/**
 * Today（`todayai.cn` / `today.ai`）上游协议、Cookie 清洗与 JWT 会话交换。
 *
 * 移植自 `cpa-today-plugin`（`internal/today/cookie.go` & `internal/today/client.go`）：
 *
 * 1. 认证链：
 *    浏览器 session cookie (`__Secure-better-auth.session_token`)
 *      -> POST `{appBase}/api/token` `{ audience: apiBase, expiresIn: 3600 }` -> `{ token, expiresIn }`
 *      -> `Authorization: Bearer <JWT>` 请求 `{apiBase}/v1/*`
 * 2. 对话链（非 OpenAI 协议、无 SSE，需轮询）：
 *    - `PUT /v1/pricing/model-option` `{ optionId }` 切换模型
 *    - `POST /v1/messages` `{ content, messageType: "text", clientMessageId, channel: "main" }` -> `{ threadId, messageId }`
 *    - `GET /v1/conversations/messages?isMainChat=true&limit=3` 轮询直到匹配 `threadId`、
 *      `role === 'assistant'` 且 `state === 'completed' || isFinal === true`
 * 3. 额度与模型清单：
 *    - `GET /v1/pricing/status` -> `data.status.{ plan, usage, modelOptions }`
 *    - `GET /v1/users/me` -> `{ id, email, plan }`
 *
 * @module src/today.ts
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  TODAY,
  TODAY_INTL,
  TODAY_KNOWN_MODELS,
  type TodayModelEntry,
  type TodayProduct,
  type TodayRealm,
} from './today-product.js'

/** Better Auth 在 HTTPS 下使用的主会话 Cookie 名。 */
export const TODAY_SESSION_COOKIE_NAME = '__Secure-better-auth.session_token'

/** 落盘在 DSH credentials store 中的 Today 账号凭据。 */
export interface TodayCredential {
  /** 规范化后的完整 Cookie 请求头串。 */
  readonly cookie_raw: string
  /** 站点域（`cn` = todayai.cn，`global` = today.ai）。 */
  readonly realm: TodayRealm
  readonly user_id?: string
  readonly email?: string
  readonly plan?: string
  readonly nickname?: string
}

/** 带有 HTTP 状态码的上游调用错误。 */
export class TodayUpstreamError extends Error {
  readonly status: number
  readonly retryAfterMs?: number

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message)
    this.name = 'TodayUpstreamError'
    this.status = status
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      this.retryAfterMs = retryAfterMs
    }
  }
}

/** `normalizeTodayCookieInput` 返回结果。 */
export interface NormalizedTodayCookie {
  readonly header: string
  readonly realmHint?: TodayRealm
}

/** 内存缓存的 API JWT（避免每次调用都重打 `/api/token`）。 */
interface CachedJwtEntry {
  token: string
  expiresAtMs: number
}

/** 已确认的上游选中模型缓存（避免每次请求都多打一次 `/v1/pricing/status`）。 */
interface CachedModelSelection {
  optionId: string
  checkedAtMs: number
}

const jwtCache = new Map<string, CachedJwtEntry>()
const selectedModelCache = new Map<string, CachedModelSelection>()
const MODEL_SELECTION_TTL_MS = 10 * 60_000
const JWT_REFRESH_LEAD_MS = 60_000
const DEFAULT_HTTP_TIMEOUT_MS = 30_000

/** 仅供单测清空运行时缓存。 */
export function clearTodayRuntimeCaches(): void {
  jwtCache.clear()
  selectedModelCache.clear()
}

/** 计算凭据稳定指纹，用作 JWT / 模型选择缓存键与去重依据。 */
export function todayCredentialFingerprint(cookieRaw: string): string {
  return createHash('sha256').update(cookieRaw, 'utf8').digest('hex')
}

/** 按凭据身份或指纹生成简短账号标识后缀。 */
export function todayAccountSuffix(credential: Pick<TodayCredential, 'user_id' | 'cookie_raw'>): string {
  const seed = credential.user_id && credential.user_id.length > 0
    ? credential.user_id
    : credential.cookie_raw
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 12)
}

/** 解析凭据 JSON 字符串；若非合法 TodayCredential 返回 `undefined`。 */
export function parseTodayCredential(
  raw: string | undefined | null,
  expectedRealm?: TodayRealm,
): TodayCredential | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const o = parsed as Record<string, unknown>

  const rawCookie = typeof o.cookie_raw === 'string' && o.cookie_raw.trim().length > 0
    ? o.cookie_raw
    : typeof o.session === 'string' && o.session.trim().length > 0
      ? o.session
      : ''
  if (rawCookie.length === 0) return undefined

  const normalized = normalizeTodayCookieInput(rawCookie)
  if (normalized.header.length === 0) return undefined

  const rawRealm = typeof o.realm === 'string' ? o.realm.trim().toLowerCase() : ''
  const realm: TodayRealm = rawRealm === 'cn'
    ? 'cn'
    : rawRealm === 'global'
      ? 'global'
      : normalized.realmHint ?? expectedRealm ?? 'global'

  return {
    cookie_raw: normalized.header,
    realm,
    ...(typeof o.user_id === 'string' && o.user_id.length > 0 ? { user_id: o.user_id } : {}),
    ...(typeof o.email === 'string' && o.email.length > 0 ? { email: o.email } : {}),
    ...(typeof o.plan === 'string' && o.plan.length > 0 ? { plan: o.plan } : {}),
    ...(typeof o.nickname === 'string' && o.nickname.length > 0 ? { nickname: o.nickname } : {}),
  }
}

// ── Cookie 清洗与提取（移植自 cpa-today-plugin/internal/today/cookie.go） ──

const COOKIE_ATTR_KEYS = new Set([
  'path', 'domain', 'max-age', 'expires', 'samesite', 'httponly', 'secure', 'partitioned', 'priority',
])

function isCookieName(name: string): boolean {
  return name.length > 0 && /^[0-9A-Za-z!#$%&'*+\-.^_`|~]+$/.test(name)
}

function isCookieAttribute(seg: string): boolean {
  const eq = seg.indexOf('=')
  const key = (eq >= 0 ? seg.slice(0, eq) : seg).trim().toLowerCase()
  return COOKIE_ATTR_KEYS.has(key)
}

function isBetterAuthCookie(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('better-auth') || lower.includes('session_token') || lower.includes('session_data')
}

function unquoteOuter(s: string): string {
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
      return s.slice(1, -1)
    }
  }
  return s
}

function removeAllWhitespace(s: string): string {
  return s.replace(/\s+/g, '')
}

function encodeBetterAuthValue(val: string): string {
  let decoded = val
  if (decoded.includes('%')) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      // 保留原始文本，避免畸形百分号转义抛出 URIError
    }
  }
  return encodeURIComponent(decoded)
}

function formatCookiePair(name: string, value: string): string {
  const cleanName = name.trim()
  let cleanVal = unquoteOuter(value.trim())
  if (isBetterAuthCookie(cleanName)) {
    cleanVal = encodeBetterAuthValue(cleanVal)
  }
  return `${cleanName}=${cleanVal}`
}

function stripCookieHeaderPrefix(s: string): { rest: string; stripped: boolean } {
  const trimmed = s.trim()
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('cookie:')) {
    return { rest: trimmed.slice('cookie:'.length).trim(), stripped: true }
  }
  if (lower.startsWith('set-cookie:')) {
    return { rest: trimmed.slice('set-cookie:'.length).trim(), stripped: true }
  }
  return { rest: trimmed, stripped: false }
}

function parseCookieString(raw: string): string {
  let s = raw.trim().replace(/\r/g, '')
  for (;;) {
    const { rest, stripped } = stripCookieHeaderPrefix(s)
    if (!stripped) break
    s = rest
  }
  s = unquoteOuter(s.trim())
  if (s.length === 0) return ''

  if (s.includes(';')) {
    s = s.replace(/\n/g, ' ')
    const pairs: string[] = []
    for (const rawSeg of s.split(';')) {
      const seg = rawSeg.trim()
      if (seg.length === 0 || isCookieAttribute(seg)) continue
      const eq = seg.indexOf('=')
      if (eq < 0) {
        if (pairs.length === 0) {
          pairs.push(formatCookiePair(TODAY_SESSION_COOKIE_NAME, removeAllWhitespace(seg)))
        }
        continue
      }
      const lhs = seg.slice(0, eq).trim()
      const rhs = seg.slice(eq + 1).trim()
      if (rhs.replace(/=+$/, '').length === 0 || !isCookieName(lhs)) {
        if (lhs.length > 0 && !COOKIE_ATTR_KEYS.has(lhs.toLowerCase())) {
          pairs.push(formatCookiePair(TODAY_SESSION_COOKIE_NAME, removeAllWhitespace(seg)))
        }
        continue
      }
      if (rhs.length > 0) {
        pairs.push(formatCookiePair(lhs, rhs))
      }
    }
    return pairs.join('; ')
  }

  const eq = s.indexOf('=')
  if (eq < 0) {
    const clean = removeAllWhitespace(unquoteOuter(s))
    return clean.length === 0 ? '' : formatCookiePair(TODAY_SESSION_COOKIE_NAME, clean)
  }
  const lhs = s.slice(0, eq).trim()
  const rhs = s.slice(eq + 1).trim()
  if (rhs.replace(/=+$/, '').length === 0 || !isCookieName(lhs)) {
    const clean = removeAllWhitespace(unquoteOuter(s))
    return clean.length === 0 ? '' : formatCookiePair(TODAY_SESSION_COOKIE_NAME, clean)
  }
  return formatCookiePair(lhs, removeAllWhitespace(unquoteOuter(rhs)))
}

function detectRealmHint(text: string): TodayRealm | undefined {
  const lower = text.toLowerCase()
  const hasCN = lower.includes('todayai.cn') || lower.includes('mytoday.cn')
  const hasGlobal = lower.includes('today.ai')
  if (hasCN && !hasGlobal) return 'cn'
  if (hasGlobal && !hasCN) return 'global'
  return undefined
}

function tryParseCookieJson(trimmed: string): { header: string; realmHint?: TodayRealm } | undefined {
  if (trimmed.startsWith('[')) {
    try {
      const items = JSON.parse(trimmed) as unknown
      if (Array.isArray(items)) {
        const pairs: string[] = []
        let realmHint: TodayRealm | undefined
        for (const item of items) {
          if (typeof item !== 'object' || item === null) continue
          const obj = item as Record<string, unknown>
          if (realmHint === undefined && typeof obj.domain === 'string') {
            realmHint = detectRealmHint(obj.domain)
          }
          const name = typeof obj.name === 'string' ? obj.name.trim() : ''
          const val = typeof obj.value === 'string' ? obj.value.trim() : ''
          if (name.length > 0 && val.length > 0 && isCookieName(name)) {
            pairs.push(formatCookiePair(name, val))
          }
        }
        return { header: pairs.join('; '), ...(realmHint ? { realmHint } : {}) }
      }
    } catch {
      return undefined
    }
  }
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof obj !== 'object' || obj === null) return undefined
      let realmHint: TodayRealm | undefined
      if (typeof obj.realm === 'string') {
        const r = obj.realm.trim().toLowerCase()
        if (r === 'cn' || r === 'global') realmHint = r
      }
      if (realmHint === undefined && typeof obj.domain === 'string') {
        realmHint = detectRealmHint(obj.domain)
      }
      if (typeof obj.cookie_raw === 'string' && obj.cookie_raw.trim().length > 0) {
        const sub = normalizeTodayCookieInput(obj.cookie_raw)
        return { header: sub.header, ...(realmHint ?? sub.realmHint ? { realmHint: realmHint ?? sub.realmHint } : {}) }
      }
      if (typeof obj.session === 'string' && obj.session.trim().length > 0) {
        const sub = normalizeTodayCookieInput(obj.session)
        return { header: sub.header, ...(realmHint ?? sub.realmHint ? { realmHint: realmHint ?? sub.realmHint } : {}) }
      }
      if (typeof obj.name === 'string' && typeof obj.value === 'string'
        && obj.name.trim().length > 0 && obj.value.trim().length > 0) {
        return {
          header: formatCookiePair(obj.name.trim(), obj.value.trim()),
          ...(realmHint ? { realmHint } : {}),
        }
      }
      if (typeof obj.session === 'object' && obj.session !== null) {
        const sessObj = obj.session as Record<string, unknown>
        if (typeof sessObj.token === 'string' && sessObj.token.trim().length > 0) {
          return {
            header: formatCookiePair(TODAY_SESSION_COOKIE_NAME, sessObj.token.trim()),
            ...(realmHint ? { realmHint } : {}),
          }
        }
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

function unescapeCmdCarets(s: string): string {
  const work = s.replace(/\^\r?\n/g, ' ')
  let out = ''
  for (let i = 0; i < work.length; i++) {
    if (work[i] === '^' && i + 1 < work.length) {
      out += work[i + 1]
      i++
      continue
    }
    out += work[i]
  }
  return out
}

function unescapeQuotes(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\'/g, '\'').replace(/\\\\/g, '\\')
}

function tryExtractFromCommand(s: string): string | undefined {
  let work = s
  if (work.toLowerCase().startsWith('curl') && work.includes('^')) {
    work = unescapeCmdCarets(work)
  }
  work = work.replace(/\\\r?\n/g, ' ')

  const parts: string[] = []
  const reCookieFlag = /(?:^|\s)(?:-b|--cookie)(?:=|\s+)(?:'([^']+)'|"((?:\\.|[^"\\])+)"|(\S+))/gi
  for (const m of work.matchAll(reCookieFlag)) {
    const val = (m[1] ?? (m[2] !== undefined ? unescapeQuotes(m[2]) : m[3]) ?? '').trim()
    if (val.length > 0) parts.push(val)
  }
  const reHeaderFlag = /(?:-H|--header)(?:=|\s+)(?:'(?:set-)?cookie\s*:\s*([^']+)'|"(?:set-)?cookie\s*:\s*((?:\\.|[^"\\])+)")/gi
  for (const m of work.matchAll(reHeaderFlag)) {
    const val = (m[1] ?? (m[2] !== undefined ? unescapeQuotes(m[2]) : '')).trim()
    if (val.length > 0) parts.push(val)
  }
  if (parts.length > 0) return parts.join('; ')

  const reFetchCookie = /["']cookie["']\s*:\s*(?:"((?:\\.|[^"\\])+)"|'((?:\\.|[^'\\])+)')/i
  const fetchMatch = reFetchCookie.exec(work)
  if (fetchMatch !== null) {
    const val = (fetchMatch[1] !== undefined ? unescapeQuotes(fetchMatch[1]) : unescapeQuotes(fetchMatch[2] ?? '')).trim()
    if (val.length > 0) return val
  }

  const rePsCookie = /System\.Net\.Cookie\(\s*"([^"]+)"\s*,\s*"([^"]*)"/gi
  const psParts: string[] = []
  for (const m of work.matchAll(rePsCookie)) {
    const k = m[1]?.trim() ?? ''
    const v = m[2]?.trim() ?? ''
    if (k.length > 0 && v.length > 0) psParts.push(`${k}=${v}`)
  }
  if (psParts.length > 0) return psParts.join('; ')

  return undefined
}

function tryExtractHeaderLines(s: string): string | undefined {
  if (!s.includes('\n')) return undefined
  const collected: string[] = []
  for (const rawLine of s.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (line.length === 0) continue
    const { rest, stripped } = stripCookieHeaderPrefix(line)
    if (stripped && rest.length > 0) {
      const parsed = parseCookieString(rest)
      if (parsed.length > 0) collected.push(parsed)
    }
  }
  return collected.length > 0 ? collected.join('; ') : undefined
}

function tryExtractTabRows(s: string): string | undefined {
  if (!s.includes('\t')) return undefined
  const pairs: string[] = []
  for (const rawLine of s.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (line.length === 0 || !line.includes('\t')) continue
    const cols = line.split('\t')
    if (cols.length < 2) continue
    const name = cols[0]?.trim() ?? ''
    const val = cols[1]?.trim() ?? ''
    if (name.length === 0 || val.length === 0 || name.toLowerCase() === 'name') continue
    if (isCookieName(name)) pairs.push(formatCookiePair(name, val))
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined
}

/** 清洗用户粘贴的 Cookie 文本并提取站点域名提示（`cn` / `global`）。 */
export function normalizeTodayCookieInput(raw: string): NormalizedTodayCookie {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { header: '' }
  const realmHint = detectRealmHint(trimmed)

  const fromJson = tryParseCookieJson(trimmed)
  if (fromJson !== undefined) {
    const hint = fromJson.realmHint ?? realmHint
    return { header: fromJson.header, ...(hint ? { realmHint: hint } : {}) }
  }

  const fromCmd = tryExtractFromCommand(trimmed)
  if (fromCmd !== undefined) {
    return { header: parseCookieString(fromCmd), ...(realmHint ? { realmHint } : {}) }
  }

  const fromHeaders = tryExtractHeaderLines(trimmed)
  if (fromHeaders !== undefined) {
    return { header: fromHeaders, ...(realmHint ? { realmHint } : {}) }
  }

  const fromTab = tryExtractTabRows(trimmed)
  if (fromTab !== undefined) {
    return { header: fromTab, ...(realmHint ? { realmHint } : {}) }
  }

  return { header: parseCookieString(trimmed), ...(realmHint ? { realmHint } : {}) }
}

/** 从响应头 Set-Cookie 提取 Better Auth 会话 Cookie。 */
export function extractTodayCookiesFromHeaders(headers: Headers): string {
  const rawList = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : headers.get('set-cookie') !== null
      ? [headers.get('set-cookie')!]
      : []
  const parts: string[] = []
  const seen = new Map<string, number>()
  for (const raw of rawList) {
    const segments = raw.split(';')
    const nv = segments[0]?.trim() ?? ''
    const eq = nv.indexOf('=')
    if (eq <= 0) continue
    const name = nv.slice(0, eq).trim()
    const val = nv.slice(eq + 1).trim()
    if (val.length === 0 || !isBetterAuthCookie(name)) continue
    const cleared = segments.slice(1).some((attr) => {
      const lower = attr.trim().toLowerCase()
      if (!lower.startsWith('max-age=')) return false
      const v = lower.slice('max-age='.length).trim()
      return v === '0' || v.startsWith('-')
    })
    if (cleared) continue
    const pair = formatCookiePair(name, val)
    const idx = seen.get(name)
    if (idx !== undefined) {
      parts[idx] = pair
    } else {
      seen.set(name, parts.length)
      parts.push(pair)
    }
  }
  return parts.join('; ')
}

/** 对 401/403 拒绝结果给出明确的中文排障提示。 */
export function diagnoseTodayCookieFailure(cookieHeader: string): string {
  const sessionValues: string[] = []
  for (const seg of cookieHeader.split(';')) {
    const s = seg.trim()
    const eq = s.indexOf('=')
    if (eq <= 0) continue
    const name = s.slice(0, eq).trim()
    let val = s.slice(eq + 1).trim()
    if (name.toLowerCase().includes('session_token') && val.length > 0) {
      try {
        val = decodeURIComponent(val)
      } catch {
        // 保留原值
      }
      sessionValues.push(val)
    }
  }
  if (sessionValues.length === 0) {
    return '未在粘贴内容中找到 __Secure-better-auth.session_token（请先在浏览器登录 todayai.cn 或 today.ai，再从 F12 → Application → Cookies 中复制该项）'
  }
  if (sessionValues.some((v) => v.includes('.'))) {
    return 'Cookie 已被上游拒绝（会话可能已过期或在浏览器中退出登录，请重新复制最新的 __Secure-better-auth.session_token）'
  }
  return 'session_token 缺少签名段（完整值形如 xxx.yyy=），请从浏览器 F12 → Application → Cookies 中复制完整的 __Secure-better-auth.session_token 值'
}

// ── 上游 HTTP 客户端 ──

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const dateMs = Date.parse(raw)
  if (Number.isFinite(dateMs) && dateMs > Date.now()) return dateMs - Date.now()
  return undefined
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<{ status: number; headers: Headers; text: string; json: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs)
  const signal = init.signal === undefined || init.signal === null
    ? controller.signal
    : AbortSignal.any([init.signal, controller.signal])
  try {
    const response = await fetcher(url, { ...init, signal })
    const text = await response.text().catch(() => '')
    let json: unknown
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    return { status: response.status, headers: response.headers, text, json }
  } finally {
    clearTimeout(timer)
  }
}

/** 用 session cookie 向 `{appBase}/api/token` 换出 API JWT（带缓存）。 */
export async function exchangeTodayJwt(
  credential: TodayCredential,
  product: TodayProduct,
  options: { fetcher?: typeof fetch; signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<string> {
  const fetcher = options.fetcher ?? globalThis.fetch
  const fp = `${product.id}:${todayCredentialFingerprint(credential.cookie_raw)}`
  if (!options.forceRefresh) {
    const cached = jwtCache.get(fp)
    if (cached !== undefined && Date.now() + JWT_REFRESH_LEAD_MS < cached.expiresAtMs) {
      return cached.token
    }
  }
  const { status, text, json } = await fetchJson(
    `${product.appBase}/api/token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: credential.cookie_raw,
        Origin: product.appBase,
        Referer: `${product.appBase}/`,
      },
      body: JSON.stringify({ audience: product.apiBase, expiresIn: 3600 }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    fetcher,
  )
  if (status === 401 || status === 403) {
    jwtCache.delete(fp)
    throw new TodayUpstreamError(`today session cookie rejected (${status}): ${text.slice(0, 200)}`, status)
  }
  if (status !== 200) {
    throw new TodayUpstreamError(`token exchange failed: HTTP ${status} ${text.slice(0, 200)}`, status)
  }
  const obj = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  const token = typeof obj.token === 'string' ? obj.token : ''
  if (token.length === 0) {
    throw new TodayUpstreamError(`token response missing token field: ${text.slice(0, 200)}`, 502)
  }
  const expiresIn = typeof obj.expiresIn === 'number' && obj.expiresIn > 0 ? obj.expiresIn : 3600
  jwtCache.set(fp, { token, expiresAtMs: Date.now() + expiresIn * 1000 })
  return token
}

/** 调用 `{apiBase}/v1/*`，遇到 401 时强制刷新一次 JWT 重试。 */
async function callTodayApi(
  credential: TodayCredential,
  product: TodayProduct,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body: unknown,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ status: number; headers: Headers; text: string; json: unknown }> {
  const fetcher = options.fetcher ?? globalThis.fetch
  const runOnce = async (forceRefresh: boolean) => {
    const jwt = await exchangeTodayJwt(credential, product, {
      fetcher,
      forceRefresh,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return await fetchJson(
      `${product.apiBase}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${jwt}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      fetcher,
    )
  }
  const first = await runOnce(false)
  if (first.status !== 401) return first
  return await runOnce(true)
}

/** 拉取当前用户信息 `/v1/users/me`。 */
export async function fetchTodayMe(
  credential: TodayCredential,
  product: TodayProduct,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ id?: string; email?: string; plan?: string }> {
  const res = await callTodayApi(credential, product, 'GET', '/v1/users/me', undefined, options)
  if (res.status !== 200) {
    throw new TodayUpstreamError(
      `users/me failed: HTTP ${res.status} ${res.text.slice(0, 200)}`,
      res.status,
      parseRetryAfterMs(res.headers),
    )
  }
  const obj = (typeof res.json === 'object' && res.json !== null ? res.json : {}) as Record<string, unknown>
  return {
    ...(typeof obj.id === 'string' && obj.id.length > 0 ? { id: obj.id } : {}),
    ...(typeof obj.email === 'string' && obj.email.length > 0 ? { email: obj.email } : {}),
    ...(typeof obj.plan === 'string' && obj.plan.length > 0 ? { plan: obj.plan } : {}),
  }
}

/** 拉取 `/v1/pricing/status` 中的 `data.status`。 */
export async function fetchTodayPricingStatus(
  credential: TodayCredential,
  product: TodayProduct,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  const res = await callTodayApi(credential, product, 'GET', '/v1/pricing/status', undefined, options)
  if (res.status !== 200) {
    throw new TodayUpstreamError(
      `pricing/status failed: HTTP ${res.status} ${res.text.slice(0, 200)}`,
      res.status,
      parseRetryAfterMs(res.headers),
    )
  }
  const root = (typeof res.json === 'object' && res.json !== null ? res.json : {}) as Record<string, unknown>
  const data = (typeof root.data === 'object' && root.data !== null ? root.data : {}) as Record<string, unknown>
  const statusObj = (typeof data.status === 'object' && data.status !== null ? data.status : undefined)
  if (statusObj === undefined) {
    throw new TodayUpstreamError(`pricing/status missing data.status: ${res.text.slice(0, 200)}`, 502)
  }
  return statusObj as Record<string, unknown>
}

/** 从 `/v1/pricing/status` 提取当前可用模型目录。 */
export function parseTodayModelsFromPricingStatus(status: Record<string, unknown>): TodayModelEntry[] {
  const modelOptions = (typeof status.modelOptions === 'object' && status.modelOptions !== null
    ? status.modelOptions
    : undefined) as Record<string, unknown> | undefined
  if (modelOptions === undefined || !Array.isArray(modelOptions.options)) {
    return []
  }
  const out: TodayModelEntry[] = []
  const seen = new Set<string>()
  for (const raw of modelOptions.options) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const optionId = typeof item.id === 'string' ? item.id.trim() : ''
    if (optionId.length === 0 || item.disabled === true) continue
    const shortId = optionId.startsWith('model.') ? optionId.slice('model.'.length) : optionId
    if (shortId.length === 0 || seen.has(shortId)) continue
    seen.add(shortId)
    const known = TODAY_KNOWN_MODELS.find((m) => m.id === shortId)
    const displayObj = (typeof item.display === 'object' && item.display !== null
      ? item.display
      : undefined) as Record<string, unknown> | undefined
    const title = typeof displayObj?.title === 'string' && displayObj.title.trim().length > 0
      ? displayObj.title.trim()
      : (known?.name ?? shortId)
    out.push({
      optionId,
      id: shortId,
      name: title,
      /**
       * ⚠️⚠️ **未知模型不得虚构 `contextWindow` / `maxTokens`**（2026-11-27 正向审计）。
       *
       * 这里原本是 `?? 131_072` / `?? 8_192` —— **凭空编两个数**，而 PR 自述写的是
       * 「未知模型不虚构 `contextWindow`」⇒ **自述与实现相反**。
       *
       * ## 为什么「编一个数」比「不声明」更糟（本仓成文纪律）
       *
       * - `contextWindow` 编大了（如 1,048,576）⇒ **自动压缩在 90 万 token 才触发**，
       *   而在那之前上游早就 `CONTEXT_WINDOW_EXCEEDED` ⇒ 用户看到的是「莫名报错」；
       * - `maxTokens` 编小了（如 8,192）⇒ **长回答被静默截断**；
       * - 两者都会被当成**真实能力**传给宿主，宿主据此做压缩/预算决策 ⇒
       *   **错的分母比没有分母更难查**（本仓 `providers-baizhi.md` 记过同型事故）。
       *
       * ⇒ 未知就是 `undefined`：宿主会退化成「不显示占用条 / 用默认预算」，
       *   那至少是**诚实的降级**，而不是一个假数字。
       */
      contextWindow: known?.contextWindow,
      maxTokens: known?.maxTokens,
    })
  }
  return out
}

/** 确保上游选中了目标模型选项（10 分钟内相同选择做内存缓存跳过）。 */
export async function ensureTodayModelOption(
  credential: TodayCredential,
  product: TodayProduct,
  optionId: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<void> {
  const cacheKey = `${product.id}:${todayCredentialFingerprint(credential.cookie_raw)}`
  const cached = selectedModelCache.get(cacheKey)
  if (cached !== undefined && cached.optionId === optionId && Date.now() - cached.checkedAtMs < MODEL_SELECTION_TTL_MS) {
    return
  }
  try {
    const status = await fetchTodayPricingStatus(credential, product, options)
    const modelOptions = (typeof status.modelOptions === 'object' && status.modelOptions !== null
      ? status.modelOptions
      : undefined) as Record<string, unknown> | undefined
    const selected = typeof modelOptions?.selectedOptionId === 'string' ? modelOptions.selectedOptionId : ''
    if (selected === optionId) {
      selectedModelCache.set(cacheKey, { optionId, checkedAtMs: Date.now() })
      return
    }
  } catch (error) {
    // 读不到当前模型不算致命，但认证/限流错误要冒泡以便外层换号
    if (error instanceof TodayUpstreamError && (error.status === 401 || error.status === 403 || error.status === 429 || error.status === 402)) {
      throw error
    }
  }
  const putRes = await callTodayApi(
    credential,
    product,
    'PUT',
    '/v1/pricing/model-option',
    { optionId },
    options,
  )
  if (putRes.status !== 200 && putRes.status !== 204) {
    throw new TodayUpstreamError(
      `pricing/model-option failed: HTTP ${putRes.status} ${putRes.text.slice(0, 200)}`,
      putRes.status,
      parseRetryAfterMs(putRes.headers),
    )
  }
  selectedModelCache.set(cacheKey, { optionId, checkedAtMs: Date.now() })
}

/** 发送一轮用户消息，返回 `threadId`。 */
export async function sendTodayMessage(
  credential: TodayCredential,
  product: TodayProduct,
  text: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal; threadId?: string } = {},
): Promise<string> {
  const clientMessageId = `msg_${randomBytes(12).toString('hex')}`
  const body: Record<string, unknown> = {
    content: text,
    messageType: 'text',
    clientMessageId,
    // ⚠️ channel 必填：缺了它消息不进主对话，后续轮询查不到这条 thread
    channel: 'main',
  }
  if (options.threadId && options.threadId.length > 0) {
    body.threadId = options.threadId
  }
  const res = await callTodayApi(credential, product, 'POST', '/v1/messages', body, options)
  if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
    throw new TodayUpstreamError(
      `messages failed: HTTP ${res.status} ${res.text.slice(0, 200)}`,
      res.status,
      parseRetryAfterMs(res.headers),
    )
  }
  const obj = (typeof res.json === 'object' && res.json !== null ? res.json : {}) as Record<string, unknown>
  const threadId = typeof obj.threadId === 'string' ? obj.threadId : ''
  if (threadId.length === 0) {
    throw new TodayUpstreamError(`messages response missing threadId: ${res.text.slice(0, 200)}`, 502)
  }
  return threadId
}

interface ConversationMessageItem {
  readonly threadId: string
  readonly role: string
  readonly state: string
  readonly isFinal: boolean
  readonly text: string
}

function extractConversationItems(json: unknown): ConversationMessageItem[] {
  const root = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  const data = (typeof root.data === 'object' && root.data !== null ? root.data : {}) as Record<string, unknown>
  if (!Array.isArray(data.items)) return []
  const out: ConversationMessageItem[] = []
  for (const raw of data.items) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const body = (typeof item.body === 'object' && item.body !== null ? item.body : {}) as Record<string, unknown>
    const parts = Array.isArray(body.parts) ? body.parts : []
    let text = ''
    for (const p of parts) {
      if (typeof p !== 'object' || p === null) continue
      const part = p as Record<string, unknown>
      if (part.messageType !== 'text') continue
      const content = (typeof part.content === 'object' && part.content !== null ? part.content : {}) as Record<string, unknown>
      if (typeof content.text === 'string') text += content.text
    }
    out.push({
      threadId: typeof item.threadId === 'string' ? item.threadId : '',
      role: typeof item.role === 'string' ? item.role : '',
      state: typeof item.state === 'string' ? item.state : '',
      isFinal: item.isFinal === true,
      text,
    })
  }
  return out
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 轮询 `GET /v1/conversations/messages` 直到助手回复完成，期间增量推送 delta。 */
export async function pollTodayReply(
  credential: TodayCredential,
  product: TodayProduct,
  threadId: string,
  options: {
    fetcher?: typeof fetch
    signal?: AbortSignal
    timeoutMs?: number
    initialIntervalMs?: number
    maxIntervalMs?: number
    onDelta?: (delta: string) => void
  } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? product.fetchTimeoutMs
  const deadline = Date.now() + timeoutMs
  let intervalMs = options.initialIntervalMs ?? product.initialPollIntervalMs
  const maxIntervalMs = options.maxIntervalMs ?? product.maxPollIntervalMs
  let last = ''

  for (;;) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('aborted')
    }
    if (Date.now() > deadline) {
      if (last.length > 0) return last
      throw new TodayUpstreamError(`today upstream did not answer within ${timeoutMs}ms`, 504)
    }
    const res = await callTodayApi(
      credential,
      product,
      'GET',
      '/v1/conversations/messages?isMainChat=true&limit=3',
      undefined,
      options,
    )
    if (res.status !== 200) {
      throw new TodayUpstreamError(
        `conversations/messages failed: HTTP ${res.status} ${res.text.slice(0, 200)}`,
        res.status,
        parseRetryAfterMs(res.headers),
      )
    }
    const items = extractConversationItems(res.json)
    for (const item of items) {
      if (item.threadId !== threadId || item.role !== 'assistant') continue
      if (item.text.length === 0) continue
      if (options.onDelta && item.text.length > last.length && item.text.startsWith(last)) {
        options.onDelta(item.text.slice(last.length))
      }
      last = item.text
      if (item.state === 'completed' || item.isFinal) {
        return item.text
      }
    }
    await sleepAbortable(intervalMs, options.signal)
    if (intervalMs < maxIntervalMs) {
      intervalMs = Math.min(maxIntervalMs, intervalMs + 100)
    }
  }
}

/** 国际版发送邮箱 OTP 验证码。 */
export async function sendTodayEmailOtp(
  email: string,
  product: TodayProduct,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (!product.supportsEmailOtp) {
    throw new TodayUpstreamError('国内版 todayai.cn 已停用邮箱验证码登录，请使用粘贴浏览器 Cookie 方式', 400)
  }
  const res = await fetchJson(
    `${product.authBase}/api/auth/email-otp/send-verification-otp`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: product.appBase,
        Referer: `${product.appBase}/`,
      },
      body: JSON.stringify({ email: email.trim(), type: 'sign-in' }),
    },
    fetcher,
  )
  if (res.status === 200) return
  if (res.text.includes('email_sign_in_disabled')) {
    throw new TodayUpstreamError('当前站点已停用邮箱验证码登录，请改用粘贴浏览器 Cookie 方式', 400)
  }
  throw new TodayUpstreamError(
    `发送验证码失败: HTTP ${res.status} ${res.text.slice(0, 200)}`,
    res.status,
    parseRetryAfterMs(res.headers),
  )
}

/** 国际版使用邮箱 OTP 验证码换取 Cookie。 */
export async function verifyTodayEmailOtp(
  email: string,
  otp: string,
  product: TodayProduct,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<string> {
  if (!product.supportsEmailOtp) {
    throw new TodayUpstreamError('国内版 todayai.cn 已停用邮箱验证码登录，请使用粘贴浏览器 Cookie 方式', 400)
  }
  const res = await fetchJson(
    `${product.authBase}/api/auth/sign-in/email-otp`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: product.appBase,
        Referer: `${product.appBase}/`,
      },
      body: JSON.stringify({ email: email.trim(), otp: otp.trim() }),
    },
    fetcher,
  )
  if (res.status !== 200) {
    if (res.text.includes('email_sign_in_disabled')) {
      throw new TodayUpstreamError('当前站点已停用邮箱验证码登录，请改用粘贴浏览器 Cookie 方式', 400)
    }
    throw new TodayUpstreamError(`邮箱验证码登录失败: HTTP ${res.status} ${res.text.slice(0, 200)}`, res.status)
  }
  const cookieHeader = extractTodayCookiesFromHeaders(res.headers)
  if (cookieHeader.length === 0) {
    throw new TodayUpstreamError('登录成功但服务端未下发 session cookie', 502)
  }
  return cookieHeader
}

/** 按目标产品校验 Cookie 有效性与跨站误填检测。 */
export async function authenticateTodayCookie(
  rawCookie: string,
  product: TodayProduct,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<TodayCredential> {
  const normalized = normalizeTodayCookieInput(rawCookie)
  if (normalized.header.length === 0) {
    throw new TodayUpstreamError('Cookie 内容为空或格式无法识别', 400)
  }
  const altProduct = product.id === TODAY.id ? TODAY_INTL : TODAY
  if (normalized.realmHint !== undefined && normalized.realmHint !== product.realm) {
    throw new TodayUpstreamError(
      `检测到这份 Cookie 来自 ${altProduct.displayName}（${altProduct.appBase}），请在「${altProduct.displayName}」渠道里添加。`,
      400,
    )
  }
  const cred: TodayCredential = { cookie_raw: normalized.header, realm: product.realm }
  try {
    await exchangeTodayJwt(cred, product, { fetcher, forceRefresh: true })
  } catch (error) {
    if (error instanceof TodayUpstreamError && (error.status === 401 || error.status === 403)) {
      // 检查是否误粘贴了另一站点的 Cookie
      const altCred: TodayCredential = { cookie_raw: normalized.header, realm: altProduct.realm }
      try {
        await exchangeTodayJwt(altCred, altProduct, { fetcher, forceRefresh: true })
        throw new TodayUpstreamError(
          `该 Cookie 属于 ${altProduct.displayName}（${altProduct.appBase}），请切换到「${altProduct.displayName}」渠道添加。`,
          400,
        )
      } catch (altErr) {
        if (altErr instanceof TodayUpstreamError && altErr.status === 400) throw altErr
      }
      throw new TodayUpstreamError(`凭证验证失败：${diagnoseTodayCookieFailure(normalized.header)}`, 400)
    }
    throw error
  }
  let me: { id?: string; email?: string; plan?: string } = {}
  try {
    me = await fetchTodayMe(cred, product, { fetcher })
  } catch {
    // `/v1/users/me` 偶发不可达时不阻断登录
  }
  const nickname = me.email && me.email.length > 0
    ? me.email
    : `Today-${todayAccountSuffix({ ...cred, ...me }).slice(0, 8)}`
  return {
    cookie_raw: normalized.header,
    realm: product.realm,
    ...(me.id ? { user_id: me.id } : {}),
    ...(me.email ? { email: me.email } : {}),
    ...(me.plan ? { plan: me.plan } : {}),
    nickname,
  }
}
