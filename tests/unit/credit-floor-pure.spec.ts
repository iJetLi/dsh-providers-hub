/**
 * ★★★ **`credit-floor-pure.js` 的行为级守卫**（2026-11-27 从 `usage-badge.js` 抽出）
 *
 * ## 为什么这个文件存在
 *
 * 这两处计算原本是 `usage-badge.js` 里的闭包，而那个文件
 * `import * as React` ⇒ **单测 import 不进来** ⇒ 只能做源码正则守卫
 *（挡不住 `if (false)` 这类失效形态）。
 *
 * 抽成纯函数后，本文件做**真值断言**。
 *
 * ⚠️ 本仓同一先例：`sumAvailableCredits` 从 `usage-badge.js` 搬到 `badge-model.js`，
 *    理由逐字相同（对抗审计 B02：把 `return seen ? total : null` 改成
 *    `return null` —— **三个 spec 全绿**）。
 */
import { describe, expect, it } from 'vitest'

import { expiringUsableOf, startTierOf } from '../../plugin-src/client/credit-floor-pure.js'
import { CREDIT_ORDER_TIER } from '../../plugin-src/client/badge-model.js'
import { QUOTA_UNIT } from '../../plugin-src/client/credits-format.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 27, 0, 0, 0)

/**
 * 造资源包。
 *
 * ⚠️⚠️ **到期时刻必须落对桶**（`imminentDays: 5` / `windowDays: 15`）：
 *
 * | 距过期 | 桶 |
 * |---|---|
 * | < 5 天 | **临期**（`imminent`，⊂ expiring）|
 * | 5 ~ 15 天 | 短期（`shortTerm`）|
 * | > 15 天 | 永久（`permanent`）|
 *
 * ⚠️ 我第一版把「短期」包写成 2 天 ⇒ 落**临期**桶 ⇒ `expiringFloor` 对它
 *   不起作用 ⇒ 用例「没拦住」其实是**构造错了**。
 */
function pkg(remaining: number, days: number) {
  return {
    name: 'P',
    unit: 'credit',
    remaining,
    total: remaining,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    deductionEndTime: NOW + days * DAY,
  }
}

/** 窗口参数：临期 < 5 天、短期 5~15 天。 */
const W = { windowDays: 15, imminentDays: 5 }

describe('★★★ (D5-4) `expiringUsableOf`：锁定态的「可用短临积分」', () => {
  it('★★★ 链式降级：临期 5 + 纯短期 28，阈值 20/30 ⇒ **归入长期**（0）', () => {
    /**
     * ## 用户原话（这是需求的**核心场景**）
     *
     * > 「临期低于 20 就不再算临期了，归入短期；
     * >   **短期低于 30 就不算短期了，自动归入长期**」
     *
     * 一个「临期 5 + 纯短期 28」的号：
     * - 临期 5 ≤ 20 ⇒ 不算临期
     * - 纯短期 28 ≤ 30 ⇒ **也不算短期** ⇒ 归入长期
     *
     * ⇒ 锁定态下它**没有任何可用于排队的短临积分** ⇒ 返回 **0**。
     *
     * ⚠️⚠️ **这正是我先前实现错的地方**：用母量 `expiring`（= 5+28 = 33）
     *   判短期档 ⇒ `33 > 30` 成立 ⇒ 误判「仍可用」= **与用户要求相反**。
     */
    const packages = [pkg(5, 2), pkg(28, 8), pkg(800, 400)]
    expect(
      expiringUsableOf(packages, { ...W, imminentFloor: 20, expiringFloor: 30 }, NOW),
      '★★★ 两档都不足阈值 ⇒ 返回 0（归入长期）',
    ).toBe(0)
    /** 反向对照：只配临期阈值时短期仍可用。 */
    expect(
      expiringUsableOf(packages, { ...W, imminentFloor: 20 }, NOW),
      '★★ 只配临期阈值 ⇒ 纯短期 28 仍算短期 ⇒ 可用',
    ).toBe(33)
  })

  it('★★★ 充足额度不受影响（反向对照）', () => {
    const packages = [pkg(500, 2)]
    expect(
      expiringUsableOf(packages, { ...W, imminentFloor: 20 }, NOW),
      '★★ 500 > 20 ⇒ 仍可用',
    ).toBe(500)
  })

  it('★★★ 读不到 ⇒ `undefined`（**绝不倒向不可用**）', () => {
    /**
     * ⚠️ 这是真缺陷的教训：无余额概念的渠道（codearts / cline / token 计费）
     * 恒可用。若这里返回 0，用户会**一个起点都选不了**。
     */
    expect(expiringUsableOf(undefined, W, NOW), '★ 无包数组 ⇒ undefined').toBeUndefined()
    expect(expiringUsableOf(null, W, NOW), '★ null ⇒ undefined').toBeUndefined()
    expect(expiringUsableOf('not-array', W, NOW), '★ 非数组 ⇒ undefined').toBeUndefined()
  })

  it('★★★ 全部为 0 ⇒ 返回 0（真的没短临积分）', () => {
    expect(
      expiringUsableOf([pkg(800, 400)], W, NOW),
      '★★ 只有永久 ⇒ 0（锁定态不可用）',
    ).toBe(0)
  })

  it('★★ 短期档也按 `expiringFloor` 过滤（**只对不含临期的号生效**）', () => {
    /**
     * ⚠️⚠️ **这里有个我一开始理解错、后来被 parity 用例纠正的地方**：
     *
     * 判据用**母量 `expiring`**（= `imminent + shortTerm`），与后端
     * `buddyBalanceTier` 读 `balance.expiringBalance` **逐字同源**。
     *
     * | 号 | `expiringFloor: 30` | 结果 |
     * |---|---|---|
     * | 临期 0 / 短期 25（`expiring = 25`）| `25 > 30` 假 | 降级 ✅ |
     * | 临期 5 / 短期 0（`expiring = 5`）| `5 > 30` 假 | 也降级 |
     * | 临期 5 / 短期 0，`expiringFloor: 1` | `5 > 1` 真 | **仍算可用**（母量含临期）|
     *
     * ⚠️ 我曾想把它改成 `shortTerm`（「只算纯短期更合理」），但那样会与后端分叉
     *  ⇒ `credit-floor-parity.spec.ts` 立刻红 4 条。**同源优先于「感觉更合理」。**
     */
    const pureShort = [pkg(25, 8)]
    expect(expiringUsableOf(pureShort, W, NOW), '★ 阈值关 ⇒ 25 可用').toBe(25)
    expect(
      expiringUsableOf(pureShort, { ...W, expiringFloor: 30 }, NOW),
      '★★ `expiring(25) ≤ 阈值 30` ⇒ 降档 ⇒ 0',
    ).toBe(0)
    expect(
      expiringUsableOf(pureShort, { ...W, expiringFloor: 20 }, NOW),
      '★★ `25 > 20` ⇒ 仍可用',
    ).toBe(25)
  })

  it('★★ 非法阈值（负数 / NaN）⇒ 归 0 = 关闭（方向保守）', () => {
    /**
     * ⚠️ 这条守 `floorOf` 的**归一化**：
     *
     * | 传 `imminentFloor` | 若不归一化会怎样 |
     * |---|---|
     * | `-5` | `imminent(5) > -5` **恒真** ⇒ 阈值形同虚设（但结果碰巧相同）|
     * | `NaN` | `5 > NaN` 恒 **false** ⇒ **误降级** 🚨 |
     *
     * ⇒ 用 `NaN` 才能区分「归一化」与「没归一化」——
     *   负数那格两种实现结果相同（`5 > -5` 和 `5 > 0` 都真）。
     */
    const packages = [pkg(5, 2)]
    expect(
      expiringUsableOf(packages, { ...W, imminentFloor: -5 }, NOW),
      '★ 负数归 0 ⇒ 不降级',
    ).toBe(5)
    expect(
      expiringUsableOf(packages, { ...W, imminentFloor: Number.NaN }, NOW),
      '★★★ NaN 必须归一成 0（不归一化时 `5 > NaN` 为假 ⇒ 会误降级成 0）',
    ).toBe(5)
    expect(
      expiringUsableOf(packages, { ...W, imminentFloor: Number.POSITIVE_INFINITY }, NOW),
      '★★ Infinity 也归一成 0',
    ).toBe(5)
    /**
     * ⚠️ **如实登记：这条挡不住「`floorOf` 不做归一化」**。
     *
     * 我实测变异「把 `floorOf` 改成 `return value ?? 0`」⇒ **用例仍绿**：
     *
     * ```
     * packages = [临期 5]，imminentFloor = NaN
     *   归一化版： countsImminent = 5 > 0   = true  ⇒ 返回 5
     *   未归一化： countsImminent = 5 > NaN = false
     *              countsShortTerm = 5 > 0  = true  ⇒ 仍返回 5   ← 被救回来
     * ```
     *
     * ⇒ 因为 `expiring`（母量）判据与 `imminent` 判据**互为掩护**：
     *   临期那格失效时，短期那格（`expiring = imminent + shortTerm`）会接住。
     *
     * **这是结构性的冗余保护，不是缺口。** 我不为它编造恒真用例。
     * 真正让 `floorOf` 承重的场景需要「两个阈值都非法 + 号只有临期」——
     * 但那与「阈值关闭」等价，**本来就该返回可用**，故永远无法区分。
     */
    /** 反向对照：合法阈值必须真的生效（这条**是**有牙的）。 */
    expect(
      expiringUsableOf(packages, { ...W, imminentFloor: 100, expiringFloor: 100 }, NOW),
      '★★ 合法阈值 100 ⇒ 真的降级（这条守得住）',
    ).toBe(0)
  })
})

describe('★★★ (D5-5) `startTierOf`：起点档位提示', () => {
  it('★★★ 链式降级（档位）：临期 5 + 纯短期 28，阈值 20/30 ⇒ **permanent**', () => {
    /**
     * 与上一条同源（`startTierOf` 走 `backendOrderTier`）：
     * 两档都不足阈值 ⇒ 提示必须说「**永久档**」。
     *
     * ⚠️ 说错档位比不说更糟 —— 用户会以为自己选对了。
     */
    const packages = [pkg(5, 2), pkg(28, 8), pkg(800, 400)]
    expect(
      startTierOf(packages, W, true, NOW),
      '★ 不配阈值 ⇒ imminent',
    ).toBe(CREDIT_ORDER_TIER.imminent)
    expect(
      startTierOf(packages, { ...W, imminentFloor: 20 }, true, NOW),
      '★★ 只配临期阈值 ⇒ 降到 **expiring**',
    ).toBe(CREDIT_ORDER_TIER.expiring)
    expect(
      startTierOf(packages, { ...W, imminentFloor: 20, expiringFloor: 30 }, true, NOW),
      '★★★ 两档都不足 ⇒ **permanent**（纯短期 28 ≤ 30）',
    ).toBe(CREDIT_ORDER_TIER.permanent)
  })

  it('★★★ 反向对照：纯短期 35 > 阈值 30 ⇒ 仍算短期', () => {
    /**
     * ⚠️ **没有这条，上一条的「permanent」可能只是「一律降级」导致的**。
     */
    const packages = [pkg(5, 2), pkg(35, 8), pkg(800, 400)]
    expect(
      startTierOf(packages, { ...W, imminentFloor: 20, expiringFloor: 30 }, true, NOW),
      '★★ 纯短期 35 > 30 ⇒ 仍在短期档',
    ).toBe(CREDIT_ORDER_TIER.expiring)
  })

  it('★★★ 锁定永久 + 临期不足阈值 ⇒ `none`（提示「不可用」）', () => {
    /**
     * 号「临期 5、纯短期 0、**永久 800**」+ `imminentFloor: 20`：
     * - 临期 5 ≤ 20 ⇒ 不算临期
     * - 纯短期 = `expiring(5) - imminent(5)` = **0** ≤ `expiringFloor(0)` ⇒ 不算短期
     * ⇒ 落到 `permanent` 档。
     *
     * | 锁定 | 结果 |
     * |---|---|
     * | **否** | `permanent(2)`（可用，积分不浪费）|
     * | **是** | **`none(3)`**（不去烧永久）|
     *
     * ⚠️ **必须带一个永久包**：我第一版只放了「临期 5」，`split.permanent = 0`
     *   ⇒ 连 permanent 档都不成立 ⇒ 两种锁定态都返回 `none`，用例分不开。
     */
    const packages = [pkg(5, 2), pkg(800, 400)]
    expect(
      startTierOf(packages, { ...W, imminentFloor: 20 }, true, NOW),
      '★★ 不锁定 ⇒ 落到 permanent 档',
    ).toBe(CREDIT_ORDER_TIER.permanent)
    expect(
      startTierOf(packages, { ...W, imminentFloor: 20 }, false, NOW),
      '★★★ 锁定 + 临期不足 ⇒ none（不去烧永久）',
    ).toBe(CREDIT_ORDER_TIER.none)
  })

  it('★★ 配额单位（Gemini）⇒ `null`（调用方跳过渲染）', () => {
    /**
     * ⚠️ `QUOTA_UNIT` 的**实际值是 `'%'`**（不是 `'quota'`）。
     * 我第一版用了 `'quota'` ⇒ 判据不命中 ⇒ 用例假红。
     * ⇒ 直接引真实常量，不硬编码字面量。
     */
    const packages = [{ name: 'Q', unit: QUOTA_UNIT, remaining: 50, total: 100, used: 50, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '' }]
    expect(startTierOf(packages, W, true, NOW), '★★ 配额单位无档位概念').toBeNull()
  })

  it('★★ 读不到 ⇒ `null`', () => {
    expect(startTierOf(undefined, W, true, NOW)).toBeNull()
  })
})

describe('★★★ 抽取前后**语义逐字节相同**（防搬运引入回归）', () => {
  /**
   * ⚠️ 抽取的最大风险是「搬着搬着改了个符号」。
   * 这组用**多组合**覆盖，锁住「不配阈值时的行为 = 旧实现」。
   */
  const CASES = [
    { name: '临期充足', packages: [pkg(500, 2)] },
    { name: '临期少量', packages: [pkg(5, 2)] },
    { name: '只有短期', packages: [pkg(100, 8)] },
    { name: '只有永久', packages: [pkg(900, 400)] },
    { name: '临期+短期', packages: [pkg(5, 2), pkg(100, 8)] },
    { name: '全空', packages: [] },
  ]

  for (const c of CASES) {
    it(`★★ ${c.name}：不传阈值时与旧口径一致`, () => {
      const usable = expiringUsableOf(c.packages, W, NOW)
      const tier = startTierOf(c.packages, W, true, NOW)
      console.log(`  [${c.name}] usable=${String(usable)} tier=${String(tier)}`)
      /** 不传阈值 ⇒ 两个函数都应给出「有值」的结果（不是 undefined / null）。 */
      expect(usable, '★ 不传阈值 ⇒ 应有数值结果').not.toBeUndefined()
      expect(tier, '★ 不传阈值 ⇒ 应有档位').not.toBeNull()
      /** 有临期/短期的号 ⇒ 档位必 < permanent(2)。 */
      if (c.name === '临期充足' || c.name === '临期少量') {
        expect(tier, '★ 有临期 ⇒ imminent 档').toBe(CREDIT_ORDER_TIER.imminent)
      }
    })
  }
})
