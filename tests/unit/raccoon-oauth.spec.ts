import { describe, expect, it, vi } from 'vitest'
import { RACCOON } from '../../src/raccoon-product.js'
import {
  buildQrImageUrl,
  createRaccoonQrTicket,
  exchangeRaccoonAuthorizationCode,
  fetchRaccoonUserInfo,
  loginRaccoonWithSmsCode,
  pollRaccoonQrLogin,
  refreshRaccoonCredential,
  sendRaccoonSmsCode,
} from '../../src/raccoon-oauth.js'

/** 造一个最小 JWT（exp 在指定秒数）。 */
function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ exp: expSeconds, name: 'RaccoonAva' })).toString('base64url')
  return `${header}.${body}.sig`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('createRaccoonQrTicket', () => {
  it('向 IAM 申请票据，解析出 code / scanPath / 两个毫秒间隔', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 'OK',
      message: 'success',
      request_id: 'reqiam-1',
      data: {
        qrcode_code: 'qr-01a1db13-77bc-7239-beae-3953ada73ea7',
        scan_path: '/login/mp',
        expires_in: 300,
        poll_interval: 2,
        status: 'pending',
      },
    }))
    const ticket = await createRaccoonQrTicket(RACCOON, fetcher as unknown as typeof fetch)

    expect(ticket).toEqual({
      code: 'qr-01a1db13-77bc-7239-beae-3953ada73ea7',
      scanPath: '/login/mp',
      expiresInMs: 300_000,
      pollIntervalMs: 2_000,
    })
    /**
     * ⚠️⚠️ 必须打 **IAM** 前缀（`/api/iam/v1`），不是业务 API 前缀
     * （`/api/web/auth/v1`）—— 2026-11-14 扫码链路整体迁到 IAM，
     * 打错前缀会 404 且症状是「二维码一直拿不到」。
     */
    expect(fetcher.mock.calls[0]![0]).toBe(`${RACCOON.apiBase}/api/iam/v1/auth/mp/qrcode`)
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST' })
  })

  it('非 OK 码时抛出可读错误（不能静默退回本地随机 code）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 'INTERNAL', message: 'boom' }))
    await expect(createRaccoonQrTicket(RACCOON, fetcher as unknown as typeof fetch))
      .rejects.toThrow('boom')
  })

  it('缺 qrcode_code 时抛错', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 'OK', data: { scan_path: '/login/mp', expires_in: 300, poll_interval: 2 },
    }))
    await expect(createRaccoonQrTicket(RACCOON, fetcher as unknown as typeof fetch))
      .rejects.toThrow('qrcode_code')
  })

  it('缺 scan_path（或非绝对路径）时抛错', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 'OK', data: { qrcode_code: 'qr-x', expires_in: 300, poll_interval: 2 },
    }))
    await expect(createRaccoonQrTicket(RACCOON, fetcher as unknown as typeof fetch))
      .rejects.toThrow('scan_path')
  })

  it('★ 服务端给退化值时走兜底（不能把 0 秒轮询打给页面）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 'OK', data: { qrcode_code: 'qr-x', scan_path: '/login/mp', expires_in: 0, poll_interval: 0 },
    }))
    const ticket = await createRaccoonQrTicket(RACCOON, fetcher as unknown as typeof fetch)
    expect(ticket.expiresInMs).toBe(300_000)
    expect(ticket.pollIntervalMs).toBe(2_000)
  })

  it('★★ 上界夹取（expires_in 60 分钟 / poll_interval 10 分钟都不许原样下发）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 'OK', data: { qrcode_code: 'qr-x', scan_path: '/login/mp', expires_in: 3_600, poll_interval: 600 },
    }))
    const ticket = await createRaccoonQrTicket(RACCOON, fetcher as unknown as typeof fetch)
    expect(ticket.expiresInMs).toBe(3_600_000)
    expect(ticket.pollIntervalMs).toBe(60_000)
  })
})

describe('buildQrImageUrl', () => {
  const ticket = {
    code: 'qr-01a1db13',
    scanPath: '/login/mp',
    expiresInMs: 300_000,
    pollIntervalMs: 2_000,
  }

  it('★ 用服务端下发的 scan_path 拼，带 code / appname / source=platform', () => {
    const url = new URL(buildQrImageUrl(RACCOON, ticket))

    expect(url.origin).toBe('https://xiaohuanxiong.com')
    expect(url.pathname).toBe('/login/mp')
    expect(url.searchParams.get('code')).toBe('qr-01a1db13')
    expect(url.searchParams.get('appname')).toBe('商汤小浣熊官网')
    // 官网 `5348-…js` 明确 set('source','platform')；漏了会影响扫码后的归因
    expect(url.searchParams.get('source')).toBe('platform')
  })

  it('scan_path 换成别的路径时也跟着变（不是硬编码 /login/mp）', () => {
    const url = new URL(buildQrImageUrl(RACCOON, { ...ticket, scanPath: '/login/qr' }))
    expect(url.pathname).toBe('/login/qr')
  })
})

describe('pollRaccoonQrLogin', () => {
  it('pending 状态原样返回，且打 IAM 的登录端点', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 'OK', data: { status: 'pending' } }))
    const result = await pollRaccoonQrLogin(RACCOON, 'qr-c', fetcher as unknown as typeof fetch)

    expect(result.status).toBe('pending')
    expect(fetcher.mock.calls[0]![0]).toBe(`${RACCOON.apiBase}/api/iam/v1/auth/mp/qrcode/login`)
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST' })
  })

  it('success 时取出 token 并推算 expires_at（毫秒字符串）', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const fetcher = vi.fn(async () => jsonResponse({
      code: 'OK',
      data: { status: 'success', access_token: jwtWithExp(exp), refresh_token: 'r1' },
    }))
    const result = await pollRaccoonQrLogin(RACCOON, 'qr-c', fetcher as unknown as typeof fetch)

    expect(result.status).toBe('success')
    expect(result.accessToken).toBe(jwtWithExp(exp))
    expect(result.refreshToken).toBe('r1')
    expect(result.expiresAt).toBe(String(exp * 1000))
  })

  it('logging 时带出 expired_at（供页面续期计时）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 'OK', data: { status: 'logging', expired_at: '2030-01-01T00:00:00Z' },
    }))
    const result = await pollRaccoonQrLogin(RACCOON, 'qr-c', fetcher as unknown as typeof fetch)

    expect(result.status).toBe('logging')
    expect(result.expiredAt).toBe('2030-01-01T00:00:00Z')
  })

  it('网络异常时降级为 pending（不打断轮询）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network down') })
    const result = await pollRaccoonQrLogin(RACCOON, 'qr-c', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('pending')
  })

  it('未知 status 也降级为 pending（不误判成成功）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 'OK', data: { status: 'weird' } }))
    const result = await pollRaccoonQrLogin(RACCOON, 'qr-c', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('pending')
  })

  it('success 但缺 access_token 时不当作成功', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 'OK', data: { status: 'success' } }))
    const result = await pollRaccoonQrLogin(RACCOON, 'qr-c', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('pending')
  })

  it('canceled 状态透传', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 'OK', data: { status: 'canceled' } }))
    const result = await pollRaccoonQrLogin(RACCOON, 'qr-c', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('canceled')
  })

  /**
   * ★★★ 这一格是 Gitee IKVA90 的核心回归守卫：
   * 二维码过期时 IAM 回 `401 + AUTH_QRCODE_INVALID`，必须映射成 `expired`
   * （终态、触发重签）。若也降级成 `pending`，页面会**永远转圈**。
   */
  it('★★★ AUTH_QRCODE_INVALID（HTTP 401）⇒ expired，不许降级成 pending', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 'AUTH_QRCODE_INVALID',
      message: 'mini-program QR code invalid',
      request_id: 'reqiam-2',
    }, 401))
    const result = await pollRaccoonQrLogin(RACCOON, 'qr-stale', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('expired')
  })

  it('★★ 只有 HTTP 401 而 code 缺失时也判 expired（网关换皮的兜底）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: 'unauthorized' }, 401))
    const result = await pollRaccoonQrLogin(RACCOON, 'qr-stale', fetcher as unknown as typeof fetch)
    expect(result.status).toBe('expired')
  })
})

describe('sendRaccoonSmsCode', () => {
  it('加密手机号后提交，带 captcha_param 与 nation_code', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, message: 'success' }))
    await sendRaccoonSmsCode(RACCOON, '13800000000', 'captcha-token', fetcher as unknown as typeof fetch)
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${RACCOON.apiBase}${RACCOON.authApiPrefix}/send_sms`)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.nation_code).toBe('86')
    expect(body.captcha_param).toBe('captcha-token')
    // 手机号必须是密文（不是明文）
    expect(body.phone).not.toBe('13800000000')
    expect(typeof body.phone).toBe('string')
  })

  it('captcha_verify_error 时抛出可读错误（提示重新过滑块）', async () => {
    const fetcher = vi.fn(async () => jsonResponse(
      { code: 100006, message: 'captcha_verify_error', details: 'captcha verify failed' }, 400,
    ))
    await expect(sendRaccoonSmsCode(RACCOON, '13800000000', 'bad', fetcher as unknown as typeof fetch))
      .rejects.toThrow(/验证码/)
  })
})

describe('loginRaccoonWithSmsCode', () => {
  it('成功后返回完整凭据（含 expires_at）', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: { access_token: jwtWithExp(exp), refresh_token: 'r', office_identity: 'personal' },
    }))
    const credential = await loginRaccoonWithSmsCode(
      RACCOON, '13800000000', '123456', fetcher as unknown as typeof fetch,
    )
    expect(credential.access_token).toBe(jwtWithExp(exp))
    expect(credential.refresh_token).toBe('r')
    expect(credential.expires_at).toBe(String(exp * 1000))
    expect(credential.office_identity).toBe('personal')
  })

  it('缺少 access_token 时抛错（不产出半截凭据）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { refresh_token: 'r' } }))
    await expect(loginRaccoonWithSmsCode(RACCOON, '13800000000', '1', fetcher as unknown as typeof fetch))
      .rejects.toThrow(/access_token/)
  })

  it('验证码错误时透传服务端文案', async () => {
    const fetcher = vi.fn(async () => jsonResponse(
      { code: 100002, message: 'params_invalid_error', details: 'sms code invalid' }, 400,
    ))
    await expect(loginRaccoonWithSmsCode(RACCOON, '13800000000', 'bad', fetcher as unknown as typeof fetch))
      .rejects.toThrow(/sms code invalid/)
  })
})

describe('refreshRaccoonCredential', () => {
  it('用 refresh_token 换新 token，并保留旧凭据的附加字段', async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0, data: { access_token: jwtWithExp(exp), refresh_token: 'r2' },
    }))
    const next = await refreshRaccoonCredential(
      RACCOON,
      { access_token: 'old', refresh_token: 'r1', office_identity: 'personal', nickname: 'Ava' },
      fetcher as unknown as typeof fetch,
    )
    expect(next.access_token).toBe(jwtWithExp(exp))
    expect(next.refresh_token).toBe('r2')
    expect(next.expires_at).toBe(String(exp * 1000))
    // 服务端不返回的字段要保留，否则昵称/身份会丢
    expect(next.office_identity).toBe('personal')
    expect(next.nickname).toBe('Ava')
  })

  it('服务端未返回新 refresh_token 时保留旧的', async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { access_token: jwtWithExp(exp) } }))
    const next = await refreshRaccoonCredential(
      RACCOON, { access_token: 'old', refresh_token: 'r1' }, fetcher as unknown as typeof fetch,
    )
    expect(next.refresh_token).toBe('r1')
  })

  it('401 时抛出「请重新登录」（不重试）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 200003, message: 'authorization_verify_error' }, 401))
    await expect(refreshRaccoonCredential(
      RACCOON, { access_token: 'old', refresh_token: 'r1' }, fetcher as unknown as typeof fetch,
    )).rejects.toThrow(/重新登录/)
  })
})

describe('exchangeRaccoonAuthorizationCode', () => {
  it('用授权码换凭据（官方桌面端链路，供将来复用）', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: { access_token: jwtWithExp(exp), refresh_token: 'r', office_identity: 'personal' },
    }))
    const credential = await exchangeRaccoonAuthorizationCode(
      RACCOON, 'auth-code', fetcher as unknown as typeof fetch,
    )
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${RACCOON.apiBase}${RACCOON.authApiPrefix}/login_with_authorization_code`)
    expect(JSON.parse(String(init.body))).toEqual({ authorization_code: 'auth-code' })
    expect(credential.access_token).toBe(jwtWithExp(exp))
  })

  it('授权码失效（200035）时给出可操作提示', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 200035, message: 'not found' }, 400))
    await expect(exchangeRaccoonAuthorizationCode(
      RACCOON, 'stale', fetcher as unknown as typeof fetch,
    )).rejects.toThrow(/授权码已失效/)
  })
})

describe('fetchRaccoonUserInfo', () => {
  it('取出用户 id、昵称与身份', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: { id: '7445120', name: 'RaccoonAva', office_identity: 'personal' },
    }))
    const info = await fetchRaccoonUserInfo(
      RACCOON, { access_token: 't', refresh_token: 'r' }, fetcher as unknown as typeof fetch,
    )
    expect(info.userId).toBe('7445120')
    expect(info.nickname).toBe('RaccoonAva')
    expect(info.officeIdentity).toBe('personal')
  })

  it('失败时返回空对象（用户信息是展示用，不该让登录失败）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 1, message: 'err' }, 500))
    const info = await fetchRaccoonUserInfo(
      RACCOON, { access_token: 't', refresh_token: 'r' }, fetcher as unknown as typeof fetch,
    )
    expect(info).toEqual({})
  })

  it('网络异常时也返回空对象', async () => {
    const fetcher = vi.fn(async () => { throw new Error('down') })
    const info = await fetchRaccoonUserInfo(
      RACCOON, { access_token: 't', refresh_token: 'r' }, fetcher as unknown as typeof fetch,
    )
    expect(info).toEqual({})
  })
})
