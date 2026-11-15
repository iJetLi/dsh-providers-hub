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
 * `docs/workbuddy-intl-checkin.md`，移植自社区实现 L0NE-6/WorkBuddy-Daily
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
 * 单次请求超时（毫秒）。
 *
 * ⚠️ 比签到端点（30s）短：本链路是**签到之后的附加动作**，用户在面板上等的是
 * 签到结果，不该被三发附加请求拖成「转圈 90 秒」。
 */
const REQUEST_TIMEOUT_MS = 20_000

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
 * 打开后若活动已开放且 `/daily-checkin` 已领到积分，本发不会执行（见
 * {@link keepWorkBuddyIntlActivity} 的短路条件）。
 */
function webSessionEnabled(): boolean {
  return process.env.DSH_WORKBUDDY_INTL_WEB_SESSION === '1'
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
  if (credential.user_id !== undefined && credential.user_id.length > 0) {
    headers['X-User-Id'] = credential.user_id
  }
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
): Promise<JsonResult> {
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
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
): Promise<{ ok: boolean; note: string }> {
  const uid = credential.user_id ?? ''
  if (uid.length === 0) return { ok: false, note: '缺少账号 uid，跳过活跃上报' }

  const reported = await requestJson(`${product.endpoint}${WORKBUDDY_INTL_REPORT_PATH}`, {
    method: 'POST',
    headers: headersOf(credential, product),
    body: JSON.stringify([reportEventOf(uid)]),
  }, fetcher)
  if (!reported.ok) return { ok: false, note: `活跃上报失败：${reported.message}` }
  if (reported.body.code !== 0) {
    return { ok: false, note: `活跃上报未确认（code=${String(reported.body.code)}）` }
  }

  const streak = await requestJson(`${product.endpoint}${WORKBUDDY_INTL_STREAK_PATH}`, {
    method: 'GET',
    headers: headersOf(credential, product),
  }, fetcher)
  const days = streakDaysOf(streak)
  if (days !== undefined) return { ok: true, note: `活跃已上报（连登 ${String(days)} 天）` }
  return { ok: true, note: '活跃已上报（连登天数回读失败）' }
}

/** 从回读响应里取连登天数；取不到回 `undefined`（不回 0 —— 0 是「没连登」的语义）。 */
function streakDaysOf(result: JsonResult): number | undefined {
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
): Promise<{ ok: boolean; note: string }> {
  const uid = credential.user_id ?? ''
  if (uid.length === 0) return { ok: false, note: '缺少账号 uid，跳过网页会话' }

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
 * 1. 上报活跃（必做，2 个请求：上报 + 回读）；
 * 2. 网页会话（**仅当** `DSH_WORKBUDDY_INTL_WEB_SESSION=1`）——
 *    上报成功已经点亮连登，但「当日活跃」计数不认 `/v2/report`，只有网页会话
 *    进这个计数；故只在显式打开时才补这一发。
 *
 * 两件都没成时回 `undefined`（无事可报，别往签到结果里塞噪声）。
 */
export async function keepWorkBuddyIntlActivity(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const reported = await reportWorkBuddyIntlActivity(credential, product, fetcher)
  const notes: string[] = []
  // ⚠️ 上报失败也**不**把整条判成失败：活动开着时积分早已由 `claim` 领到，
  //    活跃只是附加；把它写成「失败」会让一次成功签到看起来像出错。
  if (reported.ok) notes.push(reported.note)

  if (webSessionEnabled()) {
    const session = await createWorkBuddyIntlWebSession(credential, product, fetcher)
    if (session.ok) notes.push(session.note)
  }

  return notes.length > 0 ? notes.join(' · ') : undefined
}
