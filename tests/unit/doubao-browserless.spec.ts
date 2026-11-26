/**
 * 豆包**去浏览器**的两块拼图（2026-11-25）：
 *
 * 1. `src/doubao-bdms.ts` 的 **chunk 地址解析**（`bdms-sdk.<hash>.js` 每次发版都变，
 *    而"猜错 chunk"的后果是签名一直空串 —— 只能靠日志发现）；
 * 2. `src/doubao-signin.ts` 的 **HTTP 签到腿**（签名 → 两步 POST → 三态映射）
 *    与 **浏览器回退判据**（只有"签名不可用"才回退，网络错误不回退）。
 *
 * ⚠️ 不测真实签名（要下载 163KB 官方 SDK，CI 网络不可控）；签名本身用注入的
 * `sign` 替身，被测的是**请求形状**与**结果映射**——那才是会被改坏的部分。
 *
 * @module tests/unit/doubao-browserless
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBdmsChunkUrl } from '../../src/doubao-bdms.js'
import { claimDoubaoDaily, claimDoubaoDailyViaHttp, probeDoubaoSession } from '../../src/doubao-signin.js'

const CREDENTIAL = JSON.stringify({ cookie: 'sessionid=sess_123; ttwid=tw_1', accountKey: 'sess_123' })

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('★ bdms chunk 地址解析', () => {
  it('从 rspack manifest 里读出 bdms-sdk 的哈希', () => {
    // 真实 HTML 的形态（节选自 2026-11-25 的 chat 页）
    const html = '...{97:"s2-applet-music-player","9a":"bdms-sdk","9b":"async-business-input-engine-upload"...'
      + '...{99:"195ed0f7e4","9a":"173db50026","9b":"1db207db47"...'
    expect(parseBdmsChunkUrl(html))
      .toBe('https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/chat/static/js/async/bdms-sdk.173db50026.js')
  })

  it('转义引号（被包成 JS 字符串）的形态也要认', () => {
    const html = '{\\"9a\\":\\"bdms-sdk\\"} ... {\\"9a\\":\\"173db50026\\"}'
    expect(parseBdmsChunkUrl(html))
      .toBe('https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/chat/static/js/async/bdms-sdk.173db50026.js')
  })

  it('⚠️ 名字映射不是 bdms-sdk 时**必须放弃**（别把别的 chunk 当签名 SDK）', () => {
    // 上游重排 chunk id 的形态：9a 已经不是 bdms-sdk，但哈希还在
    const html = '{\\"9a\\":\\"some-other-chunk\\"} ... {\\"9a\\":\\"173db50026\\"}'
    expect(parseBdmsChunkUrl(html)).toBeUndefined()
  })

  it('读不到哈希 ⇒ undefined（调用方回落到内置兜底哈希）', () => {
    expect(parseBdmsChunkUrl('<html>no manifest here</html>')).toBeUndefined()
  })
})

describe('★ 豆包 HTTP 签到腿', () => {
  it('两步 POST：带 a_bogus、Cookie 与 Agw-Js-Conv，成功映射成 claimed', async () => {
    const calls: Array<{ url: string, init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes('/landing/get')) return jsonResponse({ code: 0, data: {} })
      return jsonResponse({
        code: 0,
        data: { checked_in: true, reward_amount: 50, continuous_days: 3, checkin_date: '2026-11-25' },
      })
    }))

    const result = await claimDoubaoDailyViaHttp(CREDENTIAL, { sign: async () => 'BOGUS_TEST' })
    expect(result.signerError).toBeUndefined()
    expect(result.outcome.kind).toBe('claimed')
    if (result.outcome.kind === 'claimed') {
      expect(result.outcome.credit).toBe(50)
      expect(result.outcome.streakDays).toBe(3)
    }
    // 两条腿都要带签名与 cookie（缺一个上游就回 710010702 / 未登录）
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.url).toContain('a_bogus=BOGUS_TEST')
      const headers = call.init?.headers as Record<string, string>
      expect(headers.cookie).toContain('sessionid=sess_123')
      expect(headers['agw-js-conv']).toBe('str')
    }
    expect(calls[1]?.url).toContain('/alice/ug/campaign/landing/checkin')
    expect(calls[1]?.init?.method).toBe('POST')
  })

  it('710010702 ⇒ inactive（"今天没活动"，不是故障）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 710010702, message: 'no activity' })))
    const result = await claimDoubaoDailyViaHttp(CREDENTIAL, { sign: async () => 'B' })
    expect(result.outcome.kind).toBe('inactive')
    if (result.outcome.kind === 'inactive') expect(result.outcome.message).toContain('没有可领取')
  })

  it('幂等已签 ⇒ already-claimed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 0, data: { checked_in: false, idempotent: true } })))
    const result = await claimDoubaoDailyViaHttp(CREDENTIAL, { sign: async () => 'B' })
    expect(result.outcome.kind).toBe('already-claimed')
  })

  it('没有 cookie ⇒ inactive，且一个请求都不发', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await claimDoubaoDailyViaHttp(JSON.stringify({ accountKey: 'x' }), { sign: async () => 'B' })
    expect(result.outcome.kind).toBe('inactive')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('★ 无浏览器：签名不可用时直接失败（没有浏览器可回退）', () => {
  it('签名不可用 ⇒ failed，文案直指 bdms 签名侧、且明确不提浏览器', async () => {
    const result = await claimDoubaoDaily(CREDENTIAL, {
      sign: async () => { throw new Error('bdms SDK 初始化后没有 frontierSign') },
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.message).toContain('签名环境不可用')
      expect(result.message).toContain('frontierSign')
      // ⚠️ 2026-11-25：浏览器腿已删除，文案不许再引导用户"装浏览器 / 找 Chrome"。
      expect(result.message).not.toContain('未找到可用的浏览器')
      expect(result.message).not.toMatch(/Chrome|Chromium|chrome\.exe/)
    }
  })

  it('签名可用 ⇒ 走 HTTP 腿，且全程不 spawn 任何子进程', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 0, data: { checked_in: true, reward_amount: 10, continuous_days: 1 } })))
    const result = await claimDoubaoDaily(CREDENTIAL, { sign: async () => 'B' })
    expect(result.kind).toBe('claimed')
  })
})

/**
 * 豆包 **cookie 导入**的探活判据（2026-11-26）。
 *
 * ⚠️ 钉死的原因：扫码在「扫完之后」被 passport 强制要求 SDK 现场算的
 * `sign/qs/a_bogus`（绑定当次 query），纯 HTTP 造不出来 ⇒ 用户报「扫完二维码
 * 一直不消失」。改用粘 cookie 后，唯一需要判的就是「这份 cookie 还有效吗」。
 * 判据来自真机实测：失效回 `710012001 登录已过期`，有效回 `code:0`（或
 * `710010702`「当前无活动」）。**只有 710012001 才拦人**，网络失败一律放行。
 */
describe('★ 豆包 cookie 探活（导入登录）', () => {
  it('710012001 ⇒ 判定失效（并带出上游文案）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: null, code: 710012001, msg: '登录已过期，请重新登录', message: 'login invalid',
    })))
    const result = await probeDoubaoSession(CREDENTIAL, { sign: async () => 'bogus_x' })
    expect(result.sessionOk).toBe(false)
    expect(result.code).toBe(710012001)
    expect(result.message).toContain('登录已过期')
  })

  it('code:0 / 710010702 ⇒ 视为有效（活动类错误与登录态无关）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 0, data: { activity: {} } })))
    expect((await probeDoubaoSession(CREDENTIAL, { sign: async () => 'b' })).sessionOk).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 710010702, data: null })))
    expect((await probeDoubaoSession(CREDENTIAL, { sign: async () => 'b' })).sessionOk).toBe(true)
  })

  it('网络失败 ⇒ undefined（不拦人，别因一次抖动拒掉有效 cookie）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up') }))
    const result = await probeDoubaoSession(CREDENTIAL, { sign: async () => 'b' })
    expect(result.sessionOk).toBeUndefined()
    expect(result.message).toContain('socket hang up')
  })

  it('探活只发 landing/get，绝不发签到（不能替用户签到）', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      urls.push(String(input))
      return jsonResponse({ code: 0, data: {} })
    }))
    await probeDoubaoSession(CREDENTIAL, { sign: async () => 'b' })
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/alice/ug/campaign/landing/get')
    expect(urls.some((u) => u.includes('/checkin'))).toBe(false)
  })
})
