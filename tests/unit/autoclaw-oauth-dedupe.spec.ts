/**
 * ★★ OAuth 登录路径的**同账号去重**（2026-11-02 审查发现：新路径绕过了既有防线）。
 *
 * ## 历史事故（`login.submitSms` 那条腿的注释）
 *
 * 2026-10-19 真机报障：同一个手机号在面板上出现 **3 次**、积分被**重复累加 62416**。
 * 根因是 `access_token` 是 JWT、**每次登录/续期都轮换** ⇒ 拿它当身份判据时
 * 同一账号每登一次就算新账号；而 `user_id` 是稳定值。
 *
 * ## 为什么新路径必须单独守
 *
 * 短信路径能兜住，是因为它有「用户再提交一次验证码」这**第二次交互**
 * （去重写在 `login.submitSms` 里）。而 **OAuth 在回调里一次做完，没有第二次机会**
 * ⇒ 用户连点两次「+ 新建账号」并用同一个 Z.ai 账号授权，就会得到两张卡片、
 * 两份凭据、积分翻倍。
 *
 * ## 判据为什么是行为级
 *
 * 「代码里有 `findAccountIdByIdentityField`」抓不住两种真实错法：
 * ① provider 传成硬编码的 `AUTOCLAW.id`（对国际版**恒查不到** —— 这正是本仓
 *    「同一事实抄两份」的老形态，短信那条就是这么写的）；
 * ② 顺序写反（先删占位再写老条目 ⇒ 新 token 丢失、账号永久失效）。
 * ⇒ 断言**池里的最终条数 + 昵称归属 + 凭据落点**。
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'

interface Harness {
  pool: AccountPool
  call: (method: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string; message?: string } }>
  /** 让 `account.create` 的后台 `started.result` 落定。 */
  finishLogin: (credential: Record<string, unknown>) => void
  /** 等后台链跑完（轮询池状态，最多 1s）。 */
  waitFor: (predicate: () => boolean) => Promise<void>
  credentials: Map<string, string>
}

function makeHarness(): Harness {
  let handler: ((req: Request) => Promise<Response>) | undefined
  let settle: ((value: unknown) => void) | undefined
  const credentials = new Map<string, string>()
  const ctx = new Context() as never as Record<string, unknown>
  const provide = (ctx as { provide: (n: string, v: unknown) => void }).provide.bind(ctx)
  provide('credentials', {
    resolve: async (ref: unknown) => {
      const value = credentials.get(String(ref))
      return value === undefined ? undefined : { value, source: 'fake' }
    },
    describe: async () => ({ configured: true, writable: true }),
    set: async (ref: unknown, value: string) => { credentials.set(String(ref), value) },
    unset: async (ref: unknown) => { credentials.delete(String(ref)) },
  })
  provide('commands', { register: () => () => {}, definitions: [] })
  provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  })
  const state: { value: unknown } = { value: undefined }
  provide('settings', {
    register() { return { get: () => state.value, replace: (v: unknown) => { state.value = v } } },
    describe() { return [] },
  })
  ;(ctx as unknown as Record<string, unknown>).logger = {
    warn: () => {}, info: () => {}, error: () => {}, debug: () => {},
  }
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_d: string[], cb: (c: unknown) => void) => cb(ctx)

  const fakeAuth = {
    probeLocal: async () => null,
    importLocalAccount: async () => {},
    verifyCredentialSite: async () => {},
    startLogin: async () => {
      const result = new Promise((resolve) => { settle = resolve })
      return { loginUrl: 'http://127.0.0.1:1/autoclaw/login', result, close: async () => {} }
    },
  }
  const pool = new AccountPool(ctx as never)
  registerJetHubRpc(
    ctx as never, pool,
    {
      codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
      lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
      trae: {} as never, cline: {} as never, loomy: {} as never,
      raccoon: {} as never, minimax: {} as never, zcode: {} as never,
      gemini: {} as never, officeace: {} as never,
      autoclaw: fakeAuth as never,
      autoclawintl: fakeAuth as never,
    } as never,
    undefined,
  )
  if (handler === undefined) throw new Error('handler 未注册')

  const call = async (method: string, payload: unknown) => {
    const response = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: unknown } }
    return body.result
  }
  return {
    pool, call, credentials,
    finishLogin: (credential) => settle?.({ credential, phone: '' }),
    waitFor: async (predicate) => {
      const startedAt = Date.now()
      while (!predicate()) {
        if (Date.now() - startedAt > 1_000) throw new Error('等待后台登录链超时（1s）')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
  }
}

describe('★★ OAuth 登录去重：同一个 user_id 第二次授权不得产生第二张卡片', () => {
  const credential = (name: string) => ({
    access_token: `stub-${name}`,
    refresh_token: `stub-r-${name}`,
    expires_at: Date.now() + 3_600_000,
    device_id: 'dev-test',
    user_id: 'same-user-id',
    user_name: name,
  })

  it('★★ 两次 create 同一账号 ⇒ 池里只留一条，且新凭据落到**原条目**上', async () => {
    const h = makeHarness()

    // 第一次
    const first = await h.call('account.create', { provider: 'autoclawintl', autoclawMode: 'zai' })
    expect(first.ok).toBe(true)
    h.finishLogin(credential('alice'))
    // ⚠️ **不能等「池里 1 条」**：占位条目在 `startLogin` 之前就已经 addAccount 了
    //    ⇒ 那个条件在后台链跑完**之前**就满足（第一版就这么写，拿到空凭据）。
    await h.waitFor(() => [...h.credentials.values()].some((value) => value.includes('stub-alice')))
    const firstEntry = h.pool.listAccountsByProvider('autoclawintl')[0]
    const firstRef = firstEntry.credentialRef
    // ⚠️ 凭据键是 `credentialRef(refName)` 的结果（未必等于 `entry.credentialRef` 的字面值）
    //    ⇒ 按**值**找，别按猜的键名找（按键名找会得到空串，症状像「凭据没落盘」）。
    expect(
      [...h.credentials.values()].some((value) => value.includes('stub-alice')),
      '第一次登录的凭据必须落盘',
    ).toBe(true)

    // 第二次：同一 user_id（模拟用户又点了一次「+」，走同一 Z.ai 账号）
    const second = await h.call('account.create', { provider: 'autoclawintl', autoclawMode: 'zai' })
    expect(second.ok).toBe(true)
    h.finishLogin(credential('alice-renamed'))

    // 后台链要跑完：占位条目被删、老条目昵称被更新
    await h.waitFor(() => {
      const entries = h.pool.listAccountsByProvider('autoclawintl')
      return entries.length === 1 && entries[0].nickname === 'alice-renamed'
    })

    const entries = h.pool.listAccountsByProvider('autoclawintl')
    expect(entries, '同一账号第二次授权产生了第二张卡片 ⇒ 积分会按账号翻倍累加').toHaveLength(1)
    expect(entries[0].id, '必须保留**先创建**的那条').toBe(firstEntry.id)
    expect(entries[0].credentialRef, '凭据引用不应被换成新占位的 ref').toBe(firstRef)
  })

  it('★ 对照：不同 user_id 必须各自成条（别把去重做成「只准有一个账号」）', async () => {
    const h = makeHarness()
    await h.call('account.create', { provider: 'autoclawintl', autoclawMode: 'zai' })
    h.finishLogin({ ...credential('bob'), user_id: 'user-b' })
    await h.waitFor(() => h.pool.listAccountsByProvider('autoclawintl').length === 1)

    await h.call('account.create', { provider: 'autoclawintl', autoclawMode: 'zai' })
    h.finishLogin({ ...credential('carol'), user_id: 'user-c' })
    await h.waitFor(() => h.pool.listAccountsByProvider('autoclawintl').length === 2)

    expect(h.pool.listAccountsByProvider('autoclawintl')).toHaveLength(2)
  })

  /**
   * ⚠️⚠️ **读池失败 ≠ 登录失败**（2026-11-02 自查补的必修）。
   *
   * 去重这一步跑在 `started.result.then(...)` 链上，而该链有
   * `.catch(error => failLogin(id, error))` —— **任何抛错都会删账号**。
   * 但此处凭据**已经换到手了**：若把「查重的依赖挂了」判成「登录失败」，
   * 用户会看到「登录失败」，而占位条目连同刚拿到的凭据一起被清掉 ⇒ 只能重来一次。
   * 这与 officeace 那条注释的教训同型（「读不到 ≠ 没有」）。
   *
   * 判据设计：让 `findAccountIdByIdentityField` 直接抛错，然后断言
   * ① 账号**还在**（没走 failLogin）② 凭据**落盘**。
   */
  it('★★ 查重时读池抛错 ⇒ 记 warn 后照常落库，绝不删账号', async () => {
    const h = makeHarness()
    const created = await h.call('account.create', { provider: 'autoclawintl', autoclawMode: 'zai' })
    expect(created.ok).toBe(true)

    // 让查重读池直接炸（模拟池后端不可用 / 替身池没这个方法）
    Object.defineProperty(h.pool, 'findAccountIdByIdentityField', {
      configurable: true,
      value: () => { throw new Error('pool unavailable') },
    })

    h.finishLogin(credential('dave'))
    await h.waitFor(() => [...h.credentials.values()].some((value) => value.includes('stub-dave')))

    const entries = h.pool.listAccountsByProvider('autoclawintl')
    expect(entries, '读池失败被当成登录失败 ⇒ 占位条目连同凭据一起被删').toHaveLength(1)
    expect(entries[0].nickname, '照常落库时昵称必须按本次凭据刷新').toBe('dave')
  })

  /**
   * ⚠️⚠️ **命中「已停用」的原卡时必须一并启用**（2026-11-02 自查补；officeace P2 的第二个入口）。
   *
   * 症状：用户手动停用某张国际版卡片 → 用同一个 Z.ai 账号重新授权 ⇒ 新卡并入老卡并删除
   * 新卡 ⇒ 老卡**仍是停用** ⇒ 面板上「新卡片消失、老卡片依旧灰着」= 用户以为没登上；
   * 若那是唯一账号，还会因「无已启用账号」整组隐藏。
   * 语义与 officeace 一致：**用户刚刚主动用这个号登录过，就是想让它可用**。
   */
  it('★★ 命中的原卡已被停用 ⇒ 并入时必须重新启用（否则「登录成功但零可用卡」）', async () => {
    const h = makeHarness()
    await h.call('account.create', { provider: 'autoclawintl', autoclawMode: 'zai' })
    h.finishLogin(credential('erin'))
    await h.waitFor(() => [...h.credentials.values()].some((value) => value.includes('stub-erin')))

    const first = h.pool.listAccountsByProvider('autoclawintl')[0]
    await h.pool.updateAccount(first.id, { enabled: false })
    expect(h.pool.listAccountsByProvider('autoclawintl')[0].enabled).toBe(false)

    // 同一账号再登一次
    await h.call('account.create', { provider: 'autoclawintl', autoclawMode: 'zai' })
    h.finishLogin(credential('erin-again'))
    await h.waitFor(() => {
      const entries = h.pool.listAccountsByProvider('autoclawintl')
      return entries.length === 1 && entries[0].nickname === 'erin-again'
    })

    const entries = h.pool.listAccountsByProvider('autoclawintl')
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe(first.id)
    expect(entries[0].enabled, '原卡停用着 ⇒ 用户会以为没登上，且该渠道零可用卡').toBe(true)
  })

  afterEach(() => {
    // 池是每用例新建的，无需清理
  })
})
