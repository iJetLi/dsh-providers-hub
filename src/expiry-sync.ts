import type { AccountPool } from './account-pool.js'
import type { ProviderAccountEntry } from './types.js'
import { REFRESH_LEAD_MS } from './refresh.js'

/**
 * 账号池「有效期」的共享回写与 lead-time 判据。
 *
 * ## 为什么需要这个模块（issue !IKIRTT 的真实缺陷）
 *
 * UI 账号卡片的「有效期：已过期」读的是**账号池的 `expiresAt`**
 * （`plugin-src/client/jet-hub.js` 的 `account.expiresAt <= Date.now()`），
 * 而不是凭据里 access_token 的真实 `exp`。于是只要凭据被更新过而**索引没跟上**，
 * 就会出现「显示已过期、但发消息完全正常」的数据源分叉。
 *
 * 这条分叉有两条产生路径，都真实发生过：
 *
 * 1. **按需续期不回写**：`refreshAccountCredential`（RPC `account.refresh` 走的
 *    路径）原先只有 raccoon 记得 `pool.updateAccount({ expiresAt })`，
 *    其余七个 provider 只 `credentials.set` —— 续期成功了、凭据换新了，
 *    UI 却纹丝不动，且没有任何自救手段（「重测」按钮的 refresh 是刻意的 no-op）。
 * 2. **定时器首轮要等满一个周期**：`src/index.ts` 的多账号续期只有 `setInterval`、
 *    没有启动时首轮，短寿命 provider（cline 1h / codearts 2h / raccoon 3h）
 *    在宿主关闭期间到期后，最长要等 30 分钟才第一次被处理。
 *
 * 本模块把 raccoon 已经验证过的写法抽成一份实现，让九个 provider 共用 ——
 * 与 AGENTS.md「差异收敛到产品配置、缺陷只修一遍」的一贯做法一致。
 */

/** 池内条目的现值（用于「变了才写盘」的短路）。 */
export interface ExpiryCurrentValue {
  expiresAt?: number
  refreshable?: boolean
}

/**
 * 回写有效期所需的**最小**账号池能力。
 *
 * 刻意不依赖整个 `AccountPool` 类：本模块只做「反查 + 打补丁」两件事，
 * 与账号池的缓存、落盘、模型黑名单等无关。收窄到接口也让单测可以直接
 * 传一个结构替身，而不必先构造真池。
 */
export interface ExpirySyncPool {
  updateAccount(
    id: string,
    patch: Partial<Pick<ProviderAccountEntry, 'expiresAt' | 'refreshable'>>,
  ): Promise<void>
  findAccountIdByCredential(provider: string, identity: string): Promise<string>
}

/** 从各家凭据取过期信息的能力（各 provider 凭据类型不同，故以提取器注入）。 */
export interface ExpiryAccessors<TCredential> {
  /** access_token 的过期时刻（毫秒）；`undefined` 表示凭据里读不到。 */
  expiresAtOf: (credential: TCredential) => number | undefined
  /**
   * 凭据是否仍可续期。
   *
   * ⚠️ **不提供时只同步 `expiresAt`、绝不碰 `refreshable`**。Loomy 必须走这条：
   * 它的 `isLoomyRefreshable` **恒为 `false`**（服务端没有任何 refresh 端点，
   * 这是诚实标记），若让共享实现据此把池里写 `false`，反而会把账号池改成
   * 与该产品实际行为不符的状态。
   */
  refreshableOf?: (credential: TCredential) => boolean
  /**
   * **refresh_token 本身的到期时刻**（毫秒）。
   *
   * ## 这条腿是为谁加的（CodeArts 30 天硬上限，2026-10-18 实测）
   *
   * ⚠️ lead-time 判据原本**只读 access_token 的到期**，在 refresh_token 寿命
   * **更短**时会于死线之后才放行 ⇒ 那一轮续期必然失败。
   *
   * 华为 STS 的实测行为（解开全部历史凭据的 JWT 逐个核对得出）：
   * `refresh_token.exp` **恒等于「登录时刻 + 30 天」，续期不会延长它** ——
   * 续期只会**缩短**剩余寿命。而 access_token 寿命恒为 2 小时。于是最后一天：
   * access 剩 2 小时、refresh 只剩约 50 分钟，按 lead-time 算净窗口仅 6~9 分钟，
   * 而调度周期是 30 分钟 ⇒ **必然错过**，账号在 access 到期后彻底不可用
   * （该日实测两个账号同时报废，且池内 `refreshable` 仍是 `true`）。
   *
   * 提供本腿后，剩余寿命不足 lead 时会**提前放行**（在死线前把 access 换新，
   * 顺带把 refresh 的剩余寿命重新拉满到 access 之后）。
   *
   * ⚠️ **不提供时行为与从前逐字节一致**（`shouldRefreshNow` 退化成单腿判据）：
   * 其余八家的 refresh_token 寿命均长于 access_token（buddy 14 天 / cline 30 天
   * / minimax 30 天 …），补这条腿对它们**无任何行为变化**，故刻意不给它们加。
   */
  refreshExpiresAtOf?: (credential: TCredential) => number | undefined
  /**
   * **上次签发/刷新时刻**（毫秒）。供「保活续期」判据用（issue #124，2026-11-19）。
   *
   * ## 这条腿为谁而加（CodeBuddy：access TTL 以**天**计）
   *
   * lead-time 判据只在「距过期不足 1 小时」放行 ⇒ 对 access TTL = 28/30/60 天
   * 的渠道，续期可能连续数十天一次都不发，`refresh_token` 被服务端**闲置失效**
   * （实测 401 `12153: refresh token is invalid`，症状是「凭据过期 / API 密钥无效」
   * 且面板写 `refreshable: false`，用户唯一出路是重登，且 28 天后**必复发**）。
   *
   * ⇒ 判据增加一条「距上次刷新已超过 {@link KEEPALIVE_MAX_IDLE_MS}」。
   *   `iat` 在续期后会重签 ⇒ 它天然就是「上次刷新时刻」，不需要新字段。
   *
   * ⚠️ **不提供时行为与从前逐字节相同**（与 `refreshExpiresAtOf` 同款纪律）：
   * 这条腿对 access TTL ≈ 1 小时的渠道**多余**（它们每轮都在 lead 窗口内，
   * 强行保活只会白烧一次性 refresh_token），故只给需要的家开。
   */
  issuedAtOf?: (credential: TCredential) => number | undefined
  /**
   * `AccountPool.findAccountIdByCredential` 的凭据身份。
   *
   * ⚠️ 该参数的语义是「**凭据内容**」（通常是 access_token）而**不是 ref 名**，
   * 传 ref 名会恒匹配失败且**静默无报错**（raccoon 踩过，见其方法注释）。
   */
  identityOf: (credential: TCredential) => string
}

/**
 * 「保活续期」的最大闲置时长：距上次刷新超过它就必须发一次续期请求。
 *
 * ## 为什么是 7 天（而不是 issue #124 建议的 3~7 天中位数、或 TTL 的比例）
 *
 * 上游**没有**下发 `refresh_token` 的闲置窗口（issue 作者拿不到、我也拿不到），
 * 所以这个值只能是**下界估计**，取值方向必须偏保守：
 * - **取得太长**：refresh_token 仍可能在窗口外被作废（本缺陷原样复发）；
 * - **取得太短**：每次续期都消耗/重签一次 refresh_token，而对一次性 token 的
 *   渠道这会**提前报废**（本仓 2026-10-27 两次同型事故，见 `shouldRefreshNow` 注释）。
 *
 * 7 天对已知最紧的一批（access TTL 28 天）意味着**每 7 天一次**，安全余量 4 倍；
 * 对 60 天那批是 8~9 次/周期 —— 都在「不会把 token 烧掉」的量级。
 *
 * ⚠️ 一旦上游给出更具体的闲置时长（issue 里已请报障者补响应原文），
 *    只改这一个常量即可。
 */
export const KEEPALIVE_MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000

/** 容差：毫秒时间戳来自 JWT 的秒级 `exp`，换算后可能有 1 秒内的舍入。 */
const EXPIRY_TOLERANCE_MS = 1000

/**
 * 本轮是否需要为该凭据发一次续期请求（lead-time 语义）。
 *
 * 与单凭据时代 `computeFirstRefreshDelayMs` 的 `expiresAt - now <= REFRESH_LEAD_MS`
 * 同一判据：**距过期不足 1 小时（或已过期、或读不到过期时间）才刷**。
 *
 * ## 为什么判据用**凭据的**过期时间而不是账号池的 `expiresAt`
 *
 * 池值正是本缺陷里可能陈旧的那份数据（按需续期不回写、老版本从未回写）。
 * 拿它当判据会让「凭据其实快过期」的账号被跳过；而凭据本体是权威值，
 * 读它只是一次本地存储访问，不花网络也不花模型额度。
 *
 * @param expiresAtMs 凭据 access_token 的过期时刻；`undefined` 一律视为需要刷。
 */
export function shouldRefreshNow(expiresAtMs: number | undefined, nowMs = Date.now()): boolean {
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) return true
  return expiresAtMs - nowMs <= REFRESH_LEAD_MS
}

/**
 * 本轮是否需要为该凭据发一次续期请求：**access 与 refresh 两条腿取或**。
 *
 * ⚠️ 这是 {@link shouldRefreshNow} 的**带 refresh 寿命腿**版本，只有 CodeArts
 * 走它（其余八家不提供 `refreshExpiresAtOf`，行为与旧版逐字节相同）。
 *
 * ## 为什么必须取「或」而不是「与」
 *
 * 取「与」（两条腿都满足才续）会**制造**一个新缺陷：refresh 剩 3 天、access
 * 剩 2 小时（正常态）时反而**不续**，access 一过期账号就报废 —— 而此刻 refresh
 * 明明还好好活着。取「或」的语义才是对的：**任一条腿进入告警区间就续期**，
 * 两条腿都能因此被拉满。
 *
 * ## 为什么 refresh 已过期时也要放行（而不是直接判定失败）
 *
 * `refreshExpiresAt < now` 时本函数返回 `true`，让调用方**真去发一次**请求：
 * 上游可能已经续发过（多端登录会重签 refresh），本地这一份过期不代表云端不接受。
 * 让真实报文来否决，比凭本地过期时间猜要可靠 —— 且调用方对 `invalid_grant`
 * 已有终态处理（写 `refreshable: false` 并提示重新登录）。
 *
 * ⚠️ 但**读不到**（`undefined` / NaN）时**必须当「不知」而非「已过期」**：
 * CodeArts 的 refresh 是 JWT，`exp` 明文可读，读不到只可能是旧版 ticket 凭据
 * （没有 refresh_token），那种情况由 `isCodeArtsRefreshable` 拦下；若在这里
 * fail-closed 成 `true`，会让所有读不到腿的凭据每 30 分钟被无谓刷一次。
 */
export function shouldRefreshNowWithRefreshExpiry<TCredential>(params: {
  /** access_token 的到期时刻（毫秒）。 */
  expiresAtMs: number | undefined
  /** refresh_token 的到期时刻（毫秒）；`undefined` = 读不到（当作不知）。 */
  refreshExpiresAtMs: number | undefined
  /**
   * **上次签发/刷新时刻**（毫秒）；`undefined` = 读不到 ⇒ 保活腿不生效。
   *
   * ⚠️ issue #124：对 access TTL 以「天」计的渠道（CodeBuddy），仅靠 lead-time
   * 会让续期连续数十天不发，`refresh_token` 在服务端**闲置失效**。
   */
  issuedAtMs?: number | undefined
  /** 保活窗口；缺省 {@link KEEPALIVE_MAX_IDLE_MS}。传 `Infinity` 可关掉这条腿。 */
  keepAliveMaxIdleMs?: number
  nowMs?: number
}): boolean {
  const nowMs = params.nowMs ?? Date.now()
  // 主腿：access 进入 lead 窗口（含已过期 / 读不到）。
  if (shouldRefreshNow(params.expiresAtMs, nowMs)) return true
  // 保活腿：距上次刷新超过窗口 ⇒ 主动续一次（让 refresh_token 保持活性）。
  // ⚠️ 读不到 `iat` 就**放弃这条腿**（fail-open 到旧行为）—— fail-closed 会让
  //    所有解不出 JWT 的凭据每 30 分钟被无谓刷一次，正是 `REFRESH_LEAD_MS`
  //    那次事故的形态。
  const issuedAtMs = params.issuedAtMs
  const keepAliveMaxIdleMs = params.keepAliveMaxIdleMs ?? KEEPALIVE_MAX_IDLE_MS
  // ⚠️ `keepAliveMaxIdleMs > 0` 是**必需**守卫（正向审计 P3-2）：传 0 或负数会让
  //    `nowMs - issuedAtMs >= 0` 恒真 ⇒ 每 30 分钟一轮都真发续期请求 ⇒ 一次性
  //    refresh_token 被白烧（2026-10-27 两次同型事故）。非正值一律当「关掉这条腿」。
  if (issuedAtMs !== undefined
    && Number.isFinite(issuedAtMs)
    && Number.isFinite(keepAliveMaxIdleMs)
    && keepAliveMaxIdleMs > 0
    && nowMs - issuedAtMs >= keepAliveMaxIdleMs) {
    return true
  }
  // refresh 这条腿：读不到就**放弃这条腿**（fail-open 到「按 access 判」）。
  const r = params.refreshExpiresAtMs
  if (r === undefined || !Number.isFinite(r)) return false
  // 已过期 → 放行（让真实请求去否决，见上方注释）。
  if (r <= nowMs) return true
  // 剩余不足一个 lead 周期 → 提前续，别等到 access 的窗口才发现来不及。
  return r - nowMs <= REFRESH_LEAD_MS
}

/**
 * 把凭据的过期信息同步回账号池（UI 读的就是这里）。
 *
 * 三条从 raccoon 既有实现继承下来的硬规矩，改动时必须保持：
 *
 * 1. **失败只记日志、绝不上抛**：调用点是「凭据已经续期成功」之后，
 *    此时因为写索引失败而报错，会让用户以为续期失败、甚至触发无谓的重新登录。
 *    索引是展示层数据，不该反噬凭据本身。
 * 2. **优先用调用方给的 `accountId`**：`refreshAll` 手里本来就有 entry，
 *    无需反查；只有在缺失时才退化为按凭据身份遍历账号池比对。
 * 3. **现值一致时不写盘**：账号列表是整体落盘的，否则定时器每 30 分钟
 *    会把 39 条记录全量重写一遍，白耗 I/O。
 *
 * ⚠️ `expiresAt` 取不到时**不覆盖**池内旧值：`updateAccount` 做的是
 * `{ ...entry, ...patch }`，把字段写成 `undefined` 后落盘会被 `JSON.stringify`
 * 整个丢弃，UI 于是显示「未知」—— 保留旧信息比抹掉它更有价值。
 */
export async function syncAccountExpiry<TCredential>(params: {
  /** 账号池；未提供时静默跳过（兼容不传 pool 的既有调用方）。 */
  pool: ExpirySyncPool | undefined
  /** 账号池里该 provider 的 id，如 `'cline'` / `'codearts'`。 */
  provider: string
  /** 已从凭据算好的过期信息。 */
  credential: TCredential
  accessors: ExpiryAccessors<TCredential>
  /** 调用方已知的账号 id；缺失时按凭据身份反查。 */
  accountId?: string
  /** 池内现值，提供时启用「变了才写盘」短路。 */
  current?: ExpiryCurrentValue
  /** 日志前缀，如 `'[cline]'`。 */
  tag: string
  warn?: (message: string) => void
}): Promise<void> {
  const { pool, provider, credential, accessors, accountId, current, tag } = params
  if (pool === undefined) return
  try {
    let id = accountId
    if (id === undefined || id.length === 0) {
      id = await pool.findAccountIdByCredential(provider, accessors.identityOf(credential))
    }
    if (id === undefined || id.length === 0) return

    const expiresAt = accessors.expiresAtOf(credential)
    const refreshable = accessors.refreshableOf?.(credential)
    if (expiresAt === undefined && refreshable === undefined) return
    const expiryChanged = expiresAt !== undefined
      && (current?.expiresAt === undefined
        || Math.abs(current.expiresAt - expiresAt) > EXPIRY_TOLERANCE_MS)
    const refreshableChanged = refreshable !== undefined
      && (current === undefined || current.refreshable !== refreshable)
    if (!expiryChanged && !refreshableChanged) return

    await pool.updateAccount(id, {
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(refreshable === undefined ? {} : { refreshable }),
    })
  } catch (error) {
    params.warn?.(
      `${tag} 凭据处理成功但回写账号池的有效期失败（不影响使用）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * `refreshAll` 的单账号编排：需要刷就刷、不需要就把池值对账。
 *
 * 「不需要续期」的分支**不是**一句 `continue` 就完事 —— 存量账号的凭据早已在
 * 别处（IDE / 上一轮定时续期）续好了，只有池里还是旧值；若跳过时对账缺失，
 * UI 会**永远**显示「已过期」，正是本 issue 里最难自愈的那一半。
 *
 * @returns 是否真的发了一次续期请求（供调用方计数/日志）。
 */
export async function refreshAccountWithReconcile<TCredential>(params: {
  pool: ExpirySyncPool
  provider: string
  tag: string
  accountId: string
  credential: TCredential
  accessors: ExpiryAccessors<TCredential>
  /** 池内现值（通常就是 `entry` 本身）。 */
  current?: ExpiryCurrentValue
  /** 执行真正的续期并**落盘凭据**；失败应抛错。 */
  refresh: (credential: TCredential) => Promise<TCredential>
  /** 续期成功后写回凭据存储。 */
  save: (credential: TCredential) => Promise<void>
  /**
   * 造出**本家**的「refresh_token 已失效」错误（见 `refreshAccountWithReconcile`
   * 里落盘失败那一节）。
   *
   * ⚠️ **必填，且必须传自己那家的类**：各 provider 的 `refreshAll` 判的是自己
   * 定义的同名类的 `instanceof`，共享模块借用任何一家的类都会让另外八家把
   * 「凭据已死」当非终态 ⇒ 静默死号。必填是为了让漏接线在 `tsc` 就红。
   */
  makeTerminalError: (message: string) => Error
  /**
   * 覆盖「保活窗口」；缺省 {@link KEEPALIVE_MAX_IDLE_MS}（7 天）。
   *
   * 只在提供了 `accessors.issuedAtOf` 的家上生效（见该字段注释）。
   * 传 `Infinity` 可关掉保活腿（等价于改造前）。
   */
  keepAliveMaxIdleMs?: number
  warn?: (message: string) => void
  info?: (message: string) => void
}): Promise<boolean> {
  const { pool, provider, tag, accountId, credential, accessors, current, refresh, save } = params
  const expiresAt = accessors.expiresAtOf(credential)

  if (!shouldRefreshNowWithRefreshExpiry({
    expiresAtMs: expiresAt,
    refreshExpiresAtMs: accessors.refreshExpiresAtOf?.(credential),
    issuedAtMs: accessors.issuedAtOf?.(credential),
    ...params.keepAliveMaxIdleMs === undefined
      ? {}
      : { keepAliveMaxIdleMs: params.keepAliveMaxIdleMs },
  })) {
    // 凭据仍在有效期内：只把池值对账，不发请求。
    await syncAccountExpiry({
      pool,
      provider,
      credential,
      accessors,
      accountId,
      current,
      tag,
      warn: params.warn,
    })
    return false
  }

  const refreshed = await refresh(credential)
  // ⚠️ 续期响应缺访问令牌时**绝不能**把 `undefined` 落盘：那会把一份好凭据
  // 覆盖成 `"undefined"` 字符串，账号直接报废（只能重新登录）。
  if (refreshed === undefined) {
    throw new Error(`${tag} 续期响应缺少访问令牌，凭据未更新`)
  }
  /**
   * ⚠️⚠️ **`save()` 失败 = 凭据已死，必须报终态**（真实缺陷，2026-10-27）。
   *
   * ## 为什么不能像以前那样让它当普通异常冒泡
   *
   * `refresh()` 成功意味着**服务端已经把旧的一次性 token 消耗掉并签发了新的**
   * （codearts / officeace 的 refresh_token 都是一次性的）。此时若 `save()`
   * 失败，新凭据只有一个内存引用、随调用栈一起消失 ⇒ **本地永久停留在那份
   * 已被消耗的旧 token 上**。
   *
   * 旧实现让这个异常直接冒泡，调用方（`refreshAll` 的 catch）把它当**非终态**
   * 处理：只记一条 warn、不标 `refreshable:false`、下一轮继续用同一份死 token
   * 去兑换 ⇒ 服务端如实回 `STS5.1806 the refresh token has been used`
   * ⇒ 每轮失败一次、日志被 `terminalWarned` 去重、面板照常显示「自动续期」。
   *
   * 实测（2026-10-27 两次独立事故）：
   * - 时间线：16:58 续期成功落盘 → 17:58 那轮「兑换成功但 `.credentials.yaml`
   *   **零写入**」 → 18:23 池值被标 false → 18:30 实测 STS5.1806；
   * - 上一版「判终态前重读凭据」的防护**救不了它**：磁盘上的 `refresh_token`
   *   与刚用过的那份**完全相同**（因为没写进去），条件不成立。
   *
   * ⇒ 必须抛**终态错误**，让调用方走「需重新登录」分支。
   *
   * ## ⚠️⚠️ 终态错误的**类型必须由调用方给**（PR159 首版缺陷，2026-10-28 修）
   *
   * 首版让本模块 `import { RefreshTokenExpiredError } from './oauth.js'`
   * （codearts 的类），注释声称「各家 `refreshAll` 都按
   * `instanceof RefreshTokenExpiredError` 判终态 ⇒ **九家同时受益**」。
   * **这句不成立**：每家都有**自己的**同名类（buddy 用 `buddy-oauth.ts` 的、
   * trae / qoder / cline / lobsterai 各自在 auth 文件里定义、gemini 是
   * `GeminiRefreshTokenExpiredError`、minimax 是 `MinimaxRefreshTokenExpiredError`、
   * accio 是 `AccioRefreshTokenExpiredError`），跨模块 `instanceof` **恒为 false**
   * ⇒ 另外 8 家仍落「非终态」分支，账号照样静默死 —— 正是本修复要治的病。
   *
   * 另一种写法（本模块自定义一个中立类）同样不行：它不属于任何一家的判据。
   * ⇒ 只能由调用方把自己的类**注入**进来（`makeTerminalError`）。
   *
   * ## 为什么该参数是**必填**而不是可选带默认值
   *
   * 可选 + 默认 = 「漏接线」是**静默**的（退回普通 Error ⇒ 又变回静默死号），
   * 正是本缺陷的形态。必填 ⇒ 任何新增的调用点漏传都会在 `tsc --noEmit` 变红，
   * 不依赖人记得。实测接线点：九家、共 10 处（gemini 有两处）。
   *
   * ⚠️ `save()` 抛的是**存储层**错误（权限/磁盘满/序列化），不是网络错误，
   * 且此刻服务端票据已消耗 ⇒ 重试无意义，**不属可自愈类**。
   */
  try {
    await save(refreshed)
  } catch (error) {
    // ⚠️ 这条 warn 在**抛终态之前**单独记一次：调用方的终态分支会把它归成
    //    「refresh_token 已失效」，而真正的原因是**落盘失败**——两者对该怎么
    //    处置的答案相同（重新登录），但排查时要能一眼分清是谁的锅。
    //    实测（2026-10-27）当时的日志只有「续期失败：<存储错误>」一条，
    //    与「服务端拒绝」同形，导致定位多花了几十分钟。
    params.warn?.(
      `${tag} 账号 ${accountId} 续期**已成功但落盘失败**（${provider}）：`
      + `${error instanceof Error ? error.message : String(error)}`
      + ` ⇒ refresh_token 已在服务端被消耗，本地凭据已失效，需重新登录`,
    )
    throw params.makeTerminalError(
      `${tag} 账号 ${accountId} 续期成功但**新凭据落盘失败**：`
      + `${provider} 的 refresh_token 是一次性的，服务端那份已被消耗，`
      + `本地仍停留在旧 token 上，继续重试只会得到「已被使用」⇒ 必须重新登录。`
      + `落盘错误：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  await syncAccountExpiry({
    pool,
    provider,
    credential: refreshed,
    accessors,
    accountId,
    current,
    tag,
    warn: params.warn,
  })
  params.info?.(`${tag} 账号 ${accountId} 已续期`)
  return true
}
