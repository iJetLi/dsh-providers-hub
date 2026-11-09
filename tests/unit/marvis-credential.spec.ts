/**
 * Marvis 的凭据、请求头与 UAL 签名原语。
 *
 * ## 为什么这些是「原语」而不是「适配器的一部分」
 *
 * 两条腿（推理 `/v1/chat/completions`、业务 `/v3/*`）**鉴权方式相反**：
 *
 * | 端点 | 需要的头 | 绝不能带的头 |
 * |---|---|---|
 * | `/v1/chat/completions` | `Ual-Access-{Openid,Access-Token,Login-Type,Guid}` + `Ual-Access-MarvisExt` | **UAL 签名**（带了 403 变 401） |
 * | `/v3/*` | 上面四个 + `Ual-Access-{Businessid,Timestamp,Nonce,Signature}` | — |
 *
 * 这条「不能混」的判据必须有**一处**可被单测点名的地方，否则接线时随手
 * 复用 `businessHeaders` 就会把推理打挂，而症状（「登录态过期」）指向
 * 完全错误的方向。故原语独立成模块。
 *
 * @module tests/unit/marvis-credential.spec.ts
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  MARVIS_ACCESS_KEY,
  businessHeaders,
  credentialExpiresAtMs,
  isMarvisCredentialExpired,
  llmHeaders,
  marvisAccountLabel,
  marvisAccountOf,
  marvisExt,
  marvisLanguageOf,
  maskMarvisKey,
  parseMarvisCredential,
  ualSignature,
  uskeyOf,
  type MarvisAccount,
  type MarvisCredential,
} from '../../src/marvis.js'

const CREDENTIAL: MarvisCredential = {
  access_token: 'mv-test-access-token',
  refresh_token: 'test-refresh-token-0001',
  openid: '864D89036E52CC338D18484131FE053D',
  guid: 'f4642360411b4132d5917bf04f615b8a',
  login_type: '1',
  nickname: 'Jet',
}

const ACCOUNT: MarvisAccount = {
  accessToken: 'mv-test-access-token',
  openid: '864D89036E52CC338D18484131FE053D',
  guid: 'f4642360411b4132d5917bf04f615b8a',
  loginType: '1',
}

describe('parseMarvisCredential', () => {
  it('解析出完整凭据（四个必填字段都在）', () => {
    expect(parseMarvisCredential(JSON.stringify(CREDENTIAL))).toMatchObject({
      access_token: 'mv-test-access-token',
      refresh_token: 'test-refresh-token-0001',
      openid: '864D89036E52CC338D18484131FE053D',
      login_type: '1',
      nickname: 'Jet',
    })
  })

  it('缺 access_token / openid / guid / login_type 任一 ⇒ undefined（不是半份凭据）', () => {
    for (const field of ['access_token', 'openid', 'guid', 'login_type'] as const) {
      const broken: Record<string, unknown> = { ...CREDENTIAL }
      delete broken[field]
      expect(parseMarvisCredential(JSON.stringify(broken))).toBeUndefined()
    }
  })

  it('login_type 只接受 "1" / "2"（其它值当作坏凭据）', () => {
    expect(parseMarvisCredential(JSON.stringify({ ...CREDENTIAL, login_type: '3' }))).toBeUndefined()
  })

  it('非 JSON / 空串 / undefined ⇒ undefined（不得抛错）', () => {
    expect(parseMarvisCredential(undefined)).toBeUndefined()
    expect(parseMarvisCredential('')).toBeUndefined()
    expect(parseMarvisCredential('not json')).toBeUndefined()
  })
})

describe('marvisAccountOf / 过期判定', () => {
  it('凭据 → 请求头用的账号对象', () => {
    expect(marvisAccountOf(CREDENTIAL)).toEqual({
      accessToken: 'mv-test-access-token',
      openid: '864D89036E52CC338D18484131FE053D',
      guid: 'f4642360411b4132d5917bf04f615b8a',
      loginType: '1',
    })
  })

  it('expires_at 秒级时间戳按秒展开（否则恒判 1970 已过期）', () => {
    expect(credentialExpiresAtMs({ ...CREDENTIAL, expires_at: '1796660878' })).toBe(1_796_660_878_000)
    expect(credentialExpiresAtMs({ ...CREDENTIAL, expires_at: '1796660878059' })).toBe(1_796_660_878_059)
  })

  it('expires_at 缺失 ⇒ 未过期（读不到不等于已失效）', () => {
    expect(credentialExpiresAtMs({ ...CREDENTIAL })).toBeUndefined()
    expect(isMarvisCredentialExpired({ ...CREDENTIAL })).toBe(false)
  })

  it('过去的时刻 ⇒ 已过期', () => {
    expect(isMarvisCredentialExpired({ ...CREDENTIAL, expires_at: '1600000000000' })).toBe(true)
  })
})

describe('maskMarvisKey', () => {
  it('前缀 + 尾 4 位（与账号 id / 凭据 ref 的指纹口径一致）', () => {
    expect(maskMarvisKey('mv_' + '1234567890ab' + 'cdef')).toBe('mv_1…cdef')
  })

  it('形状不合法 ⇒ 空串（打码函数不得成为「原样上屏」的通道）', () => {
    expect(maskMarvisKey('')).toBe('')
    expect(maskMarvisKey(undefined)).toBe('')
    expect(maskMarvisKey('随便一段文本')).toBe('')
  })
})

describe('ualSignature', () => {
  it('md5(query + timestamp + accessKey + nonce) 的 32 位小写 hex', () => {
    const signature = ualSignature('{}', '1700000000000', '1234')
    expect(signature).toMatch(/^[0-9a-f]{32}$/)
    // 逐字复算：钉住**拼接顺序**（值取自导出常量，顺序由本行给出）。
    expect(signature).toBe(
      createHash('md5')
        .update(`{}1700000000000${MARVIS_ACCESS_KEY}1234`)
        .digest('hex'),
    )
  })

  it('任一输入变了签名就变（不是常量）', () => {
    expect(ualSignature('{}', '1700000000000', '1234'))
      .not.toBe(ualSignature('{}', '1700000000001', '1234'))
  })
})

describe('uskeyOf', () => {
  it('376 字节 base64（每次现签，两次不同）', () => {
    const first = uskeyOf()
    const second = uskeyOf()
    expect(Buffer.from(first, 'base64')).toHaveLength(376)
    expect(first).not.toBe(second)
  })
})

describe('llmHeaders（推理腿）', () => {
  const headers = llmHeaders(ACCOUNT)

  it('Authorization 恒 Bearer placeholder（真正的凭据在 Ual-Access-* 里）', () => {
    expect(headers.Authorization).toBe('Bearer placeholder')
    expect(headers['Ual-Access-Access-Token']).toBe(ACCOUNT.accessToken)
    expect(headers['Ual-Access-Openid']).toBe(ACCOUNT.openid)
    expect(headers['Ual-Access-Login-Type']).toBe('1')
    expect(headers['Ual-Access-Guid']).toBe(ACCOUNT.guid)
  })

  it('★ 绝不带 UAL 签名头（带了 403 会变成 401 登录态过期）', () => {
    expect(Object.keys(headers).some((key) => key.startsWith('Ual-Access-Signature'))).toBe(false)
    expect(Object.keys(headers).some((key) => key.startsWith('Ual-Access-Businessid'))).toBe(false)
    expect(Object.keys(headers).some((key) => key.startsWith('Ual-Access-Timestamp'))).toBe(false)
    expect(Object.keys(headers).some((key) => key.startsWith('Ual-Access-Nonce'))).toBe(false)
  })

  it('★ Ual-Access-MarvisExt 是紧凑 JSON（不能有空格）且带 guid / reqScene / taskType / isIoa', () => {
    const ext = headers['Ual-Access-MarvisExt'] ?? ''
    expect(ext).not.toMatch(/\s/)
    expect(JSON.parse(ext)).toMatchObject({
      guid: ACCOUNT.guid,
      reqScene: 1,
      taskType: 'user',
      isIoa: false,
    })
    // uskey 必须是现签的那一份（376 字节）
    expect(Buffer.from(JSON.parse(ext).uskey as string, 'base64')).toHaveLength(376)
  })

  it('UA 是 Marvis agent 自己的（换成浏览器 UA 会被风控 4100404）', () => {
    expect(headers['User-Agent']).toBe('AsyncOpenAI/Python 2.32.0')
  })

  it('可覆盖 scene / agentTag / 会话 id', () => {
    const custom = llmHeaders(ACCOUNT, {
      scene: 'chat',
      agentTag: 'agent',
      conversationId: 'c1',
      responseId: 'r1',
    })
    expect(custom['Marvis-Scene']).toBe('chat')
    expect(custom['Marvis-AgentTag']).toBe('agent')
    expect(custom['Marvis-Conversation-ID']).toBe('c1')
    expect(custom['Marvis-Response-ID']).toBe('r1')
  })

  it('每次调用都重新现签 uskey（同一账号两次不同）', () => {
    expect(llmHeaders(ACCOUNT)['Ual-Access-MarvisExt'])
      .not.toBe(llmHeaders(ACCOUNT)['Ual-Access-MarvisExt'])
  })
})

describe('businessHeaders（/v3/* 业务腿）', () => {
  it('带 businessid / timestamp / nonce / signature 四件套', () => {
    const headers = businessHeaders(ACCOUNT, { query: '{}', method: 'POST' })
    expect(headers['Ual-Access-Businessid']).toBe('marvis_client')
    expect(headers['Ual-Access-Timestamp']).toMatch(/^\d+$/)
    expect(headers['Ual-Access-Nonce']).toMatch(/^\d{4}$/)
    expect(headers['Ual-Access-Signature']).toBe(
      ualSignature('{}', headers['Ual-Access-Timestamp'] ?? '', headers['Ual-Access-Nonce'] ?? ''),
    )
  })

  it('业务腿用浏览器 UA（与推理腿刻意不同）', () => {
    expect(businessHeaders(ACCOUNT, { query: '{}' })['User-Agent']).toMatch(/^Mozilla\/5\.0/)
  })
})

describe('marvisExt / 标签', () => {
  it('marvisExt 的 clientVersion 可覆盖', () => {
    expect(JSON.parse(marvisExt({ ...ACCOUNT, clientVersion: '9.9.9' })).clientVersion).toBe('9.9.9')
    expect(JSON.parse(marvisExt(ACCOUNT)).clientVersion).toBe('1.60.3300.765')
  })

  it('login_type → 请求里的 login_type 码（QC / WX）', () => {
    expect(marvisLanguageOf('1')).toBe('QC')
    expect(marvisLanguageOf('2')).toBe('WX')
  })

  it('账号展示名 = <QQ|微信>·<昵称>', () => {
    expect(marvisAccountLabel('Jet', '1')).toBe('QQ·Jet')
    expect(marvisAccountLabel('小明', '2')).toBe('微信·小明')
    expect(marvisAccountLabel(undefined, '1')).toBe('QQ')
  })
})
