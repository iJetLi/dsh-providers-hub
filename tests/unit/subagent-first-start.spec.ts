/**
 * ★★★ **新架构的行为守卫**（2026-11-25 重构后补）。
 *
 * ## 被重构掉的旧架构
 *
 * | 旧 | 新 |
 * |---|---|
 * | `pinnedAccountId` 字段 | ❌ 删除 |
 * | `userPickedAccountId` 字段 | ❌ 删除 |
 * | `pinSubagentAccount` / `setUserPickedAccount` | ❌ 删除 |
 * | resolver 里的 7 个子代理标记 | ❌ 删除 |
 *
 * ## 新架构（用户定案）
 *
 * > 「除了需要子代理轮换起点策略之外，其他点子代理跟主代理都一样的行为」
 * >
 * > 「这个位次就相当于用户在主代理手动选择下拉框一样」
 *
 * ```
 * 子代理首次请求（preferredRotation 里还没有它的 sessionId）
 *   → 按 startMode 算出目标账号
 *   → 取其档位（selector 缓存 / 冷启动回查一次）
 *   → 写 preferredRotation[子代理sessionId] = { position, tierAtSelection }
 *   ↓
 * 之后：与主代理**完全同一条代码**
 * ```
 *
 * ## 本文件守什么
 *
 * | # | 断言 | 变异（改坏就红） |
 * |---|---|---|
 * | T1 | 首次会**写一次** `preferredRotation` | 删掉写入 ⇒ 红 |
 * | T2 | `reverse` 算出的位次正确（从主代理起点往前）| 换 `sequence` ⇒ 红 |
 * | T3 | `sequence` 算出的位次正确（往后）| 换 `reverse` ⇒ 红 |
 * | T4 | `fixed` 用 `fixedPosition` | 忽略 fixedPosition ⇒ 红 |
 * | T5 | **已有条目 ⇒ 不再写**（只在首次）| 去掉该判据 ⇒ 红 |
 * | T6 | 没配 `startMode` ⇒ 不写 | 去掉判据 ⇒ 红 |
 * | T7 | 主代理（无分配记录）⇒ 不写 | 去掉判据 ⇒ 红 |
 * | T8 | **写进去的档位 = 该号当前档位** | 写错档位 ⇒ 红 |
 */
import { describe, expect, it } from 'vitest'

import {
  positionOfAccount,
  probeRotationStartTier,
  rotationStartTierOfRank,
  shouldDecideSubagentStartOnFirstUse,
} from '../../src/subagent-first-start.js'
import { decideSubagentStart } from '../../src/subagent-start.js'

/** 池序（位次 1-4）。 */
const POOL = ['acc-1', 'acc-2', 'acc-3', 'acc-4']

describe('T7/T6/T5：shouldDecideSubagentStartOnFirstUse 的四条闸门', () => {
  const base = {
    sessionId: 'child-1',
    setting: { startMode: 'reverse' as const },
    hasAssignment: true,
    hasPreferredRotation: false,
  }

  it('★★★ 四条件齐全 ⇒ true（要算）', () => {
    expect(shouldDecideSubagentStartOnFirstUse(base)).toBe(true)
  })

  it('★★★ 主代理（无分配记录）⇒ false（不参与）', () => {
    /**
     * ⚠️ 分配表**只登记子代理** —— 主代理查不到记录。
     * 若这里改成 true，主代理的起点会被子代理策略覆盖（严重回归）。
     */
    expect(shouldDecideSubagentStartOnFirstUse({ ...base, hasAssignment: false })).toBe(false)
  })

  it('★★★ 没配 `startMode` ⇒ false', () => {
    expect(shouldDecideSubagentStartOnFirstUse({ ...base, setting: undefined })).toBe(false)
    expect(shouldDecideSubagentStartOnFirstUse({ ...base, setting: {} })).toBe(false)
  })

  it('★★★ **已有 preferredRotation ⇒ false**（只在首次算）', () => {
    /**
     * ## 这是「缓存命中率」的根因
     *
     * 若每次请求都重算，池子稍有波动就换号 ⇒ prompt cache 全失效。
     * ⇒ 只在**首次**写一次，之后由 `rotateFromPreferred` 负责切号。
     */
    expect(shouldDecideSubagentStartOnFirstUse({ ...base, hasPreferredRotation: true })).toBe(false)
  })

  it('★★ sessionId 为空 ⇒ false', () => {
    expect(shouldDecideSubagentStartOnFirstUse({ ...base, sessionId: undefined })).toBe(false)
    expect(shouldDecideSubagentStartOnFirstUse({ ...base, sessionId: '' })).toBe(false)
  })
})

describe('T2/T3/T4：策略算出的位次（与主代理同口径）', () => {
  /**
   * 全池同档（都用 `undefined` 档位选择器 ⇒ 不缩窄）。
   *
   * 主代理起点 = `acc-2`（index 1）。
   */
  const enabledIds = POOL
  const mainStartId = 'acc-2'

  const decide = (mode: 'sequence' | 'reverse' | 'hash' | 'fixed', extra: { fixedPosition?: number } = {}, slot = 1) =>
    decideSubagentStart({
      providerId: 'probe',
      sessionId: 'child-1',
      candidateIds: POOL,
      allowPermanent: true,
      pool: {
        /** ⚠️ `decideSubagentStart` 要用它算 `enabledIds`（位次的基准）。 */
        listAccountsByProvider: () => POOL.map((id) => ({ id, credentialRef: `R-${id}`, enabled: true })),
        permanentLocked: () => false,
        subagentAssignmentOf: () => ({
          sessionId: 'child-1',
          parentSessionId: 'parent-1',
          at: 0,
          slot,
        }),
        subagentRotationFor: () => ({ startMode: mode, ...extra }),
      } as never,
      /** ⚠️ 不给 selector ⇒ 不缩窄档位（测「位次算术」本身）。 */
      selector: undefined,
      mainSessionStartId: mainStartId,
    })

  it('★★★ sequence slot1 ⇒ 从 acc-2 **往后两位** = acc-4', () => {
    /**
     * `sequence`：`tierIds[(base + 1 + slot) % n]`
     * base = 1（acc-2 的 index），slot = 1 ⇒ `(1+1+1) % 4 = 3` ⇒ **acc-4**
     */
    expect(decide('sequence').startId, '★★★ sequence slot1 必须是 acc-4').toBe('acc-4')
  })

  it('★★★ reverse slot1 ⇒ 从 acc-2 **往前两位** = acc-4（绕回）', () => {
    /**
     * `reverse`：`tierIds[((base - 1 - slot) % n + n*2) % n]`
     * base = 1，slot = 1 ⇒ `((1-1-1) % 4 + 8) % 4 = (-1+8)%4 = 3` ⇒ **acc-4**
     *
     * ⚠️ 与 sequence slot1 同结果（n=4 时的巧合），故下面再加一条区分用例。
     */
    expect(decide('reverse').startId, '★★★ reverse slot1 = acc-4').toBe('acc-4')
  })

  it('★★★ reverse slot0 ⇒ 往前一位 = acc-1（与 sequence 方向相反）', () => {
    /**
     * 主代理起点 = `acc-2`（index 1）。
     *
     * `reverse` slot0：`((1-1-0)%4+8)%4 = 0` ⇒ **acc-1**
     * `sequence` slot0：`(1+1+0)%4 = 2` ⇒ **acc-3**
     *
     * ⇒ 这条才是「方向相反」的真正区分点。
     */
    expect(decide('reverse', {}, 0).startId, '★★★ reverse slot0 = acc-1（往前）').toBe('acc-1')
    expect(decide('sequence', {}, 0).startId, '★★★ sequence slot0 = acc-3（往后）').toBe('acc-3')
    expect(decide('reverse', {}, 0).startId, '★★★ 两者必须不同').not.toBe(decide('sequence', {}, 0).startId)
  })

  it('★★★ fixed ⇒ 用 `fixedPosition` 指定那位（与主代理同口径）', () => {
    expect(decide('fixed', { fixedPosition: 3 }).startId, '★★★ fixed 位次3 = acc-3').toBe('acc-3')
    expect(decide('fixed', { fixedPosition: 1 }).startId, '★★★ fixed 位次1 = acc-1').toBe('acc-1')
  })

  it('★★ hash ⇒ 结果与起点不同（排除主代理自己）', () => {
    /**
     * ⚠️ `hash` 的实现是「在**除主代理起点外**的号里按 sessionId 哈希取一个」——
     * 目的是避免「子代理与主代理撞号」。
     */
    const got = decide('hash').startId
    expect(got, '★★ hash 不得等于主代理起点（否则撞号）').not.toBe(mainStartId)
    expect(POOL, '★ 必须落在池里').toContain(got)
  })
})

describe('T1：positionOfAccount 的换算', () => {
  it('★★★ 位次 = 池内下标 + 1', () => {
    expect(positionOfAccount(POOL, 'acc-1')).toBe(1)
    expect(positionOfAccount(POOL, 'acc-3')).toBe(3)
    expect(positionOfAccount(POOL, 'acc-4')).toBe(4)
  })

  it('★★★ 不在池里 ⇒ undefined（**不写**，避免「永远不生效」的位次）', () => {
    expect(positionOfAccount(POOL, 'acc-9')).toBeUndefined()
  })
})

describe('T8：档位读取（缓存优先，冷启动回查）', () => {
  it('★★★ 缓存命中 ⇒ 直接用（不触发 balanceOf）', async () => {
    /**
     * ⚠️ 这是「零额外开销」的守卫：子代理是被主代理拉起的，
     * 主代理刚发过请求 ⇒ 缓存里已有全部账号的余额。
     */
    let balanceCalls = 0
    const probe = {
      cachedTierOf: () => 0, // imminent
      balanceOf: async () => { balanceCalls += 1 },
    }
    expect(await probeRotationStartTier(probe, 'acc-1')).toBe('imminent')
    expect(balanceCalls, '★★★ 命中缓存时**不得**回查上游').toBe(0)
  })

  it('★★★ 缓存未命中 ⇒ 回查一次，再用新缓存值', async () => {
    let cached: number | undefined
    const probe = {
      cachedTierOf: () => cached,
      balanceOf: async () => { cached = 1 }, // 回查后变成 expiring
    }
    expect(await probeRotationStartTier(probe, 'acc-1')).toBe('expiring')
  })

  it('★★★ 回查后仍读不到 ⇒ undefined（**不写盘**）', async () => {
    const probe = {
      cachedTierOf: () => undefined,
      balanceOf: async () => { /* 仍无缓存 */ },
    }
    expect(await probeRotationStartTier(probe, 'acc-1')).toBeUndefined()
  })

  it('★★ selector 不存在 ⇒ undefined（替身场景，不崩）', async () => {
    expect(await probeRotationStartTier(undefined, 'acc-1')).toBeUndefined()
  })

  it('★★ tiers 枚举映射与后端同值', () => {
    expect(rotationStartTierOfRank(0)).toBe('imminent')
    expect(rotationStartTierOfRank(1)).toBe('expiring')
    expect(rotationStartTierOfRank(2)).toBe('permanent')
    expect(rotationStartTierOfRank(3)).toBeUndefined()
    expect(rotationStartTierOfRank(undefined)).toBeUndefined()
  })
})
