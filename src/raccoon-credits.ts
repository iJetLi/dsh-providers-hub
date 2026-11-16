/**
 * Raccoon Work 积分（余额 + 每日签到 + 一次性登录奖励）。
 *
 * ## 三个来源的语义（2026-11-15 修正）
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放（`reward_grant`） | 不涉及（用户注册即有） |
 * | 桌面端登录奖励 | 3000 | `POST …/desktop/v1/login/points/grant`（幂等一次性） | ✅ `claimRaccoonLoginReward` |
 * | 每日赠送积分 | 300/日 | **`GET …/office/v3/setting_info`**（按天幂等） | ✅ `claimRaccoonDailyCheckin` |
 *
 * ## ⚠️⚠️ 旧结论「每日 300 没有签到端点」已作废（2026-11-15 真实账号复验）
 *
 * 原注释的依据是「`/points/v1|v2` 下 `sign_in` / `check_in` / `daily` / `claim`
 * 全 404」，那条**仍然成立**（本次逐个复验，仍是 HTML 无关的纯文本
 * `404 page not found`）—— 但结论下早了：每日积分的触发器不在 points 前缀下，
 * 而在**办公端**的 `GET /api/web/office/v3/setting_info`。
 *
 * 实测（2026-11-16 00:14 UTC+8，跨日后第一次调用，3 个真实账号各一次）：
 * - `available_points` 三个账号**全部 +300**，`daily_points` 同步 +300；
 * - 响应带 `point_grant_popups: [{source:'daily', points:300,
 *   expire_at:'2026-11-22T23:59:59+08:00'}]`；
 * - 紧接着再调一次 ⇒ `popups: []` + 余额不变 ⇒ **按天幂等**，重复调用不会多发。
 *
 * ## 成功判据：以**余额前后差**为准，账单只作兜底
 *
 * ⚠️ 触发成功后**立刻**拉账单有时看不到当天那笔（积分记录同步有延迟，官方文档
 * 也写了这一点）。只用账单会把「刚发放成功」误报成「今天早就发过了」——
 * 用户看到「已领」而实际未记账，逐日累计就差一整笔。故顺序是：
 * 余额(before) → 触发 → 余额(after) → 差额 > 0 判 `claimed`；差额为 0 才查账单
 * 区分「今天早些时候已到账」与「确实没发」。
 *
 * ## 账单必须走 v2 + `type=income`
 *
 * v1 的 `/bills` 按时间倒序返回全部记录（消耗也在内）。2026-11-15 实测三个
 * 账号的 `paging.limit=50` 全被 `daily_grant` + `desktop` 占满，
 * `reward_grant` **零命中** ⇒ 登录奖励状态恒报「未领取」。见
 * {@link RACCOON_POINTS_V2_PREFIX}。
 *
 * ## ⚠️ 登录奖励仍是「一次性」，不登记为每日签到
 *
 * 它幂等一次性（已领过返回 `granted:false`），语义与 Loomy 的新手任务同构，
 * 故登记为 `onboardingTasks`；`dailyCheckin` 归的是每天的 `setting_info` 那条。
 *
 * ## 只读优先
 *
 * 余额查询用 `GET /points/v1/balance`（**只读**）。在「打开面板」这类
 * 高频路径上**绝不**触碰触发端点（Loomy 的 `first-login` 就踩过这个坑：
 * 打开面板即意外触发签到）。
 */

import {
  RACCOON_POINTS_PREFIX,
  RACCOON_POINTS_V2_PREFIX,
  RACCOON_DESKTOP_PREFIX,
  RACCOON_OFFICE_PREFIX,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonHeaders,
  type RaccoonCredential,
} from './raccoon.js'
import { RACCOON, type RaccoonProduct } from './raccoon-product.js'
import { roundCredits, type ClaimOutcome, type CreditBalance, type CreditPackage } from './credits.js'

/** 登录奖励的默认额度（服务端未在 popup 里给出时兜底）。 */
export const RACCOON_LOGIN_REWARD_POINTS = 3000

/** 登录奖励在账单里的 `event_name`（用于判定是否已领）。 */
export const RACCOON_LOGIN_REWARD_EVENT_NAME = '桌面端登录奖励'

/**
 * 每日积分在账单里的 `event_name` 与 `biz_type`。
 *
 * 实测三个账号逐条一致（`biz_type: 'daily_grant'`、`event_name: '每日积分发放'`）。
 * ⚠️ 判据**只用 `biz_type`**：`event_name` 是展示文案、上游随时可能改字，
 * 而 `biz_type` 是机器码。`event_name` 留在这里只为 README/排查时对得上。
 */
export const RACCOON_DAILY_GRANT_BIZ_TYPE = 'daily_grant'
export const RACCOON_DAILY_GRANT_EVENT_NAME = '每日积分发放'

/** 业务响应信封。 */
interface Envelope {
  ok: boolean
  code: number
  message: string
  data: Record<string, unknown> | undefined
}

/** 解析信封；`code === 0` 为成功。 */
function parseEnvelope(payload: unknown, status: number): Envelope {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const code = typeof record.code === 'number' ? record.code : (status >= 400 ? status : 0)
  const message = typeof record.message === 'string' && record.message.length > 0
    ? record.message
    : (typeof record.details === 'string' ? record.details : '')
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined
  return { ok: code === 0, code, message, data }
}

/** 读成有限数字；非法返回 undefined（**不编造 0**）。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 发一次业务请求并拆信封。
 *
 * ⚠️ 不抛错 —— 调用方按 `ok` 分支处理。积分查询/领取属「尽力而为」，
 * 批量操作时单个账号失败不应中断其余账号。
 */
async function requestJson(
  url: string,
  credential: RaccoonCredential,
  product: RaccoonProduct,
  init: { method: string; body?: string },
  fetcher: typeof fetch,
): Promise<Envelope> {
  try {
    const response = await fetcher(url, {
      method: init.method,
      headers: raccoonHeaders(credential, {
        platform: product.clientPlatform,
        version: product.clientVersion,
      }),
      ...init.body === undefined ? {} : { body: init.body },
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
    const parsed: unknown = await response.json()
    return parseEnvelope(parsed, response.status)
  } catch (error) {
    return {
      ok: false,
      code: -1,
      message: error instanceof Error ? error.message : String(error),
      data: undefined,
    }
  }
}

/** 构造一个资源包条目。 */
function makePackage(name: string, remaining: number): CreditPackage {
  return {
    name,
    unit: '积分',
    remaining,
    total: remaining,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
}

/**
 * 查询积分余额（映射成既有的 `CreditBalance` 形状）。
 *
 * ⚠️ 各池**分开作 package**，让用户看出「注册礼包 / 每日 / 充值」是独立来源
 * —— 它们的有效期与回补规则都不同（每日积分每日刷新、充值积分长期有效）。
 *
 * @returns 查不到时返回 `null`（卡片显示原因，**不是** 0）。
 */
export async function fetchRaccoonCreditBalance(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_PREFIX}/balance`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) return null

  const available = readNumber(envelope.data.available_points)
  // `available_points` 是核心字段：没有它就说明响应形状不对，不编造数字。
  if (available === undefined) return null

  const packages: CreditPackage[] = []
  const reward = readNumber(envelope.data.reward_points)
  const daily = readNumber(envelope.data.daily_points)
  const topup = readNumber(envelope.data.topup_points)
  const monthly = readNumber(envelope.data.monthly_points)
  if (reward !== undefined) packages.push(makePackage('奖励积分', reward))
  if (daily !== undefined) packages.push(makePackage('每日积分', daily))
  if (monthly !== undefined && monthly > 0) packages.push(makePackage('会员积分', monthly))
  if (topup !== undefined) packages.push(makePackage('充值积分', topup))

  return {
    total: available,
    // 极端情形（服务端只给 total 不给分项）也要有至少一个包，否则 UI 空列表
    packages: packages.length > 0 ? packages : [makePackage('可用积分', available)],
    expiredTotal: 0,
  }
}

/**
 * 领取「桌面端登录奖励」（一次性，幂等）。
 *
 * ⚠️ **不是每日签到**：实测该端点是幂等一次性的（已领过返回 `granted:false`
 * 且账单里能看到上一次的记录）。映射到 `onboardingTasks` 能力。
 *
 * ⚠️ 需要 `X-Client-Platform` 头（值见 `product.clientPlatform`）——
 * 它标识「来自桌面端」，缺了会被拒。见 `raccoonHeaders`。
 *
 * 本函数**不抛错**（失败也返回 `failed`），保证批量领取不会因单个账号中断。
 */
export async function claimRaccoonLoginReward(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_DESKTOP_PREFIX}/login/points/grant`,
    credential,
    product,
    { method: 'POST' },
    fetcher,
  )

  if (!envelope.ok) {
    return {
      kind: 'failed',
      code: envelope.code,
      message: envelope.message.length > 0 ? envelope.message : '领取登录奖励失败',
    }
  }

  // ⚠️ 幂等判据是 `granted`（重复领取同样返回 HTTP 200 + `granted:false`），
  // 故映射成 `already-claimed` 而**不是** `claimed` ——
  // 后者会让用户以为每天都真的加了额度。
  if (envelope.data?.granted !== true) {
    return {
      kind: 'already-claimed',
      message: '该账号已领取过桌面端登录奖励（每号一次）',
    }
  }

  const popup = typeof envelope.data.popup === 'object' && envelope.data.popup !== null
    ? envelope.data.popup as Record<string, unknown>
    : undefined
  const points = readNumber(popup?.points) ?? RACCOON_LOGIN_REWARD_POINTS
  return { kind: 'claimed', credit: points, streakDays: 0, isStreakDay: false }
}

/** 账单里的一条入账记录（只取本模块用到的字段）。 */
interface RaccoonBillItem {
  readonly bizType: string
  readonly eventName: string
  readonly points: number
  readonly createdAt: string
}

/**
 * 拉「收入」账单（只含发放记录，不含消耗）。
 *
 * ⚠️ **必须走 v2 + `type=income`**，理由见 {@link RACCOON_POINTS_V2_PREFIX}：
 * v1 的前 50 条实测已被 `daily_grant` + `desktop` 占满，
 * `reward_grant` 零命中 ⇒ 领过的账号也会被判成「未领取」。
 *
 * @returns `null` 表示查不到（调用方不得编造 0）。
 */
async function fetchRaccoonIncomeBills(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch,
): Promise<RaccoonBillItem[] | null> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_V2_PREFIX}/bills?paging.limit=100&type=income`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) return null
  // ⚠️⚠️ 形状不对必须回 `null`（= 查不到），**不能**回空数组。
  //
  // 两种「没有」在语义上是两件事：`items: []` 是「上游明确说这段时间没记录」，
  // `items` 缺失/不是数组是「上游改了响应形状（协议漂移）」—— 后者是最该报
  // 异常的时刻，读成「今天没发」会让调用方（`fetchRaccoonTodayDailyGrants` /
  // `fetchRaccoonOnboardingStatus`）静默得出错误结论。同文件
  // `fetchRaccoonCreditBalance` 对形状异常就是 `return null`，两条路径必须同口径。
  if (!Array.isArray(envelope.data.items)) return null
  const raw: readonly unknown[] = envelope.data.items
  const items: RaccoonBillItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    // ⚠️⚠️ `points` 读不出来 **不得丢整行**（PR #88 对抗审计 C4 的回归）：
    // 旧实现把 `points` 只用于**金额**，行的存在本身就等于「这条发放发生过」；
    // 改成丢行后，「上游把 points 写成字符串」或「上游不返回 points」这两种
    // 纯展示性问题，会让 `onboarding` 的 `claimed` 由 true 翻成 false ——
    // 用户被告知「登录奖励还能领」，点一次又白跑三轮请求。
    // ⇒ 金额读不出时记 0，行照样保留；需要金额的地方自己按 `> 0` 过滤。
    const points = readNumber(record.points) ?? 0
    items.push({
      bizType: typeof record.biz_type === 'string' ? record.biz_type : '',
      eventName: typeof record.event_name === 'string' ? record.event_name : '',
      points,
      createdAt: typeof record.created_at === 'string' ? record.created_at : '',
    })
  }
  return items
}

/**
 * 查询「桌面端登录奖励」是否已领（供 `onboarding.status` 用）。
 *
 * 判据：收入账单里存在 `biz_type === 'reward_grant'` 且
 * `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠️⚠️ **这里是「判据只用 `biz_type`」那条纪律的唯一例外，且是刻意的**：
 * 「新人注册礼包」也是 `reward_grant`（实测），只按 `biz_type` 判会让新用户
 * 一打开面板就显示「登录奖励已领取」。⇒ 必须再叠一层 `event_name` 才能区分。
 * 代价是**上游改文案就会翻成未领**（对抗审计 F7/C6 实测：把「桌面端登录奖励」
 * 改成「…发放」⇒ `claimed` 由 true 变 false），这是一个**已知的取舍**：
 * 宁可让老用户偶尔多点一次（服务端幂等，无害），也不要让新用户一开始就错过。
 *
 * ⚠️ **不能靠 `balance` 推断** —— 余额是多个来源（注册礼包/每日/充值）的
 * 合计，无法区分某一项是否已领。
 * ⚠️ **不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」
 * 也是 `reward_grant`，把它算作登录奖励会让新用户一开始就显示「已领取」。
 * ⚠️ **服务端没有单独的奖励状态端点**（实测），故只能查账单明细。
 * ⚠️ 查询失败时保守返回 `claimed: false` —— 宁可让用户多点一次
 * （服务端幂等，无害），也不要误报「已领」而让他真的错过。
 */
export async function fetchRaccoonOnboardingStatus(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<{ claimed: boolean; points: number }> {
  const items = await fetchRaccoonIncomeBills(product, credential, fetcher)
  if (items === null) {
    return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS }
  }

  let claimed = false
  let points = RACCOON_LOGIN_REWARD_POINTS
  for (const item of items) {
    if (item.bizType !== 'reward_grant') continue
    if (item.eventName !== RACCOON_LOGIN_REWARD_EVENT_NAME) continue
    claimed = true
    if (item.points > 0) points = item.points
    break
  }
  return { claimed, points }
}

/* ────────────────────── 每日签到（办公端结算触发器） ──────────────────────
 *
 * 「签到」在本渠道 = **打一次只读的 `GET /office/v3/setting_info`** + 用余额差
 * 核对。触发请求本身没有请求体、没有写语义（它本职是拉设置），重复调用只会
 * 返回「今天已经结算过了」—— 故它天然幂等，可以每天无脑调。
 *
 * ⚠️ 与 Loomy 的 `POST /points/first-login` 形态不同，**不要照抄那个**：
 * 那边是显式写端点，这边是「读端点顺带结算」。
 */

/**
 * UTC+8 的当天日期（`YYYY-MM-DD`）—— 上游每日积分按北京零点切日。
 *
 * ⚠️ 必须用**算术平移**而不是本机时区：日界归服务端（UTC+8），用本机时区
 * 会在用户出差 / 改系统时区时得到错的「今天」。
 */
export function raccoonUtc8Date(nowMs: number = Date.now()): string {
  return new Date(nowMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 触发结果：成功时带上游自带的发放提示（已结算过则为空）。 */
export interface RaccoonDailyGrantResult {
  readonly ok: boolean
  readonly message: string
  readonly toast: string
  readonly popups: ReadonlyArray<{ displayName: string; points: number; expireAt: string }>
}

/**
 * 触发一次「每日积分结算」（按天幂等）。
 *
 * @returns `ok: false` 表示上游拒绝 / 网络失败（`message` 带原因）；
 *          `ok: true` 时 `toast` / `popups` 是上游自带的发放提示，**可能为空**
 *          （为空只说明「今天此前已经结算过」，不代表失败）。
 */
export async function triggerRaccoonDailyGrant(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonDailyGrantResult> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_OFFICE_PREFIX}/setting_info`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok) {
    const reason = envelope.message.length > 0 ? envelope.message : `HTTP ${envelope.code}`
    return { ok: false, message: `每日积分结算失败：${reason}`, toast: '', popups: [] }
  }
  const data = envelope.data ?? {}
  const toast = typeof data.point_grant_toast === 'string' ? data.point_grant_toast : ''
  const popups: Array<{ displayName: string; points: number; expireAt: string }> = []
  for (const raw of Array.isArray(data.point_grant_popups) ? data.point_grant_popups : []) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    popups.push({
      displayName: typeof record.display_name === 'string' ? record.display_name : '积分发放',
      points: readNumber(record.points) ?? 0,
      expireAt: typeof record.expire_at === 'string' ? record.expire_at : '',
    })
  }
  return { ok: true, message: '', toast, popups }
}

/**
 * 读账单，汇总「今天（UTC+8）到账的每日积分」。
 *
 * @returns `null` 表示账单查不到（调用方必须当成失败，不能编造 0）。
 */
export async function fetchRaccoonTodayDailyGrants(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<{ total: number; entries: ReadonlyArray<{ name: string; points: number }> } | null> {
  const items = await fetchRaccoonIncomeBills(product, credential, fetcher)
  if (items === null) return null
  const today = raccoonUtc8Date(nowMs)
  const entries: Array<{ name: string; points: number }> = []
  for (const item of items) {
    if (item.bizType !== RACCOON_DAILY_GRANT_BIZ_TYPE) continue
    if (item.points <= 0) continue
    // ⚠️⚠️ 必须按**绝对时刻**归到北京日，不能截 `created_at` 的前 10 个字符。
    //
    // 上游当前发的是 `2026-11-16T00:14:0x+08:00` 形态，截前 10 位恰好等于北京日；
    // 但这个等式**只在偏移为 `+08:00` 时成立**。若上游改成 `Z`（UTC），
    // `2026-11-15T20:00:00Z` = 北京 `2026-11-16 04:00`，截出来却是 `2026-11-15`
    // ⇒ 北京 00:00~08:00 这八小时的记录**全部跨日判错**（约 1/3），
    // 而这条账单正是「差额为 0 时」唯一能救回正确结论的兜底腿。
    // `Date.parse` 对 `+08:00` 与 `Z` 都返回正确的毫秒数，两种形态一起覆盖。
    const stamp = Date.parse(item.createdAt)
    if (!Number.isFinite(stamp)) continue
    if (raccoonUtc8Date(stamp) !== today) continue
    entries.push({ name: item.eventName.length > 0 ? item.eventName : RACCOON_DAILY_GRANT_EVENT_NAME, points: item.points })
  }
  return { total: roundCredits(entries.reduce((sum, entry) => sum + entry.points, 0)), entries }
}

/**
 * 每日签到：触发办公端结算，再用**余额前后差**核对。
 *
 * 三条返回分支：
 * - 余额差额 > 0 ⇒ `claimed`（`credit` = 差额，含上游顺带补发的历史缺额）；
 * - 差额为 0 且今日账单已有 `daily_grant` ⇒ `already-claimed`（今天早些时候到过账）；
 * - 触发或两次余额查询都失败 ⇒ `failed`（带原因，**不虚报成功**）。
 *
 * ⚠️ `coversToday` **不再恒为 `true`**：只有在「差额 > 0」或「账单/弹窗给出了
 * 今天的凭证」时才声明今天已处理；**三者都拿不到证据时回 `false`**
 * （让自动签到下一轮重试，而不是把真失败锁成当天不再尝试）。
 *
 * ⚠️ 余额查询失败（`null`）**不直接判失败**：差额判据要求两次都读得到，
 * 读不到就退到账单判据 —— 账单也说没有时才算「今天没发」。这条短路顺序
 * 是刻意的：余额端点偶尔 5xx 时不该让用户看到「签到失败」。
 */
export async function claimRaccoonDailyCheckin(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const before = await fetchRaccoonCreditBalance(product, credential, fetcher)
  const triggered = await triggerRaccoonDailyGrant(product, credential, fetcher)
  if (!triggered.ok) {
    return { kind: 'failed', code: -1, message: triggered.message, coversToday: true }
  }
  const after = await fetchRaccoonCreditBalance(product, credential, fetcher)
  // 账单无论走哪条分支都要用（差额分支拿它对账，兜底分支拿它判「今天到过没」），
  // 故只查一次。注意它可能为 `null`（= 查不到，与「没有记录」是两件事）。
  const today = await fetchRaccoonTodayDailyGrants(product, credential, fetcher)
  const todayDaily = today !== null && today.total > 0 ? today.total : 0
  if (before !== null && after !== null) {
    const gained = roundCredits(after.total - before.total)
    if (gained > 0) {
      // ⚠️⚠️ 余额差**不能直接当成签到金额**（PR #88 对抗审计 F1 / 正向 P1-1）。
      //
      // `total` 是 `available_points` —— 全部来源的合计（注册礼包 / 每日 /
      // 登录奖励 / 充值）。用户在「before 与 after 之间」领了桌面端登录奖励
      // （3000，按钮就渲染在同一个面板上）或充值，差额就是 3300，而这里原本
      // 会回「今天签到领了 3300」—— 日额只有 300。
      //
      // ⇒ 金额以**账单里今天的 `daily_grant` 合计**为准；账单查不到/为空时
      // 退回余额差，但必须在 message 里讲清「可能含同期其它入账」。
      const credit = todayDaily > 0 ? todayDaily : gained
      return {
        kind: 'claimed',
        credit,
        streakDays: 0,
        isStreakDay: false,
        coversToday: true,
        ...todayDaily > 0
          ? {}
          : {
              message: `余额增加 ${gained}，但账单里今天的每日积分合计为 0 —— 该金额可能包含同期其它入账（登录奖励 / 充值），签到日额以余额实际到账为准`,
            },
      }
    }
  }
  // 余额差为 0（或余额读不到）时再问账单：今天早些时候真的到过账吗？
  if (today !== null && today.total > 0) {
    const detail = today.entries.slice(0, 3).map((entry) => `${entry.name}+${entry.points}`).join('，')
    return {
      kind: 'already-claimed',
      message: `今日每日积分已到账 ${today.total}（${detail}）`,
      coversToday: true,
    }
  }
  // 触发成功、余额没变、账单也没有 ⇒ 上游认为今天已经结算过，但没有可展示的凭证。
  // 如实报「已处理」而不是 `claimed`：编一个金额就是报假账。
  const popupPoints = triggered.popups.reduce((sum, popup) => sum + popup.points, 0)
  // ⚠️⚠️ **零证据时不得声明「今天已处理」**（PR #88 双向审计的 P1）。
  //
  // 走到这里意味着三件事都没给出答案：两次余额读不到 / 没变化，账单也查不到，
  // popup 与 toast 都是空的。此时原来的写法回 `already-claimed` +
  // `coversToday: true` —— 而 `computeClaimSummary` 会把它计进 `coversToday`、
  // `auto-checkin` 据此 `proven.add(provider)` ⇒ **当天第二个时段（21:00）
  // 不再重试**，真失败（网关抖动 / 上游结算延迟）被永久伪装成「已结算」。
  //
  // 修法：`coversToday: false` ⇒ 自动签到下一轮会再问一次。
  // **不改判 `failed`**：上游很可能真的发了、只是我们看不到（余额端点 5xx），
  // 报 `failed` 会让这类用户每天看到「签到失败」而无处可修。
  //
  // popup 里**有**积分时反而是有证据的（上游明确说「今天发了 N」）⇒ 保持 true。
  const hasPopupEvidence = popupPoints > 0 || triggered.toast.length > 0
  return {
    kind: 'already-claimed',
    message: triggered.toast.length > 0
      ? triggered.toast
      : popupPoints > 0
        ? `今日每日积分已发放 ${popupPoints}（账单同步有延迟，稍后可在余额看到）`
        : '每日积分结算已触发，但余额与账单都读不到，无法确认是否到账（稍后自动重试）',
    coversToday: hasPopupEvidence,
  }
}

/** 默认产品配置下的便捷包装（供 `RaccoonAuth` 调用）。 */
export const raccoonCreditsForDefaultProduct = {
  fetchBalance: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    fetchRaccoonCreditBalance(RACCOON, credential, fetcher),
  claimLoginReward: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    claimRaccoonLoginReward(RACCOON, credential, fetcher),
  fetchOnboardingStatus: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    fetchRaccoonOnboardingStatus(RACCOON, credential, fetcher),
  claimDailyCheckin: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    claimRaccoonDailyCheckin(RACCOON, credential, fetcher),
  triggerDailyGrant: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    triggerRaccoonDailyGrant(RACCOON, credential, fetcher),
}
