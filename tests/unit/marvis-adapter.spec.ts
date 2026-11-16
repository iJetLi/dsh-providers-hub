/**
 * ★ Marvis 适配器：目录门控 / 错误分类 / 槽轮换 / 流式解析。
 *
 * 判据全部打在**用户可见后果**上（目录里有没有、抛什么码、打了几次请求），
 * 不锁实现细节 —— 与 modelscope 的两份迁移规格同构。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarvisAdapter, marvisRetryAfterMs } from '../../src/marvis-adapter.js'
import { MARVIS, MARVIS_FALLBACK_MODELS } from '../../src/marvis-product.js'
import type { AccountPool } from '../../src/account-pool.js'
import type { MarvisCredential } from '../../src/marvis.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const CREDENTIAL: MarvisCredential = {
  access_token: 'mv-test-access-token',
  refresh_token: 'test-refresh-token-0001',
  openid: '0123456789abcdef0123456789abcdef',
  guid: 'fedcba9876543210fedcba9876543210',
  login_type: '1',
}

/** 一个「有已登录账号」的账号池替身（只实现门控与黑名单两个消费点）。 */
function makePool(
  options: { disabled?: readonly string[]; closed?: boolean; visible?: boolean } = {},
): AccountPool {
  return {
    disabledModelsFor: () => new Set(options.disabled ?? []),
    providerClosedFor: () => options.closed ?? false,
    hasLoggedInAccount: async () => options.visible ?? true,
  } as never
}

function makeAdapter(options: {
  pool?: AccountPool
  slots?: readonly { id: string; credential: MarvisCredential }[]
  markLimited?: (slotId: string, modelId: string, resetAtMs: number) => void
  warn?: (message: string) => void
  readImage?: (ref: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
} = {}): MarvisAdapter {
  const slots = options.slots ?? [{ id: 'marvis-a1', credential: CREDENTIAL }]
  return new MarvisAdapter({
    product: MARVIS,
    accountPool: options.pool ?? makePool(),
    slots: async () => slots,
    ...(options.markLimited === undefined ? {} : { markLimited: options.markLimited }),
    ...(options.warn === undefined ? {} : { warn: options.warn }),
    ...(options.readImage === undefined ? {} : { readImage: options.readImage }),
  })
}

/** 一段最小 SSE 正文（正文 + 收尾 + usage）。 */
function sseBody(text: string): string {
  return [
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 1, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
}

async function collect(adapter: MarvisAdapter, model = 'deepseek-v4-pro-external'): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of adapter.stream({
    model,
    messages: [{ role: 'user', content: 'hi' }],
  } as never)) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
  }
  return chunks.join('')
}

describe('★ 目录：只有 deepseek-v4-pro-external，且由共享骨架门控', () => {
  it('★ 有账号 ⇒ 一条 deepseek-v4-pro-external，名字是美化名，声明 1M 上下文与图片能力', async () => {
    const listed = await makeAdapter().listModels(MARVIS.id)
    expect(listed).toHaveLength(1)
    const [entry] = listed as unknown as Array<{
      id: string
      name: string
      inputModalities?: readonly string[]
      contextWindow?: number
    }>
    expect(entry.id).toBe('deepseek-v4-pro-external')
    expect(entry.name).toBe('DeepSeek V4.1 Flash')
    // 宿主 `listModels` 会剥掉 contextWindow，但适配器必须交出去（网关走它）。
    expect(entry.contextWindow).toBe(1_000_000)
    expect(entry.inputModalities).toEqual(['text', 'image'])
    // 刻意不声明档位（思考默认开、关不掉）。
    expect((entry as { reasoning?: unknown }).reasoning).toBeUndefined()
  })

  it('★★ 关闭该模型 ⇒ 从 listModels 消失（黑名单对 Marvis 生效）', async () => {
    const listed = await makeAdapter({ pool: makePool({ disabled: ['deepseek-v4-pro-external'] }) }).listModels(
      MARVIS.id,
    )
    expect(listed).toEqual([])
  })

  it('★★ 关闭整个供应商 ⇒ listModels 恒空', async () => {
    expect(await makeAdapter({ pool: makePool({ closed: true }) }).listModels(MARVIS.id)).toEqual([])
  })

  it('★★ 没有已登录账号 ⇒ 目录为空（整个 provider 隐藏）', async () => {
    expect(await makeAdapter({ slots: [] }).listModels(MARVIS.id)).toEqual([])
  })

  it('★ listAllModels 必须同步（jet-hub-rpc 会 [...all]）', () => {
    const all = makeAdapter().listAllModels?.()
    expect(Array.isArray(all)).toBe(true)
    expect(all?.map((m) => m.id)).toEqual(['deepseek-v4-pro-external'])
  })

  it('★ 兜底表只有一条（防止有人顺手加回别的槽位）', () => {
    expect(MARVIS_FALLBACK_MODELS.map((m) => m.id)).toEqual(['deepseek-v4-pro-external'])
  })
})

describe('★ 模型 id 归一', () => {
  it('★ 数组下标 "0" 与真实模型 id 都归一成槽位 id', async () => {
    const adapter = makeAdapter()
    expect((await adapter.resolveModel(MARVIS.id, '0')).id).toBe('deepseek-v4-pro-external')
    expect((await adapter.resolveModel(MARVIS.id, 'deepseek-v4-1-flash-261017')).id).toBe(
      'deepseek-v4-pro-external',
    )
  })

  /**
   * ⚠️ 2026-11-10 对抗性审计 I6：`DEEPSEEK-V4-PRO-EXTERNAL` 原样透传会目录未命中 ⇒ 静默退化
   * 成「未知模型」（text-only / 无上下文 / 无图片），且**不报错**。
   */
  it('★★ 大小写变体同样归一（否则静默退化成未知模型）', async () => {
    const adapter = makeAdapter()
    const upper = await adapter.resolveModel(MARVIS.id, 'DEEPSEEK-V4-PRO-EXTERNAL')
    expect(upper.id).toBe('deepseek-v4-pro-external')
    expect(upper.name).toBe('DeepSeek V4.1 Flash')
    expect(upper.context).toEqual({ contextWindow: 1_000_000 })
    expect(upper.inputModalities).toEqual(['text', 'image'])
  })

  it('★ 未知 id 原样保留（静默替换成别的模型比报错更糟）', async () => {
    const resolved = await makeAdapter().resolveModel(MARVIS.id, 'gpt-5.4')
    expect(resolved.id).toBe('gpt-5.4')
    expect(resolved.name).toBe('gpt-5.4')
    expect(resolved.inputModalities).toEqual(['text'])
    expect(resolved.context).toBeUndefined()
  })
})

describe('★ 推理：正常流与 content-type 闸门', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('★★ 上游回 text/plain（实测如此）但 body 是 SSE ⇒ 正常产出正文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sseBody('你好'), {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })),
    )
    expect(await collect(makeAdapter())).toBe('你好')
  })

  it('★★ HTTP 200 + text/html 风控页 ⇒ SERVER，绝不是 QUOTA_EXCEEDED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>blocked</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })),
    )
    let code: string | undefined
    let message = ''
    try {
      await collect(makeAdapter())
    } catch (error) {
      code = (error as { code?: string }).code
      message = (error as Error).message
    }
    expect(code).not.toBe('QUOTA_EXCEEDED')
    expect(code).toBe('SERVER')
    expect(message).toContain('text/html')
  })

  it('★★★ system 里的腾讯系风控指纹必须被改写（IKJNA1 同一份表，2026-11-15 起 marvis 也登记）', async () => {
    // ⚠️ 这是**行为级**守卫：纯函数用例只证明 `rewriteTencentContentFingerprints` 对
    //    `'marvis'` 生效，不证明 adapter 真的调了它 —— 把这一行摘掉，纯函数用例仍全绿。
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(sseBody('ok'), {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    // 直接吃 stream：`collect` 不带 system，这里要的就是带 system 的那条路径。
    for await (const _chunk of makeAdapter().stream({
      model: 'deepseek-v4-pro-external',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'Main branch (you will usually use this for PRs)',
    } as never)) {
      // drain
    }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(init.body as string) as {
      system?: string
      messages: Array<{ role: string; content: unknown }>
    }
    // GitHub #97：顶层 `system` 会被上游静默忽略 ⇒ 必须折进 `messages[]`，
    // 且改写要作用在**折进去的那一份**上（两个位置共用一个函数）。
    expect(Object.hasOwn(payload, 'system'), '顶层不许再有 system').toBe(false)
    expect(payload.messages[0]).toEqual({ role: 'system', content: 'Main branch (PRs usually go here)' })
  })

  it('★★★ messages 里的 system 那条也必须改写（只改顶层 system 时 403 4100406）', async () => {
    // 2026-11-15 真机实测（Gitee issue IKVF8Z 同型）：同一份身份句
    //   · 只在顶层 `system` ⇒ 200（上一个用例覆盖）
    //   · 出现在 `messages[]` 的 system 消息里 ⇒ **403 `{"code":4100406,"msg":"非法请求"}`**
    // 故这条是**行为级**守卫：摘掉 `streamVia` 里那句 `.map(rewriteMarvisSystemMessage)`
    // 本用例立刻变红，而只断言顶层 `system` 的用例仍全绿（那正是漏掉它的形态）。
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(sseBody('ok'), {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    for await (const _chunk of makeAdapter().stream({
      model: 'deepseek-v4-pro-external',
      messages: [
        { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
        { role: 'user', content: 'hi' },
      ],
    } as never)) {
      // drain
    }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(init.body as string) as {
      messages: readonly { role: string; content: unknown }[]
    }
    const system = payload.messages.find((message) => message.role === 'system')
    expect(system).toBeDefined()
    // ⚠️ **三级链**，断言必须写成最终产物（Gitee IKVRNK）：
    //   ① 共用登记表把 DSH 身份句换成「官方同形措辞」
    //      `You are an AI coding assistant, powered by a large language model.`；
    //   ② 那句在 marvis 网关**也被拉黑了**（403/4100406，2026-11-16 实发）
    //      ⇒ 过 `rewriteMarvisBlockedIdentities` 换成实测放行的措辞；
    //   ③ 兜底正则此时已是 no-op。
    // ⇒ 只断言 ① 的产物就是**把被拦文本钉成了期望**（本文件此前正是如此）。
    // 「只换身份句本体」⇒ 原文 `, powered by a large language model.` 必须原样留下
    // （真机实测该形态 200；整句替换会把这半句删掉 = 内容损失）。
    expect(system?.content).toBe(
      'You are an AI agent for coding work, powered by a large language model.',
    )
    expect(String(system?.content)).not.toContain('DeepSeek Harness')
    // ★★★ 反向判据：产物里**不得**再出现被拦的两种措辞 —— 上游随时可能再登记，
    // 但「自己别主动写禁词」这一条不依赖上游。
    expect(String(system?.content)).not.toContain('AI coding assistant')
    expect(String(system?.content)).not.toContain('Claude Code')
  })

  it('★★ 表未登记的中文句式也被兜底清掉（上游漂移容忍）', async () => {
    // 证据：`你是一个由 DeepSeek Harness 驱动的 AI 智能体。` 实测同样 403/4100406，
    // 而登记表只有英文句式 ⇒ 兜底那条不该被当成多余代码删掉。
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(sseBody('ok'), {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    for await (const _chunk of makeAdapter().stream({
      model: 'deepseek-v4-pro-external',
      messages: [
        { role: 'system', content: '你是一个由 DeepSeek Harness 驱动的 AI 智能体。' },
        { role: 'user', content: 'hi' },
      ],
    } as never)) {
      // drain
    }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(init.body as string) as {
      messages: readonly { role: string; content: unknown }[]
    }
    expect(payload.messages[0]?.content).toBe('你是一个由 DSH 驱动的 AI 智能体。')
  })

  it('★★ user 正文里的同一句不得被改（只改 system，别篡改历史证据）', async () => {
    const sentence = '我从一条报错里看到: You are an AI agent powered by DeepSeek Harness'
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(sseBody('ok'), {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    for await (const _chunk of makeAdapter().stream({
      model: 'deepseek-v4-pro-external',
      messages: [{ role: 'user', content: sentence }],
    } as never)) {
      // drain
    }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(init.body as string) as {
      messages: readonly { role: string; content: unknown }[]
    }
    expect(payload.messages[0]?.content).toBe(sentence)
  })

  it('★★★ 兜底正则必须大小写不敏感 + 吞空白（否则小写/跨行变体仍 403）', async () => {
    // 对抗审计 P2-1（真发实测）：这三格**上游都 403** `4100406`，而当前实现靠
    // `/DeepSeek\s+Harness/gi` 的 `gi` 与 `\s+` 才挡住 —— 两个都零用例。
    // 把 `gi` 改 `g`、`\s+` 改空格，27 条全绿（无牙），所以这三格必须单独钉住。
    const variants = [
      'you are an ai agent powered by deepseek  harness.', // 全小写 + 双空格
      'You are an AI agent powered by DeepSeek\nHarness.', // 跨行
      'You are an AI agent powered by DeepSeek\t\tHarness.', // 制表符
    ]
    for (const sentence of variants) {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) =>
          new Response(sseBody('ok'), {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          }),
      )
      vi.stubGlobal('fetch', fetchMock)
      for await (const _chunk of makeAdapter().stream({
        model: 'deepseek-v4-pro-external',
        messages: [
          { role: 'system', content: sentence },
          { role: 'user', content: 'hi' },
        ],
      } as never)) {
        // drain
      }
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      const payload = JSON.parse(init.body as string) as {
        messages: readonly { role: string; content: unknown }[]
      }
      const wire = String(payload.messages.find((message) => message.role === 'system')?.content ?? '')
      expect(wire, `变体未被清洗：${JSON.stringify(sentence)}`).not.toMatch(/deepseek\s+harness/i)
    }
  })

  it('★★ 顶层 system 与 messages[] 的 system 必须走同一个函数（中文句在顶层也要被兜底清掉）', async () => {
    // 正向审计 P2-1：顶层此前只过登记表、没有兜底正则；而登记表对中文句**原样返回**
    // ⇒ 中文身份句放在顶层时不会被清洗（与「两个位置都要改」自相矛盾）。
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(sseBody('ok'), {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    for await (const _chunk of makeAdapter().stream({
      model: 'deepseek-v4-pro-external',
      messages: [{ role: 'user', content: 'hi' }],
      system: '你是一个由 DeepSeek Harness 驱动的 AI 智能体。',
    } as never)) {
      // drain
    }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(init.body as string) as {
      system?: string
      messages: Array<{ role: string; content: unknown }>
    }
    expect(Object.hasOwn(payload, 'system'), '顶层不许再有 system').toBe(false)
    expect(payload.messages[0]).toEqual({
      role: 'system',
      content: '你是一个由 DSH 驱动的 AI 智能体。',
    })
  })

  it('★★ 多条 system / system 在 user 之后，每一条都要改（不是只改第 0 条）', async () => {
    // 对抗审计 P2-3：把改写限定成 `index === 0` 时 27 条全绿（无牙）。
    const first = 'You are an AI agent powered by DeepSeek Harness.'
    const second = '你是一个由 DeepSeek Harness 驱动的 AI 智能体。'
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(sseBody('ok'), {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    for await (const _chunk of makeAdapter().stream({
      model: 'deepseek-v4-pro-external',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: first },
        { role: 'system', content: second },
      ],
    } as never)) {
      // drain
    }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const payload = JSON.parse(init.body as string) as {
      messages: readonly { role: string; content: unknown }[]
    }
    const systems = payload.messages.filter((message) => message.role === 'system').map((m) => String(m.content))
    expect(systems).toHaveLength(2)
    for (const text of systems) expect(text).not.toMatch(/deepseek\s+harness/i)
    expect(systems[1]).toBe('你是一个由 DSH 驱动的 AI 智能体。')
  })

  it('★ 请求头只带 Ual-Access-*（绝无签名头），body 带 include_usage', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(sseBody('ok'), {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await collect(makeAdapter())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://yybadaccess.3g.qq.com/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['Ual-Access-Openid']).toBe(CREDENTIAL.openid)
    expect(headers['Ual-Access-Guid']).toBe(CREDENTIAL.guid)
    expect(headers['Ual-Access-MarvisExt']).toBeTypeOf('string')
    // 模型网关加签名头 ⇒ 403 判成登录态过期。
    expect(Object.keys(headers).some((k) => /Signature|Businessid|Timestamp|Nonce/i.test(k))).toBe(
      false,
    )
    const payload = JSON.parse(init.body as string) as {
      model: string
      stream: boolean
      stream_options?: { include_usage?: boolean }
    }
    expect(payload.model).toBe('deepseek-v4-pro-external')
    expect(payload.stream).toBe(true)
    expect(payload.stream_options?.include_usage).toBe(true)
  })
})

describe('★ 错误分类与槽轮换', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('★ 没有账号 ⇒ MISSING_CREDENTIAL', async () => {
    let code: string | undefined
    try {
      await collect(makeAdapter({ slots: [] }))
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe('MISSING_CREDENTIAL')
  })

  it('★★ 4100403（HTTP 401）⇒ AUTH，且不写限流标记', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({ code: 4100403, msg: '客户端通用错误:登录态过期/未登录' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )),
    )
    const markLimited = vi.fn()
    let code: string | undefined
    try {
      await collect(makeAdapter({ markLimited }))
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe('AUTH')
    expect(markLimited).not.toHaveBeenCalled()
  })

  it('★★ 4130001（无效模型id）⇒ BAD_REQUEST，且不换号（只打一次请求）', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 4130001, msg: '客户端AI业务错误: 无效模型id' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    let code: string | undefined
    let message = ''
    try {
      await collect(
        makeAdapter({
          slots: [
            { id: 'marvis-a1', credential: CREDENTIAL },
            { id: 'marvis-a2', credential: CREDENTIAL },
          ],
        }),
      )
    } catch (error) {
      code = (error as { code?: string }).code
      message = (error as Error).message
    }
    expect(code).toBe('BAD_REQUEST')
    expect(message).toContain('无效模型id')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('★★ 429 限流 ⇒ 换下一个账号，并给前一个写冷却标记', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limit exceeded', {
        status: 429,
        headers: { 'content-type': 'text/plain', 'retry-after': '1' },
      }))
      .mockResolvedValueOnce(new Response(sseBody('第二个账号'), {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const markLimited = vi.fn()
    const text = await collect(
      makeAdapter({
        slots: [
          { id: 'marvis-a1', credential: CREDENTIAL },
          { id: 'marvis-a2', credential: CREDENTIAL },
        ],
        markLimited,
      }),
    )
    expect(text).toBe('第二个账号')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(markLimited).toHaveBeenCalledTimes(1)
    const [slotId, modelId] = markLimited.mock.calls[0] as unknown as [string, string]
    expect(slotId).toBe('marvis-a1')
    expect(modelId).toBe('deepseek-v4-pro-external')
  })

  it('★★ 402 额度耗尽 ⇒ **换号 + 写冷却标记**（回归：曾与「槽位耗尽」共用 QUOTA_EXCEEDED，被提前短路）', async () => {
    // 2026-11-09 评审 I2：从 modelscope 照抄过来的
    // `if (error.code === 'QUOTA_EXCEEDED') throw error` 会把**上游额度耗尽**
    // 也一起短路 ⇒ 既不换号、也不写冷却标记，`marvisRetryAfterMs('quota')`
    // 的「次日 UTC+8 零点」变成死代码，用户看到的是「所有账号均受限」，
    // 而另一个还有额度的账号一次都没被试过。
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 402, msg: 'insufficient quota' }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(sseBody('第二个账号'), {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const markLimited = vi.fn()
    const text = await collect(
      makeAdapter({
        slots: [
          { id: 'marvis-a1', credential: CREDENTIAL },
          { id: 'marvis-a2', credential: CREDENTIAL },
        ],
        markLimited,
      }),
    )
    expect(text).toBe('第二个账号')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(markLimited).toHaveBeenCalledTimes(1)
    expect(markLimited.mock.calls[0]?.[0]).toBe('marvis-a1')
  })

  /**
   * ⚠️ 2026-11-10 对抗性审计 I1：`context_window` 分支此前**零行为级覆盖**
   * （变异 `&& false` ⇒ 589 条全绿）。后果不是「多换一个号」而是：落进下面
   * 的默认「限流」分支 ⇒ 给账号写一个到**次日 UTC+8 零点**的标记 ⇒ 用户只是
   * 消息太长却被封一整天，且终态码被宿主换成「额度已用尽」（IKJVCW）。
   */
  it('★★ 上下文超限 ⇒ CONTEXT_WINDOW_EXCEEDED，不换号、不写限流标记', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 400, msg: 'maximum context length is 128000 tokens' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const markLimited = vi.fn()
    let code: string | undefined
    try {
      await collect(makeAdapter({
        slots: [
          { id: 'marvis-a1', credential: CREDENTIAL },
          { id: 'marvis-a2', credential: CREDENTIAL },
        ],
        markLimited,
      }))
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(markLimited).not.toHaveBeenCalled()
  })

  /**
   * ⚠️ 2026-11-10 对抗性审计 I2：`if (delivered) throw error` 此前**零覆盖**
   * （变异成 `if (false)` ⇒ 全绿）。后果是**真副作用**：流式已经吐了一半正文
   * （甚至工具调用）之后断流，再换号重放 ⇒ 用户看到正文重复、工具被执行两次。
   */
  it('★★ 已经吐出内容后断流 ⇒ 直接抛出，不得换号重放', async () => {
    // ⚠️ 这里**刻意**用子类替掉 `streamVia`（而不是伪造一个会中途报错的
    //    ReadableStream）：后者会被 `consumeOpenAiSse` 当成「流正常结束」吃掉，
    //    用例会变成测 SSE 解析器而不是测轮换循环的 `delivered` 闸门。
    const calls: string[] = []
    class ThrowingAdapter extends MarvisAdapter {
      protected override async *streamVia(): AsyncIterable<StreamChunk> {
        calls.push('a1')
        yield { type: 'text-delta', index: 0, text: '前半段' }
        throw Object.assign(new Error('socket hang up'), { code: 'TRANSPORT' })
      }
    }
    const adapter = new ThrowingAdapter({
      product: MARVIS,
      accountPool: makePool(),
      slots: async () => [
        { id: 'marvis-a1', credential: CREDENTIAL },
        { id: 'marvis-a2', credential: CREDENTIAL },
      ],
    })
    const seen: string[] = []
    let failed = false
    try {
      for await (const chunk of adapter.stream({
        model: 'deepseek-v4-pro-external',
        messages: [{ role: 'user', content: 'hi' }],
      } as never)) {
        if (chunk.type === 'text-delta') seen.push(chunk.text)
      }
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    // 只跑过一个槽：换号重放会让「前半段」在第二个账号上再出现一遍。
    expect(calls).toEqual(['a1'])
    expect(seen.join('')).toBe('前半段')
  })

  /**
   * ⚠️ 2026-11-10 对抗性审计 I7：槽位耗尽的终态码**零断言**（改成 `'SERVER'`
   * 仍全绿）。它必须是额度码，宿主才会给「额度已用尽」而不是「服务器错误」。
   */
  it('★★ 所有槽位都限流 ⇒ 终态码是 QUOTA_EXCEEDED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limit exceeded', {
        status: 429,
        headers: { 'content-type': 'text/plain', 'retry-after': '1' },
      })),
    )
    let code: string | undefined
    try {
      await collect(makeAdapter({
        slots: [
          { id: 'marvis-a1', credential: CREDENTIAL },
          { id: 'marvis-a2', credential: CREDENTIAL },
        ],
        markLimited: () => undefined,
      }))
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe('QUOTA_EXCEEDED')
  })

  it('★ 取消 ⇒ 原样抛出，不换号', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => {
      controller.abort()
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    })
    vi.stubGlobal('fetch', fetchMock)
    let code: string | undefined
    try {
      for await (const _ of makeAdapter({
        slots: [
          { id: 'marvis-a1', credential: CREDENTIAL },
          { id: 'marvis-a2', credential: CREDENTIAL },
        ],
      }).stream({
        model: 'deepseek-v4-pro-external',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      } as never)) {
        /* 不应产出 */
      }
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(code).not.toBe('QUOTA_EXCEEDED')
  })
})

describe('★ 额度冷却到次日 UTC+8 零点（不是 +24h）', () => {
  it('★ quota 的冷却终点 = 次日 00:00（UTC+8）', () => {
    // 2026-11-09 23:50 +08:00
    const now = Date.UTC(2026, 10, 9, 15, 50)
    expect(marvisRetryAfterMs('quota', undefined, 1, now)).toBe(10 * 60_000)
  })

  it('★ 服务端给了 retry-after 就优先用它', () => {
    expect(marvisRetryAfterMs('rate_limit', 5_000, 3)).toBe(5_000)
  })
})

/**
 * ★★★ IKVL6C 的**接线层**守卫：判据必须打在 wire 上，不能只打在纯函数上。
 *
 * 背景：`tests/unit/marvis-messages.spec.ts` 那 12 条只证明 `buildMarvisPayload`
 * 的形状正确；而 2026-11-16 的双审计实测（变异 M15）证明 —— **把
 * `src/marvis-adapter.ts` 里 `streamVia` 传给 `buildMarvisPayload` 的 `tools`
 * 那一行摘掉，42 条全绿**。也就是说纯函数那一层守不住「adapter 到底有没有把
 * `options.tools` 交下去」。
 *
 * 这两条把判据搬到 `fetch` 的请求体上：读真实发出的 body，断言 `tools` 键在/不在。
 *
 * ⚠️ **更正（2026-11-16 对抗审计 A4，我原先把这里有写错）**：原文写「摘掉 adapter 的
 * 传参 ⇒ **第一条**红」是**假的**。实测摘掉 `src/marvis-adapter.ts` 的
 * `tools: options.tools,` 只让**第二条**（有工具那一轮）红 —— 第一条
 * （`bodyOf({})` / `bodyOf({tools: []})`）**全绿**，因为「不传」与「传了但为空」
 * 在 wire 上都等于「没有 `tools` 键」。
 * ⇒ **第一条对这个 adapter 缺陷零判别力**，它守的是 payload 层的门控；
 * 第二条才是 adapter 传参的守卫。两条各守一层，别指望任一条单独够用。
 */
describe('★★★ 工具键的接线层守卫（IKVL6C：判据必须打在 wire 上）', () => {
  // ⚠️ 必须自己收 stub（对抗审计 A7）：`vitest.config.ts` 没开
  // `unstubGlobals: true`、`tests/setup-isolation.ts` 也没做，而本 describe 用
  // `vi.stubGlobal('fetch', …)` ⇒ 不清理就会把 stub 漏给后续 describe
  // （当前它是文件最后一个，暂不咬人；追加用例即污染）。
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function bodyOf(options: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(sseBody('ok'), {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    for await (const _chunk of makeAdapter().stream({
      model: 'deepseek-v4-pro-external',
      messages: [{ role: 'user', content: 'hi' }],
      ...options,
    } as never)) {
      // drain
    }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    return JSON.parse(init.body as string) as Record<string, unknown>
  }

  // ⚠️ 这一条是**整链**守卫（options → adapter → buildMarvisPayload → wire），
  //    不是 adapter 层守卫：`tools` 的空值门控只在 `buildMarvisPayload` 一处，
  //    adapter 只做原样透传 ⇒ 本用例对 adapter 层零判别力（正向审计 P2-2）。
  //    它仍然承重：adapter 那条 `tools: options.tools` 若被删掉，
  //    「有工具时必须带」那条会红。
  it('★★★ 没有工具的那一轮，wire 上必须**没有** `tools` 键（整链守卫）', async () => {
    const body = await bodyOf({})
    expect(Object.hasOwn(body, 'tools')).toBe(false)
    // 再核一遍「空数组」那一格：显式传 [] 也必须等价于「不带」。
    const bodyEmpty = await bodyOf({ tools: [] })
    expect(Object.hasOwn(bodyEmpty, 'tools')).toBe(false)
  })

  it('★★★ 有工具的那一轮，wire 上必须带 `tools`，且外层是 `type/function` 包装', async () => {
    const body = await bodyOf({
      tools: [{ name: 'read_file', description: '读一个文件', parameters: { type: 'object' } }],
    })
    expect(Array.isArray(body.tools)).toBe(true)
    const first = (body.tools as unknown[])[0] as { type?: unknown; function?: { name?: unknown } }
    expect(first.type).toBe('function')
    expect(first.function?.name).toBe('read_file')
  })
})
