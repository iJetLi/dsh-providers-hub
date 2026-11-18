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

import {
  AGNESCODE_SESSION_FILE_PATTERN,
  agnescodeApiRoot,
  decryptAgnescodeSessionBlob,
  parseAgnescodeCredential,
  parseAgnescodeSession,
  sortAgnescodeSessionFiles,
  trustAgnescodeBffBase,
  unwrapAgnescodeLocalStateKey,
} from '../../src/agnescode.js'
import { AGNESCODE, AGNESCODE_INTL } from '../../src/agnescode-product.js'
import { buildAgnescodePayload, buildAgnescodeTools } from '../../src/agnescode-messages.js'
import { fetchAgnescodeBalanceDetailed } from '../../src/agnescode-credits.js'

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
