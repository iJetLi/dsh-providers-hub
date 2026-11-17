import { LlmError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  CHAT_API_BASE,
  CodeArtsAdapter,
  isSseQueueErrorCode,
  isSseQuotaExhaustedErrorCode,
} from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

/**
 * 「**同一个 provider 内部**某账号积分用完后必须换到下一个账号」。
 *
 * ## 真实报障（2026-11-15，用户连报三遍）
 *
 * > 「一个账号的积分用完后竟然不会切换账号」
 *
 * 现场是 CodeArts 面板两个账号：`codearts-e6758a73`（积分 233.66）、
 * `codearts-acb57fd3`（积分 0，2/2 个资源包有效），都「已启用」，
 * 但请求全部打到同一个号上、从不切换。
 *
 * ## 根因（用真实凭据直连实测锁定，不是推断）
 *
 * 换号代码本身是**完整**的（`stream()` 里的 `SseQuotaExhaustedError` 分支与
 * 4xx 分支都会「写 `modelRateLimits` → `getAvailableAccount` → `continue`」），
 * 问题在**判据不认识真实的额度报文**：
 *
 * ```text
 * HTTP 400  content-type: application/json
 * {"error_code":"TM.00001050",
 *  "error_msg":"您的积分已耗尽，请关注活动积分领取活动或者[升级套餐](https://…)。"}
 * ```
 *
 * 而 `isSseQuotaExhaustedErrorCode` 只有两条腿 —— `code.includes('4291')`
 * 与 `/insufficient[\s_-]+quota/i`（那是 2026-10-02 从 **benefit 免费额度**
 * 通道取的证）—— 对这个码**零命中**。报文于是落进通用 4xx 分支直接抛出：
 * 既不写标记、也不取下一个号。
 *
 * 现场侧证：`~/.dsh/jet-hub/state.json` 里 codearts 两个账号**连
 * `modelRateLimits` 键都不存在**（不是空值，是键缺失）⇒ 从未落过任何标记；
 * 而同期 trae / raccoon 的账号都有标记，说明「别的渠道的换号是生效的」。
 *
 * ## ⚠️ 本文件守的两类事
 *
 * 1. **码值腿**：`TM.00001050` 命中、`TM.000010051`（「无权调用该模型」）
 *    **不**命中 —— 后者与前者**共享 9 字符词干 `TM.000010`** 后分叉
 *    （`50` vs `051`），且两者实测在**同一批请求**里同时出现（同一积分耗尽
 *    账号：`glm-5.2` 回 `1051`、`glm-5.3` 回 `1050`）。按词干匹配会把
 *    「无权限」判成「没钱」⇒ 对一个永远不会有积分的模型把整池账号轮一遍
 *    并全部沉底，比不换号更糟。
 * 2. **行为腿**：真实报文（两条通道：HTTP 400 与 SSE 200 首帧）都必须触发
 *    「写标记 + 换号 + 换号后成功出内容」。
 */

const CREDENTIAL_REF = credentialRef('CODEARTS_ACCESS_TOKEN')

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** adapter.stream() 的最小 GenerateOptions 形参。 */
const streamOptions = {
  model: 'glm-5.3',
  messages: [],
  signal: new AbortController().signal,
} as never

/** 实测原样报文（2026-11-15，真实凭据直连 `snap-access.cn-north-4.myhuaweicloud.com`）。 */
const REAL_CREDIT_EXHAUSTED_BODY = JSON.stringify({
  error_code: 'TM.00001050',
  error_msg: '您的积分已耗尽，请关注活动积分领取活动或者[升级套餐]'
    + '(https://console.huaweicloud.com/devcloud/?region=cn-north-4&locale=zh-cn'
    + '#/change-new/doer-credits-apply?package_type=codearts_doer_credits'
    + '&version=doer_individual_trial&resource_id=abc123)。',
})

/** 实测原样报文：同一账号请求 `glm-5.2` 时回这个（HTTP 200 + SSE 首帧）。 */
const REAL_TENANT_NOT_ENABLED_CODE = 'TM.000010051'

function makeAdapter(overrides: {
  fetchImpl: typeof fetch
  accountPool?: unknown
}) {
  const adapter = new CodeArtsAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => validCredential,
    refresh: async () => {},
    fetchImpl: overrides.fetchImpl,
    ...overrides.accountPool !== undefined ? { accountPool: overrides.accountPool as never } : {},
  })
  return adapter
}

/** 从出站请求的签名头里取 `Access=<AK>`，用于分辨「这次用的是哪个账号」。 */
function accessKeyOf(init?: RequestInit): string {
  const auth = new Headers(init?.headers).get('Authorization') ?? ''
  return /Access=([^,\s]+)/.exec(auth)?.[1] ?? ''
}

describe('判据：TM.00001050（账号积分耗尽）', () => {
  it('认这条码，且走数字边界——TM.000010051（无权调用）必须不命中', () => {
    // ① 码值腿：真实报文的 error_code 原样传入。
    expect(isSseQuotaExhaustedErrorCode('TM.00001050', '您的积分已耗尽')).toBe(true)
    // ② ⚠️ 真实 4xx 通道传的是 `errorDetailForClassify(body)` 拼出的分类文本，
    //    形态是「码 + 文案」两段拼一起 —— 码在**串中间**也必须认出。
    expect(isSseQuotaExhaustedErrorCode(
      'TM.00001050 您的积分已耗尽，请关注活动积分领取活动',
      REAL_CREDIT_EXHAUSTED_BODY,
    )).toBe(true)
    // ③ ⚠️⚠️ 词干陷阱：`TM.00001050` 与 `TM.000010051` **共享 9 字符词干
    //    `TM.000010`** 后分叉。这里若图省事匹配词干（或任何更短的前缀）
    //    就会判 true ⇒ 把「无权限」当「没钱」，对着一个永远不会有积分的模型
    //    把整池账号轮一遍并全部沉底。两个码实测在同一批请求里同时出现
    //    （同一账号 glm-5.2 回 1051、glm-5.3 回 1050），这一格是**真实可达**的。
    //
    //    ⚠️ 如实记录：两者**不是**严格前缀关系
    //    （`'TM.000010051'.includes('TM.00001050') === false`，第 10 位已分叉），
    //    所以真正的变异锚点是**词干**而非前缀 —— 这一点是变异测试纠正我的。
    expect(isSseQuotaExhaustedErrorCode(
      REAL_TENANT_NOT_ENABLED_CODE,
      '您当前无权调用该模型，请联系企业管理员开通。',
    )).toBe(false)
    expect(isSseQuotaExhaustedErrorCode(
      '',
      `{"error_code":"${REAL_TENANT_NOT_ENABLED_CODE}","error_msg":"您当前无权调用该模型"}`,
    )).toBe(false)
    // ④ 文案腿：万一上游改码值，中文文案仍能命中（共享正则）。
    expect(isSseQuotaExhaustedErrorCode('TM.99999999', '您的积分已耗尽')).toBe(true)
    // ⑤ 排队码不受影响（修额度不能把真排队一起修坏）。
    expect(isSseQuotaExhaustedErrorCode('TM.00001041', '账号并发上限')).toBe(false)
  })

  it('TM.00001050 不会被排队判据吃掉', () => {
    // 若它被 `isSseQueueErrorCode` 先接走，就会被当成「等一会儿就通」，
    // 而积分耗尽按自然日/套餐周期结算 —— 等多久都没用。
    expect(isSseQueueErrorCode('TM.00001050')).toBe(false)
    // 对照组：真排队码仍为 true。
    expect(isSseQueueErrorCode('TM.00001041')).toBe(true)
  })
})

describe('行为：积分耗尽必须换到下一个账号', () => {
  it('HTTP 400 + 真实积分耗尽报文 ⇒ 写标记并切到下一个账号，换号后成功出流', async () => {
    const marked: Array<{ accountId: string; modelId: string }> = []
    const pool = {
      findAccountIdByCredential: async () => 'codearts-acb57fd3',
      getAvailableAccount: async () => ({
        entry: { id: 'codearts-e6758a73' },
        credential: {
          access_key_id: 'AK2', secret_access_key: 'SK2', security_token: 'ST2',
          expires_at: '2099-01-01T00:00:00Z',
        },
      }),
      updateModelRateLimit: async (accountId: string, modelId: string) => {
        marked.push({ accountId, modelId })
      },
    }

    const chatKeys: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = accessKeyOf(init)
      if (String(input).startsWith(CHAT_API_BASE)) chatKeys.push(key)
      if (key === 'AK2') {
        return new Response(
          'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      // 第一个账号：真实积分耗尽报文（HTTP 400 + application/json）。
      return new Response(REAL_CREDIT_EXHAUSTED_BODY, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    })

    const adapter = makeAdapter({ fetchImpl, accountPool: pool })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }

    // ① 真的换了号（两个 AK 都发过请求，顺序为先失败的、后成功的）。
    expect(chatKeys).toEqual(['AK', 'AK2'])
    // ② 换号后正常出内容 —— 用户只要看到这个，就不会知道底下换过号。
    expect(texts).toEqual(['recovered'])
    // ③ 标记落在**失败的那个账号**上（不是被换上的那个）。
    expect(marked.map(entry => entry.accountId)).toEqual(['codearts-acb57fd3'])
    expect(marked[0]!.modelId).toBe('glm-5.3')
  })

  it('SSE 200 首帧内嵌 TM.00001050 ⇒ 同样换号（两条通道都要接）', async () => {
    const marked: string[] = []
    const pool = {
      findAccountIdByCredential: async () => 'codearts-acb57fd3',
      getAvailableAccount: async () => ({
        entry: { id: 'codearts-e6758a73' },
        credential: {
          access_key_id: 'AK2', secret_access_key: 'SK2', security_token: 'ST2',
          expires_at: '2099-01-01T00:00:00Z',
        },
      }),
      updateModelRateLimit: async (accountId: string) => { marked.push(accountId) },
    }

    const chatKeys: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = accessKeyOf(init)
      if (String(input).startsWith(CHAT_API_BASE)) chatKeys.push(key)
      if (key === 'AK2') {
        return new Response(
          'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      // SSE 形态：HTTP 200 + 首帧 error_code。
      return new Response(
        `data:{"error_code":"TM.00001050","error_msg":"您的积分已耗尽"}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })

    const adapter = makeAdapter({ fetchImpl, accountPool: pool })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }

    expect(chatKeys).toEqual(['AK', 'AK2'])
    expect(texts).toEqual(['recovered'])
    expect(marked).toEqual(['codearts-acb57fd3'])
  })

  it('两个账号积分都耗尽 ⇒ 试完两个号后如实报额度错误（带解禁时间）', async () => {
    // 现场正是这个形态（截图里 acb57fd3 积分 0、e6758a73 上游同样回耗尽），
    // 所以「换号失败后长什么样」必须锁住：不能死循环、不能静默无输出。
    const marked: string[] = []
    let nextCalled = 0
    const pool = {
      findAccountIdByCredential: async () => 'codearts-acb57fd3',
      getAvailableAccount: async () => {
        // 池里第二个号：只返回一次，第二次没有可用的号了。
        if (nextCalled > 0) return null
        nextCalled += 1
        return {
          entry: { id: 'codearts-e6758a73' },
          credential: {
            access_key_id: 'AK2', secret_access_key: 'SK2', security_token: 'ST2',
            expires_at: '2099-01-01T00:00:00Z',
          },
        }
      },
      updateModelRateLimit: async (accountId: string) => { marked.push(accountId) },
    }

    let chatCalls = 0
    const fetchImpl = vi.fn(async () => {
      chatCalls += 1
      return new Response(REAL_CREDIT_EXHAUSTED_BODY, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    })

    const adapter = makeAdapter({ fetchImpl, accountPool: pool })
    const chunks: unknown[] = []
    let thrown: unknown
    try {
      for await (const chunk of adapter.stream(streamOptions)) chunks.push(chunk)
    } catch (error) {
      thrown = error
    }

    // ① 两个号各试一次，不多试（不死循环）。
    expect(chatCalls).toBe(2)
    // ② 两个号都被标记。
    expect(marked).toEqual(['codearts-acb57fd3', 'codearts-e6758a73'])
    // ③ 零内容块 + 如实抛额度错误。
    //    码必须是字面量 `'QUOTA_EXCEEDED'`（harness 常量 `QUOTA_EXCEEDED_CODE`
    //    的字面值是 `'QUOTA'`，会让客户端把 message 换成通用文案，
    //    下面那句解禁时间就到不了用户眼前 —— issue IKJVCW）。
    expect(chunks).toEqual([])
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).code).toBe('QUOTA_EXCEEDED')
    expect((thrown as LlmError).message).toMatch(/预计 .*后重置/)
  })

  it('TM.000010051（无权调用该模型）不写标记、不换号 —— 直接如实报错', async () => {
    // ⚠️ 这条守的是「前缀陷阱的**行为**面」：单测判据函数还不够，
    // 必须证明真实报文走到这里时**不会**把整池账号烧掉。
    // glm-5.2 实测对两个账号都回 TM.000010051（模型未在租户开通），
    // 换号永远无用 —— 若误判成「没钱」，还会把两个好账号全部沉底。
    const marked: string[] = []
    let getAvailableCalls = 0
    const pool = {
      findAccountIdByCredential: async () => 'codearts-acb57fd3',
      getAvailableAccount: async () => {
        getAvailableCalls += 1
        return null
      },
      updateModelRateLimit: async (accountId: string) => { marked.push(accountId) },
    }

    let chatCalls = 0
    const fetchImpl = vi.fn(async () => {
      chatCalls += 1
      return new Response(
        `data:{"text":"[DONE]","error_code":"${REAL_TENANT_NOT_ENABLED_CODE}",`
        + `"error_msg":"您当前无权调用该模型，请联系企业管理员开通。"}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })

    const adapter = makeAdapter({ fetchImpl, accountPool: pool })
    let thrown: unknown
    try {
      for await (const _ of adapter.stream(streamOptions)) { /* 不应产出 */ }
    } catch (error) {
      thrown = error
    }

    // ① 只发一次请求（不轮号）。
    expect(chatCalls).toBe(1)
    // ② 没取号、没写标记。
    expect(getAvailableCalls).toBe(0)
    expect(marked).toEqual([])
    // ③ 仍如实报错（但不是额度类，也不是静默）。
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).code).not.toBe('QUOTA_EXCEEDED')
  })
})
