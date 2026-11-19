/**
 * AgnesCode 的**协议/安全判据**守卫（2026-11-19）。
 *
 * 这里只测**纯函数**：采集（读桌面文件）与 DPAPI 都是注入式的，单测不碰
 * 真实磁盘、不启动子进程、不发网络请求。
 *
 * ⚠️ 为什么 `trustAgnescodeBffBase` 的负例比正例多：本家把 `Authorization`
 * 挂在**账号下发的 base** 上 —— 判据写松一格就是「凭据被发到别人的域名」。
 */

import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from '@deepseek-ai/dsh-llm'

import {
  AGNESCODE_SESSION_FILE_PATTERN,
  agnescodeApiRoot,
  agnescodeExpiryMs,
  agnescodeSessionExpired,
  decodeAgnescodeJwtExpMs,
  decryptAgnescodeSessionBlob,
  fetchAgnescodeBalance,
  fetchAgnescodeCatalog,
  harvestAgnescodeLocalSession,
  parseAgnescodeCredential,
  parseAgnescodeSession,
  sortAgnescodeSessionFiles,
  trustAgnescodeBffBase,
  unwrapAgnescodeLocalStateKey,
} from '../../src/agnescode.js'
import { AGNESCODE, AGNESCODE_INTL } from '../../src/agnescode-product.js'
import { buildAgnescodePayload, buildAgnescodeTools } from '../../src/agnescode-messages.js'
import { fetchAgnescodeBalanceDetailed } from '../../src/agnescode-credits.js'
import { AgnescodeAdapter } from '../../src/agnescode-adapter.js'
import { probeById } from '../../src/index.js'

const BFF_CN = 'https://api-agnes-code.agnes-ai.cn/v1'
const BFF_INTL = 'https://api-agnes-code.agnes-ai.com/v1'

describe('trustAgnescodeBffBase（域名边界钉扎）', () => {
  it('放行两个站点的正式 host（并去掉尾部斜杠）', () => {
    expect(trustAgnescodeBffBase(BFF_CN)).toBe(BFF_CN)
    expect(trustAgnescodeBffBase('https://api-agnes-code.agnes-ai.cn/v1/')).toBe(BFF_CN)
    expect(trustAgnescodeBffBase(BFF_INTL)).toBe(BFF_INTL)
    expect(trustAgnescodeBffBase('https://agnes-ai.com')).toBe('https://agnes-ai.com')
  })

  it('⚠️ 拒绝「把受信域名当前缀」的地址（凭据外泄链的入口）', () => {
    expect(trustAgnescodeBffBase('https://api.agnes-ai.cn.evil.example/v1')).toBeNull()
    expect(trustAgnescodeBffBase('https://agnes-ai.com.evil.example')).toBeNull()
    expect(trustAgnescodeBffBase('https://evil.example/?next=agnes-ai.cn')).toBeNull()
  })

  it('拒绝非 https、带 userinfo、空串与非字符串', () => {
    expect(trustAgnescodeBffBase('http://api-agnes-code.agnes-ai.cn/v1')).toBeNull()
    expect(trustAgnescodeBffBase('https://user:pass@api-agnes-code.agnes-ai.cn/v1')).toBeNull()
    expect(trustAgnescodeBffBase('')).toBeNull()
    expect(trustAgnescodeBffBase(undefined)).toBeNull()
    expect(trustAgnescodeBffBase(42)).toBeNull()
  })

  it('⚠️ 拒绝非默认端口（域名判据对「同域冒名端口」完全无感）', () => {
    // 会话文件是**本地**文件：被篡改时 `https://api.agnes-ai.cn:8443` 就能把
    // Bearer 打到一个监听在同一域、非标端口的冒名服务上 —— 域名照样匹配。
    expect(trustAgnescodeBffBase('https://api-agnes-code.agnes-ai.cn:8443/v1')).toBeNull()
    // 显式写 443 由 `URL` 规范化成默认端口（`url.port === ''`）⇒ 放行，符合同一判据。
    expect(trustAgnescodeBffBase('https://agnes-ai.com:443')).toBe('https://agnes-ai.com')
  })
})

describe('agnescodeApiRoot', () => {
  it('去掉 /v1 后缀（额度端点不在 /v1 下）', () => {
    expect(agnescodeApiRoot(BFF_CN)).toBe('https://api-agnes-code.agnes-ai.cn')
    expect(agnescodeApiRoot(BFF_CN + '/')).toBe('https://api-agnes-code.agnes-ai.cn')
  })

  it('没有 /v1 时原样返回', () => {
    expect(agnescodeApiRoot('https://api-agnes-code.agnes-ai.cn')).toBe('https://api-agnes-code.agnes-ai.cn')
  })
})

describe('decryptAgnescodeSessionBlob（v10 + AES-256-GCM）', () => {
  const key = Buffer.from(randomBytes(32))
  const plaintext = Buffer.from(JSON.stringify({ accessToken: 'tok', bffPublicBaseUrl: BFF_CN }))

  const encrypt = (): Buffer => {
    const nonce = Buffer.from(randomBytes(12))
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    // 形状：`v10` + nonce(12) + ciphertext + tag(16)
    return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, body.subarray(0, body.length - 16), body.subarray(body.length - 16)])
  }

  it('能解开自己加出来的 blob', () => {
    expect(decryptAgnescodeSessionBlob(encrypt(), key).toString('utf8')).toBe(plaintext.toString('utf8'))
  })

  it('前缀不对 / 长度不够 / key 长度不对都**抛错**（不静默回空）', () => {
    expect(() => decryptAgnescodeSessionBlob(Buffer.from('v11abc', 'latin1'), key)).toThrow(/prefix/)
    expect(() => decryptAgnescodeSessionBlob(Buffer.from('v10short', 'latin1'), key)).toThrow(/too short/)
    expect(() => decryptAgnescodeSessionBlob(encrypt(), Buffer.alloc(16))).toThrow(/32 bytes/)
  })

  it('⚠️ tag 被改过的 blob **抛错**（GCM 的完整性校验不能绕过）', () => {
    const blob = encrypt()
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff
    expect(() => decryptAgnescodeSessionBlob(blob, key)).toThrow()
  })
})

describe('unwrapAgnescodeLocalStateKey（DPAPI 前缀）', () => {
  const dpapi = async (wrapped: Buffer): Promise<Buffer> => Buffer.concat([Buffer.from('plain:'), wrapped])

  it('剥掉 "DPAPI" 前缀后交给注入的解包器', async () => {
    const cipher = Buffer.from('cipher-bytes')
    const raw = JSON.stringify({
      os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), cipher]).toString('base64') },
    })
    const out = await unwrapAgnescodeLocalStateKey(raw, dpapi)
    expect(out.toString('utf8')).toBe(`plain:${cipher.toString('utf8')}`)
  })

  it('缺 encrypted_key / 前缀不对 / JSON 坏掉都抛错', async () => {
    await expect(unwrapAgnescodeLocalStateKey('{"os_crypt":{}}', dpapi)).rejects.toThrow(/no os_crypt/)
    await expect(unwrapAgnescodeLocalStateKey('{"os_crypt":{"encrypted_key":"AAAA"}}', dpapi))
      .rejects.toThrow(/DPAPI prefix/)
    await expect(unwrapAgnescodeLocalStateKey('not json', dpapi)).rejects.toThrow(/not valid JSON/)
  })
})

describe('parseAgnescodeCredential', () => {
  it('完整 JSON：两个字段都保留', () => {
    const parsed = parseAgnescodeCredential(JSON.stringify({
      access_token: 'tok',
      bff_base: BFF_CN,
      user_id: 'u1',
      nickname: 'n1',
    }), AGNESCODE)
    expect(parsed?.access_token).toBe('tok')
    expect(parsed?.bff_base).toBe(BFF_CN)
    expect(parsed?.user_id).toBe('u1')
  })

  it('⚠️ 不可信的 base ⇒ 整条凭据作废（不是「退回落址」）', () => {
    expect(parseAgnescodeCredential(JSON.stringify({
      access_token: 'tok',
      bff_base: 'https://api.agnes-ai.cn.evil.example/v1',
    }), AGNESCODE)).toBeUndefined()
  })

  it('缺 token / 坏 JSON ⇒ undefined', () => {
    expect(parseAgnescodeCredential(JSON.stringify({ bff_base: BFF_CN }), AGNESCODE)).toBeUndefined()
    expect(parseAgnescodeCredential('{oops', AGNESCODE)).toBeUndefined()
  })

  it('缺 bff_base 时按**站点常量**补（两站各自补自己的）', () => {
    expect(parseAgnescodeCredential(JSON.stringify({ access_token: 'tok' }), AGNESCODE)?.bff_base)
      .toBe(AGNESCODE.fallbackBffBase)
    expect(parseAgnescodeCredential(JSON.stringify({ access_token: 'tok' }), AGNESCODE_INTL)?.bff_base)
      .toBe(AGNESCODE_INTL.fallbackBffBase)
  })
})

describe('parseAgnescodeSession（会话文件的形状）', () => {
  it('两个驼峰字段齐全 ⇒ 解码', () => {
    expect(parseAgnescodeSession({
      accessToken: 'tok',
      bffPublicBaseUrl: BFF_CN,
      userInfo: { id: 'u1', username: 'n1' },
    })).toEqual({ accessToken: 'tok', bffBase: BFF_CN, userId: 'u1', nickname: 'n1' })
  })

  it('缺 token / base 不可信 ⇒ null', () => {
    expect(parseAgnescodeSession({ bffPublicBaseUrl: BFF_CN })).toBeNull()
    expect(parseAgnescodeSession({ accessToken: 'tok', bffPublicBaseUrl: 'https://evil.example' })).toBeNull()
  })
})

describe('会话文件选择', () => {
  it('文件名家族正则只认 code-auth-session*.v1', () => {
    expect(AGNESCODE_SESSION_FILE_PATTERN.test('code-auth-session.cn.v1')).toBe(true)
    expect(AGNESCODE_SESSION_FILE_PATTERN.test('code-auth-session.v1')).toBe(true)
    expect(AGNESCODE_SESSION_FILE_PATTERN.test('code-auth-session.v1.bak')).toBe(false)
    expect(AGNESCODE_SESSION_FILE_PATTERN.test('other.v1')).toBe(false)
  })

  it('⚠️ 国内站优先选 `cn`，国际站优先选**没有** `cn` 的那个', () => {
    const files = ['code-auth-session.v1', 'code-auth-session.cn.v1']
    expect(sortAgnescodeSessionFiles(files, 'cn')[0]).toBe('code-auth-session.cn.v1')
    expect(sortAgnescodeSessionFiles(files, 'intl')[0]).toBe('code-auth-session.v1')
  })

  it('⚠️ 严格模式零命中但家族文件在 ⇒ `format_drift`（不是「没装 App」）', async () => {
    // 「装了桌面端但文件后缀变了」和「根本没装」是两件事：报 `file_missing`
    // 会让用户去重装桌面端，而真正该做的是等适配 / 反馈版本。
    const result = await harvestAgnescodeLocalSession({
      product: AGNESCODE,
      platform: 'win32',
      env: { APPDATA: 'C:/Users/u/AppData/Roaming' },
      readDirImpl: async () => ['code-auth-session.v2', 'Local State'],
      readFileImpl: async () => { throw new Error('must not read') },
    })
    expect(result.ok).toBe(false)
    expect(result.attempts[0]?.tier).toBe('format_drift')
  })

  it('家族文件也不存在 ⇒ 仍是 `file_missing`', async () => {
    const result = await harvestAgnescodeLocalSession({
      product: AGNESCODE,
      platform: 'win32',
      env: { APPDATA: 'C:/Users/u/AppData/Roaming' },
      readDirImpl: async () => ['Local State'],
      readFileImpl: async () => { throw new Error('must not read') },
    })
    expect(result.attempts[0]?.tier).toBe('file_missing')
  })
})

describe('buildAgnescodePayload / buildAgnescodeTools', () => {
  it('stream 恒 true、system 折进 messages、tools 恒带', () => {
    const body = buildAgnescodePayload({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'be nice',
      tools: [],
    })
    expect(body.stream).toBe(true)
    // ⚠️ 真机取证：不传 `stream_options.include_usage`，整条流**一帧 `usage` 都没有**
    //    ⇒ 令牌台账永远空转。删掉这行必须让本断言红。
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(Array.isArray(body.tools)).toBe(true)
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toBe('be nice')
  })

  it('⚠️ `max_tokens` 只放行安全正整数（0/NaN 一律不发）', () => {
    const base = { model: 'm', messages: [{ role: 'user', content: 'x' }] }
    expect(buildAgnescodePayload({ ...base, maxTokens: 0 })).not.toHaveProperty('max_tokens')
    expect(buildAgnescodePayload({ ...base, maxTokens: Number.NaN })).not.toHaveProperty('max_tokens')
    expect(buildAgnescodePayload({ ...base, maxTokens: 4096 })).toHaveProperty('max_tokens', 4096)
  })

  it('工具包装成 OpenAI function，空描述整个省略', () => {
    const tools = buildAgnescodeTools([
      { name: 'read', description: '', parameters: { type: 'object' } },
      { name: 'write', description: 'writes' },
    ])
    expect(tools).toHaveLength(2)
    expect(tools[0]?.function).not.toHaveProperty('description')
    expect(tools[1]?.function.description).toBe('writes')
    // 参数缺省也整个省略（不是发 `undefined` 键）。
    expect(tools[1]?.function).not.toHaveProperty('parameters')
  })
})

describe('目录与余额的**数值域**（0 / 负数一律不是「数据」）', () => {
  const credential = JSON.stringify({ access_token: 'tok', bff_base: BFF_CN })
  const json = (payload: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

  it('⚠️ `max_input_tokens: 0` / `max_output_tokens: 0` ⇒ **不声明**（不是声明 0）', async () => {
    // 0 在目录里只可能表示「上游没给/哨兵」；放行它会让条目声明 `contextWindow: 0`，
    // 而 `resolveModel` 与 `model-catalog-parity` 都按 `> 0` 判 ⇒ 同一份数据两套口径。
    const entries = await fetchAgnescodeCatalog(parseAgnescodeCredential(credential, AGNESCODE)!, AGNESCODE, json({
      data: [{ id: 'm0', name: 'M0', model_type: 'text', max_input_tokens: 0, max_output_tokens: 0 }],
    }))
    expect(entries).toHaveLength(1)
    expect(entries?.[0]).not.toHaveProperty('contextWindow')
    expect(entries?.[0]).not.toHaveProperty('maxTokens')
  })

  it('负数上限同样不声明', async () => {
    const entries = await fetchAgnescodeCatalog(parseAgnescodeCredential(credential, AGNESCODE)!, AGNESCODE, json({
      data: [{ id: 'mneg', model_type: 'text', max_input_tokens: -1, max_output_tokens: -4096 }],
    }))
    expect(entries?.[0]).not.toHaveProperty('contextWindow')
    expect(entries?.[0]).not.toHaveProperty('maxTokens')
  })

  it('⚠️ 负余额 ⇒ 整份读数作废（不是「-5 积分」）', async () => {
    const reading = await fetchAgnescodeBalance(parseAgnescodeCredential(credential, AGNESCODE)!, AGNESCODE, json({
      code: '000000',
      data: { total_balance: -5, permanent_balance: -5, time_sensitive_balance: 0 },
    }))
    expect(reading).toBeNull()
  })
})

describe('AgnescodeAdapter 的接线判据（推理腿 / 预热自激 / 带图请求）', () => {
  const product = AGNESCODE
  const credential = parseAgnescodeCredential(
    JSON.stringify({ access_token: 'spec-token', bff_base: BFF_CN }),
    product,
  )!

  const slot = (accountId: string) => ({ accountId, credential })

  it('⚠️ 推理腿必须走注入的 `fetchImpl`（选项注释承诺「三端点共用」）', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
    const adapter = new AgnescodeAdapter({
      product,
      slots: async () => [slot('a1')],
      fetchImpl,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试只关心出口，不关心 GenerateOptions 的完整形状
    for await (const _chunk of adapter.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] } as any)) {
      // 消费完即可；断言的是「谁发的请求」。
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(`${BFF_CN}/chat/completions`)
  })

  it('⚠️ 目录拉失败不得自激成「预热 → catalog → 失败 → 再预热」的无限循环', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    const adapter = new AgnescodeAdapter({
      product,
      slots: async () => [slot('a1')],
      fetchImpl,
    })
    // ① 异步路径（`catalog()` 拉失败后回兜底表，**不得**再触发预热）；
    // ② 同步路径（`listAllModels()` 每次都触发预热 ⇒ 必须有节流/反重入）。
    await adapter.resolveModel('agnescode', 'm')
    adapter.listAllModels()
    adapter.listAllModels()
    await new Promise((resolve) => setTimeout(resolve, 120))
    // 旧实现（`catalog()` 失败时回落到 `syncCatalogEntries()` + 无闸门）下这条链会
    // 自己喂自己（每轮一次 HTTP）⇒ 120ms 内就会攒出几十次；现在只允许 1 次。
    expect(calls).toBeLessThanOrEqual(1)
  })

  it('⚠️ 带图请求在**进池循环前**就拒掉：不换号、不发请求、不写限流', async () => {
    let calls = 0
    const marks: string[] = []
    const adapter = new AgnescodeAdapter({
      product,
      slots: async () => [slot('a1'), slot('a2')],
      fetchImpl: (async () => {
        calls += 1
        return new Response('', { status: 200 })
      }) as unknown as typeof fetch,
      markLimited: async (accountId: string) => { marks.push(accountId) },
    })
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上：只需要一条带图消息
      for await (const _chunk of adapter.stream({
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'img-1' } }] }],
      } as any)) {
        // 不该产出任何 chunk。
      }
    }).rejects.toThrow(/不支持图片输入/)
    expect(calls).toBe(0)
    expect(marks).toEqual([])
  })

  it('⚠️ SSE 里的额度错误（无 status）必须写冷却并换号，不能当传输错误白轮', async () => {
    // 流内错误没有 HTTP `status`：只看 status 会把它们归 `transport` ⇒ 不写标记、
    // 下次请求照旧撞同一面墙（而用户看到的只是「重试也没用」）。
    const marks: string[] = []
    let calls = 0
    const adapter = new AgnescodeAdapter({
      product,
      slots: async () => [slot('a1'), slot('a2')],
      fetchImpl: (async () => {
        calls += 1
        throw new LlmError('agnescode: 额度已用尽', 'QUOTA_EXCEEDED')
      }) as unknown as typeof fetch,
      markLimited: async (accountId: string) => { marks.push(accountId) },
    })
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 只需要一条文本消息
      for await (const _chunk of adapter.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] } as any)) {
        // 不该产出任何 chunk。
      }
    }).rejects.toThrow(/均受限/)
    expect(calls).toBe(2)
    expect(marks).toEqual(['a1', 'a2'])
  })

  it('⚠️ SSE 里的上下文超限（无 status）必须**不换号**（换号对同一请求无用）', async () => {    let calls = 0
    const adapter = new AgnescodeAdapter({
      product,
      slots: async () => [slot('a1'), slot('a2')],
      fetchImpl: (async () => {
        calls += 1
        throw new LlmError('agnescode: 上下文超限', CONTEXT_WINDOW_EXCEEDED_CODE)
      }) as unknown as typeof fetch,
      markLimited: async () => { throw new Error('must not mark') },
    })
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 只需要一条文本消息
      for await (const _chunk of adapter.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] } as any)) {
        // 不该产出任何 chunk。
      }
    }).rejects.toThrow(/上下文超限/)
    expect(calls).toBe(1)
  })

  it('★ 真机形态的工具调用帧能合并成 tool 块 + finish tool-calls（首片带 id/name）', async () => {
    // 帧形态照抄 2026-11-19 真机（agnes-2.5-pro + get_time）：
    //   首片 {id,type:'function',index:0,function:{name:'get_time',arguments:''}}
    //   后续只带 arguments 片段（实测是 "{" 与 "}" 两片）
    //   末帧 delta 为空 + finish_reason:'tool_calls'，随后 [DONE]
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","type":"function","index":0,"function":{"name":"get_time","arguments":""}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"{"},"type":"function","index":0}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"}"},"type":"function","index":0}]}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
    let wireBody: Record<string, unknown> = {}
    const adapter = new AgnescodeAdapter({
      product,
      slots: async () => [slot('a1')],
      fetchImpl: (async (_url: string, init: { body: string }) => {
        wireBody = JSON.parse(init.body) as Record<string, unknown>
        return new Response(frames, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }) as unknown as typeof fetch,
    })
    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of adapter.stream({
      model: 'agnes-2.5-pro',
      messages: [{ role: 'user', content: '几点了？' }],
      tools: [{ name: 'get_time', description: '时间', parameters: { type: 'object' } }],
    } as never)) {
      chunks.push(chunk as unknown as Record<string, unknown>)
    }
    // 请求侧：工具必须真的发出去（漏接 = 模型永远不调用工具，且没有报错）。
    expect((wireBody.tools as Array<{ function: { name: string } }>)[0]?.function.name).toBe('get_time')
    const toolEnd = chunks.find((c) => c.type === 'block-end'
      && (c.block as { type?: string } | undefined)?.type === 'tool-call')
    expect((toolEnd?.block as { arguments?: string } | undefined)?.arguments).toBe('{}')
    expect(chunks.at(-1)?.type).toBe('finish')
    expect((chunks.at(-1)?.reason as { kind?: string } | undefined)?.kind).toBe('tool-calls')
  })

  it('★ 目录名带计费倍率、免费标记、订阅门控说明（2026-11-19 真机字段）', async () => {
    // 真机实测：`points_cost_multiplier` 取 0 / 0.3 / 1 / 1.5 / 2.2 / 6 / 7.5 / 25；
    // `allowed_subscription` 非空 = 需要该档订阅（免费账号请求 403 subscription_required）。
    const rows = [
      { id: 'kimi-k3', name: 'Kimi K3', model_type: 'text', max_input_tokens: 1048576, max_output_tokens: 131072, points_cost_multiplier: 6, allowed_subscription: ['Starter', 'Plus', 'Pro'] },
      { id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash', model_type: 'text', max_input_tokens: 512000, max_output_tokens: 65536, points_cost_multiplier: 0, allowed_subscription: [] },
      { id: 'agnes-no-price', name: 'Agnes NoPrice', model_type: 'text' },
      { id: 'auto', name: 'Auto', model_type: 'text' },
    ]
    const adapter = new AgnescodeAdapter({
      product,
      slots: async () => [slot('a1')],
      fetchImpl: (async () => new Response(JSON.stringify({ data: rows }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    })
    const models = await adapter.listModels('agnescode')
    const byId = (id: string) => models.find((m) => m.id === id)
    expect(byId('kimi-k3')?.name).toBe('Kimi K3 · x6.00')
    expect(byId('kimi-k3')?.description).toMatch(/Starter \/ Plus \/ Pro/)
    expect(byId('agnes-3.0-flash')?.name).toBe('Agnes 3.0 Flash · x0.00')
    expect('description' in (byId('agnes-3.0-flash') ?? {})).toBe(false)
    // 上游没报价 ⇒ 名字**不加任何后缀**（不是 x0.00，也不是 x1.00）。
    expect(byId('agnes-no-price')?.name).toBe('Agnes NoPrice')
    expect(models.map((m) => m.id)).not.toContain('auto')
    // `isFree` 只从 `listAllModels()` 出（宿主 `LlmModelInfo` 没有该字段，Jet Hub 免费桶读这条）。
    const all = adapter.listAllModels()
    expect(all.find((m) => m.id === 'agnes-3.0-flash')?.isFree).toBe(true)
    expect(all.find((m) => m.id === 'kimi-k3')?.isFree).toBeUndefined()
  })

  it('⚠️ 403 `subscription_required` 不是认证失败：不换号、不给「重新登录」指路', async () => {    // 真机取证（2026-11-19）：免费账号请求 `deepseek-v4.1-flash` 回
    // `403 {"code":"subscription_required","message":"该模型需要更高权益解锁，请升级订阅后使用。"}`
    // 旧实现把它当 `AUTH` ⇒ 白轮整池 + 错误尾部挂「会话可能已过期，请重新登录」这条错指路。
    let calls = 0
    const adapter = new AgnescodeAdapter({
      product,
      slots: async () => [slot('a1'), slot('a2')],
      fetchImpl: (async () => {
        calls += 1
        return new Response(
          JSON.stringify({ error: { code: 'subscription_required', message: '该模型需要更高权益解锁，请升级订阅后使用。' } }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch,
      markLimited: async () => { throw new Error('must not mark') },
    })
    let caught: unknown
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 只需要一条文本消息
      for await (const _chunk of adapter.stream({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] } as any)) {
        // 不该产出任何 chunk。
      }
    } catch (error) {
      caught = error
    }
    expect(calls).toBe(1)
    const failure = (caught as { failure?: { code?: string } }).failure
    expect(failure?.code).toBe('PERMISSION')
    expect((caught as Error).message).not.toMatch(/重新登录|会话可能已过期/)
    expect((caught as Error).message).toMatch(/subscription_required/)
  })

  it('⚠️ 429 `daily_requests`（日墙）不得只冷却 60 秒', async () => {
    // 真机取证：`429 {"code":"rate_limit_exceeded","message":"daily_requests limit exceeded"}`。
    // 60s 冷却 ⇒ 每分钟撞一次同一面日墙；日墙要等次日 0 点（UTC+8）。
    const marks: Array<{ at: number }> = []
    const adapter = new AgnescodeAdapter({
      product,
      slots: async () => [slot('a1'), slot('a2')],
      fetchImpl: (async () => new Response(
        JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'daily_requests limit exceeded' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
      markLimited: async (_accountId: string, _model: string, resetAtMs: number) => { marks.push({ at: resetAtMs }) },
    })
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 只需要一条文本消息
      for await (const _chunk of adapter.stream({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }] } as any)) {
        // 不该产出任何 chunk。
      }
    }).rejects.toThrow(/均受限/)
    expect(marks).toHaveLength(2)
    for (const mark of marks) {
      const delta = mark.at - Date.now()
      expect(delta).toBeGreaterThan(60 * 60_000)
      expect(delta).toBeLessThanOrEqual(25 * 60 * 60_000)
    }
  })
})

describe('有效期（`expires_at` / JWT `exp` → 过期预检）', () => {
  /** 造一枚只有 `exp` 的 JWT（签名段是假的 —— 本地只解 payload，不验签）。 */
  function jwtWithExp(expSeconds: number): string {
    const payload = Buffer.from(JSON.stringify({ exp: expSeconds }), 'utf8').toString('base64url')
    return `header.${payload}.sig`
  }

  it('`decodeAgnescodeJwtExpMs`：能解出 `exp`，解不出时是**未知**（undefined）而不是已过期', () => {
    expect(decodeAgnescodeJwtExpMs(jwtWithExp(1_700_000_000))).toBe(1_700_000_000_000)
    expect(decodeAgnescodeJwtExpMs('plain-token')).toBeUndefined()
    expect(decodeAgnescodeJwtExpMs('a.b')).toBeUndefined()
    expect(decodeAgnescodeJwtExpMs('a.!!!.c')).toBeUndefined()
  })

  it('`agnescodeExpiryMs`：`expires_at` 优先于 JWT', () => {
    const credential = parseAgnescodeCredential(
      JSON.stringify({ access_token: jwtWithExp(1_700_000_000), bff_base: BFF_CN, expires_at: 2_000 }),
      AGNESCODE,
    )
    expect(credential).toBeDefined()
    expect(agnescodeExpiryMs(credential!)).toBe(2_000)
  })

  it('⚠️ `agnescodeSessionExpired`：过期才 true；有效期未知一律 false（未知 ≠ 过期）', () => {
    const base = { bff_base: BFF_CN }
    const now = 1_700_000_500_000
    expect(agnescodeSessionExpired({ ...base, access_token: jwtWithExp(1_699_999_000) }, now)).toBe(true)
    expect(agnescodeSessionExpired({ ...base, access_token: jwtWithExp(1_700_001_000) }, now)).toBe(false)
    // 非 JWT（手工粘贴的 token）⇒ 本地判不了，绝不能拦。
    expect(agnescodeSessionExpired({ access_token: 'plain-token', bff_base: BFF_CN }, now)).toBe(false)
  })

  it('⚠️ 探测路径对已过期会话给**可读原因**（而不是打一次上游拿回空目录）', async () => {
    // 目录端点把 401 吞成 `[]` ⇒「重测」只会显示「没有模型」。过期预检在**发请求之前**
    // 就抛 ⇒ 这条用例同时证明「没打网络」（fetch 是探针里构造的，我们无法 mock）。
    const expiredToken = jwtWithExp(Math.floor(Date.now() / 1000) - 3600)
    const adapter = probeById.agnescode.createProbeAdapter(
      'AGNESCODE_ACCESS_TOKEN',
      JSON.stringify({ access_token: expiredToken, bff_base: BFF_CN }),
    )
    await expect(adapter.listModels('agnescode')).rejects.toThrow(/会话已过期/)
  })
})

describe('fetchAgnescodeBalanceDetailed（订阅积分池 → CreditBalance）', () => {
  const credential = JSON.stringify({ access_token: 'tok', bff_base: BFF_CN })

  const fake = (payload: unknown, ok = true): typeof fetch =>
    (async () => new Response(JSON.stringify(payload), { status: ok ? 200 : 500 })) as unknown as typeof fetch

  it('两个桶都 > 0 ⇒ 两个包；⚠️ 限时桶带 expiryUnknown，永久桶不带', async () => {
    const detail = await fetchAgnescodeBalanceDetailed(AGNESCODE, credential, fake({
      code: '000000',
      data: { total_balance: 3000, permanent_balance: 1000, time_sensitive_balance: 2000 },
    }))
    expect(detail.error).toBeUndefined()
    const packages = detail.balance?.packages ?? []
    expect(packages).toHaveLength(2)
    const permanent = packages.find((p) => p.name === '永久积分')
    const limited = packages.find((p) => p.name === '限时积分')
    expect(permanent?.remaining).toBe(1000)
    expect(permanent?.expiryUnknown).toBeUndefined()
    // ⚠️ 本仓红线：上游没给日期**不等于**永不到期。
    expect(limited?.remaining).toBe(2000)
    expect(limited?.expiryUnknown).toBe(true)
    expect(detail.balance?.total).toBe(3000)
  })

  it('0 的桶不造空包', async () => {
    const detail = await fetchAgnescodeBalanceDetailed(AGNESCODE, credential, fake({
      code: '000000',
      data: { total_balance: 1000, permanent_balance: 1000, time_sensitive_balance: 0 },
    }))
    expect(detail.balance?.packages).toHaveLength(1)
  })

  it('⚠️ 信封 code 是**字符串** "000000"：数字或缺失都判失败', async () => {
    const numeric = await fetchAgnescodeBalanceDetailed(AGNESCODE, credential, fake({
      code: 0, data: { total_balance: 1 },
    }))
    expect(numeric.balance).toBeNull()
    expect(numeric.error).toBeTruthy()
  })

  it('HTTP 失败 / 凭据不可解析 ⇒ balance null + 原因（不是 0）', async () => {
    const httpFail = await fetchAgnescodeBalanceDetailed(AGNESCODE, credential, fake({}, false))
    expect(httpFail.balance).toBeNull()
    const badCred = await fetchAgnescodeBalanceDetailed(AGNESCODE, '{}', fake({}))
    expect(badCred.balance).toBeNull()
    expect(badCred.error).toBeTruthy()
  })
})
