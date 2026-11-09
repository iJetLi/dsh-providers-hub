/**
 * 腾讯 Marvis（应用宝 AI 助手）的凭据结构、请求头与 UAL 签名原语。
 *
 * ## 两条腿，两套鉴权，**不能混**
 *
 * | 端点 | 需要的头 | 绝不能带的头 |
 * |---|---|---|
 * | `/v1/chat/completions`（模型网关） | `Ual-Access-{Openid,Access-Token,Login-Type,Guid}` + `Ual-Access-MarvisExt` | **UAL 签名** |
 * | `/v3/*`（钱包、用户信息） | 上面四个 + `Ual-Access-{Businessid,Timestamp,Nonce,Signature}` | — |
 *
 * ⚠️ **把签名头加到模型网关上是错的**：实测会把 `403 风控拦截` 变成
 * `401 登录态过期/未登录`（2026-11-09 请求头矩阵）。症状指向「凭据坏了」，
 * 而凭据完全正常 —— 这种错误最贵，故两条腿分成两个函数、并有单测钉死
 * 「推理头不带签名」。
 *
 * ## 凭据形态
 *
 * 一份账号一份 JSON（与 `modelscope` / `loomy` 同属「凭据是静态材料」那一类）：
 * 登录换来的是 **access token + refresh token 对**，两者都不可再生。
 *
 * ⚠️ 字段名 **必须**是 `access_token`：`AccountPool.findAccountIdByCredential`
 * 对非 codearts 的 provider 统一取它作身份标识（`src/account-pool.ts:1271`），
 * 改名会让限流记录的账号归属**恒匹配失败且静默**。
 *
 * @module src/marvis.ts
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

/** 业务接口基址（`/v3/*` 与登录回调都在这个 host 上）。 */
export const MARVIS_BASE_URL = 'https://yybadaccess.3g.qq.com'

/**
 * 业务接口签名用的 accessKey。
 *
 * ⚠️ 这不是密钥：明文硬编码在 Marvis 的渲染层里（`config_defaults` 的
 * Fernet 解密产物），任何登录了客户端的机器上都能读出来。写在这里是为了
 * 「签名能算对」，不是「保密」。
 */
export const MARVIS_ACCESS_KEY = 'fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi'

/** 上游 business id（请求头 `Ual-Access-Businessid`）。 */
export const MARVIS_BUSINESS_ID = 'marvis_client'

/**
 * 模型网关的 UA。
 *
 * ⚠️ **必须**是 Marvis agent 自己的 `AsyncOpenAI/Python 2.32.0`：
 * 换成浏览器 UA 或 magpie 自己的 UA 会被风控拦 `4100404`
 * （2026-11-09 请求头矩阵）。这不是「伪装」，是这个端点的准入条件。
 */
export const MARVIS_CLIENT_UA = 'AsyncOpenAI/Python 2.32.0'

/** 业务接口（`/v3/*`、授权页）用的浏览器 UA，照抄 Marvis 自己的。 */
export const MARVIS_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Marvis/1.60.3300.408 '
  + 'Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36'

/** QQ 互联 appid。 */
export const MARVIS_QQ_APP_ID = '1903794758'
/** 微信开放平台 appid。 */
export const MARVIS_WX_APP_ID = 'wxb650708317d56f88'

/**
 * 登录回调地址。
 *
 * ⚠️ **预注册、改不了**：换成本地地址会被微信/QQ 拒绝（域名白名单）。
 * 故登录必须「在浏览器里打开授权页 → 在 Request 阶段截停回调 →
 * Node 侧带 `Ual-Access-Guid` 换 code」（见 `marvis-browser-login.ts`）。
 */
export const MARVIS_REDIRECT_URI = `${MARVIS_BASE_URL}/marvis_client_login/marvis_oauth`

/** 默认客户端版本（`Ual-Access-MarvisExt.clientVersion`）。 */
export const MARVIS_DEFAULT_CLIENT_VERSION = '1.60.3300.765'

/** uskey 的字节数（Marvis 设备指纹的长度，实测 376）。 */
const USKEY_BYTES = 376

/** 一份可持久化的 Marvis 凭据。 */
export interface MarvisCredential {
  /**
   * access token（`mv_…`）。
   *
   * ⚠️ 字段名 **必须**是 `access_token`（见模块头）。
   */
  access_token: string
  /** refresh token（一次性轮换，必须写回）。 */
  refresh_token: string
  /** QQ / 微信的 openid（账号身份）。 */
  openid: string
  /** 设备 guid（token 与它绑定，换 guid 会 401）。 */
  guid: string
  /** `1` = QQ（QC），`2` = 微信（WX）。 */
  login_type: '1' | '2'
  /** 展示名。 */
  nickname?: string
  /**
   * 毫秒时间戳字符串（上游的 `access_token_expire_time`）。
   *
   * ⚠️ **兼容秒级**：`> 1e12` 视为毫秒，否则视为秒。
   */
  expires_at?: string
}

/** 发请求时用的账号视图（凭据里与「怎么发」有关的那几个字段）。 */
export interface MarvisAccount {
  accessToken: string
  openid: string
  guid: string
  loginType: '1' | '2'
  /** 覆盖 `Ual-Access-MarvisExt.clientVersion`（探测/兼容用）。 */
  clientVersion?: string
}

/**
 * 解析一份持久化的凭据。
 *
 * ⚠️ **四个必填字段缺一不可**：`access_token` / `openid` / `guid` /
 * `login_type`。半份凭据比没有更糟 —— 它会让「账号存在」与「请求必 401」
 * 同时成立，而症状（登录态过期）指向错误的方向。
 *
 * @returns 解析失败返回 `undefined`（**不抛错**：调用方要能区分「没凭据」
 *   与「凭据坏了」，而不是让异常冒到 RPC 层变成 500）。
 */
export function parseMarvisCredential(value: string | undefined): MarvisCredential | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const accessToken = record.access_token
  const refreshToken = record.refresh_token
  const openid = record.openid
  const guid = record.guid
  const loginType = record.login_type
  if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined
  if (typeof openid !== 'string' || openid.length === 0) return undefined
  if (typeof guid !== 'string' || guid.length === 0) return undefined
  if (loginType !== '1' && loginType !== '2') return undefined
  const credential: MarvisCredential = {
    access_token: accessToken,
    // ⚠️ refresh_token 允许为空串：上游续期响应可能回空（「不变」），
    // 解析层不该因此把整份凭据判死。
    refresh_token: typeof refreshToken === 'string' ? refreshToken : '',
    openid,
    guid,
    login_type: loginType,
  }
  if (typeof record.nickname === 'string' && record.nickname.length > 0) {
    credential.nickname = record.nickname
  }
  if (typeof record.expires_at === 'string' && record.expires_at.length > 0) {
    credential.expires_at = record.expires_at
  }
  return credential
}

/** 凭据 → 请求头用的账号对象。 */
export function marvisAccountOf(credential: MarvisCredential): MarvisAccount {
  return {
    accessToken: credential.access_token,
    openid: credential.openid,
    guid: credential.guid,
    loginType: credential.login_type,
  }
}

/**
 * 解析凭据里的过期时刻（毫秒）。
 *
 * ⚠️ **读取时兼容秒级**（`> 1e12` 视为毫秒，否则视为秒）—— 上游的
 * `access_token_expire_time` 历史上两种量纲都出现过；不兼容会让「秒」被当成
 * 1970 年 ⇒ **恒判已过期**、每轮都白跑一次续期。
 */
export function credentialExpiresAtMs(credential: MarvisCredential | undefined): number | undefined {
  const raw = credential?.expires_at
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed > 1e12 ? parsed : parsed * 1000
}

/**
 * 凭据是否已过期。
 *
 * ⚠️ **没有 `expires_at` 时恒返回 `false`（= 未过期）**：读不到不等于已失效。
 * 判成过期会让卡片整片变红、续期定时器每轮空转，而真正的失效由**上游 401**
 * 反映（客户端会给出「请重新登录」）。
 */
export function isMarvisCredentialExpired(
  credential: MarvisCredential | undefined,
  nowMs: number = Date.now(),
): boolean {
  const expiresAt = credentialExpiresAtMs(credential)
  if (expiresAt === undefined) return false
  return expiresAt <= nowMs
}

/**
 * 把 access token 打码成 `mv_1…cdef`（UI 一律用它，**绝不**展示明文）。
 *
 * ⚠️ 形状不合法时**返回空串**而不是回显原文 —— 打码函数绝不能成为
 * 「把任意输入原样上屏」的通道。
 */
export function maskMarvisKey(value: string | undefined | null): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!/^mv_[A-Za-z0-9_-]{16,}$/.test(trimmed)) return ''
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`
}

/**
 * 生成一次性的设备指纹（uskey）。
 *
 * ⚠️ **每次调用都现签**（376 字节随机 base64）：magpie 的 README 声称
 * 「同一 uskey 用第 3 次会 403」，本次实测未复现，但现签的代价可忽略，
 * 且能规避「指纹被服务端按次数判定」这类不可见风险。
 */
export function uskeyOf(): string {
  return randomBytes(USKEY_BYTES).toString('base64')
}

/**
 * `Ual-Access-MarvisExt` 的值（**紧凑 JSON，不能有空格**）。
 *
 * 服务端按原文字符串校验，带空格会被判成不同的指纹。
 */
export function marvisExt(account: MarvisAccount, uskey: string = uskeyOf()): string {
  return JSON.stringify({
    osVersion: 'Windows-10-10.0.26200',
    guid: account.guid ?? '',
    uskey,
    nonce: randomUUID(),
    reqScene: 1,
    taskType: 'user',
    clientVersion: account.clientVersion ?? MARVIS_DEFAULT_CLIENT_VERSION,
    isIoa: false,
  })
}

/**
 * 模型网关（`/v1/chat/completions`）的完整请求头。
 *
 * ⚠️ **不含任何 UAL 签名头**（见模块头）。
 */
export function llmHeaders(
  account: MarvisAccount,
  options: {
    accept?: string
    conversationId?: string
    responseId?: string
    agentTag?: string
    scene?: string
  } = {},
): Record<string, string> {
  return {
    Accept: options.accept ?? 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': MARVIS_CLIENT_UA,
    'X-Stainless-Lang': 'python',
    'X-Stainless-Package-Version': '2.32.0',
    'X-Stainless-OS': 'Windows',
    'X-Stainless-Arch': 'other:amd64',
    'X-Stainless-Runtime': 'CPython',
    'X-Stainless-Runtime-Version': '3.11.9',
    'X-Stainless-Async': 'async:asyncio',
    'X-Stainless-Raw-Response': 'true',
    Authorization: 'Bearer placeholder',
    'Ual-Access-Openid': account.openid,
    'Ual-Access-Access-Token': account.accessToken,
    'Ual-Access-Login-Type': account.loginType,
    'Ual-Access-Guid': account.guid ?? '',
    'Marvis-AgentTag': options.agentTag ?? 'auto_discovery',
    'Marvis-Conversation-ID': options.conversationId ?? '',
    'Marvis-Response-ID': options.responseId ?? '',
    'Marvis-Scene': options.scene ?? 'preload_summary',
    'Marvis-Protocol-Version': '1000',
    'X-Device-GUID': account.guid ?? '',
    'Ual-Access-MarvisExt': marvisExt(account),
  }
}

/**
 * `/v3/*` 业务接口的签名：`md5(query + timestamp + accessKey + nonce)`。
 *
 * @param query 签名原文 —— GET 是查询串（不含 `?`），POST 是 JSON body 原文
 * @returns 32 位小写 hex
 */
export function ualSignature(query: string, timestamp: string, nonce: string): string {
  return createHash('md5').update(`${query}${timestamp}${MARVIS_ACCESS_KEY}${nonce}`).digest('hex')
}

/** `/v3/*` 业务接口的完整请求头（带签名四件套）。 */
export function businessHeaders(
  account: MarvisAccount,
  options: { query: string; method?: string; now?: number; nonce?: string },
): Record<string, string> {
  const timestamp = String(options.now ?? Date.now())
  const nonce = options.nonce ?? String(1000 + Math.floor(Math.random() * 9000))
  return {
    Accept: '*/*',
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': MARVIS_BROWSER_UA,
    'Ual-Access-Businessid': MARVIS_BUSINESS_ID,
    'Ual-Access-Timestamp': timestamp,
    'Ual-Access-Nonce': nonce,
    'Ual-Access-Signature': ualSignature(options.query, timestamp, nonce),
    'Ual-Access-Guid': account.guid ?? '',
    'Ual-Access-Access-Token': account.accessToken,
    'Ual-Access-Login-Type': account.loginType,
    'Ual-Access-Openid': account.openid,
  }
}

/**
 * `login_type`（`'1'`/`'2'`）→ 回调/授权页用的码（`QC`/`WX`）。
 *
 * ⚠️ 只有**登录/授权**这条腿用 `QC`/`WX`；续期 body 里的 `loginType`
 * 恒为字面量 `"Marvis"`（见 `marvis-auth.ts`），别混。
 */
export function marvisLanguageOf(loginType: '1' | '2'): 'QC' | 'WX' {
  return loginType === '2' ? 'WX' : 'QC'
}

/** 账号展示名：`QQ·昵称` / `微信·昵称`（无昵称时退化成平台名）。 */
export function marvisAccountLabel(nickname: string | undefined, loginType: '1' | '2'): string {
  const platform = loginType === '2' ? '微信' : 'QQ'
  const name = typeof nickname === 'string' ? nickname.trim() : ''
  return name.length === 0 ? platform : `${platform}·${name}`
}

/** 推理端点全 URL。 */
export function marvisChatUrl(baseUrl: string = MARVIS_BASE_URL): string {
  return `${baseUrl}/v1/chat/completions`
}

/** 续期端点全 URL（**POST**，path 见 `marvis-product.ts` 的 `refreshPath`）。 */
export function marvisRefreshUrl(refreshPath: string, baseUrl: string = MARVIS_BASE_URL): string {
  return `${baseUrl}${refreshPath}`
}
