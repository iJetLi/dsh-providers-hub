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
   `CatalogEntry.maxTokens`，写进 `context` 会被宿主白名单重建丢弃）；
   `stream()` 里改成 `baizhiMaxTokensFor(options.maxTokens, options.model)`。
4. `src/baizhi-messages.ts`：`baizhiMaxTokensFor(maxTokens, model?)` 按**模型**夹取。
   ⚠️ 不能一律夹到 100,000 —— qwen 系列会被上游 400。

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
