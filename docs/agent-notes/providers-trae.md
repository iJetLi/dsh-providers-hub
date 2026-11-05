<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## TRAE（字节跳动）协议要点（五个易踩的坑）

`trae` 的 chat 链路与其它 provider **全程不同构**，以下是实测/逆向确认的关键约束：

0. **⭐ 必须先做「消息序列化」，再做载荷转换**（`serializeTraeMessages`）：
   DSH 交给适配器的 `options.messages` 是**原生块结构**
   （`content:[{type:'tool-call'}]` / `[{type:'tool-result'}]` / `[{type:'reasoning'}]`），
   **不是** OpenAI wire 格式。必须先转成 `tool_calls` + 独立 `role:'tool'` 消息，
   **再**交给 `transformToSOLOBody`（后者只认识 `type:'text'`）。

   **真实缺陷**：早期实现把原生块**原样**透传，后果是**每一轮多步对话都坏掉**：
   `tool-call` 不是 SOLO 认识的字段 → **模型看不到自己调用过什么**；
   `tool-result` 同样不被识别 → **模型永远看不到工具返回值**，于是反复请求
   同一个工具或凭空编造结果。全程**没有任何报错**，极难排查。
   三个兄弟适配器（`llm-adapter.ts` / `buddy-adapter.ts` / `lobsterai-adapter.ts`）
   都有这一步，只有 TRAE 漏了 —— 本文件甚至早已 `import` 了
   `resolveToolPairing` 却从未使用，说明当初打算写但没接上。
   已由 `tests/unit/trae-adapter.spec.ts` 的「消息序列化（真实缺陷回归）」锁死。
1. **请求体必须转换，不能透传**（`transformToSOLOBody`）：
   - `stream` 强制 `true`；注入 `function: "solo_work_lite"`（实测 `work` / `solo` / `work_lite` 均无效）
   - `model` 同时写入 `config_name` 与 `model` 两个字段；内部名后缀 `__dev` 需去除
   - `messages[].content` 字符串 → `[{type:"text",text:...}]`
   - assistant 的 `tool_calls[].function` → **`function_call`**（SOLO 字段名），无 `name` 的条目须剔除（上游 `FunctionCall.Name` 必填）
   - ⚠️ **`tools[].function.parameters` 必须序列化为 JSON 字符串**（SOLO 上游要求 string，OpenAI 标准是 object）。因此 **tools 必须放进源的 OpenAI 对象里再交给转换函数** —— 若在转换**之后**再补 `bodyObj.tools`，`normalizeTools` 已执行完毕，parameters 会保持对象形态发给上游被拒（真实缺陷，已由 `tests/unit/trae-adapter.spec.ts` 锁死）
2. **响应是 SOLO 自定义 SSE，不是 OpenAI 格式**（`parseTraeSSELine` / `aggregateTraeSSE`）：事件为 `metadata` / `timing_cost` / `output` / `extra_info` / `token_usage` / `done` / `error`；正文在 `output.response`、思考在 `output.reasoning_content`；`tool_calls` 内层同样用 `function_call` 字段且带 SOLO 专属的 `namespace` / `partial_arguments`（须清理掉，只留标准 `function.{name,arguments}`）。解析须兼容 `data: {...}` 与 `data:{...}`（实测无空格）
3. **凭据必须持久化两个机器指纹**（`buildTraeCredential` / `applyTraeRefresh`）：
   - `machine_id`：**32 位 hex** 设备指纹。**续期时绝不可重新生成** —— 服务端按它标识设备，换了可能要求重新登录
   - `device_id`：**32 位 hex** 签到设备号（`login.sh:34` 的 `openssl rand -hex 16`，与 machine_id 同格式）。**账号间必须互异**，同一天两账号共用会被「该设备已签到」拦截；为空则签到报 9004
4. **`4001 param is invalid` 有三个独立成因**（见下「TRAE 的『通道（`function`）』」）：
   最普遍的是**发错了通道**（模型只在列出它的通道里可调用）；其次是模型本身是
   `is_custom_model` 条目；再次是**请求头被叠成重复值**（`content-type` 大小写各写一次）。
   早期把 `4001` 归因于 `X-Ide-Version` 过低（`0.1.43` 请求 `glm-5.3` 报错、
   `0.1.52` 正常）—— **本次复测未能重现该结论**：`glm-5.3` 在 `0.1.52` 与 `0.1.43`
   下**都**正常返回，故该归因**不足以作为 `4001` 的解释**，已降级为「未复现的旧观察」。
5. **⚠️⚠️ `4027 tool call failed` = 工具的 `parameters` 不是 object（2026-10-23 实测，第三个码）**

   **用户报障**（与 buddy 系**同一个根因**、第三个上游）：
   `trae: tool call failed: tools.0.function.parameters must be a JSON Schema of type object … (code=4027)`。

   **分流表（先按它判方向，别被 `4001` 带走）**：

   | 码 | 含义 | HTTP | 藏在哪 |
   |---|---|---|---|
   | `4001` | param invalid（三个独立成因，见下节） | 200 | 流内 `event:error` |
   | `4006` | 请求体体积超限 | 200 | 流内 |
   | **`4027`** | **工具 `parameters` 不是 JSON Schema object** | **200** | 流内（`event:progress_notice` 之后） |
   | `4008` / `1005` | 配额耗尽 / plan 权益不足 | — | — |

   ⚠️⚠️ **`4027` 的 HTTP 是 200** ⇒ 只看状态码会把它误判成「成功但没内容」
   （与本文件「`4006` 不得归 `SERVER`」**同一形态**）。判「成功」必须看流是否产出正文。

   ⚠️ **`tools.0` 不是「第 0 个工具坏了」的通例**，而是问题工具恰好排第 0
   （本仓工具按名排序，`analyzeImage` 恰在首位）⇒ 排查**必须**先解出 `tools.N` 是哪个工具。

   **根因与修法**：本插件的 `analyzeImage` 工具把 `parameters` 写成了空对象 `{}`。
   TRAE 按本文件笔记 ① 要求它**序列化为 JSON 字符串**，于是发出去的是 `"{}"` ——
   一个**合法 JSON 字符串**、但**不是** object schema ⇒ 4027；腾讯两站不要求字符串、
   直接收对象形态，看到 `{}` 缺 `type` ⇒ 11129。**同一份缺陷、三种校验口径。**

   ⇒ 已修成 `{ type: 'object', properties: {} }`（三者都过），并加**路由作用域**摘除
   （`src/codearts-vision.ts`）：该工具只服务 codearts，而本插件注册 20 个渠道、
   工具表是**进程全局**的 ⇒ 别家（buddy/workbuddy/trae/…）**根本不该看到它**。
   真机复核（TRAE 账号、经真实注册入口）：实发 **279/280**（不含该工具）、
   **即使用未修 schema 的原样清单也不被拒**。取证链见 `src/codearts-vision.ts` 模块头。

其它要点：`exchange` 的 `refresh_token` 会**轮换**（续期后必须回写）；错误分类见 `src/trae-errors.ts`，其中 `4008`（配额耗尽）与 `1005`（plan 权益不足）是 TRAE 最主要的失败模式。

### ⚠️ TRAE 的「通道（`function`）」：模型只在列出它的通道里可调用

**真实缺陷**（用户报障「使用模型时报 `trae: We're sorry, the param is invalid.
Please try with a valid param. (code=4001)`」）。

#### 症状定位

该文案**只**在 `src/trae-adapter.ts` 的 `consumeSse` 流内 `event:error` 分支拼出 ——
说明 **HTTP 是 200**（请求已被接受），上游在**参数校验阶段**才拒绝。

#### 三个独立成因（都实测过，别混为一谈）

| 成因 | 判据 | 实测 |
|---|---|---|
| ① 模型是「需自行配置的自定义模型」 | `display_config.is_custom_model === true` | **5/5 命中、0 误报** |
| ② **发错了通道** | 该模型不在所发 `function` 的目录里 | 见下路由矩阵 |
| ③ 请求头 `content-type` 被叠成重复值 | 实际发出 `"application/json, application/json"` | HTTP 400 + `code=4001 binding: … missing required parameter` |

**①** 的 5 个条目（2026-09-19 快照）：`deepseek-v4-flash` / `glm-5.3-flash` /
`qwen3.8-flash` / `agnes-2.5-flash` / `silk-gpt-5.6-luna`。

> ⚠️ **该名单已过期，不要再据此删模型**（复测 2026-09-20）：`deepseek-v4-flash` /
> `agnes-2.5-flash` / `silk-gpt-5.6-luna` 已**下架**；`glm-5.3-flash` /
> `qwen3.8-flash` 已转为 `is_custom_model: false`，**是正常可调用的合法模型**；
> 全目录 custom 条目数为 **0**。判据是**标志的值**，不是模型名 —— 曾把
> `qwen3.8-flash` 误记为「应被剔除」，差点误删一个可用模型。

**② 是本节重点**。实测路由矩阵（2026-09-19，逐模型 × 逐通道）：

| model | `solo_agent_remote` | `solo_work_lite` |
|---|---|---|
| `glm-5.2` / `kimi-k3` | OK | OK |
| `glm-5.1` / `qwen-3.5` / `Doubao-Seed-Code` | **OK** | 流内 `4001` |
| `glm-5-turbo` / `sagitta` / `seed-code-pro-0430` | 流内 `4001` | **OK** |

即**「模型属于哪个通道，就只能在那个通道里调用」**。旧实现把 `function` 写死
`solo_work_lite`，于是 agent 专有模型一用就报 `4001`。

**③ 是排查时最容易自伤的**：`{ ...headers, 'content-type': 'application/json' }`
与已有的 `Content-Type` 大小写不同，`Headers` 按 `append` 语义**合并**成非法值。
**写探针/代码时务必用 `new Headers(base).set(...)`，不要用对象展开叠同名头。**

#### 通道目录怎么拿：`batch_get_detail_param`（**不是** `get_detail_param`）

真实 CN IDE 用的是**批量**端点，一次传多个 `functions`，响应 `function_configs[]`
为**每个通道各自一套** `config_info_list`：

```
POST {agentHost}/api/ide/v1/batch_get_detail_param
{ "functions": ["solo_work_lite","solo_agent_remote"], "show_custom_model": true,
  "agent_type": "", "current_config_info": {"config_name":"","is_custom_model":false},
  "mode_type": 0, "access_type": 0, "ab_force_vids": "", "ab_autotest_advanced_mode": 0 }
```

单 function 的 `get_detail_param` 只能拿一个通道的目录，**不要**再用它。

#### 「可调用」与「官方可见」是两个独立维度

| 标志 | 含义 | 本插件处理 |
|---|---|---|
| `display_config.is_custom_model` | 需在 IDE 内自行绑定供应商 | **必须剔除**（必然 4001） |
| `config_switch === false` | 上游已停用 | **必须剔除** |
| `is_invisible_to_user` | **官方 picker 不展示** | **必须剔除**（硬性，使目录与官方 Auto Mode 一致） |
| `usage !== 'chat_completion'` | 非对话用途（summary / fast_apply / multimodal…） | **必须剔除** |

> **历史修正**：早期实现把 `is_invisible_to_user` 当作「两个独立维度」而默认保留
> （理由是实测 `glm-5.1` 被官方隐藏却**可调用**）。后来用户要求目录与官方
> **Auto Mode 选择器完全一致**，该标志遂改为**硬性过滤** —— 代价是
> `glm-5.1` / `qwen-3.5` 等「可调用但官方不展示」的模型不再出现在目录里
> （目录 47 → 29）。这是**有意的取舍**（对齐官方 UI），不是回归；
> 被过滤的模型若已被持久化为会话模型，`resolveModel` 仍能解析。
> 需要临时放宽时改 `parseTraeBatchModelList` 的过滤条件，不要动
> `isTraeModelCallable`（那里管的是「必然调不通」）。

#### 远端参数必须消费（这一条曾被整段漏掉）

- `context_window_tokens.dev` → `contextWindow`。⚠️ 常规会话用 `dev`
  （条目形如 `{dev:200000, max:1000000}`）；`max` 只在**开启 Max 模式**时才声明
  （见下「TRAE 的 Max 模式」），无脑采信 `max` 会让 DSH 以为有 1M 窗口而实际请求被拒。
- `model_detail_list[].max_tokens` → `maxOutputTokens`。实测**主流模型是 32000**
  （旧兜底表写的 131072 / 128000 是估值，**已被推翻**）；多条明细优先取 `__dev` 那条，
  Max 模式那条（`__max`）另存为 `maxModeOutputTokens`。
- `reasoning_effort_config` → `reasoningConfig`（见下「TRAE 的推理强度档位」）。

**真实缺陷**：接口 `TraeRemoteModel` 早已声明这两个字段、`contextWindowFor` /
`maxOutputTokensFor` 也在读，但解析器**从未填充** → 远端值被静默忽略、恒回退兜底表
估值。现由 `parseTraeBatchModelList` 填充，兜底表数值同步修正为 200000 / 32000。

#### TRAE 的推理强度档位（`reasoning_effort_config`）

真实条目：

```json
"reasoning_effort_config": {
  "default_level": "high",
  "options": ["light", "high", "extra_high"],
  "support_thinking": true
}
```

要点：

- **`options` 是单值字符串**，既是产品侧档位名、也是发给上游 `reasoning_effort` 的
  wire 值。⚠️ 这与 LobsterAI 的 `level` / `openclawLevel` **双字段**形态不同 ——
  不要照搬那张映射表；TRAE 的展示名表（`TRAE_EFFORT_NAMES`）**只用于美化**，
  不参与 wire 取值。
- 不声明 `reasoning` 的两种情形：**远端没有该配置**（UI 显示「当前模型未提供
  推理等级」）与 **`support_thinking === false`**（远端明确说不支持思考）。
  后者若照旧声明档位，会让用户选一个发了也没用的值。
- ⚠️ **默认档优先采信远端 `default_level`**（2026-09-26 变更，此前是「一律取最强档」）：
  用户报障「为什么默认是最高档位的思考？按说应该用次高档做默认吧？」。旧行为
  （AGENTS.md 更早版本记的「用户要求所有模型默认用 max」）代价是每次请求都顶格
  思考，而思考 token **计入 `completion_tokens`**、与正文共享额度。
  现规则见 `defaultTraeEffort()`：`default_level` **存在且在 `options` 内**就用它，
  否则退 `strongestTraeEffort`。实测 6 个模型的新旧对照：

  | 模型 | options | 上游 `default_level` | 旧默认 | 新默认 |
  |---|---|---|---|---|
  | `deepseek-v4.1-flash` | light,high,extra_high | `high` | extra_high | **high** |
  | `glm-5.2` | high,extra_high | `high` | extra_high | **high** |
  | `qwen3.8-max` | light,high,extra_high | `high` | extra_high | **high** |
  | `Doubao-Seed-2.1-Pro` | light,high | `high` | high | high |
  | `glm-5.3` | light,high,extra_high | `extra_high` | extra_high | extra_high |
  | `kimi-k3` | light,high,extra_high | `extra_high` | extra_high | extra_high |

  ⚠️ **不要改成「固定取次高档」**：后两行说明上游**自己**在 `glm-5.3` / `kimi-k3`
  上选了最高档，机械取次高会把它们无谓降下来。以**上游的判断**为准。
- ⚠️ **`default_level` 是外部输入，必须校验它在 `options` 内**：DSH 会拿
  `defaultEffort` 直接发请求，给不存在的档位抛 `UNSUPPORTED_REASONING_EFFORT`
  （`dsh-llm` 的 `resolveCallWithInfo`）。实测上游确实会下发
  `default_level: 'max'` 而 `options` 里没有 `max` —— 此时必须退到最强**可用**档。
- ⚠️ **UI 里没有「Default（跟随上游默认）」这一档**：`dsh-client-ui-model-selection`
  只在 `reasoning.defaultEffort === undefined` 时才注入该选项
  （`client.js` 的 `effortChoices`）。我们总是声明 `defaultEffort`，故用户可选项
  只有 `Light / High / Extra High`。
- ⚠️ **DSH 不按模型记忆档位**：切换模型时走 `client.js` 的
  `state.current?.provider === group.id && state.current.model === model.id ? … :
  model.reasoning?.defaultEffort` —— 切到别的模型再切回来取的是**新模型的
  `defaultEffort`**，不是上次手选的档位。故「切走再切回仍是最高档」在旧行为下
  是必然结果（默认档就是最高档），不是"记住了"。**区分方法**：先选次高档
  `high`、切走、再切回，若回到 `extra_high` 即为该机制而非记忆。
- ⚠️ **`extra_high` 下正文可能为空，这是模型行为、不是档位被拒**：实测
  `maxTokens` 给到 4096，同一档位重复调用仍**随机地**有时返回「好的」、有时
  只回思考不吐正文（`outputTokens` 仅 41~113、几乎全是 `reasoningTokens`，
  `finish.reason` 均为 `stop`）。故 e2e **不要断言「正文非空」**（会随机失败），
  判据用 `finish.reason.kind === 'stop'`。排查脚本
  `scripts/probe-trae-effort-stream.ts <model> <effort|''> <maxTokens>`（打印
  每个 chunk 类型、usage 与 finish 原因；**消耗额度**）。
- `defaultEffort` 必须落在 `efforts` 内 —— DSH 会拿它直接发请求，给一个不存在的
  档位会抛 `UNSUPPORTED_REASONING_EFFORT`。因为取值来自 `options` 本身，天然满足。
  实测 DSH 侧物化逻辑：`dsh-llm` 的 `LlmRuntime` 在 `requested ?? reasoning.defaultEffort`
  处把默认档写进 `config.reasoningEffort`（调用方不传时），并校验成员关系 ——
  所以**只声明 `defaultEffort` 即可**，适配器不必自己补发 `reasoning_effort`。
- 下发：`stream()` 把 `options.reasoningEffort` 原样写进 `reasoning_effort`，
  **不做白名单校验**（校验只会把「远端新增档位」变成静默丢弃）。
- ⚠️ `options` 为**对象数组**（`{level, openclawLevel}`）时取 `openclawLevel`、
  回退 `level` —— 这是防御性兼容：上游若改成双字段形态，解析不会退化成空数组。

#### TRAE 的 Max 模式（1M 上下文，**默认开启**）

`display_config.max_mode === true` 的模型支持 **Max 模式**（1M 窗口）。协议逆向自
`Trae2api-cn/src/trae_remote_client.py:249-397`（`_max_mode_requested` /
`_max_mode_fields`），要点：

- **不能只把 `max_tokens` 调大**：上游按 `strategy=max` +
  `model_auto_selection.strategy=max` 判定「这是 Max 会话」，缺了它们只会被当成
  常规会话、按 200K 校验，然后拒绝 1M 的输入。三件套
  （`context_window_size` / `prompt_max_tokens` / `max_tokens`）必须**成套**下发。
- 常量：1M 窗口 / **936K** 提示词预算 / **64K** 输出上限 / `mode_type: 1`
  （`TRAE_MAX_CONTEXT_TOKENS` 等）。936K < 1M 是刻意的 —— 给输出留位。
- ⚠️ **默认开启**（用户要求「上下文用最大的那一档」）：`resolveMaxModeFlag` 只有
  见到显式假值（`DSH_TRAE_MAX_MODE=0`/`false`/`no`/`off`）才关闭。**不要**改回
  `isTruthyFlag`（那是「默认关」语义，混用会让开关静默失效）。
- ⚠️ **三个条件缺一不可**（`TraeAdapter.maxModeFor`）：
  1. 产品级 `DSH_TRAE_MAX_MODE` **未关**（默认开；Max 会话计费倍率不同，要省额度时设 `0`）；
  2. 远端 `display_config.max_mode === true` —— **绝不**给未标记的模型硬套 Max 参数，
     CN 项目原注释明写 *"Never fabricate max limits for a model the account config
     does not mark"*，上游会拒；
  3. `DSH_TRAE_MAX_MODELS` 白名单（留空/含 `*` = 全部）。
- 未标 `max_mode` 的模型即便开关为开也**仍走 `dev`(200K)** —— 开启不会让任何模型失败，
  这部分「最大的那一档」就是它自己能用的最大档。
- **注入点在 `clampTraeMaxTokens` 之后**：Max 会话的输出上限由 `__max` 明细声明
  （实测 `custom_model_1M__max` 384000 vs `__dev` 64000），被 64K clamp 覆盖会让
  Max 请求与常规请求的输出预算相同、失去意义。
- `resolveModel` 同步切换：Max 生效时 `contextWindow` 用 `max`（1M）、
  `defaultMaxTokens` 用 `maxModeOutputTokens`；未生效时仍用 `dev`（200K）。
  **两者绝不能混用** —— 未开 Max 却声明 1M 会让 DSH 把超长上下文直接发出去，
  上游按 200K 校验后拒绝。

#### ⚠️ TRAE **支持图片**，但必须逐模型判定（Issue #IKHDKC）

**真实缺陷**（用户报障「TRAE字节 模型不支持图片」）：早期 `inputModalitiesFor`
恒返回 `['text']`（参数名是 `_model`，即**刻意忽略模型**），理由写的是
「SOLO 通道未见图片能力」。后果不只是「少个功能」——`inputModalities` 是
**DSH 的准入闸门**，图片在**附件入库阶段**就被拒
（`session/attachment-invalid`），用户看到「当前模型不支持图片，请切换支持
图片的模型」，而报错把原因指向**模型**，真实原因是**插件**。

**实测证伪**（2026-09-21，真实凭据）：

1. 远端目录**一直**在 `display_config.multimodal` 里声明该能力 —— 它与
   `max_mode` / `is_custom_model` 是**同一层级的相邻字段**，当初读了一个漏了另一个
   （52 个可调用条目中 27 个为 `true`；本插件可见集 19 个中 15 个为 `true`）；
2. **直发图片，模型真的看得见**：纯红图答「红色」、纯蓝图答「蓝色」、
   不带图答「无法确定」—— 三次答案不同，且无图时思考链明说「并没有提供图片」。
   ⚠️ 只验「不报错」不够：**静默丢图同样不报错**，必须做这种三连对照；
3. **反向对照定死判据**：`multimodal: false` 的模型（`DeepSeek-V4-Pro-Official`）
   收到图后答「无法确定」、思考链说「但没有图片」，**与不带图的回答一致**
   → 该标志是**权威准入判据**，不能按 provider 一刀切。

⚠️ **两个字段是两种独立能力，不可合并**：`multimodal`（用户贴图）与
`tool_response_multimodal`（工具结果图能否回传）。实测 `deepseek-v4.1-flash`
前者 `true`、后者 `false`；Doubao / Kimi 系列两者皆 `true`。
本插件**只消费 `multimodal`**，另一个仅保留信息。

⚠️ **请求形态无需协议逆向**：`transformToSOLOBody` 对**数组形态的 content
原样透传**，所以 OpenAI 的 `{type:'image_url',image_url:{url}}`（data URL）
直发即被接受 —— 与 buddy / lobsterai 适配器**完全同款**，没有 TRAE 专属转换。

落点（四处）：

1. `src/trae.ts`：`TraeRemoteModel` 加 `multimodal` / `toolResponseMultimodal`，
   `parseTraeConfigEntry` 与 `maxMode` 相邻处读取（含 PascalCase 回退）；
2. `inputModalitiesFor(model)` 改为 `remoteMeta.get(model)?.multimodal === true
   ? ['text','image'] : ['text']`（**未声明按不支持**，不臆造能力）；
3. `listModels` / `resolveModel` **两个出口**都改用它（漏一个闸门仍会拦图）；
4. `stream()`：按模型判定 —— 声明支持则读 `readImage` 字节转 data URL
   （`collectImages` 递归收集 + `userContentParts` 递归序列化，
   **两侧必须对称**）；不支持则明确报错且**不发请求**。

⚠️ `readImage` 必须由 `index.ts` 桥接（`makeReadImage(ctx)`）。缺失时收到图片
报「需要附件服务」而**不是**静默丢图；字节读取失败时留 `[image unavailable]`
占位符（空 Map 不能降级为 undefined，否则占位符也被跳过）。

#### 修法落点（四处）

1. `parseTraeBatchModelList`（`src/trae.ts`）按通道合并目录，每条记上 `function`
   与三个标志；同一 `config_name` 出现在多个 function 时**后面的覆盖前面的**
   （后面的条目带更完整的 `reasoning_effort_config` / `model_detail_list`）。
   同时执行三条硬性过滤：`usage !== 'chat_completion'` / `config_switch === false` /
   `is_invisible_to_user === true` 全部剔除。
2. `TraeAdapter.listModels` 过滤掉 `is_custom_model === true` 与 `isHidden === true`
   （`remoteMeta` 保留全量，已持久化的模型 id 仍可解析）。
3. `TraeAdapter.channelFor(model)` → `transformToSOLOBody(body, undefined, channel)`：
   **发送时按该模型所属通道下发 `function`**，查不到才回退 `product.function`。
4. `traeStreamErrorMessage` 给 `4001` 追加「模型不被上游接受」，同时**保留**上游原文
   与错误码。其余错误码保持原文，**不做无依据的解释**。

> ⚠️ `hideInternalModels`（`DSH_TRAE_HIDE_INTERNAL`）与 `isTraeModelUsable` 的
> `hideInternal` 参数**已废弃**：`is_invisible_to_user` 现在是**硬性过滤**，因为
> 目录要与官方 Auto Mode 选择器一致。字段保留仅为兼容既有 profile。
> `channels` 默认已改为 `['solo_agent', 'solo_work_lite', 'solo_agent_remote']`，
> 首位 `solo_agent` 对应截图 Auto Mode 的模型列表。

#### 真实 CN IDE 的其它情报（Reqable 抓包，`Trae CN.exe 3.3.94`）

- 头：`x-ide-version: 3.3.94` / `20260820`、`x-app-version: default`、
  `package-type: stable_cn`、`x-lgw-req-sdk-type: 3`、UA `TraeClient/TTNet`；
  `x-machine-id` 是 **64 hex**、`x-device-id` 是 **16 位数字** —— 与本插件的
  32hex/32hex **不同**（本插件走的是旧 SOLO 协议，勿照搬）。
- `llm_utils_chat` / `create_agent_task` 的**请求体是加密的**（配 `x-helios` /
  `x-medusa` / `x-neptune` / `x-request-pin` / `x-requested-at`）。实测**仅换版本头
  解不开**加密的那批模型（`deepseek-v4-flash` 等仍失败）→ 门槛是加密信封本身，
  属独立工作量，**尚未实现**。
- 另有 22 个 function（`chat_v3` 58 / `builder_v3` 51 / `solo_coder` 46 / `solo_agent`
  66 …）与非对话通道（`multimodal` / `system_diagnosis`）；本插件只默认启用实测过的
  `solo_work_lite` + `solo_agent_remote`（`DSH_TRAE_CHANNELS` 可覆盖）。

> **排除性证据**（都做过，别重复走）：消息序列化 / `tools.parameters` / 多轮
> `tool_calls`+`tool` 结果、`max_tokens`（64000 与 128000）**全部通过**；
> 兜底表 id 也都真实存在；`X-Ide-Version` 的旧归因**未复现**（`glm-5.3` 在
> `0.1.43` 与 `0.1.52` 下都通过）。
> ⚠️ 曾经把上面的 ③ 误判为「突发限流」和「host 不匹配」——两次都是错的。
> **全 4001 时先检查自己发的头**，再怀疑上游。

### ⚠️ 登录回调**没有** `code`：直接回传 token，参数名是 `auth_callback_url`

**真实缺陷**（用户报障「网页一直停在认证中的界面」）：早期实现按 OAuth 惯例
把 TRAE 当成标准的授权码流程，于是：

1. 登录 URL 只发了 5 个参数，且回调地址用了 `callback_url` / `redirect_uri` ——
   **真实参数名是 `auth_callback_url`**。名字错了 TRAE 拿不到回调地址，
   登录页既不跳转也不回传任何东西；
2. 回调解析去找 `?code=` —— 而真实回调**根本没有该参数**，它直接回传
   `refreshToken` / `userInfo` / `userJwt`。于是 `parseTraeCallback` 恒判失败
   → 回调服务器回 400 → `result` Promise **永不落定**
   → 前端 `login.poll` 永远拿不到 `done:true` → **一直显示「认证中」**。

正确的登录 URL 是 **18 个参数**（唯一权威：`login.sh:47-72` /
Go 端 `BuildLoginURL`）：`login_version=1`、`auth_from=solo`、
`login_channel=native_ide`、`plugin_version=2.3.62834`、`auth_type=local`、
`client_id`、`redirect=0`、`login_trace_id`（hex16，回调据此反查 pending）、
`auth_callback_url`、`machine_id`、`device_id` 与 `x_machine_id` / `x_device_id`
/ `x_device_brand=PC` / `x_device_type=PC` / `x_os_version=1.0` /
`x_app_version` / `x_app_type=stable`。

真实回调形态：

```
http://127.0.0.1:18080/authorize?refreshToken=...&userInfo={...}&userJwt={...}
```

要点：

- `plugin_version`（`2.3.62834`）与 `ideVersion`（`0.1.52`）是**两个独立字段**：
  前者给登录门户，后者是 chat 端点的模型准入版本，不可混用
- 解析容错对齐 `login.sh:153-166`：`refreshToken` 缺失时回退
  `userJwt.RefreshToken`；两者都缺才用 `userJwt.Token` 兜底
- ⚠️ 回调的 `userInfo` 字段名是 **`TenantID`**（不是 `EnterpriseID`），
  且中文昵称存在**双重编码**乱码（实测 `Óû§8847309959`），
  须按 `fixNicknameMojibake` 回转，修不好则回退「用户+uid末4位」
- `device_id` 是 **hex32**（`login.sh:34` 的 `openssl rand -hex 16`），
  早期误用「16 位纯数字」（那是 CodeBuddy 的签到格式）

#### ⚠️ 但「带 `code` 的回调」**不是**无效回调（第二次修正，避免过度断言）

上面那条结论只说明「token 直传」是**当时实测的**流程，**不能**推广成
「带 `code` 即非法」。`Trae2api-cn/src/main.py:478-484` 的注释写明了真相：

```
1. 新流程 (code_challenge): callback 会带 authCodeInfo / code 等参数
2. 老流程 (refreshToken):    callback 直接带 refreshToken=xxx
```

**两套流程并存**。若把带 `code` 的回调一律判为「无效」，一旦上游把登录门户
切到 PKCE 新流程，**合法回调会被误判为失败**，症状与「一直认证中」一模一样，
而报错文案（「缺少 refreshToken」）会把排查方向带偏。

正确做法：`parseTraeCallbackDetailed` 对两种形态**都返回结果**，用
`authCodeFlow: true` 区分，并给出「上游返回了 PKCE 授权码，本实现暂不支持该
流程」这种**指向真实原因**的文案。注意 `authCodeInfo` 可能是 JSON
（`{code:...}`）也可能是**纯 code 字符串**，两种都要认。

> 教训：把「某次实测没见到 X」写成「X 一定不存在」是很危险的断言 ——
> 它会把未来的正常情况判成故障，且错误信息指向错误的方向。

#### ⚠️ 无效回调**必须落定结果 Promise**（第二个「一直认证中」根因）

`startTraeLoginFlow` 与 `startCallbackServer`（`src/trae-oauth.ts`）**两个**
回调处理器里，解析失败的分支早期都只写了：

```ts
res.writeHead(400, ...); res.end(...); return   // ← 没有 resolve 也没有 reject
```

结果 Promise 悬空 → 前端 `login.poll` 永远拿不到 `done:true` →
**界面永久停在「认证中」**，只能等 10 分钟超时。

这与「参数名写错」是**两个独立根因、同一个症状**：修好协议解析并不能顺带
修掉它，必须单独保证「**任何**回调路径都落定 Promise」。
`startCallbackServer` 是 `TraeAuth` / RPC 实际走的路径，漏改它同样致命 ——
两处都要有 `reject(...)`。

回归用例：`tests/unit/trae-oauth.spec.ts` 的「无任何可用参数的回调也必须落定
结果」。注意用例必须**先挂拒绝处理器再触发回调**，否则窗口期内它是未处理拒绝。

### ⚠️ 本地回调服务器：listen 失败必须先注册 `error`，否则崩掉整个宿主

`startTraeLoginFlow` / `startCallbackServer`（`src/trae-oauth.ts`）里，
`server.listen()` 的失败（最典型 `EADDRINUSE`：端口被占用）是**通过
`'error'` 事件异步抛出**的，**不属于 Promise 链** —— `await` 一个内部调用
`listen()` 的 Promise **捕获不到**它。

**真实缺陷**（用户报障，进程级崩溃）：早期实现直接 `server.listen(18080)`，
没给 `'error'` 注册处理器。于是 18080 被占用时：

- 该错误逃过 RPC 层的 `try/catch`；
- 成为**进程级 unhandled error**，把**整个 DSH 宿主**打挂；
- 用户看到的不是可读文案，而是一整堆
  `Error: listen EADDRINUSE: address already in use :::18080` + 堆栈 + 进程退出。

修法（`listenOrReject`，三处缺一不可）：

1. **在 `listen()` 之前**注册 `'error'`，把首个错误转成 Promise reject，
   让 RPC 层能照常返回规范错误响应；
2. 启动成功后把一次性处理器**降级为常驻监听** —— 运行期也可能出现 `'error'`
   （如 EMFILE），没有监听者会再次变成进程级崩溃；
3. 绑定 **`127.0.0.1`** 而非 `::`/`0.0.0.0`：这是本地 OAuth 回调，绑定所有
   网卡会让同局域网的机器也能投递伪造的 `?code=`，把攻击者的授权码写进用户
   凭据（`src/login.ts` 与 `src/lobsterai-oauth.ts` 同样只绑回环）。

配套：端口被占用时**回退到系统分配的随机端口**（`listenWithFallback`），
而不是直接失败。TRAE 的 `redirect_uri` 是我们自己构造并随登录 URL 下发的，
服务端原样回跳 —— 因此端口不固定也能工作。**注意顺序**：必须先 `listen`
拿到实际端口，**再**构造 `redirect_uri`（否则回调会打到没人监听的地址）。
这与 CodeArts 的 `listenOnCallbackPort` 同思路。

> 排查提示：Windows 上 `::` 与 `127.0.0.1` 是**两套可共存的栈**。写「端口占用」
> 的测试时，占位方必须绑与服务端**相同的地址族**，否则产品侧仍能绑定成功，
> 用例变成假阳性（本模块的 `tests/unit/trae-oauth.spec.ts` 踩过这个坑）。

### ⚠️ 错误分类必须先判更严重的类别

`classifyTraeError` 的判定顺序里，**`quota-exceeded`（4008）必须排在 `soft-rate`（4011）之前**。

两者可能同时出现在一个响应体里（网关把多个错误码拼在 msg 中）。`quota-exceeded` 需长冷却，`soft-rate` 只需短冷却 —— 让较轻的类别抢先命中，会让一个已耗尽额度的账号在 60 秒后被反复重试，用户看到的却是「稍后再试」。**真实缺陷**：早期实现把 4011 放在前面，`tests/unit/trae-errors.spec.ts` 已锁死该顺序。

### ⚠️ 续期的终态判定要看三种依据

`TraeAuth.refreshCredential` 判定「需重新登录」有三种独立依据，缺任一种都会让用户卡在无解的重试里：

1. HTTP 401 / 403（状态码最权威）
2. 分类结果为 `session-dead`
3. **拿到了 2xx、响应体也是 JSON，却没有 `accessToken`** —— 对齐 Go 的 `refresh_failed: no token in response — re-login required` 与 `LobsteraiAuth` 的同款处理。这不是瞬时故障，重试一万次也不会有 token

反之，**传输层失败（网络抖动）与 5xx 必须是可重试的普通 Error**，否则一次瞬时故障就让用户重新登录。另外响应体要**先取文本再解析**（不要直接 `response.json()`）：凭据失效时网关返回 HTML，`json()` 抛出的 `Unexpected token '<'` 对用户毫无意义。

### ⚠️ TRAE 签到：请求头与设备身份必须对齐真实客户端（`trae-mate` 实证）

**真实缺陷**（用户报障「模型没问题了，但签到有问题」）。参考实现
`E:\Workplace\APP\Tauri\trae-mate\src-tauri\src\checkin.rs` 是**能正确签到**的版本，
与旧实现有三处根本差异（旧实现在此之前只有 6 个精简头 + `{"req_source":2}`）：

| 维度 | 旧实现（失败） | trae-mate（成功） |
|---|---|---|
| 请求头 | 6 个（`Content-Type` / `Accept` / UA / `Authorization` / `X-User-Region` / `X-Device-Id`） | **约 20 个**客户端头 |
| 设备号 | `deriveCheckinDeviceId(credential.device_id, gen)`（32 hex） | **基于 `user_id` 确定性派生的 15 位数字** |
| claim body | `{"req_source":2}` | **`{}`** |

要点（`traeCheckinHeaders` 已全部落地）：

- **设备身份是「每账号一套、稳定派生」**，不是从凭据的 `device_id` 取。三件套
  （对齐 `device_map.rs`，salt 各不同）：
  - `X-Device-Id`：15 位数字（`seededDigits(15, uid, 'devid')`）
  - `X-Market-User-Id`：UUID v4（`seededStream(uid,'market',16)`，置 version/variant 位）
  - `Vscode-Sessionid`：64 hex（`seededStream(uid,'sess',32)`）
  同一 `uid` 永远得到同一套值 → 多账号天然互异，规避「每设备每天一次」配额。
- 新增头：`X-Market-Client-Id` / `X-Lgw-Req-Sdk-Type: 3` / `Package-Type: stable_cn` /
  `X-Lscbd-Aid: 787976` / `X-Lscbd-Platform` / `App-Version` / `X-Tt-Trace-Id` /
  `X-Request-Id`（**每请求刷新**）/ `Sec-Fetch-*`。
- **签到与余额都要用完整头**（`postJson` 统一走 `traeCheckinHeaders`）；
  `traeUgHeaders` 保留给其它 Ug 场景。
- **积分余额 body 改为 `{"require_usage": true, "req_source": 2}`**（不是 `{}`）——
  不带它拿不到 `usage`，余额会恒等于额度。
- **9074 不再换设备号重试**：设备身份已由 `uid` 确定性决定、每账号独立，
  「换个派生 id 立刻成功」的旧前提不成立。命中 9074 时归为 `BusinessError`（300s 冷却）
  并如实上报。
- ⚠️ **claim 响应不含积分数，必须补查 status**：`checkin_credits/claim` 的完整响应
  就是 `{"code":0,"message":"success"}`。**真实用户报障**：「领取积分显示成功但是加
  0 积分」—— 早期实现读 claim 响应的 `credits`，而该字段根本不存在，故**恒为 0**。
  所得数值只在 **status 端点**的 `credits` 字段里（实测 `150`，与积分余额中
  「签到奖励」包的 `credits_limit:150` 吻合）。现在 `claimTraeDailyCheckin` 在
  `code === 0` 后补查一次 status；补查失败时 `credit` 为 0 但**仍是 claimed**
  （不因补查失败而把成功判成失败）。
- ⚠️ **claim 对「今天已签到」是幂等的**：实测重复领取同样返回
  `{code:0, message:"success"}`，与真正成功**无法区分**。因此 `credits.claimAll`
  的 TRAE 分支**必须开启状态预检**（`collectClaimResults` 的 `precheckStatus` 保持
  默认 true 并注入 `fetchStatus`）—— 早期照抄 LobsterAI 传了 `precheckStatus: false`
  （那是「LobsterAI 领取流程内部已做 slot/context 预检」的理由，TRAE 没有这回事），
  于是已签到的账号被报成「领取成功」。判据只能是 status 的 `checked_in`。
  已有源码级守卫（`tests/unit/jet-hub-rpc.spec.ts` 的「TRAE 的 claim 分支开启状态预检」）。
- **错误分类**（`classifyTraeCheckinError`，对齐 `cooldown.rs`）：
  `200+1005 → PlanLimit(12h)` / `429 → SoftRate(60s)` / `401 → SessionDead(永久)` /
  `404 → NotFound(60s)` / `5xx → Server(600s)` / `4xx → Client(600s)` /
  `业务码非0 → BusinessError(300s)`。
- ⚠️ **网络异常与业务失败必须分开**：`postJson` 区分 `httpStatus === 0`（传输层失败，
  可重试）与有状态码（业务失败，**不**重试）。重试只针对前者。

> 旧实现里 `deriveCheckinDeviceId` / `AccountPool.traeCheckinDeviceGeneration*` /
> `TRAE_CHECKIN_BUSY_CODE` 的轮换链路**保留但不再被调用**，仅为兼容既有账号条目；
> 新语义下设备号由 `uid` 派生，无需持久化代次。

### ⚠️ TRAE 历史闸门（**已删除**）：抄来的常数，且会**静默丢历史**

**真实缺陷**（用户报障 2026-10-04：「trae 显示的上下文长度不对」）。根因是
`src/trae-adapter.ts` 里那道**只有 trae 有的**本地历史字符闸门 —— 超预算就从最早的
非系统消息开始整轮丢弃。它已被**整体删除**（PR #48）。现况：**唯一的限制是 DSH 的
压缩点（`声明的窗口 × 0.8`）**，与其余 13 个 provider 同形。

**它的来历是「抄的」，不是「量的」**：注释原文写「对齐 `Trae2api-cn` 的实测结论：
上游在 query 超过约 500K 字符时会静默结束事件流」，于是把那个项目的
`TRAE_REMOTE_MAX_HISTORY_CHARS=480000` 抄成本插件写死的 `480_000`。

- ⚠️ `480000 = 2.4 × 200000` —— 那是**声明窗口本身的量级**，不是量出来的字符天花板。
- ⚠️ 它守的另一道闸门（`TRAE_REMOTE_QUERY_MAX_CHARS`，**扁平化 query** 的硬上限）
  在本插件里**根本没有对应物**：trae 链路里没有 `query` 字段，我们发的是 OpenAI 形状的
  `messages[]`（上游那句 `Messages with role 'tool' …` 本身就证明它在逐条读 role）。

**它造成的是净损害**：引入 Max 模式（声明 1M）后，写死的 480,000 没跟着涨，与压缩点
（800K tokens ≈ 170 万字符）**脱钩** ⇒ 界面显示「才用了 8%」，适配器却每轮静默丢掉约
四分之三的历史（真实会话量：**1,898,903 字符 = 旧预算的 396%**）。

**为什么「把系数调大」不够，必须删**：

| 版本 | 预算 | 结果 |
|---|---|---|
| 写死 `480000` | Max 档恒定 ≈22% 窗口 | **静默丢历史**（本次缺陷的根因） |
| `声明窗口 × 2` | 覆盖 `R < 2.5` | 中文会话修好，英文/代码为主的会话仍在窗口 40~60% 处**静默丢** |
| `声明窗口 × 5` | 覆盖 `R ≤ 6.25` | 实测内容（`R`：中文 **2.13**、英文/代码 **4.0** —— 两者都已实测）不再误伤，**但**字符闸门在数学上**不可能**被证明「永不先于 DSH 的压缩点生效」：DSH 的界是 token、闸门是字符，任何**有限**系数都会被足够密的内容绕过 |
| **已删除** | 无 | 「静默丢历史」这一类缺陷**结构上消失** |

- **实测依据（本仓库探针，2026-10-04）**：

  | 档位 | 正文字符 | 服务端 `input_tokens` | 字符/token | 结果 |
  |---|---|---|---|---|
  | 常规（非 Max） | 40,398（标定） | 9,827 | 4.11 | 200 + 正中标记命中 |
  | 常规（非 Max） | **700,404** | 173,712 | 4.03 | **200 + 正中标记命中**（6.4 秒） |
  | 常规（非 Max） | **1,000,484** | 249,351 | 4.01 | **200 + 正中标记命中**（7.0 秒） |
  | 常规（非 Max） | 900,303（中文正文） | 422,672 | 2.13 | 200 + 正中标记命中 |

  ⇒ 「query 超过约 **500K 字符**就静默断流」在**常规档已被证伪到 2 倍**：100 万字符 /
  24.9 万 tokens，比该档声明的 200K 窗口**还超出约 24%**，仍然是 HTTP 200 且
  **埋在正文正中间的标记被复述**（任何截断/丢中段都会让它消失）。
- ⚠️ **2026-10-04 那次「Max 档 90 万字符」是**误标**档位**（本人记错）：探针构造适配器时
  `fetchRemoteModels: async () => []`，而 `maxModeFor()` 要求远端
  `display_config.max_mode === true`（`src/trae-adapter.ts:689`）—— 远端元数据为空时
  **恒为 false**，故那次实发的其实是**常规档**。重跑时把请求体抓下来打印确认：
  常规档请求体 `含 strategy=false context_window_size=false prompt_max_tokens=false`。
  ⇒ **引用旧记录时别再写成「Max 档」**。
- ⚠️ **仍未探的部分**：真正的 **Max 档**（注入远端 `max_mode=true` 后的 1M 声明）没跑过
  大正文；常规档 > 100 万字符也没探。但闸门已删，这两点**不再影响任何决策** ——
  只有「有人想把闸门加回来」时才需要补。
- ⚠️ 顺带实测到的两点事实：① 该档声明 200K 窗口，但 **24.9 万 tokens 的请求照样 200**
  （窗口并非硬校验）；② 探针**没有设任何逃生舱环境变量**就发出了 100 万字符 ——
  这本身就是「闸门确实已被删除」的端到端证据（旧实现里不设
  `DSH_TRAE_MAX_HISTORY_CHARS` 会把它裁到预算以内）。
- ⚠️ **为什么其余 13 家不需要这种闸门**：它们把 DSH 的压缩点当唯一真相。唯一的另一类体积
  防护（`src/image-budget.ts`，13 家共用）作用在**单张图的编码字节**上，数值来自**实测撞墙
  点**（qoder 8 张过 / 15 张 `TRANSPORT`、lobsterai 12 / 13×`500`、cline 24 / 32
  `TRANSPORT`），且压不下去时**抛 `UNSUPPORTED_CONTENT`**（可见报错），**不是**悄悄丢消息。
  ⇒ **判据：本仓库的体积防护只允许「按实测定界 + 失败可见」**；「抄来的常数 + 静默删改
  语义」是不允许的形态。
- `DSH_TRAE_MAX_HISTORY_CHARS` 已随闸门删除（即使设置也**不再生效**）。
- 回归用例在 `tests/unit/trae-adapter.spec.ts` 的「无本地历史闸门（本地裁剪已删除）」段
  （4 条：Max 档 60 万字符 / 20K 窗口 30 万字符 / 1M 档 600 万字符 / 该环境变量已失效）。
  ⚠️ **已做反向验证**：临时装回「写死 480000」→ 其中 **2 条**变红；临时装回
  「声明窗口 × 5」→ **另 2 条**变红（两种旧形态各自被锁住，不是同义反复）。
- ⚠️ **若将来要加回来**：先做实发探针量出真实边界**与失败形态**（可见错误？静默结束？），
  且闸门**必须可观测**（记日志/上报），不得静默改语义；同时改本段与
  `src/trae-adapter.ts` 的「TRAE 没有本地历史闸门」注释。

### ⚠️ 空响应（静默 EOF）只允许在**首个事件之前**重试一次

上游有时会「HTTP 200、会话创建成功、一个事件都不发就结束流」。`consumeSse`
用 `sawAnyUpstreamEvent` 标记是否收到过**任何**可解析事件，并在**一个都没有**时
抛 `TRANSPORT`（可重试），由 `stream()` 重试**一次**。

- ⚠️ **一旦已向上游消费者发出过任何 chunk 就绝不重放**：重放会让上游
  **重复计费**，并可能**重复执行工具**（对齐 CN 项目的
  `TRAE_REMOTE_WORK_FALLBACK` 语义）

  ⚠️⚠️ **判据是「已发出 chunk」，不是「已收到 output 事件」（2026-10-25 审计 P0 修复）**：
  旧实现把 `gotAnyContent` **只在正文分片（`ev.response`）非空时**置真，于是
  「已发出**思考**」与「已发出**工具调用**」两种情况仍被判成「尚未产出」⇒
  流内 `event:error` 照样**换号重放**。而重试循环在 `stream()` **内部**，
  harness 只看到**一条连续流** ⇒ 第一次 attempt 的 `tool-call-delta` 变成
  **幽灵调用**：`BlockAssembler.assembled()` **只在 `max-tokens` 时**丢弃
  tool-call（不过滤没有 `block-end` 的 partial），`dsh-agent-loop` 也**不去重**
  ⇒ harness 会执行一个模型已经放弃的工具（分片中断时参数还可能是**截断的非法
  JSON**）。真实后果：模型在第二轮说「直接回答、不用跑命令」，而工具仍被执行。
  ⇒ 三个发射点（`text-delta` / `reasoning-delta` / `tool-call-delta`）**都**置真，
  且只在**真正 yield 之后**（被 suppressor / 死循环守卫 / 空名字拦下的分片一个
  chunk 都没发，重发不产生幽灵调用）。这条路径此前**零守卫** —— 把缺陷真修掉，
  146 条既有 trae 用例仍然全绿。
- ⚠️ **不能把空响应当成正常的空 finish**：那会让用户看到「模型回复为空」这种
  毫无线索的结果，且不触发任何重试

### 单次输出上限收敛到 64K（`clampTraeMaxTokens`）

CN 项目实测：SOLO CN 的 agent-remote 模型单次响应上限 **64000 tokens**，并明确
警告「客户端索要 131072 会把上游打成 4xx」（`model_limits.py:9-23`）。

故 `clampTraeMaxTokens` 默认把 `max_tokens` 收敛到 **64000**
（`DSH_TRAE_MAX_COMPLETION_TOKENS` 可覆盖，设 `0` 表示关闭收敛）。

> **后续实测补正（2026-09-19）**：远端 `model_detail_list[].max_tokens` 对**主流
> 模型声明的就是 32000**（不是 64000，也不是兜底表旧值的 128000）。现在该值被
> 真正消费并写进 `resolveModel` 的 `defaultMaxTokens`，所以这个 64000 收敛在实际
> 请求里通常**不会生效**（32K 已低于阈值）—— 它保留为「上游没声明时」的最后一道
> 保险。若某模型远端声明偏大，调大 `DSH_TRAE_MAX_COMPLETION_TOKENS` 即可。

### ⚠️ 流内 `code=4006`（体积超限）**不得**归 `SERVER`（Issue IKKX0T）

**真实缺陷**（Gitee issue IKKX0T 的独立实测）：上游对流内错误用
`event:error` 下发 `code=4006 We're sorry, the content is too large for AI to understand.`
（实测边界 `(21,24]` 张 2560×1600 原图，即请求体 ≈100 MiB 量级）。

归类点原先是行内三元：

```ts
ev.errorCode === 1005 || ev.errorCode === 4008 ? 'QUOTA_EXCEEDED' : 'SERVER'
```

4006 **既不是 1005 也不是 4008** ⇒ 落到 **`SERVER`**，而 `SERVER` **在** harness 的
`DEFAULT_RETRYABLE_CODES`（`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`，
已在 `dsh-llm` 实测确认）里 ⇒ **同一个巨型请求体被原样重发 5 次**
（退避 500/1000/2000/4000/8000ms，约 15.5 秒），而体积超限是**确定性**失败。

**修法**：抽出 `streamErrorCode(code)` 一张**逐格可测**的表（与
`classifyTraeError` 同思路），4006 → `CONTEXT_WINDOW_EXCEEDED_CODE`：

| 流内码 | 归类 | 理由 |
|---|---|---|
| `4006` | `CONTEXT_WINDOW_EXCEEDED` | 载荷过大：不重试 **且**能触发 `dsh-compaction-basic` 的溢出压缩 |
| `1005` / `4008` | `QUOTA_EXCEEDED` | 额度类终态，用户需签到/换号 |
| 其余（含 `4001`） | `SERVER` | 多属上游真 5xx/瞬时故障，**必须保留重试机会** |

⚠️ **为什么归 `CONTEXT_WINDOW_EXCEEDED` 而不只是「换个不可重试的码」**：
`dsh-compaction-basic` 的 request-error listener 第一行就是
`if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()` ——
只有这个码能换来「试一次压缩」。而**图片撑大的请求体正是压缩能真正缓解的那一类**。
（同款取舍见 `buddy-adapter.ts` 的 `GATEWAY_PROMPT_TOO_LONG`。）

⚠️ **三条边界，改这张表时逐条核对**：
1. **4001 与 4006 不可合并**：4001 是「模型不可调用」（换号/压缩都无益），
   4006 是「**这一次的载荷**太大」（压缩/少发图能救）—— 合并必牺牲一方；
2. **`502 + HTML` 形态刻意不动**：issue 同时记了 trae 的
   `502 ... invalid character '<' (code=3003)`，那与「上游真崩了」**无法区分**，
   归成溢出会让真正的 5xx 故障失去重试机会（同 `upstreamStatusOrFallback` 的方向）；
3. **只认 `4006` 这个码，不做措辞匹配** —— 措辞匹配在 5xx 与体积之间没有可靠判据。

⚠️ **文案**：4006 的上游原文不提「图片」也不提「体积」，容易被读成模型能力问题，
故 `traeStreamErrorMessage` 对它补一句可操作提示（与 4001 同款处理）。

回归：`tests/unit/trae-adapter.spec.ts` 三条（★ 4006 不归可重试码且能触发压缩 /
4006 与 4001 不可合并 / 未知码仍归 SERVER）。
⚠️ **已做反向验证**（逐条独立变异）：还原成修复前的三元 → **2 条**变红；
把整张表改成「所有码都归溢出」→ **另 2 条**变红（含那条「未知码仍归 SERVER」守卫）。

⚠️ **仍未定值**：4006 的**归类**已修，但 trae 的 `imageMaxBytes` **仍未接** ——
issue 是第三方实测，按本仓库规矩须用**自己的账号与 fixture** 复测后再定
（入口 `pnpm test:e2e:image-bisect`，见 `protocol-wire.md` 的说明）。

### ⚠️ 流内 `event:error` 的类别必须走**结构化码**入口，不能喂文案表（2026-10-24 真实报障）

**现场**：用户只看到一行 `trae:  (code=1005)`（冒号后**两个空格**）+ 徽章
`QUOTA_EXCEEDED`，两个 TRAE 账号同被同一模型（`kimi-k3.1-pro`）拒，而插件侧
**一点退避都没有** —— 宿主日志 `~/.dsh/logs/desktop-next-*.jsonl` 的 `agent.failed`
与 `[jet-hub] 已记录限流: 账号 <id> 模型 kimi-k3.1-pro 重置于 <失败同一秒>` 同时出现。

**机制**：上游用 HTTP 200 + SSE `event:error` 下发 `code=1005`，而 **`message`
是空串**。换号循环里拿 `JSON.stringify({ code, message })` 去喂 `classifyTraeError`
⇒ 文案表的 `hard-plan` 还要求 `plan` 关键词（对齐 Go 端 `Classify`，且被
`tests/unit/trae-errors.spec.ts` 显式锁死）⇒ 判成 `'none'` ⇒
`traeCooldownFor('none')` = **0ms** ⇒ 限流标记写在**失败那一瞬间**、下次选号
**立刻又选回同一个号**（换号形同虚设）；池里账号全被该模型拒后，外层如实抛
`QUOTA_EXCEEDED`。

**修法**：`src/trae-errors.ts` 新增**结构化码**入口（与文案表并列，同一张判据表
不许两处各写一份）：

| 流内码 | 类别 | 冷却 |
|---|---|---|
| `1005` | `hard-plan` | 12h（与 `trae-credits.ts` 的 `200 + code === 1005 ⇒ PlanLimit(12h)` 同值） |
| `4008` | `quota-exceeded` | 24h |
| `4011` | `soft-rate` | 60s |

`classifyTraeStreamCode(code, message)` **码优先、文案兜底**（表外码仍喂文案表，
保持既有行为）；`isRotatableTraeStreamCode(code)` 与它**共用同一张表** ——
`trae-adapter.ts` 里那个本地 `isRotatableStreamError`（1005/4008/4011 硬编码）
已删除，免得「可换号集合」与「类别表」两处漂移。

⚠️ **为什么不改 `classifyTraeError` 本身**：① 它锁死了「仅 `{"code":1005}` 不判
`hard-plan`」—— 正文里**恰好出现**的数字 `1005` 不算证据（同仓 `zcode-adapter.ts`
的裸子串判据就因此把两个可用账号换掉过）；② 流内给的是**上游枚举码**，与响应体
原文的可信度不同，故两个入口分开。

⚠️ **它为什么能潜伏**：既有回归用例的夹具是
`{ code: 1005, message: 'plan 权益不足' }` —— 那个 `plan` **恰好**满足了文案表的
第二腿，于是走 `hard-plan(12h)`，**0ms 那条路径一次都没被走到**。新用例把
`message` 置空，逐字复刻报障现场。

⚠️ **已核实为不可达的伪问题**（2026-10-25 审计 B2-4）：流内分支「没有 HTTP 层那条
`recordsTraeRateLimit(kind)` 守卫」曾被登记为未修项。但能走到该分支的码全来自
`TRAE_STREAM_ERROR_KINDS`，而三类（`hard-plan`/`quota-exceeded`/`soft-rate`）
**全部**在 `recordsTraeRateLimit` 的 true 集合里 ⇒ 加守卫后行为**逐字节不变**
（审计实测：加上它，146 条 trae 用例全绿）。故不是遗留缺陷，**不要为它另开 PR**。

### 2026-10-25 审计补齐（均已修 + 有守卫）

| 项 | 缺陷 | 修法 |
|---|---|---|
| **最后一个账号漏标冷却（P1）** | `rotateBudget <= 0 → throw` 排在 `updateModelRateLimit` **之前** ⇒ 预算刚好用尽的那一次，当前账号**一个标记都不写**就抛出了。3 账号池实测第一轮只标 2 个，需第二轮才补齐 ⇒ 那个账号下次选号无标记可过滤、**立刻又被选回** | 把预算判断**移到标记之后**（先写冷却，再判预算） |
| **表外码回落分支是死代码（P2）** | `classifyTraeStreamCode` 的「表外码 ⇒ `classifyTraeError(0, JSON.stringify({code,message}))`」在生成路径上**不可达**（唯一调用点前已被同一张表过滤），且它复活的正是「拿 JSON 喂文案表 ⇒ 判 `none` ⇒ 冷却 0ms」这个本 PR 要消灭的形态 | 改为**纯表查找**：表外码返回 `undefined`，由调用方用 `TRAE_RATE_LIMIT_FALLBACK_MS` 兜底；函数**删掉 `message` 参数**（留着会让人以为文案仍参与判据） |
| **1005/4008 文案无指引力（P2）** | 上游 `message` 常为空串 ⇒ 用户只看到 `trae:  (code=1005)`，一个字都不指向他能做的事 | 1005 ⇒ 「套餐不包含模型 X，请换一个模型（被拒的是模型不是额度）」；4008 ⇒ 「今日额度已用尽，等重置或换模型/账号」。⚠️ **码保持 `QUOTA_EXCEEDED` 不动**（见下） |

⚠️⚠️ **为什么 1005 的码不改（审计 B2 的 REFUTED，推翻了一个看起来更"正确"的建议）**：
1005 的真实含义是「该模型不被这个账号的套餐接受」而非「额度耗尽」，所以码**语义不准**。
但实测**不能改**：`account-probe.ts` 的 `isRateLimitFailure` 认 `QUOTA_EXCEEDED`/`QUOTA`、
**不认** `PERMISSION_DENIED` ⇒ 改码会让面板「重测」从**「仍受限」退化为「无法确认」**，
用户会误以为凭据坏了去删号。两个码都不触发重试/压缩、都不被客户端替换文案
（`dsh-client-ui-chat` 的 `failureMessage` 只替换 `QUOTA`/`ACCOUNT_QUOTA`/`AUTH`/
`INTERRUPTED`/`ACCOUNT_*`）⇒ 改码**换不来任何用户可见改善**。**修文案，别动码。**

回归：`tests/unit/trae-errors.spec.ts` 六条（含「1005 的冷却必须是 12h」与「表外码
回落文案表」）+ `tests/unit/trae-adapter.spec.ts` 两条（★ `message` 为空 ⇒ 12h；
★ 用户所见文案逐字 `trae:  (code=1005)`）。
⚠️ **已做反向验证**（逐条独立变异）：把换号循环改回「喂 JSON 给文案表」⇒ **1 条**
变红，报错 `expected 0 to be greater than 39600000`；把 `1005` 从码表删掉 ⇒
`trae-errors.spec.ts` **4 条**变红。两次变异后源文件哈希均与变异前一致
（`src/trae-adapter.ts` `56CAA23D…`、`src/trae-errors.ts` `EFDCE7C5…`）。
### 机器指纹轮换默认**关闭**（`DSH_TRAE_ROTATE_MACHINE_ID`）

CN 项目每 3~5 次请求主动换 `machine_id` 以「降低 IDE 端点风控」
（`trae_client.py:211-224`）。但这与本地既定约束
「`machine_id` 登录后**绝不重新生成**」冲突 —— 它换来抗风控，代价是设备身份漂移，
而上游按 `machine_id` 标识设备，换值可能要求重新登录。

故该能力**默认关闭**，仅在显式设 `DSH_TRAE_ROTATE_MACHINE_ID=1` 时按每 4 次
请求递增一代（`deriveRotatingMachineId`）。它是出现**集中 401/风控**时的第一个
可尝试开关。

## TRAE（字节跳动）协议要点（五个易踩的坑）

`trae` 的 chat 链路与其它 provider **全程不同构**，以下是实测/逆向确认的关键约束：

0. **⭐ 必须先做「消息序列化」，再做载荷转换**（`serializeTraeMessages`）：
   DSH 交给适配器的 `options.messages` 是**原生块结构**
   （`content:[{type:'tool-call'}]` / `[{type:'tool-result'}]` / `[{type:'reasoning'}]`），
   **不是** OpenAI wire 格式。必须先转成 `tool_calls` + 独立 `role:'tool'` 消息，
   **再**交给 `transformToSOLOBody`（后者只认识 `type:'text'`）。

   **真实缺陷**：早期实现把原生块**原样**透传，后果是**每一轮多步对话都坏掉**：
   `tool-call` 不是 SOLO 认识的字段 → **模型看不到自己调用过什么**；
   `tool-result` 同样不被识别 → **模型永远看不到工具返回值**，于是反复请求
   同一个工具或凭空编造结果。全程**没有任何报错**，极难排查。
   三个兄弟适配器（`llm-adapter.ts` / `buddy-adapter.ts` / `lobsterai-adapter.ts`）
   都有这一步，只有 TRAE 漏了 —— 本文件甚至早已 `import` 了
   `resolveToolPairing` 却从未使用，说明当初打算写但没接上。
   已由 `tests/unit/trae-adapter.spec.ts` 的「消息序列化（真实缺陷回归）」锁死。
1. **请求体必须转换，不能透传**（`transformToSOLOBody`）：
   - `stream` 强制 `true`；注入 `function: "solo_work_lite"`（实测 `work` / `solo` / `work_lite` 均无效）
   - `model` 同时写入 `config_name` 与 `model` 两个字段；内部名后缀 `__dev` 需去除
   - `messages[].content` 字符串 → `[{type:"text",text:...}]`
   - assistant 的 `tool_calls[].function` → **`function_call`**（SOLO 字段名），无 `name` 的条目须剔除（上游 `FunctionCall.Name` 必填）
   - ⚠️ **`tools[].function.parameters` 必须序列化为 JSON 字符串**（SOLO 上游要求 string，OpenAI 标准是 object）。因此 **tools 必须放进源的 OpenAI 对象里再交给转换函数** —— 若在转换**之后**再补 `bodyObj.tools`，`normalizeTools` 已执行完毕，parameters 会保持对象形态发给上游被拒（真实缺陷，已由 `tests/unit/trae-adapter.spec.ts` 锁死）
2. **响应是 SOLO 自定义 SSE，不是 OpenAI 格式**（`parseTraeSSELine` / `aggregateTraeSSE`）：事件为 `metadata` / `timing_cost` / `output` / `extra_info` / `token_usage` / `done` / `error`；正文在 `output.response`、思考在 `output.reasoning_content`；`tool_calls` 内层同样用 `function_call` 字段且带 SOLO 专属的 `namespace` / `partial_arguments`（须清理掉，只留标准 `function.{name,arguments}`）。解析须兼容 `data: {...}` 与 `data:{...}`（实测无空格）
3. **凭据必须持久化两个机器指纹**（`buildTraeCredential` / `applyTraeRefresh`）：
   - `machine_id`：**32 位 hex** 设备指纹。**续期时绝不可重新生成** —— 服务端按它标识设备，换了可能要求重新登录
   - `device_id`：**32 位 hex** 签到设备号（`login.sh:34` 的 `openssl rand -hex 16`，与 machine_id 同格式）。**账号间必须互异**，同一天两账号共用会被「该设备已签到」拦截；为空则签到报 9004
4. **`4001 param is invalid` 有三个独立成因**（见下「TRAE 的『通道（`function`）』」）：
   最普遍的是**发错了通道**（模型只在列出它的通道里可调用）；其次是模型本身是
   `is_custom_model` 条目；再次是**请求头被叠成重复值**（`content-type` 大小写各写一次）。
   早期把 `4001` 归因于 `X-Ide-Version` 过低（`0.1.43` 请求 `glm-5.3` 报错、
   `0.1.52` 正常）—— **本次复测未能重现该结论**：`glm-5.3` 在 `0.1.52` 与 `0.1.43`
   下**都**正常返回，故该归因**不足以作为 `4001` 的解释**，已降级为「未复现的旧观察」。
5. **⚠️⚠️ `4027 tool call failed` = 工具的 `parameters` 不是 object（2026-10-23 实测，第三个码）**

   **用户报障**（与 buddy 系**同一个根因**、第三个上游）：
   `trae: tool call failed: tools.0.function.parameters must be a JSON Schema of type object … (code=4027)`。

   **分流表（先按它判方向，别被 `4001` 带走）**：

   | 码 | 含义 | HTTP | 藏在哪 |
   |---|---|---|---|
   | `4001` | param invalid（三个独立成因，见下节） | 200 | 流内 `event:error` |
   | `4006` | 请求体体积超限 | 200 | 流内 |
   | **`4027`** | **工具 `parameters` 不是 JSON Schema object** | **200** | 流内（`event:progress_notice` 之后） |
   | `4008` / `1005` | 配额耗尽 / plan 权益不足 | — | — |

   ⚠️⚠️ **`4027` 的 HTTP 是 200** ⇒ 只看状态码会把它误判成「成功但没内容」
   （与本文件「`4006` 不得归 `SERVER`」**同一形态**）。判「成功」必须看流是否产出正文。

   ⚠️ **`tools.0` 不是「第 0 个工具坏了」的通例**，而是问题工具恰好排第 0
   （本仓工具按名排序，`analyzeImage` 恰在首位）⇒ 排查**必须**先解出 `tools.N` 是哪个工具。

   **根因与修法**：本插件的 `analyzeImage` 工具把 `parameters` 写成了空对象 `{}`。
   TRAE 按本文件笔记 ① 要求它**序列化为 JSON 字符串**，于是发出去的是 `"{}"` ——
   一个**合法 JSON 字符串**、但**不是** object schema ⇒ 4027；腾讯两站不要求字符串、
   直接收对象形态，看到 `{}` 缺 `type` ⇒ 11129。**同一份缺陷、三种校验口径。**

   ⇒ 已修成 `{ type: 'object', properties: {} }`（三者都过），并加**路由作用域**摘除
   （`src/codearts-vision.ts`）：该工具只服务 codearts，而本插件注册 20 个渠道、
   工具表是**进程全局**的 ⇒ 别家（buddy/workbuddy/trae/…）**根本不该看到它**。
   真机复核（TRAE 账号、经真实注册入口）：实发 **279/280**（不含该工具）、
   **即使用未修 schema 的原样清单也不被拒**。取证链见 `src/codearts-vision.ts` 模块头。

其它要点：`exchange` 的 `refresh_token` 会**轮换**（续期后必须回写）；错误分类见 `src/trae-errors.ts`，其中 `4008`（配额耗尽）与 `1005`（plan 权益不足）是 TRAE 最主要的失败模式。

### ⚠️ TRAE 的「通道（`function`）」：模型只在列出它的通道里可调用

**真实缺陷**（用户报障「使用模型时报 `trae: We're sorry, the param is invalid.
Please try with a valid param. (code=4001)`」）。

#### 症状定位

该文案**只**在 `src/trae-adapter.ts` 的 `consumeSse` 流内 `event:error` 分支拼出 ——
说明 **HTTP 是 200**（请求已被接受），上游在**参数校验阶段**才拒绝。

#### 三个独立成因（都实测过，别混为一谈）

| 成因 | 判据 | 实测 |
|---|---|---|
| ① 模型是「需自行配置的自定义模型」 | `display_config.is_custom_model === true` | **5/5 命中、0 误报** |
| ② **发错了通道** | 该模型不在所发 `function` 的目录里 | 见下路由矩阵 |
| ③ 请求头 `content-type` 被叠成重复值 | 实际发出 `"application/json, application/json"` | HTTP 400 + `code=4001 binding: … missing required parameter` |

**①** 的 5 个条目（2026-09-19 快照）：`deepseek-v4-flash` / `glm-5.3-flash` /
`qwen3.8-flash` / `agnes-2.5-flash` / `silk-gpt-5.6-luna`。

> ⚠️ **该名单已过期，不要再据此删模型**（复测 2026-09-20）：`deepseek-v4-flash` /
> `agnes-2.5-flash` / `silk-gpt-5.6-luna` 已**下架**；`glm-5.3-flash` /
> `qwen3.8-flash` 已转为 `is_custom_model: false`，**是正常可调用的合法模型**；
> 全目录 custom 条目数为 **0**。判据是**标志的值**，不是模型名 —— 曾把
> `qwen3.8-flash` 误记为「应被剔除」，差点误删一个可用模型。

**② 是本节重点**。实测路由矩阵（2026-09-19，逐模型 × 逐通道）：

| model | `solo_agent_remote` | `solo_work_lite` |
|---|---|---|
| `glm-5.2` / `kimi-k3` | OK | OK |
| `glm-5.1` / `qwen-3.5` / `Doubao-Seed-Code` | **OK** | 流内 `4001` |
| `glm-5-turbo` / `sagitta` / `seed-code-pro-0430` | 流内 `4001` | **OK** |

即**「模型属于哪个通道，就只能在那个通道里调用」**。旧实现把 `function` 写死
`solo_work_lite`，于是 agent 专有模型一用就报 `4001`。

**③ 是排查时最容易自伤的**：`{ ...headers, 'content-type': 'application/json' }`
与已有的 `Content-Type` 大小写不同，`Headers` 按 `append` 语义**合并**成非法值。
**写探针/代码时务必用 `new Headers(base).set(...)`，不要用对象展开叠同名头。**

#### 通道目录怎么拿：`batch_get_detail_param`（**不是** `get_detail_param`）

真实 CN IDE 用的是**批量**端点，一次传多个 `functions`，响应 `function_configs[]`
为**每个通道各自一套** `config_info_list`：

```
POST {agentHost}/api/ide/v1/batch_get_detail_param
{ "functions": ["solo_work_lite","solo_agent_remote"], "show_custom_model": true,
  "agent_type": "", "current_config_info": {"config_name":"","is_custom_model":false},
  "mode_type": 0, "access_type": 0, "ab_force_vids": "", "ab_autotest_advanced_mode": 0 }
```

单 function 的 `get_detail_param` 只能拿一个通道的目录，**不要**再用它。

#### 「可调用」与「官方可见」是两个独立维度

| 标志 | 含义 | 本插件处理 |
|---|---|---|
| `display_config.is_custom_model` | 需在 IDE 内自行绑定供应商 | **必须剔除**（必然 4001） |
| `config_switch === false` | 上游已停用 | **必须剔除** |
| `is_invisible_to_user` | **官方 picker 不展示** | **必须剔除**（硬性，使目录与官方 Auto Mode 一致） |
| `usage !== 'chat_completion'` | 非对话用途（summary / fast_apply / multimodal…） | **必须剔除** |
| **`function` 不在 `TRAE_CHANNELS` 内** | **该通道在本插件的推理端点下不可调用** | **整组剔除**（见下「通道白名单」） |

> **历史修正**：早期实现把 `is_invisible_to_user` 当作「两个独立维度」而默认保留
> （理由是实测 `glm-5.1` 被官方隐藏却**可调用**）。后来用户要求目录与官方
> **Auto Mode 选择器完全一致**，该标志遂改为**硬性过滤** —— 代价是
> `glm-5.1` / `qwen-3.5` 等「可调用但官方不展示」的模型不再出现在目录里
> （目录 47 → 29）。这是**有意的取舍**（对齐官方 UI），不是回归；
> 被过滤的模型若已被持久化为会话模型，`resolveModel` 仍能解析。
> 需要临时放宽时改 `parseTraeBatchModelList` 的过滤条件，不要动
> `isTraeModelCallable`（那里管的是「必然调不通」）。

#### ⚠️ 通道白名单：`TRAE_CHANNELS` 不只是排序表，更是**准入白名单**（Issue IKJOZ7）

**真实缺陷**（用户报障 2026-10-04）：模型列表里 `function=chat`（及 `builder` /
`inline_chat`）的模型**能选中**，一发请求就被上游拒绝；换 `solo_agent` 通道同样的
模型可以正常用。用户侧表现为「模型在设置页能开、能被选中，调用却稳定失败」，而
报错文案（`the model is unknown` / `param is invalid`）**指向模型本身** ⇒ 极易误判
成「这个模型坏了」，实际是**发错了通道**。

**根因**：`channelPriority`（= `TRAE_CHANNELS`）此前**只用于排序**（规则 2 的档位
择优），不参与准入；`channelFor()` 又原样返回目录里的 `function` 当通道用
⇒「目录声明了什么通道，就照着发什么通道」。而真实目录里 **38 条中有 19 条（50%）**
带着不可调用的 `function`。

**修法**：`parseTraeBatchModelList` 的循环开头加白名单准入 ——
`if (channel.length === 0 || rankOf(channel) < 0) continue`（整组跳过）。
准入**只在解析器一处**执行（单一真相源）；不要再去 `channelFor()` 里加第二层
校验，否则用户用 `DSH_TRAE_CHANNELS` 自定义白名单时会与兜底表路径判据不一致。

**逐通道实测**（2026-10-04，真实凭据；脚本 `scripts/probe-trae-channel-callable.mjs`
逐个 function 发一次最小请求，每站可复现）：

| 结果 | function |
|---|---|
| ✅ 可调用（**白名单内容，15 个**） | `solo_agent` / `solo_work_lite` / `solo_agent_remote` / `solo_work_remote` / `solo_agent_lite` / `solo_design_lite` / `solo_design_remote` / `solo_coder` / `chat_v3` / `builder_v3` / `git_ai` / `code_reviewer` / `code_review_summary` / `multimodal` / `system_diagnosis` |
| ❌ **稳定被拒**（**不得**放入） | `chat` → `code=4023 the model is unknown`；`builder` → `4001 param is invalid`；`inline_chat` → `3003 model service is unavailable` |
| ⚪️ 目录恒空（放进来无意义） | `ui_builder_v2` / `solo_builder` / `custom_agent_generation` / `utils` |

⚠️⚠️ **两处与 issue 原文不符，以实测为准**（别照抄 issue 的推测去"补全"）：

- **`chat_v3` 是可调用的**（实测正常返回 3.8KB 正文），issue 把它与 `chat` 并列
  怀疑是**错的**。若照 issue 把它一起剔除，会连带删掉一批只有它才有的模型。
- **`solo_coder` 首测超时、换 4 个模型复测 4/4 成功** ⇒ 计入可调用。
  ⚠️ **超时 ≠ 不可调用**：单次超时可能只是上游抖动，判据必须是**复测**。
  它的独有模型（`minimax-m2.7` / `glm-5v-turbo` 等）因此得以保留。

**修复前后对账**（同一次真实目录，`scripts/diff-trae-whitelist.mjs`）：

```
修复前 38 条 → 修复后 36 条
被剔除（仅见于不可调用通道）：doubao_1_8(was=chat)、kimi-k2(was=inline_chat)
通道迁移（保留但纠正通道）：24 条，如 glm-5.1: chat → solo_coder
                          glm-5.2: chat_v3 → solo_agent
新增（不该有）：无
```

⚠️ **关键区别：剔除 vs 纠正通道**。`glm-5.1` / `DeepSeek-V4-Flash` / `qwen-3.5` 等
**同时也在可调用通道里**（`solo_coder` 等），故它们**不消失**，只是通道被纠正 ⇒
从「必然失败」变成「可用」。**只有**「仅见于不可调用通道」的条目才会被剔除
（实测就那 2 条）—— 那正是必然失败的那批。**不要**把这条修法理解成「按通道一刀切
删模型」。

⚠️ **`glm-5.1` 的通道变了，别按旧结论断言**：它在 `solo_agent*` 里全是
`is_invisible_to_user: true`（被既有硬过滤剔除），故现在落到 `solo_coder`。
历史文档里「`glm-5.1` 走 `solo_agent_remote`」的说法**已过期**
（`tests/e2e/trae-channels-probe.e2e.spec.ts:49` 仍是旧断言，跑该 e2e 前需先更新）。

⚠️ **兜底表路径不受影响**：远端目录不可用时走 `fallbackModels`，那里本就没有通道
信息，`channelFor()` 回退 `product.function`（`solo_work_lite`，已在白名单内）。

⚠️ **`DSH_TRAE_CHANNELS` 覆盖的是整张白名单**，写错即过滤掉全部模型
（有意的：宁可空目录，也不要再让不可调用的通道流出去）。

**排查脚本**（均只读；前两个零额度）：
- `scripts/probe-trae-channel-whitelist.mjs` —— 打印 22 个通道的条目数 +
  解析结果的通道分布 + 白名单外条目明细（**修复前跑会列出 19 条 offenders**）；
- `scripts/diff-trae-whitelist.mjs` —— 修复前后目录对账（剔除 / 迁移 / 新增）；
- `scripts/probe-trae-channel-callable.mjs` —— **消耗额度**，逐通道实发判定可调用性；
- `scripts/verify-trae-channel-fix.mjs` —— **消耗额度**，用修复后的适配器对
  10 个「修复前必然失败」的模型实发对话（实测 10/10 通过）。
  ⚠️ **必须传 `fetchRemoteModels`**，否则适配器 `remoteMeta` 为空、
  `channelFor` 回退 `solo_work_lite`，验的就不是本次修复了（我第一版就这么白跑了一遍）。

**回归用例**：`tests/unit/trae.spec.ts` 的「通道优先级表同时是白名单」等 4 条
（非白名单通道整组剔除 / 仅见于不可调用通道者被剔除 / 可调用+不可调用都出现时保留
并纠正通道 / 未声明 `function` 的组跳过），以及 `tests/unit/trae-product.spec.ts`
的 2 条（白名单不得含被拒的 3 个通道、15 个可调用通道必须齐全）。
⚠️ 已做**反向验证**：去掉白名单准入（恢复「只用于排序」）→ **3 条变红**；还原后全绿。

⚠️ **同时修掉了两处「语义漂移」的既有用例**（它们会因「条目被丢弃」而**假通过**）：原
「已选条目不在优先级表内时，有档位者仍胜出」用例用的是 `chat` 通道 —— 修复后该条目
根本进不了目录，用例变成**同义反复**（不再验证「档位优先于顺序」）。已改写为明确
断言白名单语义，并另加 3 条覆盖剔除/纠正两种路径。**改动解析器时请复查既有用例是否
仍在验证它声称的那件事** —— 「测试全绿」不等于「测试还有意义」。

#### 远端参数必须消费（这一条曾被整段漏掉）

- `context_window_tokens.dev` → `contextWindow`。⚠️ 常规会话用 `dev`
  （条目形如 `{dev:200000, max:1000000}`）；`max` 只在**开启 Max 模式**时才声明
  （见下「TRAE 的 Max 模式」），无脑采信 `max` 会让 DSH 以为有 1M 窗口而实际请求被拒。
- `model_detail_list[].max_tokens` → `maxOutputTokens`。实测**主流模型是 32000**
  （旧兜底表写的 131072 / 128000 是估值，**已被推翻**）；多条明细优先取 `__dev` 那条，
  Max 模式那条（`__max`）另存为 `maxModeOutputTokens`。
- `reasoning_effort_config` → `reasoningConfig`（见下「TRAE 的推理强度档位」）。

**真实缺陷**：接口 `TraeRemoteModel` 早已声明这两个字段、`contextWindowFor` /
`maxOutputTokensFor` 也在读，但解析器**从未填充** → 远端值被静默忽略、恒回退兜底表
估值。现由 `parseTraeBatchModelList` 填充，兜底表数值同步修正为 200000 / 32000。

#### TRAE 的推理强度档位（`reasoning_effort_config`）

真实条目：

```json
"reasoning_effort_config": {
  "default_level": "high",
  "options": ["light", "high", "extra_high"],
  "support_thinking": true
}
```

要点：

- **`options` 是单值字符串**，既是产品侧档位名、也是发给上游 `reasoning_effort` 的
  wire 值。⚠️ 这与 LobsterAI 的 `level` / `openclawLevel` **双字段**形态不同 ——
  不要照搬那张映射表；TRAE 的展示名表（`TRAE_EFFORT_NAMES`）**只用于美化**，
  不参与 wire 取值。
- 不声明 `reasoning` 的两种情形：**远端没有该配置**（UI 显示「当前模型未提供
  推理等级」）与 **`support_thinking === false`**（远端明确说不支持思考）。
  后者若照旧声明档位，会让用户选一个发了也没用的值。
- ⚠️ **默认档优先采信远端 `default_level`**（2026-09-26 变更，此前是「一律取最强档」）：
  用户报障「为什么默认是最高档位的思考？按说应该用次高档做默认吧？」。旧行为
  （AGENTS.md 更早版本记的「用户要求所有模型默认用 max」）代价是每次请求都顶格
  思考，而思考 token **计入 `completion_tokens`**、与正文共享额度。
  现规则见 `defaultTraeEffort()`：`default_level` **存在且在 `options` 内**就用它，
  否则退 `strongestTraeEffort`。实测 6 个模型的新旧对照：

  | 模型 | options | 上游 `default_level` | 旧默认 | 新默认 |
  |---|---|---|---|---|
  | `deepseek-v4.1-flash` | light,high,extra_high | `high` | extra_high | **high** |
  | `glm-5.2` | high,extra_high | `high` | extra_high | **high** |
  | `qwen3.8-max` | light,high,extra_high | `high` | extra_high | **high** |
  | `Doubao-Seed-2.1-Pro` | light,high | `high` | high | high |
  | `glm-5.3` | light,high,extra_high | `extra_high` | extra_high | extra_high |
  | `kimi-k3` | light,high,extra_high | `extra_high` | extra_high | extra_high |

  ⚠️ **不要改成「固定取次高档」**：后两行说明上游**自己**在 `glm-5.3` / `kimi-k3`
  上选了最高档，机械取次高会把它们无谓降下来。以**上游的判断**为准。
- ⚠️ **`default_level` 是外部输入，必须校验它在 `options` 内**：DSH 会拿
  `defaultEffort` 直接发请求，给不存在的档位抛 `UNSUPPORTED_REASONING_EFFORT`
  （`dsh-llm` 的 `resolveCallWithInfo`）。实测上游确实会下发
  `default_level: 'max'` 而 `options` 里没有 `max` —— 此时必须退到最强**可用**档。
- ⚠️ **UI 里没有「Default（跟随上游默认）」这一档**：`dsh-client-ui-model-selection`
  只在 `reasoning.defaultEffort === undefined` 时才注入该选项
  （`client.js` 的 `effortChoices`）。我们总是声明 `defaultEffort`，故用户可选项
  只有 `Light / High / Extra High`。
- ⚠️ **DSH 不按模型记忆档位**：切换模型时走 `client.js` 的
  `state.current?.provider === group.id && state.current.model === model.id ? … :
  model.reasoning?.defaultEffort` —— 切到别的模型再切回来取的是**新模型的
  `defaultEffort`**，不是上次手选的档位。故「切走再切回仍是最高档」在旧行为下
  是必然结果（默认档就是最高档），不是"记住了"。**区分方法**：先选次高档
  `high`、切走、再切回，若回到 `extra_high` 即为该机制而非记忆。
- ⚠️ **`extra_high` 下正文可能为空，这是模型行为、不是档位被拒**：实测
  `maxTokens` 给到 4096，同一档位重复调用仍**随机地**有时返回「好的」、有时
  只回思考不吐正文（`outputTokens` 仅 41~113、几乎全是 `reasoningTokens`，
  `finish.reason` 均为 `stop`）。故 e2e **不要断言「正文非空」**（会随机失败），
  判据用 `finish.reason.kind === 'stop'`。排查脚本
  `scripts/probe-trae-effort-stream.ts <model> <effort|''> <maxTokens>`（打印
  每个 chunk 类型、usage 与 finish 原因；**消耗额度**）。
- `defaultEffort` 必须落在 `efforts` 内 —— DSH 会拿它直接发请求，给一个不存在的
  档位会抛 `UNSUPPORTED_REASONING_EFFORT`。因为取值来自 `options` 本身，天然满足。
  实测 DSH 侧物化逻辑：`dsh-llm` 的 `LlmRuntime` 在 `requested ?? reasoning.defaultEffort`
  处把默认档写进 `config.reasoningEffort`（调用方不传时），并校验成员关系 ——
  所以**只声明 `defaultEffort` 即可**，适配器不必自己补发 `reasoning_effort`。
- 下发：`stream()` 把 `options.reasoningEffort` 原样写进 `reasoning_effort`，
  **不做白名单校验**（校验只会把「远端新增档位」变成静默丢弃）。
- ⚠️ `options` 为**对象数组**（`{level, openclawLevel}`）时取 `openclawLevel`、
  回退 `level` —— 这是防御性兼容：上游若改成双字段形态，解析不会退化成空数组。

#### TRAE 的 Max 模式（1M 上下文，**默认开启**）

`display_config.max_mode === true` 的模型支持 **Max 模式**（1M 窗口）。协议逆向自
`Trae2api-cn/src/trae_remote_client.py:249-397`（`_max_mode_requested` /
`_max_mode_fields`），要点：

- **不能只把 `max_tokens` 调大**：上游按 `strategy=max` +
  `model_auto_selection.strategy=max` 判定「这是 Max 会话」，缺了它们只会被当成
  常规会话、按 200K 校验，然后拒绝 1M 的输入。三件套
  （`context_window_size` / `prompt_max_tokens` / `max_tokens`）必须**成套**下发。
- 常量：1M 窗口 / **936K** 提示词预算 / **64K** 输出上限 / `mode_type: 1`
  （`TRAE_MAX_CONTEXT_TOKENS` 等）。936K < 1M 是刻意的 —— 给输出留位。
- ⚠️ **默认开启**（用户要求「上下文用最大的那一档」）：`resolveMaxModeFlag` 只有
  见到显式假值（`DSH_TRAE_MAX_MODE=0`/`false`/`no`/`off`）才关闭。**不要**改回
  `isTruthyFlag`（那是「默认关」语义，混用会让开关静默失效）。
- ⚠️ **三个条件缺一不可**（`TraeAdapter.maxModeFor`）：
  1. 产品级 `DSH_TRAE_MAX_MODE` **未关**（默认开；Max 会话计费倍率不同，要省额度时设 `0`）；
  2. 远端 `display_config.max_mode === true` —— **绝不**给未标记的模型硬套 Max 参数，
     CN 项目原注释明写 *"Never fabricate max limits for a model the account config
     does not mark"*，上游会拒；
  3. `DSH_TRAE_MAX_MODELS` 白名单（留空/含 `*` = 全部）。
- 未标 `max_mode` 的模型即便开关为开也**仍走 `dev`(200K)** —— 开启不会让任何模型失败，
  这部分「最大的那一档」就是它自己能用的最大档。
- **注入点在 `clampTraeMaxTokens` 之后**：Max 会话的输出上限由 `__max` 明细声明
  （实测 `custom_model_1M__max` 384000 vs `__dev` 64000），被 64K clamp 覆盖会让
  Max 请求与常规请求的输出预算相同、失去意义。
- `resolveModel` 同步切换：Max 生效时 `contextWindow` 用 `max`（1M）、
  `defaultMaxTokens` 用 `maxModeOutputTokens`；未生效时仍用 `dev`（200K）。
  **两者绝不能混用** —— 未开 Max 却声明 1M 会让 DSH 把超长上下文直接发出去，
  上游按 200K 校验后拒绝。

#### ⚠️ TRAE **支持图片**，但必须逐模型判定（Issue #IKHDKC）

**真实缺陷**（用户报障「TRAE字节 模型不支持图片」）：早期 `inputModalitiesFor`
恒返回 `['text']`（参数名是 `_model`，即**刻意忽略模型**），理由写的是
「SOLO 通道未见图片能力」。后果不只是「少个功能」——`inputModalities` 是
**DSH 的准入闸门**，图片在**附件入库阶段**就被拒
（`session/attachment-invalid`），用户看到「当前模型不支持图片，请切换支持
图片的模型」，而报错把原因指向**模型**，真实原因是**插件**。

**实测证伪**（2026-09-21，真实凭据）：

1. 远端目录**一直**在 `display_config.multimodal` 里声明该能力 —— 它与
   `max_mode` / `is_custom_model` 是**同一层级的相邻字段**，当初读了一个漏了另一个
   （52 个可调用条目中 27 个为 `true`；本插件可见集 19 个中 15 个为 `true`）；
2. **直发图片，模型真的看得见**：纯红图答「红色」、纯蓝图答「蓝色」、
   不带图答「无法确定」—— 三次答案不同，且无图时思考链明说「并没有提供图片」。
   ⚠️ 只验「不报错」不够：**静默丢图同样不报错**，必须做这种三连对照；
3. **反向对照定死判据**：`multimodal: false` 的模型（`DeepSeek-V4-Pro-Official`）
   收到图后答「无法确定」、思考链说「但没有图片」，**与不带图的回答一致**
   → 该标志是**权威准入判据**，不能按 provider 一刀切。

⚠️ **两个字段是两种独立能力，不可合并**：`multimodal`（用户贴图）与
`tool_response_multimodal`（工具结果图能否回传）。实测 `deepseek-v4.1-flash`
前者 `true`、后者 `false`；Doubao / Kimi 系列两者皆 `true`。
本插件**只消费 `multimodal`**，另一个仅保留信息。

⚠️ **请求形态无需协议逆向**：`transformToSOLOBody` 对**数组形态的 content
原样透传**，所以 OpenAI 的 `{type:'image_url',image_url:{url}}`（data URL）
直发即被接受 —— 与 buddy / lobsterai 适配器**完全同款**，没有 TRAE 专属转换。

落点（四处）：

1. `src/trae.ts`：`TraeRemoteModel` 加 `multimodal` / `toolResponseMultimodal`，
   `parseTraeConfigEntry` 与 `maxMode` 相邻处读取（含 PascalCase 回退）；
2. `inputModalitiesFor(model)` 改为 `remoteMeta.get(model)?.multimodal === true
   ? ['text','image'] : ['text']`（**未声明按不支持**，不臆造能力）；
3. `listModels` / `resolveModel` **两个出口**都改用它（漏一个闸门仍会拦图）；
4. `stream()`：按模型判定 —— 声明支持则读 `readImage` 字节转 data URL
   （`collectImages` 递归收集 + `userContentParts` 递归序列化，
   **两侧必须对称**）；不支持则明确报错且**不发请求**。

⚠️ `readImage` 必须由 `index.ts` 桥接（`makeReadImage(ctx)`）。缺失时收到图片
报「需要附件服务」而**不是**静默丢图；字节读取失败时留 `[image unavailable]`
占位符（空 Map 不能降级为 undefined，否则占位符也被跳过）。

#### 修法落点（四处）

1. `parseTraeBatchModelList`（`src/trae.ts`）按通道合并目录，每条记上 `function`
   与三个标志；同一 `config_name` 出现在多个 function 时**后面的覆盖前面的**
   （后面的条目带更完整的 `reasoning_effort_config` / `model_detail_list`）。
   同时执行三条硬性过滤：`usage !== 'chat_completion'` / `config_switch === false` /
   `is_invisible_to_user === true` 全部剔除。
2. `TraeAdapter.listModels` 过滤掉 `is_custom_model === true` 与 `isHidden === true`
   （`remoteMeta` 保留全量，已持久化的模型 id 仍可解析）。
3. `TraeAdapter.channelFor(model)` → `transformToSOLOBody(body, undefined, channel)`：
   **发送时按该模型所属通道下发 `function`**，查不到才回退 `product.function`。
4. `traeStreamErrorMessage` 给 `4001` 追加「模型不被上游接受」，同时**保留**上游原文
   与错误码。其余错误码保持原文，**不做无依据的解释**。

> ⚠️ `hideInternalModels`（`DSH_TRAE_HIDE_INTERNAL`）与 `isTraeModelUsable` 的
> `hideInternal` 参数**已废弃**：`is_invisible_to_user` 现在是**硬性过滤**，因为
> 目录要与官方 Auto Mode 选择器一致。字段保留仅为兼容既有 profile。
> `channels` 默认已改为 `['solo_agent', 'solo_work_lite', 'solo_agent_remote']`，
> 首位 `solo_agent` 对应截图 Auto Mode 的模型列表。

#### ⚠️⚠️ 图片能力必须**三态**：「未知」既不能当不支持，也不能报 `['text']`（Issue IKJQ3M）

**真实缺陷**（用户报障「buddy/space-bunny 贴图报 does not accept image input」）：
`inputModalitiesFor` 恒返回数组，把两种**语义相反**的状态压成同一个 `['text']` ——
「远端明确说不支持」与「远端目录还没拉到」。

⚠️ **第二处根因在白名单，且它不是瞬时问题**：issue 原文以为「重启即自愈」，
实测**不成立**。`reconcileWithFallback` 是白名单式重建，不在产品兜底表里的模型
被整个丢弃（**连同它自带的 `supportsImages: true`**），而兜底表是编译期快照、
必然滞后于服务端上新。实测 `space-bunny` 由 scoped 端点下发且带完整能力元数据，
但**未被任何 agent 引用** ⇒ 远端目录**即使拉取成功**也照样误判。
⇒ 「不在编译期快照里」与「服务端未声明可选」是**两回事**。

**三条判据（buddy/workbuddy 两站共用同一个 `BuddyAdapter`）**：

| 能力状态 | `inputModalitiesFor` | 后果 |
|---|---|---|
| 已知支持 | `['text','image']` | 放行 |
| 已知不支持（远端显式 `false`） | `['text']` | 拒绝，报 `UNSUPPORTED_CONTENT` |
| **未知** | **`undefined`（省略字段）** | 拒绝，报**可区分**的错误码 |

⚠️⚠️ **未知必须省略字段，绝不能报 `['text']`**：宿主契约明写
「absent means unknown」（dsh-llm `types.d.ts` 的 `inputModalities`），而 DSH
见到「不含 image」的声明会按「**确认是纯文本模型**」把图片
**静默投影成占位文本**（`lib/index.js` 的 `projectImagesForTextModel`）
⇒ 图既没进请求体、用户也拿不到任何原因。比报错更隐蔽。

⚠️ **未知时的错误码不能取 `TRANSPORT`**（本轮实测踩过）：harness 的
`DEFAULT_RETRYABLE_CODES` 是 `['EMPTY_RESPONSE','RATE_LIMIT','SERVER',
'TIMEOUT','TRANSPORT']` —— `TRANSPORT` **就在里面** ⇒ 一次用户报错被白重试
5 次（500/1000/2000/4000/8000 ms），每次重走一遍 `stream()`。用**明确不可重试**
的码（`INVALID_REQUEST`），让用户在目录恢复后自己重试。
⚠️ 该常量在 `lib/types/*.d.ts` 里**未导出**，单测要断言「不在可重试集合里」
只能**从 `lib/index.js` 源码原文读出来**再比 —— 写死字面量属同义反复。

⚠️ **白名单放宽只能认 `supportsImages`**（本轮自查抓到的自伤）：初版写「有任一
能力元数据就保留」，结果把实测 `11102 service info not found` 的模型
（glm-4.6/4.7/5.0、minimax-m2.5、kimi-k2.5、hunyuan-* …）请回了模型选择器 ——
**它们同样带 `contextWindow` 与 `maxOutputTokens`**（见 `product.ts` 的
`CODEBUDDY_FALLBACK_MODELS` 注释，正是因不可调用才排除）。用户选中后才报错，
**比原 issue 更糟**。

⚠️ **「等目录就绪」的重试必须自己设间隔**（用户 2026-10-06 定：**≥10 秒**）：
`RemoteCatalogGate` 默认冷却 **30 秒**，照用会让「请稍后重试」迟迟不兑现；
而无节流的「贴图就重拉」会把每个模型的每次带图请求放大成一次远端拉取
（目录端点超时上限 **60 秒**，那正是首屏「加载模型巨长」的成因）。
实现：`RemoteCatalogGate.sinceLastAttemptMs()` + `BuddyAdapter.refreshCatalog()`。
⚠️ `sinceLastAttemptMs()` **只在 `run()` 主路径更新**（`inFlight` 去重分支不更新），
故实测并发 20 个带图请求、串行 5 次、以及一次 5 秒长拉取期间并发 6 次 ——
**目录端点均只被调用 1 次**（`inFlight` 去重已足够挡住并发放大）。

⚠️ **其余 provider 大多仍报 `['text']`**（trae/lobsterai/cline/qoder/opencode…）。
那是**各自刻意**的「未声明按不支持」取舍，本轮**未动**：改一个先看它的目录是否
真的有「未知态」（有的家目录永不失败，恒可用 ⇒ 不存在未知态）。

#### 真实 CN IDE 的其它情报（Reqable 抓包，`Trae CN.exe 3.3.94`）

- 头：`x-ide-version: 3.3.94` / `20260820`、`x-app-version: default`、
  `package-type: stable_cn`、`x-lgw-req-sdk-type: 3`、UA `TraeClient/TTNet`；
  `x-machine-id` 是 **64 hex**、`x-device-id` 是 **16 位数字** —— 与本插件的
  32hex/32hex **不同**（本插件走的是旧 SOLO 协议，勿照搬）。
- `llm_utils_chat` / `create_agent_task` 的**请求体是加密的**（配 `x-helios` /
  `x-medusa` / `x-neptune` / `x-request-pin` / `x-requested-at`）。实测**仅换版本头
  解不开**加密的那批模型（`deepseek-v4-flash` 等仍失败）→ 门槛是加密信封本身，
  属独立工作量，**尚未实现**。
- 另有 22 个 function（`chat_v3` 58 / `builder_v3` 51 / `solo_coder` 46 / `solo_agent`
  66 …）与非对话通道（`multimodal` / `system_diagnosis`）；本插件只默认启用实测过的
  `solo_work_lite` + `solo_agent_remote`（`DSH_TRAE_CHANNELS` 可覆盖）。

> **排除性证据**（都做过，别重复走）：消息序列化 / `tools.parameters` / 多轮
> `tool_calls`+`tool` 结果、`max_tokens`（64000 与 128000）**全部通过**；
> 兜底表 id 也都真实存在；`X-Ide-Version` 的旧归因**未复现**（`glm-5.3` 在
> `0.1.43` 与 `0.1.52` 下都通过）。
> ⚠️ 曾经把上面的 ③ 误判为「突发限流」和「host 不匹配」——两次都是错的。
> **全 4001 时先检查自己发的头**，再怀疑上游。

### ⚠️ 登录回调**没有** `code`：直接回传 token，参数名是 `auth_callback_url`

**真实缺陷**（用户报障「网页一直停在认证中的界面」）：早期实现按 OAuth 惯例
把 TRAE 当成标准的授权码流程，于是：

1. 登录 URL 只发了 5 个参数，且回调地址用了 `callback_url` / `redirect_uri` ——
   **真实参数名是 `auth_callback_url`**。名字错了 TRAE 拿不到回调地址，
   登录页既不跳转也不回传任何东西；
2. 回调解析去找 `?code=` —— 而真实回调**根本没有该参数**，它直接回传
   `refreshToken` / `userInfo` / `userJwt`。于是 `parseTraeCallback` 恒判失败
   → 回调服务器回 400 → `result` Promise **永不落定**
   → 前端 `login.poll` 永远拿不到 `done:true` → **一直显示「认证中」**。

正确的登录 URL 是 **18 个参数**（唯一权威：`login.sh:47-72` /
Go 端 `BuildLoginURL`）：`login_version=1`、`auth_from=solo`、
`login_channel=native_ide`、`plugin_version=2.3.62834`、`auth_type=local`、
`client_id`、`redirect=0`、`login_trace_id`（hex16，回调据此反查 pending）、
`auth_callback_url`、`machine_id`、`device_id` 与 `x_machine_id` / `x_device_id`
/ `x_device_brand=PC` / `x_device_type=PC` / `x_os_version=1.0` /
`x_app_version` / `x_app_type=stable`。

真实回调形态：

```
http://127.0.0.1:18080/authorize?refreshToken=...&userInfo={...}&userJwt={...}
```

要点：

- `plugin_version`（`2.3.62834`）与 `ideVersion`（`0.1.52`）是**两个独立字段**：
  前者给登录门户，后者是 chat 端点的模型准入版本，不可混用
- 解析容错对齐 `login.sh:153-166`：`refreshToken` 缺失时回退
  `userJwt.RefreshToken`；两者都缺才用 `userJwt.Token` 兜底
- ⚠️ 回调的 `userInfo` 字段名是 **`TenantID`**（不是 `EnterpriseID`），
  且中文昵称存在**双重编码**乱码（实测 `Óû§8847309959`），
  须按 `fixNicknameMojibake` 回转，修不好则回退「用户+uid末4位」
- `device_id` 是 **hex32**（`login.sh:34` 的 `openssl rand -hex 16`），
  早期误用「16 位纯数字」（那是 CodeBuddy 的签到格式）

#### ⚠️ 但「带 `code` 的回调」**不是**无效回调（第二次修正，避免过度断言）

上面那条结论只说明「token 直传」是**当时实测的**流程，**不能**推广成
「带 `code` 即非法」。`Trae2api-cn/src/main.py:478-484` 的注释写明了真相：

```
1. 新流程 (code_challenge): callback 会带 authCodeInfo / code 等参数
2. 老流程 (refreshToken):    callback 直接带 refreshToken=xxx
```

**两套流程并存**。若把带 `code` 的回调一律判为「无效」，一旦上游把登录门户
切到 PKCE 新流程，**合法回调会被误判为失败**，症状与「一直认证中」一模一样，
而报错文案（「缺少 refreshToken」）会把排查方向带偏。

正确做法：`parseTraeCallbackDetailed` 对两种形态**都返回结果**，用
`authCodeFlow: true` 区分，并给出「上游返回了 PKCE 授权码，本实现暂不支持该
流程」这种**指向真实原因**的文案。注意 `authCodeInfo` 可能是 JSON
（`{code:...}`）也可能是**纯 code 字符串**，两种都要认。

> 教训：把「某次实测没见到 X」写成「X 一定不存在」是很危险的断言 ——
> 它会把未来的正常情况判成故障，且错误信息指向错误的方向。

#### ⚠️ 无效回调**必须落定结果 Promise**（第二个「一直认证中」根因）

`startTraeLoginFlow` 与 `startCallbackServer`（`src/trae-oauth.ts`）**两个**
回调处理器里，解析失败的分支早期都只写了：

```ts
res.writeHead(400, ...); res.end(...); return   // ← 没有 resolve 也没有 reject
```

结果 Promise 悬空 → 前端 `login.poll` 永远拿不到 `done:true` →
**界面永久停在「认证中」**，只能等 10 分钟超时。

这与「参数名写错」是**两个独立根因、同一个症状**：修好协议解析并不能顺带
修掉它，必须单独保证「**任何**回调路径都落定 Promise」。
`startCallbackServer` 是 `TraeAuth` / RPC 实际走的路径，漏改它同样致命 ——
两处都要有 `reject(...)`。

回归用例：`tests/unit/trae-oauth.spec.ts` 的「无任何可用参数的回调也必须落定
结果」。注意用例必须**先挂拒绝处理器再触发回调**，否则窗口期内它是未处理拒绝。

### ⚠️ 本地回调服务器：listen 失败必须先注册 `error`，否则崩掉整个宿主

`startTraeLoginFlow` / `startCallbackServer`（`src/trae-oauth.ts`）里，
`server.listen()` 的失败（最典型 `EADDRINUSE`：端口被占用）是**通过
`'error'` 事件异步抛出**的，**不属于 Promise 链** —— `await` 一个内部调用
`listen()` 的 Promise **捕获不到**它。

**真实缺陷**（用户报障，进程级崩溃）：早期实现直接 `server.listen(18080)`，
没给 `'error'` 注册处理器。于是 18080 被占用时：

- 该错误逃过 RPC 层的 `try/catch`；
- 成为**进程级 unhandled error**，把**整个 DSH 宿主**打挂；
- 用户看到的不是可读文案，而是一整堆
  `Error: listen EADDRINUSE: address already in use :::18080` + 堆栈 + 进程退出。

修法（`listenOrReject`，三处缺一不可）：

1. **在 `listen()` 之前**注册 `'error'`，把首个错误转成 Promise reject，
   让 RPC 层能照常返回规范错误响应；
2. 启动成功后把一次性处理器**降级为常驻监听** —— 运行期也可能出现 `'error'`
   （如 EMFILE），没有监听者会再次变成进程级崩溃；
3. 绑定 **`127.0.0.1`** 而非 `::`/`0.0.0.0`：这是本地 OAuth 回调，绑定所有
   网卡会让同局域网的机器也能投递伪造的 `?code=`，把攻击者的授权码写进用户
   凭据（`src/login.ts` 与 `src/lobsterai-oauth.ts` 同样只绑回环）。

配套：端口被占用时**回退到系统分配的随机端口**（`listenWithFallback`），
而不是直接失败。TRAE 的 `redirect_uri` 是我们自己构造并随登录 URL 下发的，
服务端原样回跳 —— 因此端口不固定也能工作。**注意顺序**：必须先 `listen`
拿到实际端口，**再**构造 `redirect_uri`（否则回调会打到没人监听的地址）。
这与 CodeArts 的 `listenOnCallbackPort` 同思路。

> 排查提示：Windows 上 `::` 与 `127.0.0.1` 是**两套可共存的栈**。写「端口占用」
> 的测试时，占位方必须绑与服务端**相同的地址族**，否则产品侧仍能绑定成功，
> 用例变成假阳性（本模块的 `tests/unit/trae-oauth.spec.ts` 踩过这个坑）。

### ⚠️ 错误分类必须先判更严重的类别

`classifyTraeError` 的判定顺序里，**`quota-exceeded`（4008）必须排在 `soft-rate`（4011）之前**。

两者可能同时出现在一个响应体里（网关把多个错误码拼在 msg 中）。`quota-exceeded` 需长冷却，`soft-rate` 只需短冷却 —— 让较轻的类别抢先命中，会让一个已耗尽额度的账号在 60 秒后被反复重试，用户看到的却是「稍后再试」。**真实缺陷**：早期实现把 4011 放在前面，`tests/unit/trae-errors.spec.ts` 已锁死该顺序。

### ⚠️ 续期的终态判定要看三种依据

`TraeAuth.refreshCredential` 判定「需重新登录」有三种独立依据，缺任一种都会让用户卡在无解的重试里：

1. HTTP 401 / 403（状态码最权威）
2. 分类结果为 `session-dead`
3. **拿到了 2xx、响应体也是 JSON，却没有 `accessToken`** —— 对齐 Go 的 `refresh_failed: no token in response — re-login required` 与 `LobsteraiAuth` 的同款处理。这不是瞬时故障，重试一万次也不会有 token

反之，**传输层失败（网络抖动）与 5xx 必须是可重试的普通 Error**，否则一次瞬时故障就让用户重新登录。另外响应体要**先取文本再解析**（不要直接 `response.json()`）：凭据失效时网关返回 HTML，`json()` 抛出的 `Unexpected token '<'` 对用户毫无意义。

### ⚠️ TRAE 签到：请求头与设备身份必须对齐真实客户端（`trae-mate` 实证）

**真实缺陷**（用户报障「模型没问题了，但签到有问题」）。参考实现
`E:\Workplace\APP\Tauri\trae-mate\src-tauri\src\checkin.rs` 是**能正确签到**的版本，
与旧实现有三处根本差异（旧实现在此之前只有 6 个精简头 + `{"req_source":2}`）：

| 维度 | 旧实现（失败） | trae-mate（成功） |
|---|---|---|
| 请求头 | 6 个（`Content-Type` / `Accept` / UA / `Authorization` / `X-User-Region` / `X-Device-Id`） | **约 20 个**客户端头 |
| 设备号 | `deriveCheckinDeviceId(credential.device_id, gen)`（32 hex） | **基于 `user_id` 确定性派生的 15 位数字** |
| claim body | `{"req_source":2}` | **`{}`** |

要点（`traeCheckinHeaders` 已全部落地）：

- **设备身份是「每账号一套、稳定派生」**，不是从凭据的 `device_id` 取。三件套
  （对齐 `device_map.rs`，salt 各不同）：
  - `X-Device-Id`：15 位数字（`seededDigits(15, uid, 'devid')`）
  - `X-Market-User-Id`：UUID v4（`seededStream(uid,'market',16)`，置 version/variant 位）
  - `Vscode-Sessionid`：64 hex（`seededStream(uid,'sess',32)`）
  同一 `uid` 永远得到同一套值 → 多账号天然互异，规避「每设备每天一次」配额。
- 新增头：`X-Market-Client-Id` / `X-Lgw-Req-Sdk-Type: 3` / `Package-Type: stable_cn` /
  `X-Lscbd-Aid: 787976` / `X-Lscbd-Platform` / `App-Version` / `X-Tt-Trace-Id` /
  `X-Request-Id`（**每请求刷新**）/ `Sec-Fetch-*`。
- **签到与余额都要用完整头**（`postJson` 统一走 `traeCheckinHeaders`）；
  `traeUgHeaders` 保留给其它 Ug 场景。
- **积分余额 body 改为 `{"require_usage": true, "req_source": 2}`**（不是 `{}`）——
  不带它拿不到 `usage`，余额会恒等于额度。
- **9074 不再换设备号重试**：设备身份已由 `uid` 确定性决定、每账号独立，
  「换个派生 id 立刻成功」的旧前提不成立。命中 9074 时归为 `BusinessError`（300s 冷却）
  并如实上报。
- ⚠️ **claim 响应不含积分数，必须补查 status**：`checkin_credits/claim` 的完整响应
  就是 `{"code":0,"message":"success"}`。**真实用户报障**：「领取积分显示成功但是加
  0 积分」—— 早期实现读 claim 响应的 `credits`，而该字段根本不存在，故**恒为 0**。
  所得数值只在 **status 端点**的 `credits` 字段里（实测 `150`，与积分余额中
  「签到奖励」包的 `credits_limit:150` 吻合）。现在 `claimTraeDailyCheckin` 在
  `code === 0` 后补查一次 status；补查失败时 `credit` 为 0 但**仍是 claimed**
  （不因补查失败而把成功判成失败）。
- ⚠️ **claim 对「今天已签到」是幂等的**：实测重复领取同样返回
  `{code:0, message:"success"}`，与真正成功**无法区分**。因此 `credits.claimAll`
  的 TRAE 分支**必须开启状态预检**（`collectClaimResults` 的 `precheckStatus` 保持
  默认 true 并注入 `fetchStatus`）—— 早期照抄 LobsterAI 传了 `precheckStatus: false`
  （那是「LobsterAI 领取流程内部已做 slot/context 预检」的理由，TRAE 没有这回事），
  于是已签到的账号被报成「领取成功」。判据只能是 status 的 `checked_in`。
  已有源码级守卫（`tests/unit/jet-hub-rpc.spec.ts` 的「TRAE 的 claim 分支开启状态预检」）。
- **错误分类**（`classifyTraeCheckinError`，对齐 `cooldown.rs`）：
  `200+1005 → PlanLimit(12h)` / `429 → SoftRate(60s)` / `401 → SessionDead(永久)` /
  `404 → NotFound(60s)` / `5xx → Server(600s)` / `4xx → Client(600s)` /
  `业务码非0 → BusinessError(300s)`。
- ⚠️ **网络异常与业务失败必须分开**：`postJson` 区分 `httpStatus === 0`（传输层失败，
  可重试）与有状态码（业务失败，**不**重试）。重试只针对前者。

> 旧实现里 `deriveCheckinDeviceId` / `AccountPool.traeCheckinDeviceGeneration*` /
> `TRAE_CHECKIN_BUSY_CODE` 的轮换链路**保留但不再被调用**，仅为兼容既有账号条目；
> 新语义下设备号由 `uid` 派生，无需持久化代次。

### ⚠️ TRAE 历史闸门（**已删除**）：抄来的常数，且会**静默丢历史**

**真实缺陷**（用户报障 2026-10-04：「trae 显示的上下文长度不对」）。根因是
`src/trae-adapter.ts` 里那道**只有 trae 有的**本地历史字符闸门 —— 超预算就从最早的
非系统消息开始整轮丢弃。它已被**整体删除**（PR #48）。现况：**唯一的限制是 DSH 的
压缩点（`声明的窗口 × 0.8`）**，与其余 13 个 provider 同形。

**它的来历是「抄的」，不是「量的」**：注释原文写「对齐 `Trae2api-cn` 的实测结论：
上游在 query 超过约 500K 字符时会静默结束事件流」，于是把那个项目的
`TRAE_REMOTE_MAX_HISTORY_CHARS=480000` 抄成本插件写死的 `480_000`。

- ⚠️ `480000 = 2.4 × 200000` —— 那是**声明窗口本身的量级**，不是量出来的字符天花板。
- ⚠️ 它守的另一道闸门（`TRAE_REMOTE_QUERY_MAX_CHARS`，**扁平化 query** 的硬上限）
  在本插件里**根本没有对应物**：trae 链路里没有 `query` 字段，我们发的是 OpenAI 形状的
  `messages[]`（上游那句 `Messages with role 'tool' …` 本身就证明它在逐条读 role）。

**它造成的是净损害**：引入 Max 模式（声明 1M）后，写死的 480,000 没跟着涨，与压缩点
（800K tokens ≈ 170 万字符）**脱钩** ⇒ 界面显示「才用了 8%」，适配器却每轮静默丢掉约
四分之三的历史（真实会话量：**1,898,903 字符 = 旧预算的 396%**）。

**为什么「把系数调大」不够，必须删**：

| 版本 | 预算 | 结果 |
|---|---|---|
| 写死 `480000` | Max 档恒定 ≈22% 窗口 | **静默丢历史**（本次缺陷的根因） |
| `声明窗口 × 2` | 覆盖 `R < 2.5` | 中文会话修好，英文/代码为主的会话仍在窗口 40~60% 处**静默丢** |
| `声明窗口 × 5` | 覆盖 `R ≤ 6.25` | 实测内容（`R`：中文 **2.13**、英文/代码 **4.0** —— 两者都已实测）不再误伤，**但**字符闸门在数学上**不可能**被证明「永不先于 DSH 的压缩点生效」：DSH 的界是 token、闸门是字符，任何**有限**系数都会被足够密的内容绕过 |
| **已删除** | 无 | 「静默丢历史」这一类缺陷**结构上消失** |

- **实测依据（本仓库探针，2026-10-04）**：

  | 档位 | 正文字符 | 服务端 `input_tokens` | 字符/token | 结果 |
  |---|---|---|---|---|
  | 常规（非 Max） | 40,398（标定） | 9,827 | 4.11 | 200 + 正中标记命中 |
  | 常规（非 Max） | **700,404** | 173,712 | 4.03 | **200 + 正中标记命中**（6.4 秒） |
  | 常规（非 Max） | **1,000,484** | 249,351 | 4.01 | **200 + 正中标记命中**（7.0 秒） |
  | 常规（非 Max） | 900,303（中文正文） | 422,672 | 2.13 | 200 + 正中标记命中 |

  ⇒ 「query 超过约 **500K 字符**就静默断流」在**常规档已被证伪到 2 倍**：100 万字符 /
  24.9 万 tokens，比该档声明的 200K 窗口**还超出约 24%**，仍然是 HTTP 200 且
  **埋在正文正中间的标记被复述**（任何截断/丢中段都会让它消失）。
- ⚠️ **2026-10-04 那次「Max 档 90 万字符」是**误标**档位**（本人记错）：探针构造适配器时
  `fetchRemoteModels: async () => []`，而 `maxModeFor()` 要求远端
  `display_config.max_mode === true`（`src/trae-adapter.ts:689`）—— 远端元数据为空时
  **恒为 false**，故那次实发的其实是**常规档**。重跑时把请求体抓下来打印确认：
  常规档请求体 `含 strategy=false context_window_size=false prompt_max_tokens=false`。
  ⇒ **引用旧记录时别再写成「Max 档」**。
- ⚠️ **仍未探的部分**：真正的 **Max 档**（注入远端 `max_mode=true` 后的 1M 声明）没跑过
  大正文；常规档 > 100 万字符也没探。但闸门已删，这两点**不再影响任何决策** ——
  只有「有人想把闸门加回来」时才需要补。
- ⚠️ 顺带实测到的两点事实：① 该档声明 200K 窗口，但 **24.9 万 tokens 的请求照样 200**
  （窗口并非硬校验）；② 探针**没有设任何逃生舱环境变量**就发出了 100 万字符 ——
  这本身就是「闸门确实已被删除」的端到端证据（旧实现里不设
  `DSH_TRAE_MAX_HISTORY_CHARS` 会把它裁到预算以内）。
- ⚠️ **为什么其余 13 家不需要这种闸门**：它们把 DSH 的压缩点当唯一真相。唯一的另一类体积
  防护（`src/image-budget.ts`，13 家共用）作用在**单张图的编码字节**上，数值来自**实测撞墙
  点**（qoder 8 张过 / 15 张 `TRANSPORT`、lobsterai 12 / 13×`500`、cline 24 / 32
  `TRANSPORT`），且压不下去时**抛 `UNSUPPORTED_CONTENT`**（可见报错），**不是**悄悄丢消息。
  ⇒ **判据：本仓库的体积防护只允许「按实测定界 + 失败可见」**；「抄来的常数 + 静默删改
  语义」是不允许的形态。
- `DSH_TRAE_MAX_HISTORY_CHARS` 已随闸门删除（即使设置也**不再生效**）。
- 回归用例在 `tests/unit/trae-adapter.spec.ts` 的「无本地历史闸门（本地裁剪已删除）」段
  （4 条：Max 档 60 万字符 / 20K 窗口 30 万字符 / 1M 档 600 万字符 / 该环境变量已失效）。
  ⚠️ **已做反向验证**：临时装回「写死 480000」→ 其中 **2 条**变红；临时装回
  「声明窗口 × 5」→ **另 2 条**变红（两种旧形态各自被锁住，不是同义反复）。
- ⚠️ **若将来要加回来**：先做实发探针量出真实边界**与失败形态**（可见错误？静默结束？），
  且闸门**必须可观测**（记日志/上报），不得静默改语义；同时改本段与
  `src/trae-adapter.ts` 的「TRAE 没有本地历史闸门」注释。

### ⚠️ 空响应（静默 EOF）只允许在**首个事件之前**重试一次

上游有时会「HTTP 200、会话创建成功、一个事件都不发就结束流」。`consumeSse`
用 `sawAnyUpstreamEvent` 标记是否收到过**任何**可解析事件，并在**一个都没有**时
抛 `TRANSPORT`（可重试），由 `stream()` 重试**一次**。

- ⚠️ **一旦已向上游消费者发出过任何 chunk 就绝不重放**：重放会让上游
  **重复计费**，并可能**重复执行工具**（对齐 CN 项目的
  `TRAE_REMOTE_WORK_FALLBACK` 语义）

  ⚠️⚠️ **判据是「已发出 chunk」，不是「已收到 output 事件」（2026-10-25 审计 P0 修复）**：
  旧实现把 `gotAnyContent` **只在正文分片（`ev.response`）非空时**置真，于是
  「已发出**思考**」与「已发出**工具调用**」两种情况仍被判成「尚未产出」⇒
  流内 `event:error` 照样**换号重放**。而重试循环在 `stream()` **内部**，
  harness 只看到**一条连续流** ⇒ 第一次 attempt 的 `tool-call-delta` 变成
  **幽灵调用**：`BlockAssembler.assembled()` **只在 `max-tokens` 时**丢弃
  tool-call（不过滤没有 `block-end` 的 partial），`dsh-agent-loop` 也**不去重**
  ⇒ harness 会执行一个模型已经放弃的工具（分片中断时参数还可能是**截断的非法
  JSON**）。真实后果：模型在第二轮说「直接回答、不用跑命令」，而工具仍被执行。
  ⇒ 三个发射点（`text-delta` / `reasoning-delta` / `tool-call-delta`）**都**置真，
  且只在**真正 yield 之后**（被 suppressor / 死循环守卫 / 空名字拦下的分片一个
  chunk 都没发，重发不产生幽灵调用）。这条路径此前**零守卫** —— 把缺陷真修掉，
  146 条既有 trae 用例仍然全绿。
- ⚠️ **不能把空响应当成正常的空 finish**：那会让用户看到「模型回复为空」这种
  毫无线索的结果，且不触发任何重试

### 单次输出上限收敛到 64K（`clampTraeMaxTokens`）

CN 项目实测：SOLO CN 的 agent-remote 模型单次响应上限 **64000 tokens**，并明确
警告「客户端索要 131072 会把上游打成 4xx」（`model_limits.py:9-23`）。

故 `clampTraeMaxTokens` 默认把 `max_tokens` 收敛到 **64000**
（`DSH_TRAE_MAX_COMPLETION_TOKENS` 可覆盖，设 `0` 表示关闭收敛）。

> **后续实测补正（2026-09-19）**：远端 `model_detail_list[].max_tokens` 对**主流
> 模型声明的就是 32000**（不是 64000，也不是兜底表旧值的 128000）。现在该值被
> 真正消费并写进 `resolveModel` 的 `defaultMaxTokens`，所以这个 64000 收敛在实际
> 请求里通常**不会生效**（32K 已低于阈值）—— 它保留为「上游没声明时」的最后一道
> 保险。若某模型远端声明偏大，调大 `DSH_TRAE_MAX_COMPLETION_TOKENS` 即可。

### 机器指纹轮换默认**关闭**（`DSH_TRAE_ROTATE_MACHINE_ID`）

CN 项目每 3~5 次请求主动换 `machine_id` 以「降低 IDE 端点风控」
（`trae_client.py:211-224`）。但这与本地既定约束
「`machine_id` 登录后**绝不重新生成**」冲突 —— 它换来抗风控，代价是设备身份漂移，
而上游按 `machine_id` 标识设备，换值可能要求重新登录。

故该能力**默认关闭**，仅在显式设 `DSH_TRAE_ROTATE_MACHINE_ID=1` 时按每 4 次
请求递增一代（`deriveRotatingMachineId`）。它是出现**集中 401/风控**时的第一个
可尝试开关。

## ⚠️ 前缀缓存自 2026-10-26 起为 0（issue IKSFT2，**已用原始 SSE 定论**）

**实测结论（2026-11-03 e2e，`tests/e2e/trae-cache-probe.e2e.spec.ts`）**：
同一段约 3.8 万 token 的固定前缀连发三次，**直接读上游 SSE 原始 `usage`**
（不经适配器投影），`trae/deepseek-v4.1-flash` 的结果是

| 请求 | `prompt_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` |
|---|---|---|---|
| A 冷启动 | 38234 | **0** | 0 |
| B 同前缀第二次 | 38234 | **0** | 0 |
| C 同前缀 + `prompt_cache_key`（请求体确认已带，`body has key: true`） | 38234 | **0** | 0 |

⇒ 两点定论：
1. **不是字段被投影丢弃**：上游原始行里 `cache_read_input_tokens` 就是 0；
2. **`prompt_cache_key` 对 trae 无效**：带上后仍 0，且 `prompt_tokens` 仍是全量
   38234（没有部分命中）。对照 buddy 第二次 97.6%，客户端/网络侧正常。

插件侧 `traeUsageFromTokenUsage` 在故障前后未改，请求体也没有新增时间戳/随机 id
（`src/trae-adapter.ts` 最近改动 2026-10-25，早于 10-26）⇒ **判断为上游服务端变更**
（该时间窗内 trae 模型目录从 12 涨到 35+，疑似集群迁移）；本仓没有可修的客户端缺陷。
影响：长上下文会话每一步全量重算（用户实测单步 27s~218s、一轮 19 步 27.8 分钟）。
README 已加「不建议把 trae 当长跑主力」的提示。

⚠️ 仍待上游确认（拿到答复前不要改代码）：
1. Max 档 / 1M 集群是否不参与前缀缓存（本轮探针未切 Max 档，只验证了默认档）；
2. 上游是否已彻底关闭 trae 的前缀缓存（若是，本仓无解）；
3. 若只是换集群/换 key，官方需要给出新的命中条件（`prompt_cache_key` 已被实测排除）。
