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

describe('rotateFromPreferred —— S2 只提升起点自己', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((id) => mk(id, 100, 0))

  it('不设起点 ⇒ 逐字节不变（唯一回归面）', () => {
    expect(ids(rotateFromPreferred(five, {}))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(rotateFromPreferred(five, { rotationStartId: undefined }))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(rotateFromPreferred(five, { rotationStartId: '' }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('★ 选中间项 ⇒ **只把它摘到最前**，其余保持原序（不是绕圈）', () => {
    // S2：选 c ⇒ [c, a, b, d, e]
    // ⚠️ 旧语义会得到 [c, d, e, a, b]（把 a/b 甩到末尾）—— 那正是要修掉的
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'c' })))
      .toEqual(['c', 'a', 'b', 'd', 'e'])
  })

  it('选第 4 个 ⇒ d → a → b → c → e（S2：只提它一个）', () => {
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'd' })))
      .toEqual(['d', 'a', 'b', 'c', 'e'])
    // ⚠️ 旧语义是 [d, e, a, b, c]
  })

  it('选首个 ⇒ 原样（幂等）', () => {
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'a' }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('选末个 ⇒ 提到最前（其余保持原序）', () => {
    expect(ids(rotateFromPreferred(five, { rotationStartId: 'e' }))).toEqual(['e', 'a', 'b', 'c', 'd'])
    // ⚠️ 旧语义也是 [e,a,b,c,d]（末位绕圈 == 提到最前）⇒ 本条两种语义同结果
  })

  it('★ 集合不变：只重排，不增删', () => {
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
describe('★★ S2：起点不得破坏「临期优先」', () => {
  /** 造一个带三档的账号（用 expiring/imminent/permanent 三个字段直接表达分桶结果）。 */
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

  it('★ 起点在「短期」档 ⇒ 临期账号仍排在第 2 位（不被甩到末尾）', () => {
    const ranked = rankBuddyAccountsByBalance(POOL, { allowPermanent: true })
    expect(ids(ranked), '档位序：C(临期) 在最前').toEqual(['C', 'B', 'D', 'A', 'E'])
    const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: 'B' })
    expect(ids(out), 'B 提到最前，C(临期) 保持第 2').toEqual(['B', 'C', 'D', 'A', 'E'])
    // ⚠️ 反向对照：旧语义会得到 ['B','D','A','E','C'] —— C 的临期被甩到最后
    expect(ids(out)[1], '临期账号必须在第 2 位').toBe('C')
    expect(ids(out)[ids(out).length - 1], '临期账号绝不能在末位').not.toBe('C')
  })

  it('★ 起点在「永久」档 ⇒ 临期账号仍排在第 2 位', () => {
    const ranked = rankBuddyAccountsByBalance(POOL, { allowPermanent: true })
    const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: 'A' })
    expect(ids(out), 'A 提到最前，C(临期) 保持第 2').toEqual(['A', 'C', 'B', 'D', 'E'])
  })

  it('★ 不变量：除起点外，其余元素相对顺序**逐字节不变**', () => {
    const ranked = rankBuddyAccountsByBalance(POOL, { allowPermanent: true })
    for (const startId of ['B', 'D', 'A', 'E', 'C']) {
      const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: startId })
      const expectedOthers = ranked.filter((a) => a.id !== startId).map((a) => a.id)
      expect(out[0].id, '起点必须在首位').toBe(startId)
      expect(out.slice(1).map((a) => a.id), `起点=${startId} 时其余顺序`).toEqual(expectedOthers)
    }
  })

  it('起点是临期档时 ⇒ 与不设起点的结果相同（它本就是首选）', () => {
    const ranked = rankBuddyAccountsByBalance(POOL, { allowPermanent: true })
    const out = rotateFromPreferred(ranked, { allowPermanent: true, rotationStartId: 'C' })
    expect(ids(out), 'C 本就在首位 ⇒ 提升后完全相同').toEqual(ids(ranked))
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
    // b 可用 ⇒ S2 只把它摘到最前 ⇒ [b, a, d, c]
    expect(ids(out), 'S2：b 提到最前，其余保持 [a,d,c]').toEqual(['b', 'a', 'd', 'c'])
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
    // S2：d 提到最前，其余 [a,b,c,e] 保持原序
    expect(ids(out)).toEqual(['d', 'a', 'b', 'c', 'e'])
  })

  it('★ 严格手动顺序下同样生效', () => {
    const ranked = rankBuddyAccountsByManualOrder(accounts, { allowPermanent: true, strictManualOrder: true })
    const out = rotateFromPreferred(ranked, {
      allowPermanent: true,
      strictManualOrder: true,
      rotationStartId: 'd',
    })
    expect(ids(out), 'S2：d 提到最前，其余保持原序').toEqual(['d', 'a', 'b', 'c', 'e'])
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
    // S2：锚点 = c ⇒ 只把 c 提到最前，其余 [a, e] 保持原序
    expect(ids(out), 'S2：c 提到最前').toEqual(['c', 'a', 'e'])
  })

  it('选被封禁的 d ⇒ 从 e 开始', () => {
    const out = rotateFromPreferred(candidates, { rotationStartId: 'd', enabledAccountIds: pool })
    // S2：锚点 = e ⇒ 只把 e 提到最前，其余 [a, c] 保持原序
    expect(ids(out), 'S2：e 提到最前').toEqual(['e', 'a', 'c'])
  })

  it('起点在候选里 ⇒ 仍按候选直接命中（本修法不改变既有语义）', () => {
    const out = rotateFromPreferred(candidates, { rotationStartId: 'e', enabledAccountIds: pool })
    // e 本就在候选末位 ⇒ S2 提到最前
    expect(ids(out)).toEqual(['e', 'a', 'c'])
  })

  it('★ 老调用方不传 enabledAccountIds ⇒ 找不到就原样（既有语义逐字节不变）', () => {
    const out = rotateFromPreferred(candidates, { rotationStartId: 'b' })
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
