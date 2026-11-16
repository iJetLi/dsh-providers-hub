/**
 * AStudio 的两格**行为守卫**（2026-10-18 审计补齐，此前一条都没有）：
 *
 * ① **目录缓存的 20 分钟 TTL** —— 与应用其余 11 家同款判据
 *    （`model-catalog.ts` 的 `isCatalogFresh`）；
 * ② **思考档位的本地拦截** —— 丢集合外的值（上游对非法档位回 200 并按最贵档跑）。
 *
 * ## 为什么此前零守卫
 *
 * - 目录侧：`loadModels` 只判 `remoteModels !== undefined` ⇒ **成功拉到一次就永不重拉**
 *   （上游上/下架模型后用户的模型列表永久冻结），`isCatalogFreshFor` 在本家零命中；
 * - 档位侧：`astudioEffortForRequest` 在**任何**测试里零调用 —— 实测把它整块换成
 *   裸透传后全量 9645 例**零红**（同 PR 的 autoclaw 侧同一位置有 3~7 条红）。
 *
 * ⚠️ 判据一律打在**行为**上（真的 fetch 次数 / 真的请求体），**不用**源码文本断言 ——
 *    后者会被 `if (false)` 短路骗过（本仓库已实测 5 条全绿）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AstudioAdapter } from '../../src/astudio-adapter.js'
import { ASTUDIO } from '../../src/astudio-product.js'
import { CATALOG_REFRESH_INTERVAL_MS } from '../../src/model-catalog.js'
import type { AstudioCatalogModel, AstudioCredential } from '../../src/astudio.js'

/** 造一个远端目录条目（只填转换链路真正读的字段；其余字段用断言补齐）。 */
function remoteModel(
  id: string,
  extra: Partial<AstudioCatalogModel> = {},
): AstudioCatalogModel {
  return {
    id,
    name: id.toUpperCase(),
    visibility: 'list',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    inputModalities: ['text'],
    ...extra,
  } as AstudioCatalogModel
}

const CRED = { access_token: 'at' } as AstudioCredential

/** 可推进的假时钟。 */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let v = start
  return { now: () => v, advance: (ms: number) => { v += ms } }
}

function emptySse(): Response {
  return new Response('data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * 从**请求体**里取实际发出去的思考档位。
 *
 * ⚠️ 2026-11-16 起本家走的是 **Responses** 协议：档位在 `reasoning.effort`，
 * 不再是 chat 的顶层 `reasoning_effort`。判据必须跟着 wire 形态走 ——
 * 照旧读 `reasoning_effort` 会让本组用例**恒真**（字段永远不存在 ⇒ 永远
 * `undefined`），把「门禁失效」整个漏掉。
 */
function reasoningEffortOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const reasoning = (body as { reasoning?: unknown }).reasoning
  if (typeof reasoning !== 'object' || reasoning === null) return undefined
  const effort = (reasoning as { effort?: unknown }).effort
  return typeof effort === 'string' ? effort : undefined
}

/**
 * 造一个最小 adapter。
 *
 * ⚠️ **不注入 `fetchRemoteModels` 时目录退用内置兜底表**（零网络）——
 *    档位那一组用例靠它（兜底表里 `xopglm52` 声明 `none/high/max`）。
 */
function makeAdapter(options: {
  remote?: () => Promise<readonly AstudioCatalogModel[]>
  clock?: { now: () => number }
  warnings?: string[]
} = {}) {
  const warnings = options.warnings ?? []
  const bodies: unknown[] = []
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
    return emptySse()
  }) as unknown as typeof fetch
  const adapter = new AstudioAdapter({
    product: ASTUDIO,
    fetchImpl: fetcher,
    resolveCredential: async () => CRED,
    ...options.remote === undefined ? {} : { fetchRemoteModels: options.remote },
    ...options.clock === undefined ? {} : { now: options.clock.now },
    warn: (message: string) => { warnings.push(message) },
  })
  return { adapter, warnings, bodies }
}

/** 跑完一次 stream（本文件只关心发出去的请求体）。 */
async function streamOnce(
  adapter: AstudioAdapter,
  model: string,
  reasoningEffort?: string,
): Promise<void> {
  const options = {
    provider: 'astudio',
    model,
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    })],
    ...reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as never },
  } as GenerateOptions
  for await (const _chunk of adapter.stream(options)) { /* 只为触发请求 */ }
}

// ════════════════════════════════════════════════════════════════════════
describe('★★ AStudio 目录缓存的 20 分钟 TTL（规范对齐：其余 11 家都有）', () => {
  it('冷缓存必须真拉（不得只回兜底表）', async () => {
    let fetched = 0
    const { adapter } = makeAdapter({
      remote: async () => { fetched += 1; return [remoteModel('xopglm52')] },
    })
    const models = await adapter.listModels('astudio')
    expect(fetched, '冷缓存必须拉一次').toBe(1)
    expect(models.map((m) => m.id), '拉到的目录必须可见').toContain('xopglm52')
  })

  it('★★ TTL 内**零额外请求**（这是「有缓存」的全部意义）', async () => {
    let fetched = 0
    const clock = makeClock()
    const { adapter } = makeAdapter({
      remote: async () => { fetched += 1; return [remoteModel('xopglm52')] },
      clock,
    })
    await adapter.listModels('astudio')
    clock.advance(CATALOG_REFRESH_INTERVAL_MS - 1)
    await adapter.listModels('astudio')
    expect(fetched, 'TTL 内不得重拉').toBe(1)
  })

  it('★★ 满 20 分钟必须重拉（修前**恒不重拉** —— 模型列表整个进程冻结）', async () => {
    let fetched = 0
    const clock = makeClock()
    const { adapter } = makeAdapter({
      remote: async () => { fetched += 1; return [remoteModel(`m${fetched}`)] },
      clock,
    })
    await adapter.listModels('astudio')
    clock.advance(CATALOG_REFRESH_INTERVAL_MS + 1)
    const second = await adapter.listModels('astudio')
    expect(fetched, '超过 20 分钟必须重拉').toBe(2)
    expect(second.map((m) => m.id), '必须看到**新**目录（不是旧的那份）').toContain('m2')
  })

  it('⚠️ 拉取失败**不得**写「成功时刻」（否则一次抖动掩盖 20 分钟）', async () => {
    let fetched = 0
    const clock = makeClock()
    const { adapter } = makeAdapter({
      remote: async () => { fetched += 1; throw new Error('net down') },
      clock,
    })
    await adapter.listModels('astudio')
    expect(fetched, '第一次要真去拉').toBe(1)
    // 失败后进入 60s 冷却；推进到冷却已过但 TTL 未满的位置。
    clock.advance(61_000)
    await adapter.listModels('astudio')
    // 冷却已过 ⇒ 允许再拉；关键是**不能**因为失败就被当成"新鲜"而在 TTL 内静默跳过。
    expect(fetched, '失败不得被记成新鲜（TTL 内也必须继续重试）').toBeGreaterThan(1)
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('★★ AStudio 的强制重拉与后台刷新器入口', () => {
  it('★ refreshCatalog() 必须**无视 TTL** 真重拉（两条清腿至少清一条）', async () => {
    // ⚠️ 本用例锁的是 `refreshCatalog` 的**整体语义**，不是某一条清腿：
    //    实测（2026-10-18 变异）单独删 `catalogAt = 0` 或单独删
    //    `remoteModels = undefined` **都无牙**（12 例全绿）—— 因为 `loadModels`
    //    的 gate 是合取、且 `isCatalogFresh` 对 `at === 0` 恒判陈旧
    //    ⇒ 任一条都足以让 gate 失效。**两条都删**才红（1 failed）。
    //    ⇒ 这是**如实登记的无牙腿**，不是「忘了一条判据」；
    //      详见 `astudio-adapter.ts` 的 `refreshCatalog` 注释里的实测表。
    let fetched = 0
    const clock = makeClock()
    const { adapter } = makeAdapter({
      remote: async () => { fetched += 1; return [remoteModel('xopglm52')] },
      clock,
    })
    await adapter.listModels('astudio')
    // TTL 完全没到 —— 修前 refreshCatalog 只清 remoteModels、不清 catalogAt，
    // 而 gate 会因 TTL 仍新鲜直接返回旧目录 ⇒ 按钮看起来没反应。
    await adapter.refreshCatalog()
    expect(fetched, 'TTL 内调 refreshCatalog 也必须真拉').toBe(2)
  })

  it('★★ 必须暴露 refresh() 实例成员 —— 后台目录刷新器的唯一入口', async () => {
    // ⚠️⚠️ `src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`，返回 undefined
    //    即**静默跳过**（「刷新器已武装」的日志仍为真）。`refresh` 是
    //    `createModelCatalog` 返回的 **catalog 实例**上的成员，不会自动变成适配器的
    //    成员 ⇒ 必须在类上显式转发。本仓库 12 家适配器实测**都没有**这个成员。
    let fetched = 0
    const { adapter } = makeAdapter({
      remote: async () => { fetched += 1; return [remoteModel('xopglm52')] },
    })
    expect(typeof (adapter as { refresh?: unknown }).refresh, '适配器必须暴露 refresh()').toBe('function')
    await adapter.listModels('astudio')
    expect(fetched).toBe(1)
    await adapter.refresh()
    expect(fetched, 'refresh() 必须真的触发一次重拉').toBe(2)
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('★★ AStudio 思考档位本地拦截（上游对非法档位回 200 并按最贵档跑）', () => {
  it('集合内的档位原样发（none / high / max 三档都要走通）', async () => {
    for (const effort of ['none', 'high', 'max']) {
      const { adapter, bodies } = makeAdapter()
      await streamOnce(adapter, 'xopglm52', effort)
      expect(
        reasoningEffortOf(bodies[0]),
        `${effort} 应当原样上行`,
      ).toBe(effort)
    }
  })

  it('★★ 集合外的档位**不发该字段**（不拦就是为最贵档付钱）', async () => {
    for (const bogus of ['bogus-value', 'medium', 'low', 'turbo', 'MAX', ' ']) {
      const { adapter, bodies } = makeAdapter()
      await streamOnce(adapter, 'xopglm52', bogus)
      expect(
        reasoningEffortOf(bodies[0]),
        `非法档位 ${JSON.stringify(bogus)} 绝不能上行`,
      ).toBeUndefined()
    }
  })

  it('⚠️ 丢弃必须**留痕**且指名丢的是什么（静默丢弃等于把账算到模型头上）', async () => {
    const { adapter, warnings } = makeAdapter()
    await streamOnce(adapter, 'xopglm52', 'bogus-value')
    expect(
      warnings.some((w) => w.includes('bogus-value')),
      '丢弃档位时必须有告警，且要指名丢的是什么',
    ).toBe(true)
  })

  it('合法档位不得产生任何丢弃告警（防「无脑 warn」把日志刷满）', async () => {
    const { adapter, warnings } = makeAdapter()
    await streamOnce(adapter, 'xopglm52', 'high')
    expect(warnings).toEqual([])
  })

  it('用户未指定档位时不发该字段（走上游默认）', async () => {
    const { adapter, bodies, warnings } = makeAdapter()
    await streamOnce(adapter, 'xopglm52')
    expect(reasoningEffortOf(bodies[0])).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('★★ 只有 defaultEffort（单档）的模型必须**放行**那一档 —— 播报与门禁同源', async () => {
    // ⚠️⚠️ 2026-10-18 审计 P1：宿主被告知的是 `astudioReasoningOf()` 的输出，
    //    它有一条「远端只给 `default_reasoning_level` ⇒ **单档**」的腿；而门禁修前
    //    直接读**原始** `entry.efforts` ⇒ 那种模型播报 `['high']`、门禁却算出空集合
    //    ⇒ 用户**唯一可选**的档位被静默丢弃，且 warn 文案是**假的**
    //    （「上游目录未对该模型声明任何思考档位」——可它明明声明了）。
    //    端到端实测（审计探针）：播报 `["high"]` / 上行 `undefined` / warn 如上。
    const { adapter, bodies, warnings } = makeAdapter({
      remote: async () => [remoteModel('single-effort', { efforts: undefined, defaultEffort: 'high' })],
    })
    // 先让远端目录落地（否则 `catalogSource()` 还是兜底表）。
    const listed = await adapter.listModels('astudio')
    expect(listed.map((m) => m.id)).toContain('single-effort')
    await streamOnce(adapter, 'single-effort', 'high')
    expect(
      reasoningEffortOf(bodies[0]),
      '单档模型的唯一档位必须放行（修前被丢弃且打假告警）',
    ).toBe('high')
    expect(warnings, '不得为单档模型打「未声明任何档位」的假告警').toEqual([])
  })
})