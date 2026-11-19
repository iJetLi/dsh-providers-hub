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
import { AGNESCODE, agnescodeDisplayName, agnescodeFallbackModels, agnescodeIsFree, agnescodeSubscriptionNote, type AgnescodeModelEntry, type AgnescodeProduct } from './agnescode-product.js'
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

/** 后台预热的节流窗口（同一实例 60s 内最多试一次）。 */
const WARM_THROTTLE_MS = 60_000

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
  /** 正在进行的预热（反重入；见 {@link warmCatalog} 的两道闸门）。 */
  private warming?: Promise<void>
  /** 上一次预热开始时刻（节流）。 */
  private lastWarmAt = 0
  /** 上一次目录拉取失败时刻（失败也节流，避免过期凭据被反复重打）。 */
  private lastCatalogFailAt = 0

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
   *
   * ⚠️ **必须委托给骨架**（2026-11-19 自查）：本方法原先自己从 `lastCatalog`
   * 重新摊一遍，**丢掉了 `isFree`**（骨架那份是 `{id, name, isFree?}`，
   * 而 Jet Hub 的免费桶只认该字段）；同时那也是「一判据两份实现」——
   * 骨架的 `cached ?? syncCatalog()` 与本地的 `lastCatalog` 迟早会分叉。
   * 语义完全一致（骨架的 `cached` 就是本适配器 `loadCatalog()` 的产物，
   * 未暖时回落到 `syncCatalogEntries()`，同样会触发一次受节流的预热）。
   */
  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[] {
    return this.skeletonCatalog.listAllModels()
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
    return this.fallbackEntries()
  }

  /** 兜底目录（本家**刻意留空**，见 `agnescode-product.ts`）。 */
  private fallbackEntries(): readonly CatalogEntry[] {
    return agnescodeFallbackModels(this.product).map(toCatalogEntry)
  }

  /**
   * 后台预热一次目录；失败静默（没有账号时本来就不该有目录）。
   *
   * ⚠️⚠️ 两道闸门缺一不可（2026-11-19 提交前自查）：
   *   1. **反重入**（`warming`）：`syncCatalogEntries()` 会触发本函数，而它自己
   *      又是 `catalog()` 的失败回落（本次已把那条回落改成直接返回兜底表，
   *      但闸门必须留着 —— 否则任何一次「预热里再触发预热」的接线改动都会
   *      重新变成自激）；
   *   2. **节流**（`lastWarmAt` / `lastCatalogFailAt`）：`listAllModels()` 是同步
   *      接口、每次调用都会触发预热 ⇒ 面板刷新快时会连打上游；失败的目录同样
   *      要吃掉 60s 窗口，否则凭据过期时等于拿插件当压测工具。
   *
   * 自激的具体形态（已实测）：预热 → `catalog()` → 拉失败 → 回落 → 预热 → …
   * 每轮一次 HTTP、永不停止，而用户看到的现象只是「面板卡」。
   */
  private async warmCatalog(): Promise<void> {
    if (this.warming !== undefined) return
    // 成功与失败共用同一个节流窗口：刚失败过的目录不在一分钟内重打上游
    //（凭据过期的形态下，否则等于拿插件当压测工具）。
    const lastAttemptAt = Math.max(this.lastWarmAt, this.lastCatalogFailAt)
    if (Date.now() - lastAttemptAt < WARM_THROTTLE_MS) return
    this.lastWarmAt = Date.now()
    this.warming = (async () => {
      try {
        await this.catalog()
      } catch {
        // 预热失败不值得打扰用户。
      } finally {
        this.warming = undefined
      }
    })()
    await this.warming
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
      const entries: CatalogEntry[] = remote.map(toCatalogEntry)
      this.lastCatalog = { at: Date.now(), bffBase: base, entries }
      return entries
    }
    // ⚠️ 这里**不能再走** `syncCatalogEntries()`：那会触发一次预热，而本次调用
    //    本身就是预热（失败时构成无限自激）。直接回兜底表（本家是空表）。
    // 同时记下失败时刻：预热路径据此节流（失败的目录在 60s 内不重打上游）。
    this.lastCatalogFailAt = Date.now()
    return this.fallbackEntries()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const slots = await this.options.slots(options.model)
    if (slots.length === 0) {
      throw new LlmError(
        `${this.product.id}: 没有可用账号。请在 Jet Hub 的 ${this.product.displayName} 面板`
        + '点「导入本机登录态」（需要先在本机安装并登录 AgnesCode 桌面端）。',
        'MISSING_CREDENTIAL',
      )
    }

    // ⚠️ 带图请求在**进池循环之前**就拒掉：图片支持与账号无关，放在循环里会让
    //    每个槽都被白试一遍（`failureInfoOf` 对无 `status` 的错误归 `transport`
    //    ⇒ 换号重试），最终仍是同一句「不支持图片」，只是白打整池。
    if (hasImages(options.messages)) {
      throw new LlmError(
        `${this.product.id}: 模型 "${options.model}" 不支持图片输入（AgnesCode 目录只声明文本模态）`,
        'UNSUPPORTED_CONTENT',
      )
    }

    const tried = new Set<string>()
    const limited: string[] = []
    for (;;) {
      const slot = slots.find((s) => !tried.has(s.accountId))
      if (slot === undefined) {
        throw new LlmError(
          `${this.product.id}: 所有账号对该模型均受限${limited.length > 0 ? `（${limited.join('、')}）` : ''}`,
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
        // 权益不足（403 `subscription_required`）：换号**没有任何用**（同一个订阅档
        // 每个账号都一样），而且换号会把真实的「请升级订阅」淹没成「所有账号受限」。
        if (failure.kind === 'entitlement') throw error
        if (failure.kind === 'auth') {
          if (tried.size >= slots.length) throw error
          limited.push(`${slot.accountId}(认证失败)`)
          continue
        }
        if (failure.kind === 'server' || failure.kind === 'transport') {
          // 上游故障/网络问题：不写标记，只换下一个；槽耗尽时抛**原始错误**，
          // 否则单账号用户看到的是误导性的「额度用尽」。
          this.options.warn?.(`${this.product.id}: 账号 ${slot.accountId} ${failure.kind}，换下一个`)
          if (tried.size >= slots.length) throw error
          continue
        }
        // 限流 / 额度：标记该槽后换下一个。
        //
        // ⚠️ 「每日请求量」与普通限流**不是**同一个冷却量级（2026-11-19 真机：
        //    免费模型回 `429 daily_requests limit exceeded`）：按 60s 标记等于
        //    每分钟重撞同一面日墙。日墙按「次日 0 点」记；上游若同时给了
        //    `retry-after`，取两者更大的那个（上游口径优先）。
        const resetAtMs = failure.daily === true
          ? Math.max(agnescodeDailyResetAtMs(), Date.now() + (failure.retryAfterMs ?? 0))
          : failure.retryAfterMs !== undefined
            ? Date.now() + Math.max(0, Math.min(failure.retryAfterMs, 30 * 60_000))
            : Date.now() + 60_000
        await this.options.markLimited?.(slot.accountId, options.model, resetAtMs)
        limited.push(`${slot.accountId}(${failure.kind})`)
      }
    }
  }

  /** 指定槽发一次请求。 */
  private async *streamVia(slot: AgnescodeSlot, options: GenerateOptions): AsyncIterable<StreamChunk> {
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
      throw new LlmError(
        `${this.product.id}: 凭据里的 BFF base 未通过 origin 钉扎，请重新导入登录态`,
        'AUTH',
      )
    }
    const response = await this.fetchChat(
      `${base}/chat/completions`,
      { ...agnescodeHeaders(slot.credential), Accept: 'text/event-stream' },
      JSON.stringify(payload),
      options.signal,
    )
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
              // ⚠️ 权益不足必须用 `PERMISSION`，**不能**用 `AUTH`：宿主会把 `AUTH`
              //    的报文整条换成「API 密钥无效」，而「该模型需要更高订阅」这句
              //    恰恰是唯一出路（Issue IKLBSH 的复发形态）。
              : kind === 'entitlement'
                ? 'PERMISSION'
                : httpErrorCode(response.status)
      throw new LlmError(
        `${this.product.id}: HTTP ${response.status} — ${text.slice(0, 300)}`
        // ⚠️ 「重新登录」这条指路**只对真·认证失败**有效。403 的权益不足挂上它
        //    就是把人引向一个必然无效的动作（实测 `subscription_required`）。
        + `${kind !== 'auth'
          ? ''
          : '（会话可能已过期：请在本机重新登录 AgnesCode 桌面端，再点「导入本机登录态」）'}`,
        code,
        {
          status: response.status,
          // ⚠️ `providerRetryAfterMs` 在 `LlmError` 里被校验为 **> 0**：
          //    上游回 `retry-after: 0` 时传 0 会让构造函数自己抛校验错，
          //    把一个正常的 429 变成一条与真因无关的崩溃。
          ...retryAfterMs === undefined || retryAfterMs <= 0 ? {} : { providerRetryAfterMs: retryAfterMs },
        },
      )
    }
    // ⚠️ content-type 闸门：网关回 200 + HTML（风控页 / 登录墙）时若直接喂给
    //    SSE 解帧器，会解析出零帧 ⇒ 抛 EMPTY_RESPONSE ⇒ 归为传输错误 ⇒ 白打整池。
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const peek = await response.text().catch(() => '')
      throw new LlmError(
        `${this.product.id}: 上游未返回事件流（content-type: ${contentType || '(空)'}）`
        + `${peek === '' ? '' : `；服务端原文：${peek.slice(0, 200)}`}`,
        'SERVER',
        { status: response.status },
      )
    }
    yield* consumeOpenAiSse(
      response,
      options.signal !== undefined ? { signal: options.signal } : {},
      {
        label: this.product.id,
        firstTokenTimeoutMs: this.product.fetchTimeoutMs,
        chunkTimeoutMs: this.product.fetchTimeoutMs,
        ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      },
    )
  }

  /**
   * 发推理请求：出口走注入的 `fetchImpl`，且**只对「等响应头」这一段**设上限。
   *
   * ⚠️ 为什么必须两件事一起做（2026-11-19 自查）：
   *   1. 选项注释承诺「目录 / 余额 / 推理共用」`fetchImpl`，而推理腿原先直接用
   *      全局 `fetch` ⇒ 注释与实现不一致，且推理路径在单测里**无法拦截**
   *     （本仓红线：注释必须与实际一致）；
   *   2. `product.fetchTimeoutMs` 此前只喂给 `consumeOpenAiSse` 的
   *      `firstTokenTimeoutMs`，而那是**拿到响应头之后**的空闲超时 ⇒「等头」这段
   *      没人负责，只能吃 undici 默认（约 300s）：网关卡在排队时用户看到的是
   *      「永远转圈」（magicrew 的同型修法）。
   *
   * ⚠️ 拿到头**立即** `clearTimeout`：这条定时器只管等头，绝不能误杀后面的长回答。
   */
  private async fetchChat(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const fetcher = this.options.fetchImpl ?? globalThis.fetch
    const headerController = new AbortController()
    const headerTimer = setTimeout(
      () => headerController.abort(
        new LlmError(`${this.product.id}: 等待响应头超时（上游 BFF 可能正在排队）`, 'TIMEOUT'),
      ),
      this.product.fetchTimeoutMs,
    )
    try {
      return await fetcher(url, {
        method: 'POST',
        headers,
        body,
        signal: signal === undefined
          ? headerController.signal
          : AbortSignal.any([signal, headerController.signal]),
      })
    } catch (error) {
      // ⚠️ 只有**本控制器**超时才改写错误；调用方 abort 必须原样冒泡
      //    （否则「用户点了停止」会被报成「上游超时」）。
      if (headerController.signal.aborted) throw headerController.signal.reason
      throw error
    } finally {
      clearTimeout(headerTimer)
    }
  }
}

/**
 * 目录条目 → 骨架条目（**唯一**一处映射，远端与兜底共用）。
 *
 * ⚠️ 必须只有一份：倍率后缀 / 免费标记 / 订阅说明三条判据各自都在这里，
 * 远端与兜底各写一遍就会「远端显示 x6.00、兜底显示原名」这种同数据两套口径
 *（本仓已因「一判据两份实现」吃过多次亏）。
 */
function toCatalogEntry(model: AgnescodeModelEntry): CatalogEntry {
  const free = agnescodeIsFree(model)
  const note = agnescodeSubscriptionNote(model)
  return {
    id: model.id,
    name: agnescodeDisplayName(model),
    inputModalities: ['text'] as const,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(free === undefined ? {} : { isFree: free }),
    ...(note === undefined ? {} : { description: note }),
  }
}

/** 消息里是否有图片附件。 */function hasImages(messages: readonly { content: unknown }[]): boolean {
  const refs = new Map<string, unknown>()
  for (const message of messages) {
    if (Array.isArray(message.content)) collectImages(message.content, refs)
  }
  return refs.size > 0
}

/** 状态码 + 报文 → 语义类别。 */
type FailureKind =
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'context_window'
  | 'invalid_request'
  /** 账号权益不够（403 `subscription_required`）：换号无用、也没有「重新登录」这条路。 */
  | 'entitlement'
  | 'server'
  | 'transport'

function kindOfStatus(status: number, text: string): FailureKind {
  if (status === 401) return 'auth'
  // ⚠️ 403 有**两种完全不同的语义**（2026-11-19 真机取证）：
  //    - 会话失效 ⇒ 重新登录有用；
  //    - `subscription_required`（「该模型需要更高权益解锁，请升级订阅后使用」）⇒ 换号
  //      和重新登录**都没用**，用户要做的只有升级订阅。
  //    旧实现一律归 `auth` ⇒ 白轮整池 + 错误尾部还挂着「会话可能已过期，请重新登录」
  //    这条**错误指路**（本仓红线：文案本身就是出路时不能给错）。
  if (status === 403) return entitlementText(text) ? 'entitlement' : 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 402) return 'quota'
  if (status >= 500) return 'server'
  if (contextOverflowText(text)) return 'context_window'
  return 'invalid_request'
}

/** 403 报文里是否在说「权益/订阅」而不是「凭据」。 */
function entitlementText(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('subscription_required')
    || lower.includes('subscription required')
    || lower.includes('upgrade')
    || text.includes('升级订阅')
    || text.includes('权益')
}

/**
 * 「每日请求量」限流的报文判据。
 *
 * ⚠️ 实测（2026-11-19 真机）：免费模型 `agnes-3.0-flash` 回
 * `429 {"code":"rate_limit_exceeded","message":"daily_requests limit exceeded"}`。
 * 这一条与普通限流的**冷却时长差两个数量级**：按 60s 处理 ⇒ 用户每分钟被劝一次
 * 「再试」，每次都撞同一面日墙（而日墙要到次日 0 点才开）。
 */
function dailyLimitText(text: string): boolean {
  const lower = text.toLowerCase()
  return (lower.includes('daily') && lower.includes('limit'))
    || lower.includes('每日')
    || lower.includes('今日')
}

/**
 * 下一次「当地 0 点」的时刻（毫秒）。
 *
 * ⚠️ 用 UTC+8：本家两站都是国内平台的日窗口，而本仓对「当日额度」的既有口径
 * 正是 UTC+8 的 24:00（`loomyCooldownResetAtMs` / qoder 的当日限流标记同款）。
 * ⚠️ 这是**推断**不是取证：上游只说 `daily`，没有给 reset 时间戳也没有
 * `retry-after`。取「次日 0 点」是最不坏的一条（比 60s 真实、比 24h 精确）。
 */
function agnescodeDailyResetAtMs(now = Date.now()): number {
  const OFFSET_MS = 8 * 3_600_000
  const shanghaiNow = now + OFFSET_MS
  const nextMidnight = (Math.floor(shanghaiNow / 86_400_000) + 1) * 86_400_000
  return nextMidnight - OFFSET_MS
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

/**
 * 从抛出的错误里还原语义（先看 `failure.status`，**再看 `failure.code`**，最后看报文）。
 *
 * ⚠️ 为什么必须认 `code`（2026-11-19 二次自查）：SSE 解帧器抛的错误（额度耗尽、
 * 上下文超限）**没有 HTTP `status`** —— 只看 status 会把它们一律归 `transport`：
 * - 429/额度类 ⇒ 白轮一遍池子，且**不写**冷却（下次请求照旧撞同一面墙）；
 * - 上下文超限 ⇒ 同样白轮，而它换号**根本无用**（同一个请求对谁都太大）。
 * 宿主的溢出压缩只认 `CONTEXT_WINDOW_EXCEEDED` 这个码，所以这里的归类错会让
 * 唯一有效的动作（压缩重试）被掩盖（qiniu / gemini 的同型修法）。
 */
function failureInfoOf(error: unknown): { kind: FailureKind; retryAfterMs?: number; daily?: boolean } {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    failure?: { status?: unknown; providerRetryAfterMs?: unknown; code?: unknown }
  }
  const status = typeof failure.failure?.status === 'number' ? failure.failure.status : 0
  const retryAfterMs = typeof failure.failure?.providerRetryAfterMs === 'number'
    && Number.isFinite(failure.failure.providerRetryAfterMs)
    ? failure.failure.providerRetryAfterMs
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  const failureCode = typeof failure.failure?.code === 'string' ? failure.failure.code : ''
  const kind = status !== 0
    ? kindOfStatus(status, message)
    : failureCode === CONTEXT_WINDOW_EXCEEDED_CODE
      ? 'context_window'
      : failureCode === 'QUOTA_EXCEEDED' || failureCode === 'RATE_LIMIT'
        ? 'rate_limit'
        : failureCode === 'AUTH'
          ? 'auth'
          : 'transport'
  // 「每日请求量」只对限流类有意义（其它类别不看这个标记）。
  const daily = kind === 'rate_limit' && dailyLimitText(message)
  return {
    kind,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(daily ? { daily } : {}),
  }
}

/** 在 `ctx.llm` 上注册 AgnesCode 路由（幂等）。 */
export function registerAgnescodeLlm(ctx: Context, options: AgnescodeAdapterOptions): AgnescodeAdapter {
  const adapter = new AgnescodeAdapter(options)
  registerAdapterIdempotent(ctx.llm, [(options.product ?? AGNESCODE).id], adapter)
  return adapter
}
