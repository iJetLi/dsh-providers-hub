/**
 * ★★★ **风控（3012）必须短路三条业务判据 + 两条归类/文案轴**（GitHub issue #85）。
 *
 * ## 缺陷
 *
 * `3012` 的响应正文里**完全可能**出现 `1005` / `3009` / `3007`：
 * 领取路径的真实 plan_id 就是 `zcode-v3-start-plan-trust-1005`，`logid` 常含数字串。
 *
 * 而这三条判据排在「风控」之前，且各自驱动一条**有害**的动作：
 *
 * | 判据 | 命中后 | 危害（实测 2026-11-13）|
 * |---|---|---|
 * | 额度 | `switchAccountOnQuota` 换号 | **三个号各写一条「到次日 0 点」的限流标记**，全部被烧 |
 * | 并发 | 退避后重发 | 对风控请求重发 |
 * | captcha | 补产 captcha 后重发 | 白烧阿里云「同设备每小时 150 次」配额 |
 *
 * 本仓笔记早已确立：**「对 405 重试不只是无用，是有害的」**。
 *
 * ## 修法
 *
 * 与 `looksLikeZcodeHtmlPage` 短路**同轴**：风控一律先返回 `false`（三条 `is*`），
 * 或归 `PERMISSION`（归类轴），或走风控文案（文案轴）。
 */
import { describe, expect, it } from 'vitest'
import {
  describeUpstreamError,
  httpErrorCodeForZcode,
  isZcodeCaptchaRejected,
  isZcodeConcurrencyLimited,
  isZcodeQuotaExhausted,
} from '../../src/zcode-adapter.js'

/** 真实上游 3012 的形态（`msg` 逐字取自真机）。 */
const RISK_BARE = '{"code":3012,"msg":"request has been blocked due to unusual activity."}'
/** 同一份 3012，但正文里夹了业务码数字（issue #85 的攻击输入）。 */
const riskWith = (extra: string) => `{"code":3012,"msg":"unusual activity","detail":"${extra}"}`

describe('issue #85：风控 3012 的短路', () => {
  it('★★★ 裸 3012 ⇒ 三条判据全 false、归类 PERMISSION', () => {
    expect(isZcodeQuotaExhausted(405, RISK_BARE)).toBe(false)
    expect(isZcodeConcurrencyLimited(405, RISK_BARE)).toBe(false)
    expect(isZcodeCaptchaRejected(405, RISK_BARE)).toBe(false)
    expect(httpErrorCodeForZcode(405, RISK_BARE)).toBe('PERMISSION')
  })

  it('★★★ 3012 + 正文夹 1005 ⇒ **额度判据必须 false**（否则换号把整池烧光）', () => {
    const body = riskWith('zcode-v3-start-plan-trust-1005')
    expect(isZcodeQuotaExhausted(405, body)).toBe(false)
  })

  it('★★★ 3012 + 正文夹 3009 ⇒ **并发判据必须 false**（否则退避重发）', () => {
    const body = riskWith('3009')
    expect(isZcodeConcurrencyLimited(405, body)).toBe(false)
  })

  it('★★★ 3012 + 正文夹 3007 ⇒ **captcha 判据必须 false**（否则补产重发、白烧设备配额）', () => {
    const body = riskWith('3007')
    expect(isZcodeCaptchaRejected(405, body)).toBe(false)
  })

  it('★★★ 3012 + 3009 ⇒ 归类 **PERMISSION**（不能是 RATE_LIMIT —— 它在可重试集合里）', () => {
    expect(httpErrorCodeForZcode(405, riskWith('3009'))).toBe('PERMISSION')
  })

  it('★★★ 3012 + 3007 ⇒ 归类 **PERMISSION**（同上）', () => {
    expect(httpErrorCodeForZcode(405, riskWith('3007'))).toBe('PERMISSION')
  })

  it('★★★ 3012 + 1005 ⇒ 归类 **PERMISSION**（不能是 QUOTA_EXCEEDED）', () => {
    expect(httpErrorCodeForZcode(405, riskWith('1005'))).toBe('PERMISSION')
  })

  it('★★ 3012 + 3009 ⇒ **文案必须是风控**（不能建议用户「稍后重试」）', () => {
    const text = describeUpstreamError(405, riskWith('3009'))
    expect(text).toContain('风控')
    expect(text).not.toContain('并发限流')
  })

  // ── 反向：真业务码不受影响（防「一刀切短路」）────────────────────
  it('★ 真 1005（无风控语义）⇒ 额度判据仍 true', () => {
    expect(isZcodeQuotaExhausted(400, '{"code":1005,"msg":"exceed quota limit"}')).toBe(true)
  })

  it('★ 真 1113 ⇒ 额度判据仍 true', () => {
    expect(isZcodeQuotaExhausted(400, '{"code":1113,"msg":"余额不足"}')).toBe(true)
  })

  it('★ 真 3009（无风控语义）⇒ 并发判据仍 true', () => {
    expect(isZcodeConcurrencyLimited(429, '{"code":3009,"msg":"concurrency limit exceeded"}')).toBe(true)
  })

  it('★ 真 3007（无风控语义）⇒ captcha 判据仍 true', () => {
    expect(isZcodeCaptchaRejected(400, '{"code":3007,"msg":"captcha verify failed"}')).toBe(true)
  })

  it('★ HTML 边缘页里的 1005 仍被豁免（既有行为不变）', () => {
    expect(isZcodeQuotaExhausted(502, '<html><title>1005</title></html>')).toBe(false)
  })
})
