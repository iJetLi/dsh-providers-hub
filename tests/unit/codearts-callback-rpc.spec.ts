import { describe, expect, it } from 'vitest'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'

/**
 * `account.submitCallback` —— 「手动粘贴回调链接」的 RPC 接线。
 *
 * ## 为什么必须有这个文件
 *
 * PR #57 自带 27 条用例，但**全部只测 `src/login.ts` 的纯函数**：没有一条经过
 * RPC 层。对抗/正向两轮独立审计各自实证：把 `pendingCodeArtsCallbacks.set(...)`
 * 整行删掉、把失败分支改成静默 `ok:true`、把 `finally` 的清理删掉，
 * **全量 13203 条仍然全绿** —— 而功能已经彻底死亡（用户粘任何合法链接都被
 * 告知「这轮登录已经结束」，且重开一次登录也必然同样失败）。
 *
 * 本文件盯的是**接线**：四分支的行为，而不是 `login.ts` 里的解析正确性
 * （那个由 `codearts-manual-callback.spec.ts` 负责）。
 */
type Handler = (request: Request) => Promise<Response>

interface RpcEnvelope {
  ok: boolean
  error?: { code?: string; message?: string }
  value?: unknown
}

/**
 * 构造端点。
 *
 * `outcome` 是登录服务替身里 `submitManualCallback` 的返回值 —— 让用例能分别
 * 走「成功」与「登录服务报失败」两条腿。
 *
 * ⚠️ `startLogin().result` 用**永不落定**的 Promise：模拟用户还没在浏览器里
 * 完成授权。只有这样才能让「在途表」保持有值（`result` 一旦落定，
 * `.finally` 会把登记摘掉，后面的 `submitCallback` 就恒走「已经结束」分支，
 * 四条用例会退化成互相不可区分的同一条）。
 */
function registerSubmitEndpoints(outcome: { ok: boolean; message?: string }): {
  call: (method: string, payload: unknown) => Promise<RpcEnvelope>
  submitted: unknown[]
  /**
   * 让「在途登录」的 `result` **落定**。
   *
   * ⚠️ 不给这个口子的话，`result` 是永不落定的 Promise ⇒ RPC 层的
   * `.finally(() => pendingManualCallbacks.delete(id))` **永不执行** ⇒
   * 清理腿在任何用例里都是死代码（PR #58 对抗审计 M11a/M11b 实证：
   * 删掉两处 `.finally` 都是 13 条全绿）。
   */
  settle: () => void
} {
  let handler: Handler | undefined
  const submitted: unknown[] = []
  let settle: () => void = () => {}

  const makeAuth = (id: string) => ({
    async startLogin(): Promise<{
      loginUrl: string
      result: Promise<never>
      close: () => Promise<void>
      submitManualCallback: (raw: unknown) => { ok: boolean; message?: string }
    }> {
      return {
        loginUrl: `https://example.test/${id}/login`,
        result: new Promise<never>((_resolve) => {
          // 只记录句柄，不真的 resolve 成业务值：RPC 层只关心「有没有落定」。
          settle = () => { _resolve(undefined as never) }
        }),
        close: async () => {},
        submitManualCallback: (raw: unknown) => {
          submitted.push(raw)
          return outcome
        },
      }
    },
    async login(): Promise<never> {
      return new Promise<never>(() => {})
    },
  })

  const pool = {
    addAccount: async () => {},
    updateAccount: async () => {},
    removeAccount: async () => {},
    listAccounts: async () => [],
    listAccountsByProvider: async () => [],
    setQoderProxy: async () => {},
    getAvailableAccount: async () => undefined,
  }

  const ctx = {
    get: (key: string) => key === 'connection'
      ? {
          fetch: {
            register: (config: { path: string; fetch: Handler }) => {
              if (config.path === JET_HUB_API_PATH) handler = config.fetch
            },
          },
        }
      : undefined,
    inject: (_deps: string[], callback: (inner: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {} },
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
  }

  // 命名对象：键是 provider id（与 `src/jet-hub-rpc.ts` 的 auths 形状一致）。
  // 本组用例只触发 codearts 分支，其余给空对象（与既有 spec 同款）。
  registerJetHubRpc(ctx as never, pool as never, {
    codearts: makeAuth('codearts'),
    buddy: {} as never,
    workbuddy: {} as never,
    lobsterai: makeAuth('lobsterai'),
    qoder: makeAuth('qoder'),
    qodercn: {} as never,
    trae: makeAuth('trae'),
    cline: makeAuth('cline'),
    loomy: {} as never,
    raccoon: {} as never,
    minimax: {} as never,
    zcode: {} as never,
    gemini: {} as never,
    officeace: {} as never,
  } as never)
  if (handler === undefined) throw new Error('endpoint handler was not registered')

  const call = async (method: string, payload: unknown): Promise<RpcEnvelope> => {
    const response = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-1',
        method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    // ⚠️ 载体页把 RPC 结果包在 `result` 里（不是裸 envelope）；
    //    直接 `return await response.json()` 会让 `ok` 恒 `undefined`，
    //    四条用例会一起红在「expected undefined to be false」这种看不出所以然的地方。
    const body = await response.json() as { result: RpcEnvelope }
    return body.result
  }

  // ⚠️ 必须包一层：`settle` 在 `startLogin()` 被调用时才被赋值，
  //    直接 `return { …, settle }` 会在**返回那一刻**把默认的 no-op 存进对象，
  //    之后 `startLogin` 再怎么改局部变量都到不了调用方（我第一版就这么写的，
  //    表现为「settle 调了但 .finally 永不执行」）。
  return { call, submitted, settle: () => settle() }
}

/** 起一轮 codearts 登录，返回它发出的 `accountId`（在途表现已登记）。 */
async function createCodeartsLogin(
  call: (method: string, payload: unknown) => Promise<RpcEnvelope>,
): Promise<string> {
  const created = await call('account.create', { provider: 'codearts' })
  expect(created.ok).toBe(true)
  const accountId = (created.value as { accountId?: unknown } | undefined)?.accountId
  expect(typeof accountId).toBe('string')
  return accountId as string
}

describe('account.submitCallback（手动粘贴回调链接，PR #57 对抗审计 P1-a）', () => {
  it('★★ 未登记的 accountId ⇒ bad-request「这轮登录已经结束」（删 pendingCodeArtsCallbacks.set 就红）', async () => {
    const { call } = registerSubmitEndpoints({ ok: true })
    // 故意不先 create：在途表里没有这一项。
    const response = await call('account.submitCallback', {
      accountId: 'codearts-not-registered',
      callbackUrl: 'http://127.0.0.1:8080/oauth/callback?code=abc',
    })
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('bad-request')
    expect(response.error?.message ?? '').toContain('这轮登录已经结束')
  })

  it('★★ 空 accountId ⇒ bad-request「未指定账号 id」', async () => {
    const { call } = registerSubmitEndpoints({ ok: true })
    const response = await call('account.submitCallback', {
      accountId: '',
      callbackUrl: 'http://127.0.0.1:8080/oauth/callback?code=abc',
    })
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('bad-request')
    expect(response.error?.message ?? '').toContain('未指定账号 id')
  })

  it('★★ 登录服务报失败 ⇒ 原样下发 message（静默 ok:true 就红）', async () => {
    const { call, submitted } = registerSubmitEndpoints({
      ok: false,
      message: '不是合法的回调链接（缺少 code 参数）',
    })
    const accountId = await createCodeartsLogin(call)
    const response = await call('account.submitCallback', {
      accountId,
      callbackUrl: 'http://127.0.0.1:8080/oauth/callback',
    })
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('bad-request')
    expect(response.error?.message ?? '').toContain('不是合法的回调链接')
    // 原文必须真的交给了登录服务（而不是被 RPC 层吞掉后编一句新话）。
    expect(submitted).toEqual(['http://127.0.0.1:8080/oauth/callback'])
  })

  it('★★ 成功 ⇒ { ok:true, value:{ accepted:true } }', async () => {
    const { call } = registerSubmitEndpoints({ ok: true })
    const accountId = await createCodeartsLogin(call)
    const response = await call('account.submitCallback', {
      accountId,
      callbackUrl: 'http://127.0.0.1:8080/oauth/callback?code=abc',
    })
    expect(response).toEqual({ ok: true, value: { accepted: true } })
  })
  /**
   * ★★ TRAE 分支（PR #58）：`account.submitCallback` 现在服务两家，
   * 「TRAE 分支漏了 `pendingManualCallbacks.set`」与「codearts 分支」是
   * **两处独立代码**，只测 codearts 抓不到 TRAE 那处。
   */
  it('★★ trae 分支也必须在途表登记（删 TRAE 分支的 set 就红）', async () => {
    const { call, submitted } = registerSubmitEndpoints({ ok: true })
    const created = await call('account.create', { provider: 'trae' })
    expect(created.ok).toBe(true)
    const accountId = (created.value as { accountId?: unknown } | undefined)?.accountId
    expect(typeof accountId).toBe('string')
    const url = 'http://127.0.0.1:18080/authorize?refreshToken=RT-x&userInfo=%7B%7D&userJwt=%7B%7D'
    const response = await call('account.submitCallback', { accountId, callbackUrl: url })
    expect(response).toEqual({ ok: true, value: { accepted: true } })
    // 原文必须真的交给 TRAE 的登录服务（不是被 codearts 那个闭包接走）。
    expect(submitted).toEqual([url])
  })
  /**
   * ★★ 在途表必须随登录结束被清掉（PR #58 对抗审计 M11a / M11b）。
   *
   * 两处 `.finally(() => pendingManualCallbacks.delete(id))` 是**两段独立代码**
   * （codearts 分支 / trae 分支），所以用 `it.each` 各跑一遍 —— 只测一家
   * 抓不到另一家漏写。
   */
  it.each(['codearts', 'trae'] as const)(
    '★★ %s：登录落定后必须在途表条目被清掉（删该分支的 .finally(delete) 就红）',
    async (provider) => {
      const { call, settle } = registerSubmitEndpoints({ ok: true })
      const created = await call('account.create', { provider })
      expect(created.ok).toBe(true)
      const accountId = (created.value as { accountId?: unknown } | undefined)?.accountId
      expect(typeof accountId).toBe('string')
      settle()
      // 让 `.finally` 所在的微任务链跑完（then → catch → finally 至少 3 跳）；
      // 10ms 是实测够用的余量（纯 setTimeout(0) 在本机偶发不足）。
      await new Promise((resolve) => setTimeout(resolve, 10))
      const response = await call('account.submitCallback', {
        accountId,
        callbackUrl: 'http://127.0.0.1:18080/authorize?refreshToken=RT-late',
      })
      expect(response.ok).toBe(false)
      expect(response.error?.message ?? '').toContain('这轮登录已经结束')
    },
  )
})

