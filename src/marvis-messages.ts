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
 *
 * ⚠️⚠️ 但**空数组不许下发**（返回 `[]` 时调用方必须把整个键省略）。
 * 上面那句说的是「**有工具却不下发**」⇒ 模型看不到定义 ⇒ 只能臆造；
 * 它**推不出**「没有工具时也要发一个空数组」。两种状态在上游的语义不同：
 * 省略 = 「本轮纯聊天，没有函数调用能力」，`[]` = 「有函数调用能力，但一个
 * 定义都没给」⇒ 后者才是臆造的温床。
 *
 * **用户报障症状**（Gitee IKVL6C，2026-11-16）：`dsh-experimental-auto-review` 的
 * 评审那一轮没有工具 ⇒ wire 上是 `"tools": []` ⇒ 模型在正文里吐
 * `<｜｜DSML｜｜tool_calls>` ⇒ 上层严格 `JSON.parse` 崩在 `Unexpected token '<'`，
 * 12 次工具调用全失败。⚠️ **「`[]` 导致臆造」这一步是推断，未经受控对照**：
 * 本机无 marvis 凭据、auto-review 包不在依赖里（`parseDecision` 读不到），
 * 而本仓唯一一份「只差 tools 一个变量」的实测（`codely-adapter.ts:698-703`）
 * 结论**相反**（不带 tools 时模型才臆造）⇒ 本修法的诚实定位是
 * **「预防性对齐（未验证）」**，不是根因修复。详见
 * `docs/agent-notes/providers-marvis.md`。
 *
 * ⚠️ 本仓的分歧面（已全量核对，别再凭印象数「8 家」）：
 * - **门控**（`if (tools !== undefined && tools.length > 0)`）共 **8 家**：
 *   `autoclaw-adapter.ts:637` / `buddy-adapter.ts:2863` / `cline-adapter.ts:916` /
 *   `codely-adapter.ts:707` / `lobsterai-adapter.ts:1198` / `magicrew-adapter.ts:456` /
 *   `trae-adapter.ts:1277` / `zcode-adapter.ts:963`；
 * - **只判 `undefined`**（`...options.tools !== undefined ? { tools } : {}`）共 **7 家**：
 *   `modelscope-adapter.ts:862` / `opencode-adapter.ts:646` / `qiniu-adapter.ts:723` /
 *   `baizhi-adapter.ts:337` / `gemini-adapter.ts:685` / `monkeycode-adapter.ts:306` /
 *   `minimax-adapter.ts:853` —— 它们对 `[]` **照样**发 `"tools": []`，与修前的本文件同病；
 * - **无条件带**（`tools: buildXxxTools(input.tools)`）共 **5 家**，全是同一个模板的
 *   产物：`modelscope-messages.ts:123` / `opencode-messages.ts:181` /
 *   `qiniu-messages.ts:116` / `qoder-adapter.ts:1765,1814`（+ `buildQoderTools:599-603`
 *   对 undefined 返 `[]`）。**其中 modelscope / qiniu 的注释写着「`tools` 恒带
 *   （哪怕是空数组）」，并把理由挂在 `invalid_parameter_error` 那条事故上 —— 但那条
 *   事故讲的是「带工具但形状不对 ⇒ 400 `'type' is a required property - 'tools.0'`」，
 *   与空数组毫无关系 ⇒ 那是一个错误推论，然后被复制到了五家。**
 *   本次只改 marvis（用户要求单独修这一条），其余**登记未修**。
 *
 * ⚠️ 另：`codely-adapter.ts:698-703` 那份受控实测的方向与本修法**相反**，
 * 引用它当「门控先例」是错的 —— 它是**反证**，不是支持。
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
 * - `tools` 只在**非空**时下发（与 `autoclaw` / `buddy` / `cline` / `codely` /
 *   `lobsterai` / `magicrew` / `trae` / `zcode` 这 8 家同口径；`tools: []` 会让
 *   模型在正文臆造工具调用，见 `buildMarvisTools` 的注释）；
 * - `reasoning_effort` 只有非空字符串才带（非法值上游 400 `3000101`）。
 */
export function buildMarvisPayload(input: MarvisPayloadInput): Record<string, unknown> {
  return {
    model: input.model,
    messages: input.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(input.tools !== undefined && input.tools.length > 0
      ? { tools: buildMarvisTools(input.tools) }
      : {}),
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
