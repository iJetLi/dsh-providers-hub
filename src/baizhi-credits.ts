/**
 * 百智云（BaiZhiCloud）**控制台**积分读取与网页登录态换 Key。
 *
 * ## 为什么这个模块存在（2026-11-02 用户报障后重做）
 *
 * 第一版 baizhi provider 的结论是「百智云按量计费、没有积分」，理由是
 * **模型网关** `https://ai-models.app.baizhi.cloud` 上除了
 * `/api/anthropic/v1/models` 与 `/api/anthropic/v1/messages` 之外全部 404
 * （`{"type":"error","error":{"type":"invalid_request_error","message":"Gateway 路由不存在"}}`）。
 * 那个实测是**真的**，但结论错了 —— 积分不在网关，在**主站控制台**
 * `https://baizhi.cloud`，而且只认网页登录态 cookie。
 *
 * 用户截图（控制台 → 钱包）证明存在一套完整积分体系：
 * 可用积分 235.05、每日积分 98.21（零点过期）、充值积分 136.84（长期有效）、
 * 今日/本月消耗 364.95、调用次数 31、「模型商店」占比 100%。
 *
 * 实测对齐（2026-11-02，真实账号）：
 * - `GET /api/v1/user/wallet/balance` →
 *   `{"code":0,"message":"success","data":{"user_id":187965886890053,
 *     "temporary_credit_cents":9821,"permanent_credit_cents":13684,
 *     "frozen_credit_cents":0,"available_credit_cents":23505,
 *     "daily_temporary_credit_claimed":true}}`
 *   ⇒ 单位是 **1/100 积分**（9821 → 98.21、23505 → 235.05），与截图逐位吻合。
 * - `GET /api/v1/user/wallet/app-credit-usage?period=month` →
 *   `{"items":[{"period":"2026-11-02","app_id":22,"call_count":31,
 *     "credit":364.95,"credit_ratio":1}]}`
 *   ⇒ 调用次数 31、消耗 364.95 与截图完全一致。`period` 只认
 *   `week` / `month` / `year`（`today`/`all`/`day` 全 400「参数错误」）。
 * - `GET /api/v1/user/api-keys` → `{"items":[{"id":…,"name":"demo-user",
 *   "key":"sk-…","created_at":…}]}` ⇒ **网页登录后可以自动取到 sk- Key**，
 *   不需要用户手抄。
 * - `POST /api/v1/user/wallet/daily-temporary-credit` → 400
 *   `captcha binding mismatch`（每日临时积分领取要过验证码，暂不实现）。
 *
 * ## 两套凭据（关键）
 *
 * | 用途 | 凭据 | 认证头 |
 * |---|---|---|
 * | 发消息（`ai-models.app.baizhi.cloud`） | `sk-…` | `x-api-key` |
 * | 积分 / 用量 / Key 列表（`baizhi.cloud`） | 网页登录态 | `cookie` |
 *
 * `x-api-key` 打控制台接口一律 401；cookie 打模型网关同样不行。所以
 * 「只有 sk- 的账号能发消息但看不到积分」不是 bug，是两套凭据的分工 ——
 * 本模块的作用就是让浏览器登录顺手把 cookie 也存下来。
 *
 * @module src/baizhi-credits.ts
 */

import type { CreditBalance, CreditPackage } from './credits.js'
import type { BaizhiCredential } from './baizhi.js'
import { BAIZHI, type BaizhiProduct } from './baizhi-product.js'
import { normalizeSessionCookie } from './session-cookie.js'

/** 控制台会话 cookie 名（`baizhi.cloud` 上实测有两枚，两枚都要带）。 */
export const BAIZHI_SESSION_COOKIE_NAME = 'baizhi_session'

/** 控制台签到/登录态里那枚 `sl-session`（与 `baizhi_session` 同时下发）。 */
export const BAIZHI_SL_SESSION_COOKIE_NAME = 'sl-session'

/**
 * 控制台请求的可注入依赖。
 *
 * ⚠️ `fetchImpl` 只给单测用：本仓红线是「单测不许发真网络」。
 */
export interface BaizhiCreditsDeps {
  readonly fetchImpl?: typeof fetch
  /** 非致命问题的提示出口。 */
  readonly warn?: (message: string) => void
}

/** 积分余额（已从「分」换算成积分）。 */
export interface BaizhiWallet {
  /** 控制台用户 id（数字）。 */
  readonly userId?: number
  /** 当前可用积分（temporary + permanent - frozen）。 */
  readonly available: number
  /** 每日积分（**零点过期**）。 */
  readonly temporary: number
  /** 充值积分（**长期有效**）。 */
  readonly permanent: number
  /** 冻结积分。 */
  readonly frozen: number
  /** 今天是否已领取每日积分。 */
  readonly dailyClaimed: boolean
}

/** 用量明细里的一天 / 一个周期。 */
export interface BaizhiUsageItem {
  /** `2026-11-02`（按天）或 `2026-11`（按年查询时按月聚合）。 */
  readonly period: string
  /** 服务 id（`22` = 模型商店）。 */
  readonly appId: number
  /** 调用次数。 */
  readonly callCount: number
  /** 消耗积分。 */
  readonly credit: number
  /** 该服务占比（0~1）。 */
  readonly creditRatio: number
}

/** 用量汇总。 */
export interface BaizhiUsage {
  readonly items: readonly BaizhiUsageItem[]
  /** 今天的消耗积分之和。 */
  readonly todayCredit: number
  /** 今天的调用次数之和。 */
  readonly todayCalls: number
  /** 本月（`period=month`）的消耗积分之和。 */
  readonly monthCredit: number
  /** 本月的调用次数之和。 */
  readonly monthCalls: number
}

/** 平台请求结果（与 `monkeycode-credits.ts` 同形）。 */
type PlatformResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string }

/**
 * 把凭据里的 `session_cookie` 归一成可直接放进 `Cookie` 头的字符串。
 *
 * ⚠️ 2026-11-02 三审 F🟢-6：逻辑已抽到 `src/session-cookie.ts`（与 MonkeyCode 共用）。
 * 本处只保留两个**本平台差异**：认两个 cookie 名（`baizhi_session` / `sl-session`），
 * 裸值时补前者。
 */
export function normalizeBaizhiCookie(raw: string | undefined): string | undefined {
  return normalizeSessionCookie(
    raw,
    [BAIZHI_SESSION_COOKIE_NAME, BAIZHI_SL_SESSION_COOKIE_NAME],
    BAIZHI_SESSION_COOKIE_NAME,
  )
}

/** 从凭据取归一化 cookie。 */
function cookieOf(credential: BaizhiCredential | undefined): string | undefined {
  if (credential === undefined || credential === null) return undefined
  return normalizeBaizhiCookie(credential.session_cookie)
}

/** 控制台请求头。 */
function platformHeaders(cookie: string, product: BaizhiProduct): Record<string, string> {
  return {
    cookie,
    accept: 'application/json',
    referer: `${product.platformBaseUrl}/console/`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }
}

/** 把 HTTP 失败翻译成能行动的中文原因。 */
function describeFailure(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return `网页登录态未生效（HTTP ${status}）—— 控制台接口只认已登录的会话，`
      + '请重新用「浏览器登录」进入百智云并完成登录'
  }
  if (status === 429) return '请求过于频繁（HTTP 429），请稍后再试'
  const text = body.trim().slice(0, 160)
  return text.length > 0 ? `HTTP ${status}：${text}` : `HTTP ${status}`
}

/** 解析平台返回的信封 `{code,message,data}`；`data` 缺失时返回原始对象。 */
function unwrapEnvelope(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw
  const record = raw as Record<string, unknown>
  return 'data' in record ? record.data : raw
}

/** 安全读数字。 */
function readNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
  if (source === undefined) return undefined
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 安全读布尔。 */
function readBool(source: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (source === undefined) return undefined
  const value = source[key]
  return typeof value === 'boolean' ? value : undefined
}

/** 安全读对象数组。 */
function readArray(source: Record<string, unknown> | undefined, key: string): Record<string, unknown>[] {
  if (source === undefined) return []
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
}

/** 控制台 REST 请求。 */
async function platformRequest(
  path: string,
  cookie: string,
  product: BaizhiProduct,
  deps: BaizhiCreditsDeps,
  init: {
    readonly method?: string
    readonly body?: string
    readonly timeoutMs?: number
    /** 覆盖 origin：推理 Key 在**大模型商店**域上（`consoleBaseUrl`），不在控制台域。 */
    readonly baseUrl?: string
  } = {},
): Promise<PlatformResult> {
  const doFetch = deps.fetchImpl ?? fetch
  const timeoutMs = init.timeoutMs ?? 10_000
  try {
    const response = await doFetch(`${init.baseUrl ?? product.platformBaseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...platformHeaders(cookie, product),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) {
      return { ok: false, status: response.status, error: describeFailure(response.status, text) }
    }
    try {
      return { ok: true, data: JSON.parse(text) as unknown }
    } catch {
      return { ok: false, status: response.status, error: '上游返回的不是合法 JSON' }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 0, error: `请求失败：${message}` }
  }
}

/** 读积分余额。 */
export async function fetchBaizhiWallet(
  credential: BaizhiCredential,
  product: BaizhiProduct = BAIZHI,
  deps: BaizhiCreditsDeps = {},
): Promise<{ readonly ok: true; readonly wallet: BaizhiWallet } | { readonly ok: false; readonly error: string }> {
  const cookie = cookieOf(credential)
  if (cookie === undefined) {
    return {
      ok: false,
      error: '未配置会话（session_cookie）—— 请用「浏览器登录」添加账号，'
        + '只填 API Key 的账号能发消息但查不到积分',
    }
  }
  const result = await platformRequest(product.walletBalancePath, cookie, product, deps)
  if (!result.ok) return { ok: false, error: result.error }
  const data = unwrapEnvelope(result.data)
  const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
  const availableCents = readNumber(record, 'available_credit_cents')
  if (availableCents === undefined) {
    return { ok: false, error: '上游未下发积分余额（响应里没有 available_credit_cents）' }
  }
  // 单位是 1/100 积分 ⇒ 除 100 才是面板上的「235.05」。
  const toCredit = (cents: number | undefined): number => (cents === undefined ? 0 : cents / 100)
  return {
    ok: true,
    wallet: {
      ...(readNumber(record, 'user_id') === undefined ? {} : { userId: readNumber(record, 'user_id') }),
      available: toCredit(availableCents),
      temporary: toCredit(readNumber(record, 'temporary_credit_cents')),
      permanent: toCredit(readNumber(record, 'permanent_credit_cents')),
      frozen: toCredit(readNumber(record, 'frozen_credit_cents')),
      dailyClaimed: readBool(record, 'daily_temporary_credit_claimed') === true,
    },
  }
}

/** 用量周期。上游只认这三个（其余 400）。 */
export type BaizhiUsagePeriod = 'week' | 'month' | 'year'

/** 读用量明细。 */
export async function fetchBaizhiUsage(
  credential: BaizhiCredential,
  period: BaizhiUsagePeriod = 'month',
  product: BaizhiProduct = BAIZHI,
  deps: BaizhiCreditsDeps = {},
): Promise<{ readonly ok: true; readonly usage: BaizhiUsage } | { readonly ok: false; readonly error: string }> {
  const cookie = cookieOf(credential)
  if (cookie === undefined) return { ok: false, error: '未配置会话（session_cookie）' }
  const result = await platformRequest(
    `${product.walletUsagePath}?period=${period}`,
    cookie,
    product,
    deps,
  )
  if (!result.ok) return { ok: false, error: result.error }
  const data = unwrapEnvelope(result.data)
  const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
  const items: BaizhiUsageItem[] = readArray(record, 'items').map((item) => ({
    period: typeof item.period === 'string' ? item.period : '',
    appId: readNumber(item, 'app_id') ?? 0,
    callCount: readNumber(item, 'call_count') ?? 0,
    credit: readNumber(item, 'credit') ?? 0,
    creditRatio: readNumber(item, 'credit_ratio') ?? 0,
  }))
  // 今天的日期按**本地时区**取（上游 `period` 就是本地日历日，实测
  // `2026-11-02` 与截图「今日消耗」一致）；不用 UTC，否则北京时间
  // 00:00–08:00 会把今天的消耗算成昨天。
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const todayItems = items.filter((item) => item.period === today)
  const sum = (list: readonly BaizhiUsageItem[], key: 'credit' | 'callCount'): number =>
    list.reduce((total, item) => total + item[key], 0)
  return {
    ok: true,
    usage: {
      items,
      todayCredit: sum(todayItems, 'credit'),
      todayCalls: sum(todayItems, 'callCount'),
      monthCredit: sum(items, 'credit'),
      monthCalls: sum(items, 'callCount'),
    },
  }
}

/**
 * 把钱包 + 用量拼成面板要的 `CreditBalance`。
 *
 * 三个包分别对应控制台钱包页的三行数字：
 * - 「可用积分」= available（主行口径）；
 * - 「每日积分」= temporary（`cycleEndTime` 留空：上游只给「零点过期」这种
 *   说法，不给时刻，编一个时间会让面板显示假倒计时）；
 * - 「充值积分」= permanent（长期有效 ⇒ 无到期字段）。
 */
export function buildBaizhiBalance(wallet: BaizhiWallet, usage: BaizhiUsage | undefined): CreditBalance {
  const packages: CreditPackage[] = [
    {
      name: '每日积分',
      unit: 'credit',
      remaining: wallet.temporary,
      total: wallet.temporary,
      used: 0,
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
    },
    {
      name: '充值积分',
      unit: 'credit',
      remaining: wallet.permanent,
      total: wallet.permanent,
      used: 0,
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
    },
  ]
  if (wallet.frozen > 0) {
    packages.push({
      name: '冻结积分',
      unit: 'credit',
      remaining: 0,
      total: wallet.frozen,
      used: wallet.frozen,
      // 冻结额度不可用 ⇒ 明确标成非 active，面板会放进「已失效」区。
      active: false,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
    })
  }
  return {
    total: wallet.available,
    packages,
    expiredTotal: 0,
    // ⚠️ 2026-11-02 三审 F🟡-8：用量不能塞进 `packages`（那会被渲染成「已失效的
    //    资源包」、并且参与「N/M 个包有效」与临期折算）⇒ 走 `usage` 这条独立通道。
    ...(usage !== undefined && usage.monthCredit > 0
      ? { usage: { label: '本月消耗', amount: usage.monthCredit, unit: 'credit' } }
      : {}),
  }
}

/**
 * `ProviderCredits.fetchBalanceDetailed` 的实现。
 *
 * 用量是**附加信息**：读失败不影响余额展示（只 warn），否则一次 500 就会让
 * 用户彻底看不到积分。
 */
export async function fetchBaizhiBalanceDetailed(
  credential: BaizhiCredential,
  product: BaizhiProduct = BAIZHI,
  deps: BaizhiCreditsDeps = {},
): Promise<{ readonly balance: CreditBalance | null; readonly error?: string }> {
  const wallet = await fetchBaizhiWallet(credential, product, deps)
  if (!wallet.ok) return { balance: null, error: wallet.error }
  const usage = await fetchBaizhiUsage(credential, 'month', product, deps)
  if (!usage.ok) deps.warn?.(`百智云用量读取失败：${usage.error}`)
  return { balance: buildBaizhiBalance(wallet.wallet, usage.ok ? usage.usage : undefined) }
}

/** 网页登录态换出来的 API Key。 */
export interface BaizhiIssuedKey {
  readonly apiKey: string
  readonly keyName?: string
  readonly userId?: string
}

/**
 * 用控制台网页登录态换 `sk-` API Key（**浏览器登录的最后一环**）。
 *
 * ⚠️ 打的是**大模型商店**的 console 接口：
 * `GET https://ai-models.app.baizhi.cloud/api/console/api-keys`（cookie 认证），
 * 响应 `{"items":[{"id":…,"name":"demo-account","api_key":"sk-…","status":"active"}]}`。
 *
 * ⚠️ 2026-11-03 合并审计更正：本节原写「`GET /api/v1/user/api-keys` 返回
 * `items[].key`」——那是**控制台**（`baizhi.cloud`）的接口，只发 `bzy_` 前缀的
 * Key（15 位），拿它打模型网关恒 401「API Key 无效」。真正的推理 Key 是
 * console 接口下发的 `sk-…`，字段名是 **`api_key`**（下划线）而不是 `key`。
 *
 * ⇒ 用户只要在浏览器里登进控制台，插件就能自动建号，不需要手抄 Key。
 *
 * 一个账号可以有多把 Key：取**第一把 `status === 'active'` 的**（列表按创建
 * 时间倒序，第一把就是用户最近用的那把；停用/删除的跳过）。没有可用 Key 时
 * 返回可行动的提示 —— 用户需要先去控制台「API Keys」页点一次「新建」。
 */
export async function exchangeBaizhiSessionForKey(
  sessionCookie: string,
  product: BaizhiProduct = BAIZHI,
  deps: BaizhiCreditsDeps = {},
): Promise<{ readonly ok: true; readonly key: BaizhiIssuedKey } | { readonly ok: false; readonly error: string }> {
  const cookie = normalizeBaizhiCookie(sessionCookie)
  if (cookie === undefined) return { ok: false, error: '网页登录态为空' }
  // ⚠️ 打的是**大模型商店**的 console 接口（`consoleBaseUrl` + `consoleApiKeysPath`），
  //    不是控制台的 `/api/v1/user/api-keys` —— 后者只发 `bzy_`，发不出能用的推理 Key。
  const result = await platformRequest(product.consoleApiKeysPath, cookie, product, deps, {
    baseUrl: product.consoleBaseUrl,
  })
  if (!result.ok) {
    // 401/403 说明登录态还没生效（窗口刚开），交给上层的「等登录」循环重试。
    return { ok: false, error: result.error }
  }
  const data = unwrapEnvelope(result.data)
  const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
  const items = readArray(record, 'items')
  for (const item of items) {
    // ⚠️ 字段是 `api_key`（下划线），不是控制台的 `key`；停用的不能拿来用。
    const key = item.api_key
    const status = typeof item.status === 'string' ? item.status : 'active'
    if (status !== 'active') continue
    if (typeof key === 'string' && /^sk-[A-Za-z0-9_-]{16,}$/.test(key.trim())) {
      const name = typeof item.name === 'string' ? item.name : undefined
      return {
        ok: true,
        key: {
          apiKey: key.trim(),
          ...(name === undefined ? {} : { keyName: name }),
        },
      }
    }
  }
  return {
    ok: false,
    error: '这个大模型商店账号下还没有可用的 `sk-` 密钥 —— 请打开'
      + ' https://ai-models.app.baizhi.cloud/console/keys 新建一把，'
      + '或改用「手动填写 API Key」添加',
  }
}

/** 控制台用户资料（登录后用于显示昵称）。 */
export async function fetchBaizhiProfile(
  sessionCookie: string,
  product: BaizhiProduct = BAIZHI,
  deps: BaizhiCreditsDeps = {},
): Promise<{ readonly ok: true; readonly userId?: string; readonly name?: string } | { readonly ok: false; readonly error: string }> {
  const cookie = normalizeBaizhiCookie(sessionCookie)
  if (cookie === undefined) return { ok: false, error: '网页登录态为空' }
  const result = await platformRequest(product.profilePath, cookie, product, deps)
  if (!result.ok) return { ok: false, error: result.error }
  const data = unwrapEnvelope(result.data)
  const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
  const id = readNumber(record, 'id')
  const name = typeof record?.name === 'string' ? record.name : undefined
  return {
    ok: true,
    ...(id === undefined ? {} : { userId: String(id) }),
    ...(name === undefined ? {} : { name }),
  }
}
