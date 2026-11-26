/**
 * ★★★ **Bug 1：子代理「帐号分布方式」不生效**（2026-11-25 用户报障）。
 *
 * ## 用户原话
 *
 * > 「子代理设置里面的帐号分布方式不成功」
 *
 * ## 本文件的目的
 *
 * 交接文档给了三条线索（slot 全局递增 / assignment 未登记 / 档位缩到 1 个）。
 * **先用行为级测试把「哪一格红」钉出来**，再改代码。
 *
 * ## 对照组设计
 *
 * 池：`[A(临期), B(临期), C(永久)]`，主代理起点 = A，`sequence`，2 个子代理。
 *
 * | slot | `sequence` 期望（档内 `[A,B]`） |
 * |---|---|
 * | 0 | `B` |
 * | 1 | `A`（绕回） |
 *
 * ⇒ 两个子代理由此**不同**（B / A），且都不等于「主代理当前号」时的行为也可断言。
 */
import { describe, expect, it } from 'vitest'

import { decideSubagentStart } from '../../src/subagent-start.js'
import { startIndexOfSlot } from '../../src/subagent-rotation.js'

const PROVIDER = 'probe'
const NOW = 1_700_000_000_000

/** 池序：A / B / C。 */
const ENTRIES = [
  { id: 'acc-a', credentialRef: 'RA', enabled: true },
  { id: 'acc-b', credentialRef: 'RB', enabled: true },
  { id: 'acc-c', credentialRef: 'RC', enabled: true },
]
const CANDIDATES = ['acc-a', 'acc-b', 'acc-c']

/**
 * 造一个**带余额档位**的 selector 替身。
 *
 * @param tiers - 账号 id → 档位（0=临期 / 1=短期 / 2=永久 / 3=不可用）
 *
 * ⚠️ 必须提供 `cachedTierOf`，否则 `sameTierAsMainStart` / `bestTierAnchorId`
 *    会**退化为全池** —— 那样测不出「档位内错开」这条腿。
 */
function makeSelector(tiers: Record<string, number>) {
  return {
    cachedTierOf: (account: { id: string }) => tiers[account.id],
  } as never
}

function makePool(options: {
  slots: Record<string, number>
  mode?: 'follow' | 'sequence' | 'reverse' | 'hash' | 'fixed'
  fixedPosition?: number
}) {
  return {
    subagentRotationFor: () => ({
      startMode: options.mode ?? 'sequence',
      ...(options.fixedPosition === undefined ? {} : { fixedPosition: options.fixedPosition }),
    }),
    subagentAssignmentOf: (_p: string, sid: string) => {
      const slot = options.slots[sid]
      if (slot === undefined) return undefined
      return { sessionId: sid, parentSessionId: 'parent-session', at: NOW, slot }
    },
    listAccountsByProvider: () => ENTRIES,
  } as never
}

/** 统一调用（主代理起点 = acc-a）。 */
function decide(options: {
  slots: Record<string, number>
  sessionId: string
  mode?: 'follow' | 'sequence' | 'reverse' | 'hash' | 'fixed'
  fixedPosition?: number
  tiers?: Record<string, number>
  mainSessionStartId?: string
}) {
  return decideSubagentStart({
    providerId: PROVIDER,
    sessionId: options.sessionId,
    candidateIds: CANDIDATES,
    allowPermanent: true,
    pool: makePool(options),
    selector: makeSelector(options.tiers ?? { 'acc-a': 0, 'acc-b': 0, 'acc-c': 2 }),
    mainSessionStartId: options.mainSessionStartId ?? 'acc-a',
  })
}

describe('Bug 1：`sequence` 必须让不同子代理拿到不同账号', () => {
  it('★★★ 2 个子代理（slot 0 / 1）⇒ 起点必须**不同**', () => {
    /**
     * 临期档 = `[acc-a, acc-b]`，主代理起点 = `acc-a`。
     *
     * - slot 0 ⇒ `(0+1+0)%2 = 1` ⇒ **acc-b**
     * - slot 1 ⇒ `(0+1+1)%2 = 0` ⇒ **acc-a**
     *
     * ⇒ 不同 ✅
     */
    const c1 = decide({ slots: { 'child-1': 0, 'child-2': 1 }, sessionId: 'child-1' })
    const c2 = decide({ slots: { 'child-1': 0, 'child-2': 1 }, sessionId: 'child-2' })

    expect(c1.startId, 'child-1 必须有起点').toBeDefined()
    expect(c2.startId, 'child-2 必须有起点').toBeDefined()
    expect(
      c1.startId,
      `★★★ 两个子代理必须错开（实际 child-1=${c1.startId} child-2=${c2.startId}）`,
    ).not.toBe(c2.startId)
  })

  it('★★★ slot 0 不得等于主代理起点（否则「没按预期错开」）', () => {
    /**
     * ⚠️ `sequence` 的语义是「从主代理起点**往后**数」——
     * slot 0 就应该是起点之后的**第一个**，不是起点自己。
     */
    const out = decide({ slots: { 'child-1': 0 }, sessionId: 'child-1' })
    expect(out.startId, '★★★ sequence slot=0 必须是起点之后第一个').toBe('acc-b')
  })

  it('★★★ slot 缺失（未登记）⇒ 所有子代理都拿 slot 0 ⇒ 会撞号（这是线索 B）', () => {
    /**
     * ⚠️ **这一格是「归因测试」，不是缺陷测试**。
     *
     * 若 `subagentAssignmentOf` 返回 `undefined`（没登记成功），
     * `decideSubagentStart` 用 `assignment?.slot ?? 0` ⇒ **全是 slot 0**
     * ⇒ 所有子代理**同一个起点** ⇒ 用户看到「分布方式没生效」。
     *
     * ⇒ 本用例把这条因果**钉死**：未登记时确实会撞。
     *    修复方向是「保证登记发生」，不是改 `decideSubagentStart`。
     */
    const c1 = decide({ slots: {}, sessionId: 'child-1' })
    const c2 = decide({ slots: {}, sessionId: 'child-2' })
    expect(c1.startId, '未登记 ⇒ slot 兜底 0').toBe(c2.startId)
  })

  it('★★★ 档位内只有 1 个号 ⇒ `sequence` 必然撞号（线索 C，账号不足而非缺陷）', () => {
    /**
     * ⚠️ **这是「账号不够」而非 bug**：`n=1` 时 `(0+1+slot)%1 === 0` 恒成立。
     *
     * 本用例**如实记录**这个事实，防止将来有人把它当回归去「修」。
     * 合理的产品做法是「给出可诊断提示」，而不是改判据。
     */
    const out0 = decide({
      slots: { 'child-1': 0 },
      sessionId: 'child-1',
      tiers: { 'acc-a': 0, 'acc-b': 2, 'acc-c': 2 },
    })
    const out1 = decide({
      slots: { 'child-2': 1 },
      sessionId: 'child-2',
      tiers: { 'acc-a': 0, 'acc-b': 2, 'acc-c': 2 },
    })
    expect(out0.startId, '临期档只有 A ⇒ sequence 恒返回 A').toBe('acc-a')
    expect(out1.startId, '同因').toBe('acc-a')
  })
})

describe('Bug 1：其余策略的错开规律', () => {
  const tiers = { 'acc-a': 0, 'acc-b': 0, 'acc-c': 2 }

  it('★★ reverse：slot 0 是起点**之前**那一个', () => {
    /**
     * 档内 `[acc-a, acc-b]`，起点 `acc-a`（index 0）
     * ⇒ `(0-1-0+4)%2 = 1` ⇒ **acc-b**（绕回档尾）
     */
    const out = decide({ slots: { 'child-1': 0 }, sessionId: 'child-1', mode: 'reverse', tiers })
    expect(out.startId).toBe('acc-b')
  })

  it('★★ hash：稳定（同 sessionId 恒同结果）、且不等于主代理起点', () => {
    const a = decide({ slots: { 'child-1': 0 }, sessionId: 'child-1', mode: 'hash', tiers })
    const b = decide({ slots: { 'child-1': 0 }, sessionId: 'child-1', mode: 'hash', tiers })
    expect(a.startId, '★ 同 sessionId 必须稳定').toBe(b.startId)
    expect(a.startId, '★ hash 必须排除主代理起点').not.toBe('acc-a')
  })

  it('★★ fixed：按位次取，忽略错开', () => {
    const out = decide({
      slots: { 'child-1': 0 },
      sessionId: 'child-1',
      mode: 'fixed',
      fixedPosition: 3,
      tiers,
    })
    expect(out.startId, '位次 3 = acc-c').toBe('acc-c')
  })
})

describe('Bug 1：`startIndexOfSlot` 纯函数直测（排除上层干扰）', () => {
  const tierIds = ['acc-a', 'acc-b', 'acc-c']

  it('★★★ sequence：slot 递增必须逐个错开', () => {
    expect(startIndexOfSlot(tierIds, 'acc-a', 'sequence', 0, 's')).toBe('acc-b')
    expect(startIndexOfSlot(tierIds, 'acc-a', 'sequence', 1, 's')).toBe('acc-c')
    expect(startIndexOfSlot(tierIds, 'acc-a', 'sequence', 2, 's')).toBe('acc-a')
  })

  it('★★ reverse：反序', () => {
    expect(startIndexOfSlot(tierIds, 'acc-a', 'reverse', 0, 's')).toBe('acc-c')
    expect(startIndexOfSlot(tierIds, 'acc-a', 'reverse', 1, 's')).toBe('acc-b')
  })

  it('★★★ `slot` 很大时必须取模（不得越界返回 undefined）', () => {
    /**
     * ⚠️ 交接文档线索 A 的推理是「slot 大时绕圈」——
     * 本用例证明**取模是对的**（不会 undefined），
     * 但**绕圈本身**会让两个相邻子代理看起来「撞号」（若 slot 间距 ≥ n）。
     *
     * 算式：`(0 + 1 + slot) % 3`
     * - slot=7 ⇒ `8 % 3 = 2` ⇒ `acc-c`
     * - slot=8 ⇒ `9 % 3 = 0` ⇒ `acc-a`
     *
     * ⚠️ 我第一版把 slot=7 写成 `acc-b`（漏算 base+1）—— **测试错，不是代码错**。
     */
    expect(startIndexOfSlot(tierIds, 'acc-a', 'sequence', 7, 's')).toBe('acc-c')
    expect(startIndexOfSlot(tierIds, 'acc-a', 'sequence', 8, 's')).toBe('acc-a')
  })

  it('★★ 基准不在序列里 ⇒ undefined（不猜）', () => {
    expect(startIndexOfSlot(tierIds, 'not-in-list', 'sequence', 0, 's')).toBeUndefined()
  })
})
