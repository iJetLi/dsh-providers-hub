/**
 * astudio-responses.spec.ts —— AStudio **Responses 协议**的两个纯函数单测。
 *
 * 被测源码（`src/astudio.ts`）：
 * - `astudioResponsesInputItems` / `buildAstudioResponsesRequest`：chat 形状消息 → Responses 请求体；
 * - `astudioResponsesToChatSse`：上游 Responses SSE → chat 帧（再交给共享消费器）。
 *
 * ── 为什么必须成对测 ────────────────────────────────────────────────
 * 本家真实通路是 `POST {base}/model-gateway/v1/responses`（2026-11-16 真机实测）：
 * 同一基址的 `/chat/completions` 恒 404，而 Chat Completions 那条腿上的 MaaS
 * `api_key` 会 403 `11200`。⇒ 请求体与 SSE 事件**两套都不兼容**，任一函数退回去
 * 就整条渠道不可用，且症状是「上游 200 但正文空」这类最难查的形态。
 *
 * ── 零网络 ─────────────────────────────────────────────────────────
 * 输入全部是本地构造的 SSE 字面量（形态逐字取自 2026-11-16 真机抓包）。
 *
 * ── 关键格里为什么这么写（都由实测驱动，别凭直觉改）────────────────
 * ① `function_call_arguments.*` 必须按 **`output_index`** 归并到工具槽位（不是按 `item_id`：
 *    槽位语义是「第几个并行调用」，与 id 无关）。⚠️ 早期文档写「`item_id` 是空串」是错的
 *    （2026-11-17 复核真机抓包 4 帧全带 `item_id:"call_7e08…"`）—— 代码用 `output_index`
 *    本身是对的，只是理由要正过来。**未知 `output_index` 必须丢弃**（不能兜到 0 号槽，
 *    否则并行工具参数串台且上游零报错）。
 * ② `response.incomplete`（撞输出上限，reasoning 也吃预算）必须映射成 `length`，
 *    否则 harness 会把「被截断」当成正常结束，长回答静默丢失尾部。
 * ③ **断流（一个终态事件都没有）时必须什么都不补**，让共享消费器的
 *    `truncatedStream` 判据兜成 `max-tokens`。补 `finish_reason:'stop'` + `[DONE]`
 *    会让该判据永不触发 ⇒ 半截正文当完整回答上报（真机实测 60%~67% 丢失）。
 * ③ usage 是 **Responses 口径**（`input_tokens` / `output_tokens` /
 *    `*_details.cached_tokens|reasoning_tokens`），与 chat 的 `prompt_tokens` 不同名；
 *    直接透传会让消费器算成 0 token（计费与统计双缺）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AstudioAdapter } from '../../src/astudio-adapter.js'
import { ASTUDIO } from '../../src/astudio-product.js'
import {
  astudioResponsesInputItems,
  astudioResponsesToChatSse,
  buildAstudioResponsesRequest,
} from '../../src/astudio.js'
import { consumeOpenAiSse } from '../../src/openai-compat.js'

/** 把 SSE 事件行拼成一个 `Response`（body 是字面量，不出网）。 */
function sseResponse(pairs: Array<[string, unknown]>): Response {
  const body = pairs
    .map(([event, data]) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    .join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 用共享消费器把翻译后的流跑完，返回全部 chunk。 */
async function collect(response: Response, maxTokens?: number): Promise<Array<Record<string, unknown>>> {
  const chunks: Array<Record<string, unknown>> = []
  for await (const chunk of consumeOpenAiSse(astudioResponsesToChatSse(response), {}, {
    label: 'astudio',
    firstTokenTimeoutMs: 5_000,
    chunkTimeoutMs: 5_000,
    ...maxTokens !== undefined ? { maxTokens } : {},
  })) {
    chunks.push(chunk as unknown as Record<string, unknown>)
  }
  return chunks
}

const textOf = (chunks: Array<Record<string, unknown>>, type: string): string =>
  chunks.filter((c) => c.type === type).map((c) => String(c.text ?? '')).join('')

describe('buildAstudioResponsesRequest —— 请求体构造', () => {
  it('system 进顶层 instructions，user 成 input_text 部件', () => {
    const body = buildAstudioResponsesRequest({
      model: 'xopglm52',
      system: '你是简洁的助手。',
      messages: [{ role: 'user', content: '说一个字' }],
      stream: true,
    })
    expect(body.instructions).toBe('你是简洁的助手。')
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: '说一个字' }] }])
    expect(body.stream).toBe(true)
  })

  it('messages 里的 system 也进 instructions（与 one-shot system 合并）', () => {
    const body = buildAstudioResponsesRequest({
      model: 'xopglm52',
      system: '甲',
      messages: [
        { role: 'system', content: '乙' },
        { role: 'user', content: 'x' },
      ],
      stream: true,
    })
    expect(body.instructions).toBe('甲\n\n乙')
    // ⚠️ system **不得**出现在 input 里：Responses 的 input 条目只认
    // user/assistant/function_call/function_call_output。
    expect((body.input as Array<Record<string, unknown>>).some((item) => item.role === 'system')).toBe(false)
  })

  it('assistant 正文 → output_text 条目；tool_calls → 紧随其后的 function_call 条目', () => {
    const { items } = astudioResponsesInputItems([
      { role: 'user', content: '查天气' },
      {
        role: 'assistant',
        content: '好的',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
      },
    ])
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '查天气' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
    ])
  })

  it('空名字的 tool_call 必须剔除（否则下游执行成 unknown tool ""）', () => {
    const { items } = astudioResponsesInputItems([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: '', arguments: '{}' } }] },
    ])
    expect(items).toEqual([])
  })

  it('tool 结果 → function_call_output（call_id 原样）', () => {
    const { items } = astudioResponsesInputItems([
      // ⚠️ 必须先有配对的 `function_call`：孤儿的 `function_call_output` 现在会被剔除
      // （见下一条用例）。这里顺带钉住「配对齐全时逐字透传」。
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴，28 度' },
    ])
    expect(items).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '晴，28 度' },
    ])
  })

  it('⚠️⚠️ 孤儿 function_call_output 必须剔除（调用被剔掉时不留孤儿，与网关 resolveToolPairing 同口径）', () => {
    // 本仓 Issue IKLRIK 逐字记过的形态。真机实测孤儿**不会 400**（2026-11-17），
    // 后果是历史与调用链**静默不一致** —— 比 400 更难查。
    const { items } = astudioResponsesInputItems([
      // 空名字调用被剔掉 ⇒ 它的结果也不能发
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_bad', type: 'function', function: { name: '', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_bad', content: '不该出现' },
      // 完全没有 call_id 的结果同样剔除（旧代码会发 `call_id: ''`）
      { role: 'tool', content: '也不该出现' },
    ])
    expect(items).toEqual([])
    expect(JSON.stringify(items)).not.toContain('不该出现')
    expect(JSON.stringify(items)).not.toContain('也不该出现')
  })

  it('⚠️ 纯空白的 system 不下发成 instructions（实测会原样变成 "   "）', () => {
    const body = buildAstudioResponsesRequest({
      model: 'xopglm52',
      system: '   ',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(Object.hasOwn(body, 'instructions')).toBe(false)
  })

  it('⚠️ maxTokens=0 必须省略（实测 0 ⇒ 上游 response.failed 归 SERVER ⇒ 白重试 5 次）', () => {
    const body = buildAstudioResponsesRequest({
      model: 'xopglm52',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 0,
      stream: true,
    })
    expect(Object.hasOwn(body, 'max_output_tokens')).toBe(false)
  })

  it('tools 是**扁平**形态（没有 chat 的 function 嵌套）', () => {
    const tools = [{ type: 'function', name: 'get_weather', description: 'weather', parameters: { type: 'object' } }]
    const body = buildAstudioResponsesRequest({ model: 'xopglm52', messages: [], tools, stream: true })
    expect(body.tools).toEqual(tools)
    // ⚠️ 判据必须打在**键**上：`"type":"function"` 这个**值**里也含 `function` 字样，
    //    用 `JSON.stringify(...).not.toContain('function')` 会永远红（同义反复的反面）。
    const first = (body.tools as Array<Record<string, unknown>>)[0]!
    expect(Object.hasOwn(first, 'function')).toBe(false)
    expect(first.name).toBe('get_weather')
  })

  it('maxTokens → max_output_tokens；temperature 原样；effort → reasoning.effort', () => {
    const body = buildAstudioResponsesRequest({
      model: 'xopglm52',
      messages: [],
      maxTokens: 400,
      temperature: 0.3,
      reasoningEffort: 'high',
      stream: true,
    })
    expect(body.max_output_tokens).toBe(400)
    expect(body.max_tokens).toBeUndefined()
    expect(body.temperature).toBe(0.3)
    expect(body.reasoning).toEqual({ effort: 'high' })
  })

  it('effort=none 必须**显式发出去**（省略 ≠ 关闭：实测省略会照开思考）', () => {
    const body = buildAstudioResponsesRequest({ model: 'spark-x2.6', messages: [], reasoningEffort: 'none', stream: true })
    // ⚠️ 判据来自真机：spark-x2.6 省略 reasoning ⇒ reasoning_tokens=49（照开）；
    //    {effort:'none'} ⇒ reasoning_tokens=0。改回「省略」就是让用户白付思考 token。
    expect(body.reasoning).toEqual({ effort: 'none' })
  })

  it('builtin/<base64> 别名被剥成裸 slug（上游只认裸 slug）', () => {
    const body = buildAstudioResponsesRequest({ model: 'builtin/eG9wZ2xtNTI', messages: [], stream: true })
    expect(body.model).toBe('xopglm52')
  })
})

describe('astudioResponsesToChatSse —— 事件翻译', () => {
  it('reasoning_summary_text.delta / output_text.delta 分别成思考块与正文块', async () => {
    const chunks = await collect(sseResponse([
      ['response.created', { type: 'response.created', response: { status: 'in_progress' } }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } }],
      ['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', delta: '想一下', output_index: 0, item_id: 'rs_1' }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1' } }],
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: '答', output_index: 1, item_id: 'msg_1' }],
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: '案', output_index: 1, item_id: 'msg_1' }],
      ['response.completed', {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16, output_tokens_details: { reasoning_tokens: 3 } } },
      }],
    ]))
    expect(textOf(chunks, 'reasoning-delta')).toBe('想一下')
    expect(textOf(chunks, 'text-delta')).toBe('答案')
    expect(chunks.find((c) => c.type === 'usage')?.usage).toEqual({ inputTokens: 11, outputTokens: 5, reasoningTokens: 3 })
    expect(chunks.find((c) => c.type === 'finish')?.reason).toEqual({ kind: 'stop' })
  })

  it('工具调用：added 带 name，参数 delta 按 output_index 归并到槽位', async () => {
    const chunks = await collect(sseResponse([
      ['response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'call_x', call_id: 'call_x', name: 'get_weather' },
      }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', delta: '{"city":', output_index: 0, item_id: '' }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', delta: '"北京"}', output_index: 0, item_id: '' }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_x', name: 'get_weather', arguments: '{"city":"北京"}' } }],
      ['response.completed', { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 20, output_tokens: 9 } } }],
    ]))
    const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
    expect(deltas[0]?.name).toBe('get_weather')
    expect(deltas[0]?.id).toBe('call_x')
    expect(deltas.map((d) => String(d.argumentsDelta ?? '')).join('')).toBe('{"city":"北京"}')
    expect(chunks.find((c) => c.type === 'finish')?.reason).toEqual({ kind: 'tool-calls' })
  })

  it('只发 .done（没有 delta）时补全量 arguments —— 不能靠 delta 才能拿到参数', async () => {
    const chunks = await collect(sseResponse([
      ['response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'call_y', call_id: 'call_y', name: 'get_weather' },
      }],
      ['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', arguments: '{"city":"上海"}', output_index: 0, item_id: 'call_y' }],
      ['response.completed', { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 5 } } }],
    ]))
    const args = chunks.filter((c) => c.type === 'tool-call-delta').map((d) => String(d.argumentsDelta ?? '')).join('')
    expect(args).toBe('{"city":"上海"}')
  })

  it('⚠️⚠️ 分片 delta + `.done` 带全量时**只补差量**（argsSent 不累加 ⇒ 参数翻倍损坏）', async () => {
    // 真机形态（2026-11-17 抓包）：先若干 `function_call_arguments.delta` 分片，
    // 最后 `function_call_arguments.done` 带**完整** arguments。
    // 若 `argsSent` 不累加（或 `.done` 无条件补全量），参数会被拼成
    // `{"city":"北京"}{"city":"北京"}` ⇒ 非法 JSON。
    // 变异 M02（`argsSent.set(slot, ...)` 改成不累加）在改前**全绿** ⇒ 这条是补的真缺口。
    const chunks = await collect(sseResponse([
      ['response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'call_z', call_id: 'call_z', name: 'get_weather' },
      }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', delta: '{"city"', output_index: 0, item_id: 'call_z' }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', delta: ':"北京"}', output_index: 0, item_id: 'call_z' }],
      ['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', arguments: '{"city":"北京"}', output_index: 0, item_id: 'call_z' }],
      ['response.completed', { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 5 } } }],
    ]))
    const args = chunks.filter((c) => c.type === 'tool-call-delta').map((d) => String(d.argumentsDelta ?? '')).join('')
    expect(args).toBe('{"city":"北京"}')
    expect(() => JSON.parse(args) as unknown).not.toThrow()
  })

  it('response.incomplete ⇒ finish 报 max-tokens（被截断不能当正常结束）', async () => {
    const chunks = await collect(sseResponse([
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: '截', output_index: 0, item_id: 'm' }],
      ['response.incomplete', {
        type: 'response.incomplete',
        response: { status: 'incomplete', usage: { input_tokens: 30, output_tokens: 40, output_tokens_details: { reasoning_tokens: 41 } } },
      }],
    ]), 40)
    expect(chunks.find((c) => c.type === 'finish')?.reason).toEqual({ kind: 'max-tokens' })
    expect(chunks.find((c) => c.type === 'usage')?.usage).toMatchObject({ outputTokens: 40, reasoningTokens: 41 })
  })

  it.each([
    { label: '明确为零', fields: {}, expected: { cacheReadTokens: 0 } },
    { label: '未上报', fields: { cache_read_reported: false }, expected: {} },
  ])('Responses 缓存计数为 0 且状态为 $label', async ({ fields, expected }) => {
    const chunks = await collect(sseResponse([
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'x', output_index: 0, item_id: 'm' }],
      ['response.completed', {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, ...fields },
        },
      }],
    ]))
    expect(chunks.find(c => c.type === 'usage')?.usage).toEqual({ inputTokens: 100, outputTokens: 2, ...expected })
  })

  it('缓存命中要从 inputTokens 里扣出来单列（否则缓存命中率显示偏大）', async () => {
    const chunks = await collect(sseResponse([
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'x', output_index: 0, item_id: 'm' }],
      ['response.completed', {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 60 } } },
      }],
    ]))
    expect(chunks.find((c) => c.type === 'usage')?.usage).toEqual({ inputTokens: 40, outputTokens: 2, cacheReadTokens: 60 })
  })

  it('error 事件被归成 LlmError（HTTP 200 + 流内错误不能当成功）', async () => {
    await expect(collect(sseResponse([
      ['error', { type: 'error', error: { message: 'boom', type: 'server_error' } }],
    ]))).rejects.toThrow(/boom/)
  })

  it('⚠️⚠️ 上游断流（一个终态事件都没有）必须报 max-tokens，**不能**补成正常 stop', async () => {
    // 真缺陷（2026-11-17 真机）：翻译器的 `flush` 曾**无条件**补
    // `finish_reason:'stop'` + `data: [DONE]`。共享消费器的截断判据是
    // `truncatedStream = finishReason === undefined && !streamEnded`，
    // 而 `[DONE]` 会把 `streamEnded` 置真 ⇒ 该判据**永不触发**，
    // 半截正文被当成完整回答上报（实测 `fixtures/long.sse` 截前 50% ⇒
    // 输出 120 字 + `{kind:'stop'}` + 零错误；PR 之前 chat 直传同场景判 max-tokens）。
    //
    // 现在 `flush` 什么都不补 ⇒ 消费器按截断处理。
    const chunks = await collect(sseResponse([
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: '半截正文', output_index: 0, item_id: 'm' }],
      // ← 没有 response.completed / response.incomplete / error，流就断了
    ]), 200)
    expect(chunks.find((c) => c.type === 'finish')?.reason).toEqual({ kind: 'max-tokens' })
  })

  it('⚠️ 未知 output_index 的参数字节必须丢弃，**不能**并到 0 号工具（并行工具串台）', async () => {
    // 旧代码是 `toolSlots.get(outputIndex) ?? 0` ⇒ 缺 `output_index`（或值非法）时
    // 两个并行工具的参数会被拼进同一个槽位 ⇒ arguments 变成非法 JSON 或把 B 的参数发给 A，
    // 且**上游零报错**（最难查的一种）。协议里该字段必带 ⇒ 纯防御、结构可达、零实测。
    const chunks = await collect(sseResponse([
      ['response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'call_a', call_id: 'call_a', name: 'tool_a' },
      }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', delta: '{"a":1}', output_index: 0, item_id: 'call_a' }],
      // 第二个调用**没带** output_index，参数是给 tool_b 的
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', delta: '{"b":2}' }],
      // 第三个调用**带**了 output_index，但那个 index 从没 `output_item.added` 过
      // ⇒ 两条守卫必须分开覆盖：① `typeof !== 'number'` ② `toolSlots.get(...) === undefined`
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', delta: '{"c":3}', output_index: 7 }],
      ['response.completed', { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 5 } } }],
    ]))
    const args = chunks.filter((c) => c.type === 'tool-call-delta').map((d) => String(d.argumentsDelta ?? '')).join('')
    expect(args).toBe('{"a":1}') // 只有 A 的参数；B 的 `{"b":2}` 与 C 的 `{"c":3}` 都必须被丢弃
    expect(args).not.toContain('"b"')
    expect(args).not.toContain('"c"')
  })
})


// ════════════════════════════════════════════════════════════════════════
describe('★★★ 生产链路（翻译器 → 消费器）必须逐字还原「重复正文」', () => {
  /**
   * 真缺陷（2026-11-17 实跑复现）：生产链路曾经是
   * `consumeOpenAiSse(astudioWrapIncremental(astudioResponsesToChatSse(response)))`。
   *
   * `astudioWrapIncremental` 的语义是「同一 Id 累积全文 ⇒ 只发差量」，它的
   * `astudioIncrementalDelta` 有一条 `previous.startsWith(incoming) ⇒ ''` ——
   * 而翻译器产出的是**真增量**（协议里每个 `output_text.delta` 就是本帧新增文本）。
   * 于是「本帧恰好是已发全文的前缀」时被当成重复**静默丢弃**：
   *
   * | 上游 delta 序列 | 应得 | 套包装器后 |
   * |---|---|---|
   * | `["a","a","a","b"]` | `aaab` | `ab`（丢两个 a） |
   * | `["The","The"," weather"]` | `TheThe weather` | `The weather` |
   * | `["Same text","Same text"]` | 重复两遍 | 只一遍 |
   *
   * ⚠️ 重复词、重复代码行（`});` 连写）在模型输出里**很常见**，且症状是
   * 「正文少一截、零报错」。旧 chat 通路同样套过它，但那条通路因 `/chat/completions`
   * 恒 404 从未跑过流量 ⇒ 缺陷一直没暴露（本 PR 第一次让它吃到真流量）。
   *
   * 既有 `astudio-stream.spec.ts` 的「标准增量必须逐字透传」只喂 `你`+`好`
   * （两字符不同）⇒ 对该缺陷**零牙**。本组必须走**适配器真实链路**。
   */
  function adapterWith(deltas: readonly string[]): AstudioAdapter {
    const events: Array<[string, unknown]> = [
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_0' } }],
      ...deltas.map((delta): [string, unknown] => ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta }]),
      ['response.completed', { type: 'response.completed', response: { status: 'completed' } }],
    ]
    const fetcher = vi.fn(async () => sseResponse(events)) as unknown as typeof fetch
    return new AstudioAdapter({
      product: ASTUDIO,
      fetchImpl: fetcher,
      resolveCredential: async () => ({ access_token: 'at' } as never),
      warn: () => { /* 静音 */ },
    })
  }

  async function textThroughAdapter(deltas: readonly string[]): Promise<string> {
    const options = {
      provider: 'astudio',
      model: 'xdeepseek-flash-in',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    } as unknown as GenerateOptions
    let text = ''
    for await (const chunk of adapterWith(deltas).stream(options)) {
      if (chunk.type === 'text-delta') text += String((chunk as { text?: unknown }).text ?? '')
    }
    return text
  }

  it('单字符重复：["a","a","a","b"] 必须还原成 aaab', async () => {
    expect(await textThroughAdapter(['a', 'a', 'a', 'b'])).toBe('aaab')
  })

  it('重复词：["The","The"," weather"] 必须还原成 TheThe weather', async () => {
    expect(await textThroughAdapter(['The', 'The', ' weather'])).toBe('TheThe weather')
  })

  it('整段重复：["Same text","Same text"] 必须发两遍', async () => {
    expect(await textThroughAdapter(['Same text', 'Same text'])).toBe('Same textSame text')
  })

  it('前缀重复：["abcdef","abc","def"] 必须还原成 abcdefabcdef', async () => {
    expect(await textThroughAdapter(['abcdef', 'abc', 'def'])).toBe('abcdefabcdef')
  })
})
