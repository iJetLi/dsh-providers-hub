import { describe, expect, it, vi } from 'vitest'
import {
  fetchAccioBalanceDetailed,
  fetchAccioUserInfo,
  flattenAccioCredits,
} from '../../src/accio-credits.js'
import type { AccioCredential } from '../../src/accio.js'

const cred: AccioCredential = {
  access_token: 'tok', refresh_token: 'rt', expires_at: Date.now() + 3_600_000, region: 'cn',
}

describe('⚠️ 三个端点的传参方式各不相同（用错即 405/400）', () => {
  it('userinfo 必须 POST 且 token 在 body', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true, data: { userId: 'u1', userName: 'U', routeRegion: 'CN', userLevel: 'freeMember' },
    }), { status: 200 }))
    // ⚠️ 断言返回值：只 await 不看结果的话，函数「返回 undefined」也算绿
    //    （等于没锁住「信封拆对了」这件事）。
    const info = await fetchAccioUserInfo(cred, { fetcher: fetcher as unknown as typeof fetch })
    expect(info).toEqual({
      userId: 'u1', userName: 'U', routeRegion: 'CN', userLevel: 'freeMember', maskedMobile: '',
      // ★ issue #177：新增解析 `activeTeam`。本 fixture 的响应里**没有**该字段
      //   ⇒ 必须解析成 `null`（个人空间），而**不是** undefined —— 后者会让
      //   「字段缺失」与「解析失败」同形，团队账号就永远拿不到 teamId。
      activeTeam: null,
    })

    // ⚠️ 必须钉住 method **与** token 位置：只断言「发出去了」是空转的
    //    （把 POST 改成 GET、token 挪进 query，旧断言照样全绿）。
    expect(fetcher.mock.calls).toHaveLength(1)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://phoenix-gw.alibaba.com/api/auth/userinfo')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ accessToken: 'tok' })
    // token **不得**同时出现在 query（GET 才会那样发，混用是另一种形状）
    expect(url).not.toContain('accessToken')
  })

  it('currentSubscription 必须 GET 且 token 在 query', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { total: 200, remaining: 200, type: 'FREE', entitlement: { daily: { total: 200, used: 0, remaining: 200 } } },
    }), { status: 200 }))
    await fetchAccioBalanceDetailed(cred, { fetcher: fetcher as unknown as typeof fetch })

    // ⚠️ 按 URL 认领那次调用（而不是写死 `calls[0]`）：端点调用顺序是**实现细节**，
    //    写死下标会让「换顺序」这类无害重构假失败。
    const call = fetcher.mock.calls.find(([u]) => String(u).includes('/currentSubscription'))
    expect(call, '没有向 /currentSubscription 发请求').toBeDefined()
    const [url, init] = call as unknown as [string, RequestInit]
    expect(init.method).toBe('GET')
    expect(url.startsWith('https://phoenix-gw.alibaba.com/api/entitlement/currentSubscription?')).toBe(true)
    expect(url).toContain('accessToken=tok')
    expect(init.body).toBeUndefined()
  })

  it('quota 是 GET + query', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('/quota')) {
        return new Response(JSON.stringify({
          success: true, data: { usagePercent: 0, refreshCountdownSeconds: 86400 },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        success: true, data: { total: 200, remaining: 200, entitlement: {} },
      }), { status: 200 })
    })
    const r = await fetchAccioBalanceDetailed(cred, { fetcher: fetcher as unknown as typeof fetch })
    expect(r.balance).not.toBeNull()

    // ⚠️ 必须同时钉住 method 与 token 位置：只断言 balance 非空是**空转**的
    //    （把 GET 改成 POST、token 挪进 body，旧断言照样全绿）。
    const call = fetcher.mock.calls.find(([u]) => String(u).includes('/quota'))
    expect(call, '没有向 /quota 发请求').toBeDefined()
    const [url, init] = call as unknown as [string, RequestInit]
    expect(init.method).toBe('GET')
    expect(url).toContain('accessToken=tok')
    expect(init.body).toBeUndefined()
  })
})

describe('flattenAccioCredits —— 三类桶', () => {
  it('daily / monthly / referral 各产出一条（值为 0 的桶也保留：用户要看到"还有 0"）', () => {
    const rows = flattenAccioCredits({
      entitlement: {
        daily: { plan: 'daily', total: 200, used: 0, remaining: 200 },
        monthly: { plan: 'monthly', total: 0, used: 0, remaining: 0 },
        referral: { plan: 'referral', total: 0, used: 0, remaining: 0 },
      },
    })
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ label: '每日积分', total: 200, used: 0, remaining: 200 })
  })

  it('缺桶时不产出（不是 0）', () => {
    expect(flattenAccioCredits({ entitlement: { daily: { total: 200, used: 0, remaining: 200 } } }))
      .toHaveLength(1)
    expect(flattenAccioCredits({})).toEqual([])
  })
})

describe('⚠️ 失败语义', () => {
  it('查不到时 balance 必须是 null（不得编造 0 —— 那会让用户以为额度被清空）', async () => {
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 }))
    const r = await fetchAccioBalanceDetailed(cred, { fetcher: fetcher as unknown as typeof fetch })
    expect(r.balance).toBeNull()
    expect(r.error).toBeTruthy()
  })

  it('401 要能区分「未登录」与「查询失败」', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false, code: '401', message: 'NOT_LOGIN',
    }), { status: 200 }))
    const r = await fetchAccioBalanceDetailed(cred, { fetcher: fetcher as unknown as typeof fetch })
    expect(r.balance).toBeNull()
    expect(String(r.error)).toMatch(/未登录|NOT_LOGIN|重新登录/)
  })

  it('⚠️ code 下发成数字 401 时也必须判为「未登录」（不能退化成「查询失败」）', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false, code: 401, message: 'NOT_LOGIN',
    }), { status: 200 }))
    const r = await fetchAccioBalanceDetailed(cred, { fetcher: fetcher as unknown as typeof fetch })
    expect(r.balance).toBeNull()
    expect(String(r.error)).toMatch(/未登录|NOT_LOGIN|重新登录/)
  })

  it('⚠️ 数字 401 且没有 NOT_LOGIN 文案时，也必须判为「未登录」', async () => {
    // ⚠️⚠️ 这一条是 `code` 判据的**唯一守卫**：上一条的 `message:'NOT_LOGIN'` 会被
    //     `message` 判据兜住 —— 即使 `code` 只认字符串（数字 401 被读成空串）它照样全绿，
    //     是**空转**的。这里刻意不带任何 NOT_LOGIN 文案，于是「数字 401」只能靠
    //     `code` 按标量归一来命中。反向验证：把 `code` 退回 `readString` ⇒ 本条必红。
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false, code: 401, message: '登录态已失效',
    }), { status: 200 }))
    const r = await fetchAccioBalanceDetailed(cred, { fetcher: fetcher as unknown as typeof fetch })
    expect(r.balance).toBeNull()
    expect(String(r.error)).toMatch(/未登录|重新登录/)
    // 服务端原文仍要保留
    expect(String(r.error)).toContain('登录态已失效')
  })

  it('⚠️ 数字 401 且 message 用 error 字段下发时，两个判据都要成立', async () => {
    // 官方失败信封有**两种**形态：`{code, message}` 与 `{error}`。这一条同时压
    // 「code 按标量归一」与「摘要回退读 error」两条 —— 少任何一条都会红。
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false, code: 401, error: 'Not authenticated',
    }), { status: 200 }))
    const r = await fetchAccioBalanceDetailed(cred, { fetcher: fetcher as unknown as typeof fetch })
    expect(r.balance).toBeNull()
    expect(String(r.error)).toMatch(/未登录|NOT_LOGIN|重新登录/)
    // 「保留服务端原文」的承诺：`error` 字段的内容必须出现在摘要里
    // （只读 `message` 时会退化成光秃秃的 `HTTP 200`）。
    expect(String(r.error)).toContain('Not authenticated')
  })

  it('⚠️ 形状不认识时立即短路：不得白发 quota / userinfo 两个注定失败的请求', async () => {
    // 文件头承诺「形状不认识就短路」。这两个可容忍端点都不产出任何余额字段，
    // 排在短路之后就是纯粹的白发请求（判据本身不依赖它们的结果）。
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true, data: { unexpected: true },
    }), { status: 200 }))
    const r = await fetchAccioBalanceDetailed(cred, { fetcher: fetcher as unknown as typeof fetch })
    expect(r.balance).toBeNull()
    expect(String(r.error)).toContain('未包含余额字段')
    expect(fetcher.mock.calls).toHaveLength(1)
  })
})
