/**
 * 「轮换起点」的行为级守卫（用户 2026-11-10 需求）。
 *
 * ## 需求（原话）
 *
 * 「下拉框**只是更改了原来的策略轮换起点**，并不更改策略的档次或者策略的变更。
 *  比如：锁定永久积分，临时账号有两个，默认第 1 个起点，我选第 2 个，
 *  那就是先账号 2 再账号 1；如果临时账号只有一个，那就没得选。
 *  解锁后全部账号都可以选择。也就是下拉框只变更轮换起点，不变更原来的策略选择和切换。」
 *
 * ## 三条不变量（逐条对应一个 describe）
 *
 * 1. **只旋转，不改策略** —— 档位判据、可用性过滤全部照旧；
 * 2. **集合不变** —— 只重排，不增删；
 * 3. **默认（undefined）逐字节不变** —— 本功能的唯一回归面。
 *
 * ## ⚠️ 样例必须用 ≥5 元素且选中间项
 *
 * 三元素选末位时「旋转」与「提到最前」结果**恰好相同** ⇒ 测不出差异（假绿）。
 */
import { describe, expect, it } from 'vitest'
import { rotateFromPreferred, buddyBalanceTier, rankBuddyAccountsByBalance, rankBuddyAccountsByManualOrder } from '../../src/buddy-balance-rank.js'

const mk = (id, expiring, permanent) => ({ id, expiringBalance: expiring, permanentBalance: permanent })
const ids = (rows) => rows.map((r) => r.id)

describe('rotateFromPreferred —— 纯环形旋转', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((id) => mk(id, 100, 0))

  it('不设起点 ⇒ 逐字节不变（唯一回归面）', () => {
    expect(ids(rotateFromPreferred(five, {}))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(rotateFromPreferred(five, { rotationStartId: undefined }))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(rotateFromPreferred(five, { rotationStartId: '' }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('★ 选中间项 ⇒ 从它起绕一圈（不是"提到最前"）', () => {
    // ⚠️ 这条是核心：选 c
    //   旋转   ⇒ [c, d, e, a, b]
    //   提到最前 ⇒ [c, a, b, d, e]  ← 错的实现会得到这个
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'c' })))
      .toEqual(['c', 'd', 'e', 'a', 'b'])
  })

  it('选第 4 个 ⇒ 4 → 5 → 1 → 2 → 3（用户原话的例子）', () => {
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'd' })))
      .toEqual(['d', 'e', 'a', 'b', 'c'])
  })

  it('选首个 ⇒ 原样（幂等）', () => {
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'a' }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('选末个 ⇒ 原样（末位旋转等于不变）', () => {
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'e' }))).toEqual(['e', 'a', 'b', 'c', 'd'])
  })

  it('★ 集合不变：只旋转，不增删', () => {
    const out = rotateFromPreferred(five, { rotationStartId: 'c' })
    expect(out).toHaveLength(five.length)
    expect(new Set(ids(out))).toEqual(new Set(ids(five)))
  })

  it('找不到该 id（账号被删）⇒ 原样', () => {
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'zzz' }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('返回新数组，不修改入参', () => {
    const input = [...five]
    const out = rotateFromPreferred(input, { rotationStartId: 'c' })
    expect(ids(input)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(out).not.toBe(input)
  })
})

describe('rotateFromPreferred —— 起点跳过不可用（Q2：循环到下一个）', () => {
  it('★ 选的号「只剩永久」+ 锁定 ⇒ 起点前移到下一个可用', () => {
    // 排序后（锁定）：a(临期) b(临期) c(永久→none) d(临期)
    // ⚠️ 实际排序会把 none 沉底，故用 rankBuddyAccountsByBalance 的真实结果驱动。
    const accounts = [mk('a', 100, 0), mk('b', 100, 0), mk('c', 0, 500), mk('d', 100, 0)]
    const ranked = rankBuddyAccountsByBalance(accounts, { allowPermanent: false })
    // 锁定态下 c 是 none ⇒ 沉底 ⇒ [a, b, d, c]
    expect(ids(ranked)).toEqual(['a', 'b', 'd', 'c'])
    // 选 c（不可用）⇒ 从它往后找第一个可用 ⇒ 绕回 a
    const out = rotateFromPreferred(ranked, { allowPermanent: false, rotationStartId: 'c' })
    expect(ids(out)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('★ 选中间一个不可用的 ⇒ 起点落在它之后的第一个可用', () => {
    // 手动序模式：unusable 沉底 ⇒ [a, d, b, c]（b、c 只剩永久）
    const accounts = [mk('a', 100, 0), mk('b', 0, 500), mk('c', 0, 500), mk('d', 100, 0)]
    const ranked = rankBuddyAccountsByManualOrder(accounts, { allowPermanent: false })
    expect(ids(ranked)).toEqual(['a', 'd', 'b', 'c'])
    // 选 b（不可用，位置 2）⇒ 往后找第一个可用 ⇒ 绕回 a（因为 b 之后全是不可用）
    const out = rotateFromPreferred(ranked, { allowPermanent: false, rotationStartId: 'b' })
    expect(ids(out)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('解锁后「只剩永久」也可用 ⇒ 起点就落在它自己', () => {
    const accounts = [mk('a', 100, 0), mk('b', 0, 500), mk('c', 0, 500), mk('d', 100, 0)]
    const ranked = rankBuddyAccountsByBalance(accounts, { allowPermanent: true })
    // 未锁定：临期在前 ⇒ [a, d, b, c]
    expect(ids(ranked)).toEqual(['a', 'd', 'b', 'c'])
    const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: 'b' })
    // b 可用 ⇒ 直接从 b 起
    expect(ids(out)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('全不可用 ⇒ 原样（交给上层报错，不在这里抛）', () => {
    const accounts = [mk('a', 0, 500), mk('b', 0, 500)]
    const ranked = rankBuddyAccountsByBalance(accounts, { allowPermanent: false })
    const out = rotateFromPreferred(ranked, { allowPermanent: false, rotationStartId: 'b' })
    expect(ids(out)).toEqual(ids(ranked))
  })
})

describe('两种策略都生效（strictManualOrder 不再是例外）', () => {
  const accounts = [mk('a', 100, 0), mk('b', 100, 0), mk('c', 100, 0), mk('d', 100, 0), mk('e', 100, 0)]

  it('默认模式（余额分档）下生效', () => {
    const ranked = rankBuddyAccountsByBalance(accounts, { allowPermanent: true })
    const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: 'd' })
    expect(ids(out)).toEqual(['d', 'e', 'a', 'b', 'c'])
  })

  it('★ 严格手动顺序下同样生效', () => {
    const ranked = rankBuddyAccountsByManualOrder(accounts, { allowPermanent: true, strictManualOrder: true })
    const out = rotateFromPreferred(ranked, {
      allowPermanent: true,
      strictManualOrder: true,
      rotationStartId: 'd',
    })
    expect(ids(out)).toEqual(['d', 'e', 'a', 'b', 'c'])
  })
})
