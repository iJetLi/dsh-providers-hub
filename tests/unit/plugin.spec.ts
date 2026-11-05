import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { apply, makeReadImage } from '../../src/index.js'
import * as pluginEntry from '../../src/index.js'
import { runLoginFlow, runOAuthFlow } from '../../src/login.js'
import { runBuddyLoginFlow } from '../../src/buddy-oauth.js'
import { CodeArtsAuth } from '../../src/service.js'
import { BuddyAuth } from '../../src/buddy-auth.js'
import { LobsteraiAuth } from '../../src/lobsterai-auth.js'
import { TraeAuth } from '../../src/trae-auth.js'
import { ZcodeAuth } from '../../src/zcode-auth.js'
import { MinimaxAuth } from '../../src/minimax-auth.js'
import { WORKBUDDY } from '../../src/product.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { TRAE } from '../../src/trae-product.js'

vi.mock('../../src/login.js', () => ({
  runLoginFlow: vi.fn(),
  runOAuthFlow: vi.fn(),
}))

// Buddy 登录会真实发起轮询网络请求：插件层测试只关心命令/路由注册，故 mock 整个流程。
// RefreshTokenExpiredError 必须保留真实实现：buddy-auth 的 RefreshScheduler
// onError 回调以 `error instanceof RefreshTokenExpiredError` 判定续期是否
// 彻底失效；mock 缺少该导出会让判定路径抛出 unhandled rejection。
vi.mock('../../src/buddy-oauth.js', async (importOriginal) => ({
  ...await importOriginal(),
  runBuddyLoginFlow: vi.fn(),
}))

const mockedRunLoginFlow = vi.mocked(runLoginFlow)
const mockedRunOAuthFlow = vi.mocked(runOAuthFlow)
const mockedRunBuddyLoginFlow = vi.mocked(runBuddyLoginFlow)

class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

class FakeCommands {
  readonly definitions: CommandDefinition[] = []
  register(definition: CommandDefinition): () => void {
    this.definitions.push(definition)
    return () => {}
  }
}

class FakeLlm {
  readonly providers: string[] = []
  readonly adapters: string[] = []
  /** `registerConfigurableProviders` 的入参明细，供目录项（displayName/settingsNs）断言使用。 */
  readonly configurableProviders: Array<{ provider: string; displayName?: string; settingsNs?: string }> = []
  /** `registerAdapter` 注册的路由名，供 provider 路由断言使用。 */
  readonly registeredProviders: string[] = []
  /** 路由名 → 适配器实例（供目录接线的**真接线**断言使用）。 */
  readonly adapterByProvider = new Map<string, unknown>()
  registerConfigurableProviders(
    entries: Array<{ provider: string; displayName?: string; settingsNs?: string }>,
  ): { replace: () => void } {
    for (const entry of entries) {
      this.providers.push(entry.provider)
      this.configurableProviders.push(entry)
    }
    return { replace: () => {} }
  }
  registerAdapter(providers: string[], adapter: unknown): { replace: () => void } {
    this.adapters.push(...providers)
    this.registeredProviders.push(...providers)
    for (const provider of providers) this.adapterByProvider.set(provider, adapter)
    return { replace: () => {} }
  }
}

/**
 * settings 服务的替身。
 *
 * `registerProviderSettings` 会注册 provider 配置 namespace 并回读 `describe()`
 * 自检，因此替身必须同时实现 `register` 与 `describe`，否则自检日志会走
 * “describe 失败”分支，无法反映真实的 namespace 注册结果。
 *
 * ⚠️⚠️ **`register` 必须返回带 `get`/`replace` 的 scope 对象**（2026-11-05 四审
 * 测试判别力）：真实宿主契约是「`register(ns, schema)` 返回该 namespace 的
 * scope」，而原写法 `register(ns, _schema): void` 让 `createJetHubStore` 拿到
 * `undefined` ⇒ `SettingsStore.load()` 里 `this.scope.get()` 抛
 * `TypeError: Cannot read properties of undefined (reading 'get')`。
 * **该异常被 `apply()` 内部的 try/catch 吞掉** ⇒ 本文件大部分用例仍是绿的，
 * 只有真去读 store 的两条（zcode / minimax 的目录接线）会红。
 */
class FakeSettings {
  readonly registeredNamespaces: string[] = []
  register(ns: string, _schema: unknown): { get: () => unknown; replace: (value: unknown) => void } {
    if (!this.registeredNamespaces.includes(ns)) this.registeredNamespaces.push(ns)
    return { get: () => undefined, replace: () => {} }
  }
  describe(): Array<{ ns: string }> {
    return this.registeredNamespaces.map((ns) => ({ ns }))
  }
}

function makeContext(): { ctx: Context; commands: FakeCommands; llm: FakeLlm; settings: FakeSettings } {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  const commands = new FakeCommands()
  ctx.provide('commands', commands as never)
  const llm = new FakeLlm()
  ctx.provide('llm', llm as never)
  const settings = new FakeSettings()
  ctx.provide('settings', settings as never)
  return { ctx, commands, llm, settings }
}

/**
 * WorkBuddy 测试所用的 mock 上下文。
 *
 * 返回真实的 `Context`（`apply()` 需要它），替身通过 `ctx.provide` 注入，
 * 测试里可直接以 `ctx.llm` / `ctx.settings` 取回并断言。
 */
function createMockContext(): Context & { llm: FakeLlm; commands: FakeCommands; settings: FakeSettings } {
  return makeContext().ctx as Context & { llm: FakeLlm; commands: FakeCommands; settings: FakeSettings }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('plugin entry', () => {
  it('registers the codeartsAuth service (no slash commands)', () => {
    const { ctx, commands } = makeContext()
    apply(ctx)
    expect(ctx.codeartsAuth).toBeInstanceOf(CodeArtsAuth)
    // CodeArts 不再注册任何斜杠命令：登录/状态/续期统一在 Jet Hub 设置页完成。
    const names = commands.definitions.map((d) => d.name)
    for (const removed of ['codearts-login', 'codearts-status', 'codearts-refresh', 'codearts-logout']) {
      expect(names, removed).not.toContain(removed)
    }
  })

  it('注册 codearts LLM 路由（适配器）', () => {
    const { ctx, llm } = makeContext()
    apply(ctx)
    // ⚠️ 2026-10-01 起不再向模型设置页声明 provider（见 src/llm-register-compat.ts
    // 模块头），故只断言 adapter 路由 —— 它才是模型选择器可见性的来源。
    expect(llm.registeredProviders).toContain('codearts')
    expect(llm.adapters).toContain('codearts')
  })

  it('stops the refresh scheduler when the plugin context is disposed', async () => {
    const { ctx } = makeContext()
    apply(ctx)
    const stopSpy = vi.spyOn(ctx.codeartsAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stopSpy).toHaveBeenCalled()
  })
})

/** schemastery `toJSON()` 的序列化形态：子 schema 以 id 存于 `refs`，`dict` 存 id。 */
interface SerializedSchema {
  uid: string | number
  refs: Record<string, {
    type?: string
    meta?: Record<string, unknown>
    dict?: Record<string, string | number>
  }>
}

/**
 * DSH 0.1.7-rc.1 起 `ctx.settings` 是 `SettingsForms`：**没有 `register`**，
 * 命名空间只能是 profile 条目 id。旧实现会在这条分支上打一条误导性的
 * 「settings 服务不可用」告警，并把 provider 的 settingsNs 留成永不存在于
 * settings 的 `llm-*`。这里锁死新契约下的行为（Gitee issue IKI7WT）。
 */
describe('0.1.7 settings 契约（SettingsForms，无 register）', () => {
  /** 0.1.7 的 settings 形状：describe/configure 在，register 不在。 */
  function make017Context(): { ctx: Context; llm: FakeLlm } {
    const ctx = new Context()
    ctx.provide('credentials', new FakeCredentials() as never)
    ctx.provide('commands', new FakeCommands() as never)
    const llm = new FakeLlm()
    ctx.provide('llm', llm as never)
    ctx.provide('settings', {
      describe: () => [],
      configure: () => () => {},
    } as never)
    return { ctx, llm }
  }

  it('apply 不抛错，且不再打「settings 服务不可用」告警', () => {
    const { ctx } = make017Context()
    const warns: string[] = []
    const spy = vi.spyOn(ctx.logger, 'warn').mockImplementation(((...args: unknown[]) => {
      warns.push(args.map(String).join(' '))
    }) as never)
    try {
      expect(() => apply(ctx)).not.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(warns.filter(w => w.includes('settings 服务不可用'))).toEqual([])
  })

  it('0.1.7 契约下同样不向模型设置页声明 provider（路由照常注册）', () => {
    const { ctx, llm } = make017Context()
    apply(ctx)
    // 2026-10-01 起刻意不声明（见 src/llm-register-compat.ts 模块头）：原先这里
    // 断言的是 settingsNs 解析结果，如今没有声明就没有观察点，故锁「一条都不声明」。
    expect(llm.configurableProviders).toEqual([])
    expect(llm.registeredProviders).toContain('codearts')
  })

  it('Config 暴露 volatile 的 providers 字段（否则 settings.describe 不收录本条目）', () => {
    const schema = (pluginEntry as {
      Config?: { toJSON(): SerializedSchema }
    }).Config
    expect(schema).toBeDefined()
    const json = schema!.toJSON()
    const root = json.refs[String(json.uid)]
    expect(root?.type).toBe('object')
    // `dict` 存的是子 schema 在 refs 里的 id。
    const providersRef = String(root?.dict?.['providers'])
    expect(json.refs[providersRef]?.meta?.['volatile']).toBe(true)
  })
})

describe('buddy plugin entry', () => {
  it('registers the buddyAuth service without slash commands', () => {
    // 登录/状态/续期都在 Jet Hub 设置页完成，命令式入口已移除。
    const { ctx, commands } = makeContext()
    apply(ctx)
    expect(ctx.buddyAuth).toBeInstanceOf(BuddyAuth)
    const names = commands.definitions.map((d) => d.name)
    expect(names).not.toContain('buddy-login')
    expect(names).not.toContain('buddy-status')
    expect(names).not.toContain('buddy-refresh')
  })

  it('registers the buddy LLM route', () => {
    const { ctx, llm } = makeContext()
    apply(ctx)
    expect(llm.registeredProviders).toContain('buddy')
    expect(llm.adapters).toContain('buddy')
  })

  it('stops the buddy refresh scheduler when the plugin context is disposed', async () => {
    const { ctx } = makeContext()
    apply(ctx)
    const stopSpy = vi.spyOn(ctx.buddyAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stopSpy).toHaveBeenCalled()
  })
})

describe('WorkBuddy provider 注册', () => {
  it('apply 时注册 buddy 与 workbuddy 两个 provider 路由', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const registered = ctx.llm.registeredProviders
    expect(registered).toContain('buddy')
    expect(registered).toContain('workbuddy')
  })

  it('WorkBuddy 使用独立的凭据 ref', () => {
    expect(WORKBUDDY.defaultCredentialRef).toBe('WORKBUDDY_ACCESS_TOKEN')
  })

  /**
   * ⚠️ 2026-10-01（用户要求）：原先这里断言 WorkBuddy 在模型设置页的目录项与
   * `settingsNs`。本插件已**刻意不再声明**可配置 provider —— 账号、模型开关与模型
   * 目录都在 Jet Hub 设置页管理，声明只会在「设置 → 模型 → 提供商」留下无人使用的
   * 行。机制与代价评估见 `src/llm-register-compat.ts` 模块头；此处改为反向断言，
   * 防止日后误把声明加回来。
   */
  it('不向模型设置页声明 workbuddy 目录项（但路由与适配器照常注册）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.llm.configurableProviders).toEqual([])
    expect(ctx.llm.registeredProviders).toContain('workbuddy')
    expect(ctx.llm.adapters).toContain('workbuddy')
  })

  it('不注册任何 provider 的斜杠命令（入口都在 Jet Hub 设置页）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of [
      'buddy-login', 'buddy-status', 'buddy-refresh', 'workbuddy-login', 'workbuddy-status',
      // CodeArts 的三个命令也已移除：登录/状态/续期统一在 Jet Hub 完成，
      // 六个 provider 的做法现在完全一致。
      'codearts-login', 'codearts-status', 'codearts-refresh', 'codearts-logout',
    ]) {
      expect(names, removed).not.toContain(removed)
    }
    // 命令名必须唯一，重复注册会让后注册的覆盖先注册的。
    expect(new Set(names).size).toBe(names.length)
  })

  // cordis 的 Service 构造时按名称注册，同名第二次注册会抛
  // `service "buddyAuth" has been registered`。两个产品必须各占一个服务名，
  // 否则 apply() 直接抛错、插件完全无法加载。
  it('同时暴露 buddyAuth 与 workbuddyAuth 两个独立实例，各读自己的凭据 ref', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.buddyAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.workbuddyAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.buddyAuth).not.toBe(ctx.workbuddyAuth)
    expect(ctx.buddyAuth.product.id).toBe('buddy')
    expect(ctx.workbuddyAuth.product.id).toBe('workbuddy')
    expect(ctx.buddyAuth.credentialRefName).toBe('BUDDY_ACCESS_TOKEN')
    expect(ctx.workbuddyAuth.credentialRefName).toBe('WORKBUDDY_ACCESS_TOKEN')
  })

  it('workbuddyAuth 只读 WorkBuddy 自己的凭据 ref', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写入 CodeBuddy 的 ref：WorkBuddy 必须报告未配置。
    await ctx.credentials.set('BUDDY_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.workbuddyAuth.status()).configured).toBe(false)

    // 写入 WorkBuddy 自己的 ref 后变为已配置。
    await ctx.credentials.set('WORKBUDDY_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT2', refresh_token: 'RT2', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.workbuddyAuth.status()).configured).toBe(true)
  })

  it('buddyAuth 与 workbuddyAuth 的凭据互相隔离', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写 CodeBuddy 的 ref：CodeBuddy 已配置、WorkBuddy 未配置。
    await ctx.credentials.set('BUDDY_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.buddyAuth.status()).configured).toBe(true)
    expect((await ctx.workbuddyAuth.status()).configured).toBe(false)
  })

  it('dispose 时同时停止 Buddy 与 WorkBuddy 的续期调度', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const buddyStop = vi.spyOn(ctx.buddyAuth, 'stop')
    const workbuddyStop = vi.spyOn(ctx.workbuddyAuth, 'stop')
    await ctx.fiber.dispose()
    expect(buddyStop).toHaveBeenCalled()
    expect(workbuddyStop).toHaveBeenCalled()
  })

  /**
   * `connection` **不得**出现在插件级静态 `inject` 里。
   *
   * 该服务只由 Web bundle（dsh-client-connection）提供，headless / CLI profile
   * 中并不存在。静态 `inject` 会让本插件在那些 profile 里永久 pending，整个
   * profile 因此以
   * `plugin tree failed to load: 1 entry did not activate` 启动失败
   * —— chicheng-cron 的 skill/agent 任务正是跑在 `dsh --profile headless` 下，
   * 会全部 exit 1。
   *
   * 正确做法是 `registerJetHubRpc` 内部用惰性注入（`ctx.inject(['connection'], …)`）
   * 挂载端点：Web 下正常注册，其余 profile 只是不注册 Jet Hub 端点。
   *
   * 这条断言锁住的是「**能不能加载**」而非某个功能细节，所以即便日后有人为了
   * 让 UI 更"直接"而把 connection 加回静态 inject，也必须先看到这里失败。
   */
  it('静态 inject 不得包含 connection（否则 headless profile 启动失败）', () => {
    const { inject } = pluginEntry as { inject?: readonly string[] }
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).not.toContain('connection')
    // 必需服务仍须声明，避免修 connection 时顺手把别的服务误删。
    for (const required of ['credentials', 'commands', 'llm']) {
      expect(inject, required).toContain(required)
    }
  })
})


describe('LobsterAI provider 注册', () => {
  it('apply 时注册 lobsterai provider 路由与适配器', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.llm.registeredProviders).toContain('lobsterai')
    expect(ctx.llm.adapters).toContain('lobsterai')
  })

  // 与 workbuddy 同理（见上方说明）：不再声明可配置 provider。
  it('不向模型设置页声明 lobsterai 目录项（但路由照常注册）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.llm.configurableProviders).toEqual([])
    expect(ctx.llm.registeredProviders).toContain('lobsterai')
    // 展示名仍由产品配置承载（只是不再流向模型设置页）。
    expect(ctx.lobsteraiAuth.product.displayName).toBe(LOBSTERAI.displayName)
  })

  it('不注册任何 lobsterai 斜杠命令（入口在 Jet Hub 设置页）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of ['lobsterai-login', 'lobsterai-status', 'lobsterai-refresh']) {
      expect(names, removed).not.toContain(removed)
    }
  })

  it('暴露 lobsteraiAuth 服务实例，服务名不与既有 provider 冲突', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.lobsteraiAuth).toBeInstanceOf(LobsteraiAuth)
    expect(ctx.lobsteraiAuth.name).toBe('lobsteraiAuth')
    expect(ctx.lobsteraiAuth.product.id).toBe('lobsterai')
    expect(ctx.lobsteraiAuth.credentialRefName).toBe('LOBSTERAI_ACCESS_TOKEN')
    // 四个 provider 的服务实例必须两两不同（同名二次注册会抛错）。
    expect(ctx.lobsteraiAuth).not.toBe(ctx.buddyAuth)
    expect(ctx.lobsteraiAuth).not.toBe(ctx.workbuddyAuth)
  })

  it('lobsteraiAuth 只读自己的凭据 ref（不串用腾讯系凭据）', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写入 CodeBuddy 的 ref：LobsterAI 必须报告未配置。
    await ctx.credentials.set('BUDDY_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.lobsteraiAuth.status()).configured).toBe(false)

    await ctx.credentials.set('LOBSTERAI_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT2', refresh_token: 'RT2', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.lobsteraiAuth.status()).configured).toBe(true)
  })

  it('dispose 时停止 LobsterAI 的续期调度', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const stop = vi.spyOn(ctx.lobsteraiAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stop).toHaveBeenCalled()
  })
})

describe('TRAE provider 注册', () => {
  it('apply 时注册 trae provider 路由与适配器', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.llm.registeredProviders).toContain('trae')
    expect(ctx.llm.adapters).toContain('trae')
  })

  // 与 workbuddy / lobsterai 同理（见上方说明）：不再声明可配置 provider。
  it('不向模型设置页声明 trae 目录项（但路由照常注册）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.llm.configurableProviders).toEqual([])
    expect(ctx.llm.registeredProviders).toContain('trae')
    // 展示名仍由产品配置承载（只是不再流向模型设置页）。
    expect(ctx.traeAuth.product.displayName).toBe(TRAE.displayName)
  })

  it('不注册任何 trae 斜杠命令（入口在 Jet Hub 设置页）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of ['trae-login', 'trae-status', 'trae-refresh']) {
      expect(names, removed).not.toContain(removed)
    }
  })

  it('暴露 traeAuth 服务实例，服务名不与既有 provider 冲突', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.traeAuth).toBeInstanceOf(TraeAuth)
    expect(ctx.traeAuth.name).toBe('traeAuth')
    expect(ctx.traeAuth.product.id).toBe('trae')
    expect(ctx.traeAuth.credentialRefName).toBe('TRAE_ACCESS_TOKEN')
    // 五个 provider 的服务实例必须两两不同（同名二次注册会抛错）。
    expect(ctx.traeAuth).not.toBe(ctx.buddyAuth)
    expect(ctx.traeAuth).not.toBe(ctx.workbuddyAuth)
    expect(ctx.traeAuth).not.toBe(ctx.lobsteraiAuth)
  })

  it('traeAuth 只读自己的凭据 ref（不串用其它 provider 凭据）', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写入 CodeBuddy 的 ref：TRAE 必须报告未配置。
    await ctx.credentials.set('BUDDY_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.traeAuth.status()).configured).toBe(false)

    await ctx.credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT2', refresh_token: 'RT2', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.traeAuth.status()).configured).toBe(true)
  })

  it('dispose 时停止 TRAE 的续期调度', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const stop = vi.spyOn(ctx.traeAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stop).toHaveBeenCalled()
  })
})

/**
 * `makeReadImage` 是「图片为什么送不出去」这条诊断链上唯一的桥接点。
 *
 * 旧实现在附件服务缺失或单图读取失败时一律 `return undefined`，
 * 适配器收到 undefined 后 `continue` 丢图：线上请求静默退化成纯文本，
 * 用户只看到模型「看不到图片」，拿不到任何错误原因——排查成本极高。
 * 下面两条锁住「读不到必须抛错」这一契约。
 */
describe('makeReadImage 图片桥接', () => {
  it('附件服务缺失时抛错，并提示需要哪个插件', async () => {
    const ctx = new Context()
    const readImage = makeReadImage(ctx)
    const error = await readImage({ attachmentId: 'att-1' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('attachments')
    expect((error as Error).message).toContain('dsh-attachment-local')
  })

  it('读取成功时返回字节与 mediaType', async () => {
    const ctx = new Context()
    ctx.provide('attachments', {
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), ref: { mediaType: 'image/png' } }),
    } as never)
    const readImage = makeReadImage(ctx)
    await expect(readImage({ attachmentId: 'att-1' })).resolves.toEqual({
      data: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
    })
  })

  it('单图读取失败时让原始异常冒泡（绝不静默返回 undefined）', async () => {
    // 分工：桥接层不包装，保持原始错误完整；适配器层负责包成带
    // attachmentId 的 LlmError。此处锁住「不会变成 undefined」这一点。
    const cause = new Error('attachment object is gone')
    const ctx = new Context()
    ctx.provide('attachments', {
      readImage: async () => { throw cause },
    } as never)
    const readImage = makeReadImage(ctx)
    const error = await readImage({ attachmentId: 'att-1' }).catch((e: unknown) => e)
    expect(error).toBe(cause)
    expect(error).not.toBeUndefined()

  })
})

/**
 * 「设置 → 模型 → 提供商」里**不得**出现本插件的 provider 行。
 *
 * 用户报障（2026-10-01）：「设置中模型中有很多提供商是由 jet hub 插件提供的，
 * 但是实际也不需要在模型的提供商中进行编辑」。根因是十个 adapter 各自调用
 * `ctx.llm.registerConfigurableProviders()`，而 DSH 的模型设置页只渲染**声明过**
 * 的目录项，且 `settingsPath: []` 使它们恒被判为「已配置」→ 十二行常驻、无法消失。
 *
 * 该声明已在本次改动中移除（机制与代价评估见 `src/llm-register-compat.ts` 模块头）。
 * 这里用一条**跨全部 provider** 的断言锁死：目录一条都不声明，但十二条路由都在
 *（模型选择器的可见性来自 adapter 路由，与声明无关）。
 */
describe('模型设置页：不声明可配置 provider', () => {
  it('apply 后目录为空，但十二条 adapter 路由都已注册', () => {
    const { ctx, llm } = makeContext()
    apply(ctx)
    expect(llm.configurableProviders).toEqual([])
    for (const provider of [
      'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
      'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode',
    ]) {
      expect(llm.registeredProviders, provider).toContain(provider)

      }
    })
  })

/**
 * ★ **目录接线的真接线回归**（审查指出：这两处修复此前**没有任何测试**）。
 *
 * 两个修复点的形态完全一样 —— 它们都是「`index.ts` 里把 A 换成了 B」：
 *
 * | 修复 | 换成了 | 换错的后果 |
 * |---|---|---|
 * | 三处 `fetchRemoteModels` | `…Only()` | 远端失败时回吐兜底表 ⇒ 兜底表被当成远端目录永久缓存（首屏很久才出模型、之后只剩兜底模型） |
 * | zcode 的 `refresh` | `refreshAll(pool)` | 旧写法 `current()` + `getAvailableAccount()` 会「把 A 的凭据写进 B 的 ref」⇒ 30 分钟一轮串掉整池 |
 *
 * ⚠ 此前 `zcode-wiring.spec.ts` 只测 `refreshAll` **方法本身**、
 * `minimax-auth.spec.ts` 只测 `fetchRemoteModelsOnly` **方法本身**；把
 * `index.ts` 的接线改回旧写法时全量 3658 个用例**零红**。下面几条直接
 * 从 `apply()` 建出来的真适配器上取回调，因而能抓住接线本身。
 */
describe('★ 目录接线的真接线（fetchRemoteModels 指向哪个方法）', () => {
  /** 写一份形状合法的 zcode 凭据到默认 ref，让 `ZcodeAuth.current()` 能就绪。 */
  function seedZcodeCredential(ctx: Context): void {
    const credentials = (ctx as unknown as {
      credentials: { set(ref: string, value: string): Promise<void> }
    }).credentials
    void credentials.set(
      'ZCODE_CREDENTIAL',
      JSON.stringify({ zcode_jwt: 'h.p.s', device_mid: 'mid-1' }),
    )
  }

  /**
   * ★ **直接观测接线接到了哪个方法**（而不是旁敲侧击看返回值的条数）。
   *
   * ## 为什么不能用「返回值是不是兜底表」当判据
   *
   * ① `zcode-adapter` 在「远端拿不到」时**本来就应该**回落静态兜底表 ——
   * 那是展示需要，不是缺陷；② 闸门有 30 秒冷却，第一次失败后的第二次调用
   * 根本不会重拉。两条叠加 ⇒ 从返回值上无法区分「接线错了」与「这是设计行为」。
   *
   * ## 判据
   *
   * 适配器侧那条回调是 `() => zcode.fetchRemoteModelsOnly()`（每次调用时**才**
   * 解析方法）⇒ 在原型上包一层就能看见它到底调了哪个方法：
   * - 修复后 ⇒ 记录到 `fetchRemoteModelsOnly`；
   * - 退回旧写法（`zcode.fetchModels()`）⇒ 记录到 `fetchModels` ⇒ **本条变红**。
   *
   * ⚠ 这正是审查指出的「变异后 3658 个用例零红」的那处缺口。
   */
  it('★ zcode 的 fetchRemoteModels 必须接到 fetchRemoteModelsOnly（不得退回 fetchModels）', async () => {
    /** 远端一律立刻失败：本用例不关心结果，只要过程快。 */
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch

    const calls: string[] = []
    const proto = ZcodeAuth.prototype as unknown as Record<string, (...args: never[]) => unknown>
    const originalOnly = proto['fetchRemoteModelsOnly']
    const originalAll = proto['fetchModels']
    proto['fetchRemoteModelsOnly'] = function (this: unknown, ...args: never[]) {
      calls.push('fetchRemoteModelsOnly')
      return originalOnly.apply(this, args)
    }
    proto['fetchModels'] = function (this: unknown, ...args: never[]) {
      calls.push('fetchModels')
      return originalAll.apply(this, args)
    }

    const previousFlag = process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
    process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = 'false'
    try {
      const { ctx, llm } = makeContext()
      apply(ctx)
      seedZcodeCredential(ctx)

      const zcode = llm.adapterByProvider.get('zcode') as {
        listModels(provider: string): Promise<readonly { id: string }[]>
      }
      await zcode.listModels('zcode')

      /**
       * ★ 关键断言：必须命中 `…Only`，且**绝不**命中 `fetchModels`。
       *
       * 退回旧写法时 `calls` 会变成 `['fetchModels']` ⇒ 本条红。
       */
      expect(calls, '适配器的远端目录回调必须走 fetchRemoteModelsOnly').toContain('fetchRemoteModelsOnly')
      expect(calls, '不得退回 fetchModels（那会让兜底表被当成远端目录永久缓存）')
        .not.toContain('fetchModels')
    } finally {
      proto['fetchRemoteModelsOnly'] = originalOnly
      proto['fetchModels'] = originalAll
      if (previousFlag === undefined) delete process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
      else process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = previousFlag
      globalThis.fetch = originalFetch
    }
  })

  /**
   * ★ 同一个判据在 minimax 上（三处 `…Only` 中的另一处）。
   *
   * `minimax-adapter` 的接线是 `() => minimax.fetchRemoteModelsOnly(pool)` ——
   * 同样在每次调用时解析方法，故原型包装一样有效。
   */
  it('★ minimax 的 fetchRemoteModels 必须接到 fetchRemoteModelsOnly', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch

    const calls: string[] = []
    const proto = MinimaxAuth.prototype as unknown as Record<string, (...args: never[]) => unknown>
    const originalOnly = proto['fetchRemoteModelsOnly']
    const originalAll = proto['fetchModels']
    proto['fetchRemoteModelsOnly'] = function (this: unknown, ...args: never[]) {
      calls.push('fetchRemoteModelsOnly')
      return originalOnly.apply(this, args)
    }
    proto['fetchModels'] = function (this: unknown, ...args: never[]) {
      calls.push('fetchModels')
      return originalAll.apply(this, args)
    }

    const previousFlag = process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
    process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = 'false'
    try {
      const { ctx, llm } = makeContext()
      apply(ctx)
      const minimax = llm.adapterByProvider.get('minimax') as {
        listModels(provider: string): Promise<readonly { id: string }[]>
      }
      await minimax.listModels('minimax')

      expect(calls, 'minimax 的远端目录回调必须走 fetchRemoteModelsOnly').toContain('fetchRemoteModelsOnly')
      expect(calls, '不得退回 fetchModels').not.toContain('fetchModels')
    } finally {
      proto['fetchRemoteModelsOnly'] = originalOnly
      proto['fetchModels'] = originalAll
      if (previousFlag === undefined) delete process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
      else process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = previousFlag
      globalThis.fetch = originalFetch
    }
  })
})
