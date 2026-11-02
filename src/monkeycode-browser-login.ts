/**
 * MonkeyCode **网页版登录**：开一个**独立 profile** 的浏览器窗口、让用户在官方页面上
 * 完成登录，再从那个 profile 里把 `monkeycode_ai_session` cookie 读回来。
 *
 * ## 为什么要有这条路（而不是让用户粘三个字段）
 *
 * 用户要的是插件既有的登录范式：**点「新建账号」→ 开浏览器 → 自己登 → 自动建号**。
 * 手工粘贴 API Key / Signing Secret / Session Cookie 三格的做法被判为「跟插件根本不搭」
 * （2026-11-02 用户纠正），因为：
 *
 * - `signing_secret` 与 `api_key` 本来就能由平台用**同一个会话 cookie** 换出来
 *   （`POST /api/v1/users/ohmyagent/api-keys`），让用户去翻三个地方抄是纯负担；
 * - cookie 是 **HttpOnly** 的（`monkeycode_ai_session`），用户在浏览器 DevTools 里
 *   都拿不到它，只能去翻配置目录 —— 那更不是插件该要求用户做的事。
 *
 * ## ⚠️⚠️ 为什么必须用**独立 profile**（不复用用户真实浏览器）
 *
 * | 理由 | 后果 |
 * |---|---|
 * | 真实 profile 被用户自己的浏览器进程独占（`SingletonLock`） | 起第二个实例时 Chromium 把 URL 转交给已存在的实例、自己退出 ⇒ CDP 端口永不就绪 |
 * | 真实 profile 里是用户的全部会话 | 读到的不一定是本次登录写进去的凭据 |
 * | 一次性目录从空开始 | 「读到 cookie」本身就能当**登录完成**的判据 |
 *
 * 参考实现（`magicrew-browser-login.ts` 文件头）记录过复用目录的后果：第二个账号
 * 登录时一秒内读到**上一个账号**的凭据 ⇒ 建不出新账号。
 *
 * ## ⚠️⚠️ 读 cookie 只能用 `Storage.getCookies`，不能指望 `Network.*`
 *
 * 文件内实测结论（`chromium-session.ts:1406-1420`，2026-10-08）：
 *
 * - 浏览器级端点只认 `Target.*` / `Storage.*` / `Browser.*`；
 * - **浏览器级没有 `Network.getAllCookies`、也没有 `Network.getCookies`**（都回 -32601）；
 * - **读 cookie 的唯一可用命令是 `Storage.getCookies`，且不需要 `sessionId`**。
 *
 * 这正好绕开了 `Runtime.evaluate` 那条路要 `Target.attachToTarget` + `sessionId` 的麻烦：
 * 本模块**不 attach 任何页面**，500ms 一拍直接问浏览器要 cookie 列表。
 *
 * ## 读到的 cookie 之后还要换 Key
 *
 * 本模块**只负责拿到 cookie**。cookie → `oma_…` + `signing_secret` 的兑换在
 * `monkeycode-credits.ts` 的 `exchangeMonkeycodeSessionForKey`（复用那边的
 * `platformRequest` 与 `unwrapEnvelope`，避免出现第二份闻封逻辑）。
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
import { MONKEYCODE, type MonkeycodeProduct } from './monkeycode-product.js'

/** 平台会话 cookie 的名字（HttpOnly，只能由 CDP 读到）。 */
export const MONKEYCODE_SESSION_COOKIE_NAME = 'monkeycode_ai_session'

/** 等待用户完成登录的上限（毫秒）：与 magicrew 同档，够慢手用户登完。 */
export const MONKEYCODE_BROWSER_LOGIN_TIMEOUT_MS = 240_000

/** 轮询间隔（毫秒）。 */
export const MONKEYCODE_BROWSER_LOGIN_POLL_MS = 500

/** 单次 CDP 调用的超时（毫秒）。 */
const CDP_COOKIE_TIMEOUT_MS = 15_000

/** 一个已起好浏览器的网页登录会话。 */
export interface MonkeycodeBrowserLogin {
  /**
   * 收掉浏览器（**幂等**，必须在 `finally` 里调）。
   *
   * ⚠️ 不调就会留下窗口、进程与 `%TEMP%` 里的一次性 profile 目录。
   */
  close(): void
  /**
   * 等用户在窗口里登完并读到 `monkeycode_ai_session`。
   *
   * ⚠️ **绝不抛错**：用户没登完 / 自己关了窗口 / 超时都是**正常路径**，
   * 返回 `undefined` 让调用方走「未完成」分支。
   */
  waitForSessionCookie(timeoutMs?: number): Promise<string | undefined>
}

/** `createChromiumMonkeycodeLogin` 的依赖（生产缺省全接线；单测逐个注入）。 */
export interface MonkeycodeBrowserLoginDeps {
  /** 产品常量（只用于登录页地址与诊断文案）。 */
  product?: MonkeycodeProduct
  /**
   * 浏览器探测（缺省 {@link findBrowserExecutable}）。
   *
   * ⚠️ **可注入是为了能测「找不到浏览器」那条路**：真机上有浏览器时那条路永远走不到，
   * 而它恰恰是用户最常见的失败（本机没装 Chromium 内核浏览器）。
   */
  resolveBrowser?: () => string | undefined
  /** 平台（只影响「找不到浏览器」的文案措辞）。缺省 `process.platform`。 */
  platform?: NodeJS.Platform
  /** 显式指定可执行文件（跳过探测）。 */
  executablePath?: string
  /** 浏览器就绪上限（缺省 `ChromiumSession` 的 30 秒）。 */
  readyTimeoutMs?: number
  /** 等待用户完成登录的上限（缺省 {@link MONKEYCODE_BROWSER_LOGIN_TIMEOUT_MS}）。 */
  timeoutMs?: number
  /** 轮询间隔。 */
  pollIntervalMs?: number
  /** 读 cookie 原语（缺省 {@link readMonkeycodeSessionCookieViaCdp}；单测注入）。 */
  readCookie?: (session: MonkeycodeLoginSession) => Promise<string | undefined>
  /** 等待原语（单测注入 ⇒ 零真实等待）。 */
  sleep?: (ms: number) => Promise<void>
  /** 时钟（单测注入）。 */
  now?: () => number
  /** 诊断输出（缺省静默）。 */
  log?: (message: string) => void
  /**
   * 浏览器会话工厂（单测注入 ⇒ 完全不起浏览器）。
   *
   * ⚠️ 缺省就是真起 `ChromiumSession`。**只有单测**该注入它。
   */
  sessionFactory?: (options: MonkeycodeLoginSessionOptions) => Promise<MonkeycodeLoginSession>
}

/** 本模块对 `ChromiumSession` 的最小依赖面（便于单测注入假会话）。 */
export interface MonkeycodeLoginSession {
  cdp: { send: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown> } | undefined
  readonly exited: boolean
  start(): Promise<void>
  dispose(): void
  readonly userDataDir: string | undefined
}

/** 起浏览器用的选项（与 `ChromiumSessionOptions` 同形，只透传本模块要用的字段）。 */
export interface MonkeycodeLoginSessionOptions {
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

/**
 * 把超时归一到合理区间。
 *
 * ⚠️ 三条防御：非有限值 / NaN / 负数都退回默认；过小（< 1s）会让用户来不及登，
 * 过大（> 10min）会让「窗口开着没人管」的会话长期占着进程。
 */
function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return MONKEYCODE_BROWSER_LOGIN_TIMEOUT_MS
  }
  return Math.min(Math.max(Math.trunc(value), 1_000), 600_000)
}

/** cookie 的 `domain` 是否属于 MonkeyCode（`.monkeycode-ai.com` / `monkeycode-ai.com`）。 */
function isMonkeycodeDomain(domain: unknown, hostnames: readonly string[]): boolean {
  if (typeof domain !== 'string') return false
  const normalized = (domain.startsWith('.') ? domain.slice(1) : domain).toLowerCase()
  return hostnames.some((host) => normalized === host || normalized.endsWith(`.${host}`))
}

/**
 * 从产品配置派生「本站在用的主机名」。
 *
 * ⚠️⚠️ **不能写死 `monkeycode-ai.com`**（2026-11-02 国际站真机踩到）：国内站是
 * `.com`、国际站是 `.net`，两站各发一枚同名 `monkeycode_ai_session=` cookie。
 * 判据写死 `.com` 的后果是国际站的窗口**永远读不到自己的 cookie** ⇒
 * `waitForSessionCookie` 一路等到 240 秒超时，账号卡停在「凭据未配置」，
 * 而浏览器窗口里明明已经登录成功。
 * ⚠️ 厂商换了域名只要改 `product.platformBaseUrl` 即可，不必回来改这里。
 */
export function monkeycodeLoginHostnamesOf(product: { readonly platformBaseUrl: string }): string[] {
  try {
    return [new URL(product.platformBaseUrl).hostname.toLowerCase()]
  } catch {
    return ['monkeycode-ai.com']
  }
}

/**
 * 通过浏览器级 CDP 读会话 cookie。
 *
 * ⚠️ **任何一步失败都返回 `undefined` 而不抛**：轮询循环里抛错会把「用户还没登完」
 * 这条正常路径显示成「登录失败」，而窗口明明还开着。
 */
export async function readMonkeycodeSessionCookieViaCdp(
  session: Pick<MonkeycodeLoginSession, 'cdp'>,
  hostnames: readonly string[] = ['monkeycode-ai.com'],
): Promise<string | undefined> {
  const cdp = session.cdp
  if (cdp === undefined) return undefined
  let result: unknown
  try {
    // ⚠️ 浏览器级命令，**不需要 sessionId**（见文件头的实测结论）。
    result = await cdp.send('Storage.getCookies', {}, CDP_COOKIE_TIMEOUT_MS)
  } catch {
    return undefined
  }
  const cookies = (result as { cookies?: unknown } | undefined)?.cookies
  if (!Array.isArray(cookies)) return undefined
  for (const entry of cookies) {
    if (entry === null || typeof entry !== 'object') continue
    const cookie = entry as { name?: unknown, value?: unknown, domain?: unknown }
    if (cookie.name !== MONKEYCODE_SESSION_COOKIE_NAME) continue
    if (typeof cookie.value !== 'string' || cookie.value.length === 0) continue
    if (!isMonkeycodeDomain(cookie.domain, hostnames)) continue
    return cookie.value
  }
  return undefined
}

/** 一个已起好浏览器的网页登录会话（实现 {@link MonkeycodeBrowserLogin}）。 */
class ChromiumCookieLogin implements MonkeycodeBrowserLogin {
  private closed = false
  private readonly defaultTimeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private readonly log: ((message: string) => void) | undefined
  private readonly read: () => Promise<string | undefined>

  constructor(
    private readonly session: MonkeycodeLoginSession,
    deps: MonkeycodeBrowserLoginDeps,
    defaultTimeoutMs: number,
    hostnames: readonly string[],
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs
    this.sleep = deps.sleep ?? defaultSleep
    this.now = deps.now ?? Date.now
    this.pollIntervalMs = deps.pollIntervalMs ?? MONKEYCODE_BROWSER_LOGIN_POLL_MS
    this.log = deps.log
    // ⚠️ 收窗后必须立刻放弃等待，否则 `close()` 之后还要空转到超时。
    this.read = async () => {
      if (this.closed || this.session.exited) return undefined
      const readCookie = deps.readCookie
      if (readCookie !== undefined) return await readCookie(this.session)
      return await readMonkeycodeSessionCookieViaCdp(this.session, hostnames)
    }
  }

  /**
   * 收掉浏览器（**幂等**）。
   *
   * ⚠️ 走 `ChromiumSession.dispose()`：它内部是 `kill()`（`taskkill /T /F`，同步等它
   * 退干净）+ 临时 profile 的**退避重试删除**。不要在别处自己 `rmSync`。
   * ⚠️ 收尾失败**不抛**：调用点在 `finally`，抛错会盖掉真正的登录结果。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.session.dispose()
    } catch {
      // 尽力而为：窗口/进程/目录各自都有兜底（系统会回收临时目录）。
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
      // ⚠️ 用户自己关了窗口 = 明确放弃，不必等满超时。
      if (this.session.exited) {
        this.log?.('[monkeycode] 浏览器窗口已关闭，停止等待登录')
        return undefined
      }
      await this.sleep(this.pollIntervalMs)
    }
    return undefined
  }
}

/**
 * 起浏览器并打开 MonkeyCode 网页（**独立 profile、可见窗口**）。
 *
 * 找不到浏览器 ⇒ 抛 {@link BrowserDeploymentError}（`deployKind: 'browser-not-found'`），
 * 文案里带 {@link browserNotFoundMessage} 的分平台提示与本次**真的尝试过**的候选清单。
 *
 * ⚠️ 这是本模块**唯一**会 `spawn` 浏览器的函数；单测只允许以
 * `resolveBrowser: () => undefined`（测找不到那条路）或注入 `sessionFactory`。
 */
export async function createChromiumMonkeycodeLogin(
  deps: MonkeycodeBrowserLoginDeps = {},
): Promise<MonkeycodeBrowserLogin> {
  const product = deps.product ?? MONKEYCODE
  const executable = deps.executablePath ?? (deps.resolveBrowser ?? findBrowserExecutable)()
  if (executable === undefined || executable.length === 0) {
    /**
     * ⚠️ 文案**必须**由 {@link browserNotFoundMessage} 生成（不自己编）：
     * 它按平台说人话，并回显「本进程看到的候选清单」——那是用户唯一能自查的东西。
     * ⚠️ `tried` 只列**真的会被尝试**的候选（绝对路径 + 非空）。
     */
    throw new BrowserDeploymentError(
      'MonkeyCode: 找不到可用的浏览器（网页版登录需要本机有一个 Chromium 内核浏览器）。'
        + browserNotFoundMessage(deps.platform ?? process.platform, 'ZCODE_CHROME_PATH', {
          tried: browserCandidates({ platform: deps.platform })
            .filter((candidate) => candidate.length > 0 && isAbsolute(candidate)),
          overrideValue: process.env.ZCODE_CHROME_PATH,
        }),
      'browser-not-found',
    )
  }
  const sessionOptions: MonkeycodeLoginSessionOptions = {
    executablePath: executable,
    /**
     * ⚠️⚠️ **窗口必须可见**（`hideWindow: false`）：用户要在这个窗口里自己登录。
     * 缺省是 `true`（把窗口移出屏幕）—— 用在这里等于「点了没反应」。
     */
    hideWindow: false,
    windowSize: '1024,800',
    // 每次登录一个**一次性** profile（理由见文件头）。
    profilePrefix: 'monkeycode-login-',
    initialUrl: product.platformBaseUrl,
    label: 'MonkeyCode',
    notFoundHint: '（网页版登录需要本机有一个 Chromium 内核浏览器）',
    ...deps.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: deps.readyTimeoutMs },
    ...deps.log === undefined ? {} : { log: deps.log },
  }
  const session = await (deps.sessionFactory
    ?? ((options: MonkeycodeLoginSessionOptions) => new ChromiumSession(options) as unknown as MonkeycodeLoginSession))(sessionOptions)
  try {
    await session.start()
  } catch (error) {
    /**
     * ⚠️ 起不来时**必须** dispose：`launch()` 失败路径只 `kill()` 进程树，
     * 临时 profile 目录由 `dispose()` 才删（它内部有退避重试）。
     * 不调就会在 `%TEMP%` 里留下一个 `monkeycode-login-*` 目录（每次失败一个）。
     */
    session.dispose()
    throw error
  }
  return new ChromiumCookieLogin(
    session,
    deps,
    normalizeTimeoutMs(deps.timeoutMs),
    monkeycodeLoginHostnamesOf(product),
  )
}

/** {@link startMonkeycodeBrowserLogin} 的选项。 */
export interface MonkeycodeBrowserLoginStartOptions {
  /** 产品配置；默认 {@link MONKEYCODE}。 */
  product?: MonkeycodeProduct
  /** 等待用户完成登录的上限（毫秒）。 */
  timeoutMs?: number
  /** 浏览器工厂（单测注入）。 */
  sessionFactory?: (options: MonkeycodeLoginSessionOptions) => Promise<MonkeycodeLoginSession>
  /** 诊断输出。 */
  log?: (message: string) => void
}

/**
 * 起浏览器打开 MonkeyCode 登录页（独立 profile），返回一个「等用户登完」的会话。
 *
 * @example
 * ```ts
 * const login = await startMonkeycodeBrowserLogin()
 * try {
 *   const cookie = await login.waitForSessionCookie(120_000)
 * } finally {
 *   login.close()   // ⚠️ 必须：否则窗口与进程残留
 * }
 * ```
 */
export async function startMonkeycodeBrowserLogin(
  options: MonkeycodeBrowserLoginStartOptions = {},
): Promise<MonkeycodeBrowserLogin> {
  const product = options.product ?? MONKEYCODE
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs)
  return await createChromiumMonkeycodeLogin({
    product,
    timeoutMs,
    ...options.sessionFactory === undefined ? {} : { sessionFactory: options.sessionFactory },
    ...options.log === undefined ? {} : { log: options.log },
  })
}
