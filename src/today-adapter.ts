/**
 * Today（`today` / `todayintl`）LLM 适配器。
 *
 * 将 DSH 的 `GenerateOptions` 转成 Today 私有轮询协议，并按 `StreamChunk` 流式输出。
 *
 * @module src/today-adapter.ts
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
import { isAbortLike } from './aggregate-adapter.js'
import { buildDsmlSystemPrompt, type DsmlToolSpec } from './dsml.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { createModelCatalog, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { collectImages, serializeMessages } from './openai-compat.js'
import { createDsmlMarkerNormalizer, resolveEmptyResponseReason } from './sse.js'
import { reportLedgerAccount } from './token-ledger.js'
import {
  TODAY,
  TODAY_KNOWN_MODELS,
  resolveTodayModelEntry,
  type TodayModelEntry,
  type TodayProduct,
} from './today-product.js'
import {
  TodayUpstreamError,
  ensureTodayModelOption,
  fetchTodayPricingStatus,
  parseTodayModelsFromPricingStatus,
  pollTodayReply,
  sendTodayMessage,
  todayCredentialFingerprint,
  type TodayCredential,
} from './today.js'

const CATALOG_TTL_MS = 300_000
const WARM_THROTTLE_MS = 60_000

/** 单槽（账号 id + 解析后的 Today 凭据）。 */
export interface TodaySlot {
  readonly accountId: string
  readonly credential: TodayCredential
}

export interface TodayAdapterOptions {
  product?: TodayProduct
  slots: (modelId?: string) => Promise<readonly TodaySlot[]>
  accountPool?: AccountPool
  markLimited?: (accountId: string, modelId: string, resetAtMs: number) => Promise<void>
  warn?: (message: string) => void
  fetchImpl?: typeof fetch
}

interface CatalogCacheEntry {
  at: number
  accountId: string
  credentialKey: string
  entries: readonly CatalogEntry[]
  failed: boolean
}

function toCatalogEntry(model: TodayModelEntry): CatalogEntry {
  return {
    id: model.id,
    name: model.name,
    inputModalities: ['text'] as const,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }
}

function hasImages(messages: readonly { content: unknown }[]): boolean {
  const refs = new Map<string, unknown>()
  for (const message of messages) {
    if (Array.isArray(message.content)) collectImages(message.content, refs)
  }
  return refs.size > 0
}

function contentToPlainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const raw of content) {
    if (typeof raw === 'string') {
      parts.push(raw)
      continue
    }
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as Record<string, unknown>
    const t = typeof block.type === 'string' ? block.type : ''
    if (t === '' || t === 'text' || t === 'input_text' || t === 'output_text') {
      if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * 将 DSH 会话消息与可选工具定义拼装成 Today 单轮文本提示词。
 *
 * Today 上游 `/v1/messages` 无 system role 与原生 tool role，需按分段标签线性拼接；
 * 当请求携带 `tools` 时，将工具 schema 通过 DSML system 提示注入给模型。
 */
export function buildTodayPrompt(options: Pick<GenerateOptions, 'messages' | 'system' | 'tools'>): string {
  const serialized = serializeMessages(
    options.messages as readonly { role: string; content: unknown }[],
  )
  const systems: string[] = []
  if (typeof options.system === 'string' && options.system.trim().length > 0) {
    systems.push(options.system.trim())
  }
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    const dsmlTools: DsmlToolSpec[] = options.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
    systems.push(buildDsmlSystemPrompt(dsmlTools))
  }

  const turns: Array<{ label: string; text: string }> = []
  for (const msg of serialized) {
    const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : 'user'
    let text = contentToPlainText(msg.content)

    if (role === 'assistant' && Array.isArray((msg as { tool_calls?: unknown }).tool_calls)) {
      const toolCalls = (msg as { tool_calls: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls
      const callSummary = toolCalls
        .map((tc) => `[调用工具 ${tc.function?.name ?? 'unknown'}: ${tc.function?.arguments ?? '{}'}]`)
        .join('\n')
      text = [text, callSummary].filter((s) => s.length > 0).join('\n')
    }

    if (role === 'system' || role === 'developer') {
      if (text.trim().length > 0) systems.push(text.trim())
      continue
    }
    if (role === 'assistant') {
      if (text.trim().length > 0) turns.push({ label: '助手', text })
      continue
    }
    if (role === 'tool') {
      if (text.trim().length > 0) turns.push({ label: '工具结果', text })
      continue
    }
    if (text.trim().length > 0) {
      turns.push({ label: '用户', text })
    }
  }

  if (turns.length === 0) {
    return systems.join('\n\n')
  }

  const chunks: string[] = []
  if (systems.length > 0) {
    chunks.push(`[系统指令]\n${systems.join('\n\n')}`)
  }
  if (turns.length > 1) {
    const historyLines = turns.slice(0, -1).map((t) => `${t.label}：${t.text}`).join('\n')
    chunks.push(`[历史对话]\n${historyLines}\n[当前消息]\n${turns[turns.length - 1]!.text}`)
  } else {
    chunks.push(turns[0]!.text)
  }
  return chunks.join('\n\n').trim()
}

type FailureKind = 'auth' | 'rate_limit' | 'quota' | 'server' | 'transport' | 'invalid_request'

function classifyTodayError(error: unknown): { kind: FailureKind; retryAfterMs?: number; status?: number } {
  if (error instanceof TodayUpstreamError) {
    const s = error.status
    const retry = error.retryAfterMs
    if (s === 401 || s === 403) return { kind: 'auth', status: s }
    if (s === 429) return { kind: 'rate_limit', status: s, ...(retry !== undefined ? { retryAfterMs: retry } : {}) }
    if (s === 402) return { kind: 'quota', status: s, ...(retry !== undefined ? { retryAfterMs: retry } : {}) }
    if (s === 400 || s === 404 || s === 422) return { kind: 'invalid_request', status: s }
    if (s >= 500) return { kind: 'server', status: s }
    return { kind: 'transport', status: s }
  }
  return { kind: 'transport' }
}

/** Today LLM 适配器。 */
export class TodayAdapter extends LlmAdapter {
  private readonly product: TodayProduct
  private readonly skeletonCatalog: ModelCatalog
  private lastCatalog: CatalogCacheEntry[] = []
  private warming?: Promise<void>
  private lastWarmAt = 0
  private lastCatalogFailAt = 0

  constructor(private readonly options: TodayAdapterOptions) {
    super()
    this.product = options.product ?? TODAY
    this.skeletonCatalog = createModelCatalog(
      this.options.accountPool === undefined ? {} : { accountPool: this.options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
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

  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[] {
    return this.skeletonCatalog.listAllModels()
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entries = await this.catalog()
    const matched = entries.find((item) => item.id === model)
    const known = TODAY_KNOWN_MODELS.find((m) => m.id === model || m.optionId === model || `model.${m.id}` === model)
    const contextWindow = matched?.contextWindow ?? known?.contextWindow
    const maxTokens = matched?.maxTokens ?? known?.maxTokens
    return {
      provider,
      id: model,
      name: matched?.name ?? known?.name ?? model,
      inputModalities: ['text'] as const,
      ...(typeof contextWindow === 'number' && contextWindow > 0 ? { context: { contextWindow } } : {}),
      ...(typeof maxTokens === 'number' && maxTokens > 0 ? { defaultMaxTokens: maxTokens } : {}),
    }
  }

  async prepareCall(provider: string, model: string): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return { model: await this.resolveModel(provider, model), stream: (o) => this.stream(o) }
  }

  async refreshCatalog(): Promise<readonly CatalogEntry[]> {
    return await this.catalog()
  }

  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    const slots = await this.options.slots()
    if (slots.length === 0) return []
    return await this.catalog()
  }

  private syncCatalogEntries(): readonly CatalogEntry[] {
    const seen = new Set<string>()
    const merged: CatalogEntry[] = []
    for (const cached of this.lastCatalog) {
      if (cached.failed) continue
      for (const entry of cached.entries) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        merged.push(entry)
      }
    }
    if (merged.length > 0) return merged
    void this.warmCatalog()
    return TODAY_KNOWN_MODELS.map(toCatalogEntry)
  }

  private async warmCatalog(): Promise<void> {
    if (this.warming !== undefined) return
    const lastAttemptAt = Math.max(this.lastWarmAt, this.lastCatalogFailAt)
    if (Date.now() - lastAttemptAt < WARM_THROTTLE_MS) return
    this.lastWarmAt = Date.now()
    this.warming = (async () => {
      try {
        await this.catalog()
      } catch {
        // 预热失败静默
      } finally {
        this.warming = undefined
      }
    })()
    await this.warming
  }

  private async catalog(): Promise<readonly CatalogEntry[]> {
    const slots = await this.options.slots()
    if (slots.length === 0) return []
    const now = Date.now()
    const merged: CatalogEntry[] = []
    const seen = new Set<string>()
    const nextCache: CatalogCacheEntry[] = []
    let anyFailed = false
    const fetcher = this.options.fetchImpl ?? globalThis.fetch

    for (const slot of slots) {
      const credentialKey = todayCredentialFingerprint(slot.credential.cookie_raw)
      const cached = this.lastCatalog.find((item) => item.accountId === slot.accountId
        && item.credentialKey === credentialKey)
      if (cached !== undefined && now - cached.at < (cached.failed ? WARM_THROTTLE_MS : CATALOG_TTL_MS)) {
        nextCache.push(cached)
        if (cached.failed) { anyFailed = true; continue }
        for (const entry of cached.entries) {
          if (seen.has(entry.id)) continue
          seen.add(entry.id)
          merged.push(entry)
        }
        continue
      }

      try {
        const status = await fetchTodayPricingStatus(slot.credential, this.product, { fetcher })
        const models = parseTodayModelsFromPricingStatus(status)
        const entries = models.map(toCatalogEntry)
        nextCache.push({ at: Date.now(), accountId: slot.accountId, credentialKey, entries, failed: false })
        for (const entry of entries) {
          if (seen.has(entry.id)) continue
          seen.add(entry.id)
          merged.push(entry)
        }
      } catch {
        nextCache.push({ at: Date.now(), accountId: slot.accountId, credentialKey, entries: [], failed: true })
        anyFailed = true
      }
    }

    this.lastCatalog = nextCache
    if (anyFailed) this.lastCatalogFailAt = now
    return merged.length > 0 ? merged : TODAY_KNOWN_MODELS.map(toCatalogEntry)
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const slots = await this.options.slots(options.model)
    if (slots.length === 0) {
      throw new LlmError(
        `${this.product.id}: 没有可用账号。请在 Jet Hub 的「${this.product.displayName}」面板粘贴浏览器 Cookie 登录。`,
        'MISSING_CREDENTIAL',
      )
    }

    if (hasImages(options.messages)) {
      throw new LlmError(
        `${this.product.id}: 模型 "${options.model}" 不支持图片输入（Today 上游仅接受文本）`,
        'UNSUPPORTED_CONTENT',
      )
    }

    const modelEntry = resolveTodayModelEntry(options.model)
    if (modelEntry === undefined) {
      throw new LlmError(`${this.product.id}: 无效的模型 id "${options.model}"`, 'BAD_REQUEST')
    }

    const prompt = buildTodayPrompt(options)
    if (prompt.length === 0) {
      throw new LlmError(`${this.product.id}: 请求消息内容为空`, 'BAD_REQUEST')
    }

    const tried = new Set<string>()
    const limited: string[] = []
    for (;;) {
      const slot = slots.find((s) => !tried.has(s.accountId))
      if (slot === undefined) {
        throw new LlmError(
          `${this.product.id}: 所有账号均受限${limited.length > 0 ? `（${limited.join('、')}）` : ''}`,
          'QUOTA_EXCEEDED',
        )
      }
      tried.add(slot.accountId)
      reportLedgerAccount(this.product.id, slot.accountId)

      let delivered = false
      try {
        for await (const chunk of this.streamVia(slot, modelEntry, prompt, options.signal)) {
          delivered = true
          yield chunk
        }
        return
      } catch (error) {
        if (delivered) throw error
        if (isAbortLike(error, options.signal)) throw error

        const classified = classifyTodayError(error)
        const wrapped = this.toLlmError(error, classified.kind, classified.status, classified.retryAfterMs)

        if (classified.kind === 'invalid_request') {
          throw wrapped
        }
        if (classified.kind === 'auth') {
          if (tried.size >= slots.length) throw wrapped
          limited.push(`${slot.accountId}(认证失败)`)
          continue
        }
        if (classified.kind === 'server' || classified.kind === 'transport') {
          this.options.warn?.(`${this.product.id}: 账号 ${slot.accountId} ${classified.kind}，换下一个`)
          if (tried.size >= slots.length) throw wrapped
          continue
        }

        // rate_limit / quota：写入冷却并换下一个账号
        const defaultCooldown = classified.kind === 'quota' ? 5 * 60_000 : 60_000
        const resetAtMs = classified.retryAfterMs !== undefined
          ? Date.now() + Math.max(0, Math.min(classified.retryAfterMs, 30 * 60_000))
          : Date.now() + defaultCooldown
        await this.options.markLimited?.(slot.accountId, options.model, resetAtMs)
        limited.push(`${slot.accountId}(${classified.kind})`)
        if (tried.size >= slots.length) throw wrapped
      }
    }
  }

  private toLlmError(error: unknown, kind: FailureKind, status?: number, retryAfterMs?: number): LlmError {
    if (error instanceof LlmError) return error
    const msg = error instanceof Error ? error.message : String(error)
    const code = kind === 'auth'
      ? 'AUTH'
      : kind === 'rate_limit'
        ? 'RATE_LIMIT'
        : kind === 'quota'
          ? 'QUOTA_EXCEEDED'
          : kind === 'invalid_request'
            ? 'BAD_REQUEST'
            : 'SERVER'
    const suffix = kind === 'auth'
      ? `（Cookie 可能已过期，请在「${this.product.displayName}」面板更新 Cookie）`
      : ''
    return new LlmError(`${this.product.id}: ${msg}${suffix}`, code, {
      ...(status !== undefined ? { status } : {}),
      ...(retryAfterMs !== undefined && retryAfterMs > 0 ? { providerRetryAfterMs: retryAfterMs } : {}),
    })
  }

  private async *streamVia(
    slot: TodaySlot,
    modelEntry: TodayModelEntry,
    prompt: string,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const fetcher = this.options.fetchImpl ?? globalThis.fetch
    const reqOpts = { fetcher, ...(signal ? { signal } : {}) }

    await ensureTodayModelOption(slot.credential, this.product, modelEntry.optionId, reqOpts)
    const threadId = await sendTodayMessage(slot.credential, this.product, prompt, reqOpts)

    // 通过异步队列在轮询过程中实时吐出增量分片
    const queue: string[] = []
    let notify: (() => void) | undefined
    let finished = false
    let pollError: unknown
    let fullText = ''

    const wake = () => {
      if (notify !== undefined) {
        const fn = notify
        notify = undefined
        fn()
      }
    }

    const pollTask = pollTodayReply(slot.credential, this.product, threadId, {
      ...reqOpts,
      onDelta: (delta) => {
        if (delta.length > 0) {
          queue.push(delta)
          wake()
        }
      },
    }).then(
      (text) => {
        fullText = text
        finished = true
        wake()
      },
      (err) => {
        pollError = err
        finished = true
        wake()
      },
    )

    const dsmlFix = createDsmlMarkerNormalizer()
    let started = false
    let rawEmittedLen = 0
    let emittedText = ''
    const blockIndex = 0

    for (;;) {
      while (queue.length > 0) {
        const delta = queue.shift()!
        rawEmittedLen += delta.length
        const fixed = dsmlFix.push(delta)
        if (fixed.length === 0) continue
        if (!started) {
          started = true
          yield { type: 'block-start', index: blockIndex, blockType: 'text' }
        }
        emittedText += fixed
        yield { type: 'text-delta', index: blockIndex, text: fixed }
      }
      if (finished) break
      await new Promise<void>((resolve) => { notify = resolve })
    }

    await pollTask
    if (pollError !== undefined) throw pollError

    if (fullText.length > rawEmittedLen) {
      const rest = fullText.slice(rawEmittedLen)
      rawEmittedLen = fullText.length
      const fixed = dsmlFix.push(rest)
      if (fixed.length > 0) {
        if (!started) {
          started = true
          yield { type: 'block-start', index: blockIndex, blockType: 'text' }
        }
        emittedText += fixed
        yield { type: 'text-delta', index: blockIndex, text: fixed }
      }
    }

    const tail = dsmlFix.flush()
    if (tail.length > 0) {
      if (!started) {
        started = true
        yield { type: 'block-start', index: blockIndex, blockType: 'text' }
      }
      emittedText += tail
      yield { type: 'text-delta', index: blockIndex, text: tail }
    }

    if (started) {
      yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: emittedText } }
    }

    const reason = resolveEmptyResponseReason({ kind: 'stop' }, started ? 1 : 0)
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason }
  }
}

/** 在 `ctx.llm` 上注册 Today 路由（幂等）。 */
export function registerTodayLlm(ctx: Context, options: TodayAdapterOptions): TodayAdapter {
  const adapter = new TodayAdapter(options)
  registerAdapterIdempotent(ctx.llm, [(options.product ?? TODAY).id], adapter)
  return adapter
}
