/**
 * MonkeyCode 协议原语：凭据形状、过期判据、鉴权头、错误分类。
 *
 * 本文件**不发请求、不碰存储**，只做纯函数 —— 便于单测直接驱动，
 * 也避免适配器里堆满与传输无关的判断。
 *
 * ## 鉴权：只有一种（OhMyAgent 网关）
 *
 * 除 `x-api-key: oma_…` 外，**必须**额外带
 * `X-OhMyAgent-Signature: v1=<hex HMAC-SHA256(signing_secret, prompt)>`。
 * 缺签名或签名错 ⇒ `403 {"error":"invalid ohmyagent request"}`。
 *
 * ⚠️ **签名覆盖的是「prompt 文本」，不是整个请求体**。这意味着**改了 payload
 * 就必须重算签名** —— 所以本模块不缓存签名，而是让调用方在**序列化完成之后**
 * 把 body 传进来（{@link monkeycodeHeaders} 的 `body` 参数）。早期版本在
 * `buildPayload` 之前就构造 headers，结果 body 一改签名即失效、报 403 且文案
 * 只有一句 `invalid ohmyagent request`，极难定位。
 *
 * ⚠️ 签名算法是**公开的**（`backend/biz/llmproxy/ohmyagent_prompt.go` 开源）：
 * `"v1=" + hex(HMAC-SHA256(signing_secret, prompt))`，十六进制小写，中间没有空格。
 *
 * ## 过期：**几乎恒不过期**
 *
 * 网关凭据是**长期静态材料**（登录后由平台签发），没有 refresh 端点，
 * 也没有 `expires_at`。故 {@link isMonkeycodeExpired} 对「无过期时间」
 * **恒返回 false**，与 qiniu 同口径：把「未知」当成「已过期」会让刚登录的
 * 账号立刻被判死。
 *
 * @module src/monkeycode.ts
 */

import { createHmac } from 'node:crypto'

import { MONKEYCODE, type MonkeycodeProduct } from './monkeycode-product.js'

/**
 * MonkeyCode 凭据。
 *
 * ⚠️ 主键字段必须叫 **`access_token`**（SPEC §7 契约）：Jet Hub 的账号列表、
 * 凭据面板与 `parse*Credential` 的通用校验都按这个名字取。改成 `api_key`
 * 能编译通过、类型全绿，但面板会显示「凭据不完整」且无法测活 —— 静默失效。
 */
export interface MonkeycodeCredential {
  /** 主键：网关 `oma_…`（36 位）。 */
  access_token: string
  /**
   * 网关签名密钥（48 位）。
   *
   * ⚠️ **必须有**，否则每个请求都 403。它由浏览器登录后的
   * `POST /api/v1/users/api-keys` 与 `api_key` 一起签发。
   */
  signing_secret?: string
  /** 展示名（登录后可用平台昵称）。 */
  nickname?: string
  /**
   * 过期时间，**毫秒字符串**。
   *
   * ⚠️ 本仓库契约：`expires_at` 一律毫秒。若上游给秒，必须在**写入处**
   * 一次性归一化（`> 1e12 ? 原值 : 原值 * 1000`），不要在读取处再乘。
   */
  expires_at?: string
  /**
   * 平台会话 cookie（`monkeycode_ai_session`）。
   *
   * ⚠️ **与推理通道完全解耦**：额度 / 积分 / 订阅 / 签到都只能用 cookie 认证
   * （API Key 实测 401）。没这个字段时推理照常可用，只是面板上查不到额度、
   * 也不能签到 —— 必须**优雅降级**，不能让整个账号不可用。
   */
  session_cookie?: string
  /**
   * 平台用户 id（`/api/v1/users/status` 的 `data.user.id`）。
   *
   * ⚠️⚠️ **不是**兑换 Key 响应里的 `id`（那是「每签发一把 Key 就变」的记录 id，
   * 2026-11-03 实测同一账号两次兑换得到两个不同值）。用途有两条，都要求稳定：
   * ① 浏览器登录判重（否则同账号每登一次多一张卡）；② 邀请链接 `?ic=<id>`。
   * 取不到时**省略本字段**（宁可跳过判重，也不要用会漂的值误并账号）。
   */
  user_id?: string
}

/**
 * `expires_at` → 毫秒时间戳。
 *
 * ⚠️ 三条防御都是**实测踩过的形状**：`expires_at` 可能是字符串也可能缺失；
 * 上游偶发给秒；空串/`0`/非有限值都表示「没有这个信息」而非「1970 年过期」。
 */
export function monkeycodeCredentialExpiresAtMs(
  credential: Pick<MonkeycodeCredential, 'expires_at'>,
): number | undefined {
  const raw = credential.expires_at
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  // ⚠️ 秒/毫秒归一化**只在这里做一次**（本仓库 AGENTS.md 的「一处归一化」）。
  return parsed > 1e12 ? parsed : parsed * 1000
}

/**
 * 凭据是否已过期。
 *
 * ⚠️ **没有 `expires_at` 时恒 `false`**：网关 key 是长期静态材料，
 * 「不知道什么时候过期」不等于「已经过期」。反过来写会让每个刚登好的 key
 * 立刻被判死、且在面板上显示为「已过期」——qiniu 有过同型事故。
 */
export function isMonkeycodeExpired(
  credential: Pick<MonkeycodeCredential, 'expires_at'>,
): boolean {
  const expiresAt = monkeycodeCredentialExpiresAtMs(credential)
  if (expiresAt === undefined) return false
  return expiresAt <= Date.now()
}

/**
 * 是否支持自动续期。**恒 `false`**。
 *
 * ⚠️ 这是**诚实标记**，不是凭据状态：上游没有任何 refresh 端点。
 * 写成 `true` 会让续期器每 30 分钟发起一次注定失败的网络请求。
 */
export function isMonkeycodeRefreshable(): false {
  return false
}

/**
 * 账号身份（用于「池里的条目 ↔ 凭据」反查）。
 *
 * ⚠️ 用 `access_token` 本身而不是派生哈希：账号池的
 * `findAccountIdByCredential()` 按同一口径比较，两侧必须逐字节一致。
 */
export function monkeycodeIdentityOf(
  credential: Pick<MonkeycodeCredential, 'access_token'>,
): string | undefined {
  const token = credential.access_token
  return typeof token === 'string' && token.length > 0 ? token : undefined
}

/**
 * 面板展示用的打码 key（`前4…后4`）。
 *
 * ⚠️ 形状不合法时返回**空串**（调用方据此省略字段），不要返回 `'****'` ——
 * 那会让「凭据缺字段」与「凭据正常」在 UI 上看起来一样。
 */
export function maskMonkeycodeKey(apiKey: string): string {
  if (typeof apiKey !== 'string' || apiKey.length < 12) return ''
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`
}

/** 推理端点 URL。 */
export function monkeycodeMessagesUrl(product: MonkeycodeProduct = MONKEYCODE): string {
  return `${product.gatewayBaseUrl}${product.gatewayMessagesPath}`
}

/**
 * 网关签名：`v1=<hex HMAC-SHA256(signing_secret, prompt)>`。
 *
 * ⚠️ `prompt` 为空串时**仍然签名**（空串的 HMAC 是合法值）。不要在这里
 * 「为空就跳过签名」—— 那会让一个没有 system 也没有 messages 的边界请求
 * 直接 403，而不是得到一个可读的空 prompt 错误。
 */
export function monkeycodeGatewaySignature(signingSecret: string, prompt: string): string {
  const digest = createHmac('sha256', signingSecret).update(prompt, 'utf8').digest('hex')
  return `v1=${digest}`
}

/** 从内容块里取文本（string 直接返回；对象取其 `text` 字段）。 */
function textOfBlock(block: unknown): string | undefined {
  if (typeof block === 'string') return block
  if (typeof block !== 'object' || block === null) return undefined
  const text = (block as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

/** 从 Anthropic 的 `content`（string | 块数组）里取**第一块**文本。 */
function firstTextOfContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    const text = textOfBlock(block)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * 取签名用的 `prompt`。
 *
 * 取值顺序（SPEC §3，**顺序不能变**，服务端按同样的优先级取）：
 * 1. 顶层 `system`（string，或 `[{text}]` 取第一块 text）；
 * 2. 顶层 `instructions` 数组，多块按 `\n` join；
 * 3. `messages` 里首个 `role === 'system'` 的消息内容；
 * 4. `input` 里首个 `role === 'developer' | 'system'` 的消息内容。
 *
 * ⚠️ ①② 的区别是**实测出来的**：`system` 只取第一块，而 `instructions`
 * 要求**全量 join**。写成同一种处理会在 instructions 多块时签名不匹配，
 * 症状是 403 且没有任何可区分的信息。
 *
 * @returns 全部落空时返回空串（签名仍会照常计算）。
 */
export function monkeycodeSigningPrompt(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const body = payload as Record<string, unknown>

  // ① 顶层 system：string，或取数组里第一块 text。
  const system = body.system
  if (typeof system === 'string' && system.length > 0) return system
  if (Array.isArray(system)) {
    const text = firstTextOfContent(system)
    if (text !== undefined) return text
  }

  // ② 顶层 instructions：多块按 `\n` join（**不能只取第一块**）。
  const instructions = body.instructions
  if (Array.isArray(instructions)) {
    const parts = instructions
      .map((block) => firstTextOfContent(block) ?? textOfBlock(block) ?? '')
      .filter((part) => part.length > 0)
    if (parts.length > 0) return parts.join('\n')
  }

  // ③ messages 里首个 system 消息。
  const messages = body.messages
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue
      const candidate = message as { role?: unknown; content?: unknown }
      if (candidate.role !== 'system') continue
      const text = firstTextOfContent(candidate.content)
      if (text !== undefined) return text
    }
  }

  // ④ input 里首个 developer / system 消息。
  const input = body.input
  if (Array.isArray(input)) {
    for (const message of input) {
      if (typeof message !== 'object' || message === null) continue
      const candidate = message as { role?: unknown; content?: unknown }
      if (candidate.role !== 'developer' && candidate.role !== 'system') continue
      const text = firstTextOfContent(candidate.content)
      if (text !== undefined) return text
    }
  }

  return ''
}

/** {@link monkeycodeHeaders} 的选项。 */
export interface MonkeycodeHeaderOptions {
  readonly accept?: string
  /**
   * **已序列化**的请求体。
   *
   * ⚠️ 必须传它才能算网关签名；不传时签名基于空串（会 403）。
   */
  readonly body?: string
  readonly product?: MonkeycodeProduct
}

/**
 * 解析已序列化的请求体；失败返回 `undefined`。
 *
 * ⚠️ 不抛错：body 是我们自己序列化出来的，理论上是合法 JSON。真解析失败时
 * 让签名退化成「空 prompt 的签名」并照常发请求，比在这里抛一个
 * `SyntaxError`（调用方拿不到原始 body 上下文）更好定位。
 */
function parseBodyQuietly(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/**
 * 构造请求头。
 *
 * ⚠️ 网关签名**必须**基于最终 body 计算，所以调用顺序是
 * `序列化 → 传 body 进来 → 发请求`。三次重复这样写很别扭，但比缓存一个
 * 「签名对不上」的旧值安全得多（见模块头）。
 */
export function monkeycodeHeaders(
  credential: MonkeycodeCredential,
  options: MonkeycodeHeaderOptions = {},
): Record<string, string> {
  const product = options.product ?? MONKEYCODE
  // ⚠️ 大小写：Anthropic 协议头是大小写不敏感的，但网关的签名头实测要求
  // 保留 `X-OhMyAgent-Signature` 这个写法（全小写也接受，为可读性保留原样）。
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: options.accept ?? 'text/event-stream',
    'anthropic-version': product.anthropicVersion,
    'x-api-key': credential.access_token,
  }

  const secret = credential.signing_secret
  if (typeof secret !== 'string' || secret.length === 0) {
    // ⚠️ 这里**不抛错**（headers 是纯函数，抛错会让调用方丢掉「已构造好的
    // 请求」上下文）。缺 secret 的诊断由适配器在发请求前给出可读错误。
    return headers
  }
  const prompt = options.body === undefined ? '' : monkeycodeSigningPrompt(parseBodyQuietly(options.body))
  headers['X-OhMyAgent-Signature'] = monkeycodeGatewaySignature(secret, prompt)
  return headers
}

/**
 * 失败分类。
 *
 * ⚠️ 这个分类**只影响「要不要换号 / 要不要写冷却」**，不影响抛给用户的错误码
 * （那是适配器的事）。四个值的语义：
 * - `quota`：402 或文案含「积分已耗尽」⇒ 这个号今天已经没钱了；
 * - `rate`：429；
 * - `auth`：401 / 403（含网关签名错与 basic 账号访问 pro 前缀）；
 * - `server`：5xx（且正文里没有额度/限流字样）⇒ 上游侧故障，换号可能成功；
 * - `other`：其余（4xx 参数错、网络错）—— 换谁都一样错。
 */
export type MonkeycodeFailureClass = 'quota' | 'rate' | 'auth' | 'server' | 'other'

/**
 * 按 HTTP 状态 + 响应正文分类。
 *
 * **判定顺序**：先看状态码（402/429/401/403 这四个含义明确）→ 再看文案
 * （兜住「状态码被网关改写成 5xx、正文仍是额度文案」）→ 最后才按 5xx 归
 * `server` / 其余归 `other`。
 *
 * ⚠️ 402 的正文是纯文本 `积分已耗尽，调用失败`，而 403 的正文是 JSON
 * `{"error":"invalid ohmyagent request"}` —— 这两类靠状态码判最稳，文案只做兜底。
 */
export function classifyMonkeycodeFailure(
  errorText: string,
  status: number,
): MonkeycodeFailureClass {
  if (status === 402) return 'quota'
  if (status === 429) return 'rate'
  if (status === 401 || status === 403) return 'auth'
  /**
   * ⚠️ 5xx 单独成类（2026-11-02 复审发现）：原先一律落 `other` ⇒ 适配器
   * 「`other` 换号也没用」直接抛，第二个账号**永不尝试**；对外又是 `SERVER`
   * （可重试）⇒ 上层重试 5 次时每轮都只打同一个账号、且不写冷却
   * （与 qoder 504 主导形态逐字同型）。
   * 5xx 是**上游/网关侧**故障，换一个账号（甚至换一个站点）完全可能成功。
   */
  const text = errorText.toLowerCase()
  if (text.includes('积分已耗尽') || text.includes('额度已耗尽')) return 'quota'
  if (text.includes('insufficient') || text.includes('quota')) return 'quota'
  if (text.includes('rate limit') || text.includes('too many requests')) return 'rate'
  /**
   * ⚠️ 5xx 排在**文案匹配之后**（2026-11-02 二审 C🟡-1）：本函数开头那句注释
   * 明确写着「文案匹配用来兜住『状态码被网关改写成 500 但正文仍是额度文案』」——
   * 而 5xx 分支若排在前面，这个兜底**恒不可达**：此类响应会被判 `server`
   * （仍会换号，但不写冷却），对外错误码也变成 `SERVER` 而不是 `QUOTA_EXCEEDED`。
   * 现在先认文案，认不出来才按 5xx 归 `server`。
   */
  if (status >= 500) return 'server'
  return 'other'
}

/** 是否值得换一个账号重试（`other` 换号也没用，参数错换谁都错）。 */
export function shouldRotateMonkeycodeAccount(failureClass: MonkeycodeFailureClass): boolean {
  return failureClass === 'quota'
    || failureClass === 'rate'
    || failureClass === 'auth'
    || failureClass === 'server'
}

/**
 * 是否给该账号写模型级冷却。
 *
 * ⚠️ `auth` **不写**冷却：它往往是「这个 key 过期/贴错」这种需要人介入的状态，
 * 写 24 小时冷却会让用户改好 key 之后仍然要等冷却结束（与 minimax 同口径）。
 */
export function recordsMonkeycodeRateLimit(failureClass: MonkeycodeFailureClass): boolean {
  return failureClass === 'quota' || failureClass === 'rate'
}
