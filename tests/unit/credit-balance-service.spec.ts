import { describe, expect, it, vi } from 'vitest'
import { createCreditBalanceService } from '../../src/credit-balance-service.js'
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'

const secret = 'PRIVATE_LOGIN_TOKEN_EMAIL_URL_MUST_NOT_ESCAPE'
const balance = (extra: Record<string, unknown> = {}) => ({ total: 42.5, packages: [], ...extra })
const account = (extra: Record<string, unknown> = {}) => ({ accountId: secret, nickname: secret, balance: balance(), ...extra })
const wrap = (...accounts: unknown[]) => ({ ok: true, value: { accounts, credentialRef: secret } })
const make = (read: (id: string) => Promise<unknown>) => createCreditBalanceService({ providers: () => PROVIDER_REGISTRY, read })

describe('跨插件余额投影', () => {
  it('能力清单来自 registry，发现过程不查询余额', () => {
    const read = vi.fn()
    const service = make(read)
    expect(service.supportedProviders()).toEqual(PROVIDER_REGISTRY.filter((p) => p.credits.balance).map((p) => ({ id: p.id, displayName: p.label })))
    expect(service.supportedProviders().map((p) => p.id)).toEqual(expect.arrayContaining(['zcode', 'minimax', 'minimaxintl']))
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'constructor', '__proto__', '', 'MINIMAX'])('拒绝未知供应商 %s，不调用读取端', async (id) => {
    const read = vi.fn()
    await expect(make(read).creditsBalances(id)).rejects.toMatchObject({ name: 'UnsupportedProviderError', message: 'unsupported-provider' })
    expect(read).not.toHaveBeenCalled()
  })

  it('空账号池是空结果，不是假零余额', async () => {
    expect(await make(async () => wrap()).creditsBalances('zcode')).toEqual({ accounts: [] })
  })

  it('原样区分零余额和小数余额，仅传递选中的供应商', async () => {
    const read = vi.fn(async () => wrap(account({ balance: balance({ total: 0 }) }), account()))
    const result = await make(read).creditsBalances('minimaxintl')
    expect(read).toHaveBeenCalledExactlyOnceWith('minimaxintl')
    expect(result.accounts.map((a) => a.balance?.total)).toEqual([0, 42.5])
    expect(result.accounts.map((a) => a.accountId)).toEqual(['account-1', 'account-2'])
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('多桶、过期包和缺失 remaining 保留原始数值，不制造百分比或补零', async () => {
    const result = await make(async () => wrap(account({ balance: balance({ packages: [
      { name: '长期', unit: 'token', remaining: 90, total: 100, used: 10, active: true },
      { name: '过期', unit: 'credit', total: 100, used: 20, active: false },
      { name: '临时', unit: 'credit', remaining: 0.5 },
    ] }) }))).creditsBalances('zcode')
    expect(result.accounts[0].balance?.packages).toEqual([
      { name: '长期', unit: 'token', remaining: 90, total: 100, used: 10, active: true },
      { name: '过期', unit: 'credit', total: 100, used: 20, active: false },
      { name: '临时', unit: 'credit', remaining: 0.5 },
    ])
    expect(result.accounts[0].balance?.packages[1]).not.toHaveProperty('remaining')
  })

  it('保留明确的单位与毫秒到期时间，未知日期不透传', async () => {
    const result = await make(async () => wrap(account({ balance: balance({ unit: 'USD', packages: [
      { remaining: 1, name: '\u0000测试\n', unit: 'credit', deductionEndTime: 1793000000000, expiredTime: '2026-10-27T00:00:00Z', token: secret },
      { remaining: 2, expiredTime: secret, deductionEndTime: 9e99 },
    ] }) }))).creditsBalances('buddy')
    expect(result.accounts[0].balance?.unit).toBe('USD')
    expect(result.accounts[0].balance?.packages[0]).toEqual({ name: '测试', unit: 'credit', remaining: 1, deductionEndTime: 1793000000000, expiredTime: '2026-10-27T00:00:00.000Z' })
    expect(result.accounts[0].balance?.packages[1]).toEqual({ name: '额度包 2', unit: 'credit', remaining: 2 })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('失败与 stale 账号不返回旧余额，不暴露账号、昵称或错误文本', async () => {
    const result = await make(async () => wrap(account(), account({ error: secret }), account({ stale: true }), null)).creditsBalances('zcode')
    expect(result.accounts.map((a) => a.balance?.total ?? null)).toEqual([42.5, null, null, null])
    expect(result.accounts.map((a) => a.error)).toEqual([undefined, 'unknown', 'stale-balance', 'upstream-invalid-response'])
    expect(result.accounts[2].stale).toBe(true)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it.each([-1, NaN, Infinity, '0', null])('坏的余额 %s 不能变成可用的零', async (total) => {
    const result = await make(async () => wrap(account({ balance: balance({ total }) }))).creditsBalances('buddy')
    expect(result.accounts[0]).toMatchObject({ balance: null, error: 'upstream-invalid-response' })
  })

  it.each([{ remaining: -1 }, { remaining: NaN }, { remaining: 2, used: -1 }, {}, null])('坏的积分包拒绝整个账号', async (pkg) => {
    const result = await make(async () => wrap(account({ balance: balance({ packages: [pkg] }) }))).creditsBalances('buddy')
    expect(result.accounts[0]).toMatchObject({ balance: null, error: 'upstream-invalid-response' })
  })

  it.each([null, [], {}, { ok: true }, { ok: true, value: { accounts: {} } }])('异常 envelope 拒绝并返回固定原因', async (response) => {
    await expect(make(async () => response).creditsBalances('zcode')).rejects.toMatchObject({ message: 'upstream-invalid-response', safeReason: 'upstream-invalid-response' })
  })

  it('宿主异常与 RPC 失败不透传原文', async () => {
    for (const read of [async () => { throw new Error(secret) }, async () => ({ ok: false, error: { message: secret } })]) {
      await expect(make(read).creditsBalances('zcode')).rejects.toMatchObject({ message: 'unknown', safeReason: 'unknown' })
    }
  })

  it('只投影允许字段，不改动宿主对象', async () => {
    const response = wrap(account({ credential: secret, balance: balance({ packages: [{ remaining: 2, token: secret }], extra: secret }) }))
    const before = structuredClone(response)
    const result = await make(async () => response).creditsBalances('buddy')
    expect(response).toEqual(before)
    expect(result.accounts[0]).toEqual({ accountId: 'account-1', nickname: '账号 1', balance: { total: 42.5, packages: [{ name: '额度包 1', unit: 'credit', remaining: 2 }] } })
  })
})
