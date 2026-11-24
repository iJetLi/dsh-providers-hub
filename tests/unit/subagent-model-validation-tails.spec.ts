/**
 * ★★★ **PR #154 双审的三格遗留**（2026-11-24，上游原话）。
 *
 * > 「仍未覆盖的三格（如实登记，不在本 PR 范围）
 * >   1. **「同源 = `pool.listDisabledModels` 黑名单」** —— 判据被删时无守卫
 * >   2. **「非空串」** 仍在 RPC 内联、无行为用例（PR 前既有）
 * >   3. **「`enabledIds === undefined` 时连档位也跳过」** 这条腿无独立用例
 * >      （A 路 M6 变异仍绿）
 * >   这三格都在 `validateSubagentModelChoice` 的**上层**（RPC 内联逻辑 / 参数装配），
 * >   不在「抽纯函数」的范围内，**建议另开一条**。」
 *
 * 本文件就是那一条。
 *
 * ## ⚠️ 为什么必须走**真实 RPC 端点**
 *
 * 上面三格全在 `credits.window.set` 的**参数装配**里 ——
 * 纯函数拿到的已经是「过滤好的 id 列表」。
 * ⇒ 直接调纯函数**永远测不到**「黑名单有没有被应用」。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { unwrapRpcResult } from '../../plugin-src/management-rpc.mjs'

const PROVIDER = 'probe'

/** 每个用例的临时 home，统一清理。 */
const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

/**
 * 起一套真实 RPC 端点（真 `AccountPool` + 临时 state 目录 + 带 `llm` 的 ctx）。
 *
 * @param options.enabledModelIds - `listModels` 返回的目录
 * @param options.effortsOf - 按模型给 `resolveModelInfo` 的 `reasoning.efforts`
 * @param options.listModelsThrows - `listModels` 抛错（模拟离线）
 * @param options.beforeRegister - 注册端点**之前**对 pool 做的准备（如拉黑模型）
 */
function makeRpc(options: {
  enabledModelIds: readonly string[]
  effortsOf?: Record<string, readonly string[]>
  listModelsThrows?: boolean
  beforeRegister?: (pool: AccountPool) => void
}) {
  const dir = mkdtempSync(join(tmpdir(), 'sub-tails-'))
  tmpDirs.push(dir)
  const prev = process.env.DSH_JET_HUB_STATE_DIR
  process.env.DSH_JET_HUB_STATE_DIR = dir

  let handler: ((req: Request) => Promise<Response>) | undefined
  const ctx = {
    get: (key: string) => key === 'connection'
      ? {
        fetch: {
          register: (config: { path: string; fetch: typeof handler }) => {
            if (config.path === '/api/jet-hub') handler = config.fetch
          },
        },
      }
      : undefined,
    inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {} },
    credentials: { resolve: async () => undefined },
    emit: () => {},
    llm: {
      listModels: async (_p: string) => {
        if (options.listModelsThrows === true) throw new Error('offline')
        return options.enabledModelIds.map((id) => ({ id, name: id }))
      },
      resolveModelInfo: async (_p: string, modelId: string) => {
        const efforts = options.effortsOf?.[modelId]
        return efforts === undefined ? undefined : { reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } }
      },
    },
  }
  const pool = new AccountPool(ctx as never)
  options.beforeRegister?.(pool)
  registerJetHubRpc(ctx as never, pool, {})
  if (handler === undefined) throw new Error('端点未注册')

  const restore = () => {
    if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
    else process.env.DSH_JET_HUB_STATE_DIR = prev
  }

  return {
    pool,
    restore,
    /**
     * 调端点，返回 `{ error }` —— **绝不抛**。
     *
     * ⚠️ `unwrapRpcResult` 对 `ok:false` 会 **throw**（那是给客户端的契约），
     *    而本文件要断言「错误文案」，故必须在这里 catch 成普通返回值。
     *
     * ⚠️ 我第一版没 catch ⇒ 4 条用例全报 `rejects` 风格失败，
     *    但那其实是**用例抓到了正确错误**、只是包装方式不对。
     */
    call: async (subagent: Record<string, unknown>) => {
      try {
        const res = await handler!(new Request('http://localhost/api/jet-hub', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
            payload: { method: 'credits.window.set', payload: { provider: PROVIDER, subagent } },
          }),
        }))
        const body = await res.json()
        return unwrapRpcResult(body.result) as { ok?: boolean; error?: { message?: string } } | undefined
      } catch (error) {
        /** Endpoint 拒绝 ⇒ 把 message 包成同样的形状，便于统一断言。 */
        return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
      } finally {
        restore()
      }
    },
  }
}

// ============================================================================
// 格 1：「同源 = pool.listDisabledModels 黑名单」
// ============================================================================
describe('格1：模型校验必须真的读黑名单（同源 listDisabledModels）', () => {
  it('★★★ 模型在目录里但**被用户拉黑** ⇒ 必须拒绝', async () => {
    /**
     * ## 这一格守什么
     *
     * RPC 的参数装配是：
     *
     * ```ts
     * const disabledForProvider = pool.listDisabledModels(req.provider)
     * return all.filter((m) => disabledForProvider[m.id] !== true).map((m) => m.id)
     * ```
     *
     * ⇒ 把 `.filter(...)` 那一行**删掉**，`enabledIds` 就变成「目录里全部」，
     *    拉黑的模型也能通过校验。
     *
     * ⚠️ 这**不是假想**：`credits.window.models`（下拉框）也读黑名单，
     *    两处不同源就会出现「下拉框里没有、手改 state.json 却能存进去」。
     */
    const rpc = makeRpc({
      enabledModelIds: ['ok-model', 'blacklisted-model'],
      beforeRegister: (pool) => {
        /** ⚠️ 用 pool 的公开接口把它拉黑（与设置页同一条链路）。 */
        pool.setModelDisabled(PROVIDER, 'blacklisted-model', true)
      },
    })

    const out = await rpc.call({ model: 'blacklisted-model', startMode: 'sequence' })
    expect(
      out?.error?.message ?? '',
      '★★★ 被拉黑的模型必须拒绝（删掉 .filter 这行必红）',
    ).toContain('不在该渠道已启用的模型中')
  })

  it('★★ 同目录里**未拉黑**的模型 ⇒ 通过（反向对照）', async () => {
    /** ⚠️ 证明上面的红不是因为「整条 RPC 拒绝一切」。 */
    const rpc = makeRpc({
      enabledModelIds: ['ok-model', 'blacklisted-model'],
      beforeRegister: (pool) => {
        pool.setModelDisabled(PROVIDER, 'blacklisted-model', true)
      },
    })

    const out = await rpc.call({ model: 'ok-model', startMode: 'sequence' })
    expect(
      out?.error?.message ?? '',
      '★★ 未拉黑的模型不该被拒',
    ).not.toContain('不在该渠道已启用的模型中')
  })
})

// ============================================================================
// 格 2：「非空串」内联校验
// ============================================================================
describe('格2：「非空串」校验必须有行为用例', () => {
  it('★★★ 空串模型 ⇒ 必须拒绝（内联校验真的在跑）', async () => {
    /**
     * ⚠️ 这一格是 **PR 前既有**的内联逻辑：
     *
     * ```ts
     * if (value !== undefined && (typeof value !== 'string' || value.length === 0)) → bad-request
     * ```
     *
     * 它此前**没有任何行为用例** —— 删掉这两个判断也不会红。
     */
    const rpc = makeRpc({ enabledModelIds: ['ok-model'] })
    const out = await rpc.call({ model: '', startMode: 'sequence' })
    expect(
      out?.error?.message ?? '',
      '★★★ 空串模型必须被拒（删掉内联判断必红）',
    ).toContain('必须是非空字符串')
  })

  it('★★ 空串思考档位 ⇒ 同样拒绝', async () => {
    const rpc = makeRpc({ enabledModelIds: ['ok-model'], effortsOf: { 'ok-model': ['high'] } })
    const out = await rpc.call({ model: 'ok-model', reasoningEffort: '', startMode: 'sequence' })
    expect(
      out?.error?.message ?? '',
      '★★ 空串档位必须被拒',
    ).toContain('必须是非空字符串')
  })
})

// ============================================================================
// 格 3：「enabledIds === undefined 时连档位也跳过」
// ============================================================================
describe('格3：目录读不到时，连档位校验也必须跳过', () => {
  it('★★★ `listModels` 抛错 ⇒ 非法档位**也不拦**（校验整体跳过）', async () => {
    /**
     * ## 这一格守什么（上游原话：「A 路 M6 变异仍绿」）
     *
     * 纯函数里那条腿是：
     *
     * ```ts
     * if (input.reasoningEffort === undefined || enabledIds === undefined) return undefined
     * ```
     *
     * ⚠️ 只测「`reasoningEffort === undefined`」测不到「`enabledIds === undefined`」
     * —— 必须**同时**满足「配了档位」+「目录读不到」才走到那半边。
     *
     * 把 `|| enabledIds === undefined` 删掉 ⇒ 本用例变红（会去查档位并拒绝）。
     */
    const rpc = makeRpc({
      enabledModelIds: ['ok-model'],
      /** ⚠️ 目录**读不到**（离线）。 */
      listModelsThrows: true,
      /** ⚠️ 但档位查得到，且配的是非法档位 —— 若还去查就会拒。 */
      effortsOf: { 'ok-model': ['low', 'high'] },
    })

    const out = await rpc.call({
      model: 'ok-model',
      reasoningEffort: 'NOT-A-VALID-EFFORT',
      startMode: 'sequence',
    })
    expect(
      out?.error?.message ?? '',
      '★★★ 目录读不到时档位也必须跳过（删掉 || enabledIds === undefined 必红）',
    ).not.toContain('合法档位')
  })

  it('★★ 目录**读得到**时，同一非法档位必须拒绝（反向对照）', async () => {
    /** ⚠️ 证明上一条的绿不是因为「档位校验整个不存在」。 */
    const rpc = makeRpc({
      enabledModelIds: ['ok-model'],
      effortsOf: { 'ok-model': ['low', 'high'] },
    })

    const out = await rpc.call({
      model: 'ok-model',
      reasoningEffort: 'NOT-A-VALID-EFFORT',
      startMode: 'sequence',
    })
    expect(
      out?.error?.message ?? '',
      '★★ 目录正常时非法档位必须被拒',
    ).toContain('合法档位')
  })
})
