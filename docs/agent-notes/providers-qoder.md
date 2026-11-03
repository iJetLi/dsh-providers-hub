<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠️ 安装（git 插件）的 allowBuilds 键在 pnpm 10 / 11 语义**互不兼容**（Issue IKJCOC）

**用户报障**（2026-09-30，Gitee issue IKJCOC）：「DSH Desktop 内置 pnpm 下
`dsh plugin add` 安装失败：allowBuilds 的 git URL 键触发
`ERR_PNPM_INVALID_VERSION_UNION`」。报错里 `Found:` 的那个键，正是当时 README
「方式一」与本仓库 `pnpm-workspace.yaml` 里那行
`dsh-codearts-auth@git+https://gitee.com/iJetLi/deepseek-harness-codearts.git`。

**实测结论：这不是"换个键写法"就能了事，而是两代 pnpm 的键语义互不兼容** ——
同一个键在一代上"非法"、在另一代上"合法但永不匹配"。本机实测（Windows 11，
2026-09-30；依赖侧统一用**本地 git 仓库**里的同名包，带 `prepare` 脚本，
⚠️ **每个变体都换一个新 commit**，因为 pnpm 的 side-effect cache 命中时会跳过
allowBuilds 判定，不换 commit 会得到假的"成功"）：

| `allowBuilds` 键 | pnpm 10.28.0 | pnpm 11.7.0 |
|---|---|---|
| `dsh-codearts-auth@git+<url>`（旧 README / 旧仓库写法） | ❌ `ERR_PNPM_INVALID_VERSION_UNION` | ❌ `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`（缺 `#commit`，永不匹配） |
| `dsh-codearts-auth@git+<url>#<当前commit>`（**pnpm 自己打印的键**） | ❌ `ERR_PNPM_INVALID_VERSION_UNION` | ✅ 放行成功 |
| `dsh-codearts-auth@git+<url>#<旧commit>` | — | ❌ `NOT_ALLOWED`（换 commit 即失效） |
| `dsh-codearts-auth`（纯包名；**issue 建议的"已验证修复"**） | ✅ 放行成功 | ❌ `NOT_ALLOWED` |
| `dsh-codearts-auth@0.1.0`（精确版本） | — | ❌ `NOT_ALLOWED` |
| `dangerouslyAllowAllBuilds: true`（顶层） | ✅ | ✅ |
| `add --allow-build=dsh-codearts-auth`（CLI） | — | ❌（它只写入纯包名键，本次仍不放行） |

- pnpm 11.7.0 取自本机安装的 DSH Desktop：
  `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\pnpm`
  （`DeepSeek Harness.exe` 的 FileVersion `0.2.0-rc.2`）；pnpm 10.28.0 用
  `npx pnpm@10.28.0`（issue 报告的内置版本是「10.28.0 定制构建」，与本机这版**不同**，
  故两代都必须覆盖）。
- ⚠️ **issue 建议的纯包名键不能直接采纳**：它只在 pnpm 10 上有效。pnpm 11 的
  `createAllowBuildFunction` 里
  `trustPackageIdentity = name && version && !nonSemverVersion` —— git 包的
  `nonSemverVersion` 非空 ⇒ 直接 `return undefined`，**纯包名/精确版本键一律不参与匹配**，
  只有 `allowedDepPathBuilds` 里的 `name@git+...#sha` 能命中。
- ⚠️ **pnpm 10 的坑更深：它连自己打印的键都拒绝**。11.7.0 有 `isDepPathAllowBuildKey()`
  把含 `:` / `/` / `#` 的键当 depPath 键，从而**绕开**版本并集解析；10.28.0 没有这层保护，
  所有键都走 `parseVersionPolicyRule()` → `semver.valid('git+https://…')` 为 `null` →
  抛 `INVALID_VERSION_UNION`。⇒ pnpm 10 上「复制 pnpm 打印的键」这条官方提示**走不通**，
  只能写纯包名键或 `dangerouslyAllowAllBuilds: true`。
- ⚠️ **失败表现的版本差异**（排查时先看这个）：本机 desktop（11.7.0）**不复现**
  `ERR_PNPM_INVALID_VERSION_UNION`，而是报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；
  两者根因同为"那个键不可用"。**不要**因为报错文案与 issue 不一致就判定"desktop 下没问题"。
- ⚠️ **pnpm 只对 git 托管包打印提示、不写占位符**（实测 `pnpm-workspace.yaml` 未被改动），
  所以 DSH 的「允许这些脚本并重试」按钮覆盖不到 git 插件安装 ——
  `readPendingBuilds`（`packages/boot/plugin-manager/src/build-approval.ts`）只认值为
  `set this to true or false` 的条目。用户只能手写键。这属 DSH 侧可改进项，不在本仓库范围。

**端到端复现与修复验证**（本机、离线、不动工作区；`git clone` 到临时目录后按场景改写
并 **commit** —— ⚠️ pnpm 取的是**提交内容**，只在工作区覆盖文件是无效的，第一次就这么白跑了一遍）：

| 场景 | 结果 |
|---|---|
| 修复前（仓库保留那行 git 键）+ pnpm 10.28.0，profile 已按 issue 写纯包名键 | ❌ 插件自己的 `pnpm install` 阶段：`ERR_PNPM_INVALID_VERSION_UNION … Found: "dsh-codearts-auth@git+https://…"` → `ERR_PNPM_PREPARE_PACKAGE … Exit status 1`（issue 描述的第二个失败点，原样复现） |
| 修复后（删掉那行键）+ pnpm 10.28.0 + profile 纯包名键 | ✅ install + `prepare`（tsc / copy-assets / client 打包）跑通，`lib/index.js` 产出 |
| 修复后 + DSH Desktop 内置 pnpm 11.7.0 + profile 精确键（`…#<commit>`） | ✅ 85 个依赖装好、`esbuild` postinstall 执行、`prepare` 全跑通（`lib/qoder-auth-wasm.wasm`、`lib/client/jet-hub.js` 均产出） |

⇒ **两条不要改回去的红线**：

1. **本仓库 `pnpm-workspace.yaml` 里不得出现 `包名@git+URL` 键**。本包不依赖
   `dsh-codearts-auth`，该键永远匹配不上；而在 pnpm 10.x 下它会**毒化整个 clone**：
   从 git 安装时 pnpm 要在 clone 里跑 `pnpm install`，读到这行即抛
   `ERR_PNPM_INVALID_VERSION_UNION`，`prepare`（`pnpm build:all`）根本起不来。
   （`esbuild: true` 必须保留 —— registry 包的版本是 semver，纯名键在两代都生效。）
2. **README「方式一」的放行键必须按 pnpm 大版本分别给出**，不能把某一代的写法写成通用解。
   唯一跨版本可用的是 `dangerouslyAllowAllBuilds: true`（代价：放行该 profile 里所有依赖的
   构建脚本）。改完请照上表重跑一遍验证 —— 尤其**要换新 commit**，否则缓存会骗你。

## ⚠️ 额度类业务码**不是一个值，是一条链** —— 只认 `110` 会让换号静默失效（Issue IKKJFH）

**用户报障**（2026-10-10，Gitee issue IKKJFH，provider `qoder` 国内版）：

```
本轮运行失败  qoder: {"pricingUrl":"https://qoder.com.cn/pricing?client=qoder"} (112/model_error)
模型请求重试已取消 (2/5)
```

观感是**「轮换没生效」**：白退避、重试计数走到 2/5，期间**既没换号也没换 provider**。

**根因**：`src/model-queue.ts` 的额度判据原先**只认单码值 `110`**，
`isBillingBusinessCode('112')` 为 false，文案兜底 `looksLikeBillingError` 也不含
`pricingUrl` ⇒ 三个判据全 false ⇒ 落 `SERVER` ⇒

1. `SERVER` **在** harness 的 `DEFAULT_RETRYABLE_CODES` 里 ⇒ **白退避 5 次**；
2. `qoder-adapter.isQuotaExceededError(SERVER) = false` ⇒ `switchAccountOnQuota`
   **永不被调用** ⇒ **既不换号、也不换 provider**。

⚠️ 这与 2026-09-27 那次 `110` 缺陷**完全同型，只是换了码值**。

### 两条判据腿**必须同时在**，缺一条下次换码值就复发

- **码值腿**：`BILLING_BUSINESS_CODES = ['110', '112']`
  （`BILLING_BUSINESS_CODE` 保留为单值再导出，仅为对外 API 兼容，**判据别用它**）；
- **文案腿**：`looksLikeBillingError` 增认结构字段 `"pricingUrl"\s*:`。

⚠️ **`pricingUrl` 是窄词**：它是该错误报文的**结构字段名**，不是自然语言。
判据是**认结构字段，不认主题词** —— 实测 `balance` / `quota` / 正常讨论 pricing 的正文
都不含这个键名，故不会误伤（单测有反向断言锁住）。

### ⚠️ 证据强度（如实标注，别当成客户端产物实证）

`110` 当年的取证是**读客户端 obf 产物原文**（`billing_error → permission`）。
`112` **没有**那份证据：本机未装 Qoder 客户端 ⇒ 无产物可读；上游全历史搜
`pricingUrl` **零命中**。现有依据是**报文语义**（定价页链接 = 付费才能用）＋
**兄弟码同类**。若哪天能拿到客户端产物，欢迎修正 `112` 的语义。

### 反向验证（四条各自独立，别当同义反复删掉）

| 变异 | 变红用例 |
|---|---|
| 集合改回 `['110']` | 纯函数「110 与 112 都算额度」 |
| 正则撤掉 `"pricingUrl"` | 「pricingUrl 报文算额度」＋「无业务码只有 pricingUrl 文案」 |
| **源码整体回退到修复前** | **6 条**（含行为用例「112 同样触发换号」） |

⚠️ 「归 `QUOTA_EXCEEDED`」与「真的切了号」是**两件事** ——
`switchAccountOnQuota` 在无池/无候选时会返回 `undefined` 而码仍然正确。
故 `112` 必须有一条**走完整行为链**的用例（标记 → 取号传 tried → 换号重发 → 拿到内容），
只断言错误码会漏掉 issue 现象的另一半。

### 顺带记录：`qoder-adapter.ts` 的 `isBillingBusinessCode(response.status)` **恒 false**

HTTP 分支那条判据（`src/qoder-adapter.ts:809` 附近）把 **HTTP 状态码**传给了判**业务码**的
函数 —— 两者是不同命名空间（业务码是 `110`/`112`，状态码是 `2xx/4xx/5xx`），
实测 `200/400/401/403/429/500/502` 逐个喂进去**全部 false**（`110`→true）。
该分支实际只靠右边的 `looksLikeBillingError(errorText)` 兜住。
**本次未改**（不在 IKKJFH 范围内）：注释里写明是「为服务端将来改用 HTTP 状态码下发而预留」，
是否要补「从 body 里解析业务码」那条腿属独立决策，交维护者判断。

## ⚠️ 渠道原生搜索（2026-10-14 接入）

Qoder 客户端**自带** WebSearch 能力，与聊天同源同账号。本插件把它接到官方
`web_search` 工具上（`QoderAdapter.searchOnce`，见
`src/native-search-contract.ts` 的契约说明）。

### 端点与请求形状（全部来自官方客户端源码 + 真机实测）

| 项 | 值 |
|---|---|
| host | 本产品的 `encryptedInferBase`（CN = `gateway.qoder.com.cn`；国际实测 `center.qoder.sh` / `api2.qoder.sh` / `gateway.qoder.com.cn` **都能通**） |
| path | `/api/v1/webSearch/oneSearch` |
| method | `POST` |
| 鉴权 | **WASM 签名**（`prepareRequest(host, path, 'POST', 'auth', body)`，本插件已实现于 `src/qoder-wasm.ts`） |
| 请求头 | `Authorization: Bearer COSY.<载荷>.<签名>` + 18 个 `Cosy-*` 头（全由 WASM 生成）+ `X-Session-ID` |

**明文 payload**（信封内层）：
```json
{ "query": "…", "timeRange": "NoLimit",
  "contents": { "mainText": false, "markdownText": false, "summary": false } }
```

**明文 body**（信封外层）：
```json
{ "payload": "<上面那个 JSON 的字符串>", "encodeVersion": "1" }
```

**响应**：`{ requestId, pageItems: [{title, link, snippet, publishedTime, hostname, hostLogo}], searchInformation: {searchTime} }`

### 源码依据（`qoder-worker-runtime.obf.mjs`，asar.unpacked 里）

```js
p0d = "/algo/api/v1/webSearch/oneSearch"
$bt = class { async search(A) {
  let e = { query: A.query, …, timeRange: "NoLimit",
            contents: { mainText: false, markdownText: false, summary: false } }
  return (await this.sender.send(mi.builder().operation("webSearch.search")
    .endpoint("webSearch").post(p0d).withSignature("auth")
    .json({ payload: JSON.stringify(e), encodeVersion: "1" }).build())).json(m0d)
}}
// path 另有 `/api/v1/webSearch/unifiedSearch`（通义灵码环境走它）
function APl() { return ePl() ? "/api/v1/webSearch/unifiedSearch" : "/api/v1/webSearch/oneSearch" }
// endpoint host：webSearch 与 center **同一个 host**
poe = { prod: { center: `https://${Mme}`, webSearch: `https://${Mme}`, … } }
```

### ⚠️ 四个不能改错的点

1. **`hostname` / `hostLogo` 必须丢弃**：官方 output schema 是
   `additionalProperties: false`，多传字段会让 `createSuccessResult` 抛
   `ToolOutputError`，**整条调用失败**（不是少一条结果）。
   ⚠️⚠️ **但 `publishedTime` 属于另一格**（2026-10-14 PR95 审计修正）：官方
   `dsh-tool-web` 的 output schema 与 seam 的 `WebSearchSource` **都**声明了
   可选的 `publishedAt?: string`（「provider 给的发布时间戳」）—— 原注释把三个
   字段一锅端说成「schema 不允许」，对 `publishedTime` **不成立**。
   **当前刻意仍丢弃**：接它要先真机确认 Qoder 下发的是 ISO-8601 字符串，
   接错的代价是整条调用失败，收益（多一列时间）不抵风险。**待办**。
2. **url 字段叫 `link`**（腾讯叫 `url`）—— 投影时必须改名。
3. **WASM 实例必须 `dispose`**：`QoderContext` 是 wasm 堆上的 Rust 对象，
   `gluePromise` 是进程级单例，不释放会让堆只增不减 → 长上下文会话最终以裸
   `RuntimeError: unreachable` 暴毙（真实事故史见 `qoder-wasm.ts` 文件头）。
4. **两处 path 别混**：`oneSearch` 是默认；`unifiedSearch` 只在通义灵码环境下用。

### 与腾讯（buddy 系）的差异对照

| | 腾讯 | Qoder |
|---|---|---|
| 端点 | `/agenttool/v1/search` | `/api/v1/webSearch/oneSearch` |
| 参数 | `{query, type:'text2text', max_results}` | `{query, timeRange, contents}` |
| 鉴权 | `Bearer <access_token>` | **COSY 签名（WASM）** |
| 信封 | 明文 JSON | `{payload, encodeVersion}` + 加密 body |
| 结果字段 | `results[].{title,url,snippet}` | `pageItems[].{title,link,snippet,…}` |
| 上限 | 8（上游实测封顶） | 实测返回 10 条（本插件仍按官方 `MAX_RESULTS=8` 截断） |

### 实测记录（2026-10-14）

- CN 免费账号（`qfmodel` 所在的号）：`POST https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1` → **HTTP 200**，
  返回 10 条 `pageItems`。
- **与客户端真实调用逐条对比**（客户端侧证据取自本机
  `~/.qoder-cn/projects/…/d6bb315c-….jsonl` 的真实会话记录）：
  **URL 10/10 一致、标题 10/10 一致、顺序完全一致**。
- `searchInformation: { searchTime: 371 }` 是搜索耗时，客户端**未使用**该字段。

### ⚠️ 未验证

- 官方还有第二个后端：`tools.webSearch.provider = bailian`（阿里百炼 MCP，
  `https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp`，需 Bailian API Key）。
  本插件**未接入**它 —— 默认走 `qoder` 后端（用户机器上也是默认）。
- 国际版（`qoder` 非 CN）的搜索 host 官方源码写的是 `center.qoder.sh`，
  实测三个 host 都能通；本插件用 `product.encryptedInferBase`（`api2.qoder.sh`）。

## ⚠️⚠️ 远端模型目录：静态兜底表**必然腐坏**，已改走 `/api/v2/model/list?Encode=1`（2026-10-20）

### 用户报障与根因

「Qoder（含中国版）里 DeepSeek-Flash 上游已经 **0×（免费）** 了，插件列表还显示 **0.1**」。

根因是**结构性的**：本家此前**恒用编译期兜底表**（`QoderProduct.fallbackModels`，
国际版快照 2026-09-21 / 中国版 2026-09-27），一次远端请求都不发
（`catalogEntries()` 直接 `product.fallbackModels.map(...)`，`loadCatalog` 与
`syncCatalog` 是同一份）。上游改价/改免费额度/上下架模型都不会通知任何人。

**真机对账（2026-10-20，两站各自最新的 `catalog-v6`）**：

| 现象 | 兜底表 | 上游实际 |
|---|---|---|
| `dfmodel`（DeepSeek-Flash） | `price_factor = 0.1` | **`0` + `is_free` + 原价 0.1**（IDE 显示 `0.1×`划掉`0×`） |
| `mmodel` | 国际 `MiniMax-M3`/0.2、CN `MiniMax-M2.7`/0.2 | **`MiniMax-M3.1-Flash` / 0.1**（CN 的 `is_vl` 还是 false→true） |
| `fast` | 无此条 | 有（`price_factor 0.8`，见下面的版本闸门） |
| `qmodel_38max` / `qmodel_latest` / `qmodel` | 存的是**采集时刻的折后价** | 现在下发**窗口外原价**，且 `qmodel_latest` 的 `promotion` **整块被删**（我们会显示一个不存在的折扣） |
| 国际 `ultimate` / `efficient` | 无 promotion / 窗口 1M | 新增 promotion(0.2/2) / 最大档 **200K** |

### 协议（取自 IDE 产物 + 真机实测）

客户端 `qoder-worker-runtime` 的 `listModelsFromRemote`：

```js
let s = "/api/v2/model/list?Encode=1"           // 可再拼 &outerProviders=…
let A = JqA(g, s, this.authManager)             // ← WASM 签名（prepareRequest）
await this.fetchWithTrace({ operation:"listModels", endpointType:"infer",
  method:"GET", path:s, url:A.url, init:{ method:"GET", headers:A.headers } })
let E = rb(await B.text())                      // ← rb = decrypt_server_response（失败即明文）
let u = JSON.parse(E)                           // { 场景: [模型…] }
```

四条**实测边界**（`src/qoder-catalog.ts` 的模块头有完整版）：

1. **host = `encryptedInferBase`**，WASM 自己补 `/algo` 前缀
   ⇒ 实发 `…/algo/api/v2/model/list?Encode=1`（手写 `/algo` 会 404）。
2. **只发 GET、无 body**，鉴权是 WASM 生成的 `Bearer COSY.<载荷>.<签名>`（18 个头）。
3. **`Encode=1` 不保证响应加密** —— 两站实测都回**明文 JSON**
   （`decrypt_server_response` 失败即明文，与官方 `rb()` 逐字同形）。
4. **响应是 `{场景: [模型]}`**：`chat / developer / assistant / inline / quest /
   qwork / experts / qwake / app / byok_teams / byok_enterprise`；本插件取 `chat`。

### ⚠️⚠️ 版本闸门：`fast` 拿不到是**设计如此**，不是缺陷

条目可带 `minimal_version: {app, cli, qoder_wake, vsc}`，服务端按**请求方自称的
客户端类型**选命名空间比较。同一账号、只改身份与版本的实测：

| 身份 + 声明版本 | `chat` 条数 | `fast` |
|---|---|---|
| `client_type=5`（cli，本插件）+ `1.1.49`（= `COSY_VERSION`） | 14 | ✗ |
| `client_type=5` + `1.1.69` | 14 | ✗ |
| `client_type=5` + `1.1.70` | 15 | ✓ |
| `client_type=10`（app，IDE 用它）+ `0.4.8` | 14 | ✗ |
| `client_type=10` + `1.1.66` | 15 | ✓ |
| `client_type=10` + `1.1.69`（= IDE 的 SDK 版本常量 `NH`） | 15 | ✓ |

⇒ 闸门是 `{app: 1.1.66, cli: 1.1.70}`，IDE 是 **app 身份 + 1.1.69** 才刚好过。
本插件用 **cli 身份 + 1.1.49** ⇒ 需要 1.1.70 才够，故**天然拿不到 `fast`**
（用户 2026-10-20 明确「不需要这种 IDE 融合档位」）⇒ **刻意不动 `COSY_VERSION`**：
它同时被**推理**签名使用，为一个融合档位抬高声明版本属未经实测的改动。
**其余 14 个模型不受影响**（1.1.49 下 `dfmodel` 的 `price_factor/is_free/
original_price_factor` 与 `mmodel` 的改名都已是最新值）。

### ⚠️⚠️ `is_reasoning=false` 不是「不支持思考」—— 两条信号相互独立（2026-10-20 用户追问）

用户追问：「实测 CN 的 DeepSeek-Flash 支持思考、也有档位，为什么列表里
`is_reasoning=false`？」

**因为上游这两个信号本来就分开，且可以反向**：

| 信号 | 来源 | 决定什么 |
|---|---|---|
| 思考档位清单 | 目录 `thinking_config.enabled.efforts` 的键 + `disabled` 分支 | **UI 的档位下拉**（`qoderEffortsFor`；CN `dfmodel` = 高/最大/低 + 关闭思考） |
| 是否真的思考 | 请求体 `parameters.reasoning_effort` + `enable_thinking` | 服务端行为 |
| `is_reasoning` | 目录字段 | **只是**写进 `model_config.is_reasoning` / `chat_context.extra.modelConfig.is_reasoning` |

**真机实测**（本插件自己的链路，CN `dfmodel`，其 `is_reasoning` = false，
免费模型零成本）：`reasoning_effort=max` → **238 字符**思考、`low` → **199**、
`none` → **0**（关得掉）⇒ 支持思考、档位真实生效、`false` 完全不影响。

**客户端源码同款**（`qoder-worker-runtime` 的 `fal()`）：

```js
s = r?.is_reasoning ?? false            // 目录值原样取
u = { key, …, is_reasoning: s, … }      // → modelConfig.is_reasoning
…
(0 === o?.thinkingBudget || 'none' === h.reasoning_effort || false === h.enable_thinking)
  && (l.is_reasoning = false)           // ⚠️ 只会强制成 false，**从不置 true**
```

⇒ IDE 对同一模型发出去的**也是 `false`**，我们与它逐字一致（`supportsThinking`
在适配器里**只有一处**用途：`isReasoning: fallback?.supportsThinking ?? false`）。
⇒ **不要**据此把 `efforts` 丢掉，也**不要**为了「看起来对」把它改成 true
（那会与 IDE 的请求体分叉，且 `is_reasoning` 的服务端语义**未验证**）。

⚠️ 关联记录：`performance` / `qmodel_latest` / `qmodel` / `kimi` 系等条目
同样是 `is_reasoning=false` 却有档位（INTL 的 `performance` 早在静态表年代
就登记过这一格）。

### ⚠️ 目录是**按账号**下发的，且 upsert 语义是「整体替换」

- 实测同一 provider 下不同账号拿到的条数**不同**：国际版 9 个凭据里有一个
  免费额度号，上游只给它 **2 条**（`qfmodel` + `dfmodel`），其余 17 条。
- 适配器缓存是「**上一次成功那一个账号的目录**」（20 分钟 TTL）。
  ⚠️ 导入的后果已如实登记：多账号池下，谁被选中决定菜单宽窄；
  **不要**把多个账号的目录并集起来（那会宣告当前账号用不了的模型，
  报错面比菜单短更难排查）。

### 接线三点（缺一即静默失效，与其余 12 家同形）

1. **取数在 auth 服务**：`QoderAuth.fetchModels(pool)` 只做池的**只读**读取
   （`getAvailableAccount`，不写任何账），池空时回退默认 ref。
   ⚠️ **不得**改成适配器里的 `resolveCredential` —— 它选中账号时会
   `reportAccount`（写「本次实际使用的账号」），而目录请求是周期性的
   （20 分钟刷新器），会把额度标记**改写到目录用的账号**上
   （`index.ts` 的 `activeQoderAccountId` 注释逐字警告过这个后果）。
   守卫：`qoder-auth.spec.ts` 的「池必须只读」（`updateAccount` 不得被调用）
   + `qoder-adapter.spec.ts` 的「目录取数不得走 `resolveCredential`」。
2. **`refresh()` 必须转发** `catalog.refresh`（否则后台刷新器对本家空转且零日志，
   `be42b25` 的形态）；已被 `model-catalog-parity.spec.ts` 的逐家点名表覆盖
   （12 → **14** 家）。
3. **`onCatalogLoaded` 必须接广播**（`registerQoderLlm` 已注入
   `broadcastCatalogChanged(ctx)`）：DSH 客户端把目录缓存在 `ready` 即短路的
   store 里，远端目录异步落地后不广播 ⇒ 选择器**永久**停在冷启动那份兜底表。

### 单测/探针的两个实测教训

- ⚠️⚠️ **该端点对「伪造凭据」也回 200**（返回**真实目录**）。中途一版实现把
  取数放在适配器内 + 走全局 `fetch` ⇒ **每个单测都真发 HTTPS 并拿到上游真表**，
  「自定义 product + 单条兜底表」的 4 条用例以 `Auto · x0.5`（而非 `Unknown`）
  失败。⇒ 适配器**不再自己发请求**（注入式），单测默认不接线即恒走兜底表。
- ⚠️ 既有的 `qodercn-probe.e2e.spec.ts` **「续期」用例是写操作**
  （`/device_token/refresh` 会轮换 `refresh_token` 且探针**不落盘**）——
  文件头原写「全部只读」。已加二次确认闸门
  （`DSH_QODERCN_E2E_REFRESH_CONFIRM=yes`）。⚠️ 本轮跑过一次，已把轮换后的
  凭据手工回写该 CN 账号（并同步池的 `expiresAt`），
  `userinfo` 复验 200。

### ⚠️ 不在这条链路上的东西

- **「1017」这类版本串不在模型列表里**：它是 IDE 的**遥控文案**
  （`GET {base}/ide-text/latest?namespace=…` → OSS，缓存名 `dynamic-texts.json`，
  键 `modelSelector.item.dfmodel.markdownDescription`）。模型列表只给
  `display_name = "DeepSeek-Flash"` ⇒ 我们的列表能反映「已免费」，
  但**显示不出 `-1017` 这个版本后缀**（不接 `ide-text` 就没有）。
- 本机 `~/.qoder{,-cn}/.models/{uid}/catalog-v6` 能离线解出同一份数据
  （只需 uid，`model_cache_decrypt`），但**只对该账号在本机 IDE 打开过时存在**
  ⇒ 纯插件用户恒为空；线上路径不用它，只用于排查对账。

## ⚠️⚠️ 审计补记：一轮 subagent 审计 + 对抗审计（2026-10-20，接入远端目录之后）

用户要求「对这个提交的修改用 subagent 驱动的方式启动一轮审计和对抗性审计」。
派了**两个独立沙箱**（`git worktree add --detach … 8b41403`，`node_modules` 用目录联接，
`pnpm build` 在 worktree 里会因联接失败 ⇒ 改用 `npx tsc -p tsconfig.json` +
`copy-assets` + 客户端 `build.mjs` 补 `lib/`）。主工作区**三次指纹比对零改动**。

### 真缺陷 1 ★★：能力/元数据判据的**取值域**从「编译期超集」变成「按账号变化的子集」

`inputModalitiesFor()` 与 `stream()` 的模型元数据改查「当前目录」后，而 Qoder 的目录是
**按账号**下发的（实测：一个免费额度号上游只给 2 条）⇒ 目录里没有的模型被当成「未知」：

| 场景 | 只查远端（缺陷态） | 取并集（现行） |
|---|---|---|
| `dmodel` + 远端大目录 | ✅ | ✅ 远端优先 |
| `dmodel` + 远端只剩 2 条 | ❌ **硬拒图片** `UNSUPPORTED_CONTENT`；`name` 退化成裸 id、`context`/`reasoning` 消失、请求体 `display_name`/`max_input_tokens`/`is_reasoning` 一并退化 | ✅ 回退静态表 |
| `fast`（只在远端有） | ✅ | ✅ 远端命中 |

**修法**：`catalogModel()` = 远端 ∪ 静态表（**能力/元数据**判据取并集）；
**菜单（`listModels`）仍远端独占**（不能把账号用不了的模型摆出来）。
`resolveModel` 与 `listModels` 共用 `loadCatalog()`，故用「静态表专用的第二个
`ModelCatalog` 实例」做回退，复用骨架自己的装配逻辑（原来想在适配器里重写，
那会是同一语义的第二套判据）。

⚠️ 我复现时的读数（`resolveModel('dmodel')`）：无远端 → `name="DeepSeek-V4-Pro"
modalities=["text","image"] context={"contextWindow":1000000}`；远端只有 `fast` →
`name="dmodel" modalities=["text"] context=null reasoning=null` + `stream()` 硬拒。

### 真缺陷 2：`isFree` 端到端未通（Jet Hub「免费额度」分组拿不到）

`plugin-src/client/model-groups.js` 的免费桶**只认** `model.isFree === true`，
`src/cline-adapter.ts` 的成文约定也是「`isFree` 必须透出」；解析层已产出它，
但 `toCatalogEntry()` **从不写**这个键（改造前也如此 ⇒ 不是本提交引入的回归，
但提交信息「免费标记跟随上游」说过了头）。已补一行透出 + 用例。

### 对抗审计：六条**假绿**（我逐条独立复现）

| 变异 | 变异后读数 | 缺口 |
|---|---|---|
| `refresh()` 空转（成员在、什么都不做） | `model-catalog-parity` **49 passed** | 该守则只判 `typeof === 'function'` ⇒ 抓不到「转发但空转」，而它引用的 `be42b25` 缺陷恰是空转。**已如实收窄其声明范围**（行为面由各家自己的 refresh 用例承担；该文件多数 CASE 不注入 `fetchRemoteModels`，通用化会真发网络） |
| `supportsDisable = true` 恒真 | 4 spec **175 passed** | 无用例喂「无 `disabled`」的远端条目 ⇒ 已补（会给所有模型臆造「关闭思考」档位） |
| `parseEfforts` 末尾 `sort()` | **175 passed** | 「不要排序」铁律无守卫；唯一可观察序的期望值恰是字典序 ⇒ 已补非字典序输入 |
| `readString` 去掉非空 | **175 passed** | 空串 `key`/`display_name` 零覆盖（放过 ⇒ DSH `INVALID_CATALOG` ⇒ provider 整个消失）⇒ 已补 |
| 删池读 `.catch(() => null)` | auth+adapter **111 passed** | 「池读 reject 不炸」零守卫；且 `await` 原在 `try` **之外**，reject 会抛穿 ⇒ 已把整段收进 `try` + 补用例 |
| `fallbackModels` 置空 | 9 条 describe **9 passed** | 断言写成 `toBe(QODER.fallbackModels.length)` 是**同义反复**（`0 === 0`）⇒ 已改成 `>0` + **内容锚定**（`dmodel` 必须存在）。⚠️ 真正抓住「菜单变空」的是 parity 的 (j)（实测 `1 failed`），但那 3 条自己不承重 |

### 解析口径对齐官方客户端（审计发现 + 我的独立发现）

| 项 | 官方（本机产物取证） | 我们（修前 → 修后） |
|---|---|---|
| 档位白名单 | `k3 = ["none","low","medium","high","xhigh","max"]`（**6 个，无 `minimal`**） | 7 个（多 `minimal`）→ 对齐 6 个；中文名表保留 `minimal` 但注明「不在线上白名单」 |
| `efforts` 形态 | `sgi()`：**数组 / 逗号或空格字符串 / 对象** 都认（并去重、过白名单） | 只认对象 → 三形态都认 |
| `available_reasoning_effort` | `R3({thinking_config: 该字段})` ⇒ 它是**一个 thinking_config 对象** | 直接当档位表解析（恒空）→ 包一层；并按官方短路语义，**只在条目自身既无档位也无 `disabled` 时**才读它 |
| 顶层 `default_effort` | `c = ci(e.default_effort ?? e.defaultEffort)`，作默认档兜底 | 未读 → 已读 |
| `is_default` | `vhc()`：**蛇形与驼峰都认** | 只认蛇形 → 都认 |
| `supports_disabled` | `l = a?.supportsDisabled \|\| e.supports_disabled \|\| e.supportsDisabled` | 只看 `thinking_config.disabled` → 补顶层两条腿 |

### 本轮**未修**（已登记，等真机/用户决策）

- **R4 折扣展示口径**：官方 `yo0()` 是「当前价恒取 `price_factor`；划线原价 =
  `promotion.active ? beforePromotionPriceFactor ?? originalPriceFactor : originalPriceFactor`」，
  **从不做 `before×discount` 乘法**。我们的 `qoderDisplayName()` 用**本地时钟推窗口 + 乘法**
  （既有代码，非本提交引入）。改动会改用户可见文案 ⇒ 待拍板。
- **R5**：`refresh()` 先清 `catalogAt=0` 再拉，失败后停在 0 ⇒ 冷却（30 s）一过就重打上游
  （同形态 accio/trae 也有）。
- **R6**：`decrypt_server_response` 的**真加密**分支零覆盖（两站实测都回明文）；
  上游真加密时会 `JSON.parse(密文)` 抛错 ⇒ 静默回退兜底表（只留一条 warn）。
- **R7**：黑名单按 id 写、不随目录收缩而收缩 ⇒ 大目录下点过「关闭全部」后切到
  2 条目录的免费号，`listModels` = 2 − 黑名单 = `[]` ⇒ **DSH 隐藏整个 provider**
  （设置页走 `listAllModels()` 仍可逐条恢复）。端到端复现需真实多账号池，**未实测**。

### 三条过程教训（比结论更值钱）

1. **「守卫有牙」与「取值域正确」是两件事**：提交前我做过 4 处变异验证（都变红），
   但**没有一处**问「我把谁的取值域换掉了」⇒ 缺陷 1 就是从这个缝里漏出去的。
2. **新写的守卫自己可能是假绿**：我给缺陷 1 写的图片回归用例**直接 `stream()`**，
   没有先把远端目录读进缓存 ⇒ `catalogSource()` 还是静态表 ⇒ 变异打不中它
   （变异验证实测：`92 passed`）。**先加载再断言**才是真判据。
3. **变异脚本的锚点必须先自证**：CRLF 上 `replace` 会静默不生效；本轮另有两条锚点
   因「把 `await` 移进 `try` 后缩进变了」而失配 ⇒ 必须报 `PATCH-NOT-APPLIED`
   而不是当成「无牙」。

---

## ⚠️⚠️ 审计补记（2026-10-21，!136 / !137 合并后 5 路 subagent 审计）

完整报告：`docs/audit/pr135-138-merge-audit.md`。这里只留与本家直接相关的。

### ① 真缺陷（**已修**）：`isFreeModel` 只查远端 ⇒ 免费模型被判收费

`QoderAdapter.isFreeModel` 原写成 `this.catalogSource().find(...)`，
而 `catalogSource()` = `remoteModels ?? fallbackModels` —— **远端一落地就把静态表顶掉**。
本家目录是**按账号**下发的（免费额度号只给 `qfmodel` + `dfmodel`，见本文件上一节）
⇒ 静态表里标了 `isFree: true` 的模型被判「未知 ⇒ 非免费」
⇒ 跳过「免费模型不受锁定约束」的短路 ⇒ 锁定永久积分时被 `allowPermanent=false`
拦下、报出「额度都属于永久」这类**与事实相反**的错误 ⇒ **本家 2026-10-21 报障原地复发**。

实测（`lib/` 重建后真跑）：

```
①远端收缩目录（无免费） isFreeModel(qmodel_38max) = false   ★ 应为 true
②远端只含 qmodel_38max isFreeModel(qfmodel)       = false   ★ 应为 true
③未接线远端            isFreeModel(qmodel_38max) = true    ✓
```

⚠️⚠️ **同一文件的 `catalogModel()` 注释逐字记过这个反模式**
（「第一版把它写成 `catalogSource().find(...)`，被独立审计打穿」）——
能力判据当时改对了，**免费判据又写回了它**。⇒ 改任何「按 id 查目录」的判据前，
**先看 `catalogModel()` 的注释**，用它、别用 `catalogSource()`。

⚠️ **判据方向不对称**（为什么必须保守）：判**收费**只是用不上（可恢复）；
判**免费**会绕过锁定**真烧永久积分**（不可逆）。

### ② 真缺陷（**已修**）：`fetchQoderBalanceDetailed` 会抛 ⇒ 并发批量隔离失效

`creditsHeaders` 原本在 try **之外**（!136 把串行 `for` 改成 `Promise.all` 时漏了它）
⇒ 凭据形状异常（如解码出 `null`）时它抛 ⇒ `Promise.all` reject
⇒ **整批** `credits.balances` 变 `ok:false` ⇒ 客户端把同一句 message 盖到
**每一个**账号卡片上。⇒ 已包进 try，返回 `{balance:null, error:'…（凭据不可用）'}`。

### ③ 文案（**已修**）：`remedy` 不得写死站点、不得断言机制

原写死「Qoder **国际版**端点在本机被阻断（TCP 能连通、TLS 握手被丢）」，
而该分支被 `isQoderFamily` **两站共用** ⇒ 中国版用户读到与同一句里主机名
自相矛盾的结论；且对 `ENOTFOUND`（DNS）说「TCP 能连通」是事实性错误。
⇒ 只留出路（站点由 `subject` 主机名点名）。

### ④ **未修**（已登记，**需真机才能定稿**）：兜底表 `dfmodel` 无 `isFree`

两站 `dfmodel` 都没有 `isFree`（`priceFactor: 0.1`），而本文件记着上游它是
`price_factor = 0` + `is_free`（0.1 是被划掉的原价）
⇒ 远端不可用时（兜底路径）`isFreeModel('dfmodel') = false`，而 !137 的 spec
头注释把 `DeepSeek-Flash` 当免费模型之一。

⚠️ **为什么不直接补 `isFree: true`**：若上游的 `is_free` 是**按账号**下发的，
把它写进**静态**兜底表会让**付费账号**被判免费 ⇒ **绕过锁定烧永久积分**（不可逆）。
⇒ 需先真机确认「付费账号下 `dfmodel` 是否仍 `is_free`」。

### ⑤ 前端还差一格收窄（**未修**，前向防御）

后端 `splitBuddyCreditsByExpiry` 已把 `deductionEndTime` 的判据**收窄**为
「只接受 `number` 或数字字符串」（挡住了 `true → 1` 与 `[ms] → 单元素数组`
这两格），而**前端 `packageExpiryMs` 仍是裸 `Number()`** ⇒ 同样两格两站分叉。
可达性低（写入方都同时给 `deductionEndTime`）⇒ 登记为前向防御缺口。

## ⑦ 出口代理与失败分类（2026-10-25 审计：3 域合规 + 2 域对抗，67 次变异）

本节登记 `618a090`（per-账号出口代理）/ `d55a41e`（端口探活分道）/ `551a44b`
（失败分类拆两张表）/ `c5dbf3f`（锁定报错说清原因）这一批的**审计结论与后续修正**。

### 语义表：类别 → 动作（必须逐格同构于同族）

| 类别 | 判据 | 换号 | 写冷却 |
|---|---|---|---|
| `quota` | `QUOTA_EXCEEDED` / `110` / `112` / `pricingUrl` / 余额文案 | ✅ | ✅ 至 UTC+8 当日 24:00 |
| `rate` | `RATE_LIMIT` / 429 | ✅ | ✅ 1h |
| `auth` | `AUTH` / 401 / 403 | ✅ | ❌ **绝不** |
| `upstream` | `SERVER` **且** 上游/网关故障文案 | ✅ | ❌ **绝不** |
| `other` | 其余（400 参数错、风控页、空响应…） | ❌ | ❌ |

⚠️ `auth` / `upstream` 只换号不写冷却，是 **2026-10-06「一个请求封死整池」事故**
换来的不变式（同 loomy / raccoon / minimax / accio）。

### ⚠️⚠️ 本轮修正的三条（都是「本 PR 的目标没覆盖到真实主导形态」）

**① 网关 5xx 原先**不换号**，而它才是实测主导形态**（审计 B1-1）

对抗审计扫了本机**全部 1374 个会话 / 163 条真实 qoder 失败**，按形态计数：

| 真实形态 | 次数 | 旧判据归类 |
|---|---|---|
| `qoder: <html>…504 Gateway Time-out…</html>` | **74** | `other` ⇒ **不换号** |
| `First Token Timeout or Upstream Timeout (504/model_error)` | **6** | `other` ⇒ **不换号** |
| `Error in upstream response (provider_error/model_error)` | 16 | `upstream` ✅ |

⇒ 本 PR 原以为的核心目标（`provider_error`，16 次）**不是主导形态**；而前两种
（共 80 次）既不换号、终态又是 `SERVER`（在宿主 `DEFAULT_RETRYABLE_CODES` 里）
⇒ 还要**白重试 5 次**。修法：`looksLikeUpstreamProviderError` 增补
`gateway time-?out` / `bad gateway` / `service unavailable` /
`(first token|upstream) timeout`，并加**双向**用例（504 必须换号；
`504 + billing 文案` 仍必须归 `quota`；`internal server error` / `request timeout`
仍必须归 `other` —— 判据不得放宽成「5xx 全体」）。

**② 折算路径没接 per-账号代理 ⇒ 墙外环境下该渠道从聚合轮换里静默消失**（审计 A2-17 / B2）

本 PR 把代理接进了**四条腿**（推理 / 原生搜索 / 余额选号 / 登录续期目录），
**折算这条漏了**：`qoderExpiry(credential, product, cached?)` 无 fetcher 形参、
内部 `fetchQoderCreditBalance(credential, product)` 走**全局 fetch** ⇒
墙外折算恒失败 ⇒ `UNUSABLE` ⇒ 被 `rankCandidates` 剔除 ⇒
**用户在聚合轮换列表里永远看不到 qoder / qodercn**，零报错、零日志，
而面板（走选号器那条腿）看起来完全正常。

⚠️ 这**不是**「与本 PR 无关的既有缺口」：`src/index.ts` 明写
「`credits` 与 `expiry` 是两个独立消费域……**两条腿缺一不可**，这正是本仓库
记过 6 次的那类静默陷阱」，而本 PR 恰好只接了 credits 一侧；
`provider-expiry.ts` 的 `minimaxIntlFetchFor` 注释更**逐字**点了同一个症状
（「只把 fetcher 接进了选号器与适配器 —— 折算路径一行没改」）。
修法：`ProviderExpiryDeps` 加 `qoderFetchFor`（**与 minimax 分两个键** ——
两家的解析器是不同实例，合成一个会让「只接了一家」静默通过），
`qoderExpiry` 加第 4 形参，`createProviderExpiry` 的 `qoderFamilyExpiry(QODER, deps)`
透传；守卫是**行为级**（真跑 `createProviderExpiry`，断言注入的解析器**按该
accountId** 被调用、且它返回的 fetch **真的被用去发请求**）——
⚠️ 同族先例 `minimax-proxy.spec.ts` 用的是源码文本断言，本仓库已多次实测
其对「字面量留在死分支里」无感。

**③ 非法代理字符串会让账号**永久不可用**，且入口 **UI 可达**（审计 B2-1）

`sanitizeAccounts` 用 `{ ...candidate }` **原样透传**代理字段，只限「是不是字符串」、
不限「是不是合法代理」。实测：

```
backup.import（载荷 qoderProxy = "ftp://host:21"）→ ok:true、账号落池
  → 此后该账号每次取 fetcher 都抛「代理地址无效 — 不支持的协议 ftp」
  → 该账号【永久不可用】
```

⚠️ 客户端**有**导入按钮 ⇒ 这条路径 UI 可达（审计先只找到 `account.create` 那条
「零客户端写入点」的腿，对抗轮才找到真正可达的入口）。
修法：`sanitizeAccounts` 的四个代理字段统一过 scheme 闸
（`http` / `https` / `socks5`），**非法就清掉该字段**（降级直连）而**不是**丢弃整条
账号 —— 删一个字段比删一条账号可逆得多，且面板上「当前：直连」一眼可见、可重填。
⚠️ 修在这一处（而不是四个 provider 各自的读取侧）的理由：`sanitizeAccounts` 是
「外部数据 → 池」的**唯一闸门**（`state.json` 读取与 `backup.import` 都过它），
四个读取侧（`opencode.ts` / `gemini-proxy.ts` / `minimax-proxy.ts` / `qoder-proxy.ts`）
**同形**地 `throw`，四处同改极易只改一家而分叉。

### ⚠️ 代理口令的泄漏面：**去向决定定级**（对抗审计 B2 的翻案）

审计先报了 2 个 P0，对抗轮**逐条实测去向链**后**降为 P2**：

| 潜在去向 | 实测结果 |
|---|---|
| 宿主 `ctx.logger` | ❌ `testProxy` 期间 logger 调用 **0 次**（handler 返回信封不抛，注册处 `catch` 不触发） |
| 客户端 `console.*` | ❌ 该文件全文零命中；`error` 只进 `React.createElement('p', …)` |
| 落盘 / 会话历史 / 模型上下文 | ❌ 都不 |
| 用户自己的弹窗 | ✅ **唯一落点** |

⇒ **没有一条后果链能到达「用户以外的人」** ⇒ 不够 P0。
但**仍修了两处**（都便宜且方向明确）：

1. `qoder.testProxy` 的失败文案曾写
   `` `代理 ${label}（${url}）没有在监听` `` —— `label` 已脱敏成
   `http://user:***@host:port`，紧接着又把带**明文口令**的 `url` 贴回来，
   **同一句里自己拆自己的台**（且错误行是用户最容易整段复制/截图的东西）。
   ⇒ 删掉 `（${url}）`，只回显 `label`。
2. 四家 `set*Proxy` 的**日志**都直接拼原始 `proxy` ⇒ 口令明文进日志。
   ⇒ 统一走中立模块 `src/proxy-mask.ts` 的 `maskProxyPassword`。
   ⚠️ 池**不能** import `opencode.ts`（provider 实现在依赖图上层，会成环），
   而复制一份正则进池里正是本仓库「**同一语义两套判据**」的红线 ⇒
   脱敏实现住在**双方都能依赖**的中立文件里。

⚠️ **定级判据可推广**：说「泄漏」必须能说出「**谁**在什么条件下拿到它」。
「用户自己看自己刚敲的口令」不是 P0；而「口令进日志文件、被随手贴进 issue」
是**用户发起**的次级风险（条件性、人为中介）。

### ⚠️⚠️ 两处仍**未修**（已登记，附理由）

**① 401/403 分支把「额度文案」判在「认证续期」之前**（审计 A1-F-02，对抗轮判 OVERSTATED）

`:1733` 的 `isBillingBusinessCode(status) || looksLikeBillingError(errorText)`
排在续期分支之前 ⇒ `401 + "Billing daily count exceeded"` 会让**全池每个账号各写
一个近乎一天的冷却**（`recordsQoderRateLimit('quota') = true`、
冷却 = `nextUtc8DayStartMs()`）—— 正是「一个请求封死整池」的形态。
且该顺序与本文件**自己的注释**矛盾（`:1725-1728` 说「401/403 的第一处置是续期」）。

⚠️ **为什么不修**：对抗轮扫了**全部 1374 会话 / 163 条真实 qoder 失败**，
`401/403 + 余额文案` **零命中**（`401 = 0`；`403 = 54 且全是 10605 排队帧`；
billing 文案**恒走 `(110/model_error)` 即 HTTP 200 + SSE 通道**；
`402 = 0`）⇒ 属「**结构可达、零实测**」，按本仓库成文判据（同类前提在 codearts 上
141 会话零命中即撤回）应降级。
⚠️ 且 A1 给的修法有**副作用**（B1-3）：在「续期失败」子分支会把上游原文替换成
`credential expired and refresh failed` —— 与「**文案本身就是出路**」红线同型
（用户会去重新登录，而真因是额度/网关）。⇒ 要修必须同时保留原始 `errorText`
（拼进 AUTH 消息或作为 detail），并补「原文仍在 message 里」的用例。
**留给能真机复现该共现的人做。**

**② `auth` 行的「换号」语义也未实现**（审计 B1-4，A1 漏了这半边）

语义表承诺 `auth ⇒ 换号 ✅`，但 `:1712-1756` 分支内**没有任何**
`switchAccountOnQuota` 调用（只有额度那处硬编码）⇒ 401/403 续期失败与第二发 401
**都直接抛**，池里第二个账号**永不被尝试**（实测 `picks=[]`：**根本没去取号**）。
若某账号 `refresh_token` 失效，整条请求失败而池里可能仍有可用账号 ——
与 accio「登录 N 个账号 ≠ N 倍可用性」同型。

⚠️ 另：对抗轮实测 `'AUTH'` **永不入参** `classifyQoderFailure`
（`:1774` 的 `httpErrorCode` 只在非 401/403 分支被调；`:1840` 的 SSE 生成器只抛
`EMPTY_RESPONSE` / `TRANSPORT` / `SERVER` / `QUOTA_EXCEEDED` / `QUEUE`），
6 种 SSE 认证形态实测**全部 → SERVER → other** ⇒ `auth` 那格当前是**死代码**
（不是纵深防御），M8（auth 也写冷却）只红一条纯函数用例、**零行为守卫**。
**留给按 F-01 修法一并实现的人**（AUTH 走类别表 ⇒ 换号 + 不冷却，并加
「第二发 `body.token`」的行为用例）。

## ⚠️⚠️ 传输级失败必须换号（issue IKR5ZD，2026-10-31 修复）

用户报障（2026-10-28）：「`qoder: transport error: fetch failed`；到 `api2.qoder.sh`
的 TCP 连接 10s 超时，**重试不换 IP**，错误丢失 cause」。本地逐条取证：

| 指控 | 结论 |
|---|---|
| 10s 连接超时 | **不是插件设的** —— undici 默认 `connectTimeout`。用保证不可达的 `192.0.2.1` 实测 `10,713ms`，错误形态 `TypeError: fetch failed` → `cause.code=UND_ERR_CONNECT_TIMEOUT`、`cause.message` 含 `attempted address: …:443, timeout: 10000ms` |
| 重试不换 IP | **成立且更硬**：该域名有 **2 个 A 记录**（`47.57.188.188` / `8.223.13.163`），但 `dns.lookup` 默认**只回第一个**，连打 **8 次建连全部落在 `47.57.188.188`**；而适配器对 transport 错误**零换号**（`fetch` 只 1 发、池 `getAvailableAccount` 0 次），宿主又把 `TRANSPORT` 当可重试码（`DEFAULT_RETRYABLE_CODES`，`maxRetries=5`、退避 500ms→10s）⇒ **6 发全打同一条出口**，对「路由被阻断」等于零重试 |
| 错误丢失 cause | 对象层面**不成立**（`{ cause }` 从首版就有，issue 那个版本 `e8d14c6:src/qoder-adapter.ts:1703-1704` 也带着）；但 **message 只有 `fetch failed`**，可操作信息在两级 `cause` 之下 ⇒ 用户视角成立 |

### 修法（三条，`src/qoder-adapter.ts`）

1. **transport 错误换号**：`sendEncrypted` 外包一层 `try/catch`，命中 `code==='TRANSPORT'`
   就调 `switchAccountOnQuota(..., 'transport')` —— **换号 = 换出口**（每账号可配独立
   代理，见 `618a090`「国际版 SNI 阻断下唯一出路」）。修前这条调用**一次都执行不到**。
2. **预算 2 次**（`QODER_TRANSPORT_MAX_RETRIES`）：**只换号、不同号空转** —— 同号重连对
   阻断路由无效，而「瞬时抖动」宿主已经用退避重试 5 次兜了；再叠一层只会把「完全离线」
   从 10s 放大到 30s/轮。换不到号就**立即抛**。
3. **message 带 cause 链**（`transportErrorDetail`）：沿 `cause` 取最多 4 层、去重、
   自引用不发散，输出形如
   `qoder: transport error: fetch failed ← UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address: 1.2.3.4:443, timeout: 10000ms)`。
   ⚠️ 结果过 `maskProxyPassword` 脱敏 —— 顺手把该函数从**锚定 `^`** 改成全局非锚定
   （原来对「地址夹在句子中间」静默漏脱敏，而那正是错误文案最常见的形态）。

### 三条边界（与 `minimaxFetchWithRetry` 同款）

只处理传输错误（4xx/5xx 是服务端明确答复，重试只会掩盖真因）／**abort 绝不重试**／
耗尽后抛**原错误**并保住 `cause`。

⚠️ abort 的判据**只留一处**（`sendEncrypted` 的早退）：在重试循环里再判一遍是
**不可观测的等价变异**（实测删掉它全绿 —— 因为 abort 时 `sendEncrypted` 抛的是原始
错误、非 `TRANSPORT`，循环里上一行的码判据先 rethrow 了）。行为由「abort ⇒ 只发一发」
的服务级用例守住。

### 仍未修（如实登记）

`dns.lookup` 的**单地址**行为没动：真要「换 IP」得对 `api2.qoder.sh` 取 `all:true`
再逐地址尝试，那属于出口层改造，风险比换号大，单独一轮再定。
`fetchFor` 的代理侧同理 —— 该域名若在某条链路上被 SNI 阻断，**给账号配代理**仍是当前
唯一出路。

### 复审修正（同日：一名审计 + 一名红队跑本分支，抓出的东西）

- **P1 安全回退已修**：给 `maskProxyPassword` 去掉锚定时，第一版顺手把字符类收窄成
  `[^:@/\s]` / `[^@/\s]`，于是 `http://a b:s3cr3t@h:1` 这种**带空白的脏值**从
  「已脱敏」退回「明文输出」。`account-pool.ts` 的 `proxyLogText` 明写它接收
  「备份文件原样透传的脏值」⇒ 这条影响面是真实日志。**字符类必须保持宽口径**
  （`[^:@/]` / `[^@/]`）：**宁可多遮，不可漏遮**。
- **P1 假绿已删**：原「换号重发」用例拿「两发 `Authorization` 不同」当判据 ——
  COSY 载荷每次带新 `requestId`，**同一账号连发两次也必然不同** ⇒ 断言恒真，
  连「换回同一个号」的变异都能过。改为「池返回**缺 uid** 的凭据 ⇒ 必然抛
  `MISSING_CREDENTIAL`」——这条能真正证明用的是**池返回的那份凭据**。
- **P2 无牙用例已换**：原「HTTP 500 不被传输级重试吞掉」没有判别力（500 被归
  `other`，且它的 `LlmError` 在新 `try` **之外**抛，新 catch 根本看不到）。
  改成「`fetch` 抛**非传输**错误时不得被包装成 TRANSPORT、一发即止」。
- **P2 强化**：`transportErrorDetail` 补 `String(code)` 兜底（`code` 是 Symbol 时
  原来会**自己抛错顶替原始错误**）与 **512 字符截断**（实测 10 万字符 cause 会原样
  进日志/UI）；用例补上 cause 为字符串/普通对象/深链/相邻重复/2 跳自引用/超长。
- **P2 注释说反已改**：正文里「换不到号才同号退避重试」与实际（**立即抛**）不一致。
- **已登记的边界**：① 只覆盖**建连腿**，SSE 中途的 `sse transport error` 被
  `classifyQoderFailure` 归 `other` ⇒ **不换号**（正文可能已吐一半，换号会重复内容，
  刻意如此）；② transport 换号会把上一个号塞进本次请求的 `tried`，后续额度换号
  少一个候选（非永久损失，transport 不写冷却）；③ `classifyQoderFailure` **永不**
  返回 `'transport'`，该成员只作内部入参；④ `transportErrorDetail` 是仓内**第 7 份**
  「沿 cause 链取信息」的实现（另有 `opencode-rpc.ts` 的 `describeFetchError`、
  `minimax.ts`、`network-hint.ts`、`refresh*.ts`），口径重叠、有漂移风险，暂不合并。

### 第二轮（红队）补记：无牙与不可观测，逐条登记

| 腿 | 变异 | 现在 | 处置 |
|---|---|---|---|
| 限深 4 层 / 相邻去重 | 4→1 / 去掉去重 | **有牙**（已补深链、重复、2 跳自引用、Symbol code、10 万字符截断用例） | 已补 |
| 换号后 `ensureUid` | 删掉 | **有牙**（缺 uid ⇒ `MISSING_CREDENTIAL` 用例） | 已补 |
| 换号 = 换出口 | 把 `fetcherForCurrentAccount()` 提到循环外 | **有牙**（新增 `fetchFor` 观测用例：出口序列必须是 `['acct-A','acct-B']`） | 已补 |
| 换后不采纳新凭据（`credential = switched.credential`） | 删该行 | **无牙、且无法观测** | **如实登记**：两份凭据的差异只在 WASM 的 `COSY` 签名内部；`machine_id: ''` 与「缺 uid」两条替代判据实测都不可区分（后者抛点在 `ensureUid`、在 switch 内部）。保留该行 + 代码评审，**不编恒真用例** |
| `authRefreshed = false` | 删掉 | **无牙** | 只有「401→transport→401」的顺序能观测；该场景代价 > 收益，**登记**为未覆盖 |
| `shouldRotateQoderAccount('transport')` | 改 false | **无牙（死代码）** | `classifyQoderFailure` 永不返回 `'transport'`，transport 换号是**直接调**；已把注释改成「别当承重件」 |
| 删 `transportRetries += 1` | — | **挂死**（不是变红） | 循环全是已 resolve 的微任务 ⇒ 事件循环闹钟饿死、vitest 的 `testTimeout` **不触发**，只能靠 CI job 超时。**登记**：这行若被误删，CI 表现为「挂到超时」 |

另外两条**行为**结论（都已改掉）：
- `activeAccountId` 为 `''`/`undefined` 时（探测适配器 `currentAccountId: () => entry?.id ?? ''`），
  换号拿不到排除通道、池可能把同一个号还回来 ⇒ 白等一个 10s。现在**直接抛**。
- 换号期间池自己抛错（如 `pool read failed`）会顶掉原始 `TRANSPORT`、`cause` 也没了 ——
  与「保住 cause」主旨相反。现在**只吞非 `LlmError`**（`LlmError` 是刻意的判断，如
  `MISSING_CREDENTIAL`，必须如实报出）。

## ⚠️ 多账号同机的「物理设备锁」（issue #17，2026-11-03 核对）

Qoder 服务端按**设备指纹**（`Cosy-MachineToken` + `Cosy-MachineType`）限制每日领取：
同一台机器上第一个账号领完后，其余账号的 claim 会回

```json
{ "status": "BLOCKED", "failureCode": "SAME_PERSON_ALREADY_CLAIMED" }
```

**这不是登录失效，也不是本插件的缺陷**：设备身份由 Qoder 桌面端的 UMID 生成，
同一台机器天然只有一套；重新登录、删卡重加、换账号都**无法绕过**（服务端就是
按设备计数）。⚠️ 仓库的 `QODER_MACHINE_TOKEN_PATH` 可以把身份指向另一份 token 文件，
但它只用于**单测隔离/排查**（生产不会自动切换设备身份），不要用它来规避设备锁。插件现在把该 failureCode 翻成「同一设备今日已由其它 Qoder 账号领取
（上游设备锁），换设备或明日再试」，避免用户误以为是登录坏了。

⚠️ **不要**为了「让多账号都能领」而给每个账号伪造不同的 `Cosy-MachineToken` ——
那是规避上游反滥用设备锁，既不稳定也可能违反服务条款；多账号需求应分设备。

### 与 issue 里另外两条的关系（均已核对）

- **`/claim` 请求体**：本仓 `claimQoderCampaign` 一直是 `body: ''`（`content-length: 0`），
  issue 说的「必须发空串」**已经是现状**，无需改。
- **Linux 路径**：`findRuntimeInfoExecutable` 走 `<home>/.qoder{,-cn}/.bin/umid-*/runtime-info`
  （非 Windows 用无 `.exe` 的名字），磁盘退路是
  `~/.config/Qoder{," CN"}/SharedClientCache/cache/machine_token.json`。issue 提到的
  `~/.local/opt/qoder` / `~/.config/com.qoder.app.stable` 不在现有候选里；但它们是否是
  Linux 上 UMID 的真实数据目录**尚未在 Linux 实测**，不能断言「不需要追加」——
  若 Linux 用户拿不到身份，应先用 `QODER_RUNTIME_INFO` 指向真实可执行文件验证。若 Linux 用户仍拿不到身份，
  应先用 `QODER_RUNTIME_INFO` 指向真实的 `runtime-info` 验证，再谈路径扩展。
