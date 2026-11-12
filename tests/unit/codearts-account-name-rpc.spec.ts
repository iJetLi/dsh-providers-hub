/**
 * CodeArts 账号名**接线**的行为级守卫。
 *
 * ## 为什么必须行为级，而不是源码文本断言
 *
 * 本仓库的血泪史（`AGENTS.md` 的「源码文本断言的共同弱点」）：
 * 源码里出现某个字符串**不代表它被执行** —— `if (false)` 包一层、把调用挪进死分支、
 * 或者把 `?? name` 写成 `?? id` 之后又保留原字符串，都能让源码正则全绿而功能全废。
 * ⇒ 本文件真起 RPC、真跑 `account.list`，断言**返回的 JSON**。
 *
 * ## 三条要守的腿
 *
 * | 腿 | 判据 |
 * |---|---|
 * | ① enrich 分支真的接了 | 占位昵称的账号在 `account.list` 里拿到真名 |
 * | ② 不覆盖用户起的名字 | `nickname !== id` 时原样返回（**且不读凭据**） |
 * | ③ 失败不外溢 | 凭据缺失 / 坏 JSON / 解不出 ⇒ 保留原条目，列表整体仍成功 |
 *
 * ⚠️ ③ 的「列表仍成功」是刻意的：`account.list` 是进面板就发的热路径，
 * 一个坏账号把整张列表打成错误，代价远大于少显示一个名字。
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
 * ⚠️ 样本**自造**（`alice` / `acme` / `bob`），不含任何真实账号名。
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
  return `${header}.${body}.signature`
}

const ROOT_PROFILE = {
  account_id: '01a19d50056f7354a3a13363256be613',
  account_name: 'alice',
  principal_is_root_user: true,
  principal_urn: 'iam::01a19d50056f7354a3a13363256be613:user:alice',
}

/** 能注册 RPC 的最小 ctx（照 `gemini-rpc.spec.ts` 的 `makeCtx`，只留本用例用得到的部分）。 */
function makeCtx(): { ctx: Context; credentials: FakeCredentials; handler: () => ((req: Request) => Promise<Response>) | undefined } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
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

/** 装一套 RPC，返回 `call` 与底层依赖（供断言「读了哪些 ref」）。 */
function makeRpc() {
  const { ctx, credentials, handler } = makeCtx()
  const pool = new AccountPool(ctx)
  registerJetHubRpc(
    ctx, pool,
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
  options: { id: string; nickname: string; credential?: CodeArtsCredential | string },
): Promise<void> {
  const refName = `CODEARTS_ACCOUNT_${options.id.replace(/\W/g, '').toUpperCase()}`
  await pool.addAccount({
    id: options.id,
    provider: 'codearts',
    nickname: options.nickname,
    enabled: true,
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

describe('account.list × codearts：显示真实 IAM 用户名', () => {
  it('★ 占位昵称（== id）的账号拿到真名，`accountName` 同步给上', async () => {
    const { call, pool, credentials } = makeRpc()
    await seedAccount(pool, credentials, {
      id: 'codearts-89d2d92a',
      nickname: 'codearts-89d2d92a',
      credential: credentialWith(refreshTokenWith(ROOT_PROFILE)),
    })

    const listed = await call('account.list', { provider: 'codearts' })
    expect(listed.ok).toBe(true)
    const [account] = listed.value.accounts as Array<{ id: string; nickname: string; accountName?: string }>
    expect(account.nickname).toBe('alice')
    // `accountName` 是上游既有的「只存在于凭据里的展示名」字段，Token 面板按它取值。
    expect(account.accountName).toBe('alice')
  })

  it('多个账号各自解出**互不相同**的名字（这条才是用户报障的诉求本体）', async () => {
    const { call, pool, credentials } = makeRpc()
    const names = ['alice', 'bob', 'carol']
    for (const [index, name] of names.entries()) {
      await seedAccount(pool, credentials, {
        id: `codearts-spec000${index}`,
        nickname: `codearts-spec000${index}`,
        credential: credentialWith(refreshTokenWith({
          account_name: name,
          principal_urn: `iam::acc-${index}:user:${name}`,
        })),
      })
    }

    const listed = await call('account.list', { provider: 'codearts' })
    const nicknames = (listed.value.accounts as Array<{ nickname: string }>).map((a) => a.nickname)
    expect(nicknames).toEqual(names)
    expect(new Set(nicknames).size).toBe(names.length)
  })

  it('★ 用户手动改过的昵称**原样保留**，且**连凭据都不读**', async () => {
    const { call, pool, credentials } = makeRpc()
    await seedAccount(pool, credentials, {
      id: 'codearts-1637c1a6',
      // 用户起的名 ≠ 池 id ⇒ 属于「用户意图」，不得被 IAM 用户名覆盖。
      nickname: '生产环境主号',
      credential: credentialWith(refreshTokenWith(ROOT_PROFILE)),
    })

    const listed = await call('account.list', { provider: 'codearts' })
    const [account] = listed.value.accounts as Array<{ nickname: string; accountName?: string }>
    expect(account.nickname).toBe('生产环境主号')
    // ⚠️ 这条是「早退」的力量所在：把早退删掉，下面是 `['CODEARTS_ACCOUNT_…']` ⇒ 红。
    expect(credentials.resolved).toEqual([])
  })

  it('不解出的账号保留原条目（回落显示 id），列表整体仍 ok', async () => {
    const { call, pool, credentials } = makeRpc()
    // ① 凭据缺失 ② 凭据是坏 JSON ③ 有 refresh_token 但解不出名字
    await seedAccount(pool, credentials, { id: 'codearts-missing0', nickname: 'codearts-missing0' })
    await seedAccount(pool, credentials, {
      id: 'codearts-broken00', nickname: 'codearts-broken00', credential: '{not json',
    })
    await seedAccount(pool, credentials, {
      id: 'codearts-noname00', nickname: 'codearts-noname00',
      credential: credentialWith(refreshTokenWith(undefined)),
    })

    const listed = await call('account.list', { provider: 'codearts' })
    expect(listed.ok).toBe(true)
    const accounts = listed.value.accounts as Array<{ id: string; nickname: string; accountName?: string }>
    expect(accounts.map((a) => a.nickname)).toEqual(['codearts-missing0', 'codearts-broken00', 'codearts-noname00'])
    // 解不出时**不得**塞一个 `accountName`（否则客户端会显示空白）。
    expect(accounts.every((a) => a.accountName === undefined)).toBe(true)
  })

  it('老 ticket 凭据（无 refresh_token）用凭据顶层 `user_name`', async () => {
    const { call, pool, credentials } = makeRpc()
    await seedAccount(pool, credentials, {
      id: 'codearts-legacy00',
      nickname: 'codearts-legacy00',
      credential: {
        access_key_id: 'AK-OLD', secret_access_key: 'SK-OLD', security_token: 'ST-OLD',
        expires_at: '2099-01-01T00:00:00Z', user_name: 'legacy-user',
      },
    })

    const listed = await call('account.list', { provider: 'codearts' })
    const [account] = listed.value.accounts as Array<{ nickname: string }>
    expect(account.nickname).toBe('legacy-user')
  })

  it('**不写账号池**：列表返回真名，但池里的 nickname 仍是占位 id', async () => {
    const { call, pool, credentials } = makeRpc()
    await seedAccount(pool, credentials, {
      id: 'codearts-20b1fc47',
      nickname: 'codearts-20b1fc47',
      credential: credentialWith(refreshTokenWith(ROOT_PROFILE)),
    })

    await call('account.list', { provider: 'codearts' })

    // ⚠️ 这是本改动的核心取舍：只改**返回值**，不碰存储。
    //    写池会让「旧进程下次落盘盖回去」那一类问题复活，且会污染用户数据。
    const entries = await pool.listAccounts('codearts')
    expect(entries[0]?.nickname).toBe('codearts-20b1fc47')
  })

  it('别的 provider 不受影响（enrich 分支按 provider 分派）', async () => {
    const { call, pool, credentials } = makeRpc()
    await pool.addAccount({
      id: 'buddy-spec0001',
      provider: 'buddy',
      nickname: 'codearts-lookalike',
      enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_SPEC0001',
      refreshable: false,
      createdAt: Date.now(),
    })
    const listed = await call('account.list', { provider: 'buddy' })
    const [account] = listed.value.accounts as Array<{ nickname: string; accountName?: string }>
    // 名字里含 `codearts` 也不能被 codearts 的 enrich 吃掉。
    expect(account.nickname).toBe('codearts-lookalike')
    expect(account.accountName).toBeUndefined()
    expect(credentials.resolved).toEqual([])
  })
})
