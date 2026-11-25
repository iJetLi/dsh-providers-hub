import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderAuth, RefreshTokenExpiredError } from '../../src/qoder-auth.js'
import { QODER } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload } from '../../src/qoder.js'

/** 所有已创建的 service；afterEach 统一 stop()，避免刷新定时器泄漏。 */
const services: QoderAuth[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.stop()
})

/**
 * 内存凭据提供者，形状与 ctx.credentials 一致。
 *
 * 用真实 `Context` + `ctx.provide('credentials', ...)`（而非裸对象 mock）：
 * cordis 的 `Service` 构造会调用 `ctx.provide`，裸对象会在
 * `Cannot read properties of undefined (reading 'provide')` 处炸掉。
 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: unknown) {
    const value = this.store.get(keyOf(ref))
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: unknown) {
    const has = this.store.has(keyOf(ref))
    return { configured: has, source: has ? 'fake' : undefined, writable: true }
  }
  async set(ref: unknown, value: string) { this.store.set(keyOf(ref), value) }
  async unset(ref: unknown) { this.store.delete(keyOf(ref)) }
  has(ref: unknown): boolean { return this.store.has(keyOf(ref)) }
  raw(ref: unknown): string | undefined { return this.store.get(keyOf(ref)) }
}

/** 取凭据 ref 的键名（credentialRef(name) 返回 `{ name }` 形态）。 */
function keyOf(ref: unknown): string {
  if (typeof ref === 'string') return ref
  if (ref !== null && typeof ref === 'object' && 'name' in ref) {
    return String((ref as { name: unknown }).name)
  }
  return String(ref)
}

/** 建立带凭据存储的 Context。初始条目形如 `[['QODER_ACCESS_TOKEN', json]]`。 */
function makeCtx(entries: Array<[string, string]> = []): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  for (const [ref, value] of entries) void credentials.set(ref, value)
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

/** 构造 service 并登记以便 afterEach 清理。 */
function newService(ctx: Context, fetcher: typeof fetch): QoderAuth {
  const service = new QoderAuth(ctx, { product: QODER, fetcher })
  services.push(service)
  return service
}

/** 读回已存凭据的 JSON。 */
function readCred(credentials: FakeCredentials, ref: string): Record<string, unknown> {
  return JSON.parse(credentials.raw(ref)!) as Record<string, unknown>
}

const credJson = JSON.stringify(buildQoderCredential(
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref' }), { machineId: 'm-1' }))

/** 成功的续期响应。 */
function refreshOk(token = 'tok-2', refresh = 'ref-2'): Response {
  return new Response(JSON.stringify({ device_token: token, refresh_token: refresh }), { status: 200 })
}

describe('QoderAuth 续期', () => {
  it('401 抛 RefreshTokenExpiredError 且 name 精确（refresh.ts 按 name 判定）', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const error = await auth.refresh().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).name).toBe('RefreshTokenExpiredError')
  })

  it('403 同样视为终态', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('网络失败抛普通 Error（可重试，不是终态）', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const error = await auth.refresh().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).not.toBe('RefreshTokenExpiredError')
  })

  it('5xx 抛普通 Error（可重试）', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const error = await auth.refresh().catch((e: unknown) => e)
    expect((error as Error).name).not.toBe('RefreshTokenExpiredError')
  })

  it('成功续期回写新 token 并保留 machine_id', async () => {
    const { ctx, credentials } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => refreshOk()) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refresh()
    const saved = readCred(credentials, 'QODER_ACCESS_TOKEN')
    expect(saved.access_token).toBe('tok-2')
    expect(saved.machine_id).toBe('m-1')
    expect(saved.refresh_token).toBe('ref-2')
  })

  it('续期请求体带 refresh_token 与 machine_id', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => refreshOk()) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refresh()
    const call = (fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    expect(String(call[0])).toBe('https://openapi.qoder.sh/api/v1/deviceToken/refresh')
    expect(JSON.parse(String((call[1] as { body: string }).body))).toEqual({
      refresh_token: 'ref', machine_id: 'm-1',
    })
  })

  it('无 refresh_token 时抛终态错误', async () => {
    const noRefresh = buildQoderCredential(
      parseQoderTokenPayload({ token: 'tok' }), { machineId: 'm' })
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', JSON.stringify(noRefresh)]])
    const auth = newService(ctx, vi.fn() as never)
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('未配置凭据时报错', async () => {
    const { ctx } = makeCtx()
    const auth = newService(ctx, vi.fn() as never)
    await expect(auth.refresh()).rejects.toThrow(/未配置凭据/)
  })

  it('响应 200 但无 token 视为终态（拿不到新凭据）', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })
})

describe('QoderAuth status / logout', () => {
  it('status 报告 configured / refreshable / expiresAt', async () => {
    const withExpiry = buildQoderCredential(
      parseQoderTokenPayload({ token: 't', refresh_token: 'r', expires_at: '2030-01-01T00:00:00Z' }),
      { machineId: 'm' })
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', JSON.stringify(withExpiry)]])
    const auth = newService(ctx, vi.fn() as never)
    const status = await auth.status()
    expect(status.configured).toBe(true)
    expect(status.refreshable).toBe(true)
    expect(status.expiresAt).toBe(Date.parse('2030-01-01T00:00:00Z'))
  })

  it('未配置时 status.configured 为 false', async () => {
    const { ctx } = makeCtx()
    const auth = newService(ctx, vi.fn() as never)
    const status = await auth.status()
    expect(status.configured).toBe(false)
    expect(status.refreshable).toBe(false)
  })

  it('logout 清除凭据', async () => {
    const { ctx, credentials } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const auth = newService(ctx, vi.fn() as never)
    await auth.logout()
    expect(credentials.has('QODER_ACCESS_TOKEN')).toBe(false)
  })

  it('logout 后在途续期不回写（登出竞态保护）', async () => {
    const { ctx, credentials } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetcher = vi.fn(async () => {
      await gate
      return refreshOk('tok-x', 'ref-x')
    }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const inFlight = auth.refresh().catch(() => {})
    await auth.logout()
    release?.()
    await inFlight
    expect(credentials.has('QODER_ACCESS_TOKEN')).toBe(false)
  })
})

describe('QoderAuth refreshAll（只按 refreshable 过滤，不看 enabled）', () => {
  it('已停用但可续期的账号仍被续期', async () => {
    // AGENTS.md 强制约定：停用只影响选号，不该让凭据烂掉
    const { ctx, credentials } = makeCtx([['QODER_ACCOUNT_A', credJson]])
    const fetcher = vi.fn(async () => refreshOk('tok-new', 'ref-new')) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const pool = {
      async listAccounts() {
        return [{
          id: 'a', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_A',
          enabled: false, refreshable: true, nickname: 'a', createdAt: 0,
        }]
      },
      async updateAccount() { /* noop */ },
    } as never
    await auth.refreshAll(pool)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(readCred(credentials, 'QODER_ACCOUNT_A').access_token).toBe('tok-new')
  })

  it('不可续期的账号被跳过', async () => {
    const { ctx } = makeCtx()
    const fetcher = vi.fn() as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const pool = {
      async listAccounts() {
        return [{ id: 'a', provider: 'qoder', credentialRef: 'X', enabled: true, refreshable: false,
          nickname: 'a', createdAt: 0 }]
      },
      async updateAccount() { /* noop */ },
    } as never
    await auth.refreshAll(pool)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('单账号失败不中断其他账号', async () => {
    const { ctx, credentials } = makeCtx([
      ['QODER_ACCOUNT_A', credJson],
      ['QODER_ACCOUNT_B', credJson],
    ])
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('ECONNRESET')
      return refreshOk('ok', 'r')
    }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const pool = {
      async listAccounts() {
        return [
          { id: 'a', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_A', enabled: true,
            refreshable: true, nickname: 'a', createdAt: 0 },
          { id: 'b', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_B', enabled: true,
            refreshable: true, nickname: 'b', createdAt: 0 },
        ]
      },
      async updateAccount() { /* noop */ },
    } as never
    await auth.refreshAll(pool)
    expect(calls).toBe(2)
    expect(readCred(credentials, 'QODER_ACCOUNT_B').access_token).toBe('ok')
  })

  it('refreshAccountCredential 刷指定 ref（不动默认单凭据）', async () => {
    const { ctx, credentials } = makeCtx([
      ['QODER_ACCESS_TOKEN', credJson],
      ['QODER_ACCOUNT_Z', credJson],
    ])
    const fetcher = vi.fn(async () => refreshOk('z-new', 'z-ref')) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    await auth.refreshAccountCredential('QODER_ACCOUNT_Z')
    expect(readCred(credentials, 'QODER_ACCOUNT_Z').access_token).toBe('z-new')
    expect(readCred(credentials, 'QODER_ACCESS_TOKEN').access_token).toBe('tok')
  })
})

// ── 远端模型目录（2026-10-20）──
//
// 为什么由 auth 服务取数、而不是适配器自己解析凭据：适配器的
// `resolveCredential` 会 `reportAccount`（写「本次实际使用的账号」），而目录请求
// 是周期性的（20 分钟刷新器）⇒ 会把额度标记改写到目录用的账号上。
// 本组用例把「池只读」这条性质钉住。
describe('QoderAuth.fetchModels（远端模型目录）', () => {
  /** 带 uid 的凭据（加密目录请求必需）。 */
  const credWithUid = JSON.stringify(buildQoderCredential(
    parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
    { machineId: 'm-1' },
  ))

  /** Standard models from the real CLI `/model/list` shape. */
  const remoteBody = {
    chat: [
      {
        key: 'dfmodel', display_name: 'DeepSeek-Flash', enable: true,
        is_vl: true, is_reasoning: false, is_free: true,
        price_factor: 0, original_price_factor: 0.1,
        context_config: { '1M': { token_count: 1_000_000 } },
      },
      {
        key: 'mmodel', display_name: 'MiniMax-M3.1-Flash', enable: true,
        is_vl: true, price_factor: 0.1,
        context_config: { '200K': { token_count: 200_000 } },
      },
    ],
  }
  /** Sanitized app-only model payload captured live from Qoder CN/Global on 2026-11-25. */
  const remoteAppBody = {
    assistant: [{
      key: 'hmodel', status: 'idle', format: 'openai', source: 'system', enable: true,
      display_name: 'HungerG', is_vl: true, is_reasoning: true, price_factor: 0,
      original_price_factor: 0, max_input_tokens: 1_000_000, is_free: true, is_lite_plan: true, tags: ['free'],
      context_config: { '1M': { token_count: 1_000_000 }, '200K': { token_count: 200_000, is_default: true }, '400K': { token_count: 400_000 } },
      thinking_config: { disabled: {}, enabled: { efforts: { high: {}, max: { is_default: true }, low: {} }, is_default: true } },
      minimal_version: { cli: '9999.9999.9999', qoder_work: '9999.9999.9999', mobile: '9999.9999.9999', jb_plugin: '9999.9999.9999', cloud_agents: '9999.9999.9999', qoder_wake: '9999.9999.9999' },
    }],
    app: [{
      key: 'hmodel', status: 'idle', format: 'openai', source: 'system', enable: true,
      display_name: 'HungerG', is_vl: true, is_reasoning: true, price_factor: 0,
      original_price_factor: 0, max_input_tokens: 1_000_000, is_free: true, is_lite_plan: true, tags: ['free'],
      context_config: { '1M': { token_count: 1_000_000 }, '200K': { token_count: 200_000, is_default: true }, '400K': { token_count: 400_000 } },
      thinking_config: { disabled: {}, enabled: { efforts: { high: {}, max: { is_default: true }, low: {} }, is_default: true } },
      minimal_version: { cli: '9999.9999.9999', qoder_work: '9999.9999.9999', mobile: '9999.9999.9999', jb_plugin: '9999.9999.9999', cloud_agents: '9999.9999.9999', qoder_wake: '9999.9999.9999' },
    }],
  }
  const okResponse = (body: unknown = remoteBody): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  /** 假的账号池；只实现本路径用到的读方法。 */
  function fakePool(credential: unknown): { pool: never; reads: ReturnType<typeof vi.fn>; writes: ReturnType<typeof vi.fn> } {
    const reads = vi.fn(async () => (credential === undefined
      ? null
      : { entry: { id: 'a1', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_A' }, credential }))
    const writes = vi.fn(async () => undefined)
    return {
      pool: { getAvailableAccount: reads, updateAccount: writes, listAccounts: vi.fn(async () => []) } as never,
      reads,
      writes,
    }
  }

  it('默认先取 CLI 目录，再以隔离 app tuple 探测 HungerG；池保持只读', async () => {
    const { ctx } = makeCtx()
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const identity = new Headers(init?.headers).get('cosy-clienttype')
      return identity === '10' ? okResponse(remoteAppBody) : okResponse()
    }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const { pool, writes } = fakePool(JSON.parse(credWithUid) as unknown)
    const models = await auth.fetchModels(pool)
    expect(models.map((m) => m.id)).toEqual(['dfmodel', 'mmodel', 'hmodel'])
    expect(models[0]?.priceFactor).toBe(0)
    expect(models[0]?.isFree).toBe(true)
    expect(models[1]?.name).toBe('MiniMax-M3.1-Flash')
    expect(models[2]).toMatchObject({ name: 'HungerG', isFree: true, priceFactor: 0, requiresAppIdentity: true })
    const calls = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[0]).toContain('/api/v2/model/list?Encode=1')
    expect(new Headers(calls[0]?.[1].headers).get('cosy-clienttype')).toBe('5')
    expect(new Headers(calls[1]?.[1].headers).get('cosy-clienttype')).toBe('10')
    expect(new Headers(calls[0]?.[1].headers).get('cosy-version')).toBe('1.1.79')
    // ⚠️ 池必须**只读**：这条路径不得写任何账号字段（否则会污染额度/限流账）。
    expect(writes).not.toHaveBeenCalled()
  })

  it('app 目录探测失败时，CLI 标准模型仍可用', async () => {
    const { ctx } = makeCtx()
    const warn = vi.fn()
    ;(ctx as unknown as { logger: unknown }).logger = { warn, info: vi.fn(), error: vi.fn() }
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const identity = new Headers(init?.headers).get('cosy-clienttype')
      return identity === '10'
        ? new Response(JSON.stringify({ code: '101', message: 'Signature invalid' }), { status: 403 })
        : okResponse()
    }) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const models = await auth.fetchModels(fakePool(JSON.parse(credWithUid) as unknown).pool)
    expect(models.map((m) => m.id)).toEqual(['dfmodel', 'mmodel'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('app-only catalog probe failed')
  })

  it('池里没有可用账号 ⇒ 回退本实例默认 ref 的凭据', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credWithUid]])
    const fetcher = vi.fn(async () => okResponse()) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const models = await auth.fetchModels(fakePool(undefined).pool)
    expect(models).toHaveLength(2)
  })

  it('既没有池账号也没有默认凭据 ⇒ 返回空数组，且**不打日志**（未登录是常态）', async () => {
    const { ctx } = makeCtx()
    const warn = vi.fn()
    ;(ctx as unknown as { logger: unknown }).logger = { warn, info: vi.fn(), error: vi.fn() }
    const fetcher = vi.fn()
    const auth = newService(ctx, fetcher as unknown as typeof fetch)
    expect(await auth.fetchModels(fakePool(undefined).pool)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('HTTP 失败 ⇒ 返回空数组（调用方回退兜底表）并**留一条 warn**', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credWithUid]])
    const warn = vi.fn()
    ;(ctx as unknown as { logger: unknown }).logger = { warn, info: vi.fn(), error: vi.fn() }
    const fetcher = (async () => new Response(
      JSON.stringify({ code: '105', message: 'Login expired' }), { status: 403 },
    )) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    expect(await auth.fetchModels()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.map(call => String(call[0])).join('\n')).toContain('Login expired')
  })

  it('⚠️ 池**读失败**（reject）⇒ 返回空数组、不抛穿（失败不升级成 provider 报错）', async () => {
    // 对抗审计实测：删掉那一行 `.catch(() => null)` 时 111 条用例**全绿** ⇒
    // 「池读 reject 不炸」这条腿当时零守卫；且原实现的 `await` 在 `try` **之外**，
    // rejection 会直接抛穿 fetchModels，绕开「失败即回退兜底表」的契约。
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credWithUid]])
    const warn = vi.fn()
    ;(ctx as unknown as { logger: unknown }).logger = { warn, info: vi.fn(), error: vi.fn() }
    const fetcher = vi.fn(async () => okResponse()) as unknown as typeof fetch
    const auth = newService(ctx, fetcher)
    const brokenPool = {
      getAvailableAccount: vi.fn(async () => { throw new Error('pool store corrupted') }),
      updateAccount: vi.fn(),
      listAccounts: vi.fn(async () => []),
    } as never
    // 池坏了但**默认 ref 有凭据** ⇒ 仍应正常出目录（这是"池读失败不致命"的正解）。
    const models = await auth.fetchModels(brokenPool)
    expect(models.map((m) => m.id)).toEqual(['dfmodel', 'mmodel'])
    // 池坏 + 连默认 ref 也没有 ⇒ 返回 []（而不是把 rejection 抛给调用方）。
    const { ctx: ctx2 } = makeCtx()
    const auth2 = newService(ctx2, fetcher)
    await expect(auth2.fetchModels(brokenPool)).resolves.toEqual([])
  })

  it('⚠️ 凭据缺 uid 时**不发请求**（签名必然无效），返回空数组并留痕', async () => {
    const { ctx } = makeCtx([['QODER_ACCESS_TOKEN', credJson]])
    const warn = vi.fn()
    ;(ctx as unknown as { logger: unknown }).logger = { warn, info: vi.fn(), error: vi.fn() }
    const fetcher = vi.fn()
    const auth = newService(ctx, fetcher as unknown as typeof fetch)
    expect(await auth.fetchModels()).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('uid')
  })
})
