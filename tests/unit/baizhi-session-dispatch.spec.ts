import { describe, expect, it } from 'vitest'

import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'

/**
 * `baizhi.startSession` 的**分派顺序**与「合并写回」行为（2026-11-03 补牙）。
 *
 * ## 为什么必须行为级
 *
 * 这个分支必须排在 `startsWith('baizhi.')` **之前**：否则会被 `handleBaizhiRpc`
 * 当成未知动作（`startSession` 不在它的 switch 里）返回 `undefined`，再落到主
 * switch 的 `default`，客户端收到 `unknown method` —— 而「补登录态」按钮是
 * 百智云卡片上**唯一**能修积分的入口。
 *
 * 红队实测：把 `if (method === 'baizhi.startSession')` 改成 `if (false && …)`
 * （等价于顺序写错被吞），**30 条用例全绿**；全仓 `tests/` 里该串只出现一次
 * 且在注释里。故本文件真起 RPC 端点、真调方法、真等后台任务。
 *
 * ## 同时守的第二件事：写回必须**合并**
 *
 * `access_token`（用户手填的 `sk-`）与 `session_cookie` 是两套凭据：补登录态时
 * 若整份覆盖，账号会**再也发不出消息**且没有任何提示。
 */

type Handler = (req: Request) => Promise<Response>

function makeHarness(options: {
  accounts: Array<{ id: string, credentialRef: string }>
  previousCredential?: string
}) {
  let handler: Handler | undefined
  const writes: Array<{ ref: string, value: string }> = []
  const updates: Array<{ id: string, patch: unknown }> = []
  let loginCalls = 0

  const ctx = {
    get: (key: string) => key === 'connection'
      ? {
          fetch: {
            register: (config: { path: string, fetch: Handler }) => {
              if (config.path === JET_HUB_API_PATH) handler = config.fetch
            },
          },
        }
      : undefined,
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {} },
    credentials: {
      resolve: async (ref: { ref?: string } | string) => {
        const name = typeof ref === 'string' ? ref : ref.ref ?? ''
        if (options.previousCredential === undefined) return undefined
        return { ref: name, value: options.previousCredential }
      },
      set: async (ref: { ref?: string } | string, value: string) => {
        writes.push({ ref: typeof ref === 'string' ? ref : ref.ref ?? '', value })
      },
      unset: async () => {},
    },
  }

  const pool = {
    listAccounts: async () => options.accounts,
    listAccountsByProvider: (provider: string) => provider === 'baizhi'
      ? options.accounts.map((a) => ({ ...a, provider: 'baizhi', enabled: true }))
      : [],
    addAccount: async () => {},
    updateAccount: async (id: string, patch: unknown) => { updates.push({ id, patch }) },
    removeAccount: async () => {},
  }

  const auths = {
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
    monkeycode: {} as never,
    monkeycodeintl: {} as never,
    baizhi: {
      async loginSessionViaBrowser() {
        loginCalls += 1
        return {
          session_cookie: 'baizhi_session=NEW; sl-session=NEW2',
          nickname: '新昵称',
          user_id: 'u-1',
        }
      },
    },
  }

  registerJetHubRpc(ctx as never, pool as never, auths as never)
  if (handler === undefined) throw new Error('endpoint handler 未注册')
  const registered = handler

  async function call(method: string, payload: unknown) {
    const response = await registered(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as { result: { ok: boolean, value?: unknown, error?: unknown } }
    return body.result
  }

  return {
    call,
    writes,
    updates,
    loginCalls: () => loginCalls,
  }
}

describe('baizhi.startSession 的分派顺序（必须先于 startsWith(baizhi.)）', () => {
  it('★★ 真调 RPC：命中 startSession 分支并起登录任务（被 baizhi. 吞掉时这里会拿到 unknown method）', async () => {
    const harness = makeHarness({
      accounts: [{ id: 'baizhi-1', credentialRef: 'BAIZHI_ACCOUNT_1' }],
      previousCredential: JSON.stringify({ access_token: 'sk-old', signing_secret: 'sec-old' }),
    })
    const result = await harness.call('baizhi.startSession', { accountId: 'baizhi-1' })
    expect(result.ok, `startSession 没被分派到：${JSON.stringify(result.error)}`).toBe(true)
    expect(result.value).toEqual({ accountId: 'baizhi-1' })

    // 后台任务是 fire-and-forget：等一拍让它跑完 `loginSessionViaBrowser` + 写回。
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.loginCalls(), 'startSession 分支没有调用 loginSessionViaBrowser').toBe(1)
  })

  it('★★ 写回必须合并：旧的 `sk-`（access_token）不得被覆盖掉', async () => {
    const harness = makeHarness({
      accounts: [{ id: 'baizhi-1', credentialRef: 'BAIZHI_ACCOUNT_1' }],
      previousCredential: JSON.stringify({ access_token: 'sk-old', signing_secret: 'sec-old' }),
    })
    await harness.call('baizhi.startSession', { accountId: 'baizhi-1' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.writes).toHaveLength(1)
    const value = JSON.parse(harness.writes[0]!.value) as Record<string, unknown>
    // 旧推理凭据必须还在
    expect(value.access_token).toBe('sk-old')
    // 新登录态必须写进去
    expect(value.session_cookie).toContain('baizhi_session=NEW')
    // 昵称/用户 id 一并回填（用于卡片展示与账号判重）
    expect(value.nickname).toBe('新昵称')
    expect(value.user_id).toBe('u-1')
    // 池里的昵称也要更新
    expect(harness.updates[0]).toEqual({ id: 'baizhi-1', patch: { nickname: '新昵称' } })
  })

  it('缺 accountId / 账号不存在 ⇒ 明确的 RPC 错误（不能静默成功）', async () => {
    const harness = makeHarness({ accounts: [] })
    const missing = await harness.call('baizhi.startSession', {})
    expect(missing.ok).toBe(false)
    const notFound = await harness.call('baizhi.startSession', { accountId: 'nope' })
    expect(notFound.ok).toBe(false)
    expect(harness.loginCalls()).toBe(0)
  })
})
