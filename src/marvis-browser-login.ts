/**
 * Marvis 的**隔离浏览器登录**：在 Request 阶段截停 OAuth 回调。
 *
 * ## 为什么不能像别的 provider 那样「等 cookie」
 *
 * Marvis 的回调端点是 `https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth`，
 * 它**不是**登录成功的证明，而是一个**一次性 code 兑换入口**：
 *
 * - 浏览器一发出这个请求，`code` 就被消费掉了（第二次换回 `-107 RC_NO_AUTH_ERR`）；
 * - 而它**必须**带 `Ual-Access-Guid` 请求头才认参数（2026-11-09 实测：
 *   guid 放 query ⇒ `-109 RC_PARAMS_INVALID`），**浏览器顶层导航带不了自定义头**
 *   ⇒ 让浏览器真的发出这个请求，结果是页面上显示一段 JSON 错误，而我们
 *   永远拿不到能用的 code。
 *
 * ⇒ 唯一可行的做法（magpie 同款）：用 CDP 的 **`Fetch` 域**在
 * `requestStage: 'Request'` 把它**拦在发出之前**，`Fetch.fulfillRequest`
 * 喂一段静态「登录成功」页，然后把 URL 交给 Node 侧**带 guid 换唯一一次**。
 *
 * ## ⚠️ 为什么必须 `Fetch.fulfillRequest` 而不是 `Fetch.continueRequest`
 *
 * 放行就等于让浏览器真的请求了回调端点 —— 即使我们同时拿到了 URL，`code` 也
 * 已被消费（且 params 检查在前，浏览器那次必然 `-109`，code 反而**没**被消费，
 * 但这依赖上游实现细节）。`fulfillRequest` 是**确定性**的：请求根本不出网。
 *
 * @module src/marvis-browser-login.ts
 */

import { isAbsolute } from 'node:path'

import {
  BrowserDeploymentError,
  ChromiumSession,
  browserCandidates,
  browserNotFoundMessage,
  findBrowserExecutable,
  sleep as defaultSleep,
  type CdpEvent,
} from './chromium-session.js'
import { MARVIS, type MarvisProduct } from './marvis-product.js'
import {
  MARVIS_DEFAULT_CLIENT_VERSION,
  MARVIS_QQ_APP_ID,
  MARVIS_REDIRECT_URI,
  MARVIS_WX_APP_ID,
} from './marvis.js'

/** 回调路径（**唯一**被 Marvis 注册的 redirect_uri 路径，改不了）。 */
const CALLBACK_PATH = 'marvis_client_login/marvis_oauth'

/** 等待用户完成登录的上限（毫秒）：与 magicrew / monkeycode 同档。 */
export const MARVIS_BROWSER_LOGIN_TIMEOUT_MS = 240_000

/** 轮询间隔（毫秒）。 */
export const MARVIS_BROWSER_LOGIN_POLL_MS = 500

/** 单次 CDP 调用的超时（毫秒）。 */
const CDP_TIMEOUT_MS = 15_000

/**
 * 喂给浏览器的静态完成页。
 *
 * ⚠️ 必须**自包含**（无外链、无脚本）：此时浏览器处于 `Fetch` 拦截状态，
 * 任何额外子资源都会再触发一次 `Fetch.requestPaused`，而我们只对该路径
 * 放行 ⇒ 页面会白屏等待。
 */
export const MARVIS_CALLBACK_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Marvis 登录完成</title>
<style>body{font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:0;display:flex;height:100vh;align-items:center;justify-content:center;background:#f6f7f9;color:#1f2328}main{text-align:center;padding:32px 40px;background:#fff;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.06)}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#57606a}</style>
</head><body><main><h1>登录已完成</h1><p>可以关闭此窗口，回到 DSH 继续。</p></main></body></html>`

/**
 * 构造 Marvis 的授权页 URL。
 *
 * ## 两个平台的形状**不同**（都是 2026-11-09 真机核对过的）
 *
 * - QQ：`graph.qq.com/oauth2.0/authorize`，`state` 必须是**小数**
 *   （magpie 注释：整数会被上游拒），`login_type` 放在 redirect_uri 的 query 里；
 * - 微信：`open.weixin.qq.com/connect/qrconnect`，`state` 就是设备 guid
 *   （回调时靠它取回同一个 guid），`login_type` 同样在 redirect_uri 里。
 */
export function authorizeUrlOf(
  loginType: '1' | '2',
  guid: string,
  state?: string,
): string {
  if (loginType === '1') {
    const qqState = state === undefined || state === '' ? `0.${String(Math.random()).slice(2)}` : state
    const params = new URLSearchParams({
      which: 'Login',
      display: 'pc',
      response_type: 'code',
      client_id: MARVIS_QQ_APP_ID,
      redirect_uri: `${MARVIS_REDIRECT_URI}?login_type=QC`,
      state: qqState,
    })
    return `https://graph.qq.com/oauth2.0/authorize?${params.toString()}`
  }
  const params = new URLSearchParams({
    appid: MARVIS_WX_APP_ID,
    redirect_uri: `${MARVIS_REDIRECT_URI}?login_type=WX`,
    response_type: 'code',
    scope: 'snsapi_login',
    state: guid,
  })
  return `https://open.weixin.qq.com/connect/qrconnect?${params.toString()}`
}

/**
 * 这个 URL 是不是授权回调。
 *
 * ⚠️ 只认路径**且**带 `code=` 或 `error=`：同一路径也是授权页自己的
 * `redirect_uri` 参数值，若只判路径，页面刚打开就会被当成「已回调」。
 */
export function isMarvisCallbackUrl(url: string, matcher?: RegExp): boolean {
  if (matcher !== undefined) return matcher.test(url)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const path = parsed.pathname.toLowerCase()
  if (!path.includes(CALLBACK_PATH)) return false
  return parsed.searchParams.has('code') || parsed.searchParams.has('error')
}

/** 一个已起好浏览器的登录会话。 */
export interface MarvisBrowserLogin {
  /** 收掉浏览器（**幂等**，必须在 `finally` 里调）。 */
  close(): void
  /**
   * 等用户在窗口里登完，返回**被截停的回调 URL**。
   *
   * ⚠️ **绝不抛错**：用户没登完 / 自己关了窗口 / 超时都是**正常路径**，
   * 返回 `undefined` 让调用方走「未完成」分支。
   */
  waitForCallbackUrl(timeoutMs?: number): Promise<string | undefined>
}

/** 本模块对 `ChromiumSession` 的最小依赖面（便于单测注入假会话）。 */
export interface MarvisLoginSession {
  cdp:
    | {
        send: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
        subscribe: (listener: (event: CdpEvent) => void) => () => void
      }
    | undefined
  readonly exited: boolean
  start(): Promise<void>
  dispose(): void
  readonly userDataDir: string | undefined
}

/** 起浏览器用的选项（与 `ChromiumSessionOptions` 同形，只透传本模块要用的字段）。 */
export interface MarvisLoginSessionOptions {
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

export interface MarvisBrowserLoginDeps {
  product?: MarvisProduct
  loginType: '1' | '2'
  guid: string
  state?: string
  /** 浏览器探测（缺省 {@link findBrowserExecutable}）。 */
  resolveBrowser?: () => string | undefined
  platform?: NodeJS.Platform
  executablePath?: string
  readyTimeoutMs?: number
  timeoutMs?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (message: string) => void
  /** 浏览器会话工厂（单测注入 ⇒ 完全不起浏览器）。 */
  sessionFactory?: (options: MarvisLoginSessionOptions) => Promise<MarvisLoginSession>
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return MARVIS_BROWSER_LOGIN_TIMEOUT_MS
  }
  return Math.min(Math.max(Math.trunc(value), 1_000), 600_000)
}

class ChromiumMarvisLogin implements MarvisBrowserLogin {
  private closed = false
  private captured: string | undefined
  private readonly defaultTimeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly log: ((message: string) => void) | undefined
  private readonly unsubscribe: (() => void) | undefined

  constructor(
    private readonly session: MarvisLoginSession,
    deps: MarvisBrowserLoginDeps,
    defaultTimeoutMs: number,
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs
    this.sleep = deps.sleep ?? defaultSleep
    this.pollIntervalMs = deps.pollIntervalMs ?? MARVIS_BROWSER_LOGIN_POLL_MS
    this.log = deps.log
    this.unsubscribe = this.session.cdp?.subscribe((event) => {
      void this.onCdpEvent(event)
    })
  }

  /**
   * 处理 `Fetch.requestPaused`。
   *
   * ⚠️ 必须在**同一次事件回调里**同步发出 `fulfillRequest`/`continueRequest`：
   * 被 pause 的请求会一直挂着，直到我们回其中一条；不回的后果是页面
   * 永久等待（用户看到的是「点了登录没反应」）。
   */
  private async onCdpEvent(event: CdpEvent): Promise<void> {
    if (event.method !== 'Fetch.requestPaused') return
    const params = event.params as {
      requestId?: unknown
      request?: { url?: unknown }
    }
    const requestId = typeof params.requestId === 'string' ? params.requestId : undefined
    const url = typeof params.request?.url === 'string' ? params.request.url : undefined
    if (requestId === undefined || url === undefined) return
    try {
      if (!isMarvisCallbackUrl(url)) {
        await this.session.cdp?.send('Fetch.continueRequest', { requestId }, CDP_TIMEOUT_MS)
        return
      }
      this.captured = url
      await this.session.cdp?.send(
        'Fetch.fulfillRequest',
        {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from(MARVIS_CALLBACK_PAGE, 'utf8').toString('base64'),
        },
        CDP_TIMEOUT_MS,
      )
      this.log?.('[marvis] 已截停授权回调，code 未被消费')
    } catch {
      // 浏览器已关 / 请求已失效：等待侧会因 exited 提前返回。
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.unsubscribe?.()
    } catch {
      // 尽力而为
    }
    try {
      this.session.dispose()
    } catch {
      // 收尾失败不抛：调用点在 finally，抛错会盖掉真正的登录结果。
    }
  }

  async waitForCallbackUrl(timeoutMs: number = this.defaultTimeoutMs): Promise<string | undefined> {
    // ⚠️ 用**累计等待**判超时，而不是比较时钟：注入的 `now` 在单测里是常量
    //    （`() => 0`），比较时钟会死循环。
    const timeout = normalizeTimeoutMs(timeoutMs)
    let waited = 0
    while (waited < timeout) {
      if (this.closed) return undefined
      if (this.captured !== undefined) return this.captured
      // ⚠️ 用户自己关了窗口 = 明确放弃，不必等满超时。
      if (this.session.exited) {
        this.log?.('[marvis] 浏览器窗口已关闭，停止等待登录')
        return undefined
      }
      await this.sleep(this.pollIntervalMs)
      waited += this.pollIntervalMs
    }
    return undefined
  }
}

/**
 * 起浏览器打开 Marvis 授权页（**独立 profile、可见窗口**）。
 *
 * 找不到浏览器 ⇒ 抛 {@link BrowserDeploymentError}（`deployKind: 'browser-not-found'`）。
 */
export async function createChromiumMarvisLogin(
  deps: MarvisBrowserLoginDeps,
): Promise<MarvisBrowserLogin> {
  const product = deps.product ?? MARVIS
  const executable = deps.executablePath ?? (deps.resolveBrowser ?? findBrowserExecutable)()
  if (executable === undefined || executable.length === 0) {
    throw new BrowserDeploymentError(
      'Marvis: 找不到可用的浏览器（登录需要本机有一个 Chromium 内核浏览器）。'
        + browserNotFoundMessage(deps.platform ?? process.platform, 'ZCODE_CHROME_PATH', {
          tried: browserCandidates({ platform: deps.platform }).filter(
            (candidate) => candidate.length > 0 && isAbsolute(candidate),
          ),
          overrideValue: process.env.ZCODE_CHROME_PATH,
        }),
      'browser-not-found',
    )
  }
  const sessionOptions: MarvisLoginSessionOptions = {
    executablePath: executable,
    // ⚠️ 窗口必须可见：用户要在这个窗口里扫码/登录。
    hideWindow: false,
    windowSize: '1024,800',
    profilePrefix: 'marvis-login-',
    initialUrl: authorizeUrlOf(deps.loginType, deps.guid, deps.state),
    label: 'Marvis',
    notFoundHint: '（登录需要本机有一个 Chromium 内核浏览器）',
    ...(deps.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: deps.readyTimeoutMs }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
  }
  const session = await (deps.sessionFactory
    ?? ((options: MarvisLoginSessionOptions) =>
      new ChromiumSession(options) as unknown as MarvisLoginSession))(sessionOptions)
  try {
    await session.start()
    /**
     * ⚠️ **如实说明**（2026-11-09 评审 M3）：注释写「必须在导航之前」是不成立的
     * —— `ChromiumSession` 把 `initialUrl` 当**命令行参数**传给 chromium
     * （`spawn(executable, [..., initialUrl])`），导航在 `start()` 返回前就已经
     * 开始。今天无害：`mkdtempSync` 出来的是全新 profile，没有任何既有 cookie，
     * 用户必须**手动**点授权才可能产生回调 —— 而人手点的动作必然晚于本行。
     *
     * ⚠️ 若将来改成复用 profile（带既有登录态），**必须**改成「先 `Fetch.enable`
     *    再导航」，否则回调可能在 enable 之前就发出（`code` 被浏览器消费掉）。
     */
    await session.cdp?.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*marvis_oauth*', requestStage: 'Request' }] },
      CDP_TIMEOUT_MS,
    )
  } catch (error) {
    session.dispose()
    throw error
  }
  return new ChromiumMarvisLogin(session, deps, normalizeTimeoutMs(deps.timeoutMs))
}

