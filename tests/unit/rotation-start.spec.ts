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
 * ## ⚠️⚠️ 2026-11-18 语义变更：S3「环形旋转」→ S2「只提升起点自己」
 *
 * 用户原话：「起点只提升自己，自己是什么档次就使用它的档次，
 * 然后剩余全部按默认策略档位排列」
 *
 * | | 旧（S3，环形旋转）| 新（S2，只提自己）|
 * |---|---|---|
 * | 选 c | `c d e a b` | `c a b d e` |
 * | 选 d | `d e a b c` | `d a b c e` |
 *
 * ### 为什么要改（核心）
 *
 * 环形旋转会把「档位序里排在起点**之前**」的账号甩到末尾 —— 而那些账号
 * 可能就是**临期**的。临期积分一旦排到最后，就会白等到过期，而「临期优先」
 * 正是三档机制存在的唯一理由。
 *
 * ⚠️ 样例必须用 ≥5 元素且选中间项：三元素选末位时两种语义结果相同 ⇒ 测不出差异。
 */
import { describe, expect, it } from 'vitest'
import { rotateFromPreferred, buddyBalanceTier, rankBuddyAccountsByBalance, rankBuddyAccountsByManualOrder } from '../../src/buddy-balance-rank.js'

const mk = (id, expiring, permanent) => ({ id, expiringBalance: expiring, permanentBalance: permanent })
const ids = (rows) => rows.map((r) => r.id)

describe('rotateFromPreferred —— S4 起点所在档位内循环', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((id) => mk(id, 100, 0))

  it('不设起点 ⇒ 逐字节不变（唯一回归面）', () => {
    expect(ids(rotateFromPreferred(five, {}))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(rotateFromPreferred(five, { rotationStartId: undefined }))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(rotateFromPreferred(five, { rotationStartId: '' }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('★ 选中间项 ⇒ **本档内循环**（起点 → 其后 → 绕回档首）', () => {
    // 五个全是同档（都有 expiring）⇒ 整档内循环
    // 选 c ⇒ [c, d, e, a, b]
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'c', rotationStartTier: 'expiring' })))
      .toEqual(['c', 'd', 'e', 'a', 'b'])
  })

  it('选第 4 个 ⇒ d → e → a → b → c（同档循环）', () => {
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'd', rotationStartTier: 'expiring' })))
      .toEqual(['d', 'e', 'a', 'b', 'c'])
  })

  it('选首个 ⇒ 原样（幂等）', () => {
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'a', rotationStartTier: 'expiring' }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('选末个 ⇒ 提到最前（其余保持原序）', () => {
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'e', rotationStartTier: 'expiring' }))).toEqual(['e', 'a', 'b', 'c', 'd'])
    // ⚠️ 旧语义也是 [e,a,b,c,d]（末位绕圈 == 提到最前）⇒ 本条两种语义同结果
  })

  it('★ 集合不变：只重排，不增删', () => {
    const out = rotateFromPreferred(five, { rotationStartId: 'c', rotationStartTier: 'expiring' })
    expect(out).toHaveLength(five.length)
    expect(new Set(ids(out))).toEqual(new Set(ids(five)))
  })

  it('找不到该 id（账号被删）⇒ 原样', () => {
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'zzz', rotationStartTier: 'expiring' }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('返回新数组，不修改入参', () => {
    const input = [...five]
    const out = rotateFromPreferred(input, { rotationStartId: 'c', rotationStartTier: 'expiring' })
    expect(ids(input)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(out).not.toBe(input)
  })
})

/**
 * ★★ **S2 的核心价值：起点不能破坏「临期优先」**（用户 2026-11-18 定稿）。
 *
 * 旧语义（S3 环形旋转）的致命缺陷：起点若不在临期档，会把档位序里排在它
 * **前面**的临期账号甩到**末尾** ⇒ 那些临期积分白等到过期。
 *
 * 实测（本 describe 的用例钉住的形态）：
 * ```
 * 池：A(位1·永久) B(位2·短期) C(位3·临期) D(位4·短期) E(位5·永久)
 * 档位序：  C(临期) B(短期) D(短期) A(永久) E(永久)
 * 起点=B： S3 ⇒ B D A E C   ← C 的临期被甩到最后
 *          S2 ⇒ B C D A E   ← C 仍在第 2 位
 * ```
 */
describe('★★ S5：起点绝对第一 + 其余档位优先 + 同档循环', () => {
  /** 造一个带三档的账号。 */
  const mkTier = (id, { imminent = 0, expiring = 0, permanent = 0 }) => ({
    id, imminentBalance: imminent, expiringBalance: expiring, permanentBalance: permanent,
  })
  const POOL = [
    mkTier('A', { permanent: 1000 }),
    mkTier('B', { expiring: 500 }),
    mkTier('C', { imminent: 300 }),
    mkTier('D', { expiring: 800 }),
    mkTier('E', { permanent: 2000 }),
  ]

  it('★★ 起点在「短期」档 ⇒ **起点第一**，之后临期档，再其余', () => {
    const ranked = rankBuddyAccountsByBalance(POOL, { allowPermanent: true })
    expect(ids(ranked), '档位序：C(临期) 在最前').toEqual(['C', 'B', 'D', 'A', 'E'])
    // ★ 起点 B 是「短期」档 ⇒ 传 tierAtSelection: 'expiring'（档位未变 ⇒ 仍占首位）
    const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: 'B', rotationStartTier: 'expiring' })
    // S5：起点 B 第一；之后按档位序 C(临期) → D(短期) → A/E(永久)
    expect(ids(out), 'B 第一，随后 C(临期)').toEqual(['B', 'C', 'D', 'A', 'E'])
    expect(ids(out)[0], '起点必须在首位').toBe('B')
  })

  it('★★ 起点在「永久」档 ⇒ **起点第一**（哪怕临期档更优先）', () => {
    const ranked = rankBuddyAccountsByBalance(POOL, { allowPermanent: true })
    // ★ 起点 A 是「永久」档 ⇒ 传 tierAtSelection: 'permanent'
    const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: 'A', rotationStartTier: 'permanent' })
    // S5：A 第一；之后 C(临期) → B/D(短期) → E(永久)
    expect(ids(out), 'A 第一，随后 C(临期)、B/D(短期)、E(永久)').toEqual(['A', 'C', 'B', 'D', 'E'])
  })

  it('★★ 同档内**循环**（起点之后的绕到前面）', () => {
    // 五个全是同档 ⇒ 整档内循环
    const same = ['a', 'b', 'c', 'd', 'e'].map((id) => mkTier(id, { expiring: 100 }))
    const ranked = rankBuddyAccountsByBalance(same, { allowPermanent: true })
    expect(ids(ranked)).toEqual(['a', 'b', 'c', 'd', 'e'])
    const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: 'c', rotationStartTier: 'expiring' })
    expect(ids(out), 'S5：起点 c 第一，其后 d/e，绕回 a/b').toEqual(['c', 'd', 'e', 'a', 'b'])
  })

  it('★ 不变量：**起点永远是第一位**（遍历每个作为起点）', () => {
    const ranked = rankBuddyAccountsByBalance(POOL, { allowPermanent: true })
    /** ★ 每个起点的真实档位（S6：必须传，否则按降档处理）。 */
    const tierOf = { A: 'permanent', B: 'expiring', C: 'imminent', D: 'expiring', E: 'permanent' }
    for (const startId of ['A', 'B', 'C', 'D', 'E']) {
      const out = rotateFromPreferred(ranked, {
        allowPermanent: true,
        rotationStartId: startId,
        rotationStartTier: tierOf[startId],
      })
      expect(out[0].id, `起点=${startId} 必须在首位`).toBe(startId)
      expect(out).toHaveLength(ranked.length)
      expect(new Set(ids(out))).toEqual(new Set(ids(ranked)))
    }
  })

  it('★ 不变量：起点之后按档位升序（不得出现跨档逆序）', () => {
    const ranked = rankBuddyAccountsByBalance(POOL, { allowPermanent: true })
    const tierOf = { A: 'permanent', B: 'expiring', C: 'imminent', D: 'expiring', E: 'permanent' }
    for (const startId of ['A', 'B', 'C', 'D', 'E']) {
      const out = rotateFromPreferred(ranked, {
        allowPermanent: true,
        rotationStartId: startId,
        rotationStartTier: tierOf[startId],
      })
      const ranks = out.slice(1).map((a) => buddyBalanceTier(a, { allowPermanent: true }))
      const sorted = [...ranks].sort((x, y) => x - y)
      expect(ranks, `起点=${startId} 之后必须按档位升序`).toEqual(sorted)
    }
  })

  it('起点是临期档且已在该档首位 ⇒ 与不设起点的结果相同', () => {
    const ranked = rankBuddyAccountsByBalance(POOL, { allowPermanent: true })
    const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: 'C', rotationStartTier: 'imminent' })
    expect(ids(out), 'C 本就在首位 ⇒ 结果完全相同').toEqual(ids(ranked))
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
    // ★ b 是「永久」档（mk 无 imminentBalance、expiring=0）⇒ 传 'permanent'
    const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: 'b', rotationStartTier: 'permanent' })
    // S5：b 第一；之后按档位序 a, d(临期) → c(永久)
    expect(ids(out), 'S5：b 第一，随后临期 a/d，再永久 c').toEqual(['b', 'a', 'd', 'c'])
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
    // ★ d 是「短期」档（mk 的 expiringBalance=100、无 imminent）⇒ 传 'expiring'
    const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: 'd', rotationStartTier: 'expiring' })
    // 五个全同档 ⇒ S4 整档内循环：d → e → a → b → c
    expect(ids(out)).toEqual(['d', 'e', 'a', 'b', 'c'])
  })

  it('★ 严格手动顺序下同样生效', () => {
    const ranked = rankBuddyAccountsByManualOrder(accounts, { allowPermanent: true, strictManualOrder: true })
    const out = rotateFromPreferred(ranked, {
      allowPermanent: true,
      strictManualOrder: true,
      rotationStartId: 'd',
      rotationStartTier: 'expiring',
    })
    // 全同档 ⇒ S4 整档循环
    expect(ids(out), 'S4：d 开始循环').toEqual(['d', 'e', 'a', 'b', 'c'])
  })
})

/**
 * ★★ PR #59 正向审计 P1-a：**起点不在候选集里**（账号级封禁 / 目标模型限流，
 * 被 `candidatesOf` 滤掉）时，必须**循环到下一个可用**，不能静默回落默认。
 *
 * 池序（`enabledAccountIds`）是 a b c d e，候选集只有 a c e（b、d 被封禁/限流）。
 */
describe('★★ 起点被封禁 / 被限流（不在候选集里）⇒ 循环到下一个可用', () => {
  const pool = ['a', 'b', 'c', 'd', 'e']
  const candidates = [mk('a', 100, 0), mk('c', 100, 0), mk('e', 100, 0)]

  it('★ 选被封禁的 b ⇒ 从 c 开始（而不是回落默认的 a）', () => {
    const out = rotateFromPreferred(candidates, { rotationStartId: 'b', enabledAccountIds: pool })
    // 错的实现（找不到就原样）会得到 ['a', 'c', 'e'] —— 正是用户想避开的。
    // S4：锚点 = c（同档内循环）⇒ 候选 [a, c, e] 全同档 ⇒ c → e → a
    expect(ids(out), 'S4：c 开始循环').toEqual(['c', 'e', 'a'])
  })

  it('选被封禁的 d ⇒ 从 e 开始', () => {
    const out = rotateFromPreferred(candidates, { rotationStartId: 'd', enabledAccountIds: pool })
    // S4：锚点 = e，全同档 ⇒ e → a → c
    expect(ids(out), 'S4：e 开始循环').toEqual(['e', 'a', 'c'])
  })

  it('起点在候选里 ⇒ 仍按候选直接命中（本修法不改变既有语义）', () => {
    const out = rotateFromPreferred(candidates, { rotationStartId: 'e', enabledAccountIds: pool })
    // e 本就在候选末位 ⇒ S2 提到最前
    expect(ids(out)).toEqual(['e', 'a', 'c'])
  })

  it('★ 老调用方不传 enabledAccountIds ⇒ 找不到就原样（既有语义逐字节不变）', () => {
    const out = rotateFromPreferred(candidates, { rotationStartId: 'b', rotationStartTier: 'expiring' })
    expect(ids(out)).toEqual(['a', 'c', 'e'])
  })

  it('起点已被删除（不在 enabledAccountIds 里）⇒ 原样（不变量 3）', () => {
    const out = rotateFromPreferred(candidates, { rotationStartId: 'zzz', enabledAccountIds: pool })
    expect(ids(out)).toEqual(['a', 'c', 'e'])
  })

  it('★ 起点之后那个候选也不可用 ⇒ 继续向后绕（跳过 none 档）', () => {
    const mixed = [mk('a', 100, 0), mk('c', 0, 0), mk('e', 100, 0)]
    const out = rotateFromPreferred(mixed, { rotationStartId: 'b', enabledAccountIds: pool })
    // b 不在候选 ⇒ 从「池位次 ≥ 1」的第一个候选 c 起；c 是 none 档 ⇒ 继续到 e
    expect(ids(out)).toEqual(['e', 'a', 'c'])
  })
})
