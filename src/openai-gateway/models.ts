import { TtlCache } from '../ttl-cache.js'

import { effortView, type GatewayEffortView } from './effort-view.js'

export interface GatewayModelInfo {
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly string[]
}

export interface GatewayProviderModels {
  provider: string
  models: readonly GatewayModelInfo[]
}

export interface OpenAiModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
  name: string
  description?: string
  context_window?: number
  max_tokens?: number
  input?: readonly string[]
  /**
   * 思考档位的**机读视图**（附加字段，OpenAI 规范里没有这个语义）。
   *
   * ⚠️ 模型**没声明**档位时**整个字段缺省**（而不是给空数组）——「不知道」与
   * 「一个都没有」对客户端是两件事，见 `effort-view.ts` 的 `effortView`。
   */
  reasoning?: GatewayEffortView
}

export function toOpenAiModelId(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** 采集目录所需的最小 runtime 形态（便于单测替身）。 */
export interface GatewayModelSource {
  listProviders(): readonly { id: string }[]
  listModels(provider: string): Promise<readonly GatewayModelInfo[]>
  /**
   * 可选：解析某个模型的**精确**元信息（档位在这里，`listModels` 不带）。
   *
   * ⚠️ 声明为可选是刻意的：它是**附加能力**。宿主没提供（旧版本、单测替身）时
   * 目录照常返回，只是不带档位视图 —— 绝不能因为拿不到档位就让整个目录失败。
   */
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
}

/**
 * 采集全量模型目录，**逐个 provider 兜住**。
 *
 * ⚠️ 不能直接 `Promise.all` 全部 provider：任一 provider 抛错（未登录、远端
 * 目录拉取失败）会让整个目录变成失败 —— 用户看到的是「网关坏了」，而真实原因
 * 只是某一个 provider 没登录。逐个跳过也让「无凭据的 provider 不出现在目录里」
 * 天然成立。
 *
 * ⚠️ **本函数承诺永不抛出**。它是「网关面板顺带展示的目录」，是附加信息，
 * 不该有能力把调用方（设置页状态读取、请求失败后的纠错建议）一起拖垮。
 * 故对下列畸形输入全部降级为空：方法缺失、`listProviders()` 返回非数组、
 * 某个 `listModels()` 返回非数组、provider 条目缺 id。
 * （`llm` 来自 DSH 的 service，真实形态与类型声明可能不一致，故不假设它守规矩。）
 */
export async function collectGatewayModels(
  llm: GatewayModelSource,
  onError?: (provider: string, error: unknown) => void,
  /**
   * 覆盖 provider 列表（省略则用 `llm.listProviders()`）。
   *
   * 给设置页用：它有一条「`listProviders` 取不到时用已注册适配器的 key 兜底」
   * 的策略（`src/jet-hub-rpc.ts` 的 `providerIdsOf`），兜底结果必须能传进来。
   * ⚠️ 传了它就用它，**不再**调 `llm.listProviders()` —— 两处各算一份会让
   * 「设置页显示的渠道」与「实际采集的渠道」漂移。
   */
  providersOverride?: readonly { id: string }[],
): Promise<GatewayProviderModels[]> {
  let providers: readonly { id: string }[] = []
  try {
    const raw = providersOverride ?? llm?.listProviders?.()
    if (Array.isArray(raw)) providers = raw.filter((entry): entry is { id: string } => typeof entry?.id === 'string')
  } catch (error) {
    onError?.('listProviders', error)
  }
  if (providers.length === 0) return []

  const groups = await Promise.all(providers.map(async ({ id: provider }) => {
    try {
      const models = await llm.listModels(provider)
      if (!Array.isArray(models)) {
        onError?.(provider, new Error('listModels 未返回数组'))
        return undefined
      }
      return { provider, models: models as readonly GatewayModelInfo[] }
    } catch (error) {
      onError?.(provider, error)
      return undefined
    }
  }))
  return groups.filter((group): group is GatewayProviderModels => group !== undefined)
}

/**
 * 采集成设置页可直接渲染的 `{ id, name, input }` 列表。
 *
 * 与 {@link toOpenAiModels} 共用同一份采集逻辑与容错口径 —— 用户在设置页看到的
 * 与 `/v1/models` 返回的**必须**是同一批 ID 与同一份能力声明，两处各算一遍必然
 * 漂移，而漂移的症状是「照着设置页选的模型却不支持图片」。
 *
 * ⚠️ `input` 原样透传**不归一化**：它决定用户能否给该模型发图片，而各 provider
 * 的能力声明才是权威（`/v1/models` 的 HTTP 路径同样直接输出它）。
 * 缺失时归一化为 `['text']`，与各适配器「不声明即按 text 保守处理」一致
 * （见 lobsterai-adapter.ts）——宁可少报能力，也不要让用户发一张
 * 注定被上游拒绝的图。
 */
export async function collectGatewayModelIds(
  llm: GatewayModelSource,
  onError?: (provider: string, error: unknown) => void,
  effortViews?: ReadonlyMap<string, GatewayEffortView>,
): Promise<GatewayModelIdEntry[]> {
  const groups = await collectGatewayModels(llm, onError)
  return toGatewayModelIds(groups, effortViews)
}

/**
 * 设置页面板渲染一行的**权威字段**。
 *
 * ⚠️ `provider` / `model` 是**采集侧给的拆分**，不是前端从 `id` 切出来的。
 * 模型名里允许带斜杠（实测 Cline 的 `cline/anthropic/claude-sonnet-5.5`），
 * 按首个 `/` 反推虽然与网关自己的路由口径同源（`messages.ts` 的
 * `parseModelRoute` 同样用 `indexOf('/')`），但一旦某家 provider 的模型名
 * 以 `/` 开头、或 provider key 本身含 `/`，反推就会错位。
 * 分组是「哪家有哪些模型」这个**用户语义**，理应由采集侧决定而不是猜。
 */
export interface GatewayModelIdEntry {
  /** 可直接填进 agent 配置的完整 ID（`provider/模型名`）。 */
  id: string
  /** 该条目所属的 provider key（**权威值**，非从 `id` 切出）。 */
  provider: string
  /** provider 内部的模型名（不含 `<provider>/` 前缀）。 */
  model: string
  name: string
  input: readonly string[]
  reasoning?: GatewayEffortView
}

/**
 * 分组目录 → 扁平行（设置页/面板用）。
 *
 * ⚠️ 抽成**纯函数**是为了让「已经采集过分组与档位」的调用方直接复用，
 * 而不是再走一遍 `collectGatewayModelIds` 把目录拉第二次
 * （重复采集的症状是同一份清单里两次出现不同的档位）。
 */
export function toGatewayModelIds(
  groups: readonly GatewayProviderModels[],
  effortViews?: ReadonlyMap<string, GatewayEffortView>,
): GatewayModelIdEntry[] {
  return groups.flatMap(({ provider, models }) => models.map((model) => {
    const id = toOpenAiModelId(provider, model.id)
    const reasoning = effortViews?.get(id)
    return {
      id,
      // ⚠️ 这两个字段**必须由这里给出**（见 `GatewayModelIdEntry` 的注释）：
      // 前端没有别的地方能拿到权威拆分。
      provider,
      model: model.id,
      name: model.name,
      input: Array.isArray(model.inputModalities) && model.inputModalities.length > 0
        ? [...model.inputModalities]
        : ['text'],
      ...reasoning === undefined ? {} : { reasoning },
    }
  }))
}

/**
 * `/v1/models` 需要的**逐模型附加信息**：档位视图 + 上下文窗口。
 *
 * ⚠️ 为什么窗口要在这里解析（issue #36）：宿主 `LlmRuntime.listModels()` 会把
 * 适配器返回的对象**按白名单重建**（`provider/id/name/description/inputModalities`），
 * 适配器在 `listModels` 里多带的 `contextWindow` 到网关这里已经被剥掉。
 * 唯一还带着窗口的是 `resolveModelInfo()` 的 `context.contextWindow`，而它
 * **本来就已经被档位解析逐个调用**（见 `collectGatewayEffortViews` 的成本注释）
 * ⇒ 同一次调用里把窗口也读出来，零额外请求。
 */
export interface GatewayModelDetails {
  effortViews: Map<string, GatewayEffortView>
  contextWindows: Map<string, number>
}

/**
 * 逐个模型解析档位与窗口（一次 `resolveModelInfo` 同时取两者）。
 *
 * 容错口径与旧实现一致：单个模型解析失败只让它没有附加字段，不影响整份目录；
 * 宿主没提供 `resolveModelInfo` 时返回两张空表。
 */
export async function collectGatewayModelDetails(
  llm: GatewayModelSource,
  groups: readonly GatewayProviderModels[],
  onError?: (provider: string, error: unknown) => void,
): Promise<GatewayModelDetails> {
  const effortViews = new Map<string, GatewayEffortView>()
  const contextWindows = new Map<string, number>()
  const resolve = llm?.resolveModelInfo
  if (typeof resolve !== 'function') return { effortViews, contextWindows }
  await Promise.all(groups.flatMap(({ provider, models }) => models.map(async (model) => {
    const key = toOpenAiModelId(provider, model.id)
    try {
      const info = await resolve.call(llm, provider, model.id) as {
        reasoning?: { efforts?: readonly { id?: unknown, name?: unknown }[], defaultEffort?: unknown }
        context?: { contextWindow?: unknown }
      } | undefined
      const view = effortView(info?.reasoning?.efforts, info?.reasoning?.defaultEffort)
      if (view !== undefined) effortViews.set(key, view)
      const window = info?.context?.contextWindow
      if (typeof window === 'number' && Number.isInteger(window) && window > 0) {
        contextWindows.set(key, window)
      }
    } catch (error) {
      onError?.(provider, new Error(
        `${model.id} 的附加信息解析失败（该模型不带档位/窗口，目录本身照常返回）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      ))
    }
  })))
  return { effortViews, contextWindows }
}

/** 把解析到的窗口合并进目录项（未解析到的不写，不猜）。 */
export function applyGatewayContextWindows(
  groups: readonly GatewayProviderModels[],
  contextWindows: ReadonlyMap<string, number>,
): GatewayProviderModels[] {
  if (contextWindows.size === 0) return [...groups]
  return groups.map(({ provider, models }) => ({
    provider,
    models: models.map((model) => {
      const window = contextWindows.get(toOpenAiModelId(provider, model.id))
      return window === undefined
        ? model
        : { ...model, contextWindow: model.contextWindow ?? window }
    }),
  }))
}

/**
 * 逐个模型解析**档位视图**（key = `provider/model`）。
 *
 * ## 为什么要单独解析
 *
 * DSH 的 `LlmModelInfo`（`listModels` 的产物）**不带**档位，档位只在
 * `resolveModelInfo` 的 `LlmResolvedModelInfo.reasoning` 里。而档位正是本网关
 * 最需要公开的东西 —— 各 provider 的档位 id 私有（`light` / `extra_high` /
 * `xhigh` / `on`），客户端不查就只能猜，猜错就是 400。
 *
 * ## 成本与容错
 *
 * 每个模型一次 `resolveModelInfo`：它读的是适配器**已缓存**的远端目录
 * （`listModels` 刚拉过），故不产生额外网络请求；DSH 自己的 `buildModelCatalog`
 * 也是「每个 provider listModels 后逐个 resolveModelInfo」的同一形状。
 * 逐模型 catch：单个模型解析失败只是**它**没有档位字段，不影响整个目录。
 */
export async function collectGatewayEffortViews(
  llm: GatewayModelSource,
  groups: readonly GatewayProviderModels[],
  onError?: (provider: string, error: unknown) => void,
): Promise<Map<string, GatewayEffortView>> {
  // 与窗口解析共用同一次逐模型 `resolveModelInfo`（见 GatewayModelDetails）。
  const { effortViews } = await collectGatewayModelDetails(llm, groups, onError)
  return effortViews
}

/**
 * 一次采集的**完整快照**：分组 + 逐模型附加信息 + 渠道级失败清单。
 *
 * 三者必须同源，见 {@link collectGatewayCatalogSnapshot} 的注释。
 */
export interface GatewayCatalog {
  /** 逐渠道的模型列表（`listModels` 产物，含 `inputModalities`）。 */
  readonly groups: readonly GatewayProviderModels[]
  /** 逐模型附加信息（档位视图 + `contextWindow`）。 */
  readonly details: GatewayModelDetails
  /**
   * 本次 **渠道级** 读取失败的 provider（`listProviders` / `listModels` 抛错）。
   *
   * ⚠️ 与 `onError` 的差别：`onError` 是**回调**（日志用），这里是**结果**
   * （保护集用）。同步层必须拿这一份、而不是自己在 `onError` 里再收一遍 ——
   * 两处各收一份必然漂移，而漂移的症状正是「预览说保留、落盘却删除」。
   */
  readonly failedProviders: readonly string[]
}

/**
 * 网关目录缓存的有效期（毫秒）。
 *
 * ⚠️ 与 `src/model-catalog.ts` 的 20 分钟**刻意不同**：那里是「用户在 Jet Hub
 * 改完开关 ⇒ 该渠道目录必须立即失效」的交互目录（带 `invalidatedAt` 主动失效
 * 表）；这里是只读展示，30 秒的滞后不可感知，而每次命中省掉几百次
 * `resolveModelInfo`。
 */
const GATEWAY_CATALOG_TTL_MS = 30_000

interface CatalogCacheSlot {
  readonly cache: TtlCache<GatewayCatalog>
  /**
   * 最近一次调用方给的 `onError`（日志用）。
   *
   * 缓存**命中**时不会走 `load`，故 `onError` 只在真正采集的那一次触发 ——
   * 这是刻意的：否则 `/v1/models` 每次被客户端扫描都会把同一批失败日志重复
   * 打一遍。缓存条目本身仍是「部分失败」的一致快照，不影响保护集。
   */
  onError?: (provider: string, error: unknown) => void
  /**
   * 最近一次调用方给的 provider 列表覆盖（设置页的兜底清单）。
   *
   * 与 `onError` 同命：只在**真正采集**的那一次生效。
   */
  providers?: readonly { id: string }[]
}

/**
 * 按 `llm` 实例分桶的目录缓存。
 *
 * ⚠️ 为什么 key 是 `llm` 而不是模块级单例：不同 ctx（不同会话）可能给不同
 * `llm` 对象，而它们的 provider 登录状态可能完全不同。模块级单例会让 A 会话
 * 的目录串到 B 会话 —— 症状是「明明没登录的渠道却出现在目录里」。
 */
const catalogCacheSlots = new WeakMap<object, CatalogCacheSlot>()

function catalogSlotFor(llm: GatewayModelSource): CatalogCacheSlot {
  const existing = catalogCacheSlots.get(llm as object)
  if (existing !== undefined) return existing
  const created: CatalogCacheSlot = {
    cache: new TtlCache<GatewayCatalog>({
      ttlMs: GATEWAY_CATALOG_TTL_MS,
      load: () => loadGatewayCatalog(llm, created),
    }),
  }
  catalogCacheSlots.set(llm as object, created)
  return created
}

async function loadGatewayCatalog(
  llm: GatewayModelSource,
  slot: CatalogCacheSlot,
): Promise<GatewayCatalog> {
  const failedProviders: string[] = []
  const markFailed = (provider: string, error: unknown): void => {
    if (!failedProviders.includes(provider)) failedProviders.push(provider)
    slot.onError?.(provider, error)
  }
  const groups = await collectGatewayModels(llm, markFailed, slot.providers)
  // ⚠️ 逐模型 `resolveModelInfo` 失败**不算渠道级失败**：渠道本身是好的，只是
  //    某几个模型拿不到窗口。这些模型会缺 `contextWindow`、被计划层判为
  //    `skipped`，而「skipped 的模型如果目标里已有就必须保留」由
  //    `src/sync-targets.ts` 的 skip 分支负责（保护粒度 = **单个模型**）。
  //    若在这里把整条渠道塞进 `failedProviders`，一个模型抖动会冻结整条渠道
  //    （新模型也进不来），反而更差。
  //
  //    但诊断信息仍要透出 —— 故这里把调用方的 `onError` 原样传下去。
  const details = await collectGatewayModelDetails(llm, groups, slot.onError)
  return { groups, details, failedProviders }
}

/**
 * 采集（或复用 30 秒内的）网关目录快照。
 *
 * ## 为什么必须缓存（真实缺陷）
 *
 * `collectGatewayModels` + `collectGatewayModelDetails` 每次都是**全量采集**：
 * 12 个 `listModels` 并发 + **每个模型**一次 `resolveModelInfo`（实测 369 次，
 * 全并发且无上限）。而这条链路上有四个**各自独立采集**的调用点：
 *
 * - `GET /v1/models`（`server.ts` 的 `handleModels`）
 * - `GET /v1/reasoning-efforts`（`server.ts` 的 `handleReasoningEfforts`）
 * - 设置页 `gateway.getEnabled`（`jet-hub-rpc.ts`）
 * - `sync.preview`（`sync-service.ts` 的 `collectSyncCatalog`）
 *
 * 后果（真实报障）：打开「同步模型」面板时组件挂载连发两次 preview
 * ⇒ **738 次** `resolveModelInfo`；每勾选一个渠道再 +369 次。
 *
 * ## 为什么 `details` 与 `groups` 必须**一起**缓存
 *
 * `collectGatewayModelDetails` 的入参就是 `groups`。分开缓存会让「第二次拿到的
 * `groups` 与 `details` 对不上」，症状是同一份清单里两次出现不同的档位/窗口。
 *
 * ## 为什么「部分失败」也缓存
 *
 * 两个采集函数都承诺**永不抛错**（失败走 `onError` 并降级为空/缺字段），故
 * `TtlCache` 的 `load` 不会抛错，缓存里存的是「一致的部分失败快照」。这正确：
 * 保护集（`failedProviders`）与目录**必须**来自同一次采集。
 *
 * @param options.force 强制重新采集。⚠️ UI 的「刷新」按钮**必须**传 `true`，
 *   否则点刷新会命中 30 秒缓存、看起来「没反应」。
 * @param options.onError 采集失败的诊断回调（**仅真正采集的那一次**触发）。
 */
export async function collectGatewayCatalogSnapshot(
  llm: GatewayModelSource,
  options?: {
    readonly force?: boolean
    readonly providers?: readonly { id: string }[]
    readonly onError?: (provider: string, error: unknown) => void
  },
): Promise<GatewayCatalog> {
  const slot = catalogSlotFor(llm)
  if (options?.onError !== undefined) slot.onError = options.onError
  if (options?.providers !== undefined) slot.providers = options.providers
  return slot.cache.get({ force: options?.force === true })
}

/**
 * 丢弃某个 `llm` 实例的目录缓存。
 *
 * 用于「用户刚登录/退出某渠道」这类**已知目录变化**的场景，以及单测清理。
 * 不需要手动调用的场景（绝大多数）靠 30 秒 TTL 自愈。
 */
export function clearGatewayCatalogCache(llm: GatewayModelSource): void {
  catalogCacheSlots.get(llm as object)?.cache.clear()
}

/** 将 DSH 的 provider 分组目录转换为 OpenAI models 响应中的 data 项。 */
export function toOpenAiModels(
  groups: readonly GatewayProviderModels[],
  effortViews?: ReadonlyMap<string, GatewayEffortView>,
): OpenAiModel[] {
  return groups.flatMap(({ provider, models }) => models.map((model) => {
    const reasoning = effortViews?.get(toOpenAiModelId(provider, model.id))
    return {
      id: toOpenAiModelId(provider, model.id),
      object: 'model' as const,
      created: 0,
      owned_by: provider,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { context_window: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { max_tokens: model.maxTokens },
      ...model.inputModalities === undefined ? {} : { input: model.inputModalities },
      ...reasoning === undefined ? {} : { reasoning },
    }
  }))
}
