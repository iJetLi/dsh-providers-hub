/**
 * ★ Marvis 钱包解析：字符串数字 / 单包 / 到期未知 / 失败不回落 0。
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchMarvisBalanceDetailed, readMarvisAmount } from '../../src/marvis-credits.js'
import type { MarvisCredential } from '../../src/marvis.js'

const CREDENTIAL: MarvisCredential = {
  access_token: 'mv-test-access-token',
  refresh_token: 'test-refresh-token-0001',
  openid: '0123456789abcdef0123456789abcdef',
  guid: 'fedcba9876543210fedcba9876543210',
  login_type: '1',
}

function fake(body: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

describe('★ readMarvisAmount：字符串数字必须能读', () => {
  it('★ "10000000" ⇒ 10000000（实测上游就是字符串）', () => {
    expect(readMarvisAmount('10000000')).toBe(10_000_000)
    expect(readMarvisAmount('  42 ')).toBe(42)
    expect(readMarvisAmount(42)).toBe(42)
  })

  it('★ 非数字/负数/空串 ⇒ undefined（绝不回落 0）', () => {
    expect(readMarvisAmount('abc')).toBeUndefined()
    expect(readMarvisAmount('')).toBeUndefined()
    expect(readMarvisAmount(-1)).toBeUndefined()
    expect(readMarvisAmount(Number.NaN)).toBeUndefined()
    expect(readMarvisAmount(null)).toBeUndefined()
    expect(readMarvisAmount(undefined)).toBeUndefined()
  })
})

describe('★ 钱包响应解析', () => {
  it('★ 真机报文 ⇒ 单包「令牌用量」，可用/总额/已用正确，且到期未知', async () => {
    const { balance, error } = await fetchMarvisBalanceDetailed(CREDENTIAL, undefined, {
      fetchImpl: fake(JSON.stringify({
        code: 0,
        msg: '',
        data: {
          openid: '0123456789abcdef0123456789abcdef',
          total_tokens: '10000000',
          used_tokens: '100',
          frozen_tokens: '0',
          avail_tokens: '9999900',
          total_cost: 0,
          status: 1,
        },
      })),
    })
    expect(error).toBeUndefined()
    // ⚠️ 徽标读的是 `balance.total`，语义是「还剩多少」⇒ 必须是**可用**而不是上限
    //    （初版写上限 ⇒ 徽标永远 10,000,000，用掉额度也纹丝不动）。
    expect(balance?.total).toBe(9_999_900)
    expect(balance?.expiredTotal).toBe(0)
    expect(balance?.packages).toHaveLength(1)
    expect(balance?.packages[0]).toMatchObject({
      name: '令牌用量',
      unit: 'token',
      remaining: 9_999_900,
      total: 10_000_000,
      used: 100,
      active: true,
      // 上游没有任何日期字段 ⇒ 必须标「到期未知」，而不是「永久」。
      expiryUnknown: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
    })
  })

  /**
   * ⚠️ 2026-11-10 对抗性审计 I4：上游可能把业务码序列化成**字符串 `"0"`**。
   * 判 `parsed.code !== 0` 会把它当失败 ⇒ 积分行报「业务码 0」（自相矛盾），
   * 而同一个 0 在 `classifyMarvisError` 的 `businessCodeOf` 里是成功的。
   */
  it('★★ 业务码是字符串 "0" ⇒ 仍然成功（不是「业务码 0」失败）', async () => {
    const { balance, error } = await fetchMarvisBalanceDetailed(CREDENTIAL, undefined, {
      fetchImpl: fake(JSON.stringify({
        code: '0',
        data: { total_tokens: '100', used_tokens: '0', avail_tokens: '100', status: 1 },
      })),
    })
    expect(error).toBeUndefined()
    expect(balance?.packages[0]?.remaining).toBe(100)
  })

  /** ⚠️ 审计 I5：`status` 也见过字符串形态；`=== 1` 会让账号被判死、从轮换里消失。 */
  it('★★ status 是字符串 "1" ⇒ active:true（否则账号静默退出轮换）', async () => {
    const { balance } = await fetchMarvisBalanceDetailed(CREDENTIAL, undefined, {
      fetchImpl: fake(JSON.stringify({
        code: 0,
        data: { total_tokens: '100', used_tokens: '0', avail_tokens: '100', status: '1' },
      })),
    })
    expect(balance?.packages[0]?.active).toBe(true)
  })

  it('★ status !== 1 ⇒ active:false（账号被限制）', async () => {
    const { balance } = await fetchMarvisBalanceDetailed(CREDENTIAL, undefined, {
      fetchImpl: fake(JSON.stringify({
        code: 0,
        data: { total_tokens: '100', used_tokens: '0', avail_tokens: '100', status: 0 },
      })),
    })
    expect(balance?.packages[0]?.active).toBe(false)
  })

  it('★★ 冻结额走 `usage` 展示行，**不**成为第 2 个包（否则双计 + 烧光也判不死）', async () => {
    const { balance } = await fetchMarvisBalanceDetailed(CREDENTIAL, undefined, {
      fetchImpl: fake(JSON.stringify({
        code: 0,
        data: {
          total_tokens: '1000',
          used_tokens: '100',
          frozen_tokens: '50',
          avail_tokens: '850',
          status: 1,
        },
      })),
    })
    // ⚠️⚠️ 2026-11-09 评审 I3：**只有一个包**。冻结额若也做成包，两件事同时坏：
    //    ① `splitCreditsByExpiry` 对每个 `remaining > 0` 的包求和 ⇒ 卡片显示
    //       「到期未知 900」（多报 50 的可用额度）；
    //    ② `avail=0, frozen=50` 时仍有一个正 remaining 的包 ⇒ 折算层判 `NEVER`
    //       而不是 `UNUSABLE` ⇒ 继续往这个已经没额度的账号上派单，每次必失败。
    expect(balance?.packages).toHaveLength(1)
    expect(balance?.packages[0]?.remaining).toBe(850)
    expect(balance?.packages[0]?.total).toBe(1000)
    // 冻结仍要让用户看见，但它只是**展示行**（不参与任何求和）。
    expect(balance?.usage).toEqual({ label: '冻结中', amount: 50, unit: 'token' })
  })

  it('★★ 可用为 0 且只有冻结额 ⇒ 必须判「不可用」（不是「额度未知」）', async () => {
    const { balance } = await fetchMarvisBalanceDetailed(CREDENTIAL, undefined, {
      fetchImpl: fake(JSON.stringify({
        code: 0,
        data: { total_tokens: '50', used_tokens: '50', frozen_tokens: '50', avail_tokens: '0', status: 1 },
      })),
    })
    expect(balance).not.toBeNull()
    // 唯一的包 remaining === 0 ⇒ 没有任何可用额度（`splitCreditsByExpiry` 会
    // 判 `expiredTotal`，折算层据此给 `UNUSABLE`）。
    expect(balance!.packages.every((entry) => entry.remaining === 0)).toBe(true)
    expect(balance!.usage?.amount).toBe(50)
  })

  it('★★ 401 ⇒ balance:null 且 error 指向「重新登录」（绝不回 0）', async () => {
    const { balance, error } = await fetchMarvisBalanceDetailed(CREDENTIAL, undefined, {
      fetchImpl: fake('', 401),
    })
    expect(balance).toBeNull()
    expect(error).toContain('重新登录')
  })

  it('★★ 业务码非 0 ⇒ balance:null，error 带业务码（不是「余额 0」）', async () => {
    const { balance, error } = await fetchMarvisBalanceDetailed(CREDENTIAL, undefined, {
      fetchImpl: fake(JSON.stringify({ code: 4100403, msg: '客户端通用错误:登录态过期/未登录' })),
    })
    expect(balance).toBeNull()
    expect(error).toContain('4100403')
    expect(error).toContain('登录态过期')
  })

  it('★★ 缺 total_tokens ⇒ balance:null（上游改版，不是额度用光）', async () => {
    const { balance, error } = await fetchMarvisBalanceDetailed(CREDENTIAL, undefined, {
      fetchImpl: fake(JSON.stringify({ code: 0, data: { used_tokens: '0', avail_tokens: '0' } })),
    })
    expect(balance).toBeNull()
    expect(error).toContain('total_tokens')
  })

  it('★ 请求形状：POST + body "{}" + UAL 签名头', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ code: 0, data: { total_tokens: '1', used_tokens: '0', avail_tokens: '1', status: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    await fetchMarvisBalanceDetailed(CREDENTIAL, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://yybadaccess.3g.qq.com/v3/marvis_get_wallet')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
    const headers = init.headers as Record<string, string>
    expect(headers['Ual-Access-Businessid']).toBe('marvis_client')
    expect(headers['Ual-Access-Signature']).toMatch(/^[0-9a-f]{32}$/)
    expect(headers['Ual-Access-Openid']).toBe(CREDENTIAL.openid)
  })

  it('★ 没有凭据 ⇒ 直接失败，不打请求', async () => {
    const fetchImpl = vi.fn()
    const { balance, error } = await fetchMarvisBalanceDetailed(
      { ...CREDENTIAL, access_token: '' },
      undefined,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(balance).toBeNull()
    expect(error).toContain('凭据')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
