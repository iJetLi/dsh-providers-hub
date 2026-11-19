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

## 11. 真机取证（2026-11-19，两站都跑通）

⚠️ **这份是唯一的事实源**，别再按印象改这几处。取证方式：`harvestAgnescodeLocalSession`
读本机真会话 → 用我们自己的模块直接打三个端点（脚本已删，勿把 token 写进仓库）。

### 11.1 目录 `/v2/models` 的真实字段（两站并集）

`allowed_subscription, auto_compact_threshold, created, description, display_label,
gray_available, id, is_gray, max_input_tokens, max_output_tokens, model_type, object,
owned_by, provider, supported_endpoint_types, points_cost_multiplier, thinking_toggle`

实测值（国内站 8 行 / 国际站 12 行）：

- `points_cost_multiplier`：`0`（`agnes-3.0-flash` / `2.5-flash`）/ `0.3` / `1` / `1.5` /
  `2.2` / `6`（`kimi-k3`）/ `7.5` / `25`（`gpt-6-astra`）；`auto` 行**没有**该字段。
- `allowed_subscription`：`agnes-*` 是 `[]`，其余是 `["Starter","Plus","Pro"]`。
- `thinking_toggle`：`{default_enabled:true, switchable_endpoints:["chat"]}`（`glm-5.3` 没有）。
- `display_label`：只有 `deepseek-v4.1-flash` 是 `"限时优惠"`，其余空串（与参考实现的
  「空串必须当**没有**徽标」同判）。
- `max_input_tokens` / `max_output_tokens` 全部为正整数（`512000/65536`、`1000000/393216`、
  `1048576/131072` …）。

### 11.2 三个已修的真缺陷

- ⚠️⚠️ **403 `subscription_required` 被当成「认证失败」**（真机：免费档请求
  `deepseek-v4.1-flash` 回 `403 {"code":"subscription_required","message":"该模型需要更高权益
  解锁，请升级订阅后使用。"}`）。旧实现 `kindOfStatus(403) === 'auth'` ⇒ ①白轮整池
  （同一订阅档每个账号都一样）；②错误尾部挂「会话可能已过期，请重新登录」——
  **一条必然无效的指路**（本仓红线：文案本身就是出路时不能给错）。现在 403 先判报文，
  权益类归 `entitlement`：**不换号**、`code` 用 `PERMISSION`（宿主会把 `AUTH` 的报文整条
  换成「API 密钥无效」，Issue IKLBSH 同型）、「重新登录」这句只在真·认证失败时出现。
- ⚠️ **429 `daily_requests limit exceeded` 只冷却 60 秒**（真机：免费模型
  `agnes-3.0-flash`）。日墙要等次日 0 点，按 60s 标记等于每分钟劝用户重撞同一面墙。
  现在报文命中 `daily…limit` ⇒ 冷却到**次日 UTC+8 0 点**（与 `loomyCooldownResetAtMs` /
  qoder 当日标记同口径）；上游若同时给 `retry-after`，取两者更大的。⚠️「次日 0 点」是
  **推断**（上游只说 daily，不给 reset 时间戳）—— 比 60s 真实、比 24h 精确，已在代码里
  如实标注。
- ⚠️ **计费倍率完全没展示**（真机确有 `points_cost_multiplier`，最高 25×）：本仓选择器
  没有价格通道，而 `kimi-k3`(6×) 与 `gpt-6-astra`(25×) 在列表里看起来与 1× 无差别。
  现在按参考实现与全仓既有约定把倍率写进 `name`（` · x6.00`；`x0.00` = 免费，**缺字段才
  不加后缀**），`multiplier === 0` 同时产 `isFree`（Jet Hub 免费桶只认它），
  `allowed_subscription` 非空则写进 `description`（「需要 Starter / Plus / Pro 订阅；
  免费档请求会被上游 403」）。三条判据集中在 `agnescode-product.ts`、远端与兜底共用
  `toCatalogEntry()` 一份实现。
- ⚠️ **`listAllModels()` 自己摊目录时丢了 `isFree`**：骨架的 `listAllModels()` 是
  `{id, name, isFree?}`，我们那份覆写只返回 `{id,name}` ⇒ 免费桶永远空。现在直接委托
  给骨架（语义相同：骨架的 `cached` 就是本适配器 `loadCatalog()` 的产物）。
- 两站共用一个 `AgnescodeAuth` 类，而日志 tag 与 `refresh()` 文案都写死 `agnescode`
  ⇒ 国际站的诊断行挂错名（与适配器里已修的同一类）。现全部走 `product.id` / `displayName`。

### 11.3 工具调用与用量（同样真机验证过）

- **工具调用是通的**：真机 `agnes-2.5-pro` + `get_time` 返回
  `{"choices":[{"delta":{"tool_calls":[{"id":"call_…","type":"function","index":0,
  "function":{"name":"get_time","arguments":""}}]}}]}`，参数分两片（`"{"`、`"}"`）合并，
  末帧 `finish_reason:"tool_calls"`。经**我们自己的适配器**再跑一遍，块序列是
  `reasoning-delta ×6 → text-delta → tool-call-delta ×3(args 合成为 {}) → block-end → finish{tool-calls}`
  ⇒ `options.tools` → `buildAgnescodeTools` → SSE 合并这条链完整（`44 条`用例里专门锁了这条）。
- **`tools: []` 不会挂**（真机 200，模型正常回答）⇒「tools 恒带」这条约定可以继续。
- ⚠️⚠️ **`stream_options.include_usage` 是必须的，而且原实现没发**（已修）：
  不传这个字段，上游整条流里**一帧 `usage` 都没有**（实测 10 帧全无）⇒ 令牌台账
  永远空转（面板上「本步用量」恒空，用户以为插件不记账）。传了之后末帧回
  `{"usage":{"completion_tokens":29,"prompt_tokens":350,"total_tokens":379,
  "completion_tokens_details":{"reasoning_tokens":14,"text_tokens":15}}}`，
  适配器随即产出 `usage {inputTokens:98, outputTokens:30, cacheReadTokens:256, reasoningTokens:15}`
  （`inputTokens` 已按共享口径扣掉缓存命中部分）。**国内站与国际站都实测 200 + 有 usage 帧**。
  ⚠️ 免费模型（`agnes-3.0-flash`）今天撞了日限额 429，**没能**验证它对 `stream_options`
  的接受度 —— 但同网关同协议，且 OpenAI 标准字段，先按「两站付费站已验证」推进。
- **目录 `supported_endpoint_types` 恒 `["openai"]`**（CN 8 行全部如此，`model_type` 也恒
  `"text"`）⇒ 不做该字段的门控（没有一条反例，加了就是永不触发的死代码）；`model_type !== 'text'`
  的过滤保留（那是既有事实）。

### 11.4 实测过但**刻意不做**的

- **思考档位**：真机证明 BFF **接受 `reasoning_effort`**（`2.5-pro` 的 `low`/`medium` 均 200
  且返回 `reasoning_content`），`thinking_toggle` 也证明模型有开关。但仍**不声明**，理由三条：
  ① 档位是**按模型**的 —— `2.5-pro` 对 `high` 回 400（「Supported types are xhigh (default),
  medium, and low」），而目录**不告诉**我们每个模型的梯子；
  ② `xhigh` 今天**实测 500**（`'NoneType' object has no attribute '__aiter__'`，上游 bug），
  而参考实现把 `2.5-pro` 的 `high` 别名到 `xhigh` ⇒ 照抄就会把「默认档」打成 500；
  ③ 我们自己的 wire 形态（字段名 `reasoning_effort` + 哪个值）在**本仓代码路径**上未验过
  （只验过「上游接受」）。⇒ 维持 `PROVIDERS_WITHOUT_REASONING`，等有逐模型梯子的来源再说。
  附注：默认（不传该字段）**思考是开着的**，`reasoning-delta` 能正常流出（真机端到端跑过，
  块序列 `reasoning-delta ×6 + text-delta ×1`）。
- **`display_label` → 徽标**：`"限时优惠"` 是上游文案（比 TRAE 那种「只有数字」好办），
  但现有徽标通道是 `model-promotions.ts` 的**按时间窗现算**体系（issue #101 的定案是
  「在 `toCatalogEntry` 现算、条目只存未决候选表」），而这里是一个**静态行字段**。
  硬塞进去会绕开那套窗口纪律（也不清楚「限时优惠」何时失效）。已登记为候选，不在本 PR。
- `memberOnly` 模型**不从目录摘掉**（参考实现同口径：门控是账号状态，不是模型事实），
  只在 `description` 上说清楚；请求撞门控时由上面的 `entitlement` 分类给出可执行文案。

