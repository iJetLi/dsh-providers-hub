/**
 * `credits.balances` / `credits.status` 改为**查表分派**后的行为回归（Task 3）。
 *
 * ## ⚠️ 为什么不用 brief 给的那版对拍用例
 *
 * brief Step 1 的样例把旧分派逻辑**就地复刻**成一个局部函数
 * （`const legacyCodearts = (info) => …`）再断言它自己的返回值 ——
 * 那是**同义反复**：它从不接触生产代码，删掉整个 `credits.balances` 分支
 * 它照样全绿。本仓库已四次记录该形态（「保险失效比变红更糟」）。
 *
 * 故本文件改成**两种真正有区分力的断言**：
 *
 * 1. **注入哨兵**：把 `createProviderCredits` 换成一个**可注入替身**（模块替身，
 *    见本文件顶部的 `vi.mock`），表里的实现返回一个**别处不可能产生**的哨兵值
 *    （`4242` / `streakDays: 7`）。端点若仍走硬编码分支（没查表），哨兵就不会
 *    出现在响应里 ⇒ 红。这条直接锁死「分派真的经过那张表」这个本 Task 的全部内容。
 * 2. **registry 派生**：凡涉及「哪些 provider 支持 / 哪些回传 windowDays」
 *    的判断，判据一律从 `PROVIDER_REGISTRY` **派生**，绝不手写清单
 *    （手写清单漏一项会静默丢掉一家的行为覆盖 —— Task 2 复审 Finding I-1）。
 *
 * 剩下的用例是真实现的**等价性**回归（codearts 三态、windowDays 语义、
 * opencode 零网络、qoder 特例优先级）—— 它们改前改后都应绿，作用是防回归。
 *
 * ## ⚠️ 2026-10-08 改（设计复审 C1）：哨兵**不再经第 5 个形参**注入
 *
 * Task 3 初版给 `registerJetHubRpc` 加了第 5 个**位置**形参 `credits`，本文件
 * 的 5 处 `makeRpc({ … })` 全靠它。该形参已删除（理由见 `registerJetHubRpc`
 * 的注释：它在生产路径上不承载信息，且重开了 Task 9 刚关掉的位置错位门）。
 *
 * 端点现在从**已解构的 `auths`** 现造表。若就此放弃端点级哨兵，本文件会丢掉
 * 唯一一条能区分「buddy 与 workbuddy 各自拿到自己那条实现」的断言 ——
 * 两家的**上游路径完全相同**（`/v2/billing/meter/get-user-resource`），
 * 逐家路径那组用例**发现不了互串**。故改为**模块替身**：
 * `vi.mock('provider-credits.js')` 让 `createProviderCredits` 在
 * `creditsOverride.current` 有值时返回它，否则透传真实现。
 *
 * ⚠️ 这**不是**「为了测试便利而在生产里开洞」：替身落在**模块边界**上，
 * 生产代码一行未改、也没有任何 `NODE_ENV` / 形参分支；断言仍打在**端点响应**上，
 * 判别力与原形参方案逐条等价。
 *
 * ⚠️ 透传是必需的：本文件下方「★★ 生产积分表的内容」一组要直接对
 * `createProviderCredits()` 断言真表 —— 若替身恒生效，那组会退化成测替身。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import { clearProviderRuntimes, registerProviderRuntime, runtimeOf } from '../../src/provider-runtime.js'
import type { ProviderCredits } from '../../src/provider-runtime.js'
import { OPENCODE } from '../../src/opencode-product.js'
import { GEMINI } from '../../src/gemini.js'
import { CODEARTS_SNAP_ENGINE_URL, CODEARTS_PACKAGE_INFO_PATH } from '../../src/codearts-credits.js'
import { LOBSTERAI_PROFILE_SUMMARY_PATH } from '../../src/lobsterai-credits.js'
import { TRAE_ENT_USAGE_PATH } from '../../src/trae.js'
import { MINIMAX_CREDIT_DETAILS_PATH } from '../../src/minimax-product.js'
import { GEMINI_QUOTA_PATH } from '../../src/gemini.js'
import { ACCIO_SUBSCRIPTION_PATH } from '../../src/accio-product.js'
import { createProviderCredits } from '../../src/provider-credits.js'
// ⚠️ 2026-11-01：Magicrew 两站的**完整 URL** 断言（只断路径片段区分不了两站）。
import { MAGICREW, MAGICREW_INTL } from '../../src/magicrew-product.js'
// ⚠️ 2026-11-03：MonkeyCode 两站同款守卫（两站余额路径逐字节相同，只差 host）。
import { MONKEYCODE, MONKEYCODE_INTL } from '../../src/monkeycode-product.js'
import { expectedProviderIdsInCreditsTable } from '../helpers/provider-sets.js'

/**
 * 端点级哨兵表的注入点（`vi.hoisted` 让它在 `vi.mock` 的**提升**工厂里可见）。
 *
 * ⚠️ `undefined` = 透传真实工厂（默认）。只有 `makeRpc({ … })` 会在**自己那次
 * 注册之前**置值，`afterEach` 复位 —— 故用例之间零串扰。
 */
const creditsOverride = vi.hoisted(() => ({
  current: undefined as Readonly<Record<string, ProviderCredits>> | undefined,
  /** 端点侧最近一次传给工厂的 deps（「表真的由 auths 派生」用例据此断言身份）。 */
  lastDeps: undefined as unknown,
}))

vi.mock('../../src/provider-credits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/provider-credits.js')>()
  return {
    ...actual,
    createProviderCredits: (deps?: unknown) => {
      creditsOverride.lastDeps = deps
      return creditsOverride.current ?? actual.createProviderCredits(deps as never)
    },
  }
})

/** 内存凭据存储（与其它 provider 的 spec 同款）。 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) { return { configured: this.store.has(ref), writable: true, source: 'fake' } }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

/** 14 个 auth 键的**空桩**（本文件只走 credits 端点，不碰 auth 实例）。 */
function emptyAuths(): Record<string, unknown> {
  const stub = {} as never
  return {
    codearts: stub, buddy: stub, workbuddy: stub, lobsterai: stub,
    qoder: stub, qodercn: stub, trae: stub, cline: stub, loomy: stub,
    raccoon: stub, minimax: stub, zcode: stub, gemini: stub,
    officeace: stub,
  }
}

/**
 * 装配一套能真调 credits 端点的最小 RPC。
 *
 * ⚠️ `settings.register` **必须返回可用 scope**：`createJetHubStore` 按
 * 「`settings.register` 是不是函数」选后端，给了返回 undefined 的桩会走
 * `SettingsStore` 并报 `Cannot read properties of undefined (reading 'get')`。
 *
 * ⚠️ `credits` 形参是**本文件自己的接缝**，**不是**生产签名的一部分
 *（`registerJetHubRpc` 只有 4 个形参，见文件头）：传它 = 本次注册期间让
 * `createProviderCredits` 回这张哨兵表（模块替身）；不传 = 走**真实**实现表。
 *
 * ⚠️ `auths` 形参让个别用例换上**带实例方法的 auth 桩**（默认 13 个键全是
 * 空对象）—— 用来证明端点的表真的从 `auths` 派生。
 */
function makeRpc(
  credits?: Readonly<Record<string, ProviderCredits>>,
  auths?: Record<string, unknown>,
) {
  creditsOverride.current = credits
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() {
      return { get: () => state.value, replace: (v: unknown) => { state.value = v } }
    },
    describe() { return [] },
  } as never)

  let handler: ((req: Request) => Promise<Response>) | undefined
  ;(ctx as unknown as Record<string, unknown>).connection = {
    // ⚠️ 按 path 取处理器：本模块除 RPC 的 POST 端点还注册了载体页 GET 路由。
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_deps: string[], cb: (c: unknown) => void) => cb(ctx)

  const pool = new AccountPool(ctx)
  // ⚠️ 4 个实参 —— 与生产签名逐字一致（`src/index.ts` 也是这么调的）。
  registerJetHubRpc(
    ctx, pool, (auths ?? emptyAuths()) as never, undefined,
  )
  const h = handler
  if (h === undefined) throw new Error('endpoint handler 未注册')

  const call = async (method: string, payload: unknown) => {
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'jet-hub', payload: { method, payload } }),
    }))
    const body = await res.json() as { result: { ok: boolean; value?: any; error?: { message: string } } }
    return body.result
  }
  return { call, pool, credentials }
}

/** 造一个账号条目。 */
async function seed(pool: AccountPool, provider: string, id: string, ref: string): Promise<void> {
  await pool.addAccount({
    id, provider, nickname: `${provider}-号`, enabled: true,
    credentialRef: ref, createdAt: 1, refreshable: true,
  })
}

/** 一个积分账户的 `statistics/plugin` 响应（含 credit metric）。 */
function creditPackageBody(remain: number): Record<string, unknown> {
  return {
    package: {
      package_name_cn: '码道个人专业版', package_name_en: 'CodeArts Agent Pro',
      spec_code: 'codearts.agent.professional', status: 'normal',
      is_credit_package: true, is_token_package: false,
    },
    metrics: [
      { name: 'usageTotalPackageCredit', package_credit_amount: 5000, package_credit_used: 1200, package_credit_remain: remain },
    ],
  }
}

beforeEach(() => {
  clearProviderRuntimes()
  creditsOverride.current = undefined
  creditsOverride.lastDeps = undefined
})
afterEach(() => {
  clearProviderRuntimes()
  creditsOverride.current = undefined
  creditsOverride.lastDeps = undefined
  vi.unstubAllGlobals()
})

// ─────────────────────────────────────────────────────────────────────────────
// 一、新结构：分派真的经过 credits 表（本 Task 的核心，改前必红）
// ─────────────────────────────────────────────────────────────────────────────

describe('★ credits 表真的驱动分派（注入哨兵，硬编码分支不可能产生它）', () => {
  it('credits.balances 走注入的 credits 表：codearts 的哨兵余额出现在响应里', async () => {
    // 哨兵 4242 只可能来自本表 —— 真实现读的是华为云响应，桩 fetch 未被调用。
    const sentinel: ProviderCredits = {
      fetchBalance: async () => ({ total: 4242, packages: [], expiredTotal: 0 }),
    }
    const { call, pool, credentials } = makeRpc({ codearts: sentinel })
    await seed(pool, 'codearts', 'ca-1', 'CODEARTS_ACCOUNT_SPEC')
    await credentials.set('CODEARTS_ACCOUNT_SPEC', JSON.stringify({ access_key_id: 'AK', secret_access_key: 'SK' }))
    // 任何真实网络请求都应让本用例失败：分派不该碰上游。
    vi.stubGlobal('fetch', async () => { throw new Error('查表分派不得发网络请求') })

    const result = await call('credits.balances', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    expect(result.value.accounts).toHaveLength(1)
    expect(
      result.value.accounts[0]?.balance?.total,
      '注入的 credits 表没有生效 —— 说明端点仍在走硬编码分支（没查表）',
    ).toBe(4242)
  })

  it('credits.balances 走注入的表：buddy 与 workbuddy 各自拿到**自己**那条实现', async () => {
    // 两家各回一个不同的哨兵 ⇒ 同时证明「查到了表」与「没有串到隔壁」。
    const { call, pool, credentials } = makeRpc({
      buddy: { fetchBalance: async () => ({ total: 111, packages: [], expiredTotal: 0 }) },
      workbuddy: { fetchBalance: async () => ({ total: 222, packages: [], expiredTotal: 0 }) },
    })
    await seed(pool, 'buddy', 'b-1', 'BUDDY_ACCOUNT_SPEC')
    await seed(pool, 'workbuddy', 'w-1', 'WORKBUDDY_ACCOUNT_SPEC')
    await credentials.set('BUDDY_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-B' }))
    await credentials.set('WORKBUDDY_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-W' }))
    vi.stubGlobal('fetch', async () => { throw new Error('查表分派不得发网络请求') })

    const buddy = await call('credits.balances', { provider: 'buddy' })
    expect(buddy.value.accounts[0]?.balance?.total, 'buddy 没拿到自己那条实现').toBe(111)
    const work = await call('credits.balances', { provider: 'workbuddy' })
    expect(work.value.accounts[0]?.balance?.total, 'workbuddy 串到了 buddy 那条实现').toBe(222)
  })

  it('credits.status 走注入的 credits 表：buddy 的哨兵签到状态出现在响应里', async () => {
    const sentinel = {
      active: true, todayCheckedIn: false, streakDays: 7, dailyCredit: 100,
      todayCredit: 0, isStreakDay: false, totalCredits: 0, checkinDates: [],
      activityName: '哨兵活动', themeName: '哨兵主题', endTime: '',
    }
    const { call, pool, credentials } = makeRpc({
      buddy: { fetchStatus: async () => sentinel },
    })
    await seed(pool, 'buddy', 'b-1', 'BUDDY_ACCOUNT_SPEC')
    await credentials.set('BUDDY_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-B' }))
    vi.stubGlobal('fetch', async () => { throw new Error('查表分派不得发网络请求') })

    const result = await call('credits.status', { provider: 'buddy' })
    expect(result.ok).toBe(true)
    expect(
      result.value.accounts[0]?.status?.streakDays,
      '注入的 credits 表没有生效 —— credits.status 仍在走硬编码分支',
    ).toBe(7)
    expect(result.value.accounts[0]?.status?.activityName).toBe('哨兵活动')
  })

  it('表里没有 fetchStatus 的渠道**如实回 null**（不臆造 {streakDays:0}）', async () => {
    // 注入一张只有 fetchBalance 的表：minimax 的真实 fetchStatus 被**摘掉**，
    // 于是判据「有则真查、无则 null」必须回 null。
    const { call, pool, credentials } = makeRpc({
      minimax: { fetchBalance: async () => ({ total: 5, packages: [], expiredTotal: 0 }) },
    })
    await seed(pool, 'minimax', 'm-1', 'MINIMAX_ACCOUNT_SPEC')
    await credentials.set('MINIMAX_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-M' }))
    vi.stubGlobal('fetch', async () => { throw new Error('无 fetchStatus 时不得发请求') })

    const result = await call('credits.status', { provider: 'minimax' })
    expect(result.ok).toBe(true)
    expect(result.value.accounts).toEqual([
      { accountId: 'm-1', nickname: 'minimax-号', status: null },
    ])
  })

  it('credits 域注册在 ProviderRuntime 上，且 fetchBalance 收到解析出的 credential', async () => {
    const fetchBalance = vi.fn(async () => ({ total: 42, packages: [], expiredTotal: 0 }))
    registerProviderRuntime({
      descriptor: descriptorOf('raccoon')!,
      credits: { fetchBalance: fetchBalance as never },
    })
    const runtime = runtimeOf('raccoon')
    expect(runtime?.credits?.fetchBalance, 'ProviderRuntime 缺少 credits 域').toBeDefined()
    await runtime!.credits!.fetchBalance!({ fake: true }, {} as never)
    expect(fetchBalance).toHaveBeenCalledWith({ fake: true }, expect.anything())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、真实现的等价性回归（改前改后都应绿）
// ─────────────────────────────────────────────────────────────────────────────

describe('codearts 三种非余额态必须报**可读原因**（不是 0）', () => {
  /**
   * ⚠️ 这三条文案是用户报障修来的，逐字保留。
   * 反向验证：把 codearts 的 fetchBalance 改成 `async () => 0`
   *（= 故意把「查不到」画成 0）⇒ 本组前两条立刻变红。
   */
  async function codeartsRow(body: Record<string, unknown>) {
    const { call, pool, credentials } = makeRpc()
    await seed(pool, 'codearts', 'ca-1', 'CODEARTS_ACCOUNT_SPEC')
    await credentials.set('CODEARTS_ACCOUNT_SPEC', JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2099-01-01T00:00:00.000Z',
    }))
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const result = await call('credits.balances', { provider: 'codearts' })
    expect(seen, 'codearts 的余额必须来自 statistics/plugin 一次真实查询').toContain(
      `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_PACKAGE_INFO_PATH}`,
    )
    return result.value.accounts[0] as { balance: { total: number } | null; error?: string }
  }

  it('积分账户：回真实余额', async () => {
    const row = await codeartsRow(creditPackageBody(3800))
    expect(row.balance?.total).toBe(3800)
    expect(row.error).toBeUndefined()
  })

  it('Token 计费账户：报「Token 计费账户，无积分余额」，**不是 0**', async () => {
    const row = await codeartsRow({
      package: { is_credit_package: false, is_token_package: true },
      metrics: [],
    })
    expect(row.balance, 'Token 账户不得伪造余额').toBeNull()
    expect(row.error).toBe('Token 计费账户，无积分余额')
  })

  it('非积分计费账户：报「非积分计费账户，无积分余额」', async () => {
    const row = await codeartsRow({
      package: { is_credit_package: false, is_token_package: false },
      metrics: [],
    })
    expect(row.balance).toBeNull()
    expect(row.error).toBe('非积分计费账户，无积分余额')
  })

  it('积分账户但无 credit metric：报「未返回积分数据」，**不是 0**', async () => {
    const row = await codeartsRow({
      package: { is_credit_package: true, is_token_package: false },
      metrics: [{ name: 'usageTokenChatMessages', usage_token_num: 1 }],
    })
    expect(row.balance).toBeNull()
    expect(row.error).toBe('未返回积分数据')
  })

  it('查询失败：带上底层原因（不退化成泛化文案）', async () => {
    const { call, pool, credentials } = makeRpc()
    await seed(pool, 'codearts', 'ca-1', 'CODEARTS_ACCOUNT_SPEC')
    await credentials.set('CODEARTS_ACCOUNT_SPEC', JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK',
      expires_at: '2099-01-01T00:00:00.000Z',
    }))
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ error_code: 'APIG.0301', error_msg: 'verify ak sk signature fail' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ))
    const result = await call('credits.balances', { provider: 'codearts' })
    const row = result.value.accounts[0] as { balance: unknown; error?: string }
    expect(row.balance).toBeNull()
    expect(row.error, '必须保留底层原因').toContain('账户信息查询失败')
    expect(row.error).toContain('APIG.0301')
  })
})

describe('★ windowDays 由 registry 的 usesExpiryWindow 驱动（不是「是不是 buddy」）', () => {
  /**
   * ⚠️ 用**空账号池**遍历：零网络、零凭据，只观察响应信封的形状。
   * 判据完全从 `PROVIDER_REGISTRY` 派生 —— 手写「四家」清单漏一家就会
   * 静默丢掉那家的窗口语义（本仓库 failure-class #1）。
   */
  it('只有 usesExpiryWindow === true 的渠道回传 windowDays', async () => {
    const { call } = makeRpc()
    const checked: string[] = []
    for (const d of PROVIDER_REGISTRY) {
      if (d.credits.balance !== true) continue
      checked.push(d.id)
      const result = await call('credits.balances', { provider: d.id })
      expect(result.ok, `${d.id} 应被接受（registry 声明 balance:true）`).toBe(true)
      const hasWindow = Object.prototype.hasOwnProperty.call(result.value ?? {}, 'windowDays')
      expect(
        hasWindow,
        d.usesExpiryWindow === true
          ? `${d.id} 必须回传 windowDays（否则面板无法分「长期 / 临时」）`
          : `${d.id} 不该回传 windowDays（它没有按到期时间分桶的概念）`,
      ).toBe(d.usesExpiryWindow === true)
    }
    // 防止循环被静默跳过（例如 registry 里 balance 全变 false）——空转也是恒绿。
    expect(checked.length, '没有任何渠道被检查 = 本用例什么都没守').toBeGreaterThanOrEqual(14)
  })

  it('usesExpiryWindow 的登记值与「按到期时间分桶」的实测集合一致', () => {
    // 这些是余额里带逐包到期时间、走按到期分桶的渠道。
    // 写死它是**有意**的：若有人改 registry，这条会红并要求他复核，
    // 而不是让 windowDays 静默地多出/少掉一家。
    // ⚠️ autoclaw 2026-10-17 加入：流水每笔发放带 `wallet_expires_at`（唯一到期
    //    数据源，真机取证 28/28 带值且守恒），批次包归一化到 `deductionEndTime`。
    // ⚠️ autoclawintl 2026-10-20 加入：与 autoclaw **同源**（同一份 credits 实现），
    //    实测国际站批次同样带 `deductionEndTime`（3000→10/21、10000→10/27）。
    // ⚠️ codearts 2026-10-20 加入（PR !123）：**只有基础积分包**带
    //    `deductionEndTime`（取自套餐周期 `end_date`）；赠送/按需包没有逐包到期
    //    字段，走 `expiringTotal` 聚合提示。它**不**开 `permanentLock`。
    // ⚠️ qoder / qodercn 2026-10-20 加入：`/sash/api/v2/me/usage` 的
    //    `usage.expiresAt` 是**永久哨兵**（`253402214400000` = `9999-12-31`）时
    //    **不写** `deductionEndTime`（未知到期 ⇒ 落永久桶）；真实时间戳才写。
    //    ⚠️ `addOnQuota` 只给聚合标量、**任何日期字段都没有** ⇒ 恒落永久桶。
    const withWindow = PROVIDER_REGISTRY.filter((d) => d.usesExpiryWindow === true).map((d) => d.id).sort()
    // ⚠️ astudio 2026-10-20 加入：`/points/balance` 的 member / buy / activity
    //    三池各带 `*NextExpireTime`（不带时区的本地时间串），由
    //    `astudio-credits.ts` 的 `astudioLocalTimeMs` 归一化到 `deductionEndTime`。
    // ⚠️ minimax / minimaxintl 2026-10-20 加入：`/minimax-cloud/api/v1/credit/details`
    //    的每条 `details[]` 带 `expire_at_ms`（**毫秒时间戳**，无需换算），
    //    直接写进 `deductionEndTime` —— 与 astudio 那条的形态差异是本条的价值所在
    //    （两种输入形态都能落进同一个分桶判据）。
    // ⚠️ magicrew / magicrewintl 2026-11-01 加入：`/api/v1/quota/points/total`
    //    的 `expiring_quota_details[]` 每条带 `expires_at`（**无时区**的
    //    `YYYY-MM-DD HH:mm:ss`，按 UTC+8 解析），而 `total_points` 减批次和
    //    的残差是**上游不下发到期时间**的永久积分（合成包**不写**到期时刻）
    //    —— 「有到期时间」与「没有到期时间」两种包同时出现，正是分桶判据
    //    需要的那组输入。
    //    ⚠️ `codearts` 在这张表里但**不是**本家端点下发到期时间（它靠静态校准）。
    expect(withWindow).toEqual([
      'astudio', 'autoclaw', 'autoclawintl', 'buddy', 'codearts', 'lobsterai',
      'magicrew', 'magicrewintl', 'minimax', 'minimaxintl', 'officeace',
      'qoder', 'qodercn', 'trae', 'workbuddy',
    ])
  })
})

describe('特例的**优先级**：必须在查表之前短路', () => {
  it('★ opencode 不查表、零网络（注入一张会抛错的表也拦不住它）', async () => {
    const { call, pool } = makeRpc({
      // 若端点先查表，这个哨兵就会生效（或抛错）——两种都会让本用例失败。
      opencode: {
        fetchBalance: async () => { throw new Error('opencode 不该走 credits 表') },
      },
    })
    await seed(pool, OPENCODE.id, 'oc-on', 'OPENCODE_ACCOUNT_ON')
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      fetched.push(String(input))
      throw new Error('opencode 的余额分支不得发网络请求')
    })

    const result = await call('credits.balances', { provider: OPENCODE.id })
    expect(result.ok).toBe(true)
    expect(fetched, 'opencode 的余额分支不得触碰网络').toEqual([])
    // 语义是「可用通道数」，来自本地账号池（见 opencode-usage-badge.spec.ts）。
    expect(result.value.accounts[0]?.balance?.total).toBe(1)
    expect(result.value.accounts[0]?.balance?.packages[0]?.unit).toBe('通道')
  })

  it('★ qoder 系不查表：注入的 qoder 实现不得生效（它只吃 QoderCredential）', async () => {
    const { call, pool, credentials } = makeRpc({
      qoder: { fetchBalance: async () => ({ total: 9999, packages: [], expiredTotal: 0 }) },
      qodercn: { fetchBalance: async () => ({ total: 9999, packages: [], expiredTotal: 0 }) },
    })
    await seed(pool, 'qoder', 'q-1', 'QODER_ACCOUNT_SPEC')
    await credentials.set('QODER_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-Q' }))
    vi.stubGlobal('fetch', async () => new Response('{"error":"nope"}', { status: 404 }))

    const result = await call('credits.balances', { provider: 'qoder' })
    expect(result.ok).toBe(true)
    const row = result.value.accounts[0] as { balance: { total: number } | null; error?: string }
    expect(row.balance?.total, 'qoder 走了 credits 表 —— 特例没有短路').not.toBe(9999)
    // 查不到时**带原因**，不显示成 0（与其它 provider 同约定）。
    expect(row.balance).toBeNull()
    // ⚠️ 2026-10-21 改：原断言是把文案写死成
    //    「积分查询失败（凭据失效或响应异常）」。那句文案**本身就是缺陷**——
    //    它把「网络出不去 / 401 / 服务端 5xx / 企业版无数字」四种完全不同的
    //    处境压成一句，用户据此只能做错事（反复重新登录）。
    //    现在 qoder 分支改用带原因的 `fetchQoderBalanceDetailed`，故改判：
    //    ① 必须**带状态码**（本例是 404）② 不许再是那句把原因抹平的话。
    expect(row.error).toContain('404')
    expect(row.error, '不得退回「凭据失效或响应异常」这种无信息量的统一话术')
      .not.toBe('积分查询失败（凭据失效或响应异常）')
  })

  /**
   * ⚠️⚠️ **qoder 多账号余额必须并发查询**（2026-10-21 报障「一直读取中」）。
   *
   * ## 这条用例守的是一个**耗时**属性，不是文案
   *
   * 原实现 `for (const account of accounts) { await fetchBalanceDetailed(...) }`
   * 是**串行**：墙外时单账号 10.7s 才失败（undici 的 connect timeout 先于
   * `AbortSignal.timeout(15s)`），两个账号 **22s**；前端 `callManagementRpc`
   * 不设超时 ⇒ 整段时间面板只显示「读取中…」。
   *
   * ## 为什么用「窗口内完成」而不是量总毫秒
   *
   * 直接断言 `elapsed < 15s` 在慢 CI 上会 flaky。这里让**每个账号的 fetch
   * 各挂 200ms**，断言「3 个账号总共 < 400ms」——既是并发（串行至少 600ms）、
   * 又留了一倍余量，不依赖机器快慢。
   *
   * ⚠️ 顺带守住**失败隔离**与**输出顺序**：并发改造最容易踩的两个坑。
   */
  it('★★ qoder 多账号余额必须并发查询（串行 = 面板「一直读取中」22 秒）', async () => {
    const { call, pool, credentials } = makeRpc()
    await seed(pool, 'qoder', 'q-a', 'QODER_ACCOUNT_A')
    await seed(pool, 'qoder', 'q-b', 'QODER_ACCOUNT_B')
    await seed(pool, 'qoder', 'q-c', 'QODER_ACCOUNT_C')
    for (const ref of ['QODER_ACCOUNT_A', 'QODER_ACCOUNT_B', 'QODER_ACCOUNT_C']) {
      await credentials.set(ref, JSON.stringify({ access_token: `AT-${ref}` }))
    }
    /** 每个账号的响应延迟（串行 ⇒ 总和 600ms；并发 ⇒ 约 200ms）。 */
    const PER_ACCOUNT_MS = 200
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, PER_ACCOUNT_MS))
      // ⚠️ 鉴权头在**第二参**（`fetch(url, { headers })`），不在 URL 上。
      // ⚠️ b 号故意 401：既验失败隔离（不连累 a/c），也验原因分档。
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (headers.Authorization === 'Bearer AT-QODER_ACCOUNT_B') {
        return new Response('unauthorized', { status: 401 })
      }
      return new Response(JSON.stringify({
        displayMode: 'qoder',
        qoderUsage: {
          expiresAt: 253402214400000,
          userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
          addOnQuota: { total: 100, used: 0, remaining: 100, unit: 'credits' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const startedAt = Date.now()
    const result = await call('credits.balances', { provider: 'qoder' })
    const elapsed = Date.now() - startedAt

    expect(result.ok).toBe(true)
    // 并发判据：3 × 200ms 串行 = 600ms；并发应约 200ms。400ms 是留一倍余量的阈值。
    expect(elapsed, `3 个账号查询耗时 ${elapsed}ms —— 串行会 ≥600ms`).toBeLessThan(400)
    // 失败隔离：b 号失败不影响 a/c。
    const rows = result.value.accounts as Array<{ accountId: string; balance: { total: number } | null; error?: string }>
    expect(rows.map((r) => r.accountId), '输出顺序必须与账号池顺序一致').toEqual(['q-a', 'q-b', 'q-c'])
    expect(rows[0]!.balance?.total).toBe(100)
    expect(rows[1]!.balance).toBeNull()
    expect(rows[2]!.balance?.total).toBe(100)
    // 原因分档：401 指向「重新登录」，不是代理，也不是抹平话术。
    expect(rows[1]!.error).toContain('401')
    expect(rows[1]!.error).not.toContain('HTTPS_PROXY')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、边界契约（registry 派生，绝不手写 provider 清单）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 每家的余额**上游路径片段**。
 *
 * ⚠️ 这是**手写清单**，故由下面第一条用例与 `PROVIDER_REGISTRY` **逐项交叉核对**
 *（Task 2 复审 Finding I-1 的教训：手写清单漏一项会静默丢掉一家的行为覆盖，
 * 而全量测试照样全绿）。漏写一个 ⇒ 那条用例变红并点名。
 *
 * ⚠️ 只写**路径片段**而不是完整 URL：域名来自各家 product 配置（`apiBase` /
 * endpoint / apiHost），写全串会在产品换域名时假失败，而本用例守的是
 * 「请求发到了**这家自己的**余额端点」这个语义。
 */
const BALANCE_PATH_OF: Readonly<Record<string, string>> = {
  codearts: CODEARTS_PACKAGE_INFO_PATH,
  buddy: '/v2/billing/meter/get-user-resource',
  workbuddy: '/v2/billing/meter/get-user-resource',
  lobsterai: LOBSTERAI_PROFILE_SUMMARY_PATH,
  trae: TRAE_ENT_USAGE_PATH,
  cline: '/api/v1/users/',
  loomy: '/points/records',
  raccoon: '/balance',
  minimax: MINIMAX_CREDIT_DETAILS_PATH,
  // ⚠️ minimaxintl 与 `minimax` **同一条路径片段**（两站端点同形、只差主机）——
  //    本清单守的是「请求发到了这家自己的余额端点」，路径相同不影响判别力
  //    （主机由 `MINIMAX_INTL.apiHost` 决定，由 `minimax-intl.spec.ts` 专门断言）。
  minimaxintl: MINIMAX_CREDIT_DETAILS_PATH,
  zcode: '/api/v1/zcode-plan/billing/balance',
  gemini: GEMINI_QUOTA_PATH,
  // ⚠️ accio 的**必需**端点是 currentSubscription（三类积分桶）；
  //    quota 与 userinfo 都是可容忍的补充（失败不影响余额）。
  accio: ACCIO_SUBSCRIPTION_PATH,
  // astudio（2026-10-16，goal 302 接线）：余额走 xingchen-studio 工作台域名的
  //   points/balance（src/astudio-credits.ts 的 ASTUDIO_POINTS_BALANCE_PATH，
  //   baseUrl 来自 src/astudio-product.ts 的 authBaseUrl）。
  astudio: '/points/balance',
  autoclaw: '/agent-assetmgr/api/v2/wallets',
  // ⚠️ autoclawintl 与 `autoclaw` **同一条路径**（两站端点同形、只差主机）——
  //    本清单守的是「请求发到了这家自己的余额端点」，路径相同不影响判别力
  //    （主机由 `AUTOCLAW_INTL.apiBase` 决定）。实测 2026-10-20：
  //    国际站该路径返回 `code=0`、`total_balance=13000`。
  autoclawintl: '/agent-assetmgr/api/v2/wallets',
  // ⚠️ 超级麦吉（Magicrew，2026-10-29）：`GET /api/v1/model-gateway/tokens`（`MAGICREW_POINTS_PATH`）。
  magicrew: '/api/v1/quota/points/total',
  // ⚠️ **MagiCrew 国际版**（2026-11-01）：同一个 Go 服务的另一个数据面，
  //    路径**逐字符相同**（只有 host 不同：`magic-service.magicrew.ai`）。
  //    ⚠️ 两站必须各登记一项 —— 漏了会让国际站的行为覆盖静默降到零。
  magicrewintl: '/api/v1/quota/points/total',
  // ⚠️ **本 fork 独有**（魔搭，2026-10-17）：魔粒余额端点。
  //    ⚠️ 只写**路径片段**（与本表其余项同口径）：域名在 product 的 `balanceUrl`
  //    里，而它**刻意不是** `baseUrl` 那个 host（见 modelscope-product.ts 的字段注释）。
  modelscope: '/openapi/v1/magicubes/balance',
  // ⚠️ **本 fork 独有**（Codely/Unity，2026-10-19）：积分余额端点（真凭据实测 200，
  //    `remaining_points` 是字符串；同域 /api/user/info 等候选均已 404）。
  codely: '/api/user/usage/summary',
  // ⚠️ **本 fork 独有**（MonkeyCode，2026-11-02）：余额走**平台侧**的
  //    `GET /api/v1/users/wallet`（Cookie 认证）。⚠️ 它**不是**推理端点：
  //    推理走白泽 `ai-models.app.baizhi.cloud/api/anthropic/v1/messages` 或
  //    网关 `proxy.monkeycode-ai.com/v1/messages`，那两条都与余额无关。
  monkeycode: '/api/v1/users/wallet',
  // ⚠️ 国际站（2026-11-02）：与国内站**同一条路径**（两站的平台 API 逐字节同形，
  //    只有 host 不同）。清单里必须单列 —— 本表按 provider id 比对，缺了它
  //    国际站的「余额请求打到自己端点」这条行为覆盖会静默降到零。
  monkeycodeintl: '/api/v1/users/wallet',
  // ⚠️ **本 fork 独有**（百智云，2026-11-02）：余额走**控制台**（`baizhi.cloud`）的
  //    钱包接口，**Cookie 认证**（`sl-session` + `baizhi_session`）。
  //    ⚠️ 它**不是**推理端点：推理走 `ai-models.app.baizhi.cloud/api/anthropic`
  //    的 `/v1/messages`（`x-api-key` 认证），那条网关**没有任何余额路由**
  //    （`/v1/credits`、`/v1/balance`、`/v1/usage` 实测全 404「Gateway 路由不存在」）。
  //    ⚠️ 单位是 **1/100 积分**（23505 ⇒ 235.05），换算在 buildBaizhiBalance 里做。
  baizhi: '/api/v1/user/wallet/balance',
}

/**
 * ★★ **本 Task 的核心行为守卫**：逐家真调 `credits.balances`，断言请求发到了
 * **这家自己的**余额端点。
 *
 * 这是那批「`src/jet-hub-rpc.ts` 里含 `fetchXxxCreditBalance(credential, …)`」
 * 源码文本断言的**行为替代**：那些文本在 Task 3 之后**不存在了**（调用搬进了
 * `src/provider-credits.ts` 的表），而它们守的意图（该渠道的余额真的走它自己的
 * 协议原语）**与文本无关**。本用例比文本强 —— 文本只能证明源码里有那串字符，
 * 它能证明**端到端**把请求打到了正确的上游路径。
 *
 * ⚠️ 凭据用**超集**：各家从同一份 JSON 里读自己需要的字段，故不必为每家手写
 * 一份（写死会让新增字段时假失败）。上游一律回 `{}`（各家解析器回 null 即可，
 * 本用例只关心**请求发出去了**）。
 */
describe('★★ 逐家余额都走自己的上游端点（源码文本断言的行为替代）', () => {
  /** 覆盖全部字段的凭据超集。 */
  const CREDENTIAL = JSON.stringify({
    access_token: 'AT', refresh_token: 'RT', account_id: 'usr-spec',
    access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
    zcode_jwt: 'jwt', device_mid: 'mid', app_version: '3.14.4',
    uid: 'uid-spec', user_id: 'uid-spec', machine_id: 'm-1',
    expires_at: '2099-01-01T00:00:00.000Z',
    // ⚠️ 超级麦吉（Magicrew，2026-10-29）只认 `jwt` + `organizationCode` 两个字段
    //    （其 `credits` 条目的 `fetchBalance` 在 jwt 缺失时会**早退不发请求**，
    //    那是刻意的不浪费 —— 故共享 fixture 必须带上它们，否则本表那条
    //    「余额请求打到自己端点」会对 magicrew 恒读过）。
    jwt: 'j.w.t', organization_code: 'org1',
    // ⚠️ MonkeyCode（2026-11-02）的余额**早退**条件：没有 `session_cookie` 时
    //    `fetchMonkeycodeWallet` 直接回「未配置会话」、**一个请求都不发**
    //    （那是刻意的降级，不是缺陷）⇒ 超集必须带上它，否则下面那张
    //    「余额请求打到自己端点」的表会对 monkeycode 恒读过。
    session_cookie: 'spec_session=1',
  })

  it('手写端点清单与 registry 逐项对齐（漏一家即红并点名）', () => {
    // 判据：registry 里**有余额能力、且不是形态不匹配的特例**的渠道。
    // 特例是 opencode（本地派生、零网络）与 qoder 系（只吃 QoderCredential）——
    // 两者都由 `credits-runtime-parity.spec.ts` 的「特例的优先级」单独守。
    // ⚠️ 2026-10-08（Task 11-F）：特例表与判据改由 `tests/helpers/provider-sets.ts`
    // 单一持有（原先本文件里就写了两遍、另有一处在 `provider-runtime-wiring.spec.ts`）。
    const expected = expectedProviderIdsInCreditsTable().sort()
    expect(
      Object.keys(BALANCE_PATH_OF).sort(),
      '端点清单与 registry 漂移：左侧多出 = 清单里有僵尸项，右侧多出 = registry 里'
      + '有余额能力的渠道漏了端点（那家的行为覆盖会静默降到零）',
    ).toEqual(expected)
  })

  it.each(Object.keys(BALANCE_PATH_OF))('%s 的余额请求打到自己的上游路径', async (provider) => {
    const { call, pool, credentials } = makeRpc()
    const ref = `${provider.toUpperCase()}_ACCOUNT_SPEC`
    await seed(pool, provider, `${provider}-1`, ref)
    await credentials.set(ref, CREDENTIAL)

    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      // 上游回一个空对象：各家解析器据此回 null（本用例只关心请求发出去了）。
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await call('credits.balances', { provider })
    expect(result.ok, `${provider} 应被接受`).toBe(true)
    const path = BALANCE_PATH_OF[provider]!
    expect(
      seen.some((url) => url.includes(path)),
      `${provider} 的余额没有打到自己的端点（期望含 ${path}）—— 实际请求：`
      + `${seen.length === 0 ? '（一个都没发）' : seen.join(', ')}`,
    ).toBe(true)
  })
})

/**
 * ★★ **Magicrew 两站的余额必须打到各自的 host**（国际站串号守卫，2026-11-01 补）。
 *
 * ## 为什么必须有这条（测试有效性审查的**阻断项**）
 *
 * 上面那张 `BALANCE_PATH_OF` 只存**路径片段**，而两站路径**逐字符相同**
 * （`/api/v1/quota/points/total`）⇒ 原理上无法区分两站。实测：把
 * `src/provider-credits.ts` 里 `magicrewintl` 的 `fetchBalance` 改成
 * `product: MAGICREW`，**25 个 spec / 859 条用例全绿**。
 *
 * 生产症状：国际站账号的 JWT 打到国内 host ⇒ 余额恒读不到 ⇒ 卡片显示
 * 「余额查询失败」、聚合临期折算恒 `UNUSABLE` ⇒ 国际站模型从轮换表静默消失。
 *
 * ⚠️ 本用例**不改** `BALANCE_PATH_OF` 的形状（那会让 20 项全改，且那张表守的是
 * 另一个语义「请求打到自己的端点」）；这里单独断**完整 URL**。
 */
describe('★★ Magicrew 两站的余额打到各自的 host（国际站串号守卫）', () => {
  it.each([
    { provider: 'magicrew', product: MAGICREW },
    { provider: 'magicrewintl', product: MAGICREW_INTL },
  ])('$provider 的余额 URL host 是 $product.host', async ({ provider, product }) => {
    const ref = `${provider.toUpperCase()}_ACCOUNT_SPEC`
    const { call, pool, credentials } = makeRpc()
    await seed(pool, provider, `${provider}-1`, ref)
    await credentials.set(ref, JSON.stringify({ jwt: 'JWT-SPEC', organizationCode: 'org-spec' }))

    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await call('credits.balances', { provider })
    expect(result.ok, `${provider} 应被接受`).toBe(true)
    expect(seen.length, `${provider} 的余额请求一个都没发`).toBeGreaterThan(0)
    expect(seen[0], `${provider} 的余额没有打到自己的 host（国内/国际串号会让余额恒失败）`)
      .toBe(`${product.host}/api/v1/quota/points/total`)
  })

  it('两站的 host 互不相同（fixture 自检：相同则上面那条恒真）', () => {
    expect(MAGICREW.host).not.toBe(MAGICREW_INTL.host)
  })
})

/**
 * ★★ **MonkeyCode 两站的余额必须打到各自的 host**（2026-11-03 合并审计补牙）。
 *
 * ## 为什么必须补（红队实测的阻断项）
 *
 * 上面那张 `BALANCE_PATH_OF` 只存**路径片段**，而两站路径逐字节相同
 * （`/api/v1/users/wallet`），只有 host 不同（`monkeycode-ai.com` / `.net`）。
 * 红队实测：把 `src/provider-credits.ts` 里 monkeycode 的 `fetchBalanceDetailed`
 * 换成 `MONKEYCODE_INTL`（及反向、claim 同理）⇒ **19 个 spec / 433 条全绿**。
 *
 * 生产症状与 magicrew 逐字同型：国际站 cookie 打国内站恒 401 ⇒ 余额恒
 * 「网页登录态未生效」⇒ 聚合折算恒 `UNUSABLE` ⇒ 国际站从轮换表**静默消失**。
 *
 * ⚠️ 与上面 Magicrew 那条**判据同构**（完整 URL，不是片段），但**不能合并**成
 * 一张参数表：两家的凭据形状不同（MonkeyCode 需要 `session_cookie`），
 * 合并会让某个 fixture 缺字段变成恒真。
 */
describe('★★ MonkeyCode 两站的余额打到各自的 host（国际站串号守卫）', () => {
  it.each([
    { provider: 'monkeycode', product: MONKEYCODE },
    { provider: 'monkeycodeintl', product: MONKEYCODE_INTL },
  ])('$provider 的余额 URL host 是 $product.platformBaseUrl', async ({ provider, product }) => {
    const ref = `${provider.toUpperCase()}_ACCOUNT_SPEC`
    const { call, pool, credentials } = makeRpc()
    await seed(pool, provider, `${provider}-1`, ref)
    // ⚠️ 必须带 `session_cookie`：缺它时 `fetchMonkeycodeWallet` 会**早退**
    //    （一个请求都不发），那条用例就会变成「因为没发请求而恒真」。
    await credentials.set(ref, JSON.stringify({
      access_token: 'oma_spec', signing_secret: 'sec_spec', session_cookie: 'spec_session=1',
    }))

    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await call('credits.balances', { provider })
    expect(result.ok, `${provider} 应被接受`).toBe(true)
    expect(seen.length, `${provider} 的余额请求一个都没发`).toBeGreaterThan(0)
    expect(
      seen[0],
      `${provider} 的余额没有打到自己的 host（国内/国际串号会让余额恒 401、聚合折算恒 UNUSABLE）`,
    ).toBe(`${product.platformBaseUrl}${product.walletPath}`)
  })

  it('两站的 host 互不相同（fixture 自检：相同则上面那条恒真）', () => {
    expect(MONKEYCODE.platformBaseUrl).not.toBe(MONKEYCODE_INTL.platformBaseUrl)
  })
})

describe('★★ 生产积分表的内容（源码文本断言的行为替代）', () => {
  it('★ 表里的渠道集合 === registry 里有余额能力、且非特例的渠道', () => {
    // ⚠️ 特例是**形态不匹配**的两类（见 `provider-credits.ts` 文件头）：
    //    opencode（本地派生、零网络）与 qoder 系（只吃 QoderCredential）。
    // ⚠️ 2026-10-08（Task 11-F）：判据改由 `tests/helpers/provider-sets.ts` 单一持有。
    const expected = expectedProviderIdsInCreditsTable().sort()
    const table = createProviderCredits()
    expect(
      Object.keys(table).sort(),
      '生产积分表与 registry 漂移：左侧多出 = 表里有僵尸项，右侧多出 = registry 里'
      + '有余额能力的渠道没进表（那家的余额会恒回 unsupported provider）',
    ).toEqual(expected)
    // 反向：确认上面那圈里真的既有 true 也有特例，否则断言可能恒真。
    expect(PROVIDER_REGISTRY.some((d) => d.credits.balance !== true)).toBe(true)
    // ⚠️ 2026-10-15 加 minimaxintl：12 → 13。
    // ⚠️ 2026-10-16 astudio 并入（credits.balance:true 且不在 CREDITS_TABLE_EXEMPT）：13 → 14。
    // ⚠️ 2026-10-17 autoclaw（AutoClaw 智谱，wallet 余额）：14 → 15。
    // ⚠️ 2026-10-17 **本 fork** 并入 modelscope（魔搭）：15 → 16。
    //    modelscope 原先被豁免（理由「平台没有额度 API」）已作废：真端点是
    //    `/openapi/v1/magicubes/balance`（带 API Key 返 200、随消耗下降）。
    // ⚠️ 2026-10-20 autoclawintl（AutoClaw 国际版，与国内同端点、只差主机）：16 → 17。
    //    ⚠️ 合并上游时**不要**改回 13。
    // ⚠️ 2026-10-19 **本 fork** 并入 codely（Unity，usage/summary）⇒ 15 → 16。
    //    它是全仓首例 balance:true + channel:false（登录/余额均为自由函数，
    //    无 auth 服务；runtime 守卫只查已注册 runtime，codely 被跳过）。
    // ⚠️ 2026-11-01 并入 magicrewintl（MagiCrew 国际版）⇒ 19 → 20。
    //    它与 magicrew 同形（balance + dailyCheckin + onboardingTasks 全开）。
    // ⚠️ 2026-11-02 并入 monkeycode（MonkeyCode）⇒ 20 → 21。
    //    它是 balance + dailyCheckin（无 onboardingTasks），余额走平台 wallet 端点。
    // ⚠️ 2026-11-02 并入 monkeycodeintl（MonkeyCode 国际站）⇒ 21 → 22。
    // ⚠️ 2026-11-02 并入 baizhi（百智云）⇒ 22 → 23。
    //    它是全仓首例「**同一家 provider 的两套凭据分走两个域**」：`sk-` 走
    //    推理网关（`x-api-key`），控制台 cookie 走积分（cookie）。只有后者能查
    //    余额 ⇒ 只填 Key 的账号会走 401 降级路径，不会被当成「零余额」。
    expect(expected.length).toBe(23)
    // ⚠️ **关键集合判据必须对「生产真正调用的那种形态」也成立**（2026-10-08 复审 C1）：
    //    上面那次是 `createProviderCredits()`（无 deps），而端点与 `index.ts` 调的
    //    都是 `createProviderCredits({ loomy, raccoon, zcode })`。deps 只应影响**实现**，
    //    不该影响**键集合** —— 但它俩是同一个对象的两个分支，写错就会让生产少一家
    //    （症状：那家的余额恒回 `unsupported provider`）而本组照样全绿。
    const withDeps = createProviderCredits({
      loomy: { fetchCreditBalance: async () => null },
      raccoon: { fetchCreditBalance: async () => null },
      zcode: { fetchBalanceFor: async () => undefined },
    } as never)
    expect(
      Object.keys(withDeps).sort(),
      '带 deps 的表与不带 deps 的表键集合不一致 —— deps 不该改变表里有哪些渠道',
    ).toEqual(Object.keys(table).sort())
  })

  it('★ 表里每条都至少有一个查询方法（空条目会让该渠道恒回「余额查询失败」）', () => {
    const table = createProviderCredits()
    for (const [id, impl] of Object.entries(table)) {
      expect(
        impl.fetchBalance !== undefined || impl.fetchBalanceDetailed !== undefined,
        `${id} 在表里但没有任何余额方法 —— 它的卡片会恒显示「余额查询失败」`,
      ).toBe(true)
    }
  })

  it('★ fetchStatus 只登记在**真有**同构状态端点的渠道上（buddy 系 + minimax 两站）', () => {
    // ⚠️ 写死这几家是**有意**的：其余渠道（codearts / lobsterai / trae / cline /
    //    loomy）**没有**与 `CheckinStatus` 同构的状态端点 —— 给它们补一个
    //    `fetchStatus` 会让 `credits.status` 从「如实 null」变成「臆造
    //    `{streakDays: 0}`」，面板于是显示「连续 0 天」这种**看起来像真实读数**
    //    的假数据。故本清单变更时必须人工复核。
    // ⚠️ 2026-10-15：minimaxintl 与 `minimax` **共用同一个状态端点形状**
    //    （只差主机），故它同样登记（漏了它 ⇒ 国际站面板的签到状态恒 null）。
    const table = createProviderCredits()
    const withStatus = Object.entries(table)
      .filter(([, impl]) => impl.fetchStatus !== undefined)
      .map(([id]) => id)
      .sort()
    expect(withStatus).toEqual(['buddy', 'minimax', 'minimaxintl', 'workbuddy'])
  })

  it('★ 余额查询优先走**传入的 auth 实例**（它可能带注入的 fetchImpl）', async () => {
    // ⚠️ 三家（loomy / raccoon / zcode）的余额查询走实例方法，因为实例可能带
    //    注入的 `fetchImpl`（测试替身 / 代理）。哨兵证明「实例真的被用了」——
    //    若实现回退到自由函数，哨兵不会出现，且会真发一次网络请求。
    for (const [provider, key, method] of [
      ['loomy', 'loomy', 'fetchCreditBalance'],
      ['raccoon', 'raccoon', 'fetchCreditBalance'],
      ['zcode', 'zcode', 'fetchBalanceFor'],
    ] as const) {
      const sentinel = provider === 'zcode'
        ? { buckets: [], remaining: 77, total: 77, claimablePlans: [] }
        : { total: 77, packages: [], expiredTotal: 0 }
      const table = createProviderCredits({
        [key]: { [method]: async () => sentinel },
      } as never)
      const impl = table[provider]!
      const credential = JSON.parse(JSON.stringify({ access_token: 'AT', zcode_jwt: 'jwt' }))
      const result = await impl.fetchBalanceDetailed!(credential, {} as never)
      expect(
        result.balance?.total,
        `${provider} 没有走传入的 auth 实例（哨兵 77 未出现）`,
      ).toBe(77)
    }
  })

  /**
   * ★★ **端点真的把 `auths` 里的实例交给了工厂**（2026-10-08 复审 C1 的接缝替代）。
   *
   * ## 它守的失效形态
   *
   * 删掉第 5 个形参后，端点的表由 `createProviderCredits({ loomy, raccoon, zcode })`
   * 现造。若有人把它改成 `createProviderCredits()`（**漏掉 deps**）或从别处取表：
   *
   * - **没有编译错误** —— deps 全是可选的（`ProviderCreditsDeps` 三个字段都 `?`）；
   * - **没有其它用例会红** —— 逐家上游路径那组喂的是**真实现 + 桩 fetch**，
   *   loomy / raccoon / zcode 的自由函数回退路径与实例路径**打的是同一个上游
   *   端点**（实例方法内部就是调那个自由函数 + `this.fetchImpl`），故路径断言
   *   照样通过；
   * - 后果在生产里是**真实的功能回退**：这三家的实例可能带注入的 `fetchImpl`
   *   （代理 / 测试替身），漏掉 deps 就退回全局 `fetch` —— 本仓库
   *   `providers-opencode.md` 记录的「dispatcher 与 fetch 必须同源」是同一族缺陷。
   *
   * ⇒ 判据用**实例上的哨兵**：桩实例的 `fetchCreditBalance` 回 4242，
   *    自由函数**不可能**产生它。哨兵出现 = 端点确实把 auths 的实例传给了工厂。
   *
   * ⚠️ 三家的上游路径相同与否不重要 —— 本用例打的是**响应里的数值**，不是路径。
   */
  it('★★ 端点的积分表由 `auths` 现造：三家实例方法被真的调用（漏传 deps 即红）', async () => {
    const sentinelBalance = (total: number) => ({ total, packages: [], expiredTotal: 0 })
    // 只给三家各一个「带实例方法的 auth 桩」，其余键照旧空桩。
    // ⚠️ 不传 credits（透传真实工厂）⇒ 走端点**自己**从 auths 现造的那张表。
    const { call, pool, credentials } = makeRpc(undefined, {
      ...emptyAuths(),
      loomy: { fetchCreditBalance: async () => sentinelBalance(4242) },
      raccoon: { fetchCreditBalance: async () => sentinelBalance(4243) },
      zcode: { fetchBalanceFor: async () => ({ buckets: [], remaining: 4244, total: 4244 }) },
    })
    // 上游一律不许被碰到：哨兵说明实例方法已生效，回退到自由函数会真发请求。
    vi.stubGlobal('fetch', async () => {
      throw new Error('三家必须走 auths 里的实例方法，不得回退到自由函数')
    })

    for (const [provider, expected] of [['loomy', 4242], ['raccoon', 4243], ['zcode', 4244]] as const) {
      const ref = `${provider.toUpperCase()}_ACCOUNT_DERIVE`
      await seed(pool, provider, `${provider}-d`, ref)
      await credentials.set(ref, JSON.stringify({ access_token: 'AT', zcode_jwt: 'jwt' }))
      const result = await call('credits.balances', { provider })
      expect(result.ok, `${provider} 应被接受`).toBe(true)
      expect(
        result.value.accounts[0]?.balance?.total,
        `${provider} 没有走 auths 里的实例方法（哨兵 ${expected} 未出现）——`
        + '端点可能漏传了 `createProviderCredits` 的 deps，或表不再由 auths 派生',
      ).toBe(expected)
    }
    // 反向：确认工厂**真的被调过**且拿到了 auths 的实例（不是空 deps）。
    // 只看哨兵会漏掉「表由别处提供、恰好也是这三家」的形态。
    expect(
      creditsOverride.lastDeps,
      '端点没有把 auths 的实例交给 createProviderCredits',
    ).toMatchObject({
      loomy: expect.anything(), raccoon: expect.anything(), zcode: expect.anything(),
    })
  })
})

describe('provider 边界：拒绝是兜底契约，判据来自 registry', () => {
  it.each(['credits.balances', 'credits.status'])('%s 对未知 provider 回可读的 bad-request', async (method) => {
    const { call } = makeRpc()
    const result = await call(method, { provider: 'unknownprovider' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('unsupported provider: unknownprovider')
  })

  it('★ 每个 registry 声明 balance:true 的渠道都被接受；声明 false 的被拒', async () => {
    const { call } = makeRpc()
    for (const d of PROVIDER_REGISTRY) {
      const result = await call('credits.balances', { provider: d.id })
      expect(
        result.ok,
        d.credits.balance === true
          ? `${d.id} 声明了 balance:true 却被拒（能力表与分派漂移）`
          : `${d.id} 未声明余额能力却被接受`,
      ).toBe(d.credits.balance === true)
    }
    // 反向：确认上面那圈里真的既有 true 也有 false，否则断言恒真。
    expect(PROVIDER_REGISTRY.some((d) => d.credits.balance === true)).toBe(true)
    expect(PROVIDER_REGISTRY.some((d) => d.credits.balance !== true)).toBe(true)
  })

  it('credits.status 对 registry 里的每个渠道都被接受（未知 id 除外）', async () => {
    const { call } = makeRpc()
    for (const d of PROVIDER_REGISTRY) {
      const result = await call('credits.status', { provider: d.id })
      expect(result.ok, `${d.id} 是已登记渠道，不该回 unsupported provider`).toBe(true)
    }
  })
})
