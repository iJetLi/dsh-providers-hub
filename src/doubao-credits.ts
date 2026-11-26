/**
 * 豆包（Doubao）积分额度余额与每日签到（薄壳）。
 *
 * ## 余额（2026-11-26 晚修正：POST 之后直接可读，全程无浏览器、无签名）
 *
 * ## 面板「订阅与额度管理」顶部的数字来自
 *
 * - 本文件：**余额**（真实读 commerce `quota/summary`）+ **签到薄壳**（把凭据转给 `doubao-signin.ts`）；
 * - `src/doubao-upstream.ts`：额度/模型/对话三条腿的共享协议；
 * - `src/doubao-signin.ts`：**沙箱签名 + 直连 HTTP**（2026-11-26 起零浏览器；
 *   历史实现曾是 CDP 页面会话驱动，已删除）。
 *
 * ## ⚠️⚠️ 2026-11-26 的两条错误结论（已作废，别再抄）
 *
 * 1. **「commerce 网关校验 `a_bogus`，服务端一律 404」是错的**。
 *    404 的唯一原因是**方法用错**：这些端点全是 `POST`，当时拿 `GET` 打。
 *    实测三条对照（同一 cookie、同一 query）：
 *    - `a_bogus` 随机改 4 个字符 ⇒ **200**
 *    - 整段删掉 `a_bogus` ⇒ **200**
 *    - 换成 `GET` ⇒ **404**
 *    ⇒ **余额这条腿不需要签名**，`bdms` 沙箱只服务签到那条链路。
 * 2. **金额是带千分位的字符串**（`"4,003"`），不是 number；
 *    到期时间是**毫秒**（`1797937149723`），不是秒。
 *    这两点都会静默错位：`Number("4,003")` = NaN ⇒ 卡片显示 0；
 *    秒当毫秒 ⇒ 全部判成 1970 年已过期。
 *
 * ## 签到
 *
 * 签到仍在 `src/doubao-signin.ts`（纯 HTTP + `bdms` 沙箱签名），本文件只做薄壳转发。
 * - **签到端点**：`POST https://www.doubao.com/alice/ug/campaign/landing/checkin`
 *   （公共 query 见 `src/doubao.ts` 的 `doubaoCheckinQuery`），body
 *   `{"scene":"pc_incentive_task_mvp_v3"}`，响应
 *   `{data:{checked_in,checkin_date,continuous_days,idempotent,reward_amount,…},code:0}`。
 * - **鉴权 = cookie**（`sessionid`/`sid_tt`/`ttwid` 等），无 `Authorization`。
 * - **签名 = query 的 `a_bogus`**，由 `window.bdms.frontierSign` 生成
 *   （`bdms` 只在 doubao.com 页面里存在）⇒ **签到必须签名**。
 *   ⚠️ 2026-11-26 起签名在 `node:vm` 沙箱里跑**随包内置**的官方 SDK（零下载、零浏览器）。
 *   纯 Node fetch 产不出合法 `a_bogus`（实测裸 fetch 恒 `710010702 系统错误`）。
 * - **幂等**：`idempotent: true`（重复调用安全，今日已签会回 `checked_in:true`）。
 *
 * ```
 * POST https://www.doubao.com/alice/commerce/sale/subscription/overview/
 *      ?<公共 query>          # 只要 aid/device_platform/version_code 即可
 *      body: {"product_line":"membership"}
 * ```
 *
 * 响应 `data.quota_balance_overview`（实测 2026-11-26，真 cookie）：
 *
 * ```jsonc
 * {
 *   "total_remaining_amount": "4,003",
 *   "summaries": [
 *     { "category": 1, "title": "套餐", "remaining_amount": "2,142" },
 *     { "category": 3, "title": "赠送", "remaining_amount": "1,861" }
 *   ],
 *   "top_items": [ { "display_name": "豆包工作体验套餐", "total_amount": "2,142",
 *                    "used_amount": "0", "used_percent": 0,
 *                    "end_time": 1797937149723, "time_type": 2 }, … ]
 * }
 * ```
 *
 *
 * @module src/doubao-credits.ts
 */

import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'
import {
  DOUBAO_BASE_URL,
  DOUBAO_WEB_USER_AGENT,
  doubaoCheckinQuery,
  type DoubaoCredential,
} from './doubao.js'

export const DOUBAO_HTTP_TIMEOUT_MS = 15_000

/** 额度总览端点（实测自面板真实请求，2026-11-26）。 */
export const DOUBAO_OVERVIEW_PATH = '/alice/commerce/sale/subscription/overview/'

/** 请求体：面板固化的 `product_line`（`entry/config` 与 `card/list` 另有各自的 body）。 */
export const DOUBAO_OVERVIEW_BODY = '{"product_line":"membership"}'

/** 豆包查询「登录已过期」的业务码（与签到同码）。 */
const DOUBAO_SESSION_EXPIRED_CODE = 710012001

/** 上游金额既可能是 `"4,003"`，也可能是纯数字 —— 两种都要吃得下。 */
type DoubaoAmount = string | number | null | undefined

/** `quota_balance_overview.summaries[]`：按分类聚合的剩余（面板顶部那两行）。 */
interface DoubaoQuotaSummary {
  /** 1 = 套餐，3 = 赠送；缺失时按 `title` 兜底。 */
  category?: number
  /** 面板上的分类名（「套餐」「赠送」）。 */
  title?: string
  /** 该分类剩余额度（`"2,142"` 这种带千分位的字符串）。 */
  remaining_amount?: DoubaoAmount
}

/** `quota_balance_overview.top_items[]`：明细条目（只给前几条，`has_more` 标记截断）。 */
interface DoubaoQuotaTopItem {
  category?: number
  display_name?: string
  total_amount?: DoubaoAmount
  used_amount?: DoubaoAmount
  used_percent?: number
  /** 到期时刻（**毫秒**）。 */
  end_time?: number
  time_type?: number
}

interface DoubaoQuotaBalanceOverview {
  has_more?: boolean
  summaries?: DoubaoQuotaSummary[]
  top_items?: DoubaoQuotaTopItem[]
  total_remaining_amount?: DoubaoAmount
}

/** 分类维度的「总额 + 已用」聚合（`window_limit_section` / `incentive_quota_section` 同构）。 */
interface DoubaoWindowLimit {
  total_amount?: DoubaoAmount
  used_amount?: DoubaoAmount
  used_percent?: number
}

interface DoubaoWindowLimitGroup {
  feature_group?: string
  feature_group_name?: string
  window_limits?: DoubaoWindowLimit[]
}

interface DoubaoLimitSection {
  window_limit_groups?: DoubaoWindowLimitGroup[]
}

interface DoubaoOverviewPayload {
  quota_balance_overview?: DoubaoQuotaBalanceOverview | null
  window_limit_section?: DoubaoLimitSection | null
  incentive_quota_section?: DoubaoLimitSection | null
}

interface DoubaoOverviewWire {
  code?: number
  message?: string
  msg?: string
  data?: DoubaoOverviewPayload | null
}

/**
 * 解析上游金额：`"4,003"` / `"0"` / `4003` ⇒ `number`；认不出 ⇒ `NaN`。
 *
 * ⚠️ 直接 `Number("4,003")` 是 `NaN` —— 卡片会显示 0，看上去像「额度用光了」。
 */
export function parseDoubaoAmount(value: DoubaoAmount): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN
  if (typeof value !== 'string') return Number.NaN
  const cleaned = value.replace(/[,\s，]/g, '')
  if (cleaned.length === 0) return Number.NaN
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

interface CategoryTotal {
  total: number
  used: number
  /**
   * 该分类的每一行都解析成功、且各自 `0 <= used <= total`。
   *
   * `false` = 有一行金额读不出来或自相矛盾 ⇒ **不许拿这个总额当分母**：丢行之后再
   * 和 `summaries.remaining` 比「总额 − 已用 == 剩余」，很容易凑巧相等（review 指出
   * 过的和式假阳性）。宁可 `totalKnown = false`。
   */
  complete: boolean
}

/**
 * 从两个 section 里取「套餐 / 赠送」的总额与已用。
 *
 * 判据：`feature_group(_name)` 命中 `activity/reward/incentive/活动/赠送` ⇒ 赠送，
 * 其余（订阅套餐那条）⇒ 套餐。
 *
 * ⚠️ 调用方只在 `total - used === summary.remaining` 时采用（见映射函数）：
 *    面板 `has_more` 会截断明细，若把 section 总额无脑套到 summary 上，
 *    分母可能对不上分子；宁可退回「总额未知」也不编一个。
 */
function categoryTotalsOf(
  payload: DoubaoOverviewPayload | null | undefined,
): { membership?: CategoryTotal; gift?: CategoryTotal } {
  const result: { membership?: CategoryTotal; gift?: CategoryTotal } = {}
  const sections: Array<DoubaoLimitSection | null | undefined> = [
    payload?.window_limit_section,
    payload?.incentive_quota_section,
  ]
  for (const section of sections) {
    for (const group of section?.window_limit_groups ?? []) {
      let total = 0
      let used = 0
      let complete = true
      for (const limit of group?.window_limits ?? []) {
        const t = parseDoubaoAmount(limit?.total_amount)
        const u = parseDoubaoAmount(limit?.used_amount)
        /**
         * ⚠️ 以前这里是 `if (!Number.isFinite(t)) continue` —— **静默丢行**。
         *    丢一行就等于把分母缩小一点，而分母仍然拿去和 `summaries` 的剩余做
         *    算术比对，于是「凑巧相等」的假阳性比以前更容易出现（review 指出的正是
         *    这类和式假阳性）。现在一律标 `complete = false`，该分类退回
         *    「总额未知」，不编分母。
         */
        if (!Number.isFinite(t) || !Number.isFinite(u) || u < 0 || u > t) {
          complete = false
          continue
        }
        total += t
        used += u
      }
      if (total <= 0) continue
      const featureGroup = `${group?.feature_group ?? ''} ${group?.feature_group_name ?? ''}`
      const bucket = /activity|reward|incentive|活动|赠送/i.test(featureGroup) ? 'gift' : 'membership'
      const existing = result[bucket]
      result[bucket] = {
        total: (existing?.total ?? 0) + total,
        used: (existing?.used ?? 0) + used,
        complete: (existing?.complete ?? true) && complete,
      }
    }
  }
  return result
}

/** 分类码：`QuotaBalanceCategory` 里 1 = 套餐（订阅），3 = 赠送（活动/新手）。 */
const DOUBAO_CATEGORY_GIFT = 3

/** 分类名兜底（`summaries[]` 没给 `title` 时）。 */
function summaryNameOf(summary: DoubaoQuotaSummary): string {
  const title = typeof summary.title === 'string' ? summary.title.trim() : ''
  if (title.length > 0) return title
  return summary.category === DOUBAO_CATEGORY_GIFT ? '赠送额度' : '套餐额度'
}

/**
 * 把额度总览响应映射成 `CreditBalance`（纯函数，单测直接喂 fixture）。
 *
 * 口径：
 * - `total` = `quota_balance_overview.total_remaining_amount`（= 面板「可用额度」）；
 *   缺失时退回各分类剩余之和；
 * - `packages` = 每个 summary 一包（`套餐` / `赠送`），`remaining` 直接取剩余；
 * - `total`/`used` 只在 section 聚合能对上（`total - used === remaining`）时才填，
 *   否则 `totalKnown = false`、`used = 0` —— 面板不得并列显示分子分母。
 * - `expiredTotal` 恒为 0：`summaries[]` 不区分失效，上游的 `total_remaining_amount`
 *   本身已经把失效额度排除在外。
 */
export function doubaoBalanceFromOverviewPayload(
  payload: DoubaoOverviewPayload | null | undefined,
): CreditBalance {
  const overview = payload?.quota_balance_overview ?? null
  const summaries = Array.isArray(overview?.summaries) ? overview.summaries : []
  const totals = categoryTotalsOf(payload)

  const packages: CreditPackage[] = summaries.map((summary) => {
    const remaining = parseDoubaoAmount(summary?.remaining_amount)
    const safeRemaining = Number.isFinite(remaining) ? remaining : 0
    const bucket = summary?.category === DOUBAO_CATEGORY_GIFT ? totals.gift : totals.membership
    // 只有算术自洽（总额 - 已用 == 剩余）**且每一行都读得出来**才认这个分母。
    const totalCandidate = bucket?.total
    const used = bucket?.used ?? 0
    const totalKnown =
      bucket?.complete === true &&
      typeof totalCandidate === 'number' &&
      Number.isFinite(totalCandidate) &&
      totalCandidate >= safeRemaining &&
      Math.abs(totalCandidate - used - safeRemaining) < 1e-6
    return {
      name: summaryNameOf(summary),
      unit: 'credit',
      remaining: safeRemaining,
      total: totalKnown ? (totalCandidate as number) : safeRemaining,
      totalKnown,
      used: totalKnown ? used : 0,
      // 上游没给「已用光」之外的空包；`remaining > 0` 即可用。
      active: safeRemaining > 0,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
      /**
       * ⚠️⚠️ **这里必须是 `expiryUnknown`，不能是空 `expiredTime`**（review 更正，
       * 仓库红线 IKTLMX）：
       *
       * - `top_items[].end_time`（毫秒）确实在响应里，但**`top_items` 不带分类归属**
       *   （只有 `display_name` / 金额 / 到期），套到「套餐」「赠送」这两个 summary
       *   头上就是编造 —— 而 `has_more` 还可能把明细截断；
       * - 「拿不到逐笔到期」**不等于**「永不到期」。空 `expiredTime` 会被展示层读成
       *   `permanent` ⇒ 面板写「永久 4,003」，用户就不会去抢救临期额度。
       * - `expiryUnknown: true` 的语义正是「会过期、但不知道哪天」：分桶行为不变，
       *   只是把「永久」改口径成「到期未知」。
       */
      expiryUnknown: true,
    } satisfies CreditPackage
  })

  const computed = packages.reduce((sum, pkg) => sum + pkg.remaining, 0)
  const declared = parseDoubaoAmount(overview?.total_remaining_amount)
  const total = Number.isFinite(declared) && declared >= 0 ? declared : computed
  return { total, packages, expiredTotal: 0 }
}

/**
 * 拉取豆包积分额度（`fetchBalanceDetailed` 形态：失败自带可读原因）。
 *
 * @param options.fetchImpl 测试注入点（生产路径 = 全局 `fetch`）。
 */
export async function fetchDoubaoBalanceDetailed(
  credential: DoubaoCredential,
  options: {
    log?: (msg: string) => void
    timeoutMs?: number
    fetchImpl?: typeof fetch
  } = {},
): Promise<{ balance: CreditBalance | null; error?: string }> {
  const cookie = typeof credential?.cookie === 'string' ? credential.cookie : ''
  if (cookie.length === 0) {
    return { balance: null, error: '没有可用的豆包登录会话（请先在账号卡上导入 Cookie）' }
  }
  const fetchImpl = options.fetchImpl ?? fetch
  // 公共 query 与签到同一份（device_id / web_id / tea_uuid 逐账号派生，别在这里另抄一套）。
  const query = doubaoCheckinQuery(credential)
  const timeoutMs = options.timeoutMs ?? DOUBAO_HTTP_TIMEOUT_MS
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = setTimeout(() => { try { controller?.abort() } catch { /* noop */ } }, timeoutMs)

  try {
    // ⚠️ **必须是 POST**。同一个 URL 换成 GET 一律 404（2026-11-26 实测），
    //    当初 404 的全部原因就在这里，与签名无关。
    const response = await fetchImpl(`${DOUBAO_BASE_URL}${DOUBAO_OVERVIEW_PATH}?${query}`, {
      method: 'POST',
      headers: {
        cookie,
        'user-agent': DOUBAO_WEB_USER_AGENT,
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        // AGW 网关对 JSON 接口要求这个转换头（签到同款）。
        'agw-js-conv': 'str',
        referer: `${DOUBAO_BASE_URL}/member/quota-management?quota_tab=personal&theme=light&is_setting_iframe=1`,
        origin: DOUBAO_BASE_URL,
      },
      body: DOUBAO_OVERVIEW_BODY,
      signal: controller?.signal,
    })
    const text = await response.text()
    if (response.status !== 200) {
      options.log?.(`[doubao-quota] HTTP ${response.status}｜${text.slice(0, 200)}`)
      return { balance: null, error: `额度接口返回 HTTP ${response.status}（豆包可能改了接口，详见宿主日志）` }
    }
    let wire: DoubaoOverviewWire
    try {
      wire = JSON.parse(text) as DoubaoOverviewWire
    } catch {
      return { balance: null, error: `额度接口返回的不是 JSON：${text.slice(0, 120)}` }
    }
    if (wire.code !== undefined && wire.code !== 0) {
      if (wire.code === DOUBAO_SESSION_EXPIRED_CODE) {
        return { balance: null, error: '豆包登录已过期（710012001），请重新导入 Cookie' }
      }
      const message = wire.message ?? wire.msg ?? ''
      return { balance: null, error: `额度查询失败（${wire.code} ${message}）`.trim() }
    }
    if (wire.data === undefined || wire.data === null) {
      return { balance: null, error: '额度接口没有返回数据（可能当日无额度活动）' }
    }
    const balance = doubaoBalanceFromOverviewPayload(wire.data)
    // ⚠️ `overview` 对所有账号都回 `code:0`，但「没有任何额度分类」时也照样 200
    //    —— 那种情况不能装作读到了 0。
    if (balance.packages.length === 0 && !Number.isFinite(parseDoubaoAmount(wire.data.quota_balance_overview?.total_remaining_amount))) {
      return { balance: null, error: '额度接口没有返回任何额度分类（账号可能不在额度体系内）' }
    }
    return { balance }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // ⚠️ 兜底报错会进面板/日志：把凭据里出现过的 cookie 原文抹掉，
    //    免得某些 HTTP 栈把请求头（含 sessionid）拼进异常文本。
    const safe = cookie.length > 0 && reason.includes(cookie) ? reason.split(cookie).join('<已隐藏>') : reason
    return { balance: null, error: `额度查询请求失败：${safe}` }
  } finally {
    clearTimeout(timer)
  }
}

// ── 签到：薄壳，转发给签到驱动（HTTP-only，无浏览器）──

/**
 * 执行豆包每日签到领取。
 *
 * 真正的实现是 `src/doubao-signin.ts` 的 `claimDoubaoDaily`：用 `doubao-bdms.ts`
 * 在 Node 沙箱里产 `a_bogus` 后直连签到接口（**全程无浏览器、无兜底**）。
 * 本函数是它的薄壳：把凭据原文与可选注入点转过去，**`ClaimOutcome` 原样上抛**
 * （`failed` 不许被吞成 `inactive`，否则面板会把"签名坏了"显示成"今天没活动"）。
 *
 * ⚠️ 凭据必须带 `cookie`（登录会话）；没有它 ⇒ `inactive`（不发请求）。
 * ⚠️ `options.sign` 只给单测注入用（生产路径不传 ⇒ 走沙箱签名）。
 */
export async function claimDoubaoDailyCheckin(
  credential: DoubaoCredential,
  options: { sign?: () => Promise<string>, log?: (message: string) => void } = {},
): Promise<ClaimOutcome> {
  if (typeof credential?.cookie !== 'string' || credential.cookie.length === 0) {
    return { kind: 'inactive', message: '没有可用的豆包登录会话（请先在账号卡上导入 Cookie）' }
  }
  const { claimDoubaoDaily } = await import('./doubao-signin.js')
  return claimDoubaoDaily(JSON.stringify(credential), options)
}
