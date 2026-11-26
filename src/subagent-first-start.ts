/**
 * ★★★ **子代理首次拉起：算一次「轮换起点」并写成 `preferredRotation`**
 * （2026-11-25 重构，用户定案）。
 *
 * ## 用户原话（这是本次重构的全部依据）
 *
 * > 「除了需要子代理轮换起点策略之外，其他点子代理跟主代理都一样的行为」
 *
 * > 「这个位次就相当于用户在主代理手动选择下拉框一样」
 *
 * > 「pin 就相当于主代理的手动选择轮换起点呀，肯定就先轮换起点，
 * >   然后不行了就按照策略切号呀」
 *
 * ## 设计：只做一件事
 *
 * ```
 * 子代理首次请求（preferredRotation 里还没有它的 sessionId）
 *   ↓
 * ① 按 `startMode`（follow / sequence / reverse / hash / fixed）算出目标账号
 *   ↓
 * ② 从**共享的 selector 缓存**取该号这一刻的档位（零额外网络开销）
 *   ↓
 * ③ 换算成位次，写 `preferredRotation[子代理 sessionId] = { position, tierAtSelection }`
 *   ↓
 * ────────────── 以下与主代理**完全同一条代码** ──────────────
 *   preferredRotationFor → accountId
 *   rotationStartTierFor → 档位快照
 *   pickBuddyAccount → rotateFromPreferred（同一份切号逻辑）
 * ```
 *
 * ## ⚠️ 为什么必须在**首次**写，而不是每发都写
 *
 * 主代理的 `preferredRotation` 是「用户选一次，之后一直用」。
 * 子代理照抄：**只在首次写一次**，之后 pin 就固定了 ——
 * 这正是用户要的「拉起时定死，缓存命中率高」。
 *
 * ⚠️ 但 pin 的号**烧完那一档**之后，由 `rotateFromPreferred` 的现有逻辑
 * 自动按积分列表切号，并把新号**写回** `pinnedAccountId`（诊断用）。
 * ⇒ 起点本身**不变**，变的是「当前实际在用的号」。
 *
 * ## ⚠️ 档位的来源（用户问过「为什么算不出档次」）
 *
 * 主代理的档次不是存储字段，而是 `buddyBalanceTier(余额)` 现算的；
 * 余额在 **`BuddyBalanceSelector.cache`**（进程级、每个 provider 一个实例）。
 *
 * | 情况 | `cachedTierOf` |
 * |---|---|
 * | 主代理刚发过请求（子代理就是它拉起的）| **命中缓存，零成本** |
 * | 插件刚重启 / 超 60s TTL | 未命中 ⇒ 本函数**主动查一次**（`balanceOf`）|
 *
 * ⇒ 绝大多数情况零开销；冷启动才多一次查询（那一次本来也会被选号路径查到）。
 */
import type {
  RotationStartTier,
  SubagentRotationSetting,
  SubagentStartMode,
} from './jet-hub-store.js'

/** `tierRank` → `RotationStartTier`（与 `buddy-balance-rank.ts` 的枚举同值）。 */
export function rotationStartTierOfRank(rank: number | undefined): RotationStartTier | undefined {
  if (rank === 0) return 'imminent'
  if (rank === 1) return 'expiring'
  if (rank === 2) return 'permanent'
  return undefined
}

/**
 * 读某账号当前的轮换起点档位。
 *
 * ⚠️ **只读缓存**（`cachedTierOf`）；未命中返回 `undefined`，
 *    由调用方决定要不要回查（`balanceOf`）。
 *
 * ⚠️ `allowPermanent` 用**恒解锁**口径（`true`）：
 *    档位快照要表达「这个号现在是什么档」，与「允不允许烧永久」是两件事。
 *    主代理侧 `tierAtSelectionOf` 同样用 `backendOrderTier(split, true)`
 *    （见 `usage-badge.js:2244`）⇒ 两处**同源**。
 */
export interface TierProbe {
  cachedTierOf(account: { id: string }, allowPermanent: boolean): number | undefined
  balanceOf?(account: { id: string }): Promise<unknown>
}

/**
 * 给定目标账号 id，读出它的档位快照。
 *
 * @returns 档位；`undefined` = 读不到（此时**不应**写 `preferredRotation`
 *          —— 没有档位的条目会被 `sanitizePreferredRotation` 丢弃）
 */
export async function probeRotationStartTier(
  probe: TierProbe | undefined,
  accountId: string,
): Promise<RotationStartTier | undefined> {
  if (probe === undefined || typeof probe.cachedTierOf !== 'function') return undefined
  const asAccount = { id: accountId }
  /** ① 先读缓存（绝大多数情况命中）。 */
  const cached = probe.cachedTierOf(asAccount, true)
  if (cached !== undefined) return rotationStartTierOfRank(cached)
  /** ② 冷启动：查一次（`balanceOf` 内部会缓存结果，后续请求零成本）。 */
  if (typeof probe.balanceOf === 'function') {
    try {
      await probe.balanceOf(asAccount)
    } catch { return undefined }
    const after = probe.cachedTierOf(asAccount, true)
    if (after !== undefined) return rotationStartTierOfRank(after)
  }
  return undefined
}

/**
 * 把「账号 id」换算成「启用账号池序里的位次」（1-based）。
 *
 * ⚠️ 必须与 `AccountPool.preferredRotationFor` 的换算**同口径** ——
 * 那里是 `readAccounts().filter(enabled)[position - 1]`，
 * 故这里必须用**同一份顺序**（`listAccountsByProvider` 已按池序返回，
 * 只需再 `filter(enabled)`）。
 *
 * @returns 位次；找不到 ⇒ `undefined`（调用方不写，避免写进「永远不生效」的位次）
 */
export function positionOfAccount(
  enabledIds: readonly string[],
  accountId: string,
): number | undefined {
  const idx = enabledIds.indexOf(accountId)
  return idx < 0 ? undefined : idx + 1
}

/**
 * 判断「本次是否该为子代理算起点」。
 *
 * ## 三条同时成立
 *
 * | # | 条件 | 为什么 |
 * |---|---|---|
 * | ① | 有 `sessionId` 且**已登记为子代理**（分配表里有记录）| 主代理不参与 |
 * | ② | 配了 `subagent.startMode` | 没配 ⇒ 完全走主代理行为 |
 * | ③ | **`preferredRotation` 里还没有该 sessionId 的条目** | 只在**首次**算一次 |
 *
 * ⚠️ ③ 是关键：主代理的起点是「用户选一次」；子代理照抄 ⇒
 *    只在首次写，之后 pin 固定（缓存命中率）。
 */
export function shouldDecideSubagentStartOnFirstUse(options: {
  sessionId: string | undefined
  setting: SubagentRotationSetting | undefined
  /** 分配表里是否已有这条 sessionId（= 已登记为子代理）。 */
  hasAssignment: boolean
  /** `preferredRotation` 里是否已有该 sessionId 的条目。 */
  hasPreferredRotation: boolean
}): boolean {
  if (options.sessionId === undefined || options.sessionId.length === 0) return false
  if (!options.hasAssignment) return false
  if (options.setting?.startMode === undefined) return false
  /** ⚠️ 已有条目 ⇒ 用户/上一次已定过起点 ⇒ **不再算**。 */
  if (options.hasPreferredRotation) return false
  return true
}

/** 合法 `startMode` 列表（与 `jet-hub-store.ts` 的 `SUBAGENT_START_MODES` 一致）。 */
export const DECIDE_START_MODES: readonly SubagentStartMode[] =
  ['follow', 'sequence', 'reverse', 'hash', 'fixed']
