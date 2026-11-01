/**
 * 已作废额度**不得**被算进「临期」（2026-11-02 修）。
 *
 * 背景：TRAE / Qoder 的 `active` 是**硬编码 true**（从不反映是否过期），
 * 所以「`deductionEndTime` 已过、`active` 仍 true、`remaining > 0`」的包一定会出现。
 * 旧行为：它被累加进 `expiring` ⇒ 面板显示「临期 7」却**没有倒计时**
 * （`earliestExpiringAt` 只取未来时刻），而同一个包的标签/提示写「已过期」——
 * 同一条数据两个说法，且那个 7 根本扣不到。
 *
 * 修法（**不改数据语义**）：`expiring` 里仍然包含它（三档合计 === `total` 是硬
 * 不变量，且后端/聚合也按「窗口内」处理这类包），另记一个 `expired` **子集**，
 * 展示层用 `expiring - expired` 显示「临期」、剩下的单独写「已过期」。
 */
import { describe, expect, it } from 'vitest'
import {
  expiryBucketLabel,
  expirySplitParts,
  formatExpiryHint,
  formatExpirySplitLine,
  splitCreditsByExpiry,
} from '../../plugin-src/client/credit-expiry.js'

const NOW = Date.parse('2026-11-01T12:00:00+08:00')
const DAY = 86_400_000

const expiredPkg = { name: '已过期包', remaining: 7, total: 10, active: true, deductionEndTime: NOW - 3 * DAY }
const soonPkg = { name: '临期包', remaining: 300, total: 300, active: true, deductionEndTime: NOW + 3 * DAY }
const farPkg = { name: '长期包', remaining: 500, total: 500, active: true, deductionEndTime: NOW + 300 * DAY }
const permPkg = { name: '永久积分', remaining: 1000, total: 1000, active: true }

describe('已作废额度（issue：面板「临期 7」但标签写「已过期」）', () => {
  it('★ 只作废包：expiring 仍含它（保守恒），expired 标出子集', () => {
    const split = splitCreditsByExpiry([expiredPkg], 30, NOW)
    expect(split.expiring).toBe(7)
    expect(split.expired).toBe(7)
  })

  it('★★ 展示行：写「已过期 7」而不是「临期 7」', () => {
    const split = splitCreditsByExpiry([expiredPkg], 30, NOW)
    const parts = expirySplitParts(split, (v) => String(v), NOW)
    expect(parts.map((p) => p.text)).toEqual(['已过期 7'])
    // 与包标签/提示同口径（同一条数据不再两个说法）
    expect(expiryBucketLabel(expiredPkg, 30, NOW)).toBe('已过期')
    expect(formatExpiryHint(expiredPkg, 30, NOW)).toContain('已过期')
  })

  it('★ 混合：临期只显示还能用的 300，已过期单独 7', () => {
    const split = splitCreditsByExpiry([permPkg, farPkg, soonPkg, expiredPkg], 30, NOW)
    const parts = expirySplitParts(split, (v) => String(v), NOW)
    const byKey = Object.fromEntries(parts.map((p) => [p.key, p.text]))
    expect(byKey.expiring).toBe('临期 300')
    expect(byKey.expired).toBe('已过期 7')
    // 三档 + 已过期 === total（守恒不变量没被破坏）
    expect(split.permanent + split.longTerm + split.expiring).toBe(1807)
    expect(byKey.permanent).toBe('永久 1000')
    expect(byKey.longTerm).toBe('长期 500')
  })

  it('★ 没有已作废额度时**不出现** expired 键（不制造恒 0 噪音）', () => {
    const split = splitCreditsByExpiry([permPkg, soonPkg], 30, NOW)
    expect('expired' in split).toBe(false)
    const line = formatExpirySplitLine(split, (v) => String(v))
    expect(line).not.toContain('已过期')
  })

  it('★ 纯文本行（tooltip 用）同样拆开', () => {
    const split = splitCreditsByExpiry([soonPkg, expiredPkg], 30, NOW)
    const line = formatExpirySplitLine(split, (v) => String(v))
    expect(line).toBe('临期 300 · 已过期 7')
  })

  it('★ 全部作废 ⇒ 只剩「已过期」段（不显示空的「临期 0」）', () => {
    const split = splitCreditsByExpiry([expiredPkg, { ...expiredPkg, remaining: 3 }], 30, NOW)
    const parts = expirySplitParts(split, (v) => String(v), NOW)
    expect(parts.map((p) => p.text)).toEqual(['已过期 10'])
  })
})
