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
 * ⚠️ 这是决定 payload 里 `tools` 键**形状**的唯一位置（adapter 只做「不传
 * `undefined`」，见 `marvis-adapter.ts`）。不下发函数定义，模型在 wire 上看不到
 * 任何工具，只能用正文里的 XML 臆造工具调用 —— 这条有 4 份独立记录佐证，见
 * `docs/agent-notes/providers-marvis.md`。
 *
 * ⚠️⚠️ 但**空数组不许下发**（返回 `[]` 时调用方必须把整个键省略）。
 * 「有工具却不下发 ⇒ 只能臆造」推不出「没有工具时也要发一个空数组」：
 * 省略 = 「本轮纯聊天，没有函数调用能力」，`[]` = 「有函数调用能力，但一个
 * 定义都没给」。**⚠️ 这两者在上游是否被区别对待，本仓零实测** —— 见下。
 *
 * **用户报障症状**（Gitee IKVL6C，2026-11-16）：`dsh-experimental-auto-review` 的
 * 评审那一轮没有工具 ⇒ wire 上是 `"tools": []` ⇒ 模型在正文里吐
 * `<｜｜DSML｜｜tool_calls>` ⇒ 上层严格 `JSON.parse` 崩在 `Unexpected token '<'`，
 * 12 次工具调用全失败。
 *
 * **⚠️ 证据强度分级（必读，别只看标题）**：
 * - **已核实的代码事实**（3 环）：① `buildMarvisPayload` 修前恒带 `tools`，空数组
 *   就是 `"tools": []`；② 评审那一轮 `options.tools` 确为 `undefined`
 *   （`dsh-experimental-auto-review` 的 `classifyRisk` 构造的 options 没有 `tools` 键）；
 *   ③ 该包 `parseDecision` 是**严格 `JSON.parse`**，与本机看到的
 *   `Unexpected token '<'` 形态一致；④ `marvis-adapter` 调 `consumeOpenAiSse` 时
 *   **没有** `dsmlToolMode: true` ⇒ `DsmlContentExtractor` 不装 ⇒ 正文原样到上层。
 * - **⚠️⚠️ 已被真机实发推翻（2026-11-16 对抗审计，20 样本）**：**`[]` 会让模型臆造**
 *   这一步**不成立**。本机**有** marvis 凭据（`~/.dsh/.credentials.yaml` 里 4 条
 *   `MARVIS_ACCOUNT_*`，其中 `marvis-30ce38d0` enabled 且未过期）⇒ 按 auto-review
 *   的真实请求形状做了两臂各 10 次受控实发（A = `"tools": []`，B = 省略 `tools`，
 *   交替顺序）：
 *   - **两臂都 0 次产出合法决策**（auto-review 要的是 `{"risk":…,"decision":…}`）；
 *   - 伪工具调用 A 7/10 vs B 8/10（p = 1.0，**无显著差异**）；
 *   - 全角 DSML A 0/10 vs B 1/10（新行为侧反而出现 1 次）。
 *   ⇒ **两种 wire 状态都是「零个工具」，模型都只能把调用写进正文；门控只改变臆造物
 *   的形状，不改变是否臆造。** 本修法**不是 IKVL6C 的修复**。
 * - ⚠️ 更正一条**早前的错误记录**：本文件与 `docs/agent-notes/providers-marvis.md`
 *   曾写「本机无 marvis 凭据 ⇒ 不能发请求」——**那是假事实**（当时的凭据探测用了
 *   错误的正则，漏掉了行首带缩进的 `MARVIS_ACCOUNT_*`）。这条错误曾被我用来为
 *   「不做受控测试」开脱，必须留痕，不要再犯。
 * - **反证面（必须一起读）**：本仓有 **4 条**「只差 tools 一个变量」的记录，**全部**
 *   是「**完全不发 tools** ⇒ 模型在正文臆造」：`codely-adapter.ts:694-712`（受控 A/B）、
 *   `dsml.ts:22-34`（OfficeAce 2026-10-13）、`qoder-adapter.ts:1762-1764`、
 *   `raccoon-adapter.ts:766-767`。⇒ **`[]` 的正向证据是 0 条**。
 *   两者不矛盾（`[]` 与省略是不同输入），但**本修法的定位是「预防性对齐（未验证）」，
 *   不是根因修复**。详见 `docs/agent-notes/providers-marvis.md`。
 *
 * ⚠️ 本仓口径（**只记结论，不记条数与行号** —— 那是必然腐坏的快照，
 * 接一个 provider 就失效，见 `AGENTS.md`）：
 * - **多数 provider 在 tools 为空时省略该键**，这是本仓的主流口径，新增 provider
 *   一律按此写；
 * - 但仍有一批是「无条件带」（`tools: buildXxxTools(input.tools)`，builder 对
 *   `undefined` 返 `[]` 且键无条件写出）⇒ **新增或修改 provider 时必须同时检查
 *   `*-messages.ts` 的 builder 是否会把 `[]` 写出去**，只改 adapter 是不够的；
 * - 那批「无条件带」的注释理由是**一条错误推论**：`modelscope` / `qiniu` 的
 *   `buildXxxPayload` 注释写着「`tools` 恒带（哪怕是空数组），这是
 *   `invalid_parameter_error` 事故的修法的一半」—— 而那条事故讲的是
 *   「**带了工具但形状不对** ⇒ 400 `'type' is a required property - 'tools.0'`」，
 *   与空数组**毫无关系**。别拿它当「恒带」的依据。
 * - 本次只改 marvis（用户要求单独修这一条），其余**登记未修**。
 *
 * ⚠️ `tools.length === 0` 这个早退分支在集成路径上**已是死代码**（门控保证非空），
 * 保留只为直接调用 `buildMarvisTools([])` 的用例与防御。
 */
export function buildMarvisTools(
  tools: readonly MarvisHarnessTool[] | undefined,
): MarvisWireTool[] {
  if (tools === undefined || tools.length === 0) return []
  // ⚠️ 稀疏数组（`new Array(3)`）的 `length` 是 3，但 `.map` **保留空洞** ⇒
  //    `JSON.stringify` 出 `[null, null, null]` ⇒ 上游 `'type' is a required
  //    property - 'tools.0'`（与本 PR 修的那条 `invalid_parameter_error` 同形）。
  //    `length > 0` 的门控拦不住它，故按**有效条目**判：先归一化空洞再 map。
  //    ⚠️ 只靠 `filter` 就够 —— `Array.prototype.filter` **跳过空洞**（不调 callback），
  //    所以 `Array.from(...)` 那层归一化是多余的（正向审计 P1-3 的同一条批评：
  //    零行为的装饰性分支会让后来者以为有两道兜底）。混排时有效条目顺序不变。
  return tools
    .filter((tool) => tool !== undefined && tool !== null)
    .map((tool) => ({
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
 * - `tools` 只在**非空**时下发（本仓主流口径；⚠️ 还有一批 provider 是「无条件带」，
 *   见 `buildMarvisTools` 的注释 —— 那里**刻意不记条数与行号**，因为那是必然腐坏的
 *   快照。`tools: []` 疑似会让模型在正文臆造工具调用，**但这一步仍是推断**）；
 * - `reasoning_effort` 只有非空字符串才带（非法值上游 400 `3000101`）。
 */
export function buildMarvisPayload(input: MarvisPayloadInput): Record<string, unknown> {
  // ⚠️ 非数组 `tools` **必须响亮报错**，不能静默省略（对抗审计 A5，本 PR 引入的
  //    回归）：修前 `tools: buildMarvisTools(input.tools)` 会在 `.map` 处抛错，
  //    修后 `length > 0` 对 `5` / `true` / `Symbol()` / `Object.create(null)` 一律
  //    false ⇒ **静默发出纯聊天请求**，错误被吞。TS 只挡得住仓内唯一调用点，
  //    而本函数是 `export` 的。
  if (input.tools !== undefined && !Array.isArray(input.tools)) {
    throw new TypeError(
      `marvis: options.tools 必须是数组或 undefined，收到 ${Object.prototype.toString.call(input.tools)}`,
    )
  }
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
