/**
 * Buddy 系（codebuddy / workbuddy）**重复账号去重**的回归测试。
 *
 * ## 守的是什么（用户实际走的路径）
 *
 * `account.create(provider=buddy|workbuddy)` 先落一张**占位条目**，
 * 后台 `runBuddyLoginFlow` 完成后回填昵称/有效期。修前这条回调**不判重**：
 * 同一账号点两次「添加账号」（或授权页复用已有会话直接放行）会得到
 * **两条独立条目** —— 各自参与选号、各自消耗额度，UI 上昵称一样无从分辨。
 *
 * 同型缺陷在别处都已修：zcode（2026-10-02，`zcode-rpc-login.spec.ts`）、
 * autoclaw（2026-10-19）、officeace、magicrew（按指纹）——
 * **buddy 系是最后一个没有登录后判重的**。
 *
 * ## 判据必须是 `user_id`
 *
 * `buildCredential` 已把服务端下发的 `account.uid` 存进凭据（JWT `sub` 兜底，
 * 见 `buddy.ts`），与 access_token 的轮换无关；access_token 每次登录都换 ⇒
 * 不可作判据（zcode 的 `device_mid` 教训同型）。
 *
 * ## 处置：停用 + 改名，**不删条目**
 *
 * 与 zcode 同口径：前端 `login.poll` 靠「条目还在 + 凭据已写入」判断登录成功，
 * 删条目会被显示成「登录失败」误导用户重试。停用后不参与自动选号，
 * 昵称写明「重复」供用户自行删除；保留**原来那条**继续可用。
 *
 * ## 测试脚手架的注意点（踩过）
 *
 * RPC 的 buddy 分支调用**全局** `fetch`（`runBuddyLoginFlow` 未传 fetcher，
 * `fetchAuthState(undefined, …)` 同）⇒ 必须 `vi.stubGlobal('fetch', …)`，
 * 并在 `afterEach` `vi.unstubAllGlobals()`。网络桩一次答完三步：
 * auth/state → auth/token → login/account（`uid` 即判重身份）。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { CODEBUDDY } from '../../src/product.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'

/** 内存凭据实现（与 `zcode-dedup.spec.ts` 同型）。 */
class FakeCredentials {
  private readonly store = new Map<string, string>()
  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async set(ref: string, value: string): Promise<void> {
    this.store.set(ref, value)
  }
  async unset(ref: string): Promise<void> {
    this.store.delete(ref)
  }
}

function makeCtx(): Context {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() {
      return { get: () => state.value, replace: (v: unknown) => { state.value = v } }
    },
    describe() { return [] },
  } as never)
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  return ctx
}

/** 服务端为某 uid 返回的三步应答（auth/state → auth/token → login/account）。 */
function stubBuddyUpstream(uid: string): void {
  const impl = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url)
    if (u.includes('/v2/plugin/auth/state')) {
      return Response.json({ code: 0, data: { state: 'spec-state', authUrl: 'https://spec.invalid/login' } })
    }
    if (u.includes('/v2/plugin/auth/token')) {
      return Response.json({
        code: 0,
        data: {
          accessToken: `tok-${uid}`,
          refreshToken: `rt-${uid}`,
          tokenType: 'Bearer',
          expiresIn: 3600,
          domain: 'copilot.tencent.com',
        },
      })
    }
    if (u.includes('/v2/plugin/login/account')) {
      return Response.json({ code: 0, data: { uid, nickname: `用户-${uid}` } })
    }
    return Response.json({ code: -1, message: `unexpected url: ${u}` }, { status: 404 })
  }
  vi.stubGlobal('fetch', impl as unknown as typeof fetch)
}

/** 装配一次 RPC（真实 handler + 真实 AccountPool），返回可复用的 call。 */
function setupRpc(): { ctx: Context; pool: AccountPool; call: (payload: unknown) => Promise<{ ok: boolean; value?: { accountId: string }; error?: { message: string } }> } {
  const ctx = makeCtx()
  const pool = new AccountPool(ctx)
  let handler: ((req: Request) => Promise<Response>) | undefined
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  const rpcCtx = {
    get: (key: string) => {
      if (key === 'connection') {
        return {
          fetch: {
            register: (config: { path: string; fetch: typeof handler }) => {
              if (config.path === JET_HUB_API_PATH) handler = config.fetch
            },
          },
        }
      }
      if (key === 'credentials') return ctx.get('credentials')
      if (key === 'llm') return { listModels: async () => [], resolveModelInfo: async () => ({}) }
      return undefined
    },
    credentials: ctx.get('credentials'),
    inject: (_deps: string[], cb: (c: unknown) => void) => { cb(rpcCtx) },
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    emit: () => {},
  }
  registerJetHubRpc(
    rpcCtx as never,
    pool,
    {
      codearts: {}, buddy: { scheduleRefresh: () => {} }, workbuddy: { scheduleRefresh: () => {} },
      lobsterai: {}, qoder: {}, qodercn: {}, trae: {}, cline: {}, loomy: {}, raccoon: {},
      minimax: {}, zcode: {}, gemini: {}, officeace: {},
    } as never,
    undefined,
  )
  const h = handler
  if (h === undefined) throw new Error('RPC handler 未注册')
  const call = async (payload: unknown) => {
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'jet-hub', payload }),
    }))
    return (await res.json() as { result: { ok: boolean; value?: { accountId: string }; error?: { message: string } } }).result
  }
  return { ctx, pool, call: (payload: unknown) => call({ method: 'account.create', payload }) }
}

let isolatedHome: string | undefined
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env['DSH_JET_HUB_STATE_DIR']
  isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-buddy-dedup-'))
  process.env['DSH_JET_HUB_STATE_DIR'] = isolatedHome
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Buddy 系重复账号去重的判据', () => {
  it('★★ 同一 user_id 登录两次：第二条被停用 + 改名「重复」，原条目不受影响', { timeout: 30000 }, async () => {
    const { pool, call } = setupRpc()
    stubBuddyUpstream('user-A')

    const first = await call({ provider: CODEBUDDY.id })
    expect(first.ok).toBe(true)
    const firstId = first.value?.accountId
    expect(firstId).toBeTruthy()

    // 等后台登录回调完成（占位条目回填昵称即完成）。
    await vi.waitFor(async () => {
      const entry = pool.findAccount(firstId!)
      expect(entry?.nickname).toBe('用户-user-A')
    }, { timeout: 15000 })

    // 同一账号再登录一次（服务端仍返回 user-A）。
    const second = await call({ provider: CODEBUDDY.id })
    expect(second.ok).toBe(true)
    const secondId = second.value?.accountId
    expect(secondId).toBeTruthy()
    expect(secondId).not.toBe(firstId)

    await vi.waitFor(async () => {
      const dup = pool.findAccount(secondId!)
      // 停用 + 昵称写明重复（不删条目：login.poll 靠条目存在报成功）。
      expect(dup?.enabled).toBe(false)
      expect(dup?.nickname).toContain('重复')
    }, { timeout: 15000 })

    // 原条目保持可用。
    const kept = pool.findAccount(firstId!)
    expect(kept?.enabled).toBe(true)
    expect(kept?.nickname).toBe('用户-user-A')
  })

  it('★★ 同款缺陷在 workbuddy（国际版）分支同样被修（同一代码路径、product.id 不同）', { timeout: 30000 }, async () => {
    const { pool, call } = setupRpc()
    stubBuddyUpstream('user-W')

    const first = await call({ provider: 'workbuddy' })
    expect(first.ok).toBe(true)
    await vi.waitFor(() => { expect(pool.findAccount(first.value!.accountId)?.nickname).toBe('用户-user-W') }, { timeout: 15000 })

    const second = await call({ provider: 'workbuddy' })
    expect(second.ok).toBe(true)
    await vi.waitFor(async () => {
      const dup = pool.findAccount(second.value!.accountId)
      expect(dup?.enabled).toBe(false)
      expect(dup?.nickname).toContain('重复')
    }, { timeout: 15000 })
    expect(pool.findAccount(first.value!.accountId)?.enabled).toBe(true)
  })

  it('★★ 不同 user_id 各自成条：去重不得误伤正常多账号', { timeout: 30000 }, async () => {
    const { pool, call } = setupRpc()
    stubBuddyUpstream('user-A')
    const first = await call({ provider: CODEBUDDY.id })
    expect(first.ok).toBe(true)
    await vi.waitFor(() => { expect(pool.findAccount(first.value!.accountId)?.nickname).toBe('用户-user-A') }, { timeout: 15000 })

    stubBuddyUpstream('user-B')
    const second = await call({ provider: CODEBUDDY.id })
    expect(second.ok).toBe(true)
    await vi.waitFor(() => { expect(pool.findAccount(second.value!.accountId)?.nickname).toBe('用户-user-B') }, { timeout: 15000 })

    // 两条都启用 —— 不同账号不去重。
    expect(pool.findAccount(first.value!.accountId)?.enabled).toBe(true)
    expect(pool.findAccount(second.value!.accountId)?.enabled).toBe(true)
  })
})
