/**
 * 每账号代理 → undici Dispatcher。
 *
 * ## 两条实现路线（设计文档 §3）
 *
 * - **HTTP(S)**：undici 的 `ProxyAgent`。⚠️ 必须传
 *   `clientFactory` + `pipelining: 0` —— 默认的 keep-alive 连接池会被
 *   Clash 类代理静默关闭空闲 CONNECT 隧道，导致请求挂死
 *   （opencode2dsh / dsh-llm-proxy 都实测踩过，数据 2/10 → 10/10）。
 * - **SOCKS5**：Node 生态**没有**可用的纯 JS 栈（npm 的 `socks-proxy-agent`
 *   是给 node:http 的 Agent，不是 undici Dispatcher），故自实现最小
 *   CONNECT 隧道：RFC 1928 握手 + RFC 1929 认证 + CONNECT，
 *   **不**自写加密协议栈（设计文档 §8 明确排除）。
 *
 * ## 作用域：仅本 provider
 *
 * 只在 `fetch(url, { dispatcher })` 里逐请求传入，**不动全局 dispatcher**
 * （opencode2dsh 的 R1 教训：两个插件抢全局槽位会互相短路整个路由层）。
 *
 * ⚠️ **发请求必须走本模块的 {@link proxyFetch}**，不要自己写
 * `fetch(url, { dispatcher: buildProxyDispatcher(...) })` —— 那正是缺陷 IKK4BY，
 * 原因见 {@link proxyFetch} 的注释。
 *
 * ## ⚠️ 依赖说明
 *
 * 本模块是**全仓库唯一**新增的 npm 依赖（undici）。原本的设计要求「零新依赖」，
 * 但 per-request 代理的 `ProxyAgent` / 可插 connector 的 `Agent` 都住在 undici
 * 里，而它既不在本仓库依赖中、也无法从 Node 内部路径 require 到
 * （`node:undici` 不存在、`globalThis.ProxyAgent` 未定义、
 * `--use-env-proxy` 是**进程全局**的，给不了「每账号不同出口」）。
 * 用户已确认接受这一处破例。
 */

import { Agent, Pool, ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Dispatcher } from 'undici'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { checkServerIdentity, connect as tlsConnect, type PeerCertificate, type TLSSocket } from 'node:tls'
import { URL } from 'node:url'
import type { NormalizedProxy } from './opencode.js'

/** LRU 上限：连接是惰性建立的，缓存过多实例只是占内存。 */
const PROXY_CACHE_LIMIT = 16

const cache = new Map<string, Dispatcher>()

/**
 * 走**指定代理**发请求（本 provider 的唯一出口方法）。
 *
 * ## ⚠️⚠️ 为什么不能直接用全局 `fetch`（真实缺陷 IKK4BY）
 *
 * {@link buildProxyDispatcher} 的 Dispatcher 来自**外部 undici**，而全局
 * `fetch` 是 Node **内置 undici** 的实现。把前者塞进 `RequestInit.dispatcher`，
 * 等于让「内置版本的 handler」去满足「外部版本的断言」—— 两个版本区间不搭就
 * **在建连之前**同步抛错：
 *
 *     InvalidArgumentError: invalid onRequestStart method
 *     code = UND_ERR_INVALID_ARG
 *
 * 该异常被 fetch 包装成 `TypeError: fetch failed` 且 **cause 被丢弃**，
 * 于是用户只看到「测试失败 fetch failed、耗时 0~1ms」「保存后每次对话都失败」，
 * 与代理地址是否可用**完全无关**（实测断言早于任何连接）。
 *
 * ## 版本对应关系（本机实测 Node 22.19 / 24.21 / 26.10）
 *
 * | Node | 内置 undici | 全局 fetch + 外部 8.x |
 * |---|---|---|
 * | 22.19 | 6.21.2 | ✗ 缺 6 个新契约字段 |
 * | 24.21 | 7.29.1 | ✗ 缺 5 个 |
 * | 26.10 | 8.10.2 | ✓ **恰好**同契约 |
 *
 * ⚠️ 机制细节：undici **7.x** 的 `assertRequestHandler` 开头有「双契约早返回」
 * （`typeof handler.onRequestStart === 'function'` 就直接 return），
 * 而 **8.x 删掉了它**，改为无条件要求新契约字段。这就是「同一份 handler，
 * Node 26 过、Node 22/24 挂」的全部来源。
 *
 * ⚠️ 因此 Node 26 上「看似正常」纯属**版本巧合**，不是「跨实例 Dispatcher 被支持」。
 * 外部 undici 升到 9.x、或用户换回 Node 22/24，都会立刻复发 ——
 * 故**凡是要传 dispatcher 的请求都必须走本函数**，这是唯一与版本无关的根治办法。
 *
 * ## 与全局 fetch 的语义差异（已实测无影响）
 *
 * - **SSE 增量语义不变**：`response.body` 仍逐块到达（4 段 SSE 的分片数与
 *   首片耗时与全局 fetch 一致，未被整体缓冲）—— `consumeOpenAiSse` 依赖这条；
 * - **`AbortSignal` 行为不变**：1.5s 中断 3s 慢响应，两者都是 `AbortError`；
 * - **无代理时不切实现**：`proxy === undefined` 时仍走全局 `fetch`，
 *   以免改变「不传 dispatcher」路径的既有行为（例如 Node 24+ 的
 *   `NODE_USE_ENV_PROXY` 等**由内置 fetch 提供**的宿主特性）。
 *   ⚠️ 这条已实测：`NODE_USE_ENV_PROXY=1` + `HTTP_PROXY=<中介>` 时，
 *   Node 26 的全局 fetch 确实经中介（中介命中 +2），而 Node 22 不支持该特性
 *   （命中 0）—— 故「无代理也切到 undici fetch」会**静默丢掉**这类宿主能力。
 *
 * ## ⚠️ 不接受 `Request` 对象（实测的静默降级风险）
 *
 * 本函数把 `init` 用 `{ ...init }` 展开后再补 `dispatcher`。若有人传
 * **`Request` 对象**当 `init`，展开得到的是**空对象**（`Request` 的
 * method / body / headers 都不是自有可枚举属性）—— 于是请求会**静默降级**：
 *
 *     全局 fetch(url, Request)         → POST + body + headers   ✓ 正确
 *     fetch(url, { ...Request })      → **GET、无 body、无 headers**  ← 静默错
 *
 * 这比抛错更危险（错得没有声音）。故这里**显式拦截**并抛出，让调用方立刻发现。
 * ⚠️ 当前三个调用点都传普通对象或 `{ signal }`，均未触发 —— 这是**防御**而非修 bug。
 */
export function proxyFetch(
  input: string,
  init: RequestInit,
  proxy: NormalizedProxy | undefined,
): Promise<Response> {
  // ⚠️ 用 `instanceof Request` 判据而不是「找 method 字段」：后者对
  // `{ method: 'POST' }` 这种正常对象会误判。
  if (init instanceof Request) {
    throw new TypeError(
      'proxyFetch 不接受 Request 对象作 init：{ ...init } 展开会丢失 method/body/headers，'
      + '导致请求静默降级为 GET。请传普通对象（或先解构出字段）。',
    )
  }
  if (proxy === undefined) return fetch(input, init)
  // ⚠️ 两处断言的分工：
  // - `init` 的 `dispatcher` 字段在 TS 层属于外部 undici，与全局 `RequestInit` 不同源；
  // - 返回值是外部 undici 的 `Response`，与全局 `Response` 在类型上不同源
  //   （运行期同构，`consumeOpenAiSse` 只用到 `.ok/.status/.text()/.body/.headers`）。
  // 运行期契约由「dispatch 与 fetch 同源」保证，故此处只做类型层收敛。
  return undiciFetch(input, {
    ...init,
    dispatcher: buildProxyDispatcher(proxy) as never,
  } as never) as unknown as Promise<Response>
}

/** 取（或建）该代理地址的 Dispatcher。 */
export function buildProxyDispatcher(proxy: NormalizedProxy): Dispatcher {
  const existing = cache.get(proxy.url)
  if (existing !== undefined) return existing
  const created = proxy.kind === 'http' ? buildHttpDispatcher(proxy.url) : buildSocksDispatcher(proxy)
  // 触碰即移到末尾，实现 LRU 的淘汰顺序
  cache.delete(proxy.url)
  cache.set(proxy.url, created)
  while (cache.size > PROXY_CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    const victim = cache.get(oldest.value)
    cache.delete(oldest.value)
    if (victim !== undefined) {
      // 淘汰路径不 await（失败只落在实例内部，不该拖慢请求路径）；
      // 插件 dispose 时 closeAllProxyDispatchers 会兜底等待。
      void Promise.resolve(victim.close?.()).catch(() => {})
    }
  }
  return created
}

/** 当前缓存的代理实例数（诊断用）。 */
export function proxyCacheSize(): number {
  return cache.size
}

/** 关闭并清空全部缓存实例（插件 dispose 路径）。 */
export async function closeAllProxyDispatchers(): Promise<void> {
  const all = [...cache.values()]
  cache.clear()
  await Promise.allSettled(all.map(async (d) => {
    try {
      await d.close()
    } catch {
      // 已被对端断开的实例 close() 会抛；这在 dispose 路径无关紧要
    }
  }))
}

/** HTTP(S) 代理：ProxyAgent + 禁用代理侧 keep-alive 复用。 */
function buildHttpDispatcher(url: string): Dispatcher {
  return new ProxyAgent({
    uri: url,
    // ⚠️ `pipelining: 0` 是必需的（见模块头）；`clientFactory` 由 undici 在
    // 每次建连时调用，用它把默认 Pool 换成禁用复用的 Pool。
    clientFactory: (origin: string, opts: object) => new Pool(origin, { ...(opts as object), pipelining: 0 } as never),
  } as never)
}

/**
 * SOCKS5 握手的**首帧**（可单测的纯函数）。
 *
 * - 无认证 → `[0x05, 0x01, 0x00]`（VER=5，NMETHODS=1，METHOD=NO AUTH）
 * - 有认证 → `[0x05, 0x02, 0x00, 0x02]`（NMETHODS=2，NO AUTH + USER/PASS）
 *
 * ⚠️ 凭据用 `decodeURIComponent` 解码：用户在 URL 里写 `%40` 表示 `@`。
 */
export function buildSocks5Handshake(proxy: Pick<NormalizedProxy, 'url'>): Uint8Array {
  const parsed = new URL(proxy.url)
  const wantsAuth = parsed.username.length > 0
  return wantsAuth
    ? new Uint8Array([0x05, 0x02, 0x00, 0x02])
    : new Uint8Array([0x05, 0x01, 0x00])
}

/** 走 SOCKS5 代理建立一条到 `host:port` 的 TCP 隧道。 */
async function openSocks5Tunnel(proxy: NormalizedProxy, host: string, port: number): Promise<Socket> {
  const parsed = new URL(proxy.url)
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = netConnect({ host: parsed.hostname, port: Number(parsed.port) })
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
  // ⚠️ 这里**不能**写 `const fail = (e) => reject(e)`：`reject` 只是上面那个
  // `new Promise` 执行器的作用域参数，在外层函数里已不存在（写出来会变成
  // ReferenceError，把「认证失败」变成「代码崩溃」——typecheck 抓到的真实 bug）。
  // 正确做法是直接 throw：本函数整体被 try/catch 包住，catch 负责 destroy socket。
  const fail = (error: Error): never => {
    throw error
  }
  const write = (bytes: Uint8Array): Promise<void> => new Promise((resolve, reject) => {
    socket.write(Buffer.from(bytes), (err) => (err ? reject(err) : resolve()))
  })

  /**
   * 带缓冲的定长读取器。
   *
   * ## ⚠️ 为什么必须跨调用保存余量（真实 bug，由 `opencode-proxy-live.spec.ts` 抓到）
   *
   * TCP **不保证**按我们的读请求切包：SOCKS5 服务端常把整个 10 字节 REPLY
   * 一次写完，而握手要分三次读（2 字节方法应答、4 字节前缀、6 字节地址端口）。
   * 若每次 `read(n)` 只取走 n 字节、**丢弃同 chunk 里的其余字节**，
   * 第二次 `read(6)` 就会永远等不到数据 —— 表现为握手卡死直到 undici 超时。
   *
   * ⇒ 余量必须留到下一次 `read` 里用。这也是本函数不用
   * `socket.once('data')` 逐次读取的根本原因。
   */
  let leftover: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let pending: { n: number; resolve: (value: Uint8Array) => void; reject: (err: Error) => void } | undefined

  const detach = (): void => {
    socket.off('data', onData)
    socket.off('error', onError)
    socket.off('close', onClose)
  }
  const fulfill = (): void => {
    if (pending === undefined || leftover.length < pending.n) return
    const n = pending.n
    const target = pending
    pending = undefined
    const value = new Uint8Array(leftover.subarray(0, n))
    leftover = leftover.subarray(n)
    detach()
    target.resolve(value)
  }
  const onData = (chunk: Buffer): void => {
    leftover = leftover.length === 0 ? chunk : Buffer.concat([leftover, chunk])
    fulfill()
  }
  const onError = (error: Error): void => {
    const target = pending
    pending = undefined
    detach()
    target?.reject(error)
  }
  // ⚠️ 对端在应答中途关闭时必须 reject：否则这个 Promise 永不 settle，
  // 请求会挂到 undici 自己的超时才结束，用户看到的是「转圈很久才失败」。
  const onClose = (): void => {
    const target = pending
    pending = undefined
    detach()
    target?.reject(new Error('SOCKS5 代理在握手完成前关闭了连接'))
  }

  const read = (n: number): Promise<Uint8Array> => new Promise((resolve, reject) => {
    if (n <= 0) {
      resolve(new Uint8Array(0))
      return
    }
    // 一次只允许一个在途请求：本模块的握手步骤是严格串行 await 的
    pending = { n, resolve, reject }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    fulfill()
  })

  try {
    await write(buildSocks5Handshake(proxy))
    const methodReply = await read(2)
    const method = methodReply[1]
    if (method === 0x02) {
      const user = Buffer.from(decodeURIComponent(parsed.username), 'utf8')
      const pass = Buffer.from(decodeURIComponent(parsed.password), 'utf8')
      // RFC 1929：VER=1 ULEN uname PLEN passwd
      await write(new Uint8Array([0x01, user.length, ...user, pass.length, ...pass]))
      const authReply = await read(2)
      if (authReply[1] !== 0x00) fail(new Error('SOCKS5 用户名/密码认证失败'))
    } else if (method !== 0x00) {
      fail(new Error(`SOCKS5 服务端要求未知认证方式 0x${(method ?? 0).toString(16)}`))
    }

    // CONNECT：VER CMD=0x01 RSV ATYP=0x03(域名) LEN host PORT
    // ⚠️ 端口必须转成**无符号 16 位**：`port >> 8` 在 >32767 时是负数，
    // 写进帧里会变成错误的字节（443/1080 之类常用值没事，但 40000+ 会坏）。
    const target = Buffer.from(host, 'utf8')
    await write(new Uint8Array([
      0x05, 0x01, 0x00, 0x03, target.length, ...target,
      (port >>> 8) & 0xff, port & 0xff,
    ]))
    // ⚠️⚠️ **必须读完整个应答，不能只读 4 字节前缀**（真实 bug，由
    // `opencode-proxy-live.spec.ts` 的真实联通测试抓到）：
    // RFC 1928 的 REPLY 里 BND.ADDR/BND.PORT 是**变长**的（ATYP 决定），
    // 只取前 4 字节会把剩余 6~18 字节留在 socket 缓冲里，随后被 undici
    // 当成 HTTP/TLS 数据读走 —— 表现为握手成功后紧跟一个莫名其妙的解析错误，
    // 或者响应流里凭空多出垃圾字节。
    const reply = await read(4)
    if (reply[1] !== 0x00) {
      fail(new Error(`SOCKS5 CONNECT 被拒绝（应答码 0x${(reply[1] ?? 0).toString(16)}）`))
    }
    const atyp = reply[3]
    if (atyp === 0x01) await read(4 + 2)
    else if (atyp === 0x04) await read(16 + 2)
    else if (atyp === 0x03) await read(1).then((lenByte) => read((lenByte[0] ?? 0) + 2))
    // 未知 ATYP：无法确定剩余长度，握手已成功但不能安全继续
    else fail(new Error(`SOCKS5 应答的地址类型 0x${(atyp ?? 0).toString(16)} 不受支持`))

    // ⚠️ **不要**在交出前 pause：undici 接管后不会 resume 一个已暂停的
    // socket（它假定 connector 交回的是流动的），实测会让请求挂到超时。
    // 握手期间的字节也不会丢 —— 我们的 `data` 监听在每次 read 结束时已摘除，
    // 剩余数据留在 Node 的流缓冲里，undici 挂上 reader 后照常读出。
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/**
 * SOCKS5 Dispatcher：把自定义 connector 交给 undici 的 `Agent`。
 *
 * 隧道 socket 交给 undici 后，它会继续在上面做 TLS 握手与 HTTP/1.x 收发。
 *
 * ## ⚠️⚠️ 端口**不能**写成 `Number(opts.port ?? 443)`（真实缺陷，2026-10-08 实测）
 *
 * undici 传给 connector 的 `opts.port` 在**默认端口**时是**空字符串 `""`**，
 * 而不是 `undefined`（实测 undici 8.11.2，`opts` 全部键为
 * `host,hostname,protocol,port,servername,localAddress`）：
 *
 * | 目标 URL | `opts.port` | `Number(opts.port ?? 443)` |
 * |---|---|---|
 * | `https://opencode.ai/zen/...`（默认 443） | `""` | **0** ← 坏 |
 * | `https://example.com:8443/` | `"8443"` | 8443 ✓ |
 *
 * `??` 只兜 `null`/`undefined`，**兜不住空字符串**，于是 `Number("") === 0`，
 * SOCKS5 的 CONNECT 帧把端口写成 `0x0000` ⇒ 上游按端口 0 连接必然失败：
 *
 *     中介实测：CONNECT → "opencode.ai:0" → 失败（应答码 0x5）
 *     显式端口实测：CONNECT → "example.com:8443" → 通过
 *
 * 影响面**正好命中生产主路径** —— `OPENCODE.baseUrl` 是
 * `https://opencode.ai/zen`（默认 443），故「SOCKS5 代理」这个功能
 * 在修复前是**恒不可用**的（HTTP 代理不受影响，它不走这条 connector）。
 * 三代 Node（22.19 / 24.21 / 26.10）一致复现，与版本无关。
 *
 * ⇒ 判据必须同时覆盖「空串」与「非法值」，回退到按协议推出的默认端口。
 */
export interface SocksConnectDeps {
  tunnel?: (proxy: NormalizedProxy, host: string, port: number) => Promise<Socket>
  wrapTls?: (options: {
    socket: Socket
    servername?: string
    // ⚠️ IP 目标没有 SNI 时 Node 会拿**底层 socket 的 _host**（= 代理地址）去比
    // 证书 ⇒ ERR_TLS_CERT_ALTNAME_INVALID；必须显式用目标 host 校验。
    checkServerIdentity?: (hostname: string, cert: PeerCertificate) => Error | undefined
  }) => TLSSocket
}

interface SocksConnectOptions {
  hostname?: string
  host?: string
  port?: number | string
  protocol?: string
  /** undici 可能带上 SNI override（内置 connector 也读它）。 */
  servername?: string
}

/** 该目标是否需要在 SOCKS5 隧道上再做 TLS（`https:`/`wss:`，或未给协议但端口 443）。 */
function needsTls(opts: SocksConnectOptions): boolean {
  const protocol = String(opts.protocol ?? '').toLowerCase()
  if (protocol.length > 0) return protocol.startsWith('https') || protocol.startsWith('wss')
  return resolveConnectPort(opts) === 443
}

/**
 * 构造 undici 的 `connect` 钩子：SOCKS5 握手后按目标协议**再做 TLS**。
 *
 * ## ⚠️⚠️ 为什么必须自己包 TLS（真实缺陷，Gitee/GitHub issue #19）
 *
 * undici 的 `connect` 选项**整体替换**内置 connector —— 内置 connector 在
 * `protocol === 'https:'` 时会自己 `tls.connect`，而自定义钩子返回的 socket
 * 会被当作**已就绪**直接写 HTTP。只返回裸 TCP 隧道 ⇒ TLS ClientHello 被当成
 * HTTP 明文发给上游 ⇒ `https://opencode.ai/...` 经 SOCKS5 必然失败
 * （HTTP 代理不走这条 connector，所以只有 SOCKS5 用户中招）。
 *
 * ⇒ 握手成功后：https/wss 目标用 `tls.connect({ socket, servername })` 包一层，
 * 等 `secureConnect` 再交给 undici；`servername` 只对域名设置（IP 不发 SNI）。
 */
export function createSocksConnect(
  proxy: NormalizedProxy,
  deps: SocksConnectDeps = {},
): (opts: SocksConnectOptions, callback: (error: Error | null, socket?: Socket) => void) => void {
  const tunnel = deps.tunnel ?? openSocks5Tunnel
  const wrapTls = deps.wrapTls ?? ((options) => tlsConnect(options))
  return (opts, callback) => {
    const host = String(opts.hostname ?? opts.host ?? '')
    const port = resolveConnectPort(opts)
    if (host.length === 0) {
      callback(new Error('SOCKS5 代理：目标 host 为空'), undefined)
      return
    }
    tunnel(proxy, host, port)
      .then((socket) => {
        if (!needsTls(opts)) {
          callback(null, socket)
          return
        }
        let settled = false
        /**
         * SNI 只对域名设置；但**证书校验的主机名必须始终是目标 host** ——
         * 不设 servername 时 Node 会退回 `options.socket._host`，而该 socket 连的
         * 是**代理** ⇒ 拿代理的 IP/域名去比目标证书，IP 目标恒
         * `ERR_TLS_CERT_ALTNAME_INVALID`（2026-11-03 审计 P1）。
         */
        const serverName = opts.servername !== undefined && opts.servername.length > 0
          ? opts.servername
          : isIP(host) === 0 ? host : undefined
        let secure: TLSSocket
        try {
          secure = wrapTls({
            socket,
            ...serverName === undefined ? {} : { servername: serverName },
            checkServerIdentity: (_hostname, cert) => checkServerIdentity(serverName ?? host, cert),
          })
        } catch (error) {
          // wrapTls 同步抛错：底层隧道必须销毁，否则泄漏。
          socket.destroy()
          callback(error as Error, undefined)
          return
        }
        // 保底：settled 之后再来 error 不能让 EventEmitter 变成 uncaught。
        secure.on('error', () => { secure.destroy() })
        secure.once('secureConnect', () => {
          if (settled) return
          settled = true
          callback(null, secure)
        })
        secure.once('error', (error: Error) => {
          if (settled) return
          settled = true
          // TLS 握手失败：TLS socket 与底层隧道都销毁，否则泄漏。
          secure.destroy()
          socket.destroy()
          callback(error, undefined)
        })
      })
      .catch((error: Error) => { callback(error, undefined) })
  }
}

function buildSocksDispatcher(proxy: NormalizedProxy): Dispatcher {
  return new Agent({
    connect: createSocksConnect(proxy) as never,
  } as never)
}

/**
 * 从 undici 传来的 `opts` 里解析出**真正的目标端口**。
 *
 * 三层兜底（缺一不可，每一层都有实测依据）：
 * 1. `opts.port` 是**空串** ⇒ 视为「未指明」，落到协议默认端口
 *    （⚠️ 这是本函数存在的根本原因，见 {@link buildSocksDispatcher} 的事故注释）；
 * 2. 解析结果不是 **1..65535 的整数**（`NaN` / 0 / 越界 / 小数）⇒ 同样回退；
 * 3. 协议默认端口：`https:`/`wss:` → 443，其余 → 80。
 *    ⚠️ 不复用 443 作通用兜底：http 目标回退到 443 会把「端口没给对」伪装成
 *    「连不上」，掩盖真实原因。
 */
export function resolveConnectPort(opts: { port?: number | string; protocol?: string }): number {
  const raw = opts.port
  // ⚠️ 不能只判 `undefined`/`null`：undici 给默认端口时是 `''`
  const parsed = raw === undefined || raw === null || String(raw).trim().length === 0
    ? Number.NaN
    : Number(raw)
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed
  const protocol = String(opts.protocol ?? '').toLowerCase()
  return protocol.startsWith('https') || protocol.startsWith('wss') ? 443 : 80
}
