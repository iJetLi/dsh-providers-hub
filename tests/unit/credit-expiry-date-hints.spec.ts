/**
 * 卡片分段行的日期提示（`expiryDateHints` + `expirySplitParts` 第 4 参）。
 *
 * 报障（2026-11-14）：Qoder 卡片显示「长期 400 · 临期 192（7 天 7 小时）」，倒计时属于
 * 套餐额度的刷新日，而资源包的到期日在卡片上完全看不到 ⇒ 被读成「资源包到期时间算错了」。
 */
import { describe, expect, it } from 'vitest'
import {
  expiryDateHints,
  expirySplitParts,
  formatMonthDay,
  splitCreditsByExpiry,
} from '../../plugin-src/client/credit-expiry.js'

const DAY = 86_400_000
const NOW = new Date(2026, 10, 14, 3, 40).getTime() // 本地时间 2026-11-14 03:40

function pkg(name: string, remaining: number, end?: number, extra: Record<string, unknown> = {}) {
  return {
    name, unit: 'credits', remaining, total: remaining, used: 0, active: true,
    cycleStartTime: '', cycleEndTime: '', expiredTime: '',
    ...end !== undefined ? { deductionEndTime: end } : {},
    ...extra,
  }
}

function line(packages: ReturnType<typeof pkg>[], withHints = true) {
  const split = splitCreditsByExpiry(packages, 15, NOW)
  const hints = withHints ? expiryDateHints(packages, 15, NOW) : undefined
  return expirySplitParts(split, String, NOW, hints)
    .map((p: { text: string; countdown?: string }) => (p.countdown ? `${p.text}（${p.countdown}）` : p.text))
    .join(' · ')
}

describe('卡片分段行的日期提示', () => {
  const planEnd = new Date(2026, 10, 21, 11, 1).getTime()
  const qoder = [
    pkg('套餐额度', 192, planEnd),
    pkg('资源包', 100, new Date(2026, 11, 13, 12).getTime()),
    pkg('资源包', 100, new Date(2026, 11, 7, 12).getTime()),
    pkg('资源包', 100, new Date(2026, 11, 10, 12).getTime()),
    pkg('资源包', 100, new Date(2026, 11, 11, 12).getTime()),
  ]

  it('报障原样：长期带最早到期日，临期点名是套餐刷新', () => {
    expect(line(qoder)).toBe('长期 400（最早 12月7日到期） · 临期 192（套餐 11月21日刷新，7 天 7 小时后）')
  })

  it('不传提示 ⇒ 与改动前逐字一致（其余调用方不受影响）', () => {
    expect(line(qoder, false)).toBe('长期 400 · 临期 192（7 天 7 小时）')
  })

  it('临期最早那批不是套餐 ⇒ 照旧只给倒计时；长期仍带日期', () => {
    const packages = [pkg('赠包', 50, NOW + 3 * DAY), pkg('赠包', 80, NOW + 40 * DAY)]
    expect(line(packages)).toBe(`长期 80（最早 ${formatMonthDay(NOW + 40 * DAY, NOW)}到期） · 临期 50（3 天 0 小时）`)
  })

  it('同一时刻既有套餐又有别的包 ⇒ 不说是套餐刷新', () => {
    const packages = [pkg('套餐额度', 10, planEnd), pkg('资源包', 20, planEnd)]
    expect(expiryDateHints(packages, 15, NOW)?.expiringIsPlanRefresh).toBe(false)
  })

  it('到期未知 / 永久 / 已用完 / 未激活的包不参与日期', () => {
    const packages = [
      pkg('资源包', 400, undefined, { expiryUnknown: true }),
      pkg('长包', 0, NOW + 30 * DAY),
      pkg('长包', 5, NOW + 20 * DAY, { active: false }),
    ]
    expect(expiryDateHints(packages, 15, NOW)).toEqual({ earliestLongTermAt: null, expiringIsPlanRefresh: false })
    expect(line(packages)).toBe('到期未知 400')
  })

  it('跨年日期带年份', () => {
    expect(formatMonthDay(new Date(2027, 0, 3).getTime(), NOW)).toBe('2027年1月3日')
    expect(formatMonthDay(new Date(2026, 11, 7).getTime(), NOW)).toBe('12月7日')
  })
})
