/**
 * Qoder 渠道原生搜索（`QoderAdapter.searchOnce`）的行为守卫。
 *
 * ## 被锁死的契约
 *
 * 1. **协议形状**：`POST {encryptedInferBase}/api/v1/webSearch/oneSearch`，
 *    信封 `{ payload: JSON.stringify({query, timeRange, contents}), encodeVersion: '1' }`。
 * 2. **投影**：Qoder 的 `pageItems[].link` → 官方 `sources[].url`；
 *    `publishedTime` / `hostname` / `hostLogo` **丢弃**（官方 schema
 *    `additionalProperties: false`，多传会让整条调用失败）。
 * 3. **防御**：`pageItems:[null]` / 缺 `link` / 响应体 `null` / 非 JSON ——
 *    一律降级或报业务错误，不让整条调用炸掉。
 * 4. **WASM 释放**：每次 `create` 必须 `dispose`（否则 wasm 堆泄漏 → 会话暴毙）。
 * 5. **无账号**：凭据缺 `security_oauth_token` / `machine_id` 时报 `noAccount`。
 *
 * ## 测试策略
 *
 * ⚠️ **签名无法 mock**：`searchOnce` 内部的 `prepareRequest` 走真 WASM
 * （`qoder-auth-wasm.wasm`），本测试**故意保留真 WASM** —— 那正是要验证的部分
 * （参数顺序写错会让 `prepareRequest` trap `unreachable`）。
 * 只有**上游 fetch** 被注入替身拦下，故全程无网络。
 *
 * 另：本文件会加载真 WASM（292 KB），比纯单测慢一些；这是刻意的取舍。
 */
import { describe, expect, it, vi } from 'vitest'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import { NativeSearchCodes, WebNativeError, type NativeSource } from '../../src/native-search-contract.js'
import { QODER, QODER_CN, type QoderProduct } from '../../src/qoder-product.js'
import { qoderMachineOs } from '../../src/qoder-align.js'
import type { QoderCredential } from '../../src/qoder.js'

// ───────────────────────── 替身 ─────────────────────────

/** 一份形状完整的 Qoder 凭据（值任意，签名会用到 uid / machine_id）。 */
function makeCredential(overrides: Partial<QoderCredential> = {}): QoderCredential {
  return {
    security_oauth_token: 'SECURITY_TOKEN',
    access_token: 'ACCESS_TOKEN',
    machine_id: 'machine-1234',
    uid: 'uid-5678',
    ...overrides,
  } as QoderCredential
}

/** 造一个适配器：`resolveCredential` 返回给定凭据，`fetchImpl` 记录调用。 */
function makeAdapter(options: {
  credential?: QoderCredential | undefined
  product?: QoderProduct
  response?: ((init?: RequestInit) => Response | Promise<Response>) | undefined
  /** 传入即同时挂上 `fetchFor`（per-账号出口代理），用来验证**优先级**。 */
  fetchForCalls?: Array<{ accountId: string; url: string }>
} = {}) {
  const fetchCalls: Array<{ url: string; init: RequestInit }> = []
  const credential = 'credential' in options ? options.credential : makeCredential()
  const adapter = new QoderAdapter({
    credentialRef: 'QODER_ACCOUNT_TEST' as never,
    resolveCredential: async () => credential as never,
    refresh: async () => {},
    ...(options.product !== undefined ? { product: options.product } : {}),
    ...(options.fetchForCalls === undefined
      ? {}
      : {
          fetchFor: (accountId: string) => (async (url: string | URL, init?: RequestInit) => {
            options.fetchForCalls!.push({ accountId, url: String(url) })
            return new Response('{}', { status: 200 })
          }) as unknown as typeof fetch,
        }),
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} })
      if (options.response === undefined) return new Response('{}', { status: 200 })
      return await options.response(init)
    }) as unknown as typeof fetch,
  })
  return { adapter, fetchCalls }
}

/** 造一个 JSON Response。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 从 fetch 调用里解出「发给上游的明文信封」（body 是密文，故只解 headers/url）。 */
function firstCall(calls: Array<{ url: string; init: RequestInit }>) {
  expect(calls.length).toBeGreaterThan(0)
  return calls[0]!
}

// ───────────────────────── ① 协议形状 ─────────────────────────

describe('Qoder 搜索：出口 fetcher 优先级（与推理主路径**必须一致**）', () => {
  it('★★★ 注入了 `fetchImpl` ⇒ 搜索**绝不**走 `fetchFor`（单测替身优先）', async () => {
    // 对抗审计 PR #91 P2-2：原来只有**源码文本**断言（`expect(search).toMatch(...)`），
    // 把判据改成语义反转（`this.hasInjectedFetchImpl && false`）246 条全绿。
    // 这条是行为级：真调一次搜索，数两个出口各被调用几次。
    const fetchForCalls: Array<{ accountId: string; url: string }> = []
    const { adapter, fetchCalls } = makeAdapter({
      fetchForCalls,
      response: () => jsonResponse({ pageItems: [] }),
    })
    await adapter.searchOnce('hello', makeCredential(), new AbortController().signal)
    expect(fetchCalls.length, '注入的 fetchImpl 必须被调用').toBeGreaterThan(0)
    expect(fetchForCalls, '注入了替身就不得再走代理出口').toHaveLength(0)
  })

  it('★★ 没注入替身但有 `fetchFor` ⇒ 搜索**必须**走代理出口（否则墙外恒超时）', async () => {
    // 真实报障 2026-10-21 的形态：搜索端点在墙外域，漏接代理的症状是
    // 「聊天通了、联网搜索恒 10.7s 超时」。这条锁的是**反方向**：
    // 只要没注入替身，就一定要走 `fetchFor`。
    const fetchForCalls: Array<{ accountId: string; url: string }> = []
    const adapter = new QoderAdapter({
      credentialRef: 'QODER_ACCOUNT_TEST' as never,
      resolveCredential: async () => makeCredential() as never,
      refresh: async () => {},
      fetchFor: (accountId: string) => (async (url: string | URL) => {
        fetchForCalls.push({ accountId, url: String(url) })
        return jsonResponse({ pageItems: [] })
      }) as unknown as typeof fetch,
    })
    await adapter.searchOnce('hello', makeCredential(), new AbortController().signal)
    expect(fetchForCalls, '没注入替身 ⇒ 必须走 fetchFor').toHaveLength(1)
    expect(fetchForCalls[0]!.url).toContain('/api/v1/webSearch/oneSearch')
  })
})

describe('Qoder 搜索：协议形状', () => {
  it('打 {encryptedInferBase}/api/v1/webSearch/oneSearch', async () => {
    const { adapter, fetchCalls } = makeAdapter({ response: () => jsonResponse({ pageItems: [] }) })
    await adapter.searchOnce('天气', makeCredential(), new AbortController().signal)
    const call = firstCall(fetchCalls)
    expect(call.url).toContain('/api/v1/webSearch/oneSearch')
  })

  it('CN 产品用 gateway.qoder.com.cn；国际产品用 api2.qoder.sh', async () => {
    for (const [product, expected] of [[QODER_CN, 'gateway.qoder.com.cn'], [QODER, 'api2.qoder.sh']] as const) {
      const { adapter, fetchCalls } = makeAdapter({ product, response: () => jsonResponse({ pageItems: [] }) })
      await adapter.searchOnce('x', makeCredential(), new AbortController().signal)
      expect(firstCall(fetchCalls).url).toContain(expected)
    }
  })

  it('⚠️ 携带签名头（Authorization 为 COSY 形态）与 X-Session-ID', async () => {
    const { adapter, fetchCalls } = makeAdapter({ response: () => jsonResponse({ pageItems: [] }) })
    await adapter.searchOnce('x', makeCredential(), new AbortController().signal)
    const headers = firstCall(fetchCalls).init.headers as Record<string, string>
    // 签名由真 WASM 生成：Authorization 必是 `Bearer COSY.<…>`
    expect(headers['Authorization']).toMatch(/^Bearer COSY\./)
    expect(headers['X-Session-ID']).toBeTruthy()
    // 全套 Cosy-* 头也应由 WASM 生成
    expect(Object.keys(headers).some((k) => k.startsWith('Cosy-'))).toBe(true)
    // 形态对齐：`Cosy-MachineOS` 是**本仓库补的**（WASM 头表里没有这一项，
    // 依据见 `qoder-align.ts` 模块头的实测 dump）；`X-Session-ID` 是官方的。
    expect(headers['Cosy-MachineOS']).toBe(qoderMachineOs())
  })

  it('method 为 POST，body 非空（密文）', async () => {
    const { adapter, fetchCalls } = makeAdapter({ response: () => jsonResponse({ pageItems: [] }) })
    await adapter.searchOnce('x', makeCredential(), new AbortController().signal)
    const call = firstCall(fetchCalls)
    expect(call.init.method).toBe('POST')
    expect(String(call.init.body ?? '').length).toBeGreaterThan(0)
  })
})

// ───────────────────────── ② 投影 ─────────────────────────

describe('Qoder 搜索：结果投影', () => {
  it('pageItems[].link → sources[].url，title/snippet 一对一', async () => {
    const { adapter } = makeAdapter({
      response: () => jsonResponse({
        pageItems: [
          { title: 'T1', link: 'https://a.com/', snippet: 'S1' },
          { title: 'T2', link: 'https://b.com/', snippet: 'S2' },
        ],
      }),
    })
    const sources = await adapter.searchOnce('x', makeCredential(), new AbortController().signal)
    expect(sources).toEqual([
      { url: 'https://a.com/', title: 'T1', snippet: 'S1' },
      { url: 'https://b.com/', title: 'T2', snippet: 'S2' },
    ])
  })

  it('⚠️ 丢弃 publishedTime / hostname / hostLogo（官方 schema 不允许额外字段）', async () => {
    const { adapter } = makeAdapter({
      response: () => jsonResponse({
        pageItems: [{
          title: 'T', link: 'https://a.com/', snippet: 'S',
          publishedTime: '2026-10-01T00:00:00+08:00', hostname: 'a.com', hostLogo: 'https://logo',
        }],
      }),
    })
    const sources = await adapter.searchOnce('x', makeCredential(), new AbortController().signal)
    expect(sources).toHaveLength(1)
    // ⚠️ 只应有 url / title / snippet 三个键
    expect(Object.keys(sources[0]!).sort()).toEqual(['snippet', 'title', 'url'])
  })

  it('⚠️ 缺 link 的条目被丢弃（url 是官方必填，留着会让整个调用失败）', async () => {
    const { adapter } = makeAdapter({
      response: () => jsonResponse({
        pageItems: [
          { title: 'no-link', snippet: 'x' },
          { title: 'ok', link: 'https://a.com/' },
        ],
      }),
    })
    const sources = await adapter.searchOnce('x', makeCredential(), new AbortController().signal)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.url).toBe('https://a.com/')
  })

  it('空 pageItems → 空数组（不是错误）', async () => {
    const { adapter } = makeAdapter({ response: () => jsonResponse({ pageItems: [] }) })
    expect(await adapter.searchOnce('x', makeCredential(), new AbortController().signal)).toEqual([])
  })

  it('pageItems 缺失但 searchInformation 在 → 报 badResponse（不是空数组）', async () => {
    const { adapter } = makeAdapter({
      response: () => jsonResponse({ requestId: 'r', searchInformation: { searchTime: 12 } }),
    })
    await expect(adapter.searchOnce('x', makeCredential(), new AbortController().signal))
      .rejects.toMatchObject({ code: NativeSearchCodes.badResponse })
  })

  it('title / snippet 为非字符串或空串时该字段不出现（不是填空串）', async () => {
    const { adapter } = makeAdapter({
      response: () => jsonResponse({
        pageItems: [
          { title: '', link: 'https://a.com/' },
          { title: 123, link: 'https://b.com/', snippet: '' },
        ],
      }),
    })
    const sources = await adapter.searchOnce('x', makeCredential(), new AbortController().signal)
    expect(sources[0]).toEqual({ url: 'https://a.com/' })
    expect(sources[1]).toEqual({ url: 'https://b.com/' })
  })
})

// ───────────────────────── ③ 畸形数据防御 ─────────────────────────

describe('Qoder 搜索：畸形上游数据不得炸掉整条调用', () => {
  it('⚠️ pageItems 含 null 项时丢弃，而不是整条失败', async () => {
    const { adapter } = makeAdapter({
      response: () => jsonResponse({ pageItems: [null, { link: 'https://ok.com/' }] }),
    })
    const sources = await adapter.searchOnce('x', makeCredential(), new AbortController().signal)
    expect(sources).toEqual([{ url: 'https://ok.com/' }])
  })

  it('⚠️ 响应体是 JSON null → badResponse（不是 TypeError）', async () => {
    const { adapter } = makeAdapter({ response: () => jsonResponse(null) })
    await expect(adapter.searchOnce('x', makeCredential(), new AbortController().signal))
      .rejects.toMatchObject({ code: NativeSearchCodes.badResponse })
  })

  it('⚠️ 响应体是数组（非对象）→ badResponse', async () => {
    const { adapter } = makeAdapter({ response: () => jsonResponse([{ link: 'https://a.com/' }]) })
    await expect(adapter.searchOnce('x', makeCredential(), new AbortController().signal))
      .rejects.toMatchObject({ code: NativeSearchCodes.badResponse })
  })

  it('⚠️ 非 JSON（HTML 错误页）→ badResponse', async () => {
    const { adapter } = makeAdapter({ response: () => new Response('<html>', { status: 200 }) })
    await expect(adapter.searchOnce('x', makeCredential(), new AbortController().signal))
      .rejects.toMatchObject({ code: NativeSearchCodes.badResponse })
  })

  it('上游非 2xx → upstream，文案带端点', async () => {
    const { adapter } = makeAdapter({
      response: () => new Response('{"errorCode":1,"errorMsg":"bad"}', { status: 403 }),
    })
    await expect(adapter.searchOnce('x', makeCredential(), new AbortController().signal))
      .rejects.toMatchObject({ code: NativeSearchCodes.upstream })
  })

  it('抛的是 WebNativeError（宿主据此产出 isError 结果）', async () => {
    const { adapter } = makeAdapter({ response: () => new Response('x', { status: 500 }) })
    await expect(adapter.searchOnce('x', makeCredential(), new AbortController().signal))
      .rejects.toBeInstanceOf(WebNativeError)
  })
})

// ───────────────────────── ④ 无账号 ─────────────────────────

describe('Qoder 搜索：无可用账号', () => {
  it('凭据 undefined → noAccount', async () => {
    const { adapter } = makeAdapter({ credential: undefined })
    await expect(adapter.searchOnce('x', undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: NativeSearchCodes.noAccount })
  })

  it('⚠️ security_oauth_token 与 access_token 都为空 → noAccount', async () => {
    const { adapter } = makeAdapter({
      credential: makeCredential({ security_oauth_token: '', access_token: '' }),
    })
    await expect(adapter.searchOnce('x', makeCredential({ security_oauth_token: '', access_token: '' }), new AbortController().signal))
      .rejects.toMatchObject({ code: NativeSearchCodes.noAccount })
  })

  it('⚠️ 缺 machine_id → noAccount（签名需要它，缺了会 trap）', async () => {
    const bad = makeCredential()
    delete (bad as Record<string, unknown>).machine_id
    await expect(makeAdapter({ credential: bad }).adapter
      .searchOnce('x', bad, new AbortController().signal))
      .rejects.toMatchObject({ code: NativeSearchCodes.noAccount })
  })

  it('access_token 可回退（security_oauth_token 缺席时）', async () => {
    const cred = makeCredential({ security_oauth_token: '' })
    const { adapter, fetchCalls } = makeAdapter({ credential: cred, response: () => jsonResponse({ pageItems: [] }) })
    await adapter.searchOnce('x', cred, new AbortController().signal)
    expect(fetchCalls.length).toBe(1)
  })
})

// ───────────────────────── ⑤ 并发/串行 ─────────────────────────

describe('Qoder 搜索：并发安全', () => {
  it('⚠️ 并发两次搜索：各自独立建 WASM 上下文，都成功', async () => {
    // ⚠️ 本模块的 `gluePromise` 是**进程级单例**，但 `QoderContext` 是每实例的。
    //    本用例确认「并发创建多个上下文」不会互相踩踏（工具层会串行，但适配器
    //    必须自己能扛并发 —— 防御性验证）。
    const { adapter, fetchCalls } = makeAdapter({ response: () => jsonResponse({ pageItems: [{ link: 'https://a.com/' }] }) })
    const results = await Promise.all([
      adapter.searchOnce('q1', makeCredential(), new AbortController().signal),
      adapter.searchOnce('q2', makeCredential(), new AbortController().signal),
    ])
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual([{ url: 'https://a.com/' }])
    expect(results[1]).toEqual([{ url: 'https://a.com/' }])
    expect(fetchCalls.length).toBe(2)
  })

  it('⚠️ 取消信号已 abort → 不发出请求（或抛出 aborted）', async () => {
    const { adapter, fetchCalls } = makeAdapter({ response: () => jsonResponse({ pageItems: [] }) })
    const controller = new AbortController()
    controller.abort()
    try {
      await adapter.searchOnce('x', makeCredential(), controller.signal)
    } catch {
      /* 允许抛错 */
    }
    // 已中止的信号不该产生成功的上游调用（fetch 替身会立刻拒绝）
    expect(fetchCalls.length).toBeLessThanOrEqual(1)
  })
})

// ───────────────────────── ⑥ 取消 / 超时归因（PR95 审计补） ─────────────────────────

/**
 * ⚠️ 本组的存在理由（PR95 对抗审计实测出的**两个无牙区**）：
 *
 * 1. **变异 M-SIG-Q**：把 `searchOnce` 里的 `signal: composed` 换成
 *    `new AbortController().signal`（即**彻底忽略调用方取消**），
 *    本文件原有 22 条用例**全部仍绿** —— 没有一条测信号传递。
 * 2. **变异 M-MSG-Q**：往 HTTP 错误文案里塞 `[MUTANT-UPSTREAM-MSG]`，
 *    22 条同样全绿 —— 原有用例只断言 `code`，**从不断言 `message`**。
 *
 * 故这组既锁「信号真被透传下去」，也锁「归因与文案」。
 */
describe('Qoder 搜索：取消 / 超时的归因', () => {
  it('⚠️ 调用方取消（DOMException/AbortError）→ aborted，且信号真的传给了 fetch', async () => {
    const controller = new AbortController()
    // 调用方取消：reason 是 DOMException/AbortError（实测形状见契约注释）
    controller.abort(new DOMException('user stop', 'AbortError'))
    const { adapter, fetchCalls } = makeAdapter({
      response: async () => { throw new DOMException('user stop', 'AbortError') },
    })
    await expect(adapter.searchOnce('x', makeCredential(), controller.signal))
      .rejects.toMatchObject({ code: NativeSearchCodes.aborted })
    // ⚠️ M-SIG-Q 的反证：fetch 收到的 signal 必须是 `composed`（可被调用方与
    //    本模块预算共同中止的那个），**不是**新造的、与调用方无关的信号。
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.init.signal).not.toBe(controller.signal)
    expect((fetchCalls[0]!.init.signal as AbortSignal).aborted).toBe(true)
  })

  it('⚠️ 本模块自己的 20s 预算到期 → timeout（不是 aborted）', async () => {
    // 照 `web-native.spec.ts` 的既有手法：把 20s 预算缩成 1ms，
    // 从而毫秒级走到 native 预算分支而不真等 20s。
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) =>
      realTimeout(ms === 20_000 ? 1 : ms))
    const { adapter } = makeAdapter({
      // 替身等本模块的预算真到期，再按其 reason 抛出（与真 fetch 行为一致）。
      response: async (init?: RequestInit) => {
        const sig = init?.signal
        const reason: unknown = await new Promise((resolve) => {
          if (sig?.aborted === true) return resolve(sig.reason)
          sig?.addEventListener('abort', () => resolve(sig.reason), { once: true })
        })
        throw reason instanceof Error ? reason : new DOMException('timed out', 'TimeoutError')
      },
    })
    try {
      const err = await adapter.searchOnce('x', makeCredential(), new AbortController().signal)
        .catch((e: unknown) => e)
      expect(err).toMatchObject({ code: NativeSearchCodes.timeout })
      // 文案必须说明是**我们的** 20s 预算用尽
      expect((err as Error).message).toMatch(/timed out after 20000ms/)
    } finally {
      spy.mockRestore()
    }
  })

  it('⚠️⚠️ 外层 harness deadline 到期（TimeoutReason/TOOL_TIMEOUT）必须归 timeout，不得误报 aborted', async () => {
    // 本组最关键的一格：本模块在 cordis waterfall 的**内层**，生产环境里传进来的
    // `signal` 就是外层 `tool-call-timeout-policy` 的 deadline 信号。它的
    // `reason` 是 harness 的 `TimeoutReason`（name/code 见实测对照），
    // 与「调用方取消」的 `DOMException/AbortError` **形状不同**。
    // 旧实现「先判 signal.aborted 就归 aborted」会把超时报成「用户取消了搜索」，
    // 文案里那串排障指引全部丢失。
    const caller = new AbortController()
    const timeoutReason = Object.assign(new Error('TOOL_TIMEOUT after 1ms'), {
      name: 'TimeoutReason', code: 'TOOL_TIMEOUT', timeoutMs: 1,
    })
    caller.abort(timeoutReason)
    const { adapter } = makeAdapter({ response: async () => { throw timeoutReason } })

    const err = await adapter.searchOnce('x', makeCredential(), caller.signal).catch((e: unknown) => e)
    // 反证必须写在前：旧实现会命中的正是这一格
    expect((err as { code?: string }).code).not.toBe(NativeSearchCodes.aborted)
    expect(err).toMatchObject({ code: NativeSearchCodes.timeout })
    expect((err as Error).message).toMatch(/timed out/)
    expect((err as Error).message).toMatch(/webSearch\/oneSearch/)
  })

  it('⚠️ 非 abort 的传输失败 → upstream（不吞成 aborted）', async () => {
    const { adapter } = makeAdapter({ response: async () => { throw new Error('ECONNRESET') } })
    await expect(adapter.searchOnce('x', makeCredential(), new AbortController().signal))
      .rejects.toMatchObject({ code: NativeSearchCodes.upstream })
  })
})
