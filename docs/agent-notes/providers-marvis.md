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
