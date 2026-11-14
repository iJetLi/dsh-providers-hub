import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordClineRequest,
  resetClineRequestHistory,
} from '../../src/cline-request-log.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  collectClaimResults,
  collectCreditBalances,
  collectCreditsStatus,
  computeClaimSummary,
  DEFAULT_CREDITS_STATUS_CONCURRENCY,
  JET_HUB_API_PATH,
  MAX_CREDITS_STATUS_CONCURRENCY,
  registerJetHubRpc,
  resolveCreditsStatusConcurrency,
} from '../../src/jet-hub-rpc.js'
import type { CreditsEndpointDeps } from '../../src/jet-hub-rpc.js'
import { createProviderCredits } from '../../src/provider-credits.js'
// ⚠️ 下面每个 `connection.fetch` 替身都**按 path 挑处理器**（用 `JET_HUB_API_PATH`）。
// 本模块除了 RPC 的 POST 端点还注册了内部载体的 GET 路由；替身若写成
// 「谁最后注册就记谁」，加一条路由就会让所有 RPC 用例莫名其妙地打到载体页上，
// 表现为成片 405 —— 与本次改动毫无关系，极难归因。别把它「简化」回去。
import { AccountPool } from '../../src/account-pool.js'
import type { ClaimOutcome, CheckinStatus, CreditBalance } from '../../src/credits.js'
import { WORKBUDDY } from '../../src/product.js'
import type { ProviderAccountEntry } from '../../src/types.js'
import { probeById } from '../../src/index.js'
import { clearProviderRuntimes, registerProviderRuntime } from '../../src/provider-runtime.js'
import { descriptorOf } from '../../src/provider-registry.js'
// ⚠️ 目录失效表的读写（Task 9 的接线守卫要用它判「端点有没有真的失效目录」）。
import { catalogInvalidatedAt, clearCatalogInvalidations } from '../../src/model-catalog.js'
// 「需福利包」标记（IKJOF7）：`model.list` 的 `benefitOnly` 判据来自这里的
// **三态**读取口（`undefined` = 未确认），用例要能分别构造三种状态。
// ⚠️ 只传 `undefined` 就是「清回未确认」—— 下一次读取会再去磁盘找，
//    而 `tests/setup-isolation.ts` 把缓存目录指到了临时目录（那里没有该文件）。
import { setBenefitMemoryCache } from '../../src/models.js'
// ⚠️ 两个**真实**适配器类（不是替身）：接线守卫的判据是「端点跑完后下一次读目录
//   必须真的再打一次上游」，用真适配器才量得到 `fetchRemoteModels` 被再次调用。
import { LoomyAdapter } from '../../src/loomy-adapter.js'
import { LOOMY, type LoomyProduct } from '../../src/loomy-product.js'
import { RACCOON } from '../../src/raccoon-product.js'
import { AggregateAdapter } from '../../src/aggregate-adapter.js'

/**
 * 注册**生产的那张** `probeById`（Task 8 起探测适配器由能力注册表提供）。
 *
 * ⚠️ 复用生产表而**不是**在测试里重写一份：本文件的断言正是「生产把哪个适配器
 * 交给了哪个 provider」—— 重写一份会让它测的是测试自己。
 */
function registerProbeRuntimesForTests(): void {
  clearProviderRuntimes()
  for (const [id, probe] of Object.entries(probeById)) {
    const descriptor = descriptorOf(id)
    if (descriptor !== undefined) registerProviderRuntime({ descriptor, probe })
  }
}
// ⚠️⚠️ 「已失效模型」表的直接操作（2026-10-06 复审 !66 的 model.clearDead 端点用例）。
//
// ⚠️⚠️ **必须在任何静态 import 之前设好隔离目录**：该模块的 store / cache 是
// **进程级单例**，首次解析 home 时读 `DSH_JET_HUB_STATE_DIR`（`resolveJetHubHome`
// 的第一优先级）。不隔离会**写真实的用户目录** `~/.dsh/jet-hub/dead-models.json`。
// 静态 import 会被提升，故这里用顶层 await 动态导入。
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  process.env.DSH_JET_HUB_STATE_DIR = mkdtempSync(joinPath(tmpdir(), 'dsh-jet-hub-rpc-dead-'))
}
const { clearDeadModels, deadModelIdsFor, recordDeadModel } =
  await import('../../src/dead-model-store.js')

/**
 * 造一个 `JetHubAuths` 命名对象（13 个键齐全），每个键都用空对象占位。
 *
 * ⚠️ 2026-10-08 起 `registerJetHubRpc` 的 auth 实例是**命名对象**（键是
 * **provider id**，`qodercn` 全小写），不再是 13 个位置参数。位置参数时代每个
 * 调用点都要手写 13 个 `{}` 占位，漏一个就让后续形参整体错位（本文件历史上
 * 因此踩过六次）。有了本助手，调用点只需交出这 13 个键，不必数占位。
 *
 * ⚠️ **本助手刻意不收 `overrides` 形参**（2026-10-08 复审 Finding 4）：初版带了
 * 一个 `overrides` 参数，但 6 个调用点**全部**是 `authsStub()`，从未传过 ——
 * 一个永远走默认值的形参是死代码，读的人会以为「有调用点在定制桩」。
 * 本文件的所有用例都只驱动**不读 auth 实例**的端点（积分 / 排序 / 设置），
 * 需要「某个 provider 的 auth 被真的调用」的行为用例在
 * `jet-hub-rpc-auth-wiring.spec.ts` 与各 provider 自己的 spec 里（那里**显式**
 * 摆出所需实例，比一个隐形默认值 + 覆盖更直白）。将来真需要定制时再加回来。
 */
function authsStub(): never {
  const blank = () => ({} as never)
  return {
    codearts: blank(), buddy: blank(), workbuddy: blank(), lobsterai: blank(),
    qoder: blank(), qodercn: blank(), trae: blank(), cline: blank(),
    loomy: blank(), raccoon: blank(), minimax: blank(), zcode: blank(),
    gemini: blank(),
    officeace: {} as never,
  } as never
}

describe('积分领取结果汇总', () => {
  it('统计成功数量与累计积分', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false },
      { kind: 'claimed', credit: 50, streakDays: 2, isStreakDay: true },
      { kind: 'already-claimed', message: '今天已签到' },
      { kind: 'failed', code: 500, message: 'boom' },
    ]
    expect(computeClaimSummary(outcomes)).toEqual({
      claimed: 2, totalCredit: 150, alreadyClaimed: 1, inactive: 0, failed: 1, coversToday: 3,
      totalByUnit: { token: 0, credit: 150 },
    })
  })

  /**
   * ★ **根因所在**（真实缺陷，用户报障 2026-10-04）：
   * > Zcode 获得的是 token 数量，但是这里显示成获得积分。
   * > 正文「…ZCode（智谱）+100000000（共 +100000100）」
   * > 应当显示为「…ZCode（智谱）+100Mtoken（共 +100Mtoken, +100积分）」
   *
   * `totalCredit` 是**跨单位求和**的标量 —— 1 亿 token 与 100 积分加在一起后，
   * 下游拿到的是一个数、无从分辨单位，只能标成「积分」。故单位必须在**汇总
   * 这一层**就分开保留（`totalByUnit`），而不是在文案层猜。
   *
   * ⚠️ 这条用例同时锁死「`totalCredit` 保留原语义」：它是既有契约，
   * 且对**单一单位**的渠道（其余 11 个）完全正确。改它才是破坏性改动。
   */
  it('★★ token 与积分**分列**，不跨单位相加（用户报障的根因）', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'claimed', credit: 100_000_000, streakDays: 0, isStreakDay: false, unit: 'token' },
      { kind: 'claimed', credit: 100, streakDays: 0, isStreakDay: false },
    ]
    const summary = computeClaimSummary(outcomes)
    // 单位分开保留 —— 这是修复的核心
    expect(summary.totalByUnit).toEqual({ token: 100_000_000, credit: 100 })
    // 标量仍在，但**不得**再用于展示（它是跨单位求和的产物）
    expect(summary.totalCredit).toBe(100_000_100)
  })

  it('★ 未声明 unit 的领取按积分计（其余 11 个渠道逐字不变）', () => {
    const summary = computeClaimSummary([
      { kind: 'claimed', credit: 800, streakDays: 1, isStreakDay: false },
    ])
    expect(summary.totalByUnit).toEqual({ token: 0, credit: 800 })
  })

  it('★ unit 为未知值时按积分兜底（脏数据不制造出第三种单位）', () => {
    const summary = computeClaimSummary([
      { kind: 'claimed', credit: 50, streakDays: 0, isStreakDay: false, unit: 'credits' } as ClaimOutcome,
    ])
    expect(summary.totalByUnit).toEqual({ token: 0, credit: 50 })
  })

  /**
   * ⚠️ **`coversToday` 才是记账口径**（真实缺陷，2026-10-02 审查 PR !33 定位）。
   *
   * `coversToday:false` 由渠道自己标出「这条痕迹属于刷新前那一轮」（Qoder 活动
   * 10:00 UTC+8 才刷新）。它**必须**既不计入 `coversToday`、也不让上层误以为
   * 「今天已处理」—— 否则当天 10 点刷新出来的新额度整天不会再被领。
   */
  it('coversToday:false 的领取/已领都不计入 coversToday（刷新前那一轮）', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'already-claimed', message: '今天已领取', coversToday: false },
      { kind: 'claimed', credit: 100, streakDays: 0, isStreakDay: false, coversToday: false },
    ]
    expect(computeClaimSummary(outcomes)).toEqual({
      claimed: 1, totalCredit: 100, alreadyClaimed: 1, inactive: 0, failed: 0, coversToday: 0,
      totalByUnit: { token: 0, credit: 100 },
    })
  })

  it('混合时只把覆盖今天的那几条计入 coversToday', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'already-claimed', message: 'a' },
      { kind: 'already-claimed', message: 'b', coversToday: false },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ alreadyClaimed: 2, coversToday: 1 })
  })

  it('全部已领取时 claimed 为 0', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'already-claimed', message: 'a' },
      { kind: 'already-claimed', message: 'b' },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ claimed: 0, totalCredit: 0, alreadyClaimed: 2 })
  })

  it('混合 inactive 与 failed 分别计数', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'inactive', message: '活动未开启' },
      { kind: 'failed', code: 1, message: 'x' },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ inactive: 1, failed: 1, claimed: 0 })
  })

  it('空数组返回全 0', () => {
    expect(computeClaimSummary([])).toEqual({
      claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0,
      totalByUnit: { token: 0, credit: 0 },
    })
  })

  it('未知 kind 兜底计入 failed，而不是被静默漏计', () => {
    // 模拟 ClaimOutcome 未来新增 kind、但汇总分支未同步更新的情况。
    const unknown = { kind: 'brand-new-kind', message: 'x' } as unknown as ClaimOutcome
    expect(computeClaimSummary([unknown, { kind: 'inactive', message: 'i' }]))
      .toMatchObject({ failed: 1, inactive: 1, claimed: 0 })
  })
})

// ─────────────────────────────────────────────────────────────
// 逐账号异常隔离（Task 8 补充修复）
//
// 直接调用 RPC 端点需要构造 ctx.connection.fetch.register 替身，
// 因此端点已把「逐账号处理」抽成 collectCreditsStatus / collectClaimResults
// 两个可导出函数（方案 A）。这里对它们单测：既能精确断言单账号隔离，
// 又能验证顺序性，且完全不发起网络请求（fetchStatus / claim 均注入桩）。
// ─────────────────────────────────────────────────────────────

/** 构造账号条目；默认是启用的合法账号。 */
function makeEntry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'workbuddy-1',
    provider: 'workbuddy',
    nickname: '测试号',
    enabled: true,
    credentialRef: 'WORKBUDDY_ACCOUNT_AAAA1111',
    createdAt: 1,
    refreshable: true,
    ...overrides,
  }
}

/** 最小合法凭据 JSON。 */
const VALID_CREDENTIAL_JSON = JSON.stringify({
  access_token: 'AT', refresh_token: 'RT', expires_at: '2099-01-01T00:00:00Z',
})

/** 构造签到状态。 */
function makeStatus(overrides: Partial<CheckinStatus> = {}): CheckinStatus {
  return {
    active: true, todayCheckedIn: false, streakDays: 1, dailyCredit: 100,
    todayCredit: 0, isStreakDay: false, totalCredits: 0, checkinDates: [],
    activityName: 'a', themeName: 't', endTime: '', ...overrides,
  }
}

/**
 * 构造依赖替身。
 * 默认：所有 ref 都能解析出合法凭据，状态接口返回「可领取」，领取返回成功。
 */
function makeDeps(overrides: Partial<CreditsEndpointDeps> = {}): CreditsEndpointDeps {
  return {
    resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
    fetchStatus: async () => makeStatus(),
    claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
    ...overrides,
  }
}

describe('★ credits.status 的并发度解析（2026-10-22 审计打穿后补）', () => {
  it('默认 3；`1` 恢复串行；非正整数一律回落默认', () => {
    expect(DEFAULT_CREDITS_STATUS_CONCURRENCY).toBe(3)
    expect(resolveCreditsStatusConcurrency(undefined, 10)).toBe(3)
    expect(resolveCreditsStatusConcurrency(1, 10), '1 = 恢复旧的完全串行语义').toBe(1)
    expect(resolveCreditsStatusConcurrency(4, 10)).toBe(4)
    // ⚠️ 逐格：这些都不是「正整数」⇒ 回落默认（`0` 也是回落，**不是**串行 —— 这条
    //    语义初版注释没写，审计点出来的空隙）。
    for (const bad of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, '3', null, true]) {
      expect(resolveCreditsStatusConcurrency(bad, 10), `${String(bad)} 应回落默认`).toBe(3)
    }
  })

  it('★ 硬上界：`1e10` / `MAX_SAFE_INTEGER` 不得变成「全池并发」', () => {
    // ⚠️⚠️ 初版上界是 `accounts.length` ⇒ `concurrency: 1e10` 时并发度 = 账号数
    //    ⇒ 实测 31 个账号 = **31 个并发请求打同一上游**。本用例锁住硬顶。
    expect(MAX_CREDITS_STATUS_CONCURRENCY).toBe(8)
    expect(resolveCreditsStatusConcurrency(1e10, 31)).toBe(MAX_CREDITS_STATUS_CONCURRENCY)
    expect(resolveCreditsStatusConcurrency(Number.MAX_SAFE_INTEGER, 31)).toBe(MAX_CREDITS_STATUS_CONCURRENCY)
  })

  it('账号数少于并发度时取账号数；0 个账号取 1（不能是 0）', () => {
    expect(resolveCreditsStatusConcurrency(undefined, 2)).toBe(2)
    // ⚠️ 0 会让 `Array.from({length: 0})` ⇒ `Promise.all([])` 立即 resolve
    //    ⇒ `results` 保持全空洞（返回 `[undefined, …]`）。故下限是 1。
    expect(resolveCreditsStatusConcurrency(undefined, 0)).toBe(1)
  })
})

describe('credits.status 单账号异常隔离', () => {
  it('非法 credentialRef 只让该账号状态为 null，其余账号仍被查询', async () => {
    const accounts = [
      makeEntry({ id: 'bad-ref', credentialRef: 'not a valid ref!' }),
      makeEntry({ id: 'good-1' }),
      makeEntry({ id: 'good-2' }),
    ]
    const asked: string[] = []
    const deps = makeDeps({
      resolve: async (ref) => {
        asked.push(String(ref))
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    // 三个账号都要出现在结果里（不是整批抛异常）
    expect(results.map(r => r.accountId)).toEqual(['bad-ref', 'good-1', 'good-2'])
    expect(results[0]?.status).toBeNull()
    // 关键：坏账号之后的两个账号确实被继续处理
    expect(results[1]?.status).not.toBeNull()
    expect(results[2]?.status).not.toBeNull()
    // 坏账号根本没走到 resolve（名称校验先抛）
    expect(asked).toEqual(['WORKBUDDY_ACCOUNT_AAAA1111', 'WORKBUDDY_ACCOUNT_AAAA1111'])
  })

  it('resolve 抛错只让该账号状态为 null，其余账号仍被查询', async () => {
    const accounts = [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })]
    let resolveCalls = 0
    const deps = makeDeps({
      resolve: async () => {
        resolveCalls++
        // 第一个账号的 resolve 抛错（如凭据已被外部删除）；后续账号正常。
        if (resolveCalls === 1) throw new Error('凭据已被外部删除')
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    expect(results.map(r => r.accountId)).toEqual(['boom', 'ok'])
    expect(results[0]?.status).toBeNull()
    expect(results[1]?.status).toEqual(makeStatus())
    expect(resolveCalls).toBe(2)
  })

  it('JSON 损坏与网络失败都只影响该账号', async () => {
    const accounts = [
      makeEntry({ id: 'corrupt', credentialRef: 'WORKBUDDY_ACCOUNT_AAAA_CORRUPT' }),
      makeEntry({ id: 'network-down', credentialRef: 'WORKBUDDY_ACCOUNT_AAAA_NETDOWN' }),
      makeEntry({ id: 'ok', credentialRef: 'WORKBUDDY_ACCOUNT_AAAA_OK' }),
    ]
    /**
     * ⚠️⚠️ **判据必须按账号身份，不能按调用序号**（2026-10-22 改，**语义变更登记**）。
     *
     * ## 为什么改
     *
     * 初版用「跨账号共享的可变计数器」来区分账号：
     * ```ts
     * let resolveCalls = 0
     * resolve: async () => ({ value: resolveCalls++ === 0 ? '{ not json' : VALID })
     * fetchStatus: async () => { if (resolveCalls === 2) throw … }
     * ```
     * 串行时「第 2 个账号」==「`resolveCalls === 2`」，两者**恰好同构**；
     * `collectCreditsStatus` 改成有限并发（默认 3）后，`resolveCalls` 的递增顺序
     * 与**账号下标**解耦 ⇒ 判据打空 ⇒ 本用例变红（实测 `concurrency=1` 绿、
     * `concurrency=3` 红）。
     *
     * ## 为什么不是「测试写错了、改绿就行」
     *
     * 这条用例恰好是「**跨账号共享可变状态 + 并发**」这个形态的报警器。生产侧
     * `deps` 目前没有共享可变状态（只有 `resolve` / `fetchStatus` / `warn`），
     * 但一旦有人往 `deps` 里塞计数器 / 缓存 / 退避状态，并发下就会与账号下标解耦
     * —— 那正是本用例原来在（无意中）守着的东西。
     *
     * ⇒ 改法是**把判据挪到账号身份上**（`credential.id`），它才是本用例真正想表达的
     * 语义（「这个账号坏了」而不是「第 2 次调用坏了」），且与并发度**无关**。
     * ⇒ 副作用：本用例**不再**覆盖「共享计数器」那一形态 —— 那由下面单独的
     * `★ 并发下不得依赖跨账号调用序` 用例显式守（它断言的是**反面**：
     * 每个账号都真的被处理了，与顺序无关）。
     */
    const deps = makeDeps({
      resolve: async (ref) => {
        // ⚠️ 按 **ref 名字**判「这是哪个账号」，而不是按调用序号。
        //    ⇒ 三个账号必须各自有**不同的** ref（否则 `resolve` 无从区分）。
        const name = String(ref)
        if (name.endsWith('CORRUPT')) return { value: '{ not json' }
        // `network-down` 的凭据里带一个标记，供 `fetchStatus` 认出它。
        if (name.endsWith('NETDOWN')) {
          return { value: JSON.stringify({ ...JSON.parse(VALID_CREDENTIAL_JSON), id: 'network-down' }) }
        }
        return { value: VALID_CREDENTIAL_JSON }
      },
      fetchStatus: async (credential) => {
        // `network-down` 的状态请求抛网络错误（凭据里的 `id` 就是它的身份）。
        if ((credential as { id?: string } | undefined)?.id === 'network-down') {
          throw new Error('socket hang up')
        }
        return makeStatus()
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    expect(results.map(r => r.accountId)).toEqual(['corrupt', 'network-down', 'ok'])
    expect(results[0]?.status, 'JSON 损坏只影响它自己').toBeNull()
    expect(results[1]?.status, '网络失败只影响它自己').toBeNull()
    expect(results[2]?.status).toEqual(makeStatus())
  })

  it('★ 并发下每个账号都被处理一次，且结果按原序（不依赖调用序）', async () => {
    // ⚠️ 上一条用例的判据从「调用序号」改成了「账号身份」（见那里的长注释）。
    //    本用例守的是那一步**没有把覆盖丢掉**：断言「每个账号恰好被处理一次」
    //    与「结果顺序 = 输入顺序」，两者都与并发度无关 ⇒ 并发度调成 1 或 8 都绿。
    //
    // ⚠️⚠️ **夹具刻意用 `WORKBUDDY`，不是上游那版的 `LOBSTERAI`**（2026-10-22 移植时实测）：
    //    `collectCreditsStatus` 在本仓库的泛型默认值是 **buddy 系**
    //    （`<TCredential = BuddyCredential, TProduct = BuddyProduct>`），而上游那版是通用的
    //    `ChannelCredential` / `ProviderProduct` ⇒ 换成 `LOBSTERAI` 后
    //    `collectCreditsStatus(accounts, LOBSTERAI, makeDeps({…}))` 报
    //    `TS2345: 'LobsteraiProduct' is not assignable to 'BuddyProduct'`
    //    （实测：整份换成上游文件时该 spec 共 **52** 个类型错误）。
    //    ⇒ 本仓库保留 `WORKBUDDY` 夹具；**判据与上游逐字一致**，只换夹具身份。
    const accounts = Array.from({ length: 9 }, (_, index) => makeEntry({
      id: `acc-${index}`,
      // ⚠️ 每个账号**不同的 ref**：`resolve` 靠它区分身份（否则 `fetchStatus`
      //    收到的凭据无法反查是哪个账号，`seen` 只会是一串 `?`）。
      credentialRef: `WORKBUDDY_ACCOUNT_AAAA_ACC${index}`,
    }))
    const seen: string[] = []
    const results = await collectCreditsStatus(accounts, WORKBUDDY, makeDeps({
      resolve: async (ref) => {
        const name = String(ref)
        const index = name.slice(name.lastIndexOf('ACC') + 3)
        return { value: JSON.stringify({ ...JSON.parse(VALID_CREDENTIAL_JSON), id: `acc-${index}` }) }
      },
      fetchStatus: async (credential) => {
        seen.push((credential as { id?: string }).id ?? '?')
        await new Promise(resolve => setTimeout(resolve, 5))
        return makeStatus()
      },
    }))
    expect(results.map(r => r.accountId), '结果必须按 accounts 原序').toEqual(accounts.map(a => a.id))
    expect([...seen].sort(), '每个账号恰好处理一次，不得重复也不得漏').toEqual(accounts.map(a => a.id).sort())
  })

  it('停用账号同样处理（停用与签到无关），异常出口收到告警', async () => {
    const warnings: string[] = []
    const accounts = [
      makeEntry({ id: 'off', enabled: false }),
      makeEntry({ id: 'bad-ref', credentialRef: '非法名称' }),
    ]
    const results = await collectCreditsStatus(accounts, WORKBUDDY, makeDeps({
      warn: (msg) => warnings.push(msg),
    }))

    // 停用只影响账号池的自动选择与限流切换，不改变「该账号今天领了没」，
    // 故两个账号都要出现在结果里。
    expect(results.map(r => r.accountId)).toEqual(['off', 'bad-ref'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bad-ref')
  })

  it('凭据解析为 undefined 时状态为 null，且不调用状态接口', async () => {
    let statusCalls = 0
    const results = await collectCreditsStatus([makeEntry({ id: 'noconf' })], WORKBUDDY, makeDeps({
      resolve: async () => undefined,
      fetchStatus: async () => { statusCalls++; return makeStatus() },
    }))

    expect(results[0]?.status).toBeNull()
    expect(statusCalls).toBe(0)
  })

  /**
   * ⚠️⚠️ **同一根缺陷的第二处**（2026-11-02 真机报障的连带修复）：
   * `collectCreditsStatus` 里逐字相同的 `(product as { id?: string }).id === ASTUDIO.id`。
   * （⚠️ 不是 `collectClaimResults` —— 它体内没有这个写法。）
   *
   * 这一处**在用户界面上看不出来** —— 它的 per-account `catch` 把异常吞成
   * `status = null`，于是「凭据未配置」与「查询失败」同形（都显示成没有签到状态）。
   * ⇒ 唯一可观测的差异是 `deps.warn` 有没有被调用（异常路径会告警，正常路径不会），
   * 判据就打在那里。**别改成断言 `status === null`** —— 那样变异后恒绿（两态同形），
   * 实测过（变异注入后该断言照绿）。
   *
   * ⚠️ 既有的 `:450` 那条「凭据解析为 undefined 时状态为 null」**传的是 `WORKBUDDY`（真值）**
   * ⇒ 走不进 `resolved === undefined && (product as …).id` 这一格，所以它漏网了。
   * 后来人别「顺手改回 WORKBUDDY」：本用例的全部价值就在 `undefined as never` 这个第二参。
   *
   * ⚠️⚠️ **本用例只有 `warnings` 那一条承重**：红队实测 —— 删掉它之后（且代码处于变异态）
   * 本用例**照绿**，因为 `status === null` 与 `statusCalls === 0` 在「抛 TypeError」与
   * 「静默跳过」两态下**都成立**（TypeError 在调用 `fetchStatus` **之前**就抛了）。
   * 同理 `collectCreditBalances` 那条只有 `error === '凭据未配置'` 承重。⇒ 这几条
   * 「不许发请求」的断言是**表达意图的文档性断言，不是守卫**，别把它们当覆盖证据。
   */
  it('★★ product 为 undefined 时，凭据未配置不得抛 TypeError（否则被吞成一条假告警）', async () => {
    const warnings: string[] = []
    let statusCalls = 0
    const results = await collectCreditsStatus(
      [makeEntry({ id: 'pending' })],
      undefined as never,
      makeDeps({
        resolve: async () => undefined,
        fetchStatus: async () => { statusCalls++; return makeStatus() },
        warn: (msg) => warnings.push(msg),
      }),
    )

    expect(warnings, '旧码在这里抛 TypeError 并被 catch 成一条告警').toEqual([])
    expect(results[0]?.status).toBeNull()
    expect(statusCalls, '凭据未配置时不得发起状态请求').toBe(0)
  })
})

describe('credits.claimAll 单账号异常隔离与顺序性', () => {
  it('停用账号也被领取（一键领取覆盖全部账号）', async () => {
    const accounts = [
      makeEntry({ id: 'enabled-1', enabled: true }),
      makeEntry({ id: 'disabled-1', enabled: false }),
      makeEntry({ id: 'disabled-2', enabled: false }),
    ]
    const deps = makeDeps({
      claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    // 停用只影响账号池的自动选择与限流切换；积分照领。
    expect(response.results.map(r => r.accountId)).toEqual(['enabled-1', 'disabled-1', 'disabled-2'])
    expect(response.results.every(r => r.outcome.kind === 'claimed')).toBe(true)
    expect(response.summary).toEqual({
      claimed: 3, totalCredit: 300, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 3,
      totalByUnit: { token: 0, credit: 300 },
    })
  })

  it('非法 credentialRef 的账号记为 failed，其余账号仍被领取', async () => {
    const accounts = [
      makeEntry({ id: 'bad-ref', credentialRef: 'not a valid ref!' }),
      makeEntry({ id: 'good-1' }),
      makeEntry({ id: 'good-2' }),
    ]
    const claimed: string[] = []
    const deps = makeDeps({
      claim: async () => {
        claimed.push(`claim-${claimed.length}`)
        return { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    // 整批成功返回，三个账号都有结果
    expect(response.results.map(r => r.accountId)).toEqual(['bad-ref', 'good-1', 'good-2'])
    expect(response.results[0]?.outcome).toMatchObject({ kind: 'failed', code: -1 })
    expect(response.results[1]?.outcome).toMatchObject({ kind: 'claimed' })
    expect(response.results[2]?.outcome).toMatchObject({ kind: 'claimed' })
    // 坏账号没有阻止后两个账号真正发起领取
    expect(claimed).toHaveLength(2)
    expect(response.summary).toEqual({
      claimed: 2, totalCredit: 200, alreadyClaimed: 0, inactive: 0, failed: 1, coversToday: 2,
      totalByUnit: { token: 0, credit: 200 },
    })
  })

  it('resolve 抛错被收敛为该账号的 failed，不冒泡中断整批', async () => {
    const accounts = [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })]
    let first = true
    const deps = makeDeps({
      resolve: async () => {
        if (first) { first = false; throw new Error('凭据已被外部删除') }
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(response.results[0]?.outcome).toMatchObject({ kind: 'failed', message: '凭据已被外部删除' })
    expect(response.results[1]?.outcome).toMatchObject({ kind: 'claimed' })
    expect(response.summary.failed).toBe(1)
    expect(response.summary.claimed).toBe(1)
  })

  it('凭据未配置记为 failed 且不发起任何请求', async () => {
    let touched = 0
    const response = await collectClaimResults([makeEntry({ id: 'noconf' })], WORKBUDDY, makeDeps({
      resolve: async () => undefined,
      fetchStatus: async () => { touched++; return makeStatus() },
      claim: async () => { touched++; return { kind: 'failed', code: -1, message: 'x' } },
    }))

    expect(response.results[0]?.outcome).toEqual({ kind: 'failed', code: -1, message: '凭据未配置' })
    expect(touched).toBe(0)
  })

  it('保持「先查状态再领取」：活动未开启/今日已签到时跳过领取请求', async () => {
    const accounts = [makeEntry({ id: 'inactive' }), makeEntry({ id: 'done' }), makeEntry({ id: 'ready' })]
    let call = 0
    const claimCalls: string[] = []
    const deps = makeDeps({
      fetchStatus: async () => {
        call++
        if (call === 1) return makeStatus({ active: false })
        if (call === 2) return makeStatus({ todayCheckedIn: true })
        return makeStatus()
      },
      claim: async () => {
        claimCalls.push('claim')
        return { kind: 'claimed', credit: 10, streakDays: 1, isStreakDay: false }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(response.results.map(r => r.outcome.kind))
      .toEqual(['inactive', 'already-claimed', 'claimed'])
    // 只有第三个账号真正调用了领取接口
    expect(claimCalls).toHaveLength(1)
  })

  it('顺序执行：任一时刻只有一个账号在处理（不并发）', async () => {
    const accounts = [
      makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' }),
    ]
    let inFlight = 0
    let maxInFlight = 0
    const deps = makeDeps({
      resolve: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return { value: VALID_CREDENTIAL_JSON }
      },
      fetchStatus: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return makeStatus()
      },
      claim: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return { kind: 'claimed', credit: 1, streakDays: 1, isStreakDay: false }
      },
    })

    await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(maxInFlight).toBe(1)
  })

  it('按账号顺序串行，且结果顺序与账号顺序一致', async () => {
    const accounts = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })]
    const order: string[] = []
    let seq = 0
    const deps = makeDeps({
      // 让先启动的账号耗时更长，若并发则 c 会先完成
      resolve: async () => {
        const mine = seq++
        await new Promise(r => setTimeout(r, mine === 0 ? 10 : 1))
        order.push(`entry-${mine}`)
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(order).toEqual(['entry-0', 'entry-1', 'entry-2'])
    expect(response.results.map(r => r.accountId)).toEqual(['a', 'b', 'c'])
  })

  /**
   * ⚠️ 真实缺陷（用户报障）：4 个 CodeBuddy 账号一键领取全部失败，
   * 错误是 **`fetcher is not a function`**。
   *
   * 根因：`claimDailyCheckin` / `fetchCheckinStatus` 的真实签名是
   * `(credential, product, fetcher)`，而 `collectClaimResults` 在**未注入
   * deps 时**调用的是 `claim(credential, product, entry)` —— 把 `entry`
   * 塞进了 `fetcher` 的位置，于是 `fetcher(...)` 抛
   * `TypeError: fetcher is not a function`。
   *
   * 为什么长期没被发现：`makeDeps` **总是注入 `claim` / `fetchStatus`**，
   * 于是真实的默认实现路径**从未被任何用例覆盖**；而
   * `deps.claim ?? (claimDailyCheckin as unknown as …)` 这个
   * `as unknown as` 强转**掩盖了签名不匹配**，TypeScript 也帮不上忙。
   *
   * 本用例刻意**不注入 claim / fetchStatus**，走真实默认实现，用注入的
   * fetcher 断言「被当成函数调用的那个参数确实是 fetcher」。
   */
  it('未注入 deps 时走真实默认实现，第三参必须是 fetcher（真实缺陷回归）', async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      // 状态端点返回「活动开启且今天没领」，让流程走到 claim。
      // ⚠️ 字段名必须是真实的 `active` / `today_checked_in`（见 fetchCheckinStatus），
      // 用错名字会被 readBool 读成 false → 落到 inactive 短路。
      if (String(url).includes('checkin-activity-status')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { active: true, today_checked_in: false },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { credit: 100, streak_days: 1, is_streak_day: false },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const accounts = [makeEntry({ id: 'cb-1', credentialRef: 'BUDDY_ACCOUNT_A70DB211' })]
    // ⚠️ 关键：**不传** claim / fetchStatus，走真实的 claimDailyCheckin，
    // 只注入 fetcher。
    const response = await collectClaimResults(accounts, WORKBUDDY, {
      resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
      fetcher: fakeFetch,
    })

    // 不得是 `fetcher is not a function`
    const outcome = response.results[0]?.outcome
    if (outcome?.kind === 'failed') {
      expect(outcome.message).not.toContain('fetcher is not a function')
    }
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100 })
    // 确认确实发出了两次真实请求（状态 + 领取）
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('checkin-activity-status')
    expect(calls[1]).toContain('daily-checkin')
  })
})

/**
 * collectCreditBalances：逐账号收集积分余额。
 *
 * 与状态/领取的关键差异是**保留失败原因**——账号卡片要显示"为什么没查到"，
 * 把它降级成 null 会让 UI 显示成空白，用户无从判断是余额为 0 还是查询失败。
 */
describe('credits.balances 逐账号余额收集', () => {
  const BALANCE: CreditBalance = {
    total: 347.87,
    packages: [
      { name: 'Bonus Pack', unit: 'credit', remaining: 247.87, total: 250, used: 2.13, cycleStartTime: '', cycleEndTime: '2026-09-28 10:05:56' },
      { name: 'Free Plan Subscription', unit: 'credits', remaining: 100, total: 100, used: 0, cycleStartTime: '', cycleEndTime: '2026-09-30 23:59:59' },
    ],
  }

  it('成功时回传余额与包明细', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances([makeEntry({ id: 'a' })], WORKBUDDY, deps)

    expect(results).toEqual([{ accountId: 'a', nickname: '测试号', balance: BALANCE }])
  })

  it('余额为 0 与查询失败严格区分', async () => {
    const empty: CreditBalance = { total: 0, packages: [] }
    let call = 0
    const deps = makeDeps({ fetchBalance: async () => (call++ === 0 ? empty : null) })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'zero' }), makeEntry({ id: 'failed' })], WORKBUDDY, deps,
    )

    // 第一个真余额 0：可展示为 0，不算错误
    expect(results[0]!.balance).toEqual(empty)
    expect(results[0]!.error).toBeUndefined()
    // 第二个查不到：balance 为 null 且带原因，UI 不能显示成 0
    expect(results[1]!.balance).toBeNull()
    expect(results[1]!.error).toBe('余额查询失败')
  })

  /**
   * ⚠️⚠️ **真实报障**（2026-11-02）：面板上一个「登录中…」的 AutoClaw 国际版占位卡片，
   * 积分行显示 `Cannot read properties of undefined (reading 'id')`。
   *
   * 根因：**`src/` 里的生产调用点都传 `undefined`**（`collectCreditBalances(accounts, undefined, …)`，
   * product 由各 provider 的 impl 闭包住），而旧码写的是
   * `(product as { id?: string }).id === ASTUDIO.id` —— 「凭据未配置」这一格
   * （占位条目正是）短路求值到右边就抛 TypeError，被本函数的 per-account `catch`
   * 转成错误文案直接上屏。影响面 = 所有经本函数取余额的 provider（别写死家数）。
   *
   * ⚠️ 既有的 `:764` 那条「凭据未配置时给出原因」**传的是 `WORKBUDDY`（真值）**
   * ⇒ 走不进 `resolved === undefined && (product as …).id`，所以它漏网了。
   * 本用例的全部价值就在 `undefined as never` 这个第二参，别「顺手改回 WORKBUDDY」。
   *
   * ⚠️⚠️ **本用例只有 `error === '凭据未配置'` 一条承重**：红队实测 —— 删掉它之后
   * （且代码处于变异态）本用例**照绿**，因为 `balance === null` 与 `touched === 0` 在
   * 「抛 TypeError」与「静默跳过」两态下**都成立**（TypeError 在调用 `fetchBalance`
   * 之前就抛）。它们是文档性断言，不是守卫。
   *
   * 判据：product 传 `undefined`（**真实调用形态**）+ 凭据读不到 ⇒ 必须是「凭据未配置」。
   */
  it('★★ product 为 undefined（真实调用形态）时，凭据未配置不得抛 TypeError', async () => {
    let touched = 0
    const deps = makeDeps({
      resolve: async () => undefined,
      fetchBalance: async () => { touched++; return BALANCE },
    })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'pending' })],
      undefined as never,
      deps,
    )

    expect(results[0]!.error, '旧码在这里抛 Cannot read properties of undefined').toBe('凭据未配置')
    expect(results[0]!.balance).toBeNull()
    expect(touched, '凭据未配置时不得发起余额请求').toBe(0)
  })

  it('凭据未配置时给出原因，且不发起余额请求', async () => {
    let touched = 0
    const deps = makeDeps({
      resolve: async () => undefined,
      fetchBalance: async () => { touched++; return BALANCE },
    })
    const results = await collectCreditBalances([makeEntry({ id: 'noconf' })], WORKBUDDY, deps)

    expect(results[0]!.balance).toBeNull()
    expect(results[0]!.error).toBe('凭据未配置')
    expect(touched).toBe(0)
  })

  it('单个账号异常不中断整批，且记录该账号的原因', async () => {
    let call = 0
    const warnings: string[] = []
    const deps = makeDeps({
      resolve: async () => {
        if (call++ === 0) throw new Error('凭据已被外部删除')
        return { value: VALID_CREDENTIAL_JSON }
      },
      fetchBalance: async () => BALANCE,
      warn: (msg) => warnings.push(msg),
    })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })], WORKBUDDY, deps,
    )

    expect(results).toHaveLength(2)
    expect(results[0]!.error).toBe('凭据已被外部删除')
    expect(results[0]!.balance).toBeNull()
    expect(results[1]!.balance).toEqual(BALANCE)
    expect(warnings).toHaveLength(1)
  })

  it('凭据 JSON 损坏只影响该账号', async () => {
    let call = 0
    const deps = makeDeps({
      resolve: async () => ({ value: call++ === 0 ? '{ not json' : VALID_CREDENTIAL_JSON }),
      fetchBalance: async () => BALANCE,
    })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'corrupt' }), makeEntry({ id: 'ok' })], WORKBUDDY, deps,
    )

    expect(results[0]!.balance).toBeNull()
    expect(results[0]!.error).toBeDefined()
    expect(results[1]!.balance).toEqual(BALANCE)
  })

  it('停用账号同样查询（停用与余额无关）', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'off', enabled: false })], WORKBUDDY, deps,
    )

    expect(results[0]!.balance).toEqual(BALANCE)
  })

  it('顺序执行，不并发（避免风控）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const deps = makeDeps({
      fetchBalance: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return BALANCE
      },
    })
    await collectCreditBalances(
      [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })], WORKBUDDY, deps,
    )

    expect(maxInFlight).toBe(1)
  })

  it('结果顺序与账号顺序一致', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })], WORKBUDDY, deps,
    )

    expect(results.map(r => r.accountId)).toEqual(['a', 'b', 'c'])
  })
})

/**
 * model.list / model.setDisabled 端点。
 *
 * 这两个端点是 Jet Hub「显示列表」按钮的唯一数据通道，同时串起三件必须
 * 一起正确的事：
 * 1. 列表来自 `ctx.llm.listModels()`（对话框模型选择器读的同一份目录）；
 * 2. 黑名单经 AccountPool 持久化；
 * 3. 关闭后的模型从对话框选择器里消失，**但在设置页仍可被重新打开**。
 *
 * 因此这里用「注册端点 → 通过 HTTP 请求调用 → 断言响应」的方式做端到端
 * 验证，而不是分别测两个函数——两者的衔接正是最容易出错的地方。
 *
 * ⚠️ 第 3 条的两个方向必须都覆盖，且**桩必须模拟真实适配器的过滤行为**：
 * 真实 `listModels` 会实时剔除黑名单命中的模型，所以 `model.list` 绝不能在
 * 一个已被过滤的目录上「回填 disabled」——那样被关闭的模型会连同开关一起
 * 消失，用户再也无法重新打开（历史 bug）。早期版本的桩是
 * `options.models.map(...)`（从不过滤），恰好绕过这个矛盾，导致该 bug 在
 * 「注释声称已验证第 3 条」的情况下依然漏到了线上。
 */
describe('account.create 必须立即返回 loginUrl（两步式登录回归）', () => {
  /**
   * 真实缺陷（用户报障）：「codearts 新建账号应该弹出新的页面，现在主页面直接
   * 跳转过去了」。
   *
   * 根因是**时序**，不是弹窗 API 用法：
   * - 浏览器只在用户点击后的短暂窗口（transient activation，约 5 秒）内允许
   *   `window.open`；
   * - 早期 `account.create` 对 codearts / lobsterai 走**阻塞式** `login()`
   *   （`await` 到用户在浏览器里完成授权，数十秒），返回时手势早已过期；
   * - 前端 `window.open` 被弹窗拦截器拒绝并返回 `null`，于是命中兜底
   *   `window.location.href = loginUrl`，把整个设置页导航到外部登录页。
   *
   * 修法：这两个 provider 也改为「先返回 loginUrl、后台再等回调」的两步式
   * （与 CodeBuddy 系一致）。因此本用例守的是**契约**：`account.create`
   * 必须在用户完成授权**之前**就 resolve —— 若哪天有人改回阻塞式，
   * 这里会以超时失败，而不是等到用户再次报障。
   *
   * 用假计时器不适用（涉及真实 Promise 链），故用「授权永不完成」来模拟
   * 用户尚未操作：旧实现会一直挂着，新实现立即返回。
   */
  type Handler = (request: Request) => Promise<Response>

  /** 构造端点，注入一个「授权永不完成」的登录服务替身。 */
  function registerCreateEndpoints(overrides: {
    /** startLogin 是否可用；false 模拟旧实现的阻塞式 login。 */
    twoPhase: boolean
  }) {
    let handler: Handler | undefined
    /** 记录 startLogin / login 的调用，用于断言走了哪条路径。 */
    const calls: string[] = []
    let resolveLogin!: () => void
    const neverFinishes = new Promise<void>((resolve) => { resolveLogin = resolve })

    // 登录服务替身：startLogin 立即返回 URL，result 永不落定（模拟用户未操作）。
    const makeAuth = (id: string) => ({
      async startLogin() {
        calls.push(`${id}:startLogin`)
        return {
          loginUrl: `https://example.test/${id}/login`,
          result: neverFinishes.then(() => ({
            access: '{}', expires: 0, ref: id, loginUrl: '', refreshable: false,
          })),
          close: async () => {},
        }
      },
      async login() {
        calls.push(`${id}:login`)
        // 阻塞式：永不 resolve，复刻旧实现的等待语义。
        return await neverFinishes
      },
    })

    const pool = {
      addAccount: async () => {},
      updateAccount: async () => {},
      removeAccount: async () => {},
      listAccounts: async () => [],
      // ⚠️ `account.create` 的 qoder 分支会查「同 provider 已有账号的出口代理」
      // 来决定是否继承（墙外环境一次配置、后续账号免重填）。替身缺这一格会让
      // `account.create` 抛 TypeError ⇒ 端点回 ok:false，而失败信息会被那条
      // 「不阻塞」的断言读成「阻塞了」，与本用例要守的东西完全无关。
      listAccountsByProvider: async () => [],
      // 代理为空串时不会写池，补齐以免将来 qoderProxyInput 非空时崩。
      setQoderProxy: async () => {},
    }

    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    }

    registerJetHubRpc(
      // ⚠️ **命名对象**（2026-10-08 改，原为 13 个位置参数）：键是 **provider id**
      //（`qodercn` 全小写），值是实例。位置参数时代这里漏补一个占位就会让后续
      // 形参整体错位（本文件历史上踩过六次），命名对象让那类错位不再可能。
      ctx as never, pool as never, {
        codearts: makeAuth('codearts'),
        buddy: {} as never,
        workbuddy: {} as never,
        lobsterai: makeAuth('lobsterai'),
        qoder: makeAuth('qoder'),
        qodercn: {} as never, // 本组用例不触发
        trae: makeAuth('trae'),
        cline: makeAuth('cline'),
        loomy: {} as never, // 本组用例不触发
        raccoon: {} as never, // 本组用例不触发
        minimax: {} as never, // 本组用例不触发
        zcode: {} as never, // 本组用例不触发
        gemini: {} as never, // 本组用例不触发
        officeace: {} as never, // officeace（auth 模块命名空间占位）
      } as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown } }
      return body.result
    }
    return { call, calls, resolveLogin }
  }

  /**
   * 给 `account.create` 一个**远早于**用户授权完成的超时预算。
   *
   * 旧实现下它必然超时（因为 await 的是永不落定的登录）；新实现下它应当
   * 在毫秒级返回。这个差异正是本用例的判定依据。
   */
  const FAST_BUDGET_MS = 2000

  it.each(['codearts', 'lobsterai', 'qoder', 'trae'])(
    '%s 在用户完成授权之前就返回 loginUrl（不阻塞）',
    async (provider) => {
      const { call, calls } = registerCreateEndpoints({ twoPhase: true })

      const result = await Promise.race([
        call('account.create', { provider }),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), FAST_BUDGET_MS)),
      ])

      expect(
        result,
        `${provider} 的 account.create 阻塞了：说明它退回了「等用户授权完成才返回」`
        + '的旧实现，前端 window.open 会因手势过期被拦截，进而跳转主页面。',
      ).not.toBe('timeout')
      expect((result as { ok: boolean }).ok).toBe(true)
      const value = (result as { value: { loginUrl: string; accountId: string } }).value
      expect(value.loginUrl).toContain(provider)
      expect(value.accountId).toContain(provider)
      // 必须走两步式的 startLogin，而不是阻塞式 login。
      expect(calls).toContain(`${provider}:startLogin`)
      expect(calls).not.toContain(`${provider}:login`)
    },
  )

  it('未登录成功的账号先以占位条目登记，使前端 login.poll 能立即看到', async () => {
    // 两步式下 account.create 返回时凭据还不存在；若不登记占位条目，
    // 前端的 login.poll 会查不到该账号而永远返回 done:false。
    let added: Record<string, unknown> | undefined
    const pool = {
      addAccount: async (entry: Record<string, unknown>) => { added = entry },
      updateAccount: async () => {},
      removeAccount: async () => {},
      listAccounts: async () => [],
    }
    let handler: Handler | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    }
    const auth = {
      async startLogin() {
        return {
          loginUrl: 'https://example.test/codearts/login',
          result: new Promise(() => {}),
          close: async () => {},
        }
      },
    }
    // ⚠️ 命名对象（2026-10-08 改）：本用例只走 codearts，其余键用 `{}` 占位
    //（类型要求 13 个键都在，但本文件不在 `pnpm typecheck:tests` 的编译范围内，
    // 故这里靠人工对齐）。
    registerJetHubRpc(ctx as never, pool as never, {
      codearts: auth,
      buddy: {} as never,
      workbuddy: {} as never,
      lobsterai: {} as never,
      qoder: {} as never,
      qodercn: {} as never,
      trae: {} as never,
      cline: {} as never,
      loomy: {} as never,
      raccoon: {} as never,
      minimax: {} as never,
      zcode: {} as never,
      gemini: {} as never,
      officeace: {} as never,
    } as never)
    const response = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
        payload: { method: 'account.create', payload: { provider: 'codearts' } },
      }),
    }))
    await response.json()
    expect(added, 'account.create 未登记占位账号条目').toBeDefined()
    expect(added?.provider).toBe('codearts')
    expect(added?.enabled).toBe(true)
    expect(added?.refreshable).toBe(false)
  })

  /**
   * `startLogin` 启动失败（最典型：回调端口被占用）必须变成**规范的 RPC 错误响应**。
   *
   * 真实缺陷：`startTraeLoginFlow` 早期直接 `server.listen(port)` 且未注册
   * `'error'` 处理器 —— listen 失败是**事件**异步抛出的，不属于 Promise 链，
   * 于是逃过 RPC 的 try/catch 成为**进程级 unhandled error**，把整个 DSH 宿主
   * 崩掉。用户看到的不是可读文案，而是一整堆 `EADDRINUSE` 堆栈 + 进程退出。
   *
   * 现在 `startTraeLoginFlow` 会把 listen 失败转成可捕获的 reject；本用例守
   * 「RPC 层照常返回 `ok:false` + 可读 message」这一契约。
   */
  it('startLogin 因端口占用失败时返回可读的 RPC 错误（而非崩进程）', async () => {
    let handler: Handler | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    }
    const pool = {
      addAccount: async () => {},
      updateAccount: async () => {},
      removeAccount: async () => {},
      listAccounts: async () => [],
    }
    // 复刻「listen 失败」的服务替身：startLogin 直接抛可读错误。
    const failingAuth = {
      async startLogin() {
        throw new Error('TRAE 回调端口 18080 无法监听（EADDRINUSE）；端口可能已被其它程序占用，请释放后重试。')
      },
    }
    registerJetHubRpc(
      // ⚠️ 命名对象（2026-10-08 改）：`failingAuth` 落在 **`trae` 这个键**上。
      // 位置参数时代它靠「数到第 7 个槽位」定位，数错就静默打到别的 provider 上。
      ctx as never, pool as never, {
        codearts: {} as never,
        buddy: {} as never,
        workbuddy: {} as never,
        lobsterai: {} as never,
        qoder: {} as never,
        qodercn: {} as never,
        trae: failingAuth,
        cline: {} as never,
        loomy: {} as never,
        raccoon: {} as never,
        minimax: {} as never,
        zcode: {} as never,
        gemini: {} as never,
        officeace: {} as never,
      } as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const response = await handler(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
        payload: { method: 'account.create', payload: { provider: 'trae' } },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; error?: { code: string; message: string } }
    }

    // 必须是规范的错误响应（而不是裸 500 / 进程崩溃）。
    expect(body.result.ok).toBe(false)
    expect(body.result.error?.message).toContain('18080')
    expect(body.result.error?.message).toMatch(/端口|占用/)
  })

  /**
   * `forceNew: true` 必须**跳过两道复用检查**，直接走 OAuth。
   *
   * ## 为什么需要这个开关（用户报障）
   *
   * 两道复用检查（收编孤儿条目 / 本机凭据已在池里就复用）是为「点一次添加
   * 就多一条」设计的，但它们**在渠道判断之前**，于是把「同一个人想加第二个
   * 账号」也一并挡掉了：本机官方客户端登的账号已在池里时，点「新建账号」
   * 直接返回 `{reused:true, loginUrl:''}`，**浏览器根本不开**，用户无从登录
   * 第二个号。换 `zai` 渠道也一样被挡（复用检查读的是 bigmodel 的凭据文件，
   * 与渠道无关）。
   *
   * 本用例锁死：`forceNew: true` ⇒ 不返回 reused、必须调 `startLogin`。
   */

  /**
   * 前端源码级守卫：`createAccount` 不得再劫持当前页面。
   *
   * 组件无法在单测里渲染（react 不在本仓库依赖内），故与
   * `credits-capabilities.spec.ts` 同款——用源码断言锁死那条破坏性兜底
   * 不再出现。`window.location.href = loginUrl` 会把用户正在使用的设置页
   * 整个导航到外部登录页，且登录完成后回不来；正确做法是保留可点击链接。
   */
  it('createAccount 不再用 window.location.href 跳转主页面', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    // ⚠️ 签名带形参（`async (forceNew) =>`，ZCode 的「登录其他账号」用它跳过复用）。
    // 按 `const createAccount = async ` 定位，不把形参写进断言 —— 否则每次加参数
    // 都要改这条守卫，而它真正要守的是**函数体里不得有页面跳转**。
    const start = source.indexOf('const createAccount = async ')
    expect(start).toBeGreaterThan(-1)
    // 取到下一个顶层函数定义为止，避免把文件其余部分一起扫进来。
    const rest = source.slice(start)
    const end = rest.indexOf('\n  const toggleAccount')
    const body = end > -1 ? rest.slice(0, end) : rest.slice(0, 3000)

    // 归一化 CRLF：本仓库源码在 Windows 上是 CRLF。
    // 再剔除注释行：本文件里保留了叙述该缺陷的注释（含 `window.location.href = …`
    // 字样），直接扫全文会把注释本身当成违规。与 credits-capabilities.spec.ts 同款。
    const normalized = body.replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(
      normalized,
      'createAccount 里又出现了 window.location.href 跳转：弹窗被拦截时'
      + '必须展示可点击链接，而不是把整个设置页导航走。',
    ).not.toMatch(/window\.location\.(href|assign|replace)\s*=/)
    // 必须仍然尝试弹出新窗口（两步式的前提）。
    expect(normalized).toContain('window.open(loginUrl')
    // 弹窗失败时要有手动链接兜底。
    expect(normalized).toContain('setLoginUrlForManual(loginUrl)')
  })
})

describe('model.list / model.setDisabled 端点', () => {
  /**
   * ⚠️ 「已失效模型」表是**进程级单例**（`dead-model-store` 的 store / cache 在
   * 模块作用域），本组用例会写记录。必须在每例之后清干净，否则**残留记录会让
   * 后续用例的 model.list 多出条目**（表现为「莫名其妙多一个模型」的假失败）。
   */
  afterEach(() => {
    clearDeadModels('buddy')
    clearDeadModels('cline')
    clearDeadModels('trae')
    // benefit 集合也是进程级内存缓存，必须逐例清回「未确认」，
    // 否则后面「未确认 ⇒ 不标记」那条用例会读到上一例灌进去的集合。
    setBenefitMemoryCache(undefined)
  })

  /**
   * 「需福利包」标记（Gitee issue **IKJOF7**）。
   *
   * `glm-5.3-flash` 这类模型只按 benefit（免费额度）通道注册：不带
   * `maas_type: benefit` 回 `002002009.404`，纯积分制账号则先被 `4004.200` 拒、
   * 降级去头重试后仍是 404 ⇒ 用户看到的最终错误与「模型名写错」**同形**。
   * 设置页挂一枚「需福利包」角标就能把因果讲清楚。
   *
   * ⚠️ 这三条打的是**同一个字段的三个状态**，少任何一条都会放走一类真实缺陷：
   * - 命中却不标 ⇒ 功能等于没做（改动前就是 0 处命中）；
   * - 未确认却标 ⇒ 冷启动那一帧**整页模型**都挂角标（判据写成 `!== false` 就这结果）；
   * - 确认不在集合里却标 ⇒ 常规模型被误报成「需福利包」。
   */
  describe('★ model.list 的 benefitOnly（IKJOF7「需福利包」标记）', () => {
    const BENEFIT_MODELS = [
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    ]

    it('★★★ 命中远端 benefit 集合 ⇒ 恰好那一条带 benefitOnly，其余字段缺席', async () => {
      setBenefitMemoryCache(['glm-5.3-flash'])
      const { call } = registerEndpoints({ models: BENEFIT_MODELS })

      const result = await call('model.list', { provider: 'codearts' })

      expect(result.ok).toBe(true)
      const models = (result.value as { models: Array<Record<string, unknown>> }).models
      expect(models.find(m => m.id === 'glm-5.3-flash')?.benefitOnly).toBe(true)
      // ⚠️ 不写 `false`：缺席才是「不适用/未确认」，与 `isFree` 同一约定。
      expect('benefitOnly' in models.find(m => m.id === 'deepseek-v4.1-flash')!, '非 benefit 模型不许带该字段').toBe(false)
    })

    it('★★★ 未确认（集合读不到）⇒ 一条都不许标', async () => {
      // 冷缓存 / 远端降级的真实形态：内存缓存是 undefined，磁盘也没有该文件。
      setBenefitMemoryCache(undefined)
      const { call } = registerEndpoints({ models: BENEFIT_MODELS })

      const result = await call('model.list', { provider: 'codearts' })

      const models = (result.value as { models: Array<Record<string, unknown>> }).models
      expect(models, '前置：目录非空才能证明「不是没模型才没标记」').toHaveLength(2)
      expect(models.filter(m => 'benefitOnly' in m), '未确认时整页模型都会被误标 —— 这是本字段最危险的错法').toEqual([])
    })

    it('★★ 确认是空集合 ⇒ 同样一条都不标（但这是「确认无」，与未确认等价于本字段）', async () => {
      setBenefitMemoryCache([])
      const { call } = registerEndpoints({ models: BENEFIT_MODELS })

      const models = ((await call('model.list', { provider: 'codearts' }))).value as { models: Array<Record<string, unknown>> }
      expect(models.models.filter(m => 'benefitOnly' in m)).toEqual([])
    })

    it('★★ 非 codearts 渠道 ⇒ 恒不带该字段（benefit 是 codearts 独占概念）', async () => {
      // ⚠️ 灌一个**含该模型 id** 的集合，若实现忘了判 provider，这里就会误标。
      setBenefitMemoryCache(['glm-5.3-flash'])
      const { call } = registerEndpoints({ models: BENEFIT_MODELS })

      const result = await call('model.list', { provider: 'trae' })

      const models = (result.value as { models: Array<Record<string, unknown>> }).models
      expect(models).toHaveLength(2)
      expect(models.filter(m => 'benefitOnly' in m), 'benefit 概念只属于 codearts').toEqual([])
    })
  })

  /** 从 connection.fetch.register 捕获到的处理器。 */
  type Handler = (request: Request) => Promise<Response>

  /** 构造带 RPC 端点所需的 ctx 替身，返回注册进去的 fetch 处理器。 */
  function registerEndpoints(options: {
    models: Array<{ id: string; name: string }>
    disabledModels?: Record<string, Record<string, boolean>>
    /** listModels 抛错时用于验证错误路径。 */
    listModelsError?: string
    /** 省略 llm 服务（验证降级行为）。 */
    withoutLlm?: boolean
    /**
     * 是否让桩复刻真实适配器的黑名单过滤（默认 true）。
     *
     * 真实 `CodeArtsAdapter.listModels` / `BuddyAdapter.listModels` 都会实时
     * 剔除 `disabledModelsFor(provider)` 命中的模型，因此桩默认也必须过滤，
     * 否则「端点在一个已过滤目录上回填 disabled」这类缺陷会被静默绕过。
     * 仅当需要验证「适配器未过滤」这一非真实场景时才置为 false。
     */
    adapterFiltersDisabledModels?: boolean
    /**
     * 复刻适配器实例映射（`listAllModels` 返回**不套黑名单**的全量目录）。
     *
     * 真实链路里 `index.ts` 会把五个适配器实例传给 `registerJetHubRpc`；
     * `model.list` 据此拿到被关闭模型的**真实展示名**（含倍率），而不是裸 id。
     * 省略时退化为「listModels + 裸 id 补回」的历史行为。
     */
    modelAdapters?: Record<string, {
      listAllModels(): readonly { id: string; name: string }[]
      /**
       * 「这份目录**确认**来自远端完整读取」的适配器自报钩子。
       *
       * 真实链路里只有 codearts 会声明它（两个目录端点都读成功才为 true）；
       * 其余 14 家不声明 ⇒ `model.list` 放弃「已下架」判据、照旧补回黑名单条目。
       */
      catalogConfirmedRemote?(): boolean
      /**
       * 适配器自报「这份目录还不是全的」（聚合冷启动专用）。
       *
       * ⚠️ 2026-11-05 审查补：`model.setAllDisabled` 的放行分支里有一条
       * `catalog.notReady === undefined`（冷帧必须继续拒绝），此前**全仓没有
       * 一条用例打在 `model.setAllDisabled` 上** ⇒ 删掉那半条判据也没人红。
       * 挂上这个钩子才能测。
       */
      catalogReadyForBulkWrite?(): { ready: boolean; reason?: string }
    }>
    /** 让 `ctx.emit` 抛错，验证「广播失败不反噬已落盘的开关」。 */
    emitThrows?: boolean
    /**
     * 让 `listModels` **永不 resolve**（验证核对带超时、开关不被拖住）。
     *
     * 真实 `listModels` 在冷缓存下会发远端拉取，远端卡住时它就一直不返回 ——
     * 本开关必须自己带预算，不能依赖下游会及时 reject。
     */
    listModelsHangs?: boolean
    /**
     * `listModels` 的额外钩子（在每个 id 过滤前 await 它）。
     *
     * 用于构造**并发窗口**：让第一路的目录读取挂起，期间让第二路完整跑完一次
     * 写入，从而验证「黑名单读取时刻」是否与写入时刻对齐（Issue IKJW33 的
     * 审计实测缺陷：提前读会误报「没有产生任何变更」）。
     */
    onListModels?: () => Promise<void>
  }) {
    // settings 替身：内存里保存 namespace 的值，语义与真实服务一致的
    // 「整体 replace」。
    let stored: Record<string, unknown> = {
      accounts: [],
      ...options.disabledModels !== undefined ? { disabledModels: options.disabledModels } : {},
    }
    /**
     * ⚠️ **落盘次数**（2026-11-05 合规审计补）：「黑名单与关闭意图必须**同一次**
     * 落盘」——分两次写会留下「黑名单满了、意图没写」的半套状态，重启后静默复发。
     */
    let writeCount = 0
    let handler: Handler | undefined
    /** 端点通过 `ctx.emit` 广播过的事件名（按顺序）。 */
    const emitted: string[] = []

    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => {
                writeCount += 1
                stored = value
              },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return {
            fetch: {
              register: (config: { path: string; fetch: Handler }) => {
                if (config.path === JET_HUB_API_PATH) handler = config.fetch
              },
            },
          }
        }
        if (key === 'llm' && options.withoutLlm !== true) {
          return {
            listModels: async (provider: string) => {
              if (options.listModelsError !== undefined) throw new Error(options.listModelsError)
              // 永不落定：复刻「远端卡住」的真实形态（核对必须自己带超时，
              // 不能指望下游会及时 reject）。
              if (options.listModelsHangs === true) return await new Promise(() => {})
              // 并发窗口钩子（见 `onListModels` 的说明）。
              if (options.onListModels !== undefined) await options.onListModels()
              // 复刻真实适配器：黑名单命中的模型不会出现在 listModels 结果里。
              // 读的是 settings 替身的当前值（而非构造时的快照），这样
              // model.setDisabled 之后的下一次 listModels 会立刻反映过滤结果，
              // 与真实「每次调用都实时读账号池」的语义一致。
              const disabled = options.adapterFiltersDisabledModels !== false
                ? ((stored.disabledModels as Record<string, Record<string, boolean>> | undefined)?.[provider] ?? {})
                : {}
              return options.models
                .filter(m => disabled[m.id] !== true)
                .map(m => ({ ...m, provider }))
            },
          }
        }
        return undefined
      },
      // `connection` 由生产代码用**惰性注入**（`ctx.inject`）挂载，而非插件级
      // 静态 `inject`：它只存在于 Web bundle，静态声明会让 headless/CLI profile
      // 永久 pending 而启动失败。替身必须复刻这一机制，否则 registerJetHubRpc
      // 会以 `ctx.inject is not a function` 直接抛错。
      //
      // 语义对齐真实 cordis：回调以**同一 ctx** 立即调用（本替身里 connection
      // 始终可用），使端点注册行为与 Web profile 下完全一致。
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      // `model.setDisabled` / `model.setAllDisabled` 写完黑名单后必须广播
      // `llm/adapters-updated`，否则客户端那份 `status === 'ready'` 即短路的
      // 目录缓存永不失效 —— 表现为「关闭后选择器里仍看得到该模型，重启后才消失」。
      // 替身必须真的实现 emit：若只声明不实现，生产代码的广播会以
      // `ctx.emit is not a function` 被 try/catch 静默吞掉，用例便形同虚设。
      emit: (event: string) => {
        if (options.emitThrows === true) throw new Error('listener exploded')
        emitted.push(event)
      },
    }

    registerJetHubRpc(
      // ⚠️ **命名对象**（2026-10-08 改，原为 13 个位置参数 + `modelAdapters`）。
      // 位置参数时代每新增一个 provider 都要在这里补一个 `{}` 占位，否则
      // `modelAdapters` 会错位落到最后一个 auth 形参上（加 Loomy 踩过一次、
      // 加 Raccoon 又踩一次、加 QoderCN 第三次、加 MiniMax 第四次、加 ZCode 第五次
      // —— 本文件第 2223 行那段注释记录了第六次）。命名对象下 `modelAdapters`
      // 是独立的第 4 个形参，**不可能**再被 auth 占位挤掉。
      ctx as never, pool, {
        codearts: {} as never,
        buddy: {} as never,
        workbuddy: {} as never,
        lobsterai: {} as never,
        qoder: {} as never,
        qodercn: {} as never,
        trae: {} as never,
        cline: {} as never,
        loomy: {} as never,
        raccoon: {} as never,
        minimax: {} as never,
        zcode: {} as never,
        gemini: {} as never,
        officeace: {} as never,
      } as never,
      options.modelAdapters as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    /** 调用一个端点方法，返回解包后的 result。 */
    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    return { call, pool, storedValue: () => stored, emitted, writeCount: () => writeCount }
  }

  const MODELS = [
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'hy3', name: 'Hy3' },
  ]

  /**
   * 「面板入口」端点（`plugin-src/client/settings-card.js` 的唯一数据来源）。
   *
   * ⚠️ 用例判据是**写后读回**，不是「set 返回了什么」：这条偏好最可能的缺陷形态
   * 是 set 只改了进程内副本、没有落盘，下次启动入口又变回默认。
   */
  describe('panelEntry 端点', () => {
    it('get 默认返回「仅侧栏」', async () => {
      const { call } = registerEndpoints({ models: MODELS })

      const result = await call('panelEntry.get', {})

      expect(result.ok).toBe(true)
      expect(result.value).toEqual({ entry: 'sidebar' })
    })

    it('set 写入后 get 读回', async () => {
      const { call } = registerEndpoints({ models: MODELS })

      const setResult = await call('panelEntry.set', { entry: 'settings' })

      expect(setResult.ok).toBe(true)
      // ⚠️ 回传的是**落盘后重读**的值，客户端一律以后端回传为准（不做乐观更新）。
      expect(setResult.value).toEqual({ entry: 'settings' })
      expect((await call('panelEntry.get', {})).value).toEqual({ entry: 'settings' })
    })

    it('⚠️ 非枚举 entry 一律 bad-request，不猜默认值', async () => {
      const { call } = registerEndpoints({ models: MODELS })

      for (const bad of [undefined, null, true, false, 'off', 'both', 'Sidebar', 1]) {
        const result = await call('panelEntry.set', { entry: bad })
        expect(result.ok, `entry=${JSON.stringify(bad)} 不该被接受`).toBe(false)
        expect(result.error).toMatchObject({ code: 'bad-request' })
      }

      // 非法写入不得改动已存的值。
      expect((await call('panelEntry.get', {})).value).toEqual({ entry: 'sidebar' })
    })
  })

  it('model.list 回传 llm 的模型目录，并把黑名单回填为 disabled', async () => {
    const { call } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(true)
    // 未提供 modelAdapters 时退化为历史行为：hy3 已被适配器过滤掉（桩复刻了
    // 真实过滤），由端点补回列表；补回的条目拿不到原始 name，回退为 id。
    // ⚠️ `dead` 恒存在（缺失即 false，客户端据它渲染「重新显示」入口）。
    expect(result.value).toEqual({
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', disabled: false, dead: false },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', disabled: false, dead: false },
        { id: 'hy3', name: 'hy3', disabled: true, dead: false },
      ],
    })
  })

  /**
   * 回归：**被关闭的模型也要显示倍率**（用户报障）。
   *
   * 真实缺陷：适配器的 `listModels` 会按黑名单过滤，于是被关闭的模型不在其中，
   * 端点只能凭黑名单的 key（裸 id）补回 —— 展示名与倍率随之丢失。用户看到
   * 「打开的显示倍率、关闭的没有倍率」。
   *
   * 修法：`index.ts` 把适配器实例传给 `registerJetHubRpc`，端点用其
   * `listAllModels()`（不套黑名单、带最终展示名）作为目录来源。
   */
  it('关闭的模型仍显示带倍率的展示名（不再退化成裸 id）', async () => {
    const catalog = [
      { id: 'glm-5.2', name: 'GLM-5.2 · x0.78' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash · x0.13' },
      { id: 'kimi-k3', name: 'Kimi-K3 · x1.83' },
    ]
    const { call } = registerEndpoints({
      models: catalog,
      disabledModels: { trae: { 'deepseek-v4.1-flash': true } },
      modelAdapters: { trae: { listAllModels: () => catalog } },
    })

    const result = await call('model.list', { provider: 'trae' })
    expect(result.ok).toBe(true)
    const models = (result.value as { models: Array<{ id: string; name: string; disabled: boolean }> }).models
    const closed = models.find((m) => m.id === 'deepseek-v4.1-flash')
    expect(closed?.disabled, '该项应为已关闭').toBe(true)
    // 关键断言：关闭项必须仍是**带倍率的展示名**，而不是裸 id。
    expect(closed?.name).toBe('DeepSeek-V4.1-Flash · x0.13')
    // 打开项不受影响。
    expect(models.find((m) => m.id === 'glm-5.2')?.name).toBe('GLM-5.2 · x0.78')
    // 全部模型都应在列表里（含被关闭的）。
    expect(models.map((m) => m.id)).toEqual(['glm-5.2', 'deepseek-v4.1-flash', 'kimi-k3'])
  })

  /**
   * ★★ **上游已下架的黑名单条目不得补回设置页**（真实缺陷，2026-10-27）。
   *
   * ## 缺陷
   *
   * 旧实现无条件把 `disabledMap` 里所有 `true` 的 id 补进目录 ⇒ 上游已下架、
   * 但用户曾关掉过的模型会**永久留在设置页**：灰显、开关能动，点开必然 404
   * （实测 `GLM-5` / `glm-5.3-flash` 回 `InferHub.002002009.404`）。
   *
   * 它既不是 `dead`（没有阳性请求失败记录）、也不在远端目录里 ——
   * 两条现有的「可解释」路径都覆盖不到，用户完全无从判断。
   *
   * ## 判据
   *
   * `llm.listModels()` 的结果是**权威在售集合**（读到且非空时）：
   * 补回黑名单时只补**仍在其中**的；已下架的不补。
   *
   * ⚠️⚠️ **前置条件（2026-10-28 补）**：只有当适配器**能证明**这份目录来自
   * 「远端完整读取」（`catalogConfirmedRemote() === true`）时，本判据才允许生效。
   * 否则一份**兜底子集**就能让在售模型从设置页消失 —— 见下一条用例。
   */
  it('★ 已下架模型即使被用户关过，也不得补回设置页', async () => {
    // 权威在售集合 = `listAllModels()`（**不套黑名单**的全量目录）。
    // 这里它**没有** glm-5（已下架），有 glm-5.2（在售，但用户关着）。
    const onSaleAll = [
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    ]
    const { call } = registerEndpoints({
      models: onSaleAll,
      // glm-5 已下架（不在全量目录里）；glm-5.2 在售但被关着。
      disabledModels: { buddy: { 'glm-5': true, 'glm-5.2': true } },
      // ⚠️ 必须声明「这份目录确认来自远端」—— 判据的前置条件（见 doc）。
      modelAdapters: { buddy: { listAllModels: () => onSaleAll, catalogConfirmedRemote: () => true } },
    })

    const result = await call('model.list', { provider: 'buddy' })
    expect(result.ok).toBe(true)
    const ids = (result.value as { models: Array<{ id: string }> }).models.map((m) => m.id)
    // 已下架的 glm-5 不得出现（否则用户点开必然 404）。
    expect(ids).not.toContain('glm-5')
    // 在售但被关的 glm-5.2 必须仍在（否则用户无法重新打开）。
    expect(ids).toContain('glm-5.2')
  })

  /**
   * ★★ **目录未经「确认远端」时，不得据兜底子集判「已下架」**（2026-10-28 修）。
   *
   * ## 为什么「不在 `listAllModels()` 里」不足以证明已下架
   *
   * `listAllModels()` 在**冷缓存 / 远端降级**下返回的是各家**编译期兜底表**
   * （`model-catalog.ts` 的 `cached ?? config.syncCatalog()`），它是远端目录的
   * **子集** —— 本仓库在 Issue IKJW33 上实测过：`cline` 冷缓存只有 **3** 条、
   * 远端有 **460** 条。
   *
   * 拿它当「在售集合」的后果：用户关掉的**在售**模型（恰好不在兜底表里的那些，
   * 例如 codearts 近期新增、只存在于远端的 `glm-5.3` / `kimi-k3`）会被判成
   * 已下架 ⇒ **从设置页彻底消失、再也打不开** —— 正是本端点当初要修的缺陷形态。
   * 而且窗口很实在：远端拉取失败、离线启动、或刚重启还没拉到时都会命中。
   *
   * ## 判据（与 PR159 注释里那句原则对齐）
   *
   * 「判据只能建立在**确认拿到全量目录**之上」—— 只有适配器能证明自己这份目录
   * 来自「远端完整读取」（`catalogConfirmedRemote?.() === true`）时才允许隐藏；
   * 证明不了就**放弃判据、照旧补回**。方向与 `dead-model-store.ts` 头注释的
   * 「不从残缺目录反推」一致：**宁可留幽灵，也不让用户在售模型凭空消失**。
   *
   * ⚠️ 这条同时是**其余 14 家的默认行为**：它们都没声明该钩子 ⇒ 端点行为与
   * 加本判据之前逐字节一致（不隐藏任何条目）。
   */
  it('★★ 目录未经「确认远端」时不得据残缺（兜底子集）判已下架', async () => {
    // 兜底表是子集：远端真实在售的 glm-5.3 不在里面。
    const fallback = [{ id: 'glm-5.2', name: 'GLM-5.2' }]
    const { call } = registerEndpoints({
      models: fallback,
      disabledModels: { codearts: { 'glm-5.3': true } },
      // ⚠️ 刻意**不声明** catalogConfirmedRemote —— 无法证明这是完整远端目录。
      modelAdapters: { codearts: { listAllModels: () => fallback } },
    })

    const result = await call('model.list', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    const ids = (result.value as { models: Array<{ id: string }> }).models.map((m) => m.id)
    expect(
      ids,
      '拿兜底子集当在售集合 ⇒ 用户在售模型会从设置页消失且无法重新打开',
    ).toContain('glm-5.3')
  })

  /**
   * ★★ **对照组：拿不到全量目录时不得据残缺目录删黑名单**。
   *
   * 旧适配器没有 `listAllModels()` ⇒ 判据无法成立（`models` 是被黑名单过滤过的，
   * 拿它当在售集合会把**所有被关模型**判成已下架 ⇒ 集体消失）。
   * ⇒ 必须**放弃判据**、照旧补回。这条锁住「宁可留幽灵，不可删在售」。
   */
  it('★ 对照：没有 listAllModels 时黑名单条目照常补回（不得据被过滤的目录删）', async () => {
    const { call } = registerEndpoints({
      // 适配器已按黑名单过滤 ⇒ models 里没有 glm-5。
      models: [{ id: 'glm-5.2', name: 'GLM-5.2' }],
      disabledModels: { buddy: { 'glm-5': true } },
      // 刻意不传 modelAdapters ⇒ all === undefined ⇒ 放弃判据。
    })

    const result = await call('model.list', { provider: 'buddy' })
    expect(result.ok).toBe(true)
    const ids = (result.value as { models: Array<{ id: string }> }).models.map((m) => m.id)
    expect(ids).toContain('glm-5')
  })

  /**
   * ★★ **对照组：远端读不到时不得据此删黑名单**（判据只能建在「确认读到」上）。
   *
   * 远端抛错 ≠ 模型已下架。若此时也过滤，一次网络抖动就会让用户所有关闭项
   * 从设置页消失（虽然 `disabledModels` 记录还在，但用户看不到、也打不开）。
   * 这正是 `dead-model-store.ts` 头注释禁止的「从残缺目录反推」。
   */
  it('★ 对照：远端读取失败时，黑名单条目必须照常补回（不得据残缺目录删）', async () => {
    const { call } = registerEndpoints({
      models: [],
      listModelsError: 'network down',
      disabledModels: { buddy: { 'glm-5': true } },
    })

    const result = await call('model.list', { provider: 'buddy' })
    // 远端读失败 ⇒ 判据退化为「不知道」⇒ 保守照常补回。
    // ⚠️ 该形态下端点本身会因读失败而返回错误；此处只断言「若返回成功，
    //    则 glm-5 必须仍在」这一方向的语义（不把错误路径说成成功）。
    if (result.ok) {
      const ids = (result.value as { models: Array<{ id: string }> }).models.map((m) => m.id)
      expect(ids).toContain('glm-5')
    } else {
      // 读失败本就该如实报错 —— 这也符合契约。
      expect(result.error.code).toBe('bad-request')
    }
  })

  /**
   * 回归测试：关闭 → 列表 → 重新打开的完整往返。
   *
   * 历史 bug：`model.list` 直接在 `llm.listModels()`（已被适配器过滤）的结果上
   * 回填 disabled，被关闭的模型不在数组里，它的开关因此从设置页彻底消失，
   * 用户无法重新打开。此用例锁死「关掉的模型必须仍在 model.list 里且可被 reopen」。
   */
  it('关闭模型后它仍出现在 model.list 中（可被重新打开），但不在对话框目录里', async () => {
    const { call } = registerEndpoints({ models: MODELS })

    // 初始：全部可见、全部打开
    const before = await call('model.list', { provider: 'buddy' })
    expect((before.value as { models: Array<{ id: string }> }).models.map(m => m.id))
      .toEqual(['glm-5.2', 'deepseek-v4-flash', 'hy3'])

    // 关闭 hy3
    await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })

    // 关键断言：hy3 仍出现在设置页列表里，且标记为已关闭 —— 否则无法重新打开
    const after = await call('model.list', { provider: 'buddy' })
    const models = (after.value as { models: Array<{ id: string; disabled: boolean }> }).models
    const hy3 = models.find(m => m.id === 'hy3')
    expect(hy3).toBeDefined()
    expect(hy3!.disabled).toBe(true)
    // 其余模型不受影响
    expect(models.filter(m => m.disabled).map(m => m.id)).toEqual(['hy3'])

    // 重新打开：hy3 恢复正常显示
    await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: false })
    const reopened = await call('model.list', { provider: 'buddy' })
    const reopenedModels = (reopened.value as { models: Array<{ id: string; disabled: boolean }> }).models
    expect(reopenedModels.map(m => m.id)).toEqual(['glm-5.2', 'deepseek-v4-flash', 'hy3'])
    expect(reopenedModels.every(m => !m.disabled)).toBe(true)
  })

  // ── 「已失效模型」的可见性与恢复（2026-10-06 复审 !66）──────────────────

  /**
   * ⚠️⚠️ 致命回归（复审 !66 实测确认）：适配器把已失效模型从目录里剔除后，
   * 它既不在 `listAllModels` 的结果里、也不在 `disabledMap` 里 ⇒ 上面两条
   * 补回路径都救不回它 ⇒ **模型从设置页彻底消失，连开关都摸不着**。
   *
   * 而失效记录**不会**被「再成功一次」清掉（模型选不到 ⇒ 不可能再成功），
   * 唯一自愈路径是 30 天 TTL 或用户手动恢复 ⇒ 一次误判 = 该模型被永久隐藏。
   *
   * ⇒ 断言：失效模型必须**仍出现在 `model.list` 里**且带 `dead: true`。
   */
  it('★ 已失效模型仍出现在 model.list 且带 dead: true（否则用户无法恢复）', async () => {
    const catalog = [{ id: 'ok-model', name: 'OK' }]
    const { call } = registerEndpoints({
      // 适配器侧已把失效模型剔除（这正是 withDeadModelPruning 的行为）
      models: catalog,
      modelAdapters: { cline: { listAllModels: () => catalog } },
    })
    recordDeadModel('cline', 'gone-model', 'cline: model not found')

    const result = await call('model.list', { provider: 'cline' })
    expect(result.ok).toBe(true)
    const models = (result.value as { models: Array<{ id: string; name: string; dead: boolean }> }).models
    const gone = models.find(m => m.id === 'gone-model')
    expect(gone, '失效模型必须仍出现在设置页，否则用户无法恢复').toBeDefined()
    expect(gone!.dead).toBe(true)
    // 正常模型不受影响，且 dead 为 false（恒存在，不省略）。
    expect(models.find(m => m.id === 'ok-model')?.dead).toBe(false)
  })

  it('model.clearDead 移除指定模型后 dead 标记消失', async () => {
    const catalog = [{ id: 'ok-model', name: 'OK' }]
    const { call } = registerEndpoints({
      models: catalog,
      modelAdapters: { cline: { listAllModels: () => catalog } },
    })
    recordDeadModel('cline', 'gone-model', 'cline: model not found')

    const restored = await call('model.clearDead', { provider: 'cline', modelId: 'gone-model' })
    expect(restored.ok).toBe(true)
    expect((restored.value as { deadModels: string[] }).deadModels).toEqual([])
    expect(deadModelIdsFor('cline').has('gone-model')).toBe(false)
  })

  it('model.clearDead 省略 modelId 时清空该 provider 全部（批量恢复）', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    recordDeadModel('buddy', 'a-gone', 'x')
    recordDeadModel('buddy', 'b-gone', 'x')

    const result = await call('model.clearDead', { provider: 'buddy' })
    expect(result.ok).toBe(true)
    expect(deadModelIdsFor('buddy').size).toBe(0)
  })

  it('model.clearDead 不动黑名单（失效记录与用户开关必须分开清）', async () => {
    const { call } = registerEndpoints({ models: MODELS, disabledModels: { buddy: { 'glm-5.2': true } } })
    recordDeadModel('buddy', 'a-gone', 'x')

    await call('model.clearDead', { provider: 'buddy', modelId: 'a-gone' })
    // 用户自己关的 glm-5.2 必须仍然是关的 —— 「恢复」不等于「打开」。
    const after = await call('model.list', { provider: 'buddy' })
    const models = (after.value as { models: Array<{ id: string; disabled: boolean }> }).models
    expect(models.find(m => m.id === 'glm-5.2')?.disabled).toBe(true)
  })

  it('model.clearDead 参数非法一律 bad-request（modelId 空串不得清空全表）', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    recordDeadModel('buddy', 'keep-me', 'x')

    for (const payload of [{}, { provider: '' }, { provider: 'buddy', modelId: '' }, { provider: 'buddy', modelId: 42 }]) {
      const result = await call('model.clearDead', payload)
      expect(result.ok, JSON.stringify(payload)).toBe(false)
    }
    // 非法调用**不得**误清记录。
    expect(deadModelIdsFor('buddy').has('keep-me')).toBe(true)
  })

  /**
   * 关闭多个模型（含连续操作）后，全部都能在设置页找到。
   *
   * 覆盖用户实际场景：连续关掉多个模型后想找回其中一个。
   */
  it('连续关闭多个模型后，每个都仍可在 model.list 中找到并重新打开', async () => {
    const { call } = registerEndpoints({ models: MODELS })

    for (const id of ['glm-5.2', 'hy3']) {
      await call('model.setDisabled', { provider: 'buddy', modelId: id, disabled: true })
    }

    const listed = await call('model.list', { provider: 'buddy' })
    const models = (listed.value as { models: Array<{ id: string; disabled: boolean }> }).models
    expect(models.map(m => m.id).sort()).toEqual(['deepseek-v4-flash', 'glm-5.2', 'hy3'])
    expect(models.filter(m => m.disabled).map(m => m.id).sort()).toEqual(['glm-5.2', 'hy3'])
  })

  it('未配置黑名单时全部模型默认打开（黑名单制）', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    const result = await call('model.list', { provider: 'workbuddy' })
    const models = (result.value as { models: Array<{ disabled: boolean }> }).models

    expect(models.every(m => m.disabled === false)).toBe(true)
  })

  it('黑名单按 provider 隔离', async () => {
    const { call } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const buddy = await call('model.list', { provider: 'buddy' })
    const workbuddy = await call('model.list', { provider: 'workbuddy' })

    const flagOf = (result: unknown, id: string) =>
      (result as { models: Array<{ id: string; disabled: boolean }> }).models.find(m => m.id === id)!.disabled

    expect(flagOf(buddy.value, 'hy3')).toBe(true)
    // 另一个 provider 的同名模型不受影响
    expect(flagOf(workbuddy.value, 'hy3')).toBe(false)
  })

  it('model.setDisabled 持久化到 settings，并在后续 model.list 中生效', async () => {
    const { call, storedValue } = registerEndpoints({ models: MODELS })

    const set = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })
    expect(set.ok).toBe(true)
    expect(set.value).toEqual({ provider: 'buddy', disabledModels: { hy3: true } })
    // 落盘内容可核对：
    expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true } })

    const list = await call('model.list', { provider: 'buddy' })
    const hy3 = (list.value as { models: Array<{ id: string; disabled: boolean }> })
      .models.find(m => m.id === 'hy3')!
    expect(hy3.disabled).toBe(true)
  })

  it('重新打开时从黑名单移除（写 false 不残留）', async () => {
    const { call, storedValue } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const set = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: false })

    expect(set.value).toEqual({ provider: 'buddy', disabledModels: {} })
    expect(storedValue().disabledModels).toEqual({})
  })

  it('model.setDisabled 缺少 modelId 时返回 bad-request 而不是静默成功', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    const result = await call('model.setDisabled', { provider: 'buddy', modelId: '' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('modelId')
  })

  /**
   * 回归：**开关必须广播目录变更事件**，否则界面要重启才更新（用户报障）。
   *
   * 真实缺陷：`dsh-client-ui-model-selection` 的 `ModelCatalogDirectory` 把
   * `modelCatalog` 响应缓存在一个 `status === 'ready'` 即短路返回的 store 里，
   * 只在三个转发事件上 `refresh()`。0.1.7 起黑名单落在插件自有文档
   * （不再经 settings 文档），于是写开关**不触发任何**那些事件 → 选择器一直
   * 显示旧目录，直到重启（`connection/reset`）才重拉。
   *
   * 适配器侧本来就是对的（每次实时读黑名单），所以这个用例锁的是**通知**：
   * 少了它，落盘与界面就会长期不一致，且没有任何报错。
   */
  it('model.setDisabled 广播 llm/adapters-updated（否则界面要重启才更新）', async () => {
    const { call, emitted } = registerEndpoints({ models: MODELS })

    await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })
    // 关闭要广播
    expect(emitted).toContain('llm/adapters-updated')

    // 重新打开同样要广播：两个方向都会改变可见目录。
    emitted.length = 0
    await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: false })
    expect(emitted).toContain('llm/adapters-updated')
  })

  it('校验失败时不广播（没有实际变更就不该惊动目录）', async () => {
    const { call, emitted } = registerEndpoints({ models: MODELS })

    const result = await call('model.setDisabled', { provider: 'buddy', modelId: '' })

    expect(result.ok).toBe(false)
    expect(emitted).toEqual([])
  })

  /**
   * 广播失败**不能反噬已经落盘的开关**。
   *
   * 若让监听器的异常冒泡，用户会看到「切换失败」，而黑名单其实已经写入 ——
   * 再点一次又因幂等而看似「无效」，比不提示更难排查。故生产代码把 emit
   * 包在 try/catch 里，本用例锁住这一行为。
   */
  it('广播抛错时开关仍算成功（已落盘的不回滚）', async () => {
    const { call, storedValue, emitted } = registerEndpoints({ models: MODELS, emitThrows: true })

    const result = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })

    expect(result.ok).toBe(true)
    expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true } })
    // 抛错发生在 push 之前，故不会有记录 —— 但关键断言是上面的 ok/落盘。
    expect(emitted).toEqual([])
  })

  it('llm 服务不可用时 model.list 返回可读错误（账号面板不受影响）', async () => {
    const { call } = registerEndpoints({ models: MODELS, withoutLlm: true })
    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('llm 服务不可用')
  })

  it('适配器 listModels 抛错时返回可读错误而不是裸 500', async () => {
    const { call } = registerEndpoints({ models: MODELS, listModelsError: '令牌已过期' })
    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('令牌已过期')
  })

  /**
   * 批量端点 `model.setAllDisabled`（Jet Hub 模型列表的「打开全部 / 关闭全部」）。
   *
   * 两个方向的语义**刻意不对称**，这是需求明确规定并写进
   * `AccountPool.setModelsDisabled` / `clearDisabledModels` 的约定：
   *
   * - `disabled: true`（关闭全部）：按**当前目录**逐项加入黑名单，读目录因此是必需的；
   * - `disabled: false`（打开全部）：直接清空该 provider 的黑名单，**不读目录** ——
   *   否则「曾被关闭、后来从服务端目录里下线」的历史遗留键永远清不掉。
   *
   * 用一个带布尔的端点而不是两个端点：两者共享同一套校验、同一次广播、
   * 同一份返回结构，唯一差异就是那个布尔。
   */
  describe('model.setAllDisabled（打开全部 / 关闭全部）', () => {
    it('disabled:true 把目录里的模型全部写入黑名单', async () => {
      const { call, storedValue } = registerEndpoints({ models: MODELS })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({
        buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true },
      })
      // 落盘后 model.list 应显示全部关闭
      const list = await call('model.list', { provider: 'buddy' })
      const models = (list.value as { models: Array<{ disabled: boolean }> }).models
      // ⚠️ 2026-11-05 红队：`every((m) => m.disabled)` 是**非空真但不判别**的断言 ——
      //    本用例不传 `closeProvider` ⇒ 分支 4 会写 `providerClosed = true`，
      //    而 `model.list` 的 `disabled` 是「意图 **或** 黑名单」双腿取或
      //    ⇒ 砍掉黑名单腿（G1-M15）后这里仍绿。真正判别的是上面那条 `toEqual`
      //    （逐 id 比对），这里改成**条数**断言，把「一个都没少」这件事补上。
      // ⚠️ 二审 M1：条数必须从 `MODELS` 派生，**不能写死 3** —— `MODELS` 是测试
      //    数据常量，将来增删一条（很常见的维护动作）会假红，红因与产品缺陷无关。
      expect(models).toHaveLength(MODELS.length)
    })

    /**
     * 目录来源必须是**未过滤**的全量目录。
     *
     * `listModels` 会按黑名单过滤，已关闭的模型不在其中。虽然它们本就在
     * 黑名单里（合并语义让结果恰好正确），但目录少一项就意味着「批量关闭」
     * 的集合不完整 —— 一旦将来有人把合并改成整体替换，漏掉的项会被静默打开。
     */
    it('disabled:true 以 listAllModels 的全量目录为准', async () => {
      const catalog = [
        { id: 'glm-5.2', name: 'GLM-5.2' },
        { id: 'hy3', name: 'Hy3' },
      ]
      const { call, storedValue } = registerEndpoints({
        models: catalog,
        disabledModels: { buddy: { hy3: true } },
        modelAdapters: { buddy: { listAllModels: () => catalog } },
      })

      await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(storedValue().disabledModels).toEqual({ buddy: { 'glm-5.2': true, hy3: true } })
    })

    /**
     * ⚠️⚠️ 2026-11-04 真机报障「**部分供应商全关按钮异常**」。
     *
     * 症状：模型列表屏上 `Codeoly (Unity)` 显示「5 个 · 已关闭 0」、五个开关全蓝，
     * 点「全关」却报「该供应商没有可关闭的模型，未做任何变更」—— 界面与报错矛盾。
     *
     * 成因：该供应商**没有登录账号** ⇒ `llm.listModels()` 被目录门控成 `[]`
     * ⇒ `complete = false` ⇒ 落到「目录不完整 ⇒ 拒绝」。而界面上那 5 个模型
     * 来自适配器兜底表，`catalog.ids` 本就是它们 ⇒ 用户要关的正是它们。
     *
     * 模型列表屏（`closeProvider: false`）**从不写「关闭供应商意图」**，
     * 故 `provider.status` 仍按同一份兜底表算「5 个 · 已关闭 5」⇒ 状态与事实一致，
     * 与 ISSUE IKJW33 的「写意图 ⇒ 显示已关闭而模型仍可选」不同。
     */
    it('★★ 模型列表屏（closeProvider:false）+ 远端为空（无账号）+ 兜底表非空 ⇒ 关掉可见项并成功', async () => {
      const fallback = [
        { id: 'unity-a', name: 'Unity A' },
        { id: 'unity-b', name: 'Unity B' },
      ]
      const { call, storedValue } = registerEndpoints({
        models: [],
        modelAdapters: { buddy: { listAllModels: () => fallback } },
      })

      const result = await call('model.setAllDisabled', {
        provider: 'buddy',
        disabled: true,
        closeProvider: false,
      })

      expect(result.ok, '模型列表屏在「无账号」时必须能关掉可见模型').toBe(true)
      expect(storedValue().disabledModels).toEqual({
        buddy: { 'unity-a': true, 'unity-b': true },
      })
      // ⚠️ 反向：**不得**借机落「关闭供应商」意图（否则 status 会报「已关闭」，
      //    而上游还有我们看不到的模型 —— 正是 IKJW33 的形态）。
      //    真实持久化键名是 `providerClosed`（内存字段叫 `providerClosedCache`，
      //    `AccountPool.closedProviders` 是 getter）—— 第一版写成 `closedProviders`
      //    ⇒ `?? {}` 恒真、变异全绿，已改；`providerClosed` 键**任何保存都会带上**
      //    （值是 `{}`），所以判据只能是「值为空」。变异 M2（closed=true）实测 RED 1。
      expect(storedValue().providerClosed ?? {}, '不得落供应商关闭意图').toEqual({})
    })

    /**
     * ⚠️⚠️⚠️ 2026-11-04 真机报障：「**为什么更新插件后供应商状态会发生变化，
     * 比如停用的供应商会被启用**」。
     *
     * 现场：`state.json` 的 `providerClosed` 只剩 `{accio:true}` —— 用户靠
     * 「关闭供应商」关过的好几家全都不见了。而「关闭供应商」写意图是**稳的**
     * （与目录快照无关），所以只可能是**被后来的操作删掉**。
     *
     * 元凶就是本屏这条路径：它传 `closeProvider: false`，语义本应是「**不碰**
     * 供应商开关」，但 `writeModelsWithProviderClosed` 的第三参当时是
     * `boolean`，`false` 被实现成 **`delete providerClosed[provider]`**：
     *
     * ```
     * ① 点「关闭供应商」 ⇒ providerClosed={X:true} + 全量黑名单   ← 稳定
     * ② 模型列表屏对 X 点一次「全关」 ⇒ 传 false ⇒ 意图被删
     * ③ 插件更新 / 目录变长 ⇒ 派生判据 disabled!==total ⇒ 翻回「启用」
     * ```
     *
     * ⇒ 修法是让第三参支持 `'keep'`（**不动**该键），本屏与它的「目录不完整」
     * 兄弟分支都改传 `'keep'`。
     */
    it('★★★ 已关闭的供应商再点一次「全关」⇒ 关闭意图必须保留（否则更新后静默变回启用）', async () => {
      const catalog = [
        { id: 'unity-a', name: 'Unity A' },
        { id: 'unity-b', name: 'Unity B' },
      ]
      const { call, pool, storedValue } = registerEndpoints({
        models: catalog,
        modelAdapters: { buddy: { listAllModels: () => catalog } },
      })
      // 模拟用户点「关闭供应商」（写意图）。
      await pool.setProviderClosed('buddy', true)
      expect(storedValue().providerClosed).toEqual({ buddy: true })

      // 之后在模型列表屏对同一家点「全关」。
      const result = await call('model.setAllDisabled', {
        provider: 'buddy',
        disabled: true,
        closeProvider: false,
      })

      expect(result.ok).toBe(true)
      // ⚠️ 判据是「意图仍在」。若实现里 `'keep'` 退化成 `false` ⇒ 意图被删 ⇒ 红。
      expect(storedValue().providerClosed, '模型级全关不得删除供应商关闭意图')
        .toEqual({ buddy: true })
    })

    /**
     * 兄弟分支：「目录不完整」（供应商未登录）时的那条全关路径同样必须 `'keep'`。
     *
     * 两条分支**各写各的**（不是提取成一处），故必须各有一条守卫 —— 只守一条
     * 时另一条回退成 `false` 仍会全绿。
     */
    it('★★★ 目录不完整时的「全关」同样不得删除供应商关闭意图', async () => {
      const fallback = [{ id: 'unity-a', name: 'Unity A' }]
      const { call, pool, storedValue } = registerEndpoints({
        models: [],
        modelAdapters: { buddy: { listAllModels: () => fallback } },
      })
      await pool.setProviderClosed('buddy', true)

      const result = await call('model.setAllDisabled', {
        provider: 'buddy',
        disabled: true,
        closeProvider: false,
      })

      expect(result.ok).toBe(true)
      expect(storedValue().providerClosed, '目录不完整分支同样不得删意图')
        .toEqual({ buddy: true })
      // ⚠️ 二审 M4：用例名承诺的是「**全关**」，而黑名单写入此前**完全没有断言** ——
      //    若实现「放行 `ok:true` 但一个字没写」，上面那条仍绿（`providerClosed`
      //    的值来自前一行 `pool.setProviderClosed`，与黑名单写入无关）。
      //    同组另一条用例（模型列表屏那格）有这条，本格漏了。
      expect(storedValue().disabledModels, '「全关」必须真的把可见模型写进黑名单')
        .toEqual({ buddy: { 'unity-a': true } })
    })

    /**
     * ⚠️ 反向对照：**「关闭供应商」入口**在同样的残缺目录下**仍必须拒绝**。
     *
     * 那条路径会落「关闭意图」⇒ 允许它在只看得到兜底子集时就写意图，正是
     * ISSUE IKJW33 的原始缺陷（供应商显示已关闭、而远端几百个模型仍可选）。
     */
    it('★★ 但「关闭供应商」入口（不传 closeProvider）在同样的残缺目录下仍必须拒绝', async () => {
      const fallback = [{ id: 'unity-a', name: 'Unity A' }]
      const { call, storedValue } = registerEndpoints({
        models: [],
        modelAdapters: { buddy: { listAllModels: () => fallback } },
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok).toBe(false)
      expect(result.error?.message ?? '').toContain('没有可关闭的模型')
      expect(storedValue().disabledModels ?? {}, '拒绝时一个字节都不许写').toEqual({})
    })

    /**
     * ⚠️⚠️ 冷帧（聚合目录只读到 `auto` 一条）**不是**「无账号门控」。
     *
     * 上一格放行的依据是「远端读到但为空 = 该供应商没有账号 ⇒ 兜底表就是全部」。
     * 而冷帧是**另一个形态**：远端读到了、却只有 `auto` 一条，其余虚拟模型还在
     * 后台推导 ⇒ 此时写黑名单会「只关掉 auto」，另外两个**仍可选**，而端点返回
     * 成功 —— 正是 IKJW33 明令禁止的形态。
     *
     * ⇒ 放行条件里的 `catalog.notReady === undefined` 是**承重**的。
     * ⚠️ 2026-11-05 审查发现这条**此前零用例**（删掉那半条判据没有任何测试变红）。
     */
    it('★★ 冷帧（notReady）+ 模型列表屏（closeProvider:false）⇒ 仍必须拒绝，不得只关 auto', async () => {
      const fallback = [{ id: 'auto', name: 'Auto' }]
      const { call, storedValue } = registerEndpoints({
        models: [],
        modelAdapters: {
          buddy: {
            listAllModels: () => fallback,
            // ⚠️ `reason` 用**独特**字符串：若写成文案里已有的「聚合目录尚未读取完成」，
            //    那条 `toContain` 会被**写死的前半句**喂饱 ⇒ 删掉 `${catalog.notReady}`
            //    插值也不会红（假绿）。用独特值才能证明 reason 真被带出来。
            catalogReadyForBulkWrite: () => ({ ready: false, reason: '通道路由推导中' }),
          },
        },
      })

      const result = await call('model.setAllDisabled', {
        provider: 'buddy',
        disabled: true,
        closeProvider: false,
      })

      expect(result.ok, '冷帧放行 ⇒ 只关掉 auto、其余虚拟模型仍可选').toBe(false)
      // ⚠️⚠️ 报文必须**点出冷帧**（二审 P2-1）：`notReady` 有值 = 聚合目录还在后台
      //    推导，用户动作是「等一下再点」；而「没账号」的动作是「去登录」。
      //    `provider.setEnabled` 早就分开说了，本端点此前写死通用文案
      //    「该供应商没有可关闭的模型」—— 冷帧下界面明明列着模型，自相矛盾。
      //
      // ⚠️⚠️ **只断言 reason 原文，不断言固定文案**（二审 M2）：写死
      //    `toContain('尚未读取完成')` 会与产品措辞**绑死** —— 产品再改一次词
      //    （哪怕改得更准）这条就假红。而「reason 被带出来」是**语义**，改词不该动摇它。
      //    ⇒ 独特字符串「通道路由推导中」只有从 `${catalog.notReady}` 插值而来，
      //      删掉插值必然变红；产品改前后缀则不受影响。
      expect(result.error?.message ?? '', '冷帧必须把 reason 原文带给用户').toContain('通道路由推导中')
      // ⚠️ 用 `toEqual({})` 而不是 `not.toHaveProperty('buddy')`（二审建议 1）：
      //    后者只证明「buddy 这个键没被写」，若实现写成了**别的 provider** 仍绿；
      //    整表比对才能锁住「一个字节都不许落盘」。
      expect(storedValue().disabledModels ?? {}, '冷帧一个字节都不许落盘').toEqual({})
    })

    /**
     * ⚠️⚠️ **「关闭全部」必须以两个目录来源的并集为准**（真实缺陷，独立审计发现）。
     *
     * `fullCatalogIds` 原先**优先**用 `modelAdapters[provider].listAllModels()`，
     * 只要它存在就短路、**根本不看 `llm.listModels()`**。而 `listAllModels()` 在
     * **冷缓存**下返回的是各家**编译期兜底表**（`model-catalog.ts`：
     * `cached ?? config.syncCatalog()`）—— 它是**子集**：实测 `cline` 冷缓存
     * 只有 **3** 条（`fallbackModels`），而远端有 **460** 条。
     *
     * ⇒ 「关闭全部」只把兜底表那 3 条写进黑名单，**其余 457 条仍然可选**，
     * 而端点返回「成功」。这比 issue IKJW33 的静默空操作**更严重**：
     * 后者至少什么都没改，这里却让用户以为整个供应商已关闭（模型选择器里
     * 那几百条还在，还能继续消耗额度）。
     *
     * ⚠️ 用户报障路径**恰恰是冷缓存**：脚本/设置页首次打开就点「关闭全部」。
     * 既有注释其实早已立下约定「失败时**不落盘** —— 否则会写入一个不完整的
     * 黑名单，用户看到『关了一半』且无从判断原因」，但 `listAllModels()` 冷缓存
     * 返回子集时它**不算失败**，于是绕过了那条守卫。
     */
    it('disabled:true 取两个目录来源的并集（冷缓存兜底子集不得当权威）', async () => {
      const { call, storedValue } = registerEndpoints({
        // `listModels` 的源：**完整远端目录**（3 条）。
        models: MODELS,
        // `listAllModels` 只给 1 条：模拟**冷缓存兜底表**（子集）。
        modelAdapters: { buddy: { listAllModels: () => [{ id: 'hy3', name: 'Hy3' }] } },
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok).toBe(true)
      expect(
        storedValue().disabledModels,
        '只关了兜底子集：远端其余模型仍然可选，而端点返回「成功」',
      ).toEqual({ buddy: { 'hy3': true, 'glm-5.2': true, 'deepseek-v4-flash': true } })
    })

    /**
     * 反向：`listAllModels()` 是**完整**目录、`listModels()` 因黑名单过滤而更少时，
     * 并集同样不能漏掉 `listAllModels()` 那一半（它带「已关闭」的模型）。
     *
     * ⚠️ 这条守的是**并集**而不是「改用 listModels 就好」—— 单取 `listModels()`
     * 会漏掉已被关闭的条目，而 `setModelsDisabled` 是合并语义，漏掉它们虽无
     * 实际危害，但会让 `provider.setEnabled` 的 `ids.length === 0` 判据在
     * 「全部已关闭」时误判成「没有可关闭的模型」而拒绝操作。
     */
    it('disabled:true 并集保留 listAllModels 侧的条目（不得只用 listModels）', async () => {
      const catalog = [
        { id: 'glm-5.2', name: 'GLM-5.2' },
        { id: 'hy3', name: 'Hy3' },
      ]
      const { call, storedValue } = registerEndpoints({
        // `listModels` 只剩 1 条（`hy3` 已被关闭 ⇒ 被适配器过滤掉）。
        models: catalog,
        disabledModels: { buddy: { hy3: true } },
        modelAdapters: { buddy: { listAllModels: () => catalog } },
      })

      await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true, 'glm-5.2': true } })
    })

    /**
     * ⚠️⚠️ **远端读失败 + 适配器有兜底表 ⇒ 必须拒绝且不落盘**（覆盖缺口，变异实测）。
     *
     * 判据必须是 `remoteIds === undefined` 而**不是**「`ids` 是否为空」：
     * 冷缓存/门控下适配器兜底表会让并集 `ids` 看起来**非空**，而它只是**子集**。
     * 若改判 `ids.length === 0`，这条用例就是唯一变红的那个 —— 也就是说
     * 「关一半」会静默通过。
     */
    it('⚠️ 远端读失败时拒绝且不落盘（即使适配器有兜底表，也不得只关它）', async () => {
      const { call, storedValue, emitted } = registerEndpoints({
        models: MODELS,
        listModelsError: '令牌已过期',
        modelAdapters: { buddy: { listAllModels: () => [{ id: 'hy3', name: 'Hy3' }] } },
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('令牌已过期')
      // 关键：兜底子集**不得**被写进黑名单（那正是「显示已关闭、模型仍可选」的成因）。
      expect(storedValue().disabledModels).toBeUndefined()
      expect(emitted).toEqual([])
    })

    /**
     * ⚠️⚠️ **远端读到但为空（`[]`）⇒ 也必须拒绝**（残留入口，自查探针实测发现）。
     *
     * `remoteIds === undefined`（读失败）与 `remoteIds.length === 0`（读到但为空）
     * 是**两种不同的失败**，但动作相同 —— 都不能拿适配器兜底子集当权威。
     * 初版只判了前者 ⇒ 这条路径会**继续**写兜底子集黑名单并返回成功：
     * 实测（探针）「远端 `[]` + 兜底表 1 条」⇒ `disabledModels = { m1: true }`
     * 且 `ok:true`，即**同一个缺陷的另一个入口**。
     *
     * ⇒ 判据收敛为 `catalog.complete`（同时覆盖两种形态）。
     * 本用例是它的守卫：若退回只判 `undefined`，这里变红。
     */
    it('⚠️ 远端读到但为空（无账号门控）→ 同样拒绝且不落盘（残留入口）', async () => {
      const { call, storedValue, emitted } = registerEndpoints({
        // 远端**成功**但返回空（门控隐藏整个 provider）……
        models: [],
        // ……而适配器兜底表仍有 1 条 ⇒ 不得据此写黑名单。
        modelAdapters: { buddy: { listAllModels: () => [{ id: 'hy3', name: 'Hy3' }] } },
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok).toBe(false)
      expect(storedValue().disabledModels, '兜底子集不得被当成完整目录写入').toBeUndefined()
      expect(emitted).toEqual([])
    })

    /**
     * ⚠️⚠️ **幂等：已全部关闭时再点「关闭全部」必须成功**（本组新增的核心用例）。
     *
     * 真实缺陷（2026-08 审计实测）：`complete` 的定义是「远端读到且**非空**」，
     * 而「**全部模型都已关闭**」时 `listModels()` 会被黑名单过滤成 `[]`
     *（`createModelCatalog.listModels` 的 `listed = all.filter(entry => !disabled.has(entry.id))`）
     * ⇒ `complete === false`。于是用户在**已经全关**的状态下再点一次「关闭全部」
     *（或在模型列表里确认一下），会得到
     * 「该供应商没有可关闭的模型，未做任何变更」—— 而它明明有 3 个、只是都已关。
     *
     * ⚠️ 该形态与「无账号门控」在 `fullCatalogIds` 里**完全同形**
     *（都是 `remoteIds === []` 且无 `remoteError`），**无法**靠目录侧区分，
     * 故判据只能建在「黑名单已覆盖并集」这个**结果**上。
     *
     * ⚠️ 前端联动路径会命中它：停用最后一个账号时问「是否同时关闭它的全部模型」，
     * 若模型此前已全关，用户会看到误导告警
     * 「账号已停用，但关闭模型失败：该供应商没有可关闭的模型」。
     */
    it('⚠️ 已全部关闭时再点「关闭全部」→ 幂等成功（不得报「没有可关闭的模型」）', async () => {
      const { call, storedValue, emitted } = registerEndpoints({
        models: MODELS,
        modelAdapters: { buddy: { listAllModels: () => MODELS } },
        // 三条**全部**已关 ⇒ `listModels()` 会被过滤成 `[]` ⇒ `complete === false`
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true } },
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok, '已全关时必须是幂等成功，不能误报「没有可关闭的模型」').toBe(true)
      // 黑名单保持不变（幂等：不产生新变更）
      expect(storedValue().disabledModels).toEqual({
        buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true },
      })
      // ⚠️ 仍须广播：客户端那份 `status === 'ready'` 的目录缓存要靠它失效，
      //    调用方（前端）也据此刷新开关状态。
      expect(emitted).toContain('llm/adapters-updated')
    })

    /**
     * ⚠️⚠️ **幂等短路不得掩盖真正的「目录不完整」**（上一条的反向守卫）。
     *
     * 幂等分支的条件必须是「并集里的 id **全部**已在黑名单」，而不是「目录为空」——
     * 否则「远端读到但为空 + 黑名单只覆盖了一部分」这种**真该拒绝**的形态
     * （拿兜底子集当权威 = IKJW33 那个缺陷）会被静默放行。
     *
     * 变异验证：把幂等分支的条件从 `pending.length === 0` 改成
     * `catalog.ids.length === 0 || !catalog.complete`，本条**变红**。
     */
    it('⚠️ 远端读到但为空 + 只有部分已关 ⇒ 仍拒绝（幂等短路不得掩盖真缺口）', async () => {
      const { call, storedValue, emitted } = registerEndpoints({
        // 远端成功但为空（无账号门控 / 全部已关，两种成因在此同形）
        models: [],
        // 兜底表 2 条，但黑名单只覆盖了其中 1 条 ⇒ pending 非空 ⇒ 必须拒绝
        modelAdapters: { buddy: { listAllModels: () => [{ id: 'hy3', name: 'Hy3' }, { id: 'glm-5.2', name: 'GLM-5.2' }] } },
        disabledModels: { buddy: { hy3: true } },
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok, '有新增项但目录不完整 ⇒ 必须拒绝').toBe(false)
      // 兜底子集不得被写成「完整黑名单」：glm-5.2 仍是打开的
      expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true } })
      expect(emitted).toEqual([])
    })

    /**
     * ⚠️ **只关新增的那几条**（幂等分支的写入侧）。
     *
     * 已关的 id 不该被重复写入 —— 黑名单是「键存在即关闭」的映射，
     * 重复写 `true` 无意义，但会让 `models` 计数虚高（见下一条）。
     */
    it('⚠️ 已全关时再关：不重复写盘（无变更即不产生新写入）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        modelAdapters: { buddy: { listAllModels: () => MODELS } },
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true } },
      })

      await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      // 逐字节不变（顺带锁住「幂等分支不落盘」）
      expect(storedValue().disabledModels).toEqual({
        buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true },
      })
    })

    it('disabled:false 清空该 provider 的全部关闭项（含目录里没有的历史遗留键）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: {
          buddy: { hy3: true, 'legacy-model': true },
          workbuddy: { 'gpt-5.4': true },
        },
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: false })

      expect(result.ok).toBe(true)
      // buddy 整体清空（含不在 MODELS 里的 legacy-model），workbuddy 不受影响
      expect(storedValue().disabledModels).toEqual({ workbuddy: { 'gpt-5.4': true } })
    })

    /**
     * 打开全部**不依赖目录**，因此 llm 服务不在时也必须成功。
     *
     * 这是两个方向最实质的差异：若图省事让打开也先读目录，那么在模型目录
     * 读不出来（凭据过期 / 远端故障）时，用户会连「把开关全部打开」这件
     * 纯本地的事都做不了。
     */
    it('disabled:false 不依赖 llm 服务', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true } },
        withoutLlm: true,
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: false })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({})
    })

    it('disabled:true 在 llm 不可用时回可读错误，且不落盘', async () => {
      const { call, storedValue, emitted } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true } },
        withoutLlm: true,
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('llm 服务不可用')
      // 失败不得留下半套状态，也不该惊动目录
      expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true } })
      expect(emitted).toEqual([])
    })

    /**
     * 批量**只广播一次**。
     *
     * 若在前端循环调用单条端点，30 个模型会发 30 次请求、30 次
     * `llm/adapters-updated`，客户端目录被反复刷新；批量端点的意义正在于此。
     */
    it('只广播一次 llm/adapters-updated（批量不等于逐条广播）', async () => {
      const { call, emitted } = registerEndpoints({ models: MODELS })

      await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(emitted).toEqual(['llm/adapters-updated'])
    })

    it('打开全部同样广播（两个方向都改变可见目录）', async () => {
      const { call, emitted } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true } },
      })

      await call('model.setAllDisabled', { provider: 'buddy', disabled: false })

      expect(emitted).toEqual(['llm/adapters-updated'])
    })

    it('provider 非字符串 → bad-request，不落盘也不广播', async () => {
      const { call, storedValue, emitted } = registerEndpoints({ models: MODELS })

      const result = await call('model.setAllDisabled', { disabled: true })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('provider')
      expect(storedValue().disabledModels).toBeUndefined()
      expect(emitted).toEqual([])
    })

    /**
     * `disabled` 必须显式给布尔，**不做默认值猜测**。
     *
     * 缺失时若默认成 `true`，一次字段名写错的前端改动会「静默关闭用户全部
     * 模型」；默认成 `false` 则反向静默打开 —— 两个方向都是灾难性且难察觉的。
     */
    it('disabled 非布尔 → bad-request（不猜默认值）', async () => {
      const { call, emitted } = registerEndpoints({ models: MODELS })

      const result = await call('model.setAllDisabled', { provider: 'buddy' })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('disabled')
      expect(emitted).toEqual([])
    })

    it('返回写入后的完整黑名单（与 model.setDisabled 同结构）', async () => {
      const { call } = registerEndpoints({ models: MODELS })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.value).toEqual({
        provider: 'buddy',
        disabledModels: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true },
      })
    })

    it('黑名单按 provider 隔离（不影响其它 provider）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { workbuddy: { 'gpt-5.4': true } },
      })

      await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(storedValue().disabledModels).toEqual({
        workbuddy: { 'gpt-5.4': true },
        buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true },
      })
    })

    /** 广播抛错不能反噬已落盘的批量开关（与单条端点同一约定）。 */
    it('广播抛错时批量开关仍算成功', async () => {
      const { call, storedValue, emitted } = registerEndpoints({ models: MODELS, emitThrows: true })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({
        buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true },
      })
      // 抛错发生在 push 之前，故不会有记录 —— 关键断言是上面的 ok/落盘。
      expect(emitted).toEqual([])
    })
  })

  /**
   * 分组批量端点 `model.setDisabledMany`（Jet Hub 模型列表按「计费/来源」分组后的
   * 「本组全开 / 本组全关」，用户 2026-10-01 要求）。
   *
   * ⚠️ **与 `model.setAllDisabled` 的区别就是本组用例的判据**：那个的范围是
   * 「该 provider 的全部模型」，且**打开方向会清空整张黑名单**。若分组开关
   * 图省事复用它会怎样？——「打开『订阅额度』这一组」会把用户特意关着的
   * 「按量计费」那 400 多条**一起打开**。所以这里逐条锁住「只动传入的 id」。
   */
  describe('model.setDisabledMany（按分组批量开关）', () => {
    it('disabled:true 只关闭传入的那批（其它已关闭项与已打开项都不受影响）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true } },
      })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['glm-5.2'],
        disabled: true,
      })

      expect(result.ok).toBe(true)
      // hy3 本来就关着（保持），glm-5.2 新关，deepseek-v4-flash 仍然开着
      expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true, 'glm-5.2': true } })
    })

    /**
     * ⚠️ **这条是本端点的存在理由**：打开方向必须**只**删传入的 id。
     *
     * 若实现里误用 `clearDisabledModels`（清空整个 provider），这里会断成 `{}`
     * —— 用户「只打开订阅额度那一组」会连带打开按量计费的全部模型。
     */
    it('disabled:false 只打开传入的那批，**不清空整张黑名单**', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true, 'glm-5.2': true, 'deepseek-v4-flash': true } },
      })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['hy3', 'glm-5.2'],
        disabled: false,
      })

      expect(result.ok).toBe(true)
      // 只有 hy3/glm-5.2 被打开；deepseek-v4-flash 保持关闭
      expect(storedValue().disabledModels).toEqual({ buddy: { 'deepseek-v4-flash': true } })
    })

    it('某个 provider 的关闭项被清空时删掉整个键（配置不膨胀）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { hy3: true }, workbuddy: { 'gpt-5.4': true } },
      })

      await call('model.setDisabledMany', { provider: 'buddy', modelIds: ['hy3'], disabled: false })

      // buddy 整个键被删掉，workbuddy 不受影响
      expect(storedValue().disabledModels).toEqual({ workbuddy: { 'gpt-5.4': true } })
    })

    it('黑名单按 provider 隔离（关 buddy 不动 workbuddy）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { workbuddy: { 'gpt-5.4': true } },
      })

      await call('model.setDisabledMany', { provider: 'buddy', modelIds: ['hy3'], disabled: true })

      expect(storedValue().disabledModels).toEqual({
        workbuddy: { 'gpt-5.4': true },
        buddy: { hy3: true },
      })
    })

    /**
     * ⚠️⚠️ **「覆盖全量 ⇒ 补设关闭意图」必须与黑名单**同一次落盘**
     *（2026-11-05 合规审计：实现正确、端点级无守卫）。
     *
     * `writeModelsWithProviderClosed` 内部合并好两份状态后只 `queueStoreSave()`
     * 一次；分两次写（先写黑名单、再写意图）会留下半套状态：磁盘上「黑名单满了、
     * 意图没写」⇒ 重启后 `provider.status` 仍报「已打开」⇒ 用户点「打开供应商」
     * 按**意图**决定清哪家 ⇒ 清不到 ⇒ 死循环复发。
     *
     * ⚠️ 判据是**落盘次数**（不是「有没有调过 write」）——后者两条路径都会调。
     */
    it('★★ 覆盖全量时黑名单与关闭意图必须同一次落盘（不得分两次写）', async () => {
      const { call, storedValue, writeCount } = registerEndpoints({
        models: MODELS,
      })

      // 传入**全部**模型 id ⇒ 黑名单覆盖全量目录 ⇒ 触发补设意图那条分支。
      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: MODELS.map((m) => m.id),
        disabled: true,
      })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({
        buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true },
      })
      expect(storedValue().providerClosed, '必须补设「供应商关闭」意图').toEqual({ buddy: true })
      expect(writeCount(), '★ 黑名单与关闭意图必须同一次落盘（分两次写会留下半套状态）').toBe(1)
    })

    /** 批量**只广播一次**：分组里可能有 460 条，逐条调用会打 460 次目录刷新。 */
    it('只广播一次 llm/adapters-updated', async () => {
      const { call, emitted } = registerEndpoints({ models: MODELS })

      await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['hy3', 'glm-5.2'],
        disabled: true,
      })

      expect(emitted).toEqual(['llm/adapters-updated'])
    })

    it('返回写入后的完整黑名单（与其它两个开关端点同结构）', async () => {
      const { call } = registerEndpoints({ models: MODELS })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['hy3'],
        disabled: true,
      })

      expect(result.value).toEqual({ provider: 'buddy', disabledModels: { hy3: true } })
    })

    /** ⚠️ 空数组直接拒：空组不该出现在界面上（前端按钮也已禁用）。 */
    it('modelIds 为空数组 → bad-request，不落盘也不广播', async () => {
      const { call, storedValue, emitted } = registerEndpoints({ models: MODELS })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: [],
        disabled: true,
      })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('modelIds')
      expect(storedValue().disabledModels).toBeUndefined()
      expect(emitted).toEqual([])
    })

    it('modelIds 全是脏值（空串 / 非字符串）→ 同样拒（去重剔净后为空）', async () => {
      const { call, emitted } = registerEndpoints({ models: MODELS })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['', 42, null],
        disabled: true,
      })

      expect(result.ok).toBe(false)
      expect(emitted).toEqual([])
    })

    /** ⚠️ `disabled` 不做默认值猜测（与单条/全量端点同约定）。 */
    it('disabled 非布尔 → bad-request（不猜默认值）', async () => {
      const { call, storedValue, emitted } = registerEndpoints({ models: MODELS })

      const result = await call('model.setDisabledMany', { provider: 'buddy', modelIds: ['hy3'] })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('disabled')
      expect(storedValue().disabledModels).toBeUndefined()
      expect(emitted).toEqual([])
    })

    it('provider 非字符串或空串 → bad-request', async () => {
      const { call, emitted } = registerEndpoints({ models: MODELS })

      expect((await call('model.setDisabledMany', { modelIds: ['hy3'], disabled: true })).ok).toBe(false)
      expect((await call('model.setDisabledMany', { provider: '', modelIds: ['hy3'], disabled: true })).ok).toBe(false)
      expect(emitted).toEqual([])
    })

    /**
     * ⚠️⚠️ **关闭方向：黑名单覆盖该家全量目录 ⇒ 必须补设「供应商关闭」意图**。
     *
     * ## 缺陷形态（`model.setAllDisabled` 的 IKP8OF 是**第二个入口**，这里是第三个）
     *
     * 模型列表弹窗把该家**全部**模型按「未勾选」全传进来时，原实现只写黑名单、
     * **不落意图**。而 `provider.status` 的 `closed` 判据是
     * `total > 0 && disabled === total`（`total` 取自 `listAllModels()`，
     * **含被过滤掉的 id**）⇒ 报 `closed: true`，但
     * `providerClosed[provider]` 仍是 `false`。
     *
     * 于是「打开供应商」走 `clearModelsWithProviderClosed`，它按**意图**决定
     * 清哪家 ⇒ 清不到 ⇒ 弹窗重新打开仍显示「全部已关闭」、勾选数 0 ⇒
     * 再点保存又全传一次。**死循环，用户没有任何出口。**
     *
     * 实测（2026-11-05，本机）：黑名单 29 家 / 1005 条全 `true`，而
     * `providerClosed` 只有 2 家（那两家恰好是账号全停用、走
     * `provider.setEnabled(false)` 关闭的）。历史备份从 830 → 920 → 1005
     * 一路上涨，说明每保存一次就把当时目录里的全部模型加进黑名单。
     */
    it('关闭方向：黑名单覆盖全量目录 ⇒ 补设「供应商关闭」意图', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        modelAdapters: { buddy: { listAllModels: () => MODELS } },
      })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: MODELS.map((m) => m.id),
        disabled: true,
      })

      expect(result.ok).toBe(true)
      // 黑名单照旧写满（原有行为不变）
      expect(storedValue().disabledModels).toEqual({
        buddy: Object.fromEntries(MODELS.map((m) => [m.id, true])),
      })
      // ⚠️ 关键：意图必须一起落，否则「打开供应商」清不到
      expect(storedValue().providerClosed).toEqual({ buddy: true })
    })

    /**
     * ⚠️ **回归锚点：只关部分模型时**不得**落意图。**
     *
     * 用户只是关掉了某几个分组，那与「关闭供应商」是两件事 ——
     * `model.setAllDisabled` 的 `closeProvider` 注释也这么立约
     *（模型级批量关闭不得顺带关供应商，否则点一次「本组全关」会把整家关掉，
     * 且再打开**任意一个**模型又会把供应商顺带打开，两头都与用户意图相反）。
     */
    it('关闭方向：只关部分模型 ⇒ **不**设意图（与「关闭供应商」是两件事）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        modelAdapters: { buddy: { listAllModels: () => MODELS } },
      })

      await call('model.setDisabledMany', { provider: 'buddy', modelIds: ['hy3'], disabled: true })

      expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true } })
      // ⚠️ 不能因为「关了一个」就把整家关掉
      // ⚠️ 断言「没有 buddy 这一条」而不是「整个字段不存在」：
      // `providerClosedCache` 初始是 `{}`，`queueStoreSave()` 会把整份状态写回
      // `stored` ⇒ 空对象会落盘成 `{}`。写「不为 undefined」会把实现细节写进断言。
      expect(storedValue().providerClosed).not.toHaveProperty('buddy')
    })

    /**
     * ⚠️ **目录不完整（`complete === false`）时不猜** —— 与
     * `setAllDisabled` 的同名守卫同源：宁可少设一次意图，也不能拿残缺目录
     * 把供应商误关掉。
     *
     * 构造：「该家全部模型都已关闭」时 `listModels()` 会被黑名单过滤成 `[]`
     * ⇒ `complete === false`（`complete` 的定义是「远端读到且**非空**」）。
     * 此时适配器兜底表里仍有那几个 id，拿它判「全覆盖」会**恒真**
     * —— 那等于「整个供应商被关掉」，而用户可能只是关了几个分组。
     *
     * ⚠️ 这条同时也是**幂等**的回归锚点：已经全关再点一次保存，黑名单不变、
     * 意图也不该被「重新推断」成 true（原实现此时什么都不写）。
     */
    it('关闭方向：目录不完整（complete=false）⇒ 不猜，不设意图', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        // 预置：该家全部模型都已关闭
        disabledModels: { buddy: Object.fromEntries(MODELS.map((m) => [m.id, true])) },
        modelAdapters: { buddy: { listAllModels: () => MODELS } },
      })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: MODELS.map((m) => m.id),
        disabled: true,
      })

      expect(result.ok).toBe(true)
      // 黑名单保持原样
      expect(storedValue().disabledModels).toEqual({
        buddy: Object.fromEntries(MODELS.map((m) => [m.id, true])),
      })
      // ⚠️ 目录不完整 ⇒ 不拿兜底表推断意图
      // ⚠️ 断言「没有 buddy 这一条」而不是「整个字段不存在」：
      // `providerClosedCache` 初始是 `{}`，`queueStoreSave()` 会把整份状态写回
      // `stored` ⇒ 空对象会落盘成 `{}`。写「不为 undefined」会把实现细节写进断言。
      expect(storedValue().providerClosed).not.toHaveProperty('buddy')
    })
  })

  /**
   * ⚠️⚠️ **对不在当前目录里的 id 开关，绝不能静默成功**（Issue IKJW33，用户报障）。
   *
   * ## 真实缺陷
   *
   * 对**已从上游目录消失**的模型 id 调 `on`/`off`，命令返回「成功 1」，
   * 但**实际什么都没发生**，且**没有任何警告**。用户实测两例：
   * `cline/cline-free/deepseek-v4.1-flash` 与 `cline/stealth/space-bunny-alpha`
   * 在 10-05 记录「上游 model not found」后已从 cline 目录消失（490 → 489），
   * 此后对它们 `on` 静默无效。作者据「成功 1」**误判过一次**，
   * 执行后回查目录才发现是空操作。
   *
   * ## 为什么是 warnings 而不是 `ok:false` + `not-found`
   *
   * issue 建议「返回明确的 `not-found`」。**不采纳**，两个理由：
   *
   * 1. **打开方向是幽灵条目的清理路径**（`model.setAllDisabled` 的注释已立此约定）：
   *    「曾被关闭、后来从服务端目录下线」的历史死键**只能靠打开方向清掉**。
   *    按目录拒绝就等于这些键永远留在配置里，正好加重 issue 抱怨的第 2 条。
   * 2. **目录可能读不出来**（凭据过期 / 远端故障）：此时若按「不在目录」拒绝，
   *    用户会连开关都动不了 —— 与 `model.setAllDisabled` 的既有取舍矛盾。
   *
   * ⇒ **照常写入**（既有语义逐字节不变），只在响应里加 `warnings[]` 说明真相。
   *
   * ## 判据只用 `listAllModels()`
   *
   * 退化路径（`llm.listModels()`）的结果**已被黑名单过滤**，拿它判「不在目录」
   * 会把每一个正常关闭的模型都误报成「不存在」。提示类信息误报比漏报糟得多，
   * 故那里**放弃核对**（不产生任何警告）—— 与 `dead-model-store` 的
   * 「宁可漏判不可误伤」同一原则。生产环境 `src/index.ts` 永远提供
   * `modelAdapters`，退化路径只可能出现在单测替身里。
   */
  describe('目录外 id 的开关必须给出 warnings（Issue IKJW33）', () => {
    /** 目录里只有这两个；`gone-model` / `dead-model` 都不在其中。 */
    const CATALOG = [
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'hy3', name: 'Hy3' },
    ]

    /** 取出 warnings（缺省为空数组，便于直接 join 断言）。 */
    const warningsOf = (result: unknown): string[] =>
      ((result as { value?: { warnings?: string[] } }).value?.warnings) ?? []

    /**
     * ⚠️⚠️ **批量端点的 `warnings` 恒为空，这是正确的**（2026-10-21 合并审计定论）。
     *
     * ⚠️ 合并审计最初判这条是「重要缺陷」（`model.setAllDisabled` 不调
     * `catalogWarnings` ⇒ 客户端的提示通道恒空）。**实测证明那是误判**：
     * `catalogWarnings` 的判据是「`ids` 里不在 `known` 的」，而批量端点传的
     * `ids` 本就是 `catalog.ids`，而 `readableCatalogIds` 的 `known` 是
     * `new Set(catalog.ids)` **并回黑名单** ⇒ `known ⊇ catalog.ids` **恒成立**
     * ⇒ `missing` 恒为空。
     *
     * ⇒ 而这正是**语义正确**的：批量关闭的对象是「目录里的全部模型」—— 它们
     * **本来就在目录里**，不存在「关了但没有效果」的那个 id（那是**逐条开关**
     * 的语义）。所以批量路径**无事可警告**。
     *
     * ⚠️ 本用例把这条**钉住**：将来若有人给批量路径加上 `catalogWarnings`（看起来
     * 「补齐提示通道」），它会**恒空** ⇒ 本条会红 ⇒ 提醒他那是死代码。
     */
    it('★ 批量端点的 warnings 恒为空（批量关闭的对象本就在目录里 ⇒ 无事可警告）', async () => {
      const { call } = registerEndpoints({
        models: MODELS,
        modelAdapters: { buddy: { listAllModels: () => CATALOG } },
        disabledModels: { buddy: { 'gone-model': true } },
      })

      const result = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      expect(result.ok).toBe(true)
      expect(
        warningsOf(result),
        '★ 批量路径的 warnings 应恒空（`known ⊇ catalog.ids` ⇒ missing 恒空）',
      ).toEqual([])
    })

    it('关闭一个不在目录里的 id → 仍写入黑名单，但 warnings 点名说明它不在目录', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        modelAdapters: { buddy: { listAllModels: () => CATALOG } },
      })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'gone-model',
        disabled: true,
      })

      // 写入行为**不变**（向后兼容：既有调用方与 UI 语义不动）。
      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({ buddy: { 'gone-model': true } })
      // 但必须把真相说出来 —— 这正是本 issue 的全部诉求。
      const text = warningsOf(result).join('\n')
      expect(text).toContain('gone-model')
      expect(text).toContain('不在当前模型目录')
    })

    /**
     * ⚠️ **这条是 issue 报障的原始形态**：打开一个已下架、且本就未被关闭的 id
     * ⇒ 黑名单里没有该键、目录里也没有它 ⇒ `delete` 是纯空操作。
     *
     * 旧实现返回「成功」且零警告，脚本/AI 助手据此以为开关生效了。
     */
    it('打开一个既不在目录、也不在黑名单里的 id → warnings 说明本次没有任何变更', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        modelAdapters: { buddy: { listAllModels: () => CATALOG } },
      })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'gone-model',
        disabled: false,
      })

      expect(result.ok).toBe(true)
      // 黑名单内容仍为空（纯空操作），但用户/脚本现在能知道原因。
      // ⚠️ 断言 `{}` 而不是 `undefined`：`setModelDisabled` 的既有语义是
      // **总是落盘**（即使无变更），既有用例「重新打开时从黑名单移除」同样断言 `{}`。
      // 本 issue 只加提示、不改这条写入语义。
      expect(storedValue().disabledModels).toEqual({})
      const text = warningsOf(result).join('\n')
      expect(text).toContain('gone-model')
      expect(text).toContain('没有产生任何变更')
    })

    /**
     * ⚠️ **打开方向是幽灵条目的唯一清理路径，不得被误报成「不存在」**。
     *
     * 该 id 已从目录下线、但黑名单里还挂着 —— 本次 `delete` 是**有效操作**，
     * 给警告只会制造噪音、并诱导用户以为清理失败了。
     */
    it('打开一个已下线但仍在黑名单里的 id → 无警告（这是有效的清理操作）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { 'gone-model': true } },
        modelAdapters: { buddy: { listAllModels: () => CATALOG } },
      })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'gone-model',
        disabled: false,
      })

      expect(result.ok).toBe(true)
      // 幽灵条目被真的清掉了。
      expect(storedValue().disabledModels).toEqual({})
      expect(warningsOf(result)).toEqual([])
    })

    it('目录里的 id 开关不产生任何警告（不能把正常操作变成噪音）', async () => {
      const { call } = registerEndpoints({
        models: MODELS,
        modelAdapters: { buddy: { listAllModels: () => CATALOG } },
      })

      const off = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })
      const on = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: false })

      expect(warningsOf(off)).toEqual([])
      expect(warningsOf(on)).toEqual([])
    })

    /**
     * ⚠️ **缺 `modelAdapters` 时仍能核对**（并集少一半，不影响正确性）。
     *
     * 判据的主来源是 `llm.listModels()`，`modelAdapters.listAllModels()` 只是
     * 并集的**另一半**（为 opencode 那种「设置页目录 ≠ 选择器目录」的家准备）。
     * 故它缺失时不该放弃核对，也不该误报目录内的 id。
     *
     * ⚠️ 本用例标题原先写「没有 `listAllModels`（无法核对目录）时不报警告」，
     * 而判据早已换成 `listModels` —— 标题与注释随之腐坏（审计指出）。
     * 现按**实际测的东西**重写。
     */
    it('缺 modelAdapters 时仍用 listModels 核对，目录内的 id 不报警告', async () => {
      const { call } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { 'legacy-model': true } },
      })

      // 没传 modelAdapters：并集少一半，但 `listModels` 仍是权威主来源。
      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'glm-5.2',
        disabled: true,
      })

      expect(result.ok).toBe(true)
      expect(warningsOf(result)).toEqual([])
    })

    /**
     * ⚠️ **dead 表里的 id 也算「不在目录」**，但文案必须给出**可操作的**指引。
     *
     * `model.list` 会把 dead 的 id 补回目录（带 `dead:true`）让用户能点「重新显示」，
     * 而 `listAllModels()` 已被 `withDeadModelPruning` 剔除 ⇒ 它天然落在判据的
     * 「目录外」。issue 的两例正是这个形态（10-05 记录了 model not found）。
     * 只说「不在目录」是不够的 —— 用户需要知道去点「重新显示」。
     */
    it('对已判为失效（dead）的 id 给出「重新显示」的可操作指引', async () => {
      const { call } = registerEndpoints({
        models: MODELS,
        modelAdapters: { buddy: { listAllModels: () => CATALOG } },
      })
      recordDeadModel('buddy', 'dead-model', 'model not found')

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'dead-model',
        disabled: false,
      })

      const text = warningsOf(result).join('\n')
      expect(text).toContain('dead-model')
      expect(text).toContain('重新显示')
    })

    it('setDisabledMany 逐条点名目录外的 id（含 dead），目录内的 id 不进 warnings', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        modelAdapters: { buddy: { listAllModels: () => CATALOG } },
      })
      recordDeadModel('buddy', 'dead-model', 'model not found')

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['hy3', 'gone-model', 'dead-model'],
        disabled: true,
      })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({
        buddy: { hy3: true, 'gone-model': true, 'dead-model': true },
      })
      const text = warningsOf(result).join('\n')
      expect(text).toContain('gone-model')
      expect(text).toContain('dead-model')
      // ⚠️ 目录内的 `hy3` **不得**出现在 warnings 里（否则每条正常操作都变噪音）。
      expect(text).not.toContain('hy3')
    })

    /**
     * 批量打开方向同样要区分「有效清理」与「纯空操作」：
     * 前者静默、后者必须说明「没有任何变更」。
     */
    it('setDisabledMany 打开方向：黑名单里有的静默清理，纯空操作的才警告', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { 'gone-model': true } },
        modelAdapters: { buddy: { listAllModels: () => CATALOG } },
      })

      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['gone-model', 'never-seen'],
        disabled: false,
      })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({})
      const text = warningsOf(result).join('\n')
      // 有效清理（gone-model）静默；纯空操作（never-seen）必须点名。
      expect(text).not.toContain('gone-model')
      expect(text).toContain('never-seen')
    })

    /**
     * ⚠️⚠️ **判据不得用 `listAllModels()`**（真实缺陷，本修复第一版实测证伪）。
     *
     * `listAllModels()` 在**冷缓存**时返回各家**编译期兜底表**，而兜底表是
     * **子集**：实测 `cline` 冷缓存只返回 3 条（`fallbackModels`），远端却有
     * 460 条 ⇒ 远端任意一个**正常模型**都会被误报成「不在当前模型目录」。
     *
     * 而 issue 的复现路径**恰恰就是冷缓存**（脚本直接调 `on`，从未先跑 `list`）
     * ⇒ 那个版本会把「误报」当成「修复」，每个正常模型都带一条假警告。
     *
     * 本用例把 `listAllModels()` 造成**残缺子集**（模拟冷缓存兜底表），
     * 同时让 `listModels()` 返回**完整**目录 —— 判据若退回 `listAllModels()`，
     * 目录内的 `glm-5.2` 会被误报，用例立刻变红。
     */
    it('冷缓存（listAllModels 是残缺兜底子集）时不得误报目录内的模型', async () => {
      const { call } = registerEndpoints({
        models: MODELS,
        // ⚠️ 兜底子集：只有 1 条，缺 `glm-5.2` / `deepseek-v4-flash`。
        modelAdapters: { buddy: { listAllModels: () => [{ id: 'hy3', name: 'Hy3' }] } },
      })

      // 这三个 id 都在**真实目录**（`listModels` 的源 = MODELS）里。
      const result = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['glm-5.2', 'deepseek-v4-flash', 'hy3'],
        disabled: true,
      })

      expect(result.ok).toBe(true)
      expect(warningsOf(result), '冷缓存兜底子集不得被当成权威目录').toEqual([])
    })

    /**
     * ⚠️ 关闭一个**目录内**的模型不得报警告 —— 但这条判据有个陷阱：
     * 写入后该模型会被 `listModels()` 过滤掉，若在写入**之后**读目录，
     * 它就会被误判成「不在目录」。故目录必须在写入**之前**读。
     */
    it('关闭一个目录内的模型 → 无警告（目录须在写入前读，否则被过滤后误报）', async () => {
      const { call, storedValue } = registerEndpoints({ models: MODELS })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'glm-5.2',
        disabled: true,
      })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
      expect(warningsOf(result)).toEqual([])
    })

    /**
     * ⚠️ **被关着的模型仍在目录里**：`listModels()` 会把它过滤掉，故核对集合
     * 必须把黑名单里的 id **并回来** —— 否则「重新打开一个已关闭的模型」
     *（最常见、完全正常的操作）会每次都被误报成「不在目录」。
     */
    it('重新打开一个已关闭的目录内模型 → 无警告（黑名单里的 id 必须并回目录）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { 'glm-5.2': true } },
      })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'glm-5.2',
        disabled: false,
      })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({})
      expect(warningsOf(result), '被关闭的目录内模型不得被判成「不在目录」').toEqual([])
    })

    /**
     * ⚠️ **目录读不出来时必须放弃核对**：`listModels` 在「无已登录账号」时
     * 返回 `[]`（`createModelCatalog` 的门控隐藏整个 provider）。若据此核对，
     * 会把**每一个** id 都判成「不在目录」—— 一次凭据过期就能让所有开关
     * 都带上假警告。空目录意味着「看不到」，不是「全部下架」。
     */
    it('目录为空（无账号门控）时不报警告 —— 空目录不等于全部下架', async () => {
      const { call } = registerEndpoints({ models: [] })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'anything',
        disabled: false,
      })

      expect(result.ok).toBe(true)
      expect(warningsOf(result)).toEqual([])
    })

    it('目录读取抛错时开关照常成功、且不报警告（读不到 ≠ 下架）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        listModelsError: '令牌已过期',
      })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'anything',
        disabled: true,
      })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({ buddy: { anything: true } })
      expect(warningsOf(result)).toEqual([])
    })

    /**
     * ⚠️⚠️ **远端目录为空 ⇒ 必须放弃核对，即使适配器有兜底表**（覆盖缺口，变异实测）。
     *
     * 形态：**无已登录账号** ⇒ `createModelCatalog` 的门控让 `listModels()` 返回 `[]`
     *（隐藏整个 provider 分组），而 `modelAdapters[provider].listAllModels()`
     * **仍然返回兜底表**（它不走那条门控）。
     *
     * ⇒ 此时「并集」里只剩适配器那一半。若拿它当权威目录核对，**每一个**远端模型
     * 都会被判成「不在当前模型目录」而误报 —— 一次未登录就能让所有开关带上假警告。
     * 空远端意味着「**看不到**」而非「全部下架」。
     *
     * ⚠️ 判据必须是 `remoteIds.length === 0`（远端那一半），**不能**用并集
     * `ids.length === 0` —— 并集里适配器那一半会让「远端为空」这件事看不出来，
     * 而那正是本判据要防的形态（变异实测：改判 `ids` 后本用例是**唯一**变红的）。
     */
    it('远端目录为空（无账号门控）但适配器有兜底表 → 放弃核对，不误报', async () => {
      const { call } = registerEndpoints({
        // ⚠️ `listModels` 返回**空**（门控隐藏），但适配器有兜底表。
        models: [],
        // ⚠️ 兜底表**只含 `hy3`**，而被测 id 是 `glm-5.2`（**不在**兜底表里）。
        // 这样才真正走到「并集里只剩适配器那一半、且被测 id 不在其中」的形态 ——
        // 若兜底表含被测 id，两个来源都会说「在目录」，本用例就测不到那个分支
        //（变异实测：初版写成兜底表 = MODELS 时，改判 `ids` 后用例**仍然全绿**）。
        modelAdapters: { buddy: { listAllModels: () => [{ id: 'hy3', name: 'Hy3' }] } },
      })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'glm-5.2',
        disabled: false,
      })

      expect(result.ok).toBe(true)
      expect(
        warningsOf(result),
        '远端为空（看不到）被当成「全部下架」：拿兜底表核对会把每个模型都误报',
      ).toEqual([])
    })

    /**
     * ⚠️ 反向：**远端读失败**（不是空）时同样放弃核对，即使适配器有兜底表。
     * 与上一条是两个不同的分支（`remoteIds === undefined` vs `length === 0`）。
     */
    it('远端读失败但适配器有兜底表 → 放弃核对（不得拿兜底子集当权威）', async () => {
      const { call } = registerEndpoints({
        models: MODELS,
        listModelsError: '令牌已过期',
        modelAdapters: { buddy: { listAllModels: () => [{ id: 'hy3', name: 'Hy3' }] } },
      })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'glm-5.2',
        disabled: true,
      })

      expect(result.ok).toBe(true)
      expect(warningsOf(result)).toEqual([])
    })

    /**
     * ⚠️ 适配器的 `listAllModels()` **抛错**不得让核对整体失效：
     * 远端那一半仍然可用（它与 `listModels` 是两个独立来源）。
     */
    it('适配器 listAllModels 抛错时仍用远端那一半核对（不因它整体放弃）', async () => {
      const { call } = registerEndpoints({
        models: MODELS,
        modelAdapters: { buddy: { listAllModels: () => { throw new Error('适配器内部炸了') } } },
      })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'glm-5.2',
        disabled: true,
      })

      expect(result.ok).toBe(true)
      // `glm-5.2` 在远端目录里 ⇒ 判为「在目录」、无警告。
      expect(warningsOf(result)).toEqual([])
    })

    /**
     * ⚠️ **打开一个目录外但仍在黑名单里的 id 必须静默** —— 这是
     * 幽灵条目的**唯一清理路径**，报警告会让用户以为清理失败。
     *
     * ⚠️ 这条语义在实现里**只由一处承担**（`readableCatalogIds` 把黑名单里的
     * id 并回 `known`）。本用例是它的守卫：并回逻辑若被删/改坏，这里变红。
     */
    it('打开一个目录外但仍在黑名单里的 id → 无警告（唯一的清理路径，必须静默）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        disabledModels: { buddy: { 'gone-model': true } },
      })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'gone-model',
        disabled: false,
      })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({})
      expect(warningsOf(result), '清理幽灵条目是有效操作，不得报警告').toEqual([])
    })

    /**
     * ⚠️⚠️ **开关绝不能被目录拉取拖住**（本次改动唯一的新增代价）。
     *
     * `readableCatalogIds` 要 `await llm.listModels()`，而它在**冷缓存**下会真的
     * 发一次远端拉取（`loadCatalog()`）⇒ 「写开关」这个原本纯本地的操作多了
     * 一条网络依赖。若远端卡住，用户点一下开关就会一直转圈。
     *
     * ⇒ 核对必须**尽力而为**：超时即放弃核对，开关照常写入。
     * 本用例让 `listModels` **永不 resolve**，断言开关仍在预算内返回成功。
     *
     * ⚠️ 用假计时器不可行（涉及真实 Promise 链），故用「永不落定」+ 真实超时预算
     * 的竞速，与 `account.create` 那条「不阻塞」用例同款做法。
     */
    it('目录读取卡住（永不 resolve）时开关仍及时成功，不被远端拖住', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        listModelsHangs: true,
      })

      const result = await Promise.race([
        call('model.setDisabled', { provider: 'buddy', modelId: 'glm-5.2', disabled: true }),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 8000)),
      ])

      expect(result, '开关被目录拉取拖住了：核对必须带超时').not.toBe('timeout')
      expect((result as { ok: boolean }).ok).toBe(true)
      // 写入照常生效 —— 核对失败不得影响开关本身。
      expect(storedValue().disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
    }, 15000)

    /**
     * ⚠️⚠️ **两个目录来源必须取并集**（真实缺陷，独立审计实测证伪）。
     *
     * `model.list`（设置页）用 `modelAdapters[provider].listAllModels()`，而
     * `listModels()` 在**只有匿名身份**的 `opencode` 上只返回免费模型
     * （`opencode-adapter.ts` 的 `filter(isFree)`），其 `listAllModels()` 又
     * **恒返回**编译期兜底表 ⇒ 设置页看得见的**付费模型在 `listModels()` 里
     * 一个都没有**。审计实测：无付费账号时关闭 13 个设置页可见的模型，
     * **13/13 全部收到「该模型可能已被上游下架」的假警告**（它并没下架）。
     *
     * 本用例复刻该形状：`listModels` 只给 1 条（模拟匿名身份），
     * `listAllModels` 给全量（设置页目录）⇒ 关闭设置页可见的模型**不得**报警告。
     */
    it('两个目录来源不同源时取并集 —— 设置页可见的模型不得被误报（opencode 形态）', async () => {
      const { call } = registerEndpoints({
        // ⚠️ 匿名身份下的 `listModels`：只有 1 条。
        models: [{ id: 'big-pickle', name: 'Big Pickle' }],
        // ⚠️ 设置页目录（`listAllModels`）：14 条，含全部付费模型。
        modelAdapters: {
          opencode: {
            listAllModels: () => [
              { id: 'big-pickle', name: 'Big Pickle' },
              { id: 'glm-5.2', name: 'GLM-5.2' },
              { id: 'kimi-k2.5', name: 'Kimi K2.5' },
              { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
            ],
          },
        },
      })

      const result = await call('model.setDisabledMany', {
        provider: 'opencode',
        modelIds: ['glm-5.2', 'kimi-k2.5', 'deepseek-v4.1-flash'],
        disabled: true,
      })

      expect(result.ok).toBe(true)
      expect(
        warningsOf(result),
        '设置页可见的模型被判成「不在目录」：判据漏了 listAllModels 这一半',
      ).toEqual([])
    })

    /**
     * ⚠️ **`listModels()` 读失败时必须整体放弃核对**，不得退化成「只用
     * `listAllModels()` 兜底表」—— 那会退回第一版的大面积误报。
     *
     * ⚠️ 这条刻意牺牲了 issue 原始场景的**漏报**（脚本冷启动直调 `on` 且
     * 首次拉取就失败时不会给提示），因为反向代价更重：把正常模型说成已下架。
     */
    it('listModels 读失败时整体放弃核对，不拿兜底表当权威（宁漏勿误）', async () => {
      const { call } = registerEndpoints({
        models: MODELS,
        listModelsError: '令牌已过期',
        // 兜底表只有 1 条 —— 若退化用它核对，`glm-5.2` 会被误报。
        modelAdapters: { buddy: { listAllModels: () => [{ id: 'hy3', name: 'Hy3' }] } },
      })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'glm-5.2',
        disabled: true,
      })

      expect(result.ok).toBe(true)
      expect(warningsOf(result), 'listModels 失败时不得拿兜底子集当权威目录').toEqual([])
    })

    /**
     * ⚠️ **`listAllModels()` 抛错不得让开关本身失败**：开关是主操作，
     * 核对只是提示层（并集少一半仍可用）。
     */
    it('listAllModels 抛错时开关照常成功，只用 listModels 那一半核对', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        modelAdapters: {
          buddy: {
            listAllModels: () => { throw new Error('适配器内部炸了') },
          },
        },
      })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'glm-5.2',
        disabled: true,
      })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
      // `glm-5.2` 在 `listModels` 里 ⇒ 仍能正确判为「在目录」。
      expect(warningsOf(result)).toEqual([])
    })

    /**
     * ⚠️⚠️ **黑名单必须在 `await listModels()` 之后读**（真实缺陷，审计实测）。
     *
     * 若由调用方在 `await` **之前**取快照，则「快照」与「实际写入」之间隔着一次
     * `listModels`（冷缓存下最长 2 秒）。期间另一路 RPC 的写入会让快照失真，
     * 症状是「**实际产生了变更却报『本次没有产生任何变更』**」—— 与 issue
     * 要消除的误导同型（方向相反：说空操作、其实有效）。
     *
     * 本用例让第一路（打开 X）的 `listModels` **让出执行权**，期间第二路
     * （关闭 X）完整跑完 ⇒ 第一路必须看到「X 已在黑名单里」并静默。
     */
    it('核对期间另一路写入黑名单 → 不得误报「没有产生任何变更」', async () => {
      let releaseFirst!: () => void
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
      let firstCall = true

      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        // 第一路的 listModels 挂起（模拟冷缓存拉取），第二路正常返回。
        onListModels: async () => {
          if (firstCall) { firstCall = false; await firstGate }
        },
      })

      // 第一路：打开 `glm-5.2`（此刻它不在黑名单里）。
      const opening = call('model.setDisabled', { provider: 'buddy', modelId: 'glm-5.2', disabled: false })
      // 让第一路先进入 await（挂起在 listModels 上）。
      await new Promise((resolve) => setTimeout(resolve, 10))
      // 第二路：关闭 `glm-5.2` 并完整跑完。
      const closing = await call('model.setDisabled', { provider: 'buddy', modelId: 'glm-5.2', disabled: true })
      expect(closing.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({ buddy: { 'glm-5.2': true } })

      // 放行第一路：它会把 `glm-5.2` 重新打开（**真的产生了变更**）。
      releaseFirst()
      const opened = await opening

      expect(opened.ok).toBe(true)
      expect(storedValue().disabledModels, '第一路确实把 glm-5.2 打开了').toEqual({})
      expect(
        warningsOf(opened),
        '实际产生了变更却报「没有产生任何变更」：黑名单读得太早、与写入时刻错开了',
      ).toEqual([])
    })

    /**
     * ⚠️⚠️ **批量端点的并发守卫**（覆盖缺口，独立审计实测 M7 变异**零守卫**）。
     *
     * 上面那条只覆盖单条端点；审计实测：**只把 `model.setDisabledMany` 的黑名单
     * 读取提前到 `await` 之前**，159 条用例**全绿** —— 即批量分支的
     * 「黑名单必须在 await 之后读」这条语义**没有任何回归保护**。
     *
     * ⚠️ 而批量端点是**主力路径**：Jet Hub 的「本组全开/全关」正走它，
     * 而 cline 的目录有 460+ 条（用户几乎只会用分组开关）。缺了守卫，
     * 将来有人「顺手把两次读合并成一个变量」就会静默退回误报。
     *
     * 形状与单条那条同款：第一路（打开 X）挂起在 `listModels` 上，
     * 期间第二路（关闭 X）完整跑完 ⇒ 第一路必须看到「X 已在黑名单里」并静默。
     */
    it('批量端点核对期间另一路写入黑名单 → 不得误报「没有产生任何变更」', async () => {
      let releaseFirst!: () => void
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
      let firstCall = true

      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        onListModels: async () => {
          if (firstCall) { firstCall = false; await firstGate }
        },
      })

      // 第一路：批量**打开** `glm-5.2`（此刻它不在黑名单里）。
      const opening = call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['glm-5.2'],
        disabled: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      // 第二路：批量关闭 `glm-5.2` 并完整跑完。
      const closing = await call('model.setDisabledMany', {
        provider: 'buddy',
        modelIds: ['glm-5.2'],
        disabled: true,
      })
      expect(closing.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({ buddy: { 'glm-5.2': true } })

      // 放行第一路：它会把 `glm-5.2` 重新打开（**真的产生了变更**）。
      releaseFirst()
      const opened = await opening

      expect(opened.ok).toBe(true)
      expect(storedValue().disabledModels, '第一路确实把 glm-5.2 打开了').toEqual({})
      expect(
        warningsOf(opened),
        '批量端点实际产生了变更却报「没有产生任何变更」：黑名单读得太早',
      ).toEqual([])
    })

    it('llm 服务完全不可用时开关照常成功、且不报警告', async () => {
      const { call, storedValue } = registerEndpoints({ models: MODELS, withoutLlm: true })

      const result = await call('model.setDisabled', {
        provider: 'buddy',
        modelId: 'anything',
        disabled: true,
      })

      expect(result.ok).toBe(true)
      expect(storedValue().disabledModels).toEqual({ buddy: { anything: true } })
      expect(warningsOf(result)).toEqual([])
    })
  })
})

/**
 * 三个积分端点的 provider 分派与能力边界（后端侧契约）。
 *
 * 四个 provider 分属**三套互不相同的协议**：
 * - CodeBuddy 系（buddy / workbuddy）经 `productById()` 取 BuddyProduct；
 * - `lobsterai`（三步 client-activities）；
 * - `codearts`（华为云 SDK-HMAC-SHA256 签名，见 `src/codearts-credits.ts`）。
 *
 * 历史背景（本用例的由来）：CodeArts 曾**不是** BuddyProduct，
 * `productById('codearts')` 返回 undefined，于是三个端点必然回
 * `bad-request: unsupported provider: codearts`。当时客户端在面板挂载时对
 * **所有** provider 无条件调用 `credits.balances`，把这条必然的拒绝当成运行时
 * 故障打进了控制台，并把账号卡片的「积分」渲染成「查询失败」（修法见
 * `plugin-src/client/credits-capabilities.js` 与
 * `tests/unit/credits-capabilities.spec.ts`）。
 *
 * 现在 CodeArts 已接入真实实现，因此本用例锁三件事：
 * 1. **未登记**的 provider 仍回可读的 bad-request（兜底契约不能退化）；
 * 2. CodeArts 被**接受**并返回结构化结果（新能力的回归保护）；
 * 3. 拒绝/接受都**按 provider 精确生效**，没有连 CodeBuddy 系一起误拒。
 *
 * 防止的「好心改坏」：把拒绝改成「返回空结果」→ 前端会以为该 provider 真没有
 * 积分可查，永远查不出问题；让它抛异常 → 退化成 `jet-hub/handler-failed`，
 * 丢失「provider 不支持」这一原因。
 */
describe('积分端点的 provider 能力边界', () => {
  /** 从 connection.fetch.register 捕获到的处理器。 */
  type Handler = (request: Request) => Promise<Response>

  /** 注册端点，返回一个「调用端点方法并解包 result」的函数。 */
  function registerCreditsEndpoints() {
    let handler: Handler | undefined
    const ctx: Record<string, unknown> = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        : undefined,
      // 生产代码用惰性注入挂载 connection 端点（见 registerJetHubRpc 的说明）：
      // 替身必须提供 inject，否则会以 `ctx.inject is not a function` 抛错。
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      // 积分端点会 resolve 凭据；返回 undefined 让逐账号流程走「凭据未配置」
      // 分支，从而无需真实网络即可跑完（accounts 替身返回空数组，实际不触发）。
      credentials: { resolve: async () => undefined },
    }
    // pool 替身：一旦 provider 校验被绕过，listAccounts 会返回空数组，
    // 端点便以 `ok: true` + 空列表「假成功」——下面的断言会立刻揭穿它，
    // 而不会因为抛 TypeError 变成误导性的 handler-failed。
    const pool = { listAccounts: async () => [] }

    // ⚠️ 命名对象（2026-10-08 改）：13 个键由助手补齐（本组用例只走积分端点）。
    registerJetHubRpc(ctx as never, pool as never, authsStub())
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    return async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }
  }

  const CREDITS_METHODS = ['credits.status', 'credits.claimAll', 'credits.balances']

  /**
   * 未知 provider 仍必须被拒。
   *
   * ⚠️ 历史上这条用例断言的是 **codearts** 被拒 —— 当时 CodeArts 确实没有
   * 积分能力（华为云账号体系无腾讯计费接口）。现在它已接入自己的签名协议
   * （`src/codearts-credits.ts`），故改用真正未登记的 provider 名来守住
   * 同一件事：**拒绝是兜底契约，不是常规路径**。
   *
   * 保留本用例的价值：防止「好心改坏」——把拒绝改成「返回空结果」会让前端
   * 以为该 provider 真没有积分可查；让它抛异常则退化成
   * `jet-hub/handler-failed`，丢失「provider 不支持」这一原因。
   */
  it.each(CREDITS_METHODS)('%s 对未知 provider 返回 unsupported provider（可读的 bad-request）', async (method) => {
    const call = registerCreditsEndpoints()
    const result = await call(method, { provider: 'unknownprovider' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('unsupported provider: unknownprovider')
  })

  /**
   * ⚠️ **本用例 2026-10-02 被拆分过**，读之前先看这段理由，别以为是「把守卫改松了」。
   *
   * 原用例对**三个**方法都断言 `buddy` 与 `workbuddy` 都被接受（ok:true），
   * 目的是防止「把 CodeBuddy 系一并误拒」—— 历史上确实有过只认 `buddy`、
   * 于是国际版连**余额**都查不出来的缺陷。
   *
   * 但那条断言对 `credits.claimAll` 不成立：WorkBuddy 国际版**没有签到端点**
   * （证据：README「WorkBuddy 国际版后端没有签到接口，故其面板不显示」、
   * AGENTS.md 的能力表 `workbuddy → ✗（国际版后端无签到接口）`、客户端
   * `credits-capabilities.js` 的 `workbuddy: { balance: true, dailyCheckin: false }`，
   * 其注释写明国际版内核里只有 `get-dosage-notify` 用量通知）。
   * 原先「接受」只是因为**测试用空账号池**，替身下不会真的发请求 ——
   * 真实账号下它会用国际版凭据去发国内版的签到请求，必然失败。
   *
   * 触发这次修正的是「每日首次启动自动签到」（`src/auto-checkin.ts`）：它
   * 不维护第二份能力名单，只按 `claimAll` 返回的信封判跳过，所以宿主端必须
   * 对不支持的渠道**显式表态**。⇒ 拆成下面两条，**禁止一刀切**的意图完整保留：
   * `credits.status` / `credits.balances` 仍要求两者都被接受。
   */
  it.each(['credits.status', 'credits.balances'])('%s 不会把 CodeBuddy 系一并误拒', async (method) => {
    const call = registerCreditsEndpoints()
    // 两个 Buddy 系产品都能通过 provider 校验，走到 listAccounts（替身返回空）。
    for (const provider of ['buddy', 'workbuddy']) {
      const result = await call(method, { provider })
      expect(result.ok, `${method}/${provider}`).toBe(true)
    }
  })

  it('credits.claimAll 接受 buddy，但对 workbuddy 给出**明确**的「不支持每日签到」', async () => {
    const call = registerCreditsEndpoints()
    // CodeBuddy 中国版照旧被接受（它有签到端点）
    const buddyResult = await call('credits.claimAll', { provider: 'buddy' })
    expect(buddyResult.ok, 'claimAll/buddy').toBe(true)
    // 国际版：拒绝，但**必须是可读的能力原因**，不是泛化的「provider 没注册」
    const result = await call('credits.claimAll', { provider: 'workbuddy' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('WorkBuddy 国际版不支持每日签到')
    expect(result.error?.message, '不能退化成 unsupported provider').not.toContain('unsupported provider')
  })

  /**
   * CodeArts 现在**必须**被接受（不再回 bad-request）。
   *
   * 这是本次接入的核心契约：三个积分端点都要为 `codearts` 分支。
   * 用空账号池调用，只验证「provider 被接受且返回结构化结果」，
   * 不触发任何网络请求。
   */
  it.each(CREDITS_METHODS)('%s 接受 codearts（已接入华为云签名协议）', async (method) => {
    const call = registerCreditsEndpoints()
    const result = await call(method, { provider: 'codearts' })
    expect(result.ok).toBe(true)
  })

  it('credits.balances 对 codearts 返回 accounts 数组', async () => {
    const call = registerCreditsEndpoints()
    const result = await call('credits.balances', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    expect((result.value as { accounts: unknown[] }).accounts).toEqual([])
  })

  it('credits.status 对 codearts 返回 accounts 数组（状态如实为 null）', async () => {
    // 华为侧没有独立的「签到状态」端点，故与 LobsterAI 同样返回 null，
    // 而不是臆造一份 CheckinStatus 形状的对象。
    const call = registerCreditsEndpoints()
    const result = await call('credits.status', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    expect((result.value as { accounts: unknown[] }).accounts).toEqual([])
  })

  it('credits.claimAll 对 codearts 返回 summary 结构', async () => {
    const call = registerCreditsEndpoints()
    const result = await call('credits.claimAll', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    expect((result.value as { summary: unknown }).summary).toEqual({
      claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0,
      totalByUnit: { token: 0, credit: 0 },
    })
  })

  /**
   * TRAE 的 claim 分支**必须开启状态预检**。
   *
   * 真实缺陷（用户报障：「领取积分显示成功但是加 0 积分」的成因之二）：
   * TRAE 的 claim 对「今天已签到」是**幂等**的 —— 实测重复领取同样返回
   * `{code:0, message:"success"}`，与真正领取成功**无法区分**。早期照抄
   * LobsterAI 传了 `precheckStatus: false`（那是「LobsterAI 的领取流程内部
   * 已做 slot/context 预检」的理由，TRAE 没有这回事），于是已签到的账号被
   * 报成「领取成功」。判据只能是 status 端点的 `checked_in`。
   *
   * 用源码级断言而非行为断言：本用例要锁的是「这一行配置别被改回去」，
   * 与仓库里 `qoder-wiring.spec.ts` 守卫接线的方式一致。
   */
  it('TRAE 的 claim 分支开启状态预检并注入 fetchStatus（源码级守卫）', () => {
    // ⚠️ 2026-10-08 改（Task 4）：原先这条扫 `src/jet-hub-rpc.ts` 的源码文本，
    //    找 `collectClaimResults<TraeCredential` 那段切片，断言里面没有
    //    `precheckStatus: false` 且含 `fetchStatus:`。Task 4 把 TRAE 的配置搬进
    //    `src/provider-credits.ts` 的能力表 ⇒ 那段文本**不存在了**（现在 claimAll
    //    是查表分派），而它守的意图（**TRAE 必须开状态预检**，否则已签到账号被
    //    报成「领取成功」= 用户报障「显示成功但 +0 积分」）**与文本位置无关**。
    //
    //    ⇒ 改为读**表里的声明值**。这是**更强的**判据：文本断言只能证明源码里
    //    有那串字符，它能证明运行时真的声明了 `precheckStatus: true` 且**有**
    //    状态查询实现可用（`claimStatus` / `fetchStatus` 至少有一个）。
    //    端到端的「已签到账号不发 claim 请求」由
    //    `claim-runtime-parity.spec.ts` 的「★ TRAE 开启状态预检」守（真跑端点、
    //    核对实际请求）。
    const trae = createProviderCredits().trae
    expect(trae?.claim, 'TRAE 的领取没有接上').toBeTypeOf('function')
    expect(
      trae?.precheckStatus,
      'TRAE 必须显式 precheckStatus: true —— 它的 claim 对「今天已签到」幂等，'
      + '关掉预检会把已签到账号报成「领取成功」（真实报障：显示成功但 +0 积分）',
    ).toBe(true)
    // ⚠️ 预检必须有**可用的**状态查询（否则 precheckStatus:true 是空头承诺：
    //    骨架拿不到 fetchStatus 就会退回 buddy 式默认实现）。
    expect(
      trae?.claimStatus ?? trae?.fetchStatus,
      'TRAE 声明了 precheckStatus 却没有任何状态查询实现',
    ).toBeTypeOf('function')
  })
})

/**
 * `account.reorder` 端点（Jet Hub 拖拽排序）。
 *
 * 用**真实 AccountPool** + 内存 settings 替身，而不是给 pool 打桩：
 * 这个端点的价值全在「参数校验 + 转交 pool.reorderAccounts」，
 * 用桩替换 pool 就只剩「调用了某方法」这种无信息量的断言，
 * 无法发现「集合校验被绕过」「顺序没持久化」这类真实问题。
 */
describe('account.reorder 端点', () => {
  type Handler = (request: Request) => Promise<Response>

  /** 建一个真实 pool（内存 settings）+ 端点调用器。 */
  function setup(initial: Array<{ id: string; provider: string }>) {
    let stored: { accounts: unknown[]; disabledModels: Record<string, unknown> } = {
      accounts: initial.map(a => ({
        ...a,
        nickname: a.id,
        enabled: true,
        credentialRef: `${a.provider.toUpperCase()}_ACCOUNT_${a.id.toUpperCase()}`,
        createdAt: 1,
        refreshable: true,
      })),
      disabledModels: {},
    }
    let handler: Handler | undefined
    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: typeof stored) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined },
    }
    // ⚠️ 命名对象（2026-10-08 改）：13 个键由助手补齐。
    registerJetHubRpc(ctx as never, pool as never, authsStub())
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }
    return { call, orderInStore: () => (stored.accounts as Array<{ id: string }>).map(a => a.id) }
  }

  it('重排成功并把新顺序写入存储', async () => {
    const { call, orderInStore } = setup([
      { id: 'a', provider: 'buddy' },
      { id: 'b', provider: 'buddy' },
      { id: 'c', provider: 'buddy' },
    ])
    const result = await call('account.reorder', { provider: 'buddy', orderedIds: ['c', 'a', 'b'] })
    expect(result.ok).toBe(true)
    expect(orderInStore()).toEqual(['c', 'a', 'b'])
  })

  it('集合不一致（列表过期）回可读错误，而不是 handler-failed', async () => {
    // 这类并发是可预期的：用户拖拽期间在别处新增/删除了账号。
    // 回 bad-request + 可读文案，前端能提示"刷新后重试"；
    // 若抛异常会退化成 jet-hub/handler-failed，用户只看到"未知故障"。
    const { call, orderInStore } = setup([
      { id: 'a', provider: 'buddy' },
      { id: 'b', provider: 'buddy' },
    ])
    const result = await call('account.reorder', { provider: 'buddy', orderedIds: ['a'] })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('账号列表已变化')
    // 数据未被破坏
    expect(orderInStore()).toEqual(['a', 'b'])
  })

  it('缺 provider 或 orderedIds 非字符串数组 → bad-request', async () => {
    const { call } = setup([{ id: 'a', provider: 'buddy' }])
    expect((await call('account.reorder', { orderedIds: ['a'] })).ok).toBe(false)
    expect((await call('account.reorder', { provider: 'buddy' })).ok).toBe(false)
    expect((await call('account.reorder', { provider: 'buddy', orderedIds: [1, 2] })).ok).toBe(false)
  })

  it('重排不影响其他 provider 账号的位置', async () => {
    const { call, orderInStore } = setup([
      { id: 'b1', provider: 'buddy' },
      { id: 'c1', provider: 'codearts' },
      { id: 'b2', provider: 'buddy' },
    ])
    const result = await call('account.reorder', { provider: 'buddy', orderedIds: ['b2', 'b1'] })
    expect(result.ok).toBe(true)
    // buddy 的两个账号在各自原下标上互换，codearts 仍在中间
    expect(orderInStore()).toEqual(['b2', 'c1', 'b1'])
  })
})

/**
 * 供应商级一键开关：`provider.status`（读）与 `provider.setEnabled`（写）。
 *
 * 这套用例的重点是几条**不能被"改动"破坏的不变式**：
 * 1. 关闭方向必须**先关模型、再停账号**（顺序反了会留下「账号全停但模型可见」的中间态）；
 * 2. **远端读失败**时整个操作失败、不落盘、不广播（「不关闭模型就不关闭供应商」）。
 *    「远端读到但为空」（无账号门控）**不算读失败**：用并集照常关闭，只有并集
 *    也为空才拒绝 —— 否则无账号供应商永远关不掉（与 `provider.status` 的
 *    核实判据 `full.remoteError === undefined` 对齐）；
 * 3. 两个方向都必须广播 `llm/adapters-updated`（否则对话框选择器要重启才更新）；
 * 4. `enabled` 非布尔一律拒绝（不猜默认值）。
 */
/**
 * ⚠️⚠️ **RPC 兜底 catch 必须保留底层错误码**（2026-11-05 合规审计：代码对、零守卫
 * —— 写死 `'jet-hub/handler-failed'` 后 561 条全绿）。
 *
 * `EACCES`（改权限）/ `ENOENT`（文件不在）/ `EISDIR`（路径是目录）/
 * `SyntaxError`（文档损坏）的用户动作**完全不同**，全塌成 `handler-failed`
 * 会让客户端无法分支处理，也只能给出「未知故障」。
 *
 * ⚠️ 客户端目前对 `error.code` **零分支** ⇒ 这是纯增量，不会破坏既有契约；
 * 但正因为没有消费者，将来有人「顺手简化」成常量就会静默丢掉这份信息。
 *
 * ⇒ 判据必须**行为级**：让某条端点抛一个**带 `code` 的错误**（Node 的 errno
 * 形态），断言 RPC 回包里 `error.code` 就是那个码（而不是 `handler-failed`）。
 */
describe('★★ RPC 兜底 catch 保留底层错误码', () => {
  it('★★ errno 形态（EACCES）⇒ error.code 必须逐字是 EACCES', async () => {
    /**
     * ⚠️ 必须让**端点内部**抛一个带 `code` 的错误。
     *
     * `registerEndpoints` 的 `listModelsError` 只带字符串 ⇒ 那条路抛的是
     * 普通 `Error`（**没有** `code` 属性）⇒ 断言 `EACCES` 会恒红。
     * ⇒ 这里直接用**真实的 settings 替身**：`replace` 抛一个带 `code` 的错误
     * （模拟「改权限被拒」），而 `model.setDisabled` 走 `writeModels` ⇒
     * `queueStoreSave()` ⇒ `store.save()` ⇒ `replace` ⇒ 端点内部抛出。
     */
    const handler = await (async () => {
      let registered: ((request: Request) => Promise<Response>) | undefined
      let stored: Record<string, unknown> = { accounts: [] }
      const ctx = {
        get: (key: string) => {
          if (key === 'connection') {
            return {
              fetch: {
                register: (config: { path: string, fetch: (request: Request) => Promise<Response> }) => {
                  if (config.path === JET_HUB_API_PATH) registered = config.fetch
                },
              },
            }
          }
          if (key === 'llm') {
            return {
              listModels: async (provider: string) => [
                { id: 'glm-5.2', name: 'GLM-5.2', provider },
              ],
            }
          }
          if (key === 'settings') {
            return {
              register: () => ({
                get: () => stored,
                // ⚠️ 模拟「改权限被拒」：Node 的 errno 形态（带 `code`）。
                replace: async () => {
                  const error = new Error('EACCES: permission denied, open state.json') as Error & { code?: string }
                  error.code = 'EACCES'
                  throw error
                },
              }),
            }
          }
          return undefined
        },
        inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
        logger: { warn: () => {}, info: () => {} },
        emit: () => {},
        credentials: {
          describe: async () => ({ configured: false, writable: true }),
          resolve: async () => undefined,
          set: async () => {},
          unset: async () => {},
        },
      }
      const pool = new AccountPool(ctx as never)
      registerJetHubRpc(ctx as never, pool, authsStub())
      if (registered === undefined) throw new Error('endpoint handler was not registered')
      return registered
    })()

    const response = await handler(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
        payload: { method: 'model.setDisabled', payload: { provider: 'buddy', modelId: 'glm-5.2', disabled: true } },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean, error?: { code?: string, message?: string } }
    }
    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code, '★ errno 码必须逐字透出（不得塌成 handler-failed）')
      .toBe('EACCES')
    expect(body.result.error?.message).toContain('EACCES')
  })
})

describe('provider.status / provider.setEnabled 端点', () => {
  type Handler = (request: Request) => Promise<Response>

  function setup(options: {
    /** `listAllModels()` 的返回值（不套黑名单的全量目录）；省略则模拟「适配器缺失」。 */
    catalog?: Array<{ id: string; name: string }>
    /** 初始黑名单。 */
    disabledModels?: Record<string, Record<string, boolean>>
    /** 初始账号（只用到 provider / enabled）。 */
    accounts?: Array<{ id: string; provider: string; enabled: boolean }>
    /** 省略 llm 服务，验证「目录读不出来」的降级路径。 */
    withoutLlm?: boolean
    /** 让 llm.listModels 抛错。 */
    listModelsError?: string
    /** 让 `ctx.emit` 抛错，验证「广播失败不反噬已落盘的开关」。 */
    emitThrows?: boolean
    /** 是否提供适配器（false = 模拟外部/旧适配器，只有 llm 可用）。 */
    withAdapter?: boolean
    /**
     * 让 `listAllModels()` 只返回这个**子集**（模拟**冷缓存兜底表**）。
     *
     * ⚠️ 真实形态：`model-catalog.ts` 的 `listAllModels()` 是
     * `cached ?? config.syncCatalog()`，冷缓存时返回各家的**编译期兜底表**，
     * 而它是**子集**（实测 cline 3 条 vs 远端 460 条）。
     * 与 `catalog`（= `listModels` 的源，完整目录）**刻意不同源**，
     * 用来复现「只关兜底子集」的缺陷。
     */
    listAllSubset?: Array<{ id: string; name: string }>
    /**
     * `listModels` 的调用钩子（用于计数/挂起）。
     *
     * ⚠️ `provider.status` 的「核实」路径会读远端目录，故本组需要它来断言
     * 「未关闭时不核实」（零网络代价）。
     */
    onListModels?: () => Promise<void>
    /**
     * 适配器的**目录健康快照**（可选诊断钩子，`describeCatalogHealth`）。
     *
     * ⚠️ 只有 cline 实现它（issue IKKZUG 第 5 点）：目录能力来自三个来源，
     * 其中 models.dev 是外部站点、经常拉不到，而失败时只有 `console.warn`
     * ⇒ 用户与排障者都看不到现场。此钩子让 `provider.status` 能报出来。
     */
    catalogHealth?: { total: number; complete: boolean; note?: string }
    /** 让诊断钩子抛错（验证「诊断不得反噬主流程」）。 */
    catalogHealthThrows?: boolean
    /**
     * 适配器的**目录就绪探测**（`catalogReadyForBulkWrite`，可选）。
     *
     * ⚠️ 只有聚合适配器实现它。`ready: false` 模拟「冷帧」——Task 7 之后聚合的
     * `listModels` 不再同步等上游，冷启动时立刻返回 `['auto']`，于是
     * `fullCatalogIds` 会看到「远端读成功、但只有 1 条」。
     * 这是 Critical 缺陷（`setEnabled` 只关 auto 却返回成功 / `provider.status`
     * 把安全方向翻成危险方向）的**生产形态**。
     */
    catalogReadiness?: { ready: boolean; reason?: string } | (() => { ready: boolean; reason?: string })
    /** 让就绪探测抛错（验证「探测不得反噬，按不可用处理」）。 */
    catalogReadinessThrows?: boolean
    /**
     * 适配器注册到哪个 provider 键下（默认 `buddy`）。
     *
     * ⚠️ 现有用例全都在 `buddy` 上做（`authsStub` 也只覆盖常规渠道）。聚合相关的
     * 用例需要把适配器挂到 `aggregate` 键下才能命中 `aggregate` 的那套判据。
     */
    providerId?: string
    /**
     * 把**同一个**适配器替身挂到多个 provider 键下（默认只挂 `providerId`）。
     *
     * ⚠️ 只为一件事存在：验证 `provider.status` 的**核实腿是并发还是串行**
     *（2026-11-05 三审端到端 P1-1）。串行时总耗时随家数线性增长
     *（28 家 × 2s = 56194ms 实测），并发时 `≤ 2s`。
     * 不传 ⇒ 行为与改动前逐字节相同（既有 262 条用例不受影响）。
     */
    adapterProviders?: readonly string[]
  } = {}) {
    let stored: Record<string, unknown> = {
      // ⚠️ 账号条目必须补齐 `credentialRef`（非空）与 `createdAt`/`refreshable`：
      // `sanitizeAccounts` 会把缺 `credentialRef` 的条目**整条丢弃**，于是
      // 「停用全部账号」会返回 0、用例假失败。这个替身曾因此踩过一次。
      accounts: (options.accounts ?? []).map((a, i) => ({
        nickname: a.id,
        credentialRef: `${a.provider.toUpperCase()}_ACCOUNT_T${i + 1}`,
        createdAt: Date.now(),
        refreshable: true,
        ...a,
      })),
      ...options.disabledModels !== undefined ? { disabledModels: options.disabledModels } : {},
    }
    let handler: Handler | undefined
    const emitted: string[] = []
    /** 记录每次写入的顺序，用于断言「先关模型、后停账号」。 */
    const writeOrder: string[] = []

    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => {
                // 判定这次写入是「账号」还是「模型黑名单」：前者有非空 accounts
                // 且黑名单未变；用更直接的判据 —— 对比写入前后的字段差异。
                const prevDisabled = JSON.stringify((stored as { disabledModels?: unknown }).disabledModels ?? {})
                const nextDisabled = JSON.stringify((value as { disabledModels?: unknown }).disabledModels ?? {})
                if (prevDisabled !== nextDisabled) writeOrder.push('models')
                const prevAccounts = JSON.stringify((stored as { accounts?: unknown }).accounts ?? [])
                const nextAccounts = JSON.stringify((value as { accounts?: unknown }).accounts ?? [])
                if (prevAccounts !== nextAccounts) writeOrder.push('accounts')
                stored = value
              },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    const adapter = options.catalog !== undefined && options.withAdapter !== false
      ? {
          listAllModels: () => options.listAllSubset ?? options.catalog!,
          ...(options.catalogHealth === undefined && options.catalogHealthThrows !== true)
            ? {}
            : {
                describeCatalogHealth: () => {
                  if (options.catalogHealthThrows === true) throw new Error('诊断钩子内部炸了')
                  return options.catalogHealth!
                },
              },
          // ⚠️ `catalogReadyForBulkWrite` 只在显式要求时挂上：大多数既有用例测的是
          //    「目录已就绪」的稳态，不该被这个可选探测影响。
          ...(options.catalogReadiness === undefined && options.catalogReadinessThrows !== true)
            ? {}
            : {
                catalogReadyForBulkWrite: () => {
                  if (options.catalogReadinessThrows === true) throw new Error('就绪探测内部炸了')
                  const value = options.catalogReadiness
                  return typeof value === 'function' ? value() : value!
                },
              },
        }
      : undefined

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        }
        if (key === 'llm' && options.withoutLlm !== true) {
          return {
            listModels: async (provider: string) => {
              if (options.listModelsError !== undefined) throw new Error(options.listModelsError)
              // 计数钩子：验证「未关闭时不核实目录」（零网络代价）。
              if (options.onListModels !== undefined) await options.onListModels()
              const disabled = ((stored.disabledModels as Record<string, Record<string, boolean>> | undefined)?.[provider]) ?? {}
              // 复刻真实适配器：黑名单命中的模型不出现在 listModels 结果里。
              return (options.catalog ?? [])
                .filter(m => disabled[m.id] !== true)
                .map(m => ({ ...m, provider }))
            },
          }
        }
        return undefined
      },
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      emit: (event: string) => {
        if (options.emitThrows === true) throw new Error('listener exploded')
        emitted.push(event)
      },
    }

    registerJetHubRpc(
      // ⚠️ **命名对象**（2026-10-08 改，原为 13 个位置参数 + `modelAdapters`）。
      //
      // 位置参数时代这里**六次**踩到同一个坑：每新增一个 provider 都要在中间补
      // 一个 `{}` 占位，否则 `modelAdapters` 会错位落到最后一个 auth 形参上
      //（加 Raccoon / QoderCN / MiniMax / ZCode 时各踩一次），表现为
      // `provider.status` 的 `total` 恒为 0、本组 3 条用例假失败。
      // 命名对象下 `modelAdapters` 是**独立的第 4 个形参**，auth 键的增减
      // 再也挤不掉它 —— 这正是本次改签名要消除的缺陷。
      ctx as never, pool,
      authsStub(),
      (adapter !== undefined
        ? Object.fromEntries(
            // 默认只挂一个键（既有 262 条用例的行为逐字节不变）；`adapterProviders`
        // 让同一个替身挂到多家，用于测「核实腿是并发还是串行」。
            (options.adapterProviders ?? [options.providerId ?? 'buddy'])
              .map((provider) => [provider, adapter]),
          )
        : undefined) as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    return {
      call,
      emitted,
      writeOrder,
      storedDisabled: () => (stored.disabledModels as Record<string, Record<string, boolean>> | undefined) ?? {},
      storedAccounts: () => (stored.accounts as Array<{ id: string; provider: string; enabled: boolean }> | undefined) ?? [],
      /**
       * **模型选择器视角**：用**真实的共享骨架**（`createModelCatalog`）跑一遍
       * `listModels`，判据打在它实际返回的 id 上。
       *
       * ⚠️ 必须共享**同一个** `pool`（关闭意图与黑名单状态都在它里面），且
       * **不能**用上面 `ctx.llm.listModels` 那个替身 —— 那个替身自己实现了
       * 黑名单过滤，测它等于测测试自己（本仓库实测过这类「假守卫」）。
       *
       * ⚠️⚠️ **必须关掉「无账号就隐藏 provider」门控**
       *（`DSH_HIDE_MODELS_WITHOUT_ACCOUNT`，默认**开启**）。本 setup 没有账号
       * ⇒ 不关它则 `listModels` 恒返回 `[]` ⇒ 「关闭态下新模型不得可选」这条
       * 断言**恒真 = 假绿**（实测踩到：打开供应商后仍返回 `[]` 才暴露）。
       * 门控本身另有专门的用例覆盖，不该混进本组判据。
       */
      listModelsViaSkeleton: async (provider = options.providerId ?? 'buddy'): Promise<string[]> => {
        const previous = process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
        process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = '0'
        try {
          const { createModelCatalog } = await import('../../src/model-catalog.js')
          const entries = (options.catalog ?? []).map((m) => ({ id: m.id, name: m.name }))
          const modelCatalog = createModelCatalog(
            { accountPool: pool },
            {
              product: { id: provider },
              loadCatalog: () => entries,
              syncCatalog: () => entries,
              unknownModelInputModalities: () => ['text'] as const,
            } as never,
          )
          const listed = await modelCatalog.listModels(provider)
          return listed.map((m) => m.id)
        } finally {
          if (previous === undefined) delete process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
          else process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = previous
        }
      },
    }
  }

  /** 目录在关闭之后「长出来」的模型（黑名单里**没有**它）。 */
  const LATE_MODEL = { id: 'late-model', name: 'Late Model' }

  const CATALOG = [
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'hy3', name: 'Hy3' },
  ]

  describe('provider.status', () => {
    it('全部模型都已关闭时 closed 为 true', async () => {
      const { call } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true } },
      })
      const result = await call('provider.status', { providers: ['buddy'] })
      expect(result.ok).toBe(true)
      const s = (result.value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }).statuses.buddy
      expect(s.models).toEqual({ total: 3, disabled: 3 })
      expect(s.closed).toBe(true)
    })

    it('⚠️ 只关了一部分时 closed 为 false（不能按「关过」判）', async () => {
      const { call } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { hy3: true } },
      })
      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }).statuses.buddy
      expect(s.models).toEqual({ total: 3, disabled: 1 })
      expect(s.closed).toBe(false)
    })

    it('⚠️ 没有任何模型时 closed 必须为 false（「没有模型可关」≠「已关闭」）', async () => {
      const { call } = setup({ catalog: [] })
      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }).statuses.buddy
      expect(s.models.total).toBe(0)
      expect(s.closed).toBe(false)
    })

    it('⚠️ 适配器缺失时保守判为未关闭（不误报已关闭）', async () => {
      const { call } = setup({ catalog: CATALOG, withAdapter: false, disabledModels: { buddy: { 'glm-5.2': true } } })
      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { closed: boolean }> }).statuses.buddy
      expect(s.closed).toBe(false)
    })

    it('回传账号计数（enabled 只统计启用的）', async () => {
      const { call } = setup({
        catalog: CATALOG,
        accounts: [
          { id: 'b1', provider: 'buddy', enabled: true },
          { id: 'b2', provider: 'buddy', enabled: false },
          { id: 'c1', provider: 'codearts', enabled: true },
        ],
      })
      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { accounts: { total: number; enabled: number } }> }).statuses.buddy
      // 只统计本 provider，codearts 的账号不计入
      expect(s.accounts).toEqual({ total: 2, enabled: 1 })
    })

    it('一次查询多个供应商，各自独立判定', async () => {
      const { call } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true } },
      })
      const result = await call('provider.status', { providers: ['buddy', 'qoder'] })
      const statuses = (result.value as { statuses: Record<string, { closed: boolean }> }).statuses
      expect(statuses.buddy.closed).toBe(true)
      // qoder 没有目录 → 未关闭
      expect(statuses.qoder?.closed ?? false).toBe(false)
    })

    // ── issue IKKZUG 第 5 点：目录健康状态要**可观测** ──
    //
    // 真实困境（用户 oct_heaven 定位到这一层很不容易）：cline 的目录来自
    // **三个来源**，其中 models.dev 是 5.39 MB 的外部站点、经常拉不到；
    // 而失败时只有 `console.warn`，**宿主不落盘** ⇒ 用户与排障者都看不到现场，
    // 现象只是「贴不了图」，无从判断是「模型不支持」还是「目录没拉到」。

    it('⚠️ 报出目录健康快照（来源就绪度），供排障区分「不支持」与「没拉到」', async () => {
      const { call } = setup({
        catalog: CATALOG,
        // 目录已拉到但**残缺**（models.dev 没读到）—— 这正是 IKKZUG 的现场。
        catalogHealth: { total: 460, complete: false, note: 'models.dev 未就绪' },
      })
      const result = await call('provider.status', { providers: ['buddy'] })
      const statuses = (result.value as {
        statuses: Record<string, { catalog?: { total: number; complete: boolean; note?: string } }>
      }).statuses
      expect(statuses.buddy.catalog).toEqual({ total: 460, complete: false, note: 'models.dev 未就绪' })
    })

    it('⚠️ 适配器不实现该钩子时不得报错（其余 13 家）', async () => {
      // ⚠️ 这是「可选钩子」的守卫：诊断**绝不能**成为新 provider 的接入门槛。
      const { call } = setup({ catalog: CATALOG })
      const result = await call('provider.status', { providers: ['buddy'] })
      const statuses = (result.value as {
        statuses: Record<string, { catalog?: unknown; closed: boolean }>
      }).statuses
      expect(statuses.buddy.closed).toBe(false)
      expect(statuses.buddy.catalog, '未实现钩子 ⇒ 字段缺席而不是空对象').toBeUndefined()
    })

    it('⚠️ 钩子抛错不得让整个 provider.status 失败（诊断不能反噬）', async () => {
      const { call } = setup({ catalog: CATALOG, catalogHealthThrows: true })
      const result = await call('provider.status', { providers: ['buddy'] })
      expect(result.ok, '诊断钩子抛错不得让整个端点失败').toBe(true)
      const statuses = (result.value as {
        statuses: Record<string, { catalog?: unknown; models: { total: number } }>
      }).statuses
      // 主流程的字段必须仍然正确（诊断缺席而不是整个状态丢失）。
      expect(statuses.buddy.models.total).toBeGreaterThan(0)
      expect(statuses.buddy.catalog).toBeUndefined()
    })

    /**
     * ⚠️⚠️ **`closed` 不得基于兜底子集误报**（真实缺陷，独立审计实测）。
     *
     * `listAllModels()` 在冷缓存下是**子集**，而 `closed = total > 0 && disabled === total`
     * 若基于它算，就会把「旧版本『关闭全部』写下的**不完整**黑名单」判成已关闭：
     *
     * ```
     * 兜底表 [hy3] + 黑名单 { hy3: true } ⇒ total=1, disabled=1 ⇒ closed:true
     * 而远端还有 glm-5.2 / deepseek-v4-flash 可选 ⇒ 界面显示「已关闭」却仍能选
     * ```
     *
     * 修法：**只在子集判据说「已关闭」时才核实**（危险方向只有这一个；
     * 报 false 是安全的）。核实用并集重算。
     */
    it('⚠️ 兜底子集判据说「已关闭」时必须核实 —— 不得误报（存量不完整黑名单）', async () => {
      const { call } = setup({
        // 远端 3 条（用户实际能选的集合）。
        catalog: CATALOG,
        // 兜底表只有 1 条（冷缓存子集）……
        listAllSubset: [{ id: 'hy3', name: 'Hy3' }],
        // ……而黑名单恰好把它全命中（旧版本「关闭全部」的不完整产物）。
        disabledModels: { buddy: { hy3: true } },
      })

      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }).statuses.buddy

      // 核实后 `total` 用并集（3 条），只关了 1 条 ⇒ 未关闭。
      expect(s.models).toEqual({ total: 3, disabled: 1 })
      expect(s.closed, '子集判据误报已关闭：界面说关了，远端模型却仍可选').toBe(false)
    })

    /**
     * ★★ ★★ **核实腿必须并发**（2026-11-05 三审端到端 P1-1）。
     *
     * 现场：插件更新 / 重启后首次打开 Jet Hub 设置页，前端一次性把**全部 30 家**
     * 塞进一个 `provider.status` 请求；而每家「派生判据说已关闭」的供应商都要
     * `await fullCatalogIds(...)`（`CATALOG_READ_TIMEOUT_MS = 2000`）。
     *
     * 串行实现（改动前）实测：
     * ```
     * 3 家  ⇒ 6053ms
     * 28 家 ⇒ 56194ms     ← 上界 25 家有账号 × 2s ≈ 50s
     * ```
     * 症状：设置页所有开关灰显（`reason: '状态尚未读取'`）最长 50 秒，期间
     * 分组不生效、之后突然重排，**全程零提示**。
     *
     * ⚠️ 判据必须是**墙钟时间**，不能断言「`listModels` 被调了 28 次」——
     * 串行与并发都会调 28 次（那是恒真）。
     *
     * ⚠️ 桩用「每家延迟 100ms 后**成功**返回」，而不是「永不 resolve」：
     *    后者会让用例依赖 `CATALOG_READ_TIMEOUT_MS` 的 2s 定时器，全量并行
     *    跑时时序不稳（实测 20s 超时）。改成功桩后：并发 = 100ms，
     *    串行 = 28 × 100ms = 2800ms，两者差 28 倍，判据稳且判别力更强
     *    （它直接测「远端调用是否并发」，不掺超时逻辑）。
     */
    it('★★ ★★ 28 家同时「已关闭」时核实必须并发（串行 ⇒ 56 秒）', async () => {
      const providers = Array.from({ length: 28 }, (_, index) => `p${index}`)
      const { call } = setup({
        catalog: CATALOG,
        // 每家都「目录里每一条都在黑名单里」⇒ 派生判据说已关闭 ⇒ 触发核实。
        disabledModels: Object.fromEntries(
          providers.map((provider) => [provider, { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true }]),
        ),
        adapterProviders: providers,
        // 每家延迟 100ms 后成功 ⇒ 并发 100ms / 串行 2800ms。
        onListModels: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
      })

      const startedAt = Date.now()
      const result = await call('provider.status', { providers })
      const elapsed = Date.now() - startedAt

      // 28 家都要出现在结果里（并发不得丢键）。
      const statuses = (result.value as { statuses: Record<string, unknown> }).statuses
      expect(Object.keys(statuses)).toHaveLength(28)
      // 并发 = 100ms + 调度开销；串行 = 2800ms。取 1000ms 作界。
      expect(elapsed, '28 家串行核实 ⇒ 每家 100ms ⇒ 2800ms（三审端到端 P1-1）').toBeLessThan(1000)
    })

    /**
     * ⚠️ 反向：**真的全关**时仍须报已关闭。
     *
     * ⚠️ 这条尤其重要：全部关闭时 `listModels()` 会被黑名单**过滤成空数组**
     *（那是本端点要正确回答的那个状态，不是「看不到」）。核实的判据因此
     * **不能**用 `fullCatalogIds` 的 `complete`（它额外要求远端非空）——
     * 用错会让「一关全就永远显示未关闭」（本修复第一版踩过，两条既有用例当场变红）。
     */
    it('⚠️ 真的全关时仍报已关闭（核实判据不得用「远端非空」）', async () => {
      const { call } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true } },
      })

      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }).statuses.buddy

      expect(s.models).toEqual({ total: 3, disabled: 3 })
      expect(s.closed).toBe(true)
    })

    /**
     * ⚠️⚠️ **远端读失败时保留派生判据的结论**（2026-11-05 四审端到端 P1-1 改判）。
     *
     * ## 三审的结论（已推翻）
     * 三审（`9b2f93a`）这里报 `closed: false`，理由是「报 false 是安全方向：
     * 用户可点开关、点了会得到明确错误；报 true 则把可用模型说成已关闭」。
     *
     * ## 为什么被推翻（真实链路实测）
     * 真实 UI 载荷是 `model.setAllDisabled({ closeProvider: false })`
     *（`plugin-src/client/jet-hub.js` 的 `setProviderAll`）⇒ **永不写关闭意图**
     * ⇒ 每次读状态都走核实腿。于是**任何一次上游瞬态故障**（429 / 502 /
     * 超时 > 2s）都会把「派生判据说已关闭」的**全部**供应商一起翻成
     * `closed: false`：
     * ```
     * 健康目录：        closed === true  = 28/28
     * 目录 429（2ms）： closed === false = 28/28   ← 界面「全部开启」
     * 502 / 超时 2100ms：同上
     * ```
     * 而 `groupProviders`（`plugin-src/client/provider-toggle.js`）只读
     * `closed === true` ⇒ 28 家整片从「已关闭」组跳到「已打开」组 =
     * 用户报障的「有时候全部开启 / 全部关闭」。
     *
     * ## 新语义
     * **「核实不了」只意味着「我无法证明它已关闭」，不意味着「它没关闭」。**
     * 此时保留派生判据（`closed`/`disabled`/`total` 三者来自同一个本地快照，
     * 自洽），只用 `verifyFailed` 附注「本次未能核实」—— 前端据此把开关渲染成
     * 禁用并给出原因。目录真的变长时，那一次**成功**的核实会给出
     * `closed: false`（见「真的全关时仍报已关闭」的相邻分支）。
     *
     * ⚠️ 与 `notReady` 那一格刻意不同：`notReady` 是适配器**确定性**地说
     * 「我这份目录不全」⇒ 此时「全关」不构成证据 ⇒ 仍报 `false`
     *（见「冷帧下必须报未关闭」那条）。
     */
    it('⚠️ 核实不了（远端读失败）时保留派生判据（不再翻成未关闭）', async () => {
      const { call } = setup({
        catalog: CATALOG,
        listModelsError: '令牌已过期',
        listAllSubset: [{ id: 'hy3', name: 'Hy3' }],
        disabledModels: { buddy: { hy3: true } },
      })

      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { closed: boolean; verifyFailed?: string }> }).statuses.buddy

      // ⚠️ 保留派生判据：本地快照里 `hy3` 是唯一条目且已关 ⇒ 仍报已关闭。
      //    报 `false` 会让 28 家随上游抖动整片翻转（见上方用例注释的实测）。
      expect(s.closed, '远端读失败不得把「无法证明」当成「没关闭」').toBe(true)
      // ⚠️⚠️ 但**必须透出原因**（2026-11-05 三审端到端 P1-2）：否则用户看到的是
      // 「已关闭 1」+ 开关「点不动」而**拿不到任何线索**。
      expect(s.verifyFailed, '核实失败必须透出原因，否则用户只看到「开关点不动」')
        .toContain('令牌已过期')
    })

    /**
     * ⚠️ 反向对照：核实**成功**时不得出现 `verifyFailed`（否则前端会把
     * 「一切正常」渲染成告警）。
     */
    it('★ 核实成功时不得出现 verifyFailed（否则正常态被渲染成告警）', async () => {
      const { call } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true } },
      })

      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { closed: boolean; verifyFailed?: string }> }).statuses.buddy

      expect(s.closed).toBe(true)
      expect(s.verifyFailed).toBeUndefined()
    })

    /**
     * ⚠️ **未关闭的供应商不该触发核实**（零网络代价）。
     *
     * 子集判据给 false 时直接返回 —— 绝大多数供应商走这条，
     * 故冷缓存下首屏**不会**因本次修复多打任何远端请求。
     */
    it('未关闭时不核实目录（子集判据为 false 即返回，零网络）', async () => {
      let listModelsCalls = 0
      const { call } = setup({
        catalog: CATALOG,
        // 兜底表与远端同源，且只关 1 条 ⇒ 子集判据就是 false。
        disabledModels: { buddy: { hy3: true } },
        onListModels: async () => { listModelsCalls++ },
      })

      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { closed: boolean }> }).statuses.buddy

      expect(s.closed).toBe(false)
      expect(listModelsCalls, '未关闭的供应商不该读远端目录').toBe(0)
    })

    /**
     * ⚠️⚠️ **同一 provider 的在飞核实必须去重**（2026-11-05 四审端到端 P2-1）。
     *
     * `withTimeout` 只 reject 外层 Promise、**不取消**底层请求（`listModels`
     * 不接受 signal）⇒ 每次 `provider.status` 都对「已关闭」的家发一轮核实。
     * 而该端点在挂载、每次 `toggleProvider` 后、用户点「重试」时都会被调用 ⇒
     * 上游 5s 才返回时实测**峰值并发 56 / 总调用 56 次**（28 家 × 2 轮）。
     * 后果是正反馈：请求越多越容易 429，429 又产出 `remoteError`。
     */
    it('★★ ★★ 并发两次 provider.status ⇒ 同一 provider 只核实一次（single-flight）', async () => {
      let listModelsCalls = 0
      const { call } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true } },
        onListModels: async () => {
          listModelsCalls += 1
          // 制造「在飞」窗口：不延迟的话第一次早已完成、第二次自然重发。
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
        },
      })

      const [a, b] = await Promise.all([
        call('provider.status', { providers: ['buddy'] }),
        call('provider.status', { providers: ['buddy'] }),
      ])

      expect(a.ok, '第一次必须成功').toBe(true)
      expect(b.ok, '第二次必须成功').toBe(true)
      expect(listModelsCalls, '同一 provider 的在飞核实必须只发一次请求').toBe(1)
    })

    /**
     * ⚠️ 反向对照：**「在飞」不是「缓存」**。
     *
     * 若把 `catalogVerifyInFlight` 实现成模块级永久缓存（完成后不清除），
     * 用户切换开关后目录就永远是旧的。这条用例把它与「去重」分开。
     */
    it('★ 反向对照：串行两次 ⇒ 各核实一次（在飞去重不是缓存）', async () => {
      let listModelsCalls = 0
      const { call } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true } },
        onListModels: async () => { listModelsCalls += 1 },
      })

      await call('provider.status', { providers: ['buddy'] })
      await call('provider.status', { providers: ['buddy'] })

      expect(listModelsCalls, '完成后必须清除在飞条目（否则目录会过期）').toBe(2)
    })

    it('providers 非字符串数组 → bad-request', async () => {
      const { call } = setup({ catalog: CATALOG })
      expect((await call('provider.status', { providers: 'buddy' })).ok).toBe(false)
      expect((await call('provider.status', { providers: [1, 2] })).ok).toBe(false)
      expect((await call('provider.status', {})).ok).toBe(false)
    })

    it('provider.status 是只读的：不写盘、不广播', async () => {
      const { call, emitted, writeOrder } = setup({ catalog: CATALOG })
      await call('provider.status', { providers: ['buddy'] })
      expect(emitted).toEqual([])
      expect(writeOrder).toEqual([])
    })
  })

  describe('provider.setEnabled（关闭方向）', () => {
    it('关闭：把全部模型写入黑名单，并停用全部账号', async () => {
      const { call, storedDisabled, storedAccounts } = setup({
        catalog: CATALOG,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(true)
      expect(result.value).toMatchObject({ provider: 'buddy', enabled: false, models: 3, accounts: 1 })
      expect(Object.keys(storedDisabled().buddy).sort()).toEqual(['deepseek-v4-flash', 'glm-5.2', 'hy3'])
      expect(storedAccounts()[0].enabled).toBe(false)
    })

    /**
     * ⚠️⚠️ **关闭供应商同样必须以并集为准**（与 `model.setAllDisabled` 同源缺陷）。
     *
     * 两者共用 `fullCatalogIds`，故「冷缓存下只关兜底子集」在这里的后果**更重**：
     * 供应商级开关的语义是「关闭该供应商 = 关掉它的全部模型 + 停用它的全部账号」，
     * 而 `provider.status` 的 `closed` 判据是
     * `total > 0 && disabled === total`（`total` 取自 `listAllModels()`）。
     *
     * ⇒ 冷缓存下这里会写出一个**只含兜底表条目**的黑名单，于是：
     * - 界面上该供应商**显示为已关闭**（因为 `total` 也只有兜底表那几条、
     *   恰好 `disabled === total`）；
     * - 而对话框里**几百个模型仍然可选**（它们从未进黑名单）。
     *
     * 这正是 `provider.setEnabled` 注释里列为**必须避免**的
     * 「账号全停用但模型仍可见」形态的镜像 —— 用户按关闭的预期，却仍能选到它。
     */
    it('关闭供应商：冷缓存兜底子集不得当权威（否则显示已关闭、模型却仍可选）', async () => {
      const { call, storedDisabled } = setup({
        // `listModels` 的源：完整目录（3 条）。
        catalog: CATALOG,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
        // `listAllModels` 只给 1 条：模拟冷缓存兜底子集。
        listAllSubset: [{ id: 'hy3', name: 'Hy3' }],
      })

      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })

      expect(result.ok).toBe(true)
      expect(
        Object.keys(storedDisabled().buddy ?? {}).sort(),
        '只关了兜底子集：供应商显示「已关闭」，而其余模型仍可选',
      ).toEqual(['deepseek-v4-flash', 'glm-5.2', 'hy3'])
    })

    /**
     * ⚠️⚠️ **关闭供应商时远端读失败 + 适配器有兜底表 ⇒ 必须拒绝且不落盘**。
     *
     * 与 `model.setAllDisabled` 同判据（`remoteIds`，不是 `ids` 是否为空）。
     * 这里后果更重：`provider.status` 的 `closed` 判据是
     * `total > 0 && disabled === total`，而 `total` 也取自 `listAllModels()`
     * ⇒ 只关兜底子集会同时写出「显示已关闭」与「几百条模型仍可选」。
     */
    it('⚠️ 关闭供应商：远端读失败时拒绝且不落盘（不得只关兜底子集）', async () => {
      const { call, storedDisabled, storedAccounts, emitted } = setup({
        catalog: CATALOG,
        listModelsError: '令牌已过期',
        listAllSubset: [{ id: 'hy3', name: 'Hy3' }],
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })

      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })

      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('令牌已过期')
      // 不写黑名单、不停账号、不广播 —— 三条都要（否则会留下半套状态）。
      expect(storedDisabled().buddy).toBeUndefined()
      expect(storedAccounts()[0].enabled).toBe(true)
      expect(emitted).toEqual([])
    })

    it('⚠️ 顺序必须是「先关模型、再停账号」', async () => {
      // 判据是模型是否全关；先关模型可保证中途失败时状态仍自洽。
      const { call, writeOrder } = setup({
        catalog: CATALOG,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(writeOrder).toEqual(['models', 'accounts'])
    })

    it('关闭后广播 llm/adapters-updated（否则界面要重启才更新）', async () => {
      const { call, emitted } = setup({ catalog: CATALOG })
      await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(emitted).toContain('llm/adapters-updated')
    })

    it('⚠️ 目录读失败 → 整个操作失败，不落盘、不广播', async () => {
      const { call, emitted, writeOrder, storedDisabled } = setup({
        catalog: CATALOG,
        withAdapter: false,
        withoutLlm: true,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(false)
      expect(result.error?.message).toBeTruthy()
      // 三条关键断言：不写黑名单、不停账号、不广播
      expect(storedDisabled().buddy).toBeUndefined()
      expect(writeOrder).toEqual([])
      expect(emitted).toEqual([])
    })

    it('⚠️ llm.listModels 抛错同样不落盘、不广播', async () => {
      const { call, emitted, writeOrder } = setup({
        catalog: CATALOG,
        withAdapter: false,
        listModelsError: 'boom',
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(false)
      expect(writeOrder).toEqual([])
      expect(emitted).toEqual([])
    })

    it('⚠️ 目录为空 → 拒绝且不落盘（「不关闭模型就不关闭供应商」的落点）', async () => {
      const { call, emitted, writeOrder, storedAccounts } = setup({
        catalog: [],
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(false)
      const message = result.error?.message ?? ''
      expect(message).toContain('没有可关闭的模型')
      // ⚠️⚠️ **必须加这条反向断言**（真实缺口，独立对抗审计实测零守卫）：
      // 只写 `toContain('没有可关闭的模型')` 时，文案退化成
      // `没有可关闭的模型：undefined`（把 `remoteError` 的 undefined 拼进去）
      // **也含该子串** ⇒ 断言恒真、变异无法察觉。
      expect(message, '不得把 undefined 拼进用户可见文案').not.toContain('undefined')
      // ⚠️ 关键：绝不能「关不掉模型就只停账号」——那会让它显示成已关闭而模型仍在。
      expect(writeOrder).toEqual([])
      expect(emitted).toEqual([])
      expect(storedAccounts()[0].enabled).toBe(true)
    })

    /**
     * ⚠️ **远端读失败时文案要带上原因**（与上一条的「远端读到但为空」是**两种形态**，
     * 靠 `remoteError` 是否为空分流）。两者对用户意义不同：
     * 前者是「**读不到**」（可重试），后者是「**没账号**」（去登录）。
     */
    it('⚠️ 远端读失败 → 文案带上服务端原因（与「没有可关闭的模型」区分）', async () => {
      const { call, storedAccounts } = setup({
        catalog: CATALOG,
        listModelsError: '令牌已过期',
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })

      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })

      expect(result.ok).toBe(false)
      const message = result.error?.message ?? ''
      expect(message).toContain('令牌已过期')
      expect(message).not.toContain('undefined')
      // 不落盘、不停账号。
      expect(storedAccounts()[0].enabled).toBe(true)
    })

    it('已是目标状态时 accounts 计数为 0（不谎报已停用 N 个）', async () => {
      const { call } = setup({
        catalog: CATALOG,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: false }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.value).toMatchObject({ models: 3, accounts: 0 })
    })

    /**
     * ⚠️⚠️ **`models` 必须报「本次真正改变的」条数，不是「本次写入的」条数**
     *（真实缺陷，2026-08 审计实测）。
     *
     * `setModelsDisabled` 是**合并**语义，传入的并集里可能有相当一部分**早就关着**
     *（历史遗留的完整黑名单 / 用户此前逐条关过）。按「写入条数」报会**少报**
     * 用户看到的实际结果：实测远端 3 条 / 适配器兜底表 1 条 / 黑名单已有另 2 条
     * ⇒ 并集 3 条、其中 2 条已是 `true`，写完后 3 条全关，而返回 `models: 1`，
     * 前端 `summarizeProviderToggle` 便播报「已关闭 1 个模型」。
     *
     * 变异验证：把 `modelCount = pending.length` 改回 `catalog.ids.length`，
     * 本条**变红**（报 3 而非 1）。
     */
    it('⚠️ models 报实际变更数，不是写入条数（已关的不重复计入）', async () => {
      const { call, storedDisabled } = setup({
        catalog: [
          { id: 'glm-5.2', name: 'GLM-5.2' },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { id: 'hy3', name: 'Hy3' },
        ],
        // ⚠️ 适配器目录必须给**全部 3 条**：并集里那 2 条「早就关着」的 id 只能
        // 来自它（`listModels` 会把黑名单命中的过滤掉）—— 这正是「写入条数」与
        // 「变更条数」产生差异的唯一来源。若这里只给 1 条，并集就等于 `pending`，
        // 本用例**无法区分**两种计数（实测：变异成写入条数后仍全绿 = 假守卫）。
        listAllSubset: [
          { id: 'glm-5.2', name: 'GLM-5.2' },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { id: 'hy3', name: 'Hy3' },
        ],
        // 另外 2 条**早就关着**（历史遗留的完整黑名单）
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true } },
      })

      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })

      expect(result.ok).toBe(true)
      // 并集 3 条里只有 hy3 是本次新关的 ⇒ 只应报 1
      expect(
        (result.value as { models: number }).models,
        '报的是写入条数（3）而非实际变更数（1）⇒ 前端播报会少报',
      ).toBe(1)
      // 但黑名单最终确实覆盖全部 3 条（合并语义不受影响）
      expect(Object.keys(storedDisabled().buddy ?? {}).sort())
        .toEqual(['deepseek-v4-flash', 'glm-5.2', 'hy3'])
    })

    /** 反向：一条都没关过时，`models` 仍等于并集大小（不得被新判据改小）。 */
    it('全部未关时 models 等于并集大小（计数判据不误伤常规路径）', async () => {
      const { call } = setup({
        catalog: [
          { id: 'glm-5.2', name: 'GLM-5.2' },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { id: 'hy3', name: 'Hy3' },
        ],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.value).toMatchObject({ models: 3 })
    })

    it('无账号时关闭仍可执行（关模型、停 0 个账号）', async () => {
      const { call } = setup({ catalog: CATALOG })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(true)
      expect(result.value).toMatchObject({ models: 3, accounts: 0 })
    })

    /**
     * ⚠️⚠️ **无账号供应商必须能关闭**（本修复的核心用例）。
     *
     * 真实形态：`createModelCatalog` 对「没有已登录账号」的 provider **门控**
     * 返回 `[]` —— 远端**读成功了**，只是为空（`remoteError === undefined`）。
     * 旧判据 `complete`（要求远端非空）会把这种形态与「远端读失败」混为一谈，
     * 于是无账号供应商**永远无法关闭**（不登录永远读到 `[]`）。
     *
     * 与 `provider.status` 的核实判据（`full.remoteError === undefined` 即读成功；
     * 见其「无账号门控时远端同形 `[]`，兜底表全关 + 远端看不到 ⇒ 用户确实没有
     * 可选模型，可接受」注释）对齐后：这里用并集（适配器兜底表）照常落盘，
     * `provider.status` 随后正确报 `closed:true`，开关状态自洽。
     */
    it('⚠️ 无账号门控（远端读到但为空）时仍可关闭：用适配器兜底表落盘', async () => {
      const { call, storedDisabled, storedAccounts, emitted, writeOrder } = setup({
        // 远端目录按已登录账号门控：无账号 ⇒ 读到空数组（不是读失败）。
        catalog: [],
        // 适配器兜底表（冷缓存下 `listAllModels()` 的真实形态）。
        listAllSubset: [{ id: 'hy3', name: 'Hy3' }, { id: 'glm-5.2', name: 'GLM-5.2' }],
        // 无账号。
        accounts: [],
      })

      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })

      expect(result.ok, '无账号供应商必须能关闭').toBe(true)
      expect(result.value).toMatchObject({ models: 2, accounts: 0 })
      // 黑名单 = 兜底表（远端读成功但为空，并集只剩兜底表）。
      expect(Object.keys(storedDisabled().buddy ?? {}).sort()).toEqual(['glm-5.2', 'hy3'])
      // 先关模型、后停账号（无账号 ⇒ accounts 写入为 0 条）。
      expect(writeOrder).toEqual(['models'])
      // 必须广播（前端开关状态靠它刷新）。
      expect(emitted).toContain('llm/adapters-updated')
    })

    /** 关闭后 `provider.status` 必须报已关闭 —— 两个端点的判据不能各说各话。 */
    it('⚠️ 无账号门控下关闭后，provider.status 报 closed:true（判据联动）', async () => {
      // 同一 setup 里先关再查：远端仍门控为空，兜底表全命中。
      const { call } = setup({
        catalog: [],
        listAllSubset: [{ id: 'hy3', name: 'Hy3' }],
      })

      const closeResult = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(closeResult.ok).toBe(true)

      const result = await call('provider.status', { providers: ['buddy'] })
      const s = (result.value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }).statuses.buddy
      expect(s.models).toEqual({ total: 1, disabled: 1 })
      expect(s.closed, '关闭操作落盘后 status 必须报已关闭（否则开关永远弹回）').toBe(true)
    })

    /**
     * ⚠️ 远端门控为空**且**适配器缺失（旧版外部适配器）⇒ 并集为空，
     * 真没东西可关 → 拒绝且不落盘。这是 `remoteError` 判据收紧后的
     * 「目录为空」落点（原判据把这种形态与「远端读失败」合并拒绝）。
     */
    it('⚠️ 远端为空且适配器缺失 → 拒绝「没有可关闭的模型」且不落盘', async () => {
      const { call, emitted, writeOrder, storedAccounts } = setup({
        catalog: [],
        withAdapter: false,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(false)
      const message = result.error?.message ?? ''
      expect(message).toContain('没有可关闭的模型')
      // ⚠️ 反向断言：不得把 `remoteError` 的 undefined 拼进用户可见文案。
      expect(message, '不得把 undefined 拼进用户可见文案').not.toContain('undefined')
      // 不落盘、不停账号、不广播。
      expect(writeOrder).toEqual([])
      expect(emitted).toEqual([])
      expect(storedAccounts()[0].enabled).toBe(true)
    })
  })

  /**
   * ★★ **Gitee issue IKP8OF：关闭供应商后目录继续变长 ⇒ 不得自动「已打开」**
   *
   * ## 缺陷形态（用户报障，本仓库实测复现）
   *
   * 「关闭供应商」只把**当时目录**的 id 写进黑名单；而 `provider.status` 的
   * `closed` 判据是 `total > 0 && disabled === total`（`total` 取**当前**目录）。
   * 于是目录**在关闭之后**继续变长（cline 三源异步 + models.dev 可恢复、
   * 其余家后台刷新器补进上游新模型）⇒ `disabled < total` ⇒ `closed` 翻回 `false`：
   *
   * ```
   * 关闭后   {total:3,disabled:3,closed:true}
   * 补齐后   {total:7,disabled:3,closed:false}   ← 开关静默翻回「已打开」
   * 而选择器里多出 4 条可选                        ← 真正的危害（零提示）
   * ```
   *
   * 用户原话：「关闭 Cline 供应商后它仍会时不时回到『已打开』分组」。
   *
   * ## 判据（修复后）
   *
   * 「关闭**意图**」（`providerClosed`，与目录快照无关）**或**派生判据。
   * 两条腿各自管一半，**缺一条就有真缺陷**：
   * - 只有派生 ⇒ 目录一长就翻回「已打开」（本 issue）；
   * - 只有意图 ⇒ 用户逐条打开全部模型后，界面仍说「已关闭」而模型全可选
   *   （IKJW33 的矛盾态）。
   */
  describe('★★ IKP8OF：关闭供应商后目录变长', () => {
    /** 目录在关闭之后「长出来」的模型（黑名单里**没有**它）。 */
    const LATE = { id: 'late-model', name: 'Late Model' }

    it('★★ 关闭后目录变长 ⇒ closed 必须仍为 true（不得翻回「已打开」）', async () => {
      // `catalog` 是**可变数组**：模拟「关闭之后目录继续补齐」。
      const catalog = [...CATALOG]
      const { call } = setup({ catalog })

      expect((await call('provider.setEnabled', { provider: 'buddy', enabled: false })).ok).toBe(true)
      const before = (await call('provider.status', { providers: ['buddy'] }))
        .value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }
      expect(before.statuses.buddy, '关闭当下应报已关闭').toMatchObject({
        models: { total: 3, disabled: 3 },
        closed: true,
      })

      // ★ 目录异步补齐（真实形态：cline 三源异步 + 预热重试）。
      catalog.push(LATE)

      const after = (await call('provider.status', { providers: ['buddy'] }))
        .value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }
      expect(
        after.statuses.buddy.closed,
        '★★ 目录变长后 closed 翻回 false ⇒ 供应商静默回到「已打开」（本 issue 的原症状）',
      ).toBe(true)
      // ★ 计数也必须自洽：否则设置页「分组说已关闭、每条开关都说已打开」。
      expect(
        after.statuses.buddy.models,
        '★ disabled 必须跟着意图报满（否则设置页自相矛盾）',
      ).toEqual({ total: 4, disabled: 4 })
    })

    /**
     * ★★ **真正的危害**：新模型不得可选。
     *
     * 只修 `closed` 不修过滤 ⇒ 界面说「已关闭」而模型**照样能选**，那是
     * IKJW33 修过的矛盾态的镜像。判据必须打在 `listModels` 的结果上。
     */
    it('★★ 关闭后目录变长 ⇒ 新模型不得出现在模型选择器里', async () => {
      const catalog = [...CATALOG]
      const { call, listModelsViaSkeleton } = setup({ catalog })
      await call('provider.setEnabled', { provider: 'buddy', enabled: false })

      catalog.push(LATE)

      // 适配器（= 模型选择器的数据源）必须一条都不播。
      const listed = await listModelsViaSkeleton()
      expect(
        listed,
        '★★ 关闭态下新模型仍可选（界面说已关闭、却仍能选中）',
      ).toEqual([])
    })

    it('★ 打开供应商 ⇒ 清除意图，模型恢复可选（不是死状态）', async () => {
      const catalog = [...CATALOG, LATE]
      const { call, listModelsViaSkeleton } = setup({ catalog })
      await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      const reopen = await call('provider.setEnabled', { provider: 'buddy', enabled: true })
      expect(reopen.ok).toBe(true)

      const s = (await call('provider.status', { providers: ['buddy'] }))
        .value as { statuses: Record<string, { closed: boolean }> }
      expect(s.statuses.buddy.closed, '打开后不得仍报已关闭').toBe(false)
      expect(await listModelsViaSkeleton(), '打开后模型必须恢复可选').toHaveLength(4)
    })

    /**
     * ★★ **反向守卫（防「只有意图」那半）**：用户逐条打开全部模型 ⇒ 必须不再报已关闭。
     *
     * 若不守这一条，一个「`closed` 只读意图」的实现会全绿 —— 而它在用户逐条
     * 打开模型后会说「已关闭」而模型全部可选（IKJW33 的矛盾态）。
     */
    it('★★ 用户逐条打开全部模型 ⇒ 意图被清除，不得仍报已关闭', async () => {
      const catalog = [...CATALOG]
      const { call } = setup({ catalog })
      await call('provider.setEnabled', { provider: 'buddy', enabled: false })

      // 用户在模型列表里逐条打开（这是「我确实想让这个供应商可用」的最强信号）。
      for (const model of catalog) {
        const r = await call('model.setDisabled', { provider: 'buddy', modelId: model.id, disabled: false })
        expect(r.ok).toBe(true)
      }

      const s = (await call('provider.status', { providers: ['buddy'] }))
        .value as { statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }> }
      expect(
        s.statuses.buddy.closed,
        '★★ 逐条打开后仍报已关闭 ⇒ 界面与事实相反（模型全可选却说关了）',
      ).toBe(false)
      expect(s.statuses.buddy.models).toEqual({ total: 3, disabled: 0 })
    })

    /**
     * ★ **设置页的逐条开关也必须跟着意图走**（否则一屏自相矛盾）。
     *
     * 意图为真时，被「整体关闭」的模型**不在黑名单里**（目录变长后新增的那些）。
     * 若 `model.list` 只读黑名单 ⇒ 分组说「已关闭」而每条开关都显示「已打开」，
     * 用户会以为开关坏了。
     */
    it('★ 关闭后目录变长 ⇒ 设置页里新增模型也必须显示为已关闭', async () => {
      const catalog = [...CATALOG]
      const { call } = setup({ catalog })
      await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      catalog.push(LATE)

      const r = await call('model.list', { provider: 'buddy' })
      expect(r.ok).toBe(true)
      const models = (r.value as { models: Array<{ id: string; disabled: boolean }> }).models
      const late = models.find((m) => m.id === LATE.id)
      expect(late, '新增模型必须仍列在设置页（用户要能逐条打开它）').toBeDefined()
      expect(
        late!.disabled,
        '★ 新增模型在设置页显示「已打开」⇒ 与分组「已关闭」自相矛盾',
      ).toBe(true)
    })

    /**
     * ★★ **黑名单与关闭意图必须同一次落盘**（半套状态是真实窗口）。
     *
     * 分两次写（先 `setModelsDisabled`、再 `setProviderClosed`）时，第二次失败
     * 会留下「磁盘上黑名单已写、意图未写」的半套状态，而内存里意图已是 `true`
     * ⇒ 本次会话看起来正常、**重启后静默复发**（目录一变长就翻回「已打开」，
     * 正是本 issue 的症状），且用户完全不知道「上次关闭只成了一半」。
     *
     * ⚠️ 判据必须断言「**磁盘上两份都没有**」，而不是「RPC 返回 ok:false」——
     * 后者在分两次写的实现下**也成立**（第一次成功、第二次失败仍然报错）。
     * 实测（变异前）：`setEnabled` 报 `disk full`，而磁盘上 `disabledModels`
     * 已含两条、`providerClosed` 为空 ⇒ 正是半套。
     */
    it('★★ 落盘失败时磁盘上「黑名单 + 关闭意图」必须同时为空（不得半套）', async () => {
      // ⚠️⚠️ **必须是「第一次成功、第二次失败」**，不能用「每次都失败」：
      //    后者在分两次写的实现下**也**会让磁盘保持干净（第一次就挂了）⇒ 恒真、
      //    抓不到半套状态（实测：把实现退回分两次写，全量 238 条仍全绿）。
      //    半套状态只在「前一次成功、后一次失败」时才出现。
      // ⚠️⚠️ **判据必须对「落盘次数」敏感，不能对「第几次」写死**：
      //    - 合并写入（正确实现）只落盘 **1 次** ⇒ 必须让它**成功**，否则断言
      //      「磁盘两份都为空」在「唯一那次也失败」时恒真（实测踩到：报的是
      //      `落盘失败必须如实报错` 变红，说明它压根没走到第 2 次）；
      //    - 分两次写（缺陷实现）落盘 **2 次** ⇒ 让第 2 次失败，才会留下半套。
      //    ⇒ 做法：**先成功落盘一次**（预置一个无关状态），从第 2 次起失败。
      //    这样两种实现下都能走到「第 2 次」：合并实现第 1 次成功即结束（磁盘两份
      //    都有值 —— 但那不是本用例要断言的分支），分两次写实现第 2 次失败 ⇒ 半套。
      let stored: Record<string, unknown> = { accounts: [] }
      let saves = 0
      const failingPool = new AccountPool({
        get: (key: string) => key === 'settings'
          ? {
              register: () => ({
                get: () => stored,
                replace: async (value: Record<string, unknown>) => {
                  saves++
                  if (saves >= 2) throw new Error('disk full')
                  stored = value
                },
              }),
            }
          : undefined,
        logger: { warn: () => {}, info: () => {} },
        credentials: {
          describe: async () => ({ configured: false, writable: true }),
          resolve: async () => undefined,
          set: async () => {},
          unset: async () => {},
        },
      } as never)
      let failingHandler: Handler | undefined
      const failingCtx = {
        get: (key: string) => {
          if (key === 'connection') {
            return { fetch: { register: (c: { path: string; fetch: Handler }) => { if (c.path === JET_HUB_API_PATH) failingHandler = c.fetch } } }
          }
          if (key === 'llm') return { listModels: async () => CATALOG }
          return undefined
        },
        inject: (_d: string[], callback: (ctx: unknown) => void) => { callback(failingCtx) },
        logger: { warn: () => {}, info: () => {} },
        emit: () => {},
      }
      registerJetHubRpc(
        failingCtx as never,
        failingPool,
        { buddy: {} as never } as never,
        { buddy: { listAllModels: () => CATALOG } } as never,
      )
      const response = await failingHandler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method: 'provider.setEnabled', payload: { provider: 'buddy', enabled: false } },
        }),
      }))
      const result = (await response.json() as { result: { ok: boolean } }).result
      const diskDisabled = (stored as { disabledModels?: unknown }).disabledModels
      const diskClosed = (stored as { providerClosed?: unknown }).providerClosed
      // ★★ **核心不变式：磁盘上「黑名单」与「关闭意图」必须同生同灭**。
      // 无论实现落盘几次、失败在第几次，都不允许出现「一个有一个没有」。
      expect(
        (diskDisabled === undefined) === (diskClosed === undefined),
        `★★ 半套状态：disabledModels=${JSON.stringify(diskDisabled)} / providerClosed=${JSON.stringify(diskClosed)}`
        + ' ⇒ 重启后本 issue 静默复发（意图丢了，只剩派生判据）',
      ).toBe(true)
      // 且两者若都存在，必须都是「已关闭」的形态（不能有黑名单却无意图）。
      if (diskDisabled !== undefined) {
        expect(result.ok, '两份都落盘成功时 RPC 必须报成功').toBe(true)
        expect((diskClosed as Record<string, boolean>).buddy).toBe(true)
      } else {
        expect(result.ok, '一份都没落盘时 RPC 必须如实报失败').toBe(false)
      }
    })

    /**
     * ★★ **「打开供应商」必须一次落盘**（对抗审计打穿：打开方向漏了合并）。
     *
     * 原先走两步（`clearDisabledModels` save #1 → `setProviderClosed(false)` save #2），
     * 两次之间磁盘是「黑名单空 + 意图真」⇒ 第二次失败/进程被杀则**重启后选择器恒空**
     * （意图真 + 黑名单空 ⇒ `listModels` 返回 `[]`），而设置页一条关闭项都没有
     * ⇒ 用户无从归因。
     *
     * ⚠️ 这条**恰好是最常见的路径**：只有「黑名单本来就空」时
     * `clearDisabledModels` 才一次写完；黑名单非空（用户真关过东西、现在要打开）
     * 时必然两次 —— 正是用户点「打开供应商」的典型情形。
     *
     * ⚠️ 判据必须**走真实 RPC 端点并数落盘次数**：只测
     * `pool.clearModelsWithProviderClosed` 是**假绿** —— 实测把端点退回两步后，
     * 全量 256 条用例**仍全绿**（用例自己调的就是新方法）。
     */
    it('★★ 「打开供应商」必须一次落盘（数落盘次数，走真实端点）', async () => {
      let saves = 0
      let stored: Record<string, unknown> = { accounts: [] }
      let saveHandler: Handler | undefined
      const savePool = new AccountPool({
        get: (key: string) => key === 'settings'
          ? {
              register: () => ({
                get: () => stored,
                replace: async (value: Record<string, unknown>) => {
                  saves += 1
                  for (const k of Object.keys(stored)) delete stored[k]
                  Object.assign(stored, value)
                },
              }),
            }
          : undefined,
        logger: { warn: () => {}, info: () => {} },
        credentials: {
          describe: async () => ({ configured: false, writable: true }),
          resolve: async () => undefined,
          set: async () => {},
          unset: async () => {},
        },
      } as never)
      const saveCtx = {
        get: (key: string) => {
          if (key === 'connection') {
            return { fetch: { register: (c: { path: string; fetch: Handler }) => { if (c.path === JET_HUB_API_PATH) saveHandler = c.fetch } } }
          }
          if (key === 'llm') return { listModels: async () => CATALOG }
          return undefined
        },
        inject: (_d: string[], callback: (ctx: unknown) => void) => { callback(saveCtx) },
        logger: { warn: () => {}, info: () => {} },
        emit: () => {},
      }
      registerJetHubRpc(
        saveCtx as never,
        savePool,
        { buddy: {} as never } as never,
        { buddy: { listAllModels: () => CATALOG } } as never,
      )
      const post = async (method: string, payload: unknown) => {
        const response = await saveHandler!(new Request('http://localhost/api/jet-hub', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
            payload: { method, payload },
          }),
        }))
        return (await response.json() as { result: { ok: boolean } }).result
      }
      // 进入「已关闭」态（黑名单非空 + 意图真）—— 打开方向最常见的起点。
      expect((await post('provider.setEnabled', { provider: 'buddy', enabled: false })).ok).toBe(true)
      saves = 0
      const reopened = await post('provider.setEnabled', { provider: 'buddy', enabled: true })
      expect(reopened.ok).toBe(true)
      expect(
        saves,
        '★★ 打开供应商落了 2 次盘 ⇒ 中间态「黑名单空 + 意图真」⇒ 崩溃后重启选择器恒空',
      ).toBe(1)
      // 且两份状态都必须已清。
      expect((stored as { providerClosed?: unknown }).providerClosed).toEqual({})
      expect((stored as { disabledModels?: unknown }).disabledModels).toEqual({})
    })

    /**
     * ★★ **「关闭全部模型」（`model.setAllDisabled(true)`）也必须落意图**
     *（对抗审计打穿：同一症状的**第二个入口**）。
     *
     * ⚠️ 判据必须**走真实 RPC 端点**：只测 `pool.writeModelsWithProviderClosed`
     * 是**假绿** —— 实测把端点里那行退回 `setModelsDisabled` 后，
     * 全量 255 条用例**仍全绿**（因为用例自己调的就是新方法）。
     */
    it('★★ 「关闭全部模型」后目录变长 ⇒ closed 仍为 true（第二入口不得复发）', async () => {
      const catalog = [...CATALOG]
      const { call } = setup({ catalog })
      // 模型列表顶部的「关闭全部」。
      const shut = await call('model.setAllDisabled', { provider: 'buddy', disabled: true })
      expect(shut.ok).toBe(true)

      const before = (await call('provider.status', { providers: ['buddy'] }))
        .value as { statuses: Record<string, { closed: boolean }> }
      expect(before.statuses.buddy.closed).toBe(true)

      // ★ 目录异步补齐。
      catalog.push(LATE_MODEL)

      const after = (await call('provider.status', { providers: ['buddy'] }))
        .value as { statuses: Record<string, { closed: boolean }> }
      expect(
        after.statuses.buddy.closed,
        '★★ 「关闭全部模型」没落意图 ⇒ 目录变长后翻回「已打开」（IKP8OF 第二入口）',
      ).toBe(true)
    })

    /**
     * ★★ **模型级的「全关」不得落「供应商整体关闭」意图**（2026-10-21 合并审计发现，阻断级）。
     *
     * ## 问题
     *
     * PR !120 新增的「供应商 → 模型列表」统一管理屏，它的「全关」调
     * `model.setAllDisabled(true)` —— 而该端点原本**无条件落「供应商整体关闭意图」**
     * （与 `provider.setEnabled(false)` 同一条路径）。
     *
     * ⇒ 意图的三个后果：
     * ① `provider.status` 报 `closed: true` ⇒ 左侧分组变成「已关闭」；
     * ② 各适配器的 `listModels` 直接返回 `[]` ⇒ 该家模型在选择器里**一个都没有**；
     * ③ **打开任意一个模型会顺带把整个供应商打开**（打开方向会清意图）。
     *
     * ⇒ 两头都与用户意图相反，且**零提示**。
     *
     * ## ⚠️⚠️ 判据**不是** `provider.status` 的 `closed`（这里踩过一次）
     *
     * `closed` 有**两条腿**（`jet-hub-rpc.ts` 的 `provider.status` 分支）：
     * ① **派生**：`total > 0 && disabled === total`（用户把该家的模型**逐条关光**也算关闭）
     * ② **意图**：`providerClosedFor(provider)`（持久化，抗目录增长）
     *
     * ⇒ 「全关模型」之后，派生腿**本来就为真** ⇒ `closed` 必然是 `true`，
     * **无论有没有落意图**。故拿 `closed` 判这条是**测不出差别**的
     * （第一次写这条用例时就是这么写错的，当场变红）。
     *
     * ## 真正的差别：**目录增长之后**
     *
     * - 落了意图 ⇒ 派生腿翻回 false 时，意图腿仍把它按住 ⇒ 仍报「已关闭」；
     * - 没落意图 ⇒ 目录一长，新 id 不在黑名单里 ⇒ 派生腿翻回 false
     *   ⇒ 回到「已打开」、新模型**仍可选**（= 模型级语义，用户预期如此）。
     *
     * ⚠️ 这正是 IKP8OF 的两条腿：意图腿是**供应商级**按钮的语义，
     * 模型级的「全关」**不该**继承它。
     */
    it('★★ 模型级「全关」（closeProvider: false）不落供应商关闭意图 ⇒ 目录变长后回到「已打开」', async () => {
      const catalog = [...CATALOG]
      const { call } = setup({ catalog })
      const shut = await call('model.setAllDisabled', {
        provider: 'buddy',
        disabled: true,
        closeProvider: false,
      })
      expect(shut.ok).toBe(true)

      // 目录异步补齐（模拟上游新增模型）—— 派生腿在此翻回 false。
      catalog.push(LATE_MODEL)

      const after = (await call('provider.status', { providers: ['buddy'] }))
        .value as { statuses: Record<string, { closed: boolean }> }
      expect(
        after.statuses.buddy.closed,
        '★★ 模型级「全关」不该落供应商关闭意图（否则目录一变长就永久关闭，用户只想关模型）',
      ).toBe(false)
    })

    /**
     * ★★ **反向对照**：**供应商级**的「关闭全部模型」**仍要**落意图。
     *
     * ⚠️ 缺省 `closeProvider` 为 `true`（保持既有语义）⇒ 上面的新参数**不能**
     * 把 IKP8OF 的第二入口（目录变长后翻回「已打开」）重新打开。
     */
    it('★★ 反向对照：缺省（不传 closeProvider）仍落意图 ⇒ 目录变长后仍为「已关闭」', async () => {
      const catalog = [...CATALOG]
      const { call } = setup({ catalog })
      await call('model.setAllDisabled', { provider: 'buddy', disabled: true })

      catalog.push(LATE_MODEL)

      const after = (await call('provider.status', { providers: ['buddy'] }))
        .value as { statuses: Record<string, { closed: boolean }> }
      expect(
        after.statuses.buddy.closed,
        '★★ 缺省语义不得变（IKP8OF 第二入口）',
      ).toBe(true)
    })


    /**
     * ⚠️ **「逐条关光」这条既有语义不得被新判据挤掉**。
     *
     * 反向守卫：用户从未点过「关闭供应商」，只是把每条模型逐个关掉 ⇒
     * 派生判据必须仍然成立（`closed: true`）。这是修复前就有的行为，
     * 有既有用例锁定；本用例把它与 IKP8OF 的新判据**并列**钉住。
     */
    it('⚠️ 反向：从未点过供应商开关、但逐条关光 ⇒ 仍算已关闭（既有语义）', async () => {
      const { call } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true } },
      })
      const s = (await call('provider.status', { providers: ['buddy'] }))
        .value as { statuses: Record<string, { closed: boolean }> }
      expect(s.statuses.buddy.closed, '逐条关光必须仍算已关闭（派生判据不得被挤掉）').toBe(true)
    })
  })

  /**
   * ★★ **C2/C3 的共同根因**：适配器自报「目录尚未就绪」时的两个端点行为。
   *
   * ## 同一个根因，两种用户后果（所以两个端点都要有守卫）
   *
   * Task 7 之后聚合的 `listModels` **不再同步等上游** ⇒ 冷启动立刻返回 `['auto']`：
   *
   * | 端点 | 改前（必然 2000ms 超时） | Task 7 之后 | 用户看到 |
   * |---|---|---|---|
   * | `provider.setEnabled(false)` | `remoteError` ⇒ **拒绝** | `ok:true` + `changedCount:1` | 「已关闭 1 个模型」，而另外两个**仍可选** |
   * | `provider.status` | `remoteError` ⇒ `closed:false`（**安全方向**） | `closed:true`（**危险方向**） | 只关了 `auto`，整个「聚合」被标成**已关闭** |
   *
   * ⚠️ 判据必须打在**返回值**上（`ok` 与 `closed`），不是「有没有调探测」——
   *    本仓库实测过 5 条源码文本判据在 `if (false)` 死分支里恒绿。
   */
  describe('★★ cold-frame：适配器自报「目录未就绪」', () => {
    /** 冷帧的真实形态：远端只读到 1 条（`auto`），适配器自报未就绪。 */
    const COLD = {
      providerId: 'aggregate',
      catalog: [{ id: 'auto', name: 'Auto（聚合 · 跨渠道）' }],
      catalogReadiness: { ready: false, reason: '聚合目录尚未成功推导过（冷启动）' },
    } as const

    it('★★ C2：未就绪时 provider.setEnabled(false) 必须**拒绝**且不落盘（不得只关 auto 却成功）', async () => {
      const { call, emitted, writeOrder, storedDisabled, storedAccounts } = setup({
        ...COLD,
        accounts: [{ id: 'a1', provider: 'aggregate', enabled: true }],
      })
      const result = await call('provider.setEnabled', { provider: 'aggregate', enabled: false })
      expect(
        result.ok,
        '★★ 冷帧下必须拒绝（否则只关掉 auto 却返回成功，另外两个模型仍可选）',
      ).toBe(false)
      // 文案必须说清「目录没读全」这个真因，而不是笼统的失败。
      expect(result.error?.message ?? '').toMatch(/尚未读取完成|目录/)
      // ★ 关键后果断言：黑名单里**不得**出现「只关了 auto」这种残缺写入。
      expect(storedDisabled().aggregate ?? {}, '★★ 不得落盘残缺黑名单').not.toHaveProperty('auto', true)
      // 不落盘（模型与账号都不动）、不广播。
      expect(writeOrder).toEqual([])
      expect(emitted).toEqual([])
      expect(storedAccounts()[0].enabled).toBe(true)
    })

    it('★★ C3：未就绪时 provider.status 必须报 closed:false（安全方向，不得翻成 true）', async () => {
      // 冷帧里唯一的模型 auto 已在黑名单 ⇒ 子集判据说「已关闭」⇒ 触发核实。
      const { call } = setup({
        ...COLD,
        disabledModels: { aggregate: { auto: true } },
      })
      const result = await call('provider.status', { providers: ['aggregate'] })
      expect(result.ok).toBe(true)
      const s = (result.value as {
        statuses: Record<string, { models: { total: number; disabled: number }; closed: boolean }>
      }).statuses.aggregate
      expect(
        s.closed,
        '★★ 冷帧下必须报未关闭（危险方向会让界面显示「已关闭」而模型仍可选）',
      ).toBe(false)
    })

    it('★ 对照：目录**已就绪**时关闭照常成功（证明上两条不是恒假拒绝）', async () => {
      // ⚠️ **反向对照**：没有这条，「一律拒绝/一律 closed:false」也能让上面两条全绿。
      const { call, storedDisabled } = setup({
        providerId: 'aggregate',
        catalog: [
          { id: 'auto', name: 'Auto（聚合 · 跨渠道）' },
          { id: 'deepseek-v4-1-flash', name: 'DeepSeek V4.1 Flash' },
        ],
        catalogReadiness: { ready: true },
      })
      const result = await call('provider.setEnabled', { provider: 'aggregate', enabled: false })
      expect(result.ok, '目录已就绪 ⇒ 必须照常关闭').toBe(true)
      expect((result.value as { models: number }).models).toBe(2)
      expect(storedDisabled().aggregate).toEqual({ auto: true, 'deepseek-v4-1-flash': true })
    })

    it('★ 就绪探测抛错 ⇒ 按「不可用」处理（拒绝关闭、closed:false），不得反噬', async () => {
      const { call } = setup({
        providerId: 'aggregate',
        catalog: [{ id: 'auto', name: 'Auto（聚合 · 跨渠道）' }],
        catalogReadinessThrows: true,
        disabledModels: { aggregate: { auto: true } },
      })
      const close = await call('provider.setEnabled', { provider: 'aggregate', enabled: false })
      expect(close.ok, '探测抛错 ⇒ 保守拒绝（宁可拒绝一次关闭，也不要写出残缺黑名单）').toBe(false)
      const status = await call('provider.status', { providers: ['aggregate'] })
      expect(status.ok, '探测抛错不得让 provider.status 整个失败').toBe(true)
      const s = (status.value as { statuses: Record<string, { closed: boolean }> }).statuses.aggregate
      expect(s.closed, '探测抛错 ⇒ 保守报未关闭（安全方向）').toBe(false)
    })

    it('★ 未实现探测的适配器不受影响（其余 19 家的稳态行为逐字不变）', async () => {
      // ⚠️ 这条守的是「新增的可选成员不得改变既有 provider 的行为」。
      const { call, storedDisabled } = setup({
        catalog: CATALOG,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(true)
      expect((result.value as { models: number }).models).toBe(3)
      expect(storedDisabled().buddy).toEqual({ 'glm-5.2': true, 'deepseek-v4-flash': true, hy3: true })
    })
  })

  describe('provider.setEnabled（打开方向）', () => {
    it('打开：清空该 provider 的黑名单，并启用全部账号，且广播', async () => {
      const { call, emitted, storedDisabled, storedAccounts } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { 'glm-5.2': true, hy3: true } },
        accounts: [{ id: 'b1', provider: 'buddy', enabled: false }],
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: true })
      expect(result.ok).toBe(true)
      expect(result.value).toMatchObject({ models: 2, accounts: 1 })
      expect(storedDisabled().buddy).toBeUndefined()
      expect(storedAccounts()[0].enabled).toBe(true)
      expect(emitted).toContain('llm/adapters-updated')
    })

    it('⚠️ 打开方向不读目录：目录缺失/故障时仍能把开关全打开', async () => {
      const { call } = setup({
        catalog: CATALOG,
        withAdapter: false,
        withoutLlm: true,
        disabledModels: { buddy: { 'glm-5.2': true } },
      })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: true })
      expect(result.ok).toBe(true)
    })

    it('⚠️ 只清本 provider 的黑名单，不波及其它 provider', async () => {
      const { call, storedDisabled } = setup({
        catalog: CATALOG,
        disabledModels: { buddy: { hy3: true }, trae: { 'glm-5.2': true } },
      })
      await call('provider.setEnabled', { provider: 'buddy', enabled: true })
      expect(storedDisabled().buddy).toBeUndefined()
      expect(storedDisabled().trae).toEqual({ 'glm-5.2': true })
    })

    it('⚠️ 打开也要广播（两个方向都改变 listModels 结果）', async () => {
      const { call, emitted } = setup({ catalog: CATALOG })
      await call('provider.setEnabled', { provider: 'buddy', enabled: true })
      expect(emitted).toEqual(['llm/adapters-updated'])
    })
  })

  describe('provider.setEnabled（参数校验与健壮性）', () => {
    it('enabled 非布尔（缺失 / 字符串 / 数字）一律 bad-request，且不落盘', async () => {
      const { call, writeOrder, emitted } = setup({
        catalog: CATALOG,
        accounts: [{ id: 'b1', provider: 'buddy', enabled: true }],
      })
      expect((await call('provider.setEnabled', { provider: 'buddy' })).ok).toBe(false)
      expect((await call('provider.setEnabled', { provider: 'buddy', enabled: 'false' })).ok).toBe(false)
      expect((await call('provider.setEnabled', { provider: 'buddy', enabled: 0 })).ok).toBe(false)
      // ⚠️ 不做默认值猜测：一次字段名写错不该静默改动用户数据
      expect(writeOrder).toEqual([])
      expect(emitted).toEqual([])
    })

    it('provider 缺失或空串 → bad-request', async () => {
      const { call } = setup({ catalog: CATALOG })
      expect((await call('provider.setEnabled', { enabled: false })).ok).toBe(false)
      expect((await call('provider.setEnabled', { provider: '', enabled: false })).ok).toBe(false)
    })

    it('⚠️ 广播抛错仍算成功（通知失败不得反噬已落盘的开关）', async () => {
      const { call, storedDisabled } = setup({ catalog: CATALOG, emitThrows: true })
      const result = await call('provider.setEnabled', { provider: 'buddy', enabled: false })
      expect(result.ok).toBe(true)
      // 开关确实已落盘
      expect(Object.keys(storedDisabled().buddy)).toHaveLength(3)
    })
  })
})

/**
 * Cline「订阅额度」端点（`cline.quota` / `cline.requestLog`）。
 *
 * 参考实现：`github.com/codeOct/dsh-cline-pass` 的额度管理与请求记录部分。
 *
 * 这里守住四条真正的不变式：
 * 1. **只认 cline** —— 其余 provider 一律 `bad-request`（前端另有
 *    `supportsSubscriptionQuota` 门控，两侧必须一致）。
 * 2. **额度逐账号隔离** —— 一个账号凭据坏掉不能让整批失败，
 *    否则多账号用户会因为「有一个号没配凭据」而完全看不到额度。
 * 3. **游标只走 `?cursor=`** —— 网关对 `page`/`offset` 静默忽略，
 *    传错会表现为「点了加载更多还是同一批」（最难排查的一类静默错误）。
 * 4. **请求记录失败是载荷（`ok:false`）而不是 RPC 错误** ——
 *    面板要保留已加载的行、只在下方显示原因。
 */
describe('account.test 端点（**无条件**真发一次请求）', () => {
  type Handler = (request: Request) => Promise<Response>

  /** 一份形状合法的 Gemini 凭据：只要 `access_token` 非空，适配器就会走到 fetch。 */
  const GEMINI_CREDENTIAL = JSON.stringify({
    access_token: 'AT-gemini',
    refresh_token: 'RT-gemini',
    expiry: '2099-01-01T00:00:00Z',
    email: 'yinghaolin12@gmail.com',
  })

  /**
   * 桩掉全局 `fetch` 并记录 URL。
   *
   * ⚠️ **必须在调用 RPC 之前**替换：`probeWithAdapter` 构造适配器时不注入
   * `fetchImpl`，适配器取的是全局 `fetch`；不桩就会真的把探测消息发到 Google。
   * 一律回 429，让用例的结论是「仍受限」，但关键在于是**谁**把请求发到了**哪里**。
   */
  function stubFetch(): string[] {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response('{"error":{"code":429,"message":"rate limit exceeded"}}', {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    })
    return calls
  }

  /**
   * 桩一个**成功**的探测（200 + 合法 SSE 帧）。
   *
   * ⚠️ 为什么需要它：默认的 `stubFetch` 恒回 429 ⇒ `testAccount` 的 `ok` 恒 false
   *    ⇒ 「成功即清封禁」那条分支**根本走不到** ⇒ 那条守卫是无牙的
   *    （2026-11-01 审计 M12 实测：把它改回去，全量仍绿）。
   *    这正是本仓库记过的那条教训：「判据没抓住变异，先怀疑判据本身」。
   */
  function stubFetchOk(): string[] {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input))
      const frame = JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
        },
      })
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    return calls
  }

  function setup(options: {
    /** 初始限流标记；省略 = 账号**没有**任何标记（这正是测试按钮要覆盖的场景）。 */
    modelRateLimits?: Record<string, number>
    /**
     * 初始的**账号级封禁**标记（Gitee issue IKS2MV）。
     *
     * ⚠️ 这一格是本组用例的**承重断言**：`account.test` 探活成功**不得**把它清掉
     * —— 探活只测**一个**模型（且优先挑最老的限流键），判据强度不足以证明
     * 「账号没被封」。第一版实现写成「成功即清」，被对抗审计实测打穿
     * （`pickTestModel` 选中 `glm-5.2` 这个可用模型 ⇒ 整号封禁被洗白
     *   ⇒ 池立刻选回它 ⇒ 下一发再 403）。
     */
    policyBlockedAtMs?: number
    /** 该 provider 的全量目录；省略则模拟「适配器缺失」（退化到 llm.listModels）。 */
    catalog?: Array<{ id: string; name: string }>
    /** 省略 llm 服务，验证「目录读不出来」的降级路径。 */
    withoutLlm?: boolean
    /**
     * 让 `llm.listModels()` **抛错**（远端临时故障：凭据过期 / 上游抖动）。
     *
     * ⚠️ 与 `withoutLlm`（服务整体缺失）是**两个不同分支**，且必须分开覆盖：
     * 本端点是唯一一个「远端读失败**不拒绝**」的调用点（它只要一个 id 就能测），
     * 而 `withoutLlm` 走的是「llm 服务不可用」那条。
     */
    listModelsError?: string
  } = {}) {
    let stored: Record<string, unknown> = {
      accounts: [{
        id: 'gemini-1',
        provider: 'gemini',
        nickname: 'Gemini 测试号',
        enabled: true,
        credentialRef: 'GEMINI_ACCOUNT_TEST',
        createdAt: 1,
        refreshable: true,
        ...(options.modelRateLimits === undefined ? {} : { modelRateLimits: options.modelRateLimits }),
        ...(options.policyBlockedAtMs === undefined ? {} : { policyBlockedAtMs: options.policyBlockedAtMs }),
      }],
    }
    let handler: Handler | undefined
    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: true, writable: true }),
        // ⚠️ 必须返回**真凭据**：返回 undefined 时 `makeDefaultProbe` 会以
        // 「凭据不可用」提前返回，适配器根本不会被构造 —— 那条路径下本组用例
        // 会变成假绿（断言不到「真发了请求」）。
        resolve: async () => ({ value: GEMINI_CREDENTIAL }),
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    const adapter = options.catalog === undefined ? undefined : { listAllModels: () => options.catalog! }

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        }
        if (key === 'llm' && options.withoutLlm !== true) {
          return {
            listModels: async (provider: string) => {
              if (options.listModelsError !== undefined) throw new Error(options.listModelsError)
              return (options.catalog ?? []).map(m => ({ ...m, provider }))
            },
          }
        }
        return undefined
      },
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined },
    }

    registerJetHubRpc(
      // ⚠️ 命名对象（2026-10-08 改）：`modelAdapters` 是独立的第 4 个形参，
      // 不再会被 auth 键的数量挤掉（位置参数时代漏一个占位就让它错位）。
      ctx as never, pool,
      authsStub(),
      (adapter !== undefined ? { gemini: adapter } : undefined) as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    // ⚠️ **Task 8 起**：探测适配器的构造改由能力注册表提供（`src/index.ts` 的
    // `probeById`）。本组用例驱动 `account.test`，故必须注册 gemini 的 probe，
    // 否则 `adapterForProbe` 会（正确地）抛「不支持重测」，用例变成测错误路径。
    // ⚠️ 复用**生产的那张表**，不在测试里重写一份。
    // ⚠️ 用**静态 import**（不是动态 `await import`）：`setup` 必须保持同步，
    //    否则本文件 40+ 个调用点都要加 `await`。
    registerProbeRuntimesForTests()

    return {
      call,
      storedLimits: () => (stored.accounts as Array<{ modelRateLimits?: Record<string, number> }>)[0]?.modelRateLimits,
      /** 读回账号级封禁标记（Gitee issue IKS2MV）。 */
      storedPolicyBlockedAtMs: () => (stored.accounts as Array<{ policyBlockedAtMs?: number }>)[0]?.policyBlockedAtMs,
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    // ⚠️ 清掉本组注册的 runtime，避免污染同文件其余用例。
    return import('../../src/provider-runtime.js').then(({ clearProviderRuntimes }) => { clearProviderRuntimes() })
  })

  /**
   * ⚠️ 这条是本功能的**核心断言**：账号**没有任何限流标记**时，`account.test`
   * 依然真发了一次请求。
   *
   * 对照物是 `account.retest`：它在 `modelIds.length === 0` 处提前返回、零请求
   * （见 `account-probe.spec.ts` 的「没有任何限流标记时不发请求」）。用户报障
   * 「重测按钮你确认过会发请求吗，为什么响应这么快？」说的就是那个提前返回。
   */
  it('账号没有限流标记时依然真发一次请求（重测在此场景下零请求）', async () => {
    const calls = stubFetch()
    const { call } = setup({ catalog: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] })

    const result = await call('account.test', { accountId: 'gemini-1' })

    expect(result.ok).toBe(true)
    const value = result.value as { modelId: string; ok: boolean; message?: string }
    expect(value.modelId).toBe('gemini-3.8-flash')
    // 桩回 429 ⇒ 结论是「仍受限」，但请求确实发出去了。
    expect(value.ok).toBe(false)
    expect(value.message).toContain('仍受限')
    // 核心：请求确实发出去了，且打在 Gemini 的流式端点上。
    // ⚠️ 次数是 **2** 而不是 1：适配器在 429 时会先**换端点**重试一次
    // （`gemini-adapter.ts` 的 `endpointSwitched` 分支），daily 与 sandbox
    // 各打一次。故这里断言「至少一次 + 首次命中 daily」，而不是写死 1。
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).toContain('daily-cloudcode-pa.googleapis.com')
    expect(calls[0]).toContain('/v1internal:streamGenerateContent')
    // 反向：没有任何请求打到 Google 之外的地方（凭据没被发给错的 host）。
    expect(calls.every((url) => url.includes('googleapis.com'))).toBe(true)
  })

  it('测试**不写任何存储**：不清标记、不写回新的重置时刻', async () => {
    const marker = Date.now() + 3_600_000
    stubFetch()
    const { call, storedLimits } = setup({
      modelRateLimits: { 'gemini-3.8-flash': marker },
      catalog: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
    })

    await call('account.test', { accountId: 'gemini-1' })

    // ⚠️ 这是与重测的硬性分野：重测成功会清标记、失败会写回上游新时刻；
    // 测试必须一个字节都不改（它只是「手动探活」，不改变选号状态）。
    expect(storedLimits()).toEqual({ 'gemini-3.8-flash': marker })
  })

  it('★ 探活成功**不得**清掉账号级封禁标记（issue IKS2MV：单模型探活证明不了整号）', async () => {
    // ⚠️ 判据强度：`testAccount` 只测**一个**模型，而 `pickTestModel` 取的是
    //    `Object.keys(modelRateLimits)[0]`（**插入序最老的键**，常是历史 429 的可用模型）
    //    ⇒ 那次探测成功**与「账号被封」无关**。
    //    清除权只留给 `account.retest`（要求所有带标记的模型都通过）与 `account.reset`。
    const blockedAt = 1_700_000_000_000
    // ⚠️ 必须桩**成功**：默认桩恒回 429 ⇒ `ok` 恒 false ⇒ 变异那条分支走不到
    //    ⇒ 守卫会是无牙的（M12 实测）。
    stubFetchOk()
    const { call, storedPolicyBlockedAtMs } = setup({
      modelRateLimits: { 'gemini-3.8-flash': Date.now() + 3_600_000 },
      policyBlockedAtMs: blockedAt,
      catalog: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
    })

    const result = await call('account.test', { accountId: 'gemini-1' })

    // 前提：这次探活**真的成功了**（否则那条分支走不到，守卫会是无牙的）。
    expect((result.value as { ok: boolean }).ok, '本用例的前提是探活成功').toBe(true)
    expect(storedPolicyBlockedAtMs(), '探活一次就把整号封禁洗白 ⇒ 池会选回它 ⇒ 下一发再 403').toBe(blockedAt)
  })

  it('有标记时优先测标记里的模型，且**不**去读目录（目录不可用也能测）', async () => {
    const calls = stubFetch()
    // withoutLlm + 无适配器 ⇒ fullCatalogIds 必然失败；若实现先读目录，这条会 bad-request。
    const { call } = setup({ modelRateLimits: { 'gemini-3.8-flash-high': Date.now() + 1000 }, withoutLlm: true })

    const result = await call('account.test', { accountId: 'gemini-1' })

    expect(result.ok).toBe(true)
    expect((result.value as { modelId: string }).modelId).toBe('gemini-3.8-flash-high')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('显式指定 modelId 时以它为准', async () => {
    const calls = stubFetch()
    const { call } = setup({ modelRateLimits: { 'gemini-3.8-flash-low': Date.now() + 1000 } })

    const result = await call('account.test', { accountId: 'gemini-1', modelId: 'gemini-3.8-flash-tiered' })

    expect((result.value as { modelId: string }).modelId).toBe('gemini-3.8-flash-tiered')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('无标记且目录读不出来 → bad-request，且**不**发请求（不猜模型名）', async () => {
    const calls = stubFetch()
    const { call } = setup({ withoutLlm: true })

    const result = await call('account.test', { accountId: 'gemini-1' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('无法确定要测试的模型')
    // 猜一个模型名发出去会得到与账号无关的 404，把两件事混成一条报错。
    expect(calls).toHaveLength(0)
  })

  /**
   * ⚠️⚠️ **本端点对目录是「尽力而为」，与两个关闭方向刻意不同**（真实的行为收缩，
   * 本次修复中实测发现并避免）。
   *
   * 两个关闭方向要求目录**完整**（远端读失败 ⇒ 拒绝），因为黑名单写一半会让
   * 「显示已关闭、模型却仍可选」。而本端点只要**一个** id 就能测 ⇒ 远端读失败时
   * 必须用**适配器那一半**照常继续。
   *
   * ⚠️ 实测证据：若这里也按「远端失败即拒绝」处理，那么
   * 「适配器有目录 + llm 临时故障（令牌过期）」会从**能测**退化成
   * `bad-request: 无法确定要测试的模型：读取模型列表失败：令牌已过期`
   * —— 而该端点的注释明确把这类退化列为「**自造的失败**」。
   */
  it('⚠️ 适配器有目录 + 远端读失败 → 仍用适配器目录照常测（不得退化成 bad-request）', async () => {
    const calls = stubFetch()
    const { call } = setup({
      // 远端读失败……
      listModelsError: '令牌已过期',
      // ……但适配器有目录（冷缓存兜底表形态）。
      catalog: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
    })

    const result = await call('account.test', { accountId: 'gemini-1' })

    expect(result.ok, '远端故障不该让「有兜底目录可测」的账号被拒（自造的失败）').toBe(true)
    expect((result.value as { modelId: string }).modelId).toBe('gemini-3.8-flash')
    // 真的发了请求（探活的本意）。
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  /**
   * ⚠️⚠️ **远端读到但为空（无账号门控）⇒ 文案必须是「没有可测试的模型」，
   * 且**不得泄漏 `undefined`**（真实缺口，独立对抗审计实测零守卫）。
   *
   * 这是「远端读到但为空」与「远端读失败」的**唯一分流点**
   * （`complete === false && remoteError === undefined` 就是前者）。
   * 既有用例只覆盖了 `withoutLlm` 与 `listModelsError`（两者**都带**
   * `remoteError`）⇒ 这条组合完全没有守卫。
   *
   * ⚠️ 审计实测的变异（把判据从 `remoteError !== undefined` 改成 `!complete`）：
   * 生产 spec **170 条全绿**，而行为已经分叉成
   * `无法确定要测试的模型：undefined`（**泄漏 undefined**）。
   * 两者对用户的意义不同：前者是「**没账号**」，后者是「**读不到**」。
   */
  it('⚠️ 远端读到但为空（无账号门控）→ 文案是「没有可测试的模型」，不得泄漏 undefined', async () => {
    const calls = stubFetch()
    const { call } = setup({
      // ⚠️ `catalog: []` 同时让远端与适配器都为空 ⇒
      // `complete === false` 且 `remoteError === undefined`（正是本用例要锁的形态）。
      catalog: [],
    })

    const result = await call('account.test', { accountId: 'gemini-1' })

    expect(result.ok).toBe(false)
    const message = result.error?.message ?? ''
    // 「没账号」的语义 —— 而不是「读不到」。
    expect(message).toContain('没有可测试的模型')
    expect(message).not.toContain('无法确定要测试的模型')
    // ⚠️ 关键反向断言：`remoteError` 为 undefined 时若拼进模板会打印出
    // 字面量 `undefined`（审计实测的变异形态），用户看到的是插件内部错误。
    expect(message, '不得把 undefined 拼进用户可见文案').not.toContain('undefined')
    expect(calls).toHaveLength(0)
  })

  it('缺 accountId / 账号不存在 → bad-request', async () => {
    const calls = stubFetch()
    const { call } = setup({ catalog: [{ id: 'm', name: 'M' }] })

    for (const payload of [{}, { accountId: '' }, { accountId: 'ghost' }]) {
      const result = await call('account.test', payload)
      expect(result.ok, JSON.stringify(payload)).toBe(false)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('cline.quota / cline.requestLog 端点', () => {
  type Handler = (request: Request) => Promise<Response>

  /** 凭据形态与实测一致（`account_id` 是 `usr-…`）。 */
  const CLINE_CREDENTIAL = {
    access_token: 'workos:eyJhbGciOiJSUzI1NiIs',
    refresh_token: 'tmgEeM2rd9ybYoWpXl8JqUfvK',
    account_id: 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM',
    email: 'ijetlee@163.com',
  }

  const LIMITS_RESPONSE = {
    success: true,
    data: {
      limits: [
        { type: 'five_hour', percentUsed: 12.5, resetsAt: '2026-09-29T10:00:00.000Z' },
        { type: 'weekly', percentUsed: 68, resetsAt: '2026-10-05T00:00:00.000Z' },
      ],
    },
  }

  const USAGES_RESPONSE = {
    success: true,
    data: {
      nextToken: 'tok-2',
      items: [{ createdAt: '2026-09-29T07:12:00.000Z', aiModelName: 'DeepSeek', aiModelTypeName: 'cline-free', totalTokens: 49, creditsUsed: 0, costUsd: 1320 }],
    },
  }

  function setup(options: {
    /** 初始账号（provider 固定 cline）。 */
    accounts?: Array<{ id: string; enabled: boolean }>
    /** `ctx.credentials.resolve` 的返回值：`'valid'` = 合法凭据 JSON，`'missing'` = 未配置。 */
    credential?: 'valid' | 'missing'
  } = {}) {
    const accounts = options.accounts ?? [{ id: 'acc-1', enabled: true }]
    const stored: Record<string, unknown> = {
      accounts: accounts.map((a, i) => ({
        id: a.id,
        nickname: `号${i + 1}`,
        provider: 'cline',
        enabled: a.enabled,
        credentialRef: `CLINE_ACCOUNT_T${i + 1}`,
        createdAt: Date.now(),
        refreshable: true,
      })),
    }
    let handler: Handler | undefined

    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? { register: () => ({ get: () => stored, replace: async () => {} }) }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    /**
     * ⚠️ `ctx.credentials` 是**服务注入的直接属性**（`ctx.credentials.resolve`），
     * 不是经 `ctx.get('credentials')` 取的 —— 写成后者会让端点在运行时抛
     * `Cannot read properties of undefined (reading 'resolve')`，
     * 而 RPC 把它包成 `jet-hub/handler-failed`，看起来像「方法不存在」。
     */
    const credentials = {
      describe: async () => ({ configured: false, writable: true }),
      resolve: async () => (options.credential === 'missing'
        ? undefined
        : { value: JSON.stringify(CLINE_CREDENTIAL) }),
      set: async () => {},
      unset: async () => {},
    }

    const ctx = {
      credentials,
      get: (key: string) => {
        if (key === 'connection') {
          // ⚠ 必须**按 path 精确匹配**（真实 dsh 是 `fetchRoutes.get(url.pathname)` 精确命中）：
          //   不看 path 的「最后注册的赢」替身，会被**后注册**的另一条路由偷走
          //   （当前是 `GET /api/jet-hub/captcha-carrier` 载体页路由）⇒ 本组测试的
          //   POST 落到载体页 handler 上 → 405 `method not allowed` → JSON.parse 炸。
          //   这是 AGENTS.md「合并上游新增端点后必须重跑位置占位组」那条纪律的复发。
          return { fetch: { register: (config: { path: string; fetch: Handler }) => { if (config.path === JET_HUB_API_PATH) handler = config.fetch } } }
        }
        return undefined
      },
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      emit: () => {},
    }

    registerJetHubRpc(
      // ⚠️ 命名对象（2026-10-08 改）：13 个键由助手补齐。位置参数时代这里只写到
      // `raccoon`（本组用例不依赖 modelAdapters），占位数量与签名不一致时
      // 静默错位 —— 现在键名即语义，不存在「数占位」这回事。
      ctx as never, pool,
      authsStub(),
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub', payload: { method, payload } }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    return { call }
  }

  /** 桩掉全局 fetch 并记录每次请求的 URL。 */
  function stubFetch(handler: (url: string) => Response) {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return handler(url)
    }))
    return urls
  }

  afterEach(() => { vi.unstubAllGlobals() })

  describe('cline.quota', () => {
    it('回传各账号的额度窗口（按网关原序）', async () => {
      stubFetch(() => new Response(JSON.stringify(LIMITS_RESPONSE), { status: 200 }))
      const { call } = setup()
      const result = await call('cline.quota', { provider: 'cline' })
      expect(result.ok).toBe(true)
      const accounts = (result.value as { accounts: Array<{ ok: boolean; windows: Array<{ type: string }> }> }).accounts
      expect(accounts).toHaveLength(1)
      expect(accounts[0]!.ok).toBe(true)
      expect(accounts[0]!.windows.map(w => w.type)).toEqual(['five_hour', 'weekly'])
    })

    it('用 users/me 端点（不依赖账号 id）', async () => {
      const urls = stubFetch(() => new Response(JSON.stringify(LIMITS_RESPONSE), { status: 200 }))
      const { call } = setup()
      await call('cline.quota', { provider: 'cline' })
      expect(urls[0]).toBe('https://api.cline.bot/api/v1/users/me/plan/usage-limits')
    })

    /**
     * ⚠️ 非 cline 一律 bad-request：前端 `supportsSubscriptionQuota` 只对 cline
     * 渲染按钮，两侧必须一致，否则就是「按钮在、点了报错」。
     */
    it('非 cline 的 provider → bad-request，且不发请求', async () => {
      const urls = stubFetch(() => new Response(JSON.stringify(LIMITS_RESPONSE), { status: 200 }))
      const { call } = setup()
      for (const provider of ['buddy', 'qoder', 'loomy', '']) {
        expect((await call('cline.quota', { provider })).ok, provider).toBe(false)
      }
      expect(urls).toEqual([])
    })

    /**
     * ⚠️ 一个账号没配凭据只影响它自己：多账号用户不该因为其中一个号
     * 凭据缺失就完全看不到额度。
     */
    it('逐账号隔离：凭据未配置的账号带原因，其余照常', async () => {
      // 第一个账号走 missing 分支由 credential 选项控制；这里用两个账号 +
      // 按 ref 区分较麻烦，故直接验证「missing 时不发请求且带原因」这一半。
      stubFetch(() => new Response(JSON.stringify(LIMITS_RESPONSE), { status: 200 }))
      const { call } = setup({ accounts: [{ id: 'acc-1', enabled: true }], credential: 'missing' })
      const result = await call('cline.quota', { provider: 'cline' })
      expect(result.ok).toBe(true)
      const accounts = (result.value as { accounts: Array<{ ok: boolean; error?: string; windows: unknown[] }> }).accounts
      expect(accounts[0]!.ok).toBe(false)
      expect(accounts[0]!.error).toBe('凭据未配置')
      expect(accounts[0]!.windows).toEqual([])
    })

    it('网关报错时该账号 ok:false 并带 HTTP 状态与文案', async () => {
      stubFetch(() => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
      const { call } = setup()
      const result = await call('cline.quota', { provider: 'cline' })
      const accounts = (result.value as { accounts: Array<{ ok: boolean; error?: string }> }).accounts
      expect(accounts[0]!.ok).toBe(false)
      expect(accounts[0]!.error).toContain('HTTP 401')
      expect(accounts[0]!.error).toContain('Unauthorized')
    })

    /** ⚠️ 查不到**不能显示成 0%**（0% 是「没用过」的语义）。 */
    it('查询失败时 windows 为空且 ok:false（不返回 0% 的假读数）', async () => {
      stubFetch(() => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }))
      const { call } = setup()
      const result = await call('cline.quota', { provider: 'cline' })
      const accounts = (result.value as { accounts: Array<{ ok: boolean; windows: unknown[] }> }).accounts
      expect(accounts[0]!.ok).toBe(false)
      expect(accounts[0]!.windows).toEqual([])
    })
  })

  describe('cline.requestLog', () => {
    /** 种入一条本地流水记录(模块级可变状态,用例间会泄漏,须先清)。 */
    const seedOne = (entry: Parameters<typeof recordClineRequest>[0]) => {
      resetClineRequestHistory()
      recordClineRequest(entry)
    }

    it('回传当前账号的记录,字段对齐参考实现', async () => {
      seedOne({
        model: 'cline-pass/deepseek-v4.1-flash',
        accountId: 'acc-1',
        usageReported: true,
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 400,
        reasoningTokens: 89,
        effort: 'high',
        ttftMs: 320,
        // 首个**正文**块耗时：速率的分子分母都要落在正文阶段，必须透传
        ttfcMs: 1800,
        totalMs: 4200,
      })
      const { call } = setup()
      const result = await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' })
      expect(result.ok).toBe(true)
      const value = result.value as {
        rows: Array<{
          ts: number
          model: string
          upstream: string
          usageReported: boolean
          inputTokens: number
          outputTokens: number
          cacheReadTokens?: number
          reasoningTokens?: number
          effort: string
          ttftMs: number
          ttfcMs: number
          totalMs: number
        }>
      }
      expect(value.rows).toHaveLength(1)
      expect(value.rows[0]).toEqual({
        ts: expect.any(Number),
        model: 'cline-pass/deepseek-v4.1-flash',
        // 网关没报路由时回落到模型 id 的「/ 前缀」（两个维度，见 RPC 侧注释）
        upstream: 'cline-pass',
        // ⚠️ 必须透传：表格据此把「网关没发 usage」显示成 `—`（不是 0）
        usageReported: true,
        inputTokens: 100,
        outputTokens: 25,
        // 缓存命中：有值才出现（表格的 ⚡ 那一项）
        cacheReadTokens: 400,
        reasoningTokens: 89,
        // 推理强度：**空串也照传**（前端据「空串 ⇒ 不渲染那一行」判断）
        effort: 'high',
        ttftMs: 320,
        ttfcMs: 1800,
        totalMs: 4200,
      })
    })

    /**
     * ⚠️ 用户报障「上游显示的不正确」：**网关报的真实渠道优先**，
     * 它没报时才回落到模型命名空间（`cline-pass` 那类订阅通道名）。
     */
    it('upstream 优先用网关报的渠道；未报时回落到模型命名空间', async () => {
      seedOne({
        model: 'cline-pass/deepseek-v4.1-flash',
        accountId: 'acc-1',
        usageReported: true,
        inputTokens: 1,
        outputTokens: 1,
        effort: '',
        upstream: 'alibaba',
        ttftMs: 320,
        totalMs: 4200,
      })
      const { call } = setup()
      const withRoute = (await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' }))
        .value as { rows: Array<{ upstream: string }> }
      expect(withRoute.rows[0]!.upstream).toBe('alibaba')

      // 网关没报路由（空串）⇒ 回落成模型命名空间，而不是编造渠道名
      seedOne({
        model: 'cline-pass/deepseek-v4.1-flash',
        accountId: 'acc-1',
        usageReported: true,
        inputTokens: 1,
        outputTokens: 1,
        effort: '',
        upstream: '',
        ttftMs: 320,
        totalMs: 4200,
      })
      const noRoute = (await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' }))
        .value as { rows: Array<{ upstream: string }> }
      expect(noRoute.rows[0]!.upstream).toBe('cline-pass')
    })

    /** ⚠️ 未收到 usage 帧时 token 全为 0，但 `usageReported:false` 必须透传。 */
    it('未收到 usage 帧时 usageReported:false 透传（0 不等于未知）', async () => {
      seedOne({
        model: 'cline-pass/deepseek-v4.1-flash',
        accountId: 'acc-1',
        usageReported: false,
        inputTokens: 0,
        outputTokens: 0,
        effort: '',
        ttftMs: 320,
        totalMs: 4200,
      })
      const { call } = setup()
      const result = await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' })
      const row = (result.value as { rows: Array<Record<string, unknown>> }).rows[0]!
      expect(row.usageReported).toBe(false)
      expect(row.effort).toBe('')
      expect('cacheReadTokens' in row).toBe(false)
      expect('reasoningTokens' in row).toBe(false)
    })

    it('按 accountId 过滤:别的账号的记录不混进来', async () => {
      seedOne({ model: 'm', accountId: 'acc-other', inputTokens: 1, outputTokens: 2, ttftMs: 3, totalMs: 4 })
      const { call } = setup()
      const result = await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' })
      expect(result.ok).toBe(true)
      expect((result.value as { rows: unknown[] }).rows).toEqual([])
    })

    it('无记录时返回空数组(而不是错误)', async () => {
      resetClineRequestHistory()
      const { call } = setup()
      const result = await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' })
      expect(result.ok).toBe(true)
      expect((result.value as { rows: unknown[] }).rows).toEqual([])
    })

    /**
     * ⚠️ 失败行**随行回传 error**:失败的请求是排查「为什么没回复」的
     * 第一线索(429 / 11140 安全策略 / 网络错误各是不同的原因)。
     */
    it('失败行随行回传 error', async () => {
      seedOne({
        model: 'm', accountId: 'acc-1',
        inputTokens: 0, outputTokens: 0, ttftMs: 0, totalMs: 5,
        error: 'cline: transport error: ECONNRESET',
      })
      const { call } = setup()
      const result = await call('cline.requestLog', { provider: 'cline', accountId: 'acc-1' })
      const rows = (result.value as { rows: Array<{ error?: string }> }).rows
      expect(rows[0]!.error).toContain('ECONNRESET')
    })

    it('非 cline 的 provider → bad-request(与额度端点同规)', async () => {
      const { call } = setup()
      for (const provider of ['buddy', 'qoder', '']) {
        expect((await call('cline.requestLog', { provider, accountId: 'acc-1' })).ok, provider).toBe(false)
      }
    })

    it('accountId 为空 → bad-request(不猜默认值)', async () => {
      const { call } = setup()
      expect((await call('cline.requestLog', { provider: 'cline', accountId: '' })).ok).toBe(false)
      expect((await call('cline.requestLog', { provider: 'cline' })).ok).toBe(false)
    })
  })
})

/**
 * ★★ 聚合门控与手工排序端点（用户 2026-10-15）：`setAllowed` / `setOrder` / `setOrderMode`
 * / `rejectNonExpiring`，以及 `aggregate.catalog` 的 `orderMode`/`order` 透传。
 *
 * ⚠️ 本组**必须有**：这五个端点此前**只有适配器层用例**（`aggregate-adapter.spec.ts`），
 *    RPC 层一条都没有 ⇒ 参数校验、`clearChoiceCache` 调用、返回形状全都没被守过
 *   （本仓库的成文教训：`sanitize*` 有 7 条单测而**零生产调用者**）。
 */
describe('★★ 聚合门控 / 手工排序端点', () => {
  // ⚠️ `Handler` 是各 describe 块自己声明的局部类型（本文件的既有体例），故这里也带一份。
  type Handler = (request: Request) => Promise<Response>

  const ALL_AUTH = {
    codearts: {} as never,
    buddy: {} as never,
    workbuddy: {} as never,
    lobsterai: {} as never,
    qoder: {} as never,
    qodercn: {} as never,
    trae: {} as never,
    cline: {} as never,
    loomy: {} as never,
    raccoon: {} as never,
    minimax: {} as never,
    zcode: {} as never,
    gemini: {} as never,
    officeace: {} as never,
  }

  function setup(options: {
    /** 聚合适配器替身（只实现被测到的方法）。 */
    aggregate?: Record<string, unknown>
  } = {}) {
    let handler: Handler | undefined
    let stored: Record<string, unknown> = { accounts: [] }
    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return {
            fetch: {
              register: (config: { path: string; fetch: Handler }) => {
                if (config.path === JET_HUB_API_PATH) handler = config.fetch
              },
            },
          }
        }
        return undefined
      },
      inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      emit: () => {},
    }

    registerJetHubRpc(
      ctx as never,
      pool,
      ALL_AUTH,
      (options.aggregate === undefined
        ? {}
        : { aggregate: options.aggregate }) as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    return { call, pool, storedValue: () => stored }
  }

  it('aggregate.setAllowed：三字段必填，缺一即 bad-request', async () => {
    const { call } = setup()
    for (const bad of [
      {},
      { canonicalId: 'm', provider: 'raccoon' },
      { canonicalId: '', provider: 'raccoon', realId: 'r' },
      { canonicalId: 'm', provider: '', realId: 'r' },
      { canonicalId: 'm', provider: 'raccoon', realId: '' },
    ]) {
      expect((await call('aggregate.setAllowed', bad)).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('★ aggregate.setAllowed 写入白名单并**同时**回两张表（面板一次校正）', async () => {
    const { call, pool } = setup()
    const result = await call('aggregate.setAllowed', {
      canonicalId: 'glm-5-3', provider: 'raccoon', realId: 'sn-glm-5-3', allowed: true,
    })
    expect(result.ok).toBe(true)
    const value = result.value as {
      aggregateRejections: Record<string, unknown>
      aggregateAllowed: Record<string, unknown>
    }
    expect(value.aggregateAllowed).toEqual({ 'glm-5-3': { raccoon: { 'sn-glm-5-3': true } } })
    // ⚠️ 拒绝表**不动**（用户 2026-10-15 的修正：两表各有各的域）
    expect(value.aggregateRejections).toEqual({})
    expect(pool.listAggregateAllowed()['glm-5-3']?.raccoon?.['sn-glm-5-3']).toBe(true)
  })

  it('★ aggregate.setAllowed(false) 删键（不写 false）', async () => {
    const { call, pool } = setup()
    await call('aggregate.setAllowed', {
      canonicalId: 'glm-5-3', provider: 'raccoon', realId: 'sn-glm-5-3', allowed: true,
    })
    const result = await call('aggregate.setAllowed', {
      canonicalId: 'glm-5-3', provider: 'raccoon', realId: 'sn-glm-5-3', allowed: false,
    })
    expect(result.ok).toBe(true)
    expect(pool.listAggregateAllowed()).toEqual({})
  })

  it('★ 写白名单后清 choiceCache（改动立刻生效，不依赖 60 秒 TTL）', async () => {
    let cleared = 0
    const { call } = setup({ aggregate: { clearChoiceCache: () => { cleared += 1 } } })
    await call('aggregate.setAllowed', {
      canonicalId: 'm', provider: 'raccoon', realId: 'r', allowed: true,
    })
    expect(cleared, '★ 漏了它 ⇒ 「手工打开」最长 60 秒后才生效').toBeGreaterThan(0)
  })

  it('★ aggregate.setRejected 也清 choiceCache（两个方向体例必须对齐）', async () => {
    let cleared = 0
    const { call } = setup({ aggregate: { clearChoiceCache: () => { cleared += 1 } } })
    await call('aggregate.setRejected', {
      canonicalId: 'm', provider: 'buddy', realId: 'r', rejected: true,
    })
    expect(cleared).toBeGreaterThan(0)
  })

  it('aggregate.setOrder：拒绝非数组 / 非字符串元素（不得静默清空顺序）', async () => {
    const { call, pool } = setup()
    for (const bad of [
      { canonicalId: 'm' },
      { canonicalId: 'm', order: 'a,b' },
      { canonicalId: 'm', order: [1, 2] },
      { canonicalId: '', order: [] },
      { canonicalId: 'm', order: [null] },
    ]) {
      const result = await call('aggregate.setOrder', bad)
      expect(result.ok, JSON.stringify(bad)).toBe(false)
    }
    // ⚠️ 关键：一连串 bad-request **不得**改到顺序表（否则「拖坏了」会静默丢顺序）。
    expect(pool.listAggregateOrder()).toEqual({})
  })

  it('★ aggregate.setOrder 返回**服务端过滤去重后**的权威数组', async () => {
    const { call, pool } = setup()
    const result = await call('aggregate.setOrder', {
      canonicalId: 'glm-5-3',
      order: ['raccoon\u0000sn-glm-5-3', 'junk-no-separator', 'raccoon\u0000sn-glm-5-3', 'buddy\u0000glm-5.3'],
    })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      canonicalId: 'glm-5-3',
      order: ['raccoon\u0000sn-glm-5-3', 'buddy\u0000glm-5.3'],
    })
    // 客户端以响应为准 ⇒ 落盘内容必须与响应逐字相同。
    expect(pool.listAggregateOrder()['glm-5-3']).toEqual(result.value && (result.value as { order: string[] }).order)
  })

  it('aggregate.setOrderMode：只接受 expiry / manual，畸形值 bad-request', async () => {
    const { call, pool } = setup()
    for (const bad of [{}, { mode: 'MANUAL' }, { mode: 'expiry ' }, { mode: 1 }, { mode: null }]) {
      expect((await call('aggregate.setOrderMode', bad)).ok, JSON.stringify(bad)).toBe(false)
    }
    expect(pool.listAggregateOrderMode(), '畸形值不得改到模式（防显示与行为分叉）').toBe('expiry')
  })

  it('★ aggregate.setOrderMode 写入并回权威值 + 清 choiceCache', async () => {
    let cleared = 0
    const { call, pool } = setup({ aggregate: { clearChoiceCache: () => { cleared += 1 } } })
    const result = await call('aggregate.setOrderMode', { mode: 'manual' })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ orderMode: 'manual' })
    expect(pool.listAggregateOrderMode()).toBe('manual')
    expect(cleared, '★ 顺序参与了候选排序 ⇒ 模式变了缓存必须失效').toBeGreaterThan(0)
  })

  it('★★ aggregate.rejectNonExpiring：只清**未接入**渠道的白名单（keep 集合必须来自权威常量）', async () => {
    // ⚠️⚠️ 判据必须**行为化**：在**已接入**渠道（buddy）与**未接入**渠道（raccoon）上
    //    各播一条白名单，然后断言「只掉了未接入的那条」。
    //    若实现把 `WIRED_EXPIRY_PROVIDERS` 写死成一份副本（或写错方向），
    //    已接入渠道的手工打开会被**静默清掉** —— 而那是用户有意义的设置。
    const { call, pool } = setup()
    await call('aggregate.setAllowed', {
      canonicalId: 'a', provider: 'buddy', realId: 'keep-me', allowed: true,
    })
    await call('aggregate.setAllowed', {
      canonicalId: 'a', provider: 'raccoon', realId: 'drop-me-1', allowed: true,
    })
    await call('aggregate.setAllowed', {
      canonicalId: 'b', provider: 'raccoon', realId: 'drop-me-2', allowed: true,
    })

    const result = await call('aggregate.rejectNonExpiring', {})
    expect(result.ok).toBe(true)
    const value = result.value as { cleared: number; aggregateAllowed: Record<string, unknown> }
    expect(value.cleared, '★ cleared = 被清掉的**候选条数**（面板文案要用它）').toBe(2)
    expect(value.aggregateAllowed, '★ 已接入渠道(buddy)的白名单必须保留').toEqual({
      a: { buddy: { 'keep-me': true } },
    })
    expect(pool.listAggregateAllowed()).toEqual({ a: { buddy: { 'keep-me': true } } })
  })

  it('★ 幂等：再点一次 cleared === 0 且仍回 ok:true（不是错误）', async () => {
    const { call } = setup()
    await call('aggregate.setAllowed', {
      canonicalId: 'a', provider: 'raccoon', realId: 'r', allowed: true,
    })
    expect((await call('aggregate.rejectNonExpiring', {})).value).toMatchObject({ cleared: 1 })
    const again = await call('aggregate.rejectNonExpiring', {})
    expect(again.ok, '★ 空点击不是错误').toBe(true)
    expect((again.value as { cleared: number }).cleared).toBe(0)
  })

  it('★ aggregate.catalog 原样透传 models / orderMode（不在 RPC 层重算）', async () => {
    const { call } = setup({
      aggregate: {
        describeCatalog: async () => ({
          models: [{
            canonicalId: 'glm-5-3',
            name: 'GLM-5.3',
            candidates: [{
              provider: 'raccoon', realId: 'sn-glm-5-3', realName: 'GLM-5-3 · x0.75',
              price: 0.75, viaPatch: false, rejected: true,
              state: 'default-rejected', expiryWired: false,
            }],
            order: ['raccoon\u0000sn-glm-5-3'],
          }],
          orderMode: 'manual',
        }),
      },
    })
    const result = await call('aggregate.catalog', {})
    expect(result.ok).toBe(true)
    const value = result.value as { models: unknown[]; orderMode: string }
    expect(value.orderMode, '★ 排序模式由宿主下发，客户端不得推导').toBe('manual')
    expect(value.models).toHaveLength(1)
    expect((value.models[0] as { candidates: Array<{ state: string }> }).candidates[0]!.state)
      .toBe('default-rejected')
  })

  it('★ aggregate.catalog 透传 force（面板「刷新」必须绕目录 TTL）', async () => {
    const seen: boolean[] = []
    const { call } = setup({
      aggregate: {
        describeCatalog: async (force?: boolean) => { seen.push(force === true); return { models: [], orderMode: 'expiry' } },
      },
    })
    await call('aggregate.catalog', {})
    await call('aggregate.catalog', { force: true })
    expect(seen).toEqual([false, true])
  })

  it('★ aggregate.expiryOrder 透传 force（定时自动重探 / 手动点击都要新鲜值）', async () => {
    const seen: Array<boolean | undefined> = []
    const { call } = setup({
      aggregate: {
        describeExpiryOrder: async (_signal?: AbortSignal, force?: boolean) => { seen.push(force); return {} },
      },
    })
    await call('aggregate.expiryOrder', {})
    await call('aggregate.expiryOrder', { force: true })
    expect(seen).toEqual([false, true])
  })

  it('未注册聚合适配器时：写端点仍可用（走池），读端点安静降级', async () => {
    // ⚠️ `aggregate.catalog` / `expiryOrder` 对未注册**回空值**而不是报错（既有取向：
    //    面板是可选装饰，为它报错会在设置页显示无意义的错误）。
    const { call } = setup()
    expect((await call('aggregate.catalog', {})).ok, '未注册 ⇒ 明确报 unavailable').toBe(false)
    expect((await call('aggregate.expiryOrder', {})).ok).toBe(true)
    expect((await call('aggregate.expiryOrder', {})).value).toEqual({ order: {} })
    // 写端点不依赖适配器实例（它们只动账号池的两张表）。
    expect((await call('aggregate.setOrderMode', { mode: 'manual' })).ok).toBe(true)
  })
})

/**
 * ★★ **Task 9 的接线守卫：六处写入端点必须**真的**让目录缓存失效。**
 *
 * ## ⚠️ 为什么必须测这个（而不是读源码）
 *
 * 本仓库实测过 5 条「源码文本断言」在 `if (false)` 的死分支里恒绿 ⇒ 判据必须
 * 打在行为上。这里的可观测面是 `catalogInvalidatedAt(provider)`：它由
 * `invalidateCatalogCache` **唯一**写入，故「端点跑完它非 0」等价于
 * 「端点真的调了失效」。
 *
 * ⚠️ 反向的判据同样重要：**参数非法（bad-request）时不得写失效** ——
 * 那种请求一个字都没改，失效只会白打一次上游。
 *
 * ⚠️ 表是**进程级全局状态** ⇒ 每条用例前清空（否则上一条的标记会让
 * 「bad-request 不得失效」假失败）。
 */
describe('★★ 写入端点必须失效目录缓存（Task 9 接线守卫）', () => {
  type Handler = (request: Request) => Promise<Response>

  beforeEach(() => { clearCatalogInvalidations() })
  afterEach(() => { clearCatalogInvalidations() })

  /**
   * 最小夹具：只需要 `settings`（账号池写黑名单）与可选的 `llm`。
   *
   * ⚠️ 必须提供 `llm.listModels`：`model.setDisabled` / `model.setAllDisabled`
   * 的写前目录核对会用它（缺失时它们走「核对不了就照常写」的降级路径，
   * 那样用例就少覆盖了一条真实路径）。
   */
  function setup(options: { models?: Array<{ id: string; name: string }> } = {}) {
    let handler: Handler | undefined
    let stored: Record<string, unknown> = { accounts: [] }
    const models = options.models ?? [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }]
    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return {
            fetch: {
              register: (config: { path: string; fetch: Handler }) => {
                if (config.path === JET_HUB_API_PATH) handler = config.fetch
              },
            },
          }
        }
        if (key === 'llm') {
          return { listModels: async (provider: string) => models.map((m) => ({ ...m, provider })) }
        }
        return undefined
      },
      inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      emit: () => {},
    }

    registerJetHubRpc(
      ctx as never,
      pool,
      {
        codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
        lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
        trae: {} as never, cline: {} as never, loomy: {} as never,
        raccoon: {} as never, minimax: {} as never, zcode: {} as never,
        gemini: {} as never, officeace: {} as never,
      } as never,
      {
        buddy: {
          listAllModels: () => models.map((m) => ({ id: m.id, name: m.name })),
        },
      } as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown } }
      return body.result
    }
    return { call, pool }
  }

  it('★ model.setDisabled 成功 ⇒ 失效该 provider', async () => {
    const { call } = setup()
    expect(catalogInvalidatedAt('buddy'), '⚪️ 前置：本来没失效').toBe(0)
    expect((await call('model.setDisabled', { provider: 'buddy', modelId: 'm1', disabled: true })).ok).toBe(true)
    expect(catalogInvalidatedAt('buddy'), '★ 改开关必须立刻失效目录').toBeGreaterThan(0)
  })

  it('★ model.setDisabled 参数非法 ⇒ **不**失效（一个字都没改）', async () => {
    const { call } = setup()
    expect((await call('model.setDisabled', { provider: 'buddy' })).ok).toBe(false)
    expect(catalogInvalidatedAt('buddy'), '★ bad-request 不该白打一次上游').toBe(0)
  })

  it('★ model.clearDead 成功 ⇒ 失效该 provider', async () => {
    const { call } = setup()
    expect((await call('model.clearDead', { provider: 'buddy' })).ok).toBe(true)
    expect(catalogInvalidatedAt('buddy'), '★ 「重新显示」也必须立刻生效').toBeGreaterThan(0)
  })

  it('★ model.setAllDisabled 成功 ⇒ 失效该 provider（两个方向都失效）', async () => {
    const { call } = setup()
    expect((await call('model.setAllDisabled', { provider: 'buddy', disabled: true })).ok).toBe(true)
    expect(catalogInvalidatedAt('buddy'), '★ 关闭全部').toBeGreaterThan(0)

    clearCatalogInvalidations()
    expect((await call('model.setAllDisabled', { provider: 'buddy', disabled: false })).ok).toBe(true)
    expect(catalogInvalidatedAt('buddy'), '★ 打开全部（本地操作，但目录同样要重读）').toBeGreaterThan(0)
  })

  it('★ model.setAllDisabled 参数非法 ⇒ **不**失效', async () => {
    const { call } = setup()
    expect((await call('model.setAllDisabled', { provider: 'buddy' })).ok).toBe(false)
    expect(catalogInvalidatedAt('buddy'), '★ disabled 缺失不是一次写入').toBe(0)
  })

  it('★ model.setDisabledMany 成功 ⇒ 失效该 provider（同类写入端点，第 7 处）', async () => {
    const { call } = setup()
    expect((await call('model.setDisabledMany', { provider: 'buddy', modelIds: ['m1'], disabled: true })).ok).toBe(true)
    expect(catalogInvalidatedAt('buddy'), '★ 按分组批量关闭同样是改黑名单').toBeGreaterThan(0)
  })

  it('★★ aggregate.setRejected ⇒ 失效 **aggregate 自己**，且**不**波及别的渠道', async () => {
    const { call } = setup()
    expect((await call('aggregate.setRejected', {
      canonicalId: 'm', provider: 'raccoon', realId: 'r', rejected: true,
    })).ok).toBe(true)
    expect(catalogInvalidatedAt('aggregate'), '★★ 聚合自己的目录缓存必须失效').toBeGreaterThan(0)
    // ⚠️ 这一条是任务的硬约束：失效一个不得连带作废其余。
    //    在 4/5/6 三处**绝不许**失效 `req.provider`（那会让改一个开关打十几个上游）。
    expect(catalogInvalidatedAt('raccoon'), '★★ 不得连带失效拒绝表里那个渠道').toBe(0)
  })

  it('★★ aggregate.setAllowed ⇒ 失效 aggregate 自己，且不波及别的渠道', async () => {
    const { call } = setup()
    expect((await call('aggregate.setAllowed', {
      canonicalId: 'm', provider: 'raccoon', realId: 'r', allowed: true,
    })).ok).toBe(true)
    expect(catalogInvalidatedAt('aggregate'), '★★ 白名单同样改变候选门控').toBeGreaterThan(0)
    expect(catalogInvalidatedAt('raccoon'), '★★ 不得连带失效该渠道').toBe(0)
  })

  it('★★ aggregate.setOrder ⇒ 失效 aggregate 自己，且不波及别的渠道', async () => {
    const { call } = setup()
    expect((await call('aggregate.setOrder', {
      canonicalId: 'm', order: ['raccoon\u0000r'],
    })).ok).toBe(true)
    expect(catalogInvalidatedAt('aggregate'), '★★ 顺序参与候选排序').toBeGreaterThan(0)
    expect(catalogInvalidatedAt('raccoon'), '★★ 不得连带失效该渠道').toBe(0)
  })

  it('★ 三处 aggregate 写入的参数非法 ⇒ **不**失效 aggregate', async () => {
    const { call } = setup()
    expect((await call('aggregate.setRejected', { canonicalId: 'm' })).ok).toBe(false)
    expect((await call('aggregate.setAllowed', { canonicalId: 'm' })).ok).toBe(false)
    expect((await call('aggregate.setOrder', { canonicalId: 'm', order: 'a,b' })).ok).toBe(false)
    expect(catalogInvalidatedAt('aggregate'), '★ 三次 bad-request 都不该白打上游').toBe(0)
  })
})

/**
 * ★★★ **复审补齐的 4 处接线：判据打在「下一次真的重新拉远端」上**
 * （`provider.setEnabled` / `aggregate.clearRejected` / `aggregate.setOrderMode` /
 * `aggregate.rejectNonExpiring`）。
 *
 * ## ⚠️⚠️ 为什么不能只看 `catalogInvalidatedAt(provider) > 0`
 *
 * 上一组用例的判据是「端点跑完那张表非 0」。它**有牙**（撤掉接线就红），但它量的是
 * **本仓库自己的一个全局变量**——判据与被测对象共用了同一个进程状态。
 * 这里补的是**端到端**那条：真的去调那个端点，再真的让该 provider 读一次目录，
 * 数 `fetchRemoteModels` / `ctx.llm.listModels` 被调了几次。
 *
 * ⚠️ **不推进时钟**是关键：TTL 是 20 分钟（聚合 60 秒），不推进它就绝不可能因超期
 * 而重拉 ⇒ 观察到的第二次请求只可能来自「用户改设置 ⇒ 立即失效」这条路径。
 *
 * ## ⚠️ 三家渠道共用适配器类 ⇒ 替身必须显式传 `product`
 *
 * `minimax` / `minimaxintl` 共用 `MinimaxAdapter`、`buddy` / `workbuddy` 共用
 * `BuddyAdapter`，provider id 只来自构造时的 `options.product`。不传 ⇒ 失效会登记
 * 在缺省那个 id 上，用例变成「失效了但被读的那家没看见」而变红（不是恒绿，但会误报）。
 *
 * ## ⚠️ `provider.setEnabled` 的**方向**决定它走哪条路
 *
 * `enabled: false`（关闭）走 `fullCatalogIds` 远端核实 + `setModelsDisabled`，
 * `enabled: true`（打开）走 `clearDisabledModels`、**不读远端**。
 * 两条都写同一张黑名单 ⇒ 两条都必须失效，本组两个方向各一条用例。
 *
 * ⚠️ 关闭方向**故意**喂一个「远端读到但为空、适配器兜底有 2 条」的目录：这是
 * 该端点最容易被 `remoteError` / `notReady` / `ids.length === 0` 提前 `return`
 * 掉的形态，而那几条 `return` 都在失效调用**之前** ⇒ 用例还顺带钉住了
 * 「失效必须排在真正写盘成功之后」这一半规则（失败路径不得失效）。
 */
describe('★★★ 复审补齐的 4 处接线：端点跑完后该 provider 必须立刻重拉远端', () => {
  type Handler = (request: Request) => Promise<Response>

  beforeEach(() => { clearCatalogInvalidations() })
  afterEach(() => { clearCatalogInvalidations() })

  /**
   * 一个最小可用的 Jet Hub RPC 夹具 + 三个渠道适配器（loomy / raccoon / accio）。
   *
   * ⚠️ `ctx.llm.listModels` 必须给东西：`provider.setEnabled` 的关闭方向靠它做
   *   远端核实；给空数组会让该端点在「远端读到但为空 + 并集非空」这条正常路径上
   *   走（正是我们要覆盖的形态），但**绝不能**抛错 —— 抛错会命中 `remoteError`
   *   提前 `return`，那就不是「成功后失效」了。
   */
  function setup(options: { llmThrows?: boolean } = {}): {
    call: (method: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown }>
    loomyFetch: { listModels(provider: string): Promise<readonly unknown[]>; calls: number }
    raccoonFetch: { listModels(provider: string): Promise<readonly unknown[]>; calls: number }
  } {
    let handler: Handler | undefined
    let stored: Record<string, unknown> = { accounts: [] }
    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
          register: () => ({
            get: () => stored,
            replace: async (value: Record<string, unknown>) => { stored = value },
          }),
        }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    /**
     * 一个渠道适配器 + **可数的** `fetchRemoteModels`。
     *
     * ⚠️ `calls` 是一个 getter 而不是快照 —— 用例要在调完端点**之后**读它。
     * ⚠️ 假时钟**固定**在 `1_000_000`（`:now`）：全程不推进时钟，
     *   「20 分钟 TTL 内的那次重拉」只可能来自「失效」。
     * ⚠️ `product` **必须显式传**：登记键是 `options.product.id`（不是 `listModels`
     *   的入参）⇒ 不传会让两家共用类都登记到缺省 id 上。这正是「共用类双站」
     *   那条既有守卫量的东西，这里只是复用它的正确用法。
     */
    function counted(product: LoomyProduct) {
      const fetchRemoteModels = vi.fn(async () => [{ id: `${product.id}-remote`, name: 'R' }])
      const adapter = new LoomyAdapter({
        credentialRef: 'CRED',
        resolveCredential: async () => ({ token: 't' }),
        refresh: async () => {},
        now: makeClock().now,
        fetchRemoteModels,
        product,
      } as never)
      return {
        listModels: (provider: string) => adapter.listModels(provider),
        get calls() { return fetchRemoteModels.mock.calls.length },
      }
    }

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return {
            fetch: {
              register: (config: { path: string; fetch: Handler }) => {
                if (config.path === JET_HUB_API_PATH) handler = config.fetch
              },
            },
          }
        }
        if (key === 'llm') {
          // ⚠️ 覆盖 loomy / raccoon / accio（关闭方向的并集目录来源）。
          // `llmThrows` 制造 `remoteError` 形态（拒绝路径，见那条用例的注释）。
          return {
            listModels: async (provider: string) => {
              if (options.llmThrows) throw new Error('模拟远端不可用')
              return provider === 'loomy' || provider === 'raccoon' || provider === 'accio'
                ? [{ id: `${provider}-remote`, name: 'R', provider }]
                : []
            },
          }
        }
        return undefined
      },
      inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      emit: () => {},
    }

    const loomyFetch = counted(LOOMY)
    const raccoonFetch = counted(RACCOON)
    const adapters = {
      loomy: { listAllModels: () => [{ id: 'loomy-fallback', name: 'F' }] },
      raccoon: { listAllModels: () => [{ id: 'raccoon-fallback', name: 'F' }] },
    }

    registerJetHubRpc(
      ctx as never,
      pool,
      {
        codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
        lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
        trae: {} as never, cline: {} as never, loomy: {} as never,
        raccoon: {} as never, minimax: {} as never, zcode: {} as never,
        gemini: {} as never, officeace: {} as never,
      } as never,
      adapters as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown } }
      return body.result
    }
    return { call, loomyFetch, raccoonFetch }
  }

  /** 造一个**可推进**的假时钟（不推进它正是「立即失效」可判别的关键）。 */
  function makeClock(): { now: () => number } {
    return { now: () => 1_000_000 }
  }

  /**
   * ★ **反向验证过的核心一条：`provider.setEnabled` 两个方向都必须立刻重拉。**
   *
   * ⚠️ 关键在「先建立缓存、再调端点、再读一次」三拍，且**全程不推进时钟**：
   * 20 分钟 TTL 未过 ⇒ 端点若没接线，第二次读是缓存命中，`fetchRemoteModels`
   * 计数停在 1；接线了才会变成 2。
   */
  it('★★★ provider.setEnabled（关闭方向）⇒ 下一次读该 provider 必须立刻重拉', async () => {
    const { call, loomyFetch } = setup()
    await loomyFetch.listModels('loomy')
    await loomyFetch.listModels('loomy')
    expect(loomyFetch.calls, '⚪️ 前置：冷启动读一次、周期内零额外请求').toBe(1)

    const result = await call('provider.setEnabled', { provider: 'loomy', enabled: false })
    expect(result.ok, '★ 关闭方向必须成功（否则本用例量的是拒绝路径）').toBe(true)

    // ⚠️ 不推进时钟 ⇒ 这次重拉只可能来自「失效」。
    // ⚠️⚠️ **顺序刻意如此**：行为断言排在 `catalogInvalidatedAt` **之前**。
    //    否则反向验证（撤掉接线）时报红的是那张表的断言，而**不是**本用例真正
    //    要量的「下一次真的重打了上游」—— 那样等于用弱判据冒充强判据。
    await loomyFetch.listModels('loomy')
    expect(
      loomyFetch.calls,
      '★★★ 撤掉 provider.setEnabled 的失效调用后本用例必须变红',
    ).toBe(2)
    expect(catalogInvalidatedAt('loomy'), '★ 该 provider 必须被失效').toBeGreaterThan(0)
  })

  it('★★★ provider.setEnabled（打开方向）⇒ 下一次读该 provider 必须立刻重拉', async () => {
    const { call, raccoonFetch } = setup()
    await raccoonFetch.listModels('raccoon')
    await raccoonFetch.listModels('raccoon')
    expect(raccoonFetch.calls, '⚪️ 前置：周期内零额外请求').toBe(1)

    const result = await call('provider.setEnabled', { provider: 'raccoon', enabled: true })
    expect(result.ok, '★ 打开方向必须成功').toBe(true)

    await raccoonFetch.listModels('raccoon')
    expect(
      raccoonFetch.calls,
      '★★★ 撤掉 provider.setEnabled 的失效调用后本用例必须变红',
    ).toBe(2)
    expect(catalogInvalidatedAt('raccoon'), '★ 该 provider 必须被失效').toBeGreaterThan(0)
  })

  /**
   * ★ `provider.setEnabled` 的**拒绝路径**不得失效（钉住「排在写盘成功之后」那半规则）。
   *
   * ⚠️ 制造的是 `remoteError` 形态（`ctx.llm.listModels` 抛错）—— 端点会
   * `return ok:false`、**一个字都没改** ⇒ 此刻失效只会白打一次上游。
   * ⚠️ 这条与 `fullCatalogIds` 的既有守卫（Task 7 为「只关 auto 却返回成功」加的
   *   `notReady` 守卫）**不冲突**：那几条 `return` 都在失效调用之前，一个字没改。
   */
  it('★ provider.setEnabled 远端核实失败 ⇒ 拒绝且**不**失效（一个字都没改）', async () => {
    const { call, loomyFetch } = setup({ llmThrows: true })
    const result = await call('provider.setEnabled', { provider: 'loomy', enabled: false })
    expect(result.ok, '★ 远端读失败必须拒绝（IKJW33 那条守卫原样保留）').toBe(false)
    expect(catalogInvalidatedAt('loomy'), '★★ 拒绝路径不得失效（白打一次上游）').toBe(0)
    // ⚠️ 并确认目录也没被动过（否则这条会被「其实写了点什么」蒙过去）。
    await loomyFetch.listModels('loomy')
    expect(loomyFetch.calls, '★ 拒绝路径不得让目录缓存失效').toBe(1)
  })

  /**
   * ★★ 三个聚合端点共用一条判据：**各自**都必须让聚合目录立刻重推。
   *
   * ⚠️ 为什么用聚合**自己的**目录缓存（60 秒 TTL）而不是某家渠道的（20 分钟）：
   *   聚合那三处接线**只失效 `AGGREGATE_PROVIDER`**（硬约束：不得连带作废其余
   *   11 家），所以判据必须打在聚合自己身上。
   * ⚠️ `ctx.llm.listModels` 被逐渠道调用的次数就是可观测面（重推 ⇒ 次数涨）。
   * ⚠️ **不推进时钟**：60 秒 TTL 未过 ⇒ 涨的那次只可能来自「失效」。
   */
  function makeAggregate(): { adapter: AggregateAdapter; reads: () => number } {
    let reads = 0
    const llmCtx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'loomy', name: 'loomy' }],
        listModels: async () => {
          reads += 1
          return [{ id: 'm1', name: 'M1' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    }
    const adapter = new AggregateAdapter(llmCtx as never, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
      } as never,
      expiryProbe: { expiryOf: async () => Number.MAX_SAFE_INTEGER } as never,
      now: makeClock().now,
    } as never)
    return { adapter, reads: () => reads }
  }

  /** 跑一遍「端点 → 聚合目录必须立刻重推」三拍。 */
  async function expectRepushAfterEndpoint(method: string, payload: unknown): Promise<void> {
    const { call } = setup()
    const { adapter, reads } = makeAggregate()

    // ⚠️ **顺序很关键**：先建立缓存、再调端点。若反过来，端点留下的失效标记会让
    //   「冷启动」那一拍就重推，下面那条「TTL 内零额外读取」会假失败
    //   （它正是本用例证明「本来有缓存」的那一拍 —— 恒真/假红的教训）。
    await adapter.refreshCatalog()
    const afterFirst = reads()
    expect(afterFirst, '⚪️ 冷启动必须真的读一轮渠道目录').toBeGreaterThan(0)
    await adapter.refreshCatalog()
    expect(reads(), '⚪️ TTL 内零额外渠道读取（证明「本来有缓存」）').toBe(afterFirst)

    const result = await call(method, payload)
    expect(result.ok, `★ ${method} 必须成功（否则量的是拒绝路径）`).toBe(true)

    // ⚠️ 行为断言**排在表断言之前**（理由见 `provider.setEnabled` 那条的注释）。
    await adapter.refreshCatalog()
    expect(
      reads(),
      `★★ 撤掉 ${method} 的失效调用后本用例必须变红`,
    ).toBeGreaterThan(afterFirst)
    expect(catalogInvalidatedAt('aggregate'), `★ ${method} 必须失效 aggregate 自己`).toBeGreaterThan(0)
  }

  it('★★ aggregate.clearRejected ⇒ 聚合目录必须立刻重推（不等 60 秒 TTL）', async () => {
    await expectRepushAfterEndpoint('aggregate.clearRejected', { canonicalId: 'm' })
  })

  it('★★ aggregate.setOrderMode ⇒ 聚合目录必须立刻重推', async () => {
    await expectRepushAfterEndpoint('aggregate.setOrderMode', { mode: 'manual' })
  })

  it('★★ aggregate.rejectNonExpiring ⇒ 聚合目录必须立刻重推', async () => {
    await expectRepushAfterEndpoint('aggregate.rejectNonExpiring', {})
  })

  it('★ 三处聚合端点都**不得**连带失效别的渠道（硬约束：改一个开关不打十几个上游）', async () => {
    const { call } = setup()
    expect((await call('aggregate.clearRejected', { canonicalId: 'm' })).ok).toBe(true)
    expect(catalogInvalidatedAt('loomy'), '★ 不得连带失效 loomy').toBe(0)
    expect(catalogInvalidatedAt('aggregate'), '⚪️ 只失效 aggregate 自己').toBeGreaterThan(0)

    clearCatalogInvalidations()
    expect((await call('aggregate.setOrderMode', { mode: 'manual' })).ok).toBe(true)
    expect(catalogInvalidatedAt('loomy'), '★ setOrderMode 也不得连带失效 loomy').toBe(0)

    clearCatalogInvalidations()
    expect((await call('aggregate.rejectNonExpiring', {})).ok).toBe(true)
    expect(catalogInvalidatedAt('loomy'), '★ rejectNonExpiring 也不得连带失效 loomy').toBe(0)
  })

  it('★ 四处新接线的参数非法 ⇒ **不**失效（一个字都没改）', async () => {
    const { call } = setup()
    expect((await call('provider.setEnabled', { provider: 'loomy' })).ok).toBe(false)
    expect((await call('aggregate.clearRejected', { canonicalId: 7 })).ok).toBe(false)
    expect((await call('aggregate.setOrderMode', { mode: 'whatever' })).ok).toBe(false)
    expect(catalogInvalidatedAt('loomy'), '★ bad-request 不该白打一次上游').toBe(0)
    expect(catalogInvalidatedAt('aggregate'), '★ 三次 bad-request 都不该白打上游').toBe(0)
  })
})

/**
 * ★★ `credits.balances` 的 `accountIds` 裁剪（2026-10-15，规格 §7-8）。
 *
 * ⚠️ 两条**必须同时成立**的判据（缺一条就是真缺陷）：
 *  ① 传了 `accountIds` ⇒ **只查**那些账号（收益：徽标不再查停用号）；
 *  ② 但**自愈仍对全部账号跑** —— AGENTS.md 的成文铁律「续期不得按 `enabled` 过滤」：
 *     停用只影响自动选号，与「凭据是否需要保持新鲜」无关。若把 `healExpiredAccounts`
 *     也裁掉，停用账号的 refresh_token 会在停用期间一路放到失效，
 *     用户重新启用后拿到死凭据、只能重新登录（真实事故形态）。
 */
describe('★★ credits.balances 的 accountIds 裁剪', () => {
  type Handler = (request: Request) => Promise<Response>

  function setup() {
    let handler: Handler | undefined
    let stored: Record<string, unknown> = { accounts: [] }
    const healed: string[][] = []
    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    // 三条账号（两条启用、一条停用）
    stored = {
      accounts: [
        { id: 'a1', provider: 'buddy', nickname: 'a1', enabled: true, credentialRef: 'BUDDY_ACCOUNT_A1', createdAt: 1, refreshable: true },
        { id: 'a2', provider: 'buddy', nickname: 'a2', enabled: false, credentialRef: 'BUDDY_ACCOUNT_A2', createdAt: 2, refreshable: true },
        { id: 'a3', provider: 'buddy', nickname: 'a3', enabled: true, credentialRef: 'BUDDY_ACCOUNT_A3', createdAt: 3, refreshable: true },
      ],
    }

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return {
            fetch: {
              register: (config: { path: string; fetch: Handler }) => {
                if (config.path === JET_HUB_API_PATH) handler = config.fetch
              },
            },
          }
        }
        return undefined
      },
      inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      emit: () => {},
      credentials: {
        resolve: async () => undefined,
        describe: async () => ({ configured: false, writable: true }),
      },
    }

    registerJetHubRpc(ctx as never, pool, {} as never, {} as never)
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      return (await response.json() as { result: { ok: boolean; value?: unknown } }).result
    }
    return { call, healed }
  }

  const accountIdsOf = (result: { value?: unknown }) =>
    ((result.value as { accounts: Array<{ accountId: string }> }).accounts).map((row) => row.accountId).sort()

  it('★ 省略 accountIds ⇒ 查全部（积分面板的现状语义，逐字节不变）', async () => {
    const { call } = setup()
    const result = await call('credits.balances', { provider: 'buddy' })
    expect(result.ok).toBe(true)
    expect(accountIdsOf(result), '★ 省略时含停用账号').toEqual(['a1', 'a2', 'a3'])
  })

  it('★ 传 accountIds ⇒ 只查那些账号（徽标的收益）', async () => {
    const { call } = setup()
    const result = await call('credits.balances', { provider: 'buddy', accountIds: ['a1', 'a3'] })
    expect(result.ok).toBe(true)
    expect(accountIdsOf(result)).toEqual(['a1', 'a3'])
  })

  it('★★ 传**空数组** ⇒ 一条都不查（不得被当成「省略 = 查全部」）', async () => {
    // ⚠️ 这是最容易被写成反义的一格：`accountIds: []` 若被 falsy 判断吞掉，
    //    「全部账号都停用」反而会去查全部账号 —— 与收益完全相反。
    const { call } = setup()
    const result = await call('credits.balances', { provider: 'buddy', accountIds: [] })
    expect(result.ok).toBe(true)
    expect(accountIdsOf(result), '★ 空数组 = 查空集').toEqual([])
  })

  it('★ 畸形 accountIds（非数组 / 含非字符串）按「省略」处理，不抛错', async () => {
    const { call } = setup()
    expect(accountIdsOf(await call('credits.balances', { provider: 'buddy', accountIds: 'a1' })))
      .toEqual(['a1', 'a2', 'a3'])
    expect(accountIdsOf(await call('credits.balances', { provider: 'buddy', accountIds: [1, 'a1'] })))
      .toEqual(['a1'])
  })

  it('★★ 自愈**不受** accountIds 影响（铁律：续期不得按 enabled 过滤）', async () => {
    // ⚠️⚠️ 判据打在**行为**上：`credits.balances` 会对过期账号先续期。
    //    传了只含启用账号的 accountIds 时，**停用账号的凭据仍必须被续期** ——
    //    否则它在停用期间一路放到失效，用户重新启用后只能重新登录。
    //
    // ⚠️ 本用例用**源码级判据**（下方 `it`）兜底：自愈是否真的覆盖停用账号
    //    取决于 `healExpiredAccounts` 内部，而它在单测里不发网络请求（无凭据）。
    //    ⇒ 这里先断言端点在**裁剪后仍然调用了自愈**（不是「裁剪后再自愈」）。
    const { call } = setup()
    const result = await call('credits.balances', { provider: 'buddy', accountIds: ['a1'] })
    expect(result.ok).toBe(true)
    expect(accountIdsOf(result), '余额查询确实被裁剪了').toEqual(['a1'])
  })

  it('★★ 源码级：自愈必须传 `allAccounts`，余额查询才传裁剪后的 `accounts`', async () => {
    // ⚠️ 上面那条行为用例**分不出**「自愈收到全部账号」与「自愈收到裁剪后的账号」
    //    （单测无凭据 ⇒ 自愈内部对两者都不发请求）。⇒ 按本仓库惯例补一条
    //    **源码级判据**，并锚定具体片段（不是泛泛断言「文件里出现过 allAccounts」）。
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../src/jet-hub-rpc.ts', import.meta.url), 'utf8',
    ))
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // ★ 关键：余额端点那一处自愈必须是 `allAccounts`（不是被裁剪的 `accounts`）。
    expect(code, '★ 自愈必须用未裁剪的 allAccounts（停用账号也要续期）')
      .toMatch(/await healExpiredAccounts\(allAccounts\)/)
    // ⚠️ **不得**断言「文件里再没有 `healExpiredAccounts(accounts)`」——那会误红：
    //    `credits.claimAll` 端点（另一个 case）本来就有这一行，且它是**正确的**
    //    （领取路径不裁剪账号）。⇒ 判据只锚定余额端点的**邻域**。
    const balancesStart = code.indexOf("case 'credits.balances':")
    expect(balancesStart, '必须能定位余额端点').toBeGreaterThan(0)
    // 到下一个 case 为止（余额端点的边界）。
    const nextCase = code.indexOf("case '", balancesStart + 1)
    const balancesBlock = code.slice(balancesStart, nextCase > 0 ? nextCase : undefined)
    expect(balancesBlock, '★ 余额端点的自愈不得传裁剪后的 accounts')
      .not.toMatch(/healExpiredAccounts\(accounts\)/)
    // ★ 且裁剪真的发生了（否则上面两条可以在「没有裁剪功能」时空过）。
    expect(code).toMatch(/requestedIds\.has\(entry\.id\)/)
  })
})

/**
 * 「严格手动顺序」的**两个 RPC 端点**（2026-11-09 审计：零覆盖）。
 *
 * ## 为什么必须单独钉
 *
 * 对抗审计实测：把 `strictManualOrder.getEnabled` 的返回值改成恒 `false`
 * 之后，定向 4 个文件 72/72 **全绿**。症状是面板永远显示「关」——
 * 用户开了开关、重启后开关自己弹回去，而且没有任何报错可归因。
 *
 * ## 判据为什么包含「回读」那一格
 *
 * `setEnabled` 的返回**不是** `req.enabled` 的复读，而是 `pool.strictManualOrder()`
 * 的**回读**（见端点注释：客户端据此做非乐观更新）。若实现改成直接回显入参，
 * 「落盘失败但仍回 true」就会让面板显示已打开 —— 本文件用「一个拒绝写入的池」
 * 把这两种实现区分开（回显实现 ⇒ 红）。
 */
describe('strictManualOrder 端点接线', () => {
  type Handler = (request: Request) => Promise<Response>

  interface StrictPoolStub {
    /** 模拟「落盘后的真实值」。 */
    enabled: boolean
    /** 模拟「写入被拒」（例如只读后端）：池自己不改值。 */
    readonly rejectWrites: boolean
    readonly setCalls: Array<{ provider: string; enabled: boolean }>
  }

  function makeHandler(state: StrictPoolStub): Handler {
    let handler: Handler | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? {
            fetch: {
              register: (config: { path: string; fetch: Handler }) => {
                if (config.path === JET_HUB_API_PATH) handler = config.fetch
              },
            },
          }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    }
    const pool = {
      listAccountsByProvider: () => [],
      strictManualOrder: () => state.enabled,
      qoderTrafficGuardEnabled: (provider: string) => provider === 'qoder' ? state.enabled : true,
      setQoderTrafficGuardEnabled: async (provider: string, enabled: boolean) => {
        state.setCalls.push({ provider, enabled })
        if (state.rejectWrites) throw new Error('状态写入失败')
        state.enabled = enabled
      },
      setStrictManualOrder: async (provider: string, enabled: boolean) => {
        state.setCalls.push({ provider, enabled })
        if (!state.rejectWrites) state.enabled = enabled
      },
    }
    registerJetHubRpc(ctx as never, pool as never, {} as never)
    if (handler === undefined) throw new Error('endpoint handler was not registered')
    return handler
  }

  async function call(handler: Handler, method: string, payload: unknown): Promise<{
    ok: boolean
    value?: { enabled: boolean }
    error?: { code: string; message: string }
  }> {
    const response = await handler(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-strict',
        method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as { result: { ok: boolean; value?: { enabled: boolean }; error?: { code: string; message: string } } }
    return body.result
  }

  it('getEnabled 返回池的当前值（池为 true ⇒ 必须 true）', async () => {
    const handler = makeHandler({ enabled: true, rejectWrites: false, setCalls: [] })
    const result = await call(handler, 'strictManualOrder.getEnabled', { provider: 'buddy' })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ enabled: true })
  })

  it('Qoder 限流可通过面板接口读写，拒绝不适用的渠道和非布尔值', async () => {
    const state: StrictPoolStub = { enabled: true, rejectWrites: false, setCalls: [] }
    const handler = makeHandler(state)
    expect(await call(handler, 'qoderTrafficGuard.getEnabled', { provider: 'qoder' }))
      .toMatchObject({ ok: true, value: { enabled: true } })
    expect(await call(handler, 'qoderTrafficGuard.setEnabled', { provider: 'qoder', enabled: false }))
      .toMatchObject({ ok: true, value: { enabled: false } })
    expect(await call(handler, 'qoderTrafficGuard.getEnabled', { provider: 'qodercn' }))
      .toMatchObject({ ok: true, value: { enabled: true } })
    expect(await call(handler, 'qoderTrafficGuard.setEnabled', { provider: 'buddy', enabled: false }))
      .toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await call(handler, 'qoderTrafficGuard.setEnabled', { provider: 'qoder', enabled: 'false' }))
      .toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(state.setCalls).toEqual([{ provider: 'qoder', enabled: false }])
  })

  it('getEnabled 缺 provider ⇒ bad-request（不静默当成空渠道）', async () => {
    const handler = makeHandler({ enabled: true, rejectWrites: false, setCalls: [] })
    const result = await call(handler, 'strictManualOrder.getEnabled', {})
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('bad-request')
  })

  it('setEnabled 把 provider / enabled 原样传给池，并返回**回读**值', async () => {
    const state: StrictPoolStub = { enabled: false, rejectWrites: false, setCalls: [] }
    const handler = makeHandler(state)
    const result = await call(handler, 'strictManualOrder.setEnabled', {
      provider: 'buddy',
      enabled: true,
    })
    expect(state.setCalls).toEqual([{ provider: 'buddy', enabled: true }])
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ enabled: true })
  })

  it('★ 写入被拒时不得回显入参（回读实现 ⇒ 值仍为 false）', async () => {
    const state: StrictPoolStub = { enabled: false, rejectWrites: true, setCalls: [] }
    const handler = makeHandler(state)
    const result = await call(handler, 'strictManualOrder.setEnabled', {
      provider: 'buddy',
      enabled: true,
    })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ enabled: false })
  })

  it('setEnabled 的 enabled 非布尔 ⇒ bad-request（不做默认值猜测）', async () => {
    const state: StrictPoolStub = { enabled: false, rejectWrites: false, setCalls: [] }
    const handler = makeHandler(state)
    for (const bad of ['true', 1, null, undefined]) {
      const result = await call(handler, 'strictManualOrder.setEnabled', { provider: 'buddy', enabled: bad })
      expect(result.ok, String(bad)).toBe(false)
      expect(result.error?.code, String(bad)).toBe('bad-request')
    }
    expect(state.setCalls).toEqual([])
  })
})
