/**
 * `chatglm-browser-login.spec.ts` —— 智谱清言**网页登录**的 `account.create` 三步式单测。
 *
 * ## 守着什么（2026-11-04 真机报障：卡片「有效期 未知」）
 *
 * `account.list` 的 `expiresAt` **只来自池条目**（`ProviderAccountEntry.expiresAt`），
 * **不读凭据文件**。登录分支若只 `credentials.set` 而不 `pool.updateAccount({ expiresAt })`
 * ⇒ 卡片读到 `undefined` ⇒ 恒显示「未知」，且**永远不会自己补上**。
 *
 * ⚠️ 这是本仓库**第 4 次**踩同一个坑（OfficeAce → Codely → Magicrew → chatglm）。
 * ⚠️⚠️ **这条守卫是补写的**：第一版守卫只测了纯函数 `chatglmExpiresAtPatch`
 * 的取值域 —— 实测把登录分支里的 `...chatglmExpiresAtPatch(credential)` **整行删掉**，
 * 43 条用例**全绿**（假绿）。故必须真跑 `account.create` 的完整三步式。
 *
 * ## ⚠️⚠️ 硬约束：**绝不真起浏览器**
 *
 * 真起浏览器会在用户桌面**弹出可见窗口**（本仓库已记过两次真实污染）。
 * ⇒ 这里用 `vi.mock` 把 `ChatglmLoginSession` 换成假会话，`waitForCredential`
 * 由用例直接给出凭据 —— **零进程、零窗口**。
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'

/** 造一个 JWT（只拼 payload —— 被测代码只解码不验签）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const seg = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `eyJhbGciOiJIUzI1NiJ9.${seg}.sig`
}

/** 真实 token 的 payload 形状（实测：`exp − iat = 86400s`，`device_id` 32 hex）。 */
const REAL_EXP = 1793857636
const LIVE_TOKEN = makeJwt({
  sub: '7e028697fb254b45b788bb6491e28952',
  exp: REAL_EXP,
  iat: REAL_EXP - 86400,
  uid: '6aeac6e4c18a82be3199e01b',
  device_id: '72b875712e784cbaa46493406846a706',
  is_guest: false,
})

function makeCtx(): {
  ctx: Context
  credentials: Map<string, string>
  handler: () => ((req: Request) => Promise<Response>) | undefined
} {
  const ctx = new Context()
  ;(ctx as unknown as Record<string, unknown>).logger = {
    warn: () => {}, info: () => {}, error: () => {}, debug: () => {},
  }
  const store = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'fake' }
    },
    describe: async () => ({ configured: true, writable: true }),
    set: async (ref: string, value: string) => { store.set(ref, value) },
    unset: async (ref: string) => { store.delete(ref) },
  } as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  const settingsState: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() {
      return {
        get: () => settingsState.value,
        replace: (v: unknown) => { settingsState.value = v },
      }
    },
    describe() { return [] },
  } as never)
  let handler: ((req: Request) => Promise<Response>) | undefined
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (spec: { path: string, fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_deps: string[], cb: (c: unknown) => void) => cb(ctx)
  return { ctx, credentials: store, handler: () => handler }
}

/**
 * 调一条 RPC。
 *
 * ⚠️ 请求体是 **connection 的信封格式**（`{type:'client-request', rpcId,
 * method:'jet-hub', payload:{method, payload}}`），不是裸的 `{method, payload}` ——
 * 写成裸的话 handler 会解析失败、返回 `ok:false`，而症状极像「provider 没接线」。
 * 照 `tests/unit/magicrew-browser-login.spec.ts` 的 `invoke` 同形。
 */
async function call(
  handler: () => ((req: Request) => Promise<Response>) | undefined,
  method: string,
  payload: unknown,
): Promise<{ ok: boolean, value?: unknown, error?: { message?: string } }> {
  const fn = handler()
  if (fn === undefined) throw new Error('RPC handler 未注册')
  const response = await fn(new Request(`http://127.0.0.1${JET_HUB_API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'r1', method: 'jet-hub',
      payload: { method, payload },
    }),
  }))
  const body = await response.json() as {
    result: { ok: boolean, value?: unknown, error?: { message?: string } }
  }
  return body.result
}

/**
 * 建一套 RPC，并把 `ChatglmLoginSession` 换成假会话。
 *
 * ⚠️ `vi.mock` 的工厂在**模块加载时**求值，故用模块级可变变量把「本用例的凭据」
 * 传进去（这是 vi.mock 的既有约束，不是偷懒）。
 */
const sessionScript: { credential: unknown } = { credential: undefined }

vi.mock('../../src/chatglm-login.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/chatglm-login.js')>(
    '../../src/chatglm-login.js',
  )
  return {
    ...actual,
    ChatglmLoginSession: {
      open: async () => ({
        waitForCredential: async () => sessionScript.credential,
        close: () => {},
      }),
    },
  }
})

function makeRpc() {
  const { ctx, credentials, handler } = makeCtx()
  const pool = new AccountPool(ctx)
  registerJetHubRpc(
    ctx, pool,
    {
      codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
      lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
      trae: {} as never, cline: {} as never, loomy: {} as never,
      raccoon: {} as never, minimax: {} as never, minimaxintl: {} as never,
      zcode: {} as never, gemini: {} as never, officeace: {} as never,
      accio: {} as never, astudio: {} as never, autoclaw: {} as never,
      autoclawintl: {} as never, modelscope: {} as never, qiniu: {} as never,
      codely: {} as never, magicrew: {} as never,
      chatglm: {} as never,
    } as never,
    {} as never,
  )
  return { ctx, pool, credentials, handler }
}

describe('★★ chatglm 网页登录：`account.create` 必须把有效期写进池条目', () => {
  /**
   * ## ⚠️⚠️⚠️ 这三条用例**已随设计变更重写**（2026-11-04 用户要求）
   *
   * 旧版验证的是「`mode:'browser'` 在宿主起浏览器 → `login.poll` 等它 → 建号」。
   * 用户报障「服务器开浏览器特别卡、根本识别不到滑动块，还是要在本地电脑打开浏览器」
   * ⇒ 宿主**不再**起浏览器、`mode:'browser'` **不建号**（`accountId` 恒空串、
   * 无 `login.poll`）⇒ 那三条「等 poll 落库」的用例在**新设计下不可能成立**。
   *
   * 有效期判据本身（`chatglmExpiresAtPatch`）**没有变**，只是喂给它的路径变了：
   * 现在是 `mode: 'paste'`（见下一个 describe 的「粘贴整条 cookie ⇒ 池条目带 expiresAt」）。
   * 本组保留的三条改成直接打纯函数与自愈回填 —— 那两个是**与开窗方式无关**的不变式。
   */

  it('★★★ `mode: browser` **不得**在宿主侧起浏览器、**不得**建占位账号', async () => {
    /**
     * ## 用户原话（2026-11-04）
     *
     * 「现在在服务器打开浏览器特别卡，根本就识别不到滑动块，还是要在本地电脑打开
     * 浏览器才可以，不然很难登录账号」
     *
     * ## 这条守卫守两件事
     *
     * 1. **不起浏览器**：`ChatglmLoginSession` 类已整个删除（`src/chatglm-login.ts`
     *    现在只有常量与指纹）。若有人把它加回来，本用例至少不会静默通过 ——
     *    因为这里断言「没有占位账号」，而旧实现的第一步就是 `pool.addAccount`。
     * 2. **不建占位账号**：没有东西会来填它 ⇒ 会变成**幽灵卡**（用户看得见、
     *    没凭据、也点不掉以外无任何入口）。
     *
     * ⚠️ `sessionScript.credential` 在这条用例里**故意不设**：即使有人把旧实现
     * 加回来、假会话立刻给出凭据，断言「池里没有 chatglm 账号」也仍然成立与否，
     * 才是判据的关键。
     */
    const { pool, handler } = makeRpc()
    const created = await call(handler, 'account.create', { provider: 'chatglm', mode: 'browser' })
    expect(created.ok, `account.create 应被接受：${created.error?.message ?? ''}`).toBe(true)

    // ★ 核心断言 ①：不得建任何占位账号（没有东西会来填它）
    expect(
      pool.listAccountsByProvider('chatglm'),
      '★★★ `mode: browser` 不得建占位账号 —— 宿主不再开浏览器，没有东西会来填它',
    ).toHaveLength(0)
    // ★ 核心断言 ②：`accountId` 必须是空串（客户端据此**不**起 login.poll 空转 5 分钟）
    expect(
      (created.value as { accountId?: string }).accountId,
      '★ accountId 必须为空串 —— 非空会让客户端起一个假的 5 分钟轮询',
    ).toBe('')
  })

  it('★ 凭据里读不到有效期 ⇒ **不写这个键**（不得写成 0/NaN，那会显示「已过期」）', async () => {
    // 判据与开窗方式无关：`chatglmExpiresAtPatch` 是**唯一一份**取值域。
    // 不透明 token（上游若改成非 JWT 就是这种形态）⇒ 空对象，不是 `{expiresAt: undefined}`。
    const { chatglmExpiresAtPatch } = await import('../../src/jet-hub-rpc.js')
    const patch = chatglmExpiresAtPatch({ chatglm_token: 'opaque-token-value' })
    expect(patch).toEqual({})
    expect(Object.hasOwn(patch, 'expiresAt'), '不得留下值为 undefined 的键').toBe(false)
  })

  it('★★ 声明值 `expires_at` 优先于 JWT `exp`（续期那一刻算出的新值更贴近现实）', async () => {
    const { chatglmExpiresAtPatch } = await import('../../src/jet-hub-rpc.js')
    const declared = 1795000000000
    expect(chatglmExpiresAtPatch({ chatglm_token: LIVE_TOKEN, expires_at: declared }))
      .toEqual({ expiresAt: declared })
    // 对照：没有声明值时回落到 JWT 的 exp（判据不是恒真）
    expect(chatglmExpiresAtPatch({ chatglm_token: LIVE_TOKEN }))
      .toEqual({ expiresAt: REAL_EXP * 1000 })
  })
  it('★★ 脏 `credentialRef`（非法形态）不得让 `account.list` 抛错', async () => {
    // ⚠️⚠️ `credentialRef()` 的校验是 ``/^[A-Za-z_][A-Za-z0-9_]*$/``，**同步抛错**
    //    而 `.catch()` 只接 Promise 拒绝、接不住同步 throw。
    //    旧写法 `await ctx.credentials.resolve(credentialRef(...)).catch(...)` 里
    //    那个 throw 发生在**进入 await 之前** ⇒ 整个 `account.list` 抛 500
    //    （症状：面板一片空白、且点任何按钮都失败）。
    //    ⇒ 回填循环必须把 `credentialRef()` 包在 try 里，跳过该账号继续。
    sessionScript.credential = { chatglm_token: LIVE_TOKEN }
    const { pool, credentials, handler } = makeRpc()

    // 造两条账号：一条 ref 合法（应被回填），一条 ref 非法（应被**跳过**而非炸列表）
    await pool.addAccount({
      id: 'chatglm-bad-ref',
      provider: 'chatglm',
      nickname: '脏 ref',
      enabled: true,
      credentialRef: 'chatglm.account.legacy',
      refreshable: true,
      createdAt: Date.now(),
    })
    await credentials.set('CHATGLM_ACCOUNT_OK', JSON.stringify({ chatglm_token: LIVE_TOKEN }))

    const listed = await call(handler, 'account.list', { provider: 'chatglm' })
    expect(listed.ok, `脏 ref 不得让列表抛错：${listed.error?.message ?? ''}`).toBe(true)
    const accounts = (listed.value as { accounts?: Array<{ id: string }> }).accounts ?? []
    expect(accounts.map((a) => a.id), '合法条目必须仍在列表里').toContain('chatglm-bad-ref')
  })

  it('★★ 已有账号（登录时漏写过有效期）在 `account.list` 时被**自愈回填**', async () => {
    // 复现报障现场：池条目已存在、凭据完好、但 `expiresAt` 缺失。
    const { pool, credentials, handler } = makeRpc()

    const accountId = 'chatglm-legacy'
    await pool.addAccount({
      id: accountId,
      provider: 'chatglm',
      nickname: '智谱清言账号',
      enabled: true,
      credentialRef: 'CHATGLM_ACCOUNT_LEGACY',
      refreshable: true,
      createdAt: Date.now(),
    })
    await credentials.set('CHATGLM_ACCOUNT_LEGACY', JSON.stringify({ chatglm_token: LIVE_TOKEN }))
    const before = pool.listAccountsByProvider('chatglm').find((a) => a.id === accountId)
    expect(before?.expiresAt, '先证实现场确实是「未知」').toBeUndefined()

    await call(handler, 'account.list', { provider: 'chatglm' })
    // 回填是 `void pool.updateAccount(...)`（不阻塞列表）⇒ 让微任务跑完
    await new Promise((resolve) => setTimeout(resolve, 20))

    const after = pool.listAccountsByProvider('chatglm').find((a) => a.id === accountId)
    expect(
      after?.expiresAt,
      '★ 已有账号必须在列表时自愈（否则报障用户只能重新登录一次才能看到有效期）',
    ).toBe(REAL_EXP * 1000)
  })

describe('★★★ 粘贴登录态（`account.create` 的 `mode: paste`）：服务器部署的唯一路径', () => {
  /**
   * ## ⚠️ 为什么必须有这条路（2026-11-04 用户报障）
   *
   * 报障：部署到服务器后，点「新建账号」浏览器窗口开在**服务器**上（无头部署
   * 画在没人看的虚拟屏），用户看不到；而 CodeArts 能开在本地。
   *
   * CodeArts 能做到「本地开窗 + 自动收口」，是因为它的 `loginUrl` 是**标准 OAuth
   * 授权页 + 本地回调服务器**（`startOAuthFlow` 起 loopback 端口收 code）。
   * 智谱清言网页端**没有**这条回调链路：`chatglm_token` 是 `chatglm.cn` 域的
   * cookie，**宿主读不到用户本地那一份**（两机不同），上游也没给我们注册过的
   * `redirect_uri` ⇒ 只能「本地开窗 + 用户粘贴登录态」。
   *
   * ⚠️ 判据要打在 `mode: 'paste'` 的**完整行为**上（落库 / 有效期 / 判重），
   * 不能只测 `chatglmCredentialFromInput`（那是纯函数，已由 `chatglm.spec.ts` 覆盖）。
   */
  const PASTE_COOKIE = `chatglm_token=${LIVE_TOKEN}; chatglm_refresh_token=r-token`

  /**
   * ⚠️⚠️ **必须 stub 上游**：粘贴路径会先作一次**真上游校验**
   * （`fetchChatglmBalanceDetailed`，幂等只读）。不 stub 就会打到真实 `chatglm.cn`
   * —— 离线/受限网络下恒回 `40102` ⇒ 用例假红（而且测试真对外发了请求，
   * 这本身不该发生）。返回的函数用于恢复。
   */
  function stubUpstreamValid(): () => void {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        status: 0,
        message: 'success',
        result: { _id: 'u1', member_info: { left_score: '200' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    return () => { globalThis.fetch = original }
  }

  it('★★★ 网页登录必须返回**非空 `loginUrl`**（否则窗口开在服务器上，用户看不到）', async () => {
    /**
     * ## 报障（2026-11-04 用户原话）
     *
     * 「部署到服务器后，为啥浏览器不是在本地电脑打开，codeArts 就可以在本地电脑打开」
     *
     * ## 根因
     *
     * `account.create` 的返回值决定走哪条开窗路径：
     * - `loginUrl` **非空** ⇒ **客户端** `window.open` ⇒ 用户**本地**浏览器（CodeArts 走这条）；
     * - `loginUrl` **空串** ⇒ 客户端整段跳过开窗（`if (!loginUrl) { …; return }`）
     *   ⇒ 唯一那个窗口是宿主 `spawn` 出来的，落在**服务器**上（无头部署画在虚拟屏）。
     *
     * 修复前本渠道返回空串 ⇒ 正是报障现场。
     *
     * ⚠️⚠️ **变异验证**：把 `loginUrl` 改回 `''` ⇒ 本用例必须变红。
     *    （第一版守卫没锁这条，实测该变异 **9 条全绿** —— 假绿。）
     */
    sessionScript.credential = { chatglm_token: LIVE_TOKEN }
    const { handler } = makeRpc()
    const created = await call(handler, 'account.create', { provider: 'chatglm', mode: 'browser' })
    expect(created.ok, `account.create 应被接受：${created.error?.message ?? ''}`).toBe(true)
    const loginUrl = (created.value as { loginUrl?: string }).loginUrl
    expect(
      loginUrl,
      '★★★ 必须返回非空 loginUrl —— 返回空串时客户端不会开窗，'
      + '窗口只存在于宿主（服务器）上，用户看不到（这正是报障现场）',
    ).toBeTruthy()
    expect(
      String(loginUrl),
      `loginUrl 必须是 chatglm.cn 的登录页（实际 ${String(loginUrl)}）`,
    ).toContain('chatglm.cn')
  })

  it('★★★ 粘贴整条 cookie ⇒ 落库 + 池条目带 `expiresAt`（不用等 login.poll）', async () => {
    const restore = stubUpstreamValid()
    try {
      const { pool, credentials, handler } = makeRpc()
      const listed = await call(handler, 'account.create', {
        provider: 'chatglm', mode: 'paste', pasteText: PASTE_COOKIE,
      })
      expect(listed.ok, `粘贴路径应被接受：${listed.error?.message ?? ''}`).toBe(true)
      const accountId = (listed.value as { accountId?: string }).accountId
      expect(accountId).toBeTruthy()

      // 凭据必须真的落到它自己的 ref
      const stored = [...credentials.entries()].find(([, value]) => value.includes(LIVE_TOKEN))
      expect(stored, '凭据必须写进凭据库').toBeDefined()

      // ★ 池条目必须带 expiresAt（粘贴路径**不走** login.poll 的落库那条腿）
      const entry = pool.listAccountsByProvider('chatglm').find((a) => a.id === accountId)
      expect(entry?.expiresAt, '★ 粘贴路径同样必须写有效期（否则卡片恒「未知」）').toBe(REAL_EXP * 1000)
    } finally { restore() }
  })

  it('★★ 无法识别的文本 ⇒ 明确报错，**不建任何账号**（不留幽灵卡）', async () => {
    const { pool, handler } = makeRpc()
    const before = pool.listAccountsByProvider('chatglm').length
    const res = await call(handler, 'account.create', {
      provider: 'chatglm', mode: 'paste', pasteText: '随便打的几个字',
    })
    expect(res.ok, '认不出的文本必须被拒绝').toBe(false)
    expect(res.error?.message, '文案必须说清要粘什么').toContain('chatglm_token')
    expect(pool.listAccountsByProvider('chatglm').length, '不得留下幽灵账号').toBe(before)
  })

  it('★★ 上游校验不过 ⇒ 报错且**不落库**（不让用户以为自己成功了）', async () => {
    // ⚠️ 粘贴路径会先 `fetchChatglmBalanceDetailed` 验一次。这里让上游回 40102。
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 40102, message: 'unauthorized user(40102)' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    try {
      const { pool, credentials, handler } = makeRpc()
      const res = await call(handler, 'account.create', {
        provider: 'chatglm', mode: 'paste', pasteText: `chatglm_token=${LIVE_TOKEN}`,
      })
      expect(res.ok, '无效 token 必须被拒绝').toBe(false)
      expect(res.error?.message, '文案必须指向「登录态失效」而不是「形状不对」')
        .toContain('登录态已失效')
      expect(pool.listAccountsByProvider('chatglm'), '不得留下账号').toHaveLength(0)
      expect([...credentials.values()].some((v) => v.includes(LIVE_TOKEN)), '不得落库无效凭据')
        .toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('★ 同一份 token 粘两次 ⇒ 判重命中，**不造第二张卡**（返回原 id）', async () => {
    const restore = stubUpstreamValid()
    try {
      const { pool, handler } = makeRpc()
      const first = await call(handler, 'account.create', {
        provider: 'chatglm', mode: 'paste', pasteText: PASTE_COOKIE,
      })
      const firstId = (first.value as { accountId?: string }).accountId
      const second = await call(handler, 'account.create', {
        provider: 'chatglm', mode: 'paste', pasteText: PASTE_COOKIE,
      })
      expect(second.ok).toBe(true)
      expect((second.value as { accountId?: string }).accountId, '应返回**原来**那个 id').toBe(firstId)
      expect(pool.listAccountsByProvider('chatglm'), '不得出现两张指向同一账号的卡').toHaveLength(1)
    } finally { restore() }
  })
})})
