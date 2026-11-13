/**
 * `trae-manual-callback.spec.ts` —— TRAE（字节跳动）**手动回调链接**守卫。
 *
 * ## 与 CodeArts 的机制差异（本文件据此设计断言）
 *
 * TRAE 回调**直传 token 材料**（`refreshToken` / `userInfo` / `userJwt`），
 * 不是 OAuth 的 `?code=` 交换：
 * - 交换请求（`exchangeTraeCallback`）只带 `ClientID` + `RefreshToken`，
 *   **不带** `redirect_uri` ⇒ 链接端口与本机监听端口是否一致不影响换取；
 * - `machineId` / `deviceId` 登录时已生成，手动提交与浏览器回调共用同一闭包。
 *
 * 因此本文件**不**断言「端口必须来自链接」（那是 codearts 的约束），
 * 而是断言：
 * 1. 手动粘贴的 token 材料真的被送去 ExchangeToken 并轮换；
 * 2. 凭据里持久化了 machine_id / device_id（续期与签到依赖）；
 * 3. 重复提交被拒且不二次发 ExchangeToken（refreshToken 轮换是破坏性的）；
 * 4. 失败返回可读文案、不抛、进程不退出；
 * 5. HTTP 原路径未被改动（回归）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  normalizeTraeManualCallbackText,
  parseTraeCallbackDetailed,
  startTraeLoginFlow,
} from '../../src/trae-oauth.js'
import { TRAE } from '../../src/trae-product.js'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => {
      if (!server.listening) { resolve(); return }
      server.close(() => resolve())
    })
  }
  servers.length = 0
})

/** 占一个随机端口再释放，拿它当首选端口（避免与别的测试/服务冲突）。 */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const probe = createServer()
  servers.push(probe)
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    release: () => new Promise<void>((resolve) => probe.close(() => resolve())),
  }
}

/** ExchangeToken + GetUserInfo 的 fetch 桩（形状对齐既有 trae-oauth.spec.ts）。 */
function traeFetcher(hits: Array<{ path: string; refreshToken?: string }>): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string> : {}
    hits.push({ path: target, refreshToken: body.RefreshToken })
    if (target.includes('/ExchangeToken')) {
      if (body.RefreshToken === 'BAD-RT') {
        return new Response(JSON.stringify({ Code: 'x', Message: 'rejected' }), { status: 400 })
      }
      return new Response(JSON.stringify({
        Result: {
          Token: 'AT-final', RefreshToken: 'RT-rotated',
          TokenExpireAt: Date.now() + 7_200_000, TokenExpireDuration: 7200,
        },
      }), { status: 200 })
    }
    if (target.includes('/GetUserInfo')) {
      return new Response(JSON.stringify({
        Result: { UserID: 'u-manual', ScreenName: '手动登录用户', EnterpriseID: 'ent-1' },
      }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

/** 一条真实形态的 TRAE 回调链接（token 直传）。 */
function manualCallbackUrl(port: number, refreshToken = 'RT-manual'): string {
  const params = new URLSearchParams({
    refreshToken,
    userInfo: JSON.stringify({ UserID: 'u-manual', ScreenName: '手动登录用户', TenantID: 'ent-1' }),
    userJwt: JSON.stringify({ Token: 'AT-jwt', RefreshToken: 'RT-jwt' }),
  })
  return `http://127.0.0.1:${port}/authorize?${params.toString()}`
}

describe('TRAE submitManualCallback（手动链接走同一 exchange 与同一 result）', () => {
  it('合法链接 ⇒ 凭据落定，refreshToken 被轮换，machine/device 指纹持久化', async () => {
    const { port, release } = await occupyPort()
    await release()
    const hits: Array<{ path: string; refreshToken?: string }> = []
    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port, fetcher: traeFetcher(hits) })
    try {
      // ⚠️ 端口刻意用**另一个**值：TRAE 交换不带 redirect_uri，端口不一致不影响换取。
      //    这正是与 codearts 的关键差异，也是本用例存在的理由。
      const submitted = started.submitManualCallback(manualCallbackUrl(1, 'RT-manual'))
      expect(submitted).toEqual({ ok: true })

      const outcome = await started.result
      const credential = JSON.parse(outcome.access) as Record<string, unknown>
      expect(credential.access_token).toBe('AT-final')
      expect(credential.refresh_token).toBe('RT-rotated')
      expect(credential.uid).toBe('u-manual')
      expect(String(credential.machine_id)).toMatch(/^[0-9a-f]{32}$/)
      expect(String(credential.device_id)).toMatch(/^[0-9a-f]{32}$/)

      // ExchangeToken 收到的是**链接里的** refreshToken（不是登录时的别的值）。
      const exchange = hits.find((hit) => hit.path.includes('/ExchangeToken'))
      expect(exchange?.refreshToken).toBe('RT-manual')
      // GetUserInfo 也必须走到（补齐手机号/邮箱的通道）。
      expect(hits.some((hit) => hit.path.includes('/GetUserInfo'))).toBe(true)
    } finally {
      await started.close()
    }
  })

  it('空串 / 垃圾文本 ⇒ ok:false + 可读原因，且不打任何上游请求', async () => {
    const { port, release } = await occupyPort()
    await release()
    const hits: Array<{ path: string }> = []
    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port, fetcher: traeFetcher(hits) })
    try {
      for (const bad of ['', '   ', '随便粘的一段话', undefined, 123]) {
        const submitted = started.submitManualCallback(bad)
        expect(submitted.ok).toBe(false)
        expect(typeof submitted.message).toBe('string')
        expect((submitted.message ?? '').length).toBeGreaterThan(8)
        expect(submitted.message).not.toMatch(/undefined|null|\[object/)
      }
      expect(hits).toHaveLength(0)
    } finally {
      await started.close()
    }
  })

  it('只有 query（/authorize?… 与裸 refreshToken=…）也能解析', async () => {
    const { port, release } = await occupyPort()
    await release()
    const hits: Array<{ path: string; refreshToken?: string }> = []
    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port, fetcher: traeFetcher(hits) })
    try {
      const params = new URLSearchParams({
        refreshToken: 'RT-query',
        userInfo: JSON.stringify({ UserID: 'u-q', ScreenName: 'q', TenantID: '' }),
      })
      expect(started.submitManualCallback(`/authorize?${params.toString()}`).ok).toBe(true)
      const outcome = await started.result
      expect(JSON.parse(outcome.access).access_token).toBe('AT-final')
    } finally {
      await started.close()
    }
  })

  it('PKCE 形态（只有 code）⇒ 明确报「暂不支持 PKCE」而不是含糊的缺 token', async () => {
    const { port, release } = await occupyPort()
    await release()
    const hits: Array<{ path: string }> = []
    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port, fetcher: traeFetcher(hits) })
    try {
      const submitted = started.submitManualCallback('http://127.0.0.1:1/authorize?code=PKCE-CODE')
      expect(submitted.ok).toBe(false)
      expect(submitted.message).toContain('PKCE')
      expect(hits).toHaveLength(0)
    } finally {
      await started.close()
    }
  })

  it('落定后重复提交 ⇒ ok:false 且不抛、不再发第二次 ExchangeToken', async () => {
    const { port, release } = await occupyPort()
    await release()
    const hits: Array<{ path: string }> = []
    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port, fetcher: traeFetcher(hits) })
    try {
      expect(started.submitManualCallback(manualCallbackUrl(port, 'RT-once')).ok).toBe(true)
      await started.result

      let threw = false
      let again: { ok: boolean; message?: string } | undefined
      try {
        again = started.submitManualCallback(manualCallbackUrl(port, 'RT-once'))
      } catch {
        threw = true
      }
      expect(threw).toBe(false)
      expect(again?.ok).toBe(false)
      // ⚠️ refreshToken 轮换是破坏性的：第二次 ExchangeToken 必然失败，
      //    且会把「已经成功」的结果搅浑。这里必须一次都不多发。
      expect(hits.filter((hit) => hit.path.includes('/ExchangeToken'))).toHaveLength(1)
    } finally {
      await started.close()
    }
  })

  it('ExchangeToken 拒绝 ⇒ result 拒绝（失败可见），提交当时仍 ok:true', async () => {
    const { port, release } = await occupyPort()
    await release()
    const hits: Array<{ path: string }> = []
    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port, fetcher: traeFetcher(hits) })
    try {
      expect(started.submitManualCallback(manualCallbackUrl(port, 'BAD-RT')).ok).toBe(true)
      await expect(started.result).rejects.toThrow(/ExchangeToken/)
    } finally {
      await started.close()
    }
  })
})

describe('TRAE 浏览器原回调路径未被手动提交改动（回归）', () => {
  it('真发一跳 /authorize ⇒ 200 且凭据落定', async () => {
    const { port, release } = await occupyPort()
    await release()
    const hits: Array<{ path: string; refreshToken?: string }> = []
    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port, fetcher: traeFetcher(hits) })
    try {
      const response = await fetch(manualCallbackUrl(port, 'RT-http'))
      expect(response.status).toBe(200)
      await response.text()
      const outcome = await started.result
      const credential = JSON.parse(outcome.access) as Record<string, unknown>
      expect(credential.access_token).toBe('AT-final')
      expect(hits.find((hit) => hit.path.includes('/ExchangeToken'))?.refreshToken).toBe('RT-http')
    } finally {
      await started.close()
    }
  })

  it('回调无效 ⇒ 400 且 result 拒绝（不永远挂起）', async () => {
    const { port, release } = await occupyPort()
    await release()
    const hits: Array<{ path: string }> = []
    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port, fetcher: traeFetcher(hits) })
    try {
      const response = await fetch(`http://127.0.0.1:${port}/authorize?foo=bar`)
      expect(response.status).toBe(400)
      await response.text()
      await expect(started.result).rejects.toThrow()
      expect(hits).toHaveLength(0)
    } finally {
      await started.close()
    }
  })
})

describe('parseTraeCallbackDetailed 对手动输入的边界（纯函数）', () => {
  it('完整 URL / 相对路径 / 裸 query 三种形态等价', () => {
    const params = 'refreshToken=RT-x&userInfo=' + encodeURIComponent(JSON.stringify({ UserID: 'u' }))
    const a = parseTraeCallbackDetailed(`http://127.0.0.1:18080/authorize?${params}`)
    const b = parseTraeCallbackDetailed(`/authorize?${params}`)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.info.refreshToken).toBe(b.info.refreshToken)
  })
})

describe('normalizeTraeManualCallbackText（粘贴文本的四类形态）', () => {
  const query = 'refreshToken=RT-x&userInfo=' + encodeURIComponent(JSON.stringify({ UserID: 'u' }))

  it('完整 URL ⇒ 原样（不改写）', () => {
    const url = `http://127.0.0.1:50000/authorize?${query}`
    expect(normalizeTraeManualCallbackText(url)).toBe(url)
  })

  it('相对路径 /authorize?… ⇒ 原样（解析器会补 http://127.0.0.1）', () => {
    expect(normalizeTraeManualCallbackText(`/authorize?${query}`)).toBe(`/authorize?${query}`)
  })

  it('裸 query（带不带 ? 都行）⇒ 补成 /authorize?…', () => {
    expect(normalizeTraeManualCallbackText(`?${query}`)).toBe(`/authorize?${query}`)
    expect(normalizeTraeManualCallbackText(query)).toBe(`/authorize?${query}`)
  })

  it('★★ 无 scheme 的 host:port 链接 ⇒ 补 http:// 而不是当成裸 query（PR #58 审计 P2）', () => {
    // ⚠️ 错的实现（把这一格当裸 query）会得到
    //    `/authorize?127.0.0.1:50000/authorize?refreshToken=…` —— 整条串变成
    //    **参数名**，解析器随后报「回调未携带 refreshToken」。
    const text = `127.0.0.1:50000/authorize?${query}`
    const normalized = normalizeTraeManualCallbackText(text)
    expect(normalized).toBe(`http://${text}`)
    const parsed = parseTraeCallbackDetailed(normalized)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.info.refreshToken).toBe('RT-x')
  })

  it('裸 query 里的冒号+数字不得被误判成 authority', () => {
    // `code=123:456` 形态：宽口径正则会把 `code=123` 当 host、`456` 当端口。
    expect(normalizeTraeManualCallbackText('code=123:456')).toBe('/authorize?code=123:456')
    expect(normalizeTraeManualCallbackText('?refreshToken=a:b')).toBe('/authorize?refreshToken=a:b')
  })
})

describe('submitManualCallback 只接受回环地址（PR #58 审计 P3）', () => {
  it('非回环 host ⇒ 明确报「多半是授权页」，且不打任何上游请求', async () => {
    const { port, release } = await occupyPort()
    await release()
    const hits: Array<{ path: string }> = []
    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port, fetcher: traeFetcher(hits) })
    try {
      const submitted = started.submitManualCallback('http://evil.example.com:50000/authorize?refreshToken=RT-x')
      expect(submitted.ok).toBe(false)
      expect(submitted.message).toContain('evil.example.com')
      expect(submitted.message).toContain('127.0.0.1')
      expect(hits).toHaveLength(0)
    } finally {
      await started.close()
    }
  })

  it('回环的三种写法都放行（127.0.0.1 / localhost / [::1]）', async () => {
    const { port, release } = await occupyPort()
    await release()
    const hits: Array<{ path: string }> = []
    const started = await startTraeLoginFlow({ product: TRAE, callbackPort: port, fetcher: traeFetcher(hits) })
    try {
      // 只判「归一化 + 回环判据」这一层：三次都应进到 ExchangeToken 之前。
      for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
        const probe = startTraeLoginFlow({ product: TRAE, callbackPort: port + 1, fetcher: traeFetcher([]) })
        const flow = await probe
        try {
          const result = flow.submitManualCallback(`http://${host}:50000/authorize?refreshToken=RT-${'x'}`)
          expect(result.ok).toBe(true)
        } finally {
          await flow.close()
        }
      }
      // 主 flow 一次都没被消费（上面三次用的是独立 flow）。
      expect(hits).toHaveLength(0)
    } finally {
      await started.close()
    }
  })
  /**
   * ★★ 裸 query（**无前导 `?`**、无 `/authorize` 前缀）—— PR #58 对抗审计 M4c。
   *
   * 这条腿是归一化的**第三支**（`/authorize?${text.replace(/^\?/, '')}`）。
   * 原用例名写着「`/authorize?…` 与裸 `refreshToken=…` 也能解析」，但用例体
   * **只提交了带前导 `?` 的那种**：`parseTraeCallbackDetailed` 内部是
   * `new URL(rawUrl.startsWith('http') ? rawUrl : \`http://127.0.0.1${rawUrl}\`)`，
   * 而 `http://127.0.0.1?refreshToken=…` 是合法的「空路径 + query」⇒
   * **不包装也能通过**。只有不带 `?` 的裸 query 才会被拼成
   * `http://127.0.0.1refreshToken=…`（host 被吞掉）⇒ 必然失败。
   * ⇒ 第三支实测零覆盖，且用例名会让后来者以为已经测过。
   */
  it('★★ 裸 query（无前导 ?）必须补 /authorize? 前缀，否则 host 被吞掉、解析必然失败', () => {
    const bare = 'refreshToken=RT-bare&userInfo=U&userJwt.Token=J'
    expect(normalizeTraeManualCallbackText(bare)).toBe(`/authorize?${bare}`)

    // 归一化后的串必须真的能被解析出三个字段（这条断言才是 M4c 的牙：
    // 把第三支退化成 `: text` 时 `new URL('http://127.0.0.1refreshToken=…')` 直接抛/失败）。
    const parsed = parseTraeCallbackDetailed(`/authorize?${bare}`)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.info.refreshToken).toBe('RT-bare')
    }

    // 反向钉子：带前导 `?` 的形态**也**必须补前缀（两种都走第三支，
    // 但靠的是 `replace(/^\?/, '')`；漏掉 replace 会拼出 `??`）。
    expect(normalizeTraeManualCallbackText(`?${bare}`)).toBe(`/authorize?${bare}`)
  })
})

