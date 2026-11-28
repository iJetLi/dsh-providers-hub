/**
 * ★★ 「**已领取、但还没到生效时刻**」的额度展示（2026-10-23 实测）。
 *
 * ## 现象（用户报障原文）
 *
 * > 「我重启后用 zcode 领取显示 2 个成功 2 个已领取，**但是我查询额度后还是 0**」
 *
 * 截图里 ZCode 两行都是「**+500.00MToken 领取成功**」，而额度查询是 0。
 *
 * ## 真因（不是缺陷）
 *
 * 上游 `billing/balance` 对「已领未生效」的账号返回（**实测原文**）：
 *
 * ```json
 * { "balances": [],
 *   "plans": [{ "plan_id": "zcode-v3-start-plan-1024", "name": "ZCode 1024 Dev Day",
 *               "status": "active",
 *               "starts_at": 1792756800, "ends_at": 1792976400,
 *               "entitlements": [
 *                 { "show_name": "GLM-5.3-Flash", "unit_type": "token",
 *                   "grant_units": 300000000, "effective_at": 1792767600 },
 *                 { "show_name": "GLM-5.3",       "unit_type": "token",
 *                   "grant_units": 200000000, "effective_at": 1792767600 } ] }] }
 * ```
 *
 * ⇒ 额度**已锁定在 `plans` 里**，但 `balances` 桶**还是空的** ——
 * 桶要等 `effective_at`（实测 **23:00**）才建。官方成功弹窗的文案也正是
 * 「**将于 … 生效**」。
 *
 * ## 本文件锁住两件事
 *
 * 1. **解析**：`pendingPlansOf` 只认「`status:active` + `effective_at` 未到」，
 *    且额度**按同 `unit_type` 求和**（5 亿 = 3 亿 + 2 亿）。
 * 2. **展示**：`buildZcodeBalance` 把它做成**独立包**，`remaining/total` 都给 0
 *    （此刻确实不能用），但带上**生效时刻** ——
 *    ⚠⚠ **绝不能**把它并进 `remaining`：那会让折算层判成「有额度」⇒
 *    **在生效前就把渠道派发出去**（必然失败：额度还不存在）。
 */
import { describe, expect, it } from 'vitest'

import { pendingPlansOf } from '../../src/zcode-upstream.js'
import { buildZcodeBalance } from '../../src/provider-credits.js'
import type { ZcodeBalanceResult } from '../../src/zcode-upstream.js'

/** 实测的 1024 计划（`effective_at` = 2026-10-23 23:00 UTC+8 = 1792767600）。 */
const PLAN_1024 = {
  plan_id: 'zcode-v3-start-plan-1024',
  name: 'ZCode 1024 Dev Day',
  status: 'active',
  starts_at: 1792756800,
  ends_at: 1792976400,
  entitlements: [
    { show_name: 'GLM-5.3-Flash', unit_type: 'token', grant_units: 300000000, effective_at: 1792767600 },
    { show_name: 'GLM-5.3', unit_type: 'token', grant_units: 200000000, effective_at: 1792767600 },
  ],
}

/** 「现在」= 报障那一刻（21:19，尚未到 23:00）。 */
const NOW_BEFORE = 1792760340
/** 「现在」= 23:00 之后。 */
const NOW_AFTER = 1792767900

describe('★★ 解析：只认「active + effective_at 未到」', () => {
  it('★ 1024 计划：5 亿（3 亿 + 2 亿）+ 生效时刻 + 到期时刻', () => {
    const plans = pendingPlansOf([PLAN_1024], NOW_BEFORE)
    expect(plans).toHaveLength(1)
    const plan = plans[0]!
    expect(plan.planId).toBe('zcode-v3-start-plan-1024')
    expect(plan.name).toBe('ZCode 1024 Dev Day')
    // ★ 5 亿 = 3 亿（GLM-5.3-Flash）+ 2 亿（GLM-5.3）—— 只取第一条会少报 2 亿
    expect(plan.grantUnits).toBe(500_000_000)
    expect(plan.unitType).toBe('token')
    expect(plan.effectiveAt).toBe(1792767600)
    expect(plan.endsAt).toBe(1792976400)
  })

  it('★★ 已到生效时刻 ⇒ 不再计入（那时它已变成 balances 桶，不能重复算）', () => {
    expect(pendingPlansOf([PLAN_1024], NOW_AFTER)).toEqual([])
  })

  it('★ `status` 不是 `active` ⇒ 不计入（未激活/已作废的计划）', () => {
    for (const status of ['expired', 'cancelled', 'pending', undefined]) {
      expect(pendingPlansOf([{ ...PLAN_1024, status }], NOW_BEFORE)).toEqual([])
    }
  })

  it('★ 缺 `effective_at` ⇒ 不计入（无从判断「还没生效」就不猜）', () => {
    const plan = { ...PLAN_1024, entitlements: [{ grant_units: 300000000, unit_type: 'token' }] }
    expect(pendingPlansOf([plan], NOW_BEFORE)).toEqual([])
  })

  it('★ 单位不同的 entitlement 不混加（宁可少报，也不把 token 与积分加成一个数）', () => {
    const plan = {
      ...PLAN_1024,
      entitlements: [
        { unit_type: 'token', grant_units: 100, effective_at: 1792767600 },
        { unit_type: 'credit', grant_units: 7, effective_at: 1792767600 },
        { unit_type: 'token', grant_units: 5, effective_at: 1792767600 },
      ],
    }
    const plans = pendingPlansOf([plan], NOW_BEFORE)
    expect(plans[0]?.grantUnits).toBe(105)
    expect(plans[0]?.unitType).toBe('token')
  })

  it('★ 同一 plan 里混着已生效与未生效 ⇒ 只算未生效那部分', () => {
    const plan = {
      ...PLAN_1024,
      entitlements: [
        { unit_type: 'token', grant_units: 300000000, effective_at: 1792767600 },
        { unit_type: 'token', grant_units: 111, effective_at: 1792700000 },
      ],
    }
    expect(pendingPlansOf([plan], NOW_BEFORE)[0]?.grantUnits).toBe(300000000)
  })

  it('★ 垃圾输入 ⇒ 空数组（服务端数据不可信）', () => {
    expect(pendingPlansOf(undefined, NOW_BEFORE)).toEqual([])
    expect(pendingPlansOf(null, NOW_BEFORE)).toEqual([])
    expect(pendingPlansOf('x', NOW_BEFORE)).toEqual([])
    expect(pendingPlansOf([null, 42], NOW_BEFORE)).toEqual([])
  })
})

describe('★★ 展示：独立成包，且不污染「现在能用」的额度', () => {
  const baseResult = (pendingPlans: ZcodeBalanceResult['pendingPlans']): ZcodeBalanceResult => ({
    buckets: [],
    remaining: 0,
    total: 0,
    claimablePlans: [],
    pendingPlans,
  })

  it('★ 有桶 + 待生效 ⇒ 两个包：桶照旧，待生效独立一个', () => {
    const balance = buildZcodeBalance({
      buckets: [{
        showName: 'GLM-5.3',
        unitType: 'token',
        totalUnits: 3_000_000,
        remainingUnits: 3_000_000,
        usedUnits: 0,
        capabilities: ['model:glm-5.3'],
      }],
      remaining: 3_000_000,
      total: 3_000_000,
      claimablePlans: [],
      pendingPlans: [{
        planId: 'zcode-v3-start-plan-1024',
        name: 'ZCode 1024 Dev Day',
        grantUnits: 500_000_000,
        unitType: 'token',
        effectiveAt: 1792767600,
        endsAt: 1792976400,
      }],
    })
    expect(balance.packages).toHaveLength(2)
    const pending = balance.packages[1]!
    expect(pending.name).toBe('ZCode 1024 Dev Day')
    expect(pending.unit).toBe('token')
    // ⚠⚠ 此刻**不能用** ⇒ remaining 必须是 0（并进去会让折算层提前派发）
    expect(pending.remaining).toBe(0)
    expect(pending.total).toBe(500_000_000)
    // ⚠ `active: false` ⇒ 前端不把它算进「现在可用」
    expect(pending.active).toBe(false)
    // 生效时刻放在 cycleStartTime（前端据此显示「待生效」）
    expect(pending.cycleStartTime).toBe(new Date(1792767600 * 1000).toISOString())
  })

  it('★★ ★★ 总量**不含**待生效（`total` 仍是「现在能用」的汇总）', () => {
    const balance = buildZcodeBalance(baseResult([{
      planId: 'p1',
      name: '待生效',
      grantUnits: 500_000_000,
      unitType: 'token',
      effectiveAt: 1792767600,
    }]))
    // ⚠⚠ 这是**最关键**的一格：若 total 变成 5 亿 ⇒ 折算层判「有额度」⇒
    //         在 23:00 之前就把 zcode 派发出去（必然失败）。
    expect(balance.total).toBe(0)
  })

  /**
   * ⚠️⚠️ **契约已变（2026-11-28，Gitee IKYNB9）**：
   * 原来这条断言的是「`buckets: []` ⇒ 造一个 0/0 的『ZCode 免费额度』包」——
   * **那正是要修掉的缺陷**：上游一个桶都没下发时，界面显示「0 / 0」与「真的用光了」
   * 完全同形，而报障者两个号在 ZCode 官方客户端里都**能正常显示额度**
   * ⇒ 说明是本插件读不到，**不能判成 0**（本仓红线「查不到不得判死」）。
   */
  it('★★★ 无桶也无待生效 ⇒ 返回 null（查不到，不是 0）', () => {
    const balance = buildZcodeBalance(baseResult([]))
    expect(balance, '★ 上游一个桶都没下发时不得造 0/0 包').toBeNull()
  })

  it('★★ 有桶且无待生效 ⇒ 包数不变（不凭空多一个包）', () => {
    const balance = buildZcodeBalance({
      ...baseResult([]),
      buckets: [{
        showName: 'GLM-5.3',
        unitType: 'token',
        totalUnits: 100,
        usedUnits: 0,
        remainingUnits: 100,
        availableUnits: 100,
      }],
      remaining: 100,
      total: 100,
    })
    expect(balance).not.toBeNull()
    expect(balance!.packages).toHaveLength(1)
    expect(balance!.packages[0]?.name).toBe('GLM-5.3')
  })

  it('★ 旧凭据/旧调用方**没有** `pendingPlans` 字段 ⇒ 不得抛', () => {
    // ⚠ 这是**契约防御**：`pendingPlans` 是后加的字段，存量调用方构造的对象没有它
    const legacy = {
      buckets: [],
      remaining: 0,
      total: 0,
      claimablePlans: [],
    } as unknown as ZcodeBalanceResult
    expect(() => buildZcodeBalance(legacy)).not.toThrow()
    // ⚠️ 契约已变（IKYNB9）：零个桶 = 查不到 ⇒ null（不再造 0/0 包）。
    // 这条用例的原意是「缺 pendingPlans 字段不得抛」，`not.toThrow` 已覆盖它。
    expect(buildZcodeBalance(legacy)).toBeNull()
  })
})
