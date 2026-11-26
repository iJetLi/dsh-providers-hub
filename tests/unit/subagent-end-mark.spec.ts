/**
 * ★★★ **`subagent/end` 必须真的标记分配为「已结束」**（2026-11-24 修复）。
 *
 * ## 缺陷形态
 *
 * 上一版 `subagent/end` 的监听器里**只有注释、没有调用**：
 *
 * ```ts
 * const stopEnd = injected.on('subagent/end', (info) => {
 *   forgetSubagentParent(childId)
 *   +-- (只有一行注释，点名了 markSubagentEnded，但**没有调用**）
 * ```
 *
 * ⇒ `recordSubagentEnd()` 定义了却**零调用点**（死代码），
 * 实测 `state.json` 里 `ended` **永远是 `false`**。
 *
 * ⚠️ 这正是本仓反复记录的「**注释承诺了、代码没实现**」形态 ——
 * 注释里点名了 `markSubagentEnded`，读代码时极易以为已经调了。
 *
 * ## 为什么需要反查 provider
 *
 * `subagent/end` 的 payload **只有 `id`**（子代理会话 id），**没有 provider**；
 * 而 `recordSubagentEnd(provider, sessionId)` 需要它
 * ⇒ 必须有 `providersOfSubagentSession()` 反查。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  markSubagentEnded,
  recordSubagentAssignment,
  type SubagentAssignmentMap,
} from '../../src/subagent-rotation.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSrc = readFileSync(join(here, '../../src/index.ts'), 'utf8')
const poolSrc = readFileSync(join(here, '../../src/account-pool.ts'), 'utf8')

const stripComments = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n')

// ============================================================================
// 行为：markSubagentEnded 的纯函数语义
// ============================================================================
describe('markSubagentEnded：标记已结束', () => {
  const seed = (): SubagentAssignmentMap => recordSubagentAssignment({}, 'child-1', 'main-1', 2, 1000)

  it('★★★ 标记后 ended 变 true', () => {
    const out = markSubagentEnded(seed(), 'child-1')
    expect(out['child-1']!.ended).toBe(true)
  })

  it('★★★ **不清除记录**（resume 要用原 slot）', () => {
    const out = markSubagentEnded(seed(), 'child-1')
    expect(out['child-1'], '记录必须保留').toBeDefined()
    expect(out['child-1']!.slot, 'slot 不能丢').toBe(2)
    expect(out['child-1']!.at, 'at 不能变（淘汰按它排序）').toBe(1000)
  })

  it('★★★ 不存在的 sessionId ⇒ 返回原对象（不凭空造）', () => {
    const before = seed()
    expect(markSubagentEnded(before, 'nope')).toBe(before)
  })
})

// ============================================================================
// 接线：`subagent/end` 必须**真的调用** recordSubagentEnd
// ============================================================================
describe('接线：subagent/end 必须调用 recordSubagentEnd', () => {
  const code = stripComments(indexSrc)

  it('★★★ 监听器里必须出现 recordSubagentEnd 的**调用**', () => {
    /**
     * ⚠️ 判据不能是「文件里出现过 `recordSubagentEnd`」——
     * 注释里点了 `markSubagentEnded`、别处也可能提到，删掉调用照样绿。
     *
     * ⇒ 必须断言 **`subagent/end` 的监听器体内**有 `.recordSubagentEnd(` 调用。
     */
    const start = code.indexOf("on('subagent/end'")
    expect(start, '找不到 subagent/end 监听器').toBeGreaterThan(-1)
    /** 监听器以 `}) as never)` 收尾。 */
    const end = code.indexOf('}) as never)', start)
    expect(end, '找不到监听器结尾').toBeGreaterThan(start)
    const body = code.slice(start, end)

    expect(
      body,
      '★★★ 必须调用 recordSubagentEnd（否则 ended 永远 false，就是本次修的缺陷）',
    ).toMatch(/\.recordSubagentEnd\.?\(/)
  })

  it('★★★ 必须先反查 provider（事件 payload 里没有 provider）', () => {
    const start = code.indexOf("on('subagent/end'")
    const end = code.indexOf('}) as never)', start)
    const body = code.slice(start, end)
    expect(
      body,
      '★★★ 必须用 providersOfSubagentSession 反查（payload 只有 id）',
    ).toContain('providersOfSubagentSession')
  })

  it('★★★ 必须遍历**全部**匹配的 provider（不漏标）', () => {
    /**
     * ⚠️ 同一 sessionId 可能在多家各有一条记录 ⇒ 只标第一个会留下
     * 「永远显示未结束」的记录。
     */
    const start = code.indexOf("on('subagent/end'")
    const end = code.indexOf('}) as never)', start)
    const body = code.slice(start, end)
    /**
     * ⚠️ 判据不能只是「有 for...of」—— 变异「`.slice(0, 1)` 只用第一个」
     * 时那串正则照样命中（我第一版就这么漏的）。
     *
     * ⇒ 必须断言遍历的是**完整返回值**（后面不能跟 `.slice` / `[0]` 之类截断）。
     */
    expect(body, '★★★ 必须是 for...of 遍历').toMatch(/for \(const \w+ of pool\.providersOfSubagentSession\(childId\)\)/)
    expect(
      body,
      '★★★ 不能截断（slice/[0] 会漏标同 sessionId 在其它 provider 的记录）',
    ).not.toMatch(/providersOfSubagentSession\(childId\)\.(slice|\.\.\.|[\[])/)
  })

  it('★★★ 必须 fire-and-forget（不能让事件监听器等磁盘）', () => {
    const start = code.indexOf("on('subagent/end'")
    const end = code.indexOf('}) as never)', start)
    const body = code.slice(start, end)
    expect(body, '★★★ 必须 void 掉，不能 await').toMatch(/void pool\.recordSubagentEnd/)
    expect(body, '★★★ 不能 await（事件监听器不能阻塞）').not.toContain('await pool.recordSubagentEnd')
  })

  it('★★★ 失败必须被吞掉（监听器不能上抛）', () => {
    const start = code.indexOf("on('subagent/end'")
    const end = code.indexOf('}) as never)', start)
    const body = code.slice(start, end)
    expect(body, '★★★ 必须有 .catch 兜住').toMatch(/\.recordSubagentEnd[\s\S]{0,200}\.catch\(/)
  })
})

describe('AccountPool.providersOfSubagentSession', () => {
  it('★★★ 方法必须存在且返回数组', () => {
    expect(poolSrc, '找不到该方法').toContain('providersOfSubagentSession(sessionId: string): string[]')
  })

  it('★★★ 必须遍历全部 provider 键（反查靠遍历）', () => {
    const idx = poolSrc.indexOf('providersOfSubagentSession(sessionId: string): string[]')
    const block = poolSrc.slice(idx, idx + 900)
    expect(block, '★★★ 必须遍历 subagentAssignmentCache').toContain('Object.entries(this.subagentAssignmentCache)')
  })

  it('★★ 空 sessionId ⇒ 立即返回空数组（不遍历）', () => {
    const idx = poolSrc.indexOf('providersOfSubagentSession(sessionId: string): string[]')
    const block = poolSrc.slice(idx, idx + 400)
    expect(block).toContain('return []')
  })
})
