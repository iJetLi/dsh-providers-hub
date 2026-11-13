/**
 * `dsml-normalizer-coverage.spec.ts` —— 防回归：**每个**正文出口都必须接归一化。
 *
 * ## 为什么需要这个测试（2026-10-13 真实事故）
 *
 * 首批归一化只接了 `openai-compat.ts` 与 `buddy-adapter.ts` 两个出口，自测
 * 12 条全绿、全量 7413 绿 —— 但**重启后会话里仍有 270 处坏标记**。
 * 原因：`text-delta` 出口共 **8 处**，另外 6 处（含 codearts 走的
 * `llm-adapter.ts` 主路径）**根本没接**。单测只验证了「归一化器自己是对的」，
 * 没验证「每个出口都用上了它」—— 于是覆盖缺口被完整放过。
 *
 * 这是「测试测了实现、没测接线」的典型盲区。本文件锁的就是**接线**。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(process.cwd(), 'src')

/** src 下所有 .ts（不含测试与声明文件）。 */
function sourceFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => ({ f, p: join(SRC_DIR, f) }))
    .filter(({ p }) => !readFileSync(p, 'utf8').includes("from 'vitest'"))
    .map(({ f }) => f)
}

/**
 * 找出所有发射**正文** `text-delta` 的文件。
 *
 * 判据：`yield { type: 'text-delta'` 或 `yield {...text-delta...}` 形态。
 *
 * ⚠️ **只发射空 `text-delta`（`text: ''`）的文件不算正文出口**：
 * 空串里不可能出现 DSML 标记，归一化对它没有意义；而这类帧有自己的用途
 * （qoder 排队 `visible` 档的心跳 / 排队提示帧，PR #63）。
 * 2026-11-13 实测：不排除时 `qoder-adapter.ts` 会被误判成第 10 个正文出口，
 * ①②③ 三条守卫同时变红 —— **判据必须只认「可能承载正文」的出口**。
 */
function textDeltaEmitters(): string[] {
  return sourceFiles().filter((f) => {
    const c = readFileSync(join(SRC_DIR, f), 'utf8')
    const hits = [...c.matchAll(/type:\s*'text-delta'/g)]
    if (hits.length === 0) return false
    // 该 `type` 之后 200 字符内出现 `text: ''` ⇒ 这一帧是空帧（不承载正文）。
    return hits.some((hit) => {
      const tail = c.slice(hit.index ?? 0, (hit.index ?? 0) + 200)
      return !/text:\s*''/.test(tail)
    })
  })
}

describe('DSML 归一化接线覆盖（防回归）', () => {
  const emitters = textDeltaEmitters()

  it('① 出口数量必须被显式登记 —— 新增出口要同步补接线', () => {
    // ⚠️ 这个数字变动**必须**意味着有人新增/删减了正文出口。
    //    新增时请把该出口也接上归一化，并把本数字改到新值 —— 故意让它「红一次」，
    //    逼接线的动作发生（不能无脑改数字）。
    expect(
      emitters.sort(),
      `正文出口清单变了（${emitters.length} 个）：${emitters.join(', ')}。若新增出口，必须同时接入 DSML 归一化。`,
    ).toEqual([
      'buddy-adapter.ts',
      // ⚠️ codely-adapter.ts（2026-10-20 新增）：推理改为驱动官方 CLI 后成为
      //    第 9 个正文出口 ⇒ 已同步接入 `createDsmlMarkerNormalizer`（push +
      //    flush），②③ 两条守卫现在覆盖它。
      'codely-adapter.ts',
      'gemini-messages.ts',
      'llm-adapter.ts',
      'lobsterai-adapter.ts',
      'minimax-messages.ts',
      'openai-compat.ts',
      'trae-adapter.ts',
      'zcode-anthropic.ts',
    ])
  })

  it('② **每个**出口都必须真正调用 dsmlFix（缺一即红）', () => {
    const uncovered = emitters.filter((f) => {
      const c = readFileSync(join(SRC_DIR, f), 'utf8')
      return !/dsmlFix/.test(c)
    })
    expect(
      uncovered,
      `以下正文出口未接入 DSML 归一化（2026-10-13 事故根因）：${uncovered.join(', ')}`,
    ).toEqual([])
  })

  it('③ 每个出口都必须 flush 待定缓冲（否则尾部字符丢失）', () => {
    const noFlush = emitters.filter((f) => {
      const c = readFileSync(join(SRC_DIR, f), 'utf8')
      return !/dsmlFix\.flush\(\)/.test(c)
    })
    expect(noFlush, `以下出口没有 flush（流尾字符会丢）：${noFlush.join(', ')}`).toEqual([])
  })

  it('⑤ 只发射**空** text-delta 的文件不算正文出口（qoder 排队心跳 / 提示帧，PR #63）', () => {
    // 判据的「排除空帧」那一腿必须真的生效：不排除时 qoder-adapter.ts 会被
    // 误判成第 10 个正文出口（2026-11-13 实测 ①②③ 三条同时红）。
    expect(textDeltaEmitters()).not.toContain('qoder-adapter.ts')
    // 反向钉子：真实正文出口仍必须被认出来（防止判据被改成恒假 ⇒ 守卫空转）。
    expect(textDeltaEmitters()).toContain('openai-compat.ts')
    expect(textDeltaEmitters()).toContain('llm-adapter.ts')
    expect(textDeltaEmitters().length).toBeGreaterThanOrEqual(9)
  })

  it('④ 归一化实现必须只有 sse.ts 一处（不得各写各的）', () => {
    const definers = sourceFiles().filter((f) => {
      const c = readFileSync(join(SRC_DIR, f), 'utf8')
      return /function (fixDsmlMarkers|createDsmlMarkerNormalizer)/.test(c)
    })
    expect(definers, `实现散落多处：${definers.join(', ')}`).toEqual(['sse.ts'])
  })
})
