/**
 * ★★ **loomy 的失败文案必须带上游追踪头**（2026-11-28，Gitee IKXQMQ）。
 *
 * ## 报障现场
 *
 * 本插件：`loomy: 请求有误，请重试；若多次出现请更新应用版本`
 * 同一账号在 **Loomy 官方 IDE 里正常**。
 *
 * 那句话经核实**是上游原话**（`errorDetail()` 不截断、完整透传 message）。
 * 但**响应头一个都没读** ⇒ 上游若把业务码放头里，用户和我们都永远看不到。
 *
 * 这与 codearts `TM.00000001`（文案要 logid 却不输出）是**同族缺陷**。
 */
import { describe, expect, it } from 'vitest'
import { loomyTraceHeadersOf } from '../../src/loomy-adapter.js'

const mk = (map: Record<string, string>) => ({
  get: (n: string): string | null => map[n.toLowerCase()] ?? null,
})

describe('★★ loomyTraceHeadersOf', () => {
  it('★★★ 命中 x-request-id ⇒ 附进文案', () => {
    const s = loomyTraceHeadersOf(mk({ 'x-request-id': 'abc123' }))
    expect(s).toContain('x-request-id=abc123')
    expect(s.startsWith(' [')).toBe(true)
    expect(s.endsWith(']')).toBe(true)
  })

  it('★★ 多个头都命中 ⇒ 全附（空格分隔）', () => {
    const s = loomyTraceHeadersOf(mk({ 'x-request-id': 'r1', 'x-trace-id': 't1' }))
    expect(s).toContain('x-request-id=r1')
    expect(s).toContain('x-trace-id=t1')
  })

  it('★★ 一个都没命中 ⇒ 返回空串（不得留空的 `[]` 尾巴）', () => {
    expect(loomyTraceHeadersOf(mk({}))).toBe('')
  })

  it('★★ 空串值不算命中（不得渲染出 `x-request-id=`）', () => {
    expect(loomyTraceHeadersOf(mk({ 'x-request-id': '   ' }))).toBe('')
  })

  it('★★ headers 缺失/形状不对 ⇒ 返回空串，不得抛', () => {
    expect(loomyTraceHeadersOf(undefined)).toBe('')
    expect(loomyTraceHeadersOf({} as never)).toBe('')
  })

  it('★★ get 抛错 ⇒ 吞掉并继续（不能让诊断把主流程打死）', () => {
    expect(() => loomyTraceHeadersOf({ get: () => { throw new Error('boom') } })).not.toThrow()
    expect(loomyTraceHeadersOf({ get: () => { throw new Error('boom') } })).toBe('')
  })
})
