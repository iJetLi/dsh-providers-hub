/**
 * ★★★ **`computeCoverage` 的阈值实参守卫**（2026-11-27，PR #184 对抗审计 §3 挖出的第 4 处接线）。
 *
 * ## 为什么单独建这个文件
 *
 * PR #184 修了「最后一米」里 `sumAvailableCredits` / `creditOrderOptionsOf` 两处，
 * 但**同一不变式的第 4 处接线完全没守**：
 *
 * ```js
 * // plugin-src/client/jet-hub.js:461-468
 * const coverage = computeCoverage(
 *   accounts(), effectiveWindow, effectiveImminent, Date.now(),
 *   effectiveImminentFloor,     // ← 第 5 个位置实参
 *   effectiveExpiringFloor,     // ← 第 6 个位置实参
 * )
 * ```
 *
 * 审计实测：
 * - `grep -rn "effectiveImminentFloor\|effectiveExpiringFloor" tests/` ⇒ **0 命中**；
 * - 把这**两行位置实参删掉** ⇒ `credit-floor-wiring.spec.ts` **仍然全绿**。
 *
 * ## 为什么它比具名字段更危险
 *
 * `computeCoverage(accounts, windowDays, imminentDays, now, imminentFloor = 0, expiringFloor = 0)`
 * 的 floor **有默认值 `0`** ⇒ **删掉实参不报错、静默变成「阈值关闭」**。
 *
 * ⇒ 用户在面板上改了阈值，**覆盖数不跟着变**，而所有测试都是绿的。
 *
 * ⚠️ **本文件是文本级守卫**（不是行为级）：`computeCoverage` 的签名是位置实参，
 *    而 `plugin-src/client/*.js` 不走 tsc ⇒ 没有类型能帮我们。
 *    真实的行为级保护需要把签名改成立即对象，那是独立的破坏性改动。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { callArgsOf as argsOf } from './_support/source-scanner.js'

const SRC = fileURLToPath(new URL('../../plugin-src/client/jet-hub.js', import.meta.url))

/**
 * ⚠️ **扫描器已抽到 `_support/source-scanner.ts`**（2026-11-28）。
 *
 * 原因：本文件与 `credit-floor-lastmile.spec.ts` 需要**同一份**「跳过字符串/注释的真扫描」。
 * 两处各写一份必然漂移（本仓红线：同一语义不得两套）—— 而本文件那份
 * （上游在 `8d451218` 写的）就是**正确的基准实现**，已原样搬过去。
 *
 * 它修掉的历史打穿（详见该模块头）：
 * - 固定字符窗口被「插注释」打穿（余量仅 13 字符）
 * - 朴素括号计数被「字符串/注释里的未配对括号」打穿（越界到 93,876 字符）
 */

describe('★★★ computeCoverage 的阈值实参（第 4 处接线）', () => {
  const src = readFileSync(SRC, 'utf8')

  it('★★★ 调用点数量必须恰好 1（新增/删除都该被显式确认）', () => {
    const calls = argsOf(src, 'computeCoverage')
    expect(calls.length, '`computeCoverage` 的调用点数量变了 ⇒ 请先确认每一处都传了阈值').toBe(1)
  })

  it('★★★ 实参必须含两个生效阈值（删掉它们 ⇒ 静默变「阈值关闭」）', () => {
    const [args] = argsOf(src, 'computeCoverage')
    expect(args, '调用点消失了').toBeDefined()
    expect(args, '★ 缺 effectiveImminentFloor ⇒ 覆盖数不跟阈值变').toContain('effectiveImminentFloor')
    expect(args, '★ 缺 effectiveExpiringFloor ⇒ 纯短期降级在覆盖数上失效').toContain('effectiveExpiringFloor')
  })

  it('★★ 不得只传一个（半接线）', () => {
    const [args] = argsOf(src, 'computeCoverage')
    const hasI = (args ?? '').includes('effectiveImminentFloor')
    const hasE = (args ?? '').includes('effectiveExpiringFloor')
    expect(hasI, '两个必须同时在场或同时缺席（同时缺席已由上一条挡）').toBe(hasE)
  })

  it('★★ 字符串里含未配对括号不得骗过切片（对抗审计 §1 的病）', () => {
    // 构造一个假的源：注释里带 `computeCoverage('('`，真调用在后面
    const fake = [
      '// 文档示例：computeCoverage(accounts, 15, 5, 0, 20, 30)',
      'const c = computeCoverage(',
      '  accounts(), w, i, now,',
      '  effectiveImminentFloor,',
      '  effectiveExpiringFloor,',
      ')',
    ].join('\n')
    const calls = argsOf(fake, 'computeCoverage')
    expect(calls.length, '行首注释里的示例不得算作调用点').toBe(1)
    expect(calls[0]).toContain('effectiveImminentFloor')
  })
})
