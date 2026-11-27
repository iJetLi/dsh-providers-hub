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
  it('★★★ 只配 `imminentFloor` ⇒ 「临期 5」仍算可用（降到短期档，实测口径）', () => {
    /**
     * ⚠️⚠️ **这条与我最初的直觉相反**，但**实测后端就是这个行为**：
     *
     * | 阈值 | 后端 `buddyBalanceTier` | 本函数 |
     * |---|---|---|
     * | 不配 | `imminent(0)` | 5 |
     * | `imminentFloor: 20` | **`expiring(1)`** | **5（仍可用）** |
     * | `imminentFloor: 20` + `expiringFloor: 20` | `permanent(2)` | **0** |
     *
     * ⇒ 原因：`imminentFloor` 只挡「临期档」；短期档判据是
     *   `expiring > expiringFloor`，而 `expiring = 5 > 0` 仍成立。
     *   **要让它真的不可用，必须两个阈值都配**（或锁定永久后它自然落 none）。
     *
     * ⚠️ 我第一版直接期望 0 —— 那是**没实测**的猜测，与后端分叉。
     */
    const packages = [pkg(5, 2), pkg(800, 400)]
    expect(
      expiringUsableOf(packages, W, NOW),
      '★ 不配阈值 ⇒ 5',
    ).toBe(5)
    expect(
      expiringUsableOf(packages, { ...W, imminentFloor: 20 }, NOW),
      '★★ 只配 imminentFloor ⇒ 降到短期档 ⇒ 仍可用（5）',
    ).toBe(5)
    expect(
      expiringUsableOf(packages, { ...W, imminentFloor: 20, expiringFloor: 20 }, NOW),
      '★★★ 两个阈值都配 ⇒ 真的不可用（0）',
    ).toBe(0)
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
  it('★★★ 阈值 20 时「临期 5」的号 ⇒ 降档到 **`expiring`**（实测后端口径）', () => {
    /**
     * 这个值决定提示文案。说错档位比不说更糟 —— 用户会以为自己选对了。
     *
     * ⚠️⚠️ **输入「临期 5 / 永久 800」时的真值（实测 `lib/buddy-balance-rank.js`）**：
     *
     * | 阈值 | 后端结果 |
     * |---|---|
     * | 不配 | `imminent(0)` |
     * | `imminentFloor: 20` | **`expiring(1)`** ← 降到短期档（不是 permanent！）|
     * | `imminentFloor: 20` + `expiringFloor: 20` | `permanent(2)` |
     *
     * ⇒ 原因：`imminentFloor` 只挡住「临期档」，短期档判据是
     *   `expiring > expiringFloor`，而这里 `expiring = imminent = 5 > 0`
     *   ⇒ **仍落短期档**。要再降一档必须同时配 `expiringFloor`。
     *
     * ⚠️ 我第一版期望 `permanent` —— 那是**没实测**的猜测。
     */
    const packages = [pkg(5, 2), pkg(800, 400)]
    expect(
      startTierOf(packages, W, true, NOW),
      '★ 不配阈值 ⇒ imminent',
    ).toBe(CREDIT_ORDER_TIER.imminent)
    expect(
      startTierOf(packages, { ...W, imminentFloor: 20 }, true, NOW),
      '★★★ imminentFloor 20 ⇒ 降到 **expiring**（与后端实测同值）',
    ).toBe(CREDIT_ORDER_TIER.expiring)
    expect(
      startTierOf(packages, { ...W, imminentFloor: 20, expiringFloor: 20 }, true, NOW),
      '★★★ 两个阈值都配 ⇒ 再降一档到 permanent',
    ).toBe(CREDIT_ORDER_TIER.permanent)
  })

  it('★★★ 锁定永久 + 两个阈值都配 ⇒ `none`（提示「不可用」）', () => {
    /**
     * ⚠️ **必须同时配两个阈值**：只配 `imminentFloor` 时该号落到短期档，
     * 而「锁定永久」允许烧短期 ⇒ 仍可用（`expiring`）。
     *
     * 实测后端：
     * - `imminentFloor: 20` + 锁定 ⇒ `expiring`（可用）
     * - `imminentFloor: 20` + `expiringFloor: 20` + 锁定 ⇒ **`none`**
     */
    const packages = [pkg(5, 2)]
    expect(
      startTierOf(packages, { ...W, imminentFloor: 20 }, false, NOW),
      '★ 只配临期阈值 ⇒ 落到短期档 ⇒ 锁定态仍可用',
    ).toBe(CREDIT_ORDER_TIER.expiring)
    expect(
      startTierOf(packages, { ...W, imminentFloor: 20, expiringFloor: 20 }, false, NOW),
      '★★★ 两个阈值都配 + 锁定 ⇒ none（不去烧永久）',
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
