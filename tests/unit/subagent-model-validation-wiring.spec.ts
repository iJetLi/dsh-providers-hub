/**
 * ★★★ **`credits.window.set` 的模型校验接线**（PR #154 双审 P1，两侧独立命中）。
 *
 * ## 缺陷
 *
 * 对抗审计实测：**删掉 `src/jet-hub-rpc.ts:13448-13477` 整段调用块，
 * `subagent-model-validation.spec.ts` 9/9 全绿、全量 15006 与基线逐行相同**
 * ⇒ 那个纯函数**抽了却可能没用上**，且**没有任何用例锁住接线**。
 *
 * 正向审计独立复现：把 `if (verdict !== undefined)` 改成 `if (false)` ⇒ 全量无一红。
 *
 * 这恰好是**本 PR 要消灭的那个问题的镜像**：
 *
 * > 原来「源码文本断言」无牙 ⇒ 作者抽了纯函数
 * > 现在「纯函数测试」有牙，但**接线本身无牙** ⇒ 删掉调用仍然全绿
 *
 * ## 本文件
 *
 * 从 **RPC 端点**出发（`credits.window.set`），用一个**非法模型 id** 打进去，
 * 断言它**真的被拒**。删掉调用块 ⇒ 本文件必红。
 *
 * ⚠️ `ctx` 必须带 `llm`：RPC 的校验条件是
 *    `if (rawSub.model !== undefined && ctx.llm !== undefined)`
 *    —— 没有 `llm` 就**整段跳过**（这也是为什么既有 `makeRpc` 抓不到）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { unwrapRpcResult } from '../../plugin-src/management-rpc.mjs'

const PROVIDER = 'probe'

/** 起一套真实 RPC 端点（真 AccountPool + 临时 state 目录 + **带 `llm` 的 ctx**）。 */
function makeRpcWithLlm(enabledModelIds: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'sub-val-'))
  const prev = process.env.DSH_JET_HUB_STATE_DIR
  process.env.DSH_JET_HUB_STATE_DIR = dir

  let handler: ((req: Request) => Promise<Response>) | undefined
  const ctx = {
    get: (key: string) => key === 'connection'
      ? { fetch: { register: (config: { path: string; fetch: typeof handler }) => {
          if (config.path === '/api/jet-hub') handler = config.fetch
        } } }
      : undefined,
    inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {} },
    credentials: { resolve: async () => undefined },
    emit: () => {},
    /**
     * ★ **目录替身**：只有 `enabledModelIds` 里的模型算「已启用」。
     * ⚠️ 两个方法都必须是 `async`（RPC 里 `await`）。
     */
    llm: {
      listModels: async (_p: string) => enabledModelIds.map((id) => ({ id })),
      resolveModelInfo: async (_p: string, modelId: string) =>
        (modelId === 'ok-model' ? { reasoning: { efforts: [{ id: 'high' }] } } : undefined),
    },
  }
  const pool = new AccountPool(ctx as never)
  registerJetHubRpc(ctx as never, pool, {})
  if (handler === undefined) throw new Error('端点未注册')

  return {
    pool,
    restore: () => {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    },
    rpcCall: async (method: string, payload: unknown) => {
      const res = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await res.json()
      return unwrapRpcResult(body.result)
    },
  }
}

describe('★★★ credits.window.set 的模型校验接线（PR #154 P1）', () => {
  let rpc: ReturnType<typeof makeRpcWithLlm>

  beforeEach(() => { rpc = makeRpcWithLlm(['ok-model']) })
  afterEach(() => { rpc.restore() })

  it('★★★ 非法模型 ⇒ **RPC 必须拒绝**（删掉调用块这条必红）', async () => {
    // ⚠️ 这条用例的全部意义：它走**真实 RPC 端点**，不是直接调纯函数。
    //    把 `src/jet-hub-rpc.ts` 里那段 `if (rawSub.model !== undefined && ctx.llm !== undefined) {…}`
    //    整块删掉 ⇒ 校验不发生 ⇒ 这里会**成功保存**而不是抛错 ⇒ 红。
    await expect(
      rpc.rpcCall('credits.window.set', {
        provider: PROVIDER,
        subagent: { model: 'NOT-AN-ENABLED-MODEL', startMode: 'sequence' },
      }),
    ).rejects.toThrow(/不在该渠道已启用的模型中/)
  })

  it('★★ 合法模型 ⇒ 不因「模型」被拒（校验放行）', async () => {
    // ⚠️ 反向对照：证明上面的红不是因为「整条 RPC 都拒绝 subagent 配置」。
    //    `ok-model` 在 `enabledModelIds` 里 ⇒ 不应触发「不在已启用模型」那条错误。
    const error = await rpc.rpcCall('credits.window.set', {
      provider: PROVIDER,
      subagent: { model: 'ok-model', startMode: 'sequence' },
    }).then(() => undefined).catch((e: unknown) => e as Error)
    expect(String(error?.message ?? '')).not.toContain('不在该渠道已启用的模型中')
  })

  it('★★ 目录读不到（`listModels` 抛错）⇒ **跳过存在性校验**，不拦保存', async () => {
    // 离线形态：`listEnabledModelIds` 的 catch 返回 undefined ⇒ 不校验。
    const offline = makeRpcWithLlm([])
    ;(offline as unknown as { pool: unknown }).pool // 保持引用
    // 重造一个 listModels 会抛的端点
    const dir = mkdtempSync(join(tmpdir(), 'sub-val-off-'))
    const prev = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = dir
    let handler: ((req: Request) => Promise<Response>) | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (c: { path: string; fetch: typeof handler }) => {
            if (c.path === '/api/jet-hub') handler = c.fetch
          } } }
        : undefined,
      inject: (_d: string[], cb: (c: unknown) => void) => { cb(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined },
      emit: () => {},
      llm: {
        listModels: async () => { throw new Error('offline') },
        resolveModelInfo: async () => { throw new Error('offline') },
      },
    }
    const pool = new AccountPool(ctx as never)
    registerJetHubRpc(ctx as never, pool, {})
    const res = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r', method: 'jet-hub',
        payload: { method: 'credits.window.set', payload: {
          provider: PROVIDER, subagent: { model: 'whatever', startMode: 'sequence' },
        } },
      }),
    }))
    const body = await res.json()
    const out = unwrapRpcResult(body.result) as { ok?: boolean } | undefined
    if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
    else process.env.DSH_JET_HUB_STATE_DIR = prev
    // 离线 ⇒ 校验跳过 ⇒ 不应是「不在已启用模型」那种拒绝
    expect(JSON.stringify(out)).not.toContain('不在该渠道已启用的模型中')
  })
})
