/**
 * ⚠️ **能力注册表的接线**：`src/index.ts` 真的把 14 个 auth 接到了**对的** provider id 上。
 *
 * ## 与 `jet-hub-rpc-auth-wiring.spec.ts` 的分工（**别把两者合并**）
 *
 * 本 Task（Task 2）之后，`account.refresh` 的分派走的是 `registerJetHubRpc` 的
 * **`auths` 形参**（`authOf(auths, entry.provider)`），**不是**全局注册表。
 * 因此两处接线是**两件不同的事**，各有一条防线：
 *
 * | 接线 | 守卫文件 | 走什么路径 |
 * |---|---|---|
 * | `auths` 命名对象（`registerJetHubRpc` 的实参） | `jet-hub-rpc-auth-wiring.spec.ts` | 真跑 `apply()` + `account.refresh` |
 * | 能力注册表（`provider-runtime.ts` 的 Map） | **本文件** | 真跑 `apply()` + `runtimeOf(id).auth.refreshAccount` |
 *
 * ⚠️ 本文件**不是**「重复的守卫」：它覆盖的代码段（`src/index.ts` 的注册块）
 * 在 `jet-hub-rpc-auth-wiring.spec.ts` 里**零覆盖** —— 把那段的
 * `['qodercn', qoderCn]` 改成 `['qodercn', qoder]`，那一整个文件照样全绿。
 * 反之亦然。已做反向验证（见 Task 2 报告 Step 8）。
 *
 * ## 为什么注册表也要有行为守卫
 *
 * 注册表的消费点是**拿不到 `auths` 形参**的跨模块场景（Task 5 的
 * `aggregate-expiry.ts`、Task 8 的 `account-probe.ts`）。它同样会「某个 id 接错
 * 实例」—— 而症状是「中国版账号在用国际版凭据续期」这类**历史复发 6 次**的形态。
 * 表里写错一行不会有任何编译错误（两个值类型相同），故必须有行为用例。
 *
 * ## 断言方式：跑**真实 `apply()`**，逐个比对**实例身份**
 *
 * 每个 auth 都由基类构造函数 `ctx.provide('<productId>Auth', this)` 暴露，
 * 故可以从 `apply()` 建出来的 ctx 上**取回真实例**，再断言
 * `runtimeOf(id).auth` 分派到的就是它。
 *
 * ⚠️ 这比「表里写的是哪个变量名」强：它同时覆盖
 * ①表漏了一行（该 id 取不到 runtime）、②表把两个 id 接到同一个实例、
 * ③`apply()` 里注册代码块的位置错了（比如放在实例创建之前）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { apply, probeById } from '../../src/index.js'
import { clearProviderRuntimes, registeredRuntimeIds, runtimeOf } from '../../src/provider-runtime.js'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import {
  CREDITS_TABLE_EXEMPT,
  PROBE_EXEMPT,
  WRITES_RATE_LIMIT_PROVIDERS,
  expectedProviderIdsWithAuth,
  expectedProviderIdsWithProbe,
} from '../helpers/provider-sets.js'

/**
 * 14 个**可续期** provider → 它在 `ctx` 上的服务名。
 *
 * ⚠️ 两个易错点：
 * - `codearts` 的服务名是 `codeartsAuth`，但 `src/index.ts` 里的**变量名**是 `service`；
 * - `qodercn` 的服务名是 **`qodercnAuth`** —— 服务名由 `${product.id}Auth`
 *   派生，而该 id 刻意不带连字符（见 `qoder-product.ts`）。
 *
 * ⚠️ **本表是实测出来的，不是从注释推出来的**：`AGENTS.md` 与 `src/index.ts`
 * 的注释都写作 `qoderCnAuth`（驼峰），那是**错的**。本文件用真跑 `apply()` 的
 * 探针逐个取回验证过：`ctx.qoderCnAuth` 是 `undefined`，真实名是 `ctx.qodercnAuth`。
 * 该注释的错法正是本文件存在的理由：**服务名不可凭注释推断**。
 */
const AUTH_SERVICE_OF: ReadonlyArray<readonly [string, string]> = [
  ['codearts', 'codeartsAuth'],
  ['buddy', 'buddyAuth'],
  ['workbuddy', 'workbuddyAuth'],
  ['lobsterai', 'lobsteraiAuth'],
  ['qoder', 'qoderAuth'],
  ['qodercn', 'qodercnAuth'],
  ['trae', 'traeAuth'],
  ['cline', 'clineAuth'],
  ['loomy', 'loomyAuth'],
  ['raccoon', 'raccoonAuth'],
  ['minimax', 'minimaxAuth'],
  // ⚠️ 键是 **provider id** `minimaxintl`（全小写、不带连字符），值是变量
  //    `minimaxIntl` —— 服务名由 `${product.id}Auth` 派生，故 `ctx.minimaxintlAuth`
  //    才是真实服务名（按驼峰惯例拼成 `minimaxIntlAuth` 会恒 undefined）。
  ['minimaxintl', 'minimaxintlAuth'],
  ['zcode', 'zcodeAuth'],
  ['gemini', 'geminiAuth'],
  // ⚠️ officeace 的值是 **auth 服务形状的包装对象**（`src/index.ts` 的
  //    `officeaceAuthService`），不是 `Service` 子类实例 —— 但它同样以
  //    `ctx.officeaceAuth` 注册，故这里与其余渠道同列。
  ['officeace', 'officeaceAuth'],
  ['accio', 'accioAuth'],
  // astudio 的服务名 = `${product.id}Auth` = `astudioAuth`（与 `src/astudio-auth.ts`
  // 里 `declare module Context { astudioAuth }` 逐字一致）。
  ['astudio', 'astudioAuth'],
  // ⚠️ AutoClaw（智谱）：服务名由 `${product.id}Auth` 派生 ⇒ 全小写 `autoclawAuth`。
  ['autoclaw', 'autoclawAuth'],
  // ⚠️ AutoClaw 国际版（2026-10-20）：服务名同理由派生 ⇒ `autoclawintlAuth`。
  //    它必须是**独立实例的服务名** —— 若误写成 `autoclawAuth`，按 id 查表会把
  //    国际账号分派到国内实例（续期打错基址）。
  ['autoclawintl', 'autoclawintlAuth'],
  // ⚠️ **本 fork 独有**（modelscope，2026-10-16）。服务名由 `${product.id}Auth`
  //    派生 ⇒ `modelscopeAuth`。同款坑：本表由**真跑 apply() 的探针**验证过，
  //    不凭注释推断。
  ['modelscope', 'modelscopeAuth'],
  // ⚠️ **本 fork 独有**（qiniu，2026-10-29）。服务名由 `${product.id}Auth` 派生
  //    ⇒ `qiniuAuth`。同款坑：本表由**真跑 apply() 的探针**验证过，不凭注释推断。
  ['qiniu', 'qiniuAuth'],
  // ⚠️ 超级麦吉（Magicrew，2026-10-29）：服务名由 `${product.id}Auth` 派生 ⇒ `magicrewAuth`。
  ['magicrew', 'magicrewAuth'],
  // ⚠️ MagiCrew 国际版（2026-11-01）：服务名同理由派生 ⇒ `magicrewintlAuth`。
  //    它必须是**独立实例的服务名** —— 若误写成 `magicrewAuth`，按 id 查表会把
  //    国际站账号分派到国内站实例（续期打错基址 + 凭据 ref 串号）。
  //    （与 `autoclawintl` / `minimaxintl` 同型同因。）
  ['magicrewintl', 'magicrewintlAuth'],
  // ⚠️ **本 fork 独有**（MonkeyCode，2026-11-02）。服务名由 `${product.id}Auth`
  //    派生 ⇒ `monkeycodeAuth`。它是**静态 API Key 型**渠道（白泽 sk- / 网关 oma_），
  //    `refreshable` 恒 false，但 `refreshAccountCredential` 仍要做有效期对账
  //    （把凭据里的 expires_at 回写到账号池），所以必须注册 auth 实例。
  ['monkeycode', 'monkeycodeAuth'],
  // ⚠️ MonkeyCode 国际站（2026-11-02）：服务名由 `${product.id}Auth` 派生
  //    ⇒ `monkeycodeintlAuth`。与国内站是**同一个类的两个实例**，同样必须注册
  //    （有效期对账要回写池内 `expiresAt`；漏注册 = 国际站账号的过期检测静默失效）。
  ['monkeycodeintl', 'monkeycodeintlAuth'],
  // 百智云（2026-11-02）：`channel: true` 的静态 `sk-…` 渠道，服务名由
  // `${product.id}Auth` 派生 ⇒ `baizhiAuth`。`refreshable` 恒 false（无续期端点），
  // 但 `refreshAccountCredential` 要做有效期对账回写池内 `expiresAt`，
  // 所以必须注册 auth 实例（漏注册 = 注册表与 registry 漂移，本用例点名变红）。
  ['baizhi', 'baizhiAuth'],
]

/**
 * 跑一次**真实 `apply()`**。
 *
 * ⚠️ **必须先清空注册表**：`provider-runtime.ts` 的 Map 是**模块级**的，而
 * `apply()` 每次调用都会建**一批新的** auth 实例。若不清空，第二次 `apply()`
 * 的注册会因「保留先注册者」被全部跳过，`runtimeOf()` 指向的是**上一个 ctx**
 * 的实例 —— 断言会以一条**看起来莫名其妙**的方式失败。
 */
function applyOnce(): Context {
  clearProviderRuntimes()
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', new FakeCommands() as never)
  ctx.provide('llm', new FakeLlm() as never)
  ctx.provide('settings', new FakeSettings() as never)
  apply(ctx)
  return ctx
}

class FakeCredentials {
  async resolve(): Promise<undefined> { return undefined }
  async describe() { return { configured: false, writable: true } }
  async set(): Promise<void> {}
  async unset(): Promise<void> {}
}
class FakeCommands {
  register() { return () => {} }
}
class FakeLlm {
  registerConfigurableProviders() { return { replace: () => {} } }
  registerAdapter() { return { replace: () => {} } }
  async listModels(): Promise<never[]> { return [] }
}
class FakeSettings {
  register(): void {}
  describe(): Array<{ ns: string }> { return [] }
}

afterEach(() => { clearProviderRuntimes() })

describe('★ index.ts 的能力注册表接线（行为断言，替代源码文本断言）', () => {
  /**
   * ★★ **本文件的核心**：逐个 provider 驱动注册表里的续期入口，
   * 断言**恰好它自己那个**服务实例被调用。
   *
   * ⚠️ **必须逐个真调一次**才算证明身份：`runtime.auth.refreshAccount` 是
   *    `index.ts` 里包的闭包，**无法与 ctx 上的实例直接 `toBe` 比较**
   *   （闭包每次 apply 都是新的）。故做法是：给 14 个服务各装一个 spy，
   *    调**某一个** id 的 `refreshAccount`，断言**恰好**它自己的服务被调到。
   *
   * ⚠️ 这一步是**不可替代**的：只断言「refreshAccount 是函数」的版本
   *    在 `['qodercn', qoder]` 错位下**照样全绿** —— 那是同义反复。
   */
  it('14 个 auth 逐个接到**自己那个** provider id 上（错位即红，且点名是哪个）', async () => {
    const ctx = applyOnce()

    const spies = new Map<string, ReturnType<typeof vi.spyOn>>()
    for (const [provider, serviceName] of AUTH_SERVICE_OF) {
      const service = (ctx as unknown as Record<string, unknown>)[serviceName]
      expect(service, `ctx.${serviceName} 不存在：auth 服务未注册`).toBeDefined()
      spies.set(
        provider,
        vi.spyOn(service as never, 'refreshAccountCredential' as never).mockResolvedValue(undefined as never),
      )
    }

    for (const [provider] of AUTH_SERVICE_OF) {
      const runtime = runtimeOf(provider)
      expect(runtime, `provider "${provider}" 未注册到能力注册表`).toBeDefined()
      expect(runtime?.auth, `provider "${provider}" 没有 auth 域`).toBeDefined()

      for (const spy of spies.values()) spy.mockClear()
      // 传 ref / pool / id 三个实参：本用例只关心**哪个实例**被调到。
      await runtime!.auth!.refreshAccount(`${provider.toUpperCase()}_ACCOUNT_X`, {} as never, 'x-1')

      // ⚠️ 核心断言：**恰好一个**服务被调到，且就是它自己那个。
      const called = [...spies.entries()].filter(([, spy]) => spy.mock.calls.length > 0)
      expect(
        called.map(([id]) => id),
        `provider "${provider}" 的续期没有分派到它自己的实例` +
        `（实际调到了：${called.map(([id]) => id).join(',') || '无'}）`,
      ).toEqual([provider])
    }
  })

  it('★ 14 家都挂上了 `auth.refreshAll`（Task 10：漏一家 ⇒ 该家永不自动续期且日志零字）', async () => {
    // ⚠️ **为什么必须在这里断言**：`refreshTargets` 已从「手抄固定行数」改为
    //    由 `wiredRefreshTargets()` **从注册表派生**。派生函数本身由
    //    `refresh-targets-derived.spec.ts` 测；**「注册循环真的把 14 家都接上了」
    //    只能靠真跑 `apply()` 才能证明** —— 这正是本文件的职责。
    //
    // ⚠️⚠️ **遍历 `wiredRefreshTargets()` 的结果，不是手抄清单**：
    //    我第一版从 `AUTH_SERVICE_OF`（手抄 14 家）遍历，于是「漏挂一家」
    //    **照样全绿**（实测：把 gemini 从派生表里剔掉，15 passed）—— 那是
    //    **同义反复**。改为遍历**派生结果**后，漏一家会红并点名。
    const ctx = applyOnce()
    const { wiredRefreshTargets } = await import('../../src/provider-runtime.js')

    // 期望集从 `PROVIDER_REGISTRY` 派生（`channel: true` 减 `AUTH_EXEMPT`，
    // 它没有续期概念），**不手抄**。
    // ⚠️ 判据本体由 `expectedProviderIdsWithAuth()` 单一持有（Task 11-F）。
    const expected = expectedProviderIdsWithAuth().sort()

    const targets = wiredRefreshTargets()
    const wired = targets.map(([id]) => id).sort()
    expect(wired, '批量续期表与 registry 的 channel 集合不一致（漏一家 ⇒ 该家永不自动续期）')
      .toEqual(expected)

    // ⚠️ 本用例**只做键集合对拍**，不再逐个驱动 `refreshAll` —— 那部分与
    //    `refresh-targets-derived.spec.ts` 的「② 派生的条目**真的调用**该 provider
    //    的 refreshAll（转发不错位）」**重复**，而后者用**桩**注册、没有
    //    「wrapper 闭包 vs `vi.spyOn` 时序」这层测试自身的复杂性。
    //    ⚠️ 我一度在这里加了逐个驱动，结果被 spy×wrapper 的时序问题缠住
    //    （实测 `cline` 计数为 2，根因是测试自身的 spy 语义而非生产错位）
    //    ⇒ 按「一份语义一套判据」删掉重复的那半。
  })

  it('两站账号各刷各的（用真实 apply() 的实例，驱动注册表）', async () => {
    // ⚠️ 这条与上面那条**互补**：那条逐个 provider 断言「只有自己」，
    //    这条专打**同族串接**这个历史复发 6 次的形态，且同时断言
    //    「国际版那次没碰中国版」（上面的循环只断言「恰好一个」，
    //    若两个键**互换**值，上面那条会报 qoder 与 qodercn 都错，
    //    本条则把「CN 串到国际版」这个方向单独点名）。
    const ctx = applyOnce()
    const intl = ctx.qoderAuth as unknown as { refreshAccountCredential: unknown }
    const cn = ctx.qodercnAuth as unknown as { refreshAccountCredential: unknown }
    const intlSpy = vi.spyOn(intl as never, 'refreshAccountCredential' as never)
    const cnSpy = vi.spyOn(cn as never, 'refreshAccountCredential' as never)

    const runtime = runtimeOf('qodercn')
    expect(runtime?.auth).toBeDefined()
    // 传一个不会被解析到的 ref：`refreshAccountCredential` 会因凭据不存在而抛错，
    // 但**「哪个实例被调用」**这件事已经发生，正是本条要断言的。
    await runtime!.auth!.refreshAccount('QODERCN_ACCOUNT_SPEC', {} as never, 'cn-1')
      .catch(() => {})

    expect(cnSpy, '中国版账号没有分派到 qodercnAuth').toHaveBeenCalledTimes(1)
    expect(intlSpy, '中国版账号串到了国际版 qoderAuth').not.toHaveBeenCalled()
  })

  it('注册表覆盖全部可续期 provider，且**不含** opencode / aggregate / auto', () => {
    applyOnce()
    const ids = registeredRuntimeIds().sort()
    // ⚠️ **不是「恰好等于有 auth 的集合」**（2026-10-22 合并审计改）。
    //
    // 原判据隐含「**有 runtime ⇔ 有 auth**」这条假设，而 PR #3 引入了第一个反例：
    // **codely 有 `probe` 与 `credits`、但没有 auth 服务**（`channel:false`，
    // 登录/余额都是自由函数）。
    //
    // 为什么必须给它 runtime：`probe` 域**只**在「`for (const [id, auth] of registry)`
    // 循环体内」被挂上（`...Object.hasOwn(probeById, id) ? { probe: probeById[id] } : {}`），
    // 而 codely 不在那个数组里 ⇒ `runtimeOf('codely') === undefined` ⇒
    // `adapterForProbe()` 抛「codely 没有探测适配器」⇒ 用户点「重测」**必报错**。
    // ⚠️ 这与 `PROBE_EXEMPT` 文档里记的 `opencode` 那条**错误豁免**同型：
    //    「它没有 `rateLimit: false` 豁免 ⇒ 客户端『重测』按钮会渲染 ⇒ 用户点了
    //    必报『没有探测适配器』」⇒ 正确修法是**让 probe 可达**，
    //    **不是**把 codely 塞进 `PROBE_EXEMPT`。
    //
    // ⇒ 判据：**有 auth 的必须有 runtime**（原意图不放宽）+ `probeById` 的那些也允许有；
    //   `opencode` / `aggregate` / `auto` 仍不得有（下面三条不变）。
    const authIds = AUTH_SERVICE_OF.map(([id]) => id).sort()
    for (const id of authIds) {
      expect(ids, `有 auth 的 ${id} 必须有 runtime`).toContain(id)
    }
    // ⚠️ **额外允许的、无 auth 但有 probe 的家**（本仓当前**只有 codely**）。
    //
    // 为什么必须给它 runtime：`probe` 域**只**在上面那个
    // `for (const [id, auth] of registry)` 循环体内被挂上，而 codely 不在那个
    // 数组里（`channel:false`、无 auth 服务）⇒ `runtimeOf('codely') === undefined`
    // ⇒ `adapterForProbe()` 抛「codely 没有探测适配器」⇒ 用户点「重测」**必报错**。
    //
    // ⚠️ 这与 `PROBE_EXEMPT` 文档里记的 `opencode` 那条**错误豁免**同型
    //   （「没有 `rateLimit: false` 豁免 ⇒ 『重测』按钮会渲染 ⇒ 用户点了必报
    //   『没有探测适配器』」）⇒ 正确修法是**让 probe 可达**，不是塞进豁免表。
    //
    // ⚠️ **刻意不含 `opencode`**：它虽然也在 `probeById` 里且无 runtime，
    //   但那是**存量缺陷**（master 上就如此），修它会牵动另一批守卫，不在本次
    //   范围内 ⇒ 下面仍显式断言它不得有 runtime，把这条缺口**如实留在这里**。
    const PROBE_ONLY_NO_AUTH = ['codely']
    expect(ids).toEqual([...new Set([...authIds, ...PROBE_ONLY_NO_AUTH])].sort())
    // opencode 凭据是静态 API key，没有续期概念 ⇒ 刻意不注册（见设计文档 §3.3）。
    expect(ids).not.toContain('opencode')
    // aggregate / auto 是虚拟 provider，无账号无凭据。
    expect(ids).not.toContain('aggregate')
    expect(ids).not.toContain('auto')
  })

  /**
   * ★ **`credits` 域真的挂上了**（Task 3）。
   *
   * ⚠️ 判据从 `PROVIDER_REGISTRY` **派生**，不手写清单：手写清单漏一家会静默
   * 丢掉那家的覆盖，而全量测试照样全绿（Task 2 复审 Finding I-1 的教训）。
   *
   * 守的失效形态：`src/index.ts` 的 `registerProviderRuntime({ … })` 里
   * **漏掉 `credits:` 那一行** ⇒ `runtimeOf(id).credits` 恒为 `undefined`，
   * 于是 Task 5 的 `aggregate-expiry.ts` / Task 8 的 `account-probe.ts`
   * 拿到的是「该渠道不支持积分」—— 而它明明支持。这与 `auth` 域那条守卫同型
   *（都是「注册清单漏了一个域」），故必须真跑 `apply()` 才有牙。
   *
   * ⚠️ 例外是**形态不匹配的特例**（`provider-credits.ts` 文件头）：
   *    opencode（本地派生的通道可用性、零网络）与 qoder 系（只吃
   *    `QoderCredential`）**刻意不在**积分表里 —— 它们的 `credits` 如实为
   *    `undefined`，由 `credits.balances` 里的特例分支短路。
   *
   * ⚠️ 2026-10-08（Task 11-F）：特例表改读 `CREDITS_TABLE_EXEMPT` 单一真源
   *（原先这里与 `credits-runtime-parity.spec.ts` 的两处各硬编码了一遍
   * `new Set(['opencode', 'qoder', 'qodercn'])`）。
   */
  it('★ 每个有余额能力的渠道都挂上了 credits 域（漏接即红并点名）', () => {
    applyOnce()
    for (const d of PROVIDER_REGISTRY) {
      const runtime = runtimeOf(d.id)
      if (runtime === undefined) continue // 非 channel provider（aggregate）不在此表
      // ⚠️ 2026-10-29 **本 fork**：`qiniu`（七牛云）是全仓首例
      //    「`channel: true` 且 `credits.balance: false`」—— 七牛云**没有**
      //    余额/额度 REST 端点（用量与计费只在控制台可见），故它如实不声明
      //    余额能力、`src/index.ts` 也不给它挂 `credits:` 域。
      //    ⇒ 本循环的语义严格按**本条用例的名字**取「有余额能力的渠道」：
      //    `balance !== true` 的家不做「必须挂 credits」的断言（挂了反而错）。
      //    ⚠️ 这条 `continue` **不削弱**守卫：原判据 `runtime !== undefined`
      //    对 `aggregate` 之外的家恒真，也就等于「凡注册了 runtime 就必须有
      //    credits」—— 那是把「有余额能力」错当成了「有 runtime」；
      //    `qiniu` 一进来就把它照出来了（它注册 runtime 但确实没有余额端点）。
      if (d.credits.balance !== true) continue
      if (CREDITS_TABLE_EXEMPT.has(d.id)) {
        expect(
          runtime.credits,
          `${d.id} 是形态不匹配的特例，不该进积分表（它的余额由特例分支短路）`,
        ).toBeUndefined()
        continue
      }
      expect(
        runtime.credits,
        `${d.id} 声明了 balance:${String(d.credits.balance)}，但 runtime 上没有 credits 域 —— `
        + '`src/index.ts` 的 registerProviderRuntime 漏了 `credits:` 那一行',
      ).toBeDefined()
      expect(
        runtime.credits?.fetchBalance !== undefined || runtime.credits?.fetchBalanceDetailed !== undefined,
        `${d.id} 的 credits 域没有任何余额方法`,
      ).toBe(true)
    }
  })

  /**
   * ⚠️ **本条的证明力来自「引用同一性」**：`descriptorOf(id)` 返回的是
   * `PROVIDER_REGISTRY` 里那个**冻结的同一个对象**。断言 `toBe` 而不是
   * `toEqual`，故它同时证明「注册段没有另造一份 descriptor」——
   * 那正是「改 registry 不生效」这类静默失效的形态（Task 1b 的主题）。
   */
  it('每个注册项都带**同源**的 descriptor（消费方无需二次查 registry）', () => {
    applyOnce()
    for (const [provider] of AUTH_SERVICE_OF) {
      const runtime = runtimeOf(provider)
      expect(runtime?.descriptor, provider).toBe(descriptorOf(provider))
    }
  })

  /**
   * ⚠️ 这条守的是**生产**语义，不是测试便利：宿主重启插件 fiber 时新 apply 与
   * 旧 dispose 交错，第二次注册必然发生。抛错会让整个插件加载失败
   *（`llm-register-compat.ts` 模块头记录的实测事故）。
   *
   * ⚠️ **不清空注册表**地再跑一次 `apply()`：这正是竞态的形状 ——
   *    `applyOnce()` 会先 clear，那就不叫重复注册了。
   */
  it('重复 apply() 不抛错（fiber 重启竞态：保留先注册者、跳过本次）', () => {
    const first = applyOnce()
    const firstBuddy = first.buddyAuth
    expect(firstBuddy).toBeDefined()
    expect(runtimeOf('buddy')?.auth).toBeDefined()

    // 第二个 ctx 同样要备齐服务替身，否则抛的是
    // `Cannot read properties of undefined (reading 'registerAdapter')`
    //（与注册表无关的另一类失败），会把这条用例变成**测不到目标**的假绿。
    const second = new Context()
    second.provide('credentials', new FakeCredentials() as never)
    second.provide('commands', new FakeCommands() as never)
    second.provide('llm', new FakeLlm() as never)
    second.provide('settings', new FakeSettings() as never)
    expect(() => apply(second)).not.toThrow()

    // ⚠️ 保留的是**先注册者**（第一个 ctx 的实例），不是后来者 ——
    //    这正是「先注册者静默失效」不会发生的那一半证据。
    expect(runtimeOf('buddy')?.descriptor).toBe(descriptorOf('buddy'))
    expect(second.buddyAuth).not.toBe(firstBuddy)
    // 第二次 apply 的实例**确实**建出来了（否则上面那条 `not.toBe` 是同义反复）。
    expect(second.buddyAuth).toBeDefined()
  })

  /**
   * ⚠️ `src/index.ts` 对缺失声明只记 `warn` 并 `continue`（不抛错），
   * 故「清单里写了一个 registry 没有的 id」会**静默少一个 provider**。
   * 这条把它变成红的。
   */
  it('注册清单里的每个 id 都在 registry 里有声明（防清单与 registry 漂移）', () => {
    applyOnce()
    const declared = new Set(PROVIDER_REGISTRY.map((d) => d.id))
    for (const [provider] of AUTH_SERVICE_OF) {
      expect(declared.has(provider), `registry 缺少声明：${provider}`).toBe(true)
    }
    // 反方向：registry 里**该有 auth 服务**的 provider 一个都不能漏进注册表。
    //
    // ⚠️ 判据用 `channel`（「有没有账号 / 凭据 / 积分」）**减去一个显式豁免**，
    //    而**不用** `settingsNamespace`：那个字段虽然恰好能筛出同样 13 个 id，
    //    但它是**巧合而非语义**（它表示老契约 settings namespace；opencode 恰好
    //    是唯一没有它的 `channel` provider）—— 本仓库 AGENTS.md 明确反对用
    //    巧合字段推断语义（原话见 `jet-hub-rpc-auth-wiring.spec.ts` 的
    //    `AUTH_EXEMPT` 注释）。用巧合字段的代价是：哪天给 opencode 补一个
    //    namespace，这条会**静默**把 opencode 算进「该注册」而红得莫名其妙。
    //
    // ⚠️ 豁免**只有** opencode 一个，且理由与上面三条 `not.toContain` **不同**：
    //    那三条断言「注册表里没有它」，这条断言「它**本来就不该有**」——
    //    前者可能因为清单漏写而通过，后者才把「漏写」变成红的。
    // ⚠️ 判据本体由 `expectedProviderIdsWithAuth()` 单一持有（Task 11-F）。
    const shouldRegister = expectedProviderIdsWithAuth().sort()
    // ⚠️ 2026-10-13 合并：officeace 与 accio **同一次**并入，故 13 → 15。
    // ⚠️ 2026-10-15 加 minimaxintl（MiniMax Code 国际版）：15 → 16。
    // ⚠️ 2026-10-16 并入 astudio：16 → 17。
    // ⚠️ 2026-10-17 加 autoclaw（第 18）：17 → 18；
    //    同日 **本 fork** 并入 modelscope（魔搭）：18 → 19；
    //    再加 astudio（本 fork 与上游各登记一次）⇒ 19 → 20 个真渠道，
    //    减去 AUTH_EXEMPT 两项（opencode / aggregate）⇒ 19 个 auth 键。
    // ⚠️ 2026-10-20 加 autoclawintl（AutoClaw 国际版）：19 → 20 个 auth 键。
    // ⚠️ 2026-10-22（A6）：codely 翻 `channel: true`：20 → 21。
    // ⚠️ 2026-10-29 加 qiniu（七牛云）+ magicrew：21 → 22 → 23 个 auth 键。
    // ⚠️ 2026-11-01 加 magicrewintl（MagiCrew 国际版）：23 → 24 个 auth 键。
    // ⚠️ 2026-11-02 加 monkeycode（MonkeyCode）：24 → 25 个 auth 键。
    //    它有 auth 实例（`MonkeycodeAuth`，静态 Key 无续期、但仍做有效期对账），
    //    故只需登记 `AUTH_SERVICE_OF`，不需动 `AUTH_EXEMPT`。
    // ⚠️ 2026-11-02 加 monkeycodeintl：25 → 26 个 auth 键。
    // 2026-11-02: baizhi 接入后 26 -> 27。
    expect(shouldRegister, 'channel 集合变了，请复核 opencode 豁免是否仍成立').toHaveLength(27)
    expect(
      registeredRuntimeIds().sort(),
      'registry 里有账号的 provider 必须都注册进能力注册表（左侧多出 = 清单里多了僵尸项，' +
      '右侧多出 = registry 里有而清单漏登记）',
    // ⚠️ **`shouldRegister` 是「有 auth 的家」，而 codely 无 auth 却有 runtime**
    //   （2026-10-22 合并审计修：`probe` 域只在那唯一一个循环里挂，codely 不在
    //   那个 `registry` 数组里 ⇒ `runtimeOf('codely') === undefined` ⇒ 用户点
    //   「重测」必报「codely 没有探测适配器」）。⇒ 反向断言同样要把它算进来，
    //   否则「修好了」这件事本身会让本条变红。理由与上面那条用例同源。
    // ⚠️ 2026-10-22（A6）：codely 现已翻 `channel: true` 并接入 auth ⇒ 它**已在**
    //    `shouldRegister` 里，不得再额外加 `'codely'`（会重复。旧写法是它当时
    //    无 auth 却有 runtime 的补丁；现在两者同源）。
    ).toEqual([...shouldRegister].sort())
  })
})

/**
 * ★ **`probe` 域的接线**（Task 8 复审补齐 —— 此前本域**零守卫**）。
 *
 * ## 为什么单独要一段
 *
 * Task 8 把「重测用的探测适配器」从 `account-probe.ts` 的 `else if` 链搬到了
 * `src/index.ts` 的 `probeById` 表。那次搬迁**漏了 `opencode`**，而没有任何用例
 * 变红 —— 因为 probe 域当时**一条守卫都没有**：其它四个域（auth / credits /
 * onboarding / expiry）都有真跑 `apply()` 的 parity 用例，只有 probe 没有。
 *
 * ⇒ 该缺口是**用户可见**的：`opencode` 没有 `rateLimit: false` 豁免，
 * 客户端「重测」按钮由 `supportsRateLimit`（缺省 `true`）门控 ⇒ 按钮会渲染 ⇒
 * 用户点了会拿到「没有探测适配器」。
 */
describe('★ index.ts 的 probe 域接线（Task 8 复审补齐：此前零守卫）', () => {
  /**
   * 由文件里的写点反推 provider（**明确登记**，改动写点时必须同步）。
   *
   * ⚠️ `providers` 留 `[]` 表示「**该文件不写限流标记**」—— 这是一个**被验证的声明**
   * （见下面「登记为不写标记的文件确实没有写点」那条用例），不是偷懒的占位。
   * 将来该文件真的加了写点，那条用例会红并要求填上 provider。
   */
  const WRITE_SITE_FILES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['buddy-adapter.ts', ['buddy', 'workbuddy']],
    ['lobsterai-adapter.ts', ['lobsterai']],
    ['qoder-adapter.ts', ['qoder', 'qodercn']],
    ['cline-adapter.ts', ['cline']],
    ['zcode-adapter.ts', ['zcode']],
    ['trae-adapter.ts', ['trae']],
    ['gemini-adapter.ts', ['gemini']],
    ['llm-adapter.ts', ['codearts']],
    ['loomy-adapter.ts', ['loomy']],
    ['raccoon-adapter.ts', ['raccoon']],
    // opencode 的写点是**注入式**的：`index.ts` 把 `markLimited` 传给
    // `registerOpencodeLlm`，适配器内部 3 处调它（不是自己调 `updateModelRateLimit`）。
    ['opencode-adapter.ts', ['opencode']],
    // ⚠️ **本 fork 独有**（modelscope，2026-10-16）：它**会写** `modelRateLimits`
    //    —— 见 `modelscope-adapter.ts` 的 `modelscopeRetryAfterMs`（429 指数退避 /
    //    额度耗尽对齐 UTC+8 零点），与 registry 里**省略 `rateLimit`（= true）** 自洽。
    ['modelscope-adapter.ts', ['modelscope']],
    // ⚠️ **本 fork 独有**（qiniu，2026-10-29）：它会写 `modelRateLimits`
    //    （`qiniu-adapter.ts` 的 `qiniuRetryAfterMs`：429 指数退避 / 额度类对齐
    //    UTC+8 次日零点）⇒ 与 registry 里**省略 `rateLimit`（= true）**自洽。
    ['qiniu-adapter.ts', ['qiniu']],
    // ⚠️ minimax **曾经**登记为空（不写标记）—— 2026-10-11 的 issue IKJW32 给它
    //    接上请求级换号 + 冷却后，它会写 `modelRateLimits`（额度 24h / 限流 1h）。
    //    下面那条「登记为不写标记的确实没有写点」用例就是靠这个变化**红**出来的。
    //    ⚠️ 2026-10-15：国际版与它**共用同一个适配器类** ⇒ 同样会写标记，
    //    故两个 id 并列在这一行（漏一个都会让该站的限流标记清不掉）。
    ['minimax-adapter.ts', ['minimax', 'minimaxintl']],
    // ↓ 实测不写标记的（登记它们是为了让「每个 *-adapter.ts 都要登记」成立）。
    ['aggregate-adapter.ts', []],
    ['auto-adapter.ts', []],
    // ⚠️ officeace **不写** `modelRateLimits`（registry 里 `rateLimit: false`）：
    //    限流由华为云 MaaS 侧按账号配额管理，本地标记清掉、重测通过也恢复不了配额
    //    （与 gemini / loomy 同因）。登记为空是**被验证的声明**，不是「忘了接」。
    ['officeace-adapter.ts', []],
    // ⚠️ autoclaw（AutoClaw 智谱）**同样不写** `modelRateLimits`：本 PR 只实现
    // 目录 / 解析 / 流式，请求级换号与冷却不在范围内（registry 里
    // `rateLimit: false`，与 accio 同形）。登记为空是**被验证的声明**，不是
    // 「忘了接」—— 下面那条用例会真去 grep 源码确认确实没有写点。
    ['autoclaw-adapter.ts', []],
    // accio（Accio 阿里）**会写** `modelRateLimits`：2026-10-18 的 issue IKM3ZV
    //    给它接上请求级换号 + 冷却后（额度至 UTC+8 当日 24:00 / 限流 1h）。
    //    ⚠️ 它**曾**登记为 `[]`（不写标记）—— 下面那条「登记为不写标记的确实没有
    //    写点」用例就是靠这个变化**红**出来的，与 minimax 2026-10-11 那次同型。
    ['accio-adapter.ts', ['accio']],
    // ⚠️ astudio **不写** `modelRateLimits`（`astudio-adapter.ts` 实测零处
    //    `markLimited` / `updateModelRateLimit`）：限流与额度由讯飞 MAAS 侧按账号
    //    配额管理，本地标记清不掉配额（与 officeace 同因）。留空是**被验证的声明**。
    ['astudio-adapter.ts', []],
    // ⚠️ codely（Unity 团结引擎）**会写** `modelRateLimits`（2026-10-20）：
    //    ① 推理改为 HTTP 自签直连（签名已还原，`codely-sign.ts`）⇒ 真会收到
    //       上游的 402 预算耗尽 / 429 限流响应；
    //    ② 同日接上请求级换号 + 冷却（额度耗尽 → UTC+8 次日 0 点、429 → 1h）
    //       ⇒ 它**确实是**写点文件，必须登记并与 `WRITES_RATE_LIMIT_PROVIDERS`
    //       / `probeById` 三处同步（否则标记写进去永远清不掉）。
    //    ⚠️ 它**曾**登记为 `[]`（不写标记）—— 这个变化正是下面那条
    //    「登记为不写标记的确实没有写点」用例**红**出来的，与 minimax 2026-10-11、
    //    accio 2026-10-18 两次同型。用户报障「用完积分怎么不自动切账号」即由此而来。
    ['codely-adapter.ts', ['codely']],
    // ⚠️ **本 fork 独有**（MonkeyCode，2026-11-02）：它会写 `modelRateLimits`
    //    （`monkeycode-adapter.ts` 的 `markLimited` 里直接调
    //    `pool.updateModelRateLimit`：额度 24h / 429 1h）⇒ 与 registry 里
    //    **省略 `rateLimit`（= true）** 自洽，且必须同时进
    //    `WRITES_RATE_LIMIT_PROVIDERS` 与 `probeById`（否则标记永远清不掉）。
    // ⚠️ 2026-11-02 拆站后同一个 adapter 服务两站（同一份 `markLimited` 实现、
    //    同一套 `pool.updateModelRateLimit` 调用）⇒ 两站都要登记，漏一家即红。
    ['monkeycode-adapter.ts', ['monkeycode', 'monkeycodeintl']],
    // ⚠️ 超级麦吉（Magicrew，2026-10-29）**不写** `modelRateLimits`：
    //    本家没有请求级换号/冷却（单账号直连，key 由 `MagicrewAuth` 续期管理）
    //    ⇒ 留空是**被验证的声明**（下面那条「登记为不写的确实没有写点」会真跑）。
    ['magicrew-adapter.ts', []],
    // ⚠️ 百智云（`baizhi`，2026-11-02）**会写** `modelRateLimits`：
    //    `baizhi-adapter.ts` 在 429 / 402 时调注入的 `markLimited`（未注入时回退
    //    `accountPool.updateModelRateLimit`；额度耗尽对齐 UTC+8 次日零点）⇒ 与
    //    registry 里**省略 `rateLimit`（= true）**自洽，且必须同时进
    //    `WRITES_RATE_LIMIT_PROVIDERS` 与 `probeById`（否则标记永远清不掉）。
    ['baizhi-adapter.ts', ['baizhi']],
  ]

  /**
   * ⚠️ 写点判据：**先剥注释**，再匹配**调用形**。
   *
   * 原先的实现是 `/markLimited|updateModelRateLimit\(/.test(text)` —— 有**两个**漏洞
   * （2026-10-12 对抗性审计实测）：
   *
   * 1. **纯存在性**：**注释**或**类型声明**里出现 `markLimited` 即可满足 ⇒
   *    删掉全部真实调用（只留类型声明）仍判「有写点」⇒ 守卫不红。实测
   *    `opencode-adapter.ts` 的类型声明 `markLimited?: (slotId…) => …` 单独即可命中。
   * 2. **不剥注释**：本仓确实有注释里写 `updateModelRateLimit(...)` 的先例
   *    （`trae-errors.ts`、`index.ts`），实测 `cline-adapter.ts` 的注释里也有
   *    `markLimited` ⇒ 删掉调用照样命中。
   *
   * ⇒ 现改为：剥注释 → 匹配**调用形**（`.markLimited?.(` 注入式调用 /
   * `await markLimited(` 本地包装的调用点 / `updateModelRateLimit(` 直接调用）。
   *
   * ⚠️ **残余缺口（如实登记，正则判不了）**：若某文件用一个**本地包装函数**
   * （如 cline 的 `markLimited`），而它的**定义体**里调 `updateModelRateLimit`，
   * 那么把**所有调用点**删掉后判据**仍会命中定义体** ⇒ 不红。实测
   * `cline-adapter.ts` 正是此形态（定义体在 L763 调 `updateModelRateLimit`，
   * 另有 2 处 `await markLimited()`）。
   * 判「那段代码是否可达」需要**控制流分析**，不是正则能做到的。
   * ⇒ 这条缺口应由**行为用例**兜（真实 adapter + 限流响应 + 断言池被写入）。
   */
  // ⚠️ 2026-11-02 扩一条分支：`baizhi-adapter.ts` 把写点包成了成员方法
  //    `await this.markLimited(...)`（定义体是 `private async markLimited(`，
  //    没有 `await ` 前缀，不会误命中）⇒ 原来的两条都够不着它，派生集合
  //    比清单少一家。判据仍是「调用形」，只是多认一种本地包装。
  const WRITE_SITE_PATTERN = /\.markLimited\?\.\(|await\s+(?:this\.)?markLimited\(|updateModelRateLimit\(/

  /** 剥掉块注释与行注释（避免「注释满足正则」的假绿）。 */
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('会写 modelRateLimits 的家 == 硬编码清单（漏一家即红）', () => {
    // ⚠️ 这是**派生**而不是「断言源码含某字符串」：扫出来的集合与清单**双向**比对。
    // 有人加了写点却忘更新清单 ⇒ 左侧多出 ⇒ 红；清单写了不存在的家 ⇒ 右侧多出 ⇒ 红。
    const derived = new Set<string>()
    for (const [file, providers] of WRITE_SITE_FILES) {
      const text = stripComments(readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8'))
      if (WRITE_SITE_PATTERN.test(text)) for (const p of providers) derived.add(p)
    }
    expect(
      [...derived].sort(),
      'WRITES_RATE_LIMIT_PROVIDERS 与源码写点漂移了：'
      + '左侧多出 = 该家会写标记却没进清单（probe 守卫会漏判它），'
      + '右侧多出 = 清单里写了一家已经不写标记的',
    ).toEqual([...WRITES_RATE_LIMIT_PROVIDERS].sort())
  })

  /**
   * ★★ 清单必须覆盖 `src/` 下**全部** `*-adapter.ts`。
   *
   * ## ⚠️ 为什么需要这一条（真实缺口，2026-10-12 审计 + 变异实测）
   *
   * 上一条用例只能发现「**已登记文件**里的写点变化」。若新增 provider 并带自己的
   * `foo-adapter.ts`（含写点）而**两处清单都忘了加**，则 `derived` 与
   * `WRITES_RATE_LIMIT_PROVIDERS` **两侧同时缺失** ⇒ 等式仍成立 ⇒ **全绿**。
   * 实测：新建含 `updateModelRateLimit(` 的 `src/foo-adapter.ts` 且不登记任何清单，
   * 该 spec **12 passed 全绿**。
   *
   * ⇒ 把「**文件维度**」纳入判据：清单必须覆盖 `src/` 下的全部 `*-adapter.ts`。
   * 失败方向因此变成**安全**的一侧：忘登记 ⇒ 红。
   */
  it('★★ src 下每个 *-adapter.ts 都在 WRITE_SITE_FILES 里（新文件漏登记即红）', async () => {
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(new URL('../../src/', import.meta.url))
      .filter((name) => name.endsWith('-adapter.ts'))
      .sort()
    expect(
      files,
      '有 adapter 文件没登记进 WRITE_SITE_FILES：新增 provider 时若两处清单都忘，'
      + '上面那条用例两侧同时缺失、会**静默通过**。'
      + '请登记它 —— 若它确实不写限流标记，就把 providers 留空（那是一个会被验证的声明）。',
    ).toEqual(WRITE_SITE_FILES.map(([file]) => file).sort())
  })

  /**
   * ★ 登记为「不写标记」（`providers` 为空）的文件，**必须真的没有写点**。
   *
   * 否则「空 providers」会变成新的盲区：将来给 minimax 加了写点，上一条用例仍绿
   *（文件已登记），而第一条用例也仍绿（providers 为空 ⇒ 不进 derived）。
   */
  it('★ 登记为「不写标记」的 adapter 确实没有写点', () => {
    for (const [file, providers] of WRITE_SITE_FILES) {
      if (providers.length > 0) continue
      const text = stripComments(readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8'))
      expect(
        WRITE_SITE_PATTERN.test(text),
        `${file} 登记为「不写标记」，但剥注释后源码里有写点调用 —— `
        + '请把它的 provider 填进 WRITE_SITE_FILES 并同步 WRITES_RATE_LIMIT_PROVIDERS',
      ).toBe(false)
    }
  })

  it('probeById 恰好登记「会写标记 − PROBE_EXEMPT」的那些家', () => {
    const expected = expectedProviderIdsWithProbe().sort()
    expect(
      Object.keys(probeById).sort(),
      'probeById 与期望集合不一致：'
      + '左侧多出 = 多注册了一家（要同时给出凭据形状与探测量），'
      + '右侧多出 = **漏挂**（该家限流标记将永远清不掉，且用户点「重测」会报错）',
    ).toEqual(expected)
  })

  it('豁免表里的每一家都确实会写标记（防「用不写标记」当借口重新引入漏挂）', () => {
    // ⚠️ 这条正是本次缺陷的形态：原注释把 `opencode` 写成「不写标记，故不需要」——
    //    那是**事实错误**。只要它进了豁免表，就必须同时出现在「会写标记」清单里，
    //    否则说明有人在用「它不写」当豁免理由。
    for (const id of PROBE_EXEMPT.keys()) {
      expect(
        WRITES_RATE_LIMIT_PROVIDERS.includes(id),
        `${id} 在 PROBE_EXEMPT 里，但它不在 WRITES_RATE_LIMIT_PROVIDERS —— `
        + '若它确实不写 modelRateLimits，那它就**不需要 probe、也不该进豁免表**，'
        + '应直接从两张表里都删掉（豁免表只登记「会写但拿不到探测材料」的家）',
      ).toBe(true)
      // 且它**不得**同时在 probeById 里（否则豁免表是僵尸项）。
      const runtime = runtimeOf(id)
      expect(runtime?.probe, `${id} 既在豁免表又在 probe 注册里，二者矛盾`).toBeUndefined()
    }
  })

  it('豁免理由不是空的（防止为「凑齐」而加无名豁免）', () => {
    for (const [id, reason] of PROBE_EXEMPT) {
      expect(reason.length, `${id} 的豁免理由太短，写清「为什么拿不到探测材料」`).toBeGreaterThan(30)
    }
    // ⚠️ 2026-10-08 第二轮：`opencode` 的豁免已**证伪并撤销**（理由见
    // `provider-sets.ts` 的 `PROBE_EXEMPT` 文档），故现在是 **0**。
    // 这条数字断言的意义是「豁免表变动时必须回来复核本段是否仍成立」——
    // 若将来真要新加豁免，改这里的同时**必须**给出可复现的核对步骤。
    expect(PROBE_EXEMPT.size, '豁免表新增成员时必须复核本段的用例是否仍成立').toBe(0)
  })

  /**
   * ★★ **`probeById.minimax` 的真实工厂产出**（issue IKJW32 审计补齐）。
   *
   * ## 为什么必须用**真实**适配器
   *
   * `tests/unit/account-probe-adapter.spec.ts` 用的是 `vi.mock` 的**桩**适配器：
   * 它只记录 `{ product, credentialRef }`、`stream()` 直接抛错、**完全不读凭据** ——
   * 于是「工厂把传入的凭据真的接到了请求上」这件事**零覆盖**：把
   * `resolveCredential: async () => credential as MinimaxCredential` 删掉，
   * 那两个文件**全绿**，而生产上 minimax 的「重测 / 重置」会恒返回
   * `无法确认：minimax: no usable credential; log in first`、24h 标记永远清不掉。
   *
   * ## 同时锁住第二条不变量：探测**不写任何状态**
   *
   * 探测失败若写回 `modelRateLimits`，用户点一次「重测」就会把该账号该模型
   * **封 24h**（quota）/ 1h（rate），而探测路径没有任何回滚 ⇒ 纯污染账号池
   *（本家接上换号之前没有这个后果，是 IKJW32 才引入的风险面）。
   */
  it('★★ probeById.minimax 用真实适配器：凭据接通、且无池时不换号不写标记', async () => {
    const { MINIMAX } = await import('../../src/minimax-product.js')
    const calls: Array<{ url: string; auth: string | null }> = []
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') })
      return new Response(
        '{"type":"error","error":{"type":"insufficient_balance_error","message":"insufficient balance"}}',
        { status: 402, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch)
    try {
      const credential = { access_token: 'tok-probe-minimax', token_type: 'Bearer' }
      const adapter = probeById['minimax']!.createProbeAdapter(
        'MINIMAX_ACCOUNT_TEST', credential as never,
      )
      // ⚠️ 读真实适配器实例的构造选项：桩适配器读不出这两个字段。
      const options = (adapter as unknown as {
        options: { accountPool?: unknown; fetchRemoteModels?: unknown }
      }).options
      expect(options.accountPool, '探测不得持有账号池（否则失败会写回限流标记）').toBeUndefined()
      expect(options.fetchRemoteModels, '探测不得为一次存活检查额外拉远端目录').toBeUndefined()

      const error = await adapter.stream({ model: 'MiniMax-M3', messages: [] } as never)
        .next().then(() => null).catch((e: unknown) => e)

      // ① 凭据真的接到了请求上（否则生产上「重测」恒报「未登录」）
      expect(calls).toHaveLength(1)
      expect(calls[0]?.auth).toBe('Bearer tok-probe-minimax')
      expect(calls[0]?.url).toBe(`${MINIMAX.apiHost}/mavis/api/v1/llm/v1/messages`)
      // ② 402 原样透出（探测靠它判「额度类失败」并决定是否保留标记）
      expect(error).toMatchObject({ code: 'QUOTA_EXCEEDED' })
    } finally {
      globalThis.fetch = originalFetch
      vi.unstubAllGlobals()
    }
  })

  /**
   * ★★ **probeById.accio 的同款守卫**（2026-10-18 审计补齐，Issue IKM3ZV）。
   *
   * ## 为什么必须补（同一个坑的第二家）
   *
   * minimax 那条上面已写明：`account-probe-adapter.spec.ts` 用的是 `vi.mock` 的
   * **桩**适配器（`stream()` 直接抛错、**完全不读凭据**）⇒ 「工厂把传入的凭据
   * 真的接到了请求上」这件事**零覆盖**。
   *
   * ⚠️⚠️ **实测（2026-10-18 对抗审计变异验证）：把 accio 那条工厂的
   * `resolveCredential: async () => credential as AccioCredential` 改成恒返
   * `undefined`，全套测试**仍然全绿**。** 生产症状：用户在 Jet Hub 点 accio 账号的
   * 「重测 / 重测所有」⇒ 探测恒抛 `accio: no usable credential; log in first`
   * ⇒ **本渠道写进去的 24h / 1h 限流标记永远清不掉**（与 minimax 补测前逐字相同）。
   *
   * ⚠️ 第二条更危险：给探测适配器**误加** `accountPool` 也是全绿 —— 探测路径上
   * 失败会**把被测账号封 24h**，而探测没有任何回滚 ⇒ 点一次「重测」就污染账号池。
   *
   * ⇒ 本用例锁三格：① 凭据真的进了 **`body.token`**（⚠️ 本家的令牌走 body、
   *   **不是** `Authorization` 头 —— 这是 accio 最易错的一条，桩适配器读不出）；
   *   ② `options.accountPool` 为 `undefined`；③ 402 原样透出 `QUOTA_EXCEEDED`。
   */
  it('★★ probeById.accio 用真实适配器：凭据进 body.token、且无池时不换号不写标记', async () => {
    const calls: Array<{ url: string; token: string | undefined; auth: string | null }> = []
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = String(init?.body ?? '{}')
      let token: string | undefined
      try { token = (JSON.parse(raw) as { token?: string }).token } catch { /* 非 JSON */ }
      calls.push({
        url: String(input),
        token,
        auth: new Headers(init?.headers).get('Authorization'),
      })
      return new Response('{"error":"insufficient balance"}', {
        status: 402, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)
    try {
      const credential = { access_token: 'tok-probe-accio', refresh_token: 'r' }
      const adapter = probeById['accio']!.createProbeAdapter(
        'ACCIO_ACCOUNT_TEST', credential as never,
      )
      const options = (adapter as unknown as {
        options: { accountPool?: unknown; fetchRemoteModels?: unknown }
      }).options
      expect(options.accountPool, '探测不得持有账号池（否则失败会写回限流标记 → 点一次重测就封账号 24h）')
        .toBeUndefined()
      expect(options.fetchRemoteModels, '探测不得为一次存活检查额外拉远端目录').toBeUndefined()

      const error = await adapter.stream({ model: '1Drift-N8kP2Q7wR5mX', messages: [] } as never)
        .next().then(() => null).catch((e: unknown) => e)

      // ① 凭据真的进了 **body.token**（本家的令牌走 body，放 Authorization 头恒流内 402）
      expect(calls).toHaveLength(1)
      expect(calls[0]?.token, '凭据必须进 body.token，否则生产上「重测」恒报未登录')
        .toBe('tok-probe-accio')
      expect(calls[0]?.auth, '本家不走 Authorization 头（实测恒流内 402）').toBeNull()
      // ② 402 原样透出（探测靠它判「额度类失败」）
      expect(error).toMatchObject({ code: 'QUOTA_EXCEEDED' })
    } finally {
      globalThis.fetch = originalFetch
      vi.unstubAllGlobals()
    }
  })
})
