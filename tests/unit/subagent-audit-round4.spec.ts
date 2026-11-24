/**
 * ★★★ **第四轮审计的 4 条遗留项**（2026-11-24）。
 *
 * 上游在 #151 合并评论里列了 5 条「如实登记、本轮没动」，其中
 * `sameTierIds` 档位闸门已在 #153 修掉，剩下这 4 条。
 *
 * ## ⚠️ 本文件的判据纪律
 *
 * 前两版我用的是**源码文本匹配**（`toContain('startDecidedByUser')` 之类）——
 * 变异验证当场证明它们**无牙**：
 *
 * | 变异 | 文本判据 |
 * |---|---|
 * | 落盘改成无条件 | ❌ 绿 |
 * | 去掉 `startDecidedByUser` 的语义 | ❌ 绿 |
 *
 * ⇒ 改成**行为级**：真的造一个 `AccountPool` / 跑一次 resolver 取号，
 *    用**结果**判断，而不是看代码里有没有某个词。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import { createCredentialResolver } from '../../src/credential-resolver.js'
import {
  markSubagentEnded,
  recordSubagentAssignment,
  type SubagentAssignmentMap,
} from '../../src/subagent-rotation.js'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSrc = readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8')

const tmpDirs = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

// ============================================================================
// ③ 每请求写盘 —— 行为级：数文件 mtime 变了几次
// ============================================================================
describe('③ recordSubagentStart 必须「没变化就不落盘」', () => {
  /**
   * 用**真实 FileStore**（`DSH_JET_HUB_STATE_DIR` 指向临时目录）+ 真 `AccountPool`，
   * 然后数 `state.json` 的 **mtime 变化次数**。
   *
   * ⚠️ 这是唯一可靠的判据：源码文本断言对「改成无条件写」**无牙**
   *    （字面量 `changed &&` 还在，只是被短路或条件恒真）。
   */
  function makeFilePool() {
    const dir = mkdtempSync(join(tmpdir(), 'jet-hub-write-'))
    tmpDirs.push(dir)
    const saved = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = dir
    const pool = new AccountPool({ logger: { warn: () => {}, info: () => {} } } as never)
    return {
      pool,
      statePath: join(dir, 'jet-hub', 'state.json'),
      restore: () => {
        if (saved === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
        else process.env.DSH_JET_HUB_STATE_DIR = saved
      },
    }
  }

  it('★★★ 同一个子代理重复登记 ⇒ state.json 的 mtime 不再变', async () => {
    const { pool, statePath, restore } = makeFilePool()
    try {
      await pool.recordSubagentStart('probe', 'child-1', 'parent-1', 1000)
      const mtimeAfterFirst = statSync(statePath).mtimeMs

      /** ⚠️ 等 20ms 确保 mtime 精度能区分（某些 fs 只有 1ms 精度）。 */
      await new Promise((r) => setTimeout(r, 20))

      /** 模拟第二、第三发请求（`resolveCredential` 每发都会调用一次）。 */
      await pool.recordSubagentStart('probe', 'child-1', 'parent-1', 2000)
      await pool.recordSubagentStart('probe', 'child-1', 'parent-1', 3000)

      const mtimeAfterRepeats = statSync(statePath).mtimeMs
      expect(
        mtimeAfterRepeats,
        '★★★ 重复登记**不该**再写盘（上一版每请求写一次）',
      ).toBe(mtimeAfterFirst)
      expect(pool.subagentAssignmentOf('probe', 'child-1')?.slot, 'slot 必须保留').toBe(0)
    } finally {
      restore()
    }
  })

  it('★★ 不同子代理 ⇒ 必须各自落盘（反向对照）', async () => {
    const { pool, statePath, restore } = makeFilePool()
    try {
      await pool.recordSubagentStart('probe', 'child-1', 'parent-1', 1000)
      const t1 = statSync(statePath).mtimeMs
      await new Promise((r) => setTimeout(r, 20))
      await pool.recordSubagentStart('probe', 'child-2', 'parent-1', 2000)
      const t2 = statSync(statePath).mtimeMs

      expect(t2, '★★ 新子代理必须落盘').toBeGreaterThan(t1)
      expect(pool.subagentAssignmentOf('probe', 'child-2')?.slot, 'slot 必须是 1').toBe(1)
    } finally {
      restore()
    }
  })
})

// ============================================================================
// ④ fixed 两路径必须同构 —— 行为级：真的取号
// ============================================================================
describe('④ fixed 模式：付费路径必须遵从用户手选（与免费路径一致）', () => {
  const PROVIDER = 'probe'
  const DAY = 86_400_000
  const PARENT = 'session-parent'
  const CHILD = 'child-session'

  const ENTRIES = [
    { id: 'acc-1', credentialRef: 'R1', enabled: true },
    { id: 'acc-2', credentialRef: 'R2', enabled: true },
    { id: 'acc-3', credentialRef: 'R3', enabled: true },
  ]

  function makeEnv() {
    const now = Date.now()
    const balances = {
      R1: { packages: [{ name: 'a', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
      R2: { packages: [{ name: 'b', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
      R3: { packages: [{ name: 'c', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
    }
    const refOf = { 'acc-1': 'R1', 'acc-2': 'R2', 'acc-3': 'R3' }
    const selector = new BuddyBalanceSelector({
      product: { id: PROVIDER, displayName: 'Probe' },
      resolveCredential: async () => ({}),
      fetchBalance: async (_c, _p, ctx) => balances[refOf[ctx?.accountId] ?? ''] ?? null,
      now: () => now,
      ttlMs: 0,
    })
    const pool = {
      listAccountsByProvider: () => ENTRIES,
      permanentLocked: () => false,
      strictManualOrder: () => false,
      getAvailableAccount: async () => null,
      preferredRotationFor: (_p, sid) => (sid === PARENT ? 'acc-1' : undefined),
      /** ★ `fixed` 模式 + 位次 3（= acc-3）。 */
      subagentRotationFor: () => ({ startMode: 'fixed', fixedPosition: 3 }),
      /** ★ 但用户**手动选了 acc-2** ⇒ 必须遵从用户，不是位次。 */
      subagentAssignmentOf: (_p, sid) =>
        (sid === CHILD
          ? {
            sessionId: CHILD, parentSessionId: PARENT, at: now, slot: 0,
            pinnedAccountId: 'acc-3', userPickedAccountId: 'acc-2',
          }
          : undefined),
      recordSubagentStart: async () => 0,
      pinSubagentAccount: async () => false,
    }
    return createCredentialResolver(
      { pool, subagentParentForSession: (sid) => (sid === CHILD ? PARENT : undefined) },
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
  }

  it('★★★ `fixed` + 用户手选 acc-2 ⇒ **必须用 acc-2**（不能被位次 3 覆盖）', async () => {
    /**
     * ## 缺陷（上游原话）
     *
     * > 「**`fixed` 模式两路径分叉**：付费路径忽略用户手选、免费路径遵从」
     *
     * 上一版付费路径：`strategyShouldApply = startDecidedByPin !== true || startMode === 'fixed'`
     * ⇒ `fixed` 强制进入策略分支 ⇒ 用**位次 3（acc-3）**，覆盖用户手选的 acc-2。
     *
     * 而免费路径：`if (userPickedUsable) freeStartId = userPicked`
     * ⇒ 用 **acc-2**。
     *
     * ⇒ **同一件事两条路径判断相反**。修法是让付费路径也遵从用户手选。
     */
    const resolver = makeEnv()
    const got = await resolver('m', CHILD)
    expect(
      got,
      '★★★ 用户手选（acc-2）必须优先于 fixed 位次（acc-3）—— 与免费路径一致',
    ).toBe('R2')
  })

  it('★★ 无用户手选时，`fixed` 位次仍然生效（证明 fixed 没被废掉）', async () => {
    /** 反向对照：`fixed` 的价值必须保住。 */
    const PROVIDER2 = 'probe2'
    const now = Date.now()
    const balances = {
      R1: { packages: [{ name: 'a', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
      R2: { packages: [{ name: 'b', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
      R3: { packages: [{ name: 'c', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
    }
    const refOf = { 'acc-1': 'R1', 'acc-2': 'R2', 'acc-3': 'R3' }
    const selector = new BuddyBalanceSelector({
      product: { id: PROVIDER2, displayName: 'Probe2' },
      resolveCredential: async () => ({}),
      fetchBalance: async (_c, _p, ctx) => balances[refOf[ctx?.accountId] ?? ''] ?? null,
      now: () => now,
      ttlMs: 0,
    })
    const pool = {
      listAccountsByProvider: () => ENTRIES,
      permanentLocked: () => false,
      strictManualOrder: () => false,
      getAvailableAccount: async () => null,
      preferredRotationFor: (_p, sid) => (sid === PARENT ? 'acc-1' : undefined),
      subagentRotationFor: () => ({ startMode: 'fixed', fixedPosition: 3 }),
      subagentAssignmentOf: (_p, sid) =>
        (sid === CHILD ? { sessionId: CHILD, parentSessionId: PARENT, at: now, slot: 0 } : undefined),
      recordSubagentStart: async () => 0,
      pinSubagentAccount: async () => false,
    }
    const resolver = createCredentialResolver(
      { pool, subagentParentForSession: (sid) => (sid === CHILD ? PARENT : undefined) },
      {
        product: { id: PROVIDER2, displayName: 'Probe2' },
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
    expect(await resolver('m', CHILD), '★★ 无手选 ⇒ fixed 位次 3 = acc-3').toBe('R3')
  })
})

// ============================================================================
// ② RPC 写 userPicked 必须有位次越界守卫
// ============================================================================
describe('② account.setRotation：位次越界必须报错', () => {
  it('★★★ 不得静默跳过（必须有 bad-request 早退）', () => {
    /**
     * ⚠️ 上一版 `if (pickId !== undefined) { …写… }` —— 越界时什么都不做、
     * 还回 `ok: true` ⇒ 界面显示新位次、实际仍用旧 pin。
     *
     * ⚠️ 这一条只能是源码判据：`account.setRotation` 依赖 RPC 层整体上下文
     *    （`registerJetHubRpc` 的闭包），单测造不出完整入口。
     *    **如实登记为弱守卫**，但变异已证明它有牙。
     */
    const idx = rpcSrc.indexOf('const pickId = allForPick')
    expect(idx, '找不到 pickId 计算').toBeGreaterThan(-1)
    const block = rpcSrc.slice(idx, idx + 1800)
    expect(block, '★★★ 必须有 `pickId === undefined` 的早退').toMatch(/if \(pickId === undefined\)/)
    expect(block, '★★★ 早退必须回 bad-request').toContain("code: 'bad-request'")
  })
})

// ============================================================================
// ① ended 字段的生产语义
// ============================================================================
describe('① ended 字段的生产语义', () => {
  it('★★ markSubagentEnded 保留 slot 且置 ended', () => {
    const seed = recordSubagentAssignment({}, 'child-1', 'parent-1', 2, 1000)
    const out = markSubagentEnded(seed, 'child-1')
    expect(out['child-1']!.ended).toBe(true)
    expect(out['child-1']!.slot, 'resume 要用原 slot').toBe(2)
    expect(out['child-1']!.at, 'at 不得变（淘汰按它排）').toBe(1000)
  })

  it('★★ resume 时 ended 复位为 false（同一 slot 复用、at 保留）', () => {
    /**
     * ⚠️ `at` **刻意不刷新**：淘汰按 `at` 排序，若 resume 刷新 `at`，
     * 长期复用的子代理会**永远不被淘汰**（无限增长）。
     *
     * ⚠️ 我第一版断言「resume 要刷新 at」—— **错的**，实现是对的。
     */
    const seed = recordSubagentAssignment({}, 'child-1', 'parent-1', 2, 1000)
    const ended = markSubagentEnded(seed, 'child-1')
    expect(ended['child-1']!.ended).toBe(true)

    const resumed: SubagentAssignmentMap = recordSubagentAssignment(ended, 'child-1', 'parent-1', 2, 5000)
    expect(resumed['child-1']!.ended, '★★ resume 必须把 ended 复位').toBe(false)
    expect(resumed['child-1']!.slot, '★★ slot 必须不变').toBe(2)
    expect(resumed['child-1']!.at, '★★ at 必须保留原值（否则永不淘汰）').toBe(1000)
  })
})
