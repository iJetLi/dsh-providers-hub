/**
 * ★★★ **「最后一米」接线守卫**（2026-11-28 重写第 3 版）
 *
 * ## 版本史（每一版都是被审计打穿后改的，如实登记）
 *
 * | 版本 | 手段 | 被打穿的方式 |
 * |---|---|---|
 * | v1 | 固定字符窗口 `slice(at, at+600)` | 插一行注释 ⇒ **假红**（余量仅 13 字符）|
 * | v2 | 只数 `(` / `)` | 注释里未配对 `(` ⇒ 切片**越界到 93,876 字符**；未配对 `)` ⇒ 截断 31 字符 **假红** |
 * | **v3（本版）** | **跳过字符串/注释的真扫描** + 剥字符串 | — |
 *
 * ## v2 的决定性打穿（上游实测，最该看）
 *
 * > **弹窗那处真删两个阈值**（对照：不加注释 ⇒ 2 failed）
 * > **加一条行尾注释**写 `sumAvailableCredits(` ⇒ **6 passed**
 *
 * 机制：注释里那个假调用点的切片**吞到文件尾**，把真弹窗调用点跳过；
 * `count` 仍 = 2，而吞进来的第三处字段**替它过关**。
 *
 * ⇒ 扫描器已抽到 `_support/source-scanner.ts`，与
 *   `coverage-floor-args.spec.ts` **共用同一份实现**（本仓红线：同一语义不得两套）。
 *
 * ## ⚠️ 强度边界（不假装）
 *
 * 这是**文本级**守卫：
 * - ✅ 挡得住：整段删、半接线、写死 `0`、注释/字符串伪装、调用点增减
 * - ❌ 挡不住：把调用包进 `if (false)` —— 那只由**行为级**用例负责
 *   （`credit-floor-pure.spec.ts` / `usage-badge-floor-passthrough.spec.ts`）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { callArgsOf, stripCommentsAndStrings } from './_support/source-scanner.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '../../plugin-src/client')

const usageBadge = readFileSync(join(SRC, 'usage-badge.js'), 'utf8')

describe('★★★ `sumAvailableCredits` 的**每一个**调用点都必须带两个阈值', () => {
  const calls = callArgsOf(usageBadge, 'sumAvailableCredits')

  it('★★★ 调用点数量必须恰好 2（新增/删除都该被显式确认）', () => {
    /**
     * ⚠️⚠️ **这是本文件最重要的一条**（v1/v2 都在这条上翻过车）。
     *
     * `sumAvailableCredits` 有 2 个调用点：
     *
     * | 位置 | 实参 | v1 守卫 |
     * |---|---|---|
     * | 胶囊 | `value?.accounts` | ✅ 锚定了 |
     * | **弹窗** | `accounts` | ❌ **被结构性排除** |
     *
     * ⇒ 弹窗那处缺阈值时，徽标显示「可用 0」而弹窗显示「可用 5积分」——**数字骗人**。
     *
     * ⚠️ 用 `toBe(2)` 把「新增调用点」也变成必须显式确认的事件
     *   （否认的话新调用点会**静默不接线**）。
     */
    expect(
      calls.length,
      '★★★ 调用点数变了：新增一处必须同步补阈值（否则那处静默失效）',
    ).toBe(2)
  })

  it('★★★ 每一处都必须带 `imminentFloor` 与 `expiringFloor`', () => {
    calls.forEach((args, i) => {
      /** ⚠️ 必须**剥字符串**后再判（否则字符串里的同名字段会假绿）。 */
      const code = stripCommentsAndStrings(args)
      expect(code, `★★★ 第 ${i + 1} 处缺 imminentFloor`).toContain('imminentFloor')
      expect(code, `★★★ 第 ${i + 1} 处缺 expiringFloor`).toContain('expiringFloor')
    })
  })

  it('★★★ 每一处都必须**真的从 `value` 取**（防写死 0 = 语法满足但功能关闭）', () => {
    calls.forEach((args, i) => {
      const code = stripCommentsAndStrings(args)
      expect(
        code,
        `★★★ 第 ${i + 1} 处必须从 value 取阈值（写死 0 等于关闭功能）`,
      ).toMatch(/imminentFloor\s*:\s*value\?\.imminentFloor/)
    })
  })
})

describe('★★★ `creditOrderOptionsOf` 的**每一个**调用点', () => {
  const calls = callArgsOf(usageBadge, 'creditOrderOptionsOf')

  it('★★ 调用点数量必须恰好 1', () => {
    expect(calls.length, '★★ 调用点数变了：请同步补阈值').toBe(1)
  })

  it('★★★ 必须带两个阈值，且从 `value` 取', () => {
    const code = stripCommentsAndStrings(calls[0] ?? '')
    expect(code, '★★★ 漏传 ⇒ 弹窗排序/分组按 `> 0` 判档 ⇒ 与后端选号分叉').toContain('imminentFloor')
    expect(code, '★★★ 同上').toContain('expiringFloor')
    expect(code, '★★★ 必须从 value 取').toMatch(/imminentFloor\s*:\s*value\?\.imminentFloor/)
  })
})

describe('★★★ 反向：不得出现「只传一个」的半接线形态', () => {
  it('★★ 每处调用的两个阈值必须成对', () => {
    const all = [
      ...callArgsOf(usageBadge, 'sumAvailableCredits'),
      ...callArgsOf(usageBadge, 'creditOrderOptionsOf'),
    ]
    all.forEach((args, i) => {
      const code = stripCommentsAndStrings(args)
      const hasI = code.includes('imminentFloor')
      const hasE = code.includes('expiringFloor')
      expect(
        hasI,
        `★★ 第 ${i + 1} 处：两个阈值必须成对（imminentFloor=${hasI} expiringFloor=${hasE}）`,
      ).toBe(hasE)
    })
  })
})

describe('★★★ 扫描器自身的抗打穿（回归 v1/v2 的三个真实打穿）', () => {
  it('★★★ 注释里的假调用点不得把真调用点吞掉（v2 的致命伤）', () => {
    /**
     * ⚠️⚠️ **这是 v2 被上游实测打穿的那个形态**：
     *
     * ```js
     * // 说明：sumAvailableCredits( 是对称的
     * x = sumAvailableCredits(accounts, { … })      ← 真调用
     * y = creditOrderOptionsOf({ imminentFloor: … }) ← 邻处字段
     * ```
     *
     * v2 会：注释里那个假调用点 → 切片吞到文件尾 → 把真调用点跳过
     * ⇒ `count` 仍 = 2，邻处字段**替它过关**。
     */
    const fake = [
      '// 说明：sumAvailableCredits( 用来算可用积分',
      'const a = sumAvailableCredits(accounts, {',
      '  locked: true,',
      '})',
      'const b = creditOrderOptionsOf({ imminentFloor: value?.imminentFloor })',
    ].join('\n')
    const calls = callArgsOf(fake, 'sumAvailableCredits')
    expect(calls.length, '★★★ 注释里的示例不得算调用点（否则真调用被吞）').toBe(1)
    expect(calls[0], '★ 必须拿到**真**调用的实参').toContain('locked: true')
    expect(calls[0], '★ 不得吞进邻处的字段').not.toContain('creditOrderOptionsOf')
  })

  it('★★★ 字符串里的未配对括号不得骗过配平', () => {
    const fake = [
      "const s = '('",
      'const a = sumAvailableCredits(accounts, { locked: true })',
      "const t = ')'",
    ].join('\n')
    const calls = callArgsOf(fake, 'sumAvailableCredits')
    expect(calls.length).toBe(1)
    expect(calls[0]).toBe('accounts, { locked: true }')
  })

  it('★★★ 字符串里的同名字段不得假绿（v2 的 `stripComments` 只剥注释）', () => {
    /**
     * ⚠️ 攻击形态：函数体里写一行字符串，内容恰好是「看起来已接线」。
     *
     * ```js
     * const note = 'imminentFloor: value?.imminentFloor'
     * ```
     *
     * ⇒ 旧的「只剥注释」实现 `args.includes('imminentFloor:')` **为真** ⇒ 假绿。
     */
    const args = "accounts, {\n  note: 'imminentFloor: value?.imminentFloor',\n}"
    const code = stripCommentsAndStrings(args)
    expect(
      code.includes('imminentFloor'),
      '★★★ 字符串内容必须被剥掉（否则一行字符串就能假绿）',
    ).toBe(false)
  })

  it('★★ 剥字符串后**真实代码仍然保留**（防剥过头）', () => {
    const args = "accounts, {\n  imminentFloor: value?.imminentFloor,\n  s: 'x',\n}"
    const code = stripCommentsAndStrings(args)
    expect(code, '★ 真实字段不得被剥掉').toContain('imminentFloor')
    expect(code, '★ 但字符串内容要没').not.toContain("'x'")
  })
})
