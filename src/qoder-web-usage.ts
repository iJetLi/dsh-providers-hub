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
  | {
      kind: 'web'
      packages: readonly QoderWebPackage[]
      /**
       * ⚠️ 与 ledger 分支**对称**（2026-11-14 审计 P3）：上游可能给一笔
       * `status: ACTIVE` 但 `expires_at` **已经过去**的明细。不过滤的话它照样
       * 吃掉 `left`，随后又被客户端的 `end > at` 丢掉 ⇒ 各档合计**少于**真实余额，
       * 且 `left` 已归零 ⇒ 连「到期未知」兜底包都不产出（用户看到的总数变小）。
       * 缺省用 `Date.now()`；生产路径由调用方显式传，单测可钉死。
       */
      nowMs?: number
    }
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

/** 粘贴输入的字符上限；真实 Cookie 头极少超过 4 KB，留 2 倍余量。 */
const MAX_COOKIE_INPUT_CHARS = 8192

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

/** 账号卡片的最小依赖面（补布尔标记只需要这一格）。 */
export interface QoderWebFlagTarget {
  credentialRef: string
}

/**
 * 给账号列表补「是否已保存网页会话」的**布尔标记**。
 *
 * ⚠️⚠️ 只下发布尔值 —— Cookie 本身绝不下发客户端（本文件开头的红线）。
 *
 * 为什么抽成函数而不是在 `jet-hub-rpc.ts` 里就地写：那样「只下发布尔」这条
 * 不变式**零守卫** —— 把 `{ ...account, qoderWebSession: true }` 写成
 * `{ ...account, cookie: store.cookie }` 不会有任何用例变红（2026-11-14 审计 P2）。
 * 抽出来之后，`tests/unit/qoder-web-session-guards.spec.ts` 能断言
 * 「返回值序列化后不含 Cookie 明文」。
 *
 * 没会话时**不加键**（而不是 `false`）：与 `benefitOnly` / `modelscopeKeyMask`
 * 同款式，避免每个调用方都要为「多一个恒假字段」改断言。
 */
export async function withQoderWebSessionFlag<T extends QoderWebFlagTarget>(
  accounts: readonly T[],
  credentials: QoderWebCredentials,
): Promise<Array<T & { qoderWebSession?: boolean }>> {
  return Promise.all(accounts.map(async (account) => {
    const store = await loadQoderWebStore(credentials, account.credentialRef)
    return store.cookie !== undefined ? { ...account, qoderWebSession: true } : { ...account }
  }))
}

/** 把用户粘贴的内容归一成 Cookie 头：接受裸 Cookie、`Cookie: …` 行或整段 cURL。 */
export function normalizeCookieInput(raw: string): string {
  /**
   * ⚠️ **粘贴长度上限**（2026-11-14 对抗审计 B-⑧）：以前 13 KB 的整页 HTML
   * 也能原样进来 —— `cleanCookie` 会把每一行当 candidate 过一遍，既不报错也不
   * 有用，还会被 `saveQoderWebStore` 写进凭据库。真实 Cookie 头极少超过 4 KB。
   */
  const text = raw.slice(0, MAX_COOKIE_INPUT_CHARS).trim()
  if (text === '') return ''
  const curl = /(?:-H|--header)\s+(['"])\s*cookie:\s*([\s\S]*?)\1/i.exec(text)
    ?? /(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/i.exec(text)
  if (curl) return cleanCookie(curl[2]!)
  const line = /^\s*cookie:\s*(.+)$/im.exec(text)
  if (line) return cleanCookie(line[1]!)
  return cleanCookie(text)
}

/**
 * 把粘贴内容收成一个**单行** Cookie 头。
 *
 * ⚠️⚠️ 换行也是**分隔符**，不是值的一部分（2026-11-14 审计 P1，实测）：
 * 用户把 Cookie 粘成两行是很自然的动作（长的 Cookie 在开发者工具里会折行），
 * 而带着 `\n` 的头值会让 `fetch` 直接抛
 * `Headers.append: "<整个头值>" is an invalid header value` ——
 * **那条错误消息原样引用了整个 Cookie**，于是凭据经「网络异常」文案流进
 * 插件日志与 RPC 错误（用户屏幕上）。⇒ 这里按行拆开当分隔符用，
 * 两行粘贴**变成一个合法的 Cookie**，而不是一个必崩的坏头。
 *
 * ⚠️ 控制字符一律丢弃：哪怕用户/上游带了 `\0` / `\x0b`，也不许进请求头。
 */
function cleanCookie(value: string): string {
  return value
    .split(/;\s*|[\r\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/[\u0000-\u001f\u007f]/.test(part))
    .filter((part) => /^[^=\s;]+=/.test(part))
    .join('; ')
}

/**
 * 把文本里的 Cookie 抹掉（出错文案的**最后一道**防线）。
 *
 * ⚠️⚠️ 为什么需要它（2026-11-14 审计 P1，端到端实测）：`cleanCookie` 修好之后
 * 正常输入不会再产生非法头值，但
 * 1. **存量坏值**（旧版本已写进凭据库的带换行 Cookie）仍会被读出来用；
 * 2. 上游/`fetch` 实现换一条错误文案就可能重新引用头值。
 * 两条都不该让 Cookie 出现在日志或客户端文案里 —— 那是本文件开头的红线
 * （「绝不下发客户端、绝不写日志或错误消息」）。
 *
 * 判据：整串命中就整串抹；否则按 **8 字符窗口**兜底（错误消息可能只引用一段），
 * 宁可多抹几个字符，不可漏。
 */
export function redactQoderCookie(text: string, cookie: string): string {
  if (text === '' || cookie === '') return text
  /**
   * 要抹的**不止整串**：调用方拿到的可能是归一化后的 Cookie（`a=1; b=2`），
   * 而错误消息里引用的可能是**用户原始粘贴的那一段**（含换行、含单个 `k=v`）。
   * ⇒ 整串 + 每个 `;` 分段都当 needle（实测：只抹整串会漏掉 `X-Evil: 1`）。
   */
  const needles = new Set<string>([cookie])
  for (const part of cookie.split(';')) {
    const trimmed = part.trim()
    if (trimmed !== '') needles.add(trimmed)
  }
  let out = text
  for (const needle of needles) {
    if (needle.length < 4) continue
    if (out.includes(needle)) out = out.split(needle).join('***')
  }
  // 兜底：错误消息可能只引用了头值的**一段**（8 字符窗口），宁可多抹不可漏。
  for (let at = 0; at + 8 <= cookie.length && at < 512; at += 1) {
    const window = cookie.slice(at, at + 8)
    if (out.includes(window)) out = out.split(window).join('***')
  }
  return out
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
      /**
       * ⚠️⚠️ **这条文案不能直接拼 `error.message`**（2026-11-14 审计 P1）：
       * undici 对非法头值的报错是 `Headers.append: "<整个头值>" is an invalid
       * header value.` —— **把 Cookie 原样引用了一遍**。而这条 `reason` 会
       * ① 作为 RPC 错误下发到客户端界面、② 被 `ctx.logger.warn` 写进日志。
       * ⇒ 先抹 Cookie、再剥控制字符（否则日志被换行截断）、最后截断长度。
       */
      const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      const safe = redactQoderCookie(raw, cookie)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .slice(0, 200)
      lastFailure = { ok: false, authFailed: false, reason: `网页会话明细查询失败（网络异常：${safe}）` }
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
    /**
     * ⚠️ 200 + HTML 是**会话失效**的典型形态（扫码登录页被回流下来），
     * 报「响应不是 JSON」会把用户支去查网络（2026-11-14 对抗审计 P2-⑦）。
     */
    const contentType = response.headers.get('content-type') ?? ''
    if (/text\/html/i.test(contentType)) {
      lastFailure = { ok: false, authFailed: true, reason: '网页会话已失效（返回了登录页），请重新粘贴 Cookie' }
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
    /**
     * ⚠️ **大小写不敏感**（2026-11-14 对抗审计 A23）：上游只保证枚举名，没保证大小写；
     * 写成 `status !== 'ACTIVE'` 时，一个 `active` 会让**整份明细静默清空**
     * （症状是「网页会话明明存着，资源包却仍显示到期未知」，零报错）。
     */
    const status = typeof row.status === 'string' ? row.status.replace(/^QUOTA_DETAIL_STATUS_/i, '').toUpperCase() : ''
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
  const nowMs = detail.kind === 'web' ? (detail.nowMs ?? Date.now()) : detail.nowMs
  const items = detail.kind === 'web'
    ? detail.packages
        .filter((p) => p.expiresAtMs > nowMs)
        .map((p) => ({ amount: p.remaining, expiresAtMs: p.expiresAtMs }))
    : detail.grants.filter((g) => g.amount > 0 && g.expiresAtMs > nowMs)
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
      /**
       * ⚠️⚠️ **必须 `totalKnown: false`**（2026-11-14 正向审计 P2-2）：这里只有
       * 「剩余多少」，明细里的 `total` / `used` 在拆分过程中**没有意义**（一笔
       * 100/100 与一笔 200/300 的「总额」无法按到期日切分）。默认 `true` 会让
       * hover 浮层拿各包之和当账号总额 ⇒ 三行 `100 / 100` 加起来 300，而卡片
       * 主行写着 500 = **假分母**（`src/credits.ts:216` 的既有机制就是为此存在）。
       */
      totalKnown: false,
      active: addOn.active,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: isoOrEmpty(part.expiresAtMs),
      deductionEndTime: part.expiresAtMs,
    }))
  const rest = round2(left)
  if (rest > 0) {
    out.push({
      ...addOn,
      name: QODER_ADD_ON_PACKAGE,
      remaining: rest,
      total: rest,
      used: 0,
      totalKnown: false,
      expiryUnknown: true,
    })
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

/**
 * 毫秒 → 官网口径的「日」（**UTC+8 日界**）。
 *
 * ⚠️ 为什么这里写死 +8 而 `formatMonthDay` 用浏览器本地时区：**分组**要与官网的
 * 日界对齐（同一天领的两笔必须合并成一档），而「到期日」对用户就是他**本地**那天。
 * 两个口径不同是**有意**的：改任一侧都要重新想一遍（2026-11-14 正向审计 P3-③）。
 *
 * ⚠️⚠️ `new Date(超出 ±8.64e15)` 会抛 `RangeError: Invalid time value`，而它会
 * 把**整条 RPC** 带崩（2026-11-14 对抗审计 E6）—— 上游给一个垃圾时间戳
 * （`9e15`）是可预期的输入，不是编程错误。故这里兜底成空串（调用方按「无日期」
 * 处理，同一天的空串会自然合并）。
 */
function utc8Day(ms: number): string {
  const safe = ms + 8 * 3600_000
  if (!Number.isFinite(ms) || Math.abs(safe) > 8.64e15) return ''
  return new Date(safe).toISOString().slice(0, 10)
}

/**
 * `new Date(ms).toISOString()` 在 `ms` 超出 ±8.64e15 时抛 `RangeError`
 * （2026-11-14 对抗审计 E6 实测：上游给 `9e15` ⇒ 整条 RPC 崩）。展示字段宁可留空。
 */
function isoOrEmpty(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return ''
  return new Date(ms).toISOString()
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
  /**
   * ⚠️ 存储里读出来也**必须过一遍 `cleanCookie`**（2026-11-14 审计 P1）：
   * 旧版本可能已经把带换行的 Cookie 写进去了（`normalizeStore` 原先只 `trim`），
   * 那种值会被原样当请求头用 ⇒ 见 `cleanCookie` 的说明。
   */
  const cookie = typeof raw.cookie === 'string' ? cleanCookie(raw.cookie) : ''
  const grants = Array.isArray(raw.grants)
    ? raw.grants
      .filter(isRecord)
      .map((g) => ({ amount: finite(g.amount) ?? 0, expiresAtMs: finite(g.expiresAtMs) ?? 0 }))
      .filter((g) => g.amount > 0 && g.expiresAtMs > 0)
    : []
  return {
    ...cookie !== '' ? { cookie } : {},
    ...grants.length > 0 ? { grants } : {},
  }
}
