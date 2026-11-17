/**
 * Raccoon Work 的**浏览器授权**登录（官方客户端自己的那条链）。
 *
 * ## 为什么要有这个模块
 *
 * 官方桌面端 2026-11-05 的构建**不再走扫码确认页**：它开的是 `/authorize`
 * 授权页（系统浏览器），用户在**网页里**完成登录（手机号 / 微信扫码 —— 那是
 * 页面自己的一张**活的**二维码，与已死的 `/login/mp` 不是同一张），
 * 确认后页面申请一枚**一次性** `authorization_code`，再把它**投递回调用方**：
 * 要么是注册过的 `office-raccoon://` 自定义协议（只有官方 App 能收），
 * 要么是 **`127.0.0.1:<port>` 上的回环接收端**（Windows/Linux 兼容形态，
 * 第三方可以自己托管）。
 *
 * ⚠️ **本仓为什么必须走回环形态**：`office-raccoon://` 是宿主 Node 进程
 * **收不到**的自定义协议回调。而本仓原先的扫码链**已经死了** ——
 * 扫码确认页 `/login/mp` 自 2026-11-04 起**全部 404**（含微信 UA），
 * 而**签发本身是成功的** ⇒ 用户扫进去只看到一个 404 页，零报错。
 * 本模块是那半条死链的**替代**：官方客户端的授权页 + 回环接收端 + 换码。
 *
 * ## 机制参照，不是抄端口
 *
 * 线上的事实取自三处（2026-11-17 实测）：
 *
 * 1. 官网 `/authorize` 页**在线**（HTTP 200，且把它收到的
 *    `login_source` / `appname` / `desktop_callback` / `redirect` / `state`
 *    **原样回显**进页面上下文）；
 * 2. 该页 chunk 里的**解析器规则**（见下「官方页自己的规则」）；
 * 3. 换码端点 `POST /api/web/auth/v1/login_with_authorization_code` ——
 *    实测一枚瞎编的 code 回 **HTTP 400 `{code:200035}`**（= 官方常量
 *    `AUTHORIZATION_CODE_NOT_FOUND`），证明端点与错误码都还在。
 *
 * ## 官方页自己的规则（我们逐条前置校验）
 *
 * 页面的解析器（chunk `app/(identity)/authorize/page-…js`）要求：
 *
 * - `redirect` 必须匹配 `^http://127\.0\.0\.1:[1-9][0-9]{3,4}/auth/callback$`
 *   （端口 4~5 位、首位非 0），且端口落在 1024..65535；
 * - `state` 必须是 **64 位小写 hex**；
 * - `login_source` 存在时**必须**是 `desktop`；
 * - `desktop_callback` 存在时**必须**是 `loopback`，且此时
 *   `login_source` 必为 `desktop`、`ide` 必为空、`redirect` 必过上面那条；
 * - 参数名**只能**取自 `{login_source, appname, state, redirect, ide, org,
 *   lang, desktop_callback}` —— 多一个键整条链接就作废。
 *
 * ⇒ 一个页面会拒收的 URL **不该**拿给用户（那是个没有下一步的死路）。
 * 所以 {@link buildRaccoonAuthorizeUrl} 在**发出之前**就按这些规则自查。
 *
 * ## 回环接收端的七条规则（官方接收端的规则逐条重述）
 *
 * 授权码是一次性凭据，而一个敞开的接收端就是「凭据交换漏洞」 ⇒ 七条检查
 * **一条都不能少**：GET-only、`Host` 等于我们自己的 authority、来源地址是
 * 回环、存在的 `Origin` 必须等于网关 origin、存在的 `Sec-Fetch-Dest`
 * 必须是 `document`、路径与查询键严格受限、`state` 常量时间比对通过。
 *
 * ## 凭据的边界
 *
 * 换码的结果**只**回到调用方（换码成功后由登录页流程落进 DSH 凭据服务）。
 * 本模块**不打印**任何凭据值：失败结果只带**原因词**，不带报文原文
 * （报文可能回显那枚 code）。
 *
 * @module dsh-providers-hub/raccoon-authorize
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import {
  RACCOON_API_BASE,
  RACCOON_REQUEST_TIMEOUT_MS,
  decodeJwtExpMs,
  type RaccoonCredential,
} from './raccoon.js'
import { RACCOON, type RaccoonProduct } from './raccoon-product.js'

/**
 * 网关 origin —— 本模块构造的每条 URL 都以它为底。
 *
 * ⚠️ **重导出**（不是只 import）：调用方与测试都要拿它当「授权页 origin」和
 * 「`Origin` 头必须等于的那个值」，而这个模块**就是**这条链的定义处 ⇒
 * 从这里导出才是**单一真相源**（从别处 import 会让「改了常量、这边没改」
 * 成为可能）。
 */
export { RACCOON_API_BASE }

/** 官方客户端在系统浏览器里打开的授权页路径。 */
export const RACCOON_AUTHORIZE_PATH = '/authorize'

/**
 * 回环接收端的回调路径 —— **由官方页面写死**，不可改。
 *
 * 页面投递时用的参数名在 desktop 形态下是 **`code`**（非 desktop 才是
 * `authorization_code`；见页面 chunk 的
 * `r.searchParams.set(e.desktop ? "code" : "authorization_code", t)`）。
 */
export const RACCOON_LOOPBACK_CALLBACK_PATH = '/auth/callback'

/**
 * 授权页上显示的「申请授权的应用」名。
 *
 * 官方客户端自己的 `DESKTOP_AUTH_PARAMS` 字面量（desktopLogin.js），
 * 也是 2026-11-17 那次真机授权**成功走完**时用的名字。
 *
 * ⚠️ 官方页的解析器对三个 appname 有白名单（办公小浣熊客户端 / 商汤小浣熊
 * 客户端 / Office Raccoon），其余名字**也能解析**，但确认文案会照抄
 * 那个**未知字符串** ⇒ 页面上一句「此应用希望使用你的账号登录」会变成
 * 一句没头没尾的话。故默认用**实测走通的那个**。
 */
export const RACCOON_AUTH_APPNAME = '办公小浣熊客户端'

/**
 * 网关的「这枚授权码不存在 / 已过期 / 已消费」错误码。
 *
 * 实测（2026-11-17）：一枚瞎编的 code 打
 * `POST /api/web/auth/v1/login_with_authorization_code` ⇒ HTTP 400
 * `{"code":200035,"message":"authorization_code_not_found_error"}`。
 * 官方客户端的常量 `AUTHORIZATION_CODE_NOT_FOUND` 是**同一个值**。
 *
 * ⚠️ 这是**唯一**的出路：重发同一枚码没有任何用处，只能**重开一轮**。
 */
export const RACCOON_AUTHORIZATION_CODE_NOT_FOUND = 200035

/**
 * 回环等待的默认时限（毫秒）。
 *
 * 官方回环自己的默认值（`timeoutMs ?? 300000`）。一次「网页里重新登录」
 * （含手机号验证码）能从容落在这五分钟内。
 */
export const RACCOON_AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * IAM 令牌必须带的 `iss`。
 *
 * 官方客户端算的是 `new URL(LOGIN_URL).host + "/iam"` —— **裸 host、无 scheme**。
 * ⚠️ **无 scheme 这件事是承重的**：`iss` 是**等值**比较，若按带 scheme 的
 * 严格等值去比，会**误拒每一枚真令牌**。
 */
export const RACCOON_IAM_ISSUER = `${new URL(RACCOON_API_BASE).host}/iam`

/**
 * 回环 redirect 的机器可判形状：官方页面自己那条正则。
 *
 * 页面会拒收的 redirect 会**解析失败**并只在**投递那一刻**才炸 ⇒ 那种
 * URL 是一个「看着能点、点了没反应」的死路。所以**发出之前**就拒。
 */
const RACCOON_LOOPBACK_REDIRECT_RE = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/auth\/callback$/

/**
 * 官方页面解析器接受**全部**的参数名。
 *
 * ⚠️ 多一个键 ⇒ 整条链接作废（页面判 `null`）。所以构造时**只**放这几个。
 */
const RACCOON_AUTHORIZE_PARAM_NAMES: readonly string[] = Object.freeze([
  'login_source',
  'appname',
  'state',
  'redirect',
  'ide',
  'org',
  'lang',
  'desktop_callback',
])

/** 读一个字符串字段（非字符串 / 缺字段 → 兜底）。 */
function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * 判断一枚令牌**是不是** IAM 形态 —— 官方 `iamToken.js` 的规则：
 * `iss` 以 `/iam` 结尾。
 *
 * ⚠️ **不验签**：签名由服务端负责校验；这里只决定**走成功门的哪一半**。
 *
 * @param token - 候选 JWT。
 * @returns 是否 IAM 形态。
 */
export function isRaccoonIamToken(token: unknown): boolean {
  if (typeof token !== 'string' || token === '') return false
  const parts = token.split('.')
  if (parts.length < 2) return false
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null) return false
    const iss = (payload as Record<string, unknown>).iss
    return typeof iss === 'string' && iss.endsWith('/iam')
  } catch {
    return false
  }
}

/**
 * 官方 `iamTokenIsValid` 的重述：同一个 issuer、非空 `sub`、未来的有限 `exp`
 * —— 且 `exp` 不能大到让 `new Date(exp*1000)` 不是一个日期。
 *
 * @param token - access token。
 * @param issuer - 期望的 `iss`（默认 {@link RACCOON_IAM_ISSUER}）。
 * @returns 是否通过。
 */
export function raccoonIamTokenIsValid(
  token: unknown,
  issuer: string = RACCOON_IAM_ISSUER,
): boolean {
  if (typeof token !== 'string' || token === '') return false
  const parts = token.split('.')
  if (parts.length < 2) return false
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null) return false
    const claims = payload as Record<string, unknown>
    return claims.iss === issuer
      && typeof claims.sub === 'string'
      && claims.sub.trim() !== ''
      && typeof claims.exp === 'number'
      && Number.isFinite(claims.exp)
      && claims.exp > Date.now() / 1000
      && !Number.isNaN(new Date(claims.exp * 1000).getTime())
  } catch {
    return false
  }
}

/**
 * 构造「一次浏览器登录」打开的那条 URL。
 *
 * 每个参数都在**发出之前**按官方页面的规则自查（见文件头「官方页自己的
 * 规则」）；不合规就**抛错**（带名字），让调用方能给出一句有下一步的话，
 * 而不是丢一个页面会拒收的链接给用户。
 *
 * @param options
 * @param options.port - 回环端口（整数 1024..65535）。
 * @param options.state - 64 位小写 hex 的 state（公开的 CSRF 令牌）。
 * @param options.appname - 授权页显示的应用名（默认 {@link RACCOON_AUTH_APPNAME}）。
 * @param options.base - 网关 origin（默认 {@link RACCOON_API_BASE}）。
 * @returns 完整 URL。
 * @throws {Error} 具名的违规说明。
 */
export function buildRaccoonAuthorizeUrl({
  port,
  state,
  appname = RACCOON_AUTH_APPNAME,
  base = RACCOON_API_BASE,
}: {
  port: unknown
  state: unknown
  appname?: unknown
  base?: unknown
}): string {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('authorize: 回环端口必须是 1024..65535 的整数')
  }
  const redirect = `http://127.0.0.1:${port}${RACCOON_LOOPBACK_CALLBACK_PATH}`
  if (!RACCOON_LOOPBACK_REDIRECT_RE.test(redirect)) {
    throw new Error('authorize: 回环地址必须是 http://127.0.0.1:<4~5 位端口>/auth/callback')
  }
  const expected = readString(state, '')
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('authorize: state 必须是 64 位小写 hex')
  }
  const app = readString(appname, '')
  if (app === '' || app.length > 100) {
    throw new Error('authorize: 应用名必须是 1..100 个字符')
  }
  const origin = readString(base, '') !== '' ? readString(base, '') : RACCOON_API_BASE
  const url = new URL(origin)
  if (url.protocol !== 'https:') {
    throw new Error('authorize: 网关 origin 必须是 https')
  }
  url.pathname = RACCOON_AUTHORIZE_PATH
  url.search = ''
  url.searchParams.set('login_source', 'desktop')
  url.searchParams.set('appname', app)
  url.searchParams.set('desktop_callback', 'loopback')
  url.searchParams.set('redirect', redirect)
  url.searchParams.set('state', expected)
  // ⚠️ 自查：造出来的参数名**必须**全在官方白名单里（多一个键整条链接作废）。
  for (const key of url.searchParams.keys()) {
    if (!RACCOON_AUTHORIZE_PARAM_NAMES.includes(key)) {
      throw new Error(`authorize: 参数名 ${key} 不在官方页面的白名单里`)
    }
  }
  return url.toString()
}

/** 回环接收端的终态。 */
export interface RaccoonAuthorizeReceiverResult {
  /** 是否拿到了授权码。 */
  ok: boolean
  /** 授权码**只**在这里出现（不进响应体、不进日志）。 */
  code?: string
  /** 失败的原因词。 */
  reason?: 'timeout' | 'closed' | 'failed'
}

/** 一个活着的回环接收端及其归宿。 */
export interface RaccoonAuthorizeReceiver {
  /** 接收端期待的 state（64 hex，公开）。 */
  state: string
  /** 实际监听的端口。 */
  port: number
  /** `/authorize` URL 携带的回跳目标。 */
  redirect: string
  /** 要在系统浏览器里打开的完整 `/authorize` URL。 */
  authorizeUrl: string
  /** 只落定一次：回调带来的 code，或终态原因。 */
  result: Promise<RaccoonAuthorizeReceiverResult>
  /** 立刻关闭接收端（结果落定为 `{ok:false, reason:'closed'}`）。 */
  cancel: () => void
}

/**
 * 启动回环接收端 —— 官方 `/authorize` 页的回调落点。
 *
 * 工厂是**异步**的：端口只有在操作系统分配之后才知道（`port 0`），调用方
 * 必须在把 URL 交给浏览器**之前** await 它 —— 那时接收端**已经在听**，
 * 不存在「页面往一个还不是我们的端口上跳」的窗口。
 *
 * ⚠️ 绑不上端口（EADDRINUSE）**不抛**：调用方正处在一个请求里、需要一句
 * 答复，而它报出来的失败是用户**能动作**的（重开一轮）。
 *
 * @param options
 * @param options.port - 指定端口；缺省 / 0 = 由操作系统分配。
 * @param options.state - 64 位 hex；缺省时随机生成。
 * @param options.timeoutMs - 等待时限（默认 {@link RACCOON_AUTHORIZE_TIMEOUT_MS}）。
 * @param options.authorizationOrigin - 存在的 `Origin` 头必须等于它（默认网关 origin）。
 * @param options.appname - 授权页的应用名。
 * @param options.base - 网关 origin。
 * @returns 接收端句柄。
 */
export async function startRaccoonAuthorizeReceiver(options: {
  port?: unknown
  state?: unknown
  timeoutMs?: unknown
  authorizationOrigin?: unknown
  appname?: unknown
  base?: unknown
} = {}): Promise<RaccoonAuthorizeReceiver> {
  const state = options.state !== undefined && options.state !== null
    ? readString(options.state, '')
    : randomBytes(32).toString('hex')
  if (!/^[a-f0-9]{64}$/.test(state)) {
    throw new Error('authorize: state 必须是 64 位小写 hex')
  }
  const authorizationOrigin = readString(options.authorizationOrigin, '') !== ''
    ? readString(options.authorizationOrigin, '')
    : RACCOON_API_BASE
  const timeoutMs = typeof options.timeoutMs === 'number'
    && Number.isFinite(options.timeoutMs)
    && options.timeoutMs > 0
    ? options.timeoutMs
    : RACCOON_AUTHORIZE_TIMEOUT_MS

  let settled = false
  let consumed = false
  let server: Server | null = null
  let timer: NodeJS.Timeout | null = null
  // `settleFn` 在 Promise 的 executor 里建（它持有 `resolve`），而调用点在
  // executor 之后 ⇒ TS 会把裸 `let` 的「确定已赋值」重置 ⇒ 调用方看到的是
  // 下面这个 `finish` 包装：一个从头就存在的 const，委托给 executor 建的
  // `settleFn`（直到下一个 tick 才非空）。
  let settleFn: ((value: RaccoonAuthorizeReceiverResult, hard?: boolean) => void) | null = null
  const finish = (value: RaccoonAuthorizeReceiverResult, hard = true): void => {
    settleFn?.(value, hard)
  }
  const result: Promise<RaccoonAuthorizeReceiverResult> = new Promise((resolve) => {
    // `hard` 会拆掉在途连接（超时、绑不上、用户取消：没人欠它们一个响应）。
    // **成功路径必须软关闭**：浏览器正在读的那个 200 还在半路上，硬拆会让它
    // 报「连接被重置」—— 那是一次**其实成功了**的登录。
    settleFn = (value, hard = true) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (server !== null) {
        if (hard) server.closeAllConnections?.()
        server.close()
      }
      resolve(value)
    }
  })

  const request = (req: IncomingMessage, res: ServerResponse): void => {
    const authority = `127.0.0.1:${portOf()}`
    const answer = (status: number, body: string): void => {
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(body)
    }
    if (settled || consumed) {
      // 一次性：有效回调被取走之后（或接收端已落定），端口对一切回 **409**
      // —— 那枚 code 在上游也是一次性的，第二次投递**不得**再换一次码。
      answer(409, 'used')
      return
    }
    // 每次拒绝都说**规则的名字**，不说它的输入：`code` 的值是凭据，
    // 不能出现在响应体或日志里。
    let reason = ''
    let code: string | null = null
    try {
      const raw = typeof req.url === 'string' ? req.url : '/'
      if (req.method !== 'GET') {
        reason = 'method'
      } else if (req.headers.host !== authority) {
        reason = 'host'
      } else if (req.socket.remoteAddress !== '127.0.0.1') {
        reason = 'source'
      // ⚠️ 下面两条都是「**头存在才查**」（缺头一律放行），这是**必需的**，不要按
      //   「安全加固」的直觉改成「必须存在」：官方页面在 desktop 形态用**顶层导航**
      //   投递回调（官方 bundle 里就是 `r.navigate(t)`），而顶层导航**不发 `Origin`**
      //   ⇒ 改成必须存在会让真浏览器里 100% 收不到回调。
      } else if (typeof req.headers.origin === 'string' && req.headers.origin !== authorizationOrigin) {
        reason = 'origin'
      } else if (typeof req.headers['sec-fetch-dest'] === 'string' && req.headers['sec-fetch-dest'] !== 'document') {
        reason = 'fetch-dest'
      } else {
        const url = new URL(raw, `http://${authority}`)
        if (url.origin !== `http://${authority}` || url.pathname !== RACCOON_LOOPBACK_CALLBACK_PATH || url.hash !== '') {
          reason = 'path'
        } else {
          const keys = [...url.searchParams.keys()]
          if (keys.some((key) => !(key === 'code' || key === 'state'))
            || url.searchParams.getAll('state').length !== 1
            || url.searchParams.getAll('code').length !== 1) {
            reason = 'keys'
          } else {
            const receivedState = url.searchParams.get('state') ?? ''
            const receivedCode = (url.searchParams.get('code') ?? '').trim()
            // ⚠️ `^[a-f0-9]{64}$` 这个预判是**承重**的，不是装饰：`timingSafeEqual`
            //   对**不等长**的 Buffer 会抛 `RangeError`，被外层 catch 吞成
            //   `rejected: url` ⇒ 拒绝原因词从 `state` 退化成 `url`（诊断信息丢失）。
            //   所以先固定长度，长度不对就直接落 `state`。
            const stateOk = /^[a-f0-9]{64}$/.test(receivedState)
              && timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
            const codeOk = receivedCode !== '' && receivedCode.length <= 4096
              && !/[\x00-\x1f\x7f]/.test(receivedCode)
            if (!stateOk) {
              reason = 'state'
            } else if (!codeOk) {
              reason = 'code'
            } else {
              code = receivedCode
            }
          }
        }
      }
    } catch {
      reason = 'url'
    }
    if (code === null) {
      answer(400, `rejected: ${reason === '' ? 'callback' : reason}`)
      return
    }
    consumed = true
    // 先把 200 **冲出去**再拆：这里硬拆会把 socket 掐在半截，浏览器会读成
    // 「登录失败」（软关闭让在途响应写完，然后服务才退）。
    answer(200, 'authorized')
    // `code` 离开线路的**唯一**一刻：原样进调用方。
    finish({ ok: true, code }, false)
  }

  let assignedPort = 0
  const portOf = (): number => assignedPort
  timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs)
  timer.unref?.()
  server = createServer({ maxHeaderSize: 8192 }, request)
  server.on('error', () => finish({ ok: false, reason: 'failed' }))
  const requestedPort = typeof options.port === 'number'
    && Number.isInteger(options.port)
    && options.port > 0
    ? options.port
    : 0
  if (requestedPort !== 0 && (requestedPort < 1024 || requestedPort > 65535)) {
    // 官方页面自己那个范围外的端口**页面会拒收** ⇒ 调用方的 bug，
    // 提前抛是唯一「有下一步」的形状。
    throw new Error('authorize: 请求的端口必须是 0（随机）或 1024..65535')
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server?.removeListener('error', onError)
      reject(error)
    }
    server?.once('error', onError)
    server?.listen(requestedPort, '127.0.0.1', () => {
      server?.removeListener('error', onError)
      const address = server?.address() ?? null
      if (address === null || typeof address === 'string') {
        reject(new Error('authorize: 回环端口没有绑上'))
        return
      }
      assignedPort = address.port
      resolve()
    })
  }).catch(() => {
    // 绑不上早已把结果落定为 `failed`；调用方拿到的对象仍带着（未绑上的）
    // URL，好让它报一句有下一步的失败，而 `result` 才是真相。
  })
  // 操作系统可能分配一个**页面会拒收**的端口（< 1024）⇒ 整条链是个死路，
  // 落定为 `failed` 且不产出 URL（用户重开一轮即可）。
  const portUsable = assignedPort >= 1024 && assignedPort <= 65535
  if (!portUsable && assignedPort > 0) finish({ ok: false, reason: 'failed' })
  const redirect = `http://127.0.0.1:${assignedPort}${RACCOON_LOOPBACK_CALLBACK_PATH}`
  let authorizeUrl = ''
  if (portUsable) {
    try {
      authorizeUrl = buildRaccoonAuthorizeUrl({
        port: assignedPort,
        state,
        appname: options.appname,
        base: options.base,
      })
    } catch {
      // 防御性分支（理论上不可达）：`portUsable` 已经把端口夹在 1024..65535 内，
      // 而官方页面那两条判据（回环 URL 正则 + `1024..65535` 端口范围）在这个区间上
      // 恒真。⚠️ 别把这两条判据读成「一条更窄所以另一条冗余」——回环正则允许
      // `1000..1023` 那类四位端口，是**端口范围判据**把它收窄的，官方 bundle 里
      // 同样两条并存。
      finish({ ok: false, reason: 'failed' })
    }
  }
  return {
    state,
    port: assignedPort,
    redirect,
    authorizeUrl,
    result,
    cancel: () => finish({ ok: false, reason: 'closed' }),
  }
}

/**
 * 用系统默认浏览器打开 URL；**永不抛出**。
 *
 * ⚠️⚠️ **绝不能用 `cmd /c start`** —— 它把 URL 里每个 `&` 当命令分隔符，
 * 于是 `?...&...` 会被**截断**在第一个 `&` 上（症状极具误导性：授权页显示
 * 「链接无效」、参数全丢）。`rundll32` **不经过 shell**，参数原样传递
 * （与 `accio-oauth.ts` 的 `openBrowser` 同一处方）。
 *
 * ⚠️ 永不抛出的兑现方式是那个**空回调**：Node 只在 `execFile` **带回调**时
 * 才代为挂上 `'error'` 监听器 ⇒ 那个 `() => {}` 不是装饰，删掉它，
 * `ENOENT` 会变成**未捕获异常**并打挂宿主进程。
 */
export function openRaccoonAuthorizePage(url: string): void {
  try {
    if (process.platform === 'win32') {
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], () => {})
      return
    }
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(cmd, [url], () => {})
  } catch {
    // 打开失败不影响流程：调用方会把 URL 显示给用户手动打开。
  }
}

/** 换码的结果。 */
export interface RaccoonAuthorizeExchange {
  /** 是否换到了可用的一对凭据。 */
  ok: boolean
  /** 拒绝的原因词（**没有**报文原文：报文可能回显那枚 code）。 */
  reason?: 'code_not_found' | 'session_dead' | 'server_error' | 'network' | 'invalid_response' | 'refresh_missing' | 'token_invalid'
  /** 换到的凭据（仅 `ok` 时存在）。 */
  credential?: RaccoonCredential
}

/**
 * 用一次性授权码换凭据。
 *
 * 请求形状与官方**逐字节相同**：`POST {authApi}/login_with_authorization_code`，
 * 只带一个 `Content-Type` 头，body 是 `{ authorization_code }`。
 * 网关的 web-auth 这一族用的是**数字** `code === 0` 信封。
 *
 * ## 成功门（官方的那道门，逐字重述）
 *
 * 必须有 `access_token`，**并且**满足**二者之一**：
 *
 * - 一枚**有效**的 IAM 令牌（官方规则：同一 issuer + 非空 `sub` + 未来的
 *   `exp`）—— 这一半**不要求**带 refresh；
 * - 或一枚 refresh token（legacy 那一对）。
 *
 * 差一点就是**拒绝 + 具名原因**，**绝不**产出半截凭据（存下半个凭据 = 存下
 * 一个轮换之后什么都不剩的东西）。
 *
 * ⚠️ 上面第一半（IAM 令牌）**不要求** refresh ⇒ 那种凭据落库后
 * `isRaccoonRefreshable()`（`src/raccoon.ts`）为 **false**，账号**不可静默续期**：
 * 续期调度器跳过它（`src/raccoon-auth.ts` 的 `if (!entry.refreshable) continue`），
 * 而推理侧遇到 401/403 时 `refresh()` 会**在发任何网络请求之前**抛
 * `RefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')`。
 * 这是**有意的**（官方规则如此，且行为诚实、不白烧凭据），但后果用户可见：
 * **到期后必须重新登录**。
 *
 * @param code - 一次性授权码（最多换一次；上游会对重放回 400）。
 * @param options
 * @param options.product - 产品配置（默认 {@link RACCOON}）。
 * @param options.fetcher - 注入的 fetch（测试用）。
 * @param options.authApiBase - 换码端点前缀（默认取 `product`）。
 * @param options.iamIssuer - IAM 令牌必须带的 `iss`（默认 {@link RACCOON_IAM_ISSUER}）。
 * @param options.signal - 调用方自带的取消信号（缺省时用请求超时）。
 * @returns 换码结果。
 */
export async function exchangeRaccoonAuthorizationCode(
  code: unknown,
  options: {
    product?: RaccoonProduct
    fetcher?: typeof fetch
    authApiBase?: unknown
    iamIssuer?: unknown
    /** 调用方自带的取消信号（缺省时挂 {@link RACCOON_REQUEST_TIMEOUT_MS} 的截止时间）。 */
    signal?: AbortSignal
  } = {},
): Promise<RaccoonAuthorizeExchange> {
  const token = readString(code, '').trim()
  if (token === '') return { ok: false, reason: 'invalid_response' }
  const product = options.product ?? RACCOON
  const authApiBase = readString(options.authApiBase, '') !== ''
    ? readString(options.authApiBase, '')
    : `${product.apiBase}${product.authApiPrefix}`
  const iamIssuer = readString(options.iamIssuer, '') !== ''
    ? readString(options.iamIssuer, '')
    : RACCOON_IAM_ISSUER
  const effective = options.fetcher ?? globalThis.fetch
  let response: Response
  try {
    response = await effective(`${authApiBase}/login_with_authorization_code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorization_code: token }),
      // ⚠️ **无条件**挂截止时间，不要按「fetcher 是不是注入的」分支：生产的调用点
      //   恒传 fetcher（`runAuthorizeRound(state, product, deps.fetcher, …)`，而
      //   `deps.fetcher = options.fetcher ?? fetch`）⇒ 拿 `options.fetcher === undefined`
      //   当判据会让**生产路径永远没有 signal**，上游把连接挂住时只能白等接收端的
      //   5 分钟超时（实测：注入 fetcher 时 `signalPresent === false`）。
      //   自己管 abort 的调用方用 `options.signal` 覆盖。
      signal: options.signal ?? AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, reason: 'invalid_response' }
  }
  const envelope = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const envelopeCode = typeof envelope.code === 'number' ? envelope.code : (response.status >= 400 ? response.status : 0)
  if (response.status === 401) return { ok: false, reason: 'session_dead' }
  if (envelopeCode === RACCOON_AUTHORIZATION_CODE_NOT_FOUND) {
    return { ok: false, reason: 'code_not_found' }
  }
  if (!response.ok || envelopeCode !== 0) return { ok: false, reason: 'server_error' }
  const data = envelope.data !== null && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : {}
  // ⚠️ 判据用 `trim()` 后的值：「恰好是几个空格」不是一枚令牌，但它**穿过**了
  //   `readString`（只判 typeof）与原来的 `=== ''`（精确空串）两道判据 ⇒ 一个只有
  //   空白的 `access_token` 会产出「成功」凭据。对令牌而言空白 = 缺失。
  const accessToken = readString(data.access_token, '')
  if (accessToken.trim() === '') return { ok: false, reason: 'invalid_response' }
  const iam = isRaccoonIamToken(accessToken)
  if (iam && !raccoonIamTokenIsValid(accessToken, iamIssuer)) {
    return { ok: false, reason: 'token_invalid' }
  }
  const refreshToken = readString(data.refresh_token, '')
  if (!iam && refreshToken.trim() === '') {
    // legacy 那一半**必须**带 refresh（官方规则）：否则这枚令牌续不了期，
    // 落地就是一个「过期即死」的账号。⚠️ 用 `trim()`：一枚只有空白的 refresh
    // 同样续不了期（`isRaccoonRefreshable()` 判的虽是非空，但空白串进上游一样失败）。
    return { ok: false, reason: 'refresh_missing' }
  }
  const expMs = decodeJwtExpMs(accessToken)
  const officeIdentity = readString(data.office_identity, '')
  return {
    ok: true,
    credential: {
      access_token: accessToken,
      refresh_token: refreshToken,
      ...expMs !== undefined ? { expires_at: String(expMs) } : {},
      ...officeIdentity.length > 0 ? { office_identity: officeIdentity } : {},
    },
  }
}
