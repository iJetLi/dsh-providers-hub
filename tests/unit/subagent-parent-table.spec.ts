/**
 * 子代理父子表 + 事件接线的守卫。
 *
 * ## 为什么需要它
 *
 * 父子表是「某 sessionId 是不是子代理」的**唯一真源**。
 * 判据错了的后果是静默的：
 *
 * | 错法 | 后果 |
 * |---|---|
 * | 主代理被误判成子代理 | **主代理也开始错开**（用户没配却变了行为）|
 * | 子代理没被认出来 | 子代理退化成「用主代理起点」（功能看起来没生效）|
 *
 * 两者都不会报错，只会让用户觉得「设置没生效」或「设置乱生效」。
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  forgetSubagentParent,
  isSubagentSession,
  rememberSubagentParent,
  resetSubagentParentsForTest,
  subagentParentCount,
  subagentParentOf,
} from '../../src/subagent-rotation.js'

afterEach(() => { resetSubagentParentsForTest() })

describe('父子表：登记与查询', () => {
  it('★★★ 登记后能被认出是子代理', () => {
    rememberSubagentParent('child-1', 'main-1')
    expect(isSubagentSession('child-1')).toBe(true)
    expect(subagentParentOf('child-1')).toBe('main-1')
  })

  it('★★★ 未登记的 sessionId **不是**子代理（主代理走这条）', () => {
    rememberSubagentParent('child-1', 'main-1')
    expect(isSubagentSession('main-1'), '父会话本身不该被当成子代理').toBe(false)
    expect(isSubagentSession('other'), '无关会话更不该').toBe(false)
  })

  it('★★ 空 id 不登记（脏数据防御）', () => {
    rememberSubagentParent('', 'main-1')
    rememberSubagentParent('child-1', '')
    expect(subagentParentCount()).toBe(0)
  })

  it('★★ forget 后不再是子代理', () => {
    rememberSubagentParent('child-1', 'main-1')
    forgetSubagentParent('child-1')
    expect(isSubagentSession('child-1')).toBe(false)
  })

  it('★ forget 不存在的 id 无副作用', () => {
    rememberSubagentParent('child-1', 'main-1')
    forgetSubagentParent('nope')
    expect(subagentParentCount()).toBe(1)
  })
})

describe('父子表：容量上限', () => {
  it('★★★ 超过上限时按 FIFO 淘汰最旧的（不无限增长）', () => {
    /**
     * ⚠️ 上限是 `SUBAGENT_ASSIGNMENT_MAX`（128）。这里灌 200 条，
     * 断言「总数不超上限」且「最旧的被淘汰」。
     */
    for (let i = 0; i < 200; i += 1) {
      rememberSubagentParent(`child-${i}`, 'main')
    }
    expect(subagentParentCount(), '不能无限增长').toBeLessThanOrEqual(128)
    expect(isSubagentSession('child-0'), '最旧的应被淘汰').toBe(false)
    expect(isSubagentSession('child-199'), '最新的必须在').toBe(true)
  })

  it('★★ 淘汰后仍能查到窗口内的记录', () => {
    for (let i = 0; i < 200; i += 1) {
      rememberSubagentParent(`c-${i}`, 'main')
    }
    // 最后 128 条应都在
    expect(isSubagentSession('c-199')).toBe(true)
    expect(subagentParentOf('c-199')).toBe('main')
  })
})

describe('父子表：重复登记（resume 场景）', () => {
  it('★★★ 同一子代理重复登记 ⇒ 仍是一条（不重复计数）', () => {
    rememberSubagentParent('child-1', 'main-1')
    rememberSubagentParent('child-1', 'main-1')
    rememberSubagentParent('child-1', 'main-1')
    expect(subagentParentCount(), 'Map 语义保证不重复').toBe(1)
  })

  it('★ 重复登记会更新父会话（理论上父不会变，但防御）', () => {
    rememberSubagentParent('child-1', 'main-1')
    rememberSubagentParent('child-1', 'main-2')
    expect(subagentParentOf('child-1')).toBe('main-2')
  })
})
