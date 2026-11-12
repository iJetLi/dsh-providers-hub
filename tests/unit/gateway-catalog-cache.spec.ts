/**
 * 网关目录采集缓存（`collectGatewayCatalogSnapshot`）的行为守卫。
 *
 * ## 为什么必须有这个文件（真实报障）
 *
 * 目录采集链路上有四个调用点（`/v1/models`、`/v1/reasoning-efforts`、设置页
 * `gateway.getEnabled`、`sync.preview`），每次采集 = 12 个 `listModels` +
 * **每个模型**一次 `resolveModelInfo`（实测 369 次）。打开一次「同步模型」面板
 * 要跑 738 次（组件挂载连发两次 preview）。缓存把这段成本从「每次请求」压到
 * 「每 30 秒一次」。
 *
 * ## 这些用例挡的是哪些回归
 *
 * 1. **缓存失效**（有人把 `ttlMs` 改成 0、或把 `cache.get()` 改成直接 `load()`）
 *    ⇒ 成本悄悄回到每次请求 —— 而功能一切正常，没人会注意。
 * 2. **`force` 失效**（「刷新」按钮点了没反应的最新形态）。
 * 3. **跨 `llm` 实例串缓存**（WeakMap key 写成模块级单例）⇒ B 会话看到 A 会话
 *    的渠道清单。
 * 4. **`failedProviders` 与目录不同源**（分开缓存）⇒ 保护集漂移，
 *    症状是「预览说保留、落盘却删除」。
 */

import { describe, expect, it, vi } from 'vitest'

import {
  clearGatewayCatalogCache,
  collectGatewayCatalogSnapshot,
  type GatewayModelSource,
} from '../../src/openai-gateway/models.js'

/** 造一个可观测的 llm 替身：三个方法都是 spy，方便数调用次数。 */
function makeLlm(options: {
  providers?: readonly string[]
  models?: Record<string, readonly { id: string, name: string }[]>
  failModels?: readonly string[]
} = {}) {
  const providers = options.providers ?? ['alpha', 'beta']
  const models = options.models ?? {
    alpha: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }],
    beta: [{ id: 'b1', name: 'B1' }],
  }
  const fail = new Set(options.failModels ?? [])
  const listProviders = vi.fn(() => providers.map(id => ({ id })))
  const listModels = vi.fn(async (provider: string) => {
    if (fail.has(provider)) throw new Error(`${provider} 未登录`)
    return models[provider] ?? []
  })
  const resolveModelInfo = vi.fn(async () => ({ context: { contextWindow: 128_000 } }))
  const source: GatewayModelSource = { listProviders, listModels, resolveModelInfo }
  return { source, listProviders, listModels, resolveModelInfo }
}

describe('collectGatewayCatalogSnapshot — 缓存命中', () => {
  it('⚠️ 两次调用只采集一次（否则每次请求都打 12 个 provider + 369 次 resolveModelInfo）', async () => {
    const llm = makeLlm()

    const first = await collectGatewayCatalogSnapshot(llm.source)
    const second = await collectGatewayCatalogSnapshot(llm.source)

    // 一次采集 = 2 个 provider 各一次 listModels + 3 个模型各一次 resolveModelInfo
    expect(llm.listModels).toHaveBeenCalledTimes(2)
    expect(llm.resolveModelInfo).toHaveBeenCalledTimes(3)
    // 第二次是**零**新请求
    expect(llm.listProviders).toHaveBeenCalledTimes(1)
    // 两次拿到的是同一个快照对象（缓存命中的直接证据）
    expect(second).toBe(first)
    expect(second.groups).toEqual(first.groups)
  })

  it('⚠️ force:true 会重新采集（「刷新」按钮必须真的重读网关）', async () => {
    const llm = makeLlm()

    await collectGatewayCatalogSnapshot(llm.source)
    expect(llm.listModels).toHaveBeenCalledTimes(2)

    await collectGatewayCatalogSnapshot(llm.source, { force: true })
    // 第二次采集 ⇒ 累计 4 次
    expect(llm.listModels).toHaveBeenCalledTimes(4)
  })

  it('不同 llm 实例互不串缓存（WeakMap key 必须是实例，不能是模块级单例）', async () => {
    const one = makeLlm({ providers: ['alpha'], models: { alpha: [{ id: 'a1', name: 'A1' }] } })
    const two = makeLlm({ providers: ['beta'], models: { beta: [{ id: 'b1', name: 'B1' }] } })

    const firstCatalog = await collectGatewayCatalogSnapshot(one.source)
    const secondCatalog = await collectGatewayCatalogSnapshot(two.source)

    expect(firstCatalog.groups.map(group => group.provider)).toEqual(['alpha'])
    expect(secondCatalog.groups.map(group => group.provider)).toEqual(['beta'])
    // 两个实例各采集一次
    expect(one.listModels).toHaveBeenCalledTimes(1)
    expect(two.listModels).toHaveBeenCalledTimes(1)
  })

  it('clearGatewayCatalogCache 后重新采集（登录/退出渠道这类已知变化用）', async () => {
    const llm = makeLlm()
    await collectGatewayCatalogSnapshot(llm.source)
    expect(llm.listModels).toHaveBeenCalledTimes(2)

    clearGatewayCatalogCache(llm.source)
    await collectGatewayCatalogSnapshot(llm.source)
    expect(llm.listModels).toHaveBeenCalledTimes(4)
  })
})

describe('collectGatewayCatalogSnapshot — 失败清单与目录同源', () => {
  it('⚠️ failedProviders 与目录来自同一次采集，缓存命中时仍保留（保护集不能漂移）', async () => {
    const llm = makeLlm({ failModels: ['beta'] })

    const first = await collectGatewayCatalogSnapshot(llm.source)
    expect(first.failedProviders).toEqual(['beta'])
    expect(first.groups.map(group => group.provider)).toEqual(['alpha'])

    // 第二次命中缓存：目录与失败清单**必须**不重新计算、也不丢
    const second = await collectGatewayCatalogSnapshot(llm.source)
    expect(second.failedProviders).toEqual(['beta'])
    expect(llm.listModels).toHaveBeenCalledTimes(2)
  })

  it('逐模型 resolveModelInfo 失败不算渠道级失败（保护粒度是单个模型）', async () => {
    const llm = makeLlm()
    // 让 alpha/a1 解析失败
    llm.resolveModelInfo.mockImplementation(async (provider: string, model: string) => {
      if (provider === 'alpha' && model === 'a1') throw new Error('解析失败')
      return { context: { contextWindow: 128_000 } }
    })

    const catalog = await collectGatewayCatalogSnapshot(llm.source)
    // 渠道本身是好的 ⇒ 不进 failedProviders
    expect(catalog.failedProviders).toEqual([])
    // 但该模型确实没有窗口（下游据此判 skipped，并由 skip 分支保留旧条目）
    expect(catalog.details.contextWindows.has('alpha/a1')).toBe(false)
    expect(catalog.details.contextWindows.has('alpha/a2')).toBe(true)
  })
})

// ⚠️ 「preview 与 apply 共用同一份快照」由 `sync-service.spec.ts` 的
// `审计回归 —— 目录采集缓存` 真跑（那里有临时 HOME 与两个目标的真实配置文件），
// 本文件只守 models.ts 这一层的缓存语义，不重复造 fixture。
