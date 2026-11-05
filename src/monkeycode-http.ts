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

import { ProxyAgent, request as undiciRequest } from 'undici'

/** 上游响应头超时（与 undici `fetch` 的默认值对齐）。 */
const HEADERS_TIMEOUT_MS = 300_000
/** 上游响应体空闲超时（同理）。 */
const BODY_TIMEOUT_MS = 300_000

/** 代理 dispatcher 缓存（按代理 URL 复用连接池，避免每请求新建）。 */
const dispatchers = new Map<string, ProxyAgent>()

/** 把 `RequestInit['body']` 收敛成 Buffer；不支持的形态**显式抛错**（不静默丢）。 */
function bodyBufferOf(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8')
  throw new TypeError('monkeycodeDirectFetch: 仅支持 string / Uint8Array / ArrayBuffer / URLSearchParams 请求体')
}

/** `NO_PROXY` 是否命中（`*` / 后缀 / `host:port`）。 */
function bypassesProxy(url: URL, noProxy: string | undefined): boolean {
  if (noProxy === undefined || noProxy.trim() === '') return false
  const host = url.hostname.toLowerCase()
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const [entryHost, entryPort] = entry.split(':')
    if (entryPort !== undefined && entryPort !== '' && entryPort !== port) continue
    const suffix = entryHost.replace(/^\./, '')
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

/** 取（或建）代理 dispatcher。 */
function dispatcherFor(proxy: string): ProxyAgent {
  const existing = dispatchers.get(proxy)
  if (existing !== undefined) return existing
  const created = new ProxyAgent(proxy)
  dispatchers.set(proxy, created)
  return created
}

/** `content-encoding` → 解压流（不认识的编码**不猜**，交给调用方看到原始字节会失败）。 */
function decompressorFor(encoding: string): NodeJS.ReadWriteStream | undefined {
  switch (encoding.trim().toLowerCase()) {
    case 'gzip': case 'x-gzip': return createGunzip()
    case 'deflate': return createInflate()
    case 'br': return createBrotliDecompress()
    default: return undefined
  }
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
    const decoder = typeof encoding === 'string' ? decompressorFor(encoding) : undefined
    const stream = decoder === undefined ? response.body : response.body.pipe(decoder)
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
