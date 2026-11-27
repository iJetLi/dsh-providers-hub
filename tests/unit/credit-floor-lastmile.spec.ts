/**
 * ★★★ **「最后一米」接线守卫**（2026-11-27，PR #183 审结后重写）
 *
 * ## 这一版修的是上一版的两个真实弱点（上游两审实测）
 *
 * | 弱点 | 实测症状 | 本版修法 |
 * |---|---|---|
 * | **锚定脆弱** | `site2` 的 600 字符窗口**只剩 13 字符余量**，插一行注释就假红 | **不再用固定窗口**，改为按**调用括号配对**截取实参 |
 * | **结构性漏掉第三处** | `sumAvailableCredits` 有 **2 个**调用点（胶囊 + 弹窗），旧守卫只配了 `value?.accounts` 那处 | **遍历全部调用点**，逐处断言 |
 *
 * ## ⚠️ 强度如实登记（上游原话）
 *
 * > 「PR 补的那 4 条守卫是源码文本，**0 条真跑**……把
 * >  `imminentFloor: value?.imminentFloor` **原地注释掉**……**仍 4 passed**」
 *
 * ⇒ 源码文本**挡不住 `if (false)` 死分支**。
 *
 * ⚠️ **本文件刻意不假装能挡住**。真正的保护来自：
 * - `tests/unit/usage-badge-floor-passthrough.spec.ts`（上游补的**行为级**：
 *   调真函数看返回值，加 `if(false)` 会红）；
 * - 本文件负责的是**另一个维度**：**「调用点有没有漏」**
 *（上游那 4 条也无法发现「第三处漏接线」）。
 *
 * ⇒ 两者**互补**，不是替代。本文件的价值是**穷举调用点**，
 *   而这恰恰是行为级用例做不到的（它只测被它调用的那一处）。
 *
 * ## 为什么只能做源码断言
 *
 * `usage-badge.js` 顶部 `import * as React` ⇒ 单测 import 不进来
 *（react 是 esbuild external，本仓 `node_modules` 没有）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '../../plugin-src/client')

const usageBadge = readFileSync(join(SRC, 'usage-badge.js'), 'utf8')

/**
 * ★ **按括号配对截取「某函数调用」的完整实参**（不再用固定字符窗口）。
 *
 * ⚠️ 上一版用 `slice(at, at + 600)` ⇒ 上游实测：
 *   `site2` 的 `expiringFloor` 落在**第 573 字符**，余量仅 **13 字符**
 *   ⇒ 任何人插一行注释就**假红**。
 *
 * 本函数从调用名的 `(` 开始，数括号深度直到配对结束 ⇒ **与内容长度无关**。
 *
 * @returns 实参文本（不含最外层括号）；找不到 ⇒ `''`
 */
function callArgsOf(source: string, callee: string): string[] {
  const results: string[] = []
  /** ⚠️ 必须用 `callee(` 匹配，避免命中注释里的 `callee()` 说明。 */
  const needle = callee + '('
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at < 0) break
    /**
     * ⚠️ 跳过**注释里**的出现：往前找最近的 `//` / `*` 行首特征，
     * 若该行是注释行就跳过 —— 否则会被文档说明误导（本仓反复踩过）。
     */
    const lineStart = source.lastIndexOf('\n', at) + 1
    const linePrefix = source.slice(lineStart, at)
    if (/^\s*(\*|\/\/|\/\*)/.test(linePrefix)) {
      from = at + needle.length
      continue
    }
    /** 从 `(` 起数括号配对。 */
    let depth = 0
    let i = at + callee.length
    const begin = i + 1
    for (; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    results.push(source.slice(begin, i))
    from = i + 1
  }
  return results
}

/** 去掉 `//` 与 `/* *\/` 注释，避免「注释里的字段」被当成真接线。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('★★★ 最后一米：`sumAvailableCredits` 的**每一个**调用点都必须带两个阈值', () => {
  const calls = callArgsOf(usageBadge, 'sumAvailableCredits')

  it('★★ 必须先确认「调用点数量」—— 数量变了则本守卫需同步更新', () => {
    /**
     * ⚠️⚠️ **这是本文件最重要的断言**。
     *
     * 上一版只锚定 `sumAvailableCredits(value?.accounts,{` ⇒
     * **弹窗那处（实参是 `accounts`）被结构性排除**，于是：
     *
     * | 位置 | 可用积分（临期 5 / 阈值 20）|
     * |---|---|
     * | 胶囊 | **0** ✅ |
     * | **弹窗** | **5** 🚨 渲染「可用 5 积分」数字骗人 |
     *
     * ⇒ 用 `toEqual(2)` 把「新增/删除调用点」也变成必须显式确认的事件。
     */
    expect(
      calls.length,
      '★★★ sumAvailableCredits 的调用点数变了：新增一处必须同步补阈值（否则那处静默失效）',
    ).toBe(2)
  })

  it('★★★ 两处都必须带 `imminentFloor` 与 `expiringFloor`', () => {
    calls.forEach((args, i) => {
      const code = stripComments(args)
      expect(
        code,
        `★★★ 第 ${i + 1} 处调用缺 imminentFloor ⇒ 该处「可用积分」把已降档的部分也算进去`,
      ).toContain('imminentFloor:')
      expect(
        code,
        `★★★ 第 ${i + 1} 处调用缺 expiringFloor`,
      ).toContain('expiringFloor:')
    })
  })

  it('★★★ 两处都必须**真的从 `value` 取**（防写死 0 = 语法满足但功能关闭）', () => {
    calls.forEach((args, i) => {
      expect(
        stripComments(args),
        `★★★ 第 ${i + 1} 处必须从 value 取阈值（写死 0 等于关闭功能）`,
      ).toMatch(/imminentFloor:\s*value\?\.imminentFloor/)
    })
  })
})

describe('★★★ 最后一米：`creditOrderOptionsOf` 的**每一个**调用点', () => {
  const calls = callArgsOf(usageBadge, 'creditOrderOptionsOf')

  it('★★ 必须先确认调用点数量', () => {
    expect(calls.length, '★★ creditOrderOptionsOf 调用点数变了：请同步补阈值').toBe(1)
  })

  it('★★★ 必须带两个阈值，且从 `value` 取', () => {
    const code = stripComments(calls[0] ?? '')
    expect(code, '★★★ 漏传 ⇒ 弹窗排序 / 分组按 `> 0` 判档 ⇒ 与后端选号分叉').toContain('imminentFloor:')
    expect(code, '★★★ 同上').toContain('expiringFloor:')
    expect(code, '★★★ 必须从 value 取').toMatch(/imminentFloor:\s*value\?\.imminentFloor/)
  })
})

describe('★★★ 反向：不得出现「只传一个」的半接线形态', () => {
  it('★★ 每处调用的两个阈值必须成对', () => {
    /**
     * ⚠️ 与 `credit-window-rpc-contract.spec.ts` 的「两个天数必须成对回传」**同型**：
     * 只给一半会让一半按新口径、一半按旧口径 ⇒ 界面自相矛盾。
     */
    const all = [
      ...callArgsOf(usageBadge, 'sumAvailableCredits'),
      ...callArgsOf(usageBadge, 'creditOrderOptionsOf'),
    ]
    all.forEach((args, i) => {
      const code = stripComments(args)
      const hasImminent = code.includes('imminentFloor:')
      const hasExpiring = code.includes('expiringFloor:')
      expect(
        hasImminent,
        `★★ 第 ${i + 1} 处：两个阈值必须成对（imminentFloor=${hasImminent} expiringFloor=${hasExpiring}）`,
      ).toBe(hasExpiring)
    })
  })
})
