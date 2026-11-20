/**
 * 活动徽标**保鲜接线**的行为守卫（GitHub issue #101）。
 *
 * ## 本文件只回答一个问题
 *
 * apply() 有没有真的把「窗口边界」接到「目录变更播报」上。
 *
 * 这不是形式主义：本仓库实测过「refresh() 空转仍 49 passed」与
 * 「void registerJetHubPanelEntries 全绿 10600 条」这类**接线零守卫**的失效 ——
 * 删掉一行装配代码，纯函数与适配器单测全都还是绿的，而功能从产品里消失。
 *
 * ## 三例的分工（缺一不可）
 *
 * | 例 | 断言 | 挡住什么 |
 * |---|---|---|
 * | ① 真实时间线 | 边界之前零播报；到点播报；之后按下一次边界继续排 | 接线被删 / 短路成 if (false) / 只排一次 |
 * | ② 接线形状 | 交给播报器的恰是**七家**边界源，且 fire 真的 emit 宿主事件 | 漏接一家（「七家变六家」全绿的形态）|
 * | ③ 空源 | 六家都说没有边界 ⇒ 最近边界 undefined | 「其实有别的东西在播」的假绿 |
 *
 * ⚠️ ① 跑的是**真实兜底表**的时间线：Qoder 的窗口 22:00–08:00（Asia/Shanghai），
 * 实测播报落在 14:00Z 与 00:00Z 交替 —— 所以它同时是「数据腿 + 排程腿」的合谋证据。
 * ⚠️ fetch 被钉成抛错 ⇒ 目录一次都拿不到 ⇒ 闸门 got 恒 false ⇒ 除本播报器之外
 * 没有任何东西会 emit llm/adapters-updated（这就是①里「边界之前零播报」有牙的前提）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

/**
 * 包一层真实实现来**观察**构造参数（不是替换实现：播报器仍然是真的在跑）。
 *
 * ⚠️ 为什么需要这层：apply() 是同步的，播报器在 ctx.effect 里**当场**武装第一枚
 * 定时器。等 apply() 返回后再去改适配器方法已经来不及 —— 本文件初版就是这么
 * 假失败了一次：反向对照里那条 14:00 的播报其实来自「武装在先、改 getter 在后」。
 * 故反向对照必须问「交给播报器的源是什么」，而不是「改掉适配器之后会不会播」。
 */
const construction = vi.hoisted(() => ({ options: undefined as unknown }))

vi.mock('../../src/promotion-edge-broadcast.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/promotion-edge-broadcast.js')>()
  return {
    ...actual,
    createPromotionEdgeBroadcaster: (options: unknown) => {
      construction.options = options
      return actual.createPromotionEdgeBroadcaster(options as never)
    },
  }
})

const { apply } = await import('../../src/index.js')
const { nearestPromotionEdge } = await import('../../src/promotion-edge-broadcast.js')

type EdgeSource = () => number | undefined
interface CapturedOptions {
  edgeSources(): readonly EdgeSource[]
  fire(): void
}
type EdgeCapableAdapter = { nextPromotionEdgeAt?: (nowMs?: number) => number | undefined }

class FakeCredentials {
  private store = new Map<string, string>()
  private key(ref: unknown): string { return typeof ref === 'string' ? ref : String(ref) }
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
class FakeCommands { register(): () => void { return () => {} } }
class FakeLlm {
  readonly adapterByProvider = new Map<string, unknown>()
  registerConfigurableProviders(): { replace: () => void } { return { replace: () => {} } }
  registerAdapter(providers: readonly string[], adapter: unknown): { replace: () => void } {
    for (const provider of providers) this.adapterByProvider.set(provider, adapter)
    return { replace: () => {} }
  }
  /** 预热与后台刷新器都会问它；空数组即可（本文件不测目录内容）。 */
  async listModels(): Promise<readonly unknown[]> { return [] }
}

interface TestCtx extends Context {
  credentials: FakeCredentials
  llm: FakeLlm
}

/** 2026-11-17 00:00 UTC = 08:00 Asia/Shanghai（Qoder 夜间窗口**外**、起点之前）。 */
const START = '2026-11-17T00:00:00.000Z'
/** 同一天的 22:00 Asia/Shanghai = 14:00 UTC（窗口开启的那一刻）。 */
const WINDOW_OPENS = Date.parse('2026-11-17T14:00:00.000Z')

const tempDirs: string[] = []

function boot(): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-edge-'))
  tempDirs.push(dir)
  process.env.DSH_JET_HUB_STATE_DIR = dir
  vi.stubGlobal('fetch', async () => { throw new Error('单测不发网络') })
  const ctx = new Context() as TestCtx
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', new FakeCommands() as never)
  ctx.provide('llm', new FakeLlm() as never)
  construction.options = undefined
  apply(ctx as never)
  return ctx
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete process.env.DSH_JET_HUB_STATE_DIR
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('★ apply() 的徽标保鲜接线', () => {
  it('① 真实时间线：窗口开启前零播报，到点播报，之后按下一次边界继续排', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(START))
    const ctx = boot()
    const hits: number[] = []
    ctx.on('llm/adapters-updated', () => { hits.push(Date.now()) })

    // 边界之前（推进到 13:59Z）：一条都不许发。
    await vi.advanceTimersByTimeAsync(WINDOW_OPENS - Date.now() - 60_000)
    expect(hits.length, '未到窗口边界就播报 = 白广播，客户端反复重读整个目录').toBe(0)

    // 跨过边界：播报一次，且时刻不早于边界。
    await vi.advanceTimersByTimeAsync(120_000)
    expect(hits.length, '窗口边界到了必须播报 llm/adapters-updated').toBeGreaterThanOrEqual(1)
    expect(hits[0]!).toBeGreaterThanOrEqual(WINDOW_OPENS)

    // ⚠️ 只排一次是不够的：窗口**关闭**那一侧同样要播报，否则「过期了还挂着」
    // 又回来了。22:00 开、08:00 关 ⇒ 次日 00:00Z 是第二个边界。
    await vi.advanceTimersByTimeAsync(36 * 3_600_000)
    expect(hits.length, '窗口关闭那一侧也必须播报，否则过期徽标最长留到下一次刷新').toBeGreaterThanOrEqual(2)
    // 相邻两次播报应是「一开一关」的节奏（≈10h 与 ≈14h 交替），而不是同一时刻
    // 反复空转（那说明播报后没有重新求边界）。
    const gaps = hits.slice(1).map((value, index) => Math.round((value - hits[index]!) / 3_600_000))
    expect(gaps.every((gap) => gap > 1), '播报间隔异常：' + gaps.join(', ') + ' 小时').toBe(true)
  }, 60_000)

  it('② 交给播报器的恰是七家边界源，且它们真的通向各自的适配器', () => {
    const ctx = boot()
    const options = construction.options as CapturedOptions | undefined
    expect(options, 'apply() 没有构造边界播报器（接线被删）').toBeDefined()
    const sources = options!.edgeSources()
    // ⚠️ 计数守卫：新增一家就要 +1（TRAE 于 2026-11-17 接入闲时窗口；
    // LobsterAI 同日接入限时免费 —— 顺序必须与 src/index.ts 的 edgeSources 一致，
    // 因为下面按 index 逐个钉返回值）。
    expect(sources).toHaveLength(7)

    const probes = ['buddy', 'workbuddy', 'qoder', 'qodercn', 'trae', 'lobsterai', 'raccoon'] as const
    probes.forEach((provider, index) => {
      const adapter = ctx.llm.adapterByProvider.get(provider) as EdgeCapableAdapter | undefined
      expect(adapter, provider + ' 未注册').toBeDefined()
      expect(typeof adapter!.nextPromotionEdgeAt,
        provider + ' 没有 nextPromotionEdgeAt ⇒ 这家的边界永远进不了播报器').toBe('function')
    })

    // 逐个钉住返回值再读：能点名「第 index 个源通向哪家」，而不只是「有五个源」。
    const originals = probes.map((provider) => {
      const adapter = ctx.llm.adapterByProvider.get(provider) as EdgeCapableAdapter
      const original = adapter!.nextPromotionEdgeAt!
      adapter!.nextPromotionEdgeAt = () => 1_000_000 + probes.indexOf(provider)
      return original
    })
    try {
      probes.forEach((provider, index) => {
        expect(sources[index]!(), provider + ' 的边界源指向了别家').toBe(1_000_000 + index)
      })
    } finally {
      probes.forEach((provider, index) => {
        const adapter = ctx.llm.adapterByProvider.get(provider) as EdgeCapableAdapter
        adapter!.nextPromotionEdgeAt = originals[index]!
      })
    }

    // fire 必须是「真的 emit 宿主事件」，不是空函数。
    const emitted: number[] = []
    ctx.on('llm/adapters-updated', () => { emitted.push(1) })
    options!.fire()
    /**
     * ⚠️ 2026-11-20：`broadcastCatalogChanged` 从 `queueMicrotask`（同 tick）
     * 改成了 **800ms 合并窗口**（见 `src/catalog-broadcast.ts` 模块头）⇒
     * 排空一个 microtask 已经等不到广播，必须等窗口。
     */
    return new Promise<void>((resolve) => { setTimeout(resolve, 900) }).then(() => {
      expect(emitted.length, 'fire 没有 emit llm/adapters-updated ⇒ 播报是空转').toBeGreaterThanOrEqual(1)
    })
  })

  it('④ 目录落地后要**重新求边界**（buddy 的远端目录冷启动时还没落地）', () => {
    // 首轮 schedule() 跑在 apply() 里，那一刻 buddy / workbuddy 的 remoteModels
    // 还是 undefined ⇒ 它们对边界没有任何贡献；而播报器只在 fire 过一次之后才
    // 重新求边界（可能是 10 小时以后）。⇒ 必须监听 llm/adapters-updated 重排。
    // 变异：删掉 index.ts 里那条 ctx.on 监听 ⇒ 本条红（calls 不再增长）。
    const ctx = boot()
    let calls = 0
    const probes = ['buddy', 'workbuddy', 'qoder', 'qodercn', 'trae', 'lobsterai', 'raccoon'] as const
    for (const provider of probes) {
      const adapter = ctx.llm.adapterByProvider.get(provider) as EdgeCapableAdapter
      adapter!.nextPromotionEdgeAt = () => { calls += 1; return provider === 'qoder' ? Date.now() + 60_000 : undefined }
    }
    const before = calls
    ctx.emit('llm/adapters-updated')
    expect(calls, '目录落地后没有重新求边界 ⇒ 远端活动要等到下一次 fire 才被看见')
      .toBeGreaterThan(before)
    // 一轮监听 = 七家各问一次；不成倍增长才证明没有 emit ⇄ schedule 递归。
    const grew = calls - before
    expect(grew, '一次事件应只重问一轮（七家）：' + grew).toBeLessThanOrEqual(7)
  })
  it('③ 七家都说没有边界 ⇒ 最近边界 undefined（不许退化成轮询）', () => {
    // ①的排除项。初版在这里改适配器方法后推进时间轴 —— 那条 14:00 的播报来自
    // apply() 里已武装的定时器，改 getter 追不上它。故本例**直接问播报器读到的源**。
    boot()
    const options = construction.options as CapturedOptions
    const emptied = options.edgeSources().map(() => () => undefined as number | undefined)
    expect(nearestPromotionEdge(emptied, Date.parse(START))).toBeUndefined()
    // 反向对照：只要有一家有边界就必须排出来（否则上一条是恒真）。
    expect(nearestPromotionEdge([...emptied.slice(0, 3), () => 5_000], 1_000)).toBe(5_000)
  })
})
