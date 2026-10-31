/**
 * `resolveCredential` 的**共享编排** —— 每个 provider 每轮请求「选哪个账号、取哪份凭据」。
 *
 * ## 它消除什么（实测）
 *
 * `src/index.ts` 原有 **13 个** `resolveCredential` 闭包（共约 400 行）。
 * 本 Task 把其中 **12 个**收敛到本模块；**codearts 刻意排除**（理由见文末）。
 *
 * ### 骨架同构度（**实测**，不是估计）
 *
 * 把 13 个闭包按两种口径归一化后分组（抽块 → 去注释/空白 → 分组计数）：
 *
 * | 归一化口径 | 分组数 | 最大组 | 多成员组 |
 * |---|---|---|---|
 * | 严格（仅去注释与空白） | 13 | **1** | 无 |
 * | 宽松（再把 provider 常量 / 凭据类型名 / 选择器与解析器标识符折叠成占位符） | 10 | **3** | `3 + 2` |
 *
 * ⇒ **逐字同构的闭包一个都没有**（严格口径下 13 个各自成组）。
 * 宽松口径下最大同构组是 `raccoon / minimax / gemini`（3 家），
 * 次大组是 `qoder / qodercn`（2 家）—— 即「多成员组共 5 个成员」。
 * ⚠️ 任何「6 个逐字同构」的说法都与实测不符，不要沿用。
 *
 * ### ⚠️ 收益与代价（**实测**，别把它当「减少重复」的胜利）
 *
 * 规模（2026-10-08 实测，口径逐项标明）：
 * - `src/index.ts`：**总行数 2555 → 2438（净减 117）**、非空行 2493 → 2381（净减 112）
 *   —— 两者**差 5 行**，混用会得出错数，故分别列出；
 * - 本模块：**新增那一刻（`03acdeb`）396 行**；此后随复审修复增长
 *   （`0cba1a2` → 458、`adc953f` → 458、本段写成时已 464）。
 * ⚠️⚠️ **本模块的「当前行数」刻意不写死** —— 它随本文件每次增删而变，
 * 同一 Task 内已因「拿中途快照当当前值」复发 **3 次**。
 * ⇒ **要引用当前行数，先自己量**：`(Get-Content src/credential-resolver.ts).Count`
 *（或 `wc -l`）。别沿用任何注释里写的数字，包括这一行。
 * ⇒ 结论只依赖**结构性事实**：12 份 per-provider 配置**并不比**原来的闭包短，
 * 故本 Task 的收益是结构性的（见下），**不是**「减少重复」的行数胜利。
 *
 * 真正的收益只有三条（都是**结构性**的，不是行数）：
 *
 * 1. **单一分派点**：骨架顺序（免费短路 → 分档 → 池选号 → 回报 → 限流判定 → 兜底）
 *    此前是 12 份各自维护的**约定**，现在结构上无法被绕过；
 * 2. **不可绕过的顺序**：限流判定必须排在池取号**之后**、兜底**之前** ——
 *    这类「改一处漏一处」的顺序约定现在只有一处实现；
 * 3. 删掉 buddy 系那个**已被本模块取代的编排闭包**（约 90 行）——
 *    那才是本次唯一真实的去重。
 *
 * 代价（如实登记）：多一层间接；`reportPickedAccount` 这个开关**只**为钉住一个
 * 既有的不对称而存在（见该字段说明）；以及下面那处**无法消除的 `as`**。
 *
 * ⚠️ 因此**不要**为了「减少行数」再往本模块搬东西 —— 那只会加深代价。
 *
 * ### 四类骨架（本模块按它们参数化）
 *
 * | 骨架 | 家数 | 特征 |
 * |---|---|---|
 * | A 池选号 + 限流判定 + 单凭据回退 | 10 | raccoon / minimax / gemini / qoder / qodercn / cline / lobsterai / trae / buddy / workbuddy |
 * | B 池选号 + **自定义**兜底 + **刻意不判**限流 | 1 | zcode |
 * | C 余额分档（buddy 协议）+ 免费短路 + 锁定抛错 | 4 | buddy / workbuddy / lobsterai / trae |
 * | D 余额分档（loomy 协议，**不回落池**） | 1 | loomy |
 *
 * A 与 C 在同一家上首尾相接（buddy 系 = C 的编排 + A 的尾巴）。
 *
 * ## ⚠️ 骨架顺序**不可调整**（每一步都是修过的缺陷）
 *
 * ```
 * resolve(modelId)
 *   ├─ ① 有 balance 计划？ → 候选筛（enabled + 模型未受限）
 *   │      ├─ buddy 协议：免费短路 → 余额分档编排 → 锁定则**抛错，绝不回落**
 *   │      └─ loomy 协议：分档 select → 选中即取凭据（**不换号**）→ 锁定则抛错
 *   ├─ ② getAvailableAccount(id, modelId, tried)   ← ⚠️ modelId 必须透传
 *   │      └─ **loomy 不走这一步**（它旧闭包里没有池取号，加上就是行为变更）
 *   ├─ ③ reportAccount(池实际选中的账号 id | undefined)  ← 账本 + qoder/cline/zcode 标记
 *   ├─ ④ throwIfAllRateLimited(product, modelId)     ← 区分限流与没登录
 *   └─ ⑤ 兜底（读固定 ref / 调用方自定义）
 * ```
 *
 * 四条**不可省**的细节（每条都在现有代码里有注释或用例）：
 *
 * 1. **`modelId` 必须透传**给 `getAvailableAccount` —— 传空串会让模型级限流过滤
 *    整体短路（`if (modelId.length === 0) return true`），被标记限流的号仍会被选中，
 *    「换号」形同虚设（真实缺陷，`trae-model-id-selection.spec.ts`）。
 * 2. **`reportAccount` 的契约是「回报池的决策结果」**（未命中时也报 `undefined`）
 *    —— 策略放在回调里，见该字段的说明。
 * 3. **锁定抛错不得回落**（回落会让「锁定永久积分」形同虚设，用户明确要求报错）。
 * 4. **凭据解析（含形状校验）一律由调用方给** —— 本模块**不**自己做
 *    `JSON.parse`。裸 parse 会让 `{"foo":1}` 这种损坏凭据当成有效凭据返回，
 *    随后适配器的 `credential.access_token.length` 抛不可诊断的 TypeError
 *    （TRAE / LobsterAI 的注释记录了这条）。
 *
 * ## ⚠️ 为什么是「一个 `readCredential(ref)`」而不是「`resolveRaw` + `parseCredential`」
 *
 * 各 provider 已经有一个**共用**的按 ref 解析器（`resolveBuddyCredentialByRef` /
 * `resolveTraeCredentialByRef` / `resolveLobsteraiCredentialByRef` /
 * `resolveLoomyCredentialByRef`），**余额选择器也调它**。若本模块改收
 * 「resolveRaw + parseCredential」两个半截，同一份「解析 + 形状校验」判据就会出现
 * **两处实现**（选择器一处、本模块一处）—— 正是那些注释警告的「改一处漏一处」，
 * 也正是本 Task 要消除的东西。
 *
 * ⚠️ **各家的形状校验强度本就不一致，本 Task 逐字保留**（零行为变更）：
 * `resolveTraeCredentialByRef` / `resolveLobsteraiCredentialByRef` 校验
 * `access_token` 是字符串，而 buddy / loomy / qoder 系 / cline / raccoon /
 * minimax / gemini / zcode 的兜底是**裸 `JSON.parse`**。统一强度会改变行为
 * （把此前被接受的损坏凭据改成被拒），故不在本 Task 范围内。
 *
 * ## ⚠️ 为什么 codearts 不在本模块内（13 个里唯一未替换的一个）
 *
 * 三条**同时成立**的差异，任何一条都足以让它不能参数化：
 *
 * 1. **它没有任何回退读取**：其闭包只调 `getAvailableAccount`，没有
 *    「退到单凭据 ref」那一步。而 `CODEARTS_ACCESS_TOKEN` 自多账号改造起
 *    **不再被写入也不再被读取**（其闭包注释与 AGENTS.md 同）—— 纳进来会**新读**
 *    一个空 ref，属于真实行为变更；
 * 2. **它不收 `modelId`**（签名是 `() => Promise<…>`）：适配器传进来的模型
 *    在它这里没有落点，而本模块的骨架顺序与四条细节全部围绕 `modelId` 展开；
 * 3. **它刻意不做限流判定**（`getAvailableAccount('codearts', '')` 传空串，
 *    模型级限流压根不参与筛选）—— 故它既不会误报「限流」也不会误报「未登录」，
 *    给它接判定反而会改变既有行为（`ratelimit-misreport-behavior.spec.ts`
 *    有专门一条锁死这个现状）。
 */

import type { BuddyNoAccountReason, BuddySelectorLike } from './buddy-balance-selector.js'
import { pickBuddyAccount } from './buddy-balance-selector.js'
import { sessionBalanceEnabled } from './session-balance.js'
import type {
  LoomyCandidateAccount,
  LoomyNoAccountReason,
  LoomySelectionResult,
} from './loomy-balance-selector.js'
import type { LoomyTierOptions } from './loomy-balance-rank.js'

/**
 * 编排用到的那部分账号池（**结构化**，便于单测注入替身）。
 *
 * ⚠️ 只声明真正读到的三个方法：`AccountPool` 天然满足本接口（既有调用点
 * 一行不用改），而单测不必构造整个池。
 *
 * ⚠️ `TCredential` **默认 `unknown`**：本模块不关心具体形状（形状校验是各家
 * `parseCredential` 的职责），各个调用点各自传自己的类型即可。默认值让既有测试桩
 * （它们只关心 `entry`）一行不用改。
 *
 * ⚠️ **刻意不写「几家」**：本句原写「**13 家**各自传自己的类型」，实测走本模块的
 * 只有 **12** 个调用点（`codearts` 的 `resolveCredential` 无 fallback 且不收
 * `modelId`，**刻意不纳入**本模块 —— 见 `AGENTS.md` 的抽象边界一节）。
 * 这类「家数」是**必然腐坏**的快照，同一 PR 里已在别处写错过多次
 * （`model-catalog.ts` 的未知模态名单 5 → 10 → 12）。
 * ⇒ 名单的权威是调用点本身，不是本注释。
 */
export interface ResolverPool<TCredential = unknown> {
  /** 列出该 provider 的**全部**账号（含已停用）。 */
  listAccountsByProvider(provider: string): ReadonlyArray<{
    id: string
    credentialRef: string
    enabled: boolean
    modelRateLimits?: Record<string, number>
  }>
  /** 该 provider 是否处于「锁定永久积分」状态。 */
  permanentLocked(provider: string): boolean
  /** 取「当前最该用的一个账号」；`null` = 没有可用账号。 */
  getAvailableAccount(
    provider: string,
    modelId: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<{ entry: { id: string; credentialRef: string }; credential: TCredential } | null>
  /**
   * 按 `sessionId` 选号（可选能力；供 `accountSelection: 'session-balance'` 使用）。
   *
   * 未实现时调用方回落到 {@link getAvailableAccount}。真实的 `AccountPool`
   * 已实现；单测里的结构化替身可以继续只实现上面两个方法。
   */
  getAvailableAccountForSession?(
    provider: string,
    modelId: string,
    sessionId?: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<{ entry: { id: string; credentialRef: string }; credential: TCredential } | null>
  /**
   * 「ZCode 会话负载均衡」面板开关（可选能力；真实 `AccountPool` 已实现）。
   *
   * 每次选号**现读**（Jet Hub 页头可随时切换）。未实现时回落环境变量
   * `DSH_ZCODE_SESSION_BALANCE`（默认开）—— 只为单测替身保留。
   */
  sessionBalanceEnabled?(): boolean
}

/** 注入的共享设施。 */
export interface CredentialResolverDeps<TCredential = unknown> {
  readonly pool: ResolverPool<TCredential>
  /**
   * 回报「本笔请求解析出的账号」。
   *
   * ⚠️ **契约是「回报池的决策结果」**：池兜底未命中时**也会**以 `undefined`
   * 调用一次。各家对 `undefined` 的处理不同，故**策略放在回调里**
   * 而不是本模块里多开一个开关：
   *
   * - buddy / workbuddy / lobsterai / trae / raccoon / minimax / gemini：
   *   回调自己忽略 `undefined`（`if (accountId !== undefined) …`），
   *   与它们旧闭包「只在取到号时回报」逐字等价；
   * - qoder / qodercn / cline / zcode：`undefined` 是**有意义的事件** ——
   *   它要**清空**「本次实际使用的账号」标记（留着旧 id 会误伤无辜账号）。
   */
  readonly reportAccount?: (accountId: string | undefined) => void
}

/**
 * 单次解析的「实际选中账号」出口。
 *
 * 为什么需要它：`deps.reportAccount` 是**进程级回调**（zcode 用它写
 * `activeZcodeAccountId` Map）。多个会话并发时，共享 Map 会被别的请求覆盖，
 * 适配器再读 `currentAccountId()` 就可能把失败记到别的账号头上。
 * 把这个**按调用**的 out 参数传进来，适配器拿到的是本笔解析真正选中的 id。
 */
export interface CredentialPick {
  accountId?: string
}

/**
 * loomy 选号器的**结构化**形状。
 *
 * ⚠️ 与 {@link BuddySelectorLike} 分开声明，不合并成一个「通用选号器」接口：
 * 两者的 `reason` 类型（`LoomyNoAccountReason` vs `BuddyNoAccountReason`）与
 * 余额语义（`dailyBalance` vs `expiring/permanent`）都不同。设计边界是
 * **抽象编排、不抽象协议** —— 强行合并会丢掉「今日赠送额度」这层语义。
 */
export interface LoomySelectorLike {
  select(
    candidates: readonly LoomyCandidateAccount[],
    options?: LoomyTierOptions,
  ): Promise<LoomySelectionResult>
}

/**
 * 显式声明「**本家没有免费模型概念**」的 `isFreeModel` 实现。
 *
 * ## 为什么需要这个常量（而不是让字段可选）
 *
 * `isFreeModel` 曾经是**可选**字段。于是新增一家 `balance: { kind: 'buddy' }`
 * 装配时，漏传它 **既没有编译报错、也没有运行时报错** —— 只是静默地让该家的
 * 免费模型走付费路径，被「锁定永久积分」拦住，报出「额度都属于永久」这种与
 * 事实相反的文案，并把用户推向「解锁永久积分」（不可逆烧钱）。
 *
 * 这正是 Qoder 的实际事故：`src/qoder-adapter.ts` 的兜底表早在 `isFree: true`
 * 上标好了 4 个免费模型，`toCatalogEntry` 也把 `isFree` 透出给了 UI，唯独
 * 装配层漏了这三个字。同类缺陷此前在 buddy / workbuddy / trae 已经复发过一轮。
 *
 * ⇒ 把它改成**必填**后，新增渠道时漏写是**编译错误**。确实没有免费模型的渠道
 * 用本常量显式表态，语义比裸写 `() => false` 清楚得多（后者读起来像「忘了实现」）。
 *
 * ⚠️ 只有**核实过**该家确实不存在模型级免费概念时才可以用它。判据是「产品/
 * 兜底表里没有任何 `isFree: true`，且上游目录不返回 `is_free`」，不是「懒得查」。
 */
export const NO_FREE_MODEL = (): false => false

/**
 * **buddy 协议**的余额分档计划（buddy / workbuddy / lobsterai / trae 四家共用）。
 *
 * 编排本身直接复用 `pickBuddyAccount`（**已导出的共享实现**），本模块不再手写
 * 一份候选循环 —— 那正是本 Task 要消除的重复。
 */
export interface BuddyBalancePlan {
  readonly kind: 'buddy'
  readonly selector: BuddySelectorLike
  /**
   * 锁定且无可用账号时的报错文案（各家不同，**必须由调用方逐字提供**）。
   *
   * ⚠️ 必须按 `reason.kind` 分三种报（与 loomy 同型缺陷）：把「余额查不到」
   * 报成「额度已用尽」，用户会去解锁或白等，而号其实有钱；
   * 把「凭据全坏」也报成「额度已用尽」同样是**自相矛盾**（分档刚证明它有钱）。
   */
  readonly lockedError: (reason: BuddyNoAccountReason) => Error
  /**
   * 本次请求的模型是否**免费**（消耗 0 积分）。免费时**跳过**余额分档。
   *
   * ⚠️ **必填**（原为可选，见 {@link NO_FREE_MODEL} 的事故说明）。没有免费
   * 模型概念的渠道请用 `NO_FREE_MODEL`，不要删字段。
   *
   * ⚠️ 必须是**已确认**的免费：`true` 会跳过余额分档（即不受锁定约束），
   * 误判成免费会让付费模型绕开锁定、真烧掉永久积分。故判据在适配器里，
   * 只在能确认 0 积分时才返回 true。
   */
  readonly isFreeModel: (modelId?: string) => Promise<boolean> | boolean
  /**
   * 分档**选中账号**时是否回报 `reportAccount`。缺省 `true`。
   *
   * ⚠️ **这不是「正确行为」的开关，而是钉住既有的不对称**：buddy 与 workbuddy
   * 的旧闭包在「分档选中」那一支**没有**回报账本（只在池兜底那一支回报），
   * 而 lobsterai / trae 两支都回报。零行为变更要求原样保留，故由调用方声明。
   * 该不对称在生产里无害（四个适配器随后自己都会回报账本），但改掉它就是
   * 一次行为变更。
   */
  readonly reportPickedAccount?: boolean
}

/**
 * **loomy 协议**的余额分档计划。
 *
 * ⚠️ 与 {@link BuddyBalancePlan} 的**关键差异**（本 Task 的裁定 3）：
 * loomy 的分档**自己就是完整的选号** —— 选中的账号凭据坏掉时它
 * **不换号、也不回落池**，直接退单凭据（旧闭包里根本没有池取号调用）。
 * 把它并进 `pickBuddyAccount` 会同时引入「换号重试」与「池兜底」两个行为变更。
 */
export interface LoomyBalancePlan {
  readonly kind: 'loomy'
  readonly selector: LoomySelectorLike
  /** 锁定且无可用账号时的报错文案（与 buddy 同款要求：两种原因分开报）。 */
  readonly lockedError: (reason: LoomyNoAccountReason) => Error
}

export type BalancePlan = BuddyBalancePlan | LoomyBalancePlan

/** 池里没有可用账号时的**兜底**。 */
export type ResolverFallback<TCredential> =
  /** 读某个固定单凭据 ref（12 家里的 11 家）。 */
  | { readonly kind: 'ref'; readonly refName: string }
  /**
   * 交给调用方自己的兜底（**只有 zcode**）。
   *
   * ⚠️ 与 `ref` 分开是**必须**的：`zcode.current()` 会**再读一次账号池**
   * 且不看 `enabled` / 限流标记 —— 这正是它「不接限流判定也算对」的原因
   *（池被筛空时它照样返回凭据，故不会误报「未登录」）。把它当成
   * 「读某个 ref」会丢掉这层语义。
   */
  | { readonly kind: 'custom'; readonly resolve: () => Promise<TCredential | undefined> }

/** 单家 provider 的配置。 */
export interface CredentialResolverConfig<TCredential> {
  readonly product: { readonly id: string; readonly displayName: string }
  /**
   * 按 ref 解析凭据，**并做各家自己的形状校验**（返回 `undefined` 或抛错
   * 都表示该 ref 的凭据不可用）。
   *
   * ⚠️ 传的是各 provider **已有的那份解析器**（`resolveTraeCredentialByRef` 等）
   * —— 它同时是余额选择器用的那一份。**不要**在这里另写一个 `JSON.parse`：
   * 那会让同一判据出现两处实现（本模块存在的意义就是消除这种分叉）。
   *
   * ⚠️ **必传**（zcode 那份可以传一个恒返回 `undefined` 的实现，因为它的
   * `fallback.kind` 是 `custom`，永远不会被调用到 —— 但**不要**因此把本项改成
   * 可选：可选会让「忘了传」编译期无声通过，而那正是 TRAE 注释里记的坑）。
   */
  readonly readCredential: (refName: string) => Promise<TCredential | undefined>
  /** 池里没有可用账号时退到哪里。 */
  readonly fallback: ResolverFallback<TCredential>
  /**
   * 区分「全部账号被该模型限流」与「没登录」。
   *
   * ⚠️ **可选**，且缺省是「不判定」：zcode **刻意**不接这条 —— 其余各家的兜底
   * 读的是 Jet Hub 登录路径下从不被写入的 `*_ACCESS_TOKEN`，池被筛空必然降级成
   * 「请先登录」（真实缺陷 IKJOZ9）；而 zcode 的兜底 `current()` 会**再读一次
   * 账号池**，本就不会误报，加判定反而会把本来能跑通的一发变成硬失败。
   */
  readonly throwIfAllRateLimited?: (
    product: { id: string; displayName: string },
    modelId?: string,
  ) => void
  /** 余额分档计划；缺省 ⇒ 纯池选号（骨架 A）。 */
  readonly balance?: BalancePlan
  /**
   * 账号选择策略；缺省 `'manual'` = 池的手动顺序优先（既有语义）。
   *
   * `'session-balance'`：按本次请求的 `sessionId` 做会话亲和（同一会话**优先**
   * 落同一账号；账号今日请求数达阈值后会被沉底，正在跑的会话会迁移一次 —— 见
   * `session-balance.ts` 的 `rankAccountsBySessionWithOverflow`），没有
   * `sessionId` 时随机分摊。目前仅 **zcode** 启用。
   */
  readonly accountSelection?: 'manual' | 'session-balance'
}

/**
 * 按 `enabled` + 模型限流筛出候选账号。
 *
 * ⚠️ **判据必须与 `AccountPool.getAvailableAccount` 逐字一致**（含「空 modelId
 * 不过滤」与「`resetAt` 为 0 / 已过期都算不受限」）：余额分档只在这批候选**内部**
 * 进行，不能因为某个号积分多就绕开限流标记。
 */
function candidatesOf(
  pool: ResolverPool,
  providerId: string,
  modelId: string | undefined,
): Array<{ id: string; credentialRef: string }> {
  return pool
    .listAccountsByProvider(providerId)
    .filter(a => a.enabled)
    .filter((a) => {
      const key = modelId ?? ''
      if (key.length === 0) return true
      if (a.modelRateLimits === undefined) return true
      const resetAt = a.modelRateLimits[key]
      return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
    })
    .map(a => ({ id: a.id, credentialRef: a.credentialRef }))
}

/**
 * 造一个与适配器契约一致的 `resolveCredential`。
 *
 * @param modelId - 本次请求的模型 id；⚠️ 会被透传给 `getAvailableAccount`
 *   与 `isFreeModel`（不要吞掉）。
 */
export function createCredentialResolver<TCredential>(
  deps: CredentialResolverDeps<TCredential>,
  config: CredentialResolverConfig<TCredential>,
): (modelId?: string, sessionId?: string, selection?: CredentialPick) => Promise<TCredential | undefined> {
  const providerId = config.product.id

  /** ⑤ 兜底：读固定 ref，或交给调用方自定义。 */
  const fallback = async (): Promise<TCredential | undefined> =>
    config.fallback.kind === 'ref'
      ? await config.readCredential(config.fallback.refName)
      : await config.fallback.resolve()

  return async (
    modelId?: string,
    sessionId?: string,
    selection?: CredentialPick,
  ): Promise<TCredential | undefined> => {
    /**
     * 统一回报出口：既写 `selection`（本次请求私有，供 zcode 这类多账号并发
     * 的适配器精确取「本笔实际账号」），也保留 `deps.reportAccount` 的既有
     * 进程级副作用（账本 / activeZcodeAccountId 兼容）。
     */
    const report = (accountId: string | undefined): void => {
      if (selection !== undefined) selection.accountId = accountId
      deps.reportAccount?.(accountId)
    }
    /**
     * 分档编排排除掉的账号（**只有 buddy 协议会填**）—— 池兜底据此跳过它们，
     * 否则「档位最优但凭据损坏」的号会被 `getAvailableAccount` 立刻选回，
     * 兜底**原地打转**，换号形同虚设。
     */
    const tried = new Set<string>()
    const plan = config.balance

    if (plan?.kind === 'buddy') {
      // ⚠️ `isFreeModel` **先于**候选构造求值：与旧闭包「在 options 字面量里
      //    await」的时序一致（它可能触发远端目录拉取，放到候选之后会把
      //    「先拉目录、再筛候选」这个顺序反过来）。
      // ⚠️ 字段现为**必填**（`NO_FREE_MODEL` 是「本家无免费模型」的显式表态），
      //    故不再需要 `=== undefined` 兜底 —— 那种兜底正是 Qoder 漏接三周的遮掩。
      const free = await plan.isFreeModel(modelId)
      const candidates = candidatesOf(deps.pool, providerId, modelId)

      // ① 免费模型（消耗 0 积分）不受「锁定永久积分」约束：锁定要保护的是
      //    「别把永久积分烧掉」，而免费模型既不扣临时也不扣永久积分，却被那道门
      //    一并拦下，报出「账号有余额却没有可用账号」的矛盾错误（真实报障）。
      //
      //    ⚠️ 这里**只按候选顺序逐个解析凭据**（走 `config.readCredential`，
      //    带各家自己的形状校验），**不做**余额分档 —— 免费模型没有「该烧哪个包」
      //    的选择问题，余额查询因此完全不必要（也顺带省掉一次网络请求）。
      //    ⚠️ **不能**改用 `getAvailableAccount`：那是池内的**裸 `JSON.parse`**，
      //    会让 TRAE / LobsterAI 的损坏凭据从「被拒」变成「被接受」。
      if (free) {
        for (const candidate of candidates) {
          const credential = await config.readCredential(candidate.credentialRef)
          if (credential !== undefined) {
            if (plan.reportPickedAccount !== false) report(candidate.id)
            return credential
          }
          tried.add(candidate.id)
        }
        // 免费模型下若凭据全坏，仍落到常规路径，以复用既有的错误语义
        //（凭据问题应报「凭据不可用」，而不是被误报成「额度已用尽」）。
      }

      // ② 余额分档编排（共享实现 `pickBuddyAccount`，**不要**在本文件再手写一份）。
      const allowPermanent = !deps.pool.permanentLocked(providerId)
      const picked = await pickBuddyAccount<TCredential>(plan.selector, candidates, {
        allowPermanent,
        resolveCredential: config.readCredential,
      })
      if (picked.kind === 'account') {
        if (plan.reportPickedAccount !== false) report(picked.account.id)
        return picked.credential
      }
      for (const accountId of picked.tried) tried.add(accountId)
      if (picked.kind === 'locked') {
        // ⚠️ **锁定时绝不可落到下面的池兜底** —— 那会绕过锁定、照样消耗永久
        //    积分，使锁定形同虚设（用户明确要求报错）。文案由调用方逐字提供。
        //
        // ⚠️ 但报错**之前**必须先证明失败原因是不是**限流**（真实报障
        //    2026-10-13，CodeBuddy：`明明有积分却显示不可用`）。候选为空时
        //    余额分档**一次都没跑过**，那句「积分都已用尽」是凭空断言；而
        //    「全部启用账号被目标模型限流」正是候选为空的常见成因 ——
        //    `candidatesOf` 会按 `modelRateLimits` 把它们全滤掉，解禁时刻
        //    明明就在池里，却被这条 throw 短路掉了。
        //
        //    ⚠️ 判据用 `candidates.length === 0` 而**不是** `picked.reason`
        //    的 kind：候选非空时余额分档已经跑过，限流标记在筛候选那一步
        //    就生效了，此时再去问一次是多余的网络无关判断；且候选非空 ⇒
        //    至少一个启用账号未被限流 ⇒ `throwIfAllRateLimited` 必然静默返回。
        //
        //    ⚠️ 这与本文件 ⑤ 的修法同型（Gitee IKJOZ9）：那里也是「先证明
        //    是不是限流，再退兜底」。本处只是把它补到锁定分支上。
        if (candidates.length === 0) config.throwIfAllRateLimited?.(config.product, modelId)
        // ⚠️ **不再写 `?? { kind: 'exhausted' }` 兜底**（2026-10-14 审计实测打穿的
        //    漏网路径）。`pickBuddyAccount` 的返回类型已收紧为 `reason` **必填**，
        //    而它缺席时**只有一个**成因 —— 候选非空、每次 `select()` 都 `ok:true`，
        //    但那些号的凭据全解析不出来（详见 `credential-only` 的说明）。此时
        //    `ok:true` 已证明该号落在可用档（有钱），报「积分都已用尽」是
        //    **自相矛盾**，且会把用户推向「解锁永久积分」（不可撤回地烧钱）。
        //
        //    ⚠️ **两种兜底值都不能写**：写 `exhausted` 会让「有人再写一份不填
        //    `reason` 的编排」静默退回同一个缺陷；写 `credential-only` 则是
        //    **不可达的死代码** —— 实测变异验证：把它改回 `exhausted` 时全套
        //    用例仍绿（27 passed），即该行从未被执行。⇒ 让**类型系统**保证非空
        //    （`tsconfig` 的 `strict` 已开，`strictNullChecks` 生效）。
        throw plan.lockedError(picked.reason)
      }
    } else if (plan?.kind === 'loomy') {
      const candidates = candidatesOf(deps.pool, providerId, modelId)
      const allowPermanent = !deps.pool.permanentLocked(providerId)
      if (candidates.length > 0) {
        const picked = await plan.selector.select(candidates, { allowPermanent })
        if (picked.ok) {
          const credential = await config.readCredential(picked.account.credentialRef)
          // ⚠️ 凭据不可用**不换号**（与 buddy 协议的关键差异）：loomy 的分档
          //    只回答「该用哪个号」，答案是它给的那个；换号是另一套语义，
          //    旧闭包里没有它，加上就是行为变更。
          if (credential !== undefined) {
            report(picked.account.id)
            return credential
          }
        } else if (!allowPermanent) {
          // ⚠️ 与 buddy 同款：锁定时**绝不回落**，且两种原因分开报
          //   （把一次网络抖动报成「额度用尽」，用户会去解锁或白等一天）。
          throw plan.lockedError(picked.reason)
        }
      }
      // ⚠️ loomy **不走池兜底**（见 `LoomyBalancePlan` 的说明）：它旧闭包里
      //    根本没有池取号这一步，加上会让「凭据坏掉就换号」成为一个新行为。
      config.throwIfAllRateLimited?.(config.product, modelId)
      return await fallback()
    }

    // ③ 池选号（⚠️ `modelId` 透传，否则模型级限流过滤整体短路）。
    //    `'session-balance'` = zcode 的会话亲和 / 无 sessionId 随机分摊；
    //    其余 provider 保持手动顺序优先（既有语义）。
    //    ⚠️ 总开关是**池里的面板开关**（`sessionBalanceEnabled`，Jet Hub 页头
    //    可切，落 `state.json`）：**每次现读**，关掉时连 `getAvailableAccountForSession`
    //    都不进，与手动顺序路径逐字节同语义。池未实现该方法（单测替身）时
    //    退回环境变量 `DSH_ZCODE_SESSION_BALANCE`（默认开）—— 两条判据只在
    //    「结构化替身」这一条路径上并存，生产 `AccountPool` 恒走面板开关。
    const poolSwitch = typeof deps.pool.sessionBalanceEnabled === 'function'
      ? deps.pool.sessionBalanceEnabled()
      : sessionBalanceEnabled()
    const available = config.accountSelection === 'session-balance'
      && poolSwitch
      && deps.pool.getAvailableAccountForSession !== undefined
      ? await deps.pool.getAvailableAccountForSession(providerId, modelId ?? '', sessionId, tried)
      : await deps.pool.getAvailableAccount(providerId, modelId ?? '', tried)
    // ④ 回报「池的决策结果」——**未命中时也报 `undefined`**（见 `reportAccount` 契约）。
    report(available?.entry.id ?? undefined)
    /**
     * ⚠️ **这里的 `as` 是刻意保留的、已知的取舍**（缺陷史见下），不是顺手写的。
     *
     * ## 它警告什么
     *
     * TS 的 `as` 只要**任一方向**可赋值就放行：`X as Y` 在 `X` 可赋给 `Y`、
     * 或 `Y` 可赋给 `X` 时都编译通过。故把一个凭据**误断言成另一个 provider
     * 的类型**（两家凭据结构有重叠时）能静默通过 —— 那是一条
     * **静默的类型漏洞**：`tsc` 全绿、单测全绿，而类型标注已与运行时值不符。
     *
     * 正因如此，重构前的各家闭包在「余额分档选中」那一支**刻意不写 `as`**
     *（泛型已正确推导），并在注释里记下这条判据（原话见 git 历史里
     * `src/index.ts` 的 LobsterAI / TRAE 两处「不要加 `as`」注释）。
     *
     * ## 为什么本模块**不得不**写它
     *
     * 池的取号方法返回的是**联合类型** `CodeArtsCredential | BuddyCredential`
     *（历史遗留：`src/account-pool.ts` 的 `getAvailableAccount` 早于多 provider
     * 泛型化），而本模块对池只声明了 {@link ResolverPool} 这个**结构化**接口
     *（`credential: unknown`，好让单测注入替身、且不必构造整个池）。
     * 二者之间没有任何类型层面的连接 ⇒ 从 `unknown` 回到 `TCredential`
     * 只能靠断言。`TCredential` 由调用方经泛型给出，本模块无从在运行时校验它。
     *
     * ## 我评估过、并**否决**的两条「消除 `as`」的路（都不在本 Task 范围内）
     *
     * 1. **改走 `config.readCredential(available.entry.credentialRef)` 重新读一遍**：
     *    这会**改变行为** —— 池内那份是**裸 `JSON.parse`**（无形状校验），而各家的
     *    `readCredential` 带自己的校验强度（TRAE / LobsterAI 校验 `access_token`
     *    是字符串）。改走它会让池路径下「此前被接受的损坏凭据」变成「被拒」，
     *    且多一次凭据读取 —— 与「零行为变更」直接冲突。
     * 2. **把 `ResolverPool` 泛型化 / 让配置项提供 `narrowCredential`**：
     *    真实 `AccountPool` 返回的是联合类型，`AccountPool` 天然**不满足**
     *    `ResolverPool<TCredential>`，于是断言只会从本模块**搬到 12 个调用点**
     *    （或让 12 家各写一个 `(raw) => raw as X` 的校验器）—— 断言数量变多、
     *    且正是本 Task 要消除的「同一判据 N 处实现」。
     *
     * ⇒ **2026-10-08（Task 11）已完成那次泛型化**：`AccountPool.getAvailableAccount`
     * 现在收类型参数，本行原来的 `as TCredential` **已按此处预告一并删掉**。
     * ⚠️ 保留本段叙述（而不是删掉整段）—— 它记录「为什么那个断言曾经必须存在」，
     * 后人再想「把池的返回改回联合类型」时已知那条路走不通。
     */
    if (available !== null) return available.credential

    // ⑤ 回退前先证明失败原因是不是**限流** —— 否则唯一启用账号被该模型限流时
    //    候选被筛空，会被误报成「没登录」，用户据此去重新登录，方向完全错
    //   （真实缺陷，Gitee IKJOZ9）。zcode 刻意不接（见 `throwIfAllRateLimited`）。
    config.throwIfAllRateLimited?.(config.product, modelId)

    return await fallback()
  }
}
