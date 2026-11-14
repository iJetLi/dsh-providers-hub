/**
 * 聚合调用 qoder 遇到上游排队（`10605`）时必须**切换下一个候选**；
 * 直连 qoder 时仍按 `DSH_QODER_QUEUE_WAIT_MODE` 等待 / 向下游报排队。
 *
 * ## 真实故障（2026-11-14，NAS 生产日志）
 *
 * ```
 * 01:31:07.636 [aggregate] accio（glm-5-3-flash）失败，切换下一个候选
 * 01:31:07.967 [qoder] qoder 上游排队（10605）：等待 10000ms（模式 wait，…）
 * （此后该请求再无日志；客户端 90s / 240s 收不到一个字节）
 * ```
 *
 * - `wait` 档：qoder 静默等待（上限 30 分钟）⇒ 聚合等不到错误、不切换；
 * - `visible` 档：qoder 先吐空 `text-delta` ⇒ 聚合判「已产出内容」⇒ 禁止切换。
 *
 * ⚠️ 本文件用**真实 `QoderAdapter`**（只替换 fetch / sleep），并让 `ctx.llm.stream`
 *    按宿主 `adapterStream` 的形状**嵌套一层异步生成器 + 一次定时器跳转** ——
 *    标记靠 `AsyncLocalStorage` 传递，只有走过这种嵌套才证明它真的到得了适配器。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AggregateAdapter, AGGREGATE_PROVIDER } from '../../src/aggregate-adapter.js'
import { pickDiversified } from '../../src/aggregate-core.js'
import { bindAggregateDispatch, isInsideAggregateDispatch } from '../../src/aggregate-dispatch-context.js'
import { QoderAdapter, resolveEffectiveQueueWaitMode } from '../../src/qoder-adapter.js'
import { QODER } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload } from '../../src/qoder.js'

const cred = buildQoderCredential(
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
  { machineId: 'm-1' },
)

/** 国际版真排队（与 `qoder-adapter.spec.ts` 同一份真实报文）。 */
const REAL_QUEUED = {
  isQueued: true, modelKey: 'qfmodel', queueCount: 0, queueType: 'p3',
  retryAfterSeconds: 30, serviceAvailable: false, waitTime: 30,
}

function queueResponse(): Response {
  return new Response(
    JSON.stringify({ code: '10605', message: JSON.stringify(REAL_QUEUED) }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  )
}

const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

const previousMode = process.env.DSH_QODER_QUEUE_WAIT_MODE
afterEach(() => {
  if (previousMode === undefined) delete process.env.DSH_QODER_QUEUE_WAIT_MODE
  else process.env.DSH_QODER_QUEUE_WAIT_MODE = previousMode
})

function setMode(mode: string | undefined): void {
  if (mode === undefined) delete process.env.DSH_QODER_QUEUE_WAIT_MODE
  else process.env.DSH_QODER_QUEUE_WAIT_MODE = mode
}

/** 一个恒排队的真实 qoder 适配器；记录 sleep 与 warn。 */
function makeQueuedQoder() {
  const sleeps: number[] = []
  const warns: string[] = []
  const fetchImpl = vi.fn(async () => queueResponse()) as unknown as typeof fetch
  const qoder = new QoderAdapter({
    credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
    resolveCredential: async () => cred,
    refresh: async () => {},
    product: QODER,
    fetchImpl,
    warn: (message: string) => { warns.push(message) },
    sleep: async (ms: number) => { sleeps.push(ms) },
  } as never)
  return { qoder, sleeps, warns, fetchImpl }
}

/**
 * 造一个两候选的聚合世界：手工顺序 qoder 在前、buddy 在后。
 *
 * `ctx.llm.stream` 模拟宿主 `adapterStream`：外层异步生成器 + 一次 `setTimeout`
 * 跳转（中间件常见形态）+ 适配器失败归一化成 `finish/error` 终止帧。
 */
function makeWorld(qoder: QoderAdapter) {
  const sent: string[] = []
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'qoder' }, { id: 'buddy' }],
      listModels: async (provider: string) => [
        { id: 'deepseek-v4.1-flash', name: `Deepseek-V4.1-Flash · ${provider}` },
      ],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: (o: { provider: string; messages: unknown }) => {
        sent.push(o.provider)
        return (async function* () {
          await new Promise((resolve) => { setTimeout(resolve, 0) })
          if (o.provider !== 'qoder') {
            yield { type: 'text-delta', index: 0, text: 'ok' }
            return
          }
          try {
            for await (const chunk of qoder.stream({ model: 'qfmodel', messages: o.messages } as never)) {
              yield chunk
            }
          } catch (error) {
            const e = error as { message?: string; code?: string }
            yield { type: 'finish', reason: { kind: 'error', failure: { message: e.message ?? '', code: e.code } } }
          }
        })()
      },
    },
  } as never
  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never
  const adapter = new AggregateAdapter(ctx, {
    accountPool: pool,
    expiryProbe: async () => 100,
    // qoder 未接入临期折算 ⇒ 默认不参与，需显式放行（与面板「打开」同一路径）。
    allowed: () => ({ 'deepseek-v4-1-flash': { qoder: { 'deepseek-v4.1-flash': true } } }),
    orderMode: () => 'manual',
    order: () => ({ 'deepseek-v4-1-flash': ['qoder\u0000deepseek-v4.1-flash', 'buddy\u0000deepseek-v4.1-flash'] }),
  })
  return { adapter, sent }
}

async function drainText(adapter: AggregateAdapter): Promise<string> {
  const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
  let text = ''
  for await (const chunk of call.stream({ messages: MESSAGES } as never)) {
    const c = chunk as { type: string; text?: string }
    if (c.type === 'text-delta' && typeof c.text === 'string') text += c.text
  }
  return text
}

describe('聚合调用 qoder：排队即切换下一个候选', () => {
  for (const mode of [undefined, 'wait', 'visible', 'fast'] as const) {
    it(`DSH_QODER_QUEUE_WAIT_MODE=${mode ?? '（未设置）'}：不等待、不吐心跳，直接切到 buddy`, async () => {
      setMode(mode)
      const { qoder, sleeps, warns, fetchImpl } = makeQueuedQoder()
      const { adapter, sent } = makeWorld(qoder)

      const text = await drainText(adapter)

      expect(sent, '先发 qoder（手工序第一），排队后切到 buddy').toEqual(['qoder', 'buddy'])
      expect(text, 'buddy 的回答完整到达，没有混入 qoder 的空心跳').toBe('ok')
      // ⚠️ 关键：一次 sleep 都不能有 —— 有就说明 qoder 在聚合里排队等待了（故障原形）。
      expect(sleeps).toEqual([])
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      // 排队必须留痕，且说清是「聚合调用」导致的不等待（排障时与直连 fast 档区分）。
      // ⚠️ 判据必须**精确到整句**：只查「排队」「聚合」两个子串时，把文案换成
      //    「排队聚合」也照样绿（对抗审计 E30 实测）。
      expect(warns.join('\n')).toContain('（聚合调用，交由聚合切换下一个候选）')
    })
  }
})

describe('pickDiversified：auto 名额不被一家占满', () => {
  const c = (provider: string, id: string) => ({ provider, realId: id })
  it('第一轮每家最多 2 个，保持原序；名额有剩再按原序补齐', () => {
    const ranked = [c('qoder', 'a'), c('qoder', 'b'), c('qoder', 'c'), c('qoder', 'd'), c('buddy', 'x'), c('trae', 'y')]
    expect(pickDiversified(ranked, 4).map((x) => `${x.provider}/${x.realId}`))
      .toEqual(['qoder/a', 'qoder/b', 'buddy/x', 'trae/y'])
    expect(pickDiversified(ranked, 6).map((x) => `${x.provider}/${x.realId}`))
      .toEqual(['qoder/a', 'qoder/b', 'buddy/x', 'trae/y', 'qoder/c', 'qoder/d'])
  })
  it('只有一家渠道时总名额不变（补齐轮用回同家的第 3、4 个）', () => {
    const ranked = [c('qoder', 'a'), c('qoder', 'b'), c('qoder', 'c')]
    // ⚠️ 不能只断言 `toHaveLength(3)`：那样对**顺序与身份**全盲（正序、反序、
    //    换成别家的三个都过）⇒ 正向审计 P3-④ 实测「把 picked 反序仍绿」。
    expect(pickDiversified(ranked, 3).map((x) => `${x.provider}/${x.realId}`))
      .toEqual(['qoder/a', 'qoder/b', 'qoder/c'])
  })
  it('★★ 名额本身小于「每家 2 个」时，配额必须跟着收缩（正向审计 P2-1）', () => {
    const ranked = [c('qoder', 'a'), c('qoder', 'b'), c('qoder', 'c'), c('buddy', 'x')]
    // 故障形态：`limit` 只取 2 时若仍按 `perProvider = 2` 收，第一轮就吃满
    // `[qoder/a, qoder/b]` —— 「名额被一家占满」原样存在，修法**静默失效**。
    // 而 `limit = maxAttemptsFor(catalog)` = 最长候选表的长度，只登录两家的部署里
    // 它**恰好就是 2** ⇒ 这不是理论边界。
    expect(pickDiversified(ranked, 2).map((x) => `${x.provider}/${x.realId}`))
      .toEqual(['qoder/a', 'buddy/x'])
    // ⚠️ 只有 1 个名额时没有「第二个名额」可分，必须退化成 `slice`（不能为了分散
    //    而少试候选，那会让「末位候选永远轮不到」重现）。
    expect(pickDiversified(ranked, 1).map((x) => `${x.provider}/${x.realId}`))
      .toEqual(['qoder/a'])
  })
  it('★ 退化的 perProvider（<= 0 / 非有限）等价 slice（口径已文档化，正向审计 P3-⑧）', () => {
    const ranked = [c('qoder', 'a'), c('qoder', 'b'), c('qoder', 'c'), c('buddy', 'x')]
    expect(pickDiversified(ranked, 3, 0).map((x) => `${x.provider}/${x.realId}`))
      .toEqual(['qoder/a', 'qoder/b', 'qoder/c'])
    expect(pickDiversified(ranked, 3, Number.POSITIVE_INFINITY).map((x) => `${x.provider}/${x.realId}`))
      .toEqual(['qoder/a', 'qoder/b', 'qoder/c'])
  })
  it('名额小于第一轮时按原序截断，不改传入数组', () => {
    const ranked = [c('buddy', 'x'), c('qoder', 'a'), c('qoder', 'b')]
    const snapshot = JSON.stringify(ranked)
    expect(pickDiversified(ranked, 2).map((x) => x.provider)).toEqual(['buddy', 'qoder'])
    expect(JSON.stringify(ranked)).toBe(snapshot)
  })
})

describe('aggregate/auto：qoder 整体排队时轮到别家（复现 2026-11-14 生产日志）', () => {
  it('qoder 免费模型排在最前且全部排队 ⇒ 仍能切到 buddy 拿到回答', async () => {
    setMode(undefined)
    const { qoder, sleeps } = makeQueuedQoder()
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'qoder' }, { id: 'buddy' }, { id: 'codearts' }],
        // m1 有三家候选 ⇒ 最长候选表 = 3 ⇒ auto 的名额 = 3。
        // qoder 的三个模型都是免费（倍率 0）⇒ 排序后 auto 的前 3 名全是 qoder（故障原形）。
        listModels: async (provider: string) => (provider === 'qoder'
          ? [{ id: 'm1', name: 'M1 · 免费' }, { id: 'm2', name: 'M2 · 免费' }, { id: 'm3', name: 'M3 · 免费' }]
          : [{ id: 'm1', name: `M1 · ${provider} · x1` }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string; messages: unknown }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () {
            await new Promise((resolve) => { setTimeout(resolve, 0) })
            if (o.provider !== 'qoder') {
              yield { type: 'text-delta', index: 0, text: 'ok' }
              return
            }
            try {
              for await (const chunk of qoder.stream({ model: 'qfmodel', messages: o.messages } as never)) yield chunk
            } catch (error) {
              const e = error as { message?: string; code?: string }
              yield { type: 'finish', reason: { kind: 'error', failure: { message: e.message ?? '', code: e.code } } }
            }
          })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      // buddy / codearts 都是永久积分（NEVER），与 qoder 同档 ⇒ 按倍率排，qoder 免费在前。
      expiryProbe: async () => Number.POSITIVE_INFINITY,
      allowed: () => ({
        m1: { qoder: { m1: true } },
        m2: { qoder: { m2: true } },
        m3: { qoder: { m3: true } },
      }),
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'auto')
    let text = ''
    for await (const chunk of call.stream({ messages: MESSAGES } as never)) {
      const ch = chunk as { type: string; text?: string }
      if (ch.type === 'text-delta' && typeof ch.text === 'string') text += ch.text
    }

    expect(text, 'qoder 全部排队后应由别家给出回答').toBe('ok')
    expect(sent.slice(0, 2).every((s) => s.startsWith('qoder/')), '排序偏好不变：免费的 qoder 仍先试').toBe(true)
    expect(sent[2], '第 3 个名额让给别家，而不是 qoder 的第 3 个模型').toMatch(/^(buddy|codearts)\//)
    expect(sleeps).toEqual([])
  })
})

describe('aggregate/auto：只有两家渠道（limit 恰好是 2）时也必须分散（对抗审计 P1-1）', () => {
  /**
   * ⚠️⚠️ 这是对抗审计实测出来的**硬边界**：`limit = maxAttemptsFor(catalog)` 是「最长
   * 候选表的长度」，**只登录两家**的部署里它恰好是 2 —— 而配额若恒为 2，第一轮就吃满
   * `[qoder/m1, qoder/m2]`，`pickDiversified` 逐元素等价于被证伪的 `slice`，
   * 2026-11-14 的生产故障**原样复现**（只是把「9 次」换成「2 次」）。
   *
   * 夹具刻意做成「两家」：qoder 有 m1/m2/m3 三个免费模型，buddy 只有 m1 ⇒
   * 虚拟模型 m1 有 2 个候选（`qoder+m1` 与 `buddy+m1`）⇒ `maxAttemptsFor` = **2**。
   */
  it('qoder 三个模型全排队 + 只有 buddy 一家备选 ⇒ 仍必须切到 buddy', async () => {
    setMode(undefined)
    const { qoder } = makeQueuedQoder()
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'qoder' }, { id: 'buddy' }],
        listModels: async (provider: string) => (provider === 'qoder'
          ? [{ id: 'm1', name: 'M1 · 免费' }, { id: 'm2', name: 'M2 · 免费' }, { id: 'm3', name: 'M3 · 免费' }]
          : [{ id: 'm1', name: `M1 · ${provider} · x1` }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string; messages: unknown }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () {
            await new Promise((resolve) => { setTimeout(resolve, 0) })
            if (o.provider !== 'qoder') {
              yield { type: 'text-delta', index: 0, text: 'ok' }
              return
            }
            try {
              for await (const chunk of qoder.stream({ model: 'qfmodel', messages: o.messages } as never)) yield chunk
            } catch (error) {
              const e = error as { message?: string; code?: string }
              yield { type: 'finish', reason: { kind: 'error', failure: { message: e.message ?? '', code: e.code } } }
            }
          })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async () => Number.POSITIVE_INFINITY,
      allowed: () => ({
        m1: { qoder: { m1: true } },
        m2: { qoder: { m2: true } },
        m3: { qoder: { m3: true } },
      }),
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'auto')
    let text = ''
    for await (const chunk of call.stream({ messages: MESSAGES } as never)) {
      const ch = chunk as { type: string; text?: string }
      if (ch.type === 'text-delta' && typeof ch.text === 'string') text += ch.text
    }

    expect(text, '只有两家渠道时 qoder 全排队也必须切到 buddy').toBe('ok')
    expect(sent, 'limit=2 时第一轮每家只取 1 个（配额必须按 limit 收缩）')
      .toEqual(['qoder/m1', 'buddy/m1'])
  })
})

describe('直连 qoder：仍按环境变量处理（行为不变）', () => {
  it('visible 档：直连时照常向下游吐排队提示帧，不受聚合改动影响', async () => {
    setMode('visible')
    process.env.DSH_QODER_QUEUE_HEARTBEAT_MS = '5000'
    try {
      const { qoder } = makeQueuedQoder()
      const iterator = qoder.stream({ model: 'qfmodel', messages: MESSAGES } as never)[Symbol.asyncIterator]()
      const first = await iterator.next()
      await iterator.return?.()
      expect(first.done).toBe(false)
      expect((first.value as { qoderQueue?: { queued?: boolean } }).qoderQueue?.queued).toBe(true)
    } finally {
      delete process.env.DSH_QODER_QUEUE_HEARTBEAT_MS
    }
  })

  it('聚合派发结束后标记不泄漏：随后的直连调用按环境变量走', async () => {
    setMode('visible')
    const { qoder } = makeQueuedQoder()
    const { adapter } = makeWorld(qoder)
    await drainText(adapter)
    expect(isInsideAggregateDispatch()).toBe(false)
    expect(resolveEffectiveQueueWaitMode()).toEqual({ mode: 'visible', viaAggregate: false })
  })
})

describe('bindAggregateDispatch：标记跨 yield 保持', () => {
  it('内层生成器在第 2、3 个 chunk 处仍看得到标记（消费者在上下文外 await 也一样）', async () => {
    const seen: boolean[] = []
    async function* inner() {
      for (let i = 0; i < 3; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 0) })
        seen.push(isInsideAggregateDispatch())
        yield i
      }
    }
    for await (const _ of bindAggregateDispatch(() => inner())) {
      // 消费者处在上下文**之外**：若只在创建时 run 一次，后续 chunk 会丢标记。
      expect(isInsideAggregateDispatch()).toBe(false)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    }
    expect(seen).toEqual([true, true, true])
  })

  it('不经 bindAggregateDispatch 的调用看不到标记', () => {
    expect(isInsideAggregateDispatch()).toBe(false)
    expect(resolveEffectiveQueueWaitMode().viaAggregate).toBe(false)
  })
})

describe('bindAggregateDispatch：三条转发腿各自都在上下文内（P2 守卫）', () => {
  /**
   * ⚠️ 必须用**手写 `AsyncIterator` 对象**，不能用异步生成器 —— 生成器由引擎
   * 提供 `return`/`throw`，替身一换就测不到「转发时有没有 `run`」这一层，
   * 而 `bindAggregateDispatch` 正是靠**手动**转发这三条腿。
   *
   * ⚠️ 第一条 `next()` 必须**给一个值**：`for await` 在 `done: true` 上直接结束、
   * 循环体不执行 ⇒ `break` 也不会发生 ⇒ `return` 腿测不到（我第一版就写成
   * 恒 `done: true`，`insideAtReturn` 恒 `undefined`）。
   */
  function makeRawIterator(options: {
    onReturn?: (inside: boolean) => void
    onThrow?: (inside: boolean) => void
  }): { iterable: AsyncIterable<number>; nextInside: boolean[] } {
    const nextInside: boolean[] = []
    let calls = 0
    const iterable: AsyncIterable<number> = {
      [Symbol.asyncIterator](): AsyncIterator<number> {
        return {
          next: async () => {
            nextInside.push(isInsideAggregateDispatch())
            calls += 1
            return calls === 1 ? { done: false, value: 1 } : { done: true, value: undefined }
          },
          return: async () => {
            options.onReturn?.(isInsideAggregateDispatch())
            return { done: true, value: undefined }
          },
          throw: async () => {
            options.onThrow?.(isInsideAggregateDispatch())
            return { done: true, value: undefined }
          },
        }
      },
    }
    return { iterable, nextInside }
  }

  it('★★ `open` 在上下文内被调用（中间件在创建期就看得到标记）', () => {
    let insideAtOpen: boolean | undefined
    const { iterable } = makeRawIterator({})
    const bound = bindAggregateDispatch(() => {
      insideAtOpen = isInsideAggregateDispatch()
      return iterable
    })
    // `open` 只在取迭代器时才跑（`bindAggregateDispatch` 是惰性的）。
    expect(insideAtOpen).toBeUndefined()
    void bound[Symbol.asyncIterator]()
    expect(insideAtOpen).toBe(true)
  })

  it('★★ `next` 转发时在上下文内', async () => {
    const { iterable, nextInside } = makeRawIterator({})
    for await (const _ of bindAggregateDispatch(() => iterable)) {
      // 消费第一个值（让循环体跑起来），第二次 `next()` 才拿到 `done`
    }
    expect(nextInside).toEqual([true, true])
  })

  it('★★ `return` 转发时在上下文内（提前 `break` 的清理腿）', async () => {
    let insideAtReturn: boolean | undefined
    const { iterable } = makeRawIterator({ onReturn: (inside) => { insideAtReturn = inside } })
    for await (const _ of bindAggregateDispatch(() => iterable)) {
      break
    }
    expect(insideAtReturn).toBe(true)
  })

  it('★★ `throw` 转发时在上下文内', async () => {
    let insideAtThrow: boolean | undefined
    const seen: AsyncIterable<number> = {
      [Symbol.asyncIterator](): AsyncIterator<number> {
        return {
          next: async () => ({ done: false, value: 1 }),
          throw: async () => {
            insideAtThrow = isInsideAggregateDispatch()
            return { done: true, value: undefined }
          },
        }
      },
    }
    const iterator = bindAggregateDispatch(() => seen)[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.throw?.(new Error('boom'))
    expect(insideAtThrow).toBe(true)
  })
})

describe('fast 档的错误码：必须是 `QUEUE`（可分类重试的那一格）', () => {
  /**
   * ⚠️ 为什么这条必须有：`QUEUE` 是**终态**（不在 `DEFAULT_RETRYABLE_CODES`
   * 里，宿主不会白重试）；若把它写成 `SERVER`，宿主会**白重试 5 次**、
   * 且绕过 `dead-model-store` 的 `IGNORED_CODES` 豁免（对抗审计 M11 实测：
   * 把 `QUEUE` 改成 `SERVER` 时全仓 144 条**全绿**）。
   */
  it('★★ 直连 fast 档：`code === \'QUEUE\'`，一次都不等，且日志**不许**提「聚合」', async () => {
    setMode('fast')
    const { qoder, sleeps, warns } = makeQueuedQoder()
    await expect(async () => {
      for await (const _ of qoder.stream({ model: 'qfmodel', messages: MESSAGES } as never)) {
        // 不该有 chunk
      }
    }).rejects.toMatchObject({ code: 'QUEUE' })
    expect(sleeps).toEqual([])
    /**
     * ⚠️ 直连时的日志**必须与 base 逐字节相同**（正向审计实测：同一字符串）。
     * 若 `viaAggregate` 恒 `true`，这里会变成「聚合调用…」⇒ 排障时用户会
     * 以为自己走了聚合（而其实没有）。
     */
    const log = warns.join('\n')
    expect(log).toContain('未等待')
    expect(log, '直连不该出现「聚合调用」字样').not.toContain('聚合调用')
  })
})
