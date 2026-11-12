import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildModelscopePayload } from '../../src/modelscope-messages.js'
// 静态 import：`modelscope-adapter.ts` 的模块图首次加载实测 ~5.1 s（adapter.stream 本身只 43 ms），
// 放在用例体内的 `await import()` 会把这段加载时间算进 5 s 默认超时 ⇒ 同一文件连跑 5 次有 4 次超时假红。
import { ModelscopeAdapter } from '../../src/modelscope-adapter.js'
import { MODELSCOPE } from '../../src/modelscope-product.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubSse(sse: string) {
  const fetchImpl = vi.fn(async () => new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }))
  vi.stubGlobal('fetch', fetchImpl)
  return fetchImpl
}

function makeAdapter(): ModelscopeAdapter {
  return new ModelscopeAdapter({
    slots: async () => [{ id: 'a1', apiKey: 'sk-test-key' }],
    product: MODELSCOPE,
    warn: () => {},
  } as never)
}

describe('ModelScope 用量', () => {
  it('请求体带 stream_options.include_usage', () => {
    const body = buildModelscopePayload({ model: 'Qwen/Qwen3-8B', messages: [{ role: 'user', content: 'hi' }] })
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('上游末帧的 usage 会作为 usage 块产出', async () => {
    const fetchImpl = stubSse([
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}',
      'data: [DONE]',
      '',
    ].join('\n\n'))
    const chunks: Array<{ type: string; usage?: { inputTokens?: number; outputTokens?: number } }> = []
    for await (const chunk of makeAdapter().stream({
      model: 'Qwen/Qwen3-8B',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) chunks.push(chunk as never)

    // ⚠️ 这里**只**断言 usage 腿：body 的 `stream_options` 由第 1 条用例负责。
    // 两条混在一个 it 里时，基线红的是 body 断言，usage 断言从未承重 ⇒
    // 「修复前 2 红」不能当 usage 腿的证据（正向审计 P2-1）。
    // 同时钉住「只发了一次、发的是 chat 端点」（P2-2：桩太宽松会让额外请求掩盖问题）。
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/chat/completions')
    expect(init.method).toBe('POST')
    const usage = chunks.find((c) => c.type === 'usage')
    expect(usage, '没有产出 usage 块').toBeDefined()
    expect(usage?.usage?.inputTokens).toBe(12)
    expect(usage?.usage?.outputTokens).toBe(3)
  })

  // 上游将来若**静默忽略** `stream_options`（既不报错也不下发 usage），降级形态必须是
  // 「照常出正文、只是没有用量」，不能变成抛错/空回复 —— 这条锁住降级本身。
  it('上游没有 usage 帧时仍正常收尾：有正文、无 usage 块、不抛错', async () => {
    stubSse([
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n'))
    const chunks: Array<{ type: string }> = []

    await expect((async () => {
      for await (const chunk of makeAdapter().stream({
        model: 'Qwen/Qwen3.8-Flash-Next',
        messages: [{ role: 'user', content: 'hi' }],
      } as never)) chunks.push(chunk as never)
    })()).resolves.toBeUndefined()

    expect(chunks.some((c) => c.type === 'text-delta'), '正文不该被吞').toBe(true)
    expect(chunks.filter((c) => c.type === 'usage'), '没有 usage 帧就不该产出 usage 块').toHaveLength(0)
  })
})
