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
import { createModelCatalog, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import {
  isLoomyChatModel,
  isLoomyExpired,
  loomyChatHeaders,
  loomyDisplayName,
  splitLoomyRate,
  type LoomyCredential,
} from './loomy.js'
import { LOOMY, loomyContextWindow, loomySupportsImage, type LoomyFallbackModel, type LoomyProduct } from './loomy-product.js'
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
  resolveCredential: (modelId?: string) => Promise<LoomyCredential | undefined>
  /**
   * 凭据失效时的处理。
   *
   * ⚠️ Loomy **没有 refresh 端点**，故实现只做**有效性探测**并在失效时抛错，
   * 不会（也无法）续期。
   */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<LoomyRemoteModel[]>
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
        syncCatalog: () => this.syncCatalogEntries(),
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
    if (this.remoteModels !== undefined) return this.remoteModels
    const fetchRemote = this.options.fetchRemoteModels
    if (fetchRemote !== undefined) {
      await this.catalogGate.run(async () => {
        const fetched = await fetchRemote()
        if (fetched.length === 0) return false
        this.remoteModels = fetched
        return true
      })
      if (this.remoteModels !== undefined) return this.remoteModels
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
   */
  private reasoningFor(
    entry: LoomyRemoteModel | undefined,
    fallback: LoomyFallbackModel | undefined,
  ): LlmResolvedModelInfo['reasoning'] {
    // 远端优先；远端整体失败时用兜底表（两者字段同名同形）。
    const efforts = entry?.efforts ?? fallback?.efforts
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
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isLoomyExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
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
    const effortsForModel = (await this.loadModels()).find((m) => m.id === options.model)?.efforts
      ?? this.fallbackIndex.get(options.model)?.efforts
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
      await this.options.refresh()
      const refreshed = await this.options.resolveCredential(options.model)
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
            throw new LlmError(`loomy: ${errorDetail(errorText)}`, httpErrorCode(status, errorText), { status })
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
      throw new LlmError(`loomy: ${errorDetail(errorText)}`, httpErrorCode(status, errorText), { status })
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
