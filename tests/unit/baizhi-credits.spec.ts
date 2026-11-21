/**
 * 百智云**积分/控制台**层守卫（`src/baizhi-credits.ts` + `src/baizhi-browser-login.ts`）。
 *
 * 这一层是 2026-11-02 新增的：用户指出百智云控制台确实有积分体系
 * （「可用积分 235.05 / 每日积分 98.21 / 充值积分 136.84 / 本月消耗 364.95」），
 * 而我先前的「百智云没有积分概念」结论是**错的** —— 错在只看了模型网关
 * （`ai-models.app.baizhi.cloud` 确实没有任何余额路由），没看控制台
 * （`baizhi.cloud` 的钱包接口）。
 *
 * 因此这组判据守的全是「**同一家 provider 的两套凭据**」这件事：
 *
 * ① `sk-` 走推理网关（`x-api-key`），控制台 cookie 走积分（`cookie`）——
 *    混用必然 401（`x-api-key` 打控制台、cookie 打网关，实测都是 401）；
 * ② 上游单位是 **1/100 积分**（`23505` ⇒ `235.05`），忘除 100 会显示成
 *    「两万三千五百积分」，用户一眼就觉得是假的；
 * ③ `cookie` 归一化**绝不手写 `'baizhi_session=' + value`** ——
 *    monkeycode 版在 2026-11-02 就因为模板里多写一个 `=` 拼出
 *    `name==value`，服务端解析不出 name/value ⇒ 恒 401，排查了两小时；
 * ④ 每日领取要过 Cap 验证码（`challenge → 本地 PoW → redeem`），2026-11-03
 *    实测完整跑通并到账 100 积分 ⇒ `credits.dailyCheckin === true` 且表里有
 *    `claim`；这里守「已领不重发写请求」与「奖励按 1/100 积分换算」；
 * ⑤ 只填 Key 的账号必须**降级成一句可行动提示**，不能抛错、不能当零余额。
 */

import { describe, expect, it } from 'vitest'

import {
  BAIZHI_SESSION_COOKIE_NAME,
  BAIZHI_SL_SESSION_COOKIE_NAME,
  buildBaizhiBalance,
  claimBaizhiDailyCheckin,
  exchangeBaizhiSessionForKey,
  fetchBaizhiBalanceDetailed,
  fetchBaizhiProfile,
  fetchBaizhiUsage,
  fetchBaizhiWallet,
  normalizeBaizhiCookie,
  publicClaimReason,
  redactBaizhiText,
} from '../../src/baizhi-credits.js'
import { BAIZHI } from '../../src/baizhi-product.js'

/**
 * 测试用假 Key（**构造式**，不含任何形似真实的字面量）：
 * repo-pii-guard 的 sk- 形态判据连 tests/ 一起扫，硬编码 51 位密钥会让全量测试变红。
 */
const FAKE_API_KEY = `sk-${'a'.repeat(48)}`

/** 造一个只回一次的 fetch 替身，并记录它收到的 URL/headers。 */
function makeFetch(
  reply: { readonly status?: number; readonly body: string },
): { readonly fetchImpl: typeof fetch; readonly calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const status = reply.status ?? 200
    return new Response(reply.body, { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** 造一个按路径分发的 fetch 替身（签到是一条多请求链路，单响应替身不够用）。 */
function routeFetch(
  routes: readonly {
    readonly match: string
    readonly status?: number
    readonly body: string
    /** 只匹配一次（用于「同一路径前后返回不同报文」，如预检 / 复核）。 */
    readonly once?: boolean
  }[],
): {
  readonly fetchImpl: typeof fetch
  readonly calls: { url: string; headers: Record<string, string>; init: RequestInit }[]
} {
  const calls: { url: string; headers: Record<string, string>; init: RequestInit }[] = []
  const used = new Set<number>()
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      init: init ?? {},
    })
    const index = routes.findIndex((candidate, i) =>
      url.includes(candidate.match) && (candidate.once !== true || !used.has(i)))
    const route = routes[index]
    if (route === undefined) throw new Error(`未预期的请求：${url}`)
    if (route.once === true) used.add(index)
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** 钱包报文工厂（默认「今天已领」= 预检直接短路）。 */
function walletBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    code: 0,
    message: 'success',
    data: {
      user_id: 188474429268037,
      temporary_credit_cents: 10000,
      permanent_credit_cents: 50000,
      frozen_credit_cents: 0,
      available_credit_cents: 60000,
      daily_temporary_credit_claimed: true,
      ...overrides,
    },
  })
}

/** 控制台真实报文（2026-11-02 实测，数值与截图逐位吻合）。 */
const WALLET_BODY = JSON.stringify({
  code: 0,
  message: 'success',
  data: {
    balance: 23505,
    temporary_credit_cents: 9821,
    permanent_credit_cents: 13684,
    frozen_credit_cents: 0,
    available_credit_cents: 23505,
    daily_temporary_credit_claimed: true,
  },
})

const USAGE_BODY = JSON.stringify({
  code: 0,
  message: 'success',
  data: {
    items: [{ period: '2026-11-02', app_id: 22, call_count: 31, credit: 364.95, credit_ratio: 1 }],
  },
})

const COOKIE = `${BAIZHI_SL_SESSION_COOKIE_NAME}=sl-x; ${BAIZHI_SESSION_COOKIE_NAME}=bz-y`

describe('normalizeBaizhiCookie（cookie 归一化：只补名字，不补第二个等号）', () => {
  it('undefined / 空白 ⇒ undefined（调用方据此降级，不发请求）', () => {
    expect(normalizeBaizhiCookie(undefined)).toBeUndefined()
    expect(normalizeBaizhiCookie('')).toBeUndefined()
    expect(normalizeBaizhiCookie('   ')).toBeUndefined()
  })

  it('裸值补上 `baizhi_session=` 前缀', () => {
    expect(normalizeBaizhiCookie('abc123')).toBe('baizhi_session=abc123')
  })

  it('★★ 已经带 `name=value` 的原样返回 —— 不追加第二个等号', () => {
    // ⚠️ 这条是 2026-11-02 monkeycode 版真机事故的复刻守卫：
    //    旧实现无条件 `\`${NAME}=${value}\`` ⇒ `name==value` ⇒ 服务端解析
    //    不出 name/value ⇒ 恒 401，日志里只有一句「会话已失效」，排查两小时。
    const ok = 'baizhi_session=abc123'
    expect(normalizeBaizhiCookie(ok)).toBe(ok)
    // 双等号必须是**不允许**的形态：本函数任何输入都不该产出 `==`。
    for (const input of ['abc', ok, 'a=b; c=d']) {
      expect(normalizeBaizhiCookie(input) ?? '').not.toContain('==')
    }
  })

  it('带 `Cookie:` 前缀（用户从 DevTools 整行复制）会被剥掉', () => {
    expect(normalizeBaizhiCookie('Cookie: baizhi_session=abc')).toBe('baizhi_session=abc')
    expect(normalizeBaizhiCookie('cookie:abc=1')).toBe('abc=1')
  })

  it('两枚 cookie 的常量名与实测一致（拼错 = 读不到会话）', () => {
    expect(BAIZHI_SESSION_COOKIE_NAME).toBe('baizhi_session')
    expect(BAIZHI_SL_SESSION_COOKIE_NAME).toBe('sl-session')
  })
})

describe('fetchBaizhiWallet（控制台钱包 ⇒ 单位 /100）', () => {
  it('无 session_cookie ⇒ 返回可行动提示，且**一个请求都不发**', async () => {
    const { fetchImpl, calls } = makeFetch({ body: WALLET_BODY })
    const res = await fetchBaizhiWallet({ access_token: 'sk-only' }, BAIZHI, { fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('未配置会话')
      expect(res.error).toContain('浏览器登录')
    }
    expect(calls).toHaveLength(0)
  })

  it('★★ 上游单位是 1/100 积分 ⇒ 23505 必须显示成 235.05', async () => {
    const { fetchImpl, calls } = makeFetch({ body: WALLET_BODY })
    const res = await fetchBaizhiWallet({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(calls).toHaveLength(1)
    // 端点必须是**控制台**，不是推理网关。
    expect(calls[0].url).toBe(`${BAIZHI.platformBaseUrl}${BAIZHI.walletBalancePath}`)
    // 认证是 cookie（网关那条是 x-api-key，混用实测 401）。
    expect(calls[0].headers.cookie).toBe(COOKIE)
    expect(calls[0].headers['x-api-key']).toBeUndefined()
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.wallet.available).toBe(235.05)
      expect(res.wallet.temporary).toBe(98.21)
      expect(res.wallet.permanent).toBe(136.84)
      expect(res.wallet.frozen).toBe(0)
      expect(res.wallet.dailyClaimed).toBe(true)
    }
  })

  it('★★ 授信账户：读取 billing_mode / credit_limit_cents（1000 积分窗口的分母）', async () => {
    const { fetchImpl } = makeFetch({
      body: walletBody({
        billing_mode: 'postpaid',
        credit_limit_cents: 100000,
        available_credit_cents: 90800,
        temporary_credit_cents: 0,
        permanent_credit_cents: 0,
      }),
    })
    const res = await fetchBaizhiWallet({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.wallet.billingMode).toBe('postpaid')
      expect(res.wallet.creditLimit).toBe(1000)
      expect(res.wallet.available).toBe(908)
    }
  })

  it('缺 available_credit_cents ⇒ 明确报「未下发」，不静默当 0', async () => {
    const { fetchImpl } = makeFetch({ body: JSON.stringify({ code: 0, data: { balance: 1 } }) })
    const res = await fetchBaizhiWallet({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('available_credit_cents')
  })

  it('★★ 401/403 文案指向「网页登录态」，不再让用户去粘 cookie', async () => {
    const { fetchImpl } = makeFetch({ status: 401, body: '{}' })
    const res = await fetchBaizhiWallet({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('网页登录态未生效')
      expect(res.error).toContain('浏览器登录')
      expect(res.error).not.toContain('粘贴')
    }
  })
})

describe('fetchBaizhiUsage（按周期读用量，今日按本地日历日）', () => {
  it('period 拼进 query，且只算「今天」那一行', async () => {
    const { fetchImpl, calls } = makeFetch({ body: USAGE_BODY })
    const res = await fetchBaizhiUsage(
      { access_token: 'sk', session_cookie: COOKIE },
      'week',
      BAIZHI,
      { fetchImpl },
    )
    expect(calls[0].url).toBe(`${BAIZHI.platformBaseUrl}${BAIZHI.walletUsagePath}?period=week`)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.usage.items).toHaveLength(1)
      expect(res.usage.items[0].callCount).toBe(31)
      expect(res.usage.monthCalls).toBe(31)
      expect(res.usage.monthCredit).toBe(364.95)
      // 夹具日期是 2026-11-02；只有跑在这一天才算进「今日」。
      const now = new Date()
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      expect(res.usage.todayCalls).toBe(today === '2026-11-02' ? 31 : 0)
    }
  })

  it('无 cookie ⇒ 不 request，直接降级', async () => {
    const { fetchImpl, calls } = makeFetch({ body: USAGE_BODY })
    const res = await fetchBaizhiUsage({ access_token: 'sk' }, 'month', BAIZHI, { fetchImpl })
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('buildBaizhiBalance（控制台钱包页三行数字 ⇒ 面板包）', () => {
  const wallet = {
    available: 235.05,
    temporary: 98.21,
    permanent: 136.84,
    frozen: 0,
    dailyClaimed: true,
  }

  it('主行 = 可用积分；每日包分母固定 100，充值包不假装知道总额', () => {
    const balance = buildBaizhiBalance(wallet, undefined)
    expect(balance.total).toBe(235.05)
    expect(balance.packages.map((p) => p.name)).toEqual(['每日积分', '充值积分'])
    expect(balance.packages.every((p) => p.active)).toBe(true)
    // 每日包上游按 +100/天发放：remaining 98.21 时必须是 98.21 / 100，
    // 而不是旧实现的 98.21 / 98.21（用户 2026-11-05 报障）。
    expect(balance.packages[0]).toMatchObject({ remaining: 98.21, total: 100, used: 1.79 })
    // 充值余额上游只给当前值，没有初始总额 ⇒ 面板不得显示假分母。
    expect(balance.packages[1].totalKnown).toBe(false)
    // ⚠️ 上游只说「零点过期」不给时刻 ⇒ 不得编一个时间（面板会显示假倒计时）。
    expect(balance.packages[0].cycleEndTime).toBe('')
    expect(balance.packages[1].expiredTime).toBe('')
  })

  it('★★ 授信账户：1000 授信额度消耗后显示 908 / 1000（不是孤零零的 908）', () => {
    const balance = buildBaizhiBalance({
      available: 908,
      temporary: 0,
      permanent: 0,
      frozen: 0,
      dailyClaimed: true,
      billingMode: 'postpaid',
      creditLimit: 1000,
    }, undefined)
    expect(balance.total).toBe(908)
    expect(balance.packages).toHaveLength(1)
    expect(balance.packages[0]).toMatchObject({
      name: '授信额度',
      remaining: 908,
      total: 1000,
      used: 92,
      totalKnown: true,
    })
  })

  it('冻结积分 > 0 ⇒ 追加一个 active:false 的包（不可用额度）', () => {
    const balance = buildBaizhiBalance({ ...wallet, frozen: 5 }, undefined)
    const frozen = balance.packages.find((p) => p.name === '冻结积分')
    expect(frozen?.active).toBe(false)
    expect(frozen?.total).toBe(5)
  })

  it('本月消耗 > 0 ⇒ 走 `usage` 独立通道，**不进** `packages`（三审 F🟡-8）', () => {
    /**
     * ⚠️ 原实现把「本月消耗」当成 `active: false` 的**资源包**塞进 `packages`：
     * 面板渲染成「[已失效] 本月消耗: 0 / 364.95」—— 量词错位（用量不是失效额度），
     * 且它会参与「N/M 个资源包有效」与临期档折算。现在用量只能走 `usage`。
     */
    const balance = buildBaizhiBalance(wallet, {
      items: [],
      todayCredit: 0,
      todayCalls: 0,
      monthCredit: 364.95,
      monthCalls: 31,
    })
    expect(balance.usage).toEqual({ label: '本月消耗', amount: 364.95, unit: 'credit' })
    /**
     * ⚠️⚠️ 2026-11-05 审计返工：**不做「反推期初」**。
     *
     * 上游只给当前余额；`monthCredit` 是整月总消耗（每日积分也含在内），
     * 而「每日桶今天花了多少」只有今天的数 ⇒ `monthCredit - dailySpent` 会把
     * 其余 29 天的每日消耗算进充值桶（分母高估最多 `100×(天数-1)`），
     * 且「本月充值消耗为 0」时会退化成 `136.84 / 136.84` 的假窗口。
     * ⇒ 充值包只显示余额（`totalKnown:false`），不显示分母。
     */
    expect(balance.packages[1]).toMatchObject({
      name: '充值积分',
      remaining: 136.84,
      total: 136.84,
      used: 0,
      totalKnown: false,
      expiryNote: '长期有效（平台未提供到期日）',
    })
    // 且不影响主行总额（用量不是余额）。
    expect(balance.total).toBe(235.05)
  })

  /**
   * ★★ 回归（2026-11-05 审计 P0-1/P0-2）：**任何** `monthCredit` 都不得
   * 让充值包出现「分母跟着余额跑」的假窗口。
   */
  it('★★ 假分母回归：monthCredit 为 0 / 等于今日每日消耗 / 极大值，都不显示充值窗口', () => {
    for (const monthCredit of [0, 1.79, 2840]) {
      const balance = buildBaizhiBalance(wallet, {
        items: [], todayCredit: 0, todayCalls: 0, monthCredit, monthCalls: 1,
      })
      const permanent = balance.packages.find((pkg) => pkg.name === '充值积分')
      expect(permanent, `monthCredit=${monthCredit}`).toMatchObject({
        remaining: 136.84,
        total: 136.84,
        used: 0,
        totalKnown: false,
      })
    }
  })

  /**
   * ★ 今天还没领每日积分（`dailyClaimed=false` 且 `temporary=0`）时不得显示
   * `0 / 100`（会被读成「已用光」）⇒ `totalKnown:false` + 诚实文案。
   */
  it('★ 未领取每日积分：totalKnown=false，文案说「今日尚未领取」', () => {
    const balance = buildBaizhiBalance(
      { ...wallet, temporary: 0, dailyClaimed: false },
      undefined,
    )
    expect(balance.packages[0]).toMatchObject({
      name: '每日积分',
      remaining: 0,
      total: 100,
      used: 0,
      totalKnown: false,
      expiryNote: '今日尚未领取（每日 +100）',
    })
    // 反向对照：已领取但花光 ⇒ 显示 0 / 100（真实「已用光」）。
    const claimed = buildBaizhiBalance(
      { ...wallet, temporary: 0, dailyClaimed: true },
      undefined,
    )
    expect(claimed.packages[0]).toMatchObject({ remaining: 0, total: 100, used: 100, totalKnown: true })
  })

  /**
   * ★ 超授信（`available > creditLimit`）不得显示 `1200 / 1200` 假分母。
   */
  it('★ 超授信：totalKnown=false（只显示剩余），used 不为负', () => {
    const balance = buildBaizhiBalance(
      { ...wallet, available: 1200, billingMode: 'postpaid', creditLimit: 1000 },
      undefined,
    )
    expect(balance.packages[0]).toMatchObject({
      name: '授信额度', remaining: 1200, total: 1200, used: 0, totalKnown: false,
    })
    // 正常授信：908 / 1000。
    const normal = buildBaizhiBalance(
      { ...wallet, available: 908, billingMode: 'postpaid', creditLimit: 1000 },
      undefined,
    )
    expect(normal.packages[0]).toMatchObject({ remaining: 908, total: 1000, used: 92, totalKnown: true })
  })

  it('本月消耗 = 0 ⇒ 不出现 `usage`（不给面板渲染「本月消耗 0」的噪音）', () => {
    const balance = buildBaizhiBalance(wallet, {
      items: [],
      todayCredit: 0,
      todayCalls: 0,
      monthCredit: 0,
      monthCalls: 0,
    })
    expect(balance.usage).toBeUndefined()
  })
})

describe('fetchBaizhiBalanceDetailed（用量是附加信息，失败不影响余额）', () => {
  it('用量 500 只 warn，余额照常返回', async () => {
    const warns: string[] = []
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      return call === 1
        ? new Response(WALLET_BODY, { status: 200 })
        : new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    const res = await fetchBaizhiBalanceDetailed(
      { access_token: 'sk', session_cookie: COOKIE },
      BAIZHI,
      { fetchImpl, warn: (m) => warns.push(m) },
    )
    expect(res.balance?.total).toBe(235.05)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('用量')
  })

  it('无 cookie ⇒ balance 为 null + 可行动 error', async () => {
    const { fetchImpl } = makeFetch({ body: WALLET_BODY })
    const res = await fetchBaizhiBalanceDetailed({ access_token: 'sk' }, BAIZHI, { fetchImpl })
    expect(res.balance).toBeNull()
    expect(res.error).toContain('未配置会话')
  })
})

describe('exchangeBaizhiSessionForKey（网页登录态 ⇒ 自动取回 sk-）', () => {
  it('★★ 直接读回明文 key（用户不必手抄）', async () => {
    const { fetchImpl, calls } = makeFetch({
      body: JSON.stringify({
        code: 0,
        data: { items: [{ id: 'acct-0001', name: 'demo-account', api_key: FAKE_API_KEY, status: 'active' }] },
      }),
    })
    const res = await exchangeBaizhiSessionForKey(COOKIE, BAIZHI, { fetchImpl })
    // ⚠️ 必须打**大模型商店**的 console 接口，不是控制台的 `/api/v1/user/api-keys`。
    //    后者只发 `bzy_`（15 位，打模型网关恒 401「API Key 无效」）——
    //    2026-11-02 我为这个错误结论来回改了三次。
    expect(calls[0].url).toBe(`${BAIZHI.consoleBaseUrl}${BAIZHI.consoleApiKeysPath}`)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.key.apiKey).toBe(FAKE_API_KEY)
      expect(res.key.keyName).toBe('demo-account')
    }
  })

  it('★★ 停用的密钥不能用（status≠active 要跳过）', async () => {
    const { fetchImpl } = makeFetch({
      body: JSON.stringify({
        code: 0,
        data: {
          items: [
            { id: 'a', name: '旧', api_key: `sk-${'0'.repeat(64)}`, status: 'disabled' },
            { id: 'b', name: '新', api_key: `sk-${'1'.repeat(64)}`, status: 'active' },
          ],
        },
      }),
    })
    const res = await exchangeBaizhiSessionForKey(COOKIE, BAIZHI, { fetchImpl })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.key.keyName).toBe('新')
  })

  it('★ `bzy_` 前缀的 key 不算数（控制台那套打不通模型网关）', async () => {
    const { fetchImpl } = makeFetch({
      body: JSON.stringify({ code: 0, data: { items: [{ name: 'x', api_key: 'bzy_abc12345678', status: 'active' }] } }),
    })
    const res = await exchangeBaizhiSessionForKey(COOKIE, BAIZHI, { fetchImpl })
    expect(res.ok).toBe(false)
  })

  it('空列表 ⇒ 提示去大模型商店新建一把（不是「登录失败」）', async () => {
    const { fetchImpl } = makeFetch({ body: JSON.stringify({ code: 0, data: { items: [] } }) })
    const res = await exchangeBaizhiSessionForKey(COOKIE, BAIZHI, { fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('大模型商店')
      expect(res.error).toContain('console/keys')
    }
  })

  it('401 ⇒ 归因到网页登录态（否则用户会以为 Key 生成坏了）', async () => {
    const { fetchImpl } = makeFetch({ status: 401, body: '{}' })
    const res = await exchangeBaizhiSessionForKey(COOKIE, BAIZHI, { fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('网页登录态未生效')
  })
})

describe('fetchBaizhiProfile（登录后取昵称/用户 id）', () => {
  it('200 ⇒ 回 name 与 userId', async () => {
    const { fetchImpl } = makeFetch({
      body: JSON.stringify({ code: 0, data: { id: 187965886890053, name: 'Spring🐻', status: 'active' } }),
    })
    const res = await fetchBaizhiProfile(COOKIE, BAIZHI, { fetchImpl })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.name).toBe('Spring🐻')
      expect(res.userId).toBe('187965886890053')
    }
  })
})

/* ------------------------------------------------------------------ *
 * 每日签到（2026-11-03 真机：顶栏「每日领积分 +100」= 这四步）
 * ------------------------------------------------------------------ */

describe('claimBaizhiDailyCheckin（challenge → PoW → redeem → daily-temporary-credit）', () => {
  it('★ 没有会话 ⇒ failed 且**零请求**（文案要指出怎么办）', async () => {
    const { fetchImpl, calls } = routeFetch([])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk-only' }, BAIZHI, { fetchImpl })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.message : '').toContain('未配置会话')
    expect(calls).toHaveLength(0)
  })

  it('★ 今天已领取 ⇒ already-claimed，且只发一个 GET（省掉 50 题 PoW）', async () => {
    const { fetchImpl, calls } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: true }) },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome.kind).toBe('already-claimed')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.method).toBe('GET')
  })

  it('★ 完整四步：challenge → redeem → 领取，且 captcha_token 取自 redeem、奖励 100 积分', async () => {
    const { fetchImpl, calls } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }) },
      // c=1 只为一题，单测里算得完；真实挑战是 50 题。
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc', challenge: { c: 1, s: 32, d: 3 } } }) },
      { match: BAIZHI.captchaRedeemPath, body: JSON.stringify({ code: 0, data: { token: 'deadbeef:1234567890abcde', success: true } }) },
      {
        match: BAIZHI.dailyTemporaryCreditPath,
        body: JSON.stringify({
          code: 0,
          message: 'success',
          data: { claimed: true, amount_credit_cents: 10000, expires_at: '2026-11-04T00:00:00+08:00' },
        }),
      },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100, unit: 'credit' })

    expect(calls.map((c) => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      `GET ${BAIZHI.platformBaseUrl}${BAIZHI.walletBalancePath}`,
      `POST ${BAIZHI.platformBaseUrl}${BAIZHI.captchaChallengePath}`,
      `POST ${BAIZHI.platformBaseUrl}${BAIZHI.captchaRedeemPath}`,
      `POST ${BAIZHI.platformBaseUrl}${BAIZHI.dailyTemporaryCreditPath}`,
    ])
    const redeemBody = JSON.parse(String(calls[2]!.init.body)) as { token?: unknown, solutions?: unknown }
    expect(redeemBody.token).toBe('abc')
    expect(Array.isArray(redeemBody.solutions)).toBe(true)
    expect((redeemBody.solutions as number[]).length).toBe(1)
    // 领取用的必须是 redeem 换回来的凭证，而不是 challenge 的原始 token。
    const claimBody = JSON.parse(String(calls[3]!.init.body)) as { captcha_token?: unknown }
    expect(claimBody.captcha_token).toBe('deadbeef:1234567890abcde')
  })

  it('★ 预检后被人抢先领掉（claimed:false + 复核钱包已领）⇒ already-claimed，不是 failed', async () => {
    const { fetchImpl } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }), once: true },
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: true }), once: true },
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc', challenge: { c: 1, s: 32, d: 3 } } }) },
      { match: BAIZHI.captchaRedeemPath, body: JSON.stringify({ code: 0, data: { token: 'deadbeef:1234567890abcde', success: true } }) },
      { match: BAIZHI.dailyTemporaryCreditPath, body: JSON.stringify({ code: 0, data: { claimed: false, amount_credit_cents: 10000 } }) },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome.kind).toBe('already-claimed')
  })

  it('★★ claimed:false 但复核钱包仍「未领取」⇒ failed（不得静默报已领）', async () => {
    const { fetchImpl, calls } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }), once: true },
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }), once: true },
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc', challenge: { c: 1, s: 32, d: 3 } } }) },
      { match: BAIZHI.captchaRedeemPath, body: JSON.stringify({ code: 0, data: { token: 'deadbeef:1234567890abcde', success: true } }) },
      { match: BAIZHI.dailyTemporaryCreditPath, body: JSON.stringify({ code: 0, data: { claimed: false } }) },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.message : '').toContain('未发放')
    // 预检 + 复核 = 两次钱包 GET。
    expect(calls.filter((c) => c.url.includes(BAIZHI.walletBalancePath))).toHaveLength(2)
  })

  it('★ redeem 没有 token ⇒ failed 并且文案指向「过期、重试一次」，绝不发领取请求', async () => {
    const { fetchImpl, calls } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }) },
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc', challenge: { c: 1, s: 32, d: 3 } } }) },
      { match: BAIZHI.captchaRedeemPath, body: JSON.stringify({ code: 0, data: { success: false } }) },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.message : '').toContain('重试')
    expect(calls.some((c) => c.url.includes(BAIZHI.dailyTemporaryCreditPath))).toBe(false)
  })

  it('★ 题面缺 challenge 字段 ⇒ failed 并指出「上游形态可能已变」', async () => {
    const { fetchImpl } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }) },
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc' } }) },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.message : '').toContain('上游形态可能已变')
  })

  it('★ redeem 429 ⇒ failed 且带 HTTP 状态，不发领取请求', async () => {
    const { fetchImpl, calls } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }) },
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc', challenge: { c: 1, s: 32, d: 3 } } }) },
      { match: BAIZHI.captchaRedeemPath, status: 429, body: JSON.stringify({ code: 429, message: 'rate limited' }) },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome).toMatchObject({ kind: 'failed', code: 429 })
    expect(calls.some((c) => c.url.includes(BAIZHI.dailyTemporaryCreditPath))).toBe(false)
  })

  /**
   * ⚠️ 软 fail-open 的**显式登记**（2026-11-03 对抗审计）：`claimed:true` 但
   * 上游没给 `amount_credit_cents` 时按成功处理，只在文案里提示「看余额」。
   * 这里锁住这个取舍 —— 若将来改成 failed，必须同步改本用例。
   */
  it('claimed:true 但没有 amount ⇒ claimed(0) + 延迟提示（不是静默成功）', async () => {
    const { fetchImpl } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }) },
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc', challenge: { c: 1, s: 32, d: 3 } } }) },
      { match: BAIZHI.captchaRedeemPath, body: JSON.stringify({ code: 0, data: { token: 'deadbeef:1234567890abcde', success: true } }) },
      { match: BAIZHI.dailyTemporaryCreditPath, body: JSON.stringify({ code: 0, data: { claimed: true } }) },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 0 })
    expect(outcome.kind === 'claimed' ? outcome.delayedMessage : '').toContain('余额')
  })

  it('claimed:false 且复核钱包也失败 ⇒ 文案说「无法确认」，不说「未发放」', async () => {
    const { fetchImpl } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }), once: true },
      { match: BAIZHI.walletBalancePath, status: 500, body: '{}', once: true },
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc', challenge: { c: 1, s: 32, d: 3 } } }) },
      { match: BAIZHI.captchaRedeemPath, body: JSON.stringify({ code: 0, data: { token: 'deadbeef:1234567890abcde', success: true } }) },
      { match: BAIZHI.dailyTemporaryCreditPath, body: JSON.stringify({ code: 0, data: { claimed: false } }) },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.message : '').toContain('无法确认')
    expect(outcome.kind === 'failed' ? outcome.message : '').not.toContain('未发放')
  })
})

/**
 * 2026-11-05 对抗审计的四个边界（P2-3 / P3-2 / P3-3 / P3-4）。
 */
describe('buildBaizhiBalance：授信/每日的边界', () => {
  const base = {
    available: 235.05, temporary: 98.21, permanent: 136.84, frozen: 0, dailyClaimed: true,
  }

  it('★ postpaid 但 credit_limit 缺失 ⇒ 仍走授信分支（不得掉进每日/充值桶），且不显示分母', () => {
    const balance = buildBaizhiBalance({ ...base, billingMode: 'postpaid' }, undefined)
    expect(balance.packages).toHaveLength(1)
    expect(balance.packages[0]).toMatchObject({
      name: '授信额度', remaining: 235.05, total: 235.05, totalKnown: false,
    })
  })

  it('★ temporary > 100（补发/累计）⇒ totalKnown:false（不得出现 150 / 150 假分母）', () => {
    const balance = buildBaizhiBalance({ ...base, temporary: 150 }, undefined)
    const daily = balance.packages[0]
    expect(daily).toMatchObject({ name: '每日积分', remaining: 150, total: 150, used: 0, totalKnown: false })
    expect(daily.expiryNote).toContain('超过固定值')
  })

  it('★ available < 0（欠费）⇒ used 落在 [0, creditLimit]，且不显示分母', () => {
    const balance = buildBaizhiBalance(
      { ...base, available: -50, billingMode: 'postpaid', creditLimit: 1000 },
      undefined,
    )
    const credit = balance.packages[0]
    expect(credit).toMatchObject({ name: '授信额度', remaining: -50, used: 1000, totalKnown: false })
    expect(Number(credit.used)).toBeLessThanOrEqual(1000)
  })

  it('★ dailyClaimed 缺失 + temporary=0 ⇒ 既不猜「未领取」也不猜「已用光」', () => {
    const balance = buildBaizhiBalance({ ...base, temporary: 0, dailyClaimed: undefined }, undefined)
    const daily = balance.packages[0]
    expect(daily).toMatchObject({ name: '每日积分', remaining: 0, total: 100, used: 0, totalKnown: false })
    expect(daily.expiryNote).toContain('领取状态未知')
  })
})

/**
 * ★★★ issue #123 第 3 项：把上游**拒发原因**透出来（脱敏 + 截断）。
 *
 * 报障实测：`claimed=0, alreadyClaimed=1, failed=2`，而 `failed` 的文案只有
 * 「上游未发放」—— 整个响应体被丢掉，于是「服务端具体拒发条件尚未确认」
 * 成了 issue 里悬着的一条。这两条纯函数就是为它加的。
 */
describe('issue #123：拒发原因的公开与脱敏', () => {
  it('★★★ 从信封里取保守白名单字段', () => {
    expect(publicClaimReason({
      code: 0,
      data: { claimed: false, code: 40012, message: '需要完成人机验证' },
    })).toBe('code=40012；message=需要完成人机验证')
  })

  it('★★★ `code: 0` 是成功码，不得当成失败原因', () => {
    // 本仓的领取响应就是 `{ code: 0, data: { claimed: false } }` ⇒ 取不到原因。
    expect(publicClaimReason({ code: 0, data: { claimed: false } })).toBeUndefined()
    expect(publicClaimReason({ code: '0' })).toBeUndefined()
  })

  it('★★★ 脱敏：回执里的凭据类字段必须打码（本仓红线）', () => {
    /**
     * ⚠️ 这里刻意用**硬编码假凭据**（不引用任何真实值/占位符）：
     * 断言 `not.toContain(同一批字面量)` 才是有效判据 ——
     * 若断言的是**别的**字符串，这条用例会恒真（假绿）。
     */
    const fakeCookie = 'baizhi_session=FAKE_SESSION_abc123'
    const fakeBearer = 'Bearer FAKE_TOKEN_xyz.789'
    const redacted = redactBaizhiText(`Cookie: ${fakeCookie}; Authorization: ${fakeBearer} rest`)
    expect(redacted).not.toContain('FAKE_SESSION_abc123')
    expect(redacted).not.toContain('FAKE_TOKEN_xyz.789')
    expect(redacted).toContain('***')
  })

  it('★★★ JSON 形态的凭据也必须打码（上游错误体就是 JSON —— 现实可达）', () => {
    /**
     * ⚠️ **这是我自测探针抓到的真漏洞**：第一版正则是裸 `key\s*[=:]`，
     * 而 JSON 里键值两侧都有引号 ⇒ `{"access_token":"FAKE"}` **原样输出**，
     * 凭据直接漏到用户界面上。上游的**错误体就是 JSON**，所以这不是理论问题。
     */
    const cases = [
      '{"access_token":"FAKE_JSON_1"}',
      '{ "session_cookie": "FAKE_JSON_2" }',
      "{'token': 'FAKE_JSON_3'}",
      '{"code":40012,"message":"需要验证","access_token":"FAKE_JSON_4"}',
    ]
    for (const input of cases) {
      const out = redactBaizhiText(input)
      expect(out, `JSON 形态漏了：${input}`).not.toMatch(/FAKE_JSON_\d/)
    }
  })

  it('★★ 结果不超过 200 字，且跨边界的凭据仍被打码', () => {
    /**
     * ⚠️ **更正**（正向审计 P2-3）：我原先在这条用例的注释里断言
     * 「反序（先截断）会把 token 切成半截漏出去」—— **那个说法不成立**。
     * 实测：脱敏正则吃整段 `[^"',}\s]+`，被切半的 `token=SECRET_SE` 仍会被
     * 整段吃掉 ⇒ 反序**也**不会漏。顺序保留是为了鲁棒性，不是因为反序必漏。
     * （原注释已更正；变异 M3「换顺序」实测全绿，属**等价变异**。）
     */
    const long = 'x'.repeat(190) + ' token=SECRET_SECRET_SECRET ' + 'y'.repeat(50)
    const reason = publicClaimReason({ message: long })
    expect(reason).toBeDefined()
    expect(reason!.length).toBeLessThanOrEqual(200)
    expect(reason).not.toContain('SECRET_SECRET')
  })

  it('★★★ `publicClaimReason` **内部**必须脱敏（删掉那个调用仍全绿的假绿）', () => {
    /**
     * 正向审计 P2-2：我在别处测了 `redactBaizhiText`，但**没测** `publicClaimReason`
     * 会不会调用它 ⇒ 删掉内部那行脱敏，**50/50 全绿**。
     * 这条用例直接喂一个带凭据的报文，钉住「值被取出来之后也要过一遍脱敏」。
     */
    const reason = publicClaimReason({ message: 'token=FAKE_INNER_ABC 鉴权失败' })
    expect(reason).toBeDefined()
    expect(reason, '内部没调 redactBaizhiText 就会原样带出').not.toContain('FAKE_INNER_ABC')
    expect(reason).toContain('***')
  })

  it('★★★ `message: "success"` 不是失败原因（真实信封 {code:0,message:success,data}）', () => {
    /**
     * 正向审计 P1-2：真实上游回 `{code:0, message:'success', data:{claimed:false}}`，
     * 而我第一版会取外层 `message` ⇒ 写出**「上游未发放（message=success）」**。
     * 我原来的 fixture 恰好省掉了顶层 `message`，所以是假绿。
     */
    expect(publicClaimReason({ code: 0, message: 'success', data: { claimed: false } })).toBeUndefined()
    // 反向对照：信封**本身**是失败时，外层 message 仍然要取（否则真因又丢了）
    expect(publicClaimReason({ code: 40012, message: '需要完成人机验证', data: { claimed: false } }))
      .toBe('code=40012；message=需要完成人机验证')
  })

  it('★★★ 全角分隔符 / 多值 / 裸 sk- / sid / 方案+冒号（对抗审计 8/10 那批）', () => {
    /**
     * 对抗审计实测我第一版**漏 8/10**（只 JSON 与无空格 key=value 有牙）：
     *
     * | 形态 | 我第一版的错 |
     * |---|---|
     * | `token = FAKE` | 被认证方案规则的 `Token` **吃掉**、值残留（**修 A③ 引入的新回归**）|
     * | `token＝FAKE` / `token：FAKE` | 只认 ASCII 分隔符 |
     * | `session_id` / `sid` | 词表没有 |
     * | 裸 `sk-…` | 没有字段名可锚 |
     * | `Bearer: x` / `Bearer= x` | 方案后只认空白 |
     * | `token=a,b` | 值规则排除逗号 ⇒ 第二值漏 |
     */
    const cases: Array<[string, string]> = [
      ['token = FAKE（方案撞字段名）', 'token = FAKE_R1'],
      ['全角等号', 'token＝FAKE_R2'],
      ['全角冒号', 'token：FAKE_R3'],
      ['session_id', 'session_id=FAKE_R4'],
      ['sid', 'sid=FAKE_R5'],
      ['裸 sk-', 'sk-FAKE_R6abcdefgh'],
      ['Bearer 冒号', 'Bearer: FAKE_R7'],
      ['Bearer 等号', 'Bearer=FAKE_R8'],
      ['多值第二值', 'token=FAKE_R9,FAKE_R0'],
      ['Basic 冒号', 'Authorization: Basic: FAKE_RX'],
      ['裸 session', 'session=FAKE_RY'],
      ['session_key', 'session_key=FAKE_RZ'],
    ]
    for (const [label, input] of cases) {
      // ⚠️ 断言用 `/FAKE_R/`（不限字符）：我原先写 `[0-9X]` 而假值里有 `FAKE_RY`/`FAKE_RZ`
      // ⇒ 那两条**断言恒真**（对抗审计 E8 实测「缩词表仍全绿」当场抓到的假绿）。
      expect(redactBaizhiText(input), `漏了（${label}）：${input}`).not.toMatch(/FAKE_R/)
    }
  })

  it('★★★ 词表覆盖 `x-api-key` / `secretKey` / `password` / `Basic` 认证', () => {
    // 正向审计 A③ X1–X9：这些形态原先会漏。
    const cases = [
      '{"x-api-key":"FAKE_X1"}',
      '"api-key": "FAKE_X2"',
      '{"secretKey":"FAKE_X3"}',
      'secret_key=FAKE_X4',
      '{"password":"FAKE_X5"}',
      'Authorization: Basic FAKE_X6',
      '{"client_secret":"FAKE_X7"}',
    ]
    for (const input of cases) {
      const out = redactBaizhiText(input)
      expect(out, `漏了：${input}`).not.toMatch(/FAKE_X\d/)
    }
  })

  it('★★ 上游没有任何可公开字段 ⇒ 返回 undefined（调用方写「原因未知」）', () => {
    expect(publicClaimReason(undefined)).toBeUndefined()
    expect(publicClaimReason(null)).toBeUndefined()
    expect(publicClaimReason('plain string')).toBeUndefined()
    expect(publicClaimReason({ data: { claimed: false } })).toBeUndefined()
  })
})

/**
 * ★★★ issue #123 第 3、5 项的**端到端**表现（报障者明确只要求这两项）。
 *
 * 背景：2026-11-18 实测 `claimed=0, alreadyClaimed=1, failed=2`，两个失败账号的
 * 领取请求返回 `claimed=false`、复查钱包仍未领取；随后在官网完成**图形验证**
 * 即到账 ⇒ 用户需要的不是「稍后重试」，而是①**真因**②**去哪验证**。
 *
 * 明确**不做**（报障者第 2 条评论）：不改钱包复核逻辑、不全局排除 baizhi
 * 自动签到、不做逐账号补领（另开议题）。
 */
describe('issue #123：失败文案要带上游原因与官网入口', () => {
  it('★★★ claimed=false + 钱包未领取 ⇒ 文案含上游 code/message 与官网入口', async () => {
    const { fetchImpl } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }), once: true },
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }), once: true },
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc', challenge: { c: 1, s: 32, d: 3 } } }) },
      { match: BAIZHI.captchaRedeemPath, body: JSON.stringify({ code: 0, data: { token: 'deadbeef:1234567890abcde', success: true } }) },
      {
        match: BAIZHI.dailyTemporaryCreditPath,
        body: JSON.stringify({ code: 0, data: { claimed: false, code: 40012, message: '需要完成人机验证' } }),
      },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome.kind).toBe('failed')
    const message = outcome.kind === 'failed' ? outcome.message : ''
    expect(message, '必须带出上游原因').toContain('40012')
    expect(message).toContain('需要完成人机验证')
    expect(message, '必须给出官网入口（issue 第 5 项）').toContain('https://baizhi.cloud/console/')
    expect(message, '要提示完成验证后刷新').toContain('刷新')
    expect(message, '仍然保留原语义：不是「已领取」').toContain('未发放')
  })

  it('★★★ 上游不给任何原因 ⇒ 写「原因未知」，但仍给官网入口', async () => {
    const { fetchImpl } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }), once: true },
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }), once: true },
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc', challenge: { c: 1, s: 32, d: 3 } } }) },
      { match: BAIZHI.captchaRedeemPath, body: JSON.stringify({ code: 0, data: { token: 'deadbeef:1234567890abcde', success: true } }) },
      { match: BAIZHI.dailyTemporaryCreditPath, body: JSON.stringify({ code: 0, data: { claimed: false } }) },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    const message = outcome.kind === 'failed' ? outcome.message : ''
    expect(message).toContain('原因未知')
    expect(message).toContain('https://baizhi.cloud/console/')
  })
})

/**
 * ★★★ 正向审计 P1-1：**相邻失败分支**也必须脱敏。
 *
 * 我只给 `claimed=false` 那一格接了脱敏，而这三条路径的 body 会原样进
 * `outcome.message` / `deps.warn`：
 * ① 取题（challenge）HTTP 400 的 body；② 换券（redeem）400；③ 领取（claim）400。
 * 审计实测这些路径**凭据形态的值会存活**。修法是在 `describeFailure`（唯一出口）
 * 里脱敏 ⇒ 一次覆盖三处 + 所有 `warn`。
 */
describe('issue #123：HTTP 失败 body 的脱敏（P1-1）', () => {
  it('★★★ 取题 400 的 body 带凭据形态 ⇒ message 不得原样带出', async () => {
    const { fetchImpl } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }) },
      {
        match: BAIZHI.captchaChallengePath,
        status: 400,
        // 假凭据（字面量，不引用任何真实值）
        body: JSON.stringify({ error: 'bad request', token: 'FAKE_LEAK_CHALLENGE' }),
      },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome.kind).toBe('failed')
    const message = outcome.kind === 'failed' ? outcome.message : ''
    expect(message, '400 body 里的 token 不得原样进失败文案').not.toContain('FAKE_LEAK_CHALLENGE')
    expect(message).toContain('HTTP 400')
  })

  it('★★★ 领取 400 的 body 带凭据形态 ⇒ 同样不得原样带出', async () => {
    const { fetchImpl } = routeFetch([
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }) },
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc', challenge: { c: 1, s: 32, d: 3 } } }) },
      { match: BAIZHI.captchaRedeemPath, body: JSON.stringify({ code: 0, data: { token: 'deadbeef:1234567890abcde', success: true } }) },
      {
        match: BAIZHI.dailyTemporaryCreditPath,
        status: 400,
        body: JSON.stringify({ session_cookie: 'FAKE_LEAK_CLAIM', message: 'nope' }),
      },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    const message = outcome.kind === 'failed' ? outcome.message : ''
    expect(message).not.toContain('FAKE_LEAK_CLAIM')
  })
})

/**
 * ★★★ 对抗审计最后两组「无守卫」（E12 / E6 / E13）。
 *
 * - **E12**：`!after.ok`（复核钱包本身失败）那条分支没有任何用例 —— 它是
 *   「不能断言未发放」的**唯一**出口，文案必须同样脱敏且给官网入口。
 * - **E6/E13**：白名单若被加进 `data` / `user_id`，没有任何用例会红
 *   —— 那会把**账号标识**（用户 id）带进界面。
 */
describe('issue #123：复核失败分支与白名单边界', () => {
  it('★★★ 复核钱包失败 ⇒ 「无法确认」文案 + 脱敏 + 官网入口', async () => {
    const { fetchImpl } = routeFetch([
      // 预检成功（未领取）
      { match: BAIZHI.walletBalancePath, body: walletBody({ daily_temporary_credit_claimed: false }), once: true },
      // 复核失败（500，body 带凭据形态）
      { match: BAIZHI.walletBalancePath, status: 500, body: '{"token":"FAKE_COUNTERCHECK"}', once: true },
      { match: BAIZHI.captchaChallengePath, body: JSON.stringify({ code: 0, data: { token: 'abc', challenge: { c: 1, s: 32, d: 3 } } }) },
      { match: BAIZHI.captchaRedeemPath, body: JSON.stringify({ code: 0, data: { token: 'deadbeef:1234567890abcde', success: true } }) },
      { match: BAIZHI.dailyTemporaryCreditPath, body: JSON.stringify({ code: 0, data: { claimed: false } }) },
    ])
    const outcome = await claimBaizhiDailyCheckin({ access_token: 'sk', session_cookie: COOKIE }, BAIZHI, { fetchImpl })
    expect(outcome.kind).toBe('failed')
    const message = outcome.kind === 'failed' ? outcome.message : ''
    expect(message, '必须说明「无法确认」而不是断言未发放').toContain('无法确认')
    expect(message, '复核失败的 body 同样要脱敏').not.toContain('FAKE_COUNTERCHECK')
    expect(message, '同样要给官网入口').toContain('https://baizhi.cloud/console/')
  })

  it('★★★ 白名单不得取 `data` / `user_id` 这类账号标识', () => {
    /**
     * 若有人把 `data` 或 `user_id` 加进 `publicClaimReason` 的白名单，
     * 账号标识会直接被印到界面/日志上。这条用例是那个边界的守卫。
     */
    expect(publicClaimReason({ data: 'FAKE_DATA_BLOB' }), '`data` 不是原因字段').toBeUndefined()
    expect(publicClaimReason({ user_id: 'FAKE_UID_123' }), '`user_id` 不在白名单').toBeUndefined()
    expect(publicClaimReason({ data: { user_id: 'FAKE_UID_456' } })).toBeUndefined()
  })
})
