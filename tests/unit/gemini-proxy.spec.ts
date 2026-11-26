/**
 * Gemini 账号出口代理（Gitee issue IKLTZ2）的行为与接线守卫。
 *
 * ## 缺陷原形
 *
 * Gemini 全部端点（`oauth2.googleapis.com/token`、userinfo、
 * `cloudcode-pa.googleapis.com`）都在墙外，而 undici（Node 内置 fetch）
 * **既不读** Windows WinINET 系统代理、**也不读** `HTTP(S)_PROXY` ⇒
 * 「浏览器能打开授权页并点同意、面板里账号却一直不出现」。
 *
 * ## 本文件为什么以**行为**断言为主（IKLTZ2 两次独立审计的实测结论）
 *
 * 源码文本断言对「**分支恒不执行**」与「**注释诱饵**」完全无感 —— 两种形态
 * 都能让接线判据全绿：
 *
 * - 把 `fetchFor: geminiFetchForAccount,` 删掉、只把字面量留在**注释**里；
 * - 把 `if (method.startsWith('gemini.'))` 改成
 *   `if (globalThis.X === true && …)`（字面量完整保留在**死条件**里，
 *   连剥注释都打不掉）。
 *
 * ⇒ 原则：**能用行为断言的一律用行为**；源码断言只守「接线点在不在」这一较弱
 * 不变式，且**全部先过 `stripComments`**（解决注释诱饵）。
 *
 * ⚠️ 残余弱点**如实登记**：剥注释解决不了「字面量在死条件里」。凡被 ④/⑤ 组
 * 行为用例覆盖的接线点，都**不再**只靠源码断言。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  createGeminiFetcherResolver,
  geminiFetchForAccount,
  geminiNetworkHint,
  setGeminiProxyPool,
} from '../../src/gemini-proxy.js'
import { handleGeminiRpc } from '../../src/gemini-rpc.js'
import { isUnreachableNetworkError } from '../../src/refresh.js'
import { asProxyText } from '../../src/account-pool.js'
import { stripComments } from '../helpers/strip-comments.js'

const here = dirname(fileURLToPath(import.meta.url))
// ⚠️ **全部先剥注释**：见文件头的「为什么以行为断言为主」。
const adapterSource = stripComments(readFileSync(join(here, '../../src/gemini-adapter.ts'), 'utf8'))
const authSource = stripComments(readFileSync(join(here, '../../src/gemini-auth.ts'), 'utf8'))
const indexSource = stripComments(readFileSync(join(here, '../../src/index.ts'), 'utf8'))
const rpcSource = stripComments(readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8'))
const runtimeSource = stripComments(readFileSync(join(here, '../../src/provider-runtime.ts'), 'utf8'))
const poolSource = stripComments(readFileSync(join(here, '../../src/account-pool.ts'), 'utf8'))
const typesSource = stripComments(readFileSync(join(here, '../../src/types.ts'), 'utf8'))

describe('① fetcher 解析器：按账号取出口', () => {
  it('空账号 id ⇒ 退回全局 fetch（不是抛错、不是空代理串）', () => {
    const resolver = createGeminiFetcherResolver(() => {
      throw new Error('不该被问到')
    })
    // ⚠️ 空 id 必须**根本不查池**：查了会把「不知道是谁」变成「用某人的出口」。
    expect(resolver('')).toBe(fetch)
  })

  it('账号没配代理 ⇒ 退回全局 fetch（保持 Node 24+ 的 NODE_USE_ENV_PROXY 宿主能力）', () => {
    const resolver = createGeminiFetcherResolver(() => '')
    expect(resolver('gemini-1')).toBe(fetch)
  })

  it('⚠️ 配了代理 ⇒ 换成另一个 fetcher（不是同一份全局 fetch）', () => {
    const resolver = createGeminiFetcherResolver((id) =>
      id === 'gemini-1' ? 'http://127.0.0.1:7897' : '')
    // ⚠️ 判据必须是「**不是**全局 fetch」：写成「调一次看有没有走代理」
    // 会在没配代理那一格也通过 ⇒ 恒真、无牙。
    expect(resolver('gemini-1')).not.toBe(fetch)
    expect(resolver('gemini-2')).toBe(fetch)
  })

  it('⚠️ 非法代理地址必须抛错，绝不静默退回直连', () => {
    // ⚠️ 这条是「用户以为配了代理却在裸奔」的唯一防线：
    // 静默回退会让症状与「没配代理」**完全同形**，用户无从发现。
    const resolver = createGeminiFetcherResolver(() => 'ftp://host:21')
    expect(() => resolver('gemini-1')).toThrow(/代理地址无效/)
  })

  it('同账号两次解析 ⇒ 按需现取（用户改代理后立即生效，不需重启）', () => {
    let current = ''
    const resolver = createGeminiFetcherResolver(() => current)
    expect(resolver('gemini-1')).toBe(fetch)
    current = 'http://127.0.0.1:7897'
    expect(resolver('gemini-1')).not.toBe(fetch)
  })

  it('⚠️ 池返回脏值（数字/对象）⇒ 视作「未配置」而不是崩在 trim 上', () => {
    // ⚠️ 该字段来自**用户可编辑的备份文件**，而 `sanitizeAccounts` 只做
    // `{...candidate}` 原样透传、不校验形状（实测：`12345` 原样进池）。
    // 下游 `normalizeProxy` 第一句是 `input.trim()` ⇒ 非字符串会抛
    // `TypeError: raw.trim is not a function`，该账号**永久不可用且无自愈**。
    for (const dirty of [12345, {}, [], true, null]) {
      const resolver = createGeminiFetcherResolver(() => dirty as never)
      expect(resolver('gemini-1'), `脏值 ${JSON.stringify(dirty)} 应降级为直连`).toBe(fetch)
    }
  })
})

describe('② 注入点：每个消费点都必须拿到按账号的 fetcher', () => {
  it('⚠️ GeminiAuth 的四条腿都不许用裸 fetchImpl', () => {
    // ⚠️ 判据是「**没有** fetcher 解析路径的调用点」，故按名字逐条列名：
    //   登录 startLogin → **loginFetcherFor**(options.accountId ?? '')
    //   批量续期       → refreshCredentialUnderLock(..., entry.id, …)
    //   昵称修复       → fetcherFor(entry.id)
    //
    // ⚠️ **登录为什么单独一个入口**（2026-11-26，issue #170）：
    //   `fetcherFor` 依赖「这个 accountId 已有自己的代理」，而 `startLogin` 传的是
    //   **刚生成、还没落池**的新 id ⇒ 自己的代理必然为空 ⇒ 裸 fetch ⇒ Google 在墙外
    //   ⇒ 面板「登录失败：fetch failed」而浏览器能授权。
    //   `loginFetcherFor` 额外允许「借用本 provider 任一已配代理的账号」。
    //   **推理 / 续期 / 探测仍走 `fetcherFor`**（不许借出口，否则「从哪出网」失真）。
    expect(authSource).toMatch(/fetcher:\s*this\.loginFetcherFor\(options\.accountId \?\? ''\)/)
    expect(authSource).toMatch(/fetcher:\s*this\.fetcherFor\(entry\.id\)/)
    expect(authSource).toMatch(/refreshCredentialUnderLock\(entry\.credentialRef, c, entry\.id,/)
    expect(authSource).toMatch(/fetchFor\?:\s*\(accountId: string\)\s*=>\s*typeof fetch/)
    // ★ 新增的登录专用入口也必须在 options 里（少一行 ⇒ 生产注入不进去、静默退回裸 fetch）
    expect(authSource).toMatch(/loginFetchFor\?:\s*\(accountId: string\)\s*=>\s*typeof fetch/)
  })

  it('⚠️ 推理主路径不再有裸 fetch（issue 建议漏掉的那一处 seam）', () => {
    const at = adapterSource.indexOf('let response: Response')
    expect(at, '未找到推理请求块').toBeGreaterThan(-1)
    const streamBody = adapterSource.slice(at, at + 900)
    // ⚠️ 判据是「该块里**没有**裸 `await fetch(`」—— 不是「有 fetcherForCurrentAccount」
    // （后者在注释与探测腿里也命中，审计实测 4 处匹配里 3 处是噪音 ⇒ 恒真）。
    expect(streamBody).not.toMatch(/await fetch\(/)
    expect(streamBody).toMatch(/await fetcherForCurrentAccount\(\)\(url, \{/)
  })

  it('⚠️ 项目探测与推理共用同一出口（否则探测走代理、推理直连 ⇒ 报错误导原因）', () => {
    expect(adapterSource).toMatch(
      /fetcher:\s*this\.options\.projectFetcher \?\? fetcherForCurrentAccount\(\)/,
    )
  })

  it('⚠️ 探测适配器把**池条目 id** 显式传进去（审计 P1-1：反查那条路不存在）', () => {
    // ⚠️ 探测路径**刻意不挂 accountPool**（`account-probe.ts` 的既定语义：
    // 只测这一个账号、且不写标记）⇒ 适配器内「按 access_token 反查账号 id」
    // 那条路**根本不存在** ⇒ 没有这个覆盖值时 `currentAccountId` 恒为 `''`
    // ⇒ 解析器按「空 id = 直连」处理 ⇒ **该账号的代理被完全绕过**，
    // 症状与「账号已失效」同形 ⇒ 用户会去误删好号。
    expect(adapterSource).toMatch(/let currentAccountId = this\.options\.accountIdOverride \?\? ''/)
    expect(adapterSource).toMatch(/accountIdOverride\?:\s*string/)
    // ⚠️ `probeById.gemini` 必须**接下第三个形参 entry**（原先形参只有
    // `(ref, credential)`，entry 被直接丢弃）—— 对照 opencode 的三形参写法。
    expect(indexSource).toMatch(/createProbeAdapter:\s*\(ref, credential, entry\) => new GeminiAdapter\(/)
    expect(indexSource).toMatch(/accountIdOverride:\s*entry\?\.id \?\? ''/)
  })

  it('⚠️ 登录必须把占位账号 id 传进去（凭据落盘前只有池条目认得它）', () => {
    expect(rpcSource).toMatch(/gemini\.startLogin\(\{ accountId: id \}\)/)
  })
})

describe('③ 积分路径也必须走该账号的出口', () => {
  it('⚠️ ProviderCallContext 带上了 accountId（锚定到该接口体，不是整个文件）', () => {
    // ⚠️ 锚定必须**切片到接口体**：`provider-runtime.ts` 里有**两个**接口都声明了
    // `accountId`（`ProviderCallContext` 与 `ProviderExpiryContext`），只对整个
    // 文件跑正则时删掉前者后者仍满足 ⇒ 恒真（对抗审计 M24 实测无牙）。
    const at = runtimeSource.indexOf('export interface ProviderCallContext {')
    expect(at, '未找到 ProviderCallContext').toBeGreaterThan(-1)
    // ⚠️ 切片必须到**下一个顶层 interface**（而不是第一个 `}` —— 那是
    // `resolveCredential` 那一行的收尾，会把 `accountId` 切在外面）。
    const end = runtimeSource.indexOf('export interface', at + 1)
    const body = runtimeSource.slice(at, end === -1 ? at + 1200 : end)
    expect(body).toMatch(/readonly accountId\?: string/)
  })

  it('⚠️ 两个 createProviderCredits 调用点都接了 geminiFetchFor', () => {
    // ⚠️ 与 minimaxXff（IKMEVG）同型：只接一处 ⇒ 「面板能刷新、聚合折算却失败」。
    expect(indexSource, 'index.ts 的 creditsTable 没接').toMatch(/geminiFetchFor:\s*geminiFetchForAccount/)
    expect(rpcSource, 'jet-hub-rpc.ts 的 credits 表没接')
      .toMatch(/geminiFetchFor:\s*\(accountId\) => geminiFetchForAccount\(accountId\)/)
  })
})

describe('④ 端点行为（守「死条件」那类变异；对抗审计 M29 的补法）', () => {
  // ⚠️ `if (method.startsWith('gemini.'))` 被改成
  // `if (globalThis.X === true && …)`（字面量完整保留在死条件里）时，
  // 纯源码断言**全部全绿**（审计实测）。本组用真调端点来守。

  afterEach(() => { vi.restoreAllMocks() })

  it('setProxy：合法地址会真的落到池里', async () => {
    const pool = { setGeminiProxy: vi.fn(async () => {}) }
    const res = await handleGeminiRpc({} as never, pool, 'gemini.setProxy', {
      accountId: 'gemini-1', proxy: '127.0.0.1:7897',
    })
    expect(pool.setGeminiProxy).toHaveBeenCalledWith('gemini-1', 'http://127.0.0.1:7897')
    expect(res).toMatchObject({ ok: true })
  })

  it('setProxy：空串 = 清除（不是非法地址）', async () => {
    const pool = { setGeminiProxy: vi.fn(async () => {}) }
    const res = await handleGeminiRpc({} as never, pool, 'gemini.setProxy', {
      accountId: 'gemini-1', proxy: '',
    })
    expect(pool.setGeminiProxy).toHaveBeenCalledWith('gemini-1', '')
    expect(res).toMatchObject({ ok: true, value: { proxy: '' } })
  })

  it('⚠️ setProxy：非法地址被拒，且**不写池**', async () => {
    const pool = { setGeminiProxy: vi.fn(async () => {}) }
    const res = await handleGeminiRpc({} as never, pool, 'gemini.setProxy', {
      accountId: 'gemini-1', proxy: 'ftp://host:21',
    })
    expect(res).toMatchObject({ ok: false })
    // ⚠️ 「拒绝时不得写池」：写了就等于把非法地址落盘，重启后每次解析都抛。
    expect(pool.setGeminiProxy).not.toHaveBeenCalled()
  })

  it('⚠️ setProxy：缺 accountId 必须拒绝且不写池（审计 M34 无牙）', async () => {
    const pool = { setGeminiProxy: vi.fn(async () => {}) }
    for (const payload of [{}, { accountId: '' }, { accountId: 123 }]) {
      const res = await handleGeminiRpc({} as never, pool, 'gemini.setProxy', payload)
      expect(res, JSON.stringify(payload)).toMatchObject({ ok: false })
    }
    expect(pool.setGeminiProxy).not.toHaveBeenCalled()
  })

  it('⚠️ 不认识的方法返回 undefined（让主 switch 继续匹配）', async () => {
    // ⚠️ 回信封会把**别的** provider 的方法名误判成「格式错误」。
    expect(await handleGeminiRpc({} as never, { setGeminiProxy: vi.fn() }, 'gemini.未知', {}))
      .toBeUndefined()
  })
})

describe('⑤ testProxy 的探活语义（审计 M02/M03/M28/M35 —— 原提交零覆盖）', () => {
  // ⚠️ 原提交对 testProxy **零行为覆盖**，而模块头花了 12 行论证
  // 「为什么打 Google 不打 ip-api.com」（ip-api 能通但 Google 被拒 = 假阳性），
  // **那条论证零验证**。本组用 mock proxyFetch 把实参钉住。

  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('../../src/opencode-proxy.js') })

  /** 装一个 mock 版 opencode-proxy，返回可断言的 spy。 */
  async function withMockedProxyFetch(impl: () => Promise<Response>) {
    const spy = vi.fn(impl)
    vi.resetModules()
    vi.doMock('../../src/opencode-proxy.js', () => ({
      proxyFetch: spy,
      buildProxyDispatcher: () => ({}),
      closeAllProxyDispatchers: async () => {},
      proxyCacheSize: () => 0,
      resolveConnectPort: () => 443,
      buildSocks5Handshake: () => new Uint8Array(),
    }))
    const mod = await import('../../src/gemini-rpc.js')
    return { spy, handle: mod.handleGeminiRpc }
  }

  it('⚠️ 探活目标必须是 Google 的端点，且真用用户填的代理（打掉 M02 与 M28）', async () => {
    const { spy, handle } = await withMockedProxyFetch(async () => new Response('', { status: 400 }))
    const res = await handle({} as never, { setGeminiProxy: vi.fn() }, 'gemini.testProxy', {
      proxy: 'http://127.0.0.1:7897',
    })
    expect(res, '探活失败').toMatchObject({ ok: true })
    // ⚠️ 一条断言同时打掉两处变异：换成别的域名（M02）、绕过用户代理（M28）。
    expect(spy).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.anything(),
      expect.objectContaining({ url: 'http://127.0.0.1:7897' }),
    )
  })

  it('⚠️ HTTP 400 也算「通」（判 response.ok 会让正确配置报红，打掉 M03）', async () => {
    const { handle } = await withMockedProxyFetch(async () => new Response('', { status: 400 }))
    const res = await handle({} as never, { setGeminiProxy: vi.fn() }, 'gemini.testProxy', {
      proxy: 'http://127.0.0.1:7897',
    })
    // ⚠️ 判据是 `ok:true` **且** 回传了 400 —— 只断「文案里有 400」不行，
    // 那对一个恒返回固定对象的空实现也成立。
    expect(res).toMatchObject({ ok: true, value: { status: 400 } })
  })

  it('⚠️ 失败文案必须带根因码与墙外提示（打掉 M35）', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    const { handle } = await withMockedProxyFetch(async () => {
      throw new TypeError('fetch failed', { cause })
    })
    const res = await handle({} as never, { setGeminiProxy: vi.fn() }, 'gemini.testProxy', {
      proxy: 'http://127.0.0.1:7897',
    })
    expect(res).toMatchObject({ ok: false })
    const message = (res as { error: { message: string } }).error.message
    // ⚠️ 两条都断：只断「含根因码」会放过「丢掉 describeFetchError 但手工
    // 拼了码」的半吊子；只断「含墙外提示」会放过「只说超时不说原因」。
    expect(message).toContain('ENOTFOUND')
    expect(message).toMatch(/墙外|系统代理/)
  })
})

describe('⑥ 池字段与接线收口', () => {
  it('ProviderAccountEntry 有 geminiProxy', () => {
    expect(typesSource).toMatch(/geminiProxy\?:\s*string/)
  })

  it('⚠️ 清除代理是删键（写空串会让下游把空串当成有效地址）', () => {
    const start = poolSource.indexOf('async setGeminiProxy(')
    expect(start).toBeGreaterThan(-1)
    const body = poolSource.slice(start, start + 900)
    expect(body).toMatch(/delete entry\.geminiProxy/)
    // ⚠️ 反向：`if (!proxy) return` 会让「清除」按钮点了静默无效。
    expect(body).not.toMatch(/if \(!proxy\)\s*return/)
  })

  it('⚠️ 两个读方法都过 asProxyText（备份脏值会把该账号永久打挂）', () => {
    // ⚠️ 实测：`sanitizeAccounts` 只做 `{...candidate}` 原样透传，
    // `"geminiProxy": 12345` 原样进池 ⇒ 下游 `normalizeProxy` 的
    // `input.trim()` 抛 TypeError ⇒ 该账号永久不可用且无自愈。
    // ⚠️ **同族两个 provider 的读方法都要过**（opencode 同样中招）。
    for (const name of ['geminiProxyFor', 'opencodeProxyFor']) {
      const at = poolSource.indexOf(`${name}(accountId: string): string {`)
      expect(at, `未找到 ${name}`).toBeGreaterThan(-1)
      const body = poolSource.slice(at, at + 300)
      expect(body, `${name} 必须过 asProxyText`).toMatch(/asProxyText\(/)
      expect(body, `${name} 不得直接 ?? ''`).not.toMatch(/\?\? ''/)
    }
  })

  it('⚠️ 两个读方法各取各的字段（审计 M21「字段串台」无牙）', () => {
    // ⚠️ 只查 setGeminiProxy 的函数体不够 —— 那是「改了一半」的形态：
    // 读取侧串成 opencodeProxy 时，写入侧完全看不出来。
    const at = poolSource.indexOf('geminiProxyFor(accountId: string): string {')
    expect(poolSource.slice(at, at + 300)).toMatch(/asProxyText\(entry\?\.geminiProxy\)/)
    const at2 = poolSource.indexOf('opencodeProxyFor(accountId: string): string {')
    expect(poolSource.slice(at2, at2 + 300)).toMatch(/asProxyText\(entry\?\.opencodeProxy\)/)
  })

  it('asProxyText：只放行字符串，其余一律降级为空串（直连）', () => {
    expect(asProxyText('http://h:1')).toBe('http://h:1')
    for (const dirty of [12345, {}, [], true, null, undefined]) {
      expect(asProxyText(dirty), JSON.stringify(dirty)).toBe('')
    }
  })

  it('⚠️ setGeminiProxyPool 接线后解析器才认账号（审计 M17/M33 无牙）', () => {
    // ⚠️ 删掉 `setGeminiProxyPool(pool)` 那行后，三个消费点（探测、auth、积分）
    // **全部静默恒直连**，症状与 issue 原话逐字同形。
    expect(geminiFetchForAccount('gemini-1'), '未注入池时必须直连').toBe(fetch)

    setGeminiProxyPool({ geminiProxyFor: (id) => (id === 'gemini-1' ? 'http://127.0.0.1:7897' : '') })
    try {
      expect(geminiFetchForAccount('gemini-1'), '注入池后必须走代理').not.toBe(fetch)
      expect(geminiFetchForAccount('gemini-2'), '别的账号未配代理 ⇒ 直连').toBe(fetch)
      expect(geminiFetchForAccount(''), '空 id 恒直连').toBe(fetch)
    } finally {
      setGeminiProxyPool(undefined)
    }
  })
})

describe('⑦ 可诊断性（修法 3）', () => {
  it('UND_ERR_CONNECT_TIMEOUT ⇒ 提示里点名代理并带根因码', () => {
    const cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    const hint = geminiNetworkHint(new TypeError('fetch failed', { cause }), false)
    expect(hint).toBeDefined()
    expect(hint).toMatch(/代理/)
    expect(hint).toMatch(/UND_ERR_CONNECT_TIMEOUT/)
  })

  it('⚠️ 普通业务错误不误报（不能把 5xx 都说成「需要代理」）', () => {
    // ⚠️ 判据必须是「**不返回**提示」而不是「提示里没有代理字样」——
    // 后者对一个恒返回 undefined 的实现也成立 ⇒ 恒真、无牙。
    expect(geminiNetworkHint(new Error('HTTP 500'), false)).toBeUndefined()
  })

  it('自己 arm 的超时 ⇒ 也给提示（无 cause 时仍能指路）', () => {
    expect(geminiNetworkHint(new TypeError('fetch failed'), true)).toMatch(/代理/)
  })

  it('⚠️ isUnreachableNetworkError 读 cause 链（message 恒为 fetch failed）', () => {
    const deep = Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    const mid = new TypeError('fetch failed', { cause: deep })
    expect(isUnreachableNetworkError(new TypeError('fetch failed', { cause: mid }))).toBe(true)
  })

  it('⚠️ 业务错误不被算成「连不上」', () => {
    expect(isUnreachableNetworkError(new Error('fetch failed'))).toBe(false)
  })

  it('⚠️⚠️ 调度器**只有两格**（审计 P1-3：第三格是净损害）', () => {
    const refresh = stripComments(readFileSync(join(here, '../../src/refresh.ts'), 'utf8'))
    // ⚠️ **反向**断言才是这条要守的：三格三元链不得回来。
    // 起因：`REFRESH_UNREACHABLE_RETRY_MS` 那格对 gemini **零作用**
    // （gemini 不用 `RefreshScheduler`，走固定 30 分钟的
    // `MultiAccountRefreshScheduler`），却把另外七个 provider 的一次 DNS 抖动
    // 从 60 秒拉长到 30 分钟 —— 独立审计实测确认。
    //
    // ⚠️ 判据必须锚在**赋值语句**上而不是「整个文件不含该标识符」：
    // `isUnreachableNetworkError` 仍是导出的纯函数（`geminiNetworkHint` 的
    // 码表与之同源），只是**不再参与退避决策** —— 文件级 `not.toMatch` 会把
    // 「导出但不被三元链引用」误判成失败。
    expect(refresh, '退避三元链不得再有三格').not.toMatch(
      /const retry = isUnreachableNetworkError\(/,
    )
    expect(refresh).toMatch(
      /const retry = isAbnormalNetworkError\(error\)\s*\?\s*REFRESH_ABNORMAL_NETWORK_RETRY_MS\s*:\s*REFRESH_RETRY_MS/,
    )
    // ⚠️ 常量也不该残留（导出它却不消费 = 本仓库记过的「写进去却没人读」）。
    expect(refresh).not.toMatch(/REFRESH_UNREACHABLE_RETRY_MS/)
  })
})

describe('⑧ 回归：fetcher 替身确实被送到上游', () => {
  it('⚠️ 解析器返回的 fetcher 能真正发起请求（不是恒等占位）', async () => {
    const resolver = createGeminiFetcherResolver(() => 'http://127.0.0.1:9')
    // 127.0.0.1:9 无监听 ⇒ 连接必失败；能失败就说明请求真的发出去了。
    await expect(resolver('gemini-1')('http://127.0.0.1:1/x', {})).rejects.toThrow()
  })

  it('⚠️ 全局 fetch 路径不受影响（不配代理时行为逐字不变）', async () => {
    const calls: string[] = []
    const resolver = createGeminiFetcherResolver(() => '')
    await resolver('gemini-1')('https://example.invalid/x', {})
      .then(() => { calls.push('ok') })
      .catch(() => { calls.push('failed') })
    // ⚠️ 判据是「**确实发了请求**」（结果可能任一），不是「结果是什么」。
    expect(calls).toHaveLength(1)
  })
})
