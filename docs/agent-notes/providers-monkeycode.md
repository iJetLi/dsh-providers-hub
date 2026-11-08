# MonkeyCode（猴子云）：bili 拒发 `x-ohmyagent-signature` 与直连传输

> 2026-11-05 首次记录。触发问题的组件是 **bili / billion-context**，不是 MonkeyCode
> 账号或网关；本文解释为什么只能绕过、不能配置，以及 `monkeycodeDirectFetch` 的边界。

## 症状

DSH Desktop 同时装了 `billion-context`（bili）时，MonkeyCode 的任何模型（包括
`monkeycode-basic/deepseek-flash`）在真实会话里失败，插件最终报：

```text
monkeycode: 模型 … 所有账号均不可用（auth）：monkeycode: HTTP 403 —
{"type":"error","error":{"type":"invalid_request_error","message":"bili refused to forward
this x-ohmyagent-signature-signed request: the signature covers the request body, and any
rewrite (context compression) would invalidate it upstream (401 SignatureDoesNotMatch).
bili has no re-signer for this scheme yet, and by design signed requests are either
RE-SIGNED+COMPRESSED or REFUSED — there is no unsigned pass-through mode, so NO
configuration can make this link work (passthrough settings do not ..."}}
```

真实会话证据：`~/.dsh/sessions/--F-project-pojie--/session-6d84fcc9-5cdd-4248-88d8-0bf715772320/session.v4.jsonl.zstd`，
2026-11-05 15:51 的两个 MonkeyCode 请求都命中该 403；之后会话切到 `baizhi/minimax-m3.1-flash`。

## 根因链（逐条可核对）

1. MonkeyCode 网关要求 `X-OhmyAgent-Signature: v1=HMAC-SHA256(signing_secret, prompt)`。
   上游 `chaitin/MonkeyCode` 的 `ValidateOhMyAgentPrompt` 只把 **system prompt** 作为
   被签内容；没有 system 时返回 `invalid ohmyagent prompt: system prompt not found`。
2. bili 的 native dsh 车道替换 `globalThis.fetch`，`inboundSignedScheme(headers)` 按
   **头名形状**判定 body 签名：`authorization` 首 token 含 `hmac`，或任意以
   `-signature` / `-content-sha256` 结尾的头 ⇒ `x-ohmyagent-signature` 必然命中。
3. bili 的 `KNOWN_SIGNATURE_SCHEMES` 只有 `sdk-hmac-sha256`、`aws4-hmac-sha256`、
   `hmac-sha256`、`x-ofm-signature`；`x-ohmyagent-signature` 没有重签器。
4. bili 对未知 scheme 执行「compress or refuse」二元契约：不能重签就 **403 拒发**。
   `resign["x-ohmyagent-signature"].passthrough` 对非内置 scheme **INERT**；
   `resign[...].enabled=false` 只会恢复「改写正文」的旧路径 ⇒ 上游收到被改写的
   body 后仍会 403 `invalid ohmyagent request`。所以**没有任何 bili 配置能救**。
5. bili 上游 `ranxianglei/billion-context` 截至 2026-11-05（HEAD `0aace2f`，
   version 0.1.212）没有 `ohmyagent` / `monkeycode` 相关 issue 或 PR；本仓库 Gitee
   上游也没有对应的 MonkeyCode/bili 修复 PR。

## 修法：`monkeycodeDirectFetch`（`undici.request` 模块直连）

`src/monkeycode-http.ts` 的 `monkeycodeDirectFetch` 用 **`undici.request`**（模块导入，
不是 `globalThis.fetch`）发请求，响应体用 `Readable.toWeb(...)` 桥接成原生 `Response`。
`src/monkeycode-adapter.ts` 的 `send()` 默认使用它（`this.options.fetchImpl ?? monkeycodeDirectFetch`），
`fetchImpl` 只保留给单测注入。

- `undici.request` 是**模块导入**，bili 只替换 `globalThis.fetch`，无法替换它。
- 请求体逐字节签好后直接离开进程，签名不被改写。
- ⚠️ **不要改成 `node:https`**（2026-11-05 审计打穿三条）：它不读
  `HTTP(S)_PROXY`/宿主 dispatcher（需代理的用户整条渠道消失）、没有超时
  （`fetch` 300s vs `node:http` 0）、且 `new Response(body,{status:205})` 会在
  异步回调里抛未捕获异常**带走宿主进程**（205 是 null-body status）。
- 代价：**MonkeyCode 链路不经过 bili 的上下文压缩**。bili 本来就拒绝压缩签名请求，
  这是「能用」与「用不了」之间唯一可行的取舍，不是可配置项。
- 同一模式已由 `dsh-our-free-model` v1.4.5 的 EAC 车道采用（`src/eac.js` 的
  `laneFetch`，注释点名 billion-context）；bili 的 #2179 也把它称为 never-compressed lane。

## 验证

- `tests/unit/monkeycode-http.spec.ts`：全局 `fetch` 被替换为抛错函数时仍能发请求、
  签名头 / `content-length` / 中文 body 逐字节到达、SSE 可流式读取、非 2xx 保留、AbortSignal 可中断。
- `npx tsx .tmp/monkeycode-direct-probe.mts`：真实账号 6BFC73BB 直连
  `https://proxy.monkeycode-ai.com/v1/messages` ⇒ 200 `text/event-stream`。
- **OpenAI 兼容网关路径**：`src/openai-gateway/messages.ts` 的 `toGenerateOptions()`
  把客户端的 `role:'system'` 原样放进 `GenerateOptions.messages`，不写
  `GenerateOptions.system`。`buildMonkeycodeMessagesPayload` 现在会先从
  `messages` 里提取 system 文本再写顶层 `system`（`options.system` 优先），
  否则 `serializeMinimaxMessages` 会跳过 system 角色 ⇒ 空串签名 ⇒ 网关 403
  `invalid ohmyagent request`。对应测试：
  `tests/unit/monkeycode-messages.spec.ts` 的「system 来源」与
  `tests/unit/monkeycode-http.spec.ts` 的「OpenAI 网关把 system 放在 messages 里」。

## 额度/积分展示（2026-11-05 第二批复核）

- **分母不能跟着余额跑**：MonkeyCode 钱包只下发 `balance`（当前积分），没有初始总额。
  `buildMonkeycodeBalance` 的积分包现在带 `totalKnown: false`，面板只显示剩余值，
  不再显示 `100/100 → 98/98` 的假分母；每日额度包有 `daily_token_limit`，仍显示
  `remaining / limit` 真实进度。
- 百智云每日积分固定 `+100/天`（领取响应 `amount_credit_cents:10000`），
  `BAIZHI_DAILY_CREDIT_TOTAL = 100` 作为固定分母；充值积分上游只给当前余额，
  同样 `totalKnown: false`。
- 到期记录：MonkeyCode `GET /api/v1/users/subscription` 实测 2026-11-05 只返回
  `{plan, auto_renew, cancel_at_period_end, enable_credit_consumption}`，
  **没有 `expires_at` / `current_period_end`**；钱包交易也只有 `created_at`。
  百智钱包没有到期字段，签到响应有 `expires_at`（每日 00:00 UTC+8）但只在领取时返回。
  ⇒ 不编造时间戳，`CreditPackage.expiryNote` 只写平台确认的口径：
  - MonkeyCode 积分：`长期有效（平台未提供到期日）`
  - MonkeyCode 每日额度：`每日刷新（平台未提供具体时刻）`
  - 百智每日积分：`每日 00:00（UTC+8）过期`
  - 百智充值积分：`长期有效（平台未提供到期日）`
- **授信账户（2026-11-05 补）**：百智控制台 `billing_mode: 'postpaid'` 的账号，
  `available_credit_cents` 是「授信总额 - 预占 - 未出账 - 已出账未结清」的剩余，
  `credit_limit_cents` 才是分母。旧实现只读 available，面板只显示孤零零的
  `908`。现在 `fetchBaizhiWallet` 解析这两个字段，`buildBaizhiBalance` 生成
  「授信额度」包，账号卡主行与资源包明细显示 `908 / 1000`。
  ⚠️ 这是**授信额度**口径（`credit_limit_cents` 是上游权威分母）。普通充值账户
  上游只给当前余额、**没有初始总额** ⇒ `totalKnown:false`，面板只显示余额。
  ⚠️ **不要反推期初**（2026-11-05 审计 P0-1/P0-2）：`app-credit-usage?period=month`
  是**整月总消耗**（每日积分也含在内），而「每日桶今天花了多少」只有今天的数
  ⇒ `monthCredit - dailySpent` 会把其余 29 天的每日消耗算进充值桶，分母高估
  最多 `100×(天数-1)`，且「本月充值消耗为 0」时会退化成 `136.84 / 136.84`。
- **国际站**：`MONKEYCODE_INTL` 与国内站共用 `MonkeycodeAdapter` 与
  `monkeycodeDirectFetch`，bili 的 403 拒发修复对 `.net` 同样生效。2026-11-05
  无鉴权实测 `proxy.monkeycode-ai.net/v1/messages` GET ⇒ 405、
  `monkeycode-ai.net/api/v1/users/status|wallet|models` ⇒ 401，与 `.com` 逐项一致；
  本机没有国际站真实账号，因此**没有完成带凭据的 E2E**（不把「路径可达」冒充
  「登录可用」）。
- `loadModels()` 仍是内置快照（两家共用同一份 9 条表），不是远端目录；平台
  `/api/v1/users/models` 实测有 45 条，basic 账号对 pro/ultra 前缀会 403。

## 排查提示

- 看到 `bili refused to forward ... -signed request` / `bili_resign_unavailable`：
  不是凭据问题，不要刷新或换号；先确认该 provider 是否走了 bili 的 global fetch。
- 看到 `invalid ohmyagent request`：这是网关签名校验失败，通常是没有 system prompt
  或 signing_secret 不匹配；检查 `options.system` 和账号凭据。
- 看到「回答一直在输出上限处断掉、有时正文一个字都没有、`turn/end` 是
  `{"kind":"max-tokens"}`」：先看 `assistant/message.usage.outputTokens` 是否
  **恰好 4096**。是 ⇒ 走了 `MONKEYCODE_DEFAULT_MAX_TOKENS` 兜底，根因是
  目录没声明 `maxTokens`（见下一节），不是上游限流、不是账号问题。

## ⚠️⚠️ 2026-11-05 审计返工：`undici.request` 直连（不是 `node:http`）

上一版用 `node:https.request` 绕开 bili 的 `globalThis.fetch` 替换，审计打穿三条：

| 问题 | 后果 | 修法 |
|---|---|---|
| **代理被绕过** | `node:https` 不读宿主 `setGlobalDispatcher`、也不读 `HTTP(S)_PROXY` ⇒ 需要代理才能到网关的用户整条渠道消失 | 改用 `undici.request` + 按 `HTTPS_PROXY`/`NO_PROXY` 建 `ProxyAgent` |
| **没有超时** | `fetch` 有 undici 默认 300s，`node:http` 默认 0 ⇒ 上游吊死即永久挂起 | `headersTimeout` / `bodyTimeout` = 300s |
| **205/≥600 崩溃** | `new Response(body,{status:205})` 抛 `TypeError`（205 是 null-body status）、`≥600` 抛 `RangeError`，且在**异步回调**里 ⇒ **未捕获异常带走宿主进程** | 状态码先校验；205/204/304/HEAD 传 `null` body 并排空底层流 |

⚠️ `undici.request` 是**模块导入**，bili 只替换 `globalThis.fetch`，拦不到（核心不变量不变）。
⚠️ 响应 `content-encoding: gzip/deflate/br` 现在会解压（代理无视 `identity` 时不再读到二进制垃圾）；
⚠️ 3xx **不跟随**（与 `fetch` 不同）—— 上游若做 http→https 跳转会失败，已登记。
⚠️ `Request` 入参**显式抛错**（上一版会静默丢 body）；适配器只传 URL 字符串，不可达。

## 输出上限缺失：4096 兜底截断（2026-11-07 取证并修复）

### 症状（真实会话 `session-3b0f49c4-ef32-445f-be70-3fa7aa1650ab`）

- 第 2 轮 27 步里前 26 步 `finish: tool-calls`（单步 output 56~3201）全部正常，
  第 27 步突然 `finish: max-tokens`、`outputTokens: 4096`（**正好等于兜底值**），
  内容 `[reasoning: 14497 字符, text: 0]` —— 推理吃光预算，正文零字。
- 第 3 轮第 1 步同型复现：`outputTokens: 4096`、`[reasoning: 13579, text: 0]`。
- 两轮 `turn/end` 都是 `{"kind":"max-tokens"}`。用户观感即「一直输出上限制」。

### 请求头取证（会话内三条 `request/header`）

| 时刻 | reason | config |
|---|---|---|
| 02:48:13 第 1 轮 | `initial` | `astudio/xopdsv4flash0731in`, effort=high, **maxTokens=8192** |
| 02:49:03 第 2 轮第 1 步 | `change` | `monkeycode/monkeycode-basic/deepseek-flash`, **maxTokens=8192** |
| 02:49:34 第 2 轮第 2 步 | `change` | 同路由，**maxTokens 被删**，此后（含第 3 轮）再未出现 |

- 会话**初始上限 8192**，来自宿主播种，不是渠道声明（三条记录 `adapterDefaults`
  均为 `undefined`）。
- 第 1 轮 astudio 首发 `HTTP 404 API endpoint not found` 后切到 monkeycode；
  切换当步 maxTokens 还在，**下一步就丢了**，此后 max_tokens 恒为插件的 4096。

### 根因链

1. `src/monkeycode-product.ts:246-254` 的 **8 条** deepseek 目录条目只声明
   `contextWindow`，**没有 `maxTokens`**；`glm-5`（`:258`）两者都不声明。
   （⚠️ 2026-11-08 审计订正：原文写「`:210-218` 的 9 条」—— 那是 **base** 的
   行号，且 `glm-5` 连 `contextWindow` 都没声明，不是「只声明 contextWindow」。）
2. `src/model-catalog.ts:749-752` 只在条目有 `maxTokens` 时才设
   `resolved.defaultMaxTokens`（`:744-746` 是 `contextWindow` 的兜底分支，
   别对着找）。⇒ 本家恒 `undefined` ⇒ 宿主
   `@deepseek-ai/dsh-tmux-context/lib/index.js:1863 resolveCallWithInfo`
   的 `config.maxTokens === undefined && info.defaultMaxTokens !== undefined`
   分支永不成立，不会替它补上限。
3. 因为上限不是「适配器派生的」，请求头不带 `adapterDefaults.maxTokens = true`。
   宿主的 `@deepseek-ai/dsh-agent-loop/lib/index.js:717-722 requestProposal`
   只在 `adapterDefaults.maxTokens === true` 时删值再重算；反向也成立 ——
   **没有这个标志，值只能靠持久化，一旦被改写就永久丢失**，宿主不会重建。
4. `src/monkeycode-messages.ts:69` `MONKEYCODE_DEFAULT_MAX_TOKENS = 4096`，
   Anthropic Messages 协议 `max_tokens` 必填，于是每次请求都发
   `max_tokens: 4096`（`monkeycodeMaxTokensFor(undefined)` → 4096）。
5. `monkeycodeThinkingFor`（同文件 `:96-102`）`high → budgetTokens 8192`，
   构造 payload 时夹到 `maxTokens - 1`；本例切号后 `reasoningEffort` 随切换消失
   ⇒ 不发 `thinking` 字段 ⇒ 服务端默认开思考且预算不受控，14k 字符推理直接把
   4096 烧完，正文拿 0。

### ⚠️ 根因链第 3 环的订正（2026-11-08 审计，三域独立复现）

上面第 3 环**作为「值为什么会丢」的机制不成立**，别照它推演：

- `dsh-llm/lib/index.js:2236-2244` 的 `adapterDefaults` 在
  `proposed.maxTokens === undefined` 且 `resolvedConfig.maxTokens !== undefined`
  时才置 `maxTokens: true`。若 8192 是**显式** `agent options.maxTokens`，
  则 `proposed.maxTokens !== undefined` ⇒ `adapterDefaults` 为空对象 `{}`。
- 而 `dsh-session/lib/index.js:604-612` 的 `canonicalHeader`
  （`...adapterDefaults?.reasoningEffort === true || adapterDefaults?.maxTokens === true
  ? { adapterDefaults } : {}`）**会把空对象整个丢掉**，`dsh-api-session-controller`
  同样要求 `must omit empty adapterDefaults`。
- 于是 `requestProposal` 首行 `if (header.adapterDefaults === void 0) return header.config`
  直接返回原配置 —— **同实例内根本不会删值**。

真机制在**另一条路径**：`prepareRequest`（`dsh-agent-loop/lib/index.js:1185`）
只读 `this.options.maxTokens`，不读 `persistedConfig.maxTokens`。所以
「丢值」出现在 **`resume` / 重建 agent** 时（新实例的 `options` 里没有该值），
不是「下一步」被主动删除。

**结论：叙事错、修法对。** 8 条 deepseek 声明 `maxTokens` 之后，
`defaultMaxTokens` 非 `undefined` ⇒ 每次 `prepareCall` 都会重新补齐
⇒ resume 也能自愈。**修法在错误叙事下仍然有效**，但按第 3 环去复现会得到
相反结论（用显式 `options.maxTokens` 试，值删不掉）。

### 对照：声明了上限的渠道不会丢

同工作区会话普查（`~/.dsh/sessions/--F-project-pojie--/*`）显示，声明了
`maxTokens` 的渠道请求头一律带 `adapterDefaults={"maxTokens":true}`，且
`resume` / `change` 全程稳定：workbuddy 128000、astudio 384000、cline 131072、
gemini 64000、raccoon 100000、minimax 128000。monkeycode / baizhi / codearts /
accio / loomy 等未声明的则 `adapterDefaults=undefined`，多数整条 `maxTokens`
都没有。

### 上游核对（2026-11-07，2026-11-08 审计**订正**）

⚠️ 本节原写「`git log HEAD..ijetli/master` 的 12 个提交…」，但**本仓库没有
`ijetli` remote**（只有 `origin` = Gitee 的 `iJetLi/deepseek-harness-codearts`、
`github` = `iJetLi/dsh-providers-hub`）⇒ 那条命令当场 `fatal: Needed a single
revision`，12 个提交与「删了 `monkeycode-http.ts`」都**无法复现**。
可复现的只有：

- `git show github/master:src/monkeycode-product.ts | grep -n "maxTokens\|maxOutput"`
  **零命中**（rc=1）⇒「上游没有声明输出上限」这个结论**成立**；
- 但 `git log HEAD..github/master` 只有 **1** 个提交、diff 也只含本 PR
  ⇒ 原记的「12 个提交」在 `github/master` 上同样不成立（可能是别的 fork 的
  时点，已无从考证）。引用前先确认是哪个 remote。
- 同型先例（可照抄修法）：`611a57a fix(cline): 补 minimax-m3.1-flash 的
  maxTokens 声明 —— 请求不带 max_tokens ⇒ 退回网关默认 4096 ⇒ 长回答被静默截断`。

### 修法（2026-11-07 已实施：`maxTokens: 128_000`）

在 `MONKEYCODE_GATEWAY_MODELS` 的 8 条 deepseek 条目上补
`maxTokens: MONKEYCODE_MAX_OUTPUT_TOKENS`（= `128_000`），`glm-5` 仍按
「未知就省略」不声明；适配器 `toCatalogEntry` 透传到 `CatalogEntry.maxTokens`
⇒ `model-catalog.ts` 映射成 `defaultMaxTokens` ⇒ 宿主带
`adapterDefaults.maxTokens = true`、**每一步重新 materialize**，中途丢值自愈。

**取值依据（真机探测，2026-11-07）**：用 `.credentials.yaml` 里
`MONKEYCODE_ACCOUNT_6BFC73BB` 的凭据直连 `proxy.monkeycode-ai.com/v1/messages`
（复刻适配器的 `X-OhMyAgent-Signature: v1=HMAC-SHA256(signing_secret, system)`
与 `x-api-key`），对 `monkeycode-basic/deepseek-flash` 依次探 `max_tokens`：

| max_tokens | 结果 |
|---|---|
| 131,072 | HTTP 200，`event: message_start` 正常开流 |
| 262,144 | HTTP 200，正常开流 |
| 393,216 / 524,288 / 786,432 / 1,048,575 | 未测完（探测被中断） |

⇒ 真实上限**不小于** 131,072。最终取 **128,000**：各渠道对同代 deepseek 最
常见的声明值（workbuddy / codearts 都是 128,000），且低于已被接受的 131,072。

⚠️ **这个方法只能证明「参数被接受」**，不能证明「模型真能产出 128k 正文」——
要证明后者得跑一次长生成。本字段的用途是「默认输出预算」（DSH 用它 seed
`max_tokens`），被接受即可达成本次修复目标。

⚠️ 未采取的修法：只把兜底常量 `MONKEYCODE_DEFAULT_MAX_TOKENS` 提到 8192/128k
是治标 —— 请求头仍会丢 `maxTokens`、仍没有 `adapterDefaults` 每步重算的保护。

### 同型对照：其他渠道对 deepseek 的声明值

| 渠道 | 模型 | 声明值 |
|---|---|---|
| astudio | `xopdsv4flash0731in` / `xopdeepseekv4pro0813` | 384,000 |
| officeace | `deepseek-v4.1-flash` / `deepseek-v4-flash` | 393,216 |
| workbuddy | `deepseek-v4.1-flash` | 128,000（另一端点 131,072） |
| codearts | `deepseek-v4.1-flash` / `deepseek-v4-pro` | 128,000 |
| codearts | `deepseek-v4-flash` | 50,000 |
| raccoon | `sn-deepseek-v4-1-flash` | 65,536（远上报 100,000，网关硬校验 `1..65536`） |
| baizhi | 4 条 deepseek | **同一提交已补声明**（100,000），且 qwen 系列按上游硬限 65,536/32,768 单独声明 |

### 复现/取证方法

`session.v4.jsonl.zstd` 是逐帧 zstd（magic `28 B5 2F FD`），用
`zlib.zstdDecompressSync` 逐帧解压后按行 `JSON.parse`；关键记录
`request/header`（每次上限变化）、`assistant/message.usage.outputTokens`、
`turn/end.reason`。
