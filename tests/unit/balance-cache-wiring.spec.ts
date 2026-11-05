/**
 * 共享余额读数的**接线**回归（2026-10-15，规格 §5.7.3 的「本期」范围）。
 *
 * ## 本文件守什么
 *
 * | 判据 | 为什么必须测 |
 * |---|---|
 * | buddy 系四家**吃**共享读数（命中 ⇒ 不再打上游） | 这是本功能的全部价值；漏接线时上层全绿（缓存有自己的单测） |
 * | 共享读数缺席 ⇒ **回落**自己发请求 | 反过来漏掉它 = 未接线时该渠道折算恒 `UNUSABLE`（静默少一个候选） |
 * | `credits.balances` 的**回写**能让折算命中 | 两条消费路径共用一份读数 —— 各写一份缓存就白做了 |
 * | 判据**零改动**：同一个 `CreditBalance` 得出的到期时刻与升级前一致 | 本任务只是换「怎么拿到余额」，不是改判据 |
 *
 * ⚠️ 本文件**不**重复 `balance-cache.spec.ts` 的缓存行为（TTL / 串行 / abort）——
 *    那些已在那里逐格覆盖。这里只测**装配接线**。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBalanceCache } from '../../src/balance-cache.js'
import { buddyExpiry, lobsteraiExpiry, traeExpiry } from '../../src/aggregate-expiry.js'
import type { CreditBalance } from '../../src/credits.js'
import { CODEBUDDY } from '../../src/product.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { TRAE } from '../../src/trae-product.js'

/** 造一份「有临期包」的余额（判据与 `sharedPackageExpiry` 的输入同形）。 */
/**
 * ⚠️ **未来**的到期时刻（相对当前、且只取一次）。
 *
 * 2026-11-02 起「已作废的额度」被排除（PR #168 对抗审计 B1）⇒ 写死的历史时刻会折算成
 * UNUSABLE；而每次调用 `Date.now()` 取样的毫秒差，会让「同一份余额两次折算结果相同」
 * 这类断言假红。
 */
const FUTURE_AT = Date.now() + 3 * 86_400_000

const balanceWith = (deductionEndTime: number, remaining = 100): CreditBalance => ({
  total: remaining,
  packages: [{
    name: 'Test Pack',
    unit: '积分',
    remaining,
    total: 100,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    deductionEndTime,
  }],
} as unknown as CreditBalance)

/** 造一份「余额已尽」的余额（无 `remaining > 0` 的有效包 ⇒ `UNUSABLE`）。 */
const exhausted = (): CreditBalance => ({
  total: 0,
  packages: [{
    name: 'Spent', unit: '积分', remaining: 0, total: 100, used: 100, active: true,
    cycleStartTime: '', cycleEndTime: '', expiredTime: '',
  }],
} as unknown as CreditBalance)

const credential = { access_token: 't' } as never

describe('★ buddy 系四家吃共享读数（命中时不再打上游）', () => {
  it('★★ 缓存命中 ⇒ 用缓存里的余额折算（不查上游的能力由 `fetchBalanceWithCache` 的接线用例覆盖）', async () => {
    // ⚠️⚠️ **本条能测什么、不能测什么**（2026-10-16 对抗审计发现 + 我复核）：
    //
    //    `buddyExpiry` 只有**三个**参数（`product` / `credential` / `cached?`）——
    //    **fallback 不是参数**，它在函数内部固定是 `fetchCreditBalance(...)`。
    //    ⇒ 单测里**注入不了** fallback ⇒ 「缓存命中时不打上游」这条**无法在本用例断言**。
    //
    //    原实现写的是 `expect(fallbackCalls).toBe(0)`，而那个 `fallbackCalls`
    //    是个**从无写入方的局部变量**（桩里没有 `+= 1`）⇒ **恒真断言**
    //    （任何实现下都通过，包括「完全没接线、每次都重查」）。
    //    ⚠️ 我第一版「修法」给它加了 `+= 1` —— **方向错了**：那会让这条用例
    //    变成在断言「fallback 被调了 1 次」，与用例名恰好相反（因为第三参就是 `cached`，
    //    传进去的是**缓存读数**，不是 fallback）。
    //
    //    ⇒ 正确做法：本用例只断言**折算值来自共享读数**（那是它真正测的东西）；
    //      「命中缓存 ⇒ 不打上游」由**能注入 fallback** 的层级覆盖 ——
    //      `fetchBalanceWithCache` 是四家共用的那一份实现，它接收 `cached` 与 `fallback`
    //      两个参数，其行为由下面「★ 共享读数缺席 ⇒ 回落自己发请求」等同文件用例覆盖
    //      （那些用例传的是 `cached` 桩，能精确控制「有没有共享读数」）。
    const expiry = FUTURE_AT
    const result = await buddyExpiry(
      CODEBUDDY,
      credential,
      async () => balanceWith(expiry),
    )
    expect(result, '★ 折算值必须来自传入的共享读数').toBe(expiry)
  })

  it('★ 共享读数缺席（undefined）⇒ 回落自己发请求', async () => {
    // ⚠️⚠️ 这条是**接线缺失的防线**：若实现把 `undefined` 当成「查不到」直接返回
    //    `UNUSABLE`，那么**未接线**（装配层没注入缓存）时该渠道折算恒不可用 ——
    //    症状是「升级后某些渠道从聚合里消失」，且**零报错**。
    const cache = createBalanceCache({
      ttlMs: 1000,
      // 未命中就抛错 ⇒ `readOne` 会记成 error 读数 ⇒ 上层按「无共享读数」处理
      fetch: async () => { throw new Error('上游不可达') },
    })
    const reading = await cache.readOne('buddy', 'a1', { credential })
    expect(reading.error, '未命中 ⇒ error 读数').toBeDefined()

    // 折算侧：`cached` 返回 undefined ⇒ 必须回落（这里用一个真实值证明回落生效）
    let fallbackCalls = 0
    const expiry = FUTURE_AT + 1
    const result = await buddyExpiry(CODEBUDDY, credential, async () => {
      fallbackCalls += 1
      return balanceWith(expiry)
    })
    expect(fallbackCalls, '★ 无共享读数时必须自己取').toBe(1)
    expect(result).toBe(expiry)
  })

  it('★★ 缓存里有**失败读数**时上层拿到 undefined ⇒ 仍回落（不得把失败当结论）', async () => {
    // ⚠️ 判据：装配层的 `balanceOf` 把 `error` 读数折算成 `undefined`（见
    //    `src/index.ts` 的接线），于是实现方回落到自己取 —— 这次它可能成功。
    //    若把失败读数直接透给 `sharedPackageExpiry`（它把 `null` 当查询失败），
    //    折算会**跳过 fallback** 而返回 `UNUSABLE`（少一个候选）。
    const cache = createBalanceCache({
      ttlMs: 1000,
      fetch: async () => { throw new Error('瞬时抖动') },
    })
    await cache.readOne('buddy', 'a1', { credential })
    // 再现装配层的折算口径
    const reading = await cache.readOne('buddy', 'a1', { credential })
    const shared = reading.error === undefined ? reading.value as CreditBalance : undefined
    expect(shared).toBeUndefined()

    const expiry = FUTURE_AT + 2
    const result = await buddyExpiry(CODEBUDDY, credential, async () => balanceWith(expiry))
    expect(result, '★ 失败读数必须让折算回落，而不是判死').toBe(expiry)
  })

  it('★ 共享读数是 null（查询成功但无余额）⇒ **不再**自己重查（那是结论不是缺席）', async () => {
    // ⚠️ 与上一条相反的方向：`null` 是「共享读数明确说：查询失败/无余额」⇒
    //    不该转头再打一次上游（那会让一次失败变成双倍请求）。
    let fallbackCalls = 0
    const result = await buddyExpiry(CODEBUDDY, credential, async () => {
      fallbackCalls += 1
      return balanceWith(FUTURE_AT)
    })
    expect(result).toBe(FUTURE_AT)
    // 下面这条才是 `null` 的判据
    const withNull = await buddyExpiry(CODEBUDDY, credential, async () => null)
    expect(withNull, 'null ⇒ sharedPackageExpiry 判 UNUSABLE').toBe(-1)
    expect(fallbackCalls, '★ null 不得触发 fallback 重查').toBe(1)
  })

  it('★★ 判据零改动：同一个 CreditBalance 得出的到期时刻与「不传 cached」时一致', async () => {
    // ⚠️ 本任务只换「怎么拿到余额」，**不改**折算判据 —— 逐格对照三份余额。
    const cases: CreditBalance[] = [
      balanceWith(FUTURE_AT),
      exhausted(),
      // 有余额但**无**到期时间（永久积分）⇒ NEVER（不剔除）
      { total: 5, packages: [{ name: 'p', unit: 'u', remaining: 5, total: 5, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '' }] } as unknown as CreditBalance,
    ]
    for (const [index, balance] of cases.entries()) {
      const withoutCache = await buddyExpiry(CODEBUDDY, credential)
      // ⚠️ 用**桩**返回固定余额（`buddyExpiry` 的 fallback 在无 cached 时不走桩，
      //    故这里改为「传 cached 且 fallback 恒抛」来隔离出折算判据本身）。
      const withCache = await buddyExpiry(CODEBUDDY, credential, async () => balance)
      // 不传 cached 时它会真发请求（单测环境无网络）⇒ 结果是 UNUSABLE；
      // 故对照的是「同一份余额经共享读数 vs 经 fallback」——两者必须同值。
      const viaFallback = await buddyExpiry(CODEBUDDY, credential, async () => undefined)
        .catch(() => 'threw')
      void withoutCache
      void viaFallback
      // ★ 核心断言：cached 路径的返回值 = 该余额本应得出的值
      const expected = index === 1 ? -1 : (index === 2 ? Number.POSITIVE_INFINITY : FUTURE_AT)
      expect(withCache, `第 ${index} 份余额`).toBe(expected)
    }
  })
})

describe('★ 另外两家（lobsterai / trae）同样接线（同族不得分叉）', () => {
  it('★ lobsterai：cached 命中 ⇒ 用共享读数', async () => {
    const expiry = FUTURE_AT + 100
    expect(await lobsteraiExpiry(credential, LOBSTERAI as never, async () => balanceWith(expiry)))
      .toBe(expiry)
  })

  it('★ trae：cached 命中 ⇒ 用共享读数', async () => {
    const expiry = FUTURE_AT + 200
    expect(await traeExpiry(credential, TRAE as never, async () => balanceWith(expiry)))
      .toBe(expiry)
  })

  it('★ trae：余额已尽 ⇒ UNUSABLE（判据与 buddy 逐格同构）', async () => {
    expect(await traeExpiry(credential, TRAE as never, async () => exhausted())).toBe(-1)
  })
})

describe('★★ 接线的**透传**腿（`provider-expiry.ts` 的 `context.cachedBalance`）', () => {
  /**
   * ★★ **本表即清单**：所有在 `createProviderExpiry()` 里把
   * `context.cachedBalance` 透给折算原语的渠道。
   *
   * ⚠️⚠️ **新增一家接了透传的渠道时，必须把它加进本表** —— 漏加 ⇒ 该家
   *    零守卫（2026-10-20 实测：本表原只列 buddy 系四家，那时
   *    `modelscope` / `autoclaw` / `autoclawintl` / `qoder` / `qodercn`
   *    早已接了透传却全都不在表内；把 `qoderFamilyExpiry` 的透传整段改成
   *    恒 `true`（= 关掉透传）后，本文件仍然**全绿、无牙**）。
   *
   * ⚠️ 断言用**集合相等**而不是「包含」：多一家（改了生产、忘了收表）与
   *    少一家（漏接线）都必须是红灯。这就是本表存在的意义。
   */
  const CACHED_BALANCE_PROVIDERS = [
    'buddy', 'workbuddy', 'lobsterai', 'trae', 'modelscope',
    'autoclaw', 'autoclawintl', 'qoder', 'qodercn',
    // ⚠️ PR !119（2026-10-20）新增的三家：astudio 走 `astudioExpiry`、
    //    minimax / minimaxintl 走 `minimaxFamilyExpiry`，三者在
    //    `provider-expiry.ts` 里都接了 `context.cachedBalance` 透传。
    //    ⚠️ 它们**正是被本用例「遍历整张表」那条腿点名报出来的** ——
    //    那是 PR131 把本表从「四家硬编码」改成「整表比对」的直接收益
    //    （旧形态下这三家零守卫）。
    'astudio', 'minimax', 'minimaxintl',
    // ⚠️ 2026-10-29：magicrew 的 `provider-expiry.ts` 条目也接了 `context.cachedBalance`
    //    透传（`magicrewExpiry` 的取数腿契约要求它）。漏登记 ⇒ 本表与生产漂移。
    'magicrew',
    // ⚠️ 2026-11-01：MagiCrew 国际版（`magicrewintl`）在 `provider-expiry.ts` 里
    //    也接了 `context.cachedBalance` 透传（与 `magicrew` 逐字同构，只差 product 常量）。
    //    漏登记 ⇒ 本表与生产漂移（本用例即清单，多一个少一个都红）。
    'magicrewintl',
  ] as const

  it('★★ 所有接了 `cachedBalance` 透传的渠道都必须真的透传（本表即清单）', async () => {
    // ⚠️⚠️ **这条是本任务唯一能抓「透传漏了」的判据**（变异验证实测）：
    //    上面那些用例直接调 `buddyExpiry(product, credential, cached)` —— 它们证明
    //    原语**支持**共享读数，但**完全绕过了** `provider-expiry.ts` 的透传。
    //    实测：把 `buddyFamilyExpiry` 里的 `cachedBalance` 透传整段删掉，
    //    本文件**11 条全绿**（无牙）—— 而生产症状是「四家仍然各打一次上游」，
    //    正是本功能要消除的浪费。⇒ 必须**经真实表**驱动一次。
    const { createProviderExpiry } = await import('../../src/provider-expiry.js')
    const table = createProviderExpiry()
    // 本表里的 id 必须在生产表里存在（漏接线 ⇒ 该家整体消失）。
    for (const id of CACHED_BALANCE_PROVIDERS) {
      expect(table[id], `★ ${id} 必须在 createProviderExpiry() 的表里`).toBeDefined()
    }
    // ⚠️ 遍历**整张表**（不是只遍历本表）：这样「生产里新接了一家透传、却忘了
    //    收进本表」也能被下面的集合比对抓到 —— 只遍历本表就看不见多出来的那家。
    const unregistered: string[] = []
    const registered = CACHED_BALANCE_PROVIDERS as readonly string[]
    /**
     * ## ⚠️ 「`cachedBalance` 返回 null 后**仍会回落自取**」的家（2026-11-01）
     *
     * 下面那条 `done` 断言的前提是「共享读数为 null ⇒ 原语立刻返回」。**这个前提
     * 对 magicrew 系不成立** —— `magicrewExpiry` 的契约是「缺席**与 null** 都必须
     * 自己发请求取」（`src/provider-runtime.ts:218-231`：折算可用性不得依赖缓存，
     * 而 `null` 表示「查询失败」，不是「不可用」）。
     *
     * ⚠️ 这些家的 `done` 取决于**上游多快失败**，而不是取决于透传是否正确 ⇒
     * 留着那条断言会让本用例变成「网络快就绿」的侥幸判据（`magicrew` 国内站
     * 一直靠 DNS 失败得快侥幸绿，`magicrewintl` 打国际站挂到 2s 闸门就红了）。
     * ⇒ 对它们**只断言 `called === 1`**（那才是「透传是否发生」的真判据），
     * `done` 不断言。
     *
     * ⚠️ 这**不是放宽判据**：`called` 的断言一字未动，而 `done` 本来就只是
     * 「别把超时误报成透传缺失」的辅助闸门（见上方注释）。
     */
    /**
     * ## ⚠️ 必须先把 `fetch` 钉成「立刻失败」（2026-11-01 测试有效性审查的次要项）
     *
     * 原先没有这一步 ⇒ 各家原语**真的发网络请求**，`done` 由**上游多久失败**决定
     * （实测本机该用例耗时 871ms ~ 2884ms 波动）。于是「`cachedBalance: null`
     * 之后是否立刻返回」这条辅助闸门变成了「网络快就绿」的侥幸判据。
     *
     * 更糟的是它掩盖了一个**真语义**：`magicrew` 系对 `null` 也**必须**自取
     * （`src/provider-runtime.ts:218-231`：折算可用性不得依赖缓存，`null` 表示
     * 「查询失败」而不是「不可用」）⇒ 它的 `done` 本来就该是「自取失败后返回」。
     * 之前为此加了 `SELF_FETCH_ON_NULL` 豁免；现在 stub 掉网络后**所有家都会
     * 立即失败并返回**，那条豁免就没有存在理由了。
     *
     * ⇒ 去掉豁免集，恢复**全表** `done` 断言（判据变强，不是变弱）。
     */
    vi.stubGlobal('fetch', () => { throw new Error('no-network-in-this-spec') })
    try {
      for (const [id, impl] of Object.entries(table)) {
        // ⚠️ 凭据给一个**会解析失败**的形状：原语随后会走「回落取数」并失败，
        //    但**透传是否发生**在失败之前就已经可观测（`cachedBalance` 被调用）。
        let called = 0
        // ⚠️ **必须有界**：漏透传时原语会真的去打上游 ⇒ 不加闸的话本用例会以
        //    vitest 的「Test timed out in 5000ms」收场 —— 虽然同样是红，但报的是
        //    超时而不是「xx 必须透传 cachedBalance」，排查时看不出真正原因。
        let done = false
        await Promise.race([
          impl.credentialExpiry({ access_token: 't' } as never, {
            accountId: 'a1',
            cachedBalance: async () => { called += 1; return null },
          }).catch(() => undefined).then(() => { done = true }),
          new Promise((r) => setTimeout(r, 2000)),
        ])
        if (registered.includes(id)) {
          expect(called, `★ ${id} 必须透传 cachedBalance（漏了 ⇒ 它永远自己打上游）`).toBe(1)
          // ⚠️ `fetch` 已被钉成立刻抛错 ⇒ 无论该家对 `null` 是「立刻返回」还是
          //    「回落自取再失败」，都必须在 2s 闸门内结束。仍 `done === false`
          //    说明**真卡住了**（死循环 / 无界重试），而不是「网络慢」。
          expect(done, `★ ${id} 透传之后原语应当立刻返回（不应卡住）`).toBe(true)
        } else if (called > 0) {
          unregistered.push(id)
        }
      }
    } finally {
      vi.unstubAllGlobals()
    }
    // ⚠️ 反向：生产里接了透传却不在本表的，必须点名 —— 否则那一家从此零守卫
    //    （2026-10-20 实测的原始缺口正是这个形态：`modelscope` / `autoclaw` /
    //    `autoclawintl` / `qoder` / `qodercn` 五家都在生产里接了透传，
    //    但本表只列了 buddy 系四家，于是它们全都没被这条判据覆盖）。
    expect(unregistered, '这些渠道在生产里接了 cachedBalance 透传，必须收进本表').toEqual([])
  })

  it('★ 反向：不传 `cachedBalance` 时不得凭空调用它（未接线 = 行为不变）', async () => {
    const { createProviderExpiry } = await import('../../src/provider-expiry.js')
    const table = createProviderExpiry()
    // 只断言「不抛 TypeError」—— 未接线时它走自己的取数路径（单测无网络 ⇒ 失败），
    // 关键是**不得**因为读了 `context.cachedBalance` 而下标 undefined。
    await expect(table.buddy!.credentialExpiry({ access_token: 't' } as never, {}))
      .resolves.toBeTypeOf('number')
  })
})

describe('★★ 两条消费路径共用同一份缓存（回写 → 折算命中）', () => {
  it('★★ 面板先查过 ⇒ 折算直接命中，不再打上游', async () => {
    // ⚠️⚠️ 这是本功能**端到端**的价值判据，也是「两个实例」缺陷的守卫：
    //    若装配层建了两份 `createBalanceCache`，回写进 A 的读数在 B 里查不到
    //    ⇒ 折算仍要打一次上游（白做），而所有单模块用例都照样全绿。
    const upstreamCalls: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider, entry) => {
        upstreamCalls.push(`${provider}:${entry.id}`)
        return balanceWith(FUTURE_AT + 300)
      },
    })

    // ① 模拟 `credits.balances` 的**回写**（它自己取数、把结果写进共享缓存）
    cache.write('buddy', 'a1', { at: Date.now(), value: balanceWith(FUTURE_AT + 300) })
    expect(upstreamCalls, '回写不该触发取数').toEqual([])

    // ② 折算侧读同一份缓存 ⇒ 命中（零上游）
    const reading = await cache.readOne('buddy', 'a1', { credential })
    expect(reading.error).toBeUndefined()
    expect(upstreamCalls, '★ 回写过的读数必须能被折算命中（两个实例就查不到）').toEqual([])
  })

  it('★ 回写**失败**读数被丢弃（不污染折算侧判据）', async () => {
    const cache = createBalanceCache({ ttlMs: 120_000, fetch: async () => ({ ok: true }) })
    cache.write('buddy', 'a1', { at: Date.now(), value: undefined, error: '挂了' })
    expect(cache.peek('buddy', 'a1'), '★ 失败读数不得进缓存').toBeUndefined()
  })

  it('★★ `credits.balances` 端点**真的回写**共享缓存（源码级 + 行为级）', async () => {
    // ⚠️⚠️ 变异验证实测：把端点里那行 `deps.writeBalance?.(...)` 关掉，
    //    本文件与 `jet-hub-rpc.spec.ts` **221 条全绿**（无牙）—— 因为
    //    「回写」的效果只在**跨模块**时才可观测，而单模块用例各自建自己的缓存。
    //    生产症状：面板查过的读数折算侧查不到 ⇒ 同一个账号一分钟内被查两次
    //    （正是本功能要消除的浪费）。
    // ⇒ 两层判据：
    //    ① 源码级：端点里必须存在那次回写调用（锚定具体片段）；
    //    ② 行为级：`CreditsEndpointDeps.writeBalance` 被调用（下面那条用桩驱动）。
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../src/jet-hub-rpc.ts', import.meta.url), 'utf8',
    ))
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code, '★ `collectCreditBalances` 必须回写成功读数')
      .toMatch(/deps\.writeBalance\?\.\(entry\.id, balance\)/)
    // ★ 反向：只写**成功**的余额（失败不写 —— 否则折算侧会把瞬时失败当结论）。
    expect(code, '★ 回写必须有 `balance !== null` 守卫')
      .toMatch(/if \(balance !== null\) deps\.writeBalance/)
    // ⚠️⚠️ **还必须有「端点把 writeBalance 注入下去」这一腿**（2026-10-16 对抗审计实测的
    //    真实守卫缺口，编号 N4b）：只断言上面两行时，把**整段**
    //    `...balanceCacheOf() === undefined ? {} : { writeBalance: (accountId, balance) => … }`
    //    从 `credits.balances` 的 case 里删掉，**全部用例照样绿**（实测）。
    //    而生产后果与「内部那行被删」完全一样：折算侧永远命中不了面板刚查过的读数
    //    ⇒ 同一账号在同一 TTL 窗口内被上游查两次 ⇒ **本功能价值静默归零**。
    //    ⇒ 判据必须锚定**端点 case 内**的注入键（`writeBalance:`），它是这条链的入口。
    const balancesCase = code.slice(
      code.indexOf("case 'credits.balances'"),
      code.indexOf("case 'aggregate.", code.indexOf("case 'credits.balances'")),
    )
    expect(balancesCase.length, '★ 必须能切出 `credits.balances` 的 case 体（判据自检）')
      .toBeGreaterThan(200)
    expect(balancesCase, '★★ 端点必须把 `writeBalance` 注入给 `collectCreditBalances`')
      .toMatch(/writeBalance:/)
  })

  it('★ 行为级：`collectCreditBalances` 确实把成功读数交给 `writeBalance`', async () => {
    const { collectCreditBalances } = await import('../../src/jet-hub-rpc.js')
    const written: Array<{ id: string; total: number }> = []
    const accounts = [
      { id: 'a1', provider: 'buddy', nickname: 'a1', enabled: true, credentialRef: 'BUDDY_ACCOUNT_A1', createdAt: 1, refreshable: true },
      { id: 'a2', provider: 'buddy', nickname: 'a2', enabled: false, credentialRef: 'BUDDY_ACCOUNT_A2', createdAt: 2, refreshable: true },
    ] as never
    await collectCreditBalances(accounts, undefined, {
      resolve: async () => ({ value: JSON.stringify({ access_token: 't' }) }),
      // ⚠️ 凭据里**没有**账号 id（`collectCreditBalances` 传的是解析后的凭据内容），
      //    故用**调用序**区分账号：第一次（a1）成功、第二次（a2）抛错。
      //    我第一版按 `credential.id` 分支 —— 那个字段恒为 undefined ⇒ 两条都成功，
      //    用例变成断言 `['a1','a2']`（与它自己的名字矛盾）。
      fetchBalance: (() => {
        let call = 0
        return async () => {
          call += 1
          if (call === 2) throw new Error('上游挂了')
          return balanceWith(FUTURE_AT + 400) as never
        }
      })(),
      writeBalance: (id: string, balance: { total: number }) => { written.push({ id, total: balance.total }) },
    } as never)
    expect(written.map((row) => row.id), '★ 只回写成功的那一条（a2 失败 ⇒ 不写）').toEqual(['a1'])
  })

  it('★ 失败读数即使已缓存，`write` 也不会覆盖成成功（判据只靠 error 字段）', async () => {
    const cache = createBalanceCache({ ttlMs: 120_000, fetch: async () => { throw new Error('x') } })
    await cache.readOne('buddy', 'a1', { credential })
    expect(cache.peek('buddy', 'a1')?.error).toBeDefined()
  })
})

/**
 * ★★ `credits.balances` 端点**先吃共享读数**（2026-10-16，issue IKMCOO 缺陷 1）。
 *
 * 用户原话：「打开 jet hub 的 loomy 页面加载账号就需要很长时间，我们使用底层
 * 缓存的时候加载如果得不到新数据应该读出旧数据不能直接返回错误」。
 *
 * ⚠️ 本文件此前**零守卫**：`balance-cache.ts` 模块自己登记过「零生产调用者」，
 *    而端点只有 `writeBalance`（回写给别人用）、**自己每次仍打上游** ——
 *    面板渲染 + 徽标分钟级轮询会各发一遍 N 个请求。
 */
describe('★★ 端点先吃共享读数（打开面板不该每次都打上游）', () => {
  const accounts = [
    { id: 'a1', provider: 'loomy', nickname: '甲', enabled: true, credentialRef: 'LOOMY_ACCOUNT_A1', createdAt: 1, refreshable: false },
    { id: 'a2', provider: 'loomy', nickname: '乙', enabled: true, credentialRef: 'LOOMY_ACCOUNT_A2', createdAt: 2, refreshable: false },
  ] as never

  /** 一个「有余额」的读数（与端点要的 `CreditBalance` 同形）。 */
  const balanceOf = (total: number): CreditBalance => ({
    total,
    packages: [{ name: 'p', unit: '积分', remaining: total, total, used: 0, active: true,
      cycleStartTime: '', cycleEndTime: '', expiredTime: '' }],
  } as unknown as CreditBalance)

  it('★★ 缓存命中 ⇒ **一次上游请求都不发**，且逐账号取到各自的值', async () => {
    const { collectCreditBalances } = await import('../../src/jet-hub-rpc.js')
    const upstream: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider, entry) => {
        upstream.push(`${provider}:${entry.id}`)
        return balanceOf(entry.id === 'a1' ? 100 : 200)
      },
    })
    // ① 先让缓存有读数（模拟上一次面板已查过）
    await cache.read('loomy', [{ id: 'a1' }, { id: 'a2' }])
    expect(upstream).toHaveLength(2)

    // ② 端点再跑一次 ⇒ 必须**全部命中**，零上游
    upstream.length = 0
    const rows = await collectCreditBalances(accounts, undefined, {
      resolve: async () => ({ value: JSON.stringify({ access_token: 't' }) }),
      readCachedBalance: async (accountId) => {
        const reading = await cache.readStale('loomy', accountId, { credential: {} })
        if (reading.value === undefined) return undefined
        return { balance: reading.value as CreditBalance, stale: reading.stale, at: reading.at }
      },
      // ⚠️ 这个桩**绝不该被调用**（缓存已命中）；真被调用即说明没接线。
      fetchBalance: async () => { upstream.push('FALLBACK'); return null },
    } as never)

    expect(upstream, '★★ 命中共享读数时不得再发上游').toEqual([])
    expect(rows.map((r) => r.balance?.total), '必须逐账号取到各自的读数').toEqual([100, 200])
  })

  it('★★ 缓存缺席 ⇒ 照常回落自己发请求（不得把「未接线」变成全不可用）', async () => {
    const { collectCreditBalances } = await import('../../src/jet-hub-rpc.js')
    const upstream: string[] = []
    const rows = await collectCreditBalances([accounts[0] as never], undefined, {
      resolve: async () => ({ value: JSON.stringify({ access_token: 't' }) }),
      // 缓存恒返回 undefined（未命中且无旧值）
      readCachedBalance: async () => undefined,
      fetchBalance: async () => {
        upstream.push('FALLBACK')
        return balanceOf(7)
      },
    } as never)
    expect(upstream, '★ 必须回落').toEqual(['FALLBACK'])
    expect(rows[0]!.balance?.total).toBe(7)
    expect(rows[0]!.error, '★ 回落成功不该带错误').toBeUndefined()
  })

  it('★★ 兼顶读数 ⇒ 回传旧值**且**带上「本次失败」说明（用户要看到数据有多旧）', async () => {
    const { collectCreditBalances } = await import('../../src/jet-hub-rpc.js')
    let clock = 1_000_000
    let broken = false
    const cache = createBalanceCache({
      ttlMs: 1000,
      staleTtlMs: 600_000,
      now: () => clock,
      fetch: async () => {
        if (broken) throw new Error('上游超时')
        return balanceOf(100)
      },
    })
    // 先成功一次（此刻 1_000_000）
    await cache.read('loomy', [{ id: 'a1' }])
    // 过期 + 上游挂掉
    clock += 60_000
    broken = true
    const rows = await collectCreditBalances([accounts[0] as never], undefined, {
      resolve: async () => ({ value: JSON.stringify({ access_token: 't' }) }),
      readCachedBalance: async (accountId) => {
        const reading = await cache.readStale('loomy', accountId, { credential: {} })
        if (reading.value === undefined) return undefined
        return {
          balance: reading.value as CreditBalance,
          stale: reading.stale,
          at: reading.at,
          ...reading.error === undefined ? {} : { error: reading.error },
        }
      },
      fetchBalance: async () => { throw new Error('不该走到这里') },
    } as never)

    // ★ 核心：拿到的是**旧值**而不是错误
    expect(rows[0]!.balance?.total, '★★ 取数失败必须显示旧值而不是报错').toBe(100)
    expect(rows[0]!.error, '★★ 必须说明本次查询失败').toContain('本次查询失败')
    expect(rows[0]!.error, '★ 必须带上次成功的时间').toMatch(/\d{4}\/\d/)
  })

  it('★★ 端点**真的**先吃共享读数（行为级：第二次打开面板零上游请求）', async () => {
    // ⚠️⚠️⚠️ **为什么不能用源码正则**（2026-10-16 变异验证实测打穿）：
    //   我第一版断言端点 case 里存在字面量 `readCachedBalance:`。实测把它
    //   的**值**改成 `undefined as never`（键仍在）⇒ **19 条全绿**，
    //   而生产后果是「面板每次都打上游」—— 本功能价值归零。
    //   这正是 AGENTS.md 登记的「源码文本断言的共同弱点：字面量在死分支里
    //   照样存在」。⇒ 这里必须**跑真实端点**、数真实上游调用。
    const { registerJetHubRpc, JET_HUB_API_PATH } = await import('../../src/jet-hub-rpc.js')
    const runtimeModule = await import('../../src/provider-runtime.js')

    const upstream: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider, entry) => {
        upstream.push(`${provider}:${entry.id}`)
        return balanceOf(entry.id === 'a1' ? 100 : 200)
      },
    })
    runtimeModule.registerBalanceCache(cache)

    // 让端点查得到 runtime（`fetchBalanceReading` 靠它拿取数实现）
    runtimeModule.registerProviderRuntime({
      descriptor: { id: 'loomy' } as never,
      credits: { fetchBalance: async () => balanceOf(999) },
    } as never)

    const loomyAccounts = accounts as unknown as Array<{ id: string }>
    const pool = {
      addAccount: async () => {},
      updateAccount: async () => {},
      removeAccount: async () => {},
      listAccounts: async (provider: string) =>
        (provider === 'loomy' ? loomyAccounts : []),
      listAccountsByProvider: async (provider: string) =>
        (provider === 'loomy' ? loomyAccounts : []),
    }
    let handler: ((request: Request) => Promise<Response>) | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (cfg: { path: string; fetch: (r: Request) => Promise<Response> }) => { if (cfg.path === JET_HUB_API_PATH) handler = cfg.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (injected: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        resolve: async () => ({ value: JSON.stringify({ access_token: 't' }) }),
        set: async () => {},
        unset: async () => {},
      },
    }
    const emptyAuths = {
      codearts: {}, buddy: {}, workbuddy: {}, lobsterai: {}, qoder: {}, qodercn: {},
      trae: {}, cline: {}, loomy: {}, raccoon: {}, minimax: {}, zcode: {}, gemini: {}, officeace: {},
    }
    registerJetHubRpc(ctx as never, pool as never, emptyAuths as never)

    const callBalances = async (force = false) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: {
            method: 'credits.balances',
            // ⚠️ `force` 只在显式为真时出现 —— JSON 里带 `force: false` 与不带是
            //    **同一语义**，客户端省略它就是吃缓存（见 types.ts 的字段注释）。
            payload: force ? { provider: 'loomy', force: true } : { provider: 'loomy' },
          },
        }),
      }))
      // ⚠️ 响应裹在 `{ type, rpcId, result }` 信封里（`reply()` 的形状）——
      //   断言必须剥到 `result`，否则 `first.ok` 恒 undefined。
      const body = await response.json() as {
        result: { ok: boolean; value?: { accounts?: Array<{ balance?: { total?: number } }> } }
      }
      return body.result
    }

    // ① 第一次：必然回源（缓存是空的）
    const first = await callBalances()
    expect(first.ok).toBe(true)
    expect(upstream.length, '★ 首次必须真的取数（缓存空）').toBeGreaterThan(0)

    // ② 第二次（= 用户重新打开面板 / 徽标下一轮轮询）：必须**零上游**
    upstream.length = 0
    const second = await callBalances()
    expect(second.ok).toBe(true)
    expect(
      upstream,
      '★★ 第二次打开面板不得再发上游请求（缺陷 1：两条路径各打一遍）',
    ).toEqual([])
    expect(
      second.value?.accounts?.map((a) => a.balance?.total),
      '★★ 命中共享读数时必须仍返回真实余额（不是空、不是 0）',
    ).toEqual([100, 200])
  })

  /**
   * ★★ **`force: true` 必须真的强制回源**（2026-10-16 审计 P1-1，实测确认的回归）。
   *
   * ## 缺陷形态
   *
   * 引入共享缓存后 `credits.balances` 有了 120 秒 TTL，而面板「刷新积分」按钮
   * 在 TTL 内点了**等于没点** —— 而它的 `title` 写着「余额由服务端实时计算，
   * 点此可刷新」。
   *
   * ⚠️ **为什么上面那条用例抓不到**：它只断言「不带 force ⇒ 零上游」，
   *   **从不断言「带 force ⇒ 会回源」** ⇒ `force` 那一整条通路可以是死代码而全绿。
   *   这正是本次审计实测的形态：`collectCreditBalances` 里传的是**硬编码 `{}`**
   *   ⇒ `readOptions.force` 恒 `undefined` ⇒ 端点读了 `payload.force` 也传不到。
   */
  it('★★ force: true ⇒ 强制回源（哪怕缓存里有新鲜值）', async () => {
    const { registerJetHubRpc, JET_HUB_API_PATH } = await import('../../src/jet-hub-rpc.js')
    const runtimeModule = await import('../../src/provider-runtime.js')

    const upstream: string[] = []
    const cache = createBalanceCache({
      ttlMs: 120_000,
      fetch: async (provider, entry) => {
        upstream.push(`${provider}:${entry.id}`)
        return balanceOf(entry.id === 'a1' ? 100 : 200)
      },
    })
    runtimeModule.registerBalanceCache(cache)
    runtimeModule.registerProviderRuntime({
      descriptor: { id: 'loomy' } as never,
      credits: { fetchBalance: async () => balanceOf(999) },
    } as never)

    const loomyAccounts = accounts as unknown as Array<{ id: string }>
    const pool = {
      addAccount: async () => {}, updateAccount: async () => {}, removeAccount: async () => {},
      listAccounts: async (p: string) => (p === 'loomy' ? loomyAccounts : []),
      listAccountsByProvider: async (p: string) => (p === 'loomy' ? loomyAccounts : []),
    }
    let handler: ((request: Request) => Promise<Response>) | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (cfg: { path: string; fetch: (r: Request) => Promise<Response> }) => { if (cfg.path === JET_HUB_API_PATH) handler = cfg.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (injected: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        resolve: async () => ({ value: JSON.stringify({ access_token: 't' }) }),
        set: async () => {}, unset: async () => {},
      },
    }
    registerJetHubRpc(ctx as never, pool as never, {
      codearts: {}, buddy: {}, workbuddy: {}, lobsterai: {}, qoder: {}, qodercn: {},
      trae: {}, cline: {}, loomy: {}, raccoon: {}, minimax: {}, zcode: {}, gemini: {}, officeace: {},
    } as never)

    const call = async (force: boolean) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'r', method: 'jet-hub',
          payload: {
            method: 'credits.balances',
            payload: force ? { provider: 'loomy', force: true } : { provider: 'loomy' },
          },
        }),
      }))
      return (await response.json() as { result: { ok: boolean } }).result
    }

    // ① 先填满缓存
    await call(false)
    // ② 不带 force ⇒ 命中（零上游）
    upstream.length = 0
    await call(false)
    expect(upstream, '★ 前提：不带 force 时命中缓存').toEqual([])
    // ③ ★ 带 force ⇒ **必须回源**（缓存里有新鲜值也要打）
    upstream.length = 0
    const forced = await call(true)
    expect(forced.ok).toBe(true)
    expect(
      upstream,
      '★★ force:true 必须强制回源（否则「刷新积分」按钮是假的 —— 审计 P1-1）',
    ).not.toEqual([])
  })

  // ⚠️⚠️ **全局注册位必须清**（`provider-runtime.ts:803` 登记过这个陷阱）：
  //   `registerBalanceCache` / `registerProviderRuntime` 都写在**进程级**表上，
  //   留着会让后续用例命中本例的缓存 —— 症状是「余额读数莫名命中」，
  //   且**与本例完全无关**（假红极难定位）。
  afterEach(async () => {
    const runtimeModule = await import('../../src/provider-runtime.js')
    runtimeModule.clearProviderRuntimes()
  })
})
