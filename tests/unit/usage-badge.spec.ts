import { describe, expect, it } from 'vitest'
import {
  BADGE_FAILURE_TTL_MS,
  BADGE_TTL_MS,
  DSH_JET_HUB_BADGE_TTL_MS,
  badgeFailureTtlMs,
  badgeTtlMs,
  createUsageBadge,
  type UsageBadgeDeps,
} from '../../src/usage-badge.js'
import type { CreditBalance, CreditPackage } from '../../src/credits.js'
import type {
  BadgePreference,
} from '../../src/badge-preferences.js'
import type {
  ProviderAccountEntry,
  RpcCreditsBalanceAccount,
  RpcCreditsBalancesResponse,
  RpcClineQuotaResponse,
} from '../../src/types.js'

/**
 * 用量徽标宿主侧（`usage.badge` 背后的聚合服务）的行为回归。
 *
 * 锁四件事，每件都对应一个真实会出问题的场景：
 * 1. **只算启用账号**，停用账号既不进合计也不进明细（`disabledCount` 说明）；
 * 2. **TTL 缓存**：徽标按分钟轮询，而余额是逐账号打上游的（不缓存会放大请求）；
 * 3. **失败与「读数为 0」分开**：单账号失败保留原因，整批失败回错误信封；
 * 4. **订阅与余额互不连坐**：订阅查询失败只让订阅缺席。
 */

/** 构造账号池条目。 */
function account(id: string, enabled = true): ProviderAccountEntry {
  return {
    id,
    provider: 'buddy',
    nickname: id,
    enabled,
    credentialRef: `${id.toUpperCase()}_REF`,
    createdAt: 1,
    refreshable: true,
  }
}

/** 构造一个资源包。 */
function pkg(name: string, remaining: number, total = remaining, extra: Partial<CreditPackage> = {}): CreditPackage {
  return {
    name,
    unit: 'credits',
    remaining,
    total,
    used: Math.max(0, total - remaining),
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    ...extra,
  }
}

/** 构造余额。 */
function balance(packages: CreditPackage[], total?: number): CreditBalance {
  return { total: total ?? packages.reduce((sum, item) => sum + item.remaining, 0), packages, expiredTotal: 0 }
}

/** 构造一行余额读数。 */
function balanceRow(accountId: string, value: CreditBalance | null, error?: string): RpcCreditsBalanceAccount {
  return { accountId, nickname: accountId, balance: value, ...error === undefined ? {} : { error } }
}

/** 可注入的依赖桩 + 调用计数 + 可控时钟。 */
function harness(options: {
  balances?: RpcCreditsBalancesResponse | { error: { code: string; message: string } }
  quota?: RpcClineQuotaResponse | { error: { code: string; message: string } } | 'throw' | undefined
  accounts?: ProviderAccountEntry[]
  preference?: BadgePreference
  /** 锁定永久积分状态（用户 2026-11-18 报障的那个字段）。 */
  locked?: boolean
  now?: () => number
} = {}) {
  const calls = { balances: 0, quota: 0, preference: 0, balanceAccountIds: [] as (string[] | null)[] }
  const state = {
    balances: options.balances ?? { accounts: [balanceRow('a', balance([pkg('Bonus Pack', 100)]))] },
    quota: options.quota as RpcClineQuotaResponse | { error: { code: string; message: string } } | 'throw' | undefined,
    accounts: options.accounts ?? [account('a')],
    preference: options.preference ?? ('auto' as BadgePreference),
  }
  const deps: UsageBadgeDeps = {
    // ⚠️ 桩必须**复刻真实端点的裁剪语义**（2026-10-15 加 `accountIds`）：真实
    //    `credits.balances` 会按它过滤账号行。桩若忽略它，用例就会看到「停用账号
    //    也在结果里」—— 那是**桩与实现语义不一致**造成的假红（我第一版正是如此）。
    //    ⚠️ 同时记录**每次调用传了什么** ⇒ 用例可以断言「徽标真的只要求启用账号」
    //    （那才是本改动的收益：只断言结果看不出「少查了几个号」）。
    collectBalances: async (_provider: string, accountIds?: readonly string[]) => {
      calls.balances += 1
      calls.balanceAccountIds.push(accountIds === undefined ? null : [...accountIds])
      if ('error' in state.balances) return { ok: false as const, error: state.balances.error }
      const wanted = accountIds === undefined ? undefined : new Set(accountIds)
      const rows = wanted === undefined
        ? state.balances.accounts
        : state.balances.accounts.filter((row) => wanted.has(row.accountId))
      return { ok: true as const, value: { ...state.balances, accounts: rows } }
    },
    collectQuota: async () => {
      calls.quota += 1
      if (state.quota === undefined) return undefined
      if (state.quota === 'throw') throw new Error('quota boom')
      return 'error' in state.quota
        ? { ok: false as const, error: state.quota.error }
        : { ok: true as const, value: state.quota }
    },
    listAccounts: () => state.accounts,
    /**
     * ★ 「锁定永久积分」状态（2026-11-18 加）。
     *
     * ⚠️ 这是**真实缺陷的守卫锚点**：徽标响应此前从未回传 `locked`
     *    ⇒ 客户端「可用/总」永不显示。桩返回注入值，用例断言它出现在响应里。
     */
    readLocked: () => options.locked === true,
    readPreference: () => { calls.preference += 1; return state.preference },
    /**
     * 「每日首次启动自动签到」的实时状态（顺带回传给弹窗右上角的状态灯）。
     *
     * ⚠️ 它是**必填**依赖（装配层永远能提供），故这里给一个固定桩而不是让它可选 ——
     * 可选会让「忘了接线」表现为「状态灯永远是关闭」，静默降级。
     */
    readAutoCheckin: () => ({
      enabled: false, lastDate: '', ranToday: false, running: false, lastResult: '',
    }),
    now: options.now,
    // 用例显式指定 TTL，避免受环境变量影响
    ttlMs: 1_000,
    failureTtlMs: 100,
  }
  return { deps, calls, state, badge: createUsageBadge(deps) }
}

describe('createUsageBadge：账号过滤', () => {
  it('只保留启用账号，并给出被停用的数量', async () => {
    const { badge } = harness({
      accounts: [account('a', true), account('b', false), account('c', true)],
      balances: {
        accounts: [
          balanceRow('a', balance([pkg('Bonus Pack', 100)])),
          balanceRow('b', balance([pkg('Bonus Pack', 999)])),
          balanceRow('c', balance([pkg('Bonus Pack', 50)])),
        ],
      },
    })
    const result = await badge.read('buddy')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.accounts.map((row) => row.accountId)).toEqual(['a', 'c'])
    expect(result.value.disabledCount).toBe(1)
    expect(result.value.preference).toBe('auto')
  })

  it('★★ 徽标**只要求**启用账号的读数（2026-10-15，规格 §7-8：停用账号少查）', async () => {
    // ⚠️⚠️ 判据必须是**传给端点的 accountIds**，而不是「结果里没有 b」——
    //    后者在「查全部再过滤」的旧实现下同样成立（我第一版就只断言了结果，
    //    那样本改动**零守卫**：把取号改回「不传 accountIds」用例照样绿）。
    //    收益恰恰在于**少发请求**，故必须断言请求本身。
    const { badge, calls } = harness({
      accounts: [account('a', true), account('b', false), account('c', true)],
      balances: {
        accounts: [
          balanceRow('a', balance([pkg('Bonus Pack', 100)])),
          balanceRow('b', balance([pkg('Bonus Pack', 999)])),
          balanceRow('c', balance([pkg('Bonus Pack', 50)])),
        ],
      },
    })
    await badge.read('buddy')
    expect(calls.balanceAccountIds, '★ 必须传启用账号的 id（b 是停用的，不该被查）')
      .toEqual([['a', 'c']])
  })

  it('★ 全部账号都停用 ⇒ 传**空数组**（= 一条都不查），不是「省略 = 查全部」', async () => {
    // ⚠️ 这一格最容易被写成反义（`[]` 被当成 falsy 而退回「查全部」）——
    //    那样「全部停用」反而会去查全部账号，与收益相反。
    const { badge, calls } = harness({
      accounts: [account('a', false)],
      balances: { accounts: [balanceRow('a', balance([pkg('Bonus Pack', 100)]))] },
    })
    const result = await badge.read('buddy')
    expect(calls.balanceAccountIds, '★ 空数组必须原样传下去（不是省略）').toEqual([[]])
    expect(result.ok && result.value.accounts).toEqual([])
  })

  it('老文档缺 enabled 字段时视为启用（与 provider.status 同判据）', async () => {
    const legacy = { ...account('a'), enabled: undefined } as unknown as ProviderAccountEntry
    const { badge, calls } = harness({ accounts: [legacy] })
    const result = await badge.read('buddy')
    expect(result.ok && result.value.disabledCount).toBe(0)
    expect(result.ok && result.value.accounts.length).toBe(1)
    expect(calls.balanceAccountIds, '缺 enabled ⇒ 视为启用 ⇒ 要查它').toEqual([['a']])
  })
})

describe('createUsageBadge：缓存', () => {
  it('TTL 内重复读取命中缓存（cached=true，且不再打上游）', async () => {
    let now = 10_000
    const { badge, calls } = harness({ now: () => now })

    const first = await badge.read('buddy')
    expect(first.ok && first.value.cached).toBe(false)
    expect(calls.balances).toBe(1)

    now += 999
    const second = await badge.read('buddy')
    expect(second.ok && second.value.cached).toBe(true)
    expect(calls.balances).toBe(1)
    // generatedAt 是**生成**时刻，命中缓存时保持不变（UI 的「更新于」据此显示）
    expect(second.ok && second.value.generatedAt).toBe(first.ok ? first.value.generatedAt : -1)
  })

  it('TTL 过期后重新读取', async () => {
    let now = 10_000
    const { badge, calls } = harness({ now: () => now })
    await badge.read('buddy')
    now += 1_000
    const again = await badge.read('buddy')
    expect(again.ok && again.value.cached).toBe(false)
    expect(calls.balances).toBe(2)
  })

  it('force 绕过缓存（手动刷新 / 签到之后）', async () => {
    const { badge, calls } = harness()
    await badge.read('buddy')
    const forced = await badge.read('buddy', { force: true })
    expect(forced.ok && forced.value.cached).toBe(false)
    expect(calls.balances).toBe(2)
  })

  it('全部账号失败时用**短** TTL（用户修好凭据后不必干等两分钟）', async () => {
    let now = 0
    const { badge, calls, state } = harness({
      now: () => now,
      balances: { accounts: [balanceRow('a', null, '凭据未配置')] },
    })

    await badge.read('buddy')
    expect(calls.balances).toBe(1)
    // 短 TTL 是 100ms：过了就该重取
    now += 100
    await badge.read('buddy')
    expect(calls.balances).toBe(2)

    // 修好之后（有读数）走长 TTL：先让失败那条过期，再取一次
    state.balances = { accounts: [balanceRow('a', balance([pkg('Bonus Pack', 100)]))] }
    now += 100
    await badge.read('buddy')
    expect(calls.balances).toBe(3)
    // 同样的 100ms 之后仍命中长 TTL（1000ms）——失败时才短缓存
    now += 100
    const cached = await badge.read('buddy')
    expect(cached.ok && cached.value.cached).toBe(true)
    expect(calls.balances).toBe(3)
  })

  it('「没有启用账号」不算失败（沿用长 TTL，不必每分钟重问同一个答案）', async () => {
    let now = 0
    const { badge, calls } = harness({ now: () => now, accounts: [account('a', false)], balances: { accounts: [] } })
    await badge.read('buddy')
    now += 100
    const again = await badge.read('buddy')
    expect(again.ok && again.value.cached).toBe(true)
    expect(calls.balances).toBe(1)
    expect(again.ok && again.value.disabledCount).toBe(1)
  })

  it('偏好**不进缓存**（改了偏好下次读取立刻生效）', async () => {
    const { badge, state, calls } = harness()
    await badge.read('buddy')
    state.preference = 'credits'
    const again = await badge.read('buddy')
    expect(again.ok && again.value.preference).toBe('credits')
    expect(calls.preference).toBe(2)
  })

  it('clear() 之后重新打上游', async () => {
    const { badge, calls } = harness()
    await badge.read('buddy')
    badge.clear()
    const again = await badge.read('buddy')
    expect(again.ok && again.value.cached).toBe(false)
    expect(calls.balances).toBe(2)
  })
})

describe('createUsageBadge：失败语义', () => {
  it('单账号失败保留原因，其余账号照常（不把失败画成 0）', async () => {
    const { badge } = harness({
      accounts: [account('a'), account('b')],
      balances: { accounts: [balanceRow('a', null, '凭据未配置'), balanceRow('b', balance([pkg('Bonus Pack', 7)]))] },
    })
    const result = await badge.read('buddy')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const failed = result.value.accounts.find((row) => row.accountId === 'a')
    expect(failed?.balance).toBeNull()
    expect(failed?.error).toBe('凭据未配置')
    expect(result.value.accounts.find((row) => row.accountId === 'b')?.balance?.total).toBe(7)
  })

  it('整批失败（bad-request）原样上抛，且**不缓存**（下次仍会重试）', async () => {
    const { badge, calls } = harness({ balances: { error: { code: 'bad-request', message: 'unsupported provider: nope' } } })
    const first = await badge.read('nope')
    expect(first).toEqual({ ok: false, error: { code: 'bad-request', message: 'unsupported provider: nope' } })
    const second = await badge.read('nope')
    expect(second.ok).toBe(false)
    expect(calls.balances).toBe(2)
  })
})

describe('createUsageBadge：订阅读数', () => {
  it('窗口式（Cline）：只保留启用账号的窗口行', async () => {
    const { badge } = harness({
      accounts: [account('a'), account('b', false)],
      balances: { accounts: [balanceRow('a', balance([pkg('Cline 账户余额', 5)]))] },
      quota: {
        accounts: [
          { accountId: 'a', nickname: 'a', ok: true, windows: [{ type: 'five_hour', percentUsed: 6, resetsAt: '2026-10-01T20:11:32Z' }] },
          { accountId: 'b', nickname: 'b', ok: true, windows: [{ type: 'weekly', percentUsed: 99, resetsAt: '' }] },
        ],
      },
    })
    const result = await badge.read('cline')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.subscription?.kind).toBe('windows')
    const accounts = result.value.subscription?.kind === 'windows' ? result.value.subscription.accounts : []
    expect(accounts.map((row) => row.accountId)).toEqual(['a'])
  })

  it('订阅查询失败只让订阅缺席，余额照常返回', async () => {
    const { badge } = harness({ quota: { error: { code: 'server', message: '网关 502' } } })
    const result = await badge.read('cline')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.subscription).toBeUndefined()
    expect(result.value.accounts.length).toBe(1)
  })

  it('订阅查询抛错不会冒泡（徽标不能因为额度接口挂了就整体不可用）', async () => {
    const { badge } = harness({ quota: 'throw' })
    const result = await badge.read('cline')
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.subscription).toBeUndefined()
  })

  it('套餐式（buddy）：逐账号折算成套餐行', async () => {
    const { badge } = harness({
      balances: {
        accounts: [
          balanceRow('a', balance([pkg('Bonus Pack', 20), pkg('Free Plan Subscription', 300, 500)])),
        ],
      },
    })
    const result = await badge.read('buddy')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.subscription?.kind).toBe('plan')
    const rows = result.value.subscription?.kind === 'plan' ? result.value.subscription.accounts : []
    // ⚠️ unit 是**归一后**的展示口径（'credit'），不是包上的原值（'credits'）——
    // 否则客户端会把 credit / credits 拆成两组（真实缺陷，2026-10-03）。
    expect(rows).toEqual([{ accountId: 'a', nickname: 'a', plan: { name: 'Free Plan Subscription', remaining: 300, total: 500, unit: 'credit' } }])
  })

  it('该渠道没有订阅形态时**不带** subscription 字段', async () => {
    const { badge } = harness({ accounts: [account('a')] })
    const result = await badge.read('loomy')
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.subscription).toBeUndefined()
  })

  it('有订阅形态但没有任何可用套餐包时同样缺席（回落到积分）', async () => {
    const { badge } = harness({ balances: { accounts: [balanceRow('a', balance([pkg('Bonus Pack', 250)]))] } })
    const result = await badge.read('buddy')
    expect(result.ok && result.value.subscription).toBeUndefined()
  })
})

describe('缓存时长配置', () => {
  it('默认值与文档一致', () => {
    expect(BADGE_TTL_MS).toBe(120_000)
    expect(BADGE_FAILURE_TTL_MS).toBe(15_000)
  })

  it('环境变量可覆盖，且 **0 是合法值**（= 不缓存）', () => {
    const env = { [DSH_JET_HUB_BADGE_TTL_MS]: '0' } as NodeJS.ProcessEnv
    expect(badgeTtlMs(env)).toBe(0)
    expect(badgeFailureTtlMs(env)).toBe(0)
  })

  it('非法值回落到默认（不能写成 `|| 默认值` 把 0 吃掉）', () => {
    for (const raw of ['', '   ', 'abc', '-1', 'NaN']) {
      expect(badgeTtlMs({ [DSH_JET_HUB_BADGE_TTL_MS]: raw } as NodeJS.ProcessEnv), raw).toBe(BADGE_TTL_MS)
      expect(badgeFailureTtlMs({ [DSH_JET_HUB_BADGE_TTL_MS]: raw } as NodeJS.ProcessEnv), raw).toBe(BADGE_FAILURE_TTL_MS)
    }
    expect(badgeTtlMs({} as NodeJS.ProcessEnv)).toBe(BADGE_TTL_MS)
  })
})

/**
 * ★★ **徽标必须回传 `locked`**（用户 2026-11-18 真实报障）。
 *
 * ## 缺陷
 *
 * 用户在面板里锁定了永久积分（`permanent-locks.json` 里 `trae: true` 等），
 * 但胶囊与弹窗右上角的「可用 X积分/总 Y积分」**始终不显示**。
 *
 * 根因：客户端「可用积分 = 短期 + 临期」的显示完全依赖 `value.locked`，
 * 而**徽标响应从未回传该字段** ⇒ `value.locked` 恒 `undefined`
 * ⇒ 客户端按「未锁定」处理、只显示总计。
 *
 * ## 为什么必须单独写用例
 *
 * 该字段横跨三层（pool → usage-badge 快照 → RPC 响应），任何一层漏传
 * 都不会报错、只会**静默不显示** —— 正是「静默降级」的典型形态，
 * 没有行为级用例就只能靠用户报障才发现。
 */
describe('createUsageBadge：locked 透传（可用积分的显示前提）', () => {
  it('徽标必须回传 locked=true（用户已锁定时）', async () => {
    const { badge } = harness({ locked: true })
    const result = await badge.read('trae')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.locked, '锁定态必须出现在响应里').toBe(true)
  })

  it('未锁定时回传 false（不是 undefined，前端才能区分「明确未锁」与「旧后端」）', async () => {
    const { badge } = harness({ locked: false })
    const result = await badge.read('trae')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.locked).toBe(false)
  })

  it('⚠️ 反向：装配层未提供 readLocked 时字段缺席（向后兼容，前端按未锁处理）', async () => {
    const { deps } = harness({})
    delete (deps as { readLocked?: unknown }).readLocked
    const fresh = createUsageBadge(deps)
    const result = await fresh.read('trae')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.locked, '旧装配层不应凭空冒出 locked').toBeUndefined()
  })
})
