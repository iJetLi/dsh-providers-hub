/**
 * TRAE（字节跳动 TRAE IDE）LLM 适配器。
 *
 * 骨架取自 `src/lobsterai-adapter.ts` / `src/buddy-adapter.ts`，但**载荷转换与 SSE 解析全部重写**。
 *
 * ## 与现有适配器的关键差异
 *
 * | 项 | TRAE | Buddy / LobsterAI |
 * |---|---|---|
 * | 请求体 | OpenAI → SOLO 转换（function/config_name/tools 归一化） | 透传 OpenAI 格式 |
 * | SSE 格式 | SOLO 自定义事件（output/token_usage/done/error）→ 转 OpenAI | 标准 OpenAI SSE |
 * | 请求头 | `Cloud-IDE-JWT <token>` + X-* 系列 | Bearer / X-LobsterAI-Client-* |
 * | 图片 | 不支持 | Buddy / LobsterAI 支持 |
 * | prompt_cache_key | 不发 | Buddy 发（腾讯前缀缓存） |
 *
 * 复用的是 `src/sse.ts` 的三个工具函数（`readWithIdleTimeout` / `resolveToolPairing` /
 * `normalizeToolArguments` / `isTruncatedArguments`）——它们处理的是 OpenAI 协议层的通用陷阱。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { createModelCatalog, isCatalogFreshFor, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { reasoningRankOf } from './reasoning-ladder.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import {
  TRAE_MAX_CONTEXT_TOKENS,
  clampTraeMaxTokens,
  isTraeExpired,
  parseTraeSSELine,
  isTraeModelCallable,
  traeMaxModeFields,
  traeSOLOHeaders,
  traeUsageFromTokenUsage,
  transformToSOLOBody,
  type TraeCredential,
  type TraeReasoningConfig,
  type TraeRemoteModel,
} from './trae.js'
import { TRAE, type TraeFallbackModel, type TraeProduct } from './trae-product.js'
import { classifyTraeError, classifyTraeStreamCode, isRotatableTraeStreamCode, recordsTraeRateLimit, shouldRotateTraeAccount } from './trae-errors.js'
import { traeCooldownFor } from './trae-cooldown-table.js'
import { normalizeHarnessMessages } from './message-shape.js'
import { createBlankReasoningSuppressor, createDsmlMarkerNormalizer, createReasoningLoopDetector, fixDsmlMarkers, hasUsableToolName, classifyToolArguments, toolArgsInvalidBlocks, toolArgsInvalidIsSoleOutput, isProseTruncatedByStopString, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, reasoningLoopFailure, resolveEmptyResponseReason, resolveToolPairing, splitThinkTaggedContent, stripBareThinkCloseTagIfEnabled, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled, toolArgsInvalidFailure } from './sse.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import { reportLedgerAccount } from './token-ledger.js'
import { planSessionTitleThinking } from './session-title.js'
// ⚠️ `detail` 那条腿**只留一份实现**（`openai-compat.ts`）：本仓库 6 份同义的
// `errorDetail` 各写一条判据必然漂移（IKLBSH A1）。
import { detailFieldText } from './openai-compat.js'

/** 本适配器注册的 provider 路由名。 */
export const PROVIDER = 'trae'

/**
 * 推理档位 wire 值 → 展示名。
 *
 * ⚠️ 与 LobsterAI 不同，TRAE 的 `reasoning_effort_config.options` 是**单值**
 * （`light` / `high` / `extra_high` …），该字符串既是产品侧档位名、也是发给
 * 上游的取值，故本表**只用于展示**，不做 wire 映射。
 * 未登记的取值回退原样显示，避免远端新增档位时显示空白。
 */
const TRAE_EFFORT_NAMES: Readonly<Record<string, string>> = {
  light: 'Light',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extra_high: 'Extra High',
  xhigh: 'XHigh',
  max: 'Max',
}

/**
 * 推理档位强度序（数值越大越强）。
 *
 * ⚠️ **只用于挑「默认档」，不参与 wire 取值** —— wire 值就是远端
 * `reasoning_effort_config.options` 里的字符串本身，本表改了也不会影响下发。
 *
 * ⚠️ 表本体已收敛到 `src/reasoning-ladder.ts`（网关做「OpenAI 规范名 → 私有 id」
 * 翻译时用的是**同一份**强度序）。两处各写一份必然漂移，而漂移的症状是
 * 「同一个档位在挑默认档与在网关翻译时算出不同结果」。
 */
/**
 * 从 `options` 里挑**最强**的一档作默认值。
 *
 * 三条规则逐级退化：
 * 1. 显式含 `max` → 用它（最直观的「最高档」语义，也覆盖 LobsterAI 那套
 *    `level: max → openclawLevel: xhigh` 的习惯）；
 * 2. 否则取**已登记强度序**里排名最高的；
 * 3. 若全都未登记（上游新增了档位）→ 取数组**最后一项**（远端按强度升序给出）。
 *
 * 之所以不直接用「数组最后一项」：远端不保证升序，而规则 2 对已知档位是确定的。
 */
function strongestTraeEffort(options: readonly string[]): string | undefined {
  if (options.length === 0) return undefined
  if (options.includes('max')) return 'max'
  let best: string | undefined
  let bestRank = -1
  for (const option of options) {
    const rank = reasoningRankOf(option)
    if (rank !== undefined && rank > bestRank) {
      best = option
      bestRank = rank
    }
  }
  return best ?? options[options.length - 1]
}

/**
 * 挑默认思考档：**上游 `default_level` 优先**，缺失或非法才退到 `fallback`。
 *
 * ## 为什么是「采信上游」而不是自己定规则
 *
 * 早期实现一律取最强档（用户当时的要求），但那会让每次请求都顶格思考 ——
 * 思考 token **计入 `completion_tokens`**，与正文共享额度，于是正文更早撞
 * `max_tokens`、首字更慢。改为采信上游后，实测（2026-09-26，`solo_agent` 可见集）：
 *
 * | 模型 | options | 上游 `default_level` | 旧默认 | 新默认 |
 * |---|---|---|---|---|
 * | `deepseek-v4.1-flash` | light,high,extra_high | `high` | extra_high | **high** |
 * | `glm-5.2` | high,extra_high | `high` | extra_high | **high** |
 * | `qwen3.8-max` | light,high,extra_high | `high` | extra_high | **high** |
 * | `Doubao-Seed-2.1-Pro` | light,high | `high` | high | high |
 * | `glm-5.3` | light,high,extra_high | `extra_high` | extra_high | extra_high |
 * | `kimi-k3` | light,high,extra_high | `extra_high` | extra_high | extra_high |
 *
 * ⚠️ 注意后两行：上游**自己**在 `glm-5.3` / `kimi-k3` 上选了最高档。故不能改成
 * 「固定取次高档」——那会把这两个上游认可的最高档无谓降下来。
 *
 * ⚠️ `default_level` 是**外部输入**，必须校验它真的在 `options` 里：DSH 会拿
 * `defaultEffort` 直接发请求，给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`
 * （见 `dsh-llm` 的 `resolveCallWithInfo`）。实测上游确实会下发
 * `default_level: 'max'` 而 `options` 里没有 `max` —— 此时必须退到 `fallback`，
 * **不能**照抄。
 *
 * @param config 远端档位配置（`options` / `defaultLevel`）。
 * @param fallback `default_level` 不可用时的兜底档（通常是最强档）。
 */
function defaultTraeEffort(
  config: TraeReasoningConfig,
  fallback: string | undefined,
): string | undefined {
  const declared = config.defaultLevel
  if (declared !== undefined && declared.length > 0 && config.options.includes(declared)) {
    return declared
  }
  return fallback
}

/** SSE 空闲超时（分两阶段，环境变量可覆盖）。 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_TRAE_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_TRAE_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/** 限流重置时间的本地兜底（毫秒，1 小时）。 */
const TRAE_RATE_LIMIT_FALLBACK_MS = 3_600_000

/** 单次请求最多换几个账号（含首次），防雪崩。 */
const TRAE_MAX_ROTATE = 3

/**
 * **流内**（SSE `event:error`）可换号错误的哨兵码。
 *
 * ## 为什么需要它（真实缺陷）
 *
 * 换号逻辑整体位于 `if (!response.ok)` 分支内 —— 只在 **HTTP 非 2xx** 时执行。
 * 而上游确实会用 **HTTP 200 + SSE `event:error`** 下发额度/限流错误
 * （实测依据见 {@link traeStreamErrorMessage} 的 4001 记录）。
 * 那条路径下换号代码**一行都不执行**，直接抛 `QUOTA_EXCEEDED` ——
 * 而它**不在 DSH 的可重试集合**里，用户看到的就是「不会切换账号」。
 *
 * 故流内错误在「**尚未产出任何内容**」时用本码抛出，交由
 * {@link TraeAdapter.stream} 的外层循环捕获并换号重发。
 *
 * ⚠️ **必须与真实 provider-neutral 码区分**：这个码**只在本适配器内部**
 * 传递，绝不会漏给 DSH（外层要么换号成功，要么改抛真实错误码）。
 * 用一个明显不可能与 DSH taxonomy 冲突的字符串，避免调用方误判。
 */
const TRAE_ROTATABLE_STREAM_ERROR = 'TRAE_ROTATABLE_STREAM_ERROR'

/**
 * 哨兵错误的**结构化随行物**（2026-10-05 加）。
 *
 * 为什么不用 `LlmErrorOptions` 的自由字段：那是 dsh-llm 的**官方校验契约**
 * （只有 status / providerRetryAfterMs / requestId，塞 `{kind}` 会 TS 报错）；
 * 而 `Error.cause` 的语义本就是「附加结构化诊断」，是标准通道。
 * 外层换号循环从 `cause` 里取回流内 errorCode，重分类后按类别定冷却时长
 * （详见使用处注释）。
 */
class TraeStreamErrorCause extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'TraeStreamErrorCause'
  }
}

/**
 * 流内错误码 `4006`：**请求体过大**（上游原文 `content is too large for AI to understand`）。
 *
 * ## 为什么必须单列（Gitee issue IKKX0T 的独立实测）
 *
 * 归类点原先是行内三元 `code === 1005 || code === 4008 ? 'QUOTA_EXCEEDED' : 'SERVER'`，
 * 于是 4006 落到 **`SERVER`** —— 而 `SERVER` **在** harness 的
 * `DEFAULT_RETRYABLE_CODES`（`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`，
 * 已在 `dsh-llm` 实测确认）里 ⇒ 同一个巨型请求体会被**原样重发 5 次**
 * （退避 500/1000/2000/4000/8000ms，约 15.5 秒），而它每次必然同样失败。
 *
 * ⚠️ **归错的代价是不对称的**（与 `buddy-adapter.ts` 的 `GATEWAY_PROMPT_TOO_LONG` 同因）：
 * 体积超限是**确定性**失败，重试毫无意义；归成 `CONTEXT_WINDOW_EXCEEDED` 则
 * ① 不在可重试集合里（不白重试），② 还能触发 `dsh-compaction-basic` 的溢出压缩
 * ——它的 listener 第一行就是 `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()`。
 * 图片撑大的请求体正是压缩能真正缓解的那一类。
 *
 * ⚠️ **与 `4001` 的区别**：4001 是「模型不可调用」（换号/压缩都无益，如实报错）；
 * 4006 是「这一次的载荷太大」（压缩/少发图能救）。两者**不可合并**。
 *
 * ⚠️ **只认 4006 这一个码，不做措辞匹配**：同族的 `502 + HTML` 形态
 * （issue 记录的另一条 trae 报文）与「上游真的崩了」**无法区分** ——
 * 把它也归成溢出会让真正的 5xx 故障失去重试机会（`upstreamStatusOrFallback`
 * 的注释记着同一条方向：5xx 必须原样透出）。
 */
function isStreamPayloadTooLargeError(code: number): boolean {
  return code === 4006
}

/**
 * 流内 `event:error` → provider-neutral 错误码。
 *
 * 抽成函数而不是继续写在行内三元里：这张表要**逐格**可测（本仓库的既有教训是
 * 「同一张判据表的两个实现必须逐格同构」，散落在调用点就没法对拍）。
 *
 * 顺序即优先级，且**不可重排**：
 * 1. `4006` 体积超限 → `CONTEXT_WINDOW_EXCEEDED`（不重试 + 可压缩）；
 * 2. `1005` / `4008` 额度类 → `QUOTA_EXCEEDED`（终态，用户需签到/换号）；
 * 3. 其余（含 `4001` 模型不可调用）→ `SERVER`。
 *
 * ⚠️ 第 3 条保留 `SERVER` 是**有意**的：它覆盖的多数是上游真 5xx/未知故障，
 * 那类确实该重试。本函数只把「确定为确定性失败」的码挑出来。
 */
function streamErrorCode(code: number): string {
  if (isStreamPayloadTooLargeError(code)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (code === 1005 || code === 4008) return 'QUOTA_EXCEEDED'
  return 'SERVER'
}

/**
 * 机器指纹轮换间隔（每 N 次请求换一代，仅在显式启用时生效）。
 *
 * 对齐 `Trae2api-cn/src/trae_client.py:220` 的 `max_uses = 3 + rand(0,2)`：
 * 即每 3~5 次请求换一次。这里取固定 4 次，避免引入随机性导致测试不可复现。
 */
const TRAE_MACHINE_ID_ROTATE_EVERY = 4

/**
 * TRAE 适配器选项。
 */
export interface TraeAdapterOptions {
  credentialRef: CredentialRef
  /**
   * 从凭据存储解析凭据。
   *
   * ⚠️ 入参是**本轮要用的模型 id**，实现**必须**透传给
   * `AccountPool.getAvailableAccount` 的 `modelId`：限流是**按模型**记的
   * （`modelRateLimits[model]`），传空串会让 `getAvailableAccount` 的限流
   * 过滤整体短路（`if (modelId.length === 0) return true`）—— 于是适配器
   * 刚写下的限流标记，下次选号时被完全忽略，**换号形同虚设**
   * （用户报障「没有切换」的两个根因之一）。
   *
   * 与 `LoomyAdapterOptions.resolveCredential` 同款（那里是既有正确实现）。
   */
  resolveCredential: (modelId?: string, sessionId?: string) => Promise<TraeCredential | undefined>
  /** 静默续期凭据。 */
  refresh: () => Promise<void>
  /** 动态拉取远端模型列表；失败时回退到 `product.fallbackModels`。 */
  fetchRemoteModels?: () => Promise<TraeRemoteModel[]>
  fetchImpl?: typeof fetch
  /** 多账号池（用于限流时切换账号）。 */
  accountPool?: AccountPool
  /**
   * 读取图片附件的原始字节（内联为 `data:` URL 用）。
   *
   * 由调用方桥接 `ctx.attachments.readImage(ref)`。未提供时收到图片会报
   * `UNSUPPORTED_CONTENT`（而不是静默丢弃）—— 见 `stream()` 的图片分支。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link TRAE}。 */
  product?: TraeProduct
  /**
   * 时钟（注入以便单测推进目录 TTL；缺省 `Date.now`）。
   *
   * ⚠️ 只用于**目录新鲜度**（`ensureRemoteModels` 的 `isCatalogFresh`），
   *    不用于超时/退避计时 —— 那些仍走真实时钟。
   *    ⚠️ **buddy 是例外**：它的 `catalogGate` 也吃这个时钟（冷却与
   *    「距上次尝试 ≥10 秒」判定都走它），所以别把本行当成全仓库通用口径。
   */
  now?: () => number
  /**
   * 远端目录**落地后**的通知回调（issue IKJVTF）。
   *
   * 由 `registerTraeLlm` 注入为 `broadcastCatalogChanged(ctx)`。适配器本身
   * 拿不到 `ctx`，故必须由接线层桥接（与 `readImage` 等回调同一模式）。
   *
   * ⚠️ 必要性：客户端 `ModelCatalogDirectory` 在 `status === 'ready'` 时**短路
   * 返回缓存**，只在宿主事件上 `refresh()`。没有本回调时，冷启动首拉失败
   * 缓存的**兜底表**会永久留在对话框里，远端目录真的落地也不重读。
   */
  onCatalogLoaded?: () => void
}

/** 安全读取 Error.message。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/** 将消息内容载荷展平为纯文本字符串。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map((block) => String(block.text))
    .join('')
}

/** 工具结果内嵌图片的载体文本（与 buddy / lobsterai 适配器同名同义）。 */
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/**
 * 把 harness 内容块转成 OpenAI 多模态 parts（含图片）。
 *
 * 图片必须转成 `{type:'image_url', image_url:{url}}` —— **实测（2026-09-21）
 * 这是 SOLO 上游唯一接受的形态**：`transformToSOLOBody` 对数组 content 原样
 * 透传，而这种 parts 形状直发即可被模型读到（纯红图答「红色」、纯蓝图答
 * 「蓝色」，不带图则答「无法确定」）。故无需任何额外的协议转换。
 *
 * 返回 `undefined` 表示「无图」；只要出现过图片块就一定返回数组（即便字节
 * 解析失败也留 `[image unavailable]` 占位符），以免图片被静默吞掉。
 *
 * 与 `collectImages` **对称地递归**处理 `tool-result` 内层：收集侧是任意深度，
 * 序列化侧若只走一层，深层图片会被收进 refs 却在序列化时静默丢弃。
 */
function userContentParts(
  content: readonly unknown[],
  imageUrls: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> | undefined {
  const parts: Array<Record<string, unknown>> = []
  let hasImage = false
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as {
      type?: unknown
      text?: unknown
      attachment?: { attachmentId?: unknown }
      content?: unknown
    }
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text.length > 0) parts.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      hasImage = true
      const url = block.attachment?.attachmentId === undefined
        ? undefined
        : imageUrls.get(String(block.attachment.attachmentId))
      // 解析不到字节时留占位文本，而不是静默吞掉整张图。
      parts.push(url === undefined
        ? { type: 'text', text: '[image unavailable]' }
        : { type: 'image_url', image_url: { url } })
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      const inner = userContentParts(block.content, imageUrls)
      if (inner !== undefined) {
        hasImage = true
        parts.push(...inner)
      } else {
        // 内层无图：保留其文本，避免内容丢失。
        const text = contentToText(block.content)
        if (text.length > 0) parts.push({ type: 'text', text })
      }
    }
  }
  return hasImage && parts.length > 0 ? parts : undefined
}

/** 收集消息中的图片附件引用（含工具结果内嵌图片），按 attachmentId 去重。 */
function collectImages(content: readonly unknown[], refs: Map<string, unknown>): void {
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { type?: unknown; attachment?: { attachmentId?: unknown }; content?: unknown }
    if (block.type === 'image' && typeof block.attachment?.attachmentId === 'string') {
      refs.set(block.attachment.attachmentId, block.attachment)
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) collectImages(block.content, refs)
  }
}

/**
 * 将 harness 的 **DSH 原生消息块**序列化为 OpenAI 传输格式。
 *
 * ## ⚠️ 为什么必须有这一步（真实缺陷）
 *
 * DSH 交给适配器的 `GenerateOptions.messages` 用的是**原生块结构**：
 * `content: [{type:'tool-call',...}]`、`[{type:'tool-result',...}]`、
 * `[{type:'reasoning',...}]`。它**不是** OpenAI 的 wire 格式。
 *
 * 早期实现把 `options.messages` **原样**塞进 `transformToSOLOBody`，而后者只做
 * 「字符串 content → `[{type:'text'}]`」这一类改写，**不认识** DSH 的块类型。
 * 实测证据（把 DSH 原生形状喂给 `transformToSOLOBody`）：
 *
 * ```json
 * { "role": "assistant",
 *   "content": [ { "type": "reasoning", "text": "…" },
 *                { "type": "tool-call", "id": "call_1", "name": "read", "…" } ] }
 * ```
 *
 * 后果是**每一轮多步对话都坏掉**，且症状极隐蔽：
 *
 * 1. **工具调用对模型不可见**：`tool-call` 块不是 SOLO 认识的字段，
 *    上游只当它是未知 content 片段 —— 模型看不到自己刚才调用过什么；
 * 2. **工具结果丢失**：`tool-result` 块同样不被识别，模型**永远看不到
 *    工具返回值**，于是反复请求同一个工具，或凭空编造结果；
 * 3. `reasoning` 块被当作正文喂回，污染上下文。
 *
 * 三个兄弟适配器（`llm-adapter.ts` / `buddy-adapter.ts` /
 * `lobsterai-adapter.ts`）**都有**这一步 `serializeMessages`，只有 TRAE
 * 漏了 —— 本文件顶部甚至 already `import` 了 `resolveToolPairing` 却从未使用，
 * 说明当初就是打算写、但没接上。
 *
 * 序列化后的形状与 Go 端（`payload.go:PrepareBody`）的输入**完全一致**：
 * assistant 带 `tool_calls`（`function` 形态），工具结果展开为独立
 * `{role:'tool', tool_call_id}` 消息。随后 `transformToSOLOBody` 再按 SOLO
 * 规则把 `function` → `function_call`（与 Go 端同一条流水线）。
 *
 * ## 图片（`imageUrls`）
 *
 * `imageUrls` 为 `undefined` 表示整个请求没有图片；非 undefined（**含空 Map**）
 * 时把带图的 user 消息升级为多模态 parts（`{type:'image_url',...}`）。
 * 空 Map **不能**降级为 undefined —— 那会让「图片存在但字节读取失败」的
 * `[image unavailable]` 占位符也被跳过，图片静默消失。
 */
function serializeTraeMessages(
  messages: readonly { role: string; content: unknown }[],
  imageUrls?: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  // ⚠️ 先归一化 DSH 0.1.7 的消息形状（见 `message-shape.ts`）：0.1.7 把工具结果
  // 改为一等 `role:'tool'` 消息，不再有 `tool-result` 块。若不归一化，下面的
  // `type === 'tool-result'` 判据恒不命中 → 工具结果被当成普通 user 消息下发、
  // `tool_call_id` 关联丢失，且 `resolveToolPairing` 会剔除全部 tool_calls。
  const normalized = normalizeHarnessMessages(messages)
  // 剔除无法配对的工具调用/结果：SOLO 上游同样要求 tool_calls 与 tool 结果
  // 严格配对，孤儿条目会让整条会话被拒（与三个兄弟适配器同款防线）。
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized)

  // 工具结果内嵌图片（`read_image` 等）不能并入 `role:'tool'` 消息：该角色的
  // content 只能是字符串，且必须紧跟其 assistant tool_call，中间插消息会 400。
  // 故挂起到其后的独立 user 消息统一发出（与 buddy / lobsterai 同款处理）。
  let pendingToolImages: Array<Record<string, unknown>> = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const message of normalized) {
    if (message.role === 'assistant') {
      // ⚠️ 2026-10-19 修（4027 第三例，多工具调用场景）：
      // 进入新的 assistant 之前，上一批工具结果**已经全部下发完毕**（tool 消息只会
      // 紧跟其 assistant），此时 flush 图片是安全的。若不在这里 flush，图片会一直
      // 挂到整个循环结束，被挤到更后面。
      flushToolImages()
      // 存量自愈：清洗历史里已持久化的行首 `course` / `课` 泄漏
      // （见 `stripCourseLeakFromHistoryContent`）。只清 assistant ——
      // 判据只对模型自己的输出成立，清洗用户输入等于篡改用户的话。
      const content = stripCourseLeakFromHistoryContent(
        message.role,
        Array.isArray(message.content) ? message.content : [],
      )
      const toolCalls = content
        .filter((block): block is { type: string; id: unknown; name: unknown; arguments: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
        .filter(block => keepCallIds.has(String(block.id)))
        .map((block) => ({
          id: String(block.id),
          type: 'function' as const,
          function: {
            name: String(block.name),
            arguments: normalizeToolArguments(String(block.arguments)),
          },
        }))
      const text = contentToText(content)
      // 正文为空且有工具调用时 content 必须为 null（对齐 Go 端：纯 tool_calls
      // 的 assistant 不回写空 content）。
      wire.push({
        role: 'assistant',
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    // user 角色：工具结果搭载在 harness 用户消息中，展开为独立的 role:'tool' 消息。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter(
      (block): block is { type: string; toolCallId: unknown; content: unknown } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result',
    )
    const text = contentToText(message.content)
    // 图片：仅当本请求带图（imageUrls 非 undefined）时升级为多模态 parts。
    //
    // ⚠️ **只收本消息自己的图片**（`outerContent` 先剔掉工具结果块）：工具结果内嵌的
    // 图片由下面 `pendingToolImages` 挂到 `role:'tool'` **之后**；在这里一并收进来会把
    // 它们排到 tool 消息**之前**（成因见下 `deferred` 的注释与 4027 回归用例）。
    const outerContent = content.filter(
      (block) => !(typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result'),
    )
    const parts = imageUrls === undefined ? undefined : userContentParts(outerContent, imageUrls)
    // ⚠️⚠️ **带工具结果时这条 user 消息必须延后到 `role:'tool'` 之后**：上游要求
    // tool 消息是「紧跟其 assistant `tool_calls` 的应答」，两者之间插任何消息
    // （哪怕只是本消息的正文或图片）都会被拒。
    //
    // **真实缺陷**（2026-10-04 用户报障）：`read_image`（工具结果内嵌图片）之后，
    // 整条会话在 trae 下**永久无法对话** —— 上游恒定回
    // `code=4027 Messages with role 'tool' must be a response to a preceding message
    // with 'tool_calls'`；坏报文已落进会话历史，每次请求原样重放，5 次重试与
    // 「继续」全部无效，只有换 provider 才能恢复。
    const deferred = toolResults.length > 0
    if (!deferred) {
      // 无工具结果：维持原语义立即发出（有图发多模态 parts，否则发纯文本）。
      if (parts !== undefined) {
        // 有图：正文与图片合并为一条多模态 user 消息（parts 里已含文本块）。
        flushToolImages()
        wire.push({ role: 'user', content: parts })
      } else {
        wire.push({ role: 'user', content: text })
      }
    }
    for (const result of toolResults) {
      // 丢弃孤儿工具结果：没有对应 tool_call 同样会被上游拒绝。
      if (!keepResultIds.has(String(result.toolCallId))) continue
      const innerParts = imageUrls === undefined
        ? undefined
        : (Array.isArray(result.content) ? userContentParts(result.content, imageUrls) : undefined)
      if (innerParts !== undefined) {
        // 工具结果内嵌图片：该消息的 content 只能是字符串，图片挂到后续独立
        // user 消息里（不能就地展开，否则违反 role:'tool' 的协议约束）。
        pendingToolImages.push(...innerParts.filter((part) => part.type === 'image_url'))
      }
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: contentToText(result.content) || (innerParts !== undefined ? TOOL_RESULT_IMAGE_TEXT : '(no output)'),
      })
    }
    // 延后的正文/图片：排在 `role:'tool'` 之后（成因见上方 `deferred` 的注释）。
    if (deferred && (parts !== undefined || text.length > 0)) {
      flushToolImages()
      wire.push({ role: 'user', content: parts ?? text })
    }
    // ⚠️⚠️ 2026-10-19 修（4027 真实缺陷 · 多工具调用漏网场景）：
    // **这里绝不能无条件 flush**。原实现在每条 user 消息末尾都调 `flushToolImages()`，
    // 而 DSH 0.1.7 起工具结果是**一等 `role:'tool'` 消息**（`normalizeHarnessMessages`
    // 把每条都转成**独立的** `role:'user'` + 内嵌 tool-result 块）⇒ 当一个 assistant
    // 发了 **≥2 个 tool_call**、且**不是最后一个**的结果内嵌图片时，图片会在处理第一条
    // 工具结果的消息末尾就被 flush 成一条 user 消息，**插到下一条 `role:'tool'` 之前**
    // ⇒ assistant(tool_calls) 与 tool 之间插了 user ⇒ 上游恒定回
    // `code=4027 Messages with role 'tool' must be a response to a preceding message
    // with 'tool_calls'`。
    //
    // 旧回归用例（trae-adapter.spec.ts「工具结果内嵌图片不得插在 role:tool 之前」）
    // 只覆盖了 **1 个** tool_call，故这条路径从未被测到 —— 实测在模型一次并发发出
    // `read_image` + `read` 时即触发，且坏报文落库后会话**永久卡死**。
    //
    // 修法：图片挂起**跨消息累积**，只在两处落地 ——
    //   ① 进入下一条 assistant 之前（`flushToolImages()` 已在循环顶部）；
    //   ② 整个循环结束后（见函数末尾）。
    // 这样保证同一批工具结果的全部 `role:'tool'` 消息**紧密相邻**，图片统一排在其后。
  }
  // 循环收尾：把最后一批挂起的图片发出去（此时所有 tool 消息已下发完毕）。
  flushToolImages()
  return wire
}

/** 从错误体提取可读 detail 文本。 */
function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const parts = [
      typeof data.code === 'number' || typeof data.code === 'string' ? `code=${String(data.code)}` : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      typeof data.msg === 'string' ? data.msg : undefined,
      // ⚠️ 上游代理的 `{"error":"…","detail":"<真实原因>"}` 形态（IKLBSH A1）。
      // 判据只留一份实现（`openai-compat.ts` 的 `detailFieldText`）；必须是最后一条腿。
      detailFieldText(data),
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch { /* 非 JSON 错误体 */ }
  return body
}

/** HTTP 状态码映射。 */
function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * 组合 SOLO **流内** `event:error` 的文案。
 *
 * `code=4001` 的上游原文是 *"We're sorry, the param is invalid. Please try with a
 * valid param."* —— 实测（2026-09-19，遍历 45 个远端模型）该码**只**由
 * **不可调用的模型**触发：5 个 `display_config.is_custom_model === true` 的条目
 * 全部报 4001，而同批次的其余模型全部正常。也就是说它与「提示词/参数格式有误」
 * 毫无关系，原文会把排查方向**完全带偏**（去查 message 结构、tools 序列化…）。
 *
 * ⚠️ **那 5 个条目的名单已过期**（复测 2026-09-20）：其中 3 个下架、2 个转为
 * `is_custom_model: false`（已可调用），全目录 custom 条目数为 0。故这里**不列
 * 具体模型名** —— 把某一刻的快照写成判据，会让后人误删合法模型。
 *
 * 故对 4001 追加一句指向真实成因的可操作提示。其余错误码保持原样，
 * 不做无依据的解释。
 */
function traeStreamErrorMessage(code: number, message: string, model: string): string {
  const base = `trae: ${message} (code=${code})`
  if (code === 4006) {
    // 上游原文 *"We're sorry, the content is too large for AI to understand."*
    // 说的是**这一次请求的载荷**太大（实测：约 (21,24] 张 2560×1600 原图，
    // 即请求体 ≈100 MiB 量级，Gitee issue IKKX0T）。原文不提「图片」也不提
    // 「体积」，容易被读成模型能力问题，故补一句可操作的指向。
    return `${base} —— 本次请求的内容过大：多为一次携带的图片过多/过大。`
      + '请减少本轮的图片数量或改用更小的截图后重试。'
  }
  if (code === 1005) {
    // ⚠️ **必须给出「换模型」这条出路**（2026-10-25 审计 P2-10）。
    //
    // 1005 = **套餐权益不足**：该模型不被这个账号的套餐接受。上游 `message`
    // 常常是**空串**，于是旧实现给用户的全部信息就是 `trae:  (code=1005)`
    // —— 一个字都不指向他能做的事。
    //
    // ⚠️ 引导必须指向**换模型**，不能指向签到/充值：换号也没用（换账号还是
    // 同一个模型被拒，故 1005 不在「值得换号」之外的语义里），而额度对
    // 「套餐不含此模型」是完全无效的解药。这一点审计实测确认过。
    return `${base} —— 当前账号的套餐不包含模型「${model}」：`
      + '请换一个模型重试（被拒的是这个模型，不是额度，等额度也不会好）。'
  }
  if (code === 4008) {
    // 4008 = `ide_credits` 日配额耗尽 ⇒ 这条**确实**该引导等重置/签到。
    // 与 1005 分开写，避免把两种完全不同的成因混成一句（旧实现两者共用
    // 裸码文案，用户无法区分是该换模型还是该等额度）。
    return `${base} —— 当前账号的今日额度已用尽：`
      + '请等额度重置后重试，或改用其它模型/其它账号。'
  }
  if (code !== 4001) return base
  return `${base} —— 模型「${model}」不被上游接受：它通常是「仅可见但不可调用」的`
    + '自定义模型（需先在 TRAE IDE 内自行配置供应商），请改用模型列表中的其它模型'
}

/** 传输级错误判定。 */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (message.includes('terminated')) return true
  if (error.name.startsWith('UND_ERR_')) return true
  if (message.includes('fetch failed')) return true
  if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/**
 * 组装模型选择器里展示的名字：`模型名 · 倍率`。
 *
 * ## 为什么倍率必须拼进 `name`
 *
 * composer 的模型切换菜单**只渲染 `name`**（`dsh-client-ui-model-selection` 的
 * ModelSelect 里只有 `title: model.name` 与 `children: model.name`），
 * `description` **完全不读**。用户报障「消耗倍率没有显示在切换模型列表的后面」
 * 正是因为早期版本放进了 `description`。
 *
 * 安全性：`name` **纯属展示** —— DSH 的选择与持久化只用 `id`，故附加价格不会
 * 污染会话历史。`resolveModel` 的 `name` **不带**倍率（价格只属于选择列表语境，
 * 与 Qoder 的处理一致）。
 *
 * 形态：
 * - 常态 `Qwen3.8-Flash · x0.08`
 * - 活动期 `Doubao-Seed-2.1-Pro · x0.80→x0.08`（箭头比「（促销 …）」短，适合窄菜单）
 * - 无倍率信息时只显示模型名（**不编造** `x1`）
 */
export function traeDisplayName(model: TraeRemoteModel): string {
  const rate = model.creditsRate
  if (rate === undefined) return model.name
  // `0` 是**合法**倍率（免费），必须与「没有倍率」区分开。
  const current = rate === 0 ? '免费' : `x${rate}`
  // 活动折扣：只在解析层已判定「当前生效」时才有 originalCreditsRate。
  const original = model.originalCreditsRate
  if (original !== undefined && original > rate) {
    return `${model.name} · x${original}→${current}`
  }
  return `${model.name} · ${current}`
}

/**
 * TRAE 模型适配器。
 */
export class TraeAdapter extends LlmAdapter {
  private readonly product: TraeProduct
  private readonly fetchImpl: typeof fetch
  /** 动态模型缓存。 */
  private remoteModels: TraeRemoteModel[] | undefined
  /**
   * ⚠️ 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
   *
   * ⚠️ 与 `remoteModels` **并存**、不是替代：`remoteModels` 存「有哪些模型」，
   *    本字段存「何时读到的」。只有 `remoteModels` 时目录**永不刷新**（原行为）。
   */
  private catalogAt = 0
  /**
   * 目录加载闸门：并发去重 + 失败/空结果冷却。
   * 依据见 `src/remote-catalog-gate.ts`（首屏「加载模型巨长」的实测归因）。
   */
  private readonly catalogGate: RemoteCatalogGate
  /**
   * ⚠️ **2026-10-08 Task 7c：三个方法收敛到共享骨架** `createModelCatalog`。
   * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架，
   * 现在只剩 `toCatalogEntry`（本家私有形状 + Max 模式 + 两层可见性过滤）。
   */
  private readonly catalog: ModelCatalog
  /** 远端模型元数据索引。 */
  private remoteMeta: ReadonlyMap<string, TraeRemoteModel> = new Map()
  /** 产品级兜底模型索引。 */
  private readonly fallbackIndex: ReadonlyMap<string, TraeFallbackModel>
  /**
   * 已发起的 chat 请求计数（仅在启用机器指纹轮换时使用，见
   * {@link TraeAdapter.machineIdGeneration}）。
   */
  private sendCount = 0

  constructor(private readonly options: TraeAdapterOptions) {
    super()
    this.product = options.product ?? TRAE
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(
      (this.product.fallbackModels ?? []).map((model) => [model.id, model]),
    )
    // 目录落地后通知客户端重读（issue IKJVTF 的缺陷①）。
    this.catalogGate = new RemoteCatalogGate(
      options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded },
    )
    // ⚠️ 共享骨架（Task 7c）：门控 → 读目录 → 黑名单 → 回填 → 三态。
    this.catalog = createModelCatalog(
      { accountPool: options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
        /**
         * ★ **强制重拉**（供后台 20 分钟刷新器与「用户改设置」）。
         *
         * ⚠️ 与 `loadCatalog` 的差别：后者内部有 `isCatalogFresh` 判据 ⇒ 新鲜时**不拉**。
         * 本回调要的是「无视新鲜度，强制拉一次」，故先清时刻再调同一个方法 ——
         * **不另写一份拉取逻辑**（那会让两条路的上游行为分叉）。
         */
        refresh: async () => {
          this.catalogAt = 0
          await this.ensureRemoteModels()
        },
        // ⚠️ 未知 id 保守报 `['text']`（见 `inputModalitiesFor`）。
        unknownModelInputModalities: () => ['text'] as const,
      },
    )
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 懒加载远端模型目录（**每 20 分钟**重新拉一次，用户 2026-10-18 的要求）。
   */
  private async ensureRemoteModels(): Promise<void> {
    const fetchRemote = this.options.fetchRemoteModels
    // ⚠️ `fetchRemote === undefined` 那半边**原样保留** —— 它判的是「有没有远端
    //    可拉」（无凭据/无接线），与新鲜度是两件事。
    if (fetchRemote === undefined) return
    // ⚠️ 判据来源：`isCatalogFresh`（`model-catalog.ts` 的**唯一**实现）。
    // ⚠️ **入口用 `isCatalogFreshFor`**：用户在 Jet Hub 改开关后要**立即**重拉
    //    （规格 §6 的正确性要求，见 `invalidateCatalogCache`）。本方法只有这一处
    //    判据，且它在 gate **之前**（拉不到就用旧值），故整条路径都安全。
    // ⚠️ **不是**照抄 aggregate-adapter.ts 那条 —— 那边另有两处本家没有的前提
    //    （`force` 与 `options.catalogTtlMs` 覆盖的 60s TTL），本家用 20 分钟默认周期。
    if (this.remoteModels !== undefined
      && isCatalogFreshFor(this.product.id, this.catalogAt, this.options.now?.() ?? Date.now())) {
      return
    }
    // 闸门：并发去重 + 失败/空结果冷却（依据见 src/remote-catalog-gate.ts）。
    // Trae 的目录超时上限 30s（src/trae.ts），失败不冷却会被 buildModelCatalog
    // 放大成「每模型一次」。
    await this.catalogGate.run(async () => {
      const models = await fetchRemote()
      if (models.length === 0) return false
      this.remoteModels = models
      this.remoteMeta = new Map(models.map((model) => [model.id, model]))
      // ⚠️ **只在成功赋值后**记时刻：失败/空结果不写，否则一次抖动会把上界
      //    刷新掉、下轮还要等满 20 分钟才发现上游没恢复。
      this.catalogAt = this.options.now?.() ?? Date.now()
      return true
    })
  }

  /**
   * 模型接受的输入模态 —— **逐模型**判定，不是按 provider 一刀切。
   *
   * 判据是远端 `display_config.multimodal`（见
   * {@link TraeRemoteModel.multimodal} 的实测记录）：
   *
   * - `true` → `['text', 'image']`
   * - `false` / **未声明** → `['text']`（保守：兜底表没有该字段，
   *   且「远端没说」不等于「远端支持」）
   *
   * ⚠️ **这里返回的 `image` 是 DSH 的准入闸门**：不声明 `image` 时，图片会在
   * **附件入库阶段**就被拒（`session/attachment-invalid`），用户看到
   * 「当前模型不支持图片」——而图根本没发到上游。因此漏报 `image` 不只是
   * 「少个功能」，而是「连降级成文本占位符的机会都没有」。
   *
   * **历史缺陷**（Issue #IKHDKC）：早期这里恒返回 `['text']`（参数名甚至是
   * `_model`，即刻意忽略模型），理由是「SOLO 通道未见图片能力」—— 实测证伪：
   * 远端一直在目录里声明该能力，且直发图片后模型真的看得见。
   */
  private inputModalitiesFor(model: string): readonly ('text' | 'image')[] {
    return this.remoteMeta.get(model)?.multimodal === true ? ['text', 'image'] : ['text']
  }

  /**
   * 该模型所属的聊天通道（`function`）。
   *
   * ⚠️ **模型只在列出它的通道里可调用**：发错通道上游会回流内
   * `code=4001 param is invalid`（实测 `glm-5.1` 在 `solo_work_lite` 报错、
   * 在 `solo_agent_remote` 正常；`glm-5-turbo` 恰好相反）。
   * 远端目录里每条模型都带自己的 `function`；查不到时回退默认通道。
   *
   * ⚠️ **这里拿到的一定是白名单内的通道**（Issue IKJOZ7）：非白名单通道的条目
   * 已在 `parseTraeBatchModelList` 里被整组剔除，故 `remoteMeta` 里不可能存在
   * 「通道不可调用」的模型。兜底路径（远端目录不可用 → 兜底表）本就没有通道
   * 信息，只能回退 `product.function`（`solo_work_lite`，已在白名单内）。
   *
   * ⚠️ 若在此处**再加**一层白名单校验，会让「用户用 `DSH_TRAE_CHANNELS` 自定义
   * 白名单 + 模型来自兜底表」的组合出现两条判据不一致；故准入只在解析器一处
   * 执行（单一真相源）。
   */
  private channelFor(model: string): string {
    const channel = this.remoteMeta.get(model)?.function
    return channel !== undefined && channel.length > 0 ? channel : this.product.function
  }

  /**
   * 模型的上下文窗口：远端优先，兜底表次之。
   *
   * ⚠️ 开启 Max 模式时改用 `context_window_tokens.max`（1M）。两者**不能混用**：
   * 未开 Max 却声明 1M 会让 DSH 把超长上下文直接发出去，而上游按 200K 校验后
   * 拒绝（输入被截断或 4xx）。
   */
  private contextWindowFor(model: string): number | undefined {
    const meta = this.remoteMeta.get(model)
    if (this.maxModeFor(model)) {
      return meta?.maxContextWindow ?? TRAE_MAX_CONTEXT_TOKENS
    }
    return meta?.contextWindow ?? this.fallbackIndex.get(model)?.contextWindow
  }

  /**
   * 该模型本次是否启用 **Max 模式**（1M 上下文）。
   *
   * 三个条件缺一不可（对齐 `Trae2api-cn/trae_remote_client.py:249-277`）：
   * 1. 产品级开关（`DSH_TRAE_MAX_MODE`）未关 —— **默认开启**，用户要求
   *    「上下文用最大的那一档」；显式设 `0` / `false` 才关回 200K；
   * 2. 远端 `display_config.max_mode === true` —— **绝不**给未标记的模型硬套
   *    Max 参数，上游会拒绝（`_max_mode_requested` 的注释明写
   *    "Never fabricate max limits for a model the account config does not mark"）；
   * 3. 若配置了白名单，模型须在其中。
   */
  private maxModeFor(model: string): boolean {
    if (this.product.maxMode !== true) return false
    const meta = this.remoteMeta.get(model)
    if (meta === undefined || meta.maxMode !== true) return false
    const whitelist = this.product.maxModeModels
    if (whitelist !== undefined && whitelist.length > 0 && !whitelist.includes('*')) {
      return whitelist.includes(model)
    }
    return true
  }

  /**
   * 模型可选的推理强度档位（`reasoning_effort_config`）。
   *
   * TRAE 的 `options` 是**单值字符串**（既是产品侧档位名、也是 wire 值），
   * 与 LobsterAI 的 `level` / `openclawLevel` 双字段形态不同，故不需要映射表
   * 之外的转换（命名仅用于展示）。
   *
   * 不声明 `reasoning` 的两种情形：
   * - 远端没有该配置 → UI 显示「当前模型未提供推理等级」（而不是给个发了没用的档位）
   * - `support_thinking === false` → 远端明确说不支持思考
   *
   * `defaultEffort` 必须落在 `efforts` 内（DSH 会拿它直接发请求），远端数据
   * 不一致时退化为不声明默认值。
   */
  private reasoningFor(model: string): LlmResolvedModelInfo['reasoning'] {
    const config = this.remoteMeta.get(model)?.reasoningConfig
    if (config === undefined) return undefined
    if (config.supportThinking === false) return undefined
    if (config.options.length === 0) return undefined
    const efforts = config.options.map((option) => ({
      id: ReasoningEffortId(option),
      name: TRAE_EFFORT_NAMES[option] ?? option,
    }))
    // ⚠️ 默认档**优先采信上游 `default_level`**（见 {@link defaultTraeEffort}）。
    // 早期实现一律取最强档（用户当时要求「所有模型默认用 max」），代价是思考
    // token 与正文共享 `completion_tokens`、正文更早撞上限。改为采信上游后：
    // 实测 6 个模型里 4 个上游给的就是次高档 `high`，而 `glm-5.3` / `kimi-k3`
    // 上游自己选的是 `extra_high` —— 机械取「次高档」会把后两者无谓降档，
    // 故以**上游的判断**为准，而不是自己定一条规则。
    const fallback = strongestTraeEffort(config.options)
    const chosen = defaultTraeEffort(config, fallback)
    return {
      efforts,
      ...chosen !== undefined ? { defaultEffort: ReasoningEffortId(chosen) } : {},
    }
  }

  /**
   * 模型的输出上限：远端优先 → 兜底表 → 产品级兜底值。
   *
   * ⚠️ 实测远端主流模型声明的是 **32000**，而兜底表旧值写的 128000 会让
   * DSH 索要一个上游不接受的值。远端可用时一律以远端为准。
   */
  private maxOutputTokensFor(model: string): number | undefined {
    const meta = this.remoteMeta.get(model)
    // Max 模式下 `model_detail_list` 的 `__max` 那条声明的输出上限才是准的
    // （实测 `custom_model_1M__max` 384000 vs `__dev` 64000）。
    if (this.maxModeFor(model) && meta?.maxModeOutputTokens !== undefined) {
      return meta.maxModeOutputTokens
    }
    return meta?.maxOutputTokens
      ?? this.product.fallbackMaxOutputTokens
  }

  /**
   * 静态兜底模型目录。
   *
   * 始终过滤 `isHidden === true` 的条目（这些是上游内部/隐藏模型，不应出现在
   * 对话模型目录中）。与远端路径的过滤逻辑一致（`parseTraeBatchModelList` 中也
   * 硬性过滤 `isHidden === true`）。
   */
  private staticFallbackModels(): readonly { id: string; name: string }[] {
    return this.product.fallbackModels
      .filter((model) => model.isHidden !== true)
      .map((model) => ({ id: model.id, name: model.name }))
  }

  /**
   * 完整模型目录（**不应用用户黑名单**）。
   *
   * ## 为什么需要它
   *
   * `listModels` 会按用户黑名单过滤（Jet Hub「显示列表」开关），于是**被关闭的
   * 模型不在其返回值里**。而设置页必须把关闭的模型也渲染出来（否则用户无法重新
   * 打开），RPC 层只能凭黑名单的 key（裸 id）补回 —— 那条路径拿不到展示名，
   * 只能回退成裸 id，**倍率与模型显示名随之丢失**（用户报障：「关闭的就没有显示
   * 倍率，关闭的应该也显示倍率」）。
   *
   * 故这里提供「不过滤黑名单」的目录，由 `model.list` 端点使用：它据此拿到
   * 每个 id 的**真实展示名（含倍率）**，再自行回填 `disabled` 状态。
   * 对话框模型选择器读的仍是 `listModels`（已过滤），可见性行为不变。
   *
   * ⚠️ **2026-10-08 Task 7c**：骨架（含上面这条理由）已上移到共享实现
   * `src/model-catalog.ts`，此处只剩委托。
   */
  /**
   * ★ **后台目录刷新器入口**（`src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`）。
   *
   * ⚠️⚠️ 必须由适配器**显式转发** `catalog.refresh`：`ModelCatalog`（`model-catalog.ts`）
   *    上的这个成员**不会**自动变成适配器的成员 —— `pruned()` 的 Proxy 只透传
   *    **适配器自己的**成员（`dead-model-store.ts:748-749`）。
   *    漏转发 ⇒ 刷新器「已武装」却对这家**空转**，且**零日志**（`refreshOf` 返回
   *    `undefined` 时静默跳过 —— `index.ts` 的装配注释写着这件事）。
   *    ⚠️ 与 `options.refresh`（HTTP 401 后的**凭据**重取）**不是同一件事**，
   *    两者同名纯属巧合，**不得合并**。
   */
  async refresh(): Promise<void> {
    await this.catalog.refresh?.()
  }

  listAllModels(): readonly { id: string; name: string }[] {
    return this.catalog.listAllModels()
  }

  /**
   * 把本家条目转成共享骨架的中间结构。
   *
   * ⚠️ 本家四处**真实差异**：
   * 1. `contextWindow` 受 **Max 模式**影响（开启时用 `maxContextWindow` /
   *    `TRAE_MAX_CONTEXT_TOKENS`，两者**不能混用** —— 未开 Max 却声明 1M 会让
   *    DSH 把超长上下文直接发出去，上游按 200K 校验后拒绝）；
   * 2. `maxTokens` 二级查找（Max 模式下用 `maxModeOutputTokens`）；
   * 3. `reasoning` 的默认档**优先采信上游 `default_level`**（见 `reasoningFor`）；
   * 4. `inputModalities` 逐模型判定（远端 `display_config.multimodal`）——
   *    早期硬编码 `['text']` 导致 DSH 在**附件准入阶段**就拒掉图片（Issue #IKHDKC）。
   */
  private toCatalogEntry(model: TraeRemoteModel): CatalogEntry {
    const contextWindow = this.contextWindowFor(model.id)
    const maxTokens = this.maxOutputTokensFor(model.id)
    const reasoning = this.reasoningFor(model.id)
    return {
      id: model.id,
      name: traeDisplayName(model),
      // ⚠️ `resolveModel` 用**元数据里的 name**（不带倍率）⇒ 显式提供 `bareName`。
      bareName: this.remoteMeta.get(model.id)?.name
        ?? this.fallbackIndex.get(model.id)?.name
        ?? model.name,
      // ⚠️ 逐模型判定（见上）；未声明时**保守报 `['text']`**（不是省略）。
      inputModalities: this.inputModalitiesFor(model.id),
      ...contextWindow !== undefined ? { contextWindow } : {},
      ...maxTokens !== undefined ? { maxTokens } : {},
      ...reasoning !== undefined ? { reasoning } : {},
    }
  }

  /**
   * 本家全部条目（**含两层可见性过滤**）。
   *
   * 过滤逻辑分两层（原 `listModels` 的注释）：
   *
   * 第一层（解析时，`parseTraeBatchModelList`）：硬性过滤 `usage !==
   * chat_completion` / `config_switch === false` / `is_invisible_to_user ===
   * true`。这些条件对 batch 端点（全功能配置表）有意义，避免 summary /
   * custom_model / multimodal 等非对话条目塞满目录。
   *
   * 第二层（运行时，此处）：硬性过滤 `isHidden === true`（兜底表路径没有解析器，
   * 在 `staticFallbackModels` 里过滤；远端路径由解析器过滤，但测试绕过解析器直接
   * 喂 `TraeRemoteModel[]`，故此处再补一刀保持一致性）+ `is_custom_model === true`
   * （自定义模型，需用户在 IDE 内绑定供应商，本插件调不通，一律 4001）。
   *
   * ⚠️ `is_invisible_to_user` **不再由 `hideInternalModels` 控制**：新设计
   * 要求目录与官方 Auto Mode 选择器一致，隐藏模型不在目录中展示。
   */
  private catalogEntries(): readonly CatalogEntry[] {
    const source = this.remoteModels === undefined
      ? this.staticFallbackModels()
      : this.remoteModels.filter((model) => isTraeModelCallable(model) && model.isHidden !== true)
    return source.map((model) => this.toCatalogEntry(model))
  }

  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    await this.ensureRemoteModels()
    return this.catalogEntries()
  }

  /**
   * 同步视图（`listAllModels` 用）。
   *
   * ⚠️ **不能** `await ensureRemoteModels()`（同步契约）—— 读 `remoteModels`
   * 缓存，未落地时回退静态兜底表（这正是原实现的语义）。
   */
  private syncCatalogEntries(): readonly CatalogEntry[] {
    return this.catalogEntries()
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(_provider)
  }

  /**
   * 解析模型元信息。
   *
   * ⚠️ 原实现里的四处判据（context / maxTokens / reasoning / modalities）现已
   * 收敛到 `toCatalogEntry`；骨架的 `resolveModel` 只做回填与「不声明未知」。
   * ⚠️ `inputModalities` **与 `listModels` 同源**（都走 `toCatalogEntry`）——
   * 否则准入闸门仍会拦下图（Issue #IKHDKC 的教训）。
   */
  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolveModel(provider, model, signal)
  }

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

  /**
   * 该模型是否**消耗 0 积分**（免费），用于跳过「锁定永久积分」那道门。
   *
   * ## 为什么需要它
   *
   * 选号编排里 `isFreeModel: true` 会**完全跳过余额分档**：免费模型既不扣临时
   * 积分也不扣永久积分，与「别把永久积分烧掉」这个保护目标无关。若不跳过，
   * 用户锁定了永久积分、账号只剩永久积分时，选号会落 `none` 档并抛出
   * 「积分都已用尽」—— 而他用的模型**根本不扣积分**，报错完全误导
   * （buddy 系已因此产生过真实报障，见 `index.ts` 的 `isFreeModel` 参数注释）。
   *
   * ## 判据
   *
   * 远端目录的 `creditsRate`（`readConsumptionRate()` 解析 `display_contact_config`
   * 里的 `consumption_rate.data.rate`）**等于 0** 即免费。
   *
   * ⚠️ **`rate: 0` 是合法值**，不能与「解析不出来」混为一谈（`readConsumptionRate`
   * 的注释已记这条坑）。展示层同样把它显示为「免费」（见 `traeDisplayName`）。
   *
   * ⚠️ **只在确定免费时返回 true**：查不到目录 / 解析失败一律 false ——
   * 方向保守（宁可多走一次余额门），与 `BuddyAdapter.isFreeModel` 同一约定。
   *
   * ⚠️ 远端目录是懒加载的，必须先 `await ensureRemoteModels()`，否则「直接进会话」
   * 等路径查不到目录，会**静默退回被拦截的行为**。
   *
   * @param modelId - 模型 id。
   * @returns true 仅当能确认该模型消耗 0 积分。
   */
  async isFreeModel(modelId: string | undefined): Promise<boolean> {
    if (typeof modelId !== 'string' || modelId.length === 0) return false
    await this.ensureRemoteModels()
    const meta = this.remoteMeta.get(modelId)
    return meta?.creditsRate === 0
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 0. 确保远端目录已加载 —— 发送时要用它决定该模型走哪个通道
    //    （`channelFor`）。`prepareCall` 通常已通过 `resolveModel` 触发过，
    //    这里只作兜底（已加载时是空操作）。
    await this.ensureRemoteModels()

    // 1. 获取凭据（过期则先静默续期）
    //
    // ⚠️ **必须传 `options.model`**：这是选号主路径，`resolveCredential` 会把
    // 它透传给 `getAvailableAccount` 的 `modelId` 过滤限流账号。传空串等于
    // 不按模型过滤，限流标记被忽略（用户报障「没有切换」的根因之一）。
    let credential = await this.options.resolveCredential(options.model, options.sessionId)
    if (credential === undefined || isTraeExpired(credential)) {
      await this.options.refresh()
      // ⚠️ 传 `options.model`：选号必须按**本轮的模型**过滤限流账号，
      // 否则刚标记的限流账号会被再次选中（见 options 类型处的说明）。
      credential = await this.options.resolveCredential(options.model, options.sessionId)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('trae: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 记录当前账号
    let currentAccountId = ''
    if (this.options.accountPool) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id,
          credential.access_token,
        )
        // Token 账本（第 2 期）：回报「本笔请求解析出的账号」（空串不回报）。
        if (currentAccountId !== '') reportLedgerAccount(this.product.id, currentAccountId)
      } catch {
        // 账号不匹配不影响请求
      }
    }

    // 3. 图片：按**模型**判定是否接受，并把字节读成 data URL
    //
    // ⚠️ **不能无条件拒绝**：实测（2026-09-21）TRAE 上游真的支持图片 ——
    // 远端目录里 `display_config.multimodal` 一直在声明该能力，且直发图片后
    // 模型确实读到了像素（红图答「红色」、蓝图答「蓝色」、无图答「无法确定」）。
    // 早期这里无条件抛错（理由「SOLO 通道不支持图片」），配合 `inputModalities`
    // 恒为 `['text']`，导致图片在**附件准入阶段**就被 DSH 拒掉（用户报障
    // Issue #IKHDKC）。
    //
    // 现在：`multimodal !== true` 的模型仍明确报错（实测 `DeepSeek-V4-Pro-Official`
    // 收到图后答「无法确定」、思考链说「但没有图片」，证明该标志是权威判据）；
    // `multimodal === true` 的模型读字节并转成 data URL 随请求发出。
    //
    // 宁可显式报错（DSH 会据此把图片投影成文本占位符），也不要静默吞掉。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    // `imageUrls` 为 undefined 表示「本请求没有图片」；非 undefined（含空 Map）
    // 时序列化层会把带图的 user 消息升级为多模态 parts。空 Map 不能降级为
    // undefined —— 那会让「图片存在但字节读取失败」的占位符也被跳过。
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes('image')) {
        throw new LlmError(
          `trae: model "${options.model}" does not accept image input.`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError(
          'trae: image input requires the attachment service; '
          + 'confirm the profile loads @deepseek-ai/dsh-attachment-local.',
          'UNSUPPORTED_CONTENT',
        )
      }
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        /**
         * ⚠️ **此处刻意走「原图」路径，未接 `readImageRequest` 缩放桥接**
         * （Gitee issue IKKX0T，2026-10-12 复核）。
         *
         * 既有理由「原图边界从未探过，拿不到阈值就不定值」**已失效**：
         * issue 的独立实测给出边界 **`(21, 24]` 张** 2560×1600 原图，
         * 形态是流内 `code=4006 content is too large for AI to understand`
         * （该码原先被归成可重试的 `SERVER`，已于本次修掉 —— 见
         * `streamErrorCode` 的注释，所以现在失败是**快速且文案明确**的）。
         *
         * ⇒ **但当前仍不接**，理由只有一条：**边界未经本仓库复测**。
         * issue 的 fixture 是 3.45 MiB/张、本仓库的是 2.87 MiB/张，
         * 量纲不同 ⇒ 同一个「≈100 MiB 请求体」边界对应的**张数也不同**，
         * 直接套用别家的 `imageMaxBytes` 等于写进一个没验证的猜测。
         *
         * **复测入口**：`pnpm test:e2e:image-bisect`
         * （`tests/e2e/image-limit-bisect.e2e.spec.ts`，二分到 ≤3 张）。
         * 复测后：① 给 `TraeProduct.imageMaxBytes` 赋值；
         * ② 这里改为 `projectRequestImage(ref, {...})` 并保留「拿不到就回退原图」；
         * ③ 宿主侧 `index.ts` 补 `readImageRequest` 桥接；
         * ④ 删掉 `tests/unit/image-budget.spec.ts` 里那条「loomy/trae 不误接」守卫。
         */
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // ⚠️ **tools / tool_choice 必须放进源的 OpenAI 对象里再交给
    // `transformToSOLOBody`**，不能在转换之后再补 —— SOLO 上游要求
    // `function.parameters` 是 **JSON 字符串**（OpenAI 标准是对象），
    // 那一步序列化发生在 `normalizeTools` 内部，只对**转换时已存在**的
    // tools 生效。若在转换后赋值，parameters 会保持对象形态发给上游，
    // 被反序列化拒绝（且错误信息不会指向这里）。
    //
    // ⚠️ 同理，messages 必须**先**经 `serializeTraeMessages` 转成 OpenAI
    // 传输格式（tool_calls / role:'tool' / 纯文本 content）。DSH 的
    // 原生 content 块（tool-call / tool-result / reasoning）不是 SOLO 认识的
    // 结构，原样下发会让模型看不到工具调用与工具结果（详见该函数注释）。
    const wireMessages = serializeTraeMessages(options.messages, imageUrls)

    const openaiBody: Record<string, unknown> = {
      model: options.model,
      messages: wireMessages,
      stream: true,
    }
    if (options.tools !== undefined && options.tools.length > 0) {
      openaiBody.tools = options.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
    }
    if (options.temperature !== undefined) openaiBody.temperature = options.temperature
    /**
     * 会话自动命名（`purpose: 'session-title'`）的思考与预算决策（issue IKKVDH）。
     *
     * DSH 用 **64 token** 发标题请求且**不传 `reasoningEffort`**，而宿主会把
     * 本模型的默认档注入进来。TRAE 的档位来自远端
     * `reasoning_effort_config.options`（实测形如 `["light","high","extra_high"]`，
     * **没有 `off`/`none`**）⇒ 本家在多数模型上**关不掉**思考，只能走抬预算兜底。
     *
     * ⚠️ `declaredEfforts` **必须与 `reasoningFor` 同源**（对抗审计实测的分叉）：
     * `reasoningFor` 在 `supportThinking === false` 时**不声明任何档位**，而直接读
     * `reasoningConfig.options` 会绕过该过滤 ⇒ 「resolveModel 声明 null，标题路径却
     * 当真存在档位」。方向虽安全（只会多抬预算、不会下发不存在的档），但两份判据
     * 必须同源，否则将来某家新增 `off` 档时会静默分叉。
     */
    const titlePlan = planSessionTitleThinking({
      purpose: options.purpose,
      requestedEffort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      // 与 `reasoningFor(options.model)` 同源：经它过滤 `supportThinking === false`。
      declaredEfforts: this.reasoningFor(options.model)?.efforts.map((effort) => String(effort.id)) ?? [],
      maxTokens: options.maxTokens,
    })
    // 输出额度收敛到上游安全上限（默认 64000，见 clampTraeMaxTokens）。
    // 不收敛时客户端索要 131072 会把上游打成 4xx。
    // ⚠️ 抬预算（`titlePlan.maxTokens`）必须走**同一个**钳制函数，
    // 否则会被钳回原值、兜底静默失效。
    const maxTokens = clampTraeMaxTokens(titlePlan.maxTokens)
    if (maxTokens !== undefined) openaiBody.max_tokens = maxTokens
    if (options.stop !== undefined && options.stop.length > 0) openaiBody.stop = options.stop

    // 推理强度：DSH 注入的 `reasoningEffort` 原样透传给上游的 `reasoning_effort`。
    //
    // 取值来自 `resolveModel` 声明的 `reasoning.efforts`（即远端
    // `reasoning_effort_config.options` 的字符串），故这里不做白名单校验 ——
    // 校验只会把「远端新增档位」变成静默丢弃。
    //
    // ⚠️ 标题请求改走 `titlePlan.effort`：该模型若声明了 `off`/`none` 就是它，
    // 否则**保留原档位**（关不掉，靠上面的抬预算兜底）——
    // 绝不能自作主张把档位删掉（那会让「关不掉」变成「静默降档」）。
    if (titlePlan.effort !== undefined) {
      openaiBody.reasoning_effort = titlePlan.effort
    }

    // Max 模式（1M 上下文）：成套覆盖 `max_tokens` / `prompt_max_tokens` /
    // `context_window_size` 并注入 `strategy=max`（见 traeMaxModeFields）。
    //
    // ⚠️ 必须在 `clampTraeMaxTokens` **之后**执行：Max 会话的输出上限由远端
    // `__max` 明细声明（可能高于 64K 安全线），被 clamp 覆盖会让 Max 请求
    // 与常规请求的输出预算相同、失去意义。
    if (this.maxModeFor(options.model)) {
      const meta = this.remoteMeta.get(options.model)
      Object.assign(
        openaiBody,
        traeMaxModeFields(
          meta?.maxContextWindow ?? TRAE_MAX_CONTEXT_TOKENS,
          meta?.maxModeOutputTokens,
        ),
      )
    }
    // ⚠️⚠️ **标题请求的抬预算必须排在 Max 覆盖之后**（对抗审计实测的缺口）：
    // `traeMaxModeFields` **无条件**写 `max_tokens`，若抬预算写在它之前就会被
    // 覆盖掉。且远端 `__max` 明细只校验 `> 0`（`readDetailMaxTokens`），
    // 一个异常小的值（实测 `100`、`1`）会把预算压到**低于兜底下限** ⇒ 思考又被
    // 腰斩、本 issue 原样复发。故这里按「取两者较大」收敛，绝不让已抬高的值变小。
    if (titlePlan.isTitle && maxTokens !== undefined) {
      const current = openaiBody.max_tokens
      openaiBody.max_tokens = typeof current === 'number' && Number.isFinite(current) && current > maxTokens
        ? current
        : maxTokens
    }

    // system 提示并入 messages 顶部（同样要在转换之前，以便 content 被规范化）。
    if (options.system !== undefined && options.system.length > 0) {
      openaiBody.messages = [
        { role: 'system', content: options.system },
        ...wireMessages,
      ]
    }

    // ⚠️ **这里刻意没有本地历史闸门**（2026-10-04 删除，此前是一道字符预算裁剪）。
    // 唯一的限制是 **DSH 自己的压缩点**（`声明的窗口 × 0.8`）—— 与其余 13 个
    // provider 同形。删掉的理由、被删代码的来历与「若有人想加回来必须先读什么」
    // 都在下方 `TRAE 历史闸门（已删除）` 那段注释里；改动前务必先读它。
    // 序列化之后不再对 `openaiBody.messages` 做任何长度相关的删改。

    // 一次性完成 OpenAI → SOLO 转换（含 messages 规范化、tools 序列化、
    // tool_choice 归一化、config_name 注入），并**按模型路由通道** ——
    // 同一模型只在列出它的通道里可调用（发错通道会得到流内 4001）。
    const bodyObj = transformToSOLOBody(openaiBody, undefined, this.channelFor(options.model))

    const body = JSON.stringify(bodyObj)

    // 4. 发送请求（401/403 时刷新一次凭据后重试）
    let response = await this.send(credential, body, options)
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      await this.options.refresh()
      // 与主路径一致：按本模型选号（跳过正在限流的账号）。
      const refreshed = await this.options.resolveCredential(options.model, options.sessionId)
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('trae: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      response = await this.send(credential, body, options)
    }
    if (!response.ok) {
      let errorText = await response.text().catch(() => '')
      let lastStatus = response.status
      let lastKind = classifyTraeError(response.status, errorText)

      if (this.options.accountPool && shouldRotateTraeAccount(lastKind)) {
        const tried = new Set<string>()
        if (currentAccountId) tried.add(currentAccountId)
        // ⚠️ 必须先取出局部变量：闭包里 TS 不会保留 `this.options.accountPool`
        // 的非空窄化（`if` 判据只作用于本块），直接用会报 TS2532。
        const pool = this.options.accountPool

        /**
         * 给**当前**账号记冷却。认证类不记（见 `recordsTraeRateLimit`）。
         *
         * ⚠️ 必须**每次失败后立刻调用**，不能挪到 `for` 循环开头：挪在开头时
         * 最后一个失败账号等不到下一次迭代就被循环结束跳过，就此漏记 ——
         * 下次请求又选中它。用户报障形态与 loomy/raccoon 同款（PR !71 审计）。
         */
        const markCurrentAccount = async (): Promise<void> => {
          if (currentAccountId === '' || !recordsTraeRateLimit(lastKind)) return
          // 冷却时长按**类别**取（2026-09-26 修）：原实现一律用 1 小时兜底 ⇒
          // quota-exceeded（4008 = ide_credits **月度**耗尽）也只冷却 1 小时，
          // 1 小时后耗尽的账号被再次选中，又是 4008 —— 用户看到的就是
          // 「轮换好像不行，每次都我手动切」。月度级耗尽必须长冷却（7 天，
          // 覆盖到下次配额重置）；上游若给出明确重置时间应以那个为准，
          // 但 4008 响应里没有可靠的重置字段，故改的是兜底值本身。
          const cooldownMs = traeCooldownFor(lastKind)
          await pool.updateModelRateLimit(
            currentAccountId,
            options.model,
            Date.now() + cooldownMs,
          )
        }
        await markCurrentAccount()

        const maxRotate = TRAE_MAX_ROTATE - 1
        for (let round = 0; round < maxRotate; round++) {
          const next = await pool.getAvailableAccount<TraeCredential>(
            this.product.id, options.model, tried,
          )
          if (!next || tried.has(next.entry.id)) break
          tried.add(next.entry.id)
          credential = next.credential
          currentAccountId = next.entry.id
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consumeSse(response, options)
            return
          }
          errorText = await response.text().catch(() => '')
          lastStatus = response.status
          lastKind = classifyTraeError(response.status, errorText)
          await markCurrentAccount()
          if (!shouldRotateTraeAccount(lastKind)) break
        }
        throw new LlmError(
          `trae: 模型 ${options.model} 所有账号均不可用（${errorDetail(errorText)}）`,
          lastKind === 'quota-exceeded' ? 'QUOTA_EXCEEDED' : httpErrorCode(lastStatus),
          { status: lastStatus },
        )
      }

      if (lastKind === 'quota-exceeded') {
        throw new LlmError(`trae: 积分不足（${errorDetail(errorText)}）`, 'QUOTA_EXCEEDED', { status: lastStatus })
      }
      throw new LlmError(`trae: ${errorDetail(errorText)}`, httpErrorCode(lastStatus), { status: lastStatus })
    }

    // 5. 消费 SSE 流（SOLO → OpenAI 转换）
    //
    // ## 两条重试路径，共用同一个循环
    //
    // ① **空响应**（HTTP 200 但一个事件都没发）→ 重试一次（同账号）；
    // ② **流内可换号错误**（`event:error` 1005/4008/4011，见
    //    {@link TRAE_ROTATABLE_STREAM_ERROR}）→ **换号重发**。
    //
    // 两者都**只在尚未产出任何 chunk 时**才允许：`consumeSse` 保证空响应
    // 错误只在首个事件前抛；流内错误则由 `!gotAnyContent` 把关。因此不存在
    // 「已经吐了一半再重放」的重复计费与重复执行工具风险（对齐 CN 项目的
    // `TRAE_REMOTE_WORK_FALLBACK` 语义）。
    //
    // ⚠️⚠️ **「任何 chunk」是字面意思，不是「正文」**（2026-10-25 审计 P0 修复）：
    // 旧实现只在 `ev.response` 非空时置 `gotAnyContent`，于是「已发出思考」与
    // 「已发出工具调用」两种情况仍会被判成「尚未产出」⇒ 换号重发。而重试循环
    // 在**本函数内部**，harness 只看到一条连续流 ⇒ 第一次 attempt 的
    // `tool-call-delta` 会变成**幽灵调用**：`BlockAssembler.assembled()` 只在
    // `max-tokens` 时丢弃 tool-call（**不过滤**没有 `block-end` 的 partial），
    // `dsh-agent-loop` 也不去重 ⇒ harness 会执行一个模型已经放弃的工具调用。
    // ⇒ 三个发射点（`text-delta` / `reasoning-delta` / `tool-call-delta`）
    // **必须都**置真，且只在**真正 yield 之后**（被 suppressor / 死循环守卫 /
    // 空名字拦下的分片一个 chunk 都没发，重发不产生幽灵调用）。
    // 守卫：`tests/unit/trae-adapter.spec.ts` 的两条 `★★★ P0` 用例。
    const triedStreamAccounts = new Set<string>()
    if (currentAccountId.length > 0) triedStreamAccounts.add(currentAccountId)
    let rotateBudget = TRAE_MAX_ROTATE - 1

    for (let attempt = 0; ; attempt++) {
      try {
        yield* this.consumeSse(response, options)
        return
      } catch (error) {
        // ② 流内可换号错误 → 标记当前账号 + 取下一个账号重发。
        if (error instanceof LlmError && error.code === TRAE_ROTATABLE_STREAM_ERROR) {
          // 无账号池 → 无从换号，如实抛出（去掉哨兵码，换真实语义）。
          //
          // ⚠️⚠️ **`rotateBudget <= 0` 的抛出不能放在这里**（2026-10-25 审计 P1）：
          // 旧实现在此直接 `throw`，于是「预算刚好用尽」的那一次**当前账号
          // 一个冷却标记都不写**就抛出了 —— 用 3 个账号的池实测，第一轮只标
          // 2 个，那个漏标的账号下次选号时没有任何标记可过滤 ⇒ **立刻又被选回**
          // （正是「轮换好像不行」的第三个成因）。故先标记、再判预算。
          if (this.options.accountPool === undefined) {
            throw new LlmError(error.message, 'QUOTA_EXCEEDED')
          }
          if (options.signal?.aborted) throw error
          // 标记当前账号在本模型上受限（UI 据此亮「限额重置」徽章）。
          //
          // ⚠️ 与 HTTP 层同款：只标记**该模型**，该账号在别的模型上仍可用。
          //
          // ⚠️ 冷却时长必须**按类别**取（2026-10-05 修）：从哨兵错误的
          // `cause` 里取回流内 errorCode，重分类后走与 HTTP 层**同一张**
          // `traeCooldownFor` 表——quota-exceeded 24h、hard-plan 12h、
          // soft-rate 60s（取值以 `trae-cooldown-table.ts` 为准，别再凭印象写）。
          // 旧实现一律 1h 兜底，额度耗尽的账号 1 小时后被选回、又 4008
          // （同款缺陷的流内第二实例，见抛出点注释）。
          //
          // ⚠️ 重分类必须走 {@link classifyTraeStreamCode}（**结构化码**入口），
          // 不能拿 `classifyTraeError` 喂 JSON（2026-10-24 修）：文案表判
          // `hard-plan` 还要求 `plan` 关键词，而流内 `message` 可能是**空串**
          // ⇒ 判成 `none` ⇒ 冷却 **0ms** ⇒ 标记写不下去、换号形同虚设
          // （真实报障：`trae:  (code=1005)`，两个账号同被同一模型拒）。
          //
          // ⚠️ 该入口**只查码表**（2026-10-25 审计 F-02 起）：它不再接受
          // `message`、也不回落文案表 —— 那个回落腿在生成路径上不可达，且
          // 复活的正是上面这条缺陷的形态。表外码在这里拿到 `undefined`，
          // 由下一行的 `TRAE_RATE_LIMIT_FALLBACK_MS` 兜底。
          if (currentAccountId.length > 0) {
            // ⚠️ instanceof 收窄一次、两个字段都从收窄后的引用取（PR #64 审查 1）：
            // 对 `unknown` 的行内可选链不做窄化，`cause?.message` 会报 TS2339 挡构建。
            const streamErr = (error as { cause?: unknown }).cause instanceof TraeStreamErrorCause
              ? (error as { cause?: TraeStreamErrorCause }).cause
              : undefined
            const kind = streamErr !== undefined
              ? classifyTraeStreamCode(streamErr.code)
              : undefined
            const cooldownMs = kind !== undefined ? traeCooldownFor(kind) : TRAE_RATE_LIMIT_FALLBACK_MS
            await this.options.accountPool.updateModelRateLimit(
              currentAccountId,
              options.model,
              Date.now() + cooldownMs,
            )
          }
          // ⚠️ **标记之后**才判预算（2026-10-25 审计 P1，见上面那条注释）：
          // 预算用尽时当前账号已经写好冷却，此处抛出不会漏标。
          if (rotateBudget <= 0) {
            throw new LlmError(error.message, 'QUOTA_EXCEEDED')
          }
          rotateBudget -= 1
          // 取下一个账号。
          //
          // ⚠️ **必须传真实 modelId 且传 `tried`**：
          // - 传空串会让限流过滤整体短路（`if (modelId.length === 0) return true`），
          //   刚标记的账号立刻又被选中 —— 换号形同虚设；
          // - 不传 `tried` 会在 A/B 之间反复空转（Qoder 已踩过，见
          //   `qoder-adapter.ts` 的 `switchAccountOnQuota` 注释）。
          const next = await this.options.accountPool.getAvailableAccount<TraeCredential>(
            this.product.id, options.model, triedStreamAccounts,
          )
          if (next === null || next === undefined || triedStreamAccounts.has(next.entry.id)) {
            throw new LlmError(error.message, 'QUOTA_EXCEEDED')
          }
          triedStreamAccounts.add(next.entry.id)
          credential = next.credential
          currentAccountId = next.entry.id
          response = await this.send(credential, body, options)
          if (!response.ok) {
            const text = await response.text().catch(() => '')
            const kind = classifyTraeError(response.status, text)
            if (!shouldRotateTraeAccount(kind)) {
              throw new LlmError(`trae: ${errorDetail(text)}`, httpErrorCode(response.status), { status: response.status })
            }
            // 新账号在 HTTP 层就失败 → 继续下一轮（受 rotateBudget 约束）。
            continue
          }
          continue
        }

        // ① 空响应重试（同账号，一次）。
        const empty = error instanceof LlmError
          && error.message.includes('upstream returned no events')
        if (!empty || attempt >= 1) throw error
        if (options.signal?.aborted) throw error
        response = await this.send(credential, body, options)
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new LlmError(`trae: ${errorDetail(text)}`, httpErrorCode(response.status), { status: response.status })
        }
      }
    }
  }

  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  private async send(
    credential: TraeCredential,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    this.sendCount += 1
    const headers = new Headers(
      traeSOLOHeaders(credential, this.product, true, this.machineIdGeneration()),
    )
    try {
      return await this.fetchImpl(`${this.product.agentHost}/api/agent/v3/llm_utils_chat`, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`trae: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }

  /**
   * 当前应使用的机器指纹代次。
   *
   * **默认恒为 0（不轮换）** —— 只有显式设置
   * `DSH_TRAE_ROTATE_MACHINE_ID=1` 时才按每 4 次请求递增一代。
   *
   * 默认关闭的原因见 {@link deriveRotatingMachineId}：轮换能降低端点风控，
   * 但会让设备身份漂移，与「machine_id 登录后绝不变」的既定约束冲突。
   * 该开关是出现集中 401/风控时的第一个可尝试手段。
   */
  private machineIdGeneration(): number {
    if (process.env.DSH_TRAE_ROTATE_MACHINE_ID !== '1') return 0
    return Math.floor(this.sendCount / TRAE_MACHINE_ID_ROTATE_EVERY)
  }

  /**
   * 消费 SOLO 自定义 SSE 流，转为 OpenAI StreamChunk。
   *
   * SOLO 事件格式（solosse.go）：
   * ```
   * event:output
   * data:{"response":"<增量>","reasoning_content":"<思考增量>","tool_calls":<null|数组>}
   *
   * event:token_usage
   * data:{"prompt_tokens":21,"completion_tokens":142,...}
   *
   * event:done
   * data:{"finish_reason":"stop"}
   *
   * event:error
   * data:{"code":4008,"message":"quota exceeded"}
   * ```
   */
  private async *consumeSse(
    response: Response,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('trae: empty model response body', 'EMPTY_RESPONSE')

    const blocks: Array<{ index: number; kind: 'text' | 'reasoning'; text: string }> = []
    let nextIndex = 0
    /**
     * 思考死循环检测（见 `createReasoningLoopDetector`）。命中后丢弃后续
     * reasoning 增量，收尾时发截断后的 block，并让 finish 报 max-tokens。
     *
     * 与 buddy 同因：`reasoning_tokens` **计入** `completion_tokens`，思考陷入
     * 病态重复就把输出额度烧光、正文零产出，而 `finish` 若是 `stop`，UI 上
     * 完全看不出错误。
     */
    const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
    let loopDetected = false
    /**
     * **正文**死循环检测（**独立实例**，见 `createReasoningLoopDetector`）。
     *
     * 真实缺陷（用户报障，2026-09-25）：唯一活动 session 出现**正文**循环，
     * 而旧实现只在 reasoning 分支调 `observe` → 正文循环完全看不见。
     *
     * ⚠️ 两个实例不可合并：判据看尾部 3000 字符窗口的行去重率，两条通道
     * 混进同一窗口会互相稀释，使守卫双双失效。
     *
     * ⚠️ 语义差异：实测正文循环的工具调用在循环正文**之后**到达且有效，
     * 故正文守卫**只截断文本**，绝不 `reader.cancel()`、绝不改 finish reason。
     */
    const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
    /** DSML 标记归一化器（见 sse.ts）；**每流一实例**，待定缓冲是跨帧状态。 */
    const dsmlFix = createDsmlMarkerNormalizer()
    let proseLoopDetected = false
    // ⚠️ 此处**曾有** `proseHasThinkTag` 门禁变量，2026-09-27 **删除**。
    // 逐帧探测在跨帧时必然漏判（实测二分帧 7/11 漏）→ 收尾不切分 → 标签泄漏。
    // 现改为收尾**无条件**调用 `splitThinkTaggedContent`。
    /**
     * 纯空白思考抑制器（见 `createBlankReasoningSuppressor`）。与 `blocks` /
     * `loopGuard` 同生命周期：**每个 `stream()` 调用建一个实例**。
     *
     * 为什么必须延后建块：`BlockAssembler` 在**没有 `block-end`** 时同样会用
     * `partial.text` 组装出块，故只在出口过滤挡不住空 Think 块 —— 必须从一开始
     * 就不发任何 chunk（与「空名字 tool_call」同型修法）。
     */
    const suppressor = createBlankReasoningSuppressor()
    const toolCalls = new Map<number, {
      index: number
      text: string
      callId?: string
      name?: string
      /** 是否已发过 `block-start`（名字可用的那一刻才发，见下方 tool_calls 分支）。 */
      announced: boolean
    }>()
    const toolOrder: number[] = []
    const toolIds = new Map<number, string>()
    let buffer = ''
    let streamEnded = false
    let finishReason: 'stop' | 'tool_calls' | 'length' | undefined
    // SSE 事件累积状态（跨行累积 event + data）
    let currentEvent = ''
    let currentData = ''
    /**
     * 是否**已经向上游消费者发出过任何模型产出**（正文 / 思考 / 工具调用）。
     *
     * ## ⚠️⚠️ P0：它不能只看正文（2026-10-25 审计 B2）
     *
     * 旧实现**只在 `ev.response` 非空时**置真（正文分片）。于是「已发出思考」
     * 与「已发出工具调用」两种情况下本标记仍是 `false` ⇒ 流内 `event:error`
     * 仍然整轮**换号重发**。而重试循环在 `stream()` **内部**，harness 只看到
     * **一条连续流** ⇒ 第一次 attempt 的 `tool-call-delta` 会变成**幽灵调用**：
     *
     * - `BlockAssembler.assembled()` **只在 `max-tokens` 时**丢弃 tool-call，
     *   **不过滤**没有 `block-end` 的 partial；
     * - `dsh-agent-loop` 直接 `filter(b => b.type === 'tool-call')` 后执行，
     *   **零去重**。
     *
     * 后果：模型在第二轮的答话里说「直接回答、不用跑命令」，而 harness 仍会
     * 执行第一轮那个工具；分片中断时参数还可能是**截断的非法 JSON**。
     *
     * ⇒ 判据必须是「**有没有发出过 chunk**」，而不是「有没有正文」。故三处
     * 发射点（`text-delta` / `reasoning-delta` / `tool-call-delta`）都要置真，
     * 且**只在真正 yield 之后**（被 suppressor / 死循环守卫 / 空名字拦下的分片
     * 一个 chunk 都没发，重发不会造成幽灵调用）。
     */
    let gotAnyContent = false
    /**
     * 是否收到过**任何**可解析的上游事件。
     *
     * ## 为什么需要它
     *
     * 上游有时会「会话创建成功、HTTP 200、然后一个事件都不发就结束流」
     * （CN 项目称之为 empty response，见 `main.py:3391-3408`）。这不是
     * 正常的空回复，而是可重试的瞬时故障。
     *
     * 关键是**只在首个模型事件之前**才允许重试：一旦已有 output / usage /
     * tool_calls 事件，重放请求会让上游**重复计费并可能重复执行工具**。
     * 因此本标记只在「一个事件都没收到」时才让调用方重试。
     */
    let sawAnyUpstreamEvent = false

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let firstTokenReceived = false

    try {
      for (;;) {
        if (streamEnded) break
        let result
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs()
          const phase = firstTokenReceived ? 'chunk' : 'first-token'
          result = await readWithIdleTimeout(reader, timeoutMs, 'trae', options.signal, phase)
          if (!result.done) firstTokenReceived = true
        } catch (error) {
          if (options.signal?.aborted) throw error
          if (error instanceof LlmError) throw error
          if (isTransportError(error)) {
            throw new LlmError(`trae: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
          }
          throw error
        }
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)

          // 空行 = 事件分隔符 → 解析累积的事件
          if (line.trim().length === 0) {
            if (currentEvent.length > 0) {
              const ev = parseTraeSSELine(currentEvent, currentData)
              currentEvent = ''
              currentData = ''
              if (ev === undefined) continue
              // 任何**可解析**的上游事件（含 metadata / timing_cost）都算
              // 「上游确实开工了」——此后绝不重放请求（见 sawAnyUpstreamEvent）。
              sawAnyUpstreamEvent = true

              // 分发事件
              switch (ev.event) {
                case 'output': {
                  const delta: Record<string, unknown> = {}
                  if (ev.response !== undefined && ev.response.length > 0) {
                    delta.content = ev.response
                    gotAnyContent = true
                  }
                  if (ev.reasoningContent !== undefined && ev.reasoningContent.length > 0) {
                    delta.reasoning_content = ev.reasoningContent
                  }
                  if (ev.toolCalls !== undefined && ev.toolCalls.length > 0) {
                    delta.tool_calls = ev.toolCalls
                  }

                  if (Object.keys(delta).length > 0) {
                    // 按块类型分发
                    if (delta.content !== undefined) {
                      let block = blocks.find(c => c.kind === 'text')
                      if (block === undefined) {
                        block = { index: nextIndex++, kind: 'text', text: '' }
                        blocks.push(block)
                        yield { type: 'block-start', index: block.index, blockType: 'text' }
                      }
                      // 正文死循环守卫（见 `proseLoopGuard` 注释）。命中后只停止
                      // 累积与发射，绝不 `reader.cancel()`、绝不改 finish reason。
                      if (proseLoopGuard !== undefined) {
                        if (proseLoopGuard.observe(delta.content as string)) proseLoopDetected = true
                      }
                      // ⚠️ **不要在这里逐帧探测 think 标签**（2026-09-27 移除）：
                      // 跨帧必然漏判（实测二分帧 7/11 漏）→ 收尾不切分 → 标签泄漏。
                      // 改为收尾无条件调用 `splitThinkTaggedContent`。
                      if (!proseLoopDetected) {
                        // ⚠️ **先归一化再累积**（2026-10-13，见 sse.ts 注释）。
                        const fixedDelta = dsmlFix.push(delta.content as string)
                        block.text += fixedDelta
                        if (fixedDelta.length > 0) {
                          gotAnyContent = true
                          yield { type: 'text-delta', index: block.index, text: fixedDelta }
                        }
                      }
                    }
                    if (delta.reasoning_content !== undefined) {
                      // 死循环守卫：命中后不再累积、不再发射。
                      //
                      // ⚠️ 这里**只跳过发射**：真正的止损（`reader.cancel()` +
                      // `break`）在本 chunk 的行循环**全部处理完之后**、外层
                      // `for (;;)` 末尾执行（见下方 ★ 止损块）—— 这样同一 chunk
                      // 里已到达的 `token_usage` / `done` 仍会被处理。
                      //
                      // ⚠️ 也**不能用 `continue`**（Task 2 审查发现，已独立复现）：
                      // 它会连带跳过本帧位于 reasoning 分支**之后**的处理。
                      // 本 provider 的 `usage` 走**独立** `token_usage` 事件、
                      // 不在此帧内，故被丢的是**同帧的 `tool_calls`**（一个
                      // `output` 事件确实可能同时携带两者，实测复现）。故用
                      // `if (!loopDetected)` 守卫分支体。
                      if (loopGuard !== undefined) {
                        if (loopGuard.observe(delta.reasoning_content as string)) loopDetected = true
                      }
                      if (!loopDetected) {
                        // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发，
                        // 于是既不建块、也不消耗 `nextIndex`（见 helper 注释）。
                        const emit = suppressor.feed(delta.reasoning_content as string)
                        if (emit !== undefined) {
                          let block = blocks.find(c => c.kind === 'reasoning')
                          if (block === undefined) {
                            block = { index: nextIndex++, kind: 'reasoning', text: '' }
                            blocks.push(block)
                            yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
                          }
                          // ⚠️ **整块回写**（赋值，不是 `+=`）：helper 内部已累积全部文本。
                          block.text = suppressor.text()
                          gotAnyContent = true
                          yield { type: 'reasoning-delta', index: block.index, text: emit }
                        }
                      }
                    }
                    if (delta.tool_calls !== undefined) {
                      const calls = delta.tool_calls as Array<Record<string, unknown>>
                      for (const call of calls) {
                        const wireIndex = typeof call.index === 'number' ? call.index : 0
                        if (typeof call.id === 'string' && call.id.length > 0) toolIds.set(wireIndex, call.id)
                        const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`
                        let block = toolCalls.get(wireIndex)
                        if (block === undefined) {
                          block = { index: nextIndex++, text: '', callId, announced: false }
                          toolCalls.set(wireIndex, block)
                        }
                        block.callId = callId
                        const callFn = call.function
                        const fn = typeof callFn === 'object' && callFn !== null ? callFn as Record<string, unknown> : undefined
                        if (fn !== undefined && typeof fn.name === 'string' && fn.name.length > 0) {
                          block.name = fn.name
                        }
                        const fragment = fn !== undefined && typeof fn.arguments === 'string' ? fn.arguments : ''
                        block.text += fragment
                        // ⚠️ **名称为空前不发射任何 chunk**（与 `openai-compat.ts` /
                        // `buddy-adapter.ts` 同因同修）。只跳过收尾的 `block-end`
                        // 不够 —— `BlockAssembler` 会把没有 block-end 的 partial
                        // 也组装成 `name:''`，污染会话后让下游端点以 400 拒绝请求。
                        if (!block.announced) {
                          if (!hasUsableToolName(block.name)) continue
                          block.announced = true
                          toolOrder.push(block.index)
                          gotAnyContent = true
                          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
                          yield {
                            type: 'tool-call-delta',
                            index: block.index,
                            id: ToolCallId(callId),
                            name: block.name!,
                            argumentsDelta: block.text,
                          }
                          continue
                        }
                        yield {
                          type: 'tool-call-delta',
                          index: block.index,
                          id: ToolCallId(callId),
                          ...block.name !== undefined ? { name: block.name } : {},
                          argumentsDelta: fragment,
                        }
                      }
                    }
                  }
                  break
                }
                case 'token_usage': {
                  if (ev.usage !== undefined) {
                    yield { type: 'usage', usage: traeUsageFromTokenUsage(ev.usage) }
                  }
                  break
                }
                case 'done':
                  if (ev.finishReason !== undefined) {
                    finishReason = ev.finishReason as 'stop' | 'tool_calls' | 'length'
                  }
                  streamEnded = true
                  break
                case 'error': {
                  // 上游 `event:error` → 作为业务错误抛出。
                  //
                  // ⚠️ **这里曾经的注释是错的**（本次修复）：
                  // > 如果是配额/plan 限流等可换号的错误，**不应该**走到这里
                  // >（错误响应走 HTTP 400+ 路径）
                  //
                  // 该假设与同文件的实测记录矛盾 —— 上游**确实**用流内
                  // `event:error` 下发错误（4001「param is invalid」已实测，
                  // 见 `traeStreamErrorMessage` 与 README 的 4001 条目）。
                  // 后果：额度类错误在此直接抛 QUOTA_EXCEEDED，**换号代码一行
                  // 都不执行**（它只写在 `if (!response.ok)` 里），而该码不在
                  // DSH 的可重试集合 → 用户报障「不会切换账号」。
                  //
                  // 现在：**未产出任何内容**时抛哨兵码，让外层换号重发；
                  // 已有输出则如实抛真实错误码（绝不重放，防重复计费）。
                  if (ev.errorCode !== undefined && ev.errorMessage !== undefined) {
                    const message = traeStreamErrorMessage(ev.errorCode, ev.errorMessage, options.model)
                    if (isRotatableTraeStreamCode(ev.errorCode) && !gotAnyContent) {
                      // ⚠️ **errorCode 必须随哨兵带出**（2026-10-05 修）：外层标记
                      // 冷却时长按类别取（quota 24h / hard-plan 12h / soft 60s）。`LlmErrorOptions`
                      // 是**官方校验契约**（只有 status/providerRetryAfterMs/requestId，
                      // 塞自由字段会被 `LlmError` 构造器拒绝）⇒ 走 `cause` 通道：
                      // Error.cause 本就用于「附加结构化诊断」，把 errorCode 编码进
                      // 一个轻量 Error 对象。裸 message 会丢掉类别 ⇒ 外层只能退回
                      // 1 小时兜底 ⇒ 流内额度耗尽的账号 1h 后又被选回、又 4008
                      // （HTTP 层同款缺陷已于 09-26 修过，流内侧漏改 = 第二实例）。
                      throw new LlmError(message, TRAE_ROTATABLE_STREAM_ERROR, {
                        cause: new TraeStreamErrorCause(ev.errorCode, ev.errorMessage),
                      })
                    }
                    // 4001（模型不可调用）不换号：换账号也是同一模型被拒。
                    // ⚠️ 归类走 {@link streamErrorCode}（4006 体积超限**不能**落 SERVER，
                    //    否则会被 harness 原样重发 5 次 —— 见该函数的说明）。
                    throw new LlmError(message, streamErrorCode(ev.errorCode))
                  }
                  break
                }
              }
            }
            continue
          }

          // 行处理
          const trimmed = line.trim()
          if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.slice(6).trim()
          } else if (trimmed.startsWith('data:')) {
            currentData += trimmed.slice(5) // SOLO data 可能会跨行拼接
          }
          // 注释行（":"）或其他忽略
        }
        // ★ 止损（终审 C1）：命中死循环后**中止上游**，否则 128000 token 照烧。
        // 原实现只跳过下行累积/发射，`for (;;)` 仍把流读到底 —— 实测上游
        // 200 帧被读 200 帧（守卫在 ~2304 字符即命中，99.5% 的额度仍被消耗）。
        //
        // ⚠️ 位置：内层行循环**之后**、外层 `for (;;)` 末尾 —— 同一 chunk 里已到达
        // 的 `token_usage` / `done` 事件因此仍会被处理，但命中后**立即**退出，
        // 不再读下一块。
        //
        // ⚠️ 只 cancel **reader**，绝不 abort `options.signal`：后者是调用方信号，
        // abort 会被上层报成「用户取消」而非**标记为不完整**的 `max-tokens`
        // （DSH 在 `max-tokens` 时**不自动重试**，由用户/上层决定是否继续）。
        // ⚠️ `.catch(() => {})` 不可省：连接已断时 `cancel()` 会抛错，不吞掉会把
        // 「正常止损」变成一次失败。
        if (loopDetected) {
          await reader.cancel().catch(() => {})
          break
        }
      }
    } finally {
      reader.releaseLock()
    }

    // ── 空响应判定（可重试信号）──
    //
    // 一个上游事件都没收到 = 上游静默结束事件流，属于**可重试的瞬时故障**，
    // 不是「模型决定不说话」。抛 TRANSPORT 让 DSH 的常规重试机制接管，
    // 同时保留精确原因（CN 项目同样把该情形归类为 retryable empty response）。
    //
    // 注意：这里**不能**改成返回一个空的正常 finish —— 那会让用户看到
    // 「模型回复为空」这种毫无线索的结果，且不会触发任何重试。
    if (!sawAnyUpstreamEvent) {
      throw new LlmError(
        'trae: upstream returned no events (empty response before first model event)',
        'TRANSPORT',
      )
    }

    /**
     * 本次响应**实际会发出的 `block-end` 数量**（＝真正落进 assistant 消息的块数）。
     *
     * ⚠️ **不能写成 `blocks.length`**：`blocks` 里可能留着**不会发出**的条目 ——
     * 纯空白思考块（已被 `suppressor` 压制，连 `block-start` 都没发）、
     * 或被清洗成空串的块。用 `blocks.length` 会把「零块响应」误判成「有块」，
     * 于是静默结束的缺陷原样保留。
     *
     * 故此处**在每个 `block-end` 的发射点自增**，与下面三段发射逻辑逐条对齐。
     *
     * ⚠️ 上方 `!sawAnyUpstreamEvent` 的 TRANSPORT 抛错**先于**本判据：
     * 「一个上游事件都没收到」是更具体的可重试信号，不该被泛化的零块判据
     * （EMPTY_RESPONSE）覆盖 —— 与 `kind !== 'stop'` 不改写同一条道理。
     */
    let blockCount = 0
    /** 本步**最终发出的正文**，供 finish 归类判定「是否被上游停止串截断」。 */
    let emittedProse = ''
    // 按创建顺序关闭每个块
    const textBlock = blocks.find(block => block.kind === 'text')
    for (const index of toolOrder) {
      const block = [...toolCalls.values()].find(candidate => candidate.index === index)!
      // `toolOrder` 只收「名字已可用」的块，故此处名字必然可用；不回退成
      // `?? ''` —— 那会把空名字块写进会话，正是本次修复要根除的污染路径。
      if (!hasUsableToolName(block.name)) continue
      blockCount += 1
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(block.callId ?? ''),
          name: block.name!,
          arguments: isTruncatedArguments(block.text) ? block.text : normalizeToolArguments(block.text),
        },
      }
    }
    // ── DSML 归一化收尾：下发待定缓冲 ──（与 openai-compat.ts / buddy 同款）
    {
      const tail = dsmlFix.flush()
      if (tail.length > 0 && !proseLoopDetected) {
        const tailBlock = blocks.find(candidate => candidate.kind === 'text')
        if (tailBlock !== undefined) {
          tailBlock.text += tail
          yield { type: 'text-delta', index: tailBlock.index, text: tail }
        }
      }
    }
    if (textBlock !== undefined) {
      // ── think 标签归位（见 `splitThinkTaggedContent`）──
      // 标签**前**的内心独白 → reasoning 块；标签**后**的真正文 → 本 text 块。
      // 无标签时**逐字节不变**。
      //
      // ⚠️ **必须无条件调用，不得加「先探测有没有标签」的门禁**（2026-09-27 修）：
      // 标签会**跨帧**到达，任何逐帧探测都会漏判（实测二分帧 7/11 漏），
      // 漏了就不切分、标签原样泄漏。无标签时本函数返回 undefined，故普通响应
      // 逐字节不变（仅多一次字符串扫描）。
      let textOut = textBlock.text
      {
        const split = splitThinkTaggedContent(textBlock.text)
        if (split !== undefined) {
          // ⚠️ **必须同时喂 `suppressor`**：收尾以 `suppressor.text()` 为
          // reasoning 块的权威，只改 `blocks` 条目不生效。
          if (split.reasoning !== '') {
            const existing = blocks.find(candidate => candidate.kind === 'reasoning')
            if (existing === undefined) {
              blocks.push({ index: nextIndex++, kind: 'reasoning', text: split.reasoning })
            } else {
              existing.text += split.reasoning
            }
            suppressor.feed(split.reasoning)
          }
          textOut = split.text
        }
      }
      // ── 残留标签**兜底剥离**（见 `stripBareThinkCloseTag`）──
      //
      // ⚠️ **默认关闭**（`DSH_THINK_LEAK_STRIP=1` 才启用）。用户决定（2026-09-27）：
      // > 暂时不需要泄露过滤……**加了过滤可能有思考解析失败但是被过滤我们发现不了。**
      // 即兜底会**掩盖解析层的失败**；当前要让泄漏如实呈现以便观测。
      //
      // ⚠️ **必须在切分之后**：切分负责「解析」，本行只兜底纯标签块。
      //
      // ⚠️ **必须在 hex 切分之后**（顺序不可颠倒）：若放在切分之前，
      // `思考</think:6124c78e></think>` 这类「hex 后跟裸标签」的形态会漏 ——
      // 切分把裸标签留在正文侧，直接泄漏进 UI（审计实测到的真实缺陷）。
      // 放在末尾同时覆盖两种形态：切分产物再剥一次、纯裸标签块（无 hex）也在此剥离。
      textOut = stripBareThinkCloseTagIfEnabled(textOut)
      // 正文死循环截断：只保留循环前的干净前缀。
      // ⚠️ **不改 finish reason**：工具调用仍要被执行。
      const truncated = proseLoopDetected && proseLoopGuard?.cutAt !== undefined
        ? textOut.slice(0, proseLoopGuard.cutAt)
        : textOut
      // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
      // ⚠️ DSML 归一化**整串兜底**（幂等，与 openai-compat.ts 同款）。
      const cleaned = fixDsmlMarkers(stripCourseLeakIfEnabled(truncated))
      // ⚠️ 归位后正文可能为空串 —— 空块会污染会话，且 DSH 的
      // `EMPTY_RESPONSE` 契约禁止产出空内容块。思考段已归位，故仍有产出。
      if (cleaned !== '') {
        blockCount += 1
        emittedProse = cleaned
        yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: cleaned } }
      }
    }
    const reasoningBlock = blocks.find(block => block.kind === 'reasoning')
    // ⚠️ 判据收紧为 `trim() !== ''`：纯空白思考不得被算作「有 reasoning 产出」。
    if (reasoningBlock !== undefined && reasoningBlock.text.trim() !== '') {
      // 命中死循环时只保留循环前的干净前缀（`cutAt`）。`block-end` 是
      // **权威覆盖**（已由 `scripts/verify-blockend-override.ts` 实证）：
      // 即便前面已 yield 了全部重复 delta，这里发截断后的 block 即可，无需撤回。
      //
      // ⚠️ 文本以 helper 为权威（`suppressor.text()`），**不用**
      // `reasoningBlock.text` —— 两者累积口径若不一致，以 helper 为准才能
      // 保证落块内容与 wire 一致。
      const suppressedReasoning = suppressor.text()
      const reasoningText = loopDetected && loopGuard?.cutAt !== undefined
        ? suppressedReasoning.slice(0, loopGuard.cutAt)
        : suppressedReasoning
      // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
      const cleanedReasoning = stripCourseLeakIfEnabled(reasoningText)
      if (cleanedReasoning !== '') {
        blockCount += 1
        yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: cleanedReasoning } }
      }
    }
    // 丢弃了无名 tool-call 且没有留下任何可用调用时，报 max-tokens 而非 stop ——
    // 否则模型本意调工具、harness 却认为「正常答完了」（无报错中断）。
    const argsTruncated = [...toolCalls.values()].some(block => isTruncatedArguments(block.text))
    /**
     * **模型把工具参数写坏**（结构闭合配平但 JSON 非法）—— 与「流被掐断」
     * 分开处置（真实缺陷，Gitee IKQ8Y1；与 `buddy-adapter.ts` 同因同修）。
     *
     * 只收**名字可用**的块：无名块的参数没有意义（它本来就会被丢弃）。
     */
    const invalidArgBlocks = [...toolCalls.values()]
      .filter(block => hasUsableToolName(block.name))
      .map(block => ({ block, kind: classifyToolArguments(block.text) }))
      .filter(entry => entry.kind === 'invalid')
    const droppedUnnamedCalls = [...toolCalls.values()].some(block => !block.announced)
    /**
     * 正文是否被**上游停止串**掐断（见 `isProseTruncatedByStopString`）。
     *
     * 上游把 `</think>` 当停止串：模型在正文里写它（哪怕包在反引号里）就会被
     * 掐断，但仍报 `finish_reason:"stop"` —— 我们据此判「正常答完」会让本轮
     * **没有任何报错就停住**。
     */
    const proseCutByStopString = finishReason === 'stop'
      && toolOrder.length === 0
      && isProseTruncatedByStopString(emittedProse)
    /**
     * 思考死循环是否**是唯一的产出**（无正文、无工具调用）。
     *
     * ⚠️ 与 `buddy-adapter.ts` / `openai-compat.ts` 同因同修（Gitee !IKIZNK）：
     * 只有该步没有可见产出时才报 `error` —— `error` 路径**不落
     * `assistant/message`**（实测 219 会话里 222 例），有正文/工具调用时报它会把
     * 用户可见内容整块丢掉。实测守卫命中的 25 例全部只有思考。
     */
    const reasoningLoopIsSoleOutput = loopDetected
      && emittedProse === ''
      && toolOrder.length === 0
    const reason = reasoningLoopIsSoleOutput
      // 思考死循环且无可见产出：报**有分辨力的 error**（见 REASONING_LOOP_CODE）。
      // ⚠️ 不能报 max-tokens —— UI 对它的固定文案是「已达到输出 token 上限」，
      // 把「检测到死循环」误导成「额度用满」（真实缺陷，Gitee !IKIZNK）。
      ? { kind: 'error' as const, failure: reasoningLoopFailure(
          loopGuard?.diagnostics,
          options.maxTokens,
          'reasoning',
        ) }
      // 循环命中但另有可见产出：只能报 max-tokens（保住内容），不能报 error。
      : loopDetected
        ? { kind: 'max-tokens' as const }
      // ⚠️ 工具参数写坏有自己的码（Gitee IKQ8Y1）：报 max-tokens 会让 UI 说
      // 「已达到输出 token 上限」（固定 i18n，不读适配器 message）。
      // 门禁：零正文 + 无另一个参数可解析的可用调用。
      : toolArgsInvalidIsSoleOutput(
          invalidArgBlocks.length,
          emittedProse,
          toolCalls.values(),
          finishReason === 'length' || (finishReason === undefined && !streamEnded),
        )
        ? { kind: 'error' as const, failure: toolArgsInvalidFailure(
            toolArgsInvalidBlocks(invalidArgBlocks),
          ) }
      : finishReason === 'length'
        || (finishReason === undefined && toolOrder.length > 0)
        || argsTruncated
        || proseCutByStopString
        || (droppedUnnamedCalls && toolOrder.length === 0)
        ? { kind: 'max-tokens' as const }
        : finishReason === 'tool_calls' || toolOrder.length > 0
          ? { kind: 'tool-calls' as const }
          : { kind: 'stop' as const }
    // 零内容块响应（例如本次只收到过那个被压制的空白 reasoning）否则会以
    // `stop` 收场 —— 那是 DSH `EMPTY_RESPONSE` 契约明令禁止的静默结束。
    // ⚠️ 传入的是**上面已算好的** `reason`（含 loopDetected / length /
    // 无名 tool-call 等全部既存判据）；helper 只在 `kind === 'stop'` 时改写。
    yield { type: 'finish', reason: resolveEmptyResponseReason(reason, blockCount) }
  }
}

/**
 * ⚠️ TRAE **没有**本地历史闸门（2026-10-04 删除）。改动本文件前请先读完这段。
 *
 * 这里原先有一道「请求体字符预算」裁剪：超预算就从最早的非系统消息开始整轮丢弃
 * （`trimTraeHistory` + `resolveMaxHistoryChars` + `TRAE_MAX_CHARS_PER_TOKEN`，
 * 以及逃生舱 `DSH_TRAE_MAX_HISTORY_CHARS`）。它已被**整体删除**，理由三条：
 *
 * 1. **它的依据是从别的项目抄来的，未在本仓库实测**。原文写的是「对齐
 *    `Trae2api-cn` 的实测结论：上游在 query 超过约 500K 字符时会静默结束事件流」，
 *    于是把那个项目的 `TRAE_REMOTE_MAX_HISTORY_CHARS=480000` 抄成本插件写死的
 *    480,000。而 `480000 = 2.4 × 200000` —— 那是**声明窗口本身的量级**，
 *    不是量出来的字符天花板。
 * 2. **它守的是别人客户端的形态**。那两道闸门的另一道是
 *    `TRAE_REMOTE_QUERY_MAX_CHARS`（**扁平化 query** 的硬上限），而本插件的 trae
 *    链路里**根本没有 `query` 字段** —— 我们发的是 OpenAI 形状的 `messages[]`
 *    （上游那句 `Messages with role 'tool' must be a response to a preceding
 *    message with 'tool_calls'` 本身就证明它在逐条读 role）。
 * 3. **它的前提被本仓库的探针推翻了**。2026-10-04 的实发探针（请求体抓下来打印确认
 *    档位）在**常规档**（非 Max，`含 strategy=false context_window_size=false`）实测：
 *
 *    | 正文字符 | 服务端 `input_tokens` | 字符/token | 结果 |
 *    |---|---|---|---|
 *    | 40,398（标定） | 9,827 | 4.11 | 200 + 正中标记命中 |
 *    | **700,404** | 173,712 | 4.03 | **200 + 正中标记命中** |
 *    | **1,000,484** | 249,351 | 4.01 | **200 + 正中标记命中**（比 200K 窗口还多 24%） |
 *    | 900,303（中文正文） | 422,672 | 2.13 | 200 + 正中标记命中 |
 *
 *    ⇒ 「约 500K 字符即静默断流」被**证伪到 2 倍**（100 万字符仍完整送达）；
 *    ⚠️ 并**更正一处旧误标**：早先那次 900,303 字符的记录被写成「Max 档」，
 *    但探针构造适配器时没有注入远端元数据，而 `maxModeFor()` 要求远端
 *    `display_config.max_mode === true`（见本文件 `maxModeFor`）—— 它其实是**常规档**。
 *
 * ## 它造成的是**净损害**（这是删除的决定性理由）
 *
 * 引入 Max 模式（声明 1M tokens）后，写死的 480,000 没跟着涨，与 DSH 的压缩点
 * （`窗口 × 0.8`，1M → 800K tokens ≈ 170 万字符）**脱钩**：界面显示「才用了 8%」，
 * 适配器却每轮静默丢掉约四分之三的历史（真实会话量：1,898,903 字符 = 旧预算的
 * **396%**）。用户报障原文「trae 显示的上下文长度不对」——
 * **那正是这道闸门造成的**，不是任何上游限制造成的。
 *
 * 中间版本把它改成「声明窗口 × 系数」（系数 2 → 5），能让**实测内容**下不再误伤，
 * 但仍有两个消不掉的问题：
 *
 * - **字符闸门在数学上不可能被证明「永不先于 DSH 的压缩点生效」**：DSH 的界是
 *   token、闸门是字符，只要内容的字符/token 足够高（系数 5 ⇒ 6.25），任何**有限**
 *   系数都会被绕过。系数 5 只是把触发条件推到实测值（中文 2.13、英文/代码 4.0）
 *   之外，而不是消灭它。
 * - 全仓库**只有 trae 有这条「静默丢历史」的路径**：其余 provider 把 DSH 的
 *   压缩点当唯一真相；唯一的另一类体积防护（`src/image-budget.ts`）
 *   作用在**单张图的编码字节**上，且压不下去时**抛 `UNSUPPORTED_CONTENT`**（可见），
 *   而不是悄悄丢消息。
 *   ⚠️ **刻意不写「几家共用」**：本节原写「**13 家共用**」，实测按**家**展开
 *   （一个适配器可能服务两家）只有 **9 家**（`buddy`/`workbuddy`/`cline`/`zcode`/
 *   `gemini`/`raccoon`/`qoder`/`qodercn`/`lobsterai`）。该数**从写下时就不对**
 *   —— 引入它的那笔提交里实测同样是 9，不是「后来有人不用了」。
 *   另有 5 家（`trae` / `loomy` / `minimax` / `codearts` / `opencode`）**完全不用**
 *   该模块 —— 它们的图片路径各有自己的判据（`loomy` 与 `minimax` 实测都是
 *   **显式抛 `UNSUPPORTED_CONTENT`**，同样可见、同样不静默）。
 *   ⇒ 这类「家数」是**必然腐坏**的快照，别在这里写数字。
 *
 * ⇒ 因此删掉它：**静默丢历史这一类缺陷在结构上消失**，trae 与其余各家同形，
 * 真正的限制只有一个 —— DSH 的压缩点。
 *
 * ## 如果将来要加回来
 *
 * 先做**实发探针**，不要抄常数、也不要按窗口折算：
 *
 * 1. 用真实链路量出「多大体积开始出问题」，以及出问题时是**可见错误**还是
 *    **静默结束**。⚠️ 截至 2026-10-04：常规档已知 **100 万字符 / 24.9 万 tokens
 *    仍正常返回**（正中标记命中），「约 50 万字符」那条传闻已被证伪到 2 倍；
 *    真正的 **Max 档**（注入远端 `max_mode=true` 后的 1M 声明）与常规档 > 100 万
 *    字符**都还没探** —— 但闸门已删，这两点只在「想加回来」时才需要补；
 * 2. 若确实要设闸门，它**必须可观测**（记日志/上报），不能静默改语义；
 * 3. 判据与全部取证见 `AGENTS.md` 的「TRAE 历史闸门（已删除）」段。
 *
 * 失败落点（**已知可见**，不是静默）：一个上游事件都没收到会抛 `TRANSPORT`
 * （"upstream returned no events"，见本文件 `stream()` 的 `!sawAnyUpstreamEvent`
 * 分支），并由 DSH 的常规重试接管（那次重试判据见 `isTransportError`）。
 *
 * ---
 *
 * 在 `ctx.llm` 上注册 TRAE provider 路由与适配器。
 */
export function registerTraeLlm(ctx: Context, options: TraeAdapterOptions): TraeAdapter {
  const product = options.product ?? TRAE
  const adapter = new TraeAdapter({
    ...options,
    // ⚠️ 注入**唯一**的广播实现（`src/catalog-broadcast.ts`），不要在这里
    // 另写一份 emit —— 两份实现必然漂移（issue IKJVTF 的缺陷① 就是「十处全漏」）。
    onCatalogLoaded: () => broadcastCatalogChanged(ctx),
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  // 返回实例：Jet Hub 的「显示列表」需要它的 `listAllModels()`（不受用户黑名单
  // 影响的全量目录，带最终展示名/倍率）。DSH 的 `ctx.llm` 不透传自定义方法，
  // 故必须由调用方持有引用。
  return adapter
}
