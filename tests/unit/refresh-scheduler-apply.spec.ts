import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/index.js'
import { CodeArtsAuth } from '../../src/service.js'
import { BuddyAuth } from '../../src/buddy-auth.js'
import { LobsteraiAuth } from '../../src/lobsterai-auth.js'
import { QoderAuth } from '../../src/qoder-auth.js'
import { TraeAuth } from '../../src/trae-auth.js'
import { ClineAuth } from '../../src/cline-auth.js'
import { LoomyAuth } from '../../src/loomy-auth.js'
import { RaccoonAuth } from '../../src/raccoon-auth.js'
import { MinimaxAuth } from '../../src/minimax-auth.js'
import { ZcodeAuth } from '../../src/zcode-auth.js'
import { GeminiAuth } from '../../src/gemini-auth.js'

/**
 * ★ issue IKJOZB 的**真 `apply()` 端到端验证**。
 *
 * 与 `refresh-scheduler.spec.ts` 的分工：那里测的是**抽出来的类**，
 * 这里走**用户实际加载插件的那条路径**（真 `apply()` + 真 `AccountPool`），
 * 因而能抓住「类写对了、但 `index.ts` 没接上」这类接线缺陷。
 *
 * ⚠️ 两个写这类用例必须避开的坑（第一版探针两个都踩了，导致假阴性）：
 * 1. **`vi.spyOn(ctx.logger, 'info')` 抓不到调度器日志** —— 必须直接替换
 *    `ctx.logger.info`（cordis 的 Logger 是原型方法 + 自有 exporter，spy 无效）。
 * 2. **`settle()` 里绝不能再用 `setTimeout`** —— `vi.useFakeTimers()` 把它也
 *    mock 了，`await new Promise(r => setTimeout(r, 0))` **永不 resolve**，
 *    于是 fire-and-forget 的异步链推不动、断言看到的是旧状态。
 *    改用 `vi.advanceTimersByTimeAsync(0)`（它会连微任务一起冲干净）。
 */

class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: 'fake', writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeCtxWithLogs(): { ctx: Context; infos: string[]; warns: string[] } {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace: () => {} }),
    registerAdapter: () => ({ replace: () => {} }),
  } as never)
  // ⚠️ `settings.register()` **必须返回一个带 `replace` 的 scope**：
  // JetHubStore 的 SettingsStore 分支会调 `scope.replace(...)` 落盘，
  // 返回 undefined 会在 `addAccount` 时抛 `Cannot read properties of undefined`。
  // 返回 `undefined` 会让 get() 落空 ⇒ 走 FileStore 分支（也可能是 memory），
  // 本用例只关心调度，故给一个可写的内存 scope 最省事。
  let stored: unknown = { accounts: [], disabledModels: {} }
  ctx.provide('settings', {
    register: () => ({
      get: () => stored,
      replace: async (value: unknown) => { stored = value },
    }),
    describe: () => [],
    configure: () => () => {},
  } as never)

  const infos: string[] = []
  const warns: string[] = []
  const logger = ctx.logger as unknown as Record<string, unknown>
  logger['info'] = (...a: unknown[]) => { infos.push(a.map(String).join(' ')) }
  logger['warn'] = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }
  return { ctx, infos, warns }
}

/** 推进 fake timers 并冲干净微任务（⚠️ 不能用 setTimeout，见文件头）。 */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

/** 所有 Auth 类（去重，buddy/workbuddy 与 qoder/qodercn 各共用一个类）。 */
const AUTH_CLASSES = [
  CodeArtsAuth, BuddyAuth, LobsteraiAuth, QoderAuth, TraeAuth,
  ClineAuth, LoomyAuth, RaccoonAuth, MinimaxAuth, ZcodeAuth, GeminiAuth,
] as const

/** 每轮续期看到的账号 id（由被 patch 的 `refreshAll(pool)` 记录）。 */
let ticks: string[][] = []

/**
 * 把所有 `refreshAll` 换成记录器。
 *
 * ⚠️ 必须同时避免真实网络：`refreshTargets` 里 13 条都会调各自的 `refreshAll`，
 * 真跑会打上游（用例慢且不确定）。替换后本用例只关心「调度有没有发生、
 * 那一轮看得到哪些账号」——这正是 issue 的判据。
 */
function patchRefreshAll(): () => void {
  const originals = AUTH_CLASSES.map((C) => {
    const proto = C.prototype as unknown as Record<string, unknown>
    return [proto, proto['refreshAll']] as const
  })
  const seen = new Set<unknown>()
  for (const C of AUTH_CLASSES) {
    const proto = C.prototype as unknown as Record<string, unknown>
    if (seen.has(proto)) continue
    seen.add(proto)
    proto['refreshAll'] = async function (pool: { listAllAccounts(): Promise<Array<{ id: string }>> }) {
      const accounts = await pool.listAllAccounts()
      ticks.push(accounts.map((a) => a.id))
      return undefined
    }
  }
  return () => {
    for (const [proto, original] of originals) proto['refreshAll'] = original
  }
}

describe('★ issue IKJOZB 真 apply() 端到端', () => {
  let restore: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    ticks = []
    restore = patchRefreshAll()
  })
  afterEach(() => {
    restore()
    vi.useRealTimers()
  })

  it('① 冷启动空池时调度器仍然武装（旧实现在此直接 return）', async () => {
    const { ctx, infos } = makeCtxWithLogs()
    apply(ctx)
    // issue #20：首轮延后 15s（生产接线）。apply() 的启动链需要若干轮微任务
    // 才真正调用 start()，故交错推进：start 一旦排下 15s 定时器，下一轮触发。
    for (let i = 0; i < 6; i += 1) {
      await settle(5)
      await vi.advanceTimersByTimeAsync(15_000)
    }

    expect(
      infos.some((s) => s.includes('多账号续期调度器已武装')),
      '空池时调度器未武装 —— 正是 issue IKJOZB 的根因',
    ).toBe(true)
    // issue #20：生产接线把首轮延后 15s，必须留下可观测的说明（否则用户会以为
    // 「重启后一直没续期」）。空池留痕本身由 refresh-scheduler.spec.ts 的
    // 「空池仍要记一条 info」用例守（那里没有 apply 的异步启动链噪声）。
    expect(
      infos.some((s) => s.includes('首轮续期延后 15000ms')),
      '首轮延迟必须留痕（issue #20）',
    ).toBe(true)
    // 启动首轮必须跑过（issue !IKIRTT 的既有约定）
    expect(ticks.length, '启动首轮没跑').toBeGreaterThanOrEqual(1)
  })

  it('② 冷启动空池 → 登录入库 → 该账号被纳入主动续期（issue 的完整时序）', async () => {
    const { ctx, infos } = makeCtxWithLogs()
    apply(ctx)
    await settle()
    // issue #20：先让延后的首轮真正跑一次，再看「登录入库」是否被追加。
    await vi.advanceTimersByTimeAsync(15_000)
    const afterStartup = ticks.length

    // 用户登录：走**真实** AccountPool → 真实 onAccountAdded 钩子（不打网络）
    const pool = (ctx as unknown as {
      accountPool: { addAccount(e: unknown): Promise<void> }
    }).accountPool
    expect(pool, 'ctx.accountPool 未暴露').toBeDefined()
    await pool.addAccount({
      id: 'probe-login-1',
      provider: 'codearts',
      nickname: 'probe',
      enabled: true,
      credentialRef: 'CODEARTS_PROBE',
      createdAt: Date.now(),
      expiresAt: Date.now() + 7_200_000,
      refreshable: true,
    })

    // 推进一个续期周期（30 分钟）
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    await settle()

    expect(ticks.length, '登录后一个周期内没有任何主动续期 —— issue 复现').toBeGreaterThan(afterStartup)
    expect(
      ticks.at(-1),
      `该轮看到的账号：${JSON.stringify(ticks.at(-1))}`,
    ).toContain('probe-login-1')
    // 第一道防线（无条件武装）本应已生效，故不该走到「补武装」
    expect(
      infos.some((s) => s.includes('正在补武装')),
      '走到了补武装分支 ⇒ 第一道防线（无条件武装）没生效',
    ).toBe(false)
  })

  it('③ 空池下定时器不自毁（连续多轮都在跑）', async () => {
    const { ctx } = makeCtxWithLogs()
    apply(ctx)
    await settle()
    const before = ticks.length

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    await settle()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    await settle()

    expect(ticks.length, '空池下定时器停了（= 旧缺陷形态）').toBeGreaterThanOrEqual(before + 2)
  })
})
