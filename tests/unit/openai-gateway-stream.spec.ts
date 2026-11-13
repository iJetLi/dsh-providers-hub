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
