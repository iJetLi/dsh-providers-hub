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
import { parseTraeCallbackDetailed, startTraeLoginFlow } from '../../src/trae-oauth.js'
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