/**
 * 「分档窗口」弹窗的纯逻辑守卫（2026-11-19）。
 *
 * 覆盖 `plugin-src/client/credit-window-ui.js`——**不 import react**，
 * 故可行为断言（不是源码文本断言，那类断言有已知假绿形态）。
 */
import { describe, expect, it } from 'vitest'
import {
  clampImminent,
  computeCoverage,
  coverageLabel,
  describeWindowSource,
  parseWindowInput,
  windowRangeLabels,
} from '../../plugin-src/client/credit-window-ui.js'

const NOW = Date.UTC(2026, 10, 19, 12)
const DAY = 86_400_000
const pkg = (remaining, days) => ({
  name: 'p', unit: 'credits', remaining, total: remaining, used: 0, active: true,
  cycleStartTime: '', cycleEndTime: '', expiredTime: '',
  ...(days === undefined ? {} : { deductionEndTime: NOW + days * DAY }),
})

describe('parseWindowInput：输入框文本 → 天数', () => {
  it('★★ 空串 ≠ 0（空表示「用默认」，0 表示「关掉该档」）', () => {
    expect(parseWindowInput('')).toBeUndefined()
    expect(parseWindowInput('   ')).toBeUndefined()
    expect(parseWindowInput('0')).toBe(0)
  })

  it('★ 合法整数', () => {
    expect(parseWindowInput('5')).toBe(5)
    expect(parseWindowInput(' 15 ')).toBe(15)
    expect(parseWindowInput('36500')).toBe(36500)
  })

  it('⚠️ 非法输入一律 null（应拒绝保存）', () => {
    for (const raw of ['-1', 'abc', '5x', '5.5', '1e309', 'Infinity', 'NaN', '0x10', '36501']) {
      expect(parseWindowInput(raw), `${raw} 应非法`).toBeNull()
    }
    // 非字符串
    expect(parseWindowInput(undefined)).toBeNull()
    expect(parseWindowInput(5)).toBeNull()
  })
})

describe('clampImminent：临期 ≤ 短期', () => {
  it('★★ 倒挂时钳到短期，并标记 clamped', () => {
    expect(clampImminent(20, 10)).toEqual({ imminent: 10, clamped: true })
  })

  it('⚠️ 相等不算钳制', () => {
    expect(clampImminent(5, 5)).toEqual({ imminent: 5, clamped: false })
  })

  it('正常值原样', () => {
    expect(clampImminent(3, 15)).toEqual({ imminent: 3, clamped: false })
  })

  it('非法入参不炸', () => {
    expect(clampImminent(undefined, 10)).toEqual({ imminent: undefined, clamped: false })
    expect(clampImminent(5, undefined)).toEqual({ imminent: 5, clamped: false })
  })
})

describe('computeCoverage：按新窗口统计覆盖账号数', () => {
  const ACCOUNTS = [
    // 临期 + 永久
    { id: 'a1', packages: [pkg(447, 2), pkg(1600, 30)] },
    // 短期 + 永久
    { id: 'a2', packages: [pkg(500, 12), pkg(1600, 30)] },
    // 只有永久
    { id: 'a3', packages: [pkg(1600, 30)] },
    // 查不到余额
    { id: 'a4', packages: undefined },
  ]

  it('★★★ 永久档必须把 longTerm 也算进来（真实缺陷，2026-11-19 实测抓到）', () => {
    // ⚠️ `splitCreditsByExpiry` 把「30 天到期」归 `longTerm`，
    //    而「永久」语义是「不在窗口内到期」⇒ 必须 permanent + longTerm。
    //    漏这一格 ⇒ 预览的「永久」恒 0，且不会报任何错。
    const c = computeCoverage(ACCOUNTS, 15, 5, NOW)
    expect(c.permanentAccounts, '三个有 30 天包的账号都算永久').toBe(3)
    expect(c.permanentAmount).toBe(1600 * 3)
  })

  it('★★ 账号数按「该档有积分」计（可重叠）', () => {
    const c = computeCoverage(ACCOUNTS, 15, 5, NOW)
    expect(c.imminentAccounts).toBe(1)
    expect(c.shortTermAccounts).toBe(1)
    // ⚠️ 各档之和可能 > 总账号数（同一账号跨档）—— 这是正确语义
    expect(c.imminentAccounts + c.shortTermAccounts + c.permanentAccounts).toBeGreaterThan(c.totalAccounts)
  })

  it('★ 查不到余额的账号计入 noCreditAccounts（不是「永久」）', () => {
    const c = computeCoverage(ACCOUNTS, 15, 5, NOW)
    expect(c.noCreditAccounts).toBe(1)
    expect(c.totalAccounts).toBe(4)
  })

  it('★ 窗口收窄后，原本临期的账号可能落到短期/永久', () => {
    const wide = computeCoverage(ACCOUNTS, 15, 5, NOW)
    const narrow = computeCoverage(ACCOUNTS, 5, 3, NOW)
    // 收窄后临期账号减少（2 天仍在 3 天内 ⇒ 还是临期；12 天的掉出短期）
    expect(narrow.shortTermAccounts).toBe(0)
    expect(wide.shortTermAccounts).toBe(1)
  })

  /**
   * ★★★ **同一账号跨档时必须被两个档都计入**（变异 M7 实测无牙后补的用例）。
   *
   * 语义：「覆盖 N 个账号」回答的是「这个窗口涉及哪些账号」，
   * 不是「每个账号归哪一档」⇒ 一个既有临期又有短期的账号必须**同时**计入两档。
   *
   * ⚠️ 之前的用例数据里没有「同账号跨档」的样本 ⇒ 把实现改成
   *    `else if (shortTerm > 0)`（按档归类）时**全绿** —— 语义漂移却测不出来。
   */
  it('★★★ 同一账号同时有临期与短期 ⇒ 两档都计入（可重叠）', () => {
    // 一个包 2 天后到期（临期）、另一个 12 天后到期（短期）
    const cross = [{ id: 'a', packages: [pkg(100, 2), pkg(200, 12)] }]
    const c = computeCoverage(cross, 15, 5, NOW)
    expect(c.imminentAccounts, '临期档必须计入').toBe(1)
    expect(c.shortTermAccounts, '短期档也必须计入（同一个账号）').toBe(1)
    // ⚠️ 反向：若改成按档归类，这里会是 0
  })

  it('⚠️ 脏数据不炸', () => {
    expect(computeCoverage(undefined, 15, 5, NOW).totalAccounts).toBe(0)
    expect(computeCoverage(null, 15, 5, NOW).totalAccounts).toBe(0)
    expect(computeCoverage([{ id: 'x' }], 15, 5, NOW).noCreditAccounts).toBe(1)
    expect(computeCoverage([null], 15, 5, NOW).noCreditAccounts).toBe(1)
  })

  it('★★ 与面板同源：金额用 splitCreditsByExpiry 算（不是自己求和）', () => {
    const single = [{ id: 'a', packages: [pkg(100, 2), pkg(200, 12), pkg(300, 30)] }]
    const c = computeCoverage(single, 15, 5, NOW)
    expect(c.imminentAmount).toBe(100)
    expect(c.shortTermAmount).toBe(200)
    expect(c.permanentAmount, '30 天包归 longTerm ⇒ 算永久').toBe(300)
  })
})

describe('windowRangeLabels：三档区间文案（顺序必须是临期 → 短期 → 永久）', () => {
  it('★ 文案与顺序', () => {
    const r = windowRangeLabels(15, 5)
    expect(r.imminent).toContain('< 5')
    expect(r.shortTerm).toContain('5 ~ 15')
    expect(r.permanent).toContain('≥ 15')
  })
})

describe('describeWindowSource / coverageLabel', () => {
  it('来源文案三种', () => {
    expect(describeWindowSource('setting')).toBe('本渠道设置')
    expect(describeWindowSource('env')).toBe('环境变量')
    expect(describeWindowSource('default')).toBe('默认值')
  })

  it('覆盖数文案', () => {
    expect(coverageLabel(4, 7)).toContain('4')
    expect(coverageLabel(4, 7)).toContain('覆盖')
  })
})
