/**
 * 实证 3：后台刷新与正常请求的并发行为。
 *
 * 关注点：
 *  1. 后台刷新会不会造成「每次 readStale 都打一次上游」？
 *  2. `force: true` 与正常请求共享 in-flight 时，结果是否互相污染？
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

describe('后台刷新的并发行为', () => {
  beforeEach(() => {
    setBalanceDiskCacheEnabledForTest(true)
    clearBalanceDiskCache()
  })
  afterEach(() => {
    setBalanceDiskCacheEnabledForTest(false)
    clearBalanceDiskCache()
    resetBalanceDiskCacheStateForTest()
  })

  const seed = (): void => {
    noteDiskReading('buddy', 'a1', {
      at: Date.now() - 3600_000,
      value: { balance: 111 },
    } as unknown as BalanceReading)
    flushDisk()
    resetBalanceDiskCacheStateForTest()
    primeFromDisk()
  }

  it('★★ 连续多次 readStale 不得每次都打上游（去重）', async () => {
    seed()
    let calls = 0
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async () => {
        calls++
        return { balance: 222 }
      },
    })

    // 连续 5 次冷读（模拟前端快速刷新）
    for (let i = 0; i < 5; i++) {
      await cache.readStale('buddy', 'a1', {})
    }
    await new Promise((r) => setTimeout(r, 100))

    console.log('  上游被调用次数:', calls)
    expect(calls, '★★ 5 次冷读不应打 5 次上游（in-flight 去重 + 内存新鲜值）').toBeLessThanOrEqual(2)
  })

  it('★★ 后台刷新期间内存出现新鲜值后，后续读取不再打上游', async () => {
    seed()
    let calls = 0
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async () => {
        calls++
        return { balance: 222 }
      },
    })

    await cache.readStale('buddy', 'a1', {}) // 首次：磁盘命中 + 后台刷新
    await new Promise((r) => setTimeout(r, 100))
    const afterFirst = calls

    // 后续多次读取应命中内存新鲜值
    for (let i = 0; i < 5; i++) await cache.readStale('buddy', 'a1', {})
    await new Promise((r) => setTimeout(r, 100))

    console.log('  首次后 calls:', afterFirst, '5 次后 calls:', calls)
    expect(calls, '内存新鲜值应挡住后续上游请求').toBe(afterFirst)
  })
})