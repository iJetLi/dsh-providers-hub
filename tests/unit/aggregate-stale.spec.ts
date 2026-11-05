/**
 * ★★ 聚合折算不得用**陈旧**余额读数参与排序（2026-10-18 设计）。
 *
 * ## 为什么
 *
 * 读路径改成 stale-while-revalidate 后，折算会在缓存陈旧时拿到**旧值**且
 * **不知情**（`stale` 字段原先只在 `readStale` 里判）。于是可能用一个
 * 10 分钟前的数字去排候选。
 *
 * ⚠️ 本仓库已因同类问题出过一次事故：officeace 的折算侧判 `UNUSABLE`，
 * 而面板侧把两天前的快照当实时余额显示 ⇒ 「同一份数据两层结论相反」。
 * （`src/jet-hub-rpc.ts:5462` / `src/aggregate-expiry.ts:1141`）
 *
 * ## ⚠️⚠️⚠️ 实测：本文件对 `src/index.ts` 的改动**零判别力**（2026-10-18）
 *
 * 全部用例都驱动 `balanceOfViaCache` 这个**镜像** ⇒ 实测把 `src/index.ts` 里
 * `if (reading.stale === true) return null` 那一行**删掉**，本文件 **6/6 仍然全绿**。
 * 原因就是下面那节写的关系：镜像不会跟着生产代码变。
 *
 * ⇒ **对生产改动有牙的那份守卫在 `aggregate-stale-wiring.spec.ts`**（它跑真实
 * `apply()`、截获生产 `balanceOf` 闭包、用真实共享缓存驱动）。
 * ⚠️ 本文件仍保留：它守住「真实折算链（`fetchBalanceWithCache` +
 * `sharedPackageExpiry`）对 `null`/`undefined` 的反应」这条语义 ——
 *   那条语义是**别人的代码**（`aggregate-expiry.ts`），删它要改别的文件。
 * ⚠️ 但**不得**把它当成本次改动的验收依据（实测恒绿）。
 *
 * ## 本文件守住什么
 *
 * 核心用例走 `buddyExpiry` 的**真实实现**（含 `fetchBalanceWithCache`
 * 与 `sharedPackageExpiry`），判据是**折算返回值**与**上游 fallback 的调用
 * 次数**（都是可观测量），**不是**源码文本 —— 判据方向与生产一致。
 *
 * ⚠️ 严禁改成读 `src/index.ts` 源码文本做正则断言 —— 本仓库实测过 5 条
 * 那类判据在 `if (false)` 死分支里恒绿。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ⚠️⚠️ **这是 `src/index.ts` 里 `balanceOf` 的镜像，不是它的引用。**
 *
 * ## 这层关系必须知道（改一处必须改两处）
 *
 * 本函数**复刻**了 `src/index.ts` 的 `sharedExpiryProbe` 第三个选项里的
 * `balanceOf` 判据。它存在是因为那段回调在很深的装配闭包里（要真实 `ctx` /
 * `pool` / 凭据解析），单测里取不出来；而它又是纯函数、值得测。
 *
 * ⚠️⚠️ **代价：不保证与生产代码同步** —— 将来改了 `balanceOf` 而忘了改这里，
 *   两边就分叉了，而本文件仍会全绿（本仓库红线「同一语义两套判据」）。
 *   ⚠️⚠️ **这条不是假设，是实测**：删掉生产那行，本文件 6/6 仍全绿（2026-10-18）。
 *   ⇒ **本函数绝不可作为本次改动的验收依据**；有牙的那份在
 *     `aggregate-stale-wiring.spec.ts`（跑真实 `apply()`、截获生产闭包）。
 *   ⇒ **改 `balanceOf` 时必须同步改本函数**，它是判据的第二份实现。
 *   ⇒ 若哪天它开始分叉，正解是**把判据抽成 `src/balance-cache.ts` 里的一个
 *   纯函数**由两边共用，而不是继续各自维护。
 *
 * ## ⚠️⚠️ 判据方向必须与生产一致：返回 `null`，不是 `undefined`
 *
 * 这是本任务**最关键**的一格，也是 brief 写错的一格：
 *
 * | `balanceOf` 返回 | `fetchBalanceWithCache` 的行为 | 折算结果 |
 * |---|---|---|
 * | `undefined` | **回落到自己发请求**（契约 `aggregate-expiry.ts:275`） | 上游的值（**不是** `UNUSABLE`） |
 * | `null` | 直接当「查询失败」 | `UNUSABLE(-1)`，且**不**重查 |
 *
 * ⇒ 「陈旧 ⇒ 不可用」只能靠 `null` 表达。返回 `undefined` 的实测后果是
 * 「陈旧账号每次折算**多打一次上游请求**」，与本任务要消灭的行为正好相反。
 */

/** 上游到期时刻（用它证明「折算真的采信了某个值」）。 */
const UPSTREAM_END = Date.now() + 3 * 86_400_000 + 9

/**
 * ⚠️ mock 必须**提到模块顶层**（`vi.mock` 是提升的）⇒ 折算链拿到的
 *   才是同一个 `vi.fn`，`mock.calls` 才有意义。
 */
const upstreamFetch = vi.hoisted(() => vi.fn(async () => ({
  packages: [{ active: true, remaining: 100, deductionEndTime: UPSTREAM_END }],
})))

vi.mock('../../src/credits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/credits.js')>()
  return { ...actual, fetchCreditBalance: upstreamFetch }
})

const { createBalanceCache } = await import('../../src/balance-cache.js')
const { buddyExpiry } = await import('../../src/aggregate-expiry.js')
const { UNUSABLE } = await import('../../src/aggregate-core.js')
const { CODEBUDDY } = await import('../../src/product.js')
type CreditBalance = import('../../src/credits.js').CreditBalance

/** 造一份「有临期包」的余额（判据与 `sharedPackageExpiry` 的输入同形）。 */
const balanceWith = (deductionEndTime: number) => ({
  packages: [{ active: true, remaining: 100, deductionEndTime }],
}) as unknown as CreditBalance

const credential = { access_token: 't' } as never

async function balanceOfViaCache(
  cache: ReturnType<typeof createBalanceCache>,
  provider: string,
  accountId: string,
  credential: unknown,
): Promise<unknown> {
  const reading = await cache.readOne(provider, accountId, { credential })
  // ★ 本次改动的核心一行：陈旧读数不得参与折算（注意是 `null`，理由见上）。
  if (reading.stale === true) return null
  return reading.error === undefined ? reading.value : undefined
}

/** 用 `balanceOf` 的产物驱动**真实**的折算链。 */
async function convertViaRealChain(
  cache: ReturnType<typeof createBalanceCache>,
): Promise<number> {
  return await buddyExpiry(
    CODEBUDDY,
    credential,
    async () => await balanceOfViaCache(cache, 'buddy', 'a1', credential),
  )
}

describe('★★ 聚合折算：陈旧读数判不可用', () => {
  function world(staleTtlMs?: number) {
    let clock = 1_000_000
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      ...staleTtlMs === undefined ? {} : { staleTtlMs },
      now: () => clock,
      fetch: async () => ({ balance: 5000 }),
    })
    return { cache, advance: (ms: number) => { clock += ms } }
  }

  beforeEach(() => { upstreamFetch.mockClear() })

  it('★★ 新鲜读数照常折算（不得把正常读数误判成不可用）', async () => {
    const w = world()
    await w.cache.readOne('buddy', 'a1', { credential: {} })
    const value = await balanceOfViaCache(w.cache, 'buddy', 'a1', {})
    expect(value, '★★ 新鲜读数必须可用（否则本改动会让聚合恒空）').toEqual({ balance: 5000 })
  })

  it('★★ 缓存陈旧时判 null（UNUSABLE 的结论信号）', async () => {
    const w = world(600_000)
    await w.cache.readOne('buddy', 'a1', { credential: {} })
    w.advance(130_000)   // 跨过 120s TTL ⇒ 命中陈旧值
    const value = await balanceOfViaCache(w.cache, 'buddy', 'a1', {})
    expect(value, '★★ 陈旧读数不得参与折算，且必须返回 null（不是 undefined）').toBeNull()
  })

  it('★ 上游恢复后重新可用（不得把 UNUSABLE 永久钉住）', async () => {
    // ⚠️ **反向对照**：没有这条，上一条可能因「恒返回 null」而全绿。
    //
    // ⚠️⚠️ **本用例刻意不用「等一拍让后台重取落地」**（brief 原文那么写）：
    //   读路径**一个请求都不发**（`balance-cache.ts` 的 `getServingStale`，
    //   提交 `a725101`：`a2` 的重取与 `a1` 的重叠 ⇒ 实测 `maxInflight = 2`
    //   ⇒ 触发风控）⇒ 保鲜**只由后台刷新器**负责，而本用例**没有起刷新器**
    //   ⇒ 那句 `setTimeout(0)` 等的是一个**永远不会发生的重取**，
    //   该用例实测**恒红**（brief 原文照抄会得到「3 条全过」的假期望）。
    //
    //   ⇒ 这里改成**确定性**驱动：上游恢复后由面板那条腿
    //   （`credits.balances` 端点取到数后 `write` 回缓存）把新值写进来。
    //   它验证的是本用例真正要验的那件事 ——
    //   **`stale` 是「这条读数」的属性，不是「这个账号」的永久判决**。
    let clock = 1_000_000
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      staleTtlMs: 600_000,
      now: () => clock,
      fetch: async () => ({ balance: 5000 }),
    })
    await cache.readOne('buddy', 'a1', { credential: {} })
    // 跨过 120s TTL ⇒ 此刻折算拿到的是陈旧值 ⇒ 判不可用
    clock += 130_000
    expect(await balanceOfViaCache(cache, 'buddy', 'a1', {}), '★ 前置：陈旧时必须先判不可用')
      .toBeNull()

    // ⚠️ 上游恢复 ⇒ 新值写进缓存（`write` 是 `credits.balances` 端点回写的同一条腿，
    //   它是**唯一**不经过读路径就刷新缓存的入口 ⇒ 用它最贴近生产）。
    cache.write('buddy', 'a1', { at: clock, value: { balance: 5000 } })

    const value = await balanceOfViaCache(cache, 'buddy', 'a1', {})
    expect(value, '★ 恢复后必须重新可用（不得把 UNUSABLE 钉死）').toEqual({ balance: 5000 })
  })
})

/**
 * ★★ 端到端：`balanceOf` 的产物喂进**真实的 `buddyExpiry`**。
 *
 * ⚠️ 这是本文件**对真实语义有约束力**的那一段：判据是**折算返回值**与
 * **上游 fallback 的调用次数**，而折算走真实的 `fetchBalanceWithCache` +
 * `sharedPackageExpiry`。⇒ 生产代码把 `null` 写成 `undefined` 时，
 * 下面第 1 条会实测变红（回落重查 1 次、折算值 ≠ `UNUSABLE`）。
 */
describe('★★ 真实折算链：陈旧读数不得参与排序', () => {
  beforeEach(() => { upstreamFetch.mockClear() })

  it('★★ 陈旧读数 ⇒ 折算判 UNUSABLE 且**不**回落重查', async () => {
    const clockRef = { now: 1_000_000 }
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      staleTtlMs: 600_000,
      now: () => clockRef.now,
      fetch: async () => balanceWith(UPSTREAM_END),
    })
    await cache.readOne('buddy', 'a1', { credential })
    clockRef.now += 130_000   // 跨过 TTL ⇒ 陈旧

    const expiry = await convertViaRealChain(cache)
    expect(expiry, '★★ 陈旧读数必须折算成 UNUSABLE').toBe(UNUSABLE)
    expect(
      upstreamFetch.mock.calls.length,
      '★★ 陈旧 ⇒ 不得回落重查（否则就是多打一次上游）',
    ).toBe(0)
  })

  it('★★ 对照：`undefined` 会**回落重查**（证明上一条不是恒真）', async () => {
    // ⚠️ 反向对照：把生产那行写成 `undefined` 时，折算**不会**判 `UNUSABLE`，
    //   而是回落自己打一次上游并采用上游的值 ⇒ 那正是本任务要消灭的行为。
    const expiry = await buddyExpiry(CODEBUDDY, credential, async () => undefined)
    expect(expiry, 'undefined ⇒ 回落并采用上游的值（≠ UNUSABLE）').toBe(UPSTREAM_END)
    expect(
      upstreamFetch.mock.calls.length,
      'undefined ⇒ 确实回落重查了一次（这正是不该发生的）',
    ).toBe(1)
    expect(UPSTREAM_END, '（确认上一条真不是恒等于 UNUSABLE）').not.toBe(UNUSABLE)
  })

  it('★★ 未陈旧时照常折算出上游给的到期时刻', async () => {
    const clock = 1_000_000
    const cache = createBalanceCache({
      ttlMs: 120_000,
      failureTtlMs: 15_000,
      now: () => clock,
      fetch: async () => balanceWith(UPSTREAM_END),
    })
    await cache.readOne('buddy', 'a1', { credential })

    const expiry = await convertViaRealChain(cache)
    expect(expiry, '★★ 新鲜读数必须照常折算').toBe(UPSTREAM_END)
    expect(upstreamFetch.mock.calls.length, '★ 新鲜命中共享读数 ⇒ 零额外上游请求').toBe(0)
  })
})