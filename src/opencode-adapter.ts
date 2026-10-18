/**
 * 某模型的输入模态（`LlmModelInfo` / `LlmResolvedModelInfo` 共用）。
 *
 * ⚠️ **能力表缺失时一律回退 `['text']`** —— 这是本仓库的硬约定：
 * 声明支持就必须真支持（Qoder 图片丢失事故的教训）。把「查不到」当成
 * 「支持」会让 DSH 把图片投影成上游根本不接受的形态。
 */
function inputModalitiesOf(
  capabilities: readonly OpencodeModelCapability[],
  modelId: string,
): readonly ['text'] | readonly ['text', 'image'] {
  return supportsOpencodeImage(capabilities.find((c) => c.id === modelId)) ? ['text', 'image'] : ['text']
}

/**
 * OpenCode Zen 模型适配器（账号槽 + 匿名槽平权混合池）。
 *
 * ## 平权轮换语义（设计文档 §5）
 *
 * 槽序列 = `[账号槽…（账号池手动顺序）] + [匿名槽（固定末位）]`。
 * 免费模型下**全序列**参与轮换；收费模型只由账号槽承载（匿名槽被剔除）。
 * 匿名殿后**只是位置，不是特权降级** —— 判据见 {@link pickSlot}。
 *
 * ## 身份即 key + IP + 随机会话
 *
 * opencode CLI 发往 Zen 的请求**没有机器指纹**（1.18.22 源码逐行核对），
 * 故「换一台 PC」在协议层等价于「换一个 key（账号）或换一个出口 IP（代理）」；
 * 指纹派生的作用是**防关联**与满足形状门禁，不参与配额计算。
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
import {
  OPENCODE, OPENCODE_FALLBACK_MODELS, classifyOpencodeError, isFreeOpencodeModel,
  isReachableOpencodeModel,
  type OpencodeErrorInfo, type OpencodeErrorKind, type OpencodeFallbackModel,
} from './opencode-product.js'
import { listIdentitySlots, type IdentitySlot } from './opencode-auth.js'
import { deriveRequestId, deriveSessionId, opencodeHeaders, opencodeUserAgent } from './opencode.js'
import { buildOpencodeRequest } from './opencode-messages.js'
import { normalizeOpencodeResponse } from './opencode-stream.js'
import {
  getOpencodeCapabilitiesSync, opencodeEffortName, supportsOpencodeImage,
  type OpencodeModelCapability,
} from './opencode-capability.js'
import { proxyFetch } from './opencode-proxy.js'
import { consumeOpenAiSse, collectImages, httpErrorCode, serializeMessages } from './openai-compat.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { reportLedgerAccount } from './token-ledger.js'
import { retryAfterMsFromResponse } from './retry-after.js'
import { planSessionTitleThinking } from './session-title.js'

/** 目录条目（远端与兜底共用的输出形状）。 */
export interface OpencodeCatalogEntry extends OpencodeFallbackModel {}

/** 默认目录 TTL（5 分钟，与 opencode2dsh 的 refreshSeconds=300 同档）。 */
const DEFAULT_CATALOG_TTL_MS = 300_000

const catalogCache = new Map<string, { at: number; entries: readonly OpencodeCatalogEntry[] }>()

/** 清空目录缓存（RPC 的「刷新目录」与单测隔离用）。 */
export function clearOpencodeCatalogCache(): void {
  catalogCache.clear()
}

/** 远端目录拉取（注入以便单测离线）。 */
export type OpencodeCatalogFetcher = (slot: IdentitySlot, signal?: AbortSignal) => Promise<Response>

/**
 * 拉取远端目录，失败回退静态兜底。
 *
 * @param ttlMs 命中内存缓存的窗口；测试传 0 强制每次都拉。
 *
 * ⚠️ 缓存按**槽 id** 分开存：不同账号的目录可能不同（付费可见性、
 * 地区封锁），共用一份缓存会让新加的账号迟迟看不到付费模型。
 */
export async function loadOpencodeCatalog(
  fetchCatalog: OpencodeCatalogFetcher,
  slot: IdentitySlot,
  ttlMs: number = DEFAULT_CATALOG_TTL_MS,
): Promise<readonly OpencodeCatalogEntry[]> {
  // ⚠️⚠️ **必须先读能力表**（Issue IKM9LR）：下面的 `isReachableOpencodeModel`
  //   依赖远端 `provider.api` 注入的可达性表，而注入发生在读能力表的那一刻。
  //   不先读 ⇒ 冷启动首帧那张表是空的 ⇒ filter 退化成硬编码本地表 ⇒
  //   远端明明下发了的新模型被挡掉（本 issue 的原症状，**完全静默**）。
  //   代价只是一次同步读（内存或磁盘文件），不引入任何等待。
  //
  // ⚠️⚠️ **这一句是顺序约束的唯一起作用点**（2026-10-17 对抗审计实测澄清）。
  //   `OpencodeAdapter.listModels` 原本也有一句同款前置读，实测证明那是**冗余**的
  //   （单独删掉它，全仓 9078+ 条单测仍全绿）⇒ 已删除，避免「两处同款前缀」
  //   且误导后来人以为改上面那处就够。
  //   **守卫**（`tests/unit/models-dev-cache.spec.ts` 的端到端用例）正是靠
  //   删掉**这一句**才变红 —— 它用本地表里没有的 `zzz-brand-new-x` 作断言，
  //   对「远端表是否生效」敏感（⚠️ 早先那版用 `deepseek-v4.1-flash-free`
  //   是**恒真**的：那个 id 已被收录进本地兜底表 ⇒ 顺序颠倒也照样绿）。
  getOpencodeCapabilitiesSync()
  const cached = catalogCache.get(slot.id)
  if (cached !== undefined && ttlMs > 0 && Date.now() - cached.at < ttlMs) return cached.entries
  let entries: readonly OpencodeCatalogEntry[]
  try {
    const response = await fetchCatalog(slot)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as { data?: unknown }
    if (!Array.isArray(body.data) || body.data.length === 0) throw new Error('空目录')
    const parsed: OpencodeCatalogEntry[] = []
    const seen = new Set<string>()
    for (const raw of body.data) {
      if (typeof raw !== 'object' || raw === null) continue
      const record = raw as { id?: unknown; name?: unknown; context_window?: unknown; limit?: { context?: unknown } }
      // ⚠️ `context_window` / `limit.context` 两个来源都保留，但**实测 Zen
      // `/v1/models` 从不下发**（85 条只有 `id`/`object`/`created`/`owned_by`），
      // 所以这里解析出来恒为 0。真正的窗口走能力表（models.dev 的 `limit.context`），
      // 见 `resolveModel` 里的 `capability?.contextWindow` 兜底链。
      // ⚠️ 这里**仍然解析**而不是删掉：Zen 将来若补上该字段就自动生效，
      // 删了等于把能力又退回「只能靠能力表」。
      const id = typeof record.id === 'string' ? record.id : ''
      if (id.length === 0 || seen.has(id)) continue
      // ⚠️⚠️ **按实测可达性过滤**（真实报障 2026-10-01）：远端 `/v1/models`
      // 返回全部 84 个模型且**不含协议信息**，直接暴露会让用户点到
      // `ling-3.0-flash-fin-free`（唯一端点已 500）、`claude-*`（我们未实现
      // messages 协议）等必然失败的模型。详见
      // `docs/superpowers/specs/2026-10-02-opencode-zen-endpoint-matrix.md`。
      if (!isReachableOpencodeModel(id)) continue
      seen.add(id)
      const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : id
      const ctx = typeof record.context_window === 'number'
        ? record.context_window
        : typeof record.limit?.context === 'number' ? record.limit.context : 0
      parsed.push({
        id,
        name,
        // ⚠️ 远端不下发「免费」标记，按本地表判定（表外一律 false）。
        isFree: isFreeOpencodeModel(id),
        // ⚠️ 窗口未知记 0（哨兵），**不编造**：`resolveModel` 判 > 0 才下发。
        contextWindow: Number.isSafeInteger(ctx) && ctx > 0 ? ctx : 0,
      })
    }
    if (parsed.length === 0) throw new Error('解析后为空')
    entries = parsed
  } catch {
    entries = OPENCODE_FALLBACK_MODELS
  }
  catalogCache.set(slot.id, { at: Date.now(), entries })
  return entries
}

export interface OpencodeAdapterOptions {
  /** 取当前槽序列（账号池顺序 + 匿名槽末位）。 */
  identitySlots: () => Promise<readonly IdentitySlot[]>
  /** 拉远端目录；缺省时直接用兜底表。 */
  fetchRemoteCatalog?: OpencodeCatalogFetcher
  /** 用户模型黑名单。 */
  disabledModels?: () => ReadonlySet<string>
  /** 记录受限的副作用（切槽时由接线层提供）。 */
  markLimited?: (slotId: string, modelId: string, resetAtMs: number) => Promise<void>
  /** 诊断日志。 */
  warn?: (message: string) => void
  /**
   * 附件字节读取。**只有声明了 image 模态的模型才需要**。
   *
   * ⚠️ 缺省时带图请求会抛 `UNSUPPORTED_CONTENT`（见 `resolveImageUrls`），
   * 而不是把图片静默丢掉（Qoder 图片丢失事故的教训）。
   */
  readImage?: (ref: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
}

/**
 * 按「平权」规则选一个可用槽。
 *
 * ⚠️ **收费模型跳过匿名槽**：匿名凭证（字面量 `public`）只被服务端认作
 * 免费通道，送付费模型必然 401/403。
 *
 * @param excluded 已试过的槽 id（`tried` 集合）——保证每个槽最多试一次。
 */
export function pickSlot(
  slots: readonly IdentitySlot[],
  modelId: string,
  excluded: ReadonlySet<string>,
): IdentitySlot | undefined {
  for (const slot of slots) {
    if (excluded.has(slot.id)) continue
    if (slot.kind === 'anonymous' && !isFreeOpencodeModel(modelId)) continue
    return slot
  }
  return undefined
}

/** 限流退避上限：服务端再狠也不让它单次阻塞超过 30 分钟。 */
const RETRY_AFTER_CAP_MS = 30 * 60_000
/** 匿名/账号额度穷尽时的默认标记时长（当日额度）。 */
const FREE_USAGE_DEFAULT_MS = 24 * 60 * 60_000
/** 首次 429 的默认冷却。 */
const RATE_LIMIT_BASE_MS = 60_000

/**
 * 把「错误语义 + 服务端给的延迟」换算成该槽该模型的受限时长（相对 now 的毫秒数）。
 *
 * ⚠️ **服务端给了就用它的**，且 **0 是合法值**（「立即解除」而非「未知」）：
 * 必须用 `retryAfterMs === undefined` 判空，写成 `?? default` 之外的任何
 * falsy 判据都会把 0 静默换成 1 小时 —— 那会让刚恢复的账号继续被跳过。
 * ⚠️ 没给才退避：`free_usage_limit` 按当日 24h（与 qoder 的「当日额度」同思路），
 * `rate_limit` 指数退避并封顶 30 分钟（否则单次阻塞可能数小时，UI 无法区分
 * 「在等」与「卡死」）。
 */
export function opencodeRetryAfterMs(
  kind: OpencodeErrorKind,
  retryAfterMs: number | undefined,
  attempt: number,
): number {
  if (retryAfterMs !== undefined) return Math.max(0, Math.min(retryAfterMs, RETRY_AFTER_CAP_MS))
  if (kind === 'free_usage_limit') return FREE_USAGE_DEFAULT_MS
  // ⚠️ 余额不足（402）：按**当日**标记，而不是短冷却 —— 钱不会在 60 秒内到账，
  // 短冷却会让同一个空钱包账号被反复选中、反复 402。
  if (kind === 'quota') return 24 * 60 * 60_000
  if (kind === 'auth') return RATE_LIMIT_BASE_MS
  return Math.min(RATE_LIMIT_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_AFTER_CAP_MS)
}

export class OpencodeAdapter extends LlmAdapter {
  constructor(private readonly options: OpencodeAdapterOptions) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : OPENCODE.id
    return { id, name: OPENCODE.displayName }
  }

  private async catalog(): Promise<readonly OpencodeCatalogEntry[]> {
    const slots = await this.options.identitySlots()
    // 目录用「账号槽优先」的那一身份拉取：付费模型只在认证通道的目录里
    // 完整，匿名目录看不到它们。
    const slot = slots.find((s) => s.kind === 'account') ?? slots.at(-1)
    if (this.options.fetchRemoteCatalog === undefined || slot === undefined) {
      return OPENCODE_FALLBACK_MODELS
    }
    // ⚠️ **不要**在适配器上再 memoize 一份：那会让目录永不过期 ——
    // 用户后加一个账号（付费模型本应随之可见）要重启 DSH 才能看到，
    // 表现为「key 明明有效却不显示付费模型」。刷新职责交给带 TTL 的
    // `loadOpencodeCatalog`（默认 5 分钟）。
    return loadOpencodeCatalog(this.options.fetchRemoteCatalog, slot)
  }

  /**
   * 完整目录（**同步**返回数组）。
   *
   * ⚠️ **绝不能写成 async**：`jet-hub-rpc.ts` 的 `ModelCatalogSource`
   * 接口是同步的且消费者**不 await**（`catalog = [...all]`），
   * 返回 Promise 会抛 `TypeError: all is not iterable`
   * （minimax 的同款真实缺陷，见 `minimax-adapter.ts` 的注释）。
   */
  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[] {
    return OPENCODE_FALLBACK_MODELS.map((m) => ({ id: m.id, name: m.name, isFree: m.isFree }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const slots = await this.options.identitySlots()
    // 无任何槽 = 连匿名槽都没了（异常态）：返回空数组隐藏 provider 分组，
    // **不抛错**（抛错会多一条 provider 级报错，UI 表现为「供应商加载失败」）。
    if (slots.length === 0) return []
    // ⚠️⚠️ **这里的顺序约束在下一行，不在本函数**（2026-10-17 对抗审计实测澄清）。
    //
    // 远端的「协议可达性」与「免费判定」两张表是由 `opencode-capability.ts`
    // 归一 models.dev 时注入的（见 `publishRemoteTables`），而注入发生在
    // **读能力表**的那一刻；`catalog()` 内部会逐条调
    // `isReachableOpencodeModel` / `isFreeOpencodeModel` 过滤远端目录。
    //
    // ⚠️ **本函数原本也有一句前置读**，注释写着「顺序不能颠倒」。实测
    //   （对抗审计 + 我复现）：**那句是冗余的** —— 真正兜住顺序约束的是
    //   `loadOpencodeCatalog` 里更靠前的那次读（它在 `catalog()` 被调用的
    //   更内层，必然先执行）。证据：单独去掉本函数那句，全仓 27+9084 条
    //   单测**仍全绿**；两处同时去掉，端到端守卫立刻变红。
    //
    // ⇒ 已删掉本函数那句（避免两处同款前缀、且让人误以为改这里就够了）。
    //    若将来 `catalog()` 出现**不经过 `loadOpencodeCatalog`** 的路径
    //    （例如直接用兜底表、或新增别的目录源），顺序约束会**重新失效** ——
    //    那时必须在这里补回，并**同时**补一条能抓住它的守卫。
    //
    // ⚠️ **同步**读（不 await）：渲染路径上等网络会让模型选择器一直空白
    // （真机事故 2026-10-02）。能力表在下面 map 时用到。
    const all = await this.catalog()
    const capabilities = getOpencodeCapabilitiesSync()
    // ⚠️ 可见性口径（用户定稿）：只有匿名身份时**只给免费模型**。
    // 免费判定以**远端 models.dev 的 cost** 为准（由上面那次读取注入）。
    const hasAccountSlot = slots.some((s) => s.kind === 'account')
    const visible = hasAccountSlot ? all : all.filter((m) => isFreeOpencodeModel(m.id))
    const disabled = this.options.disabledModels?.() ?? new Set<string>()
    return visible
      .filter((m) => !disabled.has(m.id))
      .map((m) => ({
        provider: OPENCODE.id,
        id: m.id,
        name: m.name,
        // ⚠️ 模态以**远端能力表**为准，不再一律 text（用户报障
        // 「space-bunny-free 发图提示不支持」：该模型实测接受图片，
        // 而我们硬编码 ['text'] 让 DSH 在本地就把图投影成了文字占位符）。
        // ⚠️ 能力表拿不到时**保守回退 text**（`inputModalitiesOf` 的实现）——
        // 声明支持就必须真支持，这是本仓库的硬约定。
        inputModalities: inputModalitiesOf(capabilities, m.id),
      }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.catalog()
    const entry = all.find((m) => m.id === model)
    const capabilities = getOpencodeCapabilitiesSync()
    const capability = capabilities.find((c) => c.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: inputModalitiesOf(capabilities, model),
    }
    // ⚠️⚠️ **窗口必须从能力表取，不能只信 catalog**（issue IKJJ68）。
    //
    // 此前只读 `entry.contextWindow`（catalog 条目），而它来自 Zen `/v1/models`
    // —— 实测该端点**只返回 4 个字段**（`id`/`object`/`created`/`owned_by`，
    // 85 条全如此），**从不带 `context_window`**，于是恒为 0 ⇒ 走下面
    // `> 0` 的否分支 ⇒ `resolved.context` 整个不声明 ⇒ 后果有二：
    //   ① 上下文占用指示器不渲染（它读 `model.contextWindow`）；
    //   ② 自动压缩抛 `TargetPressureConfigError: contextWindow (…) must be a
    //      positive integer`（见 dsh-compaction-basic）。
    //
    // 真正的窗口在 models.dev 的 `limit.context`（`opencode-capability.ts` 早已采集，
    // 只是**采了没用**）。兜底顺序：能力表 → catalog 条目 → 都不给就不声明。
    const contextWindow = capability?.contextWindow ?? entry?.contextWindow ?? 0
    // ⚠️ 窗口未知**不编造**：0 是「不知道」哨兵，不能当合法窗口下发。
    if (contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    // ⚠️⚠️ **刻意不声明 `defaultMaxTokens`**（issue IKJJ68 提到它，这里说明取舍）：
    //
    // DSH 的契约是「用户未指定 `max_tokens` 时直接拿它填请求」
    // （`defaulted = config.maxTokens === undefined && info.defaultMaxTokens !== undefined
    //   ? { maxTokens: info.defaultMaxTokens } : …`），且必须是**安全正整数**，
    // 否则 dsh-llm 直接抛 `adapter returned invalid default maxTokens`。
    //
    // 能力表里有 `limit.output`（models.dev 的 `limit.output`），但那是
    // **模型单次输出上限**，不是「合理的默认输出预算」。实测 2026-10-02：
    //   · big-pickle = 32000、nemotron-3-ultra-free = 128000、
    //     space-bunny-free = **524288**（荒谬）
    //   · 给到这些值**不会被服务端拒绝**（三个都 200 —— 我最初担心的
    //     「免费通道会拒」**不成立**，已推翻）
    //   · **不给** `max_tokens` 时服务端用自己的默认值，实测 667 tokens
    //     且 `finish=stop`（自然结束，非截断）
    //   · 唯一真实风险是**给小了被限死**：给 100 就真的 `finish=length` 截在 100
    //
    // ⇒ 不下发：当前「不下发」的行为实测就是好的，而下发等于**我们替用户决定**
    // 每轮按上限请求（space-bunny-free 的 51 万尤其荒谬）。真要默认值，
    // 应当按渠道实测出一个安全值，而不是拿上限顶替。
    // ⚠️⚠️ **思考档位**（issue IKJJ0V 修复，此前完全没声明 ⇒ 选择器永不出现）。
    //
    // 契约（读 DSH 内核 `dsh-api-session-controller/lib/types/catalog.js` 得到，
    // 它直接把本字段映射成客户端目录）：
    //   reasoning: { efforts: Array<{ id, name, description? }>, defaultEffort? }
    // 客户端**直接渲染** `efforts[].name`（不本地化、不查字典），故 name 必须给中文。
    //
    // ⚠️ 档位为**空**时**不声明**本字段（而不是给 `efforts: []`）：DSH 的判定是
    // `resolved.reasoning === undefined ? undefined : {…}`，声明空数组会让 UI
    // 出现一个没有任何档位的空选择器。
    if (capability !== undefined && capability.efforts.length > 0) {
      resolved.reasoning = {
        efforts: capability.efforts.map((effort) => ({
          // ⚠️ `id` 是**品牌类型**（`ReasoningEffortId`），必须经它的构造函数 ——
          // 与 Qoder 同款（`src/qoder-adapter.ts`）。
          id: ReasoningEffortId(effort),
          // ⚠️ 没有官方中文的档位（models.dev 会下发 `minimal` / `xhigh` 等
          // Qoder 那份表里没有的值）**回退到 id 本身** —— 宁可显示英文原值，
          // 也不猜一个可能错译的中文。
          name: opencodeEffortName(effort),
        })),
      }
      // ⚠️ `defaultEffort` **刻意不下发**：models.dev 没有 `is_default` 字段
      // （Qoder 的目录里有），无从判断默认值。让 DSH 自行取第一档，
      // 也不写死一个可能与上游默认不符的档位。
      // ⚠️ 若将来要下发，**必须落在 `efforts` 内** —— DSH 会直接拿它发请求，
      // 给不存在的档位会抛 UNSUPPORTED_REASONING_EFFORT（同 Qoder 的注释）。
    }
    return resolved
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return { model: await this.resolveModel(provider, model, signal), stream: (o) => this.stream(o) }
  }


/**
 * 平权轮换：失败按「语义」标记该槽 → 换下一槽重发。
 *
 * ⚠️ 三条硬规则（每条都对应一类真实缺陷）：
 *
 * 1. `tried` **跨迭代保留** —— 每次迭代重置会让两个槽之间无限来回
 *    （qoder 实测：标记记录是 `['acct-A','acct-A']` 而非 `['acct-A','acct-B']`）。
 * 2. **已交付内容的流不重放** —— 重放会让用户看到重复输出。
 * 3. 收费模型**不经匿名槽**（匿名凭证只认免费模型，见 `pickSlot`）。
 */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const slots = await this.options.identitySlots()
    if (slots.length === 0) {
      throw new LlmError('opencode: 没有可用通道', 'MISSING_CREDENTIAL')
    }
    // ⚠️ **先判「有没有任何槽能承载这个模型」**，再进轮换：
    // 收费模型 + 无账号槽是**配置问题**（用户没加 key），不是配额问题。
    // 混进轮换会让它以「所有通道均受限 / QUOTA_EXCEEDED」的面目出现 ——
    // 用户看到「额度用尽」却根本不知道自己缺的是 API key（写单测时实测到）。
    if (pickSlot(slots, options.model, new Set()) === undefined) {
      throw new LlmError(
        `opencode: 模型 "${options.model}" 需要 API key 账号通道（匿名通道只支持免费模型），`
        + '请先在 Jet Hub 的 OpenCode 面板添加一个账号',
        'MISSING_CREDENTIAL',
      )
    }

    const tried = new Set<string>()
    const limited: string[] = []

    for (;;) {
      const slot = pickSlot(slots, options.model, tried)
      if (slot === undefined) {
        // 全 tried ⇒ 每个槽都试过一次。收费模型走到这里通常是「没有账号槽」。
        throw new LlmError(
          `opencode: 所有通道对该模型均受限${limited.length > 0 ? `（${limited.join('、')}）` : ''}`,
          'QUOTA_EXCEEDED',
        )
      }
      tried.add(slot.id)
      // Token 账本（第 2 期）：回报「本笔请求实际使用的槽」（匿名槽 = 'anonymous'）。
      reportLedgerAccount(OPENCODE.id, slot.id)

      let delivered = false
      try {
        for await (const chunk of this.streamVia(slot, options)) {
          // ⚠️ **任何 chunk 产出都算「已交付」**：本仓库的 `StreamChunk` 联合
          // （`block-start` / `*-delta` / `block-end` / `usage` / `finish`）里
          // **没有**「内容之前的前置事件」—— 原设计假设有个 `start` 事件，
          // 实际类型里不存在（tsc 直接报 TS2367 点破了它）。既然不存在，
          // 区分「前置」与「内容」就无从谈起，保守取「一律算交付」：
          // 宁可漏掉一次可切换的机会，也绝不重放（重放会让用户看到重复输出）。
          delivered = true
          yield chunk
        }
        return
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error
        if (delivered) throw error
        if (error instanceof LlmError && (error.code === 'QUOTA_EXCEEDED' || error.code === 'PERMISSION_DENIED')) throw error

        const info = classifyOpencodeFailure(error)
        if (info.kind === 'free_tier') {
          // V2 同时校验 session 算法、UA/关联头、工具描述与 schema。
          // 换槽不改变这些协议字段；不得把拒绝原因写死为 session 外形。
          this.options.warn?.(
            `opencode: 免费通道被 FreeTierError 拒绝 —— 检查 V2 端点、session 算法、UA 与工具 schema：${info.detail}`,
          )
          // ⚠️⚠️ **错误码绝不能取 `AUTH`**（真实缺陷，Gitee issue IKLBSH 归位）。
          //
          // `AUTH` 会让 DSH 客户端**丢弃本条 message、换成固定文案「API 密钥无效」**
          //（`dsh-client-ui-chat/lib/client.js` 的 `failureMessage`；判据与
          // `buddy-adapter.ts` 的 `contentRejectionError` 注释同源）。而本条文案
          // 恰好是**唯一**能指路的那句 —— 它说的是「根因是 session id **形状**、
          // 换 key 或换出口都无效」。换成「API 密钥无效」后用户会去换 key / 重新登录，
          // 全是无效动作，而**真实报文（`info.detail`）也一并消失**。
          //
          // 库内实测取证（866 个会话，`scripts/tmp-scan-iklbsh.mjs`）：两条真实
          // `turn/end` 失败事件的 code 就是 `AUTH`，message 正是本函数写的那句
          // `opencode: HTTP 403 — {"type":"error","error":{"type":"FreeTierError",…}}`
          // —— 即本条缺陷**在真实流量上发生过**（会话
          // `session-d7c80d34`，2026-10-02）。
          //
          // 取下 `PERMISSION_DENIED`：① 客户端不替换它，文案完整送达；
          // ② `dead-model-store` 的 `IGNORED_CODES` 收它，模型**不会**被误记成
          //    下架 30 天（`AUTH` 也在该集合里，这一条两侧等价）；
          // ③ 它不在 `DEFAULT_RETRYABLE_CODES` 里 ⇒ 仍是「确定性、不白退避」，
          //    与本分支「不重试也不换槽」的设计一致。
          // 与 `buddy` 的 11140（同样从 `AUTH` 改成 `PERMISSION_DENIED`）同款裁决。
          throw new LlmError(
            `opencode: 免费通道被上游拒绝（FreeTierError）。`
            + '该错误由请求协议门禁触发，请检查 V2 端点、session 算法、请求头及工具描述/schema；换 API key 或换出口都无效。',
            'PERMISSION_DENIED',
            { status: 403 },
          )
        }
        if (info.kind === 'quota') {
          // 402 / 余额不足：换槽无意义（同账号的钱包是同一个），但**换账号有意义**。
          // ⚠️ 不能当 server 处理 —— harness 会重试 5 次（约 15 秒）而永远不会成功。
          await this.options.markLimited?.(slot.id, options.model, Date.now() + 24 * 60 * 60_000)
          limited.push(`${slot.id}(余额不足)`)
          continue
        }
        if (info.kind === 'auth') {
          // 认证失败（401/403 无类型名）：**标记并切下一个账号**是对的，
          // 但**不能**把它当限流那样「耗尽所有槽后报 QUOTA_EXCEEDED」——
          // 匿名槽失败时只有它一个，报「所有通道均受限」会让用户以为要等额度，
          // 而真实原因是「这条通道没凭证/不被接受」。故最后一次失败直接透传。
          if (tried.size >= slots.length) throw error
          await this.options.markLimited?.(slot.id, options.model, Date.now() + RATE_LIMIT_BASE_MS)
          limited.push(`${slot.id}(认证失败)`)
          continue
        }
        if (info.kind === 'server' || info.kind === 'transport') {
          // 上游故障/网络问题：不标记（不是配额问题），只换下一个。
          this.options.warn?.(`opencode: 通道 ${slot.id} ${info.kind}，换下一个：${info.detail}`)
          continue
        }
        // 限流 / 额度 / 认证：标记该槽后换下一个。
        const resetAtMs = Date.now() + opencodeRetryAfterMs(info.kind, info.retryAfterMs, tried.size)
        await this.options.markLimited?.(slot.id, options.model, resetAtMs)
        limited.push(`${slot.id}(${info.kind})`)
      }
    }
  }

  /**
   * 解析消息里的图片附件为 data URL。
   *
   * ⚠️ **模型不支持图片时直接抛 UNSUPPORTED_CONTENT**（而不是静默丢弃）——
   * 静默丢弃会让用户以为模型看到了图（Qoder 图片事故的教训）。
   * ⚠️ 附件字节读不出来时写入**空 Map**：`openai-compat` 的
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

    const capabilities = getOpencodeCapabilitiesSync()
    if (!supportsOpencodeImage(capabilities.find((c) => c.id === model))) {
      throw new LlmError(
        `opencode: 模型 "${model}" 不支持图片输入（能力以远端 models.dev 为准）`,
        'UNSUPPORTED_CONTENT',
      )
    }
    if (this.options.readImage === undefined) {
      throw new LlmError('opencode: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
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

  /** 用指定槽发一次请求（轮换循环的复用单元）。 */
  protected async *streamVia(slot: IdentitySlot, options: GenerateOptions): AsyncIterable<StreamChunk> {
    // ⚠️ **图片**：`inputModalities` 声明了 image 的模型，DSH 才会把图片
    // 投影进消息；序列化时要用 `imageUrls` 把 attachmentId 换成 data URL，
    // 否则图片会被静默丢掉（Qoder 图片丢失事故的同型缺陷）。
    const imageUrls = await this.resolveImageUrls(options.model, options.messages)
    const messages = serializeMessages(options.messages, imageUrls)
    /**
     * 会话自动命名（`purpose: 'session-title'`）的思考与预算决策（issue IKKVDH）。
     *
     * DSH 用 **64 token** 发标题请求且**不传 `reasoningEffort`**，而宿主会把
     * `normalizeEfforts` 声明的默认档注入进来。本家的档位来自 models.dev
     * `reasoning_options`：`effort` 形态给原值、`toggle` 形态给
     * `['none','low']`（含 `none`）⇒ 声明了 `none` 的模型关得掉；
     * `budget_tokens` 形态**不声明档位**（见 `normalizeEfforts`）⇒ 只能抬预算兜底。
     */
    const titlePlan = planSessionTitleThinking({
      purpose: options.purpose,
      requestedEffort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      // ⚠️ 档位声明与 `resolveModel` **同源**（能力表的 `efforts`，来自 models.dev）
      // —— 自己另查一份必然漂移：UI 给了「关闭思考」而请求把它丢掉的缺陷形态。
      declaredEfforts: getOpencodeCapabilitiesSync().find((c) => c.id === options.model)?.efforts ?? [],
      maxTokens: options.maxTokens,
    })
    const request = buildOpencodeRequest({
      model: options.model,
      messages,
      ...options.system !== undefined && options.system.length > 0 ? { system: options.system } : {},
      ...options.tools !== undefined ? { tools: options.tools } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...titlePlan.maxTokens !== undefined ? { maxTokens: titlePlan.maxTokens } : {},
      // ⚠️ 思考档位（issue IKJJ0V）：`ReasoningEffortId` 是品牌类型，转普通字符串。
      // `none`（关闭思考）也照发 —— models.dev 的 toggle 形态就产出这一档。
      // ⚠️ 标题请求改走 `titlePlan.effort`（声明了 `none` 时就是它）。
      ...titlePlan.effort !== undefined
        ? { reasoningEffort: titlePlan.effort }
        : {},
    })
    const headers: Record<string, string> = {
      ...opencodeHeaders(slot.fingerprint, sessionIdOf(options), deriveRequestId(), opencodeUserAgent(slot.userAgent)),
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${slot.apiKey}`,
    }
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(request.payload),
      ...options.signal !== undefined ? { signal: options.signal } : {},
    }
    // ⚠️ 走 `proxyFetch` 而不是裸 `fetch`：有代理时它会把请求交给**与
    // dispatcher 同源**的 undici fetch。用全局 fetch 会造成跨实例 handler
    // 契约冲突（Node 22/24 上恒失败），详见 `opencode-proxy.ts` 的 `proxyFetch`。
    // 它内部处理「无代理时退回全局 fetch」，故这里不再自行分支。
    // 只约束响应头等待；头到达即撤销定时器，不能误杀长回答。
    const headerController = new AbortController()
    const headerTimer = setTimeout(() => headerController.abort(new LlmError('opencode: 等待响应头超时', 'TIMEOUT')), OPENCODE.chatHeaderTimeoutMs)
    let response: Response
    try {
      response = await proxyFetch(`${OPENCODE.baseUrl}${OPENCODE.chatPath}`, {
        ...init,
        signal: options.signal === undefined ? headerController.signal : AbortSignal.any([options.signal, headerController.signal]),
      }, slot.proxy)
    } catch (error) {
      if (headerController.signal.aborted) throw headerController.signal.reason
      throw error
    } finally {
      clearTimeout(headerTimer)
    }
    if (!response.ok) {
      // ⚠️ **必须先读体**：Zen 的限流语义（`GoUsageLimitError`）在响应体里，
      // 而 body 只能读一次 —— 读了不传下去，轮换层就只能按状态码猜，
      // 把「额度耗尽」误判成「key 失效」（HTTP 层的 httpErrorCode 就会这么干）。
      const text = await response.text().catch(() => '')
      // ⚠️ 只解析一次：头值是 HTTP 日期时，两次调用会算出**毫秒级不同**的值。
      // 解析实现收敛在 `src/retry-after.ts`（0 是合法值，判空必须用 `=== undefined`）。
      const retryAfterMs = retryAfterMsFromResponse(response.headers)
      throw new LlmError(
        `opencode: HTTP ${response.status} — ${text.slice(0, 300)}`,
        httpErrorCode(response.status, text),
        {
          status: response.status,
          // ⚠️ 走 dsh-llm 的**官方契约**字段（`LlmErrorOptions`）：
          // 上游给的等待时长不必自己发明字段名，harness 也认它。
          ...retryAfterMs === undefined
            ? {}
            : { providerRetryAfterMs: retryAfterMs },
        },
      )
    }
    // ⚠️ 传 `warn`：响应层剔除未知/保留/残缺工具名时必须在宿主日志留痕，
    // 否则「模型不再调工具」会变成一条查不出原因的静默退化。
    const normalized = normalizeOpencodeResponse(response, request, this.options.warn)
    try {
      yield* consumeOpenAiSse(normalized, options.signal !== undefined ? { signal: options.signal } : {}, {
        label: 'opencode',
        firstTokenTimeoutMs: OPENCODE.chatHeaderTimeoutMs,
        chunkTimeoutMs: OPENCODE.chatChunkTimeoutMs,
        ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      })
    } finally {
      // 共享消费器只 releaseLock；提前结束、取消与抛错都由本渠道释放前置流/上游。
      await normalized.body?.cancel().catch(() => {})
    }
  }
}

/**
 * 从 `LlmError` 还原成语义化分类。
 *
 * ⚠️ 事实挂在 `error.failure` 上（`LlmFailure` 契约），**不是**展开在 error 自身
 * —— 早期版本误按「自身属性」读响应头，`retry-after` 因此永远读不到，
 * 于是 `GoUsageLimitError` 的 600 秒被当成「未知」退化成 1 分钟
 * （写单测时实测到：`expected 590000, got 60000`）。
 *
 * 分类仍以**响应体文案里的类型名**为准（`message` 里带着前 300 字原文），
 * HTTP 状态码只作辅助 —— Zen 的额度错误经常带 403。
 */
function classifyOpencodeFailure(error: unknown): OpencodeErrorInfo {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    failure?: { status?: unknown; providerRetryAfterMs?: unknown; message?: unknown }
  }
  const status = typeof failure.failure?.status === 'number' ? failure.failure.status : 0
  const providerRetryAfterMs = typeof failure.failure?.providerRetryAfterMs === 'number'
    && Number.isFinite(failure.failure.providerRetryAfterMs)
    ? failure.failure.providerRetryAfterMs
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  const info = classifyOpencodeError(status, message)
  return providerRetryAfterMs === undefined
    ? info
    : { ...info, retryAfterMs: info.retryAfterMs ?? providerRetryAfterMs }
}

/**
 * 会话级 session id：同一 DSH 会话内保持稳定。
 */
const sessionIds = new WeakMap<object, string>()

function sessionIdOf(options: GenerateOptions): string {
  const key = options.messages as unknown as object
  if (typeof key !== 'object' || key === null) return deriveSessionId()
  const existing = sessionIds.get(key)
  if (existing !== undefined) return existing
  const created = deriveSessionId()
  sessionIds.set(key, created)
  return created
}

/** 在 `ctx.llm` 上注册 opencode 路由。 */
export function registerOpencodeLlm(ctx: Context, options: OpencodeAdapterOptions): OpencodeAdapter {
  const adapter = new OpencodeAdapter(options)
  registerAdapterIdempotent(ctx.llm, [OPENCODE.id], adapter)
  return adapter
}

export { listIdentitySlots }
