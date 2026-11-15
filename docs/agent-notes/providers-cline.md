<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠️ Cline provider：`workos:` 前缀不可剥、免费集合动态下发

`cline` 是**第六个脉系**（独立一套 `src/cline*.ts`）。协议全部由本机 Cline 桌面端
产物逆向 + 实测得出（2026-09-25）：

- 二进制 `C:\Users\Jet\AppData\Local\Cline\code-sidecar.exe`（bun 单文件，144 MB）
- 真实凭据 `C:\Users\Jet\.cline\data\settings\providers.json`
- 排查脚本（只读）：`scripts/probe-cline-endpoints.mjs`（按关键词提取二进制字符串
  窗口）、`probe-cline-models.mjs`、`probe-cline-recommended.mjs`、
  `probe-cline-balance.mjs`、`probe-cline-chat.mjs`
- 设计文档：`docs/superpowers/specs/2026-09-25-cline-provider-design.md`

### ⚠️ 坑 1：`Authorization` 必须原样带 `workos:` 前缀（剥掉即 401）

源码 `resolveApiKey` **原样使用存储值**，而 Cline 磁盘上存的就是
`workos:eyJ…`。该前缀只在**解码 JWT** 时被剥掉
（`decodeJwtPayload(token.replace(/^workos:/, ""))`），**从不出现在请求头构造里**。

实测（`tests/e2e/cline-probe.e2e.spec.ts` 会现场复验，同一凭据）：

| Authorization | `/api/v1/users/me` |
|---|---|
| `Bearer workos:eyJ…`（**原样**） | **200** |
| `Bearer eyJ…`（剥掉前缀） | **401** |

⚠️ 401 文案是 *"make sure you're using the latest version of Cline and
re-authenticate your Cline account."* —— 与真实原因**毫不相干**，会让人误判成
「客户端版本过旧」。实现见 `clineBearerValue`（幂等补齐，两种形态都接受）。

### ⚠️ 坑 2：免费模型是**独立 id**，且只由 `recommended-models` 下发

`cline-free/deepseek-v4.1-flash`（免费）与 `deepseek/deepseek-v4.1-flash`
（按量计费）是**两个不同条目**。绝不可用「名字含 deepseek」之类模糊匹配判免费 ——
那会让用户按免费预期使用却被计费。

两个端点**必须都打**，理由各有实测依据：

| 端点 | 内容 | 认证 |
|---|---|---|
| `GET /api/v1/ai/cline/recommended-models` | `{recommended[], free[], clinePass[]}`，**唯一权威的 free 集合** | **不需要** |
| `GET /api/v1/models` | 460 个 `{id, object, created, owned_by}` —— **只有 id**，无 name/上下文 | 需要 |

⚠️ 实测 `/models` 的 460 个 id 里 **`cline-free/*` 零命中** —— 免费模型**只**由
`recommended-models` 下发。这就是「只调 `/models` 会看不到任何免费模型」的原因。
`tests/e2e/cline-probe.e2e.spec.ts` 用断言锁死了这一事实（若某天 `/models` 也开始
下发它们，该用例会失败并提示可简化实现）。

判定规则（`isClineFreeModel`，**不硬编码模型名**）：
远端 `free` 集合 ∪ `:free` 后缀 ∪ `cline-free/` 前缀 ∪ 兜底表 `isFree`。
与 CodeArts benefit 集合同一约定。

⚠️ **兜底表要与远端 `free` 数组同步**：sidecar 内嵌目录里**没有** `cline-free/*`
与 `stealth/space-bunny-alpha`（只有远端 `free` 下发），故 `cline-product.ts` 的兜底表
手工补上它们 —— 否则离线时用户看不到免费模型。
⚠️ 2026-10-03 复测：`free` **只剩 4 条**，`cline-free/gemini-3.8-flash` 已被 Cline
下线（直连回 `404 {"error":"model not found"}`），兜底表、单测与 e2e 清单已同步删除它。
**别照抄旧版本的表把它加回来**。

⚠️ **`clinePass` 不是免费集合**：它是 Cline Pass 订阅制模型（`cline-pass/*`），
按订阅额度计费。实测 14 个，误判为免费会误导用户。

### ⚠️ 坑 3：思考字段是 `delta.reasoning`，不是 `reasoning_content`

实测 Cline SSE 形如
`{"delta":{"reasoning":"The","reasoning_details":[…]}}`，而
`reasoning_content` 是 Qoder / buddy 的形态。`src/openai-compat.ts` 的
`consumeOpenAiSse` 因此**同时认两者**（`delta?.reasoning_content ?? delta?.reasoning`）。
只认前者会让 Cline 的思考内容被静默丢弃（表现为「模型不思考」，且 reasoning
档位切换看似无效）。e2e 探针实测已确认思考内容真的产出。

### ⚠️ 坑 4：思考档位**远端不下发**，只能来自客户端内嵌目录

IDE 的模型选择器旁有思考强度菜单（`None / Low / Medium / High / Extra`），
但**远端两个模型端点都不下发档位**：`/api/v1/models` 只有
`{id, object, created, owned_by}`，`recommended-models` 只有
`{id, name, description, tags}`。sidecar 内 `/api/v1/` 的 21 个路径中也没有
任何模型详情端点（`/api/v1/users/me/remote-config` 返回 `{"data":null}`）。

档位只存在于 `code-sidecar.exe` 内嵌的 `BUILTIN_MODEL_CATALOG` 的
`reasoningOptions`，而那张表覆盖不了远端 460 个 id。故 `CLINE_REASONING_EFFORTS`
对**所有**模型统一给 5 档。

⚠️ **`id`（wire 值）与 `name`（展示名）不是同一个概念**。最高档的对应关系
（`Extra` → `max`）是**行为实测**出来的，不是反推的：

| effort | reasoning 字符数（`stealth/space-bunny-alpha`，同题 3 次采样均值） |
|---|---|
| 不传 / `none` | 0（**不传 = 不思考**） |
| `low` | 67 |
| `medium` | 379 |
| `high` | 294 |
| `xhigh` | **259（与 high 无可辨差异 → 伪档位）** |
| `max` | **1192（high 的 4 倍 → 最高档）** |

若只按名字对齐（`xhigh` → 显示成 XHigh），会给用户一个**实测无差异的档位**，
而真正的最高档 `max` 反被跳过。旁证：sidecar 权重表
`{ max:1, xhigh:0.95, high:0.8, ... }` 同样确认 `max` 在 `xhigh` 之上。

⚠️ **上游对不认识的档位静默忽略而非报错**（实测 `reasoning_effort: 'banana'`
返回 HTTP 200、思考量为 0）—— 故 `stream()` 里**绝不能加白名单校验**：
校验既无必要，又会把上游未来新增的档位变成静默丢弃。

⚠️ **声明 `defaultEffort` 会改变默认行为**：实测不传档位时模型完全不思考，
而 DSH 在用户未选择时自动采用 `model.reasoning.defaultEffort`。本插件默认
`high`（对齐 IDE 截图的选中态），代价是思考 token 计入 `completion_tokens`。

⚠️ 统一给档位的**已知局限**：对不在内嵌目录里的模型，档位是猜的 ——
最坏情况是「开关无效」（上游静默忽略），不会是「请求失败」。

排查脚本：`scripts/probe-cline-reasoning.mjs`（纯本地，只读）、
`scripts/probe-cline-effort-compare.mjs`（**消耗免费额度**，多次采样对比档位）。
设计文档：`docs/superpowers/specs/2026-09-25-cline-reasoning-effort-design.md`。

### ⚠️ 坑 5：Gemini 系有两个**独立**的 400，且各自只在部分 provider 上暴露

⚠️ **2026-10-03 补记**：`cline-free/gemini-3.8-flash` 已被 Cline 下线（不在 `free`
数组里、直连回 `404 model not found`），故兜底表里那条已删除。本节保留为**历史记录**，
因为两个根因的教训与模型无关：**①表里的数值必须实测**（别照抄邻居的值）、
**②`sanitizeClineToolParameters()` 是为所有模型服务的安全网**（任何严格校验工具
`enum` 的上游都会踩到），二者都**不可因这条模型下线而回退**。

用户报障（2026-09-25）：给 `cline-free/gemini-3.8-flash` 发消息即失败。错误体里
一次请求有**两个 provider 尝试、两个不同的错误**：

| provider | 错误 |
|---|---|
| `vertex` | `maxOutputTokens value of 131072 but the supported range is from 1 to 65537` |
| `google` | `tools[0].function_declarations[34].parameters.properties[permission].enum[3]: cannot be empty` |

⚠️ **不要只修一个** —— 上游会依次 fallback，命中哪个 provider 就暴露哪个错误，
路由一漂移就复发。

**根因 1（我们的错）：兜底表数值凭印象填。** `cline-free/gemini-3.8-flash` 不在
sidecar 内嵌目录里，当初手工补表时照抄了其它免费模型的 `131072`；而同名
`google/gemini-3.8-flash` 的实测值是 **65536**，上游上限即 65536。
这与 Qoder 那条「本表数值必须逐条对照，不要凭印象填」是**同类错误**。

**根因 2（必现）：工具 schema 的 `enum` 含空串。** harness 下发的工具集里某些
参数的 `enum` 带空字符串成员，Gemini 系严格校验直接 400。
⚠️ 本适配器**从不自己造 enum**（`stream()` 原样透传 `tool.parameters`），
脏数据来自上游 harness —— 但请求是我们发的，只能在我们这侧拦住。
`sanitizeClineToolParameters()` 递归清洗，三条边界：只删空串（保留数值枚举）、
全空则丢弃 `enum` 键（空 `enum` 同样非法）、递归下钻 `properties` / `items`。

⚠️ **排障时注意：这两个 400 都不是必现的。** 实测同一 `max_tokens=131072`
连发 3 次都返回 200（那几轮没命中 vertex）。判定依据是错误体里的
`providerMetadata.gateway.routing.modelAttempts[].providerAttempts[]`，
不是重试次数 —— 别因为「重发一次就通了」而误判为偶发。

⚠️ 顺带：本机 `~/.cline/data/settings/providers.json` 里的 `accessToken` **常常过期**
（实测过期 1 小时，直接请求得到 401），排查前先续期；续期返回的是**裸** JWT，
必须补 `workos:` 前缀才能用（坑 1）。

排查 / 验证脚本：`scripts/probe-cline-gemini-400b.mjs`（对照复现两个根因）、
`scripts/verify-cline-gemini-fix.mjs`（走已编译 `lib/` 的端到端验证，三个场景）。
均**消耗免费额度**。

### ⚠️ 坑 6：403 不都是凭据问题 —— 地域限制会被误报成「API 密钥无效」

用户报障（2026-09-25）：`cline-free/muse-spark-1.3-contributor` 提示
「**API 密钥无效**」，但凭据是好的。

该中文文案**不是本插件抛的** —— 它来自 DSH 客户端 `failureMessage()`：

```js
return code === "AUTH" ? t("message.failure.auth") : message
```

即**只要错误码是 `AUTH`，真实原因就被替换成「API 密钥无效」**；非 `AUTH` 则
原样显示 message。而 `httpErrorCode()` 把 401/403 **一律**映射成 `AUTH`。

⚠️ Cline 对「该地区不可用」的模型也返回 **403**：

```
403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor
     is not available in your region","success":false}
```

于是故障链是：403 → 当作凭据过期 → **白跑一次续期**（续期还会成功，所以不提前
报错）→ 重试仍 403 → 归成 `AUTH` → UI 显示「API 密钥无效」。真实原因彻底丢失，
用户以为要去重新登录。

修法：`isClineRegionForbidden()` 按**响应体文案**识别（不能按状态码一刀切 ——
同一批 403 里既有真凭据问题也有地域限制），命中时**跳过续期**并抛
`PERMISSION_DENIED`（该码不在 DSH 默认可重试集合内，不会反复重试）。

⚠️ 顺带修了 `errorDetail()`：Cline 的错误体是 `{error: "<文案>", success:false}`，
而该函数原本只认 `code` / `message` / `msg` → 整个 JSON 原样返回，用户看到一坨
裸 JSON。现已补 `error`（字符串与嵌套对象两种形态都认）。这是**共享函数**，
Qoder 同样受益，改动已由全量单测覆盖。

排查 / 验证脚本：`scripts/probe-cline-muse-403.mjs`（直接看真实状态码）、
`scripts/verify-cline-region-fix.mjs`（走 `lib/` 验证错误码与续期次数）。
均**消耗免费额度**。

### 登录：WorkOS 设备码（与 Qoder 同为轮询式，但判据形态不同）

```
POST {workOsBase}/user_management/authorize/device   → device_code / user_code / verification_uri
轮询 POST {workOsBase}/user_management/authenticate  → 200 {access_token, refresh_token}
     grant_type=urn:ietf:params:oauth:grant-type:device_code
POST {apiBase}/api/v1/auth/register  body {accessToken, refreshToken}
  → {success:true, data:{accessToken, refreshToken, expiresAt, userInfo:{clineUserId, email}}}
```

⚠️ **`authorization_pending` 不是错误**，必须继续轮询 —— 它是「用户还没在浏览器里
点授权」。与 Qoder 的「404 表示尚未授权」是同一类语义，但**判据形态完全不同**
（Qoder 看 HTTP 状态码，Cline 看响应体的 `error` 字段）。`slow_down` 必须**累积
退避**（源码 `intervalSeconds += 1`）。

⚠️ **响应套 `{success, data}` 信封，字段名是驼峰** `accessToken`（不是
`access_token`）。判据是 `success && data.accessToken`（源码
`requireClineTokenResponse`），只看裸字段会把失败信封当成功。

### 续期：字段名是驼峰 `refreshToken` + `grantType`

```
POST {apiBase}/api/v1/auth/refresh
body: { "refreshToken": <refresh>, "grantType": "refresh_token" }
```

⚠️ **不是 OAuth 标准的 `refresh_token` / `grant_type`**（源码 `refreshClineToken`）。
两者都必填；写错字段名服务端不会明确报「缺字段」，而是回一个泛化的认证失败。

### 积分余额：只有余额，**没有签到**

```
GET {apiBase}/api/v1/users/{accountId}/balance
  → { data: { userId, balance: 500000 }, success: true }
```

⚠️ **`userId` 用凭据里的 `account_id`（`usr-…`），不是 JWT 的 `sub`（`user_…`）**：
实测传 `sub` 返回 `400 {"error":"Invalid request format"}`。

⚠️ **401 的响应体是 `{error:"…"}`，没有 `success` 字段** —— 解析器必须两种失败形态
都认，否则 401 会落到误导性的「响应缺少 data 字段」，把服务端给的唯一有用线索丢掉
（真实缺陷，已由 `tests/unit/cline-credits.spec.ts` 锁死）。

⚠️ **余额单位**：实测 `balance: 500000`。按 1e-5 USD 解释为 **$5.00**，与 Cline
公开的新账号赠额一致 —— 这是选取 `CLINE_BALANCE_SCALE = 100000` 的独立锚点。
⚠️ **不要用 `/usages` 的 `costUsd` 反推该系数**：实测单次记录
`{creditsUsed:0, costUsd:1320, totalTokens:49}`，按 1e-5 解释会是 $269/1M token
（flash 档不可能），说明两者**口径不同**。只读 e2e 探针会打印原始值供核对。

**签到不存在**：对整个 sidecar 做字符串扫描，`checkin` / `check-in` / `daily` /
`campaign` 均无任何 Cline 业务端点命中（`campaign` 的命中是 PostHog 的 UTM 参数与
feature-flag 事件属性；`daily` 是 YAML cron 别名与 Blob 导出频率枚举）。故能力矩阵
登记为 `{balance:true, dailyCheckin:false}`。（WorkBuddy 国际版此前同例，2026-11-15 已更正为 `true` —— 端点同形，只是当年只搜了 CLI 内核。）
⚠️ 这比「某次调用没看到」强，但仍不等于「永远不存在」—— 若将来增加签到，需按
Qoder 那次教训重新采集。

### e2e 闸门（付费保护，**请勿削弱**）

```
DSH_CLINE_E2E=1                          只读探针（凭据/前缀证据/余额/免费集合）
DSH_CLINE_CHAT_E2E=1 + ..._CONFIRM=yes   默认**只**请求 cline-free/deepseek-v4.1-flash
DSH_CLINE_CHAT_E2E_ALL_FREE=1            才遍历其余 4 个免费模型
```

理由：免费资格是**服务端随时可撤销**的营销状态。无条件遍历「远端此刻说免费」的
那批模型，某天某个转为计费后，一次 e2e 就会**按付费价刷 token**。

`assertFreeModel()` 是安全边界：任何 `isFree === false` 的模型（无论来自
`DSH_CLINE_MODEL` 还是远端列表）都**直接抛错、不发请求**；遍历分支还做逐个二次确认
（已不在**当前** free 集合中即跳过）。

### ⚠️ 面板图标必须从官方资源提取，**不得凭印象手绘**

**真实缺陷**（用户报障）：「我们用的图标和 cline 的好像不一样」。

初版 `CLINE_ICON` 是**凭印象手绘**的内联 SVG（「深色圆角方块 + 白色 C 形弧线」），
与 Cline 真实标志完全不符 —— 真实标志是**顶部带凸起的圆角方块 + 中间两条竖线 +
左右两侧尖角**，品牌紫底。

**教训：品牌图标必须从官方资源提取。** 修法与工具：

- 官方图标**就在安装目录里**，不必从 exe 抠 PE 资源：
  ```
  %LOCALAPPDATA%\Cline\icons\app\{classic,chip,hologram,midnight}.png   148×148
  %LOCALAPPDATA%\Cline\icons\app\macos\*.png                            1024×1024  ← 用这个
  ```
  （`cline-app.exe` 内嵌的主图标只有 **32×32** 且是 **midnight** 主题，不适合。）
- 提取脚本 **`scripts/extract-cline-icon.mjs`**（纯 Node，**零第三方依赖**：
  PNG 解码/编码用内置 `zlib` 手写，只支持官方图标的
  bit depth 8 + color type 6/2 + 非隔行）：
  ```
  node scripts/extract-cline-icon.mjs                    # classic，48×48，写入 jet-hub.js
  node scripts/extract-cline-icon.mjs --dry-run
  node scripts/extract-cline-icon.mjs --theme=midnight --size=64
  node scripts/extract-cline-icon.mjs --out=icon.png     # 另存供目视
  ```
- **主题选 classic（品牌紫 `#7271E5`）**，理由：`midnight`（exe 内嵌的默认主题）
  是近黑底，与 **Qoder 图标的深蓝黑 `#1f2a3f`** 在容器实际尺寸 **20×20** 下
  几乎无法区分，列表里会混淆；`chip`（绿色电路板）缩到 20×20 后纹理退化成噪点；
  `hologram` 在白底容器里对比度不足。另：紫色在当前 7 个 provider 图标里**未被占用**。
- ⚠️ **缩放必须做 alpha 加权（预乘）平均**：图标边缘是抗锯齿的半透明像素，
  直接对未预乘 RGB 平均会混入透明区的黑色，产出**发黑的描边**。
- ⚠️ 脚本的替换逻辑用**全局匹配、只保留一行**：单次 `String.replace` 一旦
  文件里出现重复的 `const CLINE_ICON` 声明就会残留 → esbuild 直接报
  `The symbol "CLINE_ICON" has already been declared`（开发期踩过一次），
  现在重复运行幂等且能自愈重复行。
- **回归测试 `tests/unit/cline-icon.spec.ts`**：锁定 ① 必须是结构完整的 **PNG**
  （防退回手绘 SVG）、② 尺寸 48×48、③ 与「从官方 `classic.png` 重新提取」
  **逐字节一致**（无 Cline 安装时该条干净跳过）。
  已做**反向验证**：把前缀改回 `data:image/svg+xml` 后 4 条用例失败。

### 其它

- 推理端点是**标准 OpenAI 兼容**（`POST {apiBase}/api/v1/chat/completions`），
  故复用 `src/openai-compat.ts` 全套（消息序列化 / SSE 消费 / 错误归类），与 Qoder 同做法。
- 客户端标识头（推理与账号端点都带）：`HTTP-Referer: https://cline.bot`、
  `X-Title: Cline`、`X-IS-MULTIROOT: false`、`X-CLIENT-TYPE: cline-sdk`。
- `max_tokens` 上界收敛到 **943718**（内嵌目录最大 `maxTokens`，取自
  `muse-spark-1.3-contributor`），不自行编造更大值。
- 单元测试 7 个文件：`cline.spec.ts` / `cline-models.spec.ts` / `cline-oauth.spec.ts` /
  `cline-credits.spec.ts` / `cline-quota.spec.ts` / `cline-auth.spec.ts` / `cline-adapter.spec.ts`。

### ⚠️ Cline「订阅额度」：官方额度窗口 + 请求记录（2026-09-29 新增）

Cline 面板的账号管理区有一个**订阅额度**按钮（只在 Cline 出现），点开是弹窗：
上半部是**官方额度窗口**（5 小时 / 周 / 月各用掉百分之几 + 重置时刻），
下半部是**请求记录**（逐笔：时间、模型、token、积分）。

与账号卡片上的「积分」是**多份不同的读数，不能互相替代**：

| | 积分（既有） | 订阅额度（本次） | 请求记录（本地流水） |
|---|---|---|---|
| 回答的问题 | 还剩多少钱 | 各时间窗用掉百分之几 | **本插件发出的**每笔请求：多久、多少 token |
| 来源 | `/api/v1/users/{id}/balance` | `/api/v1/users/me/plan/usage-limits` | `src/cline-request-log.ts`（进程内存） |

参考实现：`github.com/codeOct/dsh-cline-pass` 的额度管理与请求记录部分。

### ⚠️ 请求记录是**本地流水**，不是网关账单（2026-09-30 按用户反馈改造）

**用户反馈**：「请求记录展示的字段和我给你的参考也不一样」——首版把请求记录
对齐到了网关 `/users/{id}/usages`（字段 `createdAt / aiModelName / aiModelTypeName
/ totalTokens / creditsUsed / costUsd`）。**那是错的**：网关记录的是该账号在
**官方所有渠道**的消费账单，没有延迟、没有首块时间，字段也对不齐参考实现。

**改法**（对齐参考实现的请求记录部分）：

- 新增 `src/cline-request-log.ts`：适配器发出的每笔推理请求记录
  `{ ts, model, accountId, usageReported, inputTokens, outputTokens,
  cacheReadTokens?, reasoningTokens?, effort, ttftMs, totalMs, error? }`。
- `src/cline-adapter.ts` 的 stream() 有**两个**消费出口（换号成功后的 consume
  与正常路径的 consume），**都**走 `consumeWithLog()`（内部再调 `this.consume`）
  —— 接线由 `cline-adapter.spec.ts` 的源码断言锁死（`yield* this.consume(`
  不得再出现）。
- 记录的**取舍**（与参考实现的差异及理由）：
  - 不记 `ttfb`：单一网关、无 upstream 选路，响应头与首块之间没有独立阶段。
    表格的延迟列仍按参考实现给**三行**（首字 / 总耗时 / 输出速率）。
  - 换号过程**不逐笔记**：只记**最终结果**一笔 —— 参考实现会把每次
    AUTH/QUOTA attempt 都记成失败行，本适配器的 429 换号风暴（最多 3 轮）
    会把 100 条上限刷满；「所有账号均不可用」这行已包含换号语义。
  - usage 帧在**经过时捕获**：流中途 abort / 上游提前断开时 usage 没被消费到，
    此时记 `usageReported: false`（**不是记 0**）—— 表格据此显示 `—`；
    记 0 会被读成「瞬间完成、没花 token」（参考实现同约定）。
  - **记录绝不抛错**：它在推理关键路径上，记账失败不得反噬推理
    （record 内部全部 try/catch + 钳制 + 截断）。
- 存储：**进程内存，100 条，重启即丢**（刻意，与参考一致；高频写不适合持久化）。

### ⚠️⚠️ 请求记录的「账号」必须用**账号池 id**，不能用凭据里的 `account_id`（真实缺陷，2026-09-30）

**用户报障**：「请求记录中数据空白，没有记录下来」。

**根因是两个 id 空间被混用** —— 字段名叫 `accountId` 的有**两套值**：

| 位置 | 值 | 形如 |
|---|---|---|
| 面板的过滤条件 `cline.requestLog.accountId` | **账号池 id**（取自 `cline.quota` 的 `accounts[].accountId`，即 `account.id`） | `cline-bb211a53` |
| 适配器原先在**成功路径**记的 | 凭据里的 `account_id`（Cline 的**用户 id**） | `usr-01M3BCV4FY…` |

两者不相等 ⇒ `readClineRequestHistory({ accountId })` 恒返回空 ⇒ 表格**永远空白**。
（换号路径当时记的却是池 id —— 同一缺陷的两半，两条出口口径不一致。）

**修法**：`ClineAdapterOptions` 新增 `currentAccountId?: () => string | undefined`，
由 `src/index.ts` 在 `resolveCredential` 里记录**实际选中的池账号**
（`activeClineAccountId`，与 `activeQoderAccountId` 同因、同写法）；
适配器在 stream() 开头用它做**局部变量**的起点（只在首次取值，
换号后自行跟进），两个出口都用「池 id 优先、无池账号才退回 `usr-…`」。

⚠️ **反向验证已做**（本仓库要求）：把正常路径改回 `credential.account_id ?? …`
→ `cline-adapter.spec.ts` 的「请求记录归属『账号池 id』」**变红**，报错为
`expected 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM' to be 'cline-bb211a53'`；还原后全绿。

⚠️ **做这次反向验证时连踩两个工具坑**（都会让验证**假绿**，务必避开）：
1. **同一表达式在文件里出现两次**（换号路径 + 正常路径，文本完全相同）——
   用字符串 `replace` 命中的是**第一处（换号路径）**，而用例走的是正常路径，
   于是「回退了却仍全绿」。必须按**上下文/最后一次出现**定位。
2. **本仓库源文件是 CRLF**：脚本里写 `\n` 的**多行**锚点永远匹配不上
   （单行锚点没事，所以第一次只替换成功的假象更难发现）。按行处理即可。
   ⚠️ 另：**Windows 下别用内联 `node -e`**，PowerShell 会吃掉
   `\``/`$`/引号（本次两次静默跑错），写成 `.mjs` 文件再跑。

### ⚠️⚠️ 请求记录的三处**展示语义**缺陷（2026-09-30 用户复核，一次报三个）

用户报障原文：「**上游显示的不正确**」「支持图片的模型**发送不了图片**」
「请求记录中：输出速率 `11814.8 t/s` 这个是不是也有问题」。
三者**根因各不相同**，但都属于「字段取错了口径」，逐个记下：

#### ① 「上游」列取的是**模型命名空间**，不是 serving channel

- 原实现：`clineUpstreamOf(model)` = 模型 id 的 `/` 前缀（`cline-pass` /
  `cline-free`），**甚至是厂商名**（`deepseek/deepseek-v4.1-flash` → `deepseek`）。
  那是「订阅通道/厂商」，不是「谁服务了这笔请求」。
- 参考实现同一列显示的是 **`alibaba` / `baseten`** 这类真实渠道，取自网关
  下发的路由元数据（其 `parseRouting()`）。
- **落点**（三种实测形态，`src/cline-routing.ts`）：

  | 形态 | 路径 |
  |---|---|
  | **流式（真实链路）** | `choices[0].delta.provider_metadata.gateway.routing.finalProvider` |
  | 非流式 / planner | `choices[0].message.provider_metadata.gateway.routing.finalProvider` |
  | 帧顶层 | `provider_metadata.gateway.routing.finalProvider` |
  | direct | `delta.provider` / 顶层 `provider`（如 `GMICloud`，原样保留） |

  ⚠️ **大小写两种拼写都要认**：本仓库另一处实测（Gemini-400 段）记的是
  **camelCase** `providerMetadata`，参考样例是 snake_case；只认一种会在另一种
  形态下静默读不到。
  ⚠️ 参考注释：*"in a stream it appears on whichever frame carries it, so every
  frame is inspected and the last non-null reading wins"* ⇒ **逐帧**观测、
  最后一次非空为准。
- **实现**：`consumeOpenAiSse` 新增**可选旁路** `onFrame`（回调抛错被吞掉 ——
  观测绝不能打死一次正常推理）；适配器在 `consumeWithLog` 里累积，写进
  `ClineRequestEntry.upstream`。**空串 = 网关没报**，RPC 侧才回落到模型命名空间。
- 反向验证：停掉逐帧观测 → 用例红（`expected '' to be 'deepseek'`）。

⚠️⚠️ **第一版读漏了 `delta` 这一层，整处修复在真实链路上完全没生效**
（用户 2026-10-01 第二次报障：「**上游**和**请求速率**为什么显示的还是错误的」；
进程核对过 —— 00:30 启动的进程**已含** 00:09 那次安装，不是「没加载」）。
当时按「非流式挂 `message`、**流式挂帧顶层**」实现，而**实测的流式帧把它挂在
`choices[0].delta` 上** ⇒ 每帧都读不到、`upstream` 恒为空串、展示层回落到
`cline-pass`，用户看到的与修复前**一模一样**。

**两条教训（都比这一处 bug 值钱）**：

1. ⚠️ **外部载荷的确切层级只能实测，不能按参考实现的只言片语推断**。参考实现
   只说了「出现在携带它的那一帧上」，**没有说挂在 `delta` 还是帧顶层**，我按
   猜测填了帧顶层。一次性探针
   （`scripts/probe-cline-routing-live.mjs`：用凭据库里的 token 发一次极小流式
   请求，**逐帧打印命中的 JSON 路径**）当场就能定案 —— 这类「形状假设」必须
   在写实现时就用探针钉死，或至少在注释里标成**未验证假设**。
2. ⚠️⚠️ **fixture 写错等于没有测试**：适配器那条 `upstream` 用例当时用的是
   **帧顶层**的 fixture（即我的猜测），于是**用例绿、功能坏**，直到用户第二次
   报障才暴露。凡涉及外部响应形状的 fixture，必须照实测量到的报文写，
   并把「实测来源 + 日期 + 探针名」写进注释（现已如此）。

   ⚠️ 探针本身也踩了一个坑：仓库里的 `access_token` **已含 `workos:` 前缀**
   （`buildClineCredential` 写入时就加了），再拼一次 ⇒ `Bearer workos:workos:…`
   ⇒ **401**。第一版探针因此误判「两个账号的 token 都失效」。

**顺带核清的 `finalProvider` 语义**：它既可能是**基础设施商**（参考实现抓到的
`alibaba` / `baseten`），也可能是**模型厂商自己的 API** —— 本机实测
`cline-pass/deepseek-v4.1-flash` → `finalProvider = "deepseek"`。两者都是
「网关最终决定由谁服务」，故**原样展示**、不要试图归类。

**同时给「输出速率」补了 `—` 的原因提示**（`latencyParts` 新增 `rateTitle`，
挂在那一行的 `title` 上）：不可测有两种情形，各自给话 ——
`本次没有正文块（只输出思考，或流在正文之前结束）` /
`正文阶段只有 Nms（不足 250ms）—— 响应几乎一次性到达`。
用户第二次报障时正是怀疑「速率还是错的」，而实际是**不可测**；
一个横杠不解释，就会被读成「坏了」。

#### ② 图片能力只查本地兜底表 + **`cline-pass` 目录不全**（同一处修复）

用户后来又报了同一条链上的第二个症状：「**当前 cline 供应商的模型列表中关于
cline-pass 部分模型为什么不全**，例如当前这个模型就看不到了」。两者同源：
**models.dev 这份目录此前完全没被当作目录来源**。

- 原实现：`inputModalitiesFor()` 只看 `product.fallbackModels[].supportsImage`
  —— **全表只有 5 条、且全是 `cline-free/*`**；而远端两个目录端点
  **都不下发能力字段**（实测 `recommended-models` 只有
  `{id,name,description,tags}`，`/models` 只有裸 id）。
  ⇒ DSH 按适配器播报的 `inputModalities` 决定要不要把图片投影成占位符，
  于是**图片根本送不进适配器** —— 用户看到的就是「支持图片的模型发不了图」。
- **目录也不全（实测对账，2026-09-30）**：

  | 来源 | `cline-pass/*` 条数 |
  |---|---|
  | 网关 `recommended-models` 的 `clinePass` 数组 | **14** |
  | models.dev 的 `cline-pass` provider 块 | **18** |

  差的 4 条 —— `kimi-k2.6` / `glm-5.2` / `kimi-k2.7-code` / `deepseek-v4-flash`
  —— 在本插件里**根本不存在**，用户既看不到也选不到。
  另外网关给 `cline-pass/*` 的 `name` **就是 id 本身**
  （`name === 'cline-pass/mimo-v2.6-flash'`），列表里全是裸 id 也让人无从辨认；
  models.dev 给的是可读名（`DeepSeek V4.1 Flash`）。
- **权威来源：`https://models.dev/api.json` 的 `cline-pass` provider 块**
  （实测 18 条，逐条带 `modalities.input` 与 `limit`）：
  `cline-pass/deepseek-v4.1-flash` → `["text","image"]`、
  `cline-pass/minimax-m3` → `["text","image","video"]`、
  `cline-pass/glm-5.3` → `["text"]`。参考实现用的**正是同一来源**
  （其 `MODELS_DEV_URL`；面板里「Rescan the official subscription list and
  **adopt newly published models**」就是这一步 —— 注释原文：
  *"Without it a model newer than this release resolves to the `text` fallback
  and the harness refuses every image for it, silently."* 两处报障同型）。
- **实现口径**（`src/cline-models-dev.ts`，替代原先只管模态的
  `cline-modalities.ts`）：models.dev 是**目录的第三个来源**，
  在 `ensureRemoteModels()` 里用 `applyModelsDevCatalog()` 并入：
  1. **补缺**：目录里没有的 id **追加在该前缀最后一条之后**
     （不能挂第一条后 —— 那会插到同族中间；更不能追加到列表末尾 ——
     那里沉在 460 条远端 id 之后，等于没人看得到）；
  2. **补名字**：仅当 `name === id`（网关把 id 当名字下发）时用可读名替换；
  3. **补窗口**：`contextWindow` 缺失时才用 models.dev 的 `limit.context`；
  4. ⚠️ **不取 `limit.output`**：那是要**真的写进请求体 `max_tokens`** 的值，
     本仓库有过「据印象填大值 → vertex/google 400」的真实缺陷
     （见本文件 Gemini-400 段），故只补展示名与窗口，不碰输出上限。
  ⚠️ **一律不覆盖已有值**：策展的本地兜底表与网关数据优先于社区目录
  （显式 `supportsImage: false` 也照样赢）。
  ⚠️ **只认 `image`**（夹取掉 audio/video/pdf —— DSH 词表只有 text/image）。
  ⚠️ **失败向上抛、不缓存**（`TtlCache` 只在成功时写入 ⇒ 下次可重试），
  适配器侧吞掉并保持「这一层没有补充」。TTL **6 小时**（发布节奏的数据）。
- ⚠️ **「没读到」≠「不支持」**：读不到时目录照常工作、图片能力退回本地兜底表；
  把前者当后者正是本次缺陷的形态。
- 反向验证：停用 `applyModelsDevCatalog` 那一行 → **两条**用例同时变红：
  `图片能力取自 models.dev：cline-pass/* 也能发图`（报错
  `cline: 模型 "cline-pass/deepseek-v4.1-flash" 不支持图片输入`）
  与 `models.dev 补全 cline-pass 目录`。

#### ⚠️⚠️ models.dev 失败会**永久固化**：`complete` 判据漏了它（Issue IKKZUG）
---

#### ⚠️ 目录健康快照：让「没拉到」可观测（Issue IKKZUG 第 5 点）

**排障困境**：models.dev 拉不到时只有一行 `console.warn`（宿主不落盘），
现象只是「贴不了图」，**无从判断**是「这个模型不支持图片」还是「目录还没拉到」。
用户 @oct_heaven 正是靠手工推演才定位到这一层 —— 那不该是排障的常规成本。

**落点（既有端点 + 可选钩子，零新端点）**：

- `ProviderStatus.catalog`（**可选**字段）+ `CatalogHealth` 类型；
- `ModelCatalogSource.describeCatalogHealth?()`（**可选**钩子，
  与既有的 `describeCatalog?` / `clearChoiceCache?` 同构）；
- `provider.status` 逐供应商调用它。

⚠️ **不新开端点**：设置页已经在读 `provider.status`，新端点等于让前端多一次
往返；而 `model.list` 每次调用都要重组全量目录，不适合承载诊断。

**三条纪律（都有专门用例守着）**：

1. **零 IO**：设置页挂载时对**每个**供应商都会调它，一旦触发网络请求就会拖慢
   首屏（本端点全程只用同步内存副本正是为此）。有用例断言
   `describeCatalogHealth()` 连调 5 次**不触发任何拉取**。
2. **钩子抛错必须被吞**：诊断不得反噬主流程 —— 否则适配器里一个诊断 bug 会让
   整个设置页打不开。字段缺席而非整个状态丢失。
3. **字段缺席 = 该适配器不提供诊断**，不是「一切正常」。前端与排障脚本必须按
   `undefined` 判「无信息」—— 把「没测」当成「没问题」正是本仓库反复出现的
   静默形态。其余 13 家不实现该钩子，有用例守住。

⚠️ `note` **只在异常时给**：完整时不写该字段 —— 一句「一切正常」对排障毫无价值
（真正需要看的正是异常时），也省掉前端一处永远为真的渲染分支。

⚠️ 文案里**必须写明「会自动重试」**：`complete: false` 不是故障，插件会按闸门
冷却自动重试，用户无需做任何事。不写这一句会让用户以为要自己去修。

⚠️ **第 3 点建议的最后一条退路（内嵌 `cline-pass/*` 模态兜底表）有意不做**：
它会引入第二份需长期维护的快照，而本次修好的恰恰是「手工能力表与远端漂移」
这个毛病（`applyModelsDevCatalog` 把 models.dev 的「明确 false」吞成「未知」）。
要做也只能标注为纯兜底、且远端优先。

**真实报障**（用户 oct_heaven，2026-10-12）：`cline-pass/*` 整段时间贴不了图、
读不了图，**只有重启才能恢复**（实测桌面端 10-11 23:02 启动 → 10-12 00:30
仍稳定拒图）。

**根因三处叠加**，第 3 条最隐蔽：

1. **能力来源单一**：`cline-pass/*` 的条目与图片能力**只由 models.dev 提供**
   （网关 `recommended-models` 实测只下发 14 条，models.dev 有 18 条）；
2. **models.dev 经常拉不到**：目标 `api.json` **解压后 5.39 MB**、Brotli、
   无 `Content-Length`；用户直连实测三次 = `20010ms 超时` / `20010ms 超时` /
   `1908ms 成功` ⇒ **不是「慢」，而是「要么很快、要么整段挂住」**；
3. ⚠️⚠️ **`remoteComplete` 判据漏了 models.dev**：`complete` 只反映**两个
   Cline 端点**（`remote.complete`），而短路判据是 `if (this.remoteComplete)
   return` ⇒ models.dev 超时后它仍为 `true` ⇒ **闸门的冷却永远读不到**
   ⇒ models.dev 整个进程生命周期只被调 1 次。

⇒ 修法：`complete && this.modelsDev !== undefined`。判据用「**读到过**」
（含读到**空表** —— 上游确实没有 `cline-pass` 块时那也是「已就绪」，
不该无限重试）。方向是「宁可多试一次」：多试只是多发一次请求（自带 TTL +
闸门 30 秒冷却），漏判的代价是整个 provider 的图片能力永久失效。

**同源的第二个坑（被三态改造暴露）**：`applyModelsDevCatalog` 原先写

    ...entry.supportsImage ? { supportsImage: true } : {}   // false 被吞成「缺席」

⇒ models.dev **明确说 false**（实测 `cline-pass/glm-5.3` 就是不带图的）时字段
**缺席** ⇒ 三态下被读成「**未知**」，而它其实是「**确认不支持**」。
两个方向都真实有害：宿主按「未知」**放行**图片（发到不支持图的服务端）、
门禁文案说「能力尚未加载完成」。⚠️ 这条在**两态**下无害（两边都归 `['text']`），
是三态改造**暴露**的。**两个入口都要改**（补缺分支 + 已有条目的合并分支）。

**拉取健壮化**（同 issue 第 3 点）：超时 20s → **60s**、显式
`Accept-Encoding: br, gzip`（Node 原生 `fetch` **默认不带**，一直在下 5.39 MB
明文 —— 代价不只是慢，而是**极易撞上超时上限**）、ETag 条件请求。
⚠️ **304 必须回落成上次的结果**，绝不能当成「空目录」（那会把所有模型的图片
能力一次性打回纯文本）；⚠️ 服务端撤掉 ETag 时必须清空，否则一直带着失效的
`If-None-Match`；⚠️ 没有上次结果却收到 304 时**抛错**，让调用方按「未就绪」
处理 —— 返回空表就是把「没读到」说成「不支持」。

**三态判定**（同 issue 第 1 点，通用纪律见 `misc.md`）：`inputModalitiesFor`
必须判 `supportsImage === undefined`（**字段缺席**）而不是 `!== true`；
未知时 `toCatalogEntry` **省略** `inputModalities`；`stream()` 门禁分流为
`INVALID_REQUEST` + 可区分文案（**不用 `TRANSPORT`** —— 它在
`DEFAULT_RETRYABLE_CODES` 里，会白重试 5 次）。
⚠️ `cline` 已按 `model-catalog-parity` 的显式例外机制登记进
`OMIT_UNKNOWN_MODALITIES` —— **不是把 buddy 的做法推广**，而是先确认了它
确实存在「未知态」（能力来源会在进程运行中拿不到）。有些家的目录是编译期表
恒可用、根本不存在未知态，那些**不**该加进来。

⚠️ **排障提示（本次顺带查明的第三种「看不到」）**：目录里有 14 条 `cline-pass`，
但**用户的黑名单关掉了 10 条**（`~/.dsh/jet-hub/state.json` 的
`disabledModels.cline`，实测 474 条 cline 模型被关），模型选择器里因此只剩
4 条 —— 那是**用户自己的模型开关**，不是目录缺失。Jet Hub 的模型列表会渲染
被关闭的模型（`listAllModels()` 就是为此存在），所以能在那里重新打开。
**两种「看不到」的判据不同，别混**：黑名单造成的在 Jet Hub 里能看到（带开关）、
目录缺失的在任何地方都没有。

#### ③ 「输出速度（TPS）」= **DeepSeek 官方口径**（用户 2026-10-01 定案）

> 用户原话：「**按照官方速率显示规则来**」（此前明确「我说的 deep seek」）。
> ⚠️ **这一节取代了我 2026-09-30 那版「正文阶段」口径 —— 那版被用户否掉了。**

**官方规则**（只读核对，出处是本机 DSH 自己的聊天 UI：
`@deepseek-ai/dsh-client-ui-chat/lib/client.js`，可在
`D:\Program Files\DeepSeek Harness\resources\app.asar` 里直接读到）：

```js
// assistantStepReading(node)：一「步」的读数
ttftMs   = firstTokenTime - stepStartTime      // 首个 token（任意块，含推理块）
decodeMs = completedTime  - firstTokenTime     // 首 token 之后 → 结束
outputTokens = usage.outputTokens              // 该步全部输出 token

// TimePill()：显示（decodeMs > 0 才显示，否则整项不渲染）
tps = formatTokensPerSecond(outputTokens / (decodeMs / 1e3))

// formatTokensPerSecond()：取整规则（先 clamp 负值）
x >= 10 ? String(Math.round(x)) : String(Math.round(x * 10) / 10)
```

官方 i18n：`message.tokensPerSecond = "{tps} tok/s"`、
`stats.dialog.speed = "输出速度（TPS）"`。

**本插件据此落地**（`plugin-src/client/tokens-per-second.js`，纯函数可逐值单测；
`jet-hub.js` 只负责组装三行）：

| 项 | 取值 |
|---|---|
| 分子 | **全部输出 token（含推理 token）** —— ⚠️ **不减** `reasoningTokens` |
| 分母 | `总耗时 − 首字`（`decodeMs`），**不含**首字之前那段 |
| 门禁 | 只有 `decodeMs > 0`；⚠️ **没有**最小窗口下限 |
| 单位/标签 | `tok/s` / 「输出速度（TPS）」（单元格里用短版「输出速度」） |

⚠️⚠️ **三处曾经的错误做法，别再改回去**（每条都有反向验证过的用例守着）：

1. **`11814.8 t/s` 那次不是"公式错"**：官方口径在**短窗口**下本来就会给出很大的数
   （响应几乎一次性到达时 `首字 ≈ 总耗时`，`142 token ÷ 12ms ≈ 11833 tok/s`）。
   我 09-30 的反应是改分子分母 + 加 250ms 下限 —— **那是过度纠正**，官方没有下限，
   改了反而与本 app 自己的读数不一致。
2. **不要减推理 token**：`reasoning_tokens` 计入 `completion_tokens`（本仓库多处实测），
   官方就是这么算的。减了会让同一笔请求的 TPS 与 DSH 显示的不同。
3. **不要退回 `toFixed(1)`**：官方的精度是**两段式**（`≥10` 整数、`<10` 一位小数），
   不是统一小数位。反向验证：把取整换成 `toFixed(1)` → **7 条**用例变红
   （`expected '273.9 tok/s' to be '274 tok/s'` 等）；把分子改成「减推理」→ 1 条变红。

⚠️ **`ttfcMs`（首个正文块耗时）现在只是诊断字段**，**不参与**速率计算：
官方口径只用 `首字`（首个任意块）。字段仍照常记录（适配器 → 请求记录 → RPC），
将来若要显示「首正文」可直接用；但**不要**拿它当速率分母。

⚠️ **`ttftMs === 0` 在我们的数据模型里是「没有任何块到达」= 未知**（官方用 `null`），
故 `formatRowTokensPerSecond` 把 `0` 显式映射成**不可测**（显示 `—`）——
照字面算 `total - 0` 会把「首字时刻未知」当成「首字在 0ms」，报出假速率。
这条映射有专门用例（`缺首字时刻（ttft=0 = 未知）→ —`）。

⚠️ **旧断言又锁死了一次旧实现**：`cline-quota-panel.spec.ts` 里原先那条
「输出速率按正文阶段算」的用例（断言 `MIN_RATE_WINDOW_MS` / `contentTokens`）
正是锁 09-30 那版口径的，本次已改写为「接线到 `tokens-per-second.js`」。
**改口径必须同步改用例** —— 这在本仓库已是第三次同型情况
（账号池 id、平铺渲染、此处）。

⚠️ **反向验证脚本自身的坑（第 4 次同型）**：`swap-tps-official.mjs` 打补丁时
**第一版打到了文档注释里那行官方代码**（我在模块头注释里引用了
`x >= 10 ? … : …`），于是「取消官方取整」的反向验证**假绿**（13 条全过）。
判据：**要改的是函数体，必须取最后一次出现**（`lastIdx`）。
这与本文件记过的「同一表达式出现两次、替换打到第一处」是同一条教训 ——
**换行数/取最后出现**，并在反向验证后**确认它真的变红**（假绿比不验证更危险）。

⚠️ **另记一处未修的小缺口**（不属本次报障，留给后续）：
`recommended-models` 实测还有第 4 个数组 **`clineCloud`**（3 条，如
`cline-cloud/glm-5.3`），而 `parseClineRecommendedModels` 只读
`free`/`recommended`/`clinePass` ⇒ 这批模型拿不到 `name`/`description`
（只能靠 `/models` 的裸 id 出现）。改动会影响模型列表内容，故未顺手做。

### ⚠️ 模型列表的**「计费/来源」分组**（用户要求，2026-10-01）

用户问「模型列表能够分组显示吗」→ 选定口径 **B：按计费/来源分 4 组**（而不是
按 67 个命名空间），并要求**每组一个「全开 / 全关」**。实测目录规模 **488 条**
（`openai` 104 / `qwen` 54 / `google` 41 / `anthropic` 29 …），平铺确实没法看。

**只有 Jet Hub 的「显示列表」能分组**；⚠️ **对话框里的模型选择器不能** ——
那是 harness 自己的 UI（`dsh-client-ui-model-selection`），它只按 **provider**
分组，`cline` 在里面必然是一个大组；我们能影响的只有每个模型的 id/name。

#### 分组口径（`plugin-src/client/model-groups.js`，纯函数）

| 组 | 判据 | 实测规模 |
|---|---|---|
| 订阅额度 | `cline-pass/*` | 18 |
| 免费额度 | **目录下发的 `isFree === true`** | 7（5 `cline-free/*` + 2 `stealth/*`） |
| Cline Cloud | `cline-cloud/*` | 有则显示；**空组不渲染** |
| 按量计费 | 其余全部（走账户余额结算） | 460+ |

⚠️⚠️ **免费必须用 `isFree`，不能在前端按前缀猜**：免费集合是远端
`recommended-models` 的 `free` 数组 + `:free` 后缀 + `cline-free/` 前缀的
**并集**（见 `cline-models.ts`），而 **`stealth/pixel-canary` /
`stealth/space-bunny-alpha` 在 `free` 数组里却不在 `cline-free/` 命名空间下**
—— 按前缀判会把这两条**免费模型错归进「按量计费」**，用户以为要花钱而不敢用。
⚠️ `isFree` **缺失**（老/外部适配器不报）时保守归入「按量计费」：那是兜底桶，
「没说免费」比「谎称免费」安全（与全仓「未知不编造」一致）。

#### 展开策略（`groupExpanded`）

优先级：**用户点过 > 有筛选 > 默认**。默认**「按量计费」折叠、其余展开**
（前者是兜底大桶、多数是关的，默认展开等于把列表撑到没法用）；**有搜索/筛选时
一律展开**（否则搜到的结果藏在折叠组里，看起来像「没搜到」）。
⚠️ **不要把默认值烘焙进 state**：只存「用户点过的组」，否则「清空筛选后恢复
默认」就做不到了。

#### ⚠️ 新增端点 `model.setDisabledMany`（按子集），**不能**复用 `setAllDisabled`

分组的「本组全开/全关」必须只动本组的 id。若图省事复用
`model.setAllDisabled`：**它的打开方向是「清空整张黑名单」** ⇒
「只打开订阅额度这一组」会把用户特意关着的**按量计费 460 多条一起打开**。

- 池新增 `AccountPool.clearModelsDisabled(provider, modelIds)`：**只删传入的 id**
  （与 `clearDisabledModels` 的「清空全部、并顺带清掉已下线死键」是**两个语义**，
  别混）；**无实际变更不落盘**（该组本就全开时不该产生一次文档重写 + 目录广播）。
- 端点：校验 `provider` / `modelIds` 数组 / `disabled` 布尔（**不猜默认值**，
  与另两个开关端点同约定），**去重 + 剔脏值后为空则拒**，只落盘一次、只广播一次。
- 反向验证：把打开方向改回 `clearDisabledModels` → 用例红
  （`expected {} to deeply equal { Object (buddy) }`，即「其它组的关闭项被一起清掉了」）。

#### `model.list` 新增 `isFree`（缺失不编造）

`ModelCatalogSource.listAllModels()` 的返回类型扩展为
`{ id, name, isFree?: boolean }`，`ClineAdapter` 填上（它来自目录合并的
`isFree`，与模型选择器里的「· 免费」标签**同源**）。RPC 层**照原样透传、缺失
就不写这个字段** —— 不编造 `false`（类型上是 `isFree?: boolean`）。

#### ⚠️⚠️ 验证盲区：客户端改动**单测全绿也不代表 bundle 能构建**

`plugin-src/client/*.js` 的改动在本仓库**只被两种方式验证**：纯函数单测 + 把
`jet-hub.js` 当**文本**读的源码级断言。二者都**不做语法解析** ⇒
**必须另跑 `pnpm build:client`（或 `build:all`）**。
本次真踩到：分组渲染用**块体箭头函数**（`group => { ... return ... }`），收尾括号
比原来的**表达式体**少一层，我多打了一个 `)` —— 3809 条单测全绿、esbuild 报
`Expected ";" but found ")"`。**改完客户端一律跑一次构建**。

回归用例 `tests/unit/model-groups.spec.ts`（21 条：归组 / 并集不丢模型 /
组内筛选与计数 / 展开策略 / 组内批量可用性 + 4 条源码级接线断言），
端点用例在 `tests/unit/jet-hub-rpc.spec.ts` 的 `model.setDisabledMany` 段（10 条）。
⚠️ 同时更新了 `model-filter.spec.ts` 里锁**旧平铺渲染**的那条断言
（`filtered.map(...)` → `group.models.map(...)`）—— 与以往同型：**旧断言可能锁死
被有意改掉的实现**。

### ⚠️ 额度窗口与请求记录**共享同一个翻页索引**（用户要求）

「订阅额度」弹窗改为：**一次只显示一个账号**，用左右箭头 `‹ ›` 翻页；
**额度窗口与请求记录一起切**（用户明确要求「统一切换」）。参考实现同款。

要点（多数是参考实现踩过的坑）：

- 索引是**纯本地状态**，**不要用 useEffect 播种**（列表一到就 set(0)）——
  那会让「浏览位置」与「显示的是谁」短暂分叉。当前账号在**渲染期纯计算**
  （`quota[Math.min(viewIndex, quota.length - 1)]`），越界钳制但**不回写**，
  账号恢复后还能回到原位。
- 翻页是**纯本地**（额度数据一次性取回），切账号时只有请求记录需要重新拉取。
- **环绕**：末个账号的右箭头回第一个（单向尽头会让用户以为「后面没了」）。
- 单账号**整行名字都不渲染**（参考实现同款：箭头无处可去，账号名也不构成
  区分信息）。「这是谁的额度」改由**弹窗副标题**给出（多账号 = `Cline · {n} 个账号`，
  单账号 = `Cline · 账号 {名}`）—— 否则单账号用户看不到是谁的额度。
- **竞态**：切账号会丢弃未完成的旧请求记录响应（按请求序号「最新获胜」），
  否则旧响应后到会覆盖新账号的数据。

### ⚠️ 与参考实现的**逐项对齐**（2026-09-30 用户报障「没有 1:1 还原」后重做）

**用户判据**：额度窗口与请求记录要么**逐项**与
`github.com/codeOct/dsh-cline-pass`（main @ `abab1dd`）一致，要么说明为什么不一致。
首版是按「精神」做的**子集**，故这次逐条对照后重做。已对齐项与**被推翻的旧实现**：

| 项 | 参考实现（main） | 首版（错） | 现状 |
|---|---|---|---|
| 记录表列 | **5 列含状态点**（绿/红点，title 给错误） | 4 列、无状态点 | ✅ 5 列 |
| 延迟列 | **三行**：首字 / 总耗时 / **输出速率 t/s** | 单行「首块 X · 共 Y」 | ✅ 三行 |
| TOKEN 列 | `↓入 ↑出 ⚡缓存 🧠推理`（图标 + k/M 有界缩写） | `123 + 456`，丢缓存 | ✅ 图标格式 |
| 未收 usage 帧 | 显示 **`—`**（≠ 花 0） | `0 + 0` ← **语义错误** | ✅ `usageReported:false` → `—` |
| 未知耗时 | **破折号 `—`**（`stamp`/`rate`） | 半角 `-` | ✅ `—` |
| TOKEN tooltip | 精确数字 + **图例**（`—` 的含义） | 只有一句替代文案 | ✅ `TOKEN_LEGEND` |
| 行 tooltip | 汇总 5 行事实（含**推理强度**） | 无 | ✅ 含 `effort` |
| 额度窗口布局 | **grid 卡片**（auto-fit / 170px）+ **18px** 大字百分比 | 纵向列表 + 13px | ✅ grid + 18px |
| 百分比 | `Math.max(0, Math.min(100, x))` + **取整** | 保留一位小数、**故意不夹** | ✅ 夹取+取整 |
| 进度条配色 | ≥90 红 / ≥70 黄 / 其余**绿**（`usageColor`） | ≥100 红 / ≥80 黄 / 其余**蓝** | ✅ 三档绿底 |
| 窗口顺序 | 已知窗口**固定顺序在前**、未知**追加在后** | 纯按网关原序 | ✅ `QUOTA_WINDOWS` |
| 账号块 key | 按账号 id → **重挂载**（进度条不跨账号动画） | 无 key | ✅ `key: entry.accountId` |
| 模型名 | 去 `cline-pass/` 前缀 + 上游 tag | 原样 | ✅ 去前缀 |
| 失败行 | 空 2 格 + **`colSpan 3`**（消息从模型列起） | `colSpan 4` | ✅ `colSpan: 3` |
| 表格 | 自带 **280px 滚动** + **sticky 表头** + 全列居中 | 靠弹窗滚动、左对齐 | ✅ 同款 |
| 列宽 | `colgroup` 提示（状态点 16px / 时间 82px） | 无 | ✅ `colgroup` |

⚠️ **被参考实现自己删除、我们也不补**：额度卡曾经有「token 用量 / 已用金额 /
折算剩余 token」——参考 `client.js` 的 `UsageCard` 注释明确写了那些数字是
*derived, unverifiable*，**作者已主动删除**，卡片只留「百分比 + 重置时刻」。
排查时不要再去参考的 README（不同 commit 的描述）里找这三项。

⚠️ **刻意保留的措辞差异**（不是漏改）：jet-hub 沿用本插件自己的命名
「**订阅额度**」/「**请求记录**」（参考叫「官方额度」/「最近请求」）——
按钮名是用户在前一轮明确指定的，改掉会让同一功能在两个入口有两套叫法。
除措辞外，布局、字段、格式化与配色全部对齐。

⚠️ **数据层随之扩了三件事**（缺任何一件都会让上面某行显示不出来）：
`usageReported`（`—` 的判据）、`cacheReadTokens`（`⚡` 那一项）、
`effort`（行 tooltip 的推理强度行）。三者都已接线
`cline-adapter → cline-request-log → jet-hub-rpc → types`，
并由 `cline-request-log.spec.ts` / `jet-hub-rpc.spec.ts` 锁死。

回归用例 `tests/unit/cline-quota-panel.spec.ts` **在 2026-09-30 被整体重写**：
旧断言锁的是首版自创形态（「百分比不夹取」「单行延迟」等），与用户给的判据
直接冲突，故换判据而非删断言。**不要照着旧断言改回去。**

### ⚠️ 五个实测坑（沿用参考实现已核实的结论，**不要重新踩**）

1. **分页参数只认 `cursor`**，值取自响应 `data.nextToken`。
   `nextToken` / `next_token` / `page` / `offset` / `skip` 作为**请求参数**会被网关
   **静默忽略** —— 永远返回同一页。早期据此连翻会**重复计数**，得出
   「已用 28 亿 token、超限 120%」这种荒谬结果。
2. **`data.total` 恒为 0**，不能用来算页数或总量。
3. **`/usages` 忽略 `startDate` / `endDate`**：只按时间**倒序**返回，
   要按窗口截断只能读每行的 `createdAt`。
4. **`resetsAt` 是 ISO 字符串**，不是数字时间戳 —— ⚠️ 故**不能**复用客户端的
   `formatTime()`（它按毫秒运算，传字符串会一律显示「已过期」，
   把 6 小时后重置的窗口说成已重置）。现由 `quotaCountdown` / `quotaResetsIn`
   负责（`Date.parse` + 粗粒度倒计时），记录表的「时间」列另用 `formatStamp`。
5. **`userId` 用凭据里的 `account_id`（`usr-…`）**，不是 JWT 的 `sub`（`user_…`）：
   后者实测 `400 Invalid request format`。而**额度端点用字面量 `users/me`**，
   不依赖 `account_id`（两者口径不同，别顺手统一）。

#### 设计要点（改这个功能前先读）

- **能力表两侧必须同时改**：客户端 `CREDITS_CAPABILITIES.cline.subscriptionQuota`
  决定按钮是否渲染；服务端 `cline.quota` / `cline.requestLog` 对非 Cline 一律
  `bad-request`。只改一边就是「按钮在、点了报错」或「功能存在却点不出来」。
  `credits-capabilities.spec.ts` 用**全表推导**守住「只有 cline 登记」。
- **`subscriptionQuota` 与 `balance` / `dailyCheckin` 语义独立，不能互相推断**：
  Cline 是「有余额、有订阅额度、无签到」，Loomy 是「有余额、有签到、无订阅额度」。
  合并成一个标志会让某个面板冒出不该有的按钮。
- **额度逐账号隔离**：一个账号凭据坏掉只让**那一张卡片**显示原因，其余照常。
  多账号用户不该因为一个号没配凭据就完全看不到额度。
- **「查询失败」与「没有额度窗口」必须分开渲染**：前者是错误（显示原因），
  后者是事实。合并成一句会让用户以为额度没了。
- **失败不得显示成 0%**：0% 是「这个窗口没用过」的合法语义；
  查询失败一律 `ok:false` + 原因（与其余 provider「查不到不显示成 0」同约定）。
- **请求记录的失败是载荷（`ok:false`）而不是 RPC 级错误**：
  面板要**保留已加载的行**、只把原因显示在表格下方；回成 RPC 错误会让整块换成错误页，
  翻页途中失败就把用户已看到的记录清空了。
- **百分比**：数值**夹取到 0–100 后取整**（参考实现），文案与进度条宽度共用
  `quotaPercentValue` 这**一个**值 —— 两处各算一次是「进度条 100%、文案 120%」
  这类不一致的来源。⚠️ 这条在 2026-09-30 **推翻了旧实现**（旧版故意不夹取）。
- **窗口顺序**：已知窗口（`five_hour` / `weekly` / `monthly`）按 `QUOTA_WINDOWS`
  固定顺序在前，网关下发的**未知窗口追加在后** —— 纯按网关原序会让新窗口插到中间，
  同一账号两次读数的排列都可能不同。未知类型的标签回落到 `type` 原值（不丢弃）。
- 按钮放在**面板级**而不是账号卡片的按钮行：那一行已有 5 个按钮且
  `flex-wrap: nowrap`，再塞一个必然溢出（「领取新手任务」当时就是这么被挤出去的）。
  且额度是**跨账号**读数，放面板级与语义一致。

#### ✅ 验证状态（哪些已实证、哪些还没有）

**已实发核对（2026-09-29，本机真实 Cline 账号，只读 GET、未触发续期）**：
端点与响应形状与解析层**完全一致** ——

- `/users/me/plan/usage-limits` → `data.limits[]`，`type` ∈
  `five_hour` / `weekly` / `monthly`，带 `percentUsed` 与 `resetsAt`；
- `/users/{account_id}/usages` → `data.items[]` + `data.nextToken`，行含
  `createdAt` / `aiModelName` / `aiModelTypeName` / `totalTokens` /
  `creditsUsed` / `costUsd`。**用 `account_id`（`usr-…`）实测可用**。

两个实测形态已写进用例：

- `resetsAt` 是**纳秒**精度（9 位小数），如 `2026-09-29T15:41:02.244817775Z`
  —— 解析层**原样保留**（不截断、不归一化），`Date.parse` 可解析；
- 用量为 0 的窗口 `resetsAt` 是**空串** —— 客户端因此**不渲染**那一行
  （渲染一个空的「重置」会让人以为读取失败）。

⚠️ 探针**没有入库**（`tests/e2e/tmp-*.ts` 用完即删）。需要复核时：照
`tests/e2e/cline-credential.ts` 读凭据，再调 `fetchClineUsageLimits` /
`fetchClineRequestLog` 即可（**只读、不要续期**）。

⚠️ 顺带发现（**与本功能无关，刻意未改**）：`readClineCredentialsFromDshStore()`
对本机当前的 `.credentials.yaml` 读出 **0 个账号** —— `extractYamlScalar` 取出的
标量**尾部多 2 个杂字符**，`JSON.parse` 抛错后被该助手的 `catch` **静默跳过**。
探针是靠「只取第一个完整 JSON 值」绕过的。若哪天别的 Cline e2e 报
「0 个账号」，根因多半在这里，而不一定是凭据真的不存在。

**已做**：`pnpm typecheck`、`pnpm test`（新增 54 条：`cline-quota` 32、
能力表 3、RPC 端点 9、客户端接线 10）、`pnpm build:all`，并已安装到本机 profile
（`lib/` 330 个文件**全量哈希一致**）。全量测试
**1 failed | 3155 passed**，那 1 项是既有失败（`loomy-docs` 缺被 gitignore 的文档；
另有 `cline-icon` 缺不入库脚本，属套件级加载失败）。

**未做**：GUI 点击级实测（`/api/jet-hub` 需浏览器登录态，直接调用返回 401，
与既有记录一致）。

⚠️ **改了宿主侧（`src/`）必须重启 DSH 才生效**：客户端 bundle
（`lib/client/jet-hub.js`）会被 `dsh-client-hmr` 热加载（刷新页面即可，无需重启），
但 `cline.quota` / `cline.requestLog` 是**宿主侧**端点 —— 不重启只会看到
「按钮出来了、点了报 unknown method」。

### ⚠️ 修复记录：首版弹窗漏了 `.dim-jh-modalBody` + 数字列右对齐被压过
（2026-09-29 用户报障：「弹窗位置不正确。内容显示不正确」）

**根因一（位置）**：弹窗内容直接铺在 `.dim-jh-modal` 里，没包 `.dim-jh-modalBody`。

`.dim-jh-modal` 是 `max-height: min(640px, calc(100vh - 48px))` 的 flex **列**容器，
子项默认不可收缩（没有 `min-height: 0` / `overflow`），内容一多就
**画出弹窗边界之外** —— 额度卡 + 请求表叠加，视觉上就是「弹窗错位、内容错乱」。

**修法**：内容包进 `.dim-jh-modalBody`（`flex: 1 1 auto; min-height: 0;
overflow-y: auto`，见样式）。模型列表弹窗同款 —— 它的 error / loading /
empty / 列表四个分支**全部**在 modalBody 里，只有 modalHead / modalHint /
筛选条 / 批量工具条在外面。

**根因二（内容）**：`.dim-jh-quotaNumCol { text-align: right }` 的优先级
**(0,1,0)**，压不过 `.dim-jh-quotaTable th/td { text-align: left }` 的
**(0,1,1)** —— 右对齐**静默失效**：表头左对齐、数据右对齐，列错位。

**修法**：复合选择器
`.dim-jh-quotaTable td.dim-jh-quotaNumCol, .dim-jh-quotaTable th.dim-jh-quotaNumCol`。
这正是参考实现 README 里「429 错误行撑宽请求记录表格」的**同一个选择器强度
问题**（那边是 `(0,1,1)` 的 `td{white-space:nowrap}` 压过 `(0,1,0)` 的
`.cp-history-error`，解法同样是复合选择器）。

⚠️ 两条都已有**反向验证**（注入缺陷 → 对应断言变红，其余 8 条不受影响），
用例在 `tests/unit/cline-quota-panel.spec.ts` 的
「弹窗内容在 .dim-jh-modalBody 滚动区里」与「数字列右对齐用复合选择器」。

顺带吸收参考实现的既有经验：时间列**定宽 82px**（防时间戳被截断）、
模型名 `word-break: break-word`（长模型名不撑宽表格）。

## ⚠️ Cline 限流：倒计时用**报文里的人类可读时长**，402 不许倒数（真实报障两次，2026-10-03）

**用户报障 ①**：「倒计时结束了我再去连为什么还是失败了，显示要 60 分钟后？」
**用户报障 ②**（当晚，第一次修完并重启后）：「还是 60 分钟，而且连余额也查询失败了」

### 第二次报障推翻的结论（**这是本节最值钱的一条**）

第一次修复时我**只按文档推断**，在注释里写下「Cline 在 429 上**会给出** `retry-after`
（官方错误码表 + 它自己客户端的 long-retry-after 分支）」，于是只加了「读响应头」。
**实测证伪** —— 直连取证（`probe-cline-live.mjs`，2026-10-03 23:10）：

```
POST https://api.cline.bot/api/v1/chat/completions   model=cline-free/deepseek-v4.1-flash
→ HTTP 429
  date: Sat, 03 Oct 2026 15:10:33 GMT
  no-retry: true                       ← 没有任何 retry-after / x-ratelimit-reset
  x-request-id: JvXBMYgDCJKhLXnaJOXdzCnouwNjqVlJ
  {"error":{"code":"INFERENCE_CAP_ERROR",
    "message":"Error 429: Daily free limit reached on model
               deepseek/deepseek-v4.1-flash. Try again in 19h 39m"}}
```

⇒ 真实等待是 **19 小时 39 分**（当日免费额度），而代码读到的是「没有时间」→ 退回
**1 小时的快照兜底**。用户等满 1 小时再试当然还是 429，而且每失败一次就从当下重算
一小时 ⇒「永远 60 分钟」可以无限循环。

⚠️ **两条可复用的教训**：

1. **「报文里没有机器可读的时间」≠「报文里没有时间」**。Cline 把时长写在**英文句子**
   里（`Try again in 19h 39m`）。同类句式还有 `Try again in 5m` / `1h 30m` / `45s`。
   排查限流务必把**原始报文原文**打出来看，别只看响应头。
2. **文档推断不能当实测**。上一版的结论来自官方错误码表，方向对（Cline 确实分
   WAIT/STOP），但**协议细节是错的** —— 这与 qoder「某次实测没看到就推广成不存在」、
   TRAE「带 code 的回调」是同一类错误。

### 429 有**三种**语义，动作互不相同（都只能靠文案区分）

| 形态 | 判据（报文原文） | 正确动作 | 处理 |
|---|---|---|---|
| **当日免费额度** | `Daily free limit reached` + `Try again in 19h 39m` | **等不到头**；改用同一账号的**另一个免费模型** | 标记 = 服务端给的时长；文案只说「按天结算、按模型单独计 + 预计 N 小时后重置 + 可先改用其它免费模型」 |
| **短时限流** | `Rate limit exceeded` 一类 | 等一会儿 / 换账号 | 标记 = 报文时长 → 头 → 兜底 1 小时 |
| **402 额度耗尽** | `Insufficient credits` | 去 app.cline.bot 充值 | **不写倒计时**（但仍换号） |

⚠️ **免费额度是「按模型」单独计的**（同一时刻实测，同一个账号）：

| 模型 | 结果 |
|---|---|
| `cline-free/deepseek-v4.1-flash` | 429 `Daily free limit reached … Try again in 19h 29m` |
| `cline-free/mimo-v2.6-flash` | **200** |
| `cline-free/muse-spark-1.3-contributor` | **200** |

标记也只能落到那一个模型键上（`modelRateLimits[model]`）。

⚠️⚠️ **`cline-pass/*` 不是「有余额就能用」的备用通道** —— 第一版建议写成
「改用同一账号的 `cline-pass/*` 付费通道（走账号余额）」，**实测证伪**：

```
POST /api/v1/chat/completions  model=cline-pass/deepseek-v4.1-flash
→ HTTP 403 {"error":{"code":"ENTITLEMENT_ERROR",
             "message":"Error 403: the user is not subscribed to required model plan"}}
```

该账号**有余额**（`/balance` → `balance: 500000`）但**没有订阅计划**
（`/users/me/plan/usage-limits` → `404 no plan history found for user`）。`cline-pass/*`
是**订阅**通道 ⇒ 文案里**不许再提它**。教训与本节第 2 条同源：**推荐动作必须实测过**
（我凭「有余额就走付费」的直觉写了一句话，用户照做只会再撞一次墙）。

### 三处根因（第一次报障的 1~3 + 第二次报障的 4~5）

1. **写死的 60 分钟，且没有 Cline 专属解析**：标记写的是 `Date.now() + 3_600_000`。
   **证据**：`~/.dsh/jet-hub/state.json` 里 cline 那条是 `…:59.963Z` —— `.963`
   毫秒正是 `Date.now()+3_600_000` 的指纹（同一文件里 buddy 的 `…:07.000Z`、
   codearts 的 `16:00:00.000Z` 都是「整」值）。
2. **402 也被记成倒计时**：官方语义是 `Insufficient credits`，**等多久都不会恢复**。
3. **被自己的标记挡住时报「请先登录」**：池把被标记的账号筛掉（`account-pool.ts`
   的 `Date.now() >= resetAt` 过滤）→ `resolveCredential` 回 `undefined` → 适配器抛
   `cline: no usable credential; log in first`。凭据明明在、账号也登录着，用户却被
   指去重新登录。这与 buddy 那次（`buddy-ratelimit-misreport.spec.ts` 记着）**同型**：
   buddy / workbuddy 早已接上 `throwIfAllAccountsRateLimited`，**cline 漏了**。
4. **只读响应头 ⇒ 实测报文下仍然退回 60 分钟**（见上「第二次报障」）。
5. **⚠️ 换号预算用尽时，最后失败的那个账号从来没被标记**：原来的写法把标记放在
   **下一轮的开头**（`for` 里第一件事就是标记「上一轮失败的那个账号」），于是当
   `round` 用尽而退出循环时，**最后一个**账号永远不会被标记 —— 它下一次又被
   `getAvailableAccount` 选中，立刻再撞一次同样的墙。本机 cline 只有**一个**账号，
   这条尤其致命（`getAvailableAccount` 立刻返回 null 就退出，看似「标记了」）。
   ⇒ 现在 `markLimited()` 在**每次失败后**调用（用 `markedAccountId` 防重复），
   循环结束后再补一次。

**修法（勿回退）**：

| # | 改什么 | 位置 |
|---|---|---|
| 1 | 标记时长取值序：`retry-after` 头（秒数 / HTTP 日期，**0 是合法值**）→ **报文里的 `Try again in 19h 39m`** → 通用绝对时刻句式 → 兜底快照 | `src/cline-rate-limit.ts` 的 `clineRateLimitResetAt` |
| 2 | `recordsClineRateLimit` **只认 429**（402 不写徽章，但仍换号 —— 「不写徽章 ≠ 不换号」） | 同上 |
| 3 | cline 的 `resolveCredential` 接上共享的限流判定助手（`throwIfAllAccountsRateLimited`），且**必须先于**单凭据 ref 兜底。⚠️ Task 6 起该判定已下沉进 `src/credential-resolver.ts` 的共享工厂：接线判据变成「cline 的工厂配置项把该助手交给了工厂」，不再是逐个 provider 的调用点文本 | `src/index.ts` |
| 4 | 全部账号失败时按「免费额度 / 短时限流 / 402」给**三种不同**建议；**识别出语义就不再复述上游原文**（只在没识别出时附上），文案保持简短 | `clineExhaustedAdvice` |
| 5 | 每个失败账号（含最后一个）都写标记 | `cline-adapter.ts` 的 `markLimited` |

⚠️ **这三件事收敛在 `src/cline-rate-limit.ts` 一处**（原先 `clineExhaustedAdvice` /
`recordsClineRateLimit` 在适配器里、解析在别处，改一处必漏另一处）。

⚠️ 时长 token 的正则**必须带尾部 `(?![a-z])`**：`minutes?` 与 `m` 两个分支都能匹配
`2 minutes` 里的 `m`，少了它会把 2 分钟算成 4 分钟（时长直接翻倍）。
⚠️ 共享的全局正则**每次用前重置 `lastIndex`**（`matchAll` 会复制 `lastIndex`），
否则第二次调用的结果随调用次数漂移。

### ⚠️ 报错**文案的长度**也是需求（真实报障第三次，2026-10-03）

用户原话：「可以，cline 显示正常，不过这个报告和其它的供应商比起来是不是太长了？改简短点吧。」

**病根不是话说错，而是同一件事说了两遍**：

```
cline: 模型 cline-free/deepseek-v4.1-flash 的所有账号均不可用（HTTP 429 Error 429: Daily free
limit reached on model deepseek/deepseek-v4.1-flash. Try again in 19h 39m）。这是该模型的**当日
免费额度**已用尽（HTTP 429 Daily free limit reached）—— 免费额度按天结算、且**按模型单独
计算**，盯着它等不会提前恢复，服务端给出的解禁时刻是 2026/10/4 18:49:21（约 18.7 小时后）。
要立刻继续，可改用**同一个账号的另一个免费（cline-free/*）模型**，或换其它 provider / 账号
```

`（…）` 里那段是**上游英文原文**，后面的中文又把它解释了一遍 —— 两者信息完全重叠，
消息长度因此是其它 provider 的两三倍（对照：`lobsterai` 的
`模型 X 所有账号均不可用（明细）` ≈ 60 字符、`codearts` 的额度文案 ≈ 100 字符）。

⚠️ 第二个坑：**错误气泡不渲染 markdown**，`**加粗**` 会**原样显示星号**
（用户截图里就是 `**当日免费额度**`）。错误消息只能写纯文本。

**修法**（`clineExhaustedAdvice`）：

| # | 规矩 | 判据 |
|---|---|---|
| 1 | **识别出语义就不再复述原文**（免费额度 / 402 两种都识别得出），只留「是什么 + 何时恢复 + 现在改用什么」 | 单测 `not.toContain('Daily free limit reached')` |
| 2 | **没识别出语义时仍附原文**（那是唯一排障线索） | 单测 `toContain('Rate limit exceeded')` |
| 3 | 纯文本，不用 `**` | 单测 `not.toContain('**')` |
| 4 | 长度上限：单条建议 < 100 字符、最终 `error.message` < 150 字符 | 单测的长度断言（改文案别撑回去） |

改后同一条消息：**135 字符**（原 ≈ 270）。

```
cline: 模型 cline-free/deepseek-v4.1-flash 的所有账号均不可用 —— 当日免费额度已用尽（HTTP 429），
预计 19.7 小时后重置（2026/10/4 19:49:20）；额度按天结算、按模型单独计 —— 可先改用其它免费模型
```

⚠️ **代价**：这条路径的报文**不进请求记录**（`stream()` 在 `consumeWithLog` 之前就抛了），
所以「原文」不再出现在任何面向用户的地方 —— 排障时按本文件上方那节的思路重跑一次直连探针即可
（`parseClineRateLimitHint` 只认 `Daily free limit reached` 这个标记，得到的中文结论是可反推的）。

### 余额查询「fetch failed」是**另一回事**（不是本次改动造成的）

面板那次 `余额查询网络失败：fetch failed` 与限流无关，且**不可复现**：`probe-cline-stability.mjs`
对 `GET /api/v1/users/{id}/balance` 连打 5 次全部 **HTTP 200**（`balance: 500000`）。
它是插件宿主进程里的一次**瞬时传输失败**（`fetch failed` 是 undici 的连接层 TypeError）。
⚠️ 关键**反证**：面板的积分/额度走 `ctx.credentials.resolve`，**不经过**
`resolveCredential`，所以第 3 条那个限流前置检查**碰不到它** —— 别把它算到限流修复头上。
排查时先直连同一端点看是否健康，再怀疑代码。

⚠️ 顺带实测（同一探针）：`GET /api/v1/users/me/plan/usage-limits` 对该账号回
**404 `no plan history found for user`** —— 这是「没有订阅计划」的**正常**形态（不是故障），
「订阅额度」那一行据此显示原因即可。

**回归用例**：`tests/unit/cline-rate-limit.spec.ts`（19 条：实测报文 → 19h39m + 认
`Daily free limit` / 单位可省略 / 多段累加 / `2 minutes` 不翻倍 / `0s` 合法 / 句末无关数字
不计数 / 非 JSON 与 `{error:"…"}` 外壳 / 取值优先级四条 / 三种建议话术）、
`cline-adapter.spec.ts` 的「限流标记」段（8 条：429+头 → 用 600 秒 / 429 无头 → 1 小时快照 /
HTTP 日期 / **★ 实测报文 → 19h39m，且文案**不含**原文、含「按天结算」「按模型单独计」、
长度 < 150** / **★ 轮次用尽时最后一个账号也被标记** / 402 不写标记且文案含「充值」 /
无池账号不写标记）、`tests/unit/retry-after.spec.ts`（10 条）、
`buddy-ratelimit-misreport.spec.ts` 的「cline 同型缺陷」接线段（4 条）。
⚠️ 已做**反向验证**：把「报文时长」那条分支短路 → 2 条变红；去掉循环后的补标记 → 2 条变红。


## ⚠️ Cline provider：`workos:` 前缀不可剥、免费集合动态下发

`cline` 是**第六个脉系**（独立一套 `src/cline*.ts`）。协议全部由本机 Cline 桌面端
产物逆向 + 实测得出（2026-09-25）：

- 二进制 `C:\Users\Jet\AppData\Local\Cline\code-sidecar.exe`（bun 单文件，144 MB）
- 真实凭据 `C:\Users\Jet\.cline\data\settings\providers.json`
- 排查脚本（只读）：`scripts/probe-cline-endpoints.mjs`（按关键词提取二进制字符串
  窗口）、`probe-cline-models.mjs`、`probe-cline-recommended.mjs`、
  `probe-cline-balance.mjs`、`probe-cline-chat.mjs`
- 设计文档：`docs/superpowers/specs/2026-09-25-cline-provider-design.md`

### ⚠️ 坑 1：`Authorization` 必须原样带 `workos:` 前缀（剥掉即 401）

源码 `resolveApiKey` **原样使用存储值**，而 Cline 磁盘上存的就是
`workos:eyJ…`。该前缀只在**解码 JWT** 时被剥掉
（`decodeJwtPayload(token.replace(/^workos:/, ""))`），**从不出现在请求头构造里**。

实测（`tests/e2e/cline-probe.e2e.spec.ts` 会现场复验，同一凭据）：

| Authorization | `/api/v1/users/me` |
|---|---|
| `Bearer workos:eyJ…`（**原样**） | **200** |
| `Bearer eyJ…`（剥掉前缀） | **401** |

⚠️ 401 文案是 *"make sure you're using the latest version of Cline and
re-authenticate your Cline account."* —— 与真实原因**毫不相干**，会让人误判成
「客户端版本过旧」。实现见 `clineBearerValue`（幂等补齐，两种形态都接受）。

### ⚠️ 坑 2：免费模型是**独立 id**，且只由 `recommended-models` 下发

`cline-free/mimo-v2.6-flash`（免费）与 `xiaomi/mimo-v2.6-flash`
（按量计费）是**两个不同条目**。绝不可用「名字含 mimo」之类模糊匹配判免费 ——
那会让用户按免费预期使用却被计费。

两个端点**必须都打**，理由各有实测依据：

| 端点 | 内容 | 认证 |
|---|---|---|
| `GET /api/v1/ai/cline/recommended-models` | `{recommended[], free[], clinePass[]}`，**唯一权威的 free 集合** | **不需要** |
| `GET /api/v1/models` | 460 个 `{id, object, created, owned_by}` —— **只有 id**，无 name/上下文 | 需要 |

⚠️ 实测 `/models` 的 460 个 id 里 **`cline-free/*` 零命中** —— 免费模型**只**由
`recommended-models` 下发。这就是「只调 `/models` 会看不到任何免费模型」的原因。
`tests/e2e/cline-probe.e2e.spec.ts` 用断言锁死了这一事实（若某天 `/models` 也开始
下发它们，该用例会失败并提示可简化实现）。

判定规则（`isClineFreeModel`，**不硬编码模型名**）：
远端 `free` 集合 ∪ `:free` 后缀 ∪ `cline-free/` 前缀 ∪ 兜底表 `isFree`。
与 CodeArts benefit 集合同一约定。

⚠️ **兜底表要与远端 `free` 数组同步**：sidecar 内嵌目录里**没有** `cline-free/*`
与 `stealth/space-bunny-alpha`（只有远端 `free` 下发），故 `cline-product.ts` 的兜底表
手工补上它们 —— 否则离线时用户看不到免费模型。

⚠️⚠️ **兜底表是编译期快照，会落后 —— 且陈旧条目曾让用户「选中即 404」**
（真实报障 2026-10-05）：`cline-free/deepseek-v4.1-flash` 被移出远端 `free` 数组
（**3 条**）后，仍以「免费」出现在模型列表里，用户选中即回
`404 {"error":"model not found"}`。**重启不会消失** —— 合并发生在每次全新加载时。

根因：`mergeClineModels` **无条件**把整张兜底表并回结果，且
`isClineFreeModel` 对 `cline-free/` 前缀恒判免费。
**已修**（本分支）：兜底表改为**有条件并入** —— 远端成功下发目录时丢弃
「远端已不认识」的条目，只在远端不可用时整表兜底。
判据用 `remote.entries.length > 0` 而**非** `freeIds.length > 0`：后者在
「上游把免费模型**全部**撤掉」时也合法为空，只看它会把「全撤」误判成
「端点挂掉」，反而保留整张已失效的表。

⚠️ **已发生两次，同步清单**（**别照抄旧版本的表把它们加回来**）：
`gemini-3.8-flash`（2026-10-03）、`deepseek-v4.1-flash`（2026-10-05）。
判定「某个兜底免费模型是否已被下架」用 **`pnpm test:e2e:cline`**（只读、零额度）。

⚠️ **审计过全部 13 张兜底表，不能一刀切**（2026-10-05）：只有 cline 是「**并入型**」
（`mergeClineModels` 无条件并回）故有此缺陷；buddy / codebuddy / workbuddy 是
「**白名单型**」（`reconcileWithFallback` **以兜底表为准**，做目录比对反而会删掉
「你权用、只是 CLI token 看不到」的可用模型 —— 见 `product.ts` 里 `hy4-preview`
的补录注释）；lobsterai / loomy / minimax / raccoon / trae / zcode / gemini /
opencode 是「**仅回退型**」（`remoteModels ?? fallback`，远端整体替换，无双源合并）；
qoder / qoder-cn 端点是 WASM 签名、兜底表是唯一来源，无数据可比对。

⚠️ **`clinePass` 不是免费集合**：它是 Cline Pass 订阅制模型（`cline-pass/*`），
按订阅额度计费。实测 14 个，误判为免费会误导用户。

### ⚠️ 坑 3：思考字段是 `delta.reasoning`，不是 `reasoning_content`

实测 Cline SSE 形如
`{"delta":{"reasoning":"The","reasoning_details":[…]}}`，而
`reasoning_content` 是 Qoder / buddy 的形态。`src/openai-compat.ts` 的
`consumeOpenAiSse` 因此**同时认两者**（`delta?.reasoning_content ?? delta?.reasoning`）。
只认前者会让 Cline 的思考内容被静默丢弃（表现为「模型不思考」，且 reasoning
档位切换看似无效）。e2e 探针实测已确认思考内容真的产出。

### ⚠️ 坑 4：思考档位**远端不下发**，只能来自客户端内嵌目录

IDE 的模型选择器旁有思考强度菜单（`None / Low / Medium / High / Extra`），
但**远端两个模型端点都不下发档位**：`/api/v1/models` 只有
`{id, object, created, owned_by}`，`recommended-models` 只有
`{id, name, description, tags}`。sidecar 内 `/api/v1/` 的 21 个路径中也没有
任何模型详情端点（`/api/v1/users/me/remote-config` 返回 `{"data":null}`）。

档位只存在于 `code-sidecar.exe` 内嵌的 `BUILTIN_MODEL_CATALOG` 的
`reasoningOptions`，而那张表覆盖不了远端 460 个 id。故 `CLINE_REASONING_EFFORTS`
对**所有**模型统一给 5 档。

⚠️ **`id`（wire 值）与 `name`（展示名）不是同一个概念**。最高档的对应关系
（`Extra` → `max`）是**行为实测**出来的，不是反推的：

| effort | reasoning 字符数（`stealth/space-bunny-alpha`，同题 3 次采样均值） |
|---|---|
| 不传 / `none` | 0（**不传 = 不思考**） |
| `low` | 67 |
| `medium` | 379 |
| `high` | 294 |
| `xhigh` | **259（与 high 无可辨差异 → 伪档位）** |
| `max` | **1192（high 的 4 倍 → 最高档）** |

若只按名字对齐（`xhigh` → 显示成 XHigh），会给用户一个**实测无差异的档位**，
而真正的最高档 `max` 反被跳过。旁证：sidecar 权重表
`{ max:1, xhigh:0.95, high:0.8, ... }` 同样确认 `max` 在 `xhigh` 之上。

⚠️ **上游对不认识的档位静默忽略而非报错**（实测 `reasoning_effort: 'banana'`
返回 HTTP 200、思考量为 0）—— 故 `stream()` 里**绝不能加白名单校验**：
校验既无必要，又会把上游未来新增的档位变成静默丢弃。

⚠️ **声明 `defaultEffort` 会改变默认行为**：实测不传档位时模型完全不思考，
而 DSH 在用户未选择时自动采用 `model.reasoning.defaultEffort`。本插件默认
`high`（对齐 IDE 截图的选中态），代价是思考 token 计入 `completion_tokens`。

⚠️ 统一给档位的**已知局限**：对不在内嵌目录里的模型，档位是猜的 ——
最坏情况是「开关无效」（上游静默忽略），不会是「请求失败」。

排查脚本：`scripts/probe-cline-reasoning.mjs`（纯本地，只读）、
`scripts/probe-cline-effort-compare.mjs`（**消耗免费额度**，多次采样对比档位）。
设计文档：`docs/superpowers/specs/2026-09-25-cline-reasoning-effort-design.md`。

### ⚠️ 坑 5：Gemini 系有两个**独立**的 400，且各自只在部分 provider 上暴露

⚠️ **2026-10-03 补记**：`cline-free/gemini-3.8-flash` 已被 Cline 下线（不在 `free`
数组里、直连回 `404 model not found`），故兜底表里那条已删除。本节保留为**历史记录**，
因为两个根因的教训与模型无关：**①表里的数值必须实测**（别照抄邻居的值）、
**②`sanitizeClineToolParameters()` 是为所有模型服务的安全网**（任何严格校验工具
`enum` 的上游都会踩到），二者都**不可因这条模型下线而回退**。

用户报障（2026-09-25）：给 `cline-free/gemini-3.8-flash` 发消息即失败。错误体里
一次请求有**两个 provider 尝试、两个不同的错误**：

| provider | 错误 |
|---|---|
| `vertex` | `maxOutputTokens value of 131072 but the supported range is from 1 to 65537` |
| `google` | `tools[0].function_declarations[34].parameters.properties[permission].enum[3]: cannot be empty` |

⚠️ **不要只修一个** —— 上游会依次 fallback，命中哪个 provider 就暴露哪个错误，
路由一漂移就复发。

**根因 1（我们的错）：兜底表数值凭印象填。** `cline-free/gemini-3.8-flash` 不在
sidecar 内嵌目录里，当初手工补表时照抄了其它免费模型的 `131072`；而同名
`google/gemini-3.8-flash` 的实测值是 **65536**，上游上限即 65536。
这与 Qoder 那条「本表数值必须逐条对照，不要凭印象填」是**同类错误**。

**根因 2（必现）：工具 schema 的 `enum` 含空串。** harness 下发的工具集里某些
参数的 `enum` 带空字符串成员，Gemini 系严格校验直接 400。
⚠️ 本适配器**从不自己造 enum**（`stream()` 原样透传 `tool.parameters`），
脏数据来自上游 harness —— 但请求是我们发的，只能在我们这侧拦住。
`sanitizeClineToolParameters()` 递归清洗，三条边界：只删空串（保留数值枚举）、
全空则丢弃 `enum` 键（空 `enum` 同样非法）、递归下钻 `properties` / `items`。

⚠️ **排障时注意：这两个 400 都不是必现的。** 实测同一 `max_tokens=131072`
连发 3 次都返回 200（那几轮没命中 vertex）。判定依据是错误体里的
`providerMetadata.gateway.routing.modelAttempts[].providerAttempts[]`，
不是重试次数 —— 别因为「重发一次就通了」而误判为偶发。

⚠️ 顺带：本机 `~/.cline/data/settings/providers.json` 里的 `accessToken` **常常过期**
（实测过期 1 小时，直接请求得到 401），排查前先续期；续期返回的是**裸** JWT，
必须补 `workos:` 前缀才能用（坑 1）。

排查 / 验证脚本：`scripts/probe-cline-gemini-400b.mjs`（对照复现两个根因）、
`scripts/verify-cline-gemini-fix.mjs`（走已编译 `lib/` 的端到端验证，三个场景）。
均**消耗免费额度**。

### ⚠️ 坑 6：403 不都是凭据问题 —— 地域限制会被误报成「API 密钥无效」

用户报障（2026-09-25）：`cline-free/muse-spark-1.3-contributor` 提示
「**API 密钥无效**」，但凭据是好的。

该中文文案**不是本插件抛的** —— 它来自 DSH 客户端 `failureMessage()`：

```js
return code === "AUTH" ? t("message.failure.auth") : message
```

即**只要错误码是 `AUTH`，真实原因就被替换成「API 密钥无效」**；非 `AUTH` 则
原样显示 message。而 `httpErrorCode()` 把 401/403 **一律**映射成 `AUTH`。

⚠️ Cline 对「该地区不可用」的模型也返回 **403**：

```
403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor
     is not available in your region","success":false}
```

于是故障链是：403 → 当作凭据过期 → **白跑一次续期**（续期还会成功，所以不提前
报错）→ 重试仍 403 → 归成 `AUTH` → UI 显示「API 密钥无效」。真实原因彻底丢失，
用户以为要去重新登录。

修法：`isClineRegionForbidden()` 按**响应体文案**识别（不能按状态码一刀切 ——
同一批 403 里既有真凭据问题也有地域限制），命中时**跳过续期**并抛
`PERMISSION_DENIED`（该码不在 DSH 默认可重试集合内，不会反复重试）。

⚠️ 顺带修了 `errorDetail()`：Cline 的错误体是 `{error: "<文案>", success:false}`，
而该函数原本只认 `code` / `message` / `msg` → 整个 JSON 原样返回，用户看到一坨
裸 JSON。现已补 `error`（字符串与嵌套对象两种形态都认）。这是**共享函数**，
Qoder 同样受益，改动已由全量单测覆盖。

排查 / 验证脚本：`scripts/probe-cline-muse-403.mjs`（直接看真实状态码）、
`scripts/verify-cline-region-fix.mjs`（走 `lib/` 验证错误码与续期次数）。
均**消耗免费额度**。

### 登录：WorkOS 设备码（与 Qoder 同为轮询式，但判据形态不同）

```
POST {workOsBase}/user_management/authorize/device   → device_code / user_code / verification_uri
轮询 POST {workOsBase}/user_management/authenticate  → 200 {access_token, refresh_token}
     grant_type=urn:ietf:params:oauth:grant-type:device_code
POST {apiBase}/api/v1/auth/register  body {accessToken, refreshToken}
  → {success:true, data:{accessToken, refreshToken, expiresAt, userInfo:{clineUserId, email}}}
```

⚠️ **`authorization_pending` 不是错误**，必须继续轮询 —— 它是「用户还没在浏览器里
点授权」。与 Qoder 的「404 表示尚未授权」是同一类语义，但**判据形态完全不同**
（Qoder 看 HTTP 状态码，Cline 看响应体的 `error` 字段）。`slow_down` 必须**累积
退避**（源码 `intervalSeconds += 1`）。

⚠️ **响应套 `{success, data}` 信封，字段名是驼峰** `accessToken`（不是
`access_token`）。判据是 `success && data.accessToken`（源码
`requireClineTokenResponse`），只看裸字段会把失败信封当成功。

### 续期：字段名是驼峰 `refreshToken` + `grantType`

```
POST {apiBase}/api/v1/auth/refresh
body: { "refreshToken": <refresh>, "grantType": "refresh_token" }
```

⚠️ **不是 OAuth 标准的 `refresh_token` / `grant_type`**（源码 `refreshClineToken`）。
两者都必填；写错字段名服务端不会明确报「缺字段」，而是回一个泛化的认证失败。

### 积分余额：只有余额，**没有签到**

```
GET {apiBase}/api/v1/users/{accountId}/balance
  → { data: { userId, balance: 500000 }, success: true }
```

⚠️ **`userId` 用凭据里的 `account_id`（`usr-…`），不是 JWT 的 `sub`（`user_…`）**：
实测传 `sub` 返回 `400 {"error":"Invalid request format"}`。

⚠️ **401 的响应体是 `{error:"…"}`，没有 `success` 字段** —— 解析器必须两种失败形态
都认，否则 401 会落到误导性的「响应缺少 data 字段」，把服务端给的唯一有用线索丢掉
（真实缺陷，已由 `tests/unit/cline-credits.spec.ts` 锁死）。

⚠️ **余额单位**：实测 `balance: 500000`。按 1e-5 USD 解释为 **$5.00**，与 Cline
公开的新账号赠额一致 —— 这是选取 `CLINE_BALANCE_SCALE = 100000` 的独立锚点。
⚠️ **不要用 `/usages` 的 `costUsd` 反推该系数**：实测单次记录
`{creditsUsed:0, costUsd:1320, totalTokens:49}`，按 1e-5 解释会是 $269/1M token
（flash 档不可能），说明两者**口径不同**。只读 e2e 探针会打印原始值供核对。

**签到不存在**：对整个 sidecar 做字符串扫描，`checkin` / `check-in` / `daily` /
`campaign` 均无任何 Cline 业务端点命中（`campaign` 的命中是 PostHog 的 UTM 参数与
feature-flag 事件属性；`daily` 是 YAML cron 别名与 Blob 导出频率枚举）。故能力矩阵
登记为 `{balance:true, dailyCheckin:false}`（与 WorkBuddy 国际版同例）。
⚠️ 这比「某次调用没看到」强，但仍不等于「永远不存在」—— 若将来增加签到，需按
Qoder 那次教训重新采集。

### e2e 闸门（付费保护，**请勿削弱**）

```
DSH_CLINE_E2E=1                          只读探针（凭据/前缀证据/余额/免费集合）
DSH_CLINE_CHAT_E2E=1 + ..._CONFIRM=yes   默认**只**请求 cline-free/deepseek-v4.1-flash
DSH_CLINE_CHAT_E2E_ALL_FREE=1            才遍历其余 4 个免费模型
```

理由：免费资格是**服务端随时可撤销**的营销状态。无条件遍历「远端此刻说免费」的
那批模型，某天某个转为计费后，一次 e2e 就会**按付费价刷 token**。

`assertFreeModel()` 是安全边界：任何 `isFree === false` 的模型（无论来自
`DSH_CLINE_MODEL` 还是远端列表）都**直接抛错、不发请求**；遍历分支还做逐个二次确认
（已不在**当前** free 集合中即跳过）。

### ⚠️ 面板图标必须从官方资源提取，**不得凭印象手绘**

**真实缺陷**（用户报障）：「我们用的图标和 cline 的好像不一样」。

初版 `CLINE_ICON` 是**凭印象手绘**的内联 SVG（「深色圆角方块 + 白色 C 形弧线」），
与 Cline 真实标志完全不符 —— 真实标志是**顶部带凸起的圆角方块 + 中间两条竖线 +
左右两侧尖角**，品牌紫底。

**教训：品牌图标必须从官方资源提取。** 修法与工具：

- 官方图标**就在安装目录里**，不必从 exe 抠 PE 资源：
  ```
  %LOCALAPPDATA%\Cline\icons\app\{classic,chip,hologram,midnight}.png   148×148
  %LOCALAPPDATA%\Cline\icons\app\macos\*.png                            1024×1024  ← 用这个
  ```
  （`cline-app.exe` 内嵌的主图标只有 **32×32** 且是 **midnight** 主题，不适合。）
- 提取脚本 **`scripts/extract-cline-icon.mjs`**（纯 Node，**零第三方依赖**：
  PNG 解码/编码用内置 `zlib` 手写，只支持官方图标的
  bit depth 8 + color type 6/2 + 非隔行）：
  ```
  node scripts/extract-cline-icon.mjs                    # classic，48×48，写入 jet-hub.js
  node scripts/extract-cline-icon.mjs --dry-run
  node scripts/extract-cline-icon.mjs --theme=midnight --size=64
  node scripts/extract-cline-icon.mjs --out=icon.png     # 另存供目视
  ```
- **主题选 classic（品牌紫 `#7271E5`）**，理由：`midnight`（exe 内嵌的默认主题）
  是近黑底，与 **Qoder 图标的深蓝黑 `#1f2a3f`** 在容器实际尺寸 **20×20** 下
  几乎无法区分，列表里会混淆；`chip`（绿色电路板）缩到 20×20 后纹理退化成噪点；
  `hologram` 在白底容器里对比度不足。另：紫色在当前 7 个 provider 图标里**未被占用**。
- ⚠️ **缩放必须做 alpha 加权（预乘）平均**：图标边缘是抗锯齿的半透明像素，
  直接对未预乘 RGB 平均会混入透明区的黑色，产出**发黑的描边**。
- ⚠️ 脚本的替换逻辑用**全局匹配、只保留一行**：单次 `String.replace` 一旦
  文件里出现重复的 `const CLINE_ICON` 声明就会残留 → esbuild 直接报
  `The symbol "CLINE_ICON" has already been declared`（开发期踩过一次），
  现在重复运行幂等且能自愈重复行。
- **回归测试 `tests/unit/cline-icon.spec.ts`**：锁定 ① 必须是结构完整的 **PNG**
  （防退回手绘 SVG）、② 尺寸 48×48、③ 与「从官方 `classic.png` 重新提取」
  **逐字节一致**（无 Cline 安装时该条干净跳过）。
  已做**反向验证**：把前缀改回 `data:image/svg+xml` 后 4 条用例失败。

### 其它

- 推理端点是**标准 OpenAI 兼容**（`POST {apiBase}/api/v1/chat/completions`），
  故复用 `src/openai-compat.ts` 全套（消息序列化 / SSE 消费 / 错误归类），与 Qoder 同做法。
- 客户端标识头（推理与账号端点都带）：`HTTP-Referer: https://cline.bot`、
  `X-Title: Cline`、`X-IS-MULTIROOT: false`、`X-CLIENT-TYPE: cline-sdk`。
- `max_tokens` 上界收敛到 **943718**（内嵌目录最大 `maxTokens`，取自
  `muse-spark-1.3-contributor`），不自行编造更大值。
- 单元测试 7 个文件：`cline.spec.ts` / `cline-models.spec.ts` / `cline-oauth.spec.ts` /
  `cline-credits.spec.ts` / `cline-quota.spec.ts` / `cline-auth.spec.ts` / `cline-adapter.spec.ts`。

### ⚠️ Cline「订阅额度」：官方额度窗口 + 请求记录（2026-09-29 新增）

Cline 面板的账号管理区有一个**订阅额度**按钮（只在 Cline 出现），点开是弹窗：
上半部是**官方额度窗口**（5 小时 / 周 / 月各用掉百分之几 + 重置时刻），
下半部是**请求记录**（逐笔：时间、模型、token、积分）。

与账号卡片上的「积分」是**多份不同的读数，不能互相替代**：

| | 积分（既有） | 订阅额度（本次） | 请求记录（本地流水） |
|---|---|---|---|
| 回答的问题 | 还剩多少钱 | 各时间窗用掉百分之几 | **本插件发出的**每笔请求：多久、多少 token |
| 来源 | `/api/v1/users/{id}/balance` | `/api/v1/users/me/plan/usage-limits` | `src/cline-request-log.ts`（进程内存） |

参考实现：`github.com/codeOct/dsh-cline-pass` 的额度管理与请求记录部分。

### ⚠️ 请求记录是**本地流水**，不是网关账单（2026-09-30 按用户反馈改造）

**用户反馈**：「请求记录展示的字段和我给你的参考也不一样」——首版把请求记录
对齐到了网关 `/users/{id}/usages`（字段 `createdAt / aiModelName / aiModelTypeName
/ totalTokens / creditsUsed / costUsd`）。**那是错的**：网关记录的是该账号在
**官方所有渠道**的消费账单，没有延迟、没有首块时间，字段也对不齐参考实现。

**改法**（对齐参考实现的请求记录部分）：

- 新增 `src/cline-request-log.ts`：适配器发出的每笔推理请求记录
  `{ ts, model, accountId, usageReported, inputTokens, outputTokens,
  cacheReadTokens?, reasoningTokens?, effort, ttftMs, totalMs, error? }`。
- `src/cline-adapter.ts` 的 stream() 有**两个**消费出口（换号成功后的 consume
  与正常路径的 consume），**都**走 `consumeWithLog()`（内部再调 `this.consume`）
  —— 接线由 `cline-adapter.spec.ts` 的源码断言锁死（`yield* this.consume(`
  不得再出现）。
- 记录的**取舍**（与参考实现的差异及理由）：
  - 不记 `ttfb`：单一网关、无 upstream 选路，响应头与首块之间没有独立阶段。
    表格的延迟列仍按参考实现给**三行**（首字 / 总耗时 / 输出速率）。
  - 换号过程**不逐笔记**：只记**最终结果**一笔 —— 参考实现会把每次
    AUTH/QUOTA attempt 都记成失败行，本适配器的 429 换号风暴（最多 3 轮）
    会把 100 条上限刷满；「所有账号均不可用」这行已包含换号语义。
  - usage 帧在**经过时捕获**：流中途 abort / 上游提前断开时 usage 没被消费到，
    此时记 `usageReported: false`（**不是记 0**）—— 表格据此显示 `—`；
    记 0 会被读成「瞬间完成、没花 token」（参考实现同约定）。
  - **记录绝不抛错**：它在推理关键路径上，记账失败不得反噬推理
    （record 内部全部 try/catch + 钳制 + 截断）。
- 存储：**进程内存，100 条，重启即丢**（刻意，与参考一致；高频写不适合持久化）。

### ⚠️⚠️ 请求记录的「账号」必须用**账号池 id**，不能用凭据里的 `account_id`（真实缺陷，2026-09-30）

**用户报障**：「请求记录中数据空白，没有记录下来」。

**根因是两个 id 空间被混用** —— 字段名叫 `accountId` 的有**两套值**：

| 位置 | 值 | 形如 |
|---|---|---|
| 面板的过滤条件 `cline.requestLog.accountId` | **账号池 id**（取自 `cline.quota` 的 `accounts[].accountId`，即 `account.id`） | `cline-bb211a53` |
| 适配器原先在**成功路径**记的 | 凭据里的 `account_id`（Cline 的**用户 id**） | `usr-01M3BCV4FY…` |

两者不相等 ⇒ `readClineRequestHistory({ accountId })` 恒返回空 ⇒ 表格**永远空白**。
（换号路径当时记的却是池 id —— 同一缺陷的两半，两条出口口径不一致。）

**修法**：`ClineAdapterOptions` 新增 `currentAccountId?: () => string | undefined`，
由 `src/index.ts` 在 `resolveCredential` 里记录**实际选中的池账号**
（`activeClineAccountId`，与 `activeQoderAccountId` 同因、同写法）；
适配器在 stream() 开头用它做**局部变量**的起点（只在首次取值，
换号后自行跟进），两个出口都用「池 id 优先、无池账号才退回 `usr-…`」。

⚠️ **反向验证已做**（本仓库要求）：把正常路径改回 `credential.account_id ?? …`
→ `cline-adapter.spec.ts` 的「请求记录归属『账号池 id』」**变红**，报错为
`expected 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM' to be 'cline-bb211a53'`；还原后全绿。

⚠️ **做这次反向验证时连踩两个工具坑**（都会让验证**假绿**，务必避开）：
1. **同一表达式在文件里出现两次**（换号路径 + 正常路径，文本完全相同）——
   用字符串 `replace` 命中的是**第一处（换号路径）**，而用例走的是正常路径，
   于是「回退了却仍全绿」。必须按**上下文/最后一次出现**定位。
2. **本仓库源文件是 CRLF**：脚本里写 `\n` 的**多行**锚点永远匹配不上
   （单行锚点没事，所以第一次只替换成功的假象更难发现）。按行处理即可。
   ⚠️ 另：**Windows 下别用内联 `node -e`**，PowerShell 会吃掉
   `\``/`$`/引号（本次两次静默跑错），写成 `.mjs` 文件再跑。

### ⚠️⚠️ 请求记录的三处**展示语义**缺陷（2026-09-30 用户复核，一次报三个）

用户报障原文：「**上游显示的不正确**」「支持图片的模型**发送不了图片**」
「请求记录中：输出速率 `11814.8 t/s` 这个是不是也有问题」。
三者**根因各不相同**，但都属于「字段取错了口径」，逐个记下：

#### ① 「上游」列取的是**模型命名空间**，不是 serving channel

- 原实现：`clineUpstreamOf(model)` = 模型 id 的 `/` 前缀（`cline-pass` /
  `cline-free`），**甚至是厂商名**（`deepseek/deepseek-v4.1-flash` → `deepseek`）。
  那是「订阅通道/厂商」，不是「谁服务了这笔请求」。
- 参考实现同一列显示的是 **`alibaba` / `baseten`** 这类真实渠道，取自网关
  下发的路由元数据（其 `parseRouting()`）。
- **落点**（三种实测形态，`src/cline-routing.ts`）：

  | 形态 | 路径 |
  |---|---|
  | **流式（真实链路）** | `choices[0].delta.provider_metadata.gateway.routing.finalProvider` |
  | 非流式 / planner | `choices[0].message.provider_metadata.gateway.routing.finalProvider` |
  | 帧顶层 | `provider_metadata.gateway.routing.finalProvider` |
  | direct | `delta.provider` / 顶层 `provider`（如 `GMICloud`，原样保留） |

  ⚠️ **大小写两种拼写都要认**：本仓库另一处实测（Gemini-400 段）记的是
  **camelCase** `providerMetadata`，参考样例是 snake_case；只认一种会在另一种
  形态下静默读不到。
  ⚠️ 参考注释：*"in a stream it appears on whichever frame carries it, so every
  frame is inspected and the last non-null reading wins"* ⇒ **逐帧**观测、
  最后一次非空为准。
- **实现**：`consumeOpenAiSse` 新增**可选旁路** `onFrame`（回调抛错被吞掉 ——
  观测绝不能打死一次正常推理）；适配器在 `consumeWithLog` 里累积，写进
  `ClineRequestEntry.upstream`。**空串 = 网关没报**，RPC 侧才回落到模型命名空间。
- 反向验证：停掉逐帧观测 → 用例红（`expected '' to be 'deepseek'`）。

⚠️⚠️ **第一版读漏了 `delta` 这一层，整处修复在真实链路上完全没生效**
（用户 2026-10-01 第二次报障：「**上游**和**请求速率**为什么显示的还是错误的」；
进程核对过 —— 00:30 启动的进程**已含** 00:09 那次安装，不是「没加载」）。
当时按「非流式挂 `message`、**流式挂帧顶层**」实现，而**实测的流式帧把它挂在
`choices[0].delta` 上** ⇒ 每帧都读不到、`upstream` 恒为空串、展示层回落到
`cline-pass`，用户看到的与修复前**一模一样**。

**两条教训（都比这一处 bug 值钱）**：

1. ⚠️ **外部载荷的确切层级只能实测，不能按参考实现的只言片语推断**。参考实现
   只说了「出现在携带它的那一帧上」，**没有说挂在 `delta` 还是帧顶层**，我按
   猜测填了帧顶层。一次性探针
   （`scripts/probe-cline-routing-live.mjs`：用凭据库里的 token 发一次极小流式
   请求，**逐帧打印命中的 JSON 路径**）当场就能定案 —— 这类「形状假设」必须
   在写实现时就用探针钉死，或至少在注释里标成**未验证假设**。
2. ⚠️⚠️ **fixture 写错等于没有测试**：适配器那条 `upstream` 用例当时用的是
   **帧顶层**的 fixture（即我的猜测），于是**用例绿、功能坏**，直到用户第二次
   报障才暴露。凡涉及外部响应形状的 fixture，必须照实测量到的报文写，
   并把「实测来源 + 日期 + 探针名」写进注释（现已如此）。

   ⚠️ 探针本身也踩了一个坑：仓库里的 `access_token` **已含 `workos:` 前缀**
   （`buildClineCredential` 写入时就加了），再拼一次 ⇒ `Bearer workos:workos:…`
   ⇒ **401**。第一版探针因此误判「两个账号的 token 都失效」。

**顺带核清的 `finalProvider` 语义**：它既可能是**基础设施商**（参考实现抓到的
`alibaba` / `baseten`），也可能是**模型厂商自己的 API** —— 本机实测
`cline-pass/deepseek-v4.1-flash` → `finalProvider = "deepseek"`。两者都是
「网关最终决定由谁服务」，故**原样展示**、不要试图归类。

**同时给「输出速率」补了 `—` 的原因提示**（`latencyParts` 新增 `rateTitle`，
挂在那一行的 `title` 上）：不可测有两种情形，各自给话 ——
`本次没有正文块（只输出思考，或流在正文之前结束）` /
`正文阶段只有 Nms（不足 250ms）—— 响应几乎一次性到达`。
用户第二次报障时正是怀疑「速率还是错的」，而实际是**不可测**；
一个横杠不解释，就会被读成「坏了」。

#### ② 图片能力只查本地兜底表 + **`cline-pass` 目录不全**（同一处修复）

用户后来又报了同一条链上的第二个症状：「**当前 cline 供应商的模型列表中关于
cline-pass 部分模型为什么不全**，例如当前这个模型就看不到了」。两者同源：
**models.dev 这份目录此前完全没被当作目录来源**。

- 原实现：`inputModalitiesFor()` 只看 `product.fallbackModels[].supportsImage`
  —— **全表只有 5 条、且全是 `cline-free/*`**；而远端两个目录端点
  **都不下发能力字段**（实测 `recommended-models` 只有
  `{id,name,description,tags}`，`/models` 只有裸 id）。
  ⇒ DSH 按适配器播报的 `inputModalities` 决定要不要把图片投影成占位符，
  于是**图片根本送不进适配器** —— 用户看到的就是「支持图片的模型发不了图」。
- **目录也不全（实测对账，2026-09-30）**：

  | 来源 | `cline-pass/*` 条数 |
  |---|---|
  | 网关 `recommended-models` 的 `clinePass` 数组 | **14** |
  | models.dev 的 `cline-pass` provider 块 | **18** |

  差的 4 条 —— `kimi-k2.6` / `glm-5.2` / `kimi-k2.7-code` / `deepseek-v4-flash`
  —— 在本插件里**根本不存在**，用户既看不到也选不到。
  另外网关给 `cline-pass/*` 的 `name` **就是 id 本身**
  （`name === 'cline-pass/mimo-v2.6-flash'`），列表里全是裸 id 也让人无从辨认；
  models.dev 给的是可读名（`DeepSeek V4.1 Flash`）。
- **权威来源：`https://models.dev/api.json` 的 `cline-pass` provider 块**
  （实测 18 条，逐条带 `modalities.input` 与 `limit`）：
  `cline-pass/deepseek-v4.1-flash` → `["text","image"]`、
  `cline-pass/minimax-m3` → `["text","image","video"]`、
  `cline-pass/glm-5.3` → `["text"]`。参考实现用的**正是同一来源**
  （其 `MODELS_DEV_URL`；面板里「Rescan the official subscription list and
  **adopt newly published models**」就是这一步 —— 注释原文：
  *"Without it a model newer than this release resolves to the `text` fallback
  and the harness refuses every image for it, silently."* 两处报障同型）。
- **实现口径**（`src/cline-models-dev.ts`，替代原先只管模态的
  `cline-modalities.ts`）：models.dev 是**目录的第三个来源**，
  在 `ensureRemoteModels()` 里用 `applyModelsDevCatalog()` 并入：
  1. **补缺**：目录里没有的 id **追加在该前缀最后一条之后**
     （不能挂第一条后 —— 那会插到同族中间；更不能追加到列表末尾 ——
     那里沉在 460 条远端 id 之后，等于没人看得到）；
  2. **补名字**：仅当 `name === id`（网关把 id 当名字下发）时用可读名替换；
  3. **补窗口**：`contextWindow` 缺失时才用 models.dev 的 `limit.context`；
  4. ⚠️ **不取 `limit.output`**：那是要**真的写进请求体 `max_tokens`** 的值，
     本仓库有过「据印象填大值 → vertex/google 400」的真实缺陷
     （见本文件 Gemini-400 段），故只补展示名与窗口，不碰输出上限。
  ⚠️ **一律不覆盖已有值**：策展的本地兜底表与网关数据优先于社区目录
  （显式 `supportsImage: false` 也照样赢）。
  ⚠️ **只认 `image`**（夹取掉 audio/video/pdf —— DSH 词表只有 text/image）。
  ⚠️ **失败向上抛、不缓存**（`TtlCache` 只在成功时写入 ⇒ 下次可重试），
  适配器侧吞掉并保持「这一层没有补充」。TTL **6 小时**（发布节奏的数据）。
- ⚠️ **「没读到」≠「不支持」**：读不到时目录照常工作、图片能力退回本地兜底表；
  把前者当后者正是本次缺陷的形态。
- 反向验证：停用 `applyModelsDevCatalog` 那一行 → **两条**用例同时变红：
  `图片能力取自 models.dev：cline-pass/* 也能发图`（报错
  `cline: 模型 "cline-pass/deepseek-v4.1-flash" 不支持图片输入`）
  与 `models.dev 补全 cline-pass 目录`。

⚠️ **排障提示（本次顺带查明的第三种「看不到」）**：目录里有 14 条 `cline-pass`，
但**用户的黑名单关掉了 10 条**（`~/.dsh/jet-hub/state.json` 的
`disabledModels.cline`，实测 474 条 cline 模型被关），模型选择器里因此只剩
4 条 —— 那是**用户自己的模型开关**，不是目录缺失。Jet Hub 的模型列表会渲染
被关闭的模型（`listAllModels()` 就是为此存在），所以能在那里重新打开。
**两种「看不到」的判据不同，别混**：黑名单造成的在 Jet Hub 里能看到（带开关）、
目录缺失的在任何地方都没有。

#### ③ 「输出速度（TPS）」= **DeepSeek 官方口径**（用户 2026-10-01 定案）

> 用户原话：「**按照官方速率显示规则来**」（此前明确「我说的 deep seek」）。
> ⚠️ **这一节取代了我 2026-09-30 那版「正文阶段」口径 —— 那版被用户否掉了。**

**官方规则**（只读核对，出处是本机 DSH 自己的聊天 UI：
`@deepseek-ai/dsh-client-ui-chat/lib/client.js`，可在
`D:\Program Files\DeepSeek Harness\resources\app.asar` 里直接读到）：

```js
// assistantStepReading(node)：一「步」的读数
ttftMs   = firstTokenTime - stepStartTime      // 首个 token（任意块，含推理块）
decodeMs = completedTime  - firstTokenTime     // 首 token 之后 → 结束
outputTokens = usage.outputTokens              // 该步全部输出 token

// TimePill()：显示（decodeMs > 0 才显示，否则整项不渲染）
tps = formatTokensPerSecond(outputTokens / (decodeMs / 1e3))

// formatTokensPerSecond()：取整规则（先 clamp 负值）
x >= 10 ? String(Math.round(x)) : String(Math.round(x * 10) / 10)
```

官方 i18n：`message.tokensPerSecond = "{tps} tok/s"`、
`stats.dialog.speed = "输出速度（TPS）"`。

**本插件据此落地**（`plugin-src/client/tokens-per-second.js`，纯函数可逐值单测；
`jet-hub.js` 只负责组装三行）：

| 项 | 取值 |
|---|---|
| 分子 | **全部输出 token（含推理 token）** —— ⚠️ **不减** `reasoningTokens` |
| 分母 | `总耗时 − 首字`（`decodeMs`），**不含**首字之前那段 |
| 门禁 | 只有 `decodeMs > 0`；⚠️ **没有**最小窗口下限 |
| 单位/标签 | `tok/s` / 「输出速度（TPS）」（单元格里用短版「输出速度」） |

⚠️⚠️ **三处曾经的错误做法，别再改回去**（每条都有反向验证过的用例守着）：

1. **`11814.8 t/s` 那次不是"公式错"**：官方口径在**短窗口**下本来就会给出很大的数
   （响应几乎一次性到达时 `首字 ≈ 总耗时`，`142 token ÷ 12ms ≈ 11833 tok/s`）。
   我 09-30 的反应是改分子分母 + 加 250ms 下限 —— **那是过度纠正**，官方没有下限，
   改了反而与本 app 自己的读数不一致。
2. **不要减推理 token**：`reasoning_tokens` 计入 `completion_tokens`（本仓库多处实测），
   官方就是这么算的。减了会让同一笔请求的 TPS 与 DSH 显示的不同。
3. **不要退回 `toFixed(1)`**：官方的精度是**两段式**（`≥10` 整数、`<10` 一位小数），
   不是统一小数位。反向验证：把取整换成 `toFixed(1)` → **7 条**用例变红
   （`expected '273.9 tok/s' to be '274 tok/s'` 等）；把分子改成「减推理」→ 1 条变红。

⚠️ **`ttfcMs`（首个正文块耗时）现在只是诊断字段**，**不参与**速率计算：
官方口径只用 `首字`（首个任意块）。字段仍照常记录（适配器 → 请求记录 → RPC），
将来若要显示「首正文」可直接用；但**不要**拿它当速率分母。

⚠️ **`ttftMs === 0` 在我们的数据模型里是「没有任何块到达」= 未知**（官方用 `null`），
故 `formatRowTokensPerSecond` 把 `0` 显式映射成**不可测**（显示 `—`）——
照字面算 `total - 0` 会把「首字时刻未知」当成「首字在 0ms」，报出假速率。
这条映射有专门用例（`缺首字时刻（ttft=0 = 未知）→ —`）。

⚠️ **旧断言又锁死了一次旧实现**：`cline-quota-panel.spec.ts` 里原先那条
「输出速率按正文阶段算」的用例（断言 `MIN_RATE_WINDOW_MS` / `contentTokens`）
正是锁 09-30 那版口径的，本次已改写为「接线到 `tokens-per-second.js`」。
**改口径必须同步改用例** —— 这在本仓库已是第三次同型情况
（账号池 id、平铺渲染、此处）。

⚠️ **反向验证脚本自身的坑（第 4 次同型）**：`swap-tps-official.mjs` 打补丁时
**第一版打到了文档注释里那行官方代码**（我在模块头注释里引用了
`x >= 10 ? … : …`），于是「取消官方取整」的反向验证**假绿**（13 条全过）。
判据：**要改的是函数体，必须取最后一次出现**（`lastIdx`）。
这与本文件记过的「同一表达式出现两次、替换打到第一处」是同一条教训 ——
**换行数/取最后出现**，并在反向验证后**确认它真的变红**（假绿比不验证更危险）。

⚠️ **另记一处未修的小缺口**（不属本次报障，留给后续）：
`recommended-models` 实测还有第 4 个数组 **`clineCloud`**（3 条，如
`cline-cloud/glm-5.3`），而 `parseClineRecommendedModels` 只读
`free`/`recommended`/`clinePass` ⇒ 这批模型拿不到 `name`/`description`
（只能靠 `/models` 的裸 id 出现）。改动会影响模型列表内容，故未顺手做。

### ⚠️ 模型列表的**「计费/来源」分组**（用户要求，2026-10-01）

用户问「模型列表能够分组显示吗」→ 选定口径 **B：按计费/来源分 4 组**（而不是
按 67 个命名空间），并要求**每组一个「全开 / 全关」**。实测目录规模 **488 条**
（`openai` 104 / `qwen` 54 / `google` 41 / `anthropic` 29 …），平铺确实没法看。

**只有 Jet Hub 的「显示列表」能分组**；⚠️ **对话框里的模型选择器不能** ——
那是 harness 自己的 UI（`dsh-client-ui-model-selection`），它只按 **provider**
分组，`cline` 在里面必然是一个大组；我们能影响的只有每个模型的 id/name。

#### 分组口径（`plugin-src/client/model-groups.js`，纯函数）

| 组 | 判据 | 实测规模 |
|---|---|---|
| 订阅额度 | `cline-pass/*` | 18 |
| 免费额度 | **目录下发的 `isFree === true`** | 7（5 `cline-free/*` + 2 `stealth/*`） |
| Cline Cloud | `cline-cloud/*` | 有则显示；**空组不渲染** |
| 按量计费 | 其余全部（走账户余额结算） | 460+ |

⚠️⚠️ **免费必须用 `isFree`，不能在前端按前缀猜**：免费集合是远端
`recommended-models` 的 `free` 数组 + `:free` 后缀 + `cline-free/` 前缀的
**并集**（见 `cline-models.ts`），而 **`stealth/pixel-canary` /
`stealth/space-bunny-alpha` 在 `free` 数组里却不在 `cline-free/` 命名空间下**
—— 按前缀判会把这两条**免费模型错归进「按量计费」**，用户以为要花钱而不敢用。
⚠️ `isFree` **缺失**（老/外部适配器不报）时保守归入「按量计费」：那是兜底桶，
「没说免费」比「谎称免费」安全（与全仓「未知不编造」一致）。

#### 展开策略（`groupExpanded`）

优先级：**用户点过 > 有筛选 > 默认**。默认**「按量计费」折叠、其余展开**
（前者是兜底大桶、多数是关的，默认展开等于把列表撑到没法用）；**有搜索/筛选时
一律展开**（否则搜到的结果藏在折叠组里，看起来像「没搜到」）。
⚠️ **不要把默认值烘焙进 state**：只存「用户点过的组」，否则「清空筛选后恢复
默认」就做不到了。

#### ⚠️ 新增端点 `model.setDisabledMany`（按子集），**不能**复用 `setAllDisabled`

分组的「本组全开/全关」必须只动本组的 id。若图省事复用
`model.setAllDisabled`：**它的打开方向是「清空整张黑名单」** ⇒
「只打开订阅额度这一组」会把用户特意关着的**按量计费 460 多条一起打开**。

- 池新增 `AccountPool.clearModelsDisabled(provider, modelIds)`：**只删传入的 id**
  （与 `clearDisabledModels` 的「清空全部、并顺带清掉已下线死键」是**两个语义**，
  别混）；**无实际变更不落盘**（该组本就全开时不该产生一次文档重写 + 目录广播）。
- 端点：校验 `provider` / `modelIds` 数组 / `disabled` 布尔（**不猜默认值**，
  与另两个开关端点同约定），**去重 + 剔脏值后为空则拒**，只落盘一次、只广播一次。
- 反向验证：把打开方向改回 `clearDisabledModels` → 用例红
  （`expected {} to deeply equal { Object (buddy) }`，即「其它组的关闭项被一起清掉了」）。

#### `model.list` 新增 `isFree`（缺失不编造）

`ModelCatalogSource.listAllModels()` 的返回类型扩展为
`{ id, name, isFree?: boolean }`，`ClineAdapter` 填上（它来自目录合并的
`isFree`，与模型选择器里的「· 免费」标签**同源**）。RPC 层**照原样透传、缺失
就不写这个字段** —— 不编造 `false`（类型上是 `isFree?: boolean`）。

#### ⚠️⚠️ 验证盲区：客户端改动**单测全绿也不代表 bundle 能构建**

`plugin-src/client/*.js` 的改动在本仓库**只被两种方式验证**：纯函数单测 + 把
`jet-hub.js` 当**文本**读的源码级断言。二者都**不做语法解析** ⇒
**必须另跑 `pnpm build:client`（或 `build:all`）**。
本次真踩到：分组渲染用**块体箭头函数**（`group => { ... return ... }`），收尾括号
比原来的**表达式体**少一层，我多打了一个 `)` —— 3809 条单测全绿、esbuild 报
`Expected ";" but found ")"`。**改完客户端一律跑一次构建**。

回归用例 `tests/unit/model-groups.spec.ts`（21 条：归组 / 并集不丢模型 /
组内筛选与计数 / 展开策略 / 组内批量可用性 + 4 条源码级接线断言），
端点用例在 `tests/unit/jet-hub-rpc.spec.ts` 的 `model.setDisabledMany` 段（10 条）。
⚠️ 同时更新了 `model-filter.spec.ts` 里锁**旧平铺渲染**的那条断言
（`filtered.map(...)` → `group.models.map(...)`）—— 与以往同型：**旧断言可能锁死
被有意改掉的实现**。

### ⚠️ 额度窗口与请求记录**共享同一个翻页索引**（用户要求）

「订阅额度」弹窗改为：**一次只显示一个账号**，用左右箭头 `‹ ›` 翻页；
**额度窗口与请求记录一起切**（用户明确要求「统一切换」）。参考实现同款。

要点（多数是参考实现踩过的坑）：

- 索引是**纯本地状态**，**不要用 useEffect 播种**（列表一到就 set(0)）——
  那会让「浏览位置」与「显示的是谁」短暂分叉。当前账号在**渲染期纯计算**
  （`quota[Math.min(viewIndex, quota.length - 1)]`），越界钳制但**不回写**，
  账号恢复后还能回到原位。
- 翻页是**纯本地**（额度数据一次性取回），切账号时只有请求记录需要重新拉取。
- **环绕**：末个账号的右箭头回第一个（单向尽头会让用户以为「后面没了」）。
- 单账号**整行名字都不渲染**（参考实现同款：箭头无处可去，账号名也不构成
  区分信息）。「这是谁的额度」改由**弹窗副标题**给出（多账号 = `Cline · {n} 个账号`，
  单账号 = `Cline · 账号 {名}`）—— 否则单账号用户看不到是谁的额度。
- **竞态**：切账号会丢弃未完成的旧请求记录响应（按请求序号「最新获胜」），
  否则旧响应后到会覆盖新账号的数据。

### ⚠️ 与参考实现的**逐项对齐**（2026-09-30 用户报障「没有 1:1 还原」后重做）

**用户判据**：额度窗口与请求记录要么**逐项**与
`github.com/codeOct/dsh-cline-pass`（main @ `abab1dd`）一致，要么说明为什么不一致。
首版是按「精神」做的**子集**，故这次逐条对照后重做。已对齐项与**被推翻的旧实现**：

| 项 | 参考实现（main） | 首版（错） | 现状 |
|---|---|---|---|
| 记录表列 | **5 列含状态点**（绿/红点，title 给错误） | 4 列、无状态点 | ✅ 5 列 |
| 延迟列 | **三行**：首字 / 总耗时 / **输出速率 t/s** | 单行「首块 X · 共 Y」 | ✅ 三行 |
| TOKEN 列 | `↓入 ↑出 ⚡缓存 🧠推理`（图标 + k/M 有界缩写） | `123 + 456`，丢缓存 | ✅ 图标格式 |
| 未收 usage 帧 | 显示 **`—`**（≠ 花 0） | `0 + 0` ← **语义错误** | ✅ `usageReported:false` → `—` |
| 未知耗时 | **破折号 `—`**（`stamp`/`rate`） | 半角 `-` | ✅ `—` |
| TOKEN tooltip | 精确数字 + **图例**（`—` 的含义） | 只有一句替代文案 | ✅ `TOKEN_LEGEND` |
| 行 tooltip | 汇总 5 行事实（含**推理强度**） | 无 | ✅ 含 `effort` |
| 额度窗口布局 | **grid 卡片**（auto-fit / 170px）+ **18px** 大字百分比 | 纵向列表 + 13px | ✅ grid + 18px |
| 百分比 | `Math.max(0, Math.min(100, x))` + **取整** | 保留一位小数、**故意不夹** | ✅ 夹取+取整 |
| 进度条配色 | ≥90 红 / ≥70 黄 / 其余**绿**（`usageColor`） | ≥100 红 / ≥80 黄 / 其余**蓝** | ✅ 三档绿底 |
| 窗口顺序 | 已知窗口**固定顺序在前**、未知**追加在后** | 纯按网关原序 | ✅ `QUOTA_WINDOWS` |
| 账号块 key | 按账号 id → **重挂载**（进度条不跨账号动画） | 无 key | ✅ `key: entry.accountId` |
| 模型名 | 去 `cline-pass/` 前缀 + 上游 tag | 原样 | ✅ 去前缀 |
| 失败行 | 空 2 格 + **`colSpan 3`**（消息从模型列起） | `colSpan 4` | ✅ `colSpan: 3` |
| 表格 | 自带 **280px 滚动** + **sticky 表头** + 全列居中 | 靠弹窗滚动、左对齐 | ✅ 同款 |
| 列宽 | `colgroup` 提示（状态点 16px / 时间 82px） | 无 | ✅ `colgroup` |

⚠️ **被参考实现自己删除、我们也不补**：额度卡曾经有「token 用量 / 已用金额 /
折算剩余 token」——参考 `client.js` 的 `UsageCard` 注释明确写了那些数字是
*derived, unverifiable*，**作者已主动删除**，卡片只留「百分比 + 重置时刻」。
排查时不要再去参考的 README（不同 commit 的描述）里找这三项。

⚠️ **刻意保留的措辞差异**（不是漏改）：jet-hub 沿用本插件自己的命名
「**订阅额度**」/「**请求记录**」（参考叫「官方额度」/「最近请求」）——
按钮名是用户在前一轮明确指定的，改掉会让同一功能在两个入口有两套叫法。
除措辞外，布局、字段、格式化与配色全部对齐。

⚠️ **数据层随之扩了三件事**（缺任何一件都会让上面某行显示不出来）：
`usageReported`（`—` 的判据）、`cacheReadTokens`（`⚡` 那一项）、
`effort`（行 tooltip 的推理强度行）。三者都已接线
`cline-adapter → cline-request-log → jet-hub-rpc → types`，
并由 `cline-request-log.spec.ts` / `jet-hub-rpc.spec.ts` 锁死。

回归用例 `tests/unit/cline-quota-panel.spec.ts` **在 2026-09-30 被整体重写**：
旧断言锁的是首版自创形态（「百分比不夹取」「单行延迟」等），与用户给的判据
直接冲突，故换判据而非删断言。**不要照着旧断言改回去。**

### ⚠️ 五个实测坑（沿用参考实现已核实的结论，**不要重新踩**）

1. **分页参数只认 `cursor`**，值取自响应 `data.nextToken`。
   `nextToken` / `next_token` / `page` / `offset` / `skip` 作为**请求参数**会被网关
   **静默忽略** —— 永远返回同一页。早期据此连翻会**重复计数**，得出
   「已用 28 亿 token、超限 120%」这种荒谬结果。
2. **`data.total` 恒为 0**，不能用来算页数或总量。
3. **`/usages` 忽略 `startDate` / `endDate`**：只按时间**倒序**返回，
   要按窗口截断只能读每行的 `createdAt`。
4. **`resetsAt` 是 ISO 字符串**，不是数字时间戳 —— ⚠️ 故**不能**复用客户端的
   `formatTime()`（它按毫秒运算，传字符串会一律显示「已过期」，
   把 6 小时后重置的窗口说成已重置）。现由 `quotaCountdown` / `quotaResetsIn`
   负责（`Date.parse` + 粗粒度倒计时），记录表的「时间」列另用 `formatStamp`。
5. **`userId` 用凭据里的 `account_id`（`usr-…`）**，不是 JWT 的 `sub`（`user_…`）：
   后者实测 `400 Invalid request format`。而**额度端点用字面量 `users/me`**，
   不依赖 `account_id`（两者口径不同，别顺手统一）。

#### 设计要点（改这个功能前先读）

- **能力表两侧必须同时改**：客户端 `CREDITS_CAPABILITIES.cline.subscriptionQuota`
  决定按钮是否渲染；服务端 `cline.quota` / `cline.requestLog` 对非 Cline 一律
  `bad-request`。只改一边就是「按钮在、点了报错」或「功能存在却点不出来」。
  `credits-capabilities.spec.ts` 用**全表推导**守住「只有 cline 登记」。
- **`subscriptionQuota` 与 `balance` / `dailyCheckin` 语义独立，不能互相推断**：
  Cline 是「有余额、有订阅额度、无签到」，Loomy 是「有余额、有签到、无订阅额度」。
  合并成一个标志会让某个面板冒出不该有的按钮。
- **额度逐账号隔离**：一个账号凭据坏掉只让**那一张卡片**显示原因，其余照常。
  多账号用户不该因为一个号没配凭据就完全看不到额度。
- **「查询失败」与「没有额度窗口」必须分开渲染**：前者是错误（显示原因），
  后者是事实。合并成一句会让用户以为额度没了。
- **失败不得显示成 0%**：0% 是「这个窗口没用过」的合法语义；
  查询失败一律 `ok:false` + 原因（与其余 provider「查不到不显示成 0」同约定）。
- **请求记录的失败是载荷（`ok:false`）而不是 RPC 级错误**：
  面板要**保留已加载的行**、只把原因显示在表格下方；回成 RPC 错误会让整块换成错误页，
  翻页途中失败就把用户已看到的记录清空了。
- **百分比**：数值**夹取到 0–100 后取整**（参考实现），文案与进度条宽度共用
  `quotaPercentValue` 这**一个**值 —— 两处各算一次是「进度条 100%、文案 120%」
  这类不一致的来源。⚠️ 这条在 2026-09-30 **推翻了旧实现**（旧版故意不夹取）。
- **窗口顺序**：已知窗口（`five_hour` / `weekly` / `monthly`）按 `QUOTA_WINDOWS`
  固定顺序在前，网关下发的**未知窗口追加在后** —— 纯按网关原序会让新窗口插到中间，
  同一账号两次读数的排列都可能不同。未知类型的标签回落到 `type` 原值（不丢弃）。
- 按钮放在**面板级**而不是账号卡片的按钮行：那一行已有 5 个按钮且
  `flex-wrap: nowrap`，再塞一个必然溢出（「领取新手任务」当时就是这么被挤出去的）。
  且额度是**跨账号**读数，放面板级与语义一致。

#### ✅ 验证状态（哪些已实证、哪些还没有）

**已实发核对（2026-09-29，本机真实 Cline 账号，只读 GET、未触发续期）**：
端点与响应形状与解析层**完全一致** ——

- `/users/me/plan/usage-limits` → `data.limits[]`，`type` ∈
  `five_hour` / `weekly` / `monthly`，带 `percentUsed` 与 `resetsAt`；
- `/users/{account_id}/usages` → `data.items[]` + `data.nextToken`，行含
  `createdAt` / `aiModelName` / `aiModelTypeName` / `totalTokens` /
  `creditsUsed` / `costUsd`。**用 `account_id`（`usr-…`）实测可用**。

两个实测形态已写进用例：

- `resetsAt` 是**纳秒**精度（9 位小数），如 `2026-09-29T15:41:02.244817775Z`
  —— 解析层**原样保留**（不截断、不归一化），`Date.parse` 可解析；
- 用量为 0 的窗口 `resetsAt` 是**空串** —— 客户端因此**不渲染**那一行
  （渲染一个空的「重置」会让人以为读取失败）。

⚠️ 探针**没有入库**（`tests/e2e/tmp-*.ts` 用完即删）。需要复核时：照
`tests/e2e/cline-credential.ts` 读凭据，再调 `fetchClineUsageLimits` /
`fetchClineRequestLog` 即可（**只读、不要续期**）。

⚠️ 顺带发现（**与本功能无关，刻意未改**）：`readClineCredentialsFromDshStore()`
对本机当前的 `.credentials.yaml` 读出 **0 个账号** —— `extractYamlScalar` 取出的
标量**尾部多 2 个杂字符**，`JSON.parse` 抛错后被该助手的 `catch` **静默跳过**。
探针是靠「只取第一个完整 JSON 值」绕过的。若哪天别的 Cline e2e 报
「0 个账号」，根因多半在这里，而不一定是凭据真的不存在。

**已做**：`pnpm typecheck`、`pnpm test`（新增 54 条：`cline-quota` 32、
能力表 3、RPC 端点 9、客户端接线 10）、`pnpm build:all`，并已安装到本机 profile
（`lib/` 330 个文件**全量哈希一致**）。全量测试
**1 failed | 3155 passed**，那 1 项是既有失败（`loomy-docs` 缺被 gitignore 的文档；
另有 `cline-icon` 缺不入库脚本，属套件级加载失败）。

**未做**：GUI 点击级实测（`/api/jet-hub` 需浏览器登录态，直接调用返回 401，
与既有记录一致）。

⚠️ **改了宿主侧（`src/`）必须重启 DSH 才生效**：客户端 bundle
（`lib/client/jet-hub.js`）会被 `dsh-client-hmr` 热加载（刷新页面即可，无需重启），
但 `cline.quota` / `cline.requestLog` 是**宿主侧**端点 —— 不重启只会看到
「按钮出来了、点了报 unknown method」。

### ⚠️ 修复记录：首版弹窗漏了 `.dim-jh-modalBody` + 数字列右对齐被压过
（2026-09-29 用户报障：「弹窗位置不正确。内容显示不正确」）

**根因一（位置）**：弹窗内容直接铺在 `.dim-jh-modal` 里，没包 `.dim-jh-modalBody`。

`.dim-jh-modal` 是 `max-height: min(640px, calc(100vh - 48px))` 的 flex **列**容器，
子项默认不可收缩（没有 `min-height: 0` / `overflow`），内容一多就
**画出弹窗边界之外** —— 额度卡 + 请求表叠加，视觉上就是「弹窗错位、内容错乱」。

**修法**：内容包进 `.dim-jh-modalBody`（`flex: 1 1 auto; min-height: 0;
overflow-y: auto`，见样式）。模型列表弹窗同款 —— 它的 error / loading /
empty / 列表四个分支**全部**在 modalBody 里，只有 modalHead / modalHint /
筛选条 / 批量工具条在外面。

**根因二（内容）**：`.dim-jh-quotaNumCol { text-align: right }` 的优先级
**(0,1,0)**，压不过 `.dim-jh-quotaTable th/td { text-align: left }` 的
**(0,1,1)** —— 右对齐**静默失效**：表头左对齐、数据右对齐，列错位。

**修法**：复合选择器
`.dim-jh-quotaTable td.dim-jh-quotaNumCol, .dim-jh-quotaTable th.dim-jh-quotaNumCol`。
这正是参考实现 README 里「429 错误行撑宽请求记录表格」的**同一个选择器强度
问题**（那边是 `(0,1,1)` 的 `td{white-space:nowrap}` 压过 `(0,1,0)` 的
`.cp-history-error`，解法同样是复合选择器）。

⚠️ 两条都已有**反向验证**（注入缺陷 → 对应断言变红，其余 8 条不受影响），
用例在 `tests/unit/cline-quota-panel.spec.ts` 的
「弹窗内容在 .dim-jh-modalBody 滚动区里」与「数字列右对齐用复合选择器」。

顺带吸收参考实现的既有经验：时间列**定宽 82px**（防时间戳被截断）、
模型名 `word-break: break-word`（长模型名不撑宽表格）。

### ⚠️⚠️ 模型目录构建的 O(N²)：`remoteModels.find` 热点 + `resolveModel` 每次整份重建（issue IKL3YH）

**用户报障**（Windows，DSH 桌面版）：宿主进程风扇周期性狂转 —— 每 ~15 秒被唤醒一次、
持续 ~7 秒、峰值 1.1–1.5 核；Node inspector 函数级剖析的热点落在
`toCatalogEntry → inputModalitiesFor`。用户自己做的 A/B 是「把 `.find` 换成 Map 索引后
宿主 CPU 从 0.425 核降到 0.160 核」。

**根因有两层，第二层才是主因**（用户只诊断出第一层）：

1. `inputModalitiesFor` 对**每个**模型做一次 `this.remoteModels?.find(...)`。
   实测**全仓该形态只有这一处** —— 其余家都是 `remoteMeta.get()` /
   `fallbackIndex.get()` 或直接吃已解析的 entry。
2. `resolveModel` 每次都 `await config.loadCatalog()` **整份重建** `CatalogEntry[]`。
   DSH 的 `buildModelCatalog` 形状是「1 次 `listModels` + **每模型一次**
   `resolveModelInfo`」（`dsh-api-session-controller` 的 `catalog.js`），而
   `dsh-llm` 的 `resolveModelInfo` **直连适配器、不做任何缓存**
   （`normalizeModelInfo` 只是校验）⇒ N 次调用造成 N² 次条目构造。

实测（本仓 `lib/` 产物，宿主调用形状，3 轮中位数，N=471 的真实目录量级）：

| 实现 | N=100 | N=471 | N=1000 |
|---|---|---|---|
| 修复前 | 13.6 ms | **312.6 ms** | **5498.7 ms** |
| 修复后 | 0.5 ms | **1.5 ms** | **5.4 ms** |

计数实验（N=471，一次宿主调用形状）：`inputModalitiesFor` 被调 **221,841** 次
（= 471×471），`CatalogEntry[]` 被整份重建 **471** 次、每次 471 条。

**同一处还掩盖着一个潜伏缺陷**：`inputModalitiesFor` 的搜索源只有 `remoteModels`，
离线 / 首拉失败时它是 `undefined` ⇒ 兜底表里 `supportsImage: true` 的策划条目
（`stealth/space-bunny-alpha`、`cline-free/mimo-v2.6-flash`、
`cline-free/muse-spark-1.3-contributor`）被误报成**纯文本**（实测确认）。
后果不是「少个功能」而是「支持图片的模型发不了图」—— DSH 见到不含 `image` 的
声明会**静默把图片投影成文本占位符**，正是本文件 §「图片能力只查本地兜底表」
记过的同型缺陷。

**修法三条**（都在 `src/cline-adapter.ts`）：

1. `toCatalogEntry(model)` **直接读 `model.supportsImage`** —— 手上就是那条条目，
   回头拿 id 查表纯属多余。这同时修好了离线误报（兜底条目自己带该字段）。
2. `catalogIndexFor(source)`：`stream()` 门禁用的 `id → 条目` Map 索引，**按来源数组
   身份失效**（`.get()` 是 O(1)：221,841 次查找不再各扫 471 条）。
3. `catalogEntries(source)`：按来源数组身份缓存 `CatalogEntry[]`。
   ⚠️ **这一条是主因修复点**，别只做前两条（只做前两条仍留 121 ms/次）。

**⚠️ 三个实现约束（各自都有反向验证）**：

- **失效判据必须是「来源数组身份变了」，不能是「长度变了」**。目录补齐换的是
  新数组，条数可能完全相同（用户改某个模型的图片能力、或换掉同数量的条目）
  ⇒ 按长度判会一直用陈旧索引，**永不恢复**。`ensureRemoteModels` 每次落目录都赋
  新数组（`this.remoteModels = merged`），身份判据因此天然正确。
- **`fallbackCatalog()` 必须记忆化**：它是 `? :` 另一侧的来源，若每次返回新数组，
  上面两个缓存的失效判据被**架空**（每调用一次就白建一份新缓存）—— 缓存等于没有，
  且**症状完全静默**（只是慢，没有任何报错）。有用例专门守这一条。
- **`stream()` 的门禁与目录必须同源**：`inputModalitiesFor` 自己也回落到
  `fallbackCatalog()`（而不是只查 `remoteModels`），否则会出现
  「`listModels` 说支持、发图被拒」的分叉。

**反向验证（已做，逐条独立）**：去掉 `CatalogEntry[]` 缓存 → O(N²) 用例变红
（实测 3660 次 vs 上限 120）；`fallbackCatalog()` 去掉记忆化 → 兜底路径用例变红；
把索引失效判据改成比长度 → 「残缺目录重拉后等长但内容变了」用例变红；
只还原 `inputModalitiesFor` → 「listModels 与 stream 判据同源」变红；
两处一起还原（= 修复前）→ 「兜底条目的图片能力照常播报」变红。
⚠️ 注意「**只**还原 `toCatalogEntry` 一处」**不会**变红 —— 那是**故意**的两道防线
（纵深防御），不是漏守卫；要按上面那两条分别做。

**⚠️ 规模是会变的**：以上数字取决于目录条数（实测生产 488 条 / 其中 466 条来自
`/api/v1/models`）。O(N²) 的代价随 N 平方增长，**不要**按「才几百条、无所谓」判断
—— N=1000 时单次就是 5.5 秒的同步阻塞，而它发生在**模型目录构建**路径上。

**⚠️ 未在本机复现的一条**：用户称「每 ~15 秒重建一次」。master 里**找不到** 15 秒
周期的触发源 —— DSH 客户端的 `ModelCatalogDirectory` 只在 4 个宿主事件上重拉
（且有 `status === 'ready'` 短路），插件自己的 `catalog-prewarm` 是 **0/35s/75s
三轮有界**，客户端两个轮询（5 秒 `readActiveProvider`、60 秒余额）都是**纯内存读**、
不触达宿主目录重建。故周期数字**未定案**；但缺陷本身与周期无关：任何一次模型选择器
打开 / 目录事件都会吃满一次 N² 重建。

---

## ⚠️⚠️ 审计补记（2026-10-21，!138 合并后 5 路 subagent 审计）

完整报告：`docs/audit/pr135-138-merge-audit.md`。

### 真缺陷（**未修**，已登记）：`maxTokens` 只有一个来源 ⇒ 系统性缺口 ≈482 个模型

!138 补了 `cline-free/minimax-m3.1-flash` 的 `maxTokens`（点状修复，正确且真下发），
但**故障链对其它模型逐字成立**：

**机制**（代码事实，不是推断）—— cline 的 `maxTokens` **只来自 4 条静态表条目**：

- `parseEntryList`（`src/cline-models.ts`）只取 `{id, name, description}`，
  **把 `maxTokens` / `contextWindow` 直接丢弃**（下游即便下发也进不来）；
- `mergeClineModels` 只从 `fallback` 取；
- `cline-models-dev.ts` 口径 3 **刻意不取** `limit.output`
  （理由：本仓有过「据印象填大值 → 400」的事故 ⇒ 保守选择，**不是疏忽**）。

**实测（2026-10-21 匿名只读 GET `recommended-models`，HTTP 200，未用凭据）**：

```
free 6 条：cline-free/minimax-m3.1-flash, reflection/beam-free,
           cline-free/nemotron-3.5-super-vl, nvidia/nemotron-3.5-lightning-free,
           poolside/laguna-s-2.1-free, cline-free/solar-mini4
recommended 6 / clinePass 13 / clineCloud 1
⇒ **全表每条只有 {id,name,description,tags}，maxTokens 零命中**
```

⇒ free 6 条里**只有 `minimax-m3.1-flash` 在静态表里** ⇒ 另 **5 条拿不到
`maxTokens`** ⇒ 请求体不发 `max_tokens` ⇒ 退回网关默认 **4096**
⇒ 长回答 `finish_reason=length` **静默截断**。加上 `/api/v1/models` 的 460 条
按量模型 ⇒ 同类缺口 **≈482 个**。

⚠️ 另：静态表 4 条 free 里 **3 条已不在 live free 数组**
（`stealth/space-bunny-alpha`、`cline-free/mimo-v2.6-flash`、
`cline-free/muse-spark-1.3-contributor`）。本文件上面的规矩是
「表里有而远端已撤的必须同步删掉」，**这次没执行**。
风险面：远端失败时兜底表整表生效 ⇒ 用户看到已下架的免费模型。
⚠️ 是否真 404 **未实测**（需凭据）。

### ⚠️ 新增守卫的**射程**（这条比缺陷本身更该记）

`tests/unit/cline.spec.ts` 新增的「兜底表里每个免费模型都声明了 maxTokens」
只遍历**表自己的条目** —— 而本次故障是「**模型压根不在表里**」。

**变异实测**：整条删除新条目（= PR 前形态）⇒ **该守卫仍全绿**
（只有被 !138 改了期望值的**快照用例**变红）。
⇒ 「直接锁死本条故障链」的说法**不成立**：快照守住了**这一个实例**，
**类别**（远端新增免费模型）无人守。

另：`filter(m => m.maxTokens === undefined)` 放过 `0 / -1 / NaN`，
而它们与 `undefined` **后果完全相同**（`Number.isSafeInteger && > 0` 都丢掉）
⇒ 正是本仓记过的「「守卫有牙」≠「取值域正确」」。

### 正确的修法方向（**不是**继续补表）

让**远端/模型元数据成为来源**：`parseEntryList` 透出 `maxTokens`/`contextWindow`
并让远端优先；或给「兜底表没有 + 远端不下发」的模型一个**经实测的**保守默认值。
⚠️ 后者要先验「哪个值不会被网关 400」——本仓在 gemini 上踩过
「照抄邻居的 131072 ⇒ `supported range is from 1 to 65537`」。
⚠️ 本 PR 的 `131072` 对**本模型**未实测（提交信息只测到 32768），
且提交信息引用的本文件那段说的**恰恰相反**（那正是 400 事故，
结论是「兜底表数值**凭印象填**」）。
⚠️ 本 PR 引的 5 个 `scripts/probe-cline-*.mjs` **全仓不存在**
⇒ 提交信息里的「实测」无入库脚本可复现。
