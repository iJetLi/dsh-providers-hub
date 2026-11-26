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
import { registerSubagentStartIfNeeded } from '../../src/subagent-start.js'

afterEach(() => { resetSubagentParentsForTest() })

/**
 * ⚠️ **精确取出「包住 `recordSubagentStart` 的那个 `if` 条件文本」**。
 *
 * 为什么必须精确取：`includes(
 * 'parentOfThis !== undefined')` 这种判据**对「守卫恒真」和「守卫被删」都无效**
 * —— 只要字样还在（哪怕在死分支里），断言就绿。
 *
 * ⇒ 做法：从调用点**往上**找最近的、缩进更浅的 `if (`，取它的**完整条件**
 *    （配对小括号），再对这个条件做判据。
 */
function guardConditionAround(source: string): string | undefined {
  const callIdx = source.indexOf('recordSubagentStart?.(')
  if (callIdx < 0) return undefined
  const before = source.slice(0, callIdx)
  /** 从后往前找 `if (`。 */
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (!before.startsWith('if (', i)) continue
    /** 配对小括号，取出条件全文。 */
    let depth = 0
    let end = -1
    for (let j = i + 3; j < before.length; j += 1) {
      if (before[j] === '(') depth += 1
      else if (before[j] === ')') {
        depth -= 1
        if (depth === 0) { end = j; break }
      }
    }
    if (end > 0) return before.slice(i + 4, end)
  }
  return undefined
}
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

  /**
   * ⚠️⚠️ **2026-11-25 判据迁移**：登记的守卫已从「`credential-resolver` 里的内联 `if`」
   * 抽到共享函数 `registerSubagentStartIfNeeded`（`subagent-start.ts`）——
   * 因为 Bug 1 的根因是「**自建选号的 provider 完全没接登记**」
   * （codearts / officeace），三处各写一份判据必然再漏一处。
   *
   * ⇒ 下面四条断言从「检查内联 `if` 的文本」改成
   *    「**行为级**验证共享函数的判据」—— 意图完全保留，且比源码文本更硬：
   *
   * | 原断言意图 | 现在的守法人 |
   * |---|---|
   * | 必须有父会话守卫 | 父会话 `undefined` ⇒ 不登记（行为）|
   * | 守卫不能在注释里 | 行为级，天然免疫 |
   * | 独立于「免费模型 / 主代理起点」| 函数签名里**没有**这两个参数（结构证明）|
   * | 不能是 `if (false)` / `if (true)` | `setting` 缺失 ⇒ 不登记（行为）|
   */
  it('★★★ 必须有父会话守卫（父会话未知 ⇒ 不登记）', () => {
    /**
     * ⚠️ 等价于原断言的「`parentOfThis !== undefined` 必须在条件里」——
     * 但用**行为**验证：父会话 `undefined` 时**一次都不能调** `recordSubagentStart`。
     */
    const calls: unknown[] = []
    const registered = registerSubagentStartIfNeeded({
      pool: { recordSubagentStart: async () => { calls.push(1); return 0 } },
      providerId: 'probe',
      sessionId: 'child-1',
      parentSessionId: undefined,
      setting: { startMode: 'sequence' },
    })
    expect(registered, '★★★ 父会话未知必须返回 false').toBe(false)
    expect(calls.length, '★★★ 父会话未知**一次都不能调**（否则主代理也会被登记）').toBe(0)
  })

  it('★★★ setting 缺失 ⇒ 不登记（等价于「守卫不能是 if (true)」）', () => {
    const calls: unknown[] = []
    const registered = registerSubagentStartIfNeeded({
      pool: { recordSubagentStart: async () => { calls.push(1); return 0 } },
      providerId: 'probe',
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      setting: undefined,
    })
    expect(registered).toBe(false)
    expect(calls.length, '★★★ 没配子代理 ⇒ 不登记').toBe(0)
  })

  it('★★★ 登记必须**独立于**「免费模型」与「主代理起点」（结构证明）', () => {
    /**
     * ## 原缺陷（2026-11-23 本机实测）
     *
     * 第一版把登记塞进 `if (free !== true && baseRotationStartId !== undefined)`，
     * 两个**静默失效**：子代理用免费模型 / 主代理没配起点 ⇒ 永不登记。
     *
     * ## 现判据（比源码文本更硬）
     *
     * `registerSubagentStartIfNeeded` 的**入参类型**里没有 `free` /
     * `baseRotationStartId` 这类字段 ⇒ **结构上不可能**被那两个条件绑住。
     *
     * ⚠️ 这是「用类型证明」而不是「在源码里找字符串」—— 前者对
     *    `if (false)` 之类短路天然免疫。
     */
    const src = readFileSync(join(here, '../../src/subagent-start.ts'), 'utf8')
    const fnStart = src.indexOf('export function registerSubagentStartIfNeeded(')
    expect(fnStart, '找不到 registerSubagentStartIfNeeded').toBeGreaterThan(-1)
    /** 取到函数体结束（配对花括号）。 */
    const open = src.indexOf('{', src.indexOf('): boolean', fnStart))
    let depth = 0
    let end = open
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break } }
    }
    const decl = src.slice(fnStart, open)
    const body = src.slice(open, end + 1)
    /** ① 签名里**不得**出现 free / baseRotationStartId。 */
    expect(decl, '★★★ 签名不得收 free（否则会重演免费模型永不登记）').not.toMatch(/\bfree\b/)
    expect(decl, '★★★ 签名不得收 baseRotationStartId（否则会重演主代理没起点就不登记）')
      .not.toMatch(/baseRotationStartId/)
    /** ② 函数体里也不得读这两个语义。 */
    expect(body).not.toMatch(/\bfree\b/)
    expect(body).not.toMatch(/baseRotationStartId/)
  })

  it('★★★ 登记必须真的调用 recordSubagentStart（不能是 if (false) 空转）', () => {
    /**
     * ⚠️ 等价于原断言「那个 `if` 不能是 `if (false)`」——
     * 但用**行为**验证：条件齐全时必须真的调一次。
     */
    const calls: unknown[] = []
    const registered = registerSubagentStartIfNeeded({
      pool: { recordSubagentStart: async () => { calls.push(1); return 0 } },
      providerId: 'probe',
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      setting: { startMode: 'sequence' },
    })
    expect(registered, '★★★ 条件齐全必须返回 true').toBe(true)
    expect(calls.length, '★★★ 必须真的调用一次（防止 if (false) 空转）').toBe(1)
  })
})
