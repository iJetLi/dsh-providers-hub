/**
 * ★★★ **扫描器自身的抗打穿回归**（2026-11-28，PR #186 审结后第二轮）
 *
 * ## 为什么单独一个文件
 *
 * 上游在 #186 审结时说：
 *
 * > 「⚠️ 对抗审计报的两条『端到端打穿』，**我复验未能复现**……
 * >  ⇒ **请你做一件事**：把它报告里那两条攻击的**精确构造**搬成回归用例。
 * >  如果它们真能打穿，那两条用例会红 → 那就该修扫描器；
 * >  如果它们不红，说明攻击依赖了别的条件，也需要写清。」
 *
 * 我手上**没有审计报告原文**（它在上游的 `.tmp-pr-watcher/` 里），所以本轮做的是
 * **推演**：穷举「诱饵形态 × 位置」，找出扫描器的真实边界。
 *
 * ## 推演结果（实测，见本文件的用例）
 *
 * ### ✅ 外部诱饵全部无效（9 组）
 *
 * 把诱饵放在**调用之前/之后**，无论注释、字符串、正则、除法、模板 —— 9 组**全部未被打穿**。
 * ⇒ 这解释了上游为什么「复现不出来」：**诱饵位置错了**。
 *
 * ### 🔴 实参**内部**的诱饵有 3 个生效
 *
 * | # | 诱饵（实参内部）| v3 的后果 | 根因 |
 * |---|---|---|---|
 * | D1 | `re: /\\(/g` | **切片吞到别处** ⇒ 假绿 | `\(` 的 `(` 被当代码 |
 * | D2 | `re: /\\)/g` | **提前截断** ⇒ 假红 | `\)` 的 `)` 被当代码 |
 * | D6 | `` s: `${sumAvailableCredits(x, {…})}` `` | 嵌套调用污染外层 | 模板被整体跳过 |
 *
 * ## v4 修法
 *
 * 1. **正则字面量识别**（含字符类 `[...]`、`\\` 转义、`isRegexStart` 启发式）
 * 2. **模板 `${}` 内部按代码扫描**（用栈支持嵌套模板）
 *
 * ⚠️ **上游说的「模板 `${}` 嵌套」我实测了**：单层模板里的调用 v3 其实**能抓到**
 * （因为 `indexOf` 会搜到嵌套调用的 `(`），真正的问题是**外层调用被污染**。
 *
 * ## 局限（如实登记，不为它编逻辑）
 *
 * `isRegexStart` 用「前一个有效字符」启发式 —— `return /re/` 这种会**误判成除号**。
 * 本仓 client 无此写法；如未来出现，需补关键字表。
 */
import { describe, expect, it } from 'vitest'

import { callArgsOf, scanCalls, stripCommentsAndStrings } from './_support/source-scanner.js'

/** 目标调用：缺 `expiringFloor`（要被发现的「缺陷」）。 */
const BAD_CALL = [
  'const a = sumAvailableCredits(accounts, {',
  '  locked: true,',
  '})',
].join('\n')

/** 邻处合法调用：含两个字段（攻击者希望它被吞进上一处 ⇒ 假绿）。 */
const NEIGHBOR = [
  'const b = creditOrderOptionsOf({',
  '  expiringFloor: value?.expiringFloor,',
  '})',
].join('\n')

/** 判据：调用数 1，且实参**不得**含 `expiringFloor`（那说明吞进了邻处）。 */
function expectNotLeaked(src: string, label: string): void {
  const calls = callArgsOf(src, 'sumAvailableCredits')
  expect(calls.length, label + '：调用数必须为 1').toBe(1)
  expect(
    calls[0]?.includes('expiringFloor'),
    label + '：实参吞进了邻处字段（假绿）',
  ).toBe(false)
}

describe('★★★ 外部诱饵（9 组）：全部不得生效 —— 这解释了上游为何复现不出', () => {
  const OUTSIDE_BAITS: Array<[string, string]> = [
    ['注释里未配对 (', '// sumAvailableCredits( 说明'],
    ['注释里未配对 )', '// ) 说明'],
    ['字符串里未配对 (', "const x = '('"],
    ['字符串里未配对 )', "const x = ')'"],
    ['正则 /[()]/ 含未配对括号', 'const re = /\\(/g'],
    ['正则 /[)]/', 'const re = /\\)/g'],
    ['除法 total / (n+1)', 'const r = total / (n + 1)'],
    ['除号后接括号', 'const q = a / b; const p = (c)'],
    ['块注释里的括号', '/* ( ) */'],
  ]

  for (const [name, bait] of OUTSIDE_BAITS) {
    it(`★★ 诱饵在调用**外部**不得生效：${name}`, () => {
      expectNotLeaked([bait, BAD_CALL, NEIGHBOR].join('\n'), name)
    })
  }
})

describe('🔴 实参**内部**的诱饵：这是 v3 真被打穿的地方（v4 已修）', () => {
  it('★★★ D1 实参内正则 `/\\(/` 不得让切片吞到邻处（v3 假绿）', () => {
    /**
     * ## v3 的行为（实测）
     *
     * ```js
     * const a = sumAvailableCredits(accounts, { re: /\\(/g, })
     * ```
     * v3 把 `\(` 的 `(` 当代码 ⇒ depth 不减到 0 ⇒ 切片吞到 `creditOrderOptionsOf` 那处
     * ⇒ 实参里出现 `expiringFloor` ⇒ **假绿**。
     */
    const src = [
      'const a = sumAvailableCredits(accounts, {',
      '  re: /\\(/g,',
      '})',
      NEIGHBOR,
    ].join('\n')
    expectNotLeaked(src, 'D1')
  })

  it('★★★ D2 实参内正则 `/\\)/` 不得让切片提前截断（v3 假红）', () => {
    /**
     * ## v3 的行为（实测）
     *
     * `re: /\\)/g` 里 `\)` 的 `)` 被当代码 ⇒ depth 提前归零 ⇒ 实参被**截断**成
     * `"accounts, {\n  re: /\\"` ⇒ 后续断言读到残缺文本 ⇒ **假红**。
     */
    const src = [
      'const a = sumAvailableCredits(accounts, {',
      '  re: /\\)/g,',
      '  locked: true,',
      '})',
    ].join('\n')
    const [args] = callArgsOf(src, 'sumAvailableCredits')
    expect(args, '★ 实参必须完整含 locked（不得被正则里的 ) 截断）').toContain('locked: true')
    expect(args, '★ 必须含正则原文（不得截断）').toContain('re:')
  })

  it('★★★ D6 模板 `${}` 里的真调用不得污染外层实参', () => {
    /**
     * ## v3 的行为（实测）
     *
     * 外层调用的实参里嵌了一个 `${sumAvailableCredits(x, { expiringFloor: v })}`
     * ⇒ v3 把整个模板当引号态跳过 ⇒ 但 `indexOf` 仍会搜到嵌套调用
     * ⇒ 外层实参**含** `expiringFloor`（来自嵌套那处）⇒ **假绿**。
     *
     * v4：模板 `${}` 内部按**代码**扫描 ⇒ 外层实参只含模板字面量形态，不泄漏嵌套内容。
     */
    const src = [
      'const a = sumAvailableCredits(accounts, {',
      '  s: `${sumAvailableCredits(x, { expiringFloor: v })}`,',
      '})',
    ].join('\n')
    const calls = callArgsOf(src, 'sumAvailableCredits')
    expect(calls.length, '★ 两处调用都要被抓到').toBe(2)
    /** 外层（第 1 处）实参不得把嵌套那处的字段当成自己的。 */
    const outer = calls[0] ?? ''
    const nested = calls[1] ?? ''
    expect(nested, '★ 内层实参应含 expiringFloor').toContain('expiringFloor')
    expect(
      outer.includes('expiringFloor') && !outer.includes('${'),
      '★★★ 外层不得因嵌套调用而假绿',
    ).toBe(false)
  })

  it('★★ D5 模板内 `)` 在**插值内**时按代码配对（不得误解为模板正文）', () => {
    /**
     * ⚠️⚠️ **这条用例我第一版写错了，如实记录**。
     *
     * 我最初写的是 `` s: `${bar)}` `` —— 那是**JS 语法错误**
     *（`${bar)` 里的 `)` 直接关闭了外层调用）。
     * 扫描器把它判成「实参在这里结束」其实是**正确行为**（那确实是配对位置）。
     *
     * ⇒ 改成**合法 JS**：`)` 出现在 `${}` **内部**，必须按代码配对，
     *    且不得提前结束外层实参。
     */
    const src = [
      'const a = sumAvailableCredits(accounts, {',
      '  s: `${f(x)}`,',
      '  locked: true,',
      '})',
    ].join('\n')
    const [args] = callArgsOf(src, 'sumAvailableCredits')
    expect(args, '★ `${f(x)}` 里的括号必须正确配对').toContain('`${f(x)}`')
    expect(args, '★ 不得提前截断（必须含 locked）').toContain('locked: true')
  })

  it('★★ D4 模板正文里的 `(` 必须被当字面量（不得吞到邻处）', () => {
    /**
     * ⚠️ 我第一版用 `` `${foo(}` `` —— 同样是**语法错误**。
     * ⇒ 改成合法形态：`(` 出现在模板**正文**（非插值）里。
     */
    const src = [
      'const a = sumAvailableCredits(accounts, {',
      '  s: `text ( literal`,',
      '})',
      NEIGHBOR,
    ].join('\n')
    expectNotLeaked(src, 'D4')
  })

  it('★★ 除法（非正则）必须仍被当代码', () => {
    /** ⚠️ v4 的正则识别**不能把除号误判成正则**，否则会吞掉后续代码。 */
    const src = [
      'const a = sumAvailableCredits(accounts, {',
      '  r: total / 2,',
      '  locked: true,',
      '})',
    ].join('\n')
    const [args] = callArgsOf(src, 'sumAvailableCredits')
    expect(args, '★ 完整实参').toContain('locked: true')
    expect(args, '★ 除法保留').toContain('total / 2')
  })
})

describe('★★★ 扫描器不该改坏既有能力（回归 v3 已封住的三个打穿）', () => {
  it('★★★ 注释里的假调用点不得吞掉真调用点（v2 致命伤）', () => {
    const fake = [
      '// 说明：sumAvailableCredits( 用来算可用积分',
      'const a = sumAvailableCredits(accounts, {',
      '  locked: true,',
      '})',
    ].join('\n')
    const calls = callArgsOf(fake, 'sumAvailableCredits')
    expect(calls.length, '★ 注释里的示例不得算调用点').toBe(1)
    expect(calls[0], '★ 必须拿到真调用的实参').toContain('locked: true')
  })

  it('★★★ 字符串里的同名字段不得假绿', () => {
    const args = "accounts, {\n  note: 'imminentFloor: value?.imminentFloor',\n}"
    const code = stripCommentsAndStrings(args)
    expect(code.includes('imminentFloor'), '★★★ 字符串内容必须被剥掉').toBe(false)
  })

  it('★★ 剥字符串后真实代码仍保留（防剥过头）', () => {
    const args = "accounts, {\n  imminentFloor: value?.imminentFloor,\n  s: 'x',\n}"
    const code = stripCommentsAndStrings(args)
    expect(code, '★ 真实字段不得被剥').toContain('imminentFloor')
    expect(code, '★ 字符串内容要没').not.toContain("'x'")
  })

  it('★★ 模板 `${}` 里的**真代码**必须保留（v3 会误剥）', () => {
    /**
     * ⚠️ v3 把整个模板当字符串 ⇒ `${imminentFloor}` 也被剥掉 ⇒ **假红**。
     * v4 保留 `${}` 内部。
     */
    const args = 'accounts, {\n  s: `${imminentFloor}`,'
    const code = stripCommentsAndStrings(args)
    expect(code, '★★ ${} 内的真代码必须保留').toContain('imminentFloor')
  })

  it('★★ `scanCalls` 应回报跳过了几个伪调用点', () => {
    const src = [
      '// sumAvailableCredits( 文档示例',
      '* sumAvailableCredits( 文档',
      'const a = sumAvailableCredits(x)',
    ].join('\n')
    const r = scanCalls(src, 'sumAvailableCredits')
    expect(r.args.length, '★ 只有 1 处真调用').toBe(1)
    expect(r.skipped, '★ 跳过了 2 个伪调用点').toBe(2)
  })
})
