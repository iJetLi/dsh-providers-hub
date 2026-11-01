/**
 * magicrew-auth-pool.spec.ts —— Magicrew 账号池适配层（任务 3b）单测
 *
 * 被测源码：`src/magicrew-auth.ts` 的 `createMagicrewRefreshOnce` + `class MagicrewAuth`。
 *
 * ── 零网络 / 零真实凭据（硬约束）────────────────────────────────────────
 * 全部走注入：`MagicrewAuthOptions{fetchImpl, store, product}`；`fetchImpl` 是假 fetch，
 * 只回 fixture 信封，永远不打 `i-magic-service.letsmagic.cn`；`store` 是内存替身，
 * 形状与宿主 `ctx.credentials` 一致（**值是字符串**）。
 *
 * ── 为什么类本身必须单独覆盖（简报步骤 3b）──────────────────────────────
 * 续期器是**无状态**的纯逻辑，而真正会写坏数据的是类这一层：写回账号池
 * （issue !IKIRTT）、`active` 的两道判据、`refreshAll` 的过滤口径。本仓库的红线是
 * 「守卫全绿不等于有牙」⇒ 下面每条都用「真的被调用 / 真的零调用」作判据。
 *
 * ⚠️ 替身 pool 的 `listAccountsByProvider` **必须返回同步数组**（不是 Promise）——
 * 那是 issue IKLPTZ 的真实形态；用 Promise 替身会让「把它当 Promise」的变异**全体无牙**
 * （`await` 一个数组照样能用）。
 */
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'
import type { AccountPool } from '../../src/account-pool.js'
import {
  createMagicrewRefreshOnce,
  magicrewDisplayNickname,
  magicrewExpiresAtMs,
  MagicrewAuth,
  parseMagicrewCredential,
  type MagicrewAuthOptions,
} from '../../src/magicrew-auth.js'
import type { ProviderAccountEntry } from '../../src/types.js'
// ⚠️ 2026-11-01 二审：两站串号守卫要用到国际站常量。
import { MAGICREW_INTL } from '../../src/magicrew-product.js'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// ════════════════════════════════════════════════════════════════════════
// 假替身
// ════════════════════════════════════════════════════════════════════════

/**
 * 把宿主 ref 归一成 Map 键。
 *
 * ⚠️ `credentialRef()` 的产物在运行时**就是那个字符串本身**（`CredentialRef` 是
 * brand 类型），所以 `String(ref)` 是权威取法；但替身仍兼容 `{name}` 形状，
 * 免得将来宿主换成对象形状时这些用例静默失效（那样所有 ref 会塌成同一个键，
 * `currentCredential` 读到的永远是同一条凭据 —— 多账号用例**看着还在绿**）。
 */
function refKey(ref: { name?: unknown } | string): string {
  if (typeof ref === 'string') return ref
  const name = ref?.name
  return typeof name === 'string' ? name : String(ref)
}

/** 最小内存凭据库，形状与 `ctx.credentials` 一致（对齐 `astudio-auth.spec.ts` 的 FakeStore）。 */
class FakeStore {
  readonly values = new Map<string, string>()
  /** 记录真正经过 `set()` 的 ref（用来断言「零写回」）。 */
  readonly setCalls: string[] = []
  readonly unsetCalls: string[] = []
  /** 置为非空 ⇒ `set()` 一律抛错（模拟磁盘满 / 凭据库被锁）。 */
  throwOnSet: Error | undefined

  /** 播种：直接写 map，**不**计入 setCalls（用于区分「准备」与「被测的写回」）。 */
  seed(refName: string, value: string): void {
    this.values.set(refName, value)
  }

  async resolve(ref: { name?: unknown } | string): Promise<{ value: string } | undefined> {
    const value = this.values.get(refKey(ref))
    return value === undefined ? undefined : { value }
  }

  async set(ref: { name?: unknown } | string, value: string): Promise<void> {
    // ⚠️ 先抛、后记 —— 这是「写回失败」的真实形态（存储里一个字节都没变），
    //    也是「单向门」用例的唯一入口。
    if (this.throwOnSet !== undefined) throw this.throwOnSet
    const key = refKey(ref)
    this.setCalls.push(key)
    this.values.set(key, value)
  }

  async unset(ref: { name?: unknown } | string): Promise<void> {
    const key = refKey(ref)
    this.unsetCalls.push(key)
    this.values.delete(key)
  }

  /** 读回并解析某 ref 下的凭据 JSON（断言写回内容用）。 */
  saved(refName: string): Record<string, unknown> | undefined {
    const raw = this.values.get(refName)
    return raw === undefined ? undefined : JSON.parse(raw) as Record<string, unknown>
  }
}

/**
 * 替身账号池。
 *
 * ⚠️ `listAccountsByProvider` **同步返回数组** —— 与 `src/account-pool.ts:2158` 逐字同形
 * （issue IKLPTZ：那里是 `ProviderAccountEntry[]`，没有 Promise）。
 */
class FakePool {
  readonly updates: { id: string, patch: { expiresAt?: number } }[] = []
  readonly listCalls: string[] = []

  constructor(private readonly accounts: ProviderAccountEntry[]) {}

  listAccountsByProvider(provider: string): ProviderAccountEntry[] {
    this.listCalls.push(provider)
    /**
     * ⚠️ **必须真的按 provider 过滤**（2026-11-01 二审）：
     * 原先恒返回 `this.accounts` ⇒ 「`refreshAll` 写死 `listAccountsByProvider('magicrew')`」
     * 这种串号缺陷**完全测不出来**（实测：把它改成写死 `'magicrew'`，133 条用例全绿）。
     * 而生产后果是国际站账号**永不自动续期**（2 小时的 `mgw_` key 一死就 401），
     * 且国内账号被两个实例各刷一遍（一次性 refresh_token 会被二次消费）。
     */
    return this.accounts.filter((entry) => entry.provider === provider)
  }

  async updateAccount(id: string, patch: { expiresAt?: number }): Promise<void> {
    this.updates.push({ id, patch })
  }

  asPool(): AccountPool {
    return this as unknown as AccountPool
  }
}

function makeContext(): { ctx: Context, store: FakeStore } {
  const ctx = new Context()
  const store = new FakeStore()
  // ⚠️ `provide` 的键必须与 `MagicrewAuth.storeFor()` 读的键一致（`credentials`）。
  ctx.provide('credentials', store as never)
  return { ctx, store }
}

function account(
  id: string,
  refName: string,
  overrides: Partial<ProviderAccountEntry> = {},
): ProviderAccountEntry {
  return {
    id,
    provider: 'magicrew',
    nickname: id,
    enabled: true,
    credentialRef: refName,
    createdAt: 0,
    refreshable: true,
    ...overrides,
  }
}

/** 凭据 JSON（字段名与 `MagicrewCredential` 一致，值全为假）。 */
function credentialJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jwt: 'jwt-fixture',
    organizationCode: 'org-fixture',
    apiKey: 'mgw_old',
    apiKeyExpiresAt: 1,
    refreshToken: 'rt_old',
    ...overrides,
  })
}

function refreshEnvelope(apiKey: string, refreshToken: string, expiresAt?: number): Response {
  return jsonResponse({
    code: 1000,
    data: {
      api_key: apiKey,
      refresh_token: refreshToken,
      ...expiresAt === undefined ? {} : { api_key_expires_at: expiresAt },
    },
  })
}

// ════════════════════════════════════════════════════════════════════════
// ① 续期器本体：一次性 token 必须串行（简报步骤 1 原文）
// ════════════════════════════════════════════════════════════════════════

describe('magicrew 续期（一次性 token 必须串行）', () => {
  it('★ 并发两次续期只真发一次 PUT（否则第二个 token 立即失效）', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      // 人为拉长，制造并发窗口
      await new Promise((resolve) => setTimeout(resolve, 20))
      return jsonResponse({
        code: 1000,
        data: { api_key: `mgw_${calls}`, refresh_token: `rt_${calls}` },
      })
    })
    const refreshOnce = createMagicrewRefreshOnce({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const state = { refreshToken: 'rt_old' }
    const [a, b] = await Promise.all([refreshOnce(state), refreshOnce(state)])
    // 串行 + 去重 ⇒ 只发一次
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(a?.apiKey).toBe('mgw_1')
    expect(b?.apiKey).toBe('mgw_1')
    // 轮换后的新 token 被写回共享状态（下一次才能用）
    expect(state.refreshToken).toBe('rt_1')
  })

  it('★ 没有 refresh_token ⇒ 返回 undefined 且不发请求', async () => {
    const fetchImpl = vi.fn()
    const refreshOnce = createMagicrewRefreshOnce({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const state: { refreshToken?: string } = {}
    expect(await refreshOnce(state)).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ════════════════════════════════════════════════════════════════════════
// ② 类级覆盖（简报步骤 3b 的四条必备 + 两条加固）
// ════════════════════════════════════════════════════════════════════════

describe('MagicrewAuth（账号池适配）', () => {
  it('currentCredential 走 resolve + JSON.parse；坏 JSON 当「无凭据」而不抛', async () => {
    const { ctx, store } = makeContext()
    store.seed('MAGICREW_ACCESS_TOKEN', credentialJson({ phone: '13011112222' }))
    const auth = new MagicrewAuth(ctx, { fetchImpl: vi.fn() as unknown as typeof fetch })

    // 默认 ref（`product.defaultCredentialRef`）读回来是一份 `MagicrewCredential`
    const credential = await auth.currentCredential()
    expect(credential?.jwt).toBe('jwt-fixture')
    expect(credential?.organizationCode).toBe('org-fixture')
    expect(credential?.phone).toBe('13011112222')

    // 显式 ref 也走同一条路（多账号靠它区分）
    store.seed('MAGICREW_ACCOUNT_B', credentialJson({ jwt: 'jwt-b' }))
    expect((await auth.currentCredential('MAGICREW_ACCOUNT_B'))?.jwt).toBe('jwt-b')

    // 坏 JSON：`JSON.parse` 会抛，但判据是 `undefined`（不是异常）——
    // 一次凭据库损坏不该让整轮续期炸掉。
    store.seed('MAGICREW_ACCOUNT_BAD', '{not json')
    await expect(auth.currentCredential('MAGICREW_ACCOUNT_BAD')).resolves.toBeUndefined()

    // 完全没有凭据 ⇒ undefined
    await expect(auth.currentCredential('MAGICREW_ACCOUNT_MISSING')).resolves.toBeUndefined()
  })

  it('refreshAccountCredential 把新凭据写回凭据库，并把 expiresAt 写回账号池', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MAGICREW_ACCOUNT_A'
    const expiresAt = 1_760_000_000_000
    store.seed(refName, credentialJson())
    const fetchImpl = vi.fn(async () => refreshEnvelope('mgw_new', 'rt_new', expiresAt))
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool([account('magicrew-a', refName)])

    await auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')

    // ① 凭据库：新 apiKey + 轮换后的 refreshToken 都落了库，其余字段不丢
    expect(store.setCalls).toEqual([refName])
    const saved = store.saved(refName)
    expect(saved?.apiKey).toBe('mgw_new')
    expect(saved?.refreshToken).toBe('rt_new')
    expect(saved?.apiKeyExpiresAt).toBe(expiresAt)
    expect(saved?.jwt).toBe('jwt-fixture')
    expect(saved?.organizationCode).toBe('org-fixture')

    // ② 账号池：`updateAccount(id, { expiresAt })` **真的被调用** ——
    //    这是 issue !IKIRTT 的判据（凭据续好了、界面不更新等于没修）。
    expect(pool.updates).toEqual([{ id: 'magicrew-a', patch: { expiresAt } }])
  })

  it('refreshAccountCredential 在 apiKeyExpiresAt 缺失时**不**写 expiresAt（绝不写 undefined）', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MAGICREW_ACCOUNT_NOEXP'
    store.seed(refName, credentialJson())
    // 信封里没有 api_key_expires_at ⇒ `key.apiKeyExpiresAt === undefined`
    const auth = new MagicrewAuth(ctx, {
      fetchImpl: vi.fn(async () => refreshEnvelope('mgw_new', 'rt_new')) as unknown as typeof fetch,
    })
    const pool = new FakePool([account('magicrew-a', refName)])

    await auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')

    // 凭据照常写回，但池里一个字都不写：写成 `undefined` 会被 JSON.stringify 整个丢弃，
    // 于是 UI 从「已过期」变成「未知」，反而抹掉既有信息（`expiry-sync.ts` 的硬规矩）。
    expect(store.setCalls).toEqual([refName])
    expect(pool.updates).toEqual([])
  })

  it('logout() 之后再续期 ⇒ 零请求、零写回（`active` 第一道判据）', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MAGICREW_ACCOUNT_A'
    store.seed(refName, credentialJson())
    const fetchImpl = vi.fn(async () => refreshEnvelope('mgw_new', 'rt_new', 1_760_000_000_000))
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool([account('magicrew-a', refName)])

    await auth.logout()
    await auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.setCalls).toEqual([])
    expect(pool.updates).toEqual([])
  })

  it('续期中途 logout() ⇒ 网络回来了也零写回（`active` 第二道判据）', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MAGICREW_ACCOUNT_A'
    store.seed(refName, credentialJson())
    let release: (() => void) | undefined
    const fetchImpl = vi.fn(async () => {
      // 卡在「网络往返中」，让 logout 一定能插进来。
      await new Promise<void>((resolve) => { release = resolve })
      return refreshEnvelope('mgw_new', 'rt_new', 1_760_000_000_000)
    })
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool([account('magicrew-a', refName)])

    const pending = auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')
    // ⚠️ 必须等到 fetch 真的发出：否则 logout 早于**第一道**判据，
    //    这条用例会退化成上一条的同义反复（第二道判据永远测不到）。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await auth.logout()
    release?.()
    await pending

    // 用户已登出/账号已删 ⇒ 这份续期结果必须被丢弃（否则账号「复活」、登出后仍可用）。
    expect(store.setCalls).toEqual([])
    expect(pool.updates).toEqual([])
  })

  it('refreshAll 续期**全部**账号（含 enabled:false 与 refreshable:false）', async () => {
    const { ctx, store } = makeContext()
    const expiresAt = 1_760_000_000_000
    const accounts = [
      account('magicrew-a', 'MAGICREW_ACCOUNT_A'),
      // 停用只影响「自动选号」，与「凭据该不该保持新鲜」无关 ⇒ 必须续期。
      account('magicrew-b', 'MAGICREW_ACCOUNT_B', { enabled: false }),
      // `refreshable` 是**对账结果**，拿它当门禁会把一次瞬时失败固化成单向门 ⇒ 必须续期。
      account('magicrew-c', 'MAGICREW_ACCOUNT_C', { refreshable: false }),
    ]
    for (const entry of accounts) store.seed(entry.credentialRef, credentialJson())
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return refreshEnvelope(`mgw_${calls}`, `rt_${calls}`, expiresAt)
    })
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool(accounts)

    await auth.refreshAll(pool.asPool())

    // 三个账号**全部**被续期（含停用与「上次对账为不可续期」的那两个）
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(store.setCalls).toEqual(['MAGICREW_ACCOUNT_A', 'MAGICREW_ACCOUNT_B', 'MAGICREW_ACCOUNT_C'])
    expect(pool.updates.map((update) => update.id)).toEqual(['magicrew-a', 'magicrew-b', 'magicrew-c'])
    for (const update of pool.updates) expect(update.patch).toEqual({ expiresAt })
    // 池是按 `product.id` 查的（写错 provider ⇒ 恒空列表，静默零续期）
    expect(pool.listCalls).toEqual(['magicrew'])
  })

  /**
   * ★★ **国际站实例只续期国际站账号**（2026-11-01 二审补）。
   *
   * 实测：把 `src/magicrew-auth.ts` 的 `refreshAll` 里
   * `pool.listAccountsByProvider(this.product.id)` 写死成 `'magicrew'`，
   * **133 条相关用例全绿** —— 而生产后果两条：
   *
   * 1. 国际站账号**永不自动续期** ⇒ 2 小时的 `mgw_` key 一死就 401，
   *    用户只能手动重登；
   * 2. 国内账号被**两个实例各刷一遍** ⇒ 一次性 `refresh_token` 二次消费
   *    （第二次必然失败，还会把第一次成功换来的 token 关系弄乱）。
   *
   * ⚠️ 这条能成立的前提是 `FakePool.listAccountsByProvider` **真的按 provider 过滤**
   *    （上面刚补的），否则「写死」与「正确」都返回同一份列表。
   */
  it('★★ 国际站实例只续期自己的账号（写死 magicrew 即红）', async () => {
    const { ctx, store } = makeContext()
    const expiresAt = 1_760_000_000_000
    const accounts = [
      account('cn-a', 'MAGICREW_ACCOUNT_A'),
      account('intl-a', 'MAGICREWINTL_ACCOUNT_A', { provider: 'magicrewintl' }),
    ]
    for (const entry of accounts) store.seed(entry.credentialRef, credentialJson())
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return refreshEnvelope(`mgw_${calls}`, `rt_${calls}`, expiresAt)
    })
    const auth = new MagicrewAuth(ctx, {
      product: MAGICREW_INTL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const pool = new FakePool(accounts)

    await auth.refreshAll(pool.asPool())

    // ① 只查国际站（写死 'magicrew' ⇒ 这一条立刻红）
    expect(pool.listCalls, 'refreshAll 查的不是自己那个 product 的账号').toEqual(['magicrewintl'])
    // ② 只续期国际站那一个账号（国内账号一次都不该被这个实例碰）
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(store.setCalls).toEqual(['MAGICREWINTL_ACCOUNT_A'])
    expect(pool.updates.map((update) => update.id)).toEqual(['intl-a'])
  })

  it('★ refreshAll 带 lead-time：距过期 >1 小时 ⇒ **零请求**，≤1 小时 ⇒ 续期', async () => {
    const { ctx, store } = makeContext()
    // 判据是 `expiresAt - now <= 1 小时`（`REFRESH_LEAD_MS`）⇒ 「1 小时」这一格是
    // **边界**，测试里跑几毫秒就会掉进「≤1 小时」那一侧 ⇒ 远端侧用 1 小时 + 1 分钟，
    // 近端侧用 30 分钟。两侧都要**严格**落在各自区间内，否则这条用例会随机红。
    const far = Date.now() + 3_600_000 + 60_000
    const near = Date.now() + 30 * 60_000
    const accounts = [
      account('magicrew-far', 'MAGICREW_ACCOUNT_FAR'),
      account('magicrew-near', 'MAGICREW_ACCOUNT_NEAR'),
    ]
    store.seed('MAGICREW_ACCOUNT_FAR', credentialJson({ apiKeyExpiresAt: far }))
    store.seed('MAGICREW_ACCOUNT_NEAR', credentialJson({ apiKeyExpiresAt: near }))
    const fetchImpl = vi.fn(async () => refreshEnvelope('mgw_new', 'rt_new', 1_760_000_000_000))
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool(accounts)

    await auth.refreshAll(pool.asPool())

    // ⚠️ lead-time 缺失的后果（本用例的判据）：`mgw_` key TTL 只有 2 小时、调度器
    //    30 分钟一轮，且**签新 key 会吊销旧 key** ⇒ 每 2 小时白签 4 次，轮换瞬间
    //    在途的推理请求还可能拿到已吊销的 key。
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(store.setCalls).toEqual(['MAGICREW_ACCOUNT_NEAR'])
    expect(pool.updates.map((update) => update.id)).toEqual(['magicrew-near'])
    // 远未到期那个账号**一个字节都没动**（凭据没被重写 = 旧 key 没被吊销）
    expect(store.saved('MAGICREW_ACCOUNT_FAR')?.apiKey).toBe('mgw_old')
  })

  it('refreshAll 对**读不到到期时刻**的凭据照旧续期（不能放着烂掉）', async () => {
    const { ctx, store } = makeContext()
    store.seed(
      'MAGICREW_ACCOUNT_A',
      JSON.stringify({ jwt: 'jwt-fixture', organizationCode: 'org-fixture', refreshToken: 'rt_old' }),
    )
    const fetchImpl = vi.fn(async () => refreshEnvelope('mgw_new', 'rt_new', 1_760_000_000_000))
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool([account('magicrew-a', 'MAGICREW_ACCOUNT_A')])

    await auth.refreshAll(pool.asPool())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(store.setCalls).toEqual(['MAGICREW_ACCOUNT_A'])
  })

  it('单个账号失败不拖累其余账号（且每个账号仍各自续期）', async () => {
    const { ctx, store } = makeContext()
    const expiresAt = 1_760_000_000_000
    const accounts = [
      account('magicrew-a', 'MAGICREW_ACCOUNT_A'),
      account('magicrew-b', 'MAGICREW_ACCOUNT_B'),
    ]
    for (const entry of accounts) store.seed(entry.credentialRef, credentialJson())
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      // 第一个账号的网络失败（信封业务码非 1000 ⇒ `magicrewCall` 抛）
      if (calls === 1) return jsonResponse({ code: 403, message: 'token无效' })
      return refreshEnvelope('mgw_b', 'rt_b', expiresAt)
    })
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool(accounts)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let warnMessages: string[] = []
    try {
      await auth.refreshAll(pool.asPool())
    } finally {
      // ⚠️ 必须在 `mockRestore()` **之前**取走记录：它会连同 mock 历史一起清空
      //    （就地写在 finally 之后会让这条断言恒为 0，变成假红）。
      warnMessages = warn.mock.calls.map((call) => String(call[0]))
      warn.mockRestore()
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // A 失败 ⇒ 零写回；B 照常写回（正是「不拖累」的判据）
    expect(store.setCalls).toEqual(['MAGICREW_ACCOUNT_B'])
    expect(pool.updates).toEqual([{ id: 'magicrew-b', patch: { expiresAt } }])
    // 失败必须留字**并点名账号**：静默会让界面永远显示「可刷新」却刷不动。
    expect(warnMessages).toHaveLength(1)
    expect(warnMessages[0]).toContain('MAGICREW_ACCOUNT_A')
    expect(warnMessages[0]).toContain('token无效')
  })

  it('★ 两个账号并发续期**不串号**（inFlight 必须按 state 分键）', async () => {
    const { ctx, store } = makeContext()
    const expiresAt = 1_760_000_000_000
    store.seed('MAGICREW_ACCOUNT_A', credentialJson({ jwt: 'jwt-a', refreshToken: 'rt_a' }))
    store.seed('MAGICREW_ACCOUNT_B', credentialJson({ jwt: 'jwt-b', refreshToken: 'rt_b' }))
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      const n = calls
      await new Promise((resolve) => setTimeout(resolve, 20))
      return refreshEnvelope(`mgw_${n}`, `rt_${n}`, expiresAt)
    })
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool([
      account('magicrew-a', 'MAGICREW_ACCOUNT_A'),
      account('magicrew-b', 'MAGICREW_ACCOUNT_B'),
    ])

    await Promise.all([
      auth.refreshAccountCredential('MAGICREW_ACCOUNT_A', pool.asPool(), 'magicrew-a'),
      auth.refreshAccountCredential('MAGICREW_ACCOUNT_B', pool.asPool(), 'magicrew-b'),
    ])

    // 两个账号各有一次性 token ⇒ 两次 PUT 都必须真发（不许被去重成一次）
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // 各自拿到**自己那一发**的 key（串号的话 B 会被写成 A 的 `mgw_1`）
    expect(store.saved('MAGICREW_ACCOUNT_A')?.apiKey).toBe('mgw_1')
    expect(store.saved('MAGICREW_ACCOUNT_B')?.apiKey).toBe('mgw_2')
    expect(store.saved('MAGICREW_ACCOUNT_A')?.refreshToken).toBe('rt_1')
    expect(store.saved('MAGICREW_ACCOUNT_B')?.refreshToken).toBe('rt_2')
    // JWT 也不会互相覆盖
    expect(store.saved('MAGICREW_ACCOUNT_A')?.jwt).toBe('jwt-a')
    expect(store.saved('MAGICREW_ACCOUNT_B')?.jwt).toBe('jwt-b')
    expect(pool.updates.map((update) => update.id)).toEqual(['magicrew-a', 'magicrew-b'])
  })

  it('★ **同一个 ref** 两次并发续期只真发一次 PUT（一次性 token 不得二次消费）', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MAGICREW_ACCOUNT_SAME'
    const expiresAt = 1_760_000_000_000
    store.seed(refName, credentialJson({ jwt: 'jwt-same', refreshToken: 'rt_same' }))
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      const n = calls
      await new Promise((resolve) => setTimeout(resolve, 20))
      return refreshEnvelope(`mgw_${n}`, `rt_${n}`, expiresAt)
    })
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool([account('magicrew-same', refName)])

    // 同一账号的两个并发入口（面板「刷新」+ 定时器，或两个请求同时撞 401）。
    await Promise.all([
      auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-same'),
      auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-same'),
    ])

    // ⚠️ 本条与上一条（不同账号不串号）成对：上一条证「不同 state 各自独立」，
    //    本条证「同 state 只发一次」。二者缺一，`stateOf` 退化成
    //    「每次返回新对象」时都还能全绿 —— 而那正是一次性 token 被二次消费的回归。
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(store.saved(refName)?.apiKey).toBe('mgw_1')
    expect(store.saved(refName)?.refreshToken).toBe('rt_1')
    // 两次调用都各自完成写回（写的是同一份结果），不是「第二次被静默丢掉」
    expect(store.setCalls).toEqual([refName, refName])
    expect(pool.updates.map((update) => update.id)).toEqual(['magicrew-same', 'magicrew-same'])
  })

  it('★ `store.set` 抛错后，下一轮**不得**把内存里的新 token 退回已被消费的旧 token（单向门）', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MAGICREW_ACCOUNT_A'
    const expiresAt = 1_760_000_000_000
    store.seed(refName, credentialJson({ refreshToken: 'rt_old' }))
    const bodies: string[] = []
    let calls = 0
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      calls += 1
      const n = calls
      bodies.push(String(init?.body ?? ''))
      return refreshEnvelope(`mgw_${n}`, `rt_${n}`, expiresAt)
    })
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool([account('magicrew-a', refName)])

    // ── 第一轮：轮换成功、写回失败 ────────────────────────────────────
    store.throwOnSet = new Error('凭据库写坏了')
    await expect(
      auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a'),
    ).rejects.toThrow('凭据库写坏了')
    // 上游已消费 `rt_old`、内存里是 `rt_1`，而存储里还是 `rt_old`
    expect(store.saved(refName)?.refreshToken).toBe('rt_old')
    expect(JSON.parse(bodies[0]!).refresh_token).toBe('rt_old')

    // ── 第二轮：写回恢复正常 ─────────────────────────────────────────
    store.throwOnSet = undefined
    await auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')

    // ⚠️ 这一发必须用**内存里那条**（`rt_1`）。若 `stateOf` 照「存储优先」把内存
    //    改回 `rt_old`，就会拿一条**上游已消费**的 token 去换 ⇒ 此后每一轮都失败
    //    ⇒ 单向门，用户只能重新登录。这正是缺陷的判据。
    expect(JSON.parse(bodies[1]!).refresh_token).toBe('rt_1')
    expect(store.saved(refName)?.refreshToken).toBe('rt_2')
    expect(store.saved(refName)?.apiKey).toBe('mgw_2')
    expect(pool.updates.map((update) => update.id)).toEqual(['magicrew-a'])
  })

  it('refreshAll 跳过没有 credentialRef 的池条目（不崩、也不误写）', async () => {
    const { ctx, store } = makeContext()
    store.seed('MAGICREW_ACCOUNT_A', credentialJson())
    const auth = new MagicrewAuth(ctx, {
      fetchImpl: vi.fn(async () => refreshEnvelope('mgw_new', 'rt_new')) as unknown as typeof fetch,
    })
    const pool = new FakePool([
      account('magicrew-empty', ''),
      account('magicrew-a', 'MAGICREW_ACCOUNT_A'),
    ])

    await auth.refreshAll(pool.asPool())

    expect(store.setCalls).toEqual(['MAGICREW_ACCOUNT_A'])
    expect(pool.updates).toEqual([])
  })

  it('没有注入 store 且宿主也没有 credentials ⇒ 一切静默为「无凭据」', async () => {
    const ctx = new Context()
    const fetchImpl = vi.fn()
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool([account('magicrew-a', 'MAGICREW_ACCOUNT_A')])

    await expect(auth.currentCredential()).resolves.toBeUndefined()
    await auth.refreshAll(pool.asPool())
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(pool.updates).toEqual([])
  })

  it('注入的 store 优先于宿主 ctx.credentials', async () => {
    const { ctx, store } = makeContext()
    const injected = new FakeStore()
    injected.seed('MAGICREW_ACCESS_TOKEN', credentialJson({ jwt: 'jwt-injected' }))
    store.seed('MAGICREW_ACCESS_TOKEN', credentialJson({ jwt: 'jwt-host' }))
    const auth = new MagicrewAuth(ctx, {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      store: injected as unknown as MagicrewAuthOptions['store'],
    })

    expect((await auth.currentCredential())?.jwt).toBe('jwt-injected')
  })

  it('★ 失败夹一次**外部写入**后再失败 ⇒ marker 重新上膛（旧值不得被抬回）', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MAGICREW_ACCOUNT_A'
    const expiresAt = 1_760_000_000_000
    store.seed(refName, credentialJson({ refreshToken: 'rt_a' }))
    const bodies: string[] = []
    let calls = 0
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      calls += 1
      bodies.push(String(init?.body ?? ''))
      return refreshEnvelope(`mgw_${calls}`, `rt_${calls}_rot`, expiresAt)
    })
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool([account('magicrew-a', refName)])

    // t1：轮换 rt_a→… 成功、写回失败 ⇒ 库仍是 rt_a（已消费）
    store.throwOnSet = new Error('写回失败 #1')
    await expect(auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')).rejects.toThrow()
    expect(JSON.parse(bodies[0]!).refresh_token).toBe('rt_a')

    // t2：**外部写入**（备份导入 / 合并写入 / 另一实例 / 复用同一 ref 的重登）
    store.seed(refName, credentialJson({ jwt: 'jwt-ext', refreshToken: 'rt_l' }))

    // t3：又一轮失败 ⇒ marker 必须**改成这一轮被消费的 rt_l**（不是停在 rt_a）
    store.throwOnSet = new Error('写回失败 #2')
    await expect(auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')).rejects.toThrow()
    // 外部写入的 token 被采纳（正确），本轮用掉的正是它
    expect(JSON.parse(bodies[1]!).refresh_token).toBe('rt_l')
    expect(store.saved(refName)?.refreshToken).toBe('rt_l')

    // t4：写回恢复 ⇒ 必须用**内存里那条**（rt_2_rot），不许回到已被消费的 rt_l。
    //    ⚠️ 「只记第一条」的旧实现到这里会拿 rt_l 去换 ⇒ 必失败 ⇒ 门重开。
    store.throwOnSet = undefined
    await auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')
    expect(JSON.parse(bodies[2]!).refresh_token).toBe('rt_2_rot')
    expect(store.saved(refName)?.refreshToken).toBe('rt_3_rot')
    expect(store.saved(refName)?.jwt).toBe('jwt-ext')
  })

  it('★ 写回失败态下 `refreshAll` 绕开 lead-time 门（否则要等陈旧时刻进入 lead 窗口才自愈）', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MAGICREW_ACCOUNT_A'
    const pool = new FakePool([account('magicrew-a', refName)])
    // 库里是「远未到期」的陈旧值：距 2 小时。正常轮次下 `refreshAll` 会跳过它。
    store.seed(refName, credentialJson({
      refreshToken: 'rt_old',
      apiKeyExpiresAt: Date.now() + 2 * 60 * 60_000,
    }))
    const bodies: string[] = []
    let calls = 0
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      calls += 1
      bodies.push(String(init?.body ?? ''))
      return refreshEnvelope(`mgw_${calls}`, `rt_${calls}_rot`, Date.now() + 2 * 60 * 60_000)
    })
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })

    // ① 用户点「刷新」：不带 lead-time ⇒ 真去续 ⇒ 轮换成功但**写回失败**
    store.throwOnSet = new Error('写回失败')
    await expect(auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // ② 30 分钟定时器跑 `refreshAll`：此刻库里 expiresAt 仍「远未到期」，
    //    但那是**上一轮**的时刻（本轮拿到的新 key 还没写进去，实际 key 已被吊销）
    //    ⇒ 必须照样续期（否则用死 key 一路失败到陈旧时刻进入 lead 窗口）。
    store.throwOnSet = undefined
    await auth.refreshAll(pool.asPool())

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // 且用的是内存里那条新 token，不是库里那条已消费的
    expect(JSON.parse(bodies[1]!).refresh_token).toBe('rt_1_rot')
    expect(store.saved(refName)?.apiKey).toBe('mgw_2')

    // ③ 写回已恢复、库里的 `expiresAt` 也已是新鲜值（2 小时）⇒ lead-time 门必须
    //    **重新生效**：否则「写回失败态」那个旁路会一直开着，该账号此后每 30 分钟
    //    被无条件轮换一次（= 本 diff 刚修掉的那个缺陷以另一种方式回来）。
    //    ⚠️ 这条腿的承重点是「写回成功时清 marker」（`state.staleRefreshToken = undefined`）。
    await auth.refreshAll(pool.asPool())
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('★ 「成功 → 失败」连续两轮：成功必须清除 marker，失败必须重新上膛', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MAGICREW_ACCOUNT_A'
    const expiresAt = 1_760_000_000_000
    store.seed(refName, credentialJson({ refreshToken: 'rt_a' }))
    const bodies: string[] = []
    let calls = 0
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      calls += 1
      bodies.push(String(init?.body ?? ''))
      return refreshEnvelope(`mgw_${calls}`, `rt_${calls}_rot`, expiresAt)
    })
    const auth = new MagicrewAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const pool = new FakePool([account('magicrew-a', refName)])

    // 第 1 轮：成功 ⇒ 库里 rt_1_rot，marker 清空
    await auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')
    expect(store.saved(refName)?.refreshToken).toBe('rt_1_rot')

    // 第 2 轮：失败 ⇒ marker 必须登记「这一轮被消费的 rt_1_rot」（而不是空/旧值）
    store.throwOnSet = new Error('写回失败')
    await expect(auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')).rejects.toThrow()
    expect(store.saved(refName)?.refreshToken).toBe('rt_1_rot')

    // 第 3 轮：库值 rt_1_rot 已被消费 ⇒ `stateOf` 必须跳过它，用内存里的 rt_2_rot。
    //    ⚠️ 若第 1 轮成功时没清 marker，第 2 轮失败也不会重新登记（「只记第一条」）
    //    ⇒ 这一步会拿 rt_1_rot 去换 ⇒ 单向门。
    store.throwOnSet = undefined
    await auth.refreshAccountCredential(refName, pool.asPool(), 'magicrew-a')
    expect(JSON.parse(bodies[2]!).refresh_token).toBe('rt_2_rot')
    expect(store.saved(refName)?.refreshToken).toBe('rt_3_rot')
  })
})

// ════════════════════════════════════════════════════════════════════════
// ⑧ 展示昵称的优先级与**向后兼容**（2026-10-29 真机报障）
// ════════════════════════════════════════════════════════════════════════

describe('magicrewDisplayNickname：nickname → 脱敏手机号 → displayName', () => {
  it('★ 第一腿：有 `nickname` ⇒ 直接用它（哪怕同时有 11 位手机号）', () => {
    // ⚠️ 本用例的两个字段**同时**存在是刻意的：只给 nickname 的话，
    //    「昵称优先于手机号」这条判据删掉也照样绿（另一腿没有输入）。
    expect(magicrewDisplayNickname({
      jwt: 'j', organizationCode: '', nickname: 'Nick', phone: '13011112222',
    })).toBe('Nick')
  })

  it('★ 第二腿：没有 `nickname`、有 11 位手机号 ⇒ 脱敏号', () => {
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '', phone: '13011112222' }))
      .toBe('130****2222')
  })

  it('★ 第三腿：两样都没有 ⇒ 渠道名', () => {
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '' })).toBe('超级麦吉')
  })

  it('★ 昵称是**空白串**时不算昵称（回落手机号，不显示一片空白）', () => {
    expect(magicrewDisplayNickname({
      jwt: 'j', organizationCode: '', nickname: '   ', phone: '13011112222',
    })).toBe('130****2222')
  })

  it('★★ **向后兼容**：老凭据（没有 `nickname` 字段）的行为与改前**逐字节相同**', () => {
    // ⚠️⚠️ 这是本次改动最重要的一条：存量凭据全都长这样，改坏了就是所有老账号的
    //    卡片一起变样。三个格子逐条对齐改动前的实现
    //    （`phone` 11 位 → 脱敏；否则 → displayName）。
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '', phone: '13011112222' }))
      .toBe('130****2222')
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '' })).toBe('超级麦吉')
    // 非 11 位（含 10 位本地号、带国家码那种脏值）一律**不脱敏**，原样回落渠道名。
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '', phone: '1380013800' }))
      .toBe('超级麦吉')
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '', phone: '+8613011112222' }))
      .toBe('超级麦吉')
  })

  it('★ `nickname` 必须能穿过 `parseMagicrewCredential`（否则重启后卡片又变回渠道名）', () => {
    // ⚠️ 登录那一刻的展示名来自**返回值**，不经过 parse；只有「从凭据库读回来再展示」
    //    才经过它 ⇒ 漏掉 parse 里那一行，症状是「重启后又变回超级麦吉」，极难归因。
    expect(parseMagicrewCredential({
      jwt: 'j.w.t', organizationCode: 'org', nickname: 'Nick',
    })?.nickname).toBe('Nick')
    // 老凭据（没有该键）⇒ **不产生** `nickname` 键（不是空串）。
    expect(parseMagicrewCredential({ jwt: 'j.w.t', organizationCode: 'org' }))
      .not.toHaveProperty('nickname')
  })
})

// ════════════════════════════════════════════════════════════════════════
// ⑨ 卡片「有效期」的取数判据（2026-10-29 真机报障「有效期 未知」）
// ════════════════════════════════════════════════════════════════════════

describe('magicrewExpiresAtMs：apiKeyExpiresAt → JWT exp → 不写', () => {
  /** 与 `magicrew-local-browser.spec.ts` 同形的假 JWT（只关心 iat/exp）。 */
  function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${header}.${body}.fixture-signature`
  }

  it('★ 有 `apiKeyExpiresAt` ⇒ 用它（精确值优先于 JWT 的会话寿命）', () => {
    const jwt = makeJwt({ iat: 1_800_000_000, exp: 1_802_592_000 })
    expect(magicrewExpiresAtMs({ jwt, organizationCode: '', apiKeyExpiresAt: 1_800_007_200_000 }))
      .toBe(1_800_007_200_000)
  })

  it('★★ 没有 `apiKeyExpiresAt` ⇒ 用 JWT 的 `exp`（秒 ⇒ 毫秒）；这正是浏览器登录那条腿的形状', () => {
    // ⚠️ 真机凭据里**只有** `apiKey`/`jwt`/`organizationCode`/`refreshToken`
    //    （实测 `~/.dsh/.credentials.yaml`）⇒ 这一格就是用户那张卡片走的路。
    const jwt = makeJwt({ iat: 1_800_000_000, exp: 1_802_592_000 })
    expect(magicrewExpiresAtMs({ jwt, organizationCode: '' })).toBe(1_802_592_000_000)
  })

  it('⚠️ 两者都没有 / JWT 解不出来 ⇒ `undefined`（**不写**，卡片如实显示未知）', () => {
    expect(magicrewExpiresAtMs({ jwt: 'not-a-jwt', organizationCode: '' })).toBeUndefined()
    expect(magicrewExpiresAtMs({ jwt: '', organizationCode: '' })).toBeUndefined()
    // `exp` 缺失（合法 JWT，但没有 exp 字段）⇒ 0 ⇒ 同样不写。
    expect(magicrewExpiresAtMs({ jwt: makeJwt({ iat: 1_800_000_000 }), organizationCode: '' }))
      .toBeUndefined()
  })
})
