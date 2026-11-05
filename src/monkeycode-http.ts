/**
 * MonkeyCode 网关的专用 HTTP 传输。
 *
 * ## 为什么不能用全局 `fetch`
 *
 * 网关要求 `X-OhmyAgent-Signature: v1=HMAC-SHA256(signing_secret, prompt)`。
 * bili（billion-context）在 native 模式下会替换 `globalThis.fetch`，按请求头
 * 形状（任何以 `-signature` 结尾的头）把请求判定为「正文签名请求」；它没有
 * `x-ohmyagent-signature` 的重签器，于是按 compress-or-refuse 契约直接回
 * 403 `bili_resign_unavailable` —— 请求根本到不了 MonkeyCode。
 *
 * 这不是凭据问题，换号 / 重新登录都不会好；bili 的文档也明确说第三方插件
 * 若密钥密封在自己手里，唯一出路是走模块级 HTTP 客户端（`undici.request` /
 * `node:http`）直连 —— 它只替换 `globalThis.fetch`，拦不到模块导入。
 *
 * ⚠️ 代价：这条链路不经过 bili 的上下文压缩（bili 也拒绝压缩签名字段）。
 * 这是「能用」与「用不了」之间的取舍，不是可配置项。
 *
 * ## ⚠️⚠️ 为什么用 `undici.request` 而不是 `node:http`（2026-11-05 审计返工）
 *
 * 上一版直接 `node:https.request`，审计打穿三条：
 * 1. **代理被绕过**：`node:https` 不读宿主 `setGlobalDispatcher`、也不读
 *    `HTTP(S)_PROXY` ⇒ 需要代理才能到网关的用户整条渠道消失；
 * 2. **没有超时**：`fetch` 有 undici 默认 300s，`node:http` 默认 0 ⇒ 上游吊死即
 *    永久挂起；
 * 3. **205/≥600 崩溃**：`new Response(body,{status:205})` 在异步回调里抛
 *    `TypeError`（205 是 null-body status），`≥600` 抛 `RangeError` ⇒
 *    **未捕获异常直接带走宿主进程**。
 *
 * `undici.request` 一次解决三条：它走 dispatcher（显式 `ProxyAgent` 时尊重
 * 代理）、自带 `headersTimeout`/`bodyTimeout`，且返回值由我们构造 `Response`
 * 前可以逐项校验。代价是 `undici` 是直接依赖（见 package.json）。
 *
 * @module src/monkeycode-http.ts
 */

import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

import { request as undiciRequest, type Dispatcher } from 'undici'

import { normalizeProxy } from './opencode.js'
import { buildProxyDispatcher } from './opencode-proxy.js'

/** 上游响应头超时（与 undici `fetch` 的默认值对齐）。 */
const HEADERS_TIMEOUT_MS = 300_000
/** 上游响应体空闲超时（同理）。 */
const BODY_TIMEOUT_MS = 300_000

/** 把 `RequestInit['body']` 收敛成 Buffer；不支持的形态**显式抛错**（不静默丢）。 */
function bodyBufferOf(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8')
  throw new TypeError('monkeycodeDirectFetch: 仅支持 string / Uint8Array / ArrayBuffer / URLSearchParams 请求体')
}

/**
 * 拆一条 `NO_PROXY` 条目为 `{ host, port? }`。
 *
 * ⚠️ 2026-11-05 审计返工：**不能**用 `entry.split(':')` ——
 * - IPv6 带方括号（`[::1]`、`[::1]:8080`）会被拆成 `[` / `` / `1]`；
 * - 裸 IPv6（`::1`）的多冒号会被当成 `host:port`；
 * - `*.example.com` 的通配前缀会留在 host 里，永远匹配不上。
 * ⇒ 方括号按 `]` 切、只有**恰好一个**冒号时才当端口。
 */
function noProxyEntry(raw: string): { host: string, port?: string } {
  const entry = raw.trim().toLowerCase()
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']')
    if (end > 0) {
      const host = entry.slice(1, end)
      const rest = entry.slice(end + 1)
      return { host, ...rest.startsWith(':') ? { port: rest.slice(1) } : {} }
    }
  }
  const firstColon = entry.indexOf(':')
  if (firstColon >= 0 && firstColon === entry.lastIndexOf(':')) {
    return { host: entry.slice(0, firstColon), port: entry.slice(firstColon + 1) }
  }
  return { host: entry }
}

/** `NO_PROXY` 是否命中（`*` / 后缀 / `host:port` / IPv4 / IPv6 / 通配前缀）。 */
function bypassesProxy(url: URL, noProxy: string | undefined): boolean {
  if (noProxy === undefined || noProxy.trim() === '') return false
  // `URL.hostname` 对 IPv6 带方括号（`[::1]`）；比较前剥掉，并去掉尾点。
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const { host: entryHost, port: entryPort } = noProxyEntry(entry)
    if (entryPort !== undefined && entryPort !== '' && entryPort !== port) continue
    // 通配前缀 `*.example.com` / `.example.com` / 尾点 `example.com.` 一律归一成裸域。
    const suffix = entryHost
      .replace(/^\./, '')
      .replace(/^\*\.?/, '')
      .replace(/\.$/, '')
    if (suffix === '') continue
    if (host === suffix || host.endsWith(`.${suffix}`)) return true
  }
  return false
}

/** 按协议取环境变量里的出口代理（`HTTPS_PROXY` 优先）。 */
function envProxyFor(url: URL): string | undefined {
  if (bypassesProxy(url, process.env.NO_PROXY ?? process.env.no_proxy)) return undefined
  const raw = url.protocol === 'https:'
    ? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
    : process.env.HTTP_PROXY ?? process.env.http_proxy
  const proxy = raw?.trim()
  return proxy === undefined || proxy === '' ? undefined : proxy
}

/**
 * 补默认端口（`normalizeProxy` 要求显式端口；环境变量里常省略）。
 *
 * ⚠️ 只用 URL 解析补端口，**不改协议**；解析失败原样返回，让 `normalizeProxy`
 * 给出可读的 reason。
 */
function withDefaultPort(raw: string): string {
  try {
    const url = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`)
    if (url.port === '') {
      url.port = url.protocol === 'https:' ? '443' : url.protocol === 'socks5:' ? '1080' : '80'
    }
    return url.toString()
  } catch {
    return raw
  }
}

/**
 * 取（或建）代理 dispatcher —— **复用** `opencode-proxy.ts` 的加固实现。
 *
 * ⚠️ 不要在这里 `new ProxyAgent(...)`（2026-11-05 审计 P1）：仓库那份实现带
 * `clientFactory + pipelining: 0`，用来避免 Clash 类代理静默关闭空闲 CONNECT
 * 隧道导致的请求挂死（实测 2/10 → 10/10，见 `opencode-proxy.ts` 模块头）；
 * 同时它自带 LRU（上限 16）与 `closeAllProxyDispatchers()`（`index.ts` 的
 * `ctx.effect` 已在插件卸载时调用）⇒ 不会留下孤儿连接池。
 */
function dispatcherFor(proxy: string): Dispatcher {
  const normalized = normalizeProxy(withDefaultPort(proxy))
  if (!normalized.ok) {
    // ⚠️ 必须给**可区分**的文案：否则与上游网络故障同形（用户不知道是代理填错）。
    throw new Error(`monkeycode: 出口代理配置非法（${normalized.reason}）`)
  }
  return buildProxyDispatcher(normalized.proxy)
}

/** 单层 `content-encoding` → 解压流（不认识的编码返回 `undefined`）。 */
function decompressorFor(encoding: string): NodeJS.ReadWriteStream | undefined {
  switch (encoding.trim().toLowerCase()) {
    case 'gzip': case 'x-gzip': return createGunzip()
    case 'deflate': return createInflate()
    case 'br': return createBrotliDecompress()
    default: return undefined
  }
}

/**
 * 按 `content-encoding` 逐层解压（多值按 RFC 9110 **逆序**）。
 *
 * ⚠️ 不认识的编码**显式抛错**：静默把压缩字节交给调用方只会得到「未返回任何
 * 内容块」，比报错难查得多（2026-11-05 审计 P2-2）。
 */
function decompressBody(
  body: Readable,
  encoding: string | undefined,
): Readable {
  if (encoding === undefined || encoding.trim() === '') return body
  const layers = encoding.split(',').map((layer) => layer.trim().toLowerCase()).filter((layer) => layer !== '')
  let stream: Readable = body
  for (const layer of layers.reverse()) {
    if (layer === 'identity') continue
    const decoder = decompressorFor(layer)
    if (decoder === undefined) {
      throw new Error(`monkeycode: 不支持的上游 content-encoding「${layer}」`)
    }
    stream = stream.pipe(decoder) as never
  }
  return stream
}

/**
 * 用 `undici.request` 发一次请求，返回 WHATWG `Response`。
 *
 * 只实现适配器真正用到的 Response 表面（`ok` / `status` / `headers` / `body` /
 * `text()`）；响应体流式桥接，不预先缓冲。
 */
export async function monkeycodeDirectFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (input instanceof Request) {
    // ⚠️ 上一版静默丢 body（`content-length: 0`）；与其留个 footgun，不如显式报错。
    //    适配器只传 URL 字符串，这条不可达。
    throw new TypeError('monkeycodeDirectFetch: 不支持 Request 入参（请传 URL 字符串 + init）')
  }
  const url = new URL(String(input))
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers)
  // 网关的 SSE 不应被压缩；显式 identity 避免「代理仍然压缩」时读到 gzip 字节。
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity')
  const body = bodyBufferOf(init?.body)
  if (body !== undefined) headers.set('content-length', String(body.byteLength))

  const signal = init?.signal ?? undefined
  if (signal?.aborted === true) throw new DOMException('The operation was aborted', 'AbortError')

  const proxy = envProxyFor(url)
  try {
    const response = await undiciRequest(url, {
      method,
      headers: Object.fromEntries(headers.entries()),
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
      ...(proxy === undefined ? {} : { dispatcher: dispatcherFor(proxy) }),
      headersTimeout: HEADERS_TIMEOUT_MS,
      bodyTimeout: BODY_TIMEOUT_MS,
    })
    const status = response.statusCode
    // ⚠️ `Response` 构造器只接受 200..599；超出时在**异步路径**抛未捕获异常会
    //    带走宿主进程（205 是 null-body status，带 body 也会抛）。
    if (status < 200 || status > 599) {
      // 先把 body 排空再抛（`destroy()` 会触发未处理的 `AbortError`，同样带走进程）。
      void response.body.dump().catch(() => {})
      throw new Error(`monkeycode: 上游返回非法状态码 ${status}`)
    }
    const responseHeaders = new Headers()
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const item of value) responseHeaders.append(name, item)
      } else {
        responseHeaders.set(name, value)
      }
    }
    const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304
    if (noBody) {
      // 205 是 null-body status：`new Response(body,{status:205})` 会抛 TypeError
      // （审计实测直接带走宿主进程）⇒ 必须传 `null`，并排空底层流。
      void response.body.dump().catch(() => {})
      return new Response(null, { status, statusText: '', headers: responseHeaders })
    }
    const encoding = response.headers['content-encoding']
    const stream = decompressBody(response.body, typeof encoding === 'string' ? encoding : undefined)
    return new Response(Readable.toWeb(stream as never) as unknown as ReadableStream<Uint8Array>, {
      status,
      statusText: '',
      headers: responseHeaders,
    })
  } catch (error) {
    // abort 的语义要保住：undici 抛 `RequestAbortedError`，统一成 `AbortError`，
    // 否则调用方的 `isAbortLike` / `signal.aborted` 判据会把它记成普通失败。
    if (signal !== undefined && signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    throw error
  }
}
