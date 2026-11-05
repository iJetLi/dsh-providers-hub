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
 * | 1 | `expiring > 0` | 有 **15 天内到期**的积分 —— 再不用就作废，优先消耗 |
 * | 2 | `permanent > 0` | 只剩「永久」积分（≥ 15 天后才到期） |
 * | 3 | 其余（含**查询失败**） | 无可用余额 |
 *
 * ⚠️ **档内保持传入顺序**（= 用户在 Jet Hub 拖拽的手动顺序），**不重排** ——
 * 与 `AccountPool.getAvailableAccount` 的既有语义一致。
 *
 * ⚠️ **查询失败归入最后一档**：宁可把请求发给能确认余额的号（与 Loomy 同规）。
 *
 * ⚠️ 本模块是**纯函数**，不碰网络与凭据 —— 余额由调用方查好后传入。
 */

import { isExclusiveCreditPool, type CreditBalance } from './credits.js'

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

/** 账号余额档位。数字越小越优先。 */
export const BUDDY_BALANCE_TIER = Object.freeze({
  /** 有 15 天内到期的积分 —— 优先消耗（再不用就作废）。 */
  expiring: 0,
  /** 只剩永久积分（≥ 15 天后到期）。 */
  permanent: 1,
  /** 无余额 / 查询失败。 */
  none: 2,
} as const)

export type BuddyBalanceTier = (typeof BUDDY_BALANCE_TIER)[keyof typeof BUDDY_BALANCE_TIER]

/** 两类余额的拆分结果。 */
export interface BuddyCreditSplit {
  /** 15 天内到期、**且尚未作废**的积分合计（本计费周期口径）。 */
  expiring: number
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
 * @returns 两桶合计；`balance` 为 null/undefined 时返回 `undefined`（= 查询失败）。
 */
export function splitBuddyCreditsByExpiry(
  balance: CreditBalance | null | undefined,
  now: number = Date.now(),
  windowMs: number = BUDDY_EXPIRING_WINDOW_MS,
): BuddyCreditSplit | undefined {
  if (balance === null || balance === undefined) return undefined
  let expiring = 0
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
    if (endMs - now < windowMs) expiring += remaining
    else permanent += remaining
  }
  return { expiring, permanent, ...expired > 0 ? { expired } : {} }
}

/** 分档选项。 */
export interface BuddyTierOptions {
  /** 是否允许消耗永久积分。默认 `true`（解锁）。 */
  allowPermanent?: boolean
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
  balance: { expiringBalance?: number; permanentBalance?: number },
  options: BuddyTierOptions = {},
): BuddyBalanceTier {
  if (positiveOrZero(balance.expiringBalance) > 0) return BUDDY_BALANCE_TIER.expiring
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
 * 把一次拆分结果格式化成一行摘要（供日志与账号卡片提示使用）。
 *
 * ⚠️ 两个桶都为 0 时返回「无可用积分」而不是「临时 0 / 永久 0」——
 * 用户读后者需要自己推断，前者一眼可见。
 */
export function describeBuddyCreditSplit(
  split: BuddyCreditSplit | undefined,
  windowDays: number = BUDDY_EXPIRING_WINDOW_DAYS,
): string {
  if (split === undefined) return '余额查询失败'
  const expiring = roundCreditsInline(split.expiring)
  const permanent = roundCreditsInline(split.permanent)
  if (expiring <= 0 && permanent <= 0) return '无可用积分'
  return `${windowDays} 天内到期 ${expiring} · 永久 ${permanent}`
}

/** 展示用规整：两位小数（服务端精确值带浮点尾数噪声）。 */
function roundCreditsInline(value: number): number {
  return Math.round(value * 100) / 100
}
