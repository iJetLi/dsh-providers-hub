import { describe, expect, it } from 'vitest'
import { RACCOON } from '../../src/raccoon-product.js'
import { RACCOON_OFFICE_PREFIX, RACCOON_POINTS_V2_PREFIX } from '../../src/raccoon.js'
import {
  claimRaccoonDailyCheckin,
  claimRaccoonLoginReward,
  fetchRaccoonCreditBalance,
  fetchRaccoonOnboardingStatus,
  fetchRaccoonTodayDailyGrants,
  raccoonUtc8Date,
  triggerRaccoonDailyGrant,
} from '../../src/raccoon-credits.js'
import type { RaccoonCredential } from '../../src/raccoon.js'

const CRED: RaccoonCredential = { access_token: 't', refresh_token: 'r' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function balanceBody(available: number, daily = 0): Record<string, unknown> {
  return {
    code: 0,
    data: { available_points: available, daily_points: daily, reward_points: 0, topup_points: 0, monthly_points: 0 },
  }
}

/** 按 URL 路由的 fetch 替身：把请求记进 `seen`，便于断言路径与顺序。 */
function routedFetch(routes: Array<{ match: string; reply: (url: string) => Response }>) {
  const seen: string[] = []
  const fetcher = async (url: string): Promise<Response> => {
    seen.push(String(url))
    for (const route of routes) {
      if (String(url).includes(route.match)) return route.reply(String(url))
    }
    throw new Error(`未预期的请求：${url}`)
  }
  return { seen, fetcher: fetcher as unknown as typeof fetch }
}

describe('fetchRaccoonCreditBalance', () => {
  it('把 available_points 映射成 total，各池作 package', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        available_points: 6300,
        daily_points: 300,
        monthly_points: 0,
        reward_points: 6000,
        topup_points: 0,
      },
    })
    const balance = await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)
    expect(balance).not.toBeNull()
    expect(balance?.total).toBe(6300)
    const names = balance?.packages.map((p) => p.name)
    expect(names).toContain('奖励积分')
    expect(names).toContain('每日积分')
    expect(names).toContain('充值积分')
  })

  it('请求路径与鉴权头正确', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      seenUrl = String(url)
      seenAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
      return jsonResponse({ code: 0, data: { available_points: 1 } })
    }
    await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(seenUrl).toBe(`${RACCOON.apiBase}${RACCOON.pointsApiPrefix}/balance`)
    expect(seenAuth).toBe('Bearer t')
  })

  it('code 非 0 时返回 null（显示原因，不是 0）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 200003, message: 'auth fail' }, 401)
    expect(await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)).toBeNull()
  })

  it('缺 available_points 时返回 null（不编造数字）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 0, data: {} })
    expect(await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)).toBeNull()
  })

  it('网络异常时返回 null（不抛错，避免批量查询被单个账号中断）', async () => {
    const fetcher = async (): Promise<Response> => { throw new Error('down') }
    expect(await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)).toBeNull()
  })
})

describe('claimRaccoonLoginReward', () => {
  it('granted:true 时返回 claimed 与积分数', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { granted: true, popup: { source: 'desktop_login', points: 3000 } },
    })
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') {
      expect(outcome.credit).toBe(3000)
    }
  })

  it('granted:false 时返回 already-claimed（幂等，不是失败）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { granted: false, popup: null },
    })
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('already-claimed')
  })

  it('必须带 X-Client-Platform（缺了会被服务端拒）', async () => {
    let seenPlatform = ''
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
      seenPlatform = String((init?.headers as Record<string, string> | undefined)?.['X-Client-Platform'] ?? '')
      return jsonResponse({ code: 0, data: { granted: false } })
    }
    await claimRaccoonLoginReward(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(seenPlatform).toBe(RACCOON.clientPlatform)
    expect(seenPlatform).toMatch(/^desktop-(windows|macos|linux)$/)
  })

  it('请求路径与方法是 POST', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      seenUrl = String(url)
      seenMethod = String(init?.method ?? '')
      return jsonResponse({ code: 0, data: { granted: false } })
    }
    await claimRaccoonLoginReward(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(seenUrl).toBe(`${RACCOON.apiBase}${RACCOON.desktopApiPrefix}/login/points/grant`)
    expect(seenMethod).toBe('POST')
  })

  it('失败时返回 failed 且带原因（不抛错，保证批量领取不中断）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 100006, message: 'boom' }, 400)
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.message.length).toBeGreaterThan(0)
    }
  })

  it('网络异常时返回 failed', async () => {
    const fetcher = async (): Promise<Response> => { throw new Error('down') }
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('failed')
  })

  it('granted:true 但 popup 缺 points 时用 3000 兜底', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { granted: true },
    })
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') {
      expect(outcome.credit).toBe(3000)
    }
  })
})

describe('fetchRaccoonOnboardingStatus', () => {
  it('账单里已有「桌面端登录奖励」时判为已领', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        items: [
          { event_name: '桌面端登录奖励', biz_type: 'reward_grant', points: 3000 },
          { event_name: '每日积分发放', biz_type: 'daily_grant', points: 300 },
        ],
        paging: { offset: 0, limit: 20, total: 0 },
      },
    })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(true)
    expect(status.points).toBe(3000)
  })

  it('账单里没有该记录时判为未领', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        items: [{ event_name: '每日积分发放', biz_type: 'daily_grant', points: 300 }],
        paging: { offset: 0, limit: 20, total: 0 },
      },
    })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })

  it('「新人注册礼包」不算作登录奖励（两者是不同来源）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        items: [{ event_name: '新人注册礼包', biz_type: 'reward_grant', points: 3000 }],
      },
    })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })

  it('查询失败时保守判为未领（宁可让用户多点一次）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 1, message: 'err' }, 500)
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
    expect(status.points).toBe(3000)
  })

  it('网络异常时保守判为未领', async () => {
    const fetcher = async (): Promise<Response> => { throw new Error('down') }
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })

  it('items 非数组时不抛错', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 0, data: { items: 'bad' } })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 账单走 v2 + type=income（2026-11-15 真实账号实测的修正）
// ─────────────────────────────────────────────────────────────────────────────

describe('★ 账单必须走 v2 + type=income（v1 前 50 条会被消耗记录挤满）', () => {
  /**
   * 实测依据（2026-11-15，3 个真实账号）：
   *
   * ```
   * GET /points/v1/bills?paging.limit=50&paging.offset=0
   *   → 50 条，biz_type ∈ {daily_grant, desktop}，reward_grant **0 条**
   * GET /points/v2/bills?paging.limit=100&type=income
   *   → 21 条，reward_grant 4 条（桌面端/移动端登录奖励各一条 3000 + 注册礼包）
   * ```
   *
   * ⇒ 用 v1 判「登录奖励是否已领」，明明领过的账号也会被判成「未领取」。
   * 本组钉住两件事：**路径必须是 v2**、**必须带 `type=income`**。
   */
  it('登录奖励状态读的是 v2 + type=income（两个条件缺一都会退化成「未领取」）', async () => {
    let seenUrl = ''
    const fetcher = async (url: string): Promise<Response> => {
      seenUrl = String(url)
      return jsonResponse({ code: 0, data: { items: [] } })
    }
    await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(seenUrl).toContain(RACCOON_POINTS_V2_PREFIX)
    expect(seenUrl, '必须带 type=income，否则前 100 条里混着消耗记录').toContain('type=income')
    expect(seenUrl, '不得回落到 v1 的 /points/v1/bills').not.toContain('/points/v1/bills')
  })

  it('★ v1 风格的响应（全是 daily_grant/desktop）不会把已领判成已领 —— 反向自证判据真的读账单', async () => {
    // 即使响应里「没有 reward_grant」，也必须判未领（说明判据确实看内容，不是恒真）。
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        items: Array.from({ length: 50 }, () => ({
          biz_type: 'desktop', event_name: '对话消耗', points: -12,
        })),
      },
    })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 每日签到（办公端 setting_info 结算触发器）
// ─────────────────────────────────────────────────────────────────────────────

describe('raccoonUtc8Date', () => {
  it('用 UTC+8 切日，不看本机时区', () => {
    // 2026-11-15T16:14Z = 2026-11-16 00:14 UTC+8
    expect(raccoonUtc8Date(Date.parse('2026-11-15T16:14:00Z'))).toBe('2026-11-16')
    // 2026-11-15T15:59Z = 2026-11-15 23:59 UTC+8
    expect(raccoonUtc8Date(Date.parse('2026-11-15T15:59:00Z'))).toBe('2026-11-15')
  })
})

describe('triggerRaccoonDailyGrant', () => {
  it('打办公端的 setting_info（GET），并解析 popups', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      seenUrl = String(url)
      seenMethod = String(init?.method ?? '')
      return jsonResponse({
        code: 0,
        data: {
          used_space_mb: 0,
          point_grant_toast: '',
          point_grant_popups: [{
            source: 'daily',
            display_name: '每日积分发放',
            points: 300,
            expire_at: '2026-11-22T23:59:59+08:00',
          }],
        },
      })
    }
    const result = await triggerRaccoonDailyGrant(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(seenUrl).toBe(`${RACCOON.apiBase}${RACCOON_OFFICE_PREFIX}/setting_info`)
    expect(seenMethod, '⚠️ 触发器是只读 GET，不是 POST').toBe('GET')
    expect(result.ok).toBe(true)
    expect(result.popups).toHaveLength(1)
    expect(result.popups[0]?.points).toBe(300)
  })

  it('已结算过时 popups 为空，但仍算触发成功（不是失败）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0, data: { point_grant_toast: '', point_grant_popups: [] },
    })
    const result = await triggerRaccoonDailyGrant(RACCOON, CRED, fetcher)
    expect(result.ok).toBe(true)
    expect(result.popups).toEqual([])
  })

  it('上游拒绝时 ok:false 且带原因（不抛错）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse(
      { code: 200003, message: 'authorization_verify_error' }, 401,
    )
    const result = await triggerRaccoonDailyGrant(RACCOON, CRED, fetcher)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('authorization_verify_error')
  })

  it('popups 形状异常时不抛错（脏数据不得带走整个签到）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0, data: { point_grant_popups: [null, 'x', 3, { display_name: 42 }] },
    })
    const result = await triggerRaccoonDailyGrant(RACCOON, CRED, fetcher)
    expect(result.ok).toBe(true)
    expect(result.popups.every((p) => typeof p.displayName === 'string')).toBe(true)
  })
})

describe('fetchRaccoonTodayDailyGrants', () => {
  it('只统计今天的 daily_grant（biz_type 判据，不看 event_name 文案）', async () => {
    const today = raccoonUtc8Date()
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        items: [
          { biz_type: 'daily_grant', event_name: '上游改了文案也无所谓', points: 300, created_at: `${today}T00:14:00+08:00` },
          { biz_type: 'daily_grant', event_name: '每日积分发放', points: 300, created_at: '2026-01-01T00:00:00+08:00' },
          { biz_type: 'reward_grant', event_name: '桌面端登录奖励', points: 3000, created_at: `${today}T00:14:00+08:00` },
          { biz_type: 'daily_grant', event_name: '退积分', points: -300, created_at: `${today}T00:15:00+08:00` },
        ],
      },
    })
    const result = await fetchRaccoonTodayDailyGrants(RACCOON, CRED, fetcher, Date.now())
    expect(result).not.toBeNull()
    expect(result?.total).toBe(300)
    expect(result?.entries).toHaveLength(1)
  })

  it('账单查不到时返回 null（不编造 0）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 1, message: 'x' }, 500)
    expect(await fetchRaccoonTodayDailyGrants(RACCOON, CRED, fetcher)).toBeNull()
  })
})

describe('★ claimRaccoonDailyCheckin（每日签到）', () => {
  /**
   * 真实场景（2026-11-16 00:14 UTC+8，3 个真实账号实测）：
   * 余额(before) 7676 → GET setting_info（popups 300）→ 余额(after) 7976。
   * 判据必须是**余额差**，不是「触发请求 200」—— 后者只证明请求到了。
   */
  it('★ 余额 +300 ⇒ claimed，金额取自余额差（真实报文形状）', async () => {
    let call = 0
    const { fetcher, seen } = routedFetch([
      {
        match: '/points/v1/balance',
        reply: () => {
          call += 1
          return jsonResponse(balanceBody(call === 1 ? 7676 : 7976, call === 1 ? 1730 : 2030))
        },
      },
      {
        match: `/office/v3/setting_info`,
        reply: () => jsonResponse({
          code: 0,
          data: {
            point_grant_toast: '',
            point_grant_popups: [{
              source: 'daily', display_name: '每日积分发放', points: 300,
              expire_at: '2026-11-22T23:59:59+08:00',
            }],
          },
        }),
      },
      { match: '/points/v2/bills', reply: () => jsonResponse({ code: 0, data: { items: [] } }) },
    ])
    const outcome = await claimRaccoonDailyCheckin(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') {
      expect(outcome.credit).toBe(300)
    }
    expect(outcome.coversToday, '本渠道的结果就是按今天的余额差算的').toBe(true)
    // 顺序：先读余额，再触发，再读余额（账单位于其后，仅作兜底）
    expect(seen[0]).toContain('/points/v1/balance')
    expect(seen[1]).toContain('/office/v3/setting_info')
    expect(seen[2]).toContain('/points/v1/balance')
  })

  it('★ 差额为 0 但今天账单已有 daily_grant ⇒ already-claimed（不是 claimed）', async () => {
    const today = raccoonUtc8Date()
    const { fetcher } = routedFetch([
      { match: '/points/v1/balance', reply: () => jsonResponse(balanceBody(7976, 2030)) },
      {
        match: '/office/v3/setting_info',
        reply: () => jsonResponse({ code: 0, data: { point_grant_toast: '', point_grant_popups: [] } }),
      },
      {
        match: '/points/v2/bills',
        reply: () => jsonResponse({
          code: 0,
          data: {
            items: [{ biz_type: 'daily_grant', event_name: '每日积分发放', points: 300, created_at: `${today}T00:14:00+08:00` }],
          },
        }),
      },
    ])
    const outcome = await claimRaccoonDailyCheckin(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('already-claimed')
    // ⚠️ 这个字段是自动签到「当天是否已证明」的唯一输入（对抗审计 M18 指出原先零断言）。
    // 账单里**真的**有今天的 daily_grant ⇒ 就是有证据 ⇒ 必须 true（不能让 21:00 白重试）。
    expect(outcome.coversToday, '账单里今天有 daily_grant 就是证据').toBe(true)
    if (outcome.kind === 'already-claimed') {
      expect(outcome.message).toContain('300')
    }
  })

  it('★ 触发失败 ⇒ failed（不得虚报成功）', async () => {
    const { fetcher } = routedFetch([
      { match: '/points/v1/balance', reply: () => jsonResponse(balanceBody(7676)) },
      {
        match: '/office/v3/setting_info',
        reply: () => jsonResponse({ code: 200003, message: 'authorization_verify_error' }, 401),
      },
    ])
    const outcome = await claimRaccoonDailyCheckin(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('failed')
  })

  it('余额读不到 ⇒ 退到账单判据（不因余额端点抖动就报失败）', async () => {
    const today = raccoonUtc8Date()
    const { fetcher } = routedFetch([
      { match: '/points/v1/balance', reply: () => jsonResponse({ code: 1, message: 'x' }, 500) },
      {
        match: '/office/v3/setting_info',
        reply: () => jsonResponse({ code: 0, data: { point_grant_popups: [] } }),
      },
      {
        match: '/points/v2/bills',
        reply: () => jsonResponse({
          code: 0,
          data: {
            items: [{ biz_type: 'daily_grant', event_name: '每日积分发放', points: 300, created_at: `${today}T00:14:00+08:00` }],
          },
        }),
      },
    ])
    const outcome = await claimRaccoonDailyCheckin(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('already-claimed')
  })

  it('余额读不到 + 账单也没有 ⇒ already-claimed 带可读原因（不编金额）', async () => {
    const { fetcher } = routedFetch([
      { match: '/points/v1/balance', reply: () => jsonResponse({ code: 1 }, 500) },
      {
        match: '/office/v3/setting_info',
        reply: () => jsonResponse({ code: 0, data: { point_grant_popups: [] } }),
      },
      { match: '/points/v2/bills', reply: () => jsonResponse({ code: 1 }, 500) },
    ])
    const outcome = await claimRaccoonDailyCheckin(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('already-claimed')
    if (outcome.kind === 'already-claimed') {
      expect(outcome.message.length).toBeGreaterThan(0)
      // ⚠️ 反向：不得出现编造的金额
      expect(outcome.message).not.toMatch(/\+\d+/)
    }
  })

  it('★ 必须带 X-Client-Platform（缺了办公端不结算）', async () => {
    const platforms: string[] = []
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = init?.headers as Record<string, string> | undefined
      platforms.push(String(headers?.['X-Client-Platform'] ?? ''))
      if (String(url).includes('setting_info')) {
        return jsonResponse({ code: 0, data: { point_grant_popups: [] } })
      }
      if (String(url).includes('/balance')) return jsonResponse(balanceBody(1))
      return jsonResponse({ code: 0, data: { items: [] } })
    }
    await claimRaccoonDailyCheckin(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(platforms.length).toBeGreaterThan(0)
    for (const platform of platforms) expect(platform).toBe(RACCOON.clientPlatform)
  })
})

/* ────────────────── PR #88 双审计返工的守卫（主理鱼补） ──────────────────
 *
 * 下面这组用例全部是「改前会绿、改后才会红」的形态：它们钉的是**行为**，
 * 不是源码文本。每一条都对应审计报告里一个具体的 P1/P2 编号。
 */
describe('★★★ PR #88 双审计返工：金额来源、零证据不锁死、形状异常、时区', () => {
  function balanceSeq(values: Array<number | string | null>): (url: string) => Response {
    let call = 0
    return () => {
      const value = values[Math.min(call, values.length - 1)]
      call += 1
      if (value === null) return jsonResponse({ code: 1, message: 'x' }, 500)
      return jsonResponse({ code: 0, data: { available_points: value, daily_points: 0, reward_points: 0, topup_points: 0, monthly_points: 0 } })
    }
  }
  const setting = (popups: unknown[] = [], toast = ''): (url: string) => Response =>
    () => jsonResponse({ code: 0, data: { point_grant_toast: toast, point_grant_popups: popups } })

  it('★★★ 余额多了 3000 但账单里今天的 daily_grant 只有 300 ⇒ credit 必须是 300（§F1/A1）', async () => {
    // 场景：用户在 before/after 之间领了「桌面端登录奖励 3000」，余额差 3300。
    // 若直接拿余额差当 credit，UI 会显示「今天签到领了 3300」而日额是 300。
    const today = raccoonUtc8Date()
    const { fetcher } = routedFetch([
      { match: '/points/v1/balance', reply: balanceSeq([1000, 4300]) },
      { match: '/office/v3/setting_info', reply: setting() },
      {
        match: '/points/v2/bills',
        reply: () => jsonResponse({
          code: 0,
          data: {
            items: [
              { biz_type: 'reward_grant', event_name: '桌面端登录奖励', points: 3000, created_at: `${today}T00:20:00+08:00` },
              { biz_type: 'daily_grant', event_name: '每日积分发放', points: 300, created_at: `${today}T00:14:00+08:00` },
            ],
          },
        }),
      },
    ])
    const outcome = await claimRaccoonDailyCheckin(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') {
      expect(outcome.credit, '金额必须取账单里 daily_grant 的合计，不能取余额差（含同期其它入账）').toBe(300)
    }
  })

  it('★★ 差额 > 0 但账单空 ⇒ 仍算 claimed，但 message 必须说明金额可能含其它入账', async () => {
    const { fetcher } = routedFetch([
      { match: '/points/v1/balance', reply: balanceSeq([1000, 1300]) },
      { match: '/office/v3/setting_info', reply: setting() },
      { match: '/points/v2/bills', reply: () => jsonResponse({ code: 0, data: { items: [] } }) },
    ])
    const outcome = await claimRaccoonDailyCheckin(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') {
      expect(outcome.credit).toBe(300)
      expect(String(outcome.message ?? ''), '必须提示这个金额的来源不确定').toContain('其它入账')
    }
  })

  it('★★★ 零证据（余额读不到 + 账单查不到 + 无弹窗）⇒ coversToday 必须是 false（§F2/B1）', async () => {
    // 这是最危险的一格：原实现回 already-claimed + coversToday:true ⇒
    // computeClaimSummary 计进 coversToday ⇒ auto-checkin 当天不再重试 ⇒
    // 真失败被永久伪装成「已结算」。
    const { fetcher } = routedFetch([
      { match: '/points/v1/balance', reply: balanceSeq([null]) },
      { match: '/office/v3/setting_info', reply: setting() },
      { match: '/points/v2/bills', reply: () => jsonResponse({ code: 1, message: 'x' }, 500) },
    ])
    const outcome = await claimRaccoonDailyCheckin(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('already-claimed')
    expect(outcome.coversToday, '三者都拿不到证据时必须让自动签到下一轮重试，不能锁死当天').toBe(false)
    if (outcome.kind === 'already-claimed') {
      expect(outcome.message).toContain('无法确认')
    }
  })

  it('★★ 余额不变但账单空、弹窗说有 300 ⇒ coversToday 必须是 true（有证据）', async () => {
    const { fetcher } = routedFetch([
      { match: '/points/v1/balance', reply: balanceSeq([1000, 1000]) },
      { match: '/office/v3/setting_info', reply: setting([{ source: 'daily', display_name: '每日积分发放', points: 300 }]) },
      { match: '/points/v2/bills', reply: () => jsonResponse({ code: 0, data: { items: [] } }) },
    ])
    const outcome = await claimRaccoonDailyCheckin(RACCOON, CRED, fetcher)
    expect(outcome.coversToday, '弹窗是上游给出的「今天发了」证据').toBe(true)
    if (outcome.kind === 'already-claimed') {
      expect(outcome.message).toContain('300')
    }
  })

  it('★★★ 账单缺 items 字段 ⇒ 必须当成「查不到」而不是「今天没发」（§C1）', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      if (String(url).includes('/points/v1/balance')) return jsonResponse(balanceBody(1000))
      if (String(url).includes('setting_info')) return jsonResponse({ code: 0, data: { point_grant_popups: [] } })
      // 业务成功但形状漂移（上游把 items 改名 / 少给）
      return jsonResponse({ code: 0, data: { page: 1 } })
    }
    const result = await fetchRaccoonTodayDailyGrants(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(result, '形状异常必须回 null（查不到），不能回 {total:0}（没有）').toBeNull()
  })

  it('★★★ 账单行的 points 不是数字 ⇒ 该行必须保留（登录奖励「已领」不得翻成「未领」，§C4）', async () => {
    // 本 PR 引入的回归：改成共享账单函数后 `points` 读不出就丢整行，
    // 于是「已领取」变成「未领取」—— 用户被提示可以再领（白跑三轮请求）。
    const fetcher = async (url: string): Promise<Response> => {
      if (String(url).includes('/points/v2/bills')) {
        return jsonResponse({
          code: 0,
          data: { items: [{ biz_type: 'reward_grant', event_name: '桌面端登录奖励', points: '3000', created_at: '2026-11-16T00:20:00+08:00' }] },
        })
      }
      return jsonResponse({ code: 0, data: {} })
    }
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(status.claimed, 'points 是字符串（纯展示问题）不得让「已领」翻成「未领」').toBe(true)
  })

  it('★★★ created_at 带 Z 时也必须按北京日归（§F4/C3）', async () => {
    // 同一时刻的两种写法必须归到同一天：2026-11-15T20:00:00Z = 北京 2026-11-16 04:00
    const run = async (createdAt: string) => {
      const fetcher = async (url: string): Promise<Response> => {
        if (String(url).includes('/points/v2/bills')) {
          return jsonResponse({
            code: 0,
            data: { items: [{ biz_type: 'daily_grant', event_name: '每日积分发放', points: 300, created_at: createdAt }] },
          })
        }
        return jsonResponse({ code: 0, data: {} })
      }
      const fixed = Date.parse('2026-11-16T04:00:00+08:00')
      return fetchRaccoonTodayDailyGrants(RACCOON, CRED, fetcher as unknown as typeof fetch, fixed)
    }
    const z = await run('2026-11-15T20:00:00Z')
    const plus = await run('2026-11-16T04:00:00+08:00')
    expect(z?.total, 'Z 形态（= 北京 16 日 04:00）必须计入').toBe(300)
    expect(plus?.total).toBe(300)
  })

  it('★★ created_at 无法解析 ⇒ 该行跳过（不崩、不误计）', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      if (String(url).includes('/points/v2/bills')) {
        return jsonResponse({
          code: 0,
          data: {
            items: [
              { biz_type: 'daily_grant', event_name: '每日积分发放', points: 300, created_at: '' },
              { biz_type: 'daily_grant', event_name: '每日积分发放', points: 300, created_at: 'not-a-date' },
            ],
          },
        })
      }
      return jsonResponse({ code: 0, data: {} })
    }
    const result = await fetchRaccoonTodayDailyGrants(RACCOON, CRED, fetcher as unknown as typeof fetch, Date.now())
    expect(result?.total).toBe(0)
  })

  it('★★ 差额带浮点误差时 roundCredits 必须收成两位小数（§M11 无牙）', async () => {
    // ⚠️ 夹具有讲究：用 `1000 → 1000.4` 这种**恰好精确**的差值，去掉
    // `roundCredits` 也还是 `0.4` ⇒ 用例恒真。必须让裸减法产生误差：
    // `1000.4 - 1000.1 === 0.30000000000000004`，`roundCredits` 才会把它收成 `0.3`。
    expect(1000.4 - 1000.1, '夹具前提：这个减法必须真的产生浮点误差').not.toBe(0.3)
    const { fetcher } = routedFetch([
      { match: '/points/v1/balance', reply: balanceSeq([1000.1, 1000.4]) },
      { match: '/office/v3/setting_info', reply: setting() },
      { match: '/points/v2/bills', reply: () => jsonResponse({ code: 0, data: { items: [] } }) },
    ])
    const outcome = await claimRaccoonDailyCheckin(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') {
      expect(outcome.credit, 'UI 上出现 0.30000000000000004 就是这层没生效').toBe(0.3)
    }
  })
})

