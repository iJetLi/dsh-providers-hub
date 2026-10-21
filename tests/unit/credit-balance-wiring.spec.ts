import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'
import type { CreditBalance } from '../../src/credits.js'
import { clearProviderRuntimes } from '../../src/provider-runtime.js'

const probes = vi.hoisted(() => ({
  read: vi.fn(async () => ({ total: 42.5, packages: [], expiredTotal: 0 } as CreditBalance)),
  claim: vi.fn(),
}))

// 只替换供应商的取数原语，注册、账号池、凭据解析和既有余额分派全部走真实现。
vi.mock('../../src/provider-credits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/provider-credits.js')>()
  return { ...actual, createProviderCredits: () => ({ buddy: { fetchBalance: probes.read, claim: probes.claim } }) }
})

const disposers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  clearProviderRuntimes()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function setup() {
  const ctx = new Context()
  const resolve = vi.fn(async (ref: string) => ({ value: JSON.stringify({ access_token: `${ref}-PRIVATE` }), source: 'fixture' }))
  ctx.provide('credentials', { resolve } as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', { listModels: async () => [] } as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register: () => ({ get: () => state.value, replace: (value: unknown) => { state.value = value } }),
    describe: () => [],
  } as never)
  const pool = new AccountPool(ctx)
  for (const provider of ['buddy', 'workbuddy']) {
    await pool.addAccount({ id: `${provider}-PRIVATE-ID`, provider, nickname: 'PRIVATE-EMAIL', credentialRef: `${provider.toUpperCase()}_KEY`, enabled: true, refreshable: false, createdAt: 1 })
  }
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('单测不得访问真实网络') }))
  const fork = ctx.plugin((inner) => {
    registerJetHubRpc(inner, pool, Object.fromEntries(PROVIDER_REGISTRY.map((p) => [p.id, {}])) as never)
  })
  disposers.push(async () => fork.dispose())
  const mountConnection = () => {
    const connection = ctx.plugin((inner) => {
      inner.provide('connection', { fetch: { register: () => () => {} } } as never)
    })
    disposers.push(async () => connection.dispose())
    return connection
  }
  return { ctx, pool, resolve, mountConnection }
}

describe('宿主余额服务真实接线', () => {
  it('connection 延迟出现时注册，移除时撤销，重新挂载时创建新实例', async () => {
    const { ctx, mountConnection } = await setup()
    expect(ctx.creditBalance).toBeUndefined()
    const connection = mountConnection()
    await expect.poll(() => ctx.creditBalance).toBeDefined()
    const first = ctx.creditBalance
    expect(first.supportedProviders().map((p) => p.id)).toEqual(expect.arrayContaining(['zcode', 'minimax', 'minimaxintl']))
    expect(first.supportedProviders().some((p) => p.id === 'opencode')).toBe(false)
    await connection.dispose()
    await expect.poll(() => ctx.creditBalance).toBeUndefined()
    mountConnection()
    await expect.poll(() => ctx.creditBalance).toBeDefined()
    expect(ctx.creditBalance).not.toBe(first)
  })

  it('经现有余额编排读取且仅查询指定供应商，不签到、不选号，返回脱敏读数', async () => {
    const { ctx, pool, resolve, mountConnection } = await setup()
    mountConnection()
    await expect.poll(() => ctx.creditBalance).toBeDefined()
    const select = vi.spyOn(pool, 'getAvailableAccount')
    const result = await ctx.creditBalance.creditsBalances('buddy')
    expect(result).toEqual({ accounts: [{ accountId: 'account-1', nickname: '账号 1', balance: { total: 42.5, packages: [] } }] })
    expect(probes.read).toHaveBeenCalledOnce()
    expect(resolve.mock.calls.length).toBeGreaterThan(0)
    expect(resolve.mock.calls.every(([ref]) => ref === 'BUDDY_KEY')).toBe(true)
    expect(probes.claim).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('OpenCode 通道数和未知供应商不作为余额暴露，也不读取凭据', async () => {
    const { ctx, resolve, mountConnection } = await setup()
    mountConnection()
    await expect.poll(() => ctx.creditBalance).toBeDefined()
    for (const id of ['opencode', '__proto__', 'unknown']) {
      await expect(ctx.creditBalance.creditsBalances(id)).rejects.toMatchObject({ name: 'UnsupportedProviderError' })
    }
    expect(resolve).not.toHaveBeenCalled()
    expect(probes.read).not.toHaveBeenCalled()
  })
})
