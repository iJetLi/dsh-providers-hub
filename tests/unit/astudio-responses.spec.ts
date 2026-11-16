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
 * ① `function_call_arguments.delta` 的 **`item_id` 是空串** ⇒ 只能用 `output_index`
 *    归并到工具槽位。若改成按 `item_id` 归并，参数会被拆进多个槽位 ⇒ 工具调用参数不完整。
 * ② `response.incomplete`（撞输出上限，reasoning 也吃预算）必须映射成 `length`，
 *    否则 harness 会把「被截断」当成正常结束，长回答静默丢失尾部。
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
      { role: 'tool', tool_call_id: 'call_1', content: '晴，28 度' },
    ])
    expect(items).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: '晴，28 度' }])
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

  it('工具调用：added 带 name，参数 delta 的 item_id 为空串时按 output_index 归并', async () => {
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
