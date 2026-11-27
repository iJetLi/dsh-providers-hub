/**
 * per-provider 积分分档窗口的**唯一取值点**。
 *
 * ## 为什么必须单独成一个模块
 *
 * 「窗口」被两条完全不同的链路消费，且**必须取同一个值**：
 *
 * | 链路 | 消费者 | 后果 |
 * |---|---|---|
 * | 选号 | `buddy-balance-selector.ts` 的 `classify()` | 决定「先烧谁」|
 * | 展示 | `jet-hub-rpc.ts` 的 8 处回传 | 决定面板三档分色 |
 *
 * 若两条链路各算各的，会出现「面板说这是临期、选号却当短期」——
 * 这是本仓库反复记录的「一文件两套同义判据」红线。
 *
 * ## 优先级（三级，高 → 低）
 *
 * ```
 * 本渠道设置（state.json 的 creditWindows[provider]）
 *   > 环境变量（DSH_BUDDY_EXPIRING_WINDOW_DAYS / DSH_BUDDY_IMMINENT_WINDOW_DAYS）
 *   > 内置默认（15 天 / 5 天）
 * ```
 *
 * ## ⚠️ 三条不可违反的纪律
 *
 * 1. **每次调用都现读**，绝不缓存 —— 用户在面板上保存后必须立刻生效
 *    （不需要重启、重选模型或切会话）。本模块刻意不保留任何模块级状态。
 * 2. **不注入到构造期字段**（如 `BuddyBalanceSelector` 的 `deps.windowMs`）——
 *    那是构造期一次求值，会让窗口永久固定，保存后不生效。
 * 3. **`0` 是合法值**：表示「关掉该档」，不能与「未设置」混淆。
 *
 * ## 钳制（本模块是**全仓唯一的业务钳制点**）
 *
 * - `windowDays < 0` / 非有限数 ⇒ 回落下一级
 * - `imminentDays < 0` / 非有限数 ⇒ 回落下一级
 * - **`imminentDays > windowDays` ⇒ 钳制到 `windowDays`**
 *   （临期 ⊂ 短期是嵌套关系，倒挂会让「短期」段变成负区间）
 *
 * ⚠️ 与 `resolveImminentWindowMs`（毫秒版钳制）的分工：
 * 那个服务于「已经拿到毫秒」的调用方；本模块服务于「按天取值」的调用方。
 * 两者的**钳制方向一致**，但单位与入口不同 —— 不要让它们互相替代。
 */

import {
  BUDDY_EXPIRING_WINDOW_DAYS,
  BUDDY_IMMINENT_WINDOW_DAYS,
  buddyExpiringWindowDays,
  buddyImminentWindowDays,
} from './buddy-balance-rank.js'
import type { CreditWindowSetting } from './jet-hub-store.js'

/** 窗口值的**来源**（弹窗要据此显示「当前用的是哪一级」）。 */
export type CreditWindowSource = 'setting' | 'env' | 'default'

/** 解析结果。 */
export interface ResolvedCreditWindow {
  /** 「短期窗口」（≥ 此值算永久），已钳制。 */
  readonly windowDays: number
  /** 「临期窗口」（< 此值算临期），已钳制到 `<= windowDays`。 */
  readonly imminentDays: number
  /**
   * 生效来源。
   *
   * ⚠️ 是**整体**来源：两个字段可能来自不同级别（例如只设了 `windowDays`，
   * 此时 `windowDays` 来自 `setting`、`imminentDays` 来自 `env`）。
   * 整体判据是「只要有一项来自 setting 就算 setting」，因为弹窗的用途是
   * 「这个渠道有没有被单独设置过」。
   */
  readonly source: CreditWindowSource
  /**
   * `imminentDays` 是否被**钳制**过（原始值 > `windowDays`）。
   *
   * ⚠️ 弹窗必须据此提示「原填 N 天，已钳制为 M 天」——
   * 静默改写用户输入是本仓库明令禁止的形态（用户会以为保存失败或行为异常）。
   */
  readonly clamped: boolean
  /**
   * ★★★ **临期档的积分下限**（2026-11-27 用户需求）。
   *
   * 临期剩余 **≤ 该值** ⇒ 不算临期 ⇒ 降级按「短期」排队。
   *
   * ⚠️ **恒为数字**（`undefined` 已归一成 `0`）：调用方（`buddyBalanceTier`）
   * 直接用它做 `> floor` 判据即可，不必每处再判 `undefined`。
   * ⚠️ `0` = 关闭 ⇒ `> 0` 与加这个功能之前**逐字节相同**（零回归）。
   */
  readonly imminentFloor: number
  /** ★★★ **短期档的积分下限**（同上）。`0` = 关闭。 */
  readonly expiringFloor: number
}

/**
 * 「短期窗口」的**上限**（天）：100 年。
 *
 * ## 为什么必须有上限（2026-11-21，PR #129 正向审计 P2）
 *
 * `sanitizeCreditWindows` 已挡掉 `Infinity`（理由逐字写着「会让『永久』档永远为空
 * —— 一切都被判成临期/短期」），但**同型的有限大值没挡**：`1e9` 通过
 * `Number.isFinite` ⇒ `windowMs = 8.64e13` ⇒ `remaining <= windowMs` 恒真 ⇒
 * **`permanent` 恒 0**，症状与 `Infinity` 一模一样。
 *
 * ⇒ 挡 A 却没挡同型的 B 是本仓反复出事的形态，故在**唯一天数入口**补这道闸。
 *
 * ⚠️ 取 `36_500` 是为了与客户端 `plugin-src/client/credit-window-ui.js` 的
 * `parseWindowInput` **同值**（那边拒绝 `> 36_500`）：两端口径一致，
 * 才不会出现「UI 说非法、后端却收下」或反向的错位。
 * 那边是**拒绝**（让用户重填），这边是**钳制**（手改文件不该让面板崩）——
 * 两侧方向不同是刻意的：UI 有用户可交互，文件只有一行字。
 */
export const MAX_CREDIT_WINDOW_DAYS = 36_500

/** 读取本渠道设置的函数（注入 `AccountPool.creditWindow`）。 */
export type CreditWindowReader = (provider: string) => CreditWindowSetting | undefined

/**
 * ★★★ **积分下限的归一化**（2026-11-27 用户需求）。
 *
 * 规则：只接受**有限非负数**，其余一律 `0`（= 关闭）。
 *
 * ⚠️ 为什么归 `0` 而不是 `undefined`：`ResolvedCreditWindow` 的两个 floor
 *   声明为**恒数字**，调用方（`buddyBalanceTier`）直接做 `> floor` 即可 ——
 *   若允许 `undefined`，每个消费点都得再判一次，必然有人漏。
 *
 * ⚠️ 方向保守：非法值归 0 = 关闭 = **不降级** ⇒ 最坏只是功能没生效，
 *   绝不会因为一个手改坏的 `NaN` 把整个号池降级成「没可用账号」。
 */
function toFloor(value: unknown): number {
  if (typeof value !== 'number') return 0
  if (!Number.isFinite(value) || value <= 0) return 0
  return value
}

/**
 * 把「可能不完整的 pool」安全包成 {@link CreditWindowReader}。
 * ## ⚠️ 为什么需要它（真实回归，2026-11-19）
 *
 * `AccountPool.creditWindow` 是**新加的方法**。三类调用方可能拿不到它：
 *
 * 1. **单测的 pool 替身**（只实现了被用到的那几个方法）——
 *    实测 `tests/unit/jet-hub-rpc.spec.ts` 的替身只有 `listAccounts`，
 *    直接 `pool.creditWindow(id)` 会抛 `TypeError: pool.creditWindow is not a function`
 *    ⇒ 整个 `credits.permanentLock` 端点变成 handler-failed；
 * 2. **旧宿主进程 + 新客户端**（版本错配）—— 宿主侧 RPC 里没有该方法；
 * 3. 将来若有人把读取器换成一个不完整的对象。
 *
 * ⇒ **没有该方法就当作「未设置」**（回落环境变量/默认），
 *    而不是抛错 —— 这与本功能「缺键 = 回落下一级」的语义天然一致，
 *    且方向保守：最坏结果只是用户设的窗口暂时不生效，不会弄坏任何端点。
 *
 * ⚠️ 只挡「方法不存在」，**不吞方法内部抛出的错**：
 * 真实的存储读失败应该暴露出来，而不是伪装成「未设置」
 *（否则用户设的窗口静默失效且无任何痕迹）。
 */
export function safeCreditWindowReader(pool: unknown): CreditWindowReader {
  const reader = (pool as { creditWindow?: unknown } | null | undefined)?.creditWindow
  if (typeof reader !== 'function') return () => undefined
  return (provider: string) => {
    const result = (reader as (p: string) => CreditWindowSetting | undefined).call(pool, provider)
    return result
  }
}

/** 环境变量读取（可注入，便于单测）。 */
export interface CreditWindowEnv {
  readonly buddyExpiringWindowDays: () => number
  readonly buddyImminentWindowDays: () => number
}

/** 默认的环境变量读取实现（真实运行期用）。 */
const DEFAULT_ENV: CreditWindowEnv = {
  buddyExpiringWindowDays: () => buddyExpiringWindowDays(),
  buddyImminentWindowDays: () => buddyImminentWindowDays(),
}

/**
 * 判定「这个值是不是来自环境变量」。
 *
 * ⚠️ 必须问**环境变量本身**而不是比较数值：用户可能恰好把
 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 设成 15（= 默认值），
 * 此时数值比较会误报 `default`，而弹窗要如实说「环境变量 15 天」。
 *
 * @returns true = 环境变量有显式值（无论是否等于默认）
 */
function envHasExplicit(env: CreditWindowEnv, which: 'windowDays' | 'imminentDays'): boolean {
  const fromEnv = which === 'windowDays'
    ? env.buddyExpiringWindowDays()
    : env.buddyImminentWindowDays()
  const fallback = which === 'windowDays' ? BUDDY_EXPIRING_WINDOW_DAYS : BUDDY_IMMINENT_WINDOW_DAYS
  // ⚠️ 环境变量未设时函数返回**内置默认**；设了但值非法时也返回默认。
  //    ⇒ 数值 != 默认 ⇒ 一定来自环境变量；
  //       数值 == 默认 ⇒ **无法区分**（可能设成了默认值，也可能没设）。
  // 后者如实归 `default`（更保守：不谎称用户设过环境变量）。
  return fromEnv !== fallback
}

/**
 * 解析某 provider 当前生效的分档窗口。
 *
 * @param provider - provider id
 * @param readSetting - 读本渠道设置（`pool.creditWindow`）
 * @param env - 环境变量读取（单测注入用）
 */
export function resolveCreditWindow(
  provider: string,
  readSetting: CreditWindowReader,
  env: CreditWindowEnv = DEFAULT_ENV,
): ResolvedCreditWindow {
  const setting = provider.length > 0 ? readSetting(provider) : undefined
  const setWindow = setting?.windowDays
  const setImminent = setting?.imminentDays
  /**
   * ★ 积分下限（2026-11-27）。
   *
   * ⚠️ 与窗口天数**不同**：窗口有「setting → env → default」三级回落，
   *   而下限**没有环境变量与默认值** —— 没设就是 `0`（关闭）。
   *   ⇒ 不需要 `fromSetting*` 判据，也不参与 `source` 判定
   *   （「来源」问的是「窗口天数从哪来」，下限不改变这个答案）。
   *
   * ⚠️ 非法值（`NaN` / 负数 / 非数字）一律归 `0`：与 `sanitizeCreditWindows`
   *   同纪律，且方向保守（最坏结果只是阈值不生效，不会误降级）。
   */
  const imminentFloor = toFloor(setting?.imminentFloor)
  const expiringFloor = toFloor(setting?.expiringFloor)

  // ---- 第一级：本渠道设置 ----
  const fromSettingWindow = typeof setWindow === 'number' && Number.isFinite(setWindow) && setWindow >= 0
  const fromSettingImminent = typeof setImminent === 'number' && Number.isFinite(setImminent) && setImminent >= 0

  // ---- 第二级：环境变量 / 第三级：内置默认 ----
  // ⚠️ 两个 `buddy*WindowDays()` 自身已实现「环境变量 → 默认」的回落与非法值兜底。
  const envWindow = env.buddyExpiringWindowDays()
  const envImminent = env.buddyImminentWindowDays()

  const pickedWindow = fromSettingWindow ? setWindow! : envWindow
  const pickedImminent = fromSettingImminent ? setImminent! : envImminent
  // ★ 上限闸（见 {@link MAX_CREDIT_WINDOW_DAYS}）：必须在**选级之后**钳，
  //   否则「env 给了超大值」这条也不受控（只钳 setting 会漏一级）。
  const windowDays = Math.min(pickedWindow, MAX_CREDIT_WINDOW_DAYS)
  const rawImminent = Math.min(pickedImminent, MAX_CREDIT_WINDOW_DAYS)
  // ★ 全仓唯一的业务钳制：临期 ⊂ 短期（倒挂会让「短期」段变成负区间）
  const imminentDays = Math.min(rawImminent, windowDays)
  /**
   * `clamped` 必须**同时**表达两种钳制，否则弹窗会漏报：
   * ① 倒挂（`imminent > window`）；
   * ② 超过上限（`picked* > MAX`）—— 手改文件写 `1e9` 的用户有权知道它被压到了 36500。
   *
   * ⚠️ 倒挂那条用 `>` 而不是 `>=`：相等不是钳制（用户填 5/5 是合法配置）。
   */
  const clamped = pickedWindow > MAX_CREDIT_WINDOW_DAYS
    || pickedImminent > MAX_CREDIT_WINDOW_DAYS
    || rawImminent > windowDays

  // ---- 来源判定 ----
  let source: CreditWindowSource
  if (fromSettingWindow || fromSettingImminent) {
    source = 'setting'
  } else if (envHasExplicit(env, 'windowDays') || envHasExplicit(env, 'imminentDays')) {
    source = 'env'
  } else {
    source = 'default'
  }

  return { windowDays, imminentDays, source, clamped, imminentFloor, expiringFloor }
}

/** 单个 provider 的设置是否为空（用于「恢复默认」判据）。 */
export function isEmptyCreditWindowSetting(setting: CreditWindowSetting | undefined): boolean {
  if (setting === undefined) return true
  /**
   * ⚠️ **两个阈值必须参与判据**（2026-11-27）。
   *
   * 只看窗口天数的话，「只配了阈值、窗口天数用默认」这种合法配置
   * 会被判成「空」⇒ 「恢复默认」按钮会把它误当无操作，
   * 或更糟：某个「空就清掉整条」的分支会**静默删掉用户的阈值**。
   */
  return setting.windowDays === undefined
    && setting.imminentDays === undefined
    && setting.imminentFloor === undefined
    && setting.expiringFloor === undefined
}
