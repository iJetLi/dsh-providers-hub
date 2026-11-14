/**
 * Raccoon Work 登录与续期的纯 API 层。
 *
 * ## 两条登录路径
 *
 * 1. **微信扫码**（首选）：`code` 由**客户端本地随机生成**，服务端只做轮询查询。
 *    实测任意自造 code 都被接受并进入 `pending`，故完全绕开官方那条
 *    `office-raccoon://auth/callback` 自定义协议回调 —— 那是本插件（宿主侧
 *    Node 进程）无法接收的。
 * 2. **短信验证码**（次选）：手机号需 AES-128-CFB 加密，且 `send_sms` 要求
 *    先过阿里云滑块拿到 `captcha_param`。
 *
 * ## 为什么不用官方桌面端的授权码链路
 *
 * `desktopLogin.js` 走「网页授权 → `office-raccoon://auth/callback?code=` →
 * `POST /login_with_authorization_code`」。回调地址在网页里是**写死的**，
 * 改不成 localhost，插件收不到回调。故该链路只保留 `exchangeRaccoonAuthorizationCode`
 * 供将来（如支持自定义协议的环境）复用。
 *
 * ## 本模块是纯 API 层
 *
 * 不含本地 HTTP 服务器（那是 `raccoon-login-page.ts` 的职责），
 * 也不做凭据持久化（那是 `raccoon-auth.ts` 的职责）。全部函数可离线单测。
 */

import {
  RACCOON_IAM_OK_CODE,
  RACCOON_IAM_PREFIX,
  RACCOON_IAM_QR_CREATE_PATH,
  RACCOON_IAM_QR_EXPIRED_CODE,
  RACCOON_IAM_QR_INVALID_CODE,
  RACCOON_IAM_QR_LOGIN_PATH,
  RACCOON_QR_POLL_INTERVAL_MS,
  RACCOON_QR_STATUS,
  RACCOON_REQUEST_TIMEOUT_MS,
  decodeJwtExpMs,
  encryptRaccoonPhone,
  raccoonHeaders,
  type RaccoonCredential,
} from './raccoon.js'
import { type RaccoonProduct } from './raccoon-product.js'

/**
 * 扫码轮询的状态值。
 *
 * ⚠️ `expired` **不是服务端下发的状态值** —— 它由我们在 IAM 回
 * `AUTH_QRCODE_INVALID`（HTTP 401）时合成（官方前端同款映射）。
 */
export type RaccoonQrStatus = 'pending' | 'logging' | 'canceled' | 'success' | 'expired'

/** 一次扫码轮询的结果。 */
export interface RaccoonQrPollResult {
  status: RaccoonQrStatus
  /** 仅 `success` 时存在。 */
  accessToken?: string
  /** 仅 `success` 时存在。 */
  refreshToken?: string
  /** 仅 `success` 时存在（毫秒时间戳字符串）。 */
  expiresAt?: string
  /** 仅 `logging` 时存在（二维码有效期）。 */
  expiredAt?: string
}

/** 业务响应信封（失败可能带 HTTP 400/401，也可能 HTTP 200 + 非 0 code）。 */
interface RaccoonEnvelope {
  code: number
  message: string
  details: string
  data: Record<string, unknown> | undefined
}

/** 解析业务信封。`code === 0` 为成功。 */
function parseEnvelope(payload: unknown, status: number): RaccoonEnvelope {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const code = typeof record.code === 'number' ? record.code : (status >= 400 ? status : 0)
  const message = typeof record.message === 'string' ? record.message : ''
  const details = typeof record.details === 'string' ? record.details : ''
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined
  return { code, message, details, data }
}

/** 把信封里的错误拼成一条可读信息（服务端文案优先）。 */
function envelopeError(envelope: RaccoonEnvelope, fallback: string): Error {
  const parts = [envelope.message, envelope.details].filter((s) => s.length > 0)
  const text = parts.length > 0 ? parts.join(': ') : fallback
  return new Error(`raccoon: ${text}`)
}

/** 发一次 JSON 请求并解析信封。 */
async function postJson(
  url: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
  headers: Record<string, string> = {},
): Promise<{ envelope: RaccoonEnvelope; status: number }> {
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `raccoon: 请求失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`raccoon: 响应不是 JSON（HTTP ${response.status}）`)
  }
  return { envelope: parseEnvelope(parsed, response.status), status: response.status }
}

/**
 * 一次扫码会话的**服务端签发**票据。
 *
 * ⚠️⚠️ 2026-11-14 起，`qrcode_code` **不再由客户端生成** —— 必须由 IAM 的
 * `POST /api/iam/v1/auth/mp/qrcode` 签发（形如 `qr-<uuidv7>`），二维码落地页
 * 用服务端下发的 `scan_path` 拼。
 *
 * 旧的「本地随机 32 位 hex」在**新**轮询端点上恒回
 * `401 {"code":"AUTH_QRCODE_INVALID"}`（见 Gitee IKVA90）；而**旧**轮询端点
 * 对任意字符串恒回 `pending`（僵尸端点）⇒ 症状是「扫码后插件一直转圈、零报错」。
 */
export interface RaccoonQrTicket {
  /** 服务端签发的 `qrcode_code`。 */
  code: string
  /** 二维码落地页路径（服务端下发，形如 `/login/mp`）。 */
  scanPath: string
  /** 本张二维码的有效期（毫秒）。 */
  expiresInMs: number
  /** 服务端要求的轮询间隔（毫秒）。 */
  pollIntervalMs: number
}

/**
 * IAM 响应信封。
 *
 * ⚠️ `code` 是**字符串**（`'OK'` / `'AUTH_QRCODE_INVALID'` / …），与业务 API 的
 * 数字 `code: 0` **不是同一类型**，且多一个 `request_id`。两套信封必须分开解析
 * （`parseIamEnvelope` vs `parseEnvelope`），合在一起写会让任何一方静默失效。
 */
interface RaccoonIamEnvelope {
  code: string
  message: string
  requestId: string
  data: Record<string, unknown> | undefined
}

/** 解析 IAM 信封（见 `RaccoonIamEnvelope` 的类型警告）。 */
function parseIamEnvelope(parsed: unknown, httpStatus: number): RaccoonIamEnvelope {
  const record = typeof parsed === 'object' && parsed !== null
    ? parsed as Record<string, unknown>
    : {}
  const code = typeof record.code === 'string' ? record.code : ''
  const message = typeof record.message === 'string' ? record.message : ''
  const requestId = typeof record.request_id === 'string' ? record.request_id : ''
  const data = typeof record.data === 'object' && record.data !== null
    ? record.data as Record<string, unknown>
    : undefined
  // 网关直接回 HTML / 空体时 `code` 为空 —— 用状态码兜底成可读错误，
  // 否则错误文案会变成「申请扫码二维码失败（）」这种没法排查的样子。
  if (code.length === 0 && httpStatus >= 400) {
    return { code: `HTTP_${httpStatus}`, message, requestId, data }
  }
  return { code, message, requestId, data }
}

/** 发一次 IAM 请求并解析信封。 */
async function postIamJson(
  url: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<{ envelope: RaccoonIamEnvelope; status: number }> {
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `raccoon: IAM 请求失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  // ⚠️⚠️ **解析失败不能抛**（PR #76 同型教训的另一面）：这个函数有两个消费者 ——
  //    `createRaccoonQrTicket` 要「抛错让用户看到原因」，而 `pollRaccoonQrLogin` 要
  //    「识别 401 是过期终态」。若在这里抛，401 + HTML 的网关会走到 `poll` 的
  //    `catch` 被当成 `pending` ⇒ 用户拿着一个**永远不可能成功**的二维码一直等
  //    （正是 IKVA90 的症状）。所以这里只把状态码翻译成 `HTTP_<code>` 信封，
  //    交给调用方按语义决定「抛」还是「判终态」。
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    parsed = undefined
  }
  return { envelope: parseIamEnvelope(parsed, response.status), status: response.status }
}

/**
 * 向 IAM 申请一张扫码票据。
 *
 * 依据官网登录组件的 `createQr()`：`POST /auth/mp/qrcode`（其 `t()` 的
 * `baseUrl = '/api/iam/v1'`），并校验 `qrcode_code` / `scan_path` 为字符串、
 * `expires_in ∈ (0, 3600]`、`poll_interval > 0`。
 * 实测返回 `{ qrcode_code: 'qr-…', scan_path: '/login/mp', expires_in: 300, poll_interval: 2 }`
 * （`expires_in` 与 `poll_interval` 的单位都是**秒**）。
 *
 * ⚠️ 签发失败必须**抛出**（而不是退回本地随机 code）—— 本地随机 code 在新端点上
 * 100% 被拒，静默退回只会把「明确失败」变成「一直转圈」。
 */
export async function createRaccoonQrTicket(
  product: RaccoonProduct,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonQrTicket> {
  const { envelope, status: httpStatus } = await postIamJson(
    `${product.apiBase}${RACCOON_IAM_PREFIX}${RACCOON_IAM_QR_CREATE_PATH}`,
    {},
    fetcher,
  )
  if (envelope.code !== RACCOON_IAM_OK_CODE || envelope.data === undefined) {
    // 报错必须同时带**码**（`INTERNAL` / `HTTP_502` …）与**服务端原文**：
    // 只留其一，用户报障时我们没法区分「签名错」「限流」「网关挂」。
    const code = envelope.code.length > 0 ? envelope.code : `HTTP ${httpStatus}`
    const detail = envelope.message.length > 0 ? `：${envelope.message}` : ''
    throw new Error(`raccoon: 申请扫码二维码失败（${code}）${detail}`)
  }
  const rawCode = envelope.data.qrcode_code
  const rawScanPath = envelope.data.scan_path
  if (typeof rawCode !== 'string' || rawCode.length === 0) {
    throw new Error('raccoon: 申请扫码二维码失败（响应里没有 qrcode_code）')
  }
  // 必须拒绝协议相对 URL（`//evil.example/steal`）：它同样 startsWith('/')，
  // 但 `new URL(它, apiBase)` 会把 origin 换成外域 ⇒ 二维码指向攻击者。
  if (typeof rawScanPath !== 'string' || !rawScanPath.startsWith('/') || rawScanPath.startsWith('//')) {
    throw new Error('raccoon: 申请扫码二维码失败（响应里没有可用的 scan_path）')
  }
  const rawExpiresIn = envelope.data.expires_in
  const rawPollInterval = envelope.data.poll_interval
  const expiresInSec = typeof rawExpiresIn === 'number'
    && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
    ? Math.min(rawExpiresIn, 3600)
    : 300
  const pollIntervalSec = typeof rawPollInterval === 'number'
    && Number.isFinite(rawPollInterval) && rawPollInterval > 0
    ? Math.min(rawPollInterval, 60)
    : RACCOON_QR_POLL_INTERVAL_MS / 1000
  return {
    code: rawCode,
    scanPath: rawScanPath,
    expiresInMs: Math.round(expiresInSec * 1000),
    // 官方前端把下界夹到 1 秒（`Math.max(1e3, …)`），照抄以免服务端给 0 时页面空转
    pollIntervalMs: Math.max(1_000, Math.round(pollIntervalSec * 1000)),
  }
}

/**
 * 构造二维码承载的登录页 URL。
 *
 * 依据官网 `5348-…js`：`new URL(scan_path, qrOrigin)` 后 `search = ''`，再
 * `set('code', qrcode_code)` / `set('appname', brand)` / `set('source', 'platform')`。
 * `qrOrigin` 取自服务端渲染数据（实测 `https://xiaohuanxiong.com/`），与
 * `product.apiBase` 同源，故直接以它作 base。
 *
 * ⚠️ 该页面在 2026-11-14 实测**全部 404**（`/login/mp` 及其变体都是
 * `__next_error__`，只有 `/login/mp/` 回 308 再 404）——`scan_path` 名为
 * `/login/mp`，疑似**小程序页面路径**被误用于 web 端。我们仍按官方拼法生成
 * （页面恢复后自然可用），但 `raccoon-login-page.ts` 必须同时给出
 * 「用手机 App 扫码」的兜底提示，不能只给一个打不开的二维码。
 */
export function buildQrImageUrl(product: RaccoonProduct, ticket: RaccoonQrTicket): string {
  const url = new URL(ticket.scanPath, product.apiBase)
  url.search = ''
  url.searchParams.set('code', ticket.code)
  url.searchParams.set('appname', '商汤小浣熊官网')
  url.searchParams.set('source', 'platform')
  return url.href
}

/**
 * 轮询一次扫码登录状态（走 IAM 新端点）。
 *
 * ⚠️ **任何异常都降级为 `pending`**（网络抖动、响应畸形、未知 status）：
 * 轮询是 2 秒一次的循环，偶发失败不应中断整个登录流程；而把未知状态
 * 误判成 `success` 会让流程拿到空 token 后卡死，误判成 `canceled` 则会让
 * 用户正在扫码的二维码被无故刷新。
 *
 * ⚠️⚠️ **终态有两个码，必须都认**（2026-11-15 真机实测）：
 * - `401 AUTH_QRCODE_INVALID`：code 不是 IAM 签发的（乱码/伪造）
 * - `410 AUTH_QRCODE_EXPIRED`：这张票曾经有效，但已过 `expires_in`
 *   （签一张真票等它自然到期，`t+305s` 实测回这个）
 *
 * 两者都必须让页面重新签发（我们合成为 `expired`）。**不能降级成 `pending`**：
 * 那样页面会永远转圈，而这正是 2026-11-14 之前「扫码后插件一直转圈、零报错」
 * 的症状（Gitee IKVA90）。
 *
 * ⚠️ 反向对照：**5xx 绝不能被当成过期**（否则上游抖一下就会无限重签）。所以这里
 * 只认精确的 401/410，不写 `httpStatus >= 400`（对抗审计 S2）。
 *
 * ⚠️ 旧端点 `/api/web/auth/v1/login_with_qrcode_code` 已是**僵尸端点**：对任意
 * 字符串恒回 `{"code":0,…,"status":"pending"}`（实测），不再推进任何状态。
 * 保留它只会让「二维码早就失效」看起来像「一直在等」。
 */
export async function pollRaccoonQrLogin(
  product: RaccoonProduct,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonQrPollResult> {
  let envelope: RaccoonIamEnvelope
  let httpStatus: number
  try {
    const result = await postIamJson(
      `${product.apiBase}${RACCOON_IAM_PREFIX}${RACCOON_IAM_QR_LOGIN_PATH}`,
      { qrcode_code: code },
      fetcher,
    )
    envelope = result.envelope
    httpStatus = result.status
  } catch {
    return { status: 'pending' }
  }
  // 二维码失效：401 乱码 / 410 真过期都要重新签发（官方前端同样映射成 expired）
  if (
    envelope.code === RACCOON_IAM_QR_INVALID_CODE
    || envelope.code === RACCOON_IAM_QR_EXPIRED_CODE
    || httpStatus === 401
    || httpStatus === 410
  ) {
    return { status: 'expired' }
  }
  if (envelope.code !== RACCOON_IAM_OK_CODE || envelope.data === undefined) {
    return { status: 'pending' }
  }

  const raw = envelope.data.status
  const status = typeof raw === 'string' ? raw : ''
  const expiredAt = typeof envelope.data.expired_at === 'string' ? envelope.data.expired_at : undefined

  if (status === RACCOON_QR_STATUS.canceled) return { status: 'canceled' }
  if (status === RACCOON_QR_STATUS.logging) {
    return { status: 'logging', ...expiredAt !== undefined ? { expiredAt } : {} }
  }
  if (status === RACCOON_QR_STATUS.success) {
    const accessToken = typeof envelope.data.access_token === 'string' ? envelope.data.access_token : ''
    const refreshToken = typeof envelope.data.refresh_token === 'string' ? envelope.data.refresh_token : ''
    // ⚠️ 缺 token 的 success 视为未完成：否则会产出空凭据并让流程卡死
    if (accessToken.length === 0) return { status: 'pending' }
    const expMs = decodeJwtExpMs(accessToken)
    return {
      status: 'success',
      accessToken,
      refreshToken,
      ...expMs !== undefined ? { expiresAt: String(expMs) } : {},
    }
  }
  return { status: 'pending' }
}

/**
 * 下发短信验证码。
 *
 * ⚠️ 手机号必须 AES-128-CFB 加密（否则 `100003 params_encryted_error`）。
 * ⚠️ `captcha_param` 是阿里云滑块验证码的产物，**必需**（否则
 * `100006 captcha_verify_error`）。
 */
export async function sendRaccoonSmsCode(
  product: RaccoonProduct,
  phone: string,
  captchaParam: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/send_sms`,
    {
      captcha_param: captchaParam,
      nation_code: '86',
      phone: encryptRaccoonPhone(phone),
    },
    fetcher,
  )
  if (envelope.code !== 0) {
    if (envelope.code === 100006) {
      throw new Error('raccoon: 图形验证码校验失败，请重新完成滑块验证')
    }
    throw envelopeError(envelope, '下发短信验证码失败')
  }
}

/**
 * 用短信验证码登录。
 *
 * @returns 完整凭据（`expires_at` 由 JWT 的 exp 推算）。
 * @throws 验证码错误/过期、手机号非法、网络失败。
 */
export async function loginRaccoonWithSmsCode(
  product: RaccoonProduct,
  phone: string,
  smsCode: string,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonCredential> {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/login_with_sms`,
    {
      nation_code: '86',
      phone: encryptRaccoonPhone(phone),
      sms_code: smsCode,
    },
    fetcher,
  )
  if (envelope.code !== 0) throw envelopeError(envelope, '短信登录失败')
  return credentialFromEnvelope(envelope)
}

/** 从成功信封里取出凭据；缺 `access_token` 时抛错（不产出半截凭据）。 */
function credentialFromEnvelope(envelope: RaccoonEnvelope): RaccoonCredential {
  const data = envelope.data ?? {}
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : ''
  if (accessToken.length === 0) {
    throw new Error('raccoon: 登录响应缺少 access_token')
  }
  const expMs = decodeJwtExpMs(accessToken)
  const officeIdentity = typeof data.office_identity === 'string' ? data.office_identity : ''
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...expMs !== undefined ? { expires_at: String(expMs) } : {},
    ...officeIdentity.length > 0 ? { office_identity: officeIdentity } : {},
  }
}

/**
 * 用授权码换取凭据（官方桌面端链路）。
 *
 * 本插件**当前不走这条路**（收不到自定义协议回调），保留它是为了让
 * 「官方链路」有可单测的落点，并在将来支持自定义协议时可直接复用。
 */
export async function exchangeRaccoonAuthorizationCode(
  product: RaccoonProduct,
  authorizationCode: string,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonCredential> {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/login_with_authorization_code`,
    { authorization_code: authorizationCode },
    fetcher,
  )
  if (envelope.code !== 0) {
    // 官方约定：200035 = 授权码不存在/过期/已消费
    if (envelope.code === 200035) {
      throw new Error('raccoon: 授权码已失效，请重新发起登录')
    }
    throw envelopeError(envelope, '授权码登录失败')
  }
  return credentialFromEnvelope(envelope)
}

/**
 * 用 refresh_token 换新凭据。
 *
 * ⚠️ 服务端可能**只返回新的 access_token**（不带新 refresh_token），
 * 此时必须**保留旧值** —— 否则续期一次就把账号变成不可续期。
 * ⚠️ 服务端不返回的附加字段（昵称、身份、设备号）也要保留。
 * ⚠️ 401 表示 refresh_token 已失效，**抛「请重新登录」且不重试**。
 */
export async function refreshRaccoonCredential(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonCredential> {
  const { envelope, status } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/refresh`,
    { refresh_token: credential.refresh_token },
    fetcher,
  )
  if (status === 401 || envelope.code === 200003) {
    throw new Error('raccoon: 登录态已过期，请重新登录')
  }
  if (envelope.code !== 0) throw envelopeError(envelope, '续期失败')

  const data = envelope.data ?? {}
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  if (accessToken.length === 0) {
    throw new Error('raccoon: 续期响应缺少 access_token')
  }
  const nextRefresh = typeof data.refresh_token === 'string' && data.refresh_token.length > 0
    ? data.refresh_token
    : credential.refresh_token
  const expMs = decodeJwtExpMs(accessToken)
  return {
    ...credential,
    access_token: accessToken,
    refresh_token: nextRefresh,
    ...expMs !== undefined ? { expires_at: String(expMs) } : {},
  }
}

/**
 * 拉取用户信息（展示用）。
 *
 * ⚠️ 失败时返回**空对象**而不是抛错：用户信息只用于昵称展示，
 * 不该因为它失败而让整个登录流程失败（登录已经成功了）。
 *
 * ⚠️ `nickname` 取的是远端的 `name`，而**它是服务端自动生成的默认名**
 *（实测 `RaccoonAva`），微信扫码不回传微信昵称 —— 故多账号消歧要靠 `phone`。
 */
export async function fetchRaccoonUserInfo(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<{ userId?: string; nickname?: string; officeIdentity?: string; phone?: string }> {
  try {
    const response = await fetcher(`${product.apiBase}${product.authApiPrefix}/user_info`, {
      method: 'GET',
      headers: raccoonHeaders(credential),
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return {}
    const envelope = parseEnvelope(await response.json(), response.status)
    if (envelope.code !== 0 || envelope.data === undefined) return {}
    const userId = typeof envelope.data.id === 'string' ? envelope.data.id : ''
    const nickname = typeof envelope.data.name === 'string' ? envelope.data.name : ''
    const officeIdentity = typeof envelope.data.office_identity === 'string'
      ? envelope.data.office_identity
      : ''
    const phone = typeof envelope.data.phone === 'string' ? envelope.data.phone : ''
    return {
      ...userId.length > 0 ? { userId } : {},
      ...nickname.length > 0 ? { nickname } : {},
      ...officeIdentity.length > 0 ? { officeIdentity } : {},
      ...phone.length > 0 ? { phone } : {},
    }
  } catch {
    return {}
  }
}
