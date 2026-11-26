/**
 * 豆包额度余额（`fetchDoubaoBalanceDetailed` + `doubaoBalanceFromOverviewPayload`）。
 *
 * 2026-11-26 晚：真实读数落地 —— 端点是 `POST /alice/commerce/sale/subscription/overview/`
 * （面板真实请求，REA + Playwright 驱动真 Chrome 抓到的），**不需要 `a_bogus`**。
 * fixture 全部取自实测响应，不发真实网络请求。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DOUBAO_OVERVIEW_BODY,
  DOUBAO_OVERVIEW_PATH,
  doubaoBalanceFromOverviewPayload,
  fetchDoubaoBalanceDetailed,
  parseDoubaoAmount,
} from '../../src/doubao-credits.js'

const credential = { cookie: 'sessionid=fake; ttwid=x' }

/** 实测形态（2026-11-26）：4,003 = 套餐 2,142 + 赠送 1,861。 */
const wireData = {
  quota_balance_overview: {
    has_more: true,
    total_remaining_amount: '4,003',
    summaries: [
      { category: 1, title: '套餐', remaining_amount: '2,142' },
      { category: 3, title: '赠送', remaining_amount: '1,861' },
    ],
    top_items: [
      {
        category: 1,
        display_name: '豆包工作体验套餐',
        total_amount: '2,142',
        used_amount: '0',
        used_percent: 0,
        end_time: 1_797_937_149_723,
        time_type: 2,
      },
      {
        category: 3,
        display_name: '活动赠送额度',
        total_amount: '200',
        used_amount: '89',
        used_percent: 44,
        end_time: 1_797_937_151_657,
        time_type: 2,
      },
    ],
  },
  window_limit_section: {
    window_limit_groups: [
      {
        feature_group: 'doubao_work_trial_quota',
        feature_group_name: '豆包工作体验套餐',
        window_limits: [{ total_amount: '2,142', used_amount: '0', used_percent: 0 }],
      },
    ],
  },
  incentive_quota_section: {
    window_limit_groups: [
      {
        feature_group: 'doubao_activity_reward_quota',
        feature_group_name: '活动赠送额度',
        window_limits: [{ total_amount: '1,950', used_amount: '89', used_percent: 4 }],
      },
    ],
  },
}

describe('parseDoubaoAmount', () => {
  it('吃得下带千分位的字符串、纯字符串与 number', () => {
    expect(parseDoubaoAmount('4,003')).toBe(4003)
    expect(parseDoubaoAmount('0')).toBe(0)
    expect(parseDoubaoAmount(4003)).toBe(4003)
    // ⚠️ `Number("4,003")` 是 NaN —— 这正是当初卡片显示 0 的根因。
    expect(parseDoubaoAmount('')).toBeNaN()
    expect(parseDoubaoAmount(undefined)).toBeNaN()
  })
})

describe('doubaoBalanceFromOverviewPayload', () => {
  it('总额取 total_remaining_amount，逐分类带 剩余/总额/已用', () => {
    const balance = doubaoBalanceFromOverviewPayload(wireData)
    expect(balance.total).toBe(4003)
    expect(balance.packages.map((p) => p.name)).toEqual(['套餐', '赠送'])
    expect(balance.packages[0]).toMatchObject({
      remaining: 2142,
      total: 2142,
      used: 0,
      totalKnown: true,
      active: true,
      unit: 'credit',
    })
    // 1950 - 89 = 1861 ⇒ section 聚合与摘要算术自洽，分母才被采用。
    expect(balance.packages[1]).toMatchObject({ remaining: 1861, total: 1950, used: 89, totalKnown: true })
    expect(balance.expiredTotal).toBe(0)
  })

  it('section 总额对不上剩余时不采用（totalKnown=false，绝不编分母）', () => {
    const mismatched = {
      ...wireData,
      incentive_quota_section: {
        window_limit_groups: [
          {
            feature_group: 'doubao_activity_reward_quota',
            window_limits: [{ total_amount: '200', used_amount: '89' }],
          },
        ],
      },
    }
    const balance = doubaoBalanceFromOverviewPayload(mismatched)
    expect(balance.packages[1]).toMatchObject({ remaining: 1861, total: 1861, used: 0, totalKnown: false })
  })

  it('缺 total_remaining_amount 时退回各分类剩余之和', () => {
    const balance = doubaoBalanceFromOverviewPayload({
      quota_balance_overview: {
        summaries: [
          { category: 1, title: '套餐', remaining_amount: '300' },
          { category: 3, title: '赠送', remaining_amount: '200' },
        ],
      },
    })
    expect(balance.total).toBe(500)
    expect(balance.packages.every((p) => p.totalKnown === false)).toBe(true)
  })

  it('空/异常数据不抛，回 0 与空明细', () => {
    expect(doubaoBalanceFromOverviewPayload(null)).toMatchObject({ total: 0, packages: [], expiredTotal: 0 })
    expect(doubaoBalanceFromOverviewPayload({ quota_balance_overview: { summaries: [] } }).total).toBe(0)
  })

  it('remaining=0 的分类不算可用', () => {
    const balance = doubaoBalanceFromOverviewPayload({
      quota_balance_overview: {
        total_remaining_amount: '2,142',
        summaries: [
          { category: 1, title: '套餐', remaining_amount: '2,142' },
          { category: 3, title: '赠送', remaining_amount: '0' },
        ],
      },
    })
    expect(balance.packages.map((p) => p.active)).toEqual([true, false])
  })
})

describe('fetchDoubaoBalanceDetailed', () => {
  const okFetch = (body: unknown, status = 200) => vi.fn(async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  ))

  it('code:0 ⇒ 真实余额；请求必须是 POST overview、带 body，且**不要 a_bogus**', async () => {
    const fetchImpl = okFetch({ code: 0, data: wireData })
    const result = await fetchDoubaoBalanceDetailed(credential, { fetchImpl })
    expect(result.error).toBeUndefined()
    expect(result.balance?.total).toBe(4003)
    const [url, init] = (fetchImpl.mock.calls[0] as unknown) as [string, RequestInit]
    expect(url.startsWith(`https://www.doubao.com${DOUBAO_OVERVIEW_PATH}?`)).toBe(true)
    // ⚠️ 当初 404 的唯一原因就是这里写成了 GET。
    expect(init.method).toBe('POST')
    expect(init.body).toBe(DOUBAO_OVERVIEW_BODY)
    expect(url).not.toContain('a_bogus')
    const headers = init.headers as Record<string, string>
    expect(headers.cookie).toBe(credential.cookie)
    expect(headers['agw-js-conv']).toBe('str')
    expect(headers['content-type']).toBe('application/json')
  })

  it('710012001 ⇒ 可读的「登录已过期」，不返回假余额', async () => {
    const result = await fetchDoubaoBalanceDetailed(credential, {
      fetchImpl: okFetch({ code: 710012001, message: '登录已过期' }),
    })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('710012001')
    expect(result.error).toContain('重新导入 Cookie')
  })

  it('HTTP 404 / 非 JSON / 无额度分类 都回可读原因（绝不编造 0）', async () => {
    const notFound = await fetchDoubaoBalanceDetailed(credential, { fetchImpl: okFetch('', 404) })
    expect(notFound.balance).toBeNull()
    expect(notFound.error).toContain('HTTP 404')

    const html = await fetchDoubaoBalanceDetailed(credential, { fetchImpl: okFetch('<html>blocked</html>') })
    expect(html.balance).toBeNull()
    expect(html.error).toContain('不是 JSON')

    const empty = await fetchDoubaoBalanceDetailed(credential, { fetchImpl: okFetch({ code: 0, data: {} }) })
    expect(empty.balance).toBeNull()
    expect(empty.error).toContain('没有返回任何额度分类')
  })

  it('没有 cookie ⇒ 直接报「先导入 Cookie」，不发请求', async () => {
    const fetchImpl = okFetch({ code: 0, data: wireData })
    const result = await fetchDoubaoBalanceDetailed({}, { fetchImpl })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('导入 Cookie')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
