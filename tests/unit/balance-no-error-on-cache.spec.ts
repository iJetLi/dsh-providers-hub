/**
 * ★★★ **缓存命中时不得给积分行附 `error`**（2026-11-21 真实回归）。
 *
 * ## 回归现象（用户截图实测）
 *
 * 7 个 qodercn 账号的积分行全部显示成：
 *
 * ```
 * 积分  显示的是 2026/11/21 20:16:10 的缓存读数
 * ```
 *
 * 而用户要的是**积分数字**，不是「数据来源」。原话：
 *
 * > 「我要求的是显示积分，而不是积分的来源」
 * > 「期间都是后台静默完成，前端也不必要显示任何信息」
 *
 * ## 机理：客户端是**二选一**渲染
 *
 * ```js
 * if (error || !balance) {
 *   return <dd data-tone="warn">{error}</dd>   // ← 只显示 error，积分不渲染
 * }
 * // 有 balance 才往下画积分
 * ```
 *
 * ⇒ 只要 `error` 有值，**积分数字根本不出现**。
 *
 * ## 判据：只有「带 error 的 stale」才是真失败
 *
 * | 来源 | `stale` | `error` | 该不该提示 |
 * |---|---|---|---|
 * | 兼顶（上游真失败）| true | **有值** | ✅ 该提示 |
 * | **磁盘缓存命中** | true | **无值** | ❌ **不该提示** |
 * | 正常新鲜值 | false | 无值 | ❌ 不提示 |
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createBalanceCache, type BalanceReading } from '../../src/balance-cache.js'
import {
  clearBalanceDiskCache,
  flushDisk,
  noteDiskReading,
  primeFromDisk,
  resetBalanceDiskCacheStateForTest,
  setBalanceDiskCacheEnabledForTest,
} from '../../src/balance-disk-cache.js'

const acct = (id: string) => ({ id })

describe('缓存命中不得污染积分显示', () => {
  beforeEach(() => {
    setBalanceDiskCacheEnabledForTest(true)
    clearBalanceDiskCache()
  })
  afterEach(() => {
    setBalanceDiskCacheEnabledForTest(false)
    clearBalanceDiskCache()
    resetBalanceDiskCacheStateForTest()
  })

  const seedDisk = (): void => {
    noteDiskReading('buddy', 'a1', {
      at: Date.now() - 3600_000,
      value: { balance: 111 },
    } as unknown as BalanceReading)
    flushDisk()
    resetBalanceDiskCacheStateForTest()
    primeFromDisk()
  }

  it('★★★ 磁盘缓存命中 ⇒ 返回 stale:true 但 **error 必须为空**', async () => {
    seedDisk()
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async () => ({ balance: 222 }),
    })

    const out = await cache.readStale('buddy', 'a1', {})
    expect((out.value as { balance?: number }).balance, '要拿到积分数字').toBe(111)
    expect(out.stale, '必须标 stale（让刷新器知道该刷）').toBe(true)
    /**
     * ⚠️⚠️ **这是本用例的核心断言**。
     *
     * `error` 一旦有值，客户端就**不渲染积分**（只渲染那句说明）。
     */
    expect(
      out.error,
      '★★★ 磁盘缓存命中不是「失败」⇒ error 必须为空（否则积分数字被顶掉）',
    ).toBeUndefined()
  })

  it('★★ 真实失败（兼顶）⇒ error 必须有值（该提示还是要提示）', async () => {
    const cache = createBalanceCache({
      ttlMs: 1, // 极短 TTL，让下一次读取走兼顶
      fetch: async () => {
        throw new Error('上游挂了')
      },
    })

    // 第一次成功，把值记进 lastSuccess
    const okCache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async () => ({ balance: 333 }),
    })
    await okCache.readStale('buddy', 'a2', {})
    await new Promise((r) => setTimeout(r, 20))

    // 用会失败的 cache 读同一个 key —— 它会走兼顶（拿 lastSuccess）
    // ⚠️ 不同实例不共享 lastSuccess，故这里直接断言「失败时 error 有值」这个契约。
    const failOut = await cache.readStale('buddy', 'a3', {})
    expect(failOut.error, '真失败时 error 必须有值').toBeDefined()
    expect(failOut.stale, '真失败时也标 stale').toBe(true)
  })

  /**
   * ★★★ **磁盘命中 + 后台刷新失败 ⇒ 仍要能读到磁盘值（不空白）**。
   *
   * ## 为什么需要这条（评估「内存提升」方案时实测发现）
   *
   * 用户提出的设计是「磁盘值应提升进内存槽，窗口每次读内存」。
   * 评估时实测发现：**后台刷新的失败结果会写进内存槽**，把本可用的磁盘值挤掉。
   *
   * ```
   * 内存槽: { error: '上游挂了', stale: false }   ← 失败读数
   * 磁盘:   111（可用）
   * ```
   *
   * 好在磁盘兜底仍然生效（内存判据要求 `value !== undefined`，
   * 失败读数不满足 ⇒ 继续走磁盘分支）⇒ 第二次读仍拿到 111。
   *
   * ⚠️ **这条用例锁的就是那个「好在」** —— 一旦有人把内存判据放宽成
   * 「`stale === false` 就返回」，失败读数就会顶掉磁盘值
   * ⇒ 用户看到空白/错误，而磁盘里明明有数据。
   */
  it('★★★ 磁盘命中后后台刷新失败 ⇒ 第二次读仍拿到磁盘值（不空白）', async () => {
    noteDiskReading('buddy', 'b1', {
      at: Date.now() - 3600_000,
      value: { balance: 111 },
    } as unknown as BalanceReading)
    flushDisk()
    resetBalanceDiskCacheStateForTest()
    primeFromDisk()

    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async () => {
        throw new Error('上游挂了')
      },
    })

    // 第一次：命中磁盘 ⇒ 111
    const first = await cache.readStale('buddy', 'b1', {})
    expect((first.value as { balance?: number }).balance, '首次命中磁盘').toBe(111)

    // 等后台刷新（它会失败）
    await new Promise((r) => setTimeout(r, 100))

    // 第二次：后台刷新失败了，但磁盘还有值 ⇒ 仍应拿到 111
    const second = await cache.readStale('buddy', 'b1', {})
    expect(
      (second.value as { balance?: number }).balance,
      '★★★ 刷新失败不得让磁盘兜底失效（用户会看到空白）',
    ).toBe(111)
    expect(second.stale, '仍应标 stale').toBe(true)
  })
})