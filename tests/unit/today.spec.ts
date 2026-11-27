import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { UNUSABLE } from '../../src/aggregate-core.js'
import { buildVirtualModels } from '../../src/aggregate-catalog.js'
import { todayExpiry } from '../../src/aggregate-expiry.js'
import { TODAY, TODAY_INTL } from '../../src/today-product.js'
import {
  clearTodayRuntimeCaches,
  diagnoseTodayCookieFailure,
  normalizeTodayCookieInput,
} from '../../src/today.js'
import { parseTodayBalanceFromStatus } from '../../src/today-credits.js'
import { TodayAdapter, buildTodayPrompt } from '../../src/today-adapter.js'
import { handleTodayRpc } from '../../src/today-rpc.js'

afterEach(() => {
  clearTodayRuntimeCaches()
})

describe('Today Cookie 清洗与诊断', () => {
  it('支持裸值、Cookie 头、cURL、Tab 行与 JSON 数组，并识别站点提示', () => {
    const bare = normalizeTodayCookieInput('abc.def/+=')
    expect(bare.header).toBe('__Secure-better-auth.session_token=abc.def%2F%2B%3D')

    const curl = normalizeTodayCookieInput(
      `curl 'https://todayai.cn/api/token' -H 'cookie: __Secure-better-auth.session_token=tok.sig='`,
    )
    expect(curl.realmHint).toBe('cn')
    expect(curl.header).toBe('__Secure-better-auth.session_token=tok.sig%3D')

    const jsonArr = normalizeTodayCookieInput(JSON.stringify([
      { domain: '.today.ai', name: '__Secure-better-auth.session_token', value: 'intl.tok=' },
    ]))
    expect(jsonArr.realmHint).toBe('global')
    expect(jsonArr.header).toBe('__Secure-better-auth.session_token=intl.tok%3D')
  })

  it('诊断缺失/缺签名/过期 Cookie', () => {
    expect(diagnoseTodayCookieFailure('foo=bar')).toContain('未在粘贴内容中找到')
    expect(diagnoseTodayCookieFailure('__Secure-better-auth.session_token=nosig')).toContain('缺少签名段')
    expect(diagnoseTodayCookieFailure('__Secure-better-auth.session_token=tok.sig')).toContain('已被上游拒绝')
  })
})

describe('Today 额度与聚合折算', () => {
  it('解析 /v1/pricing/status 为剩余百分比包（带 resetAt）', () => {
    const resetAt = '2026-12-01T00:00:00.000Z'
    const bal = parseTodayBalanceFromStatus({
      plan: 'pro',
      usage: { progress: 25.5, resetAt, progressText: '25.5%' },
    })
    expect(bal).not.toBeNull()
    expect(bal!.total).toBe(74.5)
    expect(bal!.packages).toHaveLength(1)
    expect(bal!.packages[0]!.deductionEndTime).toBe(Date.parse(resetAt))
    expect(bal!.packages[0]!.expiryUnknown).toBeUndefined()
  })

  it('缺少 resetAt 时置 expiryUnknown 而不编造日期', () => {
    const bal = parseTodayBalanceFromStatus({
      usage: { progress: 40 },
    })
    expect(bal).not.toBeNull()
    expect(bal!.total).toBe(60)
    expect(bal!.packages[0]!.expiryUnknown).toBe(true)
    expect(bal!.packages[0]!.deductionEndTime).toBeUndefined()
  })

  it('todayExpiry 在无余额或查不到时返回 UNUSABLE，有 resetAt 返回截止时刻', async () => {
    const resetAt = '2026-12-10T00:00:00.000Z'
    const expiry = await todayExpiry(
      { cookie_raw: '__Secure-better-auth.session_token=a.b', realm: 'cn' },
      TODAY,
      async () => parseTodayBalanceFromStatus({ usage: { progress: 10, resetAt } }),
    )
    expect(expiry).toBe(Date.parse(resetAt))

    const exhausted = await todayExpiry(
      { cookie_raw: '__Secure-better-auth.session_token=a.b', realm: 'cn' },
      TODAY,
      async () => parseTodayBalanceFromStatus({ usage: { progress: 100, resetAt } }),
    )
    expect(exhausted).toBe(UNUSABLE)
  })
})

describe('TodayAdapter 推理与聚合路由', () => {
  it('buildTodayPrompt 按 [系统指令] / [历史对话] / [当前消息] 线性拼接', () => {
    const prompt = buildTodayPrompt({
      system: '你是助手',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '第一问' }] },
        { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
        { role: 'user', content: [{ type: 'text', text: '第二问' }] },
      ],
    })
    expect(prompt).toContain('[系统指令]\n你是助手')
    expect(prompt).toContain('[历史对话]\n用户：第一问\n助手：第一答\n[当前消息]\n第二问')
  })

  it('完成端到端换 JWT -> 切换模型 -> 发消息 -> 轮询增量流式输出，并在 429 时写冷却并换号', async () => {
    const limitedCalls: Array<{ accountId: string; modelId: string }> = []
    let pollCount = 0
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (url.endsWith('/api/token')) {
        const cookie = headers.Cookie ?? headers.cookie ?? ''
        const token = cookie.includes('acc1') ? 'jwt-1' : 'jwt-2'
        return new Response(JSON.stringify({ token, expiresIn: 3600 }), { status: 200 })
      }
      if (url.endsWith('/v1/pricing/status')) {
        return new Response(JSON.stringify({
          data: { status: { modelOptions: { selectedOptionId: 'model.glm-5.3', options: [] } } },
        }), { status: 200 })
      }
      if (url.endsWith('/v1/pricing/model-option')) {
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/v1/messages')) {
        if (headers.Authorization === 'Bearer jwt-1') {
          return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } })
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        expect(body.channel).toBe('main')
        return new Response(JSON.stringify({ threadId: 'th-1', messageId: 'm-1' }), { status: 202 })
      }
      if (url.includes('/v1/conversations/messages')) {
        pollCount++
        const items = pollCount === 1
          ? [{ threadId: 'th-1', role: 'assistant', state: 'pending', isFinal: false, body: { parts: [{ messageType: 'text', content: { text: '你好' } }] } }]
          : [{ threadId: 'th-1', role: 'assistant', state: 'completed', isFinal: true, body: { parts: [{ messageType: 'text', content: { text: '你好，世界' } }] } }]
        return new Response(JSON.stringify({ data: { items } }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const adapter = new TodayAdapter({
      product: TODAY,
      fetchImpl: fetcher,
      slots: async () => [
        { accountId: 'acc1', credential: { cookie_raw: '__Secure-better-auth.session_token=acc1.sig', realm: 'cn' } },
        { accountId: 'acc2', credential: { cookie_raw: '__Secure-better-auth.session_token=acc2.sig', realm: 'cn' } },
      ],
      markLimited: async (accountId, modelId) => {
        limitedCalls.push({ accountId, modelId })
      },
    })

    const chunks: string[] = []
    let finishKind = ''
    for await (const chunk of adapter.stream({
      provider: 'today',
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      if (chunk.type === 'text-delta') chunks.push(chunk.text)
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }

    expect(limitedCalls).toEqual([{ accountId: 'acc1', modelId: 'deepseek-v4.1-flash' }])
    expect(chunks.join('')).toBe('你好，世界')
    expect(finishKind).toBe('stop')
  })

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
})

describe('handleTodayRpc 登录与校验', () => {
  it('拦截把国际版 Cookie 填进国内版通道，并正常创建国内版账号', async () => {
    const creds = new Map<string, string>()
    const accounts: Array<{ id: string; provider: string; credentialRef: string; nickname?: string }> = []
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
        accounts.push(entry)
      },
      updateAccount: async () => {},
      removeAccount: async () => {},
    }

    const wrongRealm = await handleTodayRpc(
      ctx,
      pool,
      'today.addAccount',
      { cookie: `curl 'https://today.ai/api/token' -H 'cookie: __Secure-better-auth.session_token=x.y'` },
      TODAY,
    ) as { ok: boolean; error?: { message: string } }
    expect(wrongRealm.ok).toBe(false)
    expect(wrongRealm.error?.message).toContain('Today (国际版)')

    const mockFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url === `${TODAY.appBase}/api/token`) {
        return new Response(JSON.stringify({ token: 'jwt-cn', expiresIn: 3600 }), { status: 200 })
      }
      if (url === `${TODAY.apiBase}/v1/users/me`) {
        return new Response(JSON.stringify({ id: 'u1', email: 'cn@example.com', plan: 'free' }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const okRes = await handleTodayRpc(
      ctx,
      pool,
      'today.addAccount',
      { cookie: '__Secure-better-auth.session_token=valid.sig' },
      TODAY,
      mockFetch,
    ) as { ok: boolean; value?: { accountId: string; existed: boolean } }
    expect(okRes.ok).toBe(true)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.provider).toBe('today')
  })

  it('国际版支持发送并校验邮箱 OTP', async () => {
    const creds = new Map<string, string>()
    const accounts: Array<{ id: string; provider: string; credentialRef: string }> = []
    const ctx = {
      credentials: {
        resolve: async () => undefined,
        set: async (ref: string, val: string) => { creds.set(ref, val) },
        unset: async () => {},
      },
    } as unknown as Context
    const pool = {
      listAccountsByProvider: (p: string) => accounts.filter((a) => a.provider === p).map((a) => ({ ...a, enabled: true })),
      addAccount: async (entry: { id: string; provider: string; credentialRef: string }) => { accounts.push(entry) },
      updateAccount: async () => {},
      removeAccount: async () => {},
    }
    const mockFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith('/send-verification-otp')) return new Response('{}', { status: 200 })
      if (url.endsWith('/sign-in/email-otp')) {
        return new Response('{}', {
          status: 200,
          headers: { 'set-cookie': '__Secure-better-auth.session_token=otp.sig; Path=/; HttpOnly' },
        })
      }
      if (url === `${TODAY_INTL.appBase}/api/token`) {
        return new Response(JSON.stringify({ token: 'jwt-intl', expiresIn: 3600 }), { status: 200 })
      }
      if (url === `${TODAY_INTL.apiBase}/v1/users/me`) {
        return new Response(JSON.stringify({ id: 'u2', email: 'intl@example.com' }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    const sent = await handleTodayRpc(ctx, pool, 'todayintl.sendOtp', { email: 'intl@example.com' }, TODAY_INTL, mockFetch) as { ok: boolean }
    expect(sent.ok).toBe(true)

    const verified = await handleTodayRpc(
      ctx,
      pool,
      'todayintl.verifyOtp',
      { email: 'intl@example.com', otp: '123456' },
      TODAY_INTL,
      mockFetch,
    ) as { ok: boolean }
    expect(verified.ok).toBe(true)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.provider).toBe('todayintl')
  })
})
