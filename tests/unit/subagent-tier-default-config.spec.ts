/**
 * ★★★ **默认配置下（主代理不指定起点）子代理也不能先烧永久积分**
 *（2026-11-24，PR #153 双审 P1①）。
 *
 * ## 为什么单独一个文件
 *
 * `subagent-tier-gate-production.spec.ts` 的池序是 `[perm, imm2, imm1]`（**永久排第一**）
 * —— 那个顺序是**为另一个断言设计的**（让「档内 index」与「全量 index」不同）。
 *
 * 但它**测不出默认配置的缺陷**：池序永久在前时，即使档位闸门失效、
 * `enabledIds[0]` 落到 `acc-perm`，`sequence` 的 `(0+1+slot)` 恰好绕开永久位。
 *
 * ⇒ 本文件用**上游报障的原始池序** `[临期1, 临期2, 永久]`（永久在**最后**）：
 * 档位闸门一失效，`enabledIds[0]` = `acc-imm1` ⇒ `slot=1` 直接落到 **`acc-perm`**。
 *
 * ## 默认配置是什么
 *
 * 主代理「**默认，不指定**」起点 ⇒ `preferredRotationFor(provider, PARENT)` = `undefined`
 * ⇒ `mainSessionStartId` = `undefined`。这是**开箱即用的默认**，也是上游报障的配置。
 * 子代理自己的 `baseRotationStartId` 同样恒 `undefined`（没人能给它设）。
 *
 * 上一版：两者都 `undefined` ⇒ `tierAnchorId = undefined` ⇒ `sameTierIds = enabledIds`
 *（**全池**）⇒ 档位过滤一次都没生效 ⇒ 第二个子代理拿永久号。
 */
import { describe, expect, it } from 'vitest'

import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import { createCredentialResolver } from '../../src/credential-resolver.js'

const PROVIDER = 'probe'
const DAY = 86_400_000
const PARENT = 'session-parent'
const CHILD0 = 'child-0'
const CHILD1 = 'child-1'

/** **上游报障的原始池序**：临期在前、永久在**最后**。 */
const ENTRIES = [
  { id: 'acc-imm1', credentialRef: 'RI1', enabled: true },
  { id: 'acc-imm2', credentialRef: 'RI2', enabled: true },
  { id: 'acc-perm', credentialRef: 'RP', enabled: true },
]

function makeEnv() {
  const now = Date.now()
  const balances = {
    RI1: { packages: [{ name: 'i1', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
    RI2: { packages: [{ name: 'i2', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
    RP: { packages: [{ name: 'p', unit: 'credits', remaining: 500, total: 500, used: 0, active: true }] },
  }
  const refOf: Record<string, string> = { 'acc-imm1': 'RI1', 'acc-imm2': 'RI2', 'acc-perm': 'RP' }

  const selector = new BuddyBalanceSelector({
    product: { id: PROVIDER, displayName: 'Probe' },
    resolveCredential: async () => ({}),
    fetchBalance: async (_c: unknown, _p: unknown, ctx?: { accountId?: string }) =>
      balances[refOf[ctx?.accountId ?? ''] ?? ''] ?? null,
    now: () => now,
    ttlMs: 0,
  })

  const warm = async () => {
    await selector.select(
      ENTRIES.map((e) => ({ id: e.id, expiringBalance: 0, imminentBalance: 0, permanentBalance: 0 })),
      { allowPermanent: true },
    )
  }

  const slots: Record<string, number> = { [CHILD0]: 0, [CHILD1]: 1 }
  const pool = {
    listAccountsByProvider: () => ENTRIES,
    permanentLocked: () => false,
    strictManualOrder: () => false,
    getAvailableAccount: async () => null,
    /** ★★★ **默认配置**：主代理也不指定起点 ⇒ 恒 `undefined`（上游报障的原始形态）。 */
    preferredRotationFor: () => undefined,
    subagentRotationFor: () => ({ startMode: 'sequence' }),
    subagentAssignmentOf: (_p: string, sid: string) =>
      (slots[sid] === undefined
        ? undefined
        : { sessionId: sid, parentSessionId: PARENT, at: now, slot: slots[sid] }),
    recordSubagentStart: async () => 0,
  }

  const resolver = createCredentialResolver(
    {
      pool,
      subagentParentForSession: (sid) => (slots[sid] === undefined ? undefined : PARENT),
    },
    {
      product: { id: PROVIDER, displayName: 'Probe' },
      readCredential: async (ref: string) => ref,
      fallback: { kind: 'ref', refName: 'R_FALLBACK' },
      balance: {
        kind: 'buddy', selector,
        lockedError: () => new Error('locked'),
        isFreeModel: async () => false,
        reportPickedAccount: true,
      },
    },
  )
  return { resolver, warm }
}

describe('默认配置（主代理不指定起点）⇒ 档位过滤仍必须生效', () => {
  it('★★★ slot=0 ⇒ 临期档内，不落永久', async () => {
    const { resolver, warm } = makeEnv()
    await warm()
    const got = await resolver('m', CHILD0)
    expect(got, '★★★ slot=0 不能是永久号').not.toBe('RP')
  })

  it('★★★ slot=1 ⇒ **绝不落到 acc-perm（RP）**（上一版就是这一格烧永久）', async () => {
    const { resolver, warm } = makeEnv()
    await warm()
    const got = await resolver('m', CHILD1)
    // 上一版：tierAnchorId=undefined ⇒ 全池 [imm1,imm2,perm]，effStart=imm1
    //         ⇒ (0+1+1)%3 = 2 ⇒ acc-perm ⇒ **RP**（先烧永久）
    expect(got, '★★★ 默认配置下第二个子代理绝不能拿永久号').not.toBe('RP')
  })

  it('★★ 两个子代理都只用临期档（RI1 / RI2 之一）', async () => {
    const { resolver, warm } = makeEnv()
    await warm()
    const a = await resolver('m', CHILD0)
    const b = await resolver('m', CHILD1)
    expect(['RI1', 'RI2']).toContain(a)
    expect(['RI1', 'RI2']).toContain(b)
  })
})
