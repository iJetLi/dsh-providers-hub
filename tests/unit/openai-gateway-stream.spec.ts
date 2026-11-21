import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { collectOpenAiCompletion, failureToOpenAiError, toOpenAiSse } from '../../src/openai-gateway/stream.js'

async function* chunks(values: StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* values
}

describe('OpenAI gateway stream conversion', () => {
  it('converts text and usage into OpenAI SSE', async () => {
    const output: string[] = []
    for await (const item of toOpenAiSse(chunks([
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'req-1', 'qoder/qfmodel')) output.push(item)

    expect(output.join('')).toContain('"content":"hello"')
    expect(output.join('')).toContain('"finish_reason":"stop"')
    expect(output.at(-1)).toBe('data: [DONE]\n\n')
  })

  it('converts tool call deltas and finish reason', async () => {
    const output: string[] = []
    for await (const item of toOpenAiSse(chunks([
      { type: 'tool-call-delta', index: 0, id: 'call-1' as never, name: 'read', argumentsDelta: '{' },
      { type: 'tool-call-delta', index: 0, id: 'call-1' as never, argumentsDelta: '}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'req-2', 'qoder/qfmodel')) output.push(item)

    expect(output.join('')).toContain('"tool_calls"')
    expect(output.join('')).toContain('"finish_reason":"tool_calls"')
  })

  it('aggregates a non-stream response', async () => {
    const response = await collectOpenAiCompletion(chunks([
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'text-delta', index: 0, text: 'b' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]), 'req-3', 'qoder/qfmodel')
    expect(response).toMatchObject({ id: 'req-3', model: 'qoder/qfmodel' })
    expect(response.choices[0].message.content).toBe('ab')
    expect(response.choices[0].finish_reason).toBe('length')
  })

  /**
   * 排队提示帧必须能穿到下游。
   *
   * ## 守的是什么
   *
   * `visible` 档只发空心跳时，下游只能判断「连接还活着」，无法知道**在排队**。
   * 提示帧把排队这件事本身带出去（`qoder_queue`），而标准 OpenAI SDK 按协议
   * 忽略未知字段 —— 两边都不受损。
   *
   * ## 最常见的假绿
   *
   * 只断言 `output.join('')` 含 `qoder_queue`：把它塞进 error 帧同样能过，
   * 但那是**另一条出口**。故这里同时锚定「正文照常产出」与「delta 为空」。
   */
  /**
   * 提示帧的形状是「合法 `text-delta` + 私有字段 `qoderQueue`」。
   *
   * ⚠️ 为什么不是 `type: 'queue-notice'`：`StreamChunk` 是 `dsh-llm` 的闭合联合，
   * 宿主两条组装器的 `default` 都是 `assertNever` ⇒ 联合外类型**硬抛**
   *（2026-11-13 实测：`unreachable variant in BlockAssembler.push`）。
   */
  function noticeFrame(queue: Record<string, unknown>): StreamChunk {
    return { type: 'text-delta', index: 0, text: '', qoderQueue: queue } as unknown as StreamChunk
  }

  /** 把 SSE 行解析成 JSON 帧（跳过 `[DONE]` 与空行）。 */
  function parseSseFrames(output: string[]): Array<Record<string, unknown>> {
    return output
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
  }

  it('排队提示帧 → qoder_queue 字段（且不污染正文）', async () => {
    const output: string[] = []
    for await (const item of toOpenAiSse(chunks([
      noticeFrame({ queued: true, attempt: 1, waitMs: 10_000, modelKey: 'qfmodel' }),
      { type: 'text-delta', index: 0, text: '排到了' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'req-q', 'qoder/qfmodel')) output.push(item)

    // ⚠️ 判据必须**逐帧**，不能用 `output.join('').toContain(...)`：
    // finish 帧同样含 `"delta":{}`，提示帧被删掉后那条断言仍然是绿的
    //（2026-11-13 对抗审计实测）。
    const frames = parseSseFrames(output)
    const notices = frames.filter((frame) => 'qoder_queue' in frame)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      choices: [{ index: 0, delta: {} }],
      qoder_queue: { queued: true, attempt: 1, waitMs: 10_000, modelKey: 'qfmodel' },
    })
    // 提示帧不得贡献正文
    expect(JSON.stringify(notices[0])).toContain('"delta":{}')
    // 正文照常产出
    expect(frames.some((frame) => JSON.stringify(frame).includes('"content":"排到了"'))).toBe(true)
  })

  it('非流式聚合忽略排队提示帧（不得污染 message.content）', async () => {
    const response = await collectOpenAiCompletion(chunks([
      noticeFrame({ queued: true, attempt: 1 }),
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'req-q2', 'qoder/qfmodel')

    expect(response.choices[0].message.content).toBe('ok')
    expect(JSON.stringify(response)).not.toContain('qoder_queue')
  })
})

/**
 * 上游自带状态码必须能穿过网关。
 *
 * ## 守的是什么
 *
 * `LlmError` 的 `status` **不是顶层属性**（实测 `'status' in e === false`），
 * 它只落在 `e.failure.status`。网关若只读顶层，上游声明的 404 会一路退化成
 * 502 —— 而 502 在 OpenAI 客户端眼里是「服务端故障」⇒ **会被自动重试**，
 * 但「模型名写错」是确定性失败，重试纯白耗额度（`model-errors.ts:14-19`）。
 */
describe('上游状态码穿透（LlmError.failure.status）', () => {
  /** 上游拒绝未知模型名时的真实形态：`INVALID_REQUEST` + 404。 */
  const rejection = () => new LlmError('gemini: 模型 "gemini-9.9-fake" 不在本 provider 目录中', 'INVALID_REQUEST', { status: 404 })

  it('failureToOpenAiError：读得到 failure.status（顶层读不到）', () => {
    const error = rejection()
    // 先钉死前提：顶层确实没有 status，否则这条用例就白测了。
    expect('status' in error).toBe(false)
    expect(error.failure.status).toBe(404)
    expect(failureToOpenAiError(error).status).toBe(404)
  })

  it('failureToOpenAiError：没有状态码的普通错误仍是 502', () => {
    expect(failureToOpenAiError(new Error('boom')).status).toBe(502)
    expect(failureToOpenAiError(new LlmError('boom', 'SERVER')).status).toBe(502)
  })

  it('toOpenAiSse：错误帧里带 status: 404（流已发 200，只能写在帧里）', async () => {
    const output: string[] = []
    for await (const item of toOpenAiSse(chunks([
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind: 'error', failure: rejection().failure } },
    ]), 'req-4', 'gemini/gemini-9.9-fake')) output.push(item)

    const frame = output.find((item) => item.includes('"error"'))
    expect(frame).toBeDefined()
    const error = JSON.parse(frame!.slice('data: '.length)).error
    expect(error.status).toBe(404)
    expect(error.code).toBe('model_not_found')
    expect(error.type).toBe('invalid_request_error')
  })

  it('collectOpenAiCompletion：非流式抛出 404，不是会被重试的 502', async () => {
    const thrown = await collectOpenAiCompletion(chunks([
      { type: 'finish', reason: { kind: 'error', failure: rejection().failure } },
    ]), 'req-5', 'gemini/gemini-9.9-fake').then(() => undefined, (error: unknown) => error)
    expect(failureToOpenAiError(thrown).status).toBe(404)
  })

  it('⚠️ 不带状态码的上游错误不受影响（仍是 502，保留重试机会）', async () => {
    const thrown = await collectOpenAiCompletion(chunks([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'upstream exploded' } } },
    ]), 'req-6', 'qoder/qfmodel').then(() => undefined, (error: unknown) => error)
    expect(failureToOpenAiError(thrown).status).toBe(502)
  })
})

/**
 * ★★★ GitHub issue #134 复现（2026-11-21）。
 *
 * `/v1/responses` 与 `/v1/chat/completions` 共用同一条 `ctx.llm.stream()`，
 * 但**只有 Responses 侧采纳了权威帧 `block-end`**（`responses.ts` 的
 * `applyItemChunk` → `item.override`）；Chat 侧 `stream.ts:182-184` 直接
 * `return undefined` 丢掉它。
 *
 * ⇒ 所有适配器在 `block-end` 里做的**归一化**（空参数补 `{}`、DSML 清洗、
 * 残缺 JSON 原样、正文去重/切分归位）在 Chat 路由上**整层丢失**。
 *
 * 这组用例先**复现**（预期红），修复后转绿 —— 后续任何一处回退都会让它变红。
 */
describe('issue #134：Chat 路由必须采纳 block-end 的权威值', () => {
  it('★★★ 无参数工具：arguments 必须是 block-end 的 "{}"，不是 ""', async () => {
    const response = await collectOpenAiCompletion(chunks([
      { type: 'tool-call-delta', index: 0, id: 'call_1' as never, name: 'list_dir' as never, argumentsDelta: '' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call_1' as never, name: 'list_dir' as never, arguments: '{}' },
      } as never,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'req-134-1', 'codearts/glm-5.3')

    expect(
      (response.choices[0]!.message as never as { tool_calls: Array<{ function: { arguments: string } }> })
        .tool_calls[0]!.function.arguments,
      'openai-node 在 JSON.parse("") 处会抛 Unexpected end of JSON input',
    ).toBe('{}')
  })

  it('★★★ 空串 name 的分片不得盖掉已识别的真名', async () => {
    const response = await collectOpenAiCompletion(chunks([
      { type: 'tool-call-delta', index: 0, id: 'call_1' as never, name: 'Bash' as never, argumentsDelta: '{"a"' },
      { type: 'tool-call-delta', index: 0, id: 'call_1' as never, name: '' as never, argumentsDelta: ':1}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'req-134-2', 'buddy/glm-5.2')

    expect(
      (response.choices[0]!.message as never as { tool_calls: Array<{ function: { name: string } }> })
        .tool_calls[0]!.function.name,
      '空串是真实致病形态（不是 undefined），会把真名抹成 "" ⇒ 客户端报 unknown tool',
    ).toBe('Bash')
  })

  it('★★★ 正文占块 0、工具占块 1：出站 index 必须是稠密的 0', async () => {
    const output: string[] = []
    for await (const item of toOpenAiSse(chunks([
      { type: 'text-delta', index: 0, text: 'thinking' },
      { type: 'tool-call-delta', index: 1, id: 'call_9' as never, name: 'Read' as never, argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'req-134-3', 'qoder/qfmodel')) output.push(item)

    const joined = output.join('')
    // OpenAI 规范：tool_calls[].index 是本帧调用在数组中的位置（0-based 稠密）
    expect(joined, '出站 index 直接转发 DSH 块索引（1）会让客户端组装出空洞').toContain('"index":0')
    expect(joined).not.toContain('"index":1')
  })

  it('★★★ 重复的 block-end 不得让参数累加两遍', async () => {
    const response = await collectOpenAiCompletion(chunks([
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, name: 'X' as never, argumentsDelta: '{"a":1}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as never, name: 'X' as never, arguments: '{"a":1}' } } as never,
      // 上游重试导致同一 index 重排（真实形态，见 aggregate-adapter）
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, argumentsDelta: '{"a":1}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as never, name: 'X' as never, arguments: '{"a":1}' } } as never,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'req-134-4', 'qoder/qfmodel')

    expect(
      (response.choices[0]!.message as never as { tool_calls: Array<{ function: { arguments: string } }> })
        .tool_calls[0]!.function.arguments,
      '块收尾后同 index 的 delta 必须被忽略（否则参数拼两遍）',
    ).toBe('{"a":1}')
  })
})

/**
 * ★★★ 流式与非流式必须给出**等价**的 tool_calls（issue #134 自查发现的缺口）。
 *
 * 非流式靠 `argumentsOverride` 拿到 `'{}'`；流式**不能把已发帧收回**，
 * 但如果客户端「一个参数字符都没收到过」，就可以在 `block-end` 补一帧权威值。
 *
 * ⚠️ 这条用例是**流式侧**的唯一防线：`collectOpenAiCompletion` 的用例再多，
 * 也照不到「客户端按增量累积」这个真实消费方式（openai-node 就是这么攒的）。
 */
describe('issue #134：流式交付的 tool_calls 必须与客户端累积结果等价', () => {
  /** 按 openai-node 的语义把 SSE 增量攒成最终值。 */
  function accumulate(sse: string): { content: string; tools: Array<{ index: number; id: string; name: string; args: string }> } {
    let content = ''
    const tools: Array<{ index: number; id: string; name: string; args: string }> = []
    for (const line of sse.split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
      let ev: { choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> }
      try { ev = JSON.parse(line.slice(6)) } catch { continue }
      const delta = ev.choices?.[0]?.delta
      if (delta === undefined) continue
      if (typeof delta.content === 'string') content += delta.content
      for (const tc of delta.tool_calls ?? []) {
        let slot = tools.find((t) => t.index === tc.index)
        if (slot === undefined) { slot = { index: tc.index ?? 0, id: '', name: '', args: '' }; tools.push(slot) }
        if (typeof tc.id === 'string') slot.id = tc.id
        if (typeof tc.function?.name === 'string' && tc.function.name.length > 0) slot.name = tc.function.name
        if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments
      }
    }
    return { content, tools }
  }

  it('★★★ 无参数工具：流式累积必须是 "{}"（不是 ""）', async () => {
    const seq: StreamChunk[] = [
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, name: 'list_dir' as never, argumentsDelta: '' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as never, name: 'list_dir' as never, arguments: '{}' } } as never,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const out: string[] = []
    for await (const item of toOpenAiSse(chunks(seq), 'r', 'm')) out.push(item)
    expect(accumulate(out.join('')).tools[0]!.args, '客户端 JSON.parse("") 会抛错').toBe('{}')
  })

  it('★★★ 已发过参数时**不得**补发（否则客户端拼成 {...{...}）', async () => {
    const seq: StreamChunk[] = [
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, name: 'X' as never, argumentsDelta: '{"a":1}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as never, name: 'X' as never, arguments: '{"a":1}' } } as never,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const out: string[] = []
    for await (const item of toOpenAiSse(chunks(seq), 'r', 'm')) out.push(item)
    expect(accumulate(out.join('')).tools[0]!.args, '补发会让已发增量重复拼接').toBe('{"a":1}')
  })

  it('★★★ 流式与非流式的 (index, id, name) 必须逐格一致', async () => {
    const seq: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'tool-call-delta', index: 1, id: 'A' as never, name: 'Alpha' as never, argumentsDelta: '{"x":1}' },
      { type: 'tool-call-delta', index: 2, id: 'B' as never, name: 'Beta' as never, argumentsDelta: '' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } } as never,
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'A' as never, name: 'Alpha' as never, arguments: '{"x":1}' } } as never,
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'B' as never, name: 'Beta' as never, arguments: '{}' } } as never,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const out: string[] = []
    for await (const item of toOpenAiSse(chunks(seq), 'r', 'm')) out.push(item)
    const streamed = accumulate(out.join(''))
    const nonStream = await collectOpenAiCompletion(chunks(seq), 'r', 'm')
    const msg = nonStream.choices[0]!.message as never as {
      content: string | null
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
    }
    expect(streamed.content).toBe(msg.content ?? '')
    expect(streamed.tools.map((t) => [t.index, t.id, t.name]))
      .toEqual((msg.tool_calls ?? []).map((t, i) => [i, t.id, t.function.name]))
  })
})

/**
 * ★★★ 让「权威覆盖 / closed / 空名剔除 / id 判据」四条**各自可被单独证伪**。
 *
 * 上面那组用例有个共同弱点（变异实测暴露）：它们挑的场景里
 * **修复与缺陷恰好同值**，于是删掉判据也全绿 ——
 *   · 空参数场景：`normalizeToolArguments('')` 也是 `'{}'` ⇒ 取不取 override 一样；
 *   · 重复 block-end：`argumentsOverride` 掩盖了 delta 累积污染。
 * ⇒ 这组用例刻意让「修复值」与「缺陷值」**不同**（本仓库记过的同型教训：
 *    zcode 的 `action.type` 判据被 `plan_id` 那条腿挡住 ⇒ 用例无牙）。
 */
describe('issue #134：四条判据各自可单独证伪', () => {
  it('★★★ `block-end` 的 override 优先于 delta 累积（残缺 raw vs 完整权威值）', async () => {
    const response = await collectOpenAiCompletion(chunks([
      // delta 只拼到残缺 JSON（真实形态：分片在流被掐断处停住）
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, name: 'Write' as never, argumentsDelta: '{"path":"a"' },
      // block-end 给出**完整**权威值
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as never, name: 'Write' as never, arguments: '{"path":"a","body":"b"}' } } as never,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'r', 'm')
    const args = (response.choices[0]!.message as never as { tool_calls: Array<{ function: { arguments: string } }> })
      .tool_calls[0]!.function.arguments
    // 取 override ⇒ 完整；不取 ⇒ 残缺 '{"path":"a"'（isTruncated 保持原样）
    expect(args).toBe('{"path":"a","body":"b"}')
  })

  it('★★★ `block-end` 收尾后，同 index 的 delta **不得再发给客户端**（流式）', async () => {
    const out: string[] = []
    for await (const item of toOpenAiSse(chunks([
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, name: 'X' as never, argumentsDelta: '{"a":1}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as never, name: 'X' as never, arguments: '{"a":1}' } } as never,
      // 畸形流：收尾后又来一片（上游重试重排）
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, argumentsDelta: '{"b":2}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'r', 'm')) out.push(item)

    const joined = out.join('')
    // ⚠️ SSE 里的参数是**转义过**的（`"arguments":"{\"a\":1}"`），断言必须带转义，
    //    否则 `toContain('"a":1')` 永远不成立（我上一版就写错过一次）。
    expect(joined, '收尾后的 delta 必须被丢弃，否则客户端累积成两个 JSON 相拼').not.toContain('\\"b\\":2')
    expect(joined).toContain('\\"a\\":1')
  })

  it('★★★ 空名工具**不得**出现在非流式输出（客户端会报 unknown tool ""）', async () => {
    const response = await collectOpenAiCompletion(chunks([
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, name: '' as never, argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'r', 'm')
    expect((response.choices[0]!.message as never as { tool_calls?: unknown[] }).tool_calls).toBeUndefined()
  })

  it('★★ 空白 id 分片不得盖掉已解析的 id（`||` 挡不住 `\'   \'`）', async () => {
    const response = await collectOpenAiCompletion(chunks([
      { type: 'tool-call-delta', index: 0, id: 'call_real' as never, name: 'X' as never, argumentsDelta: '{}' },
      { type: 'tool-call-delta', index: 0, id: '   ' as never, argumentsDelta: '' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'r', 'm')
    expect((response.choices[0]!.message as never as { tool_calls: Array<{ id: string }> }).tool_calls[0]!.id).toBe('call_real')
  })
})

/**
 * ★★★ 两处**我自己引入的回归**（2026-11-21 正向审计，改前是对的）。
 *
 * 都是「加了 override 之后，把原来的累加语义打掉了」：
 * ① 单值 `contentOverride` 在**多正文块**时整段丢内容（Anthropic 族按
 *    `content_block` index 建块、一块一个 `block-end`，是合法可达形态）；
 * ② `block-end` 没有 first-close-wins ⇒ 畸形流的第二个权威值会覆盖第一个，
 *    而非流式已给出的值与客户端手里的值分叉。
 */
describe('issue #134 回归：多正文块 / first-close-wins', () => {
  it('★★★ 多个正文块 ⇒ 非流式必须**拼接全部**，不得只剩最后一块', async () => {
    const response = await collectOpenAiCompletion(chunks([
      { type: 'text-delta', index: 0, text: 'A' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'A' } } as never,
      { type: 'text-delta', index: 1, text: 'B' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'B' } } as never,
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'r', 'm')
    expect(response.choices[0]!.message.content, '单值 override 会让这里变成 "B"').toBe('AB')
  })

  it('★★★ 逆序收尾同样不得丢内容', async () => {
    const response = await collectOpenAiCompletion(chunks([
      { type: 'text-delta', index: 0, text: 'A' },
      { type: 'text-delta', index: 1, text: 'B' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'B' } } as never,
      { type: 'block-end', index: 0, block: { type: 'text', text: 'A' } } as never,
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'r', 'm')
    // 按块号升序拼接 ⇒ "AB"（不是按收尾顺序的 "BA"）
    expect(response.choices[0]!.message.content).toBe('AB')
  })

  it('★★★ 第二个 `block-end` 不得再覆盖（first-close-wins）', async () => {
    const response = await collectOpenAiCompletion(chunks([
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, name: 'X' as never, argumentsDelta: '{"a":1}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as never, name: 'X' as never, arguments: '{"a":1}' } } as never,
      // 畸形：同一块第二次收尾，参数不同
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as never, name: 'X' as never, arguments: '{"a":999}' } } as never,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'r', 'm')
    const args = (response.choices[0]!.message as never as { tool_calls: Array<{ function: { arguments: string } }> })
      .tool_calls[0]!.function.arguments
    expect(args, '第二次收尾若覆盖，非流式与客户端手里（{"a":1}）就分叉了').toBe('{"a":1}')
  })
})

/**
 * ★★★ 流式侧空名的**协议安全解**（2026-11-21 正向审计 P1-2）。
 *
 * 「名字只在 `block-end` 到达」是正常形态（`protocol-wire.md` 有实测记录）。
 * 旧实现照发 `tool_calls` 帧但 `function` 里没有 `name` ⇒ 客户端攒出
 * `name: ''`，那是 **IKLRIK 的会话级损坏形态**（`unknown tool ""` + 坏块
 * 入会话 + 每轮重放 ⇒ 会话报废）。
 *
 * 流式**没法撤回已发帧** ⇒ 唯一安全解是首帧推迟到名字可用（代价：名字晚到的
 * 调用丧失参数增量流式，首帧一次性带出累积参数）。与 Responses 的
 * `toolAddedEvent` 同口径。
 */
describe('issue #134：流式空名的安全解', () => {
  function accumulateTools(sse: string): Array<{ id: string; name: string; args: string }> {
    const tools: Array<{ id: string; name: string; args: string }> = []
    for (const line of sse.split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
      let ev: { choices?: Array<{ delta?: { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> }
      try { ev = JSON.parse(line.slice(6)) } catch { continue }
      for (const tc of ev.choices?.[0]?.delta?.tool_calls ?? []) {
        let slot = tools[tc.index ?? 0]
        if (slot === undefined) { slot = { id: '', name: '', args: '' }; tools[tc.index ?? 0] = slot }
        if (typeof tc.id === 'string') slot.id = tc.id
        if (typeof tc.function?.name === 'string' && tc.function.name.length > 0) slot.name = tc.function.name
        if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments
      }
    }
    return tools
  }

  it('★★★ 名字始终不可用 ⇒ 流式**一帧都不发** tool_calls', async () => {
    const out: string[] = []
    for await (const item of toOpenAiSse(chunks([
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, name: '' as never, argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'r', 'm')) out.push(item)
    expect(accumulateTools(out.join('')), 'name="" 的帧会让客户端报 unknown tool').toEqual([])
  })

  it('★★★ 名字晚到 ⇒ 首帧一次性带出全部累积参数（不丢增量）', async () => {
    const seq: StreamChunk[] = [
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, name: '' as never, argumentsDelta: '{"a"' },
      { type: 'tool-call-delta', index: 0, id: 'c1' as never, name: '' as never, argumentsDelta: ':1}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as never, name: 'Run' as never, arguments: '{"a":1}' } } as never,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const out: string[] = []
    for await (const item of toOpenAiSse(chunks(seq), 'r', 'm')) out.push(item)
    expect(accumulateTools(out.join('')), '名字可用后必须把此前累积的参数补上').toEqual([
      { id: 'c1', name: 'Run', args: '{"a":1}' },
    ])
  })
})

/**
 * ★★ 只有 `block-end` 的正文块，流式必须**补发**（正向审计 P2-2）。
 *
 * 「只发 `block-end` 不发 delta」在 codearts 链路可达（`llm-adapter` 的
 * `visible` 回退）。旧实现只把权威值记进 override、流式一帧不发 ⇒
 * **客户端收到空回答**（而非流式出口是对的，所以这个问题只在流式可见）。
 */
describe('issue #134：block-end-only 正文的流式补发', () => {
  it('★★★ 无 delta、只有 block-end(text) ⇒ 流式补一帧 content', async () => {
    const out: string[] = []
    for await (const item of toOpenAiSse(chunks([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'only-end' } } as never,
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'r', 'm')) out.push(item)
    expect(out.join(''), '不补发就是空回答').toContain('"content":"only-end"')
  })

  it('★★★ 已有 delta 的块**不得**再补发（否则客户端重复拼接）', async () => {
    const out: string[] = []
    for await (const item of toOpenAiSse(chunks([
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } } as never,
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'r', 'm')) out.push(item)
    const joined = out.join('')
    expect(joined.match(/"content":"hello"/g)?.length, '正文只应出现一次').toBe(1)
  })
})
