# 添加一个新的 LLM Provider

> 版本：v1.1 · 基于 `dsh-codearts-auth` 插件架构
> 对应源码入口：`src/index.ts` · 项目 AGENTS.md
> v1.1（2026-10-13）新增：accio 的三条新坑（§5 `rundll32`、§6 秒/毫秒、§7 同族≠同形状）、
> 「八处静默失效的接线」、以及把过时的「手抄能力表 / 逐个 case 分派」订正为现行的
> 「注册表派生 / 按 id 查表」。

## 概述

本插件已集成 **29 个 provider**（完整清单与能力见 README 的「支持的渠道」；
⚠️ 按 `PROVIDER_REGISTRY` 里的**真实渠道**数，不含 `aggregate`（它是跨渠道聚合的
虚拟入口，`channel: false`）），按**协议源流**分成多支脉系。最早的两支是：

| 脉系 | Provider | 特点 |
|------|----------|------|
| **CodeBuddy 系** | `buddy`（腾讯 CodeBuddy 中国版）、`workbuddy`（腾讯 WorkBuddy 国际版） | 同源：共用同一 CLI 内核、同一认证协议（external-link 轮询式）、同一 chat 端点格式，差异全部收敛在 `BuddyProduct` |
| **LobsterAI 系** | `lobsterai`（有道龙虾） | 不同源：完全独立的登录协议（本地回调 + authCode 换 token）、独立请求头（`X-LobsterAI-Client-*`）、独立签到协议 |
| **MiniMax 系** | `minimax`（MiniMax Code 中国版）、`minimaxintl`（MiniMax Code 国际版） | 同源：**首个 Anthropic Messages 协议族**，两站只差 `MinimaxProduct` 的 **6 个字段**（`id` / `displayName` / `accountHost` / `apiHost` / `region` / `defaultCredentialRef`），其余共用全部实现（判据由 `minimax-intl.spec.ts` 的「除这 6 个字段外逐字段相同 + 反向自检」锁住）。⚠️ `label` / `logoClass` / `settingsNamespace` 属 **`PROVIDER_REGISTRY` 描述符**字段，不在 `MinimaxProduct` 里，别混进这 6 个 |

此后陆续加入的 `qoder` / `qodercn` / `trae` / `cline` / `loomy` / `raccoon` /
`zcode` / `opencode` / `gemini` / `officeace` / `accio` **各自成支**（协议互不同源），
它们的实测结论与逐条坑点分散登记在 `docs/agent-notes/providers-*.md`。

> 📌 **accio（第 17 个）之后的成员**（本文其余章节尚未逐条展开，各自的实测结论散在
> `docs/agent-notes/providers-*.md` 或源码模块头注释里）：`astudio`、`autoclaw` /
> `autoclawintl`（智谱，读不同 userData 目录）、`magicrew` / `magicrewintl`、
> `modelscope`、`codely`、`monkeycode` / `monkeycodeintl`、`baizhi`，以及
> `marvis`（腾讯 Marvis，**QQ / 微信 OAuth + 双套鉴权**：模型网关不带 UAL 签名、
> `/v3/*` 钱包必须带签名，见 `src/marvis.ts` 模块头）。它们与本 fork 的其它
> 「本 fork 独有」渠道一样，都要求把「八处静默失效的接线」全部补齐（见 AGENTS.md）。

因此你要添加的 provider 如果属于**已有脉系**（比如再加一个腾讯系产品），只需加一份 `BuddyProduct` 配置并注册实例；如果是**全新的脉系**（全新的API协议、认证方式、签到流程），需要仿照 LobsterAI 创建一套独立但遵循相同架构模式的实现。

> 📌 **最新一份「同源加点」范例是 `minimaxintl`（2026-10-15）**：它给已有的 `minimax`
> 脉系再加一站（国际站），改动量极小 —— 主要是在 `src/minimax-product.ts` 加一份
> 产品常量，再把两站共用适配器类所依赖的**各处接线**逐一补齐
> （`PROVIDER_REGISTRY` / `provider-runtime` 注册表、`src/index.ts` 的 `probeById`、
> `WRITES_RATE_LIMIT_PROVIDERS`、`SELF_HEAL_REFRESHABLE_PROVIDERS`、ref 前缀表、
> 积分表、客户端图标与样式）。
> ⚠️ **最容易漏的是「接线点」**：漏一处**都是静默失效**（界面缺项或功能不工作，
> 没有任何报错）—— 详见 `docs/agent-notes/providers-loomy-raccoon-minimax.md` 的
> MiniMax 一节（§0 双站点用两个 provider id 的理由，以及那串必须逐个到位的接线表）。

> 📌 **最新一份「全新脉系」范例是 `accio`（2026-10-13，第 17 个 provider）**：
> ⚠️ 序号按 `PROVIDER_REGISTRY` 的声明顺序数；officeace（第 16，2026-10-12）
> 与 accio **同一次**合入 master，故两者相差一格。
> `src/accio-product.ts` → `accio.ts` → `accio-oauth.ts` → `accio-auth.ts` →
> `accio-messages.ts` → `accio-adapter.ts` → `accio-credits.ts`，另有客户端专属面板。
> 它的实测笔记（`docs/agent-notes/providers-accio.md`）里有三条**与参考实现相反**
> 的结论与两个真缺陷，动 accio 前必须先读它。

---

## 两种路径速览

### 路径 A：添加同源产品（已有脉系加点）

如果你要添加的 provider 与 CodeBuddy/WorkBuddy **共用同一协议**（例如另一个腾讯系IDE产品），只需：

```
┌─ 加 product.ts 的产品常量 → 在 index.ts 注册实例 → 加进 registry/runtime 与 auths 命名对象
```

详见 §「路径 A：同源产品」。

### 路径 B：添加不同源产品（全新脉系）

如果你要添加的 provider **协议完全不同**（自定义认证、自定义请求头、自定义签到），需要：

```
┌─ product.ts (或 xxx-product.ts)       ← 产品配置唯一真相源
├─ xxx.ts                              ← 协议常量、凭据结构、纯函数
├─ xxx-auth.ts                         ← 认证服务 (Service 子类)
├─ xxx-adapter.ts                      ← LLM 适配器 (LlmAdapter 子类)
├─ xxx-oauth.ts                        ← 登录流程
├─ xxx-credits.ts                      ← 签到/积分（可选）
├─ xxx-errors.ts                       ← 错误分类（可选）
├─ index.ts                            ← 注册入口
├─ provider-registry.ts                ← 纯数据条目（能力声明；id 纯小写字母）
├─ provider-runtime.ts                 ← 能力实现（在 apply() 里注册）
├─ jet-hub-rpc.ts                      ← RPC 分派（account.create 显式分支）
├─ 单测 + E2E
└─ 客户端（credits-capabilities.js 从 registry 派生；可选专属面板）
```

详见 §「路径 B：不同源产品」。

---

## 架构核心概念

在动手之前，先理解本插件的**架构骨架**。

### 1. 三层模型

```
┌─────────────┐     ┌──────────────┐     ┌────────────┐
│ 产品配置层   │────→│  认证服务层   │────→│  LLM 适配器 │
│ product.ts  │     │  xxx-auth.ts │     │ xxx-adapter│
│（差异收敛）  │     │（登录/续期）  │     │（对话转发） │
└─────────────┘     └──────────────┘     └────────────┘
                           │
                           ↓
                     ┌──────────────┐
                     │  账号池      │
                     │ account-pool │
                     │（多账号管理） │
                     └──────────────┘
```

- **产品配置层**：把不同产品的差异收敛到唯一的配置对象中（如 `BuddyProduct` 的 endpoint、userAgent、productCode）。这是"为什么两个同源产品只用一套代码"的秘密。
- **认证服务层**：继承 `cordis/Service`，管理登录流程、凭据存储、静默续期（`RefreshScheduler`）、批量续期（`refreshAll`）。
- **LLM 适配器层**：继承 `LlmAdapter`，负责模型目录播报（`listModels`）、模型解析（`resolveModel`）、流式对话转发（`stream`）。

### 2. 双文档系统与凭据分离

```
凭据本体: ctx.credentials (加密存储)    ← 令牌/refresh_token
账号索引: ctx.settings → jet-hub ns    ← 账号列表/黑名单/顺序
```

- 凭据本体通过 `ctx.credentials.set(ref, JSON.stringify(credential))` 存储
- 账号索引（账号列表、模型黑名单、拖拽排序）存在 `ctx.settings` 的 `jet-hub` namespace 下
- 两者通过 `credentialRef` 字段关联

### 3. 续期不得按 `enabled` 过滤；也**不得**按 `refreshable` 过滤

```
refreshAll() 不按 enabled 过滤，也不按 refreshable 过滤
停用只影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关
```

这是**两次真实缺陷**的教训。详见 AGENTS.md 的「续期不得按 `enabled` 过滤」与
「账号池的 `refreshable` 只是**凭据材料的镜像**」两节：

- **不看 `enabled`**：停用期间不续期 ⇒ 凭据烂在停用窗口里，用户重新启用后拿到死凭据；
- ⚠️ **不看 `refreshable`**：那个布尔是**每轮由凭据对账出来的结果**，不是「曾被服务端
  拒绝过」的案底。拿它当门禁 ⇒ 任何一次误标都变成**单向门**（定时那轮跳过它、启动首轮
  也跳过它，「自动续期没工作、重启也没用」，而凭据明明还能用）。
  **调度判据读凭据本身**（如 accio 的 `isAccioRefreshable(credential)` = `refresh_token`
  非空）；读凭据只是**本地存储访问**，不花网络也不花模型额度 —— 拿它当门禁来「省请求」
  是**错省**，省下的是自愈能力。

⚠️ **「本轮不刷」的分支也绝不能直接 `continue`** —— 必须仍做一次**有效期对账**
（`src/expiry-sync.ts` 的 `syncAccountExpiry` / `refreshAccountWithReconcile`）。
只修「续期时回写」是不够的：**存量账号**的凭据早已在别处续好，判据必然为「不用刷」，
池里的旧值就**永远无人更正**（UI 一直显示「已过期」，而凭据是好的）。
判据用「**与凭据不一致**」而不是「池值已过期」。

⚠️ **三条续期入口会并发消费同一份 `refresh_token`**（定时器 / 推理按需 / 面板按钮，
而 DSH 本身会并发发主回复 + 标题 + 压缩三条请求）⇒ 必须上 per-`credentialRef` 的
`SerialQueue`，且**锁内重读**凭据（仍在有效期内就直接对账返回，少烧一次 token）。
⚠️ 该锁**只在单进程内有效**：同机 web + desktop 两个实例各自持锁，跨进程互踩只能靠
「判终态前先重读磁盘凭据」兜 —— **两处都得有，少一个就会复发**。

### 4. 两步式登录（"+ 新建账号"）

```
account.create 必须在用户授权完成之前返回 loginUrl
前端立即 window.open，后台异步等回调
```

**不是风格偏好，是浏览器硬约束**：`window.open` 只在 transient activation 窗口内有效。详见 AGENTS.md。

### 5. ⚠️ 打开浏览器**绝不能**用 `cmd /c start`（用 `rundll32`）

**2026-10-13 accio 实测**（`docs/agent-notes/providers-accio.md` §1）。

```js
execFile('cmd', ['/c', 'start', '', url])                        // ❌
execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url])   // ✅
```

`cmd.exe` 把 URL 里的 **`&` 当命令分隔符**，URL 会在第一个 `&` 处**被截断**：

```
https://www.accio-ai.com/login?return_url=…%26launcher_timestamp%3D<ts>
                                                             ↑ 到此为止
丢失：&state=…&code_challenge=…&code_challenge_method=S256&client_id=accio-work
```

**症状极具误导性**（三个现象全部由这一个 bug 解释，排查代价极高）：

| 现象 | 真因 |
|---|---|
| 登录页弹「**请升级客户端**」modal | `code_challenge` 丢失 ⇒ 恰好命中登录页的 legacy 客户端门禁 |
| 弹出一个**文件管理器**窗口 | 残余片段被 `explorer.exe` 当**路径**打开 |
| 回调**永不到达** | `state` / `code_challenge` 都没了 |

⇒ 必须用 `rundll32 url.dll,FileProtocolHandler`（**不经过任何 shell**，参数原样交给系统
URL 处理器）。macOS / Linux 用 `open` / `xdg-open`，同样不经过 shell。

⚠️ **那个空回调不是装饰**：`execFile(cmd, args, () => {})` 的第三个参数**就是**
异步 `'error'` 事件的消费者（传了回调，Node 才代为挂上 `'error'` 监听器）。
删掉它会变成**未捕获异常并打挂宿主**（实测 `listenerCount('error') === 1`）。

⚠️ **必须加源码级回归锁**：断言实现里出现 `rundll32` 且**不出现** `cmd` + `start` 组合。
既有范例：`tests/unit/accio-oauth.spec.ts` 的「★ 防回退锁」段。
⚠️ 写这类断言时**必须先切片再断言**：直接对**整份源码**做 `toContain('rundll32')`
是**恒真**的（文件头注释里就写着这个词），删掉整个函数体照样全绿。

### 6. ⚠️ 秒 vs 毫秒：过期时间戳必须**在边界归一化一次**

**2026-10-13 accio 实测**（同上 §5）。上游 `expiresAt` 是**秒**
（实测 `1794407698` ≈ 2026-11-11），官方客户端自己做了 `1e3 *` 归一化。

**若直接当毫秒用**：

```
new Date(1794407698) → 1970-01-21        ⇒ 判定「早已过期」
⇒ 每个请求都触发续期
⇒ 并发下反复消费 refresh_token
⇒ 最终 invalid_grant ⇒ 账号被标死，用户只能重新登录
```

这与本仓库 **codearts 的「续期单向门」事故同型**，且更隐蔽（错的是**时间量纲**，
不是布尔，日志里看不到任何「判断错了」的痕迹）。

**规则**：

- **归一化只做一次**，在**兑换 / 续期返回处**（accio 是 `accio-oauth.ts` 的
  `toTokenResult` → `accio.ts` 的 `accioExpiresAtMs`），此后全链路一律毫秒；
- 带 **`> 1e12` 防御分支**（视为已是毫秒，容忍上游某天改单位）；
- 单测**必须做反向验证**：去掉 `×1000` ⇒ 用例必须变红
  （范例：`tests/unit/accio-oauth.spec.ts` 的「⚠️⚠️ 上游 expiresAt 是秒 ⇒ 必须 ×1000」）。

### 7. ⚠️ 「同族」≠「同字段形状」：逐字段拿官方 proto 核对

**2026-10-13 accio 实测**（同上 §4.1.1）。

accio 与 Gemini 同族的是**信封骨架**（`contents` / `parts` / `thought` /
`usage_metadata`），**不是每一个字段**：accio 的 `system_instruction` 必须是
**字符串**，而 Gemini 是 `{parts:[…]}` 对象。

照搬 Gemini 的对象形态 ⇒ **HTTP 200 + 流内 `400 Invalid request format`**
（最难看的一种失败：状态码说成功，错误在流里；不读流内 `error_code` 会误判成
「成功但没内容」）。

⇒ **「同族」只能作为起点**，逐字段仍要拿官方 proto 核对。复用同族消费器
（如 accio 复用 `consumeGeminiSse`）是对的，但**请求体构造必须逐字段实测**。

---

## 路径 A：添加同源产品（如另一个腾讯系产品）

假设你要添加一个新产品 **`buddyeu`**（腾讯 CodeBuddy 欧洲版），与现存的 CodeBuddy/WorkBuddy 同源。
⚠️ **id 用纯小写字母、不带连字符**（见「架构核心概念」的说明：它同时是 cordis 服务名、
LLM 路由名与客户端 key）。

### A1. 定义产品配置（`src/product.ts`）

```typescript
// 添加到 src/product.ts

export const BUDDYEU: BuddyProduct = {
  id: 'buddyeu',                            // provider 标识（纯小写字母）
  platform: 'ide',                          // auth/state 的 platform
  endpoint: 'https://copilot-eu.tencent.com', // 不同区域不同域名
  apiDomain: 'copilot-eu.tencent.com',
  displayName: 'CodeBuddy (欧洲版)',
  productCode: 'buddyeu',
  userAgent: 'CodeBuddyIDE/1.200.0',
  attributionName: 'CodeBuddy EU',
  clientVersion: '1.200.0',
  cliVersion: '2.200.0',
  defaultCredentialRef: 'BUDDYEU_ACCESS_TOKEN',
  appendSessionParams: false,              // 与 CodeBuddy 中国版一致
  fallbackModels: BUDDYEU_FALLBACK_MODELS, // 欧洲版模型池（需实测）
}

export const ALL_PRODUCTS: readonly BuddyProduct[] = [CODEBUDDY, WORKBUDDY, BUDDYEU]
//                                                 ↑ 加入此处
```

**要点**：
- `id` 不能与现有产品重复（`'buddy'` / `'workbuddy'`），且**纯小写字母、不带连字符**
- `defaultCredentialRef` 用大写的 provider id 前缀（`BUDDYEU_ACCESS_TOKEN`）
- `fallbackModels` 来自服务端 `/v3/config` 的实际模型池，**不要照抄中国版或国际版**
- `ALL_PRODUCTS` 数组必须包含新常量，否则 `productById()` 找不到它

### A2. 注册 provider 实例（`src/index.ts`）

```typescript
// 1. 注册 settings namespace（与 registerProviderSettings 的调用保持一致）
registerProviderSettings(ctx, 'llm-buddy', 'llm-workbuddy', 'llm-codearts', 'llm-lobsterai', 'llm-buddyeu')

// 2. 创建认证服务实例
const buddyEu = new BuddyAuth(ctx, { product: BUDDYEU })

// 3. 注册 LLM 适配器
registerBuddyLlm(ctx, {
  credentialRef: credentialRef(BUDDYEU.defaultCredentialRef),
  resolveCredential: async () => {
    const available = await pool.getAvailableAccount('buddyeu', '')
    if (available) return available.credential as BuddyCredential
    const resolved = await ctx.credentials.resolve(credentialRef(BUDDYEU.defaultCredentialRef))
    if (!resolved) return undefined
    try { return JSON.parse(resolved.value) as BuddyCredential } catch { return undefined }
  },
  refresh: () => buddyEu.refresh(),
  fetchRemoteModels: () => buddyEu.fetchModels(pool),
  readImage: makeReadImage(ctx),
  accountPool: pool,
  product: BUDDYEU,
})

// 4. 加入批量续期调度
async function refreshAllCredentials(): Promise<void> {
  // ... 现有代码 ...
  try { await buddyEu.refreshAll(pool) } catch { /* 静默 */ }
}
```

**要点**：
- `settingsNs` 格式为 `llm-${product.id}`，即 `llm-buddyeu`
- 调用方显式传 `product: BUDDYEU`，让 `BuddyAuth` 实例知道自己是哪个产品
- 服务名由 `BuddyAuth` 按 `product.id` 派生为 `buddyeuAuth`

### A3. 在 RPC 中加分派分支（`src/jet-hub-rpc.ts`）

⚠️ **2026-10-08 起 `account.refresh` 不再是逐个 `case`**：它统一走
`authOf(auths, entry.provider)`，新 provider 只需加进 `auths`（键 = provider id）。
**唯一**要逐个 provider 手写的是 `account.create`（两步式登录各家的形状不同）。

```typescript
// account.refresh —— 无需新增 case；查表自动覆盖
//    ⚠⚠ 但**必须传 pool + entry.id**（issue IKIRTT）：续期后要把新的 expiresAt 回写
//    账号池条目，否则凭据续好了、UI 一直显示「已过期」，用户没有自救手段。
//    这两个参数是**可选**的，漏传**能编译、类型全绿**，但会静默丢回写 ——
//    `tests/unit/refresh-bootstrap-wiring.spec.ts` 会逐个 auth 扫这条不变式。
await buddyEu.refreshAccountCredential(entry.credentialRef, pool, entry.id)

// account.create —— 与 buddy/workbuddy 共用 productById 分支，无需改动
// 但需把实例加进 registerJetHubRpc 的 auths 命名对象
```

⚠ **不要**在 `account.refresh` 的 catch 里回 `ok:true` + `value.success:false`：
客户端 `unwrapRpcResult`（`plugin-src/management-rpc.mjs`）只判 `ok === true`，
只判 `ok` 的调用方会把续期失败读成成功（issue IKJOZA，真实代价是 18 次里 17 次失败
被显示成「✅」）。**判据**：catch 里的失败若**没有**额外的判别字段（`done` /
`results[]` 之类），就是业务终态，必须回 `ok:false + error:{code:'bad-request', message:<原异常文案>}`。

⚠ 本端点**没有面板入口** —— 账号卡片上并没有「刷新」按钮，调用方是仓库外的
脚本/手工 RPC（issue IKJOZA 取证）。

⚠️ 同源产品（如 `buddyeu`）**还要一起看**「八处静默失效的接线」：
`provider-registry.ts` 的纯数据条目、`jet-hub-store.ts` 的 ref 前缀表、
`aggregate-adapter.ts` 的参与清单、`SELF_HEAL_REFRESHABLE_PROVIDERS` ——
少一处都是**编译全绿、功能静默少一块**。

### A4. 客户端侧

⚠️ **2026-10-08 起不再手抄能力表**：`plugin-src/client/credits-capabilities.js` 的
`CREDITS_CAPABILITIES` / `RATE_LIMIT_CAPABILITIES` / `ACCOUNT_TEST_CAPABILITIES` 全部
**从 `src/provider-registry.ts` 派生**。同源产品只需：

```typescript
// src/provider-registry.ts —— 纯数据，零 import
{ id: 'buddyeu', label: 'CodeBuddy (欧洲版)', /* … */ credits: { balance: true, dailyCheckin: true } }
```

⚠️ **id 必须纯小写字母**（不带连字符）：它同时是 cordis 服务名、LLM 路由名与客户端 key。
（`buddy-eu` 这种带连字符的 id 会派生出 `buddy-euAuth`，不符合 camelCase 惯例；
仓库里 `qodercn` 不带连字符就是这个原因。）

并在 `jet-hub.js` 的 provider 渲染逻辑中加入新 provider 的面板（如果它在 UI 上有独立面板的话）。

---

## 路径 B：添加不同源产品（全新脉系）

假设你要添加一个全新的 provider **`deepseekofficial`**（假设它有不同于现有协议的 API）。这是最完整的路径。
⚠️ **id 纯小写字母、不带连字符**（文件名可以带连字符，**id 不行** —— 它同时是
cordis 服务名 `${id}Auth`、LLM 路由名与客户端 key）。

### B0. 目录结构

```
src/
├── deepseek-official-product.ts    ← 产品配置常量（参考 lobsterai-product.ts）
├── deepseek-official.ts            ← 协议常量、凭据结构、纯函数（参考 lobsterai.ts）
├── deepseek-official-auth.ts       ← 认证服务（参考 lobsterai-auth.ts）
├── deepseek-official-adapter.ts    ← LLM 适配器（参考 lobsterai-adapter.ts）
├── deepseek-official-oauth.ts      ← 登录流程（参考 lobsterai-oauth.ts）
├── deepseek-official-credits.ts    ← 签到/积分（可选，参考 lobsterai-credits.ts）
├── deepseek-official-errors.ts     ← 错误分类（可选，参考 lobsterai-errors.ts）
```

### B1. 定义产品配置（`src/deepseek-official-product.ts`）

```typescript
import type { LobsteraiProduct } from './lobsterai-product.js'  // 或自建接口

export interface DeepseekOfficialProduct {
  id: 'deepseekofficial'   // provider 标识（⚠️ 纯小写字母，不带连字符）
  displayName: string
  apiBase: string           // API 基址
  portalBase?: string       // 登录门户（可选）
  userAgent: string
  defaultCredentialRef: string
  fallbackModels: readonly DeepseekOfficialFallbackModel[]
}

export const DEEPSEEK_OFFICIAL: DeepseekOfficialProduct = {
  id: 'deepseekofficial',
  displayName: 'DeepSeek Official',
  apiBase: 'https://api.deepseek.com',
  userAgent: 'DeepSeek/1.0.0',
  defaultCredentialRef: 'DEEPSEEK_OFFICIAL_ACCESS_TOKEN',
  fallbackModels: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128_000 },
  ],
}
```

**关键决策**：是否需要新建 `DeepseekOfficialProduct` 接口，还是可以复用 `LobsteraiProduct`？
- 如果新 provider 的 API 形态与 LobsterAI **非常相似**（如都是 Bearer 认证 + 无签名 + 无归属头），可以考虑复用 `LobsteraiProduct`（更名或泛化）
- 如果协议完全不同，**新建独立接口**更好（避免 `LobsteraiProduct` 里不需要的字段污染新 provider）

### B2. 协议常量与凭据（`src/deepseek-official.ts`）

```typescript
// 端点路径
export const DEEPSEEK_CHAT_PATH = '/v1/chat/completions'
export const DEEPSEEK_MODELS_PATH = '/v1/models'
export const DEEPSEEK_REFRESH_PATH = '/v1/auth/refresh'  // 如果有的话

// 请求超时
export const REQUEST_TIMEOUT_MS = 30_000

// ── 凭据结构 ──
export interface DeepseekOfficialCredential {
  access_token: string       // 与 AccountPool.findAccountIdByCredential 一致
  refresh_token?: string
  expires_at?: number        // ⚠️ **毫秒**（见「架构核心概念」§6）
  uid?: string
  nickname?: string
  // 其他必要字段（如 session_id、api_key 等）
}

// ── 过期判定 ──
export function credentialExpiresAtMs(cred): number | undefined { /* ... */ }
export function isExpired(cred): boolean { /* ... */ }
export function isRefreshable(cred): boolean { /* ... */ }

// ── 请求头构造 ──
export function authHeaders(cred, product): Record<string, string> { /* ... */ }
```

**规则**（照此检查你的实现）：
- 凭据结构必须含 `access_token` 字段 —— `AccountPool.findAccountIdByCredential` 对非 `codearts` 的 provider 统一取此字段作身份标识
- `expires_at` 统一存**毫秒**（数字或数字串都行，`credentialExpiresAtMs` 两种都认，且自带 `> 1e12` 的秒/毫秒判别）
- ⚠️ **归一化只在兑换 / 续期返回处做一次**，别在下游每处各乘一次（见「架构核心概念」§6）
- 纯函数（无网络副作用），可完整单测

### B3. 认证服务（`src/deepseek-official-auth.ts`）

继承 `cordis/Service`，以 `lobsterai-auth.ts` 为模板：

```typescript
export class DeepseekOfficialAuth extends Service {
  readonly product: DeepseekOfficialProduct
  readonly credentialRefName: string
  private readonly scheduler = new RefreshScheduler(/* ... */)

  constructor(ctx, options?) {
    const product = options.product ?? DEEPSEEK_OFFICIAL
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  // 必须实现的核心方法：
  async login(flowOptions?): Promise<LoginResult>
  async startLogin(flowOptions?): Promise<{ loginUrl, result, close }>  // 两步式
  async status(): Promise<LoginStatus>
  async refresh(): Promise<void>
  async refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>
  async refreshAll(pool: AccountPool): Promise<void>  // 批量续期
  async logout(): Promise<void>
  async fetchModels(pool?): Promise<RemoteModel[]>
  async scheduleRefresh(): void
  async checkExpired(): Promise<boolean>
}
```

**必须遵守的契约**：
| 方法 | 要求 |
|------|------|
| `refreshAll` | **既不按 `enabled` 过滤、也不按 `refreshable` 过滤**（两次真实缺陷；判据读**凭据本身**） |
| `startLogin` | 立即返回 `loginUrl`，后台异步 await 回调（见「两步式登录」） |
| `refreshAccountCredential` | 读写指定的 ref，不碰默认单凭据 ref；⚠️ **必须收 `pool` + `accountId`** 并回写 `expiresAt`，否则凭据续好了而 UI 永远显示「已过期」 |
| `login` / `startLogin` | 成功后必须调 `scheduleRefresh()` + `pool.addAccount()`（两步式先登记占位条目） |
| 续期并发 | 三条入口（定时器 / 推理按需 / 面板按钮）会**并发**消费同一份 `refresh_token` ⇒ 上 per-ref `SerialQueue`，且**锁内重读**凭据（仍在有效期内就直接对账返回，不烧第二次 token） |
| 判终态 | 被拒时**先重读磁盘上的凭据**：若已不等于本次用的那一份，那是「他处已续成功」，**不得**标死账号 |

### B4. LLM 适配器（`src/deepseek-official-adapter.ts`）

继承 `LlmAdapter`，以 `lobsterai-adapter.ts` 为模板：

```typescript
export class DeepseekOfficialAdapter extends LlmAdapter {
  private readonly product: DeepseekOfficialProduct

  // 必须实现的 4 个方法：
  providerInfo(provider: string): LlmProviderInfo
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModel(provider: string, model: string, signal?): Promise<LlmResolvedModelInfo>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>

  // 建议实现（兼容新版 DSH）：
  prepareCall(provider, model, signal?): Promise<{ model, stream }>
}
```

**4 个关键决策点**（参照 lobsterai-adapter 与 buddy-adapter 的对比）：

1. **`stream()` 是否恒为 true**？上游是否只支持 SSE？
2. **图片支持**：按模型判定（`remoteMeta.get(model)?.supportsImage`）还是按 provider 一刀切？
3. **思考等级（reasoning_effort）**：是否主动补档（如 buddy 的 deepseek 系必须补档否则不思考），还是只透传？
4. **`prompt_cache_key`**：上游是否支持前缀缓存？

这些问题**不能从代码推理，必须凭实测回答**。在实现文档中应标注 `TBD` 并安排 E2E 验证。

⚠️ **两条与「实测」直接相关的硬约束**（都踩过）：

- **图片通路未实测时，`inputModalities` 必须省略（= 未知），不能写 `['text']`** ——
  后者是把「未知」写成「**明确不支持**」（本仓库的静默失效格）。但省略之后 DSH 不会在
  附件准入阶段拦下图片，图片会走到 `stream()` ⇒ **适配器必须显式报错**
  （`LlmError(..., 'UNSUPPORTED_CONTENT')`），否则序列化层只会保留 text 块，
  图片被**静默丢掉**（用户以为模型看到了图）。
  ⚠️ 扫描必须**递归**（复用 `src/openai-compat.ts` 的 `collectImages`）：
  `tool-result` 块内嵌的图片只扫顶层 `message.content` 会**绕过守卫**。
- **`prepareCall` 必须包装，不是 `stream`**（PR !66）：harness 走的是 `prepareCall`，
  只改 `stream` 会得到「42 条用例全绿却完全测不到生产路径」。

**SSE 消费的共享工具**（`src/sse.ts`）：
- `readWithIdleTimeout` —— 带空闲超时的流读取（所有适配器共用）
- `resolveToolPairing` —— 孤儿工具调用清理（所有适配器共用）
- `normalizeToolArguments` —— 参数归一化（所有适配器共用）
- `isTruncatedArguments` —— 截断判定（所有适配器共用）

⚠️ **消费器「同族可复用」，但请求体构造不可照抄**（见「架构核心概念」§7）。
⚠️ **流内错误码不得被读成「成功但没内容」**：判成功要「有内容 **且** 无 `error_code`」，
否则认证失败会退化成「模型返回空内容」，而 harness **不会重试**。

### B5. 入口注册（`src/index.ts`）

```typescript
import { DEEPSEEK_OFFICIAL } from './deepseek-official-product.js'
import { DeepseekOfficialAuth } from './deepseek-official-auth.js'
import { registerDeepseekOfficialLlm } from './deepseek-official-adapter.js'

// 1. 注册 settings namespace
registerProviderSettings(ctx, 'llm-buddy', 'llm-workbuddy', 'llm-codearts', 'llm-lobsterai', 'llm-deepseekofficial')

// 2. 创建认证服务
const deepseekOfficial = new DeepseekOfficialAuth(ctx)

// 3. 注册 LLM 适配器
registerDeepseekOfficialLlm(ctx, {
  credentialRef: credentialRef(DEEPSEEK_OFFICIAL.defaultCredentialRef),
  resolveCredential: async () => {
    const available = await pool.getAvailableAccount(DEEPSEEK_OFFICIAL.id, '')
    if (available) return available.credential as DeepseekOfficialCredential
    // ... 回退到单凭据
  },
  refresh: async () => {
    // ... 先池后单凭据，与 lobsterai 同理
  },
  fetchRemoteModels: () => deepseekOfficial.fetchModels(pool),
  readImage: makeReadImage(ctx),
  accountPool: pool,
  product: DEEPSEEK_OFFICIAL,
})

// 4. 加入批量续期
async function refreshAllCredentials(): Promise<void> {
  // 现有...
  try { await deepseekOfficial.refreshAll(pool) } catch { }
}
```

**要点**：
- `settingsNs` = `llm-${product.id}` = `llm-deepseekofficial`
- 服务名由 Service 构造时自动派生为 `deepseekOfficialAuth`
- `registerDeepseekOfficialLlm` 最终调用 `ctx.llm.registerConfigurableProviders(...)` + `ctx.llm.registerAdapter(...)`，与现有 `registerBuddyLlm` / `registerLobsteraiLlm` 格式一致
- ⚠️ **续期表、`refreshAllCredentials` 的 try/catch、以及各处派生表都要一起看** ——
  漏一处是**静默失效**（见「八处静默失效的接线」）

### B6. 注册 RPC 分派（`src/jet-hub-rpc.ts`）

⚠️ **2026-10-08 起签名已改为「命名对象 + 按 id 查表」**，不再是逐个 auth 位置参数：

```typescript
// 1. 把新 auth 实例加进 JetHubAuths（键 = provider id，见 src/index.ts 的构造处）
//    ⚠️ 命名对象形参是**刻意的**：位置参数曾在「中国版 / 国际版」上错位复发 6 次
const auths: JetHubAuths = { codearts, buddy, workbuddy, lobsterai, …, deepseekOfficial }
registerJetHubRpc(ctx, pool, auths, modelAdapters)

// 2. account.create —— 加新分支（分派由 auths 查表，但**两步式登录**要显式写）
if (provider === 'deepseekofficial') {
  const started = await deepseekOfficial.startLogin({ refName, pool, accountId })
  // ... 占位条目 + 异步回调（若 auth 自己不登记占位条目）
}

// 3. account.refresh —— 不再逐个 case：统一走 authOf(auths, provider)
//    ⚠ 但**必须传 pool + entry.id**，否则 expiresAt 不回写账号池（issue IKIRTT，见 A3）

// 4. credits.* —— 加新分支（如有积分能力）
//    credits.status / credits.claimAll / credits.balances 各加一个分支
```

**要点**：

- 新 provider **不需要**改 `registerJetHubRpc` 的签名，只需加进 `auths`；
  但**必须**检查 §「八处静默失效的接线」里的每一处（尤其
  `SELF_HEAL_REFRESHABLE_PROVIDERS`）。
- 查表用 `authOf()` / `Object.hasOwn`，**不要用下标**（`table[id]` 会命中原型链上的键）。

### B7. 积分能力（`src/provider-registry.ts`）

⚠️ **2026-10-08 起不要在客户端手抄**：`plugin-src/client/credits-capabilities.js` 的
`CREDITS_CAPABILITIES` 是 `creditCapabilitiesOf()` 的派生结果，真相源是
`src/provider-registry.ts` 的 `credits` 字段：

```typescript
// src/provider-registry.ts —— 纯数据，零 import
{
  id: 'deepseekofficial',
  label: 'DeepSeek Official',
  credits: { balance: false, dailyCheckin: false },   // 新增
  // 另有 permanentLock / rateLimit / accountTest / creditPackages / usesExpiryWindow
}
```

**规则**：
- **默认关闭**：未登记的 provider 视为两项全无。忘登记时最坏结果是暂时看不到积分，而不是每次打开面板都发一个必然失败的请求
- 两个能力彼此独立，不能互相推断（`dailyCheckin` 是「每天有收益」，`onboardingTasks` 是「一次性」）
- 如果新增 provider 有积分能力，请在 `src/` 下按 `lobsterai-credits.ts` / `codearts-credits.ts` 的格式实现，并在 `src/provider-credits.ts` 里加它的分支
- ⚠️ **`rateLimit` 默认是 `true`**（与上面相反）：限流按钮是**既有 UI**，默认关闭会让老用户凭空失去按钮；只有「点下去零请求、零清除」的家才登记 `false`
- ⚠️ 字段注释里要写**依据**（为什么这一家是这个值）—— 那是后来人唯一能核对的线索

### B8. 模型黑名单（`AccountPool.disabledModelsFor`）

**不需额外操作**。`AccountPool` 的 `disabledModelsFor(provider)` 已按 provider 隔离，新 provider 的模型开关自动独立存储。

### B9. 单测与 E2E

| 测试 | 粒度 | 文件位置 |
|------|------|---------|
| 纯函数单测 | 验证 `credentialExpiresAtMs` / 请求头构造 / 信封解析 | `tests/unit/` |
| Auth 服务单测 | 登录 / 续期 / 状态 / 登出 | `tests/unit/` |
| 适配器单测 | 消息序列化 / SSE 解析 | `tests/unit/` |
| E2E 登录探针 | 打开浏览器 + 授权 + 验证 exchange | `tests/e2e/`（**默认跳过，需 DSH_*_E2E 环境变量**） |
| E2E 模型列表 | 远端模型目录 | `tests/e2e/` |
| E2E 签到探针 | 积分领取流程（可选） | `tests/e2e/` |

⚠️ **会花额度 / 会轮换凭据的探针必须上双闸门**（accio 的四个探针是范例，
清单见 `tests/e2e/README.md`）：`DSH_<X>_E2E=1` + `DSH_<X>_E2E_CONFIRM=yes`，
且**判「成功」不能只看 HTTP 200**（本仓库多次栽在「200 + 流内错误码」上：
`content.parts[].text` 有 **且** 没有非 `'200'` 的 `error_code` 才算通过）。

⚠️ **测试里的源码级断言一律「先切片、再断言」**，且并列断言要用**计数**
（`indexOf` 参与比较前必须先断言 `>= 0`）。

### B10. 文档

- 修改 `src/product.ts`（或新 product 文件）的 module header，记录新 provider 的数据来源与关键决策
- 在项目 `README.md` 的「支持的渠道」表加一行，并在「各渠道的能力与限制要点」里补该渠道的**用户可见**要点
  ⚠️ **README 只写「怎么用」** —— 协议、端点、请求头、逆向结论、实测矩阵一律进
  `docs/implementation-notes.md` / `docs/agent-notes/providers-<id>.md`，**不进 README**
- ⚠️ **README 里不得写「尚未实现的功能」为已实现**：没有落地入口的能力要么不写，
  要么如实写「尚未实现」+ 今天可用的替代路径（accio 的「刷新每日额度」就是这么处理的）
- 如有特殊坑点（如 LobsterAI 的 `X-LobsterAI-Client-Capabilities` 头），在 AGENTS.md 中记录
- ⚠️ **在 `AGENTS.md` 的「深细节索引」里更新该 provider 那一行**（不是新加一行）——
  它是一句话浓缩，实现阶段推翻设计阶段的结论**必须回写**，否则索引本身成了误导

---

## 通用检查清单

无论路径 A 还是路径 B，添加完成后对照以下清单自检：

### 编译构建

- [ ] `pnpm typecheck`（TypeScript 类型检查）通过
- [ ] `pnpm build:all`（tsc + esbuild 客户端打包）通过

### `src/index.ts` 

- [ ] settingsNs 已注册（`registerProviderSettings` 调用中加入了新 namespace）
- [ ] 认证服务已创建（`new SomethingAuth(ctx)`）
- [ ] LLM 适配器已注册（`registerSomethingLlm(ctx, ...)`）
- [ ] 批量续期已加入（`refreshAllCredentials` 中的 try/catch）
- [ ] Jet Hub RPC 已传入（`registerJetHubRpc` 参数）
- [ ] `ctx.effect` 的 cleanup 包含新服务的 `stop()`

### 续期与账号池

- [ ] `refreshAll()` **既不按 `enabled` 过滤、也不按 `refreshable` 过滤**（两次真实缺陷的教训，见「架构核心概念」§3）
- [ ] `refreshAccountCredential(refName, pool, accountId)` 读写指定 ref，不碰默认单凭据 ref（否则 Jet Hub 续期刷错凭据）
- [ ] `getAvailableAccount` 调用时传入 `this.product.id`（而不是写死字面量；WorkBuddy 踩过坑）
- [ ] ⚠️ 过期时间戳**在兑换 / 续期返回处归一化一次**，带 `> 1e12` 防御分支（见「架构核心概念」§6），且反向验证过（去掉归一化 ⇒ 用例变红）

### ⚠️ 八处**静默失效**的接线（漏一处日志零字、编译全绿）

这几处的共同形态是「**编译全绿、运行全绿、功能静默少一块**」，必须逐处确认
（每一处都有点名用例守着，但**用例只守已登记的集合**，新增 provider 时先看这里）。
⚠️ **下面恰好 8 条**（本节标题与条数必须一致：原文写「五处」而实际列了 8 条，
是**必然腐坏**的快照 —— 加一条就失配。改动本节时**标题与条数一起改**）：

- [ ] `src/provider-registry.ts` 加了该 provider 的**纯数据**条目（id 一律**纯小写字母**，不带连字符 —— 它同时是 cordis 服务名、LLM 路由名与客户端 key）
- [ ] `src/provider-runtime.ts` 的 `apply()` 里经 `registerProviderRuntime` 注册了**实现**（`auth` / `credits` / `onboarding` / `expiry` / `probe`）
- [ ] ⚠️⚠️ `src/jet-hub-rpc.ts` 的 **`SELF_HEAL_REFRESHABLE_PROVIDERS`** 里有它 —— **除非**该 provider 设计上**没有 refresh 端点**（如 `loomy` / `zcode`），那种情况要在 `tests/unit/credits-balance-self-heal.spec.ts` 的**显式豁免表**（`SELF_HEAL_EXEMPT`，必须带可核对理由）里写明。
  **漏登记的后果**：积分行报「未登录」而上游其实只需一次 refresh（issue IKKHL5 的形态），**日志零字**。
  ⚠️ 该守卫原本**只有正向**（挡住假 id），反向缺失 ⇒ accio 就是这么漏掉的；现已补反向用例（逐键点名 + 显式豁免表），漏登记会**点名变红**。
- [ ] `src/jet-hub-store.ts` 的**凭据 ref 前缀表**里有它（漏加 ⇒ `state.json` 缺失时该 provider 的账号**静默消失**；这是第四次踩同款坑）
- [ ] `src/aggregate-adapter.ts` 的参与渠道清单里有它（漏加 ⇒ 聚合里**选不到**它的模型，静默）
- [ ] `src/provider-credits.ts` 有它的积分分支（漏加 ⇒ 客户端仍会发请求，而宿主回 `bad-request`）
- [ ] `rateLimit: false` 只在「**重测 / 重置两个按钮点下去零请求、零清除**」时才登记（判据：这个按钮能不能让用户**少**受限一次？答否即 `false`）。写标记的 provider 则必须**同时**进 `probeById` 与 `WRITES_RATE_LIMIT_PROVIDERS`，否则标记清不掉
- [ ] ⚠️ **`registerProviderRuntime` 的派生表必须是函数、不能是模块级常量**（注册发生在 `apply()` 里；常量会在模块加载时求值 ⇒ 恒为空表 ⇒ 所有 provider 都不再自动续期，**症状静默**）

### 两步式登录

- [ ] `account.create` 分支立即返回 `loginUrl`（不阻塞等待授权完成）
- [ ] 先登记**占位账号条目**（无凭据），使前端 `login.poll` 能检测到
- [ ] 异步回调完成后再回填真实凭据
- [ ] 异步回调失败时**删除占位条目**（不留幽灵账号）
- [ ] 前端**没有** `window.location.href = loginUrl` 作为兜底（弹窗被拦截时应展示可点击链接）
- [ ] ⚠️ 打开浏览器用 `rundll32 url.dll,FileProtocolHandler`（**不是** `cmd /c start`），并有源码级回归锁（见「架构核心概念」§5）

### `jet-hub-rpc.ts`

- [ ] `account.create` 有该 provider 的分支
- [ ] `account.refresh` 的 switch 有该 provider 的 case，且**每个 case 都传了 `pool` 与 `entry.id`**
- [ ] `account.refresh` 的 catch 回 `ok:false + error`，不是 `ok:true + value.success:false`（issue IKJOZA）
- [ ] `credits.*` 各端点有该 provider 的分支（如果它有积分能力的话）
- [ ] 没有写死字面量（如 `LOBSTERAI.id` 代替 `'lobsterai'`）

### 客户端

- [ ] `credits-capabilities.js` 已登记新 provider 的能力（两项能力彼此独立）
- [ ] 提供 `balance` 时实现 `fetchCreditBalance` 函数
- [ ] 提供 `dailyCheckin` 时实现 `claimDailyCheckin` 函数
- [ ] 没有时写 `false`（默认关闭）
- [ ] ⚠️ 该文件的**能力表与限流表都从 `src/provider-registry.ts` 派生**，不要在客户端手抄第二份
- [ ] ⚠️ 若新增**客户端选择项**（如登录渠道 / 区域下拉）：**同时**改 `new-account.js` 的 `newAccountAsksChannel`（白名单 `PROVIDERS_ASKING_OPTIONS`）与 `buildCreateAccountPayload`（排除法）—— **两处判据方向相反**，只改一处会得到「选择被静默丢弃」或「后端拿到不认的值」。⚠️ 还要把新字段加进 `tests/unit/new-account-dialog.spec.ts` 的 `EXCLUSIVE_FIELDS`（**第三处**，漏了它不变式会退化成只查旧字段）。两个既有范例：zcode 的**登录渠道**（`zcodeProvider`）、accio 的**登录区域**（`accioRegion`，见 `docs/agent-notes/providers-accio.md` §8）
- [ ] ⚠️ 注入 `<style>` 必须署名 `data-plugin`；`jet-hub-styles.js` 的 `STYLES` 是模板字符串，**CSS 注释内绝不能出现反引号**（会提前闭合模板，报错指向注释那一行，看着像 CSS 写错）

### 凭据结构

- [ ] 非 `codearts` 的 provider 凭据含 `access_token` 字段（`AccountPool.findAccountIdByCredential` 的匹配依据）
- [ ] `expires_at` 统一存**毫秒**时间戳（复用 `credentialExpiresAtMs` 的解析逻辑）
- [ ] ⚠️ 上游若给的是**秒**：归一化只在**兑换 / 续期返回处做一次**（见「架构核心概念」§6），别在下游每处各乘一次
- [ ] 续期请求体所需的特殊字段（如 LobsterAI 的 `firstKeyfrom` / `latestKeyfrom` / `uuid`）在凭据中持久化，不每次重新生成
- [ ] 续期时**铺开旧凭据**（`{ ...credential, access_token, refresh_token, expires_at }`）：不参与续期的字段（`region` / `user_id` 等）必须原样保留，丢了 `region` 会选错登录域
- [ ] 身份字段若在 `IDENTITY_FIELDS` 候选表之外（`user_id` / `uid` / `userid` / `account_id` / `access_key_id` / `sub`），要在 `src/backup.ts` 的 `identityKey` 里单独认它 —— 否则「同一个号我已手登过」会**必然**多一条重复账号
  ⚠️ 但**轮换令牌（`access_token` / `refresh_token`）绝不能当身份**：它们每次续期都会变

### 其他

- [ ] 如果没有签到功能：`credits.status` 如实返回 `null`（不是返回假的状态对象），且**面板不渲染任何点不动的控件**
- [ ] ⚠️ **没有可落地的入口就不要渲染按钮**：accio 的「刷新每日额度」需要宿主侧新增「重新登录**既有**账号」的 RPC，在那之前面板**刻意不渲染**该按钮，只写明今天真的可用的手动路径（删号重登）。
  反例：接到 `account.create`（那会**新造**账号 id 与凭据 ref ⇒ 幽灵账号，而原账号额度一点没刷新）、接到 `credits.claim`（`dailyCheckin` 是 `false`）
- [ ] 如果凭据结构包含签名参数/额外身份字段：确认续期后这些字段是否被正确保留
- [ ] 模型列表远端可用时完全采信远端（不做 Buddy 那样的「以兜底表为准」裁剪）
- [ ] 单元测试覆盖：过期判定、请求头构造、消息序列化、SSE 解析
- [ ] ⚠️ 写对照矩阵验证协议时**必须检查每个变量是否真的独立** —— 把某个赋值写在**公共路径**上会让**所有格子共享它**，「四格都成功」≠「四个变量都被验证」（accio 的 `sgcookie` 就这么被漏掉过一轮，补做的干净对照才证明它也不必需）
- [ ] ⚠️ 源码级断言**必须先切片再断言**（整份源码 `toContain` 会被注释/文件头满足 ⇒ 删掉目标代码照样全绿），且 `indexOf` 参与比较前先断言 `>= 0`
- [ ] ⚠️ 关键防回退必须做**反向验证**（临时注入变异 ⇒ 用例必须变红），否则可能写出一组恒真的同义反复
- [ ] AGENTS.md 已更新：**「深细节索引」里那一行要回写实现阶段推翻设计的结论**（不是新加一行），新 provider 行为与特有协议的注意事项一并记录
- [ ] ⚠️ 协议实测结论进 `docs/agent-notes/providers-<id>.md`；**README 只写「怎么用」**，
  且**不得**把未实现的功能写成已实现

---

## 附录：文件参考索引

| 你需要的实现 | 参考源文件（同源产品） | 参考源文件（不同源产品） |
|-------------|----------------------|------------------------|
| 产品配置接口 | `src/product.ts` → `BuddyProduct` | `src/lobsterai-product.ts` → `LobsteraiProduct` |
| 产品配置常量 | `src/product.ts` → `CODEBUDDY` / `WORKBUDDY` | `src/lobsterai-product.ts` → `LOBSTERAI` |
| 协议常量与凭据 | `src/buddy.ts` | `src/lobsterai.ts` |
| 认证服务 | `src/buddy-auth.ts` (Service) | `src/lobsterai-auth.ts` (Service) |
| LLM 适配器 | `src/buddy-adapter.ts` | `src/lobsterai-adapter.ts` |
| OAuth 登录 | `src/buddy-oauth.ts` | `src/lobsterai-oauth.ts` |
| 错误分类 | —（同源共用 buddy-adapter） | `src/lobsterai-errors.ts` |
| 积分签到你 | `src/credits.ts` | `src/lobsterai-credits.ts` |
| 注册入口 | `src/index.ts`（buddy/workbuddy 实例） | `src/index.ts`（lobsterai 实例） |
| RPC 分派 | `src/jet-hub-rpc.ts` | `src/jet-hub-rpc.ts` |
| 客户端能力矩阵 | `plugin-src/client/credits-capabilities.js` | 同上 |
| 最新完整范例（含客户端专属面板） | — | `src/accio-*.ts` + `plugin-src/client/jet-hub.js` 的 `AccioDailyPanel` |
| SSE 共用工具 | `src/sse.ts` | 同上 |
| 刷新调度器 | `src/refresh.ts` | 同上 |
| 账号池 | `src/account-pool.ts` | 同上 |
| 账号探测 | `src/account-probe.ts` | 同上 |
| 客户端构建 | `plugin-src/client/build.mjs` | 同上 |
