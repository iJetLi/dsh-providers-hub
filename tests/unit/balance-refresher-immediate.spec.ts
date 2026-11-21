/**
 * ★★★ **后台刷新器必须在 `start()` 时立即跑一轮**（2026-11-21 真实缺陷）。
 *
 * ## 缺陷（用户实测打穿）
 *
 * 上一版 `start()` 只挂定时器：
 *
 * ```ts
 * timer = setIntervalImpl(() => { void tick() }, periodMs)   // 首轮要等 60 秒
 * ```
 *
 * ⇒ 用户「重启后过 3 秒打开积分窗口」时，**后台刷新压根还没开始**
 * ⇒ 内存是空的（刚重启）⇒ 走磁盘缓存 ⇒ 显示上次会话的旧值
 * ⇒ 而界面不会自动重绘（60 秒轮询只对 `modelscope` 生效）
 * ⇒ **旧值一直挂着，直到用户手动点刷新**。
 *
 * 用户原话：
 *
 * > 「我明明是在重启后过了 3 秒才打开的，正常来说，内存已经有最新数值了，
 * >   为什么窗口还是显示旧值，这不奇怪吗？」
 *
 * **他的推理完全正确** —— 内存本该有新值，但那个「本该」的前提
 *（启动即拉一次）**从来没有实现过**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBalanceCache, createBalanceRefresher } from '../../src/balance-cache.js'

const acct = (id: string) => ({ id, provider: 'buddy', enabled: true, credentialRef: `BUDDY_${id}` })

describe('createBalanceRefresher：start() 立即跑首轮', () => {
  /** 造一个可控世界：记录 fetch 调用次数，定时器手动推进。 */
  function makeWorld(): {
    refresher: ReturnType<typeof createBalanceRefresher>
    cache: ReturnType<typeof createBalanceCache>
    fetchCalls: () => number
    flushTimers: () => void
  } {
    let fetchCount = 0
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider: string, entry: { id: string }) => {
        fetchCount += 1
        return { provider, id: entry.id, balance: 42 }
      },
    })
    // 收集定时器回调（不真的等 60 秒）
    const pending: Array<() => void> = []
    const refresher = createBalanceRefresher(cache, {
      listAccounts: async () => [acct('a1')],
      resolveCredential: async () => ({ access_token: 'AT' }),
      intervalMs: 60_000,
      /**
       * ⚠️ 注入式定时器（选项名是 `setInterval`，返回值只需 `{ unref? }`）。
       * 收集回调供用例手动推进，**不真跑 60 秒**。
       */
      setInterval: ((fn: () => void) => {
        pending.push(fn)
        return { unref: () => {} }
      }) as never,
      info: () => {},
      warn: () => {},
    })
    return {
      refresher,
      cache,
      fetchCalls: () => fetchCount,
      flushTimers: () => { for (const fn of pending) fn() },
    }
  }

  it('★★★ start() 必须立即拉一轮（不等第一个周期）', async () => {
    const world = makeWorld()
    expect(world.fetchCalls(), 'start 之前不该有请求').toBe(0)

    world.refresher.start()
    // ⚠️ 不推进定时器，只等微任务/宏任务跑完
    await new Promise((r) => setTimeout(r, 50))

    expect(
      world.fetchCalls(),
      '★★★ start() 必须立即拉一轮（否则「重启后 3 秒打开」时内存还是空的）',
    ).toBeGreaterThan(0)
  })

  it('★★ 首轮之后，后续仍由定时器驱动', async () => {
    const world = makeWorld()
    world.refresher.start()
    await new Promise((r) => setTimeout(r, 50))
    const afterFirst = world.fetchCalls()
    expect(afterFirst).toBeGreaterThan(0)

    // 手动推进一个周期
    world.flushTimers()
    await new Promise((r) => setTimeout(r, 50))
    expect(world.fetchCalls(), '定时器仍要能驱动后续轮次').toBeGreaterThanOrEqual(afterFirst)
  })

  it('★ start() 幂等（重复调用不叠加 interval）', () => {
    const world = makeWorld()
    world.refresher.start()
    world.refresher.start()
    world.refresher.start()
    // 幂等 ⇒ 仍只有一个 interval（第二次起直接 return）
    expect(world.refresher.isArmed()).toBe(true)
  })
})