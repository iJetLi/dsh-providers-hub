/**
 * 「把网关模型目录同步到外部 agent」的**纯计划层**。
 *
 * ## 职责边界（接线 RPC 时不许越界）
 *
 * - 输入：目标文件的**当前内容**（已 parse 的对象）+ 网关模型目录 + 网关地址；
 * - 输出：新文件内容 + diff；
 * - **不碰磁盘**：不读路径、不备份、不写文件（那是 `sync-apply.ts` 的事）。
 *
 * 这样所有行为都能用内存对象断言，不需要临时目录，也不会在单测里写用户的真实配置。
 *
 * ## 为什么按 baseUrl 定位而不是写死 providerId
 *
 * 两边的网关 provider 都是**用户手工加的**：pi 里叫 `dsh-gateway`、ZCode 里叫
 * `dsh-openai-gateway`，但用户随时可能改名。写死 id 会在改名后静默匹配失败
 * （表现为「同步成功但什么都没变」）。因此按端点匹配，改名免疫。
 *
 * ## 目标文件的结构差异（这是本模块存在的根本原因）
 *
 * | 目标 | 模型能力信息存在哪 |
 * |---|---|
 * | pi | **自描述**：`providers.<k>.models[]` 每项自带 contextWindow/maxTokens |
 * | ZCode | **不自描述**：provider 里只有 id 列表，能力来自 `modelConfigRules.providerModelRules` 的匹配 |
 *
 * ⇒ ZCode 侧只写 id 列表**是不够的**：规则里没有 contextWindow 时，ZCode 读目录会报
 * `Missing token limits`。所以 {@link planZcodeSync} 必须同时 upsert 规则。
 *
 * @module src/sync-targets.ts
 */

/** 一条要同步出去的模型（由调用方从 `ctx.llm.listModels()` 归一化而来）。 */
export interface SyncModel {
  /** 模型 id（网关返回的 `<provider>/<model>` 形式，转发时用它）。 */
  id: string
  /** 展示名；缺省用 id。 */
  name?: string
  contextWindow: number
  /**
   * 输出上限。**可选**：网关的适配器普遍不声明它（实测 `/v1/models` 369 个模型
   * 无一带 `max_tokens`）。缺失表示「不知道」，此时**省略该字段**让目标用自己的
   * 默认值，而不是拿一个猜出来的数写进别人的配置。
   */
  maxTokens?: number
  /** 输入模态，如 `['text', 'image']`。 */
  input: readonly string[]
}

/** 支持同步的目标。 */
export type SyncTargetId = 'pi' | 'zcode'

/** 一次同步的变更摘要（UI 用它渲染预览）。 */
export interface SyncDiff {
  /** 新增到目标的模型 id。 */
  added: string[]
  /** 从目标移除的模型 id。 */
  removed: string[]
  /** 已存在但能力值（contextWindow / maxTokens）发生变化的模型 id。 */
  updated: string[]
  /** 因能力值非法而被跳过的模型 id（目录侧数据问题，需显式暴露给用户）。 */
  skipped: string[]
  /**
   * 因所属渠道**本次采集失败**而被原样保留的模型 id。
   *
   * ⚠️ 这些模型**不在**本次目录里（渠道没读到），但**刻意不删**：
   * 渠道临时失败（token 过期、网络抖动）与渠道真下架在目录上长得一模一样，
   * 一律判 `removed` 会造成「一次登录失效就把用户两个工具的模型删光」。
   */
  protectedModels: string[]
}

/** 计划选项。 */
export interface SyncPlanOptions {
  /**
   * 本次目录采集**失败**的 provider id。
   *
   * 这些渠道下的模型一律保留为目标现状（既不新增也不删除）——
   * 见 {@link SyncDiff.protectedModels}。
   */
  failedProviders?: readonly string[]
}

/** 从模型 id 里取 provider 段（`<provider>/<model>`；模型名本身可含 `/`，故只切首个）。 */
export function providerOfModelId(id: string): string {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : ''
}

/** 判断某模型是否属于「本次采集失败的渠道」。 */
function makeProtectedCheck(failedProviders: readonly string[] | undefined): (id: string) => boolean {
  if (!failedProviders || failedProviders.length === 0) return () => false
  const failed = new Set(failedProviders)
  return (id: string) => failed.has(providerOfModelId(id))
}

/** 计划阶段的失败（目标 provider 不存在、文件结构不认识等）。 */
export class SyncPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncPlanError'
  }
}

/** 深拷贝配置对象：目标文件都是纯 JSON，用序列化往返最省事。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 把端点归一成 `scheme://host:port`，用于跨配置匹配。
 *
 * 忽略 path / 尾斜杠 / query：用户可能写 `http://127.0.0.1:8326`、
 * `.../v1`，或带尾斜杠。解析失败时退化成原串比较（不抛错）。
 */
function normalizeEndpoint(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  const trimmed = raw.trim()
  try {
    const url = new URL(trimmed)
    // ⚠️ `new URL('localhost:8326')` **不抛错**，而是把 `localhost` 当成 scheme、
    //    host 留空 ⇒ 所有裸 `host:port` 会归一成同一个 `localhost://`，
    //    于是 8326 与 9999 被判成同一端点（实测会匹配到错的 provider）。
    if (url.host) return `${url.protocol}//${url.host}`.toLowerCase()
    throw new Error('empty host')
  } catch {
    // 裸 `host:port` / `127.0.0.1:8326`：补 scheme 再解析一次
    try {
      const url = new URL(`http://${trimmed}`)
      if (url.host) return `${url.protocol}//${url.host}`.toLowerCase()
    } catch {
      // 落到下面的原串比较
    }
    return trimmed.toLowerCase().replace(/\/+$/, '')
  }
}

/** 能力值是否可安全写入配置：必须是正的有限数（0 / 负数 / NaN 一律拒）。 */
function usableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** 逐元素比较两个字符串数组（`input` 模态列表用）。 */
function sameStringArray(left: unknown, right: readonly string[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

/**
 * 拆分出可写入的模型与需跳过的模型。
 *
 * ⚠️ **只要求 `contextWindow`**，`maxTokens` 缺失不算非法：
 * - ZCode 侧只消费 `contextWindow`（缺了它模型直接不可用）；
 * - pi / 网关适配器普遍不声明 `maxTokens`，把它设成硬门槛会让绝大多数模型
 *   （实测 369 个里 0 个带 `max_tokens`）被判为「能力值缺失」而全部跳过。
 */
function partitionModels(models: readonly SyncModel[]): { ok: SyncModel[]; skipped: string[] } {
  const ok: SyncModel[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  for (const model of models) {
    const id = typeof model?.id === 'string' ? model.id.trim() : ''
    // 重复 id 只保留第一条：否则会往配置里写重复模型
    if (!id || seen.has(id)) continue
    if (!usableNumber(model.contextWindow)) {
      skipped.push(id)
      continue
    }
    seen.add(id)
    ok.push({ ...model, id })
  }
  return { ok, skipped }
}

/** pi models.json 的最小形状（只声明本模块真正读写的字段）。 */
interface PiConfig {
  providers?: Record<string, any>
}

/**
 * 在 pi 的 models.json 里按端点找到网关 provider 的键名。
 *
 * @throws {SyncPlanError} 找不到时抛错并点名端点（不擅自新建 provider —— 那需要 apiKey）
 */
export function findPiProvider(config: PiConfig, gatewayBaseUrl: string): string {
  const wanted = normalizeEndpoint(gatewayBaseUrl)
  const providers = config?.providers ?? {}
  for (const [key, provider] of Object.entries(providers)) {
    if (normalizeEndpoint(provider?.baseUrl) === wanted) return key
  }
  throw new SyncPlanError(`pi 的 models.json 里没有端点匹配 ${gatewayBaseUrl} 的 provider`)
}

/** ZCode provider_config.json 的最小形状。 */
interface ZcodeConfig {
  config?: {
    providerOrder?: string[]
    providerConfigRules?: { providerRules?: any[] }
    modelConfigRules?: { providerModelRules?: any[]; manualProviderModelRules?: any[] }
  }
}

/**
 * 在 ZCode 的 provider_config.json 里按 `config.api.baseUrl` 找网关 provider。
 *
 * @throws {SyncPlanError} 找不到时抛错（同样不擅自新建）
 */
export function findZcodeProvider(config: ZcodeConfig, gatewayBaseUrl: string): string {
  const wanted = normalizeEndpoint(gatewayBaseUrl)
  const rules = config?.config?.providerConfigRules?.providerRules ?? []
  for (const rule of rules) {
    if (normalizeEndpoint(rule?.config?.api?.baseUrl) === wanted) return String(rule.providerId)
  }
  throw new SyncPlanError(`ZCode 的 provider_config.json 里没有端点匹配 ${gatewayBaseUrl} 的 provider`)
}

/**
 * 规划 pi 侧同步：刷新网关 provider 的 `models[]`。
 *
 * ## 三条不变量
 *
 * 1. **按模型 id 保留 pi 本地字段**：`reasoning` / `thinkingLevelMap` / `compat` 是 pi
 *    独有配置，网关目录里没有对应来源。不保留会让用户手调的思考档位与兼容开关归零。
 * 2. **不搬运密钥**：`apiKey` / `baseUrl` / `api` 原样保留（两边本来就有）。
 * 3. **外科手术**：同文件里其它 provider 一个字节都不动。
 */
export function planPiSync(
  config: PiConfig,
  models: readonly SyncModel[],
  gatewayBaseUrl: string,
  options: SyncPlanOptions = {},
): { config: PiConfig; diff: SyncDiff } {
  const key = findPiProvider(config, gatewayBaseUrl)
  const result = clone(config)
  const provider = result.providers![key] ?? {}
  const { ok, skipped } = partitionModels(models)

  // 旧模型按 id 建索引：既用于保留本地字段，也用于算 diff
  const previous = new Map<string, any>()
  for (const model of Array.isArray(provider.models) ? provider.models : []) {
    if (model && typeof model.id === 'string') previous.set(model.id, model)
  }

  const added: string[] = []
  const updated: string[] = []
  const byId = new Map(ok.map(model => [model.id, model]))

  /** 用目录值覆盖本地条目；本地独有字段（reasoning 等）由展开保留。 */
  const buildEntry = (model: SyncModel, kept: any): Record<string, unknown> => {
    const entry: Record<string, unknown> = { ...(kept ?? {}) }
    entry.id = model.id
    entry.name = model.name ?? model.id
    entry.contextWindow = model.contextWindow
    // ⚠️ maxTokens 只在目录给了合法值时才覆盖：缺失时**保留本地已有值**，
    //    本地也没有就不写该字段（交给 pi 的默认值），绝不用猜出来的数覆盖。
    if (usableNumber(model.maxTokens)) entry.maxTokens = model.maxTokens
    entry.input = [...model.input]
    return entry
  }

  // ⚠️ 两种「本次写不进去」都必须**保留目标现有条目**，绝不能判 removed：
  //    ① 渠道采集失败（token 过期 / 网络抖动）；
  //    ② 目录侧该模型能力值凑不齐（`skipped`）—— 它只是「这次没拿到窗口」，
  //       不等于「这个模型下架了」。整条删掉 = 一次目录抖动就删用户配置。
  const isProtected = makeProtectedCheck(options.failedProviders)
  const skippedSet = new Set(skipped)
  const keepAsIs = (id: string) => isProtected(id) || skippedSet.has(id)
  const protectedModels: string[] = []

  // 先按旧顺序铺（保留既有条目的位置），再把新增模型追加到末尾：
  // 直接 `ok.map` + `push(previousEntry)` 会把受保护模型挪到数组末尾，
  // 覆盖用户手排的 modelOrder。
  const nextModels: any[] = []
  const emitted = new Set<string>()
  for (const [id, previousEntry] of previous) {
    const model = byId.get(id)
    if (model) {
      nextModels.push(buildEntry(model, previousEntry))
      emitted.add(id)
      if (previousEntry.contextWindow !== model.contextWindow
        || (usableNumber(model.maxTokens) && previousEntry.maxTokens !== model.maxTokens)
        || previousEntry.name !== (model.name ?? model.id)
        || !sameStringArray(previousEntry.input, model.input)) updated.push(id)
      continue
    }
    if (!keepAsIs(id)) continue
    nextModels.push(previousEntry)
    emitted.add(id)
    if (isProtected(id)) protectedModels.push(id)
  }
  for (const model of ok) {
    if (emitted.has(model.id)) continue
    nextModels.push(buildEntry(model, undefined))
    emitted.add(model.id)
    added.push(model.id)
  }

  const removed = [...previous.keys()].filter(id => !emitted.has(id))
  provider.models = nextModels
  result.providers![key] = provider
  return { config: result, diff: { added, removed, updated, skipped, protectedModels } }
}

/**
 * 由本功能管理的 ZCode provider id 前缀。
 *
 * 每个网关渠道对应一个 `<前缀><渠道 id>` 的 provider —— 这样 ZCode 的模型选择器
 * 会像 pi 一样按渠道平铺，而不是把 168 个模型全塞进同一个 `dsh` 条目里。
 *
 * ⚠️ 前缀是「本功能管理范围」的判据之一（另一个判据是 `api.baseUrl` 指向网关）：
 * 只有同时满足两者的 provider 才会被同步改写，用户手工加的 provider 一律不碰。
 */
const ZCODE_PROVIDER_PREFIX = 'dsh-'

/** 渠道 id → 它在 ZCode 里对应的 provider id（如 `codearts` → `dsh-codearts`）。 */
export function zcodeProviderIdFor(channel: string): string {
  return ZCODE_PROVIDER_PREFIX + channel
}

/**
 * `zcodeProviderIdFor` 的逆运算：从 providerId 反推渠道名。
 * 不带前缀的 provider 返回 `''`（它不是本功能生成的）。
 */
export function channelOfZcodeProviderId(providerId: string): string {
  return providerId.startsWith(ZCODE_PROVIDER_PREFIX)
    ? providerId.slice(ZCODE_PROVIDER_PREFIX.length)
    : ''
}

/**
 * 列出配置里所有「端点匹配网关」的 provider 规则。
 *
 * 含**升级前**的那个单一条目（如 `dsh-openai-gateway`）：它装的模型会按渠道
 * 拆到各自的 provider 里，本条目随后被移除。
 */
function managedZcodeRules(config: ZcodeConfig, gatewayBaseUrl: string): any[] {
  const wanted = normalizeEndpoint(gatewayBaseUrl)
  const rules = config?.config?.providerConfigRules?.providerRules ?? []
  return rules.filter(rule => normalizeEndpoint(rule?.config?.api?.baseUrl) === wanted)
}

/**
 * 规划 ZCode 侧同步：**每个网关渠道一个 provider**。
 *
 * ## 为什么不是「一个 provider 装全部模型」
 *
 * 初版沿用用户的既有形态（`dsh-openai-gateway` 一条 + 168 个带渠道前缀的模型），
 * 结果 ZCode 的模型选择器里所有渠道的模型都折叠在 `dsh` 一个条目下，与 pi 里
 * 「按渠道铺开」的观感不一致。现改为每渠道一条，provider 的 group / access（含
 * apiKey）/ api（含 baseUrl）/ 启用状态全部继承原条目。
 *
 * ## 三条不变量
 *
 * 1. **模型 id 仍带渠道前缀**（`codearts/GLM-5.2`）：网关靠首个 `/` 之前做路由，
 *    去掉前缀它就不认了；
 * 2. **受保护渠道整条不动**：采集失败 / 用户未勾选的渠道，其 provider 与能力规则
 *    原样保留（只把 id 迁成 `dsh-<渠道>` 以统一结构）；
 * 3. **外科手术**：非管理范围的 provider 与其能力规则一个字节都不动。
 */
export function planZcodeSync(
  config: ZcodeConfig,
  models: readonly SyncModel[],
  gatewayBaseUrl: string,
  options: SyncPlanOptions = {},
): { config: ZcodeConfig; diff: SyncDiff } {
  const managed = managedZcodeRules(config, gatewayBaseUrl)
  if (managed.length === 0) {
    throw new SyncPlanError(`ZCode 的 provider_config.json 里没有端点匹配 ${gatewayBaseUrl} 的 provider`)
  }
  const result = clone(config)
  const rules = result.config!.providerConfigRules!.providerRules!
  const wanted = normalizeEndpoint(gatewayBaseUrl)
  // 模板：沿用现有网关 provider 的连接参数（不新建、不猜）
  const template = rules.find(entry => normalizeEndpoint(entry?.config?.api?.baseUrl) === wanted)
  if (!template) throw new SyncPlanError(`ZCode 配置在匹配后又找不到端点 ${gatewayBaseUrl} 的 provider`)

  // 旧模型：把所有管理中 provider 的模型按渠道汇总（升级前是「一条装全部」）
  const oldByChannel = new Map<string, string[]>()
  // ⚠️ 没有 `<channel>/` 前缀的旧 id（例如 `gpt-4o`）无法归属任何渠道。
  //    过去直接 `continue` ⇒ 它既不进 old 也不进 new，被静默删掉且 diff 完全不提。
  //    现在收集起来如实计进 removed，至少让用户看见「这条被移除了」。
  const unroutableOld: string[] = []
  for (const rule of managed) {
    const list = Array.isArray(rule?.config?.personalModelIds) ? rule.config.personalModelIds : []
    for (const id of list) {
      if (typeof id !== 'string' || !id) continue
      const channel = providerOfModelId(id)
      if (!channel) {
        if (!unroutableOld.includes(id)) unroutableOld.push(id)
        continue
      }
      const bucket = oldByChannel.get(channel) ?? []
      bucket.push(id)
      oldByChannel.set(channel, bucket)
    }
  }

  const { ok, skipped } = partitionModels(models)
  const skippedSet = new Set(skipped)
  const newByChannel = new Map<string, SyncModel[]>()
  for (const model of ok) {
    const channel = providerOfModelId(model.id)
    if (!channel) continue
    const bucket = newByChannel.get(channel) ?? []
    bucket.push(model)
    newByChannel.set(channel, bucket)
  }

  const protectedChannels = new Set(options.failedProviders ?? [])

  /**
   * 每个渠道最终的模型列表。
   *
   * - 受保护渠道 → 沿用旧列表（**不增不删**）；
   * - 其余渠道 → 仍存在的按旧顺序保留 + 新模型追加到末尾（不按字母重排，
   *   否则每次同步都会覆盖用户手工排的 `modelOrder`）；
   * - 目录里彻底消失的渠道 → 不入表 ⇒ 它的 provider 随后被移除。
   */
  const finalByChannel = new Map<string, string[]>()
  const protectedModels: string[] = []
  const allChannels = new Set([...newByChannel.keys(), ...oldByChannel.keys()])
  for (const channel of allChannels) {
    const old = oldByChannel.get(channel) ?? []
    if (protectedChannels.has(channel)) {
      if (old.length > 0) {
        finalByChannel.set(channel, old)
        protectedModels.push(...old)
      }
      continue
    }
    const fresh = newByChannel.get(channel) ?? []
    if (fresh.length === 0) {
      // 目录里这条渠道一个可写模型都没有。但旧配置里如果还有本轮 `skipped` 的模型，
      // 必须连渠道一起保留 —— 否则它们会跟着 provider 一起消失。
      const skippedOld = old.filter(id => skippedSet.has(id))
      if (skippedOld.length > 0) finalByChannel.set(channel, skippedOld)
      continue
    }
    const freshIds = fresh.map(model => model.id)
    const freshSet = new Set(freshIds)
    const oldSet = new Set(old)
    // ⚠️ 本轮 `skipped` 的旧 id 必须保留：它只是「这次没拿到窗口」，不是「模型下架」。
    //    不保留会被从 personalModelIds 与能力规则里同时删除。
    //    另外用 `new Set` 去掉升级残留造成的重复 id（旧 provider 与新 provider 同装一条）。
    finalByChannel.set(channel, [...new Set([
      ...old.filter(id => freshSet.has(id) || skippedSet.has(id)),
      ...freshIds.filter(id => !oldSet.has(id)),
    ])])
  }

  // diff：按模型 id 算（跨 provider 迁移不算变更，只有真的增/删才算）
  const added: string[] = []
  const removed: string[] = []
  for (const [channel, ids] of finalByChannel) {
    const old = oldByChannel.get(channel) ?? []
    for (const id of ids) if (!old.includes(id)) added.push(id)
    for (const id of old) if (!ids.includes(id)) removed.push(id)
  }
  for (const [channel, ids] of oldByChannel) {
    if (!finalByChannel.has(channel)) removed.push(...ids)
  }
  // 无渠道前缀的旧 id 无法路由，会被移出 personalModelIds；如实计入 removed 而不是静默丢
  removed.push(...unroutableOld)

  // ── 能力规则（缺 contextWindow 会让模型在 ZCode 里不可用）──
  result.config!.modelConfigRules = result.config!.modelConfigRules ?? {}
  const modelRules = result.config!.modelConfigRules
  const existingRules: any[] = Array.isArray(modelRules.providerModelRules) ? modelRules.providerModelRules : []
  const managedIds = new Set(managed.map(entry => String(entry?.providerId)))

  /**
   * 判定某条能力规则是否属于「本功能管理范围」（含已消失渠道的旧 rule，需一并清理）。
   *
   * ⚠️ 判据**只有「provider 的端点指向网关」**（`managedIds` 由端点算出）。
   *    曾经额外用 `pid.startsWith('dsh-')` 兜底，结果把用户**手工创建**、
   *    id 恰好以 `dsh-` 开头但端点指向别家的 provider 一起接管：
   *    provider 条目保留、能力规则却被删光 ⇒ 该 provider 的模型全部缺
   *    contextWindow 变成不可用，而 diff 一行都不显示（实测）。
   */
  const isManagedRule = (entry: any): boolean => managedIds.has(String(entry?.providerId ?? ''))

  // 旧窗口值：既用于判断 updated，也用于受保护渠道原样保留
  const oldWindow = new Map<string, unknown>()
  for (const entry of existingRules) {
    if (!isManagedRule(entry)) continue
    const mid = typeof entry?.modelId === 'string' ? entry.modelId : ''
    if (mid) oldWindow.set(mid, entry?.config?.properties?.contextWindow)
  }

  // 非管理范围的规则原样保留；管理范围的只保留「受保护渠道」或「本轮 skipped 模型」的那些。
  //
  // ⚠️ 受保护渠道的规则**不能**把 providerId 改写成 `dsh-<渠道>`：该渠道的 provider
  //    本轮是原样保留的（不重建），改写后规则会指向一个不存在的 provider，
  //    ZCode 找不到 provider ⇒ 模型直接不可用（实测）。
  //    skipped 模型则相反：它们的旧 provider 会被移除，规则必须跟着迁到新 provider。
  const keptRules = existingRules
    .filter(entry => {
      if (!isManagedRule(entry)) return true
      const mid = typeof entry?.modelId === 'string' ? entry.modelId : ''
      return protectedChannels.has(providerOfModelId(mid)) || skippedSet.has(mid)
    })
    .map(entry => {
      if (!isManagedRule(entry)) return entry
      const mid = typeof entry?.modelId === 'string' ? entry.modelId : ''
      const channel = providerOfModelId(mid)
      if (protectedChannels.has(channel)) return entry
      return { ...entry, providerId: zcodeProviderIdFor(channel) }
    })

  const updated: string[] = []
  for (const model of ok) {
    const channel = providerOfModelId(model.id)
    if (!channel || protectedChannels.has(channel)) continue
    const previous = oldWindow.get(model.id)
    if (previous !== undefined && previous !== model.contextWindow) updated.push(model.id)
    keptRules.push({
      providerId: zcodeProviderIdFor(channel),
      modelId: model.id,
      config: { properties: { contextWindow: model.contextWindow } },
    })
  }
  modelRules.providerModelRules = keptRules

  // ── provider 条目：移除管理中的旧条目，按渠道重建 ──
  /**
   * 保留的 provider 条目。
   *
   * ⚠️ 受保护渠道（未勾选 / 采集失败 / 目标独有）的 provider 必须**原样保留**：
   *    过去按 `!managedIds.has(pid)` 过滤，会把受保护渠道也滤掉、再用模板重建一条，
   *    结果 `enabled` / `providerName` / `access.apiKey` 全被模板值覆盖（实测）。
   */
  const keptProviders = rules.filter(entry => {
    const pid = String(entry?.providerId ?? '')
    if (!managedIds.has(pid)) return true
    // ① 已经是「按渠道命名」的 provider（dsh-<渠道>）：受保护渠道原样保留
    const channel = channelOfZcodeProviderId(pid)
    if (channel !== '' && protectedChannels.has(channel)) return true
    // ② 升级前的形态（一条 provider 装多个渠道，如 dsh-openai-gateway）：
    //    只要它还装着**受保护渠道**的模型，就整体保留 ——
    //    否则该渠道的模型会随着这条 provider 一起消失。
    const ids = Array.isArray(entry?.config?.personalModelIds) ? entry.config.personalModelIds : []
    return ids.some((id: unknown) => typeof id === 'string' && protectedChannels.has(providerOfModelId(id)))
  })
  const keptProviderIds = new Set(keptProviders.map(entry => String(entry?.providerId)))
  const baseConfig = template.config ?? {}
  for (const [channel, ids] of finalByChannel) {
    if (protectedChannels.has(channel)) continue
    const providerId = zcodeProviderIdFor(channel)
    if (keptProviderIds.has(providerId)) {
      throw new SyncPlanError(
        `ZCode 里已存在名为 ${providerId} 的 provider，但它不指向网关（${gatewayBaseUrl}）；`
        + '为避免覆盖你手工配置的 provider，已拒绝同步。请先重命名或删除该 provider 后重试。',
      )
    }
    keptProviders.push({
      providerId,
      providerName: providerId,
      enabled: template.enabled !== false,
      config: {
        ...baseConfig.group === undefined ? {} : { group: baseConfig.group },
        // access（含 apiKey）与 api（含 baseUrl）逐条复制：ZCode 的 provider 是
        // 自包含的，没有「继承自某一条」的机制
        access: clone(baseConfig.access ?? {}),
        api: clone(baseConfig.api ?? {}),
        personalModelIds: [...ids],
        modelOrder: [...ids],
      },
    })
    keptProviderIds.add(providerId)
  }
  result.config!.providerConfigRules!.providerRules = keptProviders

  // providerOrder：保留仍存在的顺序，新 provider 追加到末尾
  const providerIds = new Set(keptProviders.map(entry => String(entry?.providerId)))
  const oldOrder: string[] = Array.isArray(result.config!.providerOrder) ? result.config!.providerOrder : []
  const keptOrder = oldOrder.filter(id => providerIds.has(id))
  const missingOrder = [...finalByChannel.keys()]
    .map(zcodeProviderIdFor)
    .filter(id => !keptOrder.includes(id))
  result.config!.providerOrder = [...keptOrder, ...missingOrder]

  return { config: result, diff: { added, removed, updated, skipped, protectedModels } }
}

/**
 * 读出 pi 配置里网关 provider 当前已配置的模型 id。
 *
 * 找不到网关 provider 时返回**空数组而不抛错**：本函数服务于「UI 展示哪些渠道
 * 已在目标里」这种附加信息，目标还没配网关是正常状态（用户尚未加过），
 * 不该让整个预览因此失败。
 */
export function existingPiModelIds(config: PiConfig, gatewayBaseUrl: string): string[] {
  let key: string
  try {
    key = findPiProvider(config, gatewayBaseUrl)
  } catch {
    return []
  }
  const models = config?.providers?.[key]?.models
  if (!Array.isArray(models)) return []
  return models
    .map((model: any) => (typeof model?.id === 'string' ? model.id : ''))
    .filter((id: string) => id !== '')
}

/**
 * 读出 ZCode 配置里**所有**网关 provider 当前已配置的模型 id（汇总，跨渠道）。
 *
 * 找不到网关 provider 时返回空数组而不抛错：本函数服务于「UI 展示哪些渠道已在
 * 目标里」这种附加信息，目标还没配网关是正常状态。
 */
export function existingZcodeModelIds(config: ZcodeConfig, gatewayBaseUrl: string): string[] {
  const ids: string[] = []
  for (const rule of managedZcodeRules(config, gatewayBaseUrl)) {
    const list = rule?.config?.personalModelIds
    if (!Array.isArray(list)) continue
    for (const id of list) if (typeof id === 'string' && id) ids.push(id)
  }
  return ids
}

/** diff 是否为空（UI 用它决定「无需同步」而不是让用户点一个什么都没做的按钮）。 */
export function isDiffEmpty(diff: SyncDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.updated.length === 0
}

/**
 * 对外暴露「可写入模型」的拆分结果。
 *
 * 调用方（`sync-service.ts`）必须用它在落盘前判定「可写列表是否为空」：
 * 目录里**有模型但能力值全都非法**时，`models.length !== 0` 却同样会算出
 * 一份空列表 ⇒ 把目标现有模型全部判为已删除。两种情形必须同样拒绝。
 */
export function splitUsableModels(models: readonly SyncModel[]): { ok: SyncModel[]; skipped: string[] } {
  return partitionModels(models)
}
