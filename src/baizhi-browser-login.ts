/**
 * 百智云**网页版登录**：开一个**独立 profile** 的浏览器窗口，让用户在
 * `baizhi.cloud` 控制台完成登录，再把控制台那两枚 cookie（`sl-session` +
 * `baizhi_session`）读回来。
 *
 * ## 为什么百智云也要浏览器登录（两个理由）
 *
 * 1. **模型 Key 可以自动取**：`GET https://baizhi.cloud/api/v1/user/api-keys`
 *    用网页登录态直接返回**明文** `items[].key`（实测 2026-11-02：
 *    `{"items":[{"id":188069570000001,"name":"demo-user","key":"sk-…"}]}`）
 *    ⇒ 用户只要登进去，插件就能自动建号，不需要去控制台翻 API Key 页抄。
 * 2. **积分只有登录态能读**：`/api/v1/user/wallet/balance`、
 *    `/api/v1/user/wallet/app-credit-usage` 只认 cookie；拿 `sk-` 走
 *    `x-api-key` 一律 401。只填 Key 的账号「能发消息但看不到积分」，
 *    而用户明确要求卡片上要显示积分（2026-11-02 报障）。
 *
 * ## ⚠️ 与 monkeycode 版的差异：这里要读**两枚** cookie
 *
 * 控制台同时下发 `sl-session`（设备/风控会话）与 `baizhi_session`（登录会话），
 * 实测**两枚都要带上**才能通过（只带 `baizhi_session` 时 `/api/v1/user/profile`
 * 会 401）。故本模块把它们拼成一个 `Cookie` 头字符串返回，调用方原样存进
 * 凭据的 `session_cookie`。
 *
 * ## ⚠️⚠️ 必须按 `domain === 'baizhi.cloud'` **精确**匹配
 *
 * `baizhi-cookies.json` 里实测有**三枚** `sl-session`：一枚属于 `baizhi.cloud`，
 * 另两枚分别属于 `ai-models.app.baizhi.cloud` 与 `agent-toolkit.app.baizhi.cloud`。
 * 用「后缀包含」判据会随机拿到网关那枚 —— 它不是控制台会话。
 *
 * ## 读 cookie 只能用 `Storage.getCookies`
 *
 * `chromium-session.ts:1406-1420` 的实测结论：浏览器级端点只认
 * `Target.*` / `Storage.*` / `Browser.*`，**没有 `Network.getCookies`**；
 * 读 cookie 的唯一可用命令是 `Storage.getCookies`，且不需要 `sessionId`。
 *
 * @module src/baizhi-browser-login.ts
 */

import { isAbsolute } from 'node:path'

import {
  BrowserDeploymentError,
  ChromiumSession,
  browserCandidates,
  browserNotFoundMessage,
  findBrowserExecutable,
  sleep as defaultSleep,
} from './chromium-session.js'
import { BAIZHI, type BaizhiProduct } from './baizhi-product.js'
import { BAIZHI_SESSION_COOKIE_NAME, BAIZHI_SL_SESSION_COOKIE_NAME } from './baizhi-credits.js'

/** 控制台域名（cookie 必须**精确**落在这个域上）。 */
export const BAIZHI_CONSOLE_HOST = 'baizhi.cloud'

/** 等待用户完成登录的上限（毫秒）：与 magicrew / monkeycode 同档。 */
export const BAIZHI_BROWSER_LOGIN_TIMEOUT_MS = 240_000

/** 轮询间隔（毫秒）。 */
export const BAIZHI_BROWSER_LOGIN_POLL_MS = 500

/** 单次 CDP 调用超时（毫秒）。 */
const CDP_COOKIE_TIMEOUT_MS = 15_000

/** 一个已起好浏览器的网页登录会话。 */
export interface BaizhiBrowserLogin {
  /** 收掉浏览器（**幂等**，必须在 `finally` 里调）。 */
  close(): void
  /**
   * 等用户在窗口里登完并读到控制台 cookie。
   *
   * 返回拼好的 `sl-session=…; baizhi_session=…` 串；**绝不抛错** ——
   * 用户没登完 / 自己关窗 / 超时都是正常路径，返回 `undefined`。
   */
  waitForSessionCookie(timeoutMs?: number): Promise<string | undefined>
}

/** 浏览器会话的最小依赖面（便于单测注入假会话）。 */
export interface BaizhiLoginSession {
  cdp: { send: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown> } | undefined
  readonly exited: boolean
  start(): Promise<void>
  dispose(): void
  readonly userDataDir: string | undefined
}

/** 起浏览器用的选项。 */
export interface BaizhiLoginSessionOptions {
  executablePath: string
  hideWindow: boolean
  windowSize: string
  profilePrefix: string
  initialUrl: string
  label: string
  notFoundHint: string
  readyTimeoutMs?: number
  log?: (message: string) => void
}

/** `createChromiumBaizhiLogin` 的依赖（生产缺省全接线；单测逐个注入）。 */
export interface BaizhiBrowserLoginDeps {
  /** 产品常量（只用于登录页地址与诊断文案）。 */
  product?: BaizhiProduct
  /** 浏览器探测（缺省 {@link findBrowserExecutable}；可注入以测「找不到」那条路）。 */
  resolveBrowser?: () => string | undefined
  /** 平台（只影响「找不到浏览器」的文案措辞）。缺省 `process.platform`。 */
  platform?: NodeJS.Platform
  /** 显式指定可执行文件（跳过探测）。 */
  executablePath?: string
  /** 浏览器就绪上限（缺省 `ChromiumSession` 的 30 秒）。 */
  readyTimeoutMs?: number
  /** 等待用户完成登录的上限。 */
  timeoutMs?: number
  /** 轮询间隔。 */
  pollIntervalMs?: number
  /** 读 cookie 原语（缺省 {@link readBaizhiSessionCookieViaCdp}；单测注入）。 */
  readCookie?: (session: BaizhiLoginSession) => Promise<string | undefined>
  /** 等待原语（单测注入 ⇒ 零真实等待）。 */
  sleep?: (ms: number) => Promise<void>
  /** 时钟（单测注入）。 */
  now?: () => number
  /** 诊断输出（缺省静默）。 */
  log?: (message: string) => void
  /** 浏览器会话工厂（单测注入 ⇒ 完全不起浏览器）。 */
  sessionFactory?: (options: BaizhiLoginSessionOptions) => Promise<BaizhiLoginSession>
}

/** 把超时归一到合理区间。 */
function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return BAIZHI_BROWSER_LOGIN_TIMEOUT_MS
  }
  return Math.min(Math.max(Math.trunc(value), 1_000), 600_000)
}

/** cookie 的 domain 是否**精确**是控制台域（不接受子域，理由见文件头）。 */
function isConsoleDomain(domain: unknown): boolean {
  if (typeof domain !== 'string') return false
  const normalized = (domain.startsWith('.') ? domain.slice(1) : domain).toLowerCase()
  return normalized === BAIZHI_CONSOLE_HOST
}

/**
 * 通过浏览器级 CDP 读控制台 cookie，拼成 `Cookie` 头。
 *
 * 顺序固定为 `sl-session` → `baizhi_session`（与浏览器实际下发顺序一致）。
 * 两枚**都读到**才算登录完成：只读到一枚时返回 `undefined` 继续等，
 * 因为那通常意味着「用户还在登录页、登录会话 cookie 尚未写入」。
 *
 * ⚠️ **任何一步失败都返回 `undefined` 而不抛**：轮询里抛错会把「还没登完」
 * 显示成「登录失败」，而窗口明明还开着。
 */
export async function readBaizhiSessionCookieViaCdp(
  session: Pick<BaizhiLoginSession, 'cdp'>,
): Promise<string | undefined> {
  const cdp = session.cdp
  if (cdp === undefined) return undefined
  let result: unknown
  try {
    result = await cdp.send('Storage.getCookies', {}, CDP_COOKIE_TIMEOUT_MS)
  } catch {
    return undefined
  }
  const cookies = (result as { cookies?: unknown } | undefined)?.cookies
  if (!Array.isArray(cookies)) return undefined
  let slSession: string | undefined
  let baizhiSession: string | undefined
  for (const entry of cookies) {
    if (entry === null || typeof entry !== 'object') continue
    const cookie = entry as { name?: unknown, value?: unknown, domain?: unknown }
    if (typeof cookie.value !== 'string' || cookie.value.length === 0) continue
    if (!isConsoleDomain(cookie.domain)) continue
    if (cookie.name === BAIZHI_SL_SESSION_COOKIE_NAME) slSession = cookie.value
    else if (cookie.name === BAIZHI_SESSION_COOKIE_NAME) baizhiSession = cookie.value
  }
  if (slSession === undefined || baizhiSession === undefined) return undefined
  return `${BAIZHI_SL_SESSION_COOKIE_NAME}=${slSession}; ${BAIZHI_SESSION_COOKIE_NAME}=${baizhiSession}`
}

/** 一个已起好浏览器的网页登录会话。 */
class ChromiumConsoleLogin implements BaizhiBrowserLogin {
  private closed = false
  private readonly defaultTimeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private readonly log: ((message: string) => void) | undefined
  private readonly read: () => Promise<string | undefined>

  constructor(
    private readonly session: BaizhiLoginSession,
    deps: BaizhiBrowserLoginDeps,
    defaultTimeoutMs: number,
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs
    this.sleep = deps.sleep ?? defaultSleep
    this.now = deps.now ?? Date.now
    this.pollIntervalMs = deps.pollIntervalMs ?? BAIZHI_BROWSER_LOGIN_POLL_MS
    this.log = deps.log
    this.read = async () => {
      if (this.closed || this.session.exited) return undefined
      const readCookie = deps.readCookie
      if (readCookie !== undefined) return await readCookie(this.session)
      return await readBaizhiSessionCookieViaCdp(this.session)
    }
  }

  /** 收掉浏览器（幂等，失败不抛）。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.session.dispose()
    } catch {
      // 尽力而为：窗口/进程/临时目录各有兜底。
    }
  }

  async waitForSessionCookie(
    timeoutMs: number = this.defaultTimeoutMs,
  ): Promise<string | undefined> {
    const deadline = this.now() + normalizeTimeoutMs(timeoutMs)
    while (this.now() < deadline) {
      if (this.closed) return undefined
      const value = await this.read()
      if (value !== undefined) return value
      if (this.session.exited) {
        this.log?.('[baizhi] 浏览器窗口已关闭，停止等待登录')
        return undefined
      }
      await this.sleep(this.pollIntervalMs)
    }
    return undefined
  }
}

/**
 * 起浏览器并打开百智云控制台（**独立 profile、可见窗口**）。
 *
 * 找不到浏览器 ⇒ 抛 `BrowserDeploymentError('browser-not-found')`，
 * 文案由 {@link browserNotFoundMessage} 生成（按平台说人话 + 回显候选清单）。
 */
export async function createChromiumBaizhiLogin(
  deps: BaizhiBrowserLoginDeps = {},
): Promise<BaizhiBrowserLogin> {
  const product = deps.product ?? BAIZHI
  const executable = deps.executablePath ?? (deps.resolveBrowser ?? findBrowserExecutable)()
  if (executable === undefined || executable.length === 0) {
    throw new BrowserDeploymentError(
      '百智云: 找不到可用的浏览器（网页版登录需要本机有一个 Chromium 内核浏览器）。'
        + browserNotFoundMessage(deps.platform ?? process.platform, 'ZCODE_CHROME_PATH', {
          tried: browserCandidates({ platform: deps.platform })
            .filter((candidate) => candidate.length > 0 && isAbsolute(candidate)),
          overrideValue: process.env.ZCODE_CHROME_PATH,
        }),
      'browser-not-found',
    )
  }
  const sessionOptions: BaizhiLoginSessionOptions = {
    executablePath: executable,
    // ⚠️ 窗口必须可见：用户要在这个窗口里自己登录。
    hideWindow: false,
    windowSize: '1024,800',
    profilePrefix: 'baizhi-login-',
    initialUrl: `${product.platformBaseUrl}/console`,
    label: '百智云',
    notFoundHint: '（网页版登录需要本机有一个 Chromium 内核浏览器）',
    ...deps.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: deps.readyTimeoutMs },
    ...deps.log === undefined ? {} : { log: deps.log },
  }
  const session = await (deps.sessionFactory
    ?? ((options: BaizhiLoginSessionOptions) => new ChromiumSession(options) as unknown as BaizhiLoginSession))(sessionOptions)
  try {
    await session.start()
  } catch (error) {
    // 起不来时必须 dispose：否则 %TEMP% 里每次失败留一个 profile 目录。
    session.dispose()
    throw error
  }
  return new ChromiumConsoleLogin(session, deps, normalizeTimeoutMs(deps.timeoutMs))
}

/** {@link startBaizhiBrowserLogin} 的选项。 */
export interface BaizhiBrowserLoginStartOptions {
  /** 产品配置；默认 {@link BAIZHI}。 */
  product?: BaizhiProduct
  /** 等待用户完成登录的上限（毫秒）。 */
  timeoutMs?: number
  /** 浏览器工厂（单测注入）。 */
  sessionFactory?: (options: BaizhiLoginSessionOptions) => Promise<BaizhiLoginSession>
  /** 诊断输出。 */
  log?: (message: string) => void
}

/**
 * 起一次网页登录（便捷包装）。
 *
 * 调用方**必须**在 `finally` 里 `login.close()`。
 */
export async function startBaizhiBrowserLogin(
  options: BaizhiBrowserLoginStartOptions = {},
): Promise<BaizhiBrowserLogin> {
  return await createChromiumBaizhiLogin({
    ...(options.product === undefined ? {} : { product: options.product }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.sessionFactory === undefined ? {} : { sessionFactory: options.sessionFactory }),
    ...(options.log === undefined ? {} : { log: options.log }),
  })
}
