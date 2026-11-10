/**
 * 「轮换起点」下拉框的可展开性守卫（真实缺陷，2026-11-11 真机）。
 *
 * ## 事故
 *
 * 用户开启「锁定永久积分」后再打开用量弹窗，整枚徽标被错误边界接住：
 *
 * ```
 * 用量徽标渲染失败，已拦住
 * Cannot read properties of null (reading 'expiring')
 * ```
 *
 * ## 根因（两处错误叠加，任一都会崩）
 *
 * `expiringOf()` 里：
 *
 * ```js
 * const split = splitCreditsByExpiry({ packages });   // ❌ 参数错：签名第一参就是包数组
 * if (split === undefined) return undefined;          // ❌ 判据错：它返回的是 null
 * return split.expiring;                              // ⇒ TypeError
 * ```
 *
 * 1. **参数传错** ⇒ 传了对象而不是数组 ⇒ 该函数**恒返回 `null`**；
 * 2. **判据漏判 `null`** ⇒ `=== undefined` 挡不住 ⇒ 下一行抛。
 *
 * ## 为什么只在「锁定永久积分」时崩
 *
 * `expiringOf` 只在 `rotationState.locked === true` 时被调用
 *（`reasonOf` 的 `no-expiring` 判据）⇒ 未锁定时这条路径**根本不执行**，
 * 所以之前几轮测试都没碰到。
 *
 * ## 本文件守什么
 *
 * 1. 该函数**永不抛**（宽松输入也不抛）；
 * 2. 参数形态正确（数组，不是 `{ packages }`）；
 * 3. 源码里不得再出现「只判 undefined」的写法。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { splitCreditsByExpiry } from '../../plugin-src/client/credit-expiry.js'

const SRC = join(process.cwd(), 'plugin-src', 'client', 'usage-badge.js')
const source = readFileSync(SRC, 'utf8')

describe('splitCreditsByExpiry 的返回契约（本修法的前提）', () => {
  it('★ 第一参不是数组 ⇒ 返回 **null**（不是 undefined）', () => {
    // 这正是我当初传 `{ packages }` 时的形态
    expect(splitCreditsByExpiry({ packages: [] }, 15)).toBeNull()
    expect(splitCreditsByExpiry(undefined, 15)).toBeNull()
    expect(splitCreditsByExpiry('x', 15)).toBeNull()
  })

  it('★★ **漏传 windowDays 也返回 null**（最隐蔽的一条）', () => {
    // 修了「参数形态」却忘了窗口 ⇒ 仍然崩。这条锁的就是它。
    const packages = [{ remaining: 100, active: true, deductionEndTime: Date.now() + 86_400_000 }]
    expect(splitCreditsByExpiry(packages)).toBeNull()
    expect(splitCreditsByExpiry(packages, 15)).not.toBeNull()
  })

  it('★ 合法数组 + 窗口 ⇒ 返回对象（不再是 null）', () => {
    const split = splitCreditsByExpiry(
      [{ remaining: 100, active: true, deductionEndTime: Date.now() + 86_400_000 }],
      15,
    )
    expect(split).not.toBeNull()
    expect(typeof split.expiring).toBe('number')
  })

  it('空数组 + 窗口 ⇒ 返回对象，expiring 为 0（与 null 是两件事）', () => {
    const split = splitCreditsByExpiry([], 15)
    expect(split).not.toBeNull()
    expect(split.expiring).toBe(0)
  })
})

describe('usage-badge 的 expiringOf 源码契约', () => {
  it('★ 不得再传 `{ packages }` 这种错误形态', () => {
    // 变异：把它改回 splitCreditsByExpiry({ packages }) ⇒ 本条红
    expect(source).not.toMatch(/splitCreditsByExpiry\(\s*\{\s*packages\s*\}\s*\)/)
  })

  it('★ 必须把 windowDays 传进去', () => {
    // 变异：改回 splitCreditsByExpiry(packages) ⇒ 本条红（漏传窗口 ⇒ 恒 null）
    expect(source).toMatch(/splitCreditsByExpiry\(\s*packages\s*,\s*value\?\.windowDays\s*\)/)
  })

  it('★ 判据必须挡 null（`== null` 或等价写法）', () => {
    // ⚠️ 这条守的是「只写 === undefined」那个漏判。
    const guarded = /split\s*==\s*null/.test(source)
      || /split\s*!==\s*null\s*&&/.test(source)
      || /if\s*\(\s*!split\s*\)/.test(source)
    expect(guarded).toBe(true)
  })

  it('★ 不得出现「只判 undefined」的写法', () => {
    // 正是这个写法让 null 漏过去
    expect(source).not.toMatch(/if\s*\(\s*split\s*===\s*undefined\s*\)/)
  })
})
