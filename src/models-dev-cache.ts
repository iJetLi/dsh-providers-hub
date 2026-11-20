/**
 * models.dev **唯一直读点** + 本地文件缓存（用户 2026-10-17 的要求）。
 *
 * ## 需求原文与其要解决的问题
 *
 * > 「定期读取 models.dev 应该成功就保存本地文件，冷启动就读本地文件缓存，
 * > 读不到就 fallback 不会直读 models.dev（可能回卡很久）；
 * > opencode 或者 cline 等 provider 读取 models.dev 的直读操作都变成读取本地缓存，
 * > 只有 1 消失定期更新本地缓存可以直读 models.dev 的 api」
 *
 * 改前有两处**各自**直连 `https://models.dev/api.json`（`opencode-capability.ts`
 * 与 `cline-models-dev.ts`），各自带一套 TTL / 在飞去重 / ETag。那份数据
 * **解压后 5.05~5.39 MB**、首字节 ~720ms、慢则 1.4s，而本机实测三取二超时、
 * 失败时**整段挂死**（不是「慢」，见 `cline-models-dev.ts` 的超时注释）。
 *
 * ⇒ 三条硬约定（本模块存在的全部理由）：
 *
 * 1. **全仓只有本模块 `fetch` models.dev**。其余消费方只读本地缓存文件。
 *    由 `tests/unit/models-dev-cache.spec.ts` 的「唯一直读点」扫描用例守住。
 * 2. **消费方永不因 models.dev 阻塞**：`readModelsDevSync()` 只做
 *    `readFileSync`（~19 KB 量级），**永不 await 网络**。
 * 3. **只有这里能写缓存文件**，且只写**成功**的结果 ⇒ 磁盘上永远是
 *    「最近一次成功」，失败不会把好数据覆盖成空。
 *
 * ## 为什么不是「进程内 TTL 缓存」而是「文件缓存」
 *
 * 改前两处都用进程内 TTL。问题在于**首次运行**（磁盘无缓存）时，
 * `listModels` 渲染路径要么空着、要么去等网络 —— 后者就是 2026-10-02
 * 的真机事故「模型选择一直卡着」。文件缓存让「首次运行」与「每次冷启动」
 * 同形：两者都只读文件，只有**写**缓存这一条路径碰网络。
 *
 * ## 降级链（三级，逐级放宽，**绝不**回退到网络）
 *
 * ```
 *   内存（本次进程已刷新过）
 *     ↓ 冷启动 / 未刷新
 *   磁盘文件（$DSH_HOME/cache/models-dev.json）
 *     ↓ 首次运行 / 文件损坏 / 版本不符
 *   undefined（调用方各自的本地兜底表）
 * ```
 *
 * ⚠️ **磁盘文件的 TTL 只影响「是否触发后台刷新」，绝不影响「能否读到」**：
 * 陈旧的目录远好过空目录（空目录会把所有模型打回纯文本，见
 * `cline-models-dev.ts` 的模块头事故记录）。这正是 `TtlCache.peekStale()`
 * 的「陈旧兼顶」语义在本场景的用法。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 社区模型目录（公开、无需认证）。与官方 CLI、cline 侧同源。
 *
 * ## ⚠️⚠️ **唯一的目录来源**；用户提议过的 OpenRouter 备份源**已被实测否决**
 *
 * 用户 2026-10-17 提议用 `https://openrouter.ai/api/v1/models` 当备份
 * （实测**国内可达**：HTTP 200 / 2.3s / 470 条）。**实测核对后决定不接入**：
 *
 * | 问题 | 实测 |
 * |---|---|
 * | **没有 `provider.api` 字段** | 470 条里 **0 条**有 ⇒ 而它是协议可达性的**唯一权威来源** |
 * | **id 命名空间不重叠** | 前缀全是 `openai:`/`deepseek:`/`z-ai:`…；`*opencode*` / `*zen*` 匹配 **0 条** |
 *
 * ⇒ 并进来会让 `chatProtocol` 变成 `undefined` ⇒ 退回本地表 ⇒ **等于没修
 * Issue IKM9LR**，还会给未来埋一个「某些条目可达性来源不明」的坑。
 * 它能补的 `context_length` / `architecture.input_modalities` 在 models.dev
 * 也有 ⇒ 属**冗余而非补充**。
 *
 * ⚠️ 将来若要重新评估，必须先确认它**新增了** models.dev 没有的独占字段；
 * 「它更稳定」不是理由（稳定性由本模块的重试与「失败保留旧缓存」解决）。
 */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/**
 * 单次尝试的超时（毫秒）。
 *
 * ## ⚠️ 实测依据（2026-10-17，10 次采样）
 *
 * models.dev 在本机是**「要么很快、要么整段挂死」**，不是普通的「慢」：
 *
 * | 样本 | 结果 |
 * |---|---|
 * | 成功 | **1.9s / 2.3s**（多次复现） |
 * | 失败 | `20010ms 超时`（两连）、`fetch failed`、挂到 600s 未返回 |
 *
 * 成功只需约 2 秒，失败却能挂满整个超时窗口 ⇒ 超时值**几乎不影响成功请求
 * 的耗时**，只决定「挂死的请求何时被放弃」。⇒ 该值可以放心调大。
 *
 * ## 为什么从 60s 加长到 90s（用户要求「有超时要加长点」）
 *
 * 加长的收益不是「成功的那 2 秒需要更久」，而是**跨过一部分慢链路**：
 * 上游 5.5 MB 的响应在弱网下可能被拆成很多段，60s 卡住但 90s 能读完的情形
 * 是真实存在的（`Invoke-WebRequest` 45s 那次就是卡在传输中）。
 *
 * ⚠️ **代价被严格框住**，不会外溢到用户：
 * ① 刷新全程在**后台**且 fire-and-forget（见 {@link refreshModelsDev}），
 *    渲染路径只读磁盘缓存，**永远不等这个超时**；
 * ② 有重试上限（3 次）⇒ 单轮最坏 270s，而它跑在 3 小时的周期定时器里，
 *    且 {@link runRefresh} 的在途去重保证任何时刻至多一个请求在飞；
 * ③ 死锁检测阈值（{@link MODELS_DEV_DEADLOCK_MS}）已按新上限定标。
 *
 * ⇒ 调大超时**不会**让「模型选择器一直卡着」复发：那次事故的成因是
 * **渲染路径 await**，不是超时值。
 */
/**
 * 单次拉取 models.dev 的超时（毫秒）。
 *
 * ## ⚠️⚠️ 2026-11-20：**从 90 秒降到 8 秒**（真实首屏卡顿修复）
 *
 * ### 上一版的判断错在哪
 *
 * 上一版把超时从 60s 加到 90s，核心假设是：
 *
 * > 「刷新全程在**后台**且 fire-and-forget ⇒ 渲染路径**永远不等这个超时**」
 *
 * **那个假设是错的。** `cline` 的目录加载器（`makeClineModelsDevLoader`）会
 * **`await` 一次刷新** —— 它不能纯同步读，因为 `cline-pass` 的条目与图片能力
 * 只有 models.dev 提供，纯同步读会让「未就绪」闸门永久认为残缺（issue IKKZUG）。
 *
 * 于是链路变成：
 *
 * ```
 * 宿主 buildModelCatalog → cline.listModels() → ensureRemoteModels()
 *   → loadClineModels() → models.dev 缓存为空 ⇒ await refreshModelsDevAsync()
 *   → 实测本机 25 秒超时 × 3 次重试 + 退避(2s+4s) = 81 秒
 * ```
 *
 * ⇒ **首屏被拖到 60 秒+**（用户报障「足足花了一分多钟」）。
 *
 * ### 现在的取值理由
 *
 * 实测（本机，多次）：成功 **1.9~4.2 秒**；失败 **25 秒仍无响应**（挂死）。
 *
 * ⇒ **成功从不需要超过 5 秒**。90 秒窗口只是在为「已经挂死的请求」白等，
 * 而我们有磁盘缓存兜底（失败时沿用旧缓存）。
 *
 * ⇒ 降到 **8 秒**：覆盖成功路径（含弱网抖动），并让最坏等待可控。
 *
 * ⚠️ **必须与尝试次数一起看**：单轮最坏 = 8s×2 + 2s 退避 = **18 秒**（原 276 秒）。
 */
export const MODELS_DEV_TIMEOUT_MS = 8_000

/**
 * 单轮刷新的最大尝试次数（用户要求「重试 3 次都失败才完全放弃」）。
 *
 * ⚠️ **是「总次数」而不是「首次 + 3 次重试」**：用户原话是「重试 3 次都失败
 * 才完全放弃」，按 3 次总尝试实现（即 2 次重试）。差别在最后一次的语义上：
 * 3 次总尝试已经足够覆盖「瞬时抖动」，再多只是拉长放弃前的等待。
 *
 * ## 为什么值得重试（实测依据）
 *
 * models.dev 的失败**高度间歇**：同一台机、同一分钟内实测
 * `HTTP 200` / `45s 超时` / `HTTP 200` 交替出现。而失败时**缓存保持旧值继续用**
 * （本模块的核心不变式）⇒ 重试的收益只是「尽快追上上游」，代价是一次后台
 * 请求。方向是安全的。
 */
/**
 * 单轮刷新的最大尝试次数（**总次数**，不是「首次 + N 次重试」）。
 *
 * ## ⚠️ 2026-11-20：**从 3 降到 2**（真实首屏卡顿修复）
 *
 * 原要求是「重试 3 次都失败才完全放弃」，那是在**后台刷新**语境下的合理诉求
 *（多试几次，反正用户看不见）。
 *
 * 但实测证实这条链路**会阻塞首屏**（见 {@link MODELS_DEV_TIMEOUT_MS} 的说明）
 * ⇒ 每多一次重试就是把首屏再拖一个超时窗口。而 models.dev 只是
 * `cline` / `opencode` 两家目录的**补全来源**（补齐模型名 / 上下文 / 图片能力），
 * 拿不到时**有静态兜底**，不值得为它多等一轮。
 *
 * ⇒ 2 次总尝试（首次 + 1 次重试）：足以跨过一次瞬时抖动，
 * 同时把最坏等待压到 `8s×2 + 2s = 18 秒`。
 */
export const MODELS_DEV_MAX_ATTEMPTS = 2

/**
 * 重试间隔（毫秒），用**指数退避**。
 *
 * ⚠️ 为什么不固定间隔：连着三次立刻打同一个刚挂死的站点没有意义，
 * 而固定间隔又可能落在同一个网络抖动窗口内。2s → 4s 的形状足以跨过
 * 典型的瞬时抖动，同时把「2 次都失败」的最坏等待控制在 8×2 + 2 = 18s。
 */
const RETRY_BASE_DELAY_MS = 2_000

/**
 * ⚠️ 「上一次刷新已死」的判定阈值（毫秒）。
 *
 * 必须 **> 单轮最坏耗时**（见 {@link MODELS_DEV_WORST_CASE_MS}），否则**重试
 * 本身会被误判成卡死**：一个正在正常重试的刷新会被后来的调用当成「上一次已死」
 * 而**再起一个**，于是并发请求翻倍 —— 恰好加剧了我们想避免的上游压力。
 *
 * ## ⚠️ 2026-11-20：从 480 秒降到 60 秒
 *
 * 480 秒是按旧的「3 次 × 90s + 6s = 276s」算的。超时降到 8s、次数降到 2 后，
 * 最坏只有 **18 秒**（{@link MODELS_DEV_WORST_CASE_MS}）⇒ 480 秒等于让一个
 * **真卡死**的刷新把去重位占住 8 分钟（这期间任何刷新都被跳过、缓存永远补不上）。
 *
 * ⇒ 取 **60 秒**：既 > 18 秒的 3 倍余量（跨得动正常重试），又不至于让真卡死
 * 长期占位。
 *
 * ⚠️ 这是「超时 + 重试次数」的**耦合点**：三者必须一起改，单独改一个会失衡。
 */
export const MODELS_DEV_DEADLOCK_MS = 60_000

/** 一轮刷新（含全部重试）的最坏耗时估算（毫秒）—— 仅用于文档与死锁阈值对照。 */
export const MODELS_DEV_WORST_CASE_MS =
  MODELS_DEV_MAX_ATTEMPTS * MODELS_DEV_TIMEOUT_MS
  + RETRY_BASE_DELAY_MS * (MODELS_DEV_MAX_ATTEMPTS - 1)

/**
 * 缓存有效期（毫秒）：决定「是否触发一次后台刷新」。
 *
 * ⚠️ 这份目录是**发布节奏**的数据（新模型上线才变），按小时级刷新足够。
 * 与 `CLINE_MODELS_DEV_TTL_MS` 同为 6 小时，别让它俩漂移。
 */
export const MODELS_DEV_TTL_MS = 6 * 60 * 60 * 1000

/**
 * 缓存文件格式版本。
 *
 * ⚠️ 字段结构变化时**必须** +1：旧文件会被静默当成有效数据继续用，
 * 缺字段的表现是「能力/目录恒为空」且没有任何报错（2026-10-02 已踩过：
 * issue IKJJ0V 的 `version: 1 → 2` 就是这个原因）。
 */
const CACHE_VERSION = 1

/** 磁盘缓存文件（`$DSH_HOME/cache/models-dev.json`）。 */
interface CacheFile {
  version: number
  /** 写入时刻（ms），用于 TTL 判定。 */
  at: number
  /** models.dev 的**精简投影**：只保留本插件会用到的字段。 */
  providers: Record<string, Record<string, ModelRecord>>
}

/**
 * ⚠️⚠️ **只缓存这些 provider 的块**（实测数据规模：全站 8993 条 / 2.6 MB）。
 *
 * ## 为什么必须白名单，而不是整份落盘
 *
 * models.dev 的 `api.json` 覆盖**全站** provider（实测 8993 个模型条目，
 * 落盘后 **2.6 MB**），而本插件只消费其中两个块：`opencode`（实测 127 条）与
 * `cline-pass`（实测 18 条）—— 合计 145 条、约 **40 KB**。
 *
 * 落盘全站的后果不是「磁盘浪费」，而是**启动路径上多读 2.6 MB**：
 * `loadDiskCacheSync()` 是 `readFileSync`，跑在插件加载与每次
 * `getOpencodeCapabilitiesSync()` 的前置路径上 ⇒ 与本模块自己写的
 * 「代价可忽略」直接矛盾，也与 2026-10-02「模型选择器一直卡着」的事故
 * 精神相悖（那次事故正是渲染路径上多等了一次 IO）。
 *
 * ## ⚠️ 新增消费方时**必须**往这里加一条
 *
 * 漏加的症状：那个消费方永远读到空块 ⇒ 它以为「上游没有这个 provider」。
 * `tests/unit/models-dev-cache.spec.ts` 的「白名单覆盖当前消费方」那条
 * 扫描用例会红 —— 判据是「消费方读过的 provider 名必须在白名单里」。
 */
export const MODELS_DEV_CACHED_PROVIDERS = ['opencode', 'cline-pass'] as const

/**
 * 一个模型的**精简投影**（原样条目有好几 KB）。
 *
 * ⚠️ **投影必须无损到「够用」**：字段少一个，消费方就少一条判据。
 * 当前覆盖：`name` / `cost` / `limit` / `modalities` / `reasoning` /
 * `reasoning_options` / `tool_call` / `provider.api`。
 *
 * ⚠️ 全部字段**可选** —— models.dev 的条目形态并不齐一（实测 `jev-1.13-free`
 * 连 models.dev 条目都没有），**缺字段一律是「不知道」而非「否」**。
 */
export interface ModelRecord {
  name?: string
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  limit?: { context?: number; input?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
  reasoning?: boolean
  reasoning_options?: unknown
  tool_call?: boolean
  /** 该模型所属的**协议端点**（如 `…/inference/openai/v1`）。 */
  provider?: { api?: string }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** 缓存文件路径。`DSH_HOME` 未设时回落 `~/.dsh`（与 opencode 能力表同型）。 */
export function modelsDevCacheFile(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'cache', 'models-dev.json')
}

/** 从原始条目里**只抠出**投影字段（其余一律不落盘）。 */
function projectEntry(raw: unknown): ModelRecord | undefined {
  if (!isRecord(raw)) return undefined
  const out: ModelRecord = {}
  if (typeof raw.name === 'string') out.name = raw.name
  if (isRecord(raw.cost)) {
    const cost: NonNullable<ModelRecord['cost']> = {}
    for (const key of ['input', 'output', 'cache_read', 'cache_write'] as const) {
      const v = raw.cost[key]
      if (typeof v === 'number' && Number.isFinite(v)) cost[key] = v
    }
    if (Object.keys(cost).length > 0) out.cost = cost
  }
  if (isRecord(raw.limit)) {
    const limit: NonNullable<ModelRecord['limit']> = {}
    for (const key of ['context', 'input', 'output'] as const) {
      const v = raw.limit[key]
      if (typeof v === 'number' && Number.isFinite(v)) limit[key] = v
    }
    if (Object.keys(limit).length > 0) out.limit = limit
  }
  if (isRecord(raw.modalities)) {
    const modalities: NonNullable<ModelRecord['modalities']> = {}
    for (const side of ['input', 'output'] as const) {
      const v = raw.modalities[side]
      if (Array.isArray(v)) modalities[side] = v.filter((m): m is string => typeof m === 'string')
    }
    if (Object.keys(modalities).length > 0) out.modalities = modalities
  }
  if (typeof raw.reasoning === 'boolean') out.reasoning = raw.reasoning
  if (raw.reasoning_options !== undefined) out.reasoning_options = raw.reasoning_options
  if (typeof raw.tool_call === 'boolean') out.tool_call = raw.tool_call
  if (isRecord(raw.provider) && typeof raw.provider.api === 'string') out.provider = { api: raw.provider.api }
  return out
}

/**
 * 把 models.dev 的原始响应解析成 `provider → 模型 id → 投影条目`。
 *
 * ⚠️ provider 块的位置有**两种**实测形态：`json['cline-pass']`（顶层直挂）
 * 与 `json.providers['cline-pass']`（嵌在 `providers` 下）。**两者都认** ——
 * 与 `parseClineModelsDev` 的既有口径一致；只认一种会让整份目录静默变空。
 *
 * ## ⚠️⚠️ **只解析白名单里的 provider**（见 {@link MODELS_DEV_CACHED_PROVIDERS}）
 *
 * 不做这一步就会把全站 8993 条 / 2.6 MB 落进磁盘缓存，而 `loadDiskCacheSync`
 * 是**同步**读 —— 它跑在插件加载与每次能力表读取的前置路径上。
 * 实测踩过：整份落盘后文件 2.6 MB，与本模块自己写的「代价可忽略」矛盾。
 *
 * ⚠️ 白名单**不匹配**的 provider 一律丢弃（不是「解析但不用」）：那会让
 * 内存里也留着全站数据，每次冷启动多分配几 MB 对象图。
 */
export function parseModelsDev(raw: unknown): Record<string, Record<string, ModelRecord>> {
  if (!isRecord(raw)) return {}
  const providers = isRecord(raw.providers) ? raw.providers : {}
  const out: Record<string, Record<string, ModelRecord>> = {}
  const wanted = new Set<string>(MODELS_DEV_CACHED_PROVIDERS)
  const put = (name: string, block: unknown): void => {
    if (!wanted.has(name)) return
    if (!isRecord(block) || !isRecord(block.models)) return
    const models: Record<string, ModelRecord> = {}
    for (const [id, entry] of Object.entries(block.models)) {
      if (id.length === 0) continue
      const projected = projectEntry(entry)
      if (projected !== undefined) models[id] = projected
    }
    if (Object.keys(models).length > 0) out[name] = models
  }
  // ⚠️ 先取 `providers` 下的（参考实现的口径），再取顶层直挂的；
  //   `put` 内已按白名单过滤，所以「同名后者覆盖前者」不可能发生。
  for (const [name, block] of Object.entries(providers)) put(name, block)
  for (const [name, block] of Object.entries(raw)) {
    if (name === 'providers') continue
    put(name, block)
  }
  return out
}

/** 进程内缓存：`provider → 模型 id → 投影条目`（渲染路径只读它）。 */
let memory: Record<string, Record<string, ModelRecord>> = {}

/** 磁盘缓存的写入时刻（0 = 从未成功写入）。 */
let cacheFileAt = 0

/** 磁盘缓存是否已尝试读过（成功或失败都算，避免每帧重试 IO）。 */
let diskTried = false

/** 后台刷新是否已在途（去重，避免并发重复下载 5 MB）。 */
let refreshing: Promise<boolean> | undefined

/**
 * ⚠️ 在途轮的**身份哨兵**（独立审计 P4）。
 *
 * `refreshing` 是 promise，没法回答「清槽的这一轮是不是发起它的那一轮」——
 * 而 `finally` 里必须能回答（否则会清掉别人的槽，见 P4）。
 * 故另设一个与本轮一一对应的对象，`refreshing` 发起时同步赋值。
 */
let refreshingToken: object | undefined

/** 在途刷新的开始时刻（用于识别「卡死」的那一次）。 */
let refreshingStartedAt = 0

/**
 * ⚠️ **同步**读磁盘缓存（模块加载时执行一次）。
 *
 * ## 为什么必须有这一步（真机事故 2026-10-02）
 *
 * DSH 内核在 `prompt` 准入阶段校验图片：
 * ```js
 * const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
 * if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
 *   throw new RemoteError(..., "Model ... does not support image input.")
 * ```
 * 那次校验**紧贴用户操作**发生，而能力表此前只靠**异步** `await readFile`
 * 填充 ⇒ 冷启动后有一段窗口里表恒为空 ⇒ `inputModalities` 报 `['text']`
 * ⇒ **网关发图被内核拒绝**。
 *
 * 「后台刷新后广播 `llm/adapters-updated`」救不了：广播只触发 UI 重渲染，
 * 不会重新走一次准入校验。
 *
 * 代价是插件加载多一次同步 IO（缓存文件 ~30 KB 量级），可接受。
 */
function loadDiskCacheSync(): void {
  if (diskTried) return
  diskTried = true
  try {
    const parsed = JSON.parse(readFileSync(modelsDevCacheFile(), 'utf8')) as CacheFile
    if (parsed?.version === CACHE_VERSION && isRecord(parsed.providers)) {
      const count = Object.values(parsed.providers).reduce((n, m) => n + Object.keys(m).length, 0)
      if (count > 0) {
        memory = parsed.providers
        cacheFileAt = typeof parsed.at === 'number' ? parsed.at : 0
      }
    }
  } catch {
    // 没有缓存文件是**正常**的（首次运行），后台会补齐。
  }
}

/** 渲染路径唯一入口：**同步**读，永不 await。 */
export function readModelsDevSync(): Record<string, Record<string, ModelRecord>> {
  loadDiskCacheSync()
  return memory
}

/** 缓存文件的写入时刻（0 = 从未成功写入），供 TTL 与可观测性判定。 */
export function modelsDevCacheAt(): number {
  loadDiskCacheSync()
  return cacheFileAt
}

/** 是否已成功拿到过目录（内存或磁盘任一）。 */
export function hasModelsDev(): boolean {
  return Object.keys(readModelsDevSync()).length > 0
}

/** 某 provider 块的**同步**读（`opencode` / `cline-pass` 等）。 */
export function readProviderModelsSync(provider: string): Record<string, ModelRecord> {
  return readModelsDevSync()[provider] ?? {}
}

/**
 * 直连 models.dev 并把**成功**结果落盘 + 写内存。**单次尝试**。
 *
 * ## ⚠️ 这是全仓**唯一**允许 fetch models.dev 的函数
 *
 * `tests/unit/models-dev-cache.spec.ts` 扫 `src/` 逐个 `.ts` 断言该字面量
 * 只出现在本文件。任何消费方绕过本模块直连，都会让那条扫描变红。
 *
 * ⚠️ **重试在调用方**（{@link fetchWithRetry}）而不是这里 —— 保持本函数
 * 「一次请求 = 一次判定」的单一职责，否则「解析为空」这类**不该重试**的失败
 * 也会跟着重来一遍。
 *
 * @returns 成功即 true；失败抛错（由调用方决定要不要重试）。
 */
async function fetchOnce(fetcher: typeof fetch = fetch): Promise<boolean> {
  const response = await fetcher(MODELS_DEV_URL, {
    headers: {
      Accept: 'application/json',
      // ⚠️ **必须显式声明**：服务端支持 Brotli，而 Node 原生 `fetch` 默认
      // 不带 `Accept-Encoding` ⇒ 每次都下**解压后 5 MB** 的明文，极易撞上
      // 超时上限（成功那次只用 1.9 秒，失败的都是整段卡死）。见 IKKZUG。
      'Accept-Encoding': 'br, gzip',
    },
    signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`)
  const parsed = parseModelsDev(await response.json())
  const count = Object.values(parsed).reduce((n, m) => n + Object.keys(m).length, 0)
  // ⚠️ 空结果**不写盘**：那会把磁盘上已有的好数据覆盖成空文件 ⇒ 下次冷启动
  //   真的什么都没有。失败必须「保留旧缓存」，这是本模块的核心不变式。
  if (count === 0) throw new Error('models.dev 解析结果为空（不覆盖既有缓存）')
  memory = parsed
  cacheFileAt = Date.now()
  diskTried = true
  // ⚠️ 注入的 fetcher（测试用）**不落盘**，免得污染真实缓存目录。
  if (fetcher !== fetch) return true
  const path = modelsDevCacheFile()
  await mkdir(join(path, '..'), { recursive: true })
  const payload: CacheFile = { version: CACHE_VERSION, at: cacheFileAt, providers: parsed }
  // ⚠️ **先写临时文件再 rename**：直接 `writeFile` 时进程中途被杀会留下
  //   半截 JSON，下次冷启动解析失败 ⇒ 缓存彻底失效（且静默）。
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(payload), 'utf8')
  await rename(tmp, path)
  return true
}

/**
 * ⚠️ 带**指数退避重试**的拉取（用户 2026-10-17：「重试 3 次都失败才完全放弃」）。
 *
 * ## 为什么值得重试
 *
 * 实测 models.dev 的失败**高度间歇**：同一分钟内 `200` / `45s 超时` / `200`
 * 交替出现。而失败时缓存**保持旧值继续用**（本模块的核心不变式）⇒
 * 重试的收益是「尽快追上上游」，代价是一次后台请求 —— 方向是安全的。
 *
 * ## ⚠️ 为什么退避间隔要**指数**增长
 *
 * 连着三次立刻打同一个刚挂死的站点毫无意义，而固定间隔可能整体落在同一个
 * 抖动窗口内。2s → 4s 的形状足以跨过典型瞬时抖动，且把「三次全败」的最坏
 * 等待控制在 {@link MODELS_DEV_WORST_CASE_MS}。
 *
 * ## ⚠️⚠️ **超时重试、主动中断不重试**（2026-10-17 独立审计 P5 澄清）
 *
 * 改前的注释写「中断不重试」，而实现只把 `TimeoutError` / `AbortError`
 * 合流成一个 `aborted` 标志、**只用来挑日志文案**，两者都照常重试
 * （实测 `AbortError` 也会打满 3 次）⇒ **注释是错的**。
 *
 * 拆开后的口径（这才是本意）：
 * - **`TimeoutError`** = 本模块自己的 `AbortSignal.timeout` 到期
 *   ⇒ 这是**网络慢**，正是重试要解决的情形 ⇒ **重试**；
 * - **`AbortError`** = **调用方**中断（signal aborted）⇒ 「有人要求停止」
 *   ⇒ **不重试**（重试会把卸载流程拖住最多 {@link MODELS_DEV_WORST_CASE_MS}）。
 *
 * ⚠️ 生产上当前**没有**调用方 signal 入口（`fetchOnce` 用的是自己的超时信号），
 *   所以这条区分目前主要是**契约正确性**：别让注释继续骗人。
 */
async function fetchWithRetry(
  fetcher: typeof fetch,
  options: RefreshModelsDevOptions,
): Promise<boolean> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MODELS_DEV_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(fetcher)
    } catch (error) {
      lastError = error
      // ⚠️ **主动中断不重试**（见上方 P5 澄清）：调用方 abort 是「要求停止」，
      //   不是网络故障；重试只会把卸载流程拖住。
      if (isCallerAbort(error)) throw error
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      // ⚠️ 最后一轮不必再等：等下来也没有下一次尝试了，白等一个退避间隔。
      if (attempt === MODELS_DEV_MAX_ATTEMPTS) break
      const wait = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
      if (timedOut) {
        options.warn?.(`[jet-hub] models.dev 刷新超时（第 ${attempt}/${MODELS_DEV_MAX_ATTEMPTS} 次），${wait}ms 后重试`)
      } else {
        options.warn?.(`[jet-hub] models.dev 刷新失败（第 ${attempt}/${MODELS_DEV_MAX_ATTEMPTS} 次）：${error instanceof Error ? error.message : String(error)}`)
      }
      await delay(wait, options.sleep)
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`models.dev 刷新失败：${String(lastError)}`)
}

/**
 * 该错误是否是**调用方主动中断**（而非网络故障/超时）。
 *
 * ⚠️ 与 `TimeoutError` 严格分开：`AbortSignal.timeout()` 到期抛的是前者，
 *   而「调用方 abort」抛的是 `AbortError` —— 两者都叫「被中止」但语义相反
 *   （一个该重试、一个不该），混淆会让注释与实现长期互相骗（独立审计 P5）。
 */
function isCallerAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name !== 'AbortError') return false
  // ⚠️ Node 的 `AbortSignal.timeout` 产出的错误 name 也是 `AbortError`
  //   （旧版本）或 `TimeoutError`（新版本）。用 `code` 进一步区分：
  //   `ABORT_ERR` 才是真正的调用方中断。
  const code = (error as { code?: unknown }).code
  return code === 'ABORT_ERR' || code === 20
}

/** 可中断的 sleep。`sleep` 可注入，使单测不必真等退避（见 {@link RefreshModelsDevOptions}）。 */
function delay(ms: number, sleep?: (ms: number) => Promise<void>): Promise<void> {
  if (sleep !== undefined) return sleep(ms)
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}

/** 构造选项（测试可注入时钟与 fetcher）。 */
export interface RefreshModelsDevOptions {
  fetcher?: typeof fetch
  now?: () => number
  /** 忽略 TTL 强制刷新（面板「刷新目录」用）。 */
  force?: boolean
  /** 日志出口。 */
  warn?: (message: string) => void
  /**
   * 刷新成功后的**次级**回调（在 {@link refreshModelsDev} 的 `onUpdated` 之后跑）。
   *
   * ⚠️ 存在的理由：主回调通常广播目录变更（对外可见），
   * 而消费方（`opencode-capability.ts`）需要作废自己的归一缓存（纯内部）。
   * 合成一个回调会迫使消费方在广播路径上做内存管理，出错时症状极难定位。
   */
  onUpdated?: () => void
  /**
   * 覆盖退避 sleep（**单测用**）。
   *
   * ⚠️ 为什么需要：真实退避是 2s → 4s，「三次全败」那条用例要真等 6 秒，
   * 会撞上 vitest 的 5s 单测超时。注入一个立即 resolve 的替身后，
   * 用例可以在**毫秒级**验证「恰好 3 次」与退避**次数**，且不必真的睡。
   *
   * ⚠️ 缺省时用真实 setTimeout（生产路径唯一形态）。注入点只影响等待，
   *   不影响尝试次数与成功判定 —— 那才是这条用例真正要锁的东西。
   */
  sleep?: (ms: number) => Promise<void>
}

/**
 * 后台刷新缓存（**永不阻塞**调用方，fire-and-forget）。
 *
 * @param onUpdated 刷新成功后的回调（接线层广播 `llm/adapters-updated`）。
 */
export function refreshModelsDev(
  onUpdated?: () => void,
  options: RefreshModelsDevOptions = {},
): void {
  void runRefresh(options, onUpdated)
}

/**
 * **可 await** 的刷新（供「必须拿到结果才能继续」的调用方，如 cline 目录闸门）。
 *
 * ## ⚠️ 与 {@link refreshModelsDev} 共用**同一个在途槽**
 *
 * 两者若各写一套，插件启动瞬间 opencode 与 cline 会各发一次 5 MB 请求 ——
 * 而 models.dev 的实测表现是「要么 ~2 秒、要么整段挂死」，并发两份只会把
 * 慢链路的代价翻倍。这里让 fire-and-forget 那条**转调**本函数，
 * 保证全仓**任何时刻至多一个** models.dev 请求在飞。
 *
 * @returns 是否成功。失败时**保留旧缓存**（`readModelsDevSync` 仍可用）。
 */
export function refreshModelsDevAsync(options: RefreshModelsDevOptions = {}): Promise<boolean> {
  return runRefresh(options)
}

/**
 * ⚠️⚠️ **本轮刷新成功后的订阅者**（独立审计 P2 的根治）。
 *
 * ## 为什么不能是「单个回调」
 *
 * 改前 `runRefresh(options, onUpdated)` 把回调存在局部变量里，而去重的做法是
 * `if (refreshing !== undefined) return refreshing` —— **后到者的回调被整个丢弃**。
 *
 * 实测触发形态（`index.ts` 里两行相隔 8 行、同步相邻、中间无 await）：
 * ```ts
 * primeModelsDev()                      // ← 不带回调，先占住 refreshing
 * refreshModelsDev(broadcast, {onUpdated})  // ← 命中 return refreshing，回调被丢
 * ```
 * ⇒ **每次冷启动且缓存超 6h TTL，`llm/adapters-updated` 永不发出**
 * （实测：fetch 1 次、广播 0 次、`onUpdated` 0 次）。
 *
 * ⚠️ 能力表本身能自愈（memory 换新对象身份 ⇒ 归一缓存失效），**真正丢的是广播**
 * ⇒ 首帧那套「text-only / 兜底表」渲染会一直保持到下次交互。
 *
 * ⇒ 改成**订阅者列表**：在途期间到来的每个回调都会被登记，成功后逐个兑现。
 */
let refreshSubscribers: Array<() => void> = []

/** 刷新实现（**唯一一份**，两个公开入口都走它）。 */
function runRefresh(options: RefreshModelsDevOptions, onUpdated?: () => void): Promise<boolean> {
  // ⚠️ 上一次若**卡死**（fetch 永不 settle 且超时信号未生效的极端情况），
  // `refreshing` 会被永久占住，之后所有刷新都被跳过、缓存永远补不上。
  //
  // ⚠️⚠️ 阈值必须用 {@link MODELS_DEV_DEADLOCK_MS}（= 480s），**不能**再写
  //   `MODELS_DEV_TIMEOUT_MS * 2`：加了重试之后单轮最坏耗时是
  //   {@link MODELS_DEV_WORST_CASE_MS} ≈ 276s，那个旧式子（180s）会小于它 ⇒
  //   **一次正在正常重试的刷新会被误判成「已死」而再起一个**，并发请求翻倍，
  //   恰好加剧我们要避免的上游压力。这是加长超时 + 加重试**必须同改**的耦合点。
  const now = options.now ?? (() => Date.now())
  if (refreshing !== undefined && now() - refreshingStartedAt > MODELS_DEV_DEADLOCK_MS) {
    refreshing = undefined
    refreshingToken = undefined
  }
  if (refreshing !== undefined) {
    // ⚠️⚠️ **登记订阅者而不是丢弃它**（独立审计 P2）。
    //   `index.ts` 的 `primeModelsDev()` 会先占住槽（它不带回调），8 行后的
    //   `refreshModelsDev(broadcast, …)` 就会走到这里 —— 改前直接
    //   `return refreshing`，那个广播回调**被整个丢掉** ⇒ 冷启动首刷的
    //   `llm/adapters-updated` 永不发出（实测 fetch 1 次 / 广播 0 次）。
    if (onUpdated !== undefined) refreshSubscribers.push(onUpdated)
    if (options.onUpdated !== undefined) refreshSubscribers.push(options.onUpdated)
    return refreshing
  }
  const fresh = cacheFileAt > 0 && now() - cacheFileAt < MODELS_DEV_TTL_MS
  if (!options.force && fresh) return Promise.resolve(true)
  refreshingStartedAt = now()
  // ⚠️ 本轮**自己**的订阅者也进列表，保证兑现路径只有一处。
  if (onUpdated !== undefined) refreshSubscribers.push(onUpdated)
  if (options.onUpdated !== undefined) refreshSubscribers.push(options.onUpdated)
  // ⚠️ `mine` 是**本轮的身份哨兵**，声明在 async IIFE **之前**。
  //   它存进 {@link refreshingToken}（不是 `refreshing`）⇒ `finally` 里能安全
  //   比对「当前在途是不是本轮」。⚠️ **不能**读 `task` 来比对（TDZ：fetcher
  //   立刻抛错时 IIFE 会在赋值前同步走到 `finally`）。见 P4 的注释。
  const mine = {}
  const task: Promise<boolean> = (async () => {
    try {
      // ⚠️ 走带重试的那条：3 次都失败才算「放弃这次更新」。
      const ok = await fetchWithRetry(options.fetcher ?? fetch, options)
      if (ok) {
        // ⚠️ 归一层的缓存也必须一起作废（消费方按 provider 块的对象身份记忆化，
        // 而成功刷新会**整体换掉**那块对象，所以它们靠身份变化自动失效；
        // 这里再显式给一个钩子，供「不靠身份」的订阅方使用）。
        //
        // ⚠️ 兑现顺序：**先取快照再清空**。若某个订阅者回调里又调了
        //   `refreshModelsDev`（理论上不该，但接线层是外部代码），
        //   在途去重会把它登记进**下一轮**的列表，而不是本轮的 —— 
        //   那样它会被**再兑现一次**。先清空则不会。
        const subscribers = refreshSubscribers
        refreshSubscribers = []
        for (const notify of subscribers) {
          try {
            notify()
          } catch (error) {
            // ⚠️ 一个订阅者抛错**不得**影响其余订阅者、更不得让本轮失败
            // （与仓库既有约定一致：告警出口必须被隔离）。
            options.warn?.(`[jet-hub] models.dev 刷新成功但某个订阅回调抛错：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return true
      }
      return false
    } catch (error) {
      // ⚠️ 失败（3 次都超时/报错）**保留现有缓存继续用**（能力退化为上一次的
      //   读数，而不是清空），只留一条日志便于排障。
      options.warn?.(`[jet-hub] models.dev 缓存刷新失败（已重试 ${MODELS_DEV_MAX_ATTEMPTS} 次，沿用上一次读数）：${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      // ⚠️⚠️ **只清属于自己的那个槽**（独立审计 P4）。
      //   改前是无条件 `refreshing = undefined`：若本轮已因「死锁超时」被判定为
      //   过期（`refreshing` 被另一次调用清空并重新赋值），而本轮稍后才 settle，
      //   它的 `finally` 会把**别人那轮的在途槽也清掉** ⇒ 第三次调用 C 又发一次
      //   请求 ⇒ 并发翻倍，正好加剧我们要避免的上游压力（实测 B 完成后 A 的
      //   finally 清空了 B 的槽）。
      //
      //   ⚠️ **不能**读 `task` 来比对（TDZ）：async IIFE 可能在本轮被赋给
      //   `refreshing` **之前**就同步走到 `finally`（fetcher 立刻抛错时），
      //   那时读 `task` 是 TDZ ⇒ 与**先声明**的身份哨兵 `mine` 比对。
      if (refreshingToken === mine) {
        refreshingToken = undefined
        refreshing = undefined
      }
    }
  })()
  // ⚠️ 两个变量**同步**赋值：promise 供调用方 await，哨兵供 `finally` 辨身（P4）。
  refreshingToken = mine
  refreshing = task
  return task
}

/**
 * 启动期预热：**同步**读一次磁盘缓存，然后**后台**补一次刷新。
 *
 * ⚠️ `ensureDiskLoaded` 那条 async 链是**刻意去掉**的：它只会「读到就返回、
 *   没读到就后台拉」，而 `loadDiskCacheSync()` 已经在同步路径上做了同一件事。
 *   多一条 async 链既不增加能力，又让「是否读到缓存」有两个判据。
 */
export function primeModelsDev(): void {
  loadDiskCacheSync()
  refreshModelsDev()
}

/** 清空内存与磁盘缓存（单测用）。 */
export async function clearModelsDevCache(): Promise<void> {
  memory = {}
  cacheFileAt = 0
  diskTried = false
  try {
    const { unlink } = await import('node:fs/promises')
    await unlink(modelsDevCacheFile())
  } catch {
    // 文件不存在是正常的
  }
}

/** 测试用：直接塞一份内存目录（不碰磁盘）。 */
export function setModelsDevForTest(providers: Record<string, Record<string, ModelRecord>>): void {
  memory = providers
  diskTried = true
  cacheFileAt = Date.now()
}