/**
 * ★★★ **`codeArtsExpiry` 必须从已解析的 `packages[]` 折算，且优先吃共享读数**（issue #187）。
 *
 * ## 修前的两处缺陷（同一个函数，一处管入口一处管出口）
 *
 * 1. **入口**：函数第一版是 `return NEVER` —— 拿完上游响应就走，
 *    `result.info.credit.packages[]` **从未被读取**。
 *    而那个值早在 `codearts-credits.ts` 四处生成好了
 *    （顶层 `end_date` → `packageEndMs` → 只赋给基础积分包 `deductionEndTime` → 写进包对象）。
 *    ⇒ 面板显示到期日、轮换**从不消耗它**；两个账号的基础积分包恒 `used = 0`，
 *    其他渠道的临期积分被优先烧掉，这两份闲置过期。
 * 2. **出口**：表项只传 `(c)`，`context.cachedBalance` 被丢掉 ⇒ **每轮探测重打华为云**。
 *
 * ⚠️ **本文件专门盯这两条腿**，因为既有 spec 只测了「三字段全空 ⇒ NEVER」，
 * 对「有 `end_date` 时应给出真实时间戳」零覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codeArtsExpiry } from '../../src/aggregate-expiry.js'
import { NEVER, UNUSABLE } from '../../src/aggregate-core.js'
import { createProviderExpiry } from '../../src/provider-expiry.js'
import type { CreditBalance } from '../../src/credits.js'

const cred = {
  access_key_id: 'ak', secret_access_key: 'sk', security_token: 'st', expires_at: '',
} as never

/** 真实形状：顶层 `end_date` + 基础积分包（`deductionEndTime` 只赋给它）。 */
function upstreamWithEndDate(endDate: string) {
  return {
    package: {
      is_credit_package: true, is_token_package: false, spec_code: 'x',
      package_name: '体验版', status: 'normal',
    },
    end_date: endDate,
    metrics: [
      {
        name: 'usageBasicPackageCredit',
        package_credit_amount: 500,
        package_credit_used: 0,
        package_credit_remain: 500,
      },
    ],
  }
}

function stubFetch(payload: unknown) {
  const calls: number[] = []
  vi.stubGlobal('fetch', (async () => {
    calls.push(Date.now())
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch)
  return calls
}

afterEach(() => { vi.unstubAllGlobals() })

describe('★★★ codeArtsExpiry：从 packages[] 折算（issue #187 缺陷 1）', () => {
  it('★★★ 有 `end_date` ⇒ 必须返回**真实时间戳**（修前恒 `NEVER` ⇒ 恒排最后）', async () => {
    stubFetch(upstreamWithEndDate('2026-12-01T08:00:00+08:00'))
    const value = await codeArtsExpiry(cred)
    /**
     * ⚠️ 这是 issue #187 症状表里 `codearts-c588859f` 的真实读数
     * （`deductionEndTime` = 1796083200000 = 2026-12-01 08:00 UTC+8）。
     * 修前返回 `NEVER` ⇒ 在「临期优先」排序里**永远排最后** ⇒ 这 500 分闲置过期。
     */
    expect(value, '修前是 NEVER（Infinity）⇒ 恒排最后').toBe(1796083200000)
    expect(Number.isFinite(value), '必须是有限数，不能是 NEVER').toBe(true)
  })

  it('★★ 另一个账号的 `end_date` 也要各自折算（不是写死一个值）', async () => {
    stubFetch(upstreamWithEndDate('2026-12-15T08:00:00+08:00'))
    expect(await codeArtsExpiry(cred)).toBe(1797292800000)
  })

  it('★★ 没有 `end_date` ⇒ 仍 `NEVER`（不臆造，沿用既有口径）', async () => {
    stubFetch({
      package: { is_credit_package: true, is_token_package: false, spec_code: 'x', package_name: '体验版', status: 'normal' },
      metrics: [{ name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 }],
    })
    expect(await codeArtsExpiry(cred)).toBe(NEVER)
  })
})

describe('★★★ codeArtsExpiry：优先吃共享读数（issue #187 缺陷 2）', () => {
  it('★★★ 共享读数有值 ⇒ **一次上游请求都不发**', async () => {
    const calls = stubFetch(upstreamWithEndDate('2026-12-01T08:00:00+08:00'))
    const shared: CreditBalance = {
      packages: [{
        name: '基础积分包', remaining: 500, total: 500, used: 0, active: true,
        cycleStartTime: '', cycleEndTime: '', expiredTime: '2026-12-01T00:00:00.000Z',
        deductionEndTime: 1796083200000,
      }],
    } as unknown as CreditBalance
    const value = await codeArtsExpiry(cred, async () => shared)
    expect(value, '共享读数里的 deductionEndTime 必须被用上').toBe(1796083200000)
    expect(calls.length, '★ 有共享读数却仍打上游 ⇒ 每轮探测白打一次华为云').toBe(0)
  })

  it('★★ 共享读数**说查询失败**（`null`）⇒ `UNUSABLE`，且**不再发上游请求**', async () => {
    const calls = stubFetch(upstreamWithEndDate('2026-12-01T08:00:00+08:00'))
    const value = await codeArtsExpiry(cred, async () => null)
    /**
     * ⚠️ 这是 issue 给的修法**漏掉的一态**：`fetchBalanceWithCache` 在 `cached()` 返回 `null` 时
     * 直接返回 `null` 且**不调 fallback**，此时 `failed` 仍为 `false`。
     * 若只看 `failed` ⇒ 会判成 `NEVER` ⇒ **一个探测失败的渠道反而以「长期」身份留在候选表里**。
     */
    expect(value, '共享读数说失败 ⇒ 必须剔除，不能当「长期可用」').toBe(UNUSABLE)
    expect(calls.length, '「失败」是结论，不该转头再自己发一次').toBe(0)
  })

  it('★★ 共享读数**没有这个账号**（`undefined`）⇒ 退回真实请求', async () => {
    const calls = stubFetch(upstreamWithEndDate('2026-12-01T08:00:00+08:00'))
    expect(await codeArtsExpiry(cred, async () => undefined)).toBe(1796083200000)
    expect(calls.length, '缓存没命中就该自己查一次').toBe(1)
  })
})

describe('★★★ provider-expiry 表项：必须把 context.cachedBalance 透给原语（issue #187 缺陷 2）', () => {
  /**
   * ⚠️ **这条必须走表项，不能直接调 `codeArtsExpiry`** —— 缺陷 2 就在表项那一行
   * （`codearts: { credentialExpiry: (c) => codeArtsExpiry(c) }` 把 `context` 丢掉了）。
   * 直接调原语测不到它：变异「表项丢掉 context」在本文件里会**全绿**（实测过一次）。
   *
   * 本文件自己的纪律注释写着：「`context.cachedBalance` 原样透给原语，
   * 那样『吃共享读数』这条能力**只在这一处**声明，四家自动一致
   * （各写一遍必然有一家漏掉 ⇒ **静默多发一次上游请求**）」。
   * ⇒ **CodeArts 就是漏掉的那家**。
   */
  it('★★★ 表项被调用时，`cachedBalance` 必须真的被调用（= 不打上游）', async () => {
    const calls = stubFetch(upstreamWithEndDate('2026-12-01T08:00:00+08:00'))
    const table = createProviderExpiry()
    const shared: CreditBalance = {
      packages: [{
        name: '基础积分包', remaining: 500, total: 500, used: 0, active: true,
        cycleStartTime: '', cycleEndTime: '', expiredTime: '2026-12-01T00:00:00.000Z',
        deductionEndTime: 1796083200000,
      }],
    } as unknown as CreditBalance
    let asked: string[] = []
    const context = {
      accountId: 'codearts-c588859f',
      cachedBalance: async (id: string) => { asked.push(id); return shared },
    }
    const value = await table.codearts.credentialExpiry(cred as never, context as never)
    expect(value, '共享读数里的 deductionEndTime 必须被用上').toBe(1796083200000)
    expect(asked, '★ 表项必须把 accountId 透下去').toEqual(['codearts-c588859f'])
    expect(calls.length, '★ 表项丢掉 context ⇒ 每轮探测白打一次华为云（缺陷 2 原症状）').toBe(0)
  })

  it('★★ 表项在**没有** `cachedBalance` 时照旧自己查（不能因为新接线就不工作）', async () => {
    const calls = stubFetch(upstreamWithEndDate('2026-12-15T08:00:00+08:00'))
    const table = createProviderExpiry()
    const value = await table.codearts.credentialExpiry(cred as never, { accountId: 'x' } as never)
    expect(value).toBe(1797292800000)
    expect(calls.length).toBe(1)
  })
})

describe('★★ codeArtsExpiry：三态处置（失败 / 无指标 / 余额 0 方向各不相同）', () => {
  it('★★ 上游查询失败 ⇒ `UNUSABLE`（剔除）', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch)
    expect(await codeArtsExpiry(cred)).toBe(UNUSABLE)
  })

  it('★★ Token 计费账户（无积分指标）⇒ `NEVER`（可用、无到期概念）', async () => {
    stubFetch({
      package: { is_credit_package: false, is_token_package: true, spec_code: 'x', package_name: '体验版', status: 'normal' },
    })
    expect(await codeArtsExpiry(cred)).toBe(NEVER)
  })

  it('★★ 有余额但无 `end_date` ⇒ `NEVER`（不是 `UNUSABLE` —— 「余额 0/无到期」≠「渠道不可用」）', async () => {
    stubFetch({
      package: { is_credit_package: true, is_token_package: false, spec_code: 'x', package_name: '体验版', status: 'normal' },
      metrics: [{ name: 'usageBasicPackageCredit', package_credit_amount: 0, package_credit_used: 0, package_credit_remain: 0 }],
    })
    expect(await codeArtsExpiry(cred)).toBe(NEVER)
  })
})
