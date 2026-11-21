/**
 * 实证：为什么「后台刷新完成后，第二次打开仍是旧值」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createBalanceCache, type BalanceReading } from '../../src/balance-cache.js'
import {
  clearBalanceDiskCache,
  flushDisk,
  noteDiskReading,
  primeFromDisk,
  readDiskReading,
  resetBalanceDiskCacheStateForTest,
  setBalanceDiskCacheEnabledForTest,
} from '../../src/balance-disk-cache.js'

const acct = (id: string) => ({ id })

describe('后台刷新后，第二次读取拿到什么', () => {
  beforeEach(() => {
    setBalanceDiskCacheEnabledForTest(true)
    clearBalanceDiskCache()
  })
  afterEach(() => {
    setBalanceDiskCacheEnabledForTest(false)
    clearBalanceDiskCache()
    resetBalanceDiskCacheStateForTest()
  })

  it('★★★ 后台刷新完成后，第二次 readStale 必须拿到新值', async () => {
    // 磁盘：2 小时前的旧值 111
    noteDiskReading('buddy', 'a1', {
      at: Date.now() - 2 * 3600_000,
      value: { balance: 111 },
    } as unknown as BalanceReading)
    flushDisk()
    resetBalanceDiskCacheStateForTest()
    primeFromDisk()

    // fetch 返回新值 222
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async () => ({ balance: 222 }),
    })

    // 第一次：命中磁盘 ⇒ 111 + 后台刷新
    const first = await cache.readStale('buddy', 'a1', {})
    console.log('  第一次:', (first.value as { balance?: number }).balance, 'stale:', first.stale)
    expect((first.value as { balance?: number }).balance, '首次应返回磁盘旧值').toBe(111)

    // 等后台刷新完成
    await new Promise((r) => setTimeout(r, 100))

    // 第二次：应该拿到新值 222
    const second = await cache.readStale('buddy', 'a1', {})
    console.log('  第二次:', (second.value as { balance?: number }).balance, 'stale:', second.stale)

    expect(
      (second.value as { balance?: number }).balance,
      '★★★ 后台刷新完成后，第二次必须拿到新值 222（用户要的就是这个）',
    ).toBe(222)
  })

  it('★★★ 后台刷新成功后必须**立即落盘**（强杀也不丢新值）', async () => {
    // 磁盘：2 小时前的旧值 111
    noteDiskReading('buddy', 'a1', {
      at: Date.now() - 2 * 3600_000,
      value: { balance: 111 },
    } as unknown as BalanceReading)
    flushDisk()
    resetBalanceDiskCacheStateForTest()
    primeFromDisk()

    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async () => ({ balance: 222 }),
    })

    // 首次命中磁盘 ⇒ 111 + 后台刷新
    await cache.readStale('buddy', 'a1', {})
    await new Promise((r) => setTimeout(r, 100))

    /**
     * ⚠️⚠️ **关键：模拟「用户强制退出 DSH」（不触发退出钩子）**。
     *
     * 上一版只在「首次」与「30 分钟定时器」写盘 ⇒ 这里的新值 222 只进了
     * 内存镜像、**没进磁盘文件** ⇒ 复位后读到的是旧值 111
     *（用户实测：重启后看到的全是 50~176 分钟前的旧值）。
     *
     * ⇒ 现在 `noteDiskReading` 每次都落盘，复位后必须读到 222。
     */
    resetBalanceDiskCacheStateForTest() // 模拟进程重启（内存全丢）
    const primed = primeFromDisk()

    expect(primed, '必须有读数被落盘').toBeGreaterThan(0)
    const afterRestart = readDiskReading('buddy', 'a1') as { value?: { balance?: number } } | undefined
    expect(
      afterRestart?.value?.balance,
      '★★★ 后台刷新的新值 222 必须已落盘（强杀也不丢）',
    ).toBe(222)
  })
})