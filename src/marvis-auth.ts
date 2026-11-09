/**
 * 腾讯 Marvis 的认证服务：OAuth 兑换、续期、资料回填与账号池适配。
 *
 * ## 两条登录腿
 *
 * | 腿 | 入口 | 用在哪 |
 * |---|---|---|
 * | 浏览器截获回调 | `loginViaBrowser('1'|'2')` | 面板「新建账号」的 QQ / 微信 |
 * | 从 magpie 导入 | `readMagpieCredential()`（宿主**自己**读
 *   `~/.config/magpie/plugin-auth.json`） | 已经在本机 magpie 里登过的用户（一键迁移） |
 *
 * 两条腿产出**同一种** `MarvisCredential`，区别只在换 code 的方式。
 *
 * ## ⚠️ 为什么 `exchangeCode` 必须带 `Ual-Access-Guid`
 *
 * 2026-11-09 真机 A/B（假 code，只读）：
 * `?login_type=QC&code=…` ⇒ `-109 RC_PARAMS_INVALID`；guid 放 query ⇒ 同样 -109；
 * guid 放 `Ual-Access-Guid` 请求头 ⇒ `-107 RC_NO_AUTH_ERR`（参数过关、code 假）。
 * ⇒ 兑换**只能**由 Node 侧带头发起，浏览器顶层导航永远做不到（这也是
 *   `marvis-browser-login.ts` 必须在 Request 阶段截停的原因）。
 *
 * @module src/marvis-auth.ts
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import { shouldRefreshNow } from './expiry-sync.js'
import { newMarvisDeviceGuid } from './marvis-device.js'
import {
  createChromiumMarvisLogin,
  type MarvisBrowserLogin,
  type MarvisLoginSessionOptions,
} from './marvis-browser-login.js'
import { MARVIS, type MarvisProduct } from './marvis-product.js'
import {
  MARVIS_BROWSER_UA,
  MARVIS_REDIRECT_URI,
  businessHeaders,
  credentialExpiresAtMs,
  marvisAccountOf,
  marvisLanguageOf,
  parseMarvisCredential,
  type MarvisCredential,
} from './marvis.js'

/** 凭据库的最小接口（与宿主 `ctx.credentials` 同形，值恒为字符串）。 */
/**
 * magpie 的凭据文件位置（magpie 与插件共用 `~/.config` 约定）。
 *
 * ⚠️ 路径**在调用时**才算（`homedir()`），不要在模块顶层算成常量：单测会把
 * `HOME`/`USERPROFILE` 指到临时目录，顶层常量会读到真实用户目录 —— 那样
 * 「没装 magpie 时要回可读错误」这条用例会变成读开发机的真文件（假绿/假红都
 * 取决于开发机上有没有登过）。
 */
export function magpieAuthPath(): string {
  return join(homedir(), '.config', 'magpie', 'plugin-auth.json')
}

/** `readMagpieMarvisCredential` 的返回：凭据 **或** 一句可读的原因。 */
export type MagpieImportResult =
  | { credential: MarvisCredential }
  | { error: string }

/**
 * 直接读本机 magpie 的 `plugin-auth.json`，取出 `marvis` 那一条。
 *
 * ## 为什么由宿主读、而不是让用户复制粘贴
 *
 * 2026-11-09 用户报障：弹窗里放一个 textarea 让用户自己去
 * `~/.config/magpie/plugin-auth.json` 里抄一段 JSON，既要求用户会找文件、
 * 又要精确复制（漏一个 `}` 就被判成「凭据不完整」）。可这个文件本来就在
 * **本机**、而且是**插件自己**能读的位置 ⇒ 没有任何理由把这件事外包给用户。
 *
 * `readFile` 可注入：单测用它喂临时文件，生产走 `readFileSync`。
 */
export function readMagpieMarvisCredential(
  options: { path?: string; readFile?: (path: string) => string } = {},
): MagpieImportResult {
  const path = options.path ?? magpieAuthPath()
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'))
  let text: string
  try {
    text = readFile(path)
  } catch {
    return {
      error: `没有读到 magpie 的凭据文件（${path}）。请确认本机 magpie 里已登录过 Marvis；也可以直接用 QQ / 微信登录。`,
    }
  }
  const credential = importCredentialFromMagpie(text)
  if (credential === undefined) {
    return {
      error: `magpie 的凭据文件里没有可用的 Marvis 条目（${path}）。需要 access / refresh / metadata.openid / metadata.guid 四个字段；也可以直接用 QQ / 微信登录。`,
    }
  }
  return { credential }
}

export interface MarvisCredentialStore {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  set(ref: CredentialRef, value: string): Promise<void>
  unset(ref: CredentialRef): Promise<void>
}

/** 面板用的只读登录状态。 */
export interface MarvisLoginStatus {
  configured: boolean
  /** 登录来源（`'qq'` / `'wechat'` / `'magpie'`）。 */
  source?: string
  expiresAt?: number
  refreshable: boolean
  /** 最近一次续期失败的原因（如有）。 */
  refreshError?: string
}

export interface MarvisAuthOptions {
  product?: MarvisProduct
  fetchImpl?: typeof fetch
  warn?: (message: string) => void
  store?: MarvisCredentialStore
  /** 浏览器登录工厂（单测注入 ⇒ 完全不起浏览器）。 */
  browserLoginFactory?: (options: {
    loginType: '1' | '2'
    guid: string
    state?: string
    /**
     * 等用户完成授权的总时长（毫秒）。
     *
     * ⚠️ 2026-11-09 评审 M2：这个字段原先**只在调用点**存在、被 `as` 断言从类型里
     * 抹掉 ⇒ 默认工厂收不到它，`createChromiumMarvisLogin` 的会话准备超时与
     * 调用方想要的等待时长**脱钩**。类型里写出来，工厂才有机会自己决定怎么用。
     */
    timeoutMs?: number
  }) => Promise<MarvisBrowserLogin>
  /** 时钟（单测注入）。 */
  now?: () => number
  /**
   * 读 magpie 凭据文件用的实现（单测注入）。
   *
   * ⚠️ 生产必须走默认的 `readFileSync`：这不是「可配置」而是「可测」——
   * 单测若去读真实 `~/.config/magpie/plugin-auth.json`，结果会取决于开发机
   * 上有没有登过 Marvis（假绿），也可能把真实凭据喂进断言。
   */
  readFile?: (path: string) => string
}

/** 从 magpie 的 `plugin-auth.json` 片段导入凭据。 */
export function importCredentialFromMagpie(raw: string): MarvisCredential | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const root = parsed as Record<string, unknown>
  // 整份 plugin-auth.json（`{ marvis: {...} }`）或单条 entry 都收。
  const entry = (root['marvis'] !== null && typeof root['marvis'] === 'object'
    ? root['marvis']
    : root) as Record<string, unknown>
  const metadata = (entry['metadata'] !== null && typeof entry['metadata'] === 'object'
    ? entry['metadata']
    : {}) as Record<string, unknown>

  const access = typeof entry['access'] === 'string' ? entry['access'] : undefined
  const refresh = typeof entry['refresh'] === 'string' ? entry['refresh'] : undefined
  const openid = typeof metadata['openid'] === 'string'
    ? metadata['openid']
    : typeof entry['uid'] === 'string' ? entry['uid'] : undefined
  const guid = typeof metadata['guid'] === 'string' ? metadata['guid'] : undefined
  if (access === undefined || access === '') return undefined
  if (refresh === undefined || refresh === '') return undefined
  if (openid === undefined || openid === '') return undefined
  if (guid === undefined || guid === '') return undefined

  const loginType = metadata['loginType'] === '2' ? '2' : '1'
  const expiresAt = typeof entry['expires'] === 'number' && Number.isFinite(entry['expires'])
    ? entry['expires']
    : undefined
  const nickname = typeof metadata['nickname'] === 'string' && metadata['nickname'] !== ''
    ? metadata['nickname']
    : undefined
  return {
    access_token: access,
    refresh_token: refresh,
    openid,
    guid,
    login_type: loginType,
    ...(nickname === undefined ? {} : { nickname }),
    ...(expiresAt === undefined ? {} : { expires_at: String(expiresAt) }),
  }
}

/** 把 Set-Cookie 列表解析成 name → value（值做 decodeURIComponent）。 */
export function parseMarvisCookies(headers: Headers): Record<string, string> {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const out: Record<string, string> = {}
  for (const line of list) {
    const [pair] = line.split(';')
    if (pair === undefined) continue
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index).trim().toLowerCase()
    const value = pair.slice(index + 1).trim()
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

export class MarvisAuth extends Service {
  readonly product: MarvisProduct
  private readonly fetchImpl: typeof fetch
  private readonly warnImpl: ((message: string) => void) | undefined
  private readonly store: MarvisCredentialStore | undefined
  private readonly browserLoginFactory: NonNullable<MarvisAuthOptions['browserLoginFactory']>
  private readonly now: () => number
  /** 读 magpie 凭据文件的实现（单测注入；生产走 `readFileSync`）。 */
  private readonly readFile: ((path: string) => string) | undefined
  private active = true

  constructor(ctx: Context, options: MarvisAuthOptions = {}) {
    const product = options.product ?? MARVIS
    super(ctx, `${product.id}Auth`)
    this.product = product
    this.fetchImpl = options.fetchImpl ?? fetch
    this.warnImpl = options.warn
    this.store = options.store
    this.now = options.now ?? Date.now
    this.readFile = options.readFile
    this.browserLoginFactory = options.browserLoginFactory
      ?? (async (login) => await createChromiumMarvisLogin({
        loginType: login.loginType,
        guid: login.guid,
        ...(login.state === undefined ? {} : { state: login.state }),
        /**
         * ⚠️ **刻意不把 `login.timeoutMs` 当 `readyTimeoutMs` 用**：前者是「等用户
         * 点授权」的总时长（分钟级），后者是「浏览器进程起来」的时限（30 秒级）。
         * 两者混用会让「浏览器起得慢」被误报成「会话准备超时」。等待时长由
         * `waitForCallbackUrl(options.timeoutMs)` 那一侧自己承担。
         */
        log: (message) => { this.warn(message) },
      }))
  }

  private warn(message: string): void {
    if (this.warnImpl !== undefined) this.warnImpl(message)
    else this.ctx.logger?.warn?.(message)
  }

  private storeFor(): MarvisCredentialStore | undefined {
    return this.store ?? (this.ctx.credentials as unknown as MarvisCredentialStore | undefined)
  }

  /** 读指定 ref 的凭据；解析失败当「没有」（一次凭据库损坏不该炸掉整轮续期）。 */
  async currentCredential(refName?: string): Promise<MarvisCredential | undefined> {
    const name = refName ?? this.product.defaultCredentialRef
    const store = this.storeFor()
    if (store === undefined) return undefined
    try {
      const resolved = await store.resolve(credentialRef(name))
      if (resolved === undefined) return undefined
      return parseMarvisCredential(resolved.value)
    } catch {
      return undefined
    }
  }

  /**
   * 用回调 URL 里的 code 换凭据（**唯一**一次使用 code）。
   *
   * ⚠️ 成功响应是 **302 + Set-Cookie**（不是 JSON）；错误响应才是 JSON
   * `{code:-107|-109}`。
   */
  async exchangeCode(params: {
    code: string
    loginType: '1' | '2'
    guid: string
    state?: string
  }): Promise<MarvisCredential> {
    const language = marvisLanguageOf(params.loginType)
    const search = new URLSearchParams({ login_type: language, code: params.code })
    if (params.state !== undefined && params.state !== '') search.set('state', params.state)
    const url = `${MARVIS_REDIRECT_URI}?${search.toString()}`
    const response = await this.fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: '*/*',
        'User-Agent': MARVIS_BROWSER_UA,
        'Ual-Access-Guid': params.guid,
      },
    })

    const cookies = parseMarvisCookies(response.headers)
    const accessToken = cookies['accesstoken']
    if (accessToken !== undefined && accessToken !== '') {
      const openid = cookies['openid'] ?? ''
      if (openid === '') {
        throw new Error('Marvis 登录响应缺少 openid（无法把该账号与设备绑定）')
      }
      const refreshToken = cookies['refreshtoken'] ?? ''
      if (refreshToken === '') {
        // ⚠️ magpie 的纪律：没有 refresh 会导致账号写不进 plugin-auth.json，
        //    在本插件里同样意味着「几天后必死且无法自愈」⇒ 当场说清而不是静默收下。
        throw new Error('Marvis 登录响应缺少 refresh_token（该账号将无法自动续期）')
      }
      const expiresAt = Number(cookies['access_token_expire_time'] ?? '')
      const nickname = cookies['nickname']
      return {
        access_token: accessToken,
        refresh_token: refreshToken,
        openid,
        guid: params.guid,
        login_type: params.loginType,
        ...(nickname === undefined || nickname === '' ? {} : { nickname }),
        ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expires_at: String(expiresAt) } : {}),
      }
    }

    const text = await response.text().catch(() => '')
    const code = /"code"\s*:\s*(-?\d+)/.exec(text)?.[1]
    if (code === '-107') {
      throw new Error('Marvis 授权码已失效（-107 RC_NO_AUTH_ERR）：请重新点击新建账号')
    }
    if (code === '-109') {
      throw new Error('Marvis 登录请求参数无效（-109 RC_PARAMS_INVALID）：缺少 guid 或 login_type')
    }
    throw new Error(`Marvis 登录响应里没有 access_token 凭据（HTTP ${String(response.status)}）`)
  }

  /**
   * 取账号资料（昵称 / 头像）。
   *
   * ⚠️ **失败返回空对象、绝不抛**：昵称只是展示名，取不到不该挡登录
   * （与 magicrew `withProfileNickname` 同一条纪律）。
   * ⚠️ 只带 business 签名头，**不带** `Ual-Access-Access-Token`（magpie 实测带了会 500）。
   */
  async fetchUserProfile(credential: MarvisCredential): Promise<{ nickname?: string; avatar?: string }> {
    const language = marvisLanguageOf(credential.login_type)
    const body = JSON.stringify({
      userInfo: {
        openId: credential.openid,
        accessToken: credential.access_token,
        refreshToken: credential.refresh_token,
        loginType: language,
        guid: credential.guid,
      },
    })
    try {
      const response = await this.fetchImpl(`${this.product.baseUrl}/marvis_client/marvis_get_user_info`, {
        method: 'POST',
        headers: businessHeaders(marvisAccountOf(credential), { query: body, method: 'POST' }),
        body,
        signal: AbortSignal.timeout(this.product.chatHeaderTimeoutMs),
      })
      if (!response.ok) return {}
      const json = (await response.json()) as {
        ret?: unknown
        nick_name?: unknown
        head_img_url?: unknown
      }
      if (json.ret !== 0) return {}
      const nickname = typeof json.nick_name === 'string' && json.nick_name !== ''
        ? json.nick_name
        : undefined
      const avatar = typeof json.head_img_url === 'string' && json.head_img_url !== ''
        ? json.head_img_url
        : undefined
      return {
        ...(nickname === undefined ? {} : { nickname }),
        ...(avatar === undefined ? {} : { avatar }),
      }
    } catch (error) {
      this.warn('[marvis] 读取账号资料失败（卡片昵称回落为渠道名，不影响登录）：' + String(error))
      return {}
    }
  }

  /**
   * 网页登录（QQ / 微信）：起浏览器 → 截停回调 → 换 code → 补昵称。
   *
   * @returns 凭据；用户没登完 / 自己关窗 / 超时 ⇒ `undefined`（**不是异常**）。
   */
  async loginViaBrowser(
    loginType: '1' | '2',
    options: { timeoutMs?: number } = {},
  ): Promise<MarvisCredential | undefined> {
    const guid = newMarvisDeviceGuid()
    // ⚠️ QQ 的 state 必须是小数（整数上游会拒）；微信的 state 就是 guid。
    const state = loginType === '1' ? `0.${String(Math.random()).slice(2)}` : guid
    const login = await this.browserLoginFactory({
      loginType,
      guid,
      state,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    try {
      const callbackUrl = await login.waitForCallbackUrl(options.timeoutMs)
      if (callbackUrl === undefined) return undefined
      let parsed: URL
      try {
        parsed = new URL(callbackUrl)
      } catch {
        return undefined
      }
      if (parsed.searchParams.has('error')) {
        this.warn(`[marvis] 用户未完成授权：${parsed.searchParams.get('error') ?? 'unknown'}`)
        return undefined
      }
      const code = parsed.searchParams.get('code')
      if (code === null || code === '') return undefined
      const credential = await this.exchangeCode({ code, loginType, guid, state })
      const profile = await this.fetchUserProfile(credential)
      return {
        ...credential,
        ...(profile.nickname === undefined ? {} : { nickname: profile.nickname }),
      }
    } finally {
      login.close()
    }
  }

  /** 面板状态：只看池里有没有该 provider 的账号。 */
  /**
   * 从本机 magpie 的 `plugin-auth.json` 直接读 Marvis 凭据。
   *
   * 面板上的「从 magpie 导入」走这条：用户不需要找文件、不需要复制。
   */
  readMagpieCredential(): MagpieImportResult {
    return readMagpieMarvisCredential({
      ...this.readFile === undefined ? {} : { readFile: this.readFile },
    })
  }

  async status(pool?: AccountPool): Promise<MarvisLoginStatus> {
    if (pool === undefined) {
      const credential = await this.currentCredential()
      if (credential === undefined) return { configured: false, refreshable: false }
      const expiresAt = credentialExpiresAtMs(credential)
      return {
        configured: true,
        source: credential.login_type === '2' ? 'wechat' : 'qq',
        refreshable: credential.refresh_token !== '',
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }
    }
    const accounts = pool.listAccountsByProvider(this.product.id)
    if (accounts.length === 0) return { configured: false, refreshable: false }
    const first = accounts[0]
    const credential = first === undefined ? undefined : await this.currentCredential(first.credentialRef)
    return {
      configured: true,
      ...(credential === undefined
        ? {}
        : { source: credential.login_type === '2' ? 'wechat' : 'qq' }),
      refreshable: credential !== undefined && credential.refresh_token !== '',
      ...(first?.expiresAt === undefined ? {} : { expiresAt: first.expiresAt }),
    }
  }

  /**
   * 续期**指定账号**并写回账号池。
   *
   * ⚠️ 续期响应的 `access_token` 与旧值**相同**（Marvis 只重置有效期），
   * `refresh_token` 可能回空串 ⇒ **必须保留旧值**（否则账号变单向门）。
   */
  async refreshAccountCredential(
    refName: string,
    pool: AccountPool,
    accountId: string,
  ): Promise<void> {
    if (!this.active) return
    const credential = await this.currentCredential(refName)
    if (credential === undefined) return
    const body = JSON.stringify({
      userInfo: {
        openId: credential.openid,
        refreshToken: credential.refresh_token,
        accessToken: credential.access_token,
        // ⚠️ 恒为 'Marvis'，不是 QC/WX 码（magpie 的实测结论）。
        loginType: 'Marvis',
      },
    })
    const response = await this.fetchImpl(`${this.product.baseUrl}${this.product.refreshPath}`, {
      method: 'POST',
      headers: businessHeaders(marvisAccountOf(credential), { query: body, method: 'POST' }),
      body,
      signal: AbortSignal.timeout(this.product.chatHeaderTimeoutMs),
    })
    const text = await response.text()
    let json: {
      code?: unknown
      msg?: unknown
      user_info?: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
    }
    try {
      json = JSON.parse(text) as typeof json
    } catch {
      throw new Error(`Marvis 续期响应不是 JSON（HTTP ${String(response.status)}）：${text.slice(0, 200)}`)
    }
    if (json.code !== 0) {
      throw new Error(
        `Marvis 续期失败（code ${String(json.code)} ${String(json.msg ?? '')}）`,
      )
    }
    const info = json.user_info ?? {}
    const accessToken = typeof info.access_token === 'string' && info.access_token !== ''
      ? info.access_token
      : credential.access_token
    const refreshToken = typeof info.refresh_token === 'string' && info.refresh_token !== ''
      ? info.refresh_token
      : credential.refresh_token
    const expiresIn = typeof info.expires_in === 'number' && Number.isFinite(info.expires_in)
      ? info.expires_in
      : undefined
    const expiresAt = expiresIn === undefined ? credentialExpiresAtMs(credential) : this.now() + expiresIn * 1_000
    const next: MarvisCredential = {
      ...credential,
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(expiresAt === undefined ? {} : { expires_at: String(expiresAt) }),
    }
    // ⚠️ 回来时再判一次：网络往返期间用户可能已登出/删除账号。
    if (!this.active) return
    await this.storeFor()?.set(credentialRef(refName), JSON.stringify(next))
    if (expiresAt !== undefined) await pool.updateAccount(accountId, { expiresAt })
  }

  /** 批量续期（调度器入口）；只看 lead-time，不看 enabled / refreshable。 */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = pool.listAccountsByProvider(this.product.id)
    for (const account of accounts) {
      const refName = account.credentialRef
      if (typeof refName !== 'string' || refName === '') continue
      if (!shouldRefreshNow(account.expiresAt, this.now())) continue
      try {
        await this.refreshAccountCredential(refName, pool, account.id)
      } catch (error) {
        this.warn(`[marvis] 续期账号 ${account.id} 失败：${String(error)}`)
      }
    }
  }

  /** 对账：过期且能续期的账号返回其 id（面板状态用）。 */
  async checkExpired(pool?: AccountPool): Promise<readonly string[]> {
    if (pool === undefined) return []
    return pool
      .listAccountsByProvider(this.product.id)
      .filter((account) => account.expiresAt !== undefined && account.expiresAt <= this.now())
      .map((account) => account.id)
  }

  /** 登出（阻止在途续期回写）。 */
  async logout(): Promise<void> {
    this.active = false
  }

  /** 插件被停用时调用。 */
  stop(): void {
    this.active = false
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    marvisAuth: MarvisAuth
  }
}
