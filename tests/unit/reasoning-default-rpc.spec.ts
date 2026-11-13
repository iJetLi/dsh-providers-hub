/**
 * 「默认取最强思考档」的两个 RPC 端点（`reasoningDefault.getEnabled` /
 * `reasoningDefault.setEnabled`）—— 真跑 `registerJetHubRpc` 的 HTTP handler。
 *
 * ## 被锁死的缺陷（2026-11-13 两轮审计各自的 P1）
 *
 * 这两条 case 是 PR #70 **自己写在注释里的承诺**：
 * ① 「不做默认值猜测」—— `enabled` 不是布尔时必须 `bad-request`（否则
 *    `enabled: 'false'` 落进 `save()` 后 `sanitize` 判 `true` ⇒ 用户以为关了、
 *    其实开着）；
 * ② 「回读落盘值（而不是回传入参）」—— `save()` 被拒 / 另一实例并发写时，
 *    回传入参会向客户端返回一个**与磁盘不一致**的 `enabled` ⇒ 用户看到开关是开的、
 *    重启又变回关的，且**无任何提示**。
 *
 * 两轮审计实测：`grep -rn "reasoningDefault" tests/` 只命中**客户端**用例（注入的是
 * 假 `rpcCall`），这两个 handler **一次都没被执行过** —— 删掉校验、把回读改成回传入参，
 * 165 条定向用例全绿（M12 / M13）。
 *
 * ## 为什么必须走真实 handler
 *
 * 直接调 `createReasoningPreferenceStore` 只能证明「store 读写正确」，证明不了
 * 「RPC 层没有把入参当返回值」。故这里用**生产代码真实读取的路径**
 * `connection.fetch.register({ path, fetch })` 抓到 handler，再用真实 `Request`
 * 打进去（用错 API 的话端点根本没注册，`registerJetHubEndpoints` 只会记一条 warn
 * 后返回，用例便**静默恒绿** —— 与 `jet-hub-rpc-signature.spec.ts` 同一条纪律）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { resetReasoningPreferenceCache } from '../../src/reasoning-preferences.js'

const JET_HUB_ENDPOINT = 'jet-hub'

/** 端点路径 → handler（生产代码用 `connection.fetch.register` 注册）。 */
type Handler = (request: Request) => Promise<Response>

/**
 * 万用桩：注册阶段会摸 `pool` / `auths` 的很多成员，逐个手写既脆又长。
 *
 * ⚠️ 它**只**用于「注册能跑完」——本文件断言的两个 case 都不读 `pool`。
 */
function permissive(): unknown {
  return new Proxy(function permissiveTarget(): void { /* 被当函数调用时什么都不做 */ }, {
    get: () => permissive(),
    apply: () => undefined,
    has: () => true,
  })
}

function makeContext(): { ctx: never; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    // `connection` 由生产代码**惰性注入**（`ctx.inject(['connection'], …)`）挂载，
    // 不是插件级静态 inject；替身必须复刻这一机制，否则以 `ctx.inject is not a
    // function` 直接抛错。
    inject: (_deps: string[], cb: (c: unknown) => void) => cb(ctx),
    get: () => undefined,
    connection: {
      fetch: {
        register: (options: { path: string; fetch: Handler }) => {
          handlers.set(options.path, options.fetch)
        },
      },
    },
  }
  return { ctx: ctx as never, handlers }
}

/** 打一次真实 RPC，返回 `result`（`{ok, value?}` / `{ok:false, error}`）。 */
async function callRpc(
  handler: Handler,
  method: string,
  payload: unknown,
): Promise<{ ok: boolean; value?: Record<string, unknown>; error?: { code?: string; message?: string } }> {
  const response = await handler(new Request('http://127.0.0.1/api/jet-hub', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r1',
      method: JET_HUB_ENDPOINT,
      payload: { method, payload },
    }),
  }))
  expect(response.status, 'RPC 层必须回 200（错误走 result.ok）').toBe(200)
  const body = await response.json() as { type?: string; result?: { ok?: boolean } & Record<string, unknown> }
  expect(body.type, '必须是 server-response 信封').toBe('server-response')
  return body.result as { ok: boolean; value?: Record<string, unknown>; error?: { code?: string; message?: string } }
}

let stateDir = ''
let handlers: Map<string, Handler>

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dsh-reasoning-rpc-'))
  // 与生产同一条 home 解析入口（`resolveJetHubHome` 的第一优先级）
  process.env.DSH_JET_HUB_STATE_DIR = stateDir
  resetReasoningPreferenceCache()
  const made = makeContext()
  handlers = made.handlers
  registerJetHubRpc(made.ctx, permissive() as never, permissive() as never)
  // 前提自证：端点真的注册上了（否则下面每条都会 `handler` 为 undefined 而假绿）
  expect(handlers.has('/api/jet-hub'), '端点必须注册在 /api/jet-hub').toBe(true)
})

afterEach(() => {
  delete process.env.DSH_JET_HUB_STATE_DIR
  resetReasoningPreferenceCache()
  rmSync(stateDir, { recursive: true, force: true })
})

describe('★ reasoningDefault.getEnabled', () => {
  it('★★ 文档不存在 ⇒ 默认「开」（与 sanitize 的缺键语义一致）', async () => {
    const result = await callRpc(handlers.get('/api/jet-hub')!, 'reasoningDefault.getEnabled', {})
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ enabled: true })
  })

  it('⚠️ 文档损坏 ⇒ 仍回「开」，且不抛（坏的偏好不能让功能无声消失）', async () => {
    const handler = handlers.get('/api/jet-hub')!
    await callRpc(handler, 'reasoningDefault.setEnabled', { enabled: false })
    // 破坏文档（写进非 JSON）
    const file = join(stateDir, 'jet-hub', 'reasoning-preferences.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ not json', 'utf-8')
    resetReasoningPreferenceCache() // 模拟「重启后首次读」
    const result = await callRpc(handler, 'reasoningDefault.getEnabled', {})
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ enabled: true })
  })
})

describe('★★ reasoningDefault.setEnabled：契约三条', () => {
  it('★ 写入后 getEnabled 必须读到新值（真的落盘）', async () => {
    const handler = handlers.get('/api/jet-hub')!
    const set = await callRpc(handler, 'reasoningDefault.setEnabled', { enabled: false })
    expect(set.ok).toBe(true)
    expect(set.value).toEqual({ enabled: false })
    const got = await callRpc(handler, 'reasoningDefault.getEnabled', {})
    expect(got.value).toEqual({ enabled: false })
    // 真的写进了文件（不是只改内存）
    const raw = readFileSync(join(stateDir, 'jet-hub', 'reasoning-preferences.json'), 'utf-8')
    expect(JSON.parse(raw).strongestReasoningEnabled, '磁盘上的开关必须是 false').toBe(false)
  })

  it('★★ 「不做默认值猜测」：enabled 不是布尔 ⇒ bad-request，且不落盘', async () => {
    const handler = handlers.get('/api/jet-hub')!
    for (const bad of ['false', 0, 1, null, undefined, {}, []]) {
      const result = await callRpc(handler, 'reasoningDefault.setEnabled', { enabled: bad })
      expect(result.ok, `enabled=${JSON.stringify(bad)} 必须被拒`).toBe(false)
      expect(result.error?.code).toBe('bad-request')
    }
    // 反向对照：被拒之后读到的仍是默认「开」（没有被脏值写坏）
    const got = await callRpc(handler, 'reasoningDefault.getEnabled', {})
    expect(got.value).toEqual({ enabled: true })
  })

  it('★★ 响应必须回**落盘值**，不是入参（save 静默失败时能抓到）', async () => {
    const handler = handlers.get('/api/jet-hub')!
    // 先落一份 false，再让 save「不抛错但不落盘」—— 回传入参的实现会回 true
    await callRpc(handler, 'reasoningDefault.setEnabled', { enabled: false })
    const { FileReasoningStore } = await import('../../src/reasoning-preferences.js')
    const spy = vi.spyOn(FileReasoningStore.prototype, 'save').mockResolvedValue(undefined)
    try {
      const result = await callRpc(handler, 'reasoningDefault.setEnabled', { enabled: true })
      expect(result.ok).toBe(true)
      expect(
        result.value,
        'save 没生效时必须回「磁盘上的值」（false），回传入参就是「用户以为关了/开了但其实没变」',
      ).toEqual({ enabled: false })
    } finally {
      spy.mockRestore()
    }
  })
})
