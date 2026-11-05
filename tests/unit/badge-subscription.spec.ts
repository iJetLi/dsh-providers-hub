import { describe, expect, it } from 'vitest'
import {
  BALANCE_PLAN_LABEL,
  BADGE_PLAN_SELECTORS,
  PLAN_PACKAGE_PATTERN,
  badgePlanFor,
  badgePlanSelectorFor,
} from '../../src/badge-subscription.js'
import { QODER_PLAN_PACKAGE } from '../../src/qoder-credits.js'
import type { CreditBalance, CreditPackage } from '../../src/credits.js'

/**
 * 「用量徽标该不该显示订阅」判定表的回归。
 *
 * ## 判据的取舍（用户 2026-10-01 定：窗口 > 套餐包 > 积分）
 *
 * 只有 Cline 有**窗口式**订阅（5 小时 / 周 / 月 + 已用百分比），其余渠道里
 * 有些余额是**套餐包**（CodeBuddy 的 `Free Plan Subscription`、Qoder 的
 * 「套餐额度」、ZCode 的 plan 桶）。本文件锁的就是这张表，正反例都要有：
 *
 * ⚠️ **反例比正例更重要**：`Bonus Pack`（拉新权益）、`国内运营裂变包`、
 * Loomy 的「每日赠送」都是**发放型**权益，把它们认成订阅会让用户去核对一个
 * 并不存在的订阅 —— 比不显示订阅更糟。
 */

/** 构造一个资源包（默认有效）。 */
function pkg(name: string, remaining: number, total = remaining, extra: Partial<CreditPackage> = {}): CreditPackage {
  return {
    name,
    unit: 'credits',
    remaining,
    total,
    used: Math.max(0, total - remaining),
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    ...extra,
  }
}

/** 构造余额。 */
function balance(packages: CreditPackage[], total?: number): CreditBalance {
  return {
    total: total ?? packages.reduce((sum, item) => sum + item.remaining, 0),
    packages,
    expiredTotal: 0,
  }
}

describe('套餐判定表', () => {
  it('登记了 5 个渠道：两个 buddy、两个 Qoder、ZCode', () => {
    expect(Object.keys(BADGE_PLAN_SELECTORS).sort()).toEqual(['buddy', 'qoder', 'qodercn', 'workbuddy', 'zcode'])
  })

  it('两个 buddy 共用「包名窄正则」这条规则', () => {
    expect(badgePlanSelectorFor('buddy')).toBe(badgePlanSelectorFor('workbuddy'))
    expect(badgePlanSelectorFor('buddy')?.kind).toBe('package')
  })

  it('两个 Qoder 共用「包名 === 套餐额度」这条规则', () => {
    expect(badgePlanSelectorFor('qoder')).toBe(badgePlanSelectorFor('qodercn'))
    expect(badgePlanSelectorFor('qoder')?.kind).toBe('package')
  })

  it('ZCode 是「整个余额即套餐」', () => {
    expect(badgePlanSelectorFor('zcode')?.kind).toBe('balance')
  })

  it('未登记的渠道一律视为没有订阅（默认关闭）', () => {
    for (const provider of ['codearts', 'lobsterai', 'trae', 'loomy', 'raccoon', 'minimax', 'cline', '', 'llm-pi-ai']) {
      expect(badgePlanSelectorFor(provider), provider).toBeUndefined()
      expect(badgePlanFor(provider, balance([pkg('Free Plan Subscription', 100)])), provider).toBeNull()
    }
  })

  it('窄正则：发放型权益**不得**命中', () => {
    // 实测的服务端包名（见 src/credits.ts 与 buddy-balance-rank.ts 的注释）
    expect(PLAN_PACKAGE_PATTERN.test('Free Plan Subscription')).toBe(true)
    expect(PLAN_PACKAGE_PATTERN.test('CodeBuddy个人体验版')).toBe(true)
    expect(PLAN_PACKAGE_PATTERN.test('Bonus Pack')).toBe(false)
    expect(PLAN_PACKAGE_PATTERN.test('国内运营裂变包')).toBe(false)
    expect(PLAN_PACKAGE_PATTERN.test('拉新权益包')).toBe(false)
    expect(PLAN_PACKAGE_PATTERN.test('每日登录奖励')).toBe(false)
  })

  it('Qoder 的套餐包名取自 qoder-credits 的常量（不另抄一份字面量）', () => {
    expect(QODER_PLAN_PACKAGE).toBe('套餐额度')
    expect(badgePlanSelectorFor('qoder')?.kind === 'package'
      && (badgePlanSelectorFor('qoder') as { matches: (name: string) => boolean }).matches(QODER_PLAN_PACKAGE)).toBe(true)
  })
})

describe('badgePlanFor', () => {
  it('buddy：命中 Plan 包时给出该包的读数', () => {
    const plan = badgePlanFor('buddy', balance([
      pkg('Bonus Pack', 20, 100),
      pkg('Free Plan Subscription', 300, 500, { deductionEndTime: 1_700_000_000_000 }),
    ]))
    expect(plan).toEqual({
      name: 'Free Plan Subscription',
      remaining: 300,
      total: 500,
      unit: 'credit',
      deductionEndTime: 1_700_000_000_000,
    })
  })

  it('buddy：只有 Bonus Pack 时**不**算订阅（回落到积分）', () => {
    expect(badgePlanFor('buddy', balance([pkg('Bonus Pack', 250, 250)]))).toBeNull()
  })

  it('多个套餐包时取剩余最大者', () => {
    const plan = badgePlanFor('workbuddy', balance([
      pkg('Free Plan', 10, 100),
      pkg('Team Plan Subscription', 900, 1000),
    ]))
    expect(plan?.name).toBe('Team Plan Subscription')
    expect(plan?.remaining).toBe(900)
  })

  it('已失效的套餐包不算数（回落到积分）', () => {
    expect(badgePlanFor('buddy', balance([pkg('Free Plan Subscription', 0, 500, { active: false })]))).toBeNull()
  })

  it('Qoder：套餐额度为 0 时仍然如实给出 0（不伪装成「没有套餐」）', () => {
    const plan = badgePlanFor('qoder', balance([pkg('套餐额度', 0, 300), pkg('资源包', 100, 100)]))
    expect(plan?.name).toBe('套餐额度')
    expect(plan?.remaining).toBe(0)
  })

  it('ZCode：整个余额折算成一条「套餐」，单位随包（token）', () => {
    const plan = badgePlanFor('zcode', balance([
      pkg('GLM-5.2', 50_000_000, 60_000_000, { unit: 'token' }),
      pkg('DeepSeek-V4', 44_539_275, 40_000_000, { unit: 'token' }),
    ], 94_539_275))
    expect(plan).toEqual({
      name: BALANCE_PLAN_LABEL,
      remaining: 94_539_275,
      total: 100_000_000,
      unit: 'token',
    })
  })

  it('ZCode：失效桶不计入套餐总额', () => {
    const plan = badgePlanFor('zcode', balance([
      pkg('GLM-5.2', 50, 100, { unit: 'token' }),
      pkg('过期桶', 7, 999, { unit: 'token', active: false }),
    ], 50))
    expect(plan?.total).toBe(100)
    expect(plan?.remaining).toBe(50)
  })

  it('ZCode：总额不可得时退回剩余值（避免显示成 x / 0）', () => {
    const plan = badgePlanFor('zcode', balance([pkg('GLM-5.2', 0, 0, { unit: 'token' })], 0))
    expect(plan).toEqual({ name: BALANCE_PLAN_LABEL, remaining: 0, total: 0, unit: 'token' })
  })

  it('余额查不到（null）时一律返回 null（与「余额为 0」区分开）', () => {
    for (const provider of ['buddy', 'qoder', 'zcode']) {
      expect(badgePlanFor(provider, null), provider).toBeNull()
    }
  })

  /**
   * ⚠️ 单位**下发前就归一**（2026-10-03 改）。
   *
   * 旧断言是「缺失时按空串走」—— 那时客户端按原值分组，空串与 `credits` 会各成
   * 一组，渲染出两个「积分」。现在宿主与客户端都归一到展示口径，故这里断言
   * `'credit'`：它与 `credits` / `''` / `USD` 是同一个语义等价类。
   */
  it('单位缺失 / 同义异拼一律归一到 credit（调用方 unitLabel 显示「积分」）', () => {
    expect(badgePlanFor('zcode', balance([pkg('桶', 5, 10, { unit: '' })], 5))?.unit).toBe('credit')
    expect(badgePlanFor('zcode', balance([pkg('桶', 5, 10, { unit: 'credits' })], 5))?.unit).toBe('credit')
    expect(badgePlanFor('zcode', balance([pkg('桶', 5, 10, { unit: 'USD' })], 5))?.unit).toBe('credit')
    // 只有 token 是另一个等价类（与积分不可折算）
    expect(badgePlanFor('zcode', balance([pkg('桶', 5, 10, { unit: 'token' })], 5))?.unit).toBe('token')
  })
})

/**
 * `totalKnown` 透传（2026-11-05 审计 P3-16）。
 *
 * 套餐区（`planGroupsOf` → `readingOf`）早已按 `totalKnown === false` 隐藏分母，
 * 但 `badgePlanFor` 从不下发该字段 ⇒ 那条分支是**死代码**（变异全绿）。
 * 本组用例钉住「两种形态都必须透传，且缺省时**不得**凭空多出这个键」。
 */
describe('badgePlanFor：totalKnown 透传', () => {
  it('★ package 形态（buddy）：包 totalKnown:false ⇒ 读数 totalKnown:false', () => {
    const plan = badgePlanFor('buddy', balance([
      pkg('Free Plan Subscription', 100, 100, { totalKnown: false }),
    ], 100))
    expect(plan).toMatchObject({ totalKnown: false, remaining: 100 })
  })

  it('★ balance 形态（zcode）：任一有效包 totalKnown:false ⇒ 读数 totalKnown:false', () => {
    const plan = badgePlanFor('zcode', balance([pkg('桶', 100, 100, { totalKnown: false })], 100))
    expect(plan).toMatchObject({ totalKnown: false })
  })

  it('★ 对照：缺省 ⇒ 不下发该字段（面板仍显示 x / y）', () => {
    const plan = badgePlanFor('buddy', balance([pkg('Free Plan Subscription', 100)], 100))
    expect(plan).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(plan, 'totalKnown')).toBe(false)
  })
})
