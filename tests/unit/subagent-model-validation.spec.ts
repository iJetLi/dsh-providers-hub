/**
 * ★★★ **上游第二轮审计 P1-5：模型 id 零校验**（2026-11-24）。
 *
 * ## 上游原话
 *
 * > 「**模型 id 零校验**即落盘并 `select()`。」
 *
 * ## 缺陷链
 *
 * 上一版 `credits.window.set` 对 `subagent.model` 只判「非空字符串」：
 *
 * ```ts
 * if (value !== undefined && (typeof value !== 'string' || value.length === 0)) → 拒绝
 * ```
 *
 * ⇒ 用户（或老版本客户端 / 手改 `state.json`）传一个**不存在的模型 id** 时：
 *
 * | 步 | 结果 |
 * |---|---|
 * | 1 | 设置**照常落盘** |
 * | 2 | `subagent/start` 时 `agent.model.select({ model })` 被宿主拒 |
 * | 3 | 那个 `catch` 把它吞成**静默** ⇒ 子代理一直用主代理模型 |
 *
 * ⇒ **零报错 + 界面显示已保存** —— 与「设了不生效」那类缺陷同形。
 *
 * ## 本文件怎么守
 *
 * ⚠️ `credits.window.set` 的入口在 `registerJetHubRpc` 的闭包里，单测造不出
 * 完整 RPC 上下文 ⇒ 用**源码锚点 + 判据形态**（如实登记为弱守卫），
 * 但每条都配了「变异能变红」的验证。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSrc = readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8')

/** 剥注释（本文件注释里大量引用被断言的标识符）。 */
const stripComments = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n')

const code = stripComments(rpcSrc)

/** 取 `credits.window.set` 那个 case 的正文（配对花括号）。 */
function windowSetCaseBody(source: string): string {
  const idx = source.indexOf("case 'credits.window.set': {")
  if (idx < 0) return ''
  const open = source.indexOf('{', idx)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(idx, i + 1)
    }
  }
  return ''
}

describe('P1-5：模型 id 必须校验「存在 + 已启用」', () => {
  const body = windowSetCaseBody(code)

  it('★★★ case 体必须能取到（否则下面的断言全是空过）', () => {
    expect(body.length, '找不到 credits.window.set 的 case 体').toBeGreaterThan(1000)
  })

  it('★★★ 必须校验模型在该渠道的已启用列表里', () => {
    /**
     * ⚠️ 判据必须是「`enabledIds.includes(model)`」这种**真比对**，
     * 不能只是「出现了 listModels」（那对「读进来但不用」无效）。
     */
    expect(
      body,
      '★★★ 必须有 enabledIds.includes(rawSub.model) 的真比对',
    ).toMatch(/enabledIds\.includes\(rawSub\.model\)/)
    expect(
      body,
      '★★★ 不在列表里必须 bad-request',
    ).toMatch(/不在该渠道已启用的模型中/)
  })

  it('★★★ 校验口径必须与 credits.window.models 同源（listDisabledModels）', () => {
    /**
     * ⚠️ 「已启用」的判据**只能**复用 `pool.listDisabledModels()` ——
     * 那是设置页开关的同一真源。自己另写一套必然漂移
     * （本仓红线：同一语义不得两套判据）。
     */
    expect(
      body,
      '★★★ 必须复用 pool.listDisabledModels（与下拉框同源）',
    ).toContain('pool.listDisabledModels(req.provider)')
    expect(
      body,
      '★★★ 必须用 disabled[m.id] !== true 过滤',
    ).toMatch(/disabledForProvider\[m\.id\] !== true/)
  })

  it('★★★ 思考档位必须属于该模型', () => {
    expect(
      body,
      '★★★ 必须校验 reasoningEffort 在该模型的 efforts 里',
    ).toMatch(/efforts\.includes\(rawSub\.reasoningEffort\)/)
    expect(
      body,
      '★★★ 非法档位必须 bad-request',
    ).toMatch(/不是模型「\$\{rawSub\.model\}」的合法档位/)
  })

  it('★★ 目录读不到时必须**跳过**校验（离线也不该拦保存）', () => {
    /**
     * ⚠️ 反向对照：证明校验不是「一律拒绝」。
     *
     * 判定方式：`enabledIds` 必须是 `readonly string[] | undefined`，
     * 且 catch 分支赋 `undefined` ⇒ 后面用 `enabledIds !== undefined` 守卫。
     */
    expect(body, '★★ 目录失败必须赋 undefined（不是空数组）').toMatch(/enabledIds = undefined/)
    expect(body, '★★ 后续判据必须允许 undefined').toMatch(/enabledIds !== undefined/)
  })

  it('★★ 模型没声明档位时不得拦 reasoningEffort（避免误杀）', () => {
    /**
     * ⚠️ 有些模型 `efforts` 为空 ⇒ 配 `reasoningEffort` 本来就不会被用
     * （`select()` 忽略）⇒ 只在 `efforts.length > 0` 时才校验。
     */
    expect(body, '★★ 必须判 efforts.length > 0 才校验').toMatch(/efforts\.length > 0/)
  })
})
