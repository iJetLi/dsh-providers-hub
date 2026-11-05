/**
 * Buddy 系（codebuddy / workbuddy）**重复账号去重**的回归测试（2026-11-03 重写）。
 *
 * ## 守的是什么（用户实际走的路径）
 *
 * `account.create(provider=buddy|workbuddy)` 先落一张**占位条目**，
 * 后台 `runBuddyLoginFlow` 完成后回填凭据。修前这条回调**不判重**：
 * 同一账号点两次「添加账号」会得到**两条独立条目** —— 各自参与选号、各自消耗额度。
 *
 * ## 处置口径（与 monkeycode / baizhi / autoclaw 同型）
 *
 * 命中同 `user_id` 的旧卡时：**新凭据写到旧卡 → 旧卡更新到期/续期/昵称 →
 * 记 `loginMergedRedirect` → 删除占位**。不采用「停用新卡」：
 * 那会让旧卡永远吃不到新 token（用户按提示重登也修不好），且旧卡本来停用时
 * 会出现「两条都停用」的死循环。
 *
 * ## 本文件重点守的四条（都是审计实测会踩的）
 *
 * 1. **判据是 `user_id`，不是轮换的 `access_token`** —— 桩每次登录返回**不同**
 *    token；若有人把判据换回 access_token，这里会看到两条卡片而变红。
 * 2. **旧卡被用户停用 ⇒ 反转**（旧卡重新启用、只剩一条）。
 * 3. **新凭据必须转写到旧卡**（旧 ref 里的 `access_token` 是第二次登录的新值）。
 * 4. **不依赖条目顺序**：在后台登录完成前把占位条目重排到旧卡前面，
 *    仍必须判重（`findAccountIdByIdentityField` 传了 `excludeAccountId`）。
 *
 * ## 测试脚手架
 *
 * 真实 RPC handler + 真实 `AccountPool` + 真实 buddy OAuth 解析，只 stub 全局
 * `fetch`。每轮登录有 `sleep(POLL_INTERVAL_MS=1000)` × 2 ⇒ 单例约 4s 是真实等待，
 * 不是重试/网络。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { CODEBUDDY } from '../../src/product.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'

/** 内存凭据实现。 */
class FakeCredentials {
  readonly store = new Map<string, string>()
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

/** 服务端三步应答（auth/state → auth/token → login/account）；token **每次不同**。 */
function stubBuddyUpstream(uid: string, calls: { token: number }, onAccount?: () => Promise<void> | void): void {
  const impl = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url)
    if (u.includes('/v2/plugin/auth/state')) {
      return Response.json({ code: 0, data: { state: 'spec-state', authUrl: 'https://spec.invalid/login' } })
    }
    if (u.includes('/v2/plugin/auth/token')) {
      calls.token += 1
      return Response.json({
        code: 0,
        data: {
          // ⚠️ **每次登录换一个 token**：这是真实形态，也是「判据不能是
          //    access_token」这条的守卫 —— 同值 token 会让错误判据也能通过。
          accessToken: `tok-${uid}-${calls.token}`,
          refreshToken: `rt-${uid}-${calls.token}`,
          tokenType: 'Bearer',
          expiresIn: 3600,
          domain: 'copilot.tencent.com',
        },
      })
    }
    if (u.includes('/v2/plugin/login/account')) {
      await onAccount?.()
      return Response.json({ code: 0, data: { uid, nickname: `用户-${uid}` } })
    }
    return Response.json({ code: -1, message: `unexpected url: ${u}` }, { status: 404 })
  }
  vi.stubGlobal('fetch', impl as unknown as typeof fetch)
}

interface Harness {
  ctx: Context
  pool: AccountPool
  credentials: FakeCredentials
  call: (method: string, payload?: unknown) => Promise<{ ok: boolean, value?: unknown, error?: { message: string } }>
}

/** 装配一次 RPC（真实 handler + 真实 AccountPool）。 */
function setupRpc(): Harness {
  const ctx = makeCtx()
  const pool = new AccountPool(ctx)
  let handler: ((req: Request) => Promise<Response>) | undefined
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  const rpcCtx = {
    get: (key: string) => {
      if (key === 'connection') {
        return {
          fetch: {
            register: (config: { path: string, fetch: typeof handler }) => {
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
  const call = async (method: string, payload?: unknown) => {
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'jet-hub', payload: { method, payload } }),
    }))
    return (await res.json() as { result: { ok: boolean, value?: unknown, error?: { message: string } } }).result
  }
  return { ctx, pool, credentials: ctx.get('credentials') as unknown as FakeCredentials, call }
}

/** 等后台登录回调完成。 */
async function waitFor(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 15_000 })
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

afterAll(() => {
  if (previousHome === undefined) delete process.env['DSH_JET_HUB_STATE_DIR']
  else process.env['DSH_JET_HUB_STATE_DIR'] = previousHome
  if (isolatedHome !== undefined) rmSync(isolatedHome, { recursive: true, force: true })
})

describe('Buddy 系重复账号去重（合并进旧卡）', () => {
  it('★★ 同一 user_id 登录两次（token 每次不同）⇒ 只留一条卡、旧卡拿到新 token', { timeout: 30_000 }, async () => {
    const { pool, credentials, call } = setupRpc()
    const calls = { token: 0 }
    stubBuddyUpstream('user-A', calls)

    const first = await call('account.create', { provider: CODEBUDDY.id })
    expect(first.ok).toBe(true)
    const firstId = (first.value as { accountId: string }).accountId
    await waitFor(() => {
      expect(pool.findAccount(firstId)?.nickname).toBe('用户-user-A')
    })

    const second = await call('account.create', { provider: CODEBUDDY.id })
    expect(second.ok).toBe(true)
    const secondId = (second.value as { accountId: string }).accountId
    expect(secondId).not.toBe(firstId)

    // 占位条目被删除（合并而不是「停用新卡」）。
    await waitFor(() => {
      expect(pool.findAccount(secondId)).toBeUndefined()
    })
    const accounts = await pool.listAllAccounts()
    expect(accounts.filter((a) => a.provider === CODEBUDDY.id)).toHaveLength(1)

    // 旧卡保持启用，且拿到**第二次**登录的新 token（不是旧 token）。
    const kept = pool.findAccount(firstId)
    expect(kept?.enabled).toBe(true)
    // 到期/续期也必须承接：否则旧卡可能立刻被判过期、或失去自愈能力。
    expect(typeof kept?.expiresAt).toBe('number')
    expect(kept!.expiresAt!).toBeGreaterThan(Date.now())
    expect(kept?.refreshable).toBe(true)
    const refName = kept!.credentialRef
    const raw = JSON.parse(credentials.store.get(refName)!) as { access_token: string }
    expect(raw.access_token).toBe('tok-user-A-2')

    // login.poll 对**已删除的占位 id** 仍报成功（靠 loginMergedRedirect）。
    const poll = await call('login.poll', { accountId: secondId })
    expect(poll.ok).toBe(true)
    expect(poll.value).toMatchObject({ done: true, success: true })
  })

  it('★★ workbuddy（国际版）同一路径：同样合并、不产生第二张卡', { timeout: 30_000 }, async () => {
    const { pool, call } = setupRpc()
    const calls = { token: 0 }
    stubBuddyUpstream('user-W', calls)

    const first = await call('account.create', { provider: 'workbuddy' })
    const firstId = (first.value as { accountId: string }).accountId
    await waitFor(() => { expect(pool.findAccount(firstId)?.nickname).toBe('用户-user-W') })

    const second = await call('account.create', { provider: 'workbuddy' })
    const secondId = (second.value as { accountId: string }).accountId
    await waitFor(() => { expect(pool.findAccount(secondId)).toBeUndefined() })

    expect(pool.findAccount(firstId)?.enabled).toBe(true)
    expect((await pool.listAllAccounts()).filter((a) => a.provider === 'workbuddy')).toHaveLength(1)
  })

  it('★★ 旧卡已被用户停用 ⇒ 反转：旧卡重新启用，仍只有一条', { timeout: 30_000 }, async () => {
    const { pool, call } = setupRpc()
    const calls = { token: 0 }
    stubBuddyUpstream('user-D', calls)

    const first = await call('account.create', { provider: CODEBUDDY.id })
    const firstId = (first.value as { accountId: string }).accountId
    await waitFor(() => { expect(pool.findAccount(firstId)?.nickname).toBe('用户-user-D') })

    await pool.updateAccount(firstId, { enabled: false })

    const second = await call('account.create', { provider: CODEBUDDY.id })
    const secondId = (second.value as { accountId: string }).accountId
    await waitFor(() => { expect(pool.findAccount(secondId)).toBeUndefined() })

    // 用户刚主动登录这个号 ⇒ 旧卡重新启用（否则「登录成功但零可用卡」）。
    expect(pool.findAccount(firstId)?.enabled).toBe(true)
    expect((await pool.listAllAccounts()).filter((a) => a.provider === CODEBUDDY.id)).toHaveLength(1)
  })

  it('★★ 占位条目被重排到旧卡前面，仍必须判重（不依赖条目顺序）', { timeout: 30_000 }, async () => {
    const { pool, credentials, call } = setupRpc()
    const calls = { token: 0 }
    let pendingReorder: (() => Promise<void>) | undefined
    stubBuddyUpstream('user-R', calls, async () => {
      if (pendingReorder !== undefined) {
        const run = pendingReorder
        pendingReorder = undefined
        await run()
      }
    })

    const first = await call('account.create', { provider: CODEBUDDY.id })
    const firstId = (first.value as { accountId: string }).accountId
    await waitFor(() => { expect(pool.findAccount(firstId)?.nickname).toBe('用户-user-R') })

    const second = await call('account.create', { provider: CODEBUDDY.id })
    const secondId = (second.value as { accountId: string }).accountId
    // 模拟用户在等待浏览器授权期间拖动排序：把**新占位**排到旧卡前面。
    pendingReorder = () => pool.reorderAccounts(CODEBUDDY.id, [secondId, firstId])

    await waitFor(() => { expect(pool.findAccount(secondId)).toBeUndefined() })
    const remaining = (await pool.listAllAccounts()).filter((a) => a.provider === CODEBUDDY.id)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(firstId)
    // ⚠️ 还必须验证新 token 写回了旧卡：没有 excludeAccountId 时「自己匹配自己」
    //    会把新卡删掉、旧卡却拿不到新 token（看起来「只剩一条」但其实是错的）。
    const raw = JSON.parse(credentials.store.get(remaining[0]!.credentialRef)!) as { access_token: string }
    expect(raw.access_token).toBe('tok-user-R-2')
  })

  it('★★ 不同 user_id 各自成条：去重不得误伤正常多账号', { timeout: 30_000 }, async () => {
    const { pool, call } = setupRpc()
    const calls = { token: 0 }
    stubBuddyUpstream('user-A', calls)
    const first = await call('account.create', { provider: CODEBUDDY.id })
    const firstId = (first.value as { accountId: string }).accountId
    await waitFor(() => { expect(pool.findAccount(firstId)?.nickname).toBe('用户-user-A') })

    stubBuddyUpstream('user-B', calls)
    const second = await call('account.create', { provider: CODEBUDDY.id })
    const secondId = (second.value as { accountId: string }).accountId
    await waitFor(() => { expect(pool.findAccount(secondId)?.nickname).toBe('用户-user-B') })

    expect(pool.findAccount(firstId)?.enabled).toBe(true)
    expect(pool.findAccount(secondId)?.enabled).toBe(true)
    expect((await pool.listAllAccounts()).filter((a) => a.provider === CODEBUDDY.id)).toHaveLength(2)
  })
})

/**
 * 合并段失败补偿（2026-11-03 对抗审计 P1 的两条）。
 *
 * 这一段任何一步抛错都会冒到外层 `.catch → failLogin`，而 `failLogin` 看到
 * 占位自己的凭据已落库会按成功处理、**不删占位** ⇒ 两张同凭据启用卡。
 * 故本文件补两条失败注入用例，锁住「已交凭据就删占位 / 没交就保留并标注」。
 */
describe('合并段失败补偿', () => {
  it('★★ 凭据已交给旧卡后 updateAccount 抛错 ⇒ 占位被删，不留两张同凭据卡', { timeout: 30_000 }, async () => {
    const { pool, credentials, call } = setupRpc()
    const calls = { token: 0 }
    stubBuddyUpstream('user-F', calls)
    const first = await call('account.create', { provider: CODEBUDDY.id })
    const firstId = (first.value as { accountId: string }).accountId
    await waitFor(() => { expect(pool.findAccount(firstId)?.nickname).toBe('用户-user-F') })

    // 让「更新旧卡」这一步失败（凭据 set 已成功）。
    const originalUpdate = pool.updateAccount.bind(pool)
    let injected = false
    pool.updateAccount = async (id: string, patch: Parameters<typeof pool.updateAccount>[1]) => {
      if (id === firstId && !injected) {
        injected = true
        throw new Error('injected update failure')
      }
      return originalUpdate(id, patch)
    }

    const second = await call('account.create', { provider: CODEBUDDY.id })
    const secondId = (second.value as { accountId: string }).accountId
    await waitFor(() => { expect(pool.findAccount(secondId)).toBeUndefined() })

    const accounts = (await pool.listAllAccounts()).filter((a) => a.provider === CODEBUDDY.id)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.id).toBe(firstId)
    // 旧卡已拿到新 token（补偿只负责删占位，不动已写好的凭据）。
    const raw = JSON.parse(credentials.store.get(accounts[0]!.credentialRef)!) as { access_token: string }
    expect(raw.access_token).toBe('tok-user-F-2')
  })

  it('★★ 写旧卡凭据失败 ⇒ 保留占位并标注「合并失败」，不静默', { timeout: 30_000 }, async () => {
    const { pool, credentials, call } = setupRpc()
    const calls = { token: 0 }
    stubBuddyUpstream('user-G', calls)
    const first = await call('account.create', { provider: CODEBUDDY.id })
    const firstId = (first.value as { accountId: string }).accountId
    await waitFor(() => { expect(pool.findAccount(firstId)?.nickname).toBe('用户-user-G') })
    const firstRef = pool.findAccount(firstId)!.credentialRef

    const originalSet = credentials.set.bind(credentials)
    let injected = false
    credentials.set = async (ref: string, value: string) => {
      if (ref === firstRef && !injected) {
        injected = true
        throw new Error('injected credential write failure')
      }
      return originalSet(ref, value)
    }

    const second = await call('account.create', { provider: CODEBUDDY.id })
    const secondId = (second.value as { accountId: string }).accountId
    // 占位保留（它是唯一拿到新 token 的卡），且昵称写明失败原因。
    await waitFor(() => {
      expect(pool.findAccount(secondId)?.nickname).toContain('合并失败')
    })
    // 占位自己的凭据仍在（新 token），旧卡仍是旧 token —— 两张卡凭据不同，
    // 不是「两张同凭据启用卡」；用户能看到原因并重试。
    const raw = JSON.parse(credentials.store.get(pool.findAccount(secondId)!.credentialRef)!) as { access_token: string }
    expect(raw.access_token).toBe('tok-user-G-2')
  })
})
