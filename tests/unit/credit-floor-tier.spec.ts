/**
 * ★★★ **积分阈值的档位降级**（2026-11-27 用户需求）
 *
 * ## 用户原话
 *
 * > 「临期积分低于 20 就不再算临期了，归入短期；短期低于 30 就不算短期了，
 * >   自动归入长期…… 我想加上这个功能，让一个帐号**提前切换**，
 * >   防止它的**短期积分被使用**。」
 *
 * ## 问题本质
 *
 * ```
 * 改动前：临期 > 0 就算临期档
 *   ⇒ 一个号只剩 1 点临期，仍是「临期号」
 *   ⇒ 系统把它临期烧光 + **部分短期**才切走 ⇒ 那个号的短期被污染
 *
 * 改动后：临期 ≤ 20 ⇒ 按「短期」排队（提前切走）
 * ```
 *
 * ## 本文件守什么
 *
 * 1. **`> floor` 不是 `>= floor`**（阈值 0 时必须与改动前逐字节相同）
 * 2. **降级不浪费**（只改排队顺序，剩余积分照样能烧）
 * 3. **锁定永久时降级到 `none`**（不去烧永久）
 * 4. **客户端与后端同源**（`backendOrderTier` ↔ `buddyBalanceTier`）
 */
import { describe, expect, it } from 'vitest'

import { BUDDY_BALANCE_TIER, buddyBalanceTier } from '../../src/buddy-balance-rank.js'

const TIER = BUDDY_BALANCE_TIER

/** 造一份余额（只需三个桶）。 */
function bal(imminent: number, expiring: number, permanent: number) {
  return {
    imminentBalance: imminent,
    expiringBalance: expiring,
    permanentBalance: permanent,
  }
}

describe('★★★ 积分阈值：档位降级', () => {
  it('★★★ 临期剩余 ≤ 阈值 ⇒ 降级到「短期」（用户的核心场景）', () => {
    /**
     * 用户原话场景：临期只剩 1~2 点，但仍被当成「临期号」⇒ 会连带烧短期。
     *
     * 池里：临期 2 / 短期 500 / 永久 1000
     * - 阈值关闭（0）⇒ **临期**（改动前行为，保持）
     * - 阈值 20    ⇒ **短期**（提前切走，保住短期不被同一个号吃掉）
     */
    const b = bal(2, 500, 1000)
    expect(buddyBalanceTier(b, {}), '★ 阈值关闭 ⇒ 临期（零回归）').toBe(TIER.imminent)
    expect(
      buddyBalanceTier(b, { imminentFloor: 20 }),
      '★★★ 临期 2 ≤ 阈值 20 ⇒ 必须降级到短期',
    ).toBe(TIER.expiring)
  })

  it('★★★ 短期剩余 ≤ 阈值 ⇒ 降级到「永久」', () => {
    const b = bal(0, 25, 1000)
    expect(buddyBalanceTier(b, {}), '★ 阈值关闭 ⇒ 短期（零回归）').toBe(TIER.expiring)
    expect(
      buddyBalanceTier(b, { expiringFloor: 30 }),
      '★★★ 短期 25 ≤ 阈值 30 ⇒ 必须降级到永久',
    ).toBe(TIER.permanent)
  })

  it('★★★ 两个阈值可以叠加（临期低 + 短期低 ⇒ 永久）', () => {
    const b = bal(5, 10, 1000)
    expect(
      buddyBalanceTier(b, { imminentFloor: 20, expiringFloor: 30 }),
      '★★★ 临期 5 ≤ 20 且短期 10 ≤ 30 ⇒ 一路降到永久',
    ).toBe(TIER.permanent)
  })

  it('★★★ `>` 不是 `>=`：剩余**恰好等于**阈值 ⇒ 降级（不算该档）', () => {
    /**
     * ⚠️ 这是最容易写错的一格。用户说「低于 20 就不算临期」，
     * 但实现用 `> floor` ⇒ **恰好 20 也不算**（20 > 20 为假）。
     *
     * 判据与「阈值 0 时 > 0」**同一套**：若这里改成 `>=`，
     * 那么 floor=0 时 `0 >= 0` 会成立 ⇒ 剩余 0 也算临期 ⇒ **与改动前分叉**。
     * ⇒ 为了保住零回归，边界只能是「恰好等于也算降级」。
     */
    expect(
      buddyBalanceTier(bal(20, 500, 1000), { imminentFloor: 20 }),
      '★★★ 剩余恰好 20 == 阈值 20 ⇒ 必须降级（> 而非 >=）',
    ).toBe(TIER.expiring)
    /** 反向对照：多 1 点就算临期了。 */
    expect(
      buddyBalanceTier(bal(21, 500, 1000), { imminentFloor: 20 }),
      '★★ 剩余 21 > 阈值 20 ⇒ 仍算临期',
    ).toBe(TIER.imminent)
  })

  it('★★★ 零回归：阈值 0 / undefined / 负数 ⇒ 与改动前**逐字节相同**', () => {
    /**
     * 这是本功能**唯一的回归面**：不配阈值时必须完全等于旧行为。
     */
    const cases = [
      bal(1, 0, 0),
      bal(0, 1, 0),
      bal(0, 0, 1),
      bal(0, 0, 0),
      bal(5, 5, 5),
    ]
    for (const b of cases) {
      const baseline = buddyBalanceTier(b, {})
      expect(buddyBalanceTier(b, { imminentFloor: 0, expiringFloor: 0 }), '★ 全 0 ⇒ 同旧行为').toBe(baseline)
      expect(
        buddyBalanceTier(b, { imminentFloor: undefined, expiringFloor: undefined }),
        '★ undefined ⇒ 同旧行为',
      ).toBe(baseline)
      /**
       * ⚠️ 负数：`positiveOrZero` 归一成 0 ⇒ 同样等于关闭。
       * 这条防「有人把 floor 直接比较而不归一化」——
       * 那样 `remaining > -5` 恒真 ⇒ 阈值形同虚设。
       */
      expect(buddyBalanceTier(b, { imminentFloor: -5 }), '★ 负数 ⇒ 归一成 0 ⇒ 同旧行为').toBe(baseline)
    }
  })

  it('★★★ 锁定永久时降级到 `none`，**不去烧永久**', () => {
    /**
     * 用户第 2 条定案：降级 ≠ 不可用。但**锁定永久**是另一回事 ——
     * 用户显式说「不许烧永久」⇒ 降级链走到底就是 `none`。
     *
     * | 配置 | 期 | 短期 | 永久 | 结果 |
     * |---|---|---|---|---|
     * | 锁定 + 临期低 | 5 | 500 | 1000 | **短期**（还能烧短期）|
     * | 锁定 + 临期低 + 短期低 | 5 | 10 | 1000 | **none**（不许烧永久）|
     */
    expect(
      buddyBalanceTier(bal(5, 500, 1000), { allowPermanent: false, imminentFloor: 20 }),
      '★★ 锁定时临期低 ⇒ 仍可用短期',
    ).toBe(TIER.expiring)
    expect(
      buddyBalanceTier(bal(5, 10, 1000), { allowPermanent: false, imminentFloor: 20, expiringFloor: 30 }),
      '★★★ 锁定时两档都低 ⇒ none（**绝不去烧永久**）',
    ).toBe(TIER.none)
  })

  it('★★★ 降级不浪费：剩余积分仍在余额里（只改排队顺序）', () => {
    /**
     * 用户第 6 条定案：「降级只改**排队顺序**，不改**烧包顺序**」。
     *
     * ⚠️ 这条守的是 `buddyBalanceTier` **不得改写入参** ——
     * 它只返回档位，余额原封不动。若哪天有人「顺手把不足阈值的额度清零」
     * 来实现降级，用户的积分会被**真的抹掉**。
     */
    const b = bal(2, 500, 1000)
    const before = { ...b }
    buddyBalanceTier(b, { imminentFloor: 20 })
    expect(b, '★★★ 判档不得修改余额（降级 ≠ 消灭积分）').toEqual(before)
    expect(b.imminentBalance, '★★ 那 2 点临期还在').toBe(2)
  })
})
