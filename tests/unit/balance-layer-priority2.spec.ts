/**
 * 实证 2：内存 TtlCache 里有新鲜值，但磁盘镜像里是更旧的值 —— 谁赢？
 *
 * 场景构造：
 *  1. 磁盘里放「2 小时前」的旧读数；
 *  2. 用 `cache.write()` 或一次正常 read 让**内存 TtlCache** 里有「刚刚」的新值；
 *  3. 关键：让 `noteDiskReading` 不更新镜像（模拟「后台刷新失败」或
 *     「内存值来自 writeBalance 等其它路径」）；
 *  4. 再 readStale，看返回哪个。
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

describe('三层缓存优先级：内存 vs 磁盘', () => {
  beforeEach(() => {
    setBalanceDiskCacheEnabledForTest(true)
    clearBalanceDiskCache()
  })
  afterEach(() => {
    setBalanceDiskCacheEnabledForTest(false)
    clearBalanceDiskCache()
    resetBalanceDiskCacheStateForTest()
  })

  it('★★★ 内存有新鲜读数时，磁盘旧值不得遮蔽它（用 read() 构造）', async () => {
    // ① 磁盘：2 小时前的旧值 111
    noteDiskReading('buddy', 'a1', {
      at: Date.now() - 2 * 3600_000,
      value: { balance: 111 },
    })
    flushDisk()

    // ② 关键：**不复位内存镜像**，直接用 `cache.write()` 把「新值 222」写进 TtlCache。
    //    这模拟「内存有新鲜值，但磁盘镜像还是旧的」。
    resetBalanceDiskCacheStateForTest()
    primeFromDisk() // 镜像里是 111

    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async () => ({ balance: 999 }), // 若回源会拿到 999
    })

    // 用 write() 直接塞内存 TtlCache（模拟别的路径刚更新过）
    cache.write('buddy', 'a1', { at: Date.now(), value: { balance: 222 } })

    // ③ 此时：内存 TtlCache = 222（新鲜），磁盘镜像 = 111（2 小时前）
    const out = await cache.readStale('buddy', 'a1', {})

    console.log('  返回的余额:', (out.value as { balance?: number })?.balance)
    console.log('  stale 标记:', out.stale)
    expect(
      (out.value as { balance?: number }).balance,
      '★★★ 内存有新鲜值 222 时，不得返回磁盘旧值 111',
    ).toBe(222)
  })

  it('★★★ `force` 必须绕过内存层（面板「刷新积分」不能变假按钮）', async () => {
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async () => ({ balance: 999 }),
    })

    // 先把「222」写进内存 TtlCache（新鲜）
    cache.write('buddy', 'a1', { at: Date.now(), value: { balance: 222 } })

    // 非 force ⇒ 命中内存，返回 222
    const normal = await cache.readStale('buddy', 'a1', {})
    expect((normal.value as { balance?: number }).balance, '非 force 命中内存').toBe(222)

    /**
     * ★ force ⇒ **必须回源**（拿到 999）。
     *
     * ⚠️ 若内存层无视 `force`，这里会返回 222 ⇒ 面板「刷新积分」变成假按钮
     *（用户点了没反应，与 issue IKLTZ2 的形态同源）。
     */
    const forced = await cache.readStale('buddy', 'a1', {}, { force: true })
    expect(
      (forced.value as { balance?: number }).balance,
      '★★★ force 必须绕过内存层，回源拿到 999',
    ).toBe(999)
  })
})