import { describe, expect, it } from 'vitest'

import {
  classifyMarvisError,
  findMarvisFallback,
  MARVIS,
  MARVIS_FALLBACK_MODELS,
  marvisErrorKindCode,
  normalizeMarvisModelId,
} from '../../src/marvis-product.js'

/**
 * Marvis 的错误分类判据。
 *
 * ## 为什么必须按**业务码**判、而不是按 HTTP 状态码判
 *
 * 2026-11-09 真机实测（`.tmp-marvis/probe*.mjs`，本机 QQ 账号）：
 *
 * | 情形 | HTTP | body |
 * |---|---|---|
 * | 登录态过期 | **200** | `{"code":4100403,"msg":"客户端通用错误:登录态过期/未登录"}` |
 * | 请求被风控 | **403** | `{"code":4100404,"msg":"客户端通用错误:请求被风控拦截"}` |
 * | 模型无授权 | **400** | `{"code":4130001,"msg":"客户端AI业务错误: 无效模型id"}` |
 * | 参数非法 | **400** | `{"code":3000101,"msg":"invalid parameter"}` |
 *
 * ⇒ 只看状态码会把「风控」和「认证」混成一家、把「模型不可用」当成
 *   「请求非法」（后者会被 harness 当成用户的错、永不重试也不换号，
 *   而真因是该账号没开通这个模型——换个号就好了）。
 *
 * ⚠️ 反向陷阱同样存在：**不能**「只要 body 里出现 `登录` 就判 auth」——
 *    4100404 的报文里没有「登录」，但腾讯域其它风控页常同时提到两者，
 *    按文案抢判会让风控被误记成账号态（本仓 2026-10-06 全池被封事故同型）。
 */
describe('classifyMarvisError', () => {
  it('★ 登录态过期（HTTP 200 + 业务码 4100403）判 auth', () => {
    const info = classifyMarvisError(
      200,
      '{"code":4100403,"msg":"客户端通用错误:登录态过期/未登录"}',
    )
    expect(info.kind).toBe('auth')
    expect(info.detail).toContain('登录态过期')
  })

  it('★ 风控拦截（业务码 4100404）判 risk，即使状态码是 403', () => {
    const info = classifyMarvisError(
      403,
      '{"code":4100404,"msg":"客户端通用错误:请求被风控拦截"}',
    )
    expect(info.kind).toBe('risk')
  })

  it('★ 业务码先于状态码：403 + 4100403 仍是 auth（不是 risk）', () => {
    expect(classifyMarvisError(403, '{"code":4100403,"msg":"登录态过期"}').kind).toBe('auth')
  })

  it('★ 模型无授权（4130001 无效模型id）判 model_unavailable，不是 invalid_request', () => {
    const info = classifyMarvisError(
      400,
      '{"code":4130001,"msg":"客户端AI业务错误: 无效模型id"}',
    )
    expect(info.kind).toBe('model_unavailable')
  })

  it('★ 4100402 也是模型侧问题（magpie 的 MODEL_ISSUE 正则同批）', () => {
    expect(classifyMarvisError(400, '{"code":4100402,"msg":"模型不可用"}').kind).toBe(
      'model_unavailable',
    )
  })

  it('★ 参数非法（3000101）判 invalid_request', () => {
    expect(classifyMarvisError(400, '{"code":3000101,"msg":"invalid parameter"}').kind).toBe(
      'invalid_request',
    )
  })

  it('404 判 model_unavailable（kimi-k2.5 实测 404/500 的目录侧形态）', () => {
    expect(classifyMarvisError(404, '').kind).toBe('model_unavailable')
  })

  it('429 判 rate_limit，并保留 retry-after', () => {
    const info = classifyMarvisError(429, 'too many requests', { 'retry-after': '7' })
    expect(info.kind).toBe('rate_limit')
    expect(info.retryAfterMs).toBe(7_000)
  })

  it('402 判 quota', () => {
    expect(classifyMarvisError(402, '').kind).toBe('quota')
  })

  it('★ 上下文超限判 context_window（先于 quota/rate_limit 的关键词判据）', () => {
    expect(
      classifyMarvisError(
        400,
        '{"code":3000101,"msg":"maximum context length is 8192 tokens"}',
      ).kind,
    ).toBe('context_window')
    expect(classifyMarvisError(400, 'context window exceeded').kind).toBe('context_window')
  })

  it('500 + 5104002（RPC 报错）判 server', () => {
    expect(
      classifyMarvisError(500, '{"code":5104002,"msg":"服务端依赖RPC接口报错:RPC调用报错"}')
        .kind,
    ).toBe('server')
  })

  it('传输层失败（status 0 / fetch failed）判 transport', () => {
    expect(classifyMarvisError(0, 'fetch failed').kind).toBe('transport')
    expect(classifyMarvisError(0, 'ECONNRESET').kind).toBe('transport')
  })

  it('detail 禁止裸 JSON：优先取 msg 字段', () => {
    const info = classifyMarvisError(400, '{"code":3000101,"msg":"invalid parameter"}')
    expect(info.detail).toBe('invalid parameter')
  })

  it('detail 非 JSON 时截断到 500 字', () => {
    const info = classifyMarvisError(500, 'x'.repeat(600))
    expect(info.detail.length).toBe(501)
    expect(info.detail.endsWith('…')).toBe(true)
  })

  it('空 body 给可读兜底文案', () => {
    expect(classifyMarvisError(500, '').detail).toContain('上游未返回错误详情')
  })
})

describe('marvisErrorKindCode', () => {
  it('额度/限流/认证用字面量（不得被客户端换掉 message）', () => {
    expect(marvisErrorKindCode('quota')).toBe('QUOTA_EXCEEDED')
    expect(marvisErrorKindCode('rate_limit')).toBe('RATE_LIMIT')
    expect(marvisErrorKindCode('auth')).toBe('AUTH')
  })

  it('风控判 PERMISSION（不是 AUTH：报文本身是出路）', () => {
    expect(marvisErrorKindCode('risk')).toBe('PERMISSION')
  })

  it('上下文超限走宿主常量', () => {
    expect(marvisErrorKindCode('context_window')).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('模型侧问题判 BAD_REQUEST（确定性失败，不重试）', () => {
    expect(marvisErrorKindCode('model_unavailable')).toBe('BAD_REQUEST')
    expect(marvisErrorKindCode('invalid_request')).toBe('BAD_REQUEST')
  })

  it('服务端/传输层走可重试码', () => {
    expect(marvisErrorKindCode('server')).toBe('SERVER')
    expect(marvisErrorKindCode('transport')).toBe('TRANSPORT')
  })
})

describe('Marvis 目录（单条 deepseek-v4-pro-external）', () => {
  it('只有一条模型，显示名是美化名', () => {
    expect(MARVIS_FALLBACK_MODELS).toHaveLength(1)
    const [only] = MARVIS_FALLBACK_MODELS
    expect(only?.id).toBe('deepseek-v4-pro-external')
    expect(only?.name).toBe('DeepSeek V4.1 Flash')
    expect(only?.contextWindow).toBe(1_000_000)
    expect(only?.supportsImage).toBe(true)
  })

  it('product 常量与 `src/marvis.ts` 同源（不重复写死 host）', () => {
    expect(MARVIS.baseUrl).toBe('https://yybadaccess.3g.qq.com')
    expect(MARVIS.chatPath).toBe('/v1/chat/completions')
    expect(MARVIS.balancePath).toBe('/v3/marvis_get_wallet')
    expect(MARVIS.refreshPath).toBe('/marvis_client_login/marvis_refresh_token')
  })

  it('findMarvisFallback 能按 id 找到唯一一条', () => {
    expect(findMarvisFallback('deepseek-v4-pro-external')?.name).toBe('DeepSeek V4.1 Flash')
    expect(findMarvisFallback('nope')).toBeUndefined()
  })
})

describe('normalizeMarvisModelId', () => {
  it('去空白', () => {
    expect(normalizeMarvisModelId('  deepseek-v4-pro-external ')).toBe('deepseek-v4-pro-external')
  })

  it('旧持久化下标 "0" 归一成 deepseek-v4-pro-external（magpie 曾把数组下标写进配置）', () => {
    expect(normalizeMarvisModelId('0')).toBe('deepseek-v4-pro-external')
  })

  it('真实模型 id 归一成槽位（响应体 model 字段被用户粘进配置过）', () => {
    expect(normalizeMarvisModelId('deepseek-v4-1-flash-261017')).toBe('deepseek-v4-pro-external')
  })

  it('未知 id 原样保留（交给上游判 400，而不是静默替换）', () => {
    expect(normalizeMarvisModelId('some-future-slot')).toBe('some-future-slot')
  })
})
