/**
 * provider 的**行为能力注册表** —— 「按 provider id 找到它那套能力实现」的唯一入口。
 *
 * ## 它解决什么
 *
 * 重构前，RPC 层用 `switch (provider)` / 一长串 `else if` 分派到各家实现。
 * 实测（设计文档 §1.3）三类形态：
 *
 * | 形态 | 例子 | 分派点数 |
 * |---|---|---|
 * | **纯重复**：各分支做同一件事 | `account.refresh` 13 个 case **逐字同构** | 13 |
 * | **同构骨架 + 参数差异** | `credits.balances`（441 行）/ `credits.claimAll`（267 行） | 14 / 15 |
 * | **真协议差异** | qoder WASM 签名、codearts HMAC、trae 身份头 | 已封装在各家模块内 |
 *
 * 前两类里 RPC 层看到的**全是「选哪个函数」而不是「做什么逻辑」** ——
 * 那正是本注册表要消除的。第三类**不动**：协议实现留在各家模块内。
 *
 * ## ⚠️ 边界（别把这里做成「一套配置驱动所有 provider」）
 *
 * 抽象的是**编排**（选哪个原语、按什么顺序），**不是协议**（原语内部怎么实现）。
 * 故各家的 `*Expiry` / `fetch*Balance` / `claim*` 等原语函数**原样保留**，
 * 本文件只是把它们挂到一张可查的表上。
 *
 * ## ⚠️ 能力域全部可选，「不支持」用 `undefined` 表达
 *
 * RPC 层据此返回**既有的可读错误文案**（例如 cline 的「Cline 不支持每日签到
 * （其后端没有签到接口）」），**不得**退化成泛化的 `unsupported provider`
 * —— 后者会让排查者以为「provider 没注册」，而真相是「该产品无此能力」。
 * 这是本仓库反复记录过的缺陷形态。
 *
 * ## ⚠️ 本表与 `account.refresh` 的分派**无关**（2026-10-08 调序后修正）
 *
 * 初稿计划让 `account.refresh` 经本表分派，但 Task 9 已把 13 个 auth 实例变成
 * `registerJetHubRpc` 的**命名对象形参** `auths`，而 `account.refresh` 的 switch
 * 就在同一个闭包内 ⇒ 那里直接查 `authOf(auths, entry.provider)` 即可
 *（零全局状态、测试零改动，见 `jet-hub-rpc.ts`）。
 *
 * 本表的消费点是**拿不到 `auths` 形参**的跨模块场景（Task 5 的
 * `aggregate-expiry.ts`、Task 8 的 `account-probe.ts`）。
 *
 * ## ⚠️ 依赖方向：本文件**不得** import 上层模块
 *
 * `aggregate-expiry.ts`（Task 5 起的**真实生产消费者**）import 本文件；
 * 反过来本文件**只** import `provider-registry.ts`（纯数据）与 `account-pool.ts`
 * （**仅类型**）⇒ **无环**。这条方向是刻意维持的：
 * `aggregate-expiry.ts` 的模块头记着一条红线 —— 它若依赖聚合适配器就是
 * 「层次颠倒」（`auto-adapter.ts` 也要复用它）。本表是**底座**，故不得反向
 * 依赖任何聚合侧模块；将来要在这里加 import 时先确认这一点。
 */

import type { ProviderDescriptor } from './provider-registry.js'
// ⚠️ 只导入**类型**：本模块是运行时注册表的宿主，不该把缓存的实现拉进来
//（实现由 `src/index.ts` 建好后注册，见 `registerBalanceCache`）。
import type { BalanceCache } from './balance-cache.js'
import type { AccountPool } from './account-pool.js'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { CheckinStatus, ClaimOutcome, CreditBalance } from './credits.js'
import type {
  ProviderAccountEntry,
  RpcBuddyGrowthAccountResult,
  RpcCreditsBalanceExtra,
  RpcOnboardingClaimResponse,
  RpcOnboardingStatusResponse,
} from './types.js'

/**
 * 调用上下文：把共享设施注入给各家实现，避免它们各自持有 ctx。
 *
 * ⚠️ 只放**跨 provider 通用**的东西。各家私有的依赖（product 配置、fetch 包装）
 * 由各家在注册时闭包捕获。
 *
 * ## ⚠️ 三个字段的**读取实况**（Task 11-G 逐个实测后登记）
 *
 * 本仓库的惯例是「如实登记只被测试读 / 无读者的域」，免得下一个读者满仓找消费方
 * （同款登记见 `ProviderRuntime` 的 `auth.refreshAccount` / `credits` / `onboarding`）。
 * 本接口**更该登记**，因为它的读者比那些域**更少**。
 *
 * ⚠️ **查读取者时不要 grep 类型名 `ProviderCallContext`** —— 实测那是
 * **假阴性**：实现侧的形参叫 `call`，类型靠推断、**不写类型名**，故在
 * `provider-credits.ts` 里 grep 类型名得 **0** 次，而字段其实**有**活的读者。
 * 正确做法是 grep `call.<字段名>`。
 *
 * | 字段 | 实现侧真实读取 | 说明 |
 * |---|---|---|
 * | `accountPool` | **2 处** | ✅ **活的**：`provider-credits.ts` 里 TRAE 的 `claim` 读写设备指纹代次（这是 `claim` 必须收 `entry` 的唯一理由）|
 * | `resolveCredential` | **0 处** | 实现侧目前都自带凭据解析路径（各 auth / 适配器有各自的 `resolveCredential` 选项），未经本字段 |
 * | `warn` | **2 处** | AutoClaw 的 `claim`（2026-10-27 起：刷新失败 / 轮换落盘失败必须出声）；其余实现仍用 `console.warn` 绕过本出口 |
 * | `persistCredential` | **1 处** | AutoClaw 的 `claim`（2026-10-27 新增：刷新**轮换**出的 `refresh_token` 必须写回，否则账号续期能力被逐日烧掉）|
 * | `accountId` | **1 处** | Gemini 的出口代理选择 |
 *
 * ⚠️ **`resolveCredential` / `warn` 零读取是「尚无」而非「无用」**：
 * 两者都是实现侧**本该**走的共享入口（`warn` 尤其 —— 绕过它意味着告警不进宿主
 * 日志，只在控制台），保留它们是为了让新实现有正路可走。
 * 故这里是**登记**而不是删除；若将来确认永远不会有读者，再一起删。
 */
export interface ProviderCallContext {
  /** 按 ref 名解析凭据（返回**原始字符串**，由各家自己 parse + 形状校验）。 */
  readonly resolveCredential: (refName: string) => Promise<{ value: string } | undefined>
  /** 日志出口（两级可选链语义：logger 缺席时静默）。 */
  readonly warn: (message: string) => void
  /** 账号池（少数实现需要，如 TRAE 的设备指纹代次读写）。 */
  readonly accountPool: AccountPool
  /**
   * 本次查询所属的**账号池条目 id**（Gitee issue IKLTZ2 起）。
   *
   * ⚠️ **刻意新增**而不是让各家自己按 ref 反查：账号 id 与 `credentialRef`
   * 之间**没有可逆映射**（ref 由 RPC 随机生成），而「按账号取出口代理」
   * （Gemini）必须知道 id。空串/未提供 = 「不知道是谁」⇒ 实现应当直连，
   * **不得**猜一个账号去用它的出口（那是把请求发到错误的出口上）。
   */
  readonly accountId?: string
  /**
   * 把**续期/刷新后**的凭据写回 store（2026-10-27 新增，Gitee PR #153 审计 P0）。
   *
   * ## 为什么需要它
   *
   * `claim` 这类能力内部会做「刷新 token 以制造一次登录事件」（AutoClaw 的活动
   * 奖励由**登录事件**触发）。而刷新**可能轮换 `refresh_token`**（OAuth 2.1 RTR）
   * —— 一旦轮换而新值没人接住，旧值立即作废 ⇒ 账号的续期能力被**逐日烧掉**，
   * 表现为 `RefreshTokenExpiredError` → `refreshable:false` → 要求重登，
   * 而重登拿到的 token 又会在下一次刷到时被同样烧掉。
   *
   * ⚠️ 判据不是我猜的：`src/jet-hub-rpc.ts` 的续期注释明写「续期**会轮换**
   * refresh_token」，同 provider 的 `autoclaw-auth.ts` 那条腿**会**
   * `credentials.set` 落盘 ⇒ 同一字段两套口径；而
   * `docs/agent-notes/providers-autoclaw.md` 把「续期端点是否仍接受这批
   * refresh_token」登记为**未测**。⇒ 给刷新腿一条正规的落盘出口，
   * 让它与既有续期腿同源，而不是各自决定要不要存。
   *
   * ⚠️ 与 {@link resolveCredential} **同源**：两者都按 ref 名操作，实现方
   * 与调用方共用同一套 ref 约定（不要自己拼 ref）。
   */
  readonly persistCredential?: (refName: string, value: string) => Promise<void>
}

/**
 * 临期折算的**可选上下文**（`ProviderRuntime.expiry.credentialExpiry` 的第二参）。
 *
 * ## ⚠️ 为什么把它命名导出（而不是在签名里内联一个匿名对象类型）
 *
 * 真实缺陷（本机自查，2026-10-12）：这个形状原先被**抄写了三份** ——
 * 本文件一份、`aggregate-expiry.ts` 的 `credentialExpiry` 与 `zcodeExpiry`
 * 各一份。三份必须逐字段一致，而**没有任何机制保证**：
 * 给某一处加字段（或改某字段的可选性/类型）时，另一处不会报错，
 * 只会让「传进去的字段被静默忽略」或「实现方看不到新字段」。
 *
 * ⇒ 收敛成**一个命名类型**，三处共用。这是本仓库首条红线
 *（「同一语义两套判据」）在类型层的同一手法。
 *
 * ## 为什么全部字段可选
 *
 * 只有 zcode 用得上它们（另 6 家的折算与账号 id 无关）。全部可选 ⇒
 * 另外 6 家的实现忽略第二参即可，**一行都不用改**（G3「零行为变化」）。
 * ⚠️ 实现方**不得**因为 `context` 缺席就改变返回值：缺席只意味着
 *「写不了标记」（副作用做不了），**不是**「不知道该模型可不可用」。
 */
export interface ProviderExpiryContext {
  /** 该凭据所属的**账号池条目 id**（写 `modelRateLimits` 用）。 */
  readonly accountId?: string
  /**
   * 该凭据所属账号的 **`credentialRef`**（多账号余额查询用）。
   *
   * ⚠️ **与 `accountId` 不是一回事**，两者都要有：
   * `accountId` 是池内条目 id（`zcode` 写 `modelRateLimits` 用），
   * `credentialRef` 是凭据库里的 ref 名。**officeace 需要后者** ——
   * 它的余额入口 `fetchSubscriptionSummary(staleHours, ref, …)` 只有传了 `ref`
   * 才走**云侧直读**；不传会回落到果办客户端的**全局单一 cookie**（只反映
   * 「当前登录在果办里的那一个账号」）⇒ 多账号下所有账号折算成同一个余额
   * （实测两个账号都显示 6500），而聚合候选排序是**每账号**粒度 ⇒ 会选错人。
   *
   * ⚠️ 其余家忽略本字段（与 `catalogIds` 同一模式：可选能力由实现自己声明）。
   */
  readonly credentialRef?: string
  /**
   * 该渠道的**全部目录模型 id**（惰性求值 —— 只有真的调它才会读目录）。
   *
   * ⚠️ **必须是函数**：另外 6 家的实现**完全不碰它**，若传一个已求值的数组，
   * 每轮折算都会为它们白读一次目录（本仓库反复记录的成本）。
   *
   * ⚠️ 渠道目录读不到时由调用方降级为「只有第一个模型」的数组（可能为空）。
   */
  readonly catalogIds?: () => Promise<readonly string[]>
  /**
   * 把「某账号在这些模型上确定已无额度」写成**持久标记**。
   *
   * ⚠️ 由调用方（`aggregate-expiry.ts`）注入，**实现方不自己 import 账号池**
   * —— 那条依赖会让本模块反向依赖上层（见模块头的层次约束）。
   * ⚠️ 缺席时实现方**照常返回折算值**，只是不写标记。
   * ⚠️ 传入的模型 id 必须是**目录形态**（见 `zcode-entitlements.ts`
   * 的 `exhaustedModelsOf`：上游小写 vs 目录大写的**成败点**）。
   */
  readonly markModelsExhausted?: (accountId: string, modelIds: readonly string[]) => Promise<void>
  /**
   * **清除**「某账号在这些模型上已无额度」的标记（额度恢复时用）。
   *
   * ## ⚠️⚠️ 为什么必须与 `markModelsExhausted` 成对（真实缺陷 —— 单向门）
   *
   * 只写不清会把标记变成**单向门**：zcode 的免费额度按自然日结算，用户
   * **当天**烧光后去签到又领到额度（或上游调整）时，标记仍挂到次日 0 点 ⇒
   * 「签到成功了但当天用不了」。本仓库对单向门有事故史（`refreshable`）。
   *
   * ⚠️ 实测确认光靠**签到路径**救不回来：`credits.claimAll` 成功只清折算缓存、
   * 不清 `modelRateLimits`（`scripts/verify-zcode-mark-after-claim.mjs`）。
   * ⇒ 自愈必须发生在**下一次折算**（那时已经拿到新的余额报文）。
   * ⚠️ 缺席时实现方照常返回折算值，只是清不掉旧标记。
   */
  readonly clearModelsExhausted?: (accountId: string, modelIds: readonly string[]) => Promise<void>
  /**
   * **共享余额读数**入口（2026-10-15，`src/balance-cache.ts` 的消费者之一）。
   *
   * ## ⚠️ 为什么需要它（规格 §5.7 的分层）
   *
   * 「账号积分缓存是更底层基础设施，取号逻辑只是在调用缓存时的取舍」——
   * ⇒ buddy 系四家的折算原语原先**自己发一次余额请求**（`fetchCreditBalance`），
   * 而积分面板 / 用量徽标也各发一次 ⇒ 同一个账号在一分钟内被查 2~3 次。
   * 本字段让折算**吃同一份读数**（`balance-cache` 按 `(provider, accountId)` 去重）。
   *
   * ## 契约
   *
   * - 返回 `undefined` ⇒ **本次没有共享读数可用**（未注入 / 未命中且取数失败）。
   *   实现方必须**回落到自己发请求**（`fallback`）：折算的可用性**不得**依赖本字段
   *   —— 否则「未接线」会变成「该渠道折算恒 UNUSABLE」（静默少一个候选，正是本仓库
   *   复发过三次的形态）。
   * - 抛错 ⇒ 由实现方按自己的既有口径处理（buddy 系是「折算成 `UNUSABLE`」）。
   *   ⚠️ **但中止必须逃逸**：本入口可能网络取数。
   *
   * ⚠️ 只有**形态匹配**的渠道该用（buddy 系四家的 `CreditBalance`）；其余渠道
   * （officeace 的套餐摘要、zcode 的分桶、loomy 的命名池）**形态不同**，接入前
   * 要先把原语拆成「取数」与「折算」两段（规格 §5.7.3 的「登记待接」）。
   */
  readonly cachedBalance?: (accountId: string | undefined) => Promise<unknown>
}

/**
 * 一个 provider 的能力实现。
 *
 * ⚠️ **每个域都可选**：provider 只实现自己有的能力，`undefined` 即「不支持」。
 * 这样 cline 不必假装实现 `credits.claim`，aggregate 不必假装有 `auth`。
 */
export interface ProviderRuntime {
  /** 元数据（与 `PROVIDER_REGISTRY` 里那条同源，带上省一次查表）。 */
  readonly descriptor: ProviderDescriptor

  /**
   * 账号续期。
   *
   * ⚠️ 重构前 `account.refresh` 的 13 个 case 是**同一行调用**
   *（`auth.refreshAccountCredential(entry.credentialRef, pool, entry.id)`），
   * 只有实例名不同。
   *
   * ⚠️ **opencode 刻意没有本域**：它不参与续期（凭据是静态 API key）。
   * 它的 `account.refresh` 应返回可读错误，而不是被交给自己去刷一个不存在的端点。
   */
  readonly auth?: {
    /**
     * 续期**指定账号**。
     *
     * ⚠️ `pool` 与 `accountId` **必须都传**（issue !IKIRTT）：续期成功后要把新的
     * `expiresAt` 写回账号池，UI 才不再显示「已过期」。早先只有 raccoon 传了、
     * 其余七个分支漏传 —— 凭据续好了、界面纹丝不动，用户没有任何自救手段。
     *
     * ## ⚠️ 本字段**当前只被测试读**，生产路径**永远不会**消费它（Task 2 复审 Finding 6）
     *
     * 如实登记，免得下一个读者满仓找消费方：
     * - `account.refresh` 走 `registerJetHubRpc` 的 **`auths` 形参**
     *  （`authOf(auths, entry.provider)`），**不查本表**（见本文件模块头）；
     * - Task 5 的 `aggregate-expiry.ts` 只用 `expiry`；
     * - Task 8 的 `account-probe.ts` 用 `probe`；
     * - Task 10 读的是 `auth.refreshAll` —— ⚠️ 该字段**由 Task 10 自己加进来**
     *  （见计划 Task 10 的「auth 域补 `refreshAll?`」），不是本 Task 的产物。
     *
     * ⚠️ **Task 3 曾计划由本字段提供 `usesExpiryWindow`，执行时改为直接读
     * `descriptorOf(provider)`**（见 `jet-hub-rpc.ts` 的 `credits.balances`）——
     * 本表与 `credits` 表是**两条独立的接线**，让 `credits.balances` 同时依赖
     * 两者只会多一个「哪份没接上」的失败面。`descriptorOf` 是纯数据查表，
     * 零状态，与全局注册表无关。故本字段**仍未**有生产消费者。
     *
     * ⇒ 它的**唯一**消费者是 `tests/unit/provider-runtime-wiring.spec.ts`
     * （真跑 `apply()` 后调 `runtimeOf(id).auth.refreshAccount`，据此证明
     * 「`src/index.ts` 的注册清单把每个 id 接到了**自己的**实例上」——
     * 那是「中国版账号用国际版凭据续期」这个历史复发 6 次形态的防线）。
     *
     * ⚠️ **保留它是 plan 明确要求的前瞻接线**（本文件模块头），且那条守卫**真的需要**
     * 一个可调用的入口 —— 删掉本字段等于删掉那组行为用例。
     * 但别把它当成「生产会用到」的接口来依赖：**要接生产消费点，先改这段注释。**
     */
    refreshAccount(refName: string, pool: AccountPool, accountId: string): Promise<void>
    /**
     * 批量续期该 provider 的**全部账号**（启动首轮 + 30 分钟定时器）。
     *
     * ## ⚠️ 两条过滤铁律（AGENTS.md）
     *
     * 1. **只按凭据材料过滤，不看 `enabled`**：停用只影响自动选号，与
     *    「凭据是否需要保持新鲜」无关 —— 停用账号同样出现在面板上并参与积分领取。
     *    ⚠️ 真实缺陷：两处都按 `enabled` 过滤 ⇒ 停用期间 refresh_token 一路放到失效，
     *    用户重新启用后拿到的是死凭据，只能重新登录。
     * 2. **也不能按池里的 `refreshable` 过滤**：那个布尔是被对账的**结果**，
     *    拿它当门禁会把一次瞬时失败固化成**单向门**（账号从此永不自愈 —— 真实事故
     *    「codearts 出现 2 个 401，自动续期没有工作吗？重启也还是 401」）。
     *
     * ## 谁提供它
     *
     * 13 家全部提供（`buddy`/`workbuddy` 与 `qoder`/`qodercn` 是同类两实例）。
     * ⚠️ 各家签名**实测完全一致**（`(pool: AccountPool) => Promise<void>`，
     * 见 `grep -n 'async refreshAll(' src/*-auth.ts`）⇒ 无需逐家适配。
     *
     * ⚠️ **漏挂一家 ⇒ 该家凭据永不自动续期**，而症状只是「每隔一段时间就要重新登录」，
     * **日志里一个字都没有**。⇒ `wiredRefreshTargets()` 从本表派生 + 用例锁住。
     */
    refreshAll?(pool: AccountPool): Promise<void>
  }

  /**
   * 积分能力：余额与签到状态。
   *
   * ## ⚠️ 这两个方法只作**既有共享骨架的入参**，骨架本身**不重写**
   *
   * - `collectCreditBalances` 的「**顺序**查询避免并发触发风控」是实测结论
   *  （见该函数的注释），改成 `Promise.all` 会让上游按账号数并发打过来；
   * - 单账号失败**不抛错**而是返回 `{ ok: false }` 条目 —— 让一个号查不到
   *   不至于让整个选号失败；
   * - `collectCreditsStatus` 的逐账号 try/catch 同义。
   *
   * 故本域只是「**选哪个函数**」，各家 `fetch*Balance` 原语一行不动
   * （设计文档 §3.5 的边界：抽象编排，不抽象协议）。
   *
   * ## ⚠️ 本域**不是** `credits.balances` / `credits.status` 的分派来源
   *
   * 那两个端点的表由 `registerJetHubEndpoints` **从已解构的 `auths` 现造**
   *（`src/jet-hub-rpc.ts` 的 `createProviderCredits({ loomy, raccoon, zcode })`），
   * **不是**本表。
   *
   * ⚠️ **历史上这里一度是第 5 个命名对象形参**（与 Task 9 的 `auths` 同法），
   * 2026-10-08 的 C1 修正把它删掉了 —— 理由是它在**生产路径纯冗余**
   *（`src/index.ts` 与端点侧传的是**同一批实例**），却重新打开了
   * 「位置参数错位」那个本仓库自陈**复发 6 次**的门。⇒ 现在两侧各自从
   * `auths` 派生，**没有形参、也没有全局状态**。
   *
   * ⇒ 生产路径上本域**当前只被测试读**：
   *   `credits-runtime-parity.spec.ts`（「credits 域注册在 ProviderRuntime 上」）
   *   与 `provider-runtime-wiring.spec.ts`（「每个有余额能力的渠道都挂上了 credits 域」）。
   *   与 `auth.refreshAccount` 同款，**如实登记**，免得下一个读者满仓找消费方。
   *   它是给**拿不到 `auths` 形参**的跨模块场景（Task 5 / 8）留的接口 ——
   *   **要接生产消费点，先改这段注释。**
   *
   * ## ⚠️ 为什么 `fetchBalance` 与 `fetchBalanceDetailed` 二选一
   *
   * `fetchBalance` 用 `null` 表达「查不到」，调用侧统一补一句「余额查询失败」。
   * 但有些渠道的失败**必须区分**（codearts 的「Token 计费账户」/
   * 「非积分计费账户」/「未返回积分数据」三态，gemini 的「尚未授权」）——
   * 把它们压成同一句会让用户按错误方向排查（本仓库反复记录过该缺陷）。
   * 此时用 `fetchBalanceDetailed`，原因由实现自己给。
   */
  readonly credits?: ProviderCredits
  /**
   * 临期折算（供聚合 / auto 的候选排序）。
   *
   * ⚠️ **本域「存在」即表示「该渠道已接入临期折算」**：`src/aggregate-expiry.ts`
   * 的 `credentialExpiry` 按本域分派，缺席 ⇒ `UNUSABLE`（剔除）。
   *
   * ⚠️⚠️ **但「已接入清单」并不由本表派生**（2026-10-08 设计复审更正）：
   * `WIRED_EXPIRY_PROVIDERS`（同文件）是**编译期常量**，理由见那里的长注释 ——
   * 它在源码里有 **5 个**消费点（`aggregate-adapter.ts` 的**四处**过滤，
   * 加 `aggregate-expiry.ts` 的「未接入」短路 —— **后者才是轮换候选的闸门**），
   * 更要紧的是被**大量不调 `apply()` 的既有测试**消费（实测：在 `tests/unit` 里
   * grep「临期探针工厂名 + 左括号」共 36 处，减去 `expiry-runtime-parity.spec.ts`
   * 自己的 7 处 ⇒ **既有 29 处**；
   * grep「`new` + `AggregateAdapter` + 左括号」共 **86 处**。⚠️ 注释刻意不写出
   * 左括号，否则注释自己会被下一次 grep 计进去），而本表要到 `apply()` 才填充 ⇒
   * 派生版本在那些场景下**恒为空数组**，会把**所有虚拟模型过滤掉**
   *（聚合目录整个变空）。
   * 两者回答的是**两个不同的问题**（「接入了吗」 vs 「运行时调哪个原语」），
   * 一致性由 `tests/unit/expiry-runtime-parity.spec.ts` **真跑 `apply()`** 锁死。
   *
   * ## ⚠️ 它是本表**第一个有生产读者**的域
   *
   * 与 {@link auth.refreshAccount} / {@link credits} / {@link onboarding}
   * 不同（那三个在生产路径上只被测试读，见各自的注释）：本域被
   * `src/aggregate-expiry.ts` 的 `credentialExpiry` **真的调用**。
   * ⚠️ 故本域的**删除**是可见的功能回退：某渠道的 `expiry` 一旦缺席，
   * 它立刻退出聚合候选池（`UNUSABLE` ⇒ 剔除），且**没有**任何日志 ——
   * 由 `tests/unit/expiry-runtime-parity.spec.ts` 真跑 `apply()` 逐家点名守着。
   */
  readonly expiry?: {
    /**
     * 该凭据所属账号的**最早失效时刻**。
     *
     * @returns 毫秒时间戳（越小越早作废）／`NEVER`（长期：排最后但**不剔除**）
     *   ／`UNUSABLE`（查不到：**剔除**）
     * ⚠️ 「**有余额但无到期时间**」必须是 `NEVER` 而**不是** `UNUSABLE`：
     * 实测 lobsterai 的 `expiresAt` 可为**空串**、buddy 的永久积分包也可能不下发
     * `DeductionEndTime`。这类包**确实有额度**（`remaining > 0`），
     * 剔除它会丢掉一个可用渠道。
     * ⚠️ 但「**有效包且 `remaining = 0`（余额已尽）**」必须是 `UNUSABLE`
     *（真实缺陷已修：旧实现让它返回 `NEVER`，于是余额耗尽的账号仍会被选中，
     * 请求随即以 `QUOTA_EXCEEDED` 失败）。
     *
     * ⚠️ 实现方**原样返回**各家 `*Expiry` 原语的结论，**不要**在这一层改写
     *（尤其不要把 `UNUSABLE` 折成 `NEVER`：那正是本模块头警告的「把未知当可用」）。
     *
     * ⚠️ `credential` 是 `unknown`：各渠道凭据形状不同，由各实现自己收窄
     *（各家原语的入参类型即各自的凭据类型）。
     *
     * ## ⚠️⚠️ `context` 是**可选**的，且**只有 zcode 用**（2026-10-12）
     *
     * 加它的原因是 zcode 的**按模型**额度（8M = GLM-5.3 3M + GLM-5.3-Flash 5M
     * 两个**专属桶**）。要写出「这个账号在这个模型上已尽」的持久标记，
     * 就需要知道**是哪个账号**（`accountId`）—— 而 `credential` 里没有它
     *（`ZcodeCredential` 没有账号 id 字段，且**绝不能**用 `device_mid` 顶替：
     * 那是我们每次登录随机生成的，判据见 `zcode.ts` 的字段注释）。
     *
     * ⚠️ **必须是可选参数**：另外 6 家（buddy / workbuddy / loomy / codearts /
     * lobsterai / trae）的折算**与账号 id 无关**（它们只看凭据本身），
     * 加必填参数会让 6 个实现、`provider-expiry.ts` 与几十处测试桩一起改，
     * 而它们**一行行为都不需要变** —— 这正是 G3「零行为变化」要避免的噪音。
     *
     * ⚠️ 实现方**不得**因为 `context` 缺席就改变返回值：它缺席时只意味着
     *「写不了标记」（副作用做不了），**不是**「不知道该模型可不可用」。
     */
    credentialExpiry(credential: unknown, context?: ProviderExpiryContext): Promise<number>
  }

  /**
   * **一次性**新手任务 / 登录奖励（Loomy 新手任务、raccoon 桌面端登录奖励）。
   *
   * ⚠️ 与 `credits`（**每日**签到）语义独立：这里的每一项**每号只能领一次**
   *（Loomy 合计 10000 分、raccoon 3000 分），故是独立端点、也独立成域。
   * 把两者混在一个域里会诱导实现方拿「今天领过没」的判据去判「领过没」——
   * 那正是本仓库记录过的「一份语义两套判据」形态。
   *
   * ## ⚠️ 本域**当前只被测试读**（Task 4 复审 Finding 3）
   *
   * 与 {@link auth.refreshAccount} / {@link credits} 同款，**如实登记**，
   * 免得下一个读者满仓找消费方：
   * - 生产路径**零读者** —— `onboarding.status` / `onboarding.claim` 的表由
   *   `registerJetHubEndpoints` **从已解构的 `auths` 现造**
   *  （`src/jet-hub-rpc.ts` 的 `createProviderOnboarding({ loomy, raccoon })`），
   *   **不查本表**（理由与 `credits` 域同：位置参数错位是本仓库自陈复发 6 次的形态）；
   * - 它的**唯一**消费者是 `tests/unit/claim-runtime-parity.spec.ts` 的两条断言
   *  （「`credits.onboardingTasks === true` 的渠道，runtime 必须有
   *   `onboarding.claim` / `onboarding.status`」）—— 那是「能力声明与实现不许漂移」
   *   的守卫，需要一张可读的表才能成立。
   *
   * ⇒ 与 `credits` 同因，它是给**拿不到 `auths` 形参**的跨模块场景
   *（Task 5 的 `aggregate-expiry.ts`、Task 8 的 `account-probe.ts`）留的**前瞻接线**。
   * ⚠️ **要接生产消费点，先改这段注释。**
   */
  readonly onboarding?: ProviderOnboarding
  /**
   * 「重测」用的**探测适配器工厂**（Task 8）。
   *
   * ## 它解决什么
   *
   * `src/account-probe.ts` 原先是一条 `else if (provider === …)` 链，末尾的 `else`
   * 兜底把**未登记的 provider** 交给「**华为云 HMAC 签名**的 `CodeArtsAdapter`」去发
   * 别家凭据 ⇒ 探测必然失败，而该 provider 的限流标记（UTC+8 当日 24:00）
   * **永远清不掉**（症状只是「重测按钮点了没用」，极难定位）。
   *
   * ⚠️ 该缺陷**同型复发 4 次**（workbuddy → trae → qoder/qodercn/cline → zcode），
   * 根因是「清单靠记忆维护」。⇒ 改为查本表：**未登记 ⇒ 抛可读错误**。
   *
   * ## ⚠️ 为什么返回**实例**而不是参数对象
   *
   * 各家探测差异是**真实的协议差异**，不是参数差异：
   * - `zcode` 要传 `product`（且它的 captcha 通道有已知取舍）；
   * - `gemini` 要 `sessionLane: smoke`（否则探测流量与真实推理混进同一会话）
   *   **且**显式钉 `project`（走自动探测会先多打一次 `loadCodeAssist`，
   *   它失败时会报「项目号探测失败」而掩盖用户真正想知道的「账号仍受限」）；
   * - `trae` 不传 `product`（只有一个产品，适配器内部默认 `TRAE`）。
   *
   * ⇒ 本域抽象的是「**按 provider 找到那个工厂**」，
   * **不是**「统一怎么造适配器」（设计文档 §3.5 的边界：抽象编排，不抽象协议）。
   *
   * ⚠️ **未注册的 provider 会抛可读错误**（见 `account-probe.ts` 的
   * `adapterForProbe`），**不落回** `CodeArtsAdapter`。
   *
   * ⚠️ **不要用 `accountTest` 论证「没有入口」**：本段原话是「客户端能力表
   * `accountTest` 目前**只有 `gemini`**，其余渠道根本没有入口」——**该推论是错的**。
   * 重测 / 重置按钮由 `supportsRateLimit` 门控（缺省 **true**），只有登记了
   * `rateLimit: false` 的家（loomy / gemini / officeace / accio，理由各不同）才真的没有入口
   * ⇒ **漏登记的家会渲染按钮、用户一点就报错**（`opencode` 与 `minimax` 都踩过；后者是
   * issue IKJW32 接上换号后才补上的）。⇒ 本域的注册**是用户可见功能**，
   * 不是「将来才复发」的内部契约。
   */
  readonly probe?: {
    /**
     * 造一个**只用于探测**的轻量适配器（不落盘、不续期、不拉目录）。
     *
     * ⚠️ 调用方（`probeWithAdapter`）已刻意**不传** `accountPool` /
     * `fetchRemoteModels`，并把 `refresh` 设为 no-op：探测只测这一个账号、
     * 不写限流标记、不触发全局续期、不为一次探测额外拉目录。
     *
     * ## ⚠️ 第三个参数 `entry` 是**账号池条目的只读投影**，不是可选的装饰
     *
     * 大多数家只需要 `credential` 就能造出适配器，故它可选。但 `opencode`
     * **必须**用它：它的出口代理权威在池字段 `entry.opencodeProxy`（`setOpencodeProxy`
     * 只写池、**不回写凭据**），指纹代次同理在 `entry.opencodeFingerprintGeneration`。
     * 少了它，探测会走**错的出口 IP / 错的指纹**——而探测的全部意义正是
     * 「用这个账号的真实出网条件打一次请求」。
     *
     * ⚠️ 早先这里有段注释称「opencode 需要整个 identitySlots 序列，故补它要
     * 给 `ProbeDeps` 加池透传、属接口扩张」——**实测证伪**：探测只需**它自己
     * 那一个**槽（`stream()` 只调 `identitySlots()`，不读目录，且探测路径本就
     * 不传 `markLimited`）⇒ 由这一个 `entry` 就能投影出来，**无需**池。
     */
    createProbeAdapter(
      refName: string,
      credential: unknown,
      entry?: ProviderAccountEntry,
      options?: { qoderTrafficGuardEnabled?: boolean },
    ): LlmAdapter
  }
}

/** 一个 provider 的积分能力实现（见 {@link ProviderRuntime.credits}）。 */
export interface ProviderCredits {
  /**
   * 查该账号的积分余额。
   *
   * @returns `null` 表示「查不到」（**不是 0** —— 把失败画成 0 会让用户以为
   *   额度被清空）；调用侧据此显示原因。
   */
  fetchBalance?(credential: unknown, call: ProviderCallContext): Promise<CreditBalance | null>
  /**
   * 查余额（**带原因**）。与 {@link fetchBalance} 二选一，本方法优先。
   *
   * 回 `error` 时 `balance` 必须是 `null`（**不要编造 0**）。
   */
  fetchBalanceDetailed?(credential: unknown, call: ProviderCallContext): Promise<ProviderBalanceDetail>
  /**
   * 查签到状态（部分渠道的 claim 需要它做幂等判据，见 `precheckStatus`）。
   *
   * ⚠️ **未实现 = 该渠道没有与 `CheckinStatus` 同构的状态端点**，
   * 调用侧据此**如实回 `null`**，不要臆造 `{ streakDays: 0 }`
   *（那会让面板显示「连续 0 天」这种看起来像真实读数的假数据）。
   */
  fetchStatus?(credential: unknown, call: ProviderCallContext): Promise<CheckinStatus | null>

  /**
   * 执行**每日**签到领取。
   *
   * ## ⚠️ 为什么必须收 `entry`（不能只有 credential + call）
   *
   * TRAE 的签到设备指纹代次存在**账号池**里，按 `entry.id` 读写：
   * `claimTraeDailyCheckin(…, pool.traeCheckinDeviceGenerationFor(entry.id),
   * next => pool.updateTraeCheckinDeviceGeneration(entry.id, next))`。
   * 把 `entry` 去掉会让这个功能**静默消失**（指纹永不自愈 ⇒ 反复撞 9074）。
   *
   * ⚠️ `entry` 是 `collectClaimResults` **本来就持有**的实参（它的循环变量），
   * 不是内部派生参数 —— 故收进本接口不构成「泄漏内部状态」。
   * （对比 {@link afterClaim} 的 `roundDeadlineAt`：那个才是骨架内部算出来的。）
   */
  claim?(
    credential: unknown,
    entry: ProviderAccountEntry,
    call: ProviderCallContext,
  ): Promise<ClaimOutcome>

  /**
   * **该产品没有签到端点**时给用户看的原因（`claim` 缺席时才有意义）。
   *
   * ⚠️ 为什么不能由端点用一句泛化模板拼（那是 brief Step 4 的写法）：
   * 三条文案是**实测报障修来的**，且各自信息量不同 —— 把它们压成
   * 「`${displayName} 不支持每日签到（其后端没有签到接口）`」会
   * ① 让 workbuddy 的文案变成「WorkBuddy (国际版) 不支持…」（`displayName`
   * 带括号后缀，与实测文案逐字不同）；
   * ② **整个丢掉** raccoon 那条可操作指引「登录奖励请在『新手任务』中领取」
   *（用户看完才知道下一步该点哪里）。⇒ 文案由**知道该产品形态的那一层**给。
   *
   * ⚠️ 缺席且 `claim` 也缺席时，端点回**旧的** `unsupported provider: X`
   *（gemini / opencode / aggregate 现状即此）—— 那是**刻意不动**的行为，
   * 改成「不支持每日签到」是一处需批准的 G3 例外（见 Task 4 报告）。
   */
  claimUnavailableReason?: string

  /**
   * 领取前是否先查 status。
   *
   * ⚠️ **两侧方向都不能"统一"，各有实测依据**：
   * - **必须 `false`**（流程自带预检，外部再查一次是**重复请求**，
   *   而且对 codearts 是**发错端点**——用 buddy 式的状态查询打华为端点必然失败）：
   *   `codearts`、`lobsterai`；
   * - **必须 `true`**：`trae` —— 它的 claim 对「今天已签到」是**幂等**的，
   *   重复领取同样返回 `{code:0, message:"success"}` 与真领取**无法区分**。
   *   早期照抄 LobsterAI 传了 false，于是已签到的账号被报成「领取成功」
   *  （真实报障：**显示成功但 +0 积分**）。判据只能是 status 的 `checked_in`。
   * - 省略（`undefined`）等价于 `true`（骨架的默认值）。
   *
   * ⚠️ **`qoder` / `qodercn` 也必须是 false，但它们与本字段无关**
   *（Task 4 复审 Finding Minor 4 更正：本文原先把它们列在上面那份名单里，
   * 而它们**根本不在这张表里** —— 两家是 `credits.claimAll` 的**端点特例分支**，
   * 理由见 `jet-hub-rpc.ts` 的 `isQoderFamily` 短路与
   * `src/provider-credits.ts` 的模块头）。那处特例分支**直接写死**
   * `precheckStatus: false`（`claimQoderDailyCheckin` 自带活动列表查询），
   * **不经过**本字段。⇒ 读到这份名单时别去 credits 表里找它们。
   *
   * ⚠️ **`loomy` 也必须显式 `false`，且理由与上面两家不同**（这是最容易漏的一格）：
   * 它**没有** {@link fetchStatus}，而骨架的默认 `precheck = deps.precheckStatus !== false`
   * 会拿 **buddy 式**的 `fetchCheckinStatus` 去打 Loomy 端点 —— 一次**必然失败的
   * 真实上游请求**。它自带幂等判据（响应体的 `alreadyProcessed`），不需要外部预检。
   * 由 `tests/unit/claim-runtime-parity.spec.ts` 的「loomy 必须 false」锁死。
   */
  precheckStatus?: boolean

  /**
   * **领取预检专用**的状态查询（`precheckStatus === true` 时用它）。
   *
   * ## ⚠️ 为什么不能复用 {@link fetchStatus}（这是两个消费者，不是一个）
   *
   * 同一个「查签到状态」的动作有两个**作用域不同**的消费者：
   * - `credits.status` 端点（面板读数）—— 由 {@link fetchStatus} 提供；
   * - `credits.claimAll` 的领取预检 —— 由本字段提供。
   *
   * `trae` 恰好证明二者**必须能分开**：它有可用的状态端点（`checked_in`，
   * 领取预检的唯一可靠判据），但 `credits.status` 对它**刻意仍回 `null`**
   *（Task 3 的决定，由 `credits-runtime-parity.spec.ts` 的
   *「fetchStatus 只登记在真有同构状态端点的渠道上」锁死 —— trae 的状态响应
   * 与 `CheckinStatus` 语义不同构）。
   *
   * ⇒ 把 trae 塞进 `fetchStatus` 会**同时**改掉 `credits.status` 的行为
   *（一处未获批准的 G3 例外），故单列本字段。
   *
   * ⚠️ 未提供时端点**回落到** {@link fetchStatus}（buddy / minimax 就是这种：
   * 它们的预检与面板读数是同一个端点，只声明一次即可，避免两处重复声明漂移）。
   */
  claimStatus?(credential: unknown, call: ProviderCallContext): Promise<CheckinStatus | null>

  /**
   * 领取之后的**下钻钩子**（成长中心任务），返回值原样进
   * `RpcCreditsClaimAllResponse.growth`。
   *
   * ## ⚠️ 为什么它是独立字段而不是并进 `claim`
   *
   * 成长中心任务与签到**共用同一趟逐账号循环**才能避免把凭据解析做两遍
   *（凭据可能被外部删除，解析两次会得到两次不同的失败路径）。而它又
   * **不能**混进 `claim` 本身 —— `claim` 的返回类型是 `ClaimOutcome`，
   * 装不下 22 项任务的逐项判据（既有注释明确写了这一点）。
   *
   * ## ⚠️ 参数形状：只收「实现真正需要的」，不收骨架的内部派生量
   *
   * `growthProduct` 是 `collectClaimResults` 拿到的 `product`，**刻意不收**：
   * 各家的产品配置由各家注册时闭包捕获（buddy 闭包自己的 `CODEBUDDY`），
   * 让调用侧转发它只会多一个「传错产品」的失败面 —— 而
   * `credits.claimAll` 的通用分支**本来就传 `undefined`**（它没有 product），
   * 转发过去就是 `collectBuddyGrowth(credential, undefined, …)`，成长中心当场打坏。
   *
   * `run` 里两个字段**都是请求/骨架的真实输入**，不是派生量：
   * - `budgetMs` 来自**请求体**（`RpcCreditsClaimAllRequest.budgetMs`，
   *   `types.ts` 明文「原样透传给 `runGrowthTaskCompletions`」）；
   * - `roundDeadlineAt` 是骨架算出的**整轮**截止时刻。它确实来自骨架内部，
   *   但**必须外露**：它是「账号很多时如实停住并报出哪些账号没跑」的唯一判据，
   *   实现侧要拿它决定「本轮还轮不轮得到这个账号」（见 `collectBuddyGrowth` 首段）。
   *   不给它，实现方就只能自己再算一个 —— 那正是「一份语义两套判据」。
   *
   * ⚠️ **只有 buddy 提供**（`GROWTH_CAPABLE_PROVIDERS` 那张平行手抄集合已删除，
   * 改由本字段是否存在说了算 —— 与 Task 1b 同因：消除平行副本）。
   * ⚠️ 触发条件是 `runTasks === true`（默认 false）—— 成长一轮单账号实测
   * 90~270s、任务间 1.5s 节流，默认开启等于每次启动打几十个上游请求。
   */
  afterClaim?(
    credential: unknown,
    entry: ProviderAccountEntry,
    run: GrowthRunOptions,
    call: ProviderCallContext,
  ): Promise<RpcBuddyGrowthAccountResult | undefined>
  /**
   * 签到收尾的**附加提示**（可选）。
   *
   * 与 {@link afterClaim} 的区别：`afterClaim` **只在 `runTasks === true` 时**运行
   *（成长中心一轮 90~270s，默认关闭）；本钩子**每次签到都会跑**，语义是
   *「签到之后顺带做一件小事，并给用户一句话说明」。
   *
   * ## 为什么需要它（2026-10-20 用户报障）
   *
   * TRAE 的「1024 打卡抽奖」应在**点签到按钮**时触发。挂在 `claim` 内部会
   * **几乎永不触发**：本家 `precheckStatus: true`，今天已签到就直接回
   * `already-claimed`、根本不调 `claim`（而「已签到」恰恰最该抽奖）。
   *
   * ## 契约
   * - 返回字符串 ⇒ 追加到该账号 `outcome.message`；返回 `undefined` ⇒ 不加任何东西
   *  （**不该做的事必须回 `undefined`**，报出来是噪声）；
   * - **永不抛**：失败不得影响签到结果（本仓库有两轮「登录成功却因记账失败被报成
   *   失败」的事故史）。
   *
   * ⚠️ 只有 trae 注入；其余 provider 不传 ⇒ 行为逐字不变。
   */
  afterClaimNote?(
    credential: unknown,
    entry: ProviderAccountEntry,
    call: ProviderCallContext,
  ): Promise<string | undefined>
}

/**
 * 成长中心任务的**两个独立时间闸门**（见 {@link ProviderCredits.afterClaim}）。
 *
 * ⚠️ 它们是两个不同的问题，别合并：`budgetMs` 管「单个账号卡住」，
 * `roundDeadlineAt` 管「账号很多」。
 */
export interface GrowthRunOptions {
  /**
   * 单账号时间预算（毫秒），来自请求体。
   *
   * `undefined` 由实现取缺省 10 分钟；传 0 或负数表示不限时（本地排障用）。
   */
  readonly budgetMs: number | undefined
  /**
   * 整轮的截止时刻（`Date.now()` 口径），`undefined` 表示不限时。
   *
   * ⚠️ 逐账号预算是**每账号**上限，N 个账号会线性累加；宿主 RPC 的超时上界
   * 由 dsh 侧决定，本插件不可见也不可控。故另给一个整轮预算，让「账号很多」
   * 时也能**如实停住并报出哪些账号没跑**，而不是撞上宿主超时后前端只看到一个
   * 无来由的失败。
   */
  readonly roundDeadlineAt: number | undefined
}

/**
 * 一个 provider 的**一次性**奖励能力（见 {@link ProviderRuntime.onboarding}）。
 *
 * ⚠️ 返回类型直接复用 RPC 响应的形状（`RpcOnboardingStatusResponse` /
 * `RpcOnboardingClaimResponse`），与 `ProviderBalanceDetail` 同款理由：
 * 本域的值要直接喂给端点，多一层翻译就多一处漂移。
 *
 * ⚠️ 这**不是**把 RPC 契约当内部接口：这两个形状本就与 provider 数量无关
 *（`tasks` / `earned` / `total` / `titles` / `points` 是**所有**一次性奖励的
 * 公共字段），而 `raccoon` 的「已领时 `earned` 报满分」这条语义**只有在
 * 这个形状上**才表达得出来 —— 压成 `ClaimOutcome` 会丢掉它（见下）。
 */
export interface ProviderOnboarding {
  /**
   * 领取全部一次性奖励。
   *
   * ⚠️ **`raccoon` 的「已领时 `earned` 必须报满分、不是 0」是实测报障修来的**
   *（UI 曾显示「✅ 1 个此前已完成 / 累计已领 0 / 3000」这种自相矛盾的数字）：
   * `earned` 回答的是「该项目**累计**领到多少」，与「本次请求是否新增」无关。
   * ⚠️ 且已领时的金额必须从**账单反查**取得（与 {@link status} 同一数据源），
   * 否则两处会显示不同的数字。
   */
  claim?(credential: unknown, call: ProviderCallContext): Promise<RpcOnboardingClaimResponse>
  /**
   * 查询一次性奖励的进度（**只读**）。
   *
   * ⚠️ **只读：不得**在此触发任何 `complete` / `claim`（面板挂载时会调用它）。
   */
  status?(credential: unknown, call: ProviderCallContext): Promise<RpcOnboardingStatusResponse>
}

/**
 * 带原因的余额查询结果。
 *
 * ⚠️ 形状与 `CreditsEndpointDeps.fetchBalanceDetailed` **刻意同构**：
 * 本域的值要直接喂给 `collectCreditBalances`，多一层翻译就多一处漂移。
 *
 * ⚠️ 用**一个**宽松形状而不是 `{balance} | {balance: null, error}` 联合：
 * 共享骨架自己会在 `balance === null && error === undefined` 时补
 * 「余额查询失败」，故「有 balance 同时带 error」不是需要类型排除的语义
 *（骨架本就按 `error` 优先读），而联合会让实现侧被迫写多余的收窄。
 */
export interface ProviderBalanceDetail {
  balance: CreditBalance | null
  error?: string
  extra?: RpcCreditsBalanceExtra
}

/** id → runtime。用 Map 而非普通对象：id 来自外部输入，避免原型链污染。 */
const runtimes = new Map<string, ProviderRuntime>()

/**
 * 注册一个 provider 的能力实现。
 *
 * ## ⚠️ 重复注册**不抛错** —— 保留现有 + 跳过本次
 *
 * 初稿写的是「重复注册抛错」，那是**错的**（本 Task 起草时实测纠正）：
 * 本仓库已有**实测的 fiber 重启竞态事故**（见 `src/llm-register-compat.ts` 的模块头）——
 * 宿主在启动过程中重启插件 fiber 时，**新 fiber 的同步 `apply()` 与旧 fiber 的
 * 异步 `dispose()` 交错执行**，于是 `apply()` 会在上一轮尚未清理完时再次注册。
 * 那时**抛错会让整个插件加载失败**（`plugin tree failed to load`），
 * 而这恰恰是 `llm-register-compat.ts` 记录过的同型事故。
 *
 * ⇒ 采用与 `llm-register-compat.ts` **同一个**语义（`isDuplicateRegistrationError`
 * 分支）：**保留现有条目、跳过本次注册**。理由是重启场景下「已存在的那条」
 * 是**上一轮同一个插件的注册**（同一代码），路由同样指向等价实现 ⇒ 语义等价。
 *
 * ⚠️ **这不等于静默覆盖**：保留的是**先注册者**（不会被后来者替换），
 * 故「先注册者静默失效」这个初稿担心的情形**不会发生**。
 * ⚠️ 也**不是吞错误**：非重复类的失败（如 descriptor 缺字段）照常抛。
 *
 * ⚠️ **返回值必须被调用方判**：`false` 在**生产**里是 fiber 重启竞态的正常现象
 *（应记 info，不是 error）；在**测试**里它更可能是「用例写错了」——
 * 故 `tests/helpers/rpc-refresh.ts` 之类若复用本函数，应把 false 当失败抛。
 *
 * @returns `true` = 本次真的注册了；`false` = 已存在、跳过了本次
 *   （调用方据此记日志，而不是靠猜）。
 */
export function registerProviderRuntime(runtime: ProviderRuntime): boolean {
  const id = runtime.descriptor.id
  if (runtimes.has(id)) {
    // ⚠️ 保留现有（先注册者），不覆盖 —— 与 llm-register-compat 的
    //    「保留现有路由并跳过本次注册」同义。
    return false
  }
  runtimes.set(id, runtime)
  return true
}

/** 按 id 取（未注册返回 `undefined`，由调用方决定报错措辞）。 */
export function runtimeOf(provider: string): ProviderRuntime | undefined {
  return runtimes.get(provider)
}

/**
 * **共享余额读数缓存**的进程级注册位（2026-10-15，规格 §5.7）。
 *
 * ## ⚠️ 为什么走全局注册表而不是给 `registerJetHubRpc` 加形参
 *
 * 那个函数的签名有**成文不变式**：只剩 **4 个形参**（`ctx, pool, auths, modelAdapters`），
 * 且 `tests/unit/zcode-wiring.spec.ts` 有一组「不占形参位的是谁」的守卫。
 * 加第 5 个可选形参正是那条注释记录的**复发 6 次**的错位形态（在它之前插入任何
 * 可选形参都会让调用点静默错位）。
 *
 * ⇒ 与本文件既有的 `runtimeOf` / 全局注册表同一取向：「拿不到形参的跨模块消费点」
 * 走注册表（`ProviderRuntime.credits` 的先例就在本文件）。
 *
 * ## 生命周期
 *
 * ⚠️ 由 `src/index.ts` 的 `apply()` 在建缓存后**立即**注册；`dispose` 时清空
 *（与 `clearProviderRuntimes` 同处调用，避免用例之间串味）。
 * ⚠️ 未注册 ⇒ 消费方（`credits.balances`）**走自己的原路径**，行为与升级前一致 ——
 * 那是刻意保留的降级路径（本仓库对「可选接线缺失」的一贯取向：不得静默改变行为）。
 */
let sharedBalanceCache: BalanceCache | undefined

/** 注册共享余额缓存（`src/index.ts` 的 `apply()` 调用）。 */
export function registerBalanceCache(cache: BalanceCache): void {
  sharedBalanceCache = cache
}

/** 取共享余额缓存；未注册返回 `undefined`（调用方回退到自己的原路径）。 */
export function balanceCacheOf(): BalanceCache | undefined {
  return sharedBalanceCache
}

/**
 * 按 provider id 从一张 `expiry` 表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in` 或下标：`in`/下标会命中**原型链**上的键
 *（如 `constructor`），把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `creditsOf` / `onboardingOf` / `authOf` 同因（四处必须同款）。
 */
export function expiryOf(
  table: Readonly<Record<string, NonNullable<ProviderRuntime['expiry']>>>,
  provider: string,
): ProviderRuntime['expiry'] {
  if (!Object.hasOwn(table, provider)) return undefined
  return table[provider]
}

/**
 * 清空注册表。
 *
 * ⚠️ 只给**单测**与热重载用。生产路径不应调用 —— 清空后所有 provider 的能力
 * 一起消失，而 `apply()` 不会重新注册（它只在启动时跑一次）。
 */
export function clearProviderRuntimes(): void {
  runtimes.clear()
  // ⚠️ 共享缓存注册位也要清：它挂在同一张进程级表上，留着会让**下一个用例**
  //    读到上一个用例的缓存实例（串味，且症状是「余额读数莫名命中」）。
  sharedBalanceCache = undefined
}

/**
 * 已注册的 id 列表（诊断与单测用）。
 *
 * ⚠️ 保持**注册顺序**（`Map` 的插入序），不要排序、不要 Set 化 ——
 * 排障时「哪个 provider 先注册上」是有用信息。
 */
export function registeredRuntimeIds(): string[] {
  return [...runtimes.keys()]
}

/**
 * 派生出「**批量续期表**」：provider id → 它的 `refreshAll`（Task 10）。
 *
 * ## 为什么需要它
 *
 * `src/index.ts` 原先**手抄 13 行** provider 清单。它的失效形态极隐蔽：
 * **漏一家 ⇒ 该家凭据永不自动续期**，而症状只是「每隔一段时间就要重新登录」，
 * **日志里一个字都没有**（`src/index.ts` 的原注释记录了这一点）。
 * ⇒ 改为从本表派生：**有 `auth.refreshAll` 的才进表**。
 *
 * ## ⚠️⚠️ 必须是**函数**，不能是模块级常量
 *
 * 注册发生在 `apply()`（`registerProviderRuntime`），而模块级常量在**模块加载时**
 * 求值 ⇒ 常量版本**恒为空表** ⇒ **所有 provider 都不再自动续期**，而日志里
 * 只有 `isPoolEmpty` 的常规输出。
 *
 * ⚠️ 反例对照：`src/aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS` **刻意保持
 * 模块级常量**（理由与实测计数写在该文件里：29 处探针 + 86 处适配器构造都不调
 * `apply()`），它与 runtime 的一致性由 `expiry-runtime-parity.spec.ts` 真跑
 * `apply()` 的用例锁死。⇒ 「派生表必须是函数」这条**只适用于读注册表建索引的表**
 * （本函数），不适用于纯数据清单 —— 别照搬本条去改那张常量。
 *
 * ## ⚠️ `this` 绑定
 *
 * 各家的 `refreshAll` 是**类方法**、内部用 `this.product` / `this.ctx`。
 * ⇒ 必须包一层 `.call(rt.auth, pool)`；直接传 `rt.auth.refreshAll` 引用会丢 `this`，
 * 调用即抛 `Cannot read properties of undefined`。
 * （Task 2 的 `refreshAccount` 也用包一层的方式，同因。）
 */
export function wiredRefreshTargets(): Array<readonly [string, (pool: AccountPool) => Promise<void>]> {
  const out: Array<readonly [string, (pool: AccountPool) => Promise<void>]> = []
  for (const [id, rt] of runtimes) {
    const refreshAll = rt.auth?.refreshAll
    // ⚠️ 判据是**方法存在**，不是「有 auth 域」—— 只注册了 `refreshAccount`
    //    的 provider 不该进表（它的账号无法批量续期）。
    if (refreshAll === undefined) continue
    out.push([id, (pool: AccountPool) => refreshAll.call(rt.auth, pool)])
  }
  return out
}
