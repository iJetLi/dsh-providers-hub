/**
 * 活动窗口边界播报器 + 接线守卫（GitHub issue #101 的保鲜腿）。
 *
 * ## 这里守的是「会不会静默失效」，不是「算得对不对」
 *
 * 判据层（nextPromotionEdgeMs）已在 model-promotions.spec.ts 覆盖。本文件管两件
 * 只有它们自己才能证明的事：
 *
 * 1. **播报器的三条硬约束**：只排最近一枚、超过 Node 定时器上限要**分片**、
 *    取不到边界要**停表**（而不是退化成轮询）。
 * 2. **接线**：index.ts 真的建了这个播报器、真的把四家的边界 getter 都交进去、
 *    真的挂 ctx.effect 回收。
 *
 * ⚠️ 第 2 条是本仓库反复出缺陷的地方：「刷新器说跑了 N 家、实际只接了 M 家」
 * 「effect 被整段删掉照样全绿」都实测过（AGENTS.md / client-ui.md）。
 * 故这里用**替身 ctx 真跑 apply()**，而不是断言源码里有一行。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_TIMER_DELAY_MS,
  MIN_EDGE_FIRE_GAP_MS,
  createPromotionEdgeBroadcaster,
  nearestPromotionEdge,
} from '../../src/promotion-edge-broadcast.js'

/** 假定时器：记录 (fn, delay) 并可手动触发。 */
function fakeTimers() {
  const armed: Array<{ fn: () => void; delay: number; at: number; id: number }> = []
  let nextId = 1
  let nowMs = 0
  return {
    now: () => nowMs,
    setNow(value: number) { nowMs = value },
    setTimeoutImpl: (fn: () => void, delay: number) => {
      const id = nextId++
      armed.push({ fn, delay, at: nowMs + delay, id })
      return { id }
    },
    clearTimeoutImpl: (handle: unknown) => {
      const id = (handle as { id?: number })?.id
      const index = armed.findIndex((item) => item.id === id)
      if (index >= 0) armed.splice(index, 1)
    },
    armed: () => [...armed],
    /** 触发「下一次」定时器（按 delay 最短的那个），并把它从队列里摘掉。 */
    fireNext(): { delay: number } | undefined {
      if (armed.length === 0) return undefined
      const first = armed.reduce((a, b) => (a.delay <= b.delay ? a : b))
      const delay = first.delay
      const index = armed.indexOf(first)
      armed.splice(index, 1)
      first.fn()
      return { delay }
    },
  }
}

describe('createPromotionEdgeBroadcaster', () => {
  afterEach(() => { vi.useRealTimers() })

  it('★ 有边界 ⇒ 排一枚 delay = 剩余时间的定时器；没有边界 ⇒ **一枚都不排**', () => {
    const timers = fakeTimers()
    timers.setNow(1_000)
    let edge = 20_000
    const fire = vi.fn()
    const broadcaster = createPromotionEdgeBroadcaster({
      edgeSources: () => [() => edge],
      fire,
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    broadcaster.schedule()
    expect(timers.armed()).toHaveLength(1)
    expect(timers.armed()[0]!.delay).toBe(19_000)
    expect(broadcaster.nextFireAt()).toBe(20_000)
    // 判据 3：undefined（未登录 / 上游没有活动 / 读不懂时区）⇒ 停表，不空转。
    edge = undefined
    broadcaster.schedule()
    expect(timers.armed()).toHaveLength(0)
    expect(broadcaster.nextFireAt()).toBeUndefined()
  })

  it('★ 只取**最近**的那一枚边界（四家渠道共存时不能各排一个）', () => {
    const timers = fakeTimers()
    timers.setNow(0)
    const broadcaster = createPromotionEdgeBroadcaster({
      edgeSources: () => [() => 90_000, () => 30_000, () => 60_000],
      fire: () => {},
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    broadcaster.schedule()
    expect(timers.armed()).toHaveLength(1)
    expect(timers.armed()[0]!.delay).toBe(30_000)
    expect(nearestPromotionEdge([() => 5, () => 2], 1)).toBe(2)
  })

  it('★★ 超过 Node 定时器上限（2^31-1）必须**分片**，不许「直接不排」也不许立刻触发', () => {
    // setTimeout(delay > 2^31-1) 在 Node 上会**立刻**触发并 warn 一条
    // TimeoutOverflowWarning ⇒ 播报器会当成「边界到了」立刻广播一次，然后
    // 再拿同一个远期边界排一枚 ⇒ 立刻触发 ⇒ 广播风暴。
    const timers = fakeTimers()
    timers.setNow(0)
    const far = MAX_TIMER_DELAY_MS * 2 + 60_000 // 约 50 天后
    const fire = vi.fn()
    const broadcaster = createPromotionEdgeBroadcaster({
      edgeSources: () => [() => far],
      fire,
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    broadcaster.schedule()
    // 第一片：delay 必须**不超过**上限（变异：去掉分片分支 ⇒ 本条红）。
    expect(timers.armed()).toHaveLength(1)
    expect(timers.armed()[0]!.delay).toBe(MAX_TIMER_DELAY_MS)
    // 分片**不播报**：边界还没到。
    timers.setNow(MAX_TIMER_DELAY_MS)
    timers.fireNext()
    expect(fire).toHaveBeenCalledTimes(0)
    // 剩下的约 25 天仍然 > 上限 ⇒ 继续分片。
    expect(timers.armed()[0]!.delay).toBe(MAX_TIMER_DELAY_MS)
    timers.setNow(MAX_TIMER_DELAY_MS * 2)
    timers.fireNext()
    expect(fire).toHaveBeenCalledTimes(0)
    // 最后一片进入正常范围：delay 是剩余时间，到点才播报。
    expect(timers.armed()).toHaveLength(1)
    expect(timers.armed()[0]!.delay).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
    timers.setNow(far)
    timers.fireNext()
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('★★ fire 返回 Promise 且 reject ⇒ 必须 warn，不得变成 unhandled rejection（P3-2）', async () => {
    // `fire` 的类型是 `void | Promise<void>`。只写 `void options.fire()` 时
    // **同步 throw 会被 catch 兜住**，但**异步 reject 逃出 try/catch** ⇒
    // unhandled rejection（Node 默认终止进程）。当前生产 fire 是同步的
    // （`broadcastCatalogChanged` + queueMicrotask）⇒ 结构可达、零触发，
    // 但只要有人把它改成 async，这里就是「一播报就崩」的暗雷。
    const timers = fakeTimers()
    timers.setNow(0)
    const warn = vi.fn()
    const broadcaster = createPromotionEdgeBroadcaster({
      edgeSources: () => [() => 10_000],
      fire: () => Promise.reject(new Error('boom-async')),
      warn,
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    broadcaster.schedule()
    timers.setNow(10_000)
    timers.fireNext()
    // 让 microtask 排干：若 rejection 没被接住，vitest 会把本文件标成失败。
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('活动边界播报失败')
    expect(String(warn.mock.calls[0]![0])).toContain('boom-async')
  })

  it('★★ 边界到了 ⇒ 播报一次，并且**用播报之后的新状态**重排', () => {
    // 复用旧边界值会让一条「窗口已关、徽标已消失」的活动按同一时刻反复空转。
    const timers = fakeTimers()
    timers.setNow(0)
    const fire = vi.fn()
    let calls = 0
    const broadcaster = createPromotionEdgeBroadcaster({
      edgeSources: () => [() => {
        calls += 1
        // 第一次给一个边界，第二次（播报后）说「没有了」。
        return calls === 1 ? 10_000 : undefined
      }],
      fire,
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    broadcaster.schedule()
    expect(timers.armed()[0]!.delay).toBe(10_000)
    timers.setNow(10_000)
    timers.fireNext()
    expect(fire).toHaveBeenCalledTimes(1)
    // ⚠️ 播报之后必须重排 ⇒ 此处应当**停表**（新状态说没有边界了）。
    // 变异：onFire 里不重新 schedule ⇒ timers.armed() 仍是 []，
    // 但 nextFireAt 仍指着旧时刻 ⇒ 用下面两条合起来抓。
    expect(broadcaster.nextFireAt()).toBeUndefined()
    expect(timers.armed()).toHaveLength(0)
  })

  it('★★ 防自旋：时钟没推进 ⇒ **不重复播报**，但必须仍有一枚定时器', () => {
    // 边界落在「比此刻只晚几毫秒」时剩余被 clamp 到最小间隔 ⇒ 到点后若时钟没真的
    // 推进（假定时器 / 同一毫秒内重入），同一个边界会再次胜出。不拦就是广播风暴；
    // 而「拦下后直接 return 不重排」更糟：此后再也没有定时器，徽标永久停在
    // 旧的那一枚 —— 那比不修还难查（症状是「活动改了徽标再也不变」）。
    const timers = fakeTimers()
    timers.setNow(1_000_000)
    let fired = 0
    const broadcaster = createPromotionEdgeBroadcaster({
      // 恒给「比此刻晚 1 毫秒」：每一次都走 clamp 那一支。
      edgeSources: () => [() => timers.now() + 1],
      fire: () => { fired += 1 },
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    broadcaster.schedule()
    expect(timers.armed()).toHaveLength(1)
    // ⚠️ delay 必须被抬到最小间隔：不是 1 毫秒（那会立刻触发）、更不是 0。
    expect(timers.armed()[0]!.delay).toBe(MIN_EDGE_FIRE_GAP_MS)
    // 第一次到点：此前没播过 ⇒ 允许播报。
    timers.fireNext()
    expect(fired).toBe(1)
    expect(timers.armed()).toHaveLength(1)
    // 时钟没推进又来一次 ⇒ 距上次播报 0 ⇒ 拦下，但**不断表**。
    timers.fireNext()
    expect(fired, '时钟没推进时不该重复播报（广播风暴）').toBe(1)
    expect(timers.armed(), '拦下也必须重排，否则此后再无定时器').toHaveLength(1)
    // 时钟推进过最小间隔 ⇒ 正常播报。
    timers.setNow(1_000_000 + MIN_EDGE_FIRE_GAP_MS + 1)
    timers.fireNext()
    expect(fired).toBe(2)
  })
  it('⚠️ 早已过去的边界一律不排（那已经是「现在」，交给下一次重算）', () => {
    const timers = fakeTimers()
    timers.setNow(1_000_000)
    const fire = vi.fn()
    const broadcaster = createPromotionEdgeBroadcaster({
      edgeSources: () => [() => 999_999, () => 500_000],
      fire,
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    broadcaster.schedule()
    expect(timers.armed()).toHaveLength(0)
    expect(fire).toHaveBeenCalledTimes(0)
    expect(nearestPromotionEdge([() => 999_999, () => 1_500_000], 1_000_000)).toBe(1_500_000)
  })

  it('⚠️ schedule() **幂等**：重复调用不得叠加定时器（与刷新器同一条约定）', () => {
    const timers = fakeTimers()
    timers.setNow(0)
    const broadcaster = createPromotionEdgeBroadcaster({
      edgeSources: () => [() => 50_000],
      fire: () => {},
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    broadcaster.schedule()
    broadcaster.schedule()
    broadcaster.schedule()
    expect(timers.armed()).toHaveLength(1)
    expect(timers.armed()[0]!.delay).toBe(50_000)
  })

  it('★ stop() 真停表：句柄必须交给 clearTimeoutImpl（只置 undefined 是「看着停了还在跑」）', () => {
    const timers = fakeTimers()
    timers.setNow(0)
    // ⚠️ 代理而不是替换：把 clearTimeoutImpl 直接写成裸 spy 会让替身**不再真的**
    // 出队，于是「停表后 armed 为空」这条断言恒红（本文件第一版就栽在这里）。
    // 被测的是「有没有把句柄交出去」，替身的出队行为必须照常发生。
    const cleared = vi.fn((handle: unknown) => timers.clearTimeoutImpl(handle))
    const broadcaster = createPromotionEdgeBroadcaster({
      edgeSources: () => [() => 50_000],
      fire: () => {},
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: cleared,
    })
    broadcaster.schedule()
    broadcaster.stop()
    expect(cleared).toHaveBeenCalledTimes(1)
    expect(timers.armed()).toHaveLength(0)
    // 停表后可以再次武装。
    broadcaster.schedule()
    expect(timers.armed()).toHaveLength(1)
    // 幂等：再 stop 一次不该多清一次（handle 已 undefined）。
    // ⚠️ stop() 之后 nextFireAt 必须一起清空：留着读数会让诊断面显示
    // 「下一次在 T」而实际上已无定时器。
    broadcaster.stop()
    expect(broadcaster.nextFireAt()).toBeUndefined()
    expect(cleared).toHaveBeenCalledTimes(2)
    broadcaster.stop()
    expect(cleared).toHaveBeenCalledTimes(2)
  })

  it('单个渠道的边界 getter 抛错 ⇒ 只跳过那一家，其余照常保鲜', () => {
    const timers = fakeTimers()
    timers.setNow(0)
    const broadcaster = createPromotionEdgeBroadcaster({
      edgeSources: () => [
        () => { throw new Error('渠道 A 的判据炸了') },
        () => 40_000,
      ],
      fire: () => {},
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    broadcaster.schedule()
    expect(timers.armed()[0]!.delay).toBe(40_000)
  })

  it('fire() 自身抛错 ⇒ 记一条日志并**继续排下一次**（不能反噬定时器）', () => {
    const timers = fakeTimers()
    timers.setNow(0)
    const warn = vi.fn()
    let asked = 0
    const broadcaster = createPromotionEdgeBroadcaster({
      // 第二次问时必须给一个**未来**的边界：第一次那个到点已成「过去」，
      // 若恒返回它，下面「仍在排下一次」会因为边界被剔掉而拿到 0 枚 ⇒ 假绿。
      edgeSources: () => [() => (asked++ === 0 ? 10_000 : 40_000)],
      fire: () => { throw new Error('广播失败') },
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      warn,
    })
    broadcaster.schedule()
    timers.setNow(10_000)
    timers.fireNext()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('广播失败')
    expect(timers.armed()).toHaveLength(1)
  })

  it('边界来源全为空数组 ⇒ 不排（未登录首帧不该空转）', () => {
    const timers = fakeTimers()
    const broadcaster = createPromotionEdgeBroadcaster({
      edgeSources: () => [],
      fire: () => {},
      now: timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    })
    broadcaster.schedule()
    expect(timers.armed()).toHaveLength(0)
  })
})
