/**
 * OfficeAce 适配器：把 DSH 的 `LlmAdapter` 调用转发到华为 ModelArts MaaS。
 *
 * ## 与 AutoClaw 适配器的差异
 *
 * - **直连云端**（无本地网关）；凭据从本机 Redis 读（见 `officeace-auth.ts`）
 * - `listModels` 静态（`OFFICEACE_MODELS`）+ 探测门控（凭据读不到 = 隐藏分组）
 * - 响应含 `reasoning_content`，`consumeOpenAiSse` 已兼容 OpenAI 协议
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { OFFICEACE, OFFICEACE_MODELS } from './officeace-product.js'
import { basicAuthorization, fetchModelTokenRates, isExpiring, readOfficeAceCredential, refreshStoredCredential, type OfficeAceCredential } from './officeace-auth.js'
import { collectImages, consumeOpenAiSse, serializeMessages } from './openai-compat.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { createModelCatalog, isCatalogFreshFor, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { buildDsmlSystemPrompt, needsDsmlToolMode, type DsmlToolSpec } from './dsml.js'
import {
  isBasicCredentialRejection,
  noteOfficeaceRejection,
  noteOfficeaceSuccess,
  officeaceBreakerState,
} from './officeace-credential-health.js'

/**
 * 「重发一次有没有意义」的指纹：**决定 Basic 鉴权与目标 host 的三个字段**。
 *
 * ⚠️ 它**不是**「同一对已被拒绝的 key」那个指纹（`officeaceCredentialFingerprint`
 * 只含 Basic 二元组）：本函数要多含 `maasBaseUrl`，因为 2026-10-13 那个真实缺陷里
 * **只有网关变了**（华为按账号下发专属网关 `modelgw-0004.…`，打错硬编码 host 恒 401，
 * 而 Basic 二元组完全正确）⇒ 换 host 后重发**是**有意义的。
 * 两个问题不同，故两份判据并存，且各自注释说明为什么不能合并。
 */
function basicAuthFingerprint(credential: OfficeAceCredential): string {
  return `${credential.modelAppKey}\u0000${credential.modelAppSecret}\u0000${maasBaseUrlOf(credential)}`
}

/**
 * 401 时「续期这一次到底发生了什么」的**四态**。
 *
 * ⚠️ 刻意不用布尔：`unreadable`（续期后读不到凭据）与 `unchanged`（读到了但逐字节
 *    没变）指向**完全不同的下一步动作**，混成一个布尔必然给错指引。
 */
type RenewalOutcome = 'not-attempted' | 'unchanged' | 'changed' | 'unreadable'

/**
 * 推理/探测该用哪个 host —— **必须优先用凭据里按账号下发的 `maasBaseUrl`**。
 *
 * ## ⚠️⚠️ 这是一个阻断级真实缺陷（2026-10-13 真机实测）
 *
 * 症状：Jet Hub 里 provider 列表**有** OfficeAce、账号也在，但**对话的模型选择器里
 * 一个 OfficeAce 模型都看不到**。
 *
 * 根因：适配器原先一律打硬编码的 `OFFICEACE.defaultBaseUrl`
 *（`https://officeace.cn-southwest-2.huaweicloud-agentarts.com`），
 * 而华为**按账号下发专属网关** `modelgw-0004.officeace.cn-southwest-2...`。
 * 同一个 Basic 凭据实测：
 *
 * | host | `/v2/models` | `/v2/chat/completions` |
 * |---|---|---|
 * | `officeace…`（硬编码）| **401** `APIG.1009 AppKey or AppSecret is invalid` | **401** |
 * | `modelgw-0004.officeace…`（凭据里）| **200** | **200** |
 *
 * 后果链：`probe` 401 ⇒ `listModels` 返回 `[]` ⇒ 模型选择器**空分组**；
 * 且 `listModels` 的空返回与「无账号」**同形**，故「目录门控」会把整个
 * provider 隐藏 —— 用户看到的就是「加了账号却没有模型」。
 *
 * ⚠️ 字段其实早就写进了凭据（`fetchModelInfo` 从云侧 `model_api_url_base` 取），
 *    只是**从没被读过** —— 属「写了不读的死字段」，我在此前审计中已登记为
 *    已知缺口并**低估了它**（判为影响有限），真机证明它是主路径。
 *
 * ⚠️ **只用于 Basic 鉴权的推理/探测路径**。V11 签名那套（`/v1/subscription`、
 *    `/v1/model-token-rates`）实测**两个 host 都存在且都要求签名**，
 *    属管理面 API，**不要**一起改。
 *
 * @returns 规范化（去尾斜杠）后的 base URL；凭据没带时回退默认域（零行为变化）。
 */
export function maasBaseUrlOf(credential: OfficeAceCredential): string {
  const raw = typeof credential.maasBaseUrl === 'string' ? credential.maasBaseUrl.trim() : ''
  const base = raw.length > 0 ? raw : OFFICEACE.defaultBaseUrl
  return base.replace(/\/+$/, '')
}

export interface OfficeAceAdapterOptions {
  /** 凭据（测试注入）；缺省每次从本机读取。 */
  /**
   * 取当前可用凭据。
   *
   * ★ **2026-11-25：可选收 `sessionId`** —— 子代理起点分配要用它
   * （本家**自建选号**，不走 `createCredentialResolver`，
   *  而子代理设置原先对它**静默无效、零报错**）。
   *
   * ⚠️ **保持向后兼容**：既有嵌入方传的是**零参函数**，多一个可选参数
   *    不影响它们（传 `(` 时那个参数就是 `undefined`）。
   * ⚠️ 未传 / 传 `undefined` ⇒ 选号与改动前**逐字节相同**。
   */
  credentialProvider?: (sessionId?: string) => Promise<OfficeAceCredential | undefined>
  /**
   * **只读目录探测**专用凭据（`listModels` 的 `/v2/models` 探测与倍率读取）。
   *
   * ⚠️⚠️ **它刻意不走 `credentialProvider`**（Gitee issue IKLTHB 第 ① 条的连带
   *    缺陷，2026-10-15 自查发现）：`credentialProvider` 在「锁定永久积分且只剩
   *    永久桶」时**抛错**，而 `listModels` 的调用方**全都不接**这个错 ——
   *    `dsh-llm` 的 `llm.listModels()` 直接 `await` 适配器方法（无 try/catch），
   *    后果是一串与「锁定」毫不相干的症状：
   *
   *    | 调用方 | 症状 |
   *    |---|---|
   *    | `jet-hub-rpc.ts` 的 `model.list` | 面板报「读取模型列表失败：…锁定…」|
   *    | `jet-hub-rpc.ts` 的 `readableCatalogIds` | 「关闭供应商 / 关闭全部」被拒（`remoteError`）|
   *    | `aggregate-adapter.refreshCatalog` | 记一条 warn 后**跳过该渠道**（静默少一个候选）|
   *    | DSH 模型选择器 | 分组消失（与「目录门控」的空分组同形）|
   *
   *    ⇒ 判定写得很清楚：**锁定约束的是「推理取号」，不是「能不能读目录」**。
   *    `/v2/models` 与 `/v1/model-token-rates` 都是**只读、不扣积分**的，
   *    没有理由因为锁定而把它们也一起关掉（buddy 系就是这样的：锁定后模型
   *    照常列在目录里，发消息才报「没有可用账号」）。
   *
   * 缺省（未注入）时回落到 `credentialProvider` —— 保持既有嵌入方与单测行为不变。
   */
  probeCredential?: () => Promise<OfficeAceCredential | undefined>
  /** 覆盖默认的 fetch（测试注入）。 */
  fetchImpl?: typeof fetch
  /**
   * 凭据续期（宿主在「登录 / 点刷新积分」等时机调用）。
   *
   * ⚠️ **必须由接线层注入**：漏接的症状是该渠道的账号永不过期 —— 用户重新登录后
   *    旧凭据仍被继续用，且日志里一个字都没有（守卫用例断言
   *    `ctx.llm.adapterByProvider.get(id).options.refresh` 是函数）。
   */
  refresh?: () => Promise<void>
  /**
   * 图片读取桥（宿主 `makeReadImage(ctx)`）—— **图片输入的必要条件**。
   *
   * 未提供时收到图片消息会报 `UNSUPPORTED_CONTENT`（与 trae 同约定）：
   * 静默丢图会让用户以为模型看到了图，实际它什么都没看见。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 黑名单模型 id（面板「显示列表」开关）。 */
  /**
   * 账号池（**黑名单、关闭意图、目录门控的唯一数据源**）。
   *
   * ⚠️⚠️ **2026-10-23 迁移**：本家此前手写 `listModels`，黑名单与关闭意图靠
   * `disabledModels` / `providerClosed` 两个**选项回调**传进来。那两个字段
   * 已随迁移删除 —— 现在统一由共享骨架（`model-catalog.ts`）从本池读取。
   *
   * ⚠️ 省略时（单测 / 嵌入方）行为退回「不过滤、不判关闭意图」；
   * **生产接线必须传**（`index.ts` 负责，且有守卫逐家点名）。
   */
  accountPool?: import('./account-pool.js').AccountPool
  /**
   * 目录新鲜度用的时钟（**只**用于 `isCatalogFresh`，不参与任何业务判定）。
   *
   * ⚠️ 缺省 `Date.now()`；注入它只是为了让「20 分钟 TTL」在单测里可推进，
   *    业务语义（多久算新鲜）由 `model-catalog.ts` 的 `isCatalogFresh` **唯一**持有，
   *    本家不得自己写第二份判据。
   */
  now?: () => number
  /** 目录可用后回调 —— 接线层注入 `broadcastCatalogChanged(ctx)`。 */
  onCatalogLoaded?: () => void
}

/**
 * 该模型是否接受图片输入（**实测表**，依据见 `OFFICEACE_MODELS` 的 `multimodal` 注）。
 *
 * `/v2/models` 不返回能力元数据，只能逐个实测 —— 未入库的 id 保守按不支持。
 */
function isMultimodalModel(model: string): boolean {
  return OFFICEACE_MODELS.some((m) => m.id === model && (m as { multimodal?: boolean }).multimodal === true)
}

/**
 * 收集消息中的图片附件引用（含工具结果内层，任意深度），按 attachmentId 去重。
 *
 * ⚠️ **已改为复用共享实现**（Issue IKLSB8）。原先这里是一份与
 * `openai-compat.ts` 逐字同义的私有副本，看似无害，实际是缺陷的一半：
 * 收集侧递归进 `tool-result` 内层，而**注入侧不递归** ⇒ 深层图片被收进 refs、
 * 读出了字节、却在序列化阶段被静默丢弃（连 `[image unavailable]` 占位符都没有）。
 * 判据：**收集与注入必须同源同深度**，两份实现分处两文件时没有任何东西保证它们
 * 同步 —— 共享一份才让这类分叉不可能发生（同 `buddy-adapter.ts` 的注释所警告）。
 */

export class OfficeAceAdapter extends LlmAdapter {
  /** 目录是否已广播过（只广播一次）。 */
  private announced = false
  /** 倍率缓存（listModels 时填充，resolveModel 复用——保持两处名字一致）。 */
  private rateCache = new Map<string, number>()
  /**
   * 上次**成功**刷新目录的时刻（毫秒）；`0` = 从未成功读过。
   *
   * ⚠️ 它同时覆盖**两个独立端点**：`/v2/models` 探测与 `/v1/model-token-rates`
   *    倍率。二者任一单独缓存都会让另一半每轮照旧打上游（倍率尤其致命 ——
   *    用户原话就是「不更新就拿不到实际倍率」），故**共用同一个时刻**。
   *
   * ⚠️ 判据只有一份：`model-catalog.ts` 的 `isCatalogFresh`（周期 20 分钟）。
   */
  private catalogAt = 0

  /**
   * 共享目录骨架（`model-catalog.ts`）——**黑名单 / 关闭意图 / 目录门控 /
   * 映射**的唯一实现处（2026-10-23 迁移，见 `listModels` 的注释）。
   */
  private readonly skeletonCatalog: ModelCatalog

  constructor(private readonly options: OfficeAceAdapterOptions = {}) {
    super()
    // ⚠️⚠️ **`accountPool` 必须是真池**：骨架里 `deps.accountPool?.disabledModelsFor`
    //    与 `providerClosedFor?.(...)` 全靠它；传 `{}` 或 `undefined` 会让
    //    `?.` 变成静默 no-op（Gitee IKP8OF 实测过的形态）。
    this.skeletonCatalog = createModelCatalog(
      this.options.accountPool === undefined ? {} : { accountPool: this.options.accountPool },
      {
        product: OFFICEACE,
        loadCatalog: () => this.loadCatalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
        // ⚠️ 未知 id **保守报 `['text']`**：与本家 `resolveModel` 的取向一致
        //    （6 个纯文本模型不声明 image、也不给未知 id 编造能力）。
        unknownModelInputModalities: () => ['text'] as const,
      },
    )
  }

  /**
   * 取当前可用凭据；STS 临期（10 分钟内）先静默刷新。
   *
   * ⚠️ 刷新失败（refresh_token 已消费）返回旧凭据 —— 推理可能仍可用
   *（MaaS Basic 凭据与 STS 生命周期不同步）；真正失效由 stream 的 401 报错兜底。
   */
  /**
   * @param sessionId 当前会话 id（**可选**；来自 `GenerateOptions.sessionId`）。
   *   ⚠️ 只用于**子代理起点分配**，不参与凭据解析本身。
   */
  private async resolveCredential(sessionId?: string): Promise<OfficeAceCredential | undefined> {
    if (this.options.credentialProvider) return this.options.credentialProvider(sessionId)
    let credential = await readOfficeAceCredential()
    if (credential !== undefined && isExpiring(credential)) {
      credential = (await refreshStoredCredential().catch(() => undefined)) ?? credential
    }
    return credential
  }

  /**
   * 目录专用凭据：**锁定永久积分也必须能读目录**（见 `probeCredential` 的注释）。
   *
   * ⚠️ 未注入 `probeCredential` 时回落 `resolveCredential()`：既有嵌入方与单测
   *    的行为逐字不变（只有宿主装配层会注入它）。
   */
  private async probeCredential(): Promise<OfficeAceCredential | undefined> {
    return this.options.probeCredential !== undefined
      ? this.options.probeCredential()
      : this.resolveCredential()
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : OFFICEACE.id
    return { id, name: OFFICEACE.displayName }
  }

  /** ⚠️ 必须同步（Jet Hub `ModelCatalogSource` 不 await，同 minimax 教训）。 */
  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[] {
    return OFFICEACE_MODELS.map((m) => ({ id: m.id, name: m.name }))
  }

  /**
   * 目录：凭据可读 + `/v2/models` 可达才暴露（隐藏不可恢复的分组，
   * 与 AutoClaw 同一约定：空目录 = 隐藏，而不是报错）。
   */
  /**
   * 模型选择器的目录 —— **委托共享骨架**（`model-catalog.ts`）。
   *
   * ## ⚠️⚠️ 2026-10-23 迁移（用户要求：实体 provider 一律走共享骨架）
   *
   * 迁移前本方法**手写**了四件事：判 `providerClosed`、过滤 `disabledModels`、
   * 凭据探测门控、手工 map 成 `LlmModelInfo`。其中「关闭意图 / 黑名单 /
   * `provider` 回填」与其余 13 家**逐字同义** ⇒ 各写一份正是 Gitee IKP8OF
   * 那类漂移缺陷的温床。
   *
   * 现在那三条由骨架承担，**本家独有的三条**放进 `loadCatalog`
   * （`loadCatalogEntries`）：
   * - 只读探测凭据门控（`probeCredential()` 抛不出「锁定」错）；
   * - **20 分钟 TTL**（`isCatalogFreshFor`，判据仍只有 `model-catalog.ts` 一份）；
   * - 倍率（`/v1/model-token-rates`）拼进展示名。
   *
   * ⚠️ **门控口径变更（刻意，已与用户确认）**：骨架额外要求「账号池里有已登录
   * 账号」（`providerCatalogVisible`）。对本家而言这更贴近用户预期 —— 池里
   * 没有账号时那个 provider 本就没有可用号。
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return await this.skeletonCatalog.listModels(_provider)
  }

  /**
   * 异步读目录并转成骨架的中间结构。
   *
   * ⚠️⚠️ **本家独有逻辑全在这里**（迁移前它们在 `listModels` 里）：
   * ① 只读探测凭据门控；② 20 分钟 TTL + 探测；③ 倍率取数。
   */
  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    // ⚠️ 目录用**只读探测凭据**（见 `probeCredential` 的长注释）：恒不抛「锁定」错。
    //    `/v2/models` 与倍率都是只读端点，不扣积分，锁定它们只会得到一串
    //    与锁定毫不相干的症状（面板「读取模型列表失败」、关不掉供应商、分组消失）。
    const credential = await this.probeCredential()
    if (credential === undefined) return []
    // ⚠️⚠️ **20 分钟 TTL（本家是 23 家里唯一手写目录、此前每轮真打上游的一家）**：
    //    `/v2/models` 探测与 `/v1/model-token-rates` 倍率**各是一次真实往返**
    //    （实测日志稳定 80~340ms，其余 22 家是 1~17ms 的纯本地读）。
    //
    // ⚠️ **判据只有一份**：`isCatalogFresh`（`model-catalog.ts`，周期 20 分钟）。
    //    本家不得自己写第二份「多久算新鲜」。
    // ⚠️ 这里用 `isCatalogFreshFor`（多一个**正交**的「用户主动失效」输入）：
    //    用户在 Jet Hub 改开关后要**立即**重拉目录（规格 §6 的正确性要求，
    //    见 `invalidateCatalogCache`）。本家**不需要**「拉失败时别用失效判据」
    //    那一条：它下面失败分支走的是 `this.catalogAt === 0` 而不是新鲜度判据
    //    ⇒ 旧读数照常保留，不会退化。
    // ⚠️ **两个端点共用这一个时刻**：单独缓存其一时，另一处仍每轮打上游 ——
    //    而倍率恰恰是用户要求「20 分钟更新一次」的那一半（不更新就拿不到实际倍率）。
    //
    // ⚠️ **凭据仍每轮现取**：本地读凭据不花钱，而「换了账号/换了 `maasBaseUrl`」
    //    只有在每次探测时才知道 —— 缓存住凭据会让新账号的目录迟迟不生效。
    const catalogFresh = isCatalogFreshFor(OFFICEACE.id, this.catalogAt, this.options.now?.() ?? Date.now())
    if (!catalogFresh) {
      let probed = false
      try {
        probed = await this.probe(credential)
      } catch {
        probed = false
      }
      // ⚠️⚠️ **刷新失败必须保留旧读数、清空是错的**：空列表会让 DSH 的
      //    `buildModelCatalog` **隐藏整个分组**（用户界面上一个模型都不剩，
      //    且无日志）—— 而故障只是一次瞬时抖动。
      //    `catalogAt` 也**不刷新**：刷新了就得再等满 20 分钟才会重试。
      //
      // ⚠️ **冷启动例外**：从未成功读过（`catalogAt === 0`）时没有「旧值」可留，
      //    仍然诚实地返回 `[]` —— 这正是「凭据不可达 ⇒ 隐藏不可恢复的分组」
      //    那条既有约定（锁定态 / 未登录的既有行为逐字不变）。
      if (!probed) {
        if (this.catalogAt === 0) return []
      } else {
        this.announceLater()
        // 倍率（costCoefficient）：OfficeAce 主界面显示 `0.7x` 的那个值，来自
        // `/v1/model-token-rates`（V11 签名，管理面 API —— 保持默认域，
        // 见 `officeace-base-url.spec.ts` 的范围守卫）。取不到（未装 OfficeAce）时
        // 优雅降级 —— 名字后不带 x 系数，模型照常可选。
        const rates = await fetchModelTokenRates()
        this.rateCache = rates
        // ⚠️ **只在成功走到这里才记时刻**：失败不写（见上面的注释）。
        this.catalogAt = this.options.now?.() ?? Date.now()

      }
    }
    return OFFICEACE_MODELS.map((m) => this.toCatalogEntry(m))
  }

  /** **同步**全量目录（`listAllModels()` 用；同样带缓存倍率）。 */
  private syncCatalogEntries(): readonly CatalogEntry[] {
    return OFFICEACE_MODELS.map((m) => this.toCatalogEntry(m))
  }

  /**
   * 本家私有形状 → 骨架的 `CatalogEntry`（**唯一**转换点）。
   *
   * ⚠️ 倍率拼进 `name` 是**本家既有口径**（`resolveModel` 也这么做，两处必须
   * 同源，否则选择器显示 `GLM-5.2 · x0.7`、选中后底部胶囊只显示 `GLM-5.2`）。
   */
  private toCatalogEntry(m: (typeof OFFICEACE_MODELS)[number]): CatalogEntry {
    const coeff = this.rateCache.get(m.id)
    return {
      id: m.id,
      name: coeff !== undefined ? `${m.name} · x${coeff}` : m.name,
      // ⚠️ **图片准入闸门**（实测表见 `OFFICEACE_MODELS` 的 `multimodal` 注）：
      //    不声明 `image` 时附件在入库阶段就被拒（用户看到「当前模型不支持
      //    图片」）—— 这是对 6 个纯文本模型的**诚实**行为。
      inputModalities: isMultimodalModel(m.id) ? (['text', 'image'] as const) : (['text'] as const),
    }
  }

  private announceLater(): void {
    if (this.announced) return
    this.announced = true
    setTimeout(() => {
      try {
        this.options.onCatalogLoaded?.()
      } catch {
        // 广播失败不中断请求
      }
    }, 0)
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = OFFICEACE_MODELS.find((m) => m.id === model)
    // ⚠️ 倍率要与 listModels 同源（否则选择器显示 `GLM-5.2 · x0.7`、
    //    选中后底部胶囊却只显示 `GLM-5.2`——两处名字不一致）。缓存命中时同步取。
    const coeff = this.rateCache.get(model)
    const baseName = known?.name ?? model
    return {
      provider,
      id: model,
      name: coeff !== undefined ? `${baseName} · x${coeff}` : baseName,
      // 与 listModels 同源：准入闸门两处都要说真话（实测表见 OFFICEACE_MODELS）。
      inputModalities: isMultimodalModel(model) ? (['text', 'image'] as const) : (['text'] as const),
      // ⚠️ **未知 id 不编造 `context`**：目录外的模型我们不知道它的上下文窗口，
      //    拿一个猜测值（131072）会让自动压缩按错误阈值决策 —— 如实 `undefined`
      //    比编一个数诚实（`model-catalog-parity.spec.ts` 会红并点名这种编造）。
      ...(known === undefined ? {} : { context: { contextWindow: known.contextWindow } }),
    }
  }

  /** 探测：模型端点 200 且 JSON（凭据有效即通过）。 */
  private async probe(credential: OfficeAceCredential): Promise<boolean> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8_000)
    try {
      const f = this.options.fetchImpl ?? fetch
      const r = await f(`${maasBaseUrlOf(credential)}${OFFICEACE.modelsPath}`, {
        headers: { Authorization: basicAuthorization(credential) },
        signal: ctrl.signal,
      })
      const ct = r.headers.get('content-type') ?? ''
      return r.ok && ct.includes('application/json')
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /** ⚠️ 单参数 `stream(options)`（`LlmAdapter` 基类契约）。 */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const model = options.model
    /**
     * ★ **把会话 id 传下去**（2026-11-25）：子代理起点分配要用它。
     *
     * ⚠️ `GenerateOptions.sessionId` 是基类已有的字段（codearts / budddy 等
     *    都用它做「轮换起点」）—— 本家此前**只用来查起点、没用它做子代理分配**。
     * `undefined` 时（网关流量 / 单测）行为逐字节不变。
     */
    const credential = await this.resolveCredential(options.sessionId)
    if (credential === undefined) {
      throw new Error(
        '未找到 OfficeAce 凭据：请启动 OfficeAce 并登录华为云账号（凭据缓存于本机 Redis），'
        + '或确认 Redis 6399 与 Windows 凭据管理器条目可读',
      )
    }
    const f = this.options.fetchImpl ?? fetch

    // ── 熔断快速失败（Gitee issue IKLTHB 第 ③ 条）──
    //
    // ⚠️ **为什么要在这里拦，而不只是靠聚合折算剔除**：
    //
    // 折算层（`officeaceExpiry`）把熔断中的凭据判成 `UNUSABLE`，于是**自动路由**
    // 不会再选它；但用户**显式**选中 officeace 的模型、或聚合在别处兜底时，
    // 请求仍会落到这里 —— 那时再发一个已经知道结果的请求，白白等一个网络往返，
    // 还会把「暂时不可用」表现成一个像服务端错误的 401。
    //
    // ⚠️ 快速失败**不会**让熔断永不解除：`until` 到期即自动放行（半开），
    //    届时这次真请求就是探针。文案里带上剩余时间，用户不必猜「为什么立刻失败」。
    const breaker = officeaceBreakerState(credential)
    if (breaker.open) {
      const minutes = Math.max(1, Math.ceil(breaker.remainingMs / 60000))
      throw new Error(
        `OfficeAce：该账号的 Basic 凭据已被华为 MaaS 连续拒绝 ${breaker.consecutive} 次`
        + `（最近一次：${breaker.lastReason.slice(0, 120)}），`
        + `已临时跳过本渠道，约 ${minutes} 分钟后自动重试。`
        + '⚠️ 这与额度无关，**不要**去解锁永久积分；重新登录也改变不了'
        + '（云侧下发的 `modelAppKey`/`modelAppSecret` 不会变）。',
      )
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort)

    // ⚠️ **max_tokens 下限保护**（2026-10-12 实测定位「渠道老是停」）：
    //    OfficeAce 全系模型带思考链，且思考 token 计入 max_tokens 预算。
    //    实测 deepseek-v4.1-flash：max_tokens=32 → reasoning_tokens=32、
    //    content 0 字、finish_reason=length；512 同样 0 字；不限 → 2s 完整回复。
    //    即：小预算会被思考链**全部烧光**，正文一个字都不剩 —— 外部表现就是
    //    「回复是空的 / 渠道停了」。故低于下限的预算直接**丢弃**（交给端点默认
    //    上限兜底），只有够大的预算才透传。下限取 4096：留足思考 + 正文余量。
    const MAX_TOKENS_FLOOR = 4096
    const maxTokens = options.maxTokens !== undefined && options.maxTokens >= MAX_TOKENS_FLOOR
      ? options.maxTokens
      : undefined

    // ── 图片输入（多模态）──
    // 收集 → 闸门 → 读字节 → 注入序列化结果。四步各自可失败，逐一说明：
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      const content = Array.isArray(message.content) ? message.content : []
      collectImages(content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!isMultimodalModel(model)) {
        // ⚠️ 双保险：DSH 的准入闸门（inputModalities）已在附件阶段拦住大多数，
        //    但目录缓存过期 / 模型 id 未入库时仍可能漏到这里 —— 上游会对纯文本
        //    模型回 400 并报废整轮对话，早失败 + 文案明确更好。
        throw new Error(
          `OfficeAce: 模型 "${model}" 不支持图片输入。`
          + `已实测支持：DeepSeek-V4.1-Flash、Kimi-K2.6（见 OFFICEACE_MODELS 的 multimodal 注）`,
        )
      }
      if (this.options.readImage === undefined) {
        throw new Error(
          'OfficeAce: 图片输入需要附件服务桥接（readImage）；'
          + '请确认当前 profile 已装载 @deepseek-ai/dsh-attachment-local',
        )
      }
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // ⚠️⚠️ **`imageUrls` 必须交给共享 `serializeMessages`**（Issue IKLSB8，
    // 2026-10-14 真机报障）。此前这里**只传了 1 个实参**，而共享实现的第二参
    // 是图片字节映射；缺了它有两道后果**同时**发生：
    //
    // 1. 工具结果内层的图片（= **Claude Code / Claude Desktop 唯一的图片形状**，
    //    即 `tool_result.content=[{type:'image'}]`）没有任何一条腿去读它 ——
    //    共享实现里 `imageUrls === undefined` 那一段整节跳过 ⇒ 图片字节
    //    **根本没进请求**（实测 `input_tokens` ≈76 vs 带图 ≈245，是字节缺失
    //    而不是上游拒绝）；
    // 2. 图片型工具结果被 `contentToText` 压成空串 ⇒ 落到 `'(no output)'` 兜底
    //    ⇒ 模型被告知「工具没有任何输出」，于是答「Read 没有返回内容」，
    //    用户据此误判成模型没有视觉能力（真实原因是「有输出，输出是图」）。
    //
    // ⚠️ 旧实现在此之后有一段**补偿性注图循环**（按 `role==='user'` 出现顺序
    // 一一对应，把图补成 parts）。它有两个独立缺陷，故**整段删除**、不再保留：
    //
    // - **够不到内层**：只遍历 user 消息 content 的**顶层**，而 `collectImages`
    //   是递归的 ⇒ 收进了 refs、读出了字节、注入时却丢掉（连 `[image unavailable]`
    //   都没有）。这正是 `buddy-adapter.ts` 注释里警告过的形态。
    // - **索引错位**：`wireMessages` 与 `options.messages` 的 user **数量并不相等**
    //   —— 工具结果会被展开成 `role:'tool'`，而「只含工具结果」的 user 消息
    //   在源里占一个位置、在 wire 上却不是 user。实测（真实 Claude Code 形态：
    //   user(看图) → assistant(tool_call) → user(仅工具结果) → user(图+提问)）
    //   注图循环把**图注到了前一条文本消息上**，带图那条反而没有图。
    //
    // ⇒ 不再自己维护第二套「D+/注入」实现：共享实现已与 `collectImages` 同深度，
    // 且遵守 `0dd27ca` 的阶段结论（图片必须与提问**同一条** user 消息，图在前）。
    const wireMessages = serializeMessages(options.messages, imageUrls)

    // ── 工具定义下发 ──
    //
    // ⚠️ **这是「工具调用被当正文、模型停住不动」的真正根因**（2026-10-13）。
    //    本适配器**原本既不发 `tools` 字段、也不注入 DSML 提示**，模型在零
    //    协议指引下凭训练印象臆造出 `<｜DSML｜ calls>` —— 而解析器只认
    //    `<｜DSML｜tool_calls>`（见 dsml.ts）。标记写得再「规范」也解析不了，
    //    因为**协议名本身就是错的**。归一化修不了这个，必须先下发正确语法。
    //
    // 走 DSML 注入（而非标准 `tools` 字段）的理由与 codearts 一致：
    // 该通道同样经网关，标准 tool_calls 的参数一次性打包会触发 ~60s 空闲
    // 断连；DSML 经 `delta.content` 流式输出，全程有数据流。
    const wireTools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }) satisfies DsmlToolSpec)
    let toolsPayload = wireTools
    /**
     * 是否走 DSML 模式。**必须与 `consumeOpenAiSse` 的 `dsmlToolMode` 成对**：
     * 注入提示让模型写 DSML，消费器就必须解析 DSML —— 缺任一半，工具调用
     * 都会变成「整段标签当正文、工具永不执行」。
     *
     * ⚠️ **OfficeAce 默认关闭**（2026-10-13 三次事故后决定）。
     *
     *    DSML 的本意是绕开网关 ~60s 空闲超时（标准 `tool_calls` 要求参数
     *    一次性打包，生成期间 SSE 无数据流会被掐断）。但实测
     *    `deepseek-v4.1-flash` 经本渠道**无法稳定遵循文本协议**：
     *
     *    - 三轮迭代（注入提示 → 大小写判定 → `calls` 别名兼容）全部到位后，
     *      模型仍在同一轮里混写 `<｜DSML｜tool_calls>` 与 `<｜DSML｜ calls>`；
     *    - 更常见的是**压根不发工具调用**，只输出「我这就去查：」然后结束
     *      —— 用户视角就是「Agent 不干活」。
     *
     *    根因是 DSML 把工具协议从「框架保证的结构化字段」降级成「模型自觉
     *    遵守的文本约定」，而该模型不可靠。两害相权：**标准 `tools` 字段下
     *    工具必定可用**，超时风险留给需要它的场景自行权衡。
     *
     *    确需开启（例如实测本渠道不再触发 60s 断连）时，设环境变量
     *    `OFFICEACE_DSML=1` 后重启 dsh。
     *
     * ⚠️ **本开关同时驱动「教」与「解」两半**（注入提示 + 传给
     * `consumeOpenAiSse` 的解析开关），**不得只改一处** —— 单边存在时
     * 模型写的 DSML 无人解析，工具调用会整段当正文显示。
     */
    let dsmlMode = false
    if (process.env.OFFICEACE_DSML === '1'
        && wireTools !== undefined && wireTools.length > 0
        && needsDsmlToolMode(model, wireTools.map((tool) => tool.function.name))) {
      dsmlMode = true
      // 注入位置：system 之后、user 之前（实测放末尾会让思考泄漏进正文，
      // 见 dsml.ts 注释）。
      wireMessages.splice(
        wireMessages.findIndex((m) => m.role === 'system') + 1,
        0,
        { role: 'system', content: buildDsmlSystemPrompt(wireTools) },
      )
      toolsPayload = undefined
    }

    const payload = JSON.stringify({
      model,
      messages: wireMessages,
      stream: true,
      ...toolsPayload !== undefined && toolsPayload.length > 0 ? { tools: toolsPayload } : {},
      ...maxTokens === undefined ? {} : { max_tokens: maxTokens },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
    })

    try {
      const response = await f(`${maasBaseUrlOf(credential)}${OFFICEACE.chatPath}`, {
        method: 'POST',
        headers: {
          Authorization: basicAuthorization(credential),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: payload,
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        // ── 401：先判断「续期一次再重发」这件事**有没有意义** ──
        //
        // ⚠️⚠️ 这是一个**真实缺陷**的现场（Gitee issue IKLTHB 第 ② 条，2026-10-14
        //    起 264+ 次连续失败）。改前的代码是：
        //
        //     ```ts
        //     await this.options.refresh().catch(() => undefined)
        //     const renewed = await this.resolveCredential()
        //     if (renewed !== undefined && renewed !== credential) { /* 重发 */ }
        //     ```
        //
        //    那句 `renewed !== credential` **恒为真**：`resolveCredential()` 每次都
        //    `JSON.parse` 出一份**新对象**，对象身份永远不同 ⇒ 这个守卫一个都拦不住，
        //    401 恒被重发一次。于是真实报障里的每一轮都是「白撞一次 + 重新登录一次」
        //    —— 而取证证明重新登录**换掉了账号与 credentialRef
        //    （`OFFICEACE_ACCOUNT_651558E5` → `F1557964`）、换掉了整条 STS 三元组，
        //    却让 `modelAppKey`/`modelAppSecret` 逐字节不变**（`ffff8ba7…c476` /
        //    `bd4da972…d76b`，`accountId` 也没变）⇒ 重发注定得到同一个 401。
        //
        // ⇒ 判据必须落在**能修好 401 的那几个字段**上（见 `basicAuthFingerprint`），
        //    而不是对象身份。这样「没变」这一事实本身就成了诊断依据：
        //    报文里会**明确写出**「已续期但凭据一个字节都没变」，
        //    用户不必再去重复一次无效的重新登录。
        let finalStatus = response.status
        let finalText = text
        // ⚠️ 续期闸门必须是**超集**：`401` **照旧一律**尝试续期（形状未知的网关 401
        //    也可能是凭据陈旧，旧行为能救回来的不能丢），**另外**把「4xx + 报文点名
        //    这对 Basic 凭据」也算进来 —— 华为文档把 APIG.1009 定义为 400、真机回
        //    401，只认 401 就会漏掉文档那一侧（第二轮对抗性审计查出的真实缺口：
        //    判据只认状态码，而它自己的注释写着「不得依赖状态码」）。
        const credentialRejected = isBasicCredentialRejection(response.status, text)
        /**
         * 产生**最终**那次拒绝的凭据。
         *
         * ⚠️ 续期真的换掉了 Basic 三元组时，下一轮请求用的会是**新**那份
         *    （续期已就地更新凭据库）⇒ 熔断记账必须落在**它**身上，否则熔断器
         *    永远追不上实际在用的凭据，每轮仍白撞一次（正是 issue 第 ③ 条）。
         */
        let rejected: OfficeAceCredential = credential
        // ⚠️ **四态**，不是布尔：`renewed === undefined`（续期后读不到凭据）与
        //    「读到了但一个字节没变」是**两件不同的事**，文案必须分开说 ——
        //    用布尔会把前者说成后者（或反之），而这两种指引指向完全不同的动作。
        let renewal: RenewalOutcome = 'not-attempted'
        if ((response.status === 401 || credentialRejected) && this.options.refresh !== undefined) {
          const before = basicAuthFingerprint(credential)
          await this.options.refresh().catch(() => undefined)
          const renewed = await this.resolveCredential(options.sessionId)
          if (renewed === undefined) {
            renewal = 'unreadable'
          } else if (basicAuthFingerprint(renewed) !== before) {
            renewal = 'changed'
            rejected = renewed
            const retry = await f(`${maasBaseUrlOf(renewed)}${OFFICEACE.chatPath}`, {
              method: 'POST',
              headers: {
                Authorization: basicAuthorization(renewed),
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
              },
              body: payload,
              signal: controller.signal,
            })
            if (retry.ok) {
              // 续期真的换掉了 Basic 三元组且重发通了 ⇒ 成功，顺带解除熔断记录。
              noteOfficeaceSuccess(renewed)
              yield* consumeOpenAiSse(
                retry,
                { signal: controller.signal },
                {
                  label: OFFICEACE.id,
                  firstTokenTimeoutMs: OFFICEACE.headerTimeoutMs,
                  chunkTimeoutMs: OFFICEACE.chunkTimeoutMs,
                  ...maxTokens === undefined ? {} : { maxTokens },
                  ...dsmlMode ? { dsmlToolMode: true } : {},
                },
              )
              return
            }
            finalStatus = retry.status
            finalText = await retry.text().catch(() => '')
          } else {
            renewal = 'unchanged'
          }
        }
        // ── 熔断记账：**只认确定的凭据拒绝形状**（见 `isBasicCredentialRejection`）──
        //
        // ⚠️ 不能「凡 401 都记」：网关/代理层的 401（HTML / 空体）形状未知，
        //    据此熔断等于把一次基础设施抖动放大成「渠道消失 10 分钟」。
        if (isBasicCredentialRejection(finalStatus, finalText)) {
          noteOfficeaceRejection(rejected, finalText)
        }
        throw new Error(
          `OfficeAce (华为MaaS) 返回 HTTP ${finalStatus}：${finalText.slice(0, 200)}`
          + `（${this.diagnose(finalStatus, finalText, renewal)}）`,
        )
      }

      // ⚠️ 成功即解除熔断（**唯一**的正常出口）：这证明这对 Basic 凭据是好的。
      noteOfficeaceSuccess(credential)
      yield* consumeOpenAiSse(
        response,
        { signal: controller.signal },
        {
          label: OFFICEACE.id,
          firstTokenTimeoutMs: OFFICEACE.headerTimeoutMs,
          chunkTimeoutMs: OFFICEACE.chunkTimeoutMs,
          ...maxTokens === undefined ? {} : { maxTokens },
          ...dsmlMode ? { dsmlToolMode: true } : {},
        },
      )
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }

  /**
   * 把 HTTP 失败翻译成「用户下一步该做什么」。
   *
   * ## ⚠️ 401 那一格曾经**写死了被证伪的指引**（Gitee issue IKLTHB 第 ② 条）
   *
   * 改前的实现是一句无条件的断言：
   *
   * > `Basic 凭据失效：OfficeAce 会话已过期，请重新登录 OfficeAce 客户端`
   *
   * 那句在真实报障里**是错的**，而且**有反证**：用户按它去重新登录，
   * 结果 `modelAppKey`/`modelAppSecret` **逐字节不变**（取证见 `stream()` 里
   * `basicAuthFingerprint` 的注释）⇒ 重新登录在结构上就不可能修好这个 401，
   * 却被指引去做了一遍又一遍（264+ 次失败里有相当一部分是这么来的）。
   *
   * 现在改为**按报文与续期结果分派**：
   *
   * | 情形 | 文案指向 |
   * |---|---|
   * | 报文是 `APIG.1009` 且**续期没换掉 Basic 三元组** | 华为侧认定的 key 与本地不一致，**重新登录改变不了**；去华为云控制台/订阅处核对 |
   * | 报文是 `APIG.1009` 且**刚换过**凭据 | 新凭据也被拒 ⇒ 权限/订阅面 |
   * | 其它 401 形状 | 形状未知 ⇒ 如实说「不是已知的凭据失效形状」，提示核对 endpoint 与出口 |
   *
   * ⚠️ **分派必须先判形状、再判状态码**：`APIG.1009` 那几行的条件里**不得**出现
   *    `status === 401` —— 华为官方文档把它定义为 **400**、真机回 **401**，
   *    钉死 401 会让「文档那一侧」的报障彻底拿不到归因（第二轮审计实测缺口）。
   *    状态码只用于**兜底文案**（403 未订阅 / 404 / 429 / 5xx）。
   *
   * ⚠️ 与 `diagnose` 的调用方约定：本方法的返回值会被**拼进错误 message**，
   *    故错误本身**不得**带 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` 这类会被 DSH 客户端
   *    整段替换的码（`stream()` 抛的是**裸 `Error`**，无 `code`）。
   *
   * @param status - 终态 HTTP 状态（重发过的话是重发的那个）。
   * @param body - 终态响应正文。
   * @param refreshedUnchanged - 本次已续期，但 Basic 三元组**一个字节都没变**。
   */
  private diagnose(status: number, body = '', renewal: RenewalOutcome = 'not-attempted'): string {
    // ⚠️⚠️ 这里原先整个 APIG.1009 分支都嵌在 `if (status === 401)` **里面** ——
    //    所以只把 `isBasicCredentialRejection` 放宽到 4xx 是**不够的**：华为官方
    //    文档把 APIG.1009 定义为 **400**，按文档回 400 时这段归因**一个字都用不上**
    //    （第二轮对抗性审计查出的真实缺口；同一处「注释说不依赖状态码、代码却钉死
    //    401」的自相矛盾在两个文件里各有一份）。改为**先判形状、再判 401**。
    if (isBasicCredentialRejection(status, body)) {
      // ⚠️ 四态**各说各的**：把「续期后读不到凭据」说成「凭据没变」会让用户
      //    去华为云控制台查一个根本不存在的问题；反之会让他重复一次无效重登。
      if (renewal === 'unreadable') {
        return '华为 APIG.1009：MaaS 侧不认这对 AppKey/AppSecret。'
          + '本次已发起续期，但**续期后读不到新凭据**（凭据库/登录态异常）⇒ 请先确认'
          + '账号的凭据能正常读出（Jet Hub 的 OfficeAce 账号卡片），再判断是否需要重新登录。'
      }
      if (renewal === 'changed') {
        return '华为 APIG.1009：MaaS 侧不认这对 AppKey/AppSecret（本次凭据刚续期且已变化，'
          + '仍被拒）⇒ 更可能是该账号的 MaaS 应用凭据或模型订阅在华为云侧被撤销，'
          + '请在华为云控制台核对。'
      }
      if (renewal === 'unchanged') {
        return '华为 APIG.1009：MaaS 侧不认这对 AppKey/AppSecret。'
          + '本次**已经发起过续期**，但凭据里的 `modelAppKey`/`modelAppSecret`/推理网关'
          + '**一个都没变** —— 所以**重新登录 OfficeAce 改不了这个结果**'
          + '（重新登录只会换掉账号与 STS，Basic 这对 key 由云侧按账号下发）。'
          + '请到华为云控制台核对这个账号的 MaaS 应用凭据/模型订阅，或在 Jet Hub 里'
          + '删除该账号后用另一个华为云账号重新登录。'
      }
      return '华为 APIG.1009：MaaS 侧不认这对 AppKey/AppSecret。'
        + `本次**没有续期**（未接入续期，或 ${status} 不是续期重试路径）⇒ 可先在 Jet Hub 的`
        + 'OfficeAce 账号卡片点一次「刷新」看凭据是否会变；若不变，重新登录同样无效'
        + '（Basic 这对 key 由云侧按账号下发）。'
    }
    if (status === 401) {
      return 'HTTP 401，但报文不是已知的「AppKey/AppSecret 无效」形状 —— '
        + '可能是网关/代理层的鉴权或登录态问题：请核对凭据里的推理网关地址（`maasBaseUrl`）'
        + '与网络出口，而不是直接重新登录。'
    }
    if (status === 403) return '该账号未订阅此模型（ModelArts.81004）：请在 OfficeAce 或华为云控制台订阅'
    if (status === 404) return '模型不存在：检查模型 id 是否在目录中'
    if (status === 429) return '限流：稍后重试'
    if (status >= 500) return '华为云服务端错误：稍后重试'
    return '请确认 OfficeAce 已登录且账号有可用额度'
  }
}

/** 在 `ctx.llm` 上注册 OfficeAce provider 路由（幂等，返回**原始适配器实例**）。 */
export function registerOfficeAceLlm(
  ctx: Context,
  options: OfficeAceAdapterOptions = {},
): OfficeAceAdapter {
  const adapter = new OfficeAceAdapter(options)
  // ⚠️ **返回 `adapter` 而不是 `registerAdapterIdempotent` 的返回值**：
  //    后者的语义是「`registerAdapter` 的结果」—— 重复注册时它返回 `undefined`，
  //    非重复时返回宿主给的句柄（**不是**适配器实例）。接线层要把它放进
  //    `modelAdapters` 供 `provider.status` 调 `listAllModels()`，拿到句柄会
  //    报 `listAllModels is not a function`（实测症状，2026-10-12）。
  //    与 `registerGeminiLlm` / `registerZcodeLlm` 同款（它们也返回原始实例）。
  registerAdapterIdempotent(
    ctx.llm,
    [OFFICEACE.id],
    adapter,
    (message: string) => ctx.logger?.warn?.(message),
  )
  return adapter
}
