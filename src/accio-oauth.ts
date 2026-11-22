/**
 * Accio 的 OAuth 2.0 + PKCE 登录与续期。
 *
 * ## 为什么能脱离 IDE（与参考实现的关键差异）
 *
 * 参考实现 `dsh-connect-accio` 读本机 `credentials.enc`（DPAPI）+ 用
 * Accio 自带的 `security_guard.node` 签名 ⇒ 仅 Windows、依赖安装目录。
 * 但逐字逆向 `out/main/index.js` 的 `startLoginWithCallbackMode` 表明：
 * Accio 走的是**标准 PKCE**，`client_id = 'accio-work'`（**公开客户端、无 secret**），
 * 且回调落在**本地 loopback**、代码里对 `return_url` **无白名单校验**。
 * ⇒ 我们可以用**自己的** loopback 完成授权，完全不需要 IDE。
 *
 * ## ⚠️⚠️ 打开浏览器：绝不能用 `cmd /c start`
 *
 * `cmd.exe` 把 URL 里的 **`&` 当命令分隔符**，URL 会在第一个 `&` 处**被截断**：
 *
 * ```
 * https://www.accio-ai.com/login?return_url=…%26launcher_timestamp%3D<ts>
 *                                                              ↑ 到此为止
 * 丢失：&state=…&code_challenge=…&code_challenge_method=S256&client_id=accio-work
 * ```
 *
 * 后果**极具误导性**（三个现象全由这一个 bug 解释，排查代价极高）：
 * - 弹「**请升级客户端**」modal —— `code_challenge` 丢失后恰好命中登录页的
 *   legacy 客户端门禁（判据是 `本地 return_url && !code_challenge`）；
 * - 弹出一个**文件管理器**窗口 —— 残余片段被 explorer 当**路径**打开；
 * - 回调**永不到达** —— `state` / `code_challenge` 都没了。
 *
 * ⇒ 必须用 `rundll32 url.dll,FileProtocolHandler`（不经过任何 shell，
 * 参数原样交给系统 URL 处理器）。本文件有一条源码级回归锁守着这条。
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  ACCIO,
  ACCIO_REQUEST_TIMEOUT_MS,
  ACCIO_TOKEN_EXCHANGE_PATH,
  ACCIO_REFRESH_PATH,
  type AccioRegion,
} from './accio-product.js'
import { accioExpiresAtMs, type AccioCredential } from './accio.js'
import { autoOpenBrowserEnabled } from './login-preferences.js'

/** PKCE 对。 */
export interface AccioPkcePair {
  verifier: string
  challenge: string
}

/**
 * 生成 PKCE 对。
 *
 * ⚠️ `code_verifier` 是 **48 随机字节**的 base64url（官方客户端 `new Uint8Array(48)`），
 * `challenge` 是 `base64url(SHA-256(verifier))`，方法恒 **S256**。
 */
export function createAccioPkcePair(): AccioPkcePair {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 生成 `state`（32 随机字节 hex，与官方一致）。 */
export function createAccioState(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 拼授权 URL。
 *
 * ⚠️ **参数缺一不可**：少了 `code_challenge` 会被登录页判为 legacy 客户端
 * 而弹「请升级客户端」（见文件头）。`ttid` / `language` 是 IDE 同款参数集。
 */
export function buildAccioAuthUrl(options: {
  region: AccioRegion
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const params = new URLSearchParams({
    return_url: options.redirectUri,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    client_id: ACCIO.clientId,
    ttid: `ttid_${randomBytes(16).toString('hex')}`,
    language: 'zh',
  })
  return `${ACCIO.loginBaseUrlOf(options.region)}/login?${params.toString()}`
}

/**
 * 用系统默认浏览器打开 URL。
 *
 * ⚠️⚠️ **绝不能用 `cmd /c start`**（`&` 会被当命令分隔符截断 URL）——
 * 见文件头的完整事故说明。`rundll32` 不经过 shell，参数原样传递。
 *
 * ⚠️ 永不抛出：`execFile` 的失败是**异步 `'error'` 事件**，
 * 而**第三个参数的回调就是它的消费者** —— 传了回调，Node 会代为挂上 `'error'`
 * 监听器（实测 `listenerCount('error') === 1`，ENOENT 落进回调、进程存活）。
 * ⇒ **那个 `() => {}` 不是装饰，删掉它就会变成未捕获异常并打挂宿主**。
 * 打开失败不影响流程：调用方会把 URL 显示给用户手动打开。
 */
export function openBrowser(url: string): void {
  // ★ 与 `login.ts` 的 `openBrowser` 同一条闸门（2026-11-23，默认开）：
  //   关闭「新建账号时自动打开浏览器授权页」后不 spawn，只把地址写进日志。
  if (!autoOpenBrowserEnabled()) {
    console.info('[jet-hub] 已关闭「自动打开浏览器」，请手动打开 Accio 登录地址:', url)
    return
  }
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

/** 兑换 / 续期的归一化结果（`expires_at` **已 ×1000**）。 */
export interface AccioTokenResult {
  access_token: string
  refresh_token: string
  expires_at: number
  sgcookie?: string
}

/** 解析 `{success, code, message, data}` 信封；失败抛出**带服务端原文**的错误。 */
function unwrapTokenEnvelope(path: string, status: number, text: string): Record<string, unknown> {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`accio: ${path} 返回非 JSON（HTTP ${status}）：${text.slice(0, 200)}`)
  }
  const env = body as Record<string, unknown>
  if (env?.success !== true) {
    const code = env?.code ?? status
    const message = env?.message ?? ''
    throw new Error(`accio: ${path} 失败（${String(code)} ${String(message)}）`.trim())
  }
  const data = env?.data
  if (data === null || typeof data !== 'object') {
    throw new Error(`accio: ${path} 响应缺 data 对象`)
  }
  return data as Record<string, unknown>
}

/** 把 data 归一化为 `AccioTokenResult`（**含秒→毫秒**）。 */
function toTokenResult(path: string, data: Record<string, unknown>): AccioTokenResult {
  const access = data.accessToken
  const refresh = data.refreshToken
  const expiresAt = accioExpiresAtMs(data.expiresAt)
  // ⚠️ 三者缺一不可（官方客户端也是这么校验的：`if(!t?.accessToken||!t?.refreshToken||typeof t?.expiresAt!=='number')`）
  if (typeof access !== 'string' || access === '') throw new Error(`accio: ${path} 响应缺 accessToken`)
  if (typeof refresh !== 'string' || refresh === '') throw new Error(`accio: ${path} 响应缺 refreshToken`)
  if (expiresAt === undefined) throw new Error(`accio: ${path} 响应缺 expiresAt（或非正数）`)
  const out: AccioTokenResult = { access_token: access, refresh_token: refresh, expires_at: expiresAt }
  if (typeof data.sgcookie === 'string' && data.sgcookie !== '') out.sgcookie = data.sgcookie
  return out
}

/**
 * 用授权码兑换 token。
 *
 * ⚠️ `clientId` 必须是**公开客户端** `accio-work`；**没有** `client_secret`。
 *
 * ⚠️ `region` **刻意不参与**本函数的 URL 构造：gateway 两个区域**同一个**
 * （见 `ACCIO.gatewayBaseUrl`），只有**登录页**分区域。它保留在签名里是为了
 * 让调用方的语义完整，**不要**据此改 URL。
 */
export async function exchangeAccioCode(options: {
  region: AccioRegion
  code: string
  codeVerifier: string
  redirectUri: string
  fetcher?: typeof fetch
}): Promise<AccioTokenResult> {
  const fetcher = options.fetcher ?? fetch
  const path = ACCIO_TOKEN_EXCHANGE_PATH
  const res = await fetcher(`${ACCIO.gatewayBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code: options.code,
      codeVerifier: options.codeVerifier,
      clientId: ACCIO.clientId,
      redirectUri: options.redirectUri,
    }),
    signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  return toTokenResult(path, unwrapTokenEnvelope(path, res.status, text))
}

/**
 * 续期。
 *
 * ⚠️⚠️ **参考实现明确记录「刷新会轮换 refresh_token」**（本仓库尚未实测该端点，
 * 见 `docs/agent-notes/providers-accio.md` §10 U-A）。
 * ⇒ 三条入口（定时器 / 推理按需 / 面板按钮）**必须串行**，
 * 否则必然「1 成功、其余 `invalid_grant`」，而失败方会把**好账号标死**。
 * 串行由 `accio-auth.ts` 的 `SerialQueue` 保证，**不在这里**。
 */
export async function refreshAccioCredential(options: {
  credential: AccioCredential
  fetcher?: typeof fetch
}): Promise<AccioTokenResult> {
  const fetcher = options.fetcher ?? fetch
  const path = ACCIO_REFRESH_PATH
  const res = await fetcher(`${ACCIO.gatewayBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      accessToken: options.credential.access_token,
      refreshToken: options.credential.refresh_token,
    }),
    signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  return toTokenResult(path, unwrapTokenEnvelope(path, res.status, text))
}
