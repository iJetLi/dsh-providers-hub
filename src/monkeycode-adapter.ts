/**
 * MonkeyCode 模型适配器。
 *
 * 走 **Anthropic Messages** 协议（请求体构造与 SSE 消费在
 * `src/monkeycode-messages.ts`，其中大部分**复用 minimax 的实现**）。
 *
 * ## 一家两通道，适配器只认凭据
 *
 * 通道差异（端点 + 鉴权头）全部收在 `monkeycode.ts` 的
 * {@link monkeycodeMessagesUrl} / {@link monkeycodeHeaders} 里。本文件**不做**
 * 通道分支判断 —— 唯一的例外是 `monkeycode-{basic,pro,ultra}/…` 前缀的模型
 * 只能在网关通道用（白泽账号选中它时给一条可读错误，而不是让上游回一个
 * 含糊的 4xx）。
 *
 * ## 目录：白泽动态 + 网关常量，**必然合并**
 *
 * `listAllModels()` 契约要求**同步**返回，而同步路径上拿不到「当前凭据是哪个
 * 通道」的异步信息。故目录 = `远端白泽目录 ∪ 网关内置常量`。
 * 代价是用户可能选中当前账号调不通的模型（会得到一个明确的 HTTP 错误），
 * 比「目录随账号漂移、且冷启动时为空」好得多（空目录会让面板误显示
 * 「已关闭且无模型可关」）。
 *
 * ## ⚠️ 刻意不声明 `reasoning` 档位表
 *
 * MonkeyCode 没有下发「每个模型支持哪些思考档位」的元数据。凭空编一张表
 * 就是假能力（Qoder 的教训：UI 给了选项、请求却被丢弃）。
 * - 目录条目**不带** `reasoning` ⇒ UI 不出现档位选择器；
 * - 但如果 harness 自己传了 `reasoningEffort`（例如用户在别处设过），
 *   仍会映射成 `thinking.budget_tokens` —— 见 `monkeycodeThinkingFor`。
 *
 * ## 错误码纪律（与 minimax 同口径）
 *
 * - 非 SSE 的 200 ⇒ `INVALID_REQUEST`（**不能**用 `SERVER`：那会命中
 *   `dsh-llm-retry` 的 `DEFAULT_RETRYABLE_CODES`，被自动重试 5 次，
 *   把一个「端点返回了 JSON」的错误放大成 5 个）；
 * - 402 ⇒ `QUOTA_EXCEEDED`；
 * - 其余按 `httpErrorCode(status)`。
 *
 * @module src/monkeycode-adapter.ts
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

import { createModelCatalog, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import type { AccountPool } from './account-pool.js'
import { httpErrorCode, collectImages } from './openai-compat.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import { isAbortLike } from './aggregate-adapter.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import {
  MONKEYCODE,
  MONKEYCODE_GATEWAY_MODELS,
  monkeycodeFallbackModels,
  type MonkeycodeModelEntry,
  type MonkeycodeProduct,
} from './monkeycode-product.js'
import {
  classifyMonkeycodeFailure,
  monkeycodeHeaders,
  monkeycodeMessagesUrl,
  recordsMonkeycodeRateLimit,
  shouldRotateMonkeycodeAccount,
  type MonkeycodeCredential,
  type MonkeycodeFailureClass,
} from './monkeycode.js'
import {
  buildMonkeycodeMessagesPayload,
  consumeMonkeycodeSse,
  monkeycodeThinkingFor,
  type MonkeycodeInlineImage,
} from './monkeycode-messages.js'

/** 一个可用账号（凭据 + 它在账号池里的 id）。 */
export interface MonkeycodeSlot {
  readonly accountId: string
  readonly credential: MonkeycodeCredential
}

/** {@link MonkeycodeAdapter} 的构造选项。 */
export interface MonkeycodeAdapterOptions {
  /** 默认凭据 ref（供 `provider.status` 等处展示，不参与请求）。 */
  readonly credentialRef: CredentialRef
  /**
   * 取**当前可用**的账号列表（按池内顺序）。
   *
   * ⚠️ 由 `index.ts` 注入而不是适配器自己读池：池的过滤规则（`enabled`、
   * 模型级冷却）是**账号池的语义**，散到适配器里会变成第二份判据。
   */
  readonly slots: (modelId?: string) => Promise<readonly MonkeycodeSlot[]>
  readonly accountPool?: AccountPool
  readonly readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  readonly product?: MonkeycodeProduct
  readonly onCatalogLoaded?: () => void
  readonly warn?: (message: string) => void
  readonly now?: () => number
  readonly fetchImpl?: typeof fetch
}

/** 单次请求允许最多换几个账号（防止池里 20 个坏 key 时打满上游）。 */
const MONKEYCODE_MAX_ROTATE = 4

/** 限流冷却：1 小时。 */
const MONKEYCODE_RATE_LIMIT_COOLDOWN_MS = 3_600_000

/**
 * 额度耗尽冷却：**对齐 UTC+8 次日 0 点**，不是固定 24 小时（2026-11-02 三审 F🔴-2）。
 *
 * 本仓自己的口径写在 `src/monkeycode-credits.ts` 里：「每日额度是隐式的**次日 0 点
 * 重置**，但上游不下发时刻」。既然是次日 0 点重置，`Date.now() + 24h` 就会把
 * **23:50 烧光**额度的号锁到**次日 23:50**（近 24 小时假死）—— 用户看到上游 0 点
 * 就恢复了，插件还说在冷却。这正是 Loomy IKL80H 那个坑。
 * baizhi / qiniu / accio / codely / loomy 全都用 `nextUtc8DayStartMs`。
 *
 * ⚠️ 顺带的好处：跨日后冷却自动失效，不需要额外的清理逻辑。
 */
function monkeycodeQuotaResetAt(nowMs: number): number {
  return nextUtc8DayStartMs(nowMs)
}

/**
 * MonkeyCode 适配器。
 *
 * ⚠️ 与 minimax 的差别：**没有 refresh 重试**。凭据是静态材料，
 * 401 只意味着「key 错了/被吊销」，重取一次还是同一份字符串 —— 重试纯属浪费。
 */
export class MonkeycodeAdapter extends LlmAdapter {
  private readonly options: MonkeycodeAdapterOptions
  private readonly product: MonkeycodeProduct
  private readonly catalogGate: RemoteCatalogGate
  private readonly catalog: ModelCatalog

  constructor(options: MonkeycodeAdapterOptions) {
    super()
    this.options = options
    this.product = options.product ?? MONKEYCODE
    this.catalogGate = new RemoteCatalogGate(
      options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded },
    )
    this.catalog = createModelCatalog(
      { ...options.accountPool === undefined ? {} : { accountPool: options.accountPool } },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
        // ⚠️ 目录外手填的 id 保守报 `['text']`（本仓库 12 家同口径）：
        // 宁可少报能力（用户改用文本描述），也不要报一个服务端可能不认的模态。
        unknownModelInputModalities: () => ['text'] as const,
        refresh: async () => {
                await this.loadModels()
        },
      },
    )
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 取目录。
   *
   * ⚠️ **没有远端来源**：网关的 `GET /v1/models` 实测返回 405（国内站与国际站
   * 行为逐字节一致），所以目录只可能是内置常量。这里刻意**不**保留
   * 「失败 ⇒ 回退」的远端分支：一个永远 405 的端点只会让每次冷启动多一次
   * 注定失败的往返，并把 `RemoteCatalogGate` 的失败冷却搅浑。
   */
  private async loadModels(): Promise<readonly MonkeycodeModelEntry[]> {
    return monkeycodeFallbackModels()
  }

  /**
   * ★ 后台目录刷新器入口（`src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`）。
   *
   * ⚠️ 必须由适配器**显式转发** `catalog.refresh`：`ModelCatalog` 上的这个成员
   * 不会自动变成适配器的成员（`pruned()` 的 Proxy 只透传适配器自己的成员）。
   * 漏转发 ⇒ 刷新器「已武装」却对这家**空转**，且零日志。
   *
   * ⚠️ 与「凭据续期」**不是同一件事**，两者同名纯属巧合，不得合并。
   */
  async refresh(): Promise<void> {
    await this.catalog.refresh?.()
  }

  /** 完整目录（**不套黑名单**），供 Jet Hub「显示列表」用。**必须同步**。 */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.catalog.listAllModels()
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(provider)
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolveModel(provider, model, signal)
  }

  /**
   * 兼容 0.1.1-rc.2 的 `prepareCall` shim。
   *
   * ⚠️ **必须包装**（不能只实现 `stream`）：harness 的生产路径走 `prepareCall`，
   * 只在 `stream` 里做的校验在测试里可以看到、在生产里永远不生效。
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
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 发一次流式请求。
   *
   * 结构：**逐账号尝试** → 失败分类 → 可换号则下一个 → 全失败抛错。
   * 已经产出过任何块之后**不再换号**（重发会造成重复输出）。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const slots = await this.options.slots(options.model)
    if (slots.length === 0) {
      throw new LlmError(
        'MonkeyCode: 还没有可用的 API Key。请在 Jet Hub 的 MonkeyCode 面板用「浏览器登录」添加账号，或在那里的「添加账号」弹窗粘贴一个 sk- / oma_ 开头的 Key。',
        'MISSING_CREDENTIAL',
      )
    }

    const entry = (await this.loadModels()).find((model) => model.id === options.model)
    const images = await this.inlineImages(options, entry)

    /**
     * 思考配置。
     *
     * ⚠️ 会话自动命名（`purpose: 'session-title'`）**强制关掉思考**：
     * DSH 用 ~64 token 发标题请求，若服务端默认思考会把预算吃满、正文 0 字符
     * ⇒ 标题永远停在 fallback（issue IKKVDH 的同一形态）。
     */
    const thinking = options.purpose === 'session-title'
      ? { type: 'disabled' as const }
      : monkeycodeThinkingFor(options.reasoningEffort)

    const payload = buildMonkeycodeMessagesPayload({
      model: options.model,
      messages: options.messages,
      ...options.system === undefined ? {} : { system: options.system },
      ...options.tools === undefined ? {} : { tools: options.tools },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.stop === undefined ? {} : { stop: options.stop },
      ...thinking === undefined ? {} : { thinking },
      ...images === undefined ? {} : { images },
    })
    // ⚠️ 序列化**一次**、所有账号共用：网关签名基于这份 body 算，
    // 每个账号各自 `JSON.stringify` 会得到逐字节相同但多份字符串的副本。
    const body = JSON.stringify(payload)

    let lastError: unknown
    let lastFailure: MonkeycodeFailureClass | undefined
    let lastStatus = 0
    /** 是否已经向调用方产出过块 —— 产出过就**不能**再换号重发。 */
    let yieldedAny = false
    const tried = new Set<string>()

    for (const slot of slots) {
      if (tried.has(slot.accountId)) continue
      tried.add(slot.accountId)
      if (tried.size > MONKEYCODE_MAX_ROTATE) break

      let response: Response
      try {
        response = await this.send(slot, body, options)
      } catch (error) {
        // ⚠️ 用户主动中止：原样抛，不当成「账号坏了」（否则会白写冷却）。
        if (options.signal?.aborted === true || isAbortLike(error)) throw error
        lastError = error
        lastFailure = 'other'
        this.warn(`[monkeycode] 账号 ${slot.accountId} 请求失败：${describeError(error)}`)
        continue
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        lastStatus = response.status
        lastFailure = classifyMonkeycodeFailure(errorText, response.status)
        /**
         * ⚠️ 400 里若是「上下文超限」，必须翻成 `CONTEXT_WINDOW_EXCEEDED`
         * （2026-11-02 复审发现）：上游原文是
         * `This model's maximum context length is 1048576 tokens. However, you
         *  requested …`，落 `INVALID_REQUEST` 时宿主既不重试、也**不触发溢出压缩**，
         * 用户只会看到一条永远失败的长对话。
         */
        const overContext = /maximum context length|context length is|too many tokens/i
          .test(errorText)
        lastError = new LlmError(
          `monkeycode: HTTP ${response.status}${errorText === '' ? '' : ` — ${errorText.slice(0, 500)}`}`,
          overContext && response.status === 400
            ? 'CONTEXT_WINDOW_EXCEEDED'
            : response.status === 402 ? 'QUOTA_EXCEEDED' : httpErrorCode(response.status),
          { status: response.status },
        )
        await this.markLimited(slot, lastFailure, options.model)
        this.warn(
          `[monkeycode] 账号 ${slot.accountId} 返回 HTTP ${response.status}`
          + `（${lastFailure}）：${errorText.slice(0, 200)}`,
        )
        // ⚠️ 参数错（400/422 等 `other`）换谁的号都一样错 —— 直接抛，别打遍整池。
        //    历史上这里无条件 continue，一个 max_tokens=0 就能把整条渠道判死。
        if (!shouldRotateMonkeycodeAccount(lastFailure)) throw lastError
        continue
      }

      // ⚠️ 200 但不是 SSE：网关在额度/签名问题上偶尔会回一段 JSON 错误体。
      // 用 INVALID_REQUEST 而不是 SERVER（后者会被 dsh-llm-retry 自动重试 5 次）。
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json') || contentType.includes('text/html')) {
        const errorText = await response.text().catch(() => '')
        lastStatus = response.status
        lastFailure = classifyMonkeycodeFailure(errorText, response.status)
        lastError = new LlmError(
          `monkeycode: 推理端点返回了非 SSE 响应（HTTP ${response.status}）：${errorText.slice(0, 500)}`,
          'INVALID_REQUEST',
          { status: response.status },
        )
        // ⚠️ 2026-11-02 复审：这里原来无条件 `throw`，把上一行刚算好的 `lastFailure`
        //    变成死赋值 —— 而上文 `classifyMonkeycodeFailure` 的注释写着「网关在**额度**/签名问题上偶尔回
        //    JSON」：若正文是「积分已耗尽」，那**恰恰应该换号**。
        //    `shouldRotate` 只放 quota / rate / auth / server；签名类（`other`）仍直接抛，
        //    不把整池打一遍。
        await this.markLimited(slot, lastFailure, options.model)
        this.warn(
          `[monkeycode] 账号 ${slot.accountId} 返回 200 但非 SSE（${lastFailure}）：`
          + errorText.slice(0, 200),
        )
        if (!shouldRotateMonkeycodeAccount(lastFailure)) throw lastError
        continue
      }

      if (response.body === null) {
        lastError = new LlmError('monkeycode: 响应缺少 body', 'EMPTY_RESPONSE')
        lastFailure = 'other'
        continue
      }

      try {
        for await (const chunk of consumeMonkeycodeSse({
          body: response.body,
          ...options.signal === undefined ? {} : { signal: options.signal },
        })) {
          yieldedAny = true
          yield chunk
        }
        return
      } catch (error) {
        if (options.signal?.aborted === true || isAbortLike(error)) throw error
        lastError = error
        // 流内错误没有 HTTP 状态，只能按文案分类（`SSE error` 事件里常带额度/限流字样）。
        lastFailure = classifyMonkeycodeFailure(describeError(error), 0)
        /**
         * ⚠️ 冷却与告警要排在 `yieldedAny` 判断**之前**（2026-11-02 复审发现）：
         * 原先 `if (yieldedAny) throw` 在最前面 ⇒ 已经产出过内容再撞上 quota/rate 时
         * **连冷却都不写**，该账号下一轮仍被优先选中、继续失败（qoder/accio 审计 §11 同型）。
         * 「不重发」那条不变量只约束**重试**，不约束记账。
         */
        if (recordsMonkeycodeRateLimit(lastFailure)) {
          await this.markLimited(slot, lastFailure, options.model)
        }
        this.warn(
          `[monkeycode] 账号 ${slot.accountId} 流式消费失败（${lastFailure}）：`
          + describeError(error),
        )
        // ⚠️ 已经产出过块：**原样抛**，不换号重发（会造成重复输出）。
        if (yieldedAny) throw error
      }
    }

    // 全部账号都失败：把「最后一类失败」翻译成对外错误码。
    if (lastError !== undefined) {
      if (lastFailure === 'quota' || lastFailure === 'rate' || lastFailure === 'auth'
        || lastFailure === 'server') {
        const code = lastFailure === 'rate'
          ? 'RATE_LIMIT'
          : lastFailure === 'auth'
            ? 'AUTH'
            : lastFailure === 'server' ? 'SERVER' : 'QUOTA_EXCEEDED'
        throw new LlmError(
          `monkeycode: 模型 ${options.model} 所有账号均不可用（${lastFailure}）：${describeError(lastError)}`,
          code,
          lastStatus === 0 ? {} : { status: lastStatus },
        )
      }
      throw lastError
    }
    throw new LlmError(
      `monkeycode: 模型 ${options.model} 没有可用账号`,
      'MISSING_CREDENTIAL',
    )
  }

  /** 用某个账号发一次请求。 */
  private async send(
    slot: MonkeycodeSlot,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    if (typeof slot.credential.signing_secret !== 'string') {
      // ⚠️ 缺 signing_secret 时网关**必然** 403，且文案只有
      // `invalid ohmyagent request`。提前抛可读错误，省掉一次无意义的往返。
      throw new Error(
        'MonkeyCode：这个账号缺少 signing_secret，请求无法通过签名校验。'
        + '请重新用浏览器登录一次（插件会自动换一对新凭据）。',
      )
    }
    const url = monkeycodeMessagesUrl(this.product)
    const headers = monkeycodeHeaders(slot.credential, { body, product: this.product })
    const fetcher = this.options.fetchImpl ?? fetch
    return fetcher(url, {
      method: 'POST',
      headers,
      body,
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
  }

  /** 给失败账号写模型级冷却（`auth` 不写，见 `recordsMonkeycodeRateLimit`）。 */
  private async markLimited(
    slot: MonkeycodeSlot,
    failureClass: MonkeycodeFailureClass,
    modelId: string,
  ): Promise<void> {
    const pool = this.options.accountPool
    if (pool === undefined) return
    if (!recordsMonkeycodeRateLimit(failureClass)) return
    /**
     * ⚠️ 时间基准取**注入的 `now()`**（三审 F🟢-1）：`Date.now()` 让冷却时刻不可被
     * 测试确定性驱动，而 baizhi 那侧用的是 `this.options.now?.() ?? Date.now()`
     * —— 两侧不对称会逼测试写相对区间（本来能写绝对值）。
     */
    const nowMs = this.options.now?.() ?? Date.now()
    const resetAt = failureClass === 'rate'
      ? nowMs + MONKEYCODE_RATE_LIMIT_COOLDOWN_MS
      : monkeycodeQuotaResetAt(nowMs)
    try {
      await pool.updateModelRateLimit(slot.accountId, modelId, resetAt)
    } catch (error) {
      // 冷却写失败不该把「已经失败的请求」变成另一种失败原因。
      this.warn(`[monkeycode] 写冷却失败：${describeError(error)}`)
    }
  }

  /**
   * 内联图片。
   *
   * ⚠️ 顺序很重要：**先判模型是否支持，再读字节**。反过来会让一次不支持图片
   * 的请求先把附件全读进内存、再抛错（大图场景下浪费且可能 OOM）。
   *
   * ⚠️ 不支持时**显式抛 `UNSUPPORTED_CONTENT`**，不静默丢图：静默丢弃会让
   * 用户以为图片被模型看到了（本仓库铁律）。
   */
  private async inlineImages(
    options: GenerateOptions,
    entry: MonkeycodeModelEntry | undefined,
  ): Promise<Map<string, MonkeycodeInlineImage> | undefined> {
    const refs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, refs)
    }
    if (refs.size === 0) return undefined
    if (entry?.supportsImage !== true) {
      throw new LlmError(
        `monkeycode: 模型 "${options.model}" 不支持图片输入`,
        'UNSUPPORTED_CONTENT',
      )
    }
    if (this.options.readImage === undefined) {
      throw new LlmError(
        'monkeycode: 图片输入需要附件服务（readImage 未提供）',
        'UNSUPPORTED_CONTENT',
      )
    }
    const readImage = this.options.readImage
    const images = new Map<string, MonkeycodeInlineImage>()
    for (const [id, ref] of refs) {
      const inline = await readImage(ref)
      if (inline === undefined) continue
      // ⚠️ Anthropic 的 `source.data` 要**裸 base64**（不带 `data:…;base64,` 前缀）。
      images.set(id, {
        mediaType: inline.mediaType,
        data: Buffer.from(inline.data).toString('base64'),
      })
    }
    return images
  }

  private toCatalogEntry(model: MonkeycodeModelEntry): CatalogEntry {
    return {
      id: model.id,
      name: model.name,
      // ⚠️ 省略 `inputModalities` = 「未知」（不是「明确不支持」）。
      // 写 `['text']` 会把图片能力**静默关掉**；两种语义在 DSH 侧不同。
      ...model.supportsImage === true ? { inputModalities: ['text', 'image'] as const } : {},
      ...model.contextWindow !== undefined && model.contextWindow > 0
        ? { contextWindow: model.contextWindow }
        : {},
    }
  }

  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    const all = await this.loadModels()
    return all.map((model) => this.toCatalogEntry(model))
  }

  private syncCatalogEntries(): readonly CatalogEntry[] {
    const source = monkeycodeFallbackModels()
    return source.map((model) => this.toCatalogEntry(model))
  }

  /**
   * 记一条警告。
   *
   * ⚠️ 适配器**不自带 logger**（选项里没有 `ctx`）：`warn` 由
   * `registerMonkeycodeLlm` 注入；单测里不注入时**静默** —— 让「没接 logger」
   * 的测试不用为了消警告而 mock 一个。
   */
  private warn(message: string): void {
    this.options.warn?.(message)
  }
}

/** 错误 → 可读文本（`catch` 到非 Error 值时也不丢信息）。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 注册适配器（与其余 provider 同款）。
 *
 * ⚠️ `registerAdapterIdempotent` 内部会做「同一 provider 只注册一次」的幂等，
 * 热重载时不会抛「already registered」。
 */
export function registerMonkeycodeLlm(
  ctx: Context,
  options: MonkeycodeAdapterOptions,
): MonkeycodeAdapter {
  const product = options.product ?? MONKEYCODE
  const adapter = new MonkeycodeAdapter({
    ...options,
    onCatalogLoaded: () => broadcastCatalogChanged(ctx),
    warn: options.warn ?? ((message: string) => { ctx.logger.warn(message) }),
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
