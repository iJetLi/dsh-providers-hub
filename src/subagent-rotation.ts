/**
 * ★★★ **子代理专属起点与模型的运行时状态**（2026-11-23）。
 *
 * # 它解决什么问题
 *
 * 现状：子代理与主代理**用同一个起点账号**。用户希望子代理错开消耗 ——
 * 主代理烧 A 的临期，子代理去烧 B/C/D 的临期，避免所有子代理挤在一个号上
 * 把它的积分耗尽、而其他号闲置到过期。
 *
 * 用户原话：
 * > 「可以指定当前会话拉起的子代理使用的帐号起点」
 *
 * # 宿主已提供的能力（均已实证，2026-11-23）
 *
 * | 能力 | 宿主 API | 我们用它做什么 |
 * |---|---|---|
 * | 知道「谁是子代理、父会话是谁」| `subagent/start` 的 `parentSessionId` + `id` | 建立 sessionId → 分配记录 |
 * | 知道「子代理什么时候结束」| `subagent/end` | 标记结束（**保留**分配，供 resume）|
 * | 换账号 | `resolveCredential(model, sessionId)` | 按 sessionId 查分配 → 算出起点 |
 * | 换模型 | `agent/pre-step` + `agent.model.select()` | 每次 step 前按 sessionId 改写 |
 *
 * # 关键设计：本模块**不碰宿主**
 *
 * 全部是纯函数 + 状态容器。事件订阅与接线在 `index.ts` /
 * `credential-resolver.ts`，这样本文件可被单测直接 import
 *（本仓教训：把判据写进能测的文件里，别埋在装配层）。
 *
 * @module
 */

import type {
  SubagentRotationSetting,
  SubagentStartMode,
} from './jet-hub-store.js'

/**
 * 一条子代理分配记录。
 *
 * ⚠️ **必须持久化**：插件重启后收不到已经发过的 `subagent/start`，
 * 若不落盘，正在跑的子代理会退化成「用主代理起点」——
 * 用户会看到「子代理突然开始烧主代理的号」。
 */
export interface SubagentAssignment {
  /** 子代理自己的会话 id（= `subagent/start` 的 `info.id`）。 */
  sessionId: string
  /** 父会话 id（= 主代理）。用于查「主代理当时用的哪个起点」。 */
  parentSessionId: string
  /** 分配时刻（淘汰按它排序）。 */
  at: number
  /**
   * 本子代理在「错开序列」里的序号（0 = 第一个子代理）。
   *
   * ⚠️ 存序号而不是直接存 accountId：账号池会变（增删/停用/积分耗尽），
   * 每次请求都要**现算**起点，才能保证「起点失效时自动换下一个」这条
   * 沿用主代理规则。
   */
  slot: number
  /** `subagent/end` 是否已到达（只用于诊断，**不参与**任何判据）。 */
  ended?: boolean
}

/** 单 provider 的分配表：sessionId → 记录。 */
export type SubagentAssignmentMap = Record<string, SubagentAssignment>

/**
 * 淘汰上限（单 provider）。
 *
 * 取 128：子代理通常短命，但可能连续拉起几十个。单条 ≈ 200 字节
 * ⇒ 单 provider 至多 ≈ 26 KB，可接受。
 *
 * ⚠️ 比 `PREFERRED_ROTATION_MAX_SESSIONS`（64）大一倍：子代理的产生频率
 * 远高于「用户手动选起点」。
 */
export const SUBAGENT_ASSIGNMENT_MAX = 128

/**
 * 归一化分配表（读写两侧都跑，与 `sanitizePreferredRotation` 同纪律）。
 *
 * ⚠️ 脏数据**整条丢弃**：`sessionId` / `parentSessionId` 是后续所有判据的前提。
 */
export function sanitizeSubagentAssignments(raw: unknown): SubagentAssignmentMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: SubagentAssignmentMap = {}
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0) continue
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const src = entry as Record<string, unknown>
    const sessionId = typeof src.sessionId === 'string' && src.sessionId.length > 0 ? src.sessionId : undefined
    const parentSessionId = typeof src.parentSessionId === 'string' && src.parentSessionId.length > 0
      ? src.parentSessionId
      : undefined
    const at = typeof src.at === 'number' && Number.isFinite(src.at) && src.at >= 0 ? src.at : undefined
    const slot = typeof src.slot === 'number' && Number.isInteger(src.slot) && src.slot >= 0 ? src.slot : undefined
    if (sessionId === undefined || parentSessionId === undefined || at === undefined || slot === undefined) continue
    /**
     * ★ **钉住的账号**（2026-11-24）：拉起时算定，之后只要它还可用就不换。
     *
     * ⚠️ 与 slot 同纪律：非法值**丢弃**（不给默认值）——
     * 猜一个账号 id 会让子代理用错号，且无从排查。
     */
    /* ⚠️ pin 字段已删（2026-11-25 重构：起点改存 preferredRotation）。 */
    /** ★ 用户手动选的账号（与 pin 同纪律：非法值丢弃，不猜）。 */
    /* ⚠️ userPicked 字段已删（2026-11-25：手选直接写 preferredRotation）。 */
    // ⚠️ 键必须是 sessionId 本身：写错就是「查不到分配」→ 静默回落主代理起点。
    result[sessionId] = {
      sessionId,
      parentSessionId,
      at,
      slot,
      ...(src.ended === true ? { ended: true } : {}),
    }
  }
  return pruneSubagentAssignments(result)
}

/**
 * 按 {@link SUBAGENT_ASSIGNMENT_MAX} 淘汰最旧的（`at` 升序丢前面的）。
 *
 * ⚠️ 纯函数，返回新对象。
 * ⚠️ `limit <= 0` ⇒ 返回空表（确定性结果，不是「全留」）。
 */
export function pruneSubagentAssignments(
  assignments: SubagentAssignmentMap,
  limit: number = SUBAGENT_ASSIGNMENT_MAX,
): SubagentAssignmentMap {
  const keys = Object.keys(assignments)
  if (limit <= 0) return {}
  if (keys.length <= limit) return { ...assignments }
  const kept = keys
    .sort((a, b) => (assignments[a]!.at - assignments[b]!.at))
    .slice(keys.length - limit)
  const result: SubagentAssignmentMap = {}
  for (const key of kept) result[key] = assignments[key]!
  return result
}

/**
 * 记录一个新分配（**幂等**）。
 *
 * ## 为什么幂等（真实场景）
 *
 * 同一个子代理可能被 resume ⇒ `subagent/start` 会**再次**发出。
 * 若每次都分配新 slot，一个子代理会「越跑越往后挪」，而它的历史分配被浪费。
 *
 * ⇒ 已存在就**保留原 slot**。
 */
export function recordSubagentAssignment(
  assignments: SubagentAssignmentMap,
  sessionId: string,
  parentSessionId: string,
  slot: number,
  now: number,
): SubagentAssignmentMap {
  const existing = assignments[sessionId]
  if (existing !== undefined) {
    /**
     * ⚠️ resume 时 `subagent/start` 会再来一次（宿主行为）。
     * 保留原 slot，但**清掉** `ended` —— 它又活了。
     */
    return {
      ...assignments,
      /**
       * ⚠️ **`pinnedAccountId` / `pinSetAt` 必须原样保留**（2026-11-24）。
       *
       * resume 是同一个子代理**继续**跑 —— 换账号会让它的 prompt cache
       * 全失效（用户明确要求「拉起时定死」）。
       *
       * ⚠️ `{ ...existing, ended: false }` 天然保留它们，这里显式写出来是
       * 为了**防止**将来有人改这行时顺手把 pin 清掉（那会静默退化成
       * 「每次 resume 都重算」）。
       */
      [sessionId]: { ...existing, ended: false, at: existing.at },
    }
  }
  return pruneSubagentAssignments({
    ...assignments,
    [sessionId]: { sessionId, parentSessionId, at: now, slot },
  })
}

/**
 * 标记某个子代理已结束（**不清除记录**）。
 *
 * ## 为什么保留记录
 *
 * 1. 子代理可能被 **resume**（`send_message` 继续它的对话）—— 那时 sessionId 不变，
 *    应继续用**原来的** slot，而不是重新排到队尾；
 * 2. 立即删除会让「正在收尾的最后一轮请求」查不到分配 ⇒ 突然跳回主代理起点
 *    （用户会看到「子代理最后一枪烧了主代理的号」）。
 *
 * ⇒ 只置 `ended` 标记（诊断用），实际清理交给 `at` 淘汰。
 */
export function markSubagentEnded(
  assignments: SubagentAssignmentMap,
  sessionId: string,
): SubagentAssignmentMap {
  const existing = assignments[sessionId]
  if (existing === undefined) return assignments
  return { ...assignments, [sessionId]: { ...existing, ended: true } }
}
export function nextSubagentSlot(assignments: SubagentAssignmentMap): number {
  let max = -1
  for (const entry of Object.values(assignments)) {
    if (entry.slot > max) max = entry.slot
  }
  return max + 1
}

/**
 * ★★★ **在「同档位序列」里按策略算出起点账号 id**。
 *
 * # 这是本功能的核心判据（纯函数，可全量测）
 *
 * ## 输入
 *
 * @param tierIds - 主代理起点**所在档位**的账号 id 列表，**按策略序**
 * @param mainStartId - 主代理当前实际用的账号 id（= 该档位列表里的某个元素）
 * @param mode - 策略
 * @param slot - 本子代理的序号（0 起）
 * @param sessionId - 子代理会话 id（`hash` 模式用）
 * @returns 应作为子代理起点的账号 id；`undefined` = 无法决定（调用方回落主代理）
 *
 * ## 各策略的语义（用户 2026-11-23 确认）
 *
 * | 模式 | 语义 |
 * |---|---|
 * | `follow` | 返回 `mainStartId`（与主代理同号）|
 * | `sequence` | 主代理起点**往后**第 `slot+1` 个（绕回）|
 * | `reverse` | 主代理起点**往前**第 `slot+1` 个（绕回）|
 * | `hash` | 按 `sessionId` 稳定哈希到该档位内某个账号（排除主代理）|
 * | `fixed` | 返回 `undefined` —— 固定模式**不走档位序列**，由外层按位次取 |
 *
 * ## ⚠️⚠️ 为什么只在「同一档位内」错开
 *
 * 用户明确纠正过我第一版的错误理解：
 *
 * > 「子代理在分配帐号起点时，肯定也要像主代理一样，遵守档次优先的原则呀」
 *
 * 跨档位反转会让子代理**先烧短期**（临期还没烧完就去烧短期）——
 * 那就违背了「临期优先」这条核心策略。`rotateFromPreferred` 内部**始终**
 * 先按档位分组，所以只要起点落在同一档位内，第一枪必然是临期。
 *
 * ## ⚠️ 主代理起点可能不在 `tierIds` 里
 *
 * 调用方应从**候选集**构造 `tierIds`；若主代理起点不在其中（被限流/封禁滤掉），
 * 返回 `undefined` 让调用方回落 —— 而不是猜一个。
 */
export function startIndexOfSlot(
  tierIds: readonly string[],
  mainStartId: string,
  mode: SubagentStartMode,
  slot: number,
  sessionId: string,
): string | undefined {
  if (mode === 'follow') return mainStartId
  /** `fixed` 的起点由账号位次直接决定，不属于「档位内错开」。 */
  if (mode === 'fixed') return undefined
  if (tierIds.length === 0) return undefined

  const base = tierIds.indexOf(mainStartId)
  /**
   * ⚠️ 主代理起点不在本档位 ⇒ 无法定位基准。返回 `undefined` 让调用方回落，
   * **不要**当成下标 0（那会静默让所有子代理从档位第一个开始，
   * 看起来像「配置没生效」）。
   */
  if (base < 0) return undefined

  const n = tierIds.length

  if (mode === 'sequence') {
    /** slot=0 ⇒ 起点后的第一个（**不含主代理自己**）。 */
    return tierIds[(base + 1 + slot) % n]
  }
  if (mode === 'reverse') {
    /** slot=0 ⇒ 起点前的那一个。`+ n * 2` 保证非负。 */
    return tierIds[((base - 1 - slot) % n + n * 2) % n]
  }
  if (mode === 'hash') {
    /**
     * 哈希取 **`tierIds` 中除主代理起点外**的下标。
     *
     * ⚠️ 必须排除主代理那个位置：否则子代理有 `1/n` 概率与主代理撞号，
     * 而用户要的正是「错开」。排除后 n=1 时无位置可选 ⇒ 回落主代理。
     */
    const others = tierIds.filter((id) => id !== mainStartId)
    if (others.length === 0) return mainStartId
    return others[hashString(sessionId) % others.length]
  }
  return mainStartId
}

/**
 * 稳定字符串哈希（32 位 FNV-1a 变体）。
 *
 * ⚠️ **不能用 `Math.random` 或时间**：同一子代理的每次请求必须落在同一账号上，
 * 否则「子代理 A 第一枪烧 B、第二枪烧 C」—— 用户在积分面板上看到它在乱跳。
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/**
 * 从「全量启用账号」里按**位次**取账号 id（`fixed` 模式用）。
 *
 * @param enabledIds - 全量启用账号 id，**按池序**（1-based 位次即下标 +1）
 * @param position - 1-based 位次
 * @returns 该位次的账号 id；越界 / 非正整数 ⇒ `undefined`
 *
 * ⚠️ 越界时返回 `undefined`（调用方回落主代理起点），**不**静默取最后一个：
 * 用户的设置里写着「位次 5」，实际只剩 3 个号时悄悄用第 3 个，会让用户
 * 以为「固定」失效了（本仓记过多次同类静默降级）。
 */
export function accountIdAtPosition(
  enabledIds: readonly string[],
  position: number | undefined,
): string | undefined {
  if (position === undefined) return undefined
  if (!Number.isInteger(position) || position < 1) return undefined
  return enabledIds[position - 1]
}

/**
 * 判断「该 provider 的子代理设置是否需要生效」。
 *
 * @param setting - 该 provider 的子代理设置
 * @returns 是否启用（`false` ⇒ 调用方走主代理逻辑，与加本功能之前逐字节相同）
 */
export function subagentSettingActive(setting: SubagentRotationSetting | undefined): boolean {
  if (setting === undefined) return false
  /**
   * ⚠️ `follow` 且无模型设置 ⇒ 完全等价于「没配」。
   * 进入子代理分支也无害，但会让「是否有分配记录」这类诊断指标变成噪音。
   */
  if (setting.startMode === 'follow' && setting.model === undefined) return false
  return true
}

/**
 * ★★★ **子代理父子表**（模块级，进程内）。
 *
 * ## 为什么单独放在这里而不是 `AccountPool`
 *
 * 这张表是「**哪些 sessionId 是子代理**」的唯一真源，与 provider 无关 ——
 * 一个子代理只会用一个 provider，但事件里**没有 provider 信息**。
 *
 * ⇒ `subagent/start` 只记这里；真正的 provider 级分配
 * （`pool.recordSubagentStart`）等第一次 `resolveCredential` 时才做。
 *
 * ## 为什么进程内不落盘
 *
 * 它只是「快速判定某 sessionId 是不是子代理」的加速结构。
 * 落盘的权威是 `pool.subagentAssignments`（带 provider + slot）。
 * 进程重启后：
 *
 * - 已结束的子代理 ⇒ 无需知道；
 * - **仍在跑的子代理** ⇒ 这张表空了，但 `pool.subagentAssignmentOf()`
 *   仍能从**落盘的分配表**里查到 ⇒ 起点不受影响；
 * - 只有「插件重启后才第一次出现的子代理」会走 `subagent/start` 登记。
 *
 * ⇒ 进程内表的丢失**不破坏正确性**，只影响「一个刚拉起、还没请求过、
 * 且插件恰好重启」的极窄窗口（那时也无从知道 provider）。
 */
const subagentParents = new Map<string, string>()

/** 记下「某子代理的父会话」（`subagent/start` 时调）。 */
export function rememberSubagentParent(childId: string, parentId: string): void {
  if (childId.length === 0 || parentId.length === 0) return
  subagentParents.set(childId, parentId)
  /**
   * ⚠️ 无上限会让长时间运行的进程无限增长。子代理短命，用 FIFO 淘汰
   *（Map 保持插入序，删最早的即可）。
   */
  if (subagentParents.size > SUBAGENT_ASSIGNMENT_MAX) {
    const oldest = subagentParents.keys().next()
    if (!oldest.done) subagentParents.delete(oldest.value)
  }
}

/** 查「某 sessionId 是不是子代理」。 */
export function isSubagentSession(sessionId: string): boolean {
  return subagentParents.has(sessionId)
}

/** 查某子代理的父会话 id。 */
export function subagentParentOf(sessionId: string): string | undefined {
  return subagentParents.get(sessionId)
}

/** 子代理结束时**不必**从父子表清除（见 {@link isSubagentSession} 的说明），
 * 但清理能省内存；且若它被 resume，`subagent/start` 会再登记一次。 */
export function forgetSubagentParent(sessionId: string): void {
  subagentParents.delete(sessionId)
}

/** 清空父子表（**仅供单测**）。 */
export function resetSubagentParentsForTest(): void {
  subagentParents.clear()
}

/** 当前父子表大小（诊断 / 单测用）。 */
export function subagentParentCount(): number {
  return subagentParents.size
}