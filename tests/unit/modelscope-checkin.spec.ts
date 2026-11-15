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
})
