/**
 * `src/promotion-tooltip.ts` 的两条**核心判据**的行为级用例。
 *
 * ⚠️ 为什么单开这个文件（2026-11-17 双审计）：
 * 正向审计 + 对抗审计 + 我自己的变异都实测到 —— 把 `validUntil` 的 `- 1`（端点不含）
 * 去掉，或把 `formatPromotionDay` 的 `timeZone` 腿改成恒 UTC，**原先全部相关 spec 仍全绿**
 * （无牙）。那两条腿正是这个模块存在的理由（模块头判据 2 / 3），
 * 一个能静默退化的判据等于没有。这里各钉一条**精确到日**的断言。
 *
 * 断言必须落在**具体日期**上，不能只断言「含年份关键词」：
 * 只测「含 2026」时，把时区腿删掉照样绿（本仓复发过多次这种假绿）。
 */

import { describe, expect, it } from 'vitest'

import { formatPromotionDay, promotionLifetimeText } from '../../src/promotion-tooltip.js'
import type { ModelPromotion } from '../../src/model-promotions.js'

/** 一个最小活动：只带 schedule，其余字段够类型即可。 */
function promotionWith(schedule: ModelPromotion['schedule']): ModelPromotion {
  return {
    id: 'off_peak:test:m',
    source: 'promotion',
    modelIds: ['m'],
    badge: { label: '限时折扣' },
    schedule,
    timeDeclared: true,
    standingEligible: false,
    priority: 1,
  }
}

describe('formatPromotionDay：日期必须按**上游声明的时区**读（模块头判据 2）', () => {
  it('★★ 同一时刻在不同时区落到不同日历日 —— 删掉时区腿就会变红', () => {
    // 2026-11-01T00:00:00Z：
    //   America/Los_Angeles = 2026-10-31（-07:00，跨日）
    //   UTC                = 2026-11-01
    //   Asia/Shanghai      = 2026-11-01 08:00（同日）
    const ms = Date.parse('2026-11-01T00:00:00Z')
    const la = formatPromotionDay(ms, 'en-US', 'America/Los_Angeles')
    const utc = formatPromotionDay(ms, 'en-US', 'UTC')
    // 精确到日：LA 是 Oct 31，UTC 是 Nov 1 ⇒ 两者必须不同，且各含正确的月份/日。
    expect(la).toContain('Oct')
    expect(la).toContain('31')
    expect(utc).toContain('Nov')
    expect(utc).toContain('1')
    expect(la).not.toBe(utc)
  })

  it('★ 非法时区不许带走整条（退回 ISO 日期，不抛）', () => {
    const ms = Date.parse('2026-11-01T12:00:00Z')
    const out = formatPromotionDay(ms, 'en-US', 'Not/AZone')
    expect(out).toBe('2026-11-01')
  })
})

describe('promotionLifetimeText：validUntil 端点**不含**（模块头判据 3）', () => {
  it('★★ validUntil = 某日 00:00Z ⇒ 展示**前一天**（减 1 毫秒的真实效果）', () => {
    // 上游把「活动次日零点」写进 validUntil：11-01T00:00:00Z。
    // 减 1ms ⇒ 10-31T23:59:59.999Z ⇒ 按 UTC 读是 Oct 31。
    // 若删掉 `- 1`，就会显示 Nov 1 —— 多说一天。
    const promotion = promotionWith({
      timezone: 'UTC',
      validUntil: Date.parse('2026-11-01T00:00:00Z'),
    })
    const text = promotionLifetimeText(promotion, 'en-US')
    expect(text).toBeDefined()
    expect(text).toContain('Oct')
    expect(text).toContain('31')
    expect(text).not.toContain('Nov')
  })

  it('★ 两端都在 ⇒ 用破折号连接，顺序 from – to', () => {
    const promotion = promotionWith({
      timezone: 'UTC',
      validFrom: Date.parse('2026-10-01T00:00:00Z'),
      // 端点不含 ⇒ 展示到 10-31
      validUntil: Date.parse('2026-11-01T00:00:00Z'),
    })
    const text = promotionLifetimeText(promotion, 'en-US')
    expect(text).toContain('Oct 1')
    expect(text).toContain('Oct 31')
    expect(text).toContain('–')
  })

  it('只有一端 ⇒ 保留开区间的破折号', () => {
    const onlyFrom = promotionLifetimeText(
      promotionWith({ timezone: 'UTC', validFrom: Date.parse('2026-10-01T00:00:00Z') }),
      'en-US',
    )
    expect(onlyFrom).toBe('Oct 1, 2026 –')
    const onlyTo = promotionLifetimeText(
      promotionWith({ timezone: 'UTC', validUntil: Date.parse('2026-11-01T00:00:00Z') }),
      'en-US',
    )
    expect(onlyTo).toBe('– Oct 31, 2026')
  })

  it('两端都没有 ⇒ undefined（不写 title）', () => {
    expect(promotionLifetimeText(promotionWith({ timezone: 'UTC' }), 'en-US')).toBeUndefined()
    expect(promotionLifetimeText(promotionWith(undefined), 'en-US')).toBeUndefined()
  })
})
