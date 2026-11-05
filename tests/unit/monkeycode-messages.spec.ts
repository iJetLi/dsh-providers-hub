/**
 * MonkeyCode 请求体守卫（`src/monkeycode-messages.ts`）。
 *
 * 这个 spec 是 2026-11-02 补的：在这之前 `buildMonkeycodeMessagesPayload`
 * **没有任何单测**，于是放出去过一个真 bug —— 思考预算只夹了下限、没夹上限，
 * 档位 `high`(8192) 遇到默认 `max_tokens=4096` 时预算 ≥ 上限。
 *
 * Anthropic 对这种请求的处理是**整批 400**（不是「少给点思考」），而且失败
 * 发生在第一个 token 之前 ⇒ 适配器的换号逻辑会把它当成「账号级失败」，
 * 试遍所有账号后把**整个渠道**判死，用户看到的是「全部账号都不可用」。
 * 这类「配置组合触发的硬失败」只能靠表驱动断言守住。
 *
 * 除了 thinking 夹逼，这里还守两条容易静默漂的协议要求：
 * ① `max_tokens` 必填（Anthropic 与 OpenAI 的差异点，漏了直接 400）；
 * ② `stream` 恒真（本插件没有非流式路径，改成可选会让某条分支悄悄拿到整包响应）。
 */

import { describe, expect, it } from 'vitest'

import {
  MONKEYCODE_DEFAULT_MAX_TOKENS,
  MONKEYCODE_MAX_OUTPUT_TOKENS,
  MONKEYCODE_MIN_THINKING_BUDGET,
  buildMonkeycodeMessagesPayload,
  monkeycodeMaxTokensFor,
  monkeycodeThinkingFor,
} from '../../src/monkeycode-messages.js'

const MESSAGES = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '你好' }] }]

/** 取 `thinking` 字段并窄化成可断言的字面量形状。 */
function thinkingOf(payload: Record<string, unknown>): { type: string; budget_tokens?: number } {
  const raw = payload.thinking as { type: string; budget_tokens?: number } | undefined
  expect(raw, 'thinking 字段缺失').toBeDefined()
  return raw as { type: string; budget_tokens?: number }
}

describe('buildMonkeycodeMessagesPayload · 协议必填项', () => {
  it('max_tokens 恒存在：缺省落成默认值而不是省略字段', () => {
    const payload = buildMonkeycodeMessagesPayload({ model: 'deepseek-flash', messages: MESSAGES })
    expect(payload.max_tokens).toBe(MONKEYCODE_DEFAULT_MAX_TOKENS)
    expect(payload.max_tokens).toBeGreaterThan(0)
  })

  it('stream 恒真：本插件没有非流式路径', () => {
    const payload = buildMonkeycodeMessagesPayload({ model: 'deepseek-flash', messages: MESSAGES })
    expect(payload.stream).toBe(true)
  })

  it('调用方显式传的 max_tokens 优先', () => {
    const payload = buildMonkeycodeMessagesPayload({
      model: 'deepseek-flash',
      messages: MESSAGES,
      maxTokens: 777,
    })
    expect(payload.max_tokens).toBe(777)
  })
})

describe('buildMonkeycodeMessagesPayload · 思考预算夹逼', () => {
  it('★★ 预算必须严格小于 max_tokens（Anthropic 硬约束，违反即整批 400）', () => {
    // 穷举「档位 × max_tokens」的组合：这正是当初漏掉的形态。
    const efforts = ['none', 'low', 'medium', 'high', 'bogus'] as const
    const maxTokensList = [1, 1024, 1025, 2048, 4096, 8192, 100_000]

    for (const effort of efforts) {
      const thinking = monkeycodeThinkingFor(effort)
      if (thinking === undefined) continue
      for (const maxTokens of maxTokensList) {
        const payload = buildMonkeycodeMessagesPayload({
          model: 'deepseek-flash',
          messages: MESSAGES,
          maxTokens,
          thinking,
        })
        const thinkingField = thinkingOf(payload)

        if (thinkingField.type === 'enabled') {
          const budget = thinkingField.budget_tokens
          expect(budget, `effort=${effort} maxTokens=${maxTokens} 缺 budget_tokens`).toBeDefined()
          expect(
            budget as number,
            `effort=${effort} maxTokens=${maxTokens} 的预算必须严格小于 max_tokens`,
          ).toBeLessThan(maxTokens)
          expect(
            budget as number,
            `effort=${effort} maxTokens=${maxTokens} 的预算不得低于服务端下限`,
          ).toBeGreaterThanOrEqual(MONKEYCODE_MIN_THINKING_BUDGET)
        }
      }
    }
  })

  it('★★ high 档 + 默认 max_tokens：夹到 max_tokens-1，而不是降级 disabled（更不是发非法预算）', () => {
    const payload = buildMonkeycodeMessagesPayload({
      model: 'deepseek-flash',
      messages: MESSAGES,
      thinking: monkeycodeThinkingFor('high'),
    })
    /**
     * high = 8192 > 默认 4096 ⇒ 直接发会 400，但**不该**因此把思考整个关掉：
     * 2026-11-02 二审 C🟡-3 指出「装不下就 disabled」会让用户选 high 时
     * 静默得到零思考。正确做法是夹到 `max_tokens - 1`（服务端要求严格小于），
     * 只有连最小预算 1024 都放不下时才降级。
     */
    const thinkingField = thinkingOf(payload)
    expect(thinkingField.type).toBe('enabled')
    expect(thinkingField.budget_tokens).toBe(4095)
  })

  it('预算明显小于上限时保留 enabled 且原样透传档位值', () => {
    const payload = buildMonkeycodeMessagesPayload({
      model: 'deepseek-flash',
      messages: MESSAGES,
      maxTokens: 8192,
      thinking: monkeycodeThinkingFor('medium'),
    })
    const thinkingField = thinkingOf(payload)
    expect(thinkingField.type).toBe('enabled')
    expect(thinkingField.budget_tokens).toBe(4096)
  })

  it('预算恰好等于 max_tokens 时夹到 max_tokens-1（相等违反「严格小于」，但不必关掉思考）', () => {
    const payload = buildMonkeycodeMessagesPayload({
      model: 'deepseek-flash',
      messages: MESSAGES,
      maxTokens: 4096,
      thinking: { type: 'enabled', budgetTokens: 4096 },
    })
    const thinkingField = thinkingOf(payload)
    expect(thinkingField.type).toBe('enabled')
    expect(thinkingField.budget_tokens).toBe(4095)
  })

  it('预算装不下最小思考预算时降级 disabled（小请求不硬失败）', () => {
    const payload = buildMonkeycodeMessagesPayload({
      model: 'deepseek-flash',
      messages: MESSAGES,
      maxTokens: 1024,
      thinking: { type: 'enabled', budgetTokens: 2048 },
    })
    expect(thinkingOf(payload).type).toBe('disabled')
  })

  it('显式 disabled 原样下发', () => {
    const payload = buildMonkeycodeMessagesPayload({
      model: 'deepseek-flash',
      messages: MESSAGES,
      maxTokens: 64,
      thinking: { type: 'disabled' },
    })
    expect(thinkingOf(payload)).toEqual({ type: 'disabled' })
  })

  it('thinking 未传时不发该字段（让服务端用默认，不等于显式关闭）', () => {
    const payload = buildMonkeycodeMessagesPayload({ model: 'deepseek-flash', messages: MESSAGES })
    expect('thinking' in payload).toBe(false)
  })
})

describe('monkeycodeThinkingFor · 档位映射', () => {
  it('档位到预算是弱→强的单调序列', () => {
    const low = monkeycodeThinkingFor('low')
    const medium = monkeycodeThinkingFor('medium')
    const high = monkeycodeThinkingFor('high')
    expect(low).toEqual({ type: 'enabled', budgetTokens: 2048 })
    expect(medium).toEqual({ type: 'enabled', budgetTokens: 4096 })
    expect(high).toEqual({ type: 'enabled', budgetTokens: 8192 })
  })

  it('none 是显式关闭，未知档位是不发（两者不是一回事）', () => {
    expect(monkeycodeThinkingFor('none')).toEqual({ type: 'disabled' })
    expect(monkeycodeThinkingFor('bogus')).toBeUndefined()
    expect(monkeycodeThinkingFor(undefined)).toBeUndefined()
  })
})

describe('monkeycodeMaxTokensFor · 入参归一', () => {
  it('未传 / undefined ⇒ 默认值', () => {
    expect(monkeycodeMaxTokensFor(undefined)).toBe(MONKEYCODE_DEFAULT_MAX_TOKENS)
  })

  it('0 与负数 ⇒ 默认值（不是 0）', () => {
    expect(monkeycodeMaxTokensFor(0)).toBe(MONKEYCODE_DEFAULT_MAX_TOKENS)
    expect(monkeycodeMaxTokensFor(-1)).toBe(MONKEYCODE_DEFAULT_MAX_TOKENS)
  })

  it('NaN / Infinity ⇒ 默认值', () => {
    expect(monkeycodeMaxTokensFor(Number.NaN)).toBe(MONKEYCODE_DEFAULT_MAX_TOKENS)
    expect(monkeycodeMaxTokensFor(Number.POSITIVE_INFINITY))
      .toBe(MONKEYCODE_DEFAULT_MAX_TOKENS)
  })

  /**
   * ⚠️ 这条守的是真 bug（2026-11-02 复审发现）：`0 < x < 1` 能过完所有守卫
   * （是有限正数），却被 `Math.floor(0.5)` 抹成 `0` ⇒ 构造出 `max_tokens: 0`
   * 的请求体，服务端直接 400。调用方按比例算预算（例如 `budget * 0.5`）就会踩中。
   */
  it('(0,1) 的小数必须被抬到 1，不能 floor 成 0', () => {
    expect(monkeycodeMaxTokensFor(0.5)).toBe(1)
    expect(monkeycodeMaxTokensFor(0.0001)).toBe(1)
  })

  it('正常值向下取整', () => {
    expect(monkeycodeMaxTokensFor(1023.9)).toBe(1023)
  })

  it('超过上限 ⇒ 夹到 MONKEYCODE_MAX_OUTPUT_TOKENS', () => {
    expect(monkeycodeMaxTokensFor(MONKEYCODE_MAX_OUTPUT_TOKENS + 1))
      .toBe(MONKEYCODE_MAX_OUTPUT_TOKENS)
  })
})
