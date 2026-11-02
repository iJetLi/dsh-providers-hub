/**
 * AutoClaw 凭据获取、本地探测、短信验证码快速登录与 Token 刷新。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import {
  AUTOCLAW,
  AUTOCLAW_INTL,
  AUTOCLAW_SOURCE_ID,
  AUTOCLAW_CLIENT_VERSION,
  type AutoclawProduct,
} from './autoclaw-product.js'
import {
  AUTOCLAW_REFRESH_PATH,
  AUTOCLAW_REFRESH_FALLBACK_PATH,
  AUTOCLAW_MODEL_CONFIG_PATH,
  AUTOCLAW_REQUEST_TIMEOUT_MS,
  calculateAutoclawSign,
  cleanBearerToken,
  readUserIdFromJwt,
  autoclawExpiresAtMs,
  autoclawAccessTokenExpiresAtMs,
  type AutoclawCredential,
} from './autoclaw.js'
import { isDefinitiveRefreshRejection, refreshFailureFromResponse } from './refresh-failure.js'

export const AUTOCLAW_SEND_CODE_PATH = '/userapi/v1/agent-send-code'
export const AUTOCLAW_LOGIN_PATH = '/userapi/v1/agent-login'

// ── Z.ai OAuth（**仅国际版**，2026-10-20 逆向+实测） ─────────────────────
//
// 国际版客户端界面只给「使用 Z.ai 继续」/ Google，但**后端照样接受短信登录**
// （实测 `/userapi/v1/agent-send-code` 在国际基址返回 `code=0 SUCCESS`）。
// 问题在于**国际版账号是邮箱+OAuth 创建的、没绑手机号**
// （`account-profile.json`: `phone: null`），且**没有绑手机端点**
// （`agent-bind-phone` / `bind-phone` 等全 404）⇒ 短信这条路对国际账号不可用。
//
// ⇒ 国际版必须走 Z.ai OAuth。三个事实（全部实测/逆向）：
//
// | 项 | 值 | 来源 |
// |---|---|---|
// | 授权页 | `https://chat.z.ai/auth` | 客户端 `ZAI_OAUTH_HOST_BY_ENVIRONMENT.overseas_release` |
// | `client_id` | `client_EnD0QI8bLRFT8cciLp389Q` | 两次授权 URL 逐字节相同 ⇒ 固定值 |
// | 换 token | `POST /userapi/overseasv1/zai-oauth-login` | 客户端 `exchangeOAuth` |
// | `state.dh` | `SHA256(deviceId)` | **已破解**（实测命中） |
// | `state.nh` | 未知（64 hex，非 deviceId/硬件标识的简单哈希） | **未解** |
//
// ## ⚠️ 关于 `state.nh`：为什么可以先用「不生成 state」的方案
//
// 用**瞎编的** `state`（`aosi.fake-state-probe`）打 `zai-oauth-login`，服务端回
// **`631001 User login error`** —— 这是「进入登录逻辑后 code 无效」，
// **不是**「state 无效」。⇒ 服务端不硬校验 `state` 的内容。
//
// ## ⚠️⚠️ 「`state` 交给授权页生成」这条路线**已被真机推翻**（2026-11-02，用户报障）
//
// 当时的推理是：`state` 留空、由官方授权页填、回调时透传 ⇒ 不必逆向 `nh`。
// 真机结果是**整条流程走不下去**：用户从登录页点「使用 Z.ai 账号继续」，
// 浏览器登录 Z.ai 成功后**停在 `chat.z.ai` 首页**，我们本地的
// `/auth/callback-zai` 一个请求都没收到（面板一直等，最后超时）。
//
// 服务端探针给出决定性证据（全部**匿名** GET，无凭据）：
//
// | 请求 | 响应 |
// |---|---|
// | `GET /api/oauth/authorize?client_id=…&response_type=code&redirect_uri=…`（**无 state**） | **422 Unprocessable Entity** |
// | 同上 **+ `state=aosi.probe-…`** | **307** → `/auth?response_type=code&client_id=…&redirect_uri=…&state=aosi.probe-…` |
// | `GET /api/oauth/authorize?client_id=…（错的值）&state=…` | 307（**不校验 client_id**） |
// | 同上但 `redirect_uri` 换成 `https://evil.example.com/cb` | 307（**不校验 redirect_uri**） |
//
// ⇒ **`state` 是服务端必需参数**（缺了直接 422）。而 `/auth` 只是它的
// **前端登录页路由**，不是授权端点 —— 直接打开 `/auth` 时页面只拿
// `redirect_uri` 判断「我在 OAuth 流程里」（客户端 bundle 的
// `Hht = () => !!t.get("redirect_uri") || gJ() || !!t.get("sso_redirect")`），
// 真正的回跳目标走的是 `redirect` 参数 / sessionStorage，**不是**顶层 `redirect_uri`
// ⇒ 登录完没有可回的目标，落回首页。
//
// ⇒ 正确形态是走 **`/api/oauth/authorize`** 并**自己生成 `state`**：
//   未登录 ⇒ 它 307 到 `/auth?…&state=…`（把它原样带到登录页）；
//   登录后 ⇒ 它 302 回 `redirect_uri?code=…&state=…`。
//
// `aosi.` 前缀 + 任意内容是可行的：`nh` 仍未知，但服务端**不硬校验 `state` 内容**
// （实测把瞎编的 `aosi.fake-state-probe` 打到 `zai-oauth-login`，回的是
// `631001 User login error` = **进了登录逻辑、code 无效**，而不是「state 无效」）。

/** Z.ai **授权端点**（国际版）。⚠️ 不是 `https://chat.z.ai/auth` —— 那是登录页前端路由，见上方实测。 */
export const AUTOCLAW_ZAI_AUTH_URL = 'https://chat.z.ai/api/oauth/authorize'
/**
 * Z.ai OAuth 的 `client_id` —— **只用于降级路径**，正常路径由服务端下发。
 *
 * ## ⚠️⚠️ 只用这个值自己拼**不成立**（2026-11-02 第三轮真机证伪）
 *
 * 它来自一次真实授权 URL（两次采样逐字节相同）。但真机复现时，用同一个 `client_id`
 * + 已注册端口 + 自造 `state` 打 `/api/oauth/authorize`，服务端回
 * `{"detail":"Redirect URI not registered for this client"}` —— 端口与路径都已经被
 * 上一轮修对了，仍被拒。
 *
 * 客户端实现里**没有**这个常量：它走 `POST /userapi/overseasv1/zai-oauth-url`
 * 拿 `{oauth_url, state}`。⇒ 真正成立的是「服务端按 `navigate_uri` 现注册一组」，
 * 而不是「某个固定的 (client_id, redirect_uri) 组合」。
 *
 * ⇒ 生产路径见 `fetchAutoclawZaiAuthUrl`；这里保留常量只为「服务端不可达时仍能渲染出
 * 可点的链接」这一降级分支，且页面会显式告知用户可能失败。
 */
export const AUTOCLAW_ZAI_CLIENT_ID = 'client_EnD0QI8bLRFT8cciLp389Q'
/** OAuth 换 token 端点（`overseasv1` 命名空间，仅国际站有）。 */
export const AUTOCLAW_ZAI_EXCHANGE_PATH = '/userapi/overseasv1/zai-oauth-login'
/** Google OAuth 换 token 端点（对照用）。 */
export const AUTOCLAW_GOOGLE_EXCHANGE_PATH = '/userapi/overseasv1/google-oauth-login'

/** OAuth 回调路径（与客户端同款：`/auth/callback-zai`）。 */
export const AUTOCLAW_OAUTH_CALLBACK_PATH = '/auth/callback-zai'
/** OAuth 回调端口候选（与客户端 `OAUTH_CALLBACK_PORTS` 逐字相同）。 */
export const AUTOCLAW_OAUTH_CALLBACK_PORTS: readonly number[] = [18432, 19654, 19723, 53699]

/**
 * 生成 Z.ai OAuth 的 `state`。
 *
 * 形态对齐官方：`aosi.<base64url(JSON)>`。官方那个 JWT 里 `dh = SHA256(deviceId)`
 * **已破解**、`nh` **未解**，但服务端不硬校验内容（见上方实测表）⇒ 我们只放
 * 一个能自证「这是本轮流程」的随机串，不做任何防伪。
 *
 * ⚠️ **它必须非空**：`/api/oauth/authorize` 缺 `state` 直接回 **422**（实测），
 * 这正是 2026-11-02 那次「点完按钮、登录成功、回调永不发生」的根因。
 */
export function autoclawZaiState(now: number = Date.now()): string {
  const payload = JSON.stringify({ n: Math.random().toString(36).slice(2), t: now })
  return `aosi.${Buffer.from(payload, 'utf8').toString('base64url')}`
}

/**
 * 按顺序尝试监听**注册过的回调端口**（{@link AUTOCLAW_OAUTH_CALLBACK_PORTS}）。
 *
 * ## ⚠️⚠️ 为什么不能 `listen(0)` 随机端口（2026-11-02 真机，第二处报障）
 *
 * Z.ai 的 `/api/oauth/authorize` 对**已登录**用户会校验 `redirect_uri` 白名单，
 * 未注册的端口直接回一段 JSON：
 *
 * ```
 * {"detail":"Redirect URI not registered for this client"}
 * ```
 *
 * 实测端点是随机端口 `60768`。而 `AUTOCLAW_OAUTH_CALLBACK_PORTS` 正是官方客户端
 * 注册的那几个 —— 它在本次接线之前是**零消费**常量（审查员登记过「与 `listen(0)`
 * 冲突，若服务端做端口白名单会直接死在授权页」，现在被真机证实）。
 *
 * ⚠️ 未登录时**看不出**这个问题：那时 `/api/oauth/authorize` 一律 307 到登录页，
 * 不做白名单校验 ⇒ 「curl 探针 307」**不能**当成「端口没问题」的证据。
 *
 * ## 回退策略
 *
 * 4 个端口全被占用 ⇒ 回退 `listen(0)`。此时 OAuth 一定登不上（未注册），但本地页
 * 仍能打开 —— 用户至少能看到授权页并拿到一条可诊断的失败，而不是「窗口都起不来」。
 * 回调里对这种情况已经会返回「授权失败」的可见文案。
 *
 * @param server - 只需 `listen` / `once` / `removeListener`（单测因此可以注入替身）。
 * @param candidates - 候选端口，按顺序尝试。
 */
export async function listenOnCallbackPorts(
  server: AutoclawCallbackListenable,
  candidates: readonly number[] = AUTOCLAW_OAUTH_CALLBACK_PORTS,
): Promise<void> {
  for (const candidate of candidates) {
    const ok = await tryListen(server, candidate)
    if (ok) return
  }
  await tryListen(server, 0)
}

/** `listenOnCallbackPorts` 需要的最小 server 面（结构类型，便于单测注入替身）。 */
export interface AutoclawCallbackListenable {
  listen: (port: number, host: string) => unknown
  once: (event: 'listening' | 'error', listener: () => void) => unknown
  removeListener: (event: 'listening' | 'error', listener: () => void) => unknown
}

/** 尝试监听一个端口；`EADDRINUSE` 等错误返回 `false`（不抛）。 */
function tryListen(server: AutoclawCallbackListenable, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const onError = (): void => {
      server.removeListener('listening', onListening)
      resolve(false)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve(true)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/**
 * 构造 Z.ai 授权 URL。
 *
 * @param redirectUri - 回调地址（`http://127.0.0.1:<port>/auth/callback-zai`）。
 * @param state - **必填**（见 {@link autoclawZaiState}）。回调时原样带回，用于认领本轮流程。
 */
export function buildAutoclawZaiAuthUrl(redirectUri: string, state: string): string {
  const url = new URL(AUTOCLAW_ZAI_AUTH_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', AUTOCLAW_ZAI_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  return url.toString()
}

/**
 * 由**服务端签发**授权 URL 的端点（`overseasv1`，仅国际站）。
 *
 * ## 为什么必须走它，而不是自己拼（2026-11-02 第三轮真机报障）
 *
 * 自己拼的 URL 在真机上被 Z.ai 拒绝：
 * `{"detail":"Redirect URI not registered for this client"}`。
 * 客户端实现（`dist/main.cjs`）里根本没有 `client_id` 常量 —— 它的顺序是：
 *
 * ```js
 * // 1) 起 loopback，拿到 navigate_uri
 * // 2) 向服务端要授权地址
 * const t = await this.post('/userapi/overseasv1/zai-oauth-url', { navigate_uri });
 * const oauthUrl = a.data.oauth_url, state = a.data.state;   // ← 服务端签发
 * // 3) 打开 oauthUrl；回调拿 code+state；4) POST zai-oauth-login
 * ```
 *
 * ⇒ **`(client_id, redirect_uri, state)` 是服务端按 `navigate_uri` 现注册的一组**。
 * 我们照抄过一次真实 URL 里的 `client_id`，但那一组的 `state` 已随上一轮流程失效
 * ⇒ 服务端找不到「这个 redirect_uri 属于哪个 state」，于是报成「redirect_uri 未注册」。
 * 这个报错文案极具误导性 —— 它让人以为是端口/路径问题（实际都改对了）。
 *
 * @param navigateUri - 回调地址，必须与 `zai-oauth-login` 的 `navigate_uri` 逐字节相同。
 */
export const AUTOCLAW_ZAI_AUTH_URL_PATH = '/userapi/overseasv1/zai-oauth-url'

/** HTML 转义（登录页与回调页共用同一份，避免两份实现在特殊字符上分叉）。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** 服务端签发的授权参数。 */
export interface AutoclawZaiAuthorization {
  /** 直接可以打开的授权页地址（已含 `client_id` / `redirect_uri` / `state`）。 */
  authUrl: string
  /** 服务端签发的 `state`，回调时原样带回，比对用。 */
  state: string
}

/**
 * 向服务端申请一次授权：返回**授权页地址**与配套的 `state`。
 *
 * 失败时**不抛**（返回 `{ ok: false, error }`）—— 调用方（登录页）要把原因显示出来。
 */
export async function fetchAutoclawZaiAuthUrl(
  navigateUri: string,
  options?: LoginAutoclawWithCodeOptions,
): Promise<{ ok: true; value: AutoclawZaiAuthorization } | { ok: false; error: string }> {
  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetchImpl ?? fetch
  const deviceId = resolveDeviceId(product, options?.deviceId)
  const ts = Math.floor(Date.now() / 1000).toString()
  const sign = calculateAutoclawSign(product.appId, ts, product.appKey)

  try {
    const resp = await fetcher(`${product.apiBase}${AUTOCLAW_ZAI_AUTH_URL_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 与 `exchangeAutoclawZaiCode` 完全同一组管理头（缺一个都进不了登录逻辑）。
        'X-Version': AUTOCLAW_CLIENT_VERSION,
        'X-Tm': 'win',
        'X-Product': product.product,
        'X-Auth-Appid': product.appId,
        'X-Auth-TimeStamp': ts,
        'X-Auth-Sign': sign,
        'X-Lang': 'en-US',
        'X-Channel': 'official',
        'User-Agent': `AutoClaw/${AUTOCLAW_CLIENT_VERSION} (win)`,
      },
      body: JSON.stringify({
        navigate_uri: navigateUri,
        source_id: AUTOCLAW_SOURCE_ID,
        device_id: deviceId,
      }),
      signal: AbortSignal.timeout(AUTOCLAW_REQUEST_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return { ok: false, error: `申请授权地址失败(${resp.status})：${text.slice(0, 200)}` }
    }

    const json = (await resp.json()) as {
      code?: number
      msg?: string
      data?: { oauth_url?: string; state?: string }
    }
    const authUrl = typeof json.data?.oauth_url === 'string' ? json.data.oauth_url.trim() : ''
    const state = typeof json.data?.state === 'string' ? json.data.state.trim() : ''
    if (json.code !== 0 || authUrl === '' || state === '') {
      // ⚠️ 服务端回 `code !== 0` 时 `msg` 才是用户能看懂的那句，别吞。
      const detail = json.msg !== undefined && json.msg !== '' ? `：${json.msg}` : ''
      return { ok: false, error: `服务端未返回授权地址（code=${json.code}）${detail}` }
    }
    return { ok: true, value: { authUrl, state } }
  } catch (err) {
    return { ok: false, error: `申请授权地址失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * 用授权码换 token（国际版 Z.ai OAuth）。
 *
 * ## 与国内版 HTTP 请求的差别：**必须带完整 managed 头**
 *
 * 客户端 `createZworkManagedRequestHeaders` 里除了签名头还有三个：
 * `X-Version`（客户端版本）/ `X-Tm`（平台 `win`）/ `X-Product`（`autoclaw`）。
 *
 * ⚠️ **实测对照（2026-10-20）**：缺这三个头时服务端回
 * `410000 用户未登录`（看起来像「没登录」但其实**压根没进登录逻辑**）；
 * 补齐后回 `631001 User login error`（= 进了逻辑、code 无效）。
 * ⇒ 三个头是**必需**的，缺了会被误诊成「凭据问题」。
 *
 * @param code - 授权码（回调 URL 的 `code`）。
 * @param state - 授权页原样带回的 `state`（透传，不解析）。
 * @param navigateUri - 与授权时**完全相同**的回调地址。
 */
export async function exchangeAutoclawZaiCode(
  code: string,
  state: string,
  navigateUri: string,
  options?: LoginAutoclawWithCodeOptions,
): Promise<LoginAutoclawWithCodeResult> {
  const trimmedCode = code.trim()
  if (trimmedCode === '') return { ok: false, error: '授权码不能为空' }

  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetchImpl ?? fetch
  const deviceId = resolveDeviceId(product, options?.deviceId)
  const ts = Math.floor(Date.now() / 1000).toString()
  const sign = calculateAutoclawSign(product.appId, ts, product.appKey)

  try {
    const resp = await fetcher(`${product.apiBase}${AUTOCLAW_ZAI_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ⚠️ 这三个头缺一不可（见上面实测对照）。
        'X-Version': AUTOCLAW_CLIENT_VERSION,
        'X-Tm': 'win',
        'X-Product': product.product,
        'X-Auth-Appid': product.appId,
        'X-Auth-TimeStamp': ts,
        'X-Auth-Sign': sign,
        'X-Lang': 'en-US',
        'X-Channel': 'official',
        'User-Agent': `AutoClaw/${AUTOCLAW_CLIENT_VERSION} (win)`,
      },
      body: JSON.stringify({
        code: trimmedCode,
        // ⚠️ `state` 原样透传（不解析、不重建）—— 见文件头「关于 state.nh」。
        state,
        navigate_uri: navigateUri,
        source_id: AUTOCLAW_SOURCE_ID,
        device_id: deviceId,
      }),
      signal: AbortSignal.timeout(AUTOCLAW_REQUEST_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return { ok: false, error: `Z.ai 授权失败(${resp.status}): ${text}` }
    }

    const json = (await resp.json()) as {
      code?: number
      msg?: string
      data?: {
        access_token?: string
        refresh_token?: string
        expires_in?: number
        expires_at?: number
        user_id?: string | number
        guid?: string
      }
    }

    const data = json.data ?? {}
    const rawAccess = data.access_token
    if (json.code !== 0 || rawAccess === undefined || rawAccess === '') {
      return {
        ok: false,
        error: json.msg !== undefined && json.msg !== ''
          ? `Z.ai 授权失败：${json.msg}（code=${json.code}）`
          : `Z.ai 授权失败（code=${json.code}）`,
      }
    }

    const cleanAccess = cleanBearerToken(rawAccess)
    const cleanRefresh = data.refresh_token === undefined ? '' : cleanBearerToken(data.refresh_token)
    /**
     * ⚠️⚠️ **沿用 IKOYEG 的修法：JWT 优先、声明值兜底、都读不到就 `undefined`**
     * （2026-11-02 由 doc-wiring 审查打穿 —— 本轮之前这一行还是「编造 7 天」）。
     *
     * 旧实现写的是 `Date.now() + 7 * 86400_000`，与 `src/autoclaw.ts:227-246` 记录的
     * 那次 P0 **逐字同型**：一个编造的有效期同时是「续期 lead-time」与「积分按需自愈」
     * 的唯一判据 ⇒ 过期前不自愈、过期后也不自愈、**日志零字**。
     *
     * 它此前一直**不可达**（只有零调用的 `loginWithZaiCode` 会走到），所以历次审计都没
     * 抓到；2026-11-02 把 Z.ai OAuth 接成生产路径后，这个 P0 立刻复活。
     *
     * ⚠️ 新测试的假上游固定回 `expires_in: 3600`，恰好把 7 天分支绕开 ⇒ 用例**恒绿**。
     *    「被兜底分支掩盖的缺陷」要单独一格用例（`expires_at`/`expires_in` 都不给）。
     */
    const expiresAt = autoclawAccessTokenExpiresAtMs(
      cleanAccess,
      typeof data.expires_at === 'number'
        ? autoclawExpiresAtMs(data.expires_at)
        : typeof data.expires_in === 'number'
          ? Date.now() + data.expires_in * 1000
          : undefined,
    )

    // ⚠️ 身份字段：优先服务端 `user_id`，其次 JWT 的 `user_id`（numericUserId）。
    //    与国内版同口径（见 `autoclawIdentityOf` 的注释：UUID 与 numericUserId
    //    是两个 id 空间，统一由自愈补齐，这里只保证「不会没有身份」）。
    const jwtUserId = readUserIdFromJwt(cleanAccess)
    const resolvedUserId = data.user_id ?? jwtUserId

    const credential: AutoclawCredential = {
      access_token: cleanAccess,
      refresh_token: cleanRefresh,
      expires_at: expiresAt,
      device_id: deviceId,
      account_id: resolvedUserId === undefined ? undefined : String(resolvedUserId),
      user_id: resolvedUserId,
    }
    return { ok: true, credential }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * AutoClaw 客户端版本号（`X-Version` 头用）—— **单一真相源在 `autoclaw-product.ts`**。
 *
 * ⚠️ 此处不再重复定义（2026-10-20）：`X-Version` 是国际站推理的硬校验头
 *    （缺它 → HTTP 500 空响应体），两处各写一份 `'2.1.1'` 必然漂移，
 *    统一从 `autoclaw-product.js` 导入（见 `AUTOCLAW_CLIENT_VERSION` 的注释）。
 */

/** 手机号格式正则（中国大陆11位手机号）。 */
export const PHONE_NUMBER_RE = /^1[3-9]\d{9}$/

/**
 * 从本地 Windows DPAPI 及 AES-256-GCM 探测 AutoClaw 桌面端保存的有效凭据（一键导入模式）。
 *
 * ## ⚠️⚠️ 凭据来源是**用户真实凭据**，故必须可隔离（2026-10-17 审计 P0 修复）
 *
 * 本函数会真读 `%APPDATA%\AutoClaw-official\` 并**真跑 powershell 解 DPAPI**
 * （约 1s）⇒ 单测里若不隔离，用户装了 AutoClaw 桌面端时就会读到**他的真实
 * access/refresh token**（本仓库 `.office-claw` 未隔离事故的同型，见
 * `tests/setup-isolation.ts` 的长注释）。
 *
 * ⇒ 新增 `DSH_AUTOCLAW_APPDATA` 覆盖：**优先级高于 `APPDATA`**，
 *   `tests/setup-isolation.ts` 在**进程级**把它指向临时目录
 *   （与 `DSH_OFFICEACE_HOME` / `DSH_JET_HUB_STATE_DIR` 同型）。
 * ⚠️ 为什么不用「在用例里改 `APPDATA`」：`apply()` 内部有 fire-and-forget 的
 *   后台链，用例的 `afterEach` 恢复环境变量**之后**那条链才跑到本分支 ⇒
 *   与 officeace 那次事故同型，唯一可靠做法是进程级。
 */
export async function probeAutoclawLocalCredential(options?: {
  customAppData?: string
  /**
   * **产品配置**（推荐形态）—— 目录名从 `product.userDataDirName` 取。
   *
   * ⚠️ 与下面的 `appDirName` 二选一，`product` 优先。新增调用点**必须**用它
   * （而不是自己拼目录名），否则又会出现「三个读点各写一份」的事故形态。
   */
  product?: AutoclawProduct
  /**
   * 客户端 userData 目录名（**低层逃生口**，仅测试/特殊场景用）。
   *
   * ⚠️ **国内版与国际版是同一客户端的两份构建**（`isOversea` 是构建期常量），
   * 但 userData 目录名不同 —— 实测（2026-10-20）：
   * - 国内构建：`AutoClaw-official`
   * - 国际构建：`AutoClaw-oversea-official`
   *
   * ⇒ 生产调用点一律传 `product`，别在这里写死（原实现硬编码国内目录，
   *   导致国际版**永远导入不到**自己的凭据；审计 P0 就是漏了本函数的
   *   `/autoclaw/import-local` 那个调用点）。
   *
   * @default AUTOCLAW.userDataDirName（`'AutoClaw-official'`）
   */
  appDirName?: string
}): Promise<AutoclawCredential | undefined> {
  try {
    const appData =
      options?.customAppData
      // ⚠️ 测试隔离口必须**排在 `APPDATA` 之前**，否则隔离形同虚设。
      ?? process.env.DSH_AUTOCLAW_APPDATA
      ?? process.env.APPDATA
      ?? (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : undefined)

    if (!appData) return undefined

    const appDirName = options?.product?.userDataDirName
      ?? options?.appDirName
      ?? AUTOCLAW.userDataDirName
    const localStatePath = path.join(appData, appDirName, 'Local State')
    if (!fs.existsSync(localStatePath)) return undefined

    const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8')) as {
      os_crypt?: { encrypted_key?: string }
    }
    const encKeyB64 = localState?.os_crypt?.encrypted_key
    if (!encKeyB64) return undefined

    const encKeyBuf = Buffer.from(encKeyB64, 'base64')
    if (!encKeyBuf.subarray(0, 5).equals(Buffer.from('DPAPI'))) {
      return undefined
    }

    const rawEncKey = encKeyBuf.subarray(5)
    const hex = rawEncKey.toString('hex')
    const psScript = `
      Add-Type -AssemblyName System.Security
      $hex = "${hex}"
      $bytes = for ($i=0; $i -lt $hex.Length; $i+=2) { [Convert]::ToByte($hex.Substring($i, 2), 16) }
      $unprotected = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Convert]::ToBase64String($unprotected)
    `
    const clearB64 = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim()
    const masterKey = Buffer.from(clearB64, 'base64')

    const accountsDir = path.join(appData, appDirName, 'accounts')
    if (!fs.existsSync(accountsDir)) return undefined

    const entries = fs.readdirSync(accountsDir, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const credFile = path.join(accountsDir, ent.name, 'account-credentials.enc')
      if (!fs.existsSync(credFile)) continue

      const encData = fs.readFileSync(credFile)
      if (encData.length < 31) continue // 3 prefix + 12 nonce + at least 16 tag

      const nonce = encData.subarray(3, 15)
      const ciphertextAndTag = encData.subarray(15)
      const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16)
      const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16)

      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce)
      decipher.setAuthTag(tag)
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      const parsed = JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>

      const rawAccess = (parsed.accessToken ?? parsed.access_token) as string | undefined
      const rawRefresh = (parsed.refreshToken ?? parsed.refresh_token) as string | undefined

      if (rawAccess && rawRefresh) {
        const cleanAccess = cleanBearerToken(rawAccess)
        const cleanRefresh = cleanBearerToken(rawRefresh)

        let jwtPayload: Record<string, unknown> | undefined
        try {
          const parts = cleanAccess.split('.')
          if (parts.length >= 2) {
            const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
            jwtPayload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
          }
        } catch {
          // ignore
        }

        const profilePath = path.join(accountsDir, ent.name, 'account-profile.json')
        let profilePhone: string | undefined
        let profileName: string | undefined
        if (fs.existsSync(profilePath)) {
          try {
            const prof = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as {
              profile?: { phone?: string; displayName?: string }
            }
            profilePhone = prof?.profile?.phone
            profileName = prof?.profile?.displayName
          } catch {
            // ignore
          }
        }

        const jwtPhone =
          typeof jwtPayload?.jti === 'string' && /^1[3-9]\d{9}$/.test(jwtPayload.jti.trim())
            ? jwtPayload.jti.trim()
            : undefined

        const resolvedPhone =
          profilePhone ??
          jwtPhone ??
          (typeof parsed.userPhone === 'string' ? parsed.userPhone : undefined) ??
          (typeof parsed.phone === 'string' ? parsed.phone : undefined)

        const resolvedName =
          profileName ??
          (typeof parsed.userName === 'string' ? parsed.userName : undefined)

        const resolvedUserId =
          (typeof parsed.userId === 'string' || typeof parsed.userId === 'number' ? parsed.userId : undefined) ??
          (typeof jwtPayload?.user_id === 'string' || typeof jwtPayload?.user_id === 'number' ? jwtPayload.user_id : undefined)

        const resolvedDeviceId =
          (typeof parsed.deviceId === 'string' ? parsed.deviceId : undefined) ??
          (typeof jwtPayload?.device_id === 'string' ? jwtPayload.device_id : undefined)

        // ⚠️⚠️ **JWT 的 `exp` 优先**（2026-10-19 P0）：桌面端凭据里那份
        //   `expiresAt` 是**它自己写的**，与 token 的真实死线不一定同源；
        //   而 JWT 的 `exp` 正是网关判定 `410000` 的依据。读不到才回退它。
        const resolvedExpiresAt = autoclawAccessTokenExpiresAtMs(
          cleanAccess,
          typeof parsed.expiresAt === 'number' ? autoclawExpiresAtMs(parsed.expiresAt) : undefined,
        )

        return {
          access_token: cleanAccess,
          refresh_token: cleanRefresh,
          expires_at: resolvedExpiresAt,
          user_id: resolvedUserId,
          user_name: resolvedName,
          user_phone: resolvedPhone,
          device_id: resolvedDeviceId,
        }
      }
    }

    return undefined
  } catch {
    return undefined
  }
}

/**
 * 刷新 AutoClaw Token。
 */
export async function refreshAutoclawToken(
  refreshToken: string,
  options?: {
    product?: AutoclawProduct
    fetchImpl?: typeof fetch
    deviceId?: string
    /**
     * **单次请求**超时（毫秒）；缺省 {@link AUTOCLAW_REQUEST_TIMEOUT_MS}（60s）。
     *
     * ⚠️ 存在的理由（2026-10-27 审计 P2-2）：本函数**依次试两个端点**
     * （`/userapi/v1/refresh` 与 `/agent-refresh`），各用 60s ⇒ 调用方光等刷新
     * 就可能 **120s**。签到那条腿若用它，用户点「一键领取」最坏要等
     * `2×60 + 15 = 135s`（实测真实挂钟 **120,015ms** 只差 claim 那段），
     * 而修复前上界是 15s ⇒ 9 倍。
     *
     * ⇒ 让调用方按自己的预算覆盖它（签到腿用 {@link AUTOCLAW_CLAIM_REFRESH_TIMEOUT_MS}）。
     */
    timeoutMs?: number
  },
): Promise<AutoclawCredential> {
  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetchImpl ?? fetch
  const cleanRefresh = cleanBearerToken(refreshToken)
  const deviceId = options?.deviceId ?? 'dsh-autoclaw-device-001'
  const timeoutMs = options?.timeoutMs ?? AUTOCLAW_REQUEST_TIMEOUT_MS

  const endpoints = [AUTOCLAW_REFRESH_PATH, AUTOCLAW_REFRESH_FALLBACK_PATH]
  let lastError: Error | undefined

  for (const ep of endpoints) {
    const ts = Math.floor(Date.now() / 1000).toString()
    const sign = calculateAutoclawSign(product.appId, ts, product.appKey)
    const url = `${product.apiBase}${ep}`

    try {
      const resp = await fetcher(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Appid': product.appId,
          'X-Auth-TimeStamp': ts,
          'X-Auth-Sign': sign,
        },
        body: JSON.stringify({
          refresh_token: cleanRefresh,
          source_id: AUTOCLAW_SOURCE_ID,
          device_id: deviceId,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        /**
         * ⚠️⚠️ **必须抛结构化错误**（2026-10-27 审计修）。
         *
         * 修前是裸 `new Error('... failed with status N: <body>')` —— 状态码只在
         * 文案里，而 `autoclaw-auth.ts` 的终态判据只能 `msg.includes(...)` 捞词，
         * 于是 `503` 报文里出现 `expired` / `Invalid token` / `401` 三个字符就
         * 把健康账号判死（`refreshable:false` 是**单向门**，永不自愈）。
         *
         * ⇒ 现在把 `status` 与上游 OAuth `error` 一起带出来，判据读结构化字段。
         * ⚠️ 响应体可能不是 JSON（网关 HTML 页）⇒ 解析失败时只带状态码。
         */
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
        /**
         * ⚠️⚠️ **必须按业务码信封的键读 `msg`**（2026-10-27 第二轮审计打穿）。
         *
         * 本家的「token 无效」有两种载体：OAuth 的 `{error}` 与**业务码信封**
         * 的 `{code, msg}`。修前这里用默认键 `'error'` ⇒ 遇到
         * `HTTP 400 {code:401,msg:"Invalid token"}` 时 `oauthError` 是
         * `undefined` ⇒ 终态判据拿不到结构化信息，只能退回文案启发式（而文案里
         * 那句 `msg` 还会被整段拼进 message ⇒ 既可能漏判、又丢失原文）。
         *
         * ⇒ `refreshFailureFromResponse` 现在**两把键都读**（见其 doc），
         *   这里不必再改调用点形态。
         */
        throw refreshFailureFromResponse(
          `AutoClaw token refresh failed`,
          resp.status,
          parsed,
        )
      }

      const json = (await resp.json()) as {
        code?: number
        msg?: string
        data?: {
          access_token?: string
          refresh_token?: string
          expires_in?: number
          expires_at?: number
          user_id?: string | number
        }
      }

      if (json.code !== 0 || !json.data?.access_token) {
        /**
         * ⚠️⚠️ 业务码信封（HTTP 200 + `{code, msg}`）也必须**结构化**。
         *
         * AutoClaw 用它自己的词汇表达「token 无效」—— 实测是 `msg: "Invalid token"`，
         * **不是** OAuth 的 `invalid_grant`。所以这里把 `msg` 作为 `oauthError` 带出，
         * 并由调用点（`autoclaw-auth.ts`）在
         * `isTerminalRefreshFailure(err, AUTOCLAW_TERMINAL_OAUTH_ERRORS)` 里
         * **显式声明**自己的词表 —— 而不是把宽词塞回共享模块（那样又会退化成一个
         * 大正则管所有家，正是本模块存在的理由）。
         *
         * ⚠️ 状态码用 `200`（信封在 HTTP 200 里）：`isTerminalRefreshFailure`
         * 只对 `400` / `200` 两种「确定性拒绝」判定终态，5xx 一律非终态。
         */
        throw refreshFailureFromResponse(
          'AutoClaw token refresh returned non-zero code',
          200,
          json,
          'msg',
        )
      }

      const newAccess = cleanBearerToken(json.data.access_token)
      const newRefresh = json.data.refresh_token ? cleanBearerToken(json.data.refresh_token) : cleanRefresh
      // ⚠️⚠️ **续期响应同样可能不带 `expires_at` / `expires_in`**
      //   （2026-10-19 P0）：旧写法在这种情形下产出 `undefined` ⇒
      //   `syncAccountExpiry` 保留池内旧值（可能就是那份错的），而凭据里也
      //   读不到真死线。⇒ 一律以 JWT 的 `exp` 为准，声明值只作兜底。
      const declaredExpiresAt = autoclawExpiresAtMs(json.data.expires_at ?? json.data.expires_in)
      const expiresAt = autoclawAccessTokenExpiresAtMs(newAccess, declaredExpiresAt)

      return {
        access_token: newAccess,
        refresh_token: newRefresh,
        expires_at: expiresAt,
        /**
         * ⚠️⚠️ **`user_id` 必须带 JWT 兜底**（2026-10-20 审计 P1，实测真缺陷）。
         *
         * 上游 `/userapi/v1/refresh` **不下发 `user_id`**（登录端点都不下发，
         * 见下面 `loginAutoclawWithCode` 的同一处兜底）。原先这里写
         * `user_id: json.data.user_id` ⇒ 恒 `undefined` ⇒ `JSON.stringify`
         * 把该键**整键丢弃** ⇒ 一次自动续期就把「已补齐的 UUID」抹掉 ⇒
         * 下一轮 `dedupeByCredentialField` 因身份字段缺失而跳过该条
         * ⇒ **自愈能力随续期逐条退化**，且日志零字。
         *
         * 兜底顺序与登录路径**同源**：声明值优先，取不到就从新 JWT 的
         * `user_id` 读（`readUserIdFromJwt` 是唯一实现，不写第二份解析）。
         *
         * ⚠️ 注意兜底拿到的是 **numericUserId**（数字 id），不是 UUID ——
         *    那是**比没有好**的退化（`autoclawIdentityOf` 靠它仍能判同账号）；
         *    UUID 的真正补齐由启动自愈负责，且其跳过判据已改为
         *    「已经是 UUID 才算补齐」（见 `isAutoclawUuidUserId`）。
         */
        user_id: json.data.user_id ?? readUserIdFromJwt(newAccess),
        device_id: deviceId,
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      /**
       * ⚠️⚠️ **别让瞬时的端点错误掩盖确定性拒绝**（2026-10-27 第二轮审计打穿）。
       *
       * 本函数**依次试两个端点**。修前无条件覆盖：
       * 端点1 回 `400 invalid_grant`（上游明确说这把 RT 死了）、端点2 回 `503`
       * （网关瞬时抖动）⇒ 最终抛的是 **503** ⇒ 上层判据看不到那次确定性拒绝
       * ⇒ 真死号不标死、退化成每轮白撞。
       *
       * ⇒ 一旦拿到「确定性拒绝」，就**锁定它**（后续端点的错误不再覆盖）。
       */
      if (lastError === undefined || !isDefinitiveRefreshRejection(lastError)) {
        lastError = error
      }
    }
  }

  throw lastError ?? new Error('AutoClaw token refresh failed on all endpoints')
}

/**
 * 校验 AutoClaw 凭据是否连通可用。
 */
export async function testAutoclawConnection(
  accessToken: string,
  options?: {
    product?: AutoclawProduct
    fetchImpl?: typeof fetch
  },
): Promise<boolean> {
  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetchImpl ?? fetch
  const ts = Math.floor(Date.now() / 1000).toString()
  const sign = calculateAutoclawSign(product.appId, ts, product.appKey)
  const cleanAccess = cleanBearerToken(accessToken)

  const url = `${product.apiBase}${AUTOCLAW_MODEL_CONFIG_PATH}`
  try {
    const resp = await fetcher(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Appid': product.appId,
        'X-Auth-TimeStamp': ts,
        'X-Auth-Sign': sign,
        'X-Authorization': `Bearer ${cleanAccess}`,
      },
      signal: AbortSignal.timeout(15_000),
    })

    return resp.ok
  } catch {
    return false
  }
}

// ── 手机短信验证码快速登录模式 ──

export interface SendAutoclawCodeOptions {
  product?: AutoclawProduct
  fetchImpl?: typeof fetch
  deviceId?: string
}

export interface SendAutoclawCodeResult {
  ok: boolean
  msgid?: string
  error?: string
}

export interface LoginAutoclawWithCodeOptions {
  product?: AutoclawProduct
  fetchImpl?: typeof fetch
  deviceId?: string
}

export interface LoginAutoclawWithCodeResult {
  ok: boolean
  credential?: AutoclawCredential
  error?: string
}

/**
 * 读桌面端的**设备号**（`%APPDATA%\<userDataDir>\device\device-id.json`）。
 *
 * ⚠️⚠️ **必须按产品取目录**（2026-10-20 审计 P1）：国际版的 userData 目录是
 *    `AutoClaw-oversea-official`，写死国内目录会让国际账号拿到**国内客户端的
 *    设备号**，读不到时还会静默回落 `crypto.randomUUID()` ⇒ 设备身份与桌面端
 *    不一致，而 `device_id` 会进登录 / 签到 / 续期**三处**请求体。
 */
function resolveDeviceId(product: AutoclawProduct, explicitId?: string): string {
  if (explicitId && explicitId.trim().length > 0) return explicitId.trim()
  try {
    // ⚠️⚠️ 同样必须走隔离口（2026-10-17 审计 P0 修复）：这里读的是用户**真实**
    //   桌面端设备号。测试里读到它会让断言依赖开发机状态（本仓库 `QODER_RUNTIME_INFO`
    //   隔离的正是同款问题），而设备号会进登录/签到请求体 ⇒ 结果不可复现。
    //   ⚠️ 隔离口优先级必须与 `probeAutoclawLocalCredential` **一致**。
    const p = path.join(
      process.env.DSH_AUTOCLAW_APPDATA
        ?? process.env.APPDATA
        ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
      product.userDataDirName,
      'device',
      'device-id.json',
    )
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8')) as { deviceId?: string }
      if (typeof data.deviceId === 'string' && data.deviceId.trim()) {
        return data.deviceId.trim()
      }
    }
  } catch {}
  return crypto.randomUUID()
}

/**
 * 向手机号发送 AutoClaw 登录验证码（/userapi/v1/agent-send-code）。
 */
export async function sendAutoclawVerificationCode(
  phone: string,
  options?: SendAutoclawCodeOptions,
): Promise<SendAutoclawCodeResult> {
  const trimmedPhone = phone.trim()
  if (!PHONE_NUMBER_RE.test(trimmedPhone)) {
    return { ok: false, error: '手机号格式不正确' }
  }

  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetchImpl ?? fetch
  const deviceId = resolveDeviceId(product, options?.deviceId)
  const ts = Math.floor(Date.now() / 1000).toString()
  const sign = calculateAutoclawSign(product.appId, ts, product.appKey)
  const url = `${product.apiBase}${AUTOCLAW_SEND_CODE_PATH}`

  try {
    const resp = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Appid': product.appId,
        'X-Auth-TimeStamp': ts,
        'X-Auth-Sign': sign,
        'X-Lang': 'zh-CN',
        'X-Channel': 'official',
      },
      body: JSON.stringify({
        phone: trimmedPhone,
        source_id: AUTOCLAW_SOURCE_ID,
        device_id: deviceId,
      }),
      signal: AbortSignal.timeout(AUTOCLAW_REQUEST_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return { ok: false, error: `验证码发送失败(${resp.status}): ${text}` }
    }

    const json = (await resp.json()) as {
      code?: number
      msg?: string
      data?: Record<string, unknown>
    }

    if (json.code !== 0) {
      return { ok: false, error: json.msg || `验证码发送失败(错误码: ${json.code})` }
    }

    return { ok: true, msgid: 'autoclaw-sms' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

/**
 * 使用手机验证码登录 AutoClaw 并兑换凭据（/userapi/v1/agent-login）。
 */
export async function loginAutoclawWithCode(
  phone: string,
  code: string,
  options?: LoginAutoclawWithCodeOptions,
): Promise<LoginAutoclawWithCodeResult> {
  const trimmedPhone = phone.trim()
  const trimmedCode = code.trim()
  if (!PHONE_NUMBER_RE.test(trimmedPhone)) {
    return { ok: false, error: '手机号格式不正确' }
  }
  if (!trimmedCode) {
    return { ok: false, error: '验证码不能为空' }
  }
  const numCode = Number(trimmedCode)
  if (!Number.isSafeInteger(numCode)) {
    return { ok: false, error: '验证码必须为纯数字' }
  }

  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetchImpl ?? fetch
  const deviceId = resolveDeviceId(product, options?.deviceId)
  const ts = Math.floor(Date.now() / 1000).toString()
  const sign = calculateAutoclawSign(product.appId, ts, product.appKey)
  const url = `${product.apiBase}${AUTOCLAW_LOGIN_PATH}`

  try {
    const resp = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Appid': product.appId,
        'X-Auth-TimeStamp': ts,
        'X-Auth-Sign': sign,
        'X-Lang': 'zh-CN',
        'X-Channel': 'official',
      },
      body: JSON.stringify({
        phone: trimmedPhone,
        code: numCode,
        source_id: AUTOCLAW_SOURCE_ID,
        device_id: deviceId,
      }),
      signal: AbortSignal.timeout(AUTOCLAW_REQUEST_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return { ok: false, error: `AutoClaw 登录请求失败(${resp.status}): ${text}` }
    }

    const json = (await resp.json()) as {
      code?: number
      msg?: string
      data?: {
        user_id?: string | number
        access_token?: string
        refresh_token?: string
        user_name?: string
        user_phone?: string
        expires_in?: number
        expires_at?: number
      }
    }

    if (json.code !== 0 || !json.data) {
      return { ok: false, error: json.msg || `AutoClaw 登录失败(错误码: ${json.code})` }
    }

    const { data } = json
    if (!data.access_token) {
      return { ok: false, error: 'AutoClaw 响应中缺少 access_token' }
    }

    const cleanAccess = cleanBearerToken(data.access_token)
    const cleanRefresh = data.refresh_token ? cleanBearerToken(data.refresh_token) : undefined
    // ⚠️⚠️ **绝不编造过期时间**（2026-10-19 P0，真实报障）。
    //
    // 旧实现在上游既不给 `expires_at` 也不给 `expires_in` 时写下
    // `Date.now() + 7 * 86400_000`（7 天），而真实 access_token 的寿命是
    // **24 小时**（JWT `iat`→`exp` 实测恒 86400s）⇒ 多出的 6 天让
    // `refreshAll` 的 lead-time 判据与 `healExpiredAccountBeforeBalance`
    // 按需自愈**双双跳过**：凭据到期后表现为「刚启动还能看到积分、
    // 过一会儿变成登录凭据失效」，且**日志零字**；点「刷新积分」也不会自愈。
    //
    // ⇒ 权威是 JWT 的 `exp`；退一步用上游声明值；**都读不到就 `undefined`**
    //   （= 不知道 ⇒ 调用方按「该续期」处理），绝不编数字。
    const declaredExpiresAt = typeof data.expires_at === 'number'
      ? autoclawExpiresAtMs(data.expires_at)
      : typeof data.expires_in === 'number'
        ? Date.now() + data.expires_in * 1000
        : undefined
    const expiresAt = autoclawAccessTokenExpiresAtMs(cleanAccess, declaredExpiresAt)

    // ⚠️⚠️ **`user_id` 必须兜底从 JWT 里取**（2026-10-19 真机取证）：
    //    实测 `/userapi/v1/agent-login` 的 `data` 里**没有** `user_id`
    //    （只有 access_token / refresh_token / expires_*），于是这里原先是
    //    `undefined` ⇒ `JSON.stringify` 时被整键丢弃 ⇒ 凭据里没有 `user_id`。
    //
    //    后果（用户报障「同一账号被加了 3 次」）：`identityOf` 只能退化成
    //    `access_token`，而 access_token **每次登录/续期都轮换**
    //    ⇒ 同一账号每续期一次就被当成一个新账号，池里堆出多条同 `user_id` 的条目，
    //    面板把同一份积分**重复累加**（实测 20838×1 + 20789×2 = 62416）。
    //
    //    JWT payload 的 `user_id` 是稳定的数字 id（`numericUserId`）。
    //
    //    ⚠️ 它与「服务端 `user-profile.user_id`」（UUID）是**两个 id 空间**，
    //       不能混用：老凭据落 UUID、新凭据两个都没有，「字段优先、JWT 兜底」
    //       会让同一账号分裂成两组、去重白做（用户三次报障的教训）。
    //       ⇒ 登录时尽量写这个 JWT 值保底；**真正的统一由
    //         `autoclawSelfHeal` 启动时调 `user-profile` 补 UUID 完成**。
    const jwtUserId = readUserIdFromJwt(cleanAccess)
    const resolvedUserId = data.user_id ?? jwtUserId

    const credential: AutoclawCredential = {
      access_token: cleanAccess,
      refresh_token: cleanRefresh ?? '',
      expires_at: expiresAt,
      device_id: deviceId,
      account_id: resolvedUserId !== undefined ? String(resolvedUserId) : undefined,
      user_id: resolvedUserId,
      user_name: data.user_name,
      user_phone: data.user_phone ?? trimmedPhone,
    }

    return { ok: true, credential }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

export interface StartedAutoclawSmsLoginFlow {
  readonly loginUrl: string
  readonly result: Promise<{ credential: AutoclawCredential; phone: string }>
  readonly close: () => Promise<void>
}

export interface AutoclawSmsLoginFlowOptions {
  product?: AutoclawProduct
  timeoutMs?: number
  fetchImpl?: typeof fetch
  deviceId?: string
}

/**
 * 启动本地独立服务器承载 AutoClaw 登录授权页（支持一键读取本地凭据或手机验证码登录）。
 */
export async function startAutoclawSmsLoginFlow(
  options?: AutoclawSmsLoginFlowOptions,
): Promise<StartedAutoclawSmsLoginFlow> {
  const product = options?.product ?? AUTOCLAW
  const timeoutMs = options?.timeoutMs ?? 180_000

  let settleOk!: (val: { credential: AutoclawCredential; phone: string }) => void
  let settleErr!: (err: unknown) => void

  /**
   * 本轮流**最近一次**渲染登录页时生成的 `state`。
   *
   * 定义在这里（而不是 GET 处理器内）是因为回调处理器要读它比对：
   * 两个处理器是同一 `createServer` 的回调，闭包共享这份变量。
   *
   * ⚠️ 用户刷新登录页会让它被覆盖 —— 所以回调**只 warn 不拒绝**（旧标签页的回调
   * 仍应被认领；`state` 的价值是诊断「回调来自哪一轮」，不是防伪）。
   */
  let pendingZaiState = ''

  const result = new Promise<{ credential: AutoclawCredential; phone: string }>((resolve, reject) => {
    settleOk = resolve
    settleErr = reject
  })

  const server = http.createServer((req, res) => {
    void handleRequest(req, res)
  })

  /** 真正的处理器（异步：登录页要等服务端签发授权地址）。 */
  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${(req.socket as any).localPort ?? 0}`)

    if (req.method === 'GET' && (url.pathname === '/autoclaw/login' || url.pathname === '/')) {
      /**
       * ⚠️⚠️ **登录方式按站点分裂**（2026-11-02 接线，此前这里写死国内形态）。
       *
       * | 站点 | 登录方式 | 依据 |
       * |---|---|---|
       * | 国内 `autoclaw` | 手机短信验证码 | `agent-send-code` / `agent-login` |
       * | 国际 `autoclawintl` | **Z.ai OAuth** | 国际账号是邮箱 + OAuth 创建、`phone` 为 null、无绑手机端点 ⇒ 短信必然失败 |
       *
       * 依据见 `src/autoclaw-product.ts` 那张「为什么是两个 provider」的表，
       * 以及 `autoclaw-oauth.ts` 文件头的实测记录。
       *
       * ## 为什么这里必须算 `redirectUri`
       *
       * OAuth 要求「授权时的 `redirect_uri`」与「换 token 时的 `navigate_uri`」**逐字节相同**
       * （`exchangeAutoclawZaiCode` 的入参）。两处都从 `req.socket.localPort` 取 ——
       * 端口由 {@link listenOnCallbackPorts} 按**注册过的回调端口**选定（不是 `listen(0)`
       * 随机端口，那种端口会被 Z.ai 以「Redirect URI not registered」拒绝），
       * 但处理器拿到的是 `req`，闭包里没有 port 变量，所以仍从 socket 现算。
       */
      const smsLogin = product.id === AUTOCLAW.id
      const localPort = (req.socket as { localPort?: number }).localPort ?? 0
      const redirectUri = `http://127.0.0.1:${localPort}${AUTOCLAW_OAUTH_CALLBACK_PATH}`
      // ⚠️⚠️ **授权地址必须由服务端签发**（2026-11-02 第三轮真机报障）。
      //     客户端里没有 `client_id` 常量：它先起 loopback，再 POST `zai-oauth-url`
      //     拿 `{oauth_url, state}`，最后打开 —— 也就是说 `(client_id, redirect_uri, state)`
      //     是服务端按 `navigate_uri` **现注册的一组**。我们照抄过一次真实 URL 的
      //     `client_id` 自己拼，真机被拒（`Redirect URI not registered for this client`，
      //     报错文案误导，实际端口与路径都对）。
      //     自拼只作**降级**（服务端不可达时至少还能看到页面与原因）。
      const issued = smsLogin
        ? { ok: false as const, error: '' }
        : await fetchAutoclawZaiAuthUrl(redirectUri, { product, fetchImpl: options?.fetchImpl })
      const zaiAuthUrl = issued.ok
        ? ((pendingZaiState = issued.value.state), issued.value.authUrl)
        : buildAutoclawZaiAuthUrl(redirectUri, (pendingZaiState = autoclawZaiState()))
      const zaiIssue = issued.ok ? '' : issued.error
      const pageTitle = smsLogin ? 'AutoClaw 账号登录' : `${product.displayName ?? 'AutoClaw'} 账号登录`
      const pageDesc = smsLogin
        ? '支持一键读取本机桌面端凭据，或通过手机验证码快速登录。'
        : '支持一键读取本机桌面端凭据，或使用 Z.ai 账号授权登录。'
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AutoClaw 登录授权</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; width: 100%; max-width: 420px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
    h2 { margin: 0 0 8px 0; font-size: 20px; font-weight: 600; color: #38bdf8; }
    p.desc { color: #94a3b8; font-size: 13px; margin: 0 0 24px 0; }
    .btn-secondary { width: 100%; background: #334155; color: #f8fafc; border: 1px solid #475569; border-radius: 6px; padding: 10px 16px; font-size: 14px; cursor: pointer; transition: background 0.2s; }
    .btn-secondary:hover { background: #475569; }
    .divider { display: flex; align-items: center; text-align: center; margin: 20px 0; color: #64748b; font-size: 12px; }
    .divider::before, .divider::after { content: ''; flex: 1; border-bottom: 1px solid #334155; }
    .divider::before { margin-right: .5em; }
    .divider::after { margin-left: .5em; }
    .input-group { margin-bottom: 16px; }
    label { display: block; font-size: 12px; color: #cbd5e1; margin-bottom: 6px; }
    input { width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #475569; border-radius: 6px; padding: 10px 12px; color: #f8fafc; font-size: 14px; outline: none; }
    input:focus { border-color: #38bdf8; }
    .row { display: flex; gap: 8px; }
    .row input { flex: 1; }
    .btn-code { background: #0284c7; color: white; border: none; border-radius: 6px; padding: 0 16px; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .btn-code:disabled { background: #475569; cursor: not-allowed; }
    .btn-primary { width: 100%; background: #0284c7; color: white; border: none; border-radius: 6px; padding: 11px 16px; font-size: 15px; font-weight: 500; cursor: pointer; margin-top: 8px; }
    .btn-primary:hover { background: #0369a1; }
    .btn-primary:disabled { background: #475569; cursor: not-allowed; }
    .msg { margin-top: 16px; padding: 10px 12px; border-radius: 6px; font-size: 13px; display: none; }
    .msg.error { display: block; background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; color: #fca5a5; }
    .msg.success { display: block; background: rgba(34, 197, 94, 0.15); border: 1px solid #22c55e; color: #86efac; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${pageTitle}</h2>
    <p class="desc">${pageDesc}</p>
    <button type="button" class="btn-secondary" id="btnLocal">⚡ 一键读取本机桌面端凭据</button>
${smsLogin
      ? `    <div class="divider">或者使用手机验证码登录</div>
    <div class="input-group">
      <label for="phone">手机号</label>
      <input type="tel" id="phone" placeholder="请输入 11 位手机号" maxlength="11" />
    </div>
    <div class="input-group">
      <label for="code">短信验证码</label>
      <div class="row">
        <input type="text" id="code" placeholder="请输入 6 位验证码" maxlength="6" />
        <button type="button" class="btn-code" id="btnSend">获取验证码</button>
      </div>
    </div>
    <button type="button" class="btn-primary" id="btnLogin">登录并绑定账号</button>`
      : `    <div class="divider">或者使用 Z.ai 账号登录</div>
    <a class="btn-primary" id="btnZai" href="${zaiAuthUrl}"
       style="display:block;text-align:center;text-decoration:none;box-sizing:border-box;">🌐 使用 Z.ai 账号继续</a>
    ${zaiIssue === '' ? '' : `<div class="msg error" style="display:block">⚠️ 未能从 AutoClaw 服务端申请授权地址（正在使用降级链接，可能被 Z.ai 拒绝）：${escapeHtml(zaiIssue)}</div>`}`}
    <div class="msg" id="msgBox"></div>
  </div>
  <script>
    const btnLocal = document.getElementById('btnLocal');
    const phoneInput = document.getElementById('phone');
    const codeInput = document.getElementById('code');
    const btnSend = document.getElementById('btnSend');
    const btnLogin = document.getElementById('btnLogin');
    const msgBox = document.getElementById('msgBox');
    function showMsg(type, text) { msgBox.className = 'msg ' + type; msgBox.textContent = text; msgBox.style.display = 'block'; }
    btnLocal.addEventListener('click', async () => {
      btnLocal.disabled = true;
      btnLocal.textContent = '正在检测本地凭据...';
      try {
        const resp = await fetch('/autoclaw/import-local', { method: 'POST' });
        const data = await resp.json();
        if (data.ok) {
          showMsg('success', '✅ 成功读取本机已登录凭据（' + (data.phone || 'AutoClaw账号') + '）！已自动绑定，请关闭本窗口返回 IDE。');
          btnLocal.style.display = 'none';
        } else {
          showMsg('error', data.error || '${smsLogin ? '未检测到本地 AutoClaw 桌面端有效登录凭据，请使用下方手机验证码登录。' : '未检测到本地 AutoClaw 桌面端有效登录凭据，请改用下方的 Z.ai 账号登录。'}');
          btnLocal.disabled = false;
          btnLocal.textContent = '⚡ 一键读取本机 AutoClaw 桌面端凭据';
        }
      } catch (err) {
        showMsg('error', '请求失败：' + (err.message || String(err)));
        btnLocal.disabled = false;
        btnLocal.textContent = '⚡ 一键读取本机 AutoClaw 桌面端凭据';
      }
    });
    if (btnSend && btnLogin) {
    let countdown = 0;
    btnSend.addEventListener('click', async () => {
      const phone = phoneInput.value.trim();
      if (!/^1[3-9]\\d{9}$/.test(phone)) { showMsg('error', '请输入正确的 11 位手机号码'); return; }
      btnSend.disabled = true;
      btnSend.textContent = '发送中...';
      try {
        const resp = await fetch('/autoclaw/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
        const data = await resp.json();
        if (data.ok) {
          showMsg('success', '验证码已发送至手机，请查收');
          countdown = 60;
          btnSend.textContent = countdown + 's 后重新获取';
          const timer = setInterval(() => {
            countdown--;
            if (countdown <= 0) { clearInterval(timer); btnSend.disabled = false; btnSend.textContent = '获取验证码'; }
            else { btnSend.textContent = countdown + 's 后重新获取'; }
          }, 1000);
        } else {
          showMsg('error', data.error || '发送验证码失败');
          btnSend.disabled = false;
          btnSend.textContent = '获取验证码';
        }
      } catch (err) {
        showMsg('error', '发送验证码网络异常：' + (err.message || String(err)));
        btnSend.disabled = false;
        btnSend.textContent = '获取验证码';
      }
    });
    btnLogin.addEventListener('click', async () => {
      const phone = phoneInput.value.trim();
      const code = codeInput.value.trim();
      if (!/^1[3-9]\\d{9}$/.test(phone)) { showMsg('error', '请输入正确的 11 位手机号码'); return; }
      if (!code) { showMsg('error', '请输入收到的短信验证码'); return; }
      btnLogin.disabled = true;
      btnLogin.textContent = '登录中...';
      try {
        const resp = await fetch('/autoclaw/submit-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code }) });
        const data = await resp.json();
        if (data.ok) {
          showMsg('success', '✅ 登录成功！已绑定账号：' + (data.phone || phone) + '，您可以关闭本窗口返回 IDE。');
          btnLogin.style.display = 'none';
        } else {
          showMsg('error', data.error || '验证码登录失败，请重试');
          btnLogin.disabled = false;
          btnLogin.textContent = '登录并绑定账号';
        }
      } catch (err) {
        showMsg('error', '登录网络异常：' + (err.message || String(err)));
        btnLogin.disabled = false;
        btnLogin.textContent = '登录并绑定账号';
      }
    });
    }
  </script>
</body>
</html>`)
      return
    }

    /**
     * ⚠️⚠️ **Z.ai OAuth 回调**（2026-11-02 接线；此前是纯死代码）。
     *
     * 接之前的事实：`buildZaiAuthUrl` / `loginWithZaiCode` /
     * `AUTOCLAW_OAUTH_CALLBACK_PATH` 三样都在，但**零调用方** ——
     * 本地服务的路由只有 `/autoclaw/login`、`send-code`、`submit-code`、
     * `import-local` 四条，登录页也只有短信 + 一键读本机。
     * 后果：国际版**没有任何可用的登录入口**（短信对国际账号必然失败、
     * Z.ai 按钮不存在），只剩「一键导入本机桌面端凭据」。
     *
     * ## 两个必须对齐的点
     *
     * 1. `redirect_uri`（授权时）与 `navigate_uri`（换 token 时）**必须逐字节相同**，
     *    两处都从 `req.socket.localPort` 现算 —— 端口由 `listenOnCallbackPorts`
     *    按**注册过的回调端口**选定（`AUTOCLAW_OAUTH_CALLBACK_PORTS`）。
     * 2. **失败不要 `settleErr`**：那会立刻结束整个 flow（`result` 变成 reject），
     *    用户连重试都不行。这里只回一个错误页，flow 继续等用户再点一次。
     */
    if (req.method === 'GET' && url.pathname === AUTOCLAW_OAUTH_CALLBACK_PATH) {
      /**
       * ⚠️⚠️ **只有国际版注册这条腿**（2026-11-02 审查打穿）。
       *
       * 实测缺陷：不门控时，以 `product: AUTOCLAW`（国内）起的 flow 上，
       * 直接 GET 本端点会**真的**走一遍换 token 并把凭据 settle 进**国内**占位账号，
       * 页面还写着「已绑定 AutoClaw（国际版）账号」—— 与「登录页按站点分裂」自相矛盾，
       * 且给「任意本机进程往 loopback 投递 code」开了一条无入口但可达的路。
       *
       * 同源问题：`/autoclaw/send-code` 与 `/autoclaw/submit-code` 对国际版也仍可达。
       * 那两条**保留**（国际站后端确实接受短信，只是账号没绑手机；UI 已不渲染入口），
       * 因为它们不会把凭据写进错误站点的槽位 —— 而这条会。
       */
      if (product.id !== AUTOCLAW_INTL.id) {
        res.writeHead(404).end('Not Found')
        return
      }
      const renderCallbackPage = (ok: boolean, text: string): string => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>Z.ai 授权</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; width: 100%; max-width: 420px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
  h2 { margin: 0 0 12px 0; font-size: 19px; color: ${ok ? '#4ade80' : '#f87171'}; }
  p { color: #cbd5e1; font-size: 13px; line-height: 1.6; margin: 0; word-break: break-all; }
</style></head><body><div class="card"><h2>${ok ? '✅ 授权已完成' : '❌ 授权失败'}</h2><p>${escapeHtml(text)}</p></div></body></html>`

      const localPort = (req.socket as { localPort?: number }).localPort ?? 0
      const redirectUri = `http://127.0.0.1:${localPort}${AUTOCLAW_OAUTH_CALLBACK_PATH}`
      const code = url.searchParams.get('code') ?? ''
      const state = url.searchParams.get('state') ?? ''
      // 只 warn 不拒绝：用户可能刷新过登录页（`pendingZaiState` 被覆盖），旧标签页的回调
      // 仍应被认领；`state` 在这里的价值是「能不能看出回调来自哪一轮」，不是防伪。
      if (pendingZaiState !== '' && state !== pendingZaiState) {
        // 这里没有 logger 钩子（`AutoclawSmsLoginFlowOptions` 不带告警出口），按仓库惯例
        // 用带守卫的 `console.warn` 兜底 —— 静默丢掉的代价是「回调来自哪一轮」再也查不到。
        if (typeof console !== 'undefined') {
          console.warn(`[autoclaw] Z.ai 回调的 state 与本次流程不一致（收到 ${state === '' ? '空' : state.slice(0, 16) + '…'}）—— 可能是刷新过登录页，继续认领`)
        }
      }
      if (code === '') {
        // ⚠️ 用户点「拒绝授权」时，授权页回的是 `?error=access_denied&error_description=…`
        //    （实测形态）。原文案会把整串 query 甩给用户，等于让人自己读协议。
        const providerError = url.searchParams.get('error') ?? ''
        const providerErrorDesc = url.searchParams.get('error_description') ?? ''
        const hint = providerError === ''
          ? `回调没带授权码。请回到登录页重新点击「使用 Z.ai 账号继续」。（${url.search}）`
          : providerError === 'access_denied'
            ? '你拒绝了授权。请回到登录页重新点击「使用 Z.ai 账号继续」并允许访问。'
            : `授权页返回了错误：${providerError}${providerErrorDesc === '' ? '' : `（${providerErrorDesc}）`}。请回到登录页重试。`
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderCallbackPage(false, hint))
        return
      }
      void (async () => {
        try {
          const exchanged = await exchangeAutoclawZaiCode(code, state, redirectUri, {
            product,
            fetchImpl: options?.fetchImpl,
            deviceId: options?.deviceId,
          })
          if (!exchanged.ok || exchanged.credential === undefined) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(renderCallbackPage(false, `${exchanged.error ?? 'Z.ai 授权失败（未返回凭据）'}。请回到登录页重试。`))
            return
          }
          settleOk({ credential: exchanged.credential, phone: exchanged.credential.user_phone ?? '' })
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          /**
           * ⚠️⚠️ **文案必须中性，不能写「已绑定」**（2026-11-02 审查）。
           *
           * 此刻 `settleOk` 只是 resolve 了 Promise；真正的「这凭据能不能用」发生在
           * RPC 侧的 `verifyCredentialSite()`（它要打一次余额端点），失败就 `failLogin`
           * 并**删账号**。原文案会在浏览器上显示「✅ 已绑定」、IDE 里同时显示
           * 「导入的凭据无法通过校验」然后卡片消失 —— 两句互相打脸。
           *
           * 而且 `Z.ai OAuth 换出的 token 是否等价于 AutoClaw access_token`
           * 至今**零验证**（见 `docs/agent-notes/providers-autoclaw.md` 的「未验证」），
           * 所以这不是理论瑕疵。
           */
          res.end(renderCallbackPage(true, '授权已完成，正在绑定账号 —— 请返回 IDE 查看结果。本窗口可以关闭。'))
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderCallbackPage(false, `授权过程出错：${reason}`))
        }
      })()
      return
    }

    if (req.method === 'POST') {
      let bodyStr = ''
      req.on('data', (chunk) => { bodyStr += chunk })
      req.on('end', async () => {
        let jsonBody: Record<string, any> = {}
        try {
          if (bodyStr.trim()) jsonBody = JSON.parse(bodyStr)
        } catch {}

        if (url.pathname === '/autoclaw/send-code') {
          const resCode = await sendAutoclawVerificationCode(jsonBody.phone ?? '', {
            product,
            fetchImpl: options?.fetchImpl,
            deviceId: options?.deviceId,
          })
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(resCode))
          return
        }

        if (url.pathname === '/autoclaw/submit-code') {
          const resLogin = await loginAutoclawWithCode(jsonBody.phone ?? '', jsonBody.code ?? '', {
            product,
            fetchImpl: options?.fetchImpl,
            deviceId: options?.deviceId,
          })
          if (resLogin.ok && resLogin.credential) {
            settleOk({ credential: resLogin.credential, phone: jsonBody.phone ?? '' })
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, phone: jsonBody.phone ?? '' }))
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: resLogin.error || '登录失败' }))
          }
          return
        }

        if (url.pathname === '/autoclaw/import-local') {
          /**
           * ⚠️⚠️ **必须传 `product`**（2026-10-20 审计 P0 实测复现）。
           *
           * 这是「一键读取本机凭据」的**第二条腿** —— 第一条是
           * `AutoclawAuth.probeLocal()`（`importLocalAccount` 内部）。
           * 两条腿原先各写一份目录名，PR 只改了第一条 ⇒ 国际版的登录页按钮
           * 仍去读**国内** `AutoClaw-official`。
           *
           * 复现（审计）：以 `product: AUTOCLAW_INTL` 起 flow、POST 本端点、
           * 打桩 `fs.existsSync` ⇒ 唯一被探测路径是
           * `...\AutoClaw-official\Local State`（不是 `AutoClaw-oversea-official`）。
           *
           * 危害不只是「读不到」：读到的是**国内凭据**，而这条路径的结果经
           * `started.result` 在 `jet-hub-rpc.ts` **直接 `credentials.set` 落盘**，
           * 不经过 `importLocalAccount` 的归属校验 ⇒ 国内凭据进
           * `AUTOCLAWINTL_ACCOUNT_*`，全程零报错（PR 声称已修的那次事故复发）。
           *
           * ⇒ 目录名从 `product.userDataDirName` 取（单一真相源）；
           *   落盘前的归属校验见 `jet-hub-rpc.ts` 的 `verifyAutoclawCredentialSite`。
           */
          const localCred = await probeAutoclawLocalCredential({ product })
          if (localCred) {
            settleOk({ credential: localCred, phone: localCred.user_phone ?? '' })
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, phone: localCred.user_phone ?? '' }))
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: '未检测到本地 AutoClaw 桌面端有效登录凭据' }))
          }
          return
        }

        res.writeHead(404).end('Not Found')
      })
      return
    }

    res.writeHead(404).end('Not Found')
  }

  // ⚠️ 必须优先用**注册过的回调端口**（`listen(0)` 的随机端口会被 Z.ai 以
  //    `{"detail":"Redirect URI not registered for this client"}` 拒绝，2026-11-02 真机）。
  await listenOnCallbackPorts(server)

  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  const loginUrl = `http://127.0.0.1:${port}/autoclaw/login`

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const timer = setTimeout(() => {
    settleErr(new Error(`AutoClaw 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  result.catch(() => {}).finally(() => {
    clearTimeout(timer)
    void close()
  })

  return { loginUrl, result, close }
}


