/**
 * ★★★ **`pinnedFirst`：绝对第一**（2026-11-23）。
 *
 * ## 用户的明确要求
 *
 * > 「让它绝对第一，除非它不可用了（不可用也包含锁定永久时它只有永久情况）
 * >   就切换，所以当指定固定帐号时，如果开了锁定永久，
 * >   则它临期和短期都烧，烧没了才切帐号」
 *
 * ## 与既有 S6 的**唯一差别**
 *
 * | | S6（`rotationStartTier`）| `pinnedFirst` |
 * |---|---|---|
 * | 起点档位未变 | 绝对第一 | 绝对第一 |
 * | **起点档位变了**（如临期→短期）| **交出首位** | **仍绝对第一** |
 * | 起点完全没积分 | 交出首位 | 交出首位 |
 * | 锁定永久 + 只剩永久 | 交出首位 | **交出首位**（与用户要求一致）|
 *
 * ## ⚠️ 为什么必须测「未锁定 + 只剩永久仍第一」
 *
 * 用户原话：「未锁定永久的帐号就在用它的永久积分」
 * ⇒ 此时**不能**交出首位，否则「固定」就变成了「只在临期时固定」。
 */
import { describe, expect, it } from 'vitest'

import { rotateFromPreferred, rankBuddyAccountsByBalance } from '../../src/buddy-balance-rank.js'

/** 造一行「已分桶」的账号（`buddyBalanceTier` 期望的形状）。 */
const acct = (
  id: string,
  imminent: number,
  expiring: number,
  permanent: number,
) => ({ id, imminentBalance: imminent, expiringBalance: expiring, permanentBalance: permanent })

const POOL = ['a1', 'a2', 'a3', 'a4']

describe('pinnedFirst：起点档位变了仍绝对第一', () => {
  it('★★★ 起点从「临期」降到「短期」⇒ pinnedFirst 仍让它第一（S6 会交出首位）', () => {
    const rows = [
      acct('a1', 50, 100, 0),   // 临期档
      acct('a2', 0, 80, 0),     // 起点：已是短期档（选定那一刻是临期）
      acct('a3', 30, 100, 0),   // 临期档
    ]
    const ranked = rankBuddyAccountsByBalance(rows, {})

    /** 先确认基线：不带 pinnedFirst 时（S6 语义）起点**交出首位**。 */
    const withoutPin = rotateFromPreferred(ranked, {
      rotationStartId: 'a2',
      rotationStartTier: 'imminent',
      enabledAccountIds: ['a1', 'a2', 'a3'],
    }).map((r) => r.id)
    expect(withoutPin[0], 'S6 应让临期档的 a1/a3 排前面').not.toBe('a2')

    /** 带 pinnedFirst ⇒ 起点**恒第一**。 */
    const withPin = rotateFromPreferred(ranked, {
      rotationStartId: 'a2',
      rotationStartTier: 'imminent',
      enabledAccountIds: ['a1', 'a2', 'a3'],
      pinnedFirst: true,
    }).map((r) => r.id)
    expect(withPin[0], '★★★ pinnedFirst 必须让起点第一（档位变了也一样）').toBe('a2')
  })

  it('★★★ 起点落到「永久」档 ⇒ 未锁定时仍第一（用户要求：继续烧永久）', () => {
    const rows = [
      acct('a1', 50, 100, 0),
      acct('a2', 0, 0, 900),    // 起点：只剩永久
      acct('a3', 30, 100, 0),
    ]
    const ranked = rankBuddyAccountsByBalance(rows, {})

    const withPin = rotateFromPreferred(ranked, {
      rotationStartId: 'a2',
      rotationStartTier: 'imminent',
      enabledAccountIds: ['a1', 'a2', 'a3'],
      pinnedFirst: true,
      // ⚠️ 未锁定 ⇒ allowPermanent 默认 true
    }).map((r) => r.id)
    expect(withPin[0], '★★★ 未锁定时只剩永久 ⇒ 继续用它烧永久').toBe('a2')
  })

  it('★★★ 锁定永久 + 起点只剩永久 ⇒ **必须切走**（不可用）', () => {
    const rows = [
      acct('a1', 50, 100, 0),
      acct('a2', 0, 0, 900),    // 起点：只剩永久
      acct('a3', 30, 100, 0),
    ]
    const ranked = rankBuddyAccountsByBalance(rows, {})

    const out = rotateFromPreferred(ranked, {
      rotationStartId: 'a2',
      rotationStartTier: 'imminent',
      enabledAccountIds: ['a1', 'a2', 'a3'],
      pinnedFirst: true,
      allowPermanent: false,     // ← 锁定
    }).map((r) => r.id)
    expect(out[0], '★★★ 锁定永久 + 只剩永久 ⇒ 该号不可用，必须切走').not.toBe('a2')
  })

  it('★★ 起点完全没积分 ⇒ 切走（pinnedFirst 也不能选它）', () => {
    const rows = [
      acct('a1', 50, 100, 0),
      acct('a2', 0, 0, 0),      // 起点：彻底空
      acct('a3', 30, 100, 0),
    ]
    const ranked = rankBuddyAccountsByBalance(rows, {})
    const out = rotateFromPreferred(ranked, {
      rotationStartId: 'a2',
      rotationStartTier: 'imminent',
      enabledAccountIds: ['a1', 'a2', 'a3'],
      pinnedFirst: true,
    }).map((r) => r.id)
    expect(out[0], '空号的不能排第一').not.toBe('a2')
  })
})

describe('pinnedFirst：不影响既有语义（回归面）', () => {
  it('★★★ 不传 pinnedFirst ⇒ 与改动前逐字节相同（S6 行为不变）', () => {
    const rows = [
      acct('a1', 50, 100, 0),
      acct('a2', 100, 100, 0),
      acct('a3', 0, 80, 0),
    ]
    const ranked = rankBuddyAccountsByBalance(rows, {})
    const opts = {
      rotationStartId: 'a2',
      rotationStartTier: 'imminent' as const,
      enabledAccountIds: POOL.slice(0, 3),
    }
    const plain = rotateFromPreferred(ranked, opts).map((r) => r.id)
    const explicitFalse = rotateFromPreferred(ranked, { ...opts, pinnedFirst: false }).map((r) => r.id)
    expect(explicitFalse, 'undefined 与 false 必须同义').toEqual(plain)
  })

  it('★★ pinnedFirst 但档位**没变** ⇒ 结果与 S6 相同（两者都第一）', () => {
    const rows = [
      acct('a1', 50, 100, 0),
      acct('a2', 100, 100, 0),   // 起点：仍是临期
      acct('a3', 30, 100, 0),
    ]
    const ranked = rankBuddyAccountsByBalance(rows, {})
    const base = {
      rotationStartId: 'a2',
      rotationStartTier: 'imminent' as const,
      enabledAccountIds: POOL.slice(0, 3),
    }
    const s6 = rotateFromPreferred(ranked, base).map((r) => r.id)
    const pin = rotateFromPreferred(ranked, { ...base, pinnedFirst: true }).map((r) => r.id)
    expect(pin[0]).toBe('a2')
    expect(pin[0], '两者都应让起点第一').toBe(s6[0])
  })

  it('★★ 无 rotationStartId 时 pinnedFirst 无效（不能凭空第一）', () => {
    const rows = [
      acct('a1', 50, 100, 0),
      acct('a2', 100, 100, 0),
    ]
    const ranked = rankBuddyAccountsByBalance(rows, {})
    const out = rotateFromPreferred(ranked, { pinnedFirst: true }).map((r) => r.id)
    expect(out, '没有起点 ⇒ 原样返回排序结果').toEqual(ranked.map((r) => r.id))
  })
})
