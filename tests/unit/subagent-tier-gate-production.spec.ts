/**
 * ★★★ **临期优先必须对子代理也生效**（2026-11-24 第四轮对抗审计 P1）。
 *
 * ## 上游原话
 *
 * > 「**临期优先对子代理失效**：池 `[临期, 临期, 永久]` 时，`child-2` 会拿到
 * >   **永久号、先烧永久积分**。
 * >   根因是档位收窄的闸门读的是**子代理自己**的 `baseRotationStartId`
 * >   （生产路径恒 `undefined`）。
 * >   而作者那条「同档位内错开」的 e2e **只因为 `preferredRotationFor` 替身
 * >   对所有 sessionId 返回同值才绿** —— 换成真实形态后立刻变红（`RI2`→`RP`）。」
 *
 * ## ⚠️ 本文件为什么必须存在
 *
 * 旧的 `subagent-e2e-start.spec.ts` 里那条「同档位内错开」用例**是假绿**：
 * 它让 `preferredRotationFor` 对**任何** sessionId 都返回同一个值
 * （`() => 'acc-imm1'`）⇒ 子代理自己的 `baseRotationStartId` 也有值
 * ⇒ 闸门恰好命中档位分支 ⇒ 测试通过。
 *
 * 而**生产路径**是：
 *
 * | 查询 | 生产返回值 |
 * |---|---|
 * | `preferredRotationFor(provider, **主代理** sessionId)` | 用户设的起点（可能有值）|
 * | `preferredRotationFor(provider, **子代理** sessionId)` | **恒 `undefined`**（没人能给它设起点）|
 *
 * ⇒ 本文件**严格复现生产形态**：只有主代理那条返回起点，子代理那条恒 `undefined`。
 *
 * ⚠️ 这就是「替身必须复现真实语义」这条纪律的又一次实例 —— 我在本 PR 里
 *    因为它栽过两次（端到端替身不按 sessionId 区分 / 本次档位替身返回同值）。
 */
import { describe, expect, it } from 'vitest'

import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import { createCredentialResolver } from '../../src/credential-resolver.js'

const PROVIDER = 'probe'
const DAY = 86_400_000
const PARENT = 'session-parent'
const CHILD = 'child-session'

/**
 * 池序：`[临期1, 临期2, 永久]`（上游实测用的就是这个形状）。
 *
 * ⚠️ **顺序是刻意的**：临期在前、永久在后 ⇒ 若档位过滤失效，
 * 「全量账号」序列就是 `[imm1, imm2, perm]` ⇒ `sequence` 错开会落到 `perm`。
 */
/**
 * ⚠️⚠️ **池序是精心设计的，不要随意调整**（这是让变异有牙的关键）。
 *
 * 全量序列：`[acc-perm, acc-imm2, acc-imm1]`（**永久排第一位**）
 * 临期档序列：`[acc-imm2, acc-imm1]`
 *
 * 主代理起点 = `acc-imm1`：
 *
 * | 路径 | 序列 | `sequence` slot=0 的结果 |
 * |---|---|---|
 * | **档内（正确）** | `[imm2, imm1]` | `[(1+1+0)%2]` = `imm2` ✅ |
 * | **全量（缺陷）** | `[perm, imm2, imm1]` | `[(2+1+0)%3]` = **`perm`** ❌ |
 *
 * ⇒ 两者结果**不同**，变异才能被抓住。
 *
 * ⚠️ 我第一版用 `[imm1, imm2, perm]` —— 档内 index 1 与全量 index 1
 *    **都是 imm2** ⇒ 三个变异全绿（无牙）。这是「判据算对了但用例选不出差异」
 *    的典型形态。
 */
const ENTRIES = [
  { id: 'acc-perm', credentialRef: 'RP', enabled: true },
  { id: 'acc-imm2', credentialRef: 'RI2', enabled: true },
  { id: 'acc-imm1', credentialRef: 'RI1', enabled: true },
]

function makeEnv() {
  const now = Date.now()
  const balances = {
    RI1: { packages: [{ name: 'i1', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
    RI2: { packages: [{ name: 'i2', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
    RP: { packages: [{ name: 'p', unit: 'credits', remaining: 500, total: 500, used: 0, active: true }] },
  }
  const refOf = { 'acc-imm1': 'RI1', 'acc-imm2': 'RI2', 'acc-perm': 'RP' }

  const selector = new BuddyBalanceSelector({
    product: { id: PROVIDER, displayName: 'Probe' },
    resolveCredential: async () => ({}),
    fetchBalance: async (_c, _p, ctx) => balances[refOf[ctx?.accountId] ?? ''] ?? null,
    now: () => now,
    ttlMs: 0,
  })

  /** ⚠️ 预热余额缓存（`cachedTierOf` 只读缓存）。 */
  const warm = async () => {
    await selector.select(
      ENTRIES.map((e) => ({ id: e.id, expiringBalance: 0, imminentBalance: 0, permanentBalance: 0 })),
      { allowPermanent: true },
    )
  }

  const recorded = []
  const pool = {
    listAccountsByProvider: () => ENTRIES,
    permanentLocked: () => false,
    strictManualOrder: () => false,
    getAvailableAccount: async () => null,
    /**
     * ★★★ **严格复现生产形态**：
     * - 主代理 → 有起点（用户设的 `acc-imm1`）
     * - **子代理 → 恒 `undefined`**（没人能给它设起点）
     */
    preferredRotationFor: (_p, sid) => (sid === PARENT ? 'acc-imm1' : undefined),
    subagentRotationFor: () => ({ startMode: 'sequence' }),
    /**
     * ⚠️ **必须让分配记录有 slot**，否则策略分支不进入。
     * 分配记录是**服务端自己写的**（`recordSubagentStart`），与
     * `preferredRotationFor` 无关 —— 这正是生产里两者共存的方式。
     */
    subagentAssignmentOf: (_p, sid) =>
      (sid === CHILD
        ? { sessionId: CHILD, parentSessionId: PARENT, at: now, slot: 0 }
        : undefined),
    recordSubagentStart: async (provider, sid, parent) => { recorded.push({ provider, sid, parent }); return 0 },
    pinSubagentAccount: async () => false,
  }

  const resolver = createCredentialResolver(
    {
      pool,
      /** ⚠️ 路 1：父会话来自宿主会话头。 */
      subagentParentForSession: (sid) => (sid === CHILD ? PARENT : undefined),
    },
    {
      product: { id: PROVIDER, displayName: 'Probe' },
      readCredential: async (ref) => ref,
      fallback: { kind: 'ref', refName: 'R_FALLBACK' },
      balance: {
        kind: 'buddy', selector,
        lockedError: () => new Error('locked'),
        isFreeModel: async () => false,
        reportPickedAccount: true,
      },
    },
  )
  return { resolver, warm, recorded }
}

describe('端到端：临期优先对子代理必须生效（生产形态替身）', () => {
  it('★★★ slot=0 在临期档内错开 ⇒ acc-imm2，**绝不落到永久号**', async () => {
    /**
     * 临期档 = `[acc-imm1, acc-imm2]`，主代理起点 `acc-imm1`（index 0）
     * ⇒ `sequence` slot=0 = `tierIds[(0+1+0)%2]` = index 1 ⇒ **`acc-imm2`**（RI2）。
     *
     * ⚠️ **slot 取 0 而不是 1**（我第一版写错，如实登记）：
     *    `sequence` 的公式是 `tierIds[(base + 1 + slot) % n]` ——
     *    n=2 时 slot=1 会**绕回 index 0**（= 主代理自己），
     *    测不出「是否落到永久号」。slot=0 才是「档内往前一位」。
     *
     * ⚠️ **若档位闸门失效**（读的是子代理自己的 `undefined` ⇒ 退全量
     * `[imm1, imm2, perm]`）⇒ slot=1 会落到 **`acc-perm`**（RP）
     * ⇒ 先烧永久积分。**这正是上游实测的缺陷。**
     */
    const { resolver, warm } = makeEnv()
    await warm()
    const got = await resolver('m', CHILD)
    expect(got, '★★★ 必须档内错开（RI2），不能落到永久号（RP）').toBe('RI2')
  })

  it('★★ 主代理（无分配记录）⇒ 用它自己的起点 acc-imm1', async () => {
    /** 反向对照：证明子代理逻辑不影响主代理。 */
    const { resolver, warm } = makeEnv()
    await warm()
    expect(await resolver('m', PARENT), '主代理仍用自己的起点').toBe('RI1')
  })
})
