/**
 * 豆包（Doubao，字节跳动）模型适配器。
 *
 * ## 为什么有这个文件
 *
 * 上游把豆包登记成**纯签到渠道**（`provider-registry.ts` 的 `channel: false`），
 * 没有任何适配器 ⇒ 模型选择器里选不到豆包、也发不出消息。
 * 本适配器复用已有扫码登录会话，接入额度、模型目录与对话。
 *
 * ## 协议要点（详见 src/doubao-upstream.ts）
 *
 * - **目录**：POST /alice/slot/action_bar_v3/brief_list，`{bot_id, language_code}`；
 *   响应是一棵嵌套树，模型散在 `model_item_key` 节点里，按 key 去重。
 * - **对话**：POST /chat/completion，响应不是标准 SSE，
 *   是三行帧 `id:` / `event:` / `data:` + 空行；正文在 STREAM_CHUNK 的
 *   `patch_op[].patch_value` 及通知里，另有 `CHUNK_DELTA`；`10040` 下面的 `10000` 是思考文本。
 * - **路由**：`mode_id=1` + `agent_mode=2` = 普通对话；
 *   `mode_id=3` + `agent_mode=1` = 工作任务（会员付费额度）。
 *
 * ## 能力边界（不编造）
 *
 * 本适配器只声明 **文本输入**：没有实测豆包网页端的多模态上传路径，
 * 故 `inputModalities: ['text']`（明确否定），不谎报图片能力。
 * 工具调用同理：本适配器不向模型声明 tools，避免让模型「以为能调用」而实际不能。
 * 这两条是保守方向（少报能力），与仓库其它家的纪律一致。
 *
 * @module src/doubao-adapter.ts
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
import type { AccountPool } from './account-pool.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { contentToText } from './openai-compat.js'
import { createDsmlMarkerNormalizer } from './sse.js'
import { normalizeHarnessMessages, type HarnessMessageLike } from './message-shape.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { parseDoubaoCredential, type DoubaoCredential } from './doubao.js'
import {
  DOUBAO_BOT_ID,
  DOUBAO_BRIEF_LIST_PATH,
  DOUBAO_CHAT_PATH,
  DOUBAO_HTTP_TIMEOUT_MS,
  DOUBAO_WEB_BASE_URL,
  doubaoHeaders,
  doubaoQuery,
  doubaoRemoteModels,
  doubaoTagSuffix,
  parseDoubaoEnvelope,
  type DoubaoRemoteModel,
} from './doubao-upstream.js'

/** provider id（必须是纯小写字母，registry 的要求）。 */
export const DOUBAO_PROVIDER = 'doubao'

/** 展示名。 */
export const DOUBAO_DISPLAY_NAME = '豆包（Doubao）'

/**
 * 兜底目录：2026-11-22 真机从 brief_list 抓到的 14 条。
 *
 * ⚠️ **只在远端读取失败时使用**，且这是快照（上游加模型后不会自动更新）。
 * 值来自实测响应，不是猜的。
 */
export const DOUBAO_FALLBACK_MODELS: readonly DoubaoRemoteModel[] = [
  { key: '0', name: '豆包 快速', modeId: '1', tags: [] },
  { key: '3', name: '豆包 专家', modeId: '1', tags: [] },
  { key: '9', name: '豆包 2.1 Auto', modeId: '3', tags: ['小额免费'] },
  { key: 'seed-lite-7b', name: '豆包 2.1 Lite', modeId: '3', tags: ['限时优惠 0.01x'] },
  { key: '5', name: '豆包 2.1 Pro', modeId: '3', tags: ['0.65x'] },
  { key: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', modeId: '3', tags: ['限时优惠 0.01x'], reasoning: { efforts: [{ id: '3', name: '低' }, { id: '4', name: '中' }, { id: '5', name: '高' }, { id: '6', name: '极高' }, { id: '7', name: '最高' }] } },
  { key: 'person-qwen4-max', name: 'Qwen 4 Max', modeId: '3', tags: ['新上线 0.47x'] },
  { key: 'person-kimi-k3-1-pro-261111', name: 'Kimi K3.1 Pro', modeId: '3', tags: ['0.95x'] },
  { key: 'person-kimi-k3-1-pro-highspeed-261111', name: 'Kimi K3.1 Pro 高速', modeId: '3', tags: ['1.44x'] },
  { key: 'person-kimi-k3-261111', name: 'Kimi K3', modeId: '3', tags: ['1.48x'] },
  { key: 'person-glm-5-3-261111', name: 'GLM 5.3', modeId: '3', tags: ['0.80x'] },
  { key: 'person-glm-5-3-flash-261111', name: 'GLM 5.3 Flash', modeId: '3', tags: ['0.08x'] },
  { key: 'person-deepseek-v4-pro-ga-260813', name: 'DeepSeek V4 Pro', modeId: '3', tags: ['0.46x'] },
  { key: 'person-qwen3-8-max', name: 'Qwen 3.8 Max', modeId: '3', tags: ['0.74x'] },
  { key: 'person-qwen3-8-flash', name: 'Qwen 3.8 Flash', modeId: '3', tags: ['0.05x'] },
]

/** 一个可用账号。 */
export interface DoubaoSlot {
  readonly accountId: string
  readonly credential: DoubaoCredential
}

/** 适配器构造选项。 */
export interface DoubaoAdapterOptions {
  readonly credentialRef: CredentialRef
  readonly slots: () => Promise<readonly DoubaoSlot[]>
  readonly accountPool?: AccountPool
  readonly onCatalogLoaded?: () => void
  readonly warn?: (message: string) => void
  /** 仅单测注入。 */
  readonly fetchImpl?: typeof fetch
}

/** 解析一个字节流为 ByteDance 三行帧的事件序列。 */
export interface DoubaoFrame {
  readonly event: string
  readonly data: string
}

/**
 * 逐帧解析 `id:` / `event:` / `data:` + 空行的变体流。
 *
 * ⚠️ 这是**纯函数**：把整段响应文本切帧，单测可以直接喂抓包样本。
 * 真机上 `data:` 可能是多行 JSON（prettified），这里按「一个事件块内所有
 * `data:` 行拼起来」处理，与浏览器 EventSource 的行为一致。
 */
export function parseDoubaoFrames(raw: string): readonly DoubaoFrame[] {
  const out: DoubaoFrame[] = []
  let event = ''
  let dataLines: string[] = []
  const flush = (): void => {
    if (event.length === 0 && dataLines.length === 0) return
    out.push({ event, data: dataLines.join('\n') })
    event = ''
    dataLines = []
  }
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '') { flush(); continue }
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    // id: 行不携带正文，忽略
  }
  flush()
  return out
}

/** Extract answer data from one standalone patch frame. */
export function doubaoTextDeltaOf(data: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(data) } catch { return '' }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const record = parsed as Record<string, unknown>
  const operations = Array.isArray(record.patch_op) ? record.patch_op : []
  let text = ''
  for (const operation of operations) {
    if (typeof operation !== 'object' || operation === null) continue
    const op = operation as Record<string, unknown>
    if (String(op.patch_object) === '111') continue
    for (const block of doubaoContentBlocks(op.patch_value)) {
      const content = block.content as { text_block?: { text?: unknown } } | null | undefined
      if (block.block_type === 10000 && typeof content?.text_block?.text === 'string') text += content.text_block.text
    }
  }
  return text
}

/**
 * 从一帧里抽业务错误码（流内错误也在 200 的响应里）。
 */
export function doubaoStreamErrorOf(data: string): { code: number; message: string } | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(data) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as { code?: unknown; msg?: unknown; message?: unknown }
  const code = typeof record.code === 'number' ? record.code : 0
  if (code === 0) return undefined
  const message = typeof record.message === 'string' ? record.message
    : typeof record.msg === 'string' ? record.msg : ''
  return { code, message: message.length > 0 ? message : 'code ' + code }
}

/** 模型 id → 上游 model_item_key + mode。 */
function resolveRemoteModel(model: string, catalog: readonly DoubaoRemoteModel[]): DoubaoRemoteModel {
  const found = catalog.find((m) => m.key === model)
  if (found !== undefined) return found
  // 目录外的 id 保守按「对话模式」处理（不发工作任务请求，避免误烧会员额度）。
  return { key: model, name: model, modeId: '1', tags: [] }
}

/** 构造对话请求体。 */
export function buildDoubaoChatBody(
  options: GenerateOptions,
  remote: DoubaoRemoteModel,
): string {
  const messages = normalizeHarnessMessages(options.messages as unknown as readonly HarnessMessageLike[])
  // 豆包网页端用 content_block 承载文本；把整段历史压成一条 user 消息。
  // ⚠️ 这会丢掉多轮角色边界，但是**保守方向**：不谎报协议不支持的能力。
  const parts: string[] = []
  if (options.system !== undefined) parts.push(contentToText(options.system))
  for (const message of messages) {
    const text = contentToText(message.content)
    if (text.length === 0) continue
    parts.push((message.role === 'assistant' ? ' assistant: ' : ' user: ') + text)
  }
  const prompt = parts.join('\n').trim()
  const isTask = remote.modeId === '3'
  const modeId = isTask ? '3' : '1'
  const agentMode = isTask ? 1 : 2
  const conversationMode = isTask ? 2 : 1
  let reasoningEffort = '4'
  let needDeepThink = 0
  if (options.reasoningEffort !== undefined) {
    const selected = String(options.reasoningEffort)
    if (!remote.reasoning?.efforts.some((item) => item.id === selected)) {
      throw new LlmError('豆包：该模型未声明所选思考档位 ' + selected, 'UNSUPPORTED_REASONING_EFFORT')
    }
    reasoningEffort = selected
    // 工作任务的上游开关是独立常量 10001，不是档位编号的偏移。
    needDeepThink = isTask ? 10001 : 3
  }
  return JSON.stringify({
    client_meta: {
      local_conversation_id: 'local_' + String(Date.now()),
      conversation_id: '',
      bot_id: DOUBAO_BOT_ID,
      last_section_id: '',
      last_message_index: null,
    },
    messages: [{
      local_message_id: 'msg_' + String(Date.now()),
      content_block: [{
        block_type: 10000,
        content: { text_block: { text: prompt, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
        block_id: 'blk_0',
        parent_id: '',
        meta_info: [],
        extra_info: {},
        append_fields: [],
      }],
      message_status: 0,
    }],
    option: {
      agent_mode: agentMode,
      need_deep_think: needDeepThink,
      scene_type: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: remote.key, reasoning_effort: reasoningEffort, mode_id: modeId },
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_old_user: true,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
      model_config: { model_item_key: remote.key, model_extra_params: {}, reasoning_effort: reasoningEffort },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        conversation_mode: String(conversationMode),
        mode_id: modeId,
        model_item_key: remote.key,
        agent_mode: String(agentMode),
        reasoning_effort: reasoningEffort,
        provider_id: '',
      },
      conversation_mode: conversationMode,
      unique_key: 'uk_' + String(Date.now()),
    },
    user_context: [],
    ext: {
      agent_mode: String(agentMode),
      use_deep_think: String(needDeepThink),
      sub_conv_firstmet_type: '1',
      collection_id: '',
      is_finish: '1',
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: '0',
    },
  })
}

type DoubaoTextKind = 'reasoning' | 'text'

interface DoubaoAccumulatedBlock {
  readonly index: number
  readonly type: DoubaoTextKind
  text: string
}

function doubaoContentBlocks(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) doubaoContentBlocks(item, out)
    return out
  }
  if (typeof value !== 'object' || value === null) return out
  const record = value as Record<string, unknown>
  if (record.block_type === 10000 || record.block_type === 10040) {
    out.push(record)
    return out
  }
  for (const child of Object.values(record)) doubaoContentBlocks(child, out)
  return out
}

function doubaoBlockId(value: unknown): string | undefined {
  if ((typeof value === 'string' || typeof value === 'number') && String(value) !== '' && String(value) !== '0') return String(value)
  return undefined
}

/** Stream-local owner-aware accumulator for Doubao reasoning and answer blocks. */
class DoubaoTextTracker {
  private readonly thinkingHeaders = new Set<string>()
  private readonly blocks = new Map<DoubaoTextKind, DoubaoAccumulatedBlock>()
  private readonly owners = new Map<string, DoubaoTextKind>()
  private readonly upstreamText = new Map<string, string>()
  private readonly dsmlFix = createDsmlMarkerNormalizer()
  private readonly reasoningFix = createDsmlMarkerNormalizer()
  private hasAnswerText = false
  private current: { kind: DoubaoTextKind; id?: string } = { kind: 'text' }

  get hasAnswer(): boolean { return this.hasAnswerText }

  push(frame: DoubaoFrame): StreamChunk[] {
    if (frame.event !== 'STREAM_MSG_NOTIFY' && frame.event !== 'FULL_MSG_NOTIFY'
      && frame.event !== 'STREAM_CHUNK' && frame.event !== 'CHUNK_DELTA') return []
    let payload: unknown
    try { payload = JSON.parse(frame.data) } catch { return [] }
    if (typeof payload !== 'object' || payload === null) return []
    const record = payload as Record<string, unknown>
    const out: StreamChunk[] = []

    if (frame.event === 'STREAM_MSG_NOTIFY' || frame.event === 'FULL_MSG_NOTIFY') {
      const message = typeof record.message === 'object' && record.message !== null
        ? record.message as Record<string, unknown> : record
      if (String(message.user_type) === '1' || message.role === 'user') return out
      this.pushBlocks(doubaoContentBlocks(message.content ?? record.content), true, out)
    } else if (frame.event === 'STREAM_CHUNK') {
      const operations = Array.isArray(record.patch_op) ? record.patch_op : []
      for (const operation of operations) {
        if (typeof operation !== 'object' || operation === null) continue
        const op = operation as Record<string, unknown>
        if (String(op.patch_object) === '111') continue
        this.pushBlocks(doubaoContentBlocks(op.patch_value), false, out)
      }
    } else if (typeof record.text === 'string' && record.text.length > 0) {
      this.append(this.current.kind, record.text, this.current.id, out)
    }
    return out
  }

  flush(out: StreamChunk[]): void {
    this.emit('text', this.dsmlFix.flush(), out)
    this.emit('reasoning', this.reasoningFix.flush(), out)
  }

  *finish(): Iterable<StreamChunk> {
    for (const block of this.blocks.values()) {
      // DSH treats the final block as authoritative over the deltas.
      yield { type: 'block-end', index: block.index, block: { type: block.type, text: block.text } }
    }
  }

  private pushBlocks(blocks: readonly Record<string, unknown>[], snapshot: boolean, out: StreamChunk[]): void {
    // Known parent IDs are authoritative; a header carries status, never its own text.
    for (const block of blocks) {
      const id = doubaoBlockId(block.block_id)
      if (block.block_type === 10040 && id !== undefined) this.thinkingHeaders.add(id)
    }
    for (const block of blocks) {
      if (block.block_type !== 10000) continue
      const id = doubaoBlockId(block.block_id)
      const parentId = doubaoBlockId(block.parent_id)
      const previousOwner = id === undefined ? undefined : this.owners.get(id)
      const kind = parentId !== undefined && this.thinkingHeaders.has(parentId)
        ? 'reasoning' : previousOwner ?? 'text'
      if (id !== undefined) this.owners.set(id, kind)
      const content = block.content as { text_block?: { text?: unknown } } | null | undefined
      const text = content?.text_block?.text
      if (typeof text !== 'string') continue
      if (text.length === 0) {
        // A newly declared block can be empty before its first CHUNK_DELTA.
        // An empty status patch for a known block cannot retarget that delta.
        if (id !== undefined && previousOwner === undefined) this.current = { kind, id }
        continue
      }
      let delta = text
      if (id !== undefined) {
        const previous = this.upstreamText.get(id) ?? ''
        if (text.startsWith(previous)) delta = text.slice(previous.length)
        else if (snapshot || previous.startsWith(text)) continue
        // Inline patches can also contain a disjoint incremental fragment.
        // Anonymous legacy blocks have no replay identity; keep their old append semantics.
      }
      if (delta.length === 0) continue // A replay is not a new declaration.
      this.current = { kind, ...(id === undefined ? {} : { id }) }
      this.append(kind, delta, id, out)
    }
  }

  private append(kind: DoubaoTextKind, text: string, id: string | undefined, out: StreamChunk[]): void {
    if (text.length === 0) return
    if (kind === 'text') this.hasAnswerText = true
    if (id !== undefined) this.upstreamText.set(id, (this.upstreamText.get(id) ?? '') + text)
    const normalizer = kind === 'text' ? this.dsmlFix : this.reasoningFix
    this.emit(kind, normalizer.push(text), out)
  }

  private emit(kind: DoubaoTextKind, text: string, out: StreamChunk[]): void {
    if (text.length === 0) return
    let block = this.blocks.get(kind)
    if (block === undefined) {
      block = { index: this.blocks.size, type: kind, text: '' }
      this.blocks.set(kind, block)
      out.push({ type: 'block-start', index: block.index, blockType: kind })
    }
    block.text += text
    out.push(kind === 'reasoning'
      ? { type: 'reasoning-delta', index: block.index, text }
      : { type: 'text-delta', index: block.index, text })
  }
}

export class DoubaoAdapter extends LlmAdapter {
  private readonly options: DoubaoAdapterOptions
  private readonly catalogGate: RemoteCatalogGate
  private readonly catalog: ModelCatalog
  private remoteModels: readonly DoubaoRemoteModel[] = DOUBAO_FALLBACK_MODELS
  private remoteModelsLoaded = false

  constructor(options: DoubaoAdapterOptions) {
    super()
    this.options = options
    this.catalogGate = new RemoteCatalogGate(
      options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded },
    )
    this.catalog = createModelCatalog(
      options.accountPool === undefined ? {} : { accountPool: options.accountPool },
      {
        product: { id: DOUBAO_PROVIDER },
        // 磁盘的展示条目不含 modeId，不能用它声明随后无法路由的档位。
        diskCache: false,
        loadCatalog: () => this.loadCatalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
        unknownModelInputModalities: () => ['text'] as const,
        refresh: () => this.refreshRemoteModels(true),
      },
    )
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : DOUBAO_PROVIDER
    return { id, name: DOUBAO_DISPLAY_NAME }
  }

  /** 远端目录读取（失败时回退到实测快照，不让冷启动目录为空）。 */
  private async refreshRemoteModels(force = false): Promise<void> {
    if (!force && this.remoteModelsLoaded) return
    if (force) this.catalogGate.reset()
    await this.catalogGate.run(async () => {
      const slots = await this.options.slots()
      const slot = slots.find((item) => typeof item.credential.cookie === 'string' && item.credential.cookie.length > 0)
      if (slot === undefined) return false
      const cookie = slot.credential.cookie
      if (typeof cookie !== 'string' || cookie.length === 0) return false
      const url = DOUBAO_WEB_BASE_URL + DOUBAO_BRIEF_LIST_PATH + '?' + doubaoQuery(slot.credential).toString()
      try {
        const response = await (this.options.fetchImpl ?? fetch)(url, {
          method: 'POST',
          headers: doubaoHeaders(cookie, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ bot_id: DOUBAO_BOT_ID, language_code: 'zh' }),
          signal: AbortSignal.timeout(DOUBAO_HTTP_TIMEOUT_MS),
        })
        if (!response.ok) return false
        const envelope = parseDoubaoEnvelope(await response.text())
        if (envelope === undefined || (typeof envelope.code === 'number' && envelope.code !== 0)) return false
        const models = doubaoRemoteModels(envelope.data)
        if (models.length === 0) return false
        this.remoteModels = models
        this.remoteModelsLoaded = true
        /**
         * ★★★ **必须落盘**（PR #149 遗漏，`catalog-disk-wiring` 的派生式普查当场抓到）。
         *
         * 这一条是**派生式**判据：只要某适配器有 `remoteModels` 赋值，就必须调
         * `rememberForDisk` —— 否则**重启后该家目录不会走缓存**（冷启动那几秒
         * 会退回兜底表/空目录，而**没有任何报错**）。是「静默变慢 + 短暂显示错目录」
         * 的经典形态，本仓已经为此写过一次普查。
         *
         * ⚠️ 写在**赋值之后**：`rememberForDisk` 要把刚落地的目录写到磁盘，
         *    早于赋值会写到上一版（`buddy-adapter.ts:2259` 有同一条注释）。
         *
         * ⚠️ **只在 `models.length > 0` 之后**才到这里（上面已早退）⇒ 不存在
         *    「用残缺的目录覆盖上次的好缓存」那种风险（`buddy-adapter` 需要额外判
         *    `remoteComplete`，本家的判据是「非空即完整」，故不需要）。
         *
         * ⚠️ 可选成员（`?.`）：单测替身没有它时零行为变化。
         */
        this.catalog.rememberForDisk?.(this.syncCatalogEntries())
        return true
      } catch {
        // 传输错误可能包含请求头或会话标识，不把异常原文写入日志。
        this.options.warn?.('[doubao] 模型目录读取失败，使用快照')
        return false
      }
    })
  }

  async refresh(): Promise<void> {
    await this.catalog.refresh?.()
  }

  listAllModels(): readonly { id: string; name: string }[] {
    return this.catalog.listAllModels()
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(provider)
  }

  private async modelForCall(model: string, signal?: AbortSignal): Promise<DoubaoRemoteModel> {
    signal?.throwIfAborted()
    await this.refreshRemoteModels()
    signal?.throwIfAborted()
    return resolveRemoteModel(model, this.remoteModels)
  }

  private resolvedModel(provider: string, model: DoubaoRemoteModel): LlmResolvedModelInfo {
    const { reasoning } = this.toCatalogEntry(model)
    return { provider, id: model.key, name: model.name, inputModalities: ['text'],
      ...(reasoning === undefined ? {} : { reasoning }) }
  }

  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.resolvedModel(provider, await this.modelForCall(model, signal))
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    const remote = await this.modelForCall(model, signal)
    return {
      model: this.resolvedModel(provider, remote),
      stream: (options) => this.streamWithModel(options, remote),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamWithModel(options, await this.modelForCall(options.model, options.signal))
  }

  private async *streamWithModel(options: GenerateOptions, remote: DoubaoRemoteModel): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const slots = await this.options.slots()
    if (slots.length === 0) {
      throw new LlmError('豆包：还没有可用的账号。请在 Jet Hub 的豆包卡片上扫码登录。', 'MISSING_CREDENTIAL')
    }
    const body = buildDoubaoChatBody(options, remote)
    let lastError: LlmError | undefined
    for (const slot of slots) {
      options.signal?.throwIfAborted()
      if (typeof slot.credential.cookie !== 'string' || slot.credential.cookie.length === 0) continue
      const url = DOUBAO_WEB_BASE_URL + DOUBAO_CHAT_PATH + '?' + doubaoQuery(slot.credential).toString()
      let raw: string
      try {
        const response = await (this.options.fetchImpl ?? fetch)(url, {
          method: 'POST',
          headers: doubaoHeaders(slot.credential.cookie, { 'Content-Type': 'application/json' }),
          body,
          ...options.signal === undefined ? {} : { signal: options.signal },
        })
        if (!response.ok) {
          lastError = new LlmError('豆包：上游返回 HTTP ' + response.status, response.status === 401 ? 'AUTH' : 'SERVER', { status: response.status })
          continue
        }
        raw = await response.text()
      } catch {
        options.signal?.throwIfAborted()
        // 不透出可能附带 Cookie / URL / 请求正文的底层异常。
        lastError = new LlmError('豆包：读取上游对话响应失败', 'SERVER')
        continue
      }
      const frames = parseDoubaoFrames(raw)
      const tracker = new DoubaoTextTracker()
      const chunks: StreamChunk[] = []
      for (const frame of frames) {
        const streamError = doubaoStreamErrorOf(frame.data)
        if (streamError !== undefined) {
          throw new LlmError('豆包：上游错误 ' + streamError.code, 'SERVER')
        }
        for (const chunk of tracker.push(frame)) chunks.push(chunk)
      }
      tracker.flush(chunks)
      if (tracker.hasAnswer) {
        for (const chunk of chunks) yield chunk
        for (const chunk of tracker.finish()) yield chunk
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      lastError = new LlmError('豆包：上游未返回正文', 'EMPTY_RESPONSE')
    }
    throw lastError ?? new LlmError('豆包：所有账号均不可用', 'SERVER')
  }

  private toCatalogEntry(model: DoubaoRemoteModel): CatalogEntry {
    const suffix = doubaoTagSuffix(model.tags)
    return {
      id: model.key,
      name: model.name + (suffix === undefined ? '' : ' · ' + suffix),
      bareName: model.name,
      inputModalities: ['text'],
      ...model.reasoning === undefined ? {} : {
        reasoning: {
          efforts: model.reasoning.efforts.map((effort) => ({
            id: effort.id as NonNullable<CatalogEntry['reasoning']>['efforts'][number]['id'],
            name: effort.name,
          })),
        },
      },
    }
  }

  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    await this.refreshRemoteModels()
    return this.remoteModels.map((m) => this.toCatalogEntry(m))
  }

  private syncCatalogEntries(): readonly CatalogEntry[] {
    return this.remoteModels.map((m) => this.toCatalogEntry(m))
  }
}

/** 注册适配器。 */
export function registerDoubaoLlm(ctx: Context, options: DoubaoAdapterOptions): DoubaoAdapter {
  const adapter = new DoubaoAdapter(options)
  registerAdapterIdempotent(ctx.llm, [DOUBAO_PROVIDER], adapter)
  return adapter
}
