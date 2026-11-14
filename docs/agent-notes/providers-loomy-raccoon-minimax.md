<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠️ Loomy（讯飞）provider：七个不能凭直觉改的点

`loomy` 是第 8 个 provider，与其余七者**都不同源**。实现是独立一套
`src/loomy*.ts`（`loomy-product` / `loomy` / `loomy-sign` / `loomy-oauth` /
`loomy-onboarding` / `loomy-credits` / `loomy-auth` / `loomy-adapter`），
适配器复用 `src/openai-compat.ts`（实测是标准 OpenAI 兼容 + 标准 SSE，与 qoder 同形）。

**真实依据**：2026-09-26 用本机登录态对生产端点逐项实测。
以下五条都有实测证据，**不要按其余 provider 的直觉改**：

1. **两套认证头（最容易踩）**：`/chat/completions` 只认
   `Authorization: Bearer <session>`；`/models`、`/points/*`、
   `/onboarding/*` 只认 `token: <session>`。带错的会得到 HTTP 200 +
   `{"code":"100002","desc":"缺少 token"}` —— 看着像「登录失效」，
   实为头用错了。实测交叉矩阵：

   ```
   GET /points/records  + token  → code=000000
   GET /points/records  + Bearer → code=100002 (缺少 token)
   ```

   `loomyChatHeaders()` 两个都发（官方 `llm-completion.js:149-151` 也如此）。
   ⚠️ `Bearer ` 前缀**必需**：无前缀同样回 `100002`。

2. **没有 refresh 端点，`isLoomyRefreshable()` 恒 `false`**。
   `session` 是登录时声明 `expire: 1209600`（14 天）得来的，凭据里**没有**
   `refresh_token`。故 `refresh()` / `refreshAccountCredential()` 是**有效性探测**
   而非续期（探测走 `GET /points/records?pageSize=1`，只读零消耗），
   `refreshAll()` 只探测**已过期**的账号（避免每 30 分钟白发请求）。
   ⚠️ **不要**为了让 `refreshAll` 有活干而把 `refreshable` 改成 true ——
   那会让 UI 假装能续期，实际每次探测都失败。
   ⚠️ `scheduleRefresh()` / `stop()` 是**有意为之的空实现**：`RefreshScheduler`
   的意义是「过期前 1 小时自动续期」，Loomy 无法续期，武装它只会得到
   「触发 → 探测 → 必然抛错 → 停止」的空转。保留空实现是**契约要求**
   （`index.ts` 对全部 provider 统一调用）。

3. **新手任务服务端不校验前置行为**：直接 `POST /onboarding/tasks/complete`
   （body 仅 `{"key":...}`）即可拿满 10000 分，**零 token 消耗**。
   8 个任务：`first_message` 500 / `pick_skill` 1000 / `generate_ppt` 1500 /
   `set_schedule` 1000 / `install_skill` 1500 / `configure_remote` 1000 /
   `create_soul` 1500 / `share_soul` 2000。
   这与 workbuddy2api-panel 的做法**相反**（那边要模拟真实行为、
   上报埋点事件链）。**不要**「照 workbuddy 那样」去发对话/建定时任务 ——
   那是白花积分。若将来服务端加了校验，再走「用 `qwen3.8-flash`
   （x0.8，全表最便宜）模拟真实动作」的降级路径。
   ⚠️ 幂等判据是响应体的 `alreadyCompleted`，**不是** HTTP 码、**不是** `code`。
   ⚠️ **不采信服务端 `earned`**，按本地 `LOOMY_TASK_POINTS` 现算
   （官方 `onboarding-service.js:177-183` 明说不信任）。

4. **倍率在 `name` 字符串里**，没有独立字段，且三种括号风格混用
   （`MiniMax M3 （x4.0）` 全角带空格 / `Qwen 3.8 Max (x12.0)` 半角 /
   `GLM 5.3 Flash(x0.8)` 半角无空格）。故用 `loomyDisplayName()` 规范化。
   ⚠️ `splitLoomyRate()` **必须同时认两种形态**：远端原值（末尾括号）
   **和**已规范化的 `{name} · x{n}` —— 兜底表（`loomy-product.ts`）存的就是后者。
   早期只认括号形态，于是 `resolveModel` 无法从兜底表名去掉倍率，
   返回 `Spark X2.5 · x0.1` 而非 `Spark X2.5`（实现时暴露的真实缺陷）。
   该函数**幂等**，单测锁死。
   ⚠️ chat 模型过滤判据是 **`type === 'chat'`**，不能看 `input_modalities`
   —— 2026-10-14 实测 9 个 chat 模型里 6 个的输入模态含 `image`（能看图），
   不是生图模型；另有 1 个（`qwen-3.8-max`）**不声明** `image` 却实测读得出图，
   见下面第 6 条。

5. **积分是两个池**：永久（`balance`）与每日赠送（`dailyBalance`）分开计算。
   每日额度由 `POST /points/first-login` 触发（官方登录后立即调用），
   语义是**触发额度重置**而非「+5000 积分」：
   实测 `dailyBalance = dailyQuota - dailyConsumed`（4992 = 5000 - 8），
   消耗后不回补。故「一键签到」用 `alreadyProcessed` 判幂等并映射成
   `already-claimed`，**不是** `claimed`。
   ⚠️ **余额查询必须走只读的 `GET /points/records`**，不能用 `first-login`
   —— 后者是**写**端点，在「打开面板」这种高频路径上调用会意外触发签到。
   ⚠️ `dailyQuota` **只在 `first-login` 响应里**，`points/records` 不返回它，
   故未签到时该字段缺省 —— **不要硬编码 5000**（额度可能随活动变化）。

6. **图片能力要过覆盖表，别照抄 `input_modalities`**（2026-10-14 用户报障
   「loomy 的 qwen3.8max 输入不能上图」）。远端 `GET /api/v1/models` 对
   `qwen-3.8-max` 下发 `capabilities.input_modalities: ['text']`（`vision: false`），
   而实测**它读得出图**。照抄声明值的后果不是「图旁边多个提示」，而是 DSH 在
   **附件入库阶段**就按目录拒绝（`dsh-api-session-controller` 的
   `MODEL_DOES_NOT_SUPPORT_IMAGES`）⇒ 用户看到「当前模型不支持图片，请切换支持
   图片的模型」，而那正是他唯一想用的模型。

   判据是**随机纯色 PNG**（64×64，约 137 B，纯标准库生成）：纯文本模型答不出颜色，
   读得到的答得出。2026-10-14 用真实凭据直连生产端点逐个实测（一次一色）：

   | 模型 | 远端 `input_modalities` | 实测读图 | 备注 |
   |---|---|---|---|
   | `DeepSeek-V4.1-Flash` | text,image | ✅ | |
   | `Kimi-k2.6` | text,image,video | ✅ | |
   | `qwen3.8-flash` | text,image,video | ✅ | |
   | `mimo-v2.5` | text,audio,image,video | ✅ | |
   | `GLM-5.3-Flash` | text,image,video | ⚠️ | 颜色名答错一次；RGB 3 次中 2 次命中 |
   | **`qwen-3.8-max`** | **text（漏报）** | ✅ | 4/5 次答对 ⇒ 进覆盖表 |
   | `MiniMax-M3` | text,image,video | ❌ | 4/4 未命中；答案像经典 CSS 色值（`135,206,235`…）⇒ 疑似在编 |
   | `deepseek-v4-flash-0731` | text | ❌ | 思考链吃满预算，正文为空 |
   | `spark-x` | text | ❌ | 自称「我无法读取图片」 |
   | `auto` | 无声明 | ❌ | 未定论（思考吃满 / 答「灰」） |

   - 覆盖表 `LOOMY_IMAGE_CAPABILITY_OVERRIDES` + 判据函数 `loomySupportsImage()`
     在 `loomy-product.ts`；⚠️ **远端与兜底表两条路径都必须过它**（同第 3 条
     旁 `loomyContextWindow` 那条纪律：只改一侧，远端可用时那一侧就白改了）。
   - ⚠️ **不要写成「该家恒支持图片」**：白名单只覆盖实测确认的个案，恒 true 会把图
     放给纯文本模型，让上游回一个更晚、更难懂的 400。
   - ⚠️ `MiniMax-M3` 的**疑似假声明**（声明 image、实测读不出）本次**刻意不降级**：
     用户当时明确只关心 `qwen-3.8-max`，且降级已声明能力会改变既有可用路径 ——
     raccoon 的 `sn-glm-5-3` 就有「网关节点不一致、3 次只对 1 次」的先例 ⇒ 单账号
     证据不足以判死。它按**已知 provider 缺陷**登记在此，待多节点复核后再决定。
   - ⚠️⚠️ **覆盖表查表必须归一，且两张表同一口径**（2026-10-14 合并后审计发现，
     修复见 `loomyCatalogKey()`）：原实现是 `Set.has(modelId)` / `OVER[modelId]`
     **逐字节精确匹配**，而**同一文件**里读远端模态的 `readInputModalities()` 却
     `.toLowerCase()` 归一了 ⇒ 同一个「模型身份」概念在相邻两处两套标准。
     后果是**静默失效**：上游一旦把 id 下成 `Qwen-3.8-Max` 或前后带空白，
     覆盖表恒不命中 ⇒ `inputModalities` 退回 `['text']` ⇒ 准入闸门重新拒图、
     **用户看到的就是本条要修的症状原样复现**，而**零报错、零日志、测试全绿**
     （现有用例构造的 id 全小写，结构上抓不到）。与 zcode 的
     「上游小写 vs 目录大写」是**同一个坑换了个 provider**。
     ⚠️ **归一只能发生在查表那一刻，绝不改对外 `model.id`** —— 它同时是
     `fallbackIndex` / `effortsForModel` 的索引键与 DSH 的模型身份，
     改了会重演 accio「改对外 id ⇒ 聚合补丁索引恒不命中」那类静默连带失效。
     ⚠️ 附带取舍（**已登记，别当它不存在**）：归一后仅大小写不同的两个 id 会折叠
     成一个键；判定可接受（上游 8 条 chat 模型本就混用大小写，说明按 id 而非按
     大小写区分模型；且「不归一 ⇒ 静默拒图」已经真实发生过一次）。
     守卫在 `tests/unit/loomy-product.spec.ts` 的「查表口径」三条 + 一张
     「两张覆盖表的键都必须已归一」的机器守卫（加新条目忘了小写会红）。

7. **额度耗尽的冷却终点 = UTC+8 当日 24:00，不是「撞墙时刻 + 24h」**（Gitee
   **IKL80H**，2026-10-15 修）。每日赠送额度按**自然日**重置，用滑动窗口会让
   23:50 烧光的账号被封到**次日 23:50** —— 用户原话「0 点后 loomy 能用（自己账号
   实测），但插件说模型未到重置时间，不给用」。时长判据抽在
   `loomyCooldownResetAtMs`（`quota` = 当日 24:00、`rate` = 撞墙 +1h）。
   ⚠️ `raccoon-adapter.ts` 的 `RACCOON_QUOTA_COOLDOWN_MS` 至今仍是 +24h ——
   **别照抄它**，也别为「跟 raccoon 保持一致」把这里改回去：两家的**失败分类表**
   必须逐格同构（有对拍用例），**冷却时长**自本条起**刻意分开**（各自取决于额度
   结算周期）。实测取证与变异验证见下文「loomy 的 `quota` 冷却终点」一节。

### 请求热路径上的凭据探测：**只有** `RefreshTokenExpiredError` 是终态（2026-10-20）

`GET /points/records` 是**只读探测**端点，它能不能通 ≠ 凭据能不能用。适配器原先把
`options.refresh()` 的任何异常都往上抛 ⇒ 探测端点抖一下，**整轮对话失败**。

实测伤情（会话 `session-bfb9b616`，`/auto-study` 任务）：

| 轮次 | 文案 | 类型 |
|---|---|---|
| turn 4 | `Loomy 凭据探测失败：系统内部错误` | HTTP 200 信封内的业务错误 |
| turn 5（+27 分钟） | `Loomy 凭据探测网络失败：The operation was aborted due to timeout` | 60s 超时 |

两轮之间**面板三个账号余额全部读得到**（9521 / 5000 / 3996），渠道是活的。
且探测超时上限 `LOOMY_REQUEST_TIMEOUT_MS = 60_000` ⇒ 最坏情况下用户先白等一分钟
才拿到「失败」。

**口径（已落地）**：热路径 `try/catch` 包住探测，
`isLoomyTerminalRefreshError()` 命中 `name === 'RefreshTokenExpiredError'` 才抛，
其余降级为 `warn` 并**继续用现有凭据发请求**。理由：

- 该口径**不是新造的** —— `LoomyAuth.refreshAll()` 早已如此（只把终态记 warn、
  其余记 warn 后继续下一个账号）。热路径与它不一致属「同一仓库两套同义判据」
  （PR !62 同型）。
- Loomy **无续期端点**，探测的唯一产出是「要不要提示重新登录」。真正的失效会在
  业务请求上以 401 / `100002` 暴露，由换号与 `classifyLoomyFailure` 接住。
- `expires_at` 是**本地按登录时刻 + 14 天推算**的值（服务端不下发），
  「本地判过期」本就不等于「凭据已死」。

⚠️ 判据按 `name` 而非 `instanceof`：类在 `loomy-auth.ts`，打包/多副本下
`instanceof` 会假阴性，把「请重新登录」误降级成「继续用」。
⚠️ 守卫在 `tests/unit/loomy-adapter.spec.ts` 的「凭据探测失败不得打断本轮」三条
（业务错误 / 超时 / **反向对照**：终态仍必须抛）。变异验证：把 try/catch 换回
裸 `await refresh()`，前两条**变红**、第三条保持绿。

### 短信登录：唯一没有 loginUrl 的 provider

其余 7 个都是「`account.create` 返回 `loginUrl` → 前端 `window.open` →
轮询 `login.poll`」。短信登录**没有 URL 可打开**，故扩展了登录契约：

- `RpcCreateAccountRequest` 加可选 `phone`
- `RpcCreateAccountResponse` 加可选 `loginMode: 'url' | 'sms'`
  ⚠️ **缺省必须视为 `'url'`** —— 既有 7 个 provider 不传该字段，
  行为必须逐字节不变
- 新增 `login.sendSms` / `login.submitSms` 两个端点

⚠️ **msgid 用内存暂存表**（`pendingSmsMsgid`），**不写进 `ctx.credentials`**
—— 它是一次性中间态（5 分钟有效），写凭据会污染命名空间，且它不含任何秘密。

⚠️ **短信登录失败不删占位账号条目**：用户多半只是验证码输错，保留条目让他能重试。

⚠️ **前端短信分支绝不能回退到 `window.location.href`** —— 那会把整个设置页
导航走（与 `createAccount` 的既有约定同因，见「+ 新建账号」章节）。

### 能力矩阵第三项：`onboardingTasks`

```js
loomy: { balance: true, dailyCheckin: true, onboardingTasks: true }
```

⚠️ `onboardingTasks` 与 `dailyCheckin` **语义独立，不能互相推断**：
前者**一次性**（每号只能领一次 10000 分），后者**每天**有收益。
故新手任务有独立按钮与独立端点（`onboarding.status` / `onboarding.claim`），
**不参与**页头「一键签到」遍历 —— 否则每天会对已领完的账号
发 8 个必然 `alreadyCompleted` 的请求。

⚠️ 客户端**不调用** `onboarding.status`：`onboarding.claim` 的响应已带回
`earned`/`total`/逐任务明细，足以渲染进度，再发一次只读查询纯属多余请求。

### 账号卡片：两个积分池分开显示

`CreditBalanceRow` 对「恰好两个包且名字为 `永久积分` / `每日赠送`」的形态
显示 `永久 15000 · 每日 4992`；其余 provider 的多个同类资源包仍显示
「N/M 个资源包有效」。两种形态互斥（`isLoomyTwoPools`）。

### ⚠️ 多账号负载均衡：Loomy **不会**因积分耗尽报错，既有换号机制对它无效

**真实缺陷**（用户报障）：Loomy 会**一直消耗同一个号**，从不触发限流换号。

**根因**（实测 2026-09-26）：今日赠送额度（每天 5000）耗尽后，服务端
**继续扣永久积分且照常返回** —— 「耗尽」是**静默降级**，不是错误。
而本插件既有的换号机制（`getAvailableAccount` 按 `modelRateLimits` 排除账号）
**只在服务端返回限流错误时触发**，故对 Loomy 完全无效。

**修法**：Loomy 用**独立的按余额优先选号**（`src/loomy-balance-rank.ts`
纯函数 + `src/loomy-balance-selector.ts` 带缓存的选择器）：

| 优先级 | 判据 |
|---|---|
| 1 | `dailyBalance > 0`（今日额度每天刷新、不用会浪费） |
| 2 | `permanentBalance > 0` |
| 3 | 其余（含**查询失败**） |

三条**不能改**的约定：

1. **档内保持手动拖拽顺序**，不按余额大小重排（用户明确要求，
   与 `getAvailableAccount` 的既有语义一致）。
2. **查询失败归最后一档**（不是第一档）—— 用户明确要求：
   宁可先用能确认余额的号。
3. **候选先按「未停用 + 该模型未受限」过滤，再按余额分档** ——
   用户明确要求「策略建立在模型没有受限且账户没有被设置为停用的基础上」。
   ⚠️ 故 `resolveCredential` **必须接住并透传 `modelId`**（限流是**按模型**记的）：
   适配器侧 `resolveCredential(modelId?)` → 宿主侧用它过滤
   `a.modelRateLimits[key]`。早期实现传空串 `''`，等于不按模型过滤。

余额查询**带 60 秒 TTL 缓存**（`LOOMY_BALANCE_CACHE_TTL_MS`）：每次选号都实时查
所有账号会显著变慢（N 个账号 = N 次网络往返）。

⚠️ **不要**把 Loomy 塞回 `getAvailableAccount` 的通用逻辑里 —— 那个函数服务
全部 8 个 provider，而「按余额分档」是 Loomy 独有的需求（其他 provider 的
积分模型不同，且多数会返回限流错误）。Loomy 的 `resolveCredential` 自己
`listAccountsByProvider` + 过滤 + 调选择器。

### ⚠️ 锁定永久积分（Loomy 全局开关，**必须持久化**）

**用户需求**：面板上一个开关，锁定后**只允许消耗今日赠送额度**，永久积分不参与
选号 —— 只剩永久积分的账号在锁定期间**等同于不可用**。用户原话：
「锁定永久积分后没有临时积分后找可用账号就是没有可用账号，解锁以后才能再没有
临时积分的时候找到有永久积分的账号」。

实现分三层，**每层都有非显然的约束**：

| 层 | 落点 | 关键约束 |
|---|---|---|
| 纯函数 | `loomy-balance-rank.ts` 的 `LoomyTierOptions.allowPermanent` | 锁定时只剩永久积分的账号落 **`none` 档**（不是降到 permanent 档） |
| 选号 | `loomy-balance-selector.ts` 的 `select(candidates, options)` | ⚠️ 只在**锁定**时把「全部不可用」判成 `undefined`；解锁时**保持既有行为**（全 0 也返回第一个，让上游报余额不足） |
| 宿主 | `index.ts` 的 `resolveCredential` | ⚠️ 锁定时**绝不可落到单凭据兜底** —— 那会绕过锁定照样烧永久积分 |

⚠️ **持久化是本改动最容易出错的地方**：`JetHubState` 由「两字段」变「三字段」，
而**所有写入点都是整体替换**（`writeAccounts` / `writeModels` /
`setLoomyPermanentLocked` / `replaceAll` / `store.save`）。漏带一处，用户的锁就会
被下一次「新增账号」「改模型开关」静默解开 —— 与 `disabledModels` 当年踩过的坑
**完全同型**。`tests/unit/account-pool.spec.ts` 的「Loomy 永久积分锁定」段专门
守着它，且已做**反向验证**（注入「新增账号漏带锁定」时用例会失败）。

⚠️ **缺省必须为「解锁」**：老文档/老备份没有该字段，读到时按 `false` 处理
（与既有行为一致），**不要**因为字段缺失就报错或让整次载入失败。
`replaceAll` 对 `undefined` 的处理是**保持当前值**而不是重置为 false ——
否则导入一份老备份会静默解锁用户的永久积分。

⚠️ **写锁定后要广播 `llm/adapters-updated`**（包 try/catch）：它改变**选号结果**，
与 `model.setDisabled` 同一判据（「这次写入会不会改变 `listModels` 的结果」→
这里换成「会不会改变选号结果」）。通知失败不能反噬已落盘的开关。

### ⚠️ Loomy 没有「模型限流」，故不渲染「重测 / 重置」

**用户报障**：「这个 provider 好像没发现模型限流，把重置所有按钮删掉」。

根因就是上一条：Loomy 积分耗尽时**静默降级**（继续扣永久积分），从不返回限流
错误，故那组按钮对它毫无意义 —— 重测永远测不出限流、还会**白烧积分**。

实现用**独立的能力矩阵** `RATE_LIMIT_CAPABILITIES`
（`plugin-src/client/credits-capabilities.js`），Loomy 显式登记 `rateLimit: false`。

⚠️ **它的默认值与积分能力矩阵相反**：积分能力是「未登记 = 不支持」（避免必然
失败的请求），而限流这里必须是「未登记 = **支持**」—— 那组按钮是**既有 UI**，
若默认关闭，将来新增 provider 忘记登记会让老用户**凭空失去**按钮（可见的功能
回退）。故判据写成 `rateLimit !== false`。

⚠️ 面板级（「重测所有 / 重置所有」）与卡片级（「重测 / 重置」）**都要门控**：
只改面板级会让卡片上仍留着两个永远无效的按钮。

### ⚠️ 思考档位：`resolveModel` **必须声明 `reasoning`**，否则选择器根本不出现

**用户报障**：「loomy ide 中可以设置思考档位，我们现在没法设置」。

**根因与 Qoder 那次完全同型**（见本文件 Qoder 的 2.2 节）：`LoomyAdapter.resolveModel()`
**只声明 `context`，从不声明 `reasoning`**。而 DSH 的思考强度选择器**只会**从
`resolveModel().reasoning` 渲染 —— 故档位选择器**从来没有出现过**，
尽管远端 `GET /models` 早就下发了 `reasoning_efforts`。

⚠️ **判据是「DSH 从哪读档位」，不是「远端有没有给」**：远端给了不等于界面有，
中间少一次声明就全丢。**加任何 provider 时都要检查 `resolveModel` 是否声明了
`reasoning`**（同理还有 `context` / `inputModalities`）。

**用户要求「如果能从远端得到配置中直接生成是最好的」—— 已照此实现**：

| 项 | 来源 | 规则 |
|---|---|---|
| `efforts` | 远端 `reasoning_efforts` | **原样取用**（服务端下发的就是展示顺序） |
| `defaultEffort` | ⚠️ **本插件自己的 `high`** | **不采信远端的 `low`**（见下） |
| 中文展示名 | 本文件 `LOOMY_EFFORT_NAMES` | `none:关闭思考 low:低 medium:中 high:高 xhigh:极高` |

实测 8 个 chat 模型**完全一致**：`['none','low','medium','high','xhigh']`。
远端还带 `reasoning_catalog_version`（catalog 哈希），故档位随服务端更新、**无需改代码**。
兜底表（`loomy-product.ts`）存同一份实测值，只在远端整体失败时顶替 ——
⚠️ **抽成 `LOOMY_EFFORTS` 常量而不是逐条写 8 遍**，避免上游变更时漏改其中几条。

⚠️⚠️ **默认档用本插件自己的 `high`，有意不采信远端的 `low`**（用户要求，2026-09-28）：
> 我们档位默认用远端的几档，默认值用自己的高

**依据是 DSH 的取值逻辑**（`dsh-client-ui-model-selection/lib/client.js:512`）：
```js
const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
```
即「用户没选时发哪个档」**完全由适配器声明的 `defaultEffort` 决定**，
沿用远端的 `low` 会让默认思考偏浅。
常量在 `loomy-adapter.ts` 的 `LOOMY_PREFERRED_DEFAULT_EFFORT`，
兜底表的 `LOOMY_DEFAULT_EFFORT` **必须与它一致** ——
否则「远端可用 / 远端失败」两条路径的默认档会不同。

⚠️ **仍必须做 `efforts.includes(high)` 校验**：DSH 会拿 `defaultEffort`
**直接发请求**，某模型若不提供 `high`（远端目录变化时真会发生），
必须**不下发默认档**（退回 DSH 的「服务商默认」语义），而不是发一个非法值
（会抛 `UNSUPPORTED_REASONING_EFFORT`）。

⚠️ **`defaultEffort` 不落在 `efforts` 内时不能下发**：DSH 会拿它**直接发请求**，
给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，比不给更糟。

⚠️ **请求体字段名是 `reasoning_effort`**（与远端声明的复数形式同源，也与 OpenAI 标准
及本插件其余适配器一致）。⚠️ **不能靠 HTTP 状态码判断字段是否生效**：实测传
`reasoning_effort` / `reasoningEffort` / `thinking` **三种都返回 200** —— 服务端对
未知字段**静默忽略**（与「无效模型名回退默认模型」同一模式）。故字段名的依据是
**远端自己的命名**，而非「试出来能通」。

⚠️ **下发前必须校验档位在该模型的 `efforts` 内**（DSH 会把用户选的值直接透传）：
越界时**静默不下发**（退回服务端默认档），而不是发一个可能被拒的值。

⚠️ **实测「关闭思考」并不会真的消除思考内容**（`reasoning_effort:'none'` 仍返回
`reasoning_content`，`reasoning_tokens` 与基准相当）。**这是服务端行为，不是我们的
bug** —— 用户已明确接受（「设置关闭思考实际思考了可以接受」）。
同理 `xhigh` 也**不会**显著增加思考量，但**它是安全的**：实测 HTTP 200、
无流内错误帧、`finish_reason=stop` 未截断（用户关注点：「设置 xhigh 最大思考
如果出问题就不好了」）。

⚠️ **验证这类字段必须用流式**：第一版用**非流式 + 难题**，结果**连基准都 504**
（非流式长思考撞网关超时）—— 那是超时，不是档位问题。DSH 走流式，故探针也须流式。
且**不能用「思考字数」当唯一判据**：简单题目的思考量本来就小，各档差异淹没在噪声里。

排查脚本与取证命令**见不入库的 `docs/loomy-protocol-notes.md`**
（本文档不放脚本清单）。回归用例在 `tests/unit/loomy-adapter.spec.ts` 的
「LoomyAdapter 思考档位」段（9 条）与「请求体里的 reasoning_effort」段（4 条）。
⚠️ 已做**反向验证**：去掉 `resolveModel` 里那两行声明 → **5 条变红**。

### ⚠️ AccessKey 明文入库（用户明确同意）

`src/loomy-product.ts` 内含从 Loomy 客户端解密得到的讯飞账号 AccessKey。
它**只用于讯飞账号端点**（`account.xfinfr.com` 的登录签名），与业务/推理端点无关
（后者用用户登录后的 `session`），故泄露不涉及任何用户数据。

⚠️ **具体值、解密算法与口令、脚本清单见不入库的
`docs/loomy-protocol-notes.md`** —— 不要把它们写进 README / AGENTS.md。

### 新增 provider 时的位置参数陷阱（本次踩过）

`registerJetHubRpc` 与 `registerJetHubEndpoints` 的 auth 实例是**位置参数**。
新增 Loomy 时，三个既有测试因把参数列表写死而假失败：

- `tests/unit/qoder-wiring.spec.ts`（正则只允许一个 provider 插在 trae 后）
- `tests/unit/cline-adapter.spec.ts`（`toContain` 写死整串）
- `tests/unit/jet-hub-rpc.spec.ts`（9 个 `{}` 占位，新签名要 10 个 →
  `modelAdapters` 错位落到 `loomy` 形参上）

三处已改为**对 provider 数量中立**的断言（`[\w, ]*` / 显式补占位并注明原因）。
**再加 provider 时请沿用这种写法**，不要写死整串。

⚠️ 加 Raccoon（第 9 个）时**又踩了一次**：`tests/unit/jet-hub-rpc.spec.ts` 里
三处 `registerJetHubRpc(...)` 调用只补到 `loomy`，于是 `raccoon` 形参收到
`undefined`、`modelAdapters` **错位**落到 `raccoon` 上 → `model.list` 的
「关闭的模型仍显示倍率」用例假失败（表现为「展示名退化成裸 id」）。
`tests/unit/loomy-wiring.spec.ts` 的正则也因写死 `cline, loomy, modelAdapters`
而假失败。两处都已改为对 provider 数量中立的写法。
**教训**：新增 provider 后，`grep -n 'registerJetHubRpc(' tests/` 把**每一处**
调用点都补上占位，别只改报错的那一处。

---

## ⚠️ Raccoon Work（商汤小浣熊）provider：不能凭直觉改的点

`raccoon` 是第 9 个 provider。实现是独立一套 `src/raccoon*.ts`
（`raccoon-product` / `raccoon` / `raccoon-oauth` / `raccoon-qr` /
`raccoon-login-page` / `raccoon-credits` / `raccoon-auth` / `raccoon-adapter`），
适配器复用 `src/openai-compat.ts`（与 qoder / loomy 同形）。

**真实依据**：2026-09-26 对生产端点逐项实测 + 客户端 `app.asar` 逆向
（工具 `scripts/raccoon-asar.mjs`）。

### 1. 官方登录链路**不可复用**，微信扫码才是可行路径

官方桌面端（`build/electron/main/desktopLogin.js`）走
「网页授权 → `office-raccoon://auth/callback?code=` →
`POST /login_with_authorization_code`」。

⚠️ **本插件收不到那个自定义协议回调**（宿主侧 Node 进程），
且 `/code/authorize` 页面的回调地址**写死在 Web bundle 里**
（`hl()` 直接 `new URL("office-raccoon://auth/callback")`），改不成 localhost。

**可行路径**：二维码的 `code` 由**客户端本地随机生成**
（`CryptoJS.lib.WordArray.random(16)` → 32 位 hex），服务端只做轮询查询。
⚠️ **实测任意自造 code 都被接受**并进入 `pending`：

```
POST /api/web/auth/v1/login_with_qrcode_code  {"qrcode_code":"1790405291292abcdef123456"}
→ 200 {"code":0,"message":"success","data":{"status":"pending"}}
```

状态机：`pending` → `logging`（带 `expired_at`）→ `success`（带
`access_token`/`refresh_token`）/ `canceled`。轮询间隔 **2000ms**。

### 2. 手机号必须 AES-128-CFB 加密；短信强制阿里云滑块

算法（渲染层模块 68284 的 `yv()`）：

```
key   = UTF8("senseraccoon2023")  → 16 字节 ⇒ AES-128
iv    = 随机 16 字节
mode  = CFB, padding = NoPadding
输出  = Base64(iv ‖ ciphertext)
```

⚠️ 必须**显式**写 `aes-128-cfb`：密钥 16 字节，写成 `aes-256-cfb` 会因长度
不足而抛错（不会自动补齐）。
⚠️ 填充语义已实测：CFB 是流密码，`setAutoPadding(true/false)` 输出**完全一致**
（11 字节手机号两种设置下密文都是 11 字节）—— 不必纠结。
⚠️ 错误码区分：明文/加密错 → `100003 params_encryted_error`；
加密格式对但号码非法 → `100002 params_invalid_error`。
⚠️ **`send_sms` 强制阿里云滑块**（`100006 captcha_verify_error`，
`SceneId=1pkmy0x3`、`prefix=hk1r5l`，脚本
`https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`）。
已核实该脚本**无域名白名单校验**（扫 `document.domain`/`referer`/`origin`/
`whitelist` 均无命中，唯一 `document.domain` 命中是 core-js 的 iframe polyfill），
故本地页可以真实加载它。

### 2.5 ⚠️ **1 倍倍率也必须显示**（不要省略成无后缀）

**真实缺陷**（用户报障）：「为什么 Kimi-K3 没有倍率，ide 是 1 倍，1 倍也要显示倍率」。

`raccoonDisplayName` 早期有一条 `if (effective === 1) return name` ——
按「1 倍是默认，显示属噪声」省略了它。后果是**用户无法区分两种情形**：

- 该模型**本来就是 1 倍**（`billing_effective_multiplier === 1`）；
- 我们**没取到它的倍率**（字段缺失 → `Number.NaN` → 不加后缀）。

两者在列表里看起来一模一样（都只有模型名）。IDE 的模型选择器对 `Kimi-K3`
显示「1 倍」，故本插件对齐：**一律显示 `x生效价`**。

⚠️ **`NaN` / 负数仍然不加后缀**（那才是真正「取不到」的情形）——
不要把这两条合并成一条「1 倍或缺失都不显示」。

⚠️ 同理适用于**兜底表**：`raccoon-product.ts` 里 `sn-kimi-k3` 的
`name` 必须写 `'Kimi-K3 · x1'`，不能写 `'Kimi-K3'`
（兜底表与 `raccoonDisplayName` 的输出形态必须一致，否则远端/回退两条路径
显示不同）。

回归用例：`tests/unit/raccoon.spec.ts` 的「倍率恒为 1 时也要显示」、
`tests/unit/raccoon-product.spec.ts` 的兜底表断言、
`tests/e2e/raccoon-probe.e2e.spec.ts` 的远端实测断言。

### 3. ⚠️ 每日 300 积分**没有端点**，不要实现签到按钮

实测「每日积分发放」是**服务端按日自动发放**的（账单
`biz_type: 'daily_grant'`；该账号 13:30 注册、13:31 即到账）。
**不存在可调用的签到接口**。

故能力矩阵是 `{ balance: true, onboardingTasks: true }`，
**不登记 `dailyCheckin`** —— 登记了会让「一键签到」按钮每次点击都必然失败
（与 CodeArts 早期「对不支持的 provider 无条件发请求」同类）。

⚠️ 同时**不要**把 `login/points/grant` 当作每日签到：它是**幂等一次性**的
（已领过返回 `granted:false`，账单里能看到上一次记录），
第二天再点只会继续拿到 `granted:false`，与「签到」文案不符。

⚠️ 三个来源必须分清：

| 来源 | 金额 | 触发 |
|---|---|---|
| 新人注册礼包 | 3000 | 注册时服务端自动发放（`biz_type: reward_grant`） |
| **桌面端登录奖励** | 3000 | `POST /api/web/desktop/v1/login/points/grant` |
| 每日积分发放 | 300 | **服务端按日自动发放** |

⚠️ 判定「登录奖励是否已领」**不能只按 `biz_type === 'reward_grant'`**
（注册礼包也是它），必须同时匹配 `event_name === '桌面端登录奖励'`。
服务端**没有单独的奖励状态端点**，只能查 `GET /points/v1/bills` 明细
（`fetchRaccoonOnboardingStatus`）。

### 4. 零客户端依赖（硬约束，有测试守住）

⚠️ **运行时绝不读客户端数据**。理由（均为实测）：

1. 客户端**退出时删除** `~/.box-agent/config/auth.json`；
2. 客户端**每次重启都轮换整组凭据** —— 实测从
   `%APPDATA%\office-raccoon\Local Storage\leveldb` 提取的 `access_token`
   在 `exp` **尚未到期**（剩余 5859s）时就被 `401 200003` 拒绝，
   对照进程启动时间可确认是重启导致的轮换；
3. 用户可能**根本没装客户端**。

由 `tests/unit/raccoon-client-independence.spec.ts`（**源码扫描式**回归防线）
守住：禁止 `src/raccoon*.ts` 出现客户端路径（`raccoon-ai` / `office-raccoon` /
`box-agent`）、环境变量（`APPDATA`/`LOCALAPPDATA`）、文件读取
（`readFileSync`/`node:fs`）、以及 `leveldb`/`sqlite` 引用。

⚠️ **为什么用源码扫描而不是 mock**：这类约束的失效方式恰恰是
「某次改动悄悄加了一个 `readFileSync` 兜底」，mock 测不出来。

⚠️ 注释里解释「为何不这么做」是允许且鼓励的（扫描前会剥掉注释行）。

客户端安装目录仅用于**逆向取证**与**构建期图标提取**，都不是运行时依赖：

- `scripts/raccoon-asar.mjs`（只读探查，协议升级时用它重新核对）
- `scripts/extract-raccoon-icon.mjs`（**不入库**，见下）

### 5. 二维码是自己实现的，且**必须编码成真 PNG**

仓库**没有任何 QR 依赖**（已核实 `node_modules` 与 DSH 的 `node_modules`），
故 `src/raccoon-qr.ts` 自行实现（byte 模式 + 纠错等级 M + 版本 1–10，
约 550 行，含 GF(256) RS 纠错、zigzag 放置、8 掩码评分）。

⚠️ **两条真实教训**：

1. **结构测试全过 ≠ 二维码可用**。早期 14 个用例（finder 位置、尺寸、
   确定性）全部通过，但实际扫不出来。**判据必须是「与独立实现交叉验证」
   或「真实解码器能解出」** —— 本次用 Python `qrcode` + `segno` 双实现
   交叉确认，再用 **OpenCV `QRCodeDetector` 真实解码**验证
   （4 个用例含 144 字节登录 URL 全部还原正确）。
2. **登录页内联 SVG 时绝不能转义引号**。`renderRaccoonLoginPage` 早期把
   SVG 的 `"` 转成 `&quot;` 再注入 HTML，浏览器把它当**文本节点**而不渲染
   —— 用户报障「弹出页面二维码没显示出来」。
   ⚠️ 而当时的断言 `toContain('viewBox')` 在**有 bug 时也通过**
   （`viewBox=&quot;0 0 …&quot;` 同样含子串 `viewBox`），故缺陷从未被抓住。
   现断言要求「无 `&quot;`」+「合法 `<svg …>` 标签」+「path 段数 > 100」。

⚠️ `buildQrMatrix` 的 `options.mask` 参数**仅用于诊断与交叉验证**
（生产路径不传，走自动评分）—— 但它必须真的生效，
`tests/unit/raccoon-qr.spec.ts` 锁死了「8 个掩码产出各不相同」。

### 6. 过期判定必须回退解析 JWT（修过的真实缺陷）

`raccoonCredentialExpiresAtMs` 取值优先级是
**`expires_at` → JWT 的 `exp`**。

⚠️ 早期只读 `expires_at`，而它是**可选字段**（老凭据/手工导入可能没有）
→ 过期判定**恒为 false** → `refreshAll` 永远跳过这些账号
→ 表现为「凭据悄悄过期、续期从不触发」，与「续期按 `enabled` 过滤」
那次缺陷是同一类（**静默失效，无任何报错**）。
`tests/unit/raccoon.spec.ts` 有针对性回归。

### 7. 图标：从官方 1024×1024 提取，且**必须编码成 PNG**

来源 `C:\Program Files\raccoon-ai\resources\assets\icon.png`（1024×1024）。

⚠️ **不用 exe 内嵌图标**：实测 `ExtractAssociatedIcon` 与
`new Icon(exe, 64, 64)` 都只拿到 **32×32**（资源组里没有更大尺寸），
缩到 20×20 会糊。

⚠️ **真实缺陷**：`scripts/extract-raccoon-icon.mjs` 起初把**裸 RGBA 缓冲**
直接 base64 当 PNG 用 —— 产出字符串长度正常（12310 字符）、
`toContain('data:image/png;base64')` 也通过，但**不是合法 PNG**，
浏览器渲染不出来（图标位置一片空白）。改用 `encodePng()` 编码
（base64 从 12310 降到 2978）。
判据见 `tests/unit/raccoon-client-panel.spec.ts`：
**PNG 签名 `89504e470d0a1a0a` + IHDR 尺寸 + 非全透明**。
⚠️ 注意：该图标的 base64 **以大片 `AAAA` 开头**（顶部透明行全 0 字节），
目视很像空图但**数据正常** —— 故判据不能靠目视。

### 8. Raccoon-Auto 不是远端模型，**不要暴露**

它是客户端 i18n 条目（`modelPicker.auto` = `"Raccoon-Auto"`，
`modelPicker.autoMultiplier` = `"1 倍"`）渲染的**「自动选模」入口**，
**不在 `model_catalog` 里** —— 直接发给 `chat/completions` 会 404。

其真实语义由客户端 `resolveAutoCatalogModel()` 实现：按消息内容正则打标
（`TASK_TAG_PATTERNS` 识别 vision/code/analysis/office…）后按
`ability_level` 与 `context_window` 从候选池选真实模型；
候选池判据 `isTemporaryAutoRoutingModel()` 认 `raccoon-*` 前缀
或**含 `deepseek`**，故 `sn-deepseek-v4-1-flash` 也在其中。

**不实现的三条理由**：① DSH 的模型选择是**会话级固定**的，而 IDE 是
**按每条消息动态**选模，语义不匹配；② 复现需移植整张正则表，且选出的模型
**不可预测**、难排查；③ `ability_level`/`tags` 是客户端 UI 偏好，
不构成服务端契约，随时可能变。

**替代**：用户可直接选 `sn-deepseek-v4-1-flash`（`ability_level: 3`、
带 `auto` 标签，即复杂任务下自动选模最可能选中的那个）。

### 9. 工具调用：`tools` 必须真下发（Qoder/TRAE 的同型坑）

⚠️ 适配器把 `options.tools` 映射成 OpenAI 的
`{type:'function', function:{name, description?, parameters?}}`
写入请求体**顶层 `tools`**。

⚠️ **判据是「响应里有结构化 `tool_calls`」**，不是「模型在正文里说它想调用
工具」—— 后者正是 Qoder（WASM 把 `tools` 硬编码 `[]`）与 TRAE 踩过的形态：
模型拿不到函数 schema，只能用**正文里的 XML 文本**臆造，harness 认不出 → 任务终止。

⚠️ **间接证据（不是直接验证）**：桌面端 `model-profiles.json` 指向本端点，
且其背后的 agent 运行时 `box-agent-acp.exe` 内含 `tool_choice`（37 次命中）与
`function_call`（15 次命中）及完整 `openai.types.*` 类型表
—— 说明它构造的是带 tools 的 OpenAI 请求体。

⚠️ **本项的正式判据在 `pnpm test:e2e:raccoon-tools`**（双重闸门，
发真实请求验证）。实现期因客户端凭据被轮换而**未能完成真机实测**
（见设计文档 §12）—— 若该探针报「未返回 tool_calls」，
**不要**改用「system prompt 注入 + 正文 XML 解析」的回退方案。

### 10. 短信登录的 `nation_code` 初版只做 86

客户端下拉有 86/852/853/81。插件初版**只做 86（大陆）**，
因为 `100002 params_invalid_error: param phone invalid` **无法区分**
「号码格式错」与「该区号不支持」，不做未验证的猜测。

### 11. ⚠️ 图片能力：**默认支持**，只禁真正的纯文本模型（2026-10-03 / 10-21 两次漏判）

**症状**：给 `sn-deepseek-v4-1-flash`（DeepSeek-V4.1-Flash）发图，模型回
「无法读取图片 / 不支持图片」。

⚠️ **根因不是配置写错，而是「信息在源头就不存在」** —— 远端**从未下发**模态字段：

穷举 `model_catalog` 9 个条目的**键并集**：顶层 14 个键、`params` **只有**
`context_window` 与 `max_tokens`；用
`/modal|vision|image|img|multimodal|media|type|capab|support|input|output/i`
扫描，**命中 0 个**。⇒ 唯一的信号是 `tags`，而它被实测证伪。

**根因链（每一步都是「静默」）：**

1. `normalizeRemoteModel` 把「`tags` 含 `vision`」当成服务端能力声明；
2. `sn-deepseek-v4-1-flash` 的 `tags` 是
   `["general","code","html","analysis","reasoning","auto"]` —— **没有** `vision`
   （`display_description` 也只写「通用对话、代码开发、复杂分析」，不提图像识别）；
3. ⇒ `inputModalities` 播报 `['text']`；
4. ⇒ ⚠️ **DSH 在 `LlmRuntime` 里把图片替换成文本占位符**
   （`dsh-llm/lib/index.js` 的 `projectImagesForTextModel`，产出
   `[image omitted because this model accepts text only; attachment sha256:…]`）
   —— **图片根本没发出去**，请求体里压根没有图片；
5. ⇒ 用户看到模型说「读不到图」，而端点其实完全正常。

⚠️ **判据是「模型真的读得出来吗」，不是「远端怎么说」**（同 Qoder 那条
「IDE 能否用同一模型」）。实测：同一张**随机 6 位数字**图（模型无法猜）打
`POST /api/web/llm/v2/chat/completions`：

| 模型 | 远端 tags 含 vision | 实测读图 |
|---|---|---|
| `sn-deepseek-v4-1-flash` | ❌ | ✅ **5/5**（208063/942977/999889/123015/478368） |
| `sn-glm-5-3-flash` | ❌ | ✅ 1/1 |
| `sn-sensenova-6-8-flash` | ✅ | ✅ 2/2 |
| `sn-sensenova-6-8-flash-lite` | ✅ | ✅ 1/1 |
| `sn-kimi-k3` | ✅ | ✅ 1/1 |
| `sn-glm-5-3` | ✅ | ⚠️ **1/3**（provider 侧节点不一致，见下） |

⇒ **6 个兜底可见模型全部能读图**（2026-10-21 远端新增的
`sn-deepseek-v4-1-flash-1017` 同样实测 200 / 四色全对，见下）。`tags` 的真实用途是**客户端「Raccoon-Auto 选模」的
偏好标签**（`TASK_TAG_PATTERNS` 给消息打 vision 标记后挑一个带 `vision` 的模型），
它回答的是「该模型适不适合处理这类任务」，**不是**「能不能吃图」。

**修法（2026-10-21 策略翻转：默认支持 + 纯文本黑名单）**：
判据是 `raccoonSupportsImage(modelId)` —— **默认返回 `true`**（声明
`['text','image']`），只把实测确认的纯文本模型登记到 `RACCOON_TEXT_ONLY_MODELS`
里**显式禁掉**；判定内核 `raccoonSupportsImageWith(textOnly, id)` 入参化，
否则空集合下「纯文本被禁」那条分支永远测不到。
**两条路径都要改** —— 远端解析（`raccoon-auth.ts`）与本地兜底表（`raccoon-product.ts`）。
⚠️ 兜底表与远端判定是**两个真相源**，用单测「兜底表的图片能力与远端判定逐条一致」
锁死，防它们悄悄分叉（同 Qoder「两处等待逻辑必须共用同一实现」的教训）。

**为什么从白名单翻转为黑名单**（两次漏判）：

1. 2026-10-03：`tags` 不含 `vision` 的 `sn-deepseek-v4-1-flash` 被判 text
   —— 当时用「精确 id 白名单」修；
2. 2026-10-21：远端上架同族新版本 `sn-deepseek-v4-1-flash-1017`（`tags` 逐字
   相同、仍无 `vision`）⇒ 精确 id 查不到 ⇒ 又被打回 text。实测该 id 带图 200、
   四象限色 `红/绿/蓝/白` 全对（与无后缀版一致）。
⇒ 白名单式判据**必然腐坏**（远端每次滚版本都要补一次静态表），故改为
「默认 image + 纯文本黑名单」；黑名单同样按**基础 id**（剥末尾 `-NNNN`）命中，
否则纯文本模型滚版本后也会漏禁。

⚠️ **代价（必须知道）**：若远端上线**真正的纯文本模型**而没及时登记，DSH 会放行
图片、上游则可能**静默忽略**（不是报错）⇒ 模型凭文字幻觉作答（accio 的 GLM 5.1
实测同型）。⇒ 黑名单是唯一刹车，新增条目必须先实测「带图被**明确拒绝**」，
而不是「200 但答非所问」。

⚠️ **实测时的两个坑**（否则会得到假的「不支持」）：

1. **必须关思考**，否则 `reasoning_tokens` 吃光 `max_tokens`、正文恒为空
   （首轮 64 token 全被 `reasoning_tokens: 64` 吃掉 → 6 个模型全部「失败」）。
   唯一有效通道是 `extra_body.thinking:{type:'disabled'}`（见本文档
   `RACCOON_EFFORT_*` 段）；
2. **`sn-glm-5-3-flash` 会 400 拒绝该参数**（「该模型始终思考，不支持关闭思考；
   请使用 low、high 或 max」）—— 测它时**不能**发 `thinking`，需另跑一轮。

⚠️ **`sn-glm-5-3` 节点不一致是 provider 侧缺陷，不归我们**：3 次只对 1 次，两次回
「当前模型不支持图片或视频输入」/「未收到任何图片」。错误体暴露网关有 3 个
fallback 组（`raccoon-4eb26a` / `raccoon-0c119c` / `raccoon-ecc5fd`），
**部分节点是纯文本的**。它本来就带 `vision` 标签、我们一直在发图，
**本次修复不改变它的行为** —— 遇到时换模型即可，别改我们的声明。

排查脚本（只读、gitignored）：`scripts/probe-raccoon-vision.mjs`（打远端原始
条目）、`scripts/probe-raccoon-vision-real.mjs`（真实发图，支持 `PROBE_MODELS`
与 `NO_THINKING=1`）、`scripts/probe-raccoon-catalog-fields.mjs`（穷举键并集）。
回归用例在 `tests/unit/raccoon-product.spec.ts` 的「图片能力判定（默认支持，
纯文本模型显式禁掉）」段，与 `tests/unit/raccoon-adapter.spec.ts` 的三条 ⚠️ 用例
（默认 image / 未知新模型 image / 纯文本集合 text，均含版本后缀形态）。
⚠️ 已做**反向验证**：短路「基础 id 命中黑名单」那两行 → 2 条变红；把默认
`return true` 改成 `false` → 7 条变红。

### e2e 探针

```
pnpm test:e2e:raccoon        # 只读：凭据/模型目录/倍率/积分余额/账单，零消耗
pnpm test:e2e:raccoon-chat   # ⚠️ 发推理：标准 OpenAI SSE + reasoning_content 形态
pnpm test:e2e:raccoon-tools  # ⚠️ 发推理：**tools 是否被接受**（第 9 条的正式判据）
```

### ⚠️ 报错文案：`400` 与 `401` 的语义

- `401 200003 authorization_verify_error` —— 凭据失效。
  ⚠️ 排查时**先确认客户端是否刚重启过**：那会轮换 leveldb 里的凭据，
  让人误以为是端点或协议问题。
- `400 100006 captcha_verify_error` —— 滑块过期，需重新过验证。
- `400 100002 params_invalid_error` —— 手机号格式或验证码错。
- `400 100003 params_encryted_error` —— 手机号**未加密**或加密格式不对。

### ⚠️ 失败分类：loomy 与 raccoon 的判据是**同一张表**（2026-10-06 同型复发）

`classifyLoomyFailure`（`src/loomy-adapter.ts`）与 `classifyRaccoonFailure`
（`src/raccoon-adapter.ts`）**逐格同构**：接口形态同族（额度错误没有专用 HTTP
状态码，文案是主通道）、四个类别同义（`quota` / `rate` / `auth` / `other`）、
`rate` 冷却同档（1h）。

⚠️ **但 `quota` 的冷却时长自 2026-10-15 起刻意不再同档**（loomy `quota` =
**UTC+8 当日 24:00**；raccoon 仍是 +24h 兜底）—— 见本节末「loomy 的 quota 冷却终点」。
**分类表仍必须逐格同构**（有对拍用例），只有**时长**这一格分开了：时长取决于各自的
额度结算周期，不属于分类判据。

**真实缺陷（同型复发）**：raccoon 在 `7b524ff` 把判据收窄了两处，loomy **未同步**，
于是同一报文在两个 provider 上被判成**不同类别**，危险方向恒定朝 loomy
（它多写冷却 ⇒ 封可用账号 24h）。本机实测（临时探针，已删）：

| 报文 | loomy（未同步时） | raccoon（已修） |
|---|---|---|
| `403 + insufficient permissions to access this resource` | `quota` ⇒ **写冷却** | `auth` ⇒ 只换号 |
| `403 + 积分不足` | `quota` ⇒ **写冷却** | `auth` ⇒ 只换号 |
| `401 + 余额不足` | `quota` ⇒ **写冷却** | `auth` ⇒ 只换号 |
| `401 + 14018 Credits exhausted`（网关故障常带余额提示） | `quota` ⇒ **写冷却** | `auth` ⇒ 只换号 |
| `400 + the context window is insufficient for this model` | `quota` ⇒ **写冷却** | `other` ⇒ 不换号 |

前四行正是 AGENTS.md 记的 **2026-10-06「全池被封」事故形态**（那次触发词是
`authorization_verify_error`，这次是 `insufficient permissions` / 「不足」类文案）：
**认证类是账号态、不是模型冷却**，写标记会把网关侧授权故障放大成
「整个 provider 被封 24h」。

**两条不变式**（改任一侧都必须同步另一侧）：

1. **401/403 先判**，恒归 `auth`。状态码与额度文案并存时（网关侧故障常在报文里
   捎带余额提示）**以状态码为准** —— 这正是「先按某字段判门禁、再解析」类写法的
   反面（同 AGENTS.md 记的 Qoder 嵌套深度坑）。
2. `insufficient` **单独出现过宽**，必须与邻近的「钱」义词
   （`point` / `credit` / `balance` / `quota` / `token`）**共现**才算额度。
   中文三词（积分 / 额度 / 余额）**不要**收紧 —— 它们的方向是「宁可漏判不可误伤」。
   漏判只是不换号，误判会封可用账号（loomy 现在封到当日 24:00，raccoon 封 24h）。

**防复发的真正闸门是「对拍」而不是各写一份用例**：单方面把一侧「改严」时，
两侧各自的用例**都能过**（本次的 loomy 侧就是这样漏掉的）。
`tests/unit/loomy-adapter.spec.ts` 的「与 raccoon 对拍」段把**同一批真实报文
喂两个分类器、断言逐条同结论**，分叉即红。

### ⚠️⚠️ loomy 的 `quota` 冷却终点：**UTC+8 当日 24:00**，不是「撞墙时刻 + 24h」

（Gitee **IKL80H**，2026-10-13 用户真机报障，2026-10-15 修复）

用户原话：「**0 点后 loomy 能用，我自己的账号实测。但该插件的 loomy 会说模型未到
重置时间，不给用，目测是以积分耗尽的 24 小时做判定。**」

**根因**：Loomy 的每日赠送额度（每日 5000，`dailyBalance = dailyQuota - dailyConsumed`）
按 **UTC+8 自然日**重置，而旧实现写的是 `Date.now() + 24h` 的**滑动窗口**
（常量 `LOOMY_QUOTA_COOLDOWN_MS`，随 `raccoon-adapter.ts` 同形抄来）。
用户在 23:50 烧光 ⇒ 标记落到**次日 23:50** ⇒ 跨过 0 点后上游已放行而插件仍判受限。

| | 时刻（失败时刻 = 2026-10-13 23:50 UTC+8） |
|---|---|
| 修复前写下的标记 | `2026-10-14 23:50`（**+24h**） |
| 修复后的自然日终点 | `2026-10-14 00:00`（只差 10 分钟） |
| 0 点后 10 分钟的判定（修复前） | 仍判「全部账号限流」，距解禁 **23.67 h** |

**症状出口两处**（都读同一个 `modelRateLimits`，故一处根因两处可见）：

- 选号侧 `allAccountsRateLimitedForModel` → `throwIfAllAccountsRateLimited`
  （`src/index.ts`）报「可用账号均在限流中，最近一个将于 <次日 23:50> 解禁」；
- 面板侧 `plugin-src/client/jet-hub.js` 的「限额中」徽章与「限额重置」行。

⚠️ 这同时是 AGENTS.md 红线「**同一 provider 内不得有两套同义判据**」的一处违反：
`aggregate-expiry.ts` 的 `loomyExpiry` 对**同一件事**（Loomy 的每日赠送何时失效）用的是
`nextUtc8DayStartMs()`，与适配器这里的 +24h 结论不同。现统一到自然日，与
qoder / zcode / codearts 三家同口径。

**改法与守卫**（`src/loomy-adapter.ts` 的 `loomyCooldownResetAtMs`）：

- 时长**按类别**算，并把它抽成**导出的纯函数**（入参化 `nowMs`）才测得动 ——
  旧写法是调用点上的三元表达式 `status === 429 ? 1h : 24h`，恒真断言抓不到它；
- `recordsLoomyRateLimit` 改成**类型谓词** `cls is 'quota' | 'rate'`：
  少了守卫时 `auth` 会静默拿到一个冷却时长（旧三元表达式正是这个形状），
  现在由 `tsc` 拦（实测：退回 `boolean` ⇒ `TS2345` 编译失败）；
- 回归用例在 `tests/unit/loomy-adapter.spec.ts` 的「IKL80H：自然日 vs +24h」段，
  **含反向对照**（拿旧值当变异体，断言同一时刻**必须**判受限）——
  只断言「修复后不再受限」是可能恒真的（判据整体失效也会通过）。

**实测的变异验证**（登记结果，含一处无牙）：

| 变异 | 结果 |
|---|---|
| `quota` 退回 `nowMs + 24h` | **3 红**（自然日终点、端到端标记、0 点后症状） |
| `quota` / `rate` 两条分支对调 | **5 红** |
| `recordsLoomyRateLimit` 谓词退回 `boolean` | **`tsc` `TS2345` 编译失败** |
| ⚠️「恰好 0 点撞墙 ⇒ 终点是再下一个 0 点」 | **无牙**：该输入上两式**同值**，退回旧写法仍绿。如实登记，不为它编恒真断言（它的作用是守边界语义：不得返回「此刻」） |

**代价（如实登记）**：`classifyLoomyFailure` 判 `quota` 时分不清「每日赠送用尽」与
「连永久积分也空了」（报文只有 `14018 Credits exhausted`）。改用自然日后标记
**严格变短**（最多差近 24h）⇒ 若某个号永久积分也空，0 点后会被重试一发再重新标记。
刻意取舍：宁可多发一发失败请求，也不让用户白等一整天。

**未同批修（留给后续）**：`raccoon-adapter.ts` 的 `RACCOON_QUOTA_COOLDOWN_MS`、
`trae-cooldown-table.ts` 的 `quota-exceeded`（24h）、`minimax-adapter.ts` 的
`MINIMAX_QUOTA_COOLDOWN_MS` 三处仍是「撞墙 + N」的滑动窗口。本次**只改 loomy**
（用户报障的那一家）—— 这三家的额度结算周期尚未逐家核对，且 trae 的 24h 是有
注释依据的「覆盖到下次签到」⇒ 需各自取证后再动，别顺手统一。
⚠️ 已做**反向验证**：把 loomy 的顺序与 `insufficient` 判据改回修复前 →
3 条变红（含对拍那条）；恢复后 44/44 绿。

### ⚠️ 401 续期后必须**重新反查账号 id**（loomy 与 raccoon 同款，2026-10-06）

`options.resolveCredential` 是**池优先**的（loomy 还叠加余额分档：
`src/index.ts` 先 `loomyBalanceSelector.select()` 再解析该号的 ref），
而 `refresh()` 续期/探测的是**池当前默认账号** —— 二者可能不是同一个号。
⇒ **续期后取回的凭据可能属于另一个账号**，若 `activeAccountId` 不跟着更新，
冷却标记就记在**没发这次请求的号**头上：没耗尽的号被封 24h，而真该封的号
下次仍被选中（「卡死在一个号上」照旧）。

raccoon 在 `51ded6a` 修了这处，**loomy 当时未同步**（同一次审计里已发现
`markCurrentAccount` 的末号漏记，却漏了这一处）。现两家都在续期后按
`refreshed.access_token` 调 `findAccountIdByCredential` 重新反查。
⚠️ 与 AGENTS.md 记的 Qoder「标记用了会变的回调导致标错账号」同型。
⚠️ 已做**反向验证**：去掉 loomy 的反查块 → 对应用例变红；恢复后全绿。

---

## ⚠️⚠️ Raccoon 扫码登录已迁到 IAM：本地随机 code 100% 失效（Gitee IKVA90，2026-11-14）

### 症状

用户点「扫码登录」→ 弹出页面 → 用手机扫 → **插件一直转圈、零报错**，直到 5 分钟超时。
不是「拿不到 token 而报错」，是**连错误都没有**。

### 根因：`qrcode_code` 不再由客户端生成

旧实现（本仓到 `dd81abb` 为止）是 `generateQrCode() = randomBytes(16).toString('hex')`，
依据是当时客户端里的 `CryptoJS.lib.WordArray.random(16)`。2026-11-14 官网改版后
**服务端只认自己签发的 `qr-<uuidv7>`**，本地随机码在新端点上恒回 401。

### 四格实测（决定性证据）

| 端点 | IAM 签发的 `qr-…` | 我们的本地随机 code |
|---|---|---|
| 旧 `/api/web/auth/v1/login_with_qrcode_code` | `200 {"code":0,…,"status":"pending"}` | `200 {"code":0,…,"status":"pending"}` |
| 新 `/api/iam/v1/auth/mp/qrcode/login` | `200 {"code":"OK",…,"status":"pending"}` | **`401 {"code":"AUTH_QRCODE_INVALID","message":"mini-program QR code invalid"}`** |

⚠️ **旧端点是僵尸**：对**任意**字符串恒回 `pending`，不再推进任何状态。
所以「继续打旧端点」不会报错，只会让「二维码早就失效」看起来像「一直在等」——
这就是「零报错转圈」的来源。

### 新协议（三个事实）

1. **签发**：`POST /api/iam/v1/auth/mp/qrcode`（body `{}` 或 `{product_codes:[…]}`，
   实测四种取值结果全同）⇒ `{qrcode_code: 'qr-…', scan_path: '/login/mp',
   expires_in: 300, poll_interval: 2, status: 'pending'}`。
   `expires_in` 与 `poll_interval` 的单位都是**秒**。
2. **轮询**：`POST /api/iam/v1/auth/mp/qrcode/login`（body `{qrcode_code}`）。
3. ⚠️⚠️ **信封是两套**：业务 API 是 `{code: 0}`（数字），IAM 是
   `{code: 'OK', message, request_id, data}`（**字符串** + `request_id`）。
   **必须分开解析**（`parseIamEnvelope` vs `parseEnvelope`）—— 合在一起写，
   任何一方都会静默失效，而且失效方式是「一直 pending」。

### 两个必须重签的终态

- `canceled`（用户在手机上取消）
- `expired`（`401 + AUTH_QRCODE_INVALID`，二维码过期/被消耗）

⚠️ `expired` **不是服务端下发的状态值** —— 服务端只有
`pending / logging / canceled / success`。它由我们在拿到 `AUTH_QRCODE_INVALID`
时**合成**（官方前端同款映射：`"AUTH_QRCODE_EXPIRED"===e.code?"expired":"failed"`）。

⚠️ **不能把 `AUTH_QRCODE_INVALID` 也降级成 `pending`**（那样最省事、也最像「网络抖动」）：
降级 = 页面永远转圈 = 本 issue 的症状原样保留。

### 待解阻塞：`/login/mp` 当前 404

二维码落地页 `/login/mp` 在 2026-11-14 实测**全部 404**（带/不带 `code`、
`appname`、`source=platform`、微信 UA、桌面 UA、`www.` 前缀、`/login/mp.html`、
`/login/mp/index`、`/Login/mp` 都是 `__next_error__`；只有 `/login/mp/` 回 308 再 404；
`/login` 对照 200）。`scan_path` 名为 `/login/mp`，**疑似小程序页面路径被误用于 web 端**。

⇒ 我们仍按官方拼法生成（页面恢复后自然可用），但登录页**必须同时**给出
「用手机 App 扫码」的兜底提示，不能只给一个打不开的二维码。

### 守卫清单（8 条变异全部有牙）

| # | 变异 | 红在 |
|---|---|---|
| M1 | IAM 失效不再映射 `expired`（降级 `pending`） | `expected 'pending' to be 'expired'` |
| M2 | 只认 `code` 不认 HTTP 401（网关换皮逃逸） | 同上 |
| M3 | 登录页只重签 `canceled`（`expired` 不重签） | `expected 1 to be 2`（只签发一次） |
| M4 | 签发票据打**业务 API** 前缀（不是 IAM） | `expected '…/api/web/aut…' to be '…/api/iam/v1/…'` |
| M5 | 二维码 URL 丢掉 `source=platform` | `expected null to be 'platform'` |
| M6 | 拿不到票据时渲染空框（不报原因） | `to contain '二维码获取失败'` |
| M7 | `escapeHtmlText` 恒等（错误原因未转义） | `to contain '&lt;script&gt;'` |
| M8 | 轮询间隔写死 2000（无视服务端 `poll_interval`） | `to contain 'var POLL_INTERVAL_MS = 5000;'` |

### 两条过程教训

1. **判据没打中，先怀疑判据**：M7/M8 首版**无牙** —— M7 的夹具错误消息里
   没有 HTML 特殊字符（`escapeHtmlText` 恒等也全绿）；M8 的夹具
   `poll_interval = 2` 恰好等于常量 `RACCOON_QR_POLL_INTERVAL_MS = 2000`，
   于是「写死 2000」与「用服务端值」**逐字节相同**（本仓记过的恒真形态）。
   修法是 **夹具故意用非默认值**（`poll_interval: 5`）+ 塞真的 `<script>`。
2. **模板字符串里的反引号会提前终止字符串**：我在页面脚本的注释里写了
   `` `poll_interval` ``，`tsc` 立刻报 `TS1005: ';' expected`。
   这是本仓第 N 次踩（同 `jet-hub-styles.js` 的铁律）—— **HTML/CSS/JS 模板里的
   注释一律不许出现反引号**。

## ⚠️ MiniMax Code（中国版 + 国际版）provider：不能凭直觉改的点

`minimax` 是**第 10 个、也是首个 `Anthropic Messages` 协议族**的 provider
（其余九个都是 OpenAI 兼容族或各自的自定义协议）。生产环境
`https://agent.minimax.cn`。实现是独立一套 `src/minimax*.ts`。

### 0. ⚠️ 双站点：`minimax`（中国版）+ `minimaxintl`（国际版）

2026-10-15 加入国际版。**两个站点是两个 provider id**（不是「一个 provider 加一个
区域参数」），与 `qoder`/`qodercn` 同型：

| 字段 | `minimax`（中国版） | `minimaxintl`（国际版） |
|---|---|---|
| `displayName` | `MiniMax Code (中国版)` | `MiniMax Code (国际版)` |
| `accountHost` | `account.minimax.cn` | `account.minimax.io` |
| `apiHost` | `agent.minimax.cn` | `agent.minimax.io` |
| `region`（目录参数） | `cn` | `en` |
| `defaultCredentialRef` | `MINIMAX_ACCESS_TOKEN` | `MINIMAXINTL_ACCESS_TOKEN` |

**只有这 6 个字段不同**（OAuth 常量、全部端点路径、兜底模型表逐字段相同）⇒
**不复制任何** `src/minimax*.ts` 实现文件，差异全在
`src/minimax-product.ts` 的两个常量里。`tests/unit/minimax-intl.spec.ts` 有一条
「除这 6 个字段外两站配置逐字段相同」的断言锁住这件事（要分叉必须先加白名单并写明理由）。

**为什么不用「单 id + 站点落凭据」**（zcode / accio 那种）：
- 那两家的两站**共用同一个推理网关**，站点只决定登录页域名；而 MiniMax 两站的
  **API 主机也不同**，且**账号不互通**；
- 更关键的是**模型目录是按 provider 缓存一份的**（`MinimaxAdapter.loadModels` 的
  `this.remoteModels`）⇒ 单 id 下两台只有一个适配器实例、目录来源是
  `getAvailableAccount('minimax','')` 取到的**那一个**账号所属的站 ⇒ 另一站的模型
  根本不进列表；若改成合并两站目录，用户选中仅 A 站有的模型而选号器选了 B 站账号时，
  请求会发到 B 站主机 —— 而 **MiniMax 对不存在的模型名是 HTTP 200 + `message_start`
  里静默回退成 `MiniMax-M3`**（见本文件 §8.7 的实测表）⇒ **用户完全看不出打错了模型**。
  双 id 下这个错误结构上不可能发生。

⚠️ **两站共用同一个 `MinimaxAdapter` / `MinimaxAuth` 类** ⇒ 改动任何一处实现都会
**同时影响两站**（这是刻意的：同源协议修一遍就够）。但也意味着**接线必须两处都到位**：
`probeById`、`WRITES_RATE_LIMIT_PROVIDERS`、`SELF_HEAL_REFRESHABLE_PROVIDERS`、
`jet-hub-store` 的 ref 前缀表、`provider-credits` 的两条表项 —— 漏一处都是
**静默失效**（症状是「国际站那个面板的某项功能永远不工作」）。

⚠️ **验证状态**（2026-10-16 合并审计修正 —— 原文写「三项未真机取证（本机无国际站
账号）」，与下文 §「✅ 2026-10-15 真机验证：上面 1、2 两项已确认同形，全部可用」
**同文件自相矛盾**；本机**确实**用真实国际站账号登录并逐端点实测过）：
1. **推理路径**（`POST /mavis/api/v1/llm/v1/messages`）—— ✅ **已真机验证**
   （HTTP 200 + 真实 SSE，认证只需 `Authorization: Bearer`）；
2. **签到端点形状**（`/minimax-cloud/api/v1/signin/{status,claim}` + `timezone_id`）
   —— ✅ **已真机验证**（签到状态与积分返回 200）；
3. **兜底模型表** —— ❌ **仍未按国际站远端采集**（两站共用同一份国内站快照）。
   ⇒ **只有这一项**不该读成「已实现」；上面两项已经是实测事实，别再重复劳动。

### ⚠️⚠️ 「登录成功但余额/签到全失败」= 跨 origin 307 剥掉了 `Authorization`（issue IKMEVG，2026-10-17 已修）

**用户报障**：「minimax 国际版登录无法查询余额，领取积分失败，**疑似授权不成功**」。
面板三条症状：积分行「余额查询失败」、「一键领取积分」报
`失败 —— 签到响应缺少有效的 claim_result`、账号卡片却显示「已启用」。

#### 根因（与「授权」无关，凭据其实是有效的）

`agent.minimax.io` 现对**所有**路径恒返 `307 → https://agent.minimaxi.com/...`
（两个 Akamai 边缘 IP、连打 15 次全部一致；curl 独立复核同结果；响应头
`X-From: ak` 表明是 Akamai 边缘规则）。

而按 fetch 规范，**跨 origin 重定向会移除 `Authorization` 头**（本机双端口实验
实测：`Authorization` 被剥、`x-api-key` 反而保留）。于是：

```
带 Bearer 发 → 307 → fetch 自动跟到 minimaxi.com（Authorization 已被剥）→ 400
```

那个 `400 {"error":"invalid signature"}` 与「**完全不发 token**」**同形**
（对照矩阵印证），所以看起来像凭据无效。

**决定性反证**：手动跟随 307 并在每一跳重附 `Authorization` 后，签到面板 /
积分明细 / 推理 SSE **全部 200**（修复后用真实活凭据跑插件代码路径实测：
签到「今日已领=true 额度=400」、余额 `9845.75`）。

⚠️ 补 `x-api-key` **不解决问题**：它虽不被剥，但 MiniMax 业务端点**只认
`Authorization`**（实测仅 x-api-key → 同样 400 invalid signature）。

#### 两个必须记住的结论

1. **「登录跳转到中国版」是客户端的 region 自动检测，不是插件 bug**：
   本机国际版客户端（`MiniMax Code` 3.1.1，`app.asar`）的 `.env.local` 写死
   `NEXT_PUBLIC_LOCALE="zh"`，而 `@mavis/config` 的 `getRuntimeRegion()`
   按 `locale === 'zh' ⇒ 'cn'` 判定 ⇒ 它打开的就是 `account.minimax.cn`，
   落库路径也是 `~/.minimax/auth/prod/**cn**/mcode-public/`。
   ⇒ **装了「国际版」安装包，拿到的仍可能是中国站账号**（两站账号在**数据面
   互通**：同一 token 打 `agent.minimax.cn` 与 `agent.minimaxi.com` 都 200）。
2. **`minimaxintl` 的 `apiHost: 'https://agent.minimax.io'` 目前不可用**：它必被
   307 到 `.com`。保凭据跟随后能通，但那是「借道」—— 若哪天上游不再 307，
   这里要重新核对（**第 3 项待定，用户正在实测真实国际版能否登录**）。

#### 第二道缺陷：`requestEnvelope` 从不检查 HTTP 状态码

`src/minimax-credits.ts` 原实现只解析 JSON 体、**没有** `if (!response.ok)`
（全文件唯一的 `response.status` 只出现在「非 JSON」文案里）。于是
`400 {"error":"invalid signature"}` 这种**没有 `base_resp`** 的体走到
`statusCode === undefined` ⇒ 被判 **`ok: true`**，然后三个入口各自把真因翻译成
**与真因无关**的话：

| 入口 | 拿到 `ok:true` 之后 | 面板文案 |
|---|---|---|
| `claim` | `claim_result` 缺失 | 「签到响应缺少有效的 claim_result」（**正是报障原文**） |
| `signin/status` | 形状不认 ⇒ `null` | 签到状态不可用 |
| `credit/details` | `details`/`total_count` 缺失 ⇒ `null` | 「余额查询失败」 |

⚠️ **这一格此前零覆盖**：反向验证实测，注入 `if (!response.ok) return {ok:false…}`
后跑 **62 条** minimax 用例**全绿**（既有用例构造的响应全是 200 + 合法业务码，
结构上抓不到该分支）。

⚠️ **文案必须如实透出错误体原文**：`invalid signature`（网关/重定向）与
`invalid access token`（凭据）指向**完全不同**的处置动作，压成一句
「查询失败」会让用户照着错的指引去重新登录。

#### 修法与守卫

- `src/minimax.ts` 的 `minimaxFetch` = **重试（外层）+ 保凭据跟随重定向（内层）**，
  **四处调用点共用**（推理 `send` / 目录 `fetchRawModels` / 签到积分
  `requestEnvelope`）。⚠️ 重试必须在**外层**：传输错误在**任何**一跳都可能发生。
- 跟随有**三条硬边界**：① `redirect: 'manual'` 后**每跳重新构造头**（`buildInit`
  传函数而非对象，让「漏带头」在结构上做不到）；② 只跟**可信主机**
  （`minimax.io`/`minimax.cn`/`minimaxi.com`/`xaminim.com`，后缀匹配防
  `evil-minimax.io` 仿冒）且只跟 `https`；③ abort 不继续跟、跳数上限 3、
  不可信/超限时**原样返回 3xx**（绝不假装成功）。
- 守卫：`tests/unit/minimax-redirect-follow.spec.ts`（17 条）+
  `minimax-credits.spec.ts` 的「HTTP 非 2xx 不得被当成成功」（10 条）。
  ⚠️ 其中有一条**事实基线**用**真 Node http server** 起两个端口、用**全局真 fetch**
  走一次自动跟随，断言第二跳**收到的 `Authorization` 为 null** —— 因为本修复的
  全部价值建立在「fetch 会剥头」之上，若某天 undici 改了这条行为，那些用手写
  fetcher 的用例**全部仍会绿**（它们根本没走真 fetch）。

**变异验证（7 条，逐条实测有牙）**：只给第一跳带头 ⇒ 1 红；去掉
`redirect:'manual'` ⇒ 2 红；可信闸门改 fail-open ⇒ 2 红；删 HTTP 状态检查 ⇒
7 红；跟随丢 method/body ⇒ 1 红；去 abort 守卫 ⇒ 1 红；`MAX_HOPS=0` ⇒ 5 红。

⚠️ **本节是「第一、二缺陷」那轮的 7 条**；加上地理分流（第三缺陷）之后新增的
5 条共 **12 条**，完整清单见本节末尾「守卫与变异验证」（以那一处为**唯一权威**）。

⚠️ **连带修掉一个既有脆弱用例**：`officeace-inflight-guard.spec.ts` 的 ③ 号
用例在 `DSH_OFFICEACE_PENDING_TTL_MS='0'` 下依赖「`createdAt` 与稍后的 `now()`
**跨毫秒**」（收口判据是闭区间 `<=`，同毫秒时 `0 <= 0` 为真 ⇒ 跳过收口 ⇒ 假红）。
实测同一份代码连跑 8 次 **5 红 3 绿**，且它曾因一次**无关**改动的导入图变化而
开始大面积变红，极易被误判成该改动的回归。修法是插入 `setTimeout(2)` 让时钟
**确定性**前进（不能用微任务），连跑 10 次 10/10 绿；并做过反向验证（把收口
判据改成 `if (true) continue` ⇒ 该用例仍变红，判别力未丢）。

### ⚠️⚠️⚠️ 决定性根因：Akamai 按**出口 IP** 把大陆流量分流到中国站（同一 issue 的第三层）

上两节修掉「丢凭据」与「谎报成功」后，用户实测**仍然余额查询失败**（这次凭据是
新登录的、有效期 60 分钟）。继续深挖得到决定性结论 —— **40 个变体穷举实测**：

| 随请求附带的 `X-Forwarded-For` | `agent.minimax.io` 的结果 |
|---|---|
| 美国 `8.8.8.8` / `1.1.1.1`、日本 `133.130.0.1`、新加坡、香港 | **留在国际站（200，真实数据）** |
| 中国 `114.114.114.114` / `223.5.5.5` / `180.76.76.76` | **307 → 中国站** |
| 内网 `127.0.0.1` / `10.0.0.1` / `::1`、空值、非法串 | 视为无此头 ⇒ **307** |
| `Accept-Language` / `x-mavis-region` / `X-Region` / `region` / `?lang=` / `?region=` / UA / Origin / Referer / Cookie | **全部 307（完全无效）** |

⚠️ **不是 lang/region 头的问题**：`minimaxHeaders()` 本来就只发
`Authorization` + `Accept`，**从没带过任何中文标识**。是**出口 IP 的地理位置**。

⚠️ **跟到中国站后无法事后区分**：「国际站账号被导到中国站」与「凭据真失效」
返回的 `401 {"error":"invalid access token"}` **逐字同形**（本机实测）⇒
拿它判会把「换个网络就能用」误报成「请重新登录」。故判别**必须卡在 307 那一跳**
（`minimaxFetch` 的 `onGeoRoute` 回调）。错误码刻意用 `SERVER` 而非 `AUTH`
（本仓库 IKLBSH 记过「`AUTH` 码会连 message 一起吞」）。

#### 解法：面板可设 `X-Forwarded-For`（默认关闭）

`state.json` 新增 `minimaxXff` → 面板按钮「国际站分流设置」（**只对
`minimaxintl` 渲染**）→ RPC `minimax.getXff` / `minimax.setXff`。

三条纪律：

1. **只对 `minimaxintl` 生效**（`minimaxHeadersFor` 按 `product.id` 分流）；
   给中国站附这个头纯属伪造来源、无收益。
2. **未设置 ⇒ 一个头都不加**（老用户行为逐字节不变）。
3. **非法值绝不进请求头**：`sanitizeMinimaxXff` 只放行 IP 字面量，且
   **CR/LF 判定必须在 `trim()` 之前** —— 初版栽在这里：`'1.2.3.4\r'` 被 `trim()`
   去掉 `\r` 后变成合法 IPv4 并**通过**校验，那个 `\r` 就看不出来了（头注入）。
   请求侧 `withMinimaxXff` 独立再挡一次（纵深防御）。

⚠️ **该键必须进 `queueStoreSave` 的整体写入 + 两处 load**（`SettingsStore` /
`FileStore`）：漏一处 = 任何一次改账号都静默清掉它 ⇒「设好了，过一阵又开始 307」。

⚠️ **读池设置必须 `typeof` 判**：`pool?.minimaxXff()` 在**只实现部分方法的池替身**
上会抛 `TypeError`（`?.` 只挡 `null`/`undefined`，挡不住「对象上没有这个方法」）
—— 实测让 `minimax-adapter.spec.ts` 的**轮换组 16 条全红**。adapter 与 auth 两处
都已改成 `typeof pool?.minimaxXff === 'function'`。

#### 端到端实测（真实国际站 token，不是中国站 token）

```
不传 XFF：签到 → null、余额 → null          （面板「余额查询失败」）
传 XFF  ：签到 → ✅ 额度 400、余额 → ✅ 0   （该账号余额确实是 0）
```

#### ⚠️⚠️ 一条假阳性教训（值得单独记）

我曾用 `~/.minimax/auth/prod/**cn**/mcode-public/auth.json` 里的凭据去打 `.io`，
读到 200 与「9845.75」，并据此宣布「两站都通了」。真相是：那是**中国站 token**，
被 307 到中国站后读到的是**中国站数据**；打 `.cn` 读到的也是同一份 ⇒
**两边同值恰恰证明是同一个账号读了两遍**。用户一句
「国际版和国内版不可能是同一个积分，是哪里走错了」直接戳破了它。

⇒ 两条硬纪律：
1. **验证国际站必须用国际站自己签发的 token**（`account.minimax.io` 的 device code）；
2. **「两站结果相同」不是成功证据，而是「可能读了两遍同一个站」的信号**。

#### 顺带查清：为什么「国际版客户端登录后跳转中国版」

解包本机 `MiniMax Code` 3.1.1（`app.asar`）：`.env.local` 写死
`NEXT_PUBLIC_LOCALE="zh"`，而 `@mavis/config` 的 `getRuntimeRegion()` 按
`locale === 'zh' ⇒ 'cn'` 判定 ⇒ 它打开 `account.minimax.cn`，落库到
`~/.minimax/auth/prod/**cn**/`。**装「国际版」安装包也可能拿到中国站账号。**

数据面归属实测（同一台主机、同一个 URL）：
```
agent.minimaxi.com/minimax-cloud/api/v1/signin/status
  国内站 token → 200       真国际站 token → 401
```
⇒ `.minimaxi.com` 与 `.minimax.cn` 都是**中国站数据面**，它不认识国际站 token。

#### 为什么不默认开启 XFF

附 `X-Forwarded-For` 本质是**声明一个并非本机的来源 IP**。Akamai 那条规则是上游的
区域路由策略（账单/合规都基于它），默认伪造来源不该是产品的默认行为。故缺省为空，
且 UI 文案**先给「用代理改出口 IP」这条更正当的路**。
⚠️ 它还可能**随时失效**（很多 CDN 已默认不信任客户端提供的 XFF）——届时必须
**如实报错**，不能假装成功。

#### 守卫与变异验证

`tests/unit/minimax-redirect-follow.spec.ts`（17 条，含一条用**真 Node http server**
+ **全局真 fetch** 锁住「fetch 确实会跨 origin 剥 Authorization」的事实基线 ——
本修复的全部价值建立在这条行为上，若 undici 改了它，只用手写 fetcher 的用例会
**全绿但修法已失效**）+ `tests/unit/minimax-xff-geo.spec.ts`（31 条）+
`minimax-credits.spec.ts` 的「HTTP 非 2xx 不得被当成成功」（10 条）。

**12 条变异逐条有牙**：只给第一跳带头 ⇒ 1 红；去 `redirect:'manual'` ⇒ 2 红；
可信闸门 fail-open ⇒ 2 红；删 HTTP 状态检查 ⇒ **7 红**；跟随丢 method/body ⇒ 1 红；
去 abort 守卫 ⇒ 1 红；`MAX_HOPS=0` ⇒ 5 红；去 CRLF 原始串检查 ⇒ 1 红；
XFF 对中国站也生效 ⇒ 2 红；地理路由判据只判后缀（`account.*` 也算）⇒ 1 红；
**credits 不传业务错误原文 ⇒ 2 红**；**adapter 去掉 402 特判 ⇒ 1 红**。

#### ⚠️⚠️ 提交后自查发现的两个真缺陷（都已修）

1. **`geoRouted` 吞掉 402 的余额语义**（P0）。`geoRouted` 只表示「这次请求
   **经历过** 307」，**不表示失败原因就是它**。实测反例 `307 → 402
   insufficient_balance_error`：初版把文案整段换成地理路由说明、并把错误码
   无条件改成 `SERVER` ⇒ **「去充值」这个唯一有效动作彻底消失**，用户会一直
   折腾网络。修法：`describeMinimaxGeoRoute(detail)` 接收业务错误原文并放在
   文案**最前面**；adapter 里 402 仍保 `QUOTA_EXCEEDED`，只有会落到
   `SERVER`/`AUTH` 的档位才让地理路由接管错误码。
2. **UI「清空输入」只改草稿、不落盘**（P1）。用户点完看到输入框空了，会以为
   已关掉绕过分流，实际请求**仍带 XFF**。改为「清除设置」并真正调
   `minimax.setXff({xff:''})`（`save(override)` 显式传值，绕开 React 状态异步）。

⚠️ **一条方法论教训**：这两个缺陷都是我用**纯函数用例**测不出来的 ——
`describeMinimaxGeoRoute` 的纯函数用例在「credits 不传原文」这个变异下**全绿**，
因为判据没打在**业务入口**上。补了 `★★★ 接线` 组（4 条）后该变异才 2 红。
这正是本仓库反复记录的「函数对 ≠ 被用上」。

#### ⚠️⚠️ 子代理审计又打穿三处（2026-10-17，全部已修）

用户要求「提交 + 脱敏审计 + 一轮 subagent 审计 + 对抗性审计」。审计子代理打穿了
三处**我自己没发现的真问题**，我逐条复核后确认全部属实：

**① `SERVER` 错误码会被 DSH 自动重试 5 次（P0，影响两处）**

`@deepseek-ai/dsh-llm` 的 `retry-policy.js`：
```js
DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, 'SERVER', TIMEOUT, TRANSPORT]
DEFAULT_MAX_RETRIES = 5
```
而 minimax 适配器**没有覆写** `providerRetryPolicy`（`src/` 全仓零命中）⇒ 走默认。
两处都中招：
- **地理路由**（本次新增）—— 确定性失败，重试毫无意义，且每次重试会重跑
  `MINIMAX_MAX_ROTATE=8` 的换号循环 + 重定向跟随 ⇒ 最坏 5×8 次无谓请求；
- **`200` 非 SSE**（`isDefinitelyNotSse` 分支，**既有代码**）—— 实测最终
  `error.code === 'SERVER'`（该对象被原样当 `streamError`，**不经过**
  `httpErrorCode()` 重新归类）。

修法：两处都改用**不在默认可重试集合、且不会被 harness 替换文案**的码 ——
地理路由用 `INVALID_CREDENTIAL`（官方注释恰好同理由："a malformed credential
fails identically on every attempt"），非 SSE 用 `INVALID_REQUEST`。
守卫：`★★★ 地理路由的错误码不可重试` + 更新既有非 SSE 用例为
「`code` 不在可重试集合里」（把它从「顺带记录实现」变成有意义的守卫）。

⚠️ 本仓库已记过同型事故（`providers-trae.md`：4006 落 `SERVER` ⇒ 巨型请求体
被原样重发 5 次），这是**同一个坑的第二次**。

**② 文案写死「中国大陆」，与同函数注释自相矛盾（P1）**

`describeMinimaxGeoRoute` 上方注释明写「文案里**不写死"中国大陆"**…写死会误导
走 VPN 但出口仍被判中国的用户」，而实现里就写着「判为中国大陆来源」。
且实测**内网 IP 同样 307** ⇒ 对公司内网出口的用户，这是**事实错误**。
修法：改「被判成中国区（内网或无法解析的地址也会被判成中国区）」，
并**增加第三条指引**「先确认本机出口 IP（如打开 ifconfig.me）」——
否则用户会先怀疑插件坏了。

**③ 两条用例无牙（P1/P2，已实测证实）**

- 「`307 → 402` 不静默当成 0」只断言 `balance === null`，而 402 体无
  `details`/`total_count` ⇒ **删掉 `!response.ok` 整块也照样 null**（两条路都
  返回 null，不可区分）。
- 「超长值被拒绝（>128）」用的输入 `'8.8.8.8'.repeat(30)` 会先被「IPv4 必须四段」
  拒掉 ⇒ 删掉长度判据仍通过。实测改用 `'fe80::1%' + 'a'.repeat(130)` 后才变红
  （该串含 `%` ⇒ 字符集放宽、IPv6 形状也合法 ⇒ **只有**长度判据能拦）。

顺带补了 `sanitizeMinimaxXff` 的 **IPv6 段数校验**（初版只做形状校验不数段数，
`1:2:3:4:5:6:7:8:9:10` 被放行，与「只接受 IP 字面量」的契约名不副实）。

**审计未打穿的**：`isMinimaxTrustedHost` 以**真实入参**（`new URL().hostname`）
计 18 条攻击形态全部安全（零宽/全角/CGJ 会被 URL 规范化成真域、西里尔 o →
punycode、userinfo → `evil.com`、尾部点/表意句号/NUL → 拒）；
UI↔RPC 契约正确（`unwrapRpcResult` 对 `ok:false` 是**抛** `Error(message)`，
故 `catch` 能接住）；持久化覆盖完整（接口/schema/两处 load/save/queueStoreSave/
getter/setter 全在）。


### ⚠️⚠️ 传输级重试：`fetch failed` 的真实缺陷（2026-10-15，已修）

**用户报障**：「模型连接测试失败，显示 `fetch failed`」「积分查询及领取失败」。

**本机取证**（同一凭据、同一端点、连打 10 次）：
```
签到 (signin/status): 成功 5/10 —— 失败全是
  fetch failed ← self-signed certificate in certificate chain [SELF_SIGNED_CERT_IN_CHAIN]
目录 (models)       : 成功 10/10
```

⇒ 环境里的 **HTTPS 检查代理**（企业 / 杀软 / **Clash 的 MITM 证书**）约 **50%**
概率打断到本家的请求。**这是环境问题，但症状落在插件上**：一次偶发中断 = 整轮请求
失败，用户看到 `fetch failed`。

**修法**：`src/minimax.ts` 新增 `minimaxFetchWithRetry` + `isMinimaxTransportError`，
**三处共用同一份**（不各写一份 —— 同义判据分两处必然漂移）：
- 推理（`src/minimax-adapter.ts` 的 `send()`）
- 目录（`src/minimax-auth.ts` 的 `fetchRawModels`）
- 签到 / 积分（`src/minimax-credits.ts` 的 `requestEnvelope`）

**效果实测**：裸 `fetch` **5/10** → 走本函数（插件真实代码路径）**10/10**。

**四条边界**（`tests/unit/minimax-transport-retry.spec.ts` 逐条锁住，且都做过变异验证）：
1. **只重试传输错误，绝不重试 HTTP 状态错误** —— 4xx/5xx 是服务端的**明确答复**
   （401 要续期、402 要充值、429 要冷却），重发只会原样失败且掩盖真因；
2. **abort 绝不重试** —— 用户点了停止还继续发是**不可接受**的行为；
3. **真因在 `cause` 里** —— undici 把底层错误包成一句 `TypeError: fetch failed`，
   判据必须**沿 `cause` 链**找（本仓库 `providers-opencode.md` 记过这一点）；
   只读 `message` 会漏掉 `SELF_SIGNED_CERT_IN_CHAIN` / `UND_ERR_*` / `ECONNRESET`
   （变异验证：改成只读 message ⇒ **4 条用例变红**）；
4. **重试耗尽时抛最后一次的原错误对象** —— 保住 `cause` 链，真因仍可见
   （换成自定义文案会让用户再也看不到「自签证书」这类唯一出路）。

⚠️ 另一条**环境侧**线索（本次未改动，留作排查指引）：用户环境是 **Clash TUN +
fake-IP**（`agent.minimax.io` 被判给 `198.18.0.14`），而 `fetch failed` 的真因正是
Clash 的 MITM 证书。**若重试仍不够**，可把该域名加进 Clash 的 `fake-ip-filter`
或关掉 TUN —— 但插件侧不应依赖它（重试才是正解）。

### ✅ 2026-10-15 真机验证：上面 1、2 两项**已确认同形，全部可用**

用真实国际站账号（经本插件登录）逐端点实测，并与官方开源实现
`MiniMax-AI/minimax-code`（v0.6.11 打包产物 + 源码）逐字对拍：

| 端点 | 实测结果 |
|---|---|
| `POST /mavis/api/v1/llm/v1/messages` | ✅ 200 + 真实 SSE（**`Bearer` 即可**，与国内站一致） |
| `GET /minimax-cloud/api/v1/signin/status` | ✅ 200（真实签到面板） |
| `GET /minimax-cloud/api/v1/credit/details` | ✅ 200（真实余额） |
| `GET /mavis/api/v1/models?region=en&buildEnv=prod` | ✅ 200（4 个模型） |

**主机与常量也全部核对正确**（官方源码逐字确认）：`account.minimax.io`
（`oauth-core/src/endpoint-config.ts` 的 `ACCOUNT_ORIGINS.en.prod`；且官方
`mcode login --region global` 打开的**就是**该主机）、推理基址
`agent.minimax.io/mavis/api/v1/llm/v1`（`config/src/config.ts` 的
`PRESET_BASE_URLS['en-prod']`）、OAuth 三常量（`contracts.ts` 的
`mcode-public` / `agent.default` / `agent-backend`）。

⇒ **两站协议同形**，「两站只差 6 个字段、共用全部实现」成立。

### ⚠️⚠️ 一段**已被证伪**的中间结论（2026-10-15，留作教训，勿再采信）

同一天中途，我曾据一次**上游故障窗口**内的探测写下如下结论并写进代码/文档：

> ❌ 「国际站要求**阿里云 ALB 网关签名**；`/minimax-cloud/*` 回
> `400 {"error":"invalid signature"}`、推理 `Bearer` 回 `401 token is required`；
> 已穷举认证位置与主机均不通；推理与签到/积分**当前不可用**。」

**该结论是错的。** 故障恢复后同样的请求全部 200。当时的三个错因：

1. **把瞬时故障当成设计**：`invalid signature` / `token is required` 是上游网关在
   故障期返回的**通用错误**，恢复后即消失 —— 我当时还拿
   「不存在路径回 404、真实路径回 400」去论证「端点存在、只是要签名」，
   那个推理本身成立，但**它无法区分「要签名」与「网关故障」**；
2. **对照组选错**：我用「国内站通、国际站不通」推断「两站协议不同形」，却**没有
   先让官方客户端复现**。后来跑 `mcode` 才发现**官方自己也连不上**（截图
   `Code: 50112` = 官方枚举 `LLM_AUTH_ERROR`）—— 那才是决定性证据；
   官方 mcode 探针抓到的推理请求头**也只有 `Authorization: Bearer`**
   （另有 `x-api-key: sk-xxx` 占位与 `x-mavis-*`，缺之亦通），与我实现逐字相同；
3. **烧掉了用户凭据**：为判断凭据归属，我对两个真实账号调了 `refresh_token`
   却**没有写回**，服务端轮换后旧 token 作废，用户被迫重登。
   ⇒ **诊断脚本绝不该对真实凭据发起 refresh，无论是否写回。**

**可推广的教训**：区分「客户端 bug」与「服务端故障」时，**第一步就让官方/参考
实现复现** —— 成本最低、结论最硬；不要拿一个失败面的组合去反推协议差异。

**⚠️ 另有一条仍然成立的判据**：国际站的**目录端点当前是公开的**（无 token、垃圾
token 都返回 200，与国内站不同）⇒ **「模型目录能读到」不构成凭据有效的证据**。
凭据证据看推理 / 签到 / 积分三处。

核验入口：`pnpm test:e2e:minimaxintl`（只读，实测 4/4 通过）/
`pnpm test:e2e:minimaxintl-claim`（真实领取）。探针**刻意不硬断言**「恰好 4 个
模型」—— 国际站远端模型集与国内站不同（实测 4 条），硬断言会在上游调整时假红；
探针只断言「请求发出去了、拿到了可解读的响应」，实际内容打印给人核对。

### 1. ⚠️ `pending` 是 **HTTP 200**，不是 OAuth 标准的 400

设备码轮询里，服务端用 **HTTP 200 + `status: "pending"`** 表达「用户还没完成授权」；
而标准 OAuth 是「非 200 + `error=authorization_pending`」。**两种形态都要认**。

⚠️ **只看 HTTP 状态码会把「还在等你点授权」误判成「拿到 token 了」** ——
实测表现为 `令牌响应缺少 access_token`。这与 Qoder「404 表示尚未授权、
必须继续轮询」是同类坑（**别把非标准形态当错误**）。

### 2. ⚠️ 模型目录**必须走远端**，不能照抄客户端内置表

客户端 `config.js` 的内置表**只有 3 个**（`MiniMax-M3` /
`MiniMax-M2.7-highspeed` / `MiniMax-M2.7`），而远端
`GET /mavis/api/v1/models?region=cn&buildEnv=prod` 有 **4 个** ——
**照抄内置表会漏掉 `MiniMax-M3.1-Flash-Preview`**，而它正是客户端界面上
被选中的那个（用户截图证据）。

**判据**：目录走远端；远端失败时才回退兜底表（`minimaxFallbackEntries`）。

### 3. ⚠️ 只有 `MiniMax-M3.1-Flash-Preview` 有思考档位

其余三个远端条目**没有 `effort_options` 字段** —— 这是**远端事实，不是我们漏解析**。
故 `resolveModel` 对它们**不声明 `reasoning`**（`minimaxReasoningInfo` 返回
`undefined`）。与 Qoder 的 `qmodel`「只有关闭思考」是同一类事实：
**远端没给就是没有，不要补猜测的默认值。**

⚠️ 档位展示名直接用**远端原文**（`name === id`），不做本地化。
⚠️ 窗口口径是**档位表最大档**（M3.1 / M3 → 1M；M2.7 系 → 200K），
**不是**目录里的 `max_input_tokens`（Qoder 那条已证伪的口径，别再犯）。

### 4. ⚠️ `timezone_id` 是 **query 参数**，且放错位置**也是 HTTP 200**

签到端点：
```
GET  /minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
POST /minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>   # body {}
```
⚠️ 放到**请求头**会回 `1406010011 invalid timezone_id` —— 而且**那也是 HTTP 200**。
故「HTTP 200 = 成功」在这里**不成立**，必须查业务码
（`base_resp.status_code`，**不是** `code`）。

### 5. ⚠️ `points` 是**总数**，`bonus_points` **含在其中**，**不得相加**

实测第 1 天 `points: 800` / `bonus_points: 400`：客户端按钮显示「签到得 **800**」、
右上角另有「额外 400」角标 —— 即 `bonus_points` 是 `points` 的**子集**，
不是额外加量。

⇒ `dailyCredit === points`（**800**），**不是** `points + bonus_points`（1200）。
相加会让展示金额**虚高一倍**（用户 2026-09-28 亲自纠正）。

### 6. ⚠️ 幂等判据是 `claim_result`，**不是 HTTP 状态码**

`claim_result`：`1` = 真领取、`2` = 已领过。**重复领取同样返回 200**。
故 `claim_result` 缺失 / `null` / 越界 / 字符串时一律判 `failed`，
**绝不虚报成功**（虚报会让用户以为 +了积分，实际 +0 ——
与 TRAE「显示成功但 +0」是同一类报障）。

⚠️ 另：**今日已领的判据是 `is_today && status === 3`**，**不是**「没有 Claimable」
—— 后者会把「服务端没下发数据」误报成「今天已领」（Qoder 踩过同款）。

### 7. ⚠️ 积分余额端点是**平铺响应**，且 `details` 会整个缺失

`GET /minimax-cloud/api/v1/credit/details` 的 `total_count` 与 `base_resp` **同级、
没有 `data` 键** —— 与签到端点的信封结构**不同**。实现用 `unwrapEnvelopeData`
兼容两种形状（否则会撞上「缺 `data` 即判失败」的守卫，把**「余额为 0」
报成「查询失败」**）。

⚠️ **空明细时 `details` 字段整个缺失**；解析必须容忍。本机实测
`total_count: 0` 且无 `details` —— 那是**有效结果**（「真的为 0」），
与「查询失败」（`null`）是两回事，**不要合并**。

### 7.1 ⚠️⚠️ 余额取 `details[].remaining_amount`，**`total_count` 是记录条数**（2026-09-29 修复的真实缺陷）

初版写成 `total = total_count` —— **错的**。`total_count` 是 `details[]` 的
**记录条数**，真实余额是各包 `remaining_amount` 之和。

实测原始响应（本机领取 800 积分后，2026-09-29）：
```json
{"details":[{"remaining_amount":"800.00","consumed_amount":"0.00",
             "granted_amount":"800.00","credit_type":2,
             "granted_at_ms":1790645562328,"expire_at_ms":1793203200000}],
 "total_count":1,"base_resp":{"status_code":0,"status_msg":"ok"}}
```
余额是 **800**，`total_count` 是 **1** —— 用户界面会显示「1 积分」。

⚠️⚠️ **为什么初版与单测都没发现（这个坑的形态值得记住）**：
账号余额为 0 时 `details` **整个缺失**、`total_count` 恰好也是 **0**
—— 「条数 0」与「余额 0」在数值上**偶然重合**。于是
「`total_count: 0` → `total: 0`」那条单测是**同义反复**，
它**只能证明「0 还是 0」**，无法区分两个语义。
⇒ **领取积分后才分叉**（条数 1 / 余额 800），缺陷才暴露。

**教训具有普遍性**：当「错误的字段」与「正确的字段」在**已知样本上取值相同**时，
任何断言都是同义反复。⇒ **必须构造让两者分叉的样本**
（本例：一条 800 的记录 ⇒ 期望 800 而非 1）。这正是 Task 8「反向验证」要解决的
问题，但反向验证**只能证明既有用例有判别力**，证明不了「用例覆盖了正确的语义」
—— 后者需要**让错误实现产生不同数值**的样本。

⚠️ **`remaining_amount` 是字符串**（`"800.00"`），而 `finiteNumber` 只认 number
⇒ 必须用宽容解析（数字与字符串都接受，见 `looseAmount`）。
⚠️ `Number('')` **是 0** ⇒ 空串必须**先挡掉**，否则「缺字段」会被误读成
「0 积分」（与「不编造 0」的既有铁律冲突）。
⚠️ `expiredTotal` 仍为 0、`packages` 留空：`details[]` 没有区分「本周期有效」的
标志（`credit_type` 语义**未实测**），**不凭猜测分类**。

### 8. 推理：**Anthropic Messages** 协议（已实测启用，2026-09-29）

`POST {apiHost}/mavis/api/v1/llm/v1/messages`（`stream: true`）。
实现分两块：`src/minimax-messages.ts`（请求体构造 + SSE 消费）与
`src/minimax-adapter.ts` 的 `stream()`。

⚠️ **不要复用 `openai-compat.ts`**：那是 OpenAI 形状，硬套会把
`tools` / `tool_calls` / `input_json_delta` 全部翻译错。
⚠️ 也**不做**「通用 Anthropic 层」抽象 —— 只有一个消费者，
抽象是凭空多一层间接（Qoder 的教训是「同族第二个产品出现时再抽」）。

#### 8.1 ⚠️⚠️ 思考档位：**两种能力**，M3.1 与 M3 完全不同

远端 `thinking_config.mode` 有三种值（**不是**只看 `effort_options`）：

| 模型 | mode | effort_options | 实测行为 | 我方声明 |
|---|---|---|---|---|
| M3.1-Flash-Preview | `forced_on` | ✅ `default/low/medium/high/xhigh/max` | 传 disabled ⇒ **硬 400** | 6 档（默认 `default`） |
| **M3** | **`switchable`** | ❌ 无 | **不发 ⇒ 不思考**；adaptive ⇒ 2785+ 字符 | `none` + `on`（强度序） |
| M2.7 / M2.7-highspeed | `forced_on` | ❌ 无 | 传 disabled ⇒ **静默忽略** | 不声明 |

**M3.1 必须 adaptive**（服务端原话，实测 HTTP 400）：
```
{"type":"error","error":{"type":"invalid_request_error",
 "message":"invalid params, model \"MiniMax-M3.1-Flash-Preview\" requires
  adaptive thinking; thinking.type=\"disabled\" (including
  reasoning.effort=none) is not allowed (2013)"}}
```

⚠️⚠️ **M3 必须给「开启」档，不能只给「关闭」**（真实功能缺口，2026-09-29 修复）：
实测 M3 **不发 `thinking` 时默认「不思考」**（两轮各 0 字符），
而 `adaptive` 有 **2785 / 2797** 字符。初版只看了 `effort_options`（M3 没有）
⇒ 声明成「无推理等级」⇒ 用户**既不能开也不能关**；
我第二版只加 `none` ⇒ **只能关、无法开**（把模型强项藏起来了）。

⇒ 取客户端**权威词汇**（`thinking.js` 的 `isMiniMaxM3ThinkingMode`：
`value === 'on' || value === 'off'`）声明 **`['none','on']`**（**强度序**，Issue IKLIDV；
`on`→`adaptive`、`none`→`disabled`；`off` 在 DSH 侧的惯用名是 `none`）。
⚠️ 原写法是 `['on','none']`（把默认档排首位）—— 那在**横向档位轴**上会变成
「左强右弱」（「开启」贴最左）。规整理由见下方「展示名」那段。

⚠️ **不设 `defaultEffort`**（M3 无 `default_effort`）⇒ 保持服务端默认（=不思考），
**不擅自**设成 `on`（那会改变用户既有行为）。

⚠️ **`forced_on` 的模型绝不追加开关**：M3.1 会硬 400、M2.7 被静默忽略
—— 「给了选项却空转」比「不给」更糟（用户以为关掉了、实际没关）。

⚠️ **展示名**：远端档位用原文（官方 IDE 就是 `default`/`low`/…），
但 `on`/`none` 是**我们追加**的，给中文「开启思考」/「关闭思考」。
⚠️ **追加顺序是 `none` 在前、`on` 在后**（强度序，Issue IKLIDV）：DSH 把
`reasoning.efforts` 当**展示顺序**且客户端**不排序**，原先的 `['on','none']`
会让「开启」落在横向档位轴的最左（左强右弱）。⚠️ 远端 `effort_options` 那段
**保持原序**（如实镜像上游），故两段拼接后的数组**不一定全局单调** ——
只有「我们自己追加的那一对」按强度序排。

⚠️ **档位真的生效**（实测同一难题）：M3.1 `low`=572 / `medium`=1181 /
`max`=1297 字符 ⇒ **不是空转**。故断言必须比较**不同档位的思考量**，
不能只断言「HTTP 200」。

⚠️ **测档位要用需要推理的问题**：问「只回复两个字：收到」时
adaptive 与 none **都是 0 思考字符**（模型根本不思考）⇒ 断言退化成同义反复
（我第一版探针就这么假红过）。

⚠️ **`readImage` / contextWindow 与用户 IDE 截图的对应**：
IDE 的「上下文窗口 512K / 1M」是 **IDE 自己的**多档选择；
DSH 的 `LlmModelContext` **只有单一 `contextWindow` 字段**，本身不支持多档
⇒ 按用户 2026-09-29 的指示「不用档位直接用最大的」取 **1M**。
⚠️ 用户「看不到档位」的**真实原因**是**插件未登录**（凭据里无 `MINIMAX_*`
⇒ `providerCatalogVisible` 为假 ⇒ `listModels` 返回空 ⇒ DSH 隐藏整个 provider），
**不是档位没实现**。排障时先查登录态。

#### 8.2 ⚠️ 图片：**必须** Anthropic 形状（真机实测）

```json
{ "type":"image", "source":{"type":"base64","media_type":"image/png","data":"<裸base64>"} }
```
- ⚠️ OpenAI 的 `image_url` 被服务端**明确拒绝**：
  `400 ... messages.0.content.0: unsupported content type 'image_url' (2013)`
- ⚠️ `data` 是**裸 base64**（无 `data:` 前缀）
- ⚠️ 实测：**1×1 的 PNG 会被拒**（`400 invalid params`，**无细节**）；
  40×40 起正常。真实截图远大于此，不影响使用 ——
  但**排障时别用 1×1 图**（会得到一个毫无线索的 400）
- ⚠️ 可与 `thinking:{type:'adaptive'}` 共存、`text` 在 `image` 前后均可
- 实测：M3.1 / M3 都能识图（自造纯红 PNG ⇒ 答「红色」）

⚠️ **判据是「模型真的看到了图」，不是「HTTP 200」**（后者在静默丢图时也通过）。
⚠️ **但不要断言精确颜色**：实测同一张纯色图 M3.1 答过「灰色和暗红色」、
M3 答过「绿色」/「红色」—— 那是**模型自身识图质量**，与序列化无关；
硬匹配会让探针随机假红。断言应取「**不是**拒答」+「含颜色词」。
⚠️ **消息体的图读不到 ⇒ 抛错**（用户显式意图）；**工具结果里的图读不到 ⇒ 跳过**
（工具结果本身仍有价值）—— 有意区别对待。
⚠️ 声明不支持图片的模型收到图片 ⇒ **报错**，不能发出去让服务端 400。

#### 8.3 SSE 帧形状与三个必须保留的细节

`message_start` → `ping` → `content_block_start` → `content_block_delta` →
`content_block_stop` → `message_delta` → `message_stop`。

- ⚠️ **`signature_delta` 必须忽略**（thinking 块的签名）。当正文处理会往回答里
  注入一串十六进制。
- ⚠️ **`thinking` 块映射成 `reasoning` 块**，否则思考内容污染正文。
- ⚠️ **`thinking_tokens` 是 `output_tokens` 的「子集」**（实测两者都可能是 64），
  映射到 `reasoningTokens`，**不累加**到 outputTokens。
- ⚠️ **错误走 `event: error`**（`{type:'error', error:{type,message}}`），
  不是 OpenAI 的 `{error:{message}}` —— **必须抛错**，否则重演 Qoder
  「干净地停止、无任何报错」。

#### 8.3 ⚠️ 工具调用是 Anthropic 形状，**没有 `role:'tool'`**

- assistant 的 `tool-call` → `tool_use`（**`input` 是对象**，不是 JSON 字符串）；
- 工具结果 → **user 消息**里的 `tool_result` 块（`tool_use_id`）。
- ⚠️ 参数是残缺 JSON 时退化 `{}`，但**块必须保留** —— 丢了会让后续
  `tool_result` 变孤儿块、服务端 400。
- ⚠️ 历史里的 `reasoning` 块**不回传**：Anthropic 要求 thinking 带签名，
  我们不持久化签名 ⇒ 回传会被拒。丢弃思考历史是安全的。
- ⚠️ **判据是「结构化 `tool-call` 块」**，不是「模型在正文里说它想调工具」
  —— 后者正是 Qoder/TRAE 踩过的缺陷形态（插件没发 `tools`，
  模型只能用正文 XML 臆造，harness 认不出 → 任务终止）。

#### 8.4 ⚠️ 402 必须归 `QUOTA_EXCEEDED`，不能归 `SERVER`/`AUTH`

余额不足是最常见的真实失败，归错会让用户看不到「去充值」这个**唯一有效动作**。

#### 8.5 ⚠️ 未实现：图片（**显式抛错**，不静默丢弃）

`M3.1` / `M3` 目录条目声明 `supportsImage`（用于 `inputModalities` 播报），
但**带图请求未实测**，故序列化遇到 image 块**显式抛错**。
静默丢弃会让用户以为图片被模型看到了。

#### 8.6 ⚠️ 单测抓到的真实缺陷：截断流丢失最后一帧

原 `consumeMinimaxSse` 只在 `while (!done)` 里按行处理，`split('\n')` 后
`pop()` 的尾巴留在 `buffer` 等下一轮 —— 但**流结束时没有下一轮**，
于是最后一条事件（正是携带 `stop_reason` 与 `usage` 的 `message_delta`）
**永远被丢弃**。

真实 SSE 大多以空行结尾，恰好掩盖了它；**截断的流**才暴露，且症状极隐蔽：
`max_tokens` 被误报成 `stop`、`usage` 永远是 0 —— **不报错、不中断，只是数字错**。

⇒ 修法：把行处理抽成嵌套生成器 `processLine`，收尾时先 `decoder.decode()`
刷出残留多字节，再把 `buffer` 余量**按整行**走一遍同一套逻辑。
⚠️ 同时**空行要重置 `eventName`**（它是 SSE 的事件终止符；提到循环外后
不重置会让上一条事件的 `event:` 名残留到下一条 `data:` 上）。
回归用例 4 条，反向验证过（去掉收尾冲刷 ⇒ 4 条变红）。

#### 8.7 ⚠️ 请求级账号轮换 + 冷却（issue IKJW32，2026-10-11 接上）

修复前：本适配器**全文件零命中** `updateModelRateLimit` / `getAvailableAccount`
—— 14 家里**唯一**没有换号 / 冷却的一家；首号额度耗尽就把硬失败抛给用户，
而池的取值顺序不因失败而变 ⇒ 下次请求仍是同一个号（「卡死在一个号上」）。

⚠️ 取证口径（**别把它说成「本机复现」**）：issue 报障环境是「池里 **4 个账号
3 个余额为 0**」；本次复核的那台机器只有 **1 个 minimax 账号且余额充足**
（`credit/details` 13 条记录），故本条是靠**代码取证 + 单测**成立的，
不是靠本机复现的。

**类别→动作表**（照 `loomy-adapter.ts` / `raccoon-adapter.ts` 逐格搬）：

| 类别 | 判据 | 换号 | 写冷却 |
|---|---|---|---|
| `quota` | 402 / `insufficient_balance_error` / 额度文案 | ✅ | ✅ 24h |
| `rate` | 429 / `rate_limit_error` / `overloaded_error` | ✅ | ✅ 1h |
| `auth` | 401 / 403 / `authentication_error` | ✅ | ❌ **绝不写** |
| `other` | 其余 4xx（400 参数错） | ❌ | ❌ |

⚠️ `auth` 只换号、绝不写标记，是 2026-10-06「全池被封 24h」事故换来的不变式
（见 `loomy-adapter.ts` 的 `LoomyFailureClass` 记录），本家照搬。
⚠️ `quota` 的 24h 是**保守兜底**（本家没有可靠的额度重置字段）：用户真去充值后
不必等满 24h —— 账号卡片上的「重置」按钮会清掉该标记（这也是它**必须**进
`probeById` 的另一个理由，见本节末尾）。

**真机实测的错误报文形状**（2026-10-11，`POST /mavis/api/v1/llm/v1/messages`
＋本机凭据；三发都不产生推理、不消耗额度）：

| 构造 | HTTP | 体 |
|---|---|---|
| 坏 token | 401 | `{"code":401,"message":"auth failed"}` —— **自家信封，不是 Anthropic 形状** |
| `MiniMax-M3.1-Flash-Preview` + `thinking:{type:'disabled'}` | 400 | `{"type":"error","error":{"type":"invalid_request_error","message":"… (2013)"},"request_id":…}` |
| 不存在的模型名 | **200** | `message_start` 里 model **静默回退**成 `MiniMax-M3`（既有事实，别当错误） |

⚠️ **402 + `insufficient_balance_error` 是额度形态，但本次没有真机复现**
（本机那个账号余额充足：`credit/details` 有 13 条记录）。该形状来自既有单测与
§8.4 的记录，实现按它判 ⇒ **别把「判据有测试」误读成「真机见过」**。

⚠️⚠️ **`consumeMinimaxSse` 的错误帧必须带 `error.type`**（本次一并加）：
MiniMax 系有「HTTP 200 + 业务码」的既有习惯（签到、`timezone_id` 放错位置都是
200），故流内 `event: error` 帧也要能换号；而服务端的 `message` 完全可能是
`balance not enough` 这类**不含任何钱义词**的句子 —— 那时只有 `error.type`
能把它判成 `quota`，只带 message 会让轮换静默失效。回归用例刻意让 message
不含 `insufficient`（去掉 type 拼接即变红）。

**三处共享语义（缺一会复发）**：

1. `tried` 必须透传给 `getAvailableAccount`（不排除会拿回同一个号，换号形同虚设）；
2. **每次**失败后**立刻**记账（挪到循环开头会让末号漏记 —— loomy 实测 8 号只记 7 个）；
3. 401 续期后**必须重新反查账号 id**：本家的 `refresh`（`src/index.ts`）续的是
   **池内第一个可用账号**，续期后取回的凭据可能属于**另一个号**（同 loomy / raccoon
   的 `51ded6a` 缺陷）⇒ 不反查就把 24h 冷却记在「只是 401」的无辜账号上。

⚠️ **换号只发生在「尚未产出任何 chunk」时**：流内错误若已 yield 过内容，一律
原样抛出（重发会让用户看到重复内容）。`drain()` 的 `yieldedAny` 守卫锁这一条。

**⚠️ 连锁（第 7 次同型）：写标记 ⇒ 必须进 `probeById`**

minimax 此前**不必**登记在 `src/index.ts` 的 `probeById`（不写标记 ⇒ 没有可清的
标记）；接上换号后它会写标记 ⇒ 不登记就「标记写进去却永远清不掉」（用户点「重测」
报「没有探测适配器」）。`tests/unit/provider-runtime-wiring.spec.ts` 的
「登记为『不写标记』的 adapter 确实没有写点」**当场点名变红**，本次正是靠它发现的。
⇒ 判据是「**现在**写不写标记」，别照抄「minimax 不写标记」这条旧结论
（它已随本 issue 失效，同 `opencode` 的第 6 次形态）。

**反向验证**（9 条独立变异，各自锁死一处，逐条实测）：
`recordsMinimaxRateLimit` 恒 true ⇒ 3 红；删轮换内的记账 ⇒ 2 红；
删 401 后的账号反查 ⇒ 1 红；删 401/403 判据 ⇒ 4 红；删 `yieldedAny` 守卫 ⇒ 1 红；
删 `error.type` 拼接 ⇒ 1 红；quota/rate 冷却时长对调 ⇒ 1 红；不传 `tried` ⇒ 6 红；
`probeById.minimax` 的 `product` 接错（`MINIMAX` → `RACCOON`）⇒
`account-probe-adapter.spec.ts` 的 minimax 用例 1 红。

⚠️ **订正上一条里的第 4 项**：那次「4 红」是**同时删掉状态码腿与 `auth failed`
文案腿**的结果；只删状态码腿时，adapter 级的 401 用例仍由文案腿判 `auth`
⇒ 按 it 粒度只有分类器那条变红。该判据现在是**两条腿**，别把哪一条当成冗余删掉。

#### 8.7.1 同日三路审计（语义一致性 / 对抗性红队 / 接线连锁）后的修订

三个只读 subagent 的结论合并后有 **3 个真实代码缺陷 + 1 个掩盖型覆盖缺口**，
逐条修完并补了守卫（全部只读审计，未注入变异）：

| 缺陷 | 形态 | 修法 |
|---|---|---|
| **200 + 流内错误的分类保真度不足** | 本家**混用两种信封**：Anthropic 形状 `{"type":"error","error":{…}}` 与**自家信封** `{"code":401,"message":"auth failed"}`（401 实测就是这个）。只认 `frame.error.message` 时自家信封退化成「未知错误」⇒ 额度信息整段丢失 ⇒ 判 `other` ⇒ **不换号**（issue 在 200 路径上原样残留） | `consumeMinimaxSse` 的 error 分支回退读顶层 `message` / `code`；`!sawAnyChunk` 时带**响应原文样本**；适配器加**自家信封码通道**（`code=401/402/403/429`） |
| **200 + 非 SSE 体** | 网关 HTML / 裸 JSON 信封（`application/json`）一个 SSE 帧都没有 ⇒ 只得到「模型未返回任何内容块」 | 适配器加 `isDefinitelyNotSse`（**只认** `application/json` / `text/html`，其余仍按 SSE —— `new Response(string)` 的默认类型是 `text/plain`，当错误体会让**正常回答整轮失败**） |
| **坏凭据掐断整池** | 池凭据是裸 `JSON.parse`（不校验形状），`{}` 这类损坏条目会撞 `nextCredential.access_token.length` ⇒ `TypeError`（非 `LlmError`）+ `break` ⇒ **一个坏号废掉整轮**（loomy/raccoon 无此断点，是本家新引入的） | 判空后 `continue` |
| **`insufficient` × `token` 误封** | `max_tokens` / `input_tokens` / `budget_tokens` 是 Anthropic 的**一等字段名** ⇒ `insufficient max_tokens for the requested thinking budget`（400 参数错）被判 `quota` ⇒ 每个轮换到的号各写 **24h** | 钱义词 `token` 改**词边界**匹配；另：裸 `rate limit` 不再判 rate；**5xx 只信确定性通道**（自报类别 / 自家信封码） |

同时补齐的守卫（都是「此前零覆盖」的格）：`rate` 档 **429 → 1h** 的行为用例
（此前只跑过 402，把 rate 常量换成 quota 的不会有任何用例变红）、
`probeById.minimax` 的**真实工厂**用例（凭据接通 + 不持有 `accountPool`，
`vi.mock` 的桩适配器读不出这两样 ⇒ 原来删掉 `resolveCredential` 也全绿）、
「已产出内容后失败**仍要记账**」（否则该号永不被冷却）、
「401 报文不含 auth 文案仍判 auth」（锁状态码腿）、
「仅 `content_block_start` 后报错不重发」（锁 `yieldedAny` 的宽度）。

⚠️ **三处行为变更登记**（供后续对照，都是审计发现的「非轮换路径也变了」）：

1. **401/403 先续期一次再重发**（新增，对齐 loomy/raccoon）⇒ 探测路径同样会
   多打一发请求（`refresh` 在 `probeById` 里是 no-op，第二次仍是 401 后走原路径）；
   若续期后取不到凭据，错误文案变成 `credential expired and refresh failed`。
2. **生产里 `accountPool` 恒传** ⇒ 单凭据 / 单号池的 402 / 429 / 401 文案从
   `HTTP <code> — …` 变成「所有账号均不可用（…）」（错误码不变）；
   单号池余额耗尽会**写 24h 冷却** ⇒ 充值后要点「重置 / 重测」才立刻恢复
   （这正是必须进 `probeById` 的另一个理由）。
3. **`error.type` 进入错误文案** ⇒ `account-probe.ts` 的 `isRateLimited` 会命中
   `rate_limit_error`，探测文案从「无法确认」变「仍受限」（**标记保留行为不变**）。

**同一日第二轮的对抗性发现（机制层面，未真机复现，如实标注）**：
`MINIMAX_QUOTA_ERROR_TYPES` 等三张 type 表里，除 `insufficient_balance_error` /
`rate_limit_error` / `invalid_request_error` 之外**没有真机取证**；
402 的形态仍来自既有单测（本次未复现，本机账号余额充足）。

**变异验证（第二轮，26 + 7 条注入实测）**：26 条里 **19 条与期望一致**
（`#11` 不传 `tried` 实测 10 红，比预期更多）；**7 条暴露守卫缺失**，已逐条补齐并复验：

| 缺口（改坏了也没人红） | 补的守卫 | 复验：变异 ⇒ 实测红 |
|---|---|---|
| `consumeMinimaxSse` 的 `kind`（`error.type`）生产端无人管（消费端那些断言喂的是**测试自己拼的字符串**） | messages 断言文案含 `insufficient_balance_error`；适配器的 200 流内帧用例改用**不含任何额度措辞**的 message | `kind` 置空 ⇒ **2 红** |
| 同上 `code`（自家信封码） | messages 断言文案含 `code=402`；新增「SSE 自家信封**只有码**也换号」 | `code` 置空 ⇒ **2 红** |
| `auth failed` 是**纯文案腿**、此前零覆盖 | 判据用例补 `{"error":{"message":"auth failed"}}`（status 0：无码、无 type） | 只删该腿 ⇒ **1 红** |
| 用例「401 不含 auth 文案仍判 auth」**名不副实**（fixture 是 `{"code":401}`，被**码腿**兜住） | fixture 改成 `{}`（无文案、无码） | 删状态码腿 ⇒ **2 红** |
| `isDefinitelyNotSse` 的**正腿**没锁（换号结果碰巧相同，但错误形状/错误码变了） | 新增「200 + json 且不可换号 ⇒ 错误含『非 SSE 响应』」 | 该函数恒 `false` ⇒ **1 红** |
| `reader.cancel()` 零守卫 | messages 用 stub reader 断言 `cancel` 被调用 | 删该行 ⇒ **1 红** |
| `rawSample`（响应原文）零守卫 | messages 断言「未返回任何内容块」带响应原文 | 置空 ⇒ **1 红** |

⚠️ 两条普遍教训（写下来比记住强）：
1. **「注释里写了理由」≠「有守卫」** —— `cancel()` 与响应原文样本两条都写了详尽的
   理由与后果，实测都是**零覆盖**；`{"code":401}` 那条用例甚至**自称**锁住状态码腿，
   实际被码腿兜住（`{}` 才是真正的判据）。
2. **加一条「并联通道」会让既有用例失去判别力** —— 补上英文短语通道后，
   原来靠 `error.type` 判额度的用例不再红（message 里的 `balance not enough`
   自己就能判）；⇒ 用例的 message 必须**只留一条通道**才锁得住该通道。

### 9. 能力矩阵与 e2e

```js
minimax: { balance: true, dailyCheckin: true }
```
余额与每日签到**都有**（与 raccoon 只有 `onboardingTasks` 不同）。

```
pnpm test:e2e:minimax        # 只读：目录/签到状态/余额；**绝不领取**
pnpm test:e2e:minimax-claim  # ⚠️ **真实领取**当日积分（消耗当天唯一一次机会）
pnpm test:e2e:minimax-chat   # ⚠️ 发推理（真实适配器；默认 M2.7，会消耗额度）
```

⚠️ `minimax-chat` 的断言是「**取到非空文本 + finish 正确**」与
「工具调用返回**结构化** `tool-call` 块」—— 不是「请求返回 200」。
后者在「模型什么都没说」时也会通过（那正是要防的形态）。
⚠️ 默认只测 **M2.7**（用户 2026-09-29 指定：每天有免费额度）；
`DSH_MINIMAX_CHAT_E2E_ALL=1` 才测全部四个模型。

⚠️ 只读/领取探针读的是 **MiniMax Code 客户端自己的登录态**
（`~/.minimax/auth/prod/cn/mcode-public/auth.json`），**不是**本插件的凭据存储
—— 该 provider 尚未在任何机器上完成过插件登录。

⚠️ **token 过期时探针自动 skip，绝不代客户端续期**：MiniMax 的 refresh
可能轮换 `refresh_token`，若我们刷一次却不写回客户端文件，用户的客户端登录态
就会被弄坏。实测过期 token 打只读端点返回 **HTTP 401 `invalid access token`**。

### 10. ⚠️ `registerJetHubRpc` 的位置参数陷阱（**第 5 次复发**）

`registerJetHubRpc` 是长**位置**参数列表（**12 个 auth** + `modelAdapters`，
顺序：`codearts, buddy, workbuddy, lobsterai, qoder, qoderCn, trae, cline,
loomy, raccoon, minimax, zcode`）。
新增 provider 时**必须**在 `tests/unit/jet-hub-rpc.spec.ts` 的调用点补占位，
否则 `modelAdapters` 会**错位**落到最后一个 auth 形参上。

**已复发五次**：加 Loomy、加 Raccoon、加 QoderCN、加 MiniMax、**加 ZCode
（2026-09-30 合并上游时一次插了两个 provider，第 5 次）**。
测试注释里逐字预言过这个坑。

⚠️⚠️ **第 5 次的关键差别：这是「合并」引发的，`git` 全程不报冲突。**
上游把 `minimax` / `zcode` 插在 `raccoon` 之后，`jet-hub-rpc.spec.ts` 的
`provider.status` 那处调用点没跟上 → `modelAdapters` 落到 `minimax` 形参上、
真正的位置收到 `undefined` → 实现退化成套黑名单的 `ctx.llm.listModels()`。
症状与第 4 次**同型但报错位置不同**：三条用例断言
`{ total, disabled }` 时实际拿到 **`{ total: 0, disabled: 0 }`**
（不是渲染问题，是**目录读不到**）。
⇒ **合并任何新增 provider 的上游改动后，必须重跑 `jet-hub-rpc.spec.ts` 的
`provider.status` 组，不能以「git 没报冲突」判定合并没有语义问题。**
排查脚本可离线复查全部调用点的实参对齐（剥注释后逐个数形参，
本机实践：Windows 下别用内联 `node -e`，PowerShell 会吃掉引号/反引号，
写成 `.mjs` 文件再跑）。

⚠️ **另一个格式陷阱**：`registerJetHubRpc` 的**调用**必须保持**单行**
（`... raccoon, minimax, zcode, modelAdapters)`）。拆成多行（哪怕只加尾随逗号）
会让 `qoder-wiring.spec.ts` / `raccoon-wiring.spec.ts` 的正则失配而失败。

⚠️ **根治方向**（尚未做）：把它改成**具名参数对象**（`{ auth: {...}, modelAdapters }`）。
已复发五次说明「靠注释提醒补占位」不足以防住 —— 但那是独立重构，
需要同时改 `src/index.ts` 与全部测试调用点，不要顺手做。

## ⚠️⚠️ minimax 同账号去重的「三件套」不可只做第一件（2026-10-25 合并审计）

`!147` 补了 minimax 的同账号去重（按 `user_id` 查池、命中则**不删条目**、标停用+改名）。
方向对，但只搬了 officeace 三件套的**第 1 件**。实测两个后果：

| 缺的腿 | 后果（实测） |
|---|---|
| 新鲜凭据**转写回保留卡** + 清重复卡凭据 | 续期调度器**刻意不看 `enabled`** ⇒ 同一上游账号挂**两条续期链**。MiniMax 的 refresh_token 是轮换式的 ⇒ 两条链互相作废，症状正是「旧的那条掉登录」（本 PR 要治的形态） |
| 命中**已停用**原卡时反转 | 用户手动停用过这个号 → 同号重登 → **两张卡全停用** ⇒ `getAvailableAccount()` 返回 `null`（它按 `enabled` 过滤）而 `login.poll` 报登录成功 ⇒ **零可用号**（officeace 2026-10-17 修过同一格） |

⚠️ 还有一个**前置**缺陷：`user_id` 全仓只有 `persistLogin` 一处写入，而它只写**新**账号。
存量凭据（PR 之前登录的）**没有** `user_id`（本机三份实测零份带它），而
`findAccountIdByIdentityField` 对缺失字段是**跳过**（不是「不匹配」）⇒ 去重对存量用户
**永不触发**。唯一能补的地方是启动自愈 `repairAccountNicknames` —— 它本来就把
`identity.userId` 拿到了手，却只写了 `nickname`。

⇒ 现行实现：`src/minimax-dedup.ts`（`dedupeMinimaxAccount`，四种结局逐格可测）+
`repairAccountNicknames` 一并补写 `user_id` + `refresh()`（第 5 条续期路径，
`index.ts` 在 `getAvailableAccount()` 返回空时走它）也继承身份。
守卫：`tests/unit/minimax-dedup.spec.ts`（6 条）、`minimax-identity-inherit.spec.ts`（9 条）。

⚠️ 「收口在**唯一**出口」这类声明要按**调用点**数，不要按注释数：本 PR 声称 4 条续期路径
收口到 `refreshCredentialFor`，实际还有第 5 条 `refresh()`，且它此前直接把续期结果落盘
（`nickname`/`user_id` 双双消失，每 30 分钟一轮必然复现）。

⚠️ 两个新 spec 的 cordis 闸门曾用 `import.meta.resolve('@deepseek-ai/cordis')` ——
**Vite SSR 下恒抛**（`__vite_ssr_import_meta__.resolve is not a function`）⇒ 两条最承重的
行为用例**永久 SKIP**，而 PR 说明写着「完整安装的 checkout 里会真跑」（假的）。
探针必须与用例体用**同一种**加载方式（`await import()`）；SKIP≠PASS 仍然成立。

## ⚠️⚠️⚠️ 续期机制重构（PR155 修正版）：**终态判据 / 单飞 / 巡检生命周期**（2026-10-27 两轮审计）

> 背景：PR155 把「定时批量轮换」改成「按需 + 60s 错峰巡检」，**方向是对的**
> （`refreshAll` 改纯对账 + 抖动散列确实拆掉了「全池同秒过期」），
> 但两轮独立审计（含对抗性红队）打穿了四处，全部已修在本仓库。
> **每一条都是「线上会让用户重新登录」的形态**，改这块前必读。

### ① 终态判据**不得**用 message 正则 —— 它把健康账号标死

修前（两家**逐字同形**的两份实现）：

```ts
// ❌ autoclaw-auth.ts 与 minimax-auth.ts 各一份
if (/invalid_grant|expired|revoked/i.test(message)) throw new TerminalError(...)
// autoclaw 那份更宽：msg.includes('Invalid token') || msg.includes('expired') || msg.includes('401')
```

实测三处**误判**（都来自真实上游形态）：

| 上游报文 | 旧判据 | 后果 |
|---|---|---|
| `HTTP 503 {"error":"token expired"}` | **终态** | 网关抖动一次 = 账号需重登 |
| `HTTP 429 {"error":"rate limited, key expired soon"}` | **终态** | 限流一次 = 账号需重登 |
| `fetch failed`（`cause: certificate has expired`） | **终态** | 证书/代理抖动 = 账号需重登 |

⚠️ 第三条最隐蔽：本仓库自己记着「环境 HTTPS 检查代理约 50% 概率打断」
（见本文件「传输级重试」一节），而 `certificate has expired` 里恰含 `expired`。
⚠️ `msg.includes('401')` 更是**子串**判据 —— 任何报文里带这三个字符都命中。

而 `refreshable:false` 是**单向门**（`refreshAll` + 巡检都会跳过）⇒ 误标一次
**永不自愈**，用户看到的就是「要一个个点回来」。

⇒ 现在收口到 **`src/refresh-failure.ts`**（全仓唯一实现），三步**顺序不可颠倒**：

1. **先排传输层**（沿 `cause` 链读 `UND_ERR_*` / `CERT_*` / 文案含 `certificate`）
   ⇒ 一律非终态。`certificate has expired` 在这一步被吃掉，第 3 步看不到它。
2. **再看 HTTP 状态码**：`5xx` / `429` / `408` / `401` ⇒ 非终态。
3. **最后只认结构化 `invalid_grant`**（RFC 6749 §5.2 的唯一标准码）。
   个别上游用自有词汇的（AutoClaw 业务码信封回 `msg:"Invalid token"`）在
   **调用点显式声明**词表（`AUTOCLAW_TERMINAL_OAUTH_ERRORS`），
   而不是把宽词塞回共享模块。

⚠️ **方向性取舍**：漏判（该标死没标死）= 每 30 分钟白撞一次；
误判（不该标死标死）= **账号报废、必须重登**。两者不对称 ⇒ 一律偏向「不标死」。

### ② 单飞必须是**去重**，不是「串行化」

修前 `refreshAccountCredential`：

```ts
// ❌ 等完在飞任务后，**照样再发一份**
const existing = this.renewInFlight.get(refName)
if (existing !== undefined) await existing.catch(() => undefined)
const task = (async () => { … grant … })()
```

实测并发 5 次 ⇒ **5 份 grant、同时在飞峰值 4**，RT 序列
`['RT-0','RT-1','RT-1','RT-1','RT-1']`。而 RT 是**一次性轮换**的
⇒ 2 份起必然 `invalid_grant`，输家还会把「别人刚续成功」误读成「RT 已死」
⇒ **把好号标死**。端到端三条并发请求（主回复 + 标题 + 压缩）⇒ **全部失败**。

⇐ 现在与 `renewEntry` **同形**：命中在飞任务就 `await` 并 **直接返回**。
守卫：`tests/unit/minimax-renew-mechanism.spec.ts` 的「并发 5 次 ⇒ 只发 1 份」。

⚠️ **AutoClaw 同一格此前完全没有单飞**（全仓唯一的 in-flight 表在
`autoclaw-credits.ts`，不覆盖这条腿）⇒ 已补 `AutoclawAuth.refreshInFlight`，
并且**刻意保持 `refreshAccountCredential` 返回 `void`**（`JetHubAuthLike` 契约），
另开 `renewCredentialForRef` 返回凭据给适配器重发（两者共用同一张在飞表）。

### ③ 巡检定时器**必须**挂 `ctx.effect` 回收

修前：`setInterval` + `unref`，**全类没有 clear 路径**。
`unref` 只解决「不阻止进程退出」，**不解决「fiber 卸载后仍在跑」**。

实测：`fiber.dispose()` 后推进 130s ⇒ 巡检 tick **照跑**；而旧实例读的是
**共享的 credentials 后端**（不是快照）⇒ 它会继续对**新池**发 grant。
插件热重载 ⇒ 旧实例没死 + 新实例已起 ⇒ **两个实例并发轮换同一批一次性 RT**。

⇐ 现在：`stopRenewPatrol()`（幂等）+ `src/index.ts` 的
`ctx.effect(() => () => { minimax.stopRenewPatrol(); minimaxIntl.stopRenewPatrol() })`。
⚠️ 还有第二层：**每个账号之前**再查一次 `patrolStopped` —— 在飞的一轮可能正卡在
`await grant` 上几十秒，醒来后会继续把剩余账号全轮换一遍。

### ④ 「读凭据」而不是「读 `refreshable`」—— 单向门的另一半

`refreshAll` 与巡检**都**曾经 `if (!entry.refreshable) continue`。
而那个布尔是**每轮由凭据对账出来的镜像**，写 `false` 的唯一来源就是 ①的终态判定
⇒ 判据一误判就形成闭环：跳过它 → 永远不再判 → 永远回不来。

⚠️ 这是 `AGENTS.md` 与 `docs/adding-a-new-provider.md:132-135` 的**明文红线**
（「不看 `refreshable`」），而 PR 在巡检里**新复制了同一个门**。

⇐ 现在两处都读**凭据本体**（`isMinimaxRefreshable(credential)`），
且「凭据读不到 / 解析失败」**不**标 `refreshable:false`（那是存储问题，不是服务端拒绝）。

### ⑤ 启动自愈 `repairAccountNicknames` 写盘前必须重读（CAS）

它有**两次** `await`（读凭据 → 查身份端点 ~120ms），然后拿**那份旧凭据**展开整体
`set`。而 `index.ts` 把本函数（fire-and-forget）与巡检首轮排成了相邻两行
⇒ 启动时必然并发。实测 `set` 序列 `['NEW_RT','OLD_RT']`
⇒ **刚轮换出来的新 RT 被覆盖掉**（一次性 RT 前提下 = 账号报废）。

⚠️ 生产上**每次启动必现**：本机存量三份凭据**零份**带 `user_id` ⇒ 自愈必然写盘。

⇐ 现在写前重读，**只在最新那份上合并身份字段**，绝不动令牌材料。
守卫：`minimax-renew-mechanism.spec.ts` 的同名组。

### ⑥ CAS 丢弃前要把新 RT 压进历史栈（否则是净损失）

`renewEntryInner` 的 CAS 分支修前直接 `return`：本次 grant **已在上游完成轮换**，
而我们把这把新 RT 丢掉了（实测 `MINE_NEW_RT` 永久消失且**未压栈**）。
一次性 RT 语义下这**不是零代价** —— 它花掉一次轮换额度、什么也没留下，
还让救援链少了一把弹药。

⇐ 现在把 `next.refresh_token` 压进 `previous_refresh_tokens`（**只补 RT，
不碰 access_token / expires_at**），并与 `grantOnce` 共用
`mergePreviousRefreshTokens`（同义判据只留一份实现）。

### ⑦ 抢救链必须**层级合并**（修前在「响应丢失」下恰好失效）

修前：

```ts
// ❌ 第 1 层重试若抛终态，异常直接冒出去 ⇒ 历史代际一次都不试
catch (e) { if (终态) { …历史…; throw e } else { sleep; return grantOnce() } }
```

实测：首轮网络错 → 重试终态时 RT 序列 `['DEAD_RT','DEAD_RT']`（`OLD_RT_1` 从未被试）；
对照组「首轮即终态」是 `['DEAD_RT','OLD_RT_1']`（救回成功）。
而「响应丢失」正是本特性的**主要**设计场景 ⇒ 抢救链在最该生效处失效。

⇐ 现在单一循环：不管终态是第几次抛出的，都过一遍历史代际（历史代际本身不重试）。

### ⑧ 巡检的 margin / jitter / 间隔是「口径快照」，改它要同步改守卫

`MINIMAX_RENEW_MARGIN_MS = 5min` / `JITTER_SPAN = 10min` /
`PATROL_INTERVAL = 60s` / `ONDEMAND = 60s` / `RETRY_DELAY = 1.5s` /
`PREVIOUS_TOKENS = 3`。守卫里有一条**精确计数**断言
（「剩余 8min × 12 个 id ⇒ 只续 7 个」）钉住整张表：
`margin→0` 变 1、`margin→1h` 变 12、`jitter span→0` 变 0 ⇒ 三个方向都会红。
⚠️ 这是**有意的快照**，不是恒真式：改常量必须同步改那个数字。

### ⑨ 预判续期失败必须**降级**，不能把请求打死

`isMinimaxExpiringWithin` 是 fail-open（读不到 `expires_at` ⇒ 该续），
而 adapter 里原本是裸 `await refresh()` ⇒ 「凭据缺/非法 `expires_at`」的账号
一旦某次续期失败，**上游一次都不发**、请求直接失败（旧判据会正常放行）。
生产写入点都会写 `expires_at`，故可达面是「备份导入 / 第三方转换 / 手工编辑」。

⇐ 现在 `try/catch` + 降级为「用现有凭据继续发」，并**留 warn**
（`warn` 走 `registerMinimaxLlm` 注入的 `ctx.logger.warn`，缺省兜底 `console.warn`）。
401 之后那条「先续期再重发」路径仍然按原语义报 `AUTH`，不掩盖真终态。
