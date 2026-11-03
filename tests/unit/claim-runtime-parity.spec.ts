/**
 * `credits.claimAll` / `onboarding.*` 改为**查表分派**后的行为回归（Task 4）。
 *
 * ## ⚠️ 为什么不用 brief 给的那版对拍用例
 *
 * brief Step 1 的样例直接 `runtimeOf(id)` 却**从不注册任何 runtime**
 * （没有 `apply()`、没有 `registerProviderRuntime`）⇒ 每次查表都是 `undefined`，
 * 于是 `expect(runtimeOf('trae')?.credits?.precheckStatus).toBe(true)` 与
 * `expect(runtimeOf('buddy')?.credits?.afterClaim).toBeTypeOf('function')`
 * **在实现完全正确之后仍然是红的**。那不是「先红后绿」，那是**恒红**。
 * ⇒ 本文件按 `provider-runtime-wiring.spec.ts` 的做法真跑 `apply()`。
 *
 * ## ⚠️ 为什么还要端点级哨兵（本文件的判别力来源）
 *
 * 只断言「runtime 表里有某个函数」是**结构**断言：它证明不了端点**真的查了那张表**
 * ——把 `credits.claimAll` 改回硬编码分支、表却原样留着，那一组照样全绿。
 * 故另有一组用**模块替身**（`vi.mock('provider-credits.js')`，与
 * `credits-runtime-parity.spec.ts` 同法）注入哨兵表，断言**端点响应**里出现
 * 只可能来自该表的值。这正是 Task 3 用它替换「就地复刻旧逻辑」那种同义反复的理由。
 *
 * ⚠️ 替身落在**模块边界**上：生产代码一行未改，也没有任何 `NODE_ENV` / 形参分支。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { apply } from '../../src/index.js'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import { clearProviderRuntimes, registerProviderRuntime, runtimeOf } from '../../src/provider-runtime.js'
import type { ProviderCredits } from '../../src/provider-runtime.js'
import type { ClaimOutcome } from '../../src/credits.js'
// ⚠️ 2026-11-01：Magicrew 两站的**完整 URL** 断言要用到两个 product 常量
//   （只断路径片段的话两站路径逐字符相同 ⇒ 原理上无法区分）。
import { MAGICREW, MAGICREW_INTL } from '../../src/magicrew-product.js'

/**
 * 端点级哨兵表的注入点（`vi.hoisted` 让它在 `vi.mock` 的**提升**工厂里可见）。
 *
 * ⚠️ `undefined` = 透传真实工厂（默认）。透传是必需的：本文件要直接断言**真表**
 * 的内容，若替身恒生效，那组会退化成「测替身」。
 */
const creditsOverride = vi.hoisted(() => ({
  current: undefined as Readonly<Record<string, ProviderCredits>> | undefined,
}))

vi.mock('../../src/provider-credits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/provider-credits.js')>()
  return {
    ...actual,
    createProviderCredits: (deps?: unknown) =>
      creditsOverride.current ?? actual.createProviderCredits(deps as never),
  }
})

/**
 * **签到状态查询的调用计数**（`precheckStatus` 的行为判据）。
 *
 * ## ⚠️ 为什么必须用模块替身计数，而不是「看有没有发请求」
 *
 * 本文件最初对 loomy 的判据是「用会抛错的 `fetch` 桩，断言没有 buddy 式状态请求」。
 * **那个判据是假绿**（2026-10-08 反向验证实测发现）：骨架在 `precheckStatus`
 * 缺省（true）时会调默认的 `fetchCheckinStatus(credential, product)`，而通用分支
 * 传的 `product` 是 `undefined` ⇒ 它在 `postJson` 里访问 `product.endpoint`
 * **先抛 TypeError**，被 `postJson` 自己的 catch 吞成 `{ok:false}` ⇒
 * 状态查询返回 `null` ⇒ 骨架照常去 claim。
 * 结果：**一个 URL 都不会出现在 fetch 桩里**，两种 `precheckStatus` 取值下
 * 观测到的请求完全一样 —— 断言恒真。
 *
 * ⇒ 真正的判据是「骨架**有没有走**预检那条路」，即 `fetchCheckinStatus` 被**进入**
 * 了几次。缺省 true ⇒ 进 1 次；显式 false ⇒ 进 0 次（骨架直接跳到 `claim`）。
 * 这条对 `product` 是否为 undefined 中立，故不会因为将来传了真 product 而失效。
 */
const checkinStatusCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('../../src/credits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/credits.js')>()
  return {
    ...actual,
    fetchCheckinStatus: (...args: Parameters<typeof actual.fetchCheckinStatus>) => {
      checkinStatusCalls.count++
      return actual.fetchCheckinStatus(...args)
    },
  }
})

/** 内存凭据存储（与其它 spec 同款）。 */
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

/** 17 个 auth 键的**空桩**（本文件只走 credits / onboarding 端点）。 */
function emptyAuths(): Record<string, unknown> {
  const stub = {} as never
  return {
    codearts: stub, buddy: stub, workbuddy: stub, lobsterai: stub,
    qoder: stub, qodercn: stub, trae: stub, cline: stub, loomy: stub,
    raccoon: stub, minimax: stub, minimaxintl: stub, zcode: stub, gemini: stub,
    officeace: stub, accio: stub, autoclaw: stub,
  }
}

/**
 * 装配一套能真调 credits / onboarding 端点的最小 RPC。
 *
 * ⚠️ `settings.register` **必须返回可用 scope**（理由见 `credits-runtime-parity.spec.ts`）。
 * ⚠️ `credits` 形参是**本文件自己的接缝**（模块替身），**不是**生产签名的一部分。
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
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_deps: string[], cb: (c: unknown) => void) => cb(ctx)

  const pool = new AccountPool(ctx)
  registerJetHubRpc(ctx, pool, (auths ?? emptyAuths()) as never, undefined)
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

/** 跑一次**真实 `apply()`**（必须先清空注册表，理由见 `provider-runtime-wiring.spec.ts`）。 */
function applyOnce(): Context {
  clearProviderRuntimes()
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', { register: () => () => {} } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  ctx.provide('settings', { register(): void {}, describe: () => [] } as never)
  apply(ctx)
  return ctx
}

beforeEach(() => {
  clearProviderRuntimes()
  creditsOverride.current = undefined
})
afterEach(() => {
  clearProviderRuntimes()
  creditsOverride.current = undefined
  vi.unstubAllGlobals()
})

// ─────────────────────────────────────────────────────────────────────────────
// 一、能力声明与 runtime 实现不许漂移（真跑 apply()，否则 runtimeOf 恒 undefined）
// ─────────────────────────────────────────────────────────────────────────────

describe('签到能力：registry 声明与 runtime 实现必须一致', () => {
  /**
   * ⚠️ **`zcode` 与 Qoder 同族是形态不匹配的特例**（与余额侧的 `opencode` /
   * qoder 系同族理由）：
   * - `zcode`：「一键领取」= 补激活上报 → preview → **逐个 plan** claim，且
   *   **每个 plan 都要重新产一个 captcha**（一次性，复用会得 `3007`）⇒ **不能**套
   *   `claim(credential, entry, call) → ClaimOutcome` 那套「一个凭据一次 claim」
   *   的形状（一个账号可能有多条 outcome）；
   * - `qoder` / `qodercn`：`claimQoderDailyCheckin` 只吃 `QoderCredential` +
   *   `QoderProduct`，而表里的实现**自带 product 配置**（闭包捕获）⇒ 形态不匹配。
   *   它们**刻意不在** credits 表里，由 `credits-runtime-parity.spec.ts` 的
   *   「表里的渠道集合」与 `provider-runtime-wiring.spec.ts` 的「形态不匹配的特例」
   *   两条守卫要求缺席。
   *
   * ⚠️ 这个豁免集**必须被钉住**（下面第二条用例真跑端点证明它们确实能签到），
   * 否则它会退化成「用豁免名单掩盖漏接」—— 那正是本仓库记录过的形态。
   */
  const CLAIM_SPECIAL_CASES = new Set(['zcode', 'qoder', 'qodercn'])

  it('dailyCheckin === true 的渠道，runtime 必须有 claim（特例除外，见下）', () => {
    applyOnce()
    const checked: string[] = []
    for (const d of PROVIDER_REGISTRY) {
      if (d.credits.dailyCheckin !== true) continue
      if (CLAIM_SPECIAL_CASES.has(d.id)) continue
      // ⚠️ 只有真渠道才有 runtime；aggregate 的 dailyCheckin 已是 false。
      if (runtimeOf(d.id) === undefined) continue
      checked.push(d.id)
      expect(runtimeOf(d.id)?.credits?.claim, `${d.id} 声明可签到却无 claim`).toBeTypeOf('function')
    }
    // 防止循环被静默跳过（registry 全变 false 时空转也是恒绿）。
    // ⚠️ 阈值 = 声明可签到的渠道数减去特例数。写死它是有意的：
    //    若有人删掉表里某家的 `claim`，这里会**先**红（而不是让循环少转一圈）。
    // ⚠️ 2026-10-15 加 minimaxintl（MiniMax Code 国际版，声明可签到）⇒ 6 → 7。
    // ⚠️ 2026-10-16 加 astudio（声明可签到且有 claimDaily 接线）：7 → 8。
    // ⚠️ 2026-10-17 加 autoclaw（AutoClaw/智谱，声明可签到）：8 → 9。
    // ⚠️ 2026-10-20 加 autoclawintl（AutoClaw 国际版，与国内同源）：9 → 10。
    // ⚠️ 2026-10-22 合并审计：codely 现在真的注册了 runtime（`src/index.ts` 里那处
    //    「有 probe 但不在 `registry` 数组里」的单独注册）⇒ 它第一次进入本循环。
    //    它的 `claim` 本来就在 `provider-credits.ts` 的 codely 条目里（实测
    //    `typeof createProviderCredits()['codely'].claim === 'function'`），
    //    此前**因为 `runtimeOf('codely') === undefined` 被上面那句 `continue` 静默跳过**，
    //    所以这条守卫此前对 codely 零覆盖。10 → 11。
    // ⚠️ 2026-11-01：magicrew + magicrewintl 补上 `dailyCheckin` 并接了 `claim`
    //    （`POST /api/v1/login-gift`）⇒ 11 → 13。
    // ⚠️ 2026-11-02 加 monkeycode（MonkeyCode，声明可签到）：`claim` 在
    //    `provider-credits.ts` 的 monkeycode 条目里（challenge → 本地 PoW →
    //    redeem → checkin）⇒ 13 → 14。
    // ⚠️ 2026-11-02 拆站：monkeycodeintl 与 monkeycode **逐字同构**（同一套代码的
    //    另一部署），`claim` 同样在 `provider-credits.ts` 的 monkeycodeintl 条目里
    //    ⇒ 14 → 15。
    // ⚠️ 2026-11-03 加 baizhi（百智云，Cap 验证码补全后声明可签到）：`claim` 在
    //    `provider-credits.ts` 的 baizhi 条目里（challenge → 本地 PoW → redeem →
    //    daily-temporary-credit）⇒ 15 → 16。
    expect(checked.length, '没有任何渠道被检查 = 本用例什么都没守').toBe(16)
  })

  /**
   * ⚠️ **豁免集不许扩大**：它只能含「形态与骨架根本不匹配」的家。
   * 写死它是**有意**的 —— 若有人为了让自己那家「绿」而往这里加 id，
   * 本用例会红并要求他复核（而不是让覆盖静默归零）。
   */
  it('★ claim 特例集恰好是 {zcode, qoder, qodercn}，且它们在 registry 里确实声明可签到', () => {
    expect([...CLAIM_SPECIAL_CASES].sort()).toEqual(['qoder', 'qodercn', 'zcode'])
    for (const id of CLAIM_SPECIAL_CASES) {
      // 反向：确认这个豁免**不是**「该家本来就不能签到」的托词。
      expect(descriptorOf(id)?.credits.dailyCheckin, `${id} 本来就不声明可签到，不该占着豁免名额`).toBe(true)
    }
  })

  /**
   * ★ **Qoder 同族的特例分支真的接上了**（真跑端点，证明它没被查表改造漏掉）。
   *
   * ⚠️ 它必须**开** `precheckStatus: false`（流程自带活动查询），且必须打到
   * **这家自己的** product 上 —— 中国版串到国际版是历史复发 6 次的形态。
   */
  it.each([
    ['qoder', 'QODER_ACCOUNT_SPEC'],
    ['qodercn', 'QODERCN_ACCOUNT_SPEC'],
  ])('★ 豁免者 %s 的领取打到自己的 product 上（真跑端点）', async (provider, ref) => {
    const { call, pool, credentials } = makeRpc(undefined, { ...emptyAuths(), [provider]: {} })
    await seed(pool, provider, `${provider}-1`, ref)
    await credentials.set(ref, JSON.stringify({ access_token: 'AT', user_id: 'u-1', machine_id: 'm-1' }))
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      // 活动列表查询回空活动 ⇒ `claimQoderDailyCheckin` 走「没有可领活动」分支。
      return new Response(JSON.stringify({ campaigns: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })

    const result = await call('credits.claimAll', { provider })
    expect(result.ok, `${provider} 应被接受，实际 error=${result.error?.message}`).toBe(true)
    expect(seen.length, `${provider} 的领取分支没有发请求（特例分支断了？）`).toBeGreaterThan(0)
    // ⚠️ 反向：**不得**出现 buddy 式的状态查询（那说明 precheckStatus:false 没生效）。
    expect(
      seen.some((url) => url.includes('checkin-activity-status')),
      `${provider} 发了 buddy 式状态预检 —— precheckStatus:false 没生效`,
    ).toBe(false)
  })

  /**
   * ★ **豁免者必须真的能签到**（否则豁免就是掩盖漏接）。
   *
   * 行为断言：真跑端点，让 zcode 的 captcha 与上游都走桩，断言它返回
   * `ok:true` + 一个 claimed outcome —— 证明特例分支真的把 zcode 接上了。
   */
  it('★ 豁免者 zcode 真的能签到（真跑端点，证明特例分支没断）', async () => {
    // ⚠️ zcode 的 claim 走 **auth 实例**上的 `claimDailyFor`（每个 plan 现产 captcha），
    //    故必须给它一个**带方法的替身** —— 空对象 `{}` 会以
    //    `claimDailyFor is not a function` 失败，那是**用例没搭好**，不是实现缺陷。
    const perPlan: string[] = []
    const { call, pool, credentials } = makeRpc(undefined, {
      ...emptyAuths(),
      zcode: {
        // 一个账号回**两条** outcome（两个 plan）—— 这正是它不能套
        // `claim(credential, entry, call) → ClaimOutcome` 形状的原因
        //（那个形状一个账号只装得下一条）。
        claimDailyFor: async (credential: unknown, mint: (config: unknown) => Promise<unknown>) => {
          perPlan.push('plan-a', 'plan-b')
          await mint({ region: 'cn', param: 'sentinel' })
          return [
            { kind: 'claimed', credit: 111, streakDays: 0, isStreakDay: false },
            { kind: 'claimed', credit: 222, streakDays: 0, isStreakDay: false },
          ]
        },
        mintCaptcha: async () => 'param-sentinel',
      },
    })
    await seed(pool, 'zcode', 'z-1', 'ZCODE_ACCOUNT_SPEC')
    await credentials.set('ZCODE_ACCOUNT_SPEC', JSON.stringify({
      zcode_jwt: 'jwt', user_id: 'uid-1', device_mid: 'mid',
    }))
    vi.stubGlobal('fetch', async () => { throw new Error('哨兵替身不该发网络请求') })

    const result = await call('credits.claimAll', { provider: 'zcode' })
    expect(result.ok, `zcode 的特例分支没有接上，实际 error=${result.error?.message}`).toBe(true)
    // 两条 outcome 都被展开（证明走的是「自己遍历账号与 plan」那条形状）。
    expect(result.value.results, 'zcode 没有逐 plan 展开 outcome').toHaveLength(2)
    expect(result.value.results.map((r: { outcome: { credit: number } }) => r.outcome.credit))
      .toEqual([111, 222])
    expect(result.value.summary.claimed).toBe(2)
    // 反向：确认 captcha 真的被现产（每个 plan 一次）—— 若实现忘了 mint，
    // 上游会回 3007，而这条桩不会红，故必须显式断言它被调用过。
    expect(perPlan.length, 'captcha 没有被现产（复用会得 3007）').toBe(2)
  })

  /**
   * ★ **LobsterAI 的 `clientVersion` 必须由端点那张表提供**（不是兜底常量）。
   *
   * ⚠️ 它守的失效形态**真实存在**：`createProviderCredits` 的
   * `lobsteraiClientVersion` 是**可选** dep，漏传**没有编译错误**，而症状是
   * 签到退回产品里那个**静态兜底版本号**（`LOBSTERAI_FALLBACK_CLIENT_VERSION`）
   * —— 它可能早已过期，而 `clientVersion` 是签到接口的**必填** query 参数。
   * 这条用**哨兵版本号**证明「端点真的把解析器接上了」：哨兵只可能来自 dep。
   */
  it('★★ LobsterAI 的 clientVersion 由端点接上（哨兵版本号必须出现在请求里）', async () => {
    // ⚠️ 必须给 lobsterai 一个**带 `resolveClientVersion` 的替身**：生产里它是
    //    真实的 `LobsteraiAuth`，而 `emptyAuths()` 的空对象没有这个方法
    //    ⇒ 端点的 `() => lobsterai.resolveClientVersion()` 会抛，claim 变成 failed。
    //    （那是**用例没搭好**，不是实现缺陷 —— 与 zcode 的 `claimDailyFor` 同型。）
    const { call, pool, credentials } = makeRpc(undefined, {
      ...emptyAuths(),
      lobsterai: { resolveClientVersion: async () => 'SENTINEL-VERSION-9.9.9' },
    })
    await seed(pool, 'lobsterai', 'lb-1', 'LOBSTERAI_ACCOUNT_SPEC')
    await credentials.set('LOBSTERAI_ACCOUNT_SPEC', JSON.stringify({
      access_token: 'AT-LB', keyfrom: 'kf', user_id: 'u-1',
    }))
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      // 空响应 ⇒ 领取流程以「活动槽位查询失败」收场，但**请求已经发出**，
      // 本用例只关心 URL 里带的是哪个版本号。
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await call('credits.claimAll', { provider: 'lobsterai' })
    expect(result.ok, `lobsterai 应被接受，实际 error=${result.error?.message}`).toBe(true)
    // ⚠️ 判据是**哨兵版本号**：它只可能来自替身的 `resolveClientVersion`。
    //    若端点漏传 `lobsteraiClientVersion`，实现会退回产品的**静态兜底常量**
    //    （`LOBSTERAI_FALLBACK_CLIENT_VERSION`），哨兵不会出现 ⇒ 红。
    expect(
      seen.some((url) => url.includes('SENTINEL-VERSION-9.9.9')),
      'lobsterai 的签到请求里没有哨兵版本号 —— 端点漏传了 lobsteraiClientVersion'
      + '（会退回可能过期的静态兜底版本，而它是签到接口的必填参数）',
    ).toBe(true)
  })

  it('dailyCheckin === false 的渠道，runtime 不应有 claim（否则会打无谓请求）', () => {
    applyOnce()
    for (const d of PROVIDER_REGISTRY) {
      if (d.credits.dailyCheckin !== false) continue
      expect(runtimeOf(d.id)?.credits?.claim, `${d.id} 声明不可签到却有 claim`).toBeUndefined()
    }
    // 反向：确认上面那圈里真的既有 true 也有 false，否则断言恒真。
    expect(PROVIDER_REGISTRY.some((d) => d.credits.dailyCheckin === true)).toBe(true)
    expect(PROVIDER_REGISTRY.some((d) => d.credits.dailyCheckin === false)).toBe(true)
  })

  it('onboardingTasks === true 的渠道，runtime 必须有 onboarding.claim', () => {
    applyOnce()
    const checked: string[] = []
    for (const d of PROVIDER_REGISTRY) {
      if (d.credits.onboardingTasks !== true) continue
      checked.push(d.id)
      expect(runtimeOf(d.id)?.onboarding?.claim, `${d.id} 声明有新手任务却无实现`).toBeTypeOf('function')
      expect(runtimeOf(d.id)?.onboarding?.status, `${d.id} 声明有新手任务却无 status`).toBeTypeOf('function')
    }
    expect(checked.length, '没有任何渠道被检查 = 本用例什么都没守').toBeGreaterThanOrEqual(2)
  })
})

/**
 * ★★ **Magicrew 两站的签到必须打到各自的 host**（国际站串号守卫，2026-11-01 补）。
 *
 * ## 为什么必须有这条（测试有效性审查的**阻断项**）
 *
 * 原有用例（上面那批）只断**路径片段**，而两站的 `login-gift` 路径
 * **逐字符相同**（`/api/v1/login-gift`）⇒ 原理上无法区分两站。
 * 实测：把 `src/provider-credits.ts` 里 `magicrewintl` 两处的
 * `product: MAGICREW_INTL` 复制粘贴成 `product: MAGICREW`（余额 + 签到），
 * 再连同另外三个同型缺陷一起注入，**25 个 spec / 859 条用例全绿**。
 *
 * 生产症状：国际站账号的 JWT 打到 `i-magic-service.letsmagic.cn` ⇒
 * 签到恒失败（业务码错/401），而 UI 上只看到「签到失败」，零线索指向配置。
 *
 * ⇒ 本用例断**完整 URL**（host + path），两站各跑一次；且**断言两个 host 不同**
 *（否则 fixture 写错时会静默变成「两站都打国内」也过）。
 */
describe('★★ Magicrew 两站的签到打到各自的 host（国际站串号守卫）', () => {
  it.each([
    { provider: 'magicrew', product: MAGICREW },
    { provider: 'magicrewintl', product: MAGICREW_INTL },
  ])('$provider 的 claim 打到 $product.host', async ({ provider, product }) => {
    const ref = `${provider.toUpperCase()}_ACCOUNT_SPEC`
    const { call, pool, credentials } = makeRpc(undefined, { ...emptyAuths(), [provider]: {} } as never)
    await seed(pool, provider, `${provider}-1`, ref)
    // ⚠️ 必须同时给 `jwt` 与 `organizationCode`：国际站缺 org 时原语会**本地前置拦截**
    //    （`magicrew-checkin.ts` 的 `needsOrgOnGateway` 判断），那样根本不会发请求，
    //    本用例就变成空转（审查里 `:87` 那条就是这么废掉的）。
    await credentials.set(ref, JSON.stringify({ jwt: 'JWT-SPEC', organizationCode: 'org-spec' }))

    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response(
        JSON.stringify({ code: 1000, message: 'ok', data: { granted: true, point_amount: 7 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const result = await call('credits.claimAll', { provider })
    expect(result.ok, `${provider} 应被接受，实际 error=${result.error?.message}`).toBe(true)
    expect(seen.length, `${provider} 的领取没有发请求（claim 没接上？）`).toBeGreaterThan(0)

    const expectedUrl = `${product.host}/api/v1/login-gift`
    expect(seen[0], `${provider} 的签到没有打到自己的 host（国际站打到国内 host 会恒失败）`)
      .toBe(expectedUrl)
  })

  it('两站的 host 互不相同（fixture 自检：相同则上面那条恒真）', () => {
    expect(MAGICREW.host).not.toBe(MAGICREW_INTL.host)
  })
})

/**
 * ⚠️ **`precheckStatus: true` 但不需要 `fetchStatus`** 的渠道（2026-11-01）。
 *
 * 它们把「今天领没领」的判据**内建在自己的 claim 里**，不暴露成共享状态端点：
 *
 * | 渠道 | 为什么豁免 |
 * |---|---|
 * | `trae` | claim 本身幂等且与真领取**无法区分**，只能靠 status 判定 —— 而它的状态查询在 `claimTraeDailyCheckin` 内部（走账号池的设备指纹） |
 * | `zcode` | claim 走 auth 实例的 `claimDailyFor`（每个 plan 现产 captcha），预检在内部完成 |
 *
 * ⚠️ 本集合**必须有自检**（见下面那条用例），否则后人遇到红就往里加 id 来消除失败。
 */
const PRECHECK_WITHOUT_FETCH_STATUS: ReadonlySet<string> = new Set(['trae', 'zcode'])

describe('precheckStatus：TRAE 必须 true，自带预检的渠道必须 false', () => {
  it('TRAE 为 true（它的 claim 幂等且与真领取无法区分，只能靠 status 判定）', () => {
    applyOnce()
    // ⚠️ 这条锁的正是「显示成功但 +0 积分」那个真实报障：改成 false 即红。
    expect(runtimeOf('trae')?.credits?.precheckStatus).toBe(true)
  })

  it('codearts / lobsterai 为 false（各自流程自带预检，外部再查是重复请求）', () => {
    applyOnce()
    for (const id of ['codearts', 'lobsterai']) {
      expect(runtimeOf(id)?.credits?.precheckStatus, `${id} 应传 false`).toBe(false)
    }
  })

  /**
   * ⚠️ **`loomy` 也必须 false，且理由与上面两家不同** —— 它是**缺省值陷阱**：
   * 骨架的默认 `precheck = deps.precheckStatus !== false`，而 loomy **没有**
   * `fetchStatus` ⇒ 不显式传 false 时，骨架会拿**buddy 式**的
   * `fetchCheckinStatus` 去打 Loomy 端点 —— 一次**必然失败的真实上游请求**。
   * 这正是本仓库反复记录的「守卫看起来在、实际没守」形态。
   */
  it('★ loomy 必须 false（它没有 fetchStatus，缺省 true 会拿 buddy 式查询打 Loomy 端点）', () => {
    applyOnce()
    expect(runtimeOf('loomy')?.credits?.precheckStatus, 'loomy 不传 false 会发必然失败的上游请求').toBe(false)
    // 反向：确认 loomy **确实没有** fetchStatus —— 否则上面那条就是多余的。
    expect(runtimeOf('loomy')?.credits?.fetchStatus, 'loomy 不该有同构状态端点').toBeUndefined()
  })

  /**
   * ★★ **派生判据**：`precheckStatus` 只有在**真的实现了 `fetchStatus`** 时才允许为 `true`。
   *
   * ## 为什么必须有这条（2026-11-01 二审的**阻断项**）
   *
   * 上面那条只钉死了 `loomy` 一家。实测把 `src/provider-credits.ts` 里
   * `magicrewintl` 的 `precheckStatus: false` 改成 `true`，
   * **全量 11693 条一条都不红** —— 而生产后果是：
   *
   * 运行时在签到前先调 `fetchStatus`，而本家根本没有同构端点 ⇒ 发出
   * `undefined/v2/billing/meter/checkin-activity-status` 这类畸形 URL
   * （Node 抛 `Failed to parse URL from undefined/...`）⇒ 被 try/catch 收成
   * `{kind:'failed'}` ⇒ **国际站一键签到每天必失败**，文案还是 URL 解析错误。
   *
   * ⇒ 判据从「手写名单」改成**从能力表派生**：凡是 `true` 的，必须自证有 `fetchStatus`。
   *    这样新接入的渠道漏写 `precheckStatus: false` 时**自动**被点名。
   */
  it('★★ 派生：precheckStatus 为 true 的渠道必须真有 fetchStatus（否则签到恒失败）', () => {
    applyOnce()
    const offenders: string[] = []
    let checked = 0
    for (const descriptor of PROVIDER_REGISTRY) {
      if (descriptor.credits.dailyCheckin !== true) continue
      const credits = runtimeOf(descriptor.id)?.credits
      if (credits === undefined) continue
      checked += 1
      if (PRECHECK_WITHOUT_FETCH_STATUS.has(descriptor.id)) continue
      // `precheckStatus` 缺省是 true（见 `ProviderCredits` 的类型注释）⇒
      // 只判显式 true 会漏掉「根本没写」的情况，故这里判「不是 false」。
      const precheck = credits.precheckStatus !== false
      if (precheck && credits.fetchStatus === undefined) offenders.push(descriptor.id)
    }
    expect(
      offenders,
      '★ 这些渠道没实现 fetchStatus，却没把 precheckStatus 置 false '
      + '⇒ 签到前会发一个必然失败的畸形状态查询（用户看到「签到失败」，零线索）',
    ).toEqual([])
    // ⚠️ 反向自检：必须真的遍历到若干家，否则上面是空转。
    expect(checked, '一个渠道都没检查到 = 本用例什么都没守').toBeGreaterThanOrEqual(10)
  })

  it('★ 豁免集自检：恰好是 {trae, zcode}，且它们确实声明了可签到', () => {
    // ⚠️ 有了这条，「遇到红就加 id」这条路走不通：加进来的 id 必须真的在 registry 里
    //    声明 `dailyCheckin: true`，且集合大小被钉死（加一家必须改这条用例并说明理由）。
    expect([...PRECHECK_WITHOUT_FETCH_STATUS].sort()).toEqual(['trae', 'zcode'])
    for (const id of PRECHECK_WITHOUT_FETCH_STATUS) {
      const descriptor = PROVIDER_REGISTRY.find((d) => d.id === id)
      expect(descriptor, `${id} 不在 registry 里`).toBeDefined()
      expect(descriptor?.credits.dailyCheckin, `${id} 没有声明可签到，不该在豁免集里`).toBe(true)
    }
  })
})

/**
 * ⚠️ **成长中心（`afterClaim`）漏掉即静默消失**（计划 Step 5b 的预检缺口）。
 *
 * 它是 22 项成长中心任务的入口：漏掉后症状**只是**「成长中心不工作了」，
 * 用户点「一键领取积分」看不到任务列表，**日志里没有错误**。
 */
describe('★ credits.afterClaim：只有 buddy 提供（成长中心，漏了会静默消失）', () => {
  it('buddy 必须有 afterClaim，其余渠道一个都不许有', () => {
    applyOnce()
    expect(runtimeOf('buddy')?.credits?.afterClaim, 'buddy 必须有 afterClaim').toBeTypeOf('function')
    for (const id of [
      'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline',
      'loomy', 'raccoon', 'minimax', 'zcode', 'gemini', 'codearts',
      // ⚠️ minimaxintl 同样**没有** afterClaim（成长中心只有 buddy 提供）。
      'minimaxintl',
      // ⚠️ autoclaw 同样**没有** afterClaim（成长中心只有 buddy 提供）。
      'autoclaw',
    ]) {
      expect(runtimeOf(id)?.credits?.afterClaim, `${id} 不该有 afterClaim`).toBeUndefined()
    }
  })

  /**
   * ⚠️ 判据由**表**说了算，不再有平行的 `GROWTH_CAPABLE_PROVIDERS` 手抄集合
   * （Task 1b 同因：消除平行副本，让「哪家有成长中心」由能力注册表决定）。
   */
  it('★ 「哪家有成长中心」由能力表派生（不再有 GROWTH_CAPABLE_PROVIDERS 平行副本）', () => {
    applyOnce()
    const withGrowth = ['buddy']
      .filter((id) => runtimeOf(id)?.credits?.afterClaim !== undefined)
    expect(withGrowth).toEqual(['buddy'])
    // 反向：确认「有 afterClaim」这件事**不是**所有渠道都成立，否则断言恒真。
    expect(runtimeOf('trae')?.credits?.afterClaim).toBeUndefined()
  })

  /**
   * ★★★ **生产闭包真的跑得到成长中心**（Task 11-G 补的缺口，见下）。
   *
   * ## ⚠️ 上面两条守不住什么（实测取证，2026-10-08）
   *
   * 它们只断言 `afterClaim` **是个函数**。反向验证实测：把
   * `provider-credits.ts` 里 buddy 的 `afterClaim` **实现体**换成
   * `Promise.resolve(undefined)`（字段仍在、类型仍对）⇒ **上面两条照样全绿**
   * （71 passed），而成长中心已经**静默消失**。
   *
   * 同样地，下面「runTasks:true 时 afterClaim 被调用」那条也守不住 ——
   * 它注入的是**本文件自己的桩** `afterClaim`，把生产实现整个换掉它也绿。
   * 那是它该有的样子（它守的是**骨架有没有调这个接缝**），
   * 但「**生产闭包里到底接了什么**」于是成了零覆盖。
   *
   * ## 判据：真跑生产闭包，看它有没有打到成长中心的上游端点
   *
   * 不注入任何 credits 表（走 `createProviderCredits()` 的真实返回），
   * 取出 buddy 的 `afterClaim` 并**直接调用**，断言 `fetch` 收到了
   * 成长任务列表端点之一。`Promise.resolve(undefined)` 那种空实现
   * **一个请求都不会发** ⇒ 本条必红。
   *
   * ⚠️ 这里**刻意不驱动 `credits.claimAll`**：那条路要先过签到（会发签到请求）、
   * 还要真凭据形状。直接调生产闭包更贴近「接线有没有接错」这个意图，
   * 且不受签到侧变化影响。
   */
  it('★★★ 生产 afterClaim 闭包真的打到成长中心端点（空实现即红）', async () => {
    applyOnce()
    const afterClaim = runtimeOf('buddy')?.credits?.afterClaim
    expect(afterClaim, 'buddy 必须有 afterClaim').toBeTypeOf('function')

    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      // 空 body：`getGrowthJson` 会解析成失败并继续，本用例只关心**请求发出去了**。
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const entry = {
      id: 'buddy-g-1', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_GROWTH',
      nickname: 'g', enabled: true, refreshable: true,
    } as never

    await afterClaim!(
      { access_token: 'AT-G', user_id: 'u-1' } as never,
      entry,
      { budgetMs: 5_000, roundDeadlineAt: undefined },
      { resolveCredential: async () => undefined, warn: () => {}, accountPool: {} as never },
    )

    expect(
      seen.some((url) => url.includes('/activity/growth/')),
      '生产 afterClaim 没有打到成长中心端点 —— 成长中心静默消失了'
      + `（实际请求：${seen.length === 0 ? '（一个都没发）' : seen.map((u) => new URL(u).pathname).join(', ')}）`,
    ).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、端点真的查那张表（注入哨兵，硬编码分支不可能产生它）
// ─────────────────────────────────────────────────────────────────────────────

describe('★ credits.claimAll 真的查表（注入哨兵，硬编码分支不可能产生它）', () => {
  it('走注入的 credits 表：claim 收到解析出的凭据，哨兵 outcome 出现在响应里', async () => {
    const sentinel: ClaimOutcome = {
      kind: 'claimed', credit: 4242, streakDays: 0, isStreakDay: false,
    }
    const seen: unknown[] = []
    const { call, pool, credentials } = makeRpc({
      codearts: {
        claim: async (credential) => { seen.push(credential); return sentinel },
        precheckStatus: false,
      },
    })
    await seed(pool, 'codearts', 'ca-1', 'CODEARTS_ACCOUNT_SPEC')
    await credentials.set('CODEARTS_ACCOUNT_SPEC', JSON.stringify({ access_key_id: 'AK', secret_access_key: 'SK' }))
    // 任何真实网络请求都应让本用例失败：查表分派不该碰上游。
    vi.stubGlobal('fetch', async () => { throw new Error('查表分派不得发网络请求') })

    const result = await call('credits.claimAll', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    expect(result.value.results).toHaveLength(1)
    expect(
      result.value.results[0]?.outcome?.credit,
      '注入的 credits 表没有生效 —— 说明端点仍在走硬编码分支（没查表）',
    ).toBe(4242)
    // ⚠️ 哨兵还必须证明**凭据真的解析后传进去了**（不是空对象）。
    expect(seen[0]).toEqual({ access_key_id: 'AK', secret_access_key: 'SK' })
  })

  /**
   * ★★ **本 Task 最容易丢的功能**：成长中心与签到**共用同一趟逐账号循环**。
   *
   * 用哨兵证明：① `runTasks: true` 时 `afterClaim` 真的被调用；② 它拿到的
   * `budgetMs` 是**请求里那个值**（`types.ts` 明文契约「原样透传」），
   * 不是恒 `undefined`。
   */
  it('★★ runTasks:true 时 afterClaim 被调用，且 budgetMs 原样透传（成长中心不许静默消失）', async () => {
    const runs: { budgetMs: number | undefined; roundDeadlineAt: number | undefined }[] = []
    const { call, pool, credentials } = makeRpc({
      buddy: {
        claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
        afterClaim: async (credential, entry, run) => {
          runs.push({ budgetMs: run.budgetMs, roundDeadlineAt: run.roundDeadlineAt })
          return { accountId: entry.id, nickname: entry.nickname, ok: true, completed: 0, clientOnly: 0, failed: 0, claimedCount: 0, claimedCredit: 0, timedOut: false, tasks: [] }
        },
      },
    })
    await seed(pool, 'buddy', 'b-1', 'BUDDY_ACCOUNT_SPEC')
    await credentials.set('BUDDY_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-B' }))
    vi.stubGlobal('fetch', async () => { throw new Error('哨兵表不该发网络请求') })

    const result = await call('credits.claimAll', { provider: 'buddy', runTasks: true, budgetMs: 1234 })
    expect(result.ok).toBe(true)
    expect(runs, 'afterClaim 没有被调用 —— 成长中心静默消失了').toHaveLength(1)
    expect(runs[0]?.budgetMs, 'budgetMs 没有原样透传（契约见 types.ts）').toBe(1234)
    expect(result.value.growth, 'growth 明细没有进响应').toHaveLength(1)
    expect(result.value.growth[0]?.accountId).toBe('b-1')
  })

  it('runTasks 缺省（不传）时 afterClaim **一次都不许调用**（默认关闭是刻意的）', async () => {
    let afterClaimCalls = 0
    const { call, pool, credentials } = makeRpc({
      buddy: {
        claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
        afterClaim: async () => { afterClaimCalls++; return undefined },
      },
    })
    await seed(pool, 'buddy', 'b-1', 'BUDDY_ACCOUNT_SPEC')
    await credentials.set('BUDDY_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-B' }))
    vi.stubGlobal('fetch', async () => { throw new Error('哨兵表不该发网络请求') })

    await call('credits.claimAll', { provider: 'buddy' })
    // ⚠️ 成长一轮单账号实测 90~270s、任务间 1.5s 节流 —— 默认开启等于
    //    每次启动自动打几十个上游请求。
    expect(afterClaimCalls, 'runTasks 缺省时不得跑成长任务').toBe(0)
  })

  /**
   * ★ **TRAE 必须开状态预检**（真实报障：显示成功但 +0 积分）。
   *
   * 这条是**行为**断言：真跑端点，看它有没有先发状态查询。TRAE 的 claim 对
   * 「今天已签到」幂等，重复领取同样返回 `{code:0,"success"}`，与真领取无法区分。
   */
  it('★ TRAE 开启状态预检：已签到账号**不发** claim 请求（显示成功但 +0 积分的回归）', async () => {
    const claimedCalls: string[] = []
    const statusCalls: string[] = []
    const { call, pool, credentials } = makeRpc(undefined, {
      ...emptyAuths(),
      trae: {},
    })
    await seed(pool, 'trae', 't-1', 'TRAE_ACCOUNT_SPEC')
    await credentials.set('TRAE_ACCOUNT_SPEC', JSON.stringify({
      access_token: 'AT-T', uid: 'uid-1', machine_id: 'm-1',
    }))
    // ⚠️ 用真表 + 桩 fetch：状态端点回「今天已签到」，claim 端点若被调用就记下来。
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('checkin')) {
        statusCalls.push(url)
        if (url.includes('status')) {
          return new Response(JSON.stringify({ code: 0, enable: true, checked_in: true, streak_days: 3, credits: 150 }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        }
        claimedCalls.push(url)
        return new Response(JSON.stringify({ code: 0, message: 'success' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await call('credits.claimAll', { provider: 'trae' })
    expect(result.ok, `trae 应被接受，实际 error=${result.error?.message}`).toBe(true)
    expect(statusCalls.length, 'TRAE 没有先查状态 —— 已签到账号会被报成「领取成功」').toBeGreaterThan(0)
    expect(
      claimedCalls,
      'TRAE 对已签到账号仍发了 claim 请求（precheckStatus 没生效）',
    ).toEqual([])
    expect(result.value.results[0]?.outcome?.kind, '已签到必须报 already-claimed').toBe('already-claimed')
  })

  /**
   * ★ **`loomy` 走共享骨架，但绝不能走 buddy 式状态预检**。
   *
   * 它没有同构状态端点；缺省 `precheckStatus`（= true）会让骨架拿
   * `fetchCheckinStatus` 去打 Loomy 端点 —— 一次**必然失败的真实上游请求**。
   *
   * ⚠️ 判据是「骨架有没有**进入**状态查询那条路」（见 `checkinStatusCalls` 的注释）：
   * 缺省 true ⇒ 进 1 次；显式 false ⇒ 进 0 次。**不能**用「有没有发出状态请求」
   * 来判 —— 通用分支传 `product: undefined`，默认实现在访问 `product.endpoint`
   * 时就先抛错并被吞，两种取值下都不会真的发请求（假绿，实测过）。
   */
  it('★ loomy 走共享骨架但**不进入** buddy 式状态预检（precheckStatus:false 的行为证据）', async () => {
    const seen: string[] = []
    const { call, pool, credentials } = makeRpc(undefined, { ...emptyAuths(), loomy: {} })
    await seed(pool, 'loomy', 'l-1', 'LOOMY_ACCOUNT_SPEC')
    await credentials.set('LOOMY_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-L' }))
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input)
      seen.push(url)
      if (url.includes('first-login')) {
        // ⚠️ Loomy 的信封是 `{ code: '000000', desc, data }`（**字符串**码），
        //    不是 buddy 系的 `code: 0` —— 写错会让解析器判失败，用例假红。
        return new Response(JSON.stringify({
          code: '000000', desc: '成功', data: { dailyQuota: 5000, dailyBalance: 5000 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    checkinStatusCalls.count = 0
    const result = await call('credits.claimAll', { provider: 'loomy' })
    expect(result.ok, `loomy 应被接受，实际 error=${result.error?.message}`).toBe(true)
    expect(
      checkinStatusCalls.count,
      'loomy 走了 buddy 式状态预检 —— 缺省 true 时骨架会拿 fetchCheckinStatus 打 Loomy 端点'
      + '（发错端点，必然失败）',
    ).toBe(0)
    expect(
      seen.some((url) => url.includes('first-login')),
      'loomy 的签到没有打到它自己的端点',
    ).toBe(true)
    expect(result.value.results[0]?.outcome?.kind).toBe('claimed')
  })

  /**
   * ★ **反向锚点**：证明上面那条判据不是恒真的（`checkinStatusCalls` 真的会动）。
   *
   * buddy 的 `precheckStatus` 缺省为 true（它没有显式声明），故它**必须**进入
   * 状态查询。若这条也变成 0，说明计数机制本身坏了 —— 上面那条 loomy 的
   * `toBe(0)` 就成了同义反复。
   */
  it('★ 反向锚点：buddy（预检缺省 true）**必须进入**状态预检', async () => {
    const { call, pool, credentials } = makeRpc(undefined, { ...emptyAuths(), buddy: {} })
    await seed(pool, 'buddy', 'b-1', 'BUDDY_ACCOUNT_SPEC')
    await credentials.set('BUDDY_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-B' }))
    vi.stubGlobal('fetch', async () => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }))

    checkinStatusCalls.count = 0
    const result = await call('credits.claimAll', { provider: 'buddy' })
    expect(result.ok, `buddy 应被接受，实际 error=${result.error?.message}`).toBe(true)
    expect(
      checkinStatusCalls.count,
      'buddy 没有进入状态预检 —— 计数机制坏了，loomy 那条 toBe(0) 会是恒真',
    ).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、不支持签到的渠道必须保留**可读**原因（不退化成 unsupported provider）
// ─────────────────────────────────────────────────────────────────────────────

describe('★ 不支持签到的渠道：文案必须指明「该产品无此能力」', () => {
  it('cline / workbuddy / raccoon 各回**逐字保留**的可读原因', async () => {
    const { call } = makeRpc()
    const expected: Record<string, string> = {
      // cline：对整个 sidecar 做字符串扫描，无任何 checkin/campaign 端点。
      cline: 'Cline 不支持每日签到（其后端没有签到接口）',
      // ⚠️ workbuddy 这条守卫**必须有**：没有它时会落到通用分支，用**国际版**
      //    凭据去发**国内版**的签到请求 —— 必然失败，且是一次真实上游请求。
      workbuddy: 'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）',
      // raccoon：每日 300 积分由服务端自动发放；提示必须指向「新手任务」。
      raccoon: 'Raccoon Work 不支持每日签到（每日积分由服务端自动发放；登录奖励请在「新手任务」中领取）',
    }
    for (const [provider, message] of Object.entries(expected)) {
      const result = await call('credits.claimAll', { provider })
      expect(result.ok, `${provider} 应被拒`).toBe(false)
      expect(result.error?.message, `${provider} 的文案退化了`).toBe(message)
      expect(result.error?.message, `${provider} 不能退化成 unsupported provider`).not.toContain('unsupported provider')
    }
  })

  it('★ 未登记的 provider 仍回 unsupported provider（兜底契约不变）', async () => {
    const { call } = makeRpc()
    const result = await call('credits.claimAll', { provider: 'unknownprovider' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('unsupported provider: unknownprovider')
  })

  /**
   * ⚠️ **已登记但没有签到能力、也没有专属文案**的渠道（gemini / opencode /
   * aggregate）**逐字保留**旧行为：落到 `unsupported provider: X`。
   *
   * ⚠️ 这条是**故意的**「保持原样」，不是「本 Task 认可的文案」：对 gemini 说
   * 「provider 没注册」其实是**误导**（它明明在 registry 里），但把它改成
   * 「不支持每日签到」是一处**行为变更（G3 例外）**，需要人批准 —— 故本 Task
   * **不动它**，只把它钉住，免得重构顺手改掉而无人察觉。已在报告中如实登记。
   */
  it('⚠️ gemini / opencode / aggregate 保留旧的 unsupported provider 文案（本 Task 刻意不动）', async () => {
    const { call } = makeRpc()
    for (const id of ['gemini', 'opencode', 'aggregate']) {
      expect(descriptorOf(id), `${id} 应在 registry 里`).toBeDefined()
      const result = await call('credits.claimAll', { provider: id })
      expect(result.ok, id).toBe(false)
      expect(result.error?.message, `${id} 的旧行为被改动了（那需要 G3 批准）`)
        .toBe(`unsupported provider: ${id}`)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 四、onboarding.* 查表
// ─────────────────────────────────────────────────────────────────────────────

describe('★ onboarding.* 真的查表（注入哨兵）', () => {
  /**
   * ★★ **Magicrew 两站的新人奖励必须打到各自的 host**（2026-11-01 二审的**阻断项**）。
   *
   * 实测：把 `src/provider-onboarding.ts` 里
   * `magicrewintl: magicrewOnboardingOf(MAGICREW_INTL)` 改成 `(MAGICREW)`，
   * **全量 11693 条一条都不红** —— 而生产后果是国际站的新人奖励
   * 拿国际 JWT 去打国内 host（`code 2182` / 401），错误文案还写「超级麦吉」，
   * 用户完全看不出是配置问题。
   *
   * ⚠️ 判据必须是**完整 URL**（两站的 `onboarding/tasks` 路径逐字符相同，
   *    只断路径片段区分不了）；且必须断言 `fetch` 真被调用过（否则
   *    「原语提前返回」也会让 URL 断言在空数组上恒真）。
   */
  it.each([
    { provider: 'magicrew', product: MAGICREW },
    { provider: 'magicrewintl', product: MAGICREW_INTL },
  ])('★★ $provider 的新人奖励打到 $product.host', async ({ provider, product }) => {
    const ref = `${provider.toUpperCase()}_ACCOUNT_SPEC`
    const { call, pool, credentials } = makeRpc(undefined, emptyAuths())
    await seed(pool, provider, `${provider}-1`, ref)
    await credentials.set(ref, JSON.stringify({ jwt: 'JWT-SPEC', organizationCode: 'org-spec' }))

    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      // 回一个空任务表：本用例只关心**请求打到哪**，不关心解析结果。
      return new Response(
        JSON.stringify({ code: 1000, data: { participant_type: null, tasks: [] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const result = await call('onboarding.status', { provider, accountId: `${provider}-1` })
    expect(result.ok, `${provider} 应被接受，实际 error=${result.error?.message}`).toBe(true)
    expect(seen.length, `${provider} 的新人奖励一个请求都没发（表里没登记？）`).toBeGreaterThan(0)
    expect(seen[0], `${provider} 的新人奖励打到了别的站（国际站打国内 host 会 401/2182）`)
      .toBe(`${product.host}/api/v1/onboarding/tasks`)
  })

  it('onboarding.status 走注入的表：哨兵读数出现在响应里', async () => {
    const { call, pool, credentials } = makeRpc(undefined, {
      ...emptyAuths(),
      loomy: {
        fetchOnboardingTasks: async () => ({
          tasks: { sentinel: true }, earned: 4242, total: 10_000,
        }),
      },
    })
    await seed(pool, 'loomy', 'l-1', 'LOOMY_ACCOUNT_SPEC')
    await credentials.set('LOOMY_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-L' }))
    vi.stubGlobal('fetch', async () => { throw new Error('必须走 auths 里的实例方法') })

    const result = await call('onboarding.status', { provider: 'loomy', accountId: 'l-1' })
    expect(result.ok, `实际 error=${result.error?.message}`).toBe(true)
    expect(result.value.earned, '哨兵 4242 未出现 —— onboarding.status 没查表').toBe(4242)
    expect(result.value.tasks).toEqual({ sentinel: true })
  })

  /**
   * ⚠️ **真实缺陷回归**（用户报障）：已领过登录奖励时，UI 显示
   * 「✅ 1 个此前已完成 / 累计已领 **0** / 3000」—— **自相矛盾**。
   * `earned` 回答的是「该项目**累计**领到多少」，与「本次是否新增」无关。
   */
  it('★ raccoon 已领时 earned 报**满分**（不是 0），且金额从账单反查', async () => {
    let statusQueries = 0
    const { call, pool, credentials } = makeRpc(undefined, {
      ...emptyAuths(),
      raccoon: {
        claimLoginReward: async () => ({
          kind: 'already-claimed', message: '该账号已领取过桌面端登录奖励（每号一次）',
        }),
        fetchOnboardingStatus: async () => { statusQueries++; return { claimed: true, points: 3000 } },
      },
    })
    await seed(pool, 'raccoon', 'r-1', 'RACCOON_ACCOUNT_SPEC')
    await credentials.set('RACCOON_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-R' }))
    vi.stubGlobal('fetch', async () => { throw new Error('必须走 auths 里的实例方法') })

    const result = await call('onboarding.claim', { provider: 'raccoon', accountId: 'r-1' })
    expect(result.ok, `实际 error=${result.error?.message}`).toBe(true)
    expect(result.value.skipped).toEqual(['desktop_login_reward'])
    expect(
      result.value.earned,
      'earned 在已领分支归零了 —— UI 会显示「已完成 / 累计已领 0」这种自相矛盾的数字',
    ).toBe(3000)
    expect(result.value.total).toBe(3000)
    expect(statusQueries, '已领时的金额必须从账单反查（与 status 同一数据源）').toBe(1)
  })

  it('onboarding.status 对未登记 provider 回 unsupported provider（兜底契约不变）', async () => {
    const { call } = makeRpc()
    const result = await call('onboarding.status', { provider: 'unknownprovider', accountId: 'x' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('unsupported provider: unknownprovider')
  })

  /**
   * ⚠️ **G3-4 的行为变更，必须有用例守着**（2026-10-08 收尾轮补测）。
   *
   * 本用例是**反向验证发现的缺口**：G3-4 登记的是「loomy 的 `onboarding.claim`
   * 失败码由 `jet-hub/handler-failed` 变成 `bad-request`」，但把源码里那个
   * `code: 'bad-request'` 变异回 `'jet-hub/handler-failed'` 后，
   * 相关四份用例（本文件 / `loomy-rpc-dispatch` / `raccoon-rpc-dispatch` /
   * `jet-hub-rpc`）**全绿 190 条** —— 即该行为变更**当时零守卫**。
   *
   * 判据要点：
   * - 断言的是 `code` 而**不只是 `ok:false`**（后者两版都一样，挡不住回归）；
   * - 断言 message **是服务端原文**（旧行为下它会被降级，用户看不出是领取失败）；
   * - loomy 与 raccoon **两家都要断言 `bad-request`** —— 它们现在共用同一处
   *   `catch`，只测一家会漏掉「把统一又拆开」的回归。
   */
  it('★ claim 失败一律回 bad-request（不得降级成 handler-failed，G3-4 锁定）', async () => {
    /**
     * ⚠️ **两家委托的方法名不同**（`provider-onboarding.ts` 的 `deps` 契约）：
     * loomy 是 `claimOnboardingTasks`、raccoon 是 `claimLoginReward`。
     * 写错名字**不会报错** —— 骨架会静默回退到真实实现去打网络，本用例于是
     * 测的是别的东西（首版就踩了这个坑：loomy 桩名写成了 `claim`，
     * 结果报的是真实网络错误 `loomy: 请求失败（/onboarding/tasks）`）。
     */
    const CLAIM_DEPS = {
      loomy: { claimOnboardingTasks: async () => { throw new Error('boom-loomy') } },
      raccoon: { claimLoginReward: async () => { throw new Error('boom-raccoon') } },
    } as const

    for (const provider of ['loomy', 'raccoon'] as const) {
      const { call, pool, credentials } = makeRpc(undefined, {
        ...emptyAuths(),
        [provider]: CLAIM_DEPS[provider],
      })
      await seed(pool, provider, `${provider}-1`, `${provider.toUpperCase()}_ACCOUNT_G34`)
      await credentials.set(`${provider.toUpperCase()}_ACCOUNT_G34`, JSON.stringify({ access_token: 'AT' }))
      vi.stubGlobal('fetch', async () => { throw new Error('必须走 auths 里的实例方法') })

      const result = await call('onboarding.claim', { provider, accountId: `${provider}-1` })
      expect(result.ok, provider).toBe(false)
      expect(
        result.error?.code,
        `${provider} 的领取失败被降级成「未知故障」了 —— 用户看不出是领取失败`,
      ).toBe('bad-request')
      expect(
        result.error?.message,
        `${provider} 必须把服务端原文透出来，而不是换成固定文案`,
      ).toBe(`boom-${provider}`)
    }
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// 五、loomy 的 coversToday 语义（与旧自写循环逐条一致）
// ─────────────────────────────────────────────────────────────────────────────

describe('★ loomy 的 claim 返回 coversToday 语义与旧循环一致', () => {
  /**
   * `ClaimOutcomeCommon.coversToday` 缺省视为 `true`。`claimLoomyDailyQuota` 的
   * 三个返回分支**都没有**设它 ⇒ 一律 `true`（「今天已处理过」）—— 与旧 RPC 分支
   * 自己写的循环一致（那时 `already-claimed` 也算今天处理过）。
   *
   * ⚠️ 若将来 loomy 加了一个 `coversToday: false` 的分支（例如「活动尚未开始」
   * 与「今天已领」须区分），本用例会红，提醒把它接进 `summary.coversToday` 口径
   *（见 `auto-checkin.ts` 的逐渠道水位线判据：**不是** claimed+alreadyClaimed，
   *  而是各渠道用 `coversToday` 声明出来的 summary.coversToday）。
   */
  it('claimed 与 already-claimed 两条分支都不带 coversToday:false', async () => {
    const { claimLoomyDailyQuota } = await import('../../src/loomy-credits.js')
    const { LOOMY } = await import('../../src/loomy-product.js')
    const credential = { access_token: 'AT-L' } as never

    const claimed = await claimLoomyDailyQuota(credential, LOOMY, (async () => new Response(
      JSON.stringify({ code: '000000', desc: '成功', data: { dailyQuota: 5000, dailyBalance: 5000 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as never)
    expect(claimed.kind).toBe('claimed')
    expect(claimed.coversToday, 'claimed 分支必须视为覆盖今天').not.toBe(false)

    const already = await claimLoomyDailyQuota(credential, LOOMY, (async () => new Response(
      JSON.stringify({
        code: '000000', desc: '成功',
        data: { alreadyProcessed: true, dailyQuota: 5000, dailyBalance: 4992 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as never)
    expect(already.kind).toBe('already-claimed')
    expect(already.coversToday, 'already-claimed 分支必须视为覆盖今天（与旧循环一致）').not.toBe(false)
  })

  /**
   * ⚠️ 端到端：loomy 走共享骨架后，`summary.coversToday` 必须**计入**
   * already-claimed（旧自写循环下 auto-checkin 也是这样记账的）。
   */
  it('★ 端到端：loomy 的 already-claimed 计入 summary.coversToday', async () => {
    const { call, pool, credentials } = makeRpc(undefined, { ...emptyAuths(), loomy: {} })
    await seed(pool, 'loomy', 'l-1', 'LOOMY_ACCOUNT_SPEC')
    await credentials.set('LOOMY_ACCOUNT_SPEC', JSON.stringify({ access_token: 'AT-L' }))
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({
        code: '000000', desc: '成功',
        data: { alreadyProcessed: true, dailyQuota: 5000, dailyBalance: 4992 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    const result = await call('credits.claimAll', { provider: 'loomy' })
    expect(result.ok, `实际 error=${result.error?.message}`).toBe(true)
    expect(result.value.results[0]?.outcome?.kind).toBe('already-claimed')
    expect(
      result.value.summary.coversToday,
      'already-claimed 没有计入 coversToday —— 自动签到会当天反复重试',
    ).toBe(1)
  })
})
