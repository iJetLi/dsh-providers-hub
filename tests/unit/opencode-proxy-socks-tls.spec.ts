/**
 * SOCKS5 隧道上的 TLS 包裹（issue #19）。
 *
 * undici 的 `connect` 钩子**整体替换**内置 connector —— 内置 connector 自己会
 * 对 `https:` 目标做 TLS，自定义钩子不会。原实现只返回裸 TCP 隧道 ⇒ TLS
 * ClientHello 被当 HTTP 明文发给上游 ⇒ `https://opencode.ai/...` 经 SOCKS5 必失败。
 *
 * 本文件用注入的 tunnel / wrapTls 锁三件事：
 * 1. https/wss ⇒ 必须包 TLS，且域名要带 `servername`（IP 不带 SNI）；
 * 2. http ⇒ 不包（否则会把明文请求套进 TLS）；
 * 3. TLS 握手失败 ⇒ callback 收错、底层 socket 被销毁（不泄漏）。
 */
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { describe, expect, it, vi } from 'vitest'

import { createSocksConnect } from '../../src/opencode-proxy.js'

const proxy = { url: 'socks5://127.0.0.1:1080' } as never

function makeTls(): TLSSocket {
  const emitter = new EventEmitter() as unknown as TLSSocket
  emitter.destroy = (() => emitter) as never
  return emitter
}

function makeSocket(): { socket: Socket, isDestroyed: () => boolean } {
  const emitter = new EventEmitter() as unknown as Socket
  let destroyed = false
  emitter.destroy = (() => { destroyed = true; return emitter }) as never
  return { socket: emitter, isDestroyed: () => destroyed }
}

describe('createSocksConnect：https 目标必须包 TLS（issue #19）', () => {
  it('★★ https：包 TLS、域名带 SNI、secureConnect 后才回调', async () => {
    const { socket } = makeSocket()
    const secure = makeTls()
    const wrapTls = vi.fn(() => secure)
    const connect = createSocksConnect(proxy, { tunnel: async () => socket, wrapTls: wrapTls as never })

    let settled: { error: Error | null, socket?: Socket } | undefined
    const done = new Promise<void>((resolve) => {
      connect({ hostname: 'opencode.ai', port: '', protocol: 'https:' }, (error, value) => {
        settled = { error, socket: value }
        resolve()
      })
    })
    // 等 tunnel.then 把 TLS 监听挂上；此时尚未 secureConnect ⇒ 不得回调。
    await vi.waitFor(() => { expect(wrapTls).toHaveBeenCalled() })
    expect(wrapTls).toHaveBeenCalledWith(expect.objectContaining({ socket, servername: 'opencode.ai' }))
    expect(settled).toBeUndefined()

    secure.emit('secureConnect')
    await done
    expect(settled?.error).toBeNull()
    expect(settled?.socket).toBe(secure)
  })

  it('★★ http 目标不包 TLS', async () => {
    const { socket } = makeSocket()
    const wrapTls = vi.fn()
    const connect = createSocksConnect(proxy, { tunnel: async () => socket, wrapTls: wrapTls as never })
    const got = await new Promise<Socket | undefined>((resolve) => {
      connect({ hostname: 'example.com', port: '', protocol: 'http:' }, (_error, value) => resolve(value))
    })
    expect(wrapTls).not.toHaveBeenCalled()
    expect(got).toBe(socket)
  })

  it('IP 目标不发送 SNI', async () => {
    const { socket } = makeSocket()
    const wrapTls = vi.fn(() => makeTls())
    const connect = createSocksConnect(proxy, { tunnel: async () => socket, wrapTls: wrapTls as never })
    void connect({ hostname: '203.0.113.7', port: 443, protocol: 'https:' }, () => {})
    await vi.waitFor(() => { const options = wrapTls.mock.calls[0]?.[0] as { socket?: Socket, servername?: string }
    expect(options.socket).toBe(socket)
    expect(options.servername).toBeUndefined() })
  })

  it('TLS 握手失败 ⇒ callback 收错且销毁底层隧道', async () => {
    const { socket, isDestroyed } = makeSocket()
    const secure = makeTls()
    const connect = createSocksConnect(proxy, {
      tunnel: async () => socket,
      wrapTls: (() => secure) as never,
    })
    const result = new Promise<Error | null>((resolve) => {
      connect({ hostname: 'opencode.ai', port: 443, protocol: 'https:' }, (value) => resolve(value))
    })
    // 等 tunnel.then 把 error 监听挂上，再注入握手失败（否则 EventEmitter 会抛）。
    await vi.waitFor(() => { expect(secure.listenerCount('error')).toBeGreaterThan(0) })
    secure.emit('error', new Error('tls handshake failed'))
    const error = await result
    expect(error?.message).toContain('tls handshake failed')
    expect(isDestroyed()).toBe(true)
  })
})

describe('createSocksConnect 的协议边界（对抗审计补）', () => {
  it('★★ wss: 也必须包 TLS', async () => {
    const { socket } = makeSocket()
    const secure = makeTls()
    const wrapTls = vi.fn(() => secure)
    const connect = createSocksConnect(proxy, { tunnel: async () => socket, wrapTls: wrapTls as never })
    void connect({ hostname: 'example.com', port: 443, protocol: 'wss:' }, () => {})
    await vi.waitFor(() => { expect(wrapTls).toHaveBeenCalledWith(expect.objectContaining({ socket, servername: 'example.com' })) })
  })

  it('未给协议 + 端口 443 ⇒ 按 https 处理（包 TLS）', async () => {
    const { socket } = makeSocket()
    const secure = makeTls()
    const wrapTls = vi.fn(() => secure)
    const connect = createSocksConnect(proxy, { tunnel: async () => socket, wrapTls: wrapTls as never })
    void connect({ hostname: 'example.com', port: 443 }, () => {})
    await vi.waitFor(() => { expect(wrapTls).toHaveBeenCalled() })
  })

  it('未给协议 + 端口 80 ⇒ 不包 TLS', async () => {
    const { socket } = makeSocket()
    const wrapTls = vi.fn()
    const connect = createSocksConnect(proxy, { tunnel: async () => socket, wrapTls: wrapTls as never })
    const got = await new Promise<Socket | undefined>((resolve) => {
      connect({ hostname: 'example.com', port: 80 }, (_error, value) => resolve(value))
    })
    expect(wrapTls).not.toHaveBeenCalled()
    expect(got).toBe(socket)
  })

  it('★★ secureConnect 后再 error 也只能回调一次（settled 闸门）', async () => {
    const { socket } = makeSocket()
    const secure = makeTls()
    const callback = vi.fn()
    const connect = createSocksConnect(proxy, { tunnel: async () => socket, wrapTls: (() => secure) as never })
    connect({ hostname: 'opencode.ai', port: 443, protocol: 'https:' }, callback)
    await vi.waitFor(() => { expect(secure.listenerCount('secureConnect')).toBe(1) })
    expect(callback).not.toHaveBeenCalled()
    secure.emit('secureConnect')
    secure.emit('error', new Error('late tls error'))
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0]?.[0]).toBeNull()
  })
})
