/**
 * MiniMax Code 签到与积分余额。
 *
 * ## 端点（asar UI chunk 直读，实测通过）
 *
 * ```
 * GET  {host}/minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
 * POST {host}/minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>   body {}
 * GET  {host}/minimax-cloud/api/v1/credit/details
 * ```
 *
 * ## ⚠️ 四个必须记住的点
 *
 * 1. **`timezone_id` 是 query 参数且必填**。实测四种组合：query 生效、
 *    请求头无效、都不带报 `invalid timezone_id`、非法时区名也报错。
 * 2. **业务码在 `base_resp.status_code`**（不是 `code`），且 `invalid timezone_id`
 *    也是 **HTTP 200** —— 只看 HTTP 状态码会把它当成成功。
 * 3. **`points` 是总数，`bonus_points` 是其中的「额外」部分，不得相加**。
 *    实测第 1 天 `points: 800`、`bonus_points: 400`，截图按钮就是「签到得 800」
 *    + 右上角「额外 400」角标。相加会**虚高一倍**。
 * 4. **「今日已领」判据是 `is_today && status === 3`**，**不能**用
 *    「没有 Claimable」反推（与 Qoder「领取成功后列表仍非空」同型教训）。
 */

import {
  MINIMAX,
  MINIMAX_CREDIT_DETAILS_PATH,
  MINIMAX_REQUEST_TIMEOUT_MS,
  MINIMAX_SIGNIN_CLAIM_PATH,
  MINIMAX_SIGNIN_STATUS_PATH,
  type MinimaxProduct,
} from './minimax-product.js'
import { describeMinimaxGeoRoute, minimaxFetch, minimaxHeadersFor, type MinimaxCredential } from './minimax.js'
import { roundCredits, type CheckinStatus, type ClaimOutcome, type CreditBalance, type CreditPackage } from './credits.js'

/** 单日状态（asar `SigninDayStatus`）。 */
export const MINIMAX_SIGNIN_STATUS = Object.freeze({
  Upcoming: 1,
  Claimable: 2,
  Claimed: 3,
  Disabled: 4,
})

/** 领取结果（asar `SigninClaimResult`）。 */
export const MINIMAX_CLAIM_RESULT = Object.freeze({
  Claimed: 1,
  AlreadyClaimed: 2,
})

/** 面板场景（asar `SigninPanelScene`）。 */
export const MINIMAX_PANEL_SCENE = Object.freeze({
  Unknown: 0,
  First: 1,
  Active: 2,
  Completed: 3,
  Broken: 4,
})

/**
 * 常量表的**成员值数组**（供 `includes` 做成员合法性校验）。
 *
 * ⚠️ **不能直接写 `Object.values(MINIMAX_SIGNIN_STATUS).includes(x)`** ——
 * 因为字面量被 `Object.freeze` 收窄成 `1|2|3|4`，`Object.values` 的类型随之
 * 变成字面量联合数组，而 `x` 是 `number`，`tsc` 会报
 * `TS2345: Argument of type 'number' is not assignable to parameter of type '1|2|3|4'`
 * （实测。运行时都对，**只有类型不过**——`pnpm typecheck` 是硬门禁，必须修）。
 * 显式标注 `readonly number[]` 即可拓宽元素类型，判据与运行时行为**完全不变**。
 */
const MINIMAX_SIGNIN_STATUS_VALUES: readonly number[] = Object.values(MINIMAX_SIGNIN_STATUS)
const MINIMAX_PANEL_SCENE_VALUES: readonly number[] = Object.values(MINIMAX_PANEL_SCENE)

/** 归一后的单日条目。 */
export interface MinimaxSigninDay {
  dayNo: number
  points: number
  bonusPoints: number
  status: number
  isToday: boolean
}

/** 归一后的面板。 */
export interface MinimaxSigninPanel {
  scene: number
  days: readonly MinimaxSigninDay[]
}

/**
 * 取本机 IANA 时区名。
 *
 * 客户端就是这么取的（asar UI chunk 模块 39504）：
 * `Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"`。
 *
 * ⚠️ **与 Qoder 的口径不同**：Qoder 的额度标记**写死 UTC+8**（服务端按 UTC+8
 * 结算），而 MiniMax 的签到按**客户端上报的时区**结算。不得互相套用。
 */
export function resolveMinimaxTimezoneId(
  resolve: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  try {
    const zone = resolve()
    return typeof zone === 'string' && zone.trim().length > 0 ? zone.trim() : 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 读有限数字；非法返回 undefined。 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 解析**金额**：同时接受数字与字符串形态。
 *
 * ⚠️ 实测余额端点返回的是**字符串**（`remaining_amount: "800.00"`），
 * 而 `finiteNumber` 只认 `number` —— 用它会把 800 静默算成 0。
 * 上游既然用字符串规避浮点，我们就不该假设它哪天不变。
 *
 * 非有限 / 无法解析 ⇒ `undefined`（**不编造 0**，由调用方决定语义）。
 */
function looseAmount(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  // ⚠️ `Number('')` 是 0，会把「空字符串」误读成「0 积分」—— 先挡掉空串。
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 解析签到面板（**完整复刻** asar `validateSigninPanel`）。
 *
 * 硬约束（不满足即返回 undefined，**不编造**）：
 * - `days` **恰好 7 条**
 * - 每条 `day_no` 是 1..7 整数且**无重复**
 * - `points` 非负有限；`bonus_points` 可选但非负有限
 * - `is_today` 是 **boolean**
 * - `status` ∈ {1,2,3,4}
 * - **最多 1 条 `Claimable`**、**最多 1 条 `is_today`**
 * - `scene` ∈ {0,1,2,3,4}
 */
export function parseMinimaxSigninPanel(data: unknown): MinimaxSigninPanel | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  const scene = finiteNumber(record.scene)
  if (scene === undefined || !MINIMAX_PANEL_SCENE_VALUES.includes(scene)) return undefined

  const rawDays = record.days
  if (!Array.isArray(rawDays) || rawDays.length !== 7) return undefined

  const days: MinimaxSigninDay[] = []
  const seen = new Set<number>()
  let claimable = 0
  let today = 0
  for (const raw of rawDays) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const day = raw as Record<string, unknown>
    const dayNo = finiteNumber(day.day_no)
    const points = finiteNumber(day.points)
    const status = finiteNumber(day.status)
    const bonusRaw = day.bonus_points
    const bonusPoints = bonusRaw === undefined ? 0 : finiteNumber(bonusRaw)
    if (dayNo === undefined || !Number.isInteger(dayNo) || dayNo < 1 || dayNo > 7) return undefined
    if (seen.has(dayNo)) return undefined
    if (points === undefined || points < 0) return undefined
    if (bonusPoints === undefined || bonusPoints < 0) return undefined
    if (typeof day.is_today !== 'boolean') return undefined
    if (status === undefined || !MINIMAX_SIGNIN_STATUS_VALUES.includes(status)) {
      return undefined
    }
    seen.add(dayNo)
    if (status === MINIMAX_SIGNIN_STATUS.Claimable) claimable++
    if (day.is_today) today++
    days.push({ dayNo, points, bonusPoints, status, isToday: day.is_today })
  }
  // ⚠️ 最多 1 条可领、最多 1 条今日（asar 的硬约束）
  if (claimable > 1 || today > 1) return undefined
  return { scene, days }
}

/**
 * 把面板映射成 DSH 的 {@link CheckinStatus}。
 *
 * ⚠️ **`dailyCredit = points`**（800），**不是** `points + bonus_points`（1200）。
 * 见文件头注释第 3 点。
 *
 * ⚠️ **`active` 恒 `true`** —— 拿到响应即 true，不按「有可领项」判。
 * 否则会把「今天已领」误报成「签到活动未开启」（Qoder 同型缺陷）。
 */
export function minimaxPanelToCheckinStatus(panel: MinimaxSigninPanel): CheckinStatus {
  const today = panel.days.find((day) => day.isToday)
  const claimedToday = today !== undefined && today.status === MINIMAX_SIGNIN_STATUS.Claimed
  // 连续天数：从今日起向前数连续 Claimed
  const sorted = [...panel.days].sort((a, b) => a.dayNo - b.dayNo)
  const todayIndex = sorted.findIndex((day) => day.isToday)
  let streakDays = 0
  if (todayIndex >= 0) {
    let index = sorted[todayIndex]?.status === MINIMAX_SIGNIN_STATUS.Claimed
      ? todayIndex
      : sorted[todayIndex]?.status === MINIMAX_SIGNIN_STATUS.Claimable
        ? todayIndex - 1
        : -1
    for (; index >= 0; index -= 1) {
      if (sorted[index]?.status !== MINIMAX_SIGNIN_STATUS.Claimed) break
      streakDays += 1
    }
  }
  const claimable = panel.days.find((day) => day.status === MINIMAX_SIGNIN_STATUS.Claimable)
  const target = today ?? claimable
  return {
    active: true,
    todayCheckedIn: claimedToday,
    streakDays,
    // ⚠️ points 就是总数，不相加 bonus_points
    dailyCredit: target?.points ?? 0,
    todayCredit: claimedToday ? (today?.points ?? 0) : 0,
    // ⚠️⚠️ **本字段当前不可判读，且几乎恒为 `true`**（2026-09-29 实测发现，
    // **未修复** —— 因为缺权威语义依据，不擅自改）。
    //
    // 实测本机 7 天面板：`bonus_points` 是 **800 档日 400 / 2000 档日 1000**，
    // **七天全都有值**。故 `bonusPoints > 0` 恒真，不携带任何信息 ——
    // 与 `credit/details` 那个 `total_count` 误读（见 `fetchMinimaxCreditBalance`）
    // 是**同一类缺陷形态**：拿一个「在已知样本上恰好符合预期」的字段当判据。
    //
    // 危害**目前为零**：`isStreakDay` 在 RPC（`computeClaimSummary` 只用
    // `credit`）与 Jet Hub UI 上**都没有消费者**（已全仓检索确认）。
    // 但语义仍是错的：`bonus_points` 看起来是「该日的额外奖励数额」，
    // **不是**「今天是连续奖励日」的布尔标志。
    //
    // 客户端权威实现（`.minimax-forensics/shared-dist/daily-signin.js`）里
    // **根本没有 `isStreakDay` 这个概念** —— 它只有 `getCurrentSigninStreak()`
    //（与我们的 `streakDays` 逐行一致）。故无法从客户端反推正确判据。
    // ⚠️ 要改先拿到 `bonus_points` 的权威语义（或真实「非连续日」样本），
    // **不要**凭猜测把它改成别的表达式。
    isStreakDay: (target?.bonusPoints ?? 0) > 0,
    totalCredits: 0,
    checkinDates: [],
    activityName: '',
    themeName: '',
    endTime: '',
  }
}

/** 一次请求的结果。 */
type EnvelopeResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: number; message: string }

/**
 * 取出业务载荷。
 *
 * ⚠️ **两个端点的响应形状不同，实测确认，不能一刀切**：
 * - `signin/status`、`signin/claim` 是**信封**：业务字段在 `data` 下；
 * - `credit/details` 是**平铺的**：`total_count` 与 `base_resp` **同级**
 *   （实测 `{ total_count: 0, base_resp: {...} }`，**没有** `data` 键）。
 *
 * 故这里「有 `data` 对象就用它，否则用顶层」—— 若强行只认 `data`，
 * 余额接口会把一个**合法响应**判成「响应缺少 data 字段」，
 * 于是「余额为 0」被报成查询失败（正是本任务要避免的那种误报）。
 */
function unwrapEnvelopeData(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.data
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : payload
}

/**
 * 发一次请求并拆信封。
 *
 * ⚠️ **业务码在 `base_resp.status_code`**，且 `invalid timezone_id` 也是 HTTP 200
 * —— 只看 HTTP 状态码会把它当成成功。
 *
 * ⚠️ 不抛错 —— 调用方按 `ok` 分支处理（批量领取时单账号失败不应中断其余账号）。
 */
async function requestEnvelope(
  url: string,
  credential: MinimaxCredential,
  init: { method: string; body?: string },
  fetcher: typeof fetch,
  product: MinimaxProduct,
  xff: string | undefined,
): Promise<EnvelopeResult> {
  try {
    // ⚠️ 必须传**真正的 `Headers` 实例**，不能 `{...headers}` 摊平成普通对象 ——
    // 后者会被 fetch 正常接受（看不出问题），但调用方拿到的 `.headers` 不再有
    // `.get()`，任何「断言某个头没被误设」的检查都会崩（写用例时实测到了）。
    //
    // ⚠️ 这里返回的是**构造器**：`minimaxFetch` 每跳调用一次，保证跟随重定向时
    // 凭据被**重新附上**（fetch 自动跟随会剥掉 Authorization，issue IKMEVG）。
    const buildInit = (): RequestInit => {
      // ⚠️ 走 `minimaxHeadersFor`：国际站会附上用户设置的 `X-Forwarded-For`
      //（绕开 Akamai 按出口 IP 的地理分流，见 `src/minimax.ts` 的 `withMinimaxXff`）。
      const headers = minimaxHeadersFor(credential, xff, product.id)
      if (init.body !== undefined) headers.set('Content-Type', 'application/json')
      return {
        method: init.method,
        headers,
        ...init.body === undefined ? {} : { body: init.body },
        signal: AbortSignal.timeout(MINIMAX_REQUEST_TIMEOUT_MS),
      }
    }
    /**
     * ⚠️ **带传输级重试 + 保凭据跟随重定向**，两者都是真实缺陷的修法：
     *
     * 1. 传输级重试（2026-10-15）—— 本机环境里的 HTTPS 检查代理约 **50%**
     *    概率打断到本家的请求（`fetch failed ← SELF_SIGNED_CERT_IN_CHAIN`），
     *    签到端实测 10 次里失败 5 次；
     * 2. 保凭据跟随 3xx（2026-10-17，issue IKMEVG）—— `agent.minimax.io`
     *    恒 307 到 `agent.minimaxi.com`，而 fetch 跨 origin 跟随会剥掉
     *    `Authorization` ⇒ 第二跳无凭据 ⇒ `400 invalid signature`。
     *
     * ⚠️ 两者合成在 `minimaxFetch` 一处（`src/minimax.ts`），与推理 / 目录
     * 路径**共用同一份**实现 —— 本文件不另写判据（同义判据分两处必然漂移）。
     *
     * ⚠️ `onGeoRoute`：在**跟随之前**记下「这是地理路由」（跟随后 401 与
     * 「凭据失效」逐字同形，事后无法区分）。
     */
    let geoRouted = false
    const response = await minimaxFetch(url, buildInit, {
      fetcher,
      onGeoRoute: () => { geoRouted = true },
    })
    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return {
        ok: false,
        code: response.status,
        message: response.status === 401 || response.status === 403
          ? `凭据已失效（HTTP ${response.status}），请重新登录该账号`
          : `服务端返回了非 JSON 响应（HTTP ${response.status}）`,
      }
    }
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, code: -1, message: '响应无法解析' }
    }
    const record = payload as Record<string, unknown>
    /**
     * ⚠️⚠️ **地理路由必须给出可操作文案**（issue IKMEVG，2026-10-17）。
     *
     * 判据是 `geoRouted`（跟随**之前**看到的 307），而不是响应体 ——
     * 因为跟到中国站后，国际站 token 得到的 `401 invalid access token`
     * 与「凭据真失效」**逐字同形**（本机实测），拿它判会把「换个网络就能用」
     * 误报成「请重新登录」（用户重登一百次也没用）。
     *
     * ⚠️ 只在**真的失败**时用这条文案：若用户设了可用的 XFF、请求成功，
     * `geoRouted` 为 false（根本没 307），不会走到这里。
     *
     * ⚠️⚠️ **必须把真实业务错误一起传进去**（自查发现的真实缺陷）：
     * `geoRouted` 只说明「这次请求经历过 307」，**不说明失败原因就是它**。
     * 实测反例：`307 → 402 insufficient_balance_error` 时，若整段换成地理路由
     * 说明，用户会一直去折腾网络，而**「去充值」这个唯一有效动作彻底消失**。
     * 故这里取响应体里的可读原因（`describeMinimaxApiError`）一并透出。
     */
    if (geoRouted && !response.ok) {
      return {
        ok: false,
        code: response.status,
        message: describeMinimaxGeoRoute(describeMinimaxApiError(record)),
      }
    }
    /**
     * ⚠️⚠️ **HTTP 非 2xx 必须判失败**（2026-10-17 修复的真实缺陷，issue IKMEVG）。
     *
     * ## 修前是什么样
     *
     * 整个函数只解析 JSON 体、**从不看 HTTP 状态码**（全文件唯一的
     * `response.status` 只出现在上面那条「非 JSON」文案里）。于是
     * `400 {"error":"invalid signature"}` 这种**没有 `base_resp`** 的响应体
     * 会走到下面的 `statusCode === undefined` ⇒ 被判 **`ok: true`**。
     *
     * ## 后果（用户看到的正是这三条）
     *
     * | 入口 | 拿到 `ok:true` 之后 | 面板文案 |
     * |---|---|---|
     * | `claim` | `data.claim_result` 缺失 | 「签到响应缺少有效的 claim_result」 |
     * | `signin/status` | 形状不认 ⇒ `null` | 签到状态不可用 |
     * | `credit/details` | `details`/`total_count` 都缺失 ⇒ `null` | 「余额查询失败」 |
     *
     * ⇒ 一条「ALB 说没凭据」，被翻译成三句**与真因无关**的话。
     *
     * ## ⚠️ 为什么这一格此前零覆盖
     *
     * 反向验证实测：注入 `if (!response.ok) return {ok:false…}` 后跑 62 条
     * minimax 用例 **全绿** —— 既有用例构造的响应全是 200 + 合法业务码，
     * 结构上抓不到这个分支。
     *
     * ## 取值口径
     *
     * - 报文里有 `base_resp.status_code` 时**仍以它为准**（本家「HTTP 200 +
     *   业务码」的既有习惯不变，见下面那段），HTTP 状态只作兜底；
     * - 把响应体里的 `error` / `error_description` / `message` 拼进文案 ——
     *   这条是**唯一有用的线索**（`invalid signature` 与
     *   `invalid access token` 指向完全不同的动作：前者是网关/重定向问题，
     *   后者才是凭据问题），丢掉它就只剩一句无信息的「失败」。
     */
    const apiError = describeMinimaxApiError(record)
    if (!response.ok) {
      const suffix = apiError === undefined ? '' : `：${apiError}`
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          code: response.status,
          message: `凭据已失效（HTTP ${response.status}）${suffix || '，请重新登录该账号'}`,
        }
      }
      return {
        ok: false,
        code: response.status,
        message: `服务端返回 HTTP ${response.status}${suffix}`,
      }
    }
    const baseResp = typeof record.base_resp === 'object' && record.base_resp !== null
      ? record.base_resp as Record<string, unknown>
      : {}
    const statusCode = finiteNumber(baseResp.status_code)
    const statusMsg = typeof baseResp.status_msg === 'string' ? baseResp.status_msg : ''
    if (statusCode !== undefined && statusCode !== 0) {
      return { ok: false, code: statusCode, message: statusMsg || `业务错误 ${statusCode}` }
    }
    return { ok: true, payload: record }
  } catch (error) {
    return {
      ok: false,
      code: -1,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 从**非信封**错误体里取一句人类可读的原因。
 *
 * 本家在失败时不给 `base_resp`，而是几种平铺形状（都是实测/已知形态）：
 * - `{"error":"invalid signature"}` —— ALB 网关层（无凭据/签名不对）；
 * - `{"error":"invalid access token"}` —— 凭据层（过期/非本站）；
 * - `{"error":"invalid_grant","error_description":"…"}` —— OAuth 层；
 * - `{"code":401,"message":"auth failed"}` —— 推理端点的自家信封。
 *
 * ⚠️ **必须如实透出原文**：`invalid signature` 与 `invalid access token`
 * 指向**完全不同**的处置动作（前者是网关/重定向，后者要重新登录），
 * 压成一句笼统的「查询失败」会让用户照着错的指引去重登。
 *
 * ⚠️ 只取第一个可用字段并**截断到 200 字符**：错误体可能很长（HTML/堆栈），
 * 而它要进 UI 文案。取不到就返回 `undefined`（**不编造**原因）。
 */
function describeMinimaxApiError(record: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    record.error_description,
    record.error,
    record.message,
    record.msg,
    // 嵌套形态：`{ error: { message } }`
    typeof record.error === 'object' && record.error !== null
      ? (record.error as Record<string, unknown>).message
      : undefined,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const text = candidate.trim()
      return text.length > 200 ? `${text.slice(0, 200)}…` : text
    }
  }
  return undefined
}

/** 构造带 `timezone_id` 的 URL。 */
function withTimezone(
  base: string,
  path: string,
  timezoneId: string,
): string {
  const url = new URL(`${base}${path}`)
  url.searchParams.set('timezone_id', timezoneId)
  return url.toString()
}

/**
 * 查询签到状态；失败返回 `null`（不抛错）。
 *
 * ⚠️⚠️ **本函数会丢弃失败原因**（返回 `null` 而非原因）—— 面板只能显示一句
 * 写死的「余额查询失败」。要拿到原因请用 {@link fetchMinimaxSigninStatusDetailed}。
 * 保留本签名是为了不破坏既有调用点与 `ProviderCredits.fetchStatus` 契约。
 */
export async function fetchMinimaxSigninStatus(
  credential: MinimaxCredential,
  fetcher: typeof fetch = fetch,
  product: MinimaxProduct = MINIMAX,
  xff?: string,
): Promise<CheckinStatus | null> {
  const detailed = await fetchMinimaxSigninStatusDetailed(credential, fetcher, product, xff)
  return detailed.status
}

/**
 * 查询签到状态，**失败时带原因**（`{ status: null, error }`）。
 *
 * ## ⚠️⚠️ 为什么必须有这个变体（真实缺陷，2026-10-17 审计打穿）
 *
 * `requestEnvelope` 会为失败构造**可操作**的文案（地理路由的两条出路 /
 * `凭据已失效（HTTP 401）：invalid access token` / `服务端返回 HTTP 400：invalid signature`），
 * 但 {@link fetchMinimaxSigninStatus} 与 {@link fetchMinimaxCreditBalance} 在
 * `!result.ok` 时**直接 `return null`** ⇒ 那条文案**一行都到不了 UI**，
 * 面板最终只显示 `jet-hub-rpc.ts` 里写死的「余额查询失败」。
 *
 * ⇒ 症状就是用户报障的原话「余额查询失败」**在修复后逐字未变** ——
 *   修好了判据，却把判据的结论扔掉了。
 *
 * 本仓库既有先例：`fetchBalanceDetailed`（codearts / gemini / clio 那一批）
 * 就是为「失败原因必须区分」而存在的。这里照同一模式补两个 Detailed 变体。
 */
export async function fetchMinimaxSigninStatusDetailed(
  credential: MinimaxCredential,
  fetcher: typeof fetch = fetch,
  product: MinimaxProduct = MINIMAX,
  xff?: string,
): Promise<{ status: CheckinStatus | null; error?: string }> {
  const url = withTimezone(
    product.apiHost,
    MINIMAX_SIGNIN_STATUS_PATH,
    resolveMinimaxTimezoneId(),
  )
  const result = await requestEnvelope(url, credential, { method: 'GET' }, fetcher, product, xff)
  if (!result.ok) return { status: null, error: result.message }
  const panel = parseMinimaxSigninPanel(unwrapEnvelopeData(result.payload))
  if (panel === undefined) {
    return { status: null, error: '签到面板响应形状不符合预期（服务端可能改版）' }
  }
  return { status: minimaxPanelToCheckinStatus(panel) }
}

/**
 * 领取每日签到。
 *
 * ⚠️ **幂等判据是 `claim_result`**（`1` = 本次真领取，`2` = 已领过），
 * **不是 HTTP 状态码**（重复领取同样 200）。
 *
 * ⚠️ 本函数**不抛错**（失败也返回 `failed`），保证批量领取不因单账号中断。
 */
export async function claimMinimaxDailyCheckin(
  credential: MinimaxCredential,
  fetcher: typeof fetch = fetch,
  product: MinimaxProduct = MINIMAX,
  xff?: string,
): Promise<ClaimOutcome> {
  const url = withTimezone(
    product.apiHost,
    MINIMAX_SIGNIN_CLAIM_PATH,
    resolveMinimaxTimezoneId(),
  )
  const result = await requestEnvelope(url, credential, { method: 'POST', body: '{}' }, fetcher, product, xff)
  if (!result.ok) {
    return { kind: 'failed', code: result.code, message: result.message }
  }
  const data = unwrapEnvelopeData(result.payload)
  const claimResult = finiteNumber(data.claim_result)

  // ⚠️ 幂等：重复领取返回 2（AlreadyClaimed）
  if (claimResult === MINIMAX_CLAIM_RESULT.AlreadyClaimed) {
    return { kind: 'already-claimed', message: '今日已签到' }
  }
  if (claimResult !== MINIMAX_CLAIM_RESULT.Claimed) {
    return { kind: 'failed', code: -1, message: '签到响应缺少有效的 claim_result' }
  }
  // ⚠️ credit 取 points（总数，已含 bonus_points）
  const points = finiteNumber(data.points) ?? 0
  const panel = parseMinimaxSigninPanel(data.panel)
  const status = panel === undefined ? undefined : minimaxPanelToCheckinStatus(panel)
  return {
    kind: 'claimed',
    credit: points,
    streakDays: status?.streakDays ?? 0,
    isStreakDay: status?.isStreakDay ?? false,
  }
}

/**
 * 查询积分余额。
 *
 * ## ⚠️ 一个已被生产数据推翻的字段误读（2026-09-29 修复）
 *
 * 初版把 `total_count` 当作**积分余额**。这是**错的** ——
 * `total_count` 是 `details[]` 的**记录条数**。
 *
 * 实测原始响应（本机账号领取 800 积分后）：
 * ```json
 * {"details":[{"remaining_amount":"800.00","consumed_amount":"0.00",
 *              "granted_amount":"800.00","credit_type":2,
 *              "granted_at_ms":1790645562328,"expire_at_ms":1793203200000}],
 *  "total_count":1,"base_resp":{"status_code":0,"status_msg":"ok"}}
 * ```
 * 真实余额是 `remaining_amount`（**800**），而 `total_count` 是 **1**。
 *
 * ⚠️ **为什么初版没被发现**：账号余额为 0 时 `details` **整个字段缺失**、
 * `total_count` 恰好也是 **0** —— 于是「条数 0」与「余额 0」在数值上
 * **偶然重合**，单测那条断言（`total_count: 0` → `total: 0`）因此成了
 * **同义反复**，无法暴露该误读。领取积分后才分叉（条数 1 / 余额 800）。
 *
 * ## 取值口径
 *
 * - **余额 = Σ `details[].remaining_amount`**（各有效包剩余之和，
 *   与既有 `CreditBalance.total` 的口径一致）。
 * - `remaining_amount` 实测是**字符串**（`"800.00"`），故需要宽容解析
 *   （数字与字符串都接受）—— 上游改型不该让余额整块失效。
 * - ⚠️ `details` 缺失/非数组 ⇒ 视为**空数组 ⇒ 余额 0**（「真的为 0」），
 *   **不是**「查询失败」。两者必须区分（`null` 才是失败）。
 * - ⚠️ `base_resp.status_code` 非 0 ⇒ `null`（真失败）。
 *
 * ## `packages` 的产出（2026-10-20 用户报障后补）
 *
 * 用户报障原文：「MiniMax Code 积分也有到期时间，也应当有相同功能」（附 AStudio
 * 面板截图作参照）。此前本函数把 `packages` **硬编码成 `[]`**，理由是
 * 「`credit_type` 的语义未实测，不凭猜测分类」—— 但那个理由说的是**分类**
 * （哪些算过期），与**到期时刻**是两件事：每个 `details[]` 条目都带
 * `expire_at_ms`（毫秒时间戳，实测 2026-10-20 真实账号 20 条全部有值），
 * 直接可用，无需猜 `credit_type` 语义。
 *
 * 实测形状（两站各取真实账号，`GET /minimax-cloud/api/v1/credit/details`）：
 *
 * | 发放 `granted_at_ms` | 剩余 `remaining_amount` | 到期 `expire_at_ms` |
 * |---|---|---|
 * | 2026-10-20 01:41:32 | 1000.00 | 2026-11-19 00:00:00 |
 * | 2026-10-19 00:40:51 | 1000.00 | 2026-11-18 00:00:00 |
 * | 2026-10-18 02:24:45 | 400.00 | 2026-11-17 00:00:00 |
 *
 * ⇒ 每条明细就是一个独立的「积分包」，到期时刻 = `granted_at_ms` 的 30 天后零点。
 * 这正是「临期优先」要的信息：先烧最快作废的那一笔。
 *
 * ⚠️ **`expiredTotal` 仍为 0**：它要与 `total` 相加构成「已过期」口径，
 *   而本响应**不下发已过期条目**（服务端只回有效包）⇒ 无从计算，不编造。
 *   `packages[].active` 恒为 `true` 是基于「服务端只回有效包」的实测；
 *   若将来它开始回过期条目，**必须**改用 `expire_at_ms > Date.now()` 判定
 *   （已在该处留注释）。
 */
export async function fetchMinimaxCreditBalance(
  credential: MinimaxCredential,
  fetcher: typeof fetch = fetch,
  product: MinimaxProduct = MINIMAX,
  xff?: string,
): Promise<CreditBalance | null> {
  const detailed = await fetchMinimaxCreditBalanceDetailed(credential, fetcher, product, xff)
  return detailed.balance
}

/**
 * 查询积分余额，**失败时带原因**（`{ balance: null, error }`）。
 *
 * ⚠️⚠️ 理由见 {@link fetchMinimaxSigninStatusDetailed}：原变体把
 * `requestEnvelope` 的可操作文案**整个丢弃**（`return null`），面板只显示写死的
 * 「余额查询失败」—— 于是用户永远不知道是地理分流、凭据失效还是网关签名。
 * 本函数把它透出来，供 `fetchBalanceDetailed` 通道使用。
 */
export async function fetchMinimaxCreditBalanceDetailed(
  credential: MinimaxCredential,
  fetcher: typeof fetch = fetch,
  product: MinimaxProduct = MINIMAX,
  xff?: string,
): Promise<{ balance: CreditBalance | null; error?: string }> {
  /**
   * ★★★ **必须带 `page_size`**（issue #141，2026-11-23 用户报障）。
   *
   * ## 缺陷
   *
   * 该端点**默认只返回最近 20 个积分包**，而本函数把可见包的 `remaining_amount`
   * 求和当余额 ⇒ **被挤出 20 条窗口的包，其剩余额度从界面上消失**。
   *
   * 用户每天签到新增一个包（400 / 1000 分），**最老的一个被挤出窗口** ⇒
   * 当被挤出的包余额接近新增包金额时，**界面总额彻底不动** ——
   * 这就是「明明显示签到成功、积分却不涨」的直接原因，且**误差随天数单调扩大**。
   *
   * ## 实测证据（issue #141 作者，真实账号，2026-11-22）
   *
   * `minimaxintl`，`total_count = 23`：
   *
   * | 请求 | `details` 条数 | Σ `remaining_amount` |
   * |---|---|---|
   * | 默认（无参数）| 20 | **11600.00** |
   * | `?page_size=50` | 23 | **12781.43** |
   *
   * 差额 1181.43 分来自被截断的 3 个包（400 + 400 + 381.43）。
   * `minimax`（国内站）一侧同为 24 条、默认只回 20 条。
   *
   * ## 为什么取 1000
   *
   * 作者实测 `page_size=50` 已能拿全 23/24 条；取 **1000** 是为了让**长期用户**
   * 也不会撞上第二次截断（每天一个包 ⇒ 1000 天 ≈ 2.7 年）。
   * ⚠️ 若上游哪天真的超过 1000 条，本函数仍会**静默少算** —— 这个残余风险
   * 已如实登记，根治要循环分页（`page` 参数**未实测**，猜错会死循环，
   * 故本轮不猜；`total_count` 是可用的自检点，见下方注释）。
   */
  const bareUrl = `${product.apiHost}${MINIMAX_CREDIT_DETAILS_PATH}`
  const sizedUrl = `${bareUrl}?page_size=1000`
  /**
   * ⚠️⚠️ **带 `page_size` 失败必须回退到不带参数**（2026-11-23 对抗审计 P1-3）。
   *
   * 这一点很重要，因为**如果只加参数、不加回退，修复可能比原缺陷更糟**：
   *
   * - 作者真机只验证过 `page_size=50`，**`1000` 从未实测**；
   * - 若上游校验上限并回 **4xx** ⇒ 本函数返回 `{ balance: null, error }`
   *   ⇒ 折算层判 `UNUSABLE` ⇒ **minimax 从聚合轮换里静默消失**
   *   —— 用户丢的是「整家渠道」，而不是「少算几百分」。
   *
   * ⇒ 先按大窗口取；**失败才退**回裸请求（拿到 20 条 = 旧行为，至少能用）。
   *    这样最坏情况退化成修复前的样子，不会比修复前更差。
   */
  let result = await requestEnvelope(sizedUrl, credential, { method: 'GET' }, fetcher, product, xff)
  if (!result.ok) {
    result = await requestEnvelope(bareUrl, credential, { method: 'GET' }, fetcher, product, xff)
  }
  if (!result.ok) return { balance: null, error: result.message }
  // ⚠️ 余额响应是**平铺**的（`details` / `total_count` 与 `base_resp` 同级，
  // 无 `data`）；`unwrapEnvelopeData` 对这种形状会原样返回顶层。
  const data = unwrapEnvelopeData(result.payload)
  // ⚠️ `base_resp.status_code` 由 `requestEnvelope` 判过，这里只需确认形状：
  // 若连 `details` 与 `total_count` 都没有，说明响应形状不对，不编造 0。
  const details = Array.isArray(data.details) ? data.details : undefined
  if (details === undefined && finiteNumber(data.total_count) === undefined) {
    return { balance: null, error: '余额响应形状不符合预期（服务端可能改版）' }
  }
  /**
   * ⚠️ **`total_count` 是记录总数、不是余额**（`fetchMinimaxCreditBalance` 已踩过这个坑）。
   * 但它恰好是**截断的自检点**：`details.length < total_count` 说明这次仍被截断。
   *
   * 本轮**刻意不动返回值**（余额仍是有意义的，弹错会让一次上游改版把整块变红），
   * 只把它写进注释并登记为残余风险 —— 若哪天真的超过 `page_size=1000`，
   * 这里就是复发点，届时改用循环分页（`page` 参数未实测，猜错会死循环）。
   */
  // ⚠️ 余额 = 各包 `remaining_amount` 之和；缺失 `details` ⇒ 0（真的为 0）。
  let total = 0
  const packages: CreditPackage[] = []
  for (const entry of details ?? []) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const remaining = looseAmount(row.remaining_amount)
    if (remaining === undefined) continue
    total += remaining
    const granted = finiteNumber(row.granted_at_ms)
    const expires = finiteNumber(row.expire_at_ms)
    packages.push({
      /**
       * ⚠️ 包名**不编造业务含义**：`credit_type` 的语义未实测（实测全部样本都是 2），
       * 故不按它起名（「签到包」/「活动包」都是猜测）。用发放日期作可区分标识
       * —— 它来自实测字段，且在 UI 上足以让用户对上「哪一笔」。
       */
      name: granted === undefined
        ? '积分包'
        : `积分包 ${new Date(granted).toLocaleDateString('zh-CN')}`,
      unit: 'credit',
      remaining,
      total: remaining,
      // ⚠️ `consumed_amount` 与 `granted_amount` 都在，但口径不确定
      //（`total` 究竟该取发放额还是「剩余+已用」未实测，两者在多笔混合消耗时不等）
      // ⇒ 只填有把握的：`total = remaining`，`used = 0`。
      // 两者在 `splitCreditsByExpiry` / `sharedPackageExpiry` 里**都没有消费者**
      //（它们只读 `active`/`remaining`/`deductionEndTime`），故不编造不会影响分档。
      used: 0,
      /**
       * ⚠️ 恒 `true`，依据是**实测「服务端只回有效包」**（20 条样本全部
       * `expire_at_ms` 晚于现在、`remaining_amount` 非 0）。
       * 若将来它开始回过期条目，**必须**改成
       * `expires !== undefined && expires > Date.now()`
       * —— 否则过期包会参与分档排序，把「已作废的额度」当成可用。
       */
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: expires === undefined
        ? ''
        : new Date(expires).toISOString(),
      /**
       * ⚠️⚠️ **这才是分档与到期排序唯一读的字段**（`CreditPackage` 的类型注释
       * 第 130 行起有完整说明）。`expire_at_ms` 实测是**毫秒时间戳**（无需 ×1000），
       * 直接透传 —— 不要做 `Date.parse` / 时区换算（那是字符串形态才需要的）。
       * 解析不出就**不写这个键**（`undefined` = 「到期时间未知」，
       * 分档会落到永久桶），绝不填 0（0 会被判成「服务端未下发」，语义不同）。
       */
      ...expires === undefined ? {} : { deductionEndTime: expires },
    })
  }
  return { balance: { total: roundCredits(total), packages, expiredTotal: 0 } }
}
