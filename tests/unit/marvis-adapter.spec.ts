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

async function collect(adapter: MarvisAdapter, model = 'main-auto'): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of adapter.stream({
    model,
    messages: [{ role: 'user', content: 'hi' }],
  } as never)) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
  }
  return chunks.join('')
}

describe('★ 目录：只有 main-auto，且由共享骨架门控', () => {
  it('★ 有账号 ⇒ 一条 main-auto，名字是美化名，声明 1M 上下文与图片能力', async () => {
    const listed = await makeAdapter().listModels(MARVIS.id)
    expect(listed).toHaveLength(1)
    const [entry] = listed as Array<{
      id: string
      name: string
      inputModalities?: readonly string[]
      contextWindow?: number
    }>
    expect(entry.id).toBe('main-auto')
    expect(entry.name).toBe('DeepSeek V4.1 Flash')
    // 宿主 `listModels` 会剥掉 contextWindow，但适配器必须交出去（网关走它）。
    expect(entry.contextWindow).toBe(1_000_000)
    expect(entry.inputModalities).toEqual(['text', 'image'])
    // 刻意不声明档位（思考默认开、关不掉）。
    expect((entry as { reasoning?: unknown }).reasoning).toBeUndefined()
  })

  it('★★ 关闭该模型 ⇒ 从 listModels 消失（黑名单对 Marvis 生效）', async () => {
    const listed = await makeAdapter({ pool: makePool({ disabled: ['main-auto'] }) }).listModels(
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
    expect(all?.map((m) => m.id)).toEqual(['main-auto'])
  })

  it('★ 兜底表只有一条（防止有人顺手加回别的槽位）', () => {
    expect(MARVIS_FALLBACK_MODELS.map((m) => m.id)).toEqual(['main-auto'])
  })
})

describe('★ 模型 id 归一', () => {
  it('★ 数组下标 "0" 与真实模型 id 都归一成槽位 id', async () => {
    const adapter = makeAdapter()
    expect((await adapter.resolveModel(MARVIS.id, '0')).id).toBe('main-auto')
    expect((await adapter.resolveModel(MARVIS.id, 'deepseek-v4-1-flash-261017')).id).toBe(
      'main-auto',
    )
  })

  /**
   * ⚠️ 2026-11-10 对抗性审计 I6：`MAIN-AUTO` 原样透传会目录未命中 ⇒ 静默退化
   * 成「未知模型」（text-only / 无上下文 / 无图片），且**不报错**。
   */
  it('★★ 大小写变体同样归一（否则静默退化成未知模型）', async () => {
    const adapter = makeAdapter()
    const upper = await adapter.resolveModel(MARVIS.id, 'MAIN-AUTO')
    expect(upper.id).toBe('main-auto')
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
    expect(payload.model).toBe('main-auto')
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
    expect(modelId).toBe('main-auto')
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
      protected override async *streamVia(): AsyncIterable<never> {
        calls.push('a1')
        yield { type: 'text-delta', text: '前半段' }
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
        model: 'main-auto',
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
        model: 'main-auto',
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
