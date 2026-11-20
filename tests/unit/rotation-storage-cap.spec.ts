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
    const sessions = { s1: { position: 1, at: 1, tierAtSelection: 'imminent' }, s2: { position: 1, at: 2, tierAtSelection: 'imminent' } }
    expect(prunePreferredRotation(sessions, 5)).toEqual(sessions)
  })

  it('★ 超上限 ⇒ 保留 `at` 最大的那几个（丢掉最旧的）', () => {
    const sessions: Record<string, { position: number, at: number, tierAtSelection: 'imminent' | 'expiring' | 'permanent' }> = {}
    for (let i = 0; i < 10; i += 1) sessions[`s${i}`] = { position: 1, at: i, tierAtSelection: 'imminent' }
    const out = prunePreferredRotation(sessions, 3)
    // at 最大的是 s7/s8/s9
    expect(Object.keys(out).sort()).toEqual(['s7', 's8', 's9'])
  })

  it('★ 返回新对象，不改入参', () => {
    const sessions = { s1: { position: 1, at: 1, tierAtSelection: 'imminent' }, s2: { position: 1, at: 2, tierAtSelection: 'imminent' } }
    const out = prunePreferredRotation(sessions, 1)
    expect(sessions).toHaveProperty('s1') // 入参未变
    expect(out).not.toBe(sessions)
  })

  it('limit <= 0 ⇒ 空表（确定性，不是「全留」）', () => {
    const sessions = { s1: { position: 1, at: 1, tierAtSelection: 'imminent' } }
    expect(prunePreferredRotation(sessions, 0)).toEqual({})
    expect(prunePreferredRotation(sessions, -1)).toEqual({})
  })

  it('空表不炸', () => {
    expect(prunePreferredRotation({}, 5)).toEqual({})
  })

  it('★ sanitize 在**读取侧**也淘汰（老文档超上限时读进来就收敛）', () => {
    const raw: Record<string, unknown> = {}
    const sessions: Record<string, unknown> = {}
    for (let i = 0; i < 100; i += 1) sessions[`s${i}`] = { position: 1, at: i, tierAtSelection: 'imminent' }
    raw.p = sessions
    const out = sanitizePreferredRotation(raw)
    expect(Object.keys(out.p ?? {})).toHaveLength(64)
    // 保留的是 at 最大的 36..99
    expect(out.p?.['s99']).toEqual({ position: 1, at: 99, tierAtSelection: 'imminent' })
    expect(out.p?.['s0']).toBeUndefined()
  })
})

/**
 * ⚠️ **2026-11-20：原来这组「老格式兼容」用例已整块删除**。
 *
 * 用户决定「最彻底」：清除已选的起点，回归默认，等用户重新选。
 * ⇒ 三种旧形态（裸字符串 / 老对象 / 无档位的 position 对象）**全部丢弃**，
 * 相关兼容代码也已从 `sanitizePreferredRotation` 与 `preferredRotationFor` 删除。
 *
 * 新守卫比原来的「兼容并转换」更强：旧数据连进入缓存的机会都没有。
 */
describe('preferredRotation 旧格式一律丢弃（2026-11-20）', () => {
  it('★★★ 裸字符串（最老格式）⇒ 丢弃（不再补 at=0）', () => {
    expect(sanitizePreferredRotation({ p: { s: 'acc-1' } })).toEqual({})
  })

  it('★★★ 老对象 {accountId, at} ⇒ 丢弃', () => {
    expect(sanitizePreferredRotation({ p: { s: { accountId: 'acc-1', at: 1 } } })).toEqual({})
  })

  it('★★★ 无档位的 {position, at}（S5 格式）⇒ 丢弃', () => {
    expect(sanitizePreferredRotation({ p: { s: { position: 1, at: 1 } } })).toEqual({})
  })

  it('★★★ 新旧混存 ⇒ 只留新格式', () => {
    const out = sanitizePreferredRotation({
      p: {
        old: { accountId: 'acc-1', at: 1 },
        bare: 'acc-2',
        s5: { position: 3, at: 2 },
        new: { position: 4, at: 3, tierAtSelection: 'expiring' },
      },
    })
    expect(Object.keys(out.p ?? {})).toEqual(['new'])
    expect(out.p?.new).toEqual({ position: 4, at: 3, tierAtSelection: 'expiring' })
  })

  it('★★ 丢弃旧格式后若整层为空 ⇒ 连 provider 一起丢', () => {
    expect(sanitizePreferredRotation({ p: { s: 'acc-1' }, q: { s2: { accountId: 'x', at: 1 } } }))
      .toEqual({})
  })
})
describe('preferredRotation 脏数据', () => {
  it('顶层非对象 ⇒ 空表', () => {
    for (const bad of [undefined, null, 42, 'x', [], [1]]) {
      expect(sanitizePreferredRotation(bad)).toEqual({})
    }
  })

  it('provider 层非对象 ⇒ 跳过该 provider', () => {
    expect(sanitizePreferredRotation({ p: 42, q: { s: { position: 1, at: 1, tierAtSelection: 'imminent' } } })).toEqual({
      q: { s: { position: 1, at: 1, tierAtSelection: 'imminent' } },
    })
  })

  it('`at` 非法（NaN / 负数 / 字符串）⇒ 丢弃该条', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 'x', null]) {
      expect(sanitizePreferredRotation({ p: { s: { position: 1, at: bad, tierAtSelection: 'imminent' } } })).toEqual({})
    }
  })

  it('`accountId` 非法 ⇒ 丢弃该条（旧格式本就整条丢弃，此条仍成立）', () => {
    for (const bad of [undefined, '', 42, null, {}]) {
      expect(sanitizePreferredRotation({ p: { s: { accountId: bad, at: 1 } } })).toEqual({})
    }
  })

  it('清完为空 ⇒ 连 provider 层一起丢（不留空对象）', () => {
    // ⚠️ 必须用**会被丢弃**的条目：合法新格式会保留，那样用例恒假红。
    expect(sanitizePreferredRotation({ p: { s: 'legacy-bare-string' } })).toEqual({})
    expect(sanitizePreferredRotation({ p: { s: { position: 1, at: 1 } } })).toEqual({})
    expect(sanitizePreferredRotation({ p: { s: { position: 1, at: 1, tierAtSelection: 'imminent' } } }))
      .toEqual({ p: { s: { position: 1, at: 1, tierAtSelection: 'imminent' } } })
  })
})
