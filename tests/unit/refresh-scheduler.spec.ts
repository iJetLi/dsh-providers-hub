import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MultiAccountRefreshScheduler } from '../../src/refresh-scheduler.js'

/**
 * 多账号续期调度的**武装时机**回归（Gitee issue IKJOZB）。
 *
 * ## 被修的缺陷
 *
 * 原先的武装逻辑写在 `src/index.ts` 里，形态是：
 *
 * ```ts
 * pool.listAllAccounts().then(accounts => {
 *   if (accounts.length === 0) return          // ← 空池直接返回
 *   void refreshAllCredentials()
 *   const refreshTimer = setInterval(...)
 * })
 * ```
 *
 * 冷启动时账号池为空是很常见的情形（新用户、或用户刚删光账号），此时**整个
 * 调度器不被创建**；而 `addAccount` 之后**没有任何重新武装的路径** ——
 * 登录成功的账号在本会话内**永远不会被主动续期**，只剩「请求内按需续期」。
 * 更糟的是这条 `return` 分支一句话都不记，用户与日志都看不到。
 *
 * ## 本文件锁的四件事
 *
 * 1. **无条件武装**：池为空也必须创建定时器（空池是「等待首账号入库」的正常态，
 *    不是「不需要调度」）；
 * 2. **首轮立即跑**：不依赖第一轮定时器（issue !IKIRTT 的既有约定）；
 * 3. **空池下轮重试**：即使某个极端路径让定时器在空池下空转，也不能静默放弃；
 * 4. **入库即武装**：`notifyAccountAdded()` 能从「未武装」变「已武装」——
 *    这正是 issue 里「之后没有重新武装的路径」那一条。
 */

/** 记录每一次 refresh 调用时刻的替身。 */
function makeRefreshLog(): { calls: number; refresh: () => Promise<void> } {
  const box = { calls: 0, refresh: async (): Promise<void> => { box.calls += 1 } }
  return box
}

describe('MultiAccountRefreshScheduler：冷启动空池也必须武装（issue IKJOZB）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('池为空时依然武装定时器（无限条件 return 这条路径）', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      isPoolEmpty: async () => true,
    })
    await scheduler.start()

    expect(scheduler.isArmed()).toBe(true)
    // 首轮即使池为空也要跑一次：那一轮的作用是「对账」，且它是唯一能发现
    // 「池刚被填充」的时机之一（另一处是 notifyAccountAdded）。
    await vi.advanceTimersByTimeAsync(1)
    expect(log.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(log.calls).toBe(2)

    scheduler.stop()
  })

  it('启动时立刻跑一轮，不等第一个周期（issue !IKIRTT 的既有约定）', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      isPoolEmpty: async () => false,
    })
    await scheduler.start()
    // 不推进任何时间：首轮是 start() 内直接发起的。
    await vi.advanceTimersByTimeAsync(0)
    expect(log.calls).toBe(1)
    scheduler.stop()
  })

  it('未武装时 notifyAccountAdded 会武装（冷启动后登录的账号因此能被续期）', async () => {
    const log = makeRefreshLog()
    let empty = true
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      isPoolEmpty: async () => empty,
    })
    // 先 stop 掉，模拟「启动时因某种原因没武装」的起点。
    await scheduler.start()
    scheduler.stop()
    expect(scheduler.isArmed()).toBe(false)

    // 用户登录 → 账号入库。
    empty = false
    scheduler.notifyAccountAdded()
    await vi.advanceTimersByTimeAsync(0)

    expect(scheduler.isArmed()).toBe(true)
    expect(log.calls).toBeGreaterThanOrEqual(1)
    scheduler.stop()
  })

  it('已武装时 notifyAccountAdded 不会重复武装（不叠加定时器）', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      isPoolEmpty: async () => false,
    })
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    const afterStart = log.calls

    scheduler.notifyAccountAdded()
    scheduler.notifyAccountAdded()
    // 已武装时不做事：定时器本来就在跑，重复武装会叠加出多个 interval，
    // 让所有账号的续期频率随登录次数一起翻倍。
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(log.calls).toBe(afterStart + 1)
    scheduler.stop()
  })

  it('定时器内的空池检查不会阻止下一轮（不在空池时自毁）', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      isPoolEmpty: async () => true,
    })
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    const afterInitial = log.calls
    await vi.advanceTimersByTimeAsync(3000)
    // 三轮都应发生：空池只影响日志措辞，不影响周期本身。
    expect(log.calls).toBe(afterInitial + 3)
    expect(scheduler.isArmed()).toBe(true)
    scheduler.stop()
  })

  it('stop() 之后不再有任何续期调用，且可重新 start()', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      isPoolEmpty: async () => false,
    })
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(1)
    const before = log.calls
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(log.calls).toBe(before)
    expect(scheduler.isArmed()).toBe(false)

    await scheduler.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(log.calls).toBe(before + 1)
    scheduler.stop()
  })

  it('refresh 抛错不会打死调度器（下一轮照常）', async () => {
    let calls = 0
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: async () => { calls += 1; throw new Error('boom') },
      intervalMs: 1000,
      isPoolEmpty: async () => false,
      warn: () => {},
    })
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    const afterInitial = calls
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toBe(afterInitial + 2)
    expect(scheduler.isArmed()).toBe(true)
    scheduler.stop()
  })

  it('isPoolEmpty 抛错也照常继续（不让一次存储异常终止续期）', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      isPoolEmpty: async () => { throw new Error('store down') },
      warn: () => {},
    })
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    const afterInitial = log.calls
    await vi.advanceTimersByTimeAsync(2000)
    expect(log.calls).toBe(afterInitial + 2)
    scheduler.stop()
  })
})

describe('MultiAccountRefreshScheduler：武装判据不依赖池内布尔（issue !IKIRTT 既有铁律）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('池非空时**不**因任何账号布尔而拒绝续期（判据只有「有没有账号」）', async () => {
    // 防止有人把 issue !IKIRTT 的循环依赖改回来：「用可能被误标的 refreshable
    // 决定要不要修正误标」。本类**看不到**账号条目，只看 isPoolEmpty 的布尔，
    // 故这条用例锁的是「续期调用确实发生了」，而不是「实现里没有某个词」。
    const log = makeRefreshLog()
    let probeCalls = 0
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      // 池里「有账号」但那些账号的 refreshable=false —— 也必须照常续期。
      isPoolEmpty: async () => { probeCalls += 1; return false },
    })
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(probeCalls).toBeGreaterThanOrEqual(1)
    expect(log.calls).toBe(2)
    scheduler.stop()
  })
})

/**
 * issue #20：首轮延迟（生产 15s）。
 *
 * 宿主启动时立即对全量账号续期会和启动路径抢网络/存储；延迟只作用于首轮，
 * 周期定时器仍须立刻武装，且延迟期间 `stop()` 必须能取消。
 */
describe('MultiAccountRefreshScheduler：首轮延迟（issue #20）', () => {
  afterEach(() => { vi.useRealTimers() })

  it('★★ initialDelayMs 之前不跑首轮，之后跑一轮，周期照常', async () => {
    vi.useFakeTimers()
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      isPoolEmpty: async () => false,
      initialDelayMs: 500,
    })
    await scheduler.start()
    expect(scheduler.isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(499)
    expect(log.calls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(log.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(log.calls).toBe(2)
    scheduler.stop()
    vi.useRealTimers()
  })

  it('★★ 延迟期间 stop() 取消首轮（不留幽灵定时器）', async () => {
    vi.useFakeTimers()
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      isPoolEmpty: async () => false,
      initialDelayMs: 500,
    })
    await scheduler.start()
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(log.calls).toBe(0)
    expect(scheduler.isArmed()).toBe(false)
    vi.useRealTimers()
  })

  it('默认（不传 initialDelayMs）仍是立即跑首轮——既有 IKIRTT 契约不变', async () => {
    vi.useFakeTimers()
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      isPoolEmpty: async () => false,
    })
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(log.calls).toBe(1)
    scheduler.stop()
    vi.useRealTimers()
  })
  it('★★ 延迟期间重复 start() 仍只跑一次首轮（幂等）', async () => {
    vi.useFakeTimers()
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1000,
      isPoolEmpty: async () => false,
      initialDelayMs: 500,
    })
    await scheduler.start()
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(500)
    expect(log.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(log.calls).toBe(2)
    scheduler.stop()
  })
})

describe('空池留痕（issue IKJOZB 的另一半）', () => {
  afterEach(() => { vi.useRealTimers() })

  it('★★ 空池也要记一条 info（否则调度坏了用户完全没有线索）', async () => {
    vi.useFakeTimers()
    const infos: string[] = []
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: async () => {},
      intervalMs: 1000,
      isPoolEmpty: async () => true,
      info: (message) => infos.push(message),
    })
    await scheduler.start()
    expect(infos.some((m) => m.includes('账号池为空'))).toBe(true)
    scheduler.stop()
  })
})
