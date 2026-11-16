/**
 * 「轮换起点」下拉框 × CodeArts：**必须显示真实 IAM 用户名，不是池 id**。
 *
 * ## 为什么有这个文件（用户 2026-11-16 报障）
 *
 * 原话：「现在修复华为云帐号显示问题，之前已经修复过在 jet hub 的设置页面
 * 显示问题了，但是忘记在积分选择界面也同步修复了」。
 *
 * 设置页走 `account.list` → `enrichAccountIdentity()` → `enrichCodeartsIdentity()`
 * （从 refresh_token 内嵌的 `user_profile` base64 解出 IAM 用户名）。
 * 但「轮换起点」下拉框走的是**另一个端点** `account.getRotation`，它此前
 * 直接下发账号池里的原始 `nickname`（codearts 账号池里存的就是池 id）
 * ⇒ 下拉框显示「位次 4 · codearts-679b1dfe」。
 *
 * ## 判据必须是行为级
 *
 * 本仓的既有教训（`AGENTS.md`「源码文本断言的共同弱点」）：
 * 源码里出现 `enrichAccountIdentity` 不代表它被执行 —— 包进 `if (false)`、
 * 挪进死分支、或者补全后又用原值覆盖，都能让源码正则全绿而功能全废。
 * ⇒ 本文件真起 RPC、真跑 `account.getRotation`，断言**返回的 JSON**。
 *
 * ## 三条要守的腿
 *
 * | 腿 | 判据 |
 * |---|---|
 * | ① 接线真的接了 | 占位昵称的账号在 `account.getRotation` 里拿到真名 |
 * | ② 不覆盖用户起的名字 | `nickname !== id` 时原样返回，**且不读凭据** |
 * | ③ 位次/顺序不受影响 | 补全前后 `position` 与数组顺序逐字相同 |
 *
 * ⚠️ ③ 容易被忽略但很关键：下拉框的 `value` 是**位次**，
 * 补全若打乱顺序就会让「选位次 3」选到别的账号。
 */
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import type { CodeArtsCredential } from '../../src/types.js'

/** 极简凭据库替身（读写内存 Map，形状与 `ctx.credentials` 一致）。 */
class FakeCredentials {
  private store = new Map<string, string>()
  /** 每次 `resolve` 的 ref 都被记下来 —— 用来断言「根本没有读凭据」。 */
  readonly resolved: string[] = []
  async resolve(ref: string) {
    this.resolved.push(ref)
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) { return { configured: this.store.has(ref), writable: true } }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

/**
 * 造一个未签名形态的 refresh_token（与 `codearts-identity.spec.ts` 同一形态）。
 *
 * ⚠️ 样本**自造**（`alice` / `bob` / `carol`），不含任何真实账号名。
 */
function refreshTokenWith(profile: Record<string, unknown> | undefined): string {
  const payload: Record<string, unknown> = {
    exp: 1796232810,
    type: 'refreshToken',
    client_id: 'codearts-agent',
    ...profile === undefined
      ? {}
      : { user_profile: Buffer.from(JSON.stringify(profile), 'utf8').toString('base64') },
  }
  const header = Buffer.from('{"typ":"JWT","alg":"RS256"}', 'utf8').toString('base64url')
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${header}.${body}.specsignature`
}

/** root 账号形态：`urn` 与 `account_name` 相同（本机真实账号都是这个形态）。 */
const ROOT_PROFILE = {
  account_name: 'alice',
  account_id: 'spec-account-0001',
  principal_is_root_user: true,
  principal_urn: 'iam::spec-account-0001:user/alice',
}

/** 起一个带 `connection.fetch.register` 桩的 Context（与既有 spec 同款）。 */
function makeCtx() {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  // ⚠️ 必须用 `ctx.provide(...)`（与既有 spec 同款），不能直接赋值 ——
  //    `enrichCodeartsIdentity` 内部走的是 `ctx.credentials` 的注入解析。
  ctx.provide('credentials', credentials as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() {
      return { get: () => state.value, replace: (v: unknown) => { state.value = v } }
    },
    describe() { return [] },
  } as never)
  let handler: ((req: Request) => Promise<Response>) | undefined
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_deps: string[], cb: (c: unknown) => void) => cb(ctx)
  return { ctx, credentials, handler: () => handler }
}

/** 起一套真 RPC（只接 codearts，其它 provider 给空替身）。 */
function makeRpc() {
  const { ctx, credentials, handler } = makeCtx()
  const pool = new AccountPool(ctx as never)
  registerJetHubRpc(
    ctx as never, pool,
    // ⚠️ 命名对象（键 = provider id、值 = 实例）；本用例只关心 codearts 之外的
    //    槽位不参与，故一律给空对象替身。
    {
      codearts: {} as never,
      buddy: {} as never,
      workbuddy: {} as never,
      lobsterai: {} as never,
      qoder: {} as never,
      qodercn: {} as never,
      trae: {} as never,
      cline: {} as never,
      loomy: {} as never,
      raccoon: {} as never,
      minimax: {} as never,
      zcode: {} as never,
      gemini: {} as never,
      officeace: {} as never,
    } as never,
    undefined,
  )
  const h = handler()
  if (h === undefined) throw new Error('handler 未注册')
  const call = async (method: string, payload: unknown) => {
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'jet-hub', payload: { method, payload } }),
    }))
    const body = await res.json() as { result: { ok: boolean; value?: any; error?: { message: string } } }
    return body.result
  }
  return { call, pool, credentials }
}

/** 一条 CodeArts 账号：`nickname` 由调用方给，凭据按 ref 写进替身库。 */
async function seedAccount(
  pool: AccountPool, credentials: FakeCredentials,
  options: { id: string; nickname: string; credential?: CodeArtsCredential | string; enabled?: boolean },
): Promise<void> {
  const refName = `CODEARTS_ACCOUNT_${options.id.replace(/\W/g, '').toUpperCase()}`
  await pool.addAccount({
    id: options.id,
    provider: 'codearts',
    nickname: options.nickname,
    enabled: options.enabled !== false,
    credentialRef: refName,
    refreshable: false,
    createdAt: Date.now(),
  })
  if (options.credential !== undefined) {
    await credentials.set(
      credentialRef(refName),
      typeof options.credential === 'string' ? options.credential : JSON.stringify(options.credential),
    )
  }
}

/** 造一条形状合法的凭据（只有 `refresh_token` 对本用例有意义）。 */
function credentialWith(refreshToken: string): CodeArtsCredential {
  return {
    access_key_id: 'AK-SPEC',
    secret_access_key: 'SK-SPEC',
    security_token: 'ST-SPEC',
    expires_at: '2099-01-01T00:00:00Z',
    refresh_token: refreshToken,
  }
}

const SESSION = 'session-spec-0001'

describe('account.getRotation × codearts：下拉框必须显示真实 IAM 用户名', () => {
  it('★★★ 占位昵称（== id）的账号拿到真名（用户 2026-11-16 报障本体）', async () => {
    const { call, pool, credentials } = makeRpc()
    await seedAccount(pool, credentials, {
      id: 'codearts-89d2d92a',
      nickname: 'codearts-89d2d92a',
      credential: credentialWith(refreshTokenWith(ROOT_PROFILE)),
    })

    const got = await call('account.getRotation', { provider: 'codearts', sessionId: SESSION })
    expect(got.ok).toBe(true)
    const [account] = got.value.accounts as Array<{ id: string; nickname: string; position: number }>
    // ⚠️ 核心断言：不是 `codearts-89d2d92a`
    expect(account.nickname).toBe('alice')
    // id 不许被改（下拉框的 selected 按 id 比对）
    expect(account.id).toBe('codearts-89d2d92a')
    // 位次仍是 1
    expect(account.position).toBe(1)
    // ⚠️ 本端点**刻意不下发 `accountName`**（只有 `account.list` 下发）——
    //    下拉框只读 `nickname`，多下发一个字段等于多一条会漂移的契约。
    expect((account as Record<string, unknown>).accountName, '本端点不返回 accountName').toBeUndefined()
  })

  it('★★ 多个账号各自解出**互不相同**的名字（这才是「认不出哪个号」的诉求）', async () => {
    const { call, pool, credentials } = makeRpc()
    const names = ['alice', 'bob', 'carol']
    for (const [index, name] of names.entries()) {
      await seedAccount(pool, credentials, {
        id: `codearts-spec000${index}`,
        nickname: `codearts-spec000${index}`,
        credential: credentialWith(refreshTokenWith({
          account_name: name,
          account_id: `spec-account-000${index}`,
          principal_is_root_user: true,
          principal_urn: `iam::spec-account-000${index}:user/${name}`,
        })),
      })
    }

    const got = await call('account.getRotation', { provider: 'codearts', sessionId: SESSION })
    expect(got.ok).toBe(true)
    const nicknames = (got.value.accounts as Array<{ nickname: string }>).map((a) => a.nickname)
    expect(nicknames).toEqual(names)
    // 反向：不许有任何一个是池 id 形态
    for (const n of nicknames) expect(n).not.toMatch(/^codearts-/)
  })

  it('★★★ 位次与数组顺序必须**逐字不变**（补全不能打乱「位次 N」的语义）', async () => {
    const { call, pool, credentials } = makeRpc()
    // 混入一个「已有真昵称」的账号（不读凭据那条分支），确保两种分支都覆盖到
    const seed = [
      { id: 'codearts-aaa', name: 'alice' },
      { id: 'codearts-bbb', name: 'bob' },
      { id: 'codearts-ccc', name: 'carol' },
    ]
    for (const [index, s] of seed.entries()) {
      await seedAccount(pool, credentials, {
        id: s.id,
        nickname: s.id, // 占位 ⇒ 会走补全
        credential: credentialWith(refreshTokenWith({
          account_name: s.name,
          account_id: `spec-acc-${index}`,
          principal_is_root_user: true,
          principal_urn: `iam::spec-acc-${index}:user/${s.name}`,
        })),
      })
    }

    const got = await call('account.getRotation', { provider: 'codearts', sessionId: SESSION })
    const accounts = got.value.accounts as Array<{ id: string; nickname: string; position: number }>
    // 顺序 = 入池顺序
    expect(accounts.map((a) => a.id)).toEqual(['codearts-aaa', 'codearts-bbb', 'codearts-ccc'])
    // 位次 = 1-based 递增
    expect(accounts.map((a) => a.position)).toEqual([1, 2, 3])
    // 名字与 id 一一对应
    expect(accounts.map((a) => a.nickname)).toEqual(['alice', 'bob', 'carol'])
  })

  it('★★ 用户自己起的昵称原样保留，**且不读凭据**（不能被补全覆盖）', async () => {
    const { call, pool, credentials } = makeRpc()
    await seedAccount(pool, credentials, {
      id: 'codearts-89d2d92a',
      nickname: '我起的名',
      credential: credentialWith(refreshTokenWith(ROOT_PROFILE)),
    })
    credentials.resolved.length = 0 // 清掉入池时可能的读

    const got = await call('account.getRotation', { provider: 'codearts', sessionId: SESSION })
    expect(got.ok).toBe(true)
    const [account] = got.value.accounts as Array<{ nickname: string }>
    expect(account.nickname).toBe('我起的名')
    // ⚠️ 「已有真昵称 ⇒ 一行都不动、不读凭据」是 enrichCodeartsIdentity 的既有契约
    expect(credentials.resolved, '不该为已有昵称的账号读凭据').toHaveLength(0)
  })

  it('★★ 凭据缺失 / 坏 JSON ⇒ 保留池 id，端点整体仍成功（一个坏号不能打垮整张下拉框）', async () => {
    const { call, pool, credentials } = makeRpc()
    await seedAccount(pool, credentials, {
      id: 'codearts-ok000001',
      nickname: 'codearts-ok000001',
      credential: credentialWith(refreshTokenWith(ROOT_PROFILE)),
    })
    // 凭据完全没写进替身库
    await seedAccount(pool, credentials, { id: 'codearts-nocred1', nickname: 'codearts-nocred1' })
    // 坏 JSON
    await seedAccount(pool, credentials, { id: 'codearts-badjson', nickname: 'codearts-badjson', credential: '{not json' })
    // 合法 JSON 但解不出名字
    await seedAccount(pool, credentials, {
      id: 'codearts-noname1',
      nickname: 'codearts-noname1',
      credential: credentialWith(refreshTokenWith(undefined)),
    })

    const got = await call('account.getRotation', { provider: 'codearts', sessionId: SESSION })
    expect(got.ok, '一个坏账号不许把整张下拉框打成错误').toBe(true)
    const accounts = got.value.accounts as Array<{ id: string; nickname: string }>
    expect(accounts).toHaveLength(4)
    // 好的解出真名
    expect(accounts.find((a) => a.id === 'codearts-ok000001')?.nickname).toBe('alice')
    // 坏的保留池 id（与改动前一致，不编造）
    for (const id of ['codearts-nocred1', 'codearts-badjson', 'codearts-noname1']) {
      expect(accounts.find((a) => a.id === id)?.nickname).toBe(id)
    }
  })

  it('★ 停用账号不进下拉框（与积分窗口同口径，否则位次错位）', async () => {
    const { call, pool, credentials } = makeRpc()
    await seedAccount(pool, credentials, {
      id: 'codearts-on000001', nickname: 'codearts-on000001',
      credential: credentialWith(refreshTokenWith(ROOT_PROFILE)),
    })
    await seedAccount(pool, credentials, {
      id: 'codearts-off00001', nickname: 'codearts-off00001',
      credential: credentialWith(refreshTokenWith(ROOT_PROFILE)),
      enabled: false,
    })

    const got = await call('account.getRotation', { provider: 'codearts', sessionId: SESSION })
    const accounts = got.value.accounts as Array<{ id: string; position: number }>
    expect(accounts.map((a) => a.id)).toEqual(['codearts-on000001'])
    expect(accounts[0].position).toBe(1)
  })
})
