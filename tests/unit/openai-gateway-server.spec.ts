import { request, createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { BODY_LIMIT, createOpenAiGateway } from '../../src/openai-gateway/server.js'
import { DEFAULT_IMAGE_LIMITS } from '../../src/openai-gateway/images.js'

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function call(port: number, path: string, options: { method?: string; body?: unknown; key?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.key === undefined ? {} : { authorization: `Bearer ${options.key}` }),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.end(JSON.stringify(options.body))
    else req.end()
  })
}

async function* responseStream(signal?: AbortSignal) {
  if (signal?.aborted) return
  yield { type: 'text-delta' as const, index: 0, text: 'hello' }
  yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
}

/** 吐一帧就挂住，直到 DSH 侧收到 abort 才收尾——用来观察取消是否真的传到底层。 */
async function* hangingStream(signal?: AbortSignal) {
  yield { type: 'text-delta' as const, index: 0, text: 'first' }
  await new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return }
    signal?.addEventListener('abort', () => resolve(), { once: true })
  })
  yield { type: 'finish' as const, reason: { kind: 'aborted' as const } }
}

const ENV = (port: number) => ({ DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'test-key' })

/** 正常工作的 runtime 替身；各用例在其上覆盖个别方法。 */
const llm = {
  listProviders: () => [{ id: 'qoder', name: 'Qoder' }],
  listModels: async () => [{ provider: 'qoder', id: 'qfmodel', name: 'Qwen Flash' }],
  resolveModelInfo: async () => ({ provider: 'qoder', id: 'qfmodel', name: 'Qwen Flash' }),
  stream: (options: { signal?: AbortSignal }) => responseStream(options.signal),
}

describe('OpenAI gateway HTTP server', () => {

  it('serves models and chat completions with bearer authentication', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, home: undefined, env: ENV(port) })
    await gateway.start()
    try {
      expect((await call(port, '/v1/models')).status).toBe(401)
      const models = await call(port, '/v1/models', { key: 'test-key' })
      expect(models.status).toBe(200)
      expect(JSON.parse(models.body).data[0].id).toBe('qoder/qfmodel')

      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'qoder/qfmodel', messages: [{ role: 'user', content: 'hello' }], stream: false,
        },
      })
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body).choices[0].message.content).toBe('hello')
    } finally {
      await gateway.close()
    }
  })

  it('passes a safe GLM-5.2 output budget to the DSH runtime', async () => {
    const port = await freePort()
    let actualMaxTokens: number | undefined
    const captureLlm = {
      ...llm,
      resolveModelInfo: async () => ({ provider: 'codearts', id: 'GLM-5.2', name: 'GLM-5.2' }),
      stream: (options: { maxTokens?: number; signal?: AbortSignal }) => {
        actualMaxTokens = options.maxTokens
        return responseStream(options.signal)
      },
    }
    const gateway = createOpenAiGateway({ llm: captureLlm, env: ENV(port) })
    await gateway.start()
    try {
      const result = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'codearts/GLM-5.2', messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 128000, reasoning_effort: 'high', stream: false,
        },
      })
      expect(result.status).toBe(200)
      expect(actualMaxTokens).toBe(65536)
    } finally {
      await gateway.close()
    }
  })

  it('returns streaming SSE and completes without aborting a healthy request', async () => {
    let aborted = false
    const abortingLlm = {
      ...llm,
      stream: (options: { signal?: AbortSignal }) => {
        options.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
        return responseStream(options.signal)
      },
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: abortingLlm, env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'qoder/qfmodel', messages: [{ role: 'user', content: 'hello' }], stream: true,
        },
      })
      expect(response.status).toBe(200)
      expect(response.body).toContain('data: [DONE]')
    } finally {
      await gateway.close()
    }
    // 正常收尾**不应**触发 abort——这条锁的是「别把正常请求误判成取消」。
    expect(aborted).toBe(false)
  })

  // ⚠️ 上一条曾被命名为 `aborts on client cancellation`，但它只断言「不 abort」，
  // 与名字相反，等于设计文档验收 9（客户端断开后 DSH 收到 abort）**从未被验证**。
  // 下面这条才是真的断开客户端，并等待 abort 传到 DSH 请求。
  it('aborts the DSH request when the client disconnects mid-stream', async () => {
    // 用「事件 promise + 兜底超时」而不是轮询等待：慢机器上轮询会 flake，
    // 而这里真正要断言的是「abort 事件到达」，直接等事件最贴合语义。
    let markAborted: (() => void) | undefined
    const abortReached = new Promise<void>((resolve) => { markAborted = resolve })
    const hangingLlm = {
      ...llm,
      stream: (options: { signal?: AbortSignal }) => {
        options.signal?.addEventListener('abort', () => { markAborted?.() }, { once: true })
        return hangingStream(options.signal)
      },
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: hangingLlm, env: ENV(port) })
    await gateway.start()
    try {
      await new Promise<void>((resolve) => {
        const req = request({
          host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
        }, (res) => {
          res.once('data', () => { req.destroy(); resolve() })
        })
        req.on('error', () => resolve())
        req.end(JSON.stringify({
          model: 'qoder/qfmodel', messages: [{ role: 'user', content: 'hello' }], stream: true,
        }))
      })
      const arrived = await Promise.race([
        abortReached.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ])
      expect(arrived).toBe(true)
    } finally {
      await gateway.close()
    }
  })

  it('keeps serving /v1/models when a single provider directory fails', async () => {
    const flakyLlm = {
      ...llm,
      listProviders: () => [{ id: 'qoder' }, { id: 'broken' }],
      listModels: async (provider: string) => {
        if (provider === 'broken') throw new Error('no credentials for broken')
        return [{ provider: 'qoder', id: 'qfmodel', name: 'Qwen Flash' }]
      },
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: flakyLlm, env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/models', { key: 'test-key' })
      expect(response.status).toBe(200)
      const ids = JSON.parse(response.body).data.map((m: { id: string }) => m.id)
      expect(ids).toContain('qoder/qfmodel')
      expect(ids.some((id: string) => id.startsWith('broken/'))).toBe(false)
    } finally {
      await gateway.close()
    }
  })

  it('returns 404 (not 502) when the model cannot be resolved', async () => {
    const badResolveLlm = {
      ...llm,
      resolveModelInfo: async () => { throw new Error('unknown provider or model') },
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: badResolveLlm, env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'nosuch/nosuch', messages: [{ role: 'user', content: 'hello' }], stream: false,
        },
      })
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body).error.type).toBe('invalid_request_error')
    } finally {
      await gateway.close()
    }
  })
})

/**
 * 上游「模型不存在」的错误翻译与纠错建议。
 *
 * 背景（实测）：`codearts/GLM-5.3` 会被上游拒绝，而真实 ID 是
 * `codearts/glm-5.3-flash`。此前这条错误以 **502** 离开网关 —— 客户端会把它
 * 当可重试故障白耗额度，且错误里没有任何线索能让人猜到正确拼写。
 *
 * ⚠️ 是「翻成 404」而不是「请求前拦截」：`design.md:76` 要求显式请求仍交给
 * DSH 路由处理（有些 provider 支持目录外的模型），预检会把合法请求一起挡掉。
 */
describe('模型不存在：状态码翻译与纠错建议', () => {
  const CATALOG = {
    listProviders: () => [{ id: 'codearts' }],
    listModels: async () => [
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' },
      { id: 'GLM-5.2', name: 'GLM-5.2' },
    ],
  }

  /** 模拟上游在流里返回「模型未注册」。 */
  function rejectingLlm() {
    return {
      ...llm,
      ...CATALOG,
      stream: () => (async function* () {
        yield {
          type: 'finish' as const,
          reason: {
            kind: 'error' as const,
            failure: {
              code: 'INVALID_REQUEST',
              message: 'codearts: The model is not registered, please request other model',
            },
          },
        }
      })(),
    }
  }

  it('非流式：翻成 404 + invalid_request，而不是会被重试的 502', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: rejectingLlm(), env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'codearts/totally-wrong', messages: [{ role: 'user', content: 'hi' }], stream: false,
        },
      })
      expect(response.status).toBe(404)
      const error = JSON.parse(response.body).error
      expect(error.type).toBe('invalid_request_error')
      expect(error.code).toBe('model_not_found')
    } finally {
      await gateway.close()
    }
  })

  it('非流式：大小写/少后缀打错时给出正确拼写', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: rejectingLlm(), env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          // 实测的真实误填：大小写不同 + 少了一截后缀
          model: 'codearts/GLM-5.3', messages: [{ role: 'user', content: 'hi' }], stream: false,
        },
      })
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body).error.message).toContain('你是不是想用 codearts/glm-5.3-flash')
    } finally {
      await gateway.close()
    }
  })

  it('流式：错误帧里同样带正确 code 与建议（流已发 200，状态码改不了）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: rejectingLlm(), env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'codearts/GLM-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true,
        },
      })
      expect(response.status).toBe(200)
      const frame = response.body.split('\n').find(line => line.startsWith('data: {'))
      const error = JSON.parse(frame!.slice(6)).error
      expect(error.code).toBe('model_not_found')
      expect(error.status).toBe(404)
      expect(error.message).toContain('你是不是想用 codearts/glm-5.3-flash')
    } finally {
      await gateway.close()
    }
  })

  it('⚠️ 目录里没有相近项时不给建议（不硬凑一个误导答案）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: rejectingLlm(), env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'codearts/完全不相干的模型', messages: [{ role: 'user', content: 'hi' }], stream: false,
        },
      })
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body).error.message).not.toContain('你是不是想用')
    } finally {
      await gateway.close()
    }
  })

  it('⚠️ 其它上游错误不受影响（不得被误翻译成 404）', async () => {
    const otherLlm = {
      ...llm,
      stream: () => (async function* () {
        yield {
          type: 'finish' as const,
          reason: { kind: 'error' as const, failure: { code: 'SERVER', message: 'upstream exploded' } },
        }
      })(),
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: otherLlm, env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'qoder/qfmodel', messages: [{ role: 'user', content: 'hi' }], stream: false,
        },
      })
      // 仍应是 502（可重试的故障），没有被误伤成 404。
      expect(response.status).toBe(502)
    } finally {
      await gateway.close()
    }
  })
})

/**
 * `/v1/responses`（OpenAI Responses API）。
 *
 * ⚠️ 两个端点**同时可用**（用户 2026-10-03 的决定）：不做「格式开关」，
 * 客户端用哪套协议由它自己请求的 URL 决定 —— 互斥开关只会让另一个协议的客户端
 * 在切换后突然失效。
 */
describe('Responses API 出口', () => {
  it('非流式：返回 response 对象；鉴权与模型路由与 Chat 路径同一套', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, env: ENV(port) })
    await gateway.start()
    try {
      // 无 key ⇒ 401（同一个鉴权闸门）。
      expect((await call(port, '/v1/responses', {
        method: 'POST', body: { model: 'qoder/qfmodel', input: 'hello' },
      })).status).toBe(401)

      const result = await call(port, '/v1/responses', {
        method: 'POST', key: 'test-key', body: { model: 'qoder/qfmodel', input: 'hello' },
      })
      expect(result.status).toBe(200)
      const parsed = JSON.parse(result.body)
      expect(parsed.object).toBe('response')
      expect(parsed.status).toBe('completed')
      expect(parsed.model).toBe('qoder/qfmodel')
      expect(parsed.output[0].content[0].text).toBe('hello')
    } finally {
      await gateway.close()
    }
  })

  it('流式：给出 Responses 的事件序列，且**不**发 data: [DONE]', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/responses', {
        method: 'POST', key: 'test-key', body: { model: 'qoder/qfmodel', input: 'hello', stream: true },
      })
      expect(response.status).toBe(200)
      expect(response.body).toContain('event: response.created')
      expect(response.body).toContain('event: response.output_text.delta')
      expect(response.body).toContain('event: response.completed')
      expect(response.body).not.toContain('[DONE]')
    } finally {
      await gateway.close()
    }
  })

  it('max_output_tokens 同样经过 CodeArts 的输出预算钳制（两个端点共用同一份归一化）', async () => {
    const port = await freePort()
    let actualMaxTokens: number | undefined
    const captureLlm = {
      ...llm,
      resolveModelInfo: async () => ({ provider: 'codearts', id: 'GLM-5.2', name: 'GLM-5.2' }),
      stream: (options: { maxTokens?: number; signal?: AbortSignal }) => {
        actualMaxTokens = options.maxTokens
        return responseStream(options.signal)
      },
    }
    const gateway = createOpenAiGateway({ llm: captureLlm, env: ENV(port) })
    await gateway.start()
    try {
      const result = await call(port, '/v1/responses', {
        method: 'POST', key: 'test-key', body: {
          model: 'codearts/GLM-5.2', input: 'hello', max_output_tokens: 128000, stream: false,
        },
      })
      expect(result.status).toBe(200)
      // Chat 端实测 128000 会被上游拒绝，65536 可正常推理 —— 换了协议不能绕过钳制。
      expect(actualMaxTokens).toBe(65536)
    } finally {
      await gateway.close()
    }
  })

  it('⚠️ 语义会变的字段明确回 400（不静默忽略）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, env: ENV(port) })
    await gateway.start()
    try {
      const result = await call(port, '/v1/responses', {
        method: 'POST', key: 'test-key', body: {
          model: 'qoder/qfmodel', input: 'hello', previous_response_id: 'resp_1',
        },
      })
      expect(result.status).toBe(400)
      expect(JSON.parse(result.body).error.code).toBe('unsupported_parameter')
    } finally {
      await gateway.close()
    }
  })

  it('模型解析不了时同样回 404（不是会被重试的 502）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({
      llm: { ...llm, resolveModelInfo: async () => { throw new Error('unknown provider or model') } },
      env: ENV(port),
    })
    await gateway.start()
    try {
      const result = await call(port, '/v1/responses', {
        method: 'POST', key: 'test-key', body: { model: 'nosuch/nosuch', input: 'hello' },
      })
      expect(result.status).toBe(404)
      expect(JSON.parse(result.body).error.code).toBe('model_not_found')
    } finally {
      await gateway.close()
    }
  })

  /**
   * **真实报障回归**（2026-10-03）：Codex App 接网关后整轮对话失败
   * `tool type namespace is not supported（网关只提供 function 工具）`。
   * namespace 只是分组容器 ⇒ 摊平即可；表达不了的（custom / tool_search）
   * 只丢弃 + 记日志，**绝不能**让请求失败。
   */
  it('★ Codex 的 namespace / custom / tool_search 工具：回 200，子工具摊平后到达上游', async () => {
    const port = await freePort()
    let seenTools: unknown
    const captureLlm = {
      ...llm,
      stream: (options: { tools?: unknown; signal?: AbortSignal }) => {
        seenTools = options.tools
        return responseStream(options.signal)
      },
    }
    const gateway = createOpenAiGateway({ llm: captureLlm, env: ENV(port) })
    await gateway.start()
    try {
      const result = await call(port, '/v1/responses', {
        method: 'POST', key: 'test-key', body: {
          model: 'qoder/qfmodel',
          input: 'hello',
          tools: [
            { type: 'namespace', name: 'mcp__files__', tools: [{ type: 'function', name: 'read', parameters: {} }] },
            { type: 'custom', name: 'apply_patch' },
            { type: 'tool_search' },
          ],
        },
      })
      expect(result.status).toBe(200)
      expect(seenTools).toEqual([{ name: 'mcp__files____read', description: '', parameters: {} }])
    } finally {
      await gateway.close()
    }
  })
})

/**
 * 思考档位的**翻译层 + 可查询**（真实缺陷：CC Switch 的档位表与 provider 私有 id
 * 对不上，用户照着 DSH 界面上的名字填，得到 400 + 整轮不可用）。
 */
describe('OpenAI gateway 思考档位（翻译层与对照表）', () => {
  const TRAE = {
    listProviders: () => [{ id: 'trae' }],
    listModels: async () => [{ provider: 'trae', id: 'deepseek-v4.1-flash', name: 'Flash' }],
    resolveModelInfo: async () => ({
      provider: 'trae',
      id: 'deepseek-v4.1-flash',
      name: 'Flash',
      // issue #36：窗口只出现在 resolveModelInfo 的 context 里（listModels 被宿主重建）。
      context: { contextWindow: 1_048_576 },
      reasoning: {
        efforts: [
          { id: 'light', name: 'Light' },
          { id: 'high', name: 'High' },
          { id: 'extra_high', name: 'Extra High' },
        ],
        defaultEffort: 'high',
      },
    }),
    stream: (options: { signal?: AbortSignal }) => responseStream(options.signal),
  }

  it('★ 客户端填的是通用档位名、模型认的是私有 id：请求成功且下发的是私有 id', async () => {
    // CC Switch 里 TRAE 这一行现在填的是 `low, high, xhigh` —— 修好前这三个
    // 里有两个直接 400（整轮失败）。修好后应当照强度落到 light / high / extra_high。
    const port = await freePort()
    const seen: Array<string | undefined> = []
    const captureLlm = {
      ...TRAE,
      stream: (options: { reasoningEffort?: string; signal?: AbortSignal }) => {
        seen.push(options.reasoningEffort)
        return responseStream(options.signal)
      },
    }
    const gateway = createOpenAiGateway({ llm: captureLlm, env: ENV(port) })
    await gateway.start()
    try {
      for (const effort of ['low', 'high', 'xhigh']) {
        const result = await call(port, '/v1/responses', {
          method: 'POST', key: 'test-key', body: { model: 'trae/deepseek-v4.1-flash', input: 'hi', reasoning: { effort } },
        })
        expect(result.status, effort).toBe(200)
      }
      // `none` 则无处可去（TRAE 这模型没有关闭档）→ 不下发该参数，但请求仍然成功。
      const none = await call(port, '/v1/responses', {
        method: 'POST', key: 'test-key', body: { model: 'trae/deepseek-v4.1-flash', input: 'hi', reasoning: { effort: 'none' } },
      })
      expect(none.status).toBe(200)
      expect(seen).toEqual(['light', 'high', 'extra_high', undefined])
    } finally {
      await gateway.close()
    }
  })

  it('★ 完全不认识的档位名仍然 400（拼错不该被静默翻译），且报错带上可用档位', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: { ...TRAE }, env: ENV(port) })
    await gateway.start()
    try {
      const result = await call(port, '/v1/responses', {
        method: 'POST', key: 'test-key', body: { model: 'trae/deepseek-v4.1-flash', input: 'hi', reasoning: { effort: 'banana' } },
      })
      expect(result.status).toBe(400)
      const parsed = JSON.parse(result.body)
      expect(parsed.error.code).toBe('unsupported_reasoning_effort')
      expect(parsed.error.message).toContain('light, high, extra_high')
    } finally {
      await gateway.close()
    }
  })

  it('/v1/models 带上档位视图（工具据此就能填对，不必猜）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: { ...TRAE }, env: ENV(port) })
    await gateway.start()
    try {
      const models = JSON.parse((await call(port, '/v1/models', { key: 'test-key' })).body)
      expect(models.data[0].context_window).toBe(1_048_576)
      expect(models.data[0].reasoning).toEqual({
        efforts: [
          { id: 'light', name: 'Light', canonical: 'low' },
          { id: 'high', name: 'High', canonical: 'high' },
          { id: 'extra_high', name: 'Extra High', canonical: 'xhigh' },
        ],
        default: 'high',
        openai_efforts: ['low', 'high', 'xhigh'],
      })
    } finally {
      await gateway.close()
    }
  })

  it('★ GET /v1/reasoning-efforts：给出「该填哪几个」与 8 个规范名逐一的结局', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: { ...TRAE }, env: ENV(port) })
    await gateway.start()
    try {
      // 与其它端点同一套鉴权：地址栏直接打开会 401。
      expect((await call(port, '/v1/reasoning-efforts')).status).toBe(401)
      const body = JSON.parse((await call(port, '/v1/reasoning-efforts', { key: 'test-key' })).body)
      expect(body.canonical).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      expect(body.data).toHaveLength(1)
      expect(body.data[0].id).toBe('trae/deepseek-v4.1-flash')
      expect(body.data[0].openai_efforts).toEqual(['low', 'high', 'xhigh'])
      const resolution = (requested: string) => body.data[0].resolutions.find((row: { requested: string }) => row.requested === requested)
      expect(resolution('low')).toEqual({ requested: 'low', outcome: 'mapped', applied: 'light' })
      expect(resolution('high')).toEqual({ requested: 'high', outcome: 'exact', applied: 'high' })
      expect(resolution('xhigh')).toEqual({ requested: 'xhigh', outcome: 'mapped', applied: 'extra_high' })
      // TRAE 这模型没有关闭档 → 客户端要 none 时网关不下发该参数。
      expect(resolution('none')).toEqual({ requested: 'none', outcome: 'unexpressible' })
      expect(body.data[0].default).toBe('high')
    } finally {
      await gateway.close()
    }
  })

  it('未声明档位的模型也出现在对照表里（说明「网关不会下发档位」）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({
      llm: {
        ...TRAE,
        resolveModelInfo: async () => ({ provider: 'trae', id: 'deepseek-v4.1-flash', name: 'Flash' }),
      },
      env: ENV(port),
    })
    await gateway.start()
    try {
      const body = JSON.parse((await call(port, '/v1/reasoning-efforts', { key: 'test-key' })).body)
      expect(body.data[0]).toMatchObject({ id: 'trae/deepseek-v4.1-flash', efforts: [], openai_efforts: [] })
      // 8 个规范名全部标记为「不下发」（网关按模型默认走），而不是「无法表达」。
      expect(body.data[0].resolutions.every((row: { outcome: string }) => row.outcome === 'ignored')).toBe(true)
    } finally {
      await gateway.close()
    }
  })
})

/**
 * Issue IKKUBJ：请求体超限时网关曾销毁 socket，那条 413 永远发不出去 ——
 * 客户端只看到连接重置，把「请求过大」伪装成「网络故障」。
 *
 * ⚠️ 这些用例**必须走真实 HTTP 往返**：缺陷本身就在「响应能否写回 socket」这一层，
 * 直接单测 `readJson` 的 reject 是恒绿的（那条 reject 一直是对的，错的是它之后的
 * 那行销毁）。
 */
describe('请求体上限与超限行为（Issue IKKUBJ）', () => {
  /** 恰好 totalBytes 字节、且是合法 JSON 的请求体。 */
  function paddedBody(totalBytes: number): Buffer {
    const prefix = '{"model":"qoder/qfmodel","messages":[{"role":"user","content":"hi"}],"pad":"'
    const suffix = '"}'
    const pad = totalBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
    if (pad < 0) throw new Error('totalBytes 太小，装不下 JSON 外壳')
    return Buffer.from(prefix + 'A'.repeat(pad) + suffix)
  }

  /**
   * 发原始字节。⚠️ 网关若在写出 413 之前销毁 socket，客户端这里收到的是
   * `ECONNRESET` 并 **reject** —— 用例因此变红，而不是悄悄拿到一个别的状态码。
   */
  function postBytes(port: number, path: string, payload: Buffer): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          authorization: 'Bearer test-key',
          'content-type': 'application/json',
          'content-length': payload.length,
          connection: 'close',
        },
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  const LIMIT = 4096

  it('★ 超限时回 413 + request_too_large，而不是把连接重置掉', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, env: ENV(port), maxBodyBytes: LIMIT })
    await gateway.start()
    try {
      const response = await postBytes(port, '/v1/chat/completions', paddedBody(LIMIT + 1))
      expect(response.status).toBe(413)
      const error = JSON.parse(response.body).error
      expect(error.code).toBe('request_too_large')
      expect(error.type).toBe('invalid_request_error')
      // 排障时不必翻源码：上限值就在错误里。
      expect(error.message).toContain(String(LIMIT))
    } finally {
      await gateway.close()
    }
  })

  it('★ 超出上限很多倍（跨多个 TCP 分片）时同样拿得到 413', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, env: ENV(port), maxBodyBytes: LIMIT })
    await gateway.start()
    try {
      // 128 倍：`size` 要跨多个 `data` 事件累加才判得出超限（单分片就超限是另一条路径）。
      //
      // ⚠️ 本用例**不**锁「超限后是否排空」：把排空换成 `request.pause()` 实测仍然通过
      // —— 413 已经写进发送缓冲区，客户端收到后就停止发送了。排空省的是服务端在响应
      // 之后继续读走垃圾数据的开销，不是可观测行为，故不为它编一条恒绿的守卫。
      const response = await postBytes(port, '/v1/chat/completions', paddedBody(LIMIT * 128))
      expect(response.status).toBe(413)
      expect(JSON.parse(response.body).error.code).toBe('request_too_large')
    } finally {
      await gateway.close()
    }
  })

  it('恰好等于上限时放行（判据是 > 而不是 >=）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, env: ENV(port), maxBodyBytes: LIMIT })
    await gateway.start()
    try {
      const response = await postBytes(port, '/v1/chat/completions', paddedBody(LIMIT))
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body).choices[0].message.content).toBe('hello')
    } finally {
      await gateway.close()
    }
  })

  it('⚠️ /v1/responses 共用同一上限（只给一个端点接上限是同类缺陷）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, env: ENV(port), maxBodyBytes: LIMIT })
    await gateway.start()
    try {
      const response = await postBytes(port, '/v1/responses', paddedBody(LIMIT + 1))
      expect(response.status).toBe(413)
      expect(JSON.parse(response.body).error.code).toBe('request_too_large')
    } finally {
      await gateway.close()
    }
  })

  it('★ keep-alive 窗口覆盖「人读着回复、隔几分钟再追问」（不能是 Node 默认的 5 秒）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, env: ENV(port) })
    await gateway.start()
    try {
      const header = await new Promise<string>((resolve, reject) => {
        const req = request({
          host: '127.0.0.1', port, path: '/v1/models', method: 'GET',
          headers: { authorization: 'Bearer test-key' },
        }, (res) => {
          res.resume()
          res.on('end', () => resolve(String(res.headers['keep-alive'] ?? '')))
        })
        req.on('error', reject)
        req.end()
      })
      // Node 会把 `server.keepAliveTimeout` 如实写进响应头 —— 外部可观测，
      // 且不设就是 `timeout=5`。
      expect(header).toContain('timeout=120')
    } finally {
      await gateway.close()
    }
  })

  it('★ 上限容得下自家图片声明所能产生的请求体（否则那条声明永不可达）', () => {
    // JSON 里的图片是 base64：每 3 字节原始数据占 4 字节。
    const base64Bytes = (raw: number) => Math.ceil(raw / 3) * 4
    expect(BODY_LIMIT).toBeGreaterThanOrEqual(base64Bytes(DEFAULT_IMAGE_LIMITS.maxMessageImageBytes))
    // 单张声明也必须在门内：图片从来不独占请求体，还要与文本、tools 共处。
    expect(BODY_LIMIT).toBeGreaterThan(base64Bytes(DEFAULT_IMAGE_LIMITS.maxImageBytes))
  })
})
