/**
 * 临期括号的「只有一笔时只显示时间」（2026-11-20 用户要求）。
 *
 * 用户原话：「如果临期积分只有一笔，则括号里面只显示时间即可」。
 *
 * ## 为什么用纯函数测而不是源码文本断言
 *
 * 那段逻辑住在 `usage-badge.js`（import react，测不了），
 * 所以判据抽到了 `badge-model.js` 的 `isEarliestPartial`。
 * 本文件直接行为断言它 —— 源码文本断言有大量已知假绿形态。
 */
import { describe, expect, it } from 'vitest'
import { isEarliestPartial } from '../../plugin-src/client/badge-model.js'

describe('isEarliestPartial：临期括号要不要带金额', () => {
  it('★★★ 只有一笔 ⇒ false（括号里不写金额，避免重复）', () => {
    // 只有一笔临期时，earliestAmount 就是全部
    expect(isEarliestPartial(471.27, 471.27)).toBe(false)
    // 用户截图里的真实数据形态
    expect(isEarliestPartial(471.27, 471.27)).toBe(false)
    expect(isEarliestPartial(365.58, 365.58)).toBe(false)
  })

  it('★★★ 有多笔 ⇒ true（括号里的金额说明「先到期的是这些」）', () => {
    expect(isEarliestPartial(471.27, 300)).toBe(true)
    expect(isEarliestPartial(4464.5, 3864.5)).toBe(true)
    // 差 1 分也算多笔（用户能看到差别）
    expect(isEarliestPartial(100, 99.99)).toBe(true)
  })

  it('★ 浮点误差容忍：差值 ≤ 0.005 视为「只有一笔」', () => {
    // ⚠️ 多个同刻到期的包浮点累加，可能得到 471.27000000000004
    expect(isEarliestPartial(471.27, 471.27000000000004)).toBe(false)
    expect(isEarliestPartial(471.2700001, 471.27)).toBe(false)
    // 恰好 0.005 不触发（`>` 而不是 `>=`）
    expect(isEarliestPartial(100.005, 100)).toBe(false)
    // 明显超过 ⇒ 多笔
    expect(isEarliestPartial(100.01, 100)).toBe(true)
  })

  it('⚠️ 脏数据 / 缺失 ⇒ false（不加括号，不编造）', () => {
    expect(isEarliestPartial(undefined, 100)).toBe(false)
    expect(isEarliestPartial(100, undefined)).toBe(false)
    expect(isEarliestPartial(null, null)).toBe(false)
    expect(isEarliestPartial(NaN, 100)).toBe(false)
    expect(isEarliestPartial(100, NaN)).toBe(false)
    expect(isEarliestPartial(Infinity, 100)).toBe(false)
    expect(isEarliestPartial('100', '50')).toBe(true) // 数字字符串可被 Number() 转
  })

  it('⚠️ 反向数据（earliest > total）⇒ false（异常数据不加金额）', () => {
    // 理论上不该出现；若出现，说明数据有 bug，此时不该在括号里印一个更大的数字
    expect(isEarliestPartial(100, 200)).toBe(false)
  })
})
