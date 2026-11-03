/**
 * MiniMax / MiniMax 国际版的**同账号去重**（2026-10-25 合并审计补修）。
 *
 * ## 为什么单独成模块
 *
 * `jet-hub-rpc.ts` 里那段去重原本只有「查重 + 把新卡停用」一件，而同一语义在
 * `officeace` 分支是**三件套 + 一个反转腿**（见该分支的注释与 2026-10-17 的 P2）。
 * minimax 只搬了第 1 件 ⇒ 实测出两个后果：
 *
 * 1. **原卡被用户手动停用时，两张卡全停用** ⇒ `getAvailableAccount()` 返回
 *    `null`（它按 `enabled` 过滤，`account-pool.ts` 的 `:2314`），而
 *    `login.poll` 仍报「登录成功」⇒ 用户以为登好了，实际该渠道**零可用号**
 *    （若它是唯一账号，模型选择器还会因门控整组消失）。
 *    这与 officeace 2026-10-17 修的 P2 **逐字同形**。
 * 2. **新 token 停在停用卡、旧 token 留在启用卡**，且续期调度器**刻意不看
 *    `enabled`**（`index.ts` 的既有约定）⇒ 同一个上游账号挂**两条续期链**。
 *    MiniMax 的 refresh_token 是轮换式的（本仓库 `jet-hub-rpc.ts` 既有注释记载）
 *    ⇒ 两条链互相作废，症状正是本 PR 要治的「旧的那条掉登录」。
 *
 * ## 三条不变量（与 officeace 逐格同构，判据必须能各自被抓到）
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 命中重复时**不删条目**，只标停用 + 改名 | 删掉会让 `login.poll` 把「登录成功」显示成失败 |
 * | 2 | 新鲜凭据必须**转到保留下来的那张卡**，然后清掉重复卡的凭据 | 两条续期链互相作废 |
 * | 3 | 命中一张**已停用**的原卡时**反转**（新卡可用、原卡标重复并停用） | 零可用号 |
 *
 * ## 刻意与 officeace 的差异
 *
 * `officeace` 的转写走 `auths.officeace.persistLogin(credential, {refName})`
 * —— 它那里凭据是**结构化对象**。minimax 这里的凭据已由 `persistLogin` 落盘
 * （含 `user_id` / `nickname`），故直接**原样搬运那份 JSON**：重新序列化一遍
 * 反而可能丢字段（正是本 PR 要治的「续期丢身份」同型缺陷）。
 */

import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'

import type { ProviderAccountEntry } from './types.js'

/** 去重的四种结局（测试逐格点名，别把它并成 boolean）。 */
export type MinimaxDedupOutcome =
  /** 拿不到稳定身份（老凭据 / 身份查询失败）⇒ 放弃去重，绝不猜。 */
  | 'skipped-no-identity'
  /** 池里没有同 `user_id` 的**另一张**卡 ⇒ 正常新建。 */
  | 'skipped-not-duplicate'
  /** 命中一张启用的原卡：新卡停用、凭据转写回原卡。 */
  | 'duplicate'
  /** 命中一张**已停用**的原卡：反转（新卡可用，原卡标重复并停用）。 */
  | 'reversed'
  /** 读池失败 ⇒ 不做任何破坏性动作（读不到 ≠ 没有）。 */
  | 'error'

export interface MinimaxDedupDeps {
  pool: {
    findAccountIdByIdentityField(
      provider: string,
      field: string,
      identity: string,
      excludeAccountId?: string,
    ): Promise<string>
    /** 含已停用账号的按 id 查询（`AccountPool.findAccount` 是**同步**的）。 */
    findAccount?(id: string): ProviderAccountEntry | undefined
    updateAccount(
      id: string,
      patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled' | 'expiresAt' | 'refreshable'>>,
    ): Promise<void>
  }
  credentials: {
    resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
    set(ref: CredentialRef, value: string): Promise<void>
    unset(ref: CredentialRef): Promise<void>
  }
  logger?: { warn?(message: string): void }
}

export interface MinimaxDedupArgs {
  /** provider id（`minimax` / `minimaxintl`）—— 两站各自独立判重。 */
  providerId: string
  /** 本次登录新建的账号 id。 */
  newAccountId: string
  /** 本次登录的凭据 ref **名**（`persistLogin` 刚写进去的那个）。 */
  newCredentialRefName: string
  /** 稳定身份（`user_id`）。缺失即放弃去重。 */
  identity: string | undefined
  /** 展示名（含两站前缀，调用方已算好）。 */
  nickname: string
  /** 新凭据的到期时刻（毫秒），转写到原卡时一起更新。 */
  expiresAtMs?: number
  /** 新凭据是否可续期。 */
  refreshable?: boolean
}

/** 同名重复卡的展示名后缀（用户一眼能看出「这张是重复的」）。 */
const DUPLICATE_SUFFIX = '（重复，已停用）'

/**
 * 执行一次同账号去重。**永不抛错**（登录已成功，去重失败不得改写结论）。
 */
export async function dedupeMinimaxAccount(
  deps: MinimaxDedupDeps,
  args: MinimaxDedupArgs,
): Promise<{ outcome: MinimaxDedupOutcome; retainedAccountId?: string }> {
  const identity = typeof args.identity === 'string' ? args.identity : ''
  if (identity.length === 0) return { outcome: 'skipped-no-identity' }

  let existingId = ''
  try {
    existingId = await deps.pool.findAccountIdByIdentityField(args.providerId, 'user_id', identity, args.newAccountId)
  } catch (error) {
    // ⚠️ 读不到池 ≠ 没有重复 ⇒ 绝不做任何破坏性动作（删号/清凭据都是不可逆的）。
    deps.logger?.warn?.(
      `[jet-hub] ${args.providerId} 查重失败（按 user_id 读账号池）`
      + `⇒ 本次不做去重、照常回填：${String(error)}`,
    )
    return { outcome: 'error' }
  }
  if (existingId.length === 0 || existingId === args.newAccountId) {
    return { outcome: 'skipped-not-duplicate' }
  }

  const existing = deps.pool.findAccount?.(existingId)
  /**
   * ⚠️ **看不到那条条目时按「启用」处理**（保守方向）：
   * 反转腿会把「老卡」停用，如果其实它本来就没有条目，那一步等于空操作；
   * 而走正常腿最多只是多停用一张我们自己刚建的重复卡 —— 两个方向都不会
   * 让用户少一张可用卡。反过来（默认当成「已停用」）会让**每次**重复登录都
   * 把新卡留在启用态，等于没修。
   */
  const existingDisabled = existing !== undefined && existing.enabled === false

  if (existingDisabled) {
    /**
     * 反转腿（officeace 2026-10-17 的 P2）：用户**手动停用**过这个号，
     * 现在又重新登录 ⇒ 语义是「他想让这个号可用」。
     * 凭据本来就落在新卡（最新鲜的那份），故**不清、不搬**。
     */
    try {
      await deps.pool.updateAccount(existingId, {
        nickname: `${args.nickname}${DUPLICATE_SUFFIX}`,
        enabled: false,
      })
      await deps.pool.updateAccount(args.newAccountId, { nickname: args.nickname, enabled: true })
    } catch (error) {
      deps.logger?.warn?.(
        `[jet-hub] ${args.providerId} 重复账号反转失败（原卡 ${existingId} 已被停用）：${String(error)}`,
      )
      return { outcome: 'error', retainedAccountId: args.newAccountId }
    }
    deps.logger?.warn?.(
      `[jet-hub] ${args.providerId} 该账号（user_id=${identity}）的原卡片 ${existingId}`
      + `**已被用户停用** ⇒ 改为「新卡 ${args.newAccountId} 可用、原卡标重复并停用」`,
    )
    return { outcome: 'reversed', retainedAccountId: args.newAccountId }
  }

  /**
   * 正常腿：把**新鲜凭据原样搬到保留卡**，再清掉重复卡的凭据。
   *
   * ⚠️ 顺序不可颠倒：先搬成功才敢清（清是不可逆的，而搬失败时重复卡自己那份
   * 凭据就是唯一的活凭据）。
   */
  const retainedRefName = existing?.credentialRef ?? ''
  let handedOver = false
  if (retainedRefName.length > 0 && retainedRefName !== args.newCredentialRefName) {
    try {
      const fresh = await deps.credentials.resolve(credentialRef(args.newCredentialRefName))
      if (fresh !== undefined) {
        await deps.credentials.set(credentialRef(retainedRefName), fresh.value)
        handedOver = true
      }
    } catch (error) {
      deps.logger?.warn?.(
        `[jet-hub] ${args.providerId} 重复账号：新凭据转写回 ${retainedRefName} 失败`
        + `（保留重复条目自己的凭据，不做不可逆清理）：${String(error)}`,
      )
    }
  }

  try {
    await deps.pool.updateAccount(args.newAccountId, {
      nickname: `${args.nickname}${DUPLICATE_SUFFIX}`,
      enabled: false,
    })
  } catch (error) {
    deps.logger?.warn?.(
      `[jet-hub] ${args.providerId} 重复账号：停用新条目 ${args.newAccountId} 失败：${String(error)}`,
    )
  }

  if (!handedOver) {
    // 没搬成就**不清**凭据（唯一活凭据），但仍如实登记：此时会出现两条续期链。
    deps.logger?.warn?.(
      `[jet-hub] ${args.providerId} 重复账号：未能把新凭据转写到保留卡`
      + `（${existingId}）⇒ 该上游账号当前有两条续期链，下一轮续期可能互相作废`,
    )
    return { outcome: 'duplicate', retainedAccountId: existingId }
  }

  // 保留卡承接「可续期 + 新到期时刻」。
  try {
    await deps.pool.updateAccount(existingId, {
      refreshable: args.refreshable ?? true,
      ...args.expiresAtMs === undefined ? {} : { expiresAt: args.expiresAtMs },
    })
  } catch (error) {
    deps.logger?.warn?.(
      `[jet-hub] ${args.providerId} 重复账号：更新保留卡 ${existingId} 的到期/续期标记失败：${String(error)}`,
    )
  }

  // 最后才清重复卡的凭据（此时它已停用、且新凭据已在保留卡上）。
  try {
    await deps.credentials.unset(credentialRef(args.newCredentialRefName))
  } catch (error) {
    deps.logger?.warn?.(
      `[jet-hub] ${args.providerId} 重复账号：清重复凭据 ${args.newCredentialRefName} 失败`
      + `（无害：那张卡已停用、不参与选号；只是它若被续期会白失败一次）：${String(error)}`,
    )
  }

  deps.logger?.warn?.(
    `[jet-hub] ${args.providerId} 该账号（user_id=${identity}）已存在于 ${existingId}，`
    + `新条目 ${args.newAccountId} 已自动停用（不参与选号），凭据已转写到保留卡`,
  )
  return { outcome: 'duplicate', retainedAccountId: existingId }
}
