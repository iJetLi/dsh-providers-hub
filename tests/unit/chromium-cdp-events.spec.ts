/**
 * `CdpConnection` 的事件订阅（Marvis 登录需要 `Fetch.requestPaused`）。
 *
 * ## 为什么需要这条腿
 *
 * 修复前 `CdpConnection` 把所有 **无 `id`** 的 CDP 消息直接 `return` 掉
 * （`src/chromium-session.ts:1397`）—— 那是**事件**（`Fetch.requestPaused`、
 * `Network.requestWillBeSent` 等）。命令/响应是有的，事件从来没有出口，
 * 所以任何「在 Request 阶段截停回调」的实现都无从下手。
 *
 * ## 两条判据
 *
 * 1. **订阅者收到事件**，且 **退订后不再收到**（否则一次登录会泄漏一个
 *    永不释放的监听器，长跑的宿主进程里越积越多）。
 * 2. **订阅者抛错不得打断消息循环** —— 这是 `try/catch` 的存在理由：
 *    `ws.addEventListener('message')` 的回调里抛出会变成未捕获异常，
 *    在浏览器登录这种「用户等着」的路径上等于整个流程静默卡死。
 *
 * ⚠ 本用例用假 `WebSocket`（只实现 `addEventListener` / `send` / `close`），
 * 不连真实 Chromium —— 事件分发是**纯函数级**行为，真启浏览器只会让
 * 判据变成「网络快慢」的随机函数。
 */
import { describe, expect, it } from 'vitest'
import { CdpConnection } from '../../src/chromium-session.js'

type MessageListener = (event: { data: string }) => void

/** 假 `WebSocket`：能记录 `send`、能手动 `emit` 一条 CDP 消息。 */
class FakeWebSocket {
  private readonly listeners = new Map<string, Set<MessageListener>>()

  readonly sent: string[] = []

  addEventListener(type: string, listener: MessageListener): void {
    let bucket = this.listeners.get(type)
    if (bucket === undefined) {
      bucket = new Set()
      this.listeners.set(type, bucket)
    }
    bucket.add(listener)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    // 无需模拟关闭握手。
  }

  /** 把一条 CDP 消息喂给所有 `message` 监听器。 */
  emit(message: unknown): void {
    for (const listener of [...(this.listeners.get('message') ?? [])]) {
      listener({ data: JSON.stringify(message) })
    }
  }
}

function connectionOf(socket: FakeWebSocket): CdpConnection {
  return new CdpConnection(socket as unknown as WebSocket)
}

describe('CdpConnection 事件订阅', () => {
  it('★ 无 id 的 CDP 事件分发给订阅者，并带上 method / params / sessionId', () => {
    const socket = new FakeWebSocket()
    const connection = connectionOf(socket)
    const seen: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []

    connection.subscribe((event) => {
      seen.push(event)
    })
    socket.emit({
      method: 'Fetch.requestPaused',
      params: { requestId: 'r1' },
      sessionId: 's1',
    })

    expect(seen).toEqual([
      { method: 'Fetch.requestPaused', params: { requestId: 'r1' }, sessionId: 's1' },
    ])
  })

  it('★ 退订后不再分发（返回的闭包幂等）', () => {
    const socket = new FakeWebSocket()
    const connection = connectionOf(socket)
    const seen: string[] = []

    const unsubscribe = connection.subscribe((event) => {
      seen.push(event.method)
    })
    socket.emit({ method: 'Fetch.requestPaused', params: {} })
    expect(seen).toHaveLength(1)

    unsubscribe()
    unsubscribe() // 幂等：第二次调用不得抛错
    socket.emit({ method: 'Fetch.requestPaused', params: {} })
    expect(seen).toHaveLength(1)
  })

  it('★ 订阅者抛错不得打断消息循环：后续命令响应仍能 resolve', async () => {
    const socket = new FakeWebSocket()
    const connection = connectionOf(socket)

    connection.subscribe(() => {
      throw new Error('订阅者自己炸了')
    })

    const pending = connection.send('Runtime.evaluate', { expression: '1' })
    // 先来一条事件（订阅者抛错），再来命令响应。
    socket.emit({ method: 'Fetch.requestPaused', params: {} })
    socket.emit({ id: 1, result: { value: 42 } })

    await expect(pending).resolves.toEqual({ value: 42 })
  })

  it('★ 有 id 的响应不分发给订阅者（命令响应不是事件）', async () => {
    const socket = new FakeWebSocket()
    const connection = connectionOf(socket)
    const seen: string[] = []

    connection.subscribe((event) => {
      seen.push(event.method)
    })

    const pending = connection.send('Runtime.evaluate', {})
    socket.emit({ id: 1, result: 'ok' })
    await pending

    expect(seen).toEqual([])
  })
})
