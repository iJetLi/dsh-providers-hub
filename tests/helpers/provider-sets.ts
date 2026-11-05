/**
 * **从 `PROVIDER_REGISTRY` 派生的「期望集合」唯一真源**（Task 11-F 引入）。
 *
 * ## ⚠️ 它解决什么
 *
 * 本次重构实测：同一批「谁是 X 类 provider」的判据在**多个测试文件里各写了一遍**，
 * 形态还分两种（硬编码 id 字面量 / 读带理由的豁免表）。实测两组的分布：
 *
 * | 语义 | 出现处 | 硬编码副本 |
 * |---|---|---|
 * | 「谁该占 auth 键位 / 该注册进能力表 / 该进批量续期表」 | 4 处（3 个文件） | 3 份 `d.id !== 'opencode'` |
 * | 「谁该进生产积分表」 | 3 处（2 个文件） | 3 份 `new Set(['opencode','qoder','qodercn'])` |
 *
 * ⚠️ 两组的**集合并不相同**（13 vs 11），故**不能合并成一个**：
 *
 * - 第一组判据是 `channel`（有没有账号/凭据/积分）减去 {@link AUTH_EXEMPT}；
 * - 第二组判据是 `credits.balance === true`（声明了余额能力）减去
 *   {@link CREDITS_TABLE_EXEMPT} —— **形态不匹配**、没法套共享骨架的那几家。
 *
 * ⚠️ 两者的豁免名单**恰好重合于 opencode**，但**理由毫无关系**：前者是
 * 「RPC 走 `handleOpencodeRpc`、没有 XxxAuth 服务」，后者是「余额是本地派生的
 * 通道可用性、零网络」。把它们当成一张表会**掩盖理由的差异**（本仓库反复记录的
 * 「同一份名单承载两种语义」缺陷形态），故**刻意分成两张表**。
 *
 * ## ⚠️ 为什么是函数而不是模块级常量
 *
 * ⚠️ 与 `src/provider-runtime.ts` 的派生表**同形**（那里是硬要求：注册发生在
 * `apply()` 里，模块级常量在模块加载时求值会**恒为空表**），但本文件的理由
 * **不是**那条，而是**求值时机解耦**（2026-10-08 独立复审修正）。
 *
 * ⚠️ 原注释声称「本仓库的反向验证会**临时改写 `PROVIDER_REGISTRY`**（删一个字段、
 * 改一个布尔再跑用例），模块级常量会读到改写前的陈旧值 ⇒ 反向验证失效」——
 * **该机制在本仓库不存在**，实测如下：
 *
 * - `PROVIDER_REGISTRY` 是 `Object.freeze([...])`（且有用例锁 `Object.isFrozen`）
 *   ⇒ **运行时无法改写**；搜 `PROVIDER_REGISTRY.push/splice/sort/...` 与
 *   `vi.mock('.../provider-registry')` 全仓 **0 命中**。
 * - 本仓库的反向验证真实形态是**改源文件**再跑（Task 11 的 RV1/RV2 就是如此）。
 *   改源文件后 vitest 每个测试文件在**独立模块图**里重新加载 ⇒ **模块级常量也会
 *   重新求值、不会陈旧**。实测对照：把 `zcode` 的 `channel` 改 `false`，
 *   用模块级常量的文件 **1 红**、用函数调用的文件 **2 红** —— 两侧都捕到。
 *
 * 那为什么仍优先用函数？因为它让「期望集合的求值」与「测试文件的顶层求值时机」
 * 解耦：调用方普遍在 `beforeEach` / 用例体内现取（并各自 `.sort()` 副本），
 * 不依赖「本文件被 import 的那一刻 registry 已经是什么样」，也避免将来引入
 * `apply()` 期注册、`vi.mock` 或 `vi.resetModules` 时踩到模块级快照。
 * ⇒ 结论（用函数）不变，但**理由要写成「时机解耦 / 鲁棒性」**。
 *
 * ⚠️ 反例（**刻意保留的手写清单**）：`tests/helpers/rpc-refresh.ts` 的
 * `EXPECTED_REFRESH_PROVIDER_IDS` 与 `tests/unit/jet-hub-rpc-auth-wiring.spec.ts`
 * 的 `EXPECTED_AUTH_PROVIDER_IDS` 是**模块级常量**（`= expectedProviderIdsWithAuth()`）。
 * 它们在当前机制下**同样有效**（见上对照实验）；若将来真要防「常量快照」，
 * 应改的是这两个调用点，而不是本文件的理由。
 *
 * ## ⚠️ 为什么这些判据不该由 `src/` 导出
 *
 * 它们是**测试的期望**（「我认为谁该有 auth」），不是生产契约。放进 `src/`
 * 会让「生产代码自己声明该接受什么」—— 那等于把守卫换成同义反复
 * （`AUTH_SERVICE` 与它比对就恒真了，这正是本仓库 2026-10-08 复审 Finding 1
 * 记录过的形态）。故留在 `tests/helpers/`。
 */

import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'

/**
 * 不占 auth 键位的两个 registry provider —— **理由不同，故必须分别被验证**。
 *
 * ⚠️ 这是一张**硬编码的豁免表**，不是「顺手写的名单」：registry 里**没有**
 * 「有没有 auth 服务」这个字段（`channel` 只表示「有没有账号/凭据/积分」），
 * 而唯一形似的字段 `settingsNamespace` 是**巧合而非语义**（它表示老契约
 * settings namespace；opencode 恰好是唯一没有它的 `channel`）—— 本仓库
 * AGENTS.md 明确反对用巧合字段推断语义（「用布尔而不是『有没有 accountExtras』
 * 来推断：那是巧合而非语义」）。故豁免只能显式列出，并由用例**验证理由**。
 *
 * ⚠️ 2026-10-08（Task 11-F）：本表原先定义在 `jet-hub-rpc-auth-wiring.spec.ts`，
 * 而 `channel` + 本表的判据在**四个文件里各写了一遍**—— 实测四处**集合完全相同**
 * （都是 13 家）。现集中到本文件，四处同读这一份，去掉三份硬编码副本。
 * ⚠️ 理由的**验证**仍留在 `jet-hub-rpc-auth-wiring.spec.ts`（它会调 `AUTH_SERVICE`，
 * 而 `AUTH_SERVICE` 在 apply 的作用域里，helper 拿不到）。
 */
export const AUTH_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['opencode', '它的 RPC 由 handleMethod 统一分派到 handleOpencodeRpc，没有 XxxAuth 服务'],
  ['aggregate', '它没有账号 / 凭据 / 续期（registry 的 channel: false）'],
])

/**
 * **期望**占 auth 键位 / 该注册进能力表 / 该进批量续期表的 provider id 集合
 * —— 唯一判据：`channel: true` 减去 {@link AUTH_EXEMPT}。
 *
 * ## ⚠️ 为什么四处共用一个函数，而不是各写一遍 `.filter((d) => d.channel && …)`
 *
 * 本次重构（Task 11-F）实测：同一判据在四个文件里出现，形态有**两种**——
 * 三处写 `d.id !== 'opencode'`（硬编码字面量），一处写 `!AUTH_EXEMPT.has(d.id)`
 * （带理由表）。两种形态**实测集合相同**（都是 13 家），但失效行为不同：
 *
 * - 硬编码那三处**没有理由**，新增一个「有账号但没有 auth 服务」的 provider 时，
 *   后人只能靠猜「为什么偏偏是 opencode」；
 * - 更糟的是它们**各自独立**：改一处漏另两处 ⇒ 三处断言对「13」的期望分叉，
 *   而症状是三条看起来无关的用例一起红。
 *
 * ⚠️ 被测对象各不相同（`AUTH_SERVICE` / `wiredRefreshTargets()` /
 * `registeredRuntimeIds()` / `REFRESH_PROVIDERS`），故**不构成**红线 #1
 *（一个语义两套判据）—— 语义（「谁该有 auth」）只有这一份，
 * 被测对象有四份，那正是用例该有的样子。⚠️ 注意它与
 * {@link expectedProviderIdsInCreditsTable} 是**两个不同的语义**（13 vs 11），
 * 别因为「都排除了 opencode」就把两者当成一份。
 */
export function expectedProviderIdsWithAuth(): string[] {
  return PROVIDER_REGISTRY
    .filter((d) => d.channel && !AUTH_EXEMPT.has(d.id))
    .map((d) => d.id)
}

/**
 * 声明了余额能力（`credits.balance === true`）却**刻意不进**生产积分表的渠道。
 *
 * 判据见 `src/provider-credits.ts` 的模块头（「哪些渠道不在这里」一节）：
 *
 * - `opencode`：它的「余额」是**本地派生的通道可用性**（读账号池的
 *   `modelRateLimits`），**零网络请求**。套进 `fetchBalance(credential, …)`
 *   形状会逼它去发一个不存在的上游请求。
 * - `qoder` / `qodercn`：余额原语只吃 `QoderCredential`、且 product 来自同族
 *   注册表，**与共享骨架的 `(credential, product)` 泛型不兼容**。
 * - `officeace`：余额是**云侧 V11 签名直读**（`GET /v1/subscription`），
 *   凭据是 STS 三元组、签名逻辑封装在 `officeace-auth.ts` 内部 ——
 *   **没有** `fetchBalance(credential)` 这个可注入点。与 `qoder` 同属
 *   「形态套不进骨架」，故在 `credits.balances` 里作为特例短路（2026-10-12）。
 *
 * ⚠️ 与 {@link AUTH_EXEMPT} **不是同一张表**（虽然都含 `opencode`）：
 * 那张是「没有 auth 服务」，这张是「余额形态套不进骨架」。两者各自有
 * 独立的验证用例，别合并。
 */
export const CREDITS_TABLE_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['opencode', '余额是本地派生的通道可用性（零网络），套 fetchBalance 形状会发不存在的请求'],
  ['qoder', 'fetchQoderCreditBalance 只吃 QoderCredential，与共享骨架的泛型不兼容'],
  ['qodercn', '同 qoder（两者复用同一个 QoderAuth，余额原语同形）'],
  ['officeace', '余额是云侧 V11 签名直读（STS 凭据 + 签名在 auth 模块内），没有 fetchBalance 注入点'],
  // ⚠️⚠️ **2026-10-17：modelscope 已从本表移除**（本 fork 独有）。
  //    它原先登记的理由是「平台没有额度查询 API（12 个候选路径全 404）」——
  //    **那条结论是错的**，错在**前缀**：真端点在 `/openapi/v1/`（不是 `/api/`、
  //    也不是 `/v1/`）⇒ `GET https://www.modelscope.cn/openapi/v1/magicubes/balance`
  //    带 API Key 返 200，且实测**随推理消耗下降**（281 → 发 2 次推理 → 277）。
  //    ⇒ 它现在有真实的 `fetchBalanceDetailed`，**必须**进生产积分表。
  //    ⚠️ 留这段墓碑注释是因为：本表曾收录过它，若后人只看 git blame 会以为
  //    「当初就该收进来」，而真实经过是「收进来又移出、现在又收回来」。
  //
  // ⚠️ 百智云（2026-11-02，同日二版更正）：**它已不在本表里**。
  //    一版曾以「上游根本没有余额/积分接口」为由收录它 —— 那个结论是**错的**：
  //    控制台 `GET /api/v1/user/wallet/balance`（cookie 认证，非 `x-api-key`）
  //    如实返回 `{balance, temporary_credit_cents, permanent_credit_cents, …}`。
  //    ⇒ registry 的 `credits.balance` 现在是 `true`，它进了生产积分表
  //    （`src/provider-credits.ts` 的 `baizhi` 分支），本表不再收录。
  //    留这段墓碑注释是因为：只看 git blame 会以为「当初就该排除」，
  //    真实经过是「排除 → 实测到接口 → 收回来」。
])

/**
 * **期望**进生产积分表（`createProviderCredits()`）的 provider id 集合
 * —— 唯一判据：`credits.balance === true` 减去 {@link CREDITS_TABLE_EXEMPT}。
 *
 * ⚠️ 判据是 `credits.balance === true`（**声明了余额能力**）而不是 `channel`。
 *
 * ⚠️⚠️ **但两者的「取值集合当前恰好一致」—— 不要写成「实测不等价」**
 * （2026-10-08 独立复审修正；原注释声称「`aggregate` 的 `balance` 是 `false`
 * 而它同时也不是 `channel`」，**该论据是错的**：`aggregate` 两边都是 `false`，
 * 证明不了任何差异）。
 *
 * 实测（15 家 descriptor，逐个比对）：`channel === true` 与
 * `credits.balance === true` **各 14 家、id 逐字相同**，双向差集皆空；
 * 把本函数的判据换成 `channel`，产出**仍是同一个 11 元素集合**。
 * 13 vs 11 的差额**全部来自两张豁免表**（`qoder` / `qodercn` 只在
 * {@link CREDITS_TABLE_EXEMPT} 里），与判据无关。
 *
 * 那为什么仍要用 `credits.balance`？因为它才是**声明语义**的那一个：
 * `channel` 表达「有没有账号 / 凭据 / 积分」，`credits.balance` 表达
 * 「声明了余额能力」—— 两件事。当前取值一致是**巧合**（且已出现语义分叉的
 * 苗头：`opencode` 的 `balance: true` 语义其实是「通道可用性」而非余额，
 * 见 `CREDITS_TABLE_EXEMPT` 的理由）。一旦将来某家声明了 `balance` 却不
 * `channel`（或反之），用错判据就会把「声明了余额却没进表」的真漏接**掩盖过去**。
 * ⇒ 结论（用 `balance`、两张表不合并）不变，但**理由必须是「语义不同」，
 * 不能是「实测不等价」**。
 *
 * ⚠️ 2026-10-08（Task 11-F）：本判据原先在 `credits-runtime-parity.spec.ts`
 * （**同一文件里两处**）与 `provider-runtime-wiring.spec.ts` 里各写了一遍
 * （三份 `new Set([...])` 硬编码），现收敛到这里。
 */
export function expectedProviderIdsInCreditsTable(): string[] {
  return PROVIDER_REGISTRY
    .filter((d) => d.credits.balance === true && !CREDITS_TABLE_EXEMPT.has(d.id))
    .map((d) => d.id)
}

/**
 * **会写 `modelRateLimits`、却刻意不注册 probe 的 provider**（Task 8 复审补齐）。
 *
 * ## ⚠️ 此表的语义与前面两张**都不同**，不要合并
 *
 * 前面两张回答「谁该有 auth」「谁该进积分表」；这张回答
 * 「**谁有可清的限流标记、却拿不到探测材料**」。
 *
 * 判据（机械可核，写在这里以免后人靠记忆）：
 *
 *     grep -n 'updateModelRateLimit(' src/*.ts    # 池侧写点
 *     grep -n 'markLimited' src/*.ts              # 适配器侧注入点
 *
 * ⚠️ **不要在这里抄名单或数字**：本段曾写「会写标记的共 **13 家**」并紧跟 13 个
 * 名字，2026-10-11 加入 `minimax`（issue IKJW32：它接上了请求级换号 + 冷却，
 * 于是**开始写** `modelRateLimits`）后当场过期 —— 而同一段文字里还写着
 * 「名单**不要在这里抄**」，自相矛盾。权威清单是
 * {@link WRITES_RATE_LIMIT_PROVIDERS}（守卫把它与源码写点**双向**比对，
 * 漏一家 / 多一家都点名变红）；`src/index.ts` 的 `probeById` 必须**恰好**
 * 登记同一批家 ⇒ **本表当前为空**（见 {@link PROBE_EXEMPT}）。
 *
 * ⚠️ **`opencode` 曾在这里，那条豁免理由是错的**（2026-10-08 第二轮实测证伪，
 * 逐条反驳写在该常量自己的文档里）。教训与本仓库其它几次同型缺陷一致：
 * **「拿不到材料」必须写成可复现的核对步骤**，只写结论就会把「漏挂」
 * 长期伪装成「不需要」。当时该缺口是**用户可见**的 —— `opencode` 没有
 * `rateLimit: false` 豁免 ⇒ 客户端「重测」按钮**会渲染**（门控是
 * `supportsRateLimit`，缺省 `true`）⇒ 用户点了必报「没有探测适配器」。
 *
 * ## 当前为空 —— 且这是**修好之后**的状态，不是「从来如此」
 *
 * 此前这里登记着 `opencode`，理由写的是「探测入参只有一个账号的凭据，而它的
 * 适配器需要整个 `identitySlots` 序列 + 池条目 id（`slotId` 与 `refName` 不是
 * 同一键空间）；补它要给 `ProbeDeps` 加池透传，属**接口扩张**」。
 *
 * ⚠️ **该理由已逐条实测证伪**（2026-10-08 第二轮）：
 *
 * - **不需要整个序列**：探测只要**它自己那一个**槽 —— `OpencodeAdapter.stream()`
 *   只调 `identitySlots()` 取序列，**不读目录**（`fetchRemoteCatalog` 仅在
 *   `catalog()` 内使用，而探测本就不该拉目录），且探测路径刻意不传 `markLimited`；
 * - **不需要池**：`probeWithAdapter` 手上已有完整的 `ProviderAccountEntry`，
 *   它带着权威的代理（`opencodeProxy`）与指纹代次（`opencodeFingerprintGeneration`）
 *   —— 而这两样的权威**恰恰在池里、不在凭据里**（`AccountPool.setOpencodeProxy`
 *   只写池条目，不回写凭据）；
 * - **`slotId` / `refName` 键空间差异不成立**：探测不调 `markLimited`，
 *   没有任何「按 slotId 写回」的动作，两者根本不会相遇。
 *
 * ⇒ 真正缺的只有「把 `entry` 交给工厂」这一件事，已给
 * `probe.createProbeAdapter` 加了**可选**的第三参（纯放宽，其余各家的适配器不受影响），
 * 槽由 `poolEntrySnapshot` 造（与主接线块**同一实现**，不写第二份派生）。
 *
 * ## 为什么保留这张空表而不是删掉
 *
 * 它的**存在**本身就是判据：{@link expectedProviderIdsWithProbe} 与
 * `provider-runtime-wiring.spec.ts` 的守卫都按「会写标记 **−** 豁免」派生。
 * 将来若真出现形态确实不匹配的家，把 id 与**可核对的**理由填进来即可；
 * 守卫会同时强制「豁免的家确实会写标记」且「不得同时出现在注册表里」。
 *
 * ⚠️ 填理由时必须写**可复现的核对命令**，不要只写结论 —— 上面那条被证伪的
 * 理由就是「写了结论、没写怎么核对」的产物。
 */
export const PROBE_EXEMPT: ReadonlyMap<string, string> = new Map()

/**
 * **期望**注册进 `src/index.ts` 的 `probeById`（可重测）的 provider id 集合
 * —— 唯一判据：**会写 `modelRateLimits`** 的家减去 {@link PROBE_EXEMPT}。
 *
 * ## ⚠️ 为什么不能直接写 `channel − PROBE_EXEMPT`
 *
 * 会写标记的家**不等于** `channel: true` 的家（`aggregate` / `auto` 这类
 * 没有自己账号的通道就不会写）⇒ 用 `channel` 当判据会误报。
 *
 * ⚠️ **`minimax` 从「不写」变成「会写」是 2026-10-11 的 issue IKJW32**：
 * 它此前**全文件零命中** `updateModelRateLimit` / `getAvailableAccount`
 * （14 家里唯一），故当时被排除在本清单之外；接上请求级换号 + 冷却后
 * 额度 24h / 限流 1h 的标记会真的写进池 ⇒ 必须同时进
 * {@link WRITES_RATE_LIMIT_PROVIDERS} 与 `probeById`（否则标记写进去却
 * 永远清不掉）。判据是「**现在**写不写」，不是「曾经写不写」。
 *
 * ## ⚠️ 为什么这张清单硬编码在这里（而不是从 registry 派生）
 *
 * 「写不写限流标记」是**代码事实**，registry 里没有这个声明字段。硬编码的风险是
 * 「有人加了写点却忘了更新本清单」—— 故 `provider-runtime-wiring.spec.ts` 额外
 * 做一件事：对清单里每一家**去源码里找它的写点证据**（`markLimited` 注入或
 * `updateModelRateLimit` 调用），找不到即红。这样漏更新本清单时**同样会红**，
 * 而不是静默通过。
 */
export const WRITES_RATE_LIMIT_PROVIDERS: readonly string[] = Object.freeze([
  'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'cline',
  'zcode', 'trae', 'gemini', 'codearts', 'loomy', 'raccoon', 'opencode',
  'minimax',
// ⚠️ minimaxintl（MiniMax Code 国际版，2026-10-15）：与 `minimax` **共用同一个
  //    `MinimaxAdapter` 类** ⇒ 它同样会写 `modelRateLimits`（额度 24h / 限流 1h）
  //    ⇒ 必须同时进 `probeById` 与 `WRITES_RATE_LIMIT_PROVIDERS`，否则该站的
  //    限流标记**写进去却永远清不掉**（用户点「重测」报「没有探测适配器」）。
  'minimaxintl',
  // ⚠️ **本 fork 独有**（modelscope，2026-10-16）：它**会写** `modelRateLimits`
  //    （见 `modelscope-adapter.ts` 的 `modelscopeRetryAfterMs`）。漏登记 =
  //    标记写进去却在 `probeById` 里查不到 ⇒ 「重测 / 重置」清不掉（该陷阱已复发过）。
  'modelscope',
  // ⚠️ **本 fork 独有**（qiniu，2026-10-29）：它**会写** `modelRateLimits`
  //    （见 `qiniu-adapter.ts` 的 `qiniuRetryAfterMs`：429 指数退避 / 额度类对齐
  //    UTC+8 次日零点）。漏登记 = 标记写进去却在 `probeById` 里查不到 ⇒
  //    「重测 / 重置」清不掉（该陷阱已复发过五次）。
  'qiniu',
  // ⚠️ accio（Accio 阿里，2026-10-18 / issue IKM3ZV）：接上请求级换号 + 冷却后
  //    **会写** `modelRateLimits`（额度至 UTC+8 当日 24:00 / 限流 1h）。
  //    它**曾**登记为「不写标记」，而那正是本 issue 的成因之一：换号接上后若漏本行，
  //    标记写进去却永远清不掉 —— 与 minimax / modelscope 完全同型。
  'accio',
  // ⚠️ **本 fork 独有**（codely，2026-10-20）：接上请求级换号 + 冷却
  //  （`codely-adapter.ts` 的 `updateModelRateLimit` 写点：402/预算耗尽 →
  //  UTC+8 次日 0 点、429 → 1h；探测适配器已挂 `probeById.codely`）。
  //  漏登记 = 标记写进去却永远清不掉（minimax / modelscope 同型）。
  'codely',
  // ⚠️ **本 fork 独有**（MonkeyCode，2026-11-02）：接上请求级换号 + 冷却后
  //    **会写** `modelRateLimits`（`monkeycode-adapter.ts` 的 `markLimited` →
  //    `updateModelRateLimit`：额度耗尽 → 24h、429 → 1h；`auth` 类刻意不写，
  //    因为换账号本来就该由用户处理，把凭据问题记成模型限流只会掩盖真因）。
  //    漏登记 = 标记写进去却在 `probeById` 里查不到 ⇒ 「重测 / 重置」清不掉。
  'monkeycode',
  // ⚠️ 国际站（2026-11-02）：与国内站是**同一个适配器类的两个实例** ⇒ 同样会写
  //    `modelRateLimits`。漏登记 = 国际站的标记写进去却在 `probeById` 里查不到
  //    ⇒ 用户点「重测 / 重置」报「没有探测适配器」，且冷却永不解除
  //    （与 `minimaxintl` 同型同因）。
  'monkeycodeintl',
  // ⚠️ **本 fork 独有**（百智云，2026-11-02）：`baizhi-adapter.ts` **会写**
  //    `modelRateLimits`（429 → 冷却、402 额度耗尽 → 对齐 UTC+8 次日零点；
  //    走注入的 `markLimited`，未注入时回退 `accountPool.updateModelRateLimit`）。
  //    漏登记 = 标记写进去却在 `probeById` 里查不到 ⇒「重测 / 重置」清不掉
  //    （与 monkeycode / qiniu 同型同因）。
  'baizhi',
  ])

/** **期望**注册进 `probeById` 的 provider id（会写标记 − {@link PROBE_EXEMPT}）。 */
export function expectedProviderIdsWithProbe(): string[] {
  return WRITES_RATE_LIMIT_PROVIDERS.filter((id) => !PROBE_EXEMPT.has(id))
}
