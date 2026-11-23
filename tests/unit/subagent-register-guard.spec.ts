/**
 * ★★★ **只有真子代理才会被登记分配**（2026-11-23 本机实测打穿的真实缺陷）。
 *
 * ## 缺陷形态（实测数据）
 *
 * 上一版 `resolveCredential` 的登记判据是：
 *
 * ```ts
 * if (setting !== undefined && subagentSettingActive(setting) && sessionId !== undefined) {
 *   void deps.pool.recordSubagentStart?.(...)   // ← 任何会话都登记
 * }
 * ```
 *
 * **漏了「该会话是不是子代理」这道判据。**
 *
 * 实测后果（本机 `state.json`）：
 *
 * ```json
 * "session-b6fa9bbd-...": {
 *   "sessionId":       "session-b6fa9bbd-...",
 *   "parentSessionId": "session-b6fa9bbd-...",   // ← 自己当自己的父
 *   "slot": 0
 * }
 * ```
 *
 * **主代理把自己登记成「第 0 号子代理」** ⇒ 它的轮换起点被子代理策略覆盖
 * ⇒ 用户明明没配子代理，主代理却开始错开消耗。
 *
 * ## 为什么这个缺陷特别隐蔽
 *
 * - 不报错、不抛异常；
 * - 界面上「子代理设置」显示正常；
 * - 症状是「主代理悄悄换了号」—— 用户只会觉得「积分掉得莫名其妙」。
 *
 * ## 判据
 *
 * `isSubagentSession()` 查**父子表**，而父子表只由 `subagent/start` 写入
 *（宿主只在真的拉起子代理时发）。
 *
 * ⇒ 用**源码锚点 + 行为**双重固定：
 * 1. 源码里 `recordSubagentStart` 必须被 `isSubagentSession` 包住；
 * 2. 父子表的行为（主代理不在表里 ⇒ false）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  isSubagentSession,
  rememberSubagentParent,
  resetSubagentParentsForTest,
} from '../../src/subagent-rotation.js'

afterEach(() => { resetSubagentParentsForTest() })

describe('行为：主代理不在父子表里', () => {
  it('★★★ 未登记的会话**不是**子代理（主代理走这条）', () => {
    /**
     * 模拟实测场景：主代理 `session-b6fa9bbd` 从未收到 `subagent/start`
     * ⇒ 它**不该**被登记进分配表。
     */
    const mainSession = 'session-b6fa9bbd-0628-47a9-8714-6f0883a76abf'
    expect(isSubagentSession(mainSession), '主代理必须被判为「不是子代理」').toBe(false)
  })

  it('★★★ 真子代理（收到过 subagent/start）才被判为子代理', () => {
    rememberSubagentParent('child-1', 'main-1')
    expect(isSubagentSession('child-1')).toBe(true)
    expect(isSubagentSession('main-1'), '父会话仍不是子代理').toBe(false)
  })
})

describe('源码：登记必须被 isSubagentSession 守卫', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '../../src/credential-resolver.ts'), 'utf8')

  it('★★★ recordSubagentStart 必须被 isSubagentSession 包住', () => {
    /**
     * ⚠️ 判据不是「文件里有 isSubagentSession 字样」（那可能写在别处），
     * 而是「`recordSubagentStart` 调用点**之前**紧邻地出现 `isSubagentSession`」。
     */
    const callIdx = src.indexOf('recordSubagentStart?.(')
    expect(callIdx, '找不到 recordSubagentStart 调用').toBeGreaterThan(-1)

    /** 取调用点之前 1200 字符的窗口。 */
    const window = src.slice(Math.max(0, callIdx - 1200), callIdx)
    expect(
      window,
      '★★★ 调用点之前必须有 isSubagentSession 守卫（否则主代理也会被登记）',
    ).toContain('isSubagentSession(sessionId)')
  })

  it('★★★ 守卫必须在 `if` 条件里生效（不能只出现在注释中）', () => {
    /**
     * ⚠️ 上一版把判据写在**注释**里（「先确认它确实是子代理」），
     * 但代码没实现 —— 这正是本仓库反复记录的「注释写对了、代码没实现」形态。
     *
     * ⇒ 必须断言它是**展开的 if 语句**，不是注释里的文字。
     */
    const callIdx = src.indexOf('recordSubagentStart?.(')
    const window = src.slice(Math.max(0, callIdx - 400), callIdx)
    // 去掉注释行后再判
    const codeOnly = window
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')
    expect(
      codeOnly,
      '★★★ 守卫必须是真的 if 语句（不能只在注释里）',
    ).toMatch(/if\s*\(\s*isSubagentSession\(sessionId\)\s*\)/)
  })
})
