/**
 * 腾讯 Marvis 的 DSH 适配器。
 *
 * ## 与其余 16 家的同构点
 *
 * 目录（黑名单 / 关闭供应商 / 无账号门控）、错误分类、槽轮换、Token 账本
 * 全部走仓库的共享实现，**本文件不重写任何一条**：
 *
 * | 关注点 | 落点 |
 * | --- | --- |
 * | 目录门控与黑名单 | `model-catalog.ts` 的 `createModelCatalog` |
 * | 请求体（工具包装 / `include_usage`） | `marvis-messages.ts` |
 * | 流帧解析（思考 / 工具增量 / usage） | `openai-compat.ts` 的 `consumeOpenAiSse` |
 * | 取消判定 | `aggregate-adapter.ts` 的 `isAbortLike`（**共享唯一一份**） |
 * | 限流冷却终点 | `model-queue.ts` 的 `nextUtc8DayStartMs` |
 *
 * ## 本家独有的三处
 *
 * 1. **目录只有一条且没有远端端点**（实测 9 个候选端点全 404）⇒ `catalog()`
 *    恒返回静态表；保留 `createModelCatalog` 是为了黑名单/门控与其余家同源。
 * 2. **槽里是完整凭据对象**（`MarvisSlot.credential`），不是裸 Key ——
 *    请求头需要 `openid` / `guid` / `login_type` 三格。
 * 3. **`content-type` 闸门必须放行 `text/plain`**：实测上游对 `stream:true`
 *    回 `text/plain; charset=utf-8`，而 body 是标准 SSE。照抄 modelscope 的
 *    `includes('text/event-stream')` 会把**每一次正常请求**都当成风控页。
 *
 * @module marvis-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AccountPool } from './account-pool.js'
import { createModelCatalog, type CatalogEntry } from './model-catalog.js'
import { collectImages, consumeOpenAiSse, serializeMessages } from './openai-compat.js'
import { isAbortLike } from './aggregate-adapter.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import { retryAfterMsFromResponse } from './retry-after.js'
import { reportLedgerAccount } from './token-ledger.js'
import { llmHeaders, marvisAccountOf, marvisChatUrl, type MarvisCredential } from './marvis.js'
import { buildMarvisPayload } from './marvis-messages.js'
import {
  MARVIS,
  MARVIS_FALLBACK_MODELS,
  classifyMarvisError,
  marvisErrorKindCode,
  normalizeMarvisModelId,
  type MarvisErrorInfo,
  type MarvisFallbackModel,
  type MarvisProduct,
} from './marvis-product.js'

/** 一个可用的账号槽（接线层按账号池手动顺序产出）。 */
export interface MarvisSlot {
  /** 账号 id（`marvis-xxxxxxxx`）。 */
  readonly id: string
  /** 解析好的凭据。 */
  readonly credential: MarvisCredential
}

/** 适配器选项。 */
export interface MarvisAdapterOptions {
  /**
   * 单凭据回退 ref（无账号池条目时用）。
   *
   * ⚠️ 类型是 `unknown` —— 本适配器不用它做解析（凭据一律经 `slots()`
   * 由接线层解析好传进来），保留只为与其余 `registerXxxLlm` 的选项形状一致。
   */
  credentialRef?: unknown
  /**
   * 取当前可用槽序列（按账号池的手动顺序）。
   *
   * @param modelId 目标模型。**推理路径必须传**，接线层据此过滤掉
   *   「该模型正处于限流窗口」的账号。
   *   ⚠️ **目录路径刻意不传**：目录与「哪个账号此刻被限流」无关。
   */
  slots: (modelId?: string) => Promise<readonly MarvisSlot[]>
  /**
   * 账号池（**黑名单、关闭意图、目录门控的唯一数据源**）。
   *
   * ⚠️ 省略时（单测 / 嵌入方）行为退回「不过滤、不判关闭意图」；
   * **生产接线必须传**。
   */
  accountPool?: AccountPool
  /** 给某账号的某模型写限流标记（到 `resetAtMs` 为止）。 */
  markLimited?: (slotId: string, modelId: string, resetAtMs: number) => void | Promise<void>
  /** 警告出口（上游故障 / 换号原因）。 */
  warn?: (message: string) => void
  /** 读取图片附件（`analyzeImage` 工具用）。 */
  readImage?: (ref: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link MARVIS}。 */
  product?: MarvisProduct
}

/**
 * 限流/额度的冷却时长。
 *
 * ⚠️ 额度类**必须是「到次日 UTC+8 零点」**，不是「撞墙 +24h」：Marvis 的
 * 免费额度是**按自然日**重置的（钱包 `total_tokens` 每天回满），滑动窗口会让
 * 23:50 烧光的账号被封到**次日 23:50**，用户看到「0 点后上游已能用、插件仍说
 * 没到重置时间」（与 loomy 的 IKL80H 同型）。
 */
export function marvisRetryAfterMs(
  kind: MarvisErrorInfo['kind'],
  retryAfterMs: number | undefined,
  attempt: number,
  nowMs: number = Date.now(),
): number {
  if (kind === 'quota') return Math.max(0, nextUtc8DayStartMs(nowMs) - nowMs)
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return retryAfterMs
  }
  const backoff = 60_000 * 2 ** Math.max(0, attempt - 1)
  return Math.min(backoff, 30 * 60_000)
}

/** Marvis 适配器。 */
export class MarvisAdapter extends LlmAdapter {
  private readonly product: MarvisProduct
  private readonly options: MarvisAdapterOptions
  private readonly skeletonCatalog

  constructor(options: MarvisAdapterOptions) {
    super()
    this.options = options
    this.product = options.product ?? MARVIS
    this.skeletonCatalog = createModelCatalog(
      this.options.accountPool === undefined ? {} : { accountPool: this.options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
        // ⚠️ 省略 = 未知 = 放行；写 `['text']` 会让图片在 dispatch 前被替换成
        //    占位文字（`deepseek-v4-1-flash` 在 codearts 上踩过同款）。
        unknownModelInputModalities: () => ['text', 'image'] as const,
      },
    )
  }

  // ── 目录 ────────────────────────────────────────────────────────────────

  private toCatalogEntry(model: MarvisFallbackModel): CatalogEntry {
    return {
      id: model.id,
      name: model.name,
      inputModalities: model.supportsImage ? ['text', 'image'] : ['text'],
      ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
      // ⚠️ 刻意**不声明** `reasoning`：Marvis 的思考默认开且关不掉
      // （`none` 才真关），声明单档会让选择器出现一个点了没区别的按钮。
    }
  }

  private catalogEntries(): readonly CatalogEntry[] {
    return MARVIS_FALLBACK_MODELS.map((model) => this.toCatalogEntry(model))
  }

  /**
   * 目录（**无远端端点**）。
   *
   * 门控：没有任何已登录账号 ⇒ 空目录（与其余家同源，`createModelCatalog`
   * 读池；这里只补「槽为空」这一格）。
   */
  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    const slots = await this.options.slots()
    if (slots.length === 0) return []
    return this.catalogEntries()
  }

  /** `listAllModels` 用的同步目录（**绝不能 async**）。 */
  private syncCatalogEntries(): readonly CatalogEntry[] {
    return this.catalogEntries()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider === '' ? this.product.id : provider, name: this.product.displayName }
  }

  /**
   * **同步**全量目录。
   *
   * ⚠️ 消费者**不 await**（`jet-hub-rpc.ts` 的 `catalog = [...all]`），返回
   * Promise 会抛 `TypeError: all is not iterable`（minimax 的同款真实缺陷）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.catalogEntries().map((entry) => ({ id: entry.id, name: entry.name }))
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return await this.skeletonCatalog.listModels(_provider)
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const id = normalizeMarvisModelId(model)
    const entry = MARVIS_FALLBACK_MODELS.find((m) => m.id === id)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id,
      name: entry?.name ?? id,
      inputModalities: entry?.supportsImage === true ? ['text', 'image'] : ['text'],
    }
    // `contextWindow = 0` 是「不知道」哨兵：下发 0 会让宿主压缩算术除零。
    const contextWindow = entry?.contextWindow ?? 0
    if (contextWindow > 0) resolved.context = { contextWindow }
    return resolved
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  // ── 图片 ────────────────────────────────────────────────────────────────

  private async resolveImageUrls(
    model: string,
    messages: readonly { content: unknown }[],
  ): Promise<ReadonlyMap<string, string> | undefined> {
    const refs = new Map<string, unknown>()
    for (const message of messages) {
      if (Array.isArray(message.content)) collectImages(message.content, refs)
    }
    if (refs.size === 0) return undefined

    const id = normalizeMarvisModelId(model)
    const entry = MARVIS_FALLBACK_MODELS.find((m) => m.id === id)
    if (entry?.supportsImage !== true) {
      throw new LlmError(
        `marvis: 模型 "${model}" 不支持图片输入`,
        'UNSUPPORTED_CONTENT',
      )
    }
    if (this.options.readImage === undefined) {
      throw new LlmError('marvis: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
    }
    const readImage = this.options.readImage
    const out = new Map<string, string>()
    for (const [refId, ref] of refs) {
      const image = await readImage(ref)
      if (image === undefined) continue
      out.set(refId, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
    }
    return out
  }

  // ── 推理 ────────────────────────────────────────────────────────────────

  /**
   * 轮换：失败按「语义」标记该槽 → 换下一槽重发。
   *
   * 三条硬规则（与其余家同源）：
   * 1. `tried` **跨迭代保留** —— 每次重置会让两个槽之间无限来回；
   * 2. **已交付内容的流不重放**；
   * 3. **认证类不写限流标记**（写它会放大成「全池被封」）。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const slots = await this.options.slots(options.model)
    if (slots.length === 0) {
      throw new LlmError(
        'marvis: 没有可用账号。请在 Jet Hub 的腾讯 Marvis 面板点击「新建账号」登录 QQ 或微信。',
        'MISSING_CREDENTIAL',
      )
    }

    const tried = new Set<string>()
    const limited: string[] = []

    for (;;) {
      const slot = slots.find((s) => !tried.has(s.id))
      if (slot === undefined) {
        throw new LlmError(
          `marvis: 所有账号对该模型均受限${limited.length > 0 ? `（${limited.join('、')}）` : ''}`,
          'QUOTA_EXCEEDED',
        )
      }
      tried.add(slot.id)
      reportLedgerAccount(this.product.id, slot.id)

      let delivered = false
      try {
        for await (const chunk of this.streamVia(slot, options)) {
          delivered = true
          yield chunk
        }
        return
      } catch (error) {
        if (delivered) throw error
        /**
         * ⚠️⚠️ 这里**没有** `if (error.code === 'QUOTA_EXCEEDED') throw error` 这条腿
         * （2026-11-09 评审 I2）。
         *
         * 从 modelscope 照抄时原样带过来过，但它在这里是**错的**：`streamVia` 把
         * 上游 402/额度耗尽映射成 `'QUOTA_EXCEEDED'` 抛出，短路后既不换号、也不写
         * 冷却标记 ⇒ `marvisRetryAfterMs('quota')` 的「次日 UTC+8 零点」是死代码，
         * 且还会把「所有账号都烧光」这个终态**提前**报给用户。
         *
         * 真正需要短路的是「槽位耗尽」那条 —— 它在 `try` **之外**抛（见上面
         * `slot === undefined` 分支），压根进不到 `catch`，不需要这条守卫。
         */
        // ⚠️ 取消必须排在一切分类之前：否则 AbortError 落进兜底 `server`
        //    分支会被当成「换个号再试」，用户点了取消还在继续发请求。
        if (isAbortLike(error, options.signal)) throw error

        const info = classifyMarvisFailure(error)
        // 400/422：**换号无益**（每个槽发的是同一个体），直接上抛原文。
        // 4130001「无效模型id」同组：同一 model id 换号一样 400。
        if (info.kind === 'invalid_request' || info.kind === 'model_unavailable') {
          throw new LlmError(
            `marvis: 请求被上游拒绝（${info.detail}）`,
            'BAD_REQUEST',
          )
        }
        if (info.kind === 'auth') {
          // 认证失败：**换下一个账号，但不写限流标记**。
          if (tried.size >= slots.length) throw error
          limited.push(`${slot.id}(认证失败)`)
          continue
        }
        if (info.kind === 'server' || info.kind === 'transport' || info.kind === 'risk') {
          // 上游故障 / 网络 / 风控：**不写标记**（都不是配额问题），只换下一个。
          this.options.warn?.(`marvis: 账号 ${slot.id} ${info.kind}，换下一个：${info.detail}`)
          if (tried.size >= slots.length) throw error
          continue
        }
        if (info.kind === 'context_window') {
          // 上下文超限**换账号也没用**（请求本身太大）⇒ 不写标记，直接抛，
          // 让宿主走溢出压缩。漏这一格会落进下面的「限流」默认分支 ⇒
          // 给账号写一个到次日零点的标记 ⇒ 用户只是消息太长却被封一整天。
          throw error
        }
        // 限流 / 额度：标记该槽后换下一个。
        const resetAtMs = Date.now() + marvisRetryAfterMs(info.kind, info.retryAfterMs, tried.size)
        await this.options.markLimited?.(slot.id, options.model, resetAtMs)
        limited.push(`${slot.id}(${info.kind})`)
      }
    }
  }

  /** 指定槽发一次请求（轮换循环的复用单元）。 */
  protected async *streamVia(
    slot: MarvisSlot,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    const imageUrls = await this.resolveImageUrls(options.model, options.messages)
    const messages = serializeMessages(
      options.messages as readonly { role: string; content: unknown }[],
      imageUrls,
    )
    const payload = buildMarvisPayload({
      model: normalizeMarvisModelId(options.model),
      messages,
      ...options.system !== undefined && options.system.length > 0 ? { system: options.system } : {},
      ...options.tools !== undefined ? { tools: options.tools } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      ...options.reasoningEffort !== undefined
        ? { reasoningEffort: String(options.reasoningEffort) }
        : {},
    })
    const response = await fetch(marvisChatUrl(this.product.baseUrl), {
      method: 'POST',
      // ⚠️ 模型网关**绝不能**带 `Ual-Access-Signature` 等业务签名头：
      //    加了会被判「登录态过期」（403 → 401）。
      headers: llmHeaders(marvisAccountOf(slot.credential), { accept: 'text/event-stream' }),
      body: JSON.stringify(payload),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (!response.ok) {
      // ⚠️ 必须先读体：额度/限流的语义在响应体里，而 body 只能读一次。
      const text = await response.text().catch(() => '')
      const retryAfterMs = retryAfterMsFromResponse(response.headers)
      const info = classifyMarvisError(response.status, text, {
        ...response.headers.get('retry-after') === null
          ? {}
          : { 'retry-after': response.headers.get('retry-after') as string },
      })
      // ⚠️ 额度必须用字面量 `'QUOTA_EXCEEDED'`（宿主 `QUOTA_EXCEEDED_CODE`
      //    的字面值是 `'QUOTA'`，客户端会把 message 换成「额度已用尽」）。
      const code = marvisErrorKindCode(info.kind)
      throw new LlmError(
        `marvis: HTTP ${response.status} — ${text.slice(0, 300)}`,
        code,
        {
          status: response.status,
          ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
        },
      )
    }
    // ⚠️⚠️ **content-type 闸门**（顺手挡住「HTTP 200 + HTML 风控页」）。
    //    ⚠️ 本家**必须放行 `text/plain`**：实测 `stream:true` 回的是
    //    `text/plain; charset=utf-8` 而 body 是标准 SSE。
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream') && !contentType.includes('text/plain')) {
      const peek = await response.text().catch(() => '')
      throw new LlmError(
        `marvis: 上游未返回事件流（content-type: ${contentType || '(空)'}）——`
        + '通常是被风控拦截（网关返回 200 + HTML 拦截页）。'
        + `${peek === '' ? '' : ` 服务端原文：${peek.slice(0, 200)}`}`,
        'SERVER',
        { status: response.status },
      )
    }
    yield* consumeOpenAiSse(
      response,
      options.signal !== undefined ? { signal: options.signal } : {},
      {
        label: 'marvis',
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
 * 自身 —— 早期版本误按「自身属性」读响应头，`retry-after` 因此永远读不到。
 */
export function classifyMarvisFailure(error: unknown): MarvisErrorInfo {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    failure?: { status?: unknown; providerRetryAfterMs?: unknown }
  }
  const status = typeof failure.failure?.status === 'number' ? failure.failure.status : 0
  const providerRetryAfterMs = typeof failure.failure?.providerRetryAfterMs === 'number'
    && Number.isFinite(failure.failure.providerRetryAfterMs)
    ? failure.failure.providerRetryAfterMs
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  const info = classifyMarvisError(status, message)
  return providerRetryAfterMs === undefined
    ? info
    : { ...info, retryAfterMs: info.retryAfterMs ?? providerRetryAfterMs }
}

/** 在 `ctx.llm` 上注册 marvis 路由。 */
export function registerMarvisLlm(ctx: Context, options: MarvisAdapterOptions): MarvisAdapter {
  const product = options.product ?? MARVIS
  const adapter = new MarvisAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
