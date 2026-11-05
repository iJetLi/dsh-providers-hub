/**
 * 「渠道余额 → 最早失效时刻」的**唯一口径**。
 *
 * ## 为什么单独一个文件（而不是并进 `aggregate-core.ts` / `aggregate-adapter.ts`）
 *
 * | 候选位置 | 为什么不行 |
 * |---|---|
 * | `aggregate-adapter.ts` | `auto-adapter.ts` 的 `expiryOf` 要复用它 ⇒ 依赖方向变成 `auto-adapter → aggregate-adapter`（**层次颠倒**，聚合适配器是更上层的东西） |
 * | `aggregate-core.ts` | 该文件定位是**纯逻辑**（哨兵 / 排序 / 倍率解析，模块头明写、零 import），而本模块要发网络请求 ⇒ 把 IO 混进纯函数模块，且 `aggregate-core.spec.ts` 这个纯函数单测会**被迫加载网络模块** |
 * | ✅ 本文件 | 单一职责；两个适配器都依赖它，方向正确 |
 *
 * ## ⚠️ 六个 `*Expiry` 是**搬移**进来的，不是复制
 *
 * 它们原先私有在 `auto-adapter.ts` 里（`private async buddyExpiry` 等）。Task 7
 * 把 `expiryOf` 改成委托本模块的 {@link createExpiryProbe} 后，若原处再留一份，
 * 就成了**同一语义两套实现**——本仓库对此有明确的红线记录（AGENTS.md 首条判据：
 * `buddy-growth.ts` 因两处对同一字段给出相反判据而产生**静默失效**：不报错、
 * 不崩溃、单测能过，只是把「没做到」说成「做到了」）。
 * Task 3 已用同样手法处理过 `pickSoonestProvider` / `priceFactorFromName`。
 *
 * ⚠️ 计数是**六**不是四（2026-10-08 更正）：Task 7 搬来时是四个
 *（buddy / loomy / codeArts / zcode），2026-10-07 又补了 `lobsteraiExpiry` 与
 * `traeExpiry`（用户质疑后核实加入）—— 旧注释一直没跟着改。
 *
 * ## ⚠️ 依赖方向（2026-10-08 起 import `provider-runtime.ts`）
 *
 * 本模块**只**依赖底座，不依赖任何聚合侧模块（见上表：依赖聚合适配器就是
 * **层次颠倒**）。`provider-runtime.ts` 只 import `provider-registry.ts`（纯数据）
 * 与 `account-pool.ts`（**仅类型**），**不** import 本文件 ⇒ **无环**。
 * ⚠️ 别在这里 import `aggregate-adapter.ts` / `auto-adapter.ts`。
 *
 * @module src/aggregate-expiry.ts
 */

import type { AccountPool } from './account-pool.js'
import { NEVER, UNUSABLE, type ExpiryProbe } from './aggregate-core.js'
import type { BuddyCredential } from './buddy.js'
import { fetchCreditBalance, isExclusiveCreditPool } from './credits.js'
import { CODEBUDDY } from './product.js'
import { LOOMY } from './loomy-product.js'
import type { LoomyCredential } from './loomy.js'
import { fetchLoomyCreditDetail } from './loomy-credits.js'
import { fetchCodeArtsAccountInfoDetailed } from './codearts-credits.js'
import type { CodeArtsCredential } from './types.js'
import type { ZcodeCredential } from './zcode.js'
import { fetchZcodeBalance } from './zcode-upstream.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import { exhaustedModelsOf, recoveredModelsOf } from './zcode-entitlements.js'
import type { CreditBalance } from './credits.js'
import type { LobsteraiProduct } from './lobsterai-product.js'
import type { LobsteraiCredential } from './lobsterai.js'
import { fetchLobsteraiCreditBalance } from './lobsterai-credits.js'
import type { TraeProduct } from './trae-product.js'
import type { TraeCredential } from './trae.js'
import { fetchTraeCreditBalance } from './trae-credits.js'
// ⚠️ **本 fork 独有**（魔搭，2026-10-17）：魔粒余额折算。
import { fetchModelscopeBalanceDetailed } from './modelscope-credits.js'
import { MODELSCOPE } from './modelscope-product.js'
import type { ModelscopeCredential } from './modelscope.js'
// ⚠️ AutoClaw（智谱）：钱包余额折算（2026-10-17 审计 P0 修复新增）。
import { fetchAutoclawBalanceDetailed } from './autoclaw-credits.js'
import { AUTOCLAW } from './autoclaw-product.js'
import type { AutoclawCredential } from './autoclaw.js'
import type { AccioCredential } from './accio.js'
import { fetchAccioBalanceDetailed } from './accio-credits.js'
// ⚠️ MonkeyCode / 百智云（本 fork 独有，2026-11-02 审查 B🟡-9 补齐）：
//    余额读数要**会话 cookie**（推理只要主凭据）⇒ 折算原语里要判会话是否存在。
import { fetchMonkeycodeBalanceDetailed } from './monkeycode-credits.js'
import { MONKEYCODE, type MonkeycodeProduct } from './monkeycode-product.js'
import type { MonkeycodeCredential } from './monkeycode.js'
import { fetchBaizhiBalanceDetailed } from './baizhi-credits.js'
import { BAIZHI, type BaizhiProduct } from './baizhi-product.js'
import type { BaizhiCredential } from './baizhi.js'
// ⚠️ AStudio（讯飞 AstronStudio）：三池各带 `*NextExpireTime` ⇒ 可精确折算
//    （2026-10-20 新增）。判据链与 autoclaw 同形，只是时间字段确实存在。
import { fetchAstudioBalanceDetailed } from './astudio-credits.js'
import { ASTUDIO } from './astudio-product.js'
import type { AstudioCredential } from './astudio.js'
import type { OfficeAceCredential } from './officeace-auth.js'
import { fetchSubscriptionSummary } from './officeace-auth.js'
import { officeaceBreakerOpen } from './officeace-credential-health.js'
// ⚠️ Qoder（中国版 / 国际版）：与 **buddy 系同形**（`CreditPackage` 都带
//    `deductionEndTime`）⇒ 本原语直接复用 `sharedPackageExpiry`，不另写判据
//    （2026-10-20 新增）。用 `QoderProduct` 而不是 `typeof QODER`，因为本原语
//    **两站共用**、`product` 由调用方传入。
import { fetchQoderCreditBalance } from './qoder-credits.js'
import type { QoderProduct } from './qoder-product.js'
import type { QoderCredential } from './qoder.js'
// ⚠️ MiniMax Code（中国版 / 国际版）：每条积分明细各带 `expire_at_ms` ⇒ 可精确折算
//    （2026-10-20 新增）。用 `MinimaxProduct` 而不是 `typeof MINIMAX`，
//    因为本原语**两家共用**、`product` 由调用方传入。
import { fetchMinimaxCreditBalanceDetailed } from './minimax-credits.js'
import type { MinimaxProduct } from './minimax-product.js'
import type { MinimaxCredential } from './minimax.js'
import { runtimeOf, type ProviderExpiryContext } from './provider-runtime.js'

/**
 * 真实临期探针：**每个渠道折算成一个「最早失效时刻」**。
 *
 * ## 逐渠道判据（口径与 `jet-hub-auto` 完全一致，故复用同一套端点）
 *
 * | provider | 判据 | 依据 |
 * |---|---|---|
 * | buddy / workbuddy / **lobsterai** / **trae** | 有效资源包 `deductionEndTime` 的最小值（**共享** `sharedPackageExpiry`）；**无 `remaining > 0` 的有效包 ⇒ `UNUSABLE`** | `credits.ts` / `lobsterai-credits.ts` / `trae-credits.ts` |
 * | loomy | `daily > 0` → 当日 24:00；否则 `permanent > 0 ? NEVER : UNUSABLE` | 命名池，无时间戳 |
 * | codearts | **`NEVER`（长期）** | ⚠️ **报文无任何时间字段**（实测三字段全空）⇒ 不臆造 |
 * | zcode | 各桶 `expiresAt`（秒）最小值；**有余额但无到期时间 → 当日**；余额为 0 → `UNUSABLE`；**企业版（`enterprise`）→ `NEVER`** | `zcode-upstream.ts` |
 * | 其余（qoder / qodercn / cline / raccoon / minimax / gemini / opencode） | **本插件未接入** → `UNUSABLE` | 见设计文档 §9.1 |
 *
 * ## ⚠️ 未接入的渠道必须返回 `UNUSABLE`，**不能**返回 `NEVER`
 *
 * `NEVER` 的语义是「可用、只是无临期额度」，它**参与排序且可当选**。若把一个
 * 尚未实现的渠道折算成 `NEVER`，它会以「永久积分」的身份参与轮换 —— 而我们对
 * 它的余额**一无所知**（可能早就用尽了），结果是请求被发到一个没额度的渠道。
 * ⇒ 未接入 = `UNUSABLE` = 剔除。**宁可少一个候选，不可把未知当可用。**
 *
 * ## 为什么只探「一个代表账号」
 *
 * 渠道**内部**的换号由各适配器每次请求现做（buddy/loomy 走余额选号器，其余走
 * `getAvailableAccount` + 429 换号）。本层只回答「这个渠道现在能不能用、它的
 * 临期额度大概什么时候作废」，不替它们选账号。
 *
 * ## ⚠️ 取代表账号时必须带**真实 modelId**
 *
 * `getAvailableAccount` 对空 `modelId` 会**跳过限流过滤**（`account-pool.ts`），
 * 于是取回的是「手动序第一个启用账号」——**哪怕它此刻正在限流**。后果是多账号
 * 池里临期额度被完全忽略。故这里先取一个真实模型 id 再取号。
 *
 * ⚠️ `AbortError` **不得**折算成 `UNUSABLE`：用户取消请求时看到「请先登录」
 * 是误导（真实缺陷，PR !69 审计实测）。
 */

/**
 * **已接入临期折算**的渠道 id。
 *
 * ## ⚠️ 为什么必须导出（审计轮次二实测证伪的缺陷）
 *
 * 聚合层的目录会**广告**出所有能推导出规范名的虚拟模型 —— 包括**候选全来自
 * 未接入渠道**的那些。但那些候选一律被折算成 `UNUSABLE`（正确，见上方注释），
 * 于是用户选中它拿到的是：
 *
 * ```
 * MISSING_CREDENTIAL | 「xxx」当前没有任何可用候选（渠道被关闭、模型被关、
 *                      或所有渠道都无可用账号）
 * ```
 *
 * ⇒ 把「**该渠道的临期折算尚未实现**」谎报成「**你没登录 / 渠道被关**」——
 * 正是本仓库反复修的那类误导性报错。实测（探针）：只接 `cline`（未接入）时
 * `listModels('aggregate')` 仍返回 `['auto','deepseek-v4-1-flash','muse-spark-1-3']`。
 *
 * ⇒ 聚合目录只播报「**至少有一个已接入候选**」的虚拟模型；`auto` 不受影响
 *（它的池跨全部渠道，任一已接入渠道有账号就能路由）。
 *
 * ## ⚠️⚠️ 为什么它必须是**编译期常量**，不能从 runtime 派生（2026-10-08 设计复审）
 *
 * 本清单回答的是「**这个渠道接入了临期折算吗**」—— 那是一个**编译期事实**
 *（本文件有没有为它写折算原语）。而 `ProviderRuntime.expiry` 回答的是另一个问题：
 * 「**运行时该调哪个原语**」。两者**不是同一件事**，故不能互为派生源。
 *
 * 具体后果（**实测**，不是推断）：本清单在源码里有 **4 个**消费点 ——
 * 3 处在 `aggregate-adapter.ts` 的过滤（探测过滤 / 候选过滤 / 虚拟模型过滤），
 * 1 处是本文件的「未接入」短路。而**既有测试**里有两个大批量的构造点：
 * **29 处**临期探针工厂调用、**86 处** `AggregateAdapter` 构造 —— 那些文件
 * **一次都不调 `apply()`**（`aggregate-expiry` / `aggregate-wiring` /
 * `zcode-expiry-exhausted` 三份的 `apply` 命中**都不是真实调用**：实测分别是
 * 3 / 0 / 0 处，有命中的那份全是注释里的字）。
 * ⚠️ **计数口径**（便于复核，2026-10-08 实测）：在 `tests/unit` 里 grep
 * 「工厂名 + 左括号」共 36 处，减去 `expiry-runtime-parity.spec.ts` 自己的 7 处
 * ⇒ **既有 29 处**；grep「`new` + `AggregateAdapter` + 左括号」共 86 处
 *（全在既有文件）。⚠️ 本仓库的注释刻意**不写出左括号**，否则注释自己会被
 * 下一次 grep 计进去（自指），数字就再也复核不出来。
 * 而 runtime 注册只发生在 `apply()` ⇒ 派生版本在这些场景下**恒为空数组**，于是：
 *
 * | 后果 | 严重度 |
 * |---|---|
 * | `refreshCatalog` 把所有虚拟模型过滤掉 ⇒ **聚合 provider 的模型列表整个变空** | 致命 |
 * | 上述 29 + 86 处构造点大面积变红 | 高 |
 *
 * ⚠️ **不要**把它说成「生产路径也会变空」—— 那是**没有证据**的推断，已实测证伪：
 * `src/index.ts` 里聚合适配器确实在 runtime 注册**之前**创建（`registerAggregateLlm`
 * 调用早于 `registerProviderRuntime` 那段循环），但 `catalog-prewarm` 的首次预热是
 * `queueMicrotask` 排的，而 `apply()` 是**同步**函数 ⇒ 微任务在 `apply()` **整体
 * 返回之后**才跑，那时注册（同步段内）早已完成。
 * 实测（`node -e` 复现同一时序）：`sync-A → registration → sync-B → microtask → prewarm`。
 * ⇒ 派生版本在**生产**启动窗口内其实是安全的；**决定性证据是上面那两组实测计数**
 * （29 处探针 + 86 处适配器构造，全都不调 `apply()`），不是「生产会挂」。
 *
 * ⇒ 保持常量。它与 runtime 的一致性由
 * `tests/unit/expiry-runtime-parity.spec.ts` 的「**清单 == runtime 里挂了
 * `expiry` 域的渠道集合**」锁死（真跑 `apply()`）—— 那条锁的是真实会发生的漂移
 *「有人加了 runtime 注册却忘了加清单」（或反之），**不是**同义反复。
 */
export const WIRED_EXPIRY_PROVIDERS: readonly string[] = Object.freeze([
  'buddy',
  'workbuddy',
  'loomy',
  'codearts',
  'zcode',
  // ⚠️ 用户 2026-10-07 质疑后核实加入（此前被 `auto-adapter.ts` 一句**不成立**的
  //    理由排除：「其余 provider 没有跨账号的到期余额探测端点」）：
  //    实测这两家的 `CreditPackage` 与 buddy **同形**，都有 `deductionEndTime`。
  'lobsterai',
  'trae',
  // ⚠️ accio（2026-10-13 合并审计发现「聚合里看不到它」后补）：用户明确要求
  //    「聚合当中的 qwen3.8-flash 轮换列表里要有 accio」，而**决定候选表可见性的
  //    是这张表、不是 `AGGREGATE_CHANNELS`** —— 漏加它 ⇒ 归一化补丁再对也没用
  //    （模型层归并了，候选层却被这道闸门剔掉），症状**静默**。
  'accio',
  // ⚠️ officeace（2026-10-13 用户要求「加入聚合轮换」）：与 buddy 系**同形**
  //    （订阅的每个积分桶都带 `expiresAt`），折算原语见 `officeaceExpiry`。
  //    ⚠️ 与 accio 同款陷阱：**决定候选表可见性的是这张表、不是
  //    `AGGREGATE_CHANNELS`** —— 只加后者 ⇒ 归一化再对也没用，症状静默。
  'officeace',
  // ⚠️ **本 fork 独有**（魔搭，2026-10-17，用户明确要求加入）：
  //    折算原语见 `modelscopeExpiry`，属「**有余额但不下发到期时间**」那一类
  //    （魔搭余额报文里没有任何时间字段）⇒ 有余额即 `NEVER`、烧光即 `UNUSABLE`。
  //
  //    ⚠️⚠️ **代价（用户已知并接受）**：魔粒烧光时**不会被提前剔出轮换** ——
  //    平台既不下发「配额何时重置」，也没有别的额度端点（`/api/v1/quota/status`
  //    经实测是**任务奖励**、不是额度）。⇒ 耗尽后仍会被选中并失败一次。
  //    ⚠️ **不许用「猜一个每日 UTC+8 零点」消除它**：那是凭空造一个上游从未
  //    承诺的重置时刻（本仓库红线「绝不编造数字」）。
  //    ⚠️ 与 accio / officeace 同款陷阱：**决定候选表可见性的是这张表、
  //    不是 `AGGREGATE_CHANNELS`** —— 只加后者等于没接。
  'modelscope',
  // ⚠️ **AutoClaw**（智谱，2026-10-17 审计 P0 修复）：折算原语见 `autoclawExpiry`，
  //    属「**有余额但不下发到期时间**」那一类（钱包报文里没有任何时间字段）
  //    ⇒ 有余额即 `NEVER`、烧光即 `UNUSABLE`。
  //    ⚠️⚠️ **这是该陷阱的第 4 次复发**（cline → accio → officeace → autoclaw），
  //    症状恒定**静默**：PR 只加了 `aggregate-adapter.ts` 的 `AGGREGATE_CHANNELS`
  //    （模型层归并会发生、看起来接好了），而**决定候选表可见性的是本表**
  //    —— 漏加它 ⇒ 折算恒 `UNUSABLE`（`aggregate-expiry.ts` 的 `createExpiryProbe`
  //    与 `aggregate-adapter.ts` 的 4 处过滤都按本表），用户在聚合轮换列表里
  //    **永远看不到 autoclaw**，且**无报错、无日志**。
  //    ⚠️ 三处必须同改：本表 + `provider-expiry.ts` 的 `createProviderExpiry()`
  //    + 折算原语（后两者的一致性由 `expiry-runtime-parity.spec.ts` 真跑
  //    `apply()` 锁一致）。
  'autoclaw',
  // ⚠️ AutoClaw **国际版**（`autoclawintl`，2026-10-20）：与 `autoclaw` 同格
  //    （同一份 `autoclawExpiry` 折算原语，实测批次带 `deductionEndTime`）。
  //    ⚠️ 它也是**陷阱复发**的一次：只加 `AGGREGATE_CHANNELS` 而不加本表，
  //    症状是「模型层归并发生了、看起来接好了，但候选层被这道闸门剔掉」，
  //    用户在聚合轮换列表里**永远看不到国际版**，且**零报错、零日志**。
  //    ⚠️ 三处同改：本表 + `provider-expiry.ts` 的 `autoclawintl` 条目
  //    （⚠️ 那里必须传 `AUTOCLAW_INTL`，否则会用国内基址查国际账号余额）
  //    + 折算原语（`autoclawExpiry` 本身产品无关，无需改）。
  'autoclawintl',
  // ⚠️ **MonkeyCode 国内站 / 国际站 / 百智云**（本 fork 独有，2026-11-02 审查
  //    B🟡-9 补齐）：经「审查员 B 说豁免理由被证伪」核实后确认 —— 三家都**有**
  //    真实的余额读数接口，折算原语见 `monkeycodeExpiry` / `baizhiExpiry`。
  //
  //    ⚠️ 三处必须同改（本表 + `provider-expiry.ts` 的 `createProviderExpiry()`
  //    + 折算原语）—— 本仓库这个陷阱已复发 5 次（cline → accio → officeace →
  //    autoclaw → autoclawintl），症状恒定**静默**：模型层归并发生了、看起来
  //    接好了，但候选层被这道闸门剔掉，用户在聚合轮换列表里永远看不到该渠道。
  //
  //    ⚠️ `monkeycodeintl` 必须传 `MONKEYCODE_INTL`（两站账号池不互通、域名不同：
  //    国际站 cookie 打国内站回 401）—— 传错会让国际账号折算恒 `UNUSABLE`。
  'monkeycode',
  'monkeycodeintl',
  'baizhi',
  // ⚠️ **Qoder**（中国版 / 国际版，2026-10-20，用户要求补齐三档分档 + 永久锁）。
  //    折算原语见 `qoderExpiry`（两站共用，只换 product）。
  //
  //    取证（2026-10-20，两个真实 qodercn 账号，`/sash/api/v2/me/usage`）：
  //    - `userQuota` 只有顶层 `expiresAt`，且恒为**永久哨兵**（见下）；
  //    - `addOnQuota` **无任何日期字段，只给聚合标量**；
  //    - `dedicatedResourcePackages` 是**唯一**带真实逐包 `expiresAt` 的字段，
  //      但本机账号为 `undefined`。
  //
  //    - 顶层 `qoderUsage.expiresAt = 253402214400000`（`9999-12-31T00:00:00Z`），
  //      是 Qoder 给 `userQuota` 下发的**永久哨兵**、**不是**到期时刻。
  //    - 实际后果：`qoder-credits.ts` 对哨兵**不写** `deductionEndTime`
  //      （写进去会让客户端渲染出「9999-12-31（约 2900000 天后）」荒谬文案）
  //      ⇒ 有余额 ⇒ `NEVER`（长期，排最后但可当选）。
  //    - ⚠️ 国际站 `openapi.qoder.sh` 本机**网络不可达**（`fetch failed` ~10.7s），
  //      ⇒ 对「取不到」保守：`fetchQoderCreditBalance` 返回 `null` ⇒ `UNUSABLE`。
  //
  //    ⚠️⚠️ **这是该陷阱的第 7 次复发**（cline → accio → officeace → autoclaw
  //    → astudio → minimax → qoder），症状恒定**静默**：**决定候选表可见性的
  //    是本表**，只改 `aggregate-adapter.ts` 的 `AGGREGATE_CHANNELS` 等于没接 ——
  //    折算恒 `UNUSABLE`，用户在聚合轮换列表里**永远看不到 qoder / qodercn**。
  //    ⚠️ 两家**各占一行**：本表按 provider id，漏 `qodercn` 会让中国版单独被剔。
  'qoder',
  'qodercn',
  // ⚠️ **AStudio**（讯飞 AstronStudio，2026-10-20）：折算原语见 `astudioExpiry`。
  //    三池（会员 / 购买 / 赠送）各下发 `*NextExpireTime`（不带时区的本地时间串），
  //    已由 `astudio-credits.ts` 的 `astudioLocalTimeMs` 归一化到
  //    `packages[].deductionEndTime`（毫秒）⇒ 与 buddy 系同一套
  //    `sharedPackageExpiry` 折算即可，不需要自写原语。
  //    ⚠️⚠️ **这是该陷阱的第 5 次复发**（cline → accio → officeace → autoclaw
  //    → astudio），症状恒定**静默**：PR 只加了 `aggregate-adapter.ts` 的
  //    `AGGREGATE_CHANNELS`（模型层归并会发生、看起来接好了），而**决定候选表
  //    可见性的是本表** —— 漏加它 ⇒ 折算恒 `UNUSABLE`，用户在聚合轮换列表里
  //    **永远看不到 astudio**，且**无报错、无日志**。
  //    ⚠️ 三处必须同改：本表 + `provider-expiry.ts` 的 `createProviderExpiry()`
  //    + 折算原语（后两者的一致性由 `expiry-runtime-parity.spec.ts` 真跑
  //    `apply()` 锁一致）。
  'astudio',
  // ⚠️ **MiniMax Code**（中国版 / 国际版，2026-10-20，用户报障
  //    「MiniMax Code 积分也有到期时间，也应当有相同功能」）。
  //    折算原语见 `minimaxExpiry`（两家共用，只换 product）。
  //    `/minimax-cloud/api/v1/credit/details` 的每条 `details[]` 都带
  //    `expire_at_ms`（毫秒时间戳）⇒ 可精确折算，无已知代价。
  //    ⚠️ 国际站必须透传 `xff`（`pool.minimaxXff()`），否则 `agent.minimax.io`
  //    307 到中国站、token 不被认 ⇒ 折算恒失败（IKMEVG）。
  //    ⚠️⚠️ **这是该陷阱的第 6 次复发**（cline → accio → officeace → autoclaw
  //    → astudio → minimax），症状恒定**静默**：**决定候选表可见性的是本表**，
  //    只改 `aggregate-adapter.ts` 的 `AGGREGATE_CHANNELS` 等于没接。
  //    ⚠️ 三处必须同改：本表 + `provider-expiry.ts` 的 `createProviderExpiry()`
  //    + `provider-registry.ts` 的 `usesExpiryWindow` / `permanentLock`。
  'minimax',
  'minimaxintl',
  // ⚠️ Magicrew（2026-10-29）：**决定聚合候选表可见性的就是本表**。
  //    只加 `AGGREGATE_CHANNELS` 而不加这里 ⇒ 折算恒 UNUSABLE（静默少一个候选）。
  //    折算原语：`provider-expiry.ts` 的 `magicrew` 条目 → `magicrew-credits.ts` 的 `magicrewExpiry`。
  'magicrew',
  // ⚠️ **MagiCrew 国际版**（`magicrewintl`，2026-11-01）：**决定聚合候选表可见性
  //    的就是本表**。只加 `AGGREGATE_CHANNELS` 而不加这里 ⇒ 折算恒 UNUSABLE
  //    ⇒ 国际站候选从轮换表里静默消失（与 minimaxintl / autoclawintl 同款）。
  //    折算原语：`provider-expiry.ts` 的 `magicrewintl` 条目 → 同一个 `magicrewExpiry`，
  //    但**必须传 `MAGICREW_INTL`**（传国内版会拿国内基址查国际账号余额）。
  'magicrewintl',
])

/**
 * 临期折算结果的**缓存时长**（毫秒）。用户 2026-10-07 要求加缓存，TTL 由用户在
 * 60 / 90 / 120 中选定 —— **取 60**。
 *
 * ## 为什么是 60
 *
 * - 与既有的 {@link BUDDY_BALANCE_CACHE_TTL_MS}（余额选号器，`60_000`）**同值** ——
 *   两处节奏一致，不会出现「选号用 30 秒前的数据、排序用 90 秒前的」这种分叉；
 * - 临期判据的最小粒度是**天**（资源包到期以天计）⇒ 60 秒滞后在语义上无害；
 * - 最短 ⇒ 用户改完渠道侧配置后最坏等待最短。90/120 只省极少量请求
 *  （面板与排序都不是高频路径），却让「刚登录的账号不出现在排序里」的窗口更长。
 */
export const EXPIRY_CACHE_TTL_MS = 60_000
/**
 * **单渠道折算的总预算**（毫秒）。
 *
 * ## 为什么必须封顶
 *
 * 本函数内部 `for (const item of credentials)` **串行**折算，而单账号折算自带
 * 30 s 级的上游超时（各 `*Expiry` 自己的 `*_REQUEST_TIMEOUT_MS`）⇒ 单渠道最坏
 * 耗时 = **账号数 × 单账号超时**。账号池随用户增删账号线性增长，于是「发一条
 * 消息 / 打开面板」的等待被账号数线性放大。
 *
 * ## ⚠️ 本仓库的**具体取证**（上游 86e3591 把它删了，本仓库保留）
 *
 * 上游删掉下面这段的理由，是**他们那份仓库里 `buddy` / `workbuddy` 查无实据**
 * （`PROVIDER_REGISTRY` 只有 20 个 id、`src/` 下无 `buddy-*.ts`）。
 * **该理由在本仓库不成立**：这两家就在下面的 {@link WIRED_EXPIRY_PROVIDERS} 里，
 * 也都在 `provider-expiry.ts` 的 `createProviderExpiry()` 里（`buddyFamilyExpiry`）
 * ⇒ 走 `buddyExpiry` → `fetchCreditBalance`（`credits.ts` 的
 * `REQUEST_TIMEOUT_MS = 30_000`）。故这条**真实故障**证据在本仓库成立，按
 * 「如实登记真实故障证据」保留：
 *
 * - 用户报障「重启后配置一直加载不出来」；同机实测 `session/modelCatalog`
 *   冷启动 **290 000 / 222 000 / 54 000 ms**（中位 **222 秒**），而同一时刻
 *   `settings/describe` 只要 **68 ms** ⇒ 事件循环没被堵，是本函数在逐账号串行等上游；
 * - 该机账号池 **workbuddy 7 个号 + buddy 8 个号** ⇒ 最坏 `7×30 + 8×30 = 450 s`；
 * - 账号数在 2026-10-17 23:00 到 10-18 00:30 之间从 **17 涨到 31**
 *   ⇒ 用户感受到「昨天还能忍、今天撞墙」。
 *
 * ⚠️ 顺带订正上游 commit message 里一条**在本仓库为假**的断言：它说
 * `credits.ts` 的 `REQUEST_TIMEOUT_MS`「在 `createProviderExpiry()` 里没有消费者
 * （死路径）」—— 本仓库里 `fetchCreditBalance` **正是** buddy 系的消费者。
 *
 * ## ⚠️⚠️ 它封的是哪条路径（别读错 —— 这里已误判过两次）
 *
 * 本探针的消费者只有**两处**，且都**不在**目录加载路径上：
 *
 * | 消费者 | 何时跑 |
 * |---|---|
 * | `aggregate-adapter.ts` 的 `candidatesFor` | **发消息**（`prepareCall`） |
 * | `aggregate-adapter.ts` 的 `describeExpiryOrder` | 面板「按临期排序」（用户点按钮） |
 *
 * ⚠️ `buildModelCatalog` / `resolveModel` / `listModels` / `refreshCatalog`
 * **一律不调本探针**（前者走 `coldModelInfo` + 后台刷新，后两者只读各渠道目录）
 * ⇒ **本预算不会缩短模型选择器的冷启动耗时**。想改善那条路径要动的是
 * `AGGREGATE_BACKGROUND_REFRESH_TIMEOUT_MS` 与 `catalogForListModels`，不是这里。
 * 把因果链写成「修 `modelCatalog` 冷启动」是**错的**（2026-10-22 审计实测：
 * 那四个方法体里 `expiryProbe` 出现 0 次）。
 *
 * ## 为什么是 8 秒
 *
 * - `candidatesFor` 是**发消息**路径（用户按了发送正在等），超过 10 秒已可认为卡死；
 * - 正常情况下一个渠道折算远低于 8 秒（本仓库排障日志里 codearts / trae / zcode
 *   均在 1.2 秒内）—— 8 秒只截断「上游在超时边缘」的渠道；
 * - 被截断的渠道按**保守方向**处理，与本文件铁律
 *   「宁可少一个候选，不可把未知当可用」一致。
 *
 * ## ⚠️⚠️ 预算**按账号均分**，不是「先到先得」（2026-10-22 审计打穿后改）
 *
 * 初版是「首号吃满整个预算，耗尽就 `break`」。实测后果：某渠道的**第一个**账号
 * 稳定慢于 8 秒 ⇒ 后面所有账号**每一轮都轮不到** ⇒ 每轮都 `UNUSABLE` ⇒ 还被
 * `cacheAndReturn` 缓存 60 秒 ⇒ 该渠道在聚合轮换里**永久不可见**。
 * 那正是上一版注释自称要避免的故障，被自己的实现从另一个入口做了出来
 *（`listAvailableCredentials` 的顺序 = `readAccounts()` 固定顺序，无轮转 ⇒ 每轮
 * 都是同一个「首号」）。
 *
 * ⇒ 现在每个账号只拿「**剩余预算 ÷ 剩余账号数**」（见循环处的 `perAccountMs`）：
 * 总时长仍 ≤ 本预算，但**每个账号都有一次机会**。
 *
 * ⚠️ 截断**不是**把结果写成 `NEVER`：那会让一个我们其实没查清的渠道以
 *   「永久可用」身份参与排序。已成功折算的账号仍按**真实观测值**返回
 *   （如实登记：那是**部分观测**，不是全量）；一个都没成时才 `UNUSABLE`。
 */
export const EXPIRY_PROBE_BUDGET_MS = 8_000

/**
 * 单账号可用的**最低预算下限**（毫秒）。
 *
 * ## 为什么必须有下限（2026-10-22 审计打穿后补）
 *
 * 预算按「剩余预算 ÷ 剩余账号数」均分后，账号一多，每份就会小到不可用：
 * 8 秒 ÷ 31 个账号 = **258 ms**，而正常的折算实测在 350 ms ~ 1.2 s 之间 ⇒
 * **每个账号都会被自己的那份截断** ⇒ 整渠道 `UNUSABLE`，等于把「账号多」直接
 * 变成「渠道不可见」。那与 {@link EXPIRY_PROBE_BUDGET_MS} 要解决的问题同型。
 *
 * ⇒ 每份取 `max(下限, 均分)`：宁可让本渠道**略微超出**总预算，也不让任何一个
 * 账号因为「排得靠后」或「账号太多」而被跳过。超出量有界（≤ 账号数 × 下限），
 * 且只在「前几个账号各自吃满自己那份」的病态情形下才叠加。
 *
 * ⚠️ 取值理由：1.2 秒是实测里最慢的正常渠道（trae）的耗时量级 ⇒ 取 1.5 秒留余量。
 * 再小会让正常渠道被误截断；再大则「账号多」时总耗时增长过快。
 */
export const EXPIRY_PROBE_MIN_SLICE_MS = 1_500

/**
 * `createExpiryProbe` 的返回类型：临期探针 **+ 缓存失效入口**。
 *
 * ⚠️ 为什么是**交叉类型**而不是改 `ExpiryProbe` 本身：那个类型定义在
 * `aggregate-core.ts`（必须是**零 import** 的纯逻辑底座），而它只描述「给定渠道
 * 返回最早失效时刻」这一件事。缓存是**实现细节**，不该渗进底座类型。
 *
 * ⚠️ 为什么要暴露 `clear`：见 `createExpiryProbe` 返回处与 `src/index.ts`
 * 装配处的长注释 —— 缓存原先**没有任何失效通道**，导致刚登录的账号
 * 最长 60 秒对路由不可见（用户拿到误导性的「没有任何可用候选」）。
 */
export type ExpiryProbeWithCache = ExpiryProbe & { clear: () => void }

/** `createExpiryProbe` 的可选依赖（单测注入时钟用）。 */export interface ExpiryProbeOptions {
  /** 当前时刻（毫秒）；默认 `Date.now`。 */
  now?: () => number
  /** 缓存时长（毫秒）；默认 {@link EXPIRY_CACHE_TTL_MS}。 */
  ttlMs?: number

  /**
   * 单渠道折算的**总预算**（毫秒）；默认 {@link EXPIRY_PROBE_BUDGET_MS}。
   *
   * `0` 表示**不封顶**（保留升级前行为，供需要精确结果的调用方与单测使用）。
   *
   * ## ⚠️⚠️ 非法值一律回落默认，绝不「静默劣化」（2026-10-22 审计打穿后修）
   *
   * 归一化见 {@link normalizeExpiryProbeBudget}。初版只判 `=== 0`，于是：
   *
   * | 传入 | 初版实际行为 |
   * |---|---|
   * | `Infinity`（「不封顶」最自然的直觉写法） | `setTimeout` 延迟溢出被 Node **钳成 1 ms** ⇒ 全部渠道瞬间 `UNUSABLE` |
   * | `NaN` / `1e10` / 字符串 `'0'` | 同上（`1e10` 与 `'0'` 也溢出） |
   * | `-1` | `deadline` 在过去 ⇒ **一个账号都不探** |
   *
   * ⇒ 只有**有限的非负数**才被采纳；其余（含 `Infinity`）一律回落默认值。
   * 想让预算「不限时」请传 `0`（那是本字段唯一登记的「不封顶」写法）。
   *
   * ⚠️ 这是**每渠道**预算，不是全局预算：`candidatesFor` 逐渠道 `await`，
   * 每个渠道独立计时 —— 一个渠道慢不会连坐其它渠道。
   */
  budgetMs?: number
  /**
   * 该渠道的**全部目录模型 id**（可选的加强依赖，2026-10-12 加入）。
   *
   * ## 为什么需要它（zcode 的按模型额度）
   *
   * zcode 的余额是**按模型分桶**的（实测 8M = GLM-5.3 的 3M + GLM-5.3-Flash 的 5M），
   * 要把「某模型在这个账号上已尽」写成 `modelRateLimits` 标记，就必须知道
   * **该渠道的目录模型 id 有哪些、且大小写是什么**。
   *
   * ⚠️ **两侧大小写不同**（实测 `scripts/probe-zcode-model-id-casing.mjs`）：
   *
   * | 来源 | 形态 |
   * |---|---|
   * | 上游 `capabilities` | `model:glm-5.3`（**小写**） |
   * | DSH 目录 `modelId`（= 池过滤用的键） | `GLM-5.3`（**大写**） |
   *
   * 而池的过滤是 `a.modelRateLimits[modelId]` **精确匹配** ⇒ 拿小写去写
   * **永远不命中**，且没有任何报错（静默失效）。⇒ 必须传**目录那一套形态**的 id
   * （由 `zcode-entitlements.ts` 的 `exhaustedModelsOf` 保证：它直接回传进来
   * 的目录元素，而内部比对是大小写不敏感的）。
   *
   * ⚠️ **省略时的降级**：用 `firstModelIdOf` 那一个 id 当作全集（只覆盖第一个模型）。
   * 这让既有装配与几十处测试桩**零改动**即可工作 —— 见下方调用点。
   */
  catalogIdsOf?: (provider: string) => Promise<readonly string[]>
  /**
   * 共享余额读数（**装配层注入**；省略 ⇒ 各实现方自己发请求，行为与升级前一致）。
   *
   * ⚠️ 返回 `undefined` 表示**本次没有共享读数可用**（未命中且取数失败）⇒
   *    实现方必须回落到自己发请求。**不得**用「抛错」表达「没有读数」：
   *    那会让折算把「缓存不可用」与「上游查询失败」混为一谈。
   * ⚠️ `credential` 由本工厂从**账号池条目**配对后回调（缓存按 `(provider, accountId)`
   *    去重，而取数原语需要凭据）。
   */
  balanceOf?: (provider: string, accountId: string, credential: unknown) => Promise<unknown>
}

/**
 * 归一化 {@link ExpiryProbeOptions.budgetMs}（**纯函数，可直接单测**）。
 *
 * ## 为什么必须有它（2026-10-22 审计打穿）
 *
 * 初版只判 `budgetMs === 0`，其余值原样交给 `setTimeout`。而 `setTimeout` 的
 * 延迟是 **32 位有符号整数**，越界/`NaN` 会被 Node **钳成 1 ms**（并打一条
 * `TimeoutOverflowWarning` / `TimeoutNaNWarning` 到 stderr）。实测后果：
 *
 * | 传入 | 实测（3 账号全挂死） |
 * |---|---|
 * | `Infinity`（「不封顶」最自然的直觉写法） | 每个账号**瞬间** UNUSABLE（计时器 1 ms） |
 * | `NaN` / `1e10` / 字符串 `'0'` | 同上 |
 * | `-1` | `deadline` 在过去 ⇒ **0 次 fetch** |
 *
 * ⇒ 判据：**只有有限的非负数被采纳**；`0` 保留「不封顶」语义；其余一律回落
 * 默认值（`Infinity` 也回落 —— 想要不封顶请传 `0`，那是唯一登记的写法）。
 *
 * ⚠️ 上界 `2 ** 31 - 1` 是 `setTimeout` 自己的上限，超过它就会被钳成 1 ms ⇒
 *   必须在**这里**截断，而不是指望 `setTimeout` 帮忙。
 */
export function normalizeExpiryProbeBudget(raw: unknown): number {
  const max = 2 ** 31 - 1
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return EXPIRY_PROBE_BUDGET_MS
  if (raw === 0) return 0
  return Math.min(raw, max)
}

/**
 * 算出「**当前这个账号**可以等多久」（**纯函数，可直接单测**）。
 *
 * ## 为什么把它抽出来（2026-10-22 变异验证的血泪）
 *
 * 这段算术原本内联在循环里，于是只能用**耗时**来判它有没有生效。实测：
 * 「去掉 `min(剩余预算, …)`」这个变异只让 31 个账号的耗时从 8.01 s 变成 9.05 s
 * —— 而**探测账号数两者完全相同**（都是 6 个）。⇒ 那条用例：
 * - 用 `toBeLessThan(预算 + 5s)` 时对变异**完全无牙**；
 * - 用 `toBeLessThan(预算 + 1.2s)` 时又会被 CI 抖动打成**时红时绿**。
 *
 * ⇒ 抽成纯函数后，判据变成**确定性的逐格算术**，与时钟无关。
 *
 * ## 口径：`min(剩余预算, max(下限, 均分))`
 *
 * | 项 | 作用 |
 * |---|---|
 * | `均分` = 剩余 ÷ 剩余账号数 | 让**每个账号都有机会**；快账号省下的预算自动滚给后面的 |
 * | `下限` = {@link EXPIRY_PROBE_MIN_SLICE_MS} | 账号多时均分会小到不可用（8 s ÷ 31 = 258 ms，而正常渠道实测 350 ms~1.2 s）⇒ 没它会把「账号多」直接变成「全被截断」 |
 * | **`min(剩余预算, …)`** | **总时长硬上界** —— 下限**不得**透支预算 |
 *
 * ⚠️ 第三项是必须的：我第一版漏了它，实测 31 个账号全挂跑了 **46.8 秒**（31 × 下限）。
 *
 * @param budgetMs - 已归一化的总预算；`0` 表示不封顶。
 * @param remainingMs - 本渠道**还剩多少预算**（可能为负 / `Infinity`）。
 * @param remainingAccounts - **含当前账号在内**还有几个没探。
 * @returns 当前账号可等待的毫秒数（`Infinity` = 不封顶）。
 */
export function expiryProbeSliceMs(
  budgetMs: number,
  remainingMs: number,
  remainingAccounts: number,
): number {
  if (budgetMs === 0) return Number.POSITIVE_INFINITY
  const share = Math.floor(remainingMs / Math.max(1, remainingAccounts))
  return Math.min(remainingMs, Math.max(EXPIRY_PROBE_MIN_SLICE_MS, share))
}

export function createExpiryProbe(
  pool: AccountPool,
  firstModelIdOf: (provider: string) => Promise<string | undefined>,
  options: ExpiryProbeOptions = {},
): ExpiryProbeWithCache {
  /**
   * 按渠道缓存折算结果（用户要求：排序读缓存，不每次打服务器）。
   *
   * ## ⚠️ 为什么缓存必须在**这个工厂内部**（而不是各调用方自己加）
   *
   * `auto-adapter.ts` 的 `expiryOf` **每次调用都新建一个 probe**
   *（`createExpiryProbe(pool, …)`），聚合层也用同一个工厂 ⇒ 若缓存放在调用方，
   * `auto` 与聚合会**各查一遍**，且 `auto` 那条路径每次都从零开始（等于没缓存）。
   * 放在工厂内部后，**同一装配期内的所有调用共享一份** ——
   * `src/index.ts` 里两个适配器用的是**同一个** probe 实例（见那里的装配注释）。
   *
   * ⚠️ 缓存键是**渠道 id**（不是模型）：临期额度是账号级的，与模型无关
   *（`buddyExpiry` 等只读账号的资源包）。不同渠道必须各自缓存。
   *
   * ⚠️ **中止不写缓存**（见下方 `catch`）：一次取消若留下条目，后续请求会误命中
   * 一个「上次被取消」的结果。
   */
  const cache = new Map<string, { at: number; value: number }>()
  const now = () => options.now?.() ?? Date.now()
  const ttl = options.ttlMs ?? EXPIRY_CACHE_TTL_MS
  /**
   * 写缓存并返回该值。
   *
   * ⚠️ **`UNUSABLE` 也缓存**（不是只缓存成功值）：一个渠道「现在没有可用账号」
   * 在 60 秒内不会变，不缓存会让面板与排序在每次刷新时都为它白跑一遍
   *（取号 + 目录读取）。与 `buddy-balance-selector` 的失败短 TTL 取舍**不同** ——
   * 那里失败会被判「额度用尽」（有误导性后果）故用 5 秒；这里 `UNUSABLE` 只是
   * 「本轮剔除该候选」，60 秒的滞后无害。
   *
   * ⚠️ 但**中止不写缓存** —— 那由调用点保证（`AbortError` 会 throw，走不到这里）。
   */
  /**
   * 缓存**代际**：`clear()` 递增它。
   *
   * ## ⚠️ 为什么需要（真实缺陷，对抗审计实测证伪）
   *
   * `cacheAndReturn` 在探测**结束时**写缓存。若一个探测**早在 `clear()` 之前**
   * 就已开始（正卡在某个 `await` 上），它的写回发生在 `clear()` **之后**
   * ⇒ **陈旧值活过整个 TTL** —— 用户「清缓存」的努力被一个在途请求作废。
   *
   * 实测：`clear() 期间在途探测 ⇒ -1 ｜ clear 后再探 ⇒ -1 ｜ 取号次数 = 1`
   * ⇒ 登录后清缓存，但那个「登录前开始、登录后才结束」的探测把 `-1`（不可用）
   * 又写了回去，用户仍要再等 60 秒（正是本修复要消灭的那个现象）。
   *
   * ⇒ 探测在**开始时**记下代际，写回时代际不符就**丢弃**（不写缓存）。
   */
  let generation = 0
  /**
   * 写缓存并返回。
   *
   * ⚠️ **中止不写缓存** —— 那由调用点保证（`AbortError` 会 throw，走不到这里）。
   *
   * @param startedAt - 本次探测**开始时**的代际（`clear()` 会让它过期）
   */
  const cacheAndReturn = (forProvider: string, value: number, startedAt: number): number => {
    // ⚠️ 代际不符 ⇒ 这是一次「跨越了 clear() 的在途探测」⇒ **丢弃**，不写缓存
    //   （否则陈旧值会活过整个 TTL，让 clear() 形同虚设）。
    if (startedAt === generation) cache.set(forProvider, { at: now(), value })
    return value
  }
  return Object.assign(
    async (provider: string, signal?: AbortSignal) => {
    // ⚠️ **缓存命中也要先查 signal**：中止必须立刻以 `AbortError` 结束，
    //    不能因为「反正有缓存」就把取消吞掉（与下方短路同一口径）。
    signal?.throwIfAborted()
    const cached = cache.get(provider)
    if (cached !== undefined && now() - cached.at < ttl) return cached.value

    // ⚠️ **未接入的渠道直接返回 `UNUSABLE`，不取号、不读目录**（第 3 轮审计实测）。
    //
    // 为什么要在最前面短路：本函数对**未接入**渠道最终也返回 `UNUSABLE`（走下方
    // `credentialExpiry` 的「无 `expiry` 域」分支），但那时**已经**做了两件无意义的事：
    //   ① `await firstModelIdOf(provider)` —— 一次渠道目录读取；
    //   ② `await pool.getAvailableAccount(...)` —— 一次账号池查询。
    // 而 `candidatesFor` 的池包含**全部**渠道的候选 ⇒ 每次 `auto` 请求都会为**每个**
    // 未接入渠道白做这两件事（实测探针：`getAvailableAccount` 被以 `cline/m1` 调用）。
    //
    // ⚠️ 两件都**不是网络请求**（`getAvailableAccount` 是纯本地内存过滤），故这属
    // **性能浪费**而非功能缺陷；但短路是零成本的，且让语义更准确 ——
    // 「未接入」与「有账号但折算不了」是两件事，不该走同一条路径。
    //
    // ⚠️ `signal` 仍要先查：中止必须**立刻**以 `AbortError` 结束（全局约束），
    //    不能因为「这个渠道反正未接入」就把中止吞掉。
    signal?.throwIfAborted()
    if (!WIRED_EXPIRY_PROVIDERS.includes(provider)) return UNUSABLE
    // ⚠️ 记下**本次探测开始时**的代际：若中途有 `clear()`（用户刚登录），
    //    写回时会被丢弃（否则陈旧值活过整个 TTL —— 见 `cacheAndReturn` 的长注释）。
    const startedAt = generation

    // ⚠️ 类型是 `unknown[]`（各渠道凭据形状不同，由 `credentialExpiry` 分派时收窄）。
    //
    // ★ 2026-10-12：改为保留**账号条目 id**（`entry.id`）—— zcode 的按模型额度
    //   标记必须写到**具体账号**上（`modelRateLimits` 是账号级字段），
    //   而 `credential` 里没有账号 id（`device_mid` 是我们每次随机生成的，不可用）。
    //   ⚠️ 旧回退路径（`legacySingleCredential`）拿不到 id，故那里显式填 `undefined`
    //   —— 后果只是「那条路径下 zcode 写不了标记」，不影响折算值。
    //
    // ★ 2026-10-13：**同时保留 `credentialRef`** —— officeace 的余额入口只有拿到
    //   它才走云侧直读（否则回落果办客户端的全局单 cookie ⇒ 多账号串号，
    //   而聚合候选排序是**每账号**粒度 ⇒ 会选错人）。同样只在回退路径缺失。
    let credentials: Array<{ entry: { id?: string; credentialRef?: string }; credential: unknown }>
    /**
     * 该渠道目录的第一个模型 id（空串 = 目录读不到）。
     *
     * ⚠️ **必须提到 `try` 外面**：`catalogIds` 的降级分支要用它（2026-10-12）。
     */
    let probeModel = ''
    try {
      // ⚠️ `?? ''` 是**有意的**降级（注释随搬移丢失，Task 7 复审 M3 指出，现补回）：
      // 目录不可读 / 无可用模型时退回空串 —— 此时「有没有账号」这个判据**仍然成立**，
      // 只是**限流维度退化为不参与**（`getAvailableAccount` 对空 modelId 跳过限流
      // 过滤）。取舍方向：宁可少筛一层，也不可把整池判成不可用。
      // ⚠️ 反之**不要**在这里因为拿不到 modelId 就 return UNUSABLE —— 那会让
      // 「目录暂时读不到」被误报成「这个渠道没账号」。
      probeModel = await firstModelIdOf(provider) ?? ''
      // ⚠️⚠️ **取全部启用账号，而不是一个代表账号**（真实缺陷，用户报障 2026-10-07）。
      //
      // 用户质疑：「workbuddy 中一个号是 1 天到期，为什么我们统计是 2000 多天，
      // **只用了第一个账号吗**？」—— 他猜对了。旧实现走 `getAvailableAccount`，
      // 那个方法只返回**手动序第一个**可用账号 ⇒ 用户把「1 天到期」的号拖到后面时，
      // 它的临期额度在**排序**里被完全忽略：这个渠道明明有一个快作废的号，
      // 却被按「2000 多天后才作废」排到最后。
      //
      // ⇒ 改为取**全部**账号，逐个折算，取**最早**的那个（见下方 `earliest`）。
      //   ⚠️ 这不改变「实际发请求用哪个账号」（那仍由适配器按手动顺序选），
      //   只改变「这个渠道整体的临期额度何时作废」这个**观测**口径。
      //
      // ⚠️ **`listAvailableCredentials` 是可选方法**（结构化类型）：它不存在时回退到
      //    `getAvailableAccount`（只探一个代表账号）。回退不是为了兼容老装配 ——
      //    真实装配（`src/index.ts`）永远传完整的 `AccountPool`；回退是为了让
      //    **既有测试桩**（只实现 `getAvailableAccount`）仍然可用，尤其是
      //    `auto-adapter.spec.ts` —— 那份 spec 是**硬约束：必须零改动且全绿**
      //   （它是两处「搬移而非复制」重构的安全网）。
      //    ⚠️ 回退路径的语义是**降级**（少看几个账号），不是错误。
      //
      // ⚠️⚠️ **取号必须传空 `modelId`（跳过「按模型」过滤）** ——
      //    真实缺陷（本机实测 2026-10-12）：原先传的是 `probeModel`，
      //    而那会让本函数陷入**死锁**、且**整个渠道**从候选里消失：
      //
      // | 步骤 | 发生了什么 |
      // |---|---|
      // | ① | `probeModel = firstModelIdOf(provider)` = 目录**第一个**模型 |
      // | ② | 某次折算把「该模型已尽」写进 `modelRateLimits[probeModel]` |
      // | ③ | 下次折算取号 `listAvailableCredentials(provider, probeModel)` **按模型过滤** ⇒ 账号被筛空 |
      // | ④ | `credentials.length === 0` ⇒ 返回 `UNUSABLE` ⇒ **折算根本没跑** |
      // | ⑤ | 于是既清不掉标记、也写不了新标记 ⇒ 标记挂到次日 0 点 |
      // | ⑥ | **整个 zcode 渠道**在这期间对 auto / aggregate 不可见 |
      //
      // ⚠️ 实测（`scripts/verify-zcode-mark-self-heal.mjs`）：
      //    zcode 兜底目录顺序为 `[GLM-5.3-Flash, GLM-5.3]` ⇒ 只要
      //    **被标记的是 `GLM-5.3-Flash`**（用户实际一直在用的那个模型，
      //    真实会话日志 1359 次）就命中死锁。不是边角情形。
      //
      // ⇒ **折算问的是「这个渠道整体最早何时作废」，与「哪个模型」无关**
      //   （判据只看各账号的资源包 / 余额到期时刻）。按模型过滤在这里
      //   既**多余**（2026-10-07 起，派发前已由 `hasUsableAccountFor` /
      //   `filterByModelAvailability` 按**真实模型**复核），又**有害**（上面的死锁）。
      //   ⇒ 空串正是本仓库「不按模型过滤」的既有语义
      //   （`getAvailableAccount` / `listAvailableCredentials` 对空 `modelId`
      //    都有专门注释：跳过限流过滤、保持候选不变）。
      //
      // ⚠️ 这条也修正了**代码与注释的矛盾**：上面那句「取**全部**账号」
      //    在原实现里并没有真的做到（被 `probeModel` 过滤掉了一部分）。
      credentials = typeof pool.listAvailableCredentials === 'function'
        ? await pool.listAvailableCredentials(provider, '')
        : // ⚠️ **回退路径刻意保留 `probeModel`**（与本函数主路径不同，理由如下）：
          //    ① 它只对**测试桩**可达（生产装配的 `AccountPool` 永远有
          //       `listAvailableCredentials`）；
          //    ② `auto-adapter.spec.ts` 有一条**明确禁止空 modelId** 的用例
          //       （「取代表账号时不得用空 modelId（会让限流过滤整体短路）」）——
          //       它守的是**另一个真实缺陷**（空 modelId 让账号池的限流过滤整体失效，
          //       于是 auto 会把请求发给一个正在限流的账号）。
          //    ⚠️ 残余风险**如实登记**：这条路径同样具备上面的死锁形态
          //       （`getAvailableAccount` 也按模型过滤）。它当前不可达，
          //       故不改它 —— 改它会与那条既有用例冲突，而那条用例守的缺陷
          //       在生产上是**可达**的（主路径传空串不影响它，因为主路径
          //       取的是全部账号、不经 `getAvailableAccount`）。
          (await legacySingleCredential(pool, provider, probeModel)).map((credential) => ({
            entry: { id: undefined as string | undefined },
            credential,
          }))
    } catch (error) {
      // ⚠️⚠️ **中止不得被吞成 `UNUSABLE`**（Global Constraints 的硬要求）。
      //
      // 为什么需要这两行：本 `try` 里有两个可能抛错的调用 —— `firstModelIdOf`
      // （装配层注入，会读渠道目录）与账号池查询。任一在**探测途中被取消**时抛出的
      // `AbortError` 若被直接折算成 `UNUSABLE`，用户取消请求后看到的是
      // 「没有任何可用候选」而不是中止（误导性报错），且与「真的没登录」无法区分。
      // 与本仓库既有口径相反：`aggregate-core.ts` 的哨兵注释
      //「abort **立刻抛 `AbortError`**，绝不折算成 `UNUSABLE`」。
      //
      // ⚠️ 两行都要，覆盖两种情形（Task 7 复审 M1/M2 订正）：
      // - `throwIfAborted()` 覆盖「signal **已被标记**」——**这是当前生产装配下
      //   实际生效的那条**；
      // - `isAbortError(error)` 覆盖「signal 未必标记、但抛出的就是 AbortError」。
      //   ⚠️ 实测（Task 7 复审 M2）：当前装配的 `firstModelIdOf` 是
      //   `ctx.llm.listModels(provider)`，而 **`LlmRuntime.listModels` 只接受
      //   provider 一个参数、没有 signal 通道**（`dsh-llm/lib/index.js:1471`）
      //   ⇒ 这一条在当前装配下不可达，是**防御性**的（装配层若改成会响应 signal
      //   的取号方式，它就生效）。
      signal?.throwIfAborted()
      if (isAbortError(error)) throw error
      return UNUSABLE
    }
    // ⚠️ 一个可用账号都没有 ⇒ UNUSABLE（「这个渠道现在不能用」）。
    //    注意与「账号可用但读不到到期时间」严格区分 —— 后者由各 `*Expiry` 返回
    //    `NEVER`（可用、只是不临期），绝不能在这里一并判成不可用。
    if (credentials.length === 0) return cacheAndReturn(provider, UNUSABLE, startedAt)
    // ⚠️ 逐个账号折算，取**最早**的到期时刻（用户选定：探全部账号、取最早）。
    //    任一个账号折算失败不影响其余（跳过它）—— 一个坏账号不该让整个渠道被剔除。
    let earliest = NEVER
    // ⚠️⚠️ **必须记录「是否有任何一个账号折算成功」**（真实缺陷，独立审计实测证伪）。
    //
    // 旧实现只看 `earliest` 的终值：若**所有**账号都折算失败（每个都 `continue`），
    // `earliest` 仍是初值 `NEVER` ⇒ 该渠道被判「**可用**、只是不临期」⇒ **进入排序
    // 且可当选**（`rankCandidates` 只剔除 `UNUSABLE`）。
    //
    // 而「所有账号都查不到额度」= 我们对这个渠道**一无所知** ⇒ 必须 `UNUSABLE`（剔除）。
    // 这与本模块头的铁律**直接矛盾**：「未接入 = `UNUSABLE` = 剔除。**宁可少一个候选，
    // 不可把未知当可用。**」
    //
    // 实测场景：buddy 有两个已登录账号、上游余额接口 5xx（或 token 全过期）⇒
    // 旧实现让该渠道进入排序，请求被发到一个额度未知（可能已用尽）的渠道。
    // 且该错误值还会被缓存 60 秒。
    let anyConverted = false
    /**
     * ★ 该渠道的**全部目录模型 id**（zcode 的按模型判定用，2026-10-12）。
     *
     * ⚠️ **惰性求值**：只在实现方真的声明需要它时才去读目录
     * （省下其余 6 家每轮一次多余的目录读取）。
     * ⚠️ 未注入 `catalogIdsOf` 时退回「只有 probeModel 一个」——
     * 让既有装配与几十处测试桩零改动即可工作（只是判定范围窄一个模型）。
     */
    let catalogIdsCache: readonly string[] | undefined
    const catalogIds = async (): Promise<readonly string[]> => {
      if (catalogIdsCache !== undefined) return catalogIdsCache
      try {
        const ids = await options.catalogIdsOf?.(provider)
        catalogIdsCache = ids !== undefined && ids.length > 0
          ? ids
          // ⚠️ 未注入 `catalogIdsOf`（既有装配 / 几十处测试桩）时退回
          //    「只有 probeModel 一个」—— 判定范围窄一个模型，但**零改动可用**。
          //    ⚠️ `probeModel` 为空串时给**空数组**：空数组会让 zcode 的
          //    `exhaustedModelsOf` 一个模型都不判（**保守方向**：不写任何标记），
          //    而填 `['']` 会写一个键为空串的垃圾标记。
          : (probeModel.length > 0 ? [probeModel] : [])
      } catch {
        // ⚠️ 目录读失败**不得**让折算失败：退回 probeModel 一个（判定范围变窄，
        //    但折算值本身照常）。与 `firstModelIdOf` 的降级同一取向。
        catalogIdsCache = probeModel.length > 0 ? [probeModel] : []
      }
      return catalogIdsCache
    }
    const markModelsExhausted = pool.markModelsExhaustedForExpiry?.bind(pool)
    const clearModelsExhausted = pool.clearModelsExhaustedForExpiry?.bind(pool)
    /**
     * 共享余额读数入口（装配层注入；未注入 ⇒ 全部实现方走自己的回落路径）。
     *
     * ⚠️ 签名里的 `credential` 是**本次折算的那个账号的凭据**：缓存按
     * `(provider, accountId)` 去重，而**取数原语需要凭据** ⇒ 由本层把两者配对后
     * 传给缓存（`balanceCache.readOne`）。
     * ⚠️ 不注入时**不传**该字段（而不是传一个恒 `undefined` 的函数）：
     * 后者会让实现方白走一次「查缓存 → 未命中」的分支（行为相同，但多一层间接）。
     */
    const cachedBalanceOf = options.balanceOf
    // ⚠️ 必须走归一化：初版直接 `?? EXPIRY_PROBE_BUDGET_MS`，于是 `Infinity`
    //    （最像「不封顶」的写法）会让 `setTimeout` 溢出被钳成 1 ms ⇒ 全部渠道瞬间
    //    UNUSABLE。判据与后果见 `normalizeExpiryProbeBudget` 的表。
    const budgetMs = normalizeExpiryProbeBudget(options.budgetMs ?? EXPIRY_PROBE_BUDGET_MS)
    /**
     * 把一次「单账号折算」限制在给定预算内。
     *
     * ⚠️ **超时返回哨兵值而不是抛错**：这不是调用方中止，而是我们自己的预算用完。
     * 抛 `AbortError` 会被上层误判成「用户取消」并冒泡成 `MISSING_CREDENTIAL`；
     * 返回 `UNUSABLE` 才符合「本轮剔除该账号」的语义。
     *
     * ⚠️ **`signal` 是第三个竞争者**（2026-10-22 审计补）。`credentialExpiry` 的
     * 签名里**没有** `signal`，各 `*Expiry` 用的是自己的 `AbortSignal.timeout(30_000)`
     * ⇒ 折算层唯一的 abort 防线是循环顶部的 `throwIfAborted()` 与 catch 里的两条，
     * 而**取消发生在 await 期间时它们全都看不到**。实测（`budgetMs: 0`，即升级前
     * 语义，取消于 100 ms）：仍等满 1.5 秒才返回 `UNUSABLE`，并把它**缓存 60 秒**
     * ⇒ 用户取消一次，该渠道对路由消失 60 秒，且报错是「请先登录」式的误导。
     * 这是**既有缺陷**（非本次改动引入），但修它正好落在本函数里，故顺手补上。
     *
     * ⚠️ 超时**不取消**在途的 fetch（各 `*Expiry` 内部自带自己的超时信号，
     * 它们会在自己的超时后结束）。这里只是**不再等它** —— 让它自然结束，
     * 避免把上游连接强行掐断引发重试风暴。
     *
     * ⚠️ **`Promise.race` 会订阅全部竞争者**，故落败者的 reject 不会变成
     * `unhandledRejection`（实测确认）。但**早退分支**（`budgetMs === 0`）只
     * `await task`、不订阅别的 —— 那里必须靠 `task` 自己，别把它改成
     * 「先建 race 再早退」（那会留下一个没人订阅的 promise）。
     *
     * ⚠️ 计时器**不能 `unref()`**（实测踩到）：调用方正 `await` 这次折算，
     * 若计时器不保持进程活跃，Node 会判定「没有待办」直接退出 ——
     * 独立验证时进程以 `Warning: Detected unsettled top-level await` 静默结束。
     * 这与后台写盘的 `unref` 场景不同：这里的计时器是**前台等待**的一部分。
     *
     * @param budgetForThisAccount - 该账号可用的毫秒数（**已按剩余账号数均分**，
     *   见循环处的 `perAccountMs`）；`budgetMs === 0` 时不封顶。
     */
    const withinBudget = async <T>(
      budgetForThisAccount: number,
      task: Promise<T>,
      signal?: AbortSignal,
    ): Promise<T | typeof UNUSABLE> => {
      if (budgetMs === 0) return await task
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      /** 与 `timeout` 同一个哨兵：谁先胜出都只是「不再等」。 */
      const timeout = new Promise<typeof UNUSABLE>((resolve) => {
        timer = setTimeout(() => resolve(UNUSABLE), budgetForThisAccount)
      })
      /**
       * 中止竞争者：**抛** `AbortError`（不是 resolve 哨兵）—— 中止必须原样逃逸，
       * 与循环顶部 `signal?.throwIfAborted()` 同一口径。
       */
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal === undefined) return
        if (signal.aborted) {
          reject(abortErrorOf(signal))
          return
        }
        onAbort = () => reject(abortErrorOf(signal))
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        return await Promise.race([task, timeout, aborted])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
        // ⚠️ `aborted` 若从未胜出（正常路径），它内部登记的 listener 已被摘掉；
        //    而 `Promise.race` 已订阅它 ⇒ 不会有未处理的 rejection。
        //    但若 `signal` 已 aborted 且 `reject` 已发生、race 又先被 task 胜出，
        //    那个 rejection 仍被 race 消费（实测无 unhandledRejection）。
      }
    }
    // ⚠️ **本渠道的预算起点**（见 `EXPIRY_PROBE_BUDGET_MS` 的长注释）。
    const deadline = budgetMs === 0 ? Number.POSITIVE_INFINITY : now() + budgetMs
    for (let index = 0; index < credentials.length; index += 1) {
      const item = credentials[index] as (typeof credentials)[number]
      signal?.throwIfAborted()
      /**
       * ⚠️⚠️ **预算按「剩余账号数」均分，且**双重封顶**（2026-10-22 审计打穿后改）。
       *
       * ## 初版为什么错
       *
       * 初版把整个剩余预算交给当前账号、耗尽就 `break`。实测后果（真实报文形状）：
       * 第 1 号 12 秒后才失败、第 2 号 100 ms 就能成功 ⇒
       *   `budgetMs: 0` → 真实到期时刻（渠道可用）
       *   默认 8 秒    → `UNUSABLE`（渠道被判死，第 2 号**一次都没被问**）
       * 而 `listAvailableCredentials` 的顺序 = `readAccounts()` 的**固定顺序**（无轮转）
       * ⇒ 只要「首号」稳定慢于 8 秒，**每一轮**都是同一个首号、每一轮都 `UNUSABLE`
       * ⇒ 再被 `cacheAndReturn` 缓存 60 秒 ⇒ 该渠道在聚合轮换里**永久不可见**。
       * 这正是本常量上一版注释自称要避免的那件事。
       *
       * ## 现在的口径：`min(剩余预算, max(下限, 均分))`
       *
       * | 项 | 作用 |
       * |---|---|
       * | `均分` = 剩余 ÷ 剩余账号数 | 让**每个账号都有机会**，且快账号省下的预算自动滚给后面的 |
       * | `下限` = {@link EXPIRY_PROBE_MIN_SLICE_MS} | 账号多时均分会小到不可用（8 s ÷ 31 = 258 ms < 正常渠道的 350 ms~1.2 s）⇒ 没它会把「账号多」直接变成「全被截断」 |
       * | **`min(剩余预算, …)`** | **总时长硬上界** —— 下限**不得**透支预算 |
       *
       * ⚠️ 第三项是**必须**的（我第一版漏了它，实测 31 个账号全挂时跑了 **46.8 秒**
       * = 31 × 下限）：没有 `min`，下限会在预算耗尽后继续续命 ⇒ 预算形同虚设。
       * 现在 31 个账号全挂 ≈ 5 × 1500 + 500 = **8 秒**（有界），且**前 6 个账号都
       * 拿到了一次机会**（不是只有首号）。
       *
       * ## 已知代价（如实登记）
       *
       * 账号数超过 `预算 ÷ 下限`（默认 8 s ÷ 1.5 s ≈ 5 个）时，**靠后的账号本轮探不到**
       * ⇒ 若它们里有更早到期的那个，本轮返回的是**偏乐观**的到期时刻。
       * 这与「未探完 ⇒ 保守 ⇒ UNUSABLE」的铁律**不冲突**：铁律管的是「一个都没成」，
       * 这里已有一个成 ⇒ 渠道可用的**结论**是真的，只是排序值可能偏乐观。
       * ⇒ 真要根治得让起点**轮转**（每轮从不同账号开始），那是独立改动，不在本处。
       */
      const remainingAccounts = credentials.length - index
      const remaining = deadline - now()
      // ⚠️ 预算真的用完了才停（`budgetMs === 0` 时 `remaining` 恒 Infinity，不会命中）。
      if (budgetMs !== 0 && remaining <= 0) break
      const perAccountMs = expiryProbeSliceMs(budgetMs, remaining, remainingAccounts)
      const credential = item.credential
      let value
      try {
        /**
         * ⚠️ `context` 对**另外 6 家**是纯粹的多余参数（它们忽略第二参）——
         * 这不是「只为 zcode 开洞」，而是本仓库既有的「可选能力由实现自己声明」
         * 模式（同 `ExpiryAccessors.refreshableOf` 的可选语义）。
         *
         * ⚠️ `catalogIds` 在这里**不求值**（传的是个函数）：只有 zcode 会调它，
         * 其余 6 家每轮因此**零额外目录读取**（那是本仓库反复强调的成本）。
         */
        value = await withinBudget(perAccountMs, credentialExpiry(provider, credential, {
          ...item.entry.id === undefined ? {} : { accountId: item.entry.id },
          // ⚠️ officeace 的余额查询**必须**拿到 ref 才走云侧直读（见该字段注释）；
          //    其余家忽略它。
          ...item.entry.credentialRef === undefined || item.entry.credentialRef.length === 0
            ? {}
            : { credentialRef: item.entry.credentialRef },
          catalogIds,
          ...markModelsExhausted === undefined ? {} : { markModelsExhausted },
          ...clearModelsExhausted === undefined ? {} : { clearModelsExhausted },
          // ⚠️ 共享读数入口（2026-10-15，规格 §5.7）：只对**声明了它**的渠道生效 ——
          //    buddy 系四家吃同一份读数，其余家忽略（与本上下文里 `catalogIds`
          //    同一模式：可选能力由实现自己声明）。
          //    ⚠️ 只在装配层真的注入了缓存时给（`options.balanceOf`），否则**不传**
          //    ⇒ 实现方走自己的回落路径（那正是「未接线 = 行为不变」）。
          ...cachedBalanceOf === undefined || item.entry.id === undefined
            ? {}
            : {
                cachedBalance: () => cachedBalanceOf(provider, item.entry.id as string, credential),
              },
        }), signal)
      } catch (error) {
        // 中止仍必须逃逸（与上面的 `try` 同一口径）。
        signal?.throwIfAborted()
        if (isAbortError(error)) throw error
        continue
      }
      if (value === UNUSABLE) continue
      // ⚠️ 走到这里 = 该账号**折算成功**（拿到一个真实到期时刻或 `NEVER`）。
      //    两者都算「成功」：`NEVER` 的语义是「可用、但无临期额度」（如 codearts
      //    的长期积分），它是**已知事实**，与「查不到」严格不同。
      anyConverted = true
      if (value < earliest) earliest = value
    }
    // ⚠️ 一个都没成功 ⇒ 未知 ⇒ 剔除（不是 NEVER）。
    if (!anyConverted) return cacheAndReturn(provider, UNUSABLE, startedAt)
    // ⚠️ **部分观测也要如实登记**：走到这里可能是「探完全部账号」，也可能是
    //    「每个账号各吃满自己那份均分预算」。返回的是**已观测到的最小值**，
    //    不声称它是全量最小值（真实代价：某个排得靠后的账号若更早到期，本轮看不到）。
    //    这与「一个都没成 ⇒ UNUSABLE」是**两个不同结论**，不要合并。
    return cacheAndReturn(provider, earliest, startedAt)
    },
    /**
     * 清空折算缓存（**账号变化时调用**，见 `src/index.ts` 的装配）。
     *
     * ## ⚠️⚠️ 为什么必须提供它（真实缺陷，对抗审计实测证伪）
     *
     * 缓存**原先没有任何失效通道**（`account-pool` 不碰它、也没暴露清理入口）
     * ⇒ 「**刚登录**（或限流刚解禁）」的账号在**最长 60 秒内对路由不可见**。
     * 用户此时请求拿到的是：
     *   `MISSING_CREDENTIAL | 「xxx」当前没有任何可用候选（渠道被关闭、模型被关、
     *    或所有渠道都无可用账号）`
     * —— 正是设计文档 §9.2.1 明确要避免的误导性报错（用户明明刚登录成功）。
     *
     * ⚠️ `UNUSABLE` **也被缓存**（一个渠道「现在没账号」60 秒内不会变；不缓存会让
     * 面板与排序每次白跑一遍取号 + 目录读取），所以刚登录后的那一格**必须显式清掉**。
     */
    { clear: (): void => { cache.clear(); generation += 1 } },
  )
}

/**
 * 单账号回退：`listAvailableCredentials` 不存在时只取一个代表账号。
 *
 * ⚠️ 这是**降级路径**（少看几个账号），只为让既有测试桩可用 —— 见调用点的长注释。
 * 真实装配（`AccountPool`）永远有 `listAvailableCredentials`。
 */
async function legacySingleCredential(
  pool: AccountPool,
  provider: string,
  probeModel: string,
): Promise<unknown[]> {
  const available = await pool.getAvailableAccount(provider, probeModel)
  if (available === null || available === undefined) return []
  return [available.credential]
}

/**
 * 单个账号的临期折算（**按 provider 查能力注册表**）。
 *
 * ⚠️ 从 `createExpiryProbe` 里抽出来，是为了让「探全部账号」的循环保持简单，
 * 且**判据仍然只有一处**（不复制分派）。
 *
 * ## ⚠️ 2026-10-08 改：原先是一个 7-case `switch`
 *
 * 那个 `switch` 的**每个分支体都只是「调一个原语」**
 *（`buddyExpiry` / `loomyExpiry` / `codeArtsExpiry` / `zcodeExpiry` /
 * `lobsteraiExpiry` / `traeExpiry`），只有原语名与参数不同 —— 与
 * `account.refresh` 的 13 个同构 case 完全同型。现在「**选哪个**原语」由
 * 能力注册表回答（设计文档 §3.5.3）。
 *
 * ⚠️ **各家原语函数原样保留** —— 它们是**真实差异**（判据不同、量纲不同：
 * loomy 是命名池、codearts 无到期概念、zcode 分桶按秒、buddy 系按资源包）。
 * 本函数只负责「选哪个」，**不**抽象「原语内部做什么」（§3.6 的边界）。
 *
 * ⚠️ 层次方向：本模块**只**能依赖底座（见模块头）。`provider-runtime.ts` 不
 * import 本文件、也不 import 聚合适配器，故无环 —— 但**别**在这里 import
 * `aggregate-adapter.ts`。
 *
 * @returns 毫秒时间戳（越小越早作废）／`NEVER`（长期）／`UNUSABLE`（查不到）
 */
async function credentialExpiry(
  provider: string,
  credential: unknown,
  context?: ProviderExpiryContext,
): Promise<number> {
  const runtime = runtimeOf(provider)
  if (runtime?.expiry === undefined) {
    // ⚠️ 未接入 ⇒ `UNUSABLE`（**不是** NEVER）：返回 NEVER 会让一个我们对其
    //    一无所知的渠道被排在候选**最前**并当选 —— 而它可能压根没有可用账号。
    //    这与模块头的铁律同一条：「宁可少一个候选，不可把未知当可用」。
    //
    // ⚠️⚠️ 本分支**只对「清单内但 runtime 缺 `expiry` 域」的渠道可达**：
    //    清单外的渠道在更早的「未接入」短路处就返回了。生产装配下这个组合被
    //    `expiry-runtime-parity.spec.ts` 的不变式一挡住（清单 == runtime 里挂了
    //    `expiry` 域的集合）⇒ 它是**防御性**的，锁的是「有人删了某家的注册、
    //    却没同步改清单」这一类漂移。
    //    ⚠️ 但它**不是**同义反复：`expiry-runtime-parity.spec.ts` 有一条
    //    **行为**用例专门只注册 descriptor、不挂 `expiry` 域，断言这里回
    //    `UNUSABLE` —— 把本行的 `UNUSABLE` 改成 `NEVER` 会让它变红并点名
    //    （独立复审实测：此前该分支**零覆盖**，改坏了没有任何用例会红）。
    //
    // ⚠️ 这里**刻意不打日志**（2026-10-08 决定）：本函数在候选排序里**每个渠道
    //    调一次**，而模块内**没有** logger（`createExpiryProbe` 只收
    //    `pool` / `firstModelIdOf` / `options`，没有 `ctx`）—— 为一条被断言锁住的
    //    防御性分支去穿一条 logger 通道，会把日志出口变成这个纯底座模块的新依赖。
    //    真正的防线是上面那条不变式断言（真跑 `apply()`，漏注册一家即红并点名），
    //    以及 `src/index.ts` 注册失败时已有的 info 日志。
    return UNUSABLE
  }
  return runtime.expiry.credentialExpiry(credential, context)
}

/**
 * 该错误是否是「调用方中止」类。
 *
 * ⚠️ **就地实现，不从 `aggregate-adapter.ts` 导入**：那会让本模块反向依赖上层的
 * 聚合适配器，正是本任务要避免的层次颠倒（见模块头）。判据与 `aggregate-adapter.ts`
 * 的 `isAbortLike` 一致，只取「错误自身携带 AbortError 标记」这一条 ——
 * `signal` 侧的情形由调用点的 `signal?.throwIfAborted()` 覆盖。
 */
function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  return (error as { name?: unknown }).name === 'AbortError'
}

/**
 * 造一个 `AbortError`（供「预算等待期间被取消」那条腿用）。
 *
 * ⚠️ 为什么需要它：`signal.throwIfAborted()` 抛的是**平台自带的** `DOMException`
 * / `AbortError`，而 `withinBudget` 的 abort 竞争者要自己造一个。两者必须**同类**
 * ——`isAbortError` 只认 `name === 'AbortError'`，造错了（例如 `new Error()` 后忘了
 * 改名）会让中止被上层 `catch` 吞成 `UNUSABLE`，正是本文件反复修的形态。
 *
 * ⚠️ 优先用 `signal.reason`：取消方可能带了自定义 reason（如上层传了 `DOMException`），
 * 原样透传比自造更贴近「中止原样逃逸」的铁律。但只在它**确实是中止类**时才用
 *（自定义 reason 可能是任意值，把它当 AbortError 抛会让 `isAbortError` 判假）。
 */
function abortErrorOf(signal: AbortSignal): unknown {
  const reason = signal.reason as unknown
  if (reason !== null && typeof reason === 'object'
    && (reason as { name?: unknown }).name === 'AbortError') {
    return reason
  }
  if (typeof DOMException === 'function') return new DOMException('This operation was aborted', 'AbortError')
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

/** buddy 系：有效资源包 `deductionEndTime` 的最小值；无有效包 → NEVER。 */
export async function buddyExpiry(
  product: typeof CODEBUDDY,
  credential: BuddyCredential,
  /**
   * 共享读数入口（2026-10-15，规格 §5.7 的「buddy 系四家吃同一份读数」）。
   *
   * ⚠️ 返回 `undefined` ⇒ **回落到自己发请求**（`fetchCreditBalance`）。
   *    折算的可用性**不得**依赖它 —— 否则「未接线」会变成「该渠道折算恒 UNUSABLE」
   *（静默少一个候选，本仓库复发过三次的形态）。
   */
  cached?: () => Promise<CreditBalance | null | undefined>,
): Promise<number> {
  return sharedPackageExpiry(() => fetchBalanceWithCache(
    cached,
    () => fetchCreditBalance(credential, product),
  ))
}

/**
 * 「优先吃共享读数、缺席则自己取」的**唯一一份**实现（buddy 系四家共用）。
 *
 * ⚠️⚠️ **必须共享**：四家各写一遍这个「先看缓存、没有就自己发请求」的分支，
 * 任何一侧漏掉回落（或回落时用错原语）都会**静默分叉** —— 正是
 * `sharedPackageExpiry` 那条注释记录的事故类型（`classifyRaccoonFailure` 与
 * `classifyLoomyFailure` 的四格判据不一致）。
 *
 * ⚠️ 缓存命中的**证明责任在缓存**（`src/balance-cache.ts`）：`undefined` 严格表示
 * 「本次没有共享读数」，与「读数是 `null`（查询失败）」是两件事 ——
 * 后者要按既有口径折算成 `UNUSABLE`（`sharedPackageExpiry` 对 `null` 的处理）。
 */
async function fetchBalanceWithCache(
  cached: (() => Promise<CreditBalance | null | undefined>) | undefined,
  fallback: () => Promise<CreditBalance | null>,
): Promise<CreditBalance | null> {
  if (cached !== undefined) {
    const shared = await cached()
    // ⚠️ 只认**非 undefined**：`null` 是「共享读数说查询失败」，那是**结论**，
    //    不该转头再自己发一次请求（那会让「失败」变成双倍上游请求）。
    if (shared !== undefined) return shared
  }
  return await fallback()
}

/**
 * **共享的「有效资源包最早到期」折算**（buddy / workbuddy / lobsterai / trae 同形）。
 *
 * ## ⚠️ 为什么必须共享而不是各写一份（AGENTS.md 的「同族判据必须逐格同构」）
 *
 * 这四家的 `CreditPackage` **结构相同**（都有 `active` / `remaining` /
 * `deductionEndTime`），差别只在**怎么取到那个 `CreditBalance`**（各自的端点与凭据）。
 * 各写一份的话，任何一侧收窄（如「只算 `active` 且 `remaining > 0` 的包」）都会
 * 在另一侧**静默分叉** —— 本仓库已因这类分叉发生过真实事故
 *（`classifyRaccoonFailure` 与 `classifyLoomyFailure` 四格判据不一致，
 * 危险方向恒定朝一侧：多写 24h 冷却 ⇒ 整池被封一天）。
 *
 * ⇒ 判据只写在这里一份，各渠道只提供「怎么取余额」。
 *
 * ## 判据
 *
 * 取 `active === true` 且 `remaining > 0` 的包里 `deductionEndTime` 的**最小值**；
 * 一个都没有 ⇒ `NEVER`（长期：排最后但不剔除）。
 *
 * ⚠️ **无到期时间 ⇒ `NEVER`，不是 `UNUSABLE`**：包是有效的，只是不下发到期时间
 *（实测 lobsterai 的 `expiresAt` 可为空串）⇒ 剔除它会丢掉一个可用渠道。
 * 与 `codeArtsExpiry` 的「读不到就不猜」同一条原则。
 *
 * ## ⚠️⚠️ 「余额为 0」与「无有效包」必须一并剔除（真实缺陷，已修 2026-10-07）
 *
 * `earliest` 的初值是 `NEVER`，而只有 `remaining > 0` 才可能更新它 —— 若遍历完
 * 直接 `return earliest`，下面几种形态**都**返回 `NEVER`（= 可当选）：
 *
 * | 形态 | 旧返回 | 现在 |
 * |---|---|---|
 * | 有效包 `remaining > 0`、有 `deductionEndTime` | 该时刻 | 该时刻（不变） |
 * | 有效包 `remaining > 0`、**无**到期时间（永久积分） | `NEVER` | `NEVER`（**保留**：确实有额度） |
 * | **有效包但 `remaining = 0`（余额已尽）** | `NEVER` ❌ | **`UNUSABLE`** |
 * | **只有失效包 / `Accounts: []`** | `NEVER` ❌ | **`UNUSABLE`** |
 *
 * ⇒ 旧实现下，一个**余额已耗尽**的 buddy / workbuddy / lobsterai / trae 仍会被
 * auto 选中，请求随即以 `QUOTA_EXCEEDED` 失败 —— **与 PR #81 报障完全同型**，
 * 且 buddy / workbuddy 都在 `AUTO_PROVIDERS`（`auto-adapter.ts`）里。
 *
 * ⚠️ 本仓库对「余额为 0」早有明确判据，旧实现与它**矛盾**：
 * `buddy-balance-rank.ts` 的 `buddyBalanceTier` 在余额全为 0 时返回
 * `BUDDY_BALANCE_TIER.none`，而 `buddyTierUsable` 明写
 * **`none` 档不可用**。选号器判「不可用」、折算层判「可当选」= 同一语义两套判据
 *（AGENTS.md 首条红线）⇒ 现在两侧**同构**。
 *
 * ## ⚠️ 为什么「有余额但无到期时间」仍必须是 `NEVER`（别一刀切成 UNUSABLE）
 *
 * 实测 lobsterai 的 `expiresAt` 可为**空串**、buddy 的永久积分包也可能不下发
 * `DeductionEndTime`。这类包**确实有额度**（`remaining > 0`），剔除它会丢掉一个
 * 可用渠道。故判据是「**有没有任何一个 `active && remaining > 0` 的包**」，
 * 而不是「有没有带到期时间的包」。
 *
 * ⚠️ 与 `zcodeExpiry` 的收窄是**同一手法**（「已拥有的余额 > 0」才可用；
 * 否则 `UNUSABLE`），两处口径一致 —— 别再让一家修好、另一家漏掉。
 *
 * ⚠️ 与 `buddy-balance-selector.ts` 那句「解锁时所有候选余额都是 0 仍返回
 * 第一个候选，让上游去报真正的失败原因」**不矛盾**：那句讲的是 **provider 内部**
 * 的选号（用户已指定该渠道，此时换号才有意义），本函数讲的是**跨渠道选型**
 * （余额 0 就该让给别的渠道，而不是把请求发过去必然失败）。
 *
 * @param fetchBalance - 取余额的函数；返回 `null` 表示查询失败 ⇒ `UNUSABLE`。
 */
async function sharedPackageExpiry(
  fetchBalance: () => Promise<CreditBalance | null>,
): Promise<number> {
  let balance
  try {
    balance = await fetchBalance()
  } catch (error) {
    /**
     * ⚠️⚠️ **中止必须原样逃逸**（铁律；这是同型缺陷在本文件的**第五处**）。
     *
     * ## 为什么必须修（2026-10-19，用户报障）
     *
     * 初版是**裸 `catch`** ⇒ 把 `AbortError` 也折算成 `UNUSABLE`。
     * 而 `UNUSABLE` 会被 `cacheAndReturn` **缓存 60 秒**（`EXPIRY_CACHE_TTL_MS`）
     * ⇒ **取消一次 = 该渠道对路由消失 60 秒**。
     *
     * 用户可见症状（真实会话日志，`aggregate: 「space-bunny」当前没有任何可用候选`）：
     * - `step/start 1792418663502` → `turn/end 1792418663505` ⇒ **3 毫秒、零网络**；
     * - 报错前一步是一次 **604 秒的 subagent 调用**（长任务被取消/超时）；
     * - 该虚拟模型**只有 buddy 一家候选**（无备胎）⇒ 候选一空就直接撞
     *   `candidatesFor() === []`（`src/aggregate-adapter.ts:1315`）；
     * - 60 秒后缓存过期 ⇒ 自愈 ⇒ 表现为「发消息继续就又能工作了」。
     *
     * ## 可达性：已实测，**如实标注**（别读成「生产已复现」）
     *
     * | 探针 | 结果 |
     * |---|---|
     * | `buddyExpiry` 的 `cached()` 抛 `AbortError` | **被吞成 `UNUSABLE`** ← 本修法修的接缝 |
     * | `balanceCache.readOne` 上游抛中止 | **原样上抛**（`src/balance-cache.ts:402`）⇒ 接缝已开口 |
     * | 真实 buddy 腿 `fetchCreditBalance` | `postJson` 把中止压成 `{ok:false}` ⇒ **该腿不抛中止** |
     *
     * ⇒ buddy 当前**不可达**；但共享缓存那条腿（上一行第二条）**已经会抛中止**，
     *  且 `src/index.ts:3273` 正是把 `readOne` 接到本函数的 `cached()` 上
     *  ⇒ 这是**接缝安全**，不是「已复现的故障」。旧注释预言的三种情形
     *  （某家改用 `fetchBalanceDetailed` / `postJson` 改为抛出 / 新增走
     *  `fetchBalanceWithCache` 的渠道）任一发生，这里就会立刻吃掉中止。
     *
     * ⚠️ **判据只认 `isAbortError`，不额外查 signal**：本函数**收不到 `signal`**
     *   （签名只有 `fetchBalance`，见 `@param`）。入口 signal 已标记的那种情形
     *   由 `createExpiryProbe` 的循环逐轮 `signal?.throwIfAborted()` 负责 ——
     *   与该文件 `zcodeExpiry` 分支的登记口径一致。
     *
     * ⚠️ 其余错误**仍折算成 `UNUSABLE`**（不改既有裁决）：
     *   `tests/unit/aggregate-expiry.spec.ts:802` 的「全部账号折算失败 ⇒ UNUSABLE」
     *   是**有意取舍**（「不能把『不知道』当『可用』」），本次**刻意不动**它。
     */
    if (isAbortError(error)) throw error
    return UNUSABLE
  }
  if (balance === null) return UNUSABLE
  let earliest = NEVER
  // ⚠️ 必须单独记「有没有任何可用余额」：`earliest` 的初值 `NEVER` 无法区分
  //    「一个有效包都没有」（⇒ 剔除）与「有余额但不下发到期时间」（⇒ 长期）。
  let hasAnyCredit = false
  for (const pkg of balance.packages) {
    if (pkg.active !== true) continue
    if (!(typeof pkg.remaining === 'number' && pkg.remaining > 0)) continue
    /**
     * ⚠️⚠️ **独立池不进折算**（2026-10-21 合并审计发现）。
     *
     * AStudio 的星火池是服务端下发的**独立池**（不参与主池合计、也不能当
     * 通用积分消耗）。若把它算进来：
     * ① `hasAnyCredit` 会因它为真 ⇒ 主池全空时也判「有余额」⇒ 账号**不被
     * 剔除** ⇒ 聚合把请求发给一个只有专属池的账号 ⇒ 上游按主池计费 ⇒ 失败；
     * ② `earliest` 会取**它**的到期时刻 ⇒ 星火池先过期时整个账号被判「马上
     * 作废」⇒ 聚合把它排到最前 ⇒ **提前烧掉主池的长期积分**。
     *
     * ⚠️ 判据与后端选号侧（`buddy-balance-rank.ts`）同源（同一份
     * `isExclusiveCreditPool`）⇒ 两侧口径一致。
     */
    if (isExclusiveCreditPool(pkg)) continue
    const end: unknown = pkg.deductionEndTime
    /**
     * ⚠️⚠️ **判据必须与 `src/buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry` 同一份**
     * （2026-11-01 四审）：那边已把 `deductionEndTime` 收窄成「**number 或数字字符串**」，
     * 而这里曾只认 `typeof === 'number'`。
     *
     * 后果（结构可达、生产零实测 —— 目前所有生产者都写 number）：外部写入
     * （`state.json` / 备份导入 / 旧缓存里的 `"1791072000000"`）会让**面板判「临期」**
     * 而**聚合轮换把它当「未知」= 长期、排到最后** ⇒ 用户看到的「马上到期」与
     * 自动选择顺序相反。这正是本仓红线「同一语义不得两套判据」。
     */
    const endIsNumeric = typeof end === 'number' || typeof end === 'string'
    const endMs = endIsNumeric ? Number(end) : Number.NaN
    /**
     * ⚠️⚠️ **已作废的额度不参与「可用额度」与排序**（2026-11-02，对抗审计 B1）。
     *
     * TRAE / Qoder 的 `active` 是**硬编码 true**，所以「`deductionEndTime` 已过、
     * `remaining > 0`」的包一定会出现。旧行为把它的**过去时刻**当 `earliest`
     * ⇒ 聚合按「越早到期越优先」把它排**第一** ⇒ 请求必失败，而同池里真正
     * 3 天后到期的渠道被排在后面。
     *
     * ⇒ 与 `buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry`（`endMs <= now`
     *   单列 `expired`、不计入 `expiring`）保持**同一判据**。
     *   只剩作废额度 ⇒ `hasAnyCredit` 保持 false ⇒ 本渠道判 `UNUSABLE`（钱已经没了）。
     */
    if (Number.isFinite(endMs) && endMs > 0) {
      if (endMs <= Date.now()) continue
      hasAnyCredit = true
      if (endMs < earliest) earliest = endMs
      continue
    }
    // 到期时间未知（无字段 / 脏值）⇒ 算「有余额但不知道什么时候过期」= 长期。
    hasAnyCredit = true
  }
  // 有余额但都没给到期时间 ⇒ 长期（排最后，不剔除）。
  if (hasAnyCredit) return earliest
  // ⚠️ 一个 `remaining > 0` 的有效包都没有 ⇒ 余额已尽 ⇒ **剔除**。
  //    「只有失效包」「`Accounts: []`」也走这里 —— 那同样是「这个渠道现在没有
  //    可烧的额度」，不该被 auto 选中（旧实现把它们一并返回 `NEVER`）。
  return UNUSABLE
}

/**
 * lobsterai：与 buddy **同形**（`CreditPackage.deductionEndTime` 由
 * `lobsterai-credits.ts` 从 ISO 8601 的 `expiresAt` 归一化而来）。
 *
 * ⚠️ 本渠道此前**不在** `WIRED_EXPIRY_PROVIDERS` 里，理由是
 * `auto-adapter.ts` 那句「其余 provider 没有跨账号的到期余额探测端点」——
 * **该理由对 lobsterai 不成立**（用户 2026-10-07 质疑后核实）。
 */
export async function lobsteraiExpiry(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  /** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
  cached?: () => Promise<CreditBalance | null | undefined>,
): Promise<number> {
  return sharedPackageExpiry(() => fetchBalanceWithCache(
    cached,
    () => fetchLobsteraiCreditBalance(credential, product),
  ))
}

/**
 * trae：与 buddy **同形**（`CreditPackage.deductionEndTime` 由
 * `trae-credits.ts` 从条目级秒级 `expire_time` 换算而来）。
 *
 * ⚠️ 同 lobsterai：此前被那句（不成立的）理由排除在白名单外。
 */
export async function traeExpiry(
  credential: TraeCredential,
  product: TraeProduct,
  /** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
  cached?: () => Promise<CreditBalance | null | undefined>,
): Promise<number> {
  return sharedPackageExpiry(() => fetchBalanceWithCache(
    cached,
    () => fetchTraeCreditBalance(credential, product),
  ))
}

/**
 * ModelScope（魔搭）：**本 fork 独有**（2026-10-17）。
 *
 * ## 它属哪一类
 *
 * 「**有余额但不下发到期时间**」那一类 —— 判据直接复用
 * {@link sharedPackageExpiry}（逐格同构，不另写一套）：
 *
 * - `balance.packages` 里存在 `active === true && remaining > 0` 的包
 *   ⇒ 返回 `NEVER`（**长期可用，排最后，不剔除**）；
 * - 一个都没有（`available_balance === 0`）⇒ 返回 `UNUSABLE`（**剔除**）。
 *
 * ⚠️ 魔搭的 `/openapi/v1/magicubes/balance` 报文里**没有任何时间字段**
 * （实测：`{"total_balance":277,"available_balance":277,"frozen_amount":0}`）
 * ⇒ 必然走「有余额但无到期时间」这条，落到 `NEVER`。
 *
 * ## ⚠️⚠️ 与其它家的**根本差异**：额度耗尽**不会被自动跳过**
 *
 * buddy 系能折算出临期时刻、从而在耗尽前把账号剔出轮换；魔搭**做不到** ——
 * 它既没有「配额何时重置」字段（每日发放是平台侧行为，实测报文字段里没有），
 * 也无法查询余额之外的东西（`/api/v1/quota/status` 经实测是**任务奖励**、
 * 不是额度，详见 `modelscope-credits.ts`）。
 *
 * ⇒ **魔粒烧光时，聚合仍会把它排进轮换候选**，用户选中后才失败一次
 * （报额度用尽）。这是**已知且刻意接受**的代价，由用户在 2026-10-17 明确选择
 * （选项 B）：宁可在极端情况下多失败一次，也要让魔粒充足时能进轮换。
 * ⚠️ **不许用「猜一个每日 UTC+8 零点」来消除这个代价** —— 那会凭空造出一个
 * 上游从未承诺的重置时刻（本仓库红线「绝不编造数字」）。
 *
 * ## ⚠️ 为什么**不**直接复用 `fetchTraeCreditBalance` 那套的 `fetchBalance`
 *
 * 本家走 `fetchBalanceDetailed`（三种失败的用户动作不同，见
 * `modelscope-credits.ts`）⇒ 这里必须吃 `balance: null` 的那一支，
 * **不是** `fetchBalance` 的 `null`。
 */
export async function modelscopeExpiry(
  credential: ModelscopeCredential,
  product: typeof MODELSCOPE,
  /** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
  cached?: () => Promise<CreditBalance | null | undefined>,
): Promise<number> {
  return sharedPackageExpiry(() => fetchBalanceWithCache(
    cached,
    async () => {
      const result = await fetchModelscopeBalanceDetailed(credential, product)
      // ⚠️ `fetchBalanceDetailed` 用 `balance: null + error` 表达失败
      //    （见 `ProviderBalanceDetail` 的注释），而 `sharedPackageExpiry`
      //    认的是「`null` ⇒ UNUSABLE」⇒ 取 `balance` 即可。
      return result.balance
    },
  ))
}

/**
 * AutoClaw（智谱）：**本 fork 独有**（2026-10-17 审计 P0 修复）。
 *
 * ## 它属哪一类
 *
 * 与 {@link modelscopeExpiry} **同格**：「**有余额但不下发到期时间**」——
 * `/agent-assetmgr/api/v2/wallets` 的 `wallets[]` 只有 `balance` /
 * `balance_view` / `priority` / `display`，**没有任何时间字段**
 * （见 `autoclaw-credits.ts` 的 `AutoclawWalletItem`）。
 * ⇒ 判据直接复用 `sharedPackageExpiry`（逐格同构，不另写一套）：
 * 有 `active === true && remaining > 0` 的包 ⇒ `NEVER`；一个都没有 ⇒ `UNUSABLE`。
 *
 * ## ⚠️⚠️ 已知且刻意接受的代价
 *
 * 积分烧光时**不会被提前剔出轮换** —— 平台既不下发「配额何时重置」，
 * 也没有别的额度端点可查 ⇒ 耗尽后仍会被选中并失败一次（报额度用尽）。
 * 与 modelscope 的代价**同型**（用户在 2026-10-17 已就魔搭明确接受这个取舍）。
 * ⚠️ **不许用「猜一个每日 UTC+8 零点」消除它** —— 那是凭空造一个上游从未
 * 承诺的重置时刻（本仓库红线「绝不编造数字」）。
 *
 * ## 为什么必须走 `cachedBalance`
 *
 * 聚合每轮折算会对同一账号反复提问；没有共享读数就会白发大量重复请求
 * （与 buddy / trae / modelscope 同款理由）。
 */
export async function autoclawExpiry(
  credential: AutoclawCredential,
  product: typeof AUTOCLAW,
  /** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
  cached?: () => Promise<CreditBalance | null | undefined>,
): Promise<number> {
  return sharedPackageExpiry(() => fetchBalanceWithCache(
    cached,
    async () => {
      const result = await fetchAutoclawBalanceDetailed(credential, { product })
      // ⚠️ 同上：`fetchBalanceDetailed` 的失败形态是 `balance: null + error`，
      //    `sharedPackageExpiry` 认「`null` ⇒ UNUSABLE」⇒ 只取 `balance`。
      return result.balance
    },
  ))
}

/**
 * MonkeyCode（国内站 `monkeycode` / 国际站 `monkeycodeintl`，**共用**本原语，
 * 只换 product）—— 2026-11-02 审查 B🟡-9 补齐。
 *
 * ## 判据（如实判「现在还有没有可烧的额度」，不编造任何时刻）
 *
 * `GET <platformBaseUrl>/api/v1/users/wallet` + `/api/v1/users/subscription`
 * （**cookie 认证**）⇒ `buildMonkeycodeBalance` 给两个包：
 *
 * - 「积分余额」（unit `credit`，`remaining = balance / 1000`）—— 可以是**负数**；
 * - 「每日额度」（unit `token`，`remaining = daily_token_balance`）。
 *
 * 两个包的 `remaining` 都实测会如实归零/为负（额度用尽那次：`daily 0`、
 * `balance -8191` 千分之一积分）⇒ 直接复用 `sharedPackageExpiry` 的
 * 「有 `active && remaining > 0` 的包 ⇒ `NEVER`；一个都没有 ⇒ `UNUSABLE`」。
 *
 * ## ⚠️ 与 `aggregate-expiry.ts` 里其它家最不同的一点：**缺会话直接放行**
 *
 * 余额接口只认网页登录态，而推理只要 `oma_` + `signing_secret` ⇒ 手填 Key 的
 * 账号**读不到余额但能发消息**。缺会话时若折算成 `UNUSABLE`，这些账号会被
 * **静默踢出聚合轮换**（把「不知道」当「不可用」）⇒ 这里按 `NEVER` 保守放行。
 * 代价与 modelscope / autoclaw **同型**：额度烧光后仍会被选中并失败一次。
 *
 * ## ⚠️ 为什么必须走 `cachedBalance`
 *
 * 聚合每轮折算会对同一账号反复提问；没有共享读数就会白发大量重复请求
 * （与 buddy / trae / modelscope / autoclaw 同款理由）。
 */
export async function monkeycodeExpiry(
  credential: MonkeycodeCredential,
  product: MonkeycodeProduct = MONKEYCODE,
  /** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
  cached?: () => Promise<CreditBalance | null | undefined>,
): Promise<number> {
  if (typeof credential.session_cookie !== 'string' || credential.session_cookie.trim() === '') {
    // 没做过浏览器登录 ⇒ 读不到额度，但 `oma_` Key 照常能推理（见上方长注释）。
    return NEVER
  }
  return sharedPackageExpiry(() => fetchBalanceWithCache(
    cached,
    async () => {
      const result = await fetchMonkeycodeBalanceDetailed(credential, product)
      // ⚠️ `fetchBalanceDetailed` 的失败形态是 `balance: null + error`，
      //    `sharedPackageExpiry` 认「`null` ⇒ UNUSABLE」⇒ 只取 `balance`。
      return result.balance
    },
  ))
}

/**
 * 百智云（`baizhi`）—— 2026-11-02 审查 B🟡-9 补齐。
 *
 * ## 判据
 *
 * `GET https://baizhi.cloud/api/v1/user/wallet/balance`（**cookie 认证**）⇒
 * `buildBaizhiBalance` 给三个**额度**包：每日积分 / 充值积分（`remaining =
 * *_cents / 100`）+ 冻结积分（`active: false`）。
 *
 * ⚠️ 2026-11-02 三审 F🟡-8：此处原写「四个包」，把「本月消耗」也算成了包。
 * 用量不是额度，已改走 `CreditBalance.usage`（不参与折算）。
 *
 * 实测（2026-11-02，真实账号）：`可用 235.05`、`每日 98.21`、`充值 136.84`
 * ⇒ 有 `remaining > 0` 的包 ⇒ `NEVER`（长期，排最后、不剔除）；
 * 全部烧光 ⇒ 一个可烧的包都没有 ⇒ `UNUSABLE`（剔除）。
 *
 * ## ⚠️ 缺会话直接放行
 *
 * 与 {@link monkeycodeExpiry} 同理：余额接口只认控制台 cookie，而推理只要
 * `sk-`（`x-api-key`）⇒ 手填 Key 的账号读不到积分但照常能发消息。
 * ⇒ 缺 `session_cookie` 时返回 `NEVER`，绝不判 `UNUSABLE`。
 *
 * ## ⚠️ 已知且刻意接受的代价
 *
 * 积分烧光时**不会被提前剔出轮换** —— 报文里没有任何「额度何时重置」字段
 * （`daily_temporary_credit_claimed` 只是个布尔）⇒ 耗尽后仍会被选中并失败一次。
 * 与 modelscope / autoclaw **同型**，且**不许**用「猜一个 UTC+8 零点」消除它。
 */
export async function baizhiExpiry(
  credential: BaizhiCredential,
  product: BaizhiProduct = BAIZHI,
  /** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
  cached?: () => Promise<CreditBalance | null | undefined>,
): Promise<number> {
  if (typeof credential.session_cookie !== 'string' || credential.session_cookie.trim() === '') {
    // 只填了 `sk-` 的账号读不到积分（控制台接口要 cookie），但推理可用。
    return NEVER
  }
  return sharedPackageExpiry(() => fetchBalanceWithCache(
    cached,
    async () => {
      const result = await fetchBaizhiBalanceDetailed(credential, product)
      return result.balance
    },
  ))
}

/**
 * **Qoder**（`qoder` 国际版 / `qodercn` 中国版，**共用**本原语，只换 product）：
 * 与 **buddy 系同形**（`CreditPackage` 都带 `deductionEndTime`）⇒ 判据直接复用
 * `sharedPackageExpiry`，**不另写解析逻辑**（两站共用同一个原语，避免同族分叉）。
 *
 * ## ⚠️⚠️ **本家与其它「已接入」渠道的本质不同：上游不给逐包到期时刻**
 *
 * 2026-10-20 取证（两个真实 qodercn 账号，`GET /sash/api/v2/me/usage`）：
 *
 * | 字段 | 实测 | 是否带日期 |
 * |---|---|---|
 * | `userQuota`（套餐额度） | `{total:0,used:0,remaining:0}` | 只有顶层 `expiresAt`，且恒为**永久哨兵** |
 * | `addOnQuota`（资源包） | `{total:2000,…remaining:2000,detailUrl:…}` | **无任何日期字段，只给聚合标量** |
 * | `dedicatedResourcePackages` | `undefined`（本机账号） | **唯一**带真实逐包 `expiresAt`（字符串）的字段 |
 *
 * 顶层 `qoderUsage.expiresAt = 253402214400000`（`9999-12-31T00:00:00Z`）是
 * Qoder 给 `userQuota` 下发的**永久哨兵**、**不是**到期时刻。权威旁证是官方
 * 客户端 asar 的 `buildUsageItemGroups()`：`addOnQuota` 那一档**只渲染
 * used/total/remaining、不给任何日期**；只有 `userQuota.expiresAt` 走
 * `renewson`（「将于 {{date}} 刷新」= **订阅刷新**），
 * `dedicatedResourcePackages` 才走 `expiresOn`（「有效期至 {{date}}」）。
 *
 * ⇒ `qoder-credits.ts` 的 `toPackage()` 用常量
 * `QODER_PERMANENT_EXPIRY_MS` 识别哨兵并**不写** `deductionEndTime`
 * （写进去会让客户端 `formatPackageExpiry` 渲染出
 * `9999-12-31（约 2900000 天后）` 这种荒谬文案）。
 *
 * ## 折算结果（如实，不是打折）
 *
 * | 情形 | 折算值 | 依据 |
 * |---|---|---|
 * | 有余额但**无**逐包到期（本次实测的账号形态） | `NEVER`（长期：排最后但不剔除） | `sharedPackageExpiry` 的「有余额但无到期时间」那一档 |
 * | 有余额且有 `dedicatedResourcePackages` 的真实到期 | 该时刻（取最早那包） | 同上（`Math.min`） |
 * | 一个 `remaining > 0` 的有效包都没有 | `UNUSABLE`（剔除） | 同上 |
 * | 查询失败（含国际版不可达）/ 未登录 | `UNUSABLE` | 同上（`null` ⇒ 不猜） |
 *
 * ⚠️ **已知限制（必须如实标注）**：无 `dedicatedResourcePackages` 时
 * **临期桶恒为 0** —— 三档分档只剩「永久（未知到期）」一档 + 上游聚合标量。
 * 这**不是**缺陷，是「上游不下发 ⇒ 我们不编造」的必然结果（本仓库红线）。
 * 逐包明细端点已穷举失败：`/sash/api/v2/me/*` → 404；
 * `qoder.cn/api/v1/me/quotas/{key}/histories` →
 * `/api/v1/me/usages/big_model_credits/histories` → qoder.cn 下 **401**
 * （需浏览器登录态 cookie，插件 OAuth token 拿不到）、在 openapi 下 **404**。
 *
 * ## 为什么必须走 `cachedBalance`
 *
 * 聚合每轮折算会对同一账号反复提问；没有共享读数就会白发大量重复请求
 * （与 buddy / trae / modelscope / autoclaw / astudio / minimax 同款理由）。
 *
 * ⚠️ **不加 XFF 需求**：与 minimax 国际站不同，Qoder 没有已知的地理分流，
 * ⇒ **刻意不加** `minimaxXff` 那类透传参数（凭空多一个参数只会让人以为有分流）。
 */
export async function qoderExpiry(
  credential: QoderCredential,
  product: QoderProduct,
  /** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
  cached?: () => Promise<CreditBalance | null | undefined>,
  /**
   * 该账号的出口代理 fetcher（2026-10-25 审计 A2-17）。
   *
   * ⚠️⚠️ **折算路径不接代理 ⇒ 墙外环境下该渠道从聚合轮换里静默消失**：
   * 国际版整站在墙外被 SNI 阻断，只能用 per-账号代理出去。本 PR 把代理接进了
   * 推理/搜索/选号/登录四条腿，**折算这条漏了** ⇒ 折算恒失败 ⇒ `UNUSABLE`
   * ⇒ 被 `rankCandidates` 剔除，**零报错、零日志**，而面板看起来正常。
   *
   * 省略 ⇒ 回落全局 `fetch`（= 修复前的行为，供不需要代理的调用方使用）。
   */
  fetcher?: typeof fetch,
): Promise<number> {
  return sharedPackageExpiry(() => fetchBalanceWithCache(
    cached,
    () => fetchQoderCreditBalance(credential, product, fetcher),
  ))
}

/**
 * astudio（讯飞 AstronStudio）：三池各带到期时间 ⇒ **可精确折算**，无已知代价。
 *
 * ## 与 autoclaw 的差别（为何这里能算出真实时刻）
 *
 * autoclaw 的钱包报文里**没有任何时间字段**（只有流水批次才带 `deductionEndTime`），
 * 故它只能「有余额即 `NEVER`」。astudio 的 `/points/balance` 实测直接下发
 * `{member,buy,activity}NextExpireTime`（形如 `"2026-11-20T01:50:14"`，
 * **不带时区的本地时间串**），已由 `astudio-credits.ts` 的
 * `astudioLocalTimeMs` 用 `Date.parse(raw.replace(' ', 'T'))` 归一化到
 * `packages[].deductionEndTime`（毫秒）⇒ 直接复用
 * `sharedPackageExpiry`（取**最早**到期的那一包 = `Math.min`）。
 *
 * ## 为什么走 `sharedPackageExpiry` 而不是自己遍历
 *
 * 它把三件容易写错的事收敛在一处：①异常按 `isAbortError` 分流（用户取消要
 * 继续抛，不能吞成 `UNUSABLE`）；②`null` ⇒ `UNUSABLE`；③**所有**候选都折算
 * 失败时（`anyConverted === false`）返回 `UNUSABLE` 而不是 `NEVER`
 * —— `NEVER` 意味着「永不过期」，会被聚合排在最后但仍然**可选中**，
 * 那是把「查不到」谎报成「长期有效」（本仓库红线）。
 *
 * ## 为什么必须走 `cachedBalance`
 *
 * 聚合每轮折算会对同一账号反复提问；没有共享读数就会白发大量重复请求
 * （与 buddy / trae / modelscope / autoclaw 同款理由）。
 */
export async function astudioExpiry(
  credential: AstudioCredential,
  product: typeof ASTUDIO,
  /** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
  cached?: () => Promise<CreditBalance | null | undefined>,
): Promise<number> {
  return sharedPackageExpiry(() => fetchBalanceWithCache(
    cached,
    async () => {
      const result = await fetchAstudioBalanceDetailed(credential, { product })
      // ⚠️ 同 autoclaw：`fetchBalanceDetailed` 的失败形态是 `balance: null + error`，
      //    `sharedPackageExpiry` 认「`null` ⇒ UNUSABLE」⇒ 只取 `balance`。
      return result.balance
    },
  ))
}

/**
 * minimax（MiniMax Code，中国版 / 国际版共用本原语，只换 product）：
 * **每条积分明细各带自己的到期时刻** ⇒ 可精确折算，无已知代价。
 *
 * ## 与 astudio 的差别（字段形态，判据一致）
 *
 * | 渠道 | 到期字段 | 形态 | 是否需要归一化 |
 * |---|---|---|---|
 * | astudio | `{member,buy,activity}NextExpireTime` | **不带时区的本地时间串** | 需要（`Date.parse(raw.replace(' ','T'))`） |
 * | minimax | `details[].expire_at_ms` | **毫秒时间戳** | 不需要（直接是 epoch ms） |
 *
 * 两者最终都落到 `packages[].deductionEndTime`（毫秒）⇒ 折算口径逐格一致，
 * 都复用同一条 `sharedPackageExpiry`（取最早到期的那一包）。
 *
 * ## 为什么能算（此前判「不可折算」的依据已被实测推翻）
 *
 * 2026-10-20 用户报障「MiniMax Code 积分也有到期时间，也应当有相同功能」，
 * 并附 AStudio 面板截图作参照。实测（真实凭据，两站各取账号）确认：
 * `GET /minimax-cloud/api/v1/credit/details` 的**每条** `details[]` 都带
 * `expire_at_ms`（中国版 20/20 条、15/15 条全部有值），
 * 且到期时刻 = 发放日 + 30 天的零点（如 2026-10-20 发放 → 2026-11-19 到期）。
 *
 * ⚠️ 在此之前 `fetchMinimaxCreditBalance` 把 `packages` **硬编码成 `[]`**，
 * 聚合侧据此把本家归为「查不到到期时间」一类。那个结论**不是**
 * 「上游不下发」，而是「我们没解析」—— 这两件事在注释里被混同过，是本次
 * 报障的根因。
 *
 * ## 为什么必须走 `cachedBalance`
 *
 * 聚合每轮折算会对同一账号反复提问；没有共享读数就会白发大量重复请求
 * （与 buddy / trae / modelscope / autoclaw / astudio 同款理由）。
 */
export async function minimaxExpiry(
  credential: MinimaxCredential,
  product: MinimaxProduct,
  /** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
  cached?: () => Promise<CreditBalance | null | undefined>,
  /**
   * 国际站的 `X-Forwarded-For` 绕行头（见 `src/minimax.ts` 的 `withMinimaxXff`）。
   *
   * ⚠️ 必须透传：国际站按出口 IP 做地理分流，`agent.minimax.io` 会 307 到
   * 中国站，而**跟随后中国站不认国际站 token**（`401 invalid access token`，
   * 与「凭据真失效」逐字同形，issue IKMEVG）。不带 xff ⇒ 国际站账号的
   * 到期折算恒失败 ⇒ 该渠道在聚合轮换里被静默剔除。
   */
  xff?: string,
  /**
   * 该账号的出口 fetcher（**仅国际站**需要，PR !145 审计 P0 修法）。
   *
   * ## ⚠️⚠️ 为什么折算路径也必须换出口
   *
   * 本函数是**聚合轮换候选可见性的闸门**：折算拿不到读数 ⇒ `sharedPackageExpiry`
   * 返回 `UNUSABLE` ⇒ `rankCandidates` 把该候选剔除。而
   * `agent.minimax.io` 按出口 IP 国别分流（大陆直连恒 307 → 中国站 → 401），
   * ⇒ 用户配好代理、对话能用了，**该渠道仍从轮换里静默消失**，零报错。
   *
   * PR !145 的注释点了这个症状，但只把 fetcher 接进了选号器与适配器 ——
   * 本函数当时仍是**裸 `fetch` 字面量**。
   *
   * ⚠️ 省略 ⇒ 全局 `fetch`，与修复前**逐字节等价**（中国版永远省略）。
   */
  fetcher?: typeof fetch,
): Promise<number> {
  return sharedPackageExpiry(() => fetchBalanceWithCache(
    cached,
    async () => {
      const result = await fetchMinimaxCreditBalanceDetailed(
        credential, fetcher ?? fetch, product, xff,
      )
      // ⚠️ 同 autoclaw / astudio：失败形态是 `balance: null + error`，
      //    `sharedPackageExpiry` 认「`null` ⇒ UNUSABLE」⇒ 只取 `balance`。
      return result.balance
    },
  ))
}


/** loomy：有今日赠送 → 当日 24:00；只剩永久 → NEVER。 */
export async function loomyExpiry(credential: LoomyCredential): Promise<number> {
  let detail
  try {
    detail = await fetchLoomyCreditDetail(credential, LOOMY)
  } catch {
    return UNUSABLE
  }
  if (detail === null) return UNUSABLE
  if (detail.daily > 0) return nextUtc8DayStartMs()
  // ⚠️ `permanent` 可能是 `undefined`（上游没给该字段，issue IKMCOO 缺陷 4）。
  //   **判「大于 0」而不是「非 0」**：`undefined > 0` 为假 ⇒ 落入 `UNUSABLE`
  //   —— 那正是「有今日额度却被判不可用」的同型故障。
  return detail.permanent !== undefined && detail.permanent > 0 ? NEVER : UNUSABLE
}

/**
 * accio：与 **loomy 同形**（命名池、无逐包时间戳），但有一条更强的信息。
 *
 * ## 判据（2026-10-13 合并审计发现「聚合里看不到 accio」后补）
 *
 * | 情形 | 折算值 | 依据 |
 * |---|---|---|
 * | `每日积分 > 0` | **当日 24:00**（`nextUtc8DayStartMs()`） | 每日额度 24h 作废且**不累积** |
 * | 只剩 `每月积分` / `推荐积分` | `NEVER`（长期，排最后但不剔除） | 上游**没有**下发它们的到期时间 |
 * | 三类桶全为 0 | `UNUSABLE`（剔除） | 没有可烧的额度 |
 * | 查询失败 / 未登录 | `UNUSABLE` | 读不到就不猜 |
 *
 * ## ⚠️ 为什么用 `nextUtc8DayStartMs()` 而不是 `quota.refreshCountdownSeconds`
 *
 * `accio-credits.ts` 的 `accioQuotaResetIso` 能用倒计时算出**精确**的重置时刻，
 * 但那条路径的注释明确写着「`refreshCountdownSeconds` 只说**额度何时刷新**，
 * 与『这批积分何时作废』在 Accio 上**未被实测为同一时刻**」——
 * 故**刻意不写 `deductionEndTime`**（写进去就是编造）。
 *
 * ⇒ 本函数**尊重那个结论**：只在**有每日额度**时给一个「当日结束」的**保守上界**
 *（与 loomy 的 `daily > 0 → 当日 24:00` 逐字同判据），**不**把倒计时当到期时间用。
 * 语义上这是「临期优先」排序要的信息（今天就作废的排前面），而不是精确的作废时刻。
 *
 * ⚠️ **两家同形 ⇒ 判据必须逐格同构**（本仓库红线）：若将来 loomy 那一格改了
 *（例如上游开始下发真实到期时间），**这里要一起改**。
 */
export async function accioExpiry(credential: AccioCredential): Promise<number> {
  let detail
  try {
    detail = await fetchAccioBalanceDetailed(credential)
  } catch {
    return UNUSABLE
  }
  if (detail.balance === null) return UNUSABLE
  const buckets = detail.balance.packages
  // ⚠️ 桶的判据与 `sharedPackageExpiry` 同口径（`active === true` 且 `remaining > 0`），
  //    只是**不取** `deductionEndTime`（Accio 本来就不下发）。
  const usable = buckets.filter(
    (pkg) => pkg.active === true && typeof pkg.remaining === 'number' && pkg.remaining > 0,
  )
  if (usable.length === 0) return UNUSABLE
  // 每日额度按展示名识别（`makeAccioPackage` 的 name 就是 `每日积分`）。
  // ⚠️ 用**展示名**而不是下标：桶的顺序由 `ACCIO_CREDIT_BUCKETS` 固定，
  //    但按名字判更耐重构（少一个桶时不会错位）。
  const hasDaily = usable.some((pkg) => pkg.name === '每日积分')
  return hasDaily ? nextUtc8DayStartMs() : NEVER
}

/**
 * officeace：与 **buddy 系同形**（订阅的每个积分桶都带 `expiresAt` ⇒ 归一化到
 * `deductionEndTime`），故折算口径与 `sharedPackageExpiry` **逐格一致**。
 *
 * ## 为什么单独一条原语（而不是直接复用 `sharedPackageExpiry`）
 *
 * 那个共享实现吃的是 `fetchBalance: () => Promise<CreditBalance | null>`，而
 * officeace 的余额入口是 {@link fetchSubscriptionSummary}：签名是
 * `(staleHours, ref, credential, credentials)`，且返回的是
 * `OfficeAceSubscriptionSummary`（不是 `CreditBalance`）—— 形状套不进那个泛型。
 * 这与 `qoder` / `opencode` 被排除在共享骨架外的理由同源（「形态不匹配就如实
 * 排除，不为凑齐 N 家而丢语义」）。
 *
 * ⚠️ **但判据必须与 `sharedPackageExpiry` 逐格同构**（本仓库红线）：
 *
 * | 情形 | 折算值 | 依据 |
 * |---|---|---|
 * | 有 `remaining > 0` 的有效桶，且**至少一个**给了到期时间 | 那些到期时间的**最小值** | 与 buddy 系同口径 |
 * | 有 `remaining > 0` 的有效桶，但**都没给**到期时间 | `NEVER`（长期，排最后但不剔除） | 服务端没下发 ⇒ 不臆造 |
 * | 一个 `remaining > 0` 的有效桶都没有 | `UNUSABLE`（剔除） | 没有可烧的额度 |
 * | 查询失败 / 未登录 / 只拿到缓存 | `UNUSABLE` | 读不到就不猜 |
 *
 * ## ⚠️ 为什么要带 `ref`（2026-10-13）
 *
 * `fetchSubscriptionSummary` 传了 `ref` 才走**云侧 V11 直读**；不传会回落到
 * 果办客户端的**全局单一 cookie**（只反映「当前登录在果办里的那一个账号」）
 * ⇒ 多账号下所有账号都折算成同一个余额（实测两个账号都显示 6500）。
 * 聚合的候选排序是**每账号**粒度，串号会让选号直接选错人。
 *
 * ⚠️ 未传 `ref` 时（老调用点）仍可工作，但只对单账号正确 —— 见
 * `ProviderExpiryContext` 是否携带 ref。
 */
export async function officeaceExpiry(
  credential: OfficeAceCredential,
  ref?: string,
): Promise<number> {
  // ⚠️ **熔断优先于一切**（Gitee issue IKLTHB 第 ③ 条）：Basic 凭据被华为 MaaS
  //    连续拒绝时，这里**必须**判 `UNUSABLE`，否则会出现最难看的一种组合 ——
  //    余额读得到（V11 签名是**另一套鉴权**，它不受影响）⇒ 折算成一个正常值
  //    ⇒ officeace **留在候选表里甚至排第一** ⇒ 每轮都先撞一次 401 再改道。
  //
  // ⚠️ 判据只在这里读，**不写**：熔断的记账点在适配器（只有它看得见 401 报文），
  //    折算层只消费。这样「什么算凭据拒绝」只有一份实现（`isBasicCredentialRejection`），
  //    也避免折算探测自己把渠道熔断（余额读失败与推理被拒是两件事）。
  if (officeaceBreakerOpen(credential)) return UNUSABLE
  let summary
  try {
    summary = await fetchSubscriptionSummary(48, ref, credential)
  } catch {
    return UNUSABLE
  }
  if (summary === undefined) return UNUSABLE
  /**
   * ⚠️⚠️ **只拿到陈旧缓存 ⇒ `UNUSABLE`，不得用历史快照参与排序**
   * （Gitee issue IKM741 连带修正，2026-10-16 实测确证「注释说一套、实现做另一套」）。
   *
   * 本函数上方的判据表（以及 `docs/agent-notes/providers-officeace.md` §5.8 的同表）
   * **逐字写着**「查询失败 / 未登录 / **只拿到缓存** ⇒ `UNUSABLE`（读不到就不猜）」，
   * 而修前的实现**没有这一支**：`fetchSubscriptionSummary` 在云侧直读失败时会
   * 返回 `{ ...readSubscriptionCache(ref), stale: true }`（`officeace-auth.ts`
   * 的兜底腿），于是**几十小时前的快照**会被折算成一个正常的到期时刻、
   * 堂堂正正地参与「临期优先」排序。
   *
   * 实测（本机探针，隔离目录）：凭据在、云侧不可达、该 ref 有一份
   * `cachedAt` 为两天前的缓存 ⇒ `officeaceExpiry` 返回
   * `1792165834998`（一个真实时刻）而**不是** `UNUSABLE(-1)`。
   *
   * 危害方向与 issue IKM741 的 C 档**同族**：`stale: true` 的语义就是
   * 「这不是本次读数，是历史快照」——
   * - 快照里的桶可能**早已被烧完**（真实余额 0）⇒ 折算成临期 ⇒ 候选排到**最前**，
   *   抢走本该先用掉的别的渠道额度（正是 `codeartsExpiry` 那节记录的同型缺陷）；
   * - 也可能**恰好多出**一份已作废的签到桶 ⇒ 让一个实际没额度的账号留在候选表里。
   *
   * ⇒ 判据：**只认本次云侧读数**（`stale !== true`）。理由是 `stale` 标记本身
   * 就是本仓库为「这是缓存」专门加的字段，把它当实时读数用属于**丢字段**。
   * ⚠️ 代价如实登记：云侧抖动时该渠道会从候选表消失，最长持续
   * `EXPIRY_CACHE_TTL_MS`（60 秒）—— 这与「读不到就不猜」的既有原则一致，
   * 也与 IKLTHB 的熔断短路同方向（宁可不用，不可用错）。
   */
  if (summary.stale === true) return UNUSABLE
  let earliest = NEVER
  // ⚠️ 与 `sharedPackageExpiry` 同因：`earliest` 的初值 `NEVER` 无法区分
  //    「一个有效包都没有」（⇒ 剔除）与「有余额但不下发到期时间」（⇒ 长期）。
  let hasAnyCredit = false
  for (const group of summary.creditGroups) {
    // ⚠️ 判据与共享实现同口径（`active` 且 `remaining > 0`）。
    //    officeace 的 `expired` 是独立布尔（不是 `active`），故这里取反。
    if (group.expired === true) continue
    if (!(typeof group.remaining === 'number' && group.remaining > 0)) continue
    hasAnyCredit = true
    // ⚠️ `expiresAt` 是 ISO 8601 字符串（与 STS 的 `expiration` 同形），
    //    不是数值时间戳 —— 别顺手加 `> 1e12` 归一化（那是兄弟渠道的坑）。
    const end = typeof group.expiresAt === 'string' ? Date.parse(group.expiresAt) : Number.NaN
    if (Number.isFinite(end) && end > 0 && end < earliest) earliest = end
  }
  // 有余额但都没给到期时间 ⇒ 长期（排最后，不剔除）。
  if (hasAnyCredit) return earliest
  return UNUSABLE
}

/**
 * codearts：**积分账户的到期时间不可知 ⇒ 一律 `NEVER`（长期）**。
 *
 * ## ⚠️⚠️ 为什么不再算「当日 24:00」（真实缺陷，用户报障 2026-10-07）
 *
 * 用户看到聚合面板把 codearts 列为候选，问「codearts 中也没显示积分临期」。
 *
 * **实测探针**（本机两个真实账号，只读 GET `statistics/plugin`）：
 *
 * | 账号 | 类型 | `credit` |
 * |---|---|---|
 * | `A3E53911` | `isTokenPackage: true`（Token 计费） | `undefined`（无积分口径） |
 * | `82AD9D6E` | `isCreditPackage: true` | `22088.16`（**赠送**积分包） |
 *
 * 且 `packages[].cycleStartTime` / `cycleEndTime` / `expiredTime` **三个字段实测全空**
 * —— 与 `codearts-credits.ts` 的既有注释一致：「`statistics/plugin` **不下发**
 * 资源包的有效性/周期字段……如实置为有效、周期留空，**而不是臆造一个到期时间**」。
 *
 * ⇒ 旧实现（继承自 PR !69 的 `auto-adapter.ts` 折算表）写的是
 * 「有积分 ⇒ `nextUtc8DayStartMs()`（今日 24:00 作废）」—— 那**正是臆造**：
 * 接口没给过期时间，官方文档（README 引用）说的是签到积分「**自发放起 30 天内有效**」，
 * 两者都不是「今天 24:00」。
 *
 * **后果**：codearts 的失效时刻被算成「今天」⇒ 在「临期优先」排序里**永远排最前**，
 * 抢走了本该先用掉的**真正临期**额度（buddy 的资源包 / loomy 的当日赠送）。
 *
 * ⇒ 改为 `NEVER`（长期积分：排最后，但**不剔除** —— 没有临期额度时仍要用它）。
 * 与本仓库既有原则一致：**读不到就不猜**（`zcodeExpiry` 对「查不到」返回
 * `UNUSABLE` 而非 `NEVER`，也是同一条原则）。
 *
 * ⚠️ 两种「无到期信息」的情形在本函数里**合并处理**（都返回 `NEVER`）：
 * 有积分（到期未知）与无积分（Token 计费账户 / 余额为 0）。两者在排序上同为
 * 「不临期」，且**都不该被剔除** —— 账号本身是可用的。
 * 这与 `buddyExpiry` 的「无有效包 → NEVER」是同一口径。
 *
 * ⚠️ 若将来接口开始下发周期字段，应改为读真实值（`packages[].expiredTime` 等），
 * **不要**恢复成某个固定估算。
 *
 * ## ⚠️⚠️ 也**不要**因为「余额为 0」就改成 `UNUSABLE`（PR #81 审计实测，2026-10-07）
 *
 * 同一次用户报障里有人提议：把「余额 0」也算成当前不可用
 * （`credit.total > 0 ? 当日 : UNUSABLE`），理由是「额度已尽却仍被 auto 选中」。
 * **对本渠道该推理不成立**，实测三格反例。
 *
 * ⚠️ 下表第 2 列是**那个被拒的提议**会产生的后果（不是本函数现状 —— 本函数恒返回
 * `NEVER`，没有「当日」分支；「当日」是更早的旧实现，见上文的实测三格）：
 *
 * | 账户形态 | `credit` | 被拒提议的后果 | 本函数（现状） |
 * |---|---|---|---|
 * | 积分账户有余额 | `{ total: 22088.16 }` | 当日 24:00 ⇒ **抢走真正临期的额度** | `NEVER` |
 * | 积分账户余额 0 | `{ total: 0 }` | `UNUSABLE` | `NEVER`（账号仍可用） |
 * | **Token 计费账户** | **`undefined`** | `?? 0` ⇒ `UNUSABLE` ⇒ **可用账号被永久剔除** | `NEVER` |
 *
 * ⚠️ 第三格是**实打实的回归**：`isTokenPackage` 账户**没有积分口径**
 * （`codearts-credits.ts` 的 `CodeArtsAccountInfo.credit` 注释明写「`undefined`
 * 表示这个账户没有积分口径」，与 `{ total: 0 }` 严格区分），而这类账号**能正常
 * 推理**；且 codearts 有 benefit（免费额度）模型走 `maas_type: benefit`
 * （`isCodeArtsBenefitModelKnown` 按远端集合判定）——**积分余额 0 ≠ codearts 不可用**。
 *
 * ⚠️ 与 `loomyExpiry` 的 `permanent > 0 ? NEVER : UNUSABLE` **不是**同一口径：
 * 那里的 `permanent` 是 loomy **自己的永久积分余额**（0 就是真的没有额度）；
 * 这里的 `credit.total` 在 Token 账户下根本**不存在**，把它当 0 是**臆造**。
 * 「读不到就不猜」是本函数的立身之本，别用一个 `?? 0` 把它推翻。
 *
 * 真正该守的边界是**探测失败**（`!result.ok` ⇒ `UNUSABLE`，已有用例守住），
 * 而不是「探测成功但余额为 0」。
 */
export async function codeArtsExpiry(credential: CodeArtsCredential): Promise<number> {
  let result
  try {
    result = await fetchCodeArtsAccountInfoDetailed(credential)
  } catch {
    return UNUSABLE
  }
  // 查不到 / 结构异常 ⇒ UNUSABLE（剔除），与「查到了但没有到期概念」严格区分。
  if (!result.ok) return UNUSABLE
  return NEVER
}

/**
 * ⚠️⚠️ **本函数读不到 benefit（免费额度）口径** —— 但缺口**不在本函数**（已修，2026-10-07）。
 *
 * ## 缺口是什么
 *
 * codearts 有**两套完全不同的额度口径**，而上面只读了其中一套：
 *
 * | 口径 | 来源 | `codeArtsExpiry` 读得到吗 |
 * |---|---|---|
 * | 签到积分（长期） | `statistics/plugin` 的 `credit.total` | ✓ 只有它 |
 * | **benefit 免费额度** | `InferHub` 报文（每日 1000 万 tokens，**按自然日**结算） | ✗ **读不到** |
 *
 * ## ⚠️ 但它**不需要**在本函数里补（这是本注释存在的唯一理由）
 *
 * benefit 耗尽**已经被记账**：`llm-adapter.ts` 命中 `InferHub.4291.200` 时调
 * `accountPool.updateModelRateLimit(currentAccountId, options.model, 次日 00:00)`，
 * 而账号池按 `entry.modelRateLimits[modelId]` 过滤候选
 *（`getAvailableAccount` / `listAvailableCredentials`）。
 *
 * ⇒ **正确的判据在选型层，不在折算层**：选型时必须按**候选自己将要派发的
 * `realId`** 去问账号池「这个模型上还有可用账号吗」。
 * `AggregateAdapter.filterByModelAvailability` 就是这一层（已实现）。
 *
 * ⚠️ **为什么必须单独做这一步**：折算取号用的模型键是**渠道目录第一个模型**
 *（`src/index.ts` 的 `firstModelIdOf`：`models[0]?.id`），而聚合层派发的是
 * **候选自己的 `realId`** —— 两者常常不是同一个模型 ⇒ 那个按 modelId 的过滤
 * 对聚合路径**整体失效**（实测探针确认）。auto 路径不存在这个问题：它的
 * `firstModelOf` 返回值就是实际派发的模型。
 *
 * ## ⚠️ 不要因此照 PR #81 的 `credit.total > 0 ? 当日 : UNUSABLE` 去改
 *
 * 那个修法**方向错**（见上方长注释：会剔除 Token 计费账号与「余额 0 但可用」的账号）。
 * 本函数的 `NEVER` 是「按签到积分口径查到的信息说它可用」，与 benefit 无关 ——
 * 两件事在**不同的层**解决，别把它们混在一处。
 *
 * ⚠️ 保留本注释的原因：读到这里的人会问「benefit 读不到怎么办」，答案在
 * `filterByModelAvailability`。别在这里再补一份折算（那会变成同一语义两套判据）。
 */

/**
 * zcode：各桶 `expiresAt`（秒）最小值；有余额但上游未给到期时间 → 当日 24:00。
 *
 * ## ⚠️⚠️ 余额为 0 ⇒ `UNUSABLE`（真实缺陷，用户报障 2026-10-07）
 *
 * **用户报障原文**：auto 选中了额度已尽的 zcode，请求直接失败：
 * `zcode: 账号在模型 "GLM-5.3" 上的额度已用尽或没有可用权益。QUOTA_EXCEEDED`
 *
 * 而 auto 的价值主张恰恰是「挑有额度、且快作废的那个」—— 折算错了就挑中一个
 * **根本不能用**的渠道，比不做 auto 更糟（用户看到的是「auto 坏了」，且每次
 * 重试都撞同一个渠道）。
 *
 * 旧实现最后一行是 `if (balance.remaining > 0 || claimablePlans.length > 0)
 * return nextUtc8DayStartMs()`，**`return NEVER`** 收尾。两个分支都会让一个
 * 余额为 0 的 zcode 被选中：
 *
 * | 形态 | 旧折算 | 后果 |
 * |---|---|---|
 * | 无桶 + 有可领活动（`claimablePlans`） | 当日 24:00 | **排最前**，优先选中 |
 * | 无桶 / 桶余额为 0，无可领 | `NEVER` | 排最后，但**不被剔除**（池里只剩它时必被选中） |
 *
 * ## 判据：**「可领」不等于「已拥有」**
 *
 * `claimablePlans`（`billing/preview` 的可领活动）表示**还能领**，不表示**已经有**。
 * zcode 的每日赠送额度**要先 claim 才进 `balances` 桶**（见 `zcode-upstream.ts`
 * 的「签到为什么要补激活上报」），没领就是**当前不可用** —— 这正是 zcode
 * 「需手动签到」的形态。用户去面板签到后余额进桶，下一轮探测自然重新纳入候选。
 *
 * ⚠️ **但有余额、只是上游没给 `expires_at` 时仍按当日折算**（保留旧行为）：
 * `zcode-upstream.ts` 的 `expiresAt: num(record.expires_at)` 在字段缺失时就是
 * `undefined`，而 `remaining_units` 齐全。此时账号**确实有额度**，把它判成
 * `UNUSABLE` 会丢掉一个可用渠道 —— 与本仓库「读不到就不猜，但也不误剔除」
 * 的既有口径一致（对照 `codeArtsExpiry` 对「查不到」与「查到但无到期概念」
 * 的严格区分）。故判据是 **`balance.remaining > 0`**（有余额）而不是
 * 「有任何一个桶带有效到期时间」。
 */
export async function zcodeExpiry(
  credential: ZcodeCredential,
  context?: ProviderExpiryContext,
): Promise<number> {
  let balance
  try {
    balance = await fetchZcodeBalance(credential)
  } catch {
    return UNUSABLE
  }
  // ⚠️ `undefined` 表示「这次查不到」，不是「没有余额」—— 折算成 `NEVER` 会让
  //    一个查不到余额的渠道以「永久积分」身份参与轮换。
  if (balance === undefined) return UNUSABLE
  // ⚠️⚠️ **企业版必须判 `NEVER`（长期），绝不能落到下面的 `UNUSABLE`**
  // （真实缺陷，对抗审计实测证伪，2026-10-07 —— 我自己上一版正是这么错的）。
  //
  // 企业版（`displayMode: 'enterprise'`）返回的是 `{ enterprise: true, buckets: [],
  // remaining: 0, total: 0, claimablePlans: [] }` —— 它与「额度已用光」在**数值上
  // 完全同形**（都是 0 个桶 + `remaining: 0`），故按下面的判据会被算成 `UNUSABLE`
  // ⇒ **一个能正常推理的企业版账号被永久排除出 auto 候选**。
  //
  // ⚠️ 上游在 `zcode-upstream.ts` 已就此**明文警告**：
  //    「企业版不下发额度数字、只给外部链接 —— 此时返回 `{enterprise:true,buckets:[]}`，
  //      **不要**显示成 0（**0 是「已用光」的语义**）」
  // 本函数违反的正是这句：把「不下发额度数字」当成了「余额为 0」。
  //
  // ⇒ 判据必须**先**看 `enterprise` 标记（那是「不知道额度」的诚实标记），
  //   再谈余额。语义是「可用、但无临期额度可算」= `NEVER`（排最后但不剔除）——
  //   与 `codeArtsExpiry` 对「查到了但没有到期概念」的处理同一条原则。
  //
  // ⚠️ 企业版**没有桶** ⇒ 按模型判定那一段（下面）也没有任何可写的标记，
  //    故这里的提前返回不影响按模型标记（那是「额度数字都不知道」的形态）。
  if (balance.enterprise === true) return NEVER

  /**
   * ★★ **按模型写出「该模型在这个账号上已无额度」的持久标记**（2026-10-12）。
   *
   * ## 为什么在这里做（而不是在适配器里发请求前查一次）
   *
   * 这里是**唯一**已经拿到 `balance` 全部桶的地方，且它本来就在每次选型时跑
   * （判定「这个渠道还能不能用」）。把判定挂在这里 ⇒ **零额外请求**
   *（直接复用这次余额查询的结果），且 auto / aggregate 的**选型**阶段
   * 立刻就能通过 `getAvailableAccount(provider, model)` 看到结论
   * —— 不必等到真的发出那一发、被上游拒绝才知道。
   *
   * ## 判据表
   *
   * | 情形 | 折算值 | 写标记 |
   * |---|---|---|
   * | GLM-5.3 的 3M 烧光、Flash 的 5M 还在 | `remaining = 5M > 0` ⇒ **可用** | `['GLM-5.3']` |
   * | 两个专属桶都烧光 | `UNUSABLE` | 两个都写 |
   * | 专属桶烧光、但**通用赠送桶**还有余额 | **可用** | **不写**（通用桶覆盖它，上游仍能承接） |
   * | 某模型没有任何桶覆盖（如 GLM-5.2） | 照常 | **不写**（证据不足，不本地判死） |
   *
   * ⚠️ **两侧大小写不同**（实测）：上游 `capabilities` 是 `glm-5.3`（小写），
   * 而池过滤用的键是 DSH 目录的 `GLM-5.3`（大写）⇒ 把**目录那一套 id** 交给
   * `exhaustedModelsOf`（它内部大小写不敏感地比对、并原样回传目录 id），
   * 否则标记**永远不命中**且无任何报错。
   *
   * ⚠️ 写标记**绝不能**影响折算值：这是「观测 + 记账」，不是「折算依据」。
   * 故它在 `try/catch` 里，失败**静默吞掉**（下面那条 catch）。
   *
   * ## ⚠️ 为什么是**静默**而不是「记日志」（别照着直觉改成打日志）
   *
   * 本模块是**纯底座**：`createExpiryProbe` 只收 `pool` / `firstModelIdOf` / `options`，
   * **没有 `ctx`、也没有 logger**（同文件上方「刻意不打日志」那条注释记着同一约束）。
   * 为一条失败路径去穿一条 logger 通道，会把日志出口变成这个纯底座模块的新依赖 ——
   * 而那正是模块头禁止的层次方向。
   *
   * ⚠️ 代价是**如实承认**的：标记写失败（磁盘满 / 权限）在日志里**无痕**。
   * 可观测性由**调用方**兜：`AccountPool.markModelsExhaustedForExpiry` 自己
   * 在成功与账号不存在时都有 `ctx.logger`（那里拿得到 ctx），
   * 且它落盘失败会向上抛 —— 被本 catch 静默的那一刻确实丢信息，
   * 但**不影响正确性**（下一轮折算会重试写）。
   */
  if (
    context?.accountId !== undefined
    && context.accountId.length > 0
    && (context.markModelsExhausted !== undefined || context.clearModelsExhausted !== undefined)
    && context.catalogIds !== undefined
  ) {
    try {
      const catalogIds = await context.catalogIds()
      /**
       * ⚠️⚠️ **写与清必须成对**（真实缺陷 —— 单向门，2026-10-12）。
       *
       * 只写不清的话，用户**当天**烧光后去签到领到额度时，标记仍挂到次日 0 点
       * ⇒「签到成功了但当天用不了」。实测确认签到路径**救不回来**
       * （`credits.claimAll` 只清折算缓存、不清 `modelRateLimits`，
       * 见 `scripts/verify-zcode-mark-after-claim.mjs`）⇒ 自愈只能在这里做：
       * 本次折算**已经拿到新的余额报文**，正好能判「哪些模型恢复了」。
       *
       * ⚠️ 两个列表由 `exhaustedModelsOf` / `recoveredModelsOf` 给出，
       * 它们**逐格互补**（同一个模型不会同时出现在两边），故两个调用无顺序依赖 ——
       * 但仍按「先清后写」排列：万一将来判据漂移导致重叠，
       * 先清后写的结果是「标记存在」（保守方向），反过来则是「标记消失」（危险方向）。
       */
      const recovered = recoveredModelsOf(balance.buckets, catalogIds)
      if (recovered.length > 0 && context.clearModelsExhausted !== undefined) {
        await context.clearModelsExhausted(context.accountId, recovered)
      }
      const exhausted = exhaustedModelsOf(balance.buckets, catalogIds)
      if (exhausted.length > 0 && context.markModelsExhausted !== undefined) {
        await context.markModelsExhausted(context.accountId, exhausted)
      }
    } catch (error) {
      /**
       * ⚠️⚠️ **中止必须原样逃逸**（全局硬约束，对抗审计实测证伪 2026-10-12）。
       *
       * 初版这里是**裸的 `catch {}`** ⇒ `catalogIds()` 或 `markModelsExhausted`
       * 抛出的 `AbortError` 被静默吞掉、折算照常返回一个值 ——
       * 而本模块的铁律是「**abort 立刻抛 `AbortError`，绝不折算**」
       *（同文件上方两处、以及 `credentials` 分支的 catch 都守这条）。
       *
       * ⚠️ 实测：`AbortError` 从 `catalogIds()` 抛出时探针**返回了值**而非抛出
       *（审计的 `scratch` 探查复现；修后应改为抛出）。
       *
       * ⚠️ 判据只取 `isAbortError(error)`（**不是**两条）——
       * `zcodeExpiry` 的签名里**没有 `signal`**（它只收 `credential` + `context`），
       * 故 `signal?.throwIfAborted()` 在这里不可用；中止的**另一条**防线
       *（「signal 已标记」）由调用方 `createExpiryProbe` 的循环负责
       *（它每轮开头就 `signal?.throwIfAborted()`）。
       * ⚠️ 如实登记：这是**唯一**一处判据少于同文件其它 catch 的地方，
       * 原因是签名差异，不是遗漏。
       */
      if (isAbortError(error)) throw error
      // ⚠️ 其余失败**静默是刻意的**（本模块无 logger，见上方长注释）：
      //    标记失败不得影响折算。别在这里补 `console`/logger ——
      //    那会引入新依赖，或不一致的第二日志出口。
    }
  }

  let earliest = NEVER
  for (const bucket of balance.buckets) {
    const remaining = bucket.availableUnits ?? bucket.remainingUnits ?? 0
    if (!(remaining > 0)) continue
    const exp = bucket.expiresAt
    if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
      const ms = exp * 1000
      if (ms < earliest) earliest = ms
    }
  }
  if (earliest !== NEVER) return earliest
  // 有余额但桶里没有可用的到期时间 ⇒ 按当日额度保守估算（先烧它）。
  // ⚠️ 判据是 `remaining`（**已拥有**的余额），**不含** `claimablePlans`。
  if (balance.remaining > 0) return nextUtc8DayStartMs()
  // 余额为 0 ⇒ 当前不可用（剔除），**不因「有可领活动」而入选**。
  return UNUSABLE
}
