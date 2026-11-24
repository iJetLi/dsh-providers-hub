/**
 * ★★★ **`resolveSubagentParent` 必须用 `ctx.get('agents')`，不能 `ctx.agents`**
 * （2026-11-24，PR #151 第四轮对抗审计 P0）。
 *
 * ## 缺陷
 *
 * `agents` **不在本插件的静态 `inject` 里**（`inject = ['credentials','commands','llm']`）。
 * cordis 4.1 对**未注入的服务**走属性访问会抛
 * `cannot get property "agents" without inject`，而那个 `catch` 把它吞成 `undefined`
 * ⇒ **父 id 恒 `undefined`** ⇒ `isSubagentSession` 恒 `false` ⇒ **分配表恒 `{}`**
 * ⇒ 子代理起点 / `pin` / 用户手选 / badge **全部静默失效**。
 *
 * 审计用宿主那份 cordis 逐字复刻验证：
 *
 * | 读法 | 结果 |
 * |---|---|
 * | `(ctx as any).agents` | **`undefined`**（JSON 里那个键直接消失）|
 * | `ctx.get('agents')` | **`'parent-9'`** ✅ |
 *
 * ## 本文件只给**派生式**守卫
 *
 * ⚠️ **行为级守卫缺**（如实登记）：`resolveSubagentParent` 是 `index.ts` 里的局部闭包，
 * 不导出 ⇒ 无法直接调用。行为级守卫需要把它抽成独立模块（下一轮）。
 *
 * ⚠️ 但**派生式**在这里够用：它的失效形态是**一个精确字符串**
 *（`}).agents` vs `ctx.get('agents')`），不是「语义可能漂移」的那种。
 *
 * 本仓红线提醒：源码文本断言有假绿（`if (false)` 短路等）⇒
 * 所以本文件同时断言「**必须出现的形态**」与「**必须消失的形态**」**两条腿**。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../../src/index.ts'), 'utf8')

/**
 * ⚠️ **必须先剥注释再断言**：`resolveSubagentParent` 上面那段长注释**正是在讲
 * 「不能 `ctx.agents`」**（引用了旧形态）⇒ 不剥注释的话，反例断言会**命中注释**
 * 而假红（本仓 `catalog-disk-wiring.spec.ts` 有同一条惯例）。
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

/** 取出 `resolveSubagentParent` 的**已剥注释**函数体。 */
function resolveBody(): string {
  const stripped = stripComments(src)
  const start = stripped.indexOf('const resolveSubagentParent')
  expect(start, '找不到 resolveSubagentParent 声明').toBeGreaterThanOrEqual(0)
  const tail = stripped.slice(start)
  const end = tail.indexOf('\n  }\n')
  return end < 0 ? tail.slice(0, 4000) : tail.slice(0, end + 4)
}

describe('resolveSubagentParent 的读法（PR #151 第四轮 P0）', () => {
  it('★★★ 必须用 `ctx.get(\'agents\')`', () => {
    expect(resolveBody(), '必须惰性取 agents 服务').toContain("ctx.get('agents')")
  })

  it('★★★ 不得再用属性访问 `}).agents`（cordis 会抛 without inject）', () => {
    // 旧形态：`(ctx as unknown as { agents?: … }).agents`
    expect(resolveBody()).not.toContain('}).agents')
    // 也别写成裸的 `ctx.agents`
    expect(resolveBody()).not.toMatch(/\bctx\.agents\b/)
  })

  it('★★ 必须读 `session.header.parentSession`（不是 `session.parentSession`）', () => {
    const body = resolveBody()
    expect(body).toContain('parentSession')
    // 探针实测 `session.parentSession` 直接读是 undefined
    expect(body).toMatch(/header/)
  })

  it('★★ 拿不到时返回 undefined（绝不猜）', () => {
    expect(resolveBody()).toContain('return undefined')
  })
})
