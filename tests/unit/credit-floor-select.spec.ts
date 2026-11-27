/**
 * ★★★ **`select()` 真的降档换号** —— 上游审计指定的**唯一验收标准**
 *
 * ## 审计原话
 *
 * > 「**判断『成没成』的是这一条**：
 * >  `(c)` **`select()` 在 `readCreditWindow` 给出 floor 时，真的选**另一个号**。**
 * >  **不是「阈值存进去了」、不是「get 能读回来」、不是「纯函数算得对」**」
 *
 * ## 缺陷（审计 D3）
 *
 * > 「`select()` 728/758 重算**不带阈值** ⇒ **锁定永久 + 短期阈值仍返回该号，
 * >  并烧掉它 25 点短期**」
 *
 * ## 本文件的构造
 *
 * 用**真 `BuddyBalanceSelector`** + 可注入的 `fetchBalance`（喂固定余额）+
 * `readCreditWindow`（喂阈值），然后：
 *
 * 1. **不设阈值** ⇒ 选中「临期号」
 * 2. **设阈值** ⇒ 选中**另一个号**（那个临期号被降档到永久，让位给真正有额的号）
 *
 * ⚠️ 这条与纯函数测试的根本区别：它**走 `select()` 的完整排序链**
 *（`balanceOf` → `classify` → `rankBuddyAccountsByBalance` → `rotateFromPreferred`）。
 */
import { describe, expect, it } from 'vitest'

import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'

const DAY = 86_400_000
/** 固定「现在」，让 `deductionEndTime` 可算。 */
const NOW = Date.UTC(2026, 10, 27, 0, 0, 0)

/** 一个 buddy 号：`imminent` 临期额度 + `permanent` 永久。 */
function balancePackages(imminent: number, permanent: number) {
  return {
    total: imminent + permanent,
    packages: [
      ...(imminent > 0
        ? [{ name: 'Bonus', unit: 'credit', remaining: imminent, total: imminent, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 2 * DAY }]
        : []),
      ...(permanent > 0
        ? [{ name: 'Plan', unit: 'credit', remaining: permanent, total: permanent, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 400 * DAY }]
        : []),
    ],
    expiredTotal: 0,
  }
}

/** 建一个真 selector，余额由 `balances` 表决定，窗口/阈值由 `credits` 决定。 */
function makeSelector(options: {
  balances: Record<string, { imminent: number, permanent: number }>
  windowDays?: number
  imminentDays?: number
  imminentFloor?: number
  expiringFloor?: number
}) {
  return new BuddyBalanceSelector({
    product: { id: 'probe' } as never,
    resolveCredential: async () => ({}) as never,
    now: () => NOW,
    /**
     * ⚠️⚠️ **第一参是 credential，不是 account！** 账号 id 在**第三参**
     * `ctx.accountId`（见 `BalanceFetchContext`）。
     *
     * 我第一版把桩写成 `(account) => ...account.id` ⇒ **两个号拿到同一份余额**
     * ⇒ 用例看起来"没降档"，实际是**桩写错了**（诊断打出来的
     * `a 的 imminentBalance: 500` 就是它 —— a 本该是 5）。
     */
    fetchBalance: async (_credential, _product, ctx) => {
      const b = options.balances[ctx?.accountId ?? '']
      return b === undefined ? null : (balancePackages(b.imminent, b.permanent) as never)
    },
    /** ⚠️ 注入窗口/阈值（= `AccountPool.creditWindow` 那条腿）。 */
    readCreditWindow: () => ({
      ...(options.windowDays === undefined ? {} : { windowDays: options.windowDays }),
      ...(options.imminentDays === undefined ? {} : { imminentDays: options.imminentDays }),
      ...(options.imminentFloor === undefined ? {} : { imminentFloor: options.imminentFloor }),
      ...(options.expiringFloor === undefined ? {} : { expiringFloor: options.expiringFloor }),
    }) as never,
  } as never)
}

const ACCOUNTS = [
  { id: 'a-low-imminent', credentialRef: 'R-a', enabled: true },
  { id: 'b-healthy', credentialRef: 'R-b', enabled: true },
] as never

describe('★★★ (c) select() 真的降档换号（上游指定的唯一验收标准）', () => {
  it('★★★ 不设阈值 ⇒ 选「临期量少的号」（改动前行为）', async () => {
    /**
     * 两个号：
     * - `a-low-imminent`：临期 **5** + 永久 800
     * - `b-healthy`：临期 **500** + 永久 0
     *
     * 不设阈值时两者都是「临期档」，排序按池序 ⇒ 选第一个 `a-low-imminent`。
     */
    const selector = makeSelector({
      balances: {
        'a-low-imminent': { imminent: 5, permanent: 800 },
        'b-healthy': { imminent: 500, permanent: 0 },
      },
      windowDays: 15,
      imminentDays: 5,
    })
    const result = await selector.select(ACCOUNTS, {})
    expect(result.ok, '★ 应当成功选中').toBe(true)
    const picked = result.ok ? result.account.id : undefined
    console.log('  [不设阈值] 选中: ' + String(picked))
    expect(picked, '★ 不设阈值 ⇒ 池序第一个（临期 5 的那个）').toBe('a-low-imminent')
  })

  it('★★★ 设临期阈值 20 ⇒ **真的换号**（选 b-healthy）', async () => {
    /**
     * ## 这就是审计要的那一格
     *
     * 设 `imminentFloor: 20` 后：
     * - `a-low-imminent`：临期 5 ≤ 20 ⇒ **降档到 permanent**
     * - `b-healthy`：临期 500 > 20 ⇒ **仍在 imminent 档**
     *
     * ⇒ 排序把 `b-healthy` 排前面 ⇒ **选中它**（而不是 a）。
     *
     * ⚠️ 修复前：`select()` 的 `options` 不带 floor ⇒ 排序仍当两者都是临期
     *   ⇒ 仍选 `a-low-imminent` ⇒ **本用例必红**。
     */
    const selector = makeSelector({
      balances: {
        'a-low-imminent': { imminent: 5, permanent: 800 },
        'b-healthy': { imminent: 500, permanent: 0 },
      },
      windowDays: 15,
      imminentDays: 5,
      imminentFloor: 20,
    })
    const result = await selector.select(ACCOUNTS, {})
    expect(result.ok).toBe(true)
    const picked = result.ok ? result.account.id : undefined
    console.log('  [设阈值 20] 选中: ' + String(picked))
    expect(
      picked,
      '★★★ 阈值 20 应让临期 5 的号降档 ⇒ **必须选 b-healthy**（选回 a = 降档没发生）',
    ).toBe('b-healthy')
  })

  it('★★★ 反向对照：阈值调低到 1 ⇒ 又选回 a（证明判据在跟随阈值）', async () => {
    /**
     * ⚠️ **没有这条，上面那条可能是别的原因碰巧**。
     * 阈值 1 时 `5 > 1` 成立 ⇒ a 仍在临期档 ⇒ 选回 a。
     */
    const selector = makeSelector({
      balances: {
        'a-low-imminent': { imminent: 5, permanent: 800 },
        'b-healthy': { imminent: 500, permanent: 0 },
      },
      windowDays: 15,
      imminentDays: 5,
      imminentFloor: 1,
    })
    const result = await selector.select(ACCOUNTS, {})
    const picked = result.ok ? result.account.id : undefined
    console.log('  [阈值 1] 选中: ' + String(picked))
    expect(picked, '★★ 阈值 1 时临期 5 仍算临期 ⇒ 选回 a').toBe('a-low-imminent')
  })

  it('★★★ 审计 D3 原场景：锁定永久 + 短期阈值 ⇒ **不去烧永久号的短期**', async () => {
    /**
     * ## 审计原文
     *
     * > 「`select()` 728/758 重算**不带阈值** ⇒ **锁定永久 + 短期阈值
     * >  仍返回该号，并烧掉它 25 点短期**」
     *
     * ## 构造
     *
     * - `only-permanent`：短期 **25** + 永久 800
     * - `has-imminent`：临期 **500** + 永久 0
     *
     * 设 `expiringFloor: 30`（短期 ≤ 30 降档）：
     * - `only-permanent`：短期 25 ≤ 30 ⇒ 降档到 permanent
     * - 锁定永久（`allowPermanent: false`）⇒ 它变成 **none（不可用）**
     * ⇒ **必须选 `has-imminent`**，而不是烧掉 `only-permanent` 的 25 点短期。
     */
    const selector = makeSelector({
      balances: {
        'only-permanent': { imminent: 0, permanent: 800 },
        'has-imminent': { imminent: 500, permanent: 0 },
      },
      windowDays: 15,
      imminentDays: 5,
      expiringFloor: 30,
    })
    /**
     * ⚠️ 第二个号没有「短期」只有「临期」—— 临期 ⊂ 短期，故它对 expiringFloor
     *   也要判（500 > 30 ⇒ 仍在短期/临期档）。
     */
    const result = await selector.select(
      [
        { id: 'only-permanent', credentialRef: 'R-c', enabled: true },
        { id: 'has-imminent', credentialRef: 'R-d', enabled: true },
      ] as never,
      { allowPermanent: false },
    )
    const picked = result.ok ? result.account.id : undefined
    console.log('  [锁定 + 短期阈值 30] 选中: ' + String(picked))
    expect(
      picked,
      '★★★ 锁定态 + 短期 ≤ 阈值 ⇒ 那个号不可用 ⇒ **必须选 has-imminent**'
        + '（选回 only-permanent = D3 那个「烧 25 点短期」的缺陷仍在）',
    ).toBe('has-imminent')
  })
})
