/**
 * ★★★ **后端「链式降级」的守卫**（2026-11-27，PR #181 补）。
 *
 * ## 为什么单独建这个文件
 *
 * PR #181 修了「短期档判母量」的真缺陷（`pureShortTerm = Math.max(0, expiring - imminent)`），
 * 但**原有的 7 个 `credit-floor-*` spec 一个都不守后端** —— 实测：
 *
 * > 把 `src/buddy-balance-rank.ts` 的 `pureShortTerm` 改回**母量 `expiring`**（= 原 bug）
 * > ⇒ **全量 15546 passed / 全绿**（唯一的 1 failed 是缺 `lib/` 的环境项，与变异无关）
 *
 * ⇒ 这与 #179 那个「504 行测试全在纯函数层」是**同型**：判据存在，但没有守卫盯着它。
 *
 * ## 用户在意的那个号
 *
 * > 「临期 5 + 纯短期 28」、阈值 20/30 ⇒ 用户要求「28 < 30 ⇒ 归入**长期**」
 * > ⇒ 目的不是「档位显示对」，是**那个号的短期不被烧掉**。
 *
 * 母量是 33（> 30）⇒ 用母量判会**仍算短期** ⇒ 用户的要求反着执行。
 */
import { describe, expect, it } from 'vitest'
import { buddyBalanceTier, BUDDY_BALANCE_TIER as TIER } from '../../src/buddy-balance-rank.js'

function bal(imminent: number, expiring: number, permanent: number) {
  return { imminentBalance: imminent, expiringBalance: expiring, permanentBalance: permanent }
}

describe('★★★ 后端链式降级：短期档必须判「纯短期」而不是母量', () => {
  it('★★★ 核心场景：临期 5 + 纯短期 28 + 阈值 20/30 ⇒ permanent（母量 33 不得骗过判据）', () => {
    /**
     * 母量 `expiring` = 5 + 28 = **33** > 30 ⇒ 用母量判会得「短期」（错）。
     * 纯短期 = 33 - 5 = **28** ≤ 30 ⇒ 正确结果是「长期」。
     */
    const tier = buddyBalanceTier(bal(5, 33, 800), { imminentFloor: 20, expiringFloor: 30 })
    expect(tier, '★ 母量 33 骗不过「纯短期 28 ≤ 30」这个判据').toBe(TIER.permanent)
  })

  it('★★★ 纯短期恰好 == 阈值 ⇒ 也降级（`> floor` 语义，不是 `>=`）', () => {
    // 纯短期 30，阈值 30 ⇒ 30 > 30 为假 ⇒ 降级
    expect(buddyBalanceTier(bal(0, 30, 800), { expiringFloor: 30 })).toBe(TIER.permanent)
    // 纯短期 31 ⇒ 不降级
    expect(buddyBalanceTier(bal(0, 31, 800), { expiringFloor: 30 })).toBe(TIER.expiring)
  })

  it('★★ 纯短期够 ⇒ 仍算短期（反向对照，防止「一律永久」）', () => {
    // 临期 5 + 纯短期 100 ⇒ 纯短期 100 > 30 ⇒ 短期
    expect(buddyBalanceTier(bal(5, 105, 0), { imminentFloor: 20, expiringFloor: 30 })).toBe(TIER.expiring)
  })

  it('★★ 阈值关闭（缺键/0）⇒ 与改动前逐字节相同（零回归）', () => {
    const b = bal(5, 33, 800)
    expect(buddyBalanceTier(b, {}), '缺键 ⇒ 关').toBe(buddyBalanceTier(b, { imminentFloor: 0, expiringFloor: 0 }))
    // ⚠️ 阈值关时 `imminent=5 > 0` ⇒ 就是**临期**档（母量根本不参与这一格的判定）
    expect(buddyBalanceTier(b, {}), '阈值关时临期 5 仍是临期档').toBe(TIER.imminent)
  })
})
