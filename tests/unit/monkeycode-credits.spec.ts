import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

import {
  buildMonkeycodeBalance,
  claimMonkeycodeDailyCheckin,
  fetchMonkeycodeBalanceDetailed,
  fetchMonkeycodeCheckinStatus,
  exchangeMonkeycodeSessionForKey,
  fetchMonkeycodeProfile,
  monkeycodeInviteLink,
  prng,
  solveChallenge,
  type MonkeycodeChallenge,
} from '../../src/monkeycode-credits.js'
import { MONKEYCODE, MONKEYCODE_INTL } from '../../src/monkeycode-product.js'
import type { MonkeycodeCredential } from '../../src/monkeycode.js'

/**
 * MonkeyCode 平台侧读数与签到的**行为级**测试。
 *
 * ## 这一家为什么必须有自己的单测
 *
 * 它与其余 26 家有两个结构性差异，都**没有真实凭据可实测**（桌面客户端重开时
 * 把 cookie 删了 ⇒ 本轮只能靠报文形状 + 算法同构来保证正确）：
 *
 * ⚠️ 2026-11-03 更新：已用本机真实账号做过真机验收（浏览器登录 → 换 Key →
 * 钱包 / 签到状态 → `challenge → solve → redeem`（201 success）→ 签到前后
 * 余额差 **+100 积分**）。下面的固定向量仍以「独立实现」为准，真机结论另记在
 * `docs/audit/pr171-monkeycode-baizhi-audit.md`。
 *
 * 1. **两套凭据、两个数据面**：推理用 `sk-…` / `oma_…`（API Key），额度 / 积分 /
 *    签到只认网页 Cookie。⇒ 「没配 cookie」是最常见的状态，必须是**有话说**的
 *    降级，不能是抛错、也不能是把 0 当读数。
 * 2. **签到要现场解 50 道 PoW 题**：算法是平台前端的逐字节移植
 *    （`fnv1a32` + xorshift32 + `sha256(salt+n)` 前缀匹配）。任何一处移位写错，
 *    服务端只会回一句「验证失败」，**没有可反推的线索** ⇒ 必须有固定向量锁住它。
 *
 * ## 守什么（每条都对应一个真实形态或真实缺陷形态）
 *
 * - 无 cookie ⇒ 明确说「未配置会话」且**零请求**（不浪费一次必然 401 的往返）；
 * - `balance` 是**千分之一积分**（前端 /1000 显示）—— 少除或多除一次都是 1000 倍错;
 * - 缺 `balance` 字段 ⇒ 判「读不到」，**绝不回落 0**（0 的语义是「已用光」）；
 * - 401/403 与 200+HTML 两种失败给**不同的**用户动作（重新登录 vs 等修复）；
 * - PoW 的解**自洽且最小**（服务端按 1-based 题号校验，写成 0-based 必然失败）；
 * - 签到四步的**顺序与端点**，以及 `captcha_token` 确实取自 redeem 响应；
 * - `CheckinStatus` 里上游不下发的字段**如实为 0 / 空串**（防「连续 0 天」这种
 *   看着像真读数的假数据回潮）。
 */

/** 一份形状合法的凭据：只有会话，没有推理 key（本文件不测推理）。 */
const CRED: MonkeycodeCredential = { access_token: 'AT', session_cookie: 'spec=1' }

/** 没有会话的凭据（用户最常见的状态：只贴了推理 key）。 */
const CRED_NO_SESSION: MonkeycodeCredential = { access_token: 'AT' }

interface Route {
  /** URL 里必须包含的片段。 */
  readonly match: string
  readonly status?: number
  readonly body: unknown
}

/**
 * 装一个按 URL 片段分流的替身 fetch。
 *
 * ⚠️ 用 `deps.fetchImpl` 注入而**不是** `vi.stubGlobal('fetch')`：
 * `platformRequest` 的取用是 `deps.fetchImpl ?? fetch`，注入式替身不会污染
 * 同进程里别的用例（本仓库多次踩过 stubGlobal 串场）。
 */
function routeFetch(routes: readonly Route[]) {
  const calls: Array<{ url: string, init: RequestInit }> = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    // ⚠️ **最长的 match 优先**，不是表里第一个命中的。
    //    本家的 `checkinPath`（`…/wallet/checkin`）**包含** `walletPath`
    //    （`…/wallet`），用 `find` 会让签到状态请求先被 wallet 路由截走，
    //    于是 challenge 请求拿到的是 wallet 报文 ⇒ 报「没有 token」。
    //    按长度降序后 spec 里可以随便排（可读性优先），不会被前缀遮挡。
    const ordered = [...routes].sort((a, b) => b.match.length - a.match.length)
    const route = ordered.find((item) => url.includes(item.match))
    if (route === undefined) {
      throw new Error(`未预期的请求：${url}（本用例只允许 ${routes.map((r) => r.match).join(' / ')}）`)
    }
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
    return new Response(text, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

const walletBody = (data: unknown) => ({ code: 0, data })

afterEach(() => {
  vi.restoreAllMocks()
})

/* ------------------------------------------------------------------ *
 * PoW：算法同构性（唯一能锁住「改一个移位就全错」的手段）
 * ------------------------------------------------------------------ */

describe('签到 PoW 的算法同构性', () => {
  it('★ prng 与平台前端逐字节一致（Python 独立实现交叉验证过的固定向量）', () => {
    // ⚠️ 这三个向量是**用 Python 按 SPEC 的算法独立重算**得到的，不是从本实现
    //    抄回来的 —— 抄回来只能锁住「没改」，锁不住「一开始就写错」。
    //    实测命令见本轮报告（fnv1a32 + 三次移位 + 08x 补零 + 截断）。
    expect(prng('abc', 8)).toBe('0bb9adb8')
    expect(prng('abc', 32)).toBe('0bb9adb8ffd8e55f8d1de826333f356a')
    expect(prng('abc1d', 3)).toBe('e6e')
    // 截断而不是补齐：长度必须**恰好**等于请求值。
    expect(prng('abc', 5)).toHaveLength(5)
    // 确定性：同 seed 同长度必须逐字符相同（题号派生依赖这一点）。
    expect(prng('abc', 32)).toBe(prng('abc', 32))
    // 不同 seed 必须不同，否则「题号没进 seed」这种缺陷会恒绿。
    expect(prng('abc1', 8)).not.toBe(prng('abc2', 8))
  })

  /**
   * ⚠️ **非 ASCII seed 的固定向量**（2026-11-03 对抗审计：所有既有向量都是
   * ASCII，把实现从 UTF-16 code unit 改成 UTF-8 字节时 57 条全绿）。
   *
   * 上游 token 可能含中文（内容指纹里的 seed），注释也宣称「按 UTF-8 会漂」——
   * 这里用一个中文 seed 把编码口径钉死。期望值由独立的 `charCodeAt` 版
   * FNV/xorshift 实现算出（非 Math.imul 版），两者一致才算通过。
   */
  it('★ 非 ASCII seed 按 UTF-16 code unit 派生（不是 UTF-8 字节）', () => {
    expect(prng('签到', 32)).toBe('95a8c731249a9356a8fd6deead55468e')
    expect(prng('中文seed-测试', 16)).toBe('5f89bdf66ede744d')
  })

  it('★ solveChallenge 的解自洽且是**最小**解（题号 1-based / 服务端按 1-based 校验）', () => {
    const challenge: MonkeycodeChallenge = { count: 2, saltLength: 32, targetLength: 3 }
    const solutions = solveChallenge('abc', challenge)
    // 固定向量：与 prng 同源，任一处派生写错都会变成别的解。
    expect(solutions).toEqual([11775, 6971])

    // 自洽：每个解 n 必须让 sha256(salt + n) 以 target 开头。
    // ⚠️ 这一半独立于 solveOne 的实现（自己按 SPEC 重算 salt/target）。
    for (let index = 0; index < challenge.count; index += 1) {
      const ordinal = index + 1
      const target = prng(`abc${ordinal}d`, challenge.targetLength)
      const salt = prng(`abc${ordinal}`, challenge.saltLength)
      const digest = createHash('sha256').update(salt + String(solutions[index])).digest('hex')
      expect(digest.startsWith(target), `第 ${ordinal} 题的解 ${solutions[index]} 不满足 target`).toBe(true)
    }

    // 最小性：0..n-1 一个都不能命中。
    // ⚠️ 这条防「返回任意一个解」的退化实现 —— 服务端只认最小解，
    //    非最小解会让 redeem 静默失败（文案只有「验证失败」）。
    const target0 = prng('abc1d', challenge.targetLength)
    const salt0 = prng('abc1', challenge.saltLength)
    for (let n = 0; n < solutions[0]!; n += 1) {
      const digest = createHash('sha256').update(salt0 + String(n)).digest('hex')
      expect(digest.startsWith(target0), `n=${n} 也是解 ⇒ 返回的不是最小解`).toBe(false)
    }
  })
})

/* ------------------------------------------------------------------ *
 * 余额：换算口径与降级
 * ------------------------------------------------------------------ */

describe('fetchMonkeycodeBalanceDetailed（平台 wallet 读数）', () => {
  it('★ 没有 session_cookie ⇒ 「未配置会话」且**零请求**（不浪费一次必然 401 的往返）', async () => {
    const { impl, calls } = routeFetch([])
    const result = await fetchMonkeycodeBalanceDetailed(CRED_NO_SESSION, MONKEYCODE, { fetchImpl: impl })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('未配置会话')
    expect(result.error).toContain('session_cookie')
    expect(calls).toHaveLength(0)
  })

  it('★ 实测形状：balance 是千分之一积分 ⇒ /1000；积分与今日额度分两个包', async () => {
    const { impl, calls } = routeFetch([
      // ⚠️ 假数据要**自洽**：声明了 pro 就配 pro 的每日上限（10^8）。
      //    拿 basic 的 10^7 配 pro 会让 `accountTier.title` 里的上限取到 10,000,000，
      //    断言的失败看起来像实现 bug，其实是数据不真实。
      { match: '/api/v1/users/wallet', body: walletBody({ balance: 12500, daily_token_balance: 60_000_000, daily_token_limit: 100_000_000 }) },
      { match: '/api/v1/users/subscription', body: walletBody({ plan: 'pro' }) },
    ])
    const result = await fetchMonkeycodeBalanceDetailed(CRED, MONKEYCODE, { fetchImpl: impl })

    expect(result.error).toBeUndefined()
    // 12500 千分之一积分 = 12.5 积分（少除一次是 12500，多除一次是 0.0125）。
    expect(result.balance?.total).toBe(12.5)
    expect(result.balance?.total).not.toBe(12.5 * 1000)

    const [credit, quota] = result.balance!.packages
    expect(credit).toMatchObject({ name: '积分余额', unit: 'credit', remaining: 12.5, total: 12.5, used: 0, active: true })
    expect(quota).toMatchObject({
      // ⚠️ 包名**不含档位**（2026-11-02 改）：档位已经由 `extra.accountTier`
      // 渲染成卡片上的「账号规格」一行（见下一条断言），包名再带一遍只会把
      // 窄标签列撑爆；且用户在卡片上找的是「今天还剩多少额度」而非档位名。
      name: '每日额度',
      unit: 'token',
      remaining: 60_000_000,
      total: 100_000_000,
      used: 40_000_000,
    })

    // ⚠️ 三个时间字段必须**空串**：上游只有标量余额，编一个到期时间会让
    //    `expiry-runtime-parity.spec.ts` 里 monkeycode 的豁免理由变成假话。
    for (const pkg of result.balance!.packages) {
      expect(pkg.expiredTime).toBe('')
      expect(pkg.cycleStartTime).toBe('')
      expect(pkg.cycleEndTime).toBe('')
    }

    // 两个端点都打了，且**不是**推理端点（余额与推理是两个数据面）。
    expect(calls.map((c) => c.url)).toEqual([
      `${MONKEYCODE.platformBaseUrl}${MONKEYCODE.walletPath}`,
      `${MONKEYCODE.platformBaseUrl}${MONKEYCODE.subscriptionPath}`,
    ])
    // 档位进 hover 的 `accountTier`（label 一个词、title 带每日上限）。
    expect(result.extra?.accountTier?.label).toBe('Pro')
    expect(result.extra?.accountTier?.title).toContain('100,000,000')
  })

  it('★ 缺 balance 字段 ⇒ 判「读不到」，**不回落 0**（0 的语义是「已用光」）', async () => {
    const { impl } = routeFetch([
      { match: '/api/v1/users/wallet', body: walletBody({ daily_token_balance: 1, daily_token_limit: 2 }) },
    ])
    const result = await fetchMonkeycodeBalanceDetailed(CRED, MONKEYCODE, { fetchImpl: impl })
    expect(result.balance).toBeNull()
    expect(result.error).toBeTruthy()
    // 反向确认：不是「读成了 0」。
    expect(result.error).not.toContain('0 积分')
  })

  it('★ 只有上限、没有剩余 ⇒ 不给额度包（缺剩余时把 0 当剩余会让用户以为用光了）', () => {
    const balance = buildMonkeycodeBalance({ balance: 3, dailyTokenLimit: 100 }, undefined)
    expect(balance.packages).toHaveLength(1)
    expect(balance.packages[0]).toMatchObject({ name: '积分余额', unit: 'credit' })
  })

  it('★ 401 ⇒ 「网页登录态未生效」（要区分「还没登进去」与「网络故障」）', async () => {
    const { impl } = routeFetch([{ match: '/api/v1/users/wallet', status: 401, body: { error: 'unauthorized' } }])
    const result = await fetchMonkeycodeBalanceDetailed(CRED, MONKEYCODE, { fetchImpl: impl })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('网页登录态未生效')
    expect(result.error).toContain('完成登录')
  })

  it('★ 200 + HTML（SPA catch-all / 登录页重定向）⇒ 明说是「可能被重定向」，不冒充报文变形', async () => {
    const { impl } = routeFetch([{
      match: '/api/v1/users/wallet',
      body: '<!doctype html><html><body>login</body></html>',
    }])
    const result = await fetchMonkeycodeBalanceDetailed(CRED, MONKEYCODE, { fetchImpl: impl })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('非 JSON')
    expect(result.error).toContain('重定向')
  })

  it('★ 订阅失败不影响余额（档位只是补充信息）', async () => {
    const { impl } = routeFetch([
      { match: '/api/v1/users/wallet', body: walletBody({ balance: 1000 }) },
      { match: '/api/v1/users/subscription', status: 500, body: 'boom' },
    ])
    const warns: string[] = []
    const result = await fetchMonkeycodeBalanceDetailed(CRED, MONKEYCODE, {
      fetchImpl: impl,
      warn: (message) => warns.push(message),
    })
    expect(result.error).toBeUndefined()
    expect(result.balance?.total).toBe(1)
    expect(result.extra).toBeUndefined()
    expect(warns.some((w) => w.includes('订阅档位读取失败'))).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * 签到
 * ------------------------------------------------------------------ */

describe('fetchMonkeycodeCheckinStatus（上游只给一个布尔）', () => {
  it('★ 不下发的字段如实为 0 / 空串（防「连续 0 天」这种假读数回潮）', async () => {
    const { impl } = routeFetch([{ match: MONKEYCODE.checkinPath, body: walletBody({ checked_in: true }) }])
    const status = await fetchMonkeycodeCheckinStatus(CRED, MONKEYCODE, { fetchImpl: impl })
    expect(status).toMatchObject({
      active: true,
      todayCheckedIn: true,
      streakDays: 0,
      dailyCredit: 0,
      todayCredit: 0,
      isStreakDay: false,
      totalCredits: 0,
      checkinDates: [],
      endTime: '',
    })
  })

  it('没有会话 ⇒ 回 null（让上层如实显示「无状态」，而不是编一个未签到）', async () => {
    const { impl, calls } = routeFetch([])
    const status = await fetchMonkeycodeCheckinStatus(CRED_NO_SESSION, MONKEYCODE, { fetchImpl: impl })
    expect(status).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('claimMonkeycodeDailyCheckin（challenge → PoW → redeem → checkin）', () => {
  it('★ 没有会话 ⇒ failed 且**零请求**（文案要指出怎么办）', async () => {
    const { impl, calls } = routeFetch([])
    const outcome = await claimMonkeycodeDailyCheckin(CRED_NO_SESSION, MONKEYCODE, { fetchImpl: impl })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.message : '').toContain('未配置会话')
    expect(calls).toHaveLength(0)
  })

  it('★ 今天已签到 ⇒ already-claimed，且只发一个 GET（省掉 50 题 PoW）', async () => {
    const { impl, calls } = routeFetch([{ match: MONKEYCODE.checkinPath, body: walletBody({ checked_in: true }) }])
    const outcome = await claimMonkeycodeDailyCheckin(CRED, MONKEYCODE, { fetchImpl: impl })
    expect(outcome.kind).toBe('already-claimed')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.method).toBe('GET')
  })

  it('★ 完整四步：challenge → redeem → checkin，且 captcha_token 取自 redeem 响应', async () => {
    const { impl, calls } = routeFetch([
      { match: MONKEYCODE.checkinPath, body: walletBody({ checked_in: false }) },
      // ⚠️ 签到前后各读一次钱包（用于「上游不回奖励金额时用余额差」口径）。
      //    两次都命中同一条静态路由 ⇒ 差值为 0 ⇒ 走 delayedMessage 分支。
      { match: MONKEYCODE.walletPath, body: walletBody({ balance: 1000 }) },
      { match: MONKEYCODE.captchaChallengePath, body: walletBody({ token: 'abc', challenge: { c: 2, s: 32, d: 3 } }) },
      { match: MONKEYCODE.captchaRedeemPath, body: walletBody({ token: 'deadbeef:1234567890abcde', success: true }) },
    ])
    const outcome = await claimMonkeycodeDailyCheckin(CRED, MONKEYCODE, { fetchImpl: impl })
    expect(outcome.kind).toBe('claimed')
    // 上游不回奖励金额、余额差也为 0 ⇒ 用 delayedMessage 说明，而不是「+0 积分」。
    expect(outcome.kind === 'claimed' ? outcome.delayedMessage : '').toContain('不返回积分数量')

    // 顺序：先 GET 判已签，再读签到前余额，再 challenge，再 redeem，最后 checkin，
    // 收尾再读一次余额用于算「签到前后差」（本用例两次余额相同 ⇒ 差 0 ⇒ delayedMessage）。
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `GET ${MONKEYCODE.platformBaseUrl}${MONKEYCODE.checkinPath}`,
      `GET ${MONKEYCODE.platformBaseUrl}${MONKEYCODE.walletPath}`,
      `POST ${MONKEYCODE.platformBaseUrl}${MONKEYCODE.captchaChallengePath}`,
      `POST ${MONKEYCODE.platformBaseUrl}${MONKEYCODE.captchaRedeemPath}`,
      `POST ${MONKEYCODE.platformBaseUrl}${MONKEYCODE.checkinPath}`,
      `GET ${MONKEYCODE.platformBaseUrl}${MONKEYCODE.walletPath}`,
    ])

    // redeem 的 body 必须带上题目解的数组（长度 == c）。
    const redeemBody = JSON.parse(String(calls[3]!.init.body)) as { token?: unknown, solutions?: unknown }
    expect(redeemBody.token).toBe('abc')
    expect(Array.isArray(redeemBody.solutions)).toBe(true)
    expect((redeemBody.solutions as number[]).length).toBe(2)

    // checkin 的 body 必须是 redeem 回来的**验证 token**，不是原始题面 token。
    // ⚠️ 把两者搞混是本流程最隐蔽的错误形态：checkin 会回 400，
    //    而文案只有「验证失败」。
    const checkinBody = JSON.parse(String(calls[4]!.init.body)) as { captcha_token?: unknown }
    expect(checkinBody.captcha_token).toBe('deadbeef:1234567890abcde')
  })

  it('★★ 响应不含奖励 ⇒ 用「签到前后余额差」报真实数额（2026-11-03 真机 +100）', async () => {
    // ⚠️ 这条用例锁的是**用户能看到 100**：上游签到接口只回
    //    `{checked_in:true}`（真机实测），奖励数额必须靠余额差实测出来。
    //    两次钱包读数必须不同，静态 routeFetch 做不到 ⇒ 用计数替身。
    let walletReads = 0
    const calls: string[] = []
    const impl = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      const reply = (data: unknown) => new Response(JSON.stringify(walletBody(data)), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
      if (url.includes(MONKEYCODE.checkinPath)) {
        return reply({ checked_in: url.includes(MONKEYCODE.checkinPath) && calls.filter((u) => u.includes(MONKEYCODE.checkinPath)).length > 1 })
      }
      if (url.includes(MONKEYCODE.walletPath)) {
        walletReads += 1
        // 签到前 5 积分、签到后 105 积分 ⇒ 增量 100。
        return reply({ balance: walletReads === 1 ? 5000 : 105000 })
      }
      if (url.includes(MONKEYCODE.captchaChallengePath)) {
        return reply({ token: 'abc', challenge: { c: 1, s: 32, d: 2 } })
      }
      if (url.includes(MONKEYCODE.captchaRedeemPath)) {
        return reply({ token: 'deadbeef:1234567890abcde', success: true })
      }
      throw new Error(`未预期的请求：${url}`)
    }) as unknown as typeof fetch
    const outcome = await claimMonkeycodeDailyCheckin(CRED, MONKEYCODE, { fetchImpl: impl })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100, unit: 'credit' })
    // 两次钱包读数（前/后）都要发生，否则「差值」是编的。
    expect(walletReads).toBe(2)
  })

  it('★ redeem 没有 token ⇒ failed 并且文案指向「验证题过期、重试一次」', async () => {
    const { impl, calls } = routeFetch([
      { match: MONKEYCODE.checkinPath, body: walletBody({ checked_in: false }) },
      { match: MONKEYCODE.captchaChallengePath, body: walletBody({ token: 'abc', challenge: { c: 1, s: 32, d: 3 } }) },
      { match: MONKEYCODE.captchaRedeemPath, body: walletBody({ success: false }) },
    ])
    const outcome = await claimMonkeycodeDailyCheckin(CRED, MONKEYCODE, { fetchImpl: impl })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.message : '').toContain('重试')
    // 没有拿到验证 token ⇒ 绝不能去发 checkin（那是一次必然失败的写请求）。
    expect(calls.map((c) => c.url).some((url, index) => url.endsWith(MONKEYCODE.checkinPath) && index > 0)).toBe(false)
  })

  it('★ 题面缺 challenge 字段 ⇒ failed 并指出「上游形态可能已变」', async () => {
    const { impl } = routeFetch([
      { match: MONKEYCODE.checkinPath, body: walletBody({ checked_in: false }) },
      { match: MONKEYCODE.captchaChallengePath, body: walletBody({ token: 'abc' }) },
    ])
    const outcome = await claimMonkeycodeDailyCheckin(CRED, MONKEYCODE, { fetchImpl: impl })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.message : '').toContain('上游形态可能已变')
  })
})

/* ------------------------------------------------------------------ *
 * 平台用户资料 / 邀请链接（2026-11-03 真机取证：上游 `?ic=<user.id>`）
 * ------------------------------------------------------------------ */

describe('fetchMonkeycodeProfile（稳定账号身份）', () => {
  it('★★ 从 /users/status 的 data.user 取 id 与昵称（真机响应形状）', async () => {
    const { impl, calls } = routeFetch([
      {
        match: MONKEYCODE.profilePath,
        body: walletBody({
          // 真机报文：data.user.id 是 ULID 形态（01a19fa3-05eb-71a7-…），昵称是中文。
          user: { id: '01a19fa3-05eb-71a7-8cb3-55b9c9751f04', nickname: '水' },
          teams: [],
        }),
      },
    ])
    await expect(fetchMonkeycodeProfile('spec=1', MONKEYCODE, { fetchImpl: impl })).resolves.toEqual({
      userId: '01a19fa3-05eb-71a7-8cb3-55b9c9751f04',
      nickname: '水',
    })
    expect(calls[0]?.url).toBe(`${MONKEYCODE.platformBaseUrl}${MONKEYCODE.profilePath}`)
  })

  it('读不到 user.id ⇒ 省略 userId（不得用换 Key 的 keyId 顶替）', async () => {
    const { impl } = routeFetch([
      { match: MONKEYCODE.profilePath, body: walletBody({ user: { nickname: '无 id' } }) },
    ])
    await expect(fetchMonkeycodeProfile('spec=1', MONKEYCODE, { fetchImpl: impl })).resolves.toEqual({
      nickname: '无 id',
    })
  })

  it('401 / 报文异常 ⇒ undefined（辅助读数失败不得把登录判死）', async () => {
    const { impl } = routeFetch([
      { match: MONKEYCODE.profilePath, status: 401, body: { code: 401, message: 'Unauthorized' } },
    ])
    await expect(fetchMonkeycodeProfile('spec=1', MONKEYCODE, { fetchImpl: impl })).resolves.toBeUndefined()
  })
})

describe('monkeycodeInviteLink（邀请链接口径）', () => {
  it('★★ 上游口径 = 站点根 + ?ic=<平台用户 id>（2026-11-03 真机 / 前端 bundle 取证）', () => {
    expect(monkeycodeInviteLink('01a19fa3-05eb-71a7-8cb3-55b9c9751f04', MONKEYCODE))
      .toBe('https://monkeycode-ai.com/?ic=01a19fa3-05eb-71a7-8cb3-55b9c9751f04')
    // 国际站必须用 .net 的域名，否则邀请链接会把好友带到另一套账号系统。
    expect(monkeycodeInviteLink('u-1', MONKEYCODE_INTL))
      .toBe('https://monkeycode-ai.net/?ic=u-1')
  })

  it('缺 user id ⇒ undefined（绝不拼出空 ?ic= 的假链接）', () => {
    expect(monkeycodeInviteLink(undefined)).toBeUndefined()
    expect(monkeycodeInviteLink('')).toBeUndefined()
    expect(monkeycodeInviteLink('   ')).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * 换 Key 的信封 / 签到报文闸门（红队 2026-11-03 打穿过的那几条）
 * ------------------------------------------------------------------ */

describe('exchangeMonkeycodeSessionForKey（失败形态必须判失败）', () => {
  it('★★ 业务失败信封（code≠0）不得被当成成功（红队删掉解包后 42 条全绿）', async () => {
    const { impl } = routeFetch([
      { match: MONKEYCODE.apiKeysPath, body: { code: 403, message: 'forbidden' } },
    ])
    const res = await exchangeMonkeycodeSessionForKey('spec=1', { fetchImpl: impl }, MONKEYCODE)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('forbidden')
  })

  it('裸对象（无信封）也能读；`id` 只作为 keyId，不是账号身份', async () => {
    const { impl } = routeFetch([
      {
        match: MONKEYCODE.apiKeysPath,
        body: { id: 'key-record-1', api_key: 'oma_abc', signing_secret: 'sec-1', created_at: 1 },
      },
    ])
    const res = await exchangeMonkeycodeSessionForKey('spec=1', { fetchImpl: impl }, MONKEYCODE)
    expect(res).toEqual({
      ok: true,
      key: { apiKey: 'oma_abc', signingSecret: 'sec-1', keyId: 'key-record-1', createdAt: 1 },
    })
  })

  it('★★ 缺 api_key / signing_secret ⇒ 判失败并指出上游形态变化', async () => {
    const { impl } = routeFetch([
      { match: MONKEYCODE.apiKeysPath, body: { code: 0, data: { api_key: 'oma_abc' } } },
    ])
    const res = await exchangeMonkeycodeSessionForKey('spec=1', { fetchImpl: impl }, MONKEYCODE)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('signing_secret')
  })
})

describe('签到报文闸门', () => {
  it('★★ redeem 明确 `success:false`（但带 token）⇒ 不得当成成功', async () => {
    const { impl } = routeFetch([
      { match: MONKEYCODE.checkinPath, body: walletBody({ checked_in: false }) },
      { match: MONKEYCODE.walletPath, body: walletBody({ balance: 1000 }) },
      { match: MONKEYCODE.captchaChallengePath, body: walletBody({ token: 'abc', challenge: { c: 1, s: 32, d: 2 } }) },
      { match: MONKEYCODE.captchaRedeemPath, body: walletBody({ token: 'deadbeef:1234567890abcde', success: false }) },
    ])
    const outcome = await claimMonkeycodeDailyCheckin(CRED, MONKEYCODE, { fetchImpl: impl })
    expect(outcome.kind).toBe('failed')
  })

  it('★★ 题面参数越界（c 巨大）⇒ 明确拒绝，绝不开始算（红队删掉闸门后仍 16 绿）', async () => {
    const { impl, calls } = routeFetch([
      { match: MONKEYCODE.checkinPath, body: walletBody({ checked_in: false }) },
      { match: MONKEYCODE.walletPath, body: walletBody({ balance: 1000 }) },
      { match: MONKEYCODE.captchaChallengePath, body: walletBody({ token: 'abc', challenge: { c: 100000, s: 32, d: 3 } }) },
    ])
    const outcome = await claimMonkeycodeDailyCheckin(CRED, MONKEYCODE, { fetchImpl: impl })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.message : '').toContain('超出合理范围')
    // 关键：没有进入 redeem（本地连一道题都不该算）。
    expect(calls.some((c) => c.url.includes(MONKEYCODE.captchaRedeemPath))).toBe(false)
  })

  it('★★ 总尝试预算耗尽 ⇒ 抛可读错误（不得把宿主事件循环冻住数小时）', () => {
    // 预算 1 次、而 d=3 期望 4096 次 ⇒ 第一题就超预算。
    const challenge: MonkeycodeChallenge = { count: 50, saltLength: 32, targetLength: 3 }
    expect(() => solveChallenge('abc', challenge, { remaining: 1 })).toThrow(/累计求解超过/)
  })
})
