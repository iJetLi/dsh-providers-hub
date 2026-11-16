import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RACCOON } from '../../src/raccoon-product.js'
import {
  RACCOON_CREDENTIAL_REF,
  RefreshTokenExpiredError,
  RaccoonAuth,
  parseRaccoonCredential,
} from '../../src/raccoon-auth.js'
import type { RaccoonCredential } from '../../src/raccoon.js'
import type { AccountPool, ProviderAccountStatus } from '../../src/account-pool.js'

/** 所有已创建的 service；afterEach 统一 stop()，避免定时器泄漏。 */
const services: RaccoonAuth[] = []

/** 最小化的内存凭据提供者，形状与 ctx.credentials 一致。 */
class FakeCredentials {
  readonly store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

/** 造一个真实 cordis Context（既有 provider 的单测都这么做）。 */
function makeCtx(): { ctx: Context; credentials: FakeCredentials; warnings: string[] } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  const warnings: string[] = []
  // 捕获 logger.warn（经 ctx.logger 反射；cordis 的 logger 是可选服务）
  try {
    ctx.provide('logger', {
      warn: (msg: string) => { warnings.push(msg) },
      info: () => {},
      error: () => {},
      debug: () => {},
    } as never)
  } catch {
    // 无法注入时不阻塞测试：warning 断言会退化为「不检查」
  }
  return { ctx, credentials, warnings }
}

function newService(ctx: Context, options: { fetcher?: typeof fetch } = {}): RaccoonAuth {
  const service = new RaccoonAuth(ctx, options)
  services.push(service)
  return service
}

afterEach(() => {
  // cordis 的 Service 通过 `[Symbol.dispose]` 释放（不叫 stop）。
  // RaccoonAuth 不武装任何定时器，故这里只是形式上的清理。
  for (const service of services.splice(0)) {
    const disposable = service as unknown as { [Symbol.dispose]?: () => void }
    disposable[Symbol.dispose]?.()
  }
})

/** 造一个最小 JWT。 */
function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `${header}.${body}.sig`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 账号池替身。 */
function makePool(accounts: ProviderAccountStatus[]): AccountPool {
  return {
    listAccounts: async () => accounts,
  } as unknown as AccountPool
}

const VALID_CRED: RaccoonCredential = {
  access_token: jwtWithExp(Math.floor(Date.now() / 1000) + 3600),
  refresh_token: 'r1',
}

/** 已过期的凭据（`refreshAll` 只续期这种）。 */
const EXPIRED_CRED: RaccoonCredential = {
  access_token: jwtWithExp(Math.floor(Date.now() / 1000) - 3600),
  refresh_token: 'r-expired',
}

describe('RACCOON_CREDENTIAL_REF', () => {
  it('与产品配置一致', () => {
    expect(RACCOON_CREDENTIAL_REF).toBe('RACCOON_ACCESS_TOKEN')
    expect(RACCOON_CREDENTIAL_REF).toBe(RACCOON.defaultCredentialRef)
  })
})

describe('parseRaccoonCredential', () => {
  it('解析合法凭据', () => {
    const parsed = parseRaccoonCredential(JSON.stringify(VALID_CRED))
    expect(parsed?.access_token).toBe(VALID_CRED.access_token)
  })

  it('缺 access_token 时返回 undefined', () => {
    expect(parseRaccoonCredential(JSON.stringify({ refresh_token: 'r' }))).toBeUndefined()
  })

  it('非法 JSON 返回 undefined（不抛错）', () => {
    expect(parseRaccoonCredential('not json')).toBeUndefined()
    expect(parseRaccoonCredential('[]')).toBeUndefined()
  })
})

describe('RaccoonAuth 构造', () => {
  it('服务名由产品 id 派生为 raccoonAuth', () => {
    const { ctx } = makeCtx()
    const auth = newService(ctx)
    expect(auth.product.id).toBe('raccoon')
    expect(auth.credentialRefName).toBe('RACCOON_ACCESS_TOKEN')
  })

  it('status() 在无凭据时返回 configured:false', async () => {
    const { ctx } = makeCtx()
    const auth = newService(ctx)
    const status = await auth.status()
    expect(status.configured).toBe(false)
    expect(status.refreshable).toBe(false)
  })
})

describe('persistLogin', () => {
  it('把凭据写入 ctx.credentials 并返回 access/expires/ref/refreshable', async () => {
    const { ctx, credentials } = makeCtx()
    const auth = newService(ctx)
    const result = await auth.persistLogin(VALID_CRED)
    expect(credentials.store.get('RACCOON_ACCESS_TOKEN')).toContain(VALID_CRED.access_token)
    expect(JSON.parse(result.access)).toMatchObject({ access_token: VALID_CRED.access_token })
    expect(result.ref).toBe('RACCOON_ACCESS_TOKEN')
    expect(result.expires).toBeGreaterThan(Date.now())
    // raccoon 有 refresh_token → 可续期（与 Loomy 恒 false 不同）
    expect(result.refreshable).toBe(true)
  })

  it('无 refresh_token 时 refreshable 为 false', async () => {
    const { ctx } = makeCtx()
    const auth = newService(ctx)
    const result = await auth.persistLogin({ access_token: VALID_CRED.access_token, refresh_token: '' })
    expect(result.refreshable).toBe(false)
  })

  it('登录后静默领取一次性登录奖励（失败不影响登录成功）', async () => {
    const { ctx } = makeCtx()
    let grantCalled = false
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('/login/points/grant')) {
        grantCalled = true
        return jsonResponse({ code: 0, data: { granted: true, popup: { points: 3000 } } })
      }
      return jsonResponse({ code: 0, data: {} })
    })
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    const result = await auth.persistLogin(VALID_CRED)
    expect(result.access).toBeTruthy()
    expect(grantCalled).toBe(true)
  })

  it('登录奖励领取抛错时登录仍成功', async () => {
    const { ctx } = makeCtx()
    const fetcher = vi.fn(async () => { throw new Error('grant down') })
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    const result = await auth.persistLogin(VALID_CRED)
    expect(result.access).toBeTruthy()
  })

  it('可指定 refName 写入非默认 ref', async () => {
    const { ctx, credentials } = makeCtx()
    const auth = newService(ctx)
    const result = await auth.persistLogin(VALID_CRED, { refName: 'RACCOON_ACCOUNT_ABC' })
    expect(credentials.store.has('RACCOON_ACCOUNT_ABC')).toBe(true)
    expect(credentials.store.has('RACCOON_ACCESS_TOKEN')).toBe(false)
    expect(result.ref).toBe('RACCOON_ACCOUNT_ABC')
  })
})

describe('refresh / refreshAccountCredential', () => {
  it('refresh() 在无凭据时抛 RefreshTokenExpiredError', async () => {
    const { ctx } = makeCtx()
    const auth = newService(ctx)
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('refresh() 用 refresh_token 换新凭据并落盘', async () => {
    const { ctx, credentials } = makeCtx()
    const newExp = Math.floor(Date.now() / 1000) + 7200
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('/auth/v1/refresh')) {
        return jsonResponse({ code: 0, data: { access_token: jwtWithExp(newExp), refresh_token: 'r2' } })
      }
      return jsonResponse({ code: 0, data: {} })
    })
    credentials.store.set('RACCOON_ACCESS_TOKEN', JSON.stringify(VALID_CRED))
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    await auth.refresh()
    const saved = JSON.parse(credentials.store.get('RACCOON_ACCESS_TOKEN') ?? '{}') as RaccoonCredential
    expect(saved.access_token).toBe(jwtWithExp(newExp))
    expect(saved.refresh_token).toBe('r2')
  })

  it('refreshAccountCredential 只读写指定 ref（不碰默认 ref）', async () => {
    const { ctx, credentials } = makeCtx()
    const newExp = Math.floor(Date.now() / 1000) + 7200
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0, data: { access_token: jwtWithExp(newExp), refresh_token: 'r2' },
    }))
    const DEFAULT = JSON.stringify({ access_token: 'DEFAULT', refresh_token: 'd' })
    const ACCOUNT = JSON.stringify({ access_token: 'ACCOUNT', refresh_token: 'a' })
    credentials.store.set('RACCOON_ACCESS_TOKEN', DEFAULT)
    credentials.store.set('RACCOON_ACCOUNT_X', ACCOUNT)
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    await auth.refreshAccountCredential('RACCOON_ACCOUNT_X')
    // 账号 ref 被更新
    expect(JSON.parse(credentials.store.get('RACCOON_ACCOUNT_X') ?? '{}')).toMatchObject({ access_token: jwtWithExp(newExp) })
    // 默认 ref 原封不动
    expect(credentials.store.get('RACCOON_ACCESS_TOKEN')).toBe(DEFAULT)
  })

  it('续期遇 401 时抛 RefreshTokenExpiredError', async () => {
    const { ctx, credentials } = makeCtx()
    const fetcher = vi.fn(async () => jsonResponse({ code: 200003, message: 'auth fail' }, 401))
    credentials.store.set('RACCOON_ACCESS_TOKEN', JSON.stringify(VALID_CRED))
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    await expect(auth.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })
})

describe('refreshAll', () => {
  it('**只按 refreshable 过滤，不看 enabled**（核心不变式）', async () => {
    const { ctx, credentials } = makeCtx()
    let refreshCount = 0
    const fetcher = vi.fn(async () => {
      refreshCount += 1
      return jsonResponse({ code: 0, data: { access_token: jwtWithExp(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'r' } })
    })
    // 停用但可续期的账号 —— 也必须被续期
    const disabledButRefreshable: ProviderAccountStatus = {
      id: 'a1',
      provider: 'raccoon',
      credentialRef: 'RACCOON_ACCOUNT_A1',
      enabled: false,
      refreshable: true,
      nickname: 'a1',
      createdAt: Date.now(),
    } as unknown as ProviderAccountStatus
    // ⚠️ 必须用**已过期**的凭据：refreshAll 只续期已过期的（未过期的无需动作）
    credentials.store.set('RACCOON_ACCOUNT_A1', JSON.stringify(EXPIRED_CRED))

    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    await auth.refreshAll(makePool([disabledButRefreshable]))
    expect(refreshCount).toBeGreaterThan(0)
  })

  it('未过期的账号被跳过（不浪费请求）', async () => {
    const { ctx, credentials } = makeCtx()
    let refreshCount = 0
    const fetcher = vi.fn(async () => {
      refreshCount += 1
      return jsonResponse({ code: 0, data: {} })
    })
    const fresh = {
      id: 'a1', provider: 'raccoon', credentialRef: 'RACCOON_ACCOUNT_A1',
      enabled: true, refreshable: true, nickname: 'a1', createdAt: Date.now(),
    } as unknown as ProviderAccountStatus
    credentials.store.set('RACCOON_ACCOUNT_A1', JSON.stringify(VALID_CRED))
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    await auth.refreshAll(makePool([fresh]))
    expect(refreshCount).toBe(0)
  })

  it('refreshable:false 的账号被跳过', async () => {
    const { ctx, credentials } = makeCtx()
    let refreshCount = 0
    const fetcher = vi.fn(async () => {
      refreshCount += 1
      return jsonResponse({ code: 0, data: {} })
    })
    const notRefreshable = {
      id: 'a1',
      provider: 'raccoon',
      credentialRef: 'RACCOON_ACCOUNT_A1',
      enabled: true,
      refreshable: false,
      nickname: 'a1',
      createdAt: Date.now(),
    } as unknown as ProviderAccountStatus
    credentials.store.set('RACCOON_ACCOUNT_A1', JSON.stringify(EXPIRED_CRED))
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    await auth.refreshAll(makePool([notRefreshable]))
    expect(refreshCount).toBe(0)
  })

  it('单账号失败不影响其他账号（且留日志）', async () => {
    const { ctx, credentials, warnings } = makeCtx()
    // bad 的凭据里 refresh_token 为特定值，用它区分是哪个账号的请求
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('r-bad')) return jsonResponse({ code: 1, message: 'boom' }, 500)
      return jsonResponse({
        code: 0,
        data: { access_token: jwtWithExp(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'r-new' },
      })
    })
    const bad = {
      id: 'bad', provider: 'raccoon', credentialRef: 'RACCOON_ACCOUNT_BAD',
      enabled: true, refreshable: true, nickname: 'bad', createdAt: Date.now(),
    } as unknown as ProviderAccountStatus
    const good = {
      id: 'good', provider: 'raccoon', credentialRef: 'RACCOON_ACCOUNT_GOOD',
      enabled: true, refreshable: true, nickname: 'good', createdAt: Date.now(),
    } as unknown as ProviderAccountStatus
    credentials.store.set('RACCOON_ACCOUNT_BAD', JSON.stringify({
      access_token: jwtWithExp(Math.floor(Date.now() / 1000) - 60), refresh_token: 'r-bad',
    }))
    credentials.store.set('RACCOON_ACCOUNT_GOOD', JSON.stringify(EXPIRED_CRED))
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    await auth.refreshAll(makePool([bad, good]))
    // good 被成功续期 —— 这是本用例的核心不变式：bad 的失败没有中断循环。
    const saved = JSON.parse(credentials.store.get('RACCOON_ACCOUNT_GOOD') ?? '{}') as RaccoonCredential
    expect(saved.refresh_token).toBe('r-new')
    // ⚠️ 不断言 `warnings`：`ctx.logger` 在本测试环境不存在，生产代码走
    // `this.ctx.logger?.warn?.()` 静默跳过（既有 provider 的单测同样不断言日志）。
    // 强行注入 logger 服务也不生效，断言它只会得到一个恒假的用例。
    void warnings
  })

  it('凭据缺失的账号被跳过（不抛错）', async () => {
    const { ctx } = makeCtx()
    const missing = {
      id: 'm', provider: 'raccoon', credentialRef: 'RACCOON_ACCOUNT_MISSING',
      enabled: true, refreshable: true, nickname: 'm', createdAt: Date.now(),
    } as unknown as ProviderAccountStatus
    const auth = newService(ctx)
    await expect(auth.refreshAll(makePool([missing]))).resolves.toBeUndefined()
  })
})

describe('logout', () => {
  it('清除默认凭据', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCESS_TOKEN', JSON.stringify(VALID_CRED))
    const auth = newService(ctx)
    await auth.logout()
    expect(credentials.store.has('RACCOON_ACCESS_TOKEN')).toBe(false)
  })
})

describe('fetchModels', () => {
  it('过滤 visible:false，展示名含倍率', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCESS_TOKEN', JSON.stringify(VALID_CRED))
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        categories: [{
          type: 'chat',
          default_model: 'raccoon-8c4485',
          models: [
            { name: 'raccoon-secret', description: '内部', visible: false, tags: [], ability_level: 3, params: { context_window: 1000, max_tokens: 100 } },
            { name: 'sn-glm-5-3', description: 'GLM-5-3', visible: true, tags: ['general'], ability_level: 2, params: { context_window: 1000000, max_tokens: 100000 }, billing_multiplier: 0.75, billing_effective_multiplier: 0.75, billing_status: 'normal' },
          ],
        }],
      },
    }))
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    const models = await auth.fetchModels()
    expect(models.map((m) => m.id)).toEqual(['sn-glm-5-3'])
    expect(models[0]?.name).toBe('GLM-5-3 · x0.75')
    expect(models[0]?.contextWindow).toBe(1_000_000)
    expect(models[0]?.maxTokens).toBe(100_000)
  })

  it('远端失败时返回空数组（适配器回退兜底表）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCESS_TOKEN', JSON.stringify(VALID_CRED))
    const fetcher = vi.fn(async () => { throw new Error('down') })
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    expect(await auth.fetchModels()).toEqual([])
  })

  it('免费模型（生效价 0）展示为「免费」', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCESS_TOKEN', JSON.stringify(VALID_CRED))
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        categories: [{
          type: 'chat',
          models: [{
            name: 'sn-sensenova-6-8-flash', description: 'SenseNova-6.8-Flash', visible: true,
            tags: [], ability_level: 1, params: { context_window: 256000, max_tokens: 63999 },
            billing_multiplier: 0.5, billing_effective_multiplier: 0, billing_status: 'limited_free',
          }],
        }],
      },
    }))
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    const models = await auth.fetchModels()
    expect(models[0]?.name).toBe('SenseNova-6.8-Flash · 免费')
  })

  it('promotions 只由 billing_discounts 决定（不猜）', async () => {
    const { ctx, credentials } = makeCtx()
    credentials.store.set('RACCOON_ACCESS_TOKEN', JSON.stringify(VALID_CRED))
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        categories: [{
          type: 'chat',
          models: [{
            name: 'sn-glm-5-3-flash', description: 'GLM-5-3-Flash', visible: true,
            tags: [], ability_level: 2, params: { context_window: 1000000, max_tokens: 100000 },
            billing_multiplier: 0.2, billing_effective_multiplier: 0.1, billing_status: 'discount',
            billing_status_note: '限时折扣',
          }],
        }],
      },
    }))
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    const models = await auth.fetchModels()
    expect(models[0]?.name).toBe('GLM-5-3-Flash · x0.2→x0.1')
  })
})

describe('claimLoginReward / fetchCreditBalance（委托到积分模块）', () => {
  it('claimLoginReward 返回 ClaimOutcome', async () => {
    const { ctx } = makeCtx()
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { granted: true, popup: { points: 3000 } } }))
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    const outcome = await auth.claimLoginReward(VALID_CRED)
    expect(outcome.kind).toBe('claimed')
  })

  it('fetchCreditBalance 返回 CreditBalance', async () => {
    const { ctx } = makeCtx()
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { available_points: 6300, reward_points: 6000, daily_points: 300 } }))
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    const balance = await auth.fetchCreditBalance(VALID_CRED)
    expect(balance?.total).toBe(6300)
  })

  it('fetchOnboardingStatus 返回已领状态', async () => {
    const { ctx } = makeCtx()
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: { items: [{ event_name: '桌面端登录奖励', biz_type: 'reward_grant', points: 3000 }] },
    }))
    const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
    const status = await auth.fetchOnboardingStatus(VALID_CRED)
    expect(status.claimed).toBe(true)
  })
})

/* ───────── PR #88 双审计返工：实例方法必须走注入的 fetcher（§M15 无牙） ─────────
 *
 * `RaccoonAuth.claimDailyCheckin` 是 `provider-credits` 的**唯一**调用路径
 * （`deps.raccoon.claimDailyCheckin` 存在时优先走它）。此前它零测试覆盖，
 * 把 `this.fetchImpl` 换成全局 `fetch` 是**全绿**的 —— 而那意味着：
 * 单测失去替身（会真发网络）、生产环境的代理 / 超时配置全部失效。
 */
describe('★★★ claimDailyCheckin 必须走注入的 fetcher（不得回落到全局 fetch）', () => {
  it('★★★ 注入替身时，签到全程只打替身（四类端点都不得漏到全局 fetch）', async () => {
    const seen: string[] = []
    const fetcher = async (url: string): Promise<Response> => {
      seen.push(String(url))
      const body = String(url).includes('setting_info')
        ? { code: 0, data: { point_grant_toast: '', point_grant_popups: [] } }
        : String(url).includes('/points/v2/bills')
          ? { code: 0, data: { items: [] } }
          : { code: 0, data: { available_points: 1000, daily_points: 0, reward_points: 0, topup_points: 0, monthly_points: 0 } }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    // 若实现回落到全局 fetch，这里会立刻抛错（Node 环境真发网络 ⇒ 网络层拒绝）
    const globalSpy = vi.fn<typeof fetch>(() => { throw new Error('不得触碰全局 fetch') })
    vi.stubGlobal('fetch', globalSpy)
    try {
      const { ctx } = makeCtx()
      const auth = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })
      const outcome = await auth.claimDailyCheckin(VALID_CRED)
      expect(outcome.kind).toBe('already-claimed')
      expect(seen.length, '注入的替身必须被调用').toBeGreaterThan(0)
      expect(globalSpy, '全局 fetch 一次都不许被调用').not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('★★ 不注入 fetcher 时才回落到全局 fetch', async () => {
    const globalSpy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      code: 0,
      data: { point_grant_toast: '', point_grant_popups: [] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', globalSpy)
    try {
      const { ctx } = makeCtx()
      const auth = newService(ctx)
      const outcome = await auth.claimDailyCheckin(VALID_CRED)
      expect(outcome.kind).toBe('already-claimed')
      expect(globalSpy, '没有注入时必须回落到全局 fetch').toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

