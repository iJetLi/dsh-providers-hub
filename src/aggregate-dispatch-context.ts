/**
 * 「本次调用来自聚合派发」的异步上下文标记。
 *
 * ## 为什么需要它（真实故障，2026-11-14）
 *
 * `aggregate/*` 把请求逐个派给候选渠道，**只有候选报错**才切换下一个。而 qoder 遇到
 * 上游排队（业务码 `10605`）时，`wait` 档在网关内部静默等待（上限 30 分钟）、
 * `visible` 档先吐一帧空 `text-delta` 心跳 —— 前者让聚合永远等不到错误，后者被聚合的
 * `isVisibleContent` 判成「已产出内容」从而**禁止切换**。两种情况下请求都被锁死在
 * qoder 上，后面能用的候选一个都轮不到。
 *
 * 实测日志（NAS 生产环境）：
 * ```
 * 01:31:07.636 [aggregate] accio（glm-5-3-flash）失败，切换下一个候选
 * 01:31:07.967 [qoder] qoder 上游排队（10605）：等待 10000ms（模式 wait，…）
 * （此后该请求再无任何日志，客户端 90s / 240s 收不到一个字节）
 * ```
 *
 * ⇒ 需要的语义是：**聚合调用**时排队 = 该候选失败（立刻换下一个）；**直连**时
 *    仍按 `DSH_QODER_QUEUE_WAIT_MODE` 等待 / 向下游报排队。
 *
 * ## 为什么用 `AsyncLocalStorage` 而不是在 `GenerateOptions` 上加字段
 *
 * 聚合经宿主公共入口 `ctx.llm.stream(...)` 派发，中间要过 `llm/stream` 中间件
 * waterfall 与 `adapterStream` 的 `resolvedOptions` / `forAdapter` 重组 —— 私有字段
 * 能否原样到达适配器**没有契约保证**。异步上下文则跟着调用链走，不依赖宿主
 * 是否透传未知字段。
 *
 * ## ⚠️ 为什么必须逐次包 `next()`，不能只包「创建流」那一下
 *
 * 异步生成器的函数体在**调用 `next()` 的那个上下文**里执行。聚合的 `dispatch`
 * 本身也是异步生成器：每次 `yield` 之后，它在**消费者**的上下文里恢复 ⇒ 若只在
 * 创建时 `run()` 一次，第二个 chunk 起内层渠道代码就看不到标记了（而 qoder 的排队
 * 恰恰发生在首个 chunk 之前或任意重试之间）。故 {@link bindAggregateDispatch}
 * 把 `next` / `return` / `throw` **每一次**都放进 `run()` 里调。
 *
 * @module src/aggregate-dispatch-context.ts
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<true>()

/** 当前异步调用链是否处在一次聚合派发之内。 */
export function isInsideAggregateDispatch(): boolean {
  return storage.getStore() === true
}

/**
 * 在「聚合派发」上下文里创建并迭代一条流。
 *
 * @param open - 创建流的工厂（在上下文内调用，保证宿主中间件在创建期就看得到标记）。
 * @returns 一个转发全部 chunk 的流；其每次 `next` / `return` / `throw` 都在上下文内执行。
 */
export function bindAggregateDispatch<T>(open: () => AsyncIterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = storage.run(true, () => open()[Symbol.asyncIterator]())
      const bound: AsyncIterator<T> = {
        next: (...args: [] | [undefined]) => storage.run(true, () => iterator.next(...args)),
      }
      if (iterator.return !== undefined) {
        bound.return = (value?: unknown) => storage.run(true, () => iterator.return!(value as never))
      }
      if (iterator.throw !== undefined) {
        bound.throw = (error?: unknown) => storage.run(true, () => iterator.throw!(error))
      }
      return bound
    },
  }
}
