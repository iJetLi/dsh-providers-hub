/**
 * `login.poll` 的**终态失败通道**（Gitee issue IKLI7J）。
 *
 * ## 被守住的缺陷（真实报障，2026-10-14）
 *
 * 「登录失败对用户完全不可见：任何 provider 登录失败都只剩 5 分钟静默转圈」。
 *
 * 两条根因：
 * 1. OfficeAce 交换失败时后端回 `{done:false, error}`，而前端
 *    `if (!pollRes?.done) return;` **只判 `done`** ⇒ 那句唯一指路的原因
 *    （本例是「账号未订阅 ModelArts MaaS」）被整体丢掉；
 * 2. 其余 provider 失败后**删掉占位条目**，`login.poll` 命中
 *    `if (!entry) return {done:false}` —— 与「用户还没授权完」**同形**，
 *    没有任何终态表示。
 *
 * 5 分钟不是服务端超时，是**客户端自己的轮询上限**（`plugin-src/client/jet-hub.js`）。
 *
 * ## 三条契约（改任何一处都要同时看这三条）
 *
 * | 形态 | 含义 |
 * |---|---|
 * | `{done:false}` | 进行中（正常中间态，**不得**误报成失败） |
 * | `{done:true, success:true}` | 成功 |
 * | `{done:true, success:false, error}` | 终态失败，`error` 可直接展示 |
 *
 * ⚠️ 本文件**不发真实网络、不开浏览器窗口**（`openIncognitoWindow` 有
 * `NODE_ENV === 'test'` 断路器），全部走替身。
 */

import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import { markLoginNeedsExternalAction } from '../../src/login-failure.js'

type Handler = (request: Request) => Promise<Response>

interface RpcResult {
  ok: boolean
  value?: { done?: boolean; success?: boolean; error?: string; accountId?: string; [k: string]: unknown }
  error?: { code?: string; message?: string }
}

interface Harness {
  call(method: string, payload: unknown): Promise<RpcResult>
  /** 当前账号池里的条目（只读快照）。 */
  accounts(): Array<Record<string, unknown>>
}

/**
 * 去掉整行注释与块注释内容（**只为计数**）。
 *
 * ⚠️ 红队实测：块注释里插一行**裸文本** `failLogin(id, error)` 就能把计数守卫配平
 *（行锚定正则分不清「注释里的调用」与「真调用」）⇒ 计数前必须先剥注释。
 * 这里只剥「整行 `//`」与「`/* … *\/` 区间」，够用且不误伤 URL 里的 `//`。
 */
function stripComments(source: string): string {
  const out: string[] = []
  let inBlock = false
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      out.push('')
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      out.push('')
      continue
    }
    out.push(trimmed.startsWith('//') ? '' : line)
  }
  return out.join('\n')
}

/**
 * 15 个键**一个都不能少**（`JetHubAuths` 是位置敏感的命名对象，
 * 历史上因少传/插队错位复发过多次）。两个 harness 共用同一份形状。
 */
function hubAuths(overrides: Record<string, unknown>): Record<string, unknown> {
  const stub = {} as never
  return {
    codearts: stub, buddy: stub, workbuddy: stub, lobsterai: stub, qoder: stub,
    qodercn: stub, trae: stub, cline: stub, loomy: stub, raccoon: stub,
    minimax: stub, zcode: stub, gemini: stub, officeace: stub, accio: stub,
    ...overrides,
  }
}

/**
 * 搭一个能注册 Jet Hub RPC 的最小 ctx + 内存账号池。
 *
 * ⚠️ 用**普通对象**而不是 `new Context()` + 真 `AccountPool`：本文件要精确控制
 * 「占位条目在不在」「凭据写没写」，真 `AccountPool` 会把这些藏在磁盘/缓存后面。
 * 形状照 `accio-wiring.spec.ts` 的既有写法（那边已踩过 typecheck 的坑）。
 */
function makeHarness(overrides: Record<string, unknown>): Harness {
  let handler: Handler | undefined
  const entries = new Map<string, Record<string, unknown>>()
  const store = new Map<string, string>()

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
    inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {} },
    credentials: {
      resolve: async (ref: string) => {
        const value = store.get(ref)
        return value === undefined ? undefined : { value, source: 'test' }
      },
      set: async (ref: string, value: string) => { store.set(ref, value) },
      unset: async (ref: string) => { store.delete(ref) },
    },
  }

  const pool = {
    addAccount: async (entry: Record<string, unknown>) => { entries.set(String(entry.id), entry) },
    updateAccount: async (id: string, patch: Record<string, unknown>) => {
      const current = entries.get(id)
      if (current !== undefined) entries.set(id, { ...current, ...patch })
    },
    removeAccount: async (id: string) => { entries.delete(id) },
    // ⚠️ 真 `AccountPool` 有这个方法，`failLogin` 用它判「登录是否其实已成功」。
    // 替身缺了它会被判成「读不到池」⇒ 终态腿静默失效（本文件实测踩过一次）。
    findAccount: (id: string) => entries.get(id),
    listAccounts: async () => [...entries.values()],
    listAllAccounts: async () => [...entries.values()],
  }

  // ⚠️ 15 个键一个都不能少，见 `hubAuths`。
  registerJetHubRpc(ctx as never, pool as never, hubAuths(overrides) as never)

  return {
    accounts: () => [...entries.values()],
    call: async (method, payload) => {
      const h = handler
      if (h === undefined) throw new Error('jet-hub RPC 端点未注册')
      const res = await h(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'r1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      return (await res.json() as { result: RpcResult }).result
    },
  }
}

/**
 * 真 `Context` + 真 `AccountPool` 的变体。
 *
 * ⚠️ **「账号/凭据是否被毁」这一类断言必须用它**：上面的内存桩 `removeAccount`
 * 只删数组元素、**不会 unset 凭据**（真 `AccountPool.removeAccount` 才会），
 * 用它根本测不出「凭据被连带删除」那一半 —— 会写出恒真的用例
 *（独立审计的原话）。
 */
function makeRealHarness(
  /**
   * 替身集合；**可以传工厂**：有些替身（如 gemini 的 `persistLogin`）需要直接写
   * 凭据库才能复刻「先落凭据、再记账」的真实顺序 —— 工厂拿得到 harness 内部的 store。
   */
  overrides: Record<string, unknown> | ((store: Map<string, string>) => Record<string, unknown>),
  patchPool?: (pool: AccountPool) => void,
): {
  call(method: string, payload: unknown): Promise<RpcResult>
  pool: AccountPool
  store: Map<string, string>
  credentialKeys(): string[]
} {
  const ctx = new Context()
  const store = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'test' }
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
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() { return { get: () => state.value, replace: (v: unknown) => { state.value = v } } },
    describe() { return [] },
  } as never)
  let handler: Handler | undefined
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (spec: { path: string; fetch: Handler }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject =
    (_deps: string[], callback: (c: unknown) => void) => callback(ctx)

  const pool = new AccountPool(ctx)
  patchPool?.(pool)
  const stubs = typeof overrides === 'function' ? overrides(store) : overrides
  registerJetHubRpc(ctx, pool, hubAuths(stubs) as never, undefined)

  const h = handler
  if (h === undefined) throw new Error('jet-hub RPC 端点未注册')
  return {
    pool,
    store,
    credentialKeys: () => [...store.keys()],
    call: async (method, payload) => {
      const res = await h(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'r1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      return (await res.json() as { result: RpcResult }).result
    },
  }
}

const OFFICEACE_CREDENTIAL = {
  modelAppKey: 'app-key',
  modelAppSecret: 'app-secret',
  maasBaseUrl: 'https://officeace.example',
  access: 'ak',
  secret: 'sk',
  securityToken: 'token',
  projectId: 'p',
  expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
  refreshToken: 'refresh',
  dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
} as const

/** 每次登录的云侧身份序号 —— 见 {@link nextOfficeAceCredential} 的说明。 */
let officeAceCredentialSeq = 0

/**
 * 造一份**云侧身份各不相同**的 OfficeAce 凭据。
 *
 * ⚠️⚠️ **必须每次不同**（2026-10-17 起；此前是常量 `accountId: 'stub-account'`）。
 *
 * `login.poll` 落库后新增了「**同一 `accountId` 重复登录 ⇒ 停用新条目**」的查重
 *（见 `officeace-rpc-multi-account.spec.ts` 的 ④⑤）。若本文件的桩让每次登录都返回
 * 同一个固定身份，那些「两次登录」的用例就会被**正确地**判成重复 ⇒ `login.poll`
 * 走「停用 + 改名」分支而**不再回填展示字段** ⇒ 用例断言的东西失效，
 * 但**红的原因不在被测代码**（是桩在撒谎：说两次登录是同一个号）。
 */
function nextOfficeAceCredential(): Record<string, unknown> {
  officeAceCredentialSeq += 1
  return { ...OFFICEACE_CREDENTIAL, accountId: `stub-account-${officeAceCredentialSeq}` }
}

/**
 * OfficeAce 桩。
 *
 * @param code `undefined` = 用户还没完成授权（正常中间态）。
 * @param completeLoginThrow 非空 ⇒ 交换阶段抛这个错（issue 附件的真实触发形态）。
 */
function officeaceStub(options: {
  code?: string | undefined
  /**
   * 非空 ⇒ 交换阶段抛这个错（issue 附件的真实触发形态）。
   *
   * ⚠️ 支持传 **Error 实例**（2026-10-20）：用来模拟**带「出路在外部」标记**的真实错误
   * （`officeace-auth.ts` 的未开通分支就是那样抛的）。传字符串时按普通 `Error` 处理
   * ⇒ 既有用例行为**逐字不变**。
   */
  completeLoginThrow?: string | Error
}): Record<string, unknown> {
  // ⚠️ 不能写成 `const { code = 'stub-code' } = options`：那样
  //    `{ code: undefined }`（=「用户还没授权」）会**命中默认值**，
  //    于是「进行中」被当成「已授权」，用例测的就不是它想测的东西了。
  const code = 'code' in options ? options.code : 'stub-code'
  const { completeLoginThrow } = options
  return {
    startLogin: async () => ({
      authorizeUrl: 'https://auth.huaweicloud.com/stub',
      state: 'stub-state',
      _internal: {
        codeVerifier: 'stub-verifier',
        dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      },
    }),
    pollLoginCode: async () => code,
    completeLogin: async () => {
      if (completeLoginThrow !== undefined) {
        throw typeof completeLoginThrow === 'string'
          ? new Error(completeLoginThrow)
          : completeLoginThrow
      }
      return nextOfficeAceCredential()
    },
    persistLogin: async (
      credential: Record<string, unknown>,
      opts: { refName: string; credentials: { set(ref: string, value: string): Promise<void> } },
    ) => {
      // ⚠️ 真写进凭据库：`login.poll` 判「成功」的判据就是它 resolving 出值。
      await opts.credentials.set(opts.refName, JSON.stringify(credential))
      return { accountId: credential.accountId }
    },
  }
}

describe('IKLI7J 根因 1：OfficeAce 交换失败必须是可判定的终态', () => {
  it('★ 交换失败 ⇒ done:true + success:false + error 含真实原因（原先只有 done:false）', async () => {
    const h = makeHarness({
      officeace: officeaceStub({
        completeLoginThrow: '华为云未返回 MaaS 凭据（账号可能未订阅 ModelArts MaaS）',
      }),
    })
    const created = await h.call('account.create', { provider: 'officeace' })
    expect(created.ok, 'account.create 应当成功').toBe(true)
    const accountId = created.value?.accountId as string

    const polled = await h.call('login.poll', { accountId, provider: 'officeace' })
    expect(polled.ok).toBe(true)
    // ① 终态：前端据此**停止**轮询（原先 done:false ⇒ 一直转到 5 分钟上限）
    expect(polled.value?.done, '失败必须走终态，否则前端只能干等 5 分钟').toBe(true)
    // ② 判别字段：前端靠它区分「成功」与「失败」
    expect(polled.value?.success).toBe(false)
    // ③ 原因必须真的透出来 —— 这才是本 issue 的核心诉求
    expect(String(polled.value?.error)).toContain('未订阅 ModelArts MaaS')
  })

  it('★ 终态失败必须**幂等**：重复轮询仍报同一条原因，不得退回 {done:false}', async () => {
    // ⚠️ 客户端是 1 秒一次的 setInterval + 异步回调，轮询**可能重叠**。
    //    若「读到即清」，一次丢包/慢响应就把唯一那次原因吃掉 ⇒ 退回静默转圈。
    const h = makeHarness({
      officeace: officeaceStub({ completeLoginThrow: '账号未订阅 ModelArts MaaS' }),
    })
    const created = await h.call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string

    const first = await h.call('login.poll', { accountId, provider: 'officeace' })
    const second = await h.call('login.poll', { accountId, provider: 'officeace' })
    expect(first.value?.success).toBe(false)
    expect(second.value?.success, '第二次轮询不得退化成「进行中」').toBe(false)
    expect(second.value?.error).toBe(first.value?.error)
  })

  it('★★ 带「出路在外部」标记的失败**不得**加「请重新点击」假出路（2026-10-20 用户报障）', async () => {
    // ⚠️ 未开通 MaaS 的出路在**果办客户端**（用该账号点「开通」并同意授权）。
    //    重新点「+ 新建账号」只会重走一遍 OAuth、然后再失败一次 ⇒ 修前
    //    `loginFailureMessage()` 无条件拼的那半句是**假出路**：它把用户锚在一个
    //    永远不会成功的动作上，还把内层唯一有用的指路冲淡了。
    const h = makeHarness({
      officeace: officeaceStub({
        completeLoginThrow: markLoginNeedsExternalAction(new Error(
          '华为云未返回 MaaS 凭据：该账号尚未开通 ModelArts MaaS。'
          + '请先用该账号在果办客户端里点「开通」并同意授权，再回来重试。',
        )),
      }),
    })
    const created = await h.call('account.create', { provider: 'officeace' })
    const polled = await h.call('login.poll', {
      accountId: created.value?.accountId as string,
      provider: 'officeace',
    })
    const error = String(polled.value?.error)
    expect(error, '内层指路（去哪＋做什么）必须完整保留').toContain('果办客户端')
    expect(
      error,
      '⚠️ 不得再拼「请重新点击「+ 新建账号」」—— 那是假出路（开通只能在果办里做）',
    ).not.toContain('请重新点击')
  })

  it('★ 反向：**未标记**的失败必须照旧带「请重新点击」后缀（防「一律不加」式误改）', async () => {
    // ⚠️ 网络抖动 / 用户自己关掉弹窗这类失败，**重试正是出路** ⇒ 后缀必须保留。
    //    没有这一条，把 `loginFailureMessage` 改成「永不加后缀」也能全绿。
    const h = makeHarness({
      officeace: officeaceStub({ completeLoginThrow: '网络超时，请重试' }),
    })
    const created = await h.call('account.create', { provider: 'officeace' })
    const polled = await h.call('login.poll', {
      accountId: created.value?.accountId as string,
      provider: 'officeace',
    })
    expect(
      String(polled.value?.error),
      '未标记的失败仍须给出「重新点击新建账号」这条重试指引',
    ).toContain('请重新点击')
  })

  it('★ 失败后不留幽灵账号：占位条目必须被删掉', async () => {
    const h = makeHarness({
      officeace: officeaceStub({ completeLoginThrow: '账号未订阅 ModelArts MaaS' }),
    })
    const created = await h.call('account.create', { provider: 'officeace' })
    await h.call('login.poll', { accountId: created.value?.accountId as string, provider: 'officeace' })
    // 原先失败分支只删 pendingOfficeAceState、**不删占位条目** ⇒
    // 用户界面上永久留一张「凭据未配置」的卡片。
    expect(h.accounts(), '失败后不得留下无凭据的幽灵账号').toHaveLength(0)
  })
})

/** codearts 是**回调式**登录：`startLogin` 立即返回，结果在 `result` 上（可由用例决定何时失败）。 */
function codeartsStubWithRejectableResult(): {
  auth: Record<string, unknown>
  reject(reason: string): void
} {
  let rejectResult: ((reason: unknown) => void) | undefined
  const result = new Promise<void>((_resolve, reject) => { rejectResult = reject })
  return {
    auth: {
      startLogin: async () => ({
        loginUrl: 'https://example.test/codearts/login',
        result,
        close: async () => {},
      }),
    },
    reject: (reason: string) => {
      // ⚠️ 必须**稍后**才 reject（不能在 startLogin 里 `Promise.reject`）：
      //    RPC 在 `startLogin` 与 `.catch()` 之间还有一次 `await addAccount`，
      //    立即 reject 会先触发一次 unhandledRejection。
      rejectResult?.(new Error(reason))
    },
  }
}

describe('IKLI7J 根因 2：占位条目已被清理的失败态也必须有终态', () => {
  it('★ 后台登录失败（条目被清理）⇒ 同一 accountId 报终态失败而非 {done:false}', async () => {
    const codearts = codeartsStubWithRejectableResult()
    const h = makeHarness({ codearts: codearts.auth })
    const created = await h.call('account.create', { provider: 'codearts' })
    const accountId = created.value?.accountId as string

    // 授权被拒：后台 result 落定为失败 ⇒ failLogin（记原因 + 删占位条目）。
    codearts.reject('codearts: 授权被拒绝')
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(h.accounts(), '失败后占位条目应当已被清理').toHaveLength(0)

    const polled = await h.call('login.poll', { accountId, provider: 'codearts' })
    expect(polled.ok).toBe(true)
    // 原先这里与「用户还没授权完」同形：`{done:false}` ⇒ 静默转圈 5 分钟。
    expect(polled.value?.done, '条目消失必须被解释成终态').toBe(true)
    expect(polled.value?.success).toBe(false)
    expect(String(polled.value?.error)).toContain('授权被拒绝')
  })

  it('★ 终态失败**只作用于自己的 accountId**：另一次登录照常成功', async () => {
    // 防「用一个全局失败标志代替按账号记录」这类实现：那会让一次失败
    // 把后续所有登录都判死。
    const codearts = codeartsStubWithRejectableResult()
    const h = makeHarness({ codearts: codearts.auth, officeace: officeaceStub({}) })

    const failed = await h.call('account.create', { provider: 'codearts' })
    codearts.reject('codearts: 授权被拒绝')
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    const ok = await h.call('account.create', { provider: 'officeace' })
    const okId = ok.value?.accountId as string
    const polled = await h.call('login.poll', { accountId: okId, provider: 'officeace' })
    expect(polled.value?.done).toBe(true)
    expect(polled.value?.success, '另一次成功登录被前一次失败污染了').toBe(true)

    // 而失败那次仍如实报失败（两条记录互不覆盖）。
    const failedPoll = await h.call('login.poll', {
      accountId: failed.value?.accountId as string,
      provider: 'codearts',
    })
    expect(failedPoll.value?.success).toBe(false)
  })
})

describe('IKLI7J 回归护栏：不得把「进行中」误报成失败', () => {
  it('★ 用户尚未完成授权（无 code）⇒ 仍是 {done:false}，且不携带 success/error', async () => {
    const h = makeHarness({ officeace: officeaceStub({ code: undefined }) })
    const created = await h.call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string

    const polled = await h.call('login.poll', { accountId, provider: 'officeace' })
    expect(polled.value?.done, '未授权完不得报 done').toBe(false)
    // ⚠️ 关键：**不能**带 `success:false`，否则用户正常授权途中会被弹错。
    expect(polled.value?.success, '正常进行中不得被标成失败').toBeUndefined()
    expect(polled.value?.error).toBeUndefined()
    // 占位条目必须还在（轮询靠它判进度）。
    expect(h.accounts()).toHaveLength(1)
  })

  it('★ 占位条目存在但凭据未写入 ⇒ 仍 {done:false}（不得误报终态）', async () => {
    // 这条是**全部 15 家**的通用中间态：占位条目就是为了让前端看到进度。
    // 若把「条目在但凭据没写」判成失败，正常登录会被立刻打断。
    const h = makeHarness({ officeace: officeaceStub({ code: undefined }) })
    const created = await h.call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    for (let i = 0; i < 3; i += 1) {
      const polled = await h.call('login.poll', { accountId, provider: 'officeace' })
      expect(polled.value?.done).toBe(false)
      expect(polled.value?.success).toBeUndefined()
    }
  })

  it('★ 完全未知的 accountId（从未 account.create）⇒ 仍 {done:false}', async () => {
    // `login.poll` 是**可被外部调用**的端点，不能因为「查不到」就报登录失败。
    const h = makeHarness({ officeace: officeaceStub({}) })
    const polled = await h.call('login.poll', { accountId: 'nobody-at-all', provider: 'officeace' })
    expect(polled.ok).toBe(true)
    expect(polled.value?.done).toBe(false)
    expect(polled.value?.success).toBeUndefined()
  })

  it('★ 成功路径逐字未变：done:true + success:true', async () => {
    const h = makeHarness({ officeace: officeaceStub({}) })
    const created = await h.call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    const polled = await h.call('login.poll', { accountId, provider: 'officeace' })
    expect(polled.value?.done).toBe(true)
    expect(polled.value?.success).toBe(true)
    expect(polled.value?.error).toBeUndefined()
    expect(h.accounts()).toHaveLength(1)
  })
})

describe('IKLI7J 终态记录的边界：过期与容量', () => {
  it('★ 上限只防内存：写满后**最早**的记录被淘汰、最新一条仍报终态', async () => {
    // 淘汰会把一条**仍在被轮询**的记录挤掉 ⇒ 退回静默。红队实测这个上限必须远大于
    // 「同时在轮询的登录数」（客户端一次只允许一轮，但 RPC 可被外部脚本调用）。
    // ⚠️ 用例**不写死上限数值**：跑 300 次失败，只断言「最早没了、最新还在」，
    //    这样调大上限不会假红。
    const h = makeHarness({ officeace: officeaceStub({ completeLoginThrow: '账号未订阅 ModelArts MaaS' }) })
    const ids: string[] = []
    for (let i = 0; i < 300; i += 1) {
      const created = await h.call('account.create', { provider: 'officeace' })
      const id = created.value?.accountId as string
      ids.push(id)
      const polled = await h.call('login.poll', { accountId: id, provider: 'officeace' })
      expect(polled.value?.success, `第 ${i + 1} 次失败没报终态`).toBe(false)
    }
    const oldest = await h.call('login.poll', { accountId: ids[0], provider: 'officeace' })
    expect(oldest.value?.success, '最早的记录应已被上限淘汰（内存有界）').toBeUndefined()
    expect(oldest.value?.done).toBe(false)
    const newest = await h.call('login.poll', { accountId: ids[ids.length - 1], provider: 'officeace' })
    expect(newest.value?.success, '最新一条必须仍报终态').toBe(false)
  })

  it('★ 超过 TTL 的失败记录不得再被当作终态（也不得抛错）', async () => {
    // 记录是内存态、按账号 id 索引；没有 TTL 就会在当前进程里长住。
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-14T00:00:00Z'))
      const h = makeHarness({
        officeace: officeaceStub({ completeLoginThrow: '账号未订阅 ModelArts MaaS' }),
      })
      const created = await h.call('account.create', { provider: 'officeace' })
      const accountId = created.value?.accountId as string
      const failed = await h.call('login.poll', { accountId, provider: 'officeace' })
      expect(failed.value?.success).toBe(false)

      // 31 分钟后（TTL = 30 分钟）该记录失效。
      vi.setSystemTime(new Date('2026-10-14T00:31:00Z'))
      const later = await h.call('login.poll', { accountId, provider: 'officeace' })
      expect(later.ok).toBe(true)
      expect(later.value?.success, '过期记录不得再被当作终态').toBeUndefined()
      expect(later.value?.done).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('IKLI7J 审计修正：已落盘的登录绝不能被「失败收尾」毁掉（净回归）', () => {
  /**
   * 这两条守的是**独立审计打穿过的净回归**（**定稿前**的 OfficeAce 分支把
   * 「交换 / 落库 / 回填」罩在**同一个 `try`** 里，catch 一律 `failLogin`
   * —— 删账号，而真 `AccountPool.removeAccount` 会连带 unset 凭据）
   * ⇒ 一次**已经成功**的登录会被后来的失败抹掉。
   *
   * 当时的实测（真 `AccountPool`）：池 `[]` + 凭据键 `[]` + 前端持续看到「登录失败」。
   * ⚠️ 两条都**必须**用 `makeRealHarness`（内存桩的 `removeAccount` 不会 unset 凭据）。
   */
  function exchangingStub(completeLogin: () => Promise<unknown>): Record<string, unknown> {
    return {
      startLogin: async () => ({
        authorizeUrl: 'https://auth.huaweicloud.com/stub',
        state: 'stub-state',
        _internal: { codeVerifier: 'stub-verifier', dpopPrivateJwk: { kty: 'EC' } },
      }),
      pollLoginCode: async () => 'stub-code',
      completeLogin,
      persistLogin: async (
        credential: Record<string, unknown>,
        opts: { refName: string; credentials: { set(ref: string, value: string): Promise<void> } },
      ) => {
        await opts.credentials.set(opts.refName, JSON.stringify(credential))
        return { accountId: credential.accountId }
      },
    }
  }

  it('★ 两拍重叠拿到同一个 code：后一拍的失败不得删掉前一拍刚登好的账号与凭据', async () => {
    let seq = 0
    const h = makeRealHarness({
      officeace: exchangingStub(async () => {
        seq += 1
        // 第一拍换成功；重叠的第二拍拿到的必然是**同一条已被消费的** code。
        if (seq === 1) return nextOfficeAceCredential()
        throw new Error('授权 code 已被使用（交换失败）')
      }),
    })
    const created = await h.call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    const polled = await Promise.all([
      h.call('login.poll', { accountId, provider: 'officeace' }),
      h.call('login.poll', { accountId, provider: 'officeace' }),
    ])

    /**
     * ⚠️ **单飞表的唯一守卫**：两拍重叠时 `completeLogin` 只该被调用**一次**
     *（后一拍复用前一拍的 promise）。没有它，两拍各换一次 code，第二拍必然失败 ——
     * 虽然还有「凭据已落库 ⇒ 按成功处理」那道兜底，但那时第一次交换已经被浪费，
     * 且成败取决于两拍的**交错时序**（真实网络下不可控）。
     */
    expect(seq, '两拍各换了一次 code ⇒ 单飞表没生效（后一拍在赌时序）').toBe(1)
    expect(
      polled.filter((r) => r.value?.success === true).length,
      '两拍都在报失败 ⇒ 一次已经成功的登录被失败收尾抹掉了',
    ).toBe(2)
    expect(
      (await h.pool.listAllAccounts()).map((a) => a.id),
      '成功的登录被删号 ⇒ 用户白授权一次',
    ).toEqual([accountId])
    expect(h.credentialKeys(), '凭据被连带 unset ⇒ 用户拿到一个不可用的账号').toHaveLength(1)
    // 后续轮询必须与「一次成功登录」的结论一致（不得再退回失败）。
    const later = await h.call('login.poll', { accountId, provider: 'officeace' })
    expect(later.value?.success).toBe(true)
  })

  it('★ 落库成功但回填 updateAccount 抛错：必须报成功，账号与凭据都不得被删', async () => {
    const h = makeRealHarness(
      { officeace: exchangingStub(async () => nextOfficeAceCredential()) },
      (pool) => {
        const original = pool.updateAccount.bind(pool)
        let first = true
        ;(pool as unknown as {
          updateAccount(id: string, patch: Record<string, unknown>): Promise<void>
        }).updateAccount = async (id, patch) => {
          if (first) {
            first = false
            throw new Error('模拟存储写失败')
          }
          return original(id, patch as never)
        }
      },
    )
    const created = await h.call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    const polled = await h.call('login.poll', { accountId, provider: 'officeace' })

    // 凭据已落盘 ⇒ 这次登录就是成了；回填只是展示字段，不得反过来判失败。
    expect(polled.value?.success, '凭据已在却报失败 ⇒ 用户丢掉一个已登好的账号').toBe(true)
    expect((await h.pool.listAllAccounts()).map((a) => a.id)).toEqual([accountId])
    expect(h.credentialKeys()).toHaveLength(1)
  })

  it('★ 回归护栏：交换**真的**失败（无凭据）仍必须是终态失败 + 不留幽灵账号/孤儿凭据', async () => {
    const h = makeRealHarness({
      officeace: exchangingStub(async () => { throw new Error('账号未订阅 ModelArts MaaS') }),
    })
    const created = await h.call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    const polled = await h.call('login.poll', { accountId, provider: 'officeace' })

    expect(polled.value?.done).toBe(true)
    expect(polled.value?.success).toBe(false)
    expect(String(polled.value?.error)).toContain('未订阅')
    expect(await h.pool.listAllAccounts(), '真失败仍必须清掉占位条目').toHaveLength(0)
    expect(h.credentialKeys()).toHaveLength(0)
  })
})

describe('IKLI7J 审计修正（红队 R9）：记账失败不得把「已成功的登录」报成失败', () => {
  /**
   * 红队最强反例，**无任何未验证前提**：各 provider 后台 `.then` 里 `pool.updateAccount`
   * 排在**凭据落盘之后**，而 `AccountPool` 的 `state.json` 落盘失败会**抛错**
   *（本仓库自己记过「落盘抛错时账号已经是可用状态」）。原先这个 `.catch` 会走
   * `failLogin` ⇒ 报「登录失败」并删号，而账号与凭据其实都在。
   *
   * ⚠️ 必须用真 `AccountPool` + 真凭据落库顺序（gemini 的 `persistLogin` 先写凭据），
   * 否则测不出这条。
   */
  function geminiStubThatPersists(store: Map<string, string>): Record<string, unknown> {
    return {
      startLogin: async () => ({
        loginUrl: 'https://accounts.google.com/stub',
        result: Promise.resolve({ sub: 'sub-1', email: 'user@example.test' }),
        close: async () => {},
      }),
      persistLogin: async (credential: unknown, opts: { refName: string }) => {
        // 复刻真实顺序：**先写凭据**，之后 RPC 才 `pool.updateAccount` 回填。
        store.set(opts.refName, JSON.stringify(credential))
      },
    }
  }

  it('★ 凭据已落盘、仅记账（updateAccount）失败 ⇒ 必须报成功，账号与凭据都保留', async () => {
    const h = makeRealHarness(
      (store) => ({ gemini: geminiStubThatPersists(store) }),
      (pool) => {
        const original = pool.updateAccount.bind(pool)
        let first = true
        ;(pool as unknown as {
          updateAccount(id: string, patch: Record<string, unknown>): Promise<void>
        }).updateAccount = async (id, patch) => {
          if (first) {
            first = false
            throw new Error('state.json 写失败（磁盘/权限）')
          }
          return original(id, patch as never)
        }
      },
    )

    const created = await h.call('account.create', { provider: 'gemini' })
    const accountId = created.value?.accountId as string
    // 等后台 `.then` 跑完（它先写凭据、再回填，回填那步会抛）。
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    const polled = await h.call('login.poll', { accountId, provider: 'gemini' })
    expect(
      polled.value?.success,
      '凭据与账号都在、只是记账失败 ⇒ 报失败会把用户赶去重复登录（同一账号变两条）',
    ).toBe(true)
    expect((await h.pool.listAllAccounts()).map((a) => a.id)).toEqual([accountId])
    expect(h.credentialKeys(), '凭据不该被删').toHaveLength(1)
  })

  it('★ 读不到账号池时：只记终态，**不得删账号**（删除不可逆，宁可留卡片）', async () => {
    // 池实现抛错（或替身缺 `findAccount` —— 本文件实测踩过一次：那一刻所有失败收尾
    // 都静默失效）时，绝不能把「读不到」当成「没有凭据」去删号。
    const h = makeRealHarness(
      { officeace: officeaceStub({ completeLoginThrow: '账号未订阅 ModelArts MaaS' }) },
      (pool) => {
        ;(pool as unknown as { findAccount: () => never }).findAccount = () => {
          throw new Error('池读失败（模拟实现异常）')
        }
      },
    )
    const created = await h.call('account.create', { provider: 'officeace' })
    const accountId = created.value?.accountId as string
    const polled = await h.call('login.poll', { accountId, provider: 'officeace' })

    expect(polled.value?.success, '读不到池也必须让用户看到原因').toBe(false)
    expect(
      (await h.pool.listAllAccounts()).map((a) => a.id),
      '读不到池就删号 ⇒ 把「读不到」当成「没有」，一次可能成功的登录被不可逆地销毁',
    ).toEqual([accountId])
  })

  it('★ 登录途中账号被用户删除 ⇒ 文案必须是人话，不得泄漏内部错误串', async () => {
    const codearts = codeartsStubWithRejectableResult()
    const h = makeRealHarness({ codearts: codearts.auth })
    const created = await h.call('account.create', { provider: 'codearts' })
    const accountId = created.value?.accountId as string
    await h.call('account.delete', { accountId })
    codearts.reject('codearts: 授权被拒绝')
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    const polled = await h.call('login.poll', { accountId, provider: 'codearts' })
    // 条目没了 ⇒ 这里本来就会走 `failLogin` 的「条目已被删除」分支。
    expect(polled.value?.success).toBe(false)
    expect(String(polled.value?.error), '内部错误串（Account … not found）泄漏给用户了')
      .not.toContain('not found')
    expect(String(polled.value?.error)).toContain('已被删除')
  })
})

describe('IKLI7J 接线守卫：两侧必须同改，缺一处就退回静默转圈', () => {
  const clientSource = readFileSync(
    new URL('../../plugin-src/client/jet-hub.js', import.meta.url),
    'utf8',
  )
  const serverSource = readFileSync(
    new URL('../../src/jet-hub-rpc.ts', import.meta.url),
    'utf8',
  )

  /**
   * ⚠️ 源码断言一律用**行锚定正则**，不用 `indexOf('原始片段')`：
   * 本文件与源码的注释里都**引用**了这些片段（例如「旧写法 `if (!pollRes?.done) return;`」），
   * `indexOf` 会先命中注释 —— 本仓库记过同型事故（取证命令自匹配修复提交本身）。
   */
  function lineIndex(pattern: RegExp): number {
    const match = pattern.exec(clientSource)
    return match === null ? -1 : match.index
  }

  it('★ 客户端必须先判 success === false，再判 done（顺序不能反）', () => {
    const failureIdx = lineIndex(/^\s*if \(pollRes\?\.success === false\) \{$/m)
    const doneIdx = lineIndex(/^\s*if \(!pollRes\?\.done\) return;$/m)
    expect(failureIdx, '客户端丢失了终态失败判据（issue IKLI7J 根因 1 回归）').toBeGreaterThan(-1)
    expect(doneIdx, '客户端的 done 早退判据不见了').toBeGreaterThan(-1)
    // ⚠️ 顺序断言是**必须**的：写成「先 `!done` 早退、再判 success」等于没改 ——
    //    `done:false` 的失败仍会被丢掉（这正是 issue 原文的缺陷形态）。
    expect(failureIdx, 'success 判据必须在 done 早退之前').toBeLessThan(doneIdx)
  })

  it('★ 客户端终态失败分支必须真的把错误展示出来（不能只 loadAccounts）', () => {
    const failureIdx = lineIndex(/^\s*if \(pollRes\?\.success === false\) \{$/m)
    const doneIdx = lineIndex(/^\s*if \(!pollRes\?\.done\) return;$/m)
    const branch = clientSource.slice(failureIdx, doneIdx)
    expect(branch).toContain('setError(')
    expect(branch).toContain("setPhase('error')")
    expect(branch).toContain('stopPoll()')
  })

  it('★ 客户端超时分支必须给提示（原先静默关窗 + 停表）', () => {
    const timeoutIdx = lineIndex(/^\s*if \(Date\.now\(\) > deadline\) \{$/m)
    const pollIdx = lineIndex(/^\s*const pollRes = await rpcCall\('login\.poll'/m)
    expect(timeoutIdx, '超时分支不见了').toBeGreaterThan(-1)
    expect(pollIdx).toBeGreaterThan(timeoutIdx)
    const timeoutBranch = clientSource.slice(timeoutIdx, pollIdx)
    expect(timeoutBranch, '超时仍静默结束 ⇒ issue 期望 3 未落实').toContain('登录超时')
    expect(timeoutBranch).toContain("setPhase('error')")
    /**
     * ⚠️ **文案不得把原因写死成「未完成授权」**（独立审计发现）：走到超时还有几种
     * 与「没授权」相反的情形（用户已授权但凭据形状不被接受 / 账号途中被删 /
     * 失败记录被 TTL 或上限淘汰）。写死原因会给排障者错误的第一个假设。
     */
    expect(
      timeoutBranch,
      '超时文案把原因写死成「未完成授权」⇒ 排障者会被引向错误方向',
    ).toContain('账号条目已被删除')
  })

  it('★ 服务端：每个后台登录失败告警都必须配一条终态记录（计数断言，防漏接）', () => {
    // ⚠️ 判据用**计数**而不是「某串字符在不在」：接线是并列的十余处，
    //    「有一处在」不能推出「处处都在」（本仓库反复记录过的形态）。
    // ⚠️⚠️ **两类收尾必须分开计数**（红队 W1）：`failLogin` 与 `recordLoginFailure`
    //    混在一个和里时，把任一家的 `failLogin` 换成 `recordLoginFailure`
    //    （= 记终态但**不删占位条目** ⇒ 幽灵账号）计数照样配平、守卫全绿。
    // ⚠️⚠️ **计数前必须先剥注释**（红队 W2）：块注释里一行裸文本
    //    `failLogin(id, error)` 即可把计数配平。
    const code = stripComments(serverSource)
    const warns = code.match(/login failed for \$\{id\}/g) ?? []
    /**
     * ⚠️ **精确白名单，不是通配**（2026-11-26，issue #170 新增第三形态）：
     *
     * | 形态 | 出处 |
     * |---|---|
     * | `failLogin(id, error)` / `(id, err)` | 常规 |
     * | `failLogin(id, geminiLoginFailure(error))` | Gemini —— 必须**先包装再加终态**，见下 |
     *
     * Gemini 那一条是**唯一**需要改写错误的：它要在交给 `failLogin` **之前**
     * 把 `geminiNetworkHint`（「插件进程不读系统代理，浏览器读」）接上去，
     * 并标 `markLoginNeedsExternalAction` 去掉「请重新点新建账号」这半句假出路。
     * ⇒ 直接把 `error` 传进去，用户只会看到零信息量的 `fetch failed`。
     *
     * ⚠️ 白名单**逐字枚举**：写成 `\(.*\)` 会让「把 error 换成任意东西」也通过，
     *    而那条守卫存在的意义正是「不许静默改变收尾语义」。
     */
    const failLoginCalls = code.match(
      /^\s+void failLogin\(id, (?:err|error|geminiLoginFailure\(error\))\)$/gm,
    ) ?? []
    const accioRecord = code.match(/^\s+recordLoginFailure\(id, error\)$/gm) ?? []
    expect(warns.length, '后台失败告警条数变了？先核对是否新增/删除了 provider 分支')
      .toBeGreaterThanOrEqual(12)
    // accio 是**刻意的唯一例外**：它的占位条目由 `AccioAuth.fail()` 自己清
    //（RPC 再 removeAccount 会与它自己的清理竞争），故只记终态。
    expect(accioRecord.length, 'accio 那条例外不见了？（它不该走 failLogin）').toBe(1)
    expect(
      failLoginCalls.length,
      `告警 ${warns.length} 条，但走 failLogin 的只有 ${failLoginCalls.length} 条`
      + ' ⇒ 漏接的那家失败时会留下幽灵账号（而两类混在一起计数可能照样配平）',
    ).toBe(warns.length - accioRecord.length)
    // ⚠️ OfficeAce 走的是 `failLogin(accountId, …)`（参数名不同）⇒ 单独点名，
    //    否则它是这条计数守卫的**盲区**（红队指出）。
    expect(
      (code.match(/await failLogin\(accountId, /g) ?? []).length,
      'OfficeAce 的失败收尾没走 failLogin ⇒ 又退回「删号 / 静默」形态',
    ).toBeGreaterThanOrEqual(2)
  })

  it('★ 客户端失败判据只能有一处（多一行早退就能让真分支变死代码）', () => {
    // 红队实测：在真失败分支**之前**插一行 `if (pollRes?.success === false) return;`
    // 会让真分支变成死代码（用户又只能等 5 分钟），而只按「首个匹配之后的文本是否
    // 含 setError」判的守卫**照样全绿**。⇒ 用计数把「诱饵早退」挡掉。
    const count = (clientSource.match(/pollRes\?\.success === false/g) ?? []).length
    expect(count, '出现多处 success===false ⇒ 可能有一处是让真分支变死代码的早退').toBe(1)
  })

  it('★ 客户端必须把「轮询请求本身失败」的痕迹带进超时文案（原先被裸 catch 吞掉）', () => {
    // 红队攻击 5d：`login.poll` 自身 `ok:false` 时，裸 `catch {}` 让真实原因永不上屏。
    const timeoutIdx = lineIndex(/^\s*if \(Date\.now\(\) > deadline\) \{$/m)
    const pollIdx = lineIndex(/^\s*const pollRes = await rpcCall\('login\.poll'/m)
    const timeoutBranch = clientSource.slice(timeoutIdx, pollIdx)
    expect(timeoutBranch, '超时文案没带上轮询失败痕迹').toContain('lastPollError')
    // 记录点必须在轮询的 catch 里（否则 lastPollError 恒为 null，等于没做）。
    expect(clientSource, '轮询 catch 没记录失败').toContain('pollErrorCount += 1')
  })

  it('★ 服务端：`login.poll` 必须在查账号池之前先查终态记录', () => {
    // ⚠️ 同样用行锚定正则（源码注释里引用了这两个片段）。
    const start = serverSource.indexOf("case 'login.poll': {")
    expect(start, '找不到 login.poll 分支').toBeGreaterThan(-1)
    const branch = serverSource.slice(start)
    const failureMatch = /^\s*const failure = loginFailureOf\(req\.accountId\)$/m.exec(branch)
    const listMatch = /^\s*const accounts = await pool\.listAllAccounts\(\)$/m.exec(branch)
    expect(failureMatch, 'login.poll 丢失了终态查询').not.toBeNull()
    expect(listMatch).not.toBeNull()
    // ⚠️ 顺序同理：`failLogin` 是「先写记录、再异步删条目」，
    //    落在「记录已写、条目未删」的窗口里也必须报出终态。
    expect(
      (failureMatch as RegExpExecArray).index,
      '终态查询必须在查账号池之前',
    ).toBeLessThan((listMatch as RegExpExecArray).index)
  })
})
