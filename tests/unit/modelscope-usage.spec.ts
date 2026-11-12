import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildModelscopePayload } from '../../src/modelscope-messages.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ModelScope 用量', () => {
  it('请求体带 stream_options.include_usage', () => {
    const body = buildModelscopePayload({ model: 'Qwen/Qwen3-8B', messages: [{ role: 'user', content: 'hi' }] })
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('上游末帧的 usage 会作为 usage 块产出', async () => {
    const { ModelscopeAdapter } = await import('../../src/modelscope-adapter.js')
    const { MODELSCOPE } = await import('../../src/modelscope-product.js')
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}',
      'data: [DONE]',
      '',
    ].join('\n\n')
    const fetchImpl = vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    vi.stubGlobal('fetch', fetchImpl)
    const adapter = new ModelscopeAdapter({
      slots: async () => [{ id: 'a1', apiKey: 'ms-0123456789abcdefghij' }],
      product: MODELSCOPE,
      warn: () => {},
    } as never)
    const chunks: Array<{ type: string; usage?: { inputTokens?: number; outputTokens?: number } }> = []
    for await (const chunk of adapter.stream({
      model: 'Qwen/Qwen3-8B',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) chunks.push(chunk as never)

    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(String(init.body)).stream_options).toEqual({ include_usage: true })
    const usage = chunks.find((c) => c.type === 'usage')
    expect(usage, '没有产出 usage 块').toBeDefined()
    expect(usage?.usage?.inputTokens).toBe(12)
    expect(usage?.usage?.outputTokens).toBe(3)
  })
})
