/**
 * WorkBuddy 国际版（www.workbuddy.ai）的「每日活跃」链路。
 *
 * ## 为什么单独一个文件
 *
 * 国内版（CodeBuddy，copilot.tencent.com）的每日奖励就是一次签到：`claim`
 * 成功即到账。国际版不一样 —— 它的每日奖励**挂在活动上**，活动没开时
 * `/daily-checkin` 回 `41000`（活动未开始或已结束），此时真正驱动到账的是
 * **活跃**：上游按「当日是否活跃」异步发放。
 *
 * 活跃这件事由三个互补的端点构成（实测依据见
 * `docs/agent-notes/providers-workbuddy-intl-checkin.md`，移植自社区实现 L0NE-6/WorkBuddy-Daily
 * 的 `workbuddy_intl_daily.py`）：
 *
 * | 动作 | 端点 | 作用 |
 * | --- | --- | --- |
 * | 上报 | `POST /v2/report`（`chat_request_send` 事件） | 点亮成长中心「连登」 |
 * | 回读 | `GET /activity/growth/streak` | 读连登天数（只读，兼作上报是否生效的判据） |
 * | 网页会话 | `POST /console/as/conversations/` | 上游「当日活跃」计数**只认这一发** |
 *
 * 还有第四发（`POST /v2/chat/completions` 发一次最小对话）刻意**不移植**：
 * 它只是维持「账号有调用」，既不进「当日活跃」计数、也要烧模型额度。
 *
 * ## 契约（与 `ProviderCredits.afterClaimNote` 对齐）
 *
 * - **永不抛**：任何失败都折算成 `undefined` 或一句说明，绝不能把签到结果
 *   带成失败（本仓库有两轮「签到成功却因记账失败被报成失败」的事故史）。
 * - 返回 `undefined` 表示「没做事」（本就不该报出来，报出来是噪声）。
 * - 缺 `user_id` 时**什么都不发**：`/v2/report` 的 `userId` 是必填，缺了会被
 *   服务端**静默丢弃**（回 200，但什么也没发生）—— 那就成了一次假成功。
 */

import { randomUUID } from 'node:crypto'

import { BUDDY_DEPLOYMENT_TYPE, HTTP_HEADER_DOMAIN, HTTP_HEADER_PRODUCT } from './buddy.js'
import type { BuddyCredential } from './buddy.js'
import type { ClaimOutcome } from './credits.js'
import type { BuddyProduct } from './product.js'

/** 活跃上报端点（`chat_request_send` 事件，body 是**数组**）。 */
export const WORKBUDDY_INTL_REPORT_PATH = '/v2/report'
/** 连登天数回读端点（只读）。 */
export const WORKBUDDY_INTL_STREAK_PATH = '/activity/growth/streak'
/** 网页通道建会话端点（「当日活跃」计数只认它）。 */
export const WORKBUDDY_INTL_WEB_CONVERSATION_PATH = '/console/as/conversations/'

/** 网页会话与上报共用的免费模型链（逐个尝试，全部失败才算失败）。 */
export const WORKBUDDY_INTL_MODELS: readonly string[] = [
  'deepseek-v4.1-flash',
  'hy3',
  'hy4-preview',
  'hy4-preview-f',
]

/**
 * **单次**请求超时（毫秒）。
 *
 * ⚠️ 原文这里写「不该被三发附加请求拖成转圈 90 秒」—— 那个算术是错的：
 * 实际最多 **6 发**（上报 + 回读 + 至多 4 个模型的网页会话），而它们是
 * **串联**的 ⇒ 单靠这个常量封不住，最坏 6 × 20s = 120 秒/账号。
 * 真正封顶的是 `KEEP_TOTAL_BUDGET_MS`（见下），这里只管一发别挂太久。
 */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * 一次 `keepWorkBuddyIntlActivity` 的**总**预算（P1-3）。
 *
 * 三发是**串联**的（上报 → 回读 → 至多 4 个模型的网页会话），按 `REQUEST_TIMEOUT_MS`
 * 各给 20s 最坏 6 × 20s = **120 秒/账号**，而 `jet-hub-rpc` 的
 * `afterClaimNote` **没有任何 deadline**（`roundDeadlineAt` 只给 `afterClaim`），
 * 且账号是 `for` 串行 ⇒ N 账号线性叠加 ⇒ 撞宿主 RPC 超时。
 *
 * 这里给总预算 45s：足够正常情况（上报 + 回读各 0.2~2s，网页会话 2~5s），
 * 又不会让「上游挂住」把整条签到拖到用户以为卡死。
 */
const KEEP_TOTAL_BUDGET_MS = 45_000

/**
 * 是否顺带发一发网页会话（默认关）。
 *
 * ## 为什么默认关
 *
 * 它会在**用户账号里留下一个真实会话**（标题 `Hi`）。这属于「可见副作用」，
 * 一个网关不该在无人察觉时替用户造对话。而它又是「活动未开放」时唯一能完成
 * 当日活跃的路径 ⇒ 故做成开关，而不是删掉：
 *
 * ```bash
 * DSH_WORKBUDDY_INTL_WEB_SESSION=1
 * ```
 *
 * ## ⚠️ 它**不是**无条件执行的（PR #87 对抗审计 P1-1）
 *
 * 本发只在「本次签到确实留下了痕迹」时才发 —— 即 `outcome.kind` 是
 * `claimed` 或 `already-claimed`。`inactive`（`41000` 活动未开）与 `failed`
 * 不发：`inactive` 不计 `coversToday`（`auto-checkin.ts`），下个时段会重试，
 * 若无条件发，中招日两个时段各发一次 ⇒ **用户账号里 2 个 `Hi` 会话/天**
 * （30 天 60 个）。
 *
 * 打开方式（`1` / `true` / `yes` 都认；其余值（含 `0` / `false`）一律关）：
 *
 * ```bash
 * DSH_WORKBUDDY_INTL_WEB_SESSION=1
 * ```
 */
function webSessionEnabled(): boolean {
  const raw = (process.env.DSH_WORKBUDDY_INTL_WEB_SESSION ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * 取可用的账号 uid，非**字符串**或空串时回 `undefined`。
 *
 * ⚠️⚠️ 必须用 `typeof === 'string'` 而不是 `.length === 0`（PR #87 对抗审计
 * P1-4）：`user_id` 是 `0` / `{}` 时 `.length` 是 `undefined`，
 * `undefined === 0` 为 `false` ⇒ **守卫不守**，于是发出 `userId: 0` / `userId: {}`
 * 且回 `ok:true`（本仓 `docs/agent-notes/misc.md` 的 `String(undefined)` 同型）。
 */
function usableUidOf(credential: BuddyCredential): string | undefined {
  const raw: unknown = credential.user_id
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/** 一次 JSON 请求的结果（失败带可读原因，不抛）。 */
type JsonResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string }

/**
 * 构造签到/上报请求头。
 *
 * 与 `credits.ts` 的 `checkinHeaders` 同族（同一套产品身份头），但少一个
 * `X-Product-Code`：`/v2/report` 与网页会话端点**都不校验**它，多带一个只在
 * 国际版客户端里不存在的头反而是特征。`X-Domain` 必须与 `product.endpoint`
 * 一致 —— 用凭据里的旧 domain 会在跨区迁移过的账号上自相矛盾。
 */
function headersOf(credential: BuddyCredential, product: BuddyProduct): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    [HTTP_HEADER_DOMAIN]: product.apiDomain ?? credential.domain ?? '',
    [HTTP_HEADER_PRODUCT]: BUDDY_DEPLOYMENT_TYPE,
    'User-Agent': product.userAgent,
  }
  const uid = usableUidOf(credential)
  if (uid !== undefined) headers['X-User-Id'] = uid
  return headers
}

/**
 * 发一次请求并把响应体解析成对象。
 *
 * ⚠️ **先取文本再 parse**：凭据失效时腾讯网关回的是 **HTML 错误页**，
 * `response.json()` 抛出的 `Unexpected token '<'` 对用户毫无意义（同
 * `credits.ts` 的 `postJson` 记过的那次真实缺陷）。
 */
async function requestJson(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<JsonResult> {
  try {
    // ⚠️ 夹取**只在这一处**（`Math.min` 必须留在这里，不能只靠调用方）：
    //    调用方传进来的 `timeoutMs` 是「这次还剩多少预算」，可能远大于单发上限；
    //    去掉 `Math.min` 会让首发拿到整个总预算（45s），正是「上游挂住为什么还慢」的成因。
    const response = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, Math.max(1, timeoutMs))),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, message: `HTTP ${response.status} 非 JSON 响应` }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, message: `HTTP ${response.status} 响应不可解析` }
    }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 一条活跃上报事件的载荷（形状取自官方客户端的 `chat_request_send`）。
 *
 * ⚠️ 字段**一个都不能省**：服务端按整份结构做风控比对，缺字段的事件会被丢弃
 * （不报错），于是「上报成功但连登没亮」变成一条查不出来的静默失败。
 * ⚠️ `userId` 必填且必须是**凭据里的 user_id**，不是 token 里的 sub —— 两者
 * 在换了登录方式的账号上并不相等。
 */
export function reportEventOf(uid: string, nowMs: number = Date.now()): Record<string, unknown> {
  const conversationId = `wbintl-${randomUUID().replaceAll('-', '')}`
  return {
    eventCode: 'chat_request_send',
    timestamp: nowMs,
    reportDelay: 0,
    mode: 'craft',
    conversationId,
    requestId: conversationId,
    inputLength: 12,
    requestModelId: 'deepseek-v4.1-flash',
    requestModelName: 'DeepSeek V4.1 Flash',
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: '',
    mentionContextCount: 0,
    command: '',
    expertId: '',
    recommendId: '',
    skillId: '',
    skillCount: 0,
    totalCount: 0,
    fileUri: '',
    presentAt: nowMs,
    traceId: '',
    rootRequestId: conversationId,
    parentConversationId: conversationId,
    agentName: 'default',
    agentType: 'conversation',
    userId: uid,
  }
}

/**
 * 发一条活跃上报，并回读连登天数。
 *
 * 返回 `{ ok, note }`：`ok` 只表示**上报被接受**（回读失败不影响 `ok`，但会在
 * `note` 里如实说明）—— 与「签到成功 ≠ 活跃成功」的分开报告口径一致。
 */
export async function reportWorkBuddyIntlActivity(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ ok: boolean; note: string }> {
  const uid = usableUidOf(credential)
  if (uid === undefined) return { ok: false, note: '缺少账号 uid，跳过活跃上报' }
  // ⚠️ 没 token 就必然 401：本仓能力表原则是「未登记就不发请求」，而这里还会
  //    拼出 `Authorization: Bearer undefined` 真的打两发（对抗审计 P1-4）。
  if (typeof credential.access_token !== 'string' || credential.access_token.length === 0) {
    return { ok: false, note: '缺少账号 access_token，跳过活跃上报' }
  }

  const reported = await requestJson(`${product.endpoint}${WORKBUDDY_INTL_REPORT_PATH}`, {
    method: 'POST',
    headers: headersOf(credential, product),
    body: JSON.stringify([reportEventOf(uid)]),
  }, fetcher, timeoutMs)
  if (!reported.ok) return { ok: false, note: `活跃上报失败：${reported.message}` }
  if (reported.body.code !== 0) {
    return { ok: false, note: `活跃上报未确认（code=${String(reported.body.code)}）` }
  }

  const streak = await requestJson(`${product.endpoint}${WORKBUDDY_INTL_STREAK_PATH}`, {
    method: 'GET',
    headers: headersOf(credential, product),
  }, fetcher, timeoutMs)
  const days = streakDaysOf(streak)
  if (days !== undefined) return { ok: true, note: `活跃已上报（连登 ${String(days)} 天）` }
  return { ok: true, note: '活跃已上报（连登天数回读失败）' }
}

/** 从回读响应里取连登天数；取不到回 `undefined`（不回 0 —— 0 是「没连登」的语义）。 */
/** 导出仅为可直测：`NaN` 经 `JSON.parse` 无法表达，只能走纯函数入口。 */
export function streakDaysOf(result: JsonResult): number | undefined {
  if (!result.ok) return undefined
  const data = result.body.data
  if (typeof data !== 'object' || data === null) return undefined
  const streak = (data as Record<string, unknown>).streak
  if (typeof streak !== 'object' || streak === null) return undefined
  const days = (streak as Record<string, unknown>).days
  return typeof days === 'number' && Number.isFinite(days) ? days : undefined
}

/**
 * 在网页通道建一个带 prompt 的会话（「当日活跃」计数只认这一发）。
 *
 * 逐个免费模型尝试，**建成一个就停**：换个模型重试会把同一件事做两遍，
 * 而每建一个都是用户账号里的一个真实会话。
 *
 * 返回 `{ ok, note }`，`note` 里带最后一个模型失败的原因（便于排查是模型下线
 * 还是通道被拒）。
 */
export async function createWorkBuddyIntlWebSession(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ ok: boolean; note: string }> {
  const uid = usableUidOf(credential)
  if (uid === undefined) return { ok: false, note: '缺少账号 uid，跳过网页会话' }
  if (typeof credential.access_token !== 'string' || credential.access_token.length === 0) {
    return { ok: false, note: '缺少账号 access_token，跳过网页会话' }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    // 网页通道是**浏览器**发起的，带桌面端 UA 反而更像网关（渠道校验 11-128）。
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    Origin: product.endpoint,
    Referer: `${product.endpoint}/app`,
    'X-User-Id': uid,
  }

  let last = ''
  for (const model of WORKBUDDY_INTL_MODELS) {
    const result = await requestJson(
      `${product.endpoint}${WORKBUDDY_INTL_WEB_CONVERSATION_PATH}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: 'Hi',
          model,
          conversationOrigin: 'workbuddy-app',
          plugins: [{ name: 'weixinpay', marketplace: 'codebuddy-builtin' }],
        }),
      },
      fetcher,
      timeoutMs,
    )
    if (!result.ok) {
      last = `${model}: ${result.message}`
      continue
    }
    const data = result.body.data
    const id = typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>).id
      : undefined
    if (result.body.code === 0 && typeof id === 'string' && id.length > 0) {
      return { ok: true, note: '网页会话已创建' }
    }
    last = `${model}: code=${String(result.body.code)}`
  }
  return { ok: false, note: `网页会话未建成（${last.length > 0 ? last : '模型链为空'}）` }
}

/**
 * 签到收尾钩子：把「今天的活跃」补上（`ProviderCredits.afterClaimNote`）。
 *
 * ## 顺序与短路
 *
 * 1. **先看 `outcome`**（PR #87 对抗审计 P1-1/P1-2）：只有 `claimed` /
 *    `already-claimed` 才继续 —— 那是「今天确实有痕迹」的两种结局。
 *    `inactive`（`41000` 活动未开）与 `failed` **直接回 `undefined`**：
 *    - `inactive` 不计 `coversToday`（`auto-checkin.ts` 只认
 *      `claimed + alreadyClaimed`）⇒ 下个时段会重跑本钩子，若无条件发，
 *      中招日两个时段各发一次 ⇒ 用户账号里 **2 个 `Hi` 会话/天**；
 *    - `failed` 说明签到本身没成，此时发活跃上报既无意义也污染诊断。
 * 2. 上报活跃（2 个请求：上报 + 回读）；
 * 3. 网页会话（**仅当** `DSH_WORKBUDDY_INTL_WEB_SESSION` 打开）——
 *    上报成功已经点亮连登，但「当日活跃」计数不认 `/v2/report`，只有网页会话
 *    进这个计数；故只在显式打开时才补这一发。
 *
 * ## 失败也必须出话（对抗审计 P1-3）
 *
 * 原实现只 `push` 成功的 note，全失败回 `undefined` ⇒ 唯一的用户可见通道
 * （`jet-hub-rpc.ts` 把返回值追加到 `outcome.message`）空转，上游挂了也**零日志
 * 零提示**。现在失败也 push 一句可读原因（**不**把签到判成失败 —— 契约要求
 * 永不抛、永不影响签到结果）。
 */
export async function keepWorkBuddyIntlActivity(
  credential: BuddyCredential,
  product: BuddyProduct,
  outcome: ClaimOutcome,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  // ⚠️ 只有「今天确实有痕迹」的两种结局才发活跃（见上方长注释）。
  //    `inactive` 会被自动签到重试，`failed` 说明签到没成 —— 两种都不该有副作用。
  if (outcome.kind !== 'claimed' && outcome.kind !== 'already-claimed') return undefined

  // ⚠️ 总预算（P1-3）：下面的三发是串联的，且 `afterClaimNote` 在 RPC 层
  //    **没有 deadline**、账号串行 ⇒ 不封顶会线性叠加到宿主的 RPC 超时。
  //    每发前按剩余预算夹一次，用尽就停并如实出话（不静默）。
  const deadline = Date.now() + KEEP_TOTAL_BUDGET_MS
  // ⚠️ 这里**不再夹** `REQUEST_TIMEOUT_MS` —— 夹取只在 `requestJson` 内发生一次
  //    （本仓红线：同一判据只留一份实现）。两处都夹会让「删掉任一处」都全绿。
  const remaining = (): number => Math.max(1, deadline - Date.now())

  const reported = await reportWorkBuddyIntlActivity(credential, product, fetcher, remaining())
  const notes: string[] = []
  // ⚠️ 上报失败也**不**把整条判成失败：活动开着时积分早已由 `claim` 领到，
  //    活跃只是附加；把它写成「失败」会让一次成功签到看起来像出错。
  //    ⚠️ 但**必须出话**（对抗审计 P1-3）—— 否则上游挂了完全查不出来。
  notes.push(reported.note)

  if (webSessionEnabled()) {
    if (deadline - Date.now() <= 0) {
      notes.push('网页会话未执行（总预算已用尽）')
    } else {
      const session = await createWorkBuddyIntlWebSession(credential, product, fetcher, remaining())
      notes.push(session.note)
    }
  }

  return notes.length > 0 ? notes.join(' · ') : undefined
}
