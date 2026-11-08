# 百智云：目录没声明 `maxTokens` ⇒ 4096 兜底截断（2026-11-07 取证并修复）

> 与 MonkeyCode 同型缺陷：目录条目不声明输出上限 ⇒ 宿主不会补
> `defaultMaxTokens` ⇒ 适配器的 Anthropic 兜底 `max_tokens = 4096` 生效。
> 百智云这一侧此前**尚未**在真实会话里抓到 `max-tokens` 截断（3 个 baizhi 会话的
> `request/header` 全都没有 `maxTokens`，只是恰好没撞到长回答），属于结构性缺陷。

## 症状

- `request/header` 的 `config` 里没有 `maxTokens`，`adapterDefaults` 为 `undefined`。
- 一旦撞上长回答：`assistant/message.usage.outputTokens` **恰好 4096**、
  `finish: max-tokens`、`turn/end {"kind":"max-tokens"}`；思考预算被夹到
  `max_tokens - 1024`，推理很容易把 4096 吃光、正文 0 字。

## 根因链

1. `src/baizhi-adapter.ts` 的 `toCatalogEntry` 只映射 `inputModalities` /
   `contextWindow`，**没有 `maxTokens`**。
2. `src/model-catalog.ts` 只在条目有 `maxTokens` 时才设 `resolved.defaultMaxTokens`
   ⇒ 宿主不会替它 materialize 输出上限，请求头也不带
   `adapterDefaults.maxTokens = true`（没有该标志，宿主不会重建被改写的值）。
3. `src/baizhi-messages.ts` 的 `baizhiMaxTokensFor(undefined)` 返回
   `BAIZHI_DEFAULT_MAX_TOKENS = 4096`；Anthropic Messages 的 `max_tokens` 必填
   ⇒ 每次请求实际都发 4096。

## 修复

1. `src/baizhi-product.ts`：`BaizhiCapability` / `BaizhiModelEntry` 增加
   `maxTokens?: number`；能力表按**逐模型实测值**填写；新增
   `baizhiMaxOutputTokensFor(modelId)`（未知模型回落 `BAIZHI_MAX_OUTPUT_TOKENS`）。
2. `src/baizhi.ts`：`parseBaizhiModelList` 把能力表里的 `maxTokens` 合并进远端条目。
3. `src/baizhi-adapter.ts`：`toCatalogEntry` 透传 `maxTokens`（必须走
   `CatalogEntry.maxTokens`，写进 `context` 会被宿主白名单重建丢弃）。
   ⚠️ 2026-11-08 审计订正：`stream()` 里**不再**自己夹一次
   （原写 `baizhiMaxTokensFor(options.maxTokens, options.model)`）——
   按模型夹取只有 `buildBaizhiMessagesPayload` 一份实现，两处各夹一次时
   删掉任一处全量 12,532 条用例都全绿（互为掩码 = 这条腿没有守卫）。
4. `src/baizhi-messages.ts`：`baizhiMaxTokensFor(maxTokens, model?)` 按**模型**夹取。
   ⚠️ 不能一律夹到 100,000 —— qwen 系列会被上游 400。
5. `src/baizhi-product.ts`：`baizhiCapabilityOf` 改成**大小写不敏感**。
   原先精确 `===` 时，上游若把 id 写成 `Qwen3.6-Plus`，能力表查不到 ⇒
   `baizhiMaxOutputTokensFor` 静默回落 **100,000**（qwen 的硬限是 65,536）
   ⇒ 用户手填大预算就 400。这个路径此前**零守卫**。

## 逐模型探测（2026-11-07，真机）

方法：`POST https://ai-models.app.baizhi.cloud/api/anthropic/v1/messages`，
头 `x-api-key: sk-…` + `anthropic-version: 2023-06-01`（**无签名**），
body `{model, max_tokens, stream:true, system, messages:[短消息]}`，
收到 `event: message_start` 立即断开（只验证「网关接受该参数值」，不验证真实产出长度）。
账号：`BAIZHI_ACCOUNT_6E40BB58`。

| 上限 | 模型 |
|---|---|
| 100,000 | deepseek-v4-pro / deepseek-v4-flash / deepseek-v4-flash-vision-exp / deepseek-flash、minimax-m2.7 / minimax-m2.5 / minimax-m3.1-flash、glm-5.1 / glm-5 / glm-4.7、kimi-k2.6 / kimi-k2.5 |
| 65,536 | qwen3.6-plus / qwen3.5-plus / qwen3.5-flash（100,000 时 400：`Range of max_tokens should be [1, 65536]`） |
| 32,768 | qwen-flash（100,000 时 400：`Range of max_tokens should be [1, 32768]`） |

- `deepseek-v4-flash` 另测 131,072 也是 200，但声明值保持 100,000（与既有服务级常量一致）。
- `minimax-m3.1-flash` 不在 45 条目录快照里，但会话实测在用 ⇒ 补进能力表才能下发上限。
- 未探测过的远端 id 仍不声明（宿主不给默认值 ⇒ 插件兜底 4096，不会 400）。

## 上限值准不准：三层判据

① **参数合法性**：带该 `max_tokens` 发请求，看 200/400。qwen 的边界直接来自上游
400 原文（`[1, 65536]` / `[1, 32768]`），是精确事实。

② **真实产出（防静默夹低）**：让模型真的写满，看 `usage.output_tokens` 与
`stop_reason`。2026-11-07 实测 `deepseek-v4-flash`：请求 `max_tokens=20000`、
提示词「从 1 数到 30000，每行一个」，结果 `output_tokens=20000`、
`stop_reason=max_tokens`、32,751 字符、64.5s ⇒ 没有被夹到 8192/16384。
判据是 `stop_reason=max_tokens && output_tokens == 请求值`；若 `output_tokens`
是个更小的整数，就是被上游静默夹了。

③ **端到端**：重启 DSH 后看会话 `request/header.config.maxTokens` 是否等于声明值、
`assistant/message.usage.outputTokens` 是否还恰好 4096。

`max_tokens` 是**上限**不是承诺，声明 100,000 不会让模型硬写长文；需要连极限也验证时
把 ② 的 `max_tokens` 调到 100000、目标数调到 150000（约 5 分钟、烧 10 万输出额度）。

## 自检清单

- 重启 DSH 后新建 baizhi 会话，`request/header.config.maxTokens` 应为
  `100000`（deepseek/glm/kimi/minimax）或 `65536`/`32768`（qwen），且
  `adapterDefaults` 应为 `{"maxTokens": true}`。
- 若仍看到 `outputTokens: 4096`：先确认安装副本 `lib/baizhi-adapter.js` 含
  `maxTokens: model.maxTokens`，再确认 DSH 进程是构建之后启动的。

## 2026-11-08 审计（subagent 三域 + 16 条变异）的补充与订正

### ⚠️ 根因链第 2 环的订正：「下一步就被删掉」不成立

上面第 2 环括号里写「没有该标志，宿主不会重建被改写的值」，并由此推出
「切站后下一步 `maxTokens` 就被删掉」。**这条机制不成立**，别照它复现：

- `dsh-llm/lib/index.js:2236-2244` 的 `adapterDefaults` 仅在
  `proposed.maxTokens === undefined && resolvedConfig.maxTokens !== undefined`
  时置 `maxTokens: true`。若 8192 是**显式** `agent options.maxTokens`，
  `adapterDefaults` 是空对象 `{}`。
- `dsh-session/lib/index.js:604-612` `canonicalHeader` 会把空对象整个丢掉
  （`dsh-api-session-controller/lib/client.js:257-258` 同规则：
  `must omit empty adapterDefaults`）。
- 于是 `dsh-agent-loop/lib/index.js:717-722` `requestProposal` 首行
  `if (header.adapterDefaults === void 0) return header.config` 直接返回原值
  —— **同实例内根本不会删**。

真机制是 `prepareRequest`（`dsh-agent-loop/lib/index.js:1185`）**只读
`this.options.maxTokens`**、不读 `persistedConfig.maxTokens` ⇒ 丢值发生在
**`resume` / 重建 agent**（新实例 `options` 里没有该值）。

**叙事错、修法对**：声明 `maxTokens` 后 `defaultMaxTokens` 非 `undefined`
⇒ 每次 `prepareCall` 重新补齐 ⇒ resume 也自愈。

### 压缩副作用：声明值不会踩坑（算术核对）

`dsh-compaction-basic` 的 `reservedCompletionTokens`（`lib/index.js:757`）
直接读 `agent.session.requestHeader()?.config.maxTokens`：

```
messageBudgetTokens  = contextWindow - reservedCompletionTokens
pressureBudgetTokens = messageBudgetTokens - headroomTokens     // 默认 65,536
thresholdTokens      = min(contextWindow * 0.8, pressureBudgetTokens)   // ≤0 抛错
```

- baizhi：`1,048,576 - 100,000 - 65,536 = 883,040` > `838,860` ⇒ **触发点完全不变**；
- monkeycode：`1,048,576 - 128,000 - 65,536 = 855,040` ⇒ 不变，**余量仅 16,180**；
- 边界：`maxTokens > 144,180` 才开始降阈值；`contextWindow <= maxTokens + 65,536`
  才抛 `TargetPressureConfigError`（被 `agent/pre-step` 的 catch 吞成一条 warn
  ⇒ 后果是**自动压缩被静默关闭**，不是崩）。

### ⚠️ `minimax-m3.1-flash` 的已登记债务（唯一的**新增**条目）

它只有 `maxTokens`、**没有** `contextWindow`。`src/model-catalog.ts:725-746`
只在 `entry === undefined` 时才走 `unknownModelContextWindow` 兜底 ⇒
「条目存在但不声明 contextWindow」⇒ `info.context === void 0` ⇒ 抛
`TargetPressureConfigError` ⇒ **该模型的自动压缩静默关闭**。

**不修（不编窗口）的理由**：编 1,048,576 会让它在 90 万 token 才压缩，比静默关闭
更糟。同型的还有 12 条非 deepseek 条目（`glm-5` / `kimi-*` / `qwen*` / `minimax-m2.*`），
清单已由 `tests/unit/baizhi.spec.ts` 的「未声明 contextWindow」用例钉住
（新增条目必须显式登记）。要真正关掉这条债务，只能逐模型真机探测上下文窗口。

### 与「刻意不声明 maxTokens」两份定案的关系

`src/models.ts:105-124`（2026-10-30 第二轮审计 D-4，AgentCenter）、
`src/models.ts:458-463`、`src/llm-adapter.ts:2004-2029`（同批四路审计 P1-1，
codearts）、`src/opencode-adapter.ts:392-413` 都**明确决定不声明** `maxTokens`。
**别把本 PR 当成回归**：codearts 的出站预算已由
`CODEARTS_MAX_OUTPUT_TOKENS = 65_536`（`src/llm-adapter.ts:563`）单点决定，
不声明也不改 wire 值；baizhi / monkeycode 的兜底是 `*_DEFAULT_MAX_TOKENS = 4096`，
**不声明就真的发 4096**。两边的「不声明」后果相反。

### 守卫（2026-11-08 补齐，全部变异自证 RED）

| 变异 | 结果 |
|---|---|
| `BAIZHI_QWEN_MAX_OUTPUT_TOKENS` 65,536 → 100,000（**上游 400 的值**） | RED（修前 **GREEN**） |
| `BAIZHI_QWEN_FLASH_MAX_OUTPUT_TOKENS` 32,768 → 100,000 | RED（修前 GREEN） |
| 删 `glm-4.7` 的 `maxTokens` | RED（修前 GREEN） |
| `buildBaizhiMessagesPayload` 里去掉 `options.model` | RED |
| `baizhiCapabilityOf` 回退成精确 `===` | RED |
| `baizhiMaxOutputTokensFor` 回退成常数 | RED |
| 删 baizhi / monkeycode 的「未声明 maxTokens」告警 | RED |
| `BAIZHI_MAX_OUTPUT_TOKENS` 100,000 → 200,000 | RED |
| `MONKEYCODE_MAX_OUTPUT_TOKENS` 128,000 → 4096 | RED |
| 给 `minimax-m3.1-flash` 补 `contextWindow` | RED |

⚠️ **两条判据缺一不可**（都是实测出来的）：值必须写**字面量**（兜底值与声明值
同值 ⇒ 常量对常量是同义反复），且必须断言**键存在**（`Object.hasOwn`，否则
删条目测不出来）。

⚠️ 另记一条**不可达**结论：`monkeycodeThinkingFor` / `baizhiThinkingFor` 的
档位阶梯（low 2048 / medium 4096 / high 8192）当前是**死代码** —— 两家都不声明
`reasoning` 档位，而 `dsh-llm/lib/index.js:2186-2196` 在
`reasoning === void 0 && requested !== void 0` 时直接抛
`UNSUPPORTED_REASONING_EFFORT`，请求到不了适配器。所以「思考预算 4095 → 8192
翻倍」**不会发生**；`src/monkeycode-adapter.ts:23-29` 的原注释（说「harness 自己
传了 effort 仍会映射」）已按此订正。
