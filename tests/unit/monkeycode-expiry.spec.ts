/**
 * `monkeycodeExpiry` / `baizhiExpiry`（2026-11-02 审查 B🟡-9 新增的折算原语）。
 *
 * ## 这两家与其它家最不同的一点：**余额读数依赖第二凭据**
 *
 * - 发消息只要主凭据：monkeycode 是 `oma_` + `signing_secret`、baizhi 是 `sk-`；
 * - 读额度要**会话 cookie**：monkeycode `/api/v1/users/wallet`、
 *   baizhi 控制台 `/api/v1/user/wallet/balance`。
 *
 * ⇒ 手填 Key、没做过浏览器登录的账号**读不到额度但完全能用**。
 * 若把「读不到」折算成 `UNUSABLE`，它们会被**静默踢出聚合轮换**
 *（候选列表里看不到它，零报错零日志）—— 那是把「不知道」当「不可用」。
 *
 * 本文件守四件事：
 * 1. 缺会话 ⇒ `NEVER` 且**零网络请求**（不浪费一次注定 401 的调用）；
 * 2. 有会话 + 有余额 ⇒ `NEVER`（可用、无临期额度，排最后不剔除）；
 * 3. 有会话 + 余额全为 0/负 ⇒ `UNUSABLE`（现在烧不了，剔除）；
 * 4. 上游读失败 ⇒ `UNUSABLE`（「不能把『不知道』当『可用』」，与既有裁决一致）。
 *
 * ⚠️ `AbortError` 必须原样逃逸（由 `sharedPackageExpiry` 统一处理，本文件不重复测）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { NEVER, UNUSABLE } from '../../src/aggregate-core.js'
import { baizhiExpiry, monkeycodeExpiry } from '../../src/aggregate-expiry.js'
import { BAIZHI } from '../../src/baizhi-product.js'
import { MONKEYCODE, MONKEYCODE_INTL } from '../../src/monkeycode-product.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** 记下每一次 fetch，同时按 URL 派发响应。 */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response): string[] {
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
    seen.push(url)
    return handler(url, init)
  }) as typeof fetch
  return seen
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/* ------------------------------------------------------------------ *
 * MonkeyCode
 * ------------------------------------------------------------------ */

describe('★ monkeycodeExpiry：缺会话绝不判死（手填 Key 的账号照常能推理）', () => {
  it('★★ 没有 session_cookie ⇒ NEVER，且一次网络请求都不发', async () => {
    const seen = stubFetch(() => {
      throw new Error('缺会话时不该发任何请求')
    })
    const expiry = await monkeycodeExpiry(
      { access_token: 'oma_abc', signing_secret: 's' },
      MONKEYCODE,
    )
    expect(expiry).toBe(NEVER)
    expect(seen, '缺会话直接 NEVER，不该打 401 ⇒ 零请求').toEqual([])
  })

  it('★ 空串 / 纯空白同样视为缺会话', async () => {
    const seen = stubFetch(() => {
      throw new Error('缺会话时不该发任何请求')
    })
    expect(await monkeycodeExpiry({ access_token: 'oma_abc', session_cookie: '' }, MONKEYCODE))
      .toBe(NEVER)
    expect(await monkeycodeExpiry({ access_token: 'oma_abc', session_cookie: '   ' }, MONKEYCODE))
      .toBe(NEVER)
    expect(seen).toEqual([])
  })
})

describe('★ monkeycodeExpiry：有会话时按「还有没有可烧的额度」如实折算', () => {
  it('★★ 每日额度 > 0 ⇒ NEVER（可用，无临期额度）', async () => {
    stubFetch((url) => {
      if (url.includes('/api/v1/users/wallet')) {
        return json({
          code: 0,
          message: 'success',
          data: { id: 'u', balance: -8191, daily_token_balance: 9_000_000, daily_token_limit: 10_000_000 },
        })
      }
      if (url.includes('/api/v1/users/subscription')) {
        return json({ code: 0, message: 'success', data: { plan: 'basic' } })
      }
      throw new Error(`未预期的地址：${url}`)
    })
    expect(await monkeycodeExpiry({ access_token: 'oma_abc', session_cookie: 'monkeycode_ai_session=x' }, MONKEYCODE))
      .toBe(NEVER)
  })

  it('★★ 额度为 0 且积分为负 ⇒ UNUSABLE（现在真的烧不了）', async () => {
    stubFetch((url) => {
      if (url.includes('/api/v1/users/wallet')) {
        return json({
          code: 0,
          message: 'success',
          data: { id: 'u', balance: -8191, daily_token_balance: 0, daily_token_limit: 10_000_000 },
        })
      }
      return json({ code: 0, message: 'success', data: { plan: 'basic' } })
    })
    expect(await monkeycodeExpiry({ access_token: 'oma_abc', session_cookie: 'monkeycode_ai_session=x' }, MONKEYCODE))
      .toBe(UNUSABLE)
  })

  it('★ 国际站实例打的是国际站域名（传错 product 会让它恒 UNUSABLE）', async () => {
    const seen = stubFetch((url) => {
      if (url.includes('/api/v1/users/wallet')) {
        return json({
          code: 0,
          message: 'success',
          data: { id: 'u', balance: 100_000, daily_token_balance: 10_000_000, daily_token_limit: 10_000_000 },
        })
      }
      return json({ code: 0, message: 'success', data: { plan: 'basic' } })
    })
    await monkeycodeExpiry({ access_token: 'oma_abc', session_cookie: 'monkeycode_ai_session=x' }, MONKEYCODE_INTL)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.some((url) => url.includes('monkeycode-ai.net')), `实际请求：${seen.join(', ')}`).toBe(true)
    expect(seen.some((url) => url.includes('monkeycode-ai.com')), '不得打国内站').toBe(false)
  })

  it('★ 会话过期（401）⇒ UNUSABLE，不能当可用', async () => {
    stubFetch(() => json({ code: 401, message: '未授权' }, 401))
    expect(await monkeycodeExpiry({ access_token: 'oma_abc', session_cookie: 'monkeycode_ai_session=x' }, MONKEYCODE))
      .toBe(UNUSABLE)
  })
})

/* ------------------------------------------------------------------ *
 * 百智云
 * ------------------------------------------------------------------ */

describe('★ baizhiExpiry：缺会话绝不判死（只填 sk- 的账号照常能推理）', () => {
  it('★★ 没有 session_cookie ⇒ NEVER，且零请求', async () => {
    const seen = stubFetch(() => {
      throw new Error('缺会话时不该发任何请求')
    })
    expect(await baizhiExpiry({ access_token: 'sk-abc' }, BAIZHI)).toBe(NEVER)
    expect(seen).toEqual([])
  })
})

describe('★ baizhiExpiry：有会话时按可用积分如实折算', () => {
  it('★★ 可用积分 > 0 ⇒ NEVER（实测报文：235.05 积分）', async () => {
    stubFetch((url) => {
      if (url.includes('/api/v1/user/wallet/balance')) {
        return json({
          code: 0,
          data: {
            balance: 23505,
            temporary_credit_cents: 9821,
            permanent_credit_cents: 13684,
            frozen_credit_cents: 0,
            available_credit_cents: 23505,
            daily_temporary_credit_claimed: true,
          },
        })
      }
      if (url.includes('/api/v1/user/wallet/app-credit-usage')) {
        return json({
          code: 0,
          data: { items: [{ period: '2026-11-02', app_id: 22, call_count: 31, credit: 364.95, credit_ratio: 1 }] },
        })
      }
      if (url.includes('/api/v1/user/profile')) {
        return json({ code: 0, data: { id: 1, name: 'tester' } })
      }
      throw new Error(`未预期的地址：${url}`)
    })
    expect(await baizhiExpiry({ access_token: 'sk-abc', session_cookie: 'sl-session=a; baizhi_session=b' }, BAIZHI))
      .toBe(NEVER)
  })

  it('★★ 积分全部烧光（0）⇒ UNUSABLE', async () => {
    stubFetch((url) => {
      if (url.includes('/api/v1/user/wallet/balance')) {
        return json({
          code: 0,
          data: {
            balance: 0,
            temporary_credit_cents: 0,
            permanent_credit_cents: 0,
            frozen_credit_cents: 0,
            available_credit_cents: 0,
            daily_temporary_credit_claimed: true,
          },
        })
      }
      return json({ code: 0, data: { items: [] } })
    })
    expect(await baizhiExpiry({ access_token: 'sk-abc', session_cookie: 'sl-session=a; baizhi_session=b' }, BAIZHI))
      .toBe(UNUSABLE)
  })

  it('★ 控制台登录态失效（401）⇒ UNUSABLE', async () => {
    stubFetch(() => json({ code: 401, message: '未授权' }, 401))
    expect(await baizhiExpiry({ access_token: 'sk-abc', session_cookie: 'sl-session=a; baizhi_session=b' }, BAIZHI))
      .toBe(UNUSABLE)
  })
})

/* ------------------------------------------------------------------ *
 * 共享读数
 * ------------------------------------------------------------------ */

describe('★ 两家都必须吃共享读数（聚合每轮会反复问同一账号）', () => {
  it('★★ 传入 cached 且命中 ⇒ 不发任何网络请求', async () => {
    const seen = stubFetch(() => {
      throw new Error('cached 命中后不该发请求')
    })
    const cached = async () => ({
      currency: 'CNY',
      packages: [{ id: 'p', name: '积分', unit: 'credit', total: 10, remaining: 10, active: true }],
      total: 10,
    }) as never
    expect(await monkeycodeExpiry(
      { access_token: 'oma_abc', session_cookie: 'monkeycode_ai_session=x' },
      MONKEYCODE,
      cached,
    )).toBe(NEVER)
    expect(await baizhiExpiry(
      { access_token: 'sk-abc', session_cookie: 'sl-session=a; baizhi_session=b' },
      BAIZHI,
      cached,
    )).toBe(NEVER)
    expect(seen).toEqual([])
  })
})
