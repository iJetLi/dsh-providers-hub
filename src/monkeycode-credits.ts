/**
 * MonkeyCode 的**平台侧读数**：积分余额 / 每日额度 / 订阅档位 / 每日签到。
 *
 * ## 为什么这些读数走「平台 API + 网页会话」，而不是走推理用的 API Key
 *
 * MonkeyCode 有**两套完全不同的凭据**：
 *
 * | 用途 | 凭据 | 认证方式 |
 * |---|---|---|
 * | 推理（Anthropic Messages） | 白泽 `sk-…` / 网关 `oma_…` + `signing_secret` | `x-api-key` / HMAC 签名头 |
 * | 余额 / 额度 / 签到 | 网页登录态 `monkeycode_ai_session==…` | **Cookie** |
 *
 * 平台的 `/api/v1/users/*` 系列**不接受 API Key**（实测带 `x-api-key` / `Authorization`
 * 一律 401），只认网页 Cookie。这与 modelscope / codely 那种「同一个 Key 既能推理
 * 又能读余额」的形态不同，故 `MonkeycodeCredential` 里额外有 `session_cookie`。
 *
 * ⚠️ 因此本模块的每个入口都**必须先判 `session_cookie` 是否配置**：
 * 「没配会话」和「会话失效」是两件事，用户动作也不同（去补会话 vs 去重新登录）。
 * 把前者报成后者会让人以为自己的 Cookie 坏了。**绝不抛错**，一律降级成
 * 一句能行动的说明（`fetchBalanceDetailed` 的 `error` / `ClaimOutcome` 的 `failed`）。
 *
 * ⚠️ 「补会话」的主路径是「浏览器登录」，不是手工粘贴：该 cookie 是 **HttpOnly**，
 * `document.cookie` 读不到（四审自查修正了本段原写的「去粘贴」）。
 *
 * ## 计费口径（为什么余额要除以 1000）
 *
 * 平台下发的 `balance` 单位是**千分之一积分**（网页前端也是 `/1000` 显示），
 * 直接用会显示成「12500 积分」而实际是 12.5 —— 差三个数量级。换算只在本模块
 * 做一次，`CreditBalance.total` 一律是**积分**（`unit: 'credit'`）。
 *
 * `daily_token_balance` / `daily_token_limit` 是**计费 token**（`unit: 'token'`），
 * 与积分**不可互相折算** —— 计费 token 的折算规则见 `SPEC-monkeycode-provider.md`：
 * `(input + cache_read + 10 × output) × 1.5`，额度耗尽后按 `1 积分 = 5000 计费 token`
 * 转扣积分。⚠️ 但那是**上游的扣费规则**，本模块**不参与换算**，只如实回传两个读数
 * ——前端按单位分组并列显示（`credits-format.js` 的 `normalizeUnit`），
 * 跨量纲求和会让「12.5 积分 / 800 万 token」变成一个没有意义的数字。
 *
 * ## 每日签到：为什么要在本地解 PoW
 *
 * 签到接口要先过一道**人机验证**（captcha），但它不是图形码，而是
 * 「挑战 → 本地求解 → 兑换」的 proof-of-work：
 *
 *     POST /api/v1/public/captcha/challenge  → { token, challenge: { c, s, d } }
 *     （本地求解 c 道题，约 0.1s）
 *     POST /api/v1/public/captcha/redeem     → { token: '<8hex>:<15hex>', success }
 *     POST /api/v1/users/wallet/checkin      { captcha_token: <上一步的 token> }
 *
 * 求解算法见 {@link solveChallenge}（与平台前端逐字节同构，`fnv1a32` 派生 PRNG +
 * SHA-256 前缀碰撞）。⚠️ 这里是**纯计算**，没有任何规避行为：题目就是让你算的，
 * 网页版也是浏览器里算。
 *
 * @module src/monkeycode-credits.ts
 */

import {
  prng,
  readCapChallenge,
  readCapToken,
  solveChallenge,
  solveChallengeYielding,
} from './cap-pow.js'
import type { CheckinStatus, ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'
import {
  MONKEYCODE,
  MONKEYCODE_PLAN_DAILY_LIMIT,
  type MonkeycodeProduct,
} from './monkeycode-product.js'
import { MONKEYCODE_SESSION_COOKIE_NAME } from './monkeycode-browser-login.js'
import { normalizeSessionCookie } from './session-cookie.js'
import type { MonkeycodeCredential } from './monkeycode.js'
import type { RpcCreditsBalanceExtra } from './types.js'

// 求解器仍从本模块公开导出（既有单测与调用方按这个路径 import）。
export { prng, solveChallenge, solveChallengeYielding }

/** 订阅档位。只认这三个值，其余一律当「档位未知」（不猜）。 */
export type MonkeycodePlan = 'basic' | 'pro' | 'ultra'

/** 档位短标签（面板只放得下一个词，`extra.accountTier.label` 用它）。 */
const PLAN_LABELS: Readonly<Record<MonkeycodePlan, string>> = Object.freeze({
  basic: 'Basic',
  pro: 'Pro',
  ultra: 'Ultra',
})

/**
 * 平台请求的可注入依赖。
 *
 * ⚠️ `fetchImpl` 是给单测用的：本仓的红线是「单测不许发真网络」。
 * 生产不传 ⇒ 用全局 `fetch`（与其余 provider 的 credits 模块同形）。
 */
export interface MonkeycodeCreditsDeps {
  readonly fetchImpl?: typeof fetch
  /** 非致命问题（如订阅档位读取失败）的提示出口。 */
  readonly warn?: (message: string) => void
}

/** 平台请求的统一结果（成功带解析后的 JSON，失败带**可读原因**）。 */
type PlatformResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string }

/**
 * 把凭据里的 `session_cookie` 归一成可以直接放进 `Cookie` 头的字符串。
 *
 * ⚠️ 用户可能粘贴整串 `a=1; b=2`，也可能只粘贴值的片段。两种情况都要能用：
 * - 已含 `=` ⇒ 视为完整 cookie 串，原样（去掉首尾空白）使用；
 * - 不含合法 cookie 名 ⇒ 视为裸值，补上平台会话 cookie 名前缀。
 *
 * 若用户从 DevTools 里连 `cookie:` 一并复制过来，先剥掉这个前缀 ——
 * 否则发出去的会是 `Cookie: cookie: xxx`，服务端只会当未登录。
 *
 * ⚠️ **2026-11-02 四审 G-3**：实现已抽到 `src/session-cookie.ts`
 *    （与百智云共用一份），这里只留**参数**（cookie 名列表 + 兜底名）。
 *    此前本文件里还留着一份**逐字重复**的本地副本，且
 *    `import { normalizeSessionCookie }` 进来后**零使用**（死 import）
 *    —— 「已消除两家漂移」当时只落了一半。
 */
function normalizeCookie(raw: string): string | undefined {
  return normalizeSessionCookie(raw, [MONKEYCODE_SESSION_COOKIE_NAME], MONKEYCODE_SESSION_COOKIE_NAME)
}

/** 从凭据里取归一化后的 cookie；没有则 `undefined`（调用方据此给「未配置会话」）。 */
function cookieOf(credential: MonkeycodeCredential | undefined): string | undefined {
  if (credential === undefined || credential === null) return undefined
  const raw = credential.session_cookie
  if (typeof raw !== 'string') return undefined
  return normalizeCookie(raw)
}

/**
 * 平台 REST 请求头。
 *
 * ⚠️ 带 `referer` / `user-agent` 只是「尽量与网页同形」的保守选择 ——
 * 平台是普通 SPA + REST，没有证据表明它强制校验这两项；但缺失时被边缘 WAF
 * 拦掉的概率更高，而签到是**写操作**，失败一次就少一天的量。
 * 若将来实测发现不需要，**删掉即可**（没有逻辑依赖它们）。
 */
function platformHeaders(cookie: string, product: MonkeycodeProduct): Record<string, string> {
  return {
    cookie,
    accept: 'application/json',
    referer: `${product.platformBaseUrl}/`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }
}

/**
 * 把 HTTP 失败翻译成**能行动**的中文原因。
 *
 * ⚠️ 401/403 是**唯一**需要单独成句的状态：它意味着 Cookie 过期，
 * 用户必须去浏览器重新登录后更新凭据；其余状态多半是瞬时的或上游改版，
 * 重贴一次 Cookie 没有用。
 */
function describeFailure(status: number, text: string): string {
  const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 200)
  const suffix = excerpt.length === 0 ? '' : `：${excerpt}`
  if (status === 401 || status === 403) {
    return `网页登录态未生效（HTTP ${status}）—— 平台接口只认已登录的会话，`
      + '请确认浏览器窗口里已经完成登录'
  }
  return `平台接口返回 HTTP ${status}${suffix}`
}

/**
 * 该失败是「会话还没生效」（401/403），而不是真的出错。
 *
 * ⚠️⚠️ 这个区分是**必需**的（2026-11-02 真机踩到）：网页登录窗口一打开，
 * `monkeycode_ai_session` **立刻**就存在（服务端下发的匿名会话），所以
 * 「读到了 cookie」绝不等于「用户已经登进去」。拿它去换 Key 必然 401；
 * 此时必须**继续等**用户真正登录，而不是当场判「会话已失效」。
 */
export function isMonkeycodeSessionExpiredError(message: string): boolean {
  return /HTTP 40[13]/.test(message) || message.includes('网页登录态未生效')
}

/** 发一个平台请求并把响应体读成 JSON（非 JSON 也带原文片段，便于诊断）。 */
async function platformRequest(
  cookie: string,
  url: string,
  init: { method: 'GET' | 'POST', body?: unknown },
  product: MonkeycodeProduct,
  deps: MonkeycodeCreditsDeps,
): Promise<PlatformResult> {
  const fetcher = deps.fetchImpl ?? fetch
  const headers = platformHeaders(cookie, product)
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await fetcher(url, {
      method: init.method,
      headers,
      ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
      signal: AbortSignal.timeout(product.catalogTimeoutMs),
    })
  } catch (error) {
    // 网络层失败（断网 / DNS / 证书）与业务失败要分开说 —— 前者重试可能有用，
    // 后者重试无用。这里只翻译成一句，调用方统一降级。
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 0, error: `平台接口请求失败：${reason}` }
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    return { ok: false, status: response.status, error: describeFailure(response.status, text) }
  }
  if (text.trim().length === 0) {
    // 成功状态但空体：某些写接口确实回 204，交给调用方判断（这里不判失败）。
    return { ok: true, data: undefined }
  }
  try {
    return { ok: true, data: JSON.parse(text) as unknown }
  } catch {
    // ⚠️ 「200 + HTML」是本仓记录过的「假 200」形态（SPA catch-all 路由）：
    // 若把原文当成功传下去，上层会以为是报文变形，排查方向直接跑偏。
    return {
      ok: false,
      status: response.status,
      error: `平台接口返回了非 JSON 响应（HTTP 200，可能是会话失效被重定向到登录页）：`
        + `${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`,
    }
  }
}

/**
 * 用**网页登录态**换到的一对网关凭据。
 *
 * ⚠️ `signingSecret` 与 `apiKey` 是**两个独立的东西**（exe 内文档原文：
 * 「顶层 api_key 是与模型无关的共享认证凭据，signing_secret 是独立的 Prompt
 * 签名凭据」）—— 少了后者，每个网关请求都会 403 `invalid ohmyagent request`。
 */
export interface MonkeycodeIssuedKey {
  /** 网关 API Key（`oma_…`，36 位）。 */
  readonly apiKey: string
  /** 请求签名密钥（48 位）。 */
  readonly signingSecret: string
  /**
   * **这把 Key 的记录 id**（诊断用）。
   *
   * ⚠️ 它**不是**平台用户 id（每次兑换都变），**不得**写入凭据的 `user_id`。
   * 稳定身份见 {@link MonkeycodeProfile.userId}。
   */
  readonly keyId?: string
  /** 签发时间（**秒**，上游原样返回；毫秒换算由调用方按契约做）。 */
  readonly createdAt?: number
}

/**
 * 用网页会话 cookie 换一对网关凭据（浏览器登录的**最后一跳**）。
 *
 * 上游是 `POST /api/v1/users/ohmyagent/api-keys`（body `{}`，Cookie 认证）：
 * 成功回 `{ id, api_key, signing_secret, created_at }`，GET 同路径是 404。
 *
 * ⚠️⚠️ **返回里的 `id` 是「这把 API Key 的记录 id」，不是平台用户 id**
 * （2026-11-03 真机取证：同一账号连续兑换两次得到 `2b37a3dd-…` 与 `0848857d-…`
 * 两个不同 id，而 `GET /api/v1/users/status` 的 `data.user.id` 恒为
 * `01a19fa3-…`）。把它当账号身份写入 `user_id` 会让「同一账号第二次浏览器登录
 * 必然被判成新账号」（每登一次多一张卡 + 多签发一把 Key）。
 * ⇒ 本函数只回 `keyId`（诊断用）；稳定的 `user_id` 必须走
 * {@link fetchMonkeycodeProfile}。
 *
 * ⚠️ **不抛错**：这与本模块其余入口同口径 —— 兑换失败只是「这次登录没拿到
 * 网关凭据」，调用方可以退回到「只有会话、没有 key」的状态（额度与签到照样能用），
 * 不该让整个账号创建失败。
 *
 * ⚠️ 兑换**每次都签发新的一对**（上游没有幂等键），所以只在登录流程里调一次，
 * 不要在续期/刷新里反复调 —— 那会在用户账号下堆一长串 key。
 */
export async function exchangeMonkeycodeSessionForKey(
  sessionCookie: string,
  deps: MonkeycodeCreditsDeps = {},
  product: MonkeycodeProduct = MONKEYCODE,
): Promise<{ readonly ok: true, readonly key: MonkeycodeIssuedKey } | { readonly ok: false, readonly error: string }> {
  const cookie = normalizeCookie(sessionCookie)
  if (cookie === undefined) return { ok: false, error: '未提供网页会话 cookie' }
  const response = await platformRequest(
    cookie,
    `${product.platformBaseUrl}${product.apiKeysPath}`,
    { method: 'POST', body: {} },
    product,
    deps,
  )
  if (!response.ok) return { ok: false, error: response.error }
  const unwrapped = unwrapEnvelope(response.data)
  if (!unwrapped.ok) return { ok: false, error: unwrapped.error }
  const value = unwrapped.value
  const readText = (input: unknown): string => (typeof input === 'string' ? input.trim() : '')
  const apiKey = readText(value.api_key)
  const signingSecret = readText(value.signing_secret)
  if (apiKey.length === 0 || signingSecret.length === 0) {
    return { ok: false, error: '平台未返回 api_key / signing_secret（上游形态可能已变）' }
  }
  const keyId = readText(value.id)
  const createdAt = readNumber(value.created_at)
  return {
    ok: true,
    key: {
      apiKey,
      signingSecret,
      ...keyId.length === 0 ? {} : { keyId },
      ...createdAt === undefined ? {} : { createdAt },
    },
  }
}

/** 平台用户资料（稳定身份 + 昵称 + 邀请链接所需的用户 id）。 */
export interface MonkeycodeProfile {
  /** 平台用户 id（`data.user.id`，同一账号恒定）。 */
  readonly userId?: string
  /** 昵称（`data.user.nickname`，作展现名用）。 */
  readonly nickname?: string
}

/**
 * 读平台用户资料：`GET /api/v1/users/status` → `data.user.{id,nickname}`。
 *
 * ⚠️ 这是**稳定账号身份**的唯一来源（浏览器登录判重、邀请链接都靠它）：
 * 兑换接口回的 `id` 是「每签发一把 Key 就变」的记录 id（见
 * {@link exchangeMonkeycodeSessionForKey} 的实测）。
 *
 * ⚠️ 失败**不抛错**：调用方拿到 `undefined` 时按「身份未知」处理（不做判重），
 * 不能让一次辅助读数把已经成功的登录判死。
 */
export async function fetchMonkeycodeProfile(
  sessionCookie: string,
  product: MonkeycodeProduct = MONKEYCODE,
  deps: MonkeycodeCreditsDeps = {},
): Promise<MonkeycodeProfile | undefined> {
  const cookie = normalizeCookie(sessionCookie)
  if (cookie === undefined) return undefined
  const result = await platformRequest(
    cookie, `${product.platformBaseUrl}${product.profilePath}`, { method: 'GET' }, product, deps,
  )
  if (!result.ok) {
    deps.warn?.(`[monkeycode] 用户资料读取失败：${result.error}`)
    return undefined
  }
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) {
    deps.warn?.(`[monkeycode] 用户资料读取失败：${unwrapped.error}`)
    return undefined
  }
  const user = unwrapped.value.user
  if (user === null || typeof user !== 'object') return {}
  const record = user as Record<string, unknown>
  const userId = typeof record.id === 'string' && record.id.trim().length > 0 ? record.id.trim() : undefined
  const nickname = typeof record.nickname === 'string' && record.nickname.trim().length > 0
    ? record.nickname.trim()
    : undefined
  return {
    ...userId === undefined ? {} : { userId },
    ...nickname === undefined ? {} : { nickname },
  }
}

/**
 * 生成**邀请链接**（上游口径：`https://<平台主机>/?ic=<平台用户 id>`）。
 *
 * 2026-11-03 从官网 bundle 逐字取证：`const g = \`https://monkeycode-ai.com/?ic=${user.id}\``
 * —— 参数名是 `ic`，值是**平台用户 id**（不是邀请码、不是 Key id），
 * 邀请记录接口是 `GET /api/v1/users/invitations?page=1&size=20`。
 *
 * ⚠️ 用户 id 缺失时返回 `undefined`，**绝不**拼一个空 `?ic=` 的链接
 * （那会让用户把无效链接发给朋友，且看起来「生成成功」）。
 */
export function monkeycodeInviteLink(
  userId: string | undefined,
  product: MonkeycodeProduct = MONKEYCODE,
): string | undefined {
  if (typeof userId !== 'string' || userId.trim().length === 0) return undefined
  try {
    return `${new URL(product.platformBaseUrl).origin}/?ic=${encodeURIComponent(userId.trim())}`
  } catch {
    return undefined
  }
}

/** 把 number | string 收敛成有限数字；其余一律 `undefined`（表示「读不到」）。 */
function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 从 `{ code, data, message }` 信封里取 `data`；`code !== 0` 视为业务失败。 */
function unwrapEnvelope(data: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (data === null || typeof data !== 'object') {
    return { ok: false, error: '平台接口返回的报文不是对象（上游形态可能已变）' }
  }
  const envelope = data as { code?: unknown, data?: unknown, message?: unknown }
  // ⚠️ 只有**明确**给出 `code` 且不为 0 才判业务失败：有的端点直接回裸对象
  //（没有 `code` 字段），把「缺 code」也判失败会让它们全部读不到。
  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    const message = typeof envelope.message === 'string' && envelope.message.trim().length > 0
      ? envelope.message.trim()
      : `业务码 ${envelope.code}`
    return { ok: false, error: `平台接口拒绝：${message}` }
  }
  const value = envelope.data !== undefined ? envelope.data : data
  if (value === null || typeof value !== 'object') {
    return { ok: false, error: '平台接口返回的 data 不是对象（上游形态可能已变）' }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/** 钱包读数（已换算成积分 / 计费 token）。 */
export interface MonkeycodeWallet {
  /** 积分余额（已从「千分之一积分」换算）。 */
  readonly balance: number
  /** 当日额度剩余（计费 token）；上游没给则为 `undefined`。 */
  readonly dailyTokenBalance?: number
  /** 当日额度上限（计费 token）；上游没给则为 `undefined`。 */
  readonly dailyTokenLimit?: number
}

/**
 * 读钱包：`GET /api/v1/users/wallet`。
 *
 * ⚠️ `balance` 缺失必须判**失败**，不得回落成 0 —— 本仓红线「绝不编造数字」，
 * 而 0 的语义是「已用光」，会让用户白白去充值。
 */
export async function fetchMonkeycodeWallet(
  credential: MonkeycodeCredential,
  product: MonkeycodeProduct = MONKEYCODE,
  deps: MonkeycodeCreditsDeps = {},
): Promise<{ ok: true; wallet: MonkeycodeWallet } | { ok: false; error: string }> {
  const cookie = cookieOf(credential)
  if (cookie === undefined) {
    return {
      ok: false,
      // ⚠️ 2026-11-02 三审 F🟡-4：这个 cookie 是 **HttpOnly**（`document.cookie` 读不到），
      //    原文案叫用户「登录后把 cookie 粘贴到该账号」是**死路**。主路径是浏览器登录；
      //    已建的账号可用账号卡片上的「改 Key」补填（弹窗有 session cookie 栏）。
      error: '未配置会话（session_cookie）—— 余额 / 额度 / 签到接口只认网页登录态，'
        + '请用「浏览器登录」添加账号；已建的账号可点卡片上的「改 Key」补填 session cookie'
        + '（只填 API Key 的账号能发消息但查不到余额）',
    }
  }
  const result = await platformRequest(
    cookie, `${product.platformBaseUrl}${product.walletPath}`, { method: 'GET' }, product, deps,
  )
  if (!result.ok) return { ok: false, error: result.error }
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) return { ok: false, error: unwrapped.error }
  const raw = unwrapped.value
  // ⚠️ 单位换算：平台下发的是**千分之一积分**（网页前端 /1000 显示）。
  // 先 `Math.round` 再除以 1000，避免 `12.345000000000001` 这类浮点尾巴。
  const milli = readNumber(raw.balance)
  if (milli === undefined) {
    return { ok: false, error: '钱包报文里没有 balance 字段（上游形态可能已变）' }
  }
  const dailyTokenBalance = readNumber(raw.daily_token_balance)
  const dailyTokenLimit = readNumber(raw.daily_token_limit)
  return {
    ok: true,
    wallet: {
      balance: Math.round(milli) / 1000,
      ...dailyTokenBalance === undefined ? {} : { dailyTokenBalance },
      ...dailyTokenLimit === undefined ? {} : { dailyTokenLimit },
    },
  }
}

/**
 * 读订阅档位：`GET /api/v1/users/subscription`。
 *
 * ⚠️ 这是**辅助**读数：读不到只影响档位标签（`Basic` / `Pro` / `Ultra`），
 * 不影响余额展示 ⇒ 失败一律 `undefined` + 一条 `warn`，绝不把整行变成错误。
 */
export async function fetchMonkeycodePlan(
  credential: MonkeycodeCredential,
  product: MonkeycodeProduct = MONKEYCODE,
  deps: MonkeycodeCreditsDeps = {},
): Promise<MonkeycodePlan | undefined> {
  const cookie = cookieOf(credential)
  if (cookie === undefined) return undefined
  const result = await platformRequest(
    cookie, `${product.platformBaseUrl}${product.subscriptionPath}`, { method: 'GET' }, product, deps,
  )
  if (!result.ok) {
    deps.warn?.(`[monkeycode] 订阅档位读取失败：${result.error}`)
    return undefined
  }
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) {
    deps.warn?.(`[monkeycode] 订阅档位读取失败：${unwrapped.error}`)
    return undefined
  }
  const raw = unwrapped.value
  const plan = typeof raw.plan === 'string' ? raw.plan.trim().toLowerCase() : ''
  if (plan === 'basic' || plan === 'pro' || plan === 'ultra') return plan
  deps.warn?.(`[monkeycode] 订阅档位是未知值 "${String(raw.plan)}"（只认 basic/pro/ultra）`)
  return undefined
}

/**
 * 把两个读数拼成 `CreditBalance`。
 *
 * ## 为什么分两个包（而不是加成一个 total）
 *
 * 积分（`credit`）与每日额度（`token`）**不可互相折算**，加起来的数字没有语义。
 * 前端的 `normalizeUnit` 会按单位**分组并列**显示（与 ZCode 的 token 同型），
 * 故这里如实给两个包；`total` 只汇总**积分**口径 —— 主行显示的就是用户真正
 * 关心的「我还有多少积分」。
 *
 * ⚠️ 两个包的 `expiredTime` / `cycleEndTime` 必须写**空串**：
 * 平台 wallet 报文只有标量余额，**没有任何到期时间或重置时刻字段**
 *（每日额度是隐式的「次日 0 点重置」，但上游不下发时刻，编一个就是编造）。
 *
 * ⚠️ 2026-11-03 合并审计更正：这里原写「这也是 monkeycode **不进**
 * `WIRED_EXPIRY_PROVIDERS` 的唯一理由」——**事实错误**。三家实际都**已接进**
 * 聚合折算（`aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS` 含 `monkeycode`
 * / `monkeycodeintl` / `baizhi`，折算原语是 `monkeycodeExpiry` / `baizhiExpiry`）。
 * 空的到期字段只影响**面板展示**；折算层用的是「有 `active && remaining > 0`
 * 的包 ⇒ `NEVER`，全空才 `UNUSABLE`」（`sharedPackageExpiry`），两者并不冲突。
 */
export function buildMonkeycodeBalance(
  wallet: MonkeycodeWallet,
  plan: MonkeycodePlan | undefined,
): CreditBalance {
  const packages: CreditPackage[] = [
    {
      name: '积分余额',
      unit: 'credit',
      remaining: wallet.balance,
      // 上游只给「当前余额」这一个数，不给「总额 / 已用」⇒ 如实让 total 等于
      // remaining、used 为 0。编一个「总额」会让面板显示「12.5 / 100」这种
      // 用户根本无法核对的数字。
      total: wallet.balance,
      used: 0,
      // 余额为 0 不等于「包失效」—— `active` 是「这部分额度还算不算数」，
      // 余额用光时它仍然是用户的账户额度（下一天/充值后继续可用）。
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
    },
  ]
  const limit = wallet.dailyTokenLimit
  const remaining = wallet.dailyTokenBalance
  // ⚠️ 只有**上限与剩余都有**才给额度包：缺剩余时把 0 当剩余会让用户以为
  // 今天已经用光了（实际可能只是上游没下发）。
  if (limit !== undefined && remaining !== undefined) {
    packages.push({
      // ⚠️ 包名**不带档位**：档位已由 `planTierExtra()` 渲染成卡片上的
      // 「账号规格」一行，这里再带一遍只会把窄标签列（`dt`）撑爆 ——
      // 而且用户在卡片上找的是「每日额度还剩多少」，不是档位名。
      // `plan` 形参保留，是为了让调用方签名稳定、也给未来「按档位显示不同
      // 上限单位」留位；当前它只影响 `planTierExtra`。
      name: '每日额度',
      unit: 'token',
      remaining,
      total: limit,
      used: Math.max(0, limit - remaining),
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
    })
  }
  return {
    // 主行口径 = 积分（token 额度不参与求和，见函数注释）。
    total: wallet.balance,
    packages,
    expiredTotal: 0,
  }
}

/** 把档位拼成 `extra.accountTier`（hover 里给出该档的每日额度上限）。 */
function planTierExtra(
  plan: MonkeycodePlan | undefined,
  wallet: MonkeycodeWallet,
): RpcCreditsBalanceExtra | undefined {
  if (plan === undefined) return undefined
  const limit = wallet.dailyTokenLimit ?? MONKEYCODE_PLAN_DAILY_LIMIT[plan]
  return {
    accountTier: {
      label: PLAN_LABELS[plan],
      title: `MonkeyCode ${PLAN_LABELS[plan]}（每日额度上限 ${limit.toLocaleString('en-US')} 计费 token）`,
    },
  }
}

/**
 * `ProviderCredits.fetchBalanceDetailed` 的实现。
 *
 * ⚠️ **必须走 Detailed 而不是 `fetchBalance`**：`fetchBalance` 的 `null` 会被共享
 * 骨架统一补一句写死的「余额查询失败」，于是「未配置会话」与「会话过期」这两种
 * **用户动作完全不同**的原因都到不了 UI —— 用户只会看到一句没用的话。
 */
export async function fetchMonkeycodeBalanceDetailed(
  credential: MonkeycodeCredential,
  product: MonkeycodeProduct = MONKEYCODE,
  deps: MonkeycodeCreditsDeps = {},
): Promise<{ balance: CreditBalance | null; error?: string; extra?: RpcCreditsBalanceExtra }> {
  const wallet = await fetchMonkeycodeWallet(credential, product, deps)
  if (!wallet.ok) return { balance: null, error: wallet.error }
  const plan = await fetchMonkeycodePlan(credential, product, deps)
  const extra = planTierExtra(plan, wallet.wallet)
  return {
    balance: buildMonkeycodeBalance(wallet.wallet, plan),
    ...extra === undefined ? {} : { extra },
  }
}

/* ------------------------------------------------------------------ *
 * 每日签到
 * ------------------------------------------------------------------ */

/** PoW 挑战（平台下发的题面）。 */
export interface MonkeycodeChallenge {
  /** 题目数（实测 50）。 */
  readonly count: number
  /** 每题 salt 的十六进制长度（实测 32）。 */
  readonly saltLength: number
  /** 每题 target 的十六进制长度（实测 3 ⇒ 期望 4096 次尝试/题）。 */
  readonly targetLength: number
}

// Cap 的 PoW 求解与题面解析统一在 `src/cap-pow.ts`（与百智云共用一份实现）。

/**
 * 读签到状态：`GET /api/v1/users/wallet/checkin` → `{ checked_in: boolean }`。
 *
 * ⚠️ 上游只给**一个布尔**，没有连续天数、没有奖励金额、没有活动期。
 * 契约要求那些字段存在，故一律如实填 0 / 空串并**在注释里说明**，
 * 绝不为了「看起来完整」编造数值。`active` 恒 `true`：拿到响应就意味着签到可用。
 */
export async function fetchMonkeycodeCheckinStatus(
  credential: MonkeycodeCredential,
  product: MonkeycodeProduct = MONKEYCODE,
  deps: MonkeycodeCreditsDeps = {},
): Promise<CheckinStatus | null> {
  const cookie = cookieOf(credential)
  if (cookie === undefined) return null
  const result = await platformRequest(
    cookie, `${product.platformBaseUrl}${product.checkinPath}`, { method: 'GET' }, product, deps,
  )
  if (!result.ok) {
    deps.warn?.(`[monkeycode] 签到状态读取失败：${result.error}`)
    return null
  }
  const unwrapped = unwrapEnvelope(result.data)
  if (!unwrapped.ok) {
    deps.warn?.(`[monkeycode] 签到状态读取失败：${unwrapped.error}`)
    return null
  }
  const checkedIn = unwrapped.value.checked_in === true
  return {
    active: true,
    todayCheckedIn: checkedIn,
    // 以下字段上游**不下发**，如实为 0 / 空串（见函数注释）。
    streakDays: 0,
    dailyCredit: 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: [],
    activityName: 'MonkeyCode 每日签到',
    themeName: 'MonkeyCode',
    endTime: '',
  }
}

/** 从签到响应里 best-effort 取「本次到账积分」；读不到返回 `undefined`。 */
function readRewardedCredit(data: unknown): number | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  // ⚠️ 只认**明确的奖励字段名**：`balance` 之类是「余额」不是「本次到账」，
  //    拿它当奖励会显示成「签到 +100积分」而实际是账户总额（本仓库红线）。
  for (const key of ['credit', 'credits', 'reward', 'reward_credit', 'amount', 'points'] as const) {
    const value = readNumber(record[key])
    if (value !== undefined && value > 0) return value
  }
  return undefined
}

/**
 * 一键签到：`challenge → 本地求解 → redeem → checkin`。
 *
 * ## 幂等与预检
 *
 * 先 `GET /wallet/checkin` 判 `checked_in`：已签则直接回 `already-claimed`
 * **不发任何写请求**。这一步既是幂等判据，也省掉一次 PoW 计算
 *（50 道题约 0.2s，纯 CPU，但没必要白发）。
 * ⇒ `provider-credits.ts` 里因此可以声明 `precheckStatus: false`：
 * 预检已在本函数内部完成，外部再查一次就是**同一端点打两遍**。
 *
 * ## 奖励金额：优先读响应，其次用「签到前后余额差」
 *
 * ⚠️⚠️ 2026-11-03 真机实测（账号 `01a19fa3…`，国内站）：上游签到接口只回
 * `{ code: 0, data: { checked_in: true } }`，**不含奖励金额**；而网页文案写死
 * 「已领取 100 积分」——那 100 是前端常量，不是接口字段。
 *
 * 原实现写死 `credit: 0` + `delayedMessage`，后果是签到成功的那次批量领取在
 * 汇总行里显示成「MonkeyCode 无账号」（`formatClaimGains` 全零返回 null），
 * 用户会以为**根本没签到**。现改为：
 * 1. 响应里真有 `credit/reward/amount` ⇒ 直接用；
 * 2. 否则读一次签到后钱包，与签到前余额求差 ⇒ 用**实测增量**（真机为 +100）；
 * 3. 两次读余额有一次失败 ⇒ 才回落 `0 + delayedMessage`（并已修客户端
 *    不再把 0 渲染成「+0积分」/「无账号」）。
 *
 * ⚠️ 差值口径的边界：签到与读余额之间若有**并发的模型调用**，差值会被扣费
 * 抵消。这只影响展示数字、不影响签到本身；拿不到正数时按第 3 条降级，绝不
 * 编造一个「100」。
 *
 * ## 为什么每一步失败都单独给文案
 *
 * 用户点「一键签到」时最需要知道的是「卡在哪一步、要不要自己动手」：
 * 题解不出来 ⇒ 上游改版（等修复）；redeem 失败 ⇒ 验证过期（重试）；
 * checkin 失败 ⇒ 上游拒绝（看原文）。全部笼统成「签到失败」等于零线索。
 */
export async function claimMonkeycodeDailyCheckin(
  credential: MonkeycodeCredential,
  product: MonkeycodeProduct = MONKEYCODE,
  deps: MonkeycodeCreditsDeps = {},
): Promise<ClaimOutcome> {
  const cookie = cookieOf(credential)
  if (cookie === undefined) {
    return {
      kind: 'failed',
      code: -1,
      // 同上：HttpOnly cookie 不能手工粘贴（F🟡-4）。
      message: '未配置会话（session_cookie）—— 签到接口只认网页登录态，'
        + '请用「浏览器登录」添加账号；已建的账号可点卡片上的「改 Key」补填 session cookie',
    }
  }
  const base = product.platformBaseUrl
  try {
    const status = await fetchMonkeycodeCheckinStatus(credential, product, deps)
    if (status !== null && status.todayCheckedIn) {
      return { kind: 'already-claimed', message: '今天已经签到过了' }
    }
    // 签到前余额（读不到不影响签到本身，只是拿不到「增量」这个口径）。
    const walletBefore = await fetchMonkeycodeWallet(credential, product, deps)

    const challengeResult = await platformRequest(
      cookie, `${base}${product.captchaChallengePath}`, { method: 'POST', body: {} }, product, deps,
    )
    if (!challengeResult.ok) {
      return { kind: 'failed', code: challengeResult.status, message: `获取签到验证题失败：${challengeResult.error}` }
    }
    // ⚠️ `platformRequest` 回的是**未解包**的原始报文（`{ code: 0, data: … }` 信封），
    //    而 `readCapChallenge` / `readCapToken` 期望的是信封里的业务对象。
    //    少了这一步，真实报文会被判成「没有 token」⇒ 签到**永远失败**，
    //    且文案指向「上游改版」，排查方向完全跑偏（本轮单测抓到的第一个真实缺陷）。
    const challengeEnvelope = unwrapEnvelope(challengeResult.data)
    if (!challengeEnvelope.ok) {
      return { kind: 'failed', code: -1, message: `获取签到验证题失败：${challengeEnvelope.error}` }
    }
    const challenge = readCapChallenge(challengeEnvelope.value)
    if ('error' in challenge) {
      return { kind: 'failed', code: -1, message: challenge.error }
    }
    // ⚠️ 用 `solveChallengeYielding`（每解完一题让出事件循环）而不是同步版本：
    //    上游调高难度时同步版本会独占宿主事件循环（见 `MAX_POW_ATTEMPTS_TOTAL`）。
    const solutions = await solveChallengeYielding(challenge.token, challenge.challenge)

    const redeemResult = await platformRequest(
      cookie,
      `${base}${product.captchaRedeemPath}`,
      { method: 'POST', body: { token: challenge.token, solutions } },
      product,
      deps,
    )
    if (!redeemResult.ok) {
      return { kind: 'failed', code: redeemResult.status, message: `提交签到验证答案失败：${redeemResult.error}` }
    }
    // 同 challenge：redeem 也带信封，先解包再读 `token`。
    const redeemEnvelope = unwrapEnvelope(redeemResult.data)
    if (!redeemEnvelope.ok) {
      return { kind: 'failed', code: -1, message: `提交签到验证答案失败：${redeemEnvelope.error}` }
    }
    const captchaToken = readCapToken(redeemEnvelope.value)
    if (captchaToken === undefined) {
      return {
        kind: 'failed',
        code: -1,
        message: '签到验证没有通过（redeem 响应里没有 token）—— 可能是验证题已过期，请重试一次',
      }
    }

    const checkinResult = await platformRequest(
      cookie,
      `${base}${product.checkinPath}`,
      { method: 'POST', body: { captcha_token: captchaToken } },
      product,
      deps,
    )
    if (!checkinResult.ok) {
      return { kind: 'failed', code: checkinResult.status, message: `签到失败：${checkinResult.error}` }
    }
    // ① 先看响应里有没有明确的奖励金额（不同版本/站点可能下发）。
    const checkinEnvelope = unwrapEnvelope(checkinResult.data)
    const responseCredit = checkinEnvelope.ok ? readRewardedCredit(checkinEnvelope.value) : undefined
    // ② 响应没给 ⇒ 用「签到前后余额差」实测（2026-11-03 真机为 +100 积分）。
    let measuredCredit: number | undefined
    if (responseCredit === undefined && walletBefore.ok) {
      const walletAfter = await fetchMonkeycodeWallet(credential, product, deps)
      if (walletAfter.ok) {
        const delta = walletAfter.wallet.balance - walletBefore.wallet.balance
        // 浮点尾数（余额按 1/1000 换算）先归整到 3 位小数，再判正负。
        const normalized = Math.round(delta * 1000) / 1000
        if (normalized > 0) measuredCredit = normalized
      }
    }
    const credited = responseCredit ?? measuredCredit
    if (credited !== undefined) {
      return {
        kind: 'claimed',
        credit: credited,
        unit: 'credit',
        streakDays: 0,
        isStreakDay: false,
      }
    }
    // ③ 两条口径都拿不到 ⇒ 如实回 0 + 说明（客户端已不会渲染成「+0积分」）。
    return {
      kind: 'claimed',
      credit: 0,
      streakDays: 0,
      isStreakDay: false,
      delayedMessage: '签到成功（上游不返回积分数量，请查看刷新后的余额）',
    }
  } catch (error) {
    // PoW 的硬上限抛错走这里：它是**可预期的**上游形态变化，不是崩溃。
    const reason = error instanceof Error ? error.message : String(error)
    return { kind: 'failed', code: -1, message: `签到失败：${reason}` }
  }
}
