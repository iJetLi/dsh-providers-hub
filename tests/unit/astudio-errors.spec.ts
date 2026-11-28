/**
 * astudio-errors.spec.ts —— AStudio（讯飞 AstronStudio）错误码判定纯函数单测【草案】
 *
 * drop-in 位置：tests/unit/astudio-errors.spec.ts（本草案不写进 worktree，由后续意图原样落盘）
 * 被测源码：src/astudio.ts（纯函数层，`classifyAstudioError` / `astudioStreamErrorCode` /
 *            `astudioAuthRetryPlan` / `parseAstudioEnvelope` 等）+ src/astudio-product.ts（终态码集）
 *
 * ── 写法 ────────────────────────────────────────────────────────────────
 * 对齐同族 tests/unit/accio-auth.spec.ts 的**双写法**：
 *   ①「源码级契约正则守卫」—— 用 tests/helpers/source-scope.js 的 **AST 括号匹配**取函数体，
 *      绝不用 `indexOf('\n}\n')` 之类字符串切片（本仓 core.autocrlf=true，工作区是 CRLF，
 *      字符串切片要么切到文件尾、要么截一小截，见 source-scope.ts 顶部说明与 issue IKJMG1）；
 *   ②「行为用例」—— 直接调纯函数。
 * 全部用例**零网络、零真实凭据**（判定的输入都是 fact 377/380/402/403 实测抓到的报文形态字面量）。
 *
 * ── 依赖 fact 478 的改动才生效的期望 ───────────────────────────────────
 * 【D1｜fact 478 ⑤】src/astudio-product.ts 的 `ASTUDIO_SESSION_DEAD_CODES`
 *   当前是 `Object.freeze(new Set([1002, 1005]))`，须加入 **80000**。
 *   本文件里标 `@depends-on D1` 的用例断言「HTTP 恒 200 + code=80000」在**不带任何中文文案**时
 *   也被判终态（不依赖服务端文案正则兜底）。未改前这些用例会红，属预期。
 *
 * ── tsconfig.tests.json ────────────────────────────────────────────────
 * 本 spec 默认**不在** tsconfig.tests.json 的 `include` 名单里（现有名单：`"src"` +
 * `tests/unit/jet-hub-rpc-signature.spec.ts` + `tests/unit/client-registration-id.spec.ts` +
 * `tests/unit/dsh-host-client.ts`）。若要让它进类型门禁（`pnpm typecheck:tests`），需在
 * `include` 数组里、紧跟 `"tests/unit/jet-hub-rpc-signature.spec.ts"` 之后补一行：
 *     "tests/unit/astudio-errors.spec.ts",
 * ⚠️ 本草案不实际改该文件（同 worktree 正被 #500 写入）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  astudioAuthRetryPlan,
  astudioFrameLooksLikeError,
  astudioOpenAiErrorFields,
  astudioStatusOf,
  astudioStreamErrorCode,
  astudioStreamErrorMessage,
  classifyAstudioError,
  isAstudioSessionDeadError,
  parseAstudioEnvelope,
} from '../../src/astudio.js'
// ⚠️ 源码切片必须走它（行尾无关 + AST 括号匹配），别自己 indexOf('\n  }\n')
import { sourceScope } from '../helpers/source-scope.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const src = readFileSync(join(SRC_DIR, 'astudio.ts'), 'utf8')
const scope = sourceScope(src, 'astudio.ts')

/** fact 377/380 实测的上游 502 报文形态（错误信封是 OpenAI 风格 `{error:{code,type,message}}`）。 */
const UPSTREAM_MODEL_NOT_FOUND = JSON.stringify({
  error: { code: 'model_not_found', type: 'upstream_error', message: 'The model `glm5.3flash` does not exist' },
})
const UPSTREAM_NO_VALID_AUTHORIZATION = JSON.stringify({
  error: { code: 'no_valid_authorization', type: 'upstream_error', message: 'no valid authorization for this account' },
})
/** fact 402/403 实测的账号后端失效形态：HTTP **恒 200** + 业务码 80000。 */
const SESSION_DEAD_ENVELOPE = { flag: true, code: 80000, desc: '登录异常，请重新登录', data: null }

// ════════════════════════════════════════════════════════════════════════
describe('★ astudio.ts 源码级契约', () => {
  it('⚠️ 401 与 403 必须同归 auth（Cookie/会话失效，不是「可重试的服务端错」）', () => {
    const body = scope.fn('classifyAstudioError')
    expect(body).toMatch(/status === 401 \|\| status === 403/)
    expect(body).toMatch(/describeAstudioError\('auth'/)
  })

  it('⚠️ 传输层/超时必须在读业务码之前判定，且不得被当成 401（否则会白撞一次远端重取）', () => {
    const body = scope.fn('classifyAstudioError')
    // 两个早退分支必须出现在 `status === 401` 之前
    const atTransport = body.indexOf('options.transport === true')
    const atTimeout = body.indexOf('options.timeout === true')
    const atAuth = body.indexOf('status === 401')
    expect(atTransport).toBeGreaterThan(-1)
    expect(atTimeout).toBeGreaterThan(-1)
    expect(atAuth).toBeGreaterThan(-1)
    expect(atTransport).toBeLessThan(atAuth)
    expect(atTimeout).toBeLessThan(atAuth)
  })

  it('⚠️ astudioStatusOf 无 HTTP 状态时必须返 0（fact 478：故意不返 401）', () => {
    // 反向守卫：整个函数里不许出现「默认返 401」这种写法
    const body = scope.fn('astudioStatusOf')
    expect(body).not.toMatch(/return 401/)
    expect(body).toMatch(/\?\s*0\b|:\s*0\b/)
  })

  it('⚠️ 线级错误码表必须覆盖 model_not_found / quota / context，否则 502 会被降级成可重试的 SERVER', () => {
    const at = src.search(/const ASTUDIO_WIRE_CODES/)
    expect(at).toBeGreaterThan(-1)
    /**
     * ⚠️⚠️ **不能用固定窗口**（原来是 `slice(at, at + 900)`）。
     *
     * 2026-11-28 实测：往表里加两条 `API_KEY_DISABLED`（含注释）后，
     * `insufficient_quota` 被挤出 900 字符窗口 ⇒ **用例变红，而表其实完好**
     * —— 这是「假红」，和本仓在 zcode bundle 里用 9000 字符窗口搜到 `-1`
     * 就断言「官方删了那段」是**同一个形状的错**。
     *
     * ⇒ 改为**按表的真实边界**取：从声明处到配对的 `])`。
     */
    const close = src.indexOf('])', at)
    expect(close, '表必须有闭合的 ])').toBeGreaterThan(at)
    const table = src.slice(at, close + 2)
    for (const code of ['model_not_found', 'insufficient_quota', 'context_length_exceeded', 'invalid_api_key']) {
      expect(table).toContain(`['${code}'`)
    }
  })

  it('⚠️ model-not-found 必须落 PERMISSION_DENIED（不可重试），不得落 SERVER', () => {
    const body = scope.fn('describeAstudioError')
    expect(body).toMatch(/case 'model-not-found'[\s\S]{0,400}llmCode: 'PERMISSION_DENIED'/)
  })

  it('⚠️ 终态码集必须被引用（终态判定不得只靠文案正则兜底）', () => {
    const dead = scope.fn('isAstudioSessionDeadError')
    expect(dead).toMatch(/ASTUDIO_SESSION_DEAD_CODES\.has\(code\)/)
    expect(src).toMatch(/ASTUDIO_SESSION_DEAD_CODES\.has\(rawCode\)/) // parseAstudioEnvelope 也要用它
  })

  it('⚠️ 重取计划必须是「401 才动、失败或已试过就终态」，禁止任何循环', () => {
    const body = scope.fn('astudioAuthRetryPlan')
    expect(body).toMatch(/params\.status !== 401\) return 'none'/)
    expect(body).toMatch(/refreshFailed[\s\S]{0,40}'terminal'/)
    expect(body).toMatch(/attemptedRefresh[\s\S]{0,40}'terminal'/)
    expect(body).not.toMatch(/while|for \(/)
  })

  /**
   * 【D1｜fact 478 ⑤】终态码集当前只有 {1002, 1005}，80000 不在其中 ——
   * 后果：账号后端「HTTP 200 + code=80000」是否判终态完全依赖服务端中文文案正则，
   * 文案一改就退化成可重试（每 30 分钟白撞一次，正是 fact 401 挂点约束要避免的）。
   */
  it('⚠️ ASTUDIO_SESSION_DEAD_CODES 必须含 80000（fact 402 实测的失效形态）', () => {
    const product = readFileSync(join(SRC_DIR, 'astudio-product.ts'), 'utf8')
    const setLine = product.slice(product.indexOf('ASTUDIO_SESSION_DEAD_CODES'))
    expect(setLine.slice(0, 200)).toMatch(/80000/)
    expect(setLine.slice(0, 200)).toMatch(/1002/)
    expect(setLine.slice(0, 200)).toMatch(/1005/)
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('classifyAstudioError —— HTTP 状态 / 上游错误码 → {kind,llmCode,message}', () => {
  it('上游 HTTP 502 + error.code=model_not_found（glm5.3flash 不存在的实测形态）→ PERMISSION_DENIED 且不可重试', () => {
    const info = classifyAstudioError(502, UPSTREAM_MODEL_NOT_FOUND)
    expect(info.kind).toBe('model-not-found')
    expect(info.llmCode).toBe('PERMISSION_DENIED')
    expect(info.message).toMatch(/HTTP 502/)
    expect(info.message).toMatch(/does not exist/) // 上游 detail 必须透出，便于定位
  })

  it('⚠️ error.code=no_valid_authorization（账号订单缺失）→ PERMISSION_DENIED，**不能**落到 auth/SERVER', () => {
    // 2026-11-17 真机：`xdeepseek-flash-in` 非流式回 **HTTP 403**
    // `{"code":"no_valid_authorization","message":"no valid authorization: the account lacks
    // an active order, has insufficient quota, or the order is invalid","type":"permission_error"}`。
    //
    // ⚠️ 这条用例曾经**如实钉住旧现状**（「线表无此码 ⇒ 落 SERVER」），现在钉的是新裁决：
    // 归 `PERMISSION_DENIED` 是因为 ①`AUTH` 会让客户端把 message 换成「API 密钥无效」
    // （唯一能指路的「订单缺失」原文消失 ⇒ 用户去反复重登）②`SERVER` 会被白重试 5 次。
    // 同一份报文在流式侧（HTTP 200 + 单帧 `response.failed`）原本归 `SERVER` ⇒
    // **一条报文两条裁决**本身是缺陷，两侧现在一致。
    const info = classifyAstudioError(403, UPSTREAM_NO_VALID_AUTHORIZATION)
    expect(info.kind).toBe('permission-denied')
    expect(info.llmCode).toBe('PERMISSION_DENIED')
    expect(info.message).toMatch(/no valid authorization/) // 上游原文必须透出
    // 状态码不再是判据的主导（线级码优先）：502 也归同一类，不因 5xx 就退成可重试的 SERVER。
    expect(classifyAstudioError(502, UPSTREAM_NO_VALID_AUTHORIZATION).llmCode).toBe('PERMISSION_DENIED')
    // `type: 'permission_error'` 单独出现时也认得（同一问题的另一种信封）。
    const byType = classifyAstudioError(403, '{"error":{"type":"permission_error","message":"no order"}}')
    expect(byType.llmCode).toBe('PERMISSION_DENIED')
  })

  it('HTTP 401 → AUTH（并给出「需重新登录 AStudio」语义，绝不能是可重试码）', () => {
    const info = classifyAstudioError(401, '{"error":{"message":"invalid_api_key"}}')
    expect(info.kind).toBe('auth')
    expect(info.llmCode).toBe('AUTH')
  })

  it('HTTP 403 → 同样归 auth（Cookie/会话侧失效，与 401 同处置）', () => {
    expect(classifyAstudioError(403, '').kind).toBe('auth')
    expect(classifyAstudioError(403, '').llmCode).toBe('AUTH')
  })

  it('HTTP 429 → RATE_LIMITED；HTTP 402 → QUOTA_EXCEEDED（两者不同源，别合并）', () => {
    expect(classifyAstudioError(429, '{"error":{"message":"slow down"}}').kind).toBe('rate-limit')
    expect(classifyAstudioError(429, '{}').llmCode).toBe('RATE_LIMITED')
    expect(classifyAstudioError(402, '{}').kind).toBe('quota')
    expect(classifyAstudioError(402, '{}').llmCode).toBe('QUOTA_EXCEEDED')
  })

  it('线级码优先于状态码：HTTP 200 + error.code=context_length_exceeded 仍归 context-window', () => {
    const body = '{"error":{"code":"context_length_exceeded","message":"too long"}}'
    const info = classifyAstudioError(200, body)
    expect(info.kind).toBe('context-window')
    expect(info.llmCode).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('⚠️ error.type 也查线表（上游有时只在 type 里给语义码）', () => {
    const info = classifyAstudioError(400, '{"error":{"code":"bad_request","type":"rate_limit_exceeded","message":"m"}}')
    expect(info.kind).toBe('rate-limit')
  })

  it('HTTP 200 但业务信封 code≠0：classify 侧不解析信封（必须靠 parseAstudioEnvelope，见下一组）', () => {
    // 如实记录分工：classifyAstudioError 只认 `{error:{...}}` OpenAI 信封；
    // `{flag,code,desc}` 业务信封里没有 error 字段 ⇒ 落到 unknown→SERVER。
    // ⇒ 落盘 adapter 时「HTTP 200 + code≠0 判失败」**不能**指望 classifyAstudioError。
    const info = classifyAstudioError(200, JSON.stringify(SESSION_DEAD_ENVELOPE))
    expect(info.kind).toBe('unknown')
    expect(info.llmCode).toBe('SERVER')
    expect(info.message).toMatch(/HTTP 200/)
  })

  it('options.transport / options.timeout 最先短路（NETWORK / TIMEOUT）', () => {
    expect(classifyAstudioError(0, 'socket hang up', { transport: true }).llmCode).toBe('NETWORK')
    expect(classifyAstudioError(0, 'socket hang up', { transport: true }).kind).toBe('transport')
    expect(classifyAstudioError(200, '', { timeout: true }).llmCode).toBe('TIMEOUT')
    expect(classifyAstudioError(200, '', { timeout: true }).kind).toBe('timeout')
    // transport 优先于 timeout
    expect(classifyAstudioError(500, 'x', { transport: true, timeout: true }).kind).toBe('transport')
  })

  it('非法/非 JSON body 不得抛异常（只降级成 detail）', () => {
    expect(classifyAstudioError(500, '<html>502 Bad Gateway</html>').kind).toBe('server')
    expect(classifyAstudioError(404, '   ').llmCode).toBe('INVALID_REQUEST')
    expect(classifyAstudioError(418, '{"error":{"code":123,"message":""}}').kind).toBe('unknown')
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('parseAstudioEnvelope —— HTTP 200 + 业务码（fact 383/414 定案：code≠0 即失败）', () => {
  it('code=0 + data 对象 → ok，data 原样', () => {
    const r = parseAstudioEnvelope({ code: 0, data: { models: [{ id: 'xopglm52' }] } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.data)).toContain('models')
  })

  it('⚠️ code=0 + data **数组**（bot/models/configs 的真实形态）→ ok 且数组在 rows，data 是 {}', () => {
    // fact 414 修掉的真缺陷：旧实现「data 必须是对象，数组即失败」会让 401→重取这条
    // **唯一**的凭据自愈链恒失败（不报错、症状是「凭据刷不动」）。
    const r = parseAstudioEnvelope({
      flag: true, code: 0, desc: '成功', count: null,
      data: [{ id: 'lm_auto', model: 'astronclaw-auto', api_key: 'K', is_default: true, is_current: false }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Array.isArray(r.rows)).toBe(true)
      expect(r.rows).toHaveLength(1)
      expect(Object.keys(r.data)).toHaveLength(0)
    }
  })

  it('code≠0 → ok:false 且带上码与 desc/message 文案', () => {
    const r = parseAstudioEnvelope({ flag: false, code: 1002, desc: '登录已过期', data: null })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe(1002)
      expect(r.message).toContain('登录已过期')
      expect(r.sessionDead).toBe(true)
    }
  })

  it('【D1】code=80000 且**无文案**也必须判终态（不得依赖 desc 字面量）', () => {
    const r = parseAstudioEnvelope({ flag: false, code: 80000, desc: '', data: null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.sessionDead).toBe(true)
  })

  it('code 用字符串下发也要认（上游字段类型不严谨，fact 403 同族形态）', () => {
    const r = parseAstudioEnvelope({ code: '1005', data: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe(1005); expect(r.sessionDead).toBe(true) }
  })

  it('code=0 但 data 缺失/空数组/标量 → 判失败且 sessionDead（等价「账号视图里没有任何 api_key」）', () => {
    for (const body of [{ code: 0, data: null }, { code: 0 }, { code: 0, data: [] }, { code: 0, data: 'x' }]) {
      const r = parseAstudioEnvelope(body)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.sessionDead).toBe(true)
    }
  })

  it('非对象（数组/标量/null）body → code=-1 且不判终态（不要把形态问题当会话失效）', () => {
    for (const body of [[], 'text', 42, null, undefined]) {
      const r = parseAstudioEnvelope(body)
      expect(r.ok).toBe(false)
      if (!r.ok) { expect(r.code).toBe(-1); expect(r.sessionDead).toBe(false) }
    }
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('isAstudioSessionDeadError —— 终态判据（码集优先，文案正则只兜底）', () => {
  it('1002 / 1005 直接命中码集', () => {
    expect(isAstudioSessionDeadError(1002, '')).toBe(true)
    expect(isAstudioSessionDeadError(1005, '')).toBe(true)
  })

  it('【D1】80000 命中码集（fact 402：账号后端失效恒用这个码）', () => {
    expect(isAstudioSessionDeadError(80000, '')).toBe(true)
  })

  it('码不在集里时文案兜底仍生效；两者都不命中则不是终态', () => {
    expect(isAstudioSessionDeadError(500, '请重新登录')).toBe(true)
    expect(isAstudioSessionDeadError(500, 'login required')).toBe(true)
    expect(isAstudioSessionDeadError(500, 'upstream busy')).toBe(false)
    expect(isAstudioSessionDeadError(0, '')).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('astudioStreamErrorCode / astudioFrameLooksLikeError / astudioStreamErrorMessage', () => {
  it('流内 error 帧一律判失败，非数字 code 归 -1（**不得**当成 0=成功）', () => {
    expect(astudioStreamErrorCode({ error: { code: 'model_not_found', message: 'm' } })).toBe(-1)
    expect(astudioStreamErrorCode({ error: 'boom' })).toBe(-1)
    expect(astudioStreamErrorCode({ error: {} })).toBe(-1)
    expect(astudioFrameLooksLikeError({ error: { code: 0, message: 'm' } })).toBe(true)
  })

  it('流内业务码 code≠0 → 返回该码（HTTP 200 + 流内 code≠0 也是失败）', () => {
    expect(astudioStreamErrorCode({ code: 1002, message: '过期' })).toBe(1002)
    expect(astudioStreamErrorCode({ code: 80000, desc: '登录异常' })).toBe(80000)
    expect(astudioStreamErrorCode({ code: '1005' })).toBe(1005)
    expect(astudioFrameLooksLikeError({ code: 80000 })).toBe(true)
  })

  it('正常 chunk / code=0 / 非对象 → undefined（不是错误帧）', () => {
    expect(astudioStreamErrorCode({ id: 'chatcmpl-1', choices: [{ delta: { content: '你好' } }] })).toBeUndefined()
    expect(astudioStreamErrorCode({ code: 0, data: {} })).toBeUndefined()
    expect(astudioStreamErrorCode({ error: null })).toBeUndefined()
    for (const f of [null, undefined, 'x', 42, []]) expect(astudioStreamErrorCode(f)).toBeUndefined()
  })

  it('message：error 对象里 code/type/message 拼接，type 与 code 同值时不重复', () => {
    expect(astudioStreamErrorMessage({ error: { code: 'x1', type: 'upstream_error', message: 'boom' } })).toBe('x1 / upstream_error / boom')
    expect(astudioStreamErrorMessage({ error: { code: 'x1', type: 'x1', message: 'boom' } })).toBe('x1 / boom')
    expect(astudioStreamErrorMessage({ code: 80000, desc: '登录异常，请重新登录' })).toBe('登录异常，请重新登录')
    expect(astudioStreamErrorMessage({})).toMatch(/\{/) // 退化成 JSON 片段，不能是空串
  })

  it('astudioOpenAiErrorFields：只有真正的 OpenAI error 信封才解析', () => {
    expect(astudioOpenAiErrorFields(UPSTREAM_MODEL_NOT_FOUND)).toMatchObject({ code: 'model_not_found', type: 'upstream_error' })
    expect(astudioOpenAiErrorFields('')).toBeUndefined()
    expect(astudioOpenAiErrorFields('not json')).toBeUndefined()
    expect(astudioOpenAiErrorFields('{"code":80000}')).toBeUndefined()
    expect(astudioOpenAiErrorFields('{"error":"str"}')).toBeUndefined()
    expect(astudioOpenAiErrorFields('{"error":{"code":429}}')).toMatchObject({ code: '429' })
  })
})

// ════════════════════════════════════════════════════════════════════════
describe('astudioAuthRetryPlan —— 401 重取一次（四格全覆盖，禁止循环重试）', () => {
  it('非 401 → none（不重取，哪怕从未试过）', () => {
    expect(astudioAuthRetryPlan({ status: 200, attemptedRefresh: false, refreshFailed: false })).toBe('none')
    expect(astudioAuthRetryPlan({ status: 502, attemptedRefresh: false, refreshFailed: false })).toBe('none')
    // 断网/无 HTTP 状态时 astudioStatusOf 给 0 ⇒ 不会被误判成凭据失效而白撞远端重取
    expect(astudioStatusOf(new Error('socket hang up'))).toBe(0)
    expect(astudioAuthRetryPlan({ status: astudioStatusOf(new Error('x')), attemptedRefresh: false, refreshFailed: false })).toBe('none')
  })

  it('401 + 未试过 + 刷新没失败 → refresh-and-retry（唯一允许重取的那格）', () => {
    expect(astudioAuthRetryPlan({ status: 401, attemptedRefresh: false, refreshFailed: false })).toBe('refresh-and-retry')
  })

  it('401 + 已试过（哪怕这次刷新成功）→ terminal（第二次 401 不再重取）', () => {
    expect(astudioAuthRetryPlan({ status: 401, attemptedRefresh: true, refreshFailed: false })).toBe('terminal')
  })

  it('401 + 刷新失败 → terminal（refreshFailed 优先于 attemptedRefresh）', () => {
    expect(astudioAuthRetryPlan({ status: 401, attemptedRefresh: false, refreshFailed: true })).toBe('terminal')
    expect(astudioAuthRetryPlan({ status: 401, attemptedRefresh: true, refreshFailed: true })).toBe('terminal')
  })

  it('astudioStatusOf 取状态的两种载体 + 优先级', () => {
    expect(astudioStatusOf({ status: 401 })).toBe(401)
    expect(astudioStatusOf({ failure: { status: 502 } })).toBe(502)
    expect(astudioStatusOf({ status: 401, failure: { status: 502 } })).toBe(502)
    expect(astudioStatusOf({ status: '401' })).toBe(0) // 字符串不算状态（只认 number）
    expect(astudioStatusOf(undefined)).toBe(0)
  })
})
