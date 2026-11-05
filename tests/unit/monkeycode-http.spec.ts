/**
 * MonkeyCode 专用传输：`node:https` 直连（不经全局 `fetch`）。
 *
 * 守卫的核心不变量：bili（billion-context）会替换 `globalThis.fetch` 并按
 * `X-OhmyAgent-Signature` 形状拒发签名请求；本传输必须在**全局 fetch 被替换**
 * 的情况下仍能逐字节发出请求并流式读回 SSE。
 */
import { createHmac } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import { MonkeycodeAdapter } from '../../src/monkeycode-adapter.js'
import { monkeycodeDirectFetch } from '../../src/monkeycode-http.js'
import { MONKEYCODE } from '../../src/monkeycode-product.js'

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
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

interface TestServer {
  readonly url: string
  readonly close: () => Promise<void>
}

let servers: TestServer[] = []

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试服务器没有端口')
  const entry: TestServer = {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    },
  }
  servers.push(entry)
  return entry
}

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()))
  servers = []
  vi.unstubAllGlobals()
})

describe('monkeycodeDirectFetch', () => {
  it('★ 全局 fetch 被替换时仍能发请求（bili 拦截绕行），且正文/签名头逐字节到达', async () => {
    let receivedBody = ''
    let receivedSignature = ''
    let receivedLength = ''
    const server = await listen((req, res) => {
      receivedSignature = String(req.headers['x-ohmyagent-signature'] ?? '')
      receivedLength = String(req.headers['content-length'] ?? '')
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { receivedBody += chunk })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      })
    })
    const globalFetch = vi.fn(() => { throw new Error('全局 fetch 不应被调用') })
    vi.stubGlobal('fetch', globalFetch)

    const body = JSON.stringify({ system: '系统提示：中文', messages: [{ role: 'user', content: '你好' }] })
    const response = await monkeycodeDirectFetch(`${server.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'oma_test',
        'X-OhmyAgent-Signature': 'v1=deadbeef',
      },
      body,
    })

    expect(globalFetch).not.toHaveBeenCalled()
    expect(response.ok).toBe(true)
    expect(response.status).toBe(200)
    expect(receivedSignature).toBe('v1=deadbeef')
    expect(receivedLength).toBe(String(Buffer.byteLength(body, 'utf8')))
    expect(receivedBody).toBe(body)

    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    let text = ''
    const decoder = new TextDecoder()
    for (;;) {
      const chunk = await reader!.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    expect(text).toContain('event: message_start')
    expect(text).toContain('event: message_stop')
  })

  it('★ 非 2xx 保留状态码与响应体（交给适配器分类）', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{"error":"invalid ohmyagent request"}')
    })

    const response = await monkeycodeDirectFetch(`${server.url}/v1/messages`, { method: 'POST' })
    expect(response.ok).toBe(false)
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('{"error":"invalid ohmyagent request"}')
  })

  it('★ AbortSignal 会中断在途请求', async () => {
    const server = await listen(() => { /* 不响应，等客户端取消 */ })
    const controller = new AbortController()

    const pending = monkeycodeDirectFetch(`${server.url}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('★ 适配器默认走直连：全局 fetch 被 bili 式替换时仍能完成流式请求', async () => {
    let receivedBody = ''
    let receivedSignature = ''
    const server = await listen((req, res) => {
      receivedSignature = String(req.headers['x-ohmyagent-signature'] ?? '')
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { receivedBody += chunk })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(SSE_OK)
      })
    })
    const globalFetch = vi.fn(() => { throw new Error('bili 的 fetch 拦截不应被走到') })
    vi.stubGlobal('fetch', globalFetch)

    const adapter = new MonkeycodeAdapter({
      product: { ...MONKEYCODE, gatewayBaseUrl: `${server.url}/v1` },
      slots: async () => [{
        accountId: 'monkeycode-test',
        credential: { access_token: `oma_${'a'.repeat(32)}`, signing_secret: 'secret-1' },
      }],
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'monkeycode',
      model: 'deepseek-flash',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
      maxTokens: 16,
    } as GenerateOptions)) {
      chunks.push(chunk)
    }

    expect(globalFetch).not.toHaveBeenCalled()
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => (chunk as { text: string }).text)).toEqual(['收到'])
    expect(receivedSignature).toMatch(/^v1=[0-9a-f]{64}$/)
    expect(receivedBody).toContain('"system":"You are a helpful assistant."')
  })

  it('★ OpenAI 网关把 system 放在 messages 里时也能正确签名', async () => {
    let receivedBody = ''
    let receivedSignature = ''
    const server = await listen((req, res) => {
      receivedSignature = String(req.headers['x-ohmyagent-signature'] ?? '')
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { receivedBody += chunk })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(SSE_OK)
      })
    })

    const adapter = new MonkeycodeAdapter({
      product: { ...MONKEYCODE, gatewayBaseUrl: `${server.url}/v1` },
      slots: async () => [{
        accountId: 'monkeycode-test',
        credential: { access_token: `oma_${'a'.repeat(32)}`, signing_secret: 'secret-1' },
      }],
    })
    for await (const _chunk of adapter.stream({
      provider: 'monkeycode',
      model: 'deepseek-flash',
      // OpenAI 兼容网关（toGenerateOptions）把 system 放在 messages 里，
      // 不写 GenerateOptions.system。
      messages: [
        { role: 'system', content: [{ type: 'text', text: '来自 OpenAI 网关的 system' }] },
        { role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] },
      ],
      maxTokens: 16,
    } as GenerateOptions)) { /* drain */ }

    expect(receivedBody).toContain('"system":"来自 OpenAI 网关的 system"')
    // 空 prompt 的 HMAC 是合法值，但会与真实 system 的 HMAC 不同——这里断言
    // 签名不是空 prompt 的固定值，防止兜底再次静默失效。
    const emptyPromptSignature = `v1=${createHmac('sha256', 'secret-1').update('', 'utf8').digest('hex')}`
    expect(receivedSignature).not.toBe(emptyPromptSignature)
  })
})

// ════════════════════════════════════════════════════════════════════════
// 2026-11-05 审计返工：传输层三条高危（205 崩溃 / 无超时 / 代理被绕过）
// ════════════════════════════════════════════════════════════════════════

describe('monkeycodeDirectFetch：状态码与编码（审计返工）', () => {
  it('★★ 205（null-body status）⇒ 正常回 Response（body=null），**不得**抛 uncaught TypeError', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(205, 'Reset')
      res.end('x')
    })
    // 205 是合法状态码；旧实现用 `new Response(body,{status:205})` 在异步回调里
    // 抛 TypeError（未捕获 ⇒ 进程退出）。现在必须正常返回、且 body 为 null。
    const response = await monkeycodeDirectFetch(server.url)
    expect(response.status).toBe(205)
    expect(response.body).toBeNull()
  })

  it('★★ 600（Response 构造器 RangeError）⇒ reject，不逃逸', async () => {
    const server = await listen((_req, res) => {
      // Node 允许写 6xx 状态码（非法 HTTP，但服务端可以发）。
      res.writeHead(600)
      res.end('x')
    })
    await expect(monkeycodeDirectFetch(server.url)).rejects.toThrow(/非法状态码 600/)
  })

  it('★ gzip 响应自动解压（代理无视 identity 时不得读到二进制垃圾）', async () => {
    const payload = 'data: {"ok":true}\n\n'
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' })
      res.end(gzipSync(Buffer.from(payload, 'utf8')))
    })
    const response = await monkeycodeDirectFetch(server.url)
    expect(await response.text()).toBe(payload)
  })

  it('★ 请求带 `accept-encoding: identity`（SSE 不应被压缩）', async () => {
    let acceptEncoding = ''
    const server = await listen((req, res) => {
      acceptEncoding = String(req.headers['accept-encoding'] ?? '')
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await monkeycodeDirectFetch(server.url)
    expect(acceptEncoding).toBe('identity')
  })
})

describe('monkeycodeDirectFetch：代理（审计返工 P1-5）', () => {
  /** 极简 HTTP 转发代理：记录请求行并把目标响应回传。 */
  async function startProxy(): Promise<{ url: string, hits: string[], close: () => Promise<void> }> {
    const hits: string[] = []
    const proxy = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`)
      const target = new URL(String(req.url))
      const upstream = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: req.headers,
      }, (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(res)
      })
      upstream.on('error', () => { res.writeHead(502); res.end() })
      req.pipe(upstream)
    })
    await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
    const address = proxy.address()
    if (address === null || typeof address === 'string') throw new Error('代理端口不可用')
    return {
      url: `http://127.0.0.1:${address.port}`,
      hits,
      close: async () => {
        proxy.closeAllConnections()
        await new Promise<void>((resolve, reject) => proxy.close((error) => (
          error === undefined ? resolve() : reject(error)
        )))
      },
    }
  }

  it('★★ 设置了 HTTP_PROXY ⇒ 请求走代理', async () => {
    const server = await listen((_req, res) => { res.writeHead(200); res.end('ok') })
    const proxy = await startProxy()
    const previous = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY }
    process.env.HTTP_PROXY = proxy.url
    delete process.env.NO_PROXY
    try {
      const response = await monkeycodeDirectFetch(server.url)
      expect(await response.text()).toBe('ok')
      expect(proxy.hits.length).toBe(1)
    } finally {
      if (previous.HTTP_PROXY === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = previous.HTTP_PROXY
      if (previous.NO_PROXY === undefined) delete process.env.NO_PROXY
      else process.env.NO_PROXY = previous.NO_PROXY
      await proxy.close()
    }
  })

  it('★ 反向对照：NO_PROXY 命中 ⇒ 直连（代理零命中）', async () => {
    const server = await listen((_req, res) => { res.writeHead(200); res.end('ok') })
    const proxy = await startProxy()
    process.env.HTTP_PROXY = proxy.url
    process.env.NO_PROXY = '127.0.0.1'
    try {
      const response = await monkeycodeDirectFetch(server.url)
      expect(await response.text()).toBe('ok')
      expect(proxy.hits).toEqual([])
    } finally {
      delete process.env.HTTP_PROXY
      delete process.env.NO_PROXY
      await proxy.close()
    }
  })
})
