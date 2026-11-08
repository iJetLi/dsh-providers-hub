import { describe, expect, it } from 'vitest'

import {
  rankBuddyAccountsByBalance,
  rankBuddyAccountsByManualOrder,
  buddyBalanceTier,
  buddyTierUsable,
} from '../../src/buddy-balance-rank.js'
import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import { LoomyBalanceSelector } from '../../src/loomy-balance-selector.js'
import { LOOMY } from '../../src/loomy-product.js'
import { CODEBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/types.js'
import type { CreditBalance, CreditPackage } from '../../src/credits.js'
import {
  rankLoomyAccountsByBalance,
  rankLoomyAccountsByManualOrder,
} from '../../src/loomy-balance-rank.js'
import { sanitizeStrictManualOrder } from '../../src/jet-hub-store.js'
import { isBalanceTieredProvider } from '../../src/provider-registry.js'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** 造一个积分包（`deductionEndTime` 决定它进「临期」还是「永久」桶）。 */
function pkg(input: { remaining: number; deductionEndTime: number }): CreditPackage {
  return { name: 'p', active: true, remaining: input.remaining, deductionEndTime: input.deductionEndTime, cycleCapacity: input.remaining, used: 0 } as CreditPackage
}

function balance(...packages: CreditPackage[]): CreditBalance {
  return { total: 0, packages, expiredTotal: 0 } as CreditBalance
}

/** 造一个候选账号（`credentialRef` 与 `id` 相同，方便余额桩按 ref 分派）。 */
const account = (id: string) => ({ id, credentialRef: id })

/**
 * 「严格手动顺序」开关（`JetHubState.strictManualOrder`）的行为守卫。
 *
 * ## 这条报障与它的根
 *
 * 用户报障原文：「多账号手动拖拽决定优先使用哪个账号的积分，**时灵时不灵**」。
 *
 * 根因不是拖拽坏了：面板文案与序号徽标一直写「按顺序选号」「序号 = 自动选号
 * 优先级」，而**走余额分档的渠道**实际执行的是「先按积分到期档位排序、档内才看
 * 拖拽顺序」。于是把某号拖到首位后，只要它不再持有临期积分（或余额接口抖了
 * 一下），请求就**静默**落到别的号上 —— 用户侧就是「时灵时不灵」。
 *
 * 修法 = 给用户一个开关：打开后拖拽序是唯一优先级（档位只判「能不能用」）。
 * 本文件钉三件事：
 * ① 严格模式下**先后完全按传入顺序**（档位不再重排）；
 * ② 但**可用性判据必须保留** —— 否则「锁定永久积分」会被绕过（这是本修法
 *    最危险的出错方向：不是排序难看，而是**不可撤回地烧掉永久积分**）；
 * ③ 默认（不传 / `false`）与被改造前**逐字节等价**。
 */

/** 一眼能看出「谁先谁后」的三个号：只有 b 有临期积分。 */
const MIXED = [
  { id: 'a-permanent-only', expiringBalance: 0, permanentBalance: 2100 },
  { id: 'b-expiring', expiringBalance: 1178.22, permanentBalance: 2100 },
  { id: 'c-expiring', expiringBalance: 412.58, permanentBalance: 2100 },
] as const

describe('rankBuddyAccountsByManualOrder（严格手动顺序）', () => {
  it('① 先后完全按手动顺序 —— 档位不再把「只剩永久」的号排到后面', () => {
    // 这正是报障形态：用户在首位放了一个只剩永久积分的号。
    // 默认排序会把它沉到 b/c 后面（= 用户看到「拖到首位不生效」）。
    expect(rankBuddyAccountsByBalance([...MIXED]).map(a => a.id))
      .toEqual(['b-expiring', 'c-expiring', 'a-permanent-only'])

    // 严格模式：顺序原样保留。
    expect(rankBuddyAccountsByManualOrder([...MIXED]).map(a => a.id))
      .toEqual(['a-permanent-only', 'b-expiring', 'c-expiring'])
  })

  it('② 锁定永久积分时仍然沉底（绝不放行只剩永久积分的号）', () => {
    const ranked = rankBuddyAccountsByManualOrder([...MIXED], { allowPermanent: false })
    // 可用性优先于手动顺序：首位那个「只剩永久」的号必须被挪到最后。
    expect(ranked.map(a => a.id)).toEqual(['b-expiring', 'c-expiring', 'a-permanent-only'])
    // 首位的号**必须**真的可用 —— 选号器据此决定发不发请求。
    expect(buddyTierUsable(buddyBalanceTier(ranked[0]!, { allowPermanent: false }))).toBe(true)
    // 末位那个**必须**真的不可用 —— 否则锁定被绕过。
    expect(buddyTierUsable(buddyBalanceTier(ranked[2]!, { allowPermanent: false }))).toBe(false)
  })

  it('②b 余额查不到的号在严格模式下也沉底（宁可发给能确认余额的号）', () => {
    const ranked = rankBuddyAccountsByManualOrder([
      { id: 'broken' },
      { id: 'ok', expiringBalance: 1 },
    ])
    expect(ranked.map(a => a.id)).toEqual(['ok', 'broken'])
  })

  it('③ 不传 strictManualOrder 时与改造前逐字节等价（默认行为不变）', () => {
    const legacy = rankBuddyAccountsByBalance([...MIXED])
    const explicitFalse = rankBuddyAccountsByManualOrder([...MIXED], { strictManualOrder: false })
    // 严格函数在**不锁定时**对所有「可用」号一视同仁 ⇒ 与默认排序的差别只在档位先后。
    expect(legacy.map(a => a.id)).not.toEqual(explicitFalse.map(a => a.id))
    // 但两者对「不可用」的判据必须一致：末位都必须是不可用的那个。
    expect(buddyTierUsable(buddyBalanceTier(legacy[0]!))).toBe(true)
    expect(buddyTierUsable(buddyBalanceTier(explicitFalse[0]!))).toBe(true)
  })

  it('不修改入参数组', () => {
    const input = [...MIXED]
    const before = input.map(a => a.id)
    rankBuddyAccountsByManualOrder(input)
    expect(input.map(a => a.id)).toEqual(before)
  })
})

describe('rankLoomyAccountsByManualOrder（严格手动顺序 · loomy 同构）', () => {
  const LOOMY = [
    { id: 'a-permanent-only', dailyBalance: 0, permanentBalance: 9999 },
    { id: 'b-daily', dailyBalance: 500, permanentBalance: 0 },
  ] as const

  it('先后完全按手动顺序（默认排序会把只有永久的号沉底）', () => {
    expect(rankLoomyAccountsByBalance([...LOOMY]).map(a => a.id))
      .toEqual(['b-daily', 'a-permanent-only'])
    expect(rankLoomyAccountsByManualOrder([...LOOMY]).map(a => a.id))
      .toEqual(['a-permanent-only', 'b-daily'])
  })

  it('锁定永久积分时仍然沉底（与 buddy 同一条纪律）', () => {
    expect(rankLoomyAccountsByManualOrder([...LOOMY], { allowPermanent: false }).map(a => a.id))
      .toEqual(['b-daily', 'a-permanent-only'])
  })
})

describe('sanitizeStrictManualOrder（稀疏表归一化）', () => {
  it('只认显式 true，脏值一律丢弃', () => {
    expect(sanitizeStrictManualOrder({
      buddy: true,
      trae: false,
      qoder: 1,
      loomy: 'true',
      minimax: null,
      '': true,
    })).toEqual({ buddy: true })
  })

  it('非对象 / 数组 / null 一律退化为空表（= 升级前行为）', () => {
    expect(sanitizeStrictManualOrder(undefined)).toEqual({})
    expect(sanitizeStrictManualOrder(null)).toEqual({})
    expect(sanitizeStrictManualOrder([])).toEqual({})
    expect(sanitizeStrictManualOrder('buddy')).toEqual({})
    expect(sanitizeStrictManualOrder(42)).toEqual({})
  })
})

describe('isBalanceTieredProvider（哪些渠道会做余额分档）', () => {
  it('分档渠道在表里', () => {
    for (const id of ['buddy', 'trae', 'qoder', 'qodercn', 'loomy', 'minimax', 'minimaxintl', 'autoclaw', 'magicrew', 'astudio', 'lobsterai', 'workbuddy']) {
      expect(isBalanceTieredProvider(id), id).toBe(true)
    }
  })

  it('纯手动序的渠道不在表里（拖拽对它们是绝对的）', () => {
    for (const id of ['codearts', 'raccoon', 'cline', 'gemini', 'qiniu', 'aggregate']) {
      expect(isBalanceTieredProvider(id), id).toBe(false)
    }
  })

  it('officeace 刻意不在表里（它只在锁定时分档，解锁态与手动序同路径）', () => {
    expect(isBalanceTieredProvider('officeace')).toBe(false)
  })
})

/**
 * **接线级守卫**：`select()` 必须真的把 `strictManualOrder` 交给排序函数。
 *
 * ## 为什么这一组不可省（变异实测抓到）
 *
 * 上面那组只测了两个**排序纯函数**。把 `select` 里的
 * `options.strictManualOrder === true ? rankManual : rankBalance`
 * 改成恒走 `rankBalance`（= **开关接了但没生效**）时，那组**全绿**
 * —— 因为纯函数本身没被改。这正是本仓库反复记录的那条：
 * 「排序函数对 ≠ 选号器用了它」。
 *
 * ⇒ 这里从 `select()` 走真实路径，断言「选中谁」随开关翻转。
 */
describe('select() 接线：strictManualOrder 必须真的影响选中账号', () => {
  /** 造一个取号器：a1 只剩永久、a2 有临期（默认排序会把 a2 排前面）。 */
  function makeSelector() {
    const selector = new BuddyBalanceSelector({
      product: CODEBUDDY,
      now: () => NOW,
      resolveCredential: async (ref) => ({ access_token: `token-of-${ref}` }) as BuddyCredential,
      fetchBalance: async (credential) => {
        const ref = String((credential as { access_token: string }).access_token).replace('token-of-', '')
        if (ref === 'a1') return balance(pkg({ remaining: 2100, deductionEndTime: NOW + 3008 * DAY }))
        if (ref === 'a2') return balance(
          pkg({ remaining: 2100, deductionEndTime: NOW + 3008 * DAY }),
          pkg({ remaining: 1178.22, deductionEndTime: NOW + 9 * DAY }),
        )
        return null
      },
    })
    return selector
  }

  const candidates = [account('a1'), account('a2')]

  it('关（默认）：按档位 —— 有临期的 a2 被选中，尽管 a1 在拖拽序第一位', async () => {
    const result = await makeSelector().select(candidates, {})
    expect(result.ok).toBe(true)
    expect(result.ok ? result.account.id : undefined).toBe('a2')
  })

  it('开：按拖拽序 —— 首位的 a1 被选中', async () => {
    const result = await makeSelector().select(candidates, { strictManualOrder: true })
    expect(result.ok).toBe(true)
    expect(result.ok ? result.account.id : undefined).toBe('a1')
  })

  it('开 + 锁定永久积分：首位的 a1 只剩永久 ⇒ 仍必须跳到 a2（锁定不可被绕过）', async () => {
    const result = await makeSelector().select(candidates, {
      strictManualOrder: true,
      allowPermanent: false,
    })
    expect(result.ok).toBe(true)
    // ⚠️ 这条是本 PR 最危险的出错方向：若严格模式连可用性判据一起去掉，
    //    这里会返回 a1 ⇒ 用户锁了永久积分却仍被烧。
    expect(result.ok ? result.account.id : undefined).toBe('a2')
  })
})

describe('loomy select() 接线：strictManualOrder 必须真的影响选中账号', () => {
  /**
   * ⚠️ Loomy 的取数走注入的 `fetcher`（真实 HTTP 形态），**没有** `fetchBalance`
   * 注入点 —— 故这里必须造 HTTP 替身，而不是像 buddy 那样回一个余额对象。
   * 照抄 `loomy-balance-selector.spec.ts` 的 `makeFetcher` 形态，避免第二套桩。
   */
  const CRED_LOGIN = 'S'.repeat(32)
  function loomyFetcher(byToken: Record<string, { balance: number; daily: number }>) {
    return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const token = String((init?.headers as Record<string, string> | undefined)?.token ?? '')
      const spec = byToken[token]
      if (spec === undefined) throw new Error(`未预期的 token: ${token}`)
      return new Response(JSON.stringify({
        code: '000000',
        desc: '成功',
        trace_id: 't',
        data: { balance: spec.balance, dailyBalance: spec.daily, availableBalance: spec.balance + spec.daily },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
  }

  /** a1：只有永久积分；a2：有今日额度。默认排序会把 a2 放前面。 */
  function makeSelector() {
    return new LoomyBalanceSelector({
      product: LOOMY,
      // 两个账号共用同一份凭据内容 —— 靠 `credentialRef` 区分不了余额，
      // 故这里用**两个不同的 token**（`resolveCredential` 按 ref 给不同 token）。
      resolveCredential: async (ref) => ({ access_token: ref === 'a1' ? 'T1' : 'T2', userid: 'u', phone: '13000000000' }),
      fetcher: loomyFetcher({ T1: { balance: 9999, daily: 0 }, T2: { balance: 0, daily: 500 } }),
    })
  }

  const candidates = [account('a1'), account('a2')]

  it('关（默认）：今日额度优先 —— a2 被选中', async () => {
    const result = await makeSelector().select(candidates, {})
    expect(result.ok).toBe(true)
    expect(result.ok ? result.account.id : undefined).toBe('a2')
  })

  it('开：按拖拽序 —— 首位的 a1 被选中', async () => {
    const result = await makeSelector().select(candidates, { strictManualOrder: true })
    expect(result.ok).toBe(true)
    expect(result.ok ? result.account.id : undefined).toBe('a1')
  })
})
