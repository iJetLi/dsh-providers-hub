import { randomUUID } from 'node:crypto'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { OpenAiGatewayError } from './messages.js'
import { normalizeUpstreamFailure, upstreamStatusOrFallback } from './model-errors.js'
import { toOpenAiUsage } from './usage.js'
// ⚠️ 判据**必须复用** `../sse.js` 的唯一来源：名字可用性、参数归一化、截断判定。
//    就地写 `name.trim().length > 0` / `JSON.parse` 尝试是本仓库反复记过的漂移源
//    （`messages.ts` 的 `resolveToolPairing` 那次）。
import { hasUsableToolName, isTruncatedArguments, normalizeToolArguments } from '../sse.js'

/**
 * 失败后给出纠错建议的钩子。
 *
 * 只在**出错时**被调用（正常路径零开销），故可以放心在这里去查模型目录。
 * 流式与非流式共用同一个钩子，保证两条路径给出的建议完全一致。
 */
export type SuggestionHook = (message: string) => string | undefined | Promise<string | undefined>

/**
 * 把「你可能是想用 X」拼到错误消息后面。
 *
 * ⚠️ 导出给 `responses.ts` 复用：两个端点的纠错建议必须逐字一致，
 * 否则同一次误填在两个 URL 上会得到不同的提示。
 */
export async function withSuggestion(message: string, suggest: SuggestionHook | undefined): Promise<string> {
  if (suggest === undefined) return message
  try {
    const hint = await suggest(message)
    return typeof hint === 'string' && hint.length > 0 ? `${message}（${hint}）` : message
  } catch {
    // 建议只是锦上添花，取目录失败绝不能盖掉真正的错误消息。
    return message
  }
}

interface ToolState {
  id: string
  name?: string
  /** delta 累积的**裸拼接串**（流式期间逐帧发给客户端的就是它的增量）。 */
  arguments: string
  /**
   * `block-end` 的**权威参数**（非流式出口优先取它）。
   *
   * 所有适配器都在收尾循环里用 `block-end` 补发最终块，且**在那一刻才做归一化**
   * （空参数补 `{}`、DSML 清洗、残缺 JSON 原样）。Chat 路由如果不采纳，等于
   * 把这层保证整层丢掉 —— GitHub issue #134。
   */
  argumentsOverride?: string
  /**
   * 该块已收尾：**后续同 index 的 delta 必须忽略**。
   *
   * 上游重试会让 index 从 0 重排（真实形态，见 `aggregate-adapter.ts` 与
   * `docs/agent-notes/protocol-wire.md`），没有这格就会把同一个调用的参数
   * **拼两遍**（实测 `{"a":1}{"a":1}`）。
   */
  closed: boolean
  /**
   * **出站**的稠密索引（按**首次真正发出**的顺序分配 0,1,2…）。
   *
   * DSH 的 `chunk.index` 是**块索引**，与正文/思考共用同一个计数器 ⇒ 先出正文
   * 再出工具时它是 `1`。而 OpenAI 规范里 `tool_calls[].index` 是本帧调用在
   * 数组中的位置（0-based、稠密），openai-node 用它做 `toolCallSnapshot[index]`。
   * 直传块索引会让客户端组装出空洞。
   *
   * ⚠️ **延迟分配**（2026-11-21 对抗审计 P2-2）：名字不可用的调用会被抑制
   * （一帧都不发），若它**提前占号**，后面真正发出的工具 index 会是 1,2…而缺 0
   * ⇒ 又成了空洞（正是 issue D 要修的形态）。⇒ 只有**真正发帧时**才 `??=` 分配。
   */
  openAiIndex?: number
  /**
   * **已经发给客户端的**参数字符串（流式专用）。
   *
   * ## 为什么需要它（2026-11-21 自查发现的流式缺口）
   *
   * 「无参数工具」的上游形态是 `argumentsDelta: ''` —— 客户端一个参数字符都
   * **不会**收到，于是它那边累积成 `''`，`JSON.parse('')` 直接抛
   * `Unexpected end of JSON input`（issue #134 现象 1）。
   *
   * 非流式出口靠 `argumentsOverride` 已经拿到 `'{}'`；**流式不能把已发帧收回**，
   * 但只要「一个字符都没发过」，就可以在 `block-end` 时补一帧权威值 ——
   * 客户端累积结果就与「一次性收到 `{}`」等价。
   *
   * ⚠️ 一旦发出过**任何**参数（哪怕一个 `{`），就**不能**补发：客户端是按
   * **增量拼接**的，补一帧完整值会变成 `{...{...}` 拼接错乱。
   */
  sentArguments: string
}

interface Accumulated {
  content: string
  reasoning: string
  tools: Map<number, ToolState>
  /**
   * `block-end` 的权威正文，**按块号**记录（流式不再补帧，只供非流式出口）。
   *
   * ## ⚠️ 为什么是 Map 而不是单值（2026-11-21 正向审计 P1-1）
   *
   * 我第一版是 `contentOverride?: string` 单值 —— **一个流里出现 ≥2 个 text 块时，
   * 后一个 `block-end` 会把前一个整段覆盖掉**：实测正序收尾时非流式
   * `"AB"` → `"B"`、逆序收尾 `"AB"` → `"A"`（流式仍是 `"AB"` ⇒ 两个出口分叉）。
   *
   * 而多正文块是**合法且可达**的形态：Anthropic 族（`zcode-anthropic.ts`）按
   * `content_block` 的 index 建块、**一块一个 `block-end`**。
   * ⇒ 必须按块号存，出口时按块号升序拼接。
   */
  contentOverrides: Map<number, string>
  /** 同上，思考块。 */
  reasoningOverrides: Map<number, string>
  /**
   * 已经**发出过 delta** 的正文块号。
   *
   * 用于 P2-2：某些链路（`llm-adapter` 的 `visible` 回退 ⇒ codearts 可达）会
   * **只发 `block-end` 不发 delta**。旧实现只把权威值记进 override、流式一帧不发
   * ⇒ 客户端收到**空回答**。有了这个集合就能在「该块一帧都没发过」时补发正文。
   */
  textSentBlocks: Set<number>
  /** 同上，思考块。 */
  reasoningSentBlocks: Set<number>
  /** 下一个工具块的出站稠密索引。 */
  nextToolIndex: number
  usage?: TokenUsage
  finishReason?: string
}

function finishReason(reason: FinishReason): string {
  switch (reason.kind) {
    case 'stop': return 'stop'
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    case 'aborted': return 'error'
    case 'error': return 'error'
  }
}

/**
 * DSH 的用量 → OpenAI Chat Completions 的 `usage`。
 *
 * ⚠️ 口径转换全部在 `usage.ts` 里（两个端点共用一份判断，见该文件头）。
 * 这里只负责**改字段名**：`inputTokens`（已含缓存）→ `prompt_tokens`。
 *
 * ⚠️ 两个**私有**字段保留是**有意的向后兼容**，不是冗余：
 * - `prompt_cache_hit_tokens` 是 DeepSeek 系的私有名，本仓库多个适配器
 *   （`buddy-adapter.ts` / `openai-compat.ts` / `llm-adapter.ts` 等）在**读**它；
 * - 顶层 `reasoning_tokens` 同理由旧版网关发出，删掉会让既有消费者读不到。
 */
function usageJson(usage: TokenUsage): Record<string, unknown> {
  const normalized = toOpenAiUsage(usage)
  return {
    prompt_tokens: normalized.inputTokens,
    completion_tokens: normalized.outputTokens,
    total_tokens: normalized.totalTokens,
    // 官方明细：`cached_tokens` 是 `prompt_tokens` 的**子集**（见 `usage.ts`）。
    //
    // ⚠️ 「未上报」时**整段省略**（不是补 0）：官方 Chat schema 里
    // `prompt_tokens_details` 是 `Optional[...] = None`，省略完全合法；而 codex
    // 根本没有 Chat Completions 客户端路径（`codex-api/src/sse/` 只有 responses）。
    // 2026-11-18 按 openai-python 的 `completion_usage.py`、codex-rs 的
    // `sse/responses.rs` 与 `core/src/lib.rs` 源码核实后，删掉了原先那句
    // 「官方字段必须同时给、Codex 等标准客户端只认官方形态」—— 它不成立。
    // Responses 侧**相反**：`input_tokens_details.cached_tokens` 是必填 int，
    // 只能补 0，再用 `cache_read_reported: false` 标出「这个 0 是补的」。
    ...normalized.cachedTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: normalized.cachedTokens } }
      : {},
    ...normalized.reasoningTokens === undefined
      ? {}
      : {
          reasoning_tokens: normalized.reasoningTokens,
          completion_tokens_details: { reasoning_tokens: normalized.reasoningTokens },
        },
    // 私有兼容字段（见上方注释）：只在真有缓存命中时才发，避免凭空多出 0。
    ...normalized.cachedTokens !== undefined && normalized.cachedTokens > 0
      ? { prompt_cache_hit_tokens: normalized.cachedTokens }
      : {},
  }
}

function line(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function baseChunk(id: string, model: string, delta: Record<string, unknown>, finish?: string): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }
}

function failureMessage(reason: Extract<FinishReason, { kind: 'error' | 'aborted' }>): string {
  return reason.failure.message || `DSH model request ${reason.kind}`
}

function consumeChunk(state: Accumulated, chunk: StreamChunk): Record<string, unknown> | undefined {
  switch (chunk.type) {
    case 'text-delta': {
      /**
       * 排队提示帧（provider 专有，目前只有 qoder 的 `visible` 档会发）。
       *
       * ⚠️⚠️ 它是**合法的 `text-delta`**（`text` 为空串），只是多带一个私有字段
       * `qoderQueue`。**不能**给 `StreamChunk` 联合加新成员：宿主的两条组装器
       * （`dsh-llm` 的 `BlockAssembler.push` 与 `AssistantStreamAccumulator.push`）
       * 的 `default` 分支是 `assertNever`，任何联合外类型都会**硬抛**
       * （2026-11-13 实测：`unreachable variant in BlockAssembler.push`）。
       * 多带的字段会被它们忽略，所以「合法成员 + 私有字段」是唯一不扩宿主契约的形状。
       *
       * ⚠️ 提示帧**不能**贡献正文：`delta` 必须是空对象（`content` 留空），
       * 否则每轮排队都会往回复里注入一个字符（2026-11-13 对抗审计实测）。
       */
      const queue = (chunk as { qoderQueue?: unknown }).qoderQueue
      if (queue !== undefined) return { delta: {}, notice: queue }
      state.content += chunk.text
      state.textSentBlocks.add(chunk.index)
      return { delta: { content: chunk.text } }
    }
    case 'reasoning-delta':
      state.reasoning += chunk.text
      state.reasoningSentBlocks.add(chunk.index)
      return { delta: { reasoning_content: chunk.text } }
    case 'tool-call-delta': {
      let tool = state.tools.get(chunk.index)
      if (!tool) {
        tool = {
          id: String(chunk.id),
          arguments: '',
          sentArguments: '',
          closed: false,
        }
        state.tools.set(chunk.index, tool)
      }
      // ★ 已收尾的块，后续同 index 的 delta 一律忽略（否则参数拼两遍）。
      if (tool.closed) return undefined
      /**
       * ★ 判据与 `responses.ts` **逐字对齐**：
       * - `id`：只允许**非空**覆盖（`String(x || y)` 挡不住 `'   '`）；
       * - `name`：用 `hasUsableToolName`（trim 后非空），**不是** `!== undefined`
       *   —— 后续分片常带 `name: ''`（它不是 undefined），无条件覆盖会把首片
       *   解析出的真名抹成空 ⇒ 客户端报 `unknown tool ""`，坏块入会话、每轮重放。
       */
      /**
       * ⚠️ 判据是 **`trim()` 后非空**，不是 `length > 0`：
       * `'   '` 的 length 是 3，`length > 0` 与 `||` 都挡不住它（issue #134 根因 B
       * 原话：「`id` 用 `||` 只挡 `''`，挡不住 `'   '`」）。
       * 与 Responses 侧**同改**（两边判据必须逐格一致，否则同一份流在两个
       * 端点上会给出不同 id）。
       */
      if (String(chunk.id).trim().length > 0) tool.id = String(chunk.id)
      if (hasUsableToolName(chunk.name)) tool.name = chunk.name
      tool.arguments += chunk.argumentsDelta
      /**
       * ★★★ **名字不可用时不得发帧**（2026-11-21 正向审计 P1-2，issue 的 F 未闭合）。
       *
       * 「名字只在 `block-end` 到达」是**正常形态**（`docs/agent-notes/protocol-wire.md`
       * 有实测记录：`responses` 的 `call_late` 用例就是它）。旧实现照发，于是
       * 客户端攒出 `name: ''` —— 那是 **IKLRIK 记录的会话级损坏形态**
       * （harness 报 `unknown tool ""`、坏块入会话、每轮重放 ⇒ 会话报废）。
       *
       * 非流式出口已经用 `filter(hasUsableToolName)` 剔除，但**流式没法撤回已发帧**
       * ⇒ 唯一协议安全的做法是**首帧推迟到名字可用**。
       *
       * 代价（如实登记）：名字晚到的调用会**丧失参数增量流式** —— 首帧一次性
       * 带出已累积的参数。这与 Responses 侧的 `toolAddedEvent` 同口径
       * （它也是在名字可用时才发 `added`）。
       */
      if (!hasUsableToolName(tool.name)) return undefined
      // ★ 首次真正发帧时才占号（P2-2：被抑制的调用不得留下 index 空洞）。
      tool.openAiIndex ??= state.nextToolIndex++
      // 首帧把**已累积**的参数一次带出（此前一帧都没发过）；之后发增量。
      const payload = tool.sentArguments.length === 0 ? tool.arguments : chunk.argumentsDelta
      tool.sentArguments += payload
      return {
        delta: {
          tool_calls: [{
            // ★ 出站用**稠密**索引，不是 DSH 块索引。
            index: tool.openAiIndex,
            id: tool.id,
            type: 'function',
            function: { name: tool.name, arguments: payload },
          }],
        },
      }
    }
    case 'usage':
      state.usage = chunk.usage
      return undefined
    case 'finish':
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        // ⚠️ 把上游自带的状态码一并带出来（`LlmError` 把它放在 `failure.status`）：
        // 少了它，下游只能退化成 502，模型名写错这种确定性失败会被客户端白重试。
        return {
          error: {
            message: failureMessage(chunk.reason),
            type: 'server_error',
            code: chunk.reason.failure.code,
            status: chunk.reason.failure.status,
          },
        }
      }
      state.finishReason = finishReason(chunk.reason)
      return { delta: {}, finish_reason: state.finishReason }
    case 'block-start':
      return undefined
    case 'block-end': {
      /**
       * ★★★ **权威覆盖**（GitHub issue #134 的主修）。
       *
       * 本仓库把「`block-end` 是权威覆盖」写成了纪律（`sse.ts` 的
       * `BlockAssembler` 实测、`docs/agent-notes/dev-tasks.md:167`），九个适配器
       * **全部**在收尾循环里用 `block-end` 补发最终块、且**在那一刻才做归一化**
       * （空参数补 `{}`、DSML 清洗、正文去重/切分归位）。
       * 原先这里直接 `return undefined` ⇒ 那层保证在 Chat 路由上整层丢失。
       *
       * ⚠️ **流式不回补**：delta 逐帧已经发给客户端了，再补一帧会让客户端
       *    重复拼接。这里只把权威值记进状态，供**非流式出口**和
       *    「无 delta 只有 block-end」两种场景使用。
       */
      const block = chunk.block
      if (block.type === 'text') {
        /**
         * ★★★ **first-close-wins 同样适用于正文/思考**（2026-11-21 对抗审计 P2-1）。
         *
         * 我只把 first-close-wins 加给了 `tool-call`，正文这格漏了 ⇒ 畸形流里
         * 第二个 `block-end` 会**无条件覆盖**权威正文：实测
         * `text-delta "AAA"` + `block-end "AAA"` + 重复 `block-end "ZZZ"`
         * ⇒ 非流式 **`"ZZZ"`**（改前与 `BlockAssembler` / `responses.ts` 都是 `"AAA"`）
         * ⇒ **改前对、改后错**。
         */
        if (state.contentOverrides.has(chunk.index)) return undefined
        // 按块号记录（多正文块的形态见 `Accumulated.contentOverrides` 的说明）。
        state.contentOverrides.set(chunk.index, block.text)
        /**
         * ★ **该块一帧 delta 都没发过 ⇒ 补发正文**（正向审计 P2-2）。
         * 「只发 `block-end` 不发 delta」在 codearts 链路可达
         *（`llm-adapter` 的 `visible` 回退）；不补就是**空回答**。
         */
        if (!state.textSentBlocks.has(chunk.index) && block.text.length > 0) {
          state.textSentBlocks.add(chunk.index)
          return { delta: { content: block.text } }
        }
        return undefined
      }
      if (block.type === 'reasoning') {
        // 同上的 first-close-wins（思考块与正文同型）。
        if (state.reasoningOverrides.has(chunk.index)) return undefined
        state.reasoningOverrides.set(chunk.index, block.text)
        if (!state.reasoningSentBlocks.has(chunk.index) && block.text.length > 0) {
          state.reasoningSentBlocks.add(chunk.index)
          return { delta: { reasoning_content: block.text } }
        }
        return undefined
      }
      if (block.type !== 'tool-call') return undefined

      let tool = state.tools.get(chunk.index)
      if (tool === undefined) {
        /**
         * **只有 `block-end` 没有 delta 的块也不能丢**（与 `responses.ts` 的
         * 「只发 block-end 没有 delta 的块也不能丢」互为对偶 —— 有些适配器
         * 在收尾循环里首次成块）。补发一帧完整调用，否则该调用对客户端
         * 完全不存在。
         */
        /**
         * ★ **流式补发帧必须归一化**（正向审计 P2′）。
         *
         * 这一帧是客户端看到的**全部**参数（此前一帧都没发过）⇒ 空参数必须给
         * `'{}'`，否则 `JSON.parse('')` 抛错；而非流式出口会调
         * `normalizeToolArguments` ⇒ 不归一化就两出口分叉。
         * 判据与非流式**同一份**：截断保持原样、其余归一化。
         */
        const authoritative = isTruncatedArguments(block.arguments)
          ? block.arguments
          : normalizeToolArguments(block.arguments)
        tool = {
          id: String(block.id),
          arguments: block.arguments,
          sentArguments: authoritative,
          argumentsOverride: block.arguments,
          closed: true,
        }
        if (hasUsableToolName(block.name)) tool.name = block.name
        state.tools.set(chunk.index, tool)
        // 名字不可用 ⇒ 一帧都不发（与 delta / 补发分支同口径，见 P1′）。
        if (!hasUsableToolName(tool.name)) return undefined
        // ★ 首次真正发帧时才占号（P2-2）。
        tool.openAiIndex ??= state.nextToolIndex++
        return {
          delta: {
            tool_calls: [{
              index: tool.openAiIndex,
              id: tool.id,
              type: 'function',
              function: { name: tool.name, arguments: authoritative },
            }],
          },
        }
      }
      /**
       * ⚠️ **first-close-wins**：一个块只允许收尾一次。
       *
       * 与 `BlockAssembler` 的 `if (partial.block) return`、`responses.ts` 的
       * `closed.has(chunk.index)` **同语义**（2026-11-21 正向审计 P2-1）：
       * 少了这一格，畸形流里第二个 `block-end` 会**再覆盖**权威参数
       * （实测非流式从 `{"a":1}` 变成 `{"a":999}`，而客户端手里还是 `{"a":1}`
       * ⇒ 两个出口分叉）；带新 id/name 时整条调用会被替换。
       */
      if (tool.closed) return undefined
      if (String(block.id).trim().length > 0) tool.id = String(block.id)
      // ⚠️ 这一格比 delta 那格更危险：`block-end` 一覆盖就再没有帧来修它。
      if (hasUsableToolName(block.name)) tool.name = block.name
      tool.argumentsOverride = block.arguments
      tool.closed = true
      /**
       * ★★ **流式补发权威参数**（2026-11-21 自查发现：非流式修好了、流式没有）。
       *
       * 「无参数工具」的上游形态是 `argumentsDelta: ''` ⇒ 客户端累积成 `''`
       * ⇒ `JSON.parse('')` 抛 `Unexpected end of JSON input`（issue #134 现象 1）。
       * 只要客户端**一个参数字符都没收到过**（`sentArguments === ''`），
       * 就补一帧权威值；补完两者等价。
       *
       * ⚠️ 反过来**绝不**在已发过参数时补：客户端按增量拼接，补完整值会错乱。
       */
      /**
       * ★★★ **补发分支同样必须过名字闸门**（2026-11-21 正向审计 P1′，一行但真泄漏）。
       *
       * 我上一轮只在 `tool-call-delta` 分支加了「名字不可用就不发帧」，
       * **补发分支漏了** —— 于是「名字永不可用 + `block-end` 带参数」这条路径
       * 仍会发出一帧 `{ id, function: { arguments } }`（**没有 name**），
       * 客户端攒出来正是 `name: ''`，也就是 IKLRIK 的会话级损坏形态。
       * 审计用 `delta{name:''}` + `block-end{args:'{"a":1}'}` 当场复现。
       *
       * ⇒ 名字不可用时**一帧都不发**（与非流式出口 `filter(hasUsableToolName)`
       *   的剔除口径一致：这条调用对两个出口都不存在）。
       */
      /**
       * ⚠️ **不能加 `block.arguments.length > 0` 的前置条件**（变异 M12 暴露的）。
       *
       * 「无参数工具」的权威值就是空串，归一化后是 `{}`。我原先多写了
       * `block.arguments.length > 0` ⇒ 空参数场景**整条补发被跳过** ⇒ 客户端
       * 仍然攒出 `arguments: ''` ⇒ `JSON.parse('')` 抛错，issue #134 现象 1
       * 在「有 delta 但参数为空」这条路径上**没修好**。
       */
      if (hasUsableToolName(tool.name) && tool.sentArguments.length === 0) {
        tool.openAiIndex ??= state.nextToolIndex++
        /**
         * ★ **出站值必须归一化**（审计 P2′）。
         *
         * 这是「客户端此前一帧都没收到过」的补发 ⇒ 它就是客户端看到的**全部**
         * 参数。若原样吐出 `block.arguments`，而适配器那一刻给的是空串
         * （无参数工具），客户端就拿到 `arguments: ""` ⇒ `JSON.parse("")` 抛错
         * （非流式出口会归一化成 `{}`，两个出口又会分叉）。
         * 用与非流式**同一份**判据：截断保持原样、其余归一化。
         */
        const authoritative = isTruncatedArguments(block.arguments)
          ? block.arguments
          : normalizeToolArguments(block.arguments)
        tool.sentArguments = authoritative
        return {
          delta: {
            tool_calls: [{
              index: tool.openAiIndex,
              id: tool.id,
              type: 'function',
              function: { name: tool.name, arguments: authoritative },
            }],
          },
        }
      }
      return undefined
    }
  }
}

export async function* toOpenAiSse(
  chunks: AsyncIterable<StreamChunk>,
  requestId = `chatcmpl-${randomUUID()}`,
  model: string,
  suggest?: SuggestionHook,
): AsyncIterable<string> {
  const state: Accumulated = { content: '', reasoning: '', tools: new Map(), contentOverrides: new Map(), reasoningOverrides: new Map(), textSentBlocks: new Set(), reasoningSentBlocks: new Set(), nextToolIndex: 0 }
  try {
    for await (const chunk of chunks) {
      const event = consumeChunk(state, chunk)
      if (event === undefined) continue
      if ('error' in event) {
        const error = event.error as { message?: unknown; type?: unknown; code?: unknown; status?: unknown }
        const message = typeof error.message === 'string' ? error.message : 'upstream error'
        // 上游「模型不存在」以 502 离开网关时会被客户端当成可重试故障重试，
        // 但它是确定性失败 —— 翻成 404 让客户端提示用户改配置。
        const normalized = normalizeUpstreamFailure({
          // 上游自带状态码（如 gemini 拒绝未知模型名时的 404）优先，否则才退化成 502。
          // ⚠️ 门禁（400–599）不能省：codearts 会用 `{ status: 200 }` 表示业务失败，
          // 原样透出会让「额度用尽」在客户端眼里读成成功。另两处出口已有同一门禁。
          status: upstreamStatusOrFallback(error.status),
          type: typeof error.type === 'string' ? error.type : 'server_error',
          code: typeof error.code === 'string' ? error.code : 'upstream_error',
          message,
        })
        yield line({
          id: requestId,
          object: 'chat.completion.chunk',
          model,
          choices: [],
          error: {
            message: await withSuggestion(message, suggest),
            type: normalized.type,
            code: normalized.code,
            // 流已发出 200，状态码改不了；把该有的 404 放进 status 字段供客户端读。
            status: normalized.status,
          },
        })
        yield 'data: [DONE]\n\n'
        return
      }
      if ('finish_reason' in event) {
        yield line({ ...baseChunk(requestId, model, event.delta as Record<string, unknown>, event.finish_reason as string) })
      } else {
        const base = baseChunk(requestId, model, event.delta as Record<string, unknown>)
        // 排队提示帧：`qoder_queue` 是**非标准字段**，标准 OpenAI SDK 按协议会忽略它，
        // 愿意读的客户端（面板 / 自研）据此显示「排队中（第 N 轮，预计 M 秒）」，
        // 而不是只能看到一个没有 explain 的空心跳。
        const notice = 'notice' in event ? event.notice : undefined
        yield line(notice === undefined ? base : { ...base, qoder_queue: notice })
      }
    }
    if (state.finishReason === undefined) {
      yield line({ id: requestId, object: 'chat.completion.chunk', model, choices: [], error: { message: 'upstream stream ended before finish', type: 'server_error', code: 'incomplete_stream' } })
      yield 'data: [DONE]\n\n'
      return
    }
    if (state.usage !== undefined) {
      yield line({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: usageJson(state.usage) })
    }
    yield 'data: [DONE]\n\n'
  } catch (error) {
    const converted = failureToOpenAiError(error)
    yield line({ id: requestId, object: 'chat.completion.chunk', model, choices: [], error: converted.body.error })
    yield 'data: [DONE]\n\n'
  }
}

export async function collectOpenAiCompletion(
  chunks: AsyncIterable<StreamChunk>,
  requestId = `chatcmpl-${randomUUID()}`,
  model: string,
  suggest?: SuggestionHook,
): Promise<Record<string, unknown>> {
  const state: Accumulated = { content: '', reasoning: '', tools: new Map(), contentOverrides: new Map(), reasoningOverrides: new Map(), textSentBlocks: new Set(), reasoningSentBlocks: new Set(), nextToolIndex: 0 }
  try {
    for await (const chunk of chunks) {
      const event = consumeChunk(state, chunk)
      if (event?.error) {
        const detail = event.error as Record<string, unknown>
        throw new OpenAiGatewayError(
          String(detail.message),
          // 上游自带状态码优先（模型名不存在 = 404），否则才当可重试的服务端故障。
          upstreamStatusOrFallback(detail.status),
          'server_error',
          String(detail.code ?? 'upstream_error'),
        )
      }
    }
    if (state.finishReason === undefined) {
      throw new OpenAiGatewayError('upstream stream ended before finish', 502, 'server_error', 'incomplete_stream')
    }
  } catch (error) {
    const converted = failureToOpenAiError(error)
    const message = String(converted.body.error.message)
    // 同 toOpenAiSse：把上游「模型不存在」翻成 404，避免客户端把它当可重试故障。
    const normalized = normalizeUpstreamFailure({
      status: converted.status,
      type: String(converted.body.error.type),
      code: String(converted.body.error.code ?? 'upstream_error'),
      message,
    })
    throw new OpenAiGatewayError(await withSuggestion(message, suggest), normalized.status, normalized.type, normalized.code)
  }
  /**
   * 非流式出口（issue #134 的 C / D / F 三条一起收在这里）。
   *
   * - **排序**按出站稠密索引（`openAiIndex`），不是 DSH 块索引；
   * - **参数**优先取 `block-end` 的权威值，再按「截断保持原样、否则归一化」；
   *   残缺参数**不得**伪造成 `{}`（那会掩盖分片丢失，见 `sse.ts` 的理由）；
   * - **空名调用剔除** —— 与 Responses 的 `hasContent` 同判据（名字可用性），
   *   否则客户端会收到 `"name": ""` 并报 `unknown tool ""`。
   */
  const toolCalls = [...state.tools.values()]
    // 非流式出口的 `openAiIndex` 可能从未分配（流式才需要它）⇒ 用哨兵值排到最后，
    // 其余按分配顺序；无号者彼此的相对顺序由 Map 插入顺序决定（稳定排序）。
    .sort((left, right) => (left.openAiIndex ?? Number.MAX_SAFE_INTEGER) - (right.openAiIndex ?? Number.MAX_SAFE_INTEGER))
    .filter((tool) => hasUsableToolName(tool.name))
    .map((tool) => {
      const raw = tool.argumentsOverride ?? tool.arguments
      return {
        id: tool.id,
        type: 'function',
        function: {
          name: tool.name as string,
          arguments: isTruncatedArguments(raw) ? raw : normalizeToolArguments(raw),
        },
      }
    })
  /**
   * 按块号升序拼接权威值（**不是**取最后一个 —— 多正文块会整段丢内容）。
   * 没有任何 override 时才回退到 delta 累积（保持「无 `block-end` 的合成流」可用）。
   */
  const joinOverrides = (map: Map<number, string>, fallback: string): string => {
    if (map.size === 0) return fallback
    return [...map.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('')
  }
  const finalContent = joinOverrides(state.contentOverrides, state.content)
  const finalReasoning = joinOverrides(state.reasoningOverrides, state.reasoning)
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: finalContent || null,
    ...finalReasoning.length === 0 ? {} : { reasoning_content: finalReasoning },
    ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
  }
  return {
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: state.finishReason }],
    ...state.usage === undefined ? {} : { usage: usageJson(state.usage) },
  }
}

export function failureToOpenAiError(error: unknown): { status: number; body: { error: Record<string, unknown> } } {
  if (error instanceof OpenAiGatewayError) {
    return { status: error.status, body: { error: { message: error.message, type: error.type, code: error.code } } }
  }
  // ⚠️ `LlmError` 的 `status` **不是顶层属性**（实测 `'status' in e === false`），
  // 它只落在 `e.failure.status`（`@deepseek-ai/dsh-llm` 的 `LlmFailure`）。
  // 只读顶层等于没读 —— 上游声明的 404 会一路退化成 502 并被客户端反复重试。
  const value = error as
    | { code?: unknown; status?: unknown; failure?: { status?: unknown }; message?: unknown }
    | undefined
  const raw = typeof value?.status === 'number' ? value.status : value?.failure?.status
  const status = upstreamStatusOrFallback(raw)
  return {
    status,
    body: { error: {
      message: typeof value?.message === 'string' ? value.message : 'DSH model request failed',
      type: 'server_error',
      code: typeof value?.code === 'string' ? value.code : 'upstream_error',
    } },
  }
}
