/**
 * TRAE 认证服务单元测试。
 *
 * 覆盖 `src/trae-auth.ts` 的凭据生命周期：
 * - 状态查询（configured / expiry / refreshable）；
 * - ExchangeToken 续期（成功轮换、身份字段保留）；
 * - 终态判定（session-dead 抛 RefreshTokenExpiredError，网络抖动走可重试）；
 * - `refreshAccountCredential` 只动指定 ref（不得串到默认单凭据 ref）；
 * - `refreshAll` **包含已停用账号**（只按 refreshable 过滤，真实缺陷）；
 * - 登出竞态保护与调度停止。
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TRAE_CREDENTIAL_REF,
  RefreshTokenExpiredError,
  TraeAuth,
} from '../../src/trae-auth.js'
import { TRAE } from '../../src/trae-product.js'
import type { TraeCredential } from '../../src/trae.js'
import type { ProviderAccountStatus } from '../../src/types.js'

const services: TraeAuth[] = []

afterEach(() => {
  for (const s of services) s.stop()
  services.length = 0
  vi.clearAllMocks()
})

/** 最小化的内存凭据提供者。 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
  raw(ref: string): string | undefined { return this.store.get(ref) }
}

function makeContext(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

function newService(ctx: Context, options: { fetcher?: typeof fetch } = {}): TraeAuth {
  const service = new TraeAuth(ctx, options)
  services.push(service)
  return service
}

/**
 * 默认**距过期 50 分钟**的凭据。
 *
 * ⚠️ 不能默认给「2 小时后过期」：`refreshAll` 现在带 lead-time 过滤
 * （`src/expiry-sync.ts` 的 `shouldRefreshNow`，与单凭据时代 `REFRESH_LEAD_MS`
 * 同语义 —— 距过期超过 1 小时的账号本轮只与账号池对账、**不发续期请求**），
 * 而本文件的 `refreshAll` 用例问的正是「该刷的账号有没有被刷」。
 */
function makeCredential(overrides: Partial<TraeCredential> = {}): TraeCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 3_000_000),
    uid: 'uid-1',
    nickname: '测试账号',
    machine_id: 'a'.repeat(32),
    device_id: 'c'.repeat(32),
    ...overrides,
  }
}

/** ExchangeToken 成功响应（Go 端 PascalCase 形态）。 */
function exchangeSuccess(accessToken = 'AT2', refreshToken = 'RT2'): Response {
  return new Response(JSON.stringify({
    Result: {
      Token: accessToken,
      RefreshToken: refreshToken,
      TokenExpireAt: Date.now() + 7_200_000,
      TokenExpireDuration: 7200,
      RefreshExpireAt: Date.now() + 30 * 86_400_000,
    },
  }), { status: 200 })
}

/** 账号池替身。 */
function makePool(accounts: ProviderAccountStatus[]) {
  return {
    listAccounts: async (provider: string) => accounts.filter((a) => a.provider === provider),
    listAllAccounts: async () => accounts,
    updateAccount: vi.fn(async () => {}),
    getAvailableAccount: async () => null,
  }
}

function accountEntry(overrides: Partial<ProviderAccountStatus> = {}): ProviderAccountStatus {
  return {
    id: 'trae-1',
    provider: 'trae',
    nickname: '测试号',
    enabled: true,
    credentialRef: 'TRAE_ACCOUNT_AAAA1111',
    createdAt: 1,
    refreshable: true,
    ...overrides,
  }
}

describe('TRAE 认证服务基础', () => {
  it('服务名为 traeAuth，凭据 ref 为 TRAE_ACCESS_TOKEN', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(service.name).toBe('traeAuth')
    expect(service.product.id).toBe('trae')
    expect(service.credentialRefName).toBe(TRAE_CREDENTIAL_REF)
    expect(TRAE_CREDENTIAL_REF).toBe('TRAE_ACCESS_TOKEN')
  })

  it('未配置凭据时 status() 报告 configured: false', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(await service.status()).toEqual({ configured: false, refreshable: false })
  })

  it('已配置凭据时 status() 报告过期时间与可刷新性', async () => {
    const { ctx, credentials } = makeContext()
    const credential = makeCredential()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(credential))
    const service = newService(ctx)
    const status = await service.status()
    expect(status.configured).toBe(true)
    expect(status.refreshable).toBe(true)
    expect(status.expiresAt).toBeGreaterThan(Date.now())
  })

  it('无 refresh_token 时 status() 报告不可刷新', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential({ refresh_token: '' })))
    const service = newService(ctx)
    expect((await service.status()).refreshable).toBe(false)
  })
})

describe('TRAE 续期', () => {
  it('refresh 用 ExchangeToken 换新并回写凭据', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const fetcher = vi.fn(async () => exchangeSuccess())
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refresh()

    const stored = JSON.parse(credentials.raw('TRAE_ACCESS_TOKEN')!) as TraeCredential
    expect(stored.access_token).toBe('AT2')
    expect(stored.refresh_token).toBe('RT2')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('续期请求体含 ClientID / RefreshToken / ClientSecret / UserID', async () => {
    // 对齐 Go 端 refreshLocked 的 body 构造：ClientSecret 恒为 "-"、UserID 为空串。
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential({ refresh_token: 'RT-OLD' })))
    let captured: string | undefined
    const fetcher = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      captured = init?.body
      return exchangeSuccess()
    })
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refresh()

    expect(JSON.parse(captured!)).toEqual({
      ClientID: TRAE.clientId,
      RefreshToken: 'RT-OLD',
      ClientSecret: '-',
      UserID: '',
    })
  })

  it('续期后保留 machine_id / device_id / uid（关键契约）', async () => {
    // 重新生成机器指纹会让服务端按新设备处理，可能要求重新登录。
    const { ctx, credentials } = makeContext()
    const original = makeCredential({ uid: 'uid-keep', machine_id: 'b'.repeat(32), device_id: 'd'.repeat(32) })
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(original))
    const service = newService(ctx, { fetcher: (async () => exchangeSuccess()) as unknown as typeof fetch })

    await service.refresh()

    const stored = JSON.parse(credentials.raw('TRAE_ACCESS_TOKEN')!) as TraeCredential
    expect(stored.machine_id).toBe('b'.repeat(32))
    expect(stored.device_id).toBe('d'.repeat(32))
    expect(stored.uid).toBe('uid-keep')
  })

  it('HTTP 401 抛 RefreshTokenExpiredError（终态）并标记不可刷新', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: (async () => new Response('{"code":1001,"msg":"token invalid"}', { status: 401 })) as unknown as typeof fetch,
    })

    await expect(service.refresh()).rejects.toBeInstanceOf(RefreshTokenExpiredError)
    expect((await service.status()).refreshable).toBe(false)
    expect((await service.status()).refreshError).toContain('重新登录')
  })

  it('响应缺少 accessToken 时抛 RefreshTokenExpiredError', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: (async () => new Response(JSON.stringify({ Result: {} }), { status: 200 })) as unknown as typeof fetch,
    })
    await expect(service.refresh()).rejects.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('网络抖动抛普通 Error（不是终态，须可重试）', async () => {
    // 这是相对 Go 版的一处改进：Go 只判「响应里有没有 accessToken」，
    // 会把网络抖动也当成终态，导致一次瞬时故障就让用户重新登录。
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: (async () => { throw new Error('socket hang up') }) as unknown as typeof fetch,
    })

    const error = await service.refresh().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).message).toContain('网络失败')
  })

  it('5xx 响应抛普通 Error（可重试，不是终态）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: (async () => new Response('server error', { status: 503 })) as unknown as typeof fetch,
    })
    const error = await service.refresh().catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('无 refresh_token 时 refresh 直接抛 RefreshTokenExpiredError', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential({ refresh_token: '' })))
    const service = newService(ctx)
    await expect(service.refresh()).rejects.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('未配置凭据时 refresh 报「请先登录」', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    await expect(service.refresh()).rejects.toThrow(/未配置凭据/)
  })
})

describe('refreshAccountCredential（按 ref 续期指定账号）', () => {
  it('写回传入的那个 ref，不串到默认单凭据 ref', async () => {
    // 与 LobsterAI 同因：refresh() 读写默认 ref（TRAE_ACCESS_TOKEN），
    // 而账号卡片对应 TRAE_ACCOUNT_XXX，用 refresh() 会刷错对象。
    const { ctx, credentials } = makeContext()
    const poolRef = 'TRAE_ACCOUNT_POOL1'
    await credentials.set(poolRef, JSON.stringify(makeCredential({ access_token: 'OLD' })))
    const service = newService(ctx, { fetcher: (async () => exchangeSuccess('NEW')) as unknown as typeof fetch })

    await service.refreshAccountCredential(poolRef)

    expect((JSON.parse(credentials.raw(poolRef)!) as TraeCredential).access_token).toBe('NEW')
    // 默认 ref 完全不应被触碰。
    expect(credentials.raw('TRAE_ACCESS_TOKEN')).toBeUndefined()
  })

  it('不污染 refreshTokenInvalid / lastRefreshError（那属于单凭据路径）', async () => {
    const { ctx, credentials } = makeContext()
    const poolRef = 'TRAE_ACCOUNT_POOL2'
    await credentials.set(poolRef, JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      // 401 + 非 JSON 响应体（凭据失效时网关返回 HTML 错误页的真实形态）。
      fetcher: (async () => new Response('<html>Unauthorized</html>', { status: 401 })) as unknown as typeof fetch,
    })

    await expect(service.refreshAccountCredential(poolRef)).rejects.toBeInstanceOf(RefreshTokenExpiredError)
    // status() 读默认 ref（未配置），不应因账号池操作而出现失效提示。
    const status = await service.status()
    expect(status.configured).toBe(false)
    expect(status.refreshError).toBeUndefined()
  })
})

describe('refreshAll 批量续期', () => {
  it('包含已停用账号（只按 refreshable 过滤）', async () => {
    // 真实缺陷教训：早期按 enabled 过滤，停用期间 refresh_token 放到失效，
    // 用户重新启用后只能重新登录。停用只应影响账号池的自动选号。
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCOUNT_DISABLED', JSON.stringify(makeCredential({ access_token: 'D-OLD' })))
    await credentials.set('TRAE_ACCOUNT_ENABLED', JSON.stringify(makeCredential({ access_token: 'E-OLD' })))
    const pool = makePool([
      accountEntry({ id: 'trae-disabled', credentialRef: 'TRAE_ACCOUNT_DISABLED', enabled: false }),
      accountEntry({ id: 'trae-enabled', credentialRef: 'TRAE_ACCOUNT_ENABLED', enabled: true }),
    ])
    const service = newService(ctx, { fetcher: (async () => exchangeSuccess('FRESH')) as unknown as typeof fetch })

    await service.refreshAll(pool as never)

    // 两个账号都必须被续期。
    expect((JSON.parse(credentials.raw('TRAE_ACCOUNT_DISABLED')!) as TraeCredential).access_token).toBe('FRESH')
    expect((JSON.parse(credentials.raw('TRAE_ACCOUNT_ENABLED')!) as TraeCredential).access_token).toBe('FRESH')
  })

  it('跳过 refreshable 为 false 的账号', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCOUNT_NOTREFRESH', JSON.stringify(makeCredential()))
    const pool = makePool([
      accountEntry({ id: 'trae-x', credentialRef: 'TRAE_ACCOUNT_NOTREFRESH', refreshable: false }),
    ])
    const fetcher = vi.fn(async () => exchangeSuccess())
    const service = newService(ctx, { fetcher: fetcher as unknown as typeof fetch })

    await service.refreshAll(pool as never)

    expect(fetcher).not.toHaveBeenCalled()
  })

  it('单账号失败不中断其余账号', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCOUNT_BAD', JSON.stringify(makeCredential({ access_token: 'BAD-OLD' })))
    await credentials.set('TRAE_ACCOUNT_GOOD', JSON.stringify(makeCredential({ access_token: 'GOOD-OLD' })))
    const pool = makePool([
      accountEntry({ id: 'bad', credentialRef: 'TRAE_ACCOUNT_BAD' }),
      accountEntry({ id: 'good', credentialRef: 'TRAE_ACCOUNT_GOOD' }),
    ])
    let fetchedCount = 0
    const service = newService(ctx, {
      fetcher: (async () => {
        // 第一个账号永远 500，第二个正常。
        return fetchedCount++ === 0
          ? new Response('err', { status: 500 })
          : exchangeSuccess('OK')
      }) as unknown as typeof fetch,
    })

    await service.refreshAll(pool as never)

    // 第二个账号仍被成功续期。
    expect((JSON.parse(credentials.raw('TRAE_ACCOUNT_GOOD')!) as TraeCredential).access_token).toBe('OK')
  })

  it('终态失败把账号标记为不可续期', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCOUNT_DEAD', JSON.stringify(makeCredential()))
    const pool = makePool([accountEntry({ id: 'dead', credentialRef: 'TRAE_ACCOUNT_DEAD' })])
    const service = newService(ctx, {
      fetcher: (async () => new Response('{"code":1001}', { status: 401 })) as unknown as typeof fetch,
    })

    await service.refreshAll(pool as never)

    expect(pool.updateAccount).toHaveBeenCalledWith('dead', { refreshable: false })
  })

  it('只续期本 provider 的账号（不碰其它 provider）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCOUNT_1', JSON.stringify(makeCredential()))
    await credentials.set('BUDDY_ACCOUNT_1', JSON.stringify(makeCredential()))
    const pool = makePool([
      accountEntry({ id: 'trae-1', credentialRef: 'TRAE_ACCOUNT_1' }),
      accountEntry({ id: 'buddy-1', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_1' }),
    ])
    const service = newService(ctx, { fetcher: (async () => exchangeSuccess('T-OK')) as unknown as typeof fetch })

    await service.refreshAll(pool as never)

    expect((JSON.parse(credentials.raw('TRAE_ACCOUNT_1')!) as TraeCredential).access_token).toBe('T-OK')
    // CodeBuddy 的凭据保持原样。
    expect((JSON.parse(credentials.raw('BUDDY_ACCOUNT_1')!) as TraeCredential).access_token).toBe('AT')
  })
})

describe('登出与调度', () => {
  it('logout 清除默认凭据', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx)
    await service.logout()
    expect(credentials.raw('TRAE_ACCESS_TOKEN')).toBeUndefined()
  })

  it('stop 不清理凭据（只停调度）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx)
    service.stop()
    expect(credentials.raw('TRAE_ACCESS_TOKEN')).toBeDefined()
  })

  it('logout 后落定的在途刷新不得回写（登出竞态保护）', async () => {
    // 在途刷新期间已 logout 时，回写会让已登出的凭据复活。
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    let releaseExchange: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseExchange = resolve })
    const service = newService(ctx, {
      fetcher: (async () => { await gate; return exchangeSuccess('LATE') }) as unknown as typeof fetch,
    })

    const refreshPromise = service.refresh()
    await service.logout()
    releaseExchange!()
    await refreshPromise.catch(() => {})

    // 凭据必须保持已删除状态。
    expect(credentials.raw('TRAE_ACCESS_TOKEN')).toBeUndefined()
  })

  it('checkExpired 在无凭据时返回 true', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(await service.checkExpired()).toBe(true)
  })

  it('checkExpired 对未过期凭据返回 false', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx)
    expect(await service.checkExpired()).toBe(false)
  })
})

/**
 * `fetchModels` 的日志与缓存行为。
 *
 * 两个**真实用户报障**：
 *
 * 1. 「没有账号不需要显示 `no credential resolved from store`」—— 未登录时
 *    每次列模型都会走到无凭据分支，早期用 `console.warn` 打日志，成了纯噪声。
 * 2. 「fetch 的 log 似乎太多了」—— 成功路径也打了 `calling …` / `got N models`，
 *    而该方法在冷启动阶段会被 `listModels` / `resolveModel` 反复触发
 *    （适配器的 `ensureRemoteModels` **只缓存非空结果**），于是同一行刷屏。
 */
describe('fetchModels 的日志与缓存', () => {
  /** 记录 fetcher 调用次数，并挂一个 logger 替身。 */
  function instrument(): {
    ctx: Context
    credentials: FakeCredentials
    fetcher: typeof fetch
    calls: () => number
    warn: ReturnType<typeof vi.fn>
  } {
    const { ctx, credentials } = makeContext()
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response(JSON.stringify({ function_configs: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const warn = vi.fn()
    ;(ctx as unknown as { logger: unknown }).logger = { warn, info: vi.fn(), error: vi.fn() }
    return { ctx, credentials, fetcher, calls: () => calls, warn }
  }

  it('未登录时不打日志，且反复调用都返回空（不再刷屏）', async () => {
    const { ctx, fetcher, warn } = instrument()
    const service = newService(ctx, { fetcher })
    // 模拟冷启动期被反复触发。
    for (let i = 0; i < 5; i++) expect(await service.fetchModels()).toEqual([])
    expect(warn, '未登录不是异常，不应打任何日志').not.toHaveBeenCalled()
  })

  it('成功路径不打日志（calling / got N models 已移除）', async () => {
    const { ctx, credentials, fetcher, warn, calls } = instrument()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, { fetcher })
    await service.fetchModels()
    expect(calls(), '应真的发了一次请求').toBe(1)
    expect(warn, '成功路径不应打日志').not.toHaveBeenCalled()
  })

  it('空结果也进缓存：第二次调用不再发请求（根治日志刷屏的根因）', async () => {
    const { ctx, credentials, fetcher, calls } = instrument()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, { fetcher })
    await service.fetchModels()
    await service.fetchModels()
    await service.fetchModels()
    // 适配器不缓存空结果，若这里也不缓存就会每次都打真实请求。
    expect(calls(), '空结果应被缓存，只发一次请求').toBe(1)
  })

  it('未登录时根本不发网络请求', async () => {
    const { ctx, fetcher, calls } = instrument()
    const service = newService(ctx, { fetcher })
    await service.fetchModels()
    await service.fetchModels()
    expect(calls(), '无凭据不应发网络请求').toBe(0)
  })

  it('登出后作废缓存：不会带着旧凭据继续返回缓存结果', async () => {
    const { ctx, credentials, fetcher, calls } = instrument()
    await credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, { fetcher })
    await service.fetchModels()
    expect(calls()).toBe(1)
    // 缓存期内再取：不发请求。
    await service.fetchModels()
    expect(calls()).toBe(1)
    await service.logout()
    await service.fetchModels()
    // 凭据已清除 → 不发请求（证明缓存确实作废、走了真实的无凭据分支）。
    expect(calls(), '登出后不应带着旧凭据发请求').toBe(1)
  })
})

/**
 * 老账号昵称回填。
 *
 * 真实缺陷（用户报障 2026-09-27）：「用 trae provider 登录后用户名字显示无法
 * 区分各个用户」。服务端 ScreenName 是按 uid 自动生成的默认名，而
 * `GetUserInfo` 的 `NonPlainTextMobile`（脱敏手机号）可区分。
 * 光改代码只影响新登录的账号，故启动时要主动补一次。
 */
describe('repairAccountNicknames 老账号回填', () => {
  /** GetUserInfo 响应（含脱敏手机号）。 */
  function userInfoResponse(phone: string, email = ''): Response {
    return new Response(JSON.stringify({
      Result: {
        UserID: 'uid-1',
        ScreenName: '用户26815487395',
        TenantID: '7n',
        NonPlainTextMobile: phone,
        NonPlainTextEmail: email,
      },
    }), { status: 200 })
  }

  it('把 ScreenName 昵称改成脱敏手机号，并把手机号写回凭据', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCOUNT_AAAA1111', JSON.stringify(makeCredential()))
    const fetcher = (async () => userInfoResponse('138******00')) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })
    const pool = makePool([accountEntry({ nickname: '用户26815487395' })])

    const repaired = await service.repairAccountNicknames(pool as never)

    expect(repaired).toEqual(['trae-1'])
    expect(pool.updateAccount).toHaveBeenCalledWith('trae-1', { nickname: '138******00' })
    // 手机号必须写回**凭据**：账号条目会随账号操作整体重写，凭据里存一份才稳。
    expect(JSON.parse(credentials.raw('TRAE_ACCOUNT_AAAA1111')!).phone).toBe('138******00')
  })

  it('凭据已有手机号时不再发 GetUserInfo 请求（幂等，不重复补）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(
      'TRAE_ACCOUNT_AAAA1111',
      JSON.stringify(makeCredential({ phone: '138******00' })),
    )
    let calls = 0
    const fetcher = (async () => { calls++; return userInfoResponse('138******00') }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })
    // 昵称已是手机号 → 不应触发任何写入。
    const pool = makePool([accountEntry({ nickname: '138******00' })])

    const repaired = await service.repairAccountNicknames(pool as never)

    expect(repaired).toEqual([])
    expect(calls, '凭据已有手机号时不应再请求').toBe(0)
    expect(pool.updateAccount).not.toHaveBeenCalled()
  })

  it('GetUserInfo 失败时保留 ScreenName（不写坏昵称、不抛错）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCOUNT_AAAA1111', JSON.stringify(makeCredential()))
    const fetcher = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })
    const pool = makePool([accountEntry({ nickname: '用户26815487395' })])

    const repaired = await service.repairAccountNicknames(pool as never)

    // 拿不到手机号 → 昵称不变（不是写回空值或账号 id）。
    expect(repaired).toEqual([])
    expect(pool.updateAccount).not.toHaveBeenCalled()
  })

  it('单账号失败不中断其余账号', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCOUNT_AAAA1111', JSON.stringify(makeCredential()))
    await credentials.set('TRAE_ACCOUNT_BBBB2222', JSON.stringify(makeCredential({ uid: 'uid-2' })))
    let failedOnce = false
    const fetcher = (async (url: string | URL) => {
      // 第一个账号的请求失败，第二个成功。
      if (String(url).includes('GetUserInfo') && !failedOnce) { failedOnce = true; throw new Error('boom') }
      return userInfoResponse('138******00')
    }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })
    const pool = makePool([
      accountEntry({ id: 'trae-1', credentialRef: 'TRAE_ACCOUNT_AAAA1111', nickname: '用户A' }),
      accountEntry({ id: 'trae-2', credentialRef: 'TRAE_ACCOUNT_BBBB2222', nickname: '用户B' }),
    ])

    const repaired = await service.repairAccountNicknames(pool as never)

    expect(repaired, '第二个账号仍应被修复').toEqual(['trae-2'])
  })

  it('凭据缺失的账号被跳过（不留幽灵昵称）', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    const pool = makePool([accountEntry({ credentialRef: 'TRAE_ACCOUNT_MISSING' })])

    expect(await service.repairAccountNicknames(pool as never)).toEqual([])
    expect(pool.updateAccount).not.toHaveBeenCalled()
  })

  it('手机号与邮箱都没有时保留原昵称（不用服务端默认名覆盖用户改过的昵称）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_ACCOUNT_AAAA1111', JSON.stringify(makeCredential()))
    const fetcher = (async () => userInfoResponse('', '')) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })
    // 用户在 Jet Hub 手动改过的昵称。
    const pool = makePool([accountEntry({ nickname: '我的主力号' })])

    const repaired = await service.repairAccountNicknames(pool as never)

    expect(repaired, '没有可用的真实标识就不该改写昵称').toEqual([])
    expect(pool.updateAccount).not.toHaveBeenCalled()
  })
})
