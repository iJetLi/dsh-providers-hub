import { afterEach, describe, expect, it } from 'vitest'
import {
  channelOfOptions,
  markGatewayChannel,
  GATEWAY_CHANNEL_MARK,
} from '../../src/openai-gateway/channel.js'
import { registerAdapterIdempotent, recordThroughStream, wrapAdapterWithTokenLedger } from '../../src/llm-register-compat.js'
import { withDeadModelPruning } from '../../src/dead-model-store.js'
import {
  MIN_DECODE_MS_FOR_TPS,
  attachTokenLedgerStore,
  peekLedgerAccount,
  readTokenLedger,
  readTokenLedgerDayMap,
  recordTokenUsage,
  reportLedgerAccount,
  resetLedgerAccountsForTests,
  resetTokenLedgerForTests,
} from '../../src/token-ledger.js'
import type { TokenLedgerDayMap, TokenLedgerEntry } from '../../src/token-ledger.js'

/** 假适配器产出的 usage chunk（dsh-llm 契约形状）。 */
function usageChunk(input: number, output: number, extra: Record<string, number> = {}) {
  return { type: 'usage', usage: { inputTokens: input, outputTokens: output, ...extra } }
}

/** 极简假适配器：按脚本逐帧吐出，可选拒绝。 */
function fakeAdapter(script: () => AsyncIterable<unknown>) {
  return { stream: () => script(), resolveModel: () => 'stub' }
}

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of it) out.push(chunk)
  return out
}

afterEach(() => {
  resetTokenLedgerForTests()
  resetLedgerAccountsForTests()
})

describe('channelOfOptions / markGatewayChannel', () => {
  it('打过标 = gateway；未打标对象 / 非对象 = direct', () => {
    const marked = markGatewayChannel({ model: 'GLM-5.2' })
    expect(channelOfOptions(marked)).toBe('gateway')
    expect(channelOfOptions({ model: 'GLM-5.2' })).toBe('direct')
    expect(channelOfOptions(null)).toBe('direct')
    expect(channelOfOptions(undefined)).toBe('direct')
    expect(channelOfOptions('model')).toBe('direct')
  })

  it('mark 是模块级 Symbol：不污染 JSON 序列化与 Object.keys', () => {
    const marked = markGatewayChannel({ model: 'm' })
    expect(Object.keys(marked)).toEqual(['model'])
    expect(JSON.parse(JSON.stringify(marked))).toEqual({ model: 'm' })
    expect((marked as Record<symbol, unknown>)[GATEWAY_CHANNEL_MARK]).toBe(true)
  })

  it('markGatewayChannel 对 sealed 对象不抛错（打不上就保守 direct）', () => {
    const sealed = Object.seal({ model: 'm' })
    expect(() => markGatewayChannel(sealed)).not.toThrow()
    // sealed 允许写已有属性；这里主要验证极端入参（freeze）不炸
    const frozen = Object.freeze({ model: 'm' })
    expect(() => markGatewayChannel(frozen)).not.toThrow()
    expect(channelOfOptions(frozen)).toBe('direct')
  })
})

describe('recordThroughStream：记账骨架', () => {
  it('正常流：透传全部 chunk、记 usage、usageReported=true', async () => {
    resetTokenLedgerForTests()
    const chunks = await collect(recordThroughStream(
      async function* () { yield { type: 'text' }; yield usageChunk(120, 34, { reasoningTokens: 8 }) },
      { channel: 'direct', provider: 'codearts', model: 'GLM-5.2', startedAt: Date.now() - 500 },
    ))
    expect(chunks).toHaveLength(2)
    const snap = readTokenLedger()
    expect(snap.entries).toHaveLength(1)
    const row = snap.entries[0]!
    expect(row.usageReported).toBe(true)
    expect(row.inputTokens).toBe(120)
    expect(row.outputTokens).toBe(34)
    expect(row.reasoningTokens).toBe(8)
    expect(row.provider).toBe('codearts')
    expect(row.model).toBe('GLM-5.2')
    expect(row.channel).toBe('direct')
    expect(row.durationMs).toBeGreaterThanOrEqual(500)
  })

  /**
   * 第 3 期：首字用时在包装层实测（收第一块时打点），TPS 由记账层按官方口径
   * 算（输出 ÷ (全程 − 首块)）。注意生成器**懒执行**：首块的打点时刻是
   * 「消费方真正开始拉流」之后，与发起时刻的差就是真实的首字延迟。
   */
  it('ttft/tps：包装层实测首块时刻，记账层算出速率', async () => {
    resetTokenLedgerForTests()
    // ⚠️ 生成器**内**跨 tick：首块之后 sleep 再收 usage，让
    // durationMs − ttftMs 达到 {@link MIN_DECODE_MS_FOR_TPS} 门槛（tps 的分母下限）。
    //
    // ⚠️ 间隔必须 ≥ 100ms 而非「> 0」：decodeMs 塌缩到个位数毫秒会算出
    // 几十万 tok/s 的假值（真实缺陷 2026-10-07：单笔 1ms 样本把均值从 184
    // 拉到 634592）。旧写法 sleep(30) 恰好落在门槛之下，修复后 tps 正确地
    // 变为「不可测」—— 那是预期行为，不是缺陷。
    const startedAt = Date.now() - 50
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await collect(recordThroughStream(
      async function* () {
        yield { type: 'reasoning-delta', text: 'thinking...' }
        await sleep(MIN_DECODE_MS_FOR_TPS + 30)
        yield usageChunk(10, 100)
      },
      { channel: 'direct', provider: 'p', model: 'm', startedAt },
    ))
    const row = readTokenLedger().entries[0]!
    expect(row.ttftMs).toBeGreaterThan(0)
    expect(row.tps).toBeGreaterThan(0)
  })

  it('⚠️ 首块后间隔过短（< 100ms）⇒ tps 不可测，但 ttft 照常保留', async () => {
    resetTokenLedgerForTests()
    // 守卫方向：不能只测「够长时可测」，还得测「不够长时确实不测」——
    // 否则有人把门槛调到 0，本条仍绿，而 982.5 tok/s 的缺陷会复活。
    const startedAt = Date.now() - 50
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await collect(recordThroughStream(
      async function* () {
        yield { type: 'reasoning-delta', text: 'thinking...' }
        await sleep(MIN_DECODE_MS_FOR_TPS - 70) // 落在门槛之下
        yield usageChunk(10, 100)
      },
      { channel: 'direct', provider: 'p', model: 'm', startedAt },
    ))
    const row = readTokenLedger().entries[0]!
    // 首字用时不受该门槛影响（它测的是「第一个 chunk 何时到」）。
    expect(row.ttftMs).toBeGreaterThan(0)
    expect(row.tps).toBeUndefined()
  })

  it('★★ 明确上报的 cacheReadTokens=0 必须原样落账（PR #122：0 ≠ 未上报）', async () => {
    resetTokenLedgerForTests()
    await collect(recordThroughStream(
      async function* () { yield { type: 'text' }; yield usageChunk(120, 34, { cacheReadTokens: 0 }) },
      { channel: 'direct', provider: 'codearts', model: 'GLM-5.2', startedAt: Date.now() },
    ))
    const row = readTokenLedger().entries[0]!
    // 旧实现 `cacheReadTokens = cacheRead > 0 ? cacheRead : undefined` 会把
    // 「明确没命中」折成「没上报」⇒ 面板命中率与网关对外口径对不上。
    expect(Object.hasOwn(row, 'cacheReadTokens'), '明确 0 必须落账，不能当「没上报」省略').toBe(true)
    expect(row.cacheReadTokens).toBe(0)
  })

  it('流结束但没等到 usage：usageReported=false（显示 — 而不是 0）', async () => {
    resetTokenLedgerForTests()
    await collect(recordThroughStream(
      async function* () { yield { type: 'text' } },
      { channel: 'direct', provider: 'p', model: 'm', startedAt: Date.now() },
    ))
    const row = readTokenLedger().entries[0]!
    expect(row.usageReported).toBe(false)
  })

  it('抛错：先记失败行再原样再抛（记账不吞错）', async () => {
    resetTokenLedgerForTests()
    const boom = new Error('upstream 502')
    await expect(collect(recordThroughStream(
      async function* () { yield usageChunk(10, 5); throw boom },
      { channel: 'gateway', provider: 'qoder', model: 'qfmodel', startedAt: Date.now() },
    ))).rejects.toBe(boom)
    const row = readTokenLedger().entries[0]!
    expect(row.error).toBe('upstream 502')
    expect(row.channel).toBe('gateway')
    // 流内已经到过的 usage 也算「收到过」
    expect(row.usageReported).toBe(true)
    expect(row.inputTokens).toBe(10)
  })

  it('提前 break（消费方 cancel）：finally 兜底落账', async () => {
    resetTokenLedgerForTests()
    for await (const _ of recordThroughStream(
      async function* () { yield 'a'; yield 'b'; yield 'c' },
      { channel: 'direct', provider: 'p', model: 'm', startedAt: Date.now() },
    )) {
      break
    }
    expect(readTokenLedger().entries).toHaveLength(1)
  })

  /**
   * ⚠️⚠️ **取消必须传播到上游适配器**（真实缺陷，本 PR 首版漏掉；两道闸门缺一不可）。
   *
   * 上面那条「提前 break」只断言**记账行数** —— 它在缺陷下**照样通过**（实测），
   * 因为 `recordThroughStream` 自己的 `for await` 有转发语义，断链发生在它消费的
   * `withTokenLedgerAccountContext` 那一层。故必须直接断言**上游 finally 是否执行**。
   *
   * 影响面：上游 `finally` 是各适配器释放 SSE 资源的唯一位置
   * （`reader.cancel()` / `releaseLock()`、zcode 的 `clearTimeout` / 移除 abort 监听）。
   * 不执行 ⇒ 用户点「停止」后连接与定时器一同泄漏（与 zcode「停止按钮无效」事故同型）。
   */
  describe('★ 取消传播：上游 finally 必须执行', () => {
    /** 上游适配器骨架：`finally` 置标志，模拟真实适配器的资源释放。 */
    function guardedStream(released: { value: boolean }) {
      return async function* () {
        try {
          yield { type: 'text' }
          yield { type: 'text' }
          yield { type: 'text' }
        } finally {
          released.value = true
        }
      }
    }

    it('消费方 break ⇒ 上游 finally 执行（缺陷下这条必须变红）', async () => {
      const released = { value: false }
      for await (const _ of recordThroughStream(
        guardedStream(released),
        { channel: 'direct', provider: 'p', model: 'm', startedAt: Date.now() },
      )) {
        break
      }
      // ⚠️ 给微任务队列一次机会（转发是 await 的）。
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(released.value, 'break 后上游 finally 未执行 ⇒ reader/定时器泄漏').toBe(true)
    })

    it('消费方在循环体内抛错（= dsh-agent-loop 的 signal.throwIfAborted 取消路径）⇒ 上游 finally 执行', async () => {
      const released = { value: false }
      await expect((async () => {
        for await (const _ of recordThroughStream(
          guardedStream(released),
          { channel: 'direct', provider: 'p', model: 'm', startedAt: Date.now() },
        )) {
          // 复刻 `dsh-agent-loop/lib/index.js` 的取消：循环体内抛错，而非 break。
          throw new Error('aborted by user')
        }
      })()).rejects.toThrow('aborted by user')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(released.value, 'throw 取消路径下上游 finally 未执行').toBe(true)
    })

    it('显式 iterator.return() ⇒ 上游 finally 执行', async () => {
      const released = { value: false }
      const stream = recordThroughStream(
        guardedStream(released),
        { channel: 'direct', provider: 'p', model: 'm', startedAt: Date.now() },
      )[Symbol.asyncIterator]()
      await stream.next()
      await stream.return?.(undefined)
      expect(released.value).toBe(true)
    })

    it('正常读完整条流时 finally 照常执行（修复不得影响成功路径）', async () => {
      const released = { value: false }
      const chunks = await collect(recordThroughStream(
        guardedStream(released),
        { channel: 'direct', provider: 'p', model: 'm', startedAt: Date.now() },
      ))
      expect(chunks).toHaveLength(3)
      expect(released.value).toBe(true)
    })

    it('不带 finally 的纯 yield* 上游也要能正常读完（回归：转发不得引入异常）', async () => {
      const chunks = await collect(recordThroughStream(
        async function* () { yield { type: 'text' }; yield usageChunk(3, 1) },
        { channel: 'direct', provider: 'p', model: 'm', startedAt: Date.now() },
      ))
      expect(chunks).toHaveLength(2)
    })

    /**
     * ⚠️⚠️ **关闭动作挂起时，原始错误必须仍能传播**（红队复审发现的回归，实测复现）。
     *
     * `finally` 里若无超时地 `await iterator.return()`，而上游关闭永不 resolve
     *（适配器 `finally` 里 `await reader.cancel()` 卡在已断开的连接上），则 `finally`
     * 永不返回 ⇒ **本层已捕获的错误被永久吞掉**，消费方卡死在 `for await` 里
     *（与「停止按钮无效」同型）。修复前实测判为 `HUNG`，加超时后 2s 内抛出原始错误。
     */
    it('★ 上游关闭挂起（return 永不 resolve）⇒ 原始错误仍必须在超时内传播', async () => {
      // 上游：next 抛错；return 永不 resolve（模拟 reader.cancel() 卡在断开的连接上）
      const hangingOpen = () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> { throw new Error('upstream-500') },
            return(): Promise<IteratorResult<unknown>> { return new Promise(() => {}) }, // 永不 resolve
          }
        },
      })
      // 走**真实链路**：recordThroughStream → withTokenLedgerAccountContext → 上游
      const outcome = await Promise.race([
        collect(recordThroughStream(
          hangingOpen,
          { channel: 'direct', provider: 'p', model: 'm', startedAt: Date.now() },
        )).then(() => 'completed', (error: unknown) => `threw:${(error as Error).message}`),
        new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve('HUNG'), 5_000)
          timer.unref?.()
        }),
      ])
      expect(outcome, '关闭挂起吞掉了原始错误 ⇒ 消费方永久卡死').toBe('threw:upstream-500')
    })

    /**
     * ⚠️⚠️ **超时只影响「等待」，不影响「清理是否最终发生」**（如实钉住真实语义）。
     *
     * 实测时间线（本用例的 fixture：上游持续吐帧、关闭动作耗时 3s）：
     * ```
     * return() 开始        @1ms      ← break 后本层立刻转发了关闭信号
     * 消费方 break 返回     @2004ms   ← 2s 超时到，不再等
     * ★ 清理完成            @3009ms   ← 被"放弃"的那个 promise 仍在后台跑完
     * ```
     * 即 `Promise.race` 是**放弃等待**，不是**取消动作** —— 上游清理（`releaseLock()`
     * / `removeEventListener()`）**最终仍会执行**，只是消费方不再阻塞等它。
     *
     * ⚠️⚠️ **这一点曾被写错（首版实现注释 + 两轮审计都称"清理永不执行"），务必按实测写**：
     * 事实是「消费方提前 2s 拿到控制权 + 上游清理延后完成」。这比"永不清理"温和得多，
     * 但仍有真实代价：**清理完成前上游资源（连接/reader/监听器）一直占着**，
     * 高频取消时会有多个清理在后台并发堆积。
     *
     * ⚠️⚠️ **写法要求（首版踩过坑）**：fixture 必须让消费方**真的提前关闭**（`break`），
     * 否则走「正常读完」路径时**根本不会调用 `return()`** —— 那样断言恒真，用例沦为
     * 同义反复（实测：那种写法下把实现改成「后台续跑」，全仓用例照样全绿）。
     */
    it('★ 超时只放弃等待：消费方提前返回，上游清理随后仍在后台完成', async () => {
      const cleanupAt: number[] = []
      const started = Date.now()
      // 上游：持续吐帧（不 done），关闭动作耗时 3s（> 2s 超时）
      const slowCleanupStream = () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              return { value: { type: 'text' }, done: false } // 永不 done
            },
            async return(): Promise<IteratorResult<unknown>> {
              await new Promise((resolve) => setTimeout(resolve, 3_000))
              cleanupAt.push(Date.now() - started)
              return { value: undefined, done: true }
            },
          }
        },
      })

      // 消费方 break ⇒ 真的提前关闭 ⇒ 本层转发 return()
      for await (const _ of recordThroughStream(
        slowCleanupStream,
        { channel: 'direct', provider: 'p', model: 'm', startedAt: Date.now() },
      )) {
        break
      }
      const closeMs = Date.now() - started
      // ① 消费方应在 ~2s（超时）就拿到控制权，而不是等满 3s
      expect(closeMs, `关闭应被超时切断（实测 ${closeMs}ms）`).toBeLessThan(2_900)
      // ② 此刻清理还没跑完（否则说明根本没走超时路径）
      expect(cleanupAt, '此刻不该已完成清理').toEqual([])

      // ③ ★ 关键断言：再等 1.5s（跨过上游那 3s 的清理）—— 清理**应当已经完成**，
      //    证明超时是「不再等」而非「取消动作」。若将来改成真正中止上游（清理永不
      //    发生），这里会变红，提醒同步更新 CLOSE_STREAM_TIMEOUT_MS 的注释。
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(cleanupAt.length, '清理最终未完成 ⇒ 语义已变，请更新注释').toBe(1)
      expect(cleanupAt[0], '清理完成时刻应晚于超时返回时刻').toBeGreaterThan(closeMs)
    })
  })

  /**
   * 第 2 期（账号维度）：包装层在 **usage 帧到达时** 读回报表 —— 此时
   * `resolveCredential` 早已跑完（凭据先于任何 SSE 帧），时序才正确。
   * ⚠️ 若在 stream 开始前读，会拿到「上一笔请求」的账号（生成器懒执行）。
   */
  it('账号归属（第 2 期）：usage 帧时读取回报表，落到账本 accountId', async () => {
    resetTokenLedgerForTests()
    resetLedgerAccountsForTests()
    // 适配器「尚未解析凭据」：openStream 内部先跑了一段才回报（模拟真实时序）
    const chunks = await collect(recordThroughStream(
      async function* () {
        reportLedgerAccount('codearts', 'acct-live')
        yield { type: 'text' }
        yield usageChunk(50, 5)
      },
      { channel: 'direct', provider: 'codearts', model: 'GLM-5.2', startedAt: Date.now() },
    ))
    expect(chunks).toHaveLength(2)
    const row = readTokenLedger().entries[0]!
    expect(row.accountId).toBe('acct-live')
  })

  it('账号归属：失败行不借用共享回报表里的旧账号', async () => {
    resetTokenLedgerForTests()
    resetLedgerAccountsForTests()
    reportLedgerAccount('qoder', 'acct-stale')
    await expect(collect(recordThroughStream(
      async function* () { throw new Error('502') },
      { channel: 'direct', provider: 'qoder', model: 'm', startedAt: Date.now() },
    ))).rejects.toBeDefined()
    const row = readTokenLedger().entries[0]!
    expect(row.error).toBe('502')
    // 没有本请求上下文时必须留空，不能把另一个请求残留的账号标到这笔失败记录。
    expect(row.accountId).toBeUndefined()
  })

  it('账号归属：无人回报时空缺（accountId 缺省，不伪造）', async () => {
    resetTokenLedgerForTests()
    resetLedgerAccountsForTests()
    await collect(recordThroughStream(
      async function* () { yield usageChunk(1, 1) },
      { channel: 'direct', provider: 'lonely', model: 'm', startedAt: Date.now() },
    ))
    expect(readTokenLedger().entries[0]!.accountId).toBeUndefined()
  })

  it('report/peek 回报表基础语义（供 index.ts 的 resolveCredential 调用）', () => {
    resetLedgerAccountsForTests()
    reportLedgerAccount('qoder', 'a1')
    expect(peekLedgerAccount('qoder')).toBe('a1')
    reportLedgerAccount('qoder', 'a2')
    expect(peekLedgerAccount('qoder')).toBe('a2')
    expect(peekLedgerAccount('nope')).toBe('')
  })
})

describe('wrapAdapterWithTokenLedger：包装注册', () => {
  it('包装后的 stream 记账，其余方法原样透传', async () => {
    resetTokenLedgerForTests()
    const adapter = fakeAdapter(async function* () { yield usageChunk(7, 3) })
    const wrapped = wrapAdapterWithTokenLedger(['codearts'], adapter) as typeof adapter
    // 非 stream 方法保留
    expect(wrapped.resolveModel()).toBe('stub')
    await collect(wrapped.stream({ model: 'GLM-5.2' } as never))
    const row = readTokenLedger().entries[0]!
    expect(row.provider).toBe('codearts')
    expect(row.model).toBe('GLM-5.2')
    expect(row.inputTokens).toBe(7)
  })

  it('网关打标经包装层正确落到 channel=gateway（端到端打标→记账）', async () => {
    resetTokenLedgerForTests()
    const adapter = fakeAdapter(async function* () { yield usageChunk(7, 3) })
    const wrapped = wrapAdapterWithTokenLedger(['qoder'], adapter) as typeof adapter
    await collect(wrapped.stream(markGatewayChannel({ model: 'qfmodel' }) as never))
    const row = readTokenLedger().entries[0]!
    expect(row.channel).toBe('gateway')
  })

  it('model 缺失/垃圾值记空串不抛错', async () => {
    resetTokenLedgerForTests()
    const adapter = fakeAdapter(async function* () { yield usageChunk(1, 1) })
    const wrapped = wrapAdapterWithTokenLedger(['p'], adapter) as typeof adapter
    await collect(wrapped.stream(undefined as never))
    expect(readTokenLedger().entries[0]!.model).toBe('')
  })

  it('this 绑定：包装层把 this 还给原适配器（有状态适配器不被拆散）', async () => {
    resetTokenLedgerForTests()
    let seenThis: unknown = null
    const adapter = {
      flag: 42,
      stream(this: { flag: number }) {
        seenThis = this
        return (async function* () { yield usageChunk(1, 1) })()
      },
    }
    const wrapped = wrapAdapterWithTokenLedger(['p'], adapter)
    await collect((wrapped.stream as (o: never) => AsyncIterable<unknown>)(undefined as never))
    expect((seenThis as { flag?: number }).flag).toBe(42)
  })

  /**
   * ⚠️ 真实缺陷回归（2026-10-05）：首版用 `{ ...adapter }` 展开实现包装，
   * **class 实例的原型方法（providerInfo / listModels…）全部丢失** ——
   * buddy 的「注册的适配器与其路由使用同一产品」用例当场变红
   * （`adapter.providerInfo is not a function`）。Proxy 必须把**一切属性
   * 访问**（含原型链）转给原适配器。
   */
  it('原型方法不丢：class 实例包装后 providerInfo / listModels 仍然可用', () => {
    class FakeAdapter {
      hidden = 7
      providerInfo() { return { id: 'workbuddy' } }
      async listModels() { return [{ provider: 'workbuddy' }] }
      async *stream() { yield usageChunk(1, 1) }
    }
    const wrapped = wrapAdapterWithTokenLedger(['workbuddy'], new FakeAdapter()) as unknown as FakeAdapter
    expect(wrapped.providerInfo()).toEqual({ id: 'workbuddy' })
    expect(wrapped.hidden).toBe(7)
    expect(typeof wrapped.listModels).toBe('function')
  })

  it('私有字段：this 绑回原适配器，#field 不因 proxy 而抛 TypeError', async () => {
    resetTokenLedgerForTests()
    class PrivateAdapter {
      #secret = 41
      get secret() { return this.#secret }
      async *stream() {
        // ⚠️ 读 this.#secret：若包装层把 this 绑成 proxy，这里会直接 TypeError
        yield usageChunk(this.#secret, 1)
      }
    }
    const wrapped = wrapAdapterWithTokenLedger(['p'], new PrivateAdapter())
    await collect((wrapped.stream as (o: never) => AsyncIterable<unknown>)(undefined as never))
    const row = readTokenLedger().entries[0]!
    expect(row.inputTokens).toBe(41)
    expect(row.usageReported).toBe(true)
  })
})

/**
 * ★ 回归（复审发现的真实风险）：**插件 fiber 重启交错时，旧实例的 dispose
 * 不得摘掉新实例挂上的钩子**。
 *
 * `llm-register-compat.ts` 模块头已记载本仓库的真实事故：cordis 重启插件 fiber
 * 时，新 fiber 的同步 apply 与旧 fiber 的**异步 dispose 交错执行**（旧 dispose
 * 会追上来）。而 `index.ts` 原先在 dispose 里**无条件**摘钩子 ⇒ 一旦交错命中，
 * 新一轮挂的钩子立刻被旧一轮摘掉 → **落盘彻底停摆 + 历史视图恒为空**。
 *
 * ⚠️ 这条用**真实的 `attachTokenLedgerStore`**（而不是把接线抄一份进测试）：
 * 抄写式的断言只能证明副本自洽，改动真实接线时不会失败（与 `buddy-wiring.spec.ts`
 * 同款纪律）。
 */
describe('★ attachTokenLedgerStore：成对挂载与所有权校验（fiber 重启交错）', () => {
  /** 假 store：只记录收到哪些 entry，读侧返回固定表。 */
  function fakeStore(label: string) {
    const appended: string[] = []
    const days: TokenLedgerDayMap = new Map()
    return {
      label,
      appended,
      /** 与真实 `FileLedgerStore` 同形：append(entry) / load()。 */
      append: (entry: TokenLedgerEntry) => { appended.push(label) },
      load: () => days,
    }
  }
  const usage = () => ({
    channel: 'direct' as const, provider: 'codearts', model: 'GLM-5.2',
    usageReported: true, inputTokens: 1, outputTokens: 1, durationMs: 1,
  })

  afterEach(() => {
    // 每条用例后清干净，避免钩子泄漏到后续用例（模块级单例）。
    attachTokenLedgerStore(undefined)
  })

  it('正常挂载：记账落盘回调与历史读取器都生效', () => {
    const store = fakeStore('A')
    attachTokenLedgerStore(store as never)
    recordTokenUsage(usage())
    expect(store.appended).toEqual(['A'])
    expect(readTokenLedgerDayMap()).toBe(store.load())
  })

  it('★ 旧实例 dispose 不得摘掉新实例的钩子（交错时序）', () => {
    // ── fiber 第 1 轮 ──
    const old = fakeStore('old')
    const disposeOld = attachTokenLedgerStore(old as never)
    // ── fiber 第 2 轮：新 apply 先跑完 ──
    const fresh = fakeStore('new')
    const disposeNew = attachTokenLedgerStore(fresh as never)
    // ── 旧 fiber 的异步 dispose 追上来（真实事故的时序）──
    disposeOld()
    // 修复前：钩子被清空 ⇒ 落盘停摆、历史视图恒空
    recordTokenUsage(usage())
    expect(fresh.appended, '新实例必须仍在收账').toEqual(['new'])
    expect(old.appended, '旧实例不得再收账').toEqual([])
    expect(readTokenLedgerDayMap()).toBe(fresh.load())
    void disposeNew
  })

  it('★ 卸载语义：当前实例自己 dispose 后钩子才真的清空', () => {
    const store = fakeStore('only')
    const dispose = attachTokenLedgerStore(store as never)
    dispose()
    recordTokenUsage(usage())
    expect(store.appended).toEqual([])
    expect(readTokenLedgerDayMap().size).toBe(0)
  })

  it('★ dispose 幂等且不乱摘：重复调用第二次不得影响后续实例', () => {
    const first = fakeStore('1')
    const disposeFirst = attachTokenLedgerStore(first as never)
    disposeFirst()
    const second = fakeStore('2')
    attachTokenLedgerStore(second as never)
    // 旧 disposer 再被调用一次（cordis 重入）：不得摘掉 second
    disposeFirst()
    recordTokenUsage(usage())
    expect(second.appended).toEqual(['2'])
  })

  /**
   * ★ 回归（审计发现：原用例锁的其实是**所有权校验**，幂等守卫并未被覆盖
   * —— 删掉 `if (disposed) return` 后 61 条用例全绿）。
   *
   * 唯一能观测到幂等守卫的时序是「dispose 后**重新挂载同一个对象**，再重入调用
   * 旧 disposer」。此时所有权令牌已换代，只有幂等守卫能挡住第二次摘除。
   *
   * ⚠️ 且判据**必须用每次挂载新生成的令牌**，不能用 `backend === owned`：
   * 同一对象重复挂载时对象相等无法区分两次挂载（审计已复现该误摘）。
   */
  it('★ 同一后端重复挂载：旧 disposer 不得摘掉后一次挂载（令牌判据）', () => {
    const shared = fakeStore('SHARED')
    const disposeFirst = attachTokenLedgerStore(shared as never)
    // 重新挂载**同一个对象**（对象相等，旧判据在此失效）
    attachTokenLedgerStore(shared as never)
    disposeFirst() // 旧 disposer 追上来
    recordTokenUsage(usage())
    expect(shared.appended, '重新挂载的后端必须仍在收账').toEqual(['SHARED'])
    expect(readTokenLedgerDayMap()).toBe(shared.load())
  })

  it('★ 幂等守卫：卸载后重新挂载，重入旧 disposer 不得摘掉新挂载', () => {
    const store = fakeStore('S')
    const dispose = attachTokenLedgerStore(store as never)
    dispose()
    attachTokenLedgerStore(store as never) // 重新挂同一个对象
    dispose() // 重入：令牌已换代 ⇒ 必须让位
    recordTokenUsage(usage())
    expect(store.appended).toEqual(['S'])
  })
})

/**
 * ★★ 回归（合并 PR 66 时发现的**顺序敏感**致命隐患，2026-10-06）
 *
 * `registerAdapterIdempotent` 里现在有**两层** Proxy 包装：Token 记账
 * （`wrapAdapterWithTokenLedger`）与「已失效模型」剔除（`withDeadModelPruning`，
 * PR 66 引入）。**两者的嵌套顺序是语义性的，写反不会报错，只会让记账静默失效。**
 *
 * ## 为什么顺序有语义
 *
 * dsh-llm 的 `adapterStream` 走的是 `adapter.prepareCall(...)` 返回的
 * `adapterCall.stream(options)`（`dsh-llm/lib/index.js`：
 * `dispatch = (options) => adapterCall.stream(options)`），
 * **不直接调用顶层 `adapter.stream`**。
 *
 * 而本仓库**全部**适配器的 `prepareCall` 都写成转发形式：
 *
 * ```ts
 * stream: (options) => this.stream(options)
 * ```
 *
 * ⇒ 记账是否生效取决于 `prepareCall` 执行时 **`this` 指向谁**：
 * - **记账在内**（正确）：剔除层用 `.apply(obj, …)` 调用，`obj` 是它包着的
 *   **记账 Proxy** ⇒ `this` = 记账 Proxy ⇒ `this.stream` 命中记账陷阱 ✅
 * - **记账在外**（错误）：`this` 落到**裸适配器** ⇒ 绕过记账 Proxy
 *   ⇒ 请求照常跑、账本永远为空 ❌（"看起来正常"的静默失效）
 *
 * ⚠️ 本用例**按 dsh-llm 的真实驱动路径**（`prepareCall → call.stream`）走
 * **真实的 `registerAdapterIdempotent`**，而不是直接调 `wrapped.stream` ——
 * 后者正是掩盖该隐患的原因（现有记账用例都是直接调顶层 `stream`）。
 */
describe('★★ 两层包装的嵌套顺序（记账在内 / 剔除在外）', () => {
  /** 忠实模拟真实适配器：prepareCall 转发 this.stream（14 个适配器同款）。 */
  class PrepareCallAdapter {
    topStreamCalls = 0
    providerInfo() { return { id: 'codearts', name: 'CodeArts' } }
    providerRetryPolicy() { return undefined }
    async listModels() { return [] }
    async prepareCall() {
      return {
        model: { provider: 'codearts', id: 'm', name: 'M' },
        stream: (options: unknown) => this.stream(options),
      }
    }
    async *stream() {
      this.topStreamCalls += 1
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 5 } }
    }
  }

  /** 按 dsh-llm 真实方式驱动：prepareCall → call.stream。 */
  async function driveByPrepareCall(adapter: unknown): Promise<number> {
    const reg = adapter as {
      prepareCall: (p: string, m: string) => Promise<{ stream: (o: unknown) => AsyncIterable<unknown> }>
    }
    const call = await reg.prepareCall('codearts', 'm')
    let n = 0
    for await (const _ of call.stream({ provider: 'codearts', model: 'm' })) n += 1
    return n
  }

  afterEach(() => { resetTokenLedgerForTests() })

  it('★★ 经真实 registerAdapterIdempotent + prepareCall 路径，记账必须生效', async () => {
    resetTokenLedgerForTests()
    let registered: unknown
    const llm = {
      registerConfigurableProviders: () => undefined,
      registerAdapter: (_p: readonly string[], adapter: unknown) => { registered = adapter; return () => {} },
    } as never

    registerAdapterIdempotent(llm, ['codearts'], new PrepareCallAdapter(), () => {})
    const chunks = await driveByPrepareCall(registered)

    expect(chunks).toBe(1)
    const entries = readTokenLedger().entries
    expect(entries, '走 prepareCall 路径时记账不得被绕过').toHaveLength(1)
    expect(entries[0]!.provider).toBe('codearts')
    expect(entries[0]!.model).toBe('m')
    expect(entries[0]!.inputTokens).toBe(11)
    expect(entries[0]!.outputTokens).toBe(5)
  })

  /**
   * ★★ 回归（真实缺陷，2026-10-06）：**`prepareCall` 不透传 `this.stream` 时也必须记账**。
   *
   * 记账包装早先**只拦顶层 `stream`**，它之所以生效全靠各适配器的 `prepareCall`
   * 恰好写成 `stream: (o) => this.stream(o)`（再加上调用方经 Proxy 取 `prepareCall`
   * 时 `this` 落在 Proxy 上）。这是一条**隐式依赖**：一旦某适配器改为持有闭包引用，
   * 记账就**静默失效**（请求照常、账本永远为空）。
   *
   * ⇒ 现已在包装层显式包 `prepareCall` 返回的 `call.stream`。本用例守护这一点：
   * 用**不经 `this.stream`** 的适配器，记账仍必须生效。
   *
   * ⚠️ 同根因的既有教训见 `src/dead-model-store.ts`（PR !66 复审：只包 `stream`
   * 导致生产环境完全不生效）。
   */
  it('★★ prepareCall 不经 this.stream（闭包式）时记账仍必须生效', async () => {
    resetTokenLedgerForTests()
    const own = async function* () { yield { type: 'usage', usage: { inputTokens: 21, outputTokens: 9 } } }
    const closureAdapter = {
      providerInfo: () => ({ id: 'codearts', name: 'CodeArts' }),
      providerRetryPolicy: () => undefined,
      // ⚠️ 关键：直接引用闭包，**不**走 this.stream
      async prepareCall() {
        return { model: { provider: 'codearts', id: 'm', name: 'M' }, stream: (o: unknown) => own(o) }
      },
      stream: own,
    }
    const wrapped = wrapAdapterWithTokenLedger(['codearts'], closureAdapter as never)
    await driveByPrepareCall(wrapped)

    const entries = readTokenLedger().entries
    expect(entries, '闭包式 prepareCall 下记账不得被绕过').toHaveLength(1)
    expect(entries[0]!.inputTokens).toBe(21)
    expect(entries[0]!.outputTokens).toBe(9)
  })

  it('★★ 两层包装两种顺序都必须记账（不再依赖 this 绑定链）', async () => {
    // 记账在内 / 剔除在外
    resetTokenLedgerForTests()
    const inner = withDeadModelPruning(
      ['codearts'],
      wrapAdapterWithTokenLedger(['codearts'], new PrepareCallAdapter() as never) as never,
    )
    await driveByPrepareCall(inner)
    expect(readTokenLedger().entries, '记账在内').toHaveLength(1)

    // 记账在外 / 剔除在内 —— 显式包 prepareCall 后**同样生效**
    resetTokenLedgerForTests()
    const outer = wrapAdapterWithTokenLedger(
      ['codearts'],
      withDeadModelPruning(['codearts'], new PrepareCallAdapter() as never) as never,
    )
    await driveByPrepareCall(outer)
    expect(readTokenLedger().entries, '记账在外也不得失效（不依赖 this 绑定链）').toHaveLength(1)
  })

  it('★★ 正确顺序下两层都在位：记账生效且 listModels 仍可用', async () => {
    resetTokenLedgerForTests()
    const correct = withDeadModelPruning(
      ['codearts'],
      wrapAdapterWithTokenLedger(['codearts'], new PrepareCallAdapter() as never) as never,
    ) as unknown as { listModels: (p: string) => Promise<unknown[]> }
    await driveByPrepareCall(correct)
    expect(readTokenLedger().entries).toHaveLength(1)
    expect(Array.isArray(await correct.listModels('codearts'))).toBe(true)
  })
})
