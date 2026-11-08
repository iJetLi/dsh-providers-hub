/**
 * Magicrew 的三层凭证与续期。
 *
 * ## 三层凭证（有效期完全不同，实测 2026-10-28）
 *
 * | 层 | 有效期 | 用途 | 续期方式 |
 * |---|---|---|---|
 * | 网页 JWT | 30 天 | 业务 API（目录/计费/积分） | 手机号+密码重登 |
 * | `mgw_` api_key | **2 小时** | 模型网关（推理） | `PUT /tokens` |
 * | refresh_token | 7 天，**一次性轮换** | 换 api_key | 同上，**必须串行** |
 *
 * ## ⚠️ 两条不能违反的规则（magpie 侧真实事故换来的，AGENTS.md 坑 #3 / #4）
 *
 * 1. **签新 key 会吊销旧 key** ⇒ 绝不在热路径上签发。只允许「登录」与「续期」两个入口。
 * 2. **refresh_token 只能有一个出口** ⇒ 只允许本文件的 `refreshMagicrewKey` 持有，
 *    别的模块不得自持第二份（分叉的后果是两处 token 不一致、用户莫名掉登录）。
 */

import { createHash } from 'node:crypto'

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import { shouldRefreshNow } from './expiry-sync.js'
import {
  MAGICREW_BROWSER_LOGIN_TIMEOUT_MS,
  startMagicrewBrowserLogin,
  type MagicrewBrowserLogin,
} from './magicrew-browser-login.js'
import {
  jwtTimes,
  readMagicrewLocalCreds,
  type MagicrewLocalBrowserOptions,
} from './magicrew-local-browser.js'
import { fetchMagicrewProfile, type MagicrewProfile } from './magicrew-profile.js'
import { SerialQueue } from './serial-queue.js'
import {
  MAGICREW,
  MAGICREW_GATEWAY_TOKENS_PATH,
  MAGICREW_SESSIONS_PATH,
  MAGICREW_USER_AGENT,
  type MagicrewProduct,
} from './magicrew-product.js'

/** 一个账号的完整凭据。**不存密码**（JWT 30 天 + refresh_token 自滚，存密码得不偿失）。 */
export interface MagicrewCredential {
  /** 网页 JWT（业务 API 用）。 */
  jwt: string
  /** 组织码 —— **必须与 apiKey 配对**（错配会得到 HTTP 200 + `code:403`）。 */
  organizationCode: string
  /** 模型网关 key（2 小时）；缺失时可通过 refreshToken 救回。 */
  apiKey?: string
  apiKeyExpiresAt?: number
  /** 换 key 用，一次性轮换。 */
  refreshToken?: string
  refreshTokenExpiresAt?: number
  /** 手机号（仅展示，不参与鉴权）。 */
  phone?: string
  /**
   * 上游昵称（**仅展示**；登录时取自 {@link fetchMagicrewProfile}）。
   *
   * ⚠️ 与 `phone` 同级：卡片的展示名按 `nickname → 脱敏手机号 → displayName` 判
   * （见 {@link magicrewDisplayNickname}），它**不参与**任何鉴权。
   *
   * ⚠️ 可选字段，**老凭据里没有它** —— 这是刻意的向后兼容：没有本字段时展示判据
   * 逐字节回到改动前的行为。
   */
  nickname?: string
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把账号池里的 `unknown` 收窄成 {@link MagicrewCredential}。
 *
 * 判据：**`jwt` 是唯一必需字段**（业务 API 全靠它；api_key 缺失可由 refresh_token 救回，
 * 而 jwt 缺失意味着连目录都拉不到）⇒ 此时返回 `undefined`（账号不可用）。
 */
export function parseMagicrewCredential(raw: unknown): MagicrewCredential | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as Record<string, unknown>
  const jwt = readString(source, 'jwt')
  if (jwt === undefined) return undefined
  const apiKey = readString(source, 'apiKey')
  const refreshToken = readString(source, 'refreshToken')
  const phone = readString(source, 'phone')
  const apiKeyExpiresAt = readNumber(source, 'apiKeyExpiresAt')
  const refreshTokenExpiresAt = readNumber(source, 'refreshTokenExpiresAt')
  // ⚠️ `nickname` 必须过 parse：卡片的展示名可以来自**刚落库的返回值**（那条路
  //    不经过本函数），但任何「从凭据库读回来再展示」的路径都经过它 —— 漏掉这一行
  //    会让重启后的卡片**又变回**「超级麦吉」（而登录那一刻是对的，极难归因）。
  const nickname = readString(source, 'nickname')
  return {
    jwt,
    organizationCode: readString(source, 'organizationCode') ?? '',
    ...apiKey === undefined ? {} : { apiKey },
    ...apiKeyExpiresAt === undefined ? {} : { apiKeyExpiresAt },
    ...refreshToken === undefined ? {} : { refreshToken },
    ...refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt },
    ...phone === undefined ? {} : { phone },
    ...nickname === undefined ? {} : { nickname },
  }
}

/**
 * 凭据指纹（**按 jwt 算**）—— 用于「同一账号是否已存在」的判重。
 *
 * ⚠️ 不能用 `apiKey`：它 2 小时一换，会把同一个账号认成新账号。
 * jwt 的 payload 在 30 天内稳定（`refresh` 不改它）。
 */
export function magicrewCredentialFingerprint(jwt: string): string {
  if (typeof jwt !== 'string' || jwt.length === 0) return ''
  return createHash('sha256').update(jwt).digest('hex').slice(0, 16)
}

/**
 * 展示昵称：**上游昵称 → 手机号脱敏（`130****2222`） → 渠道名**。
 *
 * ## ⚠️ 优先级为什么是这个顺序（真机报障 2026-10-29）
 *
 * 原先只有后两条腿，而**浏览器登录**（本机浏览器导入 / 网页版登录）落库的凭据里
 * **没有 `phone`** ⇒ 卡片恒显示 `product.displayName`（=「超级麦吉」），
 * 而用户自己的昵称是 `Nick`（上游 `/api/v1/contact/accounts/me/users` 实测返回）。
 * ⇒ 登录时把昵称写进凭据（{@link MagicrewAuthOptions.profileFetcher}），这里优先用它。
 *
 * ## ⚠️⚠️ 向后兼容是硬约束：老凭据（无 `nickname`）必须逐字节不变
 *
 * 老凭据没有 `nickname` ⇒ 第一腿不成立，后两腿的判据与顺序**一字未改**：
 * 11 位手机号仍出脱敏号、其余仍回落 `displayName`。这个「老凭据」格是本次改动
 * 最重要的用例（改坏它 = 所有存量账号的卡片一起变样）。
 *
 * ⚠️ 昵称判据用 `trim()` 只为**判空**（全空白不算昵称），返回值**原样**给出去 ——
 * 上游昵称里的空格是上游的事，展示层不替它改写。
 */
export function magicrewDisplayNickname(
  credential: MagicrewCredential,
  product: MagicrewProduct = MAGICREW,
): string {
  const nickname = credential.nickname
  if (nickname !== undefined && nickname.trim().length > 0) return nickname
  const phone = credential.phone
  if (phone !== undefined && /^\d{11}$/.test(phone)) {
    return `${phone.slice(0, 3)}****${phone.slice(7)}`
  }
  return product.displayName
}

/**
 * 账号卡片上「有效期」该取哪个时刻（`undefined` = 如实显示「未知」）。
 *
 * ## 判据
 *
 * 1. `apiKeyExpiresAt` 有值 ⇒ 用它（精确，且续期成功后被不断刷新）；
 * 2. 否则用 **JWT 的 `exp`**（本家**登录会话**的寿命，实测 30 天、可离线解出）；
 * 3. 都拿不到 ⇒ `undefined`（**不编造** —— 卡片如实显示「未知」，不写 0/NaN）。
 *
 * ## ⚠️⚠️ 为什么不能只取 `apiKeyExpiresAt`（真机报障：卡片「有效期 未知」）
 *
 * `mgw_` key 只有 **2 小时**且会自动续期，而**浏览器登录**落库的凭据里
 * **根本没有 `apiKeyExpiresAt` 这个字段**（实测 `~/.dsh/.credentials.yaml` 只有
 * `apiKey`/`jwt`/`organizationCode`/`refreshToken`）⇒ `account.create` 写池时那一格
 * 是 `{}` ⇒ 卡片恒显示「未知」。
 *
 * ⚠️ 反过来也不能只用 JWT exp：JWT 过期（30 天）之后 `refresh_token` 仍可能有效，
 * `apiKeyExpiresAt` 是「更近的真相」⇒ 两条腿**各管一段**，顺序不能换。
 *
 * ⚠️ JWT 解不出来时 `jwtTimes` 返回 `exp = 0`（**不猜**）⇒ 这里同样返回 `undefined`。
 */
export function magicrewExpiresAtMs(credential: MagicrewCredential): number | undefined {
  if (credential.apiKeyExpiresAt !== undefined) return credential.apiKeyExpiresAt
  const { exp } = jwtTimes(credential.jwt)
  return exp > 0 ? exp * 1000 : undefined
}

// ── 登录与三层凭证的签发 / 续期 ──────────────────────────────────────────
//
// 本节只做**网络层**：登录换 JWT、JWT 签 `mgw_` key、refresh_token 换 key。
// 账号池侧（串行续期、写回 `expiresAt`）在文件末尾的「账号池适配层」一节（任务 3b），
// **不要**并进本节的网络层 —— 那一层是有状态的，混进来会让「纯网络原语」不再可复用。

/** 上游业务码：`1000` = ok，其余都是错误（magpie 侧实测，2026-10-28）。 */
const MAGICREW_OK_CODE = 1000

/**
 * 取账号资料（昵称）的**小超时**：6 秒。
 *
 * ⚠️⚠️ 这个值刻意**远短于** `product.requestTimeoutMs`（30 秒，业务 API 口径）：
 * 资料只用来给卡片取个昵称，而它挂在**登录**这条用户正盯着屏幕等的路径上 ——
 * 30 秒的静默等待与「点了登录没反应」同形。
 *
 * 兑现方式：调用方把 `product.requestTimeoutMs` **换成这个值**再交给
 * `fetchMagicrewProfile`（它的 `AbortSignal.timeout(product.requestTimeoutMs)` 是
 * 唯一超时出口，不为「小超时」另开一个参数 —— 两处超时门是漂移源）。
 */
export const MAGICREW_PROFILE_TIMEOUT_MS = 6_000

/**
 * 上游 UA 来自 {@link MAGICREW_USER_AGENT}（`magicrew-product.ts` 的单一定义处）。
 *
 * ⚠️ **不要在这里恢复一份字面量**（issue IKTPRV）：gateway key 与另外四腿打同一个
 * `product.host`，黑名单命中的就是那条 `.0.0.0` 假版本号 ⇒ 一处漏改就整站不可用。
 */

/**
 * 发一次请求并剥掉业务信封。
 *
 * ⚠️⚠️ **必须看业务码，不能只看 HTTP 状态**：实测用错配的 key 会得到
 * **HTTP 200 + `{"code":403,"message":"token无效"}`** —— 错误藏在 body 里，
 * 只判 `res.ok` 会把这次失败当成功，症状是「模型不回复」而日志零报错。
 *
 * ⚠️ 判据顺序是**刻意**的（先解析 → 再业务码 → 最后 HTTP 状态）：
 * 业务码优先于 HTTP 状态，否则 `200 + code:403` 这一格永远不会走到业务码那条腿。
 * 反过来「HTTP 500 + 非 JSON」也不会被误判成业务错误 —— 它在第一步就带着
 * HTTP 状态抛出可读报文（国际站实测：缺 `organization-code` 回 **22 字节裸文本**，
 * 不是 JSON，极易被误读成「网关挂了」）。
 *
 * ⚠️ 响应体**没有** `code` 键时视为「无信封」（例如裸 200 的探测响应），
 * 交给 `response.ok` 判 —— 不要凭「缺 code」直接判失败，那会把非信封端点全打死。
 */
async function magicrewCall(params: {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  fetchImpl: typeof fetch
  /**
   * 本次调用的业务超时（毫秒）。
   *
   * ⚠️ 2026-11-01 二审：原先写死 `MAGICREW.requestTimeoutMs`（= **国内站**的常量），
   * 于是**国际站**也沿用国内站的值 —— 两站当前同为 30_000 所以看不出问题，
   * 但将来任一站调整超时就会静默失效，且「两站只差一个 product 常量」这条纪律被破坏
   *（本文件是全部 auth 网络调用的唯一出口 ⇒ 它一错，登录/签发/续期三条腿一起错）。
   * ⇒ 由调用方按 `product.requestTimeoutMs` 显式传入。
   */
  timeoutMs: number
}): Promise<unknown> {
  const response = await params.fetchImpl(params.url, {
    method: params.method,
    headers: params.headers,
    ...params.body === undefined ? {} : { body: params.body },
    /**
     * ⚠️ **超时必须有**（2026-10-29 最终审查 I5）：本函数是**全部** auth 网络调用的
     * 唯一出口（登录 / 签发 / 续期），原先零超时 ⇒ 一次挂死会让 `SerialQueue`
     * 后排队的所有账号续期一起卡住（且它在 `refreshAll` 的 per-account try 之外
     * 没有第二道闸）。其余每家 `*-credits.ts` 都有 `AbortSignal.timeout`。
     * 用 `requestTimeoutMs`（业务 API 口径）；**不要**用推理那三个超时。
     * ⚠️ 2026-11-01 二审：值改由调用方按 `product` 传入（不再写死 `MAGICREW`）。
     */
    signal: AbortSignal.timeout(params.timeoutMs),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text)
  } catch {
    throw new Error(`返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  // ⚠️ `JSON.parse('null')` 是**合法 JSON**，`null` 上取 `.code` 会抛
  //    `TypeError: Cannot read properties of null` —— 对「网关回了字面量 null」这种
  //    真实现象，原始报错既没有 HTTP 状态也没有上游原文，现场只剩一句 JS 内部错误。
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`返回的不是对象（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  const envelope = parsed as { code?: unknown, message?: unknown, data?: unknown }
  const code = typeof envelope.code === 'number' ? envelope.code : undefined
  if (code !== undefined && code !== MAGICREW_OK_CODE) {
    // ⚠️ 优先用上游原文：`token无效` 这类文案是 {@link isMagicrewApiKeyDeadError}
    //    的唯一判据，包装成「请求失败（code 403）」会把它抹掉 ⇒ 续期永远不被触发。
    const message = typeof envelope.message === 'string' ? envelope.message : `code ${code}`
    throw new Error(message)
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return parsed
}

/**
 * 拼请求头。
 *
 * ⚠️ `origin` **必须**带（网关会看它，缺了偶发 403）；`organization-code` 只在
 * 有值时带（国内站不强制，国际站缺了回 HTTP 500）。
 *
 * ⚠️⚠️ `referer` 也是**硬要求**（2026-11-04 真机二分实测，此前全仓零处下发）：
 * 同一套头（origin / authorization / organization-code / user-agent 全在）下，
 * 只差一条 `referer: <webOrigin>/` 就是 **403 空 body ⇄ 200** 的差别：
 * - `GET /api/v1/contact/accounts/me/users`：无 referer **403**，有 referer **200**
 * - `POST /api/v1/model-gateway/tokens`：无 referer **403**，有 referer **200**
 * - `GET /api/v1/quota/points/total` 与 `GET /api/v1/flows/models`：两种都 200
 *   ⇒ 只补 `origin` 不够，WAF 认的是 referer。漏了它的症状是「登录成功但昵称恒
 *   回落 displayName、gateway key 恒签发失败」两条 warn，而不是明确的鉴权错误。
 */
function magicrewHeaders(params: {
  token?: string
  organizationCode?: string
  webOrigin: string
  accept?: string
  userAgent?: string
}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: params.accept ?? 'application/json',
    'user-agent': params.userAgent ?? MAGICREW_USER_AGENT,
    // 网关会看 Origin，缺了偶发 403（magpie 侧记录）。
    origin: params.webOrigin,
    // ⚠️ 尾斜杠是照浏览器真实请求抄的；WAF 按 referer 判来源，缺了直接 403 空 body。
    referer: `${params.webOrigin}/`,
  }
  if (params.token !== undefined && params.token.length > 0) {
    headers.authorization = `Bearer ${params.token}`
  }
  if (params.organizationCode !== undefined && params.organizationCode.length > 0) {
    headers['organization-code'] = params.organizationCode
  }
  return headers
}

/**
 * 把用户输入的手机号归一成上游要的**本地号码**（纯数字，不含国家码）。
 *
 * ⚠️⚠️ 上游 `phone` 字段必须是**本地号码**（带 `+86` 前缀会登录失败，实测），
 * 国家码走独立的 `state_code`。而递进来的形态五花八门：
 * `+86 130-1111-2222`、`130 1111 2222`、`8613011112222`。
 *
 * 只做「删非数字」会得到 `8613011112222`（13 位）—— 上游按本地号码解析 ⇒ 登录失败，
 * 而错误文案只说「手机号格式错误」，看不出是插件多留了国家码。
 *
 * 判据（四条腿，每条都有独立用例钉住）：
 * 1. 删非数字后**以 `state_code` 的数字为前缀**（不是这个前缀就原样返回 ——
 *    删掉这条会把 `13011112222` 按 `86` 切掉前两位，变成 `800138000`）；
 * 2. 剥完剩下的仍是完整号码（**≥ 6 位**）—— 挡住「短号恰好以国家码开头」；
 * 3. **1 位国家码在没有显式 `+` 时不剥**：`+1` 这类单位数国家码与「本地号码首位」
 *    在语法上不可区分（`1234567890` 是本地号，还是 `1` + `234567890`？）⇒ **不猜**，
 *    宁可按本地号原样发（上游会明确报手机号格式错，可查），也不静默吃掉首位；
 * 4. 显式写了 `+` 时国家码是用户明示的（`+1 415 555 2671`）⇒ 可以直接剥。
 */
function magicrewPhoneOf(phone: string, stateCode: string): string {
  const text = String(phone ?? '').trim()
  const digits = text.replace(/[^\d]/g, '')
  const stateDigits = stateCode.replace(/[^\d]/g, '')
  if (stateDigits.length === 0 || !digits.startsWith(stateDigits)) return digits
  const rest = digits.slice(stateDigits.length)
  if (rest.length < 6) return digits
  if (text.startsWith('+') || stateDigits.length >= 2) return rest
  return digits
}

/** 签发结果（三层凭证的第 2、3 层）。 */
export interface MagicrewGatewayKey {
  readonly apiKey: string
  readonly refreshToken?: string
  readonly apiKeyExpiresAt?: number
  readonly refreshTokenExpiresAt?: number
}

/**
 * 用登录 JWT 签发一把 `mgw_` key（2 小时）。
 *
 * ⚠️⚠️ **签新 key 会吊销旧 key**（magpie 坑 #3）⇒ 本函数**只允许**在
 * 「登录成功」与「续期」两个入口调用，**绝不在热路径**（推理前）调用。
 * 热路径上签一次，正在并发的另一次请求立刻拿到死 key（症状：偶发「token无效」，
 * 而重试又能成 —— 极难复现的那种）。
 */
export async function issueMagicrewGatewayKey(params: {
  jwt: string
  organizationCode: string
  product?: MagicrewProduct
  fetchImpl?: typeof fetch
}): Promise<MagicrewGatewayKey> {
  const product = params.product ?? MAGICREW
  const fetchImpl = params.fetchImpl ?? fetch
  const parsed = await magicrewCall({
    url: `${product.host}${MAGICREW_GATEWAY_TOKENS_PATH}`,
    method: 'POST',
    headers: magicrewHeaders({
      token: params.jwt,
      organizationCode: params.organizationCode,
      webOrigin: product.webOrigin,
    }),
    body: '{}',
    fetchImpl,
    timeoutMs: product.requestTimeoutMs,
  }) as { data?: Record<string, unknown> }
  const data = (parsed.data ?? {}) as Record<string, unknown>
  const apiKey = readString(data, 'api_key')
  if (apiKey === undefined) {
    throw new Error('签发密钥失败：没有 api_key')
  }
  const refreshToken = readString(data, 'refresh_token')
  const apiKeyExpiresAt = readNumber(data, 'api_key_expires_at')
  const refreshTokenExpiresAt = readNumber(data, 'refresh_token_expires_at')
  return {
    apiKey,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...apiKeyExpiresAt === undefined ? {} : { apiKeyExpiresAt },
    ...refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt },
  }
}

/**
 * 用 refresh_token 换新的 api_key。**不需要登录态**（JWT 过期也能续）。
 *
 * ⚠️⚠️ refresh_token 是**一次性**的（每换一次就轮换）⇒ 调用方**必须串行**，
 * 并发两次会让其中一个的 token 立即失效（表现为「账号突然掉登录」，而重登又好了）。
 *
 * ⚠️ **本函数是全仓唯一持有 refresh_token 的地方**（magpie 坑 #4）：
 * 别处再存一份就会分叉。
 */
export async function refreshMagicrewKey(params: {
  refreshToken: string
  product?: MagicrewProduct
  fetchImpl?: typeof fetch
}): Promise<MagicrewGatewayKey> {
  const product = params.product ?? MAGICREW
  const fetchImpl = params.fetchImpl ?? fetch
  // ⚠️ 续期走 **PUT 且 body 只带 refresh_token**：带上 JWT 反而会在 JWT 过期时
  //    把「能续的」变成「不能续的」（这条路径的存在意义就是 JWT 已经没用了）。
  const parsed = await magicrewCall({
    url: `${product.host}${MAGICREW_GATEWAY_TOKENS_PATH}`,
    method: 'PUT',
    headers: magicrewHeaders({ webOrigin: product.webOrigin }),
    body: JSON.stringify({ refresh_token: params.refreshToken }),
    fetchImpl,
    timeoutMs: product.requestTimeoutMs,
  }) as { data?: Record<string, unknown> }
  const data = (parsed.data ?? {}) as Record<string, unknown>
  const apiKey = readString(data, 'api_key')
  if (apiKey === undefined) {
    throw new Error('续期失败：没有 api_key')
  }
  const refreshToken = readString(data, 'refresh_token')
  const apiKeyExpiresAt = readNumber(data, 'api_key_expires_at')
  return {
    apiKey,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...apiKeyExpiresAt === undefined ? {} : { apiKeyExpiresAt },
  }
}

/**
 * 判断一个错误是否是「api_key 失效」（应当续期重试，而不是判账号死）。
 *
 * ⚠️ 只判**消息文本**：上游把鉴权失败装在业务码里（HTTP 200 + `code:403` +
 * `message:"token无效"`）⇒ 状态码根本不是判据。
 *
 * ⚠️ **刻意不把 HTTP 401 / 403 塞进来**：那两类是**传输层**的失败（可能是网关抖动、
 * 出口 IP 被拦、甚至 `organization-code` 错配），把它们当成「key 失效」会触发续期
 * ⇒ 而续期**会吊销当前 key** ⇒ 一次误判就把本来能用的凭据烧掉。
 */
export function isMagicrewApiKeyDeadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /token无效|token invalid|unauthorized/i.test(message)
}

// ── 账号池适配层（任务 3b）───────────────────────────────────────────────
//
// 本节三件事：① 一次性 refresh_token 的**串行器**；② 与宿主凭据库的对接
// （⚠️ 宿主存的是**字符串** ⇒ 序列化自己做、ref 必须过 `credentialRef()`）；
// ③ 续期成功后把新 `expiresAt` **写回账号池**。

/**
 * 一个账号的**续期内存态**（per-ref，由 `MagicrewAuth.states` 强持）。
 *
 * ⚠️ 它不是凭据的副本，而是「下次该拿哪个 refresh_token 去换」的唯一答案：
 * 轮换成功后立即就地更新，因此它可能比凭据库**新**（写回还没发生/失败）。
 */
export interface MagicrewRefreshState {
  refreshToken?: string
  apiKey?: string
  apiKeyExpiresAt?: number
  /**
   * **上次写回失败时，凭据库里那条已被消费的旧 token**（`undefined` = 库与内存一致）。
   *
   * 用途有两个，都不可省：
   * 1. `stateOf` 用存储值刷新内存态时**跳过它**；
   * 2. `refreshAll` 的 lead-time 门**放行**（见 `refreshAll` 内的注释）。
   *
   * ⚠️⚠️ 为什么必须有（单向门）：refresh_token 一次性轮换。若「轮换成功 → `store.set`
   * 抛错」（磁盘满 / 凭据库被锁），内存已是新 token、存储仍是旧 token。下一轮
   * `stateOf` 若照「存储优先」把内存改回那条**上游已消费**的旧 token，续期从此
   * 必然失败 ⇒ 只能重新登录。
   *
   * ⚠️⚠️ **登记点必须跟着「写回失败」走，不能放在「轮换成功」处**：库里的值可以被
   * **别的写入方**改（备份导入 / 合并写入同一 ref / 另一实例 / 复用同一 ref 的重登），
   * 那条路径的通式是「两次瞬时失败**夹一次外部写入**」——
   * `t1` 轮换 rtA→rtB 失败（marker=rtA）→ `t2` 外部写入 rtL（`stateOf` 采纳，正确）
   * → `t3` 轮换 rtL→rtC 又失败，但「只记第一条」的守卫让 marker 仍是 rtA ⇒
   * `t4` 存储值 rtL ≠ marker rtA ⇒ 把**已消费的 rtL** 抬回内存 ⇒ 门重开。
   * 改成「失败时无条件记下**当时读到的库值**（`credential.refreshToken`）」后，
   * marker 恒与库同步：每次失败重新上膛、成功即清空 ⇒ 上面每一轮都闭合。
   */
  staleRefreshToken?: string
}

/**
 * 一次性 refresh_token 的**串行续期器**。
 *
 * ⚠️⚠️ 为什么必须串行：refresh_token **一次性轮换**（每换一次就作废旧的）。
 * 两个并发请求会拿同一个 token 去换 ⇒ 第二个必然失败，而**前一个已经把新 token
 * 写回了** ⇒ 表面上「莫名掉登录」，实际是竞态。
 *
 * ⚠️ 这里刻意做成「共享同一个 state 对象」而不是闭包变量：调用方（`MagicrewAuth`）
 * 持有那份 state，续期成功后**就地更新** `refreshToken`，下一轮才有得用。
 *
 * 并发到来时**后来的等前一个的结果**（而不是各发一次）—— `SerialQueue` 保证
 * 「同一刻只有一个 PUT 在飞」，`inFlight` 保证**同一次续期只真发一次请求**。
 *
 * ⚠️⚠️ `inFlight` **必须按 `state` 分键**（`WeakMap`），不能是一个裸变量：
 * 本实例由 `MagicrewAuth` 构造时**只创建一份**、被全部账号共用，裸变量会让
 * 「账号 A 续期中、账号 B 同时要续期」变成**B 直接拿到 A 的新 key**
 * （`fetch` 只发一次、B 的凭据被写成 A 的 `mgw_` 密钥 ⇒ 跨账号串号，
 * 症状是 B 偶发「token无效」而 A 一切正常）。同一个 `state` 才该去重。
 */
export function createMagicrewRefreshOnce(deps: {
  fetchImpl?: typeof fetch
  product?: MagicrewProduct
}): (state: MagicrewRefreshState) => Promise<MagicrewGatewayKey | undefined> {
  const queue = new SerialQueue()
  const inFlight = new WeakMap<MagicrewRefreshState, Promise<MagicrewGatewayKey | undefined>>()
  return async (state) => {
    if (state.refreshToken === undefined || state.refreshToken.length === 0) return undefined
    const pending = inFlight.get(state)
    if (pending !== undefined) return await pending
    const task = queue.run(async () => {
      // ⚠️ token 必须读在**闭包内**（排队期间可能已被前一个任务轮换掉）。
      const key = await refreshMagicrewKey({
        refreshToken: state.refreshToken!,
        ...deps.product === undefined ? {} : { product: deps.product },
        ...deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl },
      })
      // ⚠️ **就地写回**（成功才写）：失败时保留旧 token，让下一次还有机会。
      state.apiKey = key.apiKey
      if (key.apiKeyExpiresAt !== undefined) state.apiKeyExpiresAt = key.apiKeyExpiresAt
      // ⚠️ 这里**不**登记 `staleRefreshToken`：marker 的语义是「凭据库里现在放着哪条
      //    已被消费的 token」，只有**写回失败的那一刻**才知道（见其字段注释）。
      if (key.refreshToken !== undefined) state.refreshToken = key.refreshToken
      return key
    })
    inFlight.set(state, task)
    try {
      return await task
    } finally {
      inFlight.delete(state)
    }
  }
}

/** `MagicrewAuth` 的注入项（测试全套可注入）。 */
export interface MagicrewAuthOptions {
  readonly product?: MagicrewProduct
  readonly fetchImpl?: typeof fetch
  /** 告警出口；缺省走 `ctx.logger?.warn`（单测注入以便断言「不许静默」）。 */
  readonly warn?: (message: string) => void
  /**
   * 注入的凭据库。⚠️：**形状必须与宿主 `ctx.credentials` 一致**。
   *
   * 实测（`astudio-auth.ts:395-399`）它是三个方法、值是**字符串**：
   *
   * ```ts
   * resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
   * set(ref: CredentialRef, value: string): Promise<void>
   * unset(ref: CredentialRef): Promise<void>
   * ```
   *
   * ⇒ 序列化要自己做（`JSON.stringify` / `JSON.parse`），且 ref 要过
   * `credentialRef(refName)` 转一下（从 `@deepseek-ai/dsh-credentials` 导入）。
   * ⚠️ 别自己发明 `read` / `write` 两个方法名 —— 那与宿主接口不匹配，`ctx.credentials` 直接風在类型上。
   */
  readonly store?: {
    resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
    set(ref: CredentialRef, value: string): Promise<void>
    unset(ref: CredentialRef): Promise<void>
  }
  /**
   * 注入的浏览器 User Data 根目录（**单测专用**，见 `magicrew-local-browser.ts`）。
   *
   * ⚠️⚠️ 缺省时扫**真实**浏览器目录 —— 单测若不注入就会读到开发机上用户的真实
   * 登录态（用例结果随机器而变，还会泄漏真实凭据）。本字段存在的唯一目的就是
   * 「用例传临时目录」。
   */
  readonly browserRoots?: readonly string[]
  /**
   * 网页版登录的**会话工厂**（注入点，单测专用 —— 绝不真起浏览器）。
   *
   * ## ⚠️⚠️ 为什么必须是 auth 层的注入点（而不是让单测调 `startMagicrewBrowserLogin`）
   *
   * `loginViaBrowser` 是**完整的一条登录腿**（开窗 → 等用户 → 签发 key → 落库），
   * 而它最容易错的两个判据都在**外面**：① 签发的**次数**（多签一次就吊销了在用的
   * key）；② 写回的 ref（写错就是「凭据在、账号读不到」）。这两条只有把整条腿
   * 跑一遍才能断言 —— 若工厂不可注入，用例就只能真起一个浏览器窗口（本仓库已
   * 记过两次「单测弹出真实浏览器窗口」的污染）。
   *
   * ⚠️ 缺省 = `startMagicrewBrowserLogin`（真起浏览器）。**不要**把它换成
   * 「测试里也安全」的假实现：那样生产路径就再没有用例覆盖了。
   */
  readonly browserLoginFactory?: (options?: {
    product?: MagicrewProduct
    timeoutMs?: number
  }) => Promise<MagicrewBrowserLogin>
  /**
   * 账号资料（昵称）取数器 —— **注入点，单测专用**（缺省 = {@link fetchMagicrewProfile}）。
   *
   * ⚠️ 为什么需要注入：两条登录腿都会在签发 key 之后取一次昵称，而那是**第二次网络
   * 往返**。不注入的话，「取昵称成功写进凭据」「取昵称失败不挡登录且留痕」这两条
   * 判据就只能靠真发请求或靠数 fetch 调用次数来断言（后者对 URL 极其敏感）。
   *
   * ⚠️ 缺省**必须**是真的取数器（不要塞一个「测试也安全」的空实现）：昵称这条路
   * 是本任务的正题，缺省假实现会让生产路径没有用例覆盖。
   */
  readonly profileFetcher?: (params: {
    jwt: string
    organizationCode: string
    product: MagicrewProduct
  }) => Promise<MagicrewProfile>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    magicrewAuth: MagicrewAuth
  }
}

/**
 * 账号池侧的续期入口（`index.ts` 的 `auths.magicrew` 用它）。
 *
 * ## ⚠️ 四条铁律（照 `AstudioAuth` 的既有口径，全部来自真实事故）
 *
 * 1. **续期成功后必须把新 `expiresAt` 写回账号池** —— 否则凭据续好了、
 *    界面纹丝不动，用户没有任何自救手段（issue !IKIRTT）。
 * 2. **`refreshAll` 只按凭据材料过滤**：不看 `enabled`（停用只影响自动选号，
 *    与「凭据该不该保持新鲜」无关 —— 按它过滤会让停用期间的 token 一路放到失效，
 *    用户重新启用后拿到死凭据），也不看池里的 `refreshable`（那是**对账结果**，
 *    拿它当门禁会把一次瞬时失败固化成**单向门**）。
 * 3. **串行**：走 {@link createMagicrewRefreshOnce}，不要自己 `await refreshMagicrewKey`。
 * 4. ⚠️⚠️ **`refreshAll` 必须带 lead-time 过滤**（`shouldRefreshNow(apiKeyExpiresAt)`），
 *    且**只有**这一层带：本家 `mgw_` key TTL 仅 **2 小时**、调度器 **30 分钟**一轮
 *    （`src/index.ts` 的 `REFRESH_INTERVAL_MS`），无条件续期等于每 2 小时窗口
 *    **白签 4 次**，而**签新 key 会吊销旧 key**（本文件头第 1 条硬约束）⇒ 轮换瞬间
 *    在途的推理请求可能拿到刚被吊销的 key。其余轮换型 provider 同样走
 *    `src/expiry-sync.ts:112` 的 `shouldRefreshNow`。
 *    ⚠️ 但**不能**把它挪进 {@link refreshAccountCredential}：那是
 *    `account.refresh`（用户点了按钮就要刷）的入口 —— 加进去等于按钮变哑的。
 *    ⚠️ 唯一的例外是**写回失败态**（`MagicrewRefreshState.staleRefreshToken` 非空）：
 *    此时凭据库里的 `expiresAt` 是上一轮的陈旧值，按它判会把这个账号的自愈推迟到
 *    库里那个时刻进入 lead 窗口（≤1 小时）⇒ `refreshAll` 对这类账号**跳过 lead-time 门**。
 */
export class MagicrewAuth extends Service {
  readonly product: MagicrewProduct
  private readonly fetchImpl: typeof fetch
  private readonly warnImpl: ((message: string) => void) | undefined
  private readonly store: MagicrewAuthOptions['store']
  /** 注入的浏览器 User Data 根目录（单测）；`undefined` = 扫真实浏览器目录。 */
  private readonly browserRoots: readonly string[] | undefined
  /** 网页版登录的会话工厂（单测注入；缺省真起浏览器）。 */
  private readonly browserLoginFactory: NonNullable<MagicrewAuthOptions['browserLoginFactory']>
  /** 账号资料（昵称）取数器（单测注入；缺省真发一次 GET）。 */
  private readonly profileFetcher: NonNullable<MagicrewAuthOptions['profileFetcher']>
  private readonly refreshOnce: ReturnType<typeof createMagicrewRefreshOnce>
  /** 每账号一份在途状态（含最新 refresh_token）。 */
  private readonly states = new Map<string, MagicrewRefreshState>()
  /**
   * 本机浏览器腿的日志出口（**稳定引用**，见 `readLocalBrowserCreds`）。
   *
   * ⚠️ 必须走 `this.warn()`（它带 `ctx.logger?.warn?.` 兜底）而**不是**
   * `this.warnImpl`（只有单测注入时才有值）—— 用 `warnImpl` 的版本在生产里
   * 恒 `undefined`，`log` 不注入 ⇒ 只剩 `console.warn`，宿主结构化日志收不到
   *（2026-11-05 对抗审计 P1-1）。
   *
   * ⚠️ 引用必须**稳定**（类字段只建一次）：`leveldbTextForFile` 的「每文件一次」
   * 去重按日志出口身份分桶，每次 new 一个箭头函数会让去重失效（每次轮询都报）。
   */
  private readonly localBrowserLog = (message: string): void => {
    this.warn(message)
  }
  /**
   * 登录态是否活跃。`stop()` / `logout()` 置 false，**阻止在途续期回写**。
   *
   * ⚠️ 为什么必须有：续期是**异步**的（一次网络往返）。用户中途登出或插件被停用时，
   * 那个在途请求回来若照常 `store.set` + `pool.updateAccount`，就会把凭据写回
   * 一个**已被删除/已登出**的账号（症状：删了账号又「复活」，或登出后仍能调用）。
   * 照 `astudio-auth.ts` 的同款（`:429` / `:926` / `:936`）。
   */
  private active = true

  constructor(ctx: Context, options: MagicrewAuthOptions = {}) {
    const product = options.product ?? MAGICREW
    // ⚠️ 服务名 = `${product.id}Auth`（cordis 文档硬要求：id 同时是服务名）。
    super(ctx, `${product.id}Auth`)
    this.product = product
    this.fetchImpl = options.fetchImpl ?? fetch
    this.warnImpl = options.warn
    this.store = options.store
    this.browserRoots = options.browserRoots
    /**
     * ⚠️ 缺省是真起浏览器 —— **不要**在这里塞一个「测试也安全」的假实现
     * （那样生产路径就没有用例覆盖了；理由见选项上的注释）。
     */
    this.browserLoginFactory = options.browserLoginFactory
      ?? ((loginOptions): Promise<MagicrewBrowserLogin> => {
        // ⚠️ 逐项展开而**不**整个传 `{product, timeoutMs}`：`startMagicrewBrowserLogin`
        //    的选项里还有 `sessionFactory`，本层的 `loginOptions` 没有它（也不该有）。
        return startMagicrewBrowserLogin({
          ...loginOptions?.product === undefined ? {} : { product: loginOptions.product },
          ...loginOptions?.timeoutMs === undefined ? {} : { timeoutMs: loginOptions.timeoutMs },
          /**
           * ⚠️⚠️ **必须**把诊断出口接进去（真机报障 2026-10-29）：
           * 超时时那一行「CDP 与磁盘都没读到凭据（CDP 尝试 N 次 / 最后一次失败原因：…）」
           * 是下次报障时**唯一**能区分「用户没登」与「我们读的方式坏了」的东西。
           * 不接 ⇒ `deps.log === undefined` ⇒ 那行**根本不会产生**（静默）。
           *
           * 走 `warn`（不是 `info`）：它是「一次等待收口且没读到」，属于需要被看见的
           * 诊断；本仓库既有出口里 `warnImpl` 也已有单测钉住「不许静默」。
           */
          log: (message) => {
            if (this.warnImpl !== undefined) this.warnImpl(message)
            else this.ctx.logger?.warn?.(message)
          },
        })
      })
    this.refreshOnce = createMagicrewRefreshOnce({
      fetchImpl: this.fetchImpl,
      product: this.product,
    })
    /**
     * ⚠️ 缺省**真的去取**（理由见选项上的注释）。这里把 `product.requestTimeoutMs`
     * 换成 {@link MAGICREW_PROFILE_TIMEOUT_MS}（6 秒）—— 它是这条腿**唯一**的超时门
     * （`fetchMagicrewProfile` 内部只有 `AbortSignal.timeout(product.requestTimeoutMs)`
     * 一个出口）。**不要**改成再传一个 `timeoutMs` 参数：两处超时会漂移。
     */
    this.profileFetcher = options.profileFetcher ?? (profileParams => fetchMagicrewProfile({
      jwt: profileParams.jwt,
      organizationCode: profileParams.organizationCode,
      product: { ...profileParams.product, requestTimeoutMs: MAGICREW_PROFILE_TIMEOUT_MS },
      fetchImpl: this.fetchImpl,
    }))
  }

  /**
   * 给凭据补上**上游昵称**（`credential.nickname`）。
   *
   * ## 调用时机：签发 gateway key **之后**
   *
   * 两条登录腿都在这之后调它。刻意放在签发那段的 `try/catch` **外面**：昵称只需要
   * `jwt` + `organizationCode`，与「key 签发成功没有」无关 —— 放在里面会让
   * 「签发失败（网关抖动）」顺带把昵称也丢掉，而那种情况下卡片本可以显示对的名字。
   *
   * ## ⚠️⚠️ 失败**不挡登录**，但**必须留痕**
   *
   * 昵称只是展示名：取不到时卡片回落「脱敏手机号 / 渠道名」，登录本身完全不受影响。
   * 但**不许静默** —— 本仓库记过「静默停摆、功能上线起一次都没成功过」的教训
   * （本文件里 `importFromLocalBrowser` / `loginViaBrowser` 的签发失败走同一条纪律）。
   *
   * ⚠️ 代价受 {@link MAGICREW_PROFILE_TIMEOUT_MS}（6 秒）约束，不给登录加长等待。
   */
  private async withProfileNickname(
    credential: MagicrewCredential,
  ): Promise<MagicrewCredential> {
    let profile: MagicrewProfile
    try {
      profile = await this.profileFetcher({
        jwt: credential.jwt,
        organizationCode: credential.organizationCode,
        product: this.product,
      })
    } catch (error) {
      this.warn(
        '[magicrew] 读取账号资料失败（卡片昵称回落为脱敏手机号 / 渠道名，不影响登录）：'
        + String(error),
      )
      return credential
    }
    if (profile.nickname.trim().length === 0) {
      // 「取到了资料、但里面没有昵称」也是一种**未达成**（卡片仍会显示渠道名）
      // ⇒ 同样留痕，否则这一格与「压根没调」在日志里不可区分。
      this.warn('[magicrew] 账号资料里没有昵称（卡片昵称回落为脱敏手机号 / 渠道名）')
      return credential
    }
    return { ...credential, nickname: profile.nickname }
  }

  /**
   * 读本账号的**展示昵称** —— `account.list` 的自愈回填用（2026-10-30）。
   *
   * ## 为什么要有这个公开入口（而不是让 RPC 层直接调 `fetchMagicrewProfile`）
   *
   * ⚠️ 必须与登录走**同一个注入点**（{@link MagicrewAuthOptions.profileFetcher}）：
   *    ① 单测要能注入假取数器（否则「回填」那条腿只能真发网络 ⇒ 不可测）；
   *    ② 超时与告警纪律只有这一份 —— 另起一条调用链必然与登录那条分叉
   *      （本仓库「一语义一套判据」的红线）。
   *
   * ⚠️ 读不到 ⇒ `undefined`，**不抛**：回填是尽力而为，调用方（`account.list`）
   *    不该因为一个展示名取不到而让整个列表失败。
   * ⚠️ 但仍然**留痕**（与 {@link withProfileNickname} 同一条纪律：不许静默 ——
   *    本仓库记过「静默停摆、功能上线起一次都没成功过」的教训）。
   */
  async readProfileNickname(credential: {
    jwt: string
    organizationCode: string
  }): Promise<string | undefined> {
    if (credential.jwt.length === 0) return undefined
    try {
      const profile = await this.profileFetcher({
        jwt: credential.jwt,
        organizationCode: credential.organizationCode,
        product: this.product,
      })
      const nickname = profile.nickname.trim()
      if (nickname.length === 0) {
        this.warn('[magicrew] 账号资料里没有昵称（卡片昵称回落为脱敏手机号 / 渠道名）')
        return undefined
      }
      return nickname
    } catch (error) {
      this.warn(
        '[magicrew] 读取账号资料失败（卡片昵称回落为脱敏手机号 / 渠道名）：' + String(error),
      )
      return undefined
    }
  }

  /** 告警出口（`warnImpl` 优先，否则宿主 logger）。 */
  private warn(message: string): void {
    if (this.warnImpl !== undefined) this.warnImpl(message)
    else this.ctx.logger?.warn?.(message)
  }

  /**
   * 续期**指定账号**并写回账号池。
   *
   * ⚠️ `pool` 与 `accountId` **必须都传**（issue !IKIRTT 的修法）。
   */
  async refreshAccountCredential(
    refName: string,
    pool: AccountPool,
    accountId: string,
  ): Promise<void> {
    if (!this.active) return
    const credential = await this.currentCredential(refName)
    if (credential === undefined) return
    const state = this.stateOf(refName, credential)
    const key = await this.refreshOnce(state)
    if (key === undefined) return
    // ⚠️ **回来时再判一次**：`refreshOnce` 是一次网络往返，期间用户可能已登出。
    //    不判就会把凭据写回一个已删除/已登出的账号。
    if (!this.active) return
    const next: MagicrewCredential = {
      ...credential,
      apiKey: key.apiKey,
      ...key.apiKeyExpiresAt === undefined ? {} : { apiKeyExpiresAt: key.apiKeyExpiresAt },
      ...state.refreshToken === undefined ? {} : { refreshToken: state.refreshToken },
    }
    // ⚠️ 序列化在这里做（宿主只收字符串）。
    try {
      await this.storeFor()?.set(credentialRef(refName), JSON.stringify(next))
      // 写回成功 ⇒ 库里已是新 token，不存在「已消费但仍在库里」的值 ⇒ 清空 marker。
      state.staleRefreshToken = undefined
    } catch (error) {
      // ⚠️⚠️ 写回**失败** ⇒ 库里仍然是刚被消费的那条旧 token（我们一个字节都没写进去）
      //    ⇒ 就地登记它，marker 由此**恒与库同步**（每次失败重新上膛、成功即清空）。
      //    登记的是**本次调用开始时读到的库值**（`credential.refreshToken`），而不是
      //    内存里那条新 token —— 后者上游还没见过，绝不能被后续 `stateOf` 跳过。
      state.staleRefreshToken = credential.refreshToken
      throw error
    }
    // ⚠️ 必须写回：凭据续好了但界面不更新等于没修（issue !IKIRTT）。
    const expiresAt = key.apiKeyExpiresAt
    if (expiresAt !== undefined) {
      await pool.updateAccount(accountId, { expiresAt })
    }
  }

  /**
   * 批量续期该 provider 的**全部账号**（`src/index.ts` 的定时器/首轮入口）。
   *
   * ⚠️ 过滤口径见类注释第 2、4 条：**不看** `enabled` / `refreshable`，
   * **但要看 lead-time**（`shouldRefreshNow`）。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    // ⚠⚠ **`listAccountsByProvider` 返回的是同步数组，不是 Promise** ——
    //    不要 `await` 它（issue IKLPTZ：把它当 Promise 调 `.catch()` 会**恒抛 TypeError**，
    //    被逐个 try 吞成一条 warn、界面零提示）。
    //    ⚠️ 判断必须**在循环之前**：写进循环里时 for...of 早已先抛错，判据永远轮不到。
    const accounts = pool.listAccountsByProvider(this.product.id)
    for (const account of accounts) {
      const refName = account.credentialRef
      if (typeof refName !== 'string' || refName.length === 0) continue
      try {
        // ⚠️⚠️ **写回失败态必须绕开 lead-time 门**：此时凭据库里放的是**上一轮的**
        //    `expiresAt`（甚至是被刚吊销的旧 key），权威时刻只在内存
        //    (`state.apiKeyExpiresAt`)。若照常按库值判「远未到期」就会跳过 ⇒ 用死 key
        //    一路失败到库里那个陈旧时刻进入 lead 窗口（≤1 小时），且池里 `expiresAt`
        //    也没更新 ⇒ UI 仍显示有效，用户无从自救。
        //    marker 非空 = 这个账号正处在那个状态 ⇒ 必续。
        if (this.states.get(refName)?.staleRefreshToken === undefined) {
          // ⚠️⚠️ **lead-time 过滤**（类注释第 4 条）：`shouldRefreshNow` 的语义是
          //    「距过期 ≤1 小时 / 已过期 / 读不到到期时刻」才续。读不到**视为该续**
          //    （没有到期时刻的凭据不能放着烂掉）。判据用**凭据里的**时刻而非池里的
          //    `expiresAt`：池值可能因上一轮写回失败而陈旧（`expiry-sync.ts` 的既定口径）。
          const credential = await this.currentCredential(refName)
          if (credential !== undefined && !shouldRefreshNow(credential.apiKeyExpiresAt)) continue
        }
        await this.refreshAccountCredential(refName, pool, account.id)
      } catch (error) {
        // 单个账号失败不拖累其余账号。
        console.warn(`[magicrew] 续期 ${refName} 失败：${String(error)}`)
      }
    }
  }

  /** 登出：置非活跃，**阻止在途续期回写**（否则会把凭据写回一个已删的账号）。 */
  /**
   * 从本机浏览器读取已登录的凭据（**不开窗口**）。读不到 ⇒ `undefined`。
   *
   * ## 为什么需要它
   *
   * magicrew 没有 OAuth 回调：用户在自己浏览器里登录成功后，插件**收不到任何通知**
   * （那是另一个浏览器）。而凭据本来就明文躺在 Chromium 系的
   * `<User Data>/<Default|Profile N>/Local Storage/leveldb/` 里
   * ⇒ 直接读文件即可，既不用开窗口也不用让用户粘任何东西。
   *
   * ## 语义上这就是一次「登录」
   *
   * 读到 jwt 之后**签发一次 `mgw_` key**（与 {@link login} 同一条腿）：不签的话
   * 池里会出现一个「有账号、每请求都抛 `AUTH`」的幽灵条目（适配器缺 api_key 时
   * 恒抛「账号未登录或缺少 api_key」），用户只会看到「明明导入成功却不回复」。
   * 签发失败**不吞掉导入结果**（jwt 能拉目录 / 积分，api_key 可由续期或重登救回），
   * 但**不许静默** —— 走 `warn`（与 {@link login} 一字不差的纪律）。
   *
   * ⚠️ 签新 key 会吊销旧 key 是本家硬约束（模块头第 1 条）。这里等同「重新登录」，
   * 故仍在允许的范围内；但**不要在热路径上重试本方法**。
   *
   * ⚠️ 写回的 ref 是 {@link MagicrewProduct.defaultCredentialRef}（**不是**某个
   * `MAGICREW_ACCOUNT_*`）：账号 id / ref 由 `account.create` 分配，本方法只管
   * 「把这台机器上已登录的那份凭据取回来并落库」。
   */
  async importFromLocalBrowser(): Promise<MagicrewCredential | undefined> {
    const found = this.readLocalBrowserCreds()
    if (found === undefined) return undefined
    const base: MagicrewCredential = {
      jwt: found.jwt,
      organizationCode: found.organizationCode,
    }
    let credential = base
    try {
      const key = await issueMagicrewGatewayKey({
        jwt: found.jwt,
        organizationCode: found.organizationCode,
        product: this.product,
        fetchImpl: this.fetchImpl,
      })
      credential = {
        ...base,
        apiKey: key.apiKey,
        ...key.apiKeyExpiresAt === undefined ? {} : { apiKeyExpiresAt: key.apiKeyExpiresAt },
        ...key.refreshToken === undefined ? {} : { refreshToken: key.refreshToken },
        ...key.refreshTokenExpiresAt === undefined
          ? {} : { refreshTokenExpiresAt: key.refreshTokenExpiresAt },
      }
    } catch (error) {
      const message = '[magicrew] 从本机浏览器读到登录态，但签发 gateway key 失败'
        + '（先用 jwt 继续；api_key 可由续期或重新登录救回）：' + String(error)
      if (this.warnImpl !== undefined) this.warnImpl(message)
      else this.ctx.logger?.warn?.(message)
    }
    /**
     * ⚠️ 昵称在**签发之后**取（见 {@link withProfileNickname}）：浏览器登录的凭据里
     * 没有 `phone`，卡片昵称的唯一来源就是这个端点。失败只 warn，不挡登录。
     */
    credential = await this.withProfileNickname(credential)
    // ⚠️ 写回失败**不吞**：调用方（`account.create`）随后要把这个 ref 写进账号池，
    //    落库失败还建账号就是幽灵账号（池里有、凭据库没有）。
    await this.storeFor()?.set(
      credentialRef(this.product.defaultCredentialRef),
      JSON.stringify(credential),
    )
    return credential
  }

  /**
   * **网页版登录**：开一个独立 profile 的浏览器窗口 → 等用户在里面登完 →
   * 把凭据取回来（并签发一次 `mgw_` key）。
   *
   * ## 三条登录路径里的第 ② 条
   *
   * | # | 路径 | 门槛 | 方法 |
   * |---|---|---|---|
   * | ① | 本机浏览器已登录态 | 零 | {@link importFromLocalBrowser} |
   * | ② | **网页版登录（本方法）** | 低（开窗，用户自己登） | 本方法 |
   * | ③ | 手机号 + 密码 | 要密码 + 上游风控 | **已下线**（见 `jet-hub-rpc.ts`） |
   *
   * ② 存在的理由：①在「用户从没在本机浏览器登过这个站」「用户用的是另一个
   * profile」两种情形下读不到，而它与「没登录」在结果上同形；③要用户交出密码、
   * 且参考实现里那条 `phone_password` 是**零调用者**的探索代码。
   * ② 是唯一「用户看着官方页面自己登、凭据自然落盘」的路径。
   *
   * ## ⚠️⚠️ 成功后**必须**签发一次 `mgw_` key（与 ① 同一条腿）
   *
   * 本仓库适配器在 `credential.apiKey` 缺失时**恒抛** `AUTH`
   * 「超级麦吉账号未登录或缺少 api_key，请重新登录」⇒ 只落 jwt 的池条目 =
   * 「登录成功但每请求都不回复」的**幽灵账号**，用户只会以为插件坏了。
   * 派生细节逐条同 {@link importFromLocalBrowser}（签发失败**不吞掉**结果、
   * 只 warn —— jwt 能拉目录 / 积分，api_key 可由续期救回）。
   *
   * ## 返回 `undefined` 的两种情形（都**不是**错误）
   *
   * 1. 用户在 `timeoutMs` 内没登完（关掉了窗口 / 还在输密码）；
   * 2. 用户在等的时候插件被停用（{@link stop}）—— 见下面的 `isStopped` 闸门。
   *
   * ⚠️ 调用方**不得**把 `undefined` 当失败弹错：那是**正常的「还没登完」**。
   * 真正失败（浏览器起不来 / 签发网络异常）才抛错，且文案可读。
   *
   * ⚠️ `close()` 在 `finally` 里 —— 不调就会留下一个可见的浏览器窗口 + 200-400MB
   * 的进程树（`ChromiumSession.dispose()` 里那套 `taskkill /T` 才是唯一正确的收法）。
   */
  async loginViaBrowser(options?: { timeoutMs?: number }): Promise<MagicrewCredential | undefined> {
    const timeoutMs = options?.timeoutMs ?? MAGICREW_BROWSER_LOGIN_TIMEOUT_MS
    /**
     * ⚠️ 会话在 `try` **外面**声明：`finally` 里要能拿到它。
     * ⚠️ 起浏览器失败（找不到浏览器）会在这里抛 → 直接向上冒（`account.create`
     *    把它的 `browserNotFoundMessage` 原样送到用户眼前，别在这里包一层）。
     */
    let login: MagicrewBrowserLogin | undefined
    try {
      login = await this.browserLoginFactory({ product: this.product, timeoutMs })
      const found = await login.waitForCredential(timeoutMs)
      // ⚠️ **回来时再判一次**：等用户登录是**分钟级**的，期间插件可能已被停用/登出
      //    （与 `refreshAccountCredential` 里那道 `this.active` 闸门同因）。
      //    不判就会把一个已停用插件的凭据写进库 —— 之后没人续期、也没人展示它。
      if (found === undefined) return undefined
      if (!this.active) return undefined
      const base: MagicrewCredential = {
        jwt: found.jwt,
        organizationCode: found.organizationCode,
      }
      let credential = base
      try {
        const key = await issueMagicrewGatewayKey({
          jwt: found.jwt,
          organizationCode: found.organizationCode,
          product: this.product,
          fetchImpl: this.fetchImpl,
        })
        credential = {
          ...base,
          apiKey: key.apiKey,
          ...key.apiKeyExpiresAt === undefined ? {} : { apiKeyExpiresAt: key.apiKeyExpiresAt },
          ...key.refreshToken === undefined ? {} : { refreshToken: key.refreshToken },
          ...key.refreshTokenExpiresAt === undefined
            ? {} : { refreshTokenExpiresAt: key.refreshTokenExpiresAt },
        }
      } catch (error) {
        const message = '[magicrew] 网页版登录读到登录态，但签发 gateway key 失败'
          + '（先用 jwt 继续；api_key 可由续期救回）：' + String(error)
        if (this.warnImpl !== undefined) this.warnImpl(message)
        else this.ctx.logger?.warn?.(message)
      }
      /**
       * ⚠️ 与 `importFromLocalBrowser` 同一条腿、同一处时机（签发之后、落库之前）：
       * 两条登录路径都必须取昵称，漏一条就是「两条路径显示不一样」。
       */
      credential = await this.withProfileNickname(credential)
      // ⚠️ 写回失败**不吞**：调用方（`account.create`）随后要把 ref 写进账号池，
      //    落库失败还建账号就是幽灵账号（池里有、凭据库没有）。
      await this.storeFor()?.set(
        credentialRef(this.product.defaultCredentialRef),
        JSON.stringify(credential),
      )
      return credential
    } finally {
      /**
       * ⚠️⚠️ `close()` 必须在 `finally`（含**抛错**路径）：`waitForCredential` 抛错
       * 时窗口还开着，不关就是一个没人收的可见浏览器。
       * ⚠️ `close()` 本身幂等（实现里有一道 `closed` 闸门），重复调不炸。
       */
      login?.close()
    }
  }

  /**
   * 读本机浏览器里的凭据（纯读，无网络）。
   *
   * ⚠️⚠️ **先试网页 origin、再试 API host**：localStorage 的 key 是
   * `_https://<origin>\x00\x01<name>`，而 magicrew 的网页在 `www.letsmagic.cn`、
   * API 在 `i-magic-service.letsmagic.cn`（`product.host`）—— 用户登录发生在
   * **网页**那个 origin 上 ⇒ 只按 `product.host` 找会**恒读不到**（且完全静默）。
   * 两个都试，谁命中用谁。
   */
  private readLocalBrowserCreds(): ReturnType<typeof readMagicrewLocalCreds> {
    /**
     * ⚠️ `log` 必须**透传**（2026-11-05 返工自查）：`leveldbTextForFile` 的
     * 「解析失败 warn 一次」若只走它自己的默认 `console.warn`，宿主注入的
     * `warn`（`ctx.logger.warn`）就永远收不到 ⇒ 生产里是「有日志但进不了宿主
     * 日志系统」，单测也断言不到 —— 那就是**假修**。
     */
    const options: MagicrewLocalBrowserOptions = {
      ...this.browserRoots === undefined ? {} : { roots: this.browserRoots },
      log: this.localBrowserLog,
    }
    for (const hostname of this.localBrowserHostnames()) {
      const found = readMagicrewLocalCreds(hostname, options)
      if (found !== undefined) return found
    }
    return undefined
  }

  /** 候选站点 host（网页 origin 优先，见 {@link readLocalBrowserCreds}）。 */
  private localBrowserHostnames(): string[] {
    const hostnames: string[] = []
    for (const url of [this.product.webOrigin, this.product.host]) {
      try {
        const hostname = new URL(url).hostname
        if (hostname.length > 0 && !hostnames.includes(hostname)) hostnames.push(hostname)
      } catch {
        // product 常量写成非法 URL ⇒ 跳过（不要静默去扫一个错的站点）。
      }
    }
    return hostnames
  }

  async logout(): Promise<void> {
    this.active = false
  }

  /** 插件被停用时调用（与 {@link logout} 同因）。 */
  stop(): void {
    this.active = false
  }

  /**
   * 拉目录（供适配器注入 `fetchRemoteModels`）。
   *
   * ⚠️ 任务 3b 刻意省略过它（当时 `magicrew-catalog.ts` 还不存在），4a 该文件已落地
   * ⇒ 4d 加回。**参数是显式的 `jwt` + `organizationCode`**（不是「读当前凭据」）：
   * 目录是**按账号**下发的，调用方必须能指定用哪个账号的 jwt；这也让单测可以
   * 完全不碰凭据库（零真实凭据）。
   *
   * ⚠️ 动态 `import()` 是刻意的：`magicrew-catalog.ts` 只在**真的拉目录**时才需要，
   * 而本文件在插件启动路径上。
   */
  async fetchCatalogModels(jwt: string, organizationCode: string) {
    const { fetchMagicrewCatalogModels } = await import('./magicrew-catalog.js')
    return await fetchMagicrewCatalogModels({
      jwt, organizationCode, product: this.product, fetchImpl: this.fetchImpl,
    })
  }

  /** 读当前凭据（账号池未提供 ref 时用默认 ref）。 */
  async currentCredential(refName?: string): Promise<MagicrewCredential | undefined> {
    const name = refName ?? this.product.defaultCredentialRef
    const store = this.storeFor()
    if (store === undefined) return undefined
    try {
      const resolved = await store.resolve(credentialRef(name))
      if (resolved === undefined || resolved === null) return undefined
      // ⚠️ 宿主存的是**字符串** ⇒ 序列化要自己做；解析失败当“无凭据”而不报错。
      return parseMagicrewCredential(JSON.parse(resolved.value))
    } catch {
      return undefined
    }
  }

  /** 凭据库：注入的替身优先，否则用宿主 `ctx.credentials`（与 `astudio-auth.ts:451` 同款）。 */
  private storeFor(): MagicrewAuthOptions['store'] | undefined {
    if (this.store !== undefined) return this.store
    const ctx = this.ctx as unknown as { credentials?: MagicrewAuthOptions['store'] }
    return ctx.credentials
  }

  /** 取（或建）某 ref 的续期状态 —— 让最新 refresh_token 在内存里只有一份。 */
  private stateOf(refName: string, credential: MagicrewCredential): MagicrewRefreshState {
    const existing = this.states.get(refName)
    if (existing !== undefined) {
      // 凭据里的更新（比如刚登录）优先覆盖内存态
      // ⚠️ **例外**：那条 token 若正是「上次轮换掉、但因写回失败仍留在库里」的旧值，
      //    覆盖它就是把**已被上游消费**的 token 再抬回来 ⇒ 后续每轮续期都失败，
      //    单向门（只能重新登录）。这不是理论风险：`store.set` 抛错即可达。
      //    判据见 {@link MagicrewRefreshState.staleRefreshToken}。
      if (credential.refreshToken !== undefined
        && credential.refreshToken !== existing.staleRefreshToken) {
        existing.refreshToken = credential.refreshToken
      }
      return existing
    }
    const created: MagicrewRefreshState = {
      ...credential.refreshToken === undefined ? {} : { refreshToken: credential.refreshToken },
      ...credential.apiKey === undefined ? {} : { apiKey: credential.apiKey },
      ...credential.apiKeyExpiresAt === undefined ? {} : { apiKeyExpiresAt: credential.apiKeyExpiresAt },
    }
    this.states.set(refName, created)
    return created
  }
}
