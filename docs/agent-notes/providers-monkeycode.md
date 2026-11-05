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

## 修法：`monkeycodeDirectFetch`（node:https 直连）

`src/monkeycode-http.ts` 的 `monkeycodeDirectFetch` 用 `node:http` / `node:https`
的 `request` 发请求，并用 `Readable.toWeb(response)` 桥接成原生 `Response`。
`src/monkeycode-adapter.ts` 的 `send()` 默认使用它（`this.options.fetchImpl ?? monkeycodeDirectFetch`），
`fetchImpl` 只保留给单测注入。

- `node:https` 是进程内置模块，bili 只替换 `globalThis.fetch`，无法替换它。
- 请求体逐字节签好后直接离开进程，签名不被改写。
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
  ⚠️ 这是**授信额度**口径；普通充值账户上游仍只给当前余额，没有初始总额。
  普通充值账户若同时拿到本月用量，则用「当前充值余额 + 本月充值消耗（总消耗 −
  每日已消耗）」反推本月期初并在 `expiryNote` 标注为反推值；没有用量时仍不显示
  假分母。百智每日积分先于充值积分消耗，故反推公式先扣除 `100 - temporary`。
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
