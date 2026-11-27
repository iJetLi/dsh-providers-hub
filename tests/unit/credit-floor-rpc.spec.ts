/**
 * ★★★ **`credits.window.get` 必须回传两个阈值**（2026-11-27 上游审计 D2）
 *
 * ## 缺陷（审计原文）
 *
 * > 「`credits.window.get`/`set` 的响应（`types.ts:2408`）**不含 `floor`**
 * >  ⇒ **面板读回恒空**；且清除判据依赖 `saved` ⇒ **已存的阈值清不掉**
 * >  （清空/填 0 都不发 payload）」
 *
 * ## 为什么这条必须走真 RPC
 *
 * 纯函数测不到「handler 有没有把 `resolved.imminentFloor` 塞进响应」——
 * 那正是 D2 的形态（`resolveCreditWindow` 算对了，但 handler 没回传）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import type { JetHubAuths } from '../../src/jet-hub-rpc.js'

type Handler = { path: string, fetch: (req: Request) => Promise<Response> }

/** 真跑一次 RPC（`Request` → handler → 解析 `result`）。 */
async function callRpc(
  handler: Handler,
  method: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const req = new Request('http://localhost' + JET_HUB_API_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      /** ⚠️ 必须是 `'jet-hub'`（`JET_HUB_ENDPOINT`），否则被格式校验先拒。 */
      method: 'jet-hub',
      rpcId: 'rpc-1',
      payload: { method, payload },
    }),
  })
  const res = await handler.fetch(req)
  const env = JSON.parse(await res.text()) as { result?: Record<string, unknown> }
  return env.result ?? {}
}

/** 建一个抓 handler 的最小装配（真 pool 只要 creditWindow 一族）。 */
function makeHarness(initial: Record<string, unknown>) {
  const handlers: Handler[] = []
  /** 可变的窗口表。 */
  const windows: Record<string, Record<string, unknown>> = {}

  const stubAuth = {
    readCredential: async () => undefined,
    readStoredCredential: () => undefined,
  }
  const auths = {
    codearts: stubAuth, buddy: stubAuth, workbuddy: stubAuth, lobsterai: stubAuth,
    qoder: stubAuth, qodercn: stubAuth, trae: stubAuth, cline: stubAuth,
    loomy: stubAuth, raccoon: stubAuth, minimax: stubAuth, minimaxintl: stubAuth,
    zcode: stubAuth, gemini: stubAuth, accio: stubAuth, autoclaw: stubAuth,
    autoclawintl: stubAuth, astudio: stubAuth,
  } as unknown as JetHubAuths

  const pool = {
    /** ★ 关键：`creditWindow` 存在 ⇒ `safeCreditWindowReader` 能读到。 */
    creditWindow: (provider: string) => windows[provider],
    setCreditWindow: async (provider: string, setting: Record<string, unknown> | undefined) => {
      if (setting === undefined) delete windows[provider]
      else windows[provider] = setting
    },
    subagentRotationFor: () => undefined,
    listAllAccounts: async () => [],
    listAccountsByProvider: () => [],
    permanentLocked: () => false,
  }

  const ctx = new Context()
  ;(ctx as unknown as Record<string, unknown>).logger = {
    warn: () => {}, info: () => {}, error: () => {}, debug: () => {},
  }
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: { register: (h: Handler) => { handlers.push(h); return () => {} } },
  }
  /** ⚠️ 必须给 `ctx.inject` 装桩，否则回调不触发。 */
  ;(ctx as unknown as Record<string, unknown>).inject = (
    _d: string[], cb: (c: unknown) => void,
  ) => { cb(ctx) }

  registerJetHubRpc(ctx, pool as never, auths)

  /** 初始值。 */
  Object.assign(windows, initial)
  return { handlers }
}

describe('★★★ (D2) `credits.window.get` 回传阈值', () => {
  it('★★★ 已存阈值 ⇒ `get` 必须回传（否则面板恒空、且清不掉）', async () => {
    const { handlers } = makeHarness({
      buddy: { windowDays: 15, imminentDays: 5, imminentFloor: 20, expiringFloor: 30 },
    })
    expect(handlers.length, '必须注册了 handler').toBeGreaterThan(0)

    const result = await callRpc(handlers[0]!, 'credits.window.get', { provider: 'buddy' })
    console.log('  [get] ' + JSON.stringify(result))
    expect(result.ok, '★ 应成功').toBe(true)
    const value = result.value as Record<string, unknown> | undefined
    expect(value?.imminentFloor, '★★★ 必须回传 imminentFloor（审计 D2）').toBe(20)
    expect(value?.expiringFloor, '★★★ 必须回传 expiringFloor').toBe(30)
  })

  it('★★ 未设阈值 ⇒ 回传 `0`（不是 undefined，让面板判断统一）', async () => {
    const { handlers } = makeHarness({ buddy: { windowDays: 15 } })
    const result = await callRpc(handlers[0]!, 'credits.window.get', { provider: 'buddy' })
    const value = result.value as Record<string, unknown> | undefined
    /**
     * ⚠️ `ResolvedCreditWindow` 的两个 floor **恒为数字**（`toFloor` 归一化），
     * 故这里是 `0` 而不是 `undefined` —— 客户端据此统一判「关闭」。
     */
    expect(value?.imminentFloor, '★★ 未设 ⇒ 0').toBe(0)
    expect(value?.expiringFloor).toBe(0)
  })

  it('★★★ `set` 后 `get` 能读回阈值（往返）', async () => {
    const { handlers } = makeHarness({ buddy: { windowDays: 15 } })
    const setResult = await callRpc(handlers[0]!, 'credits.window.set', {
      provider: 'buddy', imminentFloor: 25,
    })
    expect(setResult.ok, '★ set 应成功').toBe(true)
    const setValue = setResult.value as Record<string, unknown> | undefined
    expect(setValue?.imminentFloor, '★★★ set 的返回也必须带（审计 D2）').toBe(25)

    const getResult = await callRpc(handlers[0]!, 'credits.window.get', { provider: 'buddy' })
    const getValue = getResult.value as Record<string, unknown> | undefined
    expect(getValue?.imminentFloor, '★★★ 往返后仍能读回').toBe(25)
    expect(getValue?.windowDays, '★★ 原有天数保留').toBe(15)
  })
})
