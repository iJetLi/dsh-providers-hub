/**
 * 子代理起点分配的**纯函数**守卫。
 *
 * ## 为什么这块必须重点测
 *
 * 它决定「烧哪个号的积分」—— 判据错了会**静默消耗用户的积分**，
 * 而且用户很难察觉（只会觉得「某个号怎么突然没积分了」）。
 *
 * ## 用户的明确要求（2026-11-23）
 *
 * > 「子代理在分配帐号起点时，肯定也要像主代理一样，遵守档次优先的原则呀
 * >   （而且也要遵守锁定永久的原则）」
 *
 * ⇒ 所有策略都**只在同一档位内错开**，绝不跨档位。
 */
import { describe, expect, it } from 'vitest'

import {
  accountIdAtPosition,
  hashString,
  markSubagentEnded,
  nextSubagentSlot,
  pruneSubagentAssignments,
  recordSubagentAssignment,
  sanitizeSubagentAssignments,
  startIndexOfSlot,
  subagentSettingActive,
  SUBAGENT_ASSIGNMENT_MAX,
  type SubagentAssignmentMap,
} from '../../src/subagent-rotation.js'

/** 一套典型的「临期档」序列（按策略序，最急的在前）。 */
const TIER = ['a1', 'a2', 'a3', 'a4'] as const
const MAIN = 'a1'

describe('startIndexOfSlot：follow', () => {
  it('★★ 与主代理同号（不管 slot 多少）', () => {
    for (const slot of [0, 1, 5, 99]) {
      expect(startIndexOfSlot(TIER, MAIN, 'follow', slot, 'sub-x')).toBe(MAIN)
    }
  })
})

describe('startIndexOfSlot：sequence（同档位内往后）', () => {
  it('★★★ slot=0 取主代理的**下一个**（不撞主代理）', () => {
    expect(startIndexOfSlot(TIER, MAIN, 'sequence', 0, 's')).toBe('a2')
  })

  it('★★★ 依次往后：a2 → a3 → a4 → 绕回 a1', () => {
    expect(startIndexOfSlot(TIER, MAIN, 'sequence', 0, 's')).toBe('a2')
    expect(startIndexOfSlot(TIER, MAIN, 'sequence', 1, 's')).toBe('a3')
    expect(startIndexOfSlot(TIER, MAIN, 'sequence', 2, 's')).toBe('a4')
    // 4 个账号 ⇒ 第 4 个子代理才绕回主代理自己
    expect(startIndexOfSlot(TIER, MAIN, 'sequence', 3, 's')).toBe('a1')
    expect(startIndexOfSlot(TIER, MAIN, 'sequence', 4, 's')).toBe('a2')
  })

  it('★★ 主代理起点在中间时也正确（不是只对第一个有效）', () => {
    // 主代理用 a2 ⇒ 顺序应是 a3, a4, a1, a2
    expect(startIndexOfSlot(TIER, 'a2', 'sequence', 0, 's')).toBe('a3')
    expect(startIndexOfSlot(TIER, 'a2', 'sequence', 1, 's')).toBe('a4')
    expect(startIndexOfSlot(TIER, 'a2', 'sequence', 2, 's')).toBe('a1')
  })

  it('★ 单账号档位 ⇒ 只能撞自己', () => {
    expect(startIndexOfSlot(['only'], 'only', 'sequence', 0, 's')).toBe('only')
  })
})

describe('startIndexOfSlot：reverse（同档位内往前）', () => {
  it('★★★ slot=0 取主代理的**前一个**', () => {
    // 主代理 a1 在数组首位 ⇒ 往前绕回 a4
    expect(startIndexOfSlot(TIER, MAIN, 'reverse', 0, 's')).toBe('a4')
  })

  it('★★★ 依次往前：a4 → a3 → a2 → 绕回 a1', () => {
    expect(startIndexOfSlot(TIER, MAIN, 'reverse', 0, 's')).toBe('a4')
    expect(startIndexOfSlot(TIER, MAIN, 'reverse', 1, 's')).toBe('a3')
    expect(startIndexOfSlot(TIER, MAIN, 'reverse', 2, 's')).toBe('a2')
    expect(startIndexOfSlot(TIER, MAIN, 'reverse', 3, 's')).toBe('a1')
  })

  it('★★ 中间起点也正确', () => {
    // 主代理 a3 ⇒ 倒序 a2, a1, a4, a3
    expect(startIndexOfSlot(TIER, 'a3', 'reverse', 0, 's')).toBe('a2')
    expect(startIndexOfSlot(TIER, 'a3', 'reverse', 1, 's')).toBe('a1')
    expect(startIndexOfSlot(TIER, 'a3', 'reverse', 2, 's')).toBe('a4')
  })

  it('★★ 负下标取模必须修正（不能返回 undefined）', () => {
    const out = startIndexOfSlot(TIER, 'a1', 'reverse', 0, 's')
    expect(out, '不能是 undefined').toBeDefined()
    expect(TIER, '必须是档位内的账号').toContain(out)
  })
})

describe('startIndexOfSlot：hash（稳定且不撞主代理）', () => {
  it('★★★ 同一 sessionId 永远同一结果（多次调用稳定）', () => {
    const first = startIndexOfSlot(TIER, MAIN, 'hash', 0, 'session-abcdef')
    for (let i = 0; i < 5; i += 1) {
      expect(startIndexOfSlot(TIER, MAIN, 'hash', 0, 'session-abcdef')).toBe(first)
    }
  })

  it('★★★ **永不等于主代理起点**（排除后取模）', () => {
    for (let i = 0; i < 30; i += 1) {
      const out = startIndexOfSlot(TIER, MAIN, 'hash', 0, `session-${i}`)
      expect(out, `session-${i} 不该撞主代理 ${MAIN}`).not.toBe(MAIN)
      expect(TIER).toContain(out)
    }
  })

  it('★★ 不同 sessionId 会落到不同账号（有分散性）', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 30; i += 1) {
      seen.add(String(startIndexOfSlot(TIER, MAIN, 'hash', 0, `s-${i}`)))
    }
    expect(seen.size, '30 个不同会话应覆盖多个账号').toBeGreaterThan(1)
  })

  it('★ 档位只剩主代理一个 ⇒ 只能撞它（无其他选择）', () => {
    expect(startIndexOfSlot(['only'], 'only', 'hash', 0, 's')).toBe('only')
  })
})

describe('startIndexOfSlot：fixed 与非法输入', () => {
  it('★★ fixed 不走档位序列（返回 undefined，由外层按位次取）', () => {
    expect(startIndexOfSlot(TIER, MAIN, 'fixed', 0, 's')).toBeUndefined()
  })

  it('★★★ 主代理起点不在该档位 ⇒ undefined（不猜下标 0）', () => {
    expect(startIndexOfSlot(TIER, 'not-in-tier', 'sequence', 0, 's')).toBeUndefined()
    expect(startIndexOfSlot(TIER, 'not-in-tier', 'reverse', 0, 's')).toBeUndefined()
    /**
     * ⚠️ hash 同样返回 undefined：它也要「排除主代理」，而主代理不在这里
     * ⇒ 无从判断该排除谁。
     */
    expect(startIndexOfSlot(TIER, 'not-in-tier', 'hash', 0, 's')).toBeUndefined()
  })

  it('★★ 空档位 ⇒ undefined', () => {
    expect(startIndexOfSlot([], MAIN, 'sequence', 0, 's')).toBeUndefined()
  })
})

describe('hashString：确定性', () => {
  it('★ 同输入同输出，不同输入不同输出（抽样）', () => {
    expect(hashString('abc')).toBe(hashString('abc'))
    expect(hashString('abc')).not.toBe(hashString('abd'))
  })

  it('★ 结果是非负 32 位整数', () => {
    for (const s of ['', 'a', 'session-0', '中文', 'x'.repeat(200)]) {
      const h = hashString(s)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xFFFFFFFF)
    }
  })
})

describe('accountIdAtPosition：fixed 按位次取号', () => {
  const POOL = ['p1', 'p2', 'p3']

  it('★ 1-based 位次', () => {
    expect(accountIdAtPosition(POOL, 1)).toBe('p1')
    expect(accountIdAtPosition(POOL, 3)).toBe('p3')
  })

  it('★★★ 越界 ⇒ undefined（不静默取最后一个）', () => {
    expect(accountIdAtPosition(POOL, 4)).toBeUndefined()
    expect(accountIdAtPosition(POOL, 99)).toBeUndefined()
  })

  it('★★ 非法位次 ⇒ undefined', () => {
    expect(accountIdAtPosition(POOL, 0)).toBeUndefined()
    expect(accountIdAtPosition(POOL, -1)).toBeUndefined()
    expect(accountIdAtPosition(POOL, 1.5)).toBeUndefined()
    expect(accountIdAtPosition(POOL, undefined)).toBeUndefined()
  })
})

describe('分配表：记录 / 幂等 / 淘汰', () => {
  const empty: SubagentAssignmentMap = {}

  it('★★★ 首次记录分配 slot=0', () => {
    const m = recordSubagentAssignment(empty, 'sub-1', 'main', 0, 1000)
    expect(m['sub-1']).toEqual({ sessionId: 'sub-1', parentSessionId: 'main', at: 1000, slot: 0 })
  })

  it('★★★ 同一 sessionId 再次记录 ⇒ **保留原 slot**（resume 场景）', () => {
    let m = recordSubagentAssignment(empty, 'sub-1', 'main', 0, 1000)
    // resume 时宿主会再发一次 subagent/start，此时 nextSlot 已经变成 5
    m = recordSubagentAssignment(m, 'sub-1', 'main', 5, 2000)
    expect(m['sub-1']!.slot, '不能改成 5').toBe(0)
    expect(m['sub-1']!.at, '保留原时刻').toBe(1000)
  })

  it('★★ resume 会清掉 ended 标记', () => {
    let m = recordSubagentAssignment(empty, 'sub-1', 'main', 0, 1000)
    m = markSubagentEnded(m, 'sub-1')
    expect(m['sub-1']!.ended).toBe(true)
    m = recordSubagentAssignment(m, 'sub-1', 'main', 1, 2000)
    expect(m['sub-1']!.ended).toBe(false)
  })

  it('★★★ nextSubagentSlot 单调递增（淘汰后不回退）', () => {
    let m = recordSubagentAssignment(empty, 'sub-1', 'main', 0, 1000)
    expect(nextSubagentSlot(m)).toBe(1)
    m = recordSubagentAssignment(m, 'sub-2', 'main', 1, 2000)
    expect(nextSubagentSlot(m)).toBe(2)
    /**
     * ⚠️ 关键：即使淘汰掉了旧的，也不能回退到 0
     *（否则多个子代理会拿到同一 slot ⇒ 挤同一个账号）。
     */
    const pruned = pruneSubagentAssignments(m, 1)
    expect(Object.keys(pruned).length).toBe(1)
    expect(nextSubagentSlot(pruned), '淘汰后序号仍单调').toBe(2)
  })

  it('★ markSubagentEnded 对不存在的 sessionId 无副作用', () => {
    expect(markSubagentEnded(empty, 'nope')).toBe(empty)
  })

  it('★★ 淘汰保留最新（at 大的）', () => {
    let m: SubagentAssignmentMap = {}
    for (let i = 0; i < 5; i += 1) {
      m = recordSubagentAssignment(m, `s${i}`, 'main', i, 1000 + i)
    }
    const pruned = pruneSubagentAssignments(m, 2)
    expect(Object.keys(pruned).sort()).toEqual(['s3', 's4'])
  })

  it('★ 默认上限是 128', () => {
    expect(SUBAGENT_ASSIGNMENT_MAX).toBe(128)
  })
})

describe('sanitizeSubagentAssignments：脏数据一律丢弃', () => {
  it('★★ 缺任一必需字段 ⇒ 丢弃', () => {
    const raw = {
      good: { sessionId: 'good', parentSessionId: 'main', at: 1, slot: 0 },
      noParent: { sessionId: 'noParent', at: 1, slot: 0 },
      noAt: { sessionId: 'noAt', parentSessionId: 'main', slot: 0 },
      noSlot: { sessionId: 'noSlot', parentSessionId: 'main', at: 1 },
      badSlot: { sessionId: 'badSlot', parentSessionId: 'main', at: 1, slot: -1 },
    }
    const out = sanitizeSubagentAssignments(raw)
    expect(Object.keys(out)).toEqual(['good'])
  })

  it('★★ 非对象 / 数组 ⇒ 空表', () => {
    expect(sanitizeSubagentAssignments(null)).toEqual({})
    expect(sanitizeSubagentAssignments([])).toEqual({})
    expect(sanitizeSubagentAssignments('x')).toEqual({})
  })

  it('★ ended 只有 `true` 才保留', () => {
    const out = sanitizeSubagentAssignments({
      a: { sessionId: 'a', parentSessionId: 'm', at: 1, slot: 0, ended: true },
      b: { sessionId: 'b', parentSessionId: 'm', at: 1, slot: 1, ended: 'yes' },
    })
    expect(out['a']!.ended).toBe(true)
    expect(out['b']!.ended).toBeUndefined()
  })
})

describe('subagentSettingActive：何时进入子代理分支', () => {
  it('★★ 未配置 ⇒ 不启用（与加功能前逐字节相同）', () => {
    expect(subagentSettingActive(undefined)).toBe(false)
  })

  it('★★★ follow + 无模型 ⇒ 不启用（等价于没配）', () => {
    expect(subagentSettingActive({ startMode: 'follow' })).toBe(false)
  })

  it('★★ follow + 有模型 ⇒ 启用（只换模型不换号）', () => {
    expect(subagentSettingActive({ startMode: 'follow', model: 'glm-5.3' })).toBe(true)
  })

  it('★★ 非 follow 模式 ⇒ 启用', () => {
    for (const mode of ['sequence', 'reverse', 'hash', 'fixed'] as const) {
      expect(subagentSettingActive({ startMode: mode }), mode).toBe(true)
    }
  })
})
