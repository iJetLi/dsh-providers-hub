/**
 * ModelScope 的 chat 请求体构造。
 *
 * ## ⚠️⚠️ 本文件存在的**唯一**理由：工具必须包装（真实事故）
 *
 * DSH 递进来的工具 schema 是 harness 自己的**扁平**形状
 * `{ name, description, parameters }`，而 OpenAI 兼容端点要求外层
 * `type:'function'` + `function` 包装。旧 fork 曾**原样透传**，实测后果
 * （`%TEMP%\proxy-upstream-error.json`，2026-10-07）：
 *
 * ```
 * upstream: modelscope  status: 400
 * {"error":{"code":"invalid_parameter_error",
 *           "message":"'type' is a required property - 'tools.0'"}}
 * ```
 *
 * 即 **modelscope 每次带工具的请求都被 400 拒绝**。而这在本插件里是
 * **每一次真实对话**（DSH 总会下发工具），于是症状是「魔搭的积分一次都没消耗」
 * —— 请求根本没被受理，且反代把它当「上游不可用」静默跳过，用户完全看不出来。
 *
 * ⇒ 包装形状与 `openai-compat.ts` / `buddy-adapter.ts` / `llm-adapter.ts`
 * 保持同口径，并配 `tests/unit/modelscope-messages.spec.ts` 的逐字节用例。
 *
 * ## ⚠️ 刻意**不**复用 `openai-compat.serializeMessages`（本项目已有先例）
 *
 * `openai-compat.ts` 的模块头写着：「既有适配器（buddy / lobsterai）**刻意不
 * 改用它**：那两份实现已被大量单测与线上流量验证过，重构它们属于与本任务无关的
 * 高风险改动。」
 *
 * 本 provider 的情况是**第三种**：它是**新 provider**，故**消息序列化**这一层
 * 直接复用共享实现（`serializeMessages`）—— 那是纯协议转换，没有厂商差异。
 * 而**工具包装**这一层之所以单独成文件，是因为它是**厂商特有的形状门禁**
 * （见上），且必须能被独立单测逐字节锁死。
 *
 * ## 思考档位
 *
 * 只发 `reasoning_effort` —— 这是旧 fork 唯一**实测过**的关思考参数名
 * （`remote-upstream.ts:77`）。同一处注释还列了两个候选
 * （`enable_thinking: false` / `thinking: {type:"disabled"}`），但**没有实测证据**
 * 说明哪个生效 ⇒ 不猜、不发。档位声明侧也只给 `none`（见
 * `modelscope-product.ts` 的兜底表）。
 *
 * @module src/modelscope-messages.ts
 */

/** DSH 的工具 schema（`GenerateOptions.tools` 的形状）。 */
export interface ModelscopeHarnessTool {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

/** OpenAI wire 侧的工具定义。 */
export interface ModelscopeWireTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

/**
 * DSH 工具 → wire 工具。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。不下发它，模型在 wire 上看不到任何
 * 函数定义，只能用正文里的 XML 臆造工具调用 —— qoder 的用户报障
 * 「执行任务出现任务调用 xml 泄露任务终止」就是这个根因。
 */
export function buildModelscopeTools(
  tools: readonly ModelscopeHarnessTool[] | undefined,
): ModelscopeWireTool[] {
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

export interface ModelscopePayloadInput {
  model: string
  messages: ReadonlyArray<Record<string, unknown>>
  system?: string
  tools?: readonly ModelscopeHarnessTool[]
  temperature?: number
  maxTokens?: number
  /**
   * 思考档位（`GenerateOptions.reasoningEffort` 的字符串形态）。
   *
   * ⚠️ 声明了档位就**必须真的发出去**，否则选择器只是 UI 装饰 ——
   * 用户选了「关闭思考」却没有任何效果（issue IKJJ0V 的同款教训）。
   */
  reasoningEffort?: string
}

/**
 * 构造一次 chat 请求的完整 body。
 *
 * 契约细节（每条都对齐仓库既有适配器）：
 * - `stream` **恒 true**：本适配器只走 SSE 路径，没有非流式分支；
 * - `system` 只有非空才带（空串会被上游当成一条空 system 消息）；
 * - `max_tokens` **只放行安全正整数** —— 0 / 负数 / NaN 会让 DSH 侧抛
 *   `INVALID_MODEL_MAX_TOKENS`，把整轮对话搞崩（不是降级，是崩）；
 * - `tools` **恒带**（哪怕是空数组）：带工具的请求必须让上游看到 `tools`
 *   字段的存在，这是 `invalid_parameter_error` 那条事故的修法的一半
 *   （另一半是包装形状本身）。
 */
export function buildModelscopePayload(input: ModelscopePayloadInput): Record<string, unknown> {
  return {
    model: input.model,
    messages: input.messages,
    stream: true,
    stream_options: { include_usage: true },
    tools: buildModelscopeTools(input.tools),
    ...input.system !== undefined && input.system.length > 0 ? { system: input.system } : {},
    ...typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? { temperature: input.temperature }
      : {},
    ...Number.isSafeInteger(input.maxTokens) && (input.maxTokens ?? 0) > 0
      ? { max_tokens: input.maxTokens }
      : {},
    ...typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0
      ? { reasoning_effort: input.reasoningEffort }
      : {},
  }
}
