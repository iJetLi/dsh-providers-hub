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

  it('parameters 缺失时整个省略（判据取 wire 形态，与 tools 那条同口径）', () => {
    const tools = buildMarvisTools([{ name: 'noop', description: 'x' }])
    // ⚠️ 判 **wire** 而不是判对象键：`parameters: undefined` 在 JSON 上等于「没这个键」，
    //    而 `Object.hasOwn` 会把这两种实现判成一个红一个绿（与 P2-1 的 `tools` 同型）。
    const wire = JSON.parse(JSON.stringify(tools)) as Array<{ function: Record<string, unknown> }>
    expect(Object.hasOwn(wire[0]?.function ?? {}, 'parameters')).toBe(false)
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

  it('★★★ tools 为空时 wire 上必须整个省略（Gitee IKVL6C；「发 [] 会让模型臆造」仍是推断）', () => {
    // 空数组与 undefined 都必须等价地「不带这个键」。
    // ⚠️ 判据取 **wire 形态**（过一遍 JSON.stringify）：`Object.hasOwn(payload, …)`
    //    比 wire 更严 —— 显式写 `tools: undefined` 时 hasOwn 为 true，而 wire 上
    //    这个键根本不存在（PR #186 正向审计 P2-1）。
    // ⚠️ 本用例只钉**形状**。「`[]` 会让模型臆造」这一步在本仓**零实测**：
    //    4 条「只差 tools 一个变量」的记录全是「完全不发 tools ⇒ 臆造」，
    //    与 `[]` 不是同一输入（详见 buildMarvisTools 的 JSDoc）。
    const wireOf = (payload: unknown) => JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    const empty = wireOf(buildMarvisPayload({ ...base, tools: [] }))
    expect(Object.hasOwn(empty, 'tools')).toBe(false)
    const missing = wireOf(buildMarvisPayload(base))
    expect(Object.hasOwn(missing, 'tools')).toBe(false)
    // 显式 `undefined` 与「没写」在 wire 上必须同形（这条正是 P2-1 的变异点）。
    const explicit = wireOf(buildMarvisPayload({ ...base, tools: undefined }))
    expect(Object.hasOwn(explicit, 'tools')).toBe(false)
  })

  it('★ 有工具时必须带，且与 buildMarvisTools 逐字一致', () => {
    const tools = [
      { name: 'read_file', description: '读一个文件', parameters: { type: 'object' } },
    ]
    const payload = buildMarvisPayload({ ...base, tools })
    // ⚠️ 原有一行 `expect(payload.tools).toEqual(buildMarvisTools(tools))` 是
    //    `f(x) === f(x)` 的**空断言**（两边同一个函数），已删（正向审计 P2-3）。
    expect(payload.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: '读一个文件', parameters: { type: 'object' } },
      },
    ])
  })

  it('★ 稀疏数组不产生 [null, null, null]（长度 > 0 但无有效条目）', () => {
    // `new Array(3)` 的 length 是 3，`tools.length > 0` 的门控会放行；
    // 而 `.map` 保留空洞 ⇒ JSON.stringify 出 `[null, null, null]` ⇒ 上游
    // `'type' is a required property - 'tools.0'`（与 IKVL6C 同形的 400）。
    const sparse = new Array(3) as unknown as readonly { name: string }[]
    expect(buildMarvisTools(sparse)).toEqual([])
    // 空洞与有效条目混排时，只留有效的那条，且顺序不变。
    const mixed = [{ name: 'read_file' }]
    ;(mixed as unknown as unknown[]).length = 3
    expect(buildMarvisTools(mixed as never)).toEqual([
      { type: 'function', function: { name: 'read_file' } },
    ])
    // 纯空数组与 undefined 仍是 [] —— 门控的既有语义不变。
    expect(buildMarvisTools([])).toEqual([])
    expect(buildMarvisTools(undefined)).toEqual([])
  })

  it('★ 非数组 tools 必须响亮报错，不能静默省略（对抗审计 A5）', () => {
    // 修前 `tools: buildMarvisTools(input.tools)` 会在 `.map` 处抛错（响亮）；
    // 修后 `length > 0` 对非数组一律 false ⇒ 静默发出纯聊天请求，错误被吞。
    // TS 只挡得住仓内唯一调用点，而 `buildMarvisPayload` 是 export 的。
    for (const bad of [5, true, 'tools', Symbol('t'), { length: 1 }, Object.create(null)]) {
      expect(() => buildMarvisPayload({ ...base, tools: bad as never }), String(typeof bad)).toThrow(
        TypeError,
      )
    }
    // 合法两态不受影响。
    expect(() => buildMarvisPayload({ ...base, tools: [] })).not.toThrow()
    expect(() => buildMarvisPayload(base)).not.toThrow()
  })

  it('★ system 折进 messages[]，不放顶层（GitHub #97）', () => {
    // 上游只从 `messages[]` 读系统提示词，请求体顶层的 `system` 被**静默忽略**
    // （2026-11-17 真机：带了却收不到指令、HTTP 仍是 200）。这条用例修前把
    // **错误行为钉成了期望**（`payload.system`），所以回归能活下来。
    expect(Object.hasOwn(buildMarvisPayload({ ...base, system: '' }), 'system')).toBe(false)
    expect(buildMarvisPayload({ ...base, system: '' }).messages).toEqual(base.messages)
    const folded = buildMarvisPayload({ ...base, system: '你是助手' })
    expect(Object.hasOwn(folded, 'system'), '顶层不许再有 system').toBe(false)
    expect(folded.messages).toEqual([{ role: 'system', content: '你是助手' }, ...base.messages])
  })

  it('★ system 折进去时不得改动原 messages 数组（纯函数）', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    buildMarvisPayload({ ...base, messages, system: '你是助手' })
    expect(messages).toEqual([{ role: 'user', content: 'hi' }])
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
