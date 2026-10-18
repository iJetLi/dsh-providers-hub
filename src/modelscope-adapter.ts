/**
 * ModelScope（魔搭）LLM 适配器。
 *
 * ## 协议形态：**标准 OpenAI 兼容**，无任何厂商私有信封
 *
 * 与 qoder（WASM 签名 + 加密体）、trae（SOLO 双层转换）、gemini（字母序双层
 * 信封）不同，魔搭就是标准 OpenAI 协议 —— 这正是它能**大面积复用共享抽象**的
 * 原因：
 *
 * | 复用点 | 来源 |
 * |---|---|
 * | 消息序列化（含 0.1.7 形状归一化、工具配对剔除、图片 parts） | `openai-compat.ts` 的 `serializeMessages` |
 * | 图片引用收集 | `openai-compat.ts` 的 `collectImages` |
 * | SSE 消费（思考字段、工具增量合并、截断判定） | `openai-compat.ts` 的 `consumeOpenAiSse` |
 * | 幂等注册 + Token 记账 + 失效模型剔除 | `llm-register-compat.ts` 的 `registerAdapterIdempotent` |
 * | 附件字节桥接 | 接线层的 `makeReadImage` / `makeReadImageRequest` |
 *
 * **本文件不重复实现上述任何一条** —— 旧 fork 那份 `remote-upstream.ts` 曾把
 * 消息序列化与 SSE 解帧各写一遍（且与另外两份实现**不一致**，实测漏掉了
 * `prompt_tokens_details.cached_tokens`，导致魔搭承接的步长永远显示「缓存命中 0」，
 * 见旧 fork `src/transport/usage.ts:4-8`）。这里直接走共享实现，从根本上避免分叉。
 *
 * ## 轮换语义：「类别 → 动作」表（不照抄循环骨架）
 *
 * AGENTS.md 有一节专门讲这个（2026-10-06 的事故：照抄循环骨架、漏抄分支语义表，
 * 导致全池 6 个账号各被封 24h）。本适配器的表：
 *
 * | 类别 | 换号？ | 写限流标记？ | 抛什么 |
 * |---|---|---|---|
 * | `auth`（401/403） | 换 | **不写** | 全试完则抛 `AUTH`（保留服务端原文） |
 * | `rate_limit`（429） | 换 | **写**（服务端给了 `retry-after` 就用它，否则指数退避、封顶 30 分钟） | 全试完抛 `QUOTA_EXCEEDED` |
 * | `quota`（额度耗尽） | 换 | **写**（当日 24h） | 同上 |
 * | `invalid_request`（400/422） | **不换** | 不写 | 直接抛 `BAD_REQUEST` |
 * | `server`（5xx） | 换 | **不写**（不是配额问题） | 全试完抛原错误 |
 * | `transport`（网络） | 换 | **不写** | 全试完抛原错误 |
 *
 * ⚠️ **认证类绝不写限流标记**：魔搭的网关在异常时可能对全池回 401，
 * 若按「凡可换号就写冷却」处理，一个请求内就能把整池账号全部标记掉
 * （正是 2026-10-06 事故的形态）。
 *
 * ## ⚠️ 已产出内容的流不重放
 *
 * 轮换只在**尚未 yield 任何 chunk** 时发生。一旦开始产出，再失败只能上抛 ——
 * 否则用户会看到两份重复输出（`openai-compat` 的模块头有同款说明）。
 *
 * @module src/modelscope-adapter.ts
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountPool } from './account-pool.js'
import { providerCatalogVisible } from './account-pool.js'
import {
  MODELSCOPE,
  MODELSCOPE_FALLBACK_MODELS,
  classifyModelscopeError,
  type ModelscopeErrorInfo,
  type ModelscopeErrorKind,
  type ModelscopeFallbackModel,
  type ModelscopeProduct,
} from './modelscope-product.js'
import { modelscopeChatUrl, modelscopeHeaders, modelscopeModelsUrl, normalizeModelscopeModelId } from './modelscope.js'
import { buildModelscopePayload } from './modelscope-messages.js'
import { collectImages, consumeOpenAiSse, httpErrorCode, serializeMessages } from './openai-compat.js'
// ⚠️ 复用**共享** abort 判据，不自写第二份（该函数自己的注释记载：仓库此前已有
//    4 份同义实现，明令「别再添第五份」）。
import { isAbortLike } from './aggregate-adapter.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import { retryAfterMsFromResponse } from './retry-after.js'
import { reportLedgerAccount } from './token-ledger.js'

/** 目录条目（远端与兜底共用的输出形状）。 */
export interface ModelscopeCatalogEntry {
  id: string
  name: string
  contextWindow: number
  supportsImage: boolean
  efforts?: readonly string[]
}

/** 默认目录缓存 TTL（5 分钟，与 opencode 同档）。 */
const DEFAULT_CATALOG_TTL_MS = 300_000

/**
 * 目录缓存。
 *
 * ⚠️ 按 **apiKey** 分开存：不同账号（不同区/不同额度档）可见的模型可能不同 ——
 * 共用一份缓存会让新加的账号迟迟看不到它自己那批模型（与 opencode 同因）。
 */
const catalogCache = new Map<string, { at: number; entries: readonly ModelscopeCatalogEntry[] }>()

/** 清空目录缓存（RPC 的「刷新目录」与单测隔离用）。 */
export function clearModelscopeCatalogCache(): void {
  catalogCache.clear()
}

/** 远端目录拉取（注入以便单测离线）。 */
export type ModelscopeCatalogFetcher = (apiKey: string, signal?: AbortSignal) => Promise<Response>

/** 拉目录时的凭据提供者（返回 undefined 表示无可用账号）。 */
export type ModelscopeCredentialProvider = () => Promise<{ apiKey: string } | undefined>

interface RawRemoteModel {
  id?: unknown
  name?: unknown
  context_window?: unknown
  limit?: { context?: unknown }
  modalities?: { input?: unknown }
}

/**
 * 解析远端 `GET /v1/models` 的响应体。
 *
 * ## ⚠️ 三个字段都**尽力而为**，拿不到就回落到兜底表的值
 *
 * 实测（旧 fork 反代）：魔搭的 `/v1/models` 返回标准 OpenAI 目录形状
 * `{ data: [{ id, object, created, owned_by }] }`，
 * **不一定**带窗口/模态信息。故：
 *
 * - `context_window` / `limit.context` 两个来源都试 —— 拿不到时**从兜底表按
 *   id 查**（查到就用，查不到留 `0` 哨兵）。⚠️ **绝不编造数字**：
 *   `contextWindow` 是 DSH 自动压缩阈值的输入，编一个会让压缩在错误的位置触发
 *   （opencode 的 issue IKJJ68 同因）；
 * - `modalities.input` 含 `image` 才算支持图片；拿不到时同样回落到兜底表 ——
 *   本仓库的硬约定是「**声明支持就必须真支持**」，故**未知一律按不支持**处理
 *   （除兜底表里明确记着支持的）；
 * - 窗口/模态**都只认「远端明确给出」或「兜底表明确记着」**，不猜。
 */
export function parseModelscopeCatalog(body: unknown): ModelscopeCatalogEntry[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const entries: ModelscopeCatalogEntry[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as RawRemoteModel
    const id = typeof record.id === 'string' ? normalizeModelscopeModelId(record.id) : ''
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const fallback = MODELSCOPE_FALLBACK_MODELS.find((m) => m.id === id)
    const name = typeof record.name === 'string' && record.name.trim().length > 0
      ? record.name.trim()
      : fallback?.name ?? id
    const remoteCtx = typeof record.context_window === 'number'
      ? record.context_window
      : typeof record.limit?.context === 'number' ? record.limit.context : 0
    const contextWindow = Number.isSafeInteger(remoteCtx) && remoteCtx > 0
      ? remoteCtx
      : fallback?.contextWindow ?? 0
    // ⚠️ 未知一律按**不支持**图片（硬约定：声明支持就必须真支持）。
    // 只有远端明确列了 image，或兜底表明确记着支持，才算支持。
    const remoteModalities = Array.isArray(record.modalities?.input)
      ? record.modalities.input.filter((v): v is string => typeof v === 'string')
      : undefined
    const supportsImage = remoteModalities === undefined
      ? fallback?.supportsImage ?? false
      : remoteModalities.includes('image')
    entries.push({
      id,
      name,
      contextWindow,
      supportsImage,
      ...fallback?.efforts === undefined ? {} : { efforts: fallback.efforts },
    })
  }
  return entries
}

/**
 * 拉取远端目录，失败回退静态兜底。
 *
 * @param ttlMs 命中内存缓存的窗口；测试传 0 强制每次都拉。
 *
 * ⚠️ **必须有超时**（接线层给）：桌面版到外部域名的 fetch 可能**永不 settle**
 * （opencode 的真机事故 2026-10-02：没有超时 → `listModels` 永不返回 →
 * **模型列表与徽标同时空白**）。有超时则超时后回退兜底表，UI 立刻可用。
 */
export async function loadModelscopeCatalog(
  fetchCatalog: ModelscopeCatalogFetcher,
  apiKey: string,
  ttlMs: number = DEFAULT_CATALOG_TTL_MS,
  signal?: AbortSignal,
): Promise<readonly ModelscopeCatalogEntry[]> {
  const cached = catalogCache.get(apiKey)
  if (cached !== undefined && ttlMs > 0 && Date.now() - cached.at < ttlMs) return cached.entries
  let entries: readonly ModelscopeCatalogEntry[]
  try {
    const response = await fetchCatalog(apiKey, signal)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const parsed = parseModelscopeCatalog(await response.json())
    if (parsed.length === 0) throw new Error('空目录')
    entries = parsed
  } catch {
    entries = MODELSCOPE_FALLBACK_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      supportsImage: m.supportsImage,
      ...m.efforts === undefined ? {} : { efforts: m.efforts },
    }))
  }
  catalogCache.set(apiKey, { at: Date.now(), entries })
  return entries
}

/** 一个可发起请求的槽（账号）。 */
export interface ModelscopeSlot {
  readonly id: string
  readonly apiKey: string
}

export interface ModelscopeAdapterOptions {
  /**
   * 单凭据回退 ref（无账号池条目时用）。
   *
   * ⚠️ 类型是 `unknown` 而不是品牌类型 `CredentialRef` —— 本适配器**不用它做
   * 解析**（凭据一律经 `slots()` 由接线层解析好传进来），保留这个字段只为与
   * 其余 15 个 `registerXxxLlm` 的选项形状一致，避免调用方误以为「不传就少了
   * 一条解析路径」。做成 `unknown` 可免去在适配器里 import 凭据模块的类型。
   */
  credentialRef?: unknown
  /**
   * 取当前可用槽序列（按账号池的手动顺序）。
   *
   * @param modelId 目标模型。**推理路径必须传**，接线层据此过滤掉
   *   「该模型正处于限流窗口」的账号（与其余 15 家的 `getAvailableAccount` 同语义，
   *   见 `src/index.ts` 的 `throwIfAllAccountsRateLimited`）。
   *   ⚠️ **目录路径刻意不传**：目录要的是「这个渠道有哪些模型」，
   *   与「哪个账号此刻被限流」无关；传了会让被限流的账号把整个目录一起拖空。
   */
  slots: (modelId?: string) => Promise<readonly ModelscopeSlot[]>
  /** 用户模型黑名单。 */
  disabledModels?: () => ReadonlySet<string>
  /** 账号池（目录门控用）。 */
  accountPool?: AccountPool
  /** 记录受限的副作用（切槽时由接线层提供）。 */
  markLimited?: (slotId: string, modelId: string, resetAtMs: number) => Promise<void>
  /** 诊断日志。 */
  warn?: (message: string) => void
  /**
   * 附件字节读取。**只有在模型被声明为支持图片时才会被调用**。
   *
   * ⚠️ 缺省时带图请求会抛 `UNSUPPORTED_CONTENT`（见 `resolveImageUrls`），
   * 而不是把图片静默丢掉（Qoder 图片丢失事故的教训：模型看不到图却照常回答，
   * 用户拿到的是幻觉结果）。
   */
  readImage?: (ref: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 拉远端目录；缺省时直接用兜底表。 */
  fetchRemoteCatalog?: ModelscopeCatalogFetcher
  /** 产品配置；默认 {@link MODELSCOPE}。 */
  product?: ModelscopeProduct
}

/** 限流退避上限：服务端再狠也不让它单次阻塞超过 30 分钟。 */
const RETRY_AFTER_CAP_MS = 30 * 60_000
/** 首次 429 的默认冷却。 */
const RATE_LIMIT_BASE_MS = 60_000

/**
 * 把「错误语义 + 服务端给的延迟」换算成该槽该模型的受限时长。
 *
 * ⚠️ **服务端给了就用它的**，且 **0 是合法值**（「立即解除」而非「未知」）：
 * 必须用 `=== undefined` 判空，写成任何 falsy 判据都会把 0 静默换成 1 小时
 * （`src/retry-after.ts` 的模块头记录了这条教训）。
 */
export function modelscopeRetryAfterMs(
  kind: ModelscopeErrorKind,
  retryAfterMs: number | undefined,
  attempt: number,
  /** 注入时钟（单测用）；默认 `Date.now()`。与仓库其它时间函数同约定。 */
  nowMs: number = Date.now(),
): number {
  if (retryAfterMs !== undefined) return Math.max(0, Math.min(retryAfterMs, RETRY_AFTER_CAP_MS))
  // ⚠️ 额度耗尽的冷却必须对齐**魔粒的重置时刻**，不能用固定 24h。
  //
  // 魔搭的额度规则（用户 2026-07-14 当面确认，与网页控制台一致）：
  //   - 每个账号**每日 250 魔粒**，**按 UTC+8 自然日重置**；
  //   - 旗舰档模型（deepseek-v4.1-flash / v4-pro 等）**每次调用固定扣 2 魔粒**，
  //     与 token 数无关 ⇒ 一天约 125 次调用。
  //
  // 用固定 24h 的问题：在 23:50 撞到额度耗尽，会被冷却到**次日 23:50** ——
  // 而额度次日 00:00 就恢复了，白等近 24 小时（旧 fork `key-pool.ts` 记录了
  // 同款现象，它当时用「固定 1 小时 TTL」近似，代价是要反复空试）。
  // 复用仓库既有的 `nextUtc8DayStartMs()`（`model-queue.ts`，与签到/聚合
  // 同一口径），一次算准。
  if (kind === 'quota') return Math.max(0, nextUtc8DayStartMs(nowMs) - nowMs)
  return Math.min(RATE_LIMIT_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_AFTER_CAP_MS)
}

export class ModelscopeAdapter extends LlmAdapter {
  private readonly product: ModelscopeProduct
  /**
   * 最近一次成功解析出的目录快照（**仅供同步路径**读取）。
   *
   * ⚠️ 它不是缓存 —— 权威缓存仍是 `loadModelscopeCatalog` 那份带 TTL 的
   * （见 `catalog()` 的注释：在适配器上另立缓存会让目录永不过期）。
   * 这里只是把「上一次的结果」留给 `listAllModels()` 那个**必须同步**的调用者。
   */
  private lastCatalog?: readonly ModelscopeCatalogEntry[]

  constructor(private readonly options: ModelscopeAdapterOptions) {
    super()
    this.product = options.product ?? MODELSCOPE
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**同步**返回数组）。
   *
   * ⚠️ **绝不能写成 async**：`jet-hub-rpc.ts` 的 `ModelCatalogSource` 接口是
   * 同步的且消费者**不 await**（`catalog = [...all]`），返回 Promise 会抛
   * `TypeError: all is not iterable`（minimax 的同款真实缺陷）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    // ⚠️ 远端优先，但**必须同步返回**（见上方注释）：故读的是**上一轮**拉到的缓存，
    // 缓存为空时用兜底表，并**顺手**触发一次后台刷新 —— 下次调用即拿到远端目录。
    // 这与 cline 的 `this.remoteModels ?? this.fallbackCatalog()` + `ensureRemoteModels()`
    // 是同一范式（见 `cline-adapter.ts:480`）。
    //
    // 为什么必须这么做：「显示列表」（模型黑名单）逐 id 开关，来源正是本方法。
    // 只回兜底表的两个模型 ⇒ 远端另外几十个模型**在 UI 里根本不存在**，
    // 用户无从开关（真实缺陷，2026-07-14 实测：魔搭远端 35 个、兜底 2 个）。
    const remote = this.snapshotCatalog()
    if (remote !== undefined) return remote.map((m) => ({ id: m.id, name: m.name }))
    void this.warmCatalog()
    return MODELSCOPE_FALLBACK_MODELS.map((m) => ({ id: m.id, name: m.name }))
  }

  /**
   * 同步取「已缓存的远端目录」；没有缓存则返回 undefined。
   *
   * ⚠️ 只读缓存、**绝不发起网络请求** —— 本方法在 UI 的同步路径上被调用
   * （`catalog = [...all]`，见 `jet-hub-rpc.ts` 的 `fullCatalogIds`）。
   */
  private snapshotCatalog(): readonly ModelscopeCatalogEntry[] | undefined {
    const cached = this.lastCatalog
    return cached === undefined || cached.length === 0 ? undefined : cached
  }

  /** 后台预热一次目录；失败静默（兜底表已保证 UI 可用）。 */
  private async warmCatalog(): Promise<void> {
    try {
      await this.catalog()
    } catch {
      // 兜底表已保证可用，预热失败不值得打扰用户。
    }
  }

  /** 当前生效的目录（远端优先，失败回退兜底）。 */
  private async catalog(): Promise<readonly ModelscopeCatalogEntry[]> {
    const slots = await this.options.slots()
    const slot = slots[0]
    if (this.options.fetchRemoteCatalog === undefined || slot === undefined) {
      // ⚠️ 这里**不写** lastCatalog：没有远端能力时它永远是兜底表，
      // 记下来只会让 listAllModels 走一条与本分支结果相同的弯路。
      return MODELSCOPE_FALLBACK_MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        supportsImage: m.supportsImage,
        ...m.efforts === undefined ? {} : { efforts: m.efforts },
      }))
    }
    // ⚠️ **不要**在适配器上再 memoize 一份：那会让目录永不过期。
    // 刷新职责交给带 TTL 的 `loadModelscopeCatalog`。
    const entries = await loadModelscopeCatalog(this.options.fetchRemoteCatalog, slot.apiKey)
    // 留给 `listAllModels()`（它必须同步返回）。只记远端**成功**的结果；
    // 兜底表已由 `loadModelscopeCatalog` 在失败时返回，记不记都一样。
    this.lastCatalog = entries
    return entries
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 目录门控：没有已登录账号就返回空数组隐藏整个 provider（AGENTS.md 的
    // 「没有已登录账号就隐藏整个 provider」）。**不抛错** —— 抛错会多一条
    // provider 级报错，UI 表现为「供应商加载失败」。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []
    const slots = await this.options.slots()
    if (slots.length === 0) return []
    const all = await this.catalog()
    const disabled = this.options.disabledModels?.() ?? new Set<string>()
    return all
      .filter((m) => !disabled.has(m.id))
      .map((m) => ({
        provider: this.product.id,
        id: m.id,
        name: m.name,
        // ⚠️ 能力表缺失/未知时**一律回退 `['text']`**（硬约定：声明支持就必须
        // 真支持）。把「查不到」当成「支持」会让 DSH 把图片投影成上游不接受的形态。
        inputModalities: m.supportsImage
          ? (['text', 'image'] as const)
          : (['text'] as const),
      }))
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const id = normalizeModelscopeModelId(model)
    const all = await this.catalog()
    const entry = all.find((m) => m.id === id)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id,
      name: entry?.name ?? id,
      inputModalities: entry?.supportsImage === true
        ? (['text', 'image'] as const)
        : (['text'] as const),
    }
    // ⚠️ 窗口未知**不编造**：0 是「不知道」哨兵，不能当合法窗口下发 ——
    // 自动压缩会拿它算阈值并抛
    // `TargetPressureConfigError: contextWindow (…) must be a positive integer`。
    const contextWindow = entry?.contextWindow ?? 0
    if (contextWindow > 0) resolved.context = { contextWindow }
    // ⚠️ 档位为**空**时**不声明**本字段（而不是给 `efforts: []`）：
    // DSH 的判定是 `resolved.reasoning === undefined ? undefined : {…}`，
    // 声明空数组会让 UI 出现一个没有任何档位的空选择器（opencode 的 issue IKJJ0V）。
    const efforts = entry?.efforts ?? []
    if (efforts.length > 0) {
      resolved.reasoning = {
        efforts: efforts.map((effort) => ({
          // ⚠️ `id` 是**品牌类型**（`ReasoningEffortId`），必须经它的构造函数。
          id: ReasoningEffortId(effort),
          // ⚠️ 没有官方中文名时回退到 id 本身 —— 宁可显示英文原值，
          // 也不猜一个可能错译的中文（与 opencode 同取向）。
          name: effort === 'none' ? '关闭' : effort,
        })),
      }
    }
    // ⚠️ **刻意不声明 `defaultMaxTokens`**：DSH 的契约是「用户未指定
    // `max_tokens` 时直接拿它填请求」，而下发等于**我们替用户决定**每轮按上限
    // 请求。魔搭的能力表里根本没有可靠的输出上限来源 ⇒ 不下发。
    return resolved
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return { model: await this.resolveModel(provider, model, signal), stream: (o) => this.stream(o) }
  }

  /**
   * 解析消息里的图片附件为 data URL。
   *
   * ⚠️ **模型不支持图片时直接抛 `UNSUPPORTED_CONTENT`**（而不是静默丢弃）——
   * 静默丢弃会让用户以为模型看到了图（Qoder 图片事故的教训）。
   * ⚠️ 附件字节读不出来时**不写入该条**：`openai-compat` 的
   * `userContentParts` 遇到缺失会产出 `[image unavailable]` 占位，
   * 至少让模型知道「这里本该有张图但没拿到」，而不是消息里凭空少一块。
   */
  private async resolveImageUrls(
    model: string,
    messages: readonly { content: unknown }[],
  ): Promise<ReadonlyMap<string, string> | undefined> {
    const refs = new Map<string, unknown>()
    for (const message of messages) {
      if (Array.isArray(message.content)) collectImages(message.content, refs)
    }
    if (refs.size === 0) return undefined

    const all = await this.catalog()
    const entry = all.find((m) => m.id === normalizeModelscopeModelId(model))
    if (entry?.supportsImage !== true) {
      throw new LlmError(
        `modelscope: 模型 "${model}" 不支持图片输入（能力以远端目录/兜底表为准）`,
        'UNSUPPORTED_CONTENT',
      )
    }
    if (this.options.readImage === undefined) {
      throw new LlmError('modelscope: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
    }
    const readImage = this.options.readImage
    const out = new Map<string, string>()
    for (const [id, ref] of refs) {
      const image = await readImage(ref)
      if (image === undefined) continue
      out.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
    }
    return out
  }

  /**
   * 轮换：失败按「语义」标记该槽 → 换下一槽重发。
   *
   * 三条硬规则（见模块头的表）：
   * 1. `tried` **跨迭代保留** —— 每次重置会让两个槽之间无限来回；
   * 2. **已交付内容的流不重放**；
   * 3. **认证类不写限流标记**（写它会放大成「全池被封」）。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // ⚠️ 传 modelId：接线层据此跳过「该模型正处于限流窗口」的账号。
    const slots = await this.options.slots(options.model)
    if (slots.length === 0) {
      throw new LlmError(
        'modelscope: 没有可用账号。请在 Jet Hub 的 ModelScope 面板粘贴一个 API Key'
        + '（https://modelscope.cn/my/myaccesstoken 生成）。',
        'MISSING_CREDENTIAL',
      )
    }

    const tried = new Set<string>()
    const limited: string[] = []

    for (;;) {
      const slot = slots.find((s) => !tried.has(s.id))
      if (slot === undefined) {
        throw new LlmError(
          `modelscope: 所有账号对该模型均受限${limited.length > 0 ? `（${limited.join('、')}）` : ''}`,
          'QUOTA_EXCEEDED',
        )
      }
      tried.add(slot.id)
      // Token 账本：回报「本笔请求实际使用的槽」。
      reportLedgerAccount(this.product.id, slot.id)

      let delivered = false
      try {
        for await (const chunk of this.streamVia(slot, options)) {
          // ⚠️ **任何 chunk 产出都算「已交付」**：`StreamChunk` 联合里没有
          // 「内容之前的前置事件」，保守取「一律算交付」—— 宁可漏掉一次可切换
          // 的机会，也绝不重放。
          delivered = true
          yield chunk
        }
        return
      } catch (error) {
        if (delivered) throw error
        if (error instanceof LlmError && error.code === 'QUOTA_EXCEEDED') throw error
        // ⚠️⚠️ **取消 / 超时必须在此立刻抛出，且排在所有分类之前**
        //    （2026-10-17 审计 P2 修复）。此前轮换循环**从不检查中止**：取消产生的
        //    `AbortError` 消息不命中任何分类关键词 ⇒ 落到兜底 `server` 分支 ⇒ 被当成
        //    「换个号再试」⇒ 取消之后**继续发请求**（实测取消后仍多打 2 次），且全池
        //    耗尽后抛 `QUOTA_EXCEEDED`「所有账号对该模型均受限」—— 用户明明点了取消，
        //    看到的却是「额度用尽」。
        //    ⚠️ 用**共享** `isAbortLike`（`aggregate-adapter.ts` 导出，仓库唯一一份）：
        //    它覆盖 `signal.aborted`、`AbortError`、`code === 'ABORTED'` 与上游 499 报文。
        if (isAbortLike(error, options.signal)) {
          throw error
        }

        const info = classifyModelscopeFailure(error)
        if (info.kind === 'invalid_request') {
          // 400/422：**换号无益**（每个槽发的是同一个体，形状问题与账号无关），
          // 且魔搭对形状极严格（工具未包装事故）⇒ 带上服务端原文直接上抛。
          throw new LlmError(
            `modelscope: 请求被上游拒绝（${info.detail}）`,
            'BAD_REQUEST',
          )
        }
        if (info.kind === 'auth') {
          // 认证失败：**标记并切下一个账号是对的，但不写限流标记**。
          // 也不能在试完全部槽后报「所有账号均受限」—— 真实原因通常是
          // 「这条 Key 无效」，与额度无关。故最后一次失败**直接透传原文**。
          if (tried.size >= slots.length) throw error
          limited.push(`${slot.id}(认证失败)`)
          continue
        }
        if (info.kind === 'server' || info.kind === 'transport') {
          // 上游故障/网络问题：**不写标记**（不是配额问题），只换下一个。
          this.options.warn?.(`modelscope: 账号 ${slot.id} ${info.kind}，换下一个：${info.detail}`)
          // ⚠️⚠️ **换号有意义只在「故障是账号级」时**（2026-10-17 审计 P1 修复）。
          //    本分支此前无条件 `continue` ⇒ 换号直到槽耗尽 ⇒ 兜底那段抛
          //    `QUOTA_EXCEEDED`「所有账号对该模型均受限」。⇒ ① **单账号用户**
          //    （绝大多数）看到的是「额度用尽」而真因是上游 5xx / 风控页，
          //    排障方向完全错；② 每换一个号白发一次请求。
          //    ⇒ 判据：**槽已耗尽**时把**原始错误**抛出去（保留真因与错误码）。
          if (tried.size >= slots.length) throw error
          continue
        }
        if (info.kind === 'context_window') {
          // ⚠️ **本 fork 独有**（2026-10-17 审计 P1 修复）：上下文超限**换账号也没用**
          // —— 它是**请求本身**太大，与哪个账号无关（同一长会话换 10 个号一样报错）。
          //    ⇒ 不写冷却标记、不换号，直接把原文抛出去，让宿主走溢出压缩。
          //    ⚠️ 若漏这一格会落进下面「限流/额度」默认分支 ⇒ 给账号写一个到次日
          //    UTC+8 零点的标记 ⇒ 用户只是消息太长却被封账号一整天
          //    （与 loomy 的滑动窗口缺陷同族）。
          //    ⚠️ 真机取证（2026-10-17）：模型 id 去掉组织前缀会得到
          //    **HTTP 400 `Invalid model id: DeepSeek-V4-Flash-0731`**，且该校验
          //    **发生在鉴权之前**（带合法前缀时同一请求先回 401）⇒ 这类报文是
          //    `invalid_request`（上游已有分支直接抛），不该被当成额度去换号。
          throw error
        }
        // 限流 / 额度：标记该槽后换下一个。
        const resetAtMs = Date.now() + modelscopeRetryAfterMs(info.kind, info.retryAfterMs, tried.size)
        await this.options.markLimited?.(slot.id, options.model, resetAtMs)
        limited.push(`${slot.id}(${info.kind})`)
      }
    }
  }

  /** 指定槽发一次请求（轮换循环的复用单元）。 */
  protected async *streamVia(slot: ModelscopeSlot, options: GenerateOptions): AsyncIterable<StreamChunk> {
    const imageUrls = await this.resolveImageUrls(options.model, options.messages)
    const messages = serializeMessages(
      options.messages as readonly { role: string; content: unknown }[],
      imageUrls,
    )
    const payload = buildModelscopePayload({
      model: normalizeModelscopeModelId(options.model),
      messages,
      ...options.system !== undefined && options.system.length > 0 ? { system: options.system } : {},
      ...options.tools !== undefined ? { tools: options.tools } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      ...options.reasoningEffort !== undefined
        ? { reasoningEffort: String(options.reasoningEffort) }
        : {},
    })
    const response = await fetch(modelscopeChatUrl(this.product), {
      method: 'POST',
      headers: modelscopeHeaders(slot.apiKey, 'text/event-stream'),
      body: JSON.stringify(payload),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (!response.ok) {
      // ⚠️ **必须先读体**：额度/限流的语义在响应体里，而 body 只能读一次 ——
      // 读了不传下去，轮换层只能按状态码猜（把「额度耗尽」误判成「Key 失效」）。
      const text = await response.text().catch(() => '')
      // ⚠️ 只解析一次：头值是 HTTP 日期时，两次调用会算出毫秒级不同的值。
      const retryAfterMs = retryAfterMsFromResponse(response.headers)
      // ⚠️⚠️ **额度必须用字面量 `'QUOTA_EXCEEDED'`，不能交给 `httpErrorCode`**
      // （2026-10-17 审计 P2 修复）。两条理由：
      //   ① `classifyModelscopeError` 的注释明确指出魔搭「额度耗尽时可能回
      //      **401/403** 而不是 429」—— 即**这正是本分支预期会遇到的形态**，
      //      而 `httpErrorCode(401)` = `'AUTH'`。而 `AUTH` 码会把 message 一起吞掉
      //      （`docs/agent-notes/client-ui.md` 记的复发形态：用户只看到
      //      「API 密钥无效」，真实原因那句指路文案连同报文一起消失）；
      //   ② harness 的 `QUOTA_EXCEEDED_CODE` 字面值就是 `'QUOTA'`，客户端会丢掉
      //      message 换成「当前请求的额度已用尽」⇒ 额度必须用字面量。
      // ⇒ 故先跑一次语义分类：额度/限流各自产出**字面量**码，认证才用 `'AUTH'`。
      // ⚠️ 语义判对而错误码判错，比两者都判错更危险 —— 它会让正确的分类
      //    在传输途中被换掉，用户看到的是误导性的文案。
      const info = classifyModelscopeError(response.status, text, {
        // ⚠️ `Headers` 无索引签名、不是 `Record<string,string>` ⇒ 必须显式转。
        //    只取 `retry-after` 一格：`classifyModelscopeError` 内部只读它。
        ...(response.headers.get('retry-after') === null
          ? {}
          : { 'retry-after': response.headers.get('retry-after') as string }),
      })
      const code = info.kind === 'quota'
        ? 'QUOTA_EXCEEDED'
        : info.kind === 'rate_limit'
          ? 'RATE_LIMIT'
          : info.kind === 'auth'
            ? 'AUTH'
            : httpErrorCode(response.status, text)
      throw new LlmError(
        `modelscope: HTTP ${response.status} — ${text.slice(0, 300)}`,
        code,
        {
          status: response.status,
          ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
        },
      )
    }
    // ⚠️⚠️ **content-type 闸门**（2026-10-17 审计 P1 修复）。此前本文件只有
    //    `!response.ok` 一个闸门 ⇒ 网关返回 **HTTP 200 + `text/html`**（风控拦截页 /
    //    登录墙）时被当成正常响应喂给 `consumeOpenAiSse` ⇒ 解析不出任何帧 ⇒ 抛
    //    `EMPTY_RESPONSE` ⇒ `classifyModelscopeFailure` 读到 `status = 0` ⇒ 命中
    //    「传输错误」分支 ⇒ **轮换把整个账号池白打一遍**，最后抛
    //    `QUOTA_EXCEEDED`「所有账号对该模型均受限」。
    //    ⇒ 用户看到的是「额度用尽」而真因是风控，且唯一有效动作（换网络环境）
    //    被完全掩盖。这与 `accio-adapter.ts:1481-1492`（2026-10-13 真机踩过）是
    //    同一个坑，此处复刻。
    //    ⚠️ 归类 `SERVER`（**不重试**）：风控是身份/环境问题，原样重发只会再被拦。
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const peek = await response.text().catch(() => '')
      throw new LlmError(
        `modelscope: 上游未返回事件流（content-type: ${contentType || '(空)'}）——`
        + `通常是被风控拦截（网关返回 200 + HTML 拦截页）。`
        + `${peek === '' ? '' : ` 服务端原文：${peek.slice(0, 200)}`}`,
        'SERVER',
        { status: response.status },
      )
    }
    yield* consumeOpenAiSse(
      response,
      options.signal !== undefined ? { signal: options.signal } : {},
      {
        label: 'modelscope',
        firstTokenTimeoutMs: this.product.chatHeaderTimeoutMs,
        chunkTimeoutMs: this.product.chunkTimeoutMs,
        ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      },
    )
  }
}

/**
 * 从 `LlmError` 还原成语义化分类。
 *
 * ⚠️ 事实挂在 `error.failure` 上（`LlmFailure` 契约），**不是**展开在 error
 * 自身 —— 早期版本误按「自身属性」读响应头，`retry-after` 因此永远读不到
 * （opencode 写单测时实测到：`expected 590000, got 60000`）。
 */
export function classifyModelscopeFailure(error: unknown): ModelscopeErrorInfo {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    failure?: { status?: unknown; providerRetryAfterMs?: unknown }
  }
  const status = typeof failure.failure?.status === 'number' ? failure.failure.status : 0
  const providerRetryAfterMs = typeof failure.failure?.providerRetryAfterMs === 'number'
    && Number.isFinite(failure.failure.providerRetryAfterMs)
    ? failure.failure.providerRetryAfterMs
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  const info = classifyModelscopeError(status, message)
  return providerRetryAfterMs === undefined
    ? info
    : { ...info, retryAfterMs: info.retryAfterMs ?? providerRetryAfterMs }
}

/** 在 `ctx.llm` 上注册 modelscope 路由。 */
export function registerModelscopeLlm(
  ctx: Context,
  options: ModelscopeAdapterOptions,
): ModelscopeAdapter {
  const product = options.product ?? MODELSCOPE
  const adapter = new ModelscopeAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
