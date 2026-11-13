/**
 * **单候选虚拟模型**上的排队：聚合不能把「可恢复的排队」翻成「硬失败」。
 *
 * ## 为什么必须有这个文件（真实缺陷，2026-11-14）
 *
 * PR #72 的修法是「在聚合里给一次派发挂上『我是聚合调用』的标记」，渠道据此把
 * 「暂时排队（10605）」改判成**本候选失败**，好让聚合切到下一个候选。
 *
 * 但 `buildVirtualModels()`（`src/aggregate-catalog.ts:59`）**不按 `candidates >= 2`
 * 过滤** —— 任何渠道**独有**的模型在聚合里都是**单候选**（qoder 走 `name` 通道，
 * 它的 `ultimate` / `performance` / `efficient` / `sonus` / `cantus` 都是）。
 * 单候选时 `dispatch()` 的切换条件是 `index + 1 < targets.length` = **false**
 * ⇒ 无处可切 ⇒ 标记让渠道吐 `QUEUE`，聚合又切不了 ⇒ **本可恢复的排队变成必然失败**。
 *
 * 实测对照（同一探针，两棵树）：
 *
 * | 树 | 结果 |
 * | --- | --- |
 * | base（不挂标记） | `ok` —— 等 2 次排队后第 3 次成功 |
 * | 挂标记（PR 原样） | `LlmError … code=QUEUE` 立即失败 |
 *
 * ⇒ 修法：**只在还有下一个候选时才挂标记**（最后一个候选没有退路，等总比死好）。
 *   用户显式设 `DSH_QODER_QUEUE_WAIT_MODE=fast` 时仍然立即失败 —— 那是用户的选择，
 *   由 `resolveQueueWaitMode()` 负责，与聚合标记无关。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AggregateAdapter, AGGREGATE_PROVIDER } from '../../src/aggregate-adapter.js'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import { QODER } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload } from '../../src/qoder.js'

const cred = buildQoderCredential(
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
  { machineId: 'm-1' },
)

/** 国际版真排队报文（与 `qoder-adapter.spec.ts` 同一份）。 */
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

function successResponse(): Response {
  const textFrame = JSON.stringify({ choices: [{ delta: { content: 'ok' }, index: 0 }] })
  const finishFrame = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
  return new Response(
    `event: message\ndata: ${textFrame}\ndata: ${finishFrame}\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
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

/**
 * 造一个**单候选**世界：虚拟模型 `ultimate` 只有 qoder 一个候选。
 *
 * `ctx.llm.stream` 仍按宿主 `adapterStream` 的形状嵌套（外层异步生成器 + 一次
 * 定时器跳转 + 适配器失败归一化成终止帧），否则标记的传递链就不真实。
 */
function makeSingleCandidateWorld(qoder: QoderAdapter) {
  const sent: string[] = []
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'qoder' }],
      listModels: async (provider: string) => [
        { id: 'ultimate', name: `Ultimate · ${provider}` },
      ],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: (o: { provider: string; messages: unknown; model?: string }) => {
        sent.push(o.provider)
        return (async function* () {
          await new Promise((resolve) => { setTimeout(resolve, 0) })
          try {
            for await (const chunk of qoder.stream({
              model: o.model ?? 'ultimate',
              messages: o.messages,
            } as never)) {
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
    // 只有 qoder 一个渠道声明了这个模型 ⇒ 虚拟模型只有一个候选。
    allowed: () => ({ ultimate: { qoder: { ultimate: true } } }) as never,
    orderMode: () => 'manual',
    order: () => ({ ultimate: ['qoder\u0000ultimate'] }) as never,
  })
  return { adapter, sent }
}

function makeQoder(fetchImpl: typeof fetch): { qoder: QoderAdapter; sleeps: number[]; warns: string[] } {
  const sleeps: number[] = []
  const warns: string[] = []
  const qoder = new QoderAdapter({
    credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
    resolveCredential: async () => cred,
    refresh: async () => {},
    product: QODER,
    fetchImpl,
    warn: (message: string) => { warns.push(message) },
    sleep: async (ms: number) => { sleeps.push(ms) },
  } as never)
  return { qoder, sleeps, warns }
}

async function drain(adapter: AggregateAdapter): Promise<{ text: string; thrown?: { message: string; code?: string } }> {
  const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'ultimate')
  let text = ''
  try {
    for await (const chunk of call.stream({ messages: MESSAGES } as never)) {
      const c = chunk as { type: string; text?: string }
      if (c.type === 'text-delta' && typeof c.text === 'string') text += c.text
    }
  } catch (error) {
    const e = error as { message?: string; code?: string }
    return { text, thrown: { message: e.message ?? '', code: e.code } }
  }
  return { text }
}

describe('单候选虚拟模型：可恢复的排队必须等到成功，不许翻成硬失败', () => {
  it('★★★ 排队两次后第 3 次 200 ⇒ text=ok（聚合没有余量，只能等）', async () => {
    setMode(undefined)
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return calls <= 2 ? queueResponse() : successResponse()
    }) as unknown as typeof fetch
    const { qoder, sleeps } = makeQoder(fetchImpl)
    const { adapter, sent } = makeSingleCandidateWorld(qoder)

    const { text, thrown } = await drain(adapter)

    expect(thrown, `单候选上不许抛错 —— 排队是本可恢复的。实测：${thrown?.message ?? ''}`).toBeUndefined()
    expect(text).toBe('ok')
    expect(sent, '只发过一次候选（单候选）').toEqual(['qoder'])
    /**
     * ⚠️⚠️ 这一条是**修复的直接判据**：挂标记时 qoder 走 `fast` 档 ⇒
     * `sleeps` 为空、`fetch` 只 1 次、直接抛 `QUEUE`。等到成功必须**真的等过**。
     */
    expect(sleeps.length, 'wait 档每轮排队等一次 ⇒ 两次').toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('★★ 用户显式设 fast ⇒ 单候选也立即失败（这是用户的选择，不许被「不挂标记」抹掉）', async () => {
    setMode('fast')
    const fetchImpl = vi.fn(async () => queueResponse()) as unknown as typeof fetch
    const { qoder, sleeps } = makeQoder(fetchImpl)
    const { adapter } = makeSingleCandidateWorld(qoder)

    const { thrown } = await drain(adapter)

    expect(thrown?.code, '`fast` 是用户显式选择 ⇒ 必须还是 QUEUE').toBe('QUEUE')
    expect(sleeps, '`fast` 一次都不等').toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
