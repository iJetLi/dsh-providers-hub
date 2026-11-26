/**
 * 豆包**去浏览器**的三块拼图（2026-11-26 复审后重写）：
 *
 * 1. `src/doubao-bdms.ts`：**内置**的 bdms SDK（不再是运行时从 CDN 拉），sha256 钉扎，
 *    且沙箱里**不递任何宿主对象**；
 * 2. `src/doubao-signin.ts`：HTTP 签到腿（签名 → 两步 POST → 三态映射）；
 * 3. `src/doubao-credits.ts` 的 `claimDoubaoDailyCheckin` 薄壳：`ClaimOutcome` 的透传。
 *
 * ⚠️ 这里会**真的**跑内置 SDK 签名一次（本地文件、零网络）——那是本 PR 的核心资产，
 * 用替身测等于没测。其余用例仍用注入的 `sign` 替身，专测请求形状与结果映射。
 *
 * @module tests/unit/doubao-browserless
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import {
  DOUBAO_BDMS_SDK_SHA256,
  createBdmsContext,
  loadDoubaoBdmsSdk,
  resetDoubaoBdmsSigner,
  signDoubaoBogus,
  verifyDoubaoBdmsSdkSource,
} from '../../src/doubao-bdms.js'
import { claimDoubaoDaily, claimDoubaoDailyViaHttp, probeDoubaoSession } from '../../src/doubao-signin.js'
import { claimDoubaoDailyCheckin } from '../../src/doubao-credits.js'

const CREDENTIAL = JSON.stringify({ cookie: 'sessionid=sess_123; ttwid=tw_1', accountKey: 'sess_123' })

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetDoubaoBdmsSigner()
})

describe('★ 内置 bdms SDK：零下载 + sha256 钉扎', () => {
  it('内置文件存在，且与钉扎的 sha256 一致', () => {
    const source = loadDoubaoBdmsSdk()
    expect(source.length).toBeGreaterThan(150_000)
    expect(DOUBAO_BDMS_SDK_SHA256).toMatch(/^[0-9a-f]{64}$/)
    // 再算一遍：装载路径本身就会校验，这里显式确认不抛
    expect(() => verifyDoubaoBdmsSdkSource(source)).not.toThrow()
  })

  it('内容被改动（一个字节）⇒ 校验抛错，且拒绝 execute', () => {
    const source = loadDoubaoBdmsSdk()
    const tampered = source.replace('window.bdms', 'window.bdmsX')
    expect(() => verifyDoubaoBdmsSdkSource(tampered)).toThrow(/sha256/i)
  })

  it('⚠️ 真实签名一次：不联网也产得出 16 字符 X-Bogus', async () => {
    // 把全局 fetch 换成"一调就炸"：任何网络下载都会当场失败
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('不应发生任何网络请求') }))
    const bogus = await signDoubaoBogus()
    // 16 字符的 base64 摘要片（实测出现过 `-` `_` `/` 三种符号，故只锁「16 个 base64 字符」）
    expect(bogus).toMatch(/^[A-Za-z0-9+/_-]{16}$/)
  })

  it('⚠️ 源码里不许再出现 CDN / 运行时下载（回归守卫）', () => {
    const source = readFileSync(new URL('../../src/doubao-bdms.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/lf-flow-web-cdn/)
    expect(source).not.toMatch(/CHUNK_BASE|FALLBACK_HASH|parseBdmsChunkUrl/)
    // 允许 readFileSync（本地烘焙），不允许 fetch 去取脚本
    expect(source).not.toMatch(/await fetch\(/)
  })
})

describe('★ 沙箱纯度：宿主对象一个都不许递进去', () => {
  it('上下文里没有宿主 process / Buffer；require 只有 SE 一个白名单', () => {
    const context = createBdmsContext()
    expect(vmTypeof(context, 'process')).toBe('undefined')
    expect(vmTypeof(context, 'Buffer')).toBe('undefined')
    expect(() => runInCtx(context, `require('node:fs')`)).toThrow(/不允许 require/)
    expect(() => runInCtx(context, `require('fs')`)).toThrow(/不允许 require/)
  })

  it('document / navigator / atob / btoa 都是上下文自造的（改它们不影响宿主）', () => {
    const context = createBdmsContext()
    expect(runInCtx(context, `typeof this.atob`)).toBe('function')
    // 真 atob 语义自检（纯 JS 实现，不是宿主 Buffer 转发）
    expect(runInCtx(context, `this.atob('aGVsbG8=')`)).toBe('hello')
    expect(runInCtx(context, `this.btoa('hello')`)).toBe('aGVsbG8=')
    expect(runInCtx(context, `this.navigator.userAgent.length > 20`)).toBe(true)
  })
})

// 小工具：在给定上下文里跑一段表达式（避免测试正文里到处都是 vm 调用）
function runInCtx(context: ReturnType<typeof createBdmsContext>, expression: string): unknown {
  return vm.runInContext(expression, context)
}

function vmTypeof(context: ReturnType<typeof createBdmsContext>, name: string): string {
  return String(runInCtx(context, `typeof ${name}`))
}

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
      // ⚠️ 浏览器腿已删除，文案不许再引导用户"装浏览器 / 找 Chrome"。
      expect(result.message).not.toContain('未找到可用的浏览器')
      expect(result.message).not.toMatch(/Chrome|Chromium|chrome\.exe/)
    }
  })

  it('签名可用 ⇒ 走 HTTP 腿，且全程不 spawn 任何子进程', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 0, data: { checked_in: true, reward_amount: 10, continuous_days: 1 } })))
    // ⚠️ 真断言（此前只在标题里写了"不 spawn"，没有真的守卫）：整个签到腿不许 import
    //    child_process，也不许出现 spawn/exec 调用。
    const signin = readFileSync(new URL('../../src/doubao-signin.ts', import.meta.url), 'utf8')
    const bdms = readFileSync(new URL('../../src/doubao-bdms.ts', import.meta.url), 'utf8')
    for (const source of [signin, bdms]) {
      expect(source).not.toMatch(/child_process/)
      expect(source).not.toMatch(/\bspawn\b|\bexecFile\b|\bexecSync\b/)
      expect(source).not.toMatch(/browserCandidates|findBrowserExecutable|DSH_DOUBAO_BROWSER_PATH/)
    }
    const result = await claimDoubaoDaily(CREDENTIAL, { sign: async () => 'B' })
    expect(result.kind).toBe('claimed')
  })
})

describe('★ claimDoubaoDailyCheckin 薄壳：ClaimOutcome 必须如实透传', () => {
  it('签名不可用 ⇒ 薄壳回 failed（不得吞成 inactive）', async () => {
    const outcome = await claimDoubaoDailyCheckin(
      { cookie: 'sessionid=sess_123' },
      { sign: async () => { throw new Error('沙箱装载失败') } },
    )
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.message).toContain('沙箱装载失败')
  })

  it('签名可用 + 上游 claimed ⇒ 薄壳回 claimed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      code: 0, data: { checked_in: true, reward_amount: 20, continuous_days: 2 },
    })))
    const outcome = await claimDoubaoDailyCheckin(
      { cookie: 'sessionid=sess_123' },
      { sign: async () => 'B' },
    )
    expect(outcome.kind).toBe('claimed')
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
