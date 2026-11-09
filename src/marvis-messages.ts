/**
 * 腾讯 Marvis 的 chat 请求体构造。
 *
 * ## 为什么单独成文件
 *
 * 工具必须包装成 `{type:'function', function:{...}}` —— 本仓 2026-10-07 的
 * 真实事故（modelscope 逐字相同）：原样透传 DSH 的扁平 schema 会让上游回
 * `400 'type' is a required property - 'tools.0'`，而 DSH **每轮都带工具**，
 * 于是「一次都没请求成功」且反代把它当上游不可用静默跳过。
 *
 * 消息序列化复用共享的 `serializeMessages`（纯协议转换、无厂商差异）；
 * 只有**工具包装**与**字段白名单**是厂商特有的形状门禁，故在此独立成文件。
 *
 * ## 与 modelscope 的两处差异（都是 Marvis 特有）
 *
 * 1. **`stream_options: { include_usage: true }` 恒带**：Marvis 的 SSE 只有
 *    在请求里声明它时才会在末帧下发 `usage`（2026-11-09 实测），而账本
 *    （`wrapAdapterWithTokenLedger`）没有 `usage` 就记 0。
 * 2. **不发 `reasoning_effort` 之外的思考参数**：Marvis 的思考默认开启，
 *    `none` 才真正关闭（实测 `reasoning_tokens=0`）；但目录**刻意不声明**
 *    `reasoning.efforts`（用户裁定「抄 magpie」），所以正常情况下这个字段
 *    不会出现 —— 保留透传只是为了「若将来声明了档位就必须真的发出去」
 *    （IKJJ0V：声明了却不发 = 选择器是 UI 装饰）。
 *
 * @module src/marvis-messages.ts
 */

/** DSH 的工具 schema（`GenerateOptions.tools` 的形状）。 */
export interface MarvisHarnessTool {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

/** OpenAI wire 侧的工具定义。 */
export interface MarvisWireTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

/**
 * DSH 工具 → wire 工具。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。不下发它，模型在 wire 上看不到任何
 * 函数定义，只能用正文里的 XML 臆造工具调用。
 */
export function buildMarvisTools(
  tools: readonly MarvisHarnessTool[] | undefined,
): MarvisWireTool[] {
  if (tools === undefined || tools.length === 0) return []
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      // ⚠️ 空描述**整个省略**（不是发空串）：与 `openai-compat` 同口径。
      ...(typeof tool.description === 'string' && tool.description.length > 0
        ? { description: tool.description }
        : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  }))
}

export interface MarvisPayloadInput {
  model: string
  messages: ReadonlyArray<Record<string, unknown>>
  system?: string
  tools?: readonly MarvisHarnessTool[]
  temperature?: number
  maxTokens?: number
  /** 思考档位（`GenerateOptions.reasoningEffort` 的字符串形态）。 */
  reasoningEffort?: string
}

/**
 * 构造一次 chat 请求的完整 body。
 *
 * 契约细节（每条都对齐仓库既有适配器）：
 * - `stream` **恒 true**：本适配器只走 SSE 路径；
 * - `stream_options` **恒带** `include_usage`（见模块头）；
 * - `system` 只有非空才带；
 * - `max_tokens` 只放行安全正整数 —— 0 / 负数 / NaN 会让 DSH 侧抛
 *   `INVALID_MODEL_MAX_TOKENS`，整轮崩；
 * - `tools` **恒带**（哪怕空数组）；
 * - `reasoning_effort` 只有非空字符串才带（非法值上游 400 `3000101`）。
 */
export function buildMarvisPayload(input: MarvisPayloadInput): Record<string, unknown> {
  return {
    model: input.model,
    messages: input.messages,
    stream: true,
    stream_options: { include_usage: true },
    tools: buildMarvisTools(input.tools),
    ...(input.system !== undefined && input.system.length > 0 ? { system: input.system } : {}),
    ...(typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? { temperature: input.temperature }
      : {}),
    ...(Number.isSafeInteger(input.maxTokens) && (input.maxTokens ?? 0) > 0
      ? { max_tokens: input.maxTokens }
      : {}),
    ...(typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0
      ? { reasoning_effort: input.reasoningEffort }
      : {}),
  }
}
