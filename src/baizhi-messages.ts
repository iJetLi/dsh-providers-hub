/**
 * 百智云的 Anthropic Messages 请求体构造 + SSE 消费。
 *
 * ## 为什么单独成模块
 *
 * 协议解析**复用** `src/minimax-messages.ts`（本仓唯一的 Anthropic Messages 实现），
 * 只在这里补百智云的两点差异：
 * 1. `max_tokens` 的上限（100,000，实测可用）与默认值（4096）；
 * 2. 思考参数：百智云用 `thinking: {type:'enabled', budget_tokens:N}`，
 *    **不支持** Anthropic 的 `output_config.effort`（顶层 `effort` 实测无作用：
 *    low/xhigh 各 2 次思考长度无差异）⇒ 这里**不做 effort 透传**，
 *    只把 effort 档位换算成 budget。
 *
 * ⚠️ **硬约束：`budget_tokens` 必须严格小于 `max_tokens`**（Anthropic 协议要求
 * `budget_tokens < max_tokens`，百智云遵循该规则；写成 ≥ 会被 400 拒绝）。
 * 所以预算一律按 `min(档位值, max_tokens - 余量)` 夹，构造 payload 时再夹一次
 * `max_tokens - 1`，两道保险。
 *
 * @module src/baizhi-messages.ts
 */

import type { RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'

import { BAIZHI_MAX_OUTPUT_TOKENS } from './baizhi-product.js'
import {
  consumeMinimaxSse,
  serializeMinimaxMessages,
  mapMinimaxStopReason,
  readMinimaxUsage,
  type ConsumeMinimaxSseOptions,
  type MinimaxInlineImage,
} from './minimax-messages.js'

/** 内联图片（裸 base64，交给 `serializeMinimaxMessages` 拼 Anthropic `image` 块）。 */
export type BaizhiInlineImage = MinimaxInlineImage

/** 未指定时的 `max_tokens`（与 monkeycode/messages 保持同一默认值）。 */
export const BAIZHI_DEFAULT_MAX_TOKENS = 4096

/** 思考预算下限（低于它上游不收）。 */
export const BAIZHI_MIN_THINKING_BUDGET = 1024

/**
 * 思考预算与 `max_tokens` 之间必须留的余量。
 *
 * `budget_tokens` 要**严格小于** `max_tokens`，而思考本身还要产出少许
 * `max_tokens` 之外的正文，留 1024 是「够正文喘口气」的经验值
 * （默认 4096 ⇒ high 档 8192 会被夹到 3072）。
 */
export const BAIZHI_THINKING_HEADROOM = 1024

/** 思考配置；`undefined` = 不发该字段。 */
export type BaizhiThinking =
  | { readonly type: 'enabled'; readonly budgetTokens: number }
  | { readonly type: 'disabled' }

/**
 * 归一化 `max_tokens`：非正/非有限 ⇒ 默认 4096；超过输出上限 ⇒ 夹到 100,000。
 */
export function baizhiMaxTokensFor(maxTokens: number | undefined): number {
  const raw =
    typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.floor(maxTokens)
      : BAIZHI_DEFAULT_MAX_TOKENS
  return Math.min(raw, BAIZHI_MAX_OUTPUT_TOKENS)
}

/**
 * 把 harness 的 effort 档位换算成思考预算。
 *
 * | effort | 档位预算 |
 * | --- | --- |
 * | `none` | 关闭思考 |
 * | `low` | 2048 |
 * | `medium` | 4096 |
 * | `high` | 8192 |
 * | 其它/`undefined` | 不发 `thinking` 字段（交给上游默认） |
 *
 * 回到「预算必须 < max_tokens」：先按 `max_tokens - 1024` 夹，
 * 夹完低于 1024 就直接关掉（发不出合法预算，只能不发）。
 */
export function baizhiThinkingFor(effort: unknown, maxTokens: number): BaizhiThinking | undefined {
  if (effort === 'none') return { type: 'disabled' }
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high') return undefined

  const ladder = effort === 'low' ? 2048 : effort === 'medium' ? 4096 : 8192
  const cap = maxTokens - BAIZHI_THINKING_HEADROOM
  const budget = Math.min(ladder, cap)
  if (budget < BAIZHI_MIN_THINKING_BUDGET) return { type: 'disabled' }
  return { type: 'enabled', budgetTokens: budget }
}

/** {@link buildBaizhiMessagesPayload} 的入参。 */
export interface BuildBaizhiMessagesPayloadOptions {
  model: string
  messages: readonly RequestMessage[]
  system?: string
  tools?: readonly ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
  /** 思考配置；`undefined` = 不发该字段。 */
  thinking?: BaizhiThinking
  /** 已内联的图片；缺失时遇图**抛错**（不静默丢图）。 */
  images?: ReadonlyMap<string, BaizhiInlineImage>
}

/**
 * 构造 Anthropic Messages 请求体。
 *
 * `stream: true` **恒真**：本插件的适配器只有流式一条路径。
 * `max_tokens` **必带**（Anthropic 协议必填；百智云同样必填）。
 */
export function buildBaizhiMessagesPayload(
  options: BuildBaizhiMessagesPayloadOptions,
): Record<string, unknown> {
  const maxTokens = baizhiMaxTokensFor(options.maxTokens)
  const payload: Record<string, unknown> = {
    model: options.model,
    max_tokens: maxTokens,
    stream: true,
    messages: serializeBaizhiMessages(options.messages, options.images),
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
    if (options.thinking.type === 'disabled') {
      payload.thinking = { type: 'disabled' }
    } else {
      // ⚠️ 第二道保险：无论调用方传什么，落盘的 budget 都严格小于 max_tokens。
      const budget = Math.min(
        Math.max(BAIZHI_MIN_THINKING_BUDGET, Math.floor(options.thinking.budgetTokens)),
        maxTokens - 1,
      )
      // max_tokens 小到放不下最小预算时，宁可不发 thinking 也不发非法请求。
      if (budget >= BAIZHI_MIN_THINKING_BUDGET) {
        payload.thinking = { type: 'enabled', budget_tokens: budget }
      }
    }
  }
  return payload
}

/**
 * 把复用实现抛出的 `minimax:` 前缀改成本家的。
 *
 * 只改**前缀**，其余文案逐字保留（那些文案里记录了真实踩坑细节）。
 */
function rewriteMinimaxErrorPrefix(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  if (!error.message.startsWith('minimax:')) return error
  const replaced = new Error(error.message.replace(/^minimax:/, 'baizhi:'))
  replaced.name = error.name
  return replaced
}

/** 序列化历史消息为 Anthropic 形状（转发 `serializeMinimaxMessages`）。 */
export function serializeBaizhiMessages(
  messages: readonly RequestMessage[],
  images?: ReadonlyMap<string, BaizhiInlineImage>,
): Array<Record<string, unknown>> {
  try {
    return serializeMinimaxMessages(messages, images)
  } catch (error) {
    throw rewriteMinimaxErrorPrefix(error)
  }
}

/**
 * 消费 Anthropic SSE 流。
 *
 * ⚠️ 用 `yield*` 包一层 `try/catch` 而不是直接 re-export：流中途抛出的错误
 * 也带 `minimax:` 前缀，必须一并改写；错误**原样抛出**（半截流重发会重复输出，
 * 与 minimax 自己的「`yieldedAny` 之后不重发」口径一致）。
 */
export async function* consumeBaizhiSse(
  options: ConsumeMinimaxSseOptions,
): AsyncGenerator<StreamChunk> {
  try {
    yield* consumeMinimaxSse(options)
  } catch (error) {
    throw rewriteMinimaxErrorPrefix(error)
  }
}

/** `stop_reason` 映射（纯字段映射，直接复用）。 */
export const mapBaizhiStopReason = mapMinimaxStopReason

/** `usage` 映射（`input_tokens` / `output_tokens` / cache 两类 / thinking）。 */
export const readBaizhiUsage = readMinimaxUsage
