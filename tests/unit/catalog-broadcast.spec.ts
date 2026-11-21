import { describe, expect, it, vi } from 'vitest'

import { CATALOG_BROADCAST_COALESCE_MS, broadcastCatalogChanged } from '../../src/catalog-broadcast.js'
import { RemoteCatalogGate } from '../../src/remote-catalog-gate.js'

/** 极简 ctx 替身：只需要 `emit` 与 `logger`。 */
function makeCtx(): { emit: ReturnType<typeof vi.fn>; logger: { warn: ReturnType<typeof vi.fn> } } {
  return { emit: vi.fn(), logger: { warn: vi.fn() } }
}

/**
 * 等**合并窗口**过去（2026-11-20 起广播走 `setTimeout` 窗口，不再是 microtask）。
 *
 * ⚠️ 为什么从 microtask 改成定时器窗口：实测冷启动时 8 家 provider 的目录
 * 是**网络响应错开**落地的（几十毫秒到十几秒），`queueMicrotask` 只在同一
 * tick 内合并 ⇒ 合并率接近 0 ⇒ 宿主对每个 provider 重算 16 次。
 * 改窗口后同一窗口内的广播只派发一次（见模块头的实测时间线）。
 */
const flushBroadcast = (): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, CATALOG_BROADCAST_COALESCE_MS + 50) })

/**
 * 目录变更广播（issue IKJVTF 的缺陷①）。
 *
 * ⚠️ **2026-11-20**：派发从 `queueMicrotask`（同 tick 合并）改为
 * `setTimeout` **合并窗口**（`CATALOG_BROADCAST_COALESCE_MS`）。
 * 理由见 `src/catalog-broadcast.ts` 模块头的实测时间线 —— 各家目录是
 * **网络错开**落地的，microtask 合并率接近 0，导致宿主重复重算 16 次。
 *
 * 真实缺陷：`dsh-client-ui-model-selection` 的 `ModelCatalogDirectory` 在
 * `status === 'ready'` 时**短路返回缓存**，只在宿主事件上 `refresh()`。
 * 冷启动首拉失败时客户端把**兜底表**缓存成 ready，此后远端目录真的落地也
 * **没有任何事件**通知它重读 ⇒ 永久分叉（设置页 5 个模型、对话框只剩 2 个）。
 * 修复前十个适配器的 `ensureRemoteModels` 全是 **0 处广播**。
 */
describe('broadcastCatalogChanged', () => {
  it('派发 llm/adapters-updated（且是异步派发，不在调用栈内同步 emit）', async () => {
    const ctx = makeCtx()
    broadcastCatalogChanged(ctx as never)
    // ⚠️ 同步 emit 会把「监听器重入 listModels」变成闸门内的重入 —— 见模块头。
    expect(ctx.emit).not.toHaveBeenCalled()
    await flushBroadcast()
    expect(ctx.emit).toHaveBeenCalledWith('llm/adapters-updated')
  })

  it('同一 ctx 在**同一合并窗口**内多次调用只派发一次', async () => {
    const ctx = makeCtx()
    broadcastCatalogChanged(ctx as never)
    broadcastCatalogChanged(ctx as never)
    broadcastCatalogChanged(ctx as never)
    await flushBroadcast()
    expect(ctx.emit).toHaveBeenCalledTimes(1)
  })

  it('派发完成后可以再次广播（不是一次性的）', async () => {
    const ctx = makeCtx()
    broadcastCatalogChanged(ctx as never)
    await flushBroadcast()
    broadcastCatalogChanged(ctx as never)
    await flushBroadcast()
    expect(ctx.emit).toHaveBeenCalledTimes(2)
  })

  it('emit 抛错不冒泡，只记日志（通知失败不反噬目录加载）', async () => {
    const ctx = makeCtx()
    ctx.emit.mockImplementation(() => { throw new Error('listener boom') })
    broadcastCatalogChanged(ctx as never)
    await expect(flushBroadcast()).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledOnce()
  })

  it('★ emit 期间的**重入**被合并，不形成广播风暴', async () => {
    // 真实形态：`llm/adapters-updated` 的监听器会再走 buildModelCatalog →
    // listModels → 若目录又落地就会再次调到这里。若标记在 emit **之前**清，
    // 每次派发都翻一倍。
    const ctx = makeCtx()
    let reentered = 0
    ctx.emit.mockImplementation(() => {
      // 模拟监听器重入：每次派发都尝试再广播一次。
      if (reentered < 5) {
        reentered += 1
        broadcastCatalogChanged(ctx as never)
      }
    })
    broadcastCatalogChanged(ctx as never)
    await flushBroadcast()
    await flushBroadcast()
    // ⚠️ 只派发一次；重入的每一次调用都在 `pending` 处被合并（直接 return，
    // 不会再排 microtask）⇒ 不会指数放大。
    expect(ctx.emit).toHaveBeenCalledTimes(1)
    // 重入**确实发生过**（否则本用例测不到东西），但它只排了一次。
    expect(reentered).toBe(1)
  })

  /**
   * ★★★ **错开落地的多次广播必须合并成一次**（2026-11-20 真实启动卡顿修复）。
   *
   * ## 它守的是什么
   *
   * 实测冷启动时 8 家 provider 的目录是**网络响应错开**落地的（几十到几千毫秒），
   * 每一家落地都调一次广播。旧的 `queueMicrotask` 合并只在**同一 tick** 生效
   * ⇒ 这 8 次几乎全在不同 tick ⇒ 全部派发 ⇒ 宿主对 33 个 provider 重算 8 轮
   * （实测单 provider 被 `listModels` 16 次）。
   *
   * ⇒ 改成时间窗口后，同一窗口内的多次调用只派发一次。
   */
  it('★★★ 错开落地（同一窗口内不同 tick）的多次广播只派发一次', async () => {
    const ctx = makeCtx()
    // 模拟 8 家目录在不同 tick 落地（每次间隔 10ms，都在窗口内）
    for (let i = 0; i < 8; i++) {
      broadcastCatalogChanged(ctx as never)
      await new Promise((r) => { setTimeout(r, 10) })
    }
    // 窗口未到 ⇒ 还没派发
    expect(ctx.emit, '窗口内不该派发').not.toHaveBeenCalled()
    await flushBroadcast()
    expect(ctx.emit, '窗口内 8 次调用必须合并成 1 次').toHaveBeenCalledTimes(1)
  })

  it('★★ 窗口过去后再调用 ⇒ 派发新一轮（不是一次性的）', async () => {
    const ctx = makeCtx()
    broadcastCatalogChanged(ctx as never)
    await flushBroadcast()
    expect(ctx.emit).toHaveBeenCalledTimes(1)
    broadcastCatalogChanged(ctx as never)
    await flushBroadcast()
    expect(ctx.emit).toHaveBeenCalledTimes(2)
  })

  it('★ 窗口常量必须在合理区间（100ms~3s）', () => {
    // ⚠️ 太短 ⇒ 合并率低（退化成 microtask）；太长 ⇒ 用户察觉更新延迟
    expect(CATALOG_BROADCAST_COALESCE_MS).toBeGreaterThanOrEqual(100)
    expect(CATALOG_BROADCAST_COALESCE_MS).toBeLessThanOrEqual(3000)
  })

  it('不同 ctx 各自独立派发（两个 profile 不互相吞掉）', async () => {
    const a = makeCtx()
    const b = makeCtx()
    broadcastCatalogChanged(a as never)
    broadcastCatalogChanged(b as never)
    await flushBroadcast()
    expect(a.emit).toHaveBeenCalledTimes(1)
    expect(b.emit).toHaveBeenCalledTimes(1)
  })

  it('logger 缺席时不抛错（极简 profile）', async () => {
    const ctx = { emit: vi.fn(() => { throw new Error('boom') }) }
    broadcastCatalogChanged(ctx as never)
    await expect(flushBroadcast()).resolves.toBeUndefined()
  })
})

/**
 * 闸门的 `got` / `complete` 双判据与广播接线（issue IKJVTF 的缺陷②）。
 *
 * 两个字段语义**不同，不能合并**：
 * - `got`：拿到了**非空**目录（残缺也算）⇒ 展示 + 广播；
 * - `complete`：所有来源都拿全了 ⇒ 永久缓存 + 清冷却。
 */
describe('RemoteCatalogGate：got / complete 双判据', () => {
  it('裸布尔 true ⇒ got = complete = true，冷却被清且广播一次', async () => {
    const onLoaded = vi.fn()
    const gate = new RemoteCatalogGate({ onLoaded })
    await gate.run(async () => true)
    expect(gate.cooling()).toBe(false)
    expect(onLoaded).toHaveBeenCalledTimes(1)
  })

  it('裸布尔 false ⇒ 两者皆 false，进入冷却且**不**广播', async () => {
    const onLoaded = vi.fn()
    const gate = new RemoteCatalogGate({ onLoaded })
    await gate.run(async () => false)
    expect(gate.cooling()).toBe(true)
    expect(onLoaded).not.toHaveBeenCalled()
  })

  it('★ 残缺（got=true, complete=false）⇒ **广播**但**仍进冷却**', async () => {
    // 这正是缺陷② 的修复点：旧实现把残缺当成「完整」⇒ 清冷却 + 永久缓存。
    const onLoaded = vi.fn()
    const gate = new RemoteCatalogGate({ onLoaded })
    await gate.run(async () => ({ got: true, complete: false }))
    expect(onLoaded).toHaveBeenCalledTimes(1)
    expect(gate.cooling()).toBe(true)
  })

  it('★ 残缺后冷却到期可以重试（不会像旧实现那样永久短路）', async () => {
    let now = 0
    const gate = new RemoteCatalogGate({ cooldownMs: 100, now: () => now })
    let calls = 0
    const run = async (): Promise<{ got: boolean; complete: boolean }> => {
      calls += 1
      return { got: true, complete: false }
    }
    await gate.run(run)
    expect(calls).toBe(1)
    // 冷却窗口内不重试
    await gate.run(run)
    expect(calls).toBe(1)
    // 越过冷却后重试 —— 这是「残缺目录能补齐」的路径
    now = 101
    await gate.run(run)
    expect(calls).toBe(2)
  })

  it('完整（got=true, complete=true）⇒ 清冷却，但广播仍只发一次', async () => {
    const onLoaded = vi.fn()
    const gate = new RemoteCatalogGate({ onLoaded })
    await gate.run(async () => ({ got: true, complete: true }))
    expect(onLoaded).toHaveBeenCalledTimes(1)
    expect(gate.cooling()).toBe(false)
  })

  it('complete 省略 ⇒ 默认等于 got（向后兼容既有八处裸布尔/半结构化返回）', async () => {
    const gate = new RemoteCatalogGate()
    await gate.run(async () => ({ got: true }))
    expect(gate.cooling()).toBe(false)
  })

  it('got=false 时即使 complete=true 也不广播（没有目录可展示）', async () => {
    const onLoaded = vi.fn()
    const gate = new RemoteCatalogGate({ onLoaded })
    await gate.run(async () => ({ got: false, complete: true }))
    expect(onLoaded).not.toHaveBeenCalled()
  })

  it('run 抛错 ⇒ 两者皆 false，进冷却且不广播', async () => {
    const onLoaded = vi.fn()
    const gate = new RemoteCatalogGate({ onLoaded })
    await gate.run(async () => { throw new Error('network down') })
    expect(gate.cooling()).toBe(true)
    expect(onLoaded).not.toHaveBeenCalled()
  })

  it('★ 冷却中跳过时不广播（没有新数据，通知只会让客户端空刷）', async () => {
    const onLoaded = vi.fn()
    const gate = new RemoteCatalogGate({ onLoaded })
    await gate.run(async () => false)
    expect(onLoaded).not.toHaveBeenCalled()
    await gate.run(async () => true)
    // 第二次被冷却挡回，run 根本没跑，自然不该广播。
    expect(onLoaded).not.toHaveBeenCalled()
  })

  it('★ onLoaded 抛错不反噬目录加载（run 仍正常 resolve）', async () => {
    const gate = new RemoteCatalogGate({ onLoaded: () => { throw new Error('listener boom') } })
    await expect(gate.run(async () => true)).resolves.toBeUndefined()
    expect(gate.cooling()).toBe(false)
  })

  it('并发去重：在飞的加载共享同一个 Promise，只广播一次', async () => {
    const onLoaded = vi.fn()
    const gate = new RemoteCatalogGate({ onLoaded })
    let release: (() => void) | undefined
    const blocker = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const run = async (): Promise<boolean> => {
      calls += 1
      await blocker
      return true
    }
    const first = gate.run(run)
    const second = gate.run(run)
    release?.()
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(onLoaded).toHaveBeenCalledTimes(1)
  })
})
