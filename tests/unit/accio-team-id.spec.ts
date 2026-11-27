/**
 * ★★★ **accio 团队空间身份**（2026-11-27，GitHub issue #177）。
 *
 * ## 报障
 *
 * 用户处于官方客户端的**团队空间**（「团队订阅 0 / 8000 积分」），
 * 但 Jet Hub 面板只看到 **520**（个人空间的三桶），**也用不了那 8000**。
 *
 * ## 根因（issue 作者逆向 `app.asar` + 本机实测）
 *
 * 官方客户端 `yo()` 统一把 `x-team-id`（当前 teamId）与 `x-accio-route-region`
 * 注入**所有**出站请求（`addRequestInterceptor`，publicCatalog 除外）；
 * 本仓**一个都没发** ⇒ 上游按「默认/个人空间」响应。
 *
 * 而 `activeTeam` 一直就在 `POST /api/auth/userinfo` 的响应里
 * （取证：本机 `%APPDATA%\Accio\remembered-accounts.json` 的 `auth` 对象即该端点的返回，
 * 其中就有 `activeTeam`）—— **本仓从未解析过它**。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AccioAuth } from '../../src/accio-auth.js'
import { accioHeaders } from '../../src/accio.js'
import { fetchAccioBalanceDetailed, fetchAccioUserInfo } from '../../src/accio-credits.js'

/** 造一个只回指定 JSON 的 fetcher。 */
function stubFetcher(payload: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch
}

const CRED = {
  access_token: 'tok',
  refresh_token: 'ref',
  expires_at: Date.now() + 3_600_000,
  region: 'CN' as const,
}

describe('accio 团队空间身份（issue #177）', () => {
  /**
   * ★★★ 核心一格：`activeTeam` 必须被解析出来。
   * 这条红了 = 「团队账号永远拿不到 teamId」这个缺陷回来了。
   */
  it('★★★ userinfo 的 activeTeam 必须解析成 teamId（团队空间）', async () => {
    const info = await fetchAccioUserInfo(CRED, {
      fetcher: stubFetcher({
        success: true,
        data: {
          userId: 'u1',
          userName: 'Maxi Pan',
          routeRegion: 'CN',
          userLevel: 'freeMember',
          activeTeam: { teamId: 'team-abc123', teamName: 'MA Special Team', role: 'owner' },
        },
      }),
    })
    expect(info?.activeTeam, '团队空间的 activeTeam 必须被解析').toEqual({
      teamId: 'team-abc123',
      teamName: 'MA Special Team',
      role: 'owner',
    })
  })

  /**
   * ⚠️ **个人空间是 `null`，不是 undefined**。
   * 两者都表示「没有团队」，但只有 `null` 能区分「字段在、值为 null（已知个人空间）」
   * 与「字段缺失（可能解析漏了）」。
   */
  it('★★★ 个人空间（activeTeam: null）必须解析成 null，不能是 undefined', async () => {
    const info = await fetchAccioUserInfo(CRED, {
      fetcher: stubFetcher({ success: true, data: { userId: 'u1', userName: 'U', routeRegion: 'CN', activeTeam: null } }),
    })
    expect(info?.activeTeam, '字段存在且为 null ⇒ 必须原样保留 null').toBeNull()
  })

  it('★★★ activeTeam.teamId 为空串 ⇒ 降级成 null（不编造 teamId）', async () => {
    const info = await fetchAccioUserInfo(CRED, {
      fetcher: stubFetcher({ success: true, data: { userId: 'u1', activeTeam: { teamId: '   ', teamName: 'X' } } }),
    })
    expect(info?.activeTeam, '空白 teamId 不能当成团队（否则会发空头值）').toBeNull()
  })

  /**
   * ★★★ `x-team-id` 必须进请求头 —— 这是整条修法**唯一真正起作用**的地方。
   */
  it('★★★ 有 teamId ⇒ 请求头必须带 x-team-id', () => {
    const headers = accioHeaders({ utdid: 'u', teamId: 'team-abc123' })
    expect(headers['x-team-id'], '团队空间不带这个头 ⇒ 上游按个人空间响应').toBe('team-abc123')
  })

  it('★★★ 无 teamId / 空串 ⇒ **不发** x-team-id（个人空间行为与改动前逐字节相同）', () => {
    expect(accioHeaders({ utdid: 'u' })['x-team-id']).toBeUndefined()
    expect(accioHeaders({ utdid: 'u', teamId: '' })['x-team-id']).toBeUndefined()
    // ⚠️ 空串若发出去会变成 `x-team-id: `（空头值），比不发更糟
    expect(accioHeaders({ utdid: 'u', teamId: '   ' })['x-team-id']).toBeUndefined()
  })

  it('★★ routeRegion ⇒ x-accio-route-region（官方同样注入）', () => {
    expect(accioHeaders({ utdid: 'u', routeRegion: 'CN' })['x-accio-route-region']).toBe('CN')
    expect(accioHeaders({ utdid: 'u' })['x-accio-route-region']).toBeUndefined()
  })

  /**
   * ⚠️ **反向对照**：这些头不能被顺手带进只读端点之外的语义里。
   * 本仓有一条既有纪律「只读端点只发 Accept」——`x-team-id` 是**有证据的例外**，
   * 但其它推理端头（utdid/version/appKey）仍不得混进来。
   */
  it('★★ 反向对照：团队头不影响既有头的形状（不带推理端那些）', () => {
    const headers = accioHeaders({ utdid: 'u', teamId: 't1' })
    // 这些是 accioHeaders 本来就发的（推理用），只读端点自己另建 headers，不经此函数
    expect(headers.utdid).toBe('u')
    expect(headers['Content-Type']).toBe('application/json')
    // 关键：团队身份是**独立追加**的，没有改写既有字段
    expect(Object.keys(headers).filter((k) => k.startsWith('x-'))).toEqual(['x-team-id'])
  })
  /**
   * ★★★ **调用点守卫**（2026-11-27 正向审计指出：我最初只测了纯函数层，
   * 三个真正发头的调用点零覆盖 —— 删掉任一，全量仍绿）。
   *
   * ⚠️ 这正是本仓反复记录的形态：**判据罩错层**。
   *   「`accioHeaders` 会拼这个头」≠「真的有人把 `teamId` 交给它」。
   */
  it('★★★ 调用点①：额度查询（callAccioEndpoint）必须真的发出 x-team-id', async () => {
    const seen: Array<Record<string, string>> = []
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) })
      // 三个端点都回一个合法信封，让流程走完
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await fetchAccioBalanceDetailed({ ...CRED, teamId: 'team-abc123' }, { fetcher })
    expect(seen.length, '至少要发出请求').toBeGreaterThan(0)
    for (const [i, headers] of seen.entries()) {
      expect(headers['x-team-id'], `第 ${i + 1} 个只读端点必须带 x-team-id`).toBe('team-abc123')
    }
  })

  it('★★★ 调用点①反向对照：个人空间（无 teamId）⇒ 一个带该头的请求都没有', async () => {
    const seen: Array<Record<string, string>> = []
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) })
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await fetchAccioBalanceDetailed({ ...CRED }, { fetcher })
    expect(seen.length).toBeGreaterThan(0)
    for (const headers of seen) {
      expect(headers['x-team-id'], '个人空间不得带该头（行为须与改动前逐字节相同）').toBeUndefined()
      expect(headers['x-accio-route-region']).toBeUndefined()
    }
  })

  it('★★★ 调用点②：x-accio-route-region 也必须真的发出去（不是只在 accioHeaders 里存在）', async () => {
    const seen: Array<Record<string, string>> = []
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) })
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await fetchAccioBalanceDetailed({ ...CRED, routeRegion: 'CN' }, { fetcher })
    expect(seen[0]?.['x-accio-route-region'], 'routeRegion 有值就必须发头').toBe('CN')
  })

  /**
   * ★★★ **调用点③：目录请求**（`fetchModels`）。
   *
   * 正向/对抗审计都指出：**目录那条腿也是零覆盖** —— 删掉它的团队头，全量仍绿。
   * 而目录决定「团队空间能看到哪些模型」，漏了它等于团队模型集按个人下发。
   */
  it('★★★ 调用点③：目录请求（fetchModels）必须带 x-team-id', async () => {
    const ctx = new Context()
    const store = new Map<string, string>()
    ctx.provide('credentials', {
      async resolve(ref: string) { const v = store.get(ref); return v === undefined ? undefined : { value: v, source: 'fake' } },
      async describe(ref: string) { return { configured: store.has(ref), source: 'fake', writable: true } },
      async set(ref: string, value: string) { store.set(ref, value) },
      async unset(ref: string) { store.delete(ref) },
    } as never)
    await store.set('ACCIO_ACCESS_TOKEN', JSON.stringify({ ...CRED, teamId: 'team-abc123', routeRegion: 'CN' }))
    const seen: Array<Record<string, string>> = []
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) })
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const service = new AccioAuth(ctx, { fetcher })
    try {
      await service.fetchModels()
    } finally {
      await service.stop?.()
    }
    expect(seen.length, '目录请求必须发出').toBeGreaterThan(0)
    expect(seen[0]?.['x-team-id'], '目录请求不带团队头 ⇒ 团队模型集按个人下发').toBe('team-abc123')
    expect(seen[0]?.['x-accio-route-region'], '目录也要带 route region（官方同样注入）').toBe('CN')
  })

  it('★★ 调用点③反向对照：个人空间目录请求不带任何团队头', async () => {
    const ctx = new Context()
    const store = new Map<string, string>()
    ctx.provide('credentials', {
      async resolve(ref: string) { const v = store.get(ref); return v === undefined ? undefined : { value: v, source: 'fake' } },
      async describe(ref: string) { return { configured: store.has(ref), source: 'fake', writable: true } },
      async set(ref: string, value: string) { store.set(ref, value) },
      async unset(ref: string) { store.delete(ref) },
    } as never)
    await store.set('ACCIO_ACCESS_TOKEN', JSON.stringify({ ...CRED }))
    const seen: Array<Record<string, string>> = []
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) })
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const service = new AccioAuth(ctx, { fetcher })
    try {
      await service.fetchModels()
    } finally {
      await service.stop?.()
    }
    for (const headers of seen) {
      expect(headers['x-team-id']).toBeUndefined()
    }
  })

  /**
   * ★★★ **`x-package-region: GLOBAL`**（issue #177 作者实测**有效**的那一条）。
   *
   * 与 `x-team-id` 不同：`x-team-id` 对团队额度**无效**（空间是服务端会话状态），
   * 但 `x-package-region` 对**模型可见性有效** —— 国际站带上后 **30 个模型含 9 个 GPT**；
   * 不带 ⇒ 16 条、无 GPT/Claude/Gemini。
   */
  it('★★★ 国际站（global）必须发 x-package-region: GLOBAL', () => {
    const headers = accioHeaders({ utdid: 'u', region: 'global' })
    expect(headers['x-package-region'], '不带这个头 ⇒ GPT/Claude/Gemini 全不出现').toBe('GLOBAL')
  })

  /**
   * ★★★ **`cn` 也要发 `CN`**（2026-11-27 从官方 `app.asar` 静态取证后更正）。
   *
   * 我第一版只对 `global` 发、`cn` 不发。官方实现是：
   * ```js
   * function aa(e){ let t=e?.trim().toLowerCase()
   *   return t==='cn'||t?.endsWith(':cn') ? 'CN'
   *        : t==='global'||t?.endsWith(':global') ? 'GLOBAL' : 'unknown' }
   * ```
   * 且 `getPackageRegionState()` 在**每个出站请求**都调用；白名单 `CN|GLOBAL`；
   * 只有 **`unresolved`（盘上无值）才不下发**。
   * ⇒ 知道区域就两个站都发，跟着发才对齐。
   */
  it('★★★ 国内站（cn）必须发 x-package-region: CN（对齐官方 aa() 归一化）', () => {
    expect(accioHeaders({ utdid: 'u', region: 'cn' })['x-package-region']).toBe('CN')
  })

  it('★★★ 区域未知 ⇒ 不下发（对齐官方 unresolved 分支）', () => {
    expect(accioHeaders({ utdid: 'u' })['x-package-region']).toBeUndefined()
  })

  it('★★★ 调用点④：目录请求（fetchModels）真的发出 x-package-region: GLOBAL', async () => {
    const ctx = new Context()
    const store = new Map<string, string>()
    ctx.provide('credentials', {
      async resolve(ref: string) { const v = store.get(ref); return v === undefined ? undefined : { value: v, source: 'fake' } },
      async describe(ref: string) { return { configured: store.has(ref), source: 'fake', writable: true } },
      async set(ref: string, value: string) { store.set(ref, value) },
      async unset(ref: string) { store.delete(ref) },
    } as never)
    await store.set('ACCIO_ACCESS_TOKEN', JSON.stringify({ ...CRED, region: 'global' }))
    const seen: Array<Record<string, string>> = []
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) })
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const service = new AccioAuth(ctx, { fetcher })
    try {
      await service.fetchModels()
    } finally {
      await service.stop?.()
    }
    expect(seen[0]?.['x-package-region'], '目录请求必须带它（否则模型列表里没有 GPT）').toBe('GLOBAL')
  })

})
