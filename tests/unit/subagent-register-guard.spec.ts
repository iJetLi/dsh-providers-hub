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
     * ⚠️ 2026-11-23 二次修订：守卫已从「单独的 `if (isSubagentSession(...))`」
     * 重构成**复合条件**（还要同时判 `setting !== undefined` /
     * `subagentSettingActive(setting)`）—— 因为登记必须**独立于**
     * 「免费模型」与「主代理起点」。
     *
     * ⇒ 判据：剥注释后，`recordSubagentStart` 调用点**之前 600 字符**内
     *   必须出现 `isSubagentSession(sessionId)`。
     *
     * ⚠️ 窗口取 600 是因为复合条件跨 4 行；取太小会漏掉。
     * ⚠️ 必须剥注释：本文件的注释里大量引用 `isSubagentSession` 字样。
     */
    const stripComments = (text: string): string =>
      text
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')

    const code = stripComments(src)
    const callIdx = code.indexOf('recordSubagentStart?.(')
    expect(callIdx, '剥注释后找不到 recordSubagentStart 调用').toBeGreaterThan(-1)

    const window = code.slice(Math.max(0, callIdx - 600), callIdx)
    expect(
      window,
      '★★★ 剥注释后调用点前必须有 isSubagentSession(sessionId)（不能只在注释里）',
    ).toContain('isSubagentSession(sessionId)')
  })

  it('★★★ 登记必须**独立于**「免费模型」与「主代理起点」两个条件', () => {
    /**
     * ## 这是 2026-11-23 本机实测发现的第二个缺陷
     *
     * 第一版把登记塞进了 `if (free !== true && baseRotationStartId !== undefined)`，
     * 导致两个**静默失效**：
     *
     * | 场景 | 后果 |
     * |---|---|
     * | 子代理用免费模型 | 永不登记（之后切付费也没记录）|
     * | 主代理没配起点 | 永不登记（配了子代理策略也不生效）|
     *
     * ## 判据（⚠️ 必须剥注释，否则会命中说明文字里的示例）
     *
     * 我第一版用 `src.indexOf('if (free !== true')` —— 那**命中了注释里
     * 引用的示例代码**（本文件的注释正是在讲这个缺陷），于是得出
     * 「登记在 free 之后」的错误结论。
     *
     * ⇒ 必须先剥掉注释行，再比**真实代码**里的先后顺序。
     */
    const stripComments = (text: string): string =>
      text
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')

    const code = stripComments(src)
    const callIdx = code.indexOf('recordSubagentStart?.(')
    const freeIdx = code.indexOf('if (free !== true && baseRotationStartId !== undefined)')
    expect(callIdx, '剥注释后找不到 recordSubagentStart 调用').toBeGreaterThan(-1)
    expect(freeIdx, '剥注释后找不到 free 条件').toBeGreaterThan(-1)
    expect(
      callIdx,
      '★★★ 登记必须在「free 条件」**之前**（否则免费模型永不登记）',
    ).toBeLessThan(freeIdx)
  })

  it('★★★ 登记所在的 `if` 必须是 `sessionId !== undefined`（不能是别的条件）', () => {
    /**
     * ## 为什么需要这条（我第一版漏了）
     *
     * 上一条只比**位置**（`callIdx < freeIdx`），于是把登记块的判断写成
     * `if (false)` / `if (true)` 时**照样全绿** —— 位置没变，但语义已坏：
     *
     * | 变异 | 后果 | 上一条能抓吗 |
     * |---|---|---|
     * | `if (false)` | 永不登记 | ❌ 不能（位置没变）|
     * | `if (true)` | 无条件进块（但内部还有守卫，等价）| ❌ 不能 |
     *
     * ⇒ 必须直接断言「那个 `if` 的条件文本就是 `sessionId !== undefined`」。
     */
    const stripComments = (text: string): string =>
      text
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')

    const code = stripComments(src)
    const callIdx = code.indexOf('recordSubagentStart?.(')
    expect(callIdx).toBeGreaterThan(-1)

    /** 取调用点之前 400 字符，找最近的那个 `if (`。 */
    const before = code.slice(Math.max(0, callIdx - 400), callIdx)
    const matches = [...before.matchAll(/if\s*\(([^)]*)\)\s*\{/g)]
    expect(matches.length, '调用点前必须有一个 if 块').toBeGreaterThan(0)
    const lastCond = matches[matches.length - 1][1].trim()
    expect(
      lastCond,
      '★★★ 最近的外层 if 条件必须是 `sessionId !== undefined`（不能是 false/true 之类）',
    ).toBe('sessionId !== undefined')
  })
})
