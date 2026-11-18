# AgnesCode（`agnescode` / `agnescodeintl`，2026-11-19，issue #125）

> ⚠️ 先分清两条腿：本家接的是 **AgnesCode 桌面客户端的 BFF**（`api-agnes-code.agnes-ai.cn`
> / `api-agnes-code.agnes-ai.com`），**不是** `api.agnes-ai.cn` 那个 OpenAI 兼容的
> 「AgnesAI API」产品。后者与本案协议、凭据来源、余额口径**全都不同**。

## 1. 凭据来源：读 Windows 桌面客户端的登录态（不是扫码、不是 API Key）

- 目录：`%APPDATA%\AgnesCode`；文件名家族 `^code-auth-session[^/\\]*\.v1$`
  （国内 `code-auth-session.cn.v1`、国际 `code-auth-session.v1`），兄弟文件 `Local State`。
- `Local State` 的 `os_crypt.encrypted_key` = base64(`"DPAPI"` + 密文)；
  DPAPI（`CryptUnprotectData`）解开后是 **32 字节 AES key**。
- 会话 blob = `v10` 前缀 + AES-256-GCM（12B nonce、尾 16B tag）。
- 解密后 JSON 含 `accessToken`（约 28 天 JWT）、`userInfo.{id,username}`、
  以及 **`bffPublicBaseUrl`**。
- ⚠️⚠️ **`bffPublicBaseUrl` 每账号下发、绝不硬编码**；且必须先钉扎 `https` +
  `*.agnes-ai.cn` / `*.agnes-ai.com` 的**域名边界**（`trustAgnescodeBffBase`），
  才允许往上挂 `Authorization` —— 否则一个被改写的会话文件就能把 token 送到任意主机。
  实测反例：`api.agnes-ai.cn.evil.example` 必须被拒。
- ⚠️ DPAPI 解密走 `powershell.exe -NoProfile -NonInteractive` 子进程，**必须剥掉
  `AGNESCODE_ACCESS_TOKEN` / `AGNESCODE_CREDENTIAL` 环境变量**（那是我们自己给
  e2e 用的注入口，不能泄漏给子进程）。
- 非 Windows ⇒ 如实报 `UNSUPPORTED_PLATFORM`，**不要**假装登录。

## 2. 三个端点（形态各不相同）

| 用途 | 请求 | 要点 |
|---|---|---|
| 目录 | `GET {apiRoot}/v2/models` | 必须带 `X-App-Id: 1` + `X-Platform: 1`；**`/v1/models` 是另一个目录**（无倍率、不按账号裁剪）；`data` 是**数组**（不套信封）；`auto` 是路由别名要剔除；`model_type` 非 `text` 的条目（图/视频种子）也要剔除 |
| 余额 | `GET {apiRoot}/api/v2/subscription/credits-balance` | **不在 `/v1` 下**；信封 `code` 是**字符串** `"000000"`（不是 0）；字段 `total_balance` / `time_sensitive_balance` / `permanent_balance` |
| 推理 | `POST {bffBase}/chat/completions` | 纯 OpenAI 兼容；`stream:true` 恒真 |

## 3. 目录**完全账号级下发**，且**刻意没有静态兜底表**

- 依据本仓红线「静态兜底表必然腐坏」（Qoder 那次：上游改了倍率/改名，表没跟上，
  界面长期显示错价）。
- 因此 `AGNESCODE_FALLBACK_MODELS = []` 是**刻意的空表**，不是漏配。
- ⚠️⚠️ **代价（如实登记，不是已解决）**：
  - `listAllModels()` 是**同步**方法 ⇒ 冷缓存（从未调过 `listModels`）结构上只能为空；
  - `model-catalog-parity.spec.ts` 的「冷缓存非空」那一格对这两家**改判据豁免**
    （仍断言返回数组、且随后的 `listModels` 必须非空），理由写在用例里；
  - 新装 / 未登录 / 登录后首轮预热前的窗口里，设置页可能读到 `total = 0`
    ⇒ 显示「未关闭」而不是「已关闭」（`closed` 判据要求 `total > 0`），不会误伤开关。
- `refresh-targets-derived.spec.ts` ⑧ 的 `NO_ACCOUNT_SCOPED_CATALOG` 豁免是**同一个原因**
  （`provider.status` 对它们报 `total=0`）。两处豁免必须一起读。

## 4. 余额 → 积分（`agnescode-credits.ts`）

- 只映射**两个桶**：`permanent_balance`（永久）、`time_sensitive_balance`（限时）。
- ⚠️ **限时桶必须置 `expiryUnknown: true`**：接口**没有任何逐笔日期**，
  而「到期未知」渲染成「永久」会废掉临期桶的救命功能（红线 IKTLMX）。
  **也不许反推日期**（「剩余/100 = N 天」只在每天都领时成立）。
- `used: 0` / `expiredTotal: 0` / `totalKnown: false` —— 本家不报「已用」。
- **无签到**（`claim` 刻意不接）。

## 5. 两站 = 两个 provider id

- 账池不互通、域名族不同 ⇒ `agnescode` / `agnescodeintl` 各一个 id，
  实现 100% 共用，只在 `AgnescodeProduct` 上分叉（会话文件名 / 域名族 / fallback base）。
- ⚠️ 折算、探针、ref 前缀、`WRITES_RATE_LIMIT_PROVIDERS`、`SELF_HEAL` 表**每处都要两站到位**，
  漏一处静默失效（本仓已复发 7 次的坑）。

## 6. 临期折算

- `agnescodeExpiry` 走 `sharedPackageExpiry`：有 `active && remaining > 0` 的包 ⇒ `NEVER`，
  否则 `UNUSABLE`；`balance: null`（查不到）⇒ `UNUSABLE`。
- ⚠️ 三处必须同改：`WIRED_EXPIRY_PROVIDERS` + `createProviderExpiry()` + `AGGREGATE_CHANNELS`
  （只改后者的症状：模型进得来、候选层被静默剔掉，用户在聚合轮换里永远看不到它）。

## 7. 思考档位

- 目录条目**没有任何档位字段** ⇒ 两站都登记进 `PROVIDERS_WITHOUT_REASONING`，
  否则面板会对用户承诺一个不会发生的「默认最强档」。

## 8. 已登记未做

- 扫码设备码 + 本地回环回调（跨平台登录，参考实现有 `docs/AGNESCODE-SCAN-LOGIN.md`）：
  **未进本 PR**。当前 `account.create` 只做 Windows 本地导入。
- 图标：先用自制占位（圆角 `#0F766E` + 白「A」base64），官方 SVG 暂无来源
  （网页端根路径实测 403 维护页）。

## 9. 提交前自查（2026-11-19，PR #128 审核轮）

全部**已修并各带一条行为级用例**；每条都做过「删掉该腿」的反向变异（有牙，变异锚点先自证命中）：

- ⚠️⚠️ **目录预热会无限自激**（最严重的一条）：`catalog()` 拉不到远端时回落到
  `syncCatalogEntries()`，而后者又触发 `warmCatalog()` ⇒「预热 → catalog → 失败 → 再预热」
  每轮一次 HTTP、永不停止。凭据过期时等于拿插件当压测工具打上游，而用户只看到面板卡。
  修法三条：① `catalog()` 失败直接返回兜底表（不再回落到会触发预热的那条路径）；
  ② `warming` 反重入；③ `lastWarmAt` / `lastCatalogFailAt` 共用一个 60s 窗口
  （失败也节流 —— 否则 `listAllModels()` 这种同步接口每次调用都会重打一次）。
- ⚠️ **推理腿没走注入的 `fetchImpl`**：选项注释写着「目录 / 余额 / 推理共用」，实现里
  只有目录用过它（注释与实现不一致是本仓红线；副作用是推理路径在单测里无法拦截）。
- ⚠️ **「等响应头」这一段没有超时**：`fetchTimeoutMs` 只喂给 `consumeOpenAiSse` 的
  `firstTokenTimeoutMs`，那是**拿到头之后**的空闲超时 ⇒ 网关卡在排队时只能吃 undici 默认
  （约 300s，magicrew 的同型修法）。现改成独立 `AbortController` 只管等头、拿到头
  `clearTimeout`，绝不可误杀后面的长回答。
- ⚠️ **目录数值域放行了 0**：`max_input_tokens: 0` 会产出 `contextWindow: 0`，而
  `resolveModel` 与 `model-catalog-parity` 都按 `> 0` 判 ⇒ 同一份数据两套口径。
  现在 `0` / 负数一律视为「未声明」。
- ⚠️ **余额放行了负数**：会直接进 `CreditPackage.remaining`，卡片显示「-5 积分」。
  现在负值让整份读数作废（`null`，不是 0）。
- ⚠️ **`retry-after: 0` 会让 `LlmError` 构造自己抛校验错**（`providerRetryAfterMs` 被校验为
  `> 0`）⇒ 一个正常的 429 被变成与真因无关的崩溃。现在 `<= 0` 不发该字段。
- ⚠️ **带图请求原先在池循环内部拒**：`failureInfoOf` 对无 `status` 的错误归 `transport`
  ⇒ 白轮一遍池子才抛同一句「不支持图片」。现提到进循环之前。
- ⚠️ **新建账号的 `expiresAt` 恒 `undefined`**：`account.create` 读的是
  `imported.credential.expires_at`，而采集路径**从不写**该字段（只有 access_token /
  bff_base / user_id / nickname）⇒ 到期信息要等首轮 `refreshAll()` 才有。
  现改用 `agnescodeExpiryMs()`（回落 JWT `exp`）。
- ⚠️ **`saveCredential` 静默不落库**：插件停用时它 `return`，而 `account.create` 接着
  `updateAccount` 并报成功 ⇒ 池里留下「有账号、没凭据」的幽灵卡。现在它回 `boolean`，
  RPC 侧判 `false` 就清掉占位条目并抛可读错。
- 日志/错误前缀写死 `agnescode`：两站共用一个工厂，国际站的诊断行挂错名（改用 `product.id`；
  `consumeOpenAiSse` 的 `label` 同步改）。
- `importLocal()` 里诊断档位写死 `'untrusted_base'` 字面量（同文件已有
  `AGNESCODE_HARVEST_TIER`）⇒ 改用常量。

## 10. 第二轮自查（2026-11-19 续，对照参考实现逐条比对）

上一轮的 7 项之外，又与参考实现 `dsh-connect-agnes-token-plan/src/host/agnescode.ts`
逐条比对 + 顺着 `account.create` / 探测 / 流内错误三条腿重读，再修 4 项。

- ⚠️⚠️ **凭据钉扎缺「非默认端口」判据**（安全）：参考实现明写
  「A non-default port is never part of the account's real base; keeping it would
  let a hostile session file aim the token at any port on an Agnes host（一个同域的
  冒名监听器）」。域名判据对此**完全无感**：`https://api-agnes-code.agnes-ai.cn:8443`
  的 host 一样匹配。⇒ `url.port !== ''` 直接拒绝（显式写 `:443` 由 `URL` 规范化成默认
  端口，天然放行）。
- ⚠️ **`FORMAT_DRIFT` 档位是死代码**（定义了从不产出）：严格模式零命中但
  `code-auth-session*` 家族文件存在（桌面端改了后缀 / 换了命名）时报 `file_missing`
  ⇒ 用户被引导去重装桌面端，而真正该做的是等适配 / 报版本。现按
  `AGNESCODE_SESSION_FAMILY_PATTERN` 区分 `format_drift`（detail 只列文件名，不读内容）。
- ⚠️⚠️ **同一枚桌面会话重复导入会攒重复卡片**（真实可复现）：`account.create` 每次
  生成新 id + 新 ref，而本机导入读**同一份** `code-auth-session*.v1` ⇒ 连点两次得到
  两张指向同一账号的卡（推理轮换当两个槽、「换号」换到同一枚 token、积分画两遍）。
  现加 `findAgnescodeAccountDuplicate()`：判据是 `user_id` 两边非空且相等，否则要求
  token **全等**；读不到 / 解析失败一律**跳过**（不猜）。命中则复用既有条目
  （写凭据到既有 ref → `updateAccount` → 清掉本次占位 → 返回既有 id + `reused:true`）。
  判重必须排在「写本次 ref」之前。
- ⚠️ **`reused` 语义被借用成「没新建」**：原先照 AStudio 写 `reused: true`，而前端
  `if (res.reused)` 提示「已复用本机已有的账号凭据，**未新建账号**」——可这条路径刚
  真建了一张卡 ⇒ 用户以为没建成又点一次，正好喂给上面那条重复卡缺陷。现新建路径
  `reused: false`（落到前端「已成功导入账号凭据。」）。**AStudio 分支同款问题刻意不动**
  （超 PR 范围，另开单）。
- ⚠️ `agnescode-product.ts` 的注释引用了**不存在**的字段（`provider-registry.ts` 的
  `requiresLogin`，全仓 grep 零命中）⇒ 改写为真实机制（`providerCatalogVisible()` +
  `DSH_HIDE_MODELS_WITHOUT_ACCOUNT`，默认开启。"注释必须与实际实现一致"是本仓红线）。
- ⚠️ **SSE 里的额度 / 上下文错误被归 `transport`**：流内错误**没有 HTTP `status`**，
  只看 status 会把它们一律当传输错误 ⇒ 额度类白轮一遍池子且**不写冷却**（下次照旧撞墙），
  上下文超限同样白轮（换号对同一请求根本无用），而宿主溢出压缩只认
  `CONTEXT_WINDOW_EXCEEDED` 这个码、唯一有效的动作被掩盖。现 `status === 0` 时读
  `failure.failure.code`（`CONTEXT_WINDOW_EXCEEDED` → `context_window`、
  `QUOTA_EXCEEDED` / `RATE_LIMIT` → `rate_limit`、`AUTH` → `auth`，其余仍 `transport`）。

- ⚠️ **探测路径对过期会话「答非所问」**：会话过期后三个端点都回 401，而目录端点把
  401 吞成空数组 ⇒ 用户点「重测」看到的是「**没有模型**」，而不是「会话已过期」。
  现在 `probeSlotOf`（**只在探测路径上**）先做本地过期预检（`agnescodeSessionExpired`：
  `expires_at` 优先、回落 JWT `exp`），过期就直接抛「请在本机重新登录桌面客户端后
  重新导入」。⚠️ **未知 ≠ 过期**：解不出有效期（非 JWT / 解析失败）一律不拦 ——
  那类只能靠真请求验（否则手工粘贴的 token 会被本地判据误杀）。
  ⚠️ 选槽路径**不做**这件事：过期凭据仍允许发一次请求（时钟漂移 / 上游放宽都可能
  让本地判据失真，误杀比多打一次 HTTP 贵得多）。

**查过但判定不改的**：跨站凭据串站（国内 provider 导入到国际版会话文件）——
参考实现同样只做排序不硬过滤（`agnescodeSessionBelongsTo` 只影响 rank），本仓
`product.ts` 的「文件顺序只决定先试哪个账号」与之自洽；`parseAgnescodeSession` 保持
token **verbatim**（参考实现 trim 只用于空判），JWT 无空白，实际等价。

**变异验证**：4 次「删掉该腿」全部变红（端口判据 / `format_drift` / 判重 / `code` 归类）；
其中两次因 CRLF + 缩进用字面量锚点报 `ANCHOR-MISSING`，换 `(?m)^\s*…` 正则锚点才命中
（`ANCHOR-MISSING` ≠ 无牙）。
