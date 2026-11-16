import { describe, expect, it } from 'vitest'

import { buildMarvisPayload, buildMarvisTools } from '../../src/marvis-messages.js'

describe('buildMarvisTools', () => {
  it('★ 把 DSH 的扁平 schema 包成 type/function（不包会 400）', () => {
    const tools = buildMarvisTools([
      {
        name: 'read_file',
        description: '读一个文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ])
    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: '读一个文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ])
  })

  it('空描述整个省略（不是发空串）', () => {
    const tools = buildMarvisTools([{ name: 'noop', description: '' }])
    expect(tools[0]?.function).toEqual({ name: 'noop' })
    expect(Object.hasOwn(tools[0]?.function ?? {}, 'description')).toBe(false)
  })

  it('parameters 缺失时整个省略', () => {
    const tools = buildMarvisTools([{ name: 'noop', description: 'x' }])
    expect(Object.hasOwn(tools[0]?.function ?? {}, 'parameters')).toBe(false)
  })

  it('undefined / 空数组 ⇒ []', () => {
    expect(buildMarvisTools(undefined)).toEqual([])
    expect(buildMarvisTools([])).toEqual([])
  })
})

describe('buildMarvisPayload', () => {
  const base = { model: 'deepseek-v4-pro-external', messages: [{ role: 'user', content: 'hi' }] }

  it('stream 恒 true，且带 stream_options.include_usage（账本要靠它）', () => {
    const payload = buildMarvisPayload(base)
    expect(payload.stream).toBe(true)
    expect(payload.stream_options).toEqual({ include_usage: true })
  })

  it('★★★ tools 为空时必须整个省略（发 [] 会让模型在正文臆造工具调用）', () => {
    // 空数组与 undefined 都必须等价地「不带这个键」—— 上游据此判断本轮能否走
    // 结构化 function calling。带上 `[]` 时模型会改在正文里输出 DSML 标记，
    // 上层严格 JSON.parse 直接崩（Gitee IKVL6C）。
    const empty = buildMarvisPayload({ ...base, tools: [] })
    expect(Object.hasOwn(empty, 'tools')).toBe(false)
    expect(empty.tools).toBeUndefined()
    const missing = buildMarvisPayload(base)
    expect(Object.hasOwn(missing, 'tools')).toBe(false)
  })

  it('★ 有工具时必须带，且与 buildMarvisTools 逐字一致', () => {
    const tools = [
      { name: 'read_file', description: '读一个文件', parameters: { type: 'object' } },
    ]
    const payload = buildMarvisPayload({ ...base, tools })
    expect(payload.tools).toEqual(buildMarvisTools(tools))
    expect(payload.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: '读一个文件', parameters: { type: 'object' } },
      },
    ])
  })

  it('system 只有非空才带', () => {
    expect(Object.hasOwn(buildMarvisPayload({ ...base, system: '' }), 'system')).toBe(false)
    expect(buildMarvisPayload({ ...base, system: '你是助手' }).system).toBe('你是助手')
  })

  it('temperature 只放行有限数', () => {
    expect(buildMarvisPayload({ ...base, temperature: 0 }).temperature).toBe(0)
    expect(Object.hasOwn(buildMarvisPayload({ ...base, temperature: Number.NaN }), 'temperature')).toBe(
      false,
    )
    expect(
      Object.hasOwn(buildMarvisPayload({ ...base, temperature: Number.POSITIVE_INFINITY }), 'temperature'),
    ).toBe(false)
  })

  it('★ max_tokens 只放行安全正整数（0/负数/NaN/小数都会崩整轮）', () => {
    expect(buildMarvisPayload({ ...base, maxTokens: 32_000 }).max_tokens).toBe(32_000)
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      expect(Object.hasOwn(buildMarvisPayload({ ...base, maxTokens: bad }), 'max_tokens')).toBe(false)
    }
  })

  it('reasoning_effort 只有非空字符串才带（目录不声明档位时宿主不会发）', () => {
    expect(
      Object.hasOwn(buildMarvisPayload({ ...base, reasoningEffort: '' }), 'reasoning_effort'),
    ).toBe(false)
    expect(
      buildMarvisPayload({ ...base, reasoningEffort: 'none' }).reasoning_effort,
    ).toBe('none')
  })

  it('model 原样透传（归一化是调用方的事）', () => {
    expect(buildMarvisPayload({ ...base, model: 'deepseek-v4-pro-external' }).model).toBe('deepseek-v4-pro-external')
  })
})
