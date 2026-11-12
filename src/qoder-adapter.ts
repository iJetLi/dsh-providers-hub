/**
 * Qoder LLM 适配器。
 *
 * ## 两条推理路径
 *
 * Qoder 有**两套**推理端点，认**两套不同的模型名** —— 这是本项目
 * 最容易踩的坑，务必分清：
 *
 * | 路径 | 端点 | 模型名 | 说明 |
 * |---|---|---|---|
 * | **加密（本适配器默认）** | `api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1` | **目录 key**（`qfmodel` / `dmodel`） | 客户端真实链路；body 由 `src/qoder-wasm.ts` 加密；能拿到 Qwen3.8 系列 |
 * | 公开 | `api2-v2.qoder.sh/model/v1/chat/completions` | 通用名（`qwen-flash`） | 标准 OpenAI；但目录 key 一律 `Unsupported model` |
 *
 * **真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止」。
 * 根因是早期把**目录 key 发给了公开端点** → `invalid_model_error`，
 * 而错误帧又被解析器静默吞掉。
 *
 * ⚠️ `api2.qoder.sh`（加密）与 `api2-v2.qoder.sh`（公开）**不是同一个 host**，
 * 混用会 404。
 *
 * OpenAI 协议层的通用逻辑（消息序列化、SSE 消费、错误归类）复用
 * `src/openai-compat.ts`；加密端点的响应信封由 `src/qoder-envelope.ts` 剥离。
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { createModelCatalog, isCatalogFreshFor, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import { isQoderExpired, type QoderCredential } from './qoder.js'
import { describeWasmFailure, QoderEncryptedInfer, type QoderInferMessage, type QoderInferRequest, type QoderInferTool, type QoderInferToolCall } from './qoder-wasm.js'
// ⚠️ 原生搜索的契约来自**契约文件**（不是工具层 `web-native.ts`）：
//    避免「渠道层 import 工具层」的反向依赖，见 `native-search-contract.ts` 模块头。
import { classifyNativeAbort, NativeSearchCodes, WebNativeError, type NativeSource } from './native-search-contract.js'
// ⚠️ `errorMessage` 只留**一份**实现（`openai-compat.ts`）：本仓库原有 6 份同义
//    实现，PR95 审计时确认为「该腿的唯一实现」，新代码一律从这里取
//    （与 `detailFieldText` 同一条铁律，见 `buddy-adapter.ts` 的同款注释）。
import { errorMessage } from './openai-compat.js'
import { maskProxyPassword } from './proxy-mask.js'
import { unwrapQoderEnvelopeStream } from './qoder-envelope.js'
import { QODER, type QoderFallbackModel, type QoderModelPromotion, type QoderProduct } from './qoder-product.js'
import { projectRequestImage, type ImageRequestTarget } from './image-budget.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  ModelQueuedError,
  serializeMessages,
} from './openai-compat.js'
import { planSessionTitleThinking } from './session-title.js'
import {
  BILLING_BUSINESS_CODE,
  BILLING_BUSINESS_CODES,
  QUEUE_BUSINESS_CODE,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_MAX_DELAY_MS,
  isBillingBusinessCode,
  isQueueBusinessCode,
  looksLikeBillingError,
  nextUtc8DayStartMs,
  parseQueueError,
  queueDelayMs,
  type QueueInfo,
} from './model-queue.js'

/**
 * 本模块内使用的别名（`export { … as …
 * }` **不会**在模块内建立可用的名字 —— 那只对导入方生效）。
 */
type QoderQueueInfo = QueueInfo
const parseQoderQueueError = parseQueueError
const qoderQueueDelayMs = queueDelayMs

/**
 * ⚠️ **向后兼容的再导出**：排队解析的实现已移到 `src/model-queue.ts`
 * （因为 SSE 消费器也要用，而它不能被本模块反向 import —— 会成环）。
 * 这里保留同名导出，避免既有调用方与测试失效。
 */
export {
  BILLING_BUSINESS_CODE as QODER_BILLING_CODE,
  // ⚠️ IKKJFH：额度类**码值集合**也公开（对外 API 面），
  // 与上面的单码值并存 —— 单码值只为兼容，判据请用集合。
  BILLING_BUSINESS_CODES as QODER_BILLING_CODES,
  QUEUE_BUSINESS_CODE as QODER_QUEUE_CODE,
  QUEUE_MAX_ATTEMPTS as QODER_QUEUE_MAX_ATTEMPTS,
  QUEUE_MAX_DELAY_MS as QODER_QUEUE_MAX_DELAY_MS,
  isBillingBusinessCode,
  isQueueBusinessCode,
  looksLikeBillingError,
  nextUtc8DayStartMs,
  parseQueueError as parseQoderQueueError,
  queueDelayMs as qoderQueueDelayMs,
  type QueueInfo as QoderQueueInfo,
}

/**
 * 判断一个错误是否为**额度受限**（`QUOTA_EXCEEDED`）。
 *
 * ⚠️ 必须同时认 `code` **与** `message`：
 * - `code`：`openai-compat` 抛的 `LlmError(…, 'QUOTA_EXCEEDED')`（主判据）；
 * - `message`：兜底 —— 若哪天错误从别的路径冒出来（如未被包装的原始文本），
 *   文案里仍带 `Billing daily count exceeded`，可据此识别。
 *
 * ⚠️ 用 `code` 判据**而不是**重新解析错误文本：`ModelQueuedError` 已证明
 * 「在适配器里重解析一遍」会与上游判定漂移（同一份判据两处实现必然不同步）。
 *
 * ⚠️⚠️ **2026-10-21：本函数已不再被 `stream()` 调用**（切号判据统一走
 * {@link classifyQoderFailure}）。保留它的理由有两条，缺一不可：
 * ① {@link classifyQoderFailure} 的 `quota` 分支就是照着它写的（
 *    `code === 'QUOTA_EXCEEDED' || code === 'QUOTA'`），删掉它会让那条判据**没有出处**；
 * ② 它是 `Error` 对象级判据（带 `looksLikeBillingError` 文案腿的完整形态），
 *    而 `classifyQoderFailure` 是「码 + 文本」两参形式 —— 二者**不是**同一函数，
 *    只是同一个语义的两种入口。若将来有调用方持有 `Error` 对象，用这个更省事。
 *
 * ⚠️ 但**不要**把它的判据再复制一份到别处：`classifyQoderFailure` 已经内联了
 * 等价的两行，改判据时**两处都要改**（这是本仓库首条红线「同一语义两套判据，
 * 必有一处是错的」的已知例外点）。
 */
function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof LlmError) {
    if (error.code === 'QUOTA_EXCEEDED' || error.code === 'QUOTA') return true
  }
  if (error instanceof Error) {
    // 仅在**没有**更精确的 code 时用文案兜底（避免把正常文本误判）
    if (!(error instanceof LlmError)) return looksLikeBillingError(error.message)
  }
  return false
}

/**
 * 从任意错误里提取 `{ code, text }`（供 {@link classifyQoderFailure} 的两参形态）。
 *
 * ⚠️ 这不是判据，只是**取值**：判据全部在 `classifyQoderFailure` 里，
 * 任何调用方都不许自己再判一遍类别。
 */
function failureCallOf(error: unknown): { code: string; text: string } {
  if (error instanceof LlmError) return { code: error.code, text: error.message }
  if (error instanceof Error) return { code: '', text: error.message }
  return { code: '', text: String(error) }
}

/**
 * 上游**供应商侧瞬时故障**的文案判据（`provider_error` 这一类）。
 *
 * ## 为什么需要它（真实报障，2026-10-21）
 *
 * 用户贴出：
 * ```
 * aggregate: qodercn（dfmodel）上游失败：
 *   qoder: Error in upstream response (provider_error/model_error) code=SERVER
 * ```
 * 池里有 **2 个** `qodercn` 账号，但第二个**从未被尝试** —— 因为该错误落
 * `SERVER`，而本适配器的切号判据只有「额度」一类（见 {@link isQuotaExceededError}）。
 *
 * ## 判据为什么是「码值 + 文案」双通道
 *
 * 单认码值不够：本仓库在额度类上记过两次同型教训（`110` 漏判 → 补
 * `looksLikeBillingError`；`112` 又漏判 → 补 `pricingUrl`，见
 * `model-queue.ts:182-191` 的 IKKJFH 记录）。上游换码值/换文案是常态，
 * 只认一条腿必然再漏一次。
 *
 * 单认文案也不够：`provider_error` 是**结构字段**（`code` 字段的值），
 * 而文案 `Error in upstream response` 也可能出现在别的语境里。
 *
 * ⇒ 两条腿都认，任一命中即算（与 `isBillingBusinessCode || looksLikeBillingError`
 * 的既有形态**逐字同构**，不引入第三种判据风格）。
 *
 * ## ⚠️ 词表必须**窄**
 *
 * `provider_error` 是 Qoder 报文的**结构字段值**，不是自然语言；
 * `upstream` 类短语只认「明确的错误短语」。泛词（`error` / `failed` /
 * `upstream` 单词）会命中正常正文（模型恰好讨论「上游失败」），一律不收。
 *
 * ⚠️ **不收 `model_error`**：它是 `openai-compat.ts:929` 的**拼接产物**
 * （`[code, type].join('/')`），单独出现时可能来自任何 `SERVER` 错误，
 * 收它等于把整个 `SERVER` 都算进来 —— 那正是本判据要避免的过宽。
 *
 * ## ⚠️⚠️ 网关 5xx 也必须收（2026-10-25 审计 P1，B1-1）
 *
 * 上面那张词表**只认 `provider_error` 那类短语**。但对抗审计扫了本机全部
 * **1374 个会话 / 163 条真实 qoder 失败**，按形态计数后发现真正**主导**的是
 * 另外两种，而它们都落 `other` ⇒ **不换号**、还因终态是 `SERVER`
 * （在宿主 `DEFAULT_RETRYABLE_CODES` 里）**白重试 5 次**：
 *
 * | 真实形态 | 次数 |
 * |---|---|
 * | `qoder: <html>…504 Gateway Time-out…</html>` | **74** |
 * | `First Token Timeout or Upstream Timeout (504/model_error)` | **6** |
 * | `Error in upstream response (provider_error/model_error)` | 16 |
 *
 * ⇒ 本 PR 原以为的核心目标（16 次）其实不是主导形态；把网关 5xx 一并收进来
 * 才真正覆盖了「登录 N 个账号 ≠ N 倍可用性」这个缺陷。
 *
 * ⚠️ 仍然要**窄**：只收「明确的网关/上游故障短语」——
 * `gateway time-out` / `bad gateway` / `service unavailable` /
 * `(first token|upstream) timeout`。**不收**泛化的 `server error` /
 * `timeout` / `upstream connection reset`：那些可能是请求侧或本地网络问题，
 * 收进来会让 400 参数错也变成可换号（白烧整池）。
 * ⚠️ 顺序不变：**额度腿优先**（见 `classifyQoderFailure`），
 * 故「504 + billing 文案」仍归 `quota`。
 */
export function looksLikeUpstreamProviderError(text: string): boolean {
  if (/provider_error|provider\s+error|upstream\s+(?:provider\s+)?error|error\s+in\s+upstream\s+response/i.test(
    text,
  )) return true
  // 网关 5xx：HTML 错误页（`504 Gateway Time-out` / `502 Bad Gateway`）与
  // 上游超时（`First Token Timeout or Upstream Timeout`）。
  return /gateway\s+time-?out|bad\s+gateway|service\s+(?:temporarily\s+)?unavailable|(?:first\s+token|upstream)\s+timeout/i.test(
    text,
  )
}

/**
 * Qoder 的失败类别。
 *
 * 语义表（照 `accio-adapter.ts:1596-1605` 的「类别 → 动作」表逐格搬，
 * 本仓库已有 6 家同款：accio / minimax / loomy / raccoon / trae / lobsterai）：
 *
 * | 类别 | 判据 | 换号 | 写冷却 |
 * |---|---|---|---|
 * | `quota`    | `QUOTA_EXCEEDED` / 110 / 112 / pricingUrl | ✅ | ✅ 至 UTC+8 当日 24:00 |
 * | `rate`     | `RATE_LIMIT` / 429 | ✅ | ✅ 1h（{@link QODER_RATE_LIMIT_COOLDOWN_MS}） |
 * | `auth`     | `AUTH` / 401 / 403 | ✅ | ❌ **绝不** |
 * | `upstream` | `SERVER` **且** {@link looksLikeUpstreamProviderError} | ✅ | ❌ **绝不** |
 * | `other`    | 其余（400 参数错、风控页、空响应…） | ❌ | ❌ |
 * | `transport`| **不来自 {@link classifyQoderFailure}**：由适配器在 `fetch` 抛
 *               传输错误时（`sendEncrypted`）**直接传入** | ✅ | ❌ **绝不**
 *              （连不上是出口/网络问题，写冷却会把健康号封到当天 24 点） |
 *
 * ## ⚠️ `transport` 是**内部入参**，不是分类结果
 *
 * {@link classifyQoderFailure} **永不返回** `'transport'`（实测：喂
 * `('TRANSPORT', <含 UND_ERR 的 detail>)` 得 `'other'`）。原因：这条类别只在
 * 「建连/首包」这条腿上有意义，而 `fetch` 的传输错误在进入任何分类器**之前**
 * 就已被 `sendEncrypted` 包成 `LlmError(code='TRANSPORT')` 并直接送进换号分支。
 *
 * ⚠️ **SSE 中途**的 `sse transport error` 因此**不换号**（被归 `other`）——
 * 那是刻意的：那时正文可能已吐了一半，换号重发会重复内容。
 *
 * ## ⚠️ `auth` / `upstream` 只换号、绝不写冷却
 *
 * `auth` 那条是 2026-10-06「全池被封」事故换来的不变式：上游网关对**全池**
 * 回 401 时，若每个号都被写长冷却，**一个请求就能把整个 provider 封一天**。
 *
 * `upstream` 走同一条纪律，理由不同但方向一致：`provider_error` 是上游
 * **供应商侧**的瞬时故障，与「这个账号的额度/状态」**无关**。写冷却等于把
 * 一次上游抖动记成「该账号今日此模型已用完」—— 那要**一整天**才恢复，
 * 而实际上换个号（或等几秒重发）大概率就好了。
 *
 * ## ⚠️ 与 `isQuotaExceededError` 的关系
 *
 * 后者是**额度专用**判据（含文案兜底），保留原样不动（既有调用方与测试
 * 依赖它）。本函数是**更宽**的分类入口，额度也在其中。
 */
export type QoderFailureClass = 'quota' | 'rate' | 'auth' | 'upstream' | 'other' | 'transport'

/**
 * 单次 `stream()` 里，**传输级失败**最多允许的额外尝试次数（不含首发）。
 *
 * ## 为什么要有上限（而不是「换到没号为止」）
 *
 * 每一次尝试都要等一个 **10 秒 connect 超时**（undici 默认 `connectTimeout`，
 * 实测 10,713ms）。若不设上限：5 个账号 × 10s = 50s，而宿主对 `TRANSPORT` 还有
 * 5 次重试（`DEFAULT_RETRYABLE_CODES`，退避 500ms→10s）⇒ 最坏 6 × 50s ≈ 5 分钟
 * 才报错，用户只看到「卡住」。
 *
 * ## 为什么不「同号退避重试」
 *
 * 同号重试只对瞬时的 socket 重置有意义，而那件事**宿主已经在做**（`TRANSPORT`
 * 在 `DEFAULT_RETRYABLE_CODES` 里，5 次、退避 500ms→10s）。再叠一层只是把
 * 「完全离线」的最坏耗时成倍放大（10s → 30s/轮），换不来任何新路径。
 *
 * ⇒ 每次重试**必须换一个账号**（换号 = 换出口：每账号可配独立代理，见 `618a090`
 * 「国际版 SNI 阻断下唯一出路」）；换不到号就**立即抛原错误**，交给宿主退避。
 * 预算只给 **2** 次 ⇒ 单轮最坏 3 发 ≈ 30s（宿主再退避重试 5 次的总时长仍可控）。
 */
export const QODER_TRANSPORT_MAX_RETRIES = 2

/**
 * 把一次传输失败的**可操作信息**拼成一句话（沿 `cause` 链取更深几层）。
 *
 * ## 为什么必须拼（issue IKR5ZD，2026-10-28）
 *
 * 用户看到的只有 `qoder: transport error: fetch failed` —— 而真正能定位问题的
 * 东西全在 `cause` 链里：
 *
 * ```
 * TypeError: fetch failed
 *   └ cause: UND_ERR_CONNECT_TIMEOUT
 *            Connect Timeout Error (attempted address: 1.2.3.4:443, timeout: 10000ms)
 * ```
 *
 * 「连到哪个 IP / 是超时还是被重置 / 超时多少毫秒」直接决定处置方式
 *（换 IP、换出口代理、改超时），缺了它这条报错**等于没有信息**。
 *
 * ⚠️ 链长有界（4 层）+ 去重，避免自引用 `cause` 造成死循环。
 * ⚠️ 结果经 {@link maskProxyPassword} 脱敏：代理故障的 message 里可能带 userinfo。
 */
export function transportErrorDetail(error: unknown): string {
  const top = error instanceof Error ? error.message : String(error)
  const pieces: string[] = []
  let current: unknown = (error as { cause?: unknown } | undefined)?.cause
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const piece = (() => {
      if (!(current instanceof Error)) {
        // ⚠️ `String(x)` 对 Symbol 会**抛**（`Cannot convert a Symbol value to a
        // string`）—— 装饰函数自己抛错会顶替原始错误，与本仓库「清理失败不得改写
        // 原错误」同型。故先试，失败就退回固定文案。
        try {
          // 形如 `{ code, message }` 的普通对象（某些库就这么抛）要先取 message，
          // 否则只会得到一句无信息的 `[object Object]`。
          if (current !== null && typeof current === 'object') {
            const message = (current as { message?: unknown }).message
            const code = (current as { code?: unknown }).code
            if (typeof message === 'string' && message.length > 0) {
              return typeof code === 'string' && code.length > 0 ? `${code}: ${message}` : message
            }
          }
          return String(current)
        } catch {
          return '<unprintable cause>'
        }
      }
      const raw = (current as NodeJS.ErrnoException).code
      let code: string
      try {
        code = raw === undefined ? '' : String(raw)
      } catch {
        code = ''
      }
      return code.length === 0 ? current.message : `${code}: ${current.message}`
    })()
    if (piece.length > 0 && piece !== top && !pieces.includes(piece)) pieces.push(piece)
    current = (current as { cause?: unknown }).cause
  }
  const joined = pieces.length === 0 ? top : `${top} ← ${pieces.join(' ← ')}`
  // ⚠️ 长度上限：`cause.message` 可以是任意长（实测 10 万字符的会原样进日志与
  //    UI）。截断到 512 字符 —— 地址/错误码/超时值都在前 200 字内，够定位。
  const capped = joined.length > 512 ? `${joined.slice(0, 512)}…` : joined
  return maskProxyPassword(capped)
}

/**
 * 把一次失败归类。
 *
 * @param code - `LlmError.code`（拿不到时传 `''`）。
 * @param text - 上游原文 / 错误 message（供文案腿使用；无则传 `''`）。
 */
export function classifyQoderFailure(code: string, text: string): QoderFailureClass {
  // ① 额度：码值（含 `QUOTA` 别名）+ 文案兜底，判据只留一份（`isQuotaExceededError`
  //    的等价形态，但这里按「码 + 文本」两参形式表达，供无 `Error` 对象的场合复用）。
  if (code === 'QUOTA_EXCEEDED' || code === 'QUOTA') return 'quota'
  if (code === 'RATE_LIMIT') return 'rate'
  if (code === 'AUTH') return 'auth'
  // ② 码值没给出确定类别时，才看文案（顺序是语义性的：码值优先）。
  if (isBillingBusinessCode(code) || looksLikeBillingError(text)) return 'quota'
  // ③ 上游供应商侧瞬时故障 —— 必须**在** `other` 之前，且只在 `SERVER` 上认，
  //    否则会把 400 参数错（文案里也可能带 upstream 字样）误判成可换号。
  if (code === 'SERVER' && looksLikeUpstreamProviderError(text)) return 'upstream'
  return 'other'
}

/**
 * 该类别是否值得**换下一个账号**重试。
 *
 * ⚠️ `other` 为 false 的理由与 minimax / loomy / accio 同款：400 参数错、
 * 风控拦截页、空响应这些是**请求本身或环境**的问题，换号只会白烧整池。
 */
export function shouldRotateQoderAccount(cls: QoderFailureClass): boolean {
  // ⚠️ `transport` 在本表里是 `true`（类型完备性），但**当前没有调用方会拿它来问**
  // —— `classifyQoderFailure` 永不返回 `'transport'`，而 transport 那条换号路径
  // 在 `stream()` 里是**直接调** `switchAccountOnQuota` 的。别把它当承重件
  //（2026-10-31 对抗审计：删掉本行对 transport 的判断没有任何用例会红）。
  return cls !== 'other'
}

/**
 * 该类别是否**写冷却标记**。
 *
 * ⚠️ **`auth` / `upstream` / `transport` 恒 false**（见 {@link QoderFailureClass}
 * 的语义表）。`transport` 尤其不能记：连不上是**出口/网络**的问题，写冷却会把
 * 一个可能完全健康的账号封到当天 24 点 —— 那正是「换了号还是超时、第二天才好」
 * 这类最难查的症状（issue IKR5ZD 的处置必须避开它）。
 * 这条是「一个请求封死整池」与「坏账号永远轮不到」之间的取舍点。
 */
export function recordsQoderRateLimit(cls: QoderFailureClass): boolean {
  return cls === 'quota' || cls === 'rate'
}

/**
 * `rate` 类（429）的冷却时长。
 *
 * ⚠️ 与 `quota` 的「至 UTC+8 当日 24:00」**必须不同**：Qoder 的额度按**自然日**
 * 结算（`nextUtc8DayStartMs`），而限流是**秒级/分钟级**的背压 —— 按自然日写冷却
 * 会让一次瞬时限流把账号封到明天（`minimax` / `accio` 都记过同型缺陷）。
 *
 * 取 1 小时（与 `accio-adapter.ts:128` 的 `ACCIO_RATE_LIMIT_COOLDOWN_MS` 同值）：
 * 既足够长到让背压消退，又不至于把可用账号白白搁置半天。
 */
const QODER_RATE_LIMIT_COOLDOWN_MS = 3_600_000

/** 本适配器注册的 provider 路由名（历史常量，等价于 `QODER.id`）。 */
export const PROVIDER = 'qoder'

/**
 * 思考档位 id → 中文展示名。
 *
 * ⚠️ **必须与官方 IDE 一致**，取证是 asar 里的 i18n 表
 * （`settings.efforts`，`scripts/probe-qoder-effort-i18n2.mjs` 可取）：
 * ```
 * none:关闭思考  minimal:最小  low:低  medium:中  high:高  xhigh:极高  max:最大
 * ```
 * 用户截图里的「关闭思考 / 低 / 中 / 极高 / 最大」正是这套。
 *
 * ⚠️ DSH 的档位选择器**直接渲染 `efforts[].name`**（不本地化），
 * 所以这里给中文就是中文界面 —— 与 Qoder IDE 逐字一致。
 *
 * ⚠️ **`minimal` 是「有显示名、但不在线上白名单里」的一格**（2026-10-20 复核）：
 * 官方产物里 i18n 有 `minimal:最小`，而**档位白名单 `k3` 只有 6 个值、不含它**
 * （见 `qoder-catalog.ts` 的 `EFFORT_WHITELIST`）。本表保留它只为「万一上游
 * 真下发时别显示成裸 id」；**不要**据此把它加回白名单 —— 那会让 UI 渲染出一个
 * 官方客户端会静默丢弃的档位。
 */
const QODER_EFFORT_NAMES: Readonly<Record<string, string>> = {
  none: '关闭思考',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

/**
 * 该模型在 UI 上可选的思考档位（复刻客户端 `gU()` 的行为）。
 *
 * 三条口径：
 * 1. `efforts` 原样取用（目录顺序保持 —— 官方客户端也按对象键序渲染）；
 * 2. `supportsDisable` 为真时**追加** `none`（即「关闭思考」）；
 *    客户端 `gU()`：`… || e.includes('none') ? e : [...e, 'none']`。
 * 3. 两者皆无 → 返回空数组，调用方**不声明 `reasoning`**
 *    （UI 显示「当前模型未提供推理等级」，对应 IDE 的「不支持」）。
 *
 * ⚠️ **`qmodel` / `qmodel_latest` 这类「有 `disabled` 但无 `efforts`」的模型
 * 会得到 `['none']`** —— 即只提供「关闭思考」一项。这是**远端事实**
 * （用户 2026-09-28 确认「上面两个没有思考档位就是关闭的意思」），
 * **不要**给它们补默认档位。
 */
export function qoderEffortsFor(model: QoderFallbackModel): string[] {
  const efforts = [...(model.efforts ?? [])]
  if (model.supportsDisable === true && !efforts.includes('none')) efforts.push('none')
  return efforts
}

/**
 * 排队总时长上限（毫秒），可用 `DSH_QODER_QUEUE_TIMEOUT_MS` 覆盖。
 *
 * ⚠️ **不能用 `parseInt(…) || 默认值`**：`0` 是**合法**配置（表示「不等，立即
 * 判超时」，单测就靠它验证该开关），而 `0` 是 falsy，会被 `||` 静默换成 30 分钟
 * —— 那会让这个开关在「想关掉排队等待」时**恰好失效**。故显式判 `undefined`。
 */
function resolveQueueTimeoutMs(): number {
  const raw = process.env.DSH_QODER_QUEUE_TIMEOUT_MS
  if (raw === undefined || raw.length === 0) return 30 * 60_000
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30 * 60_000
}

/**
 * 读 `AbortSignal.aborted`（**刻意做成函数**）。
 *
 * 为什么不能内联 `signal?.aborted === true`：TS 会在 `await` 之前的一次
 * early-throw 之后把该表达式**静态窄化**为字面量 `false`，于是「等待期间被
 * 中止」这第二次检查会被判为「无重叠的比较」而**编译报错** —— 那个报错本身
 * 是假阳性（`aborted` 是随时间的可变状态）。经函数读取即可保留真实语义，
 * 也把「这里为什么再查一次」的意图写清楚。
 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

/**
 * 从 SSE 层抛出的 {@link ModelQueuedError} 里取出排队信息。
 *
 * `ModelQueuedError.queueInfo` 是已经解析好的 `QueueInfo`，但类型放宽成了
 * `Record<string, unknown>`（共享模块不该暴露 provider 私有类型）。
 * 这里原样取回 —— **不要再解析一次**（那会与已解析的结果产生两套口径）。
 */
function queueInfoOf(error: ModelQueuedError): QoderQueueInfo {
  return error.queueInfo as QoderQueueInfo
}


/**
 * 把 DSH 的工具 schema 映射成加密端点认的 `tools[]`。
 *
 * 形态取自客户端 `$Hc(A)`：
 * `{type:'function', function:{name, description?, parameters?}}` ——
 * `description` / `parameters` **缺省时该键不出现**（不是填空串/空对象）。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。适配器若不下发它，模型在 wire 上
 * 看不到任何函数定义，只能用正文里的 XML 文本臆造工具调用 —— 用户报障
 * 「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」的根因。
 *
 * @param tools - DSH 的 `GenerateOptions.tools`（可能缺席）。
 * @returns 可直接写入请求体顶层 `tools` 的数组；无工具时为空数组。
 */
export function buildQoderTools(
  tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[] | undefined,
): QoderInferTool[] {
  if (tools === undefined || tools.length === 0) return []
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(tool.description.length > 0 ? { description: tool.description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  }))
}

/** {@link buildQoderHistory} 的入参：DSH 序列化后的 wire 消息（OpenAI 形态）。 */
interface QoderWireMessage {
  role?: unknown
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
}

/** 把 wire 消息的 content 归一化为字符串（工具调用消息的正文是空串）。 */
function qoderContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text: unknown } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
      .map((block) => String(block.text))
      .join('')
  }
  // `null`（assistant 只带 tool_calls 时的 OpenAI 规范值）与畸形值都退化为空串：
  // 客户端 `t2c()` 的 content 恒为字符串（`udn(r, '')`）。
  return ''
}

/**
 * 把 wire 消息的 content 数组**逐字段搬运**成多模态 parts。
 *
 * ## 为什么必须保留数组（真实缺陷，用户报障）
 *
 * 「给 qodercn 的 qwen3.8-flash 发送图片，模型说没读到图片」。
 *
 * 根因**不在** `chat_context.imageUrls` —— 客户端官方实现 `Hyc()` 就把那个字段
 * **恒置 `null`**（obf 产物原文：`function Hyc(A,e,t){return{text:A,features:[],
 * extra:{…},chatPrompt:"",imageUrls:null}}`），我们那行是忠实复刻。
 * 图片的正确通道是 **`messages[].content` 的多模态数组**：客户端 `eQc()` 把
 * `{type:'base64',media_type,data}` 转成 `{type:'image_url',image_url:{url}}`，
 * `bJc()` 再转成 `{type:'input_image',image_url:…}` 后发出。
 *
 * 而上游 `serializeMessages`（`src/openai-compat.ts`）**已经**把图片正确转成了
 * `{type:'image_url',image_url:{url:'data:…'}}` 放进 content 数组 ——
 * 是 `buildQoderHistory` 用 `qoderContentText()` 把它压成纯文本吃掉的。
 *
 * ⚠️ 这是本文件第三个同型缺陷（前两个：`tools` 不下发、工具历史丢
 * `tool_calls`）—— 都是「序列化层没保留多模态结构」。改动时务必三者一起想。
 *
 * ⚠️ **只保留协议认识的两个键**（与 `buildQoderInferPayload` 的「逐字段搬运」
 * 同一原则）：不要把 DSH 的内部字段（`id` / `source` / `attachment` 等）
 * 原样发给上游。
 *
 * @returns 规范化后的 parts；**无图或全部畸形**时返回 undefined（调用方据此
 *          决定是否降级为字符串，以免把纯文本消息也改成数组形态）。
 */
function qoderContentParts(content: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: Array<Record<string, unknown>> = []
  let hasImage = false
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { type?: unknown; text?: unknown; image_url?: { url?: unknown } }
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text.length > 0) parts.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image_url') {
      // ⚠️ 只搬 `url`：`image_url` 里可能还有 `detail` 等字段，客户端 `bJc()`
      // 只在存在时透传 `detail`，这里与它对齐（缺省不写该键）。
      const url = block.image_url?.url
      if (typeof url !== 'string' || url.length === 0) continue
      const detail = (block.image_url as { detail?: unknown }).detail
      parts.push({
        type: 'image_url',
        image_url: {
          url,
          ...(typeof detail === 'string' && detail.length > 0 ? { detail } : {}),
        },
      })
      hasImage = true
      continue
    }
    // 其余类型（如 Anthropic 风格的 `image`、`tool_result` 内层块）不由本函数处理：
    // 它们要么已被 `serializeMessages` 转成 image_url，要么不属于推理载荷。
  }
  // 无图时返回 undefined，让调用方继续用字符串形态（上游对字符串兼容性最好）。
  return hasImage ? parts : undefined
}

/**
 * 把 `serializeMessages` 的 wire 消息转成加密端点的 `messages[]`。
 *
 * ## 真实缺陷（本次修复）
 *
 * 早期实现写成「只保留 `content` 为字符串的消息」：
 *
 * ```ts
 * messages.filter((m) => typeof m.content === 'string')
 * ```
 *
 * 这有两个后果，都会让**多步工具调用**彻底坏掉：
 * 1. assistant 带工具调用时 `content` 是 **`null`**（OpenAI 规范）→ 整条消息
 *    被丢弃，模型**看不到自己调用过什么**；
 * 2. `role:'tool'` 消息的 `tool_call_id` 被一并丢掉 → 工具结果无法与调用配对。
 *
 * 于是模型只能反复重调同一个工具或凭空编造结果 —— 与 TRAE 那条已记录的
 * 同型缺陷（「消息序列化漏做 → 模型看不到工具调用与结果」）完全一致。
 *
 * 形态对齐客户端：assistant 挂 `tool_calls`，`role:'tool'` 挂 `tool_call_id`。
 */
export function buildQoderHistory(messages: readonly QoderWireMessage[]): QoderInferMessage[] {
  const history: QoderInferMessage[] = []
  for (const message of messages) {
    if (typeof message.role !== 'string') continue
    // ⚠️ 含图消息必须保留 content **数组**（见 `qoderContentParts` 的缺陷说明）；
    // 纯文本仍走字符串，保持与既有形态和上游兼容性逐字节一致。
    const parts = qoderContentParts(message.content)
    const content = parts === undefined ? qoderContentText(message.content) : parts
    const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? (message.tool_calls as QoderInferToolCall[])
      : undefined
    const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined
    // 三者皆空的消息没有承载意义（如只有 reasoning 的帧），跳过以免发出
    // 「空 assistant」这种会让上游困惑的条目。
    //
    // ⚠️ 判空必须把**图片**算作内容：`parts` 为非空数组（含 image_url）时
    // 即便 `qoderContentText` 结果为空串也不能丢弃 —— 否则「只发一张图、
    // 不带文字」的消息会被整条吃掉（用户报障场景之一）。
    const isEmpty = parts === undefined
      ? content.length === 0
      : (content as Array<Record<string, unknown>>).length === 0
    if (isEmpty && toolCalls === undefined && toolCallId === undefined) continue
    history.push({
      role: message.role,
      content,
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
      ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    })
  }
  return history
}

/**
 * SSE 空闲超时（毫秒）。
 *
 * 分两阶段：等待首 token 的窗口与两次 chunk 之间的最大静默，均可用环境变量
 * 覆盖（便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取**
 * —— 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，
 * adapter 的 generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_QODER_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_QODER_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/**
 * 单次原生搜索请求的预算（毫秒）。
 *
 * ⚠️ **与 `buddy-adapter.ts` 的 `NATIVE_SEARCH_TIMEOUT_MS` 同值同义**（两边各写
 * 一份是刻意的：两者的模块依赖方向不同，且都属「渠道层自己的预算」；
 * 共享会诱使渠道层去 import 工具层 —— 见 `native-search-contract.ts` 模块头）。
 * 20s 与官方客户端 `WEB_SEARCH_TIMEOUT_MS = 2e4` 对齐。
 */
const NATIVE_SEARCH_TIMEOUT_MS = 20_000

/** `QoderAdapter` 的构造选项。 */
export interface QoderAdapterOptions {
  /** 默认凭据 ref（仅用于类型/日志，实际解析走 `resolveCredential`）。 */
  credentialRef: CredentialRef
  /**
   * 从凭据存储解析凭据。
   *
   * ⚠️⚠️ **第二参 sessionId 是「轮换起点」的作用域键**（用户 2026-11-11 报障）：
   * 适配器必须把 `GenerateOptions.sessionId` 透传进来，否则选号层的
   * `preferredRotationFor(provider, undefined)` 恒返回 `undefined`
   * ⇒ **下拉框选了永远不生效、且零报错**。
   *
   * 这曾是一个真实缺陷：本接口原签名只有 `modelId`，全仓各适配器的
   * 调用点**无一传 sessionId** ⇒ 功能上线后用户实测「选了 0959 仍用 4016」。
   */
  resolveCredential: (modelId?: string, sessionId?: string) => Promise<QoderCredential | undefined>
  /** 静默续期凭据。 */
  refresh: () => Promise<void>
  /** 多账号池（用于限流时切换账号与模型黑名单）。 */
  accountPool?: AccountPool
  /**
   * 补齐凭据缺失的 **`uid`**（加密推理必需）。
   *
   * ⚠️ 为什么需要这个钩子：`uid` 是后加的字段，**在此之前的旧凭据里没有它**，
   * 而 `generate_runtime_auth_fields` 依赖它派生 `encrypt_user_info`。
   * 缺 uid 时 WASM 产出**签名无效**的请求 → 服务端回
   * `Signature invalid (101)`（真实缺陷，用户报障）。
   *
   * 传入旧凭据，实现应调一次 userinfo 取 `id`、**回写凭据存储**，
   * 并返回补好 uid 的新凭据；无法补齐时返回 undefined。
   *
   * 未提供该钩子、且凭据缺 uid 时，会**明确报错**而不是发出必然失败的请求。
   */
  resolveUid?: (credential: QoderCredential) => Promise<QoderCredential | undefined>
  /**
   * 读取图片附件的原始字节（内联为 data URL 用）。
   *
   * 由调用方桥接 `ctx.attachments.readImage(ref)`；未提供时收到图片会报
   * `UNSUPPORTED_CONTENT`（而不是静默丢弃）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /**
   * 读取图片附件的**请求版本**（按像素预算与字节目标缩放后的字节）。
   *
   * ⚠️ 与 {@link readImage} 的错误契约**相反**：不可用时必须返回 `undefined`
   * 而不是抛错 —— 缩放是优化，不能因为"想缩图"把一次本来能成功的请求打死。
   * 判据与回退都在共享的 `projectRequestImage` 里（buddy / raccoon 用同一份）。
   *
   * 背景（issue !IKITT9）：qoder 撞的是**请求体体积**上限（实测 8 张原图能过、
   * 15 张 ≈57 MiB 直接 `TRANSPORT: fetch failed`），与腾讯的图片 token 预算
   * 是两种约束，但同样只能靠缩放解决。
   */
  readImageRequest?: (
    attachment: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link QODER}。 */
  product?: QoderProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * **按账号**取出口代理的 fetcher（真实报障 2026-10-21）。
   *
   * ⚠️ 国际版 `openapi.qoder.sh` 在本机被 SNI 阻断（TLS ClientHello 被丢，
   * 而 TCP 443 握手正常），实测两个真实账号的**推理通道**同样 10.7s
   * `TRANSPORT: fetch failed` ⇒ 整个渠道没有实际推理能力。中国版
   * （`openapi.qoder.com.cn`）直连 434ms 就通 ⇒ 只能按账号配。
   *
   * ⚠️ **为什么是「按账号取」而不是构造期一份常量**：适配器在一轮请求内会
   * **换号**（`switchAccountOnQuota`，见额度/限流/上游故障三条分支），出口必须
   * 跟着 `activeAccountId` 换 —— 固化会让换号后**仍走旧账号的出口**，
   * 症状是「换了号还是超时」且**无任何报错**，属最难查的一类静默失效。
   *
   * ⚠️ 不传 ⇒ 恒直连（与既有行为逐字一致，所有单测不受影响）。
   */
  fetchFor?: (accountId: string) => typeof fetch
  /**
   * 当前生效账号的 id（额度受限时用于**标记该账号**）。
   *
   * ⚠️ 做成**回调**而不是构造期常量：账号会在 `refreshAll` / 限流切换 /
   * Jet Hub 手动启停后变化，构造期快照会标记到**已经不再使用**的账号上。
   * 未提供时跳过标记（仍会尝试切号），不会因此崩。
   */
  currentAccountId?: () => string | undefined
  /**
   * 注入的休眠实现（**测试用**）。
   *
   * 排队重试要真等（最长 10s × 180 次），单测不能真睡 —— 注入后即可断言
   * 「等了几次、每次多久」，并在毫秒级完成。
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /**
   * 「远端模型目录已落地」的回调。
   *
   * ⚠️ **必须由接线层注入 `broadcastCatalogChanged(ctx)`**（`registerQoderLlm`
   * 已代劳）：DSH 客户端把目录缓存在 `status === 'ready'` 即短路的 store 里，
   * 只有收到 `llm/adapters-updated` 才重读 ⇒ 远端目录异步落地后不广播，
   * 模型选择器会**永久**停留在冷启动那份兜底表上（`catalog-broadcast.ts` 记着
   * 这条真实症状：设置页 5 个模型、对话框只剩 2 个）。
   */
  onCatalogLoaded?: () => void
  /**
   * 目录读取失败的告警出口（缺省静默）。
   *
   * ⚠️ 与「失败即回退兜底表」配套：回退是**静默**的，没有这条日志就没有
   * 任何证据表明上游目录取不到（只剩「倍率不更新」这种无信息的症状）。
   */
  warn?: (message: string) => void
  /** 注入的时钟（测试用；缺省 `Date.now`）。 */
  now?: () => number
  /**
   * 拉取**远端模型目录**（由接线层注入 `QoderAuth.fetchModels(pool)`）。
   *
   * ## ⚠️ 为什么是「注入一个取数函数」而不是适配器自己解析凭据
   *
   * 适配器手上的取凭据入口是 `resolveCredential`，而它**有副作用**：
   * 选中账号时会 `reportAccount(id)`（接线层据此维护「本次实际使用的账号」，
   * 供额度报错时标记）。目录请求是**周期性**的 —— 20 分钟刷新器可能在一次
   * 聊天请求选号之后跑到，把那个记录**改写成目录用的账号** ⇒ 额度标记落到
   * 无辜账号上（真实后果见 `index.ts` 的 `activeQoderAccountId` 注释）。
   *
   * 故与其余 11 家同形：由 auth 服务做**只读**取号 + 拉取，适配器只拿结果。
   *
   * 省略时**不发远端请求**（恒用兜底表）—— 纯测试/未接线场景的安全默认。
   */
  fetchRemoteModels?: () => Promise<readonly QoderFallbackModel[]>
}

/** Qoder 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
export class QoderAdapter extends LlmAdapter {
  private readonly product: QoderProduct
  private readonly fetchImpl: typeof fetch
  /**
   * 按账号取出口 fetcher（`undefined` = 恒直连）。
   *
   * ⚠️ 与 `fetchImpl` **并存不是替代**：`fetchImpl` 是单测替身（优先级最高），
   * 本字段是生产代理。两者的优先级在 {@link fetcherForAccount} 里定死。
   */
  private readonly fetchFor: ((accountId: string) => typeof fetch) | undefined
  /**
   * 出口 fetcher 是否被**单测替身**顶掉了（= 注入的 `fetchImpl` 不等于全局 `fetch`）。
   *
   * ⚠️ 为什么用「`!==` 全局 `fetch`」而**不是**在构造期记一个
   * `options.fetchImpl !== undefined` 布尔：`ratelimit-misreport-behavior.spec.ts`
   * 这类既有用例是**构造后直接 `adapter.fetchImpl = 替身`** 的（拿不到构造参数），
   * 构造期布尔对它恒为 false ⇒ 实现落到 `fetchFor` / 全局 `fetch` ⇒ 真发网络，
   * 全量跑起来表现为 `expected 'TRANSPORT' to be 'QUOTA_EXCEEDED'`（本轮实测）。
   * 而「引用不等于全局 `fetch`」这一判据**同时覆盖**「构造期注入」与「事后赋值」。
   *
   * ⚠️ 也不能只把两个分支调序了事 —— `fetchImpl` 在构造期已被 `?? fetch` 填满，
   * 靠判空无法区分「注入」与「默认」。
   *
   * ⚠️ 残余弱点（如实登记）：调用方注入一份**恰好等于全局 `fetch` 的引用**时会被
   * 判成「未注入」—— 但那时两种语义**没有可观察差异**，不构成缺陷。
   */
  private get hasInjectedFetchImpl(): boolean {
    return this.fetchImpl !== fetch
  }
  /**
   * ⚠️ **2026-10-08 Task 7b：三个方法收敛到共享骨架** `createModelCatalog`。
   * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架，
   * 现在只剩 `toCatalogEntry`（本家私有形状 + 静态表判据 + 倍率格式）。
   */
  private readonly catalog: ModelCatalog
  /**
   * **远端**模型目录缓存（成功拉取后保留 20 分钟）。
   *
   * ⚠️ 2026-10-20 前本家**恒用编译期兜底表**（一次远端请求都不发），
   * 上游改价/改免费额度/上下架模型都不会反映 —— 用户报障
   * 「DeepSeek-Flash 上游已经 0×（免费）了，插件还显示 0.1」。
   * 现在远端优先、兜底表只作回退（见 `src/qoder-catalog.ts`）。
   */
  private remoteModels: QoderFallbackModel[] | undefined
  /**
   * 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
   *
   * ⚠️ 与 `remoteModels` **并存**、不是替代：前者存「有哪些模型」，
   * 本字段存「何时读到的」（只有前者的目录永不刷新）。
   */
  private catalogAt = 0
  /** 目录加载闸门：并发去重 + 失败/空结果冷却。 */
  private readonly catalogGate: RemoteCatalogGate
  /**
   * **静态兜底表专用**的第二套骨架（只在 `resolveModel` 的并集回退里用）。
   *
   * ⚠️ 存在的唯一理由：`resolveModel` 与 `listModels` 共用 `loadCatalog()`，
   * 而前者要「远端 ∪ 静态表」、后者要「远端独占」。故把静态表也包成一套
   * `ModelCatalog`，让**骨架自己的装配逻辑**（裸名/context/reasoning）
   * 复用到回退路径上，而不是在适配器里重写一遍。
   * `loadCatalog` / `syncCatalog` 都是同步静态表 ⇒ 零网络。
   */
  private readonly fallbackCatalog: ModelCatalog

  constructor(private readonly options: QoderAdapterOptions) {
    super()
    this.product = options.product ?? QODER
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fetchFor = options.fetchFor
    this.catalogGate = new RemoteCatalogGate(
      options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded },
    )
    // ⚠️ 共享骨架（Task 7b）：门控 → 读目录 → 黑名单 → 回填 → 三态。
    // ⚠️ `loadCatalog` 走**远端优先**（内有新鲜度判据），`syncCatalog` 是**同步**
    //    视图（远端未落地时回退兜底表）—— 两者分工见 `ModelCatalogConfig` 的注释。
    this.catalog = createModelCatalog(
      { accountPool: options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        // ⚠️ 未知 id 保守报 ['text']（宁可少报能力，也不报服务端可能不认的模态）。
        unknownModelInputModalities: () => ['text'] as const,
        syncCatalog: () => this.syncCatalogEntries(),
        /**
         * ★ **强制重拉**（后台 20 分钟刷新器 + 「用户改设置」）。
         *
         * ⚠️ 与 `loadCatalog` 的差别：后者自带新鲜度判据 ⇒ 新鲜时**不拉**；
         * 本回调要的是「无视新鲜度，强制拉一次」。故先清时刻再调同一方法
         * —— **不另写一份拉取逻辑**（两条路的上游行为才不会分叉）。
         */
        refresh: async () => {
          this.catalogAt = 0
          await this.ensureRemoteModels()
        },
      },
    )
    this.fallbackCatalog = createModelCatalog(
      { accountPool: options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.fallbackEntries(),
        syncCatalog: () => this.fallbackEntries(),
        unknownModelInputModalities: () => ['text'] as const,
      },
    )
  }

  /**
   * 可中止的休眠；信号中止时立即 resolve（不抛错，由调用方检查 signal）。
   *
   * ⚠️ **必须响应 `signal`**：排队等待最长可达 30 分钟，用户中途取消会话时
   * 不能让 generator 卡在 `setTimeout` 里 —— 那会表现为「点了停止但没反应」。
   */
  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.options.sleep !== undefined) {
      await this.options.sleep(ms, signal)
      return
    }
    if (ms <= 0 || signal?.aborted === true) return
    await new Promise<void>((resolve) => {
      const onAbort = (): void => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * 复用本适配器**同一套**选号编排解析凭据（供插件内部的原生搜索使用）。
   *
   * ## 为什么需要这个转发方法
   *
   * `options` 是构造器的 `private readonly`，插件其余模块从外部读
   * `adapter.options.resolveCredential` 会**编译失败**（`strict: true`）。
   * 而原生搜索**必须**与聊天链路用同一个 `resolveCredential` 实例 ——
   * 另建一份会让「enabled 过滤 / 模型级限流 / 免费判定 / 余额分档 / 池兜底 /
   * 账本回报」这六步在两条链路上漂移（与 `BuddyAdapter.resolveCredentialFor`
   * 同款理由）。
   *
   * ⚠️ `modelId` **必须透传**：它同时决定模型级限流过滤与免费判定，
   * 吞掉会让搜索选到聊天链路不会选的号（例如正在限流期的号）。
   *
   * @param modelId - 本次请求的模型 id（取自当前会话路由）。
   * @returns 选中账号的凭据；无可用账号时为 `undefined`。
   */
  async resolveCredentialFor(modelId: string | undefined): Promise<QoderCredential | undefined> {
    return await this.options.resolveCredential(modelId)
  }

  /**
   * 原生搜索：执行**一次单 query**，返回投影成官方 `sources[]` 形态的结果。
   *
   * ## 协议（全部来自官方客户端源码 + 真机实测，2026-10-14）
   *
   * | 项 | 值 |
   * |---|---|
   * | host | 本产品的 `encryptedInferBase`（CN `gateway.qoder.com.cn`；国际实测 `center.qoder.sh` / `api2.qoder.sh` 均可） |
   * | path | `/api/v1/webSearch/oneSearch` |
   * | body | `{ payload: JSON.stringify({query, timeRange:'NoLimit', contents:{...}}), encodeVersion:'1' }` |
   * | 信封 | body 由 **WASM 加密**；请求头由 `prepareRequest` 生成（含 `Authorization: Bearer COSY.<载荷>.<签名>`） |
   * | 响应 | `{ requestId, pageItems: [{title, link, snippet, publishedTime, hostname, hostLogo}], searchInformation }` |
   *
   * 官方客户端对应实现（`qoder-worker-runtime` 的 `tPl` / `APl` / `$rA`）：
   * ```js
   * let n = i.prepareRequest(A, e, "POST", "auth", t, void 0)
   * return { url: n.url, headers: kc(n.headers), body: n.body ?? t, free: () => n.free() }
   * ```
   *
   * ## ⚠️ 三个必须遵守的点
   *
   * 1. **`QoderEncryptedInfer` 每次建、每次 `dispose()`**：`gluePromise` 是进程级
   *    单例，`QoderContext` 是 wasm 堆上的 Rust 对象，不释放会让堆只增不减，
   *    长上下文会话最终以裸 `RuntimeError: unreachable` 暴毙（真实事故史见
   *    `qoder-wasm.ts` 文件头）。用 `try/finally` 而非顺序调用。
   * 2. **`publishedTime` / `hostname` / `hostLogo` 一律丢弃**：官方 output schema
   *    有 `additionalProperties: false`，多传字段会让 `createSuccessResult` 抛
   *    `ToolOutputError`，**整条调用失败**（不是少一条结果）。
   *    ⚠️ **但 `publishedTime` 其实有对应字段**（PR95 审计修正）：官方
   *    `dsh-tool-web` 的 output schema 与 seam 的 `WebSearchSource` **都**声明了
   *    可选的 `publishedAt?: string`（语义就是「provider 给的发布时间戳」）。
   *    原注释把三个字段一锅端说成「schema 不允许」，那对 `hostname` /
   *    `hostLogo` 成立，对 `publishedTime` **不成立**。
   *    ⚠️ **本次仍照原样丢弃**：接它需要先确认 Qoder 的 `publishedTime` 确实是
   *    ISO-8601 字符串（seam 的类型注释如此声明，但我们**没有真机取证**），
   *    而接错的后果是整条调用失败（`ToolOutputError`）—— 收益（多一列时间）远
   *    小于风险。**待办**：取一次真实响应确认格式后再接。
   * 3. **`X-Session-ID` 用随机 UUID**：实测不传也能 200，但官方客户端会带；
   *    这里跟随官方行为。它与账号无关，只是会话标识。
   * 4. **自己 arm 一份 20s 预算**（PR95 审计修正）：只透传 `signal` 会让
   *    `NativeSearchCodes.timeout` / `aborted` 在本路径永不产生，而契约注释却
   *    声称「各适配器 20s 预算小于官方 30s」⇒ 注释与实现不符。
   *
   * @param query - 单个查询串（已由工具层 trim + 去重）。
   * @param credential - `resolveCredentialFor` 的返回值（本方法自己收窄）。
   * @param signal - 取消信号（工具层传多 query 的 batch signal）。
   */
  async searchOnce(query: string, credential: unknown, signal: AbortSignal): Promise<NativeSource[]> {
    const c = credential as QoderCredential | undefined
    const accessToken = typeof c?.security_oauth_token === 'string' && c.security_oauth_token.length > 0
      ? c.security_oauth_token
      : (typeof c?.access_token === 'string' ? c.access_token : '')
    if (accessToken.length === 0 || typeof c?.machine_id !== 'string' || c.machine_id.length === 0) {
      throw new WebNativeError(
        `${this.product.id} search has no usable account; sign in to a ${this.product.id} account `
        + `from the Jet Hub panel first. The current route is "${this.product.id}". `
        + 'Only the user can change accounts.',
        NativeSearchCodes.noAccount,
      )
    }

    const host = this.product.encryptedInferBase
    const endpoint = `${host}/api/v1/webSearch/oneSearch`

    // ⚠️ 每次新建 + `finally` 释放（理由见上方第 1 点）。
    let client: QoderEncryptedInfer | undefined
    try {
      client = await QoderEncryptedInfer.create({
        user: { uid: c.uid ?? '', securityOauthToken: accessToken },
        machineId: c.machine_id,
        metadata: { ...this.product.clientMetadata },
        host,
      })

      // ① 构造 payload（照官方 `WebSearchTool` 的字段与默认值）
      const payload = {
        query,
        timeRange: 'NoLimit',
        contents: { mainText: false, markdownText: false, summary: false },
      }
      // ② 信封（官方的 `{ payload, encodeVersion }`）
      const bodyJson = JSON.stringify({ payload: JSON.stringify(payload), encodeVersion: '1' })
      // ③ 签名（WASM 生成 url + 全套 Cosy-* 头）
      const req = client.prepareRequest(host, '/api/v1/webSearch/oneSearch', 'POST', 'auth', bodyJson, undefined)

      // ④ 发送（headers 原样透传；`X-Session-ID` 跟随官方行为）
      // ⚠️ 用**可注入** fetcher 而不是模块级 `fetch`：单测要拦上游，
      //    而这一层**必须**用真 WASM 生成签名（签名无法 mock），故只能换 fetch。
      //
      // ⚠️ **必须按账号取出口**（真实报障 2026-10-21）：本端点的 host 是
      //    `encryptedInferBase`，与国际版的推理通道**同一个墙外域**（SNI 阻断）。
      //    这一层漏接代理的症状是「聊天通了、联网搜索恒 10.7s 超时」——
      //    看起来像搜索功能坏了，实则是出口没走代理。故与推理通道同源取 fetcher。
      //    这里用 `currentAccountId()` 而不是循环里的 `activeAccountId`：
      //    搜索是**独立一次调用**（不在 `_stream` 的换号循环里），没有那个变量。
      //
      // ⚠️ 优先级与推理主路径**必须一致**（`fetchImpl` 注入 > `fetchFor` > 全局）：
      //    两处判序不同会让「推理走了代理、搜索没走」这类半接状态无从察觉。
      const searchFetcher = this.hasInjectedFetchImpl
        ? this.fetchImpl
        : this.fetchFor === undefined
          ? this.fetchImpl
          : this.fetchFor(this.options.currentAccountId?.() ?? '')

      // ⚠️⚠️ **必须自己 arm 一份预算**（PR95 审计修正的真实缺口）：本模块此前
      //    只透传 `signal`，于是 `NativeSearchCodes.timeout` / `aborted` 在 Qoder
      //    路径**永不产生**，而契约注释却声称「各适配器的 20s 预算小于官方 30s」
      //    —— 注释与实现不符（buddy 有、qoder 没有）。用 `AbortSignal.any` 熔合
      //    调用方取消、外层 deadline 与本预算三者。
      const timeout = AbortSignal.timeout(NATIVE_SEARCH_TIMEOUT_MS)
      const composed = AbortSignal.any([signal, timeout])

      let response: Response
      try {
        response = await searchFetcher(req.url, {
          method: 'POST',
          headers: { ...req.headers, 'X-Session-ID': randomUUID() },
          body: req.body,
          signal: composed,
        })
      } catch (error) {
        // ⚠️ 归因读 `signal.reason` 的形状，**不能先判 `signal.aborted`**：
        //    外层 `tool-call-timeout-policy` 的 deadline 到期时布尔值同样为真。
        //    判据与实测对照见 `native-search-contract.ts` 的 `classifyNativeAbort`。
        const stop = classifyNativeAbort(composed)
        if (stop === 'aborted') {
          throw new WebNativeError(`${this.product.id} search aborted`, NativeSearchCodes.aborted, { cause: error })
        }
        if (stop === 'timeout') {
          const budget = timeout.aborted
            ? `after ${NATIVE_SEARCH_TIMEOUT_MS}ms`
            : 'before this search returned (the host tool budget elapsed)'
          throw new WebNativeError(
            `${this.product.id} search timed out ${budget}.\n\n`
            + `The request used endpoint ${JSON.stringify(endpoint)}. `
            + 'Search uses the same account as chat but a separate endpoint. '
            + 'Retry, or narrow the request; if it keeps timing out the endpoint or network may be unreachable.',
            NativeSearchCodes.timeout,
            { cause: error },
          )
        }
        // 非 abort 的传输失败（DNS / TLS / 连接重置）：归 `upstream`，
        // 与 buddy 的 `transport error` 腿同口径。
        throw new WebNativeError(
          `${this.product.id} search request failed: ${errorMessage(error)}\n\n`
          + `The request used endpoint ${JSON.stringify(endpoint)}. `
          + 'Search uses the same account as chat but a separate endpoint. '
          + 'If the network is unreachable or the endpoint is wrong, the user must decide how to proceed.',
          NativeSearchCodes.upstream,
          { cause: error },
        )
      }

      if (!response.ok) {
        const detail = await readQoderErrorDetail(response)
        throw new WebNativeError(
          `${this.product.id} search request failed (HTTP ${response.status})${detail}\n\n`
          + `The request used endpoint ${JSON.stringify(endpoint)}. `
          + 'Search uses the same account as chat but a separate endpoint. '
          + "If the account's sign-in has expired, guide the user to sign in again from the Jet Hub panel; "
          + 'the endpoint does not need changing.',
          NativeSearchCodes.upstream,
        )
      }

      let json: unknown
      try {
        json = await response.json()
      } catch (error) {
        throw new WebNativeError(
          `${this.product.id} returned a non-JSON search response.\n\n`
          + `The request used endpoint ${JSON.stringify(endpoint)}. `
          + 'Expected a JSON body with { pageItems: [{ title, link, snippet }] }.',
          NativeSearchCodes.badResponse,
          { cause: error },
        )
      }

      // ⚠️ 响应体先过 `asRecord`：JSON `null` 时直接读 `.pageItems` 会抛
      //    `TypeError`，而我们想要的是「响应无法解析」这条业务错误。
      const record = asRecord(json)
      const items = record?.pageItems ?? record?.page_items
      if (!Array.isArray(items)) {
        throw new WebNativeError(
          `${this.product.id} returned an unparseable search response: "pageItems" is not an array.\n\n`
          + `The request used endpoint ${JSON.stringify(endpoint)}. `
          + 'Expected { pageItems: [{ title, link, snippet }] }. '
          + 'This usually means the upstream API changed, or the account lacks search permission.',
          NativeSearchCodes.badResponse,
        )
      }

      const sources: NativeSource[] = []
      for (const raw of items) {
        // ⚠️ 必须先挡 `null` / 非对象：`pageItems: [null]` 时读 `.link` 会抛
        //    `TypeError`，导致**整条工具调用**失败，与本段意图（畸形条目丢弃）相反。
        const item = asRecord(raw)
        if (item === undefined) continue
        // ⚠️ Qoder 的 url 字段叫 **`link`**（不是腾讯的 `url`）。
        const url = typeof item.link === 'string' ? item.link : ''
        // ⚠️ `url` 是官方 schema 必填项；给不出 url 的条目直接丢弃，
        //    否则 `createSuccessResult` 会抛 `ToolOutputError`（整条调用失败）。
        if (url.length === 0) continue
        const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : undefined
        const snippet = typeof item.snippet === 'string' && item.snippet.length > 0 ? item.snippet : undefined
        sources.push({
          url,
          ...title === undefined ? {} : { title },
          ...snippet === undefined ? {} : { snippet },
        })
      }
      return sources
    } catch (error) {
      // ⚠️ wasm trap（裸 `unreachable`）必须被改写成人话（与聊天链路同款处理
      //    见 `src/qoder-adapter.ts` 的 `buildRequest`）。
      throw describeWasmFailure(error)
    } finally {
      // 🔴 **释放失败绝不能顶替 `try` 块里的原始错误**（真实缺陷，2026-10-12 审计）：
      //    JS 的 `finally` 里 `throw` 会**无条件覆盖** `try` 里的 `throw`。
      //    而 `dispose()` → `freePointer()` 的 catch 里确实会 rethrow。
      try { client?.dispose?.() } catch { /* 静默：不覆盖原始错误 */ }
    }
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
   * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 按 id 取**当前**目录条目（远端优先，回退编译期兜底表）。
   *
   * ⚠️ **不能用构造期的静态索引**：只存在于远端的模型（如 `fast`）查静态表会得到
   * 「未知」，而本方法与 `stream()` 都把它当**能力判据**用 —— `accio` 记过同款教训
   * （把「未知」当「明确不支持」会让能力**静默变窄**：图片被拒、档位消失）。
   */
  /**
   * 按 id 取条目，供**能力/元数据**判据使用：**远端优先，未命中回退编译期兜底表**。
   *
   * ## ⚠️⚠️ 为什么必须是「两份目录的并集」，而不是只用远端
   *
   * 第一版把它写成 `catalogSource().find(...)`（远端落地后静态表完全不参与），
   * 被独立审计打穿（缺陷 1，已复现）：**远端目录是「按账号」下发的**，
   * 一个免费额度号只拿到 2 条；此时静态表里其它 15 条模型会被判成「未知」
   * ⇒ `inputModalitiesFor` 报 `['text']` ⇒ `stream()` **硬拒图片**
   * （`UNSUPPORTED_CONTENT`），同时 `resolveModel` 的 name 退化成裸 id、
   * `context`/`reasoning` 消失、请求体的 `display_name`/`max_input_tokens`/
   * `is_reasoning` 一并退化。
   *
   * | 场景 | 只查远端（第一版） | 并集（现行） |
   * |---|---|---|
   * | `dmodel` + 远端大目录 | ✅ | ✅ 远端优先 |
   * | `dmodel` + 远端只剩 2 条（免费号） | ❌ 硬拒图片 + 元数据退化 | ✅ 回退静态表 |
   * | `fast`（只在远端有） | ✅ | ✅ 远端命中 |
   *
   * ⚠️ **菜单（`listModels`）仍以远端为准** —— 这条并集只作用于
   * 「能力/元数据判据」，不改变「有哪些模型可选」。本仓同型铁律见
   * `docs/agent-notes/client-ui.md` 的「判『某个 id 在不在目录里』时两个目录
   * 来源必须取并集」（Issue IKJW33）：让**能力**判据取并集，让**可选项**保持单一来源。
   */
  private catalogModel(id: string): QoderFallbackModel | undefined {
    return this.catalogSource().find((model) => model.id === id)
      ?? this.product.fallbackModels.find((model) => model.id === id)
  }

  /**
   * 模型接受的输入模态。
   *
   * 按**模型**判定（目录条目的 `supportsImage`），不是按 provider 一刀切。
   * 未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
   * 也不要报一个服务端不认的模态（请求会失败）。
   *
   * ⚠️ 判据取自 `catalogModel()`（**远端 ∪ 静态表**）—— 只取远端会让
   * 「按账号收缩的目录」把静态表里已知的模型判成未知（见该方法的表）。
   */
  private inputModalitiesFor(model: string): readonly ('text' | 'image')[] {
    return this.catalogModel(model)?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率/免费标记）。
   *
   * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
   * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名与倍率随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
   *
   * ⚠️ **2026-10-08 Task 7b**：骨架（含上面这条理由）已上移到共享实现
   * `src/model-catalog.ts`，此处只剩委托。
   *
   * ⚠️ **2026-10-08 复审**：本方法上方原先还压着**一段无主的 JSDoc**
   * （以「模型目录。」开头、讲「Qoder 的模型列表端点需要 WASM 签名」）——
   * 它本来是某个已被删掉的方法的文档，删方法时留下了壳。
   * 它与紧邻的本块连在一起看像「同一个方法有两套互相矛盾的文档」。
   * 已删除。
   *
   * ⚠️ **那段旧文档里「恒用产品兜底表、不发网络请求」这句已于 2026-10-20 作废**：
   * 本家现在与其余 12 家同形 —— 远端优先（`src/qoder-catalog.ts`）、
   * 兜底表只作回退。见 `catalogSource()` 的注释。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.catalog.listAllModels()
  }

  /**
   * 把本家目录条目（**远端优先**，回退兜底表）转成共享骨架的中间结构。
   *
   * ⚠️ 远端条目经 `src/qoder-catalog.ts` 归一成与兜底表**同形**的结构后才到这里
   * ⇒ 倍率/档位/能力三条判据对两条来源**完全同源**（不会出现「远端少了某个
   * 字段于是倍率不显示」这类分叉）。
   */
  private toCatalogEntry(model: QoderFallbackModel): CatalogEntry {
    const reasoning = this.reasoningForEntry(model)
    return {
      id: model.id,
      name: qoderDisplayName(model),
      // ⚠️ `resolveModel` 用**裸名**（与 trae/loomy/raccoon 一致）：
      // 价格只属于选择列表语境。本家原本用 `entry.name`（兜底表的裸名）。
      bareName: model.name,
      // ⚠️ 模态判据按 **id** 查**静态表**（`inputModalitiesFor(model: string)` 的形态）
      // —— 这是本家私有的判据，骨架不认识。
      // ⚠️ 三态：本家恒返回数组（未声明时**保守报 `['text']`**，见原注释：
      // 「宁可少报能力，也不要报一个服务端不认的模态」）⇒ 不会是 undefined。
      inputModalities: model.supportsImage === true ? ['text', 'image'] : ['text'],
      ...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
      ...reasoning !== undefined ? { reasoning } : {},
      /**
       * ⚠️ **必须透出**（缺陷 2，2026-10-20 审计）：Jet Hub 的「免费额度」分组
       * **只**认 `model.isFree === true`（`plugin-src/client/model-groups.js`），
       * 而 `cline-adapter.ts` 的成文约定也是「`isFree` 必须透出」。
       *
       * 改造前本家从未写这个键 ⇒ 免费模型**全被归进「按量计费」**；
       * 改造后解析层（`qoder-catalog.ts`）已产出 `isFree`，但装配层漏了，
       * 于是端到端仍只到「展示名里带 `· 免费`」为止。
       */
      ...model.isFree === true ? { isFree: true } : {},
    }
  }

  /**
   * 该条目的思考档位。
   *
   * ⚠️ **`reasoning` 是「思考强度」选择器出现在模型菜单里的唯一入口**
   * （composer 读 `resolveModel().reasoning`）。此前本适配器**只声明了
   * `context`，从不声明 `reasoning`** → 中国版/国际版全都看不到档位选择器，
   * 尽管目录早已下发 `thinking_config`（用户报障「qoder中国版可以设置思考档位，
   * 我们应该按照他的设置给出可设置的档位选择」）。
   */
  private reasoningForEntry(
    entry: QoderFallbackModel,
  ): LlmResolvedModelInfo['reasoning'] {
    // 思考档位：见 `qoderEffortsFor` 的三条口径（含「关闭思考」的追加规则）。
    const efforts = qoderEffortsFor(entry)
    if (efforts.length === 0) return undefined
    const fallback = entry.defaultEffort
    return {
      efforts: efforts.map((id) => ({
        id: ReasoningEffortId(id),
        name: QODER_EFFORT_NAMES[id] ?? id,
      })),
      // ⚠️ `defaultEffort` 必须落在 `efforts` 内 —— DSH 会直接拿它发请求，
      // 给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`
      // （同 `trae-adapter.ts` 的教训）。
      ...fallback !== undefined && efforts.includes(fallback)
        ? { defaultEffort: ReasoningEffortId(fallback) }
        : {},
    }
  }

  /**
   * 目录来源：**远端优先**，未落地时回退编译期兜底表。
   *
   * ⚠️ 回退不是「优化」而是**必需**：纯插件用户（或上游目录接口故障时）
   * 若目录为空，DSH 的 `buildModelCatalog` 会把该 provider 判成「没有模型」
   * 而**整个隐藏**（`providerCatalogVisible` 之外的第二层门）。
   */
  private catalogSource(): readonly QoderFallbackModel[] {
    return this.remoteModels ?? this.product.fallbackModels
  }

  /** 同步视图（`listAllModels()` 与 `CatalogEntry` 转换共用）。 */
  private syncCatalogEntries(): readonly CatalogEntry[] {
    return this.catalogSource().map((model) => this.toCatalogEntry(model))
  }

  /** 编译期兜底表的条目视图（第二套骨架专用；同步、零网络）。 */
  private fallbackEntries(): readonly CatalogEntry[] {
    return this.product.fallbackModels.map((model) => this.toCatalogEntry(model))
  }

  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    await this.ensureRemoteModels()
    return this.syncCatalogEntries()
  }

  /**
   * 该模型是否**消耗 0 积分**（免费额度模型）。
   *
   * ## 为什么必须有这个方法（真实报障 2026-10-21）
   *
   * 用户开着「锁定永久积分」，用**免费模型**（CN `Qwen3.8-Flash` / `DeepSeek-Flash`、
   * 国际版 `Qwen3.8-Max` / `Qwen3.8-Flash`）请求，却报「没有可用账号 ⋯ 当前账号的
   * 额度都属于长期 / 永久」。
   *
   * 根因：`src/credential-resolver.ts:368` 的免费短路**只在 `plan.isFreeModel`
   * 存在时**才可能命中。本家装配层（`src/index.ts` 的两处 `balance:`）**从未传
   * `isFreeModel`** ⇒ 免费模型与付费模型走同一条余额分档路 ⇒ 锁定期间被
   * `allowPermanent=false` 一并拦下。报出的错误还**自相矛盾**：免费模型既不扣
   * 临时也不扣永久积分，说它「额度都是永久的」毫无意义。
   *
   * 这与 buddy / trae 的成文教训是同一个（`credential-resolver.ts:359-365` 的
   * 长注释记录了 buddy 那次报障）：**保护永久积分的闸门不该拦免费模型**。
   *
   * ## 判据：只认目录里明确的 `isFree`
   *
   * - 两条来源（远端目录 / 编译期兜底表）**同源**：`src/qoder-catalog.ts` 的
   *   `qoderRemoteModelToFallback()` 已把远端 `is_free` 归一成 `isFree` 并透出
   *   （`:425`），与兜底表的 `isFree: true` 是同一个字段 ⇒ 不存在「远端少了字段
   *   于是判不出免费」这种分叉。
   * - ⚠️ **不用 `priceFactor === 0` 代替**：`priceFactor` 是「计费倍率」，它等于 0
   *   与「这个模型免费」在本家是两条独立信号（CN `dfmodel` 就是
   *   `priceFactor: 0` + `isFree: true`，而国际版 `qmodel_38max` 是
   *   `isFree: true` + `priceFactor: 0.2` —— **免费但倍率非 0**）。用倍率推断免费
   *   会漏掉后者、并把倍率解析失败（undefined）误判成免费。
   * - **只在确定免费时返回 true**：查不到目录 / 解析失败一律 false。方向保守 ——
   *   宁可多走一次余额门（用户至多多一次网络请求），也不要把付费模型误判成免费
   *   （那会**真的烧掉永久积分**，是不可逆损失）。与 `BuddyAdapter.isFreeModel`
   *   同一约定。
   * - ⚠️ 远端目录懒加载，**必须先 `await ensureRemoteModels()`**：否则「直接进
   *   会话」等路径尚未加载目录，会静默退回被拦截的行为（trae 的同款教训见
   *   `TraeAdapter.isFreeModel` 的注释）。
   *
   * @param modelId - 模型 id（目录 key，如 `qfmodel`）。
   * @returns true 仅当目录明确标记 `is_free`。
   */
  async isFreeModel(modelId: string | undefined): Promise<boolean> {
    if (typeof modelId !== 'string' || modelId.length === 0) return false
    await this.ensureRemoteModels()
    // ⚠️⚠️ **必须走 `catalogModel()`（远端 ∪ 静态表），不得走 `catalogSource()`**
    // （2026-10-21 合并审计发现，阻断级；本节实现初版就是 `catalogSource().find(…)`
    //  —— 与 {@link catalogModel} 的注释里记过的那个「缺陷 1」**逐字同型**）。
    //
    // ## 为什么
    //
    // 远端目录是**按账号**下发的：免费额度号实测只拿到 **2 条**
    // （`qfmodel` + `dfmodel`，见 `docs/agent-notes/providers-qoder.md`）。
    // 而 `catalogSource()` 是 `remoteModels ?? fallbackModels` —— 远端**一旦落地
    // 就把静态表整体顶掉** ⇒ 静态表里其余那些标了 `isFree: true` 的模型被判成
    // 「未知 ⇒ 非免费」。
    //
    // ## 后果（实测复现，2026-10-21）
    //
    // 免费模型被判收费 ⇒ 跳过 `credential-resolver.ts` 的「免费模型不受锁定约束」
    // 短路 ⇒ 锁定永久积分时被 `allowPermanent=false` 拦下、报出
    // 「额度都属于永久」这类**与事实相反**的错误 —— 正是本家 2026-10-21
    // 真实报障（`src/index.ts` 的 qoder 文案把用户推向「解锁永久积分」）
    // **原地复发**，且**零日志**。
    //
    // 实测（`lib/` 重建后真跑 `isFreeModel`）：
    // ```
    // ①远端收缩目录（无免费） isFreeModel(qmodel_38max) = false   ★ 应为 true
    // ①远端收缩目录（无免费） isFreeModel(qfmodel)       = false   ★ 应为 true
    // ②远端只含 qmodel_38max isFreeModel(qfmodel)       = false   ★ 应为 true
    // ③未接线远端            isFreeModel(qmodel_38max) = true    ✓
    // ```
    //
    // ⚠️ 同一模型的两条判据自相矛盾：`resolveModel()`（走并集）会正常给出
    //    `Qwen3.8-Flash`，而本方法说它「不是免费」。
    //
    // ⚠️ 方向是不对称的：判**收费**只是让用户用不上（可恢复）；
    //    判**免费**会绕过锁定**真烧掉永久积分**（不可逆）。
    //    故这里用并集是「远端优先、静态表兜底」——**不会**把收费模型判成免费
    //    （兜底表的 `isFree` 是策展过的显式标记，不是推断）。
    return this.catalogModel(modelId)?.isFree === true
  }

  /**
   * 懒加载远端模型目录（**每 20 分钟**一次；失败/空结果走闸门冷却）。
   *
   * 三条口径与其余 12 家逐字同构：
   * 1. 入口用 `isCatalogFreshFor`（多一条「用户刚改设置⇒立即失效」的正交腿）；
   * 2. 并发去重与失败冷却交给 `RemoteCatalogGate`（同一份实现，不自己写判据）；
   * 3. **只在成功时**记 `catalogAt`（失败也记会让一次网络抖动把 TTL 上界刷掉，
   *    下一轮要再等满 20 分钟才发现上游没恢复）。
   */
  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined
      && isCatalogFreshFor(this.product.id, this.catalogAt, this.nowImpl())) {
      return
    }
    await this.catalogGate.run(async () => {
      const models = await this.loadRemoteModels()
      if (models.length === 0) return false
      this.remoteModels = [...models]
      this.catalogAt = this.nowImpl()
      return true
    })
  }

  /**
   * 真发一次远端目录请求（失败返回空数组，由闸门记冷却）。
   *
   * ⚠️ **不在这里解析凭据**：取数是接线层注入的 `fetchRemoteModels`
   *（= `QoderAuth.fetchModels(pool)`），它只做池的**只读**读取。
   * 理由见 `QoderAdapterOptions.fetchRemoteModels` 的长注释
   *（走 `resolveCredential` 会把「本次实际使用的账号」改写成目录用的账号）。
   */
  private async loadRemoteModels(): Promise<readonly QoderFallbackModel[]> {
    const fetchRemote = this.options.fetchRemoteModels
    if (fetchRemote === undefined) return []
    try {
      return await fetchRemote()
    } catch (error) {
      this.options.warn?.(
        `[qoder] 模型目录读取失败，退用内置兜底表：${errorMessage(error)}`,
      )
      return []
    }
  }

  private nowImpl(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * ★ **后台目录刷新入口**（`src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`）。
   *
   * ⚠️⚠️ **必须显式转发** `catalog.refresh`：`ModelCatalog` 上的成员**不会**
   * 自动变成适配器的成员（`dead-model-store.ts` 的 `pruned()` Proxy 只透传
   * **适配器自己的**成员）。漏转发 ⇒ 刷新器「已武装」却对本家**空转**，
   * 且**零日志** —— 这条陷阱在 `accio-adapter.ts` 有逐字记录（`be42b25` 踩过）。
   * ⚠️ 与 `options.refresh`（HTTP 401 后的**凭据**续期）**不是同一件事**，
   * 两者同名纯属巧合，**不得合并**。
   */
  async refresh(): Promise<void> {
    await this.catalog.refresh?.()
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(_provider)
  }

  /**
   * 解析模型元信息（**能力/元数据的并集回退**，见 `catalogModel()` 的表）。
   *
   * ## ⚠️ 为什么这里要路由到两套目录
   *
   * `resolveModel` 与 `listModels` **共用** `loadCatalog()`，但两者的正确口径不同：
   * - `listModels`（**菜单**）必须**只**给当前账号真能用的模型 ⇒ 远端独占；
   * - `resolveModel`（**元数据**）必须认识「可能正在被使用、但不在当前账号菜单里」
   *   的模型（会话开着、目录随账号收缩）⇒ 远端 ∪ 静态表。
   *
   * 故：远端目录认识该 id 就照旧走它（新值优先）；不认识而静态表有，就交给
   * **静态表专用的第二个骨架实例** —— 复用骨架自己的装配逻辑（裸名 / context /
   * reasoning 三态），**不在这里重写一遍**（那会是同一语义的第二套判据）。
   */
  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // ⚠️ **必须先把远端目录拉到位再判路由**（TTL 闸门内是 no-op，零额外请求）：
    //    冷缓存下 `catalogSource()` 还是静态表，此时远端独有的模型（如 `fast`）
    //    会被误判成「远端不认识」而路由到兜底骨架 ⇒ 名字退化成裸 id。
    //    （第一版漏了这一步，被既有用例「远端独有的模型…」当场抓住。）
    await this.ensureRemoteModels()
    if (this.catalogSource().some((entry) => entry.id === model)) {
      return this.catalog.resolveModel(provider, model, signal)
    }
    return this.fallbackCatalog.resolveModel(provider, model, signal)
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `LobsteraiAdapter` 同款 shim。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片能力按**模型**判定（兜底表 supportsImage）。
    //
    // 这里**不能**放宽成「总是接受」：DSH 在 LlmRuntime 里按适配器播报的
    // `inputModalities` 决定要不要把图片投影成文本占位符，声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes('image')) {
        throw new LlmError(
          `qoder: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('qoder: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        // ⚠️ 先试**请求版本**（缩放），拿不到才发原图 —— 见 projectRequestImage。
        const projected = await projectRequestImage(ref, {
          readImageRequest: this.options.readImageRequest,
          pixelBudget: this.product.imagePixelBudget,
          maxBytes: this.product.imageMaxBytes,
        })
        const image = projected ?? await readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 获取凭据（过期则先静默续期）
    let credential = await this.options.resolveCredential(options.model, options.sessionId)
    if (credential === undefined || isQoderExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model, options.sessionId)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('qoder: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 补齐 **uid**（加密推理必需）。
    //
    // ⚠️ `uid` 是后加字段，旧凭据里没有；缺它时 WASM 会产出**签名无效**的
    // 请求，服务端回 `Signature invalid (101)`（真实缺陷，用户报障）。
    // 这里调用注入的钩子补一次（实现会调 userinfo 并回写凭据）。
    credential = await this.ensureUid(credential)

    // 3. 走**加密推理**路径（客户端真实链路，认模型目录 key）。
    //
    // 目录 key（`qfmodel` 等）只有这条路能用；公开端点是另一套通用名。
    const messages = serializeMessages(options.messages, imageUrls)
    const systemText = options.system !== undefined && options.system.length > 0
      ? options.system
      : undefined

    /** 最后一条 user 消息即本轮提问；其余作为历史。 */
    const userMessages = messages.filter((m) => m.role === 'user')
    const lastUser = userMessages.at(-1)
    // ⚠️ 带图消息的 content 是**多模态数组**（见 `qoderContentParts`），
    // 只判 `typeof === 'string'` 会让 `chat_context.text` / `originalContent`
    // 退化成空串 —— 那会让模型收到「一张没有配文的图」，与用户实际输入不符。
    // 故两种形态都要取文本（数组时取其中的 text 块）。
    const userText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : (Array.isArray(lastUser?.content)
          ? (lastUser.content as Array<{ type?: unknown; text?: unknown }>)
              .filter((block) => block.type === 'text')
              .map((block) => String(block.text ?? ''))
              .join('')
          : '')
    // ⚠️ 必须走 buildQoderHistory：早期内联的「只留 content 为字符串」过滤器
    // 会丢掉 assistant 的 tool_calls（content 为 null）与 tool 的 tool_call_id，
    // 使多步工具调用彻底坏掉（模型看不到自己调用过什么）。
    const history = buildQoderHistory(messages)
    // ⚠️ 工具定义必须真的下发：加密端点的顶层 `tools`。不下发时模型只能
    // 用正文里的 XML 文本臆造工具调用 → harness 认不出 → 任务终止
    // （用户报障「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」）。
    const tools = buildQoderTools(options.tools)

    const fallback = this.catalogModel(options.model)

    /**
     * 会话自动命名（`purpose: 'session-title'`）的思考与预算决策（issue IKKVDH）。
     *
     * DSH 用 **64 token** 发标题请求且**不传 `reasoningEffort`**，而宿主会把
     * `qoderEffortsFor` 声明的默认档注入进来。本家的关闭档是 `none`
     * （由 `supportsDisable` 追加，见 `qoderEffortsFor`）⇒ 声明了它的模型
     * 关得掉；未声明的模型只能抬预算兜底。
     *
     * ⚠️ 在 `buildRequest` **之外**算一次：它在 401 重试时会被再次调用，
     * 每次重算虽无害但没必要（与 raccoon 的 `thinking` 同款理由）。
     */
    const titlePlan = planSessionTitleThinking({
      purpose: options.purpose,
      requestedEffort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      declaredEfforts: fallback === undefined ? [] : qoderEffortsFor(fallback),
      maxTokens: options.maxTokens,
    })

    /** 用给定凭据构造一次加密请求（首次与 401 重试共用，避免两处漂移）。 */
    const buildRequest = async (c: QoderCredential): Promise<QoderInferRequest> => {
      // 🔴 `client` 持有 wasm `QoderContext`，**本次构造用完必须释放**：
      // 该类每次请求都新建实例，不释放则进程级共享的 wasm 堆只增不减，
      // 长上下文会话最终以裸 `RuntimeError: unreachable` 暴毙
      // （8/8 历史命中都在 Qoder 路由上；见 `src/qoder-wasm.ts` 文件头）。
      // 用 `try/finally` 而非顺序调用：`create` / `prepareInfer` 抛错时同样要
      // 释放，否则**异常路径**反倒成了泄漏最多的那条路。
      let client: QoderEncryptedInfer | undefined
      try {
        client = await QoderEncryptedInfer.create({
          user: {
            uid: c.uid!,
            securityOauthToken: c.security_oauth_token ?? c.access_token,
          },
          machineId: c.machine_id,
          metadata: { ...this.product.clientMetadata },
          host: this.product.encryptedInferBase,
        })
        return client.prepareInfer({
          modelKey: options.model,
          userText,
          ...(systemText !== undefined ? { systemText } : {}),
          isReasoning: fallback?.supportsThinking ?? false,
          history,
          // 工具定义：这是模型**唯一**能学到函数 schema 的通道，
          // 缺了它模型只能用正文 XML 臆造调用（真实缺陷）。
          tools,
          /**
           * 会话自动命名（`purpose: 'session-title'`）的思考与预算决策（issue IKKVDH）。
           *
           * DSH 用 **64 token** 发标题请求且**不传 `reasoningEffort`**，而宿主会把
           * `qoderEffortsFor` 声明的默认档注入进来。本家的关闭档是 `none`
           * （由 `supportsDisable` 追加）⇒ 声明了它的模型关得掉；
           * 未声明的模型只能抬预算兜底。
           */
          ...(titlePlan.maxTokens !== undefined ? { maxTokens: titlePlan.maxTokens } : {}),
          ...(titlePlan.effort !== undefined ? { reasoningEffort: titlePlan.effort } : {}),
          ...(fallback?.supportsImage !== undefined ? { isVl: fallback.supportsImage } : {}),
          // 官方 `model_config` 的 display_name / max_input_tokens 必须带上。
          ...(fallback?.name !== undefined ? { displayName: fallback.name } : {}),
          ...(fallback?.contextWindow !== undefined ? { maxInputTokens: fallback.contextWindow } : {}),
          // ⚠️ **`business` 必填**，否则服务端把请求路由到错误的后端节点。
          //
          // 实测（2026-09-20）：不带 `business` 时 `qfmodel`（Qwen3.8-Flash）
          // 恒落到故障节点 `oa_qwen-plus-2025-04-28` 并返回
          // `[FAIL]node:... msg:Execution failed`；补上 `business` 后立即正常
          // （其余模型如 `qmodel_38max` 恰好不受影响，故早期排查易误判为
          // 「该模型服务端故障」）。`agent` / `sec_scan` 等取值都能通。
          //
          // 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
          // —— 服务端按 `business.type` 选路由池，缺字段会走异常分支。
          business: { type: 'agent' },
        })
      } catch (error) {
        // wasm trap（裸 `unreachable`）在 `qoder-wasm.ts` 的 glue 层已被改写；
        // 这里再兜一次，覆盖 glue 之外的路径（如 `finally` 里的栈指针回退），
        // 保证**任何**情况下都不会有裸 `unreachable` 冒到 UI。
        // 非 trap 错误原样返回，行为逐字节不变。
        throw describeWasmFailure(error)
      } finally {
        // ⚠️⚠️ **释放失败绝不能顶替 `try` 块里的原始错误**（真实缺陷，2026-10-12 审计实测）。
        //
        // JS 语义：`finally` 里的 `throw` **无条件覆盖** `try` 里的 `throw`。
        // 而 `dispose()` → `freePointer()` 的 catch 里**确实会 rethrow**
        //（见 `qoder-wasm.ts` 的 `freePointer`）—— 它自己的注释就写了
        //「堆耗尽时它同样会 trap」，即**恰在本修复要治理的那个场景下**会抛。
        //
        // 后果（实测）：上游的 401 / AUTH 等错误被改写成「WASM 堆耗尽」，
        // 而且 `describeWasmFailure` 返回的是**裸 `Error`**（非 `HarnessError`）
        // ⇒ 外层 `normalizeLlmFailure` 把它归成 `UNKNOWN` ⇒ **同时丢掉
        // `SERVER` / `AUTH` 这些可重试性判据**（本仓「错误保真」红线的形态）。
        //
        // ⇒ 取舍与 `expiry-sync.ts` 的「回写失败只记日志、不上抛」同款：
        //   释放是**清理动作**，它失败不该改变本次请求的结论。
        //
        // ⚠️ 本类**没有 logger 通道**（`QoderAdapterOptions` 里没有 `ctx`），
        //    故此处**刻意静默**吞掉 —— 不为一条清理失败的日志去新开一条通道。
        try {
          client?.dispose()
        } catch {
          // 见上：清理失败不上抛、不改写本次请求的结论。
        }
      }
    }

    // 3. 发送（⚠️ 头必须原样透传：Authorization 是 WASM 生成的
    //    `Bearer COSY.<载荷>.<签名>`，用普通 Bearer 覆盖会 403 Signature invalid）
    //
    // ## 三种 403 的语义**互不相同**，必须分开处理
    //
    // | 形态 | 判据 | 处理 |
    // |---|---|---|
    // | **排队** | 业务码 `10605`（`model_queued`） | 按服务端给的延迟**内部等待后重试**（见下） |
    // | 重复请求 | 业务码（客户端 `_TA="duplicate_request"`） | 不刷新凭据，直接重发一次 |
    // | 认证失败 | 业务码 `105`（`auth_error`）或 401 | 续期凭据后重试（**唯一**该走 refresh 的情形） |
    //
    // ⚠️ **真实缺陷**（用户报障，2026-09-27）：旧实现把**所有** 401/403 都当认证
    // 失败 → 排队时白白续期一次，再落到 harness 的 5 次通用退避（500/1000/2000/
    // 4000/8000 ≈ 共 15.5 秒）—— 而服务端明确要求等 30 秒，于是**永远等不到**；
    // 中国版那条「等 2 秒就能成功」的瞬时排队也因走错路径而反复失败。
    const queueDeadline = Date.now() + resolveQueueTimeoutMs()
    let queueAttempts = 0
    let authRefreshed = false
    let duplicateRetried = false
    let response: Response
    /**
     * 已尝试过的账号 id（额度受限切号用）。
     *
     * ⚠️ 必须跨重试保留（不能在每次迭代里新建）：它是「**已试过哪些账号**」的
     * 记录，用来保证每个账号最多试一次、试完才判定「全部受限」。每次迭代重置
     * 会让切换在两个账号之间**无限来回**。
     */
    const triedAccounts = new Set<string>()
    /**
     * **当前生效账号的 id**（会随额度受限切号而更新）。
     *
     * ⚠️ 是**局部可变**状态、而不是每次都问 `this.options.currentAccountId()`：
     * 那个回调返回的是「池当前的默认账号」，一旦我们切到下一个账号它**不会跟着变**
     * —— 若用它标记，切到 B 后失败时会**再标记一次 A**，而 B 从未被标记，
     * 下次取号又把 B 选中，于是在 A/B 之间**反复空转**
     *（写单测时实测到了：标记记录是 `['acct-A','acct-A']` 而非 `['acct-A','acct-B']`）。
     */
    let activeAccountId = this.options.currentAccountId?.()
    if (activeAccountId !== undefined && activeAccountId.length > 0) {
      triedAccounts.add(activeAccountId)
    }
    /**
     * 取**当前生效账号**该走的 fetcher（真实报障 2026-10-21）。
     *
     * ⚠️ **在循环内按 `activeAccountId` 现取**（每次发送前调一次，不缓存）：
     * 换号后出口必须跟着换 —— 循环外固化一份会让换号后**仍走旧账号的代理**，
     * 症状是「换了号还是超时」且**无任何报错**，属最难查的一类静默失效
     * （与 `gemini-adapter.ts` 的同名函数同因，见其注释）。
     *
     * ⚠️ 优先级：`fetchImpl`（单测替身，**且必须是显式注入**）> `fetchFor`（生产代理）
     * > 全局 `fetch`。单测只要传了 `fetchImpl` 就完全绕过代理，不必关心池子。
     *
     * ⚠️ 判「是否注入」必须靠 {@link hasInjectedFetchImpl}，**不能**写成
     * `this.fetchImpl !== fetch`：调用方注入一份**包着全局 fetch 的包装器**时
     * 两者引用不同，该判据会误判成已注入 ⇒ 生产出口被单测替身顶掉。
     * ⚠️ 也不能只把两个分支调序了事 —— `fetchImpl` 在构造期已被 `?? fetch`
     * 填满，调序后 `fetchFor` 反而**永远**轮不到（生产代理全失效）。
     *
     * ⚠️ `activeAccountId === undefined` ⇒ 传空串给解析器：它会去查
     * `QODER_PENDING_PROXY_KEY`（登录预置那条），查不到就直连。
     */
    const fetcherForCurrentAccount = (): typeof fetch => {
      if (this.hasInjectedFetchImpl) return this.fetchImpl
      if (this.fetchFor === undefined) return this.fetchImpl
      return this.fetchFor(activeAccountId ?? '')
    }
    // 4. 剥掉加密端点的响应信封，交给统一的 OpenAI SSE 消费器。
    //
    // ⚠️ **必须放在重试循环内**：排队错误的**第二种**下发形态是
    // **HTTP 200 + SSE 内嵌 `{code:"10605",…}` 帧**（真实缺陷，用户报障
    // 2026-09-27 —— 第一版修复只覆盖了 HTTP 403 形态，于是这条路径被
    // SSE 消费器归为 `SERVER` 直接抛给 harness，以 500…8000ms 快退避重试
    // 5 次，而服务端要求等 30 秒，**永远等不到**）。
    // ⚠️⚠️ **报错前缀必须取自 `this.product.id`，绝不能硬编码 `'qoder'`**
    //（真实报障，2026-10-21 用户贴出：
    //  `aggregate: qodercn（dfmodel）上游失败：qoder: Error in upstream response
    //   (provider_error/model_error) code=SERVER`）。
    //
    // 中国版与国际版**共用本适配器类**（`QoderAdapter` 只靠 `options.product` 区分，
    // 见构造函数 `this.product = options.product ?? QODER`），而旧实现把三处前缀
    // 全写成了字面量 `'qoder'`：
    //
    // ① 两个 HTTP 失败分支（`QUOTA_EXCEEDED` / `httpErrorCode`）；
    // ② 信封剥离函数的第二个实参（渠道标签）；
    // ③ SSE 消费器选项里的 `label` 字段。
    //
    // 后果：**中国版**（`qodercn`）的报错看起来像国际版（`qoder`）的问题 ——
    // 聚合层已经把渠道名（`qodercn`）写在**外层**，内层又冒出另一个渠道名，
    // 排查时会一头雾水（两个渠道的凭据、端点、额度池**完全不同**）。
    //
    // ⇒ 用 `this.product.id`（取值恰好是 `'qoder'` / `'qodercn'`），
    //   国际版的输出**逐字节不变**，中国版从此说自己的名字。
    const label = this.product.id
    /**
     * 本轮已用掉的**传输级**额外尝试次数（每次换一个账号，见
     * {@link QODER_TRANSPORT_MAX_RETRIES}）。
     *
     * ⚠️ **已知语义变化**（2026-10-31 审计登记）：换号会把上一个账号塞进
     * `triedAccounts`，于是同一请求内**后续**的额度/上游换号会少一个候选 ——
     * 极端情况下（传输失败 + 后续额度错）可能因为「池已试空」提前抛
     * `QUOTA_EXCEEDED`，而那个被传输失败换下的号不会被回试。
     * 方向是刻意的（刚连不上的号在本次请求里不值得再试），且**不是永久损失**：
     * transport 不写冷却，宿主整请求重试时它仍在池里。
     *
     * ⚠️ 与 `queueAttempts` / `triedAccounts` 分开计数：排队是「服务端让我等」，
     * 传输失败是「这条出口不通」，两者的上限语义与代价完全不同。
     */
    let transportRetries = 0
    for (;;) {
      /**
       * ⚠️⚠️ **传输级失败必须能换号**（issue IKR5ZD，2026-10-28 现场取证）。
       *
       * 修前：这条 `sendEncrypted` 不在任何 `try` 里，`fetch` 抛出的
       * `fetch failed` 直接冒出整个重试循环 ⇒ 后面的 `switchAccountOnQuota`
       * **一次都执行不到**。而宿主把 `TRANSPORT` 当作可重试码（`DEFAULT_RETRYABLE_CODES`，
       * 5 次、退避 500ms→10s），于是 6 发全部回到**同一个账号、同一条出口、
       * 同一个 IP** —— 实测该域名有 2 个 A 记录、`dns.lookup` 只回第一个，
       * 连打 8 次建连**全部**落在 `47.57.188.188`。对「某条路由被阻断」而言，
       * 这等于**零重试**。
       *
       * 修法：每次重试都**换一个账号**（换号 = 换出口；每账号可配独立代理，见
       * `618a090`「国际版 SNI 阻断下唯一出路」）；**换不到号立即抛**（同号重连对
       * 阻断的路由无效，而瞬时抖动宿主已用退避重试 5 次兜了）；预算耗尽后同样
       * **抛出带 cause 链的原错误**。
       *
       * ⚠️ 覆盖范围仅**建连腿**（`sendEncrypted` 这一发）。**SSE 中途**的
       * `sse transport error` 由 `openai-compat.ts` 抛出、经
       * `classifyQoderFailure` 归 `other` ⇒ **不换号**：那时正文可能已吐了一半，
       * 换号重发会重复内容（与 zcode/accio 对「已产出内容后不换号」的取舍同向）。
       * 这是**刻意的边界**，不是漏做。
       *
       * ⚠️ 三类边界与 minimax 的 `minimaxFetchWithRetry` 同款：
       * ① **只处理传输错误**（HTTP 4xx/5xx 是服务端的明确答复，重试只会掩盖真因，
       *    那条路径在下面各自的分支里已处理，绝不能走到这里）；
       * ② **abort 绝不重试**（用户点了停止还继续发是不可接受的行为）；
       * ③ **耗尽后抛原错误**，保住 `cause`（上层要能程序化取真因）。
       */
      try {
        response = await this.sendEncrypted(await buildRequest(credential), options, fetcherForCurrentAccount())
      } catch (error) {
        if (!(error instanceof LlmError) || error.code !== 'TRANSPORT') throw error
        /**
         * ⚠️ 这里**不重复**判 `signal.aborted`：`sendEncrypted` 在转换前已经做过
         * 一次早退，abort 时它抛的是**原始错误**（非 `LlmError`）⇒ 上一行的
         * 类型/码判据必然先把它 rethrow 出去，本行之后不可能看到已 abort 的
         * `TRANSPORT`。写两处会让「删掉这一处」变成不可观测的等价变异
         *（2026-10-31 实测：加这行时删掉它全绿）。abort 的**唯一判据**留在
         * `sendEncrypted`，并由「abort ⇒ 只发一发」的行为用例守住。
         */
        if (transportRetries >= QODER_TRANSPORT_MAX_RETRIES) throw error
        /**
         * ⚠️ **不知道「当前是哪个账号」时直接抛**：换号要靠 `tried` 排除自己，
         * 而 `switchAccountOnQuota` 只有在 `activeAccountId` 非空时才 `tried.add`
         * —— 否则池可能把**同一个号**再给回来，白等一个 10s connect 超时。
         * 可达路径：探测适配器 `currentAccountId: () => entry?.id ?? ''`
         *（`src/index.ts` 的 `createProbeAdapter`）。生产推理路径恒有 id。
         */
        if (activeAccountId === undefined || activeAccountId.length === 0) throw error
        transportRetries += 1
        /**
         * ⚠️ **换号失败不得顶掉原始错误**（P2-8，2026-10-31 审计）：`getAvailableAccount`
         * 是池的读盘/内存路径，它抛错时若原样冒出，用户看到的是裸 `Error`
         *（无 `code`、无 `cause`）—— 与本修法「保住 cause 让人能排查」的主旨相反。
         * ⇒ 隔离它，失败就按「没有别的号可换」处理。
         */
        let switched: { credential: QoderCredential; accountId: string } | undefined
        try {
          switched = await this.switchAccountOnQuota(
            options,
            triedAccounts,
            activeAccountId,
            'transport',
          )
        } catch (switchError) {
          /**
           * ⚠️ **只吞「池读不出来」这类裸错误**：`LlmError` 是刻意的判断
           *（例如换到的新账号缺 `uid` ⇒ `MISSING_CREDENTIAL`），把它压成
           * 「没号可换」会让用户永远看不到「这个号没法用」—— 那是数据问题，
           * 必须如实报出来（本仓库「缺失必须显式」纪律）。
           */
          if (switchError instanceof LlmError) throw switchError
          switched = undefined
        }
        // 换不到号（池空 / 全是已试过的）⇒ **立即抛**，别在原地空转 10 秒：
        // 同号重连对「路由被阻断」无效，而宿主已经会用退避再试 5 次。
        if (switched === undefined) throw error
        /**
         * ⚠️ **这一行无法用行为用例守住，如实登记**（2026-10-31 对抗审计 m20）：
         * 把 `credential = switched.credential` 删掉后，第二发仍会**用旧凭据**
         * 发出（而 `activeAccountId` 已更新、出口也换了），但**所有 127 条用例仍绿**。
         * 原因是两份凭据的差异只体现在 WASM 生成的 `COSY` 签名内部（uid / machine
         * 加密后不可读），外部唯一能看到的 `Authorization` 每次请求都带新
         * `requestId` ⇒ 无法区分。实测过的两条替代判据也都失败：
         * ① 新凭据 `machine_id: ''` ⇒ 请求照常成功；② 缺 `uid` ⇒ 抛点发生在
         * `switchAccountOnQuota` **内部**的 `ensureUid`，与「是否采纳」无关。
         * ⇒ 保留本行，靠代码评审；**不要**为它编一条恒真用例。
         */
        credential = switched.credential
        activeAccountId = switched.accountId
        authRefreshed = false // 新账号可再续期一次
        continue
      }

      if (!response.ok && (response.status === 401 || response.status === 403)) {
        // ⚠️ 必须**先读体再判断**，且 body 只能读一次 —— 排队信息就藏在
        // `message` 那个 JSON 字符串里（见 `parseQoderQueueError`）。
        const errorText = await response.text().catch(() => '')
        const queueInfo = parseQoderQueueError(errorText)

        if (queueInfo !== undefined) {
          await this.waitForQueue(queueInfo, ++queueAttempts, queueDeadline, options)
          continue
        }

        // ⚠️ **额度受限也要切账号**（用户要求，2026-09-27）。
        //
        // ⚠️ 本分支**只认额度**（不并入 `classifyQoderFailure` 的 `auth`）：401/403
        // 的第一处置是**续期当前账号**（下面的 `authRefreshed` 分支），换号是续期
        // 失败后才该做的事 —— 把 `auth` 提到这里会让「凭据过期」直接换号、永远
        // 走不到续期路径（那是既有行为，不能改）。
        //
        // 这条与 SSE 层那条**必须都有**：Qoder 的额度错误实测走 SSE 通道
        // （HTTP 200），但若哪天服务端改成用 HTTP 状态码下发，只处理一条就会漏。
        // 两处调用**同一个** `switchAccountOnQuota`，不会漂移。
        if (isBillingBusinessCode(response.status) || looksLikeBillingError(errorText)) {
          const switched = await this.switchAccountOnQuota(options, triedAccounts, activeAccountId, 'quota')
          if (switched !== undefined) {
            credential = switched.credential
            activeAccountId = switched.accountId
            authRefreshed = false // 新账号可再续期一次
            continue
          }
          throw new LlmError(`${label}: ${errorDetail(errorText)}`, 'QUOTA_EXCEEDED', { status: response.status })
        }

        // 非排队：认证失败才续期（且每次请求最多一次，避免刷爆 userinfo）。
        if (!authRefreshed) {
          authRefreshed = true
          await this.options.refresh()
          const refreshed = await this.options.resolveCredential(options.model, options.sessionId)
          if (refreshed === undefined || refreshed.access_token.length === 0) {
            throw new LlmError(`${label}: credential expired and refresh failed`, 'AUTH', { status: response.status })
          }
          credential = await this.ensureUid(refreshed)
          continue
        }
        throw new LlmError(`${label}: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
      }

      // 重复请求（客户端 `duplicate_request`）：凭据没问题，重发一次即可。
      if (!response.ok && response.status === 409 && !duplicateRetried) {
        duplicateRetried = true
        continue
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        // ⚠️ 2026-10-21：本分支也要走**统一类别判定**（{@link classifyQoderFailure}）。
        //
        // 修前这里直接抛，于是 **429**（`RATE_LIMIT`）与 **5xx + provider_error**
        // 都不会换号 —— 后者正是用户真实报障（池里 2 个 `qodercn` 账号，
        // 第二个从未被尝试）。
        //
        // ⚠️ 401/403 **不归这里**（上面已处理，先续期再换号）；409 已单独处理。
        // 到此的是 429 / 5xx / 其余 4xx，正好是「类别判定」该管的范围。
        const statusCls = classifyQoderFailure(httpErrorCode(response.status), errorText)
        if (shouldRotateQoderAccount(statusCls)) {
          const switched = await this.switchAccountOnQuota(options, triedAccounts, activeAccountId, statusCls)
          if (switched !== undefined) {
            credential = switched.credential
            activeAccountId = switched.accountId
            authRefreshed = false // 新账号可再续期一次
            continue
          }
        }
        // 换不到号（或类别是 `other`）⇒ 按状态码如实归类抛出。
        // ⚠️ `statusCls === 'quota'` 时用 `QUOTA_EXCEEDED`：那个码在 DSH 的
        // `DEFAULT_RETRYABLE_CODES` 之外 ⇒ 不会被「白重试 5 次」；而 `httpErrorCode`
        // 对 402 已给 `QUOTA_EXCEEDED`，这里只是兜住「429 + 额度文案」的边界。
        throw new LlmError(
          `${label}: ${errorDetail(errorText)}`,
          statusCls === 'quota' ? 'QUOTA_EXCEEDED' : httpErrorCode(response.status),
          { status: response.status },
        )
      }

      // ⚠️ 消费 SSE 时**捕获流内排队错误**，走与 HTTP 层**完全相同**的等待逻辑。
      // `consumeOpenAiSse` 是生成器：无法「try 一次再重试」，故这里手动迭代，
      // 捕获到排队就等待后重发整条请求（排队期间未产出任何 chunk，可安全重放）。
      const inner = consumeOpenAiSse(
        unwrapQoderEnvelopeStream(response, label),
        { signal: options.signal },
        {
          label,
          firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
          chunkTimeoutMs: resolveChunkTimeoutMs(),
          ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        },
      )
      const iterator = inner[Symbol.asyncIterator]()
      let queued = false
      for (;;) {
        let step: IteratorResult<StreamChunk>
        try {
          step = await iterator.next()
        } catch (error) {
          if (error instanceof ModelQueuedError) {
            await this.waitForQueue(
              queueInfoOf(error),
              ++queueAttempts,
              queueDeadline,
              options,
            )
            queued = true
            break
          }
          // ⚠️ **额度受限（110）要标记 + 切账号**（用户要求，2026-09-27）。
          //
          // ⚠️ 必须**在这里**捕获（SSE 层）而不只在 HTTP 层：Qoder 的额度错误
          // 实测以 **HTTP 200 + SSE 内嵌帧** 下发（与排队同通道），
          // 只在 HTTP 层处理会漏掉真实链路。
          //
          // ⚠️ 2026-10-21 扩展：判据从「只认额度」改为**统一类别判定**
          // （{@link classifyQoderFailure}）。真实报障：上游回
          // `Error in upstream response (provider_error/model_error) code=SERVER`
          // 时，池里的第二个账号**从未被尝试** —— 那是「登录 N 个账号 ≠ N 倍
          // 可用性」的经典形态（`accio-adapter.ts:1598` 点名过同一个缺陷）。
          //
          // 传 `{ code, text }` 供文案腿使用（`provider_error` 是结构字段值，
          // 已随 `errorDetail` 拼进 message，故文案腿能命中）。
          const failureCall = failureCallOf(error)
          const streamCls = classifyQoderFailure(failureCall.code, failureCall.text)
          if (shouldRotateQoderAccount(streamCls)) {
            const switched = await this.switchAccountOnQuota(
              options,
              triedAccounts,
              activeAccountId,
              streamCls,
            )
            if (switched !== undefined) {
              credential = switched.credential
              activeAccountId = switched.accountId
              queued = true // 复用「回到循环顶部重发」的语义
              break
            }
            throw error // 无可用账号 → 如实抛出（已含原始语义）
          }
          throw error
        }
        if (step.done === true) break
        yield step.value
      }
      if (queued) continue
      return
    }
  }

  /**
   * 失败后：**按类别决定「写不写冷却」，然后切下一个账号**。
   *
   * ## 用户要求（2026-09-27，额度类）
   *
   * > qoder 碰到当日额度受限应该像 workbuddy/codebuddy 一样，设置一个模型受限时间
   * > （他们是返回错误中带时间，qoder 和 qodercn 需要自己设置当日 24:00 受限）
   * > 然后切换账号池中的下一个可用模型
   *
   * ## 2026-10-21 扩展：不再只服务「额度」一类
   *
   * 用户真实报障：池里 2 个 `qodercn` 账号，上游回
   * `provider_error`（归 `SERVER`）时**第二个账号从未被尝试** —— 因为旧实现
   * 把「写冷却」和「换号」绑死，且只有额度一条判据。
   *
   * ⇒ 拆成两张表（照 `accio` / `minimax` / `loomy` / `raccoon` / `trae` 的
   * 既有范式，见 {@link classifyQoderFailure} 的语义表）：
   * - {@link shouldRotateQoderAccount} 决定**换不换**；
   * - {@link recordsQoderRateLimit} 决定**记不记**。
   *
   * ## ⚠️ 与 buddy/CodeArts 的**关键差异**
   *
   * 它们的错误文案里**带重置时间**（`parseRateLimitError` 从中解析）；
   * Qoder 的额度**不带** —— 故这里用 {@link nextUtc8DayStartMs} **自己算**
   * 「UTC+8 当日 24:00」。**不能**复用 `parseRateLimitError`：它会因解析不到
   * 时间而退回「1 小时后」（`Date.now() + 3_600_000`），那对**按自然日**结算的
   * 额度是错的 —— 会让标记过早失效，用户 1 小时后再撞一次同样的墙。
   *
   * @param activeAccountId - **当前正在使用的**账号 id（见下）。
   * @param cls - 失败类别（决定写不写冷却）。**必填**：给出默认值会让调用方
   *   忘记传时静默退化成「一律记额度冷却」—— 那正是 2026-10-10「全池被封」的形态。
   * @returns 新凭据；无可用账号时 `undefined`（调用方如实抛出原错误）。
   */
  private async switchAccountOnQuota(
    options: GenerateOptions,
    tried: Set<string>,
    activeAccountId: string | undefined,
    cls: QoderFailureClass,
  ): Promise<{ credential: QoderCredential; accountId: string } | undefined> {
    const pool = this.options.accountPool
    if (pool === undefined) return undefined

    // ① **按类别**决定写不写冷却标记（`auth` / `upstream` 绝不写）。
    //
    // ⚠️ 只标记**该模型**（不标记账号全部模型）：额度是「模型 + 账号」维度的，
    // 该账号在别的模型上仍可能可用（`modelRateLimits` 的既有语义即如此）。
    //
    // ⚠️ 用的是调用方传入的 `activeAccountId`，**不是** `this.options.currentAccountId()`：
    // 后者是「会话启动时/池当前的默认账号」，一旦我们切换到下一个账号，它**不会
    // 跟着变** —— 若用它标记，切到 B 后失败时会**再标记一次 A**，而 B 从未被标记，
    // 下次取号又把 B 选中，导致在 A/B 之间**反复空转**（写单测时实测到了：
    // 标记记录是 `['acct-A','acct-A']` 而非 `['acct-A','acct-B']`）。
    //
    // ⚠️⚠️ **无论记不记账，都必须把 `activeAccountId` 加进 `tried`**：不记账时
    // 池的限流过滤器（`account-pool.ts:2241-2242`）不会排除它，`getAvailableAccount`
    // 极可能**又把这个刚失败的账号取回来** ⇒ 换号形同虚设、在同一个号上空转。
    // `tried` 是唯一不依赖记账的排除通道，故这一句不能跟着 `recordsQoderRateLimit`
    // 一起进 if。
    if (activeAccountId !== undefined && activeAccountId.length > 0) {
      if (recordsQoderRateLimit(cls)) {
        const resetAtMs = cls === 'quota'
          ? nextUtc8DayStartMs()
          : Date.now() + QODER_RATE_LIMIT_COOLDOWN_MS
        /**
         * ⚠️⚠️ **记账失败绝不能中断换号**（对抗审计 P2-1，2026-10-18 实证）。
         *
         * 池的写盘失败（磁盘满 / 权限）会抛裸 `Error`；若不隔离，它会冒到
         * `getAvailableAccount` 之前 ⇒ **整个轮换流程被掐断** ⇒ 一次写盘失败就
         * 退化成「零换号」—— 正是本函数要修的那个症状。
         *
         * ⇒ 两道纪律：① `try/catch` 隔离；② **即便记账失败也照常换号**
         *   （记账是「锦上添花」，换号是「本轮能不能成」）。
         */
        try {
          await pool.updateModelRateLimit(activeAccountId, options.model, resetAtMs)
        } catch (error) {
          // ⚠️ 记账失败**如实留日志**（静默吞掉会让「号没被标记」变成不可排查的
          // 现象 —— 本仓库记过多次同款）。拿不到 logger 时用 console.warn 兜底。
          const detail = `qoder: 写入限流标记失败（账号 ${activeAccountId} / 模型 ${options.model}）：${String(error)}`
          if (typeof console !== 'undefined') console.warn(detail)
        }
      }
      tried.add(activeAccountId)
    }

    // ② 取下一个可用账号。
    //
    // ⚠️ 必须传 `tried`：不排除就会拿回刚失败的那个、命中下面的检查而立即放弃切换。
    // 上面 ① 已把 `activeAccountId` 加进 `tried`（无论记不记账），这一句才能真正拦住。
    // （与 buddy 的注释同因，见 `buddy-adapter.ts` 的 1200 行附近。）
    const next = await pool.getAvailableAccount<QoderCredential>(this.product.id, options.model, tried)
    if (next === null || tried.has(next.entry.id)) return undefined
    tried.add(next.entry.id)

    const credential = next.credential
    // 切号后必须重新过一遍 uid 补齐（每个账号的 uid 不同，缺了会签名无效）。
    return { credential: await this.ensureUid(credential), accountId: next.entry.id }
  }

  /**
   * 排队等待（HTTP 层与 SSE 层**共用**）。
   *
   * 两处形态必须走同一套判据，否则会再次出现「只修了一条路径」的缺陷。
   */
  private async waitForQueue(
    queueInfo: QoderQueueInfo | undefined,
    attempts: number,
    deadline: number,
    options: GenerateOptions,
  ): Promise<void> {
    // ⚠️ **先判时间、再判次数**：时间上限是硬约束（用户可调），次数上限只是
    // 防御性兜底。反过来写会让「180 次空转」在绝大多数情况下先生效，
    // 使 `DSH_QODER_QUEUE_TIMEOUT_MS` **形同虚设**（写用例时实测到了）。
    //
    // ⚠️ 用 `>=` 而不是 `>`：上限为 **0** 是合法配置（「不等，立即判超时」），
    // 而同一毫秒内 `Date.now() > now + 0` 为 **false**，会让它**先等一次**才
    // 超时 —— 那与「0 = 不等待」的语义不符（单测专门守这一点）。
    if (Date.now() >= deadline) {
      throw new LlmError('qoder: 排队等待超时', 'QUEUE')
    }
    if (attempts > QUEUE_MAX_ATTEMPTS) {
      throw new LlmError(
        `qoder: 排队重试超过上限（${QUEUE_MAX_ATTEMPTS} 次）`,
        'QUEUE',
      )
    }    if (options.signal?.aborted === true) {
      throw new LlmError('qoder: 排队等待期间请求已取消', 'QUEUE')
    }
    const waitMs = qoderQueueDelayMs(queueInfo)
    // ⚠️ 拿不到服务端延迟时**不忙等**：用保守的短退避，避免瞬间烧掉机会
    // （客户端 W7c() 此时会退回 ltA() 指数退避）。
    await this.sleep(waitMs ?? 1_000, options.signal)
    // ⚠️ 这次检查**不是**上一次的重复：它检测的是「**等待期间**被中止」。
    // `AbortSignal.aborted` 是随时间的可变状态，但 TS 会静态窄化成字面量
    // `false` 而报「无重叠」—— 故经**不透明函数**读取，避免静态收窄掩盖
    // 这个真实场景（`await` 之后状态可能已变）。
    if (isAborted(options.signal)) {
      throw new LlmError('qoder: 排队等待期间请求已取消', 'QUEUE')
    }
    // ⚠️ 排队**不刷新凭据**、不换账号：它与认证和额度都无关。
  }

  /**
   * 确保凭据带 **`uid`**（加密推理必需），必要时经注入钩子补齐。
   *
   * ⚠️ 缺 uid 时**不能静默用空串发请求** —— 那样 WASM 会产出签名无效的
   * 请求，服务端回 `Signature invalid (101)`，用户看到的是「签名错误」
   * 而非「凭据不完整」，极难定位（真实缺陷）。这里宁可明确报错。
   */
  private async ensureUid(credential: QoderCredential): Promise<QoderCredential> {
    if (credential.uid !== undefined && credential.uid.length > 0) return credential

    const patched = await this.options.resolveUid?.(credential)
    if (patched?.uid !== undefined && patched.uid.length > 0) return patched

    throw new LlmError(
      'qoder: 凭据缺少 uid，加密推理无法签名（请重新登录该账号）',
      'MISSING_CREDENTIAL',
    )
  }

  /** 发送一次**加密**推理请求（`agent_chat_generation`）。
   *
   * @param fetcher 本次要走的 fetcher（由调用方按**当前生效账号**现取）。
   *   ⚠️ **必须由调用方传**而不是方法内自己取：换号后出口要跟着换，
   *   而 `this` 上没有任何字段能反映「循环里当前是哪个账号」。
   */
  private async sendEncrypted(
    request: { url: string; headers: Record<string, string>; body: string },
    options: GenerateOptions,
    fetcher: typeof fetch,
  ): Promise<Response> {
    const headers = new Headers(request.headers)
    headers.set('Accept', 'text/event-stream')
    try {
      return await fetcher(request.url, {
        method: 'POST',
        headers,
        body: request.body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        /**
         * ⚠️ 文案必须带**沿 `cause` 链的可操作信息**（issue IKR5ZD）：
         * 只写 `fetch failed` 时用户拿不到「连到哪个 IP / 是超时还是被重置 /
         * 超时多少毫秒」，也就无法判断该换 IP、换出口代理还是改超时。
         *
         * ⚠️ `cause` 仍原样挂上（`transportErrorDetail` 只影响 message）——
         * 上层若想程序化取原始错误，链路不能断。
         */
        throw new LlmError(`qoder: transport error: ${transportErrorDetail(error)}`,
          'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }
}

/**
 * 判断当前是否落在错峰折扣窗口内（本地推算）。
 *
 * ⚠️ **为什么不直接用目录的 `promotion.active`**：那是**目录下发那一刻**的
 * 快照，客户端长时间不重启就会过期 —— 用它会让用户在窗口外看到折后价
 * （按折扣价预期、实际按原价计费），或窗口内看不到折扣。
 * 窗口本身（`windowStart`/`windowEnd`）稳定，故按当前时间**本地推算**。
 *
 * 窗口按 **UTC+8** 计（目录 `timezone: Asia/Singapore`，与用户所在时区一致）；
 * 支持跨零点（如 22:00–08:00）。窗口字段缺失时回退到目录的 `active`。
 */
export function promotionActiveNow(promotion: QoderModelPromotion, now: Date): boolean {
  const { windowStart, windowEnd } = promotion
  if (windowStart === undefined || windowEnd === undefined) return promotion.active
  const toMinutes = (hhmm: string): number | undefined => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
    if (m === null) return undefined
    const h = Number(m[1]); const min = Number(m[2])
    return h < 24 && min < 60 ? h * 60 + min : undefined
  }
  const start = toMinutes(windowStart)
  const end = toMinutes(windowEnd)
  if (start === undefined || end === undefined) return promotion.active

  // 取 UTC+8 的「墙上时间」（目录时区与用户一致，故无需真实时区换算）
  const utc8 = new Date(now.getTime() + 8 * 3_600_000)
  const minutes = utc8.getUTCHours() * 60 + utc8.getUTCMinutes()
  return start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end
}

/**
 * 生成模型选择器里显示的名字。
 *
 * 形态（**与 TRAE / buddy 三 provider 统一**）：
 *
 * ```
 * Qwen3.8-Flash · 免费            ← priceFactor = 0
 * Qwen3.8-Max · x0.5→x0.2        ← 折扣窗口内：原价→折后价
 * Qwen3.8-Max · x0.5             ← 窗口外：只有原价
 * Sonus · x8                     ← 无促销
 * ```
 *
 * ⚠️ **倍率必须写进 `name` 而不是 `description`**：composer 的模型切换菜单
 * 只渲染 `name`（见 dsh-client-ui-model-selection 的 ModelSelect：
 * `children: model.name`），`description` 仅用于 `/model` 弹窗。
 *
 * ⚠️ **折扣统一用「原价→折后价」箭头**，不再附中文角标（如「错峰 4 折」）：
 * ① 旧形态只有折后价，看不出原价与折扣幅度；② 角标与数字**冗余**
 * （0.2/0.5 本就是 4 折）。TRAE（`x0.4→x0.2`）与 buddy（`x0.79→x0.50`）
 * 早就是这个形态，本次把 Qoder 对齐过去。
 *
 * ⚠️ 折后价**不直接采信目录的 `priceFactor`**：它是采集时刻的生效价，
 * 窗口切换后即失真。改为按 `beforePromotionPriceFactor × discountFactor`
 * 本地推算（实测三条全部吻合），窗口外则用原价。
 */
export function qoderDisplayName(model: QoderFallbackModel, now: Date = new Date()): string {
  const promo = model.promotion
  const before = promo?.beforePromotionPriceFactor
  const discount = promo?.discountFactor
  const hasPromo = promo !== undefined && before !== undefined && discount !== undefined
  const active = hasPromo && promotionActiveNow(promo, now)

  // 免费优先于一切（`0` 是合法倍率，不能显示成 `x0`）。
  if (model.priceFactor === 0) return `${model.name} · 免费`

  if (hasPromo && active) {
    // 折扣生效中：`原价→折后价`（与 TRAE / buddy 同形态）
    const effective = Number((before * discount).toFixed(4))
    return `${model.name} · x${before}→x${effective}`
  }

  // 窗口外用**原价**（有 promotion 时原价就是 before，而非采集到的折后价）；
  // 窗口外显示折后价会让用户按折扣价预期、实际被按原价计费。
  const price = hasPromo ? before : model.priceFactor
  return price !== undefined ? `${model.name} · x${price}` : model.name
}

/**
 * 在 `ctx.llm` 上注册 Qoder provider 路由与适配器。
 *
 * 路由名与展示名由产品配置驱动，得到 `qoder`。
 *
 * ⚠️ 刻意**不**向 DSH 声明可配置 provider（`registerConfigurableProviders`）——
 * 详见 `llm-register-compat.ts` 模块头。
 */
export function registerQoderLlm(ctx: Context, options: QoderAdapterOptions): QoderAdapter {
  const product = options.product ?? QODER
  const adapter = new QoderAdapter({
    ...options,
    // ⚠️ 两项都**只在调用方没给时**兜底：`onCatalogLoaded` 必须接到广播上
    //（远端目录异步落地后不广播 ⇒ 模型选择器永久停在冷启动那份兜底表），
    // `warn` 接 `ctx.logger`（否则「目录读取失败」是一条零日志的静默回退）。
    onCatalogLoaded: options.onCatalogLoaded ?? (() => { broadcastCatalogChanged(ctx) }),
    warn: options.warn ?? ((message: string) => { ctx.logger?.warn?.(message) }),
    product,
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  // 返回实例：Jet Hub「显示列表」需要 `listAllModels()`（不受黑名单影响、
  // 带最终展示名/倍率）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
  return adapter
}

// ─────────────────────── 原生搜索的支撑（2026-10-14） ───────────────────────

/**
 * 把未知值收敛成记录；非对象（含 `null`）返回 `undefined`。
 *
 * ⚠️ 与「返回 `{}`」不同：原生搜索的逐项过滤需要区分「不是对象」（丢弃）
 * 与「是空对象」。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** 从非 2xx 响应里取一段可读的上游说明（截断，且不回显敏感内容）。 */
async function readQoderErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    const trimmed = text.trim().slice(0, 300)
    return trimmed.length > 0 ? `: ${trimmed}` : ''
  } catch {
    return ''
  }
}
