/**
 * ★★ **接线层生命周期与错误通道**的守卫（2026-10-27 第二轮审计打穿的那几格）。
 *
 * ## 为什么单独建一个文件
 *
 * 审计实测：下面这些接线**删掉或改坏后，全量测试一个字都不变**（红队清单里
 * 有 5 项是「绿 = 无牙」）。而它们的后果都是**用户可见且难以归因**的：
 *
 * | 接线 | 删掉后的后果 |
 * |---|---|
 * | 两站 `startRenewPatrol` | MiniMax 的轮换**完全停摆**（`refreshAll` 已改成纯对账）⇒ 每 1h 死一次 |
 * | 巡检的 `ctx.effect` 回收 | 热重载叠加定时器 ⇒ 两实例并发轮换同一批一次性 RT ⇒ 好号被标死 |
 * | `401` 后拿不到可续期账号时的**留痕** | 「一次上游都不发 + 用户看到 401 + 日志零字」 |
 *
 * ## 判据为什么必须是行为级
 *
 * 本仓库反复记录：源码文本断言会被 `if (false)` / 字符串字面量 / 行尾注释绕过
 *（`AGENTS.md` 与 `docs/agent-notes/client-ui.md` 都有实测清单）。
 * 故这里**真跑 `apply()`**、真 dispose fiber、真观察 grant 次数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { apply } from '../../src/index.js'

const dirs: string[] = []

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-'))
  dirs.push(dir)
  process.env.DSH_JET_HUB_STATE_DIR = dir
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  /**
   * ⚠️ 清理临时目录**必须容错**（2026-11-01 二审修）。
   *
   * `rmSync` 在 Windows 上偶发 `ENOTEMPTY: Directory not empty` —— 本仓库的
   * 状态文件写入是**异步**的（`replace()` 走 `writeFile` + `rename`），
   * afterEach 跑的时候可能还有一个 rename 在路上 ⇒ 目录刚被删空、新文件又落了进去。
   * 症状是**整条用例组的 afterEach 抛错**（用例本身是绿的），看起来像随机 red。
   * 实测：它单独跑 3/3 绿、全量并发下必红。
   *
   * ⇒ `maxRetries` + `retryDelay` 让 Node 自己重试（这是官方为此提供的参数），
   *   并在最后一次仍失败时**吞掉** —— 临时目录残留不影响任何断言。
   */
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // 残留只会占一点 %TEMP%，不影响结论：本文件的断言全部在用例体内。
    }
  }
  dirs.length = 0
})

class FakeCredentials {
  private store = new Map<string, string>()
  private key(ref: unknown): string {
    return typeof ref === 'string' ? ref : String((ref as { name?: string })?.name ?? ref)
  }
  async resolve(ref: unknown) {
    const value = this.store.get(this.key(ref))
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: unknown) {
    const configured = this.store.has(this.key(ref))
    return { configured, source: configured ? 'fake' : undefined, writable: true }
  }
  async set(ref: unknown, value: string) { this.store.set(this.key(ref), value) }
  async unset(ref: unknown) { this.store.delete(this.key(ref)) }
}

class FakeCommands {
  register(): () => void { return () => {} }
}

class FakeLlm {
  readonly adapterByProvider = new Map<string, unknown>()
  registerConfigurableProviders(): { replace: () => void } { return { replace: () => {} } }
  registerAdapter(providers: string[], adapter: unknown): { replace: () => void } {
    for (const provider of providers) this.adapterByProvider.set(provider, adapter)
    return { replace: () => {} }
  }
}

interface TestCtx extends Context {
  accountPool: { addAccount(entry: Record<string, unknown>): Promise<void> }
  credentials: FakeCredentials
  llm: FakeLlm
}

async function boot(): Promise<{ ctx: TestCtx; fiber: { dispose: () => Promise<void> | void } }> {
  const root = new Context()
  root.provide('credentials', new FakeCredentials() as never)
  root.provide('commands', new FakeCommands() as never)
  root.provide('llm', new FakeLlm() as never)
  /**
   * ⚠️ 必须用 `ctx.plugin(...)` 的**派生上下文**（不是根上下文）—— cordis 的服务
   * 注册在插件 fiber 上，根上下文读 `ctx.accountPool` 会抛
   * `cannot get property "accountPool" without inject`。
   */
  let inner: TestCtx | undefined
  const fiber = root.plugin({
    apply: (context: Context) => {
      inner = context as TestCtx
      apply(context as never)
    },
  }) as unknown as { dispose: () => Promise<void> | void }
  /**
   * ⚠️ `ctx.plugin(...)` 的 apply 是**异步派发**的（cordis 排进微任务），
   * 故必须 flush 微任务才能读到服务；直接断言会拿到 `undefined`。
   *
   * ⚠️⚠️ **刻意不用 `setTimeout`**：本文件会在用例里 `vi.useFakeTimers()`，
   * 那时 `setTimeout(0)` **永不执行** ⇒ `boot()` 会挂到用例超时（实测踩过）。
   */
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  if (inner === undefined) throw new Error('apply() 未执行')
  return { ctx: inner, fiber }
}

/** 造一个「已过期」的 MiniMax 账号（会被巡检续期）。 */
async function seedExpiredMinimax(ctx: TestCtx, product: string, ref: string): Promise<void> {
  await ctx.accountPool.addAccount({
    id: `acct-${ref.slice(-6).toLowerCase()}`,
    provider: product,
    nickname: ref,
    enabled: true,
    credentialRef: ref,
    createdAt: 0,
    refreshable: true,
  })
  await ctx.credentials.set(credentialRef(ref), JSON.stringify({
    access_token: 'A'.repeat(60),
    refresh_token: 'R'.repeat(60),
    token_type: 'Bearer',
    expires_at: String(Date.now() - 60_000),
    scope: 'agent.default',
  }))
}

describe('★★ 两站巡检必须真的启动（审计实测：删掉整段全量测试零变化）', () => {
  it('★★ `apply()` 之后两站各有一个巡检定时期（`minimax` 与 `minimaxintl`）', async () => {
    let minimaxGrants = 0
    let intlGrants = 0
    vi.stubGlobal('fetch', async (url: string) => {
      const href = String(url)
      if (!href.includes('/oauth2/token')) {
        // 目录/身份等只读端点：给个空壳
        return new Response(JSON.stringify({ statusInfo: { code: 0 } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      // ⚠️ 两站的账号主机不同 ⇒ 用它区分（否则数不清是哪一站发的）
      if (href.includes('minimax.io')) intlGrants += 1
      else minimaxGrants += 1
      return new Response(JSON.stringify({
        access_token: 'B'.repeat(60), refresh_token: 'R2'.repeat(30),
        token_type: 'bearer', expires_in: 3600, scope: 'agent.default',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    /**
     * ⚠️⚠️ **假时钟必须在 `boot()` 之前装**。
     *
     * 巡检的 `setInterval` 是 `apply()` 期间注册的；若先 `boot()` 再
     * `vi.useFakeTimers()`，那个定时器是**真实**的 ⇒ 假时钟推不动它
     * ⇒ 用例会报「巡检未启动」的**假红**（实测踩过）。
     */
    vi.useFakeTimers()
    const { ctx } = await boot()
    await seedExpiredMinimax(ctx, 'minimax', 'MINIMAX_ACCOUNT_LIFE1')
    await seedExpiredMinimax(ctx, 'minimaxintl', 'MINIMAXINTL_ACCOUNT_LIFE2')

    /**
     * ⚠️⚠️ **必须推进一个完整周期（61s），而不是"给一点时间"**。
     *
     * `apply()` 时巡检的**首轮是同步发起**的，而那一刻账号池还是空的
     * （用例是在 `apply()` 之后才 `addAccount`）⇒ 首轮跑了个空循环。
     * 第二轮要等 `MINIMAX_RENEW_PATROL_INTERVAL_MS`（60s）之后。
     * 推进 20ms 永远看不到请求（实测踩过：报「巡检未启动」假红）。
     */
    await vi.advanceTimersByTimeAsync(61_000)

    expect(
      minimaxGrants,
      '★ 国内站巡检未启动 ⇒ 该站轮换完全停摆（`refreshAll` 已改成纯对账）',
    ).toBeGreaterThan(0)
    expect(
      intlGrants,
      '★ 国际站巡检未启动（双站点纪律：漏一处即该站静默不续期）',
    ).toBeGreaterThan(0)
  })
})

describe('★★ 巡检必须挂 `ctx.effect`：fiber 卸载后不得继续轮换', () => {
  it('★★ dispose 之后推进 5 分钟 ⇒ 不得再发任何 grant', async () => {
    let grants = 0
    vi.stubGlobal('fetch', async (url: string) => {
      const href = String(url)
      if (!href.includes('/oauth2/token')) {
        return new Response(JSON.stringify({ statusInfo: { code: 0 } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      grants += 1
      return new Response(JSON.stringify({
        access_token: 'B'.repeat(60), refresh_token: 'R2'.repeat(30),
        token_type: 'bearer', expires_in: 3600, scope: 'agent.default',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    vi.useFakeTimers()   // ⚠️ 必须在 boot() 之前（同上）
    const { ctx, fiber } = await boot()
    await seedExpiredMinimax(ctx, 'minimax', 'MINIMAX_ACCOUNT_LIFE3')
    /**
     * ⚠️⚠️ **判据必须数「巡检有没有继续读池」，不能数「有没有发出 grant」**。
     *
     * 我第一版数的是 grant（`fetch` 次数）—— 那是**假绿**：
     * fiber dispose 之后，巡检实例读的是**已卸载的上下文**，`listAccounts`
     * 会抛「inactive context」并被 tick 的 catch 吞成一条 warn ⇒ **一次 grant 都没有**
     * ⇒ 无论有没有回收，`grants` 都停在 0（实测：删掉 `ctx.effect` 用例仍绿）。
     *
     * 而「巡检还在 tick」这个事实本身就有后果：`patrolTimer` 没被 `clearInterval`
     * ⇒ 热重载时旧实例的定时器持续空转，且**同一个账号会被新旧两套巡检覆盖**；
     * 一旦哪次上下文恰好可读（例如卸载后又被重挂），它立刻重新开始轮换
     * 一次性 RT。⇒ 判据改成 `listAccounts` 的调用次数。
     */
    const pool = (ctx as unknown as { accountPool: { listAccounts: (p: string) => Promise<unknown[]> } }).accountPool
    let listCalls = 0
    const originalList = pool.listAccounts.bind(pool)
    pool.listAccounts = (product: string) => { listCalls += 1; return originalList(product) }

    // ⚠️ 同用例 1：apply() 时的首轮池是空的 ⇒ 推进一个完整周期才看得到第二轮
    await vi.advanceTimersByTimeAsync(61_000)
    const beforeDispose = listCalls
    expect(beforeDispose, '巡检第二轮未跑（用例前提不成立）').toBeGreaterThan(0)

    await fiber.dispose()
    const atDispose = listCalls
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(
      listCalls - atDispose,
      '★ fiber 已卸载但巡检仍在 tick（定时器未 clear）⇒ 热重载后旧实例与新实例'
      + '同时覆盖同一批账号（一次性 RT ⇒ 输家 invalid_grant、好号被标死）',
    ).toBe(0)
    void grants
  })
})

describe('★★ 401 后拿不到可续期账号时必须留痕（不得「一次上游都不发 + 日志零字」）', () => {
  it('★ 两站的 refresh 闭包在「池里没有该凭据」时都必须 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/chat/completions')) {
        return new Response(JSON.stringify({ code: 401, msg: 'invalid token' }), { status: 401 })
      }
      return new Response(JSON.stringify({ models: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    })

    const { ctx } = await boot()
    /**
     * ⚠️ 池里**不**放任何 autoclaw 账号 ⇒ 反查必然返回 `''` ⇒ 走「无可续期」那一格。
     *
     * ⚠️⚠️ **不能替换 `ctx.logger.warn`**：`apply()` 期间闭包已经捕获了
     * logger 的方法引用，事后改属性**不影响**已注册的闭包（实测踩过：报假红）。
     * ⇒ 改用 `vi.spyOn` 打**同一个对象上的方法**（spy 会替换属性并保留原实现，
     *   而 `apply()` 里用的是 `ctx.logger.warn(...)` 形式 ⇒ 每次调用都重新取属性
     *   ⇒ spy 能捕获到）。
     */
    const loggerWarn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    /**
     * ⚠️⚠️ **直接调 `options.refresh(used)` 闭包**，不要绕 `adapter.stream()`。
     *
     * 我第一版走 `stream()` + 让上游回 401 —— 那是**假绿**：`stream()` 的
     * 401 分支要求先有**可用凭据**（`credential.access_token !== ''`），
     * 且目录预热等旁路会先消耗 fetch；实测那条路径根本没走到闭包
     * （`loggerWarn` 一次都没被调用）。
     *
     * 而这一格要守的是**闭包自己的语义**（「反查不到账号时必须留痕」），
     * 直接调它既精确又不受 `stream()` 的前置条件影响。
     */
    for (const product of ['autoclaw', 'autoclawintl'] as const) {
      const adapter = ctx.llm.adapterByProvider.get(product) as unknown as {
        options: { refresh?: (used?: unknown) => Promise<unknown> }
      }
      expect(adapter, `${product} 未注册适配器`).toBeDefined()
      expect(typeof adapter.options.refresh, `${product} 未接 refresh 闭包`).toBe('function')
      /**
       * ⚠️ 传一份**池里不存在**的凭据 ⇒ 必然触发「反查不到」那一格。
       * 闭包会先退默认单凭据 ref（也未配置）⇒ 最终返回 `undefined`（**不抛**）。
       */
      await adapter.options.refresh?.({
        access_token: 'AT-ORPHAN', refresh_token: 'RT-ORPHAN', expires_at: Date.now() + 3_600_000,
      })
    }

    expect(
      loggerWarn.mock.calls.some((call) => String(call[0]).includes('反查不到账号')),
      '★ 401 后找不到可续期账号却完全静默 ⇒ 用户只看到「API 密钥无效」，日志里查不到原因',
    ).toBe(true)
    loggerWarn.mockRestore()
  })
})