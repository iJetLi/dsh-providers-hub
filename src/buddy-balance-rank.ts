/**
 * CodeBuddy / WorkBuddy 账号按「积分何时作废」分档排序（负载均衡 + 永久积分锁定）。
 *
 * ## 它与 Loomy 那份（`loomy-balance-rank.ts`）的关系
 *
 * **同构但判据不同**，故刻意不共用实现：
 *
 * | | Loomy | 两个 buddy |
 * |---|---|---|
 * | 临时积分 | `dailyBalance` —— 服务端**直接给了一个字段** | 需要**自己算**：遍历资源包，取 `DeductionEndTime` 距今 **< 15 天** 的那几包余额之和 |
 * | 永久积分 | `balance`（注册奖励 + 新手任务，不过期） | 其余资源包（`DeductionEndTime` ≥ 15 天或未下发）的余额之和 |
 * | 到期节奏 | **当日**到期，明天重新发放 | **14 天 / 30 天 / 365 天**到期，没有「每天一笔」的概念 |
 *
 * ⚠️ 把两者压成一份代码需要把「什么叫临时」参数化成一个回调 —— 那会让本文件
 * 唯一有价值的东西（**15 天这条线是怎么来的**）从注释里消失，收益不抵损失。
 * 新增同族 provider 时优先扩本文件，不要再开第三份。
 *
 * ## 为什么用 `DeductionEndTime` 而不是 `CycleEndTime`（实测 2026-09-29）
 *
 * 两站真实账号的资源包形状：
 *
 * | 包 | `DeductionEndTime` 距今 | `CycleEndTime` 距今 | 归入 |
 * |---|---|---|---|
 * | WorkBuddy「Bonus Pack」 | 9 天 | 9 天 | **临时** |
 * | WorkBuddy「Free Plan Subscription」 | 3008 天 | **2 天** | **永久** |
 * | CodeBuddy「个人体验版」 | 3008 天 | 已过期 | 永久（本周期已无余额） |
 * | CodeBuddy「拉新权益包 / 国内运营裂变包」 | 17～208 天 | 同左 | ≥15 天者永久、<15 天者临时 |
 *
 * 套餐包的**计量周期**虽短（月度），但扣费截止在 8 年后 —— 取 `CycleEndTime`
 * 会把每月刷新的套餐判成「马上作废」，锁定永久积分就形同虚设。
 * 有效包的 `ExpiredTime` 一律是空串（它只在包真正失效后才回填），没有区分力。
 *
 * ## 策略（用户指定）
 *
 * | 档位 | 判据 | 含义 |
 * |---|---|---|
 * | 1 | `imminent > 0` | 有 **5 天内到期**的积分（临期）—— 再不用立刻作废，最优先 |
 * | 2 | `expiring > 0` | 只剩 **5~15 天内到期**的积分（短期） |
 * | 3 | `permanent > 0` | 只剩「永久」积分（≥ 15 天后才到期） |
 * | 4 | 其余（含**查询失败**） | 无可用余额 |
 *
 * ⚠️ 三档判据是**嵌套**的：`临期 ⊂ 15 天内`，故 `expiring` 桶同时包含临期与短期，
 * `imminent` 是它的子量。这样「锁定永久积分」的可用性判据（`expiring > 0`）不变。
 *
 * ⚠️ **档内保持传入顺序**（= 用户在 Jet Hub 拖拽的手动顺序），**不重排** ——
 * 与 `AccountPool.getAvailableAccount` 的既有语义一致。**临期档内同样如此**：
 * 两笔都临期时，顺序完全由帐号顺序决定，不按"谁更急"二次排序
 *（用户 2026-11-17 明确要求「原来是什么策略就使用什么策略」）。
 *
 * ⚠️ **查询失败归入最后一档**：宁可把请求发给能确认余额的号（与 Loomy 同规）。
 *
 * ⚠️ 本模块是**纯函数**，不碰网络与凭据 —— 余额由调用方查好后传入。
 */

import { isExclusiveCreditPool, type CreditBalance } from './credits.js'
import type { RotationStartTier } from './jet-hub-store.js'

/**
 * 「临时积分」的时间窗口：距扣费截止不足 **15 天**的积分算临时（会很快作废），
 * 其余算永久。用户 2026-09-29 定的判据。
 *
 * ⚠️ 这条线同时决定了**锁定永久积分**后哪些账号仍可用：只有 15 天内到期那部分
 * 积分可被消耗，故实测里「裂变包全部还有 17 天以上」的账号在锁定期间
 * **等同于无可用账号**（不是缺陷，正是该判据的直接推论）。
 */
export const BUDDY_EXPIRING_WINDOW_DAYS = 15

/** 由天数换算的毫秒窗口（导出供单测按同一口径构造时间戳）。 */
export const BUDDY_EXPIRING_WINDOW_MS = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000

/**
 * 「临期积分」的时间窗口：距扣费截止不足 **5 天**的积分算临期（最优先烧掉）。
 * 用户 2026-11-17 定的判据。
 *
 * ## 它与 15 天那条是**嵌套**关系，不是并列
 *
 * ```
 * 临期（< 5 天） ⊂ 短期（5 ~ 15 天） ⊂ 原「临时」（< 15 天）
 * ```
 *
 * 引入它的原因（用户 2026-11-17 需求）：原先**只有一条线**，于是「14 天后到期」
 * 与「3 天后到期」都算同一档 `expiring` ⇒ 排序时**全靠帐号顺序**决定先烧谁
 * ⇒ 一个还有 14 天的号会长期霸占轮换，而 3 天后作废的积分**一分没用上**。
 *
 * ## ⚠️ 它是 `expiring` 的**子量**，不是第 4 个平级桶
 *
 * `expiring` 的语义（15 天内）**逐字节不变** —— 这是刻意的，因为
 * `split.expiring > 0` 是「锁定永久积分」的可用性判据
 *（`src/officeace-lock.ts:255`、`plugin-src/client/usage-badge.js` 的 `expiringOf()`），
 * 改它的含义会让锁定态把一个「只有 3 天积分」的可用号误判成不可用。
 * 与 `permanent` 承载 `unknownExpiry` 子量是同一手法（见 `src/credits.ts:289-310`）。
 */
export const BUDDY_IMMINENT_WINDOW_DAYS = 5

/** 由天数换算的毫秒窗口（导出供单测按同一口径构造时间戳）。 */
export const BUDDY_IMMINENT_WINDOW_MS = BUDDY_IMMINENT_WINDOW_DAYS * 24 * 60 * 60 * 1000

/**
 * 覆盖「临期」窗口的环境变量名。
 *
 * ⚠️ 与 15 天那条同理：不同渠道的发卡节奏差别极大，5 天对某家合适、对另一家过紧。
 * 设成 `0` 可**关掉临期档**（退化成原来的两档）。
 */
export const DSH_BUDDY_IMMINENT_WINDOW_DAYS = 'DSH_BUDDY_IMMINENT_WINDOW_DAYS'

/**
 * 覆盖窗口的环境变量名。
 *
 * ## 为什么需要这道逃生门（实测 2026-09-29，真实账号）
 *
 * 15 天这条线在两站的效果**差别极大**：
 *
 * | 池 | 实测形状 | 锁定的后果 |
 * |---|---|---|
 * | WorkBuddy 5 个号 | Bonus Pack 250（8～9 天）+ Free Plan 100（3008 天） | 4 个号仍可用，1 个（Bonus Pack 已耗尽）不可用 —— 正是期望效果 |
 * | CodeBuddy 中国版 1 个号 | 裂变包共 10064.6，**距到期最少 17 天** | **立刻「无可用账号」**（17 天 > 15 天 ⇒ 全算永久） |
 *
 * 中国版的包是按 30 天发放的，所以"距到期"天然落在 17～30 天区间 ——
 * 判据本身没错，但这类池想用锁定就得把窗口放宽（如 `DSH_BUDDY_EXPIRING_WINDOW_DAYS=31`，
 * 让"本批包"整体算临时）。
 *
 * ⚠️ 窗口只能由**用户显式**改：默认值必须是用户定的 15 天。
 */
export const DSH_BUDDY_EXPIRING_WINDOW_DAYS = 'DSH_BUDDY_EXPIRING_WINDOW_DAYS'

/**
 * 当前生效的「临时积分」窗口（天）。
 *
 * ⚠️ **不能写成 `parseInt(raw) || 默认值`**：`0` 是合法值（表示「没有临时积分」，
 * 于是锁定期间整池不可用），而 `0` 是 falsy 会被 `||` 静默换成默认值 ——
 * 与 Qoder 排队超时那个坑同型。
 *
 * 非法值（空 / 非数字 / 负数）一律回落到默认窗口，不报错：这是展示与选号的
 * 辅助判据，配置写错不该让插件起不来。
 */
export function buddyExpiringWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DSH_BUDDY_EXPIRING_WINDOW_DAYS]
  if (typeof raw !== 'string' || raw.trim().length === 0) return BUDDY_EXPIRING_WINDOW_DAYS
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < 0) return BUDDY_EXPIRING_WINDOW_DAYS
  return parsed
}

/** 当前生效的窗口（毫秒）。 */
export function buddyExpiringWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return buddyExpiringWindowDays(env) * 24 * 60 * 60 * 1000
}

/**
 * 当前生效的「临期」窗口（天）。
 *
 * ⚠️ **解析纪律与 {@link buddyExpiringWindowDays} 逐条相同**：`0` 是**合法值**
 * （表示「关掉临期档，退化成两档」），故**绝不能**写 `Number(raw) || 默认值` ——
 * 那会把 `0` 静默换成 5。非法值（空 / 非数字 / 负数）回落到默认。
 */
export function buddyImminentWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DSH_BUDDY_IMMINENT_WINDOW_DAYS]
  if (typeof raw !== 'string' || raw.trim().length === 0) return BUDDY_IMMINENT_WINDOW_DAYS
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < 0) return BUDDY_IMMINENT_WINDOW_DAYS
  return parsed
}

/** 当前生效的临期窗口（毫秒）。 */
export function buddyImminentWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return buddyImminentWindowDays(env) * 24 * 60 * 60 * 1000
}

/**
 * 生效的临期窗口（毫秒）—— **全仓唯一的钳制点**。
 *
 * ## 为什么要钳制
 *
 * 两个窗口是**嵌套**的（临期 ⊂ 15 天）。用户可分别用两个环境变量调它们，
 * 于是出现「临期窗口比总窗口还大」时，分档表就自相矛盾了：
 *
 * | `DSH_BUDDY_EXPIRING_WINDOW_DAYS` | `DSH_BUDDY_IMMINENT_WINDOW_DAYS` | 不钳制的后果 |
 * |---|---|---|
 * | 15 | 20 | 「短期」档的判据 `5~15 天` 变成空区间 ⇒ 该档永远为 0（看着像缺陷） |
 * | 3 | 5 | 「临期」判据 `>3 天 且 <5 天` 两处比较打架 ⇒ 必须钳到 3 |
 *
 * 钳制后语义始终自洽：**临期 ⊂ 总窗口**，最坏情况是「短期档消失」，
 * 而那是用户显式把两个窗口调到相等/倒挂的**直接推论**，不是缺陷。
 *
 * ⚠️ 只在**这一处**钳制。调用方拿到的值已经是合法的 —— 别在别处再
 * `Math.min` 一次，那会让「同一语义两套判据」重新出现（本仓首条红线）。
 *
 * @param windowMs - 总窗口（15 天，已按 env 解析）。
 * @param imminentMs - 临期窗口候选值；省略时读环境变量。
 * @returns 恒 `>= 0` 且 `<= windowMs`。
 */
export function resolveImminentWindowMs(windowMs: number, imminentMs?: number): number {
  const raw = imminentMs ?? buddyImminentWindowMs()
  // 总窗口本身若是脏值（NaN / 负），退化成默认，避免把临期窗口也污染成 NaN。
  const total = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : BUDDY_EXPIRING_WINDOW_MS
  if (!Number.isFinite(raw) || raw < 0) return Math.min(BUDDY_IMMINENT_WINDOW_MS, total)
  return Math.min(raw, total)
}

/** 账号余额档位。数字越小越优先。 */
export const BUDDY_BALANCE_TIER = Object.freeze({
  /** 有 5 天内到期的积分（临期）—— 最优先消耗，否则直接作废。 */
  imminent: 0,
  /** 只剩 5~15 天内到期的积分（短期）—— 次优先。 */
  expiring: 1,
  /** 只剩永久积分（≥ 15 天后到期，或到期时间未知）—— 最后才用。 */
  permanent: 2,
  /** 无余额 / 查询失败 / 锁定态下只剩永久积分。 */
  none: 3,
} as const)

export type BuddyBalanceTier = (typeof BUDDY_BALANCE_TIER)[keyof typeof BUDDY_BALANCE_TIER]

/** 三类余额的拆分结果。 */
export interface BuddyCreditSplit {
  /**
   * 15 天内到期、**且尚未作废**的积分合计（本计费周期口径）。
   *
   * ⚠️⚠️ **语义与引入「临期」档之前逐字节相同**（= 临期 + 短期）。
   * 它是「锁定永久积分」的可用性判据（`split.expiring > 0` ⇒ 该号可烧），
   * 故**绝不能**把它改成「只有 5~15 天」—— 那会让一个只剩 3 天积分的可用号
   * 在锁定态被判成不可用。临期额度请读 {@link imminent}。
   */
  expiring: number
  /**
   * {@link expiring} 的**子量**：其中 5 天内到期的部分（临期，最优先烧掉）。
   *
   * 不变量 `0 <= imminent <= expiring`；只在 `> 0` 时出现在返回值里
   *（与 {@link expired} 同款约定，避免给每个调用方加一个恒 0 的键）。
   */
  imminent?: number
  /** 其余积分合计（≥ 15 天后到期，或到期时间未知）。 */
  permanent: number
  /**
   * **已经作废**的额度（`deductionEndTime <= now` 但 `active` 仍为 true）。
   *
   * ⚠️⚠️ **必须从 `expiring` 里摘出来**（2026-11-02 修，PR #168 对抗审计 B1）：
   * TRAE / Qoder 的 `active` 是**硬编码 true**（`trae-credits.ts` 从不反映是否过期），
   * 所以这类包一定会出现。旧行为把它算进 `expiring` ⇒
   * ① `buddyBalanceTier` 判 `expiring` = **可用**（锁定永久积分下也照发）；
   * ② `sharedPackageExpiry` 把它的过去时刻当最早 ⇒ 聚合**排第一**、先被烧；
   * ③ 请求必然失败（那些积分扣不到）。
   *
   * 摘出来之后：只剩作废额度的账号 ⇒ `expiring=0 permanent=0` ⇒ 档位 `none`（不可用），
   * 这正是「钱已经没了」的正确表示。
   *
   * 只在 `> 0` 时出现在返回值里（与前端 `splitCreditsByExpiry` 同款，避免给每个
   * 调用方加一个恒 0 的键）。
   */
  expired?: number
}

/** 参与分档的账号（两个字段缺失表示查询失败）。 */
export interface BuddyAccountBalance {
  id: string
  /** 15 天内到期的积分；`undefined` = 查询失败。 */
  expiringBalance?: number
  /**
   * 其中 5 天内到期的部分（{@link expiringBalance} 的子量）；`undefined` = 查询失败。
   *
   * ⚠️ 可选且**不校验**它是否真的 `<= expiringBalance` —— 分桶层
   *（{@link splitBuddyCreditsByExpiry}）天然保证 `imminent += remaining` 与
   * `expiring += remaining` 在同一分支里同时发生。外部手工构造的对象若倒挂，
   * 最坏后果只是档位判「临期」而金额偏小，不会误烧长期积分。
   */
  imminentBalance?: number
  /** 永久积分；`undefined` = 查询失败。 */
  permanentBalance?: number
}

/**
 * 把一个账号的积分余额拆成「快到期」与「永久」两桶。
 *
 * ⚠️ **口径是 `remaining`（= `CycleCapacityRemain`，本计费周期剩余）**，与
 * CodeBuddy IDE 顶部的 Credits Balance 一致。用户选定该口径的理由：实测
 * CodeBuddy 体验版套餐的**终身**剩余是 500 而**本周期**剩余是 0 ——
 * 那 500 实际扣不到，算进可用余额会让账号「看起来有钱却用不了」。
 *
 * ⚠️ **`active === false` 的包一律跳过**：失效包的服务端仍会返回余额，
 * 并进任何一桶都会虚增可用额度（`fetchCreditBalance` 的 `total` 同理只算有效包）。
 *
 * ⚠️ **到期时间未知（`deductionEndTime` 缺失 / 非正数）归入永久桶**：
 * 宁可把它当作「不会马上作废」——这是**保守方向**，最坏结果是锁定时少用一个号，
 * 而不是误把长期积分当成快到期烧掉。
 *
 * @param balance - `fetchCreditBalance` 的结果；`null`（查询失败）返回 `undefined`。
 * @param now - 当前时刻（毫秒），注入以便单测断言边界。
 * @param windowMs - 窗口，默认 {@link BUDDY_EXPIRING_WINDOW_MS}。
 * @param imminentMs - 「临期」子窗口，默认 {@link BUDDY_IMMINENT_WINDOW_MS}。
 *   ⚠️ 由调用方经 {@link resolveImminentWindowMs} 归一（保证 ≤ `windowMs`）
 *   —— 这里给默认值只为既有调用点（含大量用例）不必改动。
 * @returns 三桶合计（`expiring` 内含 `imminent` 子量）；`balance` 为 null/undefined
 *   时返回 `undefined`（= 查询失败）。
 */
export function splitBuddyCreditsByExpiry(
  balance: CreditBalance | null | undefined,
  now: number = Date.now(),
  windowMs: number = BUDDY_EXPIRING_WINDOW_MS,
  imminentMs: number = BUDDY_IMMINENT_WINDOW_MS,
): BuddyCreditSplit | undefined {
  if (balance === null || balance === undefined) return undefined
  /**
   * ⚠️⚠️ **容器层也要挡**（2026-11-18 对抗审计 P2-③）。
   *
   * 元素层早有 `if (!pkg) continue`（2026-10-21 那次审计加的），但 `packages`
   * 本身是 `{}` / 字符串 / `{ packages: {} }` 时 `for...of` 直接抛
   * `TypeError: packages is not iterable`，而 `selector.classify` 没有 try/catch
   * ⇒ **整条 `jet-hub/usage-badge` RPC 崩掉**（不是某个 provider 显示异常）。
   *
   * 客户端的 `splitCreditsByExpiry`（`plugin-src/client/credit-expiry.js:146`）
   * 同输入返回 `null`（= 不适用）⇒ 修前是**前后端两套答案**。这里对齐成
   * `undefined`（= 查询失败），与 `balance === null` 同义。
   */
  if (!Array.isArray(balance.packages)) return undefined
  let expiring = 0
  /**
   * `expiring` 的**子量**：其中距到期不足 `imminentMs` 的部分。
   *
   * ⚠️ 累加点与 `expiring` **在同一分支里成对发生**（见下方窗口比较）——
   * 这是 `0 <= imminent <= expiring` 这条不变量的**唯一**保证方式。
   * 若把它们写在两个 if 里，任何一次改动都可能让子量脱离母量。
   */
  let imminent = 0
  let permanent = 0
  let expired = 0
  for (const pkg of balance.packages) {
    /**
     * ⚠️ **必须挡 `null`/`undefined` 元素**（2026-10-21 对抗性审计发现，P2）。
     *
     * 前端 `splitCreditsByExpiry`（`credit-expiry.js`）第一句就是
     * `if (!pkg || pkg.active !== true) continue`，而这里原来直接读
     * `pkg.active` ⇒ `packages: [null]` 会让本函数抛**裸 TypeError**
     *（`Cannot read properties of null (reading 'active')`）。
     *
     * 后果不是「无可用账号」那句文案，而是一个未捕获异常穿出 `select()`
     *（`BuddyBalanceSelector.select` 没有 try/catch）⇒ 用户看到的是
     * 内部错误，而池里可能还有别的健康账号。
     *
     * 可达性：各 provider 目前都在 push 前过滤了非对象条目，故**当前不可达**；
     * 但这是**防御缺口**，且与前端**判据不对称**（同一份数据，前端跳过、后端抛错）。
     * ⇒ 按「同一语义两侧同判」补齐。
     */
    if (!pkg) continue
    if (pkg.active !== true) continue
    const remaining = positiveOrZero(pkg.remaining)
    if (remaining <= 0) continue
    /**
     * ⚠️⚠️ **独立池不进任何一桶**（2026-10-21 合并审计发现，阻断级）。
     *
     * AStudio 的星火池是服务端下发的**独立池**（不参与主池合计、也不能当
     * 通用积分消耗）。前端 `splitCreditsByExpiry`（PR !134）已把它从三档里
     * 摘出，而这里原先**完全不看 `pkg.name`** ⇒ 两侧口径分叉：
     * 同一份数据前端说「永久 0」、后端说「永久 25000」。
     *
     * ⇒ 用户可见症状：AStudio 账号只剩星火池时，面板显示「另有 25000 专属
     * （不计入）」而三档不渲染（看起来「没积分」），但后端把 25000 算成
     * **临期** ⇒ `buddyBalanceTier` 判 `expiring` ⇒ **锁定永久积分时该账号
     * 仍被判「可用」** ⇒ 选号把请求发给一个只有专属池的账号 ⇒ 上游按主池
     * 计费 ⇒ 请求失败。
     *
     * ⚠️ 判据用**宿主侧唯一持有点** `isExclusiveCreditPool`（`src/credits.ts`），
     * 客户端那份由单测锁死一致 —— 两侧不共享模块图，靠那条同步锁防漂移。
     */
    if (isExclusiveCreditPool(pkg)) continue
    const endTime = pkg.deductionEndTime
    /**
     * ⚠️⚠️ **判据必须用 `Number()`，不能用 `typeof === 'number'`**
     * （2026-10-21 对抗性审计发现，P2：这是**前后端分档对账**这条链路上唯一一处
     * 真正的「同一语义两套判据」）。
     *
     * ⚠️ **措辞更正（同日二轮审计自查）**：初版这里写的是「全仓**唯一**一处」，
     *    那是**过度声称** —— 全仓还有多处 `Date.parse` 型同义判据
     *   （`astudio-credits.ts` 的 `astudioLocalTimeMs` 与前端 `packageExpiryMs`
     *    都是 `Date.parse(raw.replace(' ', 'T'))`；`credits.ts` 的失效判定、
     *    `buddy.ts` / `cline.ts` / `codearts-credits.ts` 各有 `Date.parse`）。
     *    准确的说法是：**在「同一份 `packages[]` 被前端展示与后端选号各读一遍」
     *    这条特定链路上**，只有这一处判据不一致。
     *    ⇒ 「唯一」这类断言必须先**全仓清点**，不能凭本轮改到的范围下结论。
     *
     * ## 两侧原来不同判
     *
     * | 输入 `deductionEndTime` | 前端 `splitCreditsByExpiry` | 后端（旧） |
     * |---|---|---|
     * | `1760432000000`（number） | 临期 | 临期 |
     * | `"1760432000000"`（**数字字符串**） | **临期**（用 `Number()`） | **永久**（`typeof` 不是 number）|
     *
     * 实测（`packages: [{remaining:100, active:true, deductionEndTime:"1760432000000"}]`）：
     * ```
     * 前端: { expiring: 100, longTerm: 0, permanent: 0 }
     * 后端: { expiring: 0,   permanent: 100 }
     * ```
     * ⇒ 用户可见症状正是本仓库反复要防的那条：**面板说「临期 100」，
     *   而锁定永久积分时选号判 `none`、报「积分已用尽」**。
     *
     * ## 可达性（如实标注：低但非零）
     *
     * 三个 PR 新接的 provider（qoder / astudio / minimax / codearts）全部经
     * `Number()` / `Date.parse` 归一化后才写该字段，**都是 number** ⇒ 生产主路径
     * 不可达。可达的是**外部写进 `credits.balances` 的数据**：旧缓存、
     * 备份导入、用户手工编辑 `state.json`。
     *
     * ## 为什么改后端而不是改前端
     *
     * `Number()` 更宽容且**方向保守**：字符串数字本来就是「有确切到期时刻」，
     * 认出来才能正确分档；认不出会把它当成「永久」—— 那正是**误烧长期积分**
     * 的方向（`allowPermanent:false` 时永久桶被拦 ⇒ 该号被判不可用）。
     * 前端已经是 `Number()`，后端跟上即两侧一致，且**不放松任何现有判据**
     *（`Number(null)===0`、`Number('')===0`、`Number('abc')===NaN` 都会被
     * `Number.isFinite(...) && > 0` 挡住，与旧行为同判）。
     *
     * ⚠️ 注意 `Number(null) === 0`：**不能**只写 `Number.isFinite(Number(x))`，
     *    必须同时保留 `> 0`（否则 `null` 会被当成「时刻 0」）。已保留。
     *
     * ## ⚠️⚠️ **但 `Number()` 有两格意外翻转 —— 必须显式挡掉**（2026-10-21 二轮审计自查）
     *
     * 逐格比对「旧 `typeof` vs 新 `Number()`」时实测出**两格**从「未知」翻成「已知」，
     * 而它们**不是**「数字字符串」那种合法输入：
     *
     * | 输入 | `Number(x)` | 旧（`typeof`） | 新（仅 `Number()`） | 后果 |
     * |---|---|---|---|---|
     * | `true` | **1** | 未知 ⇒ 永久桶 | **已知 ⇒ 时刻 1ms（1970）** | ★ 误判成「早已过期」⇒ 进 `expiring` 桶 |
     * | `[1760432000000]` | **1760432000000** | 未知 ⇒ 永久桶 | **已知** | ★ 单元素数组被当成数字 |
     *
     * 两格的**共同方向都是「把非数字**放宽**成已知」** —— 与「认数字字符串」那个
     * 有意变更**不同源**（后者是合法的序列化形态，前者是类型污染）。
     * ⇒ 判据收窄为「**只接受 number 或数字字符串**」，其余一律当未知：
     *    `typeof === 'number'` **或** `typeof === 'string'`（且 `Number()` 后有效）。
     *    这样 `true` / `[]` / `{}` / `false` / `null` 全部回到「未知 ⇒ 永久桶」，
     *    与旧行为**逐格同判**，同时保留「数字字符串」这一个有意变更。
     */
    const endIsNumeric = typeof endTime === 'number' || typeof endTime === 'string'
    const endMs = endIsNumeric ? Number(endTime) : Number.NaN
    const known = Number.isFinite(endMs) && endMs > 0
    if (!known) {
      /**
       * 没有逐包到期时刻 ⇒ 默认算永久（保守：宁可少用，不可误烧长期积分）。
       *
       * ⚠️ **但 CodeArts 的赠送/按需包是例外**（2026-10-20）：上游不给逐笔
       * 日期，只在该分类 metric 上给「其中 N 即将到期」的标量，已被解析成
       * `pkg.expiringRemaining`。必须与前端 `splitCreditsByExpiry` **同规则**
       * 拆开，否则前后端漂移：
       *
       * - 前端把整包算永久 ⇒ 卡片显示「永久 25000」与新加的「临期 2500」矛盾；
       * - 后端若也整包算永久 ⇒ **锁定永久积分时该账号被判 `none` 不可用**，
       *   尽管它其实有 2500 临期积分能撑 —— 直接报「积分已用尽」。
       *
       * ⇒ 临期桶 += `expiringRemaining`，永久桶 += 余下部分。
       */
      const expiringPart = positiveOrZero(pkg.expiringRemaining)
      if (expiringPart > 0) {
        const capped = Math.min(expiringPart, remaining)
        expiring += capped
        permanent += remaining - capped
      } else {
        permanent += remaining
      }
      continue
    }
    // ⚠️ 用 `endMs`（已归一）而不是原始 `endTime` —— 后者可能是**数字字符串**，
    //    而 `"1760432000000" - now` 会走 JS 的字符串减数字转换（恰好也能算对），
    //    但那是隐式依赖、且与上面的 `known` 判据不同源。显式用 `endMs` 消除歧义。
    /**
     * ⚠️ **已作废 ⇒ 单独一桶**（2026-11-02，对抗审计 B1）：
     * `endMs <= now` 的额度**扣不到**，不能再算「临期可用」——
     * 否则它会同时骗过 `buddyBalanceTier`（判可用）与聚合排序（排第一先烧）。
     */
    if (endMs <= now) { expired += remaining; continue }
    /**
     * ⚠️⚠️ **临期判定必须与 `expiring` 累加在同一分支里成对发生**。
     *
     * `imminent` 是 `expiring` 的**子量**（`0 <= imminent <= expiring`）——
     * 这是本文件最重要的一条不变式，也是「锁定永久积分」不会误判的前提。
     * 若拆成两个独立 `if`（先把 `expiring` 累加、再单独判临期），
     * 将来任何一次边界调整都可能让子量脱离母量（子量 > 母量）。
     *
     * 边界方向与 15 天那条**严格一致**：`<` 才是窗口内。
     * ⇒ 正好 `imminentMs` 的那笔算**短期**，不算临期。
     */
    const left = endMs - now
    if (left < imminentMs) {
      imminent += remaining
      expiring += remaining
      continue
    }
    if (left < windowMs) expiring += remaining
    else permanent += remaining
  }
  /**
   * ⚠️ `imminent` / `expired` 都只在 `> 0` 时出现 —— 与前端 `unknownExpiry` 同款约定：
   * 多一个恒 0 的键会让所有「逐键 `toEqual`」的既有用例全线变红，且对 0 值毫无信息量。
   */
  return {
    expiring,
    permanent,
    ...imminent > 0 ? { imminent } : {},
    ...expired > 0 ? { expired } : {},
  }
}

/** 分档选项。 */
export interface BuddyTierOptions {
  /** 是否允许消耗永久积分。默认 `true`（解锁）。 */
  allowPermanent?: boolean
  /**
   * ★★★ **临期档的积分下限**（2026-11-27 用户需求）。
   *
   * 临期剩余 **≤ 该值** ⇒ 不再算临期 ⇒ 降级按「短期」排队。
   *
   * ⚠️ **`undefined` / 0 = 关闭** ⇒ `> 0` 与加这个功能之前**逐字节相同**（零回归）。
   * ⚠️ 这是用户的原话场景：一个号只剩 1 点临期时若还算「临期号」，
   *   系统会把它临期烧光**再吃部分短期**才切走 ⇒ 那个号的短期被污染。
   */
  imminentFloor?: number
  /** ★★★ **短期档的积分下限**（同上）。短期剩余 **≤ 该值** ⇒ 降级按「永久」排队。 */
  expiringFloor?: number
  /**
   * ⚠️ **当前实现不读它**（2026-11-01 四审登记）。保留只为调用形态稳定。
   *
   * 档位**只**取决于入参里**已经分好桶**的 `expiringBalance` / `permanentBalance` ——
   * 分桶发生在 {@link splitBuddyCreditsByExpiry}（那里才读 `now` / `windowMs`）。
   * 后果：测试里传 `windowMs: 1` 想让窗口「失效」是**空转**（实测 4 处全改后 20/20 仍绿）。
   * 要钉窗口边界，请改喂**不同到期时刻的原始包**，不要指望这个参数。
   */
  now?: number
  /** ⚠️ 同上：**当前实现不读它**（保留但无效果，别用它做窗口边界用例）。 */
  windowMs?: number
  /**
   * 「严格手动顺序」：**档位只决定可用性，不决定先后**（见
   * {@link rankBuddyAccountsByManualOrder}）。
   *
   * 默认 `false` = 既有语义（先按到期档位、档内看手动顺序）。
   *
   * ⚠️ 它**不影响** `buddyBalanceTier` 的返回值，只用在那两个排序函数的
   * 选择上 —— 故传 `true` 时「锁定永久积分」这道门照旧生效。
   */
  strictManualOrder?: boolean
  /**
   * 「轮换起点」：本会话指定的起始账号 id（`undefined` = 默认起点）。
   *
   * 语义：**只把轮换的起点挪到该账号**，不改任何档位/可用性判据。
   * 详见 {@link rotateFromPreferred}。
   */
  rotationStartId?: string
  /**
   * ★ **起点选定那一刻的档位**（S6，2026-11-20）。
   *
   * 语义：`rotateFromPreferred` 只在「起点**当前**档位 == 本字段」时让起点
   * 绝对第一；不同（= 那一档已烧完、档位下降）则**交出首位**，回到档位排序。
   * 详见 {@link rotateFromPreferred} 的 S6 说明。
   *
   * ## 三个取值的含义
   *
   * | 值 | 行为 |
   * |---|---|
   * | `'imminent'` / `'expiring'` / `'permanent'` | 按 S6 判降档 |
   * | **`undefined`** | **保持 S5**（起点绝对第一）—— 老数据 / 老客户端 |
   *
   * ⚠️ `undefined` 走 S5 是刻意的向后兼容：升级前选的起点没有这个快照，
   *    静默改变其行为违反本仓纪律。用户重选一次起点即启用 S6。
   */
  rotationStartTier?: RotationStartTier
  /**
   * 「轮换起点的定位基准」：**全量启用账号**的 id 列表（池序，**不过滤**封禁/限流）。
   *
   * ⚠️ 存在的理由（PR #59 正向审计 P1-a）：`rotationStartId` 指向的账号
   * 可能**不在候选集里**（被账号级封禁 / 被目标模型限流）—— 此时只按
   * `ranked.findIndex(id === startId)` 判会得到「找不到就原样」，于是
   * **静默回落默认第一个号**（恰是用户想避开的那个）。
   *
   * 提供本列表后，`rotateFromPreferred` 能算出「起点在池里的位次」，再从
   * 候选里取「位次 ≥ 起点」的第一个 —— 即用户明确要求的「循环到下一个可用」。
   *
   * `undefined` / 空数组 / 起点已被删除（不在本列表里）⇒ 保持既有语义
   * （找不到就原样，不报错）。
   */
  enabledAccountIds?: readonly string[]
  /**
   * ★★★ **把 `rotationStartId` 当作「绝对第一」**（2026-11-23）。
   *
   * ## 它解决什么问题
   *
   * 用户要求「子代理固定帐号」语义是：该号**还有任何可用积分就一直用它** ——
   * 烧完临期继续烧短期，烧完短期继续烧永久（未锁定时），「烧没了才切帐号」。
   *
   * 而 `rotationStartId` 的既有语义是 S5/S6 的「起点绝对第一**直到它那一档烧完**」
   * —— 烧完临期、落到短期档时就**交出首位**（S6）。那不满足用户的要求。
   *
   * ## 判据
   *
   * `pinnedFirst === true` 时**跳过** `tierStillHeld` 检查：
   * 只要 `rotationStartId` 那个账号**可用**（`buddyTierUsable` 为真），
   * 就恒排第一，**无视**它的档位怎么变。
   *
   * ## ⚠️ 「不可用」的准确含义
   *
   * 与主代理**完全同源**：
   *
   * ```ts
   * buddyTierUsable(buddyBalanceTier(account, { allowPermanent }))
   * ```
   *
   * | 场景 | `allowPermanent` | 判定 |
   * |---|---|---|
   * | 锁定永久 + 只剩永久积分 | `false` | **不可用** ⇒ 切帐号 |
   * | 未锁定 + 只剩永久积分 | `true` | **可用** ⇒ 继续用它烧永久 |
   * | 临期/短期任一 > 0 | 两者 | **可用** |
   * | 完全无积分 | 两者 | **不可用** ⇒ 切帐号 |
   *
   * 这正是用户 2026-11-23 确认的口径：
   * > 「未锁定永久的帐号就在用它的永久积分」
   *
   * ⚠️ `pinnedFirst` 只在 `rotationStartId` 已给且**该号确实可用**时生效；
   * 不可用时退回既有 S5/S6 逻辑（继续按档位找下一个）——
   * 那就是用户说的「烧没了才切帐号」。
   */
  pinnedFirst?: boolean
}

/**
 * 「轮换起点」的**唯一实现**：把已排好序的候选从指定账号处绕一圈。
 *
 * ## 语义（用户 2026-11-10 需求）
 *
 * ```
 * 策略顺序：A → B → C → D →（回到 A）
 * 选 C 后： C → D → A → B →（回到 C）
 * ```
 *
 * ⚠️ **只挪起点，不改任何策略**：
 * - 档位判据照旧（临期优先仍然成立）；
 * - 可用性过滤照旧（锁定永久积分时「只剩永久」仍不可用）；
 * - 失败换号照旧（`tried` 循环在旋转后的数组上跑）。
 *
 * ## ⚠️ 起点落在「往后第一个可用项」
 *
 * 用户选的号**可能当前不可用**，分两种成因，**都必须循环到下一个可用**、
 * 不能回落默认（用户明确要求）：
 *
 * 1. **在候选集里但档位不可用**（`none` 档）—— 向后扫时跳过；
 * 2. **压根不在候选集里**（账号级封禁 / 目标模型限流，被 `candidatesOf` 滤掉）
 *    —— 此时只按 `ranked.findIndex(id)` 会得到 `-1`，于是**静默回落默认第一个号**
 *    （恰是用户想避开的）。PR #59 正向审计 P1-a 实测。
 *
 * 成因 2 的修法：调用方额外传 {@link BuddyTierOptions.enabledAccountIds}
 * （**全量启用账号**的 id 列表，池序、不过滤封禁/限流）。本函数据它算出起点
 * 的**池位次**，再从候选里取「池位次 ≥ 起点」的第一个 —— 候选是按策略序
 * 排的，故那个就是「起点之后」的第一个候选。
 *
 * ## 三条不变量
 *
 * 1. **集合不变**：只旋转，不增删（长度与元素身份都不变）；
 * 2. **保序**：起点之后 / 之前的各自保持原相对顺序；
 * 3. **找不到就原样**：`rotationStartId` 指向的账号**已被删除**（不在
 *    `enabledAccountIds` 里）⇒ 与未设置**逐字节相同**，不报错。
 *    ⚠️ 与「起点被封禁/限流」**刻意区分**：后者账号还在，用户的选择仍有意义，
 *    故循环到下一个可用；前者选择已无处可指，回落默认才是唯一合理语义。
 *
 * @param ranked - **已按策略排好序**的候选（⚠️ 必须排在旋转之前）
 * @param options - 与排序同一份选项（需要 `allowPermanent` 判可用性，
 *   可选 `enabledAccountIds` 定位「不在候选里的起点」）
 * @returns **新数组**
 */
export function rotateFromPreferred<T extends BuddyAccountBalance>(
  ranked: readonly T[],
  options: BuddyTierOptions = {},
): T[] {
  const startId = options.rotationStartId
  if (startId === undefined || startId.length === 0) return [...ranked]
  const directIndex = ranked.findIndex((account) => account.id === startId)
  const enabledAccountIds = options.enabledAccountIds ?? []
  let index = directIndex
  if (index < 0) {
    // 成因 2：起点不在候选集里。先在全量启用账号里定位它的池位次。
    const startPosition = enabledAccountIds.indexOf(startId)
    // 不变量 3：账号已被删除 ⇒ 原样（= 默认起点）。
    if (startPosition < 0) return [...ranked]
    // 候选按策略序排；「池位次 ≥ 起点」的第一个就是「起点之后」的第一个候选。
    index = ranked.findIndex((account) => enabledAccountIds.indexOf(account.id) >= startPosition)
    // 起点是最后一位、其后没有候选 ⇒ 绕回开头（循环语义）。
    if (index < 0) index = 0
  }
  // ⚠️ 从 index 起**向后**找第一个可用项（step = 0 时先检查自己）。
  let anchor = -1
  for (let step = 0; step < ranked.length; step += 1) {
    const at = (index + step) % ranked.length
    if (buddyTierUsable(buddyBalanceTier(ranked[at]!, options))) { anchor = at; break }
  }
  // 全不可用 ⇒ 原样，交给上层报出真实原因（不要在这里抛）。
  if (anchor < 0) return [...ranked]
  /**
   * ★★★★ **S5 语义：起点**绝对第一** + 其余按档位优先 + 同档内循环**
   * （用户 2026-11-18 三次定稿，最终版）。
   *
   * ## 迭代脉络（每一次都是真实报障驱动的）
   *
   * | 版本 | 规则 | 报障 |
   * |---|---|---|
   * | S3 | 整条数组循环 | ⚠️ 起点在永久档时永久排第一、**临期沉底**，白等到过期 |
   * | S2 | 只把起点摘出来放最前（不循环）| ⚠️ 位次 7 被甩到最后 |
   * | S4 | 起点档内循环，**更优先的档整档前置** | ⚠️ **起点被挤到第 2 位** |
   * | **S5** | **起点绝对第一** + 其余档位优先 + 同档循环 | ✅ |
   *
   * ## 用户两次要求的原话（必须同时满足）
   *
   * 1. 「起点只提升自己，自己是什么档次就使用它的档次，
   *     然后剩余全部按默认策略档位排列」 ⇒ **起点第一**
   * 2. 「都是同一档次的情况下，肯定是按照循环来，
   *     而不是现在这种只是把选号 6 提到第一，其他的不变」 ⇒ **同档循环**
   *
   * S4 把第 1 条实现错了：它让「更优先的档」压过起点。
   * 用户实测（Qoder 7 个账号，起点=位次5 永久档、位次2 是临期）：
   *
   * ```
   * S4 ⇒ 位2(临期) → 位5(起点) → 位6 → …    ❌ 起点不是第一
   * S5 ⇒ 位5(起点) → 位2(临期) → 位6 → …    ✅
   * ```
   *
   * ## 规则（三条，按优先级）
   *
   * 1. **起点绝对第一**（无论它是什么档）；
   * 2. 其余账号按**档位优先序**：临期 → 短期 → 永久 → 不可用；
   * 3. **起点所在档内**从起点之后继续循环（绕回该档首），其余档保持原序。
   *
   * ⚠️⚠️ **已知代价（用户明确接受）**：起点在「永久」档且池里存在临期账号时，
   *    永久积分会先被烧掉 —— 这正是三档机制原本要避免的（临期会过期）。
   *    弹窗的起点档位提示（`rotationStartHint`）已把该后果告知用户。
   *    这里**不再替用户做「保护临期」的决定** —— 那是 S4 的错误。
   *
   * ## 三条不变量（S5 版）
   *
   * 1. **集合不变**：只重排，不增删；
   * 2. **起点必在首位**：只要找到可用起点，`out[0].id === startId`；
   * 3. **档内循环**：起点所在档内的相对顺序是「循环位移」，
   *    其余档内相对顺序**逐字节不变**。
   */
  const startAccount = ranked[anchor]!
  const anchorTier = buddyBalanceTier(startAccount, options)
  /** 分档边界用未锁定口径（`none` 档在锁定态可能是「只剩永久」，会混淆分组）。 */
  const tierRankOf = (account: T): number => buddyBalanceTier(account, { allowPermanent: true })
  const anchorRank = tierRankOf(startAccount)

  /**
   * ★★★★ **S6：起点只在「还持有选定那一档」时占首位**（2026-11-20，第四次修订）。
   *
   * ## 它修的是什么（用户真实报障）
   *
   * > 「位次4 那个 4016 的帐号，本来是有临期积分的，然后我选用它作为轮换起点，
   * >  消耗完临期积分后，它不会切换到下一个有临期积分的帐号也就是位次5，
   * >  而是直接消耗了位次4 的短期积分」
   *
   * ## 根因
   *
   * `expiringBalance` 是**母量**（= 临期 + 短期），而 `buddyBalanceTier` 只看它：
   *
   * ```
   * if (imminent > 0) → 临期(0)
   * if (expiring > 0) → 短期(1)   ← 临期烧完、短期还在，落这里
   * ```
   *
   * S5 规则是「起点绝对第一，只要可用」⇒ 起点临期烧完后落到「短期」档
   * （**仍然可用**）⇒ 永远占第一位 ⇒ 继续烧自己的短期/永久。
   *
   * ## 判据（这是本版全部逻辑）
   *
   * ```
   * 起点当前档位 == 用户选定它时的档位  ⇒  起点绝对第一（S5 行为）
   * 不等（= 那一档已烧完，档位下降）    ⇒  交出首位，回到档位排序
   * ```
   *
   * ⚠️ `tierAtSelection` 必须是**落盘的快照**，不能实时算 ——
   *    实时算等于「当前 == 当前」，恒成立，bug 依旧（见 `RotationStartTier` 注释）。
   *
   * ## ⚠️ 2026-11-20 二改：不再有「无快照回落 S5」
   *
   * 用户决定「最彻底：清除已选的起点，回归默认」⇒ `sanitizePreferredRotation`
   * 丢弃一切无档位的条目 ⇒ 只要走到本函数且存在起点，`rotationStartTier`
   * **必然有值**。故这里不再写 `tierAtSelection === undefined || …` 那种回落 ——
   * 那个回落会让老数据继续踩本 bug，正是要消除的行为。
   */
  const tierAtSelection = options.rotationStartTier
  const tierNow = ((): RotationStartTier | undefined => {
    const rank = tierRankOf(startAccount)
    if (rank === BUDDY_BALANCE_TIER.imminent) return 'imminent'
    if (rank === BUDDY_BALANCE_TIER.expiring) return 'expiring'
    if (rank === BUDDY_BALANCE_TIER.permanent) return 'permanent'
    return undefined
  })()
  /**
   * ⚠️ `tierAtSelection === undefined` 只可能来自**直接调用本函数的测试/内部代码**
   *（生产链路由 `sanitizePreferredRotation` 保证有值）。那种情况按「档位已变」处理
   * ⇒ 起点交出首位。**不回落 S5** —— 那会让缺陷复现。
   */
  const tierStillHeld = tierAtSelection !== undefined && tierNow === tierAtSelection

  /**
   * ★★★ **`pinnedFirst`：无视档位变化的「绝对第一」**（2026-11-23）。
   *
   * 用户要求「子代理固定帐号」在这条路径上：
   * > 「让它绝对第一，除非它不可用了……如果开了锁定永久，
   * >   则它临期和短期都烧，烧没了才切帐号」
   *
   * ⇒ 与 S6 的差别只有一格：**不检查「档位是否变了」**。
   * 只要起点号仍**可用**就恒排第一（烧完临期继续烧短期、再烧永久）。
   *
   * ⚠️ 「可用」判据**完全复用** `buddyTierUsable(buddyBalanceTier(...))`，
   * 不另写一份 —— 否则「锁定永久时只剩永久算不算可用」这条会两处漂移
   *（本仓红线：同一语义不得两套判据）。
   *
   * ⚠️ 不可用时**不在这里抛错**：`anchor` 已经是「从起点往后第一个可用」，
   * 走既有的 S5 分支即可（那就是用户说的「烧没了才切帐号」）。
   */
  const pinnedHeld = options.pinnedFirst === true

  // 按档分组（保持组内原序）
  const byRank = new Map<number, T[]>()
  for (const account of ranked) {
    const rank = tierRankOf(account)
    const group = byRank.get(rank)
    if (group === undefined) byRank.set(rank, [account])
    else group.push(account)
  }

  /**
   * ★ **S6 交出首位后的排序**：从起点开始按池序循环，再按档位稳定排序。
   *
   * 用户明确要求：「回归默认策略顺序不是指按照位次1来的默认，而是从轮换起点
   * 开始的策略循环，本起点消耗完临期了，则切换到起点后的下一个符合默认策略的帐号」
   *
   * ⇒ 顺序 = `旋转到起点开头(池序)` → `按档位稳定排序`。
   * 这样同档内是「从起点往后数」的循环，不是从位次 1 数。
   *
   * ⚠️ 需要**池序**（`enabledAccountIds`）。生产链路里只要配了起点就必然传入
   * （见 `credential-resolver`）。单测替身没传时退化为「档内原序」——
   * 那个降级**不会**影响本函数的正确性（只是循环原点不同），但会让测试与
   * 生产行为不一致，故这里显式写明。
   */
  const rotatedByPoolOrder = ((): T[] => {
    const poolIds = options.enabledAccountIds
    if (poolIds === undefined || poolIds.length === 0) return [...ranked]
    // 按池位次排序（不在池里的排最后，保持原相对序）
    const posOf = (id: string): number => {
      const at = poolIds.indexOf(id)
      return at < 0 ? Number.MAX_SAFE_INTEGER : at
    }
    const byPool = [...ranked].sort((a, b) => posOf(a.id) - posOf(b.id))
    const startAt = byPool.findIndex((a) => a.id === startAccount.id)
    if (startAt < 0) return byPool
    return [...byPool.slice(startAt), ...byPool.slice(0, startAt)]
  })()

  if (!tierStillHeld && !pinnedHeld) {
    /**
     * 起点已降档 ⇒ 交出首位。
     *
     * ⚠️ `pinnedHeld` 时**不进本分支**：那是「固定帐号」语义，
     * 要求无视档位变化恒排第一（见 `pinnedHeld` 的注释）。
     *
     * ⚠️ 排序必须**稳定**（`Array.prototype.sort` 在 ES2019+ 稳定），
     * 且比较器只比档位、不掺下标 —— 这样同档内保持 `rotatedByPoolOrder`
     * 的相对序（即「从起点往后数」的循环）。
     */
    return [...rotatedByPoolOrder].sort(
      (a, b) => tierRankOf(a) - tierRankOf(b),
    )
  }

  const result: T[] = [startAccount]
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const group = byRank.get(rank)!
    if (rank !== anchorRank) {
      // 其他档：整档原样（组内已排除起点？不 —— 起点只在 anchorRank 组里）
      result.push(...group)
      continue
    }
    // 起点所在档：从起点**之后**继续循环，再绕回该档首至起点之前
    const posInTier = group.findIndex((a) => a.id === startAccount.id)
    const ordered = posInTier >= 0
      ? [...group.slice(posInTier + 1), ...group.slice(0, posInTier)]
      : group
    result.push(...ordered)
  }
  // ⚠️ `anchorTier` 只为可读性保留（真正的分组边界用 tierRankOf，见上方说明）
  void anchorTier
  return result
}

/**
 * 判定单个账号的档位。
 *
 * ⚠️⚠️ **入参必须是「已分桶」的形状，不是 `CreditBalance`**（2026-11-01 三审实测踩到）：
 * 两个字段都是**可选**的 ⇒ TypeScript 对**任意对象**都放行（`CreditBalance` 也兼容）⇒
 * 传错时**编译零报错**，而 `positiveOrZero(undefined)` 归 0 ⇒ **恒返回 `none`**。
 * 症状极像真缺陷：「锁定永久积分后整池不可用」，与「所有号真的只剩永久」**同形**，
 * 且日志零字 —— 三审的探针就这样误报过一次（连「今天到期的 200 分」都被判成 none）。
 *
 * 正确形状只能由 `splitBuddyCreditsByExpiry(...)` 的 `{expiring, permanent}` 映射而来
 * （见 `src/buddy-balance-selector.ts` 的 `classify()` 与下面的 `rankBuddyAccountsByBalance`）。
 *
 * ⚠️ 刻意**不**把两个字段改成必填：`buddyBalanceTier({})` 返回 `none` 是既有用例
 * 明确要求的**防御语义**（`tests/unit/buddy-balance-rank.spec.ts` 有一条专门钉它），
 * 改成必填会连带推翻它 —— 故只登记、不改签名。
 *
 * ⚠️ **`expiring > 0` 优先于 `permanent > 0`**：快到期不用就作废，永久积分短期
 * 内还在。故只要还有 15 天内到期的余额就一定先用它。
 *
 * ⚠️ **锁定永久积分时（`allowPermanent: false`）**：永久积分不参与判定 ——
 * 只剩永久积分的账号直接落入 `none`（不可用），而不是降到 `permanent` 档。
 */
export function buddyBalanceTier(
  balance: { expiringBalance?: number; imminentBalance?: number; permanentBalance?: number },
  options: BuddyTierOptions = {},
): BuddyBalanceTier {
  /**
   * ⚠️ 两个「会作废」的档**必须在 `allowPermanent === false` 之前判**：
   * 临期与短期都在 15 天内 ⇒ 锁定时**仍可烧**。这保证「锁定永久积分」的
   * 可用性判据与引入临期档**之前逐字节相同**（那是最不能回归的一格）。
   *
   * ★★★ **积分下限（2026-11-27 用户需求）**：
   *
   * 判据从 `> 0` 变成 `> floor`（`floor` 缺省 0）。用户要的是「低于 20 就不再算临期，
   * 归入短期」—— 即剩余**不足**该值时不占用这一档，**提前切走**，
   * 免得系统把它临期烧光**再吃部分短期**（那会污染下一档）。
   *
   * ⚠️⚠️ **`>` 不是 `>=`**：`floor` 缺省 0 时 `remaining > 0` 正是改动前语义
   * （零回归）。写成 `>=` 会让「剩余恰好 0」也算该档，与现状分叉。
   *
   * ⚠️ **降级不浪费**：这里只决定「按哪一档排队」，不改「烧包顺序」——
   *   轮到这个号时它那点临期照样先烧（用户第 6 条定案）。
   *
   * ⚠️ **锁定永久时降级到 `none` 而不是 `permanent`**：两条 floor 判据都在
   *   `allowPermanent === false` 之前 ⇒ 临期低 → 短期低 → **none**（不去烧永久）。
   */
  const imminentFloor = positiveOrZero(options.imminentFloor)
  const expiringFloor = positiveOrZero(options.expiringFloor)
  const imminent = positiveOrZero(balance.imminentBalance)
  const expiring = positiveOrZero(balance.expiringBalance)

  /**
   * ★★★ **临期档**：剩余不足阈值 ⇒ 降级（不占这一档）。
   */
  if (imminent > imminentFloor) return BUDDY_BALANCE_TIER.imminent

  /**
   * ⚠️⚠️ **短期档必须判「纯短期量」，不能判母量 `expiring`**
   *（2026-11-27 用户需求修正 —— 这是一个**真缺陷**）。
   *
   * ## 用户原话
   *
   * > 「临期低于 20 就不再算临期了，归入短期；**短期低于 30 就不算短期了，
   * >   自动归入长期**」
   *
   * ## 缺陷（实测）
   *
   * `expiring` 是**母量**（= 临期 + 短期，见 `BuddyCreditSplit.expiring` 的注释）。
   * 用它做判据 ⇒ 只要还有一点临期，`expiring` 就会被抬高：
   *
   * | 号 | 母量 `expiring` | 纯短期 | 阈值 30 时**正确**结果 |
   * |---|---|---|---|
   * | 临期 5 / 纯短期 28 | **33** | **28** | 28 < 30 ⇒ **归入长期** |
   * | 用母量判 | `33 > 30` ✅ | — | 仍算短期 🚨 **与用户要求相反** |
   *
   * ⇒ **纯短期 = `expiring - imminent`**（母量减去临期子量）。
   *
   * ## ⚠️ 为什么不能直接用 `imminent` 抵消
   *
   * 只在「临期判据已经失败」之后才走到这里 ⇒ 此时该号的临期要么是 0、
   * 要么已不足 `imminentFloor`。两种情况下 `expiring - imminent` 都是
   * **真正可用的短期量**，正是用户要判的东西。
   *
   * ⚠️ 若改成 `shortTerm > expiringFloor` 而**后端 split 没暴露 shortTerm**，
   *   就得改 `BuddyCreditSplit` 的形状 —— 那是更大的改动面。
   *   `expiring - imminent` 与它**等价**（`shortTerm = expiring - imminent`）。
   */
  const pureShortTerm = Math.max(0, expiring - imminent)
  if (pureShortTerm > expiringFloor) return BUDDY_BALANCE_TIER.expiring

  if (options.allowPermanent === false) return BUDDY_BALANCE_TIER.none
  if (positiveOrZero(balance.permanentBalance) > 0) return BUDDY_BALANCE_TIER.permanent
  return BUDDY_BALANCE_TIER.none
}

/**
 * 该档位是否「可用」（可承载请求）。
 *
 * `none` 档不可用 —— 调用方据此判断「真的没有可用账号」并报明确错误。
 */
export function buddyTierUsable(tier: BuddyBalanceTier): boolean {
  return tier !== BUDDY_BALANCE_TIER.none
}

/** 把任意值归一化为安全正数；非法值（`NaN` / 负数 / `undefined`）归 0。 */
function positiveOrZero(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 按档位排序账号（**稳定排序**：档内保持传入顺序）。
 *
 * 与 `rankLoomyAccountsByBalance` 同款「装饰 - 排序 - 解装饰」写法：显式带
 * 原始下标可让「档内不重排」这一约定自明，且不受引擎实现影响。
 *
 * @param accounts - 待排序账号（顺序即手动优先级）。
 * @param options - 分档选项（`allowPermanent` = 是否允许消耗永久积分）。
 * @returns **新数组**（不修改入参）。
 */
export function rankBuddyAccountsByBalance<T extends BuddyAccountBalance>(
  accounts: readonly T[],
  options: BuddyTierOptions = {},
): T[] {
  return accounts
    .map((account, index) => ({ account, index, tier: buddyBalanceTier(account, options) }))
    .sort((a, b) => (a.tier - b.tier) || (a.index - b.index))
    .map((entry) => entry.account)
}

/**
 * 「严格手动顺序」版的候选排序：**档位只当可用性判据，不当先后判据**。
 *
 * ## 它与 {@link rankBuddyAccountsByBalance} 的唯一差别
 *
 * | | 默认（`rankBuddyAccountsByBalance`） | 严格手动顺序 |
 * |---|---|---|
 * | 先后由谁决定 | 先按档位，**档内**才看手动顺序 | 一律按手动顺序 |
 * | 档位还剩什么用 | 决定谁先 | **只决定「谁还可用」**（`none` 档沉底） |
 *
 * ## 为什么「沉底」这一条不能一起去掉
 *
 * `none` 档包含两类账号：**余额查询失败**的，和**锁定永久积分后只剩永久积分**的。
 * 后者正是「锁定永久积分」要保护的对象 —— 若严格模式把它当普通候选排在最前，
 * 用户明明锁了永久积分，请求仍会落到那个号上并消耗永久积分（不可撤回）。
 *
 * ⇒ 严格模式**保留档位的筛选语义**（`none` 沉底），只**放弃档位的排序语义**：
 * `expiring` 与 `permanent` 两档在严格模式下**同权**，全都按用户拖的顺序排。
 *
 * ⚠️ 这与「锁定永久积分」的既有判据不冲突：`buddyBalanceTier` 在
 * `allowPermanent: false` 时对「只剩永久积分」的账号直接返回 `none`，
 * 于是它照样被沉底 —— 锁定语义在两条排序里完全一致。
 *
 * ⚠️ 稳定排序：`Array.prototype.sort` 在现代引擎是稳定的，但这里的比较器本身
 * 就带原始下标兜底，故不依赖引擎实现细节。
 *
 * @param accounts - 待排序账号（顺序即手动优先级）。
 * @param options - 与 {@link rankBuddyAccountsByBalance} 同义（`allowPermanent` 决定
 *   哪些账号算「不可用」）。
 * @returns **新数组**（不修改入参）。
 */
export function rankBuddyAccountsByManualOrder<T extends BuddyAccountBalance>(
  accounts: readonly T[],
  options: BuddyTierOptions = {},
): T[] {
  return accounts
    .map((account, index) => ({
      account,
      index,
      // ⚠️ 关键：只保留「可用 / 不可用」这一层，**不保留三档的先后**。
      unusable: buddyTierUsable(buddyBalanceTier(account, options)) ? 0 : 1,
    }))
    .sort((a, b) => (a.unusable - b.unusable) || (a.index - b.index))
    .map((entry) => entry.account)
}

/**
 * 把一次拆分结果格式化成一行摘要（供日志与账号卡片提示使用）。
 *
 * ⚠️ 两个桶都为 0 时返回「无可用积分」而不是「临时 0 / 永久 0」——
 * 用户读后者需要自己推断，前者一眼可见。
 *
 * ⚠️ **有临期额度时必须把它单列**（`临期 X · 5 天内到期 Y · 永久 Z`）：
 * 若只说「15 天内到期 Y」，「其中 X 会在 5 天内烧掉」这个最关键的决策信息
 * 就丢了 —— 而这正是引入临期档的全部目的。
 */
export function describeBuddyCreditSplit(
  split: BuddyCreditSplit | undefined,
  windowDays: number = BUDDY_EXPIRING_WINDOW_DAYS,
  imminentDays: number = BUDDY_IMMINENT_WINDOW_DAYS,
): string {
  if (split === undefined) return '余额查询失败'
  const expiring = roundCreditsInline(split.expiring)
  const permanent = roundCreditsInline(split.permanent)
  const imminent = roundCreditsInline(split.imminent ?? 0)
  if (expiring <= 0 && permanent <= 0) return '无可用积分'
  /**
   * ⚠️⚠️ `imminent` 是 `expiring` 的**子量** ⇒ 明细行里必须减掉它，否则三段相加会
   * 大于合计（`临期 100 · 15 天内到期 350 · 永久 1000` 读起来是 1450，实际 1350）。
   *
   * 2026-11-18 正向审计 P3-a：上面这句注释一直这么写，但代码**没减**，而
   * `tests/unit/buddy-balance-rank.spec.ts` 的用例把错的输出钉死了 ⇒ 注释与实现
   * 互相矛盾、CI 全绿。修法是把实现改成注释说的样子（区间也随之收窄成
   * `5~15 天内到期`，与 `plugin-src/client/credit-expiry.js` 的 `expiryBucketLabel`
   * 同一口径）。
   *
   * 本函数**当前无生产调用点**（只在 spec 里）—— 保留是为了将来接回展示层时
   * 不再犯同一个错；不删是因为删掉会丢掉「三段相加 = 合计」这条不变式的记录。
   */
  const imminentPart = imminent > 0 ? `临期 ${imminent} · ` : ''
  const restDays = imminent > 0 ? `${imminentDays}~${windowDays}` : `${windowDays}`
  // `imminent > expiring` 是上游数据异常 ⇒ 用 `Math.max(0, …)` 兜底，不输出负数。
  const rest = imminent > 0 ? Math.max(0, roundCreditsInline(split.expiring - imminent)) : expiring
  return `${imminentPart}${restDays} 天内到期 ${rest} · 永久 ${permanent}`
}

/** 展示用规整：两位小数（服务端精确值带浮点尾数噪声）。 */
function roundCreditsInline(value: number): number {
  return Math.round(value * 100) / 100
}
