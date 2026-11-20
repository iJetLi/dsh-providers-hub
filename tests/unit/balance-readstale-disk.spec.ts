/**
 * ★★★ **`readStale` 路径的磁盘缓存接入**（2026-11-21，真实漏接修复）。
 *
 * ## 它守的是什么（真实缺陷，用户报障）
 *
 * 用户：「积分加载好像没中缓存，时间还是 1~2 秒左右」。
 *
 * 排查发现**两处漏接**，都在 `readStale` 这条路径上：
 *
 * 1. **读**：`credits.balances` 端点调的是 `balanceCacheOf()!.readStale(...)`，
 *    而 `readStale` 内部直接 `await cache.get({ force })` 回源 ——
 *    **不经过** `getServingStale`（我第一版只接了那里）⇒ 磁盘缓存永不命中。
 * 2. **写**：`noteDiskReading` 只接在 `read()` 里，而端点走 `readStale`
 *    ⇒ **磁盘文件从未生成**（实测 `~/.dsh/cache/balance-readings.json` 不存在）。
 *
 * ⇒ 本文件两条都测：**读得回来**（不打网络）+ **写得下去**（脏标记置位）。
 *
 * ⚠️ 教训：`balance-cache.ts` 有**两条消费路径**（`read` 与 `readStale`），
 * 只覆盖一条 = 完全没做。这类「两条同义路径」的漏接在本仓库反复出现。
 */
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createBalanceCache, type BalanceReading } from '../../src/balance-cache.js'
import {
  balanceDiskCacheFile,
  clearBalanceDiskCache,
  flushDisk,
  isDiskDirty,
  noteDiskReading,
  primeFromDisk,
  readDiskReading,
  resetBalanceDiskCacheStateForTest,
  setBalanceDiskCacheEnabledForTest,
} from '../../src/balance-disk-cache.js'

/** 一条「上次进程」读到的余额（`BalanceReading` 形状：余额在 `value` 里）。 */
const diskReading: BalanceReading = {
  at: 1_700_000_000_000,
  value: { provider: 'buddy', id: 'a1', balance: 999 },
}

/** 从读数里取余额数字（`value` 是 `unknown`）。 */
const balanceOf = (reading: { value?: unknown } | undefined): number | undefined =>
  (reading?.value as { balance?: number } | undefined)?.balance

describe('createBalanceCache：readStale 的磁盘缓存（credits.balances 真实路径）', () => {
  beforeEach(() => {
    setBalanceDiskCacheEnabledForTest(true)
    clearBalanceDiskCache()
  })

  afterEach(() => {
    setBalanceDiskCacheEnabledForTest(false)
    clearBalanceDiskCache()
    resetBalanceDiskCacheStateForTest()
  })

  /** 写一条磁盘读数并模拟进程重启。 */
  const seedDiskAndRestart = (): void => {
    noteDiskReading('buddy', 'a1', diskReading)
    flushDisk()
    resetBalanceDiskCacheStateForTest()
    primeFromDisk()
  }

  it('★★★ 磁盘有读数 ⇒ readStale **不发网络**且返回该值', async () => {
    seedDiskAndRestart()

    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        return { provider, id: entry.id, balance: 1 }
      },
    })

    const out = await cache.readStale('buddy', 'a1', {})
    expect(balanceOf(out), '必须返回磁盘里的旧读数').toBe(999)
    // ⚠️ 这条是本次修复的核心：修复前它会调到 fetch（calls 非空）。
    expect(calls, '★★★ readStale 不得打网络（那正是要消除的 1~2 秒）').toHaveLength(0)
  })

  it('★★★ readStale 返回的磁盘读数**必须标 stale: true**', async () => {
    seedDiskAndRestart()
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async () => ({ balance: 1 }),
    })

    const out = await cache.readStale('buddy', 'a1', {})
    // ⚠️ 不标它 ⇒ 刷新器认为读数新鲜、永不回源 ⇒ 一直显示上次退出时的余额。
    expect(out.stale, '★★★ 磁盘读数必须标 stale').toBe(true)
  })

  it('★★★ 成功回源后**记进磁盘镜像**（置脏标记）', async () => {
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider: string, entry: { id: string }) =>
        ({ provider, id: entry.id, balance: 42 }),
    })

    // 磁盘为空 ⇒ 走回源
    const out = await cache.readStale('buddy', 'a1', {})
    expect(balanceOf(out)).toBe(42)

    /**
     * ⚠️ 2026-11-21 修订：**首次成功会立即写盘**（`primedThisProcess`），
     * 故这里脏标记已清 —— 但文件**已经存在**，那才是「会不会落盘」的真判据。
     *
     * 第一版断言 `isDiskDirty() === true`，在补了「首次立即写盘」之后失效。
     */
    expect(existsSync(balanceDiskCacheFile()), '★★★ 成功读数必须落盘').toBe(true)
    expect(isDiskDirty(), '首次已写盘 ⇒ 脏标记清').toBe(false)
    resetBalanceDiskCacheStateForTest()
    primeFromDisk()
    expect((readDiskReading('buddy', 'a1') as { value?: { balance?: number } })?.value?.balance)
      .toBe(42)
  })

  it('★★ `force` 时**不读磁盘**（面板「刷新」必须拿真实值）', async () => {
    seedDiskAndRestart()

    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        return { provider, id: entry.id, balance: 7 }
      },
    })

    const out = await cache.readStale('buddy', 'a1', {}, { force: true })
    expect(balanceOf(out), 'force 必须绕过磁盘缓存').toBe(7)
    expect(calls, 'force 必须真的回源').toHaveLength(1)
  })

  it('★ 磁盘读数只对**对应账号**生效（不串号）', async () => {
    seedDiskAndRestart()

    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(entry.id)
        return { provider, id: entry.id, balance: 5 }
      },
    })

    const hit = await cache.readStale('buddy', 'a1', {})
    expect(balanceOf(hit)).toBe(999)
    const miss = await cache.readStale('buddy', 'a2', {})
    expect(balanceOf(miss), 'a2 没有磁盘值 ⇒ 回源').toBe(5)
    expect(calls).toEqual(['a2'])
  })
})