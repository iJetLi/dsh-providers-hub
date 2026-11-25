


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

import type { RotationStartTier } from './jet-hub-store.js'
import type { BuddyCandidateAccount, BuddyNoAccountReason, BuddySelectorLike } from './buddy-balance-selector.js'
import { BUDDY_BALANCE_TIER } from './buddy-balance-rank.js'
import { pickBuddyAccount } from './buddy-balance-selector.js'
import { accountIdAtPosition, isSubagentSession, startIndexOfSlot, subagentParentOf, subagentSettingActive } from './subagent-rotation.js'
import type { SubagentAssignment } from './subagent-rotation.js'
import type { SubagentRotationSetting } from './jet-hub-store.js'
import { sessionBalanceEnabled } from './session-balance.js'
import { isPolicyBlockedAccount } from './account-pool.js'
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
/**
 * ⚠️⚠️ **这两个函数已提取到 `src/subagent-start.ts`**（2026-11-25）。
 *
 * ## 为什么提取
 *
 * 子代理起点分配的判据原先**内联在本文件**，而本仓有一类 provider
 *（codearts / officeace / …）**自建选号**、不走本文件的
 * `createCredentialResolver` ⇒ 它们想支持子代理只能**手抄一份**，
 * 而同一语义两套实现必然漂移（本套逻辑上游已改 6 轮审计）。
 *
 * ## 为什么就地 import 而不是复制
 *
 * 本文件与 `subagent-start.ts` 必须给出**逐字节相同**的结果。
 * 守卫在 `tests/unit/subagent-start-extraction.spec.ts`（8 条，
 * 提取过程中实际抓到 6 处语义漂移）。
 *
 * ⚠️ **不要把它们搬回来**：那会让三类 provider 再次各有一份实现。
 */
import { bestTierAnchorId, decideSubagentStart, registerSubagentStartIfNeeded, sameTierAsMainStart } from './subagent-start.js'
import {
  positionOfAccount,
  probeRotationStartTier,
  shouldDecideSubagentStartOnFirstUse,
  type TierProbe,
} from './subagent-first-start.js'


export interface ResolverPool<TCredential = unknown> {
  /** 列出该 provider 的**全部**账号（含已停用）。 */
  listAccountsByProvider(provider: string): ReadonlyArray<{
    id: string
    credentialRef: string
    enabled: boolean
    modelRateLimits?: Record<string, number>
    /**
     * 账号级**封禁**标记（Gitee issue IKS2MV）。
     *
     * ⚠️ 必须在这里声明并参与过滤：`getAvailableAccount` 与 `candidatesOf` 是
     * **两份**选号判据（下文 `candidatesOf` 的注释已警告「必须逐字一致」），
     * 只改池那一份的话，主请求路径照样会把封禁账号选出来 —— 每一发都先撞一次
     * 403 再换号，并顺带写两次盘（2026-11-01 对抗审计实测 E8）。
     */
    policyBlockedAtMs?: number
  }>
  /** 该 provider 是否处于「锁定永久积分」状态。 */
  permanentLocked(provider: string): boolean
  /** 取「当前最该用的一个账号」；`null` = 没有可用账号。 */
  getAvailableAccount(
    provider: string,
    modelId: string,
    excludeAccountIds?: ReadonlySet<string>,
    /**
     * 「轮换起点」：本会话指定的起始账号 id（可选）。
     *
     * ⚠️ 池实现**只做旋转**（从它起绕一圈），不增删候选 ⇒ 它不可用时仍会选中别的号。
     * ⚠️ 未传 / 未实现时行为与改动前**逐字节相同**。
     */
    rotationStartId?: string,
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
  /**
   * 「严格手动顺序」开关（可选能力；真实 `AccountPool` 已实现）。
   *
   * **开** = 拖拽序是唯一优先级判据（档位只当可用性判据）；
   * **关 / 未实现** = 既有语义（余额分档优先、档内看手动顺序）。
   *
   * ⚠️ 每次选号**现读**（面板可随时切换）。未实现时按**关闭**处理：结构化替身
   * 与单测 stub 不该因为「这个可选方法不存在」而被动获得新行为。
   */
  strictManualOrder?(provider: string): boolean
  /**
   * 「轮换起点」（可选能力；真实 `AccountPool` 已实现）。
   *
   * 返回**本会话**指定的起始账号 id；`undefined` = 默认起点。
   *
   * ⚠️ **未实现时行为必须与改动前逐字节一致**（本功能的唯一回归面：
   * 大量单测用结构化替身池，它们不认识本方法）。
   */
  preferredRotationFor?(provider: string, sessionId: string | undefined): string | undefined
  /**
   * ★★★ **写「轮换起点」**（2026-11-25 重构后子代理也要用）。
   *
   * ## 为什么子代理需要它
   *
   * 用户定案：子代理的「首次起点」= **用户手选下拉框那一步**，只是把
   * 「用户选位次」换成「策略算位次」。写进 `preferredRotation` 之后，
   * 子代理就与主代理**走完全相同的代码**，不需要任何子代理标记。
   *
   * ## ⚠️ 契约与 `AccountPool.setPreferredRotation` 逐字相同
   *
   * - `position === null` ⇒ **删除**该会话的条目（恢复默认）；
   * - `position` 非空时 **`tierAtSelection` 必填** ——
   *   没有档位的条目会被 `sanitizePreferredRotation` 丢弃，等于白写
   *   （池那边已在源头 `return`，这里不要重复兜底）。
   *
   * ⚠️ **未实现时**（单测替身）⇒ 不写 ⇒ 子代理退回「每发按策略现算」
   *    ⇒ 行为仍可用，只是丢掉「首次定死」的缓存收益。
   */
  setPreferredRotation?(
    provider: string,
    sessionId: string,
    position: number | null,
    tierAtSelection?: RotationStartTier,
  ): Promise<void>
  /**
   * ★★★ **某会话「实际在用」的账号 id**（2026-11-25，可选能力）。
   *
   * 用户原话：「子代理轮换起点策略的参考对象，是主代理**实际在使用的帐号**，
   * 而不是下拉框选择的」。
   *
   * ⚠️ 未实现 / 返回 `undefined`（会话没发过请求 / 插件刚重启）
   * ⇒ 消费方回落 `preferredRotationFor`（下拉框位次）。
   */
  activeAccountOf?(provider: string, sessionId: string | undefined): string | undefined
  /**
   * ★★★ **记某会话「实际在用」的账号**（2026-11-25，可选能力）。
   *
   * ⚠️ 由本模块的**统一回报出口**（`report`）自动调用 —— 不需要各 provider 接线。
   * 实测 24 处 `createCredentialResolver` 里有 7 处没有 `reportAccount`，
   * 让它们各自配必然继续漏。
   */
  setActiveAccount?(
    provider: string,
    sessionId: string | undefined,
    accountId: string | undefined,
  ): void
  /**
   * ★★★ **无档位 provider 的子代理起点位次**（2026-11-25，可选能力）。
   *
   * ACCIO / ASTUDIO / MAGICREW 这类纯 key 池没有档位，而 `setPreferredRotation`
   * 会因「无档位」拒绝写入 ⇒ 起点每发重算 ⇒ 永远不稳定。
   * ⇒ 走这条**独立通道**（不进 `sanitizePreferredRotation`，不污染主代理语义）。
   */
  setSubagentStartPosition?(
    provider: string,
    sessionId: string,
    position: number,
  ): Promise<void> | void
  /** 读回 {@link setSubagentStartPosition} 写下的位次（1-based）。 */
  subagentStartPositionOf?(provider: string, sessionId: string | undefined): number | undefined
  /**
   * ★★★ **子代理专属设置**（2026-11-23，可选能力）。
   *
   * @returns `undefined` = 该 provider 没配子代理设置 ⇒ 走主代理逻辑
   *   （与加本功能之前**逐字节相同**，这是唯一的回归面）。
   */
  subagentRotationFor?(provider: string): SubagentRotationSetting | undefined
  /**
   * ★★★ **取某子代理的分配记录**（2026-11-23，可选能力）。
   *
   * ⚠️ 返回 `undefined` 有三种含义，调用方**一视同仁**地回落主代理：
   * 1. 该 sessionId 不是子代理（主代理会话）；
   * 2. 子代理的 `subagent/start` 没收到（插件晚于它启动）；
   * 3. 记录已被淘汰（超过 128 条）。
   */
  subagentAssignmentOf?(provider: string, sessionId: string | undefined): SubagentAssignment | undefined
  /**
   * **登记**一个子代理分配（2026-11-23，可选能力）。
   *
   * ⚠️ 调用点必须 **fire-and-forget**（`void ... .catch(() => {})`）：
   * 它是 async（要落盘），而选号路径不能等磁盘写。
   *
   * ⚠️ 幂等：resume 时重复调用**保留原 slot**（见 `recordSubagentAssignment`）。
   *
   * @returns 实际分配的 slot（`-1` = 参数非法，未记录）
   */
  recordSubagentStart?(
    provider: string,
    sessionId: string,
    parentSessionId: string,
    now: number,
  ): Promise<number>
  /**
   * ★★★ **钉住某子代理的账号**（2026-11-24，可选能力）。
   *
   * ## 为什么需要（用户原话）
   *
   * > 「我是希望『拉起时定死，只有该号不可用才换』，
   * >   这样可以保证子代理的缓存命中率高，如果频繁换帐号，缓存命中率就低了。」
   *
   * ⇒ prompt cache 按（账号 + 模型 + 前缀）命中；每发请求重算起点会让
   *   池子一波动就换号，缓存全失效、同一段长上下文被重复计费。
   *
   * ⚠️ 只在**真的选中了某账号**之后调用（读到坏凭据的号不该被钉）。
   *
   * ⚠️ 调用点必须 fire-and-forget：实现内部**先同步更新缓存**、再异步落盘。
   */
  pinSubagentAccount?(provider: string, sessionId: string, accountId: string): Promise<boolean>
  /**
   * ★★★ **记录用户手动选的账号**（2026-11-24，可选能力）。
   *
   * ## 用户原话
   *
   * > 「用户手动重选的话是按照用户的意愿来，
   * >   其他情况就是使用拉起时固定的那个，
   * >   可以避免系统乱换号，避免缓存命中低」
   *
   * ⇒ 优先级：`userPickedAccountId` > `pinnedAccountId` > `slot` 现算。
   *
   * ⚠️ 传 `undefined` = 清除手动选择（回落到 pin）。
   */
  setUserPickedAccount?(provider: string, sessionId: string, accountId: string | undefined): Promise<boolean>
  /**
   * ★ **起点选定那一刻的档位**（S6 可选能力；真实 `AccountPool` 已实现）。
   *
   * 用于判断「起点那一档是否已烧完」：不同则交出首位（见 `rotateFromPreferred`）。
   *
   * ⚠️ **未实现 / 返回 `undefined` ⇒ 回落 S5**（起点绝对第一）。
   * 这正是老数据与单测替身的行为，与改动前逐字节一致。
   *
   * ⚠️ 必须与 {@link preferredRotationFor} **成对**实现：只实现前者会让
   * S6 对老数据「静默不生效」且零报错（用户只会觉得「重选了起点还是先烧自己的」）。
   */
  rotationStartTierFor?(provider: string, sessionId: string | undefined): RotationStartTier | undefined
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
  /**
   * ★★★ **查「某会话的父会话 id」**（2026-11-24 上游第 3 轮审计建议的路 1）。
   *
   * ## 为什么需要（上游原话）
   *
   * > 「这个功能现在卡在一个根本障碍上：**插件拿不到「谁是子代理、父是谁」**。
   * >   三条可能的路，按可行性排：
   * >   **1. 从宿主会话头读**：`header.parentSession`（`dsh-session` types:76）
   * >      是**真的有**的 —— 如果能在 `agent/created` 或 pre-step 时读到
   * >      **当前会话的 header**，父 id 就有来源了。
   * >      这比 `subagent/start` payload 靠谱得多。」
   *
   * ## 为什么它比事件更可靠
   *
   * | 来源 | 性质 |
   * |---|---|
   * | `subagent/start` 事件 | **瞬时**：插件晚挂载 / 重启期间的事件永远收不到 |
   * | **`session.header.parentSession`** | **持久**：落在会话头里，任何时候读都有 |
   *
   * ⚠️ 实测（我的 P0 探针）：两者**当前都有值**且一致。但事件那条腿有
   *    「错过就永久丢」的窗口，而会话头没有。⇒ **优先用本依赖**，事件表只作兜底。
   *
   * ⚠️ **可选**：单测替身不实现 ⇒ 退回既有的事件表（`subagentParentOf`），
   *    行为不变。
   *
   * @returns 父会话 id；`undefined` = 本会话**不是子代理**（或查不到）
   */
  readonly subagentParentForSession?: (sessionId: string) => string | undefined
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
 *
 * ## ⚠️ 已登记的例外（2026-11-01，magicrew / magicrewintl）
 *
 * 两站**确实有**模型级免费概念（`src/magicrew-adapter.ts` 按 `magicrewIsFree(wirePoints)`
 * 产出 `isFree: true`），却仍用了本常量 —— 这是**退让**，不是「确认没有」：
 * `isFreeModel(modelId)` 是**同步 + 单个 id** 的判据，而 magicrew 的免费与否取决于
 * `fetchMagicrewModelPoints()` 异步取回、缓存在**适配器实例私有字段** `modelPoints`
 * 里的 `input_points`；resolver 与适配器是**两个对象**、装配顺序还是 resolver 在前
 * ⇒ 没有可注入的同步查询口。
 *
 * **后果（已知、已取证）**：`allowPermanent` 为 `false`（用户锁了永久积分）且池里
 * 只剩永久积分时，用户挑一个 0 点数的**免费**模型也会被拒，文案还会把用户推向
 * 「解锁永久积分」（不可逆地开始烧永久积分）。触发面很窄（必须同时满足锁 + 只剩永久 +
 * 选免费模型），且上游到底有没有 `input_points === 0` 的模型**尚未取证**。
 *
 * ⇒ 若要收紧：给适配器加一个同步查询 `isFreeModelById(id)`，并在 `src/index.ts`
 * 用 late-bound 引用接上（首次调用时适配器可能还没建 ⇒ 仍退化成非免费，方向保守）。
 * 在那之前**不得**把这行文档读成「magicrew 没有免费模型」。
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
  /**
   * 锁定态下「余额查不到」时是否降级放行（默认 `false` = 保持既有语义）。
   *
   * ⚠️ 只有**确认余额接口会被上游网关整片拒绝**的渠道才开（超级麦吉两站，
   * 2026-11-04 真机：国内站 HTTP 403 / 国际站 405，九个账号无一幸免）。
   * 不开时行为逐字不变：锁定 + 查不到 ⇒ `lockedError('unknown')` ⇒ 整个
   * provider 的模型列表被清空（用户报障「模型都选不了了」）。
   * 开了以后：查不到余额时放宽一次（允许消耗永久积分），只在余额**查得到**
   * 且真的没有可用档时才报锁定错误 —— 锁定语义在可判定时不变。
   */
  readonly degradeLockedWhenUnknown?: boolean
}

/**
 * 「轮换起点」在**免费模型**路径上的纯旋转（不判档位）。
 *
 * ## 为什么需要单独一个函数
 *
 * 免费模型分支**刻意不查余额**（免费模型不消耗积分，余额与它无关，也省一次
 * 网络请求）⇒ 拿不到档位 ⇒ **不能**用 `rotateFromPreferred`
 *（那个要用 `buddyBalanceTier(..., {allowPermanent})` 判「哪些号可用」，
 * 才能决定起点落在谁身上）。
 *
 * 而免费路径的候选已过 `enabled` / 封禁 / 逐模型限流，**全是可用项**
 * ⇒ 纯旋转即是全部语义，与 `account-pool.ts` 的 `rotateFromAccountId` 同型。
 *
 * ## 三条不变量
 *
 * 1. **集合不变**：只旋转，不增删；
 * 2. **保序**：起点前后各保持原相对顺序；
 * 3. **找不到 / 首位 / 未设置 ⇒ 原样**（仍返回新数组，不改入参）。
 */
function rotateFreeCandidates<T extends { id: string }>(
  candidates: readonly T[],
  rotationStartId: string | undefined,
): T[] {
  const copy = [...candidates]
  if (rotationStartId === undefined || rotationStartId.length === 0) return copy
  const index = copy.findIndex((c) => c.id === rotationStartId)
  if (index <= 0) return copy
  return [...copy.slice(index), ...copy.slice(0, index)]
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
    // 账号级封禁：整个账号排除（与 `AccountPool.candidateAccounts` 同一条判据，
    // 见 `isPolicyBlockedAccount`）。⚠️ 这两份判据必须同步改，否则「永久排除」
    // 只在池那条路径上生效，而真实请求走的是本函数（对抗审计 E8 实测的形态）。
    .filter(a => !isPolicyBlockedAccount(a))
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
    /**
     * ## ★★★ 2026-11-25：这里**同时**记「本会话实际在用账号」
     *
     * 用户在私有分支上的诊断原话：「子代理相关设置为什么没有生效：只有 UI，
     * 没有共同抽象层」。实测 24 处 `createCredentialResolver` 调用点里
     * **7 处没有 `reportAccount`**（ACCIO / MAGICREW / ASTUDIO 等）
     * ⇒ 记在**唯一出口**，24 个 provider 一次全覆盖。
     */
    const report = (accountId: string | undefined): void => {
      if (selection !== undefined) selection.accountId = accountId
      deps.reportAccount?.(accountId)
      /** ⚠️ `sessionId === undefined` 不记：目录/网关流量不占 key。 */
      if (sessionId !== undefined) deps.pool.setActiveAccount?.(providerId, sessionId, accountId)
    }
    /**
     * 分档编排排除掉的账号（**只有 buddy 协议会填**）—— 池兜底据此跳过它们，
     * 否则「档位最优但凭据损坏」的号会被 `getAvailableAccount` 立刻选回，
     * 兜底**原地打转**，换号形同虚设。
     */
    const tried = new Set<string>()
    const plan = config.balance
    /**
     * ★★★ **父会话 id：会话头优先，事件表兜底**（2026-11-24 上游建议的路 1）。
     *
     * ## 为什么换源
     *
     * 上一版只用 `subagentParentOf(sessionId)` —— 那是**进程内父子表**，
     * 由 `subagent/start` 事件填。它有两个窗口：
     * 1. **插件晚挂载**：子代理在插件加载前就拉起了 ⇒ 事件没收到；
     * 2. **插件重启**：表是进程内的，重启即清空。
     *
     * 而 `session.header.parentSession` 落在**会话头**（持久）里，
     * 任何时候读都有 ⇒ 无窗口。
     *
     * ⚠️ 两个来源**当前都有值且一致**（我的 P0 探针实测），但只有后者可靠。
     * ⇒ 会话头优先；事件表保留作兜底（单测替身 / 宿主版本差异时仍可用）。
     */
    const parentOfSession = (sid: string | undefined): string | undefined => {
      if (sid === undefined || sid.length === 0) return undefined
      try {
        const fromHeader = deps.subagentParentForSession?.(sid)
        if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader
      } catch { /* 依赖实现异常绝不影响选号 */ }
      /** 兜底：进程内事件表。 */
      try { return subagentParentOf(sid) } catch { return undefined }
    }
    /** ⚠️ 「是不是子代理」= 能查到父会话（两个来源的并集）。 */
    const isSubagentById = (sid: string | undefined): boolean =>
      sid !== undefined && parentOfSession(sid) !== undefined

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ★★★ **子代理首次拉起：算一次起点**（2026-11-25 重构）
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ## 用户定案
     *
     * > 「除了需要子代理轮换起点策略之外，其他点子代理跟主代理都一样的行为」
     * > 「这个位次就相当于用户在主代理手动选择下拉框一样」
     *
     * ## ⚠️⚠️ 为什么必须在 `plan.kind` 分支**之前**
     *
     * 本块的旧位置在 `if (plan?.kind === 'buddy') { … }` **里面** —— 而
     * ACCIO / ASTUDIO / MAGICREW / loomy 走的是 `else` / `else if (loomy)`
     * ⇒ **子代理设置对它们从未生效**（用户实测：「只有 UI，没有共同抽象层」）。
     *
     * ⇒ 提到所有分支之前，档位只作为**可选增强**：
     *
     * | 有无档位 | 写哪里 | 之后怎么切号 |
     * |---|---|---|
     * | 有（buddy 系）| `setPreferredRotation(位次, 档位)` | `rotateFromPreferred` 的 `tierStillHeld` |
     * | 无（纯 key 池）| `setSubagentStartPosition(位次)` | 按 slot 轮询（无档位概念）|
     *
     * ## 零回归（四条闸门，缺一不可）
     *
     * - 主代理：`hasAssignment === false` ⇒ 跳过
     * - 没配 `startMode` ⇒ 跳过
     * - 已有条目 ⇒ 跳过（只在**首次**算，保住 prompt cache 命中率）
     * - 替身没实现写入方法 ⇒ 跳过
     */
    if (shouldDecideSubagentStartOnFirstUse({
      sessionId,
      setting: deps.pool.subagentRotationFor?.(providerId),
      hasAssignment: sessionId !== undefined
        && deps.pool.subagentAssignmentOf?.(providerId, sessionId) !== undefined,
      hasPreferredRotation: sessionId !== undefined
        && deps.pool.preferredRotationFor?.(providerId, sessionId) !== undefined,
    })) {
      const firstParent = parentOfSession(sessionId as string)
      const firstCandidates = candidatesOf(deps.pool, providerId, modelId)
      /**
       * ⚠️ 位次换算必须与 `AccountPool.preferredRotationFor` 同口径
       * （那里是 `readAccounts().filter(enabled)[position - 1]`）。
       */
      const firstEnabledIds = deps.pool
        .listAccountsByProvider(providerId)
        .filter((a) => a.enabled)
        .map((a) => a.id)
      /**
       * ★ **档位选择器**：只有 buddy 系才有 `cachedTierOf`。
       * ⚠️ 用 `'cachedTierOf' in ...` 而不是判 `plan.kind` ——
       * 这样新 provider 只要实现了该方法就自动获得档位能力。
       */
      const firstTierSelector = plan !== undefined
        && 'cachedTierOf' in (plan.selector as object)
        ? (plan.selector as TierProbe)
        : undefined
      const firstDecision = decideSubagentStart({
        providerId,
        sessionId,
        candidateIds: firstCandidates.map((c) => c.id),
        allowPermanent: !deps.pool.permanentLocked(providerId),
        pool: deps.pool as never,
        selector: firstTierSelector === undefined
          ? undefined
          : (firstTierSelector as BuddySelectorLike),
        /**
         * ★★★ **参照对象 = 主代理「实际在用」的账号**（用户 2026-11-25 定案）。
         *
         * 三级回落（`??` 的先后就是优先级）：
         *
         * | 级 | 来源 | 何时有效 |
         * |---|---|---|
         * | ① | `activeAccountOf(父会话)` | 父会话发过请求（绝大多数）|
         * | ② | `preferredRotationFor(父会话)` | 插件刚重启 / 父会话还没发过请求 |
         * | ③ | 无 | 主代理也没配起点 ⇒ 按档位挑锚点 |
         */
        ...(firstParent === undefined
          ? {}
          : {
            mainSessionStartId:
              deps.pool.activeAccountOf?.(providerId, firstParent)
              ?? deps.pool.preferredRotationFor?.(providerId, firstParent),
          }),
      })
      const firstTarget = firstDecision.startId
      if (firstTarget !== undefined) {
        const firstPosition = positionOfAccount(firstEnabledIds, firstTarget)
        const firstTier = await probeRotationStartTier(firstTierSelector, firstTarget)
        if (firstPosition !== undefined) {
          try {
            if (firstTier !== undefined) {
              /** **有档位**：与主代理同一个落盘条目。 */
              await deps.pool.setPreferredRotation?.(providerId, sessionId as string, firstPosition, firstTier)
            } else {
              /** **无档位**：走独立通道（纯 key 池）。 */
              await deps.pool.setSubagentStartPosition?.(providerId, sessionId as string, firstPosition)
            }
          } catch { /* ⚠️ 写失败不影响本次选号（退回按策略现算） */ }
        }
      }
    }

    if (plan?.kind === 'buddy') {
      // ⚠️ `isFreeModel` **先于**候选构造求值：与旧闭包「在 options 字面量里
      //    await」的时序一致（它可能触发远端目录拉取，放到候选之后会把
      //    「先拉目录、再筛候选」这个顺序反过来）。
      // ⚠️ 字段现为**必填**（`NO_FREE_MODEL` 是「本家无免费模型」的显式表态），
      //    故不再需要 `=== undefined` 兜底 —— 那种兜底正是 Qoder 漏接三周的遮掩。
      const free = await plan.isFreeModel(modelId)
      const candidates = candidatesOf(deps.pool, providerId, modelId)

      /**
       * ★★★ **子代理分配登记必须在这里**（2026-11-24 实测修正）。
       *
       * ## 为什么不能放在原来的位置（第 763 行，免费分支之后）
       *
       * 免费模型（`free === true`）在 ① 分支里**直接 `return`**
       * ⇒ 后面那段登记**永远执行不到** ⇒ 分配表恒空
       * ⇒ `subagentAssignmentOf()` 恒 `undefined` ⇒ 起点计算整块被跳过。
       *
       * 实测证据：用户配了 `buddy.subagent = { startMode: 'reverse' }`，
       * 6 个子代理跑完 `state.json` 的 `subagentAssignments` 仍是 `{}`。
       *
       * ## ⚠️ 必须**同步**登记到内存（不能只 fire-and-forget）
       *
       * 本函数紧接着就要读 `subagentAssignmentOf()` 来算起点。
       * 若登记是 async 且不等待，本次请求读到的是**旧值**（`undefined`）
       * ⇒ 子代理的第一发请求必然用主代理起点。
       *
       * ⇒ `recordSubagentStart` 内部**先同步更新缓存**、再异步落盘
       *（见 `account-pool.ts` 的实现）。这里 `void` 掉是安全的
       *（落盘失败不影响本次选号）。
       */
      /**
       * ⚠️⚠️ **必须走共享的 `registerSubagentStartIfNeeded`**（2026-11-25 统一）。
       *
       * ## 原实现是**内联判据**，与 `subagent-start.ts` 的
       * `shouldRegisterSubagentStart` **不等价**：
       *
       * | 判据 | 条件 |
       * |---|---|
       * | 此处（旧内联）| `setting !== undefined && subagentSettingActive(setting) && parent !== undefined` |
       * | 共享函数 | `setting !== undefined && startMode 已声明 && sessionId 非空 && parent 非空` |
       *
       * 差异在 **`follow` + 配置了 `model`** 这一格：`subagentSettingActive` 判 `true`
       * （因为 model 有值），而 `startModeOf` 仍返回 `'follow'` ⇒ 两边**都算「要登记」**，
       * 结果相同。但**判据文本不同** ⇒ 将来改一边就会漂移。
       *
       * ## 为什么现在必须统一
       *
       * Bug 1 的根因正是「**自建选号的 provider 完全没接登记**」
       * （codearts / officeace）。若三处各写一份判据，将来必然再漏一处 ——
       * 本仓红线「同一语义不得两套实现」。
       *
       * ⇒ 三处（buddy 系 / codearts / officeace）**全部**走本函数。
       */
      registerSubagentStartIfNeeded({
        pool: deps.pool as never,
        providerId,
        sessionId,
        parentSessionId: sessionId === undefined ? undefined : parentOfSession(sessionId),
        setting: deps.pool.subagentRotationFor?.(providerId),
      })

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
        /**
         * ⚠️⚠️ **「轮换起点」必须也作用于免费模型**（真实缺陷，2026-11-11 用户实测）：
         * 他选了「账号 2 · M移0959」，实际却仍用「账号 1 · M电4016」。
         *
         * 根因：上面的免费短路按 `candidates` 原序取第一个凭据可读的号并**直接
         * return**，而 `rotationStartId` 的计算在它**之后**（L544）⇒ 永远到不了。
         *
         * ## 为什么当初写「免费模型不重排」是错的
         *
         * 那个理由原文是「免费路径不看档位，只挑第一个凭据可读的号，插优先级会
         * 改变它的既有语义」。**它只对「档位」成立，对「起点」不成立** ——
         * 起点不是档位，它只是「从谁开始数」，与是否消耗积分毫无关系。
         *
         * ## ⚠️ 这里**不能**调 `rotateFromPreferred`
         *
         * 那个函数要用 `buddyBalanceTier(..., { allowPermanent })` 判「可用」
         * 才能决定起点落点；而**本分支刻意不查余额**（免费模型没必要，也省一次
         * 网络请求）⇒ 拿不到档位。故这里做**纯旋转**（不跳不可用项）：
         * 免费路径的候选已过 enabled / 封禁 / 限流，且免费模型不受余额限制。
         */
        /**
         * ★★★ **子代理在免费模型上也要错开**（2026-11-24 用户实测报障：
         * 「你为什么子代理的帐号分配错了呢，全放在我那个不可用帐号上？」）。
         *
         * ## 缺陷         *
         * 子代理配置的模型是 `hy4flash-free`（**免费模型**）⇒ 走本分支 ⇒
         * 只按 `preferredRotationFor(...)`（**主代理**起点）旋转 ⇒
         * 而主代理起点是「默认，不指定」⇒ 不旋转 ⇒ **全部取第一个候选**
         * ⇒ 6 个子代理全落在位次 1 的账号上。
         *
         * ⚠️ 而子代理起点计算的代码在**第 711 行之后**（免费分支 return 之后）
         * ⇒ **永远执行不到**。
         *
         * ## 修法
         *
         * 免费分支自己算一次子代理起点：
         * 1. 该 provider 配了子代理设置 + 该会话是真子代理 ⇒ 用子代理策略算起点；
         * 2. 否则退回主代理起点（**零回归**）。
         *
         * ⚠️ 免费路径**刻意不查余额**（不消耗积分，省一次网络请求）⇒
         * 拿不到档位 ⇒ 这里做**纯旋转**（不跳「不可用」项），与既有语义一致。
         * ⇒ `sameTierIds` 用**全部候选**（档位未知时 `startIndexOfSlot` 的
         * `sequence` / `reverse` 仍然正确：它只按索引挪位）。
         */
        let freeStartId = deps.pool.preferredRotationFor?.(providerId, sessionId)
        if (sessionId !== undefined) {
          const subSetting = deps.pool.subagentRotationFor?.(providerId)
          const subAssignment = deps.pool.subagentAssignmentOf?.(providerId, sessionId)
          /**
           * ★★★ **优先用钉住的账号**（2026-11-24 用户要求：拉起时定死）。
           *
           * ## 为什么（用户原话）
           *
           * > 「我是希望『拉起时定死，只有该号不可用才换』，
           * >   这样可以保证子代理的缓存命中率高，如果频繁换帐号，缓存命中率就低了。」
           *
           * ⇒ prompt cache 按（账号 + 模型 + 前缀）命中。
           *   每发请求重算起点 ⇒ 池子一波动就换号 ⇒ 缓存全失效。
           *
           * ## 判据（免费路径）
           *
           * pin 的号**仍在 `candidates` 里** ⇒ 可用（免费模型不查积分/档位）。
           * ⚠️ 不在 ⇒ 已停用 / 封禁 / 限流 ⇒ **重算**（下面的逻辑）并重钉。
           */
          /**
           * ★★★ **优先级：用户手动选 > 系统 pin > 策略现算**
           *（2026-11-24 用户定 B 方案，与付费路径**逐字同构**）。
           *
           * ⚠️ 两处必须同步改 —— 本仓反复记录过「同一语义两处实现必然漂移」。
           * 免费路径的「可用」判据只有一条：**在 `candidates` 里**
           *（免费不查积分/档位）。
           */
          /**
           * ⚠️ **免费路径不再有 pin / userPicked**（2026-11-25 重构）。
           *
           * 子代理的起点现在存在 `preferredRotation`（与主代理同一个地方）——
           * 上面 `freeStartId` 已经通过 `preferredRotationFor` 读到了它
           * ⇒ 这里**不需要**任何子代理专属优先级。
           */
          /**
           * ⚠️ **不再有 pin / userPicked 分支**（2026-11-25 重构）。
           *
           * 子代理的起点（含「用户手选」）现在统一存在 `preferredRotation`
           * （与主代理同一个地方）⇒ 上面的 `freeStartId` 已经通过
           * `preferredRotationFor` 读到了它 ⇒ 这里**只有策略现算**一条腿。
           *
           * ⚠️ `fixed` 模式也在下面这条腿里处理（用 `fixedPosition` 取位次）。
           */
          if (subSetting !== undefined && subAssignment !== undefined
            && subSetting.startMode !== undefined && subSetting.startMode !== 'follow') {
            /**
             * ⚠️ 候选 id 序列用作「档位序列」—— 免费路径没有档位概念，
             * 而 `startIndexOfSlot` 只做索引算术，喂什么序列就在什么序列里挪。
             */
            const candidateIds = candidates.map((c) => c.id)
            /**
             * ⚠️ 基准 = 主代理起点（若它在候选里）否则候选第一个。
             * 与付费路径的 `effectiveMainStart` 同款兜底。
             */
            const baseId = freeStartId !== undefined && candidateIds.includes(freeStartId)
              ? freeStartId
              : candidateIds[0]
            if (baseId !== undefined) {
              if (subSetting.startMode === 'fixed') {
                /**
                 * `fixed`：直接用指定位次（1-based，在**全量启用账号**上算，
                 * 与付费路径同口径 —— 否则用户填的位次会指向别的号）。
                 */
                const enabledIds = deps.pool
                  .listAccountsByProvider(providerId)
                  .filter((a) => a.enabled)
                  .map((a) => a.id)
                const fixedId = accountIdAtPosition(enabledIds, subSetting.fixedPosition)
                if (fixedId !== undefined) freeStartId = fixedId
              } else {
                const derived = startIndexOfSlot(
                  candidateIds,
                  baseId,
                  subSetting.startMode,
                  subAssignment.slot,
                  subAssignment.sessionId,
                )
                if (derived !== undefined) freeStartId = derived
              }
            }
          }
        }
        const freeCandidates = rotateFreeCandidates(candidates, freeStartId)
        for (const candidate of freeCandidates) {
          const credential = await config.readCredential(candidate.credentialRef)
          if (credential !== undefined) {
            if (plan.reportPickedAccount !== false) report(candidate.id)
            /**
             * ★ **把首次算出的账号钉住**（2026-11-24）。
             *
             * ⚠️ 只在**真的选中了**之后钉 —— 若 we 在某号上读到坏凭据，
             * 那一号不该被钉（下一次还会重试它，说明它可能只是临时故障）。
             *
             * ⚠️ fire-and-forget：落盘不能阻塞本次选号。
             * `pinSubagentAccount` 内部**先同步更新缓存**（同 `recordSubagentStart`），
             * 故下一发请求立刻就能读到。
             */
            /**
             * ⚠️⚠️ **必须加 `fixed` 守卫，与付费路径逐字同构**
             *（2026-11-24 上游三轮审计 ⑤：免费路径写 pin 时没有 fixed 守卫）。
             *
             * ## 为什么 `fixed` 不能钉
             *
             * `fixed` 模式的起点是**用户显式指定的位次**，每次都由 `accountIdAtPosition`
             * 现算 ⇒ 结果恒定。钉住它有两个害处：
             * 1. **把「策略结果」写成「系统事实」**——用户之后改位次，pin 会拖住旧号；
             * 2. 与付费路径**行为不一致**（那边 `pinMode !== 'fixed'` 早已有守卫）。
             *
             * ⚠️ 付费路径的守卫在 `picked.kind === 'account'` 之后（`pinMode !== 'fixed'`）。
             *   两处必须逐字同构 —— 本仓反复记录过「同一语义两处实现必然漂移」。
             */
            const freePinMode = deps.pool.subagentRotationFor?.(providerId)?.startMode
            if (sessionId !== undefined && freePinMode !== 'fixed') {
              void deps.pool.pinSubagentAccount?.(providerId, sessionId, candidate.id)
                .catch(() => { /* 钉住失败不影响本次选号 */ })
            }
            return credential
          }
          tried.add(candidate.id)
        }
        // 免费模型下若凭据全坏，仍落到常规路径，以复用既有的错误语义
        //（凭据问题应报「凭据不可用」，而不是被误报成「额度已用尽」）。
      }

      // ② 余额分档编排（共享实现 `pickBuddyAccount`，**不要**在本文件再手写一份）。
      const allowPermanent = !deps.pool.permanentLocked(providerId)
      /**
       * 「轮换起点」：本会话指定的起始账号（用户 2026-11-10 需求）。
       *
       * ⚠️ 三条judge：
       * 1. **免费模型不参与** —— 免费路径（上面 ①）压根不看档位/顺序，只挑第一个
       *    凭据可读的号；在那里插起点会改变它的既有语义，且收益为零（不消耗积分）；
       * 2. **与 `strictManualOrder` 无关** —— 严格模式下**同样生效**
       *    （旋转只挪起点，不改「档位只当可用性判据」这条）；
       * 3. **未实现 `preferredRotationFor`（单测替身）⇒ `undefined`** ⇒
       *    行为与改动前**逐字节相同**（本功能的唯一回归面）。
       */
      const baseRotationStartId = free === true
        ? undefined
        : deps.pool.preferredRotationFor?.(providerId, sessionId)
      /**
       * ★★★ **子代理专属起点**（2026-11-23）。
       *
       * ## 它修的是什么
       *
       * 现状下所有子代理与主代理**共用同一个起点** ⇒ 多个子代理挤同一个账号，
       * 把它的积分耗尽，而其它账号闲置到过期。
       *
       * ## 判据链（顺序不能反）
       *
       * | 步骤 | 判据 | 不满足时 |
       * |---|---|---|
       * | ① 免费模型 | `free === true` | 跳过（免费路径不烧积分，插起点收益为零）|
       * | ② 该会话是子代理 | 分配表里有该 `sessionId` | 走主代理逻辑（**唯一回归面**）|
       * | ③ 该 provider 配了子代理设置 | `subagentRotationFor()` 非空 | 同上 |
       * | ④ 算出起点 | 见下 | 回落主代理起点 |
       *
       * ## ⚠️⚠️ 起点只在**主代理起点所在档位内**错开
       *
       * 用户明确要求子代理也必须遵守「临期 → 短期 → 永久」（2026-11-23）：
       *
       * > 「子代理在分配帐号起点时，肯定也要像主代理一样，遵守档次优先的原则呀」
       *
       * ⇒ `rotateFromPreferred` 内部始终先按档位分组，故只要起点落在同档位内，
       * 子代理的第一枪**必然是临期**。跨档位反转（我第一版的错误）会让它先烧短期。
       *
       * ## ⚠️ `fixed` 模式是**绝对第一**
       *
       * 它**不走档位序列** —— 直接返回指定位次的账号，由
       * `pickBuddyAccount` 的 `pinnedFirst` 保证「无视档位、恒排第一」。
       */
      let rotationStartId = baseRotationStartId
      /**
       * ★★★ **起点是否由子代理逻辑决定**（2026-11-24，档位快照配套的判据）。
       *
       * 三种来源：pin/userPicked（由 `startDecidedByPin` 同步置位）、
       * `fixed`（`subagentPinnedFirst`）、slot 现算（`subagentDerivedStart`）。
       *
       * ⚠️ **必须声明在 try 块外**：它在 `pickBuddyAccount` 之前读（档位快照），
       * 而那一段不在子代理的 try 块内。
       *
       * ⚠️ 不能复用另外两个标记：实测 pin 命中时**两者都是 false**
       * ⇒ 档位快照仍按主会话 id 读 ⇒ 上游指出的「账号 B + A 的档位」错配。
       */
      /**
       * ⚠️⚠️ **子代理分配登记必须先于一切条件**（2026-11-23 实测修正）。
       *
       * ## 缺陷（我上一版把登记塞进了 `if (free !== true && baseRotationStartId !== undefined)`）
       *
       * 那导致两个**静默失效**：
       *
       * | 场景 | 后果 |
       * |---|---|
       * | 子代理用**免费模型**（`free === true`）| **永不登记** ⇒ 之后切到付费模型也没记录 |
       * | 主代理**没配起点**（`baseRotationStartId === undefined`）| **永不登记** ⇒ 配了子代理策略也不生效 |
       *
       * 两者都不报错，症状是「设了没反应」。
       *
       * ## 为什么登记要独立
       *
       * 「这个 sessionId 是子代理」是**会话属性**，与「本次用免费还是付费模型」
       * 和「主代理有没有配起点」**无关**。把前者绑在后两者上，就是
       * 本仓反复记录的「同一语义被不该管它的条件限制住」。
       *
       * ⇒ 只要「确实是子代理」+「该 provider 配了子代理设置」就登记，
       * 无论模型是否免费、主代理是否有起点。
       */
      /* 登记已移到 `free` 判断之前（免费分支会 return，故必须提前）。 */
      /**
       * ★★★ **子代理起点计算：不依赖「主代理是否配了起点」**
       *（2026-11-24 用户实测打穿的真实缺陷）。
       *
       * ## 缺陷（用户截图实证）
       *
       * 上一版整块被包在 `if (free !== true && baseRotationStartId !== undefined)` 里。
       * 用户实测时主代理的起点是「**默认，不指定**」⇒ `baseRotationStartId === undefined`
       * ⇒ 整块跳过 ⇒ **子代理起点永不生效**。
       *
       * 症状：用户在档次窗口配了「倒序分布」，拉起的 6 个子代理**全用同一个账号**。
       *
       * ## 为什么不该依赖主代理起点
       *
       * 用户 2026-11-23 的原始需求是「**可以指定子代理的起点**」——
       * 它是一个**独立设置**，凭什么要求主代理先配起点？
       *
       * ## 「主代理起点」的兜底
       *
       * `sequence` / `reverse` / `hash` 的语义是「从**主代理起点**开始错开」。
       * 主代理没配起点时，它的实际起点是「**档次排序里的第一个可用账号**」——
       * 所以这里用 `undefined` 作为基准传入 `startIndexOfSlot`，
       * 由它内部按「档位序列的第 0 项」处理（见该函数的 `base < 0` 分支说明）。
       *
       * ⚠️ 但 `startIndexOfSlot` 现在遇到「主代理不在档位序列里」会返回
       * `undefined`（刻意不猜）。子代理场景下那个判据**太严**：
       * 我们允许「基准缺失时从档位第一个开始」。
       * ⇒ 这里显式用 `effectiveMainStart` 兜底。
       */
      /**
       * ★ **起点选定那一刻的档位快照**（S6，2026-11-20）。
       *
       * `undefined` 的两种来源都回落 S5（起点绝对第一）：
       * 1. 没配起点；
       * 2. 老数据（升级前选的起点，`state.json` 里没有该字段）。
       *
       * ⚠️ 与 `rotationStartId` **成对读取**：只传 id 不传档位 ⇒ 永远走 S5
       * ⇒ 本功能对老数据「静默不生效」且**不会有任何报错**。
       *
       * ⚠️⚠️ **子代理现在也走这条腿**（2026-11-25 重构）：
       * 首次拉起时已把「起点 + 档位」写进 `preferredRotation[子代理sessionId]`
       * ⇒ `preferredRotationFor` / `rotationStartTierFor` 都能查到
       * ⇒ **不需要任何子代理专属分支**。
       */
      const rotationStartTier = rotationStartId === undefined
        ? undefined
        : deps.pool.rotationStartTierFor?.(providerId, sessionId)
      /**
       * ⚠️ **必须带上 `enabledAccountIds`**：`rotateFromPreferred` 要用它算
       * 「起点在池里的位次」；不给的话，起点账号若被限流/封禁滤掉，
       * 它会「找不到就原样」⇒ **静默回落第一个号** ⇒ 起点形同没配。
       */
      const enabledAccountIds = rotationStartId === undefined
        ? undefined
        : deps.pool
            .listAccountsByProvider(providerId)
            .filter(a => a.enabled)
            .map(a => a.id)

      const picked = await pickBuddyAccount<TCredential>(plan.selector, candidates, {
        allowPermanent,
        resolveCredential: config.readCredential,
        degradeOnUnknown: plan.degradeLockedWhenUnknown === true,
        // ⚠️ **每次现读**（面板可随时切换），且**未实现时视为关闭** ——
        //    单测替身与结构化 stub 不实现它时必须走既有语义（`=== true` 判据）。
        strictManualOrder: deps.pool.strictManualOrder?.(providerId) === true,
        ...(rotationStartId === undefined ? {} : { rotationStartId }),
        ...(rotationStartTier === undefined ? {} : { rotationStartTier }),
        ...(enabledAccountIds === undefined ? {} : { enabledAccountIds }),
      })
      if (picked.kind === 'account') {
        if (plan.reportPickedAccount !== false) report(picked.account.id)
        /**
         * ★ **钉住本次真正选中的账号**（2026-11-24 用户要求：拉起时定死）。
         *
         * ## 三种情况都写回
         *
         * | 情况 | 效果 |
         * |---|---|
         * | 首次（无 pin）| 把首发的号定下来 ⇒ 后续请求不再重算 |
         * | pin 仍在且可用 `pickBuddyAccount` 会选它 ⇒ 同值 ⇒ **内部判等跳过写盘** |
         * | pin 失效（空号/停用）| 把新选中的号写回 ⇒ 从这发起重新定死 |
         *
         * ⚠️ 「同值跳过」很重要：稳态下**每发请求都会走到这里**，
         *   若无条件写盘，等于每发请求多一次磁盘写（本仓的
         *   `queueStoreSave` 有合并，但仍不该白跑）。
         *   实现里 `pin === current` 时返回 `false` 且**不写盘**。
         *
         * ⚠️ **「固定帐号」模式不钉**：那种模式下用户已经指定了绝对第一的号，
         *   再钉一个「当前命中」会让它在位次变动后与用户意图分叉。
         */
        const pinMode = deps.pool.subagentRotationFor?.(providerId)?.startMode
        if (sessionId !== undefined && pinMode !== 'fixed') {
          void deps.pool.pinSubagentAccount?.(providerId, sessionId, picked.account.id)
            .catch(() => { /* 钉住失败不影响本次选号 */ })
        }
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
        const picked = await plan.selector.select(candidates, {
          allowPermanent,
          ...(deps.pool.strictManualOrder?.(providerId) === true ? { strictManualOrder: true } : {}),
        })
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
    /**
     * 「轮换起点」（池选号路径：codearts / cline / gemini / opencode …）。
     *
     * ⚠️ **`session-balance`（zcode 会话亲和）刻意不参与**：那套用 rendezvous 哈希
     * 把会话稳定映射到账号，优先级由哈希决定；插一个起点会与哈希结果互相干扰。
     * ⚠️ 该路径**没有余额档位**（候选已过 enabled/封禁/限流）⇒ 纯旋转即可。
     */
    const poolRotationStart = config.accountSelection === 'session-balance'
      ? undefined
      : deps.pool.preferredRotationFor?.(providerId, sessionId)
    const available = config.accountSelection === 'session-balance'
      && poolSwitch
      && deps.pool.getAvailableAccountForSession !== undefined
      ? await deps.pool.getAvailableAccountForSession(providerId, modelId ?? '', sessionId, tried)
      : await deps.pool.getAvailableAccount(providerId, modelId ?? '', tried, poolRotationStart)
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
