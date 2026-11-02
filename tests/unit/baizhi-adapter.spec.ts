/**
 * 百智云适配器行为守卫（全注入、零网络）。
 *
 * 每条用例打一种**没有守卫时会静默通过**的缺陷：
 *
 * ① 无 Key 时报 `MISSING_CREDENTIAL`，而不是发一个 401 出去；
 * ② 鉴权头是 `x-api-key`（写成 `Authorization: Bearer` 会 401，但本地全绿）；
 * ③ 401 换号但**不写冷却**（写了 ⇒ 用户改好 Key 仍要等一小时）；
 * ④ 429 换号**且**写模型级冷却（不写 ⇒ 每次请求都先撞 429 再换号）；
 * ⑤ 400 不换号、直接抛 `BAD_REQUEST`（换号 = 4 次注定失败的请求）；
 * ⑥ 上下文超限从 400 文案里升级成 `CONTEXT_WINDOW_EXCEEDED`；
 * ⑦ 已产出内容的流中断**绝不重放**（重放 = 用户看到重复输出）；
 * ⑧ 未知图片能力 ⇒ `UNSUPPORTED_CONTENT`，且**不读字节**、不静默丢图；
 * ⑨ `thinking.budget_tokens` 严格小于 `max_tokens`（写成 ≥ 直接被上游 400）；
 * ⑩ `listAllModels()` 必须**同步**返回（远端挂了回退内置表，面板不能空）。
 */

import { describe, expect, it, vi } from 'vitest'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import { BAIZHI_MAX_CONTEXT, type BaizhiModelEntry } from '../../src/baizhi-product.js'
import {
  BAIZHI_MAX_ROTATE,
  BaizhiAdapter,
  type BaizhiAdapterOptions,
} from '../../src/baizhi-adapter.js'

const KEY1 = `sk-${'a'.repeat(64)}`
const KEY2 = `sk-${'b'.repeat(64)}`

/** 目录用固定注入，绝不占用推理请求的 fetch 计数。 */
const REMOTE_MODELS: readonly BaizhiModelEntry[] = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: BAIZHI_MAX_CONTEXT },
  { id: 'glm-5.1', name: 'GLM-5.1', supportsImage: true },
  { id: 'mystery-model', name: 'Mystery' },
]

const SSE_OK = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"x","usage":{"input_tokens":46,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"收到"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":87}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

/** 先吐半句再报错：用于验证「已产出内容不重放」。 */
const SSE_PARTIAL_THEN_ERROR = [
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半句"}}',
  '',
  'event: error',
  'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  '',
  '',
].join('\n')

/**
 * 先吐半句、再在 `event: error` 帧里报**额度耗尽**。
 *
 * ⚠️ 与 `SSE_PARTIAL_THEN_ERROR` 的区别在**错误类型**：那个是 `overloaded_error`
 * （`server` 类，不写冷却），这个是额度类 ⇒ 必须写冷却。
 */
const SSE_PARTIAL_THEN_QUOTA = [
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半句"}}',
  '',
  'event: error',
  'data: {"type":"error","error":{"type":"invalid_request_error","message":"积分已耗尽，调用失败"}}',
  '',
  '',
].join('\n')

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'baizhi',
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '你好' }],
    ...overrides,
  }
}

function makeAdapter(overrides: Partial<BaizhiAdapterOptions> = {}): BaizhiAdapter {
  return new BaizhiAdapter({
    slots: async () => [{ id: 'acc-1', apiKey: KEY1 }],
    fetchRemoteModels: async () => REMOTE_MODELS,
    ...overrides,
  })
}

async function drain(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** 断言「这里必须抛错」，并取回 code/message（不抛就一直读到流结束）。 */
async function failureOf(
  iterable: AsyncIterable<StreamChunk>,
): Promise<{ code?: string; message: string }> {
  let caught: unknown
  try {
    for await (const _chunk of iterable) { /* 只关心异常，不关心内容 */ }
  } catch (error) {
    caught = error
  }
  expect(caught, '期望 stream 抛错，但它正常结束了').toBeDefined()
  const error = caught as { code?: string; message?: string }
  return {
    message: error.message ?? '',
    ...error.code === undefined ? {} : { code: error.code },
  }
}

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
}

function headersOf(fetchImpl: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined
  return (init?.headers ?? {}) as Record<string, string>
}

describe('无凭据 / 请求形状', () => {
  it('★ 没有账号 ⇒ MISSING_CREDENTIAL，且一次请求都不发', async () => {
    const fetchImpl = vi.fn()
    const adapter = makeAdapter({ slots: async () => [], fetchImpl: fetchImpl as never })
    const failure = await failureOf(adapter.stream(request()))
    expect(failure.code).toBe('MISSING_CREDENTIAL')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('★ 请求打到 Anthropic 端点，用 x-api-key，body 带 max_tokens/stream', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(SSE_OK))
    const adapter = makeAdapter({ fetchImpl: fetchImpl as never })
    await drain(adapter.stream(request()))

    expect(String(fetchImpl.mock.calls[0]?.[0]))
      .toBe('https://ai-models.app.baizhi.cloud/api/anthropic/v1/messages')
    const headers = headersOf(fetchImpl)
    expect(headers['x-api-key']).toBe(KEY1)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers.authorization).toBeUndefined()

    const body = bodyOf(fetchImpl)
    expect(body.model).toBe('deepseek-v4-pro')
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(4096)
  })

  it('正常流：文本拼接 + finish 块', async () => {
    const adapter = makeAdapter({ fetchImpl: vi.fn(async () => sseResponse(SSE_OK)) as never })
    const chunks = await drain(adapter.stream(request()))
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk as { text: string }).text)
      .join('')
    expect(text).toBe('收到')
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
  })
})

describe('请求级换号', () => {
  it('★ 401 ⇒ 换下一个账号，且**不写冷却**（auth 写冷却会让修好的 Key 白等）', async () => {
    const markLimited = vi.fn(async () => {})
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['x-api-key']
      return key === KEY1 ? jsonResponse('{"error":{"message":"invalid api key"}}', 401) : sseResponse(SSE_OK)
    })
    const adapter = makeAdapter({
      slots: async () => [{ id: 'acc-1', apiKey: KEY1 }, { id: 'acc-2', apiKey: KEY2 }],
      markLimited,
      fetchImpl: fetchImpl as never,
    })
    const chunks = await drain(adapter.stream(request()))
    expect(chunks.length).toBeGreaterThan(0)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(markLimited).not.toHaveBeenCalled()
  })

  it('★ 429 ⇒ 换号 + 写模型级冷却（attempt=1 ⇒ 60s）', async () => {
    const markLimited = vi.fn(async () => {})
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['x-api-key']
      return key === KEY1
        ? jsonResponse('{"error":{"message":"Too Many Requests"}}', 429)
        : sseResponse(SSE_OK)
    })
    const adapter = makeAdapter({
      slots: async () => [{ id: 'acc-1', apiKey: KEY1 }, { id: 'acc-2', apiKey: KEY2 }],
      markLimited,
      now: () => 1_000_000,
      fetchImpl: fetchImpl as never,
    })
    await drain(adapter.stream(request()))
    expect(markLimited).toHaveBeenCalledTimes(1)
    expect(markLimited).toHaveBeenCalledWith('acc-1', 'deepseek-v4-pro', 1_060_000)
  })

  it('★ 400 ⇒ **不换号**，直接抛 BAD_REQUEST（换号只会有 4 次注定失败的请求）', async () => {
    const markLimited = vi.fn(async () => {})
    const fetchImpl = vi.fn(async () => jsonResponse('{"error":{"message":"bad field"}}', 400))
    const adapter = makeAdapter({
      slots: async () => [{ id: 'acc-1', apiKey: KEY1 }, { id: 'acc-2', apiKey: KEY2 }],
      markLimited,
      fetchImpl: fetchImpl as never,
    })
    const failure = await failureOf(adapter.stream(request()))
    expect(failure.code).toBe('BAD_REQUEST')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(markLimited).not.toHaveBeenCalled()
  })

  it('★ 400 带上下文超限文案 ⇒ 升级成 CONTEXT_WINDOW_EXCEEDED（换号救不了）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(
      '{"error":{"message":"This model\'s maximum context length is 1048576 tokens"}}',
      400,
    ))
    const adapter = makeAdapter({
      slots: async () => [{ id: 'acc-1', apiKey: KEY1 }, { id: 'acc-2', apiKey: KEY2 }],
      fetchImpl: fetchImpl as never,
    })
    const failure = await failureOf(adapter.stream(request()))
    expect(failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('★ 5xx ⇒ 换号但不写冷却；全部 5xx ⇒ 抛 SERVER', async () => {
    const markLimited = vi.fn(async () => {})
    const fetchImpl = vi.fn(async () => jsonResponse('upstream down', 503))
    const adapter = makeAdapter({
      slots: async () => [{ id: 'acc-1', apiKey: KEY1 }, { id: 'acc-2', apiKey: KEY2 }],
      markLimited,
      fetchImpl: fetchImpl as never,
    })
    const failure = await failureOf(adapter.stream(request()))
    expect(failure.code).toBe('SERVER')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(markLimited).not.toHaveBeenCalled()
  })

  it('★ transport 错误 ⇒ 换号；单账号时原样抛网络错误', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
    const adapter = makeAdapter({ fetchImpl: fetchImpl as never })
    const failure = await failureOf(adapter.stream(request()))
    expect(failure.message).toMatch(/fetch failed/)
  })

  it('★ 换号有上限：5 个坏账号只打 BAIZHI_MAX_ROTATE 次', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('boom', 500))
    const slots = [1, 2, 3, 4, 5].map((index) => ({
      id: `acc-${index}`,
      apiKey: `sk-${'a'.repeat(62)}${index}`,
    }))
    const adapter = makeAdapter({ slots: async () => slots, fetchImpl: fetchImpl as never })
    await failureOf(adapter.stream(request()))
    expect(fetchImpl).toHaveBeenCalledTimes(BAIZHI_MAX_ROTATE)
  })
})

describe('流中断：已产出内容不重放', () => {
  it('★★ 吐过文本之后流内撞额度 ⇒ **仍要写冷却**（不重发 ≠ 不记账）', async () => {
    /**
     * 2026-11-02 三审 F🔴-1：本适配器原来把 `if (yieldedAny) throw error` 放在
     * `markLimited` **之前** ⇒ 用户已经看到部分输出、随后账号撞额度（长回答最
     * 可能发生）时，那个号**连冷却都不写**，下一轮仍被优先选中、继续撞墙。
     * `monkeycode-adapter.ts` 早就是反序的（注释写着「『不重发』只约束重试、
     * 不约束记账」）⇒ 两个实现语义分叉。
     *
     * ⚠️ 现有用例只覆盖「HTTP 层失败」的冷却，抓不到这条 ⇒ 必须单独守。
     */
    const markLimited = vi.fn(async () => {})
    const fetchImpl = vi.fn(async () => sseResponse(SSE_PARTIAL_THEN_QUOTA))
    const adapter = makeAdapter({
      slots: async () => [{ id: 'acc-1', apiKey: KEY1 }, { id: 'acc-2', apiKey: KEY2 }],
      markLimited,
      now: () => 1_000_000,
      fetchImpl: fetchImpl as never,
    })
    let sawText = false
    let caught: unknown
    try {
      for await (const chunk of adapter.stream(request())) {
        if (chunk.type === 'text-delta') sawText = true
      }
    } catch (error) {
      caught = error
    }
    expect(sawText, '前半句必须先被调用方看到').toBe(true)
    expect(caught).toBeDefined()
    // 记账：额度类错误必须写冷却（否则坏号每轮都被先试一次）。
    expect(markLimited, '已产出内容后撞额度也必须记冷却').toHaveBeenCalledTimes(1)
    expect(markLimited.mock.calls[0]?.[0]).toBe('acc-1')
    // 不重发：已经产出过块，换号重发会让用户看到重复输出。
    expect(fetchImpl, '已经产出内容 ⇒ 绝不换号重发').toHaveBeenCalledTimes(1)
  })

  it('★ 吐过文本之后流内报错 ⇒ 原样抛，且不再动第二个账号', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(SSE_PARTIAL_THEN_ERROR))
    const adapter = makeAdapter({
      slots: async () => [{ id: 'acc-1', apiKey: KEY1 }, { id: 'acc-2', apiKey: KEY2 }],
      fetchImpl: fetchImpl as never,
    })
    let sawText = false
    let caught: unknown
    try {
      for await (const chunk of adapter.stream(request())) {
        if (chunk.type === 'text-delta') sawText = true
      }
    } catch (error) {
      caught = error
    }
    expect(sawText, '前半句必须先被调用方看到').toBe(true)
    expect(caught).toBeDefined()
    // 关键：**没有**重发 —— 否则用户会看到重复输出。
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('★ 200 但回 JSON（非 SSE）⇒ INVALID_REQUEST，不当成 SERVER 被自动重试', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"error":{"message":"model not found"}}', 200))
    const adapter = makeAdapter({ fetchImpl: fetchImpl as never })
    const failure = await failureOf(adapter.stream(request()))
    expect(failure.code).toBe('INVALID_REQUEST')
  })
})

describe('图片输入', () => {
  const imageMessage = {
    role: 'user' as const,
    content: [{ type: 'image' as const, attachment: { attachmentId: 'att-1' } }],
  }

  it('★ 能力未知的模型收到图片 ⇒ UNSUPPORTED_CONTENT，且**不读字节**（不静默丢图）', async () => {
    const readImage = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }))
    const fetchImpl = vi.fn(async () => sseResponse(SSE_OK))
    const adapter = makeAdapter({ readImage, fetchImpl: fetchImpl as never })
    const failure = await failureOf(
      adapter.stream(request({ model: 'mystery-model', messages: [imageMessage] })),
    )
    expect(failure.code).toBe('UNSUPPORTED_CONTENT')
    expect(readImage).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('★ 支持图片的模型 ⇒ 内联成 Anthropic image 块（裸 base64，无 data: 前缀）', async () => {
    const readImage = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }))
    const fetchImpl = vi.fn(async () => sseResponse(SSE_OK))
    const adapter = makeAdapter({ readImage, fetchImpl: fetchImpl as never })
    await drain(adapter.stream(request({ model: 'glm-5.1', messages: [imageMessage] })))
    expect(readImage).toHaveBeenCalledTimes(1)
    const body = bodyOf(fetchImpl)
    const serialized = JSON.stringify(body.messages)
    expect(serialized).toContain('"type":"image"')
    expect(serialized).toContain('"media_type":"image/png"')
    expect(serialized).toContain('"data":"AQID"')
    expect(serialized).not.toContain('data:image/png;base64')
  })
})

describe('思考预算', () => {
  it('★ 会话命名强制关思考（否则 64 token 的预算被思考吃光，标题永远 fallback）', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(SSE_OK))
    const adapter = makeAdapter({ fetchImpl: fetchImpl as never })
    await drain(adapter.stream(request({ purpose: 'session-title', reasoningEffort: 'high' })))
    expect(bodyOf(fetchImpl).thinking).toEqual({ type: 'disabled' })
  })

  it('★ 默认 max_tokens=4096 时 high 档 budget=3072，严格小于 max_tokens', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(SSE_OK))
    const adapter = makeAdapter({ fetchImpl: fetchImpl as never })
    await drain(adapter.stream(request({ reasoningEffort: 'high' })))
    const body = bodyOf(fetchImpl)
    const thinking = body.thinking as { type: string; budget_tokens?: number }
    expect(thinking.type).toBe('enabled')
    expect(thinking.budget_tokens).toBe(3072)
    expect(thinking.budget_tokens as number).toBeLessThan(body.max_tokens as number)
  })

  it('★ 不带思考偏好时不发 thinking 字段（百智云顶层 effort 实测无作用 ⇒ 不暴露档位）', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(SSE_OK))
    const adapter = makeAdapter({ fetchImpl: fetchImpl as never })
    await drain(adapter.stream(request()))
    expect(Object.hasOwn(bodyOf(fetchImpl), 'thinking')).toBe(false)
  })
})

describe('模型目录', () => {
  it('★ listAllModels() 同步返回，且远端为空数组时回退内置兜底表', () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => [] })
    const models = adapter.listAllModels()
    expect(Array.isArray(models)).toBe(true)
    // 同步 = 不是 Promise；没 await 也要能读到内容。
    expect(models.length).toBeGreaterThanOrEqual(12)
    expect(models.some((model) => model.id === 'deepseek-v4-pro')).toBe(true)
  })

  it('★ 远端目录可用时用它（远端成功会触发一次 onCatalogLoaded 广播）', async () => {
    const onCatalogLoaded = vi.fn()
    const adapter = makeAdapter({ onCatalogLoaded })
    const listed = await adapter.listModels('baizhi')
    expect(listed.map((model) => model.id).sort())
      .toEqual(['deepseek-v4-pro', 'glm-5.1', 'mystery-model'])
    expect(onCatalogLoaded).toHaveBeenCalled()
    expect(adapter.listAllModels().map((model) => model.id).sort())
      .toEqual(['deepseek-v4-pro', 'glm-5.1', 'mystery-model'])
  })

  it('★ 远端拉取失败不抛：兜底表顶上（面板不能因为一次 5xx 就空）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('boom') },
    })
    const listed = await adapter.listModels('baizhi')
    expect(listed.length).toBeGreaterThanOrEqual(12)
  })

  it('远端目录里 deepseek 的上下文窗口被带进 resolveModel', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('baizhi', 'deepseek-v4-pro')
    expect(resolved.id).toBe('deepseek-v4-pro')
    expect(resolved.provider).toBe('baizhi')
    expect(resolved.name).toBe('DeepSeek V4 Pro')
    expect(resolved.context?.contextWindow).toBe(BAIZHI_MAX_CONTEXT)
  })

  it('providerInfo 用产品展示名', () => {
    const adapter = makeAdapter()
    expect(adapter.providerInfo('baizhi')).toEqual({ id: 'baizhi', name: '百智云' })
    expect(adapter.providerInfo('')).toEqual({ id: 'baizhi', name: '百智云' })
  })
})

describe('prepareCall：harness 的生产路径', () => {
  it('★ prepareCall 同时给出 model 与可用 stream（只在 stream 里做的校验生产上永远不生效）', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(SSE_OK))
    const adapter = makeAdapter({ fetchImpl: fetchImpl as never })
    const prepared = await adapter.prepareCall('baizhi', 'deepseek-v4-pro')
    expect(prepared.model.id).toBe('deepseek-v4-pro')
    expect(prepared.model.name).toBe('DeepSeek V4 Pro')
    const chunks = await drain(prepared.stream(request()))
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
  })
})
