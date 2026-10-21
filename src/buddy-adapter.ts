/**
 * buddy (腾讯 CodeBuddy) LlmAdapter
 *
 * 使用标准 OpenAI Chat Completions 协议 + Bearer access_token 鉴权。
 * 认证由 buddy-auth.ts 服务完成（external-link-v2 轮询式登录 + refresh_token 续期）。
 *
 * 端点：https://copilot.tencent.com/v2/chat/completions
 * 模型列表：静态默认（对齐 /v3/config craft agent models）+ 登录后的动态拉取
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmAdapter, LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { createModelCatalog, isCatalogFreshFor, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { RemoteCatalogGate, REMOTE_CATALOG_COOLDOWN_MS } from './remote-catalog-gate.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import {
  RATE_LIMIT_FALLBACK_MS,
  isModelSaturationError,
  isRateLimited,
  parseRateLimitError,
} from './llm-adapter.js'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
  credentialExpiresAtMs,
  formatCreditsRate,
} from './buddy.js'
import type { BuddyCredential, BuddyRemoteModel } from './buddy.js'
import { CODEBUDDY, resolveUserAgent, type BuddyFallbackModel, type BuddyProduct } from './product.js'
import { normalizeHarnessMessages } from './message-shape.js'
import { projectRequestImage, type ImageRequestTarget } from './image-budget.js'
import { createBlankReasoningSuppressor, createDsmlMarkerNormalizer, createReasoningLoopDetector, fixDsmlMarkers, hasUsableToolName, isProseTruncatedByStopString, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, reasoningLoopFailure, resolveEmptyResponseReason, resolveToolPairing, splitThinkTaggedContent, stripBareThinkCloseTagIfEnabled, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from './sse.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import { reportLedgerAccount } from './token-ledger.js'
import { planSessionTitleThinking } from './session-title.js'
// ⚠️ 腾讯系内容级风控的指纹改写 —— 与 **OpenAI 网关**共用同一份真相源
// （`src/openai-gateway/tencent-fingerprint.ts`）。该模块**零 import**，
// 故从 `src/` 反向引它不构成环。
// 直连路径**必须**也走它：会话历史里的 `assistant` 正文实测会被拦
// （400/11128），而「排查这个风控问题的会话」必然会把那句复述进正文 ——
// 只在网关补 = 换一个入口又被拦。依据见那个文件的头。
import { rewriteTencentContentFingerprints } from './openai-gateway/tencent-fingerprint.js'
// ⚠️ `detail` 那条腿**只留一份实现**（`openai-compat.ts`）：本仓库 6 份同义的
// `errorDetail` 各写一条判据必然漂移（IKLBSH A1）。
import { detailFieldText, TOOL_RESULT_IMAGE_TEXT } from './openai-compat.js'
// ⚠️ 原生搜索的错误码与错误类型从**契约文件**取（`native-search-contract.ts`）：
//    取数虽已下沉到本适配器，但「同一种失败在任何渠道报同一个码」这条不能破 ——
//    否则排查时会把「无账号」误判成「上游故障」。
//    契约单独成文件是为了避免「渠道层 import 工具层」的反向依赖。
import { classifyNativeAbort, NativeSearchCodes, WebNativeError, type NativeSource } from './native-search-contract.js'

/**
 * CodeBuddy（中国版）的 chat completions 基址。
 *
 * 仅供既有导入方（如 e2e 探针）使用；适配器实例实际请求的基址是
 * `` `${this.product.endpoint}/v2` `` —— 国际版 WorkBuddy 的域名不同
 * （www.workbuddy.ai），故不能再用本常量拼接请求 URL。
 */
export const CHAT_API_BASE = 'https://copilot.tencent.com/v2'

/**
 * 是否为 DeepSeek 系模型（前缀匹配，不区分大小写）。
 *
 * 对齐 workbuddy2api-panel `thinking.go` 的 `isDeepSeekModel` 判定口径与
 * 官方客户端 `thinkingFormat:"deepseek"` 标记：deepseek 系模型「开思考」
 * 必须显式带 `thinking:{type:"enabled"}` + `reasoning_effort` 档位，缺任一
 * 上游都按不思考应答（`reasoning_content` 为空/缺失）。glm/kimi 等其他模型
 * 走各自 thinkingFormat（默认开或 `enable_thinking`），不需要此开关。
 */
function isDeepSeekModel(model: string): boolean {
  return /^deepseek/i.test(model.trim())
}
/**
 * CodeBuddy 的 provider 路由名（历史常量，保留导出以兼容既有导入方）。
 *
 * 注意：适配器实例实际使用的路由名是 `product.id`（`this.product.id`），
 * 本常量只表示 CodeBuddy 那一份取值，不再代表所有产品。
 */
export const PROVIDER = 'buddy'

/** 静态默认模型（对齐 /v3/config 返回的 craft agent models；动态拉取失败时的兜底）。 */
const DEFAULT_MODELS: readonly string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'hy4-preview',
  'hy4-preview-x',
  'hy3',
  'hy3-x',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'kimi-k3-1',
  'kimi-k2.7',
  'kimi-k2.6',
  'minimax-m3',
]

/**
 * 图片能力判定为「未知」时，距上次目录拉取至少要过这么久才值得重试。
 *
 * 用户 2026-10-06 定：失败后**至少 10 秒**才重新看一次模型列表。
 * 上界取 30s（`REMOTE_CATALOG_COOLDOWN_MS`）—— 即比默认冷却短，
 * 使「请稍后重试」这句话在十秒后真的兑现，而不是让用户等到 30 秒。
 */
const BUDDY_IMAGE_CAPABILITY_RETRY_MS = 10_000

/** 默认模型（deepseek-v4-flash，对齐 IDE 默认）。 */
export const DEFAULT_MODEL = 'deepseek-v4-flash'

/**
 * 模型上下文窗口（对齐 Rust BuddyProvider::context_limit 的静态 fallback 表；
 * 权威来源是 /v3/config data.models[].maxInputTokens，由 fetchRemoteModels
 * 动态拉取后经 resolveRemoteContextWindow 优先采用，此表仅作远端不可用时的兜底）。
 */
const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['deepseek-v4-flash', 1_000_000],
  ['deepseek-v4-pro', 1_000_000],
  ['hy4-preview', 1_000_000],
  ['hy4-preview-x', 1_000_000],
  ['hy3', 192_000],
  ['hy3-x', 192_000],
  ['glm-5.3', 1_000_000],
  ['glm-5.3-flash', 1_000_000],
  ['glm-5.2', 1_000_000],
  ['glm-5.1', 200_000],
  ['glm-5v-turbo', 200_000],
  ['kimi-k3-1', 1_000_000],
  ['kimi-k2.7', 256_000],
  ['kimi-k2.6', 256_000],
  ['minimax-m3', 512_000],
])

/**
 * 模型是否接受图片输入（远端 /v3/config `supportsImages` 不可用时的兜底）。
 *
 * 权威来源是远端下发的 `supportsImages`；此表只在远端未下发该字段时使用。
 * 实测（2026-09 /v3/config）craft agent 的对话模型全部 supportsImages=true，
 * 故这里列出全部对话模型，非对话模型（codewise-* 等）不在此表内。
 */
const IMAGE_MODELS: ReadonlySet<string> = new Set([
  'deepseek-v4-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-sg',
  'deepseek-v4-pro',
  'hy4-preview',
  'hy4-preview-f',
  'hy4-preview-x',
  'hy3',
  'hy3-x',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'kimi-k3',
  'kimi-k3-1',
  'kimi-k2.8-preview',
  'kimi-k2.7',
  'kimi-k2.6',
  'minimax-m3',
])

/**
 * 各模型可选的思考等级（远端 `reasoning.supportedEfforts` 不可用时的兜底）。
 *
 * 只列出**可枚举**等级的模型；仅有固定默认 effort 的模型（glm-5.1/kimi-*）
 * 不在此表内，即不向用户暴露等级选择器。
 */
const REASONING_EFFORTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['deepseek-v4-flash', ['low', 'high', 'max']],
  ['deepseek-v4.1-flash', ['low', 'high', 'max']],
  ['deepseek-v4-pro', ['low', 'high', 'xhigh']],
  ['hy4-preview', ['high']],
  ['hy4-preview-x', ['high']],
  ['hy3', ['low', 'high']],
  ['hy3-x', ['low', 'high']],
  ['glm-5.3', ['low', 'high', 'max']],
  ['glm-5.3-flash', ['low', 'high', 'max']],
  ['glm-5.2', ['high', 'xhigh']],
])

/** 思考等级 id → 展示名（对齐 DeepSeek 官方 provider 的命名）。 */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

export interface BuddyAdapterOptions {
  credentialRef: CredentialRef
  /** 前缀缓存会话标识（prompt_cache_key）；未提供时随机生成一个。 */
  sessionId?: string
  /** 从凭据存储解析凭据。 */
  resolveCredential: (modelId?: string) => Promise<BuddyCredential | undefined>
  /** 静默续期凭据。 */
  refresh: () => Promise<void>
  /** 动态拉取远端模型列表（含上下文窗口与能力，若远端下发）；失败时调用方回退到静态列表。 */
  fetchRemoteModels?: () => Promise<BuddyRemoteModel[]>
  /**
   * 最近一次目录拉取的**各来源成败**（issue IKJVTF，审计 I3）。
   *
   * buddy 的目录来自**两个**端点（`/console/enterprises/{scope}/models` +
   * `/v3/config`），两者 id 集合不同、必须取并集 ⇒「一个成功、一个失败」是常态。
   * 失败路径**静默**返回空 ⇒ 旧判据 `models.length > 0` 会把它当成完整并永久缓存
   * ⇒ 只在另一个端点下发的变体（如 `hy4-preview-f`）及其促销倍率再也回不来。
   *
   * ⚠️ 用**回调**而非直接读 `BuddyAuth` 的内部状态：适配器不该依赖 auth 服务的
   * 字段形状（它由 `index.ts` 接线，单测用替身）。返回 `undefined` 时按
   * 「无法判定」处理（`complete = got`，与 `normalizeLoadResult` 同口径）。
   */
  catalogComplete?: () => boolean | undefined
  /**
   * 读取一张图片的原始字节（图片输入必需）。
   *
   * 由调用方桥接 `ctx.attachments.readImage(ref)`。**失败必须抛错**：
   * 未提供本回调时适配器会报 UNSUPPORTED_CONTENT；提供了但读不到字节时
   * 也必须抛错（不要返回 undefined），否则图片会被静默丢弃、线上请求
   * 退化成纯文本，而用户看不到任何原因。
   *
   * 返回类型刻意不含 `undefined`——早期契约允许返回 undefined 表示
   * 「读不到」，调用方据此 `continue`，正是静默丢图的源头。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string }>
  /**
   * 读取一张图片的**请求版本**（按目标尺寸缩放后的字节），用于替代裸原图。
   *
   * ⚠️ 与 {@link readImage} 的错误契约**刻意相反**：本回调**不可用时必须返回
   * `undefined`**（而不是抛错），因为缩放是一项优化 —— 附件服务未装、版本过旧
   * 没有 `readImageRequest`、或后端拒绝投影（`ATTACHMENT_PROJECTION_UNSUPPORTED`）
   * 时，正确行为是**发原图**，而不是把一次本来能成功的请求打死。
   * 桥接实现见 `src/index.ts` 的 `makeReadImageRequest`。
   *
   * 背景（issue !IKITT9）：原先恒发原图，36 张 1721×997 的截图就顶穿网关
   * 「单次请求图片视觉 token ≈100,000」的上限，此后该会话每一轮都失败。
   */
  readImageRequest?: (
    attachment: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  fetchImpl?: typeof fetch
  /** 多账号池（用于限流时切换账号） */
  accountPool?: AccountPool
  /**
   * 产品配置；默认为 CodeBuddy。
   *
   * 决定请求身份标识（X-Product-Code / User-Agent）、模型元数据的 provider
   * 字段、providerInfo 的展示名，以及 registerBuddyLlm 注册的路由名。
   * 两个内置产品（CodeBuddy / WorkBuddy）共用同一后端与协议，
   * 差异全部由本配置承载。
   */
  product?: BuddyProduct
  /**
   * 远端目录闸门的时钟来源，默认 `Date.now`。
   *
   * 存在的理由：`refreshCatalog` 的「距上次拉取 ≥10 秒才重试」是一条
   * **基于时间**的契约（见 `BUDDY_IMAGE_CAPABILITY_RETRY_MS`），而闸门的
   * 冷却与间隔判定都走这个时钟。注入它可零副作用地验证该契约 ——
   * 改全局时钟（`vi.setSystemTime`）会污染同进程其余用例。
   */
  now?: () => number
  /** 目录闸门的失败冷却时长，默认 {@link REMOTE_CATALOG_COOLDOWN_MS}。 */
  catalogCooldownMs?: number
  /**
   * 远端目录**落地后**的通知回调（issue IKJVTF）。
   *
   * 由 `registerBuddyLlm` 注入为 `broadcastCatalogChanged(ctx)`。适配器本身
   * 拿不到 `ctx`，故必须由接线层桥接（与 `readImage` 等回调同一模式）。
   *
   * ⚠️ 必要性：客户端 `ModelCatalogDirectory` 在 `status === 'ready'` 时**短路
   * 返回缓存**，只在宿主事件上 `refresh()`。没有本回调时，冷启动首拉失败
   * 缓存的**兜底表**会永久留在对话框里，远端目录真的落地也不重读。
   */
  onCatalogLoaded?: () => void
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

/**
 * 将 harness 对话消息序列化为 CodeBuddy chat-completions 的传输格式。
 *
 * 与 openai_chat/codearts 适配器一致：assistant 的 `tool-call` 块转为
 * `tool_calls`，`reasoning` 块折叠为 `reasoning_content`，user 消息中搭载的
 * 工具结果展开为独立的 `{role: 'tool'}` 消息。
 *
 * 两点 CodeBuddy 特有要求（对齐 Rust buddy.rs）：
 * - assistant 消息**始终**携带 `reasoning_content` 字段（推理模型缺失会 400）
 *   ——与 codearts 的 deepseek-v4 校验一致；
 * - 正文为空且带 tool_calls 时 `content` 必须为 `null`（对齐 openai_chat.rs）。
 *
 * ⚠️ 第三件事（2026-10-12 补）：**腾讯系内容级风控的指纹改写**。
 * `system` 与 `assistant` 正文这两处要过 `rewriteTencentContentFingerprints`
 * ——与 OpenAI 网关**同一份表、同一判据**（为什么两处都要、以及为什么
 * `user` / `tool` / `reasoning_content` / `tool_calls.arguments` 都不要，
 * 全部是实测结论，见 `src/openai-gateway/tencent-fingerprint.ts` 的文件头）。
 * `provider` 形参就是为它加的：本函数服务 `buddy` / `workbuddy` 两个产品，
 * 而这个函数**自己**该只对腾讯系生效 —— 非腾讯系必须逐字节不变。
 */
/**
 * 「wire 首条不是 system」时补在首位的最小 system 文本。
 *
 * 判据本身有**两个**来源（WorkBuddy 网关的 11128 硬要求 + space-bunny 的 11148），
 * 依据写在 `stream()` 里那段注释。此处只说这条文本自身的两条约束：
 *
 * - 刻意取**中性且极短**：它只为满足上游对首条角色的要求，不该影响模型行为；
 * - **必须不含任何腾讯风控指纹字面量** —— 否则这条兜底自己就会把会话送进 11128，
 *   与 `openai-gateway/tencent-fingerprint.ts` 那层改写互相抵消。
 *
 * ⚠️ 与 `account-probe.ts` 的 `PROBE_SYSTEM` **同值但语义独立**（那里是探测用的
 * system，这里是首条兜底）。两处各写各的，改一处不要顺手改另一处。
 */
const LEADING_SYSTEM_PLACEHOLDER = 'You are a helpful assistant.'

function serializeMessages(
  messages: readonly { role: string; content: unknown }[],
  imageUrls: ReadonlyMap<string, string> | undefined,
  provider: string,
): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  // 工具结果内嵌图片（read_image 等）不能并入 `role:'tool'` 消息：OpenAI 兼容
  // 协议要求每条 tool 消息紧跟其 assistant tool_call，中间插入任何消息都会 400。
  // 但**也不能单独成一条 user 消息**（Issue IKLIFH，见 flushToolImages 的实测表）
  // ⇒ 挂起，等下一条 user 消息把它「搭车」带走。
  let pendingToolImages: Array<Record<string, unknown>> = []
  // 含工具结果而被延后的那条 user 消息的内容（排在 `role:'tool'` 之后发出）。
  let pendingOwnParts: Array<Record<string, unknown>> | undefined
  /**
   * 发出挂起的工具结果图片 + 延后正文；`own` 是**同一轮要发的那条 user 消息**。
   *
   * ⚠️⚠️ **图片必须与提问同在一条 user 消息里**
   * （Issue IKLIFH，真实报障「codebuddy hy4 不支持识别图片」）。
   *
   * 实测（2026-10-14，直连 `copilot.tencent.com`，hy4-preview，同一张
   * 1024x768 双色图，问「左右分别什么颜色」）：
   *
   * | wire 形态                                     | 上游行为           |
   * |-----------------------------------------------|--------------------|
   * | 图与提问**同一条** user                        | ✅ 「左白右蓝」    |
   * | 图与提问**同一条**，且前面已存在 tool 消息     | ✅ 「左白右蓝」    |
   * | 图单独一条 user（有提示句），问在下一条       | ❌ 「图像已被过滤」|
   * | 图单独一条 user（**无**提示句），问在下一条   | ❌ 「不支持图片识别」|
   * | 图并入 `role:'tool'` 消息本身                 | ❌ 「不支持读取图片」|
   *
   * ⇒ 触发条件是**图片与提问不在同一条 user 消息**；与提示句无关，也与 hy4 无关
   * （同一张图换 `deepseek-v4-flash` 同样答「已被过滤」，而它远端同样是
   * `supportsImages: true`）。
   *
   * ⚠️ 症状极具误导性：wire 上**确实有图**（抓包可见 `image_url` data URL）、
   * 上游也**不报错**（HTTP 200 + 正常流），只是模型**看不见**并自称
   * 「当前模型不支持图片输入」⇒ 用户会误判成模型能力问题、反复换模型。
   *
   * ⚠️ `own === undefined`（assistant / system / 历史末尾三处）时**只在有挂图
   * 或有延后正文时才发**：无内容却凭空造一条消息，纯文本会话会因此被上游 400
   * （反向验证实测）。
   */
  const flushToolImages = (own?: Array<Record<string, unknown>>): void => {
    const ownParts = own ?? []
    const hasImages = pendingToolImages.length > 0
    if (!hasImages && ownParts.length === 0) return
    // 图与提问**同条**。顺序取「图在前、own 的文本在后」——两种顺序实测都能被
    // 看到，前者与 harness 原生序列化（`requestImageHandleText` + image）一致。
    const ownImages = ownParts.filter((part) => part.type !== 'text')
    const ownText = ownParts.filter((part) => part.type === 'text')
    wire.push({ role: 'user', content: [...pendingToolImages, ...ownImages, ...ownText] })
    pendingToolImages = []
  }

  // ── 孤儿工具调用清理（会话续命的关键）──
  // OpenAI 兼容协议要求：带 `tool_calls` 的 assistant 消息，其**每一个**
  // tool_call id 都必须紧跟一条对应的 `role:'tool'` 结果消息；反之，
  // `role:'tool'` 消息也必须有对应的前置 tool_call。缺任一侧，后端都会以
  // 400 拒绝整个请求。
  //
  // 工具执行失败时（参数非法、超时、工具不存在……）harness 会把 assistant
  // 的 tool_calls 持久化进会话历史，却写不回结果消息。这条坏历史随后被
  // **每次请求原样重放**，于是后端对之后每一条用户消息都返回 400——表现为
  // "任务突然中断，此后发送任何内容都没有回复"，整个会话彻底报废。
  //
  // 适配器是最后一道防线：发出请求前把无法配对的 tool_calls 与 tool 结果
  // 一并剔除，让会话自愈。宁可丢失一轮工具上下文，也好过整条会话死亡。
  // ⚠️ 先归一化 DSH 0.1.7 的消息形状（见 `message-shape.ts`）：0.1.7 把工具结果
  // 改为一等 `role:'tool'` 消息，不再有 `tool-result` 块。若不归一化，下面所有
  // 按 `type === 'tool-result'` 的判据恒不命中 → 结果 id 集合为空 →
  // `resolveToolPairing` 把**全部 tool_calls 剔除**，模型看不到自己调用过什么，
  // 表现为「无工具调用即判对话结束」或「陷入循环思考」。
  const normalized = normalizeHarnessMessages(messages)
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized)

  for (const message of normalized) {
    if (message.role === 'assistant') {
      // 存量自愈：清洗历史里已持久化的行首 `course` / `课` 泄漏
      // （见 `stripCourseLeakFromHistoryContent`）。只清 assistant ——
      // 判据只对模型自己的输出成立，清洗用户输入等于篡改用户的话。
      const content = stripCourseLeakFromHistoryContent(
        message.role,
        Array.isArray(message.content) ? message.content : [],
      )
      const toolCallBlocks = content
        .filter((block): block is { type: string; id: unknown; name: unknown; arguments: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
        .filter(block => keepCallIds.has(String(block.id)))
      const toolCalls = toolCallBlocks.map((block) => ({
        id: String(block.id),
        type: 'function' as const,
        function: { name: String(block.name), arguments: normalizeToolArguments(String(block.arguments)) },
      }))
      const reasoning = content
        .filter((block): block is { type: string; text: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'reasoning')
        .map((block) => String(block.text))
        .join('')
      // ⚠️ assistant **正文**要过腾讯系风控指纹改写（实测该位置 400/11128，
      // 依据见 `openai-gateway/tencent-fingerprint.ts` 的表）。这是**存量自愈**：
      // 坏的那句一旦进了历史就每轮原样重放，整个会话从此报废（换任何腾讯系模型
      // 都一样）——2026-10-12 用户报 `step-5-preview` / `space-bunny` 同错即此。
      // 与之相对，`reasoning_content` 与 `tool_calls.arguments` 实测**不拦**，
      // 故下面两条**刻意不**改写（改了既换不来放行，又破坏回读证据）。
      const text = rewriteTencentContentFingerprints(contentToText(content), provider)
      // 挂起的工具结果图片必须在 assistant 之前发出（对齐官方适配器）：
      // 否则它们会漂到这条 assistant 之后，与产生它的 tool_call 脱节。
      // ⚠️ 延后正文一并带上（它已无处可去），否则会被下一条 user 消息吞掉。
      flushToolImages(pendingOwnParts)
      pendingOwnParts = undefined
      wire.push({
        role: 'assistant',
        // 正文为空且有工具调用时 content 必须为 null（对齐 openai_chat.rs）。
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        reasoning_content: reasoning,
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      flushToolImages(pendingOwnParts)
      pendingOwnParts = undefined
      // system 是这条风控的**已知**位置（IKJNA1），与网关路径同一判据、同一份表。
      wire.push({ role: 'system', content: rewriteTencentContentFingerprints(contentToText(message.content), provider) })
      continue
    }
    // user 角色：工具结果搭载在 harness 用户消息中；展开为独立的 role:'tool' 消息。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block): block is { type: string; toolCallId: unknown; content: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result')
    const text = contentToText(message.content)
    // 工具结果之外的常规内容（含顶层图片）。
    const regular = content.filter((block) =>
      !(typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result'))
    // 含图片时 content 升级为 OpenAI 多模态 parts（CodeBuddy 唯一接受的图片
    // 形态；{type:'image'} 会以 `unsupported content type ... image` 400）。
    //
    // 注意：这里**不能**把「空 Map」也降级为 undefined。`imageUrls` 为 undefined
    // 只发生在整个请求都没有图片时；若图片存在但全部读取失败，map 是**空的**
    // 而非 undefined。降级成 undefined 会让 `[image unavailable]` 占位符也被跳过，
    // 图片静默消失；只有部分失败时（map 非空）才会出现占位符 —— 同一故障两种
    // 表现。保留空 Map 可让 `userContentParts` 统一产出占位符。
    const regularImageUrls = imageUrls
    const parts = regularImageUrls === undefined
      ? undefined
      : userContentParts(regular, regularImageUrls)
    // ⚠️⚠️ **两条互斥分支**（Issue IKLIFH 的落点）：
    //
    // | 本条形态                | 处置                                                  |
    // |------------------------|-------------------------------------------------------|
    // | 无工具结果              | **立刻**发出，并把挂起的工具结果图片**搭车**并入本条   |
    // | 含工具结果（deferred）  | 本条内容也留到**下一条** user 消息，与挂图合并发出     |
    //
    // ⚠️ 「搭车」是本 issue 的正题：图若单独成一条 user 消息，上游就让模型
    // 「看不见」（实测 hy4-preview 与 deepseek-v4-flash 均答「图像已被过滤」，
    // 而两者远端都是 `supportsImages: true`）。明细见 flushToolImages 的表。
    //
    // ⚠️⚠️ **延后判据必须看「有没有挂图」，不能只看「本条有没有工具结果」**
    // （2026-10-14 修复）。原实现 `const deferred = toolResults.length > 0`
    // 在「tool 结果 → 一条无工具结果的 user（『好的』）→ 真正的提问」这一
    // 真实序列上判错：那中间条把 `pendingToolImages` 与 `pendingOwnParts`
    // **一起 flush 掉并单独发出**，真正的提问随后成了**纯字符串** user 消息
    // ⇒ 图与问重新分处两条，**恰好复现 IKLIFH 本次要消灭的形态**。
    //
    // 触发前提：工具结果后跟**多于一条** user 消息。实测 wire（hy4-preview）：
    //   修复前 [3]=user `image_url+text(好的)`、[4]=user `"这页写了什么？"`
    //   修复后 [3]=user `image_url+text(好的)+text(这页写了什么？)`（同一条）
    //
    // ⚠️ 含工具结果时**整条延后**这条不变：OpenAI 兼容协议要求 tool 消息**紧跟**
    // 其 assistant `tool_calls`，中间插任何 user 消息都会 400（trae 上游对应
    // `code=4027`，回归见 `trae-adapter.spec.ts`）。与 trae 的 `deferred` 同型。
    //
    // ⚠️ 「有挂图」还必须覆盖「历史上一条延后的正文」：那种情况下
    // `pendingOwnParts` 非空而 `pendingToolImages` 已空，若只看后者就会把
    // 正文提前发出、同样与后续提问分处两条。
    const deferred = toolResults.length > 0
      || pendingToolImages.length > 0
      || pendingOwnParts !== undefined
    // ⚠️ 本条同时是上一条延后内容的「搭车机会」：`pendingOwnParts` 里的正文
    // 必须与本条内容、挂起图片**一起**发出一条，否则那份正文与提问分处两条。
    //
    // ⚠️⚠️ **无挂图时必须保持「字符串」形态**（旧行为逐字节不变）：纯文本若被
    // 包装成 `[{type:'text',…}]` 发出去，上游会以 `model_param_invalid` 400
    // 拒收整个请求（实测）。故这里只在**确实有挂图**或本条本身有图时才用
    // parts，纯文本一律传 `undefined` 走字符串分支。
    //
    // ⚠️ 三个条件缺一不可（2026-10-14）：前两个覆盖「图还在排队」，
    // **第三个覆盖「图已随上一条发出、但还有正文没走」** —— 那种情况下
    // `pendingOwnParts` 非空而 `pendingToolImages` 已空，只看前两个会让本条
    // 正文被提前单独发出、同样与提问分处两条。
    const combined: Array<Record<string, unknown>> | undefined =
      pendingToolImages.length > 0 || parts !== undefined || pendingOwnParts !== undefined
      ? [
        ...(pendingOwnParts ?? []),
        ...(parts ?? (text.length > 0 ? [{ type: 'text', text }] : [])),
      ]
      : undefined
    pendingOwnParts = undefined
    if (deferred) {
      // ⚠️ `combined` 已含本条内容，直接沿用即可；仅当它是 undefined 而本条有
      // 正文时（无图、无上一条延后内容）才需要把本条正文兜进来。
      pendingOwnParts = combined ?? (text.length > 0 ? [{ type: 'text', text }] : undefined)
    } else if (combined !== undefined || toolResults.length === 0) {
      // ⚠️ 核心修复：挂起图片与本条内容**同一条**发出，而非让图片单独成一条。
      flushToolImages(combined)
      // 纯文本（无挂图无图）：与旧行为一致，发**字符串** content。
      if (combined === undefined) wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      // 丢弃孤儿工具结果：没有对应 assistant tool_call 其结果同样会让后端 400。
      if (!keepResultIds.has(String(result.toolCallId))) continue
      // 工具结果内嵌的图片（read_image 等）单独收集：文本继续走 `role:'tool'`，
      // 图片挂起到其后的 user 消息 —— 与原实现相比，这里补上了递归分支，
      // 否则图片会被 contentToText 静默丢弃（只留元数据文本）。
      let resultText = '(no output)'
      if (regularImageUrls !== undefined && Array.isArray(result.content)) {
        const resultParts = userContentParts(result.content, regularImageUrls)
        if (resultParts !== undefined) {
          pendingToolImages.push(...resultParts.filter((part) => part.type !== 'text'))
          const joined = resultParts
            .filter((part) => part.type === 'text')
            .map((part) => String(part.text))
            .join('')
          // ⚠️⚠️ **有图无文时绝不能落到 `(no output)`**（Issue IKLSB8，与
          // `openai-compat.ts` 同一处同义修复）。`resultParts !== undefined`
          // 的含义是「该工具结果里有内容」，只是内容**不是文本**；原先只在
          // `joined` 非空时改写 `resultText`，纯图片型工具结果于是保留初值
          // `(no output)` ⇒ 模型答「Read 没有返回内容」，用户误判成模型没有
          // 视觉能力。判据用 `resultParts !== undefined`（**有内容**）而不是
          // 「有图」：`[image unavailable]` 占位符也走这条腿，它同样不是没有输出。
          resultText = joined.length > 0 ? joined : TOOL_RESULT_IMAGE_TEXT
        } else {
          resultText = contentToText(result.content) || '(no output)'
        }
      } else {
        resultText = contentToText(result.content) || '(no output)'
      }
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: resultText,
      })
    }
    // ⚠️⚠️ **这里刻意不 flush**（Issue IKLIFH 的关键时序）：
    // 本条 user 消息的内容与刚入队的工具结果图片，**都留到下一条 user 消息**
    // 一起发出 —— 只有那样图片才与提问同在一条消息里。
    //
    // 若在本条末尾就 flush，图片此刻刚由上面的 `pendingToolImages.push` 入队，
    // 会**单独成一条** user 消息紧随 tool 之后，而提问在再下一条 ⇒ 复现 IKLIFH
    // （实测：hy4-preview 与 deepseek-v4-flash 均答「图像已被过滤」，而两者
    // 远端都是 `supportsImages: true`）。明细见 flushToolImages 的表。
    //
    // `pendingOwnParts` 与 `pendingToolImages` 都留在队列里，由下一条 user
    // 消息的 `flushToolImages(own)` 合并发出；历史末尾则由下面的兜底处理。
  }
  // 历史末尾的残留（工具结果之后没有再跟任何 user 消息）：图片与延后正文**必须
  // 同一条**发出，否则上游看不见（Issue IKLIFH）。
  flushToolImages(pendingOwnParts)
  pendingOwnParts = undefined
  return wire
}

/** 安全读取 Error.message。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/**
 * 把未知值收敛成记录；非对象（含 `null`）返回 `undefined`。
 *
 * ⚠️ 与「返回 `{}`」不同：原生搜索的逐项过滤需要区分「不是对象」（丢弃）
 * 与「是空对象」。搬自 `web-native.ts`（2026-10-14 架构改造）。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * 腾讯侧**安全策略拦截**（业务码 11140）判定。
 *
 * ⚠️ 这类拒绝**也回 HTTP 403**，报文实测（2026-09-27，workbuddy /
 * deepseek-v4.1-flash）：
 * ```json
 * {"code":11140,"msg":"request illegal","requestId":"…",
 *  "displayMsg":{"en":"The content did not pass the safety review. …",
 *                "zh":"内容未通过安全审核，请调整后重试。"}}
 * ```
 * 同一报文在 CodeArts 侧还会以 HTTP 200 + SSE 内嵌错误帧的形式出现。
 *
 * ## ⚠️ 服务端称它「内容」问题，实测却是**账号级**的（2026-09-27 修正）
 *
 * 逐账号对照实测：**同一份请求体**（`system` + 两个字）发往池里 7 个账号，
 * 结果 2 个 200、4 个 403/11140、1 个 429 —— 拦截**按账号生效**，与内容无关。
 * 用户侧现象吻合：连「你好」都被拦，且换新会话照样被拦（排除上下文累积）。
 *
 * 因此**不能**把它当成「内容问题，与账号无关」而拒绝换号（早期实现的错误结论）：
 * 那样池里有可用账号也永远用不上，且提示用户「请调整内容」——指错方向。
 * 正确处理与 401/403 认证失败一致：**换号**，全部试完才报错。
 *
 * 判据用三个独立信号（任一命中即可）：业务码、`msg` 措辞、`displayMsg` 文案。
 * 只看状态码无法区分 —— 403 同时覆盖「真认证失败 / 额度 / 权限 / 安全策略」。
 *
 * ⚠️⚠️ **第二腿 `/request illegal/` 与 11128 渠道校验是同一句 msg**（2026-10-17 实测）
 *
 * `msg:"request illegal"` 并不是 11140 独占的措辞：`11128` 的「渠道校验」子原因
 * **实测也用这一句**（同端点、同一天、两个账号上稳定复现，且那一句在本机从未
 * 以 `conversation id missing` 的形态出现）。两者的处置**完全不同**：
 *
 * | | 11140（本档） | 11128 渠道校验 |
 * |---|---|---|
 * | 换个请求形态能否绕过 | ❌ 不能 | ✅ **能**（带上三枚 Conv 头即 200） |
 * | 换号是否有效 | ✅ | ✅ |
 * | 写 30 分钟冷却 | ✅ | ❌ **不可**（会把可用账号凭空封禁） |
 *
 * ⇒ 本档**必须先排除**渠道校验形态，否则：一份「带三头就能用」的报文会被判成
 * 账号级拦截 → 换号 + 写 30 分钟冷却 + 出口文案建议用户**停用该账号** ——
 * 而用户停用后少了账号，整条渠道更不可用。这是 IKM7SG 复验实测到的生产缺陷。
 *
 * ⚠️⚠️ **排除必须施加到「全部」可能命中渠道校验报文的腿，不止中间那条**（P0，
 * 2026-10-17 对抗审计证伪）。第一版只给 `/request illegal/i` 那条加了排除，
 * 于是下面这条仍然认领渠道校验报文：
 * ```json
 * {"code":11128,"msg":"request illegal","requestId":"…",
 *  "displayMsg":{"en":"The content did not pass the safety review. Please retry."}}
 * ```
 * ⚠️ **这不是假想形态**：`displayMsg.en` 那句`The content did not pass the
 * safety review.` 正是**本文件上方**记录的 11140 真报文措辞（zh=「内容未通过安全审核」），
 * 而 11128 各子原因**共用/漂移 `displayMsg`** 本仓已有先例（见
 * `tests/unit/buddy-adapter.spec.ts`「内容级风控」组里那条断言）⇒ 上游哪天把
 * 渠道校验的 `displayMsg` 改成这句，缺陷原样复现。
 * 实测（审计沙盒 + 本仓自查复现）：该报文三条腿里**命中的是第三条** ⇒ 落 11140 档
 * ⇒ 写 30 分钟冷却 ⇒ 出口文案「全部账号均被服务端安全策略拦截…请停用被拦账号」。
 * ⇒ **两条腿都必须排除**（下方实现用一次早退覆盖全部）。真实 11140 报文**仍被
 * 全部三条腿命中**，未被削弱（审计实测 + 本仓回归用例各锁一遍）。
 *
 * ## ⚠️⚠️⚠️ 那个 P0 只修了一半：早退排除**只覆盖腿③**（2026-10-18 审计实测，本轮修）
 *
 * 排除用的判据是 `isChannelVerificationIllegalBody`，它只认 `code==11128` 且
 * `msg` 含 `request illegal`。而渠道校验档**带 `msg` 措辞**的形态有**两种**：
 * 腿① 认的 **`conversation id missing`**（**IKM7SG 原文措辞**，报障者两次独立
 * 取证都拿到过它），**完全没被排除**。
 *
 * 触发形态（真实可达 —— 仓库自己就是证据）：
 * ```json
 * {"code":11128,"msg":"conversation id missing",
 *  "displayMsg":{"zh":"内容未通过安全审核，请调整后重试。"}}
 * ```
 * `displayMsg.zh` 那句正是**本文件上方记录的 11140 真报文**（L623-625），
 * 而「11128 各子原因共用/漂移 `displayMsg`」本仓**已有先例**（腿③ 的注释就把它
 * 列为可达形态）⇒ 不是假想报文。
 *
 * | | 修复前 | 现版 |
 * |---|---|---|
 * | 归属 | 落 11140 档 | 落渠道校验档 |
 * | 处置 | 换号 + **写 30 分钟账号冷却** | 换号、**不写冷却** |
 * | 出口文案 | 「…请停用或更换被拦账号」 | 「未通过渠道校验…重发无效」 |
 *
 * 症状与本档注释明确写「**不可**」写账号级冷却的那件事逐字相同：可用账号被凭空
 * 封 30 分钟、UI 显示「限额重置」、并建议用户停用它 —— 而该账号带上三头立刻 200。
 *
 * ⚠️ **为什么第一版的守卫抓不到**：那批夹具的 `msg` 全是 `request illegal`
 * （腿③）⇒ 早退排除生效 ⇒ 腿①形态**完全不在观测范围内**。必须另造腿①夹具
 * （见 `tests/unit/buddy-adapter.spec.ts` 的「P0 复发」组）。
 *
 * ⚠️⚠️ 修法**必须**保持「code 精确等于 11128」这道闸门，**不得**简写成
 * `CHANNEL_VERIFICATION_MSG_FIELD.test(body)` —— 那条腿**不带 code 判据**
 * （它要覆盖的正是「报文里带 `conversation id missing` 的一切形态」），
 * 若单独拿它排除，`{"code":11140,"msg":"conversation id missing"}` 会被
 * 放行 ⇒ 真 11140 反被剥掉冷却 ⇒ 每轮重撞同一坏账号（本组有反向守卫锁这一格）。
 *
 * ## ⚠️⚠️ 覆盖范围**不是**「全部三条腿」（2026-10-18 对抗审计纠正我的一处注释撒谎）
 *
 * 精确表述是：**覆盖渠道校验档全部「带 `msg`/`message` 措辞」的形态**
 * —— 即腿①（结构化值位）与腿③（`request illegal`）。
 *
 * ⚠️ **腿②（`CHANNEL_VERIFICATION_BARE`，HTML / 纯文本裸子串兜底）结构上
 * **不可**被本排除覆盖**：它锚的是「压根不是结构化报文」，**没有 `code` 键**
 * ⇒ `ILLEGAL_CODE` 恒 false。而排除**必须**锚 `code`（见上：否则真 11140 被剥冷却）
 * ⇒ 二者不可兼得。
 * ⇒ 后果（**预先存在**，非本轮引入）：`<html>… conversation id missing …
 * 内容未通过安全审核 …</html>` + HTTP 400 仍落 11140 档、写 30 分钟冷却。
 * ⚠️ 该形态无实测可达性（真实错误体是 JSON 对象），故**如实登记、不修** ——
 * 修它只能把排除改成「不锚 code」，而那会引入上面那条更严重的假阴性。
 * ⚠️ 原注释写「全部三条腿」是**字面错误**（下一个审计会拿它当契约），本轮已更正。
 */
function isContentRejection(body: string): boolean {
  if (body.length === 0) return false
  // ⚠️ 先把渠道校验形态摘出来，下面三条腿共用它 —— 「排除一次、三条腿都干净」
  // 比在每条腿里各写一遍判据更难漂移（少写一处就是本节记的那个 P0）。
  //
  // ⚠️⚠️ 排除必须覆盖渠道校验档**所有「带 msg 措辞」的形态**（2026-10-18 审计实测）：
  // 只调 `isChannelVerificationIllegalBody` 会漏掉**腿①** 的
  // `conversation id missing` 形态（**IKM7SG 原文措辞**）⇒ 那份报文只要
  // `displayMsg` 漂成 11140 的安全审核措辞（本仓记录的 11140 真报文原句，
  // 且「11128 各子原因共用/漂移 displayMsg」已有先例），就落进 11140 档 ⇒
  // 换号 + **写 30 分钟账号冷却** ⇒ 可用账号被凭空封禁。
  // ⚠️ 腿②（裸子串兜底）**刻意不覆盖**，理由见本函数文档注释的「覆盖范围」一节。
  if (isChannelVerificationBody(body)) return false
  // ⚠️⚠️ 内容级 `Illegal API invocation…`（IKLYCT）**同样必须早退**，理由与证据见
  // {@link CONTENT_BLOCKED_MSG} 的注释：`11128` 各子原因共用/漂移 `displayMsg`，
  // 上游一漂成安全审核措辞，腿③ 就会把「换句即通」的内容级拦截误判成账号级 ⇒
  // 烧完整池 + 锁 30 分钟。
  // ⚠️⚠️ **与上面那条排除是两个独立子原因、共用同一个 `code`**：渠道校验
  // （`request illegal` / `conversation id missing`）**按账号**生效、该换号；
  // 内容级（`Illegal API invocation…`）**换句即通**，换号与冷却**全是误伤**
  // ⇒ **两条排除各管一个，少一条即复发**（本轮两条都在）。
  if (isContentBlockedIllegalBody(body)) return false
  return /"code"\s*:\s*11140/.test(body)
    || /request illegal/i.test(body)
    || /安全审核|safety review/i.test(body)
}

/**
 * ★★ 「渠道校验」拒绝：`11128`，**按账号生效**（2026-10-16 实测，2026-10-17 复验）。
 *
 * ## ⚠️⚠️ `msg` 有**两种**实测形态，判据必须**都**认（2026-10-17 真机复验）
 *
 * | 形态 | 出处 |
 * |---|---|
 * | `conversation id missing` | IKM7SG 记录；本机**从未复现**（5 账号 × 数十次零命中） |
 * | **`request illegal`** | **本机实测稳定拿到**（两个不同账号、跨多次、逐字稳定） |
 *
 * ⚠️ **只认前者会让真实报文整条链路走错档** —— 实测后果：
 * `isChannelVerificationRejection` 恒不命中 ⇒ 落进 `isContentRejection` 的
 * `/request illegal/i` 腿（11140 档）⇒ 换号 + **写 30 分钟冷却** + 出口建议
 * 用户「停用该账号」—— 而该账号**带上三头立刻 200**，正是本档明确写「不可写冷却」
 * 的那一档。
 *
 * ⚠️⚠️ 而 `request illegal` **与 11140 共用**（11140 实测就是这句）⇒ 本档与
 * `isContentRejection` **必须同时**按 `code` 精确值收窄，只改一侧都无效。
 * 详见 `isChannelVerificationIllegalBody` 与本文件末尾的变异验证记录。
 *
 * ## 为什么必须与 `isContentRejection` 分开
 *
 * 两者**共用同一个业务码 `11128`**（前者）或相邻码（11140），但成因与处置都不同：
 *
 * | | `isContentRejection`（11140 系） | 本档（11128 渠道校验） |
 * |---|---|---|
 * | 成因 | 账号级安全策略拦截 | 网关对**特定账号**的渠道校验 |
 * | 换个请求形态能否绕过 | ❌ 不能 | ✅ **能**（带上三枚 Conv 头即 200） |
 * | 换号 | ✅（唯一出路） | ✅（唯一出路） |
 * | 写 30 分钟冷却 | ✅ 否则每轮重撞 | ❌ **不可**（见下） |
 *
 * ⚠️ 判据**看的是这句 `msg` 的文本 + `code` 精确值**，绝不能只看 `code === 11128`
 * —— 同码至少四族子原因（渠道级 / 消息形状级 / 内容指纹级 / 本档），`msg` 各不相同，
 * 处置也不同。放宽成按 code 会把 `Illegal API invocation from an unapproved channel`
 * （由腾讯指纹改写链路处理、与账号轮换无关）也拖进换号，属误伤。
 * ⚠️ 但「看 msg」不等于「要求完整 JSON 片段」：见下方判据体内的书写变体表。
 *
 * ## ⚠️ 为什么不写账号冷却（与 11140 的关键差异）—— 依据已被 IKM7SG **复核**
 *
 * IKM7SG 实测（在「要求三头」那个账号上）：**带三头 → 200；紧接无头 → 400；
 * 再带 → 200** ⇒ 判据是**逐请求**的（**非账号封禁、非状态粘性**）。
 * ⇒ 该账号**并非坏账号**，只是要求「三枚 Conv 头同时存在且非空」，而本实现
 * **本来就发**这三枚 ⇒ 请求形态凑齐即立刻可用。若照抄 11140 的
 * `markPolicyBlockedAccount`，会把一个**可用**的账号封 30 分钟，且 UI 会把它
 * 显示成「限额重置」——完全误导。故本档**只换号、不记冷却**。
 *
 * ⚠️ 该决定**不依赖**任何未结清的事实（`200→400→200` 来回可切是 IKM7SG 直接实测的），
 * 且**账号级冷却的语义与「逐请求判定」直接冲突** —— 只要拒绝是逐请求的，就不该写。
 *
 * ⚠️ 原先那句「据 PR 作者的记录（**未独立复核**）」**已更正**：该记录现已被
 * **独立复核**（复核者用本仓库自己的 e2e、只换 `WB_REF` 即复现分叉，见 IKM7SG）。
 *
 * ## ⚠️ 逐请求判定这条依据的**边界**（2026-10-17 对抗审计补登记）
 *
 * `200→400→200` 来回可切足以排除「**账号封禁**」，但**排除不了**
 * 「**同一账号 + 同一个 Conv 头值重复使用**时被拒」这类**状态粘性** ——
 * 实测每轮的 `200→400→200` 里，三枚头都是**新值**，从未复用过同一个值。
 * ⇒ 本档「不写冷却」的结论**依赖**「每次 `send()` 都 `crypto.randomUUID()` 生成
 * 新的三头」（见 `send()` 里那三行）。⚠️ **若有人改成会话级复用同一个 Conv 头值**，
 * 该结论的前提就没了，而症状（每轮 400、换号也无益）**与账号封禁同形** ⇒
 * 届时应重新评估本档，并补一组「同值连发 N 次」的 e2e 断言。
 * 本轮**不**补该e2e：它是「上游行为」的未知面，且现状（逐请求换新值）恒不触发。
 *
 * ## ⚠️ 单账号 + **不注册 accountPool** + HTTP 400 时，本档**不生效**（既有旧洞）
 *
 * `stream()` 的 400 早退分支在**无账号池**时直接抛 `INVALID_REQUEST`
 * （原始 detail 透传），既不换号也不给本档文案。实测（审计沙盒）：
 * `INVALID_REQUEST` +「请求被拦截，请重新发送 request illegal」。
 * ⚠️ **这不是本次修复引入的** —— master 的 `conversation id missing` 同形态**同样**
 * 如此（那是上游在无池时唯一的文案）；有池时（本插件的正常形态）走换号循环，
 * 本档生效。故**如实登记、不在本 PR 修**：修它要改的是 400 早退分支的整体口径，
 * 超出本 PR 范围，且「无池」是插件正常用法之外的形态。
 *
 * ⚠️ **2026-10-18 独立审计补一层**：那条路径走的是 `errorDetail(body)` 而**不是**
 * `channelVerificationUpstreamId(body)` ⇒ **`redactUpstreamActionHints` 的整套脱敏
 * 在这里完全不生效** ⇒ 上游那句已被本档认定「诱导用户做无效动作」的
 * 「请重新发送」会**原样**进用户可见文案。两种措辞均实测复现。
 * 净效果 = 「用户被告知重发 + 重发确实无效 + 没有出路（无池可换）」。
 * ⚠️ `INVALID_REQUEST` 不在客户端 `failureMessage` 的吞文案名单里 ⇒ message
 * **不被吞**，用户确实看得到这句（与 IKLBSH 红线不同，属更轻的一档）。
 * 仍**不修**：无池形态之外，且「有池时脱敏正常生效」已覆盖正常用法。
 *
 * ## ⚠️⚠️ 实测依据（**已按 IKM7SG 结清**：差的是**账号**，不是「互相否证」）
 *
 * 本档曾登记一处「证据等级冲突」：本档的逐账号对照 vs 同一提交内约 90 次复测的
 * 「零次复现」。**IKM7SG 已把该冲突结清** —— 两者**都对**，差的是**账号**这个
 * 控制变量：那批复测用的账号**不要求**三头（故 `conversation id missing` 零复现），
 * 而 `66E05E7C` **要求**（故本档能稳定复现）。
 *
 * ⚠️ 原先写的「**至少有一份是错的**」「没有第三方独立复核」**均已作废** ——
 * 复核已完成，且用的是**本仓库自己的 e2e**（`pnpm test:e2e:buddy-conv`）。
 * 完整对照表与字段级穷举见本文件 `send()` 的 `X-Conversation-*` 注释。
 *
 * ⚠️ **仍未定论的部分**（别写成结论）：为什么**只有那个账号**要求三头、
 * 生效范围会如何演进 —— IKM7SG 明确未定论（仅登记一条 n=1 的线索）。
 *
 * ## 本档的实测依据（同账号 / 同网络 / 同模型）
 * - `66E05E7C` 不带三头：跨约 19 分钟共 10 次**全部 400**，`isRateLimited` 实测为 `false`；
 * - `D87606B1` / `D3238B4E` 同样不带三头：**全部 200** ⇒ 该拒绝**按账号**生效；
 * - 失败**只限聊天端点**（同刻 `/agenttool/v1/search` 200、`/v3/config` 200）；
 * - `66E05E7C` 带上三头：立刻 200。
 *
 * ## ⚠️ 2026-10-17 独立复验（维护者本机，5 个 workbuddy 账号）
 *
 * 判据**完整复现**（三枚同值/异值/`abc-123` 全 200、空串 400、删任一枚 400、
 * 补 `X-User-Id`/`X-Session-ID`/`X-Trace-Id`/`X-Request-Id` 全 400、
 * `200→400→200` 逐请求可切、换 system 仍 400 ⇒ 内容无关），
 * **按账号生效**复现为 **2/5**（两个受限账号、三个不受限）。
 * ⚠️ 但 `msg` 复现成 **`request illegal`** 而非 `conversation id missing`
 * —— 这正是上面新增腿③ 的由来，也是本档判据在 PR #104/#105 上恒不命中的原因。
 * 完整报文、claim 对照、变异验证表见 `docs/agent-notes/providers-buddy.md`。
 */
/**
 * 腿①：`msg` / `message` 键的**值**里含该句（容忍分词符与 JSON 转义）。
 *
 * ⚠️ `[^"]*` 只吃到该字符串值的闭合引号为止 —— 这正是「值里」的语义边界。
 *
 * ⚠️⚠️ 分隔符用 **`+`（至少一个）而不是 `*`**：`*` 允许**零个**分隔符，于是
 * `conversationidmissing` 这类**粘连标识符**也会命中（2026-10-16 对抗性审计
 * 实测：`conversationIdMissing` 这种 camelCase 键名/标识符同样命中）。
 * 而 `conversationidmissing` 与上游那句错**不是同一件事**，误命中的代价是
 * **白烧整池往返**。⇒ 语义是「分隔符**形式**可变，但必须**存在**」。
 *
 * ⚠️⚠️ 分隔符集合用 **Unicode 类别 `\p{Cf}` + `\s` + `:_-`**，**不枚举码点**：
 * 本仓在「不可见字符」上已有一课（`docs/agent-notes/protocol-wire.md` 的网关通配
 * 判据：枚举码点必漏 —— `Cf` 有 160+ 个，且 `\u034f` CGJ 是 `Mn` 不是 `Cf`）。
 * 实测覆盖面（8 种不可见字符全部命中）：`U+200B` / `U+200C` / `U+200D` / `U+2060`
 * / `U+FEFF` / `U+00AD`（软连字符）/ `U+180E`（蒙文元音分隔符）/ 多空格。
 *
 * ⚠️ `\\[nrt]` 是**转义序列本身**（真实 HTTP 报文体里换行是 `\n` 两个字符，
 * 不是裸换行）—— 少了它，「上游把 msg 写成多行」就会漏认
 * （2026-10-16 单测实测：这条腿是唯一能覆盖「上游 JSON 报文里改写换行」的写法）。
 *
 * ⚠️ 已知**不覆盖**（如实登记为残留缺口，不是遗漏）：纯中文措辞（「会话 id 缺失」）。
 * 它需要新造一张中文同义词表，而**没有实测证据**表明上游会改说中文
 *（真实报文实测为英文 `msg` + 中文 `displayMsg`）⇒ 不凭猜测扩容。
 */
const CHANNEL_VERIFICATION_MSG_FIELD =
  /"m(?:sg|essage)"\s*:\s*"[^"]*conversation(?:[\s:_\-\p{Cf}]|\\[nrt])+id(?:[\s:_\-\p{Cf}]|\\[nrt])+missing/iu

/** 腿②：无结构化字段时的裸子串腿（HTML / 纯文本网关页）。同理要求分隔符存在。 */
const CHANNEL_VERIFICATION_BARE =
  /conversation(?:[\s:_\-\p{Cf}]|\\[nrt])+id(?:[\s:_\-\p{Cf}]|\\[nrt])+missing/iu

/**
 * ⚠️⚠️ 腿③：**上游实际用的那句 `msg` 是 `request illegal`，不是 `conversation id missing`**。
 *
 * ## 为什么必须加这条腿（2026-10-17 真机复现，Gitee issue IKM7SG 复验）
 *
 * IKM7SG 记录的真实报文是 `{"code":11128,"msg":"conversation id missing",…}`，
 * 而本机**独立复现**到的报文（两个不同账号、跨多次、逐字稳定）是：
 *
 * ```json
 * {"code":11128,"msg":"request illegal","requestId":"…",
 *  "displayMsg":{"en":"Request blocked. Please send it again","zh":"请求被拦截，请重新发送"},
 *  "displayTips":{"en":"This call failed channel verification, possibly because it was not sent from an official client. …",
 *                 "zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"}}
 * ```
 *
 * ⇒ **`conversation id missing` 这句在这台机器上从未出现过**（跨 5 账号 × 数十次
 * 请求零命中）；本档腿①/腿② 对它**恒不命中**，于是这份报文整条链路走不进本档。
 * 实测后果（生产链路，见 `docs/agent-notes/providers-buddy.md`）：
 * | 环节 | 修复前 |
 * |---|---|
 * | 归属 | 落进 `isContentRejection`（它的 `/request illegal/i` 腿命中） |
 * | 处置 | 当成 11140 账号级拦截 → 换号 + **写 30 分钟冷却** |
 * | 出口文案 | 「全部账号均被服务端安全策略拦截…请在 Jet Hub 停用或更换被拦账号」 |
 * 而该账号**带上三头立刻 200** ⇒ 正是本档注释里明确写「**不可**写冷却」的那一档。
 * 症状与 PR #105 想避免的失败形态**逐字同形**（可用账号被凭空封 30 分钟、
 * UI 显示「限额重置」、建议用户停用它），只是入口判据认错了报文。
 *
 * ## ⚠️⚠️⚠️ 为什么**不能**只按 `request illegal` 判（这是本条最易踩的坑）
 *
 * **`request illegal` 是 11140 与 11128 渠道校验「共用」的 msg** —— 本仓
 * `isContentRejection` 的注释与全部单测都把它写成 11140 的报文（实测 11140 就是
 * `{"code":11140,"msg":"request illegal"}`）。所以本条必须**同时**锚定：
 *
 * 1. `code` 键**存在**（结构化报文），且
 * 2. 其值**精确等于 11128**（不是 11140、不是别的码）。
 *
 * ⚠️ 用 `/11128/` 子串匹配**不够**：裸子串会把 `111280` 这类码一起命中，而它们的
 * 处置未知。⇒ 必须写**带右边界**的形式。
 * ⚠️ 右边界是 `(?![\d.])`、**不是** `(?![0-9])`（2026-10-17 单测实测出的自引入缺陷）：
 * JSON 允许非整数码，`JSON.stringify({code:11128.5})` 写出的是 `11128.5`，
 * 而 `.` 不在 `[0-9]` 里 ⇒ 只挡数字的写法会**放行小数**并误命中。
 * 实测：只挡数字时 `{"code":11128.5,"msg":"request illegal"}` 被判成渠道校验。
 * ⇒ `.` 必须一并挡掉。
 * ⚠️⚠️ **残留缺口（如实登记，不声称已挡）**（2026-10-17 常规审计实测）：
 * 右边界只挡数字与小数点，**挡不住字母后缀与科学计数法**：
 * | 报文 | 现状 | 说明 |
 * |---|---|---|
 * | `{"code":11128x}` | **命中** | `x` 不在 `[\d.]` 里 |
 * | `{"code":11128e3}` | **命中** | 科学计数法；`e3` 不在 `[\d.]` 里 |
 * | `{"code":11128e0}` | **命中** | 等价于 `11128` |
 * | `{"code":111280}` / `{"code":11128.5}` | ✅ 已挡 | |
 * | `{"code":1.1128e4}` | ✅ 已挡（无 `11128` 字面） | |
 * ⚠️ 收紧到 `(?![\w.])` 可挡掉这些，但会一并挡掉**合法**的 `11128` 后接引号/逗号
 * 之类边界 —— 实测 `\w` 已含数字与下划线，故 `(?![\w.])` 与 `(?![\d.])` 在真实报文
 * 上**等价**，收益仅在字母后缀那几格。⚠️ **当前不收紧**：腾讯侧 `code` 是**业务整数码**
 * （实测恒为 `11128`/`11140` 五位整数），这些形态**不会从上游出现**；而收紧会
 * 引入「`code` 后紧跟一个字母标识符」这类**假想报文**上的新差异，收益不足。
 * ⚠️ 若将来上游真的下发非整数 `code`，本条须重新评估（先看它到底想表达什么）。
 * ⚠️ 也不写 `code` 腿的「存在性」判断就够了：只判「有 code 键」会把
 * `{"code":11140,"msg":"request illegal"}` 一起吃掉 ⇒ 那正是 11140，必须放行。
 *
 * ## ⚠️ 为什么**不**用 `displayTips` 的「渠道校验 / channel verification」作判据
 *
 *  tempting 的做法是认那句提示，因为它字面就是「渠道校验」。**实测它不可用**：
 * 11128 的**各个子原因共用逐字相同的 `displayTips`**（本机同时抓到
 * `msg:"request illegal"` 与 `msg:"Illegal API invocation from an unapproved channel"`
 * 两份报文，二者的 `displayTips` **逐字节相同**），且它与本仓库测试夹具里
 * 11140 族那句「安全策略拦截 / blocked by security policy」也高度相近。
 * ⇒ 用它会把**内容级**的 `Illegal API invocation…` 也拖进换号，
 * 而那一句换号**完全无效**（由腾讯指纹改写链路处理、每个账号都会被拦在同一句上），
 * 后果是整池被白烧 —— 与隔壁 describe 锁死的「别族不换号」直接冲突。
 *
 * ⇒ 判据只锚 `code` + `msg` 两处**都在结构化字段里**，不扫任何提示文案。
 *
 * ## ⚠️⚠️ **两个条件必须彼此独立，不许用 `[^{}]*` 串起来**（P1，2026-10-17 对抗审计）
 *
 * 初版写成 `/"code"\s*:\s*11128(?![\d.])[^{}]*"m(?:sg|essage)"\s*:…/`
 * —— 两个条件之间夹了 `[^{}]*`，于是**引入了 JSON 字段顺序依赖**，实测三格漏判：
 *
 * | 报文 | 首版 | 现版 |
 * |---|---|---|
 * | `{"msg":"request illegal","code":11128}`（`msg` 在前） | ❌ | ✅ |
 * | `{"code":11128,"displayMsg":{…},"msg":"request illegal"}`（中间夹对象） | ❌ | ✅ |
 * | `{"code":"11128","msg":"request illegal"}`（`code` 是字符串） | ❌ | ✅ |
 *
 * ⚠️ 前两格**不是理论风险**：现网报文的字段顺序恰好是 `code` → `msg` → `displayMsg`
 * （`msg` 紧跟 `code`），所以当前碰不到；但**JSON 对象键序无任何保证**，网关重排字段、
 * 或在 `code` 与 `msg` 之间新增一个对象（如把 `displayMsg` 前置）就会**静默漏判** ——
 * 漏判方向是「回落 11140 档」，即**本次要修的那个缺陷原样复现**。
 *
 * ⇒ 改成 `code` 与 `msg` 两条**独立**的前瞻断言（各用一个 `[^\n]{0,N}?` 的有界窗口
 * 只做「同层级邻近」的兜底，不是串联）：键序变了也各自命中。
 * ⚠️ 窗口**必须有界**（`{0,200}`）：无界会让「报文里任意位置有 code、任意位置有
 * msg」也命中 ⇒ `{"code":11140,…前面…,"msg":"… request illegal"}` 这类跨族报文会误判。
 */
const ILLEGAL_CODE = /"code"\s*:\s*"?11128(?![\d.])/iu
const ILLEGAL_MSG =
  /"m(?:sg|essage)"\s*:\s*"[^"]{0,200}?request(?:[\s:_\-\p{Cf}]|\\[nrt])+illegal/iu
/**
 * ⚠️⚠️ **内容级** `11128`（`Illegal API invocation from an unapproved channel`）的判定，
 * 2026-10-18 为 IKLYCT 加。
 *
 * ## 为什么它必须在 `isContentRejection` 里被**排除**（这条注释就是那个缺陷的事故史）
 *
 * 腾讯系内容级风控的报文长这样（Gitee IKJNA1 / IKLS2L / **IKLYCT**，两端点一致）：
 * ```json
 * {"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 *  "displayMsg":{"en":"blocked by security policy","zh":"请求被拦截，请重新发送"}}
 * ```
 * 它是**内容级**拦截：同一账号换掉那一句就通 ⇒ **换号无效、写 30 分钟冷却纯属误伤**
 * （会把可用账号凭空封禁，出口文案还建议用户去停用账号）。
 *
 * ⚠️⚠️ **本条原先是漏的，而漏的方式恰好被本文件自己记录过、却没落到这条腿上**：
 * 上面那段「这不是假想形态」的注释已经指出——`11128` 各子原因**共用/漂移 `displayMsg`**
 * （`displayMsg.en` 漂成 `The content did not pass the safety review.` **本仓已有先例**）。
 * 于是当上游把这份 11128 的 `displayMsg` 漂成安全审核措辞时：
 * - 腿① `"code":11140` —— **不命中**（code 是 11128）；
 * - 腿② `/request illegal/i` —— **不命中**（msg 是 `Illegal API invocation…`）；
 * - 早退 `isChannelVerificationIllegalBody` —— **不命中**（它要 `request illegal`）；
 * - ⚠️⚠️ **腿③ `/安全审核|safety review/i` 扫整份报文（含 `displayMsg`/`displayTips`）⇒ 命中**
 *   ⇒ 整份报文落进「账号级拦截」档 ⇒ **烧完整池 + 每个账号锁 30 分钟**。
 *
 * 实测（从 `lib/` 编译产物抠出判据实跑，2026-10-18；输入是本仓记录的**真实**报文措辞）：
 * | 报文 | 判定 | 命中腿 |
 * |---|---|---|
 * | 真实 11128 渠道校验 | ✅ false | 早退排除 |
 * | 真实 11128 内容级（本轮实测文案） | ✅ false | 无 |
 * | ⚠️ 11128 内容级 + `displayMsg.en` 漂成 safety review | ❌ **true（错）** | **腿③** |
 * | ⚠️ 11128 内容级 + `displayMsg.zh` 含「安全审核」 | ❌ **true（错）** | **腿③** |
 * | ⚠️ 11128 内容级 + `displayTips` 含 safety review | ❌ **true（错）** | **腿③** |
 * | 真实 11140 | ✅ true | 腿①②③（**未被削弱**） |
 *
 * ## 写法上刻意与 `isChannelVerificationIllegalBody` **同型**（三处都不可省）
 *
 * 1. **只认结构化 `code` + `msg` 两个键**，**绝不扫** `displayMsg` / `displayTips` /
 *    正文 —— 腿③ 之所以出错，正是因为它扫了报文里**所有**地方。
 * 2. `code` 用**精确值** `11128`（负向前瞻挡 `111280` / `11128.5`），不是子串。
 * 3. 与渠道校验那档一样**各自排除**（早退各写一条），因为它们是**两个**不同的
 *    子原因、同一个 `code`；少一条就回到「同码不同族被混为一谈」那个老问题上。
 *
 * ⚠️ **判窄不是为了放行真拦截**：`code:11140` 与内容级 11128 的处置**本来就不同**
 * （前者是账号级、该冷却；后者换句即通、绝不能冷却）。排掉它之后，
 * 腿③ 只对**真正的 11140 / 安全审核**报文生效 —— 这正是腿③ 的本意。
 */
const CONTENT_BLOCKED_CODE = /"code"\s*:\s*"?11128(?![\d.])/iu
const CONTENT_BLOCKED_MSG =
  /"m(?:sg|essage)"\s*:\s*"[^"]{0,200}?illegal\s+api\s+invocation/iu

/** 内容级 `11128` 的判定（见 {@link CONTENT_BLOCKED_MSG} 的事故史）。 */
function isContentBlockedIllegalBody(body: string): boolean {
  return CONTENT_BLOCKED_CODE.test(body) && CONTENT_BLOCKED_MSG.test(body)
}

/**
 * 渠道校验（11128）+ `request illegal` 形态的判定。
 *
 * ⚠️ 刻意**不是**单条正则：两个条件**独立**匹配（见上方「不许用 `[^{}]*` 串起来」）。
 * ⚠️⚠️ 同码不同族时**必须**靠它排除 —— ⚠️ **但注意它已不是 `isContentRejection`
 * 的排除判据**（2026-10-18 审计实测）：那里已改用覆盖面更全的
 * {@link isChannelVerificationBody}（本函数只认腿③，漏掉腿① 的
 * `conversation id missing` 形态 —— 那才是 P0 复发的原因）。
 * ⇒ 本函数现在**只服务** `isChannelVerificationRejection` 自己的腿③。
 * ⚠️ **刻意不写死行号**：注释里的行号必然随文件漂移（2026-10-18 审计实测已漂一次）。
 */
function isChannelVerificationIllegalBody(body: string): boolean {
  return ILLEGAL_CODE.test(body) && ILLEGAL_MSG.test(body)
}

/**
 * ★ `code` 精确等于 11128 **且** `msg`/`message` 值位写着渠道校验措辞 —— 供
 * {@link isContentRejection} 做**早退排除**用（2026-10-18 审计实测，本轮新增）。
 *
 * ## 为什么它与 `isChannelVerificationRejection` **刻意不同**
 *
 * 那三条腿里有**不锚 `code`** 的：腿② 是 HTML / 纯文本的裸子串兜底（锚的是
 * 「压根不是结构化报文」），腿① 虽然结构化但**按 `code` 收窄是刻意不做的**
 * （见该函数注释：同码至少四族子原因，按 code 会把内容级子原因也拖进换号）。
 *
 * ⚠️⚠️ **本档的排除恰好必须反过来 —— 必须锚 `code`**：排除是「别给**这一族**
 * 写冷却」，而它只对 `code==11128` 的渠道校验族成立。若拿腿① 那种
 * 「扫全文找措辞」的判据来排除，`{"code":11140,"msg":"conversation id missing"}`
 * 会被放行 ⇒ **真 11140 反被剥掉冷却** ⇒ 每轮重撞同一坏账号（本组有反向守卫）。
 *
 * ## ⚠️ 覆盖范围 = 腿① + 腿③，**腿② 结构上不可覆盖**（对抗审计纠正）
 *
 * 本函数覆盖渠道校验档**全部带 `msg`/`message` 措辞**的形态。⚠️ **腿②**
 * （HTML / 纯文本裸子串兜底）**刻意不覆盖**：它锚「压根不是结构化报文」、
 * **没有 `code` 键** ⇒ `ILLEGAL_CODE` 恒 false；而排除**必须**锚 `code`
 * （否则真 11140 被剥冷却）⇒ 二者不可兼得。
 * ⇒ `<html>… conversation id missing … 安全审核 …</html>` + 400 仍落 11140 档、
 * 写冷却（**预先存在**，无实测可达性）⇒ 如实登记、不修。
 *
 * ## ⚠️⚠️ 两个条件必须**独立**匹配，**不许**用 `[^{}]*` 串起来
 *
 * 同本文件 P1 那条教训（2026-10-17 对抗审计）：串起来会引入 **JSON 字段顺序依赖**，
 * 而真实报文**本就带** `displayMsg` 嵌套对象（夹在 `code` 与 `msg` 之间）⇒
 * 串起来的写法对**自己修的那族报文**恒漏判。⇒ 两条**独立**前瞻断言，
 * 各自只在自己的字段位置上锚定。
 *
 * ## ⚠️⚠️⚠️ 值位窗口**必须与归属判据同宽**，否则修复方向会反转（2026-10-18 对抗审计实测，本轮修）
 *
 * 初版这里写 `[^"]{0,200}?`（有界，对齐腿③ `ILLEGAL_MSG`），而归属判据**腿①**
 * 用的是 `[^"]*`（**无界**）⇒ 「属不属于渠道校验」判得比「要不要写冷却」**更宽**
 * ⇒ 二者**不再是互斥关系**。实测措辞距 `msg` 值开头 **≥205 字符**时：
 *
 * | `msg` 前缀长度 | 排除 | 归属 | |
 * |---|---|---|---|
 * | 0 / 180 / 195 / 199 | ✅ | ✅ | 两档互斥 |
 * | **205 / 260 / 500** | ❌ | ✅ | 🔴 落 **11140 档 ⇒ 写 30 分钟冷却** |
 *
 * ⚠️ **方向恰好与本函数存在的目的相反**：修复 A 是为消灭「可用账号被凭空封
 * 30 分钟」，而这个不对称制造了**一条新的**同类触发面（端到端实测 403 与流内
 * 200 两条通道都写冷却）。
 *
 * ⇒ **改为 `[^"]*` 与腿① 对齐**。⚠️ 「有界 vs 无界」此处**不是**取舍而是
 * **一致性约束**：排除必须**至少**覆盖归属判据认得的一切，否则两档会同时认领。
 * ⚠️ 反向也不成立：把腿① 收窄成有界会让「长 `msg` 里写着渠道校验措辞」的报文
 * **两条腿都不认领** ⇒ 直接抛裸错误，比写冷却更差（丢掉了「换号 + 不写冷却」
 * 这条唯一出路）。⇒ **只能向排除侧放宽**。
 * ⚠️ 腿③（`ILLEGAL_MSG`）仍是有界 `{0,200}` —— 它**与排除同宽**，故 ③ 不存在
 * 这个不对称；⚠️ 但这意味着「超长 `msg` 里的 `request illegal`」仍是
 * **归属认不出、排除也认不出** ⇒ 落 11140 档（既有行为，本轮不扩大其范围）。
 *
 * ## ⚠️ 残留缺口（如实登记，**不是**本轮引入）：转义引号会截断值位窗口
 *
 * `[^"]` 遇到 JSON 里的**转义引号 `\"`** 会在那里停下，于是措辞若位于转义引号
 * **之后**就漏认：
 * ```json
 * {"code":11128,"msg":"say \"hi\" then request illegal"}
 * ```
 * 实测三条腿（腿① / 腿③ / 本条）在这一格上**全部返回 false** ⇒ 这是**既有**
 * 的同型缺口，不是本轮引入。
 * ⚠️ **本轮刻意不修**：修它要写 JSON 感知的字符串扫描（`"(?:\\.|[^"\\])*"`），
 * 而三条腿**同时**改是另一次结构性改动；且**实测报文的 `msg` 恒为短句**
 * （`request illegal` / `conversation id missing`，均不含引号）⇒ 该形态
 * 无实测可达性。⚠️ 若将来抓到含引号的 `msg`，三条腿必须**一并**改，
 * 改一处会留下「腿① 认、腿③ 不认」的漂移。
 *
 * ## ⚠️ 残留缺口（**预先存在**，本轮把它**扩大了一个触发面**）：`ILLEGAL_CODE` 扫全文
 *
 * `ILLEGAL_CODE` 是**全文正则、不锚顶层** ⇒ 报文里**任何位置**出现 `"code":11128`
 * 都算命中。于是外层真 11140、内嵌一个 11128 子报文时会被排除：
 * ```json
 * {"code":11140,"msg":"boom","inner":{"code":11128,"msg":"request illegal"}}
 * ```
 * ⇒ 排除触发 ⇒ 真 11140 **不写冷却** ⇒ 每轮重撞同一坏账号。
 *
 * ⚠️ **精确的归属（实测，别记错）**：
 * - 该缺口在**腿③ 形态上上一版就有**（旧实现对上面那条报文同样排除）⇒ 非本轮引入；
 * - ⚠️ 本轮**新增腿①** 让**同一个缺口多了一个触发面**（内层是
 *   `conversation id missing` 时旧实现不排除、现版排除）—— 这才是本轮的净增量。
 *
 * ⚠️ **本轮刻意不修**，理由三条：
 * 1. 锚「顶层」的两条常规写法都**不可行**：改成 `^\s*\{\s*"code"` 会打红
 *    「`msg` 排在 `code` 之前必须仍被认领」那条 P1 守卫（JSON 键序无保证）；
 * 2. 正解是 `JSON.parse` 取顶层 `code`（实测 8/8 形态正确），但它把
 *    **格式错误报文从 fail-open 改成 fail-closed**（BOM / 尾随逗号会解析失败
 *    ⇒ 不再认领），属**方向性变更**，必须单独评估、不能夹带进本轮；
 * 3. 无实测可达性（真实错误体是**单层** JSON 对象，无内嵌子报文）。
 *
 * ⚠️ 若将来要修，**必须**连带处理：`JSON.parse` 失败时是回退到现状正则、还是
 * fail-closed —— 这是**产品取舍**，不是实现细节。
 *
 * ## ⚠️ 覆盖范围核查：全部调用点**共用这一个早退**（2026-10-18 审计实测）
 *
 * 本文件有多处 `isContentRejection(...)` 调用（401/403 入口、换号途中、
 * 401/403 出口、400 入口、400 换号途中、400 出口、单凭据出口、限流换号、
 * `consumeSse` 流内），**全部经由本函数的同一个早退**，无第二份判据、无漏网入口
 * ⇒ 本次修一处即覆盖全部通道。⚠️ 将来若有人**新增**调用点或**复制**一份判据，
 * 必须重跑本节的核对（这正是 trae 那次「两处各写一套」的成因）。
 * ⚠️ **刻意不写死调用点个数与行号** —— 两者都会随文件漂移（本条曾因写死行号
 * 被审计打回，见 2026-10-18 记录）。
 */
const CHANNEL_VERIFICATION_PHRASE = /"m(?:sg|essage)"\s*:\s*"[^"]*?(?:conversation(?:[\s:_\-\p{Cf}]|\\[nrt])+id(?:[\s:_\-\p{Cf}]|\\[nrt])+missing|request(?:[\s:_\-\p{Cf}]|\\[nrt])+illegal)/iu
function isChannelVerificationBody(body: string): boolean {
  return ILLEGAL_CODE.test(body) && CHANNEL_VERIFICATION_PHRASE.test(body)
}

function isChannelVerificationRejection(body: string, status?: number): boolean {
  if (body.length === 0) return false
  // ⚠️⚠️ 判据有**三条腿，且顺序不可颠倒**（腿①② 是 2026-10-16 两轮整改的结果，
  // 腿③ 是 2026-10-17 为 `request illegal` 形态加的）。
  //
  // ## 腿①（结构化，优先）：必须落在 `msg` / `message` 的**值**里
  //
  // 初版是 `/"msg"\s*:\s*"conversation id missing"/i` —— 只认**完整 JSON 片段**，
  // 上游改一个字符就**静默漏认**，退回「只试一个账号就抛」：
  // | 变体 | 初版 | 现版 |
  // |---|---|---|
  // | 键名 `message`（而非 `msg`） | ❌ | ✅ |
  // | 值尾部带句点 `…missing.` | ❌ | ✅ |
  // | 值前缀空格 `" conversation…"` | ❌ | ✅ |
  // | 内部多空格 / 制表 / 换行（含 JSON 转义 `\n`） | ❌ | ✅ |
  // | `conversation-id missing` / `conversation id: missing` | ❌ | ✅ |
  //
  // 这不是「放宽成按 code」——`code` 腿**仍然刻意不写**（见上：同码至少四族
  // 子原因，按 code 会把 `Illegal API invocation from an unapproved channel`
  // 也拖进换号）。放宽的只是**同一句 msg 的书写变体**：命中仍要求报文里出现
  // `conversation id missing` 这串字面文本，且**必须出现在 `msg`/`message` 的值里**。
  //
  // ## 腿②（非结构化兜底）：只有**整份报文没有结构化字段**时才退化到裸子串
  //
  // ⚠️⚠️ 这一步是**必须**的（2026-10-16 自查实测到一处**我引入的假阳性**）：
  // 第一版整改把判据直接换成「整份报文裸子串」，于是**别的** 11128 子原因只要在
  // `displayTips` 里**引用**了这句话（例如英文提示 `If you see "conversation id
  // missing", please resend…`），就会被判成「按账号生效」⇒ 本该只发一次变成
  // **白烧整池往返**，还会**误导用户去停用一个好账号**；报文 echo 了请求体
  //（用户消息里正好写了这句话）同型。⇒ 对**有结构化字段**的报文，只认该字段，
  // **绝不**再扫 `displayTips` / `displayMsg` / 正文。
  //
  // ⚠️⚠️ **「结构化」的判据是「JSON 对象 + 有 `code` 键」，不只是「有 `msg`/`message` 键」**
  //（2026-10-16 第三轮自查实测三处**已实测可达**的误命中；前两轮的用例都带
  // `msg` 键，故从未打到这条腿）：
  // | 报文体 | 仅有 msg 键守卫 | 加结构化守卫后 |
  // |---|---|---|
  // | `{"code":11128,"tips":"conversation id missing"}` | ❌ 误命中（烧整池） | ✅ |
  // | `{"code":11128,"error":"conversation id missing"}`（`error` 是**字符串**） | ❌ | ✅ |
  // | `{"code":400,"request":{…"conversation id missing"…}}`（**echo 请求体**） | ❌ | ✅ |
  // 三者的共同点：报文**是结构化 JSON 对象**（有 `code`），却因为「没有 `msg` 键」
  // 而被当成 HTML 兜底 ⇒ 这正是 `displayTips` 假阳性的**另一入口**。
  // 而 HTML / 纯文本网关页**没有** `code` 键可锚，此时若不做裸子串兜底就会整族
  // 漏认 ⇒ 保留它。三条腿合起来的语义是：
  // 「`msg`/`message` 的值里写着它」**或**「是结构化对象却不在该字段里 ⇒ 否」
  // **或**「压根不是结构化报文、而正文里写着它」。
  //
  // ⚠️ 判据里 `^\s*\{` 这一半**不可省**（实测教训）：只看 `"code"` 键的写法会把
  // **JSON 数组**形态（`[{"code":11128,"conversation id missing":"…"}]`）也判成
  // 结构化 ⇒ 漏认。真实网关错误体是**对象**，数组形态只出现在测试夹具里。
  //
  // ## ⚠️⚠️ 腿② 必须带**状态码闸门**（2026-10-16 第三轮审计 P1，本轮修）
  //
  // 前三轮只治了「报文体长什么样」，**没治「哪个状态码才可能出这个错」**。
  // 实测后果（已实测可达）：**网关 5xx 故障页**只要日志文字里恰好含该句
  // （例：`<html>502 Bad Gateway<br>upstream log: conversation id missing header</html>`
  // —— 注意它**没有** `msg`/`code` 键，故走腿②），就会：
  // | 观测 | 修复前 | 修复后 |
  // |---|---|---|
  // | 请求序列 | **烧满整池** `["AT1","AT2",…]` | `["AT1"]` |
  // | 错误码 | `PERMISSION_DENIED`「未通过渠道校验」 | `SERVER`（5xx 既有分类） |
  // | 用户被指引 | **「在 Jet Hub 停用或调整该账号的顺序」** | — |
  // 即：**让用户为一次网关抖动去停用一批好账号**，且 `PERMISSION_DENIED` 不在
  // harness 可重试集合里 ⇒ 一次瞬时故障被报成确定性结论。
  //
  // ⇒ 腿② 只在 `11128` **实际被观测到**的码域（`400` / `403`）启用。
  // 5xx / 429 / 其他一律交给既有分类（`SERVER` / `RATE_LIMIT` / …）—— 那些码
  // 本来就该由既有的状态码语义处理，不该被一句文本劫持。
  // ⚠️ 腿① **不受**此闸门约束：它要求 `msg`/`message` 的值位精确命中，是**强证据**
  //（上游确实用它报这个错），出现在任何状态码上都应认。
  if (CHANNEL_VERIFICATION_MSG_FIELD.test(body)) return true
  if (isChannelVerificationIllegalBody(body)) return true
  if (status !== undefined && status !== 400 && status !== 403) return false
  if (/"m(?:sg|essage)"\s*:/.test(body)) return false
  if (/^\s*\{/.test(body) && /"code"\s*:/.test(body)) return false
  return CHANNEL_VERIFICATION_BARE.test(body)
}

/**
 * 安全策略拦截的**账号冷却时长**（30 分钟）。
 *
 * ## 为什么必须自己定一个时长
 *
 * 服务端**不给解除时间**：11140 的报文里只有 `code` / `msg` / `displayMsg`，
 * 没有任何 reset 字段。因此不能走 `parseRateLimitError` —— 它解析不到时间时
 * 兜底成 1 小时（与限流的真实语义挂钩），把它当作「11140 的时长」属于偷换概念。
 * 这里独立命名一个常量，把「策略拦截的冷却」与「限流的等待」在语义上分开。
 *
 * ## 为什么取 30 分钟
 *
 * - 太短（如 1 分钟）挡不住一个 agent 轮次里的连续重发 —— 那正是用户报障的
 *   「每次都拿最先选中的坏账号去撞」；
 * - 太长则把「其实已恢复」的账号白白锁死（服务端策略可能随时间/额度状态解除）；
 * - 30 分钟也限制了误伤窗口：标记**只随时间到期失效**（`getAvailableAccount`
 *   的判据是 `Date.now() >= resetAt`，见 `src/account-pool.ts`），
 *   所以时长直接等于「这个账号在该模型上被藏起来多久」。
 *   ⚠️ 别指望 `sweepExpiredRateLimits` 来清 —— 它在生产代码里**没有任何调用方**
 *   （只有 `account-pool.spec.ts` 用），到期完全靠上面那个时间比较。
 *
 * ⚠️ 与 cline / lobsterai / trae 的 `*_RATE_LIMIT_FALLBACK_MS`（均 1 小时）**不同源**：
 * 那三个是「解析不到限流重置时间」的兜底，本常量是「服务端压根不给时间」的策略拦截冷却。
 * 别把它们合并成一个常量 —— 语义不同，将来调其中一个不该动另一个。
 *
 * ⚠️ UI 副作用（已知取舍）：复用的是 `modelRateLimits`，账号卡片因此显示
 * 「限额重置 · <模型> · 30 分钟后」（客户端渲染该行的判据见
 * `plugin-src/client/jet-hub.js` 的 `dim-jh-rateLimitsLabel`），
 * 而不是「安全策略拦截」—— 该结构只有一个 `模型→时刻` 映射，不带原因字段。
 * 换来的是现成的三条解禁路径都能用它：时间到期、Jet Hub「重置」按钮
 * （`clearModelRateLimits`）、「重测」（`account-probe.ts` 真发一条最小消息，
 * 通过才清标记）。
 */
const BUDDY_POLICY_BLOCK_COOLDOWN_MS = 30 * 60_000

/**
 * 安全策略拦截的错误。
 *
 * ## 错误码：`PERMISSION_DENIED`，**绝不能**取 `AUTH`
 *
 * 早期实现先取 `INVALID_REQUEST`（把账号级拦截说成「你的请求有问题」，指错方向），
 * !15 改成了 `AUTH` —— 而 `AUTH` 同样是错的，且错得更彻底：**它会吞掉整条 message**。
 *
 * DSH 聊天 UI 的判据（实测于安装包 `dsh-client-ui-chat/lib/client.js:1229-1234`）：
 * ```js
 * if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
 * return code === "AUTH" ? t("message.failure.auth") : message;
 * ```
 * 即 `AUTH` 会把 message 整个替换成固定文案「API 密钥无效」（`displayFailure()`
 * 那里甚至强制 `message: ""`），**本函数精心写的中文说明一个字都到不了用户眼前**。
 * 这与 !16 描述里抱怨的「UI 把用户引向检查密钥，而 7 个 token 实测全部有效」
 * 是同一个来源 —— 而除 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` 外的码**原样透传 message**，
 * 所以换码之后 !15 的文案才第一次真正生效。
 *
 * ⚠️ 也不能取 `QUOTA` / `ACCOUNT_QUOTA`：除文案错位（「额度已用尽」）外，
 * UI 还会为这两个码额外弹全局额度 Toast。
 *
 * 取 `PERMISSION_DENIED` 与本仓库既有惯例一致 —— `cline-adapter.ts` 的地域限制
 * 分支就用的这个码，并配有专门用例断言「错误码不是 AUTH」（`cline-adapter.spec.ts`）。
 * 它同时**不在** harness 的 `DEFAULT_RETRYABLE_CODES`
 * （`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）里：
 * 「这个账号被策略拦了」是确定性结论，交给 harness 白退避 5 次毫无意义 ——
 * 出路是换号（由本适配器的换号循环负责），不是重试同一个账号。
 */
function contentRejectionError(
  productId: string,
  status: number,
  body: string,
  rotated: boolean,
): LlmError {
  /**
   * 两条通道的如实描述不同：HTTP 路径试完了全部候选，流内路径只撞到当前账号
   * （那里不重发，避免「已吐了一半再重放」的重复计费与重复执行工具风险）。
   *
   * ⚠️⚠️ `rotated: false` 这一格**必须按 `status` 再分一次**（2026-10-17 审计实测）。
   *
   * 该参数原本**只为流内路径设计**，`false` 的唯一含义是「流内错误帧下发」。
   * 后来 HTTP 单凭据路径（无账号池 ⇒ 没有换号发生过）也复用了 `false`，于是
   * 那一条 **HTTP 响应体**被文案说成「流内错误帧下发」—— 实测产物：
   * 「当前账号被服务端安全策略拦截（HTTP 400，**流内错误帧下发**）」。
   *
   * ⚠️ 判据用 `status === 200` 而不是「是否 HTTP 形态」：本仓既有约定就是
   * **流内错误帧的 HTTP 状态恒为 200**（下游 `consumeSse` 的流内出口也传 200，
   * 见 `contentRejectionError(this.product.id, 200, payload, false)`），
   * 而任何真正的 HTTP 错误响应都带 4xx/5xx ⇒ 该判据可判定、无重叠。
   */
  const scope = rotated
    ? `全部账号均被服务端安全策略拦截（HTTP ${status}，已逐个换号重试）`
    : status === 200
      ? `当前账号被服务端安全策略拦截（HTTP ${status}，流内错误帧下发）`
      : `当前账号被服务端安全策略拦截（HTTP ${status}，没有其他账号可换）`
  return new LlmError(
    `${productId}: ${scope}。该拦截按账号生效（同一请求在其他账号可正常返回），`
    + `请在 Jet Hub 停用或更换被拦账号：${errorDetail(body)}`,
    'PERMISSION_DENIED',
    { status },
  )
}

/**
 * 从渠道校验报文里提取**可诊断、但不含行动指引**的上游标识。
 *
 * ## ⚠️ 为什么刻意**不用** `errorDetail`
 *
 * `errorDetail` 的第一优先级是 `displayMsg.zh`，而本档上游那句正是
 * 「请求被拦截，**请重新发送**」。本函数存在的全部理由就是**不诱导用户重发**，
 * 而 `errorDetail` 会把它从后门拼回来 —— 同一句错误文案里前半说「重发无效」、
 * 后半说「请重新发送」，自相矛盾（2026-10-16 审计实测到该产物）。
 *
 * 这里只取 `code` / `msg` 两个**结构化字段**：它们足以让用户拿着报文/日志定位，
 * 且不含任何行动指引。`error` 包装形态（上游代理）也认。
 *
 * ## ⚠️ 非 JSON 报文的边界（**已收敛**，见下）
 *
 * `displayMsg` 只存在于 JSON 报文里 ⇒ 「不透传那句误导文案」这条保证在**有 JSON
 * 结构时 100% 成立**。非 JSON（HTML / 纯文本网关页）**没有**结构化字段可锚，
 * 原先退回 `body.slice(0, 200)` 原样引用 ⇒ 审计实测 5 种形态（仅 `message` 键 /
 * `error` 是字符串 / JSON 数组 / HTML / 纯文本）都把「请重新发送」拼回了 message。
 *
 * ⚠️ 这与「保留报文以便定位」**并不冲突**：那段被保留的价值是**报错标识**
 *（code / 该 msg 的措辞），而不是**上游那句行动指引**。⇒ 现在对兜底腿也做一次
 * {@link redactUpstreamActionHints}：保留诊断信息，抹掉会诱导用户做无效动作的措辞。
 */
function channelVerificationUpstreamId(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const inner = typeof data.error === 'object' && data.error !== null
      ? data.error as Record<string, unknown>
      : undefined
    const asText = (value: unknown): string | undefined =>
      typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
    const code = asText(data.code) ?? asText(inner?.code)
    // ⚠️ 必须与**判据**认的键名一致（判据用 `m(?:sg|essage)`）——否则会出现
    // 「判据认了 `message`、出口却提不出该字段」⇒ 可诊断性静默降级
    //（2026-10-16 审计实测：报出来只剩 `code 11128`，那句唯一的定位文本丢了）。
    const msg = asText(data.msg) ?? asText(data.message)
      ?? asText(inner?.msg) ?? asText(inner?.message)
    // ⚠️⚠️ `requestId` **必须**带出来（2026-10-16 第三轮审计实测，本轮修）：
    // 本文件与 `docs/agent-notes/providers-buddy.md` 共**四处**告诉用户
    // 「先取 `requestId` 去取证」「它是唯一定位手段」，而此前实现**一个字都没取**
    // ⇒ 那句纪律对用户**不可执行**（用户唯一能看到的文案里永远没有它）。
    const requestId = asText(data.requestId) ?? asText(inner?.requestId)
    const parts = [
      code === undefined ? undefined : `code ${code}`,
      msg === undefined ? undefined : `msg ${msg}`,
      requestId === undefined ? undefined : `requestId ${requestId}`,
    ].filter((value): value is string => value !== undefined)
    // ⚠️ `msg` 的**值**本身也可能带那句行动指引（真实形态实测为
    // `conversation id missing` 这么短，但不能假设上游不会加尾巴）⇒ 同样过一遍
    // 脱敏；`code` / `msg` 这些**标识**不受影响（脱敏只动行动指引措辞）。
    if (parts.length > 0) return redactUpstreamActionHints(parts.join(' / '))
  } catch {
    // 非 JSON（HTML / 纯文本）错误体：落到下面的截断原文。
  }
  // ⚠️ 标注「非 JSON 报文」+ 抹掉行动指引：让用户知道这是**网关原样输出**、
  // 且不会被上游那句「请重新发送」带走（见上面「非 JSON 报文的边界」）。
  return `（非 JSON 报文）${redactUpstreamActionHints(body).slice(0, 200)}`
}

/**
 * 抹掉上游报文里**会诱导用户做无效动作**的措辞（本档语境下已实测重发无效）。
 *
 * ⚠️ 只抹**行动指引**，绝不动报错标识（`code` / `msg` / `requestId`）——
 * 后者是本档「报文是唯一定位手段」那条纪律的载体。
 *
 * ## ⚠️⚠️ 判据必须锚到**真实上游原句**，不能只锚作者在注释里的**转述**
 *（2026-10-16 第三轮审计实测，本轮修）
 *
 * 前一轮只写了「请重新发送」＋英文 `send again`，而**真实报文的两句都漏网**：
 * | 来源 | 真实原句 | 前一轮 | 现版 |
 * |---|---|---|---|
 * | `displayMsg.zh` | `请求被拦截，请重新发送` | ✅ | ✅ |
 * | `displayTips.zh` | `…请用官方版本重新发送。` | ❌（`请` 后紧跟 `用`） | ✅ |
 * | `displayTips.en` | `…Please resend from the official client.` | ❌（**无 `again`**） | ✅ |
 *
 * ⇒ 中文腿放宽到「`请` + 至多 12 字 + 重发类动词」，英文腿放宽到
 * 「`send`/`resend` + 至多 20 字 + `again` **或** `from the official client`」。
 * ⚠️ 收紧方向同样要守：`请稍后重试`（**不含**「重新/再次/重发」）**不得**被抹 ——
 * 它是有效指引（服务端可能真的会恢复），有专门用例锁住。
 */
function redactUpstreamActionHints(text: string): string {
  const REDACTED = '（已抹去上游的行动指引）'
  return text
    // 中文：`请` + 短间隔 + **重发**类动词。
    // ⚠️ 动词表**只收「重发」语义**（重新发送 / 重新传 / 重发 / 重新傳送），
    // **刻意排除「重试」** —— `请稍后重试` 是**有效**指引（服务端可能真的会恢复），
    // 抹掉它等于把有用的建议也吞了。实测教训：初版把「重试」并进来 ⇒
    // 「请稍后重试」被误抹。
    .replace(/请[^。；\n]{0,12}?(?:重新发送|重新傳送|重新传|重发)/g, REDACTED)
    // 英文：`send`/`resend` + 短间隔 + 「again」**或**「from the official client」。
    .replace(/\b(?:please\s+)?(?:re)?send\b[^.\n]{0,20}?(?:\bagain\b|from the official client)/gi, REDACTED)
}

/**
 * 「渠道校验」拒绝的错误出口（见 `isChannelVerificationRejection`）。
 *
 * ## 为什么文案必须自己写，不能透传上游 `displayMsg`
 *
 * 上游那句是「**请求被拦截，请重新发送**」，而实测**重发必然继续失败**
 * （同一账号不带三头跨 19 分钟共 10 次全 400），且上游自己的 `actions` 里
 * **根本没有 `RETRY`**。原样透传等于**诱导用户做无效动作** —— 用户会不断重发，
 * 而这正是原始报障里的行为。
 * ⚠️ 该目标**必须落在实现上**：上游标识走 {@link channelVerificationUpstreamId}
 *（只取 code/msg），**不得**改回 `errorDetail` —— 后者会把 `displayMsg` 拼回来。
 *
 * ## 文案要素（都对应一条实测）
 * - **指向账号**（实测按账号生效：一个号 0/3、另两个号 3/3）；
 * - **说明重发无效**（跨 19 分钟 10 次全败）；
 * - **给出真正可行的出路**：换号（Jet Hub 里停用该账号 / 调序）或切 provider。
 *
 * ⚠️ 文案里**不得**出现 Markdown 强调符：错误 message 是**纯文本**渲染，
 * `**重发无效**` 会原样显示成四个星号。
 *
 * ## `rotated`：两条通道的如实描述（与 `contentRejectionError` 同参数语义）
 * - HTTP 路径（`rotated: true`）：确实试完了全部候选；
 * - 流内路径（`rotated: false`，`consumeSse` 的 200 + 内嵌错误帧）：只撞到**当前**
 *   账号，且那里**刻意不重发**（重发需要「尚未产出内容」的判据 + 外层循环，
 *   属结构性改造）。⇒ 不能说「已逐个换号重试」。
 *
 * ⚠️ 错误码取 `PERMISSION_DENIED`，与 `contentRejectionError` 同口径：
 * - 它**不在** harness 的 `DEFAULT_RETRYABLE_CODES`
 *   （`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）⇒ 不让 harness
 *   白退避重试同一个坏形态的请求。
 *   ⚠️ 流内通道**尤其**依赖这一条：本档接入前，那条通道的 11128 帧会掉进
 *   `EMPTY_RESPONSE`（**在**可重试集合里）⇒ 白退避至多 5 次，每次重撞同一个
 *   被拒账号（2026-10-16 审计实测）；
 * - 它**在** `dead-model-store` 的 `IGNORED_CODES` 里 ⇒ 不会被误记成
 *   「该模型已失效」而把可用模型藏起来（本档与模型无关，实测只与账号/请求形态有关）；
 * - 也不取 `AUTH`（UI 会说「API 密钥无效」，实测 3 个 token 全部有效）/
 *   `QUOTA` / `ACCOUNT_QUOTA`（这两个码会弹全局额度 Toast 并替换文案，实际与额度无关）/
 *   `RATE_LIMIT`（会引导用户等待）。
 *   ⚠️ 易混：本文件兜底用的字面量是 **`'QUOTA_EXCEEDED'`**，而 harness 的
 *   `QUOTA_EXCEEDED_CODE` 字面值是 **`'QUOTA'`**（见 `llm-adapter.ts` 的 IKJVCW 注释）
 *   ⇒ 客户端**不会**为 `'QUOTA_EXCEEDED'` 弹 Toast、也不替换 message。
 *   故单账号池那次误落（见下）的症状是**误导文案原样透传**，不是全局 Toast。
 *   ⚠️ 单账号池形态曾误落到 `QUOTA_EXCEEDED`「所有账号均受限」—— 那正是本档
 *   要消灭的误导，根因与修法见 `sawChannelVerification` 的初始化注释。
 */
function channelVerificationError(
  productId: string,
  status: number,
  body: string,
  rotated: boolean,
): LlmError {
  const scope = rotated
    ? `全部账号均未通过渠道校验（HTTP ${status}，已逐个换号重试）`
    : `当前账号未通过渠道校验（HTTP ${status}，流内错误帧下发）`
  return new LlmError(
    `${productId}: ${scope}。`
    + `该拒绝按账号生效（同一请求在其他账号可正常返回），且重发无效 —— `
    + `请在 Jet Hub 停用或调整该账号的顺序后重试，或改用其它 provider。`
    + `上游：${channelVerificationUpstreamId(body)}`,
    'PERMISSION_DENIED',
    { status },
  )
}

/**
 * 「渠道校验」的**另一族**：`code 11128` + `Illegal API invocation from an unapproved channel`。
 *
 * ## ⚠️ 与 {@link isChannelVerificationRejection} 刻意分开
 *
 * 那一族（`conversation id missing` / `request illegal`）是**按账号**生效的渠道门控，
 * 出路是换号；而本族是**内容级**（2026-10-21 实测：4 个 buddy 账号全拦，把 system
 * 首句改写掉之后**同一个账号**立即 200）⇒ 换号只会白烧整池，并把用户引向
 * 「停用一个好账号」（IKM7SG 那条教训的反方向）。
 *
 * ⇒ 本函数**只用于出口文案**，不参与换号判据 —— `isChannelVerificationRejection`
 * 仍然刻意不认它（见那里的「按 code 会把 unapproved channel 也拖进换号」）。
 */
function isUnapprovedChannelBody(body: string): boolean {
  return /"code"\s*:\s*"?11128(?![\d.])/.test(body) && /unapproved\s+channel/i.test(body)
}

/**
 * 内容级 11128 的出口：把「请重新发送」换成**真正可行的信息**。
 *
 * 上游原句是「请求被拦截，请重新发送」，而实测重发恒败、换号也无效 ⇒ 原样透传
 * 等于诱导用户做无效动作（与本文件 {@link redactUpstreamActionHints} 同一立场）。
 * 文案要求：① 说明是内容级（换号/重发都没用）；② 指出出路（本版已改写已知指纹，
 * 仍复现就把上游标识与 system 首行贴出来）；③ 不带 Markdown 强调符（错误 message
 * 是纯文本渲染）。
 */
function unapprovedChannelError(productId: string, status: number, body: string): LlmError {
  return new LlmError(
    `${productId}: 请求内容被上游渠道拦下（HTTP ${status}，code 11128 的 `
    + `unapproved channel 一支）。这是内容级拦截：换账号无效、原样重发也无效；`
    + `出站 system 与 assistant 正文里的已知指纹（含 DSH 自己的身份首句）会自动改写，`
    + `若仍复现请把上游标识与 system 首行贴出来。上游：${channelVerificationUpstreamId(body)}`,
    'PERMISSION_DENIED',
    { status },
  )
}

/**
 * HTTP 非 2xx 的统一出口。
 *
 * 存在的唯一理由是**顺序**：`unapproved channel` 这一族必须先被认成「内容级」，
 * 否则会落到 `errorDetail` 的透传分支（那句「请重新发送」），让用户以为重发有用。
 * 其余形态逐字节保持既有行为（`errorDetail` + `httpErrorCode`）。
 */
function httpRejectionError(productId: string, status: number, body: string): LlmError {
  if (isUnapprovedChannelBody(body)) return unapprovedChannelError(productId, status, body)
  return new LlmError(`${productId}: ${errorDetail(body)}`, httpErrorCode(status, body), { status })
}

/**
 * 纯函数：由「现在」算出策略拦截冷却的到期时刻。
 *
 * 单测靠它锁死时长（不必等真实时间流逝），也与 {@link markPolicyBlockedAccount}
 * 分开，避免为了验证一个数字而去 mock 整个账号池。
 */
export function policyBlockResetAtMs(nowMs: number): number {
  return nowMs + BUDDY_POLICY_BLOCK_COOLDOWN_MS
}

/**
 * 把被安全策略拦截的账号在**该模型**上冷却一段时间。
 *
 * ## 为什么必须标记（真实缺陷，2026-09-28）
 *
 * !15 / !16 之后「有可用账号就一定能用上」已经成立，但**每轮都要重撞坏账号**：
 * 候选顺序是用户在 Jet Hub 拖拽定的（`getAvailableAccount` 不再按重置时间重排），
 * 被拦账号若排在前面，每次请求都要先把那几个坏账号各发一遍才轮到可用账号 ——
 * 白烧额度、白等往返，且每轮都一样。实测那个池是「前 4 个被 11140 拦、后 3 个可用」，
 * 于是每次请求固定多发 4 次失败。
 *
 * ## 为什么复用 `modelRateLimits`
 *
 * 它是账号池里**唯一**的「账号 × 模型暂时不可用」载体（`ProviderAccountEntry`
 * 只有 `模型id → 重置时间戳` 这一个映射，没有 reason / 级别字段），复用它的收益：
 * ① `getAvailableAccount` 的过滤天然生效（`account-pool.ts`）；
 * ② UI 已有徽章与「重测 / 重置」两条人工解禁路径（`account-probe.ts`）。
 * 代价是徽章文案显示为「限额重置」而非「安全策略拦截」—— 已知取舍，见常量注释。
 *
 * **只标该模型**，与 qoder 额度那条（`qoder-adapter.ts` 的 `switchAccountOnQuota`）
 * 同口径：实测只证明「同一模型下按账号生效」，没有跨模型证据，标全部模型会误伤
 * 本可用的组合。
 *
 * ⚠️ 标记失败**只记日志、不上抛**（与 `src/expiry-sync.ts` 的回写惯例一致）：
 * 本次请求的准确错误才是主线，写不进索引不该把它顶替成未知故障。
 */
async function markPolicyBlockedAccount(
  pool: AccountPool | undefined,
  productId: string,
  accountId: string,
  modelId: string,
): Promise<void> {
  if (pool === undefined || accountId.length === 0 || modelId.length === 0) return
  try {
    await pool.updateModelRateLimit(accountId, modelId, policyBlockResetAtMs(Date.now()))
  } catch (error) {
    console.warn(`[${productId}] 安全策略拦截的冷却标记写入失败（不影响本次请求）:`, error)
  }
}

/** 从错误体提取可读 detail 文本。 */
function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const error = typeof data.error === 'object' && data.error !== null
      ? data.error as Record<string, unknown>
      : undefined
    // ⚠️ 腾讯系（buddy / workbuddy）用 `msg` + `displayMsg.{zh,en}` 报错，而标准
    // `message` 字段**不存在**。早期实现只读 `error.*` / `data.message`，于是
    // 全部落空、退化成「返回整段 JSON 原文」——实测把 291 字符的原始报文糊在
    // 错误提示里，而服务端早已备好中文说明 `displayMsg.zh`，被白白埋掉。
    const display = typeof data.displayMsg === 'object' && data.displayMsg !== null
      ? data.displayMsg as Record<string, unknown>
      : undefined
    const localized = typeof display?.zh === 'string'
      ? display.zh
      : typeof display?.en === 'string' ? display.en : undefined
    const parts = [
      // 本地化文案最可读，排在最前。
      localized,
      typeof error?.code === 'string' ? error.code : undefined,
      typeof error?.type === 'string' ? error.type : undefined,
      typeof error?.message === 'string' ? error.message : undefined,
      // 腾讯系用 `msg` 而非 `message`。
      typeof data.msg === 'string' ? data.msg : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      // ⚠️ 上游代理的 `{"error":"…","detail":"<真实原因>"}` 形态（IKLBSH A1）。
      // 判据只留一份实现（`openai-compat.ts` 的 `detailFieldText`）；必须是最后一条腿。
      detailFieldText(data),
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体
  }
  return body
}

/**
 * 将 HTTP 状态码映射为 harness 错误码。
 *
 * 400 需要看**响应体**才能区分「上下文超限」与「普通请求错误」：前者必须归为
 * CONTEXT_WINDOW_EXCEEDED，才能触发 DSH 的 context-overflow 自动压缩恢复
 * （dsh-compaction-basic 监听 `agent/request-error`，只对
 * `failure.code === CONTEXT_WINDOW_EXCEEDED` 的失败压缩上下文并重试）；
 * 若一律标成 INVALID_REQUEST，长会话一旦越过窗口就会直接把裸错误抛给用户。
 *
 * 实测报文（国际版 WorkBuddy，deepseek-v4.1-flash）：
 * ```
 * {"code":11115,"msg":"prompt is too long: 1061554 tokens > 1048576 maximum",
 *  "extError":{"code":"context_length_exceeded","type":"invalid_request_error",...},
 *  "displayMsg":{"en":"The request exceeds the model context limit. ..."}}
 * ```
 * 注意该报文的 `msg` 是「prompt is too long」措辞、`extError.code` 是
 * `context_length_exceeded`，两者都能被 `isContextWindowExceededError` 识别。
 *
 * 与 CodeArts 适配器（llm-adapter.ts 的 httpErrorCode）同一判定口径，但
 * **传入原始 body 而非 errorDetail(body)**：`errorDetail` 在能提取到
 * `error.*` / `message` 时会返回拼接后的短文本，从而丢掉 `extError`、
 * `displayMsg` 等字段——实测「仅 msg 文本」这种输入会被
 * `isContextWindowExceededError` 漏判（其正则要求出现 context/for-the-model
 * 字样），而完整 body 因含 `extError.code = context_length_exceeded` 能稳定命中。
 * 判定看完整报文、展示用归一化文本，两者职责不同。
 */
/**
 * 腾讯网关「请求过大」的另一种措辞：`prompt is too long: 100001 tokens > 100000 maximum`。
 *
 * ⚠️ harness 的 `isContextWindowExceededError` **认不出这句话**（实测其五个分支
 * 都要求出现 `context` / `for this model` / `maximum context` 之类字样，而这句
 * 一个都没有）。报文若同时带 `extError.code = context_length_exceeded` 还能靠
 * 结构化那条命中；**只带 `code`/`msg`/`displayMsg`** 时就漏判。
 * 实测四种报文形态：带 extError ✅ 命中；仅 msg / 仅 msg+displayMsg / 拼给用户的
 * 整行 ❌ 全部漏判 —— 这正是 issue !IKITT9 里「逐字相同的错误一会儿
 * CONTEXT_WINDOW_EXCEEDED、一会儿 INVALID_REQUEST」的成因。
 *
 * ⚠️ 判据必须**同时**要求「prompt is too long」与「N tokens > M」两个特征：
 * 只认前者的宽泛措辞会把别的内容类 400 误判成溢出。
 */
const GATEWAY_PROMPT_TOO_LONG = /\bprompt\s+is\s+too\s+long\b[\s\S]{0,40}?\b\d[\d,]*\s+tokens?\s*>/i

/**
 * 漏判为什么必须修（后果是**不对称**的）：
 *
 * - `INVALID_REQUEST` **不在** harness 的 `DEFAULT_RETRYABLE_CODES`
 *   （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）→ 不重试；
 * - 更关键的是它**不触发溢出压缩**：`dsh-compaction-basic` 的 request-error
 *   listener 第一行就是 `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()`
 *   → 连「试一次压缩」的机会都没有，用户直接看到裸错误、会话从此每轮报废。
 *
 * 归成溢出的最坏结果只是一次无效的压缩尝试；归错成 INVALID_REQUEST 的代价是
 * 整个会话不可恢复。方向因此取「宁可多判一次溢出」。
 */
function httpErrorCode(status: number, body: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    // 先判上下文超限，再退回通用 INVALID_REQUEST。
    // 两条判据：harness 的通用分类器 + 本仓库补的网关措辞（见上）。
    if (isContextWindowExceededError(body) || GATEWAY_PROMPT_TOO_LONG.test(body)) {
      return CONTEXT_WINDOW_EXCEEDED_CODE
    }
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * SSE 流空闲超时。buddy（CodeBuddy）后端对 SSE 连接有空闲断连策略：模型
 * 生成超长推理或大工具调用参数时，两次 chunk 之间可能静默数十秒。原实现
 * 直接 `await reader.read()` 且没有任何超时——连接被服务端掐断后若对端
 * 既不发数据也不关连接（半开连接），read() 会**永久挂起**，generator 永不
 * 返回，harness 当前步骤既不出结果也不报错，会话永久停留在"运行中"：web
 * 端表现为进度停止、发送按钮置灰、后续"继续"指令完全无响应。
 *
 * 主动以略小于后端超时窗口的间隔检测空闲，超时则取消 reader 并抛可重试
 * 的 TIMEOUT，让 harness 重试该步骤并把控制权交还给用户。
 *
 * 分两个阶段，与 codearts 适配器保持一致：
 * - firstTokenTimeout：等待首个 chunk 的窗口（模型排队 / 长思考时较长）；
 * - chunkTimeout：收到首 chunk 后，两次 chunk 之间的最大静默（每次成功
 *   读取后重置）。
 *
 * 两者均可由环境变量覆盖（毫秒，整数），便于测试用短超时触发 TIMEOUT 路径，
 * 或线上针对特定模型调优。在每次 stream() 调用时读取，避免模块顶层常量
 * 在 import 时定型导致测试中设置环境变量不生效。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_BUDDY_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/**
 * 模型饱和（`14003`）的**内部重试**次数。
 *
 * ## 为什么饱和要自己重试，而额度限流（6004）不重试
 *
 * 两者的时间尺度完全不同：
 * - **额度限流 6004**：确定性 —— 「这个账号今天/这小时用完了」，重试**必然**再撞，
 *   只能等解禁或换账号；
 * - **模型饱和 14003**：**瞬时**过载，服务端原话就是「模型繁忙，请稍后重试」，
 *   且报文的 `actions` 里自带 `RETRY`。
 *
 * ⚠️ **重试必须留在本账号上**（不换号）：饱和是**模型级**的，池里 4 个独立账号
 * 会撞同一堵墙 —— 实测 4 个不同腾讯 uid 在 20 秒内全部被同一个 14003 拒绝。
 * 换号只会白烧掉「还有额度」的账号，正是本次要修的缺陷。
 */
const BUDDY_SATURATION_MAX_RETRIES = 2

/**
 * 饱和重试的基准间隔（毫秒），按次数**线性**递增（2s → 4s）。
 *
 * ⚠️ 刻意取短：14003 那次失败**自身**就要跑 46~111 秒才返回，
 * 退避再叠长间隔会让 UI 长时间停在「运行中」而无法区分「排队」与「卡死」。
 * 这与 Qoder 排队那条「≥10 秒封顶」的取舍同因。
 */
const BUDDY_SATURATION_BASE_DELAY_MS = 2_000

/**
 * 饱和重试的等待时长（毫秒）。
 *
 * ⚠️ 环境变量**不能**写成 `parseInt(…) || 默认值`：`0` 是合法值
 * （表示「不等」，单测靠它把用例压到毫秒级），而 `0` 是 falsy 会被 `||`
 * 静默换成 2000 —— 与 `QODER_QUEUE_MAX_DELAY_MS` 那次踩过的坑同型。
 */
function buddySaturationDelayMs(attempt: number): number {
  const raw = process.env.DSH_BUDDY_SATURATION_DELAY_MS
  const base = raw === undefined || raw === '' ? BUDDY_SATURATION_BASE_DELAY_MS : Number(raw)
  const resolved = Number.isFinite(base) && base >= 0 ? base : BUDDY_SATURATION_BASE_DELAY_MS
  return resolved * (attempt + 1)
}

/** 等待指定毫秒数（可被单测用 `DSH_BUDDY_SATURATION_DELAY_MS=0` 短路）。 */
function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 判断是否为传输级错误。 */
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
 * 把 user 消息内容块转为 OpenAI 多模态 parts；无图片时返回 undefined，
 * 让调用方保持原有的纯字符串路径（无图请求的线上格式不变，避免破坏前缀缓存）。
 *
 * `tool-result` 分支为**递归**，与 `collectImages()` 的递归深度保持一致：
 * 二者若不对称，出现在深层工具结果里的图片会被 collectImages 收进 refs、
 * 却因这里只走一层而在序列化阶段被静默丢弃（连 `[image unavailable]`
 * 占位符都没有）。实测 harness 目前只产生一层嵌套，但既然收集侧已经是
 * 任意深度，序列化侧就必须同样递归，否则是一处埋着的静默丢图。
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
      // 递归取内层 parts：内层只要出现图片，hasImage 即为真，
      // 从而让整条消息升级为多模态形态。
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

/**
 * 远端条目是否**明确表态**接受图片输入。
 *
 * 用途：`reconcileWithFallback` 的白名单式重建会丢弃「不在编译期兜底表里」
 * 的模型，而兜底表是快照、会随服务端上新而漂移。凡是远端**已经讲清楚了
 * 图片能力**的条目，丢弃它就等于让「本地可能过期的快照」压过「服务端权威
 * 数据」（issue IKJQ3M：`space-bunny` 即属此类）。
 *
 * ⚠️⚠️ **判据只能认 `supportsImages`，不能收「任一能力元数据」**（初版写宽了，
 * 由自查与回归用例抓出）：实测「11102 service info not found」的模型
 * （glm-4.6/4.7/5.0、minimax-m2.5、kimi-k2.5/k2.8-preview、hunyuan-* …）
 * **同样带 `contextWindow` 与 `maxOutputTokens`**（见 `src/product.ts` 的
 * `CODEBUDDY_FALLBACK_MODELS` 注释，正是因为它们不可调用才被排除）。
 * 按「任一能力字段」放行会把它们请回模型选择器，用户选中后才报错 ——
 * **那是比原 issue 更糟的新缺陷**。
 *
 * ⚠️ 也不能放宽成「远端返回的一律收下」：`parseModelsFromConfig` 会把内部别名
 * （`default` 等）与未开放模型一并解析出来。
 */
function hasRemoteImageCapability(model: BuddyRemoteModel): boolean {
  return model.supportsImages !== undefined
}

/** 收集 user 消息中的图片附件引用（含工具结果内嵌图片），按 attachmentId 去重。 */
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

/** buddy (腾讯 CodeBuddy 系) 模型适配器。使用 Bearer access_token 鉴权。 */
export class BuddyAdapter extends LlmAdapter {
  /** 本适配器所属的产品配置（默认 CodeBuddy）。 */
  private readonly product: BuddyProduct
  private readonly fetchImpl: typeof fetch
  /**
   * 前缀缓存会话标识（prompt_cache_key）。同一会话内所有请求复用同一 key，
   * 服务端据此把相同前缀的 KV 缓存跨请求复用；缺失时缓存命中恒为 0。
   */
  private readonly sessionId: string
  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  private remoteModels: BuddyRemoteModel[] | undefined
  /**
   * 已落缓存的目录是否**所有来源都取全**（issue IKJVTF，审计 I3）。
   *
   * ⚠️ **这是短路判据的第二半**：buddy 有两个目录端点，残缺目录也落
   * `remoteModels`，故只判「已定义」会让残缺永久固化（见 `ensureRemoteModels`）。
   */
  private remoteComplete = false
  /**
   * ⚠️ 上次**成功**读到远端目录的时刻（0 = 从未成功过 / 被 `refreshCatalog` 强制清零）。
   *
   * ⚠️ 与 `remoteModels` **并存**、不是替代：`remoteModels` 存「有哪些模型」，
   *    本字段存「何时读到的」。只有 `remoteModels` 时目录**永不刷新**（原行为）。
   *
   * ⚠️⚠️ **`refreshCatalog()` 会把它置 0** —— 那不是「作废数据」，而是
   *    **强制下一次 `ensureRemoteModels` 重新拉取**的手段（见该方法）。
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
   * 现在只剩 `toCatalogEntry`（本家私有形状 + 三级 context 查找 + 同名消歧）。
   */
  private readonly catalog: ModelCatalog
  /** 远端下发的模型元数据（id → 能力），listModels/resolveModel/stream 共用。 */
  private remoteMeta: ReadonlyMap<string, BuddyRemoteModel> = new Map()
  /** 远端下发的模型上下文窗口（/v3/config data.models[].maxInputTokens）。 */
  private remoteContextWindows: ReadonlyMap<string, number> = new Map()
  /**
   * 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。
   * 远端缺失时补位；构造时一次性建立，只读。
   */
  private readonly productFallbackIndex: ReadonlyMap<string, BuddyFallbackModel>
  /** 产品级兜底上下文窗口（构造时从 fallbackModels 提取）。 */
  private readonly productFallbackContextWindows: ReadonlyMap<string, number>

  constructor(private readonly options: BuddyAdapterOptions) {
    super()
    // 默认 CodeBuddy，保证既有行为完全不变。
    this.product = options.product ?? CODEBUDDY
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, '')
    // ⚠️ 闸门时钟可注入（**不是**测试专用开关）：`refreshCatalog` 的「距上次
    // 拉取 ≥10 秒才重试」是一条**基于时间**的契约，而闸门的 `now` 默认取墙钟。
    // 单测用 `vi.setSystemTime` 改全局时间会污染同文件其余用例（真实计时器
    // 用例被挂起，实测变成时序敏感），而注入时钟可零副作用地验证该契约。
    // ⚠️ `onLoaded` 与时钟/冷却**同处构造**：目录落地后通知客户端重读
    // （issue IKJVTF 的缺陷①），回调由接线层桥接。
    this.catalogGate = new RemoteCatalogGate({
      ...options.now === undefined ? {} : { now: options.now },
      ...options.catalogCooldownMs === undefined ? {} : { cooldownMs: options.catalogCooldownMs },
      ...options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded },
    })
    const fallback = this.product.fallbackModels ?? []
    this.productFallbackIndex = new Map(fallback.map((model) => [model.id, model]))
    this.productFallbackContextWindows = new Map(
      fallback
        .filter((model) => model.contextWindow !== undefined)
        .map((model) => [model.id, model.contextWindow as number]),
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
        // ⚠️ **本家是唯一真正使用「未知」语义的家**：`inputModalitiesFor` 用
        // `imageCapabilityKnown` 区分「远端明确 false」与「全都没查到」，
        // 后者**只报未知**（省略该字段）交给宿主判断。
        // ⇒ **故意不提供** `unknownModelInputModalities`（其余 **12 家**都提供 `['text']`）。
        // ⚠️ 家数实测为 12、且**不是**源码处数 10（`qoder-adapter.ts` 一处服务
        //    两家）—— 两个口径都写错过一次。完整名单与复核方式见
        //    `model-catalog.ts` 里该字段的表格，别在这里抄。
        // ⚠️ 若给它写 `['text']`，DSH 会按「确认是纯文本模型」把图片**静默投影成
        // 占位文本** ⇒ 图片能力被关掉（宿主契约：absent means unknown）。
      },
    )
  }

  /**
   * 复用本适配器**同一套**选号编排解析凭据（供插件内部的原生搜索使用）。
   *
   * ## 为什么需要这个转发方法
   *
   * `options` 是构造器的 `private readonly`，插件其余模块（`web-native.ts`）
   * 从外部读 `adapter.options.resolveCredential` 会**编译失败**（`strict: true`）。
   * 而原生搜索**必须**与聊天链路用同一个 `resolveCredential` 实例 ——
   * 另建一份会让「enabled 过滤 / 模型级限流 / 免费判定 / 余额分档 / 池兜底 /
   * 账本回报」这六步在两条链路上漂移（见 `credential-resolver.ts` 的模块头）。
   *
   * 故这里只开一个**窄接口**：转发到同一个函数，不放松 `options` 的封装。
   *
   * ⚠️ `modelId` **必须透传**：它同时决定模型级限流过滤与免费判定，
   * 吞掉会让搜索选到聊天链路不会选的号（例如正在限流期的号）。
   *
   * @param modelId - 本次请求的模型 id（取自当前会话路由）。
   * @returns 选中账号的凭据；无可用账号时为 `undefined`。
   */
  async resolveCredentialFor(modelId: string | undefined): Promise<BuddyCredential | undefined> {
    return await this.options.resolveCredential(modelId)
  }

  /**
   * 原生搜索：执行**一次单 query**，返回投影成官方 `sources[]` 形态的结果。
   *
   * ## 这份实现是从 `web-native.ts` 搬过来的（2026-10-14 架构改造）
   *
   * 原先 `web-native.ts` 里写死了腾讯的取数逻辑（`Bearer` + `/agenttool/v1/search`
   * + `results[]` 投影），Qoder 渠道接不进来（它的鉴权是 WASM 签名、字段名是
   * `pageItems[].link`）。现把「取数」下沉到各适配器，`web-native.ts` 只保留
   * 「官方语义」（入参校验 / 并发中止 / rank 轮转合并 / cap）。
   *
   * ## 契约（对齐 `NativeSearchAdapter.searchOnce`）
   *
   * - **自己校验凭据**：腾讯的判据是 `access_token` 为非空字符串。凭据是
   *   `JSON.parse` 出来的外部数据，形状不可信（缺字段 / 类型错都可能）——
   *   只判 `credential === undefined` 会让坏凭据抛
   *   `TypeError: Cannot read properties of undefined (reading 'length')`，
   *   模型看到的是无意义的 JS 报错，而不是「去登录」的指引。
   * - **投影在这一层做掉**：`results[].{title,url,snippet}` → `NativeSource[]`，
   *   并且**丢弃无 url 的条目**（`url` 是官方 schema 必填项，
   *   `additionalProperties: false` —— 整条调用会因一个坏条目失败）。
   * - **不做多 query 合并**：那是 `web-native.ts` 的职责。
   *
   * @param query - 单个查询串（已由调用方 trim + 去重）。
   * @param credential - `resolveCredentialFor` 的返回值（本方法自己收窄）。
   * @param signal - 取消信号（调用方传多 query 的 batch signal）。
   */
  async searchOnce(query: string, credential: unknown, signal: AbortSignal): Promise<NativeSource[]> {
    return await performBuddySearch(query, credential, signal, this.product)
  }

  /**
   * 该模型此刻是否**免费**（消耗 0 积分）。
   *
   * ## 为什么需要它
   *
   * 余额分档编排（`src/credential-resolver.ts` 的 buddy 分支 + 共享的
   * `pickBuddyAccount`）只问「锁没锁 + 有没有临期积分」，
   * 从不问「这个模型要不要钱」。于是免费模型也会被「锁定永久积分 + 无临期积分」
   * 这道门拦下，报出「没有可用账号……已锁定永久积分，而所有账号的『N 天内到期』
   * 积分都已用尽」，而它**一分积分都不需要** —— 用户看到的是
   * 「账号明明有余额却失败」的矛盾错误（真实报障）。
   *
   * 免费模型既不消耗临时积分也不消耗永久积分，故它与「锁定」要保护的
   * 目标（别把永久积分烧掉）无关，不该受该门约束。
   *
   * ## 判据（任一成立即免费，与展示层口径一致）
   *
   * 1. `creditsRate === 'x0'` —— 服务端 `credits: "0x"` / `"x0"`；
   * 2. `discountedCreditsRate === 'x0'` —— 促销价打到 0；
   * 3. 两者 === `'免费'` —— 促销 `factor: 0` 时 `parsePromotions` 直接写入的
   *    **中文串**（不是 `x0`，这条最容易漏，见 `src/buddy.ts` 的 `rate = '免费'`）。
   *
   * ⚠️ **只在确定免费时返回 true**：字段缺失、解析失败、未知模型一律 false。
   * 把付费模型误判成免费会绕开锁定，**真烧掉永久积分且不可撤回** ——
   * 因此这里取「保守方向」：宁可让免费模型多走一次余额门，
   * 也不放过任何无法确认的情形。
   *
   * ⚠️ 远端目录是懒加载的（`ensureRemoteModels()`），必须先 await：
   * 调用点虽在 `prepareCall` 之后（目录通常已就绪），但「直接进会话」等路径
   * 可能尚未拉取，漏掉这一步补丁会**静默失效**（退回被拦截的行为）。
   *
   * @param modelId - 模型 id。
   * @returns true 仅当能确认该模型消耗 0 积分。
   */
  async isFreeModel(modelId: string | undefined): Promise<boolean> {
    if (typeof modelId !== 'string' || modelId.length === 0) return false
    await this.ensureRemoteModels()
    // ⚠️ 兜底表（`BuddyFallbackModel`）**没有**倍率字段 —— 它是编译期快照，
    // 价格会变，故刻意不写死（见 `reconcileWithFallback` 的说明）。
    // 因此这里只信远端 `remoteMeta`；查不到即视为「无法确认免费」。
    const meta = this.remoteMeta.get(modelId)
    if (meta === undefined) return false
    const isZeroRate = (rate: string | undefined): boolean => rate === 'x0' || rate === '免费'
    return isZeroRate(meta.creditsRate) || isZeroRate(meta.discountedCreditsRate)
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * DSH 会强制校验 `info.id === provider` 且 `info.name` 为非空字符串；
   * 模型设置页还会用该 id 计算 `deriveKeyRef(provider)`（内部调用
   * `provider.toUpperCase()`）。因此这里对入参做防御性归一化：
   * 一旦 `provider` 不是字符串（例如上游传入了 undefined），
   * 直接回退到本适配器所属产品的 id，避免
   * `undefined.toUpperCase is not a function` 在客户端炸开。
   *
   * 展示名同样来自产品配置：CodeBuddy 为 'CodeBuddy (腾讯)'，
   * WorkBuddy 为 'WorkBuddy'。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 模型列表：优先使用 /v3/config 动态拉取的远端列表，否则回退静态默认。
   * 动态拉取失败时静默回退（与 Rust fetch_models 的 Vec::new() 语义一致）。
   */
  /**
   * 懒加载远端模型目录（仅拉取一次）。listModels 与 resolveModel 共用：
   * resolveModel 可能先于 listModels 被调用（如直接进入会话），此时同样
   * 触发一次远端拉取，保证 /v3/config 的 maxInputTokens 能生效。
   */
  /**
   * 按产品的像素预算派生一张图片的**请求版本**。
   *
   * 判据与回退都在共享的 `projectRequestImage` 里（raccoon 用的是同一份 ——
   * 两个适配器各写一遍正是本仓库反复出缺陷的形态）。返回 `undefined`
   * 表示本次发原图，四种正常情形见该函数的注释。
   *
   * ⚠️ 预算取 `product.imagePixelBudget`，未配置时用
   * `DEFAULT_IMAGE_PIXEL_BUDGET`（640,000 px ≈ 1,037 视觉 token）。
   */
  private async projectRequestImage(
    ref: unknown,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> {
    return projectRequestImage(ref, {
      readImageRequest: this.options.readImageRequest,
      pixelBudget: this.product.imagePixelBudget,
    })
  }

  private async ensureRemoteModels(): Promise<void> {
    const fetchRemote = this.options.fetchRemoteModels
    // ⚠️ `fetchRemote === undefined` 那半边**原样保留** —— 它判的是「有没有远端
    //    可拉」（无凭据/无接线），与新鲜度是两件事。
    if (fetchRemote === undefined) return
    // ⚠️⚠️ **短路判据是「已完整」+「未超 20 分钟」，不是「已定义」**
    //    （issue IKJVTF 复审，审计 I3；TTL 由 `isCatalogFresh` 给出）。
    //
    // buddy 是**双端点** provider（scoped + `/v3/config`，id 集合不同、必须取并集），
    // 残缺目录**也**要落 `remoteModels`（展示需要），但那时**不能**短路 ——
    // `RemoteCatalogGate` 的冷却在生产里只有闸门自己那一处调用点，而它排在
    // 短路**之后** ⇒ 残缺一旦落缓存，冷却永远读不到、残缺永远补不齐。
    //
    // ⚠️⚠️ **加 TTL 为什么不会破坏残缺恢复**（加 TTL 前逐行核实）：
    // TTL 那一腿是 `&&` 的**后半截**，前半截 `remoteComplete` 未变。残缺时
    // `remoteComplete === false` ⇒ 短路判据恒为假 ⇒ **残缺目录不会被判为
    // 「新鲜」，闸门冷却与补齐逻辑原样生效**。
    // ⇒ 两条路径的分工见 `refreshCatalog` 的注释。
    //
    // ⚠️ **TTL 那一腿用 `isCatalogFreshFor`**（带「用户主动失效」）：用户在 Jet Hub
    //    改开关后要**立即**重拉（规格 §6 的正确性要求，见 `invalidateCatalogCache`）。
    //    失效腿与完整性腿是 `&&` ⇒ 失效会让整条合取为假、照常进闸门拉取；
    //    拉取失败时**保留**旧 `remoteModels`（本方法全程不清它）⇒ 用户看到的仍是
    //    上次那份完整列表，不会退化成兜底**子集**（规格 §7 的核心取舍）。
    if (this.remoteComplete
      && isCatalogFreshFor(this.product.id, this.catalogAt, this.options.now?.() ?? Date.now())) {
      return
    }
    // 闸门：并发去重 + 失败/空结果冷却（详见 src/remote-catalog-gate.ts 的
    // 实测依据）。Buddy 的目录端点超时上限 60s，失败不冷却会让首屏在
    // 「每个模型重试一次」的放大下长时间空转。
    await this.catalogGate.run(async () => {
      const models = await fetchRemote()
      if (models.length === 0) return false
      // /v3/config data.models[] 是权威来源（对齐 Rust TUI buddy_context_limits
      // 注入逻辑）：远端下发的上下文窗口优先于静态 fallback 表；
      // 能力字段（supportsImages / reasoning.supportedEfforts）同理。
      const reconciled = this.reconcileWithFallback(models)
      this.remoteModels = reconciled
      // ⚠️ **只在成功赋值后**记时刻：失败/空结果不写，否则一次抖动会把上界
      //    刷新掉、下轮还要等满 20 分钟才发现上游没恢复。
      this.catalogAt = this.options.now?.() ?? Date.now()
      this.remoteMeta = new Map(reconciled.map((model) => [model.id, model]))
      this.remoteContextWindows = new Map(
        reconciled
          .filter((model) => model.contextWindow !== undefined)
          .map((model) => [model.id, model.contextWindow as number]),
      )
      // ⚠️ 完整性由接线层桥接的数据源上报（两来源各自的成败）。
      // 拿不到判定时退回「完整」（= 旧行为），避免把「判不出」当成残缺
      // 而让 provider 反复重拉。
      this.remoteComplete = this.options.catalogComplete?.() ?? true
      return { got: true, complete: this.remoteComplete }
    })
  }

  /**
   * 图片能力判定为「未知」时，把闸门冷却按**用户定的重试间隔**重新评估一次。
   *
   * ## 为什么需要它（issue IKJQ3M）
   *
   * 能力未知时贴图既不放行、也不谎报「不支持」（见 {@link inputModalitiesFor}），
   * 用户看到的是「请稍后重试」。若目录的冷却期是 `RemoteCatalogGate` 默认的
   * 30 秒，而用户 10 秒后就重试，他拿到的仍是「未知」—— 于是必须有一个
   * **明确的、较短的**重试窗口，否则这条修复只是把误报换成了更慢的误报。
   *
   * ## 规则（用户 2026-10-06 定，**不要擅自改**）
   *
   * 距上次拉取**不足 10 秒** → 不重拉（本次直接返回）。
   * 理由：目录端点超时上限 **60 秒**（`src/buddy.ts` 的 `REQUEST_TIMEOUT_MS`），
   * 无节流的「贴图就重拉」会把每个模型的每次带图请求都放大成一次远端拉取
   * —— 那正是 `RemoteCatalogGate` 当初要挡的放大，也是首屏「加载模型巨长」
   * 的成因（见该文件头的实测记录）。
   *
   * ⚠️ **只放宽冷却、不清 `remoteModels`**：目录已成功时 `ensureRemoteModels`
   * 本就直接返回，无需也不能重拉（重拉会把成功结果丢掉）。
   *
   * ⚠️⚠️ **2026-10-18：上一条已改** —— 目录 TTL（`isCatalogFresh`）上线后，
   *    本方法**不再复用「已定义就不重拉」那条判据**，而是**无视 TTL 强制重拉**。
   *    理由：这里的语义是「用户/贴图门禁主动**重测图片能力**」，与
   *    `ensureRemoteModels` 的「日常保鲜」是两条不同的路。实现是「置
   *    `catalogAt = 0` + 复用既有取数路径」，**不是**另写一份拉取逻辑。
   *    上面那条「只放宽冷却」的旧约束**仅对冷却期本身**仍然成立。
   *
   * ⚠️ 冷却期整体仍以 `cooldownMs`（30s）为准 —— 放宽的是**图片门禁这一次**
   * 的评估，不是把闸门的冷却期改短，故其他调用方仍受 30 秒保护。
   */
  async refreshCatalog(): Promise<void> {
    if (this.options.fetchRemoteModels === undefined) return
    // ⚠️⚠️ **这里必须无视 TTL**（2026-10-18）：本方法的语义是「**用户主动重测
    //    图片能力**」⇒ **强制重拉目录**，与 `ensureRemoteModels` 的「日常保鲜」
    //    是**两条不同的路**。若也给它加 TTL，用户点「重测」会因 `remoteModels`
    //    已定义而直接 return ⇒ **按钮变哑、零日志**（实测症状）。
    //
    // ⚠️ 强制重拉的实现是「**清时刻 + 复用既有取数路径**」，**不是**另写一份
    //    拉取逻辑（那会让两条路的上游行为分叉）。
    //
    // ⚠️ **判据的等价性**：原判据是 `if (this.remoteModels !== undefined) return`
    //    （有值就不重拉）。加 TTL 后「有值」的等价条件是
    //    `remoteComplete && isCatalogFresh(catalogAt, now)` —— 本方法要**无视**
    //    这两条中**任意一条**成立时的短路，故两条都不判，改清这两个字段。
    //
    // ⚠️⚠️ **当前形态下 `remoteComplete = false` 是「严格冗余」**（2026-10-18 复审核实）：
    //    `ensureRemoteModels` 的短路是
    //    `if (this.remoteComplete && isCatalogFresh(this.catalogAt, now)) return`
    //    —— `&&` 要求**两腿同时为真**才 return，而 `catalogAt = 0` 时
    //    `isCatalogFresh(0, …)` 第一行就 `return false` ⇒ **整条合取恒为假**
    //    ⇒ 完整性腿为 true 也拦不住任何东西。
    //    ⇒ 「只清 `catalogAt` 不够」或「前半腿会独立短路」这类说法**是错的**，
    //    早期版本的注释就是这么写的，现已更正。
    //
    //    **两行都保留的理由不是「当前需要」，而是给假想的未来改动兜底**：
    //    将来若有人把完整性判据从 `&&` 改成 `||`
    //    （`if (isCatalogFresh(...) || this.remoteComplete) return`），
    //    只清 `catalogAt` 时 `false || true` ⇒ 直接 return ⇒ 重测变哑。
    //    ⚠️⚠️ **实测（反向验证 2026-10-18）：当前形态下删掉任一行该用例仍全绿**
    //    —— 这是冗余的**已知代价**，不是疏漏。
    //    ⇒ **删任一行前先跑反向验证**确认那条假想改动确实会发生，
    //    并同步更新本注释（否则注释会开始描述一个不存在的必要性）。
    this.catalogAt = 0
    this.remoteComplete = false
    // ⚠️ **冷却顺序与原实现保持等价**（原代码：**判冷却 → `reset()` → 拉取**）。
    //    距上次尝试不足 `BUDDY_IMAGE_CAPABILITY_RETRY_MS` 时**照样直接 return**
    //    —— 这条 10 秒节流是用户定的规则（issue IKJQ3M），不能被「重测」绕过：
    //    目录端点超时上限 60s，无节流的「贴图就重拉」会把每次带图请求都放大成
    //    一次远端拉取，那正是 `RemoteCatalogGate` 当初要挡的放大。
    const since = this.catalogGate.sinceLastAttemptMs()
    if (since !== undefined && since < BUDDY_IMAGE_CAPABILITY_RETRY_MS) return
    // 放宽本次冷却，让 ensureRemoteModels 里的 run() 真正发起一次拉取。
    this.catalogGate.reset()
    await this.ensureRemoteModels()
  }

  /**
   * 用产品兜底表校正远端结果。
   *
   * 为什么需要校正：服务端按**认证上下文**决定返回哪些模型，插件的 CLI
   * token 拿到的集合可能是残缺甚至错的 —— 实测 WorkBuddy 国际版的 CLI token
   * 只拿到 13 个内部别名（含实际不可用的 `o4-mini`），而 IDE 用的是 20 个
   * （含全部 GPT 系列）。此时若直接采信远端，模型选择器会缺掉用户真正要用的模型。
   *
   * 有产品兜底表时以它为准：
   * - 只保留兜底表里声明的 id（远端多出来的别名/内部模型被丢弃）；
   * - 兜底表声明但远端缺失的模型补进来（用兜底表的元数据）；
   * - ⚠️ **例外：被 agent 引用的模型即使不在兜底表也保留**（见下）。
   *
   * ⚠️ **为什么需要那个例外**：两个端点下发的 id 集合**不同**，而兜底表是
   * 编译期快照、只覆盖其中一套。实测（2026-09-21）`hy4-preview-f`
   * —— 新用户限时免费变体 —— **只由 `/v3/config` 下发**，且被
   * `craft`/`ask`/`plan` 三个 agent 引用（即服务端声明「对话里可选」），
   * 但**不在兜底表**里。白名单重建会把它丢掉，于是用户看不到那个免费变体，
   * 而 IDE 里能看到（用户报障「hy4 preview 现在 ide 是免费我们还是 0.29」）。
   *
   * 判据用 `agentReferenced`（服务端自己的「可选」信号）而非猜测 id 后缀 ——
   * 后缀规则不统一（`-f` / `-x` / `-sg` / `-ioa` 含义各异），猜错会放进
   * 不可用的模型。未标记的内部别名（如 `default`）不会被误留。
   *
   * ⚠️⚠️ **第二条例外：远端明确表态接受图片（issue IKJQ3M）**。
   *
   * 只按 `agentReferenced` 判据仍然丢模型：实测 `space-bunny` 由 scoped 端点
   * 下发并带**完整元数据**（`supportsImages: true` / `maxInputTokens: 1000000`
   * / `maxOutputTokens: 128000` / `reasoning.supportedEfforts`），但**没有被任何
   * agent 引用** ⇒ 白名单式重建把它连同能力声明一起丢掉 ⇒
   * `inputModalitiesFor` 三级查找全落空 ⇒ 贴图误报 `does not accept image input`
   * （而真实网关 5/5 实测能看图）。**这不是瞬时状态**：远端目录即使拉取成功
   * 也照样误判，issue 里「重启即自愈」的结论只在恰好被 agent 引用时成立。
   *
   * ⇒ 「不在编译期快照里」与「服务端未声明可选」是**两回事**：远端既然已经
   * 明确表态了图片能力，丢弃它才是缺陷本身。两条例外的判据不同、互不覆盖。
   */
  private reconcileWithFallback(models: readonly BuddyRemoteModel[]): BuddyRemoteModel[] {
    const fallback = this.product.fallbackModels
    if (fallback === undefined || fallback.length === 0) return [...models]
    const remoteById = new Map(models.map((model) => [model.id, model]))
    const reconciled = fallback.map((entry) => {
      const remote = remoteById.get(entry.id)
      // 远端元数据优先（更权威），缺失的字段用兜底表补齐
      return {
        id: entry.id,
        name: remote?.name ?? entry.name,
        ...entry.contextWindow !== undefined || remote?.contextWindow !== undefined
          ? { contextWindow: remote?.contextWindow ?? entry.contextWindow }
          : {},
        // 输出上限同样「远端优先、兜底补位」：远端不下发时兜底表给保守值，
        // 两边都没有则留 undefined（不编造，见 resolveModel 的说明）。
        ...entry.maxOutputTokens !== undefined || remote?.maxOutputTokens !== undefined
          ? { maxOutputTokens: remote?.maxOutputTokens ?? entry.maxOutputTokens }
          : {},
        ...entry.supportsImages !== undefined || remote?.supportsImages !== undefined
          ? { supportsImages: remote?.supportsImages ?? entry.supportsImages }
          : {},
        ...entry.reasoningEfforts !== undefined || remote?.reasoningEfforts !== undefined
          ? { reasoningEfforts: [...(remote?.reasoningEfforts ?? entry.reasoningEfforts ?? [])] }
          : {},
        ...entry.defaultReasoningEffort !== undefined || remote?.defaultReasoningEffort !== undefined
          ? { defaultReasoningEffort: remote?.defaultReasoningEffort ?? entry.defaultReasoningEffort }
          : {},
        // 计费倍率只可能来自远端（兜底表是编译期快照，价格会变，不写死）。
        // 注意本函数是**白名单式重建**：不在这里显式搬运的字段会被静默丢弃，
        // 新增远端字段时必须同步加一行，否则 listModels 看不到它。
        ...remote?.creditsRate !== undefined ? { creditsRate: remote.creditsRate } : {},
        ...remote?.discountedCreditsRate !== undefined
          ? { discountedCreditsRate: remote.discountedCreditsRate }
          : {},
      }
    })
    // ⚠️ 追加「被 agent 引用但不在兜底表」的模型（见本方法注释的例外说明）。
    //
    // 放在**末尾**：兜底表里的模型保持原有顺序与权威性，补充的变体排在后面，
    // 不打乱用户已熟悉的列表顺序。
    //
    // ⚠️ 两条追加判据是**并集**（issue IKJQ3M）：
    //   ① `agentReferenced === true`：服务端说「对话里可选」；
    //   ② 远端**明确表态**接受图片（`supportsImages !== undefined`）：
    //      该模型正是本 issue 要解决的那类，丢弃它就会把「能看图的模型」
    //      误杀（`space-bunny` 走 ① 之外仍会被丢掉 —— 它未被任何 agent 引用）。
    // ⚠️ ② 刻意**只认 `supportsImages`**：加上 `contextWindow` / `maxOutputTokens`
    // 会把实测「11102 不可调用」的模型一并放回选择器（见 hasRemoteImageCapability）。
    // 两条都**不**放宽到「远端返回的一律收下」——那会让内部别名与未开放模型
    // 重新出现在选择器里（正是当初引入白名单的原因）。
    const known = new Set(reconciled.map((model) => model.id))
    for (const model of models) {
      if (known.has(model.id)) continue
      if (model.agentReferenced !== true && !hasRemoteImageCapability(model)) continue
      known.add(model.id)
      reconciled.push({ ...model })
    }
    return reconciled
  }

  /**
   * 远端能力字段被实测证伪、需要强制覆盖为「支持图片」的模型。
   *
   * 为什么需要它：上游两个模型端点对同一模型的能力声明会互相矛盾。
   * 实测 `glm-5.1`（2026-09）：
   * - scoped 端点 `/console/enterprises/personal/models` → `supportsImages: false`
   * - `/v3/config` → `supportsImages: true`
   * - 真实请求（纯红图 + 问颜色）→ 答出「红色」，**确实能看到图片**
   *
   * 由于 `fetchModels` 优先采用 scoped 端点，若不覆盖，`glm-5.1` 会被判成
   * 纯文本，用户贴图时直接吃 host 的 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝
   * （前端文案「当前模型不支持图片」），而图片根本到不了上游。
   *
   * 为什么用显式白名单而不是「兜底表 true 优先」这类通用规则：通用规则会让
   * 兜底表永久压过远端，一旦某模型真的下线或能力变更，用户会被放行后被上游
   * 400 拒绝 —— 错误更晚、更难懂。白名单只覆盖已实测确认的个案，新增条目
   * 必须先有真实请求证据。
   */
  private static readonly IMAGE_CAPABILITY_OVERRIDES: ReadonlySet<string> = new Set([
    // scoped 端点误报 false，实测能看图。
    'glm-5.1',
  ])

  /**
   * 模型接受的输入模态，或 `undefined` = **能力未知**。
   *
   * ## 为什么要有第三态（issue IKJQ3M）
   *
   * 原实现恒返回 `readonly ('text'|'image')[]`，把两种**语义相反**的状态
   * 压成同一个结果：
   * - 远端明确说 `supportsImages: false`（**确认不支持**）；
   * - 远端目录还没拉到 / 拉取失败（**暂时不知道**）。
   *
   * 两者都返回 `['text']`，后果有二，第二个更隐蔽：
   * 1. 贴图被拒且文案写「model "x" does not accept image input」——
   *    把「不知道」说成「不支持」，用户会去换模型、查文档，而真正的解法
   *    只是等目录就绪（真实报障：`buddy/space-bunny` 贴图报不支持，
   *    而真实网关 5/5 全对，纯红图答「红色」、双色图左右分别答对）。
   * 2. `listModels` / `resolveModel` 把这个 `['text']` 报给宿主 DSH，
   *    而 DSH 见到「不含 image」的声明会**静默把图片投影成占位文本**
   *    （dsh-llm `lib/index.js` 的 `projectImagesForTextModel`）
   *    ⇒ 图片既没进请求体、用户也拿不到任何原因。
   *
   * ✅ 因此「未知」必须**省略 `inputModalities` 字段**（宿主对 `undefined`
   * 不做任何投影，见同文件 `detachedModalities`），而不是报 `['text']`。
   *
   * ⚠️ 方向是**宁可漏判不可误伤**：未知仍不放行图片（见 `stream` 的门禁），
   * 只是不再谎报「不支持」。
   */
  private inputModalitiesFor(model: string): readonly ('text' | 'image')[] | undefined {
    // ⚠️ **判据必须逐级记录来源**：下面这条 `??` 链会把「远端明确 false」
    // 与「全都没查到」压成同一个 `false`（两者都非真值），而这两种状态的
    // 处理**恰好相反**（前者拒绝、后者只报「未知」）。故先用
    // `imageCapabilityKnown` 把两者分开，再走同一条取值链。
    const known = this.imageCapabilityKnown(model)
    const supportsImages = BuddyAdapter.IMAGE_CAPABILITY_OVERRIDES.has(model)
      || (this.remoteMeta.get(model)?.supportsImages
        ?? this.productFallbackMeta.get(model)?.supportsImages
        ?? IMAGE_MODELS.has(model))
    if (supportsImages) return ['text', 'image']
    return known ? ['text'] : undefined
  }

  /**
   * 该模型的图片能力是否**已被某个来源明确表态**（而不只是「没查到」）。
   *
   * ⚠️ 与 {@link inputModalitiesFor} 的**四个图片来源**必须逐级同源
   * （`IMAGE_CAPABILITY_OVERRIDES` → `remoteMeta.supportsImages` →
   * `productFallbackMeta.supportsImages` → `IMAGE_MODELS`）：
   * 本函数判「有没有表态」，那条链判「表态成什么」。两处口径不一致时，
   * 同一文件就会存在「一处说有、一处说无」的两套判据 —— 那正是本仓库反复
   * 出静默缺陷的形态。
   *
   * ⚠️ **刻意不含 `reasoningEfforts` / `defaultReasoningEffort`**：那不是图片
   * 能力。而目录准入侧的 `hasRemoteImageCapability` 也**只认 `supportsImages`** ——
   * 三处都是「只认图片能力」，互不交叉，**不会**出现「只带思考档位的远端模型
   * 被收进目录却判为图片未知」这类分叉（它的处置是保守的：不放行图片）。
   */
  private imageCapabilityKnown(model: string): boolean {
    if (BuddyAdapter.IMAGE_CAPABILITY_OVERRIDES.has(model)) return true
    // 远端显式 false 同样是「表态」，必须算已知。
    if (this.remoteMeta.get(model)?.supportsImages !== undefined) return true
    return this.productFallbackMeta.get(model)?.supportsImages !== undefined
      || IMAGE_MODELS.has(model)
  }

  /** 模型可选的思考等级：远端 supportedEfforts 优先，产品兜底表次之，通用静态表最后。 */
  private effortsFor(model: string): readonly string[] {
    return this.remoteMeta.get(model)?.reasoningEfforts
      ?? this.productFallbackMeta.get(model)?.reasoningEfforts
      ?? REASONING_EFFORTS.get(model)
      ?? []
  }

  /**
   * 模型声明的默认思考等级（远端 `reasoning.defaultEffort` 优先，产品兜底表次之）。
   *
   * 用途：composer 未选档位时补 `reasoning_effort`（deepseek 系不带档位 = 不思考）。
   * 若声明值不在该模型的支持档内（远端数据不一致）则视为未声明，由调用方回退。
   */
  private defaultEffortFor(model: string): string | undefined {
    const declared = this.remoteMeta.get(model)?.defaultReasoningEffort
      ?? this.productFallbackMeta.get(model)?.defaultReasoningEffort
    return declared !== undefined && this.effortsFor(model).includes(declared) ? declared : undefined
  }

  /**
   * 产品级兜底模型目录（`product.fallbackModels`）。
   *
   * 用于远端不可用或远端未覆盖到该模型时。与 `remoteMeta` 分开存放，
   * 使远端一旦可用就自动优先，而产品兜底只在缺失时补位。
   */
  private get productFallbackMeta(): ReadonlyMap<string, BuddyFallbackModel> {
    return this.productFallbackIndex
  }

  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率 + 同名消歧）。
   *
   * 设置页（Jet Hub「显示列表」）必须把**被关闭的**模型也渲染出来，否则用户
   * 无法重新打开；而 `listModels` 会按黑名单过滤掉它们，RPC 层只能凭黑名单的
   * key（裸 id）补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率随之丢失**
   * （用户报障：「关闭的就没有显示倍率」）。
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
   * ⚠️ **`all` 是「用于同名消歧的集合」，必须传未过滤的全量集合** ——
   * 见 `displayNameFor` 的说明（用过滤后的集合会让「关掉其中一个同名模型」
   * 改变另一个的变体标记，名字随开关跳变）。
   *
   * ⚠️ 本家三处**真实差异**（不要「顺手统一」）：
   * 1. `contextWindow` 三级查找：远端 `maxInputTokens` → 产品兜底表 → 通用静态表
   *    （对齐 Rust `context_limit_for_model` 的两级查找，多一层产品级）；
   * 2. `maxOutputTokens` 二级查找（远端 → 产品兜底），**必须声明**：
   *    不声明等于把这个值永久交给网关默认（实测网关默认仅 32000），
   *    大文件写入/长回答会在 32000 处被截断成 `finish_reason:'length'`；
   * 3. `reasoning` 的 `efforts` 取自 `effortsFor`（按模型/产品判据），
   *    且 `defaultEffort` **必须落在 `efforts` 内**。
   *
   * ⚠️ `inputModalities` **缺席即「未知」**（本家是全仓唯一真正使用该语义的家）：
   * `inputModalitiesFor` 用 `imageCapabilityKnown` 区分「远端明确 false」与
   * 「全都没查到」，后者返回 `undefined` ⇒ 这里**省略该字段**交给宿主判断。
   */
  private toCatalogEntry(model: BuddyRemoteModel, all: readonly BuddyRemoteModel[]): CatalogEntry {
    const contextWindow = this.remoteContextWindows.get(model.id)
      ?? this.productFallbackContextWindows.get(model.id)
      ?? CONTEXT_WINDOWS.get(model.id)
    const maxOutputTokens = positiveMaxTokens(
      this.remoteMeta.get(model.id)?.maxOutputTokens
      ?? this.productFallbackMeta.get(model.id)?.maxOutputTokens,
    )
    const efforts = this.effortsFor(model.id)
    const remoteDefault = this.remoteMeta.get(model.id)?.defaultReasoningEffort
      ?? this.productFallbackIndex.get(model.id)?.defaultReasoningEffort
    const modalities = this.inputModalitiesFor(model.id)
    return {
      id: model.id,
      // ⚠️ 同名消歧用**未过滤**的 `all`（见上）。
      name: displayNameFor(model, all),
      // ⚠️ `resolveModel` 的 name 取自**元数据**（不是 `displayNameFor`）——
      // 它不带倍率后缀，故显式提供 `bareName`。
      bareName: this.remoteMeta.get(model.id)?.name
        ?? this.productFallbackIndex.get(model.id)?.name
        ?? model.name,
      ...modalities !== undefined ? { inputModalities: modalities } : {},
      ...contextWindow !== undefined ? { contextWindow } : {},
      ...maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {},
      ...efforts.length > 0
        ? {
            reasoning: {
              efforts: efforts.map((id) => ({
                id: ReasoningEffortId(id),
                name: EFFORT_NAMES[id] ?? id,
              })),
              ...remoteDefault !== undefined && efforts.includes(remoteDefault)
                ? { defaultEffort: ReasoningEffortId(remoteDefault) }
                : {},
            },
          }
        : {},
    }
  }

  /**
   * 本家全部条目（**含 VL 等可见性判据**）—— 远端缓存 ?? 静态兜底表。
   *
   * ⚠️ 两条路径（`listModels` / `listAllModels`）都用**同一份未过滤集合**做
   * 同名消歧：`listModels` 侧原先误用「已过滤」集合，与 `displayNameFor` 的
   * 注释矛盾（用户 2026-10-08 裁定修正为未过滤 —— 一次**行为变更**：
   * 关闭同名模型之一时，另一个的变体标记不再跳变）。
   */
  private catalogEntries(source: readonly BuddyRemoteModel[]): readonly CatalogEntry[] {
    return source.map((model) => this.toCatalogEntry(model, source))
  }

  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    await this.ensureRemoteModels()
    return this.catalogEntries(this.remoteModels ?? this.staticFallbackModels())
  }

  /**
   * 同步视图（`listAllModels` 用）。
   *
   * ⚠️ **不能** `await ensureRemoteModels()`（同步契约）—— 读 `remoteModels`
   * 缓存，未落地时回退静态兜底表（这正是原实现的语义）。
   */
  private syncCatalogEntries(): readonly CatalogEntry[] {
    return this.catalogEntries(this.remoteModels ?? this.staticFallbackModels())
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(_provider)
  }

  /**
   * 解析模型元信息。
   *
   * ⚠️ 原实现里的三处判据（context 三级查找 / maxOutputTokens / reasoning）
   * 现已收敛到 `toCatalogEntry` —— 骨架的 `resolveModel` 只做回填与「不声明未知」。
   */
  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolveModel(provider, model, signal)
  }

  /**
   * 静态兜底模型目录：优先用产品自带的 `fallbackModels`，否则用通用默认表。
   *
   * 产品兜底表存在的原因：模型池由服务端按认证上下文下发，插件的 CLI
   * token 未必能取到完整集合（实测 WorkBuddy 国际版经 CLI token 只能拿到
   * 13 个别名，拿不到 GPT 系列）。产品兜底表提供该产品权威的完整清单。
   */
  private staticFallbackModels(): readonly { id: string; name: string }[] {
    const productModels = this.product.fallbackModels
    if (productModels !== undefined && productModels.length > 0) {
      return productModels.map((model) => ({ id: model.id, name: model.name }))
    }
    return DEFAULT_MODELS.map((id) => ({ id, name: id }))
  }

  /**
   * 兼容 0.1.1-rc.2：新版 LlmRuntime.prepareCall() 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * （0.1.0-rc.6）的 LlmAdapter 基类尚未提供该方法，缺少时会在每轮请求
   * 开始时抛 `registration.adapter.prepareCall is not a function`。这里把
   * 模型解析与分发绑定到同一个适配器实例（与 CodeArtsAdapter 同款 shim）。
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
    // 1. 获取凭据（过期则先静默续期）
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isCredentialExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError(
        // ⚠️ 文案里**不能**再提 `/buddy-login` —— 该斜杠命令已随单凭据模式一并移除
        // （AGENTS.md「不注册任何斜杠命令」），入口在 Jet Hub 设置页。
        `${this.product.id}: no usable credential; log in from the Jet Hub panel first`,
        'MISSING_CREDENTIAL',
      )
    }

    // Track current account for rate limit switching
    let currentAccountId = ''
    if (this.options.accountPool && credential) {
      try {
        // provider 实参必须是本适配器所属产品的 id（buddy / workbuddy）：
        // AccountPool 先按 entry.provider !== provider 过滤账号，写死 'buddy'
        // 时 WorkBuddy 账号（provider='workbuddy'）永远匹配不到，限流时间
        // 无法归属账号，UI 也永不显示限流标记。
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id,
          credential.access_token,
        )
        if (currentAccountId === '') {
          // 账号池里没有匹配该凭据的账号（例如用的是回退的单凭据），
          // 此时限流无法归属到具体账号，也就无法在 UI 上显示标记。
          console.warn(`[${this.product.id}] 当前凭据未匹配到账号池条目，限流记录将被跳过`)
        }
        // Token 账本（第 2 期）：回报「本笔请求解析出的账号」（空串不回报）。
        if (currentAccountId !== '') reportLedgerAccount(this.product.id, currentAccountId)
      } catch (error) {
        console.warn(`[${this.product.id}] 账号匹配失败（不影响本次请求）:`, error)
      }
    }

    // 能力判定（图片 / 思考强度）必须有远端目录在手：两者都以 /v3/config
    // 下发值为权威，而该拉取是懒加载的。缺了这一步，远端显式 false 会被
    // 静态兜底表覆盖，合法的思考等级也会被误判为不支持而丢弃。
    await this.ensureRemoteModels()

    // 2. 序列化消息
    // 图片：读原始字节并以内联 data URL 发出——这是 CodeBuddy 唯一接受的
    // 图片形态（{type:'image'} 会被服务端 400 拒绝）。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      // 能力未知时先给「重看一次目录」一次机会（受 10 秒间隔约束，
      // 见 refreshCatalog）：目录若已恢复，这一轮就能正常发图，
      // 用户根本看不到下面那句「请稍后重试」。
      if (this.inputModalitiesFor(options.model) === undefined) {
        await this.refreshCatalog()
      }
      const modalities = this.inputModalitiesFor(options.model)
      if (modalities === undefined) {
        // ⚠️ **能力未知 ≠ 不支持**（issue IKJQ3M）：目录没拉到就说「模型不支持
        // 图片」，用户会去换模型、查文档，而真正的解法只是等目录就绪。
        // 故用可区分的错误码与文案，别把「不知道」说成「不支持」。
        //
        // ⚠️⚠️ **不能用 `TRANSPORT`**（初版误选，被自己的回归用例抓出）：
        // `DEFAULT_RETRYABLE_CODES` 实测是
        // `['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`
        // —— `TRANSPORT` **就在里面**（dsh-llm `lib/index.js`）。于是这条
        // 「请稍后重试」会被 harness 白重试 5 次（500/1000/2000/4000/8000 ms），
        // 每次都重走一遍 `stream()` → `refreshCatalog()`，把一次用户报错放大成
        // 6 次目录拉取 + 6 次凭据解析（目录端点超时上限 60s，用户还会看到 6 次闪动）。
        //
        // ⇒ 方向取反：这类「等一会儿就好」的错误**不该由 harness 自动重试**。
        // `INVALID_REQUEST` 是仓库既有惯例（见本文件 `classifyHttpStatus`），
        // 且不在可重试集合里；用户在目录恢复后自己重试即可 ——
        // 那时 `refreshCatalog` 的 10 秒窗口通常已过，能直接发图。
        throw new LlmError(
          `${this.product.id}: 模型 "${options.model}" 的能力列表尚未加载完成，暂时无法判断是否支持图片；请稍后重试。`,
          'INVALID_REQUEST',
        )
      }
      if (!modalities.includes('image')) {
        throw new LlmError(`${this.product.id}: model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError(`${this.product.id}: image input requires the attachment service.`, 'UNSUPPORTED_CONTENT')
      }
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        // ⚠️ 先试**请求版本**（按像素预算缩放），拿到就用它；拿不到才发原图。
        // 这一步是本 issue 的正题：原图直发让 36 张截图顶穿网关的图片 token
        // 上限（≈100,000），此后每轮都失败且压缩救不回来。
        const projected = await this.projectRequestImage(ref)
        if (projected !== undefined) {
          imageUrls.set(id, `data:${projected.mediaType};base64,${Buffer.from(projected.data).toString('base64')}`)
          continue
        }
        let image: { data: Uint8Array; mediaType: string } | undefined
        try {
          image = await this.options.readImage(ref)
        } catch (error) {
          // 读取抛错必须冒泡成明确的 LlmError：早先这里会把异常吞掉，
          // 最终表现为「图片凭空消失、模型答非所问」，排查成本极高。
          throw new LlmError(
            `${this.product.id}: 读取图片附件失败（${id}）：${errorMessage(error)}`,
            'UNSUPPORTED_CONTENT',
            { cause: error as Error },
          )
        }
        if (image === undefined) {
          // 契约要求：读不到字节时报错，绝不静默丢弃整张图。
          // 返回 undefined 的典型成因是附件服务未就绪或对象已被清理；
          // 若此处 continue，线上请求会退化成纯文本，用户只看到模型
          // 「看不到图」而没有任何错误提示。
          throw new LlmError(
            `${this.product.id}: 图片附件读取不到内容（${id}）；附件服务可能未就绪，或该对象已不存在。`,
            'UNSUPPORTED_CONTENT',
          )
        }
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }
    const messages = serializeMessages(options.messages, imageUrls, this.product.id)
    if (options.system !== undefined && options.system.length > 0) {
      // ⚠️ 这条是 `serializeMessages` 之外的**第四个**产出点：`options.system`
      // 不经过那个函数，漏掉它等于「走 messages 的会话被救了、走 system 的会话照样被拦」。
      messages.unshift({
        role: 'system',
        content: rewriteTencentContentFingerprints(options.system, this.product.id),
      })
    }
    // ⚠️ wire 的**首条必须是 system**（2026-10-12 补测 + 本仓库既有约束）。
    //
    // 两个**独立**来源指向同一条要求，必须同时满足：
    //
    // ① WorkBuddy 网关**硬性要求** `messages[0]` 是 system，否则 400 + 11128
    //    `first message is not system prompt`，且 `displayMsg` 把它伪装成「安全
    //    策略拦截」（见 `account-probe.ts` 的 `PROBE_SYSTEM` 注释，内含
    //    2026-09-25 双端点对照实测：WorkBuddy 无 system → 400/11128、有 system
    //    → 200；CodeBuddy 两种都 200）。
    // ② space-bunny 的 11148：仅当「首条是**带 tool_calls 的 assistant**」时报
    //    `tool calls and tool results do not match`（`displayMsg.zh`=「工具记录不
    //    完整，请新建任务」），step-5-preview 则宽容；把 system 补到前面两个都 200。
    //
    // ⚠️ 判据因此是 `!== 'system'`，**不是** `=== 'assistant'` —— 后者漏掉
    // **user-first / tool-first** 的历史（实测存在：历史被压缩削头；以及 DSH 的
    // 一次性调用只带 user 而不带 system，见 `GenerateOptions.system` 的注释），
    // 那些在 WorkBuddy 上仍是同一个 11128。判据依赖「另一个产品碰巧不校验」同样是
    // 错的 —— 与 `PROBE_SYSTEM` 那段「无条件给所有 provider 都带 system」的取舍一致。
    //
    // ⚠️ 补在 `options.system` unshift **之后**：真实 system 优先，只有连它都没有
    // 时才需要这条兜底 ⇒ 不会重复插入。
    if (messages.length > 0 && (messages[0] as { role?: unknown }).role !== 'system') {
      messages.unshift({ role: 'system', content: LEADING_SYSTEM_PLACEHOLDER })
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    // 3. 构造请求体
    const bodyObj: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
      // prompt_cache_key 让服务端启用前缀缓存并在 usage 中返回缓存命中，
      // 缺少该字段时命中恒为 0（与 codearts 同款修复，见 llm-adapter.ts）。
      // 实证（2026 实测 deepseek-v4-flash，同一段 8k token 前缀）：
      //   不带该字段 → prompt_tokens=8027, prompt_cache_hit_tokens=0,    credit=0.34
      //   带该字段   → prompt_tokens=8027, prompt_cache_hit_tokens=7808, credit=0.02
      // 仅此一个字段的差异，费用差约 17 倍。同 key 重复请求稳定命中同一前缀。
      prompt_cache_key: this.sessionId,
    }
    if (tools !== undefined && tools.length > 0) bodyObj.tools = tools
    if (options.temperature !== undefined) bodyObj.temperature = options.temperature
    if (options.stop !== undefined && options.stop.length > 0) bodyObj.stop = options.stop
    // 单次请求输出上限。此前**完全没有**下发该字段，导致上限由网关默认值决定
    // （实测仅 32000），大文件写入会在中途被截断成 `finish_reason:'length'`，
    // UI 报「已达到输出 token 上限」，且本地无从调整。
    //
    // 取值优先级：调用方显式给的 options.maxTokens（DSH 会先注入 resolveModel
    // 声明的 defaultMaxTokens）→ 远端 maxOutputTokens → 产品兜底表。
    // 三者皆无则不发该字段，保持网关默认（不编造，理由见 resolveModel）。
    const declaredMaxTokens = positiveMaxTokens(
      options.maxTokens
        ?? this.remoteMeta.get(options.model)?.maxOutputTokens
        ?? this.productFallbackMeta.get(options.model)?.maxOutputTokens,
    )
    // DeepSeek 思维链开关（逆向官方 codebuddy.js，对齐 workbuddy2api-panel
    // thinking.go）。**实测关键结论（2026-09，直连三站点对照）**：
    //   - 裸请求（无 reasoning_effort、无 thinking）→ reasoning_content 恒为 0；
    //   - 仅带 reasoning_effort:high → 返回思考（148~250 字符）；
    //   - 仅带 thinking:{type:'enabled'} → 仍为 0（该字段单独无效）；
    //   - 两者都带 → 返回思考。
    // 即 **reasoning_effort 是真正的开关**，thinking 字段单独不生效（保留它是
    // 为对齐官方客户端出站形态，并覆盖未来后端按它判定的情形）。
    // 三站点（workbuddy 国际/中国 UA、codebuddy）行为一致 → endpoint/UA 无关。
    const deepseek = isDeepSeekModel(options.model)
    // 思考强度：composer 选中的等级透传为 `reasoning_effort`（实测
    // low/high/max 会显著改变返回的 reasoning_content 长度，服务端真实生效）。
    // 只在该模型确实支持该等级时才发，否则服务端会因非法参数 400。
    const efforts = this.effortsFor(options.model)
    const requestedEffort = options.reasoningEffort !== undefined && efforts.includes(options.reasoningEffort)
      ? options.reasoningEffort
      : undefined
    /**
     * 会话自动命名（`purpose: 'session-title'`）的思考与预算决策。
     *
     * 见 `session-title.ts` 的模块头：DSH 用 **64 token** 发标题请求、
     * 且**不传 `reasoningEffort`**，而宿主会把本模型的默认档注入进来
     * （`effective = requested ?? reasoning.defaultEffort`）。若照常开思考，
     * 实测 64 个 token 会被思考**全部吃满**、正文 0 字符、
     * `finish_reason: 'length'` ⇒ `dsh-session-title-llm` 直接拒绝，
     * 标题永远停在 fallback（issue IKKVDH）。
     *
     * 本家的关闭手段是**发裸请求**（`disableByOmission`）：实测
     * 「无 `reasoning_effort`、无 `thinking` → `reasoning_content` 恒为 0」。
     * ⚠️ 故下面**不能**再给 deepseek 系补默认档 —— 那正是缺陷的成因。
     */
    const plan = planSessionTitleThinking({
      purpose: options.purpose,
      requestedEffort: requestedEffort ?? (deepseek && efforts.length > 0
        ? this.defaultEffortFor(options.model) ?? (efforts.includes('high') ? 'high' : efforts[0])
        : undefined),
      declaredEfforts: efforts,
      maxTokens: declaredMaxTokens,
      // ⚠️ 只有 deepseek 系实测「不发字段即关闭」；其余模型族（glm/kimi）
      // 走各自 thinkingFormat，语义未实测，故不给它们这个豁免。
      disableByOmission: deepseek,
    })
    if (plan.isTitle) {
      // 标题请求：关得掉就不发任何思考字段（buddy 的 deepseek 系）；
      // 关不掉（如 glm/kimi 无 `off` 档）则保留原档位并由 plan 抬预算兜底。
      if (plan.effort !== undefined) bodyObj.reasoning_effort = plan.effort
    } else {
      if (deepseek) {
        bodyObj.thinking = { type: 'enabled' }
      }
      if (plan.effort !== undefined) {
        bodyObj.reasoning_effort = plan.effort
      }
    }
    const maxTokens = plan.maxTokens
    if (maxTokens !== undefined) bodyObj.max_tokens = maxTokens
    const body = JSON.stringify(bodyObj)

    // 4. 发送请求（401/403 时刷新当前账号一次，仍失败则换号重试）
    let response = await this.send(credential, body, options)
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      // ⚠️ 腾讯侧的安全策略拦截（`code:11140`）**也回 HTTP 403**。实测确认它是
      // **账号级**拦截（同一请求体在池里 7 个账号上「2 通 4 拦 1 限流」），因此
      // 处理方式与认证失败一致：**刷新 → 换号 → 全部试完才报错**。
      //
      // 早期实现把它当成「内容问题、与账号无关」而**拒绝换号**并直接抛
      // `INVALID_REQUEST`，后果（2026-09-27 用户实测）：池里有可用账号也永远
      // 用不上，每次都拿最先选中的坏账号去撞，且提示「请调整内容后重试」——
      // 把用户引向改内容，而真正该做的是换号／停用坏账号。
      //
      // 判据必须在认证分支内联判定而非提前 return：坏账号可能排在任何位置，
      // 必须让它和 401/403 一样进入下面的换号循环。
      const rejectedBody = await response.clone().text().catch(() => '')
      const contentRejected = isContentRejection(rejectedBody)
      // ⚠️⚠️ **同一个渠道校验拒绝也会以 HTTP 403 出现**（2026-10-16 审计实测）。
      //
      // 上游同一族拒绝**同时用 400 与 403 两种状态码**（本文件上面就有成文记录：
      // 11140「也回 HTTP 403」）。此前本档只接 400 与流内 200 ⇒ 403 形态落到
      // 下面的 `所有账号均被拒绝（HTTP 403）` 分支，码为 `httpErrorCode(403)` = **`AUTH`**，
      // 后果与本仓库既有红线**逐字相同**（`docs/agent-notes/client-ui.md` 的 IKLBSH）：
      // **DSH 客户端会把 message 整个换成「API 密钥无效」** ⇒ 本档精心写的
      // 「重发无效 / 停用该账号」一个字都到不了用户眼前，且 403 实测三个 token 全部有效。
      const channelRejected = isChannelVerificationRejection(rejectedBody, response.status)
      if (contentRejected) {
        // 记诊断日志（便于在插件日志里区分「换号」与「被策略拦下」），**不中断**换号，
        // 同时把这个账号在该模型上冷却 —— 否则它下次仍排第一，每轮都要重撞一遍。
        console.warn(
          `[${this.product.id}] 账号 ${currentAccountId || '(current)'} 被安全策略拦截`
          + `（HTTP ${response.status}，code 11140），继续换号：${errorDetail(rejectedBody).slice(0, 200)}`,
        )
        await markPolicyBlockedAccount(
          this.options.accountPool, this.product.id, currentAccountId, options.model,
        )
      }
      // ⚠️ 真实缺陷（2026-09-26，用户报障「账号池里明明有 3~4 个账号没被限流，
      // 却报『未配置凭据，请先登录』」）。早期实现在这里刷新一次就 `return`：
      //
      // ① **不换号** —— 池首账号被服务端拒绝（401/403）时，池里其余可用账号
      //    一个都用不上。轮换逻辑（下一段）只覆盖 `isRateLimited` 的 429 类，
      //    而 401/403 在这里就返回了。
      // ② **刷新失败直接冒泡** —— 刷新接线一旦指向单凭据 ref（见 `src/index.ts`
      //    的 createPoolRefresh 注释），抛出的「未配置凭据，请先登录」与真实原因
      //    毫无关系：账号池凭据完好，只是刷错了 ref。
      // ③ **下一轮必然复现** —— 刷新抛错前没有写回任何凭据，池首账号不变，
      //    于是「中断后继续 goal」永远撞同一条死路（自锁）。
      //
      // 现在的次序：刷新当前账号 → 重试 → 仍认证失败则按池顺序换号，
      // 全部换完才报 AUTH。
      const authStatus = response.status
      // 已尝试过的账号：换号时必须排除，否则会拿回刚失败的那个原地打转。
      const triedAuth = new Set<string>()
      if (currentAccountId !== '') triedAuth.add(currentAccountId)
      let refreshedCredential: BuddyCredential | undefined
      try {
        await this.options.refresh()
        refreshedCredential = await this.options.resolveCredential(options.model)
      } catch (error) {
        // 刷新失败**不致命**：换号仍有机会，单个账号故障不该让整轮陪葬。
        console.warn(`[${this.product.id}] 刷新当前账号凭据失败，改用换号重试：${String(error)}`)
      }
      if (refreshedCredential !== undefined && refreshedCredential.access_token.length > 0) {
        credential = refreshedCredential
        response = await this.send(credential, body, options)
        if (response.ok) {
          yield* this.consumeSse(response, options, currentAccountId)
          return
        }
      }
      let rotated = false
      /** 换号过程中是否撞到过安全策略拦截（用于最后的报错口径）。 */
      let sawContentRejection = contentRejected
      /**
       * **最后一次**撞到的拦截与其响应体：报错时的 HTTP 状态与文案都取它。
       *
       * 早先这里直接用 `authStatus`（**首发**的状态码）—— 而首发是 401、
       * 换号后才吃到 11140/403 的组合下，报出来的「HTTP 401」与实际被拦的
       * 那一次对不上，排查时会把人引向「token 过期」。
       */
      let rejectionStatus = contentRejected ? authStatus : 0
      let rejectionBody = contentRejected ? rejectedBody : ''
      /**
       * 换号途中是否撞到过「渠道校验」拒绝（见 `isChannelVerificationRejection`）。
       * ⚠️ 与 `sawContentRejection` 一样**用入口值初始化**（首发那次也必须记账，
       * 否则单账号池时专用出口不命中，退回 `AUTH` 误导文案）。
       */
      let sawChannelVerification = channelRejected
      let channelVerificationStatus = channelRejected ? authStatus : 0
      let channelVerificationBody = channelRejected ? rejectedBody : ''
      if ((response.status === 401 || response.status === 403) && this.options.accountPool !== undefined) {
        for (;;) {
          // modelId 参与过滤：正在限流期的账号不会被选中（与限流换号同语义）。
          const next = await this.options.accountPool.getAvailableAccount<BuddyCredential>(
            this.product.id, options.model, triedAuth,
          )
          if (!next || triedAuth.has(next.entry.id)) break
          triedAuth.add(next.entry.id)
          rotated = true
          credential = next.credential
          currentAccountId = next.entry.id
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consumeSse(response, options, currentAccountId)
            return
          }
          // ⚠️ 安全策略拦截（11140）同样继续换号 —— 它按账号生效，换号是唯一出路。
          // 必须**先于**「仅 401/403 才继续」的判据检查，否则会被当成普通 403
          // 之外的错误而 break，退回到「只试一个账号」的老问题。
          const rotatedBody = await response.clone().text().catch(() => '')
          if (isContentRejection(rotatedBody)) {
            sawContentRejection = true
            rejectionStatus = response.status
            rejectionBody = rotatedBody
            // 刚换到就是这个账号被拦：同样要冷却，否则下一轮它还是第一候选。
            await markPolicyBlockedAccount(
              this.options.accountPool, this.product.id, currentAccountId, options.model,
            )
          }
          // ⚠️ 渠道校验拒绝（403 形态）同样继续换号、且**刻意不写冷却**
          //（写 30 分钟账号级冷却在任何解释下都过重，理由见
          // `isChannelVerificationRejection` 的「为什么不写账号冷却」）。
          // 判据必须**先于**下面的「仅 401/403 才继续」检查，否则会被 break 掉。
          if (isChannelVerificationRejection(rotatedBody, response.status)) {
            sawChannelVerification = true
            channelVerificationStatus = response.status
            channelVerificationBody = rotatedBody
          }
          // 只有认证类失败（含安全策略拦截）才继续换号；
          // 429/5xx/400 交给下面的既有分类逻辑。
          if (response.status !== 401 && response.status !== 403) break
        }
      }
      // 刷新既没产出凭据、也没换到别的账号：保留原有的可诊断报错。
      if (refreshedCredential === undefined && !rotated) {
        // ⚠️ **必须先排除安全策略拦截**（补修，2026-09-28）：这条早退只看
        // 「续期失败 + 没换到号」，而**单账号池**恰恰必然满足它 —— 于是真实原因是
        // 11140（该账号被服务端策略拦下）时，报出来的却是
        // 「credential expired and refresh failed」+ `AUTH`，UI 只显示
        // 「API 密钥无效」，把用户引向重新登录（而实测 token 全部有效）。
        // 与 !15 / !16 已统一的口径一致：拦截就是拦截，别冒充认证失败。
        if (sawContentRejection) {
          throw contentRejectionError(
            this.product.id,
            rejectionStatus === 0 ? authStatus : rejectionStatus,
            rejectionBody.length === 0 ? rejectedBody : rejectionBody,
            true,
          )
        }
        // ⚠️ 同一早退分支也必须先排除**渠道校验拒绝**（与上面 11140 同款理由）：
        // 单账号池 + 403 形态恰好必然走到这里，若只排 11140，就会把渠道校验
        // 报成「credential expired and refresh failed」+ `AUTH`（UI 只显示
        // 「API 密钥无效」，实测 token 有效）。
        if (sawChannelVerification) {
          throw channelVerificationError(
            this.product.id,
            channelVerificationStatus === 0 ? authStatus : channelVerificationStatus,
            channelVerificationBody.length === 0 ? rejectedBody : channelVerificationBody,
            true,
          )
        }
        throw new LlmError(`${this.product.id}: credential expired and refresh failed`, 'AUTH', { status: authStatus })
      }
      if (response.status === 401 || response.status === 403) {
        // ⚠️ **必须带上响应体**（真实缺陷，我自己引入的回归，2026-09-27）：
        // 换号耗尽后若只报「所有账号均认证失败」，就把服务端真正说的原因丢掉了 ——
        // 而 403 在腾讯侧**并不等于认证失败**（额度耗尽 / 模型无权限 / 安全策略
        // 都可能回 403）。实测（2026-09-27 10:26）workbuddy 连续三轮报
        // 「所有账号均认证失败（HTTP 403）」，而随后逐账号复验发现 5 个 token
        // 全部有效（请求能进业务层、只因缺 system 提示回 400）—— 即那 403 并非
        // 登录问题。没有响应体就完全无从判断，只能靠猜。
        const detail = await response.text().catch(() => '')
        // 换号途中撞上的安全策略拦截：报专门的提示（指向账号，而非内容）。
        if (sawContentRejection || isContentRejection(detail)) {
          // 状态与响应体都取**最后一次拦截**（没有就退回首发的那一份 `detail`），
          // 免得「首发 401 + 途中 403/11140」报出一个对不上的 HTTP 401。
          throw contentRejectionError(
            this.product.id,
            rejectionStatus === 0 ? authStatus : rejectionStatus,
            rejectionBody.length === 0 ? detail : rejectionBody,
            true,
          )
        }
        // ⚠️ 渠道校验拒绝（403 形态）：报本档文案，**绝不**落到下面的
        // 「所有账号均被拒绝」——那个码是 `httpErrorCode(403)` = `AUTH`，
        // 客户端会把 message 换成「API 密钥无效」，把用户引向重新登录
        //（实测三个 token 全部有效）。
        // ⚠️ 顺序：放在 `sawContentRejection` **之后**（11140 语义更强、要写冷却，
        // 且它在换号途中已按 `rejectionStatus` 记账）。
        if (sawChannelVerification || isChannelVerificationRejection(detail, authStatus)) {
          throw channelVerificationError(
            this.product.id,
            channelVerificationStatus === 0 ? authStatus : channelVerificationStatus,
            channelVerificationBody.length === 0 ? detail : channelVerificationBody,
            true,
          )
        }
        throw new LlmError(
          `${this.product.id}: 所有账号均被拒绝`
          + `（HTTP ${authStatus}${authStatus === 401 ? '，请在 Jet Hub 重新登录' : ''}）：${errorDetail(detail)}`,
          httpErrorCode(authStatus, detail),
          { status: authStatus },
        )
      }
      // 换号途中遇到非认证类错误 → 落到下面的限流换号 / 错误码归类逻辑。
    }
    if (!response.ok) {
      let errorText = await response.text().catch(() => '')
      // ⚠️ 11140 安全策略拦截可能回 HTTP 400（2026-10-16 实测后端行为变更，
      // 之前回 403）。403 在上面的 401/403 分支已处理；400 走到这里。
      // 拦截按账号生效（同一请求在其他账号可 200），与 403 路径同一语义：
      // 标记冷却 + 逐个换号，全部被拦才报 PERMISSION_DENIED。
      if (response.status === 400 && isContentRejection(errorText)) {
        console.warn(
          `[${this.product.id}] 账号 ${currentAccountId || '(current)'} 被安全策略拦截`
          + `（HTTP 400，code 11140），换号重试`,
        )
        await markPolicyBlockedAccount(
          this.options.accountPool, this.product.id, currentAccountId, options.model,
        )
        if (this.options.accountPool !== undefined) {
          const triedPolicy = new Set<string>()
          if (currentAccountId) triedPolicy.add(currentAccountId)
          /**
           * 换号途中**最后一次**撞到的拦截与其响应体（报错时的 HTTP 状态与报文都取它）。
           *
           * ⚠️ 与 401/403 路径的 `rejectionStatus` / `rejectionBody` 是**同一纪律**：
           * 首发恒为 400，而换号后可能是 403 形态（上游两种都发），报「HTTP 400」
           * 与实际被拦的那一次对不上，排查时会被引向错误的方向。
           */
          let policyStatus = response.status
          let policyBody = errorText
          /**
           * 本轮是否撞到过安全策略拦截。**用入口值 `true` 初始化**（首发那一发
           * 本块已经判过 `isContentRejection`，它就是拦截）。
           *
           * ⚠️⚠️ 这条是**阻断级真缺陷**的修法（2026-10-17 对抗审计实测）：
           * 出口判据原先只读**循环结束后最后一次**的 `errorText`，而循环里的
           * 401/403/饱和 `continue` 腿都会把 `errorText` 刷成别的内容 ⇒ 已记账的
           * `policyStatus` / `policyBody` 变成死变量，11140 这个真因被整段丢弃。
           *
           * 实测（AT1 `400/11140` → AT2 `403 forbidden quota`，池耗尽）：
           * | | 修复前 | 修复后 |
           * |---|---|---|
           * | 错误码 | `AUTH` | `PERMISSION_DENIED` |
           * | message | 「buddy: forbidden quota」 | 「buddy: 全部账号均被服务端安全策略拦截…」 |
           *
           * ⚠️ `AUTH` 正是本仓 IKLBSH 红线：**DSH 客户端会把 message 整个换成
           * 「API 密钥无效」** ⇒ 用户既看不到「根因是账号被安全策略拦截、该去
           * Jet Hub 停用它」这句唯一出路，也会被引向重新登录（实测 token 全有效）。
           *
           * ⚠️ 与 401/403 路径的 `sawContentRejection` 是**完全同型**的写法 ——
           * 那条同样是用入口值初始化，目的就是堵这个洞；本块先前漏了这腿。
           */
          let sawPolicyRejection = true
          for (;;) {
            const next = await this.options.accountPool.getAvailableAccount<BuddyCredential>(
              this.product.id, options.model, triedPolicy,
            )
            if (!next || triedPolicy.has(next.entry.id)) break
            triedPolicy.add(next.entry.id)
            credential = next.credential
            currentAccountId = next.entry.id
            response = await this.send(credential, body, options)
            if (response.ok) {
              yield* this.consumeSse(response, options, currentAccountId)
              return
            }
            errorText = await response.text().catch(() => '')
            // ⚠️⚠️ 判据**不能**绑状态码（2026-10-17 审计实测的真缺陷）。
            //
            // 上游这一族拒绝**同时用 400 与 403 两种状态码**（本文件 401/403 分支的
            // 注释就记录着「11140 也回 HTTP 403」）。原实现写死 `status === 400`，
            // 于是「400 起 → 换号撞到 403 形态拦截」会在此 `break`，把池里
            // **后面那些完全可用的账号**直接判死。
            //
            // 实测（真实池同形替身，池 = 3 个账号）：
            // | 账号 | 响应 | 修复前 | 修复后 |
            // |---|---|---|---|
            // | AT1 | `400` + 11140 | 发起 | 发起 |
            // | AT2 | `403` + 11140 | **break，不试** | 继续换号 |
            // | AT3 | `200` 可用 | ❌ **从未被试**，报 `AUTH` 失败 | ✅ 成功 |
            //
            // ⇒ 这正是本块要修的那类故障（池里有可用账号却用不上）的**镜像版**：
            // 它自己又造了一遍，且错误码 `AUTH` 会被 DSH 客户端换成「API 密钥无效」
            // （`docs/agent-notes/client-ui.md` 的 IKLBSH 红线）⇒ 实测 token 全有效
            // 却把用户引向重新登录。
            if (isContentRejection(errorText)) {
              policyStatus = response.status
              policyBody = errorText
              sawPolicyRejection = true
              console.warn(
                `[${this.product.id}] 换号后账号 ${currentAccountId || '(current)'} 被安全策略拦截`
                + `（HTTP ${response.status}，code 11140），继续换号：`
                + `${errorDetail(errorText).slice(0, 200)}`,
              )
              // 刚换到就被拦：同样要冷却，否则下一轮它还是第一候选。
              await markPolicyBlockedAccount(
                this.options.accountPool, this.product.id, currentAccountId, options.model,
              )
              continue
            }
            // ⚠️⚠️ 换号途中撞到 **401/403**（凭据真失效）**必须继续换号**：
            // 它按账号生效，与 11140 无关；而池里后面的账号完全可用，break 会把
            // 整轮判死。与 401/403 路径的换号循环、以及限流路径的「② 认证类失败」
            // 分支**保持同一语义**（三处都只把「非账号级错误」当 break 理由）。
            //
            // 实测同上：AT1 `400/11140` → AT2 `401` → AT3 `200`，
            // 修复前只发 2 次即报 `AUTH`，AT3 从未被试。
            if (response.status === 401 || response.status === 403) {
              console.warn(
                `[${this.product.id}] 换号后账号 ${currentAccountId || '(current)'} 认证失败`
                + `（HTTP ${response.status}），继续换号`,
              )
              continue
            }
            // ⚠️⚠️ **模型饱和（14003 / 429）也必须换号**，且**刻意不写冷却**
            //（2026-10-17 第一轮独立审计实测的真缺陷）。
            //
            // 下方那条饱和分支的处置是「留在本账号退避重试、绝不换号」，它的
            // 前提写在饱和分支的注释里：「饱和是模型级，池里其它账号会撞同一堵墙」。
            // ⚠️ 但那个前提在**上游按账号做过负载均衡**时未必成立，而本块恰恰证明
            // 11140 是**按账号**生效的 ⇒ 同一模型下不同账号的繁忙度可以不同。
            //
            // 实测（AT1 `400/11140` → AT2 `429/14003` → AT3 完全可用）：
            // | 观测 | 走饱和分支（修复前） | 换号（修复后） |
            // |---|---|---|
            // | 发过的凭据 | `AT1, AT2, AT2, AT2`（**AT3 从未被试**） | 逐个换号 |
            // | 结果 | ❌ `RATE_LIMIT`「换账号无效」 | ✅ 用上 AT3 |
            //
            // ⇒ 修复前会给用户一条**错误的行动指引**（「换账号无效，请改用其它模型」），
            // 而池里明明有可用账号 —— 正是本块要消灭的那类故障。
            //
            // ⚠️ **不写冷却**：饱和与 11140 不同，它是**模型级**的，写 30 分钟账号级
            // 冷却会把一批好账号封死（饱和分支的注释正是为此反对复用限流标记）。
            // 「换个号也许能用」只需 try 一次，不必留下持久痕迹。
            //
            // ⚠️⚠️ **判据本体已做结构化降级，这里不得再加 `!isRateLimited` 护栏**
            //（2026-10-17 对抗审计实测的教训，两次都踩过）。
            //
            // 上游的**账号额度限流**（`code: 6004`）正文里可能带「请求量饱和」
            // 一类措辞，与模型饱和 `14003` 在**文案兜底**上无法区分。
            // 曾在这里加 `&& !isRateLimited(...)` 想把它们分开，结果：
            // | 报文 | `isRateLimited` | 结果 |
            // |---|---|---|
            // | `429/14003`（真饱和） | **恒真**（判据对 429 无条件返回 true） | ❌ 被护栏挡掉，退回下方饱和分支 ⇒ 上一轮修的「饱和也换号」**完全失效** |
            // | `429/6004`（额度限流） | 恒真 | ✅ 被挡住（这本是对的方向） |
            // ⇒ 一条护栏想拦两件事，实际只拦对了那个**本来就不该走这条腿**的，
            // 反而把**该走的**也拦了 —— 判据太宽时，正确的修法是**收窄判据**
            // （`isModelSaturationError` 本体的结构化降级），不是在调用点打补丁。
            if (isModelSaturationError(response.status, errorText)) {
              console.warn(
                `[${this.product.id}] 换号后模型 ${options.model} 请求量饱和（14003），`
                + `换号重试（不写冷却：饱和是模型级的，换号只是「也许这个号不忙」）`,
              )
              continue
            }
            // 其余（限流 / 上下文超限 / 渠道校验 …）：交给下面的既有分类逻辑，
            // 那里的换号循环与错误码各自有正确语义（不重复换号，见下方注释）。
            break
          }
          // ⚠️⚠️ 出口判据（2026-10-17 对抗审计实测的阻断级缺陷的修法）。
          //
          // 循环里的 401/403/饱和 `continue` 腿都会把 `errorText` 刷成别的内容，
          // 于是出口若只读最后一次响应，已记账的 11140 根因会被整段丢弃。
          // 实测（`AT1 400/11140 → AT2 403 forbidden quota`，池耗尽）：
          //   错误码 `AUTH`、message「buddy: forbidden quota」—— **11140 消失**。
          // 而 `AUTH` 正是本仓 IKLBSH 红线：**DSH 客户端把 message 整个换成
          // 「API 密钥无效」** ⇒ 用户看不到「根因是账号被安全策略拦截、该去 Jet Hub
          // 停用它」这句唯一出路（实测 token 全部有效）。
          //
          // ⚠️⚠️ 但判据**不能**只看 `sawPolicyRejection`（那是另一个方向的错）：
          // 末位若是**限流**，它有各自正确的下游语义（写标记 + 换号 + 「所有账号均受限」），
          // 此时误报成「全部账号均被安全策略拦截」反而是说谎。实测（修复过程中的回归）：
          // `AT1 400/11140 → AT2 429/6004 额度限流` 误报「全部账号均被拦截」，
          // 且额度标记丢失。
          //
          // ⇒ 判据是「**撞过拦截，且末位属于「message 会被客户端吞掉」的那一档**」：
          // | 末位 | 处理 | 理由 |
          // |---|---|---|
          // | 仍是拦截 | 报拦截 | 原语义 |
          // | `401` / `403` | **报拦截**（保留 11140 根因） | 它们的码会被客户端吞成「API 密钥无效」 |
          // | 限流 / 饱和 / 上下文超限 / 渠道校验 | 交给下方既有逻辑 | 各有正确语义与换号循环 |
          //
          // ⚠️ 与 401/403 路径的 `sawContentRejection` 同源：那条同样是用入口值
          // 初始化、且同样优先于 AUTH 出口，目的就是不让 11140 被认证类错误吞掉。
          const lastIsAuthFailure = response.status === 401 || response.status === 403
          if (!response.ok && sawPolicyRejection
            && (isContentRejection(errorText) || lastIsAuthFailure)) {
            throw contentRejectionError(this.product.id, policyStatus, policyBody, true)
          }
        }
        // 单凭据路径（无账号池可换）：如实报「当前账号」。
        //
        // ⚠️ 必须走**单凭据出口**（`rotated: false` ⇒ 文案是「当前账号被…」）而不是
        // 谎称「全部账号均…（已逐个换号重试）」—— 没有池就没有换号发生过，
        // 旧写法把 `rotated` 绑成「池是否配置」，在「有池但换号后变成非拦截错误」
        // 那条路径上也会谎报（该路径已由上面的出口覆盖，但两出口并存时必须各自诚实）。
        if (!response.ok && response.status === 400 && isContentRejection(errorText)) {
          throw contentRejectionError(this.product.id, 400, errorText, false)
        }
        // 换号后变成其他错误（限流 / 饱和 / 认证）：继续走下面的既有逻辑
      }
      // ⚠️⚠️ **模型饱和必须**先于**限流分支判定**（真实缺陷，2026-10-05）
      //
      // `14003 model busy` **也是 HTTP 429**，而 `isRateLimited` 对 429
      // **无条件返回 true** —— 若先走下面的限流分支，就会给每个账号写一条
      // **1 小时**限流标记（报文里没有「将在…重置」，故取 `RATE_LIMIT_FALLBACK_MS`
      // 兜底），把**整池**锁死。
      //
      // 用户报障正是这个：第一次用 `buddy/space-bunny` 就报
      // 「模型 space-bunny 所有账号均受限」。
      //
      // 实测四条证据（`scripts/probe-buddy-*.mjs`，2026-10-05）：
      // | 观测 | 结果 |
      // |---|---|
      // | 4 个**不同腾讯 uid** 的账号 | 20 秒内**全部**被写 `space-bunny` 标记 |
      // | 标记解禁时刻 | 全 = 「写入 + 整 1 小时」= **兜底值**，非服务端给的 |
      // | 4 MB 输入 | 稳定逼出 `429/14003`，报文自称「模型繁忙，请换模型」 |
      // | 小请求 30 发 | 全 200，但耗时 841ms ~ 216s（上游**时变**背压） |
      //
      // 4 个互不相干的账号同时中招，账号级限流**无法解释** ⇒ 只能是模型级。
      // 服务端报文自己就写着 `actions:["SWITCH_MODEL",…]`（**没有**换号选项）。
      //
      // ⚠️ 故正确动作是：**留在本账号退避重试**，绝不换号、绝不写标记 ——
      // 与 zcode `3009` 并发限流的处置同型（那边注释：换账号也一样撞，
      // 白白标记掉一个可用账号）。
      if (isModelSaturationError(response.status, errorText)) {
        for (let attempt = 0; attempt < BUDDY_SATURATION_MAX_RETRIES; attempt += 1) {
          const waitMs = buddySaturationDelayMs(attempt)
          console.warn(
            `[${this.product.id}] 模型 ${options.model} 请求量饱和（上游 14003 model busy），`
            + `${waitMs}ms 后**在本账号**重试（第 ${attempt + 1}/${BUDDY_SATURATION_MAX_RETRIES} 次）`
            + `—— 不换号、不写限流标记：饱和是模型级，池里其它账号会撞同一堵墙`,
          )
          await sleepMs(waitMs)
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consumeSse(response, options, currentAccountId)
            return
          }
          errorText = await response.text().catch(() => '')
          // 重试后若已**不是**饱和（如变成额度限流 / 认证失败），
          // 立刻停手交给下面的既有分类逻辑 —— 那些语义各有各的正确动作。
          if (!isModelSaturationError(response.status, errorText)) break
        }
        // 退避重试用尽仍是饱和：如实报「模型繁忙」并给**唯一有效**的动作
        // （换模型），而不是伪造成「账号额度受限」（那会让用户白等 1 小时）。
        if (isModelSaturationError(response.status, errorText)) {
          throw new LlmError(
            `${this.product.id}: 模型 ${options.model} 当前请求量饱和`
            + `（上游 14003 model busy，报文原文：「模型繁忙，请换模型或稍后重试」），`
            + `已重试 ${BUDDY_SATURATION_MAX_RETRIES} 次仍未通过。`
            + `此为该**模型**整体繁忙，并非账号额度问题 —— 换账号无效，`
            + `请改用其它模型，或稍后重试（无需重新登录）。`,
            'RATE_LIMIT',
            { status: response.status },
          )
        }
      }
      // 限流处理：把当前账号在该模型上的重置时间记录下来，然后逐个尝试
      // 其余可用账号。每个失败账号都会被记录，只有真正试完全部候选才报
      // "所有账号均受限"——避免只试一个就下结论（那会让 UI 显示的限流
      // 状态与实际判定不一致）。
      // ⚠️ 必须把 `response.status` 一并传入：服务端可能返回**空体**的 429，
      // 而只按正文判定时对空体恒为 false → 整段换号逻辑被跳过，本可自愈的限流
      // 被直接抛给用户（表现为「池里明明还有可用账号，插件却报错且不换号」）。
      // ⚠️⚠️ 「渠道校验」拒绝（`11128 conversation id missing`）**也按账号生效**，
      // 必须与限流一样进入本换号循环（2026-10-16 真实报障：整条渠道全灭）。
      //
      // 它**不满足** `isRateLimited`（实测对真实报文返回 `false`），故修复前落到
      // 下面「其余非限流错误 ⇒ 换号无益 ⇒ 直接抛」那一支，池里其余可用账号
      // 一个都试不到；而被拒账号恰是池里 workbuddy 首位 ⇒ 每轮都撞它。
      const channelRejected = isChannelVerificationRejection(errorText, response.status)
      if (this.options.accountPool && (isRateLimited(errorText, response.status) || channelRejected)) {
        const tried = new Set<string>()
        if (currentAccountId) tried.add(currentAccountId)

        // ⚠️ 限流换号途中同样会撞上安全策略拦截（11140，HTTP 403）—— 它按账号
        // 生效、与限流无关，但**必须继续换号**而不是中断。
        //
        // 真实缺陷（用户报障 2026-09-28「本轮运行失败 · API 密钥无效」）：早期
        // 实现在这里遇到非限流错误就**直接抛**。而池里 7 个 workbuddy 账号中
        // 前 4 个恰是被 11140 拦截的坏账号、后 3 个可用，于是换号在第 1 个坏
        // 账号处就中断，后面 3 个可用账号**永远试不到**（实测复刻：中断于
        // #1，若不中断则 #4 即成功）。错误码取 `httpErrorCode(403)` = `AUTH`，
        // UI 把它渲染成「API 密钥无效」，把用户引向检查密钥 —— 而 7 个 token
        // 实测全部有效（2027-09 才过期），真实原因完全丢失。
        //
        // 这与认证路径（上面的 401/403 分支）必须保持同一语义：坏账号可能排在
        // 任何位置，安全策略拦截和认证失败一样只是「这个账号不可用」。
        let sawContentRejection = false
        let contentRejectionStatus = 0
        let contentRejectionBody = ''
        /**
         * 换号途中是否撞到过「渠道校验」拒绝（`11128 conversation id missing`）。
         *
         * 与 `sawContentRejection` **分开计**：两者虽然都是「全部试完要报专门提示」，
         * 但文案、冷却语义都不同（本档不写冷却），合并会让报错口径漂移。
         *
         * ⚠️⚠️ **必须用入口的 `channelRejected` 初始化，而不是 `false`**
         *（真实缺陷，2026-10-16 审计实测；与 401/403 路径的
         * `let sawContentRejection = contentRejected` 是**同一写法**）。
         *
         * 循环内的那一档只在「**换到下一个账号**后又被拒」时置位，故从 `false`
         * 起算会漏掉**首发**那一次失败 —— 而入口 `channelRejected` 早已算出它。
         * 后果（实测）：池里没有第二个候选时（单账号池，或候选全被限流标记
         * 过滤掉），循环第一跳就 `break`，两个专用出口一个都不命中，直接落到
         * 下面的「所有账号均受限，请稍后再试」+ `QUOTA_EXCEEDED` ——
         * **本档存在的理由被自己的实现原样推翻**（把渠道校验误报成额度受限，
         * 让用户白等一个重置时刻）。
         *
         * 实测对照：`[acct-1]` 单账号池被拒 ⇒ 修复前 `QUOTA_EXCEEDED`；
         * 用 `channelRejected` 初始化后 ⇒ 走本档出口 `PERMISSION_DENIED`。
         */
        let sawChannelVerification = channelRejected
        let channelVerificationStatus = channelRejected ? response.status : 0
        let channelVerificationBody = channelRejected ? errorText : ''
        /**
         * 已经写过限流标记的账号：避免同一个账号被重复记账（换号途中可能取回它）。
         * 标记是「账号 × 模型」的快照，写两次没有意义，日志也会重复。
         */
        const rateLimitMarked = new Set<string>()

        for (;;) {
          // 先给**当前**账号记限流标记（UI 据「限额重置」徽章展示；它也是
          // 「重测 / 重置」两条人工解禁路径的唯一依据）。
          //
          // ⚠️ 判据从「解析出重置时间」改为 `isRateLimited(errorText, response.status)`：
          // 空体 429 根本没有 `msg` 可解析（`parseRateLimitError` 给兜底时长，
          // 不需要在这里区分），而**只要判为限流就必须留下标记** —— 否则用户
          // 既看不到限流徽章、也无法手动解禁。真实缺陷复现：空体 429 时旧写法
          // 连标记都不写（`recorded` 为空），而换号却发生了。
          //
          // ⚠️ `parseRateLimitError` 仍然优先：它能把**服务端声明的**真实重置
          // 时刻抠出来（有就绝不用兜底的 1 小时）。换号后 `errorText` 可能是
          // 11140 等非限流体 —— 那种情况下面①的分支会先 continue，走不到这里。
          //
          // ⚠️⚠️ **饱和必须排除在记账之外**（2026-10-17 对抗审计实测的真缺陷）。
          //
          // 本循环**每轮开头**都给当前账号记限流标记，而 `isRateLimited` 对 429
          // **无条件返回 true** —— 于是「换号途中撞到 14003 模型饱和」的账号会被
          // 写上**整 1 小时**的「限额重置」标记。
          //
          // 实测（AT1 `429/14002` 额度限流 → AT2 `429/14003 模型饱和` → AT3 `200`）：
          // 标记 = `[acc-1: 60 分钟, acc-2: 60 分钟]` —— 而 acc-2 是**模型级**饱和，
          // 一次瞬时繁忙不该让账号被藏一小时。
          //
          // ⚠️ 这与本文件下方那条「饱和必须先于限流分支判定，否则整池锁死」的守卫
          // **直接矛盾**：那道守卫只在**循环外**生效（决定是否进入限流分支），
          // 而换号**途中**新撞到的饱和会从这条记账腿漏过去 —— 同一缺陷的
          // 「限流路径版本」。`8294b0b` 修了 400 路径那一处，本条是它的对偶。
          if (currentAccountId !== '' && isRateLimited(errorText, response.status)
            && !isModelSaturationError(response.status, errorText)
            && !rateLimitMarked.has(currentAccountId)) {
            rateLimitMarked.add(currentAccountId)
            const parsed = parseRateLimitError(errorText, options.model, response.status)
            await this.options.accountPool.updateModelRateLimit(
              currentAccountId,
              parsed?.modelId ?? options.model,
              parsed?.resetTimeMs ?? Date.now() + RATE_LIMIT_FALLBACK_MS,
            )
          }
          // 取下一个未尝试过的可用账号（同样按本产品 id 过滤，否则 WorkBuddy
          // 永远取不到候选账号，限流后无法自动切换）。
          //
          // 必须把 `tried` 传给池：见 `AccountPool.getAvailableAccount` 的说明 ——
          // 池按「重置时间最早到期」排序，刚失败的账号可能仍排第一，
          // 不排除就会拿回同一个、命中下面的 `tried.has` 而立即 break。
          const next = await this.options.accountPool.getAvailableAccount<BuddyCredential>(
            this.product.id, options.model, tried,
          )
          if (!next || tried.has(next.entry.id)) break
          tried.add(next.entry.id)
          credential = next.credential
          currentAccountId = next.entry.id
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consumeSse(response, options, currentAccountId)
            return
          }
          errorText = await response.text().catch(() => '')
          // ① 安全策略拦截（11140）：按账号生效，继续换号（与认证路径同语义）。
          //    判据必须**先于**下面的「非限流即抛」，否则会退回「只试一个账号」。
          if (isContentRejection(errorText)) {
            sawContentRejection = true
            contentRejectionStatus = response.status
            contentRejectionBody = errorText
            console.warn(
              `[${this.product.id}] 账号 ${currentAccountId || '(current)'} 被安全策略拦截`
              + `（HTTP ${response.status}，code 11140），继续换号：${errorDetail(errorText).slice(0, 200)}`,
            )
            // 与认证路径同一实现：被拦的账号在**该模型**上冷却一段时间。
            //
            // ⚠️ 这里**不能**用上面的 `updateModelRateLimit` 记账分支 —— 那个写的是
            // 服务端给的限流重置时刻；11140 报文里**没有**时间，`parseRateLimitError`
            // 会返回 `null`，走它的兜底等于把「策略拦截」冒充成「限流」。
            await markPolicyBlockedAccount(
              this.options.accountPool, this.product.id, currentAccountId, options.model,
            )
            continue
          }
          // ⚠️⚠️⚠️ **③ 必须排在 ② 之前**（2026-10-18 独立审计实测的真缺陷，本轮修）。
          //
          // 上游对渠道校验**同时用 400 与 403**，而 ② 把 403 **全部**短路 ⇒
          // ③ 在 403 形态上**一次都不会执行** ⇒ `sawChannelVerification` 置不了位。
          //
          // ## 触发条件（必须**从限流进来**，否则复现不了 —— 这里最容易搞错）
          //
          // 只有入口 `isRateLimited || channelRejected` 为真才进这个换号循环。
          // ⚠️ 若入口**本身就是**渠道校验（400/403），`channelRejected` 为 `true`
          // ⇒ `sawChannelVerification` **已由入口值初始化** ⇒ ③ 一次不跑也照样
          // 出口正确。⇒ 「混合 400/403 池」复现**全部通过**，就是这个原因。
          //
          // 真实触发：**入口 429 限流**（`channelRejected=false`）→ 循环内某账号
          // 回 **403 形态**渠道校验：
          // | 入口 429，循环内 | 修复前 | 现版 |
          // |---|---|---|
          // | AT2/AT3 = **403** 渠道校验 | ❌ `QUOTA_EXCEEDED`「所有账号均受限」 | ✅ `PERMISSION_DENIED` |
          // | AT2/AT3 = **400** 渠道校验 | ✅ 已正确 | ✅ |
          //
          // ## 后果（正是本组注释写「必须先于 QUOTA_EXCEEDED」要消灭的形态）
          //
          // 用户看到「模型 X 所有账号均受限，请稍后再试」⇒ 以为在限额、**白等一个
          // 根本不存在的重置时刻**；而真实出路是「换号 / 停用该账号 / 换 provider」。
          //
          // ⚠️ **顺序纪律与 400 路径那条换号循环一致**：那里把 `isContentRejection`
          // 放在 401/403 腿**之前**（可观察的顺序纪律），本循环原先却相反 ⇒
          // 两条路径**判据同型、顺序相反**。本轮对齐。
          if (isChannelVerificationRejection(errorText, response.status)) {
            sawChannelVerification = true
            channelVerificationStatus = response.status
            channelVerificationBody = errorText
            // ⚠️ 日志**不写死** `msg` 那句措辞：实测它在同一 code 下有多种形态
            //（`conversation id missing` / `request illegal` / …），写死会让日志
            // 与上游实际回报不符、误导排查。原始报文在后面的 detail 里。
            console.warn(
              `[${this.product.id}] 账号 ${currentAccountId || '(current)'} 未通过渠道校验`
              + `（HTTP ${response.status}，code 11128），继续换号`
              + `（不写冷却）：${errorDetail(errorText).slice(0, 200)}`,
            )
            continue
          }
          // ② 认证类失败：该账号凭据不可用，与路径 A 一致继续换号。
          // ⚠️ 排在本档（③）**之后**：渠道校验的 403 形态必须由 ③ 认领，
          // 否则会被这里短路 ⇒ 出口谎报「所有账号均受限」（见上）。
          if (response.status === 401 || response.status === 403) continue
          // ④ 其余非限流错误：请求本身有问题，换号无益，按原错误分类抛出。
          //    ⚠️ 同样必须传状态码：否则空体 429 会被当成「非限流」而在换号
          //    途中**中断**，池里其余可用账号一个都试不到。
          if (!isRateLimited(errorText, response.status)) {
            // 新账号失败但不是限流：按原错误分类抛出，不要再吞成"均受限"
            throw httpRejectionError(this.product.id, response.status, errorText)
          }
          // ⑤ 仍是限流 → 继续下一轮（重置时间已在上方记录）。
        }
        // 全部候选试完：若途中撞过安全策略拦截，报专门的提示（指向账号而非内容）。
        if (sawContentRejection) {
          throw contentRejectionError(
            this.product.id, contentRejectionStatus || 403, contentRejectionBody, true,
          )
        }
        // 全部候选都未通过渠道校验：报专门的「按账号 + 重发无效」提示。
        // ⚠️ 必须先于下面的 QUOTA_EXCEEDED —— 否则会把渠道校验误报成「全部账号受限」，
        // 让用户以为在限额、白等一个重置时刻。
        //
        // ⚠️ 本出口靠 `sawChannelVerification` 用**入口的 `channelRejected`** 初始化
        // 才覆盖「首发即被拒且没有第二个候选」的形态（单账号池）。见该变量的注释。
        if (sawChannelVerification) {
          throw channelVerificationError(
            this.product.id, channelVerificationStatus || 400, channelVerificationBody, true,
          )
        }
        throw new LlmError(`${this.product.id}: 模型 ${options.model} 所有账号均受限，请稍后再试`, 'QUOTA_EXCEEDED')
      }
      throw httpRejectionError(this.product.id, response.status, errorText)
    }

    // 5. 消费 SSE 流
    yield* this.consumeSse(response, options, currentAccountId)
  }

  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  private async send(
    credential: BuddyCredential,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    const headers = new Headers(attributionHeaders())
    headers.set('Authorization', `Bearer ${credential.access_token}`)
    headers.set('Accept', 'text/event-stream')
    headers.set('Content-Type', 'application/json')
    // ⚠️ 顺序与空值语义都不能改（真实缺陷，两个子问题都出在这一行）：
    // ① **以产品配置为准**，而不是优先用凭据里的 `credential.domain`。凭据的
    //    domain 是「登录时站点」的快照；产品改造后（早期 workbuddy 指向
    //    copilot.tencent.com，现为 www.workbuddy.ai）旧凭据里仍是过期值。本请求的
    //    baseURL 取自 `product.endpoint`，X-Domain 必须与之一致，否则身份标识与
    //    目的地址自相矛盾。`src/credits.ts` 的 `checkinHeaders` 早已按此理由实现
    //    （见其文档注释），此处原先与它相反 —— 同一账号的聊天与积分请求会声明
    //    **不同的** X-Domain，属两处实现漂移。
    // ② 必须用 `||` 而非 `??`：domain 经 `readStringField` 读取，字段缺失时返回
    //    **空串**（不是 undefined），`??` 对空串不生效，X-Domain 会以空值发出
    //    （已用单测复现：`''` 未回退到 `copilot.tencent.com`）。
    // 末位 `|| ''` 只为满足 Headers.set 的非空类型要求：产品与凭据都为空属配置
    // 错误，此时发出空值比编造一个域名更诚实。
    headers.set(HTTP_HEADER_DOMAIN, this.product.apiDomain || credential.domain || '')
    headers.set(HTTP_HEADER_PRODUCT_CODE, this.product.productCode)
    // 用量归属头族：后台「使用端」列按这组头归因，缺任一个都会显示为 `-`。
    // 注意 X-Product 是**归属名**（产品名），不是部署类型 —— 历史实现发成
    // `SaaS` 导致后台归因不到产品。
    headers.set('X-Agent-Purpose', 'conversation')
    // ⚠️ `X-Conversation-*` 三头 —— **准入必要性**在**多数账号**上已被实测证伪，
    // 但在**特定账号**上是**真的**（2026-10-16；后者见 IKM7SG）。
    //
    // ## 背景（真实报障 issue IKM73W）
    // workbuddy 渠道曾**整条不可用**，每轮报
    // `workbuddy: 请求被拦截，请重新发送 conversation id missing`（INVALID_REQUEST）。
    // 上游原始报文（HTTP 400）：
    // ```json
    // {"code":11128,"msg":"conversation id missing",
    //  "displayMsg":{"zh":"请求被拦截，请重新发送"},
    //  "displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"}}
    // ```
    //
    // ## ⚠️⚠️ 本注释的两版结论**都不完整** —— 真相是「**按账号**」（IKM7SG）
    //
    // - **第一版**（原注释）：「三头必须同时存在，缺任一即 400/11128」——
    //   这是在**单账号**上验证后推广到全局，属**过度概括**；
    // - **第二版**（此前改正过的）：「三头**不是**准入必需」—— 维护者约 90 次
    //   真机复测得出，方向对，但**同样是全局断言**。
    //
    // **2026-10-16 IKM7SG 用本仓库自己的 e2e（`pnpm test:e2e:buddy-conv`）、
    // 只换 `WB_REF`，把边界定位到了「账号」这个控制变量**：
    //
    // | `WB_REF` | 基线（全头） | 删任一枚 | 三枚全删 |
    // |---|---|---|---|
    // | `D87606B1`（IKM7SG） | ✅ 200 | ✅ 200 | ✅ 200 |
    // | **`66E05E7C`（IKM7SG）** | ✅ 200 | ❌ **400/11128** | ❌ **400/11128** |
    // | 3 个 workbuddy 账号（2026-10-17 复验） | ✅ 200 | ✅ 200 | ✅ 200 |
    // | **另 2 个 workbuddy 账号（2026-10-17 复验）** | ✅ 200 | ❌ **400/11128** | ❌ **400/11128** |
    //
    // ⇒ **下面那张 14/14 消融表与 IKM7SG 的分叉表都对，差的是账号。**
    //    准确表述是：**「在多数账号上不是；在特定账号上是」**（2026-10-17 复验为 3/5 与 2/5）。
    //    ⚠️ 下表的结果**只在参与实验的那个账号上成立** —— 别再加「全局」二字。
    // ⚠️⚠️ **2026-10-17 复验的重大修正**：这些被拒格子的 `msg` 实测是
    // **`request illegal`**，不是 `conversation id missing`（后者本机零命中）。
    //   而 `request illegal` **与 11140 共用** ⇒ 本档与 `isContentRejection`
    //   必须**同时**按 `code` 精确值收窄，详见 `isChannelVerificationRejection`。
    //
    // | 实验 | 规模 | 结果（**在参与实验的那个账号上**） |
    // |---|---|---|
    // | 适配器 A/B（剥三头 vs 带三头） | 5 模型 × 各 5 次 | 剥三头 **15/15 成功**，两组**完全一致** |
    // | **逐枚消融 14 枚头** | 每枚单独删一次 | **14/14 全部仍 200**（含这三枚） |
    // | 裸 fetch 头形态矩阵 | 5 种头形态 × 2 种 system × 3 次 | 干净 system **全 200**；带指纹 system **全 400** ⇒ **变量是 system，不是头** |
    // | 真模型线 × 请求形状 | 6 模型 × 4 形状 = 48 格 | 三头与响应状态**零关联** |
    // | 逐级剥头阶梯（连 UA/鉴权/身份头都删） | 8 级 | **全 200** |
    //
    // ⇒ **在该账号上，同一份请求连鉴权头、身份头、UA 全删掉，上游照样回 200。**
    // `conversation id missing` 这句 msg 在上述全部实验里**零次复现**
    // （同批实测复现了另两句：`first message is not system prompt`、
    // `Illegal API invocation from an unapproved channel` —— 见
    // `src/openai-gateway/tencent-fingerprint.ts` 与 `src/account-probe.ts`）。
    //
    // ## ⚠️ IKM7SG 在「要求三头」那个账号上穷举出的**判据**
    // `X-User-Id` / `X-Session-ID` / `X-Agent-Intent` / `X-Request-Id` / `X-Trace-Id`
    // / `X-Client-Platform` **全 400**（都不是判据）；**仅补一枚** Conv 头仍 400；
    // **三枚同值 / 各自不同 / 填 `abc-123`** 全 200（**不校验值语义、不要求三者一致**）；
    // **三枚填空串** 400；带三头 → 紧接无头 `200→400` ⇒ **逐请求**判定
    //（**非账号封禁、非状态粘性**）；换 system / 换最简 body 仍 400（**内容无关**）。
    // ⇒ 判据 = 「**三枚 Conv 头同时存在且非空**」，**但只对该账号生效**。
    //
    // ⚠️ **为什么只有该账号：IKM7SG 明确未定论。** 唯一可观测差异是那个账号的 token
    // 缺 `name`/`family_name`/`given_name`（1321 vs 1414 字符，即一次未走完整 profile
    // 流程的凭据）—— **n=1、无因果证据、仅作线索**。别据此写断言。
    //
    // ## ⚠️ 本实现**满足**该判据（三条出站路径都发三枚非空头）
    // 主链路（下面三行）、`buddy-growth.ts` 的两条旁路（`conversationHeaders`）、
    // 以及探测路径（复用 `BuddyAdapter.stream()`）**都发三枚非空且同值的头**。
    // ⇒ 对「要求三头」那类账号，本实现本就通得过。
    //
    // ## 上游究竟怎么用这三枚头
    // **回显**。实测三轮连发，回包 `"id"` 的前缀 **3/3 命中**所发的三头值；
    // 另一次把三头填 `abc-123`，上游直接回 `"id":"abc-123"`。
    // ⇒ 上游认得这三枚头，但**至少在那个账号上**只拿它当 **completion id 的种子**
    // 与**准入判据并存**（IKM7SG：既回显种子、又要求三枚齐全）
    // —— 故「从机制上不可能是闸门」这句**对多数账号成立、对那个账号不成立**。
    //
    // ## ⚠️ 为什么保留这三行（理由已按 IKM7SG 更新）
    // 1. **对「要求三头」那类账号是必需的**（IKM7SG 实测：三枚齐全才 200）——
    //    这是**硬需求**，不再是「无害所以留着」。
    // 2. **对多数账号无害**（无三头也 200，两组实测完全一致）。
    // 3. **贴近官方客户端形态**：官方客户端确实带这三枚
    //    （`docs/workbuddy-native-search-research.md` §4.4 有真值表；§4.5 只是
    //    常量名表、不含取值），补上让后台归因与上游行为对齐。
    // 4. **修掉报错文案的误导性**：见下方「⚠️ 触发条件的现状」。
    // ⚠️ 结论：**三条出站路径都必须继续发三枚非空头** —— 删任何一枚都会让
    //    「要求三头」的账号整条渠道不可用（IKM7SG 的 14/14 消融数据**不能**用来
    //    证明「可以删」，那批数据只在**不要求三头**的账号上取得）。
    //
    // ## ⚠️ 触发条件的现状（本条已按 2026-10-17 独立复验重写）
    // 该拒绝的**成因**已定位到字段级：「三枚 Conv 头同时存在且非空」，
    // **但仅对特定账号生效**（IKM7SG；本机复现为 2/5）。
    // - 对**多数账号**：三头非必需，缺了也 200；
    // - 对**特定账号**：三头**必需**，缺任一枚即 400/11128。
    // ⚠️ **为何只有那些账号、生效范围如何演进，IKM7SG 明确未定论**；本轮复验
    // **未获支持**那条「缺 `name` 系列 claim」的线索（本机 5 个账号 claim 键集
    // 完全相同，两个受限账号互不相同）⇒ 别据此写断言。
    // ⚠️⚠️ **报文里的 `msg` 其实是 `request illegal`**（2026-10-17 实测），
    // `conversation id missing` 本机零命中 ⇒ 见文件头 `isChannelVerificationRejection`。
    // 若用户再次看到这类报错：**先取失败报文的 `requestId`**（本档出口已带上它），
    // 并**优先核对「那个账号」**——不要按「内容」方向排查（实测内容无关）。
    //
    // ## ⚠️⚠️ 语义：三头是**逐请求一次性 id**，不是「会话身份」
    // 本实现的 `conversationId` 在**每次 `send()` 调用时新生成**
    // （`send()` 当前有 **6** 个调用点，含换号重试与饱和退避重试；2026-10-18 审计
    //   实测原注释写「5 个」已漂移，结论「逐请求新值」不受影响）⇒ **零轮稳定性**。
    // 官方真值对照（§4.4）：
    // | 头 | 官方取值 | 本实现 | 是否对齐 |
    // |---|---|---|---|
    // | `X-Conversation-ID` | `context.id`（**会话稳定**） | 逐请求新 UUID | ❌ **语义相反** |
    // | `X-Conversation-Request-ID` | `context.conversationRequestId \|\| ""`（**官方默认空串**） | 逐请求新 UUID | ❌ 不一致 |
    // | `X-Conversation-Message-ID` | 32 位无横线 uuid（**逐消息**） | 逐请求新 UUID | ✅ 同型 |
    // 只有 Message-ID 对得上。**一个每轮都变的值在语义上不是会话身份** ——
    // 原注释那句「混用会把缓存分桶与会话身份绑死」因此不成立（复用 `sessionId`
    // 绑死的其实是「缓存分桶」与「一次性 id」，同样是两件事，但轻重不同）。
    // ⚠️ 实测上游**不做**跨轮状态机（同一 `prompt_cache_key` 连发三轮、每轮换
    // 三头值，上游 3/3 接受），故当前**无害**；若上游将来按 conversation id 做
    // 跨轮归并，本实现会让每轮成为新会话。真要对齐官方需另派生会话级常量。
    //
    // ## ⚠️ 刻意不复用 `this.sessionId`
    // 那是 `prompt_cache_key` 的语义（**前缀缓存的分桶键**）。本仓库登记过多次
    // 「两处语义不同的东西共用一个值」导致的漂移缺陷，故分开。
    // ⚠️ `sessionId` 的作用域（本仓**代码可证**的部分）：`this.sessionId =
    // options.sessionId ?? crypto.randomUUID()...` 在**构造器**里赋值，而
    // `registerBuddyLlm` 在 `index.ts` 的 `apply()` 内**每个产品造一个 adapter**
    // ⇒ 它是**每产品一个值、该产品的所有会话与账号共用**，既不是每轮也不是每会话。
    // ⚠️ **另有一条路径**：`index.ts` 的 `probeById.createProbeAdapter` **每次探测
    // 另建一个 adapter** ⇒ 探测路径的 `sessionId` 是每次新的（同样非每轮）。
    // ⚠️ 刻意**不断言**它「是插件进程级」—— 宿主何时重建插件实例，本仓无任何
    // 证据，属推断，不写成断言句。
    //
    // ## ⚠️ 刻意不按 `product.id` 分支
    // buddy（CodeBuddy 中国站）带上这三头实测**仍 200**（2026-10-16 复核），
    // 即无害。加分支会制造两条出站路径，而两者在本项上并无真实差异 ——
    // 未来只改一条就会静默漂移。
    //
    // ## 两条旁路（`src/buddy-growth.ts`）也打同一端点
    // 原注释称「`buddy-growth.ts` 早已携带 `X-Conversation-ID` ⇒ 属补一致性缺口」，
    // 这条论证**已撤回**（它恰恰是「一枚就够」的反证）。
    // 现状（2026-10-16 起）：两条旁路已同步补齐三枚，**理由按 IKM7SG 更新为
    // 「对『要求三头』的账号是硬需求 + 与主链路形态一致」**（不再是「反正无害」）
    // —— 与本处同源，见该文件内的对应注释。
    const conversationId = crypto.randomUUID().replace(/-/g, '')
    headers.set('X-Conversation-ID', conversationId)
    headers.set('X-Conversation-Request-ID', conversationId)
    headers.set('X-Conversation-Message-ID', conversationId)
    headers.set('X-IDE-Name', this.product.attributionName)
    headers.set('X-IDE-Type', this.product.attributionName)
    headers.set('X-IDE-Version', this.product.clientVersion)
    headers.set(HTTP_HEADER_PRODUCT, this.product.attributionName)
    // User-Agent 按模型族分档：不同模型线归属不同客户端形态，后台据此分列。
    // 必须用 set 覆盖（attributionHeaders() 注入的框架 UA 键为小写，
    // 但 Headers 键大小写不敏感，set 能正常覆盖）。
    headers.set('User-Agent', resolveUserAgent(this.product, options.model))
    try {
      return await this.fetchImpl(`${this.product.endpoint}/v2/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`${this.product.id}: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }

  /**
   * 消费 SSE 响应并产出 StreamChunk。
   *
   * CodeBuddy 返回标准 OpenAI SSE：`delta.content` 为正文、
   * `delta.reasoning_content` 为思考、`delta.tool_calls` 为工具调用。
   * 流式工具调用仅首个分片携带真实 id（chatcmpl-tool-xxx），后续参数分片
   * 只有 index——按 index 缓存 id 保证同一工具的所有分片 id 一致。
   */
  private async *consumeSse(
    response: Response,
    options: GenerateOptions,
    /**
     * 本次请求实际使用的账号 id（`''` 表示凭据没匹配到池条目）。
     *
     * 只用于流内安全策略拦截的冷却标记 —— 见 {@link isContentRejection}。
     */
    policyBlockedAccountId: string,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError(`${this.product.id}: empty model response body`, 'EMPTY_RESPONSE')

    const blocks: Array<{ index: number; kind: 'text' | 'reasoning'; text: string }> = []
    let nextIndex = 0
    /**
     * 思考死循环检测（见 `createReasoningLoopDetector`）。命中后丢弃后续
     * reasoning 增量，收尾时发截断后的 block，并让 finish 报 max-tokens。
     *
     * 本路径正是用户实际报障的那条（`workbuddy/deepseek-v4.1-flash` 报
     * 「已达到输出 token 上限」）：`reasoning_tokens` 计入 `completion_tokens`，
     * 思考陷入病态重复就把 128000 额度烧光、正文零产出。
     */
    const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
    let loopDetected = false
    /**
     * **正文**死循环检测（**独立实例**）。本路径正是用户实际报障的那条
     * （`lilishop-go` 会话 / `workbuddy/hy4-preview-f`）：该模型把思考写进
     * `content` 通道，正文出现真循环（去重率 0.0412），而旧实现只在
     * reasoning 分支调 `observe` → 正文循环**完全看不见**。
     *
     * ⚠️ 必须与 `loopGuard` **分成两个实例**：判据看的是尾部 3000 字符窗口的
     * 行去重率，两条通道混进同一窗口会互相稀释，使守卫**双双失效**。
     *
     * ⚠️ 与思考守卫的**语义差异**：实测正文循环的 wire 顺序恒为
     * `text-chunks(循环) → tool-call-chunks → finish: tool-calls` —— 工具调用
     * 在循环正文**之后**到达且有效。故正文守卫**只截断文本**，
     * **绝不 `reader.cancel()`、绝不改 finish reason**，否则会把有效调用
     * 整块丢掉（比循环本身更糟）。
     */
    const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
    /**
     * DSML 标记归一化器（见 sse.ts `createDsmlMarkerNormalizer`）。
     * ⚠️ **每个 `stream()` 调用一个实例**：待定缓冲是跨帧状态，共用会串流。
     */
    const dsmlFix = createDsmlMarkerNormalizer()
    let proseLoopDetected = false
    // ⚠️ 此处**曾有** `proseHasThinkTag` 门禁变量，2026-09-27 **删除**。
    // 它逐帧匹配标签来决定收尾是否切分，而标签**必然跨帧**（上游可切成任意片段），
    // 实测二分帧时 7/11 种切法漏判 → 标签落盘泄漏。现改为收尾**无条件**调用
    // `splitThinkTaggedContent`（无标签时返回 undefined，普通响应逐字节不变）。
    /**
     * 纯空白思考抑制器（见 `createBlankReasoningSuppressor`）。与 `blocks` /
     * `loopGuard` 同生命周期：**每个 `stream()` 调用建一个实例**。
     *
     * 为什么必须延后建块：`BlockAssembler` 在**没有 `block-end`** 时同样会用
     * `partial.text` 组装出块，故只在出口过滤挡不住空 Think 块 —— 必须从一开始
     * 就不发任何 chunk。本路径正是用户实际报障的那条
     * （`workbuddy/deepseek-v4.1-flash` 偶发只输出一个空格当思考，
     * 实测 2233 次、`usage.reasoningTokens = 1`）。
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
    // tool_call index → 后端签发的真实 id。缺失时回退 call_{index}，
    // 保证 Start/Delta 使用同一 id。
    const toolIds = new Map<number, string>()
    let buffer = ''
    let streamEnded = false
    let finishReason: 'stop' | 'tool_calls' | 'length' | undefined
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // 首 token 与 chunk 间超时分阶段使用：第一次读取用 firstTokenTimeout，
    // 收到首 chunk 后切换为 chunkTimeout 并在每次成功读取后重置。没有这层
    // 保护时，半开的 SSE 连接会让 read() 永久挂起，会话卡死在"运行中"。
    let firstTokenReceived = false

    try {
      for (;;) {
        if (streamEnded) break
        let result
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs()
          const phase = firstTokenReceived ? 'chunk' : 'first-token'
          result = await readWithIdleTimeout(reader, timeoutMs, 'buddy', options.signal, phase)
          if (!result.done) firstTokenReceived = true
        } catch (error) {
          if (options.signal?.aborted) throw error
          if (error instanceof LlmError) throw error
          if (isTransportError(error)) {
            throw new LlmError(`${this.product.id}: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
          }
          throw error
        }
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            streamEnded = true
            break
          }
          let data: {
            error?: { message?: string }
            choices?: Array<{
              delta?: {
                content?: string
                reasoning_content?: string
                tool_calls?: Array<{
                  index?: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string
            }>
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              /** 缓存命中的 prompt token 数（与 prompt_cache_hit_tokens 同值）。 */
              prompt_tokens_details?: {
                cached_tokens?: number
                cache_write_tokens?: number
              }
              completion_tokens_details?: { reasoning_tokens?: number }
              prompt_cache_hit_tokens?: number
              prompt_cache_miss_tokens?: number
              /** 费用权重（非 token 数）。 */
              credit?: number
            }
          }
          try {
            data = JSON.parse(payload)
          } catch {
            continue
          }
          // ⚠️ **流内**的安全策略拦截（HTTP 200 + SSE 内嵌 11140 帧）。
          //
          // ## 原状：整帧被**静默丢掉**
          //
          // 下面的帧类型里**根本没有** `code` / `msg` 字段（只有 `error` /
          // `choices` / `usage`），而这类报文恰好是**顶层** `{code,msg,displayMsg}`、
          // 没有 `error`、没有 `choices` —— 于是它一路走到循环末尾，既没内容也没报错，
          // UI 表现成「干净地停止、无任何失败」（与 qoder 的 10605、TRAE 的流内错误
          // 同型；`isContentRejection` 的注释也记着「同一报文在 CodeArts 侧就以
          // HTTP 200 + 内嵌错误帧的形式出现」）。
          //
          // ## 判据必须**窄**：只认「没有 choices 的帧」
          //
          // 正文里出现「安全审核」「request illegal」甚至字面 `11140` 都是常态
          // （模型在讨论审核策略时就会说这几个词），而**有效内容帧一定带 choices**；
          // 加上这一层门禁，才不会因为一句正文把整个回答误判成拦截。
          // 复用 `isContentRejection(payload)` 而非另写一套：与 HTTP 层**同一判据**，
          // 两处各写一套正是 trae 那次缺陷的成因。
          if (data.choices === undefined && isContentRejection(payload)) {
            // 按定下的口径：**标记 + 如实报错**，本轮不重发（流内重发需要
            // 「尚未产出内容」的判据 + 外层循环，是 trae 3823133 那种结构改造）。
            // 账号标了冷却，下一轮选号就会绕开它，不再反复重撞。
            await markPolicyBlockedAccount(
              this.options.accountPool, this.product.id, policyBlockedAccountId, options.model,
            )
            throw contentRejectionError(this.product.id, 200, payload, false)
          }
          // ⚠️⚠️ **流内的「渠道校验」拒绝**（HTTP 200 + SSE 内嵌 11128
          // `conversation id missing` 帧）—— 与上面 11140 那条**并列**，
          // 同样受 `choices === undefined` 门禁保护（有效内容帧一定带 choices，
          // 故不会把讨论该措辞的正文误判成拒绝）。
          //
          // ## 真实缺陷（本档第一版漏掉了这条通道，2026-10-16 审计实测）
          //
          // `isContentRejection` 的注释早就记着「同一报文在 CodeArts 侧就以
          // HTTP 200 + 内嵌错误帧的形式出现」，而第一版只改了 HTTP 通道 ⇒
          // 该形态下：① **不换号**（`consumeSse` 里根本没有这条判据）；
          // ② 帧既无 `choices` 也无 `error` ⇒ 一路走到收尾 ⇒ 零内容块 ⇒
          // 被 `resolveEmptyResponseReason` 改写成 `EMPTY_RESPONSE`；
          // ③ 而 `EMPTY_RESPONSE` **在** harness 的 `DEFAULT_RETRYABLE_CODES`
          // 里（`retry-policy.js`，`DEFAULT_MAX_RETRIES = 5`）⇒ **白退避重试
          // 至多 5 次**，每次重撞同一个被拒账号，且用户看到的是
          // 「模型没返回内容」—— 原因完全错位。
          //
          // 实测（修复前）：`sent=["AT1"]`、下发 `finish(error)` 帧、
          // code `EMPTY_RESPONSE`。
          //
          // ## 处置：与 11140 流内档同型 —— **不重发**，但口径必须正确
          //
          // 流内重发需要「尚未产出内容」的判据 + 外层循环（trae 3823133 那种
          // 结构改造），故这里只做两件事：**如实报错** + 归到不在可重试集合的码。
          // ⇒ `rotated: false`（只撞到当前账号，不能说「已逐个换号重试」）。
          // ⚠️ 与 11140 的差异：**不写冷却**（理由见 `isChannelVerificationRejection`
          // —— 写 30 分钟账号级冷却会把一份「换请求形态就能用」的账号凭空封禁）。
          // ⚠️ 必须传 `response.status`（流内通道恒为 200）：腿② 的状态码闸门因此
          // 不在此通道启用，而腿①（`msg`/`message` 值位）**照常生效** —— 真实的
          // 流内 11128 错误帧就是 `{"code":11128,"msg":"conversation id missing"}`，
          // 走腿①。反过来，一个**正常 200 报文**里若恰好出现该措辞（模型复述等），
          // 闸门正好挡住腿②的误命中。
          if (data.choices === undefined
            && isChannelVerificationRejection(payload, response.status)) {
            throw channelVerificationError(this.product.id, 200, payload, false)
          }
          if (data.error !== undefined) {
            throw new LlmError(`${this.product.id}: ${data.error.message ?? 'unknown error'}`, 'SERVER')
          }
          const choice = data.choices?.[0]
          const delta = choice?.delta
          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length'
          }
          if (delta?.content) {
            let block = blocks.find(candidate => candidate.kind === 'text')
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'text', text: '' }
              blocks.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'text' }
            }
            // 正文死循环守卫（见 `proseLoopGuard` 注释）。
            //
            // ⚠️ 命中后**只停止累积与发射**，绝不 `reader.cancel()`、绝不改
            // finish reason —— 工具调用在循环正文之后到达且有效（实测）。
            // 截断靠收尾的 `block-end` 权威覆盖落地（见文件末尾 text 段）。
            if (proseLoopGuard !== undefined) {
              if (proseLoopGuard.observe(delta.content)) proseLoopDetected = true
            }
            // ⚠️ **不要在这里逐帧探测 think 标签**（2026-09-27 移除）。
            // 逐帧探测在跨帧时必然漏判（标签可被切成任意片段，实测二分帧时
            // 7/11 种切法漏判）→ 收尾不切分 → 标签落盘泄漏。
            // 现改为收尾**无条件**调用 `splitThinkTaggedContent`
            // （无标签时返回 undefined，普通响应逐字节不变）。
            if (!proseLoopDetected) {
              // ⚠️ **先归一化再累积**（2026-10-13）：step-5-preview 实测把
              //    `<｜DSML｜invoke…>` 写坏成 `<｜｜DSML｜｜`（全角双竖线，
              //    分词器保真度问题）⇒ 宿主解析器不认，工具调用整段当正文，
              //    模型「停住不动」。push() 流式安全（跨帧由待定缓冲拼齐，
              //    与 openai-compat.ts 的 consumeOpenAiSse 同款）。
              const fixedDelta = dsmlFix.push(delta.content)
              block.text += fixedDelta
              if (fixedDelta.length > 0) {
                yield { type: 'text-delta', index: block.index, text: fixedDelta }
              }
            }
          }
          if (delta?.reasoning_content) {
            // 死循环守卫：命中后不再累积、不再发射。
            //
            // ⚠️ 这里**只跳过发射**：真正的止损（`reader.cancel()` + `break`）在
            // 本 chunk 的行循环**全部处理完之后**、外层 `for (;;)` 末尾执行（见下方
            // ★ 止损块）—— 这样同一 chunk 里已到达的 usage / [DONE] 仍会被处理。
            //
            // ⚠️ 也**不能用 `continue`**（Task 2 审查发现，已独立复现）：它会
            // 连带跳过本帧位于 reasoning 分支**之后**的 `usage` 与 `tool_calls`
            // —— 「reasoning + usage 同帧」时 usage 被静默丢弃（token 记账
            // 缺失）。故用 `if (!loopDetected)` 守卫分支体。
            if (loopGuard !== undefined) {
              if (loopGuard.observe(delta.reasoning_content)) loopDetected = true
            }
            if (!loopDetected) {
              // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发，
              // 于是既不建块、也不消耗 `nextIndex`（见 helper 注释）。
              const emit = suppressor.feed(delta.reasoning_content)
              if (emit !== undefined) {
                let block = blocks.find(candidate => candidate.kind === 'reasoning')
                if (block === undefined) {
                  block = { index: nextIndex++, kind: 'reasoning', text: '' }
                  blocks.push(block)
                  yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
                }
                // ⚠️ **整块回写**（赋值，不是 `+=`）：helper 内部已累积全部文本。
                block.text = suppressor.text()
                yield { type: 'reasoning-delta', index: block.index, text: emit }
              }
            }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0
            if (typeof call.id === 'string' && call.id.length > 0) {
              toolIds.set(wireIndex, call.id)
            }
            const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`
            let block = toolCalls.get(wireIndex)
            if (block === undefined) {
              block = { index: nextIndex++, text: '', callId, announced: false }
              toolCalls.set(wireIndex, block)
            }
            block.callId = callId
            // 后续参数分片会带上空的 function.name（""），它不是 undefined，
            // 直接覆盖会把首个分片解析出的真实工具名清空，导致
            // `unknown tool ""`。只有非空名字才允许更新。
            if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
              block.name = call.function.name
            }
            const fragment = call.function?.arguments ?? ''
            block.text += fragment
            // ⚠️ **名称为空前不发射任何 chunk**（与 `openai-compat.ts` 同因同修，
            // 见该文件内的详细说明）。只跳过收尾的 `block-end` 不够 ——
            // `BlockAssembler` 会把没有 block-end 的 partial 也组装成
            // `name:''`，污染会话后让 workbuddy 以 400 code 11133 拒绝每次请求。
            if (!block.announced) {
              if (!hasUsableToolName(block.name)) continue
              block.announced = true
              toolOrder.push(block.index)
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
          if (data.usage) {
            const promptTokens = data.usage.prompt_tokens ?? 0
            // 后端在六处回传缓存信息，其中 cached_tokens 同时出现在
            // prompt_tokens_details 与 completion_tokens_details 里，但后者
            // **恒为 0**（实测）——只认 prompt_tokens_details，误取会永远读到 0。
            const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens
              ?? data.usage.prompt_cache_hit_tokens
              ?? 0
            const cacheWriteTokens = data.usage.prompt_tokens_details?.cache_write_tokens
            const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens
            yield {
              type: 'usage',
              usage: {
                // 与 codearts 一致：inputTokens 只计**未命中缓存**的部分，
                // 命中部分单列 cacheReadTokens，否则缓存命中率显示会偏大。
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
                ...cacheWriteTokens !== undefined && cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
                ...reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {},
              },
            }
          }
        }
        // ★ 止损（终审 C1）：命中死循环后**中止上游**，否则 128000 token 照烧。
        // 原实现只跳过下行累积/发射，`for (;;)` 仍把流读到底 —— 实测上游
        // 200 帧被读 200 帧（守卫在 ~2304 字符即命中，99.5% 的额度仍被消耗）。
        //
        // ⚠️ 位置：内层行循环**之后**、外层 `for (;;)` 末尾 —— 同一 chunk 里已到达
        // 的 `usage` / `[DONE]` 因此仍会被处理，但命中后**立即**退出，不再读下一块。
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

    /**
     * 本次响应**实际会发出的 `block-end` 数量**（＝真正落进 assistant 消息的块数）。
     *
     * ⚠️ **不能写成 `blocks.length`**：`blocks` 里可能留着**不会发出**的条目 ——
     * 纯空白思考块（已被 `suppressor` 压制，连 `block-start` 都没发）、
     * 或被清洗成空串的块。用 `blocks.length` 会把「零块响应」误判成「有块」，
     * 于是静默结束的缺陷原样保留。
     *
     * 故此处**在每个 `block-end` 的发射点自增**，与下面三段发射逻辑逐条对齐。
     */
    let blockCount = 0
    /**
     * 本步**最终发出的正文**（`block-end` 的权威文本），供 finish 归类判定
     * 「是否被上游停止串截断」（见 `isProseTruncatedByStopString`）。
     */
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
          // 仅把"无参数工具下发的空分片"补成 {}；**残缺参数保持原样**，
          // 由 max-tokens 判定触发重试。切勿把残缺 JSON 也补成 {}——那会
          // 伪造出合法外观，让 harness 报 `missing required property` 而
          // 非重试，掩盖真正的分片丢失。
          arguments: isTruncatedArguments(block.text)
            ? block.text
            : normalizeToolArguments(block.text),
        },
      }
    }
    // ── DSML 归一化收尾：下发待定缓冲 ──（与 openai-compat.ts 同款）
    // 扣住的尾部在流结束时必须放行，block-end 才能带上它。
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
      // 正文死循环截断：只保留循环前的干净前缀（与思考守卫同一覆盖机制）。
      // ⚠️ **不改 finish reason**：工具调用仍要被执行。
      const truncated = proseLoopDetected && proseLoopGuard?.cutAt !== undefined
        ? textOut.slice(0, proseLoopGuard.cutAt)
        : textOut
      // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
      const cleaned = stripCourseLeakIfEnabled(truncated)
      // ⚠️ DSML 归一化**整串兜底**（幂等，与 openai-compat.ts 同款）：增量路径
      //    已逐帧修过，这里再过一遍防御跨缓冲边界漏网；block-end 是权威覆盖，
      //    发的必须是归一化后的文本，否则会把增量修好的又改回去。
      const dsmlCleaned = fixDsmlMarkers(cleaned)
      // ⚠️ 归位后正文可能为空串（实测 seq=34768 形态）—— 空块会污染会话，
      // 且 DSH 的 `EMPTY_RESPONSE` 契约禁止产出空内容块。思考段已归位，
      // 故本响应仍有产出，不会被误判为零块。
      if (dsmlCleaned !== '') {
        blockCount += 1
        emittedProse = dsmlCleaned
        yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: dsmlCleaned } }
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
    // 三种"不完整"都必须报告 max-tokens 而非 tool-calls，否则 harness 会
    // 执行残缺调用、报 INVALID_ARGS，并把脏参数持久化进会话历史：
    // - 'length'：模型输出被 max_tokens 显式截断；
    // - 未收到 finish_reason：连接被中途掐断，参数必然是半截 JSON；
    // - 参数分片丢失：后端并行下发多个工具调用时偶发丢分片（实测
    //   session-23851745 turn1 step4，两个并行 `read` 都丢了 `{"file_path": "…`
    //   前缀）。此时报告 tool-calls 会让 harness 执行缺参调用，报
    //   `missing required property "file_path"`，模型收到莫名其妙的参数错误
    //   并陷入重试循环。判定为截断后 dsh 丢弃残缺调用并重试，实测一次即恢复。
    const argsTruncated = [...toolCalls.values()].some(block => isTruncatedArguments(block.text))
    /**
     * 是否丢弃过**名称不可用**的 tool-call 块（见上方 tool_calls 分支）。
     *
     * 丢弃是对的（无名调用无法执行、留着会污染会话），但不能让它**静默地以
     * `stop` 结束** —— 那正是 AGENTS.md 记录的「没有任何报错就中断」：
     * 模型本意要调工具，harness 却认为它「正常答完了」。故报 max-tokens
     * （不完整、可重试）。同批若还有可用调用，则照常报 tool-calls。
     */
    const droppedUnnamedCalls = [...toolCalls.values()].some(block => !block.announced)
    /**
     * 正文是否被**上游停止串**掐断（见 `isProseTruncatedByStopString`）。
     *
     * 上游把 `</think>` 当停止串：模型在正文里写它（哪怕包在反引号里）就会被
     * 掐断，但仍报 `finish_reason:"stop"` —— 我们据此判「正常答完」会让本轮
     * **没有任何报错就停住**。判据三条同时成立：上游报 `stop`、本步无可用工具
     * 调用、正文止于未闭合的行内代码。
     */
    const proseCutByStopString = finishReason === 'stop'
      && toolOrder.length === 0
      && isProseTruncatedByStopString(emittedProse)
    /**
     * 思考死循环是否**是唯一的产出**（无正文、无工具调用）。
     *
     * ⚠️ 这层门禁**不可省** —— 用户要求（Gitee !IKIZNK）：「**如果只是**陷入
     * 思考循环的出错，就要给出有分辨力的错误提示」。只有该步没有任何可见产出时
     * 才报 `error`：`error` 路径**不落 `assistant/message`**（实测 219 会话里
     * 222 例），有正文/工具调用时报它会把用户可见内容整块丢掉。
     * 实测守卫命中的 25 例**全部**只有思考，故正常路径都走 error。
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
      : finishReason === 'length'
        || finishReason === undefined && toolOrder.length > 0
        || argsTruncated
        || proseCutByStopString
        || droppedUnnamedCalls && toolOrder.length === 0
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

/** 凭据是否已过期；无法解析过期时间时不判定过期（与 Rust is_expired 一致）。 */
function isCredentialExpired(credential: BuddyCredential): boolean {
  const expiresAt = credentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

/**
 * 生成模型选择器里显示的名字，承载**两类**信息：计费倍率与同名消歧。
 *
 * ⚠️ **必须写进 `name` 而不是 `description`**：composer 的模型切换菜单只渲染
 * `name`（见 ModelSelect 的 `children: model.name`），`description` 仅用于
 * `/model` 弹窗。用户报障「消耗倍率没有显示在切换模型列表的后面」正是因为
 * 早期版本放在了 `description`。
 *
 * 安全性：`name` **纯属展示** —— DSH 的选择与持久化只用 `id`
 * （见 `selectionOf` 返回 `model: model.id`），故在名字里附加价格不会污染会话。
 *
 * 形如 `Deepseek-V4.1-Flash · x0.03`；有促销时 `· x0.17→x0.50`（用箭头而
 * 不是「（促销 …）」，避免在窄菜单里过长）。同名撞车时再加变体标记。
 */
function displayNameFor(model: BuddyRemoteModel, all: readonly BuddyRemoteModel[]): string {
  const suffix = displaySuffix(model, all)
  return suffix.length > 0 ? `${model.name} · ${suffix}` : model.name
}

/** 组装展示名的后缀部分：倍率 + 同名变体标记。 */
function displaySuffix(model: BuddyRemoteModel, all: readonly BuddyRemoteModel[]): string {
  const parts: string[] = []
  // 倍率：有促销时用 `原价→促销价` 一眼看出折扣幅度。
  const rate = formatCreditsRate(model.creditsRate, model.discountedCreditsRate)
  if (rate !== undefined) parts.push(rate)
  // 同名消歧：只在**确实撞车**时追加，避免影响其它模型。
  const variant = variantLabelFor(model, all)
  if (variant.length > 0) parts.push(variant)
  return parts.join(' ')
}

/**
 * 判断该模型是否需要变体标记，需要时返回标记文本。
 *
 * 远端会给**不同 id 配同一个 name**（实测 `deepseek-v4.1-flash` /
 * `deepseek-v4.1-flash-sg` 都是 "Deepseek-V4.1-Flash"；`hy3`/`hy3-x` 都是
 * "Hy3"），而选择器按 name 展示 → 出现无法区分的重复条目。
 *
 * 用**公共前缀**切分而非硬编码 `-sg`：撞车组随服务端上新变化（本次实测三组
 * 里只有一组带 `-sg`）；也不用「取 id 最后一段」（会把 `gpt-5.6-sol` 的
 * `sol` 当变体）。公共前缀只在撞车时才计算，不影响其它模型。
 */
function variantLabelFor(model: BuddyRemoteModel, all: readonly BuddyRemoteModel[]): string {
  const group = all.filter((candidate) => candidate.name === model.name)
  if (group.length <= 1) return ''
  const prefix = commonPrefix(group.map((candidate) => candidate.id))
  const variant = model.id.slice(prefix.length).replace(/^-+/, '')
  return variant.toUpperCase()
}

/** 求一组字符串的公共前缀（逐字符比较）。 */
function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0]!
  for (const value of values.slice(1)) {
    let i = 0
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++
    prefix = prefix.slice(0, i)
    if (prefix.length === 0) break
  }
  return prefix
}

/**
 * 把候选输出上限规整为「可安全下发的正整数」，否则返回 undefined。
 *
 * 为什么必须过滤：DSH 的 `LlmRuntime.resolveModelInfoFor` 对适配器声明的
 * `defaultMaxTokens` 有硬校验 —— 非安全整数或 ≤0 会直接抛
 * `adapter returned invalid default maxTokens`（INVALID_MODEL_MAX_TOKENS），
 * 整轮对话起不来。远端是外部输入，`0` / 负数 / `NaN` 都可能出现，
 * 不能在适配器里假设它合法。
 */
function positiveMaxTokens(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * 在 ctx.llm 上注册 CodeBuddy 系产品的 provider 路由与适配器。
 *
 * 路由名与展示名由产品配置驱动：CodeBuddy 得到 `buddy`，WorkBuddy 得到 `workbuddy`。
 *
 * ⚠️ 刻意**不**调用 `ctx.llm.registerConfigurableProviders`（即不向「设置 → 模型 →
 * 提供商」声明配置行）：账号、模型开关与模型目录都由 Jet Hub 设置页管理，声明只会
 * 在该页留下无人使用的行。原因、依据与恢复方式见 `llm-register-compat.ts` 模块头。
 */
export function registerBuddyLlm(ctx: Context, options: BuddyAdapterOptions): BuddyAdapter {
  const product = options.product ?? CODEBUDDY
  const adapter = new BuddyAdapter({
    ...options,
    // ⚠️ 注入**唯一**的广播实现（`src/catalog-broadcast.ts`），不要在这里
    // 另写一份 emit —— 两份实现必然漂移（issue IKJVTF 的缺陷① 就是「十处全漏」）。
    onCatalogLoaded: () => broadcastCatalogChanged(ctx),
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  // 返回实例：Jet Hub「显示列表」需要 `listAllModels()`（不受黑名单影响、
  // 带最终展示名/倍率）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
  return adapter
}

// ─────────────────────── 原生搜索（`searchOnce` 的支撑） ───────────────────────
//
// ⚠️ 这些是从 `web-native.ts` 搬过来的（2026-10-14 架构改造）。搬家的理由见
// `BuddyAdapter.searchOnce` 的注释：取数逻辑各渠道不同（腾讯 `Bearer` + `results[]`、
// Qoder WASM 签名 + `pageItems[].link`），故下沉到适配器；`web-native.ts` 只留
// 「官方语义」（入参校验 / 并发中止 / rank 轮转合并 / cap）。

/**
 * 单次搜索请求的 `max_results`。
 *
 * ⚠️ **写死 8**：与官方 `WEB_SEARCH_MAX_RESULTS = 8` 一致，且**实测就是上游上限**
 * —— 1/3/5/8 原样返回、>8 一律封顶 8（见 `docs/workbuddy-native-search-research.md` §6.5）。
 */
const NATIVE_SEARCH_MAX_RESULTS = 8

/**
 * 执行一次腾讯原生搜索（**模块级导出**，供单测直接驱动）。
 *
 * ⚠️ 之所以抽成独立函数而不是全塞在 `BuddyAdapter.searchOnce` 里：单测要用
 * 真 `product` 配置（端点前缀随产品变）驱动它，而构造一个完整 `BuddyAdapter`
 * 需要 `AccountPool` 等重依赖。抽出来后测试可以直接传 `CODEBUDDY` / `WORKBUDDY`。
 *
 * @param query - 单个查询串。
 * @param credential - 凭据（本函数自己收窄成 `BuddyCredential`）。
 * @param signal - 取消信号。
 * @param product - 产品配置（决定 `{endpoint}/agenttool/v1/search` 的前缀与错误文案里的 id）。
 * @throws {WebNativeError} 无可用账号 / 上游非 2xx / 响应无法解析 / 超时。
 */
export async function performBuddySearch(
  query: string,
  credential: unknown,
  signal: AbortSignal,
  product: BuddyProduct,
): Promise<NativeSource[]> {
  const accessToken = typeof (credential as BuddyCredential | undefined)?.access_token === 'string'
    ? (credential as BuddyCredential).access_token
    : ''
  if (accessToken.length === 0) {
    throw new WebNativeError(
      `${product.id} search has no usable account; sign in to a ${product.id} account `
      + `from the Jet Hub panel first. The current route is "${product.id}". `
      + 'Only the user can change accounts.',
      NativeSearchCodes.noAccount,
    )
  }

  const endpoint = `${product.endpoint}/agenttool/v1/search`
  const body = { query, type: 'text2text', max_results: NATIVE_SEARCH_MAX_RESULTS }
  // ⚠️ 响应体先过 `asRecord`：上游返回 JSON `null` 时直接读 `.results` 会抛
  //    `TypeError: Cannot read properties of null`（对抗性审查 F2），
  //    而我们想要的是「响应无法解析」这条业务错误。
  const json = await postBuddySearchJson(endpoint, body, accessToken, product, signal)
  const results = (asRecord(json) as BuddySearchResponse | undefined)?.results
  if (!Array.isArray(results)) {
    throw new WebNativeError(
      `${product.id} returned an unparseable search response: "results" is not an array.\n\n`
      + `The request used endpoint ${JSON.stringify(endpoint)}. `
      + 'Expected { results: [{ title, url, snippet }] }. '
      + 'This usually means the upstream API changed, or the account lacks search permission.',
      NativeSearchCodes.badResponse,
    )
  }

  const sources: NativeSource[] = []
  for (const raw of results) {
    // ⚠️ 必须先挡 `null` / 非对象：`results: [null]` 时读 `item.url` 会抛
    //    `TypeError: Cannot read properties of null`（真实缺陷，对抗性审查 F1）——
    //    那会让**整条工具调用**失败，与本段的意图（畸形条目**丢弃**、少一条而已）相反。
    const item = asRecord(raw)
    if (item === undefined) continue
    const url = typeof item.url === 'string' ? item.url : ''
    // ⚠️ `url` 是官方 schema 的必填项（`additionalProperties: false` + `required`）。
    //    上游给不出 url 的条目直接丢弃，否则 `createSuccessResult` 会抛
    //    `ToolOutputError`（整个工具调用失败，而不是少一条结果）。
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
}

/** 上游 search 请求超时（毫秒）。与客户端 `WEB_SEARCH_TIMEOUT_MS = 2e4` 对齐。 */
const NATIVE_SEARCH_TIMEOUT_MS = 20_000

/** 上游 search 响应的形状（只声明用到的字段；逐项都当作不可信输入处理）。 */
interface BuddySearchResponse {
  results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown } | null | unknown>
}

/**
 * 发一次搜索 POST 并解析 JSON。
 *
 * 错误语义对齐官方：**直接抛**（工具层不包装，由宿主 `toolErrorResult` 统一转
 * `isError`），且文案带排障指引（端点、下一步动作、给模型的约束）。
 */
async function postBuddySearchJson(
  endpoint: string,
  body: unknown,
  accessToken: string,
  product: BuddyProduct,
  signal: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(NATIVE_SEARCH_TIMEOUT_MS)
  const composed = AbortSignal.any([signal, timeout])

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: composed,
    })
  } catch (error) {
    // ⚠️⚠️ **不能先判 `signal.aborted` 就直接归 `aborted`**（PR95 审计修正的
    //    真实缺陷）：本模块在 cordis waterfall 的**内层**，拿到的 `signal` 已被
    //    外层 `tool-call-timeout-policy` 换成带 deadline 的信号 ⇒ 外层到期时
    //    `signal.aborted` 同样为真。旧判据会把**超时**报成「search aborted」
    //    （像是用户按了停止），文案里那串排障指引全部丢失。
    //    归因必须读 `signal.reason` 的形状 —— 判据与实测六格对照见
    //    `native-search-contract.ts` 的 `classifyNativeAbort`。
    const stop = classifyNativeAbort(composed)
    if (stop === 'aborted') {
      throw new WebNativeError(
        `${product.id} search aborted`,
        NativeSearchCodes.aborted,
        { cause: error },
      )
    }
    if (stop === 'timeout') {
      // ⚠️ 文案区分**谁**的预算用尽：本模块自己 arm 的（`timeout.aborted`）
      //    报我们自己的毫秒数；外层 deadline 到期（`timeout.aborted` 为假）
      //    则说明是宿主给的工具预算被吃满，不能再谎称「我们的 20s 预算」。
      const budget = timeout.aborted
        ? `after ${NATIVE_SEARCH_TIMEOUT_MS}ms`
        : 'before this search returned (the host tool budget elapsed)'
      throw new WebNativeError(
        `${product.id} search timed out ${budget}.\n\n`
        + `The request used endpoint ${JSON.stringify(endpoint)}. `
        + 'Web search uses the same account as chat but a separate endpoint. '
        + 'Retry, or narrow the request; if it keeps timing out the endpoint or network may be unreachable.',
        NativeSearchCodes.timeout,
        { cause: error },
      )
    }
    throw new WebNativeError(
      `${product.id} search request failed: ${errorMessage(error)}\n\n`
      + `The request used endpoint ${JSON.stringify(endpoint)}. `
      + 'Web search uses the same account as chat but a separate endpoint. '
      + 'If the network is unreachable or the endpoint is wrong, the user must decide how to proceed.',
      NativeSearchCodes.upstream,
      { cause: error },
    )
  }

  if (!response.ok) {
    const detail = await readBuddyErrorDetail(response)
    throw new WebNativeError(
      `${product.id} search request failed (HTTP ${response.status})${detail}\n\n`
      + `The request used endpoint ${JSON.stringify(endpoint)}. `
      + 'Web search uses the same account as chat but a separate endpoint. '
      + "If the account's sign-in has expired, guide the user to sign in again from the Jet Hub panel; "
      + 'the endpoint does not need changing.',
      NativeSearchCodes.upstream,
    )
  }

  try {
    const json: unknown = await response.json()
    return json
  } catch (error) {
    throw new WebNativeError(
      `${product.id} returned a non-JSON response.\n\n`
      + `The request used endpoint ${JSON.stringify(endpoint)}. `
      + 'Expected a JSON body with { results: [{ title, url, snippet }] }.',
      NativeSearchCodes.badResponse,
      { cause: error },
    )
  }
}

/** 从非 2xx 响应里取一段可读的上游说明（截断，且不回显敏感内容）。 */
async function readBuddyErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    const trimmed = text.trim().slice(0, 300)
    return trimmed.length > 0 ? `: ${trimmed}` : ''
  } catch {
    return ''
  }
}
