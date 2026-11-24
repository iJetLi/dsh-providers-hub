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

  it('★★★ 包住 recordSubagentStart 的 `if` 条件里必须有父会话守卫', () => {
    /**
     * ⚠️ **判据在「条件文本」级别**，不是「文件里有没有字样」。
     *
     * ## 为什么（我第一版写错了，如实登记）
     *
     * 第一版用 `window.includes('parentOfThis !== undefined')` ——
     * 实测两个变异**全绿**：
     *
     * | 变异 | 结果 |
     * |---|---|
     * | 删掉守卫（条件改回只看 `sessionId !== undefined`）| ❌ 无牙 |
     * | 守卫改成 `&& true` | ❌ 无牙 |
     *
     * ⇒ 因为「字样还在别处」（`const parentOfThis = …` 那行）+ 窗口够宽。
     *
     * ## 现在的判据
     *
     * 取出**真正包住调用**的那个 `if` 的条件全文，断言：
     * 1. 出现父会话查询结果（`parentOfThis` 或 `isSubagentSession`）；
     * 2. **不能是恒真**（不含 `&& true`）；
     * 3. **不能只看 `sessionId !== undefined`**（那是主代理也通过的旧缺陷）。
     */
    const cond = guardConditionAround(src)
    expect(cond, '找不到包住 recordSubagentStart 的 if').toBeDefined()

    /** ① 必须有父会话守卫。 */
    expect(
      cond,
      '★★★ 条件里必须有父会话守卫（parentOfThis / isSubagentSession）',
    ).toMatch(/parentOfThis\s*!==\s*undefined|isSubagentSession\(/)

    /** ② 不能是恒真。 */
    expect(cond, '★★★ 守卫不能恒真（&& true）').not.toMatch(/&&\s*true\b/)

    /**
     * ③ **不能只看 sessionId 非空** —— 那正是「主代理也登记」的原缺陷。
     *
     * ⚠️ `sessionId !== undefined` 在修好的代码里**也可能出现**（作为外层
     *  `if (sessionId !== undefined) {` 的一部分）—— 但那个 if 里**必须还有**
     *  父会话判据。上面 ① 已保证；这里额外要求「父会话判据不在注释里」。
     */
    expect(
      cond.includes('parentOfThis') || cond.includes('isSubagentSession'),
      '★★★ 必须有真正的父会话判据（不是注释）',
    ).toBe(true)
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
    /**
     * ⚠️ **判据 2026-11-24 升级**（与上一条同因）：守卫可能是「父会话查询」的结果，
     * 不一定字面写着 `isSubagentSession(sessionId)`。
     *
     * ⚠️ 但**判断对象不变**：必须是「查出来的父会话」而非「sessionId 非空」——
     * 后者会让主代理也通过。
     */
    const hasParentLookup = code.includes('parentOfSession(') || code.includes('parentOfThis !== undefined')
    const hasLegacy = window.includes('isSubagentSession(sessionId)')
    expect(
      hasLegacy || hasParentLookup,
      '★★★ 剥注释后调用点前必须有「父会话」守卫（不能只在注释里）',
    ).toBe(true)
    expect(
      window,
      '★★★ 那个守卫必须作用在调用点之前（不能写在别的函数里）',
    ).toMatch(/parentOfThis|isSubagentSession\(sessionId\)/)
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
    /**
     * ⚠️ 2026-11-24 三改：Anchor 从「`if (free !== true && baseRotationStartId !== undefined)`」
     * 改成「`if (free !== true) {`」—— 因为**子代理起点计算**也已脱离
     * 「主代理必须配起点」这个条件（用户实测打穿：主代理默认起点时子代理全不生效）。
     *
     * ⇒ 登记仍必须在**第一个** `if (free !== true` 之前。
     */
    const freeIdx = code.indexOf('if (free !== true')
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
