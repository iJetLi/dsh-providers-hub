/**
 * **子代理起点分配**（从 `credential-resolver.ts` 提取，2026-11-25）。
 *
 * ## 为什么单独成模块
 *
 * 本仓有两类 provider：
 *
 * | 类型 | 选号实现 | 子代理支持 |
 * |---|---|---|
 * | **走 resolver**（buddy / qoder / trae / trae …）| `createCredentialResolver` | ✅ 自动拥有 |
 * | **自建选号**（codearts / officeace / …）| 各自的 `resolveCredential` / factory | ❌ **拿不到** |
 *
 * 这些逻辑原先**内联在 `credential-resolver.ts`** 里（约 50 处调用点），
 * 自建选号的 provider 想支持子代理只能**手抄一份** —— 而本仓已有记录：
 * 同一语义两套实现必然漂移（上游为这套逻辑改过 **6 轮审计**）。
 *
 * ⇒ 提取成**纯函数 + 依赖注入**，两类 provider 共用同一份判据。
 *
 * ## 语义（三级优先级，与上游 `credential-resolver` 逐字同构）
 *
 * | 级 | 来源 | 含义 | `fixed` 模式下 |
 * |---|---|---|---|
 * | ① | `userPickedAccountId` | 用户在该子代理页面手动选的 | **仍生效**（最具体）|
 * | ② | `pinnedAccountId` | 系统拉起时固定 / 重算的 | **跳过**（旧策略的结果）|
 * | ③ | 策略现算 | `fixed` 位次 / `sequence` / `reverse` / `hash` | **必须走到** |
 *
 * ⚠️ **`fixed` 模式必须跳过 ②**：若该子代理早先落下了 pin（比如之前用
 * `sequence`，用户后来改成 `fixed`），② 会命中 ⇒ ③ 的 `fixed` 分支
 * **永远走不到** ⇒ 用户改位次无效，而界面显示的是新位次 ⇒ 界面与实效不一致。
 *
 * ## 纯函数纪律
 *
 * 本模块**不做任何 IO**：
 * - 所有池读取通过注入的 `pool` 回调；
 * - 不读 `Date.now()`（调用方传入）；
 * - 不写盘（`pinSubagentAccount` / `recordSubagentStart` 由调用方执行）。
 *
 * @module src/subagent-start
 */

import { accountIdAtPosition, isSubagentSession, startIndexOfSlot } from './subagent-rotation.js'
import type { SubagentAssignment } from './subagent-rotation.js'
import type { SubagentRotationSetting } from './jet-hub-store.js'
import type { RotationStartTier } from './jet-hub-store.js'
import type { BuddyCandidateAccount, BuddySelectorLike } from './buddy-balance-selector.js'
import { BUDDY_BALANCE_TIER, buddyBalanceTier } from './buddy-balance-rank.js'

/** 策略模式（与 `SubagentRotationSetting.startMode` 同值域，但显式列出便于阅读）。 */
export type SubagentStartMode = 'follow' | 'sequence' | 'reverse' | 'hash' | 'fixed'

/**
 * 子代理起点分配所需的**池读能力**（注入，便于单测替身）。
 *
 * ⚠️ **全部可选**：缺省时退化为主代理行为（既有语义），
 * 这是「单测替身与结构 stub 不实现时必须走既有路径」的兑现。
 */
export interface SubagentStartPoolLike {
  subagentRotationFor?(provider: string): SubagentRotationSetting | undefined
  subagentAssignmentOf?(provider: string, sessionId: string | undefined): SubagentAssignment | undefined
  preferredRotationFor?(provider: string, sessionId: string): string | undefined
  listAccountsByProvider(provider: string): ReadonlyArray<{ id: string; enabled: boolean }>
  /**
   * ⚠️ **登记起点分配**（2026-11-25 加，修 Bug 1）。
   *
   * `decideSubagentStart` 靠 `subagentAssignmentOf` 拿 `slot` 算错开位次，
   * 而那张表只有本方法会写。**自建选号的 provider（codearts / officeace）
   * 原先完全没有调它** ⇒ 分配表恒空 ⇒ `slot` 恒 0 ⇒ 全撞号。
   *
   * ⚠️ 可选：单测替身不实现时 `registerSubagentStartIfNeeded` 静默跳过
   *    （行为与改动前一致）。
   */
  recordSubagentStart?(
    provider: string,
    sessionId: string,
    parentSessionId: string,
    now: number,
  ): Promise<number>
}

/** 起点分配的结果。 */
export interface SubagentStartDecision {
  /**
   * 决策出来的起点账号 id。
   *
   * ⚠️ `undefined` ⇒ **保持调用方原有的起点**（主代理行为逐字节不变）。
   */
  startId?: string
  /**
   * ★ **是否「绝对第一」**（无视档位变化，恒排第一）。
   *
   * 只有两种情形为 `true`：
   * - 子代理的起点的**所有权属于子代理**（pin / userPicked / 策略现算）；
   * - `fixed` 模式（用户明确要求「该号烧完才切」）。
   */
  pinnedFirst: boolean
  /**
   * 起点是否由**子代理**决定（而非主代理）。
   *
   * 调用方据此决定「不传档位快照」—— 因为那份快照属于主代理的起点。
   */
  ownedBySubagent: boolean
  /**
   * 选完账号后**是否重新 pin**。
   *
   * ⚠️ `fixed` 模式**不 pin**：位次是用户设的，pin 会让下次「位次变了也不生效」
   * （与「`fixed` 跳过 ②」同一个理由）。
   */
  shouldPin: boolean
  /** 决策来源（供诊断 / 日志，不影响选号）。 */
  decidedBy: 'user-pick' | 'pin' | 'fixed-position' | 'strategy' | 'none'
}

/**
 * 该子代理是否**该登记起点**（`subagent/start` 首次到达时）。
 *
 * ## 判据三条同时成立
 *
 * 1. 配了子代理设置且**已启用**（`subagentSettingActive`）；
 * 2. 该会话**确实是子代理**（父会话可解析）；
 * 3. 尚未登记过（`recordSubagentStart` 内部幂等，这里只做「要不要调」的判断）。
 *
 * ⚠️ 为什么单独抽出来：`credential-resolver` 里这条判据曾经**绑在
 * 「免费模型 / 主代理有起点」两个额外条件里**（上游 `cde3201c` 修的真缺陷：
 * 两条静默失效）。自建选号的 provider 若手抄，必然重现。
 */
export function shouldRegisterSubagentStart(
  setting: SubagentRotationSetting | undefined,
  sessionId: string | undefined,
  parentSessionId: string | undefined,
): boolean {
  if (setting === undefined) return false
  if (sessionId === undefined || sessionId.length === 0) return false
  if (parentSessionId === undefined || parentSessionId.length === 0) return false
  // `follow` 也算「配置了但不需要错开」⇒ 仍要登记（否则以后改成 sequence 时没有基准）。
  return startModeOf(setting) !== undefined
}

/** 读 `startMode`（缺失 ⇒ `undefined`，**不得**默认成 `follow`）。 */
function startModeOf(setting: SubagentRotationSetting | undefined): SubagentStartMode | undefined {
  if (setting === undefined) return undefined
  const mode = setting.startMode
  if (mode === undefined) return undefined
  return mode
}

/**
 * ★★★ **登记子代理起点分配 —— 自建选号 provider 的共享入口**
 * （2026-11-25 修 Bug 1）。
 *
 * ## 这个函数修的是什么（用户原话）
 *
 * > 「子代理设置里面的帐号分布方式不成功」
 *
 * ## 根因
 *
 * `decideSubagentStart` 读 `assignment.slot` 来算错开位次，而 `assignment`
 * 来自 `subagentAssignmentOf(provider, sessionId)` —— 那张表**只有
 * `recordSubagentStart` 会写**。
 *
 * | provider | 选起点 | **登记分配** | 后果 |
 * |---|---|---|---|
 * | buddy 系（`credential-resolver`）| ✅ | ✅ | 正常 |
 * | **codearts**（`index.ts`）| ✅ | ❌ **原先没有** | slot 恒 0 ⇒ 全撞号 |
 * | **officeace**（`officeace-lock.ts`）| ✅ | ❌ **原先没有** | 同上 |
 *
 * ⇒ 三个 provider 对同一件事只做了三分之二 —— 本仓反复记录的
 *   「同一语义多处实现必然漂移」。
 *
 * ## 为什么必须抽成这里（而不是各 provider 手抄）
 *
 * `credential-resolver.ts:720-734` 的判据曾经**绑在「免费模型 / 主代理有起点」
 * 两个额外条件里**（上游 `cde3201c` 修的真缺陷：两条静默失效）。
 * 手抄必然重现 ⇒ 这里与那边用**同一个** `shouldRegisterSubagentStart`。
 *
 * ## ⚠️ 为什么是 fire-and-forget
 *
 * `recordSubagentStart` 内部**先同步更新缓存**、再异步落盘（见 `account-pool.ts`）
 * ⇒ `void` 掉是安全的，且**本次请求就能读到新 slot**（本函数紧接着要算起点）。
 *
 * @param options.pool        池（必须实现 `recordSubagentStart`）
 * @param options.providerId  provider id
 * @param options.sessionId   子代理自己的会话 id
 * @param options.parentSessionId 父会话 id（`undefined` ⇒ 不登记，宁缺不猜）
 * @param options.setting     子代理设置（`undefined` ⇒ 没配 ⇒ 不登记）
 * @returns 是否**发起了**登记（`false` = 条件不满足，调用方可据此诊断）
 */
export function registerSubagentStartIfNeeded(options: {
  pool: {
    recordSubagentStart?(
      provider: string,
      sessionId: string,
      parentSessionId: string,
      now: number,
    ): Promise<number>
  }
  providerId: string
  sessionId: string | undefined
  parentSessionId: string | undefined
  setting: SubagentRotationSetting | undefined
  /** 注入时钟（单测可固定）。 */
  now?: () => number
}): boolean {
  if (!shouldRegisterSubagentStart(options.setting, options.sessionId, options.parentSessionId)) {
    return false
  }
  /** ⚠️ `shouldRegisterSubagentStart` 已保证这两个非空，但 TS 收窄不了 ⇒ 断言。 */
  const sessionId = options.sessionId as string
  const parentSessionId = options.parentSessionId as string
  try {
    void options.pool.recordSubagentStart?.(
      options.providerId,
      sessionId,
      parentSessionId,
      options.now?.() ?? Date.now(),
    ).catch(() => { /* 登记失败不影响本次选号 */ })
    return true
  } catch {
    /** ⚠️ 任何异常都不能影响选号（这是每发请求都要跑的路径）。 */
    return false
  }
}

/**
 * ★★★ **算子代理的起点**（本模块的唯一入口）。
 *
 * @param options.providerId  provider id（池读取用）
 * @param options.sessionId   当前会话（子代理自己的）
 * @param options.candidateIds 当前**可用**候选（enabled / 未封禁 / 未限流）
 * @param options.allowPermanent 是否允许烧永久积分（档位判据要用）
 * @param options.pool        池读能力（注入）
 * @param options.selector    余额分档选择器（`cachedTierOf` 用于档位过滤）
 * @param options.mainSessionStartId 主代理当前起点（`undefined` = 主代理没配）
 *
 * @returns 决策；`startId === undefined` ⇒ 调用方**保持原起点**。
 */
export function decideSubagentStart(options: {
  providerId: string
  sessionId: string | undefined
  candidateIds: readonly string[]
  allowPermanent: boolean
  pool: SubagentStartPoolLike
  selector?: BuddySelectorLike
  mainSessionStartId?: string
  /**
   * ⚠️ 主代理的起点（用于「主代理自己不是子代理」时的档位基准）。
   * 传 `undefined` ⇒ 用 `bestTierAnchorId` 找档位最优的号作锚。
   */
  baseRotationStartId?: string
}): SubagentStartDecision {
  const { providerId, sessionId, candidateIds, allowPermanent, pool } = options

  /** 无 `sessionId` ⇒ 与主代理无关（目录路径 / 网关流量）⇒ 保持原行为。 */
  if (sessionId === undefined || sessionId.length === 0) {
    return { pinnedFirst: false, ownedBySubagent: false, shouldPin: false, decidedBy: 'none' }
  }

  const setting = pool.subagentRotationFor?.(providerId)
  const mode = startModeOf(setting)
  /** ⚠️ 没配 / 没启用 ⇒ **完全保持主代理行为**（零回归的关键）。 */
  if (setting === undefined || mode === undefined || mode === 'follow') {
    return { pinnedFirst: false, ownedBySubagent: false, shouldPin: false, decidedBy: 'none' }
  }

  const assignment = pool.subagentAssignmentOf?.(providerId, sessionId)
  const candidateSet = new Set(candidateIds)
  const enabledIds = pool.listAccountsByProvider(providerId)
    .filter((a) => a.enabled)
    .map((a) => a.id)

  let startId: string | undefined
  let decidedBy: SubagentStartDecision['decidedBy'] = 'none'
  let pinnedFirst = false

  /**
   * ⚠️ **不再有 pin / userPicked 分支**（2026-11-25 重构）。
   *
   * 用户手选现在**直接写 `preferredRotation`**（与主代理同一个入口），
   * 而「首次算出的起点」也写在同一个地方 ⇒ 本函数**只负责首次计算**，
   * 不参与「后续请求该用哪个号」的判断。
   *
   * ⇒ 这里直接从策略现算开始。
   */
  // ── ③ 策略现算 ──
  /** ⚠️ 没有 pin/userPicked 分支了 ⇒ 策略**总是**参与（2026-11-25 重构）。 */
  const strategyShouldApply = true

  if (strategyShouldApply && mode === 'fixed') {
    /**
     * ⚠️ **位次在「全量启用账号」上取**（与主代理同口径）：
     * 位次是池序而非「当前候选序」，否则拖一下顺序 / 某号被限流时位次会指错。
     */
    const fixedId = accountIdAtPosition(enabledIds, setting.fixedPosition)
    /**
     * ⚠️ 位次越界 ⇒ **回落主代理起点**（不静默取最后一个）：
     * 用户设「位次 5」而只剩 3 个号时悄悄用第 3 个，会让用户以为「固定」失效了。
     */
    if (fixedId !== undefined) {
      startId = fixedId
      decidedBy = 'fixed-position'
      /** ★ 绝对第一：用户明确要求「该号临期和短期都烧，烧没了才切」。 */
      pinnedFirst = true
    }
  } else if (strategyShouldApply) {
    // ── `sequence` / `reverse` / `hash`：在主代理起点**所在档位**内错开 ──
    /**
     * ⚠️⚠️ **闸门必须读「主代理的起点」，不能读子代理自己的**
     * （上游第四轮审计 P1 真缺陷：`baseRotationStartId` 用子代理的 sessionId
     *  恒 `undefined` ⇒ 档位过滤一次都没生效 ⇒ 子代理可以先烧永久积分）。
     */
    const tierAnchorId = options.mainSessionStartId ?? options.baseRotationStartId
    const effectiveTierAnchorId = tierAnchorId
      ?? bestTierAnchorId(enabledIds, options.selector, allowPermanent)
    const sameTierIds = effectiveTierAnchorId === undefined
      ? enabledIds
      : sameTierAsMainStart(enabledIds, effectiveTierAnchorId, options.selector, allowPermanent)
    /**
     * ⚠️⚠️ **错开基准必须先「落进同档序列」再取**（原实现的三级回落，2026-11-24）。
     *
     * | 级 | 候选 | 为什么 |
     * |---|---|---|
     * | ① | `mainSessionStartId` **且在同档序列里** | 主代理当前实际用的号，最准 |
     * | ② | `baseRotationStartId` **且在同档序列里** | 主代理配了起点时用它 |
     * | ③ | `sameTierIds[0]` | 前两者都不在档内时，用档内第一个 |
     *
     * ⚠️ 若直接把 `effectiveTierAnchorId` 传给 `startIndexOfSlot`：那个值可能
     * **不在 `sameTierIds` 里**（档位缓存刚失效、或档位变了）⇒
     * `startIndexOfSlot` 的 `tierIds.indexOf(mainStartId)` 返回 `-1` ⇒
     * 它走「`base < 0`」分支 ⇒ **错开规律与上游不一致**。
     */
    const effectiveMainStart = (() => {
      if (options.mainSessionStartId !== undefined && sameTierIds.includes(options.mainSessionStartId)) {
        return options.mainSessionStartId
      }
      if (options.baseRotationStartId !== undefined && sameTierIds.includes(options.baseRotationStartId)) {
        return options.baseRotationStartId
      }
      return sameTierIds[0]
    })()

    /**
     * ⚠️ **参数顺序**：`startIndexOfSlot(tierIds, mainStartId, mode, slot, sessionId)`
     * —— 第 4 个是 **slot 数字**（第几个子代理），第 5 个才是 sessionId。
     * 写反会让哈希选号恒按 sessionId 当 slot 用（错开规律完全错）。
     */
    const derived = startIndexOfSlot(
      sameTierIds,
      effectiveMainStart,
      mode,
      assignment?.slot ?? 0,
      sessionId,
    )
    if (effectiveMainStart !== undefined && derived !== undefined) {
      startId = derived
      decidedBy = 'strategy'
    }
  }

  return {
    ...(startId === undefined ? {} : { startId }),
    /**
     * ★★★ **`pinnedFirst` 只在两种情况下为真**（2026-11-25 修复，用户报障）。
     *
     * ## 原缺陷
     *
     * ```ts
     * pinnedFirst: pinnedFirst || startId !== undefined,   // ← 恒真
     * ```
     *
     * `startId !== undefined` 在**任何**策略下都成立（①user-pick / ②pin /
     * ③strategy 现算 / `fixed` 位次都会给它赋值）⇒ **只要配了子代理就恒 `true`**。
     *
     * 而 `buddy-balance-rank.ts` 的 `pinnedHeld` 一旦为真就**短路 S6**：
     *
     * ```ts
     * if (!tierStillHeld && !pinnedHeld) { /* 交出首位 *\/ }
     * ```
     *
     * ⇒ 起点**永远占第一**，不看档位变化 ⇒ 用户报的：
     * **「选定了帐号使用积分消耗完临期后不会自动切换号」**。
     *
     * ⚠️ 这也推翻了本文件 L197-200 的注释意图：
     *    「`pinnedFirst` 不设：pin 只是起点，档位规则仍然生效
     *      （否则会去烧永久积分）」—— 那个意图被 `|| startId !== undefined` 抹掉了。
     *
     * ## 正确语义
     *
     * | 起点来源 | `pinnedFirst` | 理由 |
     * |---|---|---|
     * | `follow`（无起点）| `false` | 就是主代理行为 |
     * | `sequence` / `reverse` / `hash` | **`false`** | 只是「错开起点」，**档位规则必须生效** |
     * | 系统 `pin`（非 fixed）| **`false`** | pin 是「拉起时定死起点」，不是「无视档位」|
     * | **`fixed`** | **`true`** | 用户明确要求「该号临期和短期都烧，烧没了才切」|
     * | **用户手选** | **`true`** | 用户最强意愿，必须绝对第一 |
     *
     * ⚠️ **`fixed` / 手选时仍保留可用性兜底**：`pinnedFirst` 只是「跳过档位检查」，
     *    `buddy-balance-rank` 里 `anchor` 的循环仍会排除「完全无积分」的号
     *    ⇒ 真的烧光了还是会切（这正是用户要的）。
     */
    pinnedFirst,
    ownedBySubagent: startId !== undefined,
    /** ⚠️ `fixed` 不 pin：位次是用户设的，pin 会让下次位次变更失效。 */
    shouldPin: mode !== 'fixed',
    decidedBy,
  }
}

/**
 * 找「档位最优（临期优先）且可用」的账号作锚点。
 *
 * ⚠️ 从 `credential-resolver.ts` 原样提取（**行为不变**）。
 *
 * ## 为什么需要
 *
 * 「无锚点」恰是**生产默认**（主代理不指定起点）。上一版在无锚点时直接用
 * 全池 ⇒ 档位过滤一次都没生效 ⇒ 池 `[临期A, 临期B, 永久P]` 时
 * **第二个子代理拿到永久号、先烧永久积分**（上游双审 P1①）。
 */
export function bestTierAnchorId(
  enabledIds: readonly string[],
  selector: BuddySelectorLike | undefined,
  allowPermanent: boolean,
): string | undefined {
  if (selector === undefined || typeof selector.cachedTierOf !== 'function') return undefined
  const asCandidate = (id: string) => ({ id } as BuddyCandidateAccount)
  let best: { id: string; tier: number } | undefined
  for (const id of enabledIds) {
    const tier = selector.cachedTierOf!(asCandidate(id), allowPermanent)
    /**
     * ⚠️ **必须同时跳 `undefined`**（原实现逐字如此）：
     * 那是「该号没有余额缓存」⇒ 拿它当锚会把子代理导向未知档位。
     * 只写 `=== none` 会让 `undefined` 参与比较（`undefined < number` 恒 false，
     * 于是第一个 undefined 号被当成 best 占住位置）。
     */
    if (tier === undefined || tier >= BUDDY_BALANCE_TIER.none) continue
    if (best === undefined || tier < best.tier) best = { id, tier }
  }
  return best?.id
}

/**
 * 取「与主代理起点**同档位**」的账号子集。
 *
 * ⚠️ 从 `credential-resolver.ts` 原样提取（**行为不变**）。
 *
 * ## 为什么必须做档位过滤
 *
 * 用户明确要求「子代理也要遵守档次优先：临期 → 短期 → 永久」。
 * 不过滤 ⇒ 子代理可能错开到永久号上 ⇒ **先烧永久积分**。
 *
 * @param mainStartId 主代理当前起点（**不是**子代理的）
 */
export function sameTierAsMainStart(
  enabledIds: readonly string[],
  mainStartId: string,
  selector: BuddySelectorLike | undefined,
  allowPermanent: boolean,
): readonly string[] {
  if (selector === undefined || typeof selector.cachedTierOf !== 'function') return enabledIds
  const asCandidate = (id: string) => ({ id } as BuddyCandidateAccount)
  const startTier = selector.cachedTierOf!(asCandidate(mainStartId), allowPermanent)
  /**
   * ★★★ **只有 `undefined` 才返回全池**（2026-11-26 上游审计 P1 修复）。
   *
   * ## 缺陷（我上一版多加了 `none` 早退）
   *
   * ```ts
   * if (startTier === undefined || startTier === BUDDY_BALANCE_TIER.none) return enabledIds
   * //                               ↑ 多出来的，`master` 的原始实现没有它
   * ```
   *
   * 而注释当时写「原实现逐字如此」—— **与 `origin/master` 的源码相反**。
   *
   * ## 后果（穷举实测：54 个组合里 **18 个**复现）
   *
   * 主代理起点那个号**零余额 / 查询失败**（`none`）时：
   *
   * | 实现 | `sameTierIds` | 结果 |
   * |---|---|---|
   * | 有 `none` 早退 | **全池**（含永久号）| 子代理可选中永久号 ⇒ **先烧永久积分** |
   * | 只有 `undefined` | 只含同样 `none` 的号 | 下游找不到可用锚点 ⇒ 回落 `bestTierAnchorId`（临期）|
   *
   * ⇒ 这正是前 6 轮（`b8521557` / `d17dfa4d`）刚修好的「先烧永久积分」，
   *    被我这次重构**又引回来了**。
   *
   * ⚠️ `undefined`（无余额缓存，冷启动 / 刚过 TTL）仍然返回全池：
   *    那一刻**无法判断任何号的档位**，返回空子集会让子代理几乎无法错开
   *    （那正是 T2 用例抓到的形态）。
   */
  if (startTier === undefined) return enabledIds
  const same = enabledIds.filter((id) =>
    selector.cachedTierOf!(asCandidate(id), allowPermanent) === startTier)
  /**
   * ⚠️ **必须判「过滤后还含主代理起点」**（原实现逐字如此），不是判「非空」：
   * 若余额缓存刚失效、锚点自己不在同档里，返回一个**不含基准**的序列会让
   * 下游 `startIndexOfSlot` 因「找不到基准」返回 `undefined` ⇒ 起点丢失。
   */
  return same.includes(mainStartId) ? same : enabledIds
}

/** 供调用方判断「该会话是不是子代理」（转发，避免各处重复 import）。 */
export { isSubagentSession }

/** 导出档位枚举，供调用方判「该号是否还有可用积分」。 */
export { BUDDY_BALANCE_TIER, buddyBalanceTier }
export type { RotationStartTier }
