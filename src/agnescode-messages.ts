/**
 * AgnesCode 的 chat 请求体构造。
 *
 * ## 为什么工具要单独包装
 *
 * DSH 递进来的工具 schema 是 harness 的**扁平**形状 `{name, description, parameters}`，
 * 而 OpenAI 兼容端点要求外层 `type:'function'` + `function` 包装。原样透传会被
 * 上游 400（qiniu 那次真实事故：每次带工具的请求都被拒，而 DSH 的**每一次**真实
 * 对话都带工具 —— 症状是「额度一次都没消耗」，用户完全看不出来）。
 *
 * 消息序列化走共享实现（`serializeMessages`，纯协议转换、无厂商差异），
 * 本文件只负责**厂商特有的形状门禁**（工具包装 + 顶层字段白名单）。
 *
 * ## 思考档位：**不发**
 *
 * AgnesCode 的目录条目没有声明任何思考档位（`/v2/models` 的行里没有
 * `reasoning_effort` 一类字段），故不声明、也不发 —— 声明了却发不出去就是
 * 一个纯装饰的选择器（opencode 的 IKJJ0V）。
 *
 * @module src/agnescode-messages.ts
 */

import { foldSystemIntoMessages } from './system-prompt-fold.js'

/** DSH 的工具 schema（`GenerateOptions.tools` 的形状）。 */
export interface AgnescodeHarnessTool {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

/** OpenAI wire 侧的工具定义。 */
export interface AgnescodeWireTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

/** DSH 工具 → wire 工具（`options.tools` 的**唯一**出口）。 */
export function buildAgnescodeTools(
  tools: readonly AgnescodeHarnessTool[] | undefined,
): AgnescodeWireTool[] {
  if (tools === undefined || tools.length === 0) return []
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      // 空描述**整个省略**（不是发空串），与 `openai-compat` 同口径。
      ...(typeof tool.description === 'string' && tool.description.length > 0
        ? { description: tool.description }
        : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  }))
}

/** {@link buildAgnescodePayload} 的入参。 */
export interface AgnescodePayloadInput {
  model: string
  messages: ReadonlyArray<Record<string, unknown>>
  system?: string
  tools?: readonly AgnescodeHarnessTool[]
  temperature?: number
  maxTokens?: number
}

/**
 * 构造一次 chat 请求的完整 body。
 *
 * - `stream` **恒 true**：本适配器只走 SSE；
 * - `system` 折进 `messages[]` 的第一条（顶层 `system` 字段在多数 OpenAI 兼容
 *   实现里被静默忽略）；
 * - `max_tokens` 只放行**安全正整数**（0/负数/NaN 会让 DSH 抛
 *   `INVALID_MODEL_MAX_TOKENS`，那是崩，不是降级）；
 * - `tools` 恒带（可为空数组）：带工具的请求必须让上游看到该字段存在。
 * - `stream_options.include_usage` **恒带**（2026-11-19 真机取证）：不传它，上游整条
 *   流里**一帧 `usage` 都没有**（实测 10 帧全无），令牌台账因此永远是空的；带上后
 *   末帧回 `{prompt_tokens:92, completion_tokens:32, reasoning_tokens:31}`。
 *   这是 OpenAI 流式协议的标准开关，不依赖任何厂商扩展。
 */
export function buildAgnescodePayload(input: AgnescodePayloadInput): Record<string, unknown> {
  return {
    model: input.model,
    messages: foldSystemIntoMessages(input.messages, input.system),
    stream: true,
    stream_options: { include_usage: true },
    tools: buildAgnescodeTools(input.tools),
    ...typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? { temperature: input.temperature }
      : {},
    ...Number.isSafeInteger(input.maxTokens) && (input.maxTokens ?? 0) > 0
      ? { max_tokens: input.maxTokens }
      : {},
  }
}
