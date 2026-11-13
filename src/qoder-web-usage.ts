/**
 * Qoder「资源包」逐笔到期的两个来源（issue IKTLMX 的后续）。
 *
 * `/sash/api/v2/me/usage` 的 `addOnQuota` 只给聚合标量，卡片只能写「到期未知」。
 * 逐笔到期只能从下面两处拿到：
 *
 * 1. **网页会话明细**（准确）：`GET {官网}/api/v2/me/usages/big_model_credits`，
 *    即官方「用量明细」页的数据源。它**只认浏览器登录后的会话 Cookie**，
 *    OAuth `access_token` 一律 401（本仓与 CodexBar / CreditDaddy /
 *    qoder-trae-workbuddy-switch / TraeWorkAssistant 实测一致）⇒ 需要用户手动粘贴 Cookie。
 * 2. **本地领取记录**（推算）：每日领取的响应顶层带 `expiresAt`，领取成功时记下
 *    「金额 + 到期」。剩余额度按「先到期先扣」分摊到最晚到期的几笔上 ——
 *    扣费顺序是假设，界面文案须注明「推算」。
 *
 * 两者都没有时维持原行为（一整包「到期未知」）。
 *
 * ⚠️ Cookie 是能登录官网的会话凭据：只存凭据库（独立的 `<credentialRef>_web` 条目，
 *    随账号删除一并清理），绝不下发客户端、绝不写日志或错误消息。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CreditBalance, CreditPackage } from './credits.js'
import type { QoderProduct } from './qoder-product.js'

/** 一笔已领取的积分。 */
export interface QoderGrant {
  amount: number
  /** 到期时刻（毫秒）。 */
  expiresAtMs: number
}

/** 网页明细里的一笔资源包（已过滤掉用完 / 失效的）。 */
export interface QoderWebPackage {
  remaining: number
  total: number
  used: number
  /** 到期时刻（毫秒）；`0` = 上游未给。 */
  expiresAtMs: number
}

/** 拆分 `addOnQuota` 的依据。 */
export type QoderAddOnDetail =
  | { kind: 'web'; packages: readonly QoderWebPackage[] }
  | { kind: 'ledger'; grants: readonly QoderGrant[]; nowMs: number }

/** 凭据库里 `<credentialRef>_web` 条目的形状。 */
export interface QoderWebStore {
  /** `k=v; k2=v2` 形状的 Cookie 头。 */
  cookie?: string
  grants?: QoderGrant[]
}

/** 凭据服务的最小依赖面。 */
export interface QoderWebCredentials {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string } | null | undefined>
  set(ref: ReturnType<typeof credentialRef>, value: string): Promise<void>
  unset(ref: ReturnType<typeof credentialRef>): Promise<void>
}

/** 领取记录最多保留的笔数（每天一笔、30 天作废，留足余量）。 */
const MAX_GRANTS = 120

/** `parseQoderUsage` 给 `addOnQuota` 起的包名（判定「哪一包是资源包」只认它）。 */
export const QODER_ADD_ON_PACKAGE = '资源包'

export const QODER_WEB_USAGE_PATH = '/api/v2/me/usages/big_model_credits'

/** 网页明细请求超时（毫秒）。 */
export const QODER_WEB_USAGE_TIMEOUT_MS = 10_000

export function qoderWebRefName(accountCredentialRef: string): string {
  return `${accountCredentialRef}_web`
}

/**
 * 官网站点。中国版有两个域名在用（CodexBar / switch 用 `qoder.com.cn`，
 * TraeWorkAssistant 用 `qoder.cn`），Cookie 按域名隔离 ⇒ 两个都试。
 */
export function qoderWebOrigins(product: Pick<QoderProduct, 'id'>): string[] {
  return product.id === 'qodercn'
    ? ['https://qoder.com.cn', 'https://qoder.cn']
    : ['https://qoder.com']
}

export async function loadQoderWebStore(
  credentials: QoderWebCredentials,
  accountCredentialRef: string,
): Promise<QoderWebStore> {
  try {
    const resolved = await credentials.resolve(credentialRef(qoderWebRefName(accountCredentialRef)))
    if (!resolved) return {}
    return normalizeStore(JSON.parse(resolved.value))
  } catch {
    return {}
  }
}

export async function saveQoderWebStore(
  credentials: QoderWebCredentials,
  accountCredentialRef: string,
  store: QoderWebStore,
): Promise<void> {
  const ref = credentialRef(qoderWebRefName(accountCredentialRef))
  const normalized = normalizeStore(store)
  if (normalized.cookie === undefined && (normalized.grants ?? []).length === 0) {
    try { await credentials.unset(ref) } catch { /* 本就不存在 */ }
    return
  }
  await credentials.set(ref, JSON.stringify(normalized))
}

/** 追加领取记录（顺带丢掉已过期的，按到期去重）。 */
export async function recordQoderGrants(
  credentials: QoderWebCredentials,
  accountCredentialRef: string,
  grants: readonly QoderGrant[],
  nowMs: number = Date.now(),
): Promise<void> {
  if (grants.length === 0) return
  const store = await loadQoderWebStore(credentials, accountCredentialRef)
  const seen = new Set<string>()
  const merged = [...store.grants ?? [], ...grants]
    .filter((g) => g.expiresAtMs > nowMs)
    .filter((g) => {
      const key = `${g.expiresAtMs}:${g.amount}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs)
    .slice(-MAX_GRANTS)
  await saveQoderWebStore(credentials, accountCredentialRef, { ...store, grants: merged })
}

/** 把用户粘贴的内容归一成 Cookie 头：接受裸 Cookie、`Cookie: …` 行或整段 cURL。 */
export function normalizeCookieInput(raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  const curl = /(?:-H|--header)\s+(['"])\s*cookie:\s*([\s\S]*?)\1/i.exec(text)
    ?? /(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/i.exec(text)
  if (curl) return cleanCookie(curl[2]!)
  const line = /^\s*cookie:\s*(.+)$/im.exec(text)
  if (line) return cleanCookie(line[1]!)
  return cleanCookie(text)
}

function cleanCookie(value: string): string {
  return value
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter((part) => /^[^=\s;]+=/.test(part))
    .join('; ')
}

export type QoderWebUsageResult =
  | { ok: true; packages: QoderWebPackage[] }
  | { ok: false; authFailed: boolean; reason: string }

/**
 * 用网页会话 Cookie 取资源包逐笔明细。本身不抛；错误原因里**不含** Cookie。
 */
export async function fetchQoderWebPackages(
  cookie: string,
  product: Pick<QoderProduct, 'id'>,
  fetcher: typeof fetch = fetch,
  timeoutMs: number = QODER_WEB_USAGE_TIMEOUT_MS,
): Promise<QoderWebUsageResult> {
  let lastFailure: QoderWebUsageResult = { ok: false, authFailed: false, reason: '网页会话明细查询失败' }
  for (const origin of qoderWebOrigins(product)) {
    let response: Response
    try {
      response = await fetcher(`${origin}${QODER_WEB_USAGE_PATH}`, {
        method: 'GET',
        headers: {
          Cookie: cookie,
          Accept: 'application/json, text/plain, */*',
          Origin: origin,
          Referer: `${origin}/account/usage`,
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      lastFailure = { ok: false, authFailed: false, reason: `网页会话明细查询失败（网络异常：${reason}）` }
      continue
    }
    if (response.status === 401 || response.status === 403) {
      lastFailure = { ok: false, authFailed: true, reason: `网页会话已失效（HTTP ${response.status}），请重新粘贴 Cookie` }
      continue
    }
    if (!response.ok) {
      lastFailure = { ok: false, authFailed: false, reason: `网页会话明细查询失败（HTTP ${response.status}）` }
      continue
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      lastFailure = { ok: false, authFailed: false, reason: '网页会话明细查询失败（响应不是 JSON）' }
      continue
    }
    const packages = parseQoderWebUsage(body)
    if (packages === undefined) {
      lastFailure = { ok: false, authFailed: false, reason: '网页会话明细查询失败（响应形状不符）' }
      continue
    }
    return { ok: true, packages }
  }
  return lastFailure
}

/**
 * 解析 `big_model_credits` 响应，只取**个人资源包**（与 `addOnQuota` 同源）。
 *
 * 取 `resource_package_quota.quota_detail`；不取 `total_quota`：实测有账号的
 * `total_quota.quota_detail` 只列 PLAN 一条（qoder-trae-workbuddy-switch 的真机样本）。
 * 该族缺失时才回落 `total_quota` 里 `source` 以 `RESOURCE_PACKAGE` 开头的条目。
 *
 * @returns 形状不符时 `undefined`；有响应但没有可用包时 `[]`。
 */
export function parseQoderWebUsage(body: unknown): QoderWebPackage[] | undefined {
  if (!isRecord(body)) return undefined
  const root = isRecord(body.data) && body.quota_key === undefined ? body.data : body
  const own = isRecord(root.resource_package_quota) ? root.resource_package_quota.quota_detail : undefined
  let rows: unknown[]
  if (Array.isArray(own)) {
    rows = own
  } else if (isRecord(root.resource_package_quota)) {
    rows = []
  } else if (isRecord(root.total_quota) && Array.isArray(root.total_quota.quota_detail)) {
    rows = root.total_quota.quota_detail.filter(
      (row) => isRecord(row) && typeof row.source === 'string' && row.source.startsWith('RESOURCE_PACKAGE'),
    )
  } else {
    return undefined
  }
  const out: QoderWebPackage[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const status = typeof row.status === 'string' ? row.status.replace(/^QUOTA_DETAIL_STATUS_/, '') : ''
    if (status !== '' && status !== 'ACTIVE') continue
    if (row.is_active === false) continue
    const total = finite(row.limit_value)
    const used = finite(row.used_value)
    const remaining = finite(row.remaining_value) ?? Math.max(0, (total ?? 0) - (used ?? 0))
    if (!(remaining > 0)) continue
    out.push({
      remaining,
      total: Math.max(total ?? remaining, remaining),
      used: Math.max(0, used ?? 0),
      expiresAtMs: normalizeEpochMs(finite(row.expires_at) ?? finite(row.expiresAt) ?? 0),
    })
  }
  return out
}

/**
 * `expires_at` 单位上游无文档：真机样本里同一响应同时出现毫秒与秒
 * （`1795595404000` 与 `1795595404`）⇒ 小于 1e12 的按秒处理。
 */
export function normalizeEpochMs(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return raw < 1e12 ? raw * 1000 : raw
}

/**
 * 把一整包 `addOnQuota` 按逐笔到期拆开。拆不出任何带日期的包时返回 `undefined`
 * （调用方保留原来那一整包「到期未知」）。
 *
 * 守恒：拆出各包 `remaining` 之和恒等于 `addOn.remaining`，总余额与 sash 口径一致。
 * - 带日期部分合计多于 sash 余额（两次请求之间又用掉了一些）⇒ 按先到期先扣削掉；
 * - 少于 sash 余额（领取记录不全 / 网页明细缺日期）⇒ 差额另列一包「到期未知」。
 */
export function splitAddOnQuota(
  addOn: CreditPackage,
  detail: QoderAddOnDetail,
): CreditPackage[] | undefined {
  const estimated = detail.kind === 'ledger'
  const items = detail.kind === 'web'
    ? detail.packages.filter((p) => p.expiresAtMs > 0).map((p) => ({ amount: p.remaining, expiresAtMs: p.expiresAtMs }))
    : detail.grants.filter((g) => g.amount > 0 && g.expiresAtMs > detail.nowMs)
  if (items.length === 0 || !(addOn.remaining > 0)) return undefined

  // 先到期先扣 ⇒ 剩下的属于最晚到期的那几笔：从最晚往前分配。
  let left = addOn.remaining
  const byDay = new Map<string, { amount: number; expiresAtMs: number }>()
  for (const item of [...items].sort((a, b) => b.expiresAtMs - a.expiresAtMs)) {
    if (left <= 0) break
    const take = Math.min(item.amount, left)
    left -= take
    const day = utc8Day(item.expiresAtMs)
    const prev = byDay.get(day)
    if (prev === undefined) byDay.set(day, { amount: take, expiresAtMs: item.expiresAtMs })
    else byDay.set(day, { amount: prev.amount + take, expiresAtMs: Math.min(prev.expiresAtMs, item.expiresAtMs) })
  }
  if (byDay.size === 0) return undefined

  const name = estimated ? `${QODER_ADD_ON_PACKAGE}（按领取记录推算）` : QODER_ADD_ON_PACKAGE
  const out: CreditPackage[] = [...byDay.values()]
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs)
    .map((part) => ({
      name,
      unit: addOn.unit,
      remaining: round2(part.amount),
      total: round2(part.amount),
      used: 0,
      active: addOn.active,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: new Date(part.expiresAtMs).toISOString(),
      deductionEndTime: part.expiresAtMs,
    }))
  const rest = round2(left)
  if (rest > 0) {
    out.push({ ...addOn, name: QODER_ADD_ON_PACKAGE, remaining: rest, total: rest, used: 0, expiryUnknown: true })
  }
  return out
}

/**
 * 把余额里那一整包「资源包」（`parseQoderUsage` 产出的 `addOnQuota`）换成逐笔到期的包。
 * 拆不出时原样返回。总额不变（`splitAddOnQuota` 守恒）。
 *
 * 刻意在查完余额**之后**做，而不是塞进 `fetchQoderBalanceDetailed`：那条调用
 * 只负责「用该账号的出口查 sash」，到期来源与它无关，混在一起会让每个调用点
 * 都要关心 Cookie / 领取记录。
 */
export function withQoderAddOnDetail(
  balance: CreditBalance | null,
  detail: QoderAddOnDetail | undefined,
): CreditBalance | null {
  if (balance === null || detail === undefined) return balance
  const index = balance.packages.findIndex((p) => p.name === QODER_ADD_ON_PACKAGE && p.expiryUnknown === true)
  if (index === -1) return balance
  const split = splitAddOnQuota(balance.packages[index]!, detail)
  if (split === undefined) return balance
  return {
    ...balance,
    packages: [...balance.packages.slice(0, index), ...split, ...balance.packages.slice(index + 1)],
  }
}

function utc8Day(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStore(raw: unknown): QoderWebStore {
  if (!isRecord(raw)) return {}
  const cookie = typeof raw.cookie === 'string' && raw.cookie.trim() !== '' ? raw.cookie.trim() : undefined
  const grants = Array.isArray(raw.grants)
    ? raw.grants
      .filter(isRecord)
      .map((g) => ({ amount: finite(g.amount) ?? 0, expiresAtMs: finite(g.expiresAtMs) ?? 0 }))
      .filter((g) => g.amount > 0 && g.expiresAtMs > 0)
    : []
  return {
    ...cookie !== undefined ? { cookie } : {},
    ...grants.length > 0 ? { grants } : {},
  }
}
