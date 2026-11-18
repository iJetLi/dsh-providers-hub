import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { toOpenAiUsage } from '../../src/openai-gateway/usage.js'
import { consumeOpenAiSse } from '../../src/openai-compat.js'
import { collectOpenAiCompletion, toOpenAiSse } from '../../src/openai-gateway/stream.js'
import { collectResponsesResult, toResponsesSse, type OpenAiResponsesRequest } from '../../src/openai-gateway/responses.js'

async function* chunks(values: StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* values
}

/**
 * 网关用量口径。
 *
 * ## 守的是什么（真实缺陷，用户报障 2026-10-04）
 *
 * 接入 Codex 后，同一会话用 `raccoon` 时上下文进度条「搞半天只占 5%」，
 * 换 `trae` 就「正常显示占了 300k 多」。
 *
 * 根因：DSH 的 `inputTokens` **只含未命中缓存**（命中单列 `cacheReadTokens`），
 * 而 OpenAI 官方 `input_tokens` / `prompt_tokens` **含缓存**。旧实现把 DSH 口径
 * 原样发出，Codex 再按官方口径算 `input_tokens - cached_tokens`，
 * `saturating_sub` 夹到 0 ⇒ 总数只剩 output ⇒ 少算上百倍，
 * 且 `model_auto_compact_token_limit` 永不触发。
 *
 * 完整事故记录见 `src/openai-gateway/usage.ts` 文件头。
 */
describe('网关用量口径：DSH（互斥）→ OpenAI 官方（含缓存）', () => {
  it('★ 缓存命中必须计入 inputTokens（本缺陷的核心一行）', () => {
    const usage = toOpenAiUsage({ inputTokens: 770, outputTokens: 633, cacheReadTokens: 207488 })
    // DSH 内部：770 未命中 + 207488 命中 = 208258 真实输入
    expect(usage.inputTokens).toBe(770 + 207488)
    expect(usage.cachedTokens).toBe(207488)
    expect(usage.totalTokens).toBe(770 + 207488 + 633)
  })

  it('★ cachedTokens 是 inputTokens 的**子集**，不是可相加的并列项', () => {
    const usage = toOpenAiUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 })
    // 若把 cached 当并列项会得到 100+900+900=1900（重复计数）。
    expect(usage.inputTokens).toBe(1000)
    expect(usage.cachedTokens).toBe(900)
    expect(usage.cachedTokens).toBeLessThan(usage.inputTokens)
  })

  it('缓存写入也算真实输入（Anthropic 的 cache_creation），但**不算命中**', () => {
    const usage = toOpenAiUsage({ inputTokens: 10, outputTokens: 1, cacheWriteTokens: 5 })
    expect(usage.inputTokens).toBe(15)
    expect(
      Object.hasOwn(usage, 'cachedTokens'),
      '缓存量未上报/非法时这个键必须**缺席** —— 只断言值是 undefined 时，把代码改成「键常在、值为 undefined」也能过（PR #122 审计 M7）',
    ).toBe(false)
  })

  it('未上报缓存计数时仍保留完整 token 用量', () => {
    const usage = toOpenAiUsage({ inputTokens: 326134, outputTokens: 608 })
    expect(usage.inputTokens).toBe(326134)
    expect(
      Object.hasOwn(usage, 'cachedTokens'),
      '缓存量未上报/非法时这个键必须**缺席** —— 只断言值是 undefined 时，把代码改成「键常在、值为 undefined」也能过（PR #122 审计 M7）',
    ).toBe(false)
    expect(usage.totalTokens).toBe(326742)
  })

  it('⚠️ 上游报的 total 若**不含缓存**也不得采信（只会多算、绝不漏算）', () => {
    // 上游报 1000，但含缓存拼出来是 5000 —— 取较大者。
    const usage = toOpenAiUsage({ inputTokens: 1000, outputTokens: 0, totalTokens: 1000, cacheReadTokens: 4000 })
    expect(usage.totalTokens).toBe(5000)
  })

  it('上游报的 total 更大时采信它（gemini 的 totalTokenCount 含思考）', () => {
    const usage = toOpenAiUsage({ inputTokens: 10, outputTokens: 1, totalTokens: 99 })
    expect(usage.totalTokens).toBe(99)
  })

  it('非法缓存计数视为未知，其余非法用量按 0 处理', () => {
    const usage = toOpenAiUsage({
      inputTokens: -5 as never, outputTokens: Number.NaN as never, cacheReadTokens: -1 as never,
    })
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
    expect(
      Object.hasOwn(usage, 'cachedTokens'),
      '缓存量未上报/非法时这个键必须**缺席** —— 只断言值是 undefined 时，把代码改成「键常在、值为 undefined」也能过（PR #122 审计 M7）',
    ).toBe(false)
    expect(usage.totalTokens).toBe(0)
  })

  it('reasoningTokens 为 0 时省略（不给客户端一个假的「有思考」）', () => {
    expect(toOpenAiUsage({ inputTokens: 1, outputTokens: 1 }).reasoningTokens).toBeUndefined()
    expect(toOpenAiUsage({ inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }).reasoningTokens).toBeUndefined()
    expect(toOpenAiUsage({ inputTokens: 1, outputTokens: 1, reasoningTokens: 7 }).reasoningTokens).toBe(7)
  })
})

describe('两个端点的 usage 口径必须一致（只改一个就会「换个 URL 用量就变了」）', () => {
  /** 用户报障里的真实一帧：raccoon 会话末。 */
  const raccoon = { inputTokens: 770, outputTokens: 633, cacheReadTokens: 207488 }
  const request: OpenAiResponsesRequest = { model: 'raccoon/sn-deepseek-v4-1-flash', input: 'hi' }

  it.each([
    { label: '未上报', upstream: {}, cached: undefined },
    { label: '明确为零', upstream: { prompt_tokens_details: { cached_tokens: 0 } }, cached: 0 },
    { label: 'DeepSeek 报正数', upstream: { prompt_cache_hit_tokens: 60 }, cached: 60 },
    { label: '非法计数', upstream: { prompt_tokens_details: { cached_tokens: -1 } }, cached: undefined },
    // 浮点：旧实现 `count()` 是 `Math.trunc`（40.5 → 40），而 PR 初版用
    // `Number.isSafeInteger` 会把它判成「未上报」⇒ `totalTokens` 从 102 掉到 62
    // （input 少算 40）。这是 PR 自述「630 项全绿」时漏掉的唯一一格。
    { label: '浮点（必须截断保留）', upstream: { prompt_tokens_details: { cached_tokens: 40.5 } }, cached: 40 },
  ])('渠道缓存计数 $label 时，两套 API 的流式与非流式都可区分', async ({ upstream, cached }) => {
    const data = [
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 2, ...upstream } },
    ]
    const body = data.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
    const source = () => consumeOpenAiSse(new Response(body), {}, {
      label: 'test', firstTokenTimeoutMs: 5_000, chunkTimeoutMs: 5_000,
    })
    const model = 'qoder/test'
    const chat = await collectOpenAiCompletion(source(), 'chat_test', model)
    const responses = await collectResponsesResult(source(), 'resp_test', model, request)
    const chatFrames = []
    for await (const frame of toOpenAiSse(source(), 'chat_test', model)) {
      if (frame !== 'data: [DONE]\n\n') chatFrames.push(JSON.parse(frame.slice(6)))
    }
    const responsesFrames = []
    for await (const frame of toResponsesSse(source(), 'resp_test', model, request)) {
      if (frame.startsWith('event: response.completed\n')) {
        const dataLine = frame.split('\n').find(line => line.startsWith('data: '))
        responsesFrames.push(JSON.parse(dataLine!.slice(6)))
      }
    }

    for (const usage of [chat.usage, chatFrames.find(frame => frame.usage)?.usage]) {
      expect(usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 })
      if (cached === undefined) expect(usage).not.toHaveProperty('prompt_tokens_details')
      else expect(usage).toHaveProperty('prompt_tokens_details.cached_tokens', cached)
    }
    for (const usage of [responses.usage, responsesFrames[0]?.response.usage]) {
      expect(usage).toMatchObject({
        input_tokens: 100, output_tokens: 2, total_tokens: 102,
        input_tokens_details: { cached_tokens: cached ?? 0 },
      })
      if (cached === undefined) expect(usage).toHaveProperty('cache_read_reported', false)
      else expect(usage).not.toHaveProperty('cache_read_reported')
    }
  })

  it('/v1/responses：Codex 按官方口径反解出的上下文占用 ≈ 真实值', async () => {
    const result = await collectResponsesResult(
      chunks([{ type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'resp_x', 'raccoon/sn-deepseek-v4-1-flash', request,
    )
    const usage = result.usage as Record<string, any>
    // Codex 的算法：input_tokens - cached_tokens（saturating）后仍应等于真实输入。
    const codexInput = usage.input_tokens - usage.input_tokens_details.cached_tokens
    expect(codexInput).toBe(770)                       // 未命中部分，没有被夹到 0
    expect(usage.total_tokens).toBe(208258 + 633)
    // 用户报障时这里只有 1403（= 770+633），少算 148 倍。
    expect(usage.total_tokens).toBeGreaterThan(200000)
  })

  it('/v1/chat/completions：同一帧给出同一个总数（含官方明细字段）', async () => {
    const result = await collectOpenAiCompletion(
      chunks([{ type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'chatcmpl_x', 'raccoon/sn-deepseek-v4-1-flash',
    )
    const usage = result.usage as Record<string, any>
    expect(usage.prompt_tokens).toBe(208258)
    expect(usage.total_tokens).toBe(208891)
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 207488 })
  })

  it('★ 两个端点对同一份用量给出**相同**的 input/output/total', async () => {
    const responses = await collectResponsesResult(
      chunks([{ type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'resp_y', 'raccoon/sn-deepseek-v4-1-flash', request,
    )
    const chat = await collectOpenAiCompletion(
      chunks([{ type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'chatcmpl_y', 'raccoon/sn-deepseek-v4-1-flash',
    )
    const r = responses.usage as Record<string, any>
    const c = chat.usage as Record<string, any>
    expect(r.input_tokens).toBe(c.prompt_tokens)
    expect(r.output_tokens).toBe(c.completion_tokens)
    expect(r.total_tokens).toBe(c.total_tokens)
    expect(r.input_tokens_details.cached_tokens).toBe(c.prompt_tokens_details.cached_tokens)
  })

  it('SSE 两条路径同样带官方明细字段', async () => {
    const responsesFrames: string[] = []
    for await (const item of toResponsesSse(
      chunks([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'resp_z', 'raccoon/sn-deepseek-v4-1-flash', request,
    )) responsesFrames.push(item)
    const completed = JSON.parse(
      responsesFrames.filter(f => f.includes('response.completed')).at(-1)!.split('\n').find(l => l.startsWith('data: '))!.slice(6),
    )
    expect(completed.response.usage.input_tokens).toBe(208258)
    expect(completed.response.usage.total_tokens).toBe(208891)

    const chatFrames: string[] = []
    for await (const item of toOpenAiSse(
      chunks([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'usage', usage: raccoon }, { type: 'finish', reason: { kind: 'stop' } }]),
      'req_z', 'raccoon/sn-deepseek-v4-1-flash',
    )) chatFrames.push(item)
    const usageFrame = chatFrames.map(f => f.startsWith('data: ') ? f.slice(6).trim() : '')
      .filter(f => f.length > 0 && f !== '[DONE]')
      .map(f => JSON.parse(f)).find(d => d.usage !== undefined)
    expect(usageFrame.usage.prompt_tokens).toBe(208258)
    expect(usageFrame.usage.total_tokens).toBe(208891)
    expect(usageFrame.usage.prompt_tokens_details).toEqual({ cached_tokens: 207488 })
    // 私有兼容字段仍在（本仓库多个适配器在读它）。
    expect(usageFrame.usage.prompt_cache_hit_tokens).toBe(207488)
  })
})
