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
 * 若密钥密封在自己手里，唯一出路是走 `node:http` / `node:https` 直连
 * （`dsh-our-free-model` v1.4.5 的 EAC 车道就是这么做的）。`node:https` 是
 * 进程内置模块，别的插件无法替换，所以签名请求可以逐字节离开本进程。
 *
 * ⚠️ 代价：这条链路不经过 bili 的上下文压缩（bili 也拒绝压缩签名字段）。
 * 这是「能用」与「用不了」之间的取舍，不是可配置项。
 *
 * @module src/monkeycode-http.ts
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

/** Node 的 `request` 返回值在 abort 时需要保留的引用。 */
function bodyBufferOf(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8')
  throw new TypeError('monkeycodeDirectFetch: 仅支持 string / Uint8Array / ArrayBuffer / URLSearchParams 请求体')
}

/**
 * 用 `node:http` / `node:https` 发一次请求，返回 WHATWG `Response`。
 *
 * 只实现适配器真正用到的 Response 表面（`ok` / `status` / `headers` / `body` /
 * `text()`）；用原生 `Response` 包一层是为了让 `consumeMonkeycodeSse` 无需知道
 * 传输实现。响应体用 `Readable.toWeb` 流式桥接，不预先缓冲。
 */
export function monkeycodeDirectFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const requestUrl = input instanceof Request ? input.url : String(input)
  const url = new URL(requestUrl)
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  // 网关的 SSE 不应被压缩；显式 identity 避免 Node 不自动解压导致
  // `consumeMonkeycodeSse` 读到 gzip 字节。
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity')
  const body = bodyBufferOf(init?.body)
  if (body !== undefined) headers.set('content-length', String(body.byteLength))

  return new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined
    if (signal?.aborted === true) {
      reject(new DOMException('The operation was aborted', 'AbortError'))
      return
    }

    const transport = url.protocol === 'http:' ? httpRequest : httpsRequest
    const request = transport({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method,
      headers: Object.fromEntries(headers.entries()),
    }, (response) => {
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item)
        } else {
          responseHeaders.set(name, value)
        }
      }
      const status = response.statusCode ?? 502
      const noBody = method === 'HEAD' || status === 204 || status === 304
      const responseBody = noBody
        ? null
        : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>
      resolve(new Response(responseBody, {
        status,
        statusText: response.statusMessage ?? '',
        headers: responseHeaders,
      }))
    })

    const abort = (): void => {
      request.destroy(new DOMException('The operation was aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    request.on('close', () => signal?.removeEventListener('abort', abort))
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}
