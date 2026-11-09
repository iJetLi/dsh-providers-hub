/**
 * 腾讯 Marvis 的产品常量、静态目录与错误分类。
 *
 * ## 为什么目录只有一条
 *
 * 2026-11-09 在本机真实账号（QQ·Jet）上实测了 magpie-marvis 的整张槽位表：
 * 每一个槽位都能跑通推理（`hy3-preview-agent`、`claude-sonnet-4-6` 等），
 * 但**用户明确裁定只暴露 `main-auto`**——它由服务端自动路由到
 * `deepseek-v4-1-flash-261017`（响应体 `model` 字段可证），其余槽位属于
 * Marvis 自己的产品线，与本插件的「一个渠道 = 一个可预期模型」定位不符。
 *
 * ⚠️ 因此本文件**不**是「上游目录的镜像」，而是**产品决策**：
 * 想加回别的槽位要先问清楚它是不是真模型（`claude-*` 那几个在本账号下
 * 实测 **400 `4130001 无效模型id`**，即该账号根本没授权）。
 *
 * ## 为什么没有远端目录端点
 *
 * 实测 9 个候选端点全部 404（`/v1/models`、`/v3/marvis_get_models`、
 * `/v3/marvis_get_model_list`、`/v3/marvis_models`、`/v1/model/list` …），
 * 且 magpie 自己也只用静态表 ⇒ 目录**只能**静态兜底，不需要远端拉取。
 *
 * @module marvis-product
 */

import { MARVIS_BASE_URL, MARVIS_DEFAULT_CLIENT_VERSION } from './marvis.js'
import { retryAfterMsFromRecord } from './retry-after.js'

/** 产品常量。 */
export interface MarvisProduct {
  /** provider id（必须纯小写字母，`provider-registry.spec.ts` 逐条断言）。 */
  readonly id: 'marvis'
  /** 左栏展示名（必须与客户端 `PROVIDERS` 里 `marvis` 的 `label` 逐字一致）。 */
  readonly displayName: string
  /** OpenAI 兼容 base URL（**含 `/v1`**，不带尾斜杠）。 */
  readonly baseUrl: string
  /** 对话端点（拼在 baseUrl 之后）。 */
  readonly chatPath: string
  /** 钱包端点（拼在 baseUrl 之后；与推理**同 host**）。 */
  readonly balancePath: string
  /** 续期端点（拼在 baseUrl 之后）。 */
  readonly refreshPath: string
  /** 等首个 token 的空闲超时（毫秒）。 */
  readonly chatHeaderTimeoutMs: number
  /** 两次 chunk 之间的空闲超时（毫秒）。 */
  readonly chunkTimeoutMs: number
  /** 兜底目录的超时（毫秒）—— 本家无远端目录，保留字段与家族同构。 */
  readonly catalogTimeoutMs: number
  /** 钱包请求超时（毫秒）。 */
  readonly balanceTimeoutMs: number
  /** 默认凭据引用前缀。 */
  readonly defaultCredentialRef: string
}

export const MARVIS: MarvisProduct = {
  id: 'marvis',
  displayName: '腾讯 Marvis',
  baseUrl: MARVIS_BASE_URL,
  chatPath: '/v1/chat/completions',
  balancePath: '/v3/marvis_get_wallet',
  refreshPath: '/marvis_client_login/marvis_refresh_token',
  chatHeaderTimeoutMs: 60_000,
  chunkTimeoutMs: 120_000,
  catalogTimeoutMs: 15_000,
  balanceTimeoutMs: 15_000,
  defaultCredentialRef: 'MARVIS_ACCOUNT_DEFAULT',
}

/** 兜底目录条目。 */
export interface MarvisFallbackModel {
  /** 上游槽位 id（**不是**真实模型 id —— 真实 id 直传会 400）。 */
  readonly id: string
  /** 展示名（美化名）。 */
  readonly name: string
  /**
   * 上下文窗口。
   *
   * ⚠️ `0` 是「**不知道**」哨兵 ⇒ `resolveModel` 判 `> 0` 才下发 `context`。
   * 本家 magpie 表口径是 1,000,000；实测只验证到 18k（36k 汉字），
   * 但这只是「没测到上界」，不是「上界是 18k」。
   */
  readonly contextWindow: number
  readonly supportsImage: boolean
}

/**
 * 唯一的目录条目。
 *
 * ⚠️ 显示名是**产品决策**（用户要求「映射被 ds v4.1 flash 的美化名字」），
 * 不是上游下发的名字 —— 上游只回真实模型 id `deepseek-v4-1-flash-261017`。
 */
/**
 * ⚠️ **刻意不声明 `maxTokens`**（2026-11-09 评审 M4 的定案，不是遗漏）。
 *
 * magpie 的 `DEFAULT_OUTPUT = 32_000` 是**它自己**给 OpenAI SDK 用的默认值：
 * 它每一发都显式写 `max_tokens`。我们这边不写 —— 理由与 codearts 同向
 * （`src/models.ts:105-124`）：出站预算由宿主 `GenerateOptions.maxTokens`
 * 决定，模型能力不在目录里硬编一个数，免得「用户设 128k、插件偷偷改成 32k」。
 *
 * 实测（2026-11-09 wire）：32_000 / 65_536 / 131_072 / 1_000_000 全 200，
 * 上游不校验上界；`max_tokens` 缺席时走上游默认值，正文正常。
 * ⇒ 这里**不**写 `MARVIS_DEFAULT_OUTPUT`，也不要「补上」它。
 */
export const MARVIS_FALLBACK_MODELS: readonly MarvisFallbackModel[] = [
  {
    id: 'main-auto',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1_000_000,
    // 2026-11-09 实测：main-auto 收 `{type:'image_url',image_url:{url:'data:image/png;base64,…'}}`
    // 并正确答出颜色 ⇒ 真能读图（与 codearts 的 `deepseek-v4.1-flash` 同款结论：
    // **目录标的 false 不可信**，以 wire 实测为准）。
    supportsImage: true,
  },
]

export function findMarvisFallback(modelId: string): MarvisFallbackModel | undefined {
  return MARVIS_FALLBACK_MODELS.find((m) => m.id === modelId)
}

/**
 * 把用户可能持久化过的各种写法归一成槽位 id。
 *
 * ⚠️ 为什么需要它：magpie 早先把**数组下标**写进过配置（`MODEL_ALIASES`
 * 的 `"0".."7"`），而响应体里的 **真实模型 id** 也常被用户直接粘进模型字段
 * ——两者都不是合法槽位。真实 id 直传上游会 400 `4130001 无效模型id`，
 * 但**静默替换成别的模型更糟**（用户以为在跟 A 说话，实际是 B）。
 * 故只归一**确知等价**的两种写法，其余原样交给上游判错。
 */
export function normalizeMarvisModelId(model: string): string {
  const trimmed = model.trim()
  if (trimmed === '0') return 'main-auto'
  if (trimmed === 'deepseek-v4-1-flash-261017') return 'main-auto'
  return trimmed
}

/** 错误分类（**语义**，不是 LlmError 码）。 */
export type MarvisErrorKind =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  // ⚠️ 风控单独一类（magpie 映射成 503 risk_blocked）：它**不是**账号态，
  //    写冷却标记会冤枉整个账号池；但也不是用户能自己修的，文案必须原样透出。
  | 'risk'
  | 'server'
  | 'transport'
  | 'invalid_request'
  | 'context_window'
  // 模型侧不可用（无授权 / 不存在）——确定性失败，换号可能有用、重试没用。
  | 'model_unavailable'

export interface MarvisErrorInfo {
  kind: MarvisErrorKind
  /** 服务端要求的等待时长（毫秒）；仅限流类产出。 */
  retryAfterMs?: number
  /** 面向用户的可读描述（**禁止**裸 JSON）。 */
  detail: string
}

/** 从错误体里抽出人可读片段（禁止把整坨 JSON 抛给用户）。 */
function readableDetail(body: string): string {
  const text = body.trim()
  if (text === '') return '（上游未返回错误详情）'
  try {
    const data = JSON.parse(text) as { msg?: unknown; message?: unknown; error?: unknown }
    const nested =
      typeof data.error === 'object' && data.error !== null
        ? (data.error as { message?: unknown }).message
        : data.error
    const parts = [data.msg, data.message, nested].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    )
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON：直接截断原文
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

/** 从响应体里抽 Marvis 的业务码（`{"code":4100403,...}`）。 */
function businessCodeOf(body: string): number | undefined {
  try {
    const data = JSON.parse(body) as { code?: unknown }
    if (typeof data.code === 'number' && Number.isFinite(data.code)) return data.code
    if (typeof data.code === 'string' && data.code.trim() !== '') {
      const parsed = Number(data.code)
      return Number.isFinite(parsed) ? parsed : undefined
    }
  } catch {
    // 非 JSON
  }
  return undefined
}

/**
 * 把一次失败的 HTTP 响应归类为语义化错误。
 *
 * ## ⚠️ 顺序即优先级（每一条都来自真机实测）
 *
 * 1. **上下文超限**（按报文关键词）——必须最先，否则 `exceed` 会被 quota 抢走、
 *    `throttl` 会被 rate_limit 抢走 ⇒ 用户只是发了一条超长消息，
 *    却把整个账号封到次日零点（本仓 loomy/modelscope 同型事故）。
 * 2. **业务码 4100403 / HTTP 401 ⇒ auth**：它可能以 **HTTP 200** 下发
 *    （实测如此）⇒ 只看状态码会漏判。
 * 3. **业务码 4100404 / HTTP 403 ⇒ risk**：风控，不是账号态。
 * 4. 429 / 限流文案 ⇒ rate_limit（`retry-after` 原样保留，`0` 合法）。
 * 5. 402 / 额度文案 ⇒ quota。
 * 6. **业务码 4130001（无效模型id）/ 4100402 / HTTP 404 ⇒ model_unavailable**
 *    ——必须排在 400 之前，否则「该账号没开通这个模型」会被当成「用户的请求写错了」
 *    而永不换号。
 * 7. 400 / 422 ⇒ invalid_request。
 * 8. status 0 / 传输层文案 ⇒ transport。
 * 9. >= 500（含 `5104002` RPC 报错）⇒ server。
 */
export function classifyMarvisError(
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>,
): MarvisErrorInfo {
  const retryAfterMs = retryAfterMsFromRecord(headers)
  const detail = readableDetail(body)
  const lower = body.toLowerCase()
  const code = businessCodeOf(body)

  // ① 上下文超限（文本判据，先于一切）
  if (
    lower.includes('maximum context length')
    || lower.includes('context length')
    || lower.includes('context window')
    || (lower.includes('context') && lower.includes('limit'))
    || lower.includes('context_length_exceeded')
    || lower.includes('reduce the length')
    || lower.includes('too many tokens')
    || lower.includes('input tokens exceed')
  ) {
    return { kind: 'context_window', detail }
  }

  // ② 认证（业务码先于状态码：实测可能 HTTP 200）
  if (code === 4100403 || status === 401) return { kind: 'auth', detail }

  // ③ 风控（4100404 实测是 403；不按文案抢判，避免「登录」二字把风控误判成 auth）
  if (code === 4100404 || status === 403) return { kind: 'risk', detail }

  // ④ 限流
  if (
    status === 429
    || lower.includes('too many requests')
    || lower.includes('rate limit')
    || lower.includes('throttl')
  ) {
    return { kind: 'rate_limit', ...(retryAfterMs === undefined ? {} : { retryAfterMs }), detail }
  }

  // ⑤ 额度
  if (
    status === 402
    || lower.includes('insufficient')
    || lower.includes('quota')
    || lower.includes('exceed')
    || lower.includes('balance')
  ) {
    return { kind: 'quota', ...(retryAfterMs === undefined ? {} : { retryAfterMs }), detail }
  }

  // ⑥ 模型侧不可用（必须在 400 之前）
  if (code === 4130001 || code === 4100402 || status === 404) {
    return { kind: 'model_unavailable', detail }
  }

  // ⑦ 请求非法
  if (status === 400 || status === 422) return { kind: 'invalid_request', detail }

  // ⑧ 传输层
  if (
    status === 0
    || lower.includes('fetch failed')
    || lower.includes('terminated')
    || lower.includes('econnreset')
    || lower.includes('socket hang up')
    || lower.includes('getaddrinfo')
    || lower.includes('econnrefused')
  ) {
    return { kind: 'transport', detail }
  }

  // ⑨ 服务端（含 5104002）
  return { kind: 'server', detail }
}

/**
 * 语义分类 → 宿主 `LlmError.code`。
 *
 * ⚠️ 额度/限流/认证必须用**字面量**：harness 的 `QUOTA_EXCEEDED_CODE`
 * 字面值是 `'QUOTA'`，客户端会据此把 message 换成固定文案
 * ⇒ 用错字面量会让「额度用尽」被渲染成别的错误（Issue IKJVCW）。
 */
export function marvisErrorKindCode(kind: MarvisErrorKind): string {
  switch (kind) {
    case 'auth':
      return 'AUTH'
    case 'risk':
      // 风控的报文本身就是**唯一出路**（换网络环境），不能被 AUTH 的通用
      // 文案吞掉 —— 用 PERMISSION 让原文透出。
      return 'PERMISSION'
    case 'rate_limit':
      return 'RATE_LIMIT'
    case 'quota':
      return 'QUOTA_EXCEEDED'
    case 'context_window':
      return 'CONTEXT_WINDOW_EXCEEDED'
    case 'invalid_request':
    case 'model_unavailable':
      // 确定性失败：重试 5 次只会拿到同一个 400。
      return 'BAD_REQUEST'
    case 'transport':
      return 'TRANSPORT'
    case 'server':
      return 'SERVER'
  }
}
