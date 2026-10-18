import { describe, expect, it } from 'vitest'
import {
  NON_CREDENTIAL_DENIAL_MARKERS,
  httpErrorCode,
  isNonCredentialDenial,
} from '../../src/openai-compat.js'

/**
 * 「非凭据 401/403」共用判据的回归测试。
 *
 * ## 为什么这个判据值得单独锁住
 *
 * harness 客户端只拦截改写 5 个错误码，`AUTH` 是其中之一：`failureMessage()`
 * 把消息换成「API 密钥无效」，`displayFailure()` 更是直接返回
 * `{ code, message: '' }`，**连原文都清空**。所以地域封锁一旦被归成 `AUTH`，
 * 用户看到的就是「API 密钥无效」→ 去重新登录；而真实原因是「这个模型在你所在
 * 地区未开通」，重新登录一万次也不会好。
 *
 * 判据最初只长在 cline 一家（`CLINE_REGION_FORBIDDEN_MARKERS`），于是其余
 * 8 个适配器全都保留着同一个洞，本次才提取成共用实现。
 *
 * ## 这次改动为什么不会吞掉需要重试的故障
 *
 * `PERMISSION_DENIED` 与 `AUTH` **都不在** harness 的
 * `DEFAULT_RETRYABLE_CODES`（`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT,
 * TRANSPORT]`）里，所以改判只影响「文案是否被替换、原文是否可见」，
 * 不改变重试次数。真正的限流/服务端故障仍按原样归 `RATE_LIMIT` / `SERVER`。
 */
describe('非凭据 401/403 判据', () => {
  // 真实缺陷回归（用户报障 2026-09-25）：Cline 这条 403 原样透出，
  // 被判成 AUTH 后 UI 只显示「API 密钥无效」，用户去重新登录 —— 而当时
  // 凭据全部有效，白跑了一次续期，真实原因一个字都没露出来。
  const CLINE_REGION_BODY =
    '{"error":"access forbidden: cline-free/muse-spark-1.3-contributor is not available in your region","success":false}'

  it('地域封锁的 403 归 PERMISSION_DENIED，不再报「API 密钥无效」', () => {
    expect(httpErrorCode(403, CLINE_REGION_BODY)).toBe('PERMISSION_DENIED')
  })

  it('地域文案大小写不敏感', () => {
    expect(httpErrorCode(403, 'Not Available In Your Region')).toBe('PERMISSION_DENIED')
  })

  it('「国家不支持」「地区不支持」几种地域措辞都命中', () => {
    expect(httpErrorCode(403, 'this model is not available in your country')).toBe('PERMISSION_DENIED')
    expect(httpErrorCode(403, '{"error":"region not supported"}')).toBe('PERMISSION_DENIED')
  })

  // 2026-10-14 收窄（IKLBSH 上游回复 `1080923`）：裸 `access forbidden` 撤出标记表。
  // 它唯一的实证出处（上面那条 Cline 2026-09-25）里与地域措辞**同时**出现 ⇒
  // 没有独立证据；而裸 `403 access forbidden` 在别处常是真实的权限/凭据故障。
  // 按「判错方向的代价不对称」，宁可不判 —— 该实测体仍由地域措辞命中（上一条）。
  it('裸 `access forbidden` 不再算地域封锁（判据已收窄）', () => {
    expect(isNonCredentialDenial(401, 'access forbidden')).toBe(false)
    expect(httpErrorCode(403, '{"error":"access forbidden"}')).toBe('AUTH')
  })

  // 真实缺陷回归（2026-10-03 全量模型普查）：`cline/cline-pass/qwen3.7-plus`
  // 返回 403「the user is not subscribed to required model plan」——凭据完全正常，
  // 只是该账号没有这个模型所需的套餐。当时它被归成 AUTH，UI 于是又显示
  // 「API 密钥无效」，与本判据最初要修的那个毛病一模一样。
  it('账号未订阅该模型套餐的 403 归 PERMISSION_DENIED', () => {
    expect(httpErrorCode(403, '{"error":"Error 403: the user is not subscribed to required model plan"}'))
      .toBe('PERMISSION_DENIED')
    expect(isNonCredentialDenial(403, 'NOT SUBSCRIBED TO REQUIRED MODEL PLAN')).toBe(true)
  })

  // 反向：裸「subscribed」不足以判定，必须命中整句。
  // 判错方向的代价不对称 —— 把真凭据问题说成「与凭据无关」，用户就永远
  // 等不到「请重新登录」。
  it('只出现 subscribed 字样不足以判成非凭据问题', () => {
    expect(httpErrorCode(403, '{"error":"subscription check failed: invalid token"}')).toBe('AUTH')
  })

  // 反向用例：修过头会把真凭据问题说成「换个模型试试」，用户彻底无路可走。
  it('真凭据问题的 401/403 仍然归 AUTH（不许修过头）', () => {
    expect(httpErrorCode(403, '{"error":{"code":"105","message":"auth_error"}}')).toBe('AUTH')
    expect(httpErrorCode(401, 'invalid token')).toBe('AUTH')
    expect(httpErrorCode(401, '{"error":"token expired"}')).toBe('AUTH')
    expect(httpErrorCode(403, 'Forbidden')).toBe('AUTH')
  })

  it('正文为空或非字符串时保守当作凭据问题', () => {
    expect(httpErrorCode(403, '')).toBe('AUTH')
    // 旧调用点没传正文时的运行时兜底（类型上 body 已是必传，这里是防回退）。
    expect(httpErrorCode(401, undefined as unknown as string)).toBe('AUTH')
  })

  // 判据只在 401/403 上生效：限流响应体里恰好出现同一句话时仍须是 RATE_LIMIT，
  // 否则会把「等一会儿就好」的限流变成「不可重试」的权限错误。
  it('非 401/403 状态码一律不受影响', () => {
    expect(httpErrorCode(429, 'access forbidden')).toBe('RATE_LIMIT')
    expect(httpErrorCode(400, 'not available in your region')).toBe('INVALID_REQUEST')
    expect(httpErrorCode(500, 'access forbidden')).toBe('SERVER')
    expect(httpErrorCode(402, 'access forbidden')).toBe('HTTP_402')
    expect(isNonCredentialDenial(429, 'access forbidden')).toBe(false)
    expect(isNonCredentialDenial(500, 'region not supported')).toBe(false)
  })

  it('其余状态码映射不变（防止顺手改坏既有语义）', () => {
    expect(httpErrorCode(200, '')).toBe('HTTP_200')
    expect(httpErrorCode(404, '')).toBe('HTTP_404')
    expect(httpErrorCode(503, '')).toBe('SERVER')
  })

  it('标记表保持小写，便于 includes 比对', () => {
    for (const marker of NON_CREDENTIAL_DENIAL_MARKERS) {
      expect(marker).toBe(marker.toLowerCase())
    }
  })
})
