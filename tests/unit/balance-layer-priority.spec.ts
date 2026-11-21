/**
 * 实证：内存里有新鲜读数时，磁盘旧值是否会被优先返回？
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

describe('三层缓存优先级实证', () => {
  beforeEach(() => {
    setBalanceDiskCacheEnabledForTest(true)
    clearBalanceDiskCache()
  })
  afterEach(() => {
    setBalanceDiskCacheEnabledForTest(false)
    clearBalanceDiskCache()
    resetBalanceDiskCacheStateForTest()
  })

  it('★★★ 内存有新鲜值时，不得被磁盘旧值覆盖', async () => {
    // 磁盘里放一条「2 小时前」的旧读数
    const old: BalanceReading = {
      at: Date.now() - 2 * 3600_000,
      value: { balance: 111 },
    }
    noteDiskReading('buddy', 'a1', old)
    flushDisk()
    resetBalanceDiskCacheStateForTest()
    primeFromDisk()

    // 让 fetch 返回「新值」
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async () => ({ balance: 222 }),
    })

    // 第一次读：磁盘命中 ⇒ 返回 111（正确，首屏不等网络）
    const first = await cache.readStale('buddy', 'a1', {})
    expect((first.value as { balance?: number }).balance, '首次命中磁盘').toBe(111)

    // 等后台刷新完成（它会写进内存 TtlCache + 磁盘镜像）
    await new Promise((r) => setTimeout(r, 50))

    // 第二次读：此时内存里应有「新值 222」
    const second = await cache.readStale('buddy', 'a1', {})
    expect(
      (second.value as { balance?: number }).balance,
      '★★★ 内存已有新值时，不得再返回磁盘旧值 111',
    ).toBe(222)
  })
})