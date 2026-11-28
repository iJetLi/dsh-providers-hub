import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { NEVER, UNUSABLE } from '../../src/aggregate-core.js'
import { buildVirtualModels } from '../../src/aggregate-catalog.js'
import { todayExpiry } from '../../src/aggregate-expiry.js'
import { providerOfAccountRef } from '../../src/jet-hub-store.js'
import { TodayAuth } from '../../src/today-auth.js'
import { fetchTodayBalanceDetailed, parseTodayBalanceFromStatus } from '../../src/today-credits.js'
import { TODAY, TODAY_INTL, type TodayProduct } from '../../src/today-product.js'
import {
  TodayUpstreamError,
  authenticateTodayCookie,
  clearTodayRuntimeCaches,
  diagnoseTodayCookieFailure,
  ensureTodayModelOption,
  exchangeTodayJwt,
  extractTodayCookiesFromHeaders,
  fetchTodayPricingStatus,
  normalizeTodayCookieInput,
  parseTodayCredential,
  parseTodayModelsFromPricingStatus,
  pollTodayReply,
  sendTodayMessage,
} from '../../src/today.js'
import {
  TodayAdapter,
  buildTodayPrompt,
  selectUsableTodaySlots,
} from '../../src/today-adapter.js'
import { handleTodayRpc, todaySlotNamesOf } from '../../src/today-rpc.js'

afterEach(() => {
  clearTodayRuntimeCaches()
  vi.useRealTimers()
})

function okJson(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function makeCred(tok = 'valid.sig', realm: 'cn' | 'global' = 'cn') {
  return {
    cookie_raw: `__Secure-better-auth.session_token=${tok}`,
    realm,
  } as const
}

// ── 组 A：Cookie 清洗、解码/编码保真、同名去重、Max-Age=0 与 realm 严格隔离 ──

describe('Today Cookie 清洗、去重与 realm 严格校验', () => {
  it('支持裸值、多前缀头、cURL（含 Windows ^ 换行）、fetch、PS、Tab 行及 4 种 JSON', () => {
    const bare = normalizeTodayCookieInput('abc.def/+=')
    expect(bare.header).toBe('__Secure-better-auth.session_token=abc.def%2F%2B%3D')

    const headerMulti = normalizeTodayCookieInput(
      'Cookie: Set-Cookie: __Secure-better-auth.session_token=h1.sig; Path=/; HttpOnly; SameSite=Lax',
    )
    expect(headerMulti.header).toBe('__Secure-better-auth.session_token=h1.sig')

    const curlWin = normalizeTodayCookieInput(
      `curl ^"https://todayai.cn/api/token^" ^\r\n  -H ^"cookie: __Secure-better-auth.session_token=win.sig=^"`,
    )
    expect(curlWin.realmHint).toBe('cn')
    expect(curlWin.header).toBe('__Secure-better-auth.session_token=win.sig%3D')

    const curlB = normalizeTodayCookieInput(
      `curl 'https://today.ai/api/token' -b '__Secure-better-auth.session_token=intl.sig'`,
    )
    expect(curlB.realmHint).toBe('global')
    expect(curlB.header).toBe('__Secure-better-auth.session_token=intl.sig')

    const fetchSnippet = normalizeTodayCookieInput(
      `fetch("https://today.ai/api/token", {"headers": {"cookie": "__Secure-better-auth.session_token=f1.sig"}})`,
    )
    expect(fetchSnippet.header).toBe('__Secure-better-auth.session_token=f1.sig')

    const psSnippet = normalizeTodayCookieInput(
      `$session.Cookies.Add((New-Object System.Net.Cookie("__Secure-better-auth.session_token", "ps.sig", "/", "todayai.cn")))`,
    )
    expect(psSnippet.header).toBe('__Secure-better-auth.session_token=ps.sig')

    const tabRows = normalizeTodayCookieInput(
      'Name\tValue\tDomain\n__Secure-better-auth.session_token\ttab.sig\t.todayai.cn',
    )
    expect(tabRows.realmHint).toBe('cn')
    expect(tabRows.header).toBe('__Secure-better-auth.session_token=tab.sig')

    const jsonArr = normalizeTodayCookieInput(JSON.stringify([
      { domain: '.today.ai', name: '__Secure-better-auth.session_token', value: 'intl.tok=' },
    ]))
    expect(jsonArr.realmHint).toBe('global')
    expect(jsonArr.header).toBe('__Secure-better-auth.session_token=intl.tok%3D')

    const jsonSessObj = normalizeTodayCookieInput(JSON.stringify({
      domain: 'todayai.cn',
      session: { token: 'nested.tok' },
    }))
    expect(jsonSessObj.realmHint).toBe('cn')
    expect(jsonSessObj.header).toBe('__Secure-better-auth.session_token=nested.tok')
  })

  it('编码 + / = 保真且二次归一化保持严格幂等', () => {
    const first = normalizeTodayCookieInput('tok+a/b==')
    expect(first.header).toBe('__Secure-better-auth.session_token=tok%2Ba%2Fb%3D%3D')
    const second = normalizeTodayCookieInput(first.header)
    expect(second.header).toBe(first.header)
  })

  it('分号多段同名 Cookie 后者覆盖前者，不保留过期同名值', () => {
    const out = normalizeTodayCookieInput(
      '__Secure-better-auth.session_token=stale.sig; other=1; __Secure-better-auth.session_token=fresh.sig',
    )
    expect(out.header).toBe('__Secure-better-auth.session_token=fresh.sig; other=1')
  })

  it('extractTodayCookiesFromHeaders 忽略 Max-Age<=0、无关 Cookie，并对同名 Set-Cookie 去重', () => {
    const h = new Headers()
    h.append('set-cookie', '__Secure-better-auth.session_token=cleared.sig; Max-Age=0; Path=/')
    h.append('set-cookie', '__Secure-better-auth.session_data=neg.sig; Max-Age=-1; Path=/')
    h.append('set-cookie', 'theme=dark; Path=/')
    h.append('set-cookie', '__Secure-better-auth.session_token=first.sig; Path=/; HttpOnly')
    h.append('set-cookie', '__Secure-better-auth.session_token=latest.sig=; Path=/; HttpOnly')

    expect(extractTodayCookiesFromHeaders(h)).toBe('__Secure-better-auth.session_token=latest.sig%3D')
  })

  it('parseTodayCredential 按 realm / realmHint / expectedRealm / global 正确兜底，且拦截跨站错配', () => {
    // 显式匹配
    expect(parseTodayCredential(JSON.stringify(makeCred('a.b', 'cn')), 'cn')?.realm).toBe('cn')
    // 跨站显式 realm 不匹配 -> 拒绝
    expect(parseTodayCredential(JSON.stringify(makeCred('a.b', 'global')), 'cn')).toBeUndefined()
    // 缺 realm 但带跨站 URL 提示 -> 拒绝
    expect(parseTodayCredential(JSON.stringify({ cookie_raw: 'curl https://today.ai -b a.b' }), 'cn')).toBeUndefined()
    // 无显式 realm 与 hint 时兜底到 expectedRealm
    expect(parseTodayCredential(JSON.stringify({ cookie_raw: 'a.b' }), 'cn')?.realm).toBe('cn')
    // 连 expectedRealm 也无时兜底到 global
    expect(parseTodayCredential(JSON.stringify({ cookie_raw: 'a.b' }))?.realm).toBe('global')
    // 非法 realm / 坏 JSON -> undefined
    expect(parseTodayCredential(JSON.stringify({ cookie_raw: 'a.b', realm: 'eu' }), 'cn')).toBeUndefined()
    expect(parseTodayCredential('{bad-json')).toBeUndefined()
  })

  it('诊断缺失/缺签名/过期 Cookie', () => {
    expect(diagnoseTodayCookieFailure('foo=bar')).toContain('未在粘贴内容中找到')
    expect(diagnoseTodayCookieFailure('__Secure-better-auth.session_token=nosig')).toContain('缺少签名段')
    expect(diagnoseTodayCookieFailure('__Secure-better-auth.session_token=tok.sig')).toContain('已被上游拒绝')
  })
})

// ── 组 B：JWT 缓存、临期刷新、401 自愈与模型选择 TTL ──

describe('Today JWT 缓存、401 自愈与模型选择 TTL', () => {
  it('JWT 在有效期内复用缓存；expiresIn<60s 提前重换；两站缓存相互隔离；401 清缓存', async () => {
    let tokenCalls = 0
    const fetcher: typeof fetch = vi.fn(async (input) => {
      const u = String(input)
      if (u === `${TODAY.appBase}/api/token`) {
        tokenCalls++
        return okJson({ token: `jwt-cn-${tokenCalls}`, expiresIn: tokenCalls === 1 ? 3600 : 30 })
      }
      if (u === `${TODAY_INTL.appBase}/api/token`) {
        tokenCalls++
        return okJson({ token: `jwt-intl-${tokenCalls}`, expiresIn: 30 })
      }
      return new Response('not found', { status: 404 })
    })

    const cnCred = makeCred('same.sig', 'cn')
    const intlCred = makeCred('same.sig', 'global')
    expect(await exchangeTodayJwt(cnCred, TODAY, { fetcher })).toBe('jwt-cn-1')
    expect(await exchangeTodayJwt(cnCred, TODAY, { fetcher })).toBe('jwt-cn-1')
    expect(tokenCalls).toBe(1)

    // 同指纹切换成国际站不得命中 cn 缓存；且 expiresIn=30 < 60s 提前量，每次都会重换
    expect(await exchangeTodayJwt(intlCred, TODAY_INTL, { fetcher })).toBe('jwt-intl-2')
    expect(await exchangeTodayJwt(intlCred, TODAY_INTL, { fetcher })).toBe('jwt-intl-3')
    expect(tokenCalls).toBe(3)
  })

  it('业务接口首次返回 401 时强制刷新一次 JWT 并重试成功；连败则只重试一次后抛出', async () => {
    let tokenCount = 0
    let statusCalls = 0
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      const u = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (u === `${TODAY.appBase}/api/token`) {
        tokenCount++
        return okJson({ token: `jwt-${tokenCount}`, expiresIn: 3600 })
      }
      if (u === `${TODAY.apiBase}/v1/pricing/status`) {
        statusCalls++
        if (headers.Authorization === 'Bearer jwt-1') {
          return new Response('expired jwt', { status: 401 })
        }
        return okJson({ data: { status: { usage: { progress: 10 } } } })
      }
      return new Response('not found', { status: 404 })
    })

    const cred = makeCred('u401.sig', 'cn')
    const statusObj = await fetchTodayPricingStatus(cred, TODAY, { fetcher })
    expect(tokenCount).toBe(2)
    expect(statusCalls).toBe(2)
    expect((statusObj.usage as { progress: number }).progress).toBe(10)

    // 永远 401 时仅触发一次强制刷新，不陷入无限递归
    clearTodayRuntimeCaches()
    let foreverStatusCalls = 0
    const always401Fetch: typeof fetch = vi.fn(async (input) => {
      if (String(input).endsWith('/api/token')) return okJson({ token: 'bad-jwt', expiresIn: 3600 })
      foreverStatusCalls++
      return new Response('still 401', { status: 401 })
    })
    await expect(fetchTodayPricingStatus(cred, TODAY, { fetcher: always401Fetch })).rejects.toThrow(/401/)
    expect(foreverStatusCalls).toBe(2)
  })

  it('ensureTodayModelOption 跳过已选中模型、遵守 10 分钟 TTL 并在 401/429 时直接上抛', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-28T00:00:00Z'))

    let statusReads = 0
    let putCalls = 0
    let selected = 'model.glm-5.3'
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      const u = String(input)
      if (u.endsWith('/api/token')) return okJson({ token: 'jwt-m', expiresIn: 7200 })
      if (u.endsWith('/v1/pricing/status')) {
        statusReads++
        return okJson({ data: { status: { modelOptions: { selectedOptionId: selected } } } })
      }
      if (u.endsWith('/v1/pricing/model-option')) {
        putCalls++
        selected = JSON.parse(String(init?.body ?? '{}')).optionId
        return new Response(null, { status: 204 })
      }
      return new Response('not found', { status: 404 })
    })

    const cred = makeCred('mopt.sig', 'cn')
    // 1. 已选中目标模型 -> 只读不 PUT，且写入 TTL 缓存
    await ensureTodayModelOption(cred, TODAY, 'model.glm-5.3', { fetcher })
    expect(statusReads).toBe(1)
    expect(putCalls).toBe(0)

    // 2. TTL 内同一模型 -> 0 网络请求
    await ensureTodayModelOption(cred, TODAY, 'model.glm-5.3', { fetcher })
    expect(statusReads).toBe(1)
    expect(putCalls).toBe(0)

    // 3. 切换新模型 -> 发 PUT 更新选中
    await ensureTodayModelOption(cred, TODAY, 'model.deepseek-v4.1-flash', { fetcher })
    expect(putCalls).toBe(1)

    // 4. 推进超过 10 分钟 -> 缓存过期，重新查一次状态
    vi.advanceTimersByTime(10 * 60_000 + 1)
    await ensureTodayModelOption(cred, TODAY, 'model.deepseek-v4.1-flash', { fetcher })
    expect(statusReads).toBe(3)
    expect(putCalls).toBe(1)

    // 5. pricing/status 返回 429 时不吞错（留给外层冷却换号）
    clearTodayRuntimeCaches()
    const rateLimitedFetch: typeof fetch = vi.fn(async (input) => {
      if (String(input).endsWith('/api/token')) return okJson({ token: 'jwt-rl', expiresIn: 3600 })
      return new Response('too many', { status: 429 })
    })
    await expect(
      ensureTodayModelOption(cred, TODAY, 'model.glm-5.3', { fetcher: rateLimitedFetch }),
    ).rejects.toMatchObject({ status: 429 })
  })
})

// ── 组 C：目录解析（disabled / 去重 / 不编造窗口）与 accountPool 过滤 ──

describe('Today 模型目录解析与有池过滤', () => {
  it('剔除 disabled 模型、去重重复项，且未知模型不虚构 contextWindow / maxTokens', () => {
    const parsed = parseTodayModelsFromPricingStatus({
      modelOptions: {
        options: [
          { id: 'model.disabled-one', disabled: true, display: { title: 'Disabled' } },
          { id: 'model.glm-5.3', display: { title: 'GLM 5.3 官方标题' } },
          { id: 'model.glm-5.3', display: { title: 'GLM 5.3 重复项' } },
          { id: 'model.custom-beta', display: { title: 'Custom Beta' } },
        ],
      },
    })
    expect(parsed).toEqual([
      {
        optionId: 'model.glm-5.3',
        id: 'glm-5.3',
        name: 'GLM 5.3 官方标题',
        contextWindow: 131_072,
        maxTokens: 8_192,
      },
      {
        optionId: 'model.custom-beta',
        id: 'custom-beta',
        name: 'Custom Beta',
        contextWindow: undefined,
        maxTokens: undefined,
      },
    ])
  })

  it('带 accountPool 时 listModels 隐藏禁用模型，listAllModels 保留并可用于重新打开', async () => {
    const adapter = new TodayAdapter({
      product: TODAY,
      slots: async () => [{ accountId: 'acc1', credential: makeCred('cat.sig', 'cn') }],
      accountPool: {
        disabledModelsFor: () => new Set(['glm-5.3']),
        providerClosedFor: () => false,
      } as never,
      fetchImpl: async (input) => {
        if (String(input).endsWith('/api/token')) return okJson({ token: 'jwt-cat', expiresIn: 3600 })
        return okJson({
          data: {
            status: {
              modelOptions: {
                options: [
                  { id: 'model.deepseek-v4.1-flash', display: { title: 'DeepSeek V4.1 Flash' } },
                  { id: 'model.glm-5.3', display: { title: 'GLM 5.3' } },
                  { id: 'model.disabled-m', disabled: true, display: { title: '已下线' } },
                ],
              },
            },
          },
        })
      },
    })

    const listed = await adapter.listModels('today')
    expect(listed.map((m) => m.id)).toEqual(['deepseek-v4.1-flash'])
    expect(adapter.listAllModels().map((m) => m.id)).toEqual(['deepseek-v4.1-flash', 'glm-5.3'])

    const unknownResolved = await adapter.resolveModel('today', 'unknown-custom-2026')
    expect(unknownResolved.context).toBeUndefined()
    expect(unknownResolved.defaultMaxTokens).toBeUndefined()
  })
})

// ── 组 D：轮询游标、消息 ID 锁定、非前缀改写防护、空完成与超时不烧池 ──

describe('Today 轮询游标状态机、改写防护、空完成与超时不烧池', () => {
  it('按排除集与 messageId 锁定本轮回复，忽略同 thread 旧消息、混入的无关消息及乱序短快照', async () => {
    let pollStep = 0
    const deltas: string[] = []
    const fetcher: typeof fetch = vi.fn(async (input) => {
      if (String(input).endsWith('/api/token')) return okJson({ token: 'jwt-p', expiresIn: 3600 })
      pollStep++
      const itemsByStep: Record<number, unknown[]> = {
        1: [
          // 第 1 轮旧已完成消息，必须在 excludeAssistantIds 里被跳过
          { id: 'm-old', threadId: 'th-1', role: 'assistant', state: 'completed', isFinal: true, body: { parts: [{ messageType: 'text', content: { text: '旧回复' } }] } },
          // 本轮消息开始输出
          { id: 'm-new', threadId: 'th-1', role: 'assistant', state: 'pending', isFinal: false, body: { parts: [{ messageType: 'text', content: { text: 'Hello ' } }] } },
        ],
        2: [
          // 即使中途突然插进来一条其它未排除 messageId 的消息，lockedMessageId=m-new 也不会跳读
          { id: 'm-intruder', threadId: 'th-1', role: 'assistant', state: 'completed', isFinal: true, body: { parts: [{ messageType: 'text', content: { text: '无关消息' } }] } },
          // 乱序到达的旧短快照，不得重复推送
          { id: 'm-new', threadId: 'th-1', role: 'assistant', state: 'pending', isFinal: false, body: { parts: [{ messageType: 'text', content: { text: 'Hel' } }] } },
        ],
        3: [
          { id: 'm-new', threadId: 'th-1', role: 'assistant', state: 'completed', isFinal: true, body: { parts: [{ messageType: 'text', content: { text: 'Hello World' } }] } },
        ],
      }
      return okJson({ data: { items: itemsByStep[pollStep] ?? [] } })
    })

    const res = await pollTodayReply(makeCred('p1.sig', 'cn'), TODAY, 'th-1', {
      fetcher,
      initialIntervalMs: 1,
      maxIntervalMs: 1,
      excludeAssistantIds: new Set(['m-old']),
      onDelta: (d) => deltas.push(d),
    })

    expect(deltas).toEqual(['Hello ', 'World'])
    expect(res).toEqual({ text: 'Hello World', messageId: 'm-new', rewritten: false })
  })

  it('非前缀改写（abcde -> 12345z）停止切片拼尾（不产出 abcdez），block-end 给出权威全文 12345z', async () => {
    let pollStep = 0
    const adapter = new TodayAdapter({
      product: TODAY,
      slots: async () => [{ accountId: 'acc1', credential: makeCred('rw.sig', 'cn') }],
      fetchImpl: async (input) => {
        const u = String(input)
        if (u.endsWith('/api/token')) return okJson({ token: 'jwt-rw', expiresIn: 3600 })
        if (u.endsWith('/v1/pricing/status')) {
          return okJson({ data: { status: { modelOptions: { selectedOptionId: 'model.deepseek-v4.1-flash' } } } })
        }
        if (u.endsWith('/v1/messages')) return okJson({ threadId: 'th-rw', messageId: 'u-1' }, 202)
        if (u.includes('/v1/conversations/messages')) {
          pollStep++
          const items = pollStep === 1
            ? [{ id: 'a-rw', threadId: 'th-rw', role: 'assistant', state: 'pending', isFinal: false, body: { parts: [{ messageType: 'text', content: { text: 'abcde' } }] } }]
            : [{ id: 'a-rw', threadId: 'th-rw', role: 'assistant', state: 'completed', isFinal: true, body: { parts: [{ messageType: 'text', content: { text: '12345z' } }] } }]
          return okJson({ data: { items } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    const deltas: string[] = []
    let endText = ''
    for await (const chunk of adapter.stream({
      provider: 'today',
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      if (chunk.type === 'text-delta') deltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'text') endText = chunk.block.text
    }

    expect(deltas.join('')).toBe('abcde')
    expect(deltas.join('')).not.toContain('z')
    expect(endText).toBe('12345z')
  })

  it('空完成（completed + text=""）立刻结束且绝不回退 504、绝不烧第二个账号', async () => {
    const sentTokens: string[] = []
    const adapter = new TodayAdapter({
      product: TODAY,
      slots: async () => [
        { accountId: 'acc1', credential: makeCred('empty1.sig', 'cn') },
        { accountId: 'acc2', credential: makeCred('empty2.sig', 'cn') },
      ],
      fetchImpl: async (input, init) => {
        const u = String(input)
        const headers = (init?.headers ?? {}) as Record<string, string>
        if (u.endsWith('/api/token')) {
          const ck = headers.Cookie ?? ''
          return okJson({ token: ck.includes('empty1') ? 'jwt-e1' : 'jwt-e2', expiresIn: 3600 })
        }
        if (u.endsWith('/v1/pricing/status')) {
          return okJson({ data: { status: { modelOptions: { selectedOptionId: 'model.deepseek-v4.1-flash' } } } })
        }
        if (u.endsWith('/v1/messages')) {
          sentTokens.push(headers.Authorization ?? '')
          return okJson({ threadId: 'th-empty', messageId: 'u-e' }, 202)
        }
        if (u.includes('/v1/conversations/messages')) {
          return okJson({
            data: {
              items: [{
                id: 'a-empty',
                threadId: 'th-empty',
                role: 'assistant',
                state: 'completed',
                isFinal: true,
                body: { parts: [] },
              }],
            },
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    const finishReasons: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'today',
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      if (chunk.type === 'finish') finishReasons.push(chunk.reason)
    }

    expect(sentTokens).toEqual(['Bearer jwt-e1'])
    expect(finishReasons).toHaveLength(1)
  })

  it('失败态（state=failed）和轮询真超时（504）立即终止，绝不换下一个账号烧池', async () => {
    // 1. state=failed
    const failedTokens: string[] = []
    const failedAdapter = new TodayAdapter({
      product: TODAY,
      slots: async () => [
        { accountId: 'acc1', credential: makeCred('f1.sig', 'cn') },
        { accountId: 'acc2', credential: makeCred('f2.sig', 'cn') },
      ],
      fetchImpl: async (input, init) => {
        const u = String(input)
        const headers = (init?.headers ?? {}) as Record<string, string>
        if (u.endsWith('/api/token')) {
          return okJson({ token: (headers.Cookie ?? '').includes('f1') ? 'jwt-f1' : 'jwt-f2', expiresIn: 3600 })
        }
        if (u.endsWith('/v1/pricing/status')) {
          return okJson({ data: { status: { modelOptions: { selectedOptionId: 'model.deepseek-v4.1-flash' } } } })
        }
        if (u.endsWith('/v1/messages')) {
          failedTokens.push(headers.Authorization ?? '')
          return okJson({ threadId: 'th-fail', messageId: 'u-f' }, 202)
        }
        if (u.includes('/v1/conversations/messages')) {
          return okJson({ data: { items: [{ id: 'a-f', threadId: 'th-fail', role: 'assistant', state: 'failed', isFinal: false, body: { parts: [] } }] } })
        }
        return new Response('not found', { status: 404 })
      },
    })
    await expect(async () => {
      for await (const _ of failedAdapter.stream({
        provider: 'today',
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) { /* consume */ }
    }).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(failedTokens).toEqual(['Bearer jwt-f1'])

    // 2. 504 轮询超时不换号
    clearTodayRuntimeCaches()
    const fastTimeoutProduct: TodayProduct = {
      ...TODAY,
      fetchTimeoutMs: 5,
      initialPollIntervalMs: 2,
      maxPollIntervalMs: 2,
    }
    const timeoutTokens: string[] = []
    const timeoutAdapter = new TodayAdapter({
      product: fastTimeoutProduct,
      slots: async () => [
        { accountId: 'acc1', credential: makeCred('t1.sig', 'cn') },
        { accountId: 'acc2', credential: makeCred('t2.sig', 'cn') },
      ],
      fetchImpl: async (input, init) => {
        const u = String(input)
        const headers = (init?.headers ?? {}) as Record<string, string>
        if (u.endsWith('/api/token')) {
          return okJson({ token: (headers.Cookie ?? '').includes('t1') ? 'jwt-t1' : 'jwt-t2', expiresIn: 3600 })
        }
        if (u.endsWith('/v1/pricing/status')) {
          return okJson({ data: { status: { modelOptions: { selectedOptionId: 'model.deepseek-v4.1-flash' } } } })
        }
        if (u.endsWith('/v1/messages')) {
          timeoutTokens.push(headers.Authorization ?? '')
          return okJson({ threadId: 'th-to', messageId: 'u-t' }, 202)
        }
        if (u.includes('/v1/conversations/messages')) {
          return okJson({ data: { items: [] } })
        }
        return new Response('not found', { status: 404 })
      },
    })
    await expect(async () => {
      for await (const _ of timeoutAdapter.stream({
        provider: 'today',
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) { /* consume */ }
    }).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(timeoutTokens).toEqual(['Bearer jwt-t1'])
  })
})

// ── 组 E：同账号多轮 threadId 连续性与 404 回退 ──

describe('Today 多轮 threadId 会话连续性', () => {
  it('同账号多轮续聊复用上一轮 threadId；切换账号不串线；遇 404 自动回退新建会话', async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    let turn = 0
    let return404OnceForTh = false
    let currentAccount = 'acc1'

    const adapter = new TodayAdapter({
      product: { ...TODAY, initialPollIntervalMs: 1, maxPollIntervalMs: 1 },
      slots: async () => [{
        accountId: currentAccount,
        credential: makeCred(`${currentAccount}.sig`, 'cn'),
      }],
      fetchImpl: async (input, init) => {
        const u = String(input)
        if (u.endsWith('/api/token')) return okJson({ token: `jwt-${currentAccount}`, expiresIn: 3600 })
        if (u.endsWith('/v1/pricing/status')) {
          return okJson({ data: { status: { modelOptions: { selectedOptionId: 'model.deepseek-v4.1-flash' } } } })
        }
        if (u.endsWith('/v1/messages')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
          sentBodies.push(body)
          if (return404OnceForTh && typeof body.threadId === 'string') {
            return404OnceForTh = false
            return new Response('thread expired', { status: 404 })
          }
          turn++
          const th = typeof body.threadId === 'string' ? body.threadId : `th-${turn}`
          return okJson({ threadId: th, messageId: `u-${turn}` }, 202)
        }
        if (u.includes('/v1/conversations/messages')) {
          if (turn === 1) {
            return okJson({
              data: { items: [{ id: 'a-1', threadId: 'th-1', role: 'assistant', state: 'completed', isFinal: true, body: { parts: [{ messageType: 'text', content: { text: '第一答' } }] } }] },
            })
          }
          if (turn === 2) {
            return okJson({
              data: {
                items: [
                  { id: 'a-1', threadId: 'th-1', role: 'assistant', state: 'completed', isFinal: true, body: { parts: [{ messageType: 'text', content: { text: '第一答' } }] } },
                  { id: 'a-2', threadId: 'th-1', role: 'assistant', state: 'completed', isFinal: true, body: { parts: [{ messageType: 'text', content: { text: '第二答' } }] } },
                ],
              },
            })
          }
          return okJson({
            data: { items: [{ id: `a-${turn}`, threadId: `th-${turn}`, role: 'assistant', state: 'completed', isFinal: true, body: { parts: [{ messageType: 'text', content: { text: '兜底新答' } }] } }] },
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    const consume = async (messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>) => {
      let text = ''
      for await (const c of adapter.stream({
        provider: 'today',
        model: 'deepseek-v4.1-flash',
        system: '系统指令',
        messages: messages as never,
      })) {
        if (c.type === 'text-delta') text += c.text
      }
      return text
    }

    // 第 1 轮：无 threadId，发送完整 prompt
    const r1 = await consume([{ role: 'user', content: [{ type: 'text', text: '第一问' }] }])
    expect(r1).toBe('第一答')
    expect(sentBodies[0]!.threadId).toBeUndefined()

    // 第 2 轮：同账号续聊，带入 threadId='th-1' 且只传增量内容；并跳过旧的 a-1 只读 a-2
    const r2 = await consume([
      { role: 'user', content: [{ type: 'text', text: '第一问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
      { role: 'user', content: [{ type: 'text', text: '第二问' }] },
    ])
    expect(r2).toBe('第二答')
    expect(sentBodies[1]!.threadId).toBe('th-1')
    expect(sentBodies[1]!.content).toBe('第二问')

    // 若账号中途切换为 acc2 -> 绝不发送 acc1 的 threadId
    currentAccount = 'acc2'
    await consume([
      { role: 'user', content: [{ type: 'text', text: '第一问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
      { role: 'user', content: [{ type: 'text', text: '第二问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '第二答' }] },
      { role: 'user', content: [{ type: 'text', text: '第三问' }] },
    ])
    expect(sentBodies[2]!.threadId).toBeUndefined()

    // 切回 acc1 且上游返回 404 时，先带 threadId 试探失败后自动回退无 threadId 全量重发
    currentAccount = 'acc1'
    return404OnceForTh = true
    const r3 = await consume([
      { role: 'user', content: [{ type: 'text', text: '第一问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
      { role: 'user', content: [{ type: 'text', text: '第二问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '第二答' }] },
      { role: 'user', content: [{ type: 'text', text: '第三问' }] },
    ])
    expect(r3).toBe('兜底新答')
    expect(sentBodies[3]!.threadId).toBe('th-1')
    expect(sentBodies[4]!.threadId).toBeUndefined()
    expect(String(sentBodies[4]!.content)).toContain('[历史对话]')
  })
})

// ── 组 F：DSML 流内归一化、图片拒绝、400 不换号、冷却时长边界与选号器 ──

describe('Today DSML 流内归一化、错误处理与选号器边界', () => {
  it('stream() 对跨分片切断的 DSML 双竖线执行实时归一化与流尾 flush()，并下发 tools', async () => {
    let pollStep = 0
    let postedContent = ''
    const adapter = new TodayAdapter({
      product: { ...TODAY, initialPollIntervalMs: 1, maxPollIntervalMs: 1 },
      slots: async () => [{ accountId: 'acc1', credential: makeCred('dsml.sig', 'cn') }],
      fetchImpl: async (input, init) => {
        const u = String(input)
        if (u.endsWith('/api/token')) return okJson({ token: 'jwt-d', expiresIn: 3600 })
        if (u.endsWith('/v1/pricing/status')) {
          return okJson({ data: { status: { modelOptions: { selectedOptionId: 'model.deepseek-v4.1-flash' } } } })
        }
        if (u.endsWith('/v1/messages')) {
          postedContent = String(JSON.parse(String(init?.body ?? '{}')).content ?? '')
          return okJson({ threadId: 'th-d', messageId: 'u-d' }, 202)
        }
        if (u.includes('/v1/conversations/messages')) {
          pollStep++
          // 分 3 步切碎双竖线 DSML 标记，且末尾以待定前缀 '<｜' 收尾考验 flush()
          const snapshots = [
            '前言<｜｜DS',
            '前言<｜｜DSML｜｜tool_calls>hi</｜｜DS',
            '前言<｜｜DSML｜｜tool_calls>hi</｜｜DSML｜｜tool_calls><｜',
          ]
          const isLast = pollStep >= 3
          return okJson({
            data: {
              items: [{
                id: 'a-d',
                threadId: 'th-d',
                role: 'assistant',
                state: isLast ? 'completed' : 'pending',
                isFinal: isLast,
                body: { parts: [{ messageType: 'text', content: { text: snapshots[Math.min(pollStep - 1, 2)] } }] },
              }],
            },
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    const out: string[] = []
    for await (const c of adapter.stream({
      provider: 'today',
      model: 'deepseek-v4.1-flash',
      tools: [{ name: 'bash', description: 'run shell', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'check' }] }],
    })) {
      if (c.type === 'text-delta') out.push(c.text)
    }

    expect(postedContent).toContain('bash')
    expect(postedContent).toContain('<｜DSML｜tool_calls>')
    expect(out.join('')).toBe('前言<｜DSML｜tool_calls>hi</｜DSML｜tool_calls><｜')
  })

  it('拒绝图片输入（UNSUPPORTED_CONTENT）且零网络；400 不换号且不写冷却', async () => {
    const fetchMock = vi.fn()
    const adapterImg = new TodayAdapter({
      product: TODAY,
      slots: async () => [{ accountId: 'acc1', credential: makeCred('i.sig', 'cn') }],
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    await expect(async () => {
      for await (const _ of adapterImg.stream({
        provider: 'today',
        model: 'deepseek-v4.1-flash',
        messages: [{
          role: 'user',
          content: [{ type: 'image', attachment: { attachmentId: 'att-img-1', mimeType: 'image/png' } }],
        } as never],
      })) { /* consume */ }
    }).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(fetchMock).not.toHaveBeenCalled()

    const callOrder: string[] = []
    const limited: unknown[] = []
    const adapter400 = new TodayAdapter({
      product: TODAY,
      slots: async () => [
        { accountId: 'acc1', credential: makeCred('b1.sig', 'cn') },
        { accountId: 'acc2', credential: makeCred('b2.sig', 'cn') },
      ],
      markLimited: async (a, m, r) => { limited.push({ a, m, r }) },
      fetchImpl: async (input, init) => {
        const u = String(input)
        const headers = (init?.headers ?? {}) as Record<string, string>
        if (u.endsWith('/api/token')) return okJson({ token: (headers.Cookie ?? '').includes('b1') ? 'jwt-b1' : 'jwt-b2', expiresIn: 3600 })
        if (u.endsWith('/v1/pricing/status')) {
          return okJson({ data: { status: { modelOptions: { selectedOptionId: 'model.deepseek-v4.1-flash' } } } })
        }
        if (u.endsWith('/v1/messages')) {
          callOrder.push(headers.Authorization ?? '')
          return new Response('bad request', { status: 400 })
        }
        return new Response('not found', { status: 404 })
      },
    })
    await expect(async () => {
      for await (const _ of adapter400.stream({
        provider: 'today',
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) { /* consume */ }
    }).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(callOrder).toEqual(['Bearer jwt-b1'])
    expect(limited).toEqual([])
  })

  it('429/402 冷却时长精确（默认 60s / 300s，Retry-After 封顶 30m），且 selectUsableTodaySlots 尊重冷却状态', async () => {
    vi.useFakeTimers()
    const baseNow = 1_700_000_000_000
    vi.setSystemTime(baseNow)

    const recorded: Array<{ accountId: string; resetAtMs: number }> = []
    const runCooldownCase = async (status: number, retryAfter?: string) => {
      clearTodayRuntimeCaches()
      const adapter = new TodayAdapter({
        product: TODAY,
        slots: async () => [{ accountId: 'acc1', credential: makeCred(`c${status}${retryAfter ?? ''}.sig`, 'cn') }],
        markLimited: async (accountId, _m, resetAtMs) => { recorded.push({ accountId, resetAtMs }) },
        fetchImpl: async (input) => {
          const u = String(input)
          if (u.endsWith('/api/token')) return okJson({ token: 'jwt-cd', expiresIn: 3600 })
          if (u.endsWith('/v1/pricing/status')) {
            return okJson({ data: { status: { modelOptions: { selectedOptionId: 'model.deepseek-v4.1-flash' } } } })
          }
          if (u.endsWith('/v1/messages')) {
            return new Response('limited', {
              status,
              ...(retryAfter !== undefined ? { headers: { 'retry-after': retryAfter } } : {}),
            })
          }
          return new Response('not found', { status: 404 })
        },
      })
      await expect(async () => {
        for await (const _ of adapter.stream({
          provider: 'today',
          model: 'deepseek-v4.1-flash',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) { /* consume */ }
      }).rejects.toThrow()
    }

    await runCooldownCase(429)
    await runCooldownCase(402)
    await runCooldownCase(429, '120')
    await runCooldownCase(429, '99999')

    expect(recorded.map((r) => r.resetAtMs - baseNow)).toEqual([
      60_000,
      300_000,
      120_000,
      1_800_000,
    ])

    // 验证 selectUsableTodaySlots：按 modelId 过滤冷却账号，不传 modelId 时放行，跨站/停用跳过
    const entries = [
      { id: 'disabled', enabled: false, credentialRef: 'REF_DIS' },
      { id: 'cooling', enabled: true, credentialRef: 'REF_COOL', modelRateLimits: { 'glm-5.3': baseNow + 60_000 } },
      { id: 'expired-cool', enabled: true, credentialRef: 'REF_EXP', modelRateLimits: { 'glm-5.3': baseNow - 1 } },
      { id: 'wrong-realm', enabled: true, credentialRef: 'REF_WRONG' },
    ]
    const creds = new Map([
      ['REF_DIS', JSON.stringify(makeCred('1.sig', 'cn'))],
      ['REF_COOL', JSON.stringify(makeCred('2.sig', 'cn'))],
      ['REF_EXP', JSON.stringify(makeCred('3.sig', 'cn'))],
      ['REF_WRONG', JSON.stringify(makeCred('4.sig', 'global'))],
    ])
    const resolveRaw = async (ref: string) => creds.get(ref)

    const forInfer = await selectUsableTodaySlots(entries, resolveRaw, TODAY, 'glm-5.3', baseNow)
    expect(forInfer.map((s) => s.accountId)).toEqual(['expired-cool'])

    const forCatalog = await selectUsableTodaySlots(entries, resolveRaw, TODAY, undefined, baseNow)
    expect(forCatalog.map((s) => s.accountId)).toEqual(['cooling', 'expired-cool'])
  })
})

// ── 组 G：TodayAuth 服务全方法验证 ──

describe('TodayAuth 认证服务与元数据对账', () => {
  it('覆盖 status / checkExpired / refresh / refreshAccountCredential / refreshAll', async () => {
    const creds = new Map<string, string>()
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
    const warns: string[] = []
    const ctx = new Context()
    Object.assign(ctx, {
      credentials: {
        resolve: async (ref: string) => {
          const val = creds.get(ref)
          return val === undefined ? undefined : { value: val }
        },
      },
      logger: { warn: (m: string) => { warns.push(m) } },
    })

    const auth = new TodayAuth(ctx, { product: TODAY })
    expect(auth.name).toBe('todayAuth')
    expect(auth.credentialRefName).toBe('TODAY_SESSION')

    // 无池、无凭据
    expect(await auth.status()).toEqual({ configured: false, refreshable: false })
    expect(await auth.checkExpired()).toBe(true)
    await expect(auth.refresh()).rejects.toThrow(/Today \(国内版\)/)

    // 放入合法单凭据后可通过
    creds.set('TODAY_SESSION', JSON.stringify(makeCred('single.sig', 'cn')))
    expect(await auth.status()).toEqual({ configured: true, source: 'cookie', refreshable: false })
    await expect(auth.refresh()).resolves.toBeUndefined()

    const poolEntries = [
      { id: 'bad-acc', provider: 'today', credentialRef: 'TODAY_ACCOUNT_BAD', enabled: true, refreshable: true },
      { id: 'ok-acc', provider: 'today', credentialRef: 'TODAY_ACCOUNT_OK', enabled: true, refreshable: true },
      { id: 'missing-acc', provider: 'today', credentialRef: 'TODAY_ACCOUNT_MISS', enabled: true, refreshable: false },
    ]
    creds.set('TODAY_ACCOUNT_BAD', JSON.stringify(makeCred('wrong.sig', 'global')))
    creds.set('TODAY_ACCOUNT_OK', JSON.stringify({ ...makeCred('ok.sig', 'cn'), user_id: 'uid-1', email: 'cn@example.com' }))

    const pool = {
      listAccountsByProvider: () => poolEntries,
      updateAccount: async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch })
      },
    } as never

    expect(await auth.status(pool)).toEqual({ configured: true, source: 'cookie', refreshable: false })
    await auth.refreshAccountCredential('TODAY_ACCOUNT_MISS', pool, 'missing-acc')
    expect(warns.some((w) => w.includes('missing-acc'))).toBe(true)

    await auth.refreshAll(undefined)
    warns.length = 0
    await auth.refreshAccountCredential('TODAY_ACCOUNT_OK', pool, 'ok-acc')
    expect(warns).toEqual([])
    await auth.refreshAll(pool)
    expect(warns.some((w) => w.includes('bad-acc'))).toBe(true)
    expect(warns.some((w) => w.includes('missing-acc'))).toBe(true)
    expect(warns.some((w) => w.includes('ok-acc'))).toBe(false)
    expect(updates).toEqual([])
    await auth.logout()
    auth.stop()
  })
})

// ── 组 H & I：双站隔离守卫、hosts 对拍、todayExpiry 三态（含 NEVER） ──

describe('Today 双站隔离、主机分离与 todayExpiry 三态（含 NEVER）', () => {
  it('双站 refPrefix / defaultCredentialRef / Host 严格隔离且不互吞前缀', async () => {
    expect(TODAY.id).not.toBe(TODAY_INTL.id)
    expect(TODAY.realm).not.toBe(TODAY_INTL.realm)
    expect(TODAY.refPrefix).toBe('TODAY')
    expect(TODAY_INTL.refPrefix).toBe('TODAYINTL')
    expect(TODAY.defaultCredentialRef).toBe('TODAY_SESSION')
    expect(TODAY_INTL.defaultCredentialRef).toBe('TODAYINTL_SESSION')
    expect(new URL(TODAY.appBase).host).toBe('todayai.cn')
    expect(new URL(TODAY_INTL.appBase).host).toBe('today.ai')

    // TODAY 与 TODAYINTL 是前导超串关系，验证 jet-hub-store 恢复不互吞
    const cnSlot = todaySlotNamesOf(TODAY, { user_id: 'u-cn', cookie_raw: 'c1' })
    const intlSlot = todaySlotNamesOf(TODAY_INTL, { user_id: 'u-intl', cookie_raw: 'c2' })
    expect(providerOfAccountRef(cnSlot.refName)).toBe('today')
    expect(providerOfAccountRef(intlSlot.refName)).toBe('todayintl')

    // 验证余额查询确实打到各自站点域名（而非查错站）
    const cnHosts: string[] = []
    const intlHosts: string[] = []
    const hostRecorder = (bucket: string[]): typeof fetch => async (input) => {
      const u = new URL(String(input))
      bucket.push(u.host)
      if (u.pathname === '/api/token') return okJson({ token: 'jwt-bal', expiresIn: 3600 })
      return okJson({ data: { status: { plan: 'pro', usage: { progress: 20 } } } })
    }
    const cnBal = await fetchTodayBalanceDetailed(TODAY, makeCred('bal1.sig', 'cn'), hostRecorder(cnHosts))
    const intlBal = await fetchTodayBalanceDetailed(TODAY_INTL, makeCred('bal2.sig', 'global'), hostRecorder(intlHosts))
    expect(cnBal.balance?.total).toBe(80)
    expect(intlBal.balance?.total).toBe(80)
    expect(cnHosts).toEqual(['todayai.cn', 'api.todayai.cn'])
    expect(intlHosts).toEqual(['today.ai', 'api.today.ai'])
  })

  it('todayExpiry 三态全覆盖：有 resetAt -> 截止时刻；有余额无 resetAt -> NEVER；无余额/失效 -> UNUSABLE', async () => {
    const resetAt = '2026-12-10T00:00:00.000Z'
    const withDate = await todayExpiry(
      makeCred('e1.sig', 'cn'),
      TODAY,
      async () => parseTodayBalanceFromStatus({ usage: { progress: 10, resetAt } }),
    )
    expect(withDate).toBe(Date.parse(resetAt))

    // 有余额但无 resetAt -> 必须返回 NEVER（不编造 0 点也不判不可用）
    const noDate = await todayExpiry(
      makeCred('e2.sig', 'cn'),
      TODAY,
      async () => parseTodayBalanceFromStatus({ usage: { progress: 35 } }),
    )
    expect(noDate).toBe(NEVER)

    const exhausted = await todayExpiry(
      makeCred('e3.sig', 'cn'),
      TODAY,
      async () => parseTodayBalanceFromStatus({ usage: { progress: 100, resetAt } }),
    )
    expect(exhausted).toBe(UNUSABLE)

    const failed = await todayExpiry(
      makeCred('e4.sig', 'cn'),
      TODAY,
      async () => null,
    )
    expect(failed).toBe(UNUSABLE)
  })
})

// ── 组 J：聚合映射与 handleTodayRpc 全分支（去重 / 改 Cookie / 回滚 / OTP 校验） ──

describe('Today 聚合路由合并与 handleTodayRpc 完整校验', () => {
  it('today 与 todayintl 模型归并进聚合路由虚拟模型候选表', () => {
    const models = buildVirtualModels({
      today: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
        { id: 'glm-5.3', name: 'GLM 5.3' },
        { id: 'minimax-m31-flash', name: 'MiniMax M3.1 Flash' },
      ],
      todayintl: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
        { id: 'glm-5.3', name: 'GLM 5.3' },
        { id: 'minimax-m31-flash', name: 'MiniMax M3.1 Flash' },
      ],
      buddy: [
        { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
      ],
    })
    const ds = models.find((m) => m.key === 'deepseek-v4-1-flash')
    expect(ds?.candidates.map((c) => c.provider)).toEqual(['buddy', 'today', 'todayintl'])

    const mm = models.find((m) => m.key === 'minimax-m3-1-flash')
    expect(mm?.candidates.map((c) => c.provider)).toEqual(['today', 'todayintl'])
  })

  it('handleTodayRpc 支持跨站拦截、同号更新去重、失败回滚 unset、setCookie 保留昵称与 OTP 全分支', async () => {
    const creds = new Map<string, string>()
    const accounts: Array<{ id: string; provider: string; credentialRef: string; nickname?: string }> = []
    let throwOnAdd = false
    const ctx = {
      credentials: {
        resolve: async (ref: string) => {
          const val = creds.get(ref)
          return val === undefined ? undefined : { value: val }
        },
        set: async (ref: string, val: string) => { creds.set(ref, val) },
        unset: async (ref: string) => { creds.delete(ref) },
      },
    } as unknown as Context
    const pool = {
      listAccountsByProvider: (p: string) => accounts.filter((a) => a.provider === p).map((a) => ({ ...a, enabled: true })),
      addAccount: async (entry: { id: string; provider: string; credentialRef: string; nickname?: string }) => {
        if (throwOnAdd) throw new Error('disk full')
        accounts.push(entry)
      },
      updateAccount: async () => {},
      removeAccount: async () => {},
    }

    // 未知方法返回 undefined
    expect(await handleTodayRpc(ctx, pool, 'other.method', {}, TODAY)).toBeUndefined()

    // 跨站 URL 提示拦截
    const wrongRealm = await handleTodayRpc(
      ctx,
      pool,
      'today.addAccount',
      { cookie: `curl 'https://today.ai/api/token' -H 'cookie: __Secure-better-auth.session_token=x.y'` },
      TODAY,
    ) as { ok: boolean; error?: { message: string } }
    expect(wrongRealm.ok).toBe(false)
    expect(wrongRealm.error?.message).toContain('Today (国际版)')

    // addAccount 失败时回滚清理写入的 credential
    const cnFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url === `${TODAY.appBase}/api/token`) return okJson({ token: 'jwt-cn', expiresIn: 3600 })
      if (url === `${TODAY.apiBase}/v1/users/me`) return okJson({ id: 'u1', email: 'cn@example.com', plan: 'free' })
      return new Response('not found', { status: 404 })
    })
    throwOnAdd = true
    await expect(handleTodayRpc(ctx, pool, 'today.addAccount', { cookie: '__Secure-better-auth.session_token=valid.sig' }, TODAY, cnFetch))
      .resolves.toMatchObject({ ok: false })
    expect(creds.size).toBe(0)
    throwOnAdd = false

    // 正常新增 + 自定义昵称
    const added = await handleTodayRpc(
      ctx,
      pool,
      'today.addAccount',
      { cookie: '__Secure-better-auth.session_token=valid.sig', nickname: '主力 CN 号' },
      TODAY,
      cnFetch,
    ) as { ok: boolean; value?: { accountId: string; existed: boolean; nickname: string } }
    expect(added.ok).toBe(true)
    expect(added.value?.existed).toBe(false)
    expect(accounts).toHaveLength(1)

    // 同 user_id 用新 Cookie 再 add -> 去重走更新分支，不建新号
    const dedup = await handleTodayRpc(
      ctx,
      pool,
      'today.addAccount',
      { cookie: '__Secure-better-auth.session_token=rotated.sig' },
      TODAY,
      cnFetch,
    ) as { ok: boolean; value?: { accountId: string; existed: boolean; nickname: string } }
    expect(dedup.ok).toBe(true)
    expect(dedup.value?.existed).toBe(true)
    expect(dedup.value?.nickname).toBe('主力 CN 号')
    expect(accounts).toHaveLength(1)

    // setCookie 保留原自定义昵称，且对不存在账号报错
    const updated = await handleTodayRpc(
      ctx,
      pool,
      'today.setCookie',
      { accountId: added.value!.accountId, cookie: '__Secure-better-auth.session_token=newest.sig' },
      TODAY,
      cnFetch,
    ) as { ok: boolean; value?: { nickname: string } }
    expect(updated.ok).toBe(true)
    expect(updated.value?.nickname).toBe('主力 CN 号')

    const missingSet = await handleTodayRpc(
      ctx,
      pool,
      'today.setCookie',
      { accountId: 'no-such', cookie: 'a.b' },
      TODAY,
      cnFetch,
    ) as { ok: boolean }
    expect(missingSet.ok).toBe(false)

    // 国内版阻止 OTP
    const cnOtp = await handleTodayRpc(ctx, pool, 'today.sendOtp', { email: 'cn@example.com' }, TODAY) as { ok: boolean; error?: { message: string } }
    expect(cnOtp.ok).toBe(false)
    expect(cnOtp.error?.message).toContain('停用邮箱验证码')

    // 国际版 OTP 全流程
    const intlFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/send-verification-otp')) return okJson({})
      if (url.endsWith('/sign-in/email-otp')) {
        return new Response('{}', {
          status: 200,
          headers: { 'set-cookie': '__Secure-better-auth.session_token=otp.sig; Path=/; HttpOnly' },
        })
      }
      if (url === `${TODAY_INTL.appBase}/api/token`) return okJson({ token: 'jwt-intl', expiresIn: 3600 })
      if (url === `${TODAY_INTL.apiBase}/v1/users/me`) return okJson({ id: 'u2', email: 'intl@example.com' })
      return new Response('not found', { status: 404 })
    })

    const sent = await handleTodayRpc(ctx, pool, 'todayintl.sendOtp', { email: 'intl@example.com' }, TODAY_INTL, intlFetch) as { ok: boolean }
    expect(sent.ok).toBe(true)

    const verified = await handleTodayRpc(
      ctx,
      pool,
      'todayintl.verifyOtp',
      { email: 'intl@example.com', otp: '123456' },
      TODAY_INTL,
      intlFetch,
    ) as { ok: boolean }
    expect(verified.ok).toBe(true)
    expect(accounts.some((a) => a.provider === 'todayintl')).toBe(true)
  })

  it('authenticateTodayCookie 对 401 无跨站成功时给出诊断文案，跨站通过时引导正确渠道', async () => {
    const mockAltOk: typeof fetch = vi.fn(async (input) => {
      if (String(input).startsWith(TODAY.appBase)) return new Response('unauthorized', { status: 401 })
      if (String(input).startsWith(TODAY_INTL.appBase)) return okJson({ token: 'jwt-alt', expiresIn: 3600 })
      return new Response('not found', { status: 404 })
    })
    await expect(
      authenticateTodayCookie('__Secure-better-auth.session_token=onlyintl.sig', TODAY, mockAltOk),
    ).rejects.toThrow(/Today \(国际版\)/)

    const mockBothFail: typeof fetch = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    await expect(
      authenticateTodayCookie('__Secure-better-auth.session_token=expired.sig', TODAY, mockBothFail),
    ).rejects.toThrow(/已被上游拒绝/)
  })
})

describe('sendTodayMessage 基础发送契约', () => {
  it('携带可选 threadId 并返回 threadId / messageId / clientMessageId', async () => {
    const res = await sendTodayMessage(makeCred('s.sig', 'cn'), TODAY, '你好', {
      threadId: 'th-prev',
      fetcher: async (input, init) => {
        if (String(input).endsWith('/api/token')) return okJson({ token: 'jwt-s', expiresIn: 3600 })
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        expect(body.threadId).toBe('th-prev')
        expect(body.channel).toBe('main')
        return okJson({ threadId: 'th-prev', messageId: 'm-u-9' }, 202)
      },
    })
    expect(res.threadId).toBe('th-prev')
    expect(res.messageId).toBe('m-u-9')
    expect(res.clientMessageId).toMatch(/^msg_/)
  })
})
