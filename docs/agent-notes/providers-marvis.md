# 腾讯 Marvis（腾讯 Marvis）provider 笔记

> 一句话主线：**同一个 base URL 下住着两套鉴权**——模型网关（`/v1/*`）只认 Ual-Access 四件套、
> **绝不能带 UAL 签名**；钱包/用户信息（`/v3/*`）必须额外带签名。登录不是「拿到回调即成功」，
> 回调只是一次性 code 的兑换入口，兑换**只能由 Node 侧带 `Ual-Access-Guid` 发起**。
>
> 全部结论来自 2026-11-08 / 2026-11-09 在真实账号（QQ·Jet，另 8 个号用于额度核对）
> 与本机 magpie 客户端（`~/.config/magpie/`）的实测，合并提交 `1d12f80`。
>
> 本文是**知识库**，`src/` 不引用它；代码里的真相以 `src/marvis*.ts` 的模块头注释为准。

## 1. 渠道身份

| 项 | 值 |
|---|---|
| provider id | `marvis` |
| 面板名 | 腾讯 Marvis（应用宝团队的桌面 AI 助手） |
| base URL | `https://yybadaccess.3g.qq.com` |
| 推理端点 | `POST /v1/chat/completions`（**OpenAI Chat Completions 协议族**） |
| 钱包端点 | `POST /v3/marvis_get_wallet`（body 字面量 `{}`） |
| 续期端点 | `POST /marvis_client_login/marvis_refresh_token` |
| 凭据 ref 前缀 | `marvis`（见 `jet-hub-store.ts` 的 `REF_PREFIX_TO_PROVIDER`） |
| settingsNamespace | `llm-marvis` |
| 积分能力 | 仅**余额**（`credits.balance`），**无签到**（上游根本没有签到接口） |
| 客户端 UA（推理） | `AsyncOpenAI/Python 2.32.0` |
| 浏览器 UA（授权页） | `… Marvis/1.60.3300.408 Chrome/152.0.7977.130 Electron/44.7.0 …` |

`src/marvis-product.ts` 的 `MARVIS` 常量是唯一一处「渠道静态描述」：
`baseUrl` / `chatPath` / `balancePath` / `refreshPath` / 四个超时（`chatHeaderTimeoutMs: 60s`、
`chunkTimeoutMs: 120s`、`catalogTimeoutMs: 15s`、`balanceTimeoutMs: 15s`）/ `defaultCredentialRef: 'MARVIS_ACCOUNT_DEFAULT'`。

## 2. 请求头矩阵（最容易踩死的一节）

| 头 | 推理腿 `/v1/chat/completions` | 业务腿 `/v3/*` |
|---|---|---|
| `Ual-Access-Openid` | ✅ | ✅ |
| `Ual-Access-Access-Token` | ✅ | ✅ |
| `Ual-Access-Login-Type` | ✅（`QC` / `WX`） | ✅ |
| `Ual-Access-Guid` | ✅ | ✅ |
| `Ual-Access-Businessid` | ❌ 不带 | ✅ `marvis_client` |
| `Ual-Access-Timestamp` | ❌ | ✅ 毫秒 |
| `Ual-Access-Nonce` | ❌ | ✅ 1000–9999 随机 |
| `Ual-Access-Signature` | ❌ **绝对不能带** | ✅ 必带 |
| `Ual-Access-MarvisExt` | ✅ 紧凑 JSON | ❌ |

- 签名公式：`md5(query + timestamp + accessKey + nonce)`，32 位小写 hex。GET 的 `query` 是
  **不含 `?`** 的查询串，POST 是 **JSON body 原文**（所以 `{}` 与 `{ }` 的签名不同）。
- ⚠️⚠️ **把签名头加到推理腿 ⇒ 上游把错误从 `403 风控拦截` 改成 `401 登录态过期/未登录`**
  （2026-11-09 请求头矩阵实测）。这个假象会让人以为是 token 坏了，去反复重登 —— 实际是
  「多带了一个头」。代码因此把两条腿拆成 `llmHeaders()` / `businessHeaders()` 两个函数，
  并有单测钉死「推理头里不含 `Ual-Access-Signature`」。
- ⚠️ **推理腿必须用 `AsyncOpenAI/Python 2.32.0`**：换浏览器 UA 或 magpie 的 UA 会被风控拦
  `4100404`（2026-11-09）。配套还要带 8 个 `X-Stainless-*`（`lang=python`、
  `package-version=2.32.0`、`os=Windows`、`arch=other:amd64`、`runtime=CPython`、
  `runtime-version=3.11.9`、`async=async:asyncio`、`raw-response=true`），
  以及 `Authorization: Bearer placeholder`（真鉴权全在 `Ual-Access-*` 里）。
- ⚠️ **`Ual-Access-MarvisExt` 必须是紧凑 JSON、不能有空格**：服务端按**原文字符串**校验
  （字段：`osVersion:'Windows-10-10.0.26200'`、`guid`、`uskey`、`nonce`、`reqScene:1`、
  `taskType:'user'`、`clientVersion`、`isIoa:false`）。`JSON.stringify` 的默认输出正好紧凑，
  但**别经过任何 pretty-print / 二次解析重排**。
- `uskey` 是 **376 字节随机数的 base64**，每次请求现签（`uskeyOf()`）。magpie 的 README 称
  同一个 uskey 用到第 3 次会 403 —— 本次**未复现**，但现签的代价可忽略，就保持现签。
- 其它推理头：`Marvis-AgentTag`（默认 `auto_discovery`）、`Marvis-Conversation-ID`、
  `Marvis-Response-ID`、`Marvis-Scene`（默认 `preload_summary`）、
  `Marvis-Protocol-Version: '1000'`、`X-Device-GUID`。

## 3. 登录

### 3.1 两条腿，产出同一种凭据

| 腿 | 入口 | 说明 |
|---|---|---|
| ① 浏览器授权 | 面板「新建账号」→ `MarvisLoginModal` 的「QQ 登录 / 微信登录」 | `loginViaBrowser('1'\|'2')`，另开**干净隔离窗口**，在 **Request 阶段截停** OAuth 回调 |
| ② magpie 导入 | 同上弹窗里的「从本机 magpie 导入」 | `readMagpieCredential()` 由**宿主自己**读 `~/.config/magpie/plugin-auth.json` |

- ⚠️ ②的路径必须**在调用时**算 `homedir()`（`magpieAuthPath() = join(homedir(), '.config','magpie','plugin-auth.json')`），
  在模块顶层算死会让单测读到**开发机真实文件**。
- ⚠️ ②的由来是 2026-11-09 的用户报障：最初的实现是在弹窗里放一个 textarea 让用户自己抄
  「凭据 JSON」—— 用户原话是「这不合理」。任何新的「让用户手抄凭据」方案都会被打回。

### 3.2 为什么必须「浏览器开页 + 截停回调 + Node 兑换」

回调地址 `MARVIS_REDIRECT_URI = https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth`
是**应用侧预注册 + 域名白名单**，我们改不了（改了就 `-109`）。因此：

1. 浏览器打开授权页（QQ / 微信 OAuth）；
2. 浏览器即将发出 `GET …/marvis_oauth?login_type=QC&code=…` 时，在 **Request 阶段截停**；
3. Node 侧用 `code` + `Ual-Access-Guid` 头去换 token。

真机 A/B（2026-11-09，故意用假 code）：

| 变体 | 结果 | 含义 |
|---|---|---|
| `?login_type=QC&code=…`（无 guid 头） | `-109 RC_PARAMS_INVALID` | 缺 guid |
| guid 放 **query** | `-109 RC_PARAMS_INVALID` | 位置错，guid 不是参数 |
| guid 放**请求头** | `-107 RC_NO_AUTH_ERR` | 参数过关，只是 code 是假的 ⇒ 正解 |

⇒ 兑换**只能由 Node 侧发起**：浏览器的顶层导航带不了自定义请求头，所以「让浏览器自己完成兑换」
这条路是死的，截停是唯一解。

⚠️⚠️ **回调 URL 不是「登录成功」的证明**，它只是**一次性 code 的兑换入口**；浏览器发出 request
的那一刻 code 就被消费了。所以**截停之后绝不能让请求继续发出去**（真放过去，第二次兑换必回
`-107 RC_NO_AUTH_ERR`，且看起来像「登录失效」）。

### 3.3 guid 必须每号独立

`newMarvisDeviceGuid() = randomBytes(16).toString('hex')`，**每次登录新造**。
token 与 guid 绑定：共用本机 guid 会让第二个号**把第一个号顶掉**（同机多号场景的核心约束）。

- 曾实现过「读注册表 `HKCU\SOFTWARE\Tencent\Marvis\Env\svid` + `md5(host|user|marvis)`」来复刻
  本机客户端身份 —— 评审 M1 判定**无落点**（Marvis 的 guid 语义不是设备指纹），2026-11-09 整段
  删除，连带删掉 16 条「只在守护不可达代码」的用例。**别再把它加回来。**

### 3.4 凭据形状（JSON）

```json
{
  "access_token": "mv_…",
  "refresh_token": "…",
  "openid": "…",
  "guid": "32 位 hex",
  "login_type": "1",
  "nickname": "Jet",
  "expires_at": "1762xxxxxxxxx"
}
```

- ⚠️ 字段名必须是 `access_token`：`src/account-pool.ts:1271` 的 `findAccountIdByCredential`
  对**非 codearts** provider 统一取这个字段作账号身份标识，改名 = 账号去重失效。
- `login_type`：`'1'` = QQ / `'2'` = 微信。`marvisLanguageOf` 映射到头的 `QC` / `WX`；
  但**续期 body 里的 `loginType` 是字面量 `"Marvis"`**，不是 `QC`/`WX`（别「统一」它）。
- `expires_at`：毫秒字符串。`credentialExpiresAtMs` 用 `> 1e12` 判毫秒、否则当秒
  （不做这个兼容，会把所有凭据判成 1970 已过期）。
- `refresh_token` **一次性轮换**：每次续期都要把新的写回，否则下一次续期必失败；
  但**允许空串**（有些号确实没下发），空串 ≠ 损坏。
- `parseMarvisCredential` 四必填字段缺一即返回 `undefined`，**不抛错**（让上层按「无账号」处理）。
- `isMarvisCredentialExpired` 在**没有** `expires_at` 时恒 `false`：读不到 ≠ 失效，
  真的失效由上游 `401` 反映。别为了「保险」把它改成 `true`（会造成每轮都重登）。
- 面板展示用 `marvisAccountLabel` → `QQ·昵称` / `微信·昵称`；
  `maskMarvisKey` 形如 `mv_1…cdef`，**形状不合法返回空串**，绝不回显原文。

## 4. 额度（钱包）

`POST /v3/marvis_get_wallet`（业务腿，必须带签名），body 字面量 `{}`，返回：

```json
{"code":0,"msg":"","data":{"openid":"…","total_tokens":"10000000","used_tokens":"0",
 "frozen_tokens":"0","avail_tokens":"10000000","total_cost":0,"status":1}}
```

- ⚠️⚠️ **所有额度字段都是字符串数字**。写成 `typeof v === 'number'` 的判据**恒假** ⇒
  静默读不到，面板显示空且日志零字。`readMarvisAmount` 走字符串 → `Number()`。
- ⚠️ **读不到时返回 `undefined`，绝不回落 `0`**：`0` 的语义是「已用光」，回落 0 会让
  面板显示「余额 0」并可能触发不该有的降级。
- ⚠️ **响应里没有任何日期字段**（8 个真实账号逐一核对过全部字段）。因此只能标
  `expiryUnknown: true`，**不要编造「明天 0 点重置」**。
- Marvis 的免费额度是**按自然日回满**（每日 1000 万计费 token，`total_tokens` 就是它），
  但「什么时候回满」上游不告诉我们 ⇒ 面板按「未知到期」处理。
- **没有签到**：面板不给 Marvis 渲染签到按钮，`credits` 能力只声明 `balance`。
  别照抄 astudio / autoclaw 的「余额 + 每日签到」四件套。

## 5. 模型目录

- **只有一条**：上行槽位 `deepseek-v4-pro-external`（展示名 `DeepSeek V4.1 Flash`）。这是**产品决策**，
  不是上游镜像：2026-11-09 在真实账号上实测 magpie 的整张槽位表（`hy3-preview-agent`、
  `claude-sonnet-4-6` …），**每个槽位都能正常推理**，但用户裁定只暴露一条。
- ⚠️⚠️ **2026-11-14 用户裁定：槽位从 `main-auto` 切到 `deepseek-v4-pro-external`。**
  两个槽位的**真实下行是同一个模型**（`deepseek-v4-1-flash-261017`，响应体 `model` 字段可证，
  探针 2/2 稳定）⇒ 目录只显示这一条，展示名保持 `DeepSeek V4.1 Flash`（对用户透明）。
- 存量配置里的 `main-auto` / `0` / 真实模型 id 由 `normalizeMarvisModelId` **归一**到新槽位
  （否则老会话会「目录未命中」静默退化成未知模型：text-only / 无上下文 / 无图片，且不报错）。
- ⚠️ `claude-*` / `gpt-5.4` 在本账号实测 **`400 4130001 无效模型id`**（未授权）—— 所以「槽位表里有」
  不等于「这个号能用」；且**槽位按账号/套餐下发**，magpie 静态表的可用集合与 2026-11-14 实测不一致
  （README 的「18 个槽位」是旧口径）。
- ⚠️ **DS V4.1 Pro 不存在**：官方注册表无条目，所有猜测槽位 / 真实名直传全部 `400 4130001`。
- ⚠️ **没有远端目录端点**：实测 10 个候选全 404 / 400（`/v1/models`、`/v1/model/list`、
  `/v3/marvis_get_models`、`/v3/marvis_get_model_list`、`/v3/marvis_models`、`/v3/model/list`、
  `/marvis_client/marvis_get_models`、`/v3/marvis_get_config`，含 2 个带 md5 签名的 POST 腿），
  magpie 自己也是静态表 ⇒ `catalog()` 只能恒返回静态兜底 `MARVIS_FALLBACK_MODELS`；保留
  `createModelCatalog` 只是为了黑名单 / 关闭供应商 / 无账号门控与其余家同源。
- `contextWindow: 1_000_000`：`0` 是「不知道」的哨兵值，这里填的是上游宣传值；**实测只验证到
  18k（36k 汉字）**，即「没测到上界」。
- `supportsImage: true`：2026-11-14 实测 `deepseek-v4-pro-external` 收
  `{type:'image_url',image_url:{url:'data:image/png;base64,…'}}` 并**答出颜色**（reasoning 里描述了图片
  本身 ⇒ 真看到图，不是 200 + 静默忽略）⇒ 任何「目录里标不支持图片」的说法不可信。
- ⚠️ **刻意不声明 `maxTokens`**（评审 M4 定案）：实测 `32_000 / 65_536 / 131_072 / 1_000_000`
  全部 `200`，上游不校验上界；缺席时走上游默认更安全。别「补全」它。
- ⚠️ **刻意不声明 `reasoning.efforts`**（用户裁定「抄 magpie」）。但 `marvis-messages.ts` 仍保留
  `reasoning_effort` 透传：将来若真的声明了档位，就必须真发出去（声明了却不发 = 选择器是 UI 装饰）。

## 6. 适配器独有的三处约定（`src/marvis-adapter.ts` 模块头）

其余关注点全部走仓库共享实现，本文件**不重写任何一条**：

| 关注点 | 落点 |
|---|---|
| 目录门控与黑名单 | `model-catalog.ts` 的 `createModelCatalog` |
| 请求体（工具包装 / `include_usage`） | `marvis-messages.ts` |
| 流帧解析（思考 / 工具增量 / usage） | `openai-compat.ts` 的 `consumeOpenAiSse` |
| 取消判定 | `aggregate-adapter.ts` 的 `isAbortLike`（**全仓唯一一份**） |
| 限流冷却终点 | `model-queue.ts` 的 `nextUtc8DayStartMs` |

本家独有的三处：

1. **目录只有一条且没有远端端点**（见上）。
2. **槽里放的是完整凭据对象**（`MarvisSlot.credential`），不是裸 Key —— 请求头需要
   `openid` / `guid` / `login_type` 三格。
3. ⚠️⚠️ **`content-type` 闸门必须放行 `text/plain`**：实测上游对 `stream:true` 回
   `text/plain; charset=utf-8`，而 body 是标准 SSE。照抄 modelscope 的
   `includes('text/event-stream')` 会把**每一次正常请求**都当成「风控页」。
   症状极具误导性：所有请求都像被风控，但 curl 直连完全正常。

`src/marvis-messages.ts` 的两处 Marvis 特有：

- **`stream_options: { include_usage: true }` 恒带**：Marvis 的 SSE 只有请求里声明它时才会在
  末帧下发 `usage`（2026-11-09 实测），而 `wrapAdapterWithTokenLedger` 没有 `usage` 就记 0
  ⇒ 账本永远空。
- **工具必须包装成 `{type:'function', function:{…}}`**：原样透传 DSH 的扁平 schema 会让上游回
  `400 'type' is a required property - 'tools.0'`，而 DSH 每轮都带工具 ⇒「一次都没请求成功」，
  且反代把它当上游不可用**静默跳过**。这是本仓 2026-10-07 modelscope 的同款事故。

## 7. 缺陷登记

| # | 缺陷 | 状态 |
|---|---|---|
| 1 | 签名头误加到推理腿 → 上游把 `403 风控` 伪装成 `401 登录失效` | 已修（两条腿拆函数 + 单测钉死） |
| 2 | 额度字段是字符串 ⇒ `typeof === 'number'` 判据静默失效 | 已修（`readMarvisAmount` 走 `Number()`） |
| 3 | 额度读不到回落 `0` ⇒ 面板误报「已用光」 | 已修（返回 `undefined`） |
| 4 | `content-type` 只放行 `text/event-stream` ⇒ 每个正常请求都被当风控页 | 已修（放行 `text/plain`） |
| 5 | 不带 `stream_options.include_usage` ⇒ 账本记 0 | 已修 |
| 6 | 让用户在弹窗里手抄凭据 JSON | 已修（改宿主读 magpie 文件 / 浏览器登录） |
| 7 | 复用本机 guid ⇒ 同机第二个号把第一个号顶掉 | 已修（每号随机 guid） |
| 8 | 把 marvis 加进 `PROVIDERS_ASKING_OPTIONS` 白名单 ⇒ 弹成「添加 ZCode 账号」 | 已修（`createAccount` 里独立早退） |
| 9 | 缺 `Ual-Access-Guid` 的兑换（`-109`） | 已修（guid 放请求头） |
| 10 | 「读 svid + md5 造设备 guid」的不可达实现 + 16 条空转用例 | 已删（评审 M1） |
| 11 | 额度接口无日期字段 ⇒ 曾按「明天 0 点」编造到期 | 已修（`expiryUnknown: true`） |
| 12 | 目录里声明 `maxTokens` / `reasoning.efforts` 的冲动 | 未采纳（评审 M4 + 产品裁定，见上） |
| 13 | 该渠道在 README「支持的渠道」表里**长期缺席**（合并提交漏更新文档） | 已修（`1a647fe` 补齐 18→29） |

## 8. 复现与验证

```bash
# 单测（不需要真号）
pnpm exec vitest run tests/unit/marvis-auth.spec.ts tests/unit/marvis-credits.spec.ts \
  tests/unit/marvis-browser-login.spec.ts tests/unit/marvis-rpc-branches.spec.ts \
  tests/unit/marvis-client-panel.spec.ts

# 真机 E2E（需要真号 + 弹真实浏览器窗口，人工确认）
pnpm test:e2e:marvis
# = cross-env MARVIS_E2E=1 MARVIS_E2E_CONFIRM=yes vitest run --config vitest.e2e.config.ts tests/e2e/marvis.e2e.spec.ts
```

接线自检（漏一处都是静默失效，见 AGENTS.md 的「八处」）：`PROVIDER_REGISTRY` 与
`provider-runtime.ts` 两张注册表、`REF_PREFIX_TO_PROVIDER`、`SELF_HEAL_REFRESHABLE_PROVIDERS`、
`aggregate-adapter.ts` 的 `WIRED_EXPIRY_PROVIDERS`、`canonical-models.ts` 的
`PRIMARY_CHANNEL` / `CANONICAL_OVERRIDES`、客户端图标（`provider-icons.js`）与
`marvis-login-modal.js` 的加载入口。守卫用例：`provider-runtime-wiring` /
`jet-hub-panel-wiring` / `jet-hub-rpc-auth-wiring` / `expiry-runtime-parity`。

## 9. 未验证 / 风险

- `uskey` 复用第 3 次 403 的说法（来自 magpie README）**未复现**，现按「每次现签」规避。
- `contextWindow` 只验证到 18k，`1_000_000` 是上游宣传值。
- `accessKey`（`fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi`）不是密钥概念，取自已安装客户端的
  `config_defaults`（Fernet 解密产物）；上游若换 key 需要重新挖。
- 上游若把「预注册回调 + 域名白名单」改成动态校验，整条截停登录链会失效 ——
  届时症状会是兑换回 `-109`（而不是 `-107`）。

## ⚠️ 内容级风控指纹改写：2026-11-15 起 `marvis` 也登记在 `TENCENT_PROVIDERS` 里

**结论**：`marvis` 的 `system` 正文现在会过 `rewriteTencentContentFingerprints`（与 `buddy` / `workbuddy` 同一份表、同一判据）。

**这不是因为它现在会拦** —— 2026-11-15 真机实测（`D:/tmp/marvis_probe2.mjs`，直连 `https://yybadaccess.3g.qq.com/v1/chat/completions`，真实凭据，13 档）：

| 档位 | system 内容 | 长度 | 结果 |
|---|---|---|---|
| A | 无 system | 0 | **200** |
| B1 | `Main branch (you will usually use this for PRs)` | 47 | **200** |
| B2 | `You are Claude Code, Anthropic's official CLI for Claude` | 56 | **200** |
| B3 | `You are an AI agent powered by DeepSeek Harness` | 47 | **200** |
| B4 | `You are an AI coding assistant, powered by DeepSeek Harness model.` | 66 | **200** |
| E5390 / E30000 / E65000 / E88828 | 项目 `AGENTS.md` 切片 | 5390 ～ 88828 | **全部 200** |

**连腾讯系实测会被拦的 5 条指纹，在 marvis 上全部 200**，体积档也没触发任何长度/体积类风控。

**登记它的理由**（`src/openai-gateway/tencent-fingerprint.ts` 的 `TENCENT_PROVIDERS` 注释里逐字写了）：
`yybadaccess.3g.qq.com` 属腾讯域，与 `buddy` / `workbuddy` 是同一套内容风控体系，服务端随时可能下发新指纹；
统一走一份表比将来被拦了再补更省事。

**代价（必须如实记）**：脱敏会改写 DSH 自己的身份句 —— 模型读到的自我描述变了。
对 `buddy` / `workbuddy` 是「不脱敏就 403」的**必要之恶**，对 `marvis` 是**纯付出**。
要回退只需把 `'marvis'` 从 `TENCENT_PROVIDERS` 那一行删掉（**那一个元素就是唯一开关**）。

**只改 `system`，不改 `assistant` 正文**：`assistant` 正文实测不拦，改它既换不来放行，
又破坏历史回读证据（`src/marvis-adapter.ts` 的 `streamVia` 里那行注释记了这条）。

**守卫**：
- 纯函数：`tests/unit/openai-gateway-tencent-fingerprint.spec.ts` 的 `isTencentContentFingerprintProvider('marvis')` + `rewriteTencentContentFingerprints(…, 'marvis')`；
- **行为级**（这条才是承重的）：`tests/unit/marvis-adapter.spec.ts` 的「system 里的腾讯系风控指纹必须被改写」—— 摘掉 `streamVia` 里那次调用 ⇒ 该用例红，而纯函数用例**仍全绿**（变异实测 `TestFiles_failed=1 Tests_failed=1`）。

### ⚠️⚠️ 补记（2026-11-15 晚，Issue IKVF8Z）：判定发生在 `messages[]` 的 system 那条，**不在**顶层 `system`

上面那节的矩阵里 B3 档（身份句）是 **200**，但那是把身份句**只放顶层 `system`** 测的 ——
而**真实 agent 推理根本不走那个位置**（正向审计实测：loop 请求的 `options.system` 恒
`undefined`，见 `@deepseek-ai/dsh-llm/lib/types/types.d.ts` 的「Loop-built requests leave it
undefined」；`dsh-agent-loop` 的 `buildRequest` 返回体里没有 `system` 键）。顶层 `system`
只用于 session-title / auto-review 这类**一次性**调用，其文本不含身份句。

**真实推理的身份句唯一载体是 `messages[]` 的 system 消息**（`serializeMessages` 见
`role:'system'` 就 `wire.push` —— 而 `skipSystem` 等参数只在少数路径上传 `true`），
而这一条此前**没有**过指纹表。

真机现象（用户报障，1 个账号、槽位 `deepseek-v4-pro-external`）：
界面上任何一次 marvis 请求都报 `HTTP 403 {"code":4100406,"msg":"非法请求"}`，
同一账号直连同一端点、同一 body 却是 200。逐格收敛后矩阵如下
（`tests/unit/marvis-adapter.spec.ts` 的三条新用例就是按这张表写的）：

| 位置 | system 内容 | 结果 |
|---|---|---|
| 顶层 `system` | `You are an AI agent powered by DeepSeek Harness.` | **200**（无害，且已被改写） |
| `messages[]` 的 system 消息 | 同上（英文原句） | **403 / 4100406** |
| `messages[]` 的 system 消息 | 清洗成 `DSH` 之后 | **200** |
| `messages[]` 的 system 消息 | `你是一个由 DeepSeek Harness 驱动的 AI 智能体。` | **403 / 4100406** |
| `messages[]` 的 system 消息 | 该中文句清洗成 `DSH` 之后 | **200** |
| 完全不带 system | — | **200** |
| `user` 正文含同一句 | — | **200**（⇒ 只有 system 这条被拦） |

⚠️ **两个 system 位置必须走同一个函数**（`rewriteMarvisSystemText`）：登记表只覆盖英文句式，
中文身份句（`你是一个由 DeepSeek Harness 驱动的 AI 智能体。`）过登记表**原样返回**，
完全靠兜底正则 `/DeepSeek\s+Harness/gi`。此前顶层那条只过登记表、没有兜底 ——
一旦哪天 loop 请求真的开始带 `options.system`，中文句就会从顶层漏出去。
（正向审计 P2-1，2026-11-15 已修。）

**修复**（`src/marvis-adapter.ts`）：`streamVia` 里对 `serializeMessages(…)` 的产物
`.map(rewriteMarvisSystemMessage)`，与 `buddy-adapter.ts` 的
`wire.push({ role:'system', content: rewrite(…) })` 同口径 ——
**两个位置都要改，只改一处等于没改**。

**兜底正则不是冗余**：登记表只有英文句式，中文句式实测同样 403 ⇒
`DeepSeek\s+Harness → DSH`（`DSH` 是实测放行的替换值）保留，用来吃表未覆盖的形态与措辞漂移。
与上面那节一致，**只改 system 消息**，`assistant` / `user` 正文一律不动（历史回读证据）。

**守卫**（`tests/unit/marvis-adapter.spec.ts`，全部行为级）：
1. `★★★ messages 里的 system 那条也必须改写` —— 摘掉 `.map(…)` 即红；只断言顶层 `system` 的原有用例**拦不住**这个缺陷；
2. `★★ 表未登记的中文句式也被兜底清掉`；
3. `★★ user 正文里的同一句不得被改`（防将来把清洗面扩大到正文）。

**仍未解（留给分类层）**：`4100406` 现在被 `classifyMarvisError` 的 `status === 403`
分支判成 `risk`，UI 与日志上只剩「HTTP 403」，看不出上游给的是「非法请求」还是「风控」；
单账号时 `risk` 分支换无可换、直接上抛给用户。本提交只修放行面，不动分类，避免把
「内容级拦截」与「账号级风控」混成同一条码。

## ⚠️⚠️ 【待验证】工具为空时下发 `tools: []` **疑似**会让模型在正文输出 DSML 标记（Gitee IKVL6C，2026-11-16）

> **⚠️ 先读这一行**：本节的**结论面**是「空数组不许下发」（这是形状口径，已经落地并有守卫）；
> **归因面**是「`[]` 会让模型臆造」—— 那一条**零实测**，且本仓 4 条同向记录全都指向
> **相反**的输入（「完全不发 tools ⇒ 臆造」，不是「发 `[]` ⇒ 臆造」）。详见下面的「证据强度」与
> 「反证面」两小节。**不要把本节标题当已验证事实引用。**

**症状**（用户真机报障，官方 `@deepseek-ai/dsh-experimental-auto-review` + 权限预设「自动审查」）：
单个会话 12 次工具调用全部失败，报

```
Error: Auto review of tool "glob" failed; its body was not executed:
Unexpected token '<', "...is not valid JSON"
```

（另有 `Unexpected token 'I'` / `Unexpected non-whitespace character after JSON at position 82`）。
`parseDecision` 对评审输出做**严格 `JSON.parse`**，而模型在**正文**里吐了
`<｜｜DSML｜｜tool_calls>` 之类的标记。

**⚠️ 归因强度（必读）**：同一 provider 里**不走自动审查**的相邻会话 0 次失败 ⇒ 只能
推出「**自动审查这条路径独有**」。但两臂同时差**两件**事 —— `options.tools` 的有无
**以及 prompt 本身**（评审提示词 vs 对话提示词）⇒ **单一差分分离不出 tools 这一项**。
所以「与凭据、网络、上游风控无关」这句成立（它们对两臂是同一个值），但
**「就是 `tools: []` 的错」是推断，不是实测**。

**根因链（四条；**证据强度必须分级读** —— 第 1/2/4 条是**代码事实**，第 3 条是**推断**）**：

1. `src/marvis-messages.ts` 的 `buildMarvisPayload` **恒带** `tools` 键（哪怕 `[]`）；
2. 自动审查那一轮**没有任何工具**（`options.tools` 为 `undefined`）⇒ `buildMarvisTools`
   返回 `[]` ⇒ wire 上是 `"tools": []`；
3. **【❌ 已被真机实发推翻，2026-11-16】** 原假设是「`[]` 声明有函数调用能力却零定义
   ⇒ 模型臆造」。—— **实测两臂都臆造、且无显著差异**（见下文「真机受控实发」节）。
   ⚠️ 与之配套的一条**假事实**也必须更正：本文件早前写「本机无 marvis 凭据
   （不能发请求）」——**那是错的**，本机 `.credentials.yaml` 里有 4 条
   `MARVIS_ACCOUNT_*`（行首带两个空格，早前探测的正则漏了缩进）。这个假事实被用来
   为「不做受控测试」开脱，属于**方法论错误**，留痕以免再犯。
   而本仓**全部 4 条**「只差 tools 一个变量」的记录结论都**正好相反** ——
   **不带 tools** 时模型才把调用写进正文（详见下节「反证面」）；
4. `src/marvis-adapter.ts` 调 `consumeOpenAiSse(...)` 时**没有** `dsmlToolMode: true`
   ⇒ `src/openai-compat.ts` 的 `DsmlContentExtractor` 不装 ⇒ 正文里的 DSML 标记
   **原样流到上层**。

**⚠️⚠️ P1-3：本仓有 4 条「只差 tools 一个变量」的记录，方向全部与本修法相反**

> **⚠️ 读法**：这 4 条**不否定**本修法 —— 它们的输入是「**完全不发 tools**」，
> 本修法处理的是「**发一个空数组**」，两者是不同输入。但它们共同说明一件事：
> **`[]` 的正向证据是 0 条**。任何「因为 codely/dsml/qoder/raccoon 都这么说，
> 所以说明 `[]` 也一样」的推理都是错的 —— 那 4 条恰好是在说「省略会臆造」。

**① `src/codely-adapter.ts:694-712`（2026-10-20，唯一一条受控 A/B）**：

```
带 tools  ⇒ 200，13 帧标准 delta.tool_calls，零 DSML 文本
不带 tools ⇒ 200，模型把调用写进正文：<|DSML|invoke name="bash"|>
结论行：DSML 文本不是协议差异，而是「没给它工具」时模型按训练习惯的自由发挥
```

外加 `src/codely-adapter.ts:572-580`：DSML 文本一旦进了会话历史，模型**在有工具时也会模仿**。

**② `src/dsml.ts:22-34`（OfficeAce，2026-10-13）** —— 同向：不发 tools ⇒ 正文臆造。
**③ `src/qoder-adapter.ts:1762-1764`** —— 同向。
**④ `src/raccoon-adapter.ts:766-767`** —— 同向。

⇒ **本修法把 marvis 从「恒带空数组（未测）」搬到了「不带这个键」—— 而后者恰恰是
这 4 条实测判定为「DSML 温床」的那一侧。** 这不是笔误，是**方向性反证**。

⇒ **本修法不是 IKVL6C 的修复。** 它只是把 `[]` 换成「省略」，而两种 wire 状态在
上游都是「零个工具」—— 20 次真机受控实发证明臆造在**两臂都发生**、无显著差异。
继续把它当成「 prophylaxis 已经够了」是错的；把它当成「已修 IKVL6C」关闭 issue
更是错的。

**那它还有价值吗**：有，但**只有形状一致性**这一项 —— 与本仓多数 provider 的
「空则省略」口径对齐。**这个价值不足以支撑「修复 IKVL6C」这句话**，
所以：题目、文档、issue 回写**一律不得**声称修好了 IKVL6C。

---

## ⚠️⚠️⚠️ 真机受控实发（2026-11-16，两臂各 10 次）：本修法**不修 IKVL6C**

> **这一节是本文件最重要的一节。** 它推翻了本文件其余各节里所有「`[]` 会让模型臆造」
> 的表述，也推翻了我自己此前「本机无凭据、无法实测」的判断。

**条件**：真实凭据（`marvis-30ce38d0`，`QQ·Jet`，enabled、未过期）、
`https://yybadaccess.3g.qq.com/v1/chat/completions`、
模型 `deepseek-v4-pro-external`（`src/marvis-product.ts` 的 `MARVIS_SLOT_ID`）、
请求形状**逐字照 auto-review 的真实构造**（`system` = 该包 `lib/index.js` 的
`REVIEW_POLICY`；`messages` = `ENVIRONMENT` + 一条 `user-instruction`（
"Allow this tool call."）+ `toolSchemaEntry('glob')` + `toolCallEntry('glob')`；
`temperature: 0`、`stream: true`、`stream_options.include_usage: true`）。
**唯一变量 = `tools` 键**：A = `"tools": []`（旧行为）；B = 省略（新行为）。交替顺序。

| 指标 | A（`tools: []`） | B（省略 `tools`） | 判读 |
|---|---|---|---|
| 样本数 | 10 | 10 | — |
| 合法决策（`{"risk":…,"decision":…}`） | **0** | **0** | **两臂都不工作** |
| 伪工具调用（`<tool-call>` / ` ```json ` 等） | 7/10 | 8/10 | p = 1.0，**无差异** |
| 全角 DSML 标记 | 0/10 | 1/10 | 新行为侧反而出现 1 次（n 小，不显著但方向相反） |
| HTTP 状态 | 全 200 | 全 200 | 上游没有报错，全是「模型自由发挥」 |

⇒ **结论（一句话）**：`tools: []` 与「省略 `tools`」在上游都是「**零个工具**」，
语义等价；臆造在**两种状态下都发生**。**门控只改变臆造物的形状，不改变是否臆造。**

**⚠️ 这条结论的边界**：单轮样本、`temperature: 0`、固定 prompt。完整会话历史可能
改变**臆造物的分布**，但**不改变**「两种 wire 状态都是零个工具」这一语义等价性。

**⇒ 真根因在哪（留给后来者）**：在**评审会话的构造**，不在 marvis 的 `tools` 键。
`reviewMessages` 把 **pending tool call 作为 fact 消息下发**，模型读到的指令是
「Allow this tool call.」⇒ 它**照着执行**（把调用写进正文），而不是产出决策 JSON。
可试的方向：给评审轮一个**专用 decision 工具**（配 `tool_choice` 强制），或把
pending call 放进 **assistant 消息**而不是 fact 消息。
⚠️ **顺带否掉一条诱人的错解**：即使补上 `dsmlToolMode: true` 也救不了 ——
`DsmlContentExtractor` 会把全角标记变成 **tool-call 块**，而 auto-review 的
`readDecision` 要求「零或多个 reasoning 块 + **恰好一个 text 块**」⇒ 仍被判「块类型不对」。
**复发预案**：若 IKVL6C 再现（同一 `Unexpected token '<'`），说明本修法不足 ——
下一步应在该通道做**非 JSON 正文 `warn` 留痕**（让用户与日志都看得见），
**不要**再改第 5 个 provider 的 tools 门控。

**具体触发点（写死，别下次再找）**：`src/marvis-adapter.ts` 里
`consumeOpenAiSse(...)` 那个调用**之后** —— 也就是拿到最终 `text` 的地方，
判「`text.trimStart()` 的首个非空白字符既不是 `{` 也不是 `[`」时打一条 `warn`，
并把**本轮是否发过 `tools`** 一起带进日志（`tools` 已发 / 未发 / 空数组）。
这样下一次复现时，「`[]` 到底会不会触发臆造」这个问题**自己就有答案了** ——
不需要再靠推断。⚠️ 只 `warn`，**不许抛**（理由见下文「为什么不选另外两条建议」）。

**全仓口径（只记结论，不记条数与行号 —— 那是必然腐坏的快照，见 `AGENTS.md`）**

> **⚠️ 本小节原来是一张「N 家严格门控 / M 家无条件带 / K 家只判 undefined」的普查表，
> 已被**整块删除**：正向审计实测 5 处硬错（漏列 5 家、1 家误分类、3 家被数两遍、
> 1 处行号偏、1 处「同一模板」不成立），且 `grep -rln consumeOpenAiSse src/*.ts`
> 命中的文件数**不等于 provider 数**（含 `sse.ts` / `dsml.ts` / `openai-compat.ts` /
> `zero-output-guard.ts` / `opencode-proxy.ts` / `opencode-bun-tls.ts` /
> `qoder-envelope.ts` / `zcode-anthropic.ts`）。**任何人下次要数，先读 `AGENTS.md`
> 那条「条数必然腐坏」，然后按下面的**判据**数，别抄快照。**

两类形态（判据，不是清单）：

1. **门控**：`tools` 键的写出被 `tools !== undefined && tools.length > 0` 包住
   ⇒ `[]` 与 `undefined` 都不发。**这是本仓主流口径，新增 provider 一律按此写。**
2. **无条件带 / 只判 `undefined`**：`tools: buildXxxTools(input.tools)`，或
   `...options.tools !== undefined ? { tools } : {}` —— 两种对 `[]` **都照样发出**，
   与修前的 marvis 同病。

⚠️ **只看 adapter 是不够的**：真正的写出点在 `*-messages.ts` 的 builder。有些家
adapter 写成了门控、而下游 builder 对 `undefined` 返 `[]` 且**键无条件写出** ⇒
行为上仍是「无条件带」。**改一个 provider 的 tools 口径，必须同时看
adapter 与 builder 两处。**

**⚠️ 关键：那三家的「恒带」理由是错的。** `src/modelscope-messages.ts:113-114` 与
`src/qiniu-messages.ts:107-108` 逐字写着：

> `tools` **恒带**（哪怕是空数组）：带工具的请求必须让上游看到 `tools`
> 字段的存在，这是 `invalid_parameter_error` 那条事故的修法的一半。

而那条事故（`modelscope-messages.ts:13-16` 原文）是：

```
upstream: modelscope  status: 400
{"error":{"code":"invalid_parameter_error",
          "message":"'type' is a required property - 'tools.0'"}}
```

讲的是 **「带工具但包装形状不对 ⇒ 400」**，与「空数组」**毫无关系**。所以
「恒带空数组」是从那条事故里**错误推论**出来的，然后被复制到了四家。

⇒ 对本家来说，这是**继承了别处的错误推论**，而不是「无理由的偏离」——
两种说法都指向同一个结论（该改成门控），但归因必须写准，否则下一个人会
拿「modelscope 这么写的」当理由再改回去。

**⚠️ 未修已登记**：`modelscope` / `opencode` / `qiniu` 三家**仍是无条件带**
（本次用户只要求为 marvis 单独开一个 PR）。它们是否有同样的臆造症状
**未经真机验证** —— 尤其 `modelscope` 的 qoder 事故记录里提到「省略 tools 会让
模型 XML 泄露」，方向看着相反，**在真机复测前不要跟着改**。

**修法**：`buildMarvisPayload` 改成非空才带

```ts
...(input.tools !== undefined && input.tools.length > 0
  ? { tools: buildMarvisTools(input.tools) }
  : {}),
```

**为什么不选另外两条建议**（报障人提过，已在 issue 里逐条回复）：

- **在正文加协议闸门（发现 DSML 就抛 `LlmError`）** —— 不采纳这个「抛」。抛错会把
  **局部失败**（评审那一步）放大成**整轮失败**，而当前症状恰好只是 review 那步挂、
  对话本身还能继续。真正的修法是上面那条，闸门只该 `warn` + 留痕让上层自己降级。
- **发现 DSML 就重试** —— 不采纳。臆造是**概率性**行为，重试很可能再臆造一次（白烧额度），
  还会把「模型不听话」掩盖成偶发故障。

**守卫**（`tests/unit/marvis-messages.spec.ts`，`★★★` 那条是本缺陷的直接回归）：

1. `★★★ tools 为空时 wire 上必须整个省略` —— `[]` / `undefined` / **显式 `tools: undefined`**
   三格都必须 `Object.hasOwn(JSON.parse(JSON.stringify(payload))) === false`。
   ⚠️ **判据必须打在 wire 上**：`Object.hasOwn(payload, 'tools')` 比 wire 更严
   （显式 `tools: undefined` 时 `hasOwn` 为 true 而 wire 上没这个键）⇒ 用 `hasOwn(payload, …)`
   会把「wire 上等价」的两条实现判成一个红一个绿（正向审计 P2-1，M7d）。
   原有用例 `it('tools 恒带（哪怕是空数组）')` **把错误行为钉成了期望**，本提交已改写；
2. `★ 有工具时必须带`（防「为了省略把有工具也省了」的过度修正）。
   ⚠️ 原来那句 `expect(payload.tools).toEqual(buildMarvisTools(tools))` 是
   `f(x) === f(x)` 的**空断言**，已删（正向审计 P2-3）；
3. `★ 稀疏数组不产生 [null, null, null]` —— `new Array(3)` 的 `length` 是 3，
   `tools.length > 0` 的门控会放行，而 `.map` **保留空洞** ⇒ `JSON.stringify` 出
   `[null, null, null]` ⇒ 上游 `'type' is a required property - 'tools.0'`
   （与 IKVL6C 修的那条 400 同形）。修法在 `buildMarvisTools` 里
   `Array.from(tools).filter((tool) => tool !== undefined && tool !== null)`。

**通用教训可推广**：凡「协议允许省略、而本家拼命带上」的字段，都要问一句
**「带上它的语义和省略它是否等价」**。

两个**正确**的类比与一个**错误**的类比（别混）：

- ✅ `system: ""` ⇒ 省略（空串会被上游当成一条空 system 消息，语义不同）；
- ✅ `max_tokens: 0` ⇒ 省略（0 会让 DSH 侧抛 `INVALID_MODEL_MAX_TOKENS`）；
- ❌ **`temperature: 0` 不能当类比** —— 它是**有意义的值**（温度 0 = 确定性），
  **必须发**；`Number.isFinite(0) === true` ⇒ 本家实现是正确的。
  ⚠️ 若有人照「省略等价」的思路把 `temperature: 0` 也门控掉，
  会**静默改变请求语义**（退回上游默认温度）。

⇒ 判据是「**空值 vs 缺省值在上游是否可区分**」，不是「字段看起来像空的就省略」。

## ⚠️⚠️⚠️ 身份句黑名单：现行替换句**也被拉黑**（Gitee IKVRNK，2026-11-16）

**报障形状**：plan mode 开关若干次后，该会话**每轮** 403
`{"code":4100406,"msg":"非法请求"}`，其他会话正常。

**触发条件（本机真机实发确证，共 39 次）**：`messages[]` 内出现
`role:'system'` 且含身份句。与体积 / 时间 / 账号无关；同一句放在**顶层
`system` 字段**一律 200。

**为什么是「本仓缺陷」而不是「上游抽风」**：我们共用登记表
（`src/openai-gateway/tencent-fingerprint.ts`）给 DSH 身份句用的
`replace` 是官方同形措辞
`You are an AI coding assistant, powered by a large language model`，
**上游后来把这一句也登记进了黑名单** ⇒ 管线把请求**改写到了一处新的禁词上**：

```
DSH 身份句 ──登记表──▶ 官方同形句 ──▶ 403 / 4100406
```

**证据强度：已实测（直接证据）**。全部为 `messages[]` 内 `role:'system'`，
模型 `deepseek-v4-pro-external`，`stream:false`：

| 输入 | 结果 |
|---|---|
| `You are an AI agent powered by DeepSeek Harness.` | 403 / 4100406 |
| `You are an AI coding assistant, powered by a large language model`（无尾句点） | 403 / 4100406 |
| `You are an AI coding assistant, powered by a large language model.`（登记表产物） | 403 / 4100406 |
| `You are an AI coding assistant.` | 403 / 4100406 |
| `You are Claude Code, Anthropic's official CLI for Claude` | 403 / 4100406 |
| `You are Claude Code, Anthropic's CLI for Claude`（登记表产物） | 403 / 4100406 |
| `You are Claude Code.` / `You are Claude Code, an interactive CLI for coding` | 403 / 4100406 |
| `You are Claude.` | 403 / 4100406 |
| `You are an AI agent for coding work.` | **200** |
| `You are an interactive CLI coding agent.` | **200** |
| `You are an AI coding agent.` / `You are an interactive coding assistant.` | 200 |
| `You are a CLI coding agent.` / `You are a coding assistant.` / `You are an AI assistant.` | 200 |
| `你是一个由 DSH 驱动的 AI 智能体。`（兜底正则产物） | **200** |
| `你是一个用于编码工作的 AI 智能体。` | 200 |

⇒ **至少两族身份句被封，且两族的替换产物都在黑名单里**。
⚠️ 报障 issue 里「上游名单目前只登记了 DSH 身份句一族」**这句是错的**
（Claude Code 那族同样 403，本格证伪）。

**中英不对称（容易误判失效面的地方）**：中文身份句过登记表**原样返回**
（表只有英文句式），全靠兜底正则 `/DeepSeek\s+Harness/gi → DSH` 救活 ⇒
`你是一个由 DSH 驱动的 AI 智能体。` **实测 200**。所以断的只有**英文腿**。

### 修法：marvis 专有替换表（`src/marvis-identity.ts`）

**不能靠改共用登记表**：那张表是 buddy / workbuddy / marvis 三家共用，而
**两站的名单不同源** —— 官方同形句在 `copilot.tencent.com` 是 2026-10-21
实发验收过的放行值，改它会**把 buddy 一起改坏**。

所以新增 marvis 专有的
`MARVIS_BLOCKED_IDENTITY_REWRITES` + `rewriteMarvisBlockedIdentities()`，
在 `rewriteMarvisSystemText`（`src/marvis-adapter.ts`）里**接在登记表之后**：

```ts
return rewriteMarvisBlockedIdentities(rewriteTencentContentFingerprints(text, provider))
  .replace(/DeepSeek\s+Harness/gi, 'DSH')
```

⚠️ **顺序不能换**：① 的产物（官方同形句）正是 ② 的**输入**；② 挪到前面恒不命中，
等于没修。

### ⚠️⚠️⚠️ 已被实测证伪的替代方案：把 system 折进顶层 `system`

上游的准入扫描**只看 `messages[]` 内的 system 块**，同一句放顶层一律 200 ——
看起来「搬家」比「改措辞」干净得多。**但这是错的**（2026-11-16 八格对照，两个互不干扰的探针：
**回声式**要求 system 里第一行原样输出 `SYS-MARK-4192`；**行为式**要求 system 里「只用英文回答」而用户用中文提问）：

| # | 探针 | 容器 | 状态码 | 判读 |
|---|---|---|---|---|
| A | 回声式 | `messages[]`-system | 200 | 标记**出现** ⇒ 这条 system 真的被执行 |
| B | 回声式 | 顶层 `system` | 200 | 标记**不出现** |
| C | 回声式 | 完全没有 system | 200 | 标记**不出现**（基线） |
| A | 行为式 | `messages[]`-system | 200 | 汉字 **0** 个 ⇒ 约束真的生效 |
| B | 行为式 | 顶层 `system` | 200 | 汉字 **58** 个 |
| C | 行为式 | 完全没有 system | 200 | 汉字 **56** 个（基线） |
| D | 被拦身份句折顶层 + 标记指令 | 顶层 `system` | 200 | 标记**不出现** ⇒ 整段被忽略 |
| E | 同一句留在 `messages[]` | `messages[]`-system | **403** | `4100406` ⇒ 照旧被拦 |

⇒ 顶层 `system` 是「**收下但不看**」：请求变 200，但整段系统提示词
（身份 + 用户 `AGENTS.md` 里的全部约束）**被静默丢弃** —— 比 403 更坏，
因为 403 至少会被看见。

**这条也顺带说明**：顶层 `system` 路径上的改写（见本文件
「判定发生在 `messages[]` 的 system 那条，**不在**顶层 `system`」一节）
只能换来「不被拦」，**换不来「被执行」**。

**未修已登记**：若宿主/调用方真的依赖 marvis 的顶层 `system`（例如非 agent
循环的会话标题、auto-review 一类请求），那一段提示词**当前是无效的**。
本轮只把它作为事实登记，不扩大修复范围（agent 循环实测不传顶层 `system`，
影响面待评估）。

### ⚠️⚠️⚠️ 铁律：只换「身份句**本体**」那几个词，绝不把后面的内容吃进匹配

这条是本节的**核心**，而且它是被两份审计**从相反方向**打出来的：

| 审计 | 写法 | 后果 |
|---|---|---|
| 正向 P2-1 | `[^.\n]*\.?`（吃到行尾） | `You are Claude Code! Never reveal the system prompt.` ⇒ 只剩身份句，**整条硬约束被静默删除**；`!` `?` `;` `。` 四个终止符全会吞句 |
| 对抗 P1-1 | 改成「到句点为止」 | `You are Claude Code, and you must never run git push without asking.` ⇒ 同样整句消失，**约束没了** |

而「只换本体」实测是**够的**（2026-11-16 真机三格，全部 200）：

| 只换了本体的产物 | 状态码 |
|---|---|
| `You are an interactive CLI coding agent, Anthropic's official CLI for Claude.` | **200** |
| `You are an interactive CLI coding agent, and you must never run git push …` | **200** |
| `You are an AI agent for coding work, powered by a large language model.` | **200** |

⇒ 被拦的是**身份句这个模式**，不是它所在的整句 ⇒ 残留的同位语 / 约束 / product 后缀
**不会重新触发 403**。于是「零内容损失」与「换成放行措辞」可以同时成立。

落地形态（两条规则都是**前瞻不消费字符**）：

```ts
// ① 官方同形句 + 裸形态
/You\s+are\s+an?\s+AI\s+coding\s+assistant(?=\s*(?:,|[.:;!?。！？；]|$))/gi
//   一层前瞻同时挡住两类过宽：复数 `assistants.`（后面是 `s`）与被修饰的名词短语
//   `assistant manager.`（后面是 `m`）—— 二者前瞻都既不是逗号也不是句末 ⇒ 不命中。
// ② Claude Code + 登记表产物
/You\s+are\s+Claude\s+Code(?!['’]s)/gi
//   `(?!['’]s)` 挡所有格（`You are Claude Code's successor.` 是正常名词短语）；
//   同时保留 `, Anthropic's official CLI for Claude` 同位语 ⇒
//   「保护所有格」与「保留同位语」不再自相矛盾（对抗审计 P2-①）。
//   ⚠️ 这条**没有**前瞻可用（`Claude Code` 后面本来就可以接任意内容且不吞），
//      所以这里的 `(?!['’]s)` 是**承重**的（变异实测会红）。
```

⚠️ **一条关于「零行为装饰」的自我更正**：规则 ① 我最初额外写了一个 `(?!s)` 专门挡复数，
**变异实测全绿** —— 前瞻已经把 `s` 排除，那个守卫一点行为都没有。**已删**。
这正是 PR #186 审计批评过的「装饰性条件」形态（让人误以为两层判据都在承重）；
留着它就等于把同一个错误再犯一次。

替换值**刻意不带尾句点**（`You are an AI agent for coding work` /
`You are an interactive CLI coding agent`）—— 句点由原文提供，否则
`…coding work., powered by …` / `…coding work.?` / `…coding work.'s` 会语法断裂
（对抗审计 P2-②）。

### 守卫（`tests/unit/marvis-identity.spec.ts`，18 条）

1. `★★★` 官方同形句 ⇒ 换成 `You are an AI agent for coding work, powered by a large language model.`
   ——**断言必须写成保留后缀的形态**，那正是「零内容损失」的判据；裸形态走同一条规则；
2. `★★★` Claude Code 官方句 / 登记表产物 ⇒ `You are an interactive CLI coding agent, …`（同位语保留）；
   裸句 ⇒ 干净的替换值；
3. `★★★` **八种句末终止符**（`. ! ? ; 。 ！ ？ ；` + 换行）都**不得吞掉后面的约束**
   —— 这是上面那张表钉下来的判据，两份审计都靠它；
4. `★★` 大小写不敏感、幂等（连跑两次逐字节相同）、**未命中时逐字节原样且不改入参**
   （⚠️ 不要再写「返回同一引用」：字符串是原语、没有引用语义，那条断言是**恒真**的）；
5. `★★` **不许过宽**：`assistant manager.` / `assistants.` / `Claude Code's successor.`
   / 句中出现的形态**一律原样**；
6. `★★★` **反向判据**：表里任何一条规则的产物都**不得再含** `AI coding assistant`
   或 `Claude Code` —— 这一条不依赖上游（我们自己至少不该主动写禁词）；
7. `★★★` **接线级**（`wireOf()` 真跑 `stream()` 取请求体）：`messages[]`-system、
   顶层 `system`、**两处同时存在**、**端到端三级链**（DSH 身份句 ⇒ wire 上必须是
   **最终**放行措辞，不是中间产物）、以及**`assistant` 正文必须不动**（见下）。
8. `★★` `g` 标志：同一句出现两次时**两处都要换**（去掉 `g` 时第二处仍是禁词 ⇒ 403，
   这是对抗审计的 M08 真缺口）。

### ⚠️ 已知限制（如实登记，不是「待办」）

1. **`assistant` 位置维持「不改」，但理由不是「实测不拦」** ——
   `openai-gateway/tencent-fingerprint.ts` 的实测表逐字记着
   **★ assistant 正文同样被拦（2026-10-12 补测）**，那是 `copilot.tencent.com`；
   而 marvis 站（`yybadaccess.3g.qq.com`）我只在 **system** 与 **user** 位置实测过
   （user 位置 ⇒ 200），**assistant 位置从未实测**。
   ⇒ 两站**证据冲突 + marvis 缺格**，取改动面最小的保守解，并用用例钉住该决定
   （对抗审计 M18「放宽到 assistant」当时**全绿**，所以它必须被显式拦下）。
2. **词内/词间零宽字符 fail-open（不可达）**。2026-11-16 十格实发：

   | 形态 | 上游 | 我们 |
   |---|---|---|
   | `You\u200bare an AI coding assistant` | 200（上游也不拦） | —— 不是缺口 |
   | `You are an AI coding ass\u200bistant` | **403** | **漏**（正则不匹配） |
   | `You are Claude\u200b Code`（零宽 + 空格） | **403** | **漏** |
   | `You\u00ad` 软连字符 / ZWNJ | 200 | —— 不是缺口 |
   | `You\u00a0are`（NBSP） | 403 | ✅ JS 的 `\s` 含 `\u00a0`，能改 |
   | 尾全角句点 `。` | 403 | ✅ 已能改 |

   ⇒ 真 fail-open 只有两格：`assist\u200bant`（词内零宽）与 `Claude\u200b Code`（词间零宽）。
   但**本仓产出路径不产生零宽字符**（身份句来自宿主常量与官方 product.json）
   ⇒ 结构可达、零实测、**当前不可达**，故不加复杂正则（加了会显著降低可读性、
   且每加一个字面字符就多一个可腐坏点）。上游若真的开始收零宽变体，这里再动。
3. **`rule2` 的替换值 `You are an interactive CLI coding agent` 证据来源是本仓探针，
   not the report** —— 报障 issue 只放行过 `You are an AI agent for coding work.` 与
   中文 `你是一个用于编码工作的 AI 智能体。`；Claude Code 族的放行值是 2026-11-16
   我自己十格探针测出来的（见上表）。

⚠️ 为什么第 5 组不可省：`tests/unit/marvis-adapter.spec.ts` 里「messages[] 的 system 被改写」那条
原来断言的正是
**登记表产物**（`You are an AI coding assistant, powered by a large language model.`）
—— 那条用例**把被拦文本钉成了期望**，是本次回归能活下来的直接原因。

### 跑步机（如实登记）

这是**第三代**：原句 → 官方同形句 → 本表的值。每换一次措辞都可能被上游再登记。
本表的价值不是一劳永逸，而是：① 把「哪几句被拦」收敛到一个文件；
② 换措辞不必动 buddy 侧共用表；③ 替换值是**实测 200** 而非猜的。

⚠️ **不要**把本表的替换值再写进 `CONTENT_FINGERPRINTS` 的 `find`：
那会变成「找我们自己的产物再改一遍」的自指规则，零行为。
