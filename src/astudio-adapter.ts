/**
 * AStudio（讯飞 AstronStudio）模型适配器 —— dsh-llm `LlmAdapter` 的**推理面**实现。
 *
 * ## 本文件只干三件事（协议判据一律来自 `astudio.ts`，不在此重复）
 *
 * 1. **发请求**：`POST {maasBaseUrl}{chatPath}`
 *    （实测 = `https://maas-api.cn-huabei-1.xf-yun.com/v1/chat/completions`）。
 *    请求体**一律**交给 {@link buildAstudioChatRequest}，本文件绝不自己拼 body ——
 *    那函数已把三条实测取舍固化在纯函数层（裸 slug、空值省键、`stream_options.include_usage`），
 *    在这里再拼一遍就是第二处实现，必然漂移。
 * 2. **解析流**：复用仓库共享件 {@link consumeOpenAiSse}（`reasoning_content` 独立成块、
 *    `tool_calls` 按 index 合并、`finish_reason` 映射、**HTTP 200 + SSE 内嵌错误帧**归为
 *    `LlmError`）。本家实测是**标准 OpenAI 增量**，故不需要「累积全文→增量 diff」；
 *    但仍套一层 {@link astudioWrapIncremental} 作**防御**（幂等透传，上游哪天改形态不至于把
 *    正文拼成三份）。
 * 3. **凭据**：全部经 `astudio-auth.ts` 注入（磁盘快路径 + 401 触发的权威重取）。
 *    本文件**不读磁盘、不拼 Cookie、不自己发凭据请求**。
 *
 * ## 401 的唯一处理路径（硬约束：只重取一次，禁止循环重试）
 *
 * 判据入口只有 {@link astudioAuthRetryPlan}：`401 → refresh-and-retry → 再 401 → terminal`。
 * ⚠️ 磁盘上没有任何 TTL/expiresAt，本地**无法**预判到期，所以「先检查再请求」这种写法
 * 在本家不存在；反过来说，**传输层失败绝不能被读成 401**（{@link astudioStatusOf} 无状态时
 * 故意返回 `0`，就是为了不让你在断网时白撞一次远端重取）。
 *
 * ## 错误码（与 harness 名单对齐后的定案）
 *
 * `astudio.ts` 的分类器产出 `RATE_LIMITED` / `NETWORK`，而 dsh-llm 的
 * `DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`
 * 用的是 **`RATE_LIMIT` / `TRANSPORT`** —— 照抄分类器字面量会让一次 429 与一次断流
 * **都不被重试**（静默少一层恢复能力）。{@link astudioLlmErrorCode} 就是这唯一一次改名，
 * 其余码值保持原样：`QUOTA_EXCEEDED` / `PERMISSION_DENIED` 都在
 * `dead-model-store.ts` 的 `IGNORED_CODES` 里（不会被误记成「模型已下架」），不必动。
 *
 * ## 思考档位（实测：非法值**不报错**、按最大档跑）
 *
 * ⇒ 必须由 {@link astudioEffortForRequest} 在**本地**拦截，被判丢弃时**发出去的是
 * 「不带该键」**，并留一条 warn（静默丢弃是本仓库明令禁止的）。档位声明只取远端下发的
 * `supported_reasoning_levels`，未知模型不臆造。
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  createModelCatalog,
  isCatalogFresh,
  isCatalogFreshFor,
  type CatalogEntry,
  type ModelCatalog,
} from './model-catalog.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import {
  consumeOpenAiSse,
  errorDetail,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'
import { ASTUDIO, type AstudioFallbackModel, type AstudioProduct } from './astudio-product.js'
import {
  astudioBareSlugOf,
  astudioCatalogReasoningOf,
  astudioCatalogToFallback,
  astudioChatHeaders,
  astudioAuthRetryPlan,
  astudioEffortForRequest,
  astudioReasoningOf,
  astudioStreamErrorCode,
  astudioStreamErrorMessage,
  astudioVisibleModels,
  astudioWrapIncremental,
  buildAstudioChatRequest,
  classifyAstudioError,
  type AstudioCatalogModel,
  type AstudioCredential,
} from './astudio.js'
import {
  AstudioRefreshTokenExpiredError,
  isAstudioTerminalRefreshError,
  type AstudioAuth,
  type AstudioRefreshOutcome,
} from './astudio-auth.js'

/** 本适配器拥有的 provider 路由名（= `ASTUDIO.id`，纯小写无连字符）。 */
export const PROVIDER = 'astudio'

/** 远端目录拉取的失败冷却（毫秒）：失败后这段时间内不再撞第二次。 */
const REMOTE_CATALOG_COOLDOWN_MS = 60_000

/**
 * 分类器错误码 → harness 错误码的**唯一**一处改名（见模块头「错误码」一节）。
 *
 * 只登记**与两份名单实测冲突**的两个键；其余原样透传，避免把「看着更规范」的
 * 拼写改动一起塞进来（那会同时改掉重试语义，且没有实测依据）。
 */
const ASTUDIO_LLM_CODE_RENAMES: Readonly<Record<string, string>> = Object.freeze({
  RATE_LIMITED: 'RATE_LIMIT',
  NETWORK: 'TRANSPORT',
})

/** {@link ASTUDIO_LLM_CODE_RENAMES} 的取值入口（导出供单测逐格断言）。 */
export function astudioLlmErrorCode(kind: string): string {
  return ASTUDIO_LLM_CODE_RENAMES[kind] ?? kind
}

/** 空闲超时（毫秒）。⚠️ 默认取 `product.chunkTimeoutMs`，**必须 ≥300s**（fact 378）。 */
function firstTokenTimeoutMs(product: AstudioProduct): number {
  const raw = Number(process.env.DSH_ASTUDIO_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : Math.max(product.chatHeaderTimeoutMs, 60_000)
}

/** chunk 间隔超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function chunkTimeoutMsFor(product: AstudioProduct): number {
  const raw = Number(process.env.DSH_ASTUDIO_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : product.chunkTimeoutMs
}

/** {@link AstudioAdapter} 的构造选项（**单测与接线都靠这几个替身注入**，不碰真实凭据/网络）。 */
export interface AstudioAdapterOptions {
  /** 产品配置；缺省 {@link ASTUDIO}。 */
  product?: AstudioProduct
  /** 注入的 fetch；缺省全局 `fetch`。 */
  fetchImpl?: typeof fetch
  /**
   * 认证服务（`ctx.astudioAuth`）。注入后三个回调都有默认实现；
   * 单测可以完全不传它，改用下面三个显式回调。
   */
  auth?: AstudioAuth
  /** 取当前凭据；缺省 `auth.currentCredential()`。 */
  resolveCredential?: () => Promise<AstudioCredential | undefined>
  /** 401 后的**一次**权威重取；缺省 `auth.refreshOnce()`。 */
  refresh?: () => Promise<AstudioRefreshOutcome | undefined>
  /** 读远端模型目录；缺省 `auth.fetchCatalogModels()`（GET model-manager/models）。 */
  fetchRemoteModels?: () => Promise<readonly AstudioCatalogModel[]>
  /** 目录落地后通知客户端重读（`registerAstudioLlm` 注入唯一广播实现）。 */
  onCatalogLoaded?: () => void
  /** 告警出口；缺省 `console.warn`。**丢弃档位等副作用必须留痕**。 */
  warn?: (message: string) => void
  /**
   * 目录新鲜度用的时钟（**只**用于 `isCatalogFresh`，不参与任何业务判定）。
   *
   * ⚠️ 判据只有一份：`model-catalog.ts` 的 `isCatalogFresh`（周期 20 分钟）。
   *    注入点存在的唯一理由是**单测要能推进 TTL**，不必真等 20 分钟
   *    （与 loomy / minimax / raccoon / zcode 的 `now` 同款约定）。
   */
  now?: () => number
  /**
   * 账号池（**黑名单过滤与「供应商整体关闭」的唯一数据源**）。
   *
   * ⚠️⚠️ **本字段曾经缺失，是一个静默缺陷**（Gitee issue IKP8OF 审计发现）：
   * 本家是唯一把 `createModelCatalog` 的 deps 传成 `{}` 的适配器（其余各家都传
   * `{ accountPool }`）⇒ 骨架里 `deps.accountPool?.disabledModelsFor(...)` 与
   * `providerClosedFor?.(...)` 全部因 `?.` **静默跳过** ⇒
   * **用户在 Jet Hub 里关掉的模型照样出现在选择器里**、关闭整个供应商也无效。
   * 症状与 modelscope 那次「接线层漏实参」逐字相同：字段与消费点都在，只缺实参。
   *
   * ⚠️ 省略时（单测 / 嵌入方）行为退回「不过滤」，与修复前逐字节一致 ——
   *    但**生产接线必须传**（由 `index.ts` 负责，且有守卫用例逐家点名）。
   */
  accountPool?: import('./account-pool.js').AccountPool
}

/** AStudio 适配器：Chat Completions 通道（实测上游原生兼容 OpenAI）。 */
export class AstudioAdapter extends LlmAdapter {
  private readonly product: AstudioProduct
  private readonly fetchImpl: typeof fetch
  private readonly warnImpl: (message: string) => void
  private readonly resolveCredentialImpl: () => Promise<AstudioCredential | undefined>
  private readonly refreshImpl: () => Promise<AstudioRefreshOutcome | undefined>
  private readonly fetchRemoteModelsImpl: (() => Promise<readonly AstudioCatalogModel[]>) | undefined

  /** 远端目录（**已按可见性过滤**）；未拉取/拉取失败时为 undefined ⇒ 用兜底表。 */
  private remoteModels: readonly AstudioFallbackModel[] | undefined
  /** 在途目录请求（并发去重：多个入口同时 `listModels` 只发一次）。 */
  private catalogInFlight: Promise<readonly AstudioFallbackModel[]> | undefined
  /** 失败冷却截止时刻（与目录 TTL **同一份**可注入时钟，见 {@link AstudioAdapterOptions.now}）。 */
  private catalogCooldownUntil = 0
  /**
   * 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
   *
   * ⚠️ **只在成功时写**：失败写时刻会把「上游没恢复」这件事掩盖整整 20 分钟。
   *    判据由 `model-catalog.ts` 的 `isCatalogFresh` **唯一**持有。
   */
  private catalogAt = 0
  /** 目录新鲜度用的时钟（可注入，见 {@link AstudioAdapterOptions.now}）。 */
  private readonly nowImpl: () => number

  private readonly catalog: ModelCatalog

  constructor(private readonly options: AstudioAdapterOptions = {}) {
    super()
    this.product = options.product ?? ASTUDIO
    this.fetchImpl = options.fetchImpl ?? fetch
    this.warnImpl = options.warn ?? ((message: string) => { console.warn(message) })
    this.nowImpl = options.now ?? (() => Date.now())
    this.resolveCredentialImpl = options.resolveCredential
      ?? ((): Promise<AstudioCredential | undefined> =>
        this.options.auth === undefined ? Promise.resolve(undefined) : this.options.auth.currentCredential())
    this.refreshImpl = options.refresh
      ?? (async (): Promise<AstudioRefreshOutcome | undefined> =>
        this.options.auth === undefined ? undefined : await this.options.auth.refreshOnce())
    this.fetchRemoteModelsImpl = options.fetchRemoteModels
      ?? (this.options.auth === undefined ? undefined : (): Promise<readonly AstudioCatalogModel[]> =>
        this.options.auth!.fetchCatalogModels())
    // ⚠️ 共享骨架：三态（远端/兜底/未知 id）与 `listAllModels()` 的同步契约都在
    // `model-catalog.ts`。`loadCatalog`/`syncCatalog` 两个回调**都必须给**，且
    // `syncCatalog` 不得在冷缓存时返回空数组（`jet-hub-rpc` 不 await 它）。
    this.catalog = createModelCatalog(
      // ⚠️⚠️ **必须传 `accountPool`**（Gitee issue IKP8OF 审计发现）：此前是 `{}`，
      //    而其余各家都传 `{ accountPool }` ⇒ 本家的黑名单过滤与「整体关闭」
      //    全部被 `?.` 静默跳过（关闭模型无效、关闭供应商无效）。
      this.options.accountPool === undefined ? {} : { accountPool: this.options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        // 实测六个模型的 `input_modalities` 全是 `['text']` ⇒ 未知 id 保守报 text。
        unknownModelInputModalities: () => ['text'] as const,
        syncCatalog: () => this.syncCatalogEntries(),
        /**
         * ★ **强制重拉**（供后台 20 分钟刷新器与「用户改设置」）。
         *
         * ⚠️ 与 `loadCatalog` 的差别：后者内部有 `isCatalogFresh` 判据 ⇒ 新鲜时**不拉**。
         *    本回调要的是「无视新鲜度，强制拉一次」，故先清时刻再走**同一份**拉取逻辑
         *    —— 不另写一份（那会让两条路的上游行为分叉）。
         *    ⚠️ 下面两条清腿**互为冗余**（任一条都足以让 gate 失效），
         *    实测数据见 `refreshCatalog` 注释里的变异表 —— 不要把任一条说成承重腿。
         */
        refresh: async () => {
          this.catalogAt = 0
          this.remoteModels = undefined
          await this.loadModels()
        },
      },
    )
  }

  // ── 目录 ──

  /** 描述本适配器拥有的 provider 路由（对非字符串入参回退本家 id，见 loomy 同款防御）。 */
  providerInfo(provider: string): LlmProviderInfo {
    return {
      id: typeof provider === 'string' && provider.length > 0 ? provider : this.product.id,
      name: this.product.displayName,
    }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return await this.catalog.listModels(_provider)
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return await this.catalog.resolveModel(provider, model, signal)
  }

  /** 同步全量目录（Jet Hub 显示列表用；`ctx.llm` 不透传自定义方法，故须持有实例）。 */
  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[] {
    return this.catalog.listAllModels()
  }

  /**
   * 兼容旧版 dsh-llm 的 `prepareCall` shim（PR !66 要求必须包）：
   * 解析出的 model 与本次 stream 属于**同一代**目录，重读动态连接事实没有意义。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (callOptions: GenerateOptions): AsyncIterable<StreamChunk> => this.stream(callOptions),
    }
  }

  /** 全部条目（远端 ?? 兜底表），**同一形状**（`astudioCatalogToFallback` 负责归一）。 */
  private catalogSource(): readonly AstudioFallbackModel[] {
    return this.remoteModels ?? this.product.fallbackModels
  }

  private toCatalogEntry(model: AstudioFallbackModel): CatalogEntry {
    const reasoning = this.reasoningFor(model)
    return {
      id: model.id,
      name: model.name,
      // 本家展示名**不含**倍率后缀 ⇒ `bareName` 与 `name` 同值（不是「忘了算」）。
      bareName: model.name,
      // ⚠️ 三态：本家远端总是下发 `input_modalities`，故 false 是**明确不支持**，
      // 不是「未知」；这里恒为数组。
      inputModalities: model.supportsImage === true ? ['text', 'image'] : ['text'],
      ...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
      ...model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {},
      ...reasoning !== undefined ? { reasoning } : {},
    }
  }

  /**
   * 思考档位声明（`resolveModel().reasoning`）。
   *
   * 三条口径：① 顺序**原样取远端**（服务端下发即展示顺序）；② `defaultEffort` 必须落在
   * `efforts` 内（DSH 会直接拿它发请求，给个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，
   * 比不给更糟）；③ 远端未声明档位 ⇒ **不声明** `reasoning`（否则 UI 出空选择器）。
   * 判据本身在 `astudio.ts` 的 {@link astudioCatalogReasoningOf}，这里只做**品牌转换**。
   */
  private reasoningFor(
    model: AstudioFallbackModel,
  ): LlmResolvedModelInfo['reasoning'] {
    const declared = astudioReasoningOf({ efforts: model.efforts, defaultEffort: model.defaultEffort })
    if (declared === undefined || declared.efforts.length === 0) return undefined
    return {
      efforts: declared.efforts.map((effort) => ({
        id: ReasoningEffortId(effort.id),
        name: effort.name,
      })),
      ...declared.defaultEffort !== undefined
        ? { defaultEffort: ReasoningEffortId(declared.defaultEffort) }
        : {},
    }
  }

  private syncCatalogEntries(): readonly CatalogEntry[] {
    return this.catalogSource().map((model) => this.toCatalogEntry(model))
  }

  /**
   * 读远端目录并转成中间结构（**并发去重 + 失败冷却**）。
   *
   * ⚠️ 失败**不抛**：返回兜底表，让「目录接口挂了」不至于变成「模型不能选」。
   * 可见性过滤（剔 `visibility:hide` 的内部别名）在这里做 —— 只暴露 6 个裸 slug。
   */
  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    const models = await this.loadModels()
    return models.map((model) => this.toCatalogEntry(model))
  }

  private async loadModels(): Promise<readonly AstudioFallbackModel[]> {
    // ⚠️⚠️ **读驱动 TTL（20 分钟）**（2026-10-18 审计修复）：
    //    修前本方法只判 `remoteModels !== undefined` ⇒ 一旦成功拉到远端，
    //    **整个进程生命周期内永不再拉** —— 上游上线/下架模型后，用户的模型列表
    //    一直冻结在首次拉到的那份。而本仓库其余 **11 家**都有这条 20 分钟 TTL
    //    （`isCatalogFresh` / `isCatalogFreshFor`）⇒ 这是一处**规范偏差**，
    //    也让 `invalidateCatalogCache`（用户改设置立即失效）对本家**完全无效**。
    // ⚠️ 判据来源：`model-catalog.ts` 的 `isCatalogFresh`（**唯一**实现）。
    //    入口这一处用 `isCatalogFreshFor`（多一条**正交**的「用户主动失效」腿）：
    //    用户刚在 Jet Hub 改了开关就该立刻重拉，哪怕还在 20 分钟内。
    if (this.remoteModels !== undefined
      && isCatalogFreshFor(this.product.id, this.catalogAt, this.nowImpl())) {
      return this.remoteModels
    }
    if (this.catalogInFlight !== undefined) return await this.catalogInFlight
    const fetcher = this.fetchRemoteModelsImpl
    if (fetcher === undefined) {
      // 没注入认证服务也没注入目录回调 ⇒ 只能用兜底表（不报错，但要留痕）。
      this.warnImpl('[astudio] 未注入凭据/目录来源，模型列表退用内置兜底表')
      return this.product.fallbackModels
    }
    // ⚠️ 冷却与 TTL **必须走同一份可注入时钟**（2026-10-18 审计规范化）：
    //    修前冷却用 `Date.now()`、TTL 用 `now` 注入点 ⇒ 两个时钟分叉，
    //    单测推进 `now` 也推不动冷却窗口（其余 11 家统一用 `now`）。
    if (this.nowImpl() < this.catalogCooldownUntil) return this.product.fallbackModels
    const inFlight = (async (): Promise<readonly AstudioFallbackModel[]> => {
      try {
        // ⚠️ 上游 39 字段的全量 `raw` 在 `parseAstudioCatalog` 里保留（内核逐字段强
        // 校验），**这里不能裁**；对外展示的裁剪由 `CatalogEntry` 视图天然完成。
        const visible = astudioVisibleModels(await fetcher())
        if (visible.length === 0) {
          this.catalogCooldownUntil = this.nowImpl() + REMOTE_CATALOG_COOLDOWN_MS
          return this.product.fallbackModels
        }
        const converted = visible.map((model) => astudioCatalogToFallback(model))
        this.remoteModels = converted
        // ⚠️ **只在成功时**记时刻（失败不写）：否则一次网络抖动会把 TTL 上界
        //    刷新掉，下轮还要等满 20 分钟才发现上游其实没恢复。
        this.catalogAt = this.nowImpl()
        this.options.onCatalogLoaded?.()
        return converted
      } catch (error) {
        this.catalogCooldownUntil = this.nowImpl() + REMOTE_CATALOG_COOLDOWN_MS
        this.warnImpl(`[astudio] 模型目录读取失败，退用兜底表：${error instanceof Error ? error.message : String(error)}`)
        return this.product.fallbackModels
      } finally {
        this.catalogInFlight = undefined
      }
    })()
    this.catalogInFlight = inFlight
    return await inFlight
  }

  /**
   * 强制重读远端目录（接线里的「同步模型」按钮用；失败回兜底表）。
   *
   * ## ⚠️ 下面两条清腿**互为冗余**（2026-10-18 变异实测，如实登记）
   *
   * `loadModels` 的 gate 是**合取**：`remoteModels !== undefined &&
   * isCatalogFreshFor(…)`，而 `isCatalogFresh` 对 `at === 0` **恒判陈旧**
   * （`model-catalog.ts:255`）⇒ 两条清腿**任一条**都足以让 gate 失效：
   *
   * | 注入的变异 | 实测结果（`astudio-catalog-effort.spec.ts`） |
   * |---|---|
   * | 只删 `catalogAt = 0` | **12 passed**（行为逐例不变） |
   * | 只删 `remoteModels = undefined` | **12 passed**（行为逐例不变） |
   * | **两条都删** | **1 failed**（点「同步模型」看不到变化 —— 真回归） |
   *
   * ⇒ 本方法的**不变式是「至少清一条」**，而不是「必须清某一条」。
   *    两条都留着是**防御**（与新加的 `createModelCatalog` 的 `refresh` 回调同款写法），
   *    但**不得把任一条单独说成承重腿** —— 那是假因果（本仓库明令的失效形态）。
   *    ⚠️ 同型但**结构不同**的真实缺陷在 `aggregate-adapter.ts` 的 `refreshCatalog`：
   *    那边的 gate 只判 TTL（无「remoteModels 已置空」这一腿），
   *    故「不传 force ⇒ 点刷新看不到任何变化」在那里是真缺陷。
   */
  async refreshCatalog(): Promise<readonly LlmModelInfo[]> {
    this.catalogAt = 0
    this.remoteModels = undefined
    this.catalogCooldownUntil = 0
    await this.loadModels()
    return await this.listModels(this.product.id)
  }

  /**
   * ★ **后台目录刷新器入口**（`src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`，
   * 每 20 分钟一轮；用户改设置时的立即失效走 `invalidateCatalogCache`）。
   *
   * ⚠️⚠️ 存在的理由（2026-10-18 审计发现）：`createCatalogRefresher` 遍历
   * `modelAdapters` 并调 `adapter.refresh?.()`，**返回 `undefined` 即静默跳过**。
   * 而 `refresh` 是 `createModelCatalog` 返回的 **catalog 实例**上的成员
   * （`model-catalog.ts` 的 `ModelCatalog.refresh`），**不会自动变成适配器的成员**
   * ⇒ 不在类上显式转发的话，「模型目录刷新器已武装」的日志为真、实际**一家都不刷**。
   *    （该缺口已实测：本仓库 12 家适配器的原型上**都没有** `refresh` 成员，
   *    而 `catalog-refresher-wiring.spec.ts` 只断言了武装日志、
   *    没有任何一条断言「真的刷了某家」。）
   *
   * ⚠️ 与 `options.refresh` **不是同一件事**：那个是 HTTP 401 之后的**凭据**重取，
   * 本方法是**目录**强制重拉。两者同名纯属巧合，**不得合并**。
   */
  async refresh(): Promise<void> {
    await this.catalog.refresh?.()
  }

  // ── 推理 ──

  /**
   * 一次推理（**只发 `stream:true`**：harness 要的是 `StreamChunk`，而本家流式是标准
   * OpenAI 增量 + `[DONE]`，末 chunk 带 usage —— 实测 `stream_options.include_usage`
   * 不带时流里没有 usage 帧，计费与统计双缺，故该键由 `buildAstudioChatRequest` 恒补）。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credential = await this.resolveCredentialImpl()
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError(
        'astudio: 没有可用凭据；请在 AStudio 客户端登录后重试（本 provider 读磁盘 userdata\\astron-session.json）',
        'MISSING_CREDENTIAL',
      )
    }

    // 消息归一化**必须**走共享件：它自带 harness 消息形状归一与 tool 配对，
    // 自己拼会把 tool_result 的 id 关系弄丢（本仓库多次踩过）。
    const messages = serializeMessages(options.messages)

    // 档位声明取自**当前目录条目**（裸 slug 比对，兼容传入 builtin/ 别名形态）。
    const modelId = astudioBareSlugOf(options.model)
    const declared = this.catalogSource().find((entry) => entry.id === modelId)
    // ⚠️⚠️ **门禁的集合必须与「播报给宿主的集合」同源**（2026-10-18 审计 P1）。
    //    宿主被告知的是 `astudioReasoningOf()` 的输出（见上面的 `reasoningFor`），
    //    它比原始字段多一条腿：「远端只给 `default_reasoning_level`（没有
    //    `supported_reasoning_levels`）⇒ **单档**」。而修前这里直接读**原始**
    //    `entry.efforts` ⇒ 那种模型播报 `['high']`、门禁却算出空集合 ⇒ 用户
    //    **唯一可选**的档位被静默丢弃，且 warn 文案是**假的**（「上游目录未对该
    //    模型声明任何思考档位」——可它明明声明了）。
    //    端到端实测（审计探针）：播报 `["high"]` / 实际上行 `undefined` / warn 如上。
    //    ⚠️ 同一函数里两份同义判据 = 本仓库明令的失效形态（与 accio 的
    //    「两张远端表顺序颠倒」同族）。
    const declaredEfforts = astudioReasoningOf({
      efforts: declared?.efforts,
      defaultEffort: declared?.defaultEffort,
    })
    const decision = astudioEffortForRequest(
      options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      declaredEfforts?.efforts.map((effort) => effort.id),
    )
    if (decision.dropped !== undefined) {
      // ⚠️ 静默丢弃是明令禁止的：上游对非法档位**不报错、按最大档跑**，不留痕就等于
      // 用户付了 `max` 的钱却在 UI 上看到「未思考」，事后无从归因。
      this.warnImpl(`[astudio] 丢弃思考档位 ${decision.dropped}：${decision.reason ?? ''}`)
    }

    const body = buildAstudioChatRequest({
      model: options.model,
      messages,
      ...options.system !== undefined ? { system: options.system } : {},
      ...options.tools !== undefined && options.tools.length > 0
        ? { tools: options.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              ...tool.description.length > 0 ? { description: tool.description } : {},
              ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
            },
          })) }
        : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      ...options.stop !== undefined ? { stop: options.stop } : {},
      ...decision.effort !== undefined ? { reasoningEffort: decision.effort } : {},
      // 实测客户端会带 `user`（上游不强求）；凭据里没有 uid 时退回 account_id。
      ...credential.uid !== undefined && credential.uid.length > 0
        ? { user: credential.uid }
        : credential.account_id !== undefined && credential.account_id.length > 0
          ? { user: credential.account_id }
          : {},
      stream: true,
    })

    const url = `${this.product.maasBaseUrl.replace(/\/+$/, '')}${this.product.chatPath}`
    const send = async (token: AstudioCredential): Promise<Response> => {
      try {
        return await this.fetchImpl(url, {
          method: 'POST',
          headers: astudioChatHeaders(token, this.product, 'text/event-stream'),
          body: JSON.stringify(body),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted === true) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `astudio: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    let active = credential
    let response = await send(active)

    // 非 2xx：先分类，再判「是不是该走 401 重取那一次」。
    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      const info = classifyAstudioError(response.status, errorText)
      if (astudioAuthRetryPlan({ status: response.status, attemptedRefresh: false, refreshFailed: false })
        === 'refresh-and-retry') {
        const retried = await this.retryAfterRefresh(send, active, options.signal)
        if (retried !== undefined) {
          active = retried.credential
          response = retried.response
        } else {
          throw new LlmError(
            `${info.message}；重取凭据后仍失败 ⇒ 请在 AStudio 客户端重新登录（微信）`,
            'AUTH',
            { status: response.status },
          )
        }
      } else {
        throw new LlmError(info.message, astudioLlmErrorCode(info.llmCode), { status: response.status })
      }
    }

    if (!response.ok) {
      // 重取后仍非 2xx：按**新一次**的响应重新分类（凭据可能已换，状态码也可能变）。
      const retryText = await response.text().catch(() => '')
      const info = classifyAstudioError(response.status, retryText)
      throw new LlmError(info.message, astudioLlmErrorCode(info.llmCode), { status: response.status })
    }

    // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧出现 —— **判失败由
    // `consumeOpenAiSse` 负责**（它把这种帧归成 `LlmError` 抛出）；这里的 `onFrame`
    // 只是**旁路观测**（回调抛错会被吞，绝不能把一次正常推理打死），用于把本家
    // 信封码记进告警，便于归因。
    yield* consumeOpenAiSse(
      astudioWrapIncremental(response),
      { ...options.signal !== undefined ? { signal: options.signal } : {} },
      {
        label: 'astudio',
        firstTokenTimeoutMs: firstTokenTimeoutMs(this.product),
        chunkTimeoutMs: chunkTimeoutMsFor(this.product),
        ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
        onFrame: (frame: Record<string, unknown>) => {
          const code = astudioStreamErrorCode(frame)
          if (code !== undefined) {
            this.warnImpl(`[astudio] 流内错误帧 code=${code} ${astudioStreamErrorMessage(frame).slice(0, 200)}`)
          }
        },
      },
    )
  }

  /**
   * 401 后**重取一次并重发一次**（唯一的自愈路径）。
   *
   * 三条实测驱动的取舍：
   * - **不轮换就不重发**：本家 `modelBearerToken` 幂等不轮换，`changed === false`
   *   意味着再发一次必然还是同一个 401 —— 白烧一次请求，还会把错误文案推远。
   * - **终态直接放弃**：`terminal`（含 `code=80000`「登录异常，请重新登录」）表示
   *   只能人工重登，定时/循环刷新都救不回来。
   * - **绝不循环**：最多两次 `send`（首次 + 重发一次），由 `astudioAuthRetryPlan`
   *   的 `attemptedRefresh` 语义保证；这里不再自己加次数以外的重试。
   *
   * 返回 `undefined` = 「没救」（刷新失败/终态/凭据没变/重发后仍非 2xx 由调用方归类）。
   */
  private async retryAfterRefresh(
    send: (credential: AstudioCredential) => Promise<Response>,
    failed: AstudioCredential,
    signal?: AbortSignal,
  ): Promise<{ credential: AstudioCredential; response: Response } | undefined> {
    let outcome: AstudioRefreshOutcome | undefined
    try {
      outcome = await this.refreshImpl()
    } catch (error) {
      // `refreshOnce` 按契约**不抛**；抛到这里说明注入的替身自己坏了 ⇒ 视为没救，
      // 但终态语义仍要如实透出（否则调用方会把它当成一次可重试的 401）。
      if (isAstudioTerminalRefreshError(error) || error instanceof AstudioRefreshTokenExpiredError) return undefined
      this.warnImpl(`[astudio] 凭据重取异常：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    if (outcome === undefined) return undefined
    if (outcome.terminal) return undefined
    const fresh = outcome.credential
    if (fresh === undefined || fresh.access_token.length === 0) return undefined
    if (outcome.changed === false && fresh.access_token === failed.access_token) return undefined
    const retry = await send(fresh)
    if (retry.ok) return { credential: fresh, response: retry }
    // 重发仍失败：把两次的信息都带进错误文案，但**不再**第三次尝试。
    const retryText = await retry.text().catch(() => '')
    const info = classifyAstudioError(retry.status, retryText)
    throw new LlmError(
      `${info.message}（已重取凭据一次后仍失败 via=${outcome.via}）`,
      astudioLlmErrorCode(info.llmCode),
      { status: retry.status },
    )
  }
}

/**
 * 在 `ctx.llm` 上注册 AStudio 路由与适配器。
 *
 * ⚠️ **本函数不改任何热点文件** —— 谁调用它属于接线意图（`index.ts` /
 * `provider-registry.ts` 等 8 处），这里只提供入口。
 *
 * 返回适配器实例：Jet Hub 显示列表要 `listAllModels()`，而 `ctx.llm` 不透传自定义方法，
 * 故调用方须持有引用（与 loomy / accio 同一约定）。
 */
export function registerAstudioLlm(ctx: Context, options: AstudioAdapterOptions = {}): AstudioAdapter {
  const product = options.product ?? ASTUDIO
  const auth = options.auth
    ?? ((ctx as { astudioAuth?: AstudioAuth }).astudioAuth)
  const adapter = new AstudioAdapter({
    ...options,
    ...auth !== undefined ? { auth } : {},
    product,
    // ⚠️ 注入**唯一**的广播实现（`src/catalog-broadcast.ts`），不要另写一份 emit。
    onCatalogLoaded: (): void => { broadcastCatalogChanged(ctx) },
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
