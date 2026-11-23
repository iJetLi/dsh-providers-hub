/**
 * ★★★ **钉住账号：拉起时定死，只有该号不可用才换**（2026-11-24 用户要求）。
 *
 * ## 用户原话与理由
 *
 * > 「我是希望『拉起时定死，只有该号不可用才换』，
 * >   这样可以保证子代理的缓存命中率高，如果频繁换帐号，缓存命中率就低了。」
 *
 * ⚠️ 这不是优化而是**正确性**：prompt cache 按（账号 + 模型 + 前缀）命中。
 * 每发请求重算起点 ⇒ 池子一波动就换号 ⇒ 缓存全失效 ⇒ 长上下文被重复计费。
 */
import { describe, expect, it } from 'vitest'

import {
  pinSubagentAccount,
  recordSubagentAssignment,
  sanitizeSubagentAssignments,
  type SubagentAssignmentMap,
} from '../../src/subagent-rotation.js'

/** 造一个「已登记」的分配表。 */
function seed(): SubagentAssignmentMap {
  return recordSubagentAssignment({}, 'child-1', 'main-1', 3, 1000)
}

describe('pinSubagentAccount：钉住与幂等', () => {
  it('★★★ 钉住后能在分配表里读到', () => {
    const out = pinSubagentAccount(seed(), 'child-1', 'acct-A', 2000)
    expect(out['child-1']!.pinnedAccountId).toBe('acct-A')
    expect(out['child-1']!.pinSetAt).toBe(2000)
  })

  it('★★★ **同账号重复钉 ⇒ 返回原对象**（调用方据此跳过写盘）', () => {
    /**
     * ⚠️ 这条最关键：稳态下**每发请求**都会调一次。
     * 若每次返回新对象 ⇒ 每次都写盘 ⇒ 每发请求多一次磁盘 I/O。
     */
    const first = pinSubagentAccount(seed(), 'child-1', 'acct-A', 2000)
    const second = pinSubagentAccount(first, 'child-1', 'acct-A', 3000)
    expect(second, '同值必须返回同一引用').toBe(first)
  })

  it('★★★ 换账号 ⇒ 更新且返回新对象', () => {
    const first = pinSubagentAccount(seed(), 'child-1', 'acct-A', 2000)
    const second = pinSubagentAccount(first, 'child-1', 'acct-B', 3000)
    expect(second).not.toBe(first)
    expect(second['child-1']!.pinnedAccountId).toBe('acct-B')
    expect(second['child-1']!.pinSetAt).toBe(3000)
  })

  it('★★ 不存在的 sessionId ⇒ 原样返回（不凭空造记录）', () => {
    const before = seed()
    expect(pinSubagentAccount(before, 'nope', 'acct-A', 2000)).toBe(before)
  })

  it('★★ 空 accountId ⇒ 原样返回（脏数据防御）', () => {
    const before = seed()
    expect(pinSubagentAccount(before, 'child-1', '', 2000)).toBe(before)
  })

  it('★★ 不覆盖 slot / at / sessionId / parentSessionId', () => {
    const out = pinSubagentAccount(seed(), 'child-1', 'acct-A', 2000)
    expect(out['child-1']!.slot, 'slot 不能变').toBe(3)
    expect(out['child-1']!.at, 'at 不能变（淘汰按它排序）').toBe(1000)
    expect(out['child-1']!.sessionId).toBe('child-1')
    expect(out['child-1']!.parentSessionId).toBe('main-1')
  })
})

describe('resume 必须保留 pin', () => {
  it('★★★ resume（重复 record）不清掉 pinnedAccountId', () => {
    /**
     * ⚠️ 用户要求「拉起时定死」。resume 是同一子代理**继续**跑，
     * 换号会让它的 prompt cache 全失效。
     */
    const pinned = pinSubagentAccount(seed(), 'child-1', 'acct-A', 2000)
    const resumed = recordSubagentAssignment(pinned, 'child-1', 'main-1', 99, 5000)
    expect(resumed['child-1']!.pinnedAccountId, 'resume 不能换号').toBe('acct-A')
    expect(resumed['child-1']!.pinSetAt).toBe(2000)
    expect(resumed['child-1']!.slot, 'resume 也不能换 slot').toBe(3)
  })

  it('★★ resume 会清掉 ended', () => {
    const pinned = pinSubagentAccount(seed(), 'child-1', 'acct-A', 2000)
    const ended = { ...pinned, 'child-1': { ...pinned['child-1']!, ended: true } }
    const resumed = recordSubagentAssignment(ended, 'child-1', 'main-1', 3, 5000)
    expect(resumed['child-1']!.ended).toBe(false)
  })
})

describe('sanitize 保留 pin', () => {
  it('★★★ 合法 pin 被保留', () => {
    const raw = {
      'child-1': {
        sessionId: 'child-1',
        parentSessionId: 'main-1',
        at: 1000,
        slot: 3,
        pinnedAccountId: 'acct-A',
        pinSetAt: 2000,
      },
    }
    const out = sanitizeSubagentAssignments(raw)
    expect(out['child-1']!.pinnedAccountId).toBe('acct-A')
    expect(out['child-1']!.pinSetAt).toBe(2000)
  })

  it('★★ 非法 pin（空串 / 非字符串）被丢弃', () => {
    for (const bad of ['', 123, null, {}]) {
      const raw = {
        'child-1': {
          sessionId: 'child-1',
          parentSessionId: 'main-1',
          at: 1000,
          slot: 3,
          pinnedAccountId: bad,
        },
      }
      expect(sanitizeSubagentAssignments(raw)['child-1']!.pinnedAccountId, String(bad)).toBeUndefined()
    }
  })

  it('★★ 有 pin 无 pinSetAt ⇒ pin 保留、pinSetAt 丢弃', () => {
    const raw = {
      'child-1': {
        sessionId: 'child-1',
        parentSessionId: 'main-1',
        at: 1000,
        slot: 3,
        pinnedAccountId: 'acct-A',
      },
    }
    const out = sanitizeSubagentAssignments(raw)
    expect(out['child-1']!.pinnedAccountId).toBe('acct-A')
    expect(out['child-1']!.pinSetAt).toBeUndefined()
  })

  it('★★ 老数据（无 pin 字段）⇒ 正常保留，不报错', () => {
    const raw = {
      'child-1': { sessionId: 'child-1', parentSessionId: 'main-1', at: 1000, slot: 3 },
    }
    const out = sanitizeSubagentAssignments(raw)
    expect(out['child-1']!.pinnedAccountId).toBeUndefined()
    expect(out['child-1']!.slot).toBe(3)
  })
})
