/**
 * CodeBuddy / WorkBuddy 的余额缓存选号器（`src/buddy-balance-selector.ts`）。
 *
 * ## 本文件锁死什么
 *
 * 1. **TTL 缓存**：同一轮对话内的多次选号不重复发余额请求（该端点响应实测可达
 *    数百 KB，一个账号可能有 105 个资源包）。
 * 2. **失败不抛错**：一个号查不到不至于让整个选号失败（凭据过期是最常见原因）。
 * 3. **锁定语义**：只剩永久积分的账号在锁定期间**不被选中**；解锁时不改变既有
 *    行为（全部无余额仍返回第一个，让上游去报真实原因）。
 * 4. **`pickBuddyAccount` 的收尾**：锁定 → `locked`（调用方必须报错，绝不回落，
 *    否则锁定形同虚设）；未锁定 → `exhausted` + tried（调用方继续走池的兜底）。
 */
import { describe, expect, it } from 'vitest'
import {
  BUDDY_BALANCE_CACHE_TTL_MS,
  BUDDY_BALANCE_ERROR_CACHE_TTL_MS,
  BuddyBalanceSelector,
  pickBuddyAccount,
  type BuddyCandidateAccount,
} from '../../src/buddy-balance-selector.js'
import { CODEBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'
import type { CreditBalance, CreditPackage } from '../../src/credits.js'
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)

function pkg(overrides: Partial<CreditPackage> = {}): CreditPackage {
  return {
    name: 'Bonus Pack',
    unit: 'credits',
    remaining: 0,
    total: 0,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    deductionEndTime: NOW + 30 * DAY,
    ...overrides,
  }
}

function balance(...packages: CreditPackage[]): CreditBalance {
  return { total: 0, packages, expiredTotal: 0 }
}

/**
 * 造一个选号器。
 *
 * @param balances - accountId → 返回的余额（`null` = 查询失败，Error = 抛异常）
 * @param options - 凭据解析失败的账号集合、时钟、TTL
 */
function makeSelector(
  balances: Record<string, CreditBalance | null | Error>,
  options: {
    /** 这些账号的凭据解析不出来（模拟凭据缺失/损坏）。 */
    brokenRefs?: readonly string[]
    /** 现在几点（可推进以测 TTL）。 */
    clock?: { value: number }
    ttlMs?: number
    errorTtlMs?: number
  } = {},
) {
  const calls: string[] = []
  const clock = options.clock ?? { value: NOW }
  const selector = new BuddyBalanceSelector({
    product: CODEBUDDY,
    now: () => clock.value,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.errorTtlMs === undefined ? {} : { errorTtlMs: options.errorTtlMs }),
    resolveCredential: async (ref) => {
      if (options.brokenRefs?.includes(ref)) return undefined
      return { access_token: `token-of-${ref}` } as BuddyCredential
    },
    fetchBalance: async (credential) => {
      const ref = String((credential as { access_token: string }).access_token).replace('token-of-', '')
      calls.push(ref)
      const value = balances[ref]
      if (value instanceof Error) throw value
      return value ?? null
    },
  })
  return { selector, calls, clock }
}

const account = (id: string): BuddyCandidateAccount => ({ id, credentialRef: id })

/**
 * `select()` 现在返回判别联合（`{ok:true,…} | {ok:false,reason}`），
 * 断言"选中了谁"统一走这个取值器；断言"为什么没选中"则直接看 `reason`。
 */
const pickedId = (result: Awaited<ReturnType<BuddyBalanceSelector['select']>>): string | undefined =>
  result.ok ? result.account.id : undefined

describe('BuddyBalanceSelector.balanceOf（带 TTL 的余额查询）', () => {
  it('TTL 内不重复请求，过期后重查', async () => {
    const { selector, calls, clock } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
    })
    await selector.balanceOf(account('a1'))
    await selector.balanceOf(account('a1'))
    expect(calls).toEqual(['a1'])

    clock.value += BUDDY_BALANCE_CACHE_TTL_MS + 1
    await selector.balanceOf(account('a1'))
    expect(calls).toEqual(['a1', 'a1'])
  })

  /**
   * ⚠️ **真实缺陷**（用户报障 2026-09-29）：失败结果曾被按成功的那份 60 秒 TTL
   * 缓存 —— 一次网络抖动就让整池在 60 秒内全部判"不可用"，用户被告知
   * 「额度已用尽」而实际号里都有钱（实测当时 4 个 loomy 号：4965/5000/5000/0）。
   * ⇒ 失败是瞬时状态，只该缓存很短的时间。
   */
  it('失败结果只按短 TTL 缓存，5 秒后即重试（不等满 60 秒）', async () => {
    const clock = { value: NOW }
    const flaky: Record<string, CreditBalance | null> = { a1: null }
    const { selector, calls } = makeSelector(flaky, { clock })

    const first = await selector.balanceOf(account('a1'))
    expect(first.ok).toBe(false)

    // 6 秒后（< 60 秒成功 TTL，> 5 秒失败 TTL）：应该重新查一次
    clock.value += BUDDY_BALANCE_ERROR_CACHE_TTL_MS + 1_000
    flaky.a1 = balance(pkg({ remaining: 5000, deductionEndTime: NOW + 9 * DAY }))
    const second = await selector.balanceOf(account('a1'))
    expect(second.ok).toBe(true)
    expect(second.expiringBalance).toBe(5000)
    expect(calls).toEqual(['a1', 'a1'])
  })

  it('失败结果在短 TTL 内不重复请求（防同一轮里反复打）', async () => {
    const clock = { value: NOW }
    const { selector, calls } = makeSelector({ a1: null }, { clock })
    await selector.balanceOf(account('a1'))
    clock.value += BUDDY_BALANCE_ERROR_CACHE_TTL_MS - 1_000
    await selector.balanceOf(account('a1'))
    expect(calls).toEqual(['a1'])
  })

  it('invalidate 指定账号后重查；invalidate 全部同理', async () => {
    const { selector, calls } = makeSelector({
      a1: balance(pkg({ remaining: 1 })),
      a2: balance(pkg({ remaining: 2 })),
    })
    await selector.balanceOf(account('a1'))
    await selector.balanceOf(account('a2'))
    selector.invalidate('a1')
    await selector.balanceOf(account('a1'))
    expect(calls.filter(c => c === 'a1')).toHaveLength(2)
    expect(calls.filter(c => c === 'a2')).toHaveLength(1)

    selector.invalidate()
    await selector.balanceOf(account('a2'))
    expect(calls.filter(c => c === 'a2')).toHaveLength(2)
  })

  it('按账号 id 分键缓存，不同账号各自请求', async () => {
    const { selector, calls } = makeSelector({ a1: balance(), a2: balance() })
    await selector.balanceOf(account('a1'))
    await selector.balanceOf(account('a2'))
    expect(calls).toEqual(['a1', 'a2'])
  })

  /** ⚠️ 凭据不可用时**不发余额请求**，也不抛错（归入最后一档）。 */
  it('凭据解析失败 → ok: false 且不调用余额端点', async () => {
    const { selector, calls } = makeSelector({ a1: balance(pkg({ remaining: 100 })) }, { brokenRefs: ['a1'] })
    const entry = await selector.balanceOf(account('a1'))
    expect(entry.ok).toBe(false)
    expect(entry.error).toContain('凭据未配置')
    expect(calls).toEqual([])
  })

  it('余额端点抛异常 → ok: false（不让一次抖动毁掉整个选号）', async () => {
    const { selector } = makeSelector({ a1: new Error('socket hang up') })
    const entry = await selector.balanceOf(account('a1'))
    expect(entry.ok).toBe(false)
    expect(entry.error).toContain('socket hang up')
  })

  it('余额查询返回 null → ok: false（与「余额为 0」严格区分）', async () => {
    const { selector } = makeSelector({ a1: null })
    const entry = await selector.balanceOf(account('a1'))
    expect(entry.ok).toBe(false)
    expect(entry.expiringBalance).toBeUndefined()
    expect(entry.permanentBalance).toBeUndefined()
  })

  it('成功时按到期时间拆出两桶并给出档位', async () => {
    const { selector } = makeSelector({
      a1: balance(
        pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY }),
        pkg({ name: 'Free Plan Subscription', remaining: 100, deductionEndTime: NOW + 3008 * DAY }),
      ),
    })
    const entry = await selector.balanceOf(account('a1'))
    expect(entry.ok).toBe(true)
    expect(entry.split).toEqual({ expiring: 250, permanent: 100 })
    expect(entry.tier).toBe(0) // expiring
  })

  /**
   * ⚠️ 未显式注入窗口时，选号器必须**按环境变量解析**窗口。
   *
   * 实测中国版 CodeBuddy 的裂变包剩余密集落在 17～30 天：默认 15 天下整池
   * 判成永久（锁定即无可用账号），放宽到 31 天才能用。若这里把窗口写死，
   * 用户设了环境变量也不生效，而且报错文案（运行时解析）会与选号判据分叉。
   */
  /**
   * ⚠️ **本文件最重要的一条**：TTL 只抑制网络，不冻结分类。
   *
   * 「临时 / 永久」是 `DeductionEndTime - now` 与 15 天的比较结果，而宿主长期开着、
   * 时间只向前流 —— 一笔 15 天 + 30 秒的余额，30 秒后就越过了线。此时缓存还没过期
   * （60 秒），**绝不能**把上一次的分桶结果原样返回：那会让选号继续按「永久」处理
   * 一笔其实马上要作废的积分（锁定时更糟：本该可用的号被判成不可用）。
   */
  it('TTL 内命中缓存也按新时刻重新分类，且不重发请求', async () => {
    const clock = { value: NOW }
    const { selector, calls } = makeSelector(
      {
        // 距到期 = 15 天 + 30 秒：此刻还算永久
        a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 15 * DAY + 30_000 })),
      },
      { clock },
    )

    const first = await selector.balanceOf(account('a1'))
    expect(first.split).toEqual({ expiring: 0, permanent: 100 })
    expect(first.tier).toBe(1) // permanent

    // 时间前进 40 秒（< 60 秒 TTL）⇒ 距到期 15 天 − 10 秒 ⇒ 改判临时
    clock.value += 40_000
    const second = await selector.balanceOf(account('a1'))
    expect(second.split).toEqual({ expiring: 100, permanent: 0 })
    expect(second.tier).toBe(0) // expiring
    // 分类变了，但一次网络都没多发 —— 缓存的是原料
    expect(calls).toEqual(['a1'])
  })

  /** 锁定判据同理：越线的号在锁定时应立刻变成可用，不需要等 TTL 过期。 */
  it('锁定选号读到的是按当前时刻重算的档位（缓存未过期也生效）', async () => {
    const clock = { value: NOW }
    const { selector, calls } = makeSelector(
      { a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 15 * DAY + 30_000 })) },
      { clock },
    )
    // 此刻只剩永久积分 ⇒ 锁定时不可用（且是"确实用尽"，不是查不到）
    const blocked = await selector.select([account('a1')], { allowPermanent: false })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toEqual({ kind: 'exhausted' })

    clock.value += 40_000
    const picked = await selector.select([account('a1')], { allowPermanent: false })
    expect(picked.ok && picked.account.id).toBe('a1')
    expect(calls).toEqual(['a1'])
  })

  /**
   * 窗口同样每次重读：用户改了 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 不该等 TTL 过期。
   * 提示文案（运行时解析 env）与选号判据必须同一时刻取到同一个值。
   */
  it('改窗口 env 后立即生效（不必等缓存过期）', async () => {
    const previous = process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
    try {
      delete process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
      const { selector } = makeSelector({
        a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 17 * DAY })),
      })
      expect((await selector.balanceOf(account('a1'))).split).toEqual({ expiring: 0, permanent: 100 })

      process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = '31'
      expect((await selector.balanceOf(account('a1'))).split).toEqual({ expiring: 100, permanent: 0 })
    } finally {
      if (previous === undefined) delete process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
      else process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = previous
    }
  })

  it('未注入 windowMs 时按 DSH_BUDDY_EXPIRING_WINDOW_DAYS 解析', async () => {
    const previous = process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
    try {
      process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = '31'
      const { selector } = makeSelector({
        a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 17 * DAY })),
      })
      const entry = await selector.balanceOf(account('a1'))
      expect(entry.split).toEqual({ expiring: 100, permanent: 0 })
    } finally {
      if (previous === undefined) delete process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
      else process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = previous
    }
  })

  it('默认窗口（15 天）下同一笔包算永久', async () => {
    const previous = process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
    try {
      delete process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
      const { selector } = makeSelector({
        a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 17 * DAY })),
      })
      const entry = await selector.balanceOf(account('a1'))
      expect(entry.split).toEqual({ expiring: 0, permanent: 100 })
      // 锁定 ⇒ 该号不可用（中国版那种池的真实处境）
      const picked = await selector.select([account('a1')], { allowPermanent: false })
      expect(picked.ok).toBe(false)
    } finally {
      if (previous !== undefined) process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = previous
    }
  })
})

describe('BuddyBalanceSelector.select（分档选号）', () => {
  /**
   * ⚠️ **空候选的原因必须与「查到了、确实是 0」分开**（真实报障 2026-10-13）。
   *
   * 候选为空 = **余额分档一次都没跑**，我们对任何账号的余额一无所知；
   * 报 `exhausted` 是在替服务端断言一件从没查过的事。真实场景：全部账号被
   * 目标模型限流 → `candidatesOf` 把它们全滤掉 → 报「积分都已用尽」，
   * 用户据此去解锁永久积分（而解禁时刻就在 `modelRateLimits` 里）。
   *
   * 变异：把 `select()` 空候选那一支改回 `{ kind: 'exhausted' }` ⇒ 红。
   */
  it('空候选返回 ok:false 且原因是 no-candidates（**不是**查询失败、也不是「已用尽」）', async () => {
    const { selector } = makeSelector({})
    const result = await selector.select([], {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toEqual({ kind: 'no-candidates' })
  })

  it('优先选「有 15 天内到期积分」的号，即使它排在后面', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ name: '套餐', remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
      a2: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
    })
    const picked = await selector.select([account('a1'), account('a2')], {})
    expect(pickedId(picked)).toBe('a2')
  })

  /** ⚠️ 锁定语义的核心：只剩永久积分的账号**不能被选中**。 */
  it('锁定时只剩永久积分的账号不被选中', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ name: '套餐', remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
    })
    const result = await selector.select([account('a1')], { allowPermanent: false })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toEqual({ kind: 'exhausted' })
  })

  /**
   * ⚠️ **真实缺陷**（用户报障 2026-09-29）：一次网络抖动让所有号的余额都查失败，
   * 结果被判「今日额度都已用尽」，用户于是去解锁 / 白等，而号其实都有钱。
   * ⇒ 有号查询失败时，原因必须是 `unknown`（无法判定），不能报成"用尽"。
   */
  it('有号查询失败时原因是 unknown（不谎报"额度已用尽"）', async () => {
    const { selector } = makeSelector({
      a1: null,
      a2: balance(pkg({ remaining: 0, deductionEndTime: NOW + 3008 * DAY })),
    })
    const result = await selector.select([account('a1'), account('a2')], { allowPermanent: false })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason.kind).toBe('unknown')
      if (result.reason.kind === 'unknown') {
        expect(result.reason.errors).toHaveLength(1)
        expect(result.reason.errors[0]).toContain('余额查询失败')
      }
    }
  })

  /** 全部查到且确实都是 0 ⇒ 才是"用尽"。 */
  it('全部查到且为 0 时原因是 exhausted', async () => {
    const { selector } = makeSelector({ a1: balance(), a2: balance() })
    const result = await selector.select([account('a1'), account('a2')], { allowPermanent: false })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toEqual({ kind: 'exhausted' })
  })

  it('锁定时有临时积分的号仍可被选中', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
    })
    const picked = await selector.select([account('a1')], { allowPermanent: false })
    expect(pickedId(picked)).toBe('a1')
  })

  it('锁定时跳过只剩永久积分的号，选下一个有临时积分的', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ name: '套餐', remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
      a2: balance(pkg({ remaining: 100, deductionEndTime: NOW + 12 * DAY })),
    })
    const picked = await selector.select([account('a1'), account('a2')], { allowPermanent: false })
    expect(pickedId(picked)).toBe('a2')
  })

  /**
   * ⚠️ **解锁时必须保持既有行为**：所有账号余额都是 0 时仍返回第一个候选
   * （让上游报真实的失败原因），不能因为加了锁定功能而改变。
   */
  it('解锁时全部无余额仍返回第一个（不改变既有行为）', async () => {
    const { selector } = makeSelector({ a1: balance(), a2: balance() })
    const picked = await selector.select([account('a1'), account('a2')], {})
    expect(pickedId(picked)).toBe('a1')
  })

  it('未锁定时只剩永久积分的号仍可用（永久积分未被锁住）', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
    })
    const picked = await selector.select([account('a1')], {})
    expect(pickedId(picked)).toBe('a1')
  })

  it('查询失败的号排在最后（能确认余额的号优先）', async () => {
    const { selector } = makeSelector({ a1: null, a2: balance(pkg({ remaining: 1, deductionEndTime: NOW + 9 * DAY })) })
    const picked = await selector.select([account('a1'), account('a2')], { allowPermanent: false })
    expect(pickedId(picked)).toBe('a2')
  })

  it('并发查所有候选（一轮只发 N 次，不串行放大）', async () => {
    const { selector, calls } = makeSelector({ a1: balance(), a2: balance(), a3: balance() })
    await selector.select([account('a1'), account('a2'), account('a3')], {})
    expect(calls).toHaveLength(3)
  })
})

describe('pickBuddyAccount（选号 + 取凭据的编排）', () => {
  /** 编排层的凭据解析器（与 selector 内部那份可以不同）。 */
  const resolver = (broken: readonly string[] = []) => async (ref: string) =>
    broken.includes(ref) ? undefined : ({ access_token: `t-${ref}` } as BuddyCredential)

  it('选中账号后返回其凭据', async () => {
    const { selector } = makeSelector({ a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })) })
    const result = await pickBuddyAccount(selector, [account('a1')], {
      allowPermanent: true,
      resolveCredential: resolver(),
    })
    expect(result.kind).toBe('account')
    if (result.kind !== 'account') return
    expect(result.account.id).toBe('a1')
    expect(result.credential.access_token).toBe('t-a1')
    expect(result.tried.size).toBe(0)
  })

  /** ⚠️ 选号只看余额，**不保证凭据能解析** —— 必须换下一个候选而不是失败。 */
  it('首选凭据损坏时换下一个候选', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
      a2: balance(pkg({ remaining: 100, deductionEndTime: NOW + 10 * DAY })),
    })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: true,
      resolveCredential: resolver(['a1']),
    })
    expect(result.kind).toBe('account')
    if (result.kind !== 'account') return
    expect(result.account.id).toBe('a2')
    expect(result.tried).toEqual(new Set(['a1']))
  })

  it('未锁定且全部凭据不可解析 → exhausted 并带上 tried（调用方继续走池兜底）', async () => {
    const { selector } = makeSelector({ a1: balance(), a2: balance() })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: true,
      resolveCredential: resolver(['a1', 'a2']),
    })
    expect(result.kind).toBe('exhausted')
    expect(result.tried).toEqual(new Set(['a1', 'a2']))
  })

  /**
   * ⚠️ **锁定时绝不返回可继续兜底的信号** —— 调用方若拿 `getAvailableAccount`
   * 兜底就会绕过锁定、照样消耗永久积分，使锁定形同虚设。
   */
  it('锁定且全部只剩永久积分 → locked', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
      a2: balance(pkg({ remaining: 50, deductionEndTime: NOW + 30 * DAY })),
    })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: false,
      resolveCredential: resolver(),
    })
    expect(result.kind).toBe('locked')
    expect(result.tried).toEqual(new Set())
  })

  it('锁定：有临时积分的号凭据坏了，仍会继续试下一个有临时积分的号', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
      a2: balance(pkg({ remaining: 30, deductionEndTime: NOW + 14 * DAY })),
      a3: balance(pkg({ remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
    })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2'), account('a3')], {
      allowPermanent: false,
      resolveCredential: resolver(['a1']),
    })
    expect(result.kind).toBe('account')
    if (result.kind !== 'account') return
    expect(result.account.id).toBe('a2')
    // 只剩永久积分的 a3 绝不会被选中
    expect(result.tried).toEqual(new Set(['a1']))
  })

  it('锁定：有临时积分的号都坏 → locked（绝不退到只剩永久的号）', async () => {
    const { selector } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
      a2: balance(pkg({ remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
    })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: false,
      resolveCredential: resolver(['a1']),
    })
    expect(result.kind).toBe('locked')
    expect(result.tried).toEqual(new Set(['a1']))
  })

  /**
   * ⚠️ 空候选**不查余额**（一次网络都不发），且原因与「查到了、确实是 0」分开。
   *
   * 变异：去掉 `pickBuddyAccount` 开头对 `candidates.length === 0` 的定因
   * （让 `reason` 保持 `undefined`）⇒ 本条红（`reason` 变 undefined）。
   */
  it('空候选不查余额，且带上 no-candidates 原因（未锁定也如此）', async () => {
    const { selector, calls } = makeSelector({ a1: balance() })
    const result = await pickBuddyAccount(selector, [], {
      allowPermanent: true,
      resolveCredential: resolver(),
    })
    expect(result.kind).toBe('exhausted')
    expect(result.reason).toEqual({ kind: 'no-candidates' })
    expect(calls).toEqual([])
  })

  /**
   * ★ **2026-10-14 审计实测打穿的漏网路径**：候选**非空**、余额分档也**真的跑过
   * 且每次都选出了「可用档」的号** —— 只是那些号的**凭据读不出来**。
   *
   * 修复前 `reason` 会保持 `undefined`（循环里只在 `!picked.ok` 时赋值），
   * 调用方的 `?? { kind: 'exhausted' }` 于是报「所有账号的 N 天内到期积分都已用尽」。
   * 而 `ok:true` **本身就证明**该号落在可用档（锁定时只有 `expiring` 为真）——
   * 我们刚刚查到它有钱，那句文案是**自相矛盾**的，且会把用户推向
   * 「解锁永久积分」（不可撤回地烧钱）。
   *
   * ⚠️ 可达性（三条路径都真实，不是构造）：
   * ① 余额缓存 60s TTL 命中（上一轮查过「该号有临期积分」），凭据在这 60 秒内失效；
   * ② 多候选时 `select()` 逐个排除「档位最优但凭据坏」的号，耗尽后 `reason` 缺席；
   * ③ 单候选最直接：一次 `select()` 就选出了那个有临期积分的号。
   *
   * 变异：把结尾的 `if (reason === undefined) reason = { kind: 'credential-only' }`
   * 删掉 ⇒ 本条红（`reason` 变 `undefined`）。
   */
  it('★ 分档选出了有临期积分的号、但凭据全读不出来 ⇒ credential-only（**不是**「已用尽」）', async () => {
    const { selector, calls } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
      a2: balance(pkg({ remaining: 240, deductionEndTime: NOW + 8 * DAY })),
    })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: false,
      // 凭据一律解析不出来 —— 但余额**确实查到了**（下面的 `calls` 自证）。
      resolveCredential: resolver(['a1', 'a2']),
    })
    expect(result.kind).toBe('locked')
    expect(
      result.reason,
      '分档已证明这些号有临期积分 ⇒ 不得报「已用尽」，必须如实报凭据问题',
    ).toEqual({ kind: 'credential-only' })
    // ⚠️ **前提自证**：余额真的查过（否则本条会退化成「没查就报凭据」的假覆盖）。
    expect(calls, '余额必须真的查过，本条才是在测「查到了但凭据坏」').toEqual(['a1', 'a2'])
    expect(result.tried, '两个号都被凭据挡下').toEqual(new Set(['a1', 'a2']))
  })

  it('★ 单候选版本：一次 select 就选出有临期积分的号，凭据坏 ⇒ credential-only', async () => {
    const { selector, calls } = makeSelector({
      a1: balance(pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })),
    })
    const result = await pickBuddyAccount(selector, [account('a1')], {
      allowPermanent: false,
      resolveCredential: resolver(['a1']),
    })
    expect(result.kind).toBe('locked')
    expect(result.reason).toEqual({ kind: 'credential-only' })
    expect(calls).toEqual(['a1'])
  })

  /**
   * ⚠️ **阳性对照：真的用尽时必须仍是 `exhausted`**（不得被上一条的修复吞掉）。
   *
   * 全部候选的临期积分**确实都是 0**（`select()` 返回 `ok:false`）时，
   * 那句「积分都已用尽」有事实依据 —— 必须原样保留。
   *
   * 变异：把 `select()` 的 `noAccountReason` 改成恒返回 `credential-only` ⇒ 本条红。
   */
  it('⚠️ 阳性对照：分档报 ok:false（真的没积分）⇒ 仍是 exhausted，不得被 credential-only 吞掉', async () => {
    const { selector } = makeSelector({
      // 只有永久积分 + 锁定 ⇒ `select()` 判 none 档，返回 ok:false
      a1: balance(pkg({ remaining: 100, deductionEndTime: NOW + 3008 * DAY })),
    })
    const result = await pickBuddyAccount(selector, [account('a1')], {
      allowPermanent: false,
      resolveCredential: resolver(),
    })
    expect(result.kind).toBe('locked')
    expect(result.reason).toEqual({ kind: 'exhausted' })
  })
})

/**
 * `fetchBalanceDetailed`（带原因变体）—— 修的是**真实报障**（2026-10-21，Qoder）。
 *
 * 用户原话是两条互相矛盾的观察：
 * ```
 * 面板：连不上 https://openapi.qoder.sh（UND_ERR_CONNECT_TIMEOUT）…请导出 HTTPS_PROXY
 * 报错：余额查询失败（凭据失效或响应异常）
 * ```
 * ⇒ 同一份数据，**面板说得明明白白，报错里反而无从下手**。
 *
 * 根因：选号这条腿只注入 `fetchBalance`（`CreditBalance | null`），`null` 把
 * 「网络不通 / 401 / 响应缺字段 / 不是 JSON」四件事抹成同一格。
 *
 * ⚠️ 这些用例守的是**契约**（选号器必须把 `error` 透传出来），不是某家 provider
 * 的文案 —— 文案在各自 `*-credits.ts` 里，由那家的 spec 守。
 */
describe('BuddyBalanceSelector：fetchBalanceDetailed（锁定时必须说出「为什么查不到」）', () => {
  const pickWith = async (
    balanceImpl: Parameters<typeof makeDetailedSelector>[0],
    ids: readonly string[] = ['a1'],
  ) => {
    const { selector } = makeDetailedSelector(balanceImpl)
    return pickBuddyAccount(selector, ids.map(account), {
      allowPermanent: false,
      resolveCredential: async () => ({ access_token: 'tok' }) as BuddyCredential,
    })
  }

  it('★★ 详细变体的 error 必须原样进 reason.errors（不许退化成那句概括文案）', async () => {
    const result = await pickWith({
      balance: null,
      error: '连不上 https://openapi.qoder.sh（UND_ERR_CONNECT_TIMEOUT）：请导出 HTTPS_PROXY',
    })
    expect(result.kind).toBe('locked')
    // @ts-expect-error 本分支必然是 unknown（见上一行断言）
    expect(result.reason.kind).toBe('unknown')
    // @ts-expect-error 同上
    expect(result.reason.errors).toEqual([
      '连不上 https://openapi.qoder.sh（UND_ERR_CONNECT_TIMEOUT）：请导出 HTTPS_PROXY',
    ])
    // ⚠️ 反向断言：那句会把用户引向「查凭据」的概括文案**不得**出现
    // @ts-expect-error 同上
    expect(result.reason.errors.join('\n')).not.toContain('凭据失效或响应异常')
  })

  it('★ 传了详细变体就不再调 fetchBalance（严格超集，不许两条腿各查一次）', async () => {
    const { thin } = await (async () => {
      const calls: string[] = []
      const selector = new BuddyBalanceSelector({
        product: CODEBUDDY,
        now: () => NOW,
        resolveCredential: async () => ({ access_token: 'tok' }) as BuddyCredential,
        fetchBalance: async () => { calls.push('thin'); return null },
        fetchBalanceDetailed: async () => ({ balance: null, error: '查不到的原因' }),
      })
      await selector.select([account('a1')], { allowPermanent: false })
      return { thin: calls }
    })()
    expect(thin).toEqual([])
  })

  it('详细变体给了 balance ⇒ 正常分档，error 被忽略（有余额时不该报失败）', async () => {
    const result = await pickWith({
      balance: balance(pkg({ remaining: 500, deductionEndTime: NOW + 3 * DAY })),
      error: '这条不该被读到',
    })
    expect(result.kind).toBe('account')
    expect(result.kind === 'account' ? result.account.id : undefined).toBe('a1')
  })

  it('⚠️ 详细变体返回 null 但**没给** error ⇒ 报「未提供具体原因」，不得回落概括文案', async () => {
    const result = await pickWith({ balance: null })
    expect(result.kind).toBe('locked')
    // @ts-expect-error 同上
    expect(result.reason.errors).toEqual(['余额查询失败（未提供具体原因）'])
    // @ts-expect-error 同上
    expect(result.reason.errors.join('\n')).not.toContain('凭据失效或响应异常')
  })

  it('⚠️ 详细变体**抛错**仍是「余额查询异常：<message>」（异常腿不许被吞）', async () => {
    const result = await pickWith(new Error('boom'))
    expect(result.kind).toBe('locked')
    // @ts-expect-error 同上
    expect(result.reason.errors).toEqual(['余额查询异常：boom'])
  })

  it('未传详细变体时行为不变（仍报概括文案）—— 保证既有 provider 不受影响', async () => {
    const selector = new BuddyBalanceSelector({
      product: CODEBUDDY,
      now: () => NOW,
      resolveCredential: async () => ({ access_token: 'tok' }) as BuddyCredential,
      fetchBalance: async () => null,
    })
    const result = await pickBuddyAccount(selector, [account('a1')], {
      allowPermanent: false,
      resolveCredential: async () => ({ access_token: 'tok' }) as BuddyCredential,
    })
    // @ts-expect-error locked 分支一定有 reason
    expect(result.reason.errors).toEqual(['余额查询失败（凭据失效或响应异常）'])
  })
})

/**
 * ⚠️⚠️ 2026-11-04 真机报障「**模型都选不了了**」的直接成因：
 * 面板上「永久积分」锁定开着 + 余额接口被上游网关整片拒绝（真机国内站 403、
 * 国际站 405，九个账号无一幸免）⇒ 每个账号都 `unknown` ⇒ 调用方抛 `lockedError`
 * ⇒ **整个 provider 的模型列表被清空**，模型选择器里只剩一大段错误文案。
 *
 * 判据必须**两向**：开了开关时「查不到」要放行；但「查得到且只剩永久桶」
 * **仍必须报 locked** —— 否则这个开关就成了绕过锁定的后门。
 */
describe('★★ 锁定 + 余额查不到：degradeOnUnknown 开关', () => {
  // ⚠️ 名字刻意的：本 describe 里另有「按 accountId 路由余额」的外层 `makeSelector`
  //    （文件顶部），两者签名不同 —— 同名遮蔽会让新用例静默拿到错误的造数器
  //    （实测：`const { selector } = makeSelector(...)` 解构成 `undefined`）。
  const makeSingleAccountSelector = (fetchBalance: () => Promise<CreditBalance | null>) =>
    new BuddyBalanceSelector({
      product: CODEBUDDY,
      now: () => NOW,
      resolveCredential: async () => ({ access_token: 'tok' }) as BuddyCredential,
      fetchBalance,
    })

  const pick = async (
    fetchBalance: () => Promise<CreditBalance | null>,
    degradeOnUnknown: boolean,
  ) => await pickBuddyAccount(makeSingleAccountSelector(fetchBalance), [account('a1')], {
    allowPermanent: false,
    resolveCredential: async () => ({ access_token: 'tok' }) as BuddyCredential,
    degradeOnUnknown,
  })

  // ⚠️ 2026-11-05 红队：原名写「默认（不传开关）」，但实参是 `false`（`degradeOnUnknown`
  //    的类型是 `boolean`，**传不了 `undefined`**）⇒ 名不符实。「不传」的语义由
  //    `fetchBalanceDetailed` 那组的分支 4 覆盖（G3-M3 打红 4 条），这里改名说清。
  it('显式传 false：锁定 + 查不到 ⇒ locked —— 既有语义逐字不变', async () => {
    const result = await pick(async () => null, false)
    expect(result.kind).toBe('locked')
  })

  it('★★ 开关打开：锁定 + 查不到 ⇒ 放宽一次、返回账号（渠道不再整条不可用）', async () => {
    const result = await pick(async () => null, true)
    expect(result.kind).toBe('account')
    expect(result.kind === 'account' ? result.account.id : undefined).toBe('a1')
  })

  it('★★ ★★ 余额**查得到**且只剩永久桶 ⇒ 即使开了开关也必须 locked（降级不得绕过锁定）', async () => {
    const permanentOnly = async () =>
      balance(pkg({ remaining: 800, deductionEndTime: '2099-01-01T00:00:00.000Z' }))
    const result = await pick(permanentOnly, true)
    expect(result.kind).toBe('locked')
  })

  /**
   * ⚠️⚠️ **混合形态：降级不得把「明确只剩永久积分」的账号一起放行**
   *（2026-11-05 三审回归面 P1-1，`631f1c8` 引入的回归）。
   *
   * `noAccountReason` 是**池级**判据（任一账号查不到即 `unknown`），而降级分支
   * 会把 `allowPermanent` **全局**置真 ⇒ 重排时 `buddyBalanceTier` 对
   * 「`expiring = 0` 且 `permanent > 0`」的账号返回 `permanent`（可用）
   * ⇒ 该账号被选中 ⇒ **用户明明关掉了「消耗永久积分」却被烧**。
   *
   * 实测（真实 `lib/` 链路）：`degrade=false` 得 `locked`，`degrade=true` 得
   * `account a2 (tier=permanent)`。上面三条单账号用例**全部抓不到**这一格。
   *
   * ⇒ 修法是 `select()` 在进入降级分支前先判 `definitive`（存在「余额查得到且
   * 只剩永久」的账号 ⇒ 报 `exhausted`，不降级）。
   */
  it('★★ ★★ 混合形态：一个查不到 + 一个明确只剩永久 ⇒ 必须 locked（不得烧永久积分）', async () => {
    const { selector } = makeSelector({
      a1: null,
      a2: balance(pkg({ remaining: 800, deductionEndTime: '2099-01-01T00:00:00.000Z' })),
    })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: false,
      resolveCredential: async (ref) => ({ access_token: `token-of-${ref}` }) as BuddyCredential,
      degradeOnUnknown: true,
    })
    expect(result.kind).toBe('locked')
  })

  /**
   * ⚠️⚠️ **「降级读数」也不得被降级放行**（2026-11-05 对抗审计 P2-1）。
   *
   * `noAccountReason` 把两种语义都归 `unknown`：
   * - `!ok` ⇒ 真的查不到；
   * - `ok && degraded === true` ⇒ **总额读到了、逐包明细丢了**（分类不可信）。
   *
   * 而 `definitive` 守卫刻意 `&& entry.degraded !== true` 把降级账号**排除在**
   * `definitive` **之外** ⇒ 降级读数恰好落进「unknown」⇒ 降级分支放行 ⇒ 按
   * 「永久积分」烧。而明细丢失时「有临期积分」本就可能被误判成「只剩永久积分」
   * ⇒ 这正是 `noAccountReason` 那段注释要防的事。
   *
   * ⚠️ 当前生产不可达（`degraded: true` 只由 `autoclaw-credits.ts` 产出，而
   * `degradeLockedWhenUnknown` 只在 magicrew 两站开）⇒ 仍要钉住，否则将来
   * 接上 autocalw 那条腿时静默烧永久积分。
   */
  it('★★ ★★ 降级读数（总额读到、明细丢失）⇒ 不得被降级放行（不得烧永久积分）', async () => {
    const { selector } = makeSelector({
      a1: null,
      // ⚠️ `degraded: true` = 总额可信、逐包到期信息不可用 ⇒ 拆分出的「永久桶」
      //    可能其实是「明明有临期、但我们看不到」。
      a2: { ...balance(pkg({ remaining: 800 })), degraded: true },
    })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: false,
      resolveCredential: async (ref) => ({ access_token: `token-of-${ref}` }) as BuddyCredential,
      degradeOnUnknown: true,
    })
    expect(result.kind).toBe('locked')
  })

  it('★ 混合形态的反向对照：查不到的账号仍可被降级放行（不得因上一格而拒绝全部）', async () => {
    // ⚠️ 没有这条，把 `definitive` 写成恒真（`return true`）也全绿 ——
    // 那会让「纯查不到」的池也永远报 locked，降级开关彻底失效。
    const { selector } = makeSelector({ a1: null, a2: null })
    const result = await pickBuddyAccount(selector, [account('a1'), account('a2')], {
      allowPermanent: false,
      resolveCredential: async (ref) => ({ access_token: `token-of-${ref}` }) as BuddyCredential,
      degradeOnUnknown: true,
    })
    expect(result.kind).toBe('account')
  })
})

/** 只注入 `fetchBalanceDetailed` 的选号器（`balanceImpl` 为 `Error` 时抛错）。 */
function makeDetailedSelector(
  balanceImpl: { balance: CreditBalance | null; error?: string } | Error,
) {
  return {
    selector: new BuddyBalanceSelector({
      product: CODEBUDDY,
      now: () => NOW,
      resolveCredential: async () => ({ access_token: 'tok' }) as BuddyCredential,
      fetchBalanceDetailed: async () => {
        if (balanceImpl instanceof Error) throw balanceImpl
        return balanceImpl
      },
    }),
  }
}
