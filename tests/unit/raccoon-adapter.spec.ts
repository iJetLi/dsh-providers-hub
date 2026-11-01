import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { RACCOON, RACCOON_TEXT_ONLY_MODELS, raccoonSupportsImageWith } from '../../src/raccoon-product.js'
import { RACCOON_MAX_OUTPUT_TOKENS, RaccoonAdapter, clampRaccoonMaxTokens, classifyRaccoonFailure, registerRaccoonLlm } from '../../src/raccoon-adapter.js'
import type { RaccoonRemoteModel } from '../../src/raccoon-adapter.js'
import type { RaccoonCredential } from '../../src/raccoon.js'
import { raccoonDisplayName } from '../../src/raccoon.js'
import type { AccountPool } from '../../src/account-pool.js'

/** 所有已创建的 service；afterEach 统一释放。 */
const services: Array<{ [Symbol.dispose]?: () => void }> = []

function makeContext(): Context {
  return new Context()
}

afterEach(() => {
  for (const s of services.splice(0)) s[Symbol.dispose]?.()
})

const CRED: RaccoonCredential = { access_token: 'tok', refresh_token: 'r' }

/** 造一个远端模型条目。 */
function remoteModel(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'sn-glm-5-3',
    description: 'GLM-5-3',
    visible: true,
    tags: ['general'],
    ability_level: 2,
    params: { context_window: 1_000_000, max_tokens: 100_000 },
    billing_multiplier: 0.75,
    billing_effective_multiplier: 0.75,
    billing_status: 'normal',
    ...patch,
  }
}

/** 造一个 adapter（默认：有凭据、有远端目录、无账号池）。 */
function makeAdapter(patch: {
  models?: Record<string, unknown>[]
  credential?: RaccoonCredential | undefined
  pool?: AccountPool
  fetcher?: typeof fetch
  /**
   * 注入的「纯文本模型」集合（默认用生产集合）。
   *
   * ⚠️ 必须可注入：生产集合当前为空，注入不了就**测不到**「纯文本模型被禁」
   * 这条分支（与 `raccoonDefaultEffort` 的教训同型）。
   */
  textOnly?: ReadonlySet<string>
} = {}): RaccoonAdapter {
  const models = patch.models ?? [remoteModel()]
  const adapter = new RaccoonAdapter({
    credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
    resolveCredential: async () => ('credential' in patch ? patch.credential : CRED),
    refresh: async () => {},
    // ⚠️ 生产路径是 `RaccoonAuth.fetchModels` → `raccoonDisplayName`（含倍率）。
    // 替身必须复现这一点，否则测试会断言到「裸 description」这个**生产不会出现**
    // 的形状，从而既测不出倍率丢失、又让人误以为实现有问题。
    fetchRemoteModels: async () => models.map((m) => {
      const params = (m.params ?? {}) as Record<string, unknown>
      return {
        id: String(m.name),
        name: raccoonDisplayName({
          id: String(m.name),
          description: String(m.description),
          effectiveMultiplier: typeof m.billing_effective_multiplier === 'number'
            ? m.billing_effective_multiplier : Number.NaN,
          baseMultiplier: typeof m.billing_multiplier === 'number'
            ? m.billing_multiplier : Number.NaN,
          status: 'normal',
          statusNote: '',
        }),
        contextWindow: Number(params.context_window ?? 0),
        maxTokens: Number(params.max_tokens ?? 0),
        // ⚠️ **必须调生产函数**，不要在测试里复刻一份镜像实现 —— 否则单测
        // 测的是「测试自己写的那份逻辑」，生产改了它不会变红。
        // 真实实现在 `raccoonSupportsImage`（默认 image + 纯文本集合黑名单）。
        supportsImage: raccoonSupportsImageWith(
          patch.textOnly ?? RACCOON_TEXT_ONLY_MODELS,
          String(m.name),
        ),
      }
    }),
    ...patch.pool === undefined ? {} : { accountPool: patch.pool },
    ...patch.fetcher === undefined ? {} : { fetchImpl: patch.fetcher },
  })
  services.push(adapter as unknown as { [Symbol.dispose]?: () => void })
  return adapter
}

/** SSE 响应体。 */
function sseResponse(frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/** 收集 stream 的全部 chunk。 */
async function collect(adapter: RaccoonAdapter, options: Partial<GenerateOptions>): Promise<StreamChunk[]> {
  const full = {
    provider: 'raccoon',
    model: 'sn-glm-5-3',
    messages: [{ role: 'user', content: 'hi' }],
    ...options,
  } as unknown as GenerateOptions
  const chunks: StreamChunk[] = []
  for await (const c of adapter.stream(full)) chunks.push(c)
  return chunks
}

describe('classifyRaccoonFailure 判据（PR !71 审计：防止误封可用账号）', () => {
  it('★ 真实额度形态仍归 quota（PR 报障的 400 + insufficient_points）', () => {
    // 本机实测：低余额账号回 HTTP 400 + insufficient_points。
    expect(classifyRaccoonFailure('{"code":"insufficient_points"}', 400)).toBe('quota')
    expect(classifyRaccoonFailure('insufficient_points', 402)).toBe('quota')
    expect(classifyRaccoonFailure('14018 Credits exhausted', 400)).toBe('quota')
    expect(classifyRaccoonFailure('积分不足', 400)).toBe('quota')
  })

  /**
   * ★★ `insufficient` 单独出现**不得**判成 quota（PR !71 审计实测误伤 5 类）。
   *
   * 误判成 `quota` 的后果是**给一个只是没权限/上下文超长的账号写 24 小时
   * 冷却** —— 与 2026-10-06「全池被封」事故同型，只是范围更小。
   */
  it('★★ 上下文/数据类 insufficient 不判 quota（不写 24h 冷却）', () => {
    expect(classifyRaccoonFailure('the context window is insufficient for this model', 400)).toBe('other')
    expect(classifyRaccoonFailure('input length is insufficient', 400)).toBe('other')
    expect(classifyRaccoonFailure('insufficient data to complete the request', 400)).toBe('other')
  })

  /**
   * ★★★ 403 + `insufficient permissions` 必须归 **auth**（不是 quota）。
   *
   * 认证类是 2026-10-06 事故换来的不变式：**只换号、绝不写标记**。
   * 若被判成 `quota`，一个只是没权限的账号会被封 24h。
   */
  it('★★★ 403 + insufficient permissions 归 auth（不是 quota）', () => {
    expect(classifyRaccoonFailure('insufficient permissions to access this resource', 403)).toBe('auth')
    expect(classifyRaccoonFailure('{"code":200003,"message":"authorization_verify_error"}', 401)).toBe('auth')
    // 状态码与额度文案并存时，仍以状态码为准（网关侧故障常在报文里带余额提示）。
    expect(classifyRaccoonFailure('14018 Credits exhausted', 401)).toBe('auth')
  })

  it('429 与 402 按状态码归类', () => {
    expect(classifyRaccoonFailure('', 429)).toBe('rate')
    expect(classifyRaccoonFailure('', 402)).toBe('quota')
    expect(classifyRaccoonFailure('param is invalid', 400)).toBe('other')
  })
})

describe('providerInfo', () => {
  it('返回 id 与显示名', () => {
    const info = makeAdapter().providerInfo('raccoon')
    expect(info.id).toBe('raccoon')
    expect(info.name).toBe('Raccoon (商汤)')
  })

  it('provider 非字符串时回退到产品 id（不炸 toUpperCase）', () => {
    const info = makeAdapter().providerInfo(undefined as unknown as string)
    expect(info.id).toBe('raccoon')
  })
})

describe('listModels', () => {
  it('无账号池时返回全部模型（门控保守放行）', async () => {
    const models = await makeAdapter().listModels('raccoon')
    expect(models.map((m) => m.id)).toEqual(['sn-glm-5-3'])
    expect(models[0]?.name).toBe('GLM-5-3 · x0.75')
  })

  it('**无已登录账号时返回空数组且不抛错**（DSH 据此隐藏整个分组）', async () => {
    const pool = {
      hasLoggedInAccount: async () => false,
      disabledModelsFor: () => new Set<string>(),
    } as unknown as AccountPool
    const models = await makeAdapter({ pool }).listModels('raccoon')
    expect(models).toEqual([])
  })

  it('应用黑名单', async () => {
    const pool = {
      hasLoggedInAccount: async () => true,
      disabledModelsFor: () => new Set(['sn-glm-5-3']),
    } as unknown as AccountPool
    const models = await makeAdapter({ pool }).listModels('raccoon')
    expect(models).toEqual([])
  })

  it('黑名单只影响目录，不影响 resolveModel（路由契约）', async () => {
    const pool = {
      hasLoggedInAccount: async () => true,
      disabledModelsFor: () => new Set(['sn-glm-5-3']),
    } as unknown as AccountPool
    const adapter = makeAdapter({ pool })
    const resolved = await adapter.resolveModel('raccoon', 'sn-glm-5-3')
    expect(resolved.id).toBe('sn-glm-5-3')
  })
})

describe('listAllModels', () => {
  it('**不套黑名单**（设置页要显示被关闭的模型）', async () => {
    const pool = {
      hasLoggedInAccount: async () => true,
      disabledModelsFor: () => new Set(['sn-glm-5-3']),
    } as unknown as AccountPool
    const adapter = makeAdapter({ pool })
    // 远端目录是**惰性加载**的（首次 listModels/resolveModel 时拉取），
    // 故先触发一次加载，再断言 listAllModels。
    await adapter.listModels('raccoon')
    const all = adapter.listAllModels()
    expect(all.map((m) => m.id)).toEqual(['sn-glm-5-3'])
    // 且带**最终展示名（含倍率）**，不是裸 id —— 这正是 listAllModels 的价值：
    // 被黑名单关掉的模型也能在设置页显示倍率与完整名称。
    expect(all[0]?.name).toBe('GLM-5-3 · x0.75')
  })

  it('远端拉取失败时回退兜底表（6 个模型，不带倍率）', async () => {
    const adapter = new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
      fetchRemoteModels: async () => { throw new Error('down') },
    })
    services.push(adapter as unknown as { [Symbol.dispose]?: () => void })
    // 先触发一次加载
    await adapter.listModels('raccoon')
    const all = adapter.listAllModels()
    expect(all.length).toBe(6)
    expect(all.map((m) => m.id)).toContain('sn-glm-5-3')
  })
})

describe('resolveModel', () => {
  it('**name 不带倍率**（价格只属于选择列表语境）', async () => {
    const resolved = await makeAdapter().resolveModel('raccoon', 'sn-glm-5-3')
    expect(resolved.name).toBe('GLM-5-3')
  })

  it('声明 contextWindow 与 defaultMaxTokens', async () => {
    const resolved = await makeAdapter().resolveModel('raccoon', 'sn-glm-5-3')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    // ⚠️ issue IKS1L5：声明值要夹到上游硬校验上限，否则每轮请求都带 100000
    expect(resolved.defaultMaxTokens).toBe(65_536)
  })

  it('未知模型不编造 context', async () => {
    const resolved = await makeAdapter().resolveModel('raccoon', 'nope')
    expect(resolved.context).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
  })

  it('**远端非法 max_tokens 被过滤**（0/负数/NaN 会让 DSH 抛 INVALID_MODEL_MAX_TOKENS）', async () => {
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      const adapter = makeAdapter({
        models: [remoteModel({ params: { context_window: 1000, max_tokens: bad } })],
      })
      const resolved = await adapter.resolveModel('raccoon', 'sn-glm-5-3')
      expect(resolved.defaultMaxTokens, `max_tokens=${String(bad)} 应被过滤`).toBeUndefined()
    }
  })

  it('图片模态：默认声明 image（不再看远端 tags）', async () => {
    // tags 含 / 不含 vision 都应是 image —— 远端 tags 是选模偏好，不是能力契约
    const withVision = makeAdapter({ models: [remoteModel({ tags: ['vision'] })] })
    expect((await withVision.resolveModel('raccoon', 'sn-glm-5-3')).inputModalities)
      .toEqual(['text', 'image'])
    const without = makeAdapter({ models: [remoteModel({ tags: ['general'] })] })
    expect((await without.resolveModel('raccoon', 'sn-glm-5-3')).inputModalities)
      .toEqual(['text', 'image'])
  })

  /**
   * ⚠️ 真实缺陷回归（2026-10-03，用户报障「给 DeepSeek-V4.1-Flash 发图提示不支持」）。
   *
   * 远端 `tags` 不含 `vision` **不代表**模型不能看图 —— 那是客户端选模偏好。
   * 判据是「模型真的读得出来吗」，实测 5/5 读对随机数字。
   *
   * ⚠️ 后果链：`inputModalities` 报 `['text']` ⇒ DSH 在 `LlmRuntime` 里把图片
   * 换成文本占位符 ⇒ **图片根本发不出去**，用户看到「模型说读不到图」。
   */
  it('⚠️ tags 不含 vision 但实测能看图的模型仍声明 image（修复前恒为 text）', async () => {
    const adapter = makeAdapter({
      models: [
        remoteModel({
          name: 'sn-deepseek-v4-1-flash',
          description: 'DeepSeek-V4.1-Flash',
          // 实测的远端 tags：确实不含 vision
          tags: ['general', 'code', 'html', 'analysis', 'reasoning', 'auto'],
        }),
      ],
    })
    const resolved = await adapter.resolveModel('raccoon', 'sn-deepseek-v4-1-flash')
    expect(resolved.inputModalities).toEqual(['text', 'image'])

    // 目录里也必须带 image —— 设置页的模型卡据此显示可发图
    const listed = await adapter.listModels('raccoon')
    expect(listed.find((m) => m.id === 'sn-deepseek-v4-1-flash')?.inputModalities)
      .toEqual(['text', 'image'])
  })

  it('⚠️ 未知新模型默认声明 image（不再要求先登记白名单）', async () => {
    const adapter = makeAdapter({
      models: [remoteModel({ name: 'sn-not-a-real-model', tags: ['general'] })],
    })
    expect((await adapter.resolveModel('raccoon', 'sn-not-a-real-model')).inputModalities)
      .toEqual(['text', 'image'])
  })

  /**
   * ⚠️ **唯一的刹车**：真正的纯文本模型（登记在纯文本集合里）必须声明 `text`，
   * 否则 DSH 会放行图片、上游则可能静默忽略 ⇒ 模型凭文字幻觉作答。
   */
  it('⚠️ 纯文本集合里的模型声明 text（同族版本后缀同样生效）', async () => {
    const adapter = makeAdapter({
      models: [
        remoteModel({ name: 'sn-text-only-model' }),
        remoteModel({ name: 'sn-text-only-model-1017' }),
        remoteModel({ name: 'sn-deepseek-v4-1-flash' }),
      ],
      textOnly: new Set(['sn-text-only-model']),
    })
    expect((await adapter.resolveModel('raccoon', 'sn-text-only-model')).inputModalities)
      .toEqual(['text'])
    expect((await adapter.resolveModel('raccoon', 'sn-text-only-model-1017')).inputModalities)
      .toEqual(['text'])
    // 集合外不受影响
    expect((await adapter.resolveModel('raccoon', 'sn-deepseek-v4-1-flash')).inputModalities)
      .toEqual(['text', 'image'])
  })

  /**
   * ⚠️ **版本后缀回归（2026-10-21）**：远端新增 `sn-deepseek-v4-1-flash-1017`，
   * `tags` 与无后缀版逐字相同（无 `vision`）⇒ 修复前声明 `['text']`，
   * DSH 直接把图投影成占位符。实测该 id 带图 200 且四色全对。
   *
   * 本用例断言的是**生产路径**（`fetchRemoteModels` → `raccoonSupportsImage` →
   * `inputModalities`），不是替身里另写一份判据。
   */
  it('⚠️ 同族版本后缀模型（-1017）也声明 image', async () => {
    const adapter = makeAdapter({
      models: [
        remoteModel({
          name: 'sn-deepseek-v4-1-flash-1017',
          description: 'DeepSeek-V4.1-Flash-1017',
          billing_effective_multiplier: 0,
          tags: ['general', 'code', 'html', 'analysis', 'reasoning', 'auto'],
        }),
      ],
    })
    const resolved = await adapter.resolveModel('raccoon', 'sn-deepseek-v4-1-flash-1017')
    expect(resolved.inputModalities).toEqual(['text', 'image'])

    const listed = await adapter.listModels('raccoon')
    expect(listed.find((m) => m.id === 'sn-deepseek-v4-1-flash-1017')?.inputModalities)
      .toEqual(['text', 'image'])
  })
})

describe('stream', () => {
  it('**把 options.tools 真的下发到请求体顶层 tools**（Qoder/TRAE 的缺陷形态）', async () => {
    let seenBody: Record<string, unknown> = {}
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ])
    })
    await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {
      tools: [{
        name: 'get_weather',
        description: '查天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      }],
    } as unknown as Partial<GenerateOptions>)

    expect(Array.isArray(seenBody.tools)).toBe(true)
    const tools = seenBody.tools as Array<Record<string, unknown>>
    expect(tools.length).toBe(1)
    expect(tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'get_weather', description: '查天气' },
    })
  })

  it('无 tools 时不下发空数组', async () => {
    let seenBody: Record<string, unknown> = {}
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] }),
      ])
    })
    await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    expect(seenBody.tools).toBeUndefined()
  })

  it('请求体含 model / messages / stream:true，且请求到正确端点', async () => {
    let seenUrl = ''
    let seenBody: Record<string, unknown> = {}
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      seenUrl = String(url)
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] })])
    })
    await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    expect(seenUrl).toBe(`${RACCOON.apiBase}${RACCOON.llmApiPrefix}/chat/completions`)
    expect(seenBody.model).toBe('sn-glm-5-3')
    expect(seenBody.stream).toBe(true)
    expect(Array.isArray(seenBody.messages)).toBe(true)
  })

  it('请求头带 Bearer 与 X-Org-Code', async () => {
    let seenHeaders: Record<string, string> = {}
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>
      return sseResponse([JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] })])
    })
    await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    expect(seenHeaders.Authorization).toBe('Bearer tok')
    expect(seenHeaders['X-Org-Code']).toBe('')
  })

  it('解析标准 OpenAI SSE（content 成块）', async () => {
    const fetcher = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: '你' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: '好' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]))
    const chunks = await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    const text = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => (c as { text: string }).text)
      .join('')
    expect(text).toBe('你好')
  })

  it('解析 reasoning_content（思考内容）', async () => {
    const fetcher = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '想' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: '答' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]))
    const chunks = await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    const reasoning = chunks
      .filter((c) => c.type === 'reasoning-delta')
      .map((c) => (c as { text: string }).text)
      .join('')
    expect(reasoning).toBe('想')
  })

  it('解析工具调用（finish_reason: tool_calls）', async () => {
    const fetcher = vi.fn(async () => sseResponse([
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0, id: 'call_1', type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"北京"}' },
            }],
          },
        }],
      }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ]))
    const chunks = await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    const names = chunks
      .filter((c) => c.type === 'tool-call-start' || c.type === 'tool-call-delta')
      .map((c) => c as unknown as Record<string, unknown>)
    expect(names.length).toBeGreaterThan(0)
    expect(JSON.stringify(chunks)).toContain('get_weather')
  })

  it('无凭据时抛 MISSING_CREDENTIAL', async () => {
    const adapter = makeAdapter({ credential: undefined })
    await expect(async () => {
      for await (const _ of adapter.stream({
        provider: 'raccoon', model: 'sn-glm-5-3',
        messages: [{ role: 'user', content: 'hi' }],
      } as unknown as GenerateOptions)) { void _ }
    }).rejects.toThrow(/credential|登录/i)
  })

  it('给不支持图片的模型传图片时抛 UNSUPPORTED_CONTENT', async () => {
    // ⚠️ 必须注入 fetcher：否则判断通过后会真的发网络请求，
    // 用例就变成「因为 401 而失败」而不是「因为图片不支持而失败」。
    const fetcher = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] }),
    ]))
    const adapter = makeAdapter({
      models: [remoteModel({ tags: ['general'] })],
      fetcher: fetcher as unknown as typeof fetch,
    })
    await expect(async () => {
      for await (const _ of adapter.stream({
        provider: 'raccoon', model: 'sn-glm-5-3',
        messages: [{
          role: 'user',
          // ⚠️ 图片块的真实形状是 `{ type:'image', attachment:{ attachmentId } }`
          // —— 判据在 `collectImages` 里读的是 `attachment.attachmentId`。
          content: [{ type: 'image', attachment: { attachmentId: 'img-1' } }],
        }],
      } as unknown as GenerateOptions)) { void _ }
    }).rejects.toThrow(/图片|UNSUPPORTED/i)
  })

  it('HTTP 401 时刷新一次再重试', async () => {
    let calls = 0
    let refreshed = false
    const fetcher = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('{}', { status: 401 })
      return sseResponse([JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })])
    })
    const adapter = new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => CRED,
      refresh: async () => { refreshed = true },
      fetchRemoteModels: async () => [],
      fetchImpl: fetcher as unknown as typeof fetch,
    })
    services.push(adapter as unknown as { [Symbol.dispose]?: () => void })
    await collect(adapter, {})
    expect(refreshed).toBe(true)
    expect(calls).toBeGreaterThan(1)
  })
})

describe('registerRaccoonLlm', () => {
  it('只注册适配器路由并返回实例（不声明可配置 provider）', () => {
    // ⚠️ 2026-10-01（用户要求）：见 src/llm-register-compat.ts 模块头。
    const ctx = makeContext()
    const registered: string[] = []
    ctx.provide('llm', {
      registerConfigurableProviders: (list: Array<{ provider: string }>) => {
        for (const item of list) registered.push(item.provider)
      },
      registerAdapter: (ids: string[]) => { for (const id of ids) registered.push(id) },
    } as never)
    const adapter = registerRaccoonLlm(ctx, {
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
    })
    services.push(adapter as unknown as { [Symbol.dispose]?: () => void })
    // 唯一一次登记来自 registerAdapter：configurable 目录没被碰过。
    expect(registered).toEqual(['raccoon'])
    expect(adapter).toBeInstanceOf(RaccoonAdapter)
  })
})

/**
 * ⚠ **目录缓存不得被兜底表污染**（全仓同型缺陷，2026-08 起长期存在）。
 *
 * 原实现 `this.remoteModels = fallback; return fallback` 把兜底表当成「已加载」
 * 记下 ⇒ 一次瞬时失败就让它**整个进程生命周期**都只剩兜底模型：用户看不到自己的
 * 模型，且无从触发重试（`if (this.remoteModels !== undefined) return` 永远短路），
 * 只能重启 DSH。同批修好的还有 loomy / minimax / zcode 三个同型适配器。
 *
 * 另见 `tests/unit/remote-catalog-gate.spec.ts`（并发去重 + 失败冷却）。
 */
describe('RaccoonAdapter 目录缓存语义（★ 兜底表不进缓存）', () => {
  function makeFailing(fetchRemoteModels: () => Promise<RaccoonRemoteModel[]>): RaccoonAdapter {
    const adapter = new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
      fetchRemoteModels,
    })
    services.push(adapter as unknown as { [Symbol.dispose]?: () => void })
    return adapter
  }

  it('★ 远端抛错时不把兜底表写进 remoteModels', async () => {
    const adapter = makeFailing(async () => { throw new Error('network down') })
    expect((await adapter.listModels('raccoon')).length).toBeGreaterThan(0)
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeUndefined()
  })

  it('★ 远端返回空目录时不落缓存，且只拉一次（不被每个模型的 resolveModel 放大）', async () => {
    let calls = 0
    const adapter = makeFailing(async () => { calls += 1; return [] })
    expect((await adapter.listModels('raccoon')).length).toBeGreaterThan(0)
    expect((await adapter.listModels('raccoon')).length).toBeGreaterThan(0)
    await adapter.resolveModel('raccoon', 'sn-glm-5-3')
    expect(calls).toBe(1)
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeUndefined()
  })

  it('远端成功时缓存生效（不破坏既有「成功即缓存」约定）', async () => {
    let calls = 0
    const adapter = makeFailing(async () => {
      calls += 1
      return [{
        id: 'sn-glm-5-3', name: 'GLM-5-3 · x0.75', contextWindow: 1_000_000,
        maxTokens: 100_000, supportsImage: false,
      }] as RaccoonRemoteModel[]
    })
    await adapter.listModels('raccoon')
    await adapter.listModels('raccoon')
    expect(calls).toBe(1)
  })
})

/**
 * 请求级账号轮换（★ 2026-10-05，用户报障「余额用完一个号就卡死，不切下一个号」）。
 *
 * ## 症状与根因
 *
 * raccoon 的 `resolveCredential` 会从账号池取号（有 6 个账号），但适配器的
 * stream() **没有任何请求级换号逻辑**：首个账号余额耗尽（上游报
 * `14018 Credits exhausted`）时错误直接抛给 harness —— 而池按「手动顺序」
 * 取号，下次请求仍取回同一个坏号 ⇒ 表现为「卡死在一个号上」。
 *
 * ## 对齐目标：buddy 的语义
 *
 * `buddy-adapter.ts` 的既有实现（本项目「无感换号」的基准）：
 *
 * 1. HTTP 层失败且可换号（限流/额度/认证）⇒ 标记当前账号该模型受限 →
 *    `getAvailableAccount(provider, model, tried)` 取下一个 → 重发；
 * 2. `tried` 集合保证每个账号只试一次（不排除会拿回同一个号）；
 * 3. 全部候选试完才报「所有账号均不可用」，且带上**最后一次**的真实原因；
 * 4. 非限流类错误（如 400 参数错）**不换号**——换号无益，按原错误抛。
 *
 * 本 describe 锁定 raccoon 对齐该语义；SSE 层（流内错误帧）的约束是
 * 「已产出正文后绝不重发」（防重复计费），与 trae 的既有哨兵同款。
 */
describe('RaccoonAdapter 请求级账号轮换（余额耗尽无感切号）', () => {
  /** 池桩：按 exclude 排除已试过的号，记录标记调用。 */
  function makePoolStub(count = 2) {
    const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const picks: Array<ReadonlySet<string> | undefined> = []
    // ⚠️ `count` 可调是为了让「轮换预算恰好用尽」的边界场景可测：账号数
    // 少于 2 时末号漏记被掩盖（同义反复），等于 RACCOON_MAX_ROTATE 时暴露。
    // ⚠️ 前两个号沿用既有的 `raccoon-A` / `raccoon-B` 与 `tok-A` / `tok-B`
    // （既有用例按这两个 id 与 token 断言，不改名以免把无关改动混进来），
    // 第 3 个起才按序号命名。
    const accounts = Array.from({ length: count }, (_, i) => {
      const legacy = [
        { id: 'raccoon-A', token: 'tok-A' },
        { id: 'raccoon-B', token: 'tok-B' },
      ][i]
      return legacy ?? { id: `raccoon-${i + 1}`, token: `tok-${i + 1}` }
    })
    const pool = {
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        marks.push({ accountId, modelId, resetAtMs })
      },
      getAvailableAccount: async (_provider: string, _model: string, exclude?: ReadonlySet<string>) => {
        picks.push(exclude)
        for (const a of accounts) {
          if (exclude?.has(a.id)) continue
          return { entry: { id: a.id }, credential: { access_token: a.token, refresh_token: 'r' } }
        }
        return null
      },
      // ⚠️ 生产里适配器靠它把「首号凭据」反查成账号 id（轮换记账的键）。
      // 桩必须复刻该行为，否则轮换退化为「不标记」——测试就测不到真实形状。
      findAccountIdByCredential: async (_provider: string, identity: string) =>
        accounts.find((a) => a.token === identity)?.id ?? '',
    }
    return { pool, marks, picks, accounts }
  }

  const sse = (frames: string[]) => sseResponse(frames)

  it('★ 一号余额耗尽（14018）→ 标记该模型 + 切二号重发成功', async () => {
    const { pool, marks, picks } = makePoolStub()

    // 按请求头里的 Authorization 区分是哪个账号发的请求。
    // 首发凭据 = 池给的第一个号（对齐生产：resolveCredential 从池取号）。
    const seenAuth: string[] = []
    let call = 0
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1
      seenAuth.push(String(new Headers(init.headers).get('Authorization') ?? ''))
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 })
      }
      return sse([
        JSON.stringify({ choices: [{ delta: { content: '从二号账号返回' } }] }),
      ])
    })

    const adapter = makeAdapter({
      pool: pool as unknown as AccountPool,
      fetcher: fetcher as unknown as typeof fetch,
      credential: { access_token: 'tok-A', refresh_token: 'r' },
    })
    const chunks = await collect(adapter, {})

    // 枢纽断言：必须真的换号重发，且用户拿到的是二号账号的成功响应。
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(seenAuth[0]).toContain('tok-A')
    expect(seenAuth[1]).toContain('tok-B')
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    // 换号前必须把坏号标记在该模型上（下次选号自动跳过它）。
    expect(marks.some((m) => m.accountId === 'raccoon-A' && m.modelId === 'sn-glm-5-3')).toBe(true)
    // 取号必须传 exclude（否则池按手动顺序恒取回一号，换号形同虚设）。
    expect(picks[0]?.has('raccoon-A') ?? picks[0] === undefined).toBe(true)
  })

  it('★ 两号都耗尽 → 报「所有账号均不可用」并带最后一次的真实原因', async () => {
    const { pool, marks } = makePoolStub()
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = String(new Headers(init.headers).get('Authorization') ?? '')
      return new Response(
        JSON.stringify({ error: { message: `14018 exhausted (${auth.includes('tok-B') ? 'B' : 'A'})` } }),
        { status: 402 },
      )
    })
    const adapter = makeAdapter({ pool: pool as unknown as AccountPool, fetcher: fetcher as unknown as typeof fetch })
    const error = await collect(adapter, {}).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('所有账号')
    expect((error as Error).message).toContain('B') // 最后一次的真实原因，不是笼统的"均受限"
    expect(marks.map((mark) => mark.accountId)).toEqual(['raccoon-A', 'raccoon-B'])
  })

  /**
   * ★★ 「**最后一个**失败账号必须被标记」—— 本 PR 修复的是这个缺陷。
   *
   * ## 缺陷
   *
   * 旧实现把写标记放在 `for` 循环**开头**。于是**迭代次数 = 标记次数**，
   * 而最后一次失败发生在循环体**末尾**、不会再有下一次迭代 ⇒ **末号漏记**。
   * 漏记 ⇒ 下次请求又选中它 ⇒ 正是本段要修的「卡死在一个号上」。
   *
   * ## ⚠️ 两条账号的用例**测不到**这个缺陷（同义反复，PR 初版就栽在这里）
   *
   * 循环跑 2 次、写 2 个标记，`toEqual(['A','B'])` 在修复前后**输出一模一样**。
   * 缺陷只在**轮换预算恰好用尽**（池里账号数 ≥ `RACCOON_MAX_ROTATE`）或
   * **末号之后池已空**时暴露 —— 下面两条用例才是真正锁住修复的回归。
   */
  it('★★ 8 账号全耗尽（轮换预算恰好用尽）→ 8 个号全部被标记，末号不漏', async () => {
    const { pool, marks } = makePoolStub(8)
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 },
    ))
    const adapter = makeAdapter({
      pool: pool as unknown as AccountPool,
      fetcher: fetcher as unknown as typeof fetch,
      // ⚠️ 必须是池里**第一个号**的 token（`tok-A`），否则 `findAccountIdByCredential`
      // 反查不到 → `activeAccountId` 为空 → 一个标记都不写（测不到本缺陷）。
      credential: { access_token: 'tok-A', refresh_token: 'r' },
    })
    await collect(adapter, {}).catch(() => undefined)

    // 反向验证：把 `await markCurrentAccount()`（循环前那次）删掉，
    // 这里会得到 7 个标记、末号 `raccoon-8` 漏记 ⇒ 用例变红。
    expect(marks.map((m) => m.accountId)).toEqual([
      'raccoon-A', 'raccoon-B', 'raccoon-3', 'raccoon-4',
      'raccoon-5', 'raccoon-6', 'raccoon-7', 'raccoon-8',
    ])
  })

  /** ★ 末号失败后池已空（`getAvailableAccount` 返回 null）→ 末号同样必须被标记。 */
  it('★★ 末号失败后池已空 → 末号仍被标记（不因「没有下一个号」而漏记）', async () => {
    const marks: Array<{ accountId: string }> = []
    const pool = {
      updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
      getAvailableAccount: async () => null,
      findAccountIdByCredential: async () => 'raccoon-A',
    }
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 },
    ))
    const adapter = makeAdapter({
      pool: pool as unknown as AccountPool,
      fetcher: fetcher as unknown as typeof fetch,
      credential: { access_token: 'tok-A', refresh_token: 'r' },
    })
    await collect(adapter, {}).catch(() => undefined)

    expect(marks.map((m) => m.accountId)).toEqual(['raccoon-A'])
  })

  /**
   * ★★ 401 续期后**必须重新反查账号 id**（PR !71 审计发现的真实缺陷）。
   *
   * `resolveCredential` 是「池优先」的（`src/index.ts` 的 raccoon 分支先
   * `getAvailableAccount` 再回退单凭据 ref），而 `refresh()` 续期的是
   * **默认单凭据 ref**。⇒ 续期后取回的凭据**可能属于另一个账号**。
   *
   * 旧实现不更新 `activeAccountId` ⇒ 冷却标记**记在没发这次请求的号头上**：
   * 没耗尽的号被封 24h，而真该封的号下次仍被选中（缺陷照旧）。
   * 这与 AGENTS.md 记的 Qoder「标记用了会变的回调导致标错账号」同型。
   */
  it('★★ 401 续期后凭据换成了别的账号 → 标记记在**真正耗尽的那个号**上', async () => {
    const marks: Array<{ accountId: string }> = []
    // ⚠️ 桩必须自洽：id ↔ token 一一对应，否则 `findAccountIdByCredential`
    // 与 `getAvailableAccount` 会互相认错号（我第一版就踩了这个：
    // 取号发的是 `tok-raccoon-B`、而续期后是 `tok-B`，反查得到另一个 id）。
    const byToken: Record<string, string> = { 'tok-A': 'raccoon-A', 'tok-B': 'raccoon-B' }
    const pool = {
      updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
      getAvailableAccount: async (_p: string, _m: string, exclude?: ReadonlySet<string>) => {
        for (const token of ['tok-A', 'tok-B']) {
          const id = byToken[token]!
          if (exclude?.has(id)) continue
          return { entry: { id }, credential: { access_token: token, refresh_token: 'r' } }
        }
        return null
      },
      findAccountIdByCredential: async (_p: string, identity: string) => byToken[identity] ?? '',
    }
    // 第 1 次解析 = A 的凭据；续期后 = B 的凭据（生产语义：refresh 续的是
    // 默认单凭据 ref，随后 resolveCredential 又从池里取第一个可用号）。
    let resolves = 0
    const adapter = new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => (++resolves === 1
        ? { access_token: 'tok-A', refresh_token: 'r' }
        : { access_token: 'tok-B', refresh_token: 'r2' }),
      refresh: async () => {},
      accountPool: pool as unknown as AccountPool,
      fetchRemoteModels: async () => RACCOON.fallbackModels.map((m) => ({
        id: m.id, name: m.name, contextWindow: m.contextWindow,
        maxTokens: m.maxTokens, supportsImage: m.supportsImage,
      })),
      // A 返回 401（触发续期）；此后无论哪个号都额度耗尽。
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const auth = String(new Headers(init.headers).get('Authorization') ?? '')
        if (auth.includes('tok-A')) return new Response('{"code":200003}', { status: 401 })
        return new Response(
          JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 },
        )
      }) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter, {}).catch(() => [])

    expect(chunks).toEqual([])                       // 全池耗尽，如实抛错
    // 真正耗尽的是 B —— A 只返回了 401（认证类，本就不该写标记）。
    expect(marks.map((m) => m.accountId)).toEqual(['raccoon-B'])
  })

  it('非额度类错误（400 参数错）不换号 —— 换号无益，按原错误抛', async () => {
    const { pool } = makePoolStub()
    const fetcher = vi.fn(async () => new Response('{"error":{"message":"param is invalid"}}', { status: 400 }))
    const adapter = makeAdapter({ pool: pool as unknown as AccountPool, fetcher: fetcher as unknown as typeof fetch })
    const error = await collect(adapter, {}).catch((e: unknown) => e)

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((error as Error).message).toContain('param is invalid')
  })

  /**
   * ★ 授权类失败**绝不写冷却标记**（真实回归，2026-10-06 凌晨全池被封 24h）。
   *
   * ## 事故经过（证据链）
   *
   * 上游网关开始对**全池**回 `HTTP 401 + code=200003 authorization_verify_error`
   * ——这是**网关侧**的授权校验失败（不是某个号的额度问题）。当时的实现把
   * 「401/403」也算「可换号」**并且**在每次换号前写冷却标记，冷却时长取
   * `status === 429 ? 1h : 24h` ⇒ 401 落到 **24 小时**。
   *
   * 于是一个请求内的换号循环连试 6 个号、给每个都写了 24h：
   * → 池内该模型候选筛空 → 下一次请求报 `no usable credential; log in first`
   * → **整个 provider 被封 24 小时**（用户手动清标记才恢复）。
   *
   * ## 正确语义（对齐 buddy 的既有实现）
   *
   * buddy 的换号循环里，**只有限流类**才写标记；认证类（401/403）只
   * `continue` 换下一个号、**不写标记** —— 因为「凭据失效」是**账号态**而非
   * 「该模型冷却」，写标记会让池把无辜账号长期排除，且网关侧的授权故障会
   * 把整池一起封掉（正是本次事故）。
   */
  it('★ 401 授权失败（authorization_verify_error）：换号但**绝不写冷却标记**', async () => {
    const { pool, marks } = makePoolStub()
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = String(new Headers(init.headers).get('Authorization') ?? '')
      if (auth.includes('tok-A')) {
        return new Response(
          JSON.stringify({ code: 200003, message: 'authorization_verify_error' }),
          { status: 401 },
        )
      }
      return sse([JSON.stringify({ choices: [{ delta: { content: '二号账号正常' } }] })])
    })
    const adapter = makeAdapter({
      pool: pool as unknown as AccountPool,
      fetcher: fetcher as unknown as typeof fetch,
      credential: { access_token: 'tok-A', refresh_token: 'r' },
    })
    const chunks = await collect(adapter, {})

    // 换号仍要发生（另一号的 token 可能是好的）
    expect(fetcher.mock.calls.length).toBeGreaterThan(1)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    // 但**一个标记都不能写**（回归断言：旧实现写了 24h → 全池被封）
    expect(marks).toEqual([])
  })

  it('★ 401 打遍全池：仍不写任何标记（池保持可用，网关恢复后即自愈）', async () => {
    const { pool, marks } = makePoolStub()
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ code: 200003, message: 'authorization_verify_error' }),
      { status: 401 },
    ))
    const adapter = makeAdapter({
      pool: pool as unknown as AccountPool,
      fetcher: fetcher as unknown as typeof fetch,
      credential: { access_token: 'tok-A', refresh_token: 'r' },
    })
    const error = await collect(adapter, {}).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('所有账号')
    // 关键：全池失败也**不留任何标记**（旧实现会把 6 个号各封 24h）
    expect(marks).toEqual([])
  })

  it('429 限流才写标记，且时长是 1 小时档（不是 24 小时）', async () => {
    const { pool, marks } = makePoolStub()
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = String(new Headers(init.headers).get('Authorization') ?? '')
      if (auth.includes('tok-A')) return new Response('', { status: 429 })
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })])
    })
    const adapter = makeAdapter({
      pool: pool as unknown as AccountPool,
      fetcher: fetcher as unknown as typeof fetch,
      credential: { access_token: 'tok-A', refresh_token: 'r' },
    })
    await collect(adapter, {})

    expect(marks.length).toBe(1)
    const cooldown = marks[0].resetAtMs - Date.now()
    expect(cooldown).toBeGreaterThan(50 * 60_000)   // ≈1h
    expect(cooldown).toBeLessThanOrEqual(60 * 60_000)
  })

  it('额度耗尽（14018）写的是 24 小时档（日配额，与 429 区分）', async () => {
    const { pool, marks } = makePoolStub()
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = String(new Headers(init.headers).get('Authorization') ?? '')
      if (auth.includes('tok-A')) {
        return new Response(JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 })
      }
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })])
    })
    const adapter = makeAdapter({
      pool: pool as unknown as AccountPool,
      fetcher: fetcher as unknown as typeof fetch,
      credential: { access_token: 'tok-A', refresh_token: 'r' },
    })
    await collect(adapter, {})

    expect(marks.length).toBe(1)
    const cooldown = marks[0].resetAtMs - Date.now()
    expect(cooldown).toBeGreaterThan(23 * 3_600_000)
  })

  it('已产出正文后流内报错不重发（防重复计费，与 trae 哨兵同款）', async () => {
    const { pool } = makePoolStub()
    let call = 0
    const fetcher = vi.fn(async () => {
      call += 1
      if (call === 1) {
        return sse([
          JSON.stringify({ choices: [{ delta: { content: '已经发出的一半内容' } }] }),
          JSON.stringify({ error: { message: '14018 exhausted mid-stream' } }),
        ])
      }
      return sse([JSON.stringify({ choices: [{ delta: { content: '不该出现' } }] })])
    })
    const adapter = makeAdapter({ pool: pool as unknown as AccountPool, fetcher: fetcher as unknown as typeof fetch })
    const chunks: StreamChunk[] = []
    let streamError: unknown
    try {
      for await (const c of adapter.stream({
        provider: 'raccoon', model: 'sn-glm-5-3',
        messages: [{ role: 'user', content: 'hi' }],
      } as unknown as GenerateOptions)) chunks.push(c)
    } catch (e) { streamError = e }

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta' && String((c as { text?: string }).text ?? '').includes('一半内容'))).toBe(true)
    expect(streamError).toBeInstanceOf(Error)
  })
})

/**
 * ★★ 网关 499（client closed request）必须归 **aborted 形态**。
 *
 * ## 为什么之前零覆盖（2026-10-12 审计实测）
 *
 * `c411fa8` 只改了 `src/raccoon-adapter.ts` + `package.json`，**没带任何测试** ——
 * 审计实测该 spec 里匹配 `499|aborted|AbortError` 的行数为 **0**。
 * 本组补上，并把该修复的**已知缺口**（SSE 内嵌帧路径）也如实锁住。
 *
 * ## 为什么必须由**适配器自己**抛
 *
 * `raccoon` 是**直接 provider 适配器**，请求不经 aggregate 路由 ⇒
 * `aggregate-adapter.ts` 的 `isAbortLike` 第四条**覆盖不到它**。
 * 旧路径把 499 包成普通 `LlmError`（`code = httpErrorCode(499)` = `'HTTP_499'`）
 * ⇒ 外层 `adapterFailureChunk` 归 `kind: 'error'` ⇒ 终端显示「本轮运行失败」。
 *
 * ⚠️⚠️ **重试资格不受本改动影响**（实测，别按直觉推断）：
 * `DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`
 * —— **`HTTP_499` 与 `ABORTED` 都不在其中**。故本改动只改外层归类的 `kind`
 * （`error` → `aborted`），**不改变**「会不会重试」。
 */
describe('★★ raccoon 网关 499 必须归 aborted 形态（PR #87 c411fa8，原零测试）', () => {
  const failingFetcher = (status: number, body: string) =>
    vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch

  const catchError = async (
    adapter: RaccoonAdapter,
  ): Promise<{ name?: string; code?: string; message?: string } | undefined> => {
    try {
      await collect(adapter, {})
      return undefined
    } catch (error) {
      return error as { name?: string; code?: string; message?: string }
    }
  }

  it('★ 499 + `client has aborted request` ⇒ name=AbortError / code=ABORTED', async () => {
    const adapter = makeAdapter({ fetcher: failingFetcher(499, 'client has aborted request') })
    const error = await catchError(adapter)
    expect(error?.code, '必须归 ABORTED（外层靠它判 aborted）').toBe('ABORTED')
    expect(error?.name, 'name 也要设（isAbortLike 先看 name）').toBe('AbortError')
    expect(error?.message).toContain('aborted request')
  })

  it('★ 499 但 body **没有** aborted 字样 ⇒ 仍归 ABORTED（status 腿独立成立）', async () => {
    // ⚠️ 判据是 `status === 499 || 正则`，两条腿**独立**。只留正则腿这条会红。
    const adapter = makeAdapter({ fetcher: failingFetcher(499, '{"error":"unknown"}') })
    expect((await catchError(adapter))?.code).toBe('ABORTED')
  })

  it('★ 非 499 状态但 body 含 aborted request ⇒ 也归 ABORTED（正则腿独立成立）', async () => {
    const adapter = makeAdapter({ fetcher: failingFetcher(400, 'another client has aborted request') })
    expect((await catchError(adapter))?.code).toBe('ABORTED')
  })

  it('★★ 反例：真故障必须**保持**原 code（判据不得恒真）', async () => {
    // ⚠️ 500 ⇒ `httpErrorCode` 给 `SERVER`（**可重试**）。判据恒真会让它变成
    //    ABORTED ⇒ 丢掉重试资格。这是本组最重要的反例。
    const adapter = makeAdapter({ fetcher: failingFetcher(500, 'upstream exploded') })
    expect((await catchError(adapter))?.code).toBe('SERVER')
  })

  it('★ 反例：400 参数错保持 `INVALID_REQUEST`（既不误归 aborted，也不误归可重试）', async () => {
    // ⚠️ `httpErrorCode(400)` 给的是 `INVALID_REQUEST`（不是 `HTTP_400`）——
    //    4xx 里只有 401/403/429 与 400 有专用码，其余才落 `` `HTTP_${status}` ``。
    const adapter = makeAdapter({ fetcher: failingFetcher(400, 'bad request payload') })
    const error = await catchError(adapter)
    expect(error?.code).toBe('INVALID_REQUEST')
    expect(error?.name).not.toBe('AbortError')
  })

  it('⚠️ 边界如实记录：`HTTP_4990` 这类前缀串**会**被误命中（与 aggregate 侧同口径）', async () => {
    // 判据正则 `/aborted request|HTTP_?499/i` **无词边界**，故 `HTTP_4990`
    // 会被当成 499。此处把边界**如实锁住**，而不是单方面收严 ——
    // 同族判据（aggregate 侧 `isAbortLike`）就是同一形态，两处不得分叉。
    const adapter = makeAdapter({ fetcher: failingFetcher(400, 'HTTP_4990 token limit reached') })
    expect((await catchError(adapter))?.code).toBe('ABORTED')
  })

  it('🔴 已知缺口（如实锁住，非契约）：**SSE 内嵌错误帧路径**上 499 仍归 `SERVER`', async () => {
    // ⚠️⚠️ 真实缺口（2026-10-12 审计实测）：`abortLikeOrNormal` 只在**两个
    //    HTTP 非 ok 的抛出点**被调用；而 HTTP 200 + SSE 内嵌错误帧那条路径
    //    走 `consumeOpenAiSse`，**不经过它** ⇒ 499 在那里仍抛 `code='SERVER'`
    //    ⇒ 外层归 `kind:'error'` ⇒ 终端仍显示「本轮运行失败」。
    //
    // ⚠️ 修它要动 `src/openai-compat.ts`（**所有 provider 共享**的错误归类层），
    //    影响面远超本次范围，故**本分支不擅自扩大改动面**，只登记。
    //
    // ⚠️ 这条断言**刻意只锁「现状事实」**（SSE 路径拿到的是 SERVER），
    //    **不是**把缺口当契约：若将来有人在 `consumeOpenAiSse` 那层统一修好
    //    （正确方向），本用例会红 —— 那时**应当改写它**，而不是回退修复。
    const fetcher = vi.fn(async () => sseResponse([
      JSON.stringify({ statusCodeValue: 499, message: 'client has aborted request' }),
    ])) as unknown as typeof fetch
    const adapter = makeAdapter({ fetcher })
    const error = await catchError(adapter)
    expect(
      error?.code,
      'SSE 内嵌帧路径当前归 SERVER（已知缺口）。若此处变成 ABORTED，说明该层已统一修复，'
      + '请改写本用例而不是回退修复。',
    ).toBe('SERVER')
  })
})

/**
 * issue IKS1L5：上游网关对 `max_tokens` **硬校验 1..65536**，命中即整轮 400，
 * 且该 model group **没有配 fallback** ⇒ 没有任何重试机会。
 *
 * ⚠️ 两处都必须夹（只夹一处会漏）：
 * - **声明值**（`toCatalogEntry` → DSH 的 `defaultMaxTokens`）：DSH 每轮都会把这个
 *   声明值**回传**进请求，所以只夹请求体的话第二轮及以后照样带 100000；
 * - **请求体**（`buildBody` 的 `max_tokens`）：来自 `titlePlan.maxTokens`，
 *   非标题请求时是原样透传调用方（用户 / OpenAI 兼容网关都能塞 999999）。
 */
describe('★ max_tokens 收敛到上游上限（issue IKS1L5）', () => {
  it('★ 远端声明 100_000 ⇒ 声明值被夹到 65_536（否则 DSH 每轮回传 100000）', async () => {
    const adapter = makeAdapter({ models: [remoteModel({ params: { context_window: 1_000_000, max_tokens: 100_000 } })] })
    const resolved = await adapter.resolveModel('raccoon', 'sn-glm-5-3')
    expect(resolved.defaultMaxTokens).toBe(RACCOON_MAX_OUTPUT_TOKENS)
  })

  /** 驱动一次 stream，把抓到的请求体解析出来。 */
  async function bodyOf(maxTokens: number | undefined): Promise<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })])
    }) as unknown as typeof fetch
    const adapter = makeAdapter({ fetcher, models: [remoteModel()] })
    await collect(adapter, maxTokens === undefined ? {} : { maxTokens })
    expect(bodies.length).toBeGreaterThan(0)
    return bodies[0]!
  }

  it('★★ 请求体：调用方给 100_000 ⇒ 下发 65_536（这道是「网关塞 999999」的防线）', async () => {
    const body = await bodyOf(100_000)
    expect(body.max_tokens).toBe(RACCOON_MAX_OUTPUT_TOKENS)
  })

  it('★ 请求体：调用方给 1024 ⇒ 保持 1024（**不许抬高**）', async () => {
    const body = await bodyOf(1024)
    expect(body.max_tokens).toBe(1024)
  })

  it('★★ 会话标题请求（DSH 给 64）不得被抬高到 65536 —— 那会让标题烧钱', async () => {
    // ⚠️ 夹子是 `Math.min`，天然不会抬高；这条钉的是「将来有人把夹子写成
    //    『统一改成上限』」那种改动（`max_tokens = MAX` 的写法也能让 100000 变合法，
    //    但会把 64 token 的标题请求放大 1024 倍）。
    const bodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: '标题' } }] })])
    }) as unknown as typeof fetch
    const adapter = makeAdapter({ fetcher, models: [remoteModel()] })
    await collect(adapter, { maxTokens: 64, purpose: 'session-title' })
    expect(bodies[0]!.max_tokens).toBe(64)
  })

  it('★★ 网关塞 999_999 也不会漏出去（边界大于上限的那个方向）', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })])
    }) as unknown as typeof fetch
    const adapter = makeAdapter({ fetcher, models: [remoteModel()] })
    await collect(adapter, { maxTokens: 999_999 })
    expect(bodies[0]!.max_tokens).toBe(RACCOON_MAX_OUTPUT_TOKENS)
  })

  it('★ 请求体：调用方没指定 ⇒ 不下发该字段（与服务端默认一致）', async () => {
    const body = await bodyOf(undefined)
    expect('max_tokens' in body).toBe(false)
  })

  it('★ 夹子对非法值仍返回 undefined（0 / 负数 / 非整数 / NaN 不得被夹成「合法小数字」）', () => {
    for (const bad of [0, -1, Number.NaN, 1.5, undefined, '999999']) {
      expect(clampRaccoonMaxTokens(bad), String(bad)).toBeUndefined()
    }
    expect(clampRaccoonMaxTokens(65_536)).toBe(65_536)
    expect(clampRaccoonMaxTokens(999_999)).toBe(65_536)
  })
})
