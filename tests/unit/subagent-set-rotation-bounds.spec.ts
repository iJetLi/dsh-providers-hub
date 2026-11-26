/**
 * ★★★ **`account.setRotation` 位次越界必须报错**（2026-11-26 恢复守卫）
 *
 * ## 为什么需要补这条
 *
 * 上游在 PR #158 合并时如实登记：
 *
 * > 「**`account.setRotation` 位次越界报错**功能还在（`jet-hub-rpc.ts:8550`），
 * >   但 `ff7cf8f9` 重构删掉的 56 条 pin/userPicked 用例里包含它 ⇒ **已无守卫**。」
 *
 * ⇒ 实现还在，但**没有任何用例守着**。下次谁顺手删掉那段校验，
 *   症状是「用户选了一个永远不生效的位次，全程零报错」——正是该段注释记的坑。
 *
 * ## 判据为什么必须是**行为级**
 *
 * 「校验存在」可以被 `if (false && req.position > enabledCount)` 这种死分支满足。
 * ⇒ 本用例**真的发一次 RPC**（构造 `Request` 打进 handler），断言**响应体**。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import type { JetHubAuths } from '../../src/jet-hub-rpc.js'

/** 捕获 `connection.fetch.register` 注册进来的 handler。 */
type RegisteredHandler = { path: string, fetch: (req: Request) => Promise<Response> }

function makeHarness(options: {
  /** 池里「该 provider 的启用账号数」。 */
  enabledCount: number
  /** 记录 `setPreferredRotation` 是否被调用。 */
  onSetRotation?: (provider: string, sessionId: string, position: number | null) => void
}) {
  const handlers: RegisteredHandler[] = []

  /** 14 个 auth 的替身：本用例只需要它们存在（键要齐）。 */
  const stubAuth = {
    readCredential: async () => undefined,
    readStoredCredential: () => undefined,
    refreshStoredCredential: async () => undefined,
  }
  const auths = {
    codearts: stubAuth, buddy: stubAuth, workbuddy: stubAuth, lobsterai: stubAuth,
    qoder: stubAuth, qodercn: stubAuth, trae: stubAuth, cline: stubAuth,
    loomy: stubAuth, raccoon: stubAuth, minimax: stubAuth, minimaxintl: stubAuth,
    zcode: stubAuth, gemini: stubAuth, accio: stubAuth, autoclaw: stubAuth,
    autoclawintl: stubAuth, astudio: stubAuth,
  } as unknown as JetHubAuths

  const accounts = Array.from({ length: options.enabledCount }, (_, i) => ({
    id: `acct-${i + 1}`,
    provider: 'probe',
    enabled: true,
    credentialRef: `R-${i + 1}`,
  }))

  const pool = {
    listAllAccounts: async () => accounts,
    listAccountsByProvider: () => accounts,
    setPreferredRotation: async (provider: string, sessionId: string, position: number | null) => {
      options.onSetRotation?.(provider, sessionId, position)
    },
    preferredRotationFor: () => undefined,
    rotationStartTierFor: () => undefined,
    /** 其它被 handler 顺带碰到的方法，给最小实现。 */
    permanentLocked: () => false,
    subagentAssignmentOf: () => undefined,
    subagentRotationFor: () => undefined,
  }

  const ctx = new Context()
  ;(ctx as unknown as Record<string, unknown>).logger = {
    warn: () => {}, info: () => {}, error: () => {}, debug: () => {},
  }
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (h: RegisteredHandler) => { handlers.push(h); return () => {} },
    },
  }
  /**
   * ⚠️ **必须给 `ctx.inject` 装桩**：`registerJetHubRpc` 内部是
   * `ctx.inject(['connection'], (connectionCtx) => registerJetHubEndpoints(...))`。
   *
   * 真实 cordis 的 `inject` 要等依赖服务就绪才回调，而本用例的 ctx 是
   * 手工构造的 ⇒ 不装桩的话回调**永不触发** ⇒ `handlers` 恒空（我第一版就这么错：
   * 报「必须注册了一个 handler: expected 0 to be greater than 0」）。
   *
   * ⚠️ 写法与 `account-update-patch-whitelist.spec.ts` / `astudio-login-credits.spec.ts`
   *    同款（同步直接调回调，并传同一个 ctx）。
   */
  ;(ctx as unknown as Record<string, unknown>).inject = (
    _deps: string[],
    cb: (c: unknown) => void,
  ) => { cb(ctx) }

  registerJetHubRpc(ctx, pool as never, auths)

  return { handlers }
}

/** 真的发一次 RPC（走 `Request` → `Response`）。 */
async function callSetRotation(
  handler: RegisteredHandler,
  position: number,
  sessionId = 'sess-1',
): Promise<Record<string, unknown>> {
  const request = new Request('http://localhost/jet-hub', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      /**
       * ⚠️ `method` 必须是 **`JET_HUB_ENDPOINT`**（`'jet-hub'`，见 `jet-hub-rpc.ts:527`）。
       * 写成 `'jetHub.call'` 会被 handler 判成 `Invalid Jet Hub management request`
       * 并在**进入业务逻辑之前**就 `bad-request`（我第一版就这么错，
       * 结果「越界」那条**假绿**——它确实返回了 bad-request，但原因是格式不对）。
       */
      method: 'jet-hub',
      rpcId: 'rpc-1',
      payload: {
        method: 'account.setRotation',
        payload: { provider: 'probe', sessionId, position, tierAtSelection: 'imminent' },
      },
    }),
  })
  const response = await handler.fetch(request)
  const text = await response.text()
  const envelope = JSON.parse(text) as { result?: Record<string, unknown> }
  /**
   * ⚠️ 业务结果包在 **`result`** 里（见 `jet-hub-rpc.ts:14178`
   * 的 `Response.json({ type:'server-response', rpcId, result: value })`）。
   * 我第一版直接读顶层 `ok` ⇒ 恒 `undefined`。
   */
  return (envelope.result ?? {}) as Record<string, unknown>
}

describe('B：`account.setRotation` 位次越界必须报错（恢复被删的守卫）', () => {
  it('★★★ 位次超出启用账号数 ⇒ `bad-request`，且**不写盘**', async () => {
    /**
     * ## 缺陷形态（该段注释记的坑）
     *
     * 不校验的话，`setPreferredRotation` 会写入一个越界位次，
     * 而 `preferredRotationFor` 越界时**静默回落默认**
     * ⇒ 用户得到一个「选了永远不生效」的设置，**全程零提示**。
     *
     * ⚠️ 断言两件事：
     * 1. 返回 `ok: false` 且 code 是 `bad-request`（**不能是别的错**）
     * 2. `setPreferredRotation` **一次都没被调**（早退在写入之前）
     */
    let writes = 0
    const { handlers } = makeHarness({
      enabledCount: 3,
      onSetRotation: () => { writes += 1 },
    })
    expect(handlers.length, '必须注册了一个 handler').toBeGreaterThan(0)

    const res = await callSetRotation(handlers[0]!, 5)
    console.log('  [越界] 响应:', JSON.stringify(res).slice(0, 200))

    expect(res.ok, '★★★ 越界必须 ok:false').toBe(false)
    const error = res.error as { code?: string, message?: string } | undefined
    expect(error?.code, '★★★ 必须是 bad-request（不能是别的错误码）').toBe('bad-request')
    expect(error?.message, '★ 文案要点出「超出范围」').toContain('超出范围')
    expect(writes, '★★★ 越界时**不得写盘**（早退必须在 setPreferredRotation 之前）').toBe(0)
  })

  /**
   * ★★★ **非法位次的四个分支各锁一格**（2026-11-26 第五轮审计 B3-B6）。
   *
   * 审计实测：此前只测了「超界」和「恰好等于」两种，于是下面这些变异**全绿**：
   *
   * | 变异 | 修前 |
   * |---|---|
   * | 边界放宽一格（`> n` 而不是 `>= n`）| 绿 |
   * | 删掉「负位次」那一支 | 绿 |
   * | 删掉 `Number.isInteger` 那一支 | 绿 |
   * | `enabledCount` 忽略 `enabled` 标志 | 绿 |
   *
   * ⇒ 实现里其实四条都有（`jet-hub-rpc.ts` 的
   * `typeof req.position !== 'number' || !Number.isInteger(req.position) || req.position < 1`），
   * 只是**没有任何用例**。没有用例的分支等于可以随时被删掉而无人发现。
   *
   * ⚠️ 每个非法值都必须：① `ok:false`；② code 是 `bad-request`（不能是别的错）；
   *   ③ `setPreferredRotation` **一次都没被调**（早退在写入之前）。
   */
  it('★★★ 0 / 负数 / 非整数 / 非数字 ⇒ bad-request 且不写盘（四个分支各一格）', async () => {
    /**
     * ⚠️ **不能把 `NaN` 放进这个列表**：本用例走真 RPC（`Request` + `JSON.stringify`），
     * 而 `JSON.stringify({ position: NaN })` ⇒ `{"position":null}`，而 **`null` 是合法值**
     * （表示「清除位次」）。我第一版把它列进来，测试报「NaN 必须被拒 ⇒ 实际 ok:true」，
     * 看起来像代码缺陷，实际是**测具把非法值变成了合法值**。
     *
     * ⇒ 要测 NaN 得绕过 JSON（直接调 handler 并塞原始对象），那是另一条腿；
     *   这里只锁「能通过 JSON 表达」的非法值。
     */
    const illegal = [0, -1, 1.5, '2', true] as unknown as number[]
    for (const position of illegal) {
      let writes = 0
      const { handlers } = makeHarness({
        enabledCount: 3,
        onSetRotation: () => { writes += 1 },
      })
      const res = await callSetRotation(handlers[0]!, position)
      const error = res.error as { code?: string; message?: string } | undefined
      expect(res.ok, `position=${String(position)} 必须被拒`).toBe(false)
      expect(error?.code, `position=${String(position)} 必须是 bad-request`).toBe('bad-request')
      expect(writes, `position=${String(position)} 不得写盘`).toBe(0)
    }
  })

  it('★★★ 位次在范围内 ⇒ 正常写入（反向对照，证明上一条不是「一律拒绝」）', async () => {
    /**
     * ⚠️ **没有这条，上面那条的「拒绝」可能是别的原因导致的**（比如 handler 根本没跑）。
     */
    const written: Array<{ provider: string, sessionId: string, position: number | null }> = []
    const { handlers } = makeHarness({
      enabledCount: 3,
      onSetRotation: (provider, sessionId, position) => {
        written.push({ provider, sessionId, position })
      },
    })

    const res = await callSetRotation(handlers[0]!, 2)
    console.log('  [范围内] 响应:', JSON.stringify(res).slice(0, 160))

    expect(written.length, '★★★ 范围内必须真的写入一次').toBe(1)
    expect(written[0]!.position, '★ 写入的位次必须原样').toBe(2)
  })

  it('★★ 恰好等于启用账号数 ⇒ **允许**（边界，不能写成 `>=`）', async () => {
    /**
     * ⚠️ 位次是 1-based ⇒ 3 个号时位次 3 **合法**。
     * 写成 `>= enabledCount` 会把合法的最后一位也拒掉（用户会报「选最后一个不生效」）。
     */
    const written: number[] = []
    const { handlers } = makeHarness({
      enabledCount: 3,
      onSetRotation: (_p, _s, position) => { written.push(position as number) },
    })

    await callSetRotation(handlers[0]!, 3)
    expect(written, '★★ 位次 3（= 账号数）必须允许').toEqual([3])
  })
})
