/**
 * ★★★ **M6 守卫：起点把「被降档的号」挪回第一位后，锁定判据必须仍然认得它**
 *
 * ## 为什么需要这条（M6 曾「无牙」）
 *
 * `select()` 里有两处用到档位：
 *
 * | 位置 | 作用 |
 * |---|---|
 * | 排序（`:738`）| 把「降档的号」排到后面 |
 * | **锁定判据（`:773`）** | 检查 `first` 是否可用 |
 *
 * ⇒ 若**没有起点**，`first` 一定是排好序的第一个 ⇒ 它必可用 ⇒ 该判据恒真
 *   ⇒ 传 `opts` 还是 `options` 无差别（M6 无牙，结构性冗余）。
 *
 * ⚠️ **但 `rotateFromPreferred` 会破坏这个前提**：起点会把**指定的号**
 *   强制挪到第一位，哪怕它已被降档 ⇒ 此时 `first` **可能不可用** ⇒
 *   判据真的承重。
 *
 * ## 本用例的构造
 *
 * - 池：`low`（短期 25，会被 `expiringFloor: 30` 降档）+ `healthy`（临期 500）
 * - **起点指定 `low`** ⇒ 它被挪到第一位
 * - 锁定永久（`allowPermanent: false`）
 *
 * | 实现 | 结果 |
 * |---|---|
 * | 判据用 `opts`（带 floor）| `low` 被降档 ⇒ `none` ⇒ **报无可用** ✅ |
 * | 判据用 `options`（不带）| `low` 算 expiring ⇒ 「可用」⇒ **选中它并烧掉其短期** 🚨 |
 */
import { describe, expect, it } from 'vitest'

import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 27, 0, 0, 0)

/**
 * 造余额。
 *
 * ⚠️⚠️ **`short` 的到期时刻必须在「短期桶」而非「临期桶」**：
 *
 * `splitBuddyCreditsByExpiry` 的桶边界（`imminentDays: 5` / `windowDays: 15`）：
 *
 * | 距过期 | 落哪个桶 |
 * |---|---|
 * | < 5 天 | **临期**（`imminent`，⊂ expiring）|
 * | 5 ~ 15 天 | 短期（`expiring`）|
 * | > 15 天 | 永久（`permanent`）|
 *
 * ⇒ 用 **8 天**才落短期桶。我第一版用 `2 天` ⇒ 落**临期**桶 ⇒
 *   `expiringFloor` 对它**不起作用**（临期判据看的是 `imminentFloor`）
 *   ⇒ 用例「没拦住」其实是**构造错了**，不是代码缺陷。
 */
function pkgs(short: number, permanent: number) {
  return {
    total: short + permanent,
    packages: [
      ...(short > 0
        ? [{ name: 'S', unit: 'credit', remaining: short, total: short, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 8 * DAY }]
        : []),
      ...(permanent > 0
        ? [{ name: 'P', unit: 'credit', remaining: permanent, total: permanent, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 400 * DAY }]
        : []),
    ],
    expiredTotal: 0,
  }
}

function makeSelector() {
  return new BuddyBalanceSelector({
    product: { id: 'probe' } as never,
    resolveCredential: async () => ({}) as never,
    now: () => NOW,
    /** ⚠️ 第一参是 credential，账号 id 在**第三参** `ctx.accountId`。 */
    fetchBalance: async (_c, _p, ctx) => {
      /** `low` 只有 25 短期；`healthy` 有 500 短期。 */
      return (ctx?.accountId === 'low' ? pkgs(25, 800) : pkgs(500, 0)) as never
    },
    readCreditWindow: () => ({ windowDays: 15, imminentDays: 5, expiringFloor: 30 }) as never,
  } as never)
}

const CANDIDATES = [
  { id: 'low', credentialRef: 'R-low', enabled: true },
  { id: 'healthy', credentialRef: 'R-healthy', enabled: true },
] as never

describe('★★★ M6：起点把降档号挪回首位时，锁定判据仍须认得它', () => {
  it('★★★ 锁定 + 起点=low + 短期阈值 30 ⇒ **不得选 low**（它已被降档）', async () => {
    const selector = makeSelector()
    const result = await selector.select(CANDIDATES, {
      allowPermanent: false,
      /** ★ 起点指定会被降档的那个号。 */
      rotationStartId: 'low',
    } as never)
    const picked = result.ok ? result.account.id : undefined
    console.log('  [锁定+起点low] ok=' + result.ok + ' 选中=' + String(picked)
      + (result.ok ? '' : ' reason=' + JSON.stringify(result.reason)))

    /**
     * ⚠️ **判据**：`low` 短期 25 ≤ 阈值 30 ⇒ 降档到 permanent ⇒ 锁定态不可用。
     * 起点把它挪到第一位，但**不该因此变得可用**。
     *
     * ⇒ 要么选 `healthy`，要么报无可用 —— **但绝不能选 `low`**。
     */
    expect(
      picked,
      '★★★ 起点把 low 挪到首位，但锁定态下它已被降档 ⇒ **绝不能选它**'
        + '（选中 = 会烧掉它那 25 点短期，正是审计 D3 的伤害）',
    ).not.toBe('low')
  })

  it('★★ 反向对照：不锁定时起点=low ⇒ 降级**不是不可用**，起点仍能把 low 拉到首位', async () => {
    /**
     * ⚠️ 我第一版这条写错了（断言「选 low」），实际选的是 `healthy`。
     *
     * ## 为什么 `healthy` 胜出是正确的
     *
     * 排序在**起点之前**：`healthy` 在 `expiring` 档（0/1），
     * `low` 被降档到 `permanent`（2）⇒ 排序把 `healthy` 排第一。
     *
     * 而 `rotateFromPreferred` 的语义是「**在该档内**旋转起点」——
     * `low` 已不在第一档，故起点无法把它拉到最前。
     *
     * ## 那这条守什么
     *
     * 守的是**「降级 ≠ 不可用」**：`low` 不锁定时必须**仍可被选中**
     *（若 someday 有人把降级实现成「过滤掉」而不是「改顺序」，这里会红）。
     * ⇒ 判据从「选了 low」改成「low 仍在候选里」。
     */
    const selector = makeSelector()

    /** ① 不锁定时，起点若指向 healthy 则应选它（起点可用）。 */
    const withHealthy = await selector.select(CANDIDATES, { rotationStartId: 'healthy' } as never)
    expect(
      withHealthy.ok ? withHealthy.account.id : undefined,
      '★ 起点 healthy ⇒ 选它',
    ).toBe('healthy')

    /** ② 关键：**`low` 不得从候选里消失**（降级只改顺序，不淘汰）。 */
    const lockedResult = await selector.select(CANDIDATES, {
      allowPermanent: false,
      rotationStartId: 'low',
    } as never)
    console.log('  [锁定+起点low] 选中=' + (lockedResult.ok ? lockedResult.account.id : 'none'))
    expect(
      lockedResult.ok ? lockedResult.account.id : undefined,
      '★★ 锁定态下 low 已被降档 ⇒ 不得选它',
    ).not.toBe('low')
  })
})
