/**
 * ★★★ **徽标快照的「阈值透传」行为级守卫**（2026-11-27，PR #183 审结）。
 *
 * ## 为什么必须是行为级
 *
 * `PR #183` 原本补的 4 条守卫是**源码文本断言**（`readFileSync` + `indexOf` + `slice`），
 * 对抗审计实测：**把那两行原地注释掉、或包进 `if (false) { … }` 死分支，仍然 4 passed**。
 *
 * ⇒ 源码文本挡不住「功能静默关闭」—— 而「功能静默关闭」正是它要防的那件事。
 *
 * ## 它要防的原始缺陷
 *
 * `usage-badge.js` 里写着 `imminentFloor: value?.imminentFloor`，但
 * **`src/usage-badge.ts` 从来不下发这两个字段** ⇒ `value?.imminentFloor` 恒 `undefined`
 * ⇒ 客户端整条「按阈值降档」链路是**死接线**（胶囊可用积分、弹窗排序全按 0 跑，
 * 与服务端选号分叉）。
 *
 * ⚠️ 它靠「对象 spread」逃过了 tsc —— 读不存在的属性得到 `undefined` 是合法 TS。
 * ⇒ **类型缺字段 = 运行时静默失效**，比报错难查得多。
 */
import { describe, expect, it } from 'vitest'
import { badgeWindowFieldsOf } from '../../src/usage-badge.js'

describe('★★★ 徽标快照：阈值透传（行为级）', () => {
  it('★★★ 有值时**必须**带上两个阈值（这是死接线修复的判据）', () => {
    const out = badgeWindowFieldsOf({ windowDays: 15, imminentDays: 5, imminentFloor: 20, expiringFloor: 30 })
    expect(out.imminentFloor, '★ 缺这一格 ⇒ 客户端恒 undefined ⇒ 阈值从未生效').toBe(20)
    expect(out.expiringFloor, '★ 缺这一格 ⇒ 纯短期降级在客户端失效').toBe(30)
    expect(out.windowDays).toBe(15)
    expect(out.imminentDays).toBe(5)
  })

  it('★★★ `0` 必须保留为 `0`（显式关闭 ≠ 服务端没给）', () => {
    const out = badgeWindowFieldsOf({ imminentFloor: 0, expiringFloor: 0 })
    expect('imminentFloor' in out, '`0` 不能被当成「没给」丢掉').toBe(true)
    expect(out.imminentFloor).toBe(0)
    expect('expiringFloor' in out).toBe(true)
  })

  it('★★ `undefined` 不得写成 `0`（否则「没配阈值」被当成「阈值 0」）', () => {
    const out = badgeWindowFieldsOf({ windowDays: 15 })
    expect('imminentFloor' in out, '没给就不该出现这个键').toBe(false)
    expect('expiringFloor' in out).toBe(false)
  })

  it('★★ 只给一个阈值 ⇒ 只带那一个（不得凭空补另一个）', () => {
    const out = badgeWindowFieldsOf({ imminentFloor: 20 })
    expect(out.imminentFloor).toBe(20)
    expect('expiringFloor' in out, '凭空补一个 0 会让纯短期降级「被开启」').toBe(false)
  })
})
