/**
 * MonkeyCode 的 Anthropic Messages 请求体构造与 SSE 消费。
 *
 * ## ⚠️ 本文件**刻意复用** `minimax-messages.ts` 的实现
 *
 * 两个 provider 的传输协议**逐字节相同**（Anthropic Messages + SSE），
 * 差异只在「思考字段的形态」与「错误文案前缀」上。本仓库已有的教训是
 * 「同一语义不得两套判据」—— 所以：
 *
 * | 能力 | 做法 | 理由 |
 * |---|---|---|
 * | 消息序列化 | 复用 `serializeMinimaxMessages` | 它处理了 harness 的
 *   `role:'tool'` 形状归一化、孤儿 tool_use/tool_result 剔除、图片内联 ——
 *   这三件事任何一件抄错都是 400，且**没有第二份实现可以对照** |
 * | SSE 消费 | 复用 `consumeMinimaxSse` | 同上（半行 buffer、DSML 归一化、
 *   `signature_delta` 忽略…） |
 * | stop_reason / usage | 复用并**直接转发** | 纯字段映射，没有本家差异 |
 * | 请求体 | **本文件自己构造** | 思考形态不同：MiniMax 用
 *   `thinking:{type:'adaptive'}` + `output_config.effort`，MonkeyCode 用
 *   `thinking:{type:'enabled', budget_tokens:N}` / `{type:'disabled'}` |
 *
 * ⚠️ **不做「把 minimax 的 build 函数参数化」的改造**：那要么改到
 * `buildMinimaxMessagesPayload` 的签名（会波及 minimax 自己的调用点），
 * 要么在共享函数里加分支（等于让协议层认识两家）。两种都比这里多 60 行
 * 本地构造更危险。
 *
 * ## 唯一的本地改写：错误文案前缀
 *
 * 复用的实现抛错时文案以 `minimax:` 开头。原样透出会让用户以为选错了
 * provider（「我明明用的 MonkeyCode，为什么报 minimax」）。故这里做一次
 * **只改前缀、不改语义**的包装 —— 不改共享实现本身。
 *
 * ## `max_tokens` 是**必填**
 *
 * Anthropic Messages 协议要求 `max_tokens` 必填（与 OpenAI 的可选不同）。
 * 缺它 ⇒ `400 ... max_tokens: Field required`。故这里给一个默认值，
 * 而不是像 qiniu（OpenAI 协议）那样「只在有值时才带」。
 *
 * @module src/monkeycode-messages.ts
 */

import type { RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'

import {
  consumeMinimaxSse,
  mapMinimaxStopReason,
  readMinimaxUsage,
  serializeMinimaxMessages,
  type ConsumeMinimaxSseOptions,
  type MinimaxInlineImage,
} from './minimax-messages.js'

/**
 * 内联图片（attachmentId → 裸 base64）。
 *
 * ⚠️ 直接复用 minimax 的类型别名：`serializeMinimaxMessages` 的签名吃这个形状，
 * 定义一份结构相同的本地类型只会让两处将来漂移。
 */
export type MonkeycodeInlineImage = MinimaxInlineImage

/**
 * 未指定 `max_tokens` 时的默认值。
 *
 * ⚠️ 4096 是**保守下限**而不是「推荐值」：monkeycode 的错误码纪律要求
 * 「能返回可读错误就不要被上游截断」。这个数不会覆盖长回答，但 harness
 * 在绝大多数调用里都会显式传 `maxTokens`（生产路径），它只兜住标题生成
 * 这类一次性小请求。
 */
export const MONKEYCODE_DEFAULT_MAX_TOKENS = 4096

/**
 * 思考配置。
 *
 * ⚠️ 与 MiniMax 的 `adaptive` 不同 —— MonkeyCode（白泽）实测接受的是
 * `{type:'enabled', budget_tokens: N}`（`N >= 1024`）与 `{type:'disabled'}`。
 * 传 `adaptive` 会被拒（不是本家协议的一部分）。
 */
export type MonkeycodeThinking =
  | { readonly type: 'enabled'; readonly budgetTokens: number }
  | { readonly type: 'disabled' }

/** `budget_tokens` 的硬下限（SPEC：`N >= 1024`，小于它会被服务端拒）。 */
export const MONKEYCODE_MIN_THINKING_BUDGET = 1024

/**
 * 思考档位 → `budget_tokens`。
 *
 * ⚠️ 档位名来自 harness 的 `ReasoningEffortId`（`none` / `low` / `medium` / `high`），
 * 但**我们刻意不声明 `reasoning` 档位表**（见适配器注释）：MonkeyCode 没有下发
 * 「每个模型支持哪些档位」的元数据，凭空编一张表就是假能力。
 * 本函数只在 harness 自己传了 `effort` 时才被用到。
 *
 * @returns `undefined` = **不发** `thinking` 字段（让服务端用默认行为），
 *   这与「显式关掉思考」不是一回事。
 */
export function monkeycodeThinkingFor(effort: unknown): MonkeycodeThinking | undefined {
  if (effort === 'none') return { type: 'disabled' }
  if (effort === 'low') return { type: 'enabled', budgetTokens: 2048 }
  if (effort === 'medium') return { type: 'enabled', budgetTokens: 4096 }
  if (effort === 'high') return { type: 'enabled', budgetTokens: 8192 }
  return undefined
}

/** {@link buildMonkeycodeMessagesPayload} 的入参。 */
export interface BuildMonkeycodeMessagesPayloadOptions {
  model: string
  messages: readonly RequestMessage[]
  system?: string
  tools?: readonly ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
  /** 思考配置；`undefined` = 不发该字段。 */
  thinking?: MonkeycodeThinking
  /** 已内联的图片；缺失时遇图**抛错**（不静默丢图）。 */
  images?: ReadonlyMap<string, MonkeycodeInlineImage>
}

/**
 * 构造 Anthropic Messages 的请求体。
 *
 * ⚠️ `stream: true` **恒真**：本插件的所有适配器都只走流式（harness 的
 * `GenerateOptions` 也是流式的），没有「非流式」这条路径可回退。
 */
/**
 * 输出上限的「荒谬值」兜底。实测该模型 `max_tokens=100000` 能正常返回 10 万
 * token、传 `1000000` 也不报错（2026-11-02 白泽直连实测）⇒ 这里不保守夹逼，
 * 只在明显超量级时收口。真正的日常上限由桌面端配置（32K）决定。
 */
export const MONKEYCODE_MAX_OUTPUT_TOKENS = 1_048_576

/**
 * 归一化 `max_tokens`：非正 / 非有限 ⇒ 默认 4096；超过上限夹到上限。
 *
 * ⚠️ 为什么必须归一（2026-11-02 审查发现）：原实现 `options.maxTokens ?? 4096`
 *    直接透传，上游传 `0` 或负数时会原样写进 `max_tokens` ⇒ 服务端 400，
 *    而 400 落在「其它失败」档 ⇒ 适配器把它当账号级失败、挨个换号，
 *    最终整条渠道被判死。**一个参数错误不该杀掉整个 provider。**
 */
export function monkeycodeMaxTokensFor(maxTokens: number | undefined): number {
  /**
   * ⚠️ `Math.max(1, …)` 不能省（2026-11-02 复审发现）：`0 < maxTokens < 1` 能过完
   * 上面所有守卫（是有限正数），却被 `Math.floor` 抹成 `0` ⇒ 发出 `max_tokens: 0`
   * 的请求体，服务端直接 400。调用方传 `0.5`（例如按比例算预算）就会踩中。
   */
  const raw =
    typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.max(1, Math.floor(maxTokens))
      : MONKEYCODE_DEFAULT_MAX_TOKENS
  return Math.min(raw, MONKEYCODE_MAX_OUTPUT_TOKENS)
}

export function buildMonkeycodeMessagesPayload(
  options: BuildMonkeycodeMessagesPayloadOptions,
): Record<string, unknown> {
  const maxTokens = monkeycodeMaxTokensFor(options.maxTokens)
  const payload: Record<string, unknown> = {
    model: options.model,
    // ⚠️ 必填（见模块头）。放在构造处而不是条件分支里，避免将来有人
    // 「顺手改成只在有值时带」——那会让一次性小请求整批 400。
    max_tokens: maxTokens,
    stream: true,
    messages: serializeMonkeycodeMessages(options.messages, options.images),
  }
  if (options.system !== undefined && options.system !== '') payload.system = options.system
  if (options.temperature !== undefined) payload.temperature = options.temperature
  if (options.stop !== undefined && options.stop.length > 0) payload.stop_sequences = [...options.stop]
  if (options.tools !== undefined && options.tools.length > 0) {
    payload.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
  }
  if (options.thinking !== undefined) {
    // ⚠️ 两边都要夹：
    //   · 下限 `MONKEYCODE_MIN_THINKING_BUDGET`（1024）—— 小于它服务端直接拒；
    //   · 上限 `maxTokens - 1` —— Anthropic 要求 budget **严格小于** max_tokens。
    // 只夹下限是本模块放出去过的一个真 bug：档位 high(8192) 遇到默认
    // `max_tokens=4096` 时必 400，而且失败在第一个 token 之前，表现为
    // 「换号重试也全挂」⇒ 整渠道被判死，用户看到的是「全部账号都不可用」。
    //
    /**
     * Anthropic 要求 `budget_tokens` **严格小于** `max_tokens`，且 `budget_tokens`
     * 不小于 1024。两个约束撞在一起时（例如 `max_tokens=1024`，此时可用的最大预算是
     * 1023 < 1024 下限）只能**降级成 disabled**：发非法 budget 是硬 400，
     * 关掉思考至少还能拿到正文。
     *
     * ⚠️ **能夹就夹，别整段关掉**（2026-11-02 二审 C🟡-3）：原实现是
     * `budget >= maxTokens ? disabled : enabled(min(budget, maxTokens-1))` ——
     * 默认 `max_tokens=4096` 下选「high(8192)」会被直接判 disabled ⇒ **静默零思考**，
     * 既没 warn 也没提示；而那个 `Math.min` 因为是死分支（条件已保证
     * `budget < maxTokens`）恒等于 `budget`，纯摆设。
     * 现在：只要 `maxTokens - 1` 还够放最小预算，就夹到 `maxTokens - 1` 继续开思考。
     */
    if (options.thinking.type === 'disabled') {
      payload.thinking = { type: 'disabled' }
    } else {
      const budget = Math.max(MONKEYCODE_MIN_THINKING_BUDGET, options.thinking.budgetTokens)
      const room = maxTokens - 1
      payload.thinking = room < MONKEYCODE_MIN_THINKING_BUDGET
        ? { type: 'disabled' }
        : { type: 'enabled', budget_tokens: Math.min(budget, room) }
    }
  }
  return payload
}

/**
 * 把复用实现抛出的 `minimax:` 前缀改成本家的。
 *
 * ⚠️ 只改动**前缀**，其余文案逐字保留 —— 那些文案里记录了真实踩坑细节
 * （例如「图片未能内联…拒绝发出缺少图片的请求」），重写会丢掉诊断价值。
 */
function rewriteMinimaxErrorPrefix(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  if (!error.message.startsWith('minimax:')) return error
  const replaced = new Error(error.message.replace(/^minimax:/, 'monkeycode:'))
  replaced.name = error.name
  return replaced
}

/**
 * 序列化历史消息为 Anthropic 形状。
 *
 * 直接转发 `serializeMinimaxMessages`（见模块头的复用决定）。
 */
export function serializeMonkeycodeMessages(
  messages: readonly RequestMessage[],
  images?: ReadonlyMap<string, MonkeycodeInlineImage>,
): Array<Record<string, unknown>> {
  try {
    return serializeMinimaxMessages(messages, images)
  } catch (error) {
    throw rewriteMinimaxErrorPrefix(error)
  }
}

/**
 * 消费 SSE 流。
 *
 * ⚠️ 用 `yield*` 包一层 `try/catch` 而不是直接 re-export：流中途抛出的错误
 * 同样带 `minimax:` 前缀，必须一并改写。`yield*` 在 generator 里被 catch
 * 捕获后**可以继续产出**，但我们这里选择**原样抛出**（半截流重发会造成
 * 重复输出，与 minimax 自己的「yieldedAny 之后不重发」口径一致）。
 */
export async function* consumeMonkeycodeSse(
  options: ConsumeMinimaxSseOptions,
): AsyncGenerator<StreamChunk> {
  try {
    yield* consumeMinimaxSse(options)
  } catch (error) {
    throw rewriteMinimaxErrorPrefix(error)
  }
}
