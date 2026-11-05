/**
 * ModelScope（魔搭）**本 fork 独有** provider 的行为守卫。
 *
 * 起因（2026-10-17 审计）：PR #110 把 18 张表全接对了、8806 条测试全绿，
 * 但**没有任何一条用例驱动过「用户添加第一个账号」那条链** ⇒
 * `handleModelscopeRpc` 零调用方、客户端弹窗零 import ⇒ 面板出现却永远加不了号。
 * 即本仓库记载的 failure-class #1「静默漏算」的完整复现。
 *
 * ## ⚠️ 本文件的三条判据各自独立打一种缺陷（都实测过「无守卫时全绿」）
 *
 * 1. 「登录 RPC 可达」——守 P0：客户端面板必须存在 modelscope 的添加入口，
 *    且宿主 `handleMethod` 必须在 `switch` 之前改道 `modelscope.` 前缀。
 * 2. 「错误分类」——守 P1/P2：context-window 不得被 `exceed` 抢成 quota；
 *    额度必须用字面量 `QUOTA_EXCEEDED`；abort 不得被换号吞掉。
 * 3. 「content-type 闸门」——守 P1：HTTP 200 + HTML 风控页不得被当成正常流。
 *
 * ⚠️ 判据一律打在**行为**上，不做源码正则断言（本仓库反复记录：源码文本断言
 * 对 `if (false)` 短路、死分支字面量等形态有假绿；办公 ace 那轮已改用 AST 判据）。
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classifyModelscopeError } from '../../src/modelscope-product.js'
import { handleModelscopeRpc } from '../../src/modelscope-rpc.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const read = (rel: string): string => readFileSync(REPO + rel, 'utf8')

describe('★ ModelScope 登录入口（2026-10-17 审计 P0）', () => {
  it('★ 宿主的 handleMethod 必须在 switch 之前改道 modelscope. 前缀', () => {
    const src = read('src/jet-hub-rpc.ts')
    // ⚠️ 判据是**相对位置**而非「出现过」：改道若排在 `switch (method)` 之后，
    //    方法名会被主 switch 的 default 吃掉（这正是 P0 的形态）。
    const branch = src.indexOf("method.startsWith('modelscope.')")
    const dispatch = src.indexOf('switch (method)')
    expect(branch, 'handleMethod 里没有 modelscope. 的改道分支 ⇒ addAccount 落进 default 回 unknown method')
      .toBeGreaterThan(-1)
    expect(branch, 'modelscope 改道分支必须排在主 switch 之前，否则永远匹配不到')
      .toBeLessThan(dispatch)
    // ⚠️ 且必须真调用 handleModelscopeRpc 并在 undefined 时让路（opencode 同款契约）。
    expect(src).toContain('handleModelscopeRpc')
  })

  it('★ 客户端必须 import 并渲染 ModelscopeKeyModal（否则 140 行是死代码）', () => {
    const client = read('plugin-src/client/jet-hub.js')
    // 三腿缺一即静默：import（否则不进 bundle）、createAccount 改道（否则走
    // account.create 回 unknown provider）、渲染分支（否则弹窗不出现）。
    expect(client, '客户端没有 import ModelscopeKeyModal ⇒ 弹窗文件永进不了 bundle')
      .toMatch(/import\s*\{[^}]*ModelscopeKeyModal[^}]*\}\s*from\s*'\.\/modelscope-key-modal\.js'/)
    expect(client, "createAccount 里没有 modelscope 的改道分支 ⇒ 落到 account.create 回 unknown provider: modelscope")
      .toMatch(/provider\s*===\s*'modelscope'/)
    expect(client, '弹窗渲染处没有 ModelscopeKeyModal ⇒ 改道后无 UI 可显示')
      .toContain('React.createElement(ModelscopeKeyModal')
  })

  it('★ 两个 key 弹窗必须按 provider 互斥渲染（否则会同时弹出两个）', () => {
    const client = read('plugin-src/client/jet-hub.js')
    // ⚠️ 方向性：两个分支都要**只认自己那一家**。两者共用一个 keyModal 状态位，
    //    任何一侧写成「排除别人」都会在边界情况（provider 为 undefined / 新增一家
    //    忘了加排除）同时渲染两层遮罩。
    //
    //    ⚠️⚠️ 2026-11-02 三审 E🔴-2 之后 opencode 分支改成了**白名单**
    //    （`keyModal.provider === 'opencode'`）—— 原来的「排除名单」写法让任何缺
    //    provider 的对象都落进 opencode（百智添加失败会弹出「添加 OpenCode 账号」，
    //    用户重填的 Key 就落错池）。所以这里断言的是**白名单**，不是排除。
    const opencodeBlock = client.slice(client.indexOf('React.createElement(OpencodeKeyModal') - 200, client.indexOf('React.createElement(OpencodeKeyModal'))
    expect(opencodeBlock, 'opencode 弹窗分支必须是白名单（只认自己的 provider）⇒ 否则缺 provider 的对象会落进来')
      .toMatch(/keyModal\s*&&\s*keyModal\.provider\s*===\s*'opencode'/)
    expect(opencodeBlock, 'opencode 分支不得回到「排除名单」写法')
      .not.toMatch(/keyModal\.provider\s*!==\s*'modelscope'/)
    const msBlock = client.slice(
      client.indexOf('React.createElement(ModelscopeKeyModal') - 200,
      client.indexOf('React.createElement(ModelscopeKeyModal'),
    )
    expect(msBlock, 'modelscope 弹窗分支未按 provider 分派')
      .toMatch(/keyModal\s*&&\s*keyModal\.provider\s*===\s*'modelscope'/)
  })

  it('handleModelscopeRpc 真把账号落进池与凭据（行为级，非源码断言）', async () => {
    const set = vi.fn(async () => {})
    const addAccount = vi.fn(async () => {})
    const pool = {
      listAccountsByProvider: () => [] as Array<{ id: string; enabled: boolean; credentialRef: string }>,
      addAccount,
    }
    const ctx = { credentials: { set } }
    const res = await handleModelscopeRpc(
      ctx as never,
      pool as never,
      'modelscope.addAccount',
      { apiKey: 'ms-0123456789abcdefghij' },
    )
    expect(res).toMatchObject({ ok: true, value: { existed: false } })
    // ⚠️ 凭据字段名必须是 `access_token`（AccountPool 身份反查靠它）。
    expect(JSON.parse(String(set.mock.calls[0]?.[1]))).toMatchObject({
      access_token: 'ms-0123456789abcdefghij',
    })
    // ⚠️ refreshable 必须是 false：魔搭没有 refresh 端点，标 true 是「永远不会
    //    发生的承诺」（loomy 同款诚实标记）。
    expect(addAccount.mock.calls[0]?.[0]).toMatchObject({ refreshable: false })
  })

  it('重复 Key 复用同一账号且不重复写凭据（existed:true）', async () => {
    const set = vi.fn(async () => {})
    const addAccount = vi.fn(async () => {})
    // ⚠️ id 由 Key **尾 8 位**派生（`modelscopeSlotNamesOf`：id = `modelscope-<尾8>`、
    //    ref = `MODELSCOPE_ACCOUNT_<尾8 大写>`）⇒ 桩里必须按同一规则构造 id。
    const key = 'ms-0123456789aaaaaaaa'
    const tail = key.slice(-8).toLowerCase()
    const pool = {
      listAccountsByProvider: () => [{ id: `modelscope-${tail}`, enabled: true, credentialRef: 'MODELSCOPE_ACCOUNT_A' }],
      addAccount,
    }
    const res = await handleModelscopeRpc(
      { credentials: { set } } as never,
      pool as never,
      'modelscope.addAccount',
      { apiKey: key },
    )
    expect(res).toMatchObject({ ok: true, value: { existed: true } })
    expect(addAccount, '重复 Key 不该新建账号').not.toHaveBeenCalled()
  })

  it('不认识的方法返回 undefined（契约：让主 switch 继续匹配，不得包成错误）', async () => {
    const res = await handleModelscopeRpc({} as never, {} as never, 'modelscope.nope', {})
    expect(res, '返回错误信封会把别的 provider 的方法误判成格式错误').toBeUndefined()
  })

  it('★ 端到端：经真实 registerJetHubRpc 驱动 modelscope.addAccount 不再 unknown', async () => {
    let handler: ((request: Request) => Promise<Response>) | undefined
    const ctx = {
      connection: { fetch: { register: (s: { path: string; fetch: (r: Request) => Promise<Response> }) => { if (s.path === JET_HUB_API_PATH) handler = s.fetch } } },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      credentials: { resolve: async () => undefined, describe: async () => ({ configured: false }), set: async () => {} },
      get: () => undefined,
      inject: (_d: string[], cb: (c: unknown) => void) => { cb(ctx) },
    }
    const pool = {
      listAccountsByProvider: () => [],
      addAccount: async () => {},
      listAllAccounts: async () => [],
      listAccounts: async () => [],
      updateAccount: async () => {},
    }
    registerJetHubRpc(ctx as never, pool as never, { modelscope: {} } as never)
    const res = await handler!(new Request('http://127.0.0.1/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method: 'modelscope.addAccount', payload: { apiKey: 'ms-0123456789abcdefghij' } },
      }),
    }))
    const body = await res.json() as { result: { ok: boolean; value?: unknown; error?: { message?: string } } }
    expect(body.result.ok, `modelscope.addAccount 未被改道：${body.result.error?.message ?? ''}`).toBe(true)
  })
})

describe('★ ModelScope 错误分类（2026-10-17 审计 P1/P2）', () => {
  // ⚠️ 这组判据的由来：quota 判据含 `exceed`、rate_limit 含 `throttl`，而分类表
  //    此前**没有 context_window 这一类** ⇒ 超限报文被抢走 ⇒ 账号被写冷却标记
  //    到次日 UTC+8 零点（用户只是消息太长）。
  const contextCases = [
    'maximum context length is 8192 tokens, prompt exceeds limit',
    'context window exceeded',
    'context limit throttling policy exceeded',
    'input tokens exceed model maximum',
    'Please reduce the length of the messages',
  ]
  for (const body of contextCases) {
    it(`上下文超限不得判成 quota / rate_limit：${body.slice(0, 40)}…`, () => {
      expect(classifyModelscopeError(400, body).kind, `被误判，真实报文：${body}`).toBe('context_window')
    })
  }
  it('context_window 不产出 retryAfterMs（超限不是配额问题，重试无意义）', () => {
    expect(classifyModelscopeError(400, 'context window exceeded', { 'retry-after': '600' }).retryAfterMs)
      .toBeUndefined()
  })

  // ⚠️ 真机取证（2026-10-17，无凭据 / 伪造 key 均得此报文，HTTP 401 + JSON）：
  it('★ 真实认证报文必须判成 auth（措辞是 "ModelScope token"，不含 api key）', () => {
    const body = '{"error":{"message":"Authentication failed, please make sure that a valid ModelScope token is supplied."}}'
    expect(classifyModelscopeError(401, body).kind).toBe('auth')
  })
  it('真实模型名错误报文必须判成 invalid_request（不得当成额度去换号）', () => {
    expect(classifyModelscopeError(400, '{"error":{"message":"Invalid model id: DeepSeek-V4-Flash-0731"}}').kind)
      .toBe('invalid_request')
  })
  it('额度报文仍判 quota（不得因新增 context_window 而被抢走）', () => {
    expect(classifyModelscopeError(402, 'insufficient balance').kind).toBe('quota')
  })
  it('限流报文仍判 rate_limit（不得因 context_window 前置而退化）', () => {
    expect(classifyModelscopeError(429, 'too many requests').kind).toBe('rate_limit')
  })
  // ⚠️⚠️ **反向判据（必须有牙）**：新增的 `context` + `limit` 组合判据存在
  //    「把真限流报文误吞成 context_window」的风险。若这条变红，说明该判据过宽。
  it('★ 真限流报文含 limit 但不含 context 时，不得被误判成 context_window', () => {
    for (const body of [
      'rate limit exceeded, retry later',
      'Request limit reached for this token',
      'Too many concurrent requests',
    ]) {
      expect(classifyModelscopeError(429, body).kind, `被误吞成 context_window：${body}`).toBe('rate_limit')
    }
  })
})

describe('★ ModelScope content-type 闸门（2026-10-17 审计 P1）', () => {
  it('★ HTTP 200 + text/html 风控页必须报「未返回事件流」，不得走到「额度用尽」', async () => {
    const { ModelscopeAdapter } = await import('../../src/modelscope-adapter.js')
    const { MODELSCOPE } = await import('../../src/modelscope-product.js')
    // ⚠️ 复现 P1 的形态：网关回 200 + HTML（风控拦截页）。修复前它会被喂进
    //    consumeOpenAiSse → 解析不出帧 → EMPTY_RESPONSE → status 0 → transport
    //    → 轮换把整个池打一遍 → 抛 QUOTA_EXCEEDED「所有账号均受限」。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>blocked</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })))
    const adapter = new ModelscopeAdapter({
      slots: async () => [{ id: 'a1', apiKey: 'ms-0123456789abcdefghij' }],
      product: MODELSCOPE,
      warn: () => {},
    } as never)
    let code: string | undefined
    let message = ''
    try {
      for await (const _ of adapter.stream({
        model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
        messages: [{ role: 'user', content: 'hi' }],
      } as never)) { /* 不应产出 */ }
    } catch (e) {
      code = (e as { code?: string }).code
      message = (e as Error).message
    } finally {
      vi.unstubAllGlobals()
    }
    // ⚠️ 核心断言：绝不能是 QUOTA_EXCEEDED（那会把用户引向错误的排障方向）。
    expect(code, `误报为额度耗尽：${message}`).not.toBe('QUOTA_EXCEEDED')
    expect(code).toBe('SERVER')
    expect(message).toContain('text/html')
  })
})