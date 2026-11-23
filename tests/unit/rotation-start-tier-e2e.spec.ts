/**
 * ★★★ **生产链路端到端：`resolver → pickBuddyAccount → 真实 BuddyBalanceSelector`**
 * （PR #148 的对抗审计附录 A，2026-11-23 收编）。
 *
 * ## 为什么必须补这一条
 *
 * PR #148 自带的 224 行用例**只锁住中间层**（「字段出现在 options 里」），
 * 而对抗审计实测：在**真实** `select()` 里把 tier 丢掉（M4），出厂 **13 spec / 466 条全绿**。
 * 同理 M9（resolver 那跳断掉）、M10（恒当 permanent）也全绿。
 *
 * ⇒ 中间层有牙、**两端没有**。本用例把整条链跑起来（真实 resolver + 真实 selector，
 *   只替换池与 `fetchBalance`），三种形态各一条：
 *
 * | 场景 | 期望 |
 * |---|---|
 * | 起点仍持有选定档位（`permanent`）| **起点占首位**（`R_START`）|
 * | 起点已降档（`imminent`）| **交出首位**，换那个有临期的号（`R_IMM`）|
 * | 池不实现 `rotationStartTierFor`（**缺陷态**）| 交出首位 |
 *
 * ⚠️ 第三条是**反向对照**：它锁的正是 PR 修前的行为 —— 没有它，前两条在「字段恒
 * `undefined`」时也会「绿一条红一条」，看不出修的是什么。
 */
// tests/unit/rotation-start-tier-e2e.spec.ts（建议名）
import { describe, expect, it } from 'vitest'
import { createCredentialResolver } from '../../src/credential-resolver.js'
import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'

const PROVIDER = 'probe'
const DAY = 86_400_000
const ENTRIES = [
  { id: 'acc-imm', credentialRef: 'R_IMM', enabled: true },
  { id: 'acc-start', credentialRef: 'R_START', enabled: true },
]

function makeEnv(options: { withTier: boolean; tier?: 'imminent' | 'expiring' | 'permanent' }) {
  const now = Date.now()
  const balances: Record<string, unknown> = {
    // 有临期额度（1 天后到期）
    R_IMM: { packages: [{ name: 'imm', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
    // 只剩永久（无 deductionEndTime）
    R_START: { packages: [{ name: 'perm', unit: 'credits', remaining: 500, total: 500, used: 0, active: true }] },
  }
  const selector = new BuddyBalanceSelector({
    product: { id: PROVIDER, displayName: 'Probe' } as never,
    resolveCredential: async () => ({}) as never,
    fetchBalance: async (credential: unknown, _p: unknown, ctx?: { accountId?: string }) => {
      const key = typeof credential === 'string' ? credential : (ctx?.accountId === 'acc-imm' ? 'R_IMM' : 'R_START')
      return (balances[key] ?? null) as never
    },
    now: () => now,
    ttlMs: 0,
  } as never)
  const pool = {
    listAccountsByProvider: () => ENTRIES,
    permanentLocked: () => false,
    strictManualOrder: () => false,
    getAvailableAccount: async () => null,
    preferredRotationFor: () => 'acc-start',
    ...(options.withTier ? { rotationStartTierFor: () => options.tier } : {}),
  }
  const resolver = createCredentialResolver<string>(
    { pool: pool as never },
    {
      product: { id: PROVIDER, displayName: 'Probe' },
      readCredential: async (ref: string) => ref,
      fallback: { kind: 'ref', refName: 'R_FALLBACK' },
      balance: {
        kind: 'buddy', selector: selector as never,
        lockedError: () => new Error('locked'),
        isFreeModel: async () => false,
        reportPickedAccount: true,
      },
    } as never,
  )
  return resolver
}

describe('生产链路端到端：resolver → pickBuddyAccount → 真实 selector', () => {
  it('起点仍持有选定档位 ⇒ 起点占首位', async () => {
    expect(await makeEnv({ withTier: true, tier: 'permanent' })('m', 's1')).toBe('R_START')
  })
  it('起点已降档 ⇒ 交出首位，换有临期的号', async () => {
    expect(await makeEnv({ withTier: true, tier: 'imminent' })('m', 's1')).toBe('R_IMM')
  })
  it('池不实现 rotationStartTierFor（缺陷态）⇒ 交出首位', async () => {
    expect(await makeEnv({ withTier: false })('m', 's1')).toBe('R_IMM')
  })
})
