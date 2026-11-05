import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import { isAutoCheckinExcluded } from '../../src/auto-checkin.js'
import { JET_HUB_API_PATH, PERMANENT_LOCK_PROVIDERS, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import { apply } from '../../src/index.js'
import { buddyExpiringWindowDays } from '../../src/buddy-balance-rank.js'

/**
 * ⚠️ 本文件锁「registry 是**真的**唯一真相源」—— 即改 registry 会**真的**
 * 改变宿主行为。
 *
 * 背景（Task 1 复审的 Important）：Task 1 只声明了这些字段，而宿主侧仍有
 * 平行副本，于是「改 registry 不生效」。这类**静默失效**正是本 PR 要消灭的。
 */
describe('autoCheckinExcluded：宿主消费取决于 registry', () => {
  it('恰好排除 registry 里 autoCheckinExcluded === true 的那些', () => {
    const excluded = PROVIDER_REGISTRY
      .filter((d) => d.autoCheckinExcluded === true)
      .map((d) => d.id)
    expect(excluded, '当前应只有 zcode').toEqual(['zcode'])
    for (const id of excluded) {
      expect(isAutoCheckinExcluded(id), `${id} 应被排除`).toBe(true)
    }
  })

  it('未被排除的渠道一律返回 false（含未登记的 provider）', () => {
    for (const d of PROVIDER_REGISTRY) {
      if (d.autoCheckinExcluded === true) continue
      expect(isAutoCheckinExcluded(d.id), `${d.id} 不该被排除`).toBe(false)
    }
    expect(isAutoCheckinExcluded('never-heard-of-it')).toBe(false)
  })
})

describe('usesExpiryWindow：永久积分锁定的 windowDays 取决于 registry', () => {
  it('恰好是 registry 里 usesExpiryWindow === true 的 14 家（officeace 2026-10-12、autoclaw 2026-10-17、qoder/qodercn/astudio/minimax/minimaxintl/codearts 2026-10-20、magicrew/magicrewintl 2026-11-01 加入）', () => {
    const withWindow = PROVIDER_REGISTRY
      .filter((d) => d.usesExpiryWindow === true)
      .map((d) => d.id).sort()
    // ⚠️ 2026-10-20 加 autoclawintl：与 autoclaw 同源（同一份 credits 实现）。
    // ⚠️ qoder / qodercn 2026-10-20 加入：永久哨兵不写 `deductionEndTime`
    //    ⇒ 落永久桶。与 codearts **不同**，本家同时开 `permanentLock`。
    // ⚠️ astudio / minimax / minimaxintl 2026-10-20 加入（PR !119）。
    // ⚠️ codearts 2026-10-20 加入（PR !123）：只有**基础积分包**能分档（随套餐
    //    `end_date` 到期），赠送/按需包走 `expiringTotal`。它**不**开
    //    `permanentLock` —— 下面那条「支持锁定的渠道」断言因此不受影响。
    // ⚠️ magicrew / magicrewintl 2026-11-01 加入：`expiring_quota_details[].expires_at`
    //    是**无时区**的本地时间串（`magicrewParseExpiresAt` 按 UTC+8 解析），而合成包
    //    「永久积分」（= `total_points` 减批次和的残差）**不带** `deductionEndTime`
    //    ⇒ 三档判据的两种输入同时存在。⚠️ 两站各占一项（账号物理隔离）。
    expect(withWindow).toEqual([
      'astudio', 'autoclaw', 'autoclawintl', 'buddy', 'codearts', 'lobsterai',
      'magicrew', 'magicrewintl', 'minimax', 'minimaxintl', 'officeace', 'qoder',
      'qodercn', 'trae', 'workbuddy',
    ])
  })

  it('支持锁定的渠道 ⊆ usesExpiryWindow ∪ {loomy}（loomy 无窗口概念）', () => {
    // ⚠️ 这条锁的是「两个字段的语义关系」：loomy 支持锁定但**不**按到期分桶
    //   （服务端直接给两个命名池），故它不在 usesExpiryWindow 里。
    const locked = [...PERMANENT_LOCK_PROVIDERS].sort()
    const viaWindow = PROVIDER_REGISTRY
      .filter((d) => d.permanentLock === true && d.usesExpiryWindow === true)
      .map((d) => d.id).sort()
    // ⚠️ qoder / qodercn 2026-10-20 加入：两站都**同时**登记两个字段
    //    （半残形态会让锁定按钮在、分档行却不渲染 —— AStudio 首次报障时踩过）。
    // ⚠️ minimax / minimaxintl / astudio 2026-10-20 加入：与 astudio 同批，
    //    两处同时登记（只加 permanentLock 不加 usesExpiryWindow ⇒ 分档行不渲染
    //    但锁按钮在，是 AStudio 首次报障时踩过的半残形态）。
    // ⚠️ autoclaw / autoclawintl 2026-10-21 加入（用户要求「补锁定开关」）：
    //    两站**同日同时**登记两个字段（本家早有 `usesExpiryWindow`，本次补
    //    `permanentLock` + `balance` 接线）。⚠️ 两站各占一项。
    // ⚠️ magicrew / magicrewintl 2026-11-01 加入：两站**同日同时**登记两个字段
    //    （半残形态正是这里防的：锁定按钮在、分档行却不渲染）。两站各占一项。
    expect(viaWindow).toEqual([
      'astudio', 'autoclaw', 'autoclawintl', 'buddy', 'lobsterai',
      'magicrew', 'magicrewintl', 'minimax', 'minimaxintl', 'officeace', 'qoder',
      'qodercn', 'trae', 'workbuddy',
    ])
    expect(locked).toEqual([...viaWindow, 'loomy'].sort())
  })
})

describe('settingsNamespace：registerProviderSettings 的清单取决于 registry', () => {
  it('19 家声明了 namespace，且 opencode 没有', () => {
    // ⚠️ 2026-10-13 合并：officeace 与 accio **同一次**并入，故 13 → 15。
    // ⚠️ 2026-10-15 加 minimaxintl（MiniMax Code 国际版）：15 → 16。
    // ⚠️ 2026-10-16 并入 astudio：16 → 17。
    // ⚠️ 2026-10-17 加 autoclaw（AutoClaw/智谱）：17 → 18。
    // ⚠️ 2026-10-20 加 autoclawintl（AutoClaw 国际版）：18 → 19。
    const withNs = PROVIDER_REGISTRY
      .filter((d) => d.settingsNamespace !== undefined)
      .map((d) => d.id).sort()
    expect(withNs).toEqual([
      'accio', 'astudio', 'autoclaw', 'autoclawintl', 'buddy', 'cline', 'codearts', 'gemini', 'lobsterai', 'loomy',
      'minimax', 'minimaxintl', 'officeace', 'qoder', 'qodercn', 'raccoon', 'trae', 'workbuddy', 'zcode',
    ])
    expect(descriptorOf('opencode')?.settingsNamespace).toBeUndefined()
    expect(descriptorOf('aggregate')?.settingsNamespace).toBeUndefined()
  })

  it('⚠️ namespace 的值逐个对得上（不只是数量对）', () => {
    // ⚠️ 必须断**值**：只断数量会漏掉「两个 provider 的 namespace 写反了」
    //    这类错位（那会让设置页把 A 的配置写到 B 上）。
    expect(descriptorOf('codearts')?.settingsNamespace).toBe('llm-codearts')
    expect(descriptorOf('buddy')?.settingsNamespace).toBe('llm-buddy')
    expect(descriptorOf('workbuddy')?.settingsNamespace).toBe('llm-workbuddy')
    expect(descriptorOf('lobsterai')?.settingsNamespace).toBe('llm-lobsterai')
    expect(descriptorOf('qoder')?.settingsNamespace).toBe('llm-qoder')
    expect(descriptorOf('qodercn')?.settingsNamespace).toBe('llm-qodercn')
    expect(descriptorOf('trae')?.settingsNamespace).toBe('llm-trae')
    expect(descriptorOf('cline')?.settingsNamespace).toBe('llm-cline')
    expect(descriptorOf('loomy')?.settingsNamespace).toBe('llm-loomy')
    expect(descriptorOf('raccoon')?.settingsNamespace).toBe('llm-raccoon')
    expect(descriptorOf('minimax')?.settingsNamespace).toBe('llm-minimax')
    expect(descriptorOf('minimaxintl')?.settingsNamespace).toBe('llm-minimaxintl')
    expect(descriptorOf('zcode')?.settingsNamespace).toBe('llm-zcode')
    expect(descriptorOf('gemini')?.settingsNamespace).toBe('llm-gemini')
    expect(descriptorOf('officeace')?.settingsNamespace).toBe('llm-officeace')
    expect(descriptorOf('accio')?.settingsNamespace).toBe('llm-accio')
    expect(descriptorOf('astudio')?.settingsNamespace).toBe('llm-astudio')
  })
})

/**
 * ⚠️ 上面三组只证明「**声明**正确」+「两个消费函数读的是 registry」。
 * 它们**不能**证明「`src/index.ts` 真的按 registry 注册了」—— 那需要观察
 * `apply()` 的真实行为。故本组用替身 settings 服务跑一次 `apply()`，断言
 * 真正被注册进 settings 的 `llm-*` 集合**逐个**等于 registry 派生出来的集合。
 *
 * ⚠️ 这是**行为断言**，不是扫源码文本：原先有 8 条 `expect(indexSource).toContain("'llm-x'")`
 * 分散在各 provider 的 wiring 用例里，它们会因为「字面量搬家」这种**与行为无关**的
 * 原因变红（本次重构正是如此），却**不能**发现「注册被整个删掉」。本组两者都能发现。
 */
describe('registerProviderSettings：index.ts 真的按 registry 注册（行为断言）', () => {
  class FakeSettings {
    readonly registeredNamespaces: string[] = []
    register(ns: string): void {
      if (!this.registeredNamespaces.includes(ns)) this.registeredNamespaces.push(ns)
    }
    describe(): Array<{ ns: string }> {
      return this.registeredNamespaces.map((ns) => ({ ns }))
    }
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

  /** 跑一次真实的 `apply()`，返回被注册进 settings 的 namespace 集合。 */
  function registeredNamespaces(): string[] {
    const ctx = new Context()
    ctx.provide('credentials', new FakeCredentials() as never)
    ctx.provide('commands', new FakeCommands() as never)
    ctx.provide('llm', new FakeLlm() as never)
    const settings = new FakeSettings()
    ctx.provide('settings', settings as never)
    apply(ctx)
    return settings.registeredNamespaces
  }

  it('★ 注册的 llm-* 集合逐个等于 registry 派生值（漏一个或写错值都红）', () => {
    const want = PROVIDER_REGISTRY
      .map((d) => d.settingsNamespace)
      .filter((ns): ns is string => ns !== undefined)
    // ⚠️ 与上面「19 家声明了 namespace」那条**同源**：registry 里声明了 namespace 的家数。
    //    数字写成常量是有意的（防止有人给 registry 加工 `settingsNamespace` 而
    //    悄悄改变插件注册的设置项集合）。
    expect(want).toHaveLength(19)
    // 只取 `llm-*`：settings 里还有本插件自己的 `jet-hub` 条目，与 provider 无关。
    const got = registeredNamespaces().filter((ns) => ns.startsWith('llm-')).sort()
    // ⚠️ 断言**集合相等**而非顺序：注册顺序不影响 `describe()` 的语义（它按 ns 查、
    //    不按序），派生顺序与原先的人工排列不同是**刻意接受**的。
    //    已核对既有断言无一处依赖顺序（原先那些 `toContain("'llm-x'")` 都是单值包含）。
    expect(got).toEqual([...want].sort())
  })
})

/**
 * ⚠️ `credits.permanentLock` 的响应是否带 `windowDays` 必须**真的**取决于
 * registry 的 `usesExpiryWindow`。
 *
 * 原先 `tests/unit/loomy-rpc-dispatch.spec.ts` 用**源码文本**守这条
 * （`expect(rpcSource).toMatch(/provider === CODEBUDDY\.id \|\| provider === WORKBUDDY\.id/)`），
 * 该文件自己的注释就承认「只覆盖 buddy 那一半，删掉 TRAE/LOBSTERAI 整段照样全绿」。
 * 这里改成**跑真实端点**断言响应体，两侧都盖住。
 */
describe('usesExpiryWindow：credits.permanentLock 的响应体取决于 registry（行为断言）', () => {
  type Handler = (request: Request) => Promise<Response>

  function setup(): (payload: unknown) => Promise<{ ok: boolean; value?: Record<string, unknown> }> {
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
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (c: { path: string; fetch: Handler }) => { if (c.path === JET_HUB_API_PATH) handler = c.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      emit: () => {},
    }

    registerJetHubRpc(
      // ⚠️ **命名对象**（2026-10-08 改，原为位置参数）：这里只用到 pool 与
      // connection，auth 实例全用 `{}` 占位（键是 provider id）。
      ctx as never, pool,
      {
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
    )
    if (handler === undefined) throw new Error('jet-hub RPC 端点未注册')

    return async (payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method: 'credits.permanentLock', payload },
        }),
      }))
      return (await response.json() as { result: { ok: boolean; value?: Record<string, unknown> } }).result
    }
  }

  it('★ 只有 registry 里 usesExpiryWindow === true 的渠道回传 windowDays', async () => {
    const call = setup()
    for (const d of PROVIDER_REGISTRY) {
      if (d.permanentLock !== true) continue
      const result = await call({ provider: d.id })
      expect(result.ok, `${d.id} 应支持锁定`).toBe(true)
      const hasWindow = Object.prototype.hasOwnProperty.call(result.value ?? {}, 'windowDays')
      expect(
        hasWindow,
        d.usesExpiryWindow === true
          ? `${d.id} 必须回传 windowDays（否则面板按写死的 15 天渲染，与真实判据不一致）`
          : `${d.id} 不该回传 windowDays（它没有窗口概念）`,
      ).toBe(d.usesExpiryWindow === true)
      if (d.usesExpiryWindow === true) {
        expect(result.value?.windowDays, `${d.id} 的窗口天数应为当前生效值`).toBe(buddyExpiringWindowDays())
      }
    }
  })
})
