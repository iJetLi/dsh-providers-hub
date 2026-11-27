/**
 * ★★★ **积分阈值：客户端与后端必须同源**（本仓红线：同一语义不得两套）
 *
 * ## 为什么必须有这个文件
 *
 * 档位判据存在**两份实现**（客观事实，不是设计缺陷 —— 客户端算不了服务端余额）：
 *
 * | 位置 | 函数 | 用途 |
 * |---|---|---|
 * | `src/buddy-balance-rank.ts` | `buddyBalanceTier` | 后端选号 |
 * | `plugin-src/client/badge-model.js` | `backendOrderTier` | 面板显示档位 / `tierAtSelectionOf` |
 *
 * ⇒ **两边必须同判**。不同步的后果正是历史上「界面说临期、实际烧永久」的形态。
 *
 * ## 本文件怎么做
 *
 * 用**同一批输入**分别喂两个函数，断言档位一致。
 * ⚠️ 这不是「重复测试」—— 它守的正是「两份实现不许漂移」这条不变式。
 */
import { describe, expect, it } from 'vitest'

import { BUDDY_BALANCE_TIER, buddyBalanceTier } from '../../src/buddy-balance-rank.js'
import { CREDIT_ORDER_TIER, backendOrderTier } from '../../plugin-src/client/badge-model.js'

/**
 * ⚠️ 两个模块的档位常量是**各自定义**的（后端 `BUDDY_BALANCE_TIER`、
 * 客户端 `CREDIT_ORDER_TIER`），故必须建立映射再比 ——
 * 直接 `toBe` 比较会因对象身份不同而**假红**。
 */
function backendToClient(tier: number): number {
  if (tier === BUDDY_BALANCE_TIER.imminent) return CREDIT_ORDER_TIER.imminent
  if (tier === BUDDY_BALANCE_TIER.expiring) return CREDIT_ORDER_TIER.expiring
  if (tier === BUDDY_BALANCE_TIER.permanent) return CREDIT_ORDER_TIER.permanent
  return CREDIT_ORDER_TIER.none
}

/** 后端形状（三个桶）→ 客户端形状（`split`，含 `longTerm`）。 */
function toSplit(b: { imminent: number, expiring: number, permanent: number }) {
  return {
    imminent: b.imminent,
    expiring: b.expiring,
    expiring_母量: b.expiring,
    permanent: b.permanent,
    longTerm: 0,
    expired: 0,
  }
}

describe('★★★ 积分阈值：客户端与后端同源', () => {
  /** 覆盖用户描述的所有场景 + 边界。 */
  const CASES: Array<{
    name: string
    bal: { imminent: number, expiring: number, permanent: number }
    floors: { imminentFloor?: number, expiringFloor?: number }
  }> = [
    { name: '全为零', bal: { imminent: 0, expiring: 0, permanent: 0 }, floors: {} },
    { name: '只有永久', bal: { imminent: 0, expiring: 0, permanent: 500 }, floors: {} },
    { name: '只有短期', bal: { imminent: 0, expiring: 100, permanent: 0 }, floors: {} },
    { name: '只有临期', bal: { imminent: 100, expiring: 0, permanent: 0 }, floors: {} },
    { name: '三档都有', bal: { imminent: 50, expiring: 100, permanent: 500 }, floors: {} },
    /** ★ 用户的核心场景：临期被阈值压下去。 */
    { name: '临期 2 + 阈值 20 ⇒ 短期', bal: { imminent: 2, expiring: 500, permanent: 1000 }, floors: { imminentFloor: 20 } },
    { name: '短期 25 + 阈值 30 ⇒ 永久', bal: { imminent: 0, expiring: 25, permanent: 1000 }, floors: { expiringFloor: 30 } },
    { name: '两个阈值都压到底', bal: { imminent: 5, expiring: 10, permanent: 1000 }, floors: { imminentFloor: 20, expiringFloor: 30 } },
    /** ★ 边界：恰好等于阈值（`>` 的语义）。 */
    { name: '临期恰好 20 + 阈值 20 ⇒ 降级', bal: { imminent: 20, expiring: 500, permanent: 1000 }, floors: { imminentFloor: 20 } },
    { name: '临期 21 + 阈值 20 ⇒ 仍临期', bal: { imminent: 21, expiring: 500, permanent: 1000 }, floors: { imminentFloor: 20 } },
  ]

  for (const c of CASES) {
    it(`★★ ${c.name}`, () => {
      const backend = buddyBalanceTier(
        { imminentBalance: c.bal.imminent, expiringBalance: c.bal.expiring, permanentBalance: c.bal.permanent },
        { ...c.floors },
      )
      const client = backendOrderTier(toSplit(c.bal), true, c.floors.imminentFloor, c.floors.expiringFloor)
      expect(
        client,
        `★★★ 客户端与后端必须同判（后端给 ${backend}，客户端给 ${client}）`,
      ).toBe(backendToClient(backend))
    })
  }

  it('★★★ 锁定永久时两边都降到 `none`', () => {
    /**
     * ⚠️ 锁定门的位置也是「同源」的一部分：两边都必须在**两条 floor 之后**判锁定。
     * 若某一边把锁定门提前，`bal(5,10,1000)` + 两个阈值会给出不同档位。
     */
    const b = { imminent: 5, expiring: 10, permanent: 1000 }
    const backend = buddyBalanceTier(
      { imminentBalance: 5, expiringBalance: 10, permanentBalance: 1000 },
      { allowPermanent: false, imminentFloor: 20, expiringFloor: 30 },
    )
    const client = backendOrderTier(toSplit(b), false, 20, 30)
    expect(backend, '后端：锁定 + 两档都低 ⇒ none').toBe(BUDDY_BALANCE_TIER.none)
    expect(client, '客户端：同判 ⇒ none').toBe(CREDIT_ORDER_TIER.none)
    expect(backendToClient(backend)).toBe(client)
  })

  it('★★ 客户端不传 floor（老调用点）⇒ 与后端关闭阈值同判', () => {
    /**
     * ⚠️ 客户端有 20+ 处 `backendOrderTier(split, true/false)` 调用**不带 floor**。
     * 它们必须等价于「阈值关闭」—— 这条守住「加可选参数不破坏既有调用点」。
     */
    for (const c of [{ imminent: 2, expiring: 500, permanent: 1000 }, { imminent: 0, expiring: 25, permanent: 0 }]) {
      const withUndefined = backendOrderTier(toSplit(c), true)
      const withZero = backendOrderTier(toSplit(c), true, 0, 0)
      const backendOff = buddyBalanceTier(
        { imminentBalance: c.imminent, expiringBalance: c.expiring, permanentBalance: c.permanent },
        {},
      )
      expect(withUndefined, '★★ 不传 ⇒ 等同 0').toBe(withZero)
      expect(withUndefined, '★★ 必须等于后端关闭阈值的结果').toBe(backendToClient(backendOff))
    }
  })
})
