/**
 * MonkeyCode 适配器行为守卫（全注入、零网络）。
 *
 * ## 为什么现在才补
 *
 * `src/monkeycode-adapter.ts` 是本 provider 唯一「决定请求打到哪、失败换不换号、
 * 记不记冷却」的地方，但它此前**整份没有 spec**；`classifyMonkeycodeFailure` 在
 * 全仓测试里零命中。后果是 2026-11-02 二审里那批修复（5xx 新增 `'server'` 类、
 * 200-非-SSE 分支接上 `shouldRotate`、400 上下文超限翻译、流内冷却记账提前）
 * 全部处于**零直接守卫**状态 —— 任何人把它们改回去，`tsc` 和全量测试都不会响。
 *
 * 每条用例打一种「没有守卫时会静默通过」的缺陷：
 *
 * ① 无账号时先报 `MISSING_CREDENTIAL`，而不是发一个没有签名头的请求出去；
 * ② 缺 `signing_secret` 时**提前**抛（网关会以 403 invalid ohmyagent request 拒绝每一次）；
 * ③ 请求打到网关 `/v1/messages`，带 `x-api-key` 与 `X-OhMyAgent-Signature: v1=…`；
 * ④ 401 换号但**不写冷却**（写了 ⇒ 用户改好 Key 仍要等一小时）；
 * ⑤ 429 / 402 换号**且**写模型级冷却（不写 ⇒ 每次请求都先撞一次失败）；
 * ⑥ 400 参数错**不换号**、只发一次（换号 = 4 次注定失败的请求）；
 * ⑦ 400 上下文超限翻成 `CONTEXT_WINDOW_EXCEEDED`（落 `INVALID_REQUEST` 时宿主既不重试也不压缩）；
 * ⑧ 5xx 判 `server` ⇒ 换号（2026-11-02 新增的类，不加就是「白重试 5 次同一账号」）；
 * ⑨ 200 但正文是「积分已耗尽」的 JSON ⇒ **仍要换号**（不是一律抛）；
 * ⑩ 200 但正文是签名类错误 ⇒ 直接抛 `INVALID_REQUEST`，不把整池打一遍；
 * ⑪ 已产出内容的流中断**绝不重放**（重放 = 用户看到重复输出）；
 * ⑫ `listAllModels()` 必须**同步**返回内置表（面板不能空）。
 */

import { describe, expect, it, vi } from 'vitest'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import {
  MonkeycodeAdapter,
  type MonkeycodeAdapterOptions,
  type MonkeycodeSlot,
} from '../../src/monkeycode-adapter.js'
import type { MonkeycodeCredential } from '../../src/monkeycode.js'
import { MONKEYCODE } from '../../src/monkeycode-product.js'

const KEY1 = `oma_${'a'.repeat(32)}`
const KEY2 = `oma_${'b'.repeat(32)}`
const SECRET1 = 'secret-1'
const SECRET2 = 'secret-2'

const CRED1: MonkeycodeCredential = { access_token: KEY1, signing_secret: SECRET1 }
const CRED2: MonkeycodeCredential = { access_token: KEY2, signing_secret: SECRET2 }

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

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

function slot(accountId: string, credential: MonkeycodeCredential): MonkeycodeSlot {
  return { accountId, credential }
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: MONKEYCODE.id,
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    ...overrides,
  }
}

function makeAdapter(overrides: Partial<MonkeycodeAdapterOptions> = {}): MonkeycodeAdapter {
  return new MonkeycodeAdapter({
    credentialRef: 'MONKEYCODE_ACCESS_TOKEN' as never,
    slots: async () => [slot('acc-1', CRED1)],
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
    for await (const _chunk of iterable) {
      // 只关心异常，不关心内容
    }
  } catch (error) {
    caught = error
  }
  expect(caught, '期望 stream 抛错，但它正常结束了').toBeDefined()
  const error = caught as { code?: string; message?: string }
  return {
    message: error.message ?? '',
    ...(error.code === undefined ? {} : { code: error.code }),
  }
}

/**
 * ⚠️ `vi.fn()` 的 `mock.calls` 类型是**空元组**（`[]`）—— 直接下标会报
 * `TS2493: Tuple type '[]' of length '0' has no element at index '0'`。
 * 这里先断言成「真实的 fetch 调用形状」再取，别在调用点上到处写 `as never`。
 */
type FetchCall = readonly [unknown, RequestInit | undefined]

function fetchCalls(fetchImpl: ReturnType<typeof vi.fn>): readonly FetchCall[] {
  return fetchImpl.mock.calls as unknown as readonly FetchCall[]
}

function callHeaders(fetchImpl: ReturnType<typeof vi.fn>, index = 0): Record<string, string> {
  const init = fetchCalls(fetchImpl)[index]?.[1]
  return (init?.headers ?? {}) as Record<string, string>
}

function fakePool(): { updateModelRateLimit: ReturnType<typeof vi.fn> } {
  return { updateModelRateLimit: vi.fn(async () => {}) }
}

describe('凭据与请求形状', () => {
  it('★ 没有账号 ⇒ MISSING_CREDENTIAL，且一次请求都不发', async () => {
    const fetchImpl = vi.fn()
    const adapter = makeAdapter({ slots: async () => [], fetchImpl: fetchImpl as never })
    const failure = await failureOf(adapter.stream(request()))
    expect(failure.code).toBe('MISSING_CREDENTIAL')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('★★ 缺 signing_secret ⇒ 提前抛错，一次请求都不发（发出去也是 403）', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(SSE_OK))
    const adapter = makeAdapter({
      slots: async () => [slot('acc-1', { access_token: KEY1 })],
      fetchImpl: fetchImpl as never,
    })
    const failure = await failureOf(adapter.stream(request()))
    expect(failure.message).toContain('signing_secret')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('请求打到网关 /v1/messages，带 x-api-key 与 v1= 前缀的 HMAC 签名', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(SSE_OK))
    const adapter = makeAdapter({ fetchImpl: fetchImpl as never })
    await drain(adapter.stream(request()))

    expect(String(fetchCalls(fetchImpl)[0]?.[0])).toBe(
      'https://proxy.monkeycode-ai.com/v1/messages',
    )
    const headers = callHeaders(fetchImpl)
    expect(headers['x-api-key']).toBe(KEY1)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    // 签名必须是 **v1=** 前缀 + 64 位 hex；写成裸 hex 会被网关判 invalid。
    expect(headers['X-OhMyAgent-Signature']).toMatch(/^v1=[0-9a-f]{64}$/)
    // 网关不透传 Bearer：混用会让请求一律 401。
    expect(headers.authorization).toBeUndefined()

    const body = JSON.parse(String(fetchCalls(fetchImpl)[0]?.[1]?.body))
    expect(body.model).toBe('deepseek-flash')
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

describe('请求级换号与冷却', () => {
  it('★ 401 ⇒ 换下一个账号，且**不写冷却**（auth 写冷却会让修好的 Key 白等）', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['x-api-key']
      return key === KEY1
        ? jsonResponse('{"error":"invalid ohmyagent request"}', 401)
        : sseResponse(SSE_OK)
    })
    const pool = fakePool()
    const adapter = makeAdapter({
      slots: async () => [slot('acc-1', CRED1), slot('acc-2', CRED2)],
      accountPool: pool as never,
      fetchImpl: fetchImpl as never,
    })
    const chunks = await drain(adapter.stream(request()))
    expect(chunks.length).toBeGreaterThan(0)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(pool.updateModelRateLimit).not.toHaveBeenCalled()
  })

  it('★ 429 ⇒ 换号并写模型级冷却（不写 ⇒ 每次请求都先撞一次 429）', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['x-api-key']
      return key === KEY1
        ? jsonResponse('{"error":"rate limited"}', 429)
        : sseResponse(SSE_OK)
    })
    const pool = fakePool()
    const adapter = makeAdapter({
      slots: async () => [slot('acc-1', CRED1), slot('acc-2', CRED2)],
      accountPool: pool as never,
      fetchImpl: fetchImpl as never,
    })
    await drain(adapter.stream(request()))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(pool.updateModelRateLimit).toHaveBeenCalledTimes(1)
    expect(pool.updateModelRateLimit.mock.calls[0]?.[0]).toBe('acc-1')
  })

  it('★ 402 积分耗尽 ⇒ 换号并写 24 小时冷却', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['x-api-key']
      return key === KEY1
        ? new Response('积分已耗尽，调用失败', { status: 402 })
        : sseResponse(SSE_OK)
    })
    const pool = fakePool()
    const adapter = makeAdapter({
      slots: async () => [slot('acc-1', CRED1), slot('acc-2', CRED2)],
      accountPool: pool as never,
      fetchImpl: fetchImpl as never,
    })
    /**
     * ⚠️⚠️ 冷却落点是「**UTC+8 次日 0 点**」，不是 `now + 24h`（2026-11-02 三审 F🔴-2）。
     *
     * 这条用例原来断的是 `resetAt - before ∈ [24h, 24h+5s)` —— 它把**错的口径**
     * 钉死了：每日额度是次日 0 点重置（`src/monkeycode-credits.ts` 自己写着），
     * 而 `+24h` 会把 23:50 烧光额度的号锁到次日 23:50（近 24 小时假死）。
     * 现在 `markLimited` 也改用注入的 `now()` ⇒ 可以断言**绝对时刻**，
     * 先钉死一个 23:50 的时间点，验证跨日边界。
     */
    const before = Date.now()
    await drain(adapter.stream(request()))
    expect(pool.updateModelRateLimit).toHaveBeenCalledTimes(1)
    const resetAt = pool.updateModelRateLimit.mock.calls[0]?.[2] as number
    // 令 now = UTC+8 的 2026-11-02 23:50:00 ⇒ 次日 0 点 = 10 分钟后。
    const at2350 = Date.UTC(2026, 10, 2, 15, 50, 0)
    const tenMinutes = 10 * 60_000
    const pool2 = fakePool()
    const adapter2 = makeAdapter({
      slots: async () => [slot('acc-1', CRED1), slot('acc-2', CRED2)],
      accountPool: pool2 as never,
      fetchImpl: fetchImpl as never,
      now: () => at2350,
    })
    await drain(adapter2.stream(request()))
    const resetAt2 = pool2.updateModelRateLimit.mock.calls[0]?.[2] as number
    expect(resetAt2, '23:50 撞额度 ⇒ 只锁到次日 0 点（10 分钟），不是 24 小时')
      .toBe(at2350 + tenMinutes)
    // 兜底：真实时钟下也不该超过次日 0 点。
    expect(resetAt - before, '冷却不得超过「次日 0 点」这个上界')
      .toBeLessThanOrEqual(24 * 3_600_000 + 5_000)
  })

  it('★★ 400 参数错 ⇒ **不换号**、只发一次（换号 = 4 次注定失败的请求）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse('{"error":{"message":"max_tokens: must be >= 1"}}', 400),
    )
    const pool = fakePool()
    const adapter = makeAdapter({
      slots: async () => [slot('acc-1', CRED1), slot('acc-2', CRED2)],
      accountPool: pool as never,
      fetchImpl: fetchImpl as never,
    })
    const failure = await failureOf(adapter.stream(request()))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(pool.updateModelRateLimit).not.toHaveBeenCalled()
    // 400 在仓库里统一映射成 `INVALID_REQUEST`（`httpErrorCode(400)`），不是 `BAD_REQUEST`。
    expect(failure.code).toBe('INVALID_REQUEST')
  })

  it('★★ 400 上下文超限 ⇒ 翻成 CONTEXT_WINDOW_EXCEEDED（否则宿主既不重试也不压缩）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        '{"error":{"message":"This model\'s maximum context length is 1048576 tokens."}}',
        400,
      ),
    )
    const adapter = makeAdapter({
      slots: async () => [slot('acc-1', CRED1), slot('acc-2', CRED2)],
      fetchImpl: fetchImpl as never,
    })
    const failure = await failureOf(adapter.stream(request()))
    expect(failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('★ 5xx ⇒ 判 server 类并换号（不换 = 白重试 5 次同一账号）', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['x-api-key']
      return key === KEY1
        ? new Response('upstream unavailable', { status: 503 })
        : sseResponse(SSE_OK)
    })
    const adapter = makeAdapter({
      slots: async () => [slot('acc-1', CRED1), slot('acc-2', CRED2)],
      fetchImpl: fetchImpl as never,
    })
    const chunks = await drain(adapter.stream(request()))
    expect(chunks.length).toBeGreaterThan(0)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('★★ 200 但正文是「积分已耗尽」的 JSON ⇒ 仍要换号（不能一律抛）', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>)['x-api-key']
      return key === KEY1
        ? jsonResponse('{"error":"积分已耗尽，调用失败"}', 200)
        : sseResponse(SSE_OK)
    })
    const pool = fakePool()
    const adapter = makeAdapter({
      slots: async () => [slot('acc-1', CRED1), slot('acc-2', CRED2)],
      accountPool: pool as never,
      fetchImpl: fetchImpl as never,
    })
    const chunks = await drain(adapter.stream(request()))
    expect(chunks.length).toBeGreaterThan(0)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // quota 类要记账（否则坏号每次都被先试一次）。
    expect(pool.updateModelRateLimit).toHaveBeenCalledTimes(1)
  })

  it('★ 200 但正文是签名类错误 ⇒ 直接抛 INVALID_REQUEST，不把整池打一遍', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse('{"error":"invalid ohmyagent request: signature mismatch"}', 200),
    )
    const adapter = makeAdapter({
      slots: async () => [slot('acc-1', CRED1), slot('acc-2', CRED2)],
      fetchImpl: fetchImpl as never,
    })
    const failure = await failureOf(adapter.stream(request()))
    expect(failure.code).toBe('INVALID_REQUEST')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('流中断', () => {
  it('★★ 已产出内容后中断 ⇒ 直接抛，**不重放**（重放 = 用户看到重复输出）', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(SSE_PARTIAL_THEN_ERROR))
    const adapter = makeAdapter({
      slots: async () => [slot('acc-1', CRED1), slot('acc-2', CRED2)],
      fetchImpl: fetchImpl as never,
    })

    const texts: string[] = []
    let caught: unknown
    try {
      for await (const chunk of adapter.stream(request())) {
        if (chunk.type === 'text-delta') texts.push((chunk as { text: string }).text)
      }
    } catch (error) {
      caught = error
    }
    expect(caught, '期望流中断时抛错').toBeDefined()
    expect(texts.join('')).toBe('半句')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('目录', () => {
  it('★ listAllModels() 同步返回内置表（远端挂了也必须有模型可展示）', () => {
    const adapter = makeAdapter()
    const models = adapter.listAllModels()
    expect(models.length).toBeGreaterThan(0)
    expect(models.map((entry) => entry.id)).toContain('deepseek-flash')
  })
})
