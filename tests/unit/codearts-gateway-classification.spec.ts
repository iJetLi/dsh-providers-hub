/**
 * CodeArts 的**三个「非凭据问题」业务码**分类（2026-11-05，Gitee PR #175 评审 + UA 修复的兜底）。
 *
 * ## 为什么这个文件存在
 *
 * 用户报障「API 密钥无效」的真实成因是**华为 WAF 按 UA 拒发**（`TM.00000001`，
 * 已由 `CODEARTS_USER_AGENT` 修掉，见 `tests/unit/codearts-user-agent.spec.ts`）。
 * 但**同一句假原因**还有两条同类链路没被覆盖：
 *
 * 1. `TM.00001041`（账号级并发上限）在上游会以 **400 与 403 两种状态**下发，
 *    而 `isQueueError` 把状态绑死 `400` ⇒ 403 形态落 `httpErrorCode` 的
 *    `401/403 → AUTH` ⇒ 客户端整条替换成「API 密钥无效」；
 * 2. `TM.000010051`（模型未在本租户开通）原本落通用 `INVALID_REQUEST`，
 *    文案里看不出「该换模型」。
 *
 * ⇒ 三条都必须：**① `isAuthError` 排除**（不白跑一次性轮换的 STS 续期）、
 * **② 抛错出口单列**（专用文案 + 专用码）。
 *
 * ## 三条的码**必须不同**（本文件逐条钉住）
 *
 * | 码 | 重试有效？ | 宿主码 |
 * |---|---|---|
 * | `TM.00000001` | **否**（同 UA 恒 403） | `PERMISSION`（不可重试） |
 * | `TM.00001041` | **是**（等 1~2 分钟） | `RATE_LIMIT`（可重试） |
 * | `TM.000010051` | **否** | `PERMISSION` |
 *
 * ⚠️ 把 `TM.00000001` 归 `RATE_LIMIT` 是错的：宿主 `DEFAULT_RETRYABLE_CODES`
 * 含 `RATE_LIMIT`（`maxRetries 5`）⇒ 确定性失败白退避重试 5 次，每次打一次 403。
 *
 * ## 边界（业务码是**数字后缀**，必须断开）
 *
 * 本仓库踩过 `429` 命中 `InferHub.4291.200` 的坑 ⇒ `TM.00000001` 不得命中
 * `TM.000000011`。本文件含该边界用例。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import {
  CodeArtsAdapter,
  isConcurrencyLimitError,
  isGatewayBusyError,
  isTenantNotEnabledError,
} from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

const CREDENTIAL_REF = credentialRef('CODEARTS_ACCESS_TOKEN')

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** 上游报文（逐字取自真实响应；`logid` 已脱敏）。 */
const GATEWAY_BUSY_BODY = '{"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试","logid":"20261104…"}'
const CONCURRENCY_BODY = '{"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)，请关闭部分会话后重试。","logid":"20261104…"}'
const TENANT_BODY = '{"error_code":"TM.000010051","error_msg":"model is not enabled for this tenant","logid":"20261104…"}'
/** 反向对照：真实凭据失效（必须仍走 AUTH + 续期）。 */
const INVALID_TOKEN_BODY = '{"error_code":"APIG.0602","error_msg":"Invalid token"}'

interface Outcome {
  error?: LlmError
  chatCalls: number
  refreshCalls: number
}

/**
 * 跑一次 `stream()`：chat 恒回 `status + body`，排队探测回 `working`。
 *
 * ⚠️ `working` 是关键：三条 403 都必须走「探测说没排队 ⇒ 落抛错出口」那条路径，
 * 否则本文件测的就不是生产路径（探测结果变 waiting 会进 30 分钟排队循环）。
 */
async function runStream(options: {
  status: number
  body: string
  /** 让第 N 次（从 1 起）chat 返回 200 SSE（用于「400 自愈路径不得退化」那条）。 */
  okOnChatCall?: number
}): Promise<Outcome> {
  let chatCalls = 0
  let refreshCalls = 0
  const adapter = new CodeArtsAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => validCredential,
    refresh: async () => { refreshCalls += 1 },
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.includes('/queue/status')) {
        return new Response(JSON.stringify({ status: 'working' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      chatCalls += 1
      if (options.okOnChatCall !== undefined && chatCalls >= options.okOnChatCall) {
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response(options.body, {
        status: options.status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const outcome: Outcome = { chatCalls: 0, refreshCalls: 0 }
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of adapter.stream({
      model: 'GLM-5.3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) { /* 读完即可 */ }
  } catch (caught) {
    outcome.error = caught as LlmError
  }
  outcome.chatCalls = chatCalls
  outcome.refreshCalls = refreshCalls
  return outcome
}

describe('判据本身（精确业务码 + 数字边界）', () => {
  it('三个码各自命中自己的报文', () => {
    expect(isGatewayBusyError(GATEWAY_BUSY_BODY)).toBe(true)
    expect(isConcurrencyLimitError(CONCURRENCY_BODY)).toBe(true)
    expect(isTenantNotEnabledError(TENANT_BODY)).toBe(true)
  })

  it('互不串味（三条处置完全不同）', () => {
    expect(isGatewayBusyError(CONCURRENCY_BODY)).toBe(false)
    expect(isConcurrencyLimitError(GATEWAY_BUSY_BODY)).toBe(false)
    expect(isTenantNotEnabledError(CONCURRENCY_BODY)).toBe(false)
    expect(isGatewayBusyError(TENANT_BODY)).toBe(false)
  })

  // ⚠️ 本仓库踩过 `429` 命中 `InferHub.4291.200` 的坑：业务码是数字后缀，必须断开。
  it('数字后缀必须断开：TM.000000011 不得命中 TM.00000001', () => {
    expect(isGatewayBusyError('{"error_code":"TM.000000011"}')).toBe(false)
    expect(isConcurrencyLimitError('{"error_code":"TM.000010410"}')).toBe(false)
    expect(isTenantNotEnabledError('{"error_code":"TM.0000100510"}')).toBe(false)
    // 正向：真正的码仍命中（防止「全 false」的假绿）
    expect(isGatewayBusyError('{"error_code":"TM.00000001"}')).toBe(true)
  })

  it('大小写敏感（上游恒为大写 TM.）', () => {
    expect(isGatewayBusyError('{"error_code":"tm.00000001"}')).toBe(false)
  })

  it('空串 / 非字符串恒 false（不抛错）', () => {
    for (const value of ['', undefined as unknown as string, null as unknown as string]) {
      expect(isGatewayBusyError(value)).toBe(false)
      expect(isConcurrencyLimitError(value)).toBe(false)
      expect(isTenantNotEnabledError(value)).toBe(false)
    }
  })
})

describe('★ 抛错出口：三条都必须单列专用文案与专用码', () => {
  it('403 + TM.00000001 ⇒ PERMISSION（不可重试）+ 说明「不是凭据问题 / 重试无效」', async () => {
    const result = await runStream({ status: 403, body: GATEWAY_BUSY_BODY })
    expect(result.error).toBeInstanceOf(LlmError)
    // ⚠️ 绝不能是 AUTH（客户端会整条替换成「API 密钥无效」）
    expect(result.error!.code).toBe('PERMISSION')
    expect(result.error!.message).toContain('TM.00000001')
    expect(result.error!.message).toContain('不是凭据问题')
    expect(result.error!.message).toContain('重试也无效')
    // 确定性失败：不续期、也不重发
    expect(result.refreshCalls).toBe(0)
    expect(result.chatCalls).toBe(1)
  })

  it('403 + TM.00001041 ⇒ RATE_LIMIT（可重试）+ 并发上限文案', async () => {
    const result = await runStream({ status: 403, body: CONCURRENCY_BODY })
    expect(result.error!.code).toBe('RATE_LIMIT')
    expect(result.error!.message).toContain('TM.00001041')
    expect(result.error!.message).toContain('并发上限')
    expect(result.error!.message).toContain('3 个请求')
    expect(result.error!.message).toContain('不是凭据问题')
    expect(result.refreshCalls).toBe(0)
  })

  it('403 + TM.000010051 ⇒ PERMISSION + 「未在本租户开通」', async () => {
    const result = await runStream({ status: 403, body: TENANT_BODY })
    expect(result.error!.code).toBe('PERMISSION')
    expect(result.error!.message).toContain('TM.000010051')
    expect(result.error!.message).toContain('租户')
    expect(result.refreshCalls).toBe(0)
  })

  // ⚠️ 反向对照：判据不能放宽成「凡 403 都不续期」—— 真凭据失效必须仍走 AUTH + 续期。
  it('★ 对照组：403 + APIG.0602（真凭据失效）仍归 AUTH 且续期一次', async () => {
    const result = await runStream({ status: 403, body: INVALID_TOKEN_BODY })
    expect(result.error).toBeInstanceOf(LlmError)
    expect(result.error!.code).toBe('AUTH')
    expect(result.refreshCalls).toBe(1)
  })

  // ⚠️ 边界：多一位数字的「码」不得改变分类（否则会命中别的业务码）。
  it('★ 边界对照：TM.000000011 不命中 ⇒ 落回 AUTH（保留原分类链）', async () => {
    const result = await runStream({ status: 403, body: '{"error_code":"TM.000000011"}' })
    expect(result.error!.code).toBe('AUTH')
    expect(result.refreshCalls).toBe(1)
  })
})

/**
 * ## 边界：**400 形态的排队自愈不得退化**
 *
 * `TM.00001041` 在 **400** 形态下必须继续走 {@link isQueueError} 的排队重试
 * （本仓库既有 4 条用例锁着这条自愈能力）—— 本次只在 **403** 出口加分类，
 * 新分支全部位于 `if (!isQueueError(...))` **之内**。
 *
 * ⚠️ 这里**刻意不重复**写一条「400 + TM.00001041 自动重试成功」的用例：
 * `tests/unit/llm-adapter.spec.ts` 的
 * `retries the chat request after a queue error even when the queue status is working`
 * 已经逐字锁住它（且要真等 10s 的 `QUEUE_RETRY_DELAY_MS`）。重复一份只会让
 * 全量测试白慢 10 秒，而守卫强度不变 —— 那正是本仓库反复登记的「同义反复」。
 */
