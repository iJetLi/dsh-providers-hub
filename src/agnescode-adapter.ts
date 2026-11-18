/**
 * AgnesCode LLM 适配器（OpenAI 兼容直连 BFF）。
 *
 * ## 协议
 *
 * `POST {bffBase}/chat/completions`，纯 OpenAI 协议 —— 消息序列化、SSE 解帧、
 * 工具增量合并、截断判定全部复用共享实现，本文件不重写任何一条。
 *
 * ## 目录是**账号级**的
 *
 * `/v2/models` 按**当前请求的账号**下发（不同订阅档看到不同条目）。因此：
 *
 * - 目录缓存按 `bff_base` 分桶（不按 provider id 分），否则切号后看到的还是
 *   上一个号的目录；
 * - `listModels` 没有可用账号时返回 `[]`（骨架语义 = 目录为空 ⇒ 整家 provider
 *   被隐藏）；这正是「没登录就不该出现在选择器里」的门控。
 *
 * ## 轮换语义
 *
 * | 类别 | 换号？ | 写限流？ | 抛什么 |
 * |---|---|---|---|
 * | `auth`（401/403） | 换 | 不写 | 全试完抛 `AUTH`（**保留原文**与「重新导入」指路） |
 * | `rate_limit`（429） | 换 | 写（服务端 `retry-after` 优先） | 全试完抛 `QUOTA_EXCEEDED` |
 * | `context_window`（超限） | **不换** | 不写 | 直接抛（请求太大，换号无用；且要触发溢出压缩） |
 * | `invalid_request`（其余 400） | **不换** | 不写 | 抛 `BAD_REQUEST` + 原文 |
 * | `server`（5xx）/ 传输 | 换 | 不写 | 全试完抛原错误 |
 *
 * ⚠️ 已产出内容的流**不重放**（用户会看到两份输出）。
 *
 * ## 图片：一律拒绝，不静默丢弃
 *
 * 目录里没有任何条目声明能收图（`model_type` 恒 `"text"`）⇒ 带图请求直接抛
 * `UNSUPPORTED_CONTENT`。静默丢图会让模型「看不见却照常回答」，用户拿到幻觉
 * （Qoder 图片事故的教训）。
 *
 * @module src/agnescode-adapter.ts
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountPool } from './account-pool.js'
import { createModelCatalog, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { AGNESCODE, agnescodeFallbackModels, type AgnescodeProduct } from './agnescode-product.js'
import {
  agnescodeHeaders,
  fetchAgnescodeCatalog,
  trustAgnescodeBffBase,
  type AgnescodeCredential,
} from './agnescode.js'
import { buildAgnescodePayload } from './agnescode-messages.js'
import { collectImages, consumeOpenAiSse, httpErrorCode, serializeMessages } from './openai-compat.js'
import { isAbortLike } from './aggregate-adapter.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { reportLedgerAccount } from './token-ledger.js'
import { retryAfterMsFromResponse } from './retry-after.js'

/** 目录缓存 TTL（5 分钟，与 qiniu / opencode 同档）。 */
const CATALOG_TTL_MS = 300_000

/** 单槽（接线层解析好的账号 + 凭据）。 */
export interface AgnescodeSlot {
  accountId: string
  credential: AgnescodeCredential
}

/** 适配器选项。 */
export interface AgnescodeAdapterOptions {
  /** 产品配置；默认 {@link AGNESCODE}。 */
  product?: AgnescodeProduct
  /**
   * 取当前可用槽序列。`modelId` **推理路径必传**（据此过滤处于限流窗口的账号）；
   * **目录路径不传**（那会让被限流的账号把整个目录拖空）。
   */
  slots: (modelId?: string) => Promise<readonly AgnescodeSlot[]>
  /** 账号池（黑名单 / 关闭意图 / 门控的唯一数据源）。生产接线必须传。 */
  accountPool?: AccountPool
  /** 记录某账号在某模型上的冷却截止时刻。 */
  markLimited?: (accountId: string, modelId: string, resetAtMs: number) => Promise<void>
  /** 诊断日志。 */
  warn?: (message: string) => void
  /**
   * 网络出口（目录 / 余额 / 推理共用）。
   *
   * ⚠️ 必须可注入：否则单测会**真的**打上游 —— 本家端点对伪造凭据也可能回 200
   *（Qoder 那次已经踩过：测试静默变成随机真值）。生产不传 ⇒ 全局 `fetch`。
   */
  fetchImpl?: typeof fetch
}

/** 远端目录的缓存条目（按 `bff_base` 分桶）。 */
interface CatalogCacheEntry {
  at: number
  bffBase: string
  entries: readonly CatalogEntry[]
}

export class AgnescodeAdapter extends LlmAdapter {
  private readonly product: AgnescodeProduct
  private readonly skeletonCatalog: ModelCatalog
  /** 最近一次成功拉到的目录（留给**同步**的 `listAllModels`）。 */
  private lastCatalog?: CatalogCacheEntry

  constructor(private readonly options: AgnescodeAdapterOptions) {
    super()
    this.product = options.product ?? AGNESCODE
    this.skeletonCatalog = createModelCatalog(
      this.options.accountPool === undefined ? {} : { accountPool: this.options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
        // 目录只声明 `model_type: "text"` ⇒ 未知 id 保守报 `['text']`。
        unknownModelInputModalities: () => ['text'] as const,
      },
    )
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return await this.skeletonCatalog.listModels(provider)
  }

  /**
   * 同步全量目录（`listAllModels()` 用）。
   *
   * ⚠️ **不能 async**：`jet-hub-rpc` 的 `ModelCatalogSource` 是同步接口且消费者
   * 不 await，返回 Promise 会 `TypeError: all is not iterable`（minimax 的真实缺陷）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const cached = this.lastCatalog
    if (cached !== undefined && cached.entries.length > 0) {
      return cached.entries.map((entry) => ({ id: entry.id, name: entry.name }))
    }
    void this.warmCatalog()
    return agnescodeFallbackModels(this.product).map((m) => ({ id: m.id, name: m.name }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const entry = (await this.catalog()).find((item) => item.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      // ⚠️ 本家没有任何一条能收图：声明 `['text']` 是**明确否定**（不是「未知」），
      //    否则宿主会把图投影上来、上游静默忽略。
      inputModalities: ['text'] as const,
    }
    // 窗口未知**不编造**（0 是「不知道」哨兵）；自动压缩会拿它算阈值。
    if (typeof entry?.contextWindow === 'number' && entry.contextWindow > 0) {
      resolved.context = { contextWindow: entry.contextWindow }
    }
    // ⚠️ 单次输出上限必须走**顶层** `defaultMaxTokens`：不声明它宿主就不下发
    //    `maxTokens`，出站只能回落 4096 ⇒ 长回答被静默截断（baizhi 的 P0 同型）。
    if (typeof entry?.maxTokens === 'number' && entry.maxTokens > 0) {
      resolved.defaultMaxTokens = entry.maxTokens
    }
    return resolved
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return { model: await this.resolveModel(provider, model, signal), stream: (o) => this.stream(o) }
  }

  /** 异步目录 → 骨架中间结构；**没有可用账号时返回 `[]`**（隐藏整家 provider）。 */
  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    const slots = await this.options.slots()
    if (slots.length === 0) return []
    return (await this.catalog()).map((entry) => entry)
  }

  private syncCatalogEntries(): readonly CatalogEntry[] {
    const cached = this.lastCatalog
    if (cached !== undefined && cached.entries.length > 0) return cached.entries
    void this.warmCatalog()
    return agnescodeFallbackModels(this.product).map((m) => ({
      id: m.id,
      name: m.name,
      inputModalities: ['text'] as const,
      ...m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow },
      ...m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens },
    }))
  }

  /** 后台预热一次目录；失败静默（没有账号时本来就不该有目录）。 */
  private async warmCatalog(): Promise<void> {
    try {
      await this.catalog()
    } catch {
      // 预热失败不值得打扰用户。
    }
  }

  /**
   * 当前生效的目录（远端优先、失败回落兜底表）。
   *
   * ⚠️ 缓存按 `bff_base` 分桶且带 TTL：目录是**账号级**下发的，按 provider 存
   * 一份会让切号后看到上一个号的目录（与 monkeycode 目录按账号下发的同型坑）。
   */
  private async catalog(): Promise<readonly CatalogEntry[]> {
    const slots = await this.options.slots()
    const slot = slots[0]
    if (slot === undefined) return []
    const base = trustAgnescodeBffBase(slot.credential.bff_base)
    if (base === null) return []
    const cached = this.lastCatalog
    if (cached !== undefined && cached.bffBase === base && Date.now() - cached.at < CATALOG_TTL_MS) {
      return cached.entries
    }
    const remote = await fetchAgnescodeCatalog(
      slot.credential,
      this.product,
      this.options.fetchImpl ?? globalThis.fetch,
    )
    if (remote !== null && remote.length > 0) {
      const entries: CatalogEntry[] = remote.map((m) => ({
        id: m.id,
        name: m.name,
        inputModalities: ['text'] as const,
        ...m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow },
        ...m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens },
      }))
      this.lastCatalog = { at: Date.now(), bffBase: base, entries }
      return entries
    }
    return this.syncCatalogEntries()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const slots = await this.options.slots(options.model)
    if (slots.length === 0) {
      throw new LlmError(
        `agnescode: 没有可用账号。请在 Jet Hub 的 ${this.product.displayName} 面板`
        + '点「导入本机登录态」（需要先在本机安装并登录 AgnesCode 桌面端）。',
        'MISSING_CREDENTIAL',
      )
    }

    const tried = new Set<string>()
    const limited: string[] = []
    for (;;) {
      const slot = slots.find((s) => !tried.has(s.accountId))
      if (slot === undefined) {
        throw new LlmError(
          `agnescode: 所有账号对该模型均受限${limited.length > 0 ? `（${limited.join('、')}）` : ''}`,
          'QUOTA_EXCEEDED',
        )
      }
      tried.add(slot.accountId)
      reportLedgerAccount(this.product.id, slot.accountId)

      let delivered = false
      try {
        for await (const chunk of this.streamVia(slot, options)) {
          // 任何 chunk 产出都算「已交付」：宁可漏掉一次可切换的机会，也绝不重放。
          delivered = true
          yield chunk
        }
        return
      } catch (error) {
        if (delivered) throw error
        // ⚠️ 取消/中止必须**排在所有分类之前**：否则一次取消会被当成「换号再试」，
        //    用户点了取消却看到「额度用尽」（qiniu 的同款修法）。
        if (isAbortLike(error, options.signal)) throw error

        const failure = failureInfoOf(error)
        if (failure.kind === 'context_window' || failure.kind === 'invalid_request') {
          throw error
        }
        if (failure.kind === 'auth') {
          if (tried.size >= slots.length) throw error
          limited.push(`${slot.accountId}(认证失败)`)
          continue
        }
        if (failure.kind === 'server' || failure.kind === 'transport') {
          // 上游故障/网络问题：不写标记，只换下一个；槽耗尽时抛**原始错误**，
          // 否则单账号用户看到的是误导性的「额度用尽」。
          this.options.warn?.(`agnescode: 账号 ${slot.accountId} ${failure.kind}，换下一个`)
          if (tried.size >= slots.length) throw error
          continue
        }
        // 限流 / 额度：标记该槽后换下一个。
        const resetAtMs = failure.retryAfterMs !== undefined
          ? Date.now() + Math.max(0, Math.min(failure.retryAfterMs, 30 * 60_000))
          : Date.now() + 60_000
        await this.options.markLimited?.(slot.accountId, options.model, resetAtMs)
        limited.push(`${slot.accountId}(${failure.kind})`)
      }
    }
  }

  /** 指定槽发一次请求。 */
  private async *streamVia(slot: AgnescodeSlot, options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片：本家没有一条目录声明能收图 ⇒ 带图直接拒绝（不静默丢弃）。
    if (hasImages(options.messages)) {
      throw new LlmError(
        `agnescode: 模型 "${options.model}" 不支持图片输入（AgnesCode 目录只声明文本模态）`,
        'UNSUPPORTED_CONTENT',
      )
    }
    const messages = serializeMessages(
      options.messages as readonly { role: string; content: unknown }[],
    )
    const payload = buildAgnescodePayload({
      model: options.model,
      messages,
      ...options.system !== undefined && options.system.length > 0 ? { system: options.system } : {},
      ...options.tools !== undefined ? { tools: options.tools } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
    })
    const base = trustAgnescodeBffBase(slot.credential.bff_base)
    if (base === null) {
      throw new LlmError('agnescode: 凭据里的 BFF base 未通过 origin 钉扎，请重新导入登录态', 'AUTH')
    }
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { ...agnescodeHeaders(slot.credential), Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (!response.ok) {
      // ⚠️ 先读体：额度/语义在响应体里，而 body 只能读一次。
      const text = await response.text().catch(() => '')
      const retryAfterMs = retryAfterMsFromResponse(response.headers)
      const kind = kindOfStatus(response.status, text)
      const code = kind === 'auth'
        ? 'AUTH'
        : kind === 'rate_limit'
          ? 'RATE_LIMIT'
          : kind === 'context_window'
            ? CONTEXT_WINDOW_EXCEEDED_CODE
            : kind === 'quota'
              ? 'QUOTA_EXCEEDED'
              : httpErrorCode(response.status)
      throw new LlmError(
        `agnescode: HTTP ${response.status} — ${text.slice(0, 300)}`
        + `${response.status === 401 || response.status === 403
          ? '（会话可能已过期：请在本机重新登录 AgnesCode 桌面端，再点「导入本机登录态」）'
          : ''}`,
        code,
        {
          status: response.status,
          ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
        },
      )
    }
    // ⚠️ content-type 闸门：网关回 200 + HTML（风控页 / 登录墙）时若直接喂给
    //    SSE 解帧器，会解析出零帧 ⇒ 抛 EMPTY_RESPONSE ⇒ 归为传输错误 ⇒ 白打整池。
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const peek = await response.text().catch(() => '')
      throw new LlmError(
        `agnescode: 上游未返回事件流（content-type: ${contentType || '(空)'}）`
        + `${peek === '' ? '' : `；服务端原文：${peek.slice(0, 200)}`}`,
        'SERVER',
        { status: response.status },
      )
    }
    yield* consumeOpenAiSse(
      response,
      options.signal !== undefined ? { signal: options.signal } : {},
      {
        label: 'agnescode',
        firstTokenTimeoutMs: this.product.fetchTimeoutMs,
        chunkTimeoutMs: this.product.fetchTimeoutMs,
        ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      },
    )
  }
}

/** 消息里是否有图片附件。 */
function hasImages(messages: readonly { content: unknown }[]): boolean {
  const refs = new Map<string, unknown>()
  for (const message of messages) {
    if (Array.isArray(message.content)) collectImages(message.content, refs)
  }
  return refs.size > 0
}

/** 状态码 + 报文 → 语义类别。 */
type FailureKind = 'auth' | 'rate_limit' | 'quota' | 'context_window' | 'invalid_request' | 'server' | 'transport'

function kindOfStatus(status: number, text: string): FailureKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 402) return 'quota'
  if (status >= 500) return 'server'
  if (contextOverflowText(text)) return 'context_window'
  return 'invalid_request'
}

/**
 * 上下文超限的报文判据。
 *
 * ⚠️ 归 `CONTEXT_WINDOW_EXCEEDED` 而不是 `INVALID_REQUEST`：宿主只在**前者**上
 * 触发溢出压缩，判错会让唯一有效的动作（压缩重试）被掩盖（qiniu / gemini 同修法）。
 */
function contextOverflowText(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('context length')
    || lower.includes('context window')
    || lower.includes('maximum context')
    || lower.includes('too long')
    || lower.includes('reduce the length')
}

/** 从抛出的错误里还原语义（先看 `failure.status`，再看报文）。 */
function failureInfoOf(error: unknown): { kind: FailureKind; retryAfterMs?: number } {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    failure?: { status?: unknown; providerRetryAfterMs?: unknown }
  }
  const status = typeof failure.failure?.status === 'number' ? failure.failure.status : 0
  const retryAfterMs = typeof failure.failure?.providerRetryAfterMs === 'number'
    && Number.isFinite(failure.failure.providerRetryAfterMs)
    ? failure.failure.providerRetryAfterMs
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  const kind = status === 0 ? 'transport' : kindOfStatus(status, message)
  return retryAfterMs === undefined ? { kind } : { kind, retryAfterMs }
}

/** 在 `ctx.llm` 上注册 AgnesCode 路由（幂等）。 */
export function registerAgnescodeLlm(ctx: Context, options: AgnescodeAdapterOptions): AgnescodeAdapter {
  const adapter = new AgnescodeAdapter(options)
  registerAdapterIdempotent(ctx.llm, [(options.product ?? AGNESCODE).id], adapter)
  return adapter
}
