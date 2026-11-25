/**
 * ★★★ **Bug 2：固定帐号烧完后必须自动切号**（2026-11-25 用户报障）。
 *
 * ## 用户原话
 *
 * > 「子代理里面选定了帐号使用积分消耗完临期后不会自动切换号」
 *
 * ## 真正的根因（`subagent-start.ts:282`）
 *
 * ```ts
 * pinnedFirst: pinnedFirst || startId !== undefined,
 * ```
 *
 * **只要算出了起点（任何策略），`pinnedFirst` 就恒 `true`。**
 *
 * 而 `buddy-balance-rank.ts` 的 `pinnedHeld` 一旦为真就**短路 S6**：
 *
 * ```ts
 * if (!tierStillHeld && !pinnedHeld) { /* 交出首位 *\/ }
 * ```
 *
 * ⇒ 起点**永远占第一**，不看档位变化 ⇒ **积分烧完了也不切号**。
 *
 * ## ⚠️ 为什么交接文档指的 `pinnedHeld` 不是根因
 *
 * 文档建议把 `pinnedHeld` 改成
 * `options.pinnedFirst === true && buddyTierUsable(...)`。
 *
 * 但 `startAccount = ranked[anchor]`，而 `anchor` 循环（L671-675）**已经保证**
 * `buddyTierUsable(buddyBalanceTier(startAccount, options)) === true`
 * ⇒ 新加的判据**恒真** ⇒ 等价变异 ⇒ **守卫必然无牙**（我实测确认）。
 *
 * ⇒ 真根因在**上游**：`decideSubagentStart` 把 `pinnedFirst` 算成了恒真。
 *
 * ## 本文件守什么
 *
 * | 模式 | 起点来源 | `pinnedFirst` 应为 |
 * |---|---|---|
 * | `follow` | 无 | `false` |
 * | `sequence` / `reverse` / `hash` | 策略现算 | **`false`**（档位规则必须生效）|
 * | `fixed` | 用户位次 | **`true`**（用户明确要求「烧没了才切」）|
 * | `user-pick` | 用户手选 | **`true`**（用户明确指定）|
 */
import { describe, expect, it } from 'vitest'

import { decideSubagentStart } from '../../src/subagent-start.js'

const PROVIDER = 'probe'
const SESSION = 'child-session'
const NOW = 1_700_000_000_000

/** 三个账号：A(临期) / B(临期) / C(永久)。 */
const ENTRIES = [
  { id: 'acc-a', credentialRef: 'RA', enabled: true },
  { id: 'acc-b', credentialRef: 'RB', enabled: true },
  { id: 'acc-c', credentialRef: 'RC', enabled: true },
]
const CANDIDATES = ['acc-a', 'acc-b', 'acc-c']

/**
 * 造一个 `SubagentStartPoolLike` 替身。
 *
 * @param mode - 策略
 * @param assignment - 分配记录（`slot` / `pin` / `userPicked`）
 */
function makePool(options: {
  mode?: 'follow' | 'sequence' | 'reverse' | 'hash' | 'fixed'
  fixedPosition?: number
  pinnedAccountId?: string
  userPickedAccountId?: string
  slot?: number
}) {
  const assignment = {
    sessionId: SESSION,
    parentSessionId: 'parent-session',
    at: NOW,
    slot: options.slot ?? 0,
    ...(options.pinnedAccountId === undefined ? {} : { pinnedAccountId: options.pinnedAccountId }),
    ...(options.userPickedAccountId === undefined ? {} : { userPickedAccountId: options.userPickedAccountId }),
  }
  return {
    subagentRotationFor: () => (options.mode === undefined ? undefined : {
      startMode: options.mode,
      ...(options.fixedPosition === undefined ? {} : { fixedPosition: options.fixedPosition }),
    }),
    subagentAssignmentOf: () => assignment,
    listAccountsByProvider: () => ENTRIES,
  }
}

/** 统一调用 `decideSubagentStart`（不传 selector ⇒ 档位未知 ⇒ 用全池）。 */
function decide(options: {
  mode?: 'follow' | 'sequence' | 'reverse' | 'hash' | 'fixed'
  fixedPosition?: number
  pinnedAccountId?: string
  userPickedAccountId?: string
  slot?: number
  mainSessionStartId?: string
}) {
  return decideSubagentStart({
    providerId: PROVIDER,
    sessionId: SESSION,
    candidateIds: CANDIDATES,
    allowPermanent: true,
    pool: makePool(options) as never,
    mainSessionStartId: options.mainSessionStartId ?? 'acc-a',
  })
}

describe('Bug 2：`sequence` / `reverse` / `hash` 不得设 pinnedFirst', () => {
  it('★★★ sequence 模式 ⇒ pinnedFirst 必须为 false（否则烧完不切号）', () => {
    /**
     * ⚠️ **这是用户报障的核心那一格**。
     *
     * 修复前：`pinnedFirst: pinnedFirst || startId !== undefined`
     * ⇒ strategy 算出 startId 后 **恒 true** ⇒ 档位规则被短路。
     *
     * ⇒ 用户看到「选定了帐号使用积分消耗完临期后不会自动切换号」。
     */
    const out = decide({ mode: 'sequence' })
    expect(out.startId, '前提：sequence 必须算出起点').toBeDefined()
    expect(
      out.pinnedFirst,
      '★★★ sequence 只是「错开起点」，档位规则必须仍然生效',
    ).toBe(false)
  })

  it('★★★ reverse 模式 ⇒ pinnedFirst 必须为 false', () => {
    const out = decide({ mode: 'reverse' })
    expect(out.startId).toBeDefined()
    expect(out.pinnedFirst, '★★★ reverse 同理').toBe(false)
  })

  it('★★★ hash 模式 ⇒ pinnedFirst 必须为 false', () => {
    const out = decide({ mode: 'hash' })
    expect(out.startId).toBeDefined()
    expect(out.pinnedFirst, '★★★ hash 同理').toBe(false)
  })

  it('★★★ 系统 pin（非 fixed）⇒ pinnedFirst 必须为 false', () => {
    /**
     * ⚠️ pin 只是「拉起时定死起点」，**档位规则仍要生效**
     * —— 否则 pin 的号烧完临期后会在它身上继续烧短期/永久。
     *
     * 这正是 `subagent-start.ts:197-200` 注释写的意图：
     * 「`pinnedFirst` 不设：pin 只是起点，档位规则仍然生效
     *   （否则会去烧永久积分）」
     * —— 但 L282 把那个意图**推翻**了。
     */
    const out = decide({ mode: 'sequence', pinnedAccountId: 'acc-b' })
    expect(out.startId, '前提：pin 命中').toBe('acc-b')
    expect(out.pinnedFirst, '★★★ pin 的号也必须「烧没了才切」').toBe(false)
  })
})

describe('Bug 2：`fixed` 与用户手选**必须**设 pinnedFirst', () => {
  it('★★★ fixed 模式 ⇒ pinnedFirst 必须为 true（用户明确要求绝对第一）', () => {
    /**
     * ⚠️ **反向对照**：证明修复不是「一律不 pin」。
     *
     * 用户对 `fixed` 的原话是「该号临期和短期都烧，烧没了才切帐号」
     * ⇒ 这正是 `pinnedFirst` 的语义（**跳过档位检查**，但**仍有可用性兜底**）。
     */
    const out = decide({ mode: 'fixed', fixedPosition: 2 })
    expect(out.startId, '前提：fixed 位次 2 = acc-b').toBe('acc-b')
    expect(out.pinnedFirst, '★★★ fixed 必须绝对第一').toBe(true)
  })

  it('★★★ 用户手选 ⇒ pinnedFirst 必须为 true', () => {
    /**
     * ⚠️ 用户手选是最强的意愿表达 ⇒ 必须绝对第一。
     */
    const out = decide({ mode: 'sequence', userPickedAccountId: 'acc-c' })
    expect(out.startId, '前提：手选命中').toBe('acc-c')
    expect(out.pinnedFirst, '★★★ 用户手选必须绝对第一').toBe(true)
  })
})

describe('Bug 2：零回归面', () => {
  it('★★ `follow` ⇒ pinnedFirst=false、无 startId', () => {
    const out = decide({ mode: 'follow' })
    expect(out.startId).toBeUndefined()
    expect(out.pinnedFirst).toBe(false)
    expect(out.ownedBySubagent).toBe(false)
  })

  it('★★ 没配子代理设置 ⇒ 完全不动（零回归）', () => {
    const out = decide({})
    expect(out.startId).toBeUndefined()
    expect(out.pinnedFirst).toBe(false)
    expect(out.decidedBy).toBe('none')
  })
})
