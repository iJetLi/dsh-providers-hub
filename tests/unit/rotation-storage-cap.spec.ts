/**
 * 「轮换起点」存储层的容量上限与向后兼容（提 PR 前审计发现的两个问题）。
 *
 * ## 问题 1：表会**无限增长**（P1）
 *
 * 键是 `sessionId`，而用户**每开一个新会话**就可能选一次起点
 * ⇒ 表随会话数单调增长且永不回收。`state.json` 是**整体读入内存**的，
 * 无限增长最终会拖慢每次读写。
 *
 * 修法：记 `at`（写入时刻）并按 provider 淘汰最旧的，上限 64。
 *
 * ## 问题 2：老格式会**静默丢失**（P1）
 *
 * 本功能最早一版写的是裸字符串 `{ provider: { session: 'accountId' } }`，
 * 后来的 `{ accountId, at }` 若不兼容旧格式，升级用户的选择会**无声消失**。
 * 本仓反复记录过这类「静默丢用户数据」形态，故必须兼容。
 */
import { describe, expect, it } from 'vitest'
import {
  PREFERRED_ROTATION_MAX_SESSIONS,
  prunePreferredRotation,
  sanitizePreferredRotation,
} from '../../src/jet-hub-store.js'

describe('preferredRotation 容量上限', () => {
  it('上限是 64（写死在常量里，不得浮动）', () => {
    expect(PREFERRED_ROTATION_MAX_SESSIONS).toBe(64)
  })

  it('未超上限 ⇒ 全部保留', () => {
    const sessions = { s1: { accountId: 'a', at: 1 }, s2: { accountId: 'b', at: 2 } }
    expect(prunePreferredRotation(sessions, 5)).toEqual(sessions)
  })

  it('★ 超上限 ⇒ 保留 `at` 最大的那几个（丢掉最旧的）', () => {
    const sessions: Record<string, { accountId: string, at: number }> = {}
    for (let i = 0; i < 10; i += 1) sessions[`s${i}`] = { accountId: 'a', at: i }
    const out = prunePreferredRotation(sessions, 3)
    // at 最大的是 s7/s8/s9
    expect(Object.keys(out).sort()).toEqual(['s7', 's8', 's9'])
  })

  it('★ 返回新对象，不改入参', () => {
    const sessions = { s1: { accountId: 'a', at: 1 }, s2: { accountId: 'b', at: 2 } }
    const out = prunePreferredRotation(sessions, 1)
    expect(sessions).toHaveProperty('s1') // 入参未变
    expect(out).not.toBe(sessions)
  })

  it('limit <= 0 ⇒ 空表（确定性，不是「全留」）', () => {
    const sessions = { s1: { accountId: 'a', at: 1 } }
    expect(prunePreferredRotation(sessions, 0)).toEqual({})
    expect(prunePreferredRotation(sessions, -1)).toEqual({})
  })

  it('空表不炸', () => {
    expect(prunePreferredRotation({}, 5)).toEqual({})
  })

  it('★ sanitize 在**读取侧**也淘汰（老文档超上限时读进来就收敛）', () => {
    const raw: Record<string, unknown> = {}
    const sessions: Record<string, unknown> = {}
    for (let i = 0; i < 100; i += 1) sessions[`s${i}`] = { accountId: 'a', at: i }
    raw.p = sessions
    const out = sanitizePreferredRotation(raw)
    expect(Object.keys(out.p ?? {})).toHaveLength(64)
    // 保留的是 at 最大的 36..99
    expect(out.p?.['s99']).toEqual({ accountId: 'a', at: 99 })
    expect(out.p?.['s0']).toBeUndefined()
  })
})

describe('preferredRotation 老格式兼容', () => {
  it('★★ 裸字符串（老格式）⇒ 接收并补 `at = 0`', () => {
    const out = sanitizePreferredRotation({ qodercn: { 'session-abc': 'qodercn-c5a414d5' } })
    expect(out.qodercn?.['session-abc']).toEqual({ accountId: 'qodercn-c5a414d5', at: 0 })
  })

  it('★ 老格式与新格式混存 ⇒ 都接受', () => {
    const out = sanitizePreferredRotation({
      p: {
        old: 'acc-1',
        new: { accountId: 'acc-2', at: 123 },
      },
    })
    expect(out.p?.old).toEqual({ accountId: 'acc-1', at: 0 })
    expect(out.p?.new).toEqual({ accountId: 'acc-2', at: 123 })
  })

  it('老格式空串 ⇒ 丢弃（不是「有效账号」）', () => {
    expect(sanitizePreferredRotation({ p: { s: '' } })).toEqual({})
  })

  it('★ 老格式的 `at = 0` 让它在淘汰时**最先**被丢（符合直觉）', () => {
    const raw: Record<string, unknown> = { p: {} }
    const sessions = raw.p as Record<string, unknown>
    sessions.legacy = 'old-acc' // at = 0
    for (let i = 0; i < 70; i += 1) sessions[`s${i}`] = { accountId: 'a', at: 1000 + i }
    const out = sanitizePreferredRotation(raw)
    expect(Object.keys(out.p ?? {})).toHaveLength(64)
    expect(out.p?.legacy).toBeUndefined() // 最旧的被丢
  })
})

describe('preferredRotation 脏数据', () => {
  it('顶层非对象 ⇒ 空表', () => {
    for (const bad of [undefined, null, 42, 'x', [], [1]]) {
      expect(sanitizePreferredRotation(bad)).toEqual({})
    }
  })

  it('provider 层非对象 ⇒ 跳过该 provider', () => {
    expect(sanitizePreferredRotation({ p: 42, q: { s: { accountId: 'a', at: 1 } } })).toEqual({
      q: { s: { accountId: 'a', at: 1 } },
    })
  })

  it('`at` 非法（NaN / 负数 / 字符串）⇒ 丢弃该条', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 'x', null]) {
      expect(sanitizePreferredRotation({ p: { s: { accountId: 'a', at: bad } } })).toEqual({})
    }
  })

  it('`accountId` 非法 ⇒ 丢弃该条', () => {
    for (const bad of [undefined, '', 42, null, {}]) {
      expect(sanitizePreferredRotation({ p: { s: { accountId: bad, at: 1 } } })).toEqual({})
    }
  })

  it('清完为空 ⇒ 连 provider 层一起丢（不留空对象）', () => {
    expect(sanitizePreferredRotation({ p: { s: { accountId: '', at: 1 } } })).toEqual({})
  })
})
