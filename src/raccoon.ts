/**
 * Raccoon Work（商汤小浣熊）协议常量与纯函数。
 *
 * ## 与既有 provider 的关系
 *
 * raccoon 是本插件第 9 个 provider，也是**第二个用「本地页承载登录」**的
 * （第一个是 Loomy）：登录页跑在 `127.0.0.1` 的临时 HTTP 服务上，
 * 页面内联渲染二维码与短信表单，宿主侧持有全部敏感状态。
 *
 * ## 三个必须记住的坑
 *
 * 1. **官方桌面端的登录链路不可复用**：它靠 `office-raccoon://auth/callback`
 *    自定义协议回调，而本插件是宿主侧 Node 进程，收不到该回调；且
 *    `/code/authorize` 页面的回调地址是**写死的**，改不成 localhost。
 *    故改为「客户端本地生成 code + 自行轮询」—— 实测任意自造 code 都被接受。
 * 2. **手机号必须 AES-128-CFB 加密**（密钥见 `RACCOON_PHONE_CIPHER_SECRET`），
 *    否则 `send_sms` 回 `100003 params_encryted_error`。
 * 3. **每日 300 积分没有端点**：服务端按日自动发放（`daily_grant`）。
 *    不要把它实现成签到按钮 —— 见 `raccoon-credits.ts`。
 */

import { createCipheriv, randomBytes } from 'node:crypto'

/** API 基址。 */
export const RACCOON_API_BASE = 'https://xiaohuanxiong.com'

/** 认证端点前缀。 */
export const RACCOON_AUTH_PREFIX = '/api/web/auth/v1'
/** 推理与模型目录前缀。 */
export const RACCOON_LLM_PREFIX = '/api/web/llm/v2'
/** 积分端点前缀。 */
export const RACCOON_POINTS_PREFIX = '/api/web/points/v1'
/** 桌面端端点前缀（含一次性登录奖励）。 */
export const RACCOON_DESKTOP_PREFIX = '/api/web/desktop/v1'

/**
 * 手机号传输层加密密钥。
 *
 * ⚠️ 这是**公开常量**（客户端把它硬编码在前端 bundle 里），只用于防止手机号
 * 明文出现在日志/代理里，**不是安全边界**。故放在本文件不引入新的泄露面。
 * 与 Loomy 的 AccessKey 同性质。
 */
export const RACCOON_PHONE_CIPHER_SECRET = 'senseraccoon2023'

/**
 * 续期提前窗口（秒）。
 *
 * 照抄官方 `scheduleAuth.js` 的 `TOKEN_REFRESH_WINDOW_SECONDS = 300`：
 * access_token 寿命约 3 小时（实测 `exp - nbf = 10805s`），提前 5 分钟刷新
 * 可避免边界失败。
 */
export const RACCOON_TOKEN_REFRESH_WINDOW_SECONDS = 300

/** 请求超时（毫秒）。 */
export const RACCOON_REQUEST_TIMEOUT_MS = 60_000

/**
 * 扫码轮询间隔（毫秒）—— **仅当服务端未下发 `poll_interval` 时的兜底**。
 *
 * 2026-11-14 起服务端在签发二维码时一并下发 `poll_interval`（实测 2 秒），
 * 页面按它设轮询周期；这个常量只是防御（老版本服务端 / 字段缺失）。
 */
export const RACCOON_QR_POLL_INTERVAL_MS = 2_000

/**
 * IAM 服务前缀。
 *
 * ⚠️⚠️ **与业务 API 前缀（`product.authApiPrefix = /api/web/auth/v1`）是两个不同的
 * 东西**，别混用：扫码登录在 2026-11-14 前后整体迁到了 IAM。
 *
 * 依据：官网 `/login` 的渲染数据里 `qrOrigin: "https://xiaohuanxiong.com/"`，
 * 而登录组件的 `t()` 请求函数 `baseUrl: "/api/iam/v1"`（chunk `1919-…`）。
 * 实测 `POST https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode` ⇒ 200。
 */
export const RACCOON_IAM_PREFIX = '/api/iam/v1'

/** IAM 签发扫码二维码的路径（`POST`，服务端生成 `qrcode_code`）。 */
export const RACCOON_IAM_QR_CREATE_PATH = '/auth/mp/qrcode'

/** IAM 轮询扫码状态的路径（`POST`）。 */
export const RACCOON_IAM_QR_LOGIN_PATH = '/auth/mp/qrcode/login'

/**
 * IAM 信封的成功码。
 *
 * ⚠️⚠️ 与业务 API 的成功码**不是同一个类型**：业务 API 是 `{ code: 0 }`（数字），
 * IAM 是 `{ code: 'OK' }`（字符串），且多一个 `request_id`。两套信封必须分开解析
 * （`parseIamEnvelope` 与 `parseEnvelope`），混用会让文案与分类双双错位。
 */
export const RACCOON_IAM_OK_CODE = 'OK'

/** IAM 的二维码失效码（轮询时下发，HTTP 401）。 */
export const RACCOON_IAM_QR_INVALID_CODE = 'AUTH_QRCODE_INVALID'

/** 扫码登录整体超时（毫秒）。 */
export const RACCOON_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 扫码状态机的状态值。
 *
 * ⚠️ `expired` **不是服务端下发的状态值**（服务端只有 pending / logging /
 * canceled / success）—— 它由**我们**在 IAM 回 `AUTH_QRCODE_INVALID`（HTTP 401）
 * 时合成：官方前端把该码映射成 `expired` 分支（chunk `5348` 的
 * `"AUTH_QRCODE_EXPIRED"===e.code?"expired":"failed"`），体验上等价。
 */
export const RACCOON_QR_STATUS = {
  pending: 'pending',
  logging: 'logging',
  canceled: 'canceled',
  success: 'success',
  expired: 'expired',
} as const

/**
 * raccoon 凭据。
 *
 * ⚠️ `access_token` 字段名**必须**是这个 ——
 * `AccountPool.findAccountIdByCredential` 对非 `codearts` 的 provider
 * 统一取该字段作身份标识。
 */
export interface RaccoonCredential {
  /** JWT（服务端下发）。 */
  access_token: string
  /** 续期用（服务端下发）。 */
  refresh_token: string
  /** 过期时间（**毫秒时间戳字符串**），由 JWT 的 exp 推算。 */
  expires_at?: string
  /** `personal` 或组织码。 */
  office_identity?: string
  /** 用户 id。 */
  user_id?: string
  /**
   * 展示用昵称。
   *
   * ⚠️ **服务端的 `name` 是自动生成的默认名**（实测本机账号为 `RaccoonAva`，
   * 即「Raccoon」+ 随机串），微信扫码**不回传微信昵称**
   *（`wechat_bindings` 只有绑定 id 与时间）。故它**不适合做多账号区分** ——
   * 详见 `src/jet-hub-rpc.ts` 的昵称回填逻辑。
   */
  nickname?: string
  /**
   * 绑定/注册的手机号（远端 `user_info.phone`）。
   *
   * 用于**多账号消歧**：昵称是通用默认名时，手机号尾号是唯一可靠的区分依据。
   */
  phone?: string
  /** 设备指纹（32 位 hex），用于 `X-Client-Device-ID`。 */
  device_id?: string
}

/**
 * 解码 JWT payload 的 `exp`，换算成**毫秒**时间戳。
 *
 * ⚠️ 只解码、**不验签** —— 我们只需要知道什么时候该续期，签名由服务端校验。
 * ⚠️ 任何解析失败都返回 `undefined` 而**不抛错**：凭据可能被手工改坏，
 * 那时应当降级成「无过期信息」（宁可试一次），而不是让整个 provider 崩。
 */
export function decodeJwtExpMs(token: string): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    // JWT 用 base64url；Node 的 base64 解码器接受 base64url 字符集
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    const exp = (payload as Record<string, unknown>).exp
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return undefined
    return exp * 1000
  } catch {
    return undefined
  }
}

/**
 * 解析凭据的过期时刻（毫秒）。
 *
 * 取值优先级：`expires_at`（显式字段）→ **JWT 的 `exp`**。
 *
 * ⚠️ **回退到 JWT 是必需的，不是锦上添花**：`expires_at` 是可选字段，
 * 老凭据或手工导入的凭据可能没有它。只读 `expires_at` 会让过期判定
 * **恒为 false**，于是 `refreshAll` 永远跳过这些账号 —— 表现为
 * 「凭据悄悄过期、续期从不触发」，与 AGENTS.md 里「续期按 enabled 过滤」
 * 那次缺陷是同一类（静默失效，无任何报错）。
 */
export function raccoonCredentialExpiresAtMs(credential: RaccoonCredential): number | undefined {
  const raw = credential.expires_at
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  // 回退：access_token 是 JWT，本地解码 exp 即可
  return decodeJwtExpMs(credential.access_token)
}

/**
 * 凭据是否已过期。
 *
 * 无任何过期信息（既无 `expires_at` 也不是 JWT）时视为**不过期**：
 * 宁可用一个可能过期的凭据去试（服务端会回 401，我们能识别并续期），
 * 也不要凭猜测阻止用户使用。
 */
export function isRaccoonExpired(credential: RaccoonCredential): boolean {
  const expiresAt = raccoonCredentialExpiresAtMs(credential)
  return expiresAt !== undefined && expiresAt <= Date.now()
}

/**
 * 凭据是否可静默续期。
 *
 * 判据是 `refresh_token` 非空 —— raccoon **有** refresh 端点
 * （`POST /api/web/auth/v1/refresh`），与 Loomy（恒 false）不同。
 */
export function isRaccoonRefreshable(credential: RaccoonCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.trim().length > 0
}

/**
 * 加密手机号，供 `send_sms` / `login_with_sms` 使用。
 *
 * 算法照抄客户端（渲染层模块 68284 的 `yv()`）：
 *
 * ```
 * key   = UTF8("senseraccoon2023")  → 16 字节 ⇒ AES-128
 * iv    = 随机 16 字节
 * mode  = CFB, padding = NoPadding
 * 输出  = Base64(iv ‖ ciphertext)
 * ```
 *
 * ⚠️ 必须**显式**写 `aes-128-cfb`：密钥是 16 字节，写成 `aes-256-cfb` 会因
 * 长度不足而抛错（不会自动补齐）。
 * ⚠️ 填充语义已实测：CFB 是流密码，`setAutoPadding(true/false)` 输出**完全一致**
 * （11 字节手机号两种设置下密文都是 11 字节）。这里显式关掉以对齐 CryptoJS
 * 的 `NoPadding`，避免读者误以为有填充。
 *
 * @param iv 仅供单测注入固定值；生产路径省略（随机）。
 */
export function encryptRaccoonPhone(phone: string, iv?: Buffer): string {
  const key = Buffer.from(RACCOON_PHONE_CIPHER_SECRET, 'utf8')
  const nonce = iv ?? randomBytes(16)
  const cipher = createCipheriv('aes-128-cfb', key, nonce)
  cipher.setAutoPadding(false)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(phone, 'utf8')), cipher.final()])
  return Buffer.concat([nonce, ciphertext]).toString('base64')
}

/** 远端模型条目中本插件关心的字段。 */
export interface RaccoonModelMeta {
  /** 模型 id（发给 `chat/completions` 的 `model`）。 */
  id: string
  /** 展示名主体（远端 `description`）。 */
  description: string
  /** **当前生效**倍率（远端 `billing_effective_multiplier`）。 */
  effectiveMultiplier: number
  /** 原价倍率（远端 `billing_multiplier`）。 */
  baseMultiplier: number
  /** 计费状态。 */
  status: 'normal' | 'discount' | 'limited_free'
  /** 状态角标文案（远端 `billing_status_note`，如「限免一个月」）。 */
  statusNote: string
}

/** 倍率格式化：去掉浮点噪声，`0.75` → `0.75`、`1` → `1`、`0.1` → `0.1`。 */
function formatMultiplier(value: number): string {
  // 最多 4 位小数，并去掉尾随 0（服务端实测值最多 2 位，留余量）
  return String(Number(value.toFixed(4)))
}

/**
 * 最终展示名：`GLM-5-3 · x0.75` / `SenseNova-6.8-Flash · 免费` /
 * `GLM-5-3-Flash · x0.2→x0.1` / `Kimi-K3 · x1`。
 *
 * ⚠️ 倍率必须拼进 `name`（**不是** `description`）：composer 的模型切换菜单
 * 只渲染 `name`，`description` 仅用于 `/model` 弹窗。这是被用户报障纠正过的结论。
 *
 * ⚠️ **1 倍也要显示**（真实缺陷，用户报障：「为什么 Kimi-K3 没有倍率，
 * ide 是 1 倍，1 倍也要显示倍率」）。早期按「1 倍是默认，显示属噪声」省略它，
 * 结果该模型在列表里**看起来没有计费信息** —— 用户无法区分
 * 「它就是 1 倍」与「我们没取到它的倍率」。IDE 的模型选择器同样显示「1 倍」，故对齐。
 *
 * 三条展示规则：
 * - 生效价为 **0** → 显示「免费」（**不是** `x0`）；
 * - 生效价 **严格小于**原价 → 显示 `x原价→x折后价`（箭头比「（促销 …）」短，
 *   适合窄菜单；与 TRAE/buddy 的形态统一）；
 * - 其余（**含 1 倍**）→ 显示 `x生效价`。
 */
export function raccoonDisplayName(model: RaccoonModelMeta): string {
  const name = typeof model.description === 'string' && model.description.length > 0
    ? model.description
    : model.id
  const effective = model.effectiveMultiplier
  // 非有限数 / 负数：不追加后缀，避免产出「模型名 · 」这种孤立分隔符。
  // ⚠️ 这条只处理「取不到倍率」，与「倍率恰好是 1」是两回事（后者要显示）。
  if (typeof effective !== 'number' || !Number.isFinite(effective) || effective < 0) return name

  if (effective === 0) return `${name} · 免费`

  const base = model.baseMultiplier
  const hasBase = typeof base === 'number' && Number.isFinite(base) && base > 0
  // 促销：有原价、原价大于生效价、且生效价非 0（0 已在上面处理）
  if (hasBase && base > effective) {
    return `${name} · x${formatMultiplier(base)}→x${formatMultiplier(effective)}`
  }
  // 含 1 倍在内，一律显示生效价（见上方注释：省略会让用户以为「没取到倍率」）
  return `${name} · x${formatMultiplier(effective)}`
}

/**
 * 业务端点请求头。
 *
 * 依据客户端 `createHeaders()`。`X-Client-Platform` 对
 * `desktop/v1/login/points/grant` **必需**（取值必须是
 * `desktop-windows` / `desktop-macos` / `desktop-linux`）。
 */
export function raccoonHeaders(
  credential: RaccoonCredential,
  opts: { platform?: string; version?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.access_token}`,
    // 个人账号为空串；客户端总是发送该头
    'X-Org-Code': credential.office_identity ?? '',
    'X-Raccoon-Language': 'zh',
  }
  if (opts.platform !== undefined && opts.platform.length > 0) {
    headers['X-Client-Platform'] = opts.platform
  }
  if (opts.version !== undefined && opts.version.length > 0) {
    headers['X-Client-Version'] = opts.version
  }
  if (credential.device_id !== undefined && credential.device_id.length > 0) {
    headers['X-Client-Device-ID'] = credential.device_id
  }
  return headers
}
