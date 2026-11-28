/**
 * ★★★ **「上游零个额度桶」必须当「查不到」，不能当「额度为 0」**（2026-11-28，Gitee IKYNB9）。
 *
 * ## 报障原文
 *
 * > 两个鸡蛋号，一个本机领取的能正常显示额度使用，另个是其它机器领取的额度为 0，
 * > 但这两个账号在本机的 zcode 里面切换都能正常显示额度和使用
 *
 * ⇒ **上游有数据**、ZCode 官方客户端能显示，只有本插件显示 0 ⇒ 是插件侧判据问题。
 *
 * ## 原实现错在哪
 *
 * `buildZcodeBalance` 在 `packages.length === 0` 时会**造一个 0/0 的包**：
 *
 * ```ts
 * packages.push({ name: 'ZCode 免费额度', remaining: 0, total: 0, active: true, … })
 * ```
 *
 * ⇒ 界面显示「ZCode 免费额度 0 / 0」，与**真的用光了**完全同形。
 *
 * ## 为什么「零桶」不等于「用光」
 *
 * | 形态 | 含义 |
 * |---|---|
 * | 桶还在、`remaining_units: 0` | **真的用光** |
 * | `balances: []`（零个桶）| **上游没下发任何额度信息** ⇒ 查不到 |
 *
 * 两者必须分开。本仓红线「查不到不得判死」正是在管这一格
 * （同族：zcode 的「证据不足不得判死」、baizhi 的「值必须写实」）。
 */
import { describe, expect, it } from 'vitest'
import { buildZcodeBalance } from '../../src/provider-credits.js'
import type { ZcodeBalanceResult } from '../../src/zcode-upstream.js'

const empty = (): ZcodeBalanceResult => ({
  buckets: [],
  remaining: 0,
  total: 0,
  claimablePlans: [],
  pendingPlans: [],
})

describe('★★★ ZCode 零个额度桶（IKYNB9）', () => {
  it('★★★ 零桶 + 无待生效 ⇒ null（绝不再造 0/0 包）', () => {
    expect(buildZcodeBalance(empty())).toBeNull()
  })

  it('★★★ 零桶 + 有待生效 ⇒ 只有「待生效」包，仍不造 0/0 包', () => {
    const b = buildZcodeBalance({
      ...empty(),
      pendingPlans: [{
        name: '1024 活动',
        unitType: 'token',
        grantUnits: 500_000_000,
        effectiveAt: Math.floor(Date.now() / 1000) + 3600,
      }],
    })
    expect(b).not.toBeNull()
    expect(b!.packages).toHaveLength(1)
    // ⚠️ 包名用 `pending.name ?? 'ZCode 活动额度（待生效）'` ⇒ 给了 name 就用它，
    //   「待生效」的语义靠 `active:false` + `cycleStartTime` 承载，不能靠名字断言。
    expect(b!.packages[0]?.active).toBe(false)
    expect(b!.packages[0]?.cycleStartTime, '★ 待生效包必须带生效时刻').not.toBe('')
    // ⚠️ 待生效的额度**现在不能用** ⇒ remaining 必须是 0（否则折算层会提前派发）
    expect(b!.packages[0]?.remaining).toBe(0)
    expect(b!.total).toBe(0)
  })

  it('★★ 反向对照：桶在但 remaining 为 0 ⇒ 照常返回包（那是「真的用光」，不是查不到）', () => {
    const b = buildZcodeBalance({
      ...empty(),
      buckets: [{
        showName: 'GLM-5.3',
        unitType: 'token',
        totalUnits: 1000,
        usedUnits: 1000,
        remainingUnits: 0,
        availableUnits: 0,
      }],
      remaining: 0,
      total: 1000,
    })
    expect(b, '★ 有桶就必须返回包（不能把「用光」也说成查不到）').not.toBeNull()
    expect(b!.packages).toHaveLength(1)
    expect(b!.packages[0]?.remaining).toBe(0)
    expect(b!.packages[0]?.total).toBe(1000)
  })

  it('★★ 反向对照：有桶 ⇒ 照常返回（不得因这条改动吞掉正常路径）', () => {
    const b = buildZcodeBalance({
      ...empty(),
      buckets: [{
        showName: 'GLM-5.3-Flash',
        unitType: 'token',
        totalUnits: 5_000_000,
        usedUnits: 1_000_000,
        remainingUnits: 4_000_000,
        availableUnits: 4_000_000,
      }],
      remaining: 4_000_000,
      total: 5_000_000,
    })
    expect(b).not.toBeNull()
    expect(b!.packages[0]?.remaining).toBe(4_000_000)
    expect(b!.total).toBe(4_000_000)
  })
})

/**
 * ⚠️ **M2 无牙点补守卫**：上面四条只测纯函数 `buildZcodeBalance`，
 * 测不到「**调用点有没有判 null**」—— 把 `if (built === null) return fail(...)` 删掉，
 * 上面四条仍然全绿（变异实测 GREEN），而运行时会在 `ok(null)` 之后崩成
 * `Cannot read properties of null (reading 'packages')`。
 *
 * ⇒ 必须有一条**走真实调用点**的守卫（本仓纪律：接线层只能靠行为级用例）。
 */
describe('★★★ ZCode 零桶在调用点的行为（不是纯函数）', () => {
  it('★★★ `buckets: []` ⇒ `fetchBalanceDetailed` 返回 `balance: null` + 可读原因，绝不返回 0', async () => {
    const { createProviderCredits } = await import('../../src/provider-credits.js')
    const table = createProviderCredits({
      zcode: {
        // ⚠️ 零桶 + remaining/total 都是 0 —— 这正是 IKYNB9 报障账号的形态
        fetchBalanceFor: async () => ({
          buckets: [],
          remaining: 0,
          total: 0,
          claimablePlans: [],
          pendingPlans: [],
        }),
      },
    } as never)
    const impl = table.zcode!
    const credential = JSON.parse(JSON.stringify({ zcode_jwt: 'jwt', device_mid: 'd', app_version: '4.0.0' }))
    const result = await impl.fetchBalanceDetailed!(credential, {} as never)
    expect(result.balance, '★ 零桶时绝不能给出 0/0 的包').toBeNull()
    expect(result.error, '★ 必须给出可读原因（不能静默）').toBeTruthy()
    expect(result.error).toContain('未下发任何额度信息')
    // ⚠️ 关键：原因里必须**明说不等于 0** —— 报障者的诉求就是「别把查不到说成 0」
    expect(result.error).toContain('不等于额度为 0')
  })
})
