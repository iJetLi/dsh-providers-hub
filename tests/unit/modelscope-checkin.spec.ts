import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimModelscopeDaily, modelscopeDailyGrantExpiry } from '../../src/modelscope-checkin.js'
import { fetchModelscopeBalanceDetailed } from '../../src/modelscope-credits.js'

const credential = { access_token: 'ms-' + 'fixture'.repeat(3) }
const reward = {
  type: 'EARN', rule_key: 'daily_active', total_amount: 200,
  gmt_created: '2026-11-15 08:00:00', expire_at: '2026-11-16 08:00:00',
}
const ledger = (records: unknown[], total = records.length) =>
  Response.json({ success: true, data: { records, total } })

describe('魔搭魔粒签到与到期', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-15T09:00:00+08:00'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('当天已到账时仅读发放记录', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ledger([reward]))
    vi.stubGlobal('fetch', fetch)
    expect(await claimModelscopeDaily(credential)).toMatchObject({ kind: 'already-claimed' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0][0])).toContain('/magicubes/transactions')
  })

  it('完整核对到账前后的账单，并合并并发领取', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(ledger([]))
      .mockResolvedValueOnce(Response.json({ Code: 200 }))
      .mockResolvedValueOnce(ledger([
        reward,
        { ...reward, rule_key: 'aliyun_bindlogin', total_amount: '50' },
        { ...reward, rule_key: 'profile_completed', total_amount: 100 },
      ]))
    vi.stubGlobal('fetch', fetch)
    const both = await Promise.all([claimModelscopeDaily(credential), claimModelscopeDaily(credential)])
    expect(both).toMatchObject([{ kind: 'claimed', credit: 250 }, { kind: 'claimed', credit: 250 }])
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(String(fetch.mock.calls[1][0])).toContain('/users/login/info')
    expect(fetch.mock.calls[1][1]).toMatchObject({ redirect: 'error' })
  })

  it('空账单省略 records 时可领取，发放记录的日期可只有年月日', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, data: {} }))
      .mockResolvedValueOnce(Response.json({ Code: 200 }))
      .mockResolvedValueOnce(ledger([{ ...reward, gmt_created: '2026-11-15' }]))
    vi.stubGlobal('fetch', fetch)
    expect(await claimModelscopeDaily(credential)).toMatchObject({ kind: 'claimed', credit: 200 })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('账单缺少 data 或分页仍有未返回记录时，不触发领取', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({ success: true, data: { records: null, total: 2 } }))
    vi.stubGlobal('fetch', fetch)
    expect(await claimModelscopeDaily(credential)).toMatchObject({
      kind: 'failed', message: '魔粒发放记录读取不完整（缺少账单数据）',
    })
    expect(await claimModelscopeDaily(credential)).toMatchObject({
      kind: 'failed', message: '魔粒发放记录读取不完整（账单总数与记录数不符）',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('请求成功但无新发放时，不计签到完成', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ledger([]))
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(ledger([])))
    expect(await claimModelscopeDaily(credential)).toMatchObject({ kind: 'inactive', coversToday: false })
  })

  /**
   * ⚠️⚠️ **`DAILY_RULES` 是写死的白名单，上游改名就会静默漏算** —— 这条用例锁住
   * 「漏算时必须点名」：否则用户看到的是「发放记录暂未新增魔粒」（**假话**，
   * 魔粒其实已经到账），而运维没有任何线索知道该补哪个规则名。
   *
   * 反例形态：上游把 `daily_active` 改名成 `daily_login_v2` ⇒ `dailyAmount()`
   * 一点都算不进去 ⇒ `credit === 0` ⇒ 走 `inactive`。点名的价值全在这个分支。
   */
  it('★★★ 发放记录里出现未登记的规则时要点名（否则「暂未新增魔粒」是假话）', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ledger([]))
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(ledger([
        { ...reward, rule_key: 'daily_login_v2', total_amount: 250 },
        { ...reward, rule_key: 'profile_completed', total_amount: 100 },
      ])))
    const outcome = await claimModelscopeDaily(credential)
    expect(outcome).toMatchObject({
      kind: 'inactive',
      message: expect.stringContaining('daily_login_v2'),
    })
    // 两条都要点到；`profile_completed` 本来就不在白名单里，也必须一起报出来。
    expect(outcome).toMatchObject({ message: expect.stringContaining('profile_completed') })
  })

  it('账单分页未读全时暂不发起登录', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(ledger([], 5))
    vi.stubGlobal('fetch', fetch)
    expect(await claimModelscopeDaily(credential)).toMatchObject({ kind: 'failed', message: '魔粒发放记录读取不完整（账单总数与记录数不符）' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('余额保留小数，优先展示昨天仍未到期的批次', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, data: { total_balance: 251, available_balance: 250.5 } }))
      .mockResolvedValueOnce(ledger([reward, {
        ...reward, gmt_created: '2026-11-14 13:42:00', expire_at: '2026-11-15 13:42:00',
      }, {
        ...reward, gmt_created: '2026-11-14 08:00:00', expire_at: '2026-11-15 08:00:00',
      }]))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchModelscopeBalanceDetailed(credential)).toMatchObject({
      balance: {
        total: 250.5,
        dailyGrantExpiresAt: Date.parse('2026-11-15T13:42:00+08:00'),
        packages: [{ remaining: 250.5 }],
      },
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('/users/login/info'))).toBe(true)
  })

  it('账单失败时仍有余额，时间无效时不猜到期', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, data: { total_balance: 0.5 } }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(ledger([{ ...reward, expire_at: '2026-11-31 13:42:00' }])))
    const result = await fetchModelscopeBalanceDetailed(credential)
    expect(result.balance?.total).toBe(0.5)
    expect(result.balance?.dailyGrantExpiresAt).toBeUndefined()
    expect(await modelscopeDailyGrantExpiry(credential.access_token)).toBeUndefined()
  })

  // ── 第二轮（PR #83 对抗审计 P1/P2） ──

  it('★★★ 未来的流水不得冒充「今天已领取」（否则当天彻底不再领）', async () => {
    const tomorrow = { ...reward, gmt_created: '2026-11-16 08:00:00' }
    const fetch = vi.fn()
      .mockResolvedValueOnce(ledger([tomorrow]))
      .mockResolvedValueOnce(Response.json({ Code: 200 }))
      .mockResolvedValueOnce(ledger([reward]))
    vi.stubGlobal('fetch', fetch)
    // 原判据是 `>= 今天零点` ⇒ 明天那条被当成今天 ⇒ already-claimed ⇒ 只发 1 次请求。
    expect(await claimModelscopeDaily(credential)).toMatchObject({ kind: 'claimed', credit: 200 })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('★★★ 两个认证头必须同时给（只发 cookie 会让 API Key 族静默失败）', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(ledger([]))
      .mockResolvedValueOnce(Response.json({ Code: 200 }))
      .mockResolvedValueOnce(ledger([reward]))
    vi.stubGlobal('fetch', fetch)
    await claimModelscopeDaily(credential)
    const headers = fetch.mock.calls[1][1]?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ' + credential.access_token)
    // 同时保留 cookie 以兼容网页会话形态。
    expect(String(headers.cookie ?? '')).toContain(credential.access_token)
    expect(fetch.mock.calls[1][1]).toMatchObject({ redirect: 'error' })
  })

  it('★★★ 上游返回 HTML 登录页时必须说「登录态失效」，而不是「不是 JSON」', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ledger([]))
      .mockResolvedValueOnce(new Response('<html><body>login</body></html>', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      })))
    const result = await claimModelscopeDaily(credential)
    expect(result).toMatchObject({ kind: 'failed' })
    expect(result.kind === 'failed' ? result.message : '').toContain('登录态')
    expect(result.kind === 'failed' ? result.message : '').not.toContain('不是 JSON')
  })

  it('★★★ 上游重定向到登录页时也要指向「登录态失效」，不能说「网络异常」', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ledger([]))
      .mockRejectedValueOnce(new TypeError('unexpected redirect')))
    const result = await claimModelscopeDaily(credential)
    expect(result).toMatchObject({ kind: 'failed' })
    const message = result.kind === 'failed' ? result.message : ''
    expect(message).toContain('登录态')
    expect(message).not.toContain('网络异常')
  })

  it('★★★ 负金额不得让当天领取额虚报（before 里一条 -500 会把 200 抬成 700）', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ledger([{ ...reward, total_amount: -500 }]))
      .mockResolvedValueOnce(Response.json({ Code: 200 }))
      .mockResolvedValueOnce(ledger([{ ...reward, total_amount: -500 }, reward])))
    const result = await claimModelscopeDaily(credential)
    expect(result).toMatchObject({ kind: 'failed' })
    expect(result.kind === 'failed' ? result.message : '').toContain('有效金额')
  })

  it('★★★ 未登记规则名必须过字符集白名单（否则上游能把 API Key 回显到用户面前）', async () => {
    const key = credential.access_token
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ledger([]))
      .mockResolvedValueOnce(Response.json({ Code: 200 }))
      .mockResolvedValueOnce(ledger([
        { ...reward, rule_key: key, total_amount: 1 },
        { ...reward, rule_key: 'daily_login_v2', total_amount: 1 },
      ])))
    const result = await claimModelscopeDaily(credential)
    const message = result.kind === 'inactive' ? result.message : ''
    expect(message).toContain('daily_login_v2')
    expect(message).not.toContain(key)
  })
})
