// src/magicrew-adapter.ts
/**
 * Magicrew（超级麦吉）的 `LlmAdapter` 实现 —— 推理面 + 目录面。
 *
 * ## 只做**流式**
 *
 * 实测（2026-10-28）非流式也能用（正常 JSON），但本实现**只走流式**：
 * 用户明确要求，且流式才能把 `reasoning_content` 分片及时交给上层。
 * ⚠️ magpie 的 `internals.md` 说「非流式被 11101 拒」是**旧记录、已被本轮实发否定**。
 *
 * ## 成功判据是**业务码**，不是 HTTP 状态
 *
 * 实测：用错配的 api_key 会得到 **HTTP 200 + `{"code":403,"message":"token无效"}`**
 * （content-type 是 `application/json` 而不是 `text/event-stream`）。
 * ⇒ 进流之前**必须先看 content-type**，否则会把这段 JSON 当 SSE 读、报「没收到任何内容」。
 *
 * ## 当前进度
 *
 * 目录面 + 推理面均已接线：静态表兜底 + 远端目录 + `createModelCatalog` 共享骨架。
 *
 * ## ⚠️ SSE 解析必须走共享件，**不得**在本文件手写
 *
 * 4c 曾在这里手写 `readSse` —— 那是**重复实现**（本仓库红线：一份文件里两套同义判据），
 * 而且手写版**没有**工具调用增量、`reasoning` 别名、两级超时、流内错误帧分类。
 * 现统一走 `openai-compat.ts:600` 的 {@link consumeOpenAiSse}（qoder / astudio /
 * officeace 等 8 家共用），`tool-call-delta` 因此才真正接上线。
 *
 * ## 消息序列化同样**走共享件**，不得手写
 *
 * 4c/4d 曾在这里手写 `toWireMessages` / `toWirePart` —— 与 SSE 那次同构的重复
 * 实现。它的实际后果不是「少几个字段」，而是**多轮工具往返丢工具结果**：
 * `tool-call` / `tool-result` / `reasoning` 三种块被映射成空文本占位 ⇒ wire 上
 * 既没有 `tool_calls` 也没有 `role:'tool'` ⇒ 模型看不到自己上一步的工具输出
 * （DSH 是 coding agent，工具往返是核心功能）。
 * 现统一走 `openai-compat.ts:186` 的 {@link serializeMessages}：它自带 harness
 * 消息形状归一（DSH 0.1.7 的一等 `role:'tool'`）、`resolveToolPairing`（工具
 * call/result 配对 + 孤儿剔除 + 空名调用剔除）与工具结果图片提升。
 *
 * ## 图片：**宁报错，不降级**
 *
 * 目录里的模型声明了 image 模态 ⇒ 用户发图时「把图换成占位文字」会让模型
 * **以为看到了**（幻觉），正是本仓库明令禁止的「省略 / 降级 = 放行」。
 * 故这里只有两条路：经注入的 `readImage` **真读字节**内联
 * （`data:<mime>;base64,…`），或抛 `INVALID_REQUEST`（未配置读图入口）。
 * 任务 6 会在 `index.ts` 桥接 `ctx.attachments.readImage`。
 */

import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import { createModelCatalog, isCatalogFreshFor, type ModelCatalog } from './model-catalog.js'
import { collectImages, consumeOpenAiSse, serializeMessages } from './openai-compat.js'
import type { AccountPool } from './account-pool.js'
import {
  MAGICREW,
  MAGICREW_CHAT_PATH,
  MAGICREW_FALLBACK_CONTEXT_WINDOW,
  MAGICREW_MIN_MAX_TOKENS,
  MAGICREW_REASONING_EFFORTS,
  MAGICREW_DEFAULT_EFFORT,
  MAGICREW_USER_AGENT,
  magicrewFallbackModelOf,
  type MagicrewProduct,
} from './magicrew-product.js'
import { isMagicrewApiKeyDeadError, type MagicrewCredential } from './magicrew-auth.js'
import { fetchMagicrewCatalogModels, type MagicrewCatalogModel } from './magicrew-catalog.js'
import { fetchMagicrewModelPoints, magicrewIsFree, magicrewRateOf } from './magicrew-credits.js'

/**
 * 内联一张图片为**原始字节**的注入点（由接线层桥接 `ctx.attachments.readImage`）。
 *
 * ⚠️ 契约与 `accio-adapter.ts:304` / `buddy-adapter.ts` 一致：**读不到返回 `undefined`**
 * （不是抛错、也不是返回空）—— 由本适配器统一判成 `INVALID_REQUEST`。
 */
export type MagicrewReadImage =
  (attachment: unknown) => Promise<{ data: Uint8Array, mediaType: string } | undefined>

export interface MagicrewAdapterOptions {
  readonly product?: MagicrewProduct
  readonly fetchImpl?: typeof fetch
  readonly warn?: (message: string) => void
  readonly now?: () => number
  readonly accountPool?: AccountPool
  readonly resolveCredential?: () => Promise<MagicrewCredential | undefined>
  readonly fetchRemoteModels?: () => Promise<readonly MagicrewCatalogModel[]>
  /**
   * 读图入口（任务 6 在 `index.ts` 桥接 `ctx.attachments.readImage`）。
   *
   * ⚠️ **缺省时遇到图片块必须抛错**，绝不降级成占位文字：目录里 vision 模型
   * 声明了 image 模态，用户发图后模型「看不到但以为看到了」= 幻觉，
   * 且症状是 HTTP 200 + 正文正常 + 上游零报错，几乎无法归因。
   */
  readonly readImage?: MagicrewReadImage
}

/**
 * 上游 UA —— 定义在 `magicrew-product.ts` 的 {@link MAGICREW_USER_AGENT}。
 *
 * ⚠️ **不要再在这里写一份字面量**（issue IKTPRV）：五个生产者打同一个
 * `product.host`，复制 5 份就会出现「改一个忘四个」⇒ 一个入口好了、别的入口
 * 照旧 405。取值的历史与真机矩阵见那个常量自己的注释。
 */

/**
 * 档位声明 —— 上游认 7 档但**强度不被区分**（见 `MAGICREW_REASONING_EFFORTS`）
 * ⇒ 只声明「关闭 / 开启」两档。
 *
 * ⚠️ **只在这里构造一次**：`unknownModelReasoning`（目录外 id）与 `toEntry`（目录内 id）
 * 必须给**同一份**声明，否则用户手填一个模型与选一个模型会看到两套档位。
 *
 * ⚠️⚠️ `efforts[].id` 与 `defaultEffort` 在 DSH 侧是**品牌类型** `ReasoningEffortId`
 * （`brand.d.ts`）⇒ 必须过构造函数；直接给 `string` 是 `TS2322`。
 */
function magicrewReasoning(): LlmResolvedModelInfo['reasoning'] {
  return {
    efforts: MAGICREW_REASONING_EFFORTS.map((id) => ({ id: ReasoningEffortId(id), name: id })),
    defaultEffort: ReasoningEffortId(MAGICREW_DEFAULT_EFFORT),
  }
}

/**
 * 从 `HTTP 200 + JSON` 的业务信封里读 `code`（读不到 / 非 JSON 返回 `undefined`）。
 *
 * ⚠️ 上游把**鉴权与业务失败都装在 200 的 body 里**（`{code:403,message:"token无效"}`），
 * 所以状态码根本不是判据。`magicrew-catalog.ts:49` 早就在读这个字段了；本文件此前
 * **只看文案** ⇒ 同一份信封两套判据，`{code:401}` 这类会落 `SERVER`（可重试）⇒ 白重试。
 *
 * ⚠️ `1000` 是上游的成功码（与 `magicrew-catalog.ts:49` 同一常量，两处合并已登记为
 * 后续任务，本轮**刻意不顺手改** catalog）。
 */
function magicrewBusinessCodeOf(text: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const code = (parsed as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

/**
 * 「组织 / 配置类」业务失败的判据（**不是** key 失效）。
 *
 * ⚠️⚠️ 这类错误**必须归 `INVALID_REQUEST` 而不是 `AUTH`**：本仓库的老坑是
 * `AUTH` 会把 message 一起吞掉、只留宿主那句「API 密钥无效」——而
 * `organization-code 不匹配` 这句**是用户唯一的出路**（国际站必须带组织码），
 * 吞掉之后用户只会反复重新登录。
 * 同理也不能落 `SERVER`：那会把它当可重试，白重试 5 次（实测该形态与 key 失效同形）。
 */
function isMagicrewConfigBusinessError(text: string): boolean {
  return /organization[\s_-]*code|org[\s_-]*code|组织/i.test(text)
}

/**
 * 把「非 SSE 响应体」判成 `LlmError`。
 *
 * ⚠️ 顺序固定：**先文案判 key 失效**（`isMagicrewApiKeyDeadError` 是共享判据，
 * 不另写一份正则）→ 再按业务码分类。`code !== 1000` 时把**上游原文**带进 message，
 * 而不是换成一句自造的文案（原文往往就是唯一的出路）。
 */
function magicrewNonStreamError(text: string): LlmError {
  // ⚠️ key 失效的文案本身就是出路（「重新登录」），且它是**唯一**该触发续期的形态。
  if (isMagicrewApiKeyDeadError(text)) {
    return new LlmError('超级麦吉 api_key 已失效，请重试或重新登录', 'AUTH')
  }
  const code = magicrewBusinessCodeOf(text)
  if (code !== undefined && code !== 1000) {
    if (isMagicrewConfigBusinessError(text)) {
      return new LlmError(`超级麦吉拒绝了请求（业务码 ${code}）：${text.slice(0, 300)}`, 'INVALID_REQUEST')
    }
    return new LlmError(`超级麦吉业务失败（业务码 ${code}）：${text.slice(0, 300)}`, 'SERVER')
  }
  return new LlmError(`超级麦吉返回了非流式响应：${text.slice(0, 200)}`, 'SERVER')
}

export class MagicrewAdapter extends LlmAdapter {
  private readonly product: MagicrewProduct
  private readonly fetchImpl: typeof fetch
  private readonly warnImpl: (message: string) => void
  private readonly nowImpl: () => number
  private readonly resolveCredentialImpl: () => Promise<MagicrewCredential | undefined>
  /**
   * 倍率表（model_id → inputPoints/outputPoints），由 loadModelPoints 填充。
   * 懒加载、失败静默：装饰性信息，拉不到就当没有，绝不影响目录本身。
   */
  private modelPoints: Readonly<Record<string, { inputPoints?: number, outputPoints?: number }>> = {}
  private readonly fetchRemoteModelsImpl: (() => Promise<readonly MagicrewCatalogModel[]>) | undefined
  private readonly readImageImpl: MagicrewReadImage | undefined
  private readonly catalog: ModelCatalog
  private remote: readonly MagicrewCatalogModel[] | undefined
  private catalogAt = 0
  /** 上次**失败**的时间戳（负缓存用；0 = 从未失败）。 */
  private catalogFailedAt = 0
  private catalogInFlight: Promise<readonly MagicrewCatalogModel[]> | undefined

  constructor(options: MagicrewAdapterOptions = {}) {
    super()
    this.product = options.product ?? MAGICREW
    this.fetchImpl = options.fetchImpl ?? fetch
    this.warnImpl = options.warn ?? ((message: string) => { console.warn(message) })
    this.nowImpl = options.now ?? (() => Date.now())
    this.resolveCredentialImpl = options.resolveCredential ?? (async () => undefined)
    this.fetchRemoteModelsImpl = options.fetchRemoteModels
    this.readImageImpl = options.readImage
    this.catalog = createModelCatalog(
      options.accountPool === undefined ? {} : { accountPool: options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadEntries(),
        /**
         * 目录里没有的 id ⇒ 保守报 `['text']`（与其余 12 家一致）。
         * ⚠️ 不能省略：省略 = 「未知」= 放行图片 ⇒ 发到不支持的服务端（每轮失败）。
         */
        unknownModelInputModalities: () => ['text'] as const,
        /**
         * 档位**与具体模型无关**（上游认 7 档、强度不区分）⇒ 未知 id 同样声明两档。
         * 与 cline / codearts 同型；省略会让用户手填模型时失去「关闭思考」能力。
         */
        unknownModelReasoning: () => magicrewReasoning(),
        /**
         * 未知 id 给**具名兜底窗口**（`MAGICREW_FALLBACK_CONTEXT_WINDOW`）。
         * ⚠️ 与 codearts 同因：缺窗口会让上下文占用条**整条不渲染**，且压缩阈值失去唯一输入。
         * 本家目录的窗口**全部来自静态表**（上游端点不下发），故给兜底是正确方向。
         */
        unknownModelContextWindow: () => MAGICREW_FALLBACK_CONTEXT_WINDOW,
        syncCatalog: () => this.syncEntries(),
        refresh: async () => {
          // ⚠️ **两个时间戳都要清**：只清 `catalogAt` 的话，正处在失败退避窗口里时
          //    「强制刷新」会被负缓存挡住 ⇒ 后台刷新器与用户点刷新**静默空转**。
          this.catalogAt = 0
          this.catalogFailedAt = 0
          await this.loadModels()
        },
      },
    )
  }

  providerInfo(provider: string): LlmProviderInfo {
    return {
      id: typeof provider === 'string' && provider.length > 0 ? provider : this.product.id,
      name: this.product.displayName,
    }
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return await this.catalog.listModels(provider)
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return await this.catalog.resolveModel(provider, model, signal)
  }

  /**
   * `prepareCall` shim（PR !66 要求必须包）：解析出的 model 与本次 stream 属于同一代。
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
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => this.stream(options),
    }
  }

  /** 同步全量目录（Jet Hub 的「显示列表」用）。 */
  listAllModels(): readonly { id: string, name: string }[] {
    return this.catalog.listAllModels()
  }

  /**
   * 强制重拉目录（`index.ts` 的 20 分钟后台刷新器与本文件的 `refresh` 一致）。
   *
   * ⚠️⚠️ **必须显式转发**（2026-10-29 审查发现）：`refresh` 是
   * `createModelCatalog` 返回的 **catalog 实例**上的成员，给 `config.refresh`
   * 传回调**不会**自动变成适配器的成员。而刷新器调的是 `adapter.refresh?.()`
   * ⇒ 不转发时它**静默跳过**（日志为真、实际零请求），与
   * `astudio-adapter.ts:444` 记的是同一个坑。`model-catalog-parity.spec.ts:747`
   * 会对「catalog 有 refresh 而适配器没有」的家**点名失败**。
   */
  async refresh(): Promise<void> {
    await this.catalog.refresh?.()
  }

  // ── 推理 ────────────────────────────────────────────────────────────────

  /**
   * 一次推理 —— **只走流式**（用户明确要求；`requestBody` 恒 `stream: true`）。
   *
   * ⚠️⚠️ **成败判据是业务码，不是 HTTP 状态**：用错配的 api_key 会得到
   * `HTTP 200 + {"code":403,"message":"token无效"}`，`content-type` 是
   * `application/json` 而不是 `text/event-stream`。⇒ 进流之前**必须先看 content-type**，
   * 否则会把这段 JSON 当 SSE 读，症状退化成「没收到任何内容块」，与真因相距很远。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credential = await this.resolveCredentialImpl()
    if (credential === undefined || credential.apiKey === undefined || credential.apiKey.length === 0) {
      throw new LlmError('超级麦吉账号未登录或缺少 api_key，请重新登录', 'AUTH')
    }
    const body = await this.requestBody(options)
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': MAGICREW_USER_AGENT,
      origin: this.product.webOrigin,
      // ⚠️ 聊天网关本身不校验 referer（实测 200），但与其余 magicrew 请求统一：
      //    同一上游的 profile / gateway-token 两个端点缺了它就是 403 空 body。
      referer: `${this.product.webOrigin}/`,
    }
    // ⚠️ 国际站**强制**要它（缺了是 HTTP 500 裸文本）；国内站不强制但带上无害。
    if (credential.organizationCode.length > 0) {
      headers['organization-code'] = credential.organizationCode
    }
    const response = await this.fetchChat(headers, body, options.signal)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      // ⚠️ 业务错误会以 HTTP 200 + application/json 返回（`code:403 token无效`）。
      //    不当成 SSE 读，否则症状是「没收到任何内容块」，与真因相距很远。
      throw magicrewNonStreamError(await response.text())
    }
    // ⚠️⚠️ **SSE 解析走仓库共享件**（`openai-compat.ts:600`），本文件**不再手写**
    // —— 手写版会形成第二套同义判据（本仓库红线），且必然缺 `tool-call-delta`、
    // `reasoning` 别名、流内错误帧分类与两级超时。
    //
    // ⚠️ 第一参是 **`Response`**（不是 `response.body`）：消费器内部自己
    // `getReader()`，**并在没有 body 时抛 `EMPTY_RESPONSE`** ⇒ 这里不再重复判空
    //（重复的判据就会漂移成两套错误码）。
    // ⚠️ 两级超时的数字**只来自产品配置**（`chatHeaderTimeoutMs` /
    // `chunkTimeoutMs`），不在这里另写常量 —— 否则改配置会漏掉一处。
    yield* consumeOpenAiSse(
      response,
      { ...options.signal !== undefined ? { signal: options.signal } : {} },
      {
        label: 'magicrew',
        // 等首 token 的上限（推理模型可能长时间只吐 reasoning）。
        firstTokenTimeoutMs: this.product.chatHeaderTimeoutMs,
        // 两次字节之间的上限。
        chunkTimeoutMs: this.product.chunkTimeoutMs,
        ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      },
    )
  }

  /**
   * 发推理请求并**只对「等响应头」这一段**设上限。
   *
   * ⚠️⚠️ 为什么必须单独一段（2026-10-29 审查）：`chatHeaderTimeoutMs` 此前只被喂给
   * `consumeOpenAiSse` 的 `firstTokenTimeoutMs`，而那是**拿到响应头之后**的首 token
   * 空闲超时 ⇒「等头」这一段**没有任何超时**，只靠 undici 默认（约 300s）。
   * 症状：网关卡在排队时用户看到一个「永远转圈、停止按钮也不一定立刻生效」的会话。
   * 而 `product.requestTimeoutMs` 在 `src/` 里当时**零读者**。
   *
   * ⚠️ 拿到响应头**立即** `clearTimeout`（`finally` 里）：这条定时器只管「等头」，
   * 绝不能误杀后面的长回答（推理模型可能长时间只吐 reasoning）。
   * 与 `opencode-adapter.ts:671` 的先例同形（独立 `AbortController` +
   * `AbortSignal.any` 合并调用方 signal + 超时后**抛出 controller 的 reason**）。
   */
  private async fetchChat(
    headers: Record<string, string>,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const headerController = new AbortController()
    const headerTimer = setTimeout(
      () => headerController.abort(
        new LlmError('超级麦吉：等待响应头超时（上游可能正在排队）', 'TIMEOUT'),
      ),
      this.product.chatHeaderTimeoutMs,
    )
    try {
      return await this.fetchImpl(`${this.product.host}${MAGICREW_CHAT_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal === undefined
          ? headerController.signal
          : AbortSignal.any([signal, headerController.signal]),
      })
    } catch (error) {
      // ⚠️ 只有**本控制器**超时才改写错误；调用方 abort 必须原样冒泡
      //    （否则「用户点了停止」会被报成「上游超时」，与真因无关）。
      if (headerController.signal.aborted) throw headerController.signal.reason
      throw error
    } finally {
      clearTimeout(headerTimer)
    }
  }

  private async requestBody(options: GenerateOptions): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: await this.wireMessages(options),
      // ⚠️ 只流式：本适配器**没有**非流式分支（用户明确要求）。
      stream: true,
      /**
       * ⚠️⚠️ **必须显式要 usage**（2026-10-29 实发实测）：
       * 三格请求全程 `usage` 都是 `n/a`（不发这个字段上游就**不回** usage 帧）；
       * 而 usage 是上下文占用条与 token 记账的**唯一来源** —— 缺了用户看到的是
       * 「占用 0% / 不显示」，且计费无从核对。
       * 与 `astudio` 同因（`stream_options.include_usage`）。
       */
      stream_options: { include_usage: true },
      /**
       * ⚠️⚠️ **未提供就一个字都不发**（2026-10-29 真账号实测，让模型从 1 数到 400）：
       *
       * | 配置 | `finish_reason` | 正文长度 |
       * |---|---|---|
       * | **不发该字段** | `stop` | **1491 字符（完整）** |
       * | `max_tokens: 8192` | `stop` | 1491（同样完整） |
       * | `max_tokens: 512` | **`length`** | **916 字符（被截断）** |
       *
       * 而 `toEntry` 不声明 `maxTokens`、静态表也没有 ⇒ DSH 侧 `options.maxTokens`
       * 在普通对话里**就是 `undefined`**。修前 `Math.max(undefined ?? 0, 512)` 恒发
       * 512 ⇒ **每一轮都被上游按 512 截断**，用户看到的是「模型话说一半」。
       * ⇒ 只有调用方**真的给了**预算才下发，且仍抬到下限（64 会被 reasoning 吃满）。
       */
      ...options.maxTokens === undefined
        ? {}
        : { max_tokens: Math.max(options.maxTokens, MAGICREW_MIN_MAX_TOKENS) },
    }
    // ⚠️ 非法档位**不发**：上游对非法值回 HTTP 400（`must be one of: none, …`）。
    //    判据用共享表 `MAGICREW_REASONING_EFFORTS`，不在这里另写一份。
    const effort = options.reasoningEffort
    if (typeof effort === 'string' && MAGICREW_REASONING_EFFORTS.includes(effort)) {
      body.reasoning_effort = effort
    }
    // ⚠️⚠️ **`options.tools` 不能直接下发**：它是 DSH 的 `ToolSchema`
    //（`{name, description, parameters}`），而上游要的是 **OpenAI 信封**
    //（`{type:'function', function:{name, description?, parameters?}}`）。
    // 直接摊平下发 ⇒ 上游 400（或更糟：吞掉字段、模型永不调用工具）。
    // 与 `astudio-adapter.ts:499-508` 逐字同形（同一份信封规则只写一遍形态）。
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          ...tool.description.length > 0 ? { description: tool.description } : {},
          ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
        },
      }))
    }
    return body
  }

  /**
   * wire 消息 = 共享件 {@link serializeMessages} 的产物（+ `options.system`）。
   *
   * ⚠️⚠️ **不得在本文件另写一份**（本仓库红线：一文件两套同义判据）。手写版
   * （4d 的 `toWireMessages` / `toWirePart`）的实测后果不是「少几个字段」，而是
   * **多轮工具往返丢工具结果**：`tool-call` / `tool-result` / `reasoning` 三种块
   * 被映射成空文本占位 ⇒ wire 上既无 `tool_calls` 也无 `role:'tool'` ⇒
   * **模型看不到自己上一步的工具输出**（工具往复是 DSH 的核心功能）。
   *
   * ⚠️ **`options.system` 不在 `messages` 里**（它是「一次性调用方」的独立入参，
   * 见 `GenerateOptions.system` 的注释），`serializeMessages` 只吃 `messages`
   * ⇒ 必须自己前置成 system 消息，否则整段系统提示**静默丢失**。
   * 与 `cline-adapter.ts:868` / `loomy-adapter.ts:996` / `raccoon-adapter.ts:690`
   * 同形（前置在数组最前面，先于 `messages` 里可能已有的 system 消息）。
   */
  private async wireMessages(options: GenerateOptions): Promise<Array<Record<string, unknown>>> {
    const messages = serializeMessages(options.messages, await this.imageUrlsOf(options))
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    return messages
  }

  /**
   * 收集图片附件 → 读字节 → `attachmentId → data URL` 映射（`serializeMessages` 的第二参）。
   *
   * ⚠️⚠️ **key 的语义**：共享件的消费点是 `userContentParts`
   * （`openai-compat.ts:113`）—— 它用 `block.attachment.attachmentId` 去查表。
   * 而 `collectImages`（同一文件 `:155`）收集时写入的 key **就是** `attachmentId`，
   * value 是**附件引用对象本身**（正是 `readImage` 的入参）⇒ 两条腿天然同源，
   * 不需要另造 id、也不需要把 ref 反解成字节。
   *
   * ⚠️ 返回 `undefined` 表示「整个请求没有图片」：`serializeMessages` 会走**纯文本**
   * 老路径（字符串形态 `content`）。返回**空 Map** 是另一种语义（「有图但读不到」），
   * 会把 user 消息升级成 parts 并留 `[image unavailable]` 占位 —— 那正是本适配器
   * **刻意不做**的降级（见下一条）。
   *
   * ⚠️ **缺读图入口 / 读不到字节 ⇒ 抛 `INVALID_REQUEST`，绝不降级成占位文字**
   * （4d 的策略原样保留）。占位符会让模型「看不到却以为看到了」= 幻觉，且症状是
   * HTTP 200 + 正文正常 + 上游零报错，几乎无法归因。
   * ⚠️ 未配置 vs 读不到是**两种不同的缺口**，文案必须分开（否则用户无从自救）。
   */
  private async imageUrlsOf(options: GenerateOptions): Promise<Map<string, string> | undefined> {
    const refs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, refs)
    }
    if (refs.size === 0) return undefined
    const readImage = this.readImageImpl
    if (readImage === undefined) {
      throw new LlmError('magicrew: 未配置读图入口，无法发送图片', 'INVALID_REQUEST')
    }
    const imageUrls = new Map<string, string>()
    for (const [attachmentId, attachment] of refs) {
      const inline = await readImage(attachment)
      if (inline === undefined || inline.data.byteLength === 0) {
        throw new LlmError(
          'magicrew: 图片附件读取不到内容（附件服务可能未就绪，或该对象已不存在）',
          'INVALID_REQUEST',
        )
      }
      const mediaType = inline.mediaType.length > 0 ? inline.mediaType : 'image/png'
      imageUrls.set(attachmentId, `data:${mediaType};base64,${Buffer.from(inline.data).toString('base64')}`)
    }
    return imageUrls
  }

  // ── 目录 ──

  private toEntry(model: MagicrewCatalogModel) {
    const fallback = magicrewFallbackModelOf(model.id)
    // ⚠️ 远端只给 value/label/vision；ctx 与档位**两个端点都不下发** ⇒ 取静态表。
    //    ⚠️ 静态表没有就**不给**（不编造 —— `model-catalog-parity.spec.ts` 有契约锁死）。
    //    兜底窗口走 `unknownModelContextWindow` 回调（上面 `:230`）—— 它只对**目录外**的 id 生效，所以两边都成立：
    //    目录内的模型不编造、目录外的不致于占用条消失。
    /**
     * 倍率与免费标记（I2）：input_points / 2000 就是本仓口径
     * （实测 200→0.1 / 20→0.01 / 1200→0.6）。
     * - 有倍率 ⇒ 拼进 name（8 家同款做法）；
     * - isFree 只从 input_points === 0 判，不能从 rate === 0 反推
     *   （缺价格时 rate 是 undefined 不是 0）。
     */
    // ⚠️ 两个原语吃的是**原始 wire 形状**（`input_points`），而 `modelPoints` 里
    //    是归一后的 `inputPoints` —— 在这里转一次，别在 `magicrew-credits.ts` 里
    //    再加一套同义判据。
    const points = this.modelPoints[model.id]
    const wirePoints = points === undefined ? {} : { input_points: points.inputPoints }
    const rate = magicrewRateOf(wirePoints)
    const baseName = model.name.length > 0 ? model.name : model.id
    const name = rate === undefined ? baseName : `${baseName}（${rate}×）`
    const contextWindow = fallback?.contextWindow
    return {
      id: model.id,
      name,
      bareName: baseName,
      // ⚠️⚠️ **括号必须包住整个三元**：写成 `...f(x) ? A : {}` 时 `...` 只作用于
      //    `f(x)`（一个 boolean）⇒ 两个分支**都不展开**（`isFree` 永远缺席）。
      //    这是本仓记过的同型坑（`...` 的条件展开必须 `...(cond ? A : B)`）。
      ...(magicrewIsFree(wirePoints) ? { isFree: true } : {}),
      inputModalities: model.vision ? ['text', 'image'] as const : ['text'] as const,
      contextWindow,
      // ⚠️⚠️ `CatalogEntry.reasoning` 的形状是 **`{ efforts: [{id, name}], defaultEffort? }`**
      //    （= `LlmResolvedModelInfo['reasoning']`），**不是**扁平的 `reasoningEfforts: string[]`。
      //    写成前者才能被 `createModelCatalog` 直接吃下；写成后者 `TS2322`。
      reasoning: magicrewReasoning(),
    }
  }

  private async loadEntries() {
    const models = await this.loadModels()
    return models.map((model) => this.toEntry(model))
  }

  private syncEntries() {
    return (this.remote ?? this.staticModels()).map((model) => this.toEntry(model))
  }

  private staticModels(): readonly MagicrewCatalogModel[] {
    return this.product.fallbackModels.map((model) => ({
      id: model.id,
      name: model.name,
      vision: model.supportsImage === true,
    }))
  }

  private async loadModels(): Promise<readonly MagicrewCatalogModel[]> {
    // ⚠️⚠️ **读驱动 TTL（20 分钟）**：`isCatalogFreshFor` 是**唯一**判据
    //    （`model-catalog.ts`），它比 `isCatalogFresh` 多一条**正交**的
    //    「用户主动失效」腿 —— 用户刚在 Jet Hub 改设置就该立刻重拉，
    //    哪怕还在 20 分钟内。TTL 数字**不在本文件**写死：用共享判据的默认值。
    //    修前这里没有门 ⇒ `catalogAt` / `nowImpl` 零读者 ⇒ 每次发消息
    //    （`prepareCall` → `resolveModel`）都会多一次目录 GET。
    if (this.remote !== undefined
      && isCatalogFreshFor(this.product.id, this.catalogAt, this.nowImpl())) {
      return this.remote
    }
    // ⚠️⚠️ **负缓存（失败退避）**：失败时 `catalogAt` 仍是 0 ⇒ 修前**每条消息**
    //    都会再发一次目录 GET + 一条 warn —— 恰好是这道门要消灭的形态
    //    （一次上游抖动 ⇒ 整段对话里每轮都多一次超时请求）。
    //    成功时 `catalogFailedAt` 会被清零，故正常路径不受影响；
    //    `refresh()` 会同时清零两个时间戳 ⇒ 用户/后台刷新**随时**能越过退避。
    if (this.catalogFailedAt !== 0
      && this.nowImpl() - this.catalogFailedAt < this.product.catalogRetryMs) {
      return this.remote ?? this.staticModels()
    }
    // 并发去重：多个入口同时 listModels 只发一次。
    if (this.catalogInFlight !== undefined) return await this.catalogInFlight
    const inFlight = this.fetchModels()
    this.catalogInFlight = inFlight
    try {
      return await inFlight
    } finally {
      this.catalogInFlight = undefined
    }
  }

  /** 真正的拉取（含注入拉取器 + 生产路径两级回退），由 {@link loadModels} 去重与门控。 */
  private async fetchModels(): Promise<readonly MagicrewCatalogModel[]> {
    // ① 测试注入的拉取器（e2e / 单测都走这条，便于离线）
    if (this.fetchRemoteModelsImpl !== undefined) {
      try {
        const models = await this.fetchRemoteModelsImpl()
        if (models.length > 0) {
          this.rememberModels(models)
          return models
        }
      } catch (error) {
        this.warnImpl(`[magicrew] 目录拉取失败，回退静态表：${String(error)}`)
      }
    }
    // ② 生产路径：用当前账号的 jwt 真拉
    const credential = await this.resolveCredentialImpl()
    if (credential !== undefined) {
      try {
        const models = await fetchMagicrewCatalogModels({
          jwt: credential.jwt,
          organizationCode: credential.organizationCode,
          product: this.product,
          fetchImpl: this.fetchImpl,
        })
        if (models.length > 0) {
          this.rememberModels(models)
          // ⚠️ 拉倍率（I2）：独立端点（实测 POST products/model-points + {model_ids:[…]}
          //    ⇒ 200 + 数组）。失败静默 —— 只影响 name 的倍率前缀与 isFree。
          await this.loadModelPoints(credential, models)
          return models
        }
      } catch (error) {
        // ⚠️ 网络抖动 ⇒ 退回上次快照/静态表，**别让整个 provider 从列表里消失**。
        this.warnImpl(`[magicrew] 目录拉取失败，回退：${String(error)}`)
      }
    }
    // ⚠️ 两条腿都没拿到 ⇒ 记失败时间戳（`loadModels` 的负缓存据此退避）。
    //    **不覆盖** `catalogAt`：上一次成功的时间戳仍然有效，
    //    只是被负缓存压在后面不再发请求。
    this.catalogFailedAt = this.nowImpl()
    return this.remote ?? this.staticModels()
  }

  /**
   * 拉一次倍率表（products/model-points）并缓存。
   * 失败静默：倍率是装饰性信息，让它的失败冒泡会让整份目录回退到静态表。
   * 空目录直接跳过（没有 id 可问，白花一次请求）。
   */
  private async loadModelPoints(
    credential: MagicrewCredential,
    models: readonly MagicrewCatalogModel[],
  ): Promise<void> {
    const ids = models.map((model) => model.id)
    if (ids.length === 0) return
    try {
      this.modelPoints = await fetchMagicrewModelPoints({
        jwt: credential.jwt,
        organizationCode: credential.organizationCode,
        modelIds: ids,
        product: this.product,
        fetchImpl: this.fetchImpl,
      })
    } catch (error) {
      this.warnImpl(`[magicrew] 倍率拉取失败（不影响目录）：${String(error)}`)
    }
  }

  /** 记一次目录**成功**：刷新时间戳并清掉失败退避（只此一处，避免两套写法）。 */
  private rememberModels(models: readonly MagicrewCatalogModel[]): void {
    this.remote = models
    this.catalogAt = this.nowImpl()
    this.catalogFailedAt = 0
  }
}
