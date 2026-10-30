/**
 * 按 **sessionId** 做账号亲和 / 无 sessionId 时随机分摊的纯函数。
 *
 * ## 为什么需要它
 *
 * 账号池此前的 `getAvailableAccount()` 永远取「手动顺序第一个可用账号」：
 * 只要 1 号没撞限额，全部流量都压在它身上。对 ZCode 这种「一个会话会连续
 * 发很多轮请求」的 provider，用户希望：
 *
 * - **有 sessionId**：同一会话固定落到同一个账号（会话亲和），不同会话按
 *   sessionId 稳定分散到不同账号；
 * - **没有 sessionId**（本地 OpenAI 网关等一次性调用）：每次随机挑一个账号，
 *   把请求分摊开。
 *
 * ## 为什么用 rendezvous 哈希而不是 `hash % N`
 *
 * `hash(sessionId) % 账号数` 在账号数变化时会**整体重排**：某个账号临时进入
 * 限流（候选集从 5 个变 4 个）会让所有会话换号，限流恢复后又全部换回。
 * rendezvous 哈希给每个 `(session, account)` 算一个稳定分数、按分数排序取最高，
 * 账号集合变化时只有原本落在那个账号上的会话需要迁移，其余会话保持不动。
 *
 * ## 为什么随机回退用洗牌而不是「随机取一个」
 *
 * 随机取一个若刚好拿到凭据损坏 / 已被 `tried` 排除的账号，还要再抽一次；
 * 直接洗牌后顺序尝试，既均匀又不重复。
 */

import { createHash } from 'node:crypto'

/**
 * 「ZCode 会话负载均衡」的开关环境变量。
 *
 * ## 默认与判据（与 `DSH_RATE_LIMIT_SINK` 同型，**别写成 falsy 判断**）
 *
 * 默认**开启**（用户 2026-10-30 的原始需求）。留这道开关是因为它改变了选号
 * 语义：手动顺序不再决定谁先被用；若有人依赖「首位账号一直扛」的旧行为
 * （例如想让额度最充足的号先烧完），显式设 `0` / `false` / `off` / `no`
 * 即整体退回「手动顺序优先」的既有路径 —— 与关掉前逐字节同语义。
 *
 * ⚠️ 判据取「**显式写了** `0/false/off/no` 才算关」，未设置 / 空串 / 无法
 * 识别的值一律按默认开启 —— `Boolean(env[...])` 会把「未设置」误判成关闭
 * （`account-pool.ts` 的 `rateLimitSinkEnabled` 记过同型坑）。
 *
 * ⚠️ **与 `jet-hub-store.ts` 的 `sanitizeSessionBalanceEnabled` 是两套刻意
 * 不同的判据，不要「统一」**：本函数是 **env 替身回落**（字符串宽松，`'false'`
 * 算关 —— env 里没有类型，用户写了就是意图）；store 那份是**落盘数据判据**
 * （严格 `raw !== false` —— 脏字符串 ≠ 用户意图，宁可当启用）。生产路径恒走
 * store 那份（见 `credential-resolver.ts` ③ 的 poolSwitch 优先级），本函数
 * 只在「结构化替身池」可达。
 */
export const DSH_ZCODE_SESSION_BALANCE = 'DSH_ZCODE_SESSION_BALANCE'

/** 当前是否启用「ZCode 会话负载均衡」（见 {@link DSH_ZCODE_SESSION_BALANCE}）。 */
export function sessionBalanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DSH_ZCODE_SESSION_BALANCE]
  if (typeof raw !== 'string') return true
  const value = raw.trim().toLowerCase()
  if (value.length === 0) return true
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no')
}

/** 计算 `(scope, sessionId, accountId)` 的稳定分数（SHA-256 十六进制）。 */
export function sessionAccountScore(scope: string, sessionId: string, accountId: string): string {
  return createHash('sha256')
    .update(scope)
    .update('\0')
    .update(sessionId)
    .update('\0')
    .update(accountId)
    .digest('hex')
}

/**
 * 按 sessionId 给账号做 **rendezvous 哈希**排序（分数从高到低）。
 *
 * - 同一个 sessionId + 同一批账号 ⇒ 结果逐字稳定（跨进程、跨重启一致）；
 * - 不同 sessionId 会得到不同顺序，从而把会话分散到不同账号；
 * - 账号集合增删时，只影响原本首选该账号的会话，其余顺序尽量保持。
 *
 * @param accounts - 候选账号（调用方已按 enabled / 模型限流 / tried 过滤）。
 * @param sessionId - 非空会话标识。
 * @param scope - 命名空间（传 provider id），避免不同 provider 的同名账号串味。
 * @returns 新数组，不修改入参。
 */
export function rankAccountsBySession<T extends { id: string }>(
  accounts: readonly T[],
  sessionId: string,
  scope: string,
): T[] {
  return [...accounts].sort((a, b) => {
    const sa = sessionAccountScore(scope, sessionId, a.id)
    const sb = sessionAccountScore(scope, sessionId, b.id)
    if (sa !== sb) return sa < sb ? 1 : -1
    // 哈希碰撞在 SHA-256 下实际不可达；保留确定性的 id 次序，避免引擎排序不稳定。
    return a.id.localeCompare(b.id)
  })
}

/**
 * Fisher–Yates 洗牌（不改入参）。
 *
 * `random` 可注入，供单测固定序列；生产缺省 `Math.random`。
 */
export function shuffleAccounts<T>(accounts: readonly T[], random: () => number = Math.random): T[] {
  const out = [...accounts]
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    const current = out[index]!
    out[index] = out[swapIndex]!
    out[swapIndex] = current
  }
  return out
}

/**
 * 「账号今日负载」读数（供溢出均衡用）。
 *
 * 只取选号真正需要的两个字段：**今日请求数**与**今日输出 token**。
 * 数据源是 token-ledger 的日聚合（`readTokenLedgerDayMap()`），**纯内存读、
 * 零网络请求** —— 选号在推理关键路径上，绝不能在这里发余额请求。
 */
export interface AccountLoadReading {
  /** 该账号今日（UTC+8 日界）的请求笔数（含失败）。 */
  requests: number
  /** 该账号今日的输出 token 合计（0 = 还没跑过）。 */
  outputTokens: number
}

/**
 * 会话负载均衡的**溢出阈值**环境变量（账号今日请求数）。
 *
 * ## 为什么需要溢出（2026-10-31 用户报障「每个账号的负载并不太均衡」）
 *
 * 会话亲和的负载由「**会话长度 × 重试**」决定：一个跑一天的会话（实测
 * EASYTV 会话单日 820 条消息、请求数百次）会把它哈希到的那个账号独自吃满，
 * 而没有会话落在上面的账号整天空闲 —— 账号粒度天然不均。
 *
 * 溢出的含义：账号今日请求量超过阈值后，**新会话**不再亲和到它（排序沉底），
 * 已有的会话**保持亲和**（换号会让同一会话的上下文缓存失效，得不偿失）。
 * `0` = 关闭溢出（纯哈希亲和）；负数/非法值按缺省。
 *
 * ⚠️ 默认值取 **600**：均匀目标是 请求总量 ÷ 账号数；实测单账号峰值日 ~1000+
 * 次（含重试），600 约为「均匀量 ×2」再留出重试放大余量 —— 超过它说明该账号
 * 已经比其它账号多扛了一倍以上的量。可按池大小自行调整（环境变量优先）。
 */
export const DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS = 'DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS'

/** 缺省溢出阈值（今日请求数）。 */
export const DEFAULT_OVERFLOW_REQUESTS = 600

/** 当前生效的溢出阈值；`0` = 关闭溢出均衡（纯哈希亲和）。 */
export function overflowRequestsThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS]
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_OVERFLOW_REQUESTS
  const parsed = Number.parseInt(raw.trim(), 10)
  // 非法值回落缺省；`0` 是合法值（关闭溢出），不能被 `||` 吃掉。
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_OVERFLOW_REQUESTS
}

/**
 * 按账号 id 索引「今日负载」读数。
 *
 * @param days - token-ledger 日聚合表（`readTokenLedgerDayMap()` 的返回）。
 * @param provider - provider id（只统计该渠道的桶）。
 * @param day - UTC+8 日键（`utc8DayKey(Date.now())`，由调用方传入以便单测）。
 */
export function accountLoadIndex(
  days: ReadonlyMap<string, ReadonlyMap<string, {
    requests: number
    outputTokens: number
  }>>,
  provider: string,
  day: string,
): Map<string, AccountLoadReading> {
  const index = new Map<string, AccountLoadReading>()
  const buckets = days.get(day)
  if (buckets === undefined) return index
  for (const [key, bucket] of buckets) {
    // 桶键 `channel|provider|account|model`（值里的 `|` 已转义成 `/`，split 恒 4 段）。
    const parts = key.split('|')
    if (parts.length !== 4) continue
    const [, bucketProvider, accountId] = parts
    if (bucketProvider !== provider || accountId === undefined || accountId.length === 0) continue
    const current = index.get(accountId) ?? { requests: 0, outputTokens: 0 }
    current.requests += bucket.requests ?? 0
    current.outputTokens += bucket.outputTokens ?? 0
    index.set(accountId, current)
  }
  return index
}

/**
 * 带**溢出**的会话排序：负载超阈值的账号沉底，其余按 rendezvous 序不变。
 *
 * ## 语义（三条都要成立）
 *
 * 1. **未超载**的账号之间：rendezvous 哈希序不变（亲和照旧，跨请求稳定）；
 * 2. **超载**的账号整组沉到最后：新会话落到未超载账号上（负载分摊）；
 * 3. **超载账号之间的相对次序**仍按哈希 —— 全部超载时（比如深夜只有一个
 *    超长会话在跑）行为退化为纯哈希亲和，不会出现「都超载反而乱换号」。
 *
 * ⚠️ 这是**软溢出**而非硬排除：超载账号仍在候选里（排最后），只是新会话
 * 优先绕开它。硬排除会让「5 个号全超载」时选不出号 —— 而此时正确动作是
 * 照常发请求让上游自己限流。
 *
 * @param accounts - 候选账号（调用方已按 enabled / 模型限流 / tried 过滤）。
 * @param sessionId - 非空会话标识。
 * @param scope - 命名空间（provider id）。
 * @param loads - 账号今日负载索引（缺账号 = 今日没跑过 = 负载 0）。
 * @param thresholdRequests - 溢出阈值（今日请求数）；`0` = 关闭溢出。
 * @returns 新数组，不修改入参。
 */
export function rankAccountsBySessionWithOverflow<T extends { id: string }>(
  accounts: readonly T[],
  sessionId: string,
  scope: string,
  loads: ReadonlyMap<string, AccountLoadReading>,
  thresholdRequests: number,
): T[] {
  const ranked = rankAccountsBySession(accounts, sessionId, scope)
  // 阈值 0 = 关闭；负数视同关闭（与 0 同语义，不抛错）。
  if (thresholdRequests <= 0) return ranked
  const fresh = ranked.filter(a => (loads.get(a.id)?.requests ?? 0) < thresholdRequests)
  const overflowed = ranked.filter(a => (loads.get(a.id)?.requests ?? 0) >= thresholdRequests)
  // 全员超载时 fresh 为空 —— 直接返回原哈希序（语义 3）。
  if (fresh.length === 0 || overflowed.length === 0) return ranked
  return [...fresh, ...overflowed]
}
