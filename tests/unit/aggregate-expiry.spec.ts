/**
 * `src/aggregate-expiry.ts` 的缺陷回归：**未接入的渠道必须返回 `UNUSABLE`**。
 *
 * ## 为什么要单独守这个
 *
 * `createExpiryProbe` 是聚合层与 auto 层共用的**唯一**临期折算口径（Task 7 把
 * `auto-adapter.ts` 里那四个 `*Expiry` 方法搬了过来，两处不再各写一份）。
 *
 * 它有一个**静默**的失效形态：把「我们对其余额一无所知」的渠道折算成 `NEVER`。
 * `NEVER` 的语义是「可用、只是无临期额度」—— 它**参与排序且可当选**，于是请求
 * 会被发到一个可能早就没额度的渠道。不报错、不崩溃，只是把「没做到」说成
 * 「做到了」（AGENTS.md 首条判据记的正是这类静默失效）。
 *
 * ## 三条约定
 *
 * 1. **未接入的 provider ⇒ `UNUSABLE`**（剔除），绝不 `NEVER`（当选）；
 * 2. **无可用账号 ⇒ `UNUSABLE`**（取不到代表账号即「本次不可用」）；
 * 3. **abort ⇒ 抛 `AbortError`**，绝不折算成 `UNUSABLE` —— 用户取消请求时看到
 *    「请先登录」是误导（PR !69 审计实测过的真实缺陷）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXPIRY_PROBE_BUDGET_MS,
  EXPIRY_PROBE_MIN_SLICE_MS,
  WIRED_EXPIRY_PROVIDERS,
  codeArtsExpiry,
  createExpiryProbe,
  lobsteraiExpiry,
  expiryProbeSliceMs,
  normalizeExpiryProbeBudget,
  traeExpiry,
} from '../../src/aggregate-expiry.js'
import { NEVER, UNUSABLE } from '../../src/aggregate-core.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { TRAE } from '../../src/trae-product.js'
import { createProviderExpiry } from '../../src/provider-expiry.js'
import { clearProviderRuntimes, registerProviderRuntime } from '../../src/provider-runtime.js'
import { descriptorOf } from '../../src/provider-registry.js'

/**
 * 造一个 pool：`listAvailableCredentials` 返回**给定数量**的凭据。
 *
 * ⚠️⚠️ 本函数收的是**账号数**，而本文件各 describe 内部另有几个 `poolWith(...)` 收的是
 * **凭据数组**（它们是各 describe 的局部 const）。两者**不要混用**：
 * 2026-10-22 审计实测，把数字传给收数组的那版会让 `7.map` 抛 `TypeError`，
 * 被外层 `catch` 吞成 `UNUSABLE` ⇒ **0 次 fetch、0 ms** ⇒ 预算用例**假绿**
 *（断言「是 UNUSABLE」与「耗时 < 预算」全部满足，而预算代码一行没跑）。
 * ⇒ 本函数刻意独立命名，不复用 `poolWith`。
 */
function poolOfAccounts(count: number): never {
  return {
    disabledModelsFor: () => new Set<string>(),
    listAvailableCredentials: async () => Array.from({ length: count }, (_, index) => ({
      entry: { id: `acc-${index}` },
      credential: { access_token: `t${index}`, expires_at: '' },
    })),
    // ⚠️ 同时提供旧的单账号方法（回退路径用）—— 但本组断言**走的是新方法**。
    getAvailableAccount: async () => {
      throw new Error('不应走单账号回退路径')
    },
  } as never
}

/**
 * 让 `fetch` **永远挂起**（只在收到 abort 时 reject）。
 *
 * ⚠️ 初版的三条预算用例调了一个**全仓不存在**的 `stubFetchHangs()` ⇒
 * 全部 `ReferenceError` ⇒ **从未运行过**。桩必须真的定义在某处。
 */
function stubHangingFetch(): void {
  vi.stubGlobal('fetch', ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })) as unknown as typeof fetch)
}

/**
 * `lobsterai` 的**真实**报文形状（`parseLobsteraiEnvelope` → `data.creditItems[]`）。
 *
 * ⚠️⚠️ **不要**改成 `data.Response.Data.Accounts[]` —— 那是 `credits.ts` 的 buddy 形状
 * （本文件里几个 `it.skip` 的旧用例抄的就是它）。实测：用错形状时
 * `lobsteraiExpiry` 解析不到任何包 ⇒ 恒 `UNUSABLE` ⇒ 断言 `toBe(expiry)` 必红，
 * 且**红因是桩形状而不是被测逻辑**（2026-10-22 审计实测）。
 */
function lobsteraiCreditsResponse(expiryMs: number): Response {
  return new Response(JSON.stringify({
    code: 0,
    msg: 'ok',
    data: {
      creditItems: [{
        type: 'campaign',
        label: '每日登录奖励',
        creditsRemaining: 100,
        expiresAt: new Date(expiryMs).toISOString(),
      }],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/**
 * 把**真实的**临期折算实现挂进 runtime（本文件多处用例要验折算**值**）。
 *
 * ⚠️ 为什么用 `createProviderExpiry()`（生产那张表）而**不是**本文件自己写一份
 * 映射：后者会变成「同一语义两套判据」—— 本仓库首条红线
 *（`buddy-growth.ts` 因两处对同一字段给出相反判据而静默失效：不报错、不崩溃、
 * 单测能过，只是把「没做到」说成「做到了」）。这里挂的就是 `src/index.ts`
 * 注册的**同一份**表 ⇒ 单测验的是真实分派路径。
 *
 * ⚠️ 必须 `clearProviderRuntimes()`：注册表是**模块级** Map，且
 * `registerProviderRuntime` 对重复 id「保留先注册者」⇒ 不清空会让上一个用例的
 * 残留条目生效（尤其是别的 spec 留下的哨兵实现）。
 */
function registerRealExpiryRuntimes(): void {
  clearProviderRuntimes()
  const table = createProviderExpiry()
  for (const [id, expiry] of Object.entries(table)) {
    registerProviderRuntime({ descriptor: descriptorOf(id)!, expiry })
  }
}

/** 本文件所有用例都需要真实折算实现（分派已改为查 runtime 表）。 */
beforeEach(() => { registerRealExpiryRuntimes() })
afterEach(() => { clearProviderRuntimes() })

describe('真实临期探针：未接入的渠道必须返回 UNUSABLE（否则会被误当选）', () => {
  /** 取号时用的模型 id 桩（真实实现从渠道目录取第一个）。 */
  const anyModel = async (): Promise<string | undefined> => 'deepseek-v4.1-flash'

  it('provider 不在已知清单里时返回 UNUSABLE', async () => {
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const probe = createExpiryProbe(pool, anyModel)
    expect(await probe('raccoon')).toBe(UNUSABLE)
    expect(await probe('cline')).toBe(UNUSABLE)
    expect(await probe('opencode')).toBe(UNUSABLE)
  })

  it('无可用账号时返回 UNUSABLE', async () => {
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => null,
    } as never
    const probe = createExpiryProbe(pool, anyModel)
    expect(await probe('buddy')).toBe(UNUSABLE)
  })

  it('已中止的 signal 必须抛 AbortError，不得折算成 UNUSABLE', async () => {
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const probe = createExpiryProbe(pool, anyModel)
    const controller = new AbortController()
    controller.abort()
    await expect(probe('buddy', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('★ 探测期间中止必须抛 AbortError，不得吞成 UNUSABLE', async () => {
    // ⚠️ 本 `try` 里有两个可能抛错的调用（`firstModelIdOf` 与 `getAvailableAccount`），
    //    任一在探测途中被取消时抛出的 AbortError 若被折算成 UNUSABLE，用户取消后
    //    会看到「没有任何可用候选」而不是中止。
    const controller = new AbortController()
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const probe = createExpiryProbe(pool, async () => {
      controller.abort() // 模拟「探测途中被取消」（signal 被标记）
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    await expect(probe('buddy', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('★ signal 未被标记、但抛出的是 AbortError 时也必须逃逸（隔离 isAbortError 那一行）', async () => {
    // ⚠️ 上一条用例的 stub 里调了 `controller.abort()`，signal **已标记** ⇒
    //    `signal?.throwIfAborted()` 会先抛，`isAbortError(error)` 那一行**从未被判定**
    //    （Task 7 复审 M1 指出）。本用例**不标记 signal**，只让 stub 抛 AbortError
    //    ⇒ 唯一能拦住它的是 `isAbortError` 那一行。
    //
    // 为什么要单独锁：`isAbortError` 是**防御性**的（当前装配下 `listModels` 无 signal
    // 通道，故那条路径不可达），但装配层一旦改成会响应 signal 的取号方式它就会生效；
    // 没有本用例时删掉它不会有任何用例变红。
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const probe = createExpiryProbe(pool, async () => {
      const error = new Error('aborted upstream')
      error.name = 'AbortError'
      throw error // ⚠️ 注意：**不**调用 controller.abort()
    })
    // 传一个**未被标记**的 signal（它永远不会 abort）
    await expect(probe('buddy', new AbortController().signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('★ WIRED_EXPIRY_PROVIDERS：未接入渠道必须被剔除、已接入渠道必须真的走进折算', () => {
  // ⚠️ 该清单被聚合层用来决定「哪些虚拟模型可以播报」（未接入的渠道其模型会被
  //    过滤掉，否则用户选中后拿到的是误导性的「没有任何可用候选」）。
  //    ⇒ 清单若与实现漂移，会出现两种真实缺陷：
  //    ① 清单**多**了某渠道 ⇒ 它的模型被播报，但折算恒 UNUSABLE ⇒ 误导性报错；
  //    ② 清单**少**了某渠道 ⇒ 它的模型被隐藏，而其实可以正常参与轮换。
  //
  // ⚠️⚠️ **原先这里有一条「清单与 switch 分支逐项相等」的源码文本断言，已删除**
  //    （2026-10-08，Task 5）：它靠正则扫 `src/aggregate-expiry.ts` 里
  //    `case 'xxx':` 的捕获来锁「手抄清单 == 手写 switch 分支」。
  //    本次重构把「选哪个原语」改成了查 runtime 的 `expiry` 域 ⇒
  //    **源码里已经没有 `case` 了**，正则捕获恒为空数组，那条断言**无法**继续
  //    （保留它只能退化成「断言空数组 == 清单」—— 必然假红）。
  //
  // ⚠️ **它守的不变式并没有消失，而是搬了家且换了判据**：
  //    清单（编译期常量）与 runtime 的 `expiry` 域（`apply()` 时注册）**不是
  //    同一件事**，两者的一致性只能靠断言锁 —— 现由
  //    `tests/unit/expiry-runtime-parity.spec.ts` 的
  //    「清单 == runtime 里挂了 `expiry` 域的渠道集合」**真跑 `apply()`** 守住，
  //    且是**行为**判据（读真实的 runtime 表）而不是源码文本。
  //    ⚠️ 故本文件不再重复那条不变式（重复会变成「同一语义两套判据」）。

  it('★ 未知渠道必 UNUSABLE（方向对照；清单与 runtime 的一致性由对拍文件守）', async () => {
    // ⚠️ **本条原标题是「清单里的每个渠道都真的能折算（不返回「未接入」的兜底值）」——
    //    那是误导**（独立审计 M4 指出）：函数体只断言 `raccoon` / `not-a-channel`，
    //    而那两个**都不在清单里** ⇒ 它**从未遍历** `WIRED_EXPIRY_PROVIDERS`，
    //    任何实现都能过（本仓库「同义反复用例比没有更危险」的形态）。
    //
    //    本条的**真实价值**只是方向对照：**未知渠道必须被剔除**（不能返回 NEVER）。
    //    ⇒ 如实命名，不再声称它测了清单。
    const { createExpiryProbe } = await import('../../src/aggregate-expiry.js')
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [
        { entry: { id: 'a1' }, credential: {} },
      ],
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    // raccoon：真实渠道但**未接入**折算；not-a-channel：根本不存在的 id
    expect(await probe('raccoon')).toBe(-1)
    expect(await probe('not-a-channel')).toBe(-1)
  })

  it('★ 清单里的每个渠道都**真的走过了折算入口**（读了目录、未在短路处返回；**不测折算本身**）', async () => {
    // ⚠️ 补上「清单里的每个渠道都能折算」这个意图的**真实覆盖**（原用例只是
    //    标题那么写、实际没遍历）。判据：用一个「有可用账号」的池喂进去，
    //    每个清单渠道都必须**产生一次目录读取**（`firstModelIdOf` 被调用）——
    //    这证明它**没有**在「未接入」的短路处提前返回（那是 `UNUSABLE` 的另一条路径）。
    //    ⚠️ 不要求折算成功（各家凭据形状不同），只要求**真的走进去**。
    //    ⚠️ 本用例**刻意不跑 `apply()`**：它守的是「清单里的渠道不被短路」，
    //       那是**清单**这一侧的行为，与 runtime 是否注册无关（这正是清单必须
    //       是编译期常量的理由 —— 见 `aggregate-expiry.ts` 的长注释）。
    const { createExpiryProbe, WIRED_EXPIRY_PROVIDERS: wired } =
      await import('../../src/aggregate-expiry.js')
    expect(wired.length, '清单不能为空（否则本用例恒真）').toBeGreaterThan(0)

    for (const provider of wired) {
      const probed: string[] = []
      const probe = createExpiryProbe({
        disabledModelsFor: () => new Set<string>(),
        // 目录读取后返回空账号池，避免单测继续触发各 provider 的真实额度接口。
        // 本用例只验证每个接入渠道都会读取目录，不测试额度折算本身。
        // ⚠️ 这是**规避而非修复**（2026-10-12 审计登记）：出网根因**仍在** ——
        //    任何人再把「形状正确的凭据」喂进来（历史上就是
        //    `credential: { access_token: 'x' }`），各 provider 就会去**真实额度接口**。
        //    彻底修法是在本用例里给全局 `fetch` 打桩并**断言调用 0 次**，
        //    那样「未来某家新增取额度调用」也会立刻变红。用例名已随之修正
        //    （原先是「真的走过了折算路径」，与断言不符）。
        listAvailableCredentials: async () => [],
      } as never, async (p: string) => { probed.push(p); return 'm1' })
      await probe(provider).catch(() => undefined)
      expect(probed, `${provider} 必须走过折算路径（读目录），不能在短路处提前返回`)
        .toEqual([provider])
    }
    // ⚠️⚠️ **显式放宽 timeout**（2026-10-08 实测的既有 flake，不是本次改动引入）：
    //    本用例**串行**遍历清单里的 7 个渠道，每个都真跑一次折算（含读目录）。
    //    实测耗时 832/839ms，但**全量并行**时偶发超过 vitest 的 5000ms 默认上限
    //    ⇒ 假失败（单文件跑 6 次中 1 次红、全量 8 次中 2 次红，已独立复现）。
    //    这是**测试基础设施**问题（默认上限不适合「串行 N 渠道」的集成用例），
    //    不是逻辑缺陷 ⇒ 放宽到 30s 即消除（实测该上限下零失败）。
  }, 30_000)
})

describe('★ accioExpiry：命名池折算（与 loomy 同形，2026-10-13 合并审计补）', () => {
  /**
   * ⚠️ **为什么必须有这一组**：把 accio 加进 `WIRED_EXPIRY_PROVIDERS` 只是
   * 「允许它出现在聚合候选表里」；**折算值本身对不对**要单独锁。
   *
   * 三条判据（逐格，缺一格就是将来的事故）：
   *  - 有每日额度 ⇒ **当日 24:00**（24h 作废且不累积 ⇒ 临期优先里排最前）；
   *  - 只剩每月/推荐 ⇒ `NEVER`（上游**没有**下发它们的到期时间 ⇒ 不猜）；
   *  - 三类桶全 0 / 查询失败 ⇒ `UNUSABLE`（**不是 NEVER**：把它当「长期可用」
   *    会让请求被发到一个没额度的渠道）。
   */
  const makeDetail = (rows: Array<{ label: string; remaining: number }>) => ({
    balance: {
      total: rows.reduce((s, r) => s + r.remaining, 0),
      packages: rows.map((r) => ({
        name: r.label,
        unit: 'credit',
        remaining: r.remaining,
        total: r.remaining,
        used: 0,
        active: true,
        cycleStartTime: '',
        cycleEndTime: '',
        expiredTime: '',
      })),
    },
  })

  it('★ 有每日额度 ⇒ 当日 24:00（不是 NEVER）', async () => {
    const { accioExpiry } = await import('../../src/aggregate-expiry.js')
    const { fetchAccioBalanceDetailed } = await import('../../src/accio-credits.js')
    const spy = vi.spyOn(
      await import('../../src/accio-credits.js'),
      'fetchAccioBalanceDetailed',
    ).mockResolvedValue(makeDetail([{ label: '每日积分', remaining: 199 }]) as never)
    void fetchAccioBalanceDetailed
    const v = await accioExpiry({ access_token: 'x', refresh_token: 'y', expires_at: Date.now() + 1e6 } as never)
    expect(v).toBeGreaterThan(Date.now())
    expect(v).toBeLessThan(Date.now() + 48 * 3600_000)
    spy.mockRestore()
  })

  it('★ 只剩每月/推荐（无每日）⇒ NEVER（长期，不剔除）', async () => {
    const { accioExpiry } = await import('../../src/aggregate-expiry.js')
    const spy = vi.spyOn(
      await import('../../src/accio-credits.js'),
      'fetchAccioBalanceDetailed',
    ).mockResolvedValue(makeDetail([{ label: '每月积分', remaining: 500 }]) as never)
    expect(await accioExpiry({} as never)).toBe(NEVER)
    spy.mockRestore()
  })

  it('★ 三类桶全为 0 ⇒ UNUSABLE（**不是** NEVER）', async () => {
    const { accioExpiry } = await import('../../src/aggregate-expiry.js')
    const spy = vi.spyOn(
      await import('../../src/accio-credits.js'),
      'fetchAccioBalanceDetailed',
    ).mockResolvedValue(makeDetail([
      { label: '每日积分', remaining: 0 },
      { label: '每月积分', remaining: 0 },
    ]) as never)
    expect(await accioExpiry({} as never)).toBe(UNUSABLE)
    spy.mockRestore()
  })

  it('★ 查询失败 / 未登录（balance 为 null）⇒ UNUSABLE', async () => {
    const { accioExpiry } = await import('../../src/aggregate-expiry.js')
    const spy = vi.spyOn(
      await import('../../src/accio-credits.js'),
      'fetchAccioBalanceDetailed',
    ).mockResolvedValue({ balance: null, error: '未登录' } as never)
    expect(await accioExpiry({} as never)).toBe(UNUSABLE)
    spy.mockRestore()
  })
})

describe('★ 第 3 轮审计：未接入渠道必须短路（不取号、不读目录）', () => {
  it('未接入渠道：不得调用 firstModelIdOf，也不得取号', async () => {
    // ⚠️ 实测缺陷：初版对未接入渠道**先取号、后**才走到分派的兜底返回 UNUSABLE
    //    ⇒ 每次 auto 请求都为每个未接入渠道白做一次目录读取 + 账号池查询
    //    （探针：getAvailableAccount 被以 `cline/m1` 调用）。
    //    两者都**不是网络请求**（账号池是纯本地内存过滤），故属性能浪费而非功能缺陷，
    //    但短路零成本且语义更准 ——「未接入」≠「有账号但折算不了」。
    let modelIdCalls = 0
    let accountCalls = 0
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => { accountCalls += 1; return { entry: { id: 'a1' }, credential: {} } },
    } as never
    const probe = createExpiryProbe(pool, async () => { modelIdCalls += 1; return 'm1' })

    // 未接入的渠道（不在 WIRED_EXPIRY_PROVIDERS 里）
    expect(await probe('cline')).toBe(UNUSABLE)
    expect(await probe('raccoon')).toBe(UNUSABLE)
    expect(await probe('not-a-channel')).toBe(UNUSABLE)
    expect(modelIdCalls).toBe(0)
    expect(accountCalls).toBe(0)
  })

  it('已接入渠道：仍然照常取号（短路不能把正常的也跳掉）', async () => {
    let accountCalls = 0
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      // ⚠️ 判据已从 `getAvailableAccount`（返回**一个**代表账号）改为
      //    `listAvailableCredentials`（返回**全部**启用账号，用户 2026-10-07 选定）——
      //    因为「渠道整体的临期额度」必须看全部账号，只看第一个会漏掉
      //    「排后面的号快作废」这种情况。
      listAvailableCredentials: async () => {
        accountCalls += 1
        return [{ entry: { id: 'a1' }, credential: {} }]
      },
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    // buddy 已接入 ⇒ 必须真的去取号（凭据形状不对会让它抛错/返回 UNUSABLE，
    // 但**取号这件事必须发生**）
    await probe('buddy').catch(() => undefined)
    expect(accountCalls).toBe(1)
  })

  it('未接入渠道在**已中止**时仍必须抛 AbortError（短路不能吞掉中止）', async () => {
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    const controller = new AbortController()
    controller.abort()
    await expect(probe('cline', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

/**
 * `codeArtsExpiry` 的折算口径（真实缺陷回归，用户报障 2026-10-07）。
 *
 * ⚠️ **本文件此前完全没有覆盖折算值** —— 只测了控制流（短路 / 中止 / 清单一致性）。
 * 于是「codearts 被算成今天 24:00 作废」这个错误口径**一直没有测试发现**。
 * 本段补上这个缺口。
 */
describe('★ codeArtsExpiry：读不到到期时间就不猜（一律 NEVER）', () => {
  /** 造一个返回固定 `statistics/plugin` 响应的桩 fetcher。 */
  function stubFetch(payload: unknown) {
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch)
  }

  const cred = {
    access_key_id: 'ak', secret_access_key: 'sk', security_token: 'st', expires_at: '',
  } as never

  afterEach(() => { vi.unstubAllGlobals() })

  it('★ 积分账户有余额 ⇒ NEVER（**不是**今天 24:00 —— 接口不给到期时间）', async () => {
    // 实测的真实响应形状（本机账号 82AD9D6E）：有积分、但三个时间字段全空。
    stubFetch({
      package: { is_credit_package: true, is_token_package: false, spec_code: 'x', package_name: '体验版', status: 'normal' },
      metrics: [
        { name: 'usageTotalPackageCredit', package_credit_amount: 24000, package_credit_used: 1911.84, package_credit_remain: 22088.16 },
      ],
    })
    const value = await codeArtsExpiry(cred)
    // ⚠️ 旧实现返回 `nextUtc8DayStartMs()`（今天 24:00）⇒ 会让 codearts 在
    //    「临期优先」排序里**永远排最前**，抢走真正临期额度。
    expect(value).toBe(NEVER)
    expect(Number.isFinite(value)).toBe(false)
  })

  it('★ Token 计费账户（无积分口径）⇒ NEVER（账号可用，只是没有积分可烧）', async () => {
    stubFetch({
      package: { is_credit_package: false, is_token_package: true, spec_code: 'x', package_name: '体验版', status: 'normal' },
    })
    expect(await codeArtsExpiry(cred)).toBe(NEVER)
  })

  it('★★ 积分余额为 0 ⇒ NEVER（**不是** UNUSABLE —— 「余额 0」不等于「渠道不可用」）', async () => {
    // ⚠️ 本条的**真实价值**是挡住一个具体提议（PR #81 审计，2026-10-07）：
    //    把折算改成 `credit.total > 0 ? 当日 : UNUSABLE`，理由是「额度已尽仍被
    //    auto 选中」。该推理对本渠道不成立 —— codearts 有 benefit（免费额度）模型
    //    （现为 `isCodeArtsBenefitModelKnown`；旧的静态表 `isCodeArtsBenefitModel` 已删除），积分余额 0 的账号**仍能推理**；且账号可用性
    //    的权威判据是**探测是否成功**（`!result.ok`），不是余额数值。
    //    写成 UNUSABLE 会把一个可用账号从 auto 候选里**永久剔除**。
    stubFetch({
      package: { is_credit_package: true, is_token_package: false, spec_code: 'x', package_name: '体验版', status: 'normal' },
      metrics: [
        { name: 'usageTotalPackageCredit', package_credit_amount: 24000, package_credit_used: 24000, package_credit_remain: 0 },
      ],
    })
    const value = await codeArtsExpiry(cred)
    expect(value).toBe(NEVER)
    expect(value).not.toBe(UNUSABLE)
  })

  it('★ 查询失败 ⇒ UNUSABLE（剔除），与「没有到期概念」严格区分', async () => {
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    expect(await codeArtsExpiry(cred)).toBe(UNUSABLE)
  })

  it('★ 网络抛错 ⇒ UNUSABLE（不把异常当成 NEVER）', async () => {
    vi.stubGlobal('fetch', (async () => { throw new Error('network down') }) as unknown as typeof fetch)
    expect(await codeArtsExpiry(cred)).toBe(UNUSABLE)
  })
})

/**
 * ★ lobsterai / trae 的临期折算（真实缺陷回归，用户报障 2026-10-07）。
 *
 * ⚠️ **用户报障原文**：「如果没有临时积分也能进轮换列表的话，有 4.1 flash 的模型
 * 不止 3 个，为什么别的没进？」
 *
 * 核实结论：`auto-adapter.ts` 曾写「其余 provider（qoder / trae / cline / …）
 * 结构上留好接口但不接入：**它们没有跨账号的到期余额探测端点**」——
 * **该理由对 lobsterai 与 trae 是错的**：
 *
 * | 渠道 | 到期时间来源 |
 * |---|---|
 * | `lobsterai` | `lobsterai-credits.ts` 把 ISO `expiresAt` 归一化成 **`deductionEndTime`** |
 * | `trae` | `trae-credits.ts` 从条目级 `expire_time`（秒）算 **`deductionEndTime`** |
 *
 * 两者与 `buddy` **完全同形**（都是「有效包 `deductionEndTime` 的最小值」），
 * 故折算逻辑可共享、接入几乎免费。
 *
 * ⚠️ `raccoon` **确实没有**到期时间（`raccoon-credits.ts` 的 `makePackage` 把
 * `cycleStartTime`/`cycleEndTime`/`expiredTime` 全部置空）⇒ 它**保持未接入**，
 * 上面第一条用例继续断言它返回 UNUSABLE。
 */
describe('★ lobsterai / trae：与 buddy 同形的「有效包最早到期」折算', () => {
  // ⚠️ trae 的 `postJson` **要求 `uid` 非空**（否则早退「缺少 user_id，无法构造设备身份」
  //    ⇒ 返回 null ⇒ UNUSABLE）。lobsterai 只用 access_token。
  //    我第一版给两家共用同一个最小凭据，trae 因此恒返回 -1。
  const cred = { access_token: 't', expires_at: '' } as never
  const traeCred = { access_token: 't', expires_at: '', uid: 'u1' } as never

  afterEach(() => { vi.unstubAllGlobals() })

  /** 把某个时刻的毫秒戳算成「还剩多久」的可读形式。 */
  const future = (ms) => Date.now() + ms

  it('★ lobsterai：取有效包 deductionEndTime 的最小值', async () => {
    // ⚠️ **必须给 ISO 串带时区后缀**（我第一版没带，用例假失败）：
    //    `lobsterai-credits.ts` 用 `Date.parse(expiresAt)` 解析，而无时区后缀的 ISO 串
    //    按**本机时区**解释（本机 UTC+8）⇒ 同一串解析出的时刻比 UTC 早 8 小时
    //    ⇒ 「2 小时后」的包被算成 6 小时前（已过期）⇒ `active:false` ⇒ 被过滤，
    //    函数于是返回了另一个包的值。**不是实现缺陷，是我造的测试数据有歧义。**
    //    ⚠️ 顺带记录一个真实口径：服务端若下发不带时区的串，解析结果**依赖本机时区**
    //   （见下方单独一条用例）。
    const soonMs = Date.now() + 2 * 60 * 60 * 1000
    const laterMs = Date.now() + 30 * 24 * 60 * 60 * 1000
    // 带 `+08:00`：明确按 UTC+8 解释，与「本机时区」无关，用例才稳定。
    const iso = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00'
    // ⚠️ 必须带 `code: 0` —— `parseLobsteraiEnvelope` 要求它（缺失 ⇒ code=-1 ⇒ ok:false
    //    ⇒ 函数返回 null ⇒ UNUSABLE）。我第一版漏了，三条用例全返回 -1。
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: {
        creditItems: [
          { label: '每日登录奖励', type: 'campaign', creditsRemaining: 100, expiresAt: iso(laterMs) },
          { label: '赠送', type: 'gift', creditsRemaining: 50, expiresAt: iso(soonMs) },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)

    const value = await lobsteraiExpiry(cred, LOBSTERAI)
    // ISO 串只到秒 ⇒ 期望值也截到秒。
    expect(value, '应取最早到期那个包（2 小时后）').toBe(Math.floor(soonMs / 1000) * 1000)
  })

  it('★★ lobsterai：有效包但**余额为 0** ⇒ UNUSABLE（退出 auto 候选）', async () => {
    // ⚠️⚠️ 本条原为「★ lobsterai：无有效包 ⇒ NEVER（不剔除）」—— **名字与 fixture
    //    不符**（fixture 是 `creditsRemaining: 0`，即**有效包、余额为 0**，不是「无有效包」），
    //    而那个期望值本身就是缺陷（真实缺陷，对抗审计实测证伪，2026-10-07）：
    //    `creditsRemaining` 是**剩余额度**（`lobsterai-credits.ts:328` 读它填
    //    `CreditPackage.remaining`）⇒ 余额 0 表示**这个渠道现在没有可烧的额度**，
    //    返回 `NEVER`（= 可当选）会让 auto 选中它、请求随即 `QUOTA_EXCEEDED` 失败 ——
    //    **与 PR #81 报障完全同型**。
    //
    //    ⚠️ 与 `buddy-balance-rank.ts` 的判据对齐：`buddyBalanceTier`（:195-203）
    //    在余额全为 0 时返回 `none`，而 `buddyTierUsable`（:210-212）明写
    //    **`none` 档不可用**。折算层现在与选号器**同构**。
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: { creditItems: [{ label: 'x', type: 'gift', creditsRemaining: 0, expiresAt: '' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    const value = await lobsteraiExpiry(cred, LOBSTERAI)
    expect(value).toBe(UNUSABLE)
    // 方向对照：`NEVER` 是「可用、只是不临期」，它**参与排序且可当选** ——
    // 正是本缺陷的成因，故绝不能用它表示「余额已尽」。
    expect(value).not.toBe(NEVER)
  })

  it('★★ lobsterai：**只有失效包** ⇒ UNUSABLE（不是 NEVER）', async () => {
    // 失效包（`active: false`）不计入任何桶 —— 若账号只有失效包，同样「没有可烧的额度」。
    const past = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19) + '+08:00'
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: { creditItems: [{ label: 'x', type: 'gift', creditsRemaining: 100, expiresAt: past }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    expect(await lobsteraiExpiry(cred, LOBSTERAI)).toBe(UNUSABLE)
  })

  it('★ 对照：lobsterai 有效包**有余额但无到期时间** ⇒ NEVER（不得误剔除可用渠道）', async () => {
    // ⚠️ 这一格是**防误伤**：`expiresAt` 为空串是实测形态，此时账号**确实有额度**，
    //    剔除它会丢掉一个可用渠道。判据必须是「有没有 `active && remaining > 0` 的包」，
    //    而不是「有没有带到期时间的包」。
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: { creditItems: [{ label: 'x', type: 'gift', creditsRemaining: 500, expiresAt: '' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    expect(await lobsteraiExpiry(cred, LOBSTERAI)).toBe(NEVER)
  })

  it('★ lobsterai：查询失败 ⇒ UNUSABLE（与「无到期概念」严格区分）', async () => {
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    expect(await lobsteraiExpiry(cred, LOBSTERAI)).toBe(UNUSABLE)
  })

  it('★ trae：取条目级 expire_time（秒）换算后的最小值', async () => {
    const soonSec = Math.floor(future(3 * 60 * 60 * 1000) / 1000)
    const laterSec = Math.floor(future(20 * 24 * 60 * 60 * 1000) / 1000)
    // ⚠️ 字段名是 **`user_entitlement_pack_list`**（`trae-credits.ts` 实测），
    //    不是 `pack_list` —— 我第一版写错，函数因「不是数组」返回 null ⇒ UNUSABLE。
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      user_entitlement_pack_list: [
        {
          entitlement_base_info: { quota: { credits_limit: 500 }, display_desc: '每月登录赠送' },
          usage: { credits_amount: 0 }, expire_time: laterSec,
        },
        {
          entitlement_base_info: { quota: { credits_limit: 300 }, display_desc: '签到奖励' },
          usage: { credits_amount: 10 }, expire_time: soonSec,
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)

    const value = await traeExpiry(traeCred, TRAE)
    // ⚠️ 秒 → 毫秒必须 ×1000（不乘会落到 1970 年）。
    expect(value).toBe(soonSec * 1000)
  })

  it('★ trae：无到期时间（`expire_time` 为 0）⇒ NEVER（不猜）', async () => {
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      user_entitlement_pack_list: [
        {
          entitlement_base_info: { quota: { credits_limit: 300 }, display_desc: 'x' },
          usage: { credits_amount: 0 }, expire_time: 0,
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    expect(await traeExpiry(traeCred, TRAE)).toBe(NEVER)
  })

  it('★ trae：查询失败 ⇒ UNUSABLE', async () => {
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    expect(await traeExpiry(traeCred, TRAE)).toBe(UNUSABLE)
  })
})

/**
 * ★ 「探全部账号、取最早」（用户报障 2026-10-07 的第二次质疑）。
 *
 * 用户原话：「workbuddy 中一个号是 1 天到期，为什么我们统计是 2000 多天，
 * **只用了第一个账号吗**？」
 *
 * **他猜对了。** 旧实现走 `pool.getAvailableAccount`，那个方法只返回**手动序第一个**
 * 可用账号 ⇒ 用户把「1 天到期」的号拖到后面时，它的临期额度在**排序**里被完全忽略：
 * 这个渠道明明有一个快作废的号，却被按「2000 多天后才作废」排到最后。
 *
 * ⇒ 改为取**全部**启用账号，逐个折算，取**最早**的那个。
 */
describe('★ 临期折算必须看**全部**账号（不能只看手动序第一个）', () => {
  /** 造一个 pool：`listAvailableCredentials` 返回给定的多个凭据。 */
  const poolWith = (credentials: unknown[]) => ({
    disabledModelsFor: () => new Set<string>(),
    listAvailableCredentials: async () => credentials.map((credential) => ({
      entry: { id: `a${Math.random()}` }, credential,
    })),
    // ⚠️ 同时提供旧的单账号方法（回退路径用）—— 但本组用例断言**走的是新方法**。
    getAvailableAccount: async () => {
      throw new Error('不应走单账号回退路径')
    },
  }) as never

  it('★ 取全部账号里**最早**的到期时刻（不是第一个账号的）', async () => {
    // ⚠️ 走**完整真实链路**：`createExpiryProbe` → `buddyExpiry` → `fetchCreditBalance`
    //    → 全局 fetch（桩）。两个账号的响应不同：
    //      A（排第一）：30 天后到期
    //      B（排第二）：**1 天后**到期  ← 用户拖在后面的那个
    //    正确行为：取 B 的 1 天（渠道整体「最早作废」）。
    //    旧实现只看 A ⇒ 返回 30 天，于是这个渠道被排到最后（用户报障的现象）。
    const now = Date.now()
    const soon = now + 1 * 86_400_000
    const later = now + 30 * 86_400_000
    // ⚠️ 响应是**两层嵌套**：`data.Response.Data.Accounts[]`（`credits.ts` 实测），
    //    且余额字段是 `CycleCapacityRemain`（本周期口径）、失效判据是 `Status`。
    //    我第一版写 `data.packages[].Remain` —— 解析不出来 ⇒ 包全被跳过 ⇒ 返回 Infinity。
    const wrap = (pkg) => ({ code: 0, data: { Response: { Data: { Accounts: [pkg] } } } })
    const responses = [
      wrap({ Status: 1, CycleCapacityRemain: 10, DeductionEndTime: later }),
      wrap({ Status: 1, CycleCapacityRemain: 10, DeductionEndTime: soon }),
    ]
    let calls = 0
    vi.stubGlobal('fetch', (async () => {
      const body = responses[Math.min(calls, responses.length - 1)]
      calls += 1
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch)

    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [
        { entry: { id: 'a1' }, credential: { access_token: 't1' } },
        { entry: { id: 'a2' }, credential: { access_token: 't2' } },
      ],
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    const value = await probe('buddy')
    // ★ 必须是**较早**的那个（B 的 1 天），而不是第一个账号的 30 天
    expect(value).toBe(soon)
    expect(calls, '两个账号都要探（不能只探第一个）').toBeGreaterThanOrEqual(2)
  })

  it('★ 必须调用 `listAvailableCredentials`（而不是只取一个代表账号）', async () => {
    let listCalls = 0
    let legacyCalls = 0
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => { listCalls += 1; return [] },
      getAvailableAccount: async () => { legacyCalls += 1; return null },
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    await probe('buddy').catch(() => undefined)
    expect(listCalls, '必须走「全部账号」路径').toBe(1)
    expect(legacyCalls, '不得回退到单账号路径（它存在时）').toBe(0)
  })

  it('★ 只有旧方法时回退（既有测试桩的兼容路径，语义是降级不是错误）', async () => {
    let legacyCalls = 0
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => { legacyCalls += 1; return null },
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1')
    // 回退路径被走到 ⇒ 返回 UNUSABLE（没有账号），**不抛错**
    await expect(probe('buddy')).resolves.toBe(UNUSABLE)
    expect(legacyCalls).toBe(1)
  })

  it('★ 一个账号都没有 ⇒ UNUSABLE（与「有账号但读不到到期时间」严格区分）', async () => {
    const probe = createExpiryProbe(poolWith([]), async () => 'm1')
    await expect(probe('buddy')).resolves.toBe(UNUSABLE)
  })
})

/**
 * ★ 临期折算必须**带 TTL 缓存**（用户要求 2026-10-07）。
 *
 * 用户原话：「我们每次计算排序用的数据应该是调已有缓存而不是从服务器请求最新积分数据，
 * 缓存定期更新各个 provider 的积分」。
 *
 * ## 为什么必须缓存（实测的调用频率）
 *
 * `auto-adapter.ts` 的 `expiryOf` **每次调用都新建一个 probe**
 *（`createExpiryProbe(this.options.accountPool, …)`），而聚合层也用同一个工厂
 * ⇒ 没有缓存时**每次请求**都会对每个候选渠道重打上游余额接口。
 * 一个 `auto` 请求的候选池跨全部渠道 ⇒ 一次请求就是 N 次上游 GET。
 *
 * ## TTL 取 60 秒（用户给的选项：60 / 90 / 120）
 *
 * 选 60 的理由：
 * - 与既有的 `BUDDY_BALANCE_CACHE_TTL_MS = 60_000`（余额选号器）**同值** ——
 *   两处缓存节奏一致，不会出现「选号用的是 30 秒前的数据、排序用的是 90 秒前的」；
 * - 临期判据的最小粒度是**天**（资源包到期时间以天计），60 秒的滞后在语义上
 *   完全无害；
 * - 最短 ⇒ 用户改完渠道侧配置后，最坏情况下等待最短。
 *   ⚠️ 90/120 只省下极少量请求（面板与排序都不是高频路径），却让「刚登录的账号
 *   不出现在排序里」的窗口更长。
 */
describe('★ 临期折算的 TTL 缓存（默认 60 秒，与余额选号器同值）', () => {
  const poolWith = (credentials: unknown[]) => ({
    disabledModelsFor: () => new Set<string>(),
    listAvailableCredentials: async () => credentials.map((credential) => ({
      entry: { id: 'a1' }, credential,
    })),
  }) as never

  /** 造一个计数上游调用的 buddy 桩响应。 */
  function stubCountingFetch(deductionEndTime: number) {
    let calls = 0
    vi.stubGlobal('fetch', (async () => {
      calls += 1
      return new Response(JSON.stringify({
        code: 0,
        data: { Response: { Data: { Accounts: [
          { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: deductionEndTime },
        ] } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch)
    return () => calls
  }

  it('★ TTL 内重复探测只打一次上游（命中缓存）', async () => {
    let nowMs = 1_000_000
    const calls = stubCountingFetch(nowMs + 86_400_000)
    const probe = createExpiryProbe(poolWith([{ access_token: 't' }]), async () => 'm1', {
      now: () => nowMs,
    })
    await probe('buddy')
    const afterFirst = calls()
    expect(afterFirst).toBeGreaterThan(0)
    // 同一时刻再探 3 次 ⇒ 上游调用数**不得增加**
    await probe('buddy')
    await probe('buddy')
    await probe('buddy')
    expect(calls(), 'TTL 内必须命中缓存，不得重复打上游').toBe(afterFirst)
  })

  it('★ 超过 TTL 后重新探测（缓存会过期）', async () => {
    let nowMs = 1_000_000
    const calls = stubCountingFetch(nowMs + 86_400_000)
    const probe = createExpiryProbe(poolWith([{ access_token: 't' }]), async () => 'm1', {
      now: () => nowMs,
    })
    await probe('buddy')
    const afterFirst = calls()
    // 推进到 TTL 之后
    nowMs += 60_001
    await probe('buddy')
    expect(calls(), 'TTL 过后必须重新探测').toBeGreaterThan(afterFirst)
  })

  it('★ 不同渠道各自缓存（一个渠道的缓存不得顶替另一个）', async () => {
    let nowMs = 1_000_000
    const calls = stubCountingFetch(nowMs + 86_400_000)
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: { access_token: 't' } }],
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1', { now: () => nowMs })
    await probe('buddy')
    const afterBuddy = calls()
    await probe('workbuddy')
    expect(calls(), 'workbuddy 是另一个渠道，必须自己探一次').toBeGreaterThan(afterBuddy)
  })

  it('★ 中止**不得**被缓存（否则一次取消会让后续请求误命中）', async () => {
    let nowMs = 1_000_000
    const calls = stubCountingFetch(nowMs + 86_400_000)
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: { access_token: 't' } }],
    } as never
    const probe = createExpiryProbe(pool, async () => 'm1', { now: () => nowMs })
    const controller = new AbortController()
    controller.abort()
    await expect(probe('buddy', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls(), '中止不该产生缓存条目').toBe(0)
    // 未中止的调用仍要正常工作（说明缓存没被中止污染）
    await probe('buddy')
    expect(calls()).toBeGreaterThan(0)
  })
})

/**
 * ★ 全部账号折算失败 ⇒ 必须 UNUSABLE，**不是** NEVER（真实缺陷，独立审计实测证伪）。
 *
 * ## 为什么这是**最高价值**的一条判据
 *
 * `NEVER` 的语义是「**可用**、只是不临期」（参与排序、**可当选**），
 * `UNUSABLE` 的语义是「剔除」。而「所有账号都查不到额度」= 我们对这个渠道的
 * **额度一无所知** ⇒ 必须剔除。
 *
 * ⚠️ 模块头自己写着铁律：「未接入 = `UNUSABLE` = 剔除。**宁可少一个候选，
 * 不可把未知当可用。**」而旧实现在「全部账号折算失败」时返回 `NEVER` ——
 * 与这条铁律**直接矛盾**。
 *
 * 后果（审计实测）：buddy 有 2 个已登录账号、上游余额接口 5xx（或 token 全过期）
 * ⇒ 该渠道被判「可用、只是不临期」⇒ 进入排序且**可当选** ⇒ 请求被发到一个
 * 额度未知（可能已用尽）的渠道。而且该错误值还会被缓存 60 秒。
 */
describe('★ 全部账号折算失败 ⇒ UNUSABLE（不能把「不知道」当「可用」）', () => {
  const poolWith = (credentials) => ({
    disabledModelsFor: () => new Set(),
    listAvailableCredentials: async () => credentials.map((credential) => ({
      entry: { id: 'a1' }, credential,
    })),
  })

  it('★ 两个账号都查失败 ⇒ UNUSABLE（不是 NEVER）', async () => {
    // 上游一律 5xx ⇒ `fetchCreditBalance` 返回 null ⇒ `buddyExpiry` 返回 UNUSABLE
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    const probe = createExpiryProbe(
      poolWith([{ access_token: 't1' }, { access_token: 't2' }]),
      async () => 'm1',
    )
    const value = await probe('buddy')
    expect(value, '全部账号都查不到 ⇒ 必须剔除，不能判成「可用但不临期」').toBe(UNUSABLE)
    // ⚠️ 本断言本意是「**不是** `NEVER`」。
    //    我第一版写成 `expect(Number.isFinite(value)).toBe(false)` —— **写反了**：
    //    `UNUSABLE = -1` 是**有限数**（`Number.isFinite(-1) === true`），
    //    而 `NEVER = Infinity` 才是非有限。故判据应是「值不等于 `NEVER`」。
    expect(value, '绝不能是 NEVER（Infinity）').not.toBe(NEVER)
  })

  it('★ 单个账号查失败（同一条路径的另一形态）⇒ 也是 UNUSABLE', async () => {
    vi.stubGlobal('fetch', (async () => { throw new Error('network down') }) as unknown as typeof fetch)
    const probe = createExpiryProbe(poolWith([{ access_token: 't' }]), async () => 'm1')
    expect(await probe('buddy')).toBe(UNUSABLE)
  })

  it('★ 对照：一个账号成功 ⇒ 取它的值（不能因另一个失败就整渠道剔除）', async () => {
    // 第 1 个账号 5xx、第 2 个成功 ⇒ 取成功那个的到期时刻
    const soon = Date.now() + 86_400_000
    let call = 0
    vi.stubGlobal('fetch', (async () => {
      call += 1
      if (call === 1) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({
        code: 0,
        data: { Response: { Data: { Accounts: [
          { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: soon },
        ] } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch)
    const probe = createExpiryProbe(
      poolWith([{ access_token: 't1' }, { access_token: 't2' }]),
      async () => 'm1',
    )
    expect(await probe('buddy')).toBe(soon)
  })
})

/**
 * ★ `clear()` 必须真的清空缓存（真实缺陷：缓存原无任何失效通道）。
 *
 * 无失效通道的后果：**刚登录**（或限流刚解禁）的账号在**最长 60 秒内对路由不可见**，
 * 用户拿到误导性的 `MISSING_CREDENTIAL | …没有任何可用候选`（明明刚登录成功）。
 */
describe('★ 临期缓存必须可清空（账号变化时由装配层调用）', () => {
  const poolWith = (credentials: unknown[]) => ({
    disabledModelsFor: () => new Set<string>(),
    listAvailableCredentials: async () => credentials.map((credential) => ({
      entry: { id: 'a1' }, credential,
    })),
  }) as never

  it('★ 清空后必须重新探测（不再命中旧值）', async () => {
    let nowMs = 1_000_000
    let calls = 0
    vi.stubGlobal('fetch', (async () => {
      calls += 1
      return new Response(JSON.stringify({
        code: 0,
        data: { Response: { Data: { Accounts: [
          { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: nowMs + 86_400_000 },
        ] } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch)
    const probe = createExpiryProbe(poolWith([{ access_token: 't' }]), async () => 'm1', {
      now: () => nowMs,
    })
    await probe('buddy')
    const afterFirst = calls
    // TTL 内再探 ⇒ 命中缓存
    await probe('buddy')
    expect(calls).toBe(afterFirst)
    // ★ clear() 之后 ⇒ 必须重新探（这就是「刚登录账号立刻可见」的保证）
    probe.clear()
    await probe('buddy')
    expect(calls, 'clear() 之后必须重新探测').toBeGreaterThan(afterFirst)
  })

  it('★ clear() 后可复用于多个渠道（清全部，不是只清一个）', async () => {
    let nowMs = 1_000_000
    const calls: string[] = []
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: { Response: { Data: { Accounts: [
        { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: nowMs + 86_400_000 },
      ] } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: { access_token: 't' } }],
    } as never
    const probe = createExpiryProbe(pool, async (p: string) => { calls.push(p); return 'm1' }, {
      now: () => nowMs,
    })
    await probe('buddy')
    await probe('workbuddy')
    const after = calls.length
    probe.clear()
    await probe('buddy')
    await probe('workbuddy')
    expect(calls.length, '两个渠道都要重新取号（clear 是清全部）').toBeGreaterThan(after)
  })
})

/**
 * ★ `clear()` 必须挡住**在途探测**（真实缺陷，对抗审计实测证伪）。
 *
 * ## 机制
 * `cacheAndReturn` 在探测**结束时**无条件写缓存。若一个探测**早在 `clear()` 之前**
 * 就已开始（正卡在 `await` 上），它的写回发生在 `clear()` **之后** ⇒
 * **陈旧值活过整个 TTL**（用户「清缓存」的努力被一个在途请求作废）。
 *
 * 对抗审计实测：
 * ```
 * clear() 期间在途探测: -1 ｜ clear 后再探: -1 ｜ 取号次数: 1
 * ```
 * ⇒ 登录后清缓存，但那个「登录前开始、登录后才结束」的探测把 `-1`（不可用）
 * 又写了回去，用户仍要再等 60 秒。
 *
 * ## 修法
 * **代际计数**：`clear()` 递增代际，探测在**开始时**记下代际，写回时代际不符
 * 就**丢弃**（不写缓存）。
 */
describe('★ clear() 必须挡住在途探测（陈旧值不得活过 clear）', () => {
  it('★ 在 clear() 之前开始、之后结束的探测，不得写回缓存', async () => {
    let nowMs = 1_000_000
    let releaseSlow
    const slowGate = new Promise((resolve) => { releaseSlow = resolve })
    let calls = 0

    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => {
        calls += 1
        if (calls === 1) {
          // 第一个探测：卡住（模拟「在途」）
          await slowGate
        }
        return [{ entry: { id: 'a1' }, credential: { access_token: 't' } }]
      },
    } as never

    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: { Response: { Data: { Accounts: [
        { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: nowMs + 86_400_000 },
      ] } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)

    const probe = createExpiryProbe(pool, async () => 'm1', { now: () => nowMs })

    // ① 启动一个探测（它会卡在 slowGate 上 —— 尚未写缓存）
    const inFlight = probe('buddy')
    // ② 让它推进到 await（微任务队列）
    await Promise.resolve()
    // ③ 此时 clear()（模拟「用户刚登录」）
    probe.clear()
    // ④ 放行那个在途探测
    releaseSlow!(undefined)
    await inFlight

    // ⑤ 现在**重新探测**：必须真的去打上游（不能被在途探测写回的旧值命中）
    const before = calls
    await probe('buddy')
    expect(calls, '★ 在途探测不得写回缓存 ⇒ 此处必须重新取号（= 重新探测）')
      .toBeGreaterThan(before)
  })

  it('★ 对照：clear() 之后的正常探测仍要写缓存（TTL 语义不能被破坏）', async () => {
    let nowMs = 1_000_000
    let calls = 0
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => {
        calls += 1
        return [{ entry: { id: 'a1' }, credential: { access_token: 't' } }]
      },
    } as never
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      code: 0,
      data: { Response: { Data: { Accounts: [
        { Status: 1, CycleCapacityRemain: 10, DeductionEndTime: nowMs + 86_400_000 },
      ] } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    const probe = createExpiryProbe(pool, async () => 'm1', { now: () => nowMs })
    await probe('buddy')
    const afterFirst = calls
    await probe('buddy')
    expect(calls, 'TTL 内应命中缓存').toBe(afterFirst)
  })
})

/**
 * ★★ 单渠道折算预算（`EXPIRY_PROBE_BUDGET_MS`）与 `budgetMs` 归一化。
 *
 * ## 本组用例的**三条自证纪律**（初版三条用例全踩了，逐条记下来）
 *
 * 1. **桩必须真的存在**：初版调了一个全仓不存在的 `stubFetchHangs()`，三条用例
 *    全部 `ReferenceError` ⇒ **从未运行过**。本组把桩定义在**文件作用域**（`hangingFetch`
 *    与 `poolOfAccounts`），并在文件头就有其它 describe 在用同一套写法。
 * 2. **`poolOfAccounts(n)` 的入参必须是「账号数」**，而本文件既有的 `poolWith(...)`
 *    是**各 describe 内部的局部 const**、且收的是**凭据数组**。初版写成
 *    `poolWith(7)`（数字）⇒ 若把那个 `poolWith` 提到作用域，`7.map` 会抛
 *    `TypeError` 并被外层 `catch` 吞成 `UNUSABLE` ⇒ **0 次 fetch、0 ms** ⇒
 *    断言 1「是 UNUSABLE」与「耗时 < 预算+5s」**全部满足**，而预算代码一行没跑
 *    （**假绿**，比红更危险）。⇒ 本组用**独立的** `poolOfAccounts`，不复用 `poolWith`。
 * 3. **fetch 桩的报文形状必须是被测渠道真实消费的那个**：`lobsterai` 走
 *    `parseLobsteraiEnvelope` → `data.creditItems[]`（`lobsterai-credits.ts`）。
 *    初版给的是 `data.Response.Data.Accounts[]`（那是 `credits.ts` 的 buddy 形状，
 *    从本文件里 `it.skip` 的旧用例抄来的）⇒ 解析不到包 ⇒ 恒 `UNUSABLE` ⇒
 *    断言 `toBe(expiry)` **必红，且红因是桩形状而不是被测逻辑**。
 *
 * ## 为什么用真实时钟
 *
 * `vi.useFakeTimers()` 会让「计时器没保持事件循环活跃」这条缺陷测不出来
 * （`withinBudget` 的注释记着：`unref()` 会让进程以
 * `Warning: Detected unsettled top-level await` 静默退出）。
 */
describe('★ 预算常量与归一化', () => {
  it('EXPIRY_PROBE_BUDGET_MS = 8 秒；下限 1.5 秒 < 预算', () => {
    expect(EXPIRY_PROBE_BUDGET_MS).toBe(8_000)
    expect(EXPIRY_PROBE_MIN_SLICE_MS).toBe(1_500)
    // ⚠️ 下限必须小于预算，否则「一个账号都不止一份」时总时长必然超预算。
    expect(EXPIRY_PROBE_MIN_SLICE_MS).toBeLessThan(EXPIRY_PROBE_BUDGET_MS)
  })

  it('★ normalizeExpiryProbeBudget：只有有限非负数被采纳（`Infinity` 回落默认）', () => {
    // ⚠️ 这张表是**行为判据**，不是常量自证：初版只判 `=== 0`，于是 `Infinity`
    //    （「不封顶」最自然的直觉写法）会让 `setTimeout` 溢出被钳成 1 ms ⇒
    //    全部渠道瞬间 UNUSABLE（实测）。逐格断言防它回来。
    expect(normalizeExpiryProbeBudget(undefined)).toBe(EXPIRY_PROBE_BUDGET_MS)
    expect(normalizeExpiryProbeBudget(0), '0 = 不封顶，是唯一登记的写法').toBe(0)
    expect(normalizeExpiryProbeBudget(-1), '负数 ⇒ 回落默认（否则 deadline 在过去、0 次 fetch）')
      .toBe(EXPIRY_PROBE_BUDGET_MS)
    expect(normalizeExpiryProbeBudget(Number.POSITIVE_INFINITY), 'Infinity ⇒ 回落默认')
      .toBe(EXPIRY_PROBE_BUDGET_MS)
    expect(normalizeExpiryProbeBudget(Number.NaN)).toBe(EXPIRY_PROBE_BUDGET_MS)
    expect(normalizeExpiryProbeBudget('0'), '字符串不是数字').toBe(EXPIRY_PROBE_BUDGET_MS)
    expect(normalizeExpiryProbeBudget(8_000)).toBe(8_000)
    // ⚠️ 上界是 `setTimeout` 自己的上限：超过它 Node 会钳成 1 ms ⇒ 必须在这里截断。
    expect(normalizeExpiryProbeBudget(1e10)).toBe(2 ** 31 - 1)
  })
})

describe('★★ 预算真的封顶，且**每个账号都有机会**（回归：首号慢不得判死整渠道）', () => {
  it(
    '7 个账号全部挂死 ⇒ 在预算附近收工，不是 7×30s',
    async () => {
      stubHangingFetch()
      const probe = createExpiryProbe(poolOfAccounts(7), async () => 'deepseek-v4.1-flash')
      const startedAt = Date.now()
      const value = await probe('lobsterai')
      const elapsed = Date.now() - startedAt

      expect(value, '全部账号都查不到 ⇒ 必须剔除，不能判成「可用但不临期」').toBe(UNUSABLE)
      expect(value, '绝不能是 NEVER（Infinity）—— 那会被排序当成永久可用').not.toBe(NEVER)
      // 上界留足余量（CI 抖动）；下界只需证明它不是 210 s。
      expect(elapsed, '预算必须封顶：7 个账号 × 30s = 210s 是升级前的实际耗时')
        .toBeLessThan(EXPIRY_PROBE_BUDGET_MS + 5_000)
    },
    EXPIRY_PROBE_BUDGET_MS + 10_000,
  )

  it(
    '★★ 首号慢（> 单份预算）+ 次号快且成功 ⇒ **渠道必须保住**（初版会判 UNUSABLE）',
    async () => {
      // ⚠️⚠️ 这是本组**最有价值**的一条：初版「首号吃满预算就 break」的实测后果是
      //    「可用渠道被判死 + 缓存 60 秒 + 每轮同一个首号 ⇒ 永久不可见」。
      //    第 1 号 12 秒后才失败（< 30 s 自身超时，但 > 8 s 预算），第 2 号 100 ms 成功。
      const expiry = Date.now() + 86_400_000
      let call = 0
      vi.stubGlobal('fetch', ((_input: unknown, init?: { signal?: AbortSignal }) => {
        call += 1
        if (call === 1) {
          return new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('上游慢失败')), 12_000)
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          })
        }
        return Promise.resolve(lobsteraiCreditsResponse(expiry))
      }) as unknown as typeof fetch)

      const probe = createExpiryProbe(poolOfAccounts(2), async () => 'deepseek-v4.1-flash')
      const value = await probe('lobsterai')
      expect(
        value,
        '首号慢不得让整渠道被判 UNUSABLE —— 次号明明可用（初版缺陷：break 掉后次号一次都没被问）',
      ).toBe(expiry)
    },
    EXPIRY_PROBE_BUDGET_MS + 15_000,
  )

  it(
    '★★ `budgetMs: Infinity` 必须**回落默认 8 秒**（不是「不封顶」，更不是 1 ms）',
    async () => {
      // ⚠️⚠️ 这条守的是**归一化被真的接上了**，不是 `normalizeExpiryProbeBudget` 本身
      //    （那个由上面那条纯函数用例守）。2026-10-22 变异验证实测：
      //    把 `normalizeExpiryProbeBudget(...)` 换回 `options.budgetMs ?? 默认值`
      //    时，**只有纯函数那条用例变红**，本文件其余全绿 ⇒ 接线是零覆盖。
      //
      // ⚠️ 为什么 `Infinity` 是最危险的取值：它是最像「不封顶」的直觉写法，
      //    而 `setTimeout(fn, Infinity)` 会被 Node 钳成 **1 ms**
      //    （`TimeoutOverflowWarning: … was set to 1`）⇒ 每个账号瞬间
      //    `UNUSABLE` ⇒ 全部渠道不可见，且**零报错**（只有一条 stderr warning）。
      //
      // 判据：`Infinity` 归一化后是 8 秒 ⇒ 1 个挂死账号在 ~8 秒收工。
      // 若没归一化，它会在 ~1 ms 内返回（`elapsed` 远小于 1 秒）。
      stubHangingFetch()
      const probe = createExpiryProbe(poolOfAccounts(1), async () => 'deepseek-v4.1-flash', {
        budgetMs: Number.POSITIVE_INFINITY,
      })
      const startedAt = Date.now()
      const value = await probe('lobsterai')
      const elapsed = Date.now() - startedAt
      expect(value).toBe(UNUSABLE)
      expect(
        elapsed,
        'Infinity 若未归一化，setTimeout 会被钳成 1ms ⇒ 这里会看到 < 1000ms',
      ).toBeGreaterThan(EXPIRY_PROBE_MIN_SLICE_MS)
      expect(elapsed, '归一化后应当走默认 8 秒预算').toBeLessThan(EXPIRY_PROBE_BUDGET_MS + 5_000)
    },
    EXPIRY_PROBE_BUDGET_MS + 10_000,
  )

  it(
    'budgetMs: 0 ⇒ 不封顶（升级前行为被保留）',
    async () => {
      stubHangingFetch()
      // ⚠️ 用**单个**账号：不封顶时它会吃满自己的 30 s 上游超时 ⇒ 断言「没有在 8 s 内结束」。
      //    初版用 2 个账号 = 60 s，在 CI 上白等一分钟；1 个就足以区分两种语义。
      const probe = createExpiryProbe(poolOfAccounts(1), async () => 'deepseek-v4.1-flash', { budgetMs: 0 })
      const startedAt = Date.now()
      await probe('lobsterai')
      expect(Date.now() - startedAt, 'budgetMs: 0 必须保留旧的「等到上游自己超时」语义')
        .toBeGreaterThan(EXPIRY_PROBE_BUDGET_MS)
    },
    90_000,
  )

  it('★★ expiryProbeSliceMs：`min(剩余预算, max(下限, 均分))` —— 逐格算术，与时钟无关', () => {
    // ⚠️⚠️ 本用例替代了一条**无牙**的耗时断言（2026-10-22 变异验证实测）：
    //    去掉 `min(剩余预算, …)` 只让 31 个账号的耗时从 8.01 s 变成 9.05 s，
    //    而**探测账号数完全相同** ⇒ 耗时断言要么无牙（容差 +5s）、要么时红时绿
    //    （容差 +1.2s）。抽成纯函数后判据是确定性的。
    //
    // 默认预算 8000、下限 1500：
    // - 31 个账号：均分 = 8000/31 = 258 < 下限 ⇒ 取 1500（下限保住「账号多也能探」）
    expect(expiryProbeSliceMs(8_000, 8_000, 31), '均分 258 < 下限 ⇒ 取下限').toBe(1_500)
    // - 3 个账号：均分 = 2666 > 下限 ⇒ 取均分
    expect(expiryProbeSliceMs(8_000, 8_000, 3)).toBe(2_666)
    // - 2 个账号：均分 = 4000
    expect(expiryProbeSliceMs(8_000, 8_000, 2)).toBe(4_000)
    // - 1 个账号：拿到全部剩余
    expect(expiryProbeSliceMs(8_000, 8_000, 1)).toBe(8_000)
    /**
     * ★ **下限不得透支预算**（`min(剩余预算, …)` 那一腿）—— 这是本函数最要紧的一格。
     *
     * 剩余预算 300 ms、还剩 5 个账号：`max(下限 1500, 均分 60)` = 1500，但**剩余只有
     * 300** ⇒ 必须被 `min` 压回 **300**。没有 `min` 时会给 1500 ⇒ 每个账号都能
     * 「续命」超出预算 ⇒ 总耗时 = 账号数 × 下限（我第一版实测 31 × 1.5 = 46.8 s）。
     */
    expect(expiryProbeSliceMs(8_000, 300, 5), '剩余 300 < 下限 1500 ⇒ 取剩余（不得透支）')
      .toBe(300)
    expect(expiryProbeSliceMs(8_000, 100, 20), '剩余 100 ⇒ 只能给 100').toBe(100)
    // ⚠️ 剩余为负时（理论上外层 `break` 已拦，但纯函数必须自洽）：`min` 会给负数 ⇒
    //    调用方靠 `remaining <= 0` 的 break 兜住，本函数只需「不放大」。
    expect(expiryProbeSliceMs(8_000, -5, 3)).toBeLessThanOrEqual(0)
    // - `budgetMs: 0`（不封顶）⇒ 恒 Infinity，与剩余/账号数无关
    expect(expiryProbeSliceMs(0, 0, 31)).toBe(Number.POSITIVE_INFINITY)
    expect(expiryProbeSliceMs(0, -999, 1)).toBe(Number.POSITIVE_INFINITY)
    // - 剩余为 Infinity（`budgetMs: 0` 之外的防御）不得产出 NaN
    expect(Number.isNaN(expiryProbeSliceMs(8_000, Number.POSITIVE_INFINITY, 4))).toBe(false)
  })

  it('★★ 31 个账号全挂 ⇒ 总时长**仍有界**（下限不得透支预算）', async () => {
      // ⚠️ 我第一版加「每份下限」时漏了 `min(剩余预算, …)`，实测 31 个账号跑了
      //    **46.8 秒**（= 31 × 1.5 s）—— 预算形同虚设。本用例锁住总上界。
      // ⚠️ **计数必须打在「取号」上，不能打在 fetch 上**：`lobsterai` 折算先查共享
      //    余额缓存（`fetchBalanceWithCache`），缓存未注入时它仍会走自己的取数，
      //    但**被预算截断的账号根本走不到取数** ⇒ fetch 计数会是 0（实测踩到）。
      //    取号（`listAvailableCredentials` 之后的逐个折算）才是「这个账号有没有被问过」。
      let probed = 0
      stubHangingFetch()
      const countingPool = {
        disabledModelsFor: () => new Set<string>(),
        listAvailableCredentials: async () => Array.from({ length: 31 }, (_, index) => ({
          entry: { id: `acc-${index}` },
          credential: { access_token: `t${index}`, expires_at: '' },
        })),
        getAvailableAccount: async () => { throw new Error('不应走单账号回退路径') },
      } as never
      // 用 `firstModelIdOf` 计「本轮真的开始了几个账号的折算」是不可行的（它只调一次），
      // 故改为在 fetch 桩里计数 —— 但必须先关掉共享读数缓存，让每次折算都真发请求。
      vi.stubGlobal('fetch', ((_input: unknown, init?: { signal?: AbortSignal }) => {
        probed += 1
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      }) as unknown as typeof fetch)
      const probe = createExpiryProbe(countingPool, async () => 'deepseek-v4.1-flash')
      const startedAt = Date.now()
      const value = await probe('lobsterai')
      const elapsed = Date.now() - startedAt
      expect(value).toBe(UNUSABLE)
      /**
       * ⚠️⚠️ 本条**只守「总时长有界」**，不再断言「探测账号数」。
       *
       * 变异验证实测（2026-10-22）：去掉 `min(剩余预算, …)` 后，31 个账号的
       * **探测账号数完全相同**（都是 6 个）—— 差异只体现在总耗时（8.01 s → 9.05 s）。
       * ⇒ 「账号数」判据对那条缺陷**无牙**，我一度写了它并以为有牙。
       *
       * 算术正确性改由 `expiryProbeSliceMs` 的**纯函数逐格用例**锁死（确定性、
       * 与时钟无关）；本条只留「总时长仍在预算量级」这个粗粒度上界，容差取
       * 1.5 s（两态差 1.05 s，留 0.45 s 抖动余量 —— 若 CI 上抖，放宽到 2 s 仍能
       * 抓住「46.8 s」那种量级错误）。
       */
      expect(probed, '至少探了一个账号（不是零探测）').toBeGreaterThan(0)
      expect(elapsed, '总时长仍应在预算量级（初版缺陷是 46.8 s）')
        .toBeLessThan(EXPIRY_PROBE_BUDGET_MS + 1_500)
    },
    EXPIRY_PROBE_BUDGET_MS + 10_000,
  )

  it(
    '★ 第 1 个账号成功、其余挂死 ⇒ 返回第 1 个的真实到期时刻，不判 UNUSABLE',
    async () => {
      const expiry = Date.now() + 86_400_000
      let call = 0
      vi.stubGlobal('fetch', ((_input: unknown, init?: { signal?: AbortSignal }) => {
        call += 1
        if (call === 1) return Promise.resolve(lobsteraiCreditsResponse(expiry))
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      }) as unknown as typeof fetch)

      const probe = createExpiryProbe(poolOfAccounts(7), async () => 'deepseek-v4.1-flash')
      const startedAt = Date.now()
      const value = await probe('lobsterai')
      const elapsed = Date.now() - startedAt

      expect(value, '已成功的账号仍是有效观测 —— 不能把整个渠道剔掉').toBe(expiry)
      expect(elapsed, '仍然必须在预算附近收工').toBeLessThan(EXPIRY_PROBE_BUDGET_MS + 5_000)
    },
    EXPIRY_PROBE_BUDGET_MS + 10_000,
  )

  it(
    '★★ 在 await 期间取消 ⇒ 立刻抛 AbortError，且**不写缓存**（既有缺陷回归）',
    async () => {
      // ⚠️ 这是**既有缺陷**（非本 PR 引入，但修法落在 `withinBudget` 里）：`credentialExpiry`
      //    的签名没有 `signal`，各 `*Expiry` 用自己的 30 s 超时 ⇒ 取消发生在 await
      //    期间时，循环顶部的 `throwIfAborted()` 与 catch 里的两条**都看不到它**
      //    ⇒ 等满超时后返回 `UNUSABLE` 并缓存 60 秒（用户取消一次 = 渠道消失 60 秒，
      //    且报错是「请先登录」式的误导）。
      //    ⚠️ 既有那条「★ 中止不得被缓存」绿是因为它走的是**入口已标记**的早退分支，
      //       恰好绕过这一格 —— 典型的「守卫有牙但咬不到这一格」。
      stubHangingFetch()
      const probe = createExpiryProbe(poolOfAccounts(1), async () => 'deepseek-v4.1-flash')
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 100)
      const startedAt = Date.now()
      await expect(probe('lobsterai', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
      expect(Date.now() - startedAt, '取消必须在毫秒级生效，不得等满上游超时').toBeLessThan(2_000)
      // ⚠️ 中止不得留下缓存条目：后续（未中止的）调用必须**重新**探测。
      let refetched = 0
      vi.stubGlobal('fetch', (() => {
        refetched += 1
        return Promise.resolve(lobsteraiCreditsResponse(Date.now() + 86_400_000))
      }) as unknown as typeof fetch)
      const value = await probe('lobsterai')
      expect(refetched, '中止留下的 UNUSABLE 若被缓存，这里会是 0 次请求').toBeGreaterThan(0)
      expect(Number.isFinite(value), '取消后重探必须拿到真实观测值，不是缓存的 UNUSABLE').toBe(true)
    },
    20_000,
  )
})

/**
 * ⚠️⚠️ `sharedPackageExpiry` 的到期判据必须与 `src/buddy-balance-rank.ts` 的
 * `splitBuddyCreditsByExpiry` **同一份**（2026-11-01 四审）。
 *
 * ## 为什么要单独守
 *
 * 本函数曾只认 `typeof pkg.deductionEndTime === 'number'`，而面板那一侧
 * （`plugin-src/client/credit-expiry.js:packageExpiryMs`）与后端选号那一侧
 * （`splitBuddyCreditsByExpiry`）都已在三审收窄成「**number 或数字字符串**」。
 * 三者对同一份 `state.json` 给出不同答案：
 *
 * - 面板：「3 天后到期」⇒ 临期（红）；
 * - 聚合轮换：判「未知」⇒ `NEVER` ⇒ 当作长期、**排到最后**；
 *
 * 后果是「用户看到马上作废，自动选择却把它压在最后」。这正是本仓红线
 * 「同一语义不得两套判据」的最典型形态。
 *
 * ## 可达性如实标注
 *
 * **结构可达、生产零实测**：目前所有 `CreditPackage` 生产者都写 number。
 * 触发面是**外部写入**（`state.json` 手改 / 备份导入 / 旧缓存里的
 * `"1791072000000"`），以及将来任何一家从 JSON 直取的实现。
 *
 * ## 判别力
 *
 * 三条用例分别钉「数字字符串算数值」「与 number 等价」「真不可解析才算未知」。
 * 把 `endIsNumeric` 退回 `typeof end === 'number'` ⇒ 前两条**必红**（第三条仍绿，
 * 它本来就是「不可解析」的正例）。
 */
describe('★★ sharedPackageExpiry：数字字符串的到期时间必须与 number 同判（四审）', () => {
  const pkg = (deductionEndTime: unknown) => ({
    name: '限时积分',
    remaining: 100,
    total: 100,
    used: 0,
    active: true,
    deductionEndTime,
  })

  const expiryOf = async (deductionEndTime: unknown) =>
    await lobsteraiExpiry(
      { access_token: 't' } as never,
      LOBSTERAI,
      async () => ({ total: 100, remaining: 100, packages: [pkg(deductionEndTime)] }) as never,
    )

  /**
   * ⚠️ 用**未来**时刻：`sharedPackageExpiry` 内部取 `Date.now()`，而 2026-11-02 起
   * 「已作废」的额度被排除（对抗审计 B1）⇒ 写死的历史时刻会变成 UNUSABLE。'
   */
  const FUTURE_AT = Date.now() + 3 * 86_400_000

  it('★★ 数字字符串到期时刻 ⇒ 当临期折算，不是 NEVER', async () => {
    const at = await expiryOf(String(FUTURE_AT))
    expect(at, '字符串被当「未知」⇒ 返回 NEVER，聚合会把它排到最后').toBe(FUTURE_AT)
    expect(at === NEVER, 'NEVER 的语义是「可用但无临期」，与本意相反').toBe(false)
  })

  it('★ 同一个时刻用 number 与字符串给出**完全相同**的结果', async () => {
    const asNumber = await expiryOf(FUTURE_AT)
    const asString = await expiryOf(String(FUTURE_AT))
    expect(asString).toBe(asNumber)
  })

  it('★ 真不可解析（`true` / 非数字串 / 0）才算「未知」⇒ NEVER', async () => {
    for (const bogus of [true, 'abc', 0, null]) {
      expect(await expiryOf(bogus), `${String(bogus)} 不应被当成有效到期时刻`).toBe(NEVER)
    }
  })
})


describe('已作废额度不得让渠道「看起来可用」（对抗审计 B1）', () => {
  const pastPkg = () => ({
    name: 'p', unit: 'u', remaining: 100, total: 100, used: 0, active: true,
    cycleStartTime: '', cycleEndTime: '', expiredTime: '',
    deductionEndTime: Date.now() - 3 * 86_400_000,
  })

  it('★ 只剩已作废批次 ⇒ UNUSABLE（不再返回过去时刻、更不再被排最前）', async () => {
    const at = await lobsteraiExpiry(
      { access_token: 't' } as never,
      LOBSTERAI,
      async () => ({ total: 100, remaining: 100, packages: [pastPkg()] }) as never,
    )
    expect(at).toBe(UNUSABLE)
  })

  it('★ 已作废 + 真临期 ⇒ 只取真临期那个时刻', async () => {
    const future = Date.now() + 3 * 86_400_000
    const at = await lobsteraiExpiry(
      { access_token: 't' } as never,
      LOBSTERAI,
      async () => ({
        total: 200, remaining: 200,
        packages: [pastPkg(), { ...pastPkg(), deductionEndTime: future }],
      }) as never,
    )
    expect(at).toBe(future)
  })
})
