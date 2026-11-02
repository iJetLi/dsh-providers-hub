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
 * ④ 积分是**只读**的：每日领取要过验证码（`POST /api/v1/user/wallet/
 *    daily-temporary-credit` 实测 400 `captcha binding mismatch`），
 *    所以 `credits.dailyCheckin === false`、表里**没有** `claim`；
 * ⑤ 只填 Key 的账号必须**降级成一句可行动提示**，不能抛错、不能当零余额。
 */

import { describe, expect, it } from 'vitest'

import {
  BAIZHI_SESSION_COOKIE_NAME,
  BAIZHI_SL_SESSION_COOKIE_NAME,
  buildBaizhiBalance,
  exchangeBaizhiSessionForKey,
  fetchBaizhiBalanceDetailed,
  fetchBaizhiProfile,
  fetchBaizhiUsage,
  fetchBaizhiWallet,
  normalizeBaizhiCookie,
} from '../../src/baizhi-credits.js'
import { BAIZHI } from '../../src/baizhi-product.js'

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

  it('主行 = 可用积分；每日/充值各一个有效包', () => {
    const balance = buildBaizhiBalance(wallet, undefined)
    expect(balance.total).toBe(235.05)
    expect(balance.packages.map((p) => p.name)).toEqual(['每日积分', '充值积分'])
    expect(balance.packages.every((p) => p.active)).toBe(true)
    // ⚠️ 上游只说「零点过期」不给时刻 ⇒ 不得编一个时间（面板会显示假倒计时）。
    expect(balance.packages[0].cycleEndTime).toBe('')
    expect(balance.packages[1].expiredTime).toBe('')
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
    // ▶ 关键：用量**不能**混进额度包列表。
    expect(balance.packages.map((p) => p.name)).toEqual(['每日积分', '充值积分'])
    // 且不影响主行总额（用量不是余额）。
    expect(balance.total).toBe(235.05)
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
        data: { items: [{ id: 'acct-0001', name: 'demo-account', api_key: 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'active' }] },
      }),
    })
    const res = await exchangeBaizhiSessionForKey(COOKIE, BAIZHI, { fetchImpl })
    // ⚠️ 必须打**大模型商店**的 console 接口，不是控制台的 `/api/v1/user/api-keys`。
    //    后者只发 `bzy_`（15 位，打模型网关恒 401「API Key 无效」）——
    //    2026-11-02 我为这个错误结论来回改了三次。
    expect(calls[0].url).toBe(`${BAIZHI.consoleBaseUrl}${BAIZHI.consoleApiKeysPath}`)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.key.apiKey).toBe('sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
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
