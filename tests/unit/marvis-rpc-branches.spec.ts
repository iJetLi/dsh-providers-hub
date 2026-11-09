/**
 * marvis-rpc-branches.spec.ts —— 腾讯 Marvis 的 `account.create` 两条分支（**行为级**）
 *
 * 被测源码：`src/jet-hub-rpc.ts` 的 `provider === MARVIS.id` 两个分支 +
 * `src/marvis-auth.ts` 的 `loginViaBrowser` / `exchangeCode` / `fetchUserProfile`。
 *
 * ── 为什么要单独一份（2026-11-09 整支评审 I4）──────────────────────────────
 * 评审指出：`account.create` 的 marvis 分支**零行为级测试**，而三个真缺陷
 * （C1 merge 分支漏记重定向 / I2 额度不换号 / I3 冻结额双计）全都在这一层。
 * 客户端那份 `marvis-client-panel.spec.ts` 是**源码文本**断言，挡不住
 * 「留着但失效」（`if (false)` 旁路）。
 *
 * ── ⚠️⚠️ 硬约束：**绝不真起浏览器、绝不真打上游** ─────────────────────────
 * - `browserLoginFactory` —— 假会话（`waitForCallbackUrl` 由用例决定返回什么）；
 * - `fetchImpl` —— 假 fetch（只认「回调兑换」与「取资料」两个 URL，别的一律
 *   抛错 ⇒ 任何多余请求都会让用例立刻红）。
 *
 * ⚠️ 同步点：后台任务是 `void` 起的，`login.poll` **不会** await 它
 * （它只读三张表）。⇒ 用「有界轮询 + 微任务让路」当同步点，
 * 不用固定 `sleep(ms)`（本仓库明令禁止的 flaky 源）。
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { MarvisAuth } from '../../src/marvis-auth.js'
import { MARVIS } from '../../src/marvis-product.js'
import type { MarvisBrowserLogin } from '../../src/marvis-browser-login.js'

// ════════════════════════════════════════════════════════════════════════
// 夹具
// ════════════════════════════════════════════════════════════════════════

const OPENID = '864D89036E52CC338D18484131FE053D'
const ACCESS = 'mv-constructor-access-token'
const REFRESH = 'constructor-refresh-token'
/** 回调 URL 的形状（`state` 必须是小数，与 `authorizeUrlOf` 一致）。 */
const CALLBACK_URL = `https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?login_type=QC&code=CODE&state=0.5`

function refKey(ref: { name?: unknown } | string): string {
  if (typeof ref === 'string') return ref
  const name = ref?.name
  return typeof name === 'string' ? name : String(ref)
}

class FakeStore {
  readonly values = new Map<string, string>()

  async resolve(ref: { name?: unknown } | string): Promise<{ value: string } | undefined> {
    const value = this.values.get(refKey(ref))
    return value === undefined ? undefined : { value }
  }

  async set(ref: { name?: unknown } | string, value: string): Promise<void> {
    this.values.set(refKey(ref), value)
  }

  async unset(ref: { name?: unknown } | string): Promise<void> {
    this.values.delete(refKey(ref))
  }

  saved(refName: string): Record<string, unknown> | undefined {
    const raw = this.values.get(refName)
    return raw === undefined ? undefined : JSON.parse(raw) as Record<string, unknown>
  }
}

/**
 * 假 fetch。
 *
 * ⚠️ 只认两个 URL：**别的任何 URL 都抛错** —— 这样「实现里多打了一个上游请求」
 * 会立刻炸，而不是静默通过（本仓库既有教训：假 fetch 兜底回 200 会把
 * 「凭据根本没发出去」测成绿）。
 */
function makeFetch(options: {
  /** 回调兑换返回什么（`undefined` = 用默认的成功 302）。 */
  exchange?: () => Response
  /** 取资料的昵称。 */
  nickname?: string
} = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/marvis_client_login/marvis_oauth')) {
      if (options.exchange !== undefined) return options.exchange()
      const headers = new Headers()
      headers.append('set-cookie', `openid=${OPENID}`)
      headers.append('set-cookie', `accesstoken=${ACCESS}`)
      headers.append('set-cookie', `refreshtoken=${REFRESH}`)
      headers.append('set-cookie', 'access_token_expire_time=1796660878059')
      headers.append('set-cookie', 'login_type=1')
      headers.append('set-cookie', 'nickname=Jet')
      return new Response('', { status: 302, headers })
    }
    if (url.includes('/marvis_client/marvis_get_user_info')) {
      return new Response(JSON.stringify({ ret: 0, nick_name: options.nickname ?? 'Jet', head_img_url: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`marvis-rpc-branches 的假 fetch 不认识这个 URL：${url}`)
  }) as unknown as typeof fetch
}

/**
 * 取可读错误文案。
 *
 * ⚠️ `account.create` 的失败有两种形状：`{ ok:false, error:'文案' }`（分支内
 * 早退）与 `{ ok:false, error:{ code, message } }`（`handleMethod` 归一化）⇒
 * 两种都要认，否则「错误码对了但文案丢了」的回归测不出来。
 */
function errorText(result: { error?: unknown }): string {
  const error = result.error
  if (error === undefined || error === null) return ''
  if (typeof error === 'object') {
    if ('message' in error) return String((error as { message: unknown }).message)
    /**
     * ⚠️ RPC 信封把字符串**拆成数字键**（`{"0":"没","1":"有",…}`）⇒ 只能按键位
     * 重拼。写成 `String(error)` 会得到 `[object Object]`，而那条断言会因此
     * 「恰好不含关键词」假红。
     */
    const indices = Object.keys(error)
      .filter((key) => /^\d+$/.test(key))
      .map((key) => Number(key))
      .sort((left, right) => left - right)
    if (indices.length > 0) {
      return indices.map((index) => (error as Record<string, string>)[String(index)] ?? '').join('')
    }
  }
  return String(error)
}

/** 有界轮询：等到 `login.poll` 报终态（最多 100 拍）。 */
async function pollUntilDone(
  callPoll: (accountId: string) => Promise<{ ok: boolean, value?: unknown, error?: { message: string } }>,
  accountId: string,
): Promise<{ done: boolean, success?: boolean, error?: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const polled = await callPoll(accountId)
    expect(polled.ok, `login.poll 应当成功：${polled.error?.message ?? ''}`).toBe(true)
    const value = polled.value as { done: boolean, success?: boolean, error?: string }
    if (value.done) return value
    // 让后台任务跑一步（微任务 + 宏任务各让一次，不引入固定时长）。
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
  throw new Error('login.poll 在 100 拍内没有落定')
}

async function setupRpc(script: {
  /** 回调 URL（`undefined` = 用户没登完）。 */
  callbackUrl?: string | undefined
  /** 兑换直接抛错（模拟「浏览器起不来」）。 */
  throwError?: Error
  nickname?: string
  /** 卡住假会话（= 用户还在窗口里操作）。 */
  gate?: boolean
  /**
   * 假装本机的 `~/.config/magpie/plugin-auth.json` 内容。
   *
   * `undefined` ⇒ 注入一个「文件不存在」的读取实现（**不是**省略 —— 省略会落到
   * 生产的 `readFileSync`，去读开发机上的真文件，用例结果取决于这台机器有没有
   * 登过 Marvis）。`null` 也当不存在。
   */
  magpieFile?: string | null
} = {}) {
  let stored: Record<string, unknown> = { accounts: [], disabledModels: {} }
  const ctxLike = new Context() as never as {
    provide: (name: string, value: unknown) => void
    get: (name: string) => unknown
  }
  const store = new FakeStore()
  const credentials = store as unknown as {
    resolve: (ref: unknown) => Promise<{ value: string } | undefined>
    set: (ref: unknown, value: string) => Promise<void>
    unset: (ref: unknown) => Promise<void>
  }
  ctxLike.provide('credentials', credentials)
  const pool = new AccountPool({
    get: (key: string) => key === 'settings'
      ? {
          register: () => ({
            get: () => stored,
            replace: async (value: Record<string, unknown>) => { stored = value },
          }),
        }
      : undefined,
    logger: { warn: () => {}, info: () => {} },
    credentials,
  } as never)
  ctxLike.provide('accountPool', pool)

  /**
   * 「用户还在窗口里」的闸门：给了就**卡住**假会话，直到用例 `release()`。
   *
   * ⚠️ 这条闸门是「`account.create` 真的**不**在等用户」的唯一证据：
   * 没有它，假会话立刻返回 `undefined` ⇒ 后台任务瞬间走 `failLogin` 删掉占位
   * ⇒「立刻返回」与「同步等到失败」在断言上不可区分。
   */
  let releaseGate: () => void = () => {}
  const gate = {
    promise: new Promise<void>((resolve) => { releaseGate = resolve }),
    release: () => { releaseGate() },
  }
  const warnings: string[] = []
  const marvisAuth = new MarvisAuth(ctxLike as never, {
    store,
    fetchImpl: makeFetch(script.nickname === undefined ? {} : { nickname: script.nickname }),
    warn: (message) => { warnings.push(message) },
    /**
     * ⚠️ 永远注入 `readFile`：生产默认实现会去读真实的
     * `~/.config/magpie/plugin-auth.json`，那份文件在开发机上**存在与否**决定
     * 用例是绿是红（假绿），而且会把真实凭据喂进断言。
     */
    readFile: () => {
      if (typeof script.magpieFile === 'string') return script.magpieFile
      const error = new Error('ENOENT: no such file or directory')
      ;(error as NodeJS.ErrnoException).code = 'ENOENT'
      throw error
    },
    browserLoginFactory: async () => {
      if (script.throwError !== undefined) throw script.throwError
      const login: MarvisBrowserLogin = {
        close: () => {},
        waitForCallbackUrl: async () => {
          if (script.gate === true) await gate.promise
          return script.callbackUrl
        },
      }
      return login
    },
  })

  let handler: ((req: Request) => Promise<Response>) | undefined
  const rpcCtx = {
    credentials,
    get: (key: string) => {
      if (key === 'connection') {
        return {
          fetch: {
            register: (config: { path: string, fetch: typeof handler }) => {
              if (config.path === JET_HUB_API_PATH) handler = config.fetch
            },
          },
        }
      }
      if (key === 'credentials') return credentials
      if (key === 'llm') return { listModels: async () => [], resolveModelInfo: async () => ({}) }
      return undefined
    },
    inject: (_deps: string[], cb: (c: unknown) => void) => { cb(rpcCtx) },
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    emit: () => {},
  }
  registerJetHubRpc(rpcCtx as never, pool, {
    marvis: marvisAuth,
    magicrew: {}, magicrewintl: {}, codearts: {}, buddy: {}, workbuddy: {},
    lobsterai: {}, qoder: {}, qodercn: {}, trae: {}, cline: {}, loomy: {},
    raccoon: {}, minimax: {}, zcode: {}, gemini: {}, officeace: {},
    minimaxintl: {}, autoclaw: {}, accio: {}, opencode: {},
  } as never)
  if (handler === undefined) throw new Error('RPC handler 未注册')

  const invoke = async (method: string, payload: unknown) => {
    const response = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean, value?: unknown, error?: { message: string } }
    }
    return body.result
  }

  return {
    pool,
    store,
    warnings,
    release: () => { gate.release() },
    callCreate: (extra: Record<string, unknown> = {}) => invoke('account.create', {
      provider: 'marvis',
      mode: 'browser',
      ...extra,
    }),
    callPoll: (accountId: string) => invoke('login.poll', { accountId, provider: 'marvis' }),
  }
}

// ════════════════════════════════════════════════════════════════════════
// 分支 1：mode === 'browser' 的三段式
// ════════════════════════════════════════════════════════════════════════

describe("★ account.create({ provider: 'marvis', mode: 'browser' }) 三段式", () => {
  it('★★ 立刻返回（窗口由宿主开 ⇒ loginUrl 是空串）+ 占位条目已就位', async () => {
    // 用户还没登完 ⇒ 假会话**卡在**「等用户」上，后台任务不会前进。
    const { callCreate, pool, release } = await setupRpc({ callbackUrl: CALLBACK_URL, gate: true })

    const created = await callCreate()
    expect(created.ok, `应当成功：${created.error?.message ?? ''}`).toBe(true)
    const value = created.value as { accountId: string, loginUrl: string }
    expect(value.loginUrl, '窗口由宿主开 ⇒ loginUrl 是空串').toBe('')
    expect(value.accountId.length).toBeGreaterThan(0)

    // 占位条目必须**在 create 返回时**就已就位（客户端 1 秒一拍，开窗要几百毫秒）。
    const entry = pool.findAccount(value.accountId)
    expect(entry, '占位条目必须在 create 返回时就已就位').toBeDefined()
    expect(entry?.provider).toBe('marvis')
    expect(entry?.refreshable).toBe(true)
    // 此时还没有有效期（用户还在窗口里）—— 这正是「不等用户」的证据。
    expect(entry?.expiresAt).toBeUndefined()
    release()
  })

  it('★★ 用户登完 ⇒ login.poll 报 success，凭据落在**该账号自己的** ref 上', async () => {
    const { callCreate, callPoll, pool, store } = await setupRpc({ callbackUrl: CALLBACK_URL })

    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    const polled = await pollUntilDone((id) => callPoll(id), accountId)

    expect(polled.success).toBe(true)
    const entry = pool.findAccount(accountId)
    expect(entry?.credentialRef).toMatch(/^MARVIS_ACCOUNT_/)
    // 凭据必须写在该账号**自己的** ref（只写默认 ref 会让多账号互相覆盖）。
    const saved = store.saved(entry!.credentialRef)
    expect(saved?.access_token).toBe(ACCESS)
    expect(saved?.openid).toBe(OPENID)
    // 昵称 / 有效期回填。
    expect(entry?.nickname).toBe('QQ·Jet')
    expect(entry?.expiresAt).toBe(1796660878059)
  })

  it('★★ 用户没登完（关窗 / 超时）⇒ done:true + success:false + 可读原因，且**删掉占位条目**', async () => {
    const { callCreate, callPoll, pool } = await setupRpc({ callbackUrl: undefined })

    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    const polled = await pollUntilDone((id) => callPoll(id), accountId)

    // ⚠️ 三态契约（IKLI7J）：失败必须是 `done:true` + `success:false` + `error`，
    //   否则前端 `if (!pollRes?.done) return;` 会把它整体丢掉 ⇒ 静默转圈 5 分钟。
    expect(polled.success).toBe(false)
    expect(String(polled.error)).toMatch(/网页登录未完成/)
    // 不留幽灵卡片。
    expect(pool.findAccount(accountId)).toBeUndefined()
  })

  it('★★ 兑换直接抛错（浏览器起不来）⇒ 同样报终态失败，不残留占位', async () => {
    const { callCreate, callPoll, pool } = await setupRpc({
      callbackUrl: CALLBACK_URL,
      throwError: new Error('找不到可用的浏览器（网页登录需要本机有一个 Chromium 内核浏览器）'),
    })

    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    const polled = await pollUntilDone((id) => callPoll(id), accountId)

    expect(polled.success).toBe(false)
    expect(String(polled.error)).toMatch(/找不到可用的浏览器/)
    expect(pool.findAccount(accountId)).toBeUndefined()
  })

  it('★★★ C1 回归：同一 openid 二次登录 ⇒ 合并到旧卡，且 login.poll **立刻**报成功', async () => {
    // 第一次：建号 A（openid X）。
    const first = await setupRpc({ callbackUrl: CALLBACK_URL })
    const createdA = await first.callCreate()
    const accountA = (createdA.value as { accountId: string }).accountId
    expect((await pollUntilDone((id) => first.callPoll(id), accountA)).success).toBe(true)

    // 第二次：同一个 store/pool 上再建一个（openid 也是 X）⇒ 命中 merge 分支。
    const createdB = await first.callCreate()
    const accountB = (createdB.value as { accountId: string }).accountId
    expect(accountB).not.toBe(accountA)

    /**
     * ⚠️⚠️ 这一格就是 C1：merge 分支会删掉 B 的占位条目，若**不**记
     * `rememberLoginMergedRedirect`，`login.poll` 的四道出口会全部落空 ⇒
     * 永远 `{done:false}` ⇒ 用户看着弹窗转 5 分钟。
     */
    const polledB = await pollUntilDone((id) => first.callPoll(id), accountB)
    expect(polledB.success, 'C1：合并分支必须让 login.poll 立刻报成功').toBe(true)

    // B 的占位已被删、A 的凭据仍在。
    expect(first.pool.findAccount(accountB)).toBeUndefined()
    const entryA = first.pool.findAccount(accountA)
    expect(entryA).toBeDefined()
    expect(first.store.saved(entryA!.credentialRef)?.openid).toBe(OPENID)
  })
})

// ════════════════════════════════════════════════════════════════════════
// 分支 2：mode === 'magpie-import'（同步导入）
// ════════════════════════════════════════════════════════════════════════

describe("★ account.create({ provider: 'marvis', mode: 'magpie-import' }) 同步导入", () => {
  const IMPORT_JSON = JSON.stringify({
    marvis: {
      type: 'oauth',
      access: ACCESS,
      refresh: REFRESH,
      expires: 1796660878059,
      accountId: 'QQ·Jet',
      uid: OPENID,
      metadata: { openid: OPENID, guid: 'f4642360411b4132d5917bf04f615b8a', loginType: '1', nickname: 'Jet' },
    },
  })

  it('★★ 一次调用即建号（宿主自己读 magpie 文件，不产生任何轮询）', async () => {
    const { callCreate, pool, store } = await setupRpc({ magpieFile: IMPORT_JSON })

    // ⚠️ **不带** `magpieCredential`：这正是 2026-11-09 用户报障要的行为 ——
    //    界面不再让用户找文件、复制 JSON，宿主直接读本机那一份。
    const created = await callCreate({ mode: 'magpie-import' })
    expect(created.ok, `应当成功：${created.error?.message ?? ''}`).toBe(true)
    const value = created.value as { accountId: string, loginUrl: string, reused?: boolean }
    expect(value.loginUrl).toBe('')
    expect(value.reused).toBeUndefined()

    const entry = pool.findAccount(value.accountId)
    expect(entry?.provider).toBe('marvis')
    expect(entry?.refreshable).toBe(true)
    expect(entry?.nickname).toBe('QQ·Jet')
    expect(entry?.expiresAt).toBe(1796660878059)
    expect(store.saved(entry!.credentialRef)?.openid).toBe(OPENID)
  })

  it('★★ 同一 openid 再导入 ⇒ reused:true 且**不新建**账号', async () => {
    const { callCreate, pool } = await setupRpc({ magpieFile: IMPORT_JSON })

    const first = await callCreate({ mode: 'magpie-import' })
    const accountId = (first.value as { accountId: string }).accountId
    const before = pool.listAccountsByProvider('marvis').length

    const second = await callCreate({ mode: 'magpie-import' })
    expect(second.ok).toBe(true)
    expect((second.value as { accountId: string, reused?: boolean }).accountId).toBe(accountId)
    expect((second.value as { reused?: boolean }).reused).toBe(true)
    expect(pool.listAccountsByProvider('marvis').length).toBe(before)
  })

  it('★★ 文件不存在 ⇒ 可读错误（**指向路径**），且不建账号', async () => {
    const { callCreate, pool } = await setupRpc()

    const created = await callCreate({ mode: 'magpie-import' })
    expect(created.ok).toBe(false)
    // 文案必须同时说「读的是哪个文件」与「还能怎么办」—— 只说「导入失败」
    // 会让用户不知道该去装 magpie 还是改用 QQ 登录。
    expect(errorText(created)).toContain('plugin-auth.json')
    expect(errorText(created)).toMatch(/QQ \/ 微信登录/)
    expect(pool.listAccountsByProvider('marvis')).toHaveLength(0)
  })

  it('★★ 文件里没有 marvis 条目 ⇒ 可读错误，且不建账号', async () => {
    const { callCreate, pool } = await setupRpc({ magpieFile: '{"other-provider":{}}' })

    const created = await callCreate({ mode: 'magpie-import' })
    expect(created.ok).toBe(false)
    expect(errorText(created)).toMatch(/没有可用的 Marvis 条目/)
    expect(pool.listAccountsByProvider('marvis')).toHaveLength(0)
  })

  it('★ 缺 metadata.guid ⇒ 同样拒绝（四个字段缺一不可）', async () => {
    const { callCreate, pool } = await setupRpc()
    const incomplete = JSON.stringify({
      marvis: { access: ACCESS, refresh: REFRESH, metadata: { openid: OPENID } },
    })

    const created = await callCreate({ mode: 'magpie-import', magpieCredential: incomplete })
    expect(created.ok).toBe(false)
    expect(pool.listAccountsByProvider('marvis')).toHaveLength(0)
  })

  it('★ 显式粘贴内容仍可用（自动化脚本 / 老客户端兼容）', async () => {
    const { callCreate, pool } = await setupRpc({ magpieFile: null })

    const created = await callCreate({ mode: 'magpie-import', magpieCredential: IMPORT_JSON })
    expect(created.ok, `应当成功：${errorText(created)}`).toBe(true)
    expect(pool.listAccountsByProvider('marvis')).toHaveLength(1)
  })
})
