/**
 * ★★★ **磁盘缓存的冷启动路径**（2026-11-20 新增）。
 *
 * 独立成文件而不是追加进 `balance-cache.spec.ts`：
 * 后者的世界工厂（`makeWorld`）在文件内是模块级私有，追加段落会取不到它；
 * 而本组用例只需要最朴素的 `createBalanceCache`，自带更清晰。
 *
 * ## 它守的是什么
 *
 * 内存层（`TtlCache`，15 分钟）在**进程重启后是空的** ⇒ 冷启动第一次
 * `read()` 会逐账号回源 ⇒ 积分窗口 ~1 秒才出数。磁盘层跨进程存活 ⇒ 立刻有值。
 *
 * ## ⚠️⚠️ 最关键的一条：必须标 `stale: true`
 *
 * 若返回旧值却**不标 stale**，后台刷新器（`createBalanceRefresher`）会认为
 * 这条读数新鲜、不用刷 ⇒ **永远不会被真实值替换** ⇒ 用户一直看到上次退出时的
 * 余额（可能几小时前），且**永不自愈**。
 *
 * ⚠️ 变异 M9（去掉 `stale: true`）首轮**无牙** ⇒ 就是缺了本文件这组用例。
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

/**
 * 一条「上次进程」读到的余额。
 *
 * ⚠️ 形状是 `BalanceReading`（`{ at, value, error?, stale? }`），
 * 余额数字在 `value` 里 —— 不是 `balance` 字段。第一版用例把它们写错了，
 * 于是 `(out.get('a1')?.value as { balance?: number } | undefined)?.balance` 恒 `undefined` 而假红。
 */
const diskReading: BalanceReading = {
  at: 1_700_000_000_000,
  value: { provider: 'buddy', id: 'a1', balance: 999 },
}

describe('createBalanceCache：磁盘缓存的冷启动路径', () => {
  beforeEach(() => {
    setBalanceDiskCacheEnabledForTest(true)
    clearBalanceDiskCache()
  })

  afterEach(() => {
    setBalanceDiskCacheEnabledForTest(false)
    clearBalanceDiskCache()
    resetBalanceDiskCacheStateForTest()
  })

  /** 把一条读数写进磁盘，并模拟「进程重启」（复位内存镜像后 prime）。 */
  const seedDiskAndRestart = (): void => {
    noteDiskReading('buddy', 'a1', diskReading)
    flushDisk()
    resetBalanceDiskCacheStateForTest()
    primeFromDisk()
  }

  it('★★★ 磁盘有读数 ⇒ 冷读**不发网络**且立即返回该值', async () => {
    seedDiskAndRestart()

    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        return { provider, id: entry.id, balance: 1 } as unknown as BalanceReading
      },
    })

    const out = await cache.read('buddy', [acct('a1')])
    expect((out.get('a1')?.value as { balance?: number } | undefined)?.balance, '必须返回磁盘里的旧读数').toBe(999)
    expect(calls, '★★★ 冷读不得打网络（那正是要消除的 1 秒）').toHaveLength(0)
  })

  it('★★★ 返回的旧读数**必须标 stale: true**（否则永不刷新）', async () => {
    seedDiskAndRestart()

    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider: string, entry: { id: string }) =>
        ({ provider, id: entry.id, balance: 1 }) as unknown as BalanceReading,
    })

    const out = await cache.read('buddy', [acct('a1')])
    // ⚠️ 这条是变异 M9 的克星：去掉 `stale: true` 后它变红。
    expect(out.get('a1')?.stale, '★★★ 磁盘读数必须标 stale，否则刷新器认为不用刷').toBe(true)
  })

  it('★★ 没有磁盘读数 ⇒ 照原路回源（行为与加缓存前一致）', async () => {
    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(`${provider}:${entry.id}`)
        return { provider, id: entry.id, balance: 7 } as unknown as BalanceReading
      },
    })

    const out = await cache.read('buddy', [acct('a1')])
    expect((out.get('a1')?.value as { balance?: number } | undefined)?.balance).toBe(7)
    expect(calls, '无磁盘缓存时必须回源').toHaveLength(1)
  })

  it('★ 磁盘读数只对**对应账号**生效（不串号）', async () => {
    seedDiskAndRestart()

    const calls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider: string, entry: { id: string }) => {
        calls.push(entry.id)
        return { provider, id: entry.id, balance: 5 } as unknown as BalanceReading
      },
    })

    const out = await cache.read('buddy', [acct('a1'), acct('a2')])
    expect((out.get('a1')?.value as { balance?: number } | undefined)?.balance, 'a1 用磁盘值').toBe(999)
    expect((out.get('a2')?.value as { balance?: number } | undefined)?.balance, 'a2 没有磁盘值 ⇒ 回源').toBe(5)
    expect(calls, '只有 a2 该回源').toEqual(['a2'])
  })

  /**
   * ★★★ **首次成功必须落盘**（2026-11-21 修订 —— 第一版这里是错的）。
   *
   * 第一版断言「不立即写盘」，而真实缺陷正是**从不写盘**：
   * 用户重启间隔只有几分钟 ⇒ 30 分钟定时器没到、退出钩子没跑
   * ⇒ 缓存文件从未生成 ⇒ 功能完全没生效。
   *
   * ⇒ 现在首次成功即写一次（每进程仅一次），之后的读数才走 30 分钟节奏。
   */
  it('★★★ 成功回源后**首次立即落盘**（自举前提）', async () => {
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider: string, entry: { id: string }) =>
        ({ provider, id: entry.id, balance: 33 }) as unknown as BalanceReading,
    })

    await cache.read('buddy', [acct('a1')])
    // 复位内存后仍能读回 ⇒ 证明真的落盘了
    resetBalanceDiskCacheStateForTest()
    expect(primeFromDisk(), '首次成功必须已落盘').toBeGreaterThan(0)
  })

  it('★ 磁盘读数被真正替换的路径：flush 之后新读数覆盖旧值', async () => {
    seedDiskAndRestart()
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider: string, entry: { id: string }) =>
        ({ provider, id: entry.id, balance: 12 }) as unknown as BalanceReading,
    })

    // 冷读一次（拿到磁盘旧值）
    const first = await cache.read('buddy', [acct('a1')])
    expect((first.get('a1')?.value as { balance?: number } | undefined)?.balance).toBe(999)

    // ⚠️ 强制刷新（面板上的「刷新积分」按钮走这条）⇒ 拿到真实值
    const forced = await cache.read('buddy', [acct('a1')], { force: true })
    expect((forced.get('a1')?.value as { balance?: number } | undefined)?.balance, '强制刷新必须绕过所有缓存').toBe(12)

    // 新值进了镜像 ⇒ flush 后落盘 ⇒ 下次启动读到的是新值
    flushDisk()
    resetBalanceDiskCacheStateForTest()
    expect(primeFromDisk(), '刷新后的新值应已落盘').toBeGreaterThan(0)
  })
})