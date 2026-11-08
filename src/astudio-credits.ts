/**
 * AStudio（讯飞 AstronStudio）**额度面**：`GET /xingchen-studio/points/balance`。
 *
 * ## 为什么单独一个文件
 *
 * 额度端点在**账号后端**（`agent.xfyun.cn/xingchen-studio`），与推理网关
 *（`maas-api.cn-huabei-1.xf-yun.com/v1`）**不同域、不同鉴权**：
 * 推理用 `Authorization: Bearer <modelBearerToken>`，额度只认 **Cookie 的
 * `ssoSessionId`**。⇒ 凭据里那一份 `access_token` 在这里**用不上**，
 * 本文件读的是 `sso_session_id`（缺失时如实报「未登录」，不发必然 80000 的请求）。
 *
 * ## ⚠️ 三条失败路径的用户动作**完全不同**（故必须用 `fetchBalanceDetailed`）
 *
 * 1. **会话失效**：HTTP 恒 **200** + `code=80000`「登录异常，请重新登录」⇒
 *    用户要做的是**去客户端人工重登**（唯一终态，实测无程序化续期接口，
 *    服务端 Set-Cookie 的 Max-Age=31536000 意味着一年内不会自然到期）。
 * 2. **服务不可用**：HTTP 4xx/5xx、非 JSON、其它 `flag=false` 业务码 ⇒
 *    可重试，**不得**报成「需重登」（那会让用户白重登一次）。
 * 3. **形状不认识**：`code=0` 但响应里没有 `totalBalance`（上游改了 Schema）⇒
 *    明说「未包含余额字段」。
 *
 * ⚠️ **绝不允许把「查不到」写成 0**（0 是「已用光」的语义，本仓库反复记录的
 * 缺陷形态；provider-credits.ts 文件头同样写着这条红线）。
 *
 * ## ⚠️ 为什么**不**按 HTTP 码判失效
 *
 * 实测该端点无论成功还是「未登录」都回 **200**（22 例消融），故判据只能是
 * `flag`/`code` 本体。这与上游 MAAS 的 `HTTP 502 + error.code` 是两套形态，
 * 不要复用 `classifyAstudioError` 那条推理侧的映射。
 */

import { ASTUDIO } from './astudio-product.js'
import type { AstudioProduct } from './astudio-product.js'
import {
  astudioCookieHeader,
  isAstudioSessionDeadError,
  parseAstudioEnvelope,
} from './astudio.js'
import type { AstudioCredential } from './astudio.js'
import type { ProviderBalanceDetail } from './provider-runtime.js'
import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'

/** 额度端点的相对路径（账号后端，接在 `product.authBaseUrl` 之后）。 */
const ASTUDIO_POINTS_BALANCE_PATH = '/points/balance'

/**
 * 积分单位：量纲是**整数积分**（不是元、不是 token）。
 *
 * ⚠️ 上游所有数字都是**积分点**（实测 totalAmount=1200 / totalBalance=1192），
 * 展示侧不得除 100、不得做浮点折算 —— 与 accio 同为 'credit'，与 zcode 的
 * 'token' **不同**（那是刻意指明的单位，见 provider-credits.ts 的 zcode 条目）。
 */
const ASTUDIO_CREDIT_UNIT = 'credit'

/**
 * 纯读的超时兜底。
 *
 * ⚠️ 不用 `product.requestTimeoutMs`（30s 是给推理首包的）：额度是面板上的
 * 逐账号串行读数（`collectCreditBalances` 注释明确「顺序查询，避免并发触发风控」），
 * 30s 会把整轮面板拖死。8s 足够（实测该端点为轻量 GET）。
 */
const ASTUDIO_CREDITS_TIMEOUT_MS = 8_000

/** 注入替身用（单测不碰真实凭据与网络）。 */
export interface AstudioCreditsOptions {
  fetcher?: typeof fetch
  product?: AstudioProduct
  timeoutMs?: number
}

/** 安全读整数：非有限数 / 非数字一律 `undefined`（**不回落 0**）。 */
function readAstudioInt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

/** 安全读「本地时间字符串」；空串与非字符串都算「没有」。 */
function readAstudioLocalTime(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 把 `*NextExpireTime` 的**不带时区本地时间串**折算成毫秒时间戳。
 *
 * ## 为什么先 `replace(' ', 'T')` 再 `Date.parse`（⚠️ 已按实测订正 2026-10-21）
 *
 * 实测上游下发的是 `"2026-11-20T01:50:14"`（无 `Z`、无 `+08:00`）。ES 规范对这种
 * **仅日期时间**形式（`date-time`，无偏移）的解析是「按**本地时区**解释」。
 * 而空格分隔的 `"2026-11-20 01:50:14"` **不在**规范保证的三种格式内
 *（ISO / `toString` / `toUTCString`）⇒ 属**实现自定义**，`Date.parse` **允许**
 * 返回 `NaN`（规范明确写了「鼓励但不要求」支持其它格式）。
 *
 * ⇒ 先 `replace(' ', 'T')` 把它收进**有保证**的形式，两条输入形态走同一条判据。
 *
 * ⚠️⚠️ **但必须如实说明：这行在当前 V8 上是「冗余」的**（2026-10-21 审计实测）。
 *    本机 Node 26 / V8 对空格形态**非常宽容**，甚至多空格也认：
 *    ```
 *    Date.parse('2026-11-20 01:50:14')  === Date.parse('2026-11-20T01:50:14')  // true
 *    Date.parse('2026-11-20  01:50:14') === 同上                              // true
 *    ```
 *    ⇒ 把它删掉，**本机全部 109 条相关用例仍然全绿** —— 这是**实测无牙**，
 *    已如实登记，**不为它编一条恒真的用例**（本仓库红线）。
 *    保留这行的理由是**规范保证**而非「当前引擎会坏」：换引擎（JSC / SpiderMonkey）
 *    或 V8 收紧解析时，空格形态会静默变 `NaN` ⇒ 该包**静默落永久桶** ⇒
 *    永久锁对它失效。这是一条**前向防御**，不是现存缺陷的修复。
 *
 *    ⇒ 守卫只能是「两形态给出**相同毫秒**」这个**契约**断言
 *    （`astudio-lock-wiring.spec.ts` 的「空格形态与 T 形态给出相同的毫秒」），
 *    它锁的是「两条形态必须等价」这件事，**不锁 `replace` 这一行本身**。
 *
 * ⚠️ **解析不出来就返回 `undefined`，绝不编造一个时刻**（本仓库红线）。
 *   上游若改成带偏移的 ISO（`...Z`），`Date.parse` 同样能认，无需改动。
 *
 * ## ⚠️⚠️ **未验证项（如实登记，2026-10-21 合并审计）**：服务端到底是哪个时区
 *
 * 上面「按本地时区解释」那条**只对了一半**：它决定了**我们**怎么解释这个串，
 * 但**没有**证明「本机时区 == 服务端时区」。而这两者不必然相同：
 *
 * - 实测样本 `"2026-11-20T01:50:14"` 是**在哪台机器、哪个时区**采的 ——
 *   `aggregate-expiry.ts` / `aggregate-adapter.ts` / `src/index.ts` 三处注释
 *   都只抄了这个串，**没有任何一处记录采集时的机器时区**；
 * - `tests/e2e/astudio-popups-probe.e2e.spec.ts` 只 `console.log` 原始报文，
 *   **不校验**时区，也没有拿官方客户端显示的到期日做对照。
 *
 * ⇒ 如果服务端固定按 **UTC+8** 下发本地时间，而用户机器在 UTC+0，那么这里
 *   算出的时刻会**整体偏移 8 小时**。后果是「临期 / 长期」的分档边界移动
 *   （15 天窗口的判据在整天粒度上仍然成立，但**倒计时显示**会差 8 小时）。
 *
 * **为什么现在不改**：没有任何一条实测证据能确定服务端时区。三种候选做法
 *（按本机 / 固定 +08:00 / 要求上游带偏移）**都是猜**，而本仓库红线是
 *「绝不编造」。故**保持既有行为（按本机时区）并把未验证如实登记在这里**，
 * 由后续真机取证决定（取证方式：同一账号同时看官方客户端面板显示的到期日
 * 与本函数算出的日期，且**在两台不同时区的机器上各做一次**）。
 *
 * ⚠️ 不要因为「看起来对」就把这条注释删掉 —— 它记录的是**证据强度**，
 *   不是实现细节。本仓库对「结构上可达、零实测」的项一律这样标注。
 */
function astudioLocalTimeMs(source: Record<string, unknown>, key: string): number | undefined {
  const raw = readAstudioLocalTime(source, key)
  if (raw.length === 0) return undefined
  const ms = Date.parse(raw.replace(' ', 'T'))
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/** 上游文案可能不在 `message` 而在 `desc` —— 由 parseAstudioEnvelope 归一，这里只兜底。 */
function failDetail(error: string): ProviderBalanceDetail {
  return { balance: null, error }
}

/**
 * 把 `points/balance` 的 data 映射成 `CreditBalance`。
 *
 * ## 口径（与客户端一致，用户可与官方面板逐数核对）
 *
 * - `total` = 上游**权威**字段 `totalBalance`（主池可用合计），**不是**逐包求和。
 *   实测 `totalBalance === activityBalance`（1192），而 `totalAmount - totalBalance = 8`
 *   正是已消耗 —— 用求和会在星火池在场时凭空多出 5000。
 * - `packages` 按**来源四分法**分桶（member / buy / activity，均为**主池**），
 *   星火池作为**最后一个**条目并如实标注「独立池，不参与主池合计」。
 *   ⚠️ 这是刻意与 zcode 的「`total` 必须等于逐包之和」**不同**的口径：本渠道
 *   服务端本身就给了两个互不相通的池，压成一个数才是撒谎。
 *   ⇒ 面板若按「逐包之和」显示总额会偏大；接线时若需要严格自洽，可以把星火条目
 *     移出 `packages` 并在 `extra` 里给短标签，但那需要扩 `RpcCreditsBalanceExtra`
 *     （现只有 `accountTier`），属接口扩张，**本轮不做**。
 * - `expiredTotal` = 0：上游**不下发**失效额度（无独立 frozen 字段、也不回已失效桶），
 *   如实为 0 并在此注明「不是估算出来的 0」。
 *
 * ⚠️ `spark*` 六项在官方 Schema 里是 **optional** ⇒ 老响应可能整个缺席，
 * 缺席时**不生成**该条目（生成一个 `remaining: 0` 的星火包会让用户以为星火没了）。
 */
export function buildAstudioBalance(data: Record<string, unknown>): CreditBalance | null {
  const total = readAstudioInt(data, 'totalBalance')
  if (total === undefined) return null // 形状不认识 ⇒ 调用侧报「未包含余额字段」，不编造 0
  const totalAmount = readAstudioInt(data, 'totalAmount')

  const packages: CreditPackage[] = []
  const used = totalAmount !== undefined ? Math.max(0, totalAmount - total) : 0

  const pushPool = (
    name: string,
    totalKey: string,
    balanceKey: string,
    expireKey: string,
  ): void => {
    const remaining = readAstudioInt(data, balanceKey)
    if (remaining === undefined) return // 该池不下发 ⇒ 不臆造条目
    const poolTotal = readAstudioInt(data, totalKey) ?? remaining
    const expiredTime = readAstudioLocalTime(data, expireKey)
    // ⚠️ `expiredTime` 是**字符串**，而客户端的 `splitCreditsByExpiry` 只认
    //    `deductionEndTime`（毫秒数）—— 缺它就会把整个池算成「永久积分」。
    //    两者都给：`expiredTime` 供 tooltip 原样显示，`deductionEndTime` 供分档。
    const deductionEndTime = astudioLocalTimeMs(data, expireKey)
    packages.push({
      name,
      unit: ASTUDIO_CREDIT_UNIT,
      remaining,
      total: poolTotal,
      used: Math.max(0, poolTotal - remaining),
      active: remaining > 0,
      // 上游不给周期概念（额度按来源发放、按活动到期），起止留空而不是编造。
      cycleStartTime: '',
      cycleEndTime: '',
      // ⚠️ `*NextExpireTime` **不在官方 Schema 内**（Effect.Struct 会裁未知字段），
      // 且是**不带时区的本地时间串** ⇒ `expiredTime` 原样透出（展示用），
      // 数学比较统一走 `deductionEndTime`（上面的归一化值）。
      expiredTime,
      ...(deductionEndTime === undefined ? {} : { deductionEndTime }),
    })
  }

  pushPool('会员积分', 'memberTotal', 'memberBalance', 'memberNextExpireTime')
  pushPool('购买积分', 'buyTotal', 'buyBalance', 'buyNextExpireTime')
  pushPool('赠送积分', 'activityTotal', 'activityBalance', 'activityNextExpireTime')

  const sparkBalance = readAstudioInt(data, 'sparkTotalBalance')
  if (sparkBalance !== undefined) {
    const sparkTotal = readAstudioInt(data, 'sparkTotalAmount') ?? sparkBalance
    const sparkDeductionEndTime = astudioLocalTimeMs(data, 'sparkNextExpireTime')
    packages.push({
      name: '星火积分（独立池，不参与主池合计）',
      unit: ASTUDIO_CREDIT_UNIT,
      remaining: sparkBalance,
      total: sparkTotal,
      used: Math.max(0, sparkTotal - sparkBalance),
      active: sparkBalance > 0,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: readAstudioLocalTime(data, 'sparkNextExpireTime'),
      ...(sparkDeductionEndTime === undefined ? {} : { deductionEndTime: sparkDeductionEndTime }),
    })
  }

  // 上游只给了合计、一个池都没下发时补一个条目，否则面板拿到空列表连总额都不显示
  //（与 accio / raccoon 同取舍）。
  if (packages.length === 0) {
    packages.push({
      name: '可用积分',
      unit: ASTUDIO_CREDIT_UNIT,
      remaining: total,
      total: totalAmount ?? total,
      used,
      active: total > 0,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
    })
  }

  return { total, packages, expiredTotal: 0 }
}

/**
 * 查一次 AStudio 积分余额（**带原因**）。
 *
 * 判据阶梯（顺序**不可**调换，理由逐条）：
 * ① 本地就能判定的「没有会话 Cookie」⇒ 直接报未登录，**不发**一个必然 80000 的请求；
 * ② 传输层失败 / 非 2xx / 非 JSON ⇒ 「额度服务不可用（可重试）」；
 * ③ `flag=false`（HTTP 仍是 200）⇒ 用 `isAstudioSessionDeadError(code, 文案)` 分流
 *    「需人工重新登录」与「可重试」；
 * ④ `code=0` 但没有 `totalBalance` ⇒ 「响应未包含余额字段」。
 *
 * ⚠️ ③ 的终态判据**只此一份**（复用 `astudio.ts` 的 `isAstudioSessionDeadError`），
 * 本文件**不再抄一份业务码集合** —— 同一语义两套判据是本仓库的红线。
 * 该判据依赖 `src/astudio-product.ts` 的 `ASTUDIO_SESSION_DEAD_CODES` **含 80000**
 *（本轮实测已在盘：`new Set([1002, 1005, 80000])`）；否则「需重登」会退化成
 * 只靠服务端中文文案正则兜底、每轮白撞一次的可重试。
 */
export async function fetchAstudioBalanceDetailed(
  credential: AstudioCredential,
  options: AstudioCreditsOptions = {},
): Promise<ProviderBalanceDetail> {
  const fetcher = options.fetcher ?? fetch
  const product = options.product ?? ASTUDIO
  const timeoutMs = options.timeoutMs ?? ASTUDIO_CREDITS_TIMEOUT_MS

  const baseUrl = (product.authBaseUrl ?? '').replace(/\/+$/, '')
  if (baseUrl.length === 0) return failDetail('额度服务不可用（未配置账号后端地址）')

  // ⚠️⚠️ **先判凭据本身**（2026-10-20 用户报障）：账号条目在、但凭据读不到时
  //    `credential` 会是 `undefined`（调用方用 `as AstudioCredential` 硬转，运行时不拦）
  //    ⇒ `astudioCookieHeader(undefined)` **解引用崩**，而 TypeError 的消息
  //    （`Cannot read properties of undefined (reading '…')`）会被上层当成
  //    **余额文案**原样展示给用户（图 2 实测症状：积分行显示 `Cannot read properties of unde…`）。
  //    ⇒ 这里必须归成**可读失败**。判据放在本函数入口（一处）而不是各调用点 ——
  //    调用点只知道「要查余额」，不知道凭据该长什么样。
  const raw = credential as AstudioCredential | null | undefined
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return failDetail('未登录 AStudio（账号凭据缺失或读不到），请删除该账号后重新登录')
  }

  // ① 额度面只认 Cookie 的 ssoSessionId；没有它就没有任何可发的请求。
  const cookie = astudioCookieHeader(credential)
  if (cookie.length === 0) {
    return failDetail('未登录 AStudio（缺少登录会话 Cookie），请在 AStudio 客户端重新登录')
  }

  let response: Response
  let text: string
  try {
    response = await fetcher(`${baseUrl}${ASTUDIO_POINTS_BALANCE_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Cookie: cookie },
      signal: AbortSignal.timeout(timeoutMs),
    })
    text = await response.text()
  } catch (error) {
    return failDetail(`额度服务不可用（网络异常）：${error instanceof Error ? error.message : String(error)}`)
  }

  // ② 实测正常与「未登录」都回 200；非 2xx 只可能是网关/服务端故障 ⇒ 可重试，
  //    **不得**报成需重登。
  if (!response.ok) {
    return failDetail(`额度服务不可用（HTTP ${String(response.status)}）`)
  }

  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    return failDetail('额度服务不可用（响应不是 JSON）')
  }

  const envelope = parseAstudioEnvelope(body)
  if (!envelope.ok) {
    // ③ 终态 vs 可重试 —— 全部走那**一份**判据。
    if (isAstudioSessionDeadError(envelope.code, envelope.message)) {
      return failDetail('AStudio 登录会话已失效，需在 AStudio 客户端人工重新登录（微信扫码）')
    }
    return failDetail(`积分查询失败：${envelope.message}`)
  }

  const balance = buildAstudioBalance(envelope.data)
  if (balance === null) {
    // ④ 查询「成功」但形状不认识 ⇒ 仍然不编造 0。
    return failDetail('积分查询失败：响应未包含余额字段')
  }
  return { balance }
}

/**
 * 供 `BuddyBalanceSelector` 用的 `fetchBalance`（**丢失原因**的薄封装）。
 *
 * ## 为什么需要它
 *
 * `BuddyBalanceSelector` 的 `deps.fetchBalance` 契约是
 * `(credential, product) => Promise<CreditBalance | null>` —— 只回余额、不回原因
 * （分档逻辑对「为什么查不到」不感兴趣，一律归入最后一档）。
 * 而本文件的权威入口 {@link fetchAstudioBalanceDetailed} 回的是
 * `{ balance, error? }`，故这里把它**压平成 null**。
 *
 * ⚠️ **失败原因不要在这里丢掉就完事**：`fetchAstudioBalanceDetailed` 的三条失败
 * 路径（会话失效 / 服务不可用 / 形状不认识）对用户动作完全不同。选号器这条路上
 * 确实只需要 null（它会把该号归入「查不到」档，其他号继续用）；但面板上
 * 直接展示余额时走的仍是 `fetchAstudioBalanceDetailed`，原因在那里保留。
 *
 * ⚠️ **不要在本函数里再写一份失败分类**：那是 `fetchAstudioBalanceDetailed` 的职责，
 * 两处各写一遍必然漂移（本仓库红线）。
 */
export async function fetchAstudioCreditBalance(
  credential: AstudioCredential,
  product?: AstudioProduct,
): Promise<CreditBalance | null> {
  const result = await fetchAstudioBalanceDetailed(
    credential,
    product === undefined ? {} : { product },
  )
  return result.balance
}

// ── 每日奖励 / 签到能力 ──

/** 待处理弹窗查询端点（每日奖励等）。 */
export const ASTUDIO_CLIENT_POPUPS_PENDING_PATH = '/client-popups/pending'
/** 弹窗完成/领取端点。 */
export const ASTUDIO_CLIENT_POPUPS_COMPLETE_PATH = '/client-popups/complete'
/** 每日奖励弹窗类型标识。 */
export const ASTUDIO_POPUP_TYPE_DAILY_REWARD = 'DAILY_REWARD_DIALOG'
/** 新用户礼包弹窗类型标识。 */
export const ASTUDIO_POPUP_TYPE_NEW_USER = 'NEW_USER_DIALOG'

/** 可领取的福利弹窗类型列表。 */
export const ASTUDIO_CLAIMABLE_POPUP_TYPES = [
  ASTUDIO_POPUP_TYPE_DAILY_REWARD,
  ASTUDIO_POPUP_TYPE_NEW_USER,
] as const

/**
 * 取弹窗的**类型**标识（`ASTUDIO_CLAIMABLE_POPUP_TYPES` 的判据入口）。
 *
 * ## ⚠️⚠️ 真实字段是 `componentType`，**不是** `type`（2026-10-20 真机取证）
 *
 * 实测响应（`tests/e2e/astudio-popups-probe.e2e.spec.ts` 只读探针）：
 * ```
 * data: [{ popupId: 3, popupCode: 'DAILY_LOGIN_REWARD_V1', popupType: 'BANNER',
 *          componentType: 'DAILY_REWARD_DIALOG', priority: 100, instanceKey: '…',
 *          payload: { confirmText, title, content } }]
 * ```
 * 客户端自己也读 `componentType`（asar 证据：`Mc[popup.componentType]` 用于排序）。
 *
 * ⇒ 原实现读 `record.type`，而**响应里没有这个键** ⇒ `String(record.type ?? '')`
 *    恒为 `''` ⇒ **一个可领弹窗都识别不出来** ⇒ 直接走 `already-claimed`
 *    ⇒ 界面显示「今天已领取」而**积分一动不动**（用户 2026-10-20 报障的根因：
 *    客户端里明明写着「限时每日福利 · 今日可领 100 积分」，插件却说已领过）。
 *
 * ⚠️ 仍**兼容** `type`（防御上游换字段名或存在第二种形态），但**优先** `componentType`。
 * ⚠️ 只此一份实现：三个调用点（`extractAstudioClaimablePopups` 的两个分支 +
 *    `astudioClaimablePopups`）原先各写一遍 `record.type`，抄三遍就是三处一起错。
 */
function astudioPopupTypeOf(record: Record<string, unknown>): string {
  return String(record.componentType ?? record.type ?? '')
}

/** 领取弹窗数据结构（每日奖励或新用户礼包）。 */
export interface AstudioClaimablePopup {
  popupId: number
  instanceKey: string
  type: string
  payload?: {
    points?: string | number
    [key: string]: unknown
  }
}

/** 每日签到弹窗数据结构（兼容别名）。 */
export type AstudioDailyRewardPopup = AstudioClaimablePopup

function extractRecordPayload(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof record.payload === 'object' && record.payload !== null) {
    return record.payload as Record<string, unknown>
  }
  if (typeof record.content === 'object' && record.content !== null) {
    return record.content as Record<string, unknown>
  }
  if (typeof record.content === 'string') {
    try {
      const parsed = JSON.parse(record.content)
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 忽略非 JSON
    }
  }
  return undefined
}

/**
 * 解析弹窗或完成响应中的积分数值。
 * 支持字符串数字 "10"、数值 10 等形式。
 */
export function parseAstudioPopupPoints(payload: unknown): number {
  if (typeof payload === 'number' && Number.isFinite(payload) && payload >= 0) {
    return Math.floor(payload)
  }
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        const pts = parseAstudioPopupPoints(parsed)
        if (pts > 0) return pts
      } catch {
        // 回退
      }
    }
    const parsed = parseInt(trimmed, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  }
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    if ('points' in record) {
      return parseAstudioPopupPoints(record.points)
    }
    if ('credit' in record) {
      return parseAstudioPopupPoints(record.credit)
    }
    if ('rewardPoints' in record) {
      return parseAstudioPopupPoints(record.rewardPoints)
    }
    if ('reward_points' in record) {
      return parseAstudioPopupPoints(record.reward_points)
    }
  }
  return 0
}

/**
 * 解析待领取每日签到弹窗列表中的目标项。
 */
export function extractAstudioDailyRewardPopup(data: unknown): AstudioDailyRewardPopup | undefined {
  if (!Array.isArray(data)) return undefined
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (astudioPopupTypeOf(record) === ASTUDIO_POPUP_TYPE_DAILY_REWARD) {
      const rawId = record.popupId
      const popupId = typeof rawId === 'number' ? rawId : parseInt(String(rawId), 10)
      if (Number.isFinite(popupId)) {
        return {
          popupId,
          instanceKey: typeof record.instanceKey === 'string' ? record.instanceKey : '',
          type: ASTUDIO_POPUP_TYPE_DAILY_REWARD,
          payload: extractRecordPayload(record),
        }
      }
    }
  }
  return undefined
}

/**
 * 解析待领取新用户礼包弹窗（NEW_USER_DIALOG）。
 */
export function extractAstudioNewUserPopup(data: unknown): AstudioClaimablePopup | undefined {
  if (!Array.isArray(data)) return undefined
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (astudioPopupTypeOf(record) === ASTUDIO_POPUP_TYPE_NEW_USER) {
      const rawId = record.popupId
      const popupId = typeof rawId === 'number' ? rawId : parseInt(String(rawId), 10)
      if (Number.isFinite(popupId)) {
        return {
          popupId,
          instanceKey: typeof record.instanceKey === 'string' ? record.instanceKey : '',
          type: ASTUDIO_POPUP_TYPE_NEW_USER,
          payload: extractRecordPayload(record),
        }
      }
    }
  }
  return undefined
}

/**
 * 提取所有可领取的福利弹窗（包含每日签到与新用户礼包）。
 */
export function extractAstudioClaimablePopups(data: unknown): AstudioClaimablePopup[] {
  if (!Array.isArray(data)) return []
  const result: AstudioClaimablePopup[] = []
  const seenIds = new Set<number>()
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const type = astudioPopupTypeOf(record)
    if (type === ASTUDIO_POPUP_TYPE_DAILY_REWARD || type === ASTUDIO_POPUP_TYPE_NEW_USER) {
      const rawId = record.popupId
      const popupId = typeof rawId === 'number' ? rawId : parseInt(String(rawId), 10)
      if (Number.isFinite(popupId) && !seenIds.has(popupId)) {
        seenIds.add(popupId)
        result.push({
          popupId,
          instanceKey: typeof record.instanceKey === 'string' ? record.instanceKey : '',
          type,
          payload: extractRecordPayload(record),
        })
      }
    }
  }
  return result
}

/**
 * 执行 AStudio 每日签到领取（claimDaily）。
 *
 * 对接：
 * 1. GET /client-popups/pending 查询待领取的 DAILY_REWARD_DIALOG 弹窗；
 *    若无弹窗或无 DAILY_REWARD_DIALOG，返回 already-claimed；
 * 2. POST /client-popups/complete 提交 popupId 与 instanceKey 领取积分；
 * 3. 终态鉴权失败（code 80000）返回 failed 并提示人工重登。
 */
export async function claimAstudioDailyReward(
  credential: AstudioCredential,
  options: AstudioCreditsOptions = {},
): Promise<ClaimOutcome> {
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? ASTUDIO_CREDITS_TIMEOUT_MS
  const product = options.product ?? ASTUDIO
  const baseUrl = (product.authBaseUrl ?? '').replace(/\/+$/, '')

  const cookie = astudioCookieHeader(credential)
  if (cookie.length === 0) {
    return {
      kind: 'failed',
      code: 80000,
      message: '未登录 AStudio（缺少登录会话 Cookie），请在 AStudio 客户端重新登录',
    }
  }

  // ① 查询 pending 弹窗
  let pendingResponse: Response
  let pendingText: string
  try {
    pendingResponse = await fetcher(`${baseUrl}${ASTUDIO_CLIENT_POPUPS_PENDING_PATH}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: cookie,
        clientType: product.clientType,
        studioVersion: product.studioVersion,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    pendingText = await pendingResponse.text()
  } catch (error) {
    return {
      kind: 'failed',
      code: -1,
      message: `每日签到查询失败（网络异常）：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (!pendingResponse.ok) {
    return {
      kind: 'failed',
      code: pendingResponse.status,
      message: `每日签到查询失败（HTTP ${pendingResponse.status}）`,
    }
  }

  let pendingBody: unknown
  try {
    pendingBody = JSON.parse(pendingText) as unknown
  } catch {
    return {
      kind: 'failed',
      code: -1,
      message: '每日签到查询失败（响应不是 JSON）',
    }
  }

  const pendingRecord = (typeof pendingBody === 'object' && pendingBody !== null ? pendingBody : {}) as Record<string, unknown>
  const pendingCode = typeof pendingRecord.code === 'number' ? pendingRecord.code : parseInt(String(pendingRecord.code ?? ''), 10)
  const pendingMsg = typeof pendingRecord.message === 'string' ? pendingRecord.message : String(pendingRecord.desc ?? '')

  if (pendingCode === 80000 || isAstudioSessionDeadError(pendingCode, pendingMsg)) {
    return {
      kind: 'failed',
      code: 80000,
      message: 'AStudio 登录会话已失效，需在 AStudio 客户端人工重新登录（微信扫码）',
    }
  }

  if (Number.isFinite(pendingCode) && pendingCode !== 0) {
    return {
      kind: 'failed',
      code: pendingCode,
      message: `每日签到查询失败：${pendingMsg || `code=${pendingCode}`}`,
    }
  }

  // 若 pending 为空数组或无可领取的弹窗，即为今日已领取（实测已领取时返回 code=0 data=[]）
  const popups = extractAstudioClaimablePopups(pendingRecord.data)
  if (popups.length === 0) {
    return {
      kind: 'already-claimed',
      message: '今天已领取每日签到奖励及福利礼包',
    }
  }

  // ② 依次调用 complete 完成领取（支持每日签到与新用户礼包）
  let totalCredit = 0
  for (const popup of popups) {
    let completeResponse: Response
    let completeText: string
    try {
      completeResponse = await fetcher(`${baseUrl}${ASTUDIO_CLIENT_POPUPS_COMPLETE_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Cookie: cookie,
          clientType: product.clientType,
          studioVersion: product.studioVersion,
        },
        body: JSON.stringify({
          popupId: popup.popupId,
          instanceKey: popup.instanceKey,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      completeText = await completeResponse.text()
    } catch (error) {
      return {
        kind: 'failed',
        code: -1,
        message: `领取每日签到及福利礼包失败（网络异常）：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    if (!completeResponse.ok) {
      return {
        kind: 'failed',
        code: completeResponse.status,
        message: `领取每日签到及福利礼包失败（HTTP ${completeResponse.status}）`,
      }
    }

    let completeBody: unknown
    try {
      completeBody = JSON.parse(completeText) as unknown
    } catch {
      return {
        kind: 'failed',
        code: -1,
        message: '领取每日签到及福利礼包失败（响应不是 JSON）',
      }
    }

    const completeRecord = (typeof completeBody === 'object' && completeBody !== null ? completeBody : {}) as Record<string, unknown>
    const completeCode = typeof completeRecord.code === 'number' ? completeRecord.code : parseInt(String(completeRecord.code ?? ''), 10)
    const completeMsg = typeof completeRecord.message === 'string' ? completeRecord.message : String(completeRecord.desc ?? '')

    if (completeCode === 80000 || isAstudioSessionDeadError(completeCode, completeMsg)) {
      return {
        kind: 'failed',
        code: 80000,
        message: 'AStudio 登录会话已失效，需在 AStudio 客户端人工重新登录（微信扫码）',
      }
    }

    if (Number.isFinite(completeCode) && completeCode !== 0) {
      return {
        kind: 'failed',
        code: completeCode,
        message: `领取每日签到及福利礼包失败：${completeMsg || `code=${completeCode}`}`,
      }
    }

    // 解析领取到的积分值，优先 complete 响应，若无则取弹窗 payload
    const creditFromComplete = parseAstudioPopupPoints(completeRecord.data)
    const creditFromPayload = parseAstudioPopupPoints(popup.payload)
    const credit = creditFromComplete > 0 ? creditFromComplete : creditFromPayload
    totalCredit += credit
  }

  return {
    kind: 'claimed',
    credit: totalCredit,
    streakDays: 1,
    isStreakDay: false,
    unit: 'credit',
  }
}

/**
 * 单独领取新用户礼包（NEW_USER_DIALOG）。
 */
export async function claimAstudioNewUserGift(
  credential: AstudioCredential,
  options: AstudioCreditsOptions = {},
): Promise<ClaimOutcome> {
  const fetcher = options.fetcher ?? fetch
  const product = options.product ?? ASTUDIO
  const timeoutMs = options.timeoutMs ?? ASTUDIO_CREDITS_TIMEOUT_MS

  const baseUrl = (product.authBaseUrl ?? '').replace(/\/+$/, '')
  if (baseUrl.length === 0) {
    return { kind: 'failed', code: -1, message: '额度服务不可用（未配置账号后端地址）' }
  }

  const ssoSessionId = typeof credential.sso_session_id === 'string' ? credential.sso_session_id.trim() : ''
  if (!ssoSessionId) {
    return { kind: 'failed', code: 401, message: '缺少 sso_session_id，无法领取新用户礼包' }
  }

  const accountId = credential.account_id || credential.uid || ''
  const token = credential.token || ssoSessionId
  const cookie = `ssoSessionId=${ssoSessionId}; sso_sessionid=${ssoSessionId}; account_id=${accountId}; token=${token}`

  let pendingResponse: Response
  let pendingText: string
  try {
    pendingResponse = await fetcher(`${baseUrl}${ASTUDIO_CLIENT_POPUPS_PENDING_PATH}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: cookie,
        clientType: product.clientType,
        studioVersion: product.studioVersion,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    pendingText = await pendingResponse.text()
  } catch (error) {
    return {
      kind: 'failed',
      code: -1,
      message: `查询新用户礼包失败（网络异常）：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (!pendingResponse.ok) {
    return {
      kind: 'failed',
      code: pendingResponse.status,
      message: `查询新用户礼包失败（HTTP ${pendingResponse.status}）`,
    }
  }

  let pendingBody: unknown
  try {
    pendingBody = JSON.parse(pendingText) as unknown
  } catch {
    return { kind: 'failed', code: -1, message: '查询新用户礼包失败（响应不是 JSON）' }
  }

  const pendingRecord = (typeof pendingBody === 'object' && pendingBody !== null ? pendingBody : {}) as Record<string, unknown>
  const pendingCode = typeof pendingRecord.code === 'number' ? pendingRecord.code : parseInt(String(pendingRecord.code ?? ''), 10)
  const pendingMsg = typeof pendingRecord.message === 'string' ? pendingRecord.message : String(pendingRecord.desc ?? '')

  if (pendingCode === 80000 || isAstudioSessionDeadError(pendingCode, pendingMsg)) {
    return {
      kind: 'failed',
      code: 80000,
      message: 'AStudio 登录会话已失效，需在 AStudio 客户端人工重新登录（微信扫码）',
    }
  }

  if (Number.isFinite(pendingCode) && pendingCode !== 0) {
    return {
      kind: 'failed',
      code: pendingCode,
      message: `新用户礼包查询失败：${pendingMsg || `code=${pendingCode}`}`,
    }
  }

  const popup = extractAstudioNewUserPopup(pendingRecord.data)
  if (popup === undefined) {
    return {
      kind: 'already-claimed',
      message: '无待领取的新用户礼包或已领取',
    }
  }

  let completeResponse: Response
  let completeText: string
  try {
    completeResponse = await fetcher(`${baseUrl}${ASTUDIO_CLIENT_POPUPS_COMPLETE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: cookie,
        clientType: product.clientType,
        studioVersion: product.studioVersion,
      },
      body: JSON.stringify({
        popupId: popup.popupId,
        instanceKey: popup.instanceKey,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    completeText = await completeResponse.text()
  } catch (error) {
    return {
      kind: 'failed',
      code: -1,
      message: `领取新用户礼包失败（网络异常）：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (!completeResponse.ok) {
    return {
      kind: 'failed',
      code: completeResponse.status,
      message: `领取新用户礼包失败（HTTP ${completeResponse.status}）`,
    }
  }

  let completeBody: unknown
  try {
    completeBody = JSON.parse(completeText) as unknown
  } catch {
    return { kind: 'failed', code: -1, message: '领取新用户礼包失败（响应不是 JSON）' }
  }

  const completeRecord = (typeof completeBody === 'object' && completeBody !== null ? completeBody : {}) as Record<string, unknown>
  const completeCode = typeof completeRecord.code === 'number' ? completeRecord.code : parseInt(String(completeRecord.code ?? ''), 10)
  const completeMsg = typeof completeRecord.message === 'string' ? completeRecord.message : String(completeRecord.desc ?? '')

  if (completeCode === 80000 || isAstudioSessionDeadError(completeCode, completeMsg)) {
    return {
      kind: 'failed',
      code: 80000,
      message: 'AStudio 登录会话已失效，需在 AStudio 客户端人工重新登录（微信扫码）',
    }
  }

  if (Number.isFinite(completeCode) && completeCode !== 0) {
    return {
      kind: 'failed',
      code: completeCode,
      message: `领取新用户礼包失败：${completeMsg || `code=${completeCode}`}`,
    }
  }

  const creditFromComplete = parseAstudioPopupPoints(completeRecord.data)
  const creditFromPayload = parseAstudioPopupPoints(popup.payload)
  const credit = creditFromComplete > 0 ? creditFromComplete : creditFromPayload

  return {
    kind: 'claimed',
    credit,
    streakDays: 1,
    isStreakDay: false,
    unit: 'credit',
  }
}

/** 规范签到别名（对齐 claimDaily 规范）。 */
export const claimDaily = claimAstudioDailyReward
