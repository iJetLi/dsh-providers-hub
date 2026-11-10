/**
 * Loomy LLM 适配器。
 *
 * ## 协议
 *
 * 实测（2026-09-26）`POST {apiBase}/chat/completions` 是**标准 OpenAI 兼容
 * + 标准 SSE**：`data:` 帧 + 空 `data:` 终止帧，思考在 `delta.reasoning_content`，
 * **无加密、无信封、无格式转换**。与 qoder 同形，故消息序列化与 SSE 消费
 * 直接复用 `src/openai-compat.ts` —— 那是为这种形态抽的共享层，
 * **新增** provider 用它正是其设计意图（AGENTS.md 只禁止拿它去重构
 * buddy/lobsterai 的既有实现）。
 *
 * ⚠️ **认证头与业务端点不同**：chat 端点**只认** `Authorization: Bearer`，
 * 而 `/models`、`/points/*` 只认 `token`。故 `stream()` 用
 * `loomyChatHeaders()`（两个都发），`listModels()` 用 `loomyBusinessHeaders()`。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import { createModelCatalog, isCatalogFresh, isCatalogFreshFor, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import {
  LOOMY_AUTH_ERROR_CODE,
  isLoomyChatModel,
  isLoomyExpired,
  loomyChatHeaders,
  loomyDisplayName,
  parseLoomyEnvelope,
  splitLoomyRate,
  type LoomyCredential,
} from './loomy.js'
import {
  LOOMY,
  LOOMY_EFFORTS,
  loomyContextWindow,
  loomySupportsImage,
  type LoomyFallbackModel,
  type LoomyProduct,
} from './loomy-product.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'
import { planSessionTitleThinking } from './session-title.js'

/**
 * 档位 id 数组 → `LlmResolvedModelInfo['reasoning']`（**唯一**实现）。
 *
 * ⚠️ 抽成模块级纯函数是因为它现在有**三个**消费者：目录内条目走
 * `LoomyAdapter.reasoningFor`，目录外 id 的**声明**走 `unknownModelReasoning`，
 * 目录外 id 的 **wire 白名单**走 `stream()`（2026-11-06 审计 #9：声明与上行
 * 不同源会让用户选的档位静默蒸发成服务端默认档，且零提示）。
 * 两套实现会漂移成「目录内下发 high、目录外不发」这类静默缺陷 ——
 * 与本仓库红线「同一 provider 内不得有两套同义判据」同型。
 *
 * 三条口径：
 * 1. `efforts` **原样取远端顺序**（服务端下发的就是展示顺序，DSH 当作展示序）；
 * 2. `defaultEffort` **必须落在 `efforts` 内** —— DSH 会拿它直接发请求，
 *    给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，比不给更糟；
 * 3. 档位为空时不声明 `reasoning`（UI 显示「当前模型未提供推理等级」）。
 *
 * @param efforts - 档位 id 列表（远端 `reasoning_efforts` 或兜底表同名字段）。
 * @returns 可直接进 `resolveModel()` 的 `reasoning`，或 `undefined` 表示不声明。
 */
export function reasoningFromEfforts(
  efforts: readonly string[] | undefined,
): LlmResolvedModelInfo['reasoning'] {
  if (efforts === undefined || efforts.length === 0) return undefined
  // ⚠️ **默认档用本插件自己的「高」，不采信远端的 `default_reasoning_effort`**（用户要求）。
  // 依据：远端声明的是 `low`，而 DSH 的 `effectiveEffort` 直接取 `defaultEffort`
  // （`dsh-client-ui-model-selection`：`state.current?.reasoningEffort ?? reasoning?.defaultEffort`），
  // 即「用户没选时发哪个档」完全由这里决定 —— 沿用 low 会让默认思考偏浅。
  const defaultEffort = LOOMY_PREFERRED_DEFAULT_EFFORT
  const hasDefault = efforts.includes(defaultEffort)
  return {
    efforts: efforts.map((id) => ({
      id: ReasoningEffortId(id),
      // 未登记的中文名回退到 id 本身（新档位上线时不至于空白）。
      name: LOOMY_EFFORT_NAMES[id] ?? id,
    })),
    ...hasDefault ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {},
  }
}

/**
 * 目录外 id（目录与兜底表都没有）的档位声明 —— **唯一接线**（2026-11-06 审计 #9 修复）。
 *
 * ⚠️⚠️ 修复前 `stream()` 的 wire 白名单只查「目录 + 兜底表」，目录外 id 在
 * **声明面**有五档（`unknownModelReasoning`）、在 **wire 面**却拿不到
 * `reasoning_effort` —— 同一请求「声明有档、上行不发」，用户选的档位静默
 * 蒸发成服务端默认档。收敛规则与骨架（`model-catalog.ts` 的
 * `entry !== undefined ? entry.reasoning : config.unknownModelReasoning?.()`）
 * 逐分支一致：
 * - 目录内 → `LoomyAdapter.reasoningFor`（远端优先、兜底表补位）；
 * - 目录外 → 这里（产品级五档：全部 chat 模型 `reasoning_efforts` 逐字相同）。
 *
 * 档位是**产品级**事实而非模型级事实，这正是对未知 id 也敢给的理由；
 * 对照：`unknownModelContextWindow` 刻意不提供（窗口是模型级事实，编造 = 假窗口）。
 *
 * 两个消费者：目录外 id 的声明（`unknownModelReasoning`）与 wire 白名单（`stream()`），
 * 必须引用**同一个**函数 —— 换任何一份手写实现都会在这两者之间重新裂开。
 */
function offCatalogReasoning(): LlmResolvedModelInfo['reasoning'] {
  return reasoningFromEfforts([...LOOMY_EFFORTS])
}

/** 本适配器注册的 provider 路由名（等价于 `LOOMY.id`）。 */
export const PROVIDER = 'loomy'

/** 远端模型条目（已归一）。 */
export interface LoomyRemoteModel {
  id: string
  /** **已规范化**的展示名（含倍率）。 */
  name: string
  contextWindow: number
  supportsImage: boolean
  supportsThinking: boolean
  /**
   * 可选思考档位（远端 `reasoning_efforts`，如 `['none','low','medium','high','xhigh']`）。
   *
   * ⚠️ **取自远端而非硬编码** —— 服务端 `GET /models` 直接下发了这两个字段，
   * 且带 `reasoning_catalog_version`（catalog 版本哈希），故档位随服务端更新，
   * 无需改代码。
   *
   * 缺失（`undefined`）表示**该模型不提供档位选择**，此时不声明 `reasoning`，
   * UI 显示「当前模型未提供推理等级」—— 而不是给一个发了也没用的档位。
   */
  efforts?: string[]
  /** 远端声明的默认档位（`default_reasoning_effort`）。 */
  defaultEffort?: string
}

/**
 * 档位 id → 中文展示名。
 *
 * ⚠️ **必须与官方 IDE 一致**。Loomy 是基于 **opencode** 构建的，其
 * `opencode.json` 的 `variants` 用的就是 `low` / `medium` / `high` 这套 id
 * （用户截图里的「低 / 中 / 高」正是它）。中文名沿用 Qoder 那套官方 i18n 表
 * （`src/qoder-adapter.ts` 的 `QODER_EFFORT_NAMES`，同源产品命名一致）。
 *
 * ⚠️ DSH 的档位选择器**直接渲染 `efforts[].name`**（不本地化），
 * 故这里给中文即中文界面。
 */
const LOOMY_EFFORT_NAMES: Readonly<Record<string, string>> = {
  none: '关闭思考',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

/**
 * 本插件选用的**默认思考档位**（用户要求：`high`）。
 *
 * ⚠️ **不采信远端的 `default_reasoning_effort`**（它声明的是 `low`）。
 * 依据是 DSH 的取值逻辑 —— `dsh-client-ui-model-selection` 的
 * `effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort`，
 * 即「用户没选时发哪个档」**完全由适配器声明的 `defaultEffort` 决定**，
 * 沿用远端的 `low` 会让默认思考偏浅。
 *
 * ⚠️ **必须落在该模型的 `efforts` 内**：DSH 会拿它**直接发请求**，给一个不存在的
 * 档位会抛 `UNSUPPORTED_REASONING_EFFORT`。故 `reasoningFor` 里做了 `includes`
 * 校验 —— 某模型若不提供 `high`（远端目录变化时可能发生），则**不下发默认档**，
 * 退回 DSH 的「服务商默认」语义，而不是发一个非法值。
 */
const LOOMY_PREFERRED_DEFAULT_EFFORT = 'high'

/** 把 `reasoning_efforts` 读成去重后的字符串数组（非法项丢弃）。 */
function readReasoningEfforts(entry: Record<string, unknown>): string[] {
  const raw = entry.reasoning_efforts
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** 把 `capabilities.input_modalities` 读成小写字符串数组。 */
function readInputModalities(entry: Record<string, unknown>): string[] {
  const capabilities = entry.capabilities
  if (typeof capabilities !== 'object' || capabilities === null) return []
  const raw = (capabilities as Record<string, unknown>).input_modalities
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase())
}

/**
 * 解析远端 `GET /models` 响应，只保留 `type === 'chat'` 的条目。
 *
 * ⚠️ 过滤判据是 `type`，**不能**看 `input_modalities` —— 实测 5 个 chat
 * 模型的输入模态含 `image`（能看图），那不是生图模型。
 * ⚠️ 展示名经 `loomyDisplayName` 规范化（远端原值是三种括号风格混用）。
 */
export function parseLoomyRemoteModels(payload: unknown): LoomyRemoteModel[] {
  const list = Array.isArray(payload)
    ? payload
    : (typeof payload === 'object' && payload !== null
        && Array.isArray((payload as Record<string, unknown>).data)
      ? (payload as Record<string, unknown>).data as unknown[]
      : [])
  const models: LoomyRemoteModel[] = []
  for (const item of list) {
    if (!isLoomyChatModel(item)) continue
    const entry = item as Record<string, unknown>
    const id = String(entry.id)
    const rawName = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id
    const contextWindow = Number(entry.context_length)
    const capabilities = typeof entry.capabilities === 'object' && entry.capabilities !== null
      ? entry.capabilities as Record<string, unknown>
      : {}
    const efforts = readReasoningEfforts(entry)
    const rawDefault = entry.default_reasoning_effort
    models.push({
      id,
      name: loomyDisplayName(rawName),
      // ⚠️⚠️ **必须过 `loomyContextWindow`**（issue IKJW31）：远端对 `spark-x`
      // 虚报 1048576，真实墙在 262144。只改兜底表是**无效**的 —— 远端可用时
      // 走的就是这里。判据与证据见 `loomy-product.ts` 的覆盖表注释。
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0
        ? loomyContextWindow(id, contextWindow)
        : 0,
      // ⚠️⚠️ **必须过 `loomySupportsImage`**（2026-10-14 用户报障）：远端对
      // `qwen-3.8-max` 漏报 `input_modalities`（只给 `['text']`），照抄会让 DSH
      // 把图投影成文本占位符、图根本发不出去。判据与证据见 `loomy-product.ts`
      // 的覆盖表注释。
      supportsImage: loomySupportsImage(id, readInputModalities(entry).includes('image')),
      supportsThinking: capabilities.reasoning === true,
      // ⚠️ 档位缺失时**不写这两个键**（而不是写空数组）：下游据此区分
      // 「该模型不提供档位」与「提供了但为空」。
      ...efforts.length > 0 ? { efforts } : {},
      ...typeof rawDefault === 'string' && rawDefault.length > 0
        ? { defaultEffort: rawDefault }
        : {},
    })
  }
  return models
}

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: LoomyFallbackModel): LoomyRemoteModel {
  return {
    id: model.id,
    name: model.name,
    // ⚠️ 兜底表的值同样过一遍覆盖表（两条路径**同一判据**，别让它们分叉 ——
    // 覆盖表本身就是对「照抄声明值」的纠正，与值来自哪条路径无关）。
    contextWindow: loomyContextWindow(model.id, model.contextWindow),
    // 兜底表不声明图片能力：宁可少报（用户改用文本描述），
    // 也不要报一个服务端可能不认的模态。
    // ⚠️ 但**同样要过覆盖表**（与上一行的 `contextWindow` 同一条纪律）：兜底表
    // 起算值恒为 false，覆盖表是唯一的真相源，两条路径因此不可能分叉。
    supportsImage: loomySupportsImage(model.id, false),
    supportsThinking: true,
    ...model.efforts !== undefined && model.efforts.length > 0
      ? { efforts: [...model.efforts] }
      : {},
    ...model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {},
  }
}

/** {@link LoomyAdapter} 的构造选项。 */
export interface LoomyAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /**
   * 解析当前可用凭据。
   *
   * ⚠️ 入参是**本轮要用的模型 id**：Loomy 的选号策略要按「该模型是否受限」
   * 先过滤账号（限流是**按模型**记的），再按余额分档。实现**必须**把它透传给
   * `AccountPool.getAvailableAccount` 的 `modelId` —— 早期实现传空串
   * （等于不按模型过滤），会让模型级限流失效。
   */
  resolveCredential: (modelId?: string, sessionId?: string) => Promise<LoomyCredential | undefined>
  /**
   * 凭据失效时的处理。
   *
   * ⚠️ Loomy **没有 refresh 端点**，故实现只做**有效性探测**并在失效时抛错，
   * 不会（也无法）续期。
   *
   * ## ⚠️⚠️ `forCredential` 是**可选**但强烈建议实现（2026-10-20 审计 E-2）
   *
   * 不带参数时，接线层的实现探测的是**池当前默认账号**
   * （`pool.getAvailableAccount(LOOMY.id, '')`），而热路径拿它来裁决
   * 「**本轮要用的那份**凭据还能不能用」—— **二者可能不是同一个号**。
   *
   * 实测（基线 `b5dab83` 同样）：本轮要用的号完全可用，仅因**另一个号**报终态
   * ⇒ 整轮失败、业务请求 0 次。这与 `401` 分支注释里自己写过的
   * 「二者可能不是同一个号」是同一个坑，只是那处讨论的是**标记记错号**，
   * 这处是**裁决打死错的人**。
   *
   * ⇒ 实现方收到 `forCredential` 时应只探测**那一份凭据**（按 access_token 反查
   *   其 ref 后调 `refreshAccountCredential`）；无法反查时退回原行为
   *   （探测默认号）—— 「宁可退化成旧行为，也不要凭空跳过探测」。
   */
  refresh: (forCredential?: LoomyCredential) => Promise<void>
  /**
   * 非终态告警出口（可选）。
   *
   * ⚠️ 目前只有一处消费：请求热路径上「凭据探测失败但按非终态处理」时留痕。
   * 缺省静默 —— 但接线层**必须**注入，否则本渠道会退化成本仓库反复记录的
   * 「静默失败」（用户看到整轮成功、实际探测一直在失败）。
   */
  warn?: (message: string) => void
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<LoomyRemoteModel[]>
  /**
   * 「现在」的注入点（**只供单测**推进 TTL；生产缺省 `Date.now()`）。
   *
   * ⚠️ 为何要注入：TTL 是本 Task 的核心判据，而真实时间无法在用例里推进 ——
   *    只能靠 `sleep` 的用例会 flaky 且慢。既有同形态先例：`auto-adapter` 的 `now`。
   */
  now?(): number
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link LOOMY}。 */
  product?: LoomyProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 远端目录**落地后**的通知回调（issue IKJVTF）。
   *
   * 由 `registerLoomyLlm` 注入为 `broadcastCatalogChanged(ctx)`。适配器本身
   * 拿不到 `ctx`，故必须由接线层桥接（与 `readImage` 等回调同一模式）。
   *
   * ⚠️ 必要性：客户端 `ModelCatalogDirectory` 在 `status === 'ready'` 时**短路
   * 返回缓存**，只在宿主事件上 `refresh()`。没有本回调时，冷启动首拉失败
   * 缓存的**兜底表**会永久留在对话框里，远端目录真的落地也不重读。
   */
  onCatalogLoaded?: () => void
}

// ── 请求级账号轮换（2026-10-05，用户报障「余额用完一个号就卡死」）────────

/** 单次用户请求最多尝试的账号数（含首号）。与 buddy/raccoon 同语义，设上限只为防病态池。 */
const LOOMY_MAX_ROTATE = 8

/**
 * 探测**非终态**失败后的退避窗口（毫秒）。
 *
 * ## 为什么需要它（2026-10-20 审计的 E-3）
 *
 * `isLoomyExpired` 读本地 `expires_at`（登录时刻 +14 天推算**写下**，服务端不下发，
 * 本插件**永不改写**）⇒ 本地判过期后，前置探测分支**每一轮**都会进。
 * 而探测的超时上限是 `LOOMY_REQUEST_TIMEOUT_MS` = **60 秒**，且
 * `probeCredential` 用的是**独立**的 `AbortSignal.timeout`、不联动调用方 `signal`
 * ⇒ 最坏情况是「每轮首 token 前白等 60 秒」，用户点停止也打断不了。
 *
 * 实测（审计沙箱）：`refresh` 永挂 ⇒ `stream()` 8 秒后仍未返回、业务请求 0 次；
 * 缩短到 250ms 后 `perTurnMs=[316,315,310]`（≈3× 串行叠加，**每轮各等一次**）。
 *
 * ## 为什么取 5 分钟
 *
 * 探测的**唯一产出**是「要不要提示用户重新登录」，而真失效会由业务请求自己
 * 以 401/403 或 `100002` 暴露。拿「一次上游抖动」惩罚之后每轮的首 token 延迟，
 * 是拿用户可感的延迟换一个不急用的信息。
 * 5 分钟与 `REMOTE_CATALOG_COOLDOWN_MS`（30 秒）相比更宽 —— 因为那条冷却的是
 * **目录**（影响可用模型集），这条冷却的是一次**只读探测**（不影响任何判定）。
 *
 * ⚠️ 与「失败短缓存」的区别：本退避**不改写任何判定**，窗口内用的仍是本轮
 * 刚解析出的凭据；它只决定「这次要不要去问探测端点」。
 * ⚠️ 探测**成功**时立刻清掉退避（上游已恢复，没理由继续跳过）。
 */
export const LOOMY_PROBE_BACKOFF_MS = 5 * 60_000

/**
 * 凭据探测的异常是否为**终态**（凭据确实失效，必须提示重新登录）。
 *
 * ⚠️ 按 `name` 判定，不按 `instanceof`：`RefreshTokenExpiredError` 定义在
 * `loomy-auth.ts`，而该类自身的注释已把「`name` 必须恰为 `RefreshTokenExpiredError`」
 * 写成契约（宿主与其它 provider 也按名判定）。`instanceof` 在打包/多副本下
 * 会因类身份不同而**假阴性** —— 那会把「请重新登录」误降级成「继续用」，
 * 症状比原缺陷更难排查。同款双重判据见 `astudio-adapter.ts`。
 *
 * 反过来说：**任何别的异常都不是终态**。网络超时、上游 `系统内部错误`、
 * 非 JSON 响应都属于「探测端点不可用」，与凭据无关。
 */
function isLoomyTerminalRefreshError(error: unknown): boolean {
  return error instanceof Error && error.name === 'RefreshTokenExpiredError'
}
/** 429 限流冷却：1 小时（与 trae soft-rate 同档）。 */
const LOOMY_RATE_LIMIT_COOLDOWN_MS = 3_600_000

/**
 * Loomy 的失败类别。**「要不要换号」与「要不要写冷却」是两件事**——
 * 认证类（401/403）只换号、**绝不写冷却**。
 *
 * ⚠️ 真实事故（2026-10-06 凌晨，raccoon 同型实现上暴露）：上游网关对**全池**
 * 回 `401 + authorization_verify_error`（网关侧授权校验故障）。当时把 401 也算
 * 「可换号」且在换号前写冷却、时长取 `status === 429 ? 1h : 24h` ⇒ 一个请求内
 * 连试 6 个号、每个写 24h ⇒ 池内候选筛空 ⇒ **整个 provider 被封一天**
 * （下一次请求报 `no usable credential; log in first`）。
 * buddy 的既有实现是分开的：只有限流类写标记，认证类只 `continue`。
 */
export type LoomyFailureClass = 'quota' | 'rate' | 'auth' | 'other'

/**
 * 判定失败类别（与 {@link RaccoonFailureClass} 同构——raccoon 与 loomy 的额度
 * 错误形态同族：`14018 Credits exhausted`，HTTP 层无专用状态码，文案是主通道；
 * 词表限「积分/额度/余额 + 不足/耗尽」的确定性组合，避免误伤正文里恰好讨论
 * 「余额」的 4xx）。
 *
 * ## ⚠️ 401/403 **必须先判**（同型复发，2026-10-06）
 *
 * 本函数初版与 raccoon 的**修复前**版本逐字同形：文案先判、且 `insufficient`
 * **单独出现**即算额度。raccoon 已在 `7b524ff` 收窄，loomy 未同步 ⇒ 同一报文
 * 在两个 provider 上被判成**不同类别**，且危险方向恒定朝 loomy（多写冷却）：
 *
 * | 报文（实测，见 tests 的「与 raccoon 对拍」段） | loomy 修复前 | raccoon 已修 |
 * |---|---|---|
 * | `403 + insufficient permissions to access this resource` | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `403 + 积分不足` | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `401 + 余额不足` | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `401 + 14018 Credits exhausted`（网关故障通常带余额提示） | `quota` ⇒ 写 24h | `auth` ⇒ 只换号 |
 * | `400 + the context window is insufficient for this model` | `quota` ⇒ 写 24h | `other` ⇒ 不换号 |
 *
 * 前四行正是 {@link LoomyFailureClass} 记的 2026-10-06「全池被封」事故形态
 * （那次触发词是 `authorization_verify_error`，这次是 `insufficient permissions`
 * / 「不足」类文案）：**认证类是账号态、不是模型冷却**，写标记会把网关侧的
 * 授权故障放大成「整个 provider 被封 24h」。
 *
 * 两处修法（与 raccoon 逐字一致，方向都是「宁可漏判不可误伤」）：
 * 1. **401/403 优先**按认证类处理 —— 状态码与额度文案并存时以状态码为准；
 * 2. `insufficient` 须与邻近的「钱」义词（point/credit/balance/quota/token）
 *    **共现**才算额度；上下文超长 / 数据不足等与额度无关。
 *
 * ⚠️ 两家的判据必须**逐格同构**：`classifyLoomyFailure` 与
 * `classifyRaccoonFailure` 是同一张表的两个实现，任一侧单方面改动都会造成
 * 本文件记的这起「同型复发」。回归用例用同一批真实报文喂两个分类器对拍。
 */
export function classifyLoomyFailure(errorText: string, status: number): LoomyFailureClass {
  // 认证类先判：403 可能只是权限/授权问题，绝不能落到 quota 而被写 24h 冷却。
  if (status === 401 || status === 403) return 'auth'
  const lower = errorText.toLowerCase()
  const quotaText = lower.includes('14018')
    || lower.includes('credits exhausted')
    // ⚠️ `insufficient` 单独出现**过宽**（raccoon 侧 PR !71 审计实测误伤 5 类），
    // 必须与邻近的「钱」义词共现才算额度：上下文窗口超长（"context window is
    // insufficient for this model"）、数据不足等都与额度无关。
    // 方向仍是「宁可漏判不可误伤」—— 漏判只是不换号，误判会封可用账号 24h。
    || (lower.includes('insufficient')
      && ['point', 'credit', 'balance', 'quota', 'token'].some((w) => lower.includes(w)))
    || (lower.includes('积分') && (lower.includes('不足') || lower.includes('耗尽')))
    || (lower.includes('额度') && (lower.includes('不足') || lower.includes('耗尽')))
    || (lower.includes('余额') && (lower.includes('不足') || lower.includes('耗尽')))
    || (lower.includes('quota') && (lower.includes('exceeded') || lower.includes('exhausted')))
  if (quotaText || status === 402) return 'quota'
  if (status === 429) return 'rate'
  return 'other'
}

/**
 * 该失败是否值得「换下一个账号」重试。
 *
 * 导出仅供单测锁定判据本身——只靠调用点顺序兜不住边界（`isRateLimited`
 * 的 429 边界那次已验证过）。
 */
export function shouldRotateLoomyAccount(errorText: string, status: number): boolean {
  return classifyLoomyFailure(errorText, status) !== 'other'
}

/**
 * **Loomy 专属**：`HTTP 200 + 业务码 100002` 是否该按「认证失败、值得换号」处理。
 *
 * ## 为什么它是一条**独立**判据，而不是加进 {@link classifyLoomyFailure}
 *
 * `classifyLoomyFailure` 与 `classifyRaccoonFailure` 在本仓库明文规定
 * 「必须**逐格同构**」，并由 `loomy-adapter.spec.ts` 的
 * 「与 raccoon 对拍：同一报文集逐条同结论」逐条守着。
 * 而 `100002` 是 **Loomy 独有**的业务码（raccoon 没有等价码，见
 * `src/loomy.ts` 的 `LOOMY_AUTH_ERROR_CODE`）⇒ 塞进共享分类器会让那条对拍用例
 * 当场变红，或者逼着给 raccoon 编一个它并不存在的码 —— 两条路都不对。
 * ⇒ 业务码这一腿留在**本家自己的**判据里，共享分类器保持逐格同构。
 *
 * ## 缺陷形态（2026-10-20 审计 E-1，**既有缺陷、非 PR !124 引入**）
 *
 * Loomy 的业务失败**恒 HTTP 200**（`src/loomy.ts` 的协议说明：
 * 「带错的那个 → HTTP 200 + `{"code":"100002","desc":"缺少 token"}`」），
 * 而请求级换号循环写在 `if (!response.ok)` 里面 ⇒ 200 的认证失败
 * **一次都不换号**。实测（基线 `b5dab83` 同样）：
 *
 * ```
 * classifyLoomyFailure('100002', 200)   ⇒ 'other'  rotate=false
 * classifyLoomyFailure('100002', 401)   ⇒ 'auth'   rotate=true   ← 只有状态码是 401 才算
 * ```
 *
 * 而 `100002` 才是 Loomy 表达「token 缺失/失效」的**主通道**。
 *
 * ⚠️ 与 `classifyLoomyFailure` 的职责边界：本函数**只回答**「这个响应体是不是
 * 认证失败」，不参与额度/限流的分类，也**不写冷却标记**（认证类一律不写，
 * 见 2026-10-06 的全池被封事故）。
 */
export function isLoomyAuthBusinessCode(envelope: { ok: boolean; code: string }): boolean {
  return !envelope.ok && envelope.code === LOOMY_AUTH_ERROR_CODE
}

/**
 * 该类别是否要写冷却标记（`auth` 不在其中，见 {@link LoomyFailureClass}）。
 *
 * ⚠️ 返回**类型谓词**而不是 `boolean`：{@link loomyCooldownResetAtMs} 只接受这两个
 * 类别，于是「先判类别、再算时长」这条顺序由**编译器**保证 —— 少了谓词，
 * 调用点忘了守卫时 `auth` 会静默拿到一个冷却时长（旧实现正是那个形状：
 * `status === 429 ? 1h : 24h` 的三元表达式对认证类也返回 24h）。
 */
export function recordsLoomyRateLimit(cls: LoomyFailureClass): cls is 'quota' | 'rate' {
  return cls === 'quota' || cls === 'rate'
}

/**
 * 撞墙后把冷却标记写到**哪一刻**（UTC 毫秒）。
 *
 * | 类别 | 冷却终点 | 依据 |
 * |---|---|---|
 * | `quota` | **UTC+8 当日 24:00**（`nextUtc8DayStartMs`） | 每日赠送额度按自然日重置 |
 * | `rate` | 撞墙时刻 + 1 小时 | 频率类分钟级恢复，与 trae soft-rate 同档 |
 *
 * ## ⚠️⚠️ `quota` 原先记的是「撞墙时刻 + 24h」—— 真实缺陷（Gitee IKL80H）
 *
 * 用户真机报障（2026-10-13）：**0 点后上游已经放行（用户自己的账号实测能用），
 * 插件仍说该模型没到重置时间、不给用**。根因就是这个**滑动窗口**：Loomy 的每日赠送
 * 额度（每日 5000 / `dailyBalance = dailyQuota - dailyConsumed`）按 **UTC+8 自然日**
 * 重置，而旧实现从失败那一刻起算 24 小时。用户在 23:50 烧光 ⇒ 标记落到**次日 23:50**，
 * 于是白等将近一整天。
 *
 * 实测取证（注入时钟，失败时刻 `2026-10-13 23:50 UTC+8`）：
 *
 * | | 时刻 |
 * |---|---|
 * | 修复前写下的标记 | `2026-10-14 23:50`（**+24h**） |
 * | 正确的自然日终点 | `2026-10-14 00:00`（只差 10 分钟） |
 * | 0 点后 10 分钟的判定 | 仍判「全部账号限流」，距解禁 **23.67 h** |
 *
 * 症状出口两处（都读同一个 `modelRateLimits`）：选号侧
 * `allAccountsRateLimitedForModel` → `throwIfAllAccountsRateLimited` 报
 * 「可用账号均在限流中，最近一个将于 <次日 23:50> 解禁」；面板侧的「限额中」徽章
 * 与「限额重置」行。
 *
 * ⚠️ 这同时违反本仓库红线「**同一 provider 内不得有两套同义判据**」：
 * `aggregate-expiry.ts` 的 `loomyExpiry` 对**同一件事**（Loomy 的每日赠送何时失效）
 * 用的是 `nextUtc8DayStartMs()`，与适配器这里的 +24h 结论不同。现统一到自然日，
 * 与 qoder / zcode / codearts 三家同口径。
 *
 * ## ⚠️ 与 raccoon 的**冷却时长**不再同档（刻意的，已登记）
 *
 * 两家的**失败分类表**（`classifyLoomyFailure` / `classifyRaccoonFailure`）仍必须
 * 逐格同构（有对拍用例守着），但**冷却时长**由各自的额度结算周期决定：loomy 有
 * 明确的每日赠送池（自然日），raccoon 侧的 24h 兜底尚未同批核对 ⇒ 本次**只改 loomy**。
 * 这处不对称已记进 `docs/agent-notes/providers-loomy-raccoon-minimax.md`。
 *
 * ## ⚠️ 代价（如实登记）
 *
 * `classifyLoomyFailure` 判 `quota` 时**分不清**「每日赠送用尽」与「连永久积分也空了」
 * ——报文只有 `14018 Credits exhausted`。改用自然日后标记**严格变短**（最多差近 24h）
 * ⇒ 若某个号永久积分也空，0 点后会被重试一发再重新标记。这是刻意的取舍：
 * 宁可多发一发失败请求，也不要让用户白等一整天（旧值让**每一个**配额耗尽的号都白等）。
 *
 * @param cls - 失败类别；只接受会写标记的两类（由类型谓词保证）。
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export function loomyCooldownResetAtMs(cls: 'quota' | 'rate', nowMs: number = Date.now()): number {
  return cls === 'rate' ? nowMs + LOOMY_RATE_LIMIT_COOLDOWN_MS : nextUtc8DayStartMs(nowMs)
}

/** Loomy 模型适配器。chat 端点用 Bearer，业务端点用 token。 */
export class LoomyAdapter extends LlmAdapter {
  private readonly product: LoomyProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, LoomyFallbackModel>
  /** 远端模型缓存（含展示名与能力）；未拉取时为 undefined。 */
  private remoteModels: LoomyRemoteModel[] | undefined
  /**
   * ⚠️ 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
   *
   * ⚠️ 与 `remoteModels` **并存**、不是替代：`remoteModels` 存「有哪些模型」，
   *    本字段存「何时读到的」。两者缺一都会坏：只有 `remoteModels` 则目录永不更新
   *    （现状）；只有 `catalogAt` 则无内容可展示。
   */
  private catalogAt = 0
  /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
  private readonly catalogGate: RemoteCatalogGate

  constructor(private readonly options: LoomyAdapterOptions) {
    super()
    this.product = options.product ?? LOOMY
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
    // 目录落地后通知客户端重读（issue IKJVTF 的缺陷①）。
    this.catalogGate = new RemoteCatalogGate(
      options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded },
    )
    // ⚠️ 共享骨架：门控 → 读目录 → 黑名单 → 回填 → 三态，全在 `model-catalog.ts`。
    this.catalog = createModelCatalog(
      { accountPool: options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        // ⚠️ 未知 id 保守报 ['text']（宁可少报能力，也不报服务端可能不认的模态）。
        unknownModelInputModalities: () => ['text'] as const,
        /**
         * ★ **目录外 id 仍声明档位**（2026-11-06 真实报障）。
         *
         * 缺陷形态：远端 `GET /models` 抓取失败 ⇒ `loadModels()` 退回兜底表 ⇒
         * 兜底表里**没有**刚上架的模型（如 `DeepSeek-V4.1-Flash`）⇒ 该 id 走
         * `model-catalog.ts` 的「目录外」分支 ⇒ **不声明 `reasoning`** ⇒ 用户在它上面
         * 持久化过的 `xhigh` 被 `dsh-llm` 的 `resolveCallWithInfo` **硬抛**
         * `UNSUPPORTED_REASONING_EFFORT`（`no clamping or aliasing is performed`）⇒
         * **整轮失败，一个 token 都没发出去**，且没有任何降级路径。
         *
         * 为什么本家可以给：Loomy 的档位是**产品级**事实 —— 实测全部 chat 模型
         * （含 2026-11-06 新上架的 `DeepSeek-V4.1-Flash`）下发的
         * `reasoning_efforts` **逐字相同** `['none','low','medium','high','xhigh']`，
         * 与具体模型无关。同理先例：`cline` 的档位来自产品配置、`codearts` 的思考
         * 控制是顶层 `thinking.type`，两者都对本家「目录外 id」照样声明
         * （见 `src/model-catalog.ts` 的 `unknownModelReasoning` 表格）。
         *
         * ⚠️ **刻意不提供 `unknownModelContextWindow`**：窗口是**该模型**的事实，
         * 目录外 id 无从得知 ⇒ 编一个就是假窗口（分母错会让占用比与压缩阈值一起错，
         * 比「不显示」更难发现）。这与上面档位的取舍**不同源**，不要一并改。
         */
        // 目录外 id 仍声明档位（2026-11-06 真报障：远端新上架模型未同步兜底表 ⇒
        // 切模型即整轮失败）。⚠️ 与 stream() 的 wire 白名单引用**同一个**
        // `offCatalogReasoning` —— 两个消费者换任何一份手写实现都会重新裂开
        // （审计 #9：修复前白名单只查「目录 + 兜底表」，声明有档而 wire 不发）。
        unknownModelReasoning: offCatalogReasoning,
        syncCatalog: () => this.syncCatalogEntries(),
        /**
         * ★ **强制重拉**（供后台 20 分钟刷新器与「用户改设置」）。
         *
         * ⚠️ 与 `loadCatalog` 的差别：后者走 `loadModels()`，内部有 `isCatalogFresh`
         * 判据 ⇒ 新鲜时**不拉**。本回调要的是「无视新鲜度，强制拉一次」，
         * 故先清时刻再调同一个方法 —— **不另写一份拉取逻辑**（那会让两条路的上游行为分叉）。
         */
        refresh: async () => {
          this.catalogAt = 0
          await this.loadModels()
        },
      },
    )
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
   * ⚠️ **2026-10-08 Task 7a：三个方法收敛到共享骨架** `createModelCatalog`。
   *
   * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架（实测与
   * `minimax` / `raccoon` **归一化后逐字相同**）。现在只剩 `toCatalogEntry`
   * 这一个**本家私有**的转换，骨架（门控 → 读目录 → 黑名单 → 回填 → 三态）
   * 由 `src/model-catalog.ts` 统一持有。
   */
  private readonly catalog: ModelCatalog

  /** 完整目录（**不套黑名单**），带最终展示名。设置页需要它渲染被关闭的模型。 */
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
   * 取远端模型目录；**失败时不把兜底表写进缓存**。
   *
   * ⚠ 原实现是 `this.remoteModels = fallback; return fallback` —— 把兜底表当成
   * 「已加载」记下，于是一次瞬时失败会让该 provider **整个进程生命周期**都只剩
   * 兜底模型（用户看不到自己的模型，且无从触发重试，只能重启）。
   * 改为：只缓存**真实远端目录**，兜底表每次现算（纯本地、零成本），
   * 并用 {@link RemoteCatalogGate} 的冷却挡住「每模型重试一次」的放大。
   */
  private async loadModels(): Promise<LoomyRemoteModel[]> {
    // ⚠️⚠️ **两处判据都要改**（方法入口 + gate 后复查）。只改入口的话，
    //    第二次复查会把「刚拉到的」当成陈旧而再拉一次（放大成每轮两次上游请求）。
    //
    // ⚠️ 判据来源：`isCatalogFresh`（`model-catalog.ts` 的**唯一**实现）；聚合
    //    那条缓存短路（`aggregate-adapter.ts` 的 `refreshCatalog`）也走它。
    //    ⚠️ **不是「逐字相同」**：那边另有两处本家没有的前提（`force` 与
    //    `options.catalogTtlMs` 覆盖的 60s TTL），本家用的是 20 分钟默认周期。
    //
    // ⚠️ **入口这一处用 `isCatalogFreshFor`（带「用户主动失效」）**：用户刚在
    //    Jet Hub 改了开关 ⇒ 即使还在 20 分钟内也要去拉一次（规格 §6 的正确性要求，
    //    见 `model-catalog.ts` 的 `invalidateCatalogCache`）。
    //    ⚠️ 下面 gate 之后那一处**刻意仍用 `isCatalogFresh`**（不带失效）：那处
    //    问的是「手上这份旧读数还能不能用」，若也判失效，一次失败的拉取就会把
    //    **完整旧目录**判成不可用 ⇒ 回落兜底表（子集）⇒ 用户看到「模型反而变少」。
    if (this.remoteModels !== undefined
      && isCatalogFreshFor(this.product.id, this.catalogAt, this.options.now?.() ?? Date.now())) {
      return this.remoteModels
    }
    const fetchRemote = this.options.fetchRemoteModels
    if (fetchRemote !== undefined) {
      await this.catalogGate.run(async () => {
        const fetched = await fetchRemote()
        if (fetched.length === 0) return false
        this.remoteModels = fetched
        // ⚠️ **只在成功时**记时刻：失败不写，否则一次抖动会把上界刷新掉、
        //    下轮还要等满 20 分钟才发现上游没恢复。
        this.catalogAt = this.options.now?.() ?? Date.now()
        return true
      })
      if (this.remoteModels !== undefined
        && isCatalogFresh(this.catalogAt, this.options.now?.() ?? Date.now())) {
        return this.remoteModels
      }
    }
    return this.product.fallbackModels.map(fallbackToRemote)
  }

  /**
   * 把本家私有的远端/兜底条目转成共享骨架的中间结构。
   *
   * ⚠️ 这里是**唯一**还认识「倍率格式」与「supportsImage」的地方 ——
   * 骨架不认识它们（各家格式不同）。
   */
  private toCatalogEntry(
    model: LoomyRemoteModel,
    fallback: LoomyFallbackModel | undefined,
  ): CatalogEntry {
    const reasoning = this.reasoningFor(model, fallback)
    const contextWindow = model.contextWindow
    return {
      id: model.id,
      // 倍率拼进 name（不是 description）：composer 的模型切换菜单只渲染 name。
      name: model.name,
      // ⚠️ `resolveModel` 用**裸名**（不带倍率）—— 价格只属于选择列表语境。
      bareName: splitLoomyRate(model.name).name,
      // ⚠️ 三态：`supportsImage` 为 false 时是**明确不支持**（不是「未知」）——
      // 本家的远端条目**总是**带该布尔，故这里恒为数组，不会是 undefined。
      inputModalities: model.supportsImage ? ['text', 'image'] : ['text'],
      ...contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {},
      ...reasoning !== undefined ? { reasoning } : {},
    }
  }

  /** 本家全部条目（远端缓存 ?? 兜底表），已转成中间结构。 */
  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    const all = await this.loadModels()
    return all.map((model) => this.toCatalogEntry(model, this.fallbackIndex.get(model.id)))
  }

  /** 同步视图（`listAllModels` 用，见 `ModelCatalogConfig.syncCatalog` 的说明）。 */
  private syncCatalogEntries(): readonly CatalogEntry[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => this.toCatalogEntry(model, this.fallbackIndex.get(model.id)))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(_provider)
  }

  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolveModel(provider, model, signal)
  }

  /**
   * 该模型的思考档位（`resolveModel` 的 `reasoning` 字段）。
   *
   * ⚠️ **此前根本不声明** —— DSH 的思考强度选择器**只会**从
   * `resolveModel().reasoning` 渲染，故两个站点从来没出现过档位选择器，
   * 尽管远端早就下发了 `reasoning_efforts`。这与 Qoder 那次（AGENTS.md 2.2 节）
   * 是**完全同型**的缺陷。
   *
   * 三条口径：
   * 1. `efforts` **原样取远端顺序**（服务端下发的就是展示顺序）；
   * 2. `defaultEffort` **必须落在 `efforts` 内** —— DSH 会拿它直接发请求，
   *    给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，比不给更糟；
   * 3. 远端未下发档位时不声明 `reasoning`（UI 显示「当前模型未提供推理等级」）。
   *
   * ⚠️ **已知残余（2026-11-06 审计 #6，登记不修）**：目录内条目远端**未下发**
   * 档位（`reasoning_efforts: []` 会被 `parseLoomyRemoteModels` 省略键）⇒ 不声明
   * ⇒ 用户持久化过的档位仍会被 dsh-llm 硬抛（与本 PR 报障同型但**入口不同**：
   * 报障是目录外 id，这里是目录内无档位条目 —— 且仅当该 id 也不在兜底表时）。
   * 刻意**不**在这里回退产品级五档：远端对目录内条目的逐模型声明是优先事实，
   * 空档位可能是服务端刻意的（「全部 chat 模型逐字相同」只是快照，2026-11-06）。
   * wire 侧白名单已与声明同源（`stream()`），故该形态下两侧一致地「不声明也不发」。
   */
  private reasoningFor(
    entry: LoomyRemoteModel | undefined,
    fallback: LoomyFallbackModel | undefined,
  ): LlmResolvedModelInfo['reasoning'] {
    // 远端优先；远端整体失败时用兜底表（两者字段同名同形）。
    const efforts = entry?.efforts ?? fallback?.efforts
    return reasoningFromEfforts(efforts)
  }

  /**
   * 探测退避表（`modelId` → 退避到期时刻）。
   *
   * ⚠️ 按 **modelId** 分桶而不是全局一个值：探测本身与模型无关，但热路径的
   * 前置分支是**按模型**进来的（`isLoomyExpired` 与 `resolveCredential(model)`），
   * 用全局值会让「A 模型抖动一次 ⇒ B 模型也跳过探测」——那是不必要的耦合，
   * 而按模型分桶没有额外代价（`Map` 只有几十条）。
   *
   * ⚠️ **只增不减**在此处是可接受的：条目数 = 用户用过的模型数（个位到几十），
   * 每次写都是覆盖同一个键。不做定期清理，避免再引入一个需要调度的东西。
   */
  private readonly probeBackoffUntil = new Map<string, number>()

  /** 「现在」的统一取法（与 `options.now` 注入点同源，单测可推进）。 */
  private nowMs(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** 该模型当前是否处于探测退避窗口内。 */
  private probeBackedOff(modelId: string): boolean {
    const until = this.probeBackoffUntil.get(modelId)
    if (until === undefined) return false
    // ⚠️ 墙钟被回拨时 `now - until` 可能异常 ⇒ 与仓库既有口径一致，只认
    // 「剩余量不超过一个退避周期」的窗口，超长的一律按已到期处理（否则一次
    // 回拨就能把探测永久跳过）。
    const now = this.nowMs()
    if (now >= until) return false
    if (until - now > LOOMY_PROBE_BACKOFF_MS) return false
    return true
  }

  /** 记一次退避（探测非终态失败后调用）。 */
  private armProbeBackoff(modelId: string): void {
    this.probeBackoffUntil.set(modelId, this.nowMs() + LOOMY_PROBE_BACKOFF_MS)
  }

  /** 清掉退避（探测成功，或终态已抛之后）。 */
  private clearProbeBackoff(modelId: string): void {
    this.probeBackoffUntil.delete(modelId)
  }

  /**
   * 把 `HTTP 200 + 业务码 100002` 的响应**重建**成一个 `401` 响应，交给既有换号循环。
   *
   * 返回 `undefined` 表示「不是这种形态，原样继续」。
   *
   * ## ⚠️ 三条边界（都是刻意收窄，避免制造新缺陷）
   *
   * 1. **只处理 `content-type: application/json`**：SSE 流**不能**在这里 `text()`
   *    读干——那会把正文吃掉，用户看到空回复。SSE 内嵌错误帧仍归
   *    `consumeOpenAiSse`。
   * 2. **只有 `code` 恰为 `LOOMY_AUTH_ERROR_CODE` 才转**：别的业务码（额度、参数）
   *    形态各异，一律不碰 —— 那是分类器与 `!response.ok` 分支的职责。
   * 3. **转换后仍带原始报文**：把原 JSON 原文塞回新响应的 body，于是下游
   *    `errorDetail()` 与日志拿到的仍是上游原话（不编造、不丢信息）。
   *    ⚠️ `normalize` 出来的 `status` 是 **401**（而不是编一个 4xx），
   *    因为下游 `classifyLoomyFailure` 对 401 判 `auth`、且认证类**不写冷却**
   *    （2026-10-06 全池被封事故的铁律）。
   */
  private async rebuildAuthBusinessFailure(response: Response): Promise<Response | undefined> {
    // ⚠️ 先看状态码与 content-type：两者都不对就零成本返回，**不读 body**
    //    （读 body 是有代价的，且对 SSE 是破坏性的）。
    if (response.status !== 200) return undefined
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('application/json')) return undefined
    let text: string
    try {
      text = await response.text()
    } catch {
      // ⚠️⚠️ **读失败也必须把响应重建回去**：`text()` 一旦被调用，原响应的
      // body 就被消耗/锁住了（实测 `Invalid state: ReadableStream is locked`）。
      // 这里若直接 `return undefined`，下游 `consumeOpenAiSse(response)` 会抛
      // 一个与真实原因无关的流锁错误 —— 那正是本仓库反复禁止的「误导性报错」。
      return undefined
    }
    // ⚠️ 读完 body 之后，**无论走哪条分支都必须**返回一个可用的 Response
    //（要么重建的 401，要么原样重建的 200），不能把读干的流交回下游。
    const rebuiltOk = (): Response =>
      new Response(text, { status: response.status, headers: { 'content-type': contentType } })
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // 声明 JSON 但内容不是 JSON：不是「业务码」形态。
      // ⚠️ **必须返回重建的响应**（原响应体已被读干）—— 否则下游看到空流，
      // 会报「响应不是 SSE（没有任何 data: 帧）」而丢掉上游原话。
      return rebuiltOk()
    }
    const envelope = parseLoomyEnvelope(parsed)
    if (!isLoomyAuthBusinessCode(envelope)) return rebuiltOk()
    this.options.warn?.(
      `[loomy] 上游以 HTTP 200 + 业务码 ${envelope.code} 表达认证失败（${envelope.message}）：`
      + '改按认证失败处理（换号，不写冷却）',
    )
    return new Response(text, { status: 401, headers: { 'content-type': 'application/json' } })
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `QoderAdapter` 同款 shim。
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
    // 图片能力按**模型**判定。这里**不能**放宽成「总是接受」：DSH 在
    // LlmRuntime 里按适配器播报的 `inputModalities` 决定要不要把图片投影成
    // 文本占位符，声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      // ⚠️ 这里**不能**走 `this.catalog` —— 它要的是「这个模型支不支持图片」这一个
      // 判据，而 `resolveModel` 会顺带做 name 回退/context/maxTokens/reasoning，
      // 在**发请求前**的这条路径上多算一遍没有意义（且 `resolveModel` 是 async）。
      if (entry?.supportsImage !== true) {
        throw new LlmError(`loomy: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('loomy: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        /**
         * ⚠️ **此处刻意走「原图」路径，未接 `readImageRequest` 缩放桥接**
         * （Gitee issue IKKX0T，2026-10-12 复核）。
         *
         * 既有理由「loomy 实测 24 张全过、无证据说明它有约束」**已被推翻**：
         * issue 的独立实测给出 `413 Request Entity Too Large` / `504`，
         * 且本仓库那个「24 张」= **91.8 MiB** 恰落在 issue 的 87.4~96.6 MiB
         * 区间**内部** —— 即当时是**侥幸通过**，不是没有约束。
         *
         * ⇒ **但当前仍不接**，理由只有一条：**边界未经本仓库复测**。
         * 两家 fixture 的量纲不同（issue 3.45 MiB/张 vs 本仓库 2.87 MiB/张），
         * 直接套用别家的 `imageMaxBytes` 等于写进一个没验证的猜测
         * （本仓库规矩：拿不到阈值就不定值）。
         *
         * **复测入口**：`pnpm test:e2e:image-bisect`
         * （`tests/e2e/image-limit-bisect.e2e.spec.ts`，二分到 ≤3 张）。
         * 复测后：① 给 `LoomyProduct.imageMaxBytes` 赋值；
         * ② 这里改为 `projectRequestImage(ref, {...})` 并保留「拿不到就回退原图」；
         * ③ 宿主侧 `index.ts` 补 `readImageRequest` 桥接；
         * ④ 删掉 `tests/unit/image-budget.spec.ts` 里那条「loomy/trae 不误接」守卫。
         */
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 取凭据（过期则先尝试探测/刷新）
    //
    // ⚠️ **必须把模型 id 传给选号器**：Loomy 的选号要先按「该模型是否受限」
    // 过滤账号（限流按模型记），再按余额分档。传空串会让模型级限流失效。
    let credential = await this.options.resolveCredential(options.model, options.sessionId)
    if (credential === undefined || isLoomyExpired(credential)) {
      // ⚠️⚠️ 探测失败**只有一种**是终态：凭据确实失效（`RefreshTokenExpiredError`）。
      // 其余（网络超时、上游 5xx、`系统内部错误` 这类业务错误、非 JSON 响应）
      // **一律不得打断本轮** —— 它们说明的是「只读探测端点不可用」，
      // 与「这份凭据还能不能用」是两件事。
      //
      // 这条口径**不是新造的**：`LoomyAuth.refreshAll()` 早已如此（那里只把
      // 终态记 warn、其余记 warn 后继续下一个账号）。热路径与它不一致，
      // 是同一仓库里两套同义判据（AGENTS.md 记过 PR !62 的同型缺陷）。
      //
      // 真实伤情（2026-10-20，会话 `session-bfb9b616`）：同一渠道第 4、5 轮
      // 相隔 27 分钟两次整轮失败，文案分别是
      // `Loomy 凭据探测失败：系统内部错误` 与
      // `Loomy 凭据探测网络失败：The operation was aborted due to timeout`
      // —— 而同一时刻 Jet Hub 面板三个账号的余额全部读得到（渠道是活的）。
      // 探测是 60s 超时，最坏情况下用户还要先白等一分钟才拿到失败。
      //
      // 为什么放行是安全的：Loomy **没有续期端点**，探测的唯一产出是
      // 「要不要提示用户重新登录」。真正的失效会在业务请求上以 401 /
      // `100002` 暴露，由本适配器的换号与 `classifyLoomyFailure` 接住。
      // 拿探测当请求前置门禁，等于把「上游只读端点抖了一下」升级成「整轮失败」。
      //
      // ⚠️⚠️ **但「放行」不等于「每轮都去白等一次」**（2026-10-20 审计的 E-3）。
      //
      // `isLoomyExpired` 读的是本地 `expires_at`（登录时刻 +14 天推算**写下**，
      // 服务端不下发、本插件**永不改写它**）⇒ 一旦本地判过期，这个分支
      // **每一轮**都会进；而探测的超时上限是 `LOOMY_REQUEST_TIMEOUT_MS`（60 秒）
      // 且**不响应调用方 `signal`** ⇒ 最坏情况是「每轮首 token 前白等 60 秒」。
      // 修前是「每轮等 60 秒然后**失败**」，修后若不退避就变成
      // 「每轮等 60 秒然后**继续**」—— 用户感受更慢（虽然更可用）。
      //
      // ⇒ 非终态失败后记一个**退避窗口**（{@link LOOMY_PROBE_BACKOFF_MS}），
      //   窗口内**跳过探测**直接发请求。理由：探测的产出只有「要不要提示重登」，
      //   而业务请求本身会把真失效暴露出来（401/403 或 `100002`）；
      //   让一次上游抖动惩罚之后 5 分钟的**每一轮**，是拿首 token 延迟换一个
      //   我们并不急着用的信息。
      //   ⚠️ 与「失败短缓存」同型但**不是**同一件事：这里退避的是**探测**，
      //   不改写任何能力/凭据判定，窗口内用的仍是本轮刚解析出的凭据。
      if (!this.probeBackedOff(options.model)) {
        try {
          // ⚠️ 把**本轮**凭据传下去（审计 E-2）：接线层若不接参数，探测的是**池默认号**而不是本轮要用的那个。
          //   实测：本轮号完全可用，仅因**另一个号**报终态 ⇒ 整轮失败、业务请求 0 次。
          await this.options.refresh(credential)
          // 探测成功 ⇒ 清掉退避（上游已恢复，没有理由继续跳过）。
          this.clearProbeBackoff(options.model)
        } catch (error) {
          if (isLoomyTerminalRefreshError(error)) throw error
          // ⚠️ 只对「可重试类」退避：终态已抛，其余都是「端点不可用」。
          this.armProbeBackoff(options.model)
          this.options.warn?.(
            `[loomy] 凭据探测失败（非终态，继续使用现有凭据，${LOOMY_PROBE_BACKOFF_MS / 1000} 秒内不再探测）：${
              error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      credential = await this.options.resolveCredential(options.model, options.sessionId)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('loomy: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }
    /**
     * 当前请求实际使用的账号 id（请求级轮换的记账键）。语义与 raccoon 同款：
     * 按 access_token 反查池内条目；单凭据兜底时保持空串（无池即无「下一个号」，
     * 轮换自然失效，不误标）。
     */
    let activeAccountId = ''
    if (this.options.accountPool) {
      try {
        activeAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id, credential.access_token,
        ) ?? ''
      } catch { /* 反查失败不阻断主路径 */ }
    }

    const messages = serializeMessages(options.messages, imageUrls)

    /**
     * 前置 system 消息（若有）。
     *
     * ⚠️ 必须**先拼再放进对象**，不要在对象字面量里写两次 `messages` ——
     * 后者依赖「后面的键覆盖前面」这一隐式行为，读者极易误判成漏了 system。
     */
    const wireMessages = options.system !== undefined && options.system.length > 0
      ? [{ role: 'system', content: options.system }, ...messages]
      : messages

    /**
     * 思考档位：仅当**该模型确实声明了它**时才下发。
     *
     * ⚠️ 字段名是 `reasoning_effort`（与远端声明的 `reasoning_efforts` /
     * `default_reasoning_effort` 同源，也与 OpenAI 标准一致）。
     * 本插件其余适配器同样用它（如 `buddy-adapter.ts`）。
     *
     * ⚠️ **必须校验档位在该模型的 `efforts` 内**：DSH 会把用户选的档位直接透传，
     * 给一个远端不认的值比不给更糟。校验不过时**静默不下发**（退回服务端默认档），
     * 而不是发一个可能被拒的值。
     *
     * ⚠️ **不能靠 HTTP 状态码判断该字段是否生效**：实测传
     * `reasoning_effort` / `reasoningEffort` / `thinking` 三种名字**都返回 200**
     * —— 服务端对未知字段静默忽略（与「无效模型名回退默认模型」同一模式）。
     * 故这里的字段名依据是**远端自己的命名**，而非「试出来能通」。
     */
    /**
     * ⚠️⚠️ wire 白名单与 `resolveModel` 的声明**同源**（2026-11-06 审计 #9 修复）。
     *
     * 修复前白名单只查「目录 + 兜底表」（`entry?.efforts ?? fallback?.efforts`），
     * 目录外 id ⇒ `undefined` ⇒ `reasoning_effort` **静默不上行**，而声明面
     * （`unknownModelReasoning`）恰恰给了目录外 id 五档 —— 同一请求「声明有档、
     * wire 不发」，用户选的档位蒸发成服务端默认档，零提示（远端失败时表内 id
     * 能上行、目录外 id 不能，同条件不同结果）。收敛规则与骨架
     * （`model-catalog.ts` 的 `entry !== undefined ? entry.reasoning : config.unknownModelReasoning?.()`）
     * 逐分支一致：
     * - 目录内 → `reasoningFor`（远端优先、兜底表补位，与修复前值不变）；
     * - 目录外 → `offCatalogReasoning`（产品级五档，与声明面同一函数）。
     * 目录内条目两侧都**不**回退产品级五档 —— 目录内条目未下发档位时声明与
     * wire 一致地「不声明也不发」（见 `reasoningFor` 的已知残余登记）。
     *
     * ⚠️ `entry` 复用本函数开头图片闸门（`supportsImage`）那一次 `loadModels()`
     * 的查找结果 —— 同一请求、同一个模型，目录只查一次。
     */
    const declaredReasoning = entry !== undefined
      ? this.reasoningFor(entry, this.fallbackIndex.get(options.model))
      : offCatalogReasoning()
    // `String(e.id)`：reasoning.efforts[].id 是 branded `ReasoningEffortId`，
    // 摊平回 plain string —— 下游 `includes(titlePlan.effort: string)` 与
    // 修复前的 `string[]` 白名单语义逐字节等价。
    const effortsForModel = declaredReasoning?.efforts.map((e) => String(e.id))
    /**
     * 会话自动命名（`purpose: 'session-title'`）的思考与预算决策（issue IKKVDH）。
     *
     * DSH 用 **64 token** 发标题请求且**不传 `reasoningEffort`**，而宿主会把
     * 远端声明的默认档注入进来。本家远端 `reasoning_efforts` 实测形如
     * `['none','low','medium','high','xhigh']`（**含 `none`**）⇒ 声明了它的
     * 模型关得掉；远端未声明档位的模型只能抬预算兜底。
     */
    const titlePlan = planSessionTitleThinking({
      purpose: options.purpose,
      requestedEffort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      declaredEfforts: effortsForModel ?? [],
      maxTokens: options.maxTokens,
    })
    /**
     * ⚠️ **仍须做档位白名单校验**（这是本家原有的判据，不能因为接入标题逻辑
     * 而丢掉）：DSH 会把用户选的档位直接透传，给一个远端不认的值比不给更糟。
     *
     * 两种请求的取值来源不同，但**都要过这一关**：
     * - 标题请求：`titlePlan.effort`（声明了 `none` 时就是它）；
     * - 普通请求：调用方给的档位（与本次改动前**逐字节等价**）。
     */
    const effort = titlePlan.effort !== undefined
      && effortsForModel !== undefined
      && effortsForModel.includes(titlePlan.effort)
      ? titlePlan.effort
      : undefined

    /** 构造请求体。 */
    const buildBody = (): string => JSON.stringify({
      model: options.model,
      messages: wireMessages,
      stream: true,
      ...titlePlan.maxTokens !== undefined ? { max_tokens: titlePlan.maxTokens } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
      ...effort !== undefined ? { reasoning_effort: effort } : {},
      ...options.tools !== undefined && options.tools.length > 0
        ? {
            tools: options.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                ...tool.description.length > 0 ? { description: tool.description } : {},
                ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
              },
            })),
          }
        : {},
    })

    /** 发送一次 chat 请求。 */
    const send = async (token: string): Promise<Response> => {
      try {
        return await this.fetchImpl(`${this.product.apiBase}/chat/completions`, {
          method: 'POST',
          // ⚠️ chat 端点只认 Bearer（业务端点才认 token），这里两个都发。
          headers: loomyChatHeaders(token),
          body: buildBody(),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `loomy: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    let response = await send(credential.access_token)
    // 401/403 时尝试刷新一次（Loomy 无 refresh 端点，故这里多半会抛错，
    // 但保留该路径以便将来上游开放续期时自动受益）。
    if (response.status === 401 || response.status === 403) {
      /**
       * ⚠️⚠️ **探测失败不得在此处打断整轮**（2026-10-20 审计实测的真缺陷）。
       *
       * 前置门禁那处（`credential === undefined || isLoomyExpired`）已降级为 warn，
       * 而本分支长期漏修 ⇒ **同一个「非终态」错误走两条路径得到相反结果**
       *（本仓库明令禁止的「同义判据两套」，AGENTS.md 记过 PR !62 同型）。
       *
       * 实测（两路独立审计 + 主会话复核，同一份 stub `refresh` 抛
       * `Loomy 凭据探测失败：系统内部错误`）：
       * ```
       * 前置门禁分支 ⇒ 整轮成功、warns=1
       * 401/403 分支 ⇒ 整轮失败、warns=0、抛裸 Error（无 code，与报障 UNKNOWN 同形）
       * ```
       * 次生后果（决定性数字）：A 的 token 401、池里 B 完全正常时 ⇒ 整轮失败、
       * `getAvailableAccount` 调用 **0** 次、B **从未被尝试**。
       * 这直接证伪了前置门禁那段注释里「真正的失效由本适配器的换号接住」的论证
       * —— 那条自救路径被这处漏修阻断在最需要它的位置。
       *
       * ## ⚠️ 修法**不得照抄**前置门禁的「降级后继续重取重发」
       *
       * 对抗审计实测（D1–D4）：探测失败后若仍 `resolveCredential` 重取并 `send`，
       * 拿到的往往还是**同一份坏凭据** ⇒ 同一 token 被重发一次：
       * ```
       * 无池恒 401    ⇒ 2 次请求（tok-A 发两遍）
       * A 坏 B 好     ⇒ 3 次（自救成功但白烧一次）
       * 8 号全 401    ⇒ 9 次（首号重复；tried 与 LOOMY_MAX_ROTATE 兜住，不是死循环）
       * ```
       * ⇒ 正确做法：探测失败就**跳过重取与重发**，直接落到下面的 `!response.ok`
       *   换号循环。`activeAccountId` 已在 `tried` 里，换号自然从下一个号开始。
       *   实测：A401→B 正常 ⇒ SUCCESS 且 `auth=["tok-A","tok-B"]`（不重发 A）；
       *   8 号全 401 ⇒ 请求数 **1**。
       */
      let probeFailed = false
      try {
        await this.options.refresh()
      } catch (error) {
        // 终态（凭据确实失效）仍然原样抛：那是「请重新登录」这条唯一出路。
        if (isLoomyTerminalRefreshError(error)) throw error
        probeFailed = true
        this.options.warn?.(
          `[loomy] 401/403 后凭据探测失败（非终态，改走换号）：${
            error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!probeFailed) {
        const refreshed = await this.options.resolveCredential(options.model, options.sessionId)
        if (refreshed === undefined || refreshed.access_token.length === 0) {
          throw new LlmError('loomy: credential expired and refresh failed', 'AUTH', { status: response.status })
        }
        /**
         * ⚠️ **必须跟着重新反查账号 id**（与 raccoon 的 `51ded6a` 同款缺陷）。
         *
         * `options.resolveCredential` 是**池优先 + 余额分档**的（见 `src/index.ts`
         * 的 loomy 分支：先 `loomyBalanceSelector.select()` 再解析该号的 ref），
         * 而 `refresh()` 探测/续期的是**池当前默认账号**
         * （`pool.getAvailableAccount(LOOMY.id, '')`）—— 二者可能不是同一个号。
         * ⇒ 续期后取回的凭据**可能属于另一个账号**，但 `activeAccountId` 还停在
         * 刷新前的那个号上。
         *
         * 后果（与 raccoon 实测到的完全一致）：A 的 token 失效 → 刷新后拿到 B 的
         * 凭据 → B 随后返回额度耗尽，而 24h 冷却标记**记在 A 头上** ⇒ 没耗尽的 A
         * 被封、真该封的 B 下次仍被选中（本段要修的「卡死在一个号上」照旧）。
         * 这与 AGENTS.md 记的 Qoder「标记用了会变的回调导致标错账号」同型。
         */
        if (this.options.accountPool) {
          try {
            activeAccountId = await this.options.accountPool.findAccountIdByCredential(
              this.product.id, refreshed.access_token,
            ) ?? ''
          } catch { /* 反查失败不阻断主路径：轮换退化为「不标记」 */ }
        }
        response = await send(refreshed.access_token)
        if (response.ok) credential = refreshed
      }
    }

    /**
     * ⚠️⚠️ **`HTTP 200 + 业务码 100002` 也算认证失败**（2026-10-20 审计 E-1）。
     *
     * Loomy 的业务失败**恒 HTTP 200**（`src/loomy.ts` 的协议说明：
     * 「带错的那个 → HTTP 200 + `{"code":"100002","desc":"缺少 token"}`」），
     * 而下面的换号循环只写在 `if (!response.ok)` 里 ⇒ 200 的认证失败
     * **一次都不换号**，终错是 `SERVER`（`响应不是 SSE`）而不是 `AUTH`。
     * 多账号场景下**从未尝试过好号**。
     *
     * ## 为什么在这里「合成」一个失败响应，而不是另写一条换号流程
     *
     * 换号循环里已经有 `tried` / `LOOMY_MAX_ROTATE` / 冷却记账 / 全部失败才报错
     * 这一整套语义（含 2026-10-06 的「认证类不写冷却」铁律）。
     * 另起一条必然漂移。⇒ 把 200 的认证失败**重建成一个**
     * `status: 401` 的响应，让既有循环原样接管 —— 复用的不只是代码，
     * 是那套**已经被事故验证过的语义**。
     *
     * ## ⚠️ 只在**非 SSE** 上做（边界如实登记）
     *
     * 判据必须先看 `content-type`：SSE 流**不能**先 `text()` 读干（那会把正文吃掉，
     * 用户看到空回复）。故本腿只覆盖「JSON 信封」这一形态 —— 也正是最常出现的
     * 那一形态（上游回错误信封而非流）。SSE 内嵌错误帧（`data:` 帧里带 `100002`）
     * 仍由 `consumeOpenAiSse` 处理，**本腿不管**，属已登记的残余面。
     */
    const authBusinessFailure = await this.rebuildAuthBusinessFailure(response)
    if (authBusinessFailure !== undefined) response = authBusinessFailure

    if (!response.ok) {
      let errorText = await response.text().catch(() => '')
      let status = response.status
      /**
       * 请求级账号轮换（2026-10-05，用户报障「余额用完一个号就卡死」）。
       *
       * ## 为什么余额选号器救不了这个场景
       *
       * `loomy-balance-selector` 只在**取号时**按余额分档——余额查询与
       * 实际扣费是两个时刻：查询时有钱、推理请求打过去时上游判额度耗尽
       * （`14018 Credits exhausted`，日额度按次计费）。错误抛给 harness 后，
       * 下次取号余额查询仍返回同样的排序，**同一个号被再次选中** ⇒
       * 「卡死在一个号上」，直到它的余额 API 也刷新为止。
       *
       * ## 语义对齐 buddy
       *
       * - **可换**：额度耗尽（14018 / Credits / 积分不足等）、429、认证（401/403）；
       *   **不可换**：其余 4xx（换号无益，按原错误抛）。
       * - **每个账号只试一次**（`tried` 传池）。
       * - **只有配额 / 限流类才写冷却**（24h / 1h）；**认证类只换号、绝不写标记**
       *   —— 详见 {@link LoomyFailureClass} 记的 2026-10-06 全池被封事故。
       * - **全部试完才报错**，带最后一次的真实原因。
       * - ⚠️ 换到的号**绕过余额选号器**（直接用池的候选凭据）——选号器的
       *   排序在「有余额的号」内部才有意义，此处候选已明确是坏号链，
       *   池的手动顺序就是最合理的次序。
       */
      let failureClass = classifyLoomyFailure(errorText, status)
      const accountPool = this.options.accountPool
      if (accountPool && failureClass !== 'other') {
        const tried = new Set<string>()
        if (activeAccountId) tried.add(activeAccountId)
        /**
         * 给**当前**账号记冷却（配额 24h / 限流 1h），认证类不记。
         *
         * ⚠️ 必须**每次失败后立刻调用**（含第一次、也在轮换预算用尽之前），
         * 不能挪到 `for` 循环开头：那样最后一个失败账号永远等不到下一次迭代，
         * 就此漏记。实测（8 账号全耗尽）：挪在循环开头只记 7/8，末号漏记。
         * 漏记的后果是下次请求又选中它 —— 正是本段要修的「卡死在一个号上」。
         *
         * ⚠️ 闭包读的是**实时**的 `activeAccountId` / `failureClass`（二者都在
         * 循环内更新），不是创建时的快照 ⇒ 每次记的都是刚失败的那个号。
         * 同款「用回调取当前账号会标错号」的坑见 AGENTS.md 的 Qoder 第 9 条。
         */
        const markCurrentAccount = async (): Promise<void> => {
          // ⚠️ auth 类**不写标记**：认证失败是账号态而非模型冷却，写了会把
          //    网关侧授权故障放大成「全池封 24h」（2026-10-06 事故）。
          if (!activeAccountId || !recordsLoomyRateLimit(failureClass)) return
          await accountPool.updateModelRateLimit(
            activeAccountId,
            options.model,
            // ⚠️ 时长按类别算：quota = **UTC+8 当日 24:00**（自然日重置，不是 +24h，
            //    见 `loomyCooldownResetAtMs` 记的 Gitee IKL80H）；rate = +1h。
            loomyCooldownResetAtMs(failureClass),
          )
        }
        await markCurrentAccount()
        const maxRotate = LOOMY_MAX_ROTATE - 1
        for (let round = 0; round < maxRotate; round++) {
          const next = await accountPool.getAvailableAccount<LoomyCredential>(
            this.product.id, options.model, tried,
          )
          if (!next || tried.has(next.entry.id)) break
          tried.add(next.entry.id)
          const nextCred = next.credential
          if (nextCred === undefined || nextCred.access_token.length === 0) break
          activeAccountId = next.entry.id
          response = await send(nextCred.access_token)
          if (response.ok) {
            credential = nextCred
            // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回（既有说明见下）。
            yield* consumeOpenAiSse(response, { signal: options.signal }, {
              label: 'loomy',
              firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
              chunkTimeoutMs: resolveChunkTimeoutMs(),
              ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
            })
            return
          }
          errorText = await response.text().catch(() => '')
          status = response.status
          failureClass = classifyLoomyFailure(errorText, status)
          await markCurrentAccount()
          if (failureClass === 'other') {
            throw new LlmError(`loomy: ${errorDetail(errorText)}`, httpErrorCode(status), { status })
          }
        }
        throw new LlmError(
          `loomy: 模型 ${options.model} 所有账号均不可用（${errorDetail(errorText)}）`,
          failureClass === 'rate' ? 'RATE_LIMIT'
            : failureClass === 'auth' ? 'AUTH'
              : 'QUOTA_EXCEEDED',
          { status },
        )
      }
      throw new LlmError(`loomy: ${errorDetail(errorText)}`, httpErrorCode(status), { status })
    }

    // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回，由 consumeOpenAiSse 处理。
    yield* consumeOpenAiSse(response, { signal: options.signal }, {
      label: 'loomy',
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs(),
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    })
  }
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_LOOMY_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_LOOMY_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/**
 * 在 `ctx.llm` 上注册 Loomy provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerLoomyLlm(ctx: Context, options: LoomyAdapterOptions): LoomyAdapter {
  const product = options.product ?? LOOMY
  const adapter = new LoomyAdapter({
    ...options,
    // ⚠️ 注入**唯一**的广播实现（`src/catalog-broadcast.ts`），不要在这里
    // 另写一份 emit —— 两份实现必然漂移（issue IKJVTF 的缺陷① 就是「十处全漏」）。
    onCatalogLoaded: () => broadcastCatalogChanged(ctx),
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
