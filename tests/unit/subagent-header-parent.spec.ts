/**
 * ★★★ **路 1：从宿主会话头读父会话 id**（2026-11-24 上游第 3 轮审计建议）。
 *
 * ## 上游原话
 *
 * > 「这个功能现在卡在一个根本障碍上：**插件拿不到「谁是子代理、父是谁」**。
 * >   三条可能的路，按可行性排：
 * >   1. **从宿主会话头读**：`header.parentSession`（`dsh-session` types:76）
 * >      是**真的有**的 —— 如果能在 `agent/created` 或 pre-step 时读到
 * >      **当前会话的 header**，父 id 就有来源了。
 * >      这比 `subagent/start` payload 靠谱得多。
 * >   **我倾向于先确认路 1 可不可行。**」
 *
 * ## 为什么它比事件可靠
 *
 * | 来源 | 性质 | 失效窗口 |
 * |---|---|---|
 * | `subagent/start` 事件 | **瞬时** | 插件晚挂载 / 重启期间的事件**永远收不到** |
 * | **`session.header.parentSession`** | **持久** | 无 |
 *
 * ## 本文件守什么
 *
 * `credential-resolver` 的 `subagentParentForSession` 依赖必须是**第一来源**，
 * 事件表（`subagentParentOf`）只作兜底。
 *
 * ⚠️ 这几条是**行为级**的：直接给 resolver 一个假的会话头来源，
 *    断言「父 id 来自它」，而不是断言源码里有某个字符串。
 */
import { describe, expect, it } from 'vitest'

import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import { createCredentialResolver } from '../../src/credential-resolver.js'
import {
  forgetSubagentParent,
  rememberSubagentParent,
  subagentParentOf,
} from '../../src/subagent-rotation.js'

const PROVIDER = 'probe'
const DAY = 86_400_000
const PARENT = 'session-parent-from-header'
const CHILD = 'child-from-header'

const ENTRIES = [
  { id: 'acc-1', credentialRef: 'R1', enabled: true },
  { id: 'acc-2', credentialRef: 'R2', enabled: true },
  { id: 'acc-3', credentialRef: 'R3', enabled: true },
]

function makeEnv(options: {
  /** ⚠️ 路 1 的来源：真子代理返回父 id，主代理返回 undefined。 */
  headerParentOf: (sid: string) => string | undefined
  /** 故意让「事件表」为空，证明**只靠会话头**也能工作。 */
  startMode?: 'sequence' | 'follow'
}) {
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

  const recorded = []
  const pool = {
    listAccountsByProvider: () => ENTRIES,
    permanentLocked: () => false,
    strictManualOrder: () => false,
    getAvailableAccount: async () => null,
    /** 主代理起点 = acc-1 ⇒ sequence 会错开到 acc-2。 */
    preferredRotationFor: (_p, sid) => (sid === PARENT ? 'acc-1' : undefined),
    subagentRotationFor: () => ({ startMode: options.startMode ?? 'sequence' }),
    /** ⚠️ 分配记录初始为空（模拟「首轮请求」）—— 这正是路 1 要覆盖的窗口。 */
    subagentAssignmentOf: () => undefined,
    recordSubagentStart: async (provider, sid, parent) => { recorded.push({ provider, sid, parent }); return 0 },
    pinSubagentAccount: async () => false,
  }

  const resolver = createCredentialResolver(
    {
      pool,
      /** ★★★ **路 1 依赖**：这就是被测对象。 */
      subagentParentForSession: options.headerParentOf,
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
  return { resolver, recorded }
}

describe('路 1：父会话 id 从宿主会话头读', () => {
  it('★★★ 会话头能给出父 id 时，子代理会被正确识别并登记', async () => {
    /**
     * ⚠️ 关键：这里**事件表是空的**（进程内 `subagentParents` 没被填）。
     *
     * 上一版只判 `isSubagentSession(sessionId)`（事件表）⇒ 本场景**判定失败**
     * ⇒ 不登记 ⇒ 分配表恒空。
     *
     * 路 1 上线后：会话头有 `parentSession` ⇒ 判定成功 ⇒ 登记。
     */
    const { resolver, recorded } = makeEnv({
      headerParentOf: (sid) => (sid === CHILD ? PARENT : undefined),
    })

    await resolver('m', CHILD)

    expect(recorded.length, '★★★ 必须登记（上一版这里恒 0）').toBeGreaterThan(0)
    expect(recorded[0].sid).toBe(CHILD)
    expect(recorded[0].parent, '★★★ 父 id 必须来自会话头').toBe(PARENT)
  })

  it('★★★ 主代理（会话头无 parentSession）不登记', async () => {
    /** ⚠️ 纯回归面：主代理绝不能被当成子代理。 */
    const { resolver, recorded } = makeEnv({
      headerParentOf: () => undefined,
    })

    await resolver('m', PARENT)
    expect(recorded, '★★ 主代理不登记').toEqual([])
  })

  it('★★★ 会话头读不到时，退回既有事件表（不猜）', async () => {
    /**
     * ⚠️ 兜底必须保留：某些宿主版本 / 单测替身没有 `subagentParentForSession`。
     * 那时行为**与改动前逐字节相同**。
     */
    const { resolver, recorded } = makeEnv({ headerParentOf: () => undefined })
    await resolver('m', CHILD)
    expect(recorded, '★★ 两个来源都没有 ⇒ 不登记（宁丢弃不猜）').toEqual([])
  })

  it('★★★ 会话头来源优先于事件表（两边值不同时必须取会话头）', async () => {
    /**
     * ⚠️ **这条是我第一版没牙后重写的**（如实登记）。
     *
     * 第一版只断言「parent === PARENT」—— 而测试里**事件表是空的**，
     * 于是「会话头优先」与「事件表优先」**结果相同** ⇒ 变异 M2 无牙。
     *
     * ⇒ 必须**真往事件表里塞一个不同的父**（`rememberSubagentParent`），
     * 让两个来源分岔，才能区分优先级。
     */
    rememberSubagentParent(CHILD, 'session-from-event-table')
    expect(subagentParentOf(CHILD), '前提：事件表确实有这个 child').toBe('session-from-event-table')

    const { resolver, recorded } = makeEnv({
      headerParentOf: (sid) => (sid === CHILD ? PARENT : undefined),
    })
    await resolver('m', CHILD)

    expect(
      recorded[0]?.parent,
      '★★★ 必须是**会话头**给的那个 id（不是事件表里的 session-from-event-table）',
    ).toBe(PARENT)

    /** ⚠️ 清理，避免污染其它用例。 */
    forgetSubagentParent(CHILD)
  })
})
