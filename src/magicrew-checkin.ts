/**
 * Magicrew（超级麦吉 / MagiCrew）的**每日签到**与**新人奖励**协议实现。
 *
 * ## 两套机制，别混（`credits` 域 vs `onboarding` 域）
 *
 * | 机制 | 端点 | 频率 | 归属域 |
 * |---|---|---|---|
 * | 每日登录积分（= 真正的「每日签到」） | `POST /api/v1/login-gift` | 每天一次 | `credits.claim` |
 * | 新手引导任务（=「新人奖励」） | `GET /api/v1/onboarding/tasks` + `PUT …/<code>/completion` | **每号一辈子一次** | `onboarding` |
 *
 * ⚠️ 别拿「今天领过没」的判据去判「领过没」—— 那正是本仓库记录过的
 * 「一份语义两套判据」形态（见 `src/provider-onboarding.ts` 文件头的域边界表）。
 *
 * ## ① 每日登录积分（实测报文）
 *
 * ```json
 * POST /api/v1/login-gift          （**请求体存在且为空串** —— 见下方 ⚠️）
 * → {"code":1000,"data":{"granted":true,"point_amount":50,
 *                        "expire_type":1,"message":"成功领取每日登录积分"}}
 * ```
 *
 * 关键性质（两站都验过）：
 * - **幂等**：当天已领 → `granted:false, point_amount:0`「今日已领取登录积分」，
 *   **HTTP 仍是 200，不是错误** ⇒ 可以每天无脑调用。
 * - **两站同构**：路径、方法、返回结构完全一样，只有金额不同
 *   （国内 **+200/天**、国际 **+50/天**）。
 * - 抓包来源：2026-10-27 真实网页登录（`magicrew.ai` 的 `/login-gift`）。
 *
 * ## ② 新手引导任务（实测报文）
 *
 * ```json
 * GET /api/v1/onboarding/tasks
 * → {"code":1000,"data":{"participant_type":null,"tasks":[
 *      {"code":"…","title":"…","points":50,"status":"COMPLETED",
 *       "reward_status":"GRANTED","completed_at":"…"}]}}
 *
 * PUT /api/v1/onboarding/tasks/<code>/completion      （body `{}`）
 * → {"code":1000,"data":{"points":50}}
 * ```
 *
 * 国内站 8 项，其中 7 项 PUT 即完成（总分以 `tasks[].points` 现场累加，不写死）。
 *
 * ### ⚠️⚠️ 两条会让人报假账的坑
 *
 * 1. **`first_ai_work` 不支持手动完成** —— 服务端回 **`9303`**「该新人引导任务
 *    不支持手动完成」。它必须真发一条消息才置位（走话题 Socket.IO）。
 *    ⇒ 本实现**不发请求、直接归 `manualRequired`**（**不是** `skipped` ——
 *    那个字段的契约是「此前已完成」，而它既没完成也没领到分；
 *    见 `src/types.ts` 的 `RpcOnboardingClaimResponse`），否则既拿不到分
 *    又会把它写成「已完成」= 报假账。
 * 2. **国际站 `tasks` 恒为空数组** —— `{participant_type: null, tasks: []}` 是
 *    「该账号没被登记进引导计划」，**不是**「已经领完了」。
 *    ⇒ 0 项时如实报「无任务可领」，**不得**报「新手福利 0 项已全部完成」
 *      （magpie 0.3.7 犯过这个错，会把「什么都没做」写成成功）。
 *
 * ## ⚠️ 本文件不引 `node:*`，也不构造 `AbortSignal` 之外的全局副作用
 *
 * 与 `magicrew-product.ts` 同因：它可能被客户端产物（esbuild）间接引用。
 */

import {
  MAGICREW,
  MAGICREW_LOGIN_GIFT_PATH,
  MAGICREW_ONBOARDING_TASKS_PATH,
  type MagicrewProduct,
} from './magicrew-product.js'
import { magicrewApiHeaders } from './magicrew-credits.js'
import { DECIMAL_LITERAL_RE, magicrewDecimalOf } from './magicrew-number.js'
import type { ClaimOutcome } from './credits.js'
import type { RpcOnboardingClaimResponse, RpcOnboardingStatusResponse } from './types.js'

/** 已知**不支持手动完成**的任务 code —— 别再白试（服务端回 9303）。 */
export const MAGICREW_NOT_MANUALLY_COMPLETABLE: readonly string[] = Object.freeze(['first_ai_work'])

/** `9303` = 该新人引导任务不支持手动完成（服务端业务码）。 */
const MAGICREW_CODE_TASK_NOT_SUPPORTED = 9303

/**
 * 相邻两次 `PUT …/completion` 之间的间隔（毫秒）。
 *
 * 参考实现（magpie `tasks.mjs:162`）逐项之间 `setTimeout(400)`，注释写明
 * 「服务端限流留点余地」。连发 7 个 PUT 撞上风控会让后面几项失败，
 * 而症状是「每次都只领到前面几项」—— 且下次重试时前面几项已领过，
 * 用户看起来像永久卡住。
 */
const MAGICREW_PUT_GAP_MS = 400

/** 请求参数（三处共用）。 */
export interface MagicrewCheckinParams {
  readonly jwt: string
  readonly organizationCode: string
  readonly product?: MagicrewProduct
  readonly fetchImpl?: typeof fetch
  /**
   * 两次 PUT 之间的间隔（毫秒）。缺省 {@link MAGICREW_PUT_GAP_MS}。
   *
   * ⚠️ 单测传 `0` 免等待 —— 否则一条用例要真等 2.4 秒（7 项 × 400ms）。
   */
  readonly throttleMs?: number
}

/** 一条新手任务（上游原样的子集）。 */
export interface MagicrewOnboardingTask {
  readonly code: string
  readonly title: string
  readonly points: number
  readonly status: string
  readonly rewardStatus: string
  readonly completedAt?: string
}

/** 读信封：成功返回 `data`，失败返回 `{ error }`（**不抛**）。 */
interface MagicrewEnvelope {
  readonly data?: Record<string, unknown>
  readonly code?: unknown
  readonly message?: string
}

/**
 * 发一次业务 API 请求并解析信封。
 *
 * ⚠️ **永不抛** —— 网络异常/非 JSON 一律折成 `{ error }`：
 * 这两条路径的上层（`credits.claim` / `onboarding.status`）契约是
 * 「回一个带原因的结果」，抛出去会让整轮 RPC 变成 `ok:false` 的笼统错误，
 * 用户看不到是哪一步失败（与 `src/raccoon-credits.ts` 的 `requestJson` 同纪律）。
 */
async function magicrewRequest(
  params: MagicrewCheckinParams,
  path: string,
  init: { method: string, body?: string },
): Promise<{ envelope?: MagicrewEnvelope, error?: string }> {
  const product = params.product ?? MAGICREW
  /**
   * ⚠️ **国际站缺 org 要在本地就拦下**（2026-11-01 协议审查；归因由二审更正）。
   *
   * ### 归因（⚠️ 二审更正：原先把两种不同端点混成了一种）
   *
   * | 端点 | 缺 `organization-code` 时的真实响应 |
   * |---|---|
   * | **业务 API** `/api/v1/*`（本函数打的这些） | `{"code":2182,"message":"用户所在组织不存在"}`（**2026-11-01 真实凭据实测确认**） |
   * | **聊天网关** `/v1/*`（`magicrew-adapter.ts` 那条腿） | ⚠️ **形态未定**：参考实现记的是「HTTP 500 + 22 字节裸文本」，但 2026-11-01 用**真实 apiKey** 实测缺 org 时仍是 **HTTP 200 + 正常 SSE 出流** |
   *
   * ⚠️⚠️ 三审结论：**不要在用户文案里写死「网关会回 500」** —— 那一条在
   * 「完整 apiKey + 缺 org」的形态下**复现不出来**（可能是 JWT 形态才触发，
   * 也可能是上游改过）。写死一个复现不出来的形态，会让用户按错误线索去排查。
   * 业务 API 的 `code 2182` 是**实测**的，可以写。
   *
   * ### 为什么要本地拦
   *
   * 两种形态都表达「这个请求没带组织」这件事，而用户点「签到」时**看不出**是缺 org：
   * 2182 的官方文案是「用户所在组织不存在」，会被读成「我的组织被删了」。
   * 本地前置校验把它变成一条**可操作**的文案（去网页端选组织 → 重新登录）。
   *
   * ⚠️ 只对 `needsOrgOnGateway` 的站生效：国内站不强制（缺了仍 200），
   *    在这里拦会让本来能用的国内账号也失败（回归）。
   */
  if (product.needsOrgOnGateway && params.organizationCode.length === 0) {
    return {
      // ⚠️ 文案只说**实测确认过**的那一条（业务 API 的 `code 2182`）。
      //    不再写「聊天网关会回 HTTP 500」—— 2026-11-01 真实 apiKey 实测
      //    缺 org 时网关仍正常出流，那条复现不出来（详见上方表格的注释）。
      error: `${product.displayName}缺少组织码（organizationCode）—— 请在网页端选中一个组织后重新登录；`
        + '该站的业务 API 会回「用户所在组织不存在」',
    }
  }
  const fetchImpl = params.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${product.host}${path}`, {
      method: init.method,
      // ⚠️ 超时必带：零超时会让签到按钮转圈到 undici 默认 ~300s
      //    （本文件是「用户点一下就等」的主路径，与积分面板同因）。
      signal: AbortSignal.timeout(product.requestTimeoutMs),
      headers: magicrewApiHeaders({
        jwt: params.jwt,
        organizationCode: params.organizationCode,
        product,
      }),
      ...init.body === undefined ? {} : { body: init.body },
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const text = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    /**
     * ⚠️ 非 JSON 响应必须把 **HTTP 状态码**浮出来：网关故障时回的常是
     * HTML 错误页或裸文本，只报「解析失败」会让用户以为插件坏了。
     *
     * ⚠️ 这**不是**「国际站缺 org」的形态 —— 本函数打的是业务 API `/api/v1/*`，
     * 缺 org 实测回的是 JSON `{"code":2182,…}`（且已被本地前置校验拦下）。
     * 保留这段兜底仍然必要（网关 5xx / 反代错误页都会走到这里）。
     */
    const snippet = text.trim().slice(0, 120)
    return {
      error: snippet.length > 0
        ? `HTTP ${response.status}（响应不是 JSON：${snippet}）`
        : `HTTP ${response.status}（空响应）`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { error: `HTTP ${response.status}（响应不是对象）` }
  }
  const envelope = parsed as MagicrewEnvelope
  /**
   * ## 判失败要**两条腿**，缺一条都会静默出错
   *
   * ① **业务码**：上游成功码是 **1000**，而**错误也可能是 HTTP 200 + `code: 403`**
   *   （「token无效」这类藏在 body 里的错误，见 `magicrew-product.ts` 文件头第 1 条硬约束）
   *   ⇒ 只看 `response.ok` 会把这类错误判成功。
   * ② **HTTP 状态码**：反过来，上游回 4xx/5xx 且 body 是**没有数字 `code` 的 JSON**
   *   （`{"message":"…"}` / `{"error":"…"}` / `{"code":"403"}` 字符串形态）时，
   *   ① 完全无牙 ⇒ 只看 ① 会把**网关故障判成成功**：
   *   · 签到因 `granted !== true` 落进 `already-claimed`「今日已领取登录积分」
   *     ⇒ **静默漏领 200/50 分且零报错**；
   *   · 新人奖励落进 `tasks: []` / `total: 0` ⇒ 看起来「这个号没有新人奖励」。
   *
   * ⚠️ 顺序不可颠倒：② **必须放在 ① 之后**。理由：`claimMagicrewOnboardingTasks`
   *    要靠 `envelope.code === 9303` 区分「该项不支持手动完成」—— 若 ② 在前，
   *    9303 若以非 2xx 下发就会被 ② 先截胡，`first_ai_work` 从此被误判成硬失败。
   *    放在 ① 之后 ⇒ 只要有数字 code 就一律走 ①（并保留 `envelope`），
   *    只有「连业务码都没有」的响应才由 ② 收口。
   *
   * ⚠️ **本仓的顺序与参考实现相反**（2026-11-01 三审更正，原注释说"同样的两步"是错的）：
   * - 参考实现 `api.mjs:99-105` 是 **HTTP 先、code 后**（`if (!res.ok) throw` 在判 code 之前）；
   * - 本仓是 **code 先（① 数字腿、③ 字符串腿）、HTTP 后（②）**。
   *
   * 这个反转是**刻意**的：要保住 `envelope` 供 `claimMagicrewOnboardingTasks`
   * 取 `code === 9303`（否则 9303 若以非 2xx 下发会被 ② 先截胡，
   * `first_ai_work` 从此被误判成硬失败）。
   */
  if (typeof envelope.code === 'number' && envelope.code !== 1000) {
    const message = typeof envelope.message === 'string' && envelope.message.length > 0
      ? envelope.message
      : `业务码 ${envelope.code}`
    return { envelope, error: message }
  }
  /**
   * ③ **`code` 是字符串形态的业务码**（2026-11-01 二审补，真缺陷）。
   *
   * 上游确实会下发 `{"code":"403","message":"…"}`（本文件上面 ①② 的注释就把它
   * 列为真实形态）。此前只在 ① 认 `typeof code === 'number'`，于是这种响应
   * **既不过 ① 也不过 ②（HTTP 是 200）** ⇒ 一路判成功：
   *
   * - 签到：`granted !== true` ⇒ 落 `already-claimed`「今日已领取登录积分」
   *   ⇒ **静默漏领 200/50 分，零报错**（用户以为今天领过了）；
   * - 新人奖励：没有 `tasks` ⇒ `total: 0`「无新人任务」。
   *
   * ⚠️ 这不是「相对参考实现的回归」（参考 `api.mjs:99-105` 同样只认数字码）——
   *    但本仓反复强调「静默漏领不可接受」，故这一层比参考更严。
   * ⚠️ 判据：**非空字符串**且 `Number()` 有限 ⇒ 按数字码同等对待。
   *    `"1000"` 是成功码，放行；`""` / 非数字字符串（如 `"OK"`）不判失败
   *    （形态未知，交给 ② 的 `response.ok` 兜底，避免把正常响应误杀）。
   * ⚠️ 用 `DECIMAL_LITERAL_RE` 而不是裸 `Number()`（2026-11-01 三审）：
   *    `Number('0x3E8') === 1000` —— 十六进制的 `"0x3E8"` 会被当成**成功码**放行。
   *    上游不会这么给，但「拒绝畸形」比「猜对」更安全（与 `magicrewPointsOf` 同纪律）。
   */
  if (typeof envelope.code === 'string') {
    const rawCode = envelope.code.trim()
    if (rawCode !== '' && DECIMAL_LITERAL_RE.test(rawCode)) {
      const numericCode = Number(rawCode)
      if (Number.isFinite(numericCode) && numericCode !== 1000) {
        const message = typeof envelope.message === 'string' && envelope.message.length > 0
          ? envelope.message
          : `业务码 ${envelope.code}`
        return { envelope, error: message }
      }
    }
  }
  if (!response.ok) {
    /**
     * ⚠️ 保留 `envelope`（**但要知道它当前取不到 9303**，2026-11-01 三审实测）。
     *
     * 走到这条腿的条件是「非 2xx **且** body 里没有可用的 `code`」——
     * 因为数字腿 ① 与字符串腿 ③ 都在它**之前**，只要有 `code` 就已被前面的腿
     * 拦下（那两条同样保留 envelope）。
     *
     * ⇒ 「这条腿丢掉 envelope 会让 9303 兜底失效」是**错的**：这种响应里本来
     * 就没有 9303。保留它只是**顺手**（成本为零，且将来若把三条腿合并成一条
     * 就自然正确）。`magicrew-checkin.spec.ts` 的「9303 + HTTP 500」用例守的是
     * 数字腿那条路径，不是这条。
     */
    const message = typeof envelope.message === 'string' && envelope.message.length > 0
      ? envelope.message
      : `HTTP ${response.status}`
    return { envelope, error: message }
  }
  return { envelope }
}

/**
 * 把上游的 `points` 读成数字；**读不到返回 0**（签到侧契约：宁可少算也不编造）。
 *
 * ⚠️ 判据与积分侧共用 `magicrew-number.ts` 的 `magicrewDecimalOf`（2026-11-01 三审抽共享）：
 * 两处各写一份同义实现会漂移 —— 实测修前 `"0x10"` 在本侧得 0、在积分侧得 **16**，
 * `"1e3"` 在本侧 0、在积分侧 **1000**。
 *
 * 本侧把 `undefined`（读不到）映射成 `0`：`earned` 是展示用的累计值，
 * 少算比错算安全；且这里**没有**「0 是合法值」的语义（任务积分不会为 0）。
 */
function magicrewPointsOf(raw: unknown): number {
  return magicrewDecimalOf(raw) ?? 0
}

/**
 * 把信封里的业务码统一读成数字（**数字与十进制字符串两种形态都认**）。
 *
 * 与 `magicrewRequest` 的判失败三腿同口径（2026-11-01 三审抽出）：
 * 只认数字会让 `{"code":"9303"}` 这种字符串形态漏判，
 * 从而把「该任务不支持手动完成」错归到 `errors` 而不是 `manualRequired`。
 * 读不到返回 `undefined`（**不猜**）。
 */
function codeOf(envelope: MagicrewEnvelope | undefined): number | undefined {
  const raw = envelope?.code
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || !DECIMAL_LITERAL_RE.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}
/** 把上游 `tasks` 数组安全地取出来（任何一层不合形状都折成空数组）。 */
function magicrewTasksOf(data: Record<string, unknown> | undefined): MagicrewOnboardingTask[] {
  const raw = data?.tasks
  if (!Array.isArray(raw)) return []
  const out: MagicrewOnboardingTask[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.code !== 'string' || entry.code.length === 0) continue
    out.push({
      code: entry.code,
      title: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : entry.code,
      /**
       * ⚠️ `points` **不要只用 `typeof === 'number'`**（2026-11-01 二审）：
       * 上游这套 Go 服务在别的积分接口里确实会下发**字符串**（`"80"`、
       * `"1,234 积分"`、Unicode 负号 `"−32"`）。
       * 只认 number 会把 `points:"80"` 记成 **0** ⇒ UI 显示「本次领取 0 积分」，
       * 而用户实际拿到了 80。
       *
       * ⚠️⚠️ **本仓刻意比参考实现保守**（2026-11-01 三审更正：原注释说
       *    「与参考实现对齐」是错的）——
       *
       * 参考实现是 `api.mjs:364-387` 的 `parsePointsValue`（它**不叫** `num()`）：
       * 去千分位、统一 Unicode 负号、读会计括号负数、剥 `¥$￥` 前缀
       * ⇒ `"1,234 积分"` 得 **1234**、`"−32"` 得 **-32**、读不到返回 `null`。
       *
       * 本仓只接受**纯十进制字面量**（见 `DECIMAL_LITERAL_RE`），其余一律读作 0：
       * `"1,234 积分"` ⇒ **0**、`"−32"` ⇒ **0**。
       *
       * **为什么故意不照抄那套宽容解析**：正常的积分字段是 number，出现带千分位
       * 或单位的字符串本身就说明**响应形态已经变了**；把它「猜」成一个数字会让
       * 一次上游改版变成「数字看起来对、其实错」的静默错误。宁可少算（0 = 读不到，
       * 用户在 `earned` 上看到的是保守值），也不要猜。
       * ⚠️ 但 `Number()` 本身也有陷阱：`Number(null) === 0`、`Number([]) === 0`、
       *    `Number(true) === 1` ⇒ 只放行 number 与十进制字符串。
       */
      points: magicrewPointsOf(entry.points),
      status: typeof entry.status === 'string' ? entry.status : '',
      rewardStatus: typeof entry.reward_status === 'string' ? entry.reward_status : '',
      ...typeof entry.completed_at === 'string' && entry.completed_at.length > 0
        ? { completedAt: entry.completed_at } : {},
    })
  }
  return out
}

/**
 * 一条任务是否**已经拿过分**。
 *
 * ⚠️ 判据是 `status === 'COMPLETED'` **或** `reward_status === 'GRANTED'`：
 * 两者在上游是**独立**字段（实测存在 `COMPLETED` 但 `reward_status` 为空的样本），
 * 只判一个会重复 PUT 已领过的任务。
 */
export function magicrewTaskIsDone(task: MagicrewOnboardingTask): boolean {
  return task.status === 'COMPLETED' || task.rewardStatus === 'GRANTED'
}

/**
 * **每日签到** —— `POST /api/v1/login-gift`。
 *
 * 幂等：当天已领回 `granted:false`，此处映射成 `already-claimed` 而**不是**
 * `claimed` —— 后者会让用户以为每天都在加积分，而实际上什么都没发生。
 */
export async function claimMagicrewLoginGift(
  params: MagicrewCheckinParams,
): Promise<ClaimOutcome> {
  const { envelope, error } = await magicrewRequest(params, MAGICREW_LOGIN_GIFT_PATH, {
    method: 'POST',
    // ⚠️ 上游要求**有请求体且为空串**（不是省略 body）：省略时 Go 侧可能拒绝。
    body: '',
  })
  if (error !== undefined) {
    // ⚠️ `-1` 而非 `0`：本仓「无业务码」的惯例是 -1（`src/credits.ts:598`），
    //    而 0 在别处是**成功码**（`credits.ts:610`），写 0 会让日志看起来像成功。
    return { kind: 'failed', code: -1, message: `领取每日登录积分失败：${error}` }
  }
  /**
   * ⚠️⚠️ **`granted` 必须是布尔值**，否则判失败而不是「已领取」（2026-11-01 三审）。
   *
   * 只判 `granted === true` 时，一个 `200 + {}`（或任何缺 `granted` 的畸形响应）
   * 会落进「不是 true」那条腿 ⇒ 返回 `already-claimed`「今日已领取登录积分」
   * ⇒ **用户以为今天领过了，实际什么都没发生**（静默漏领，零报错）。
   *
   * 正常响应（两站实测）是 `{"code":1000,"data":{"granted":true|false,…}}` ——
   * `granted` **恒存在且是布尔**。缺它 = 上游形态已变 ⇒ 报失败让用户看见。
   */
  const data = (envelope?.data ?? {}) as Record<string, unknown>
  if (typeof data.granted !== 'boolean') {
    return {
      kind: 'failed',
      code: -1,
      message: '领取每日登录积分失败：响应里没有 granted 字段（上游形态可能已变）',
    }
  }
  const granted = data.granted === true
  const message = typeof data.message === 'string' ? data.message : ''
  if (!granted) {
    return {
      kind: 'already-claimed',
      message: message.length > 0 ? message : '今日已领取登录积分',
    }
  }
  const points = typeof data.point_amount === 'number' && Number.isFinite(data.point_amount)
    ? data.point_amount
    : 0
  return {
    kind: 'claimed',
    credit: points,
    // 上游不提供连续天数（`expire_type` 是有效期类型，不是 streak）
    // ⇒ 如实为 0，**不编造**（契约要求该字段存在）。
    streakDays: 0,
    isStreakDay: false,
    ...message.length > 0 ? { delayedMessage: message } : {},
  }
}

/**
 * **新人奖励状态**（只读）—— `GET /api/v1/onboarding/tasks`。
 *
 * ⚠️ **只读：不得**在此触发任何 `completion`（面板挂载时会调用它）。
 * ⚠️ 0 项时如实回 `total: 0`，调用侧据此显示「无任务可领」而不是「已全部完成」。
 */
export async function fetchMagicrewOnboardingStatus(
  params: MagicrewCheckinParams,
): Promise<RpcOnboardingStatusResponse> {
  const { envelope, error } = await magicrewRequest(params, MAGICREW_ONBOARDING_TASKS_PATH, {
    method: 'GET',
  })
  if (error !== undefined) throw new Error(error)
  const tasks = magicrewTasksOf(envelope?.data)
  const state: Record<string, boolean> = {}
  const titles: Record<string, string> = {}
  const points: Record<string, number> = {}
  let earned = 0
  let total = 0
  for (const task of tasks) {
    const done = magicrewTaskIsDone(task)
    state[task.code] = done
    titles[task.code] = task.title
    points[task.code] = task.points
    total += task.points
    // `earned` 回答的是「**累计**已领多少」，与「本次是否新增」无关
    //（与 `src/provider-onboarding.ts` 的 raccoon 那条缺陷同因）。
    if (done) earned += task.points
  }
  return { tasks: state, earned, total, titles, points }
}

/**
 * **领取新人奖励** —— 对每个未完成任务 `PUT …/<code>/completion`。
 *
 * ⚠️ `first_ai_work` **不发 PUT**：服务端固定回 `9303`，白试一轮还会让用户看到
 * 一条假的失败。它归入 `manualRequired`（**不是** `skipped`）—— 后者在前端被
 * 渲染成「N 个此前已完成」，而这一项**既没完成也没领到分**，混进去就是把
 * "没做"写成"做过"（2026-11-01 协议审查点名的缺陷）。
 *
 * ⚠️ **单项失败不中断整轮**：其余项照领，失败项收进 `errors` **上抛或返回**。
 * 中断会让「8 项里有 1 项抖动」变成「一项都没领到」，而下一轮重试时前面几项
 * 已经领过，用户看起来像卡住了。
 * - **零成功 + 有失败** ⇒ **上抛**（否则上层会包成「成功但没领到」）
 * - **有成功 + 有失败** ⇒ 返回并带上 `errors`（上抛会让用户以为整轮失败，
 *   而实际已经领到了大部分分；旧实现把它静默吞掉，同样是缺陷）
 *
 * ## ⚠️ 能力上限（**如实说明，不要以为只差一项**）
 *
 * 国内站 8 项里 7 项 PUT 即完成，第 8 项 `first_ai_work` 必须**真发一条消息**
 * （走话题 Socket.IO）才会置位；国际站的首对话任务同理。而它**同时是邀请奖励
 * 的触发条件**（被邀请人完成首个任务/对话后，邀请人才 +200 分）。
 *
 * 本实现**不做**发消息那条腿（协议是另一套 Socket.IO 通道，不在本次范围内），
 * 故：该项分 + 国际站首对话 + 邀请奖励**都拿不到**。这是**已知取舍**，
 * 已通过 `manualRequired` 如实告知用户，不是"已全部领完"。
 *
 * ⚠️ 相邻两次 PUT 之间留 **400ms**：参考实现（magpie `tasks.mjs:162`）如此，
 * 注释写明「服务端限流留点余地」。连发 7 个 PUT 撞上风控会让后面几项失败，
 * 而症状是「每次都只领到前面几项」。
 */
export async function claimMagicrewOnboardingTasks(
  params: MagicrewCheckinParams,
): Promise<RpcOnboardingClaimResponse> {
  const status = await fetchMagicrewOnboardingStatus(params)
  const claimed: { key: string, title: string, points: number }[] = []
  const skipped: string[] = []
  const errors: string[] = []
  const manualRequired: string[] = []
  /** PUT 之间的限流间隔（参考实现同值）。0 表示不等待（单测用）。 */
  const gapMs = params.throttleMs ?? MAGICREW_PUT_GAP_MS
  let putCount = 0
  for (const code of Object.keys(status.tasks)) {
    if (status.tasks[code] === true) {
      // 真正「此前已完成」的才进 skipped。
      skipped.push(code)
      continue
    }
    if (MAGICREW_NOT_MANUALLY_COMPLETABLE.includes(code)) {
      // 不白试：服务端固定回 9303。⚠️ 归 manualRequired，**不是** skipped。
      manualRequired.push(code)
      continue
    }
    if (putCount > 0 && gapMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, gapMs))
    }
    putCount += 1
    const path = `${MAGICREW_ONBOARDING_TASKS_PATH}/${encodeURIComponent(code)}/completion`
    const { envelope, error } = await magicrewRequest(params, path, { method: 'PUT', body: '{}' })
    if (error !== undefined) {
      /**
       * 9303 即便漏进这里（例如名单漏登记了新 code）也不应该让整轮失败
       * ⇒ 归 `manualRequired`，与上面那条同语义。
       *
       * ⚠️ 判据必须**两条腿**（数字 + 十进制字符串），与 `magicrewRequest` 的
       *    ①②③ 三腿同口径（2026-11-01 三审）：只认数字时，上游若下发
       *    `{"code":"9303"}`，字符串腿会先把它判成失败 ⇒ 落 `errors` 而不是
       *    `manualRequired` —— 与「9303 不该让整轮失败」的自述不符。
       */
      const code9303 = codeOf(envelope) === MAGICREW_CODE_TASK_NOT_SUPPORTED
      if (code9303) manualRequired.push(code)
      else errors.push(`${code}: ${error}`)
      continue
    }
    /**
     * ⚠️ `data.points` 缺失**或为 0** 时回退任务表：上游成功响应里
     * `data.points` 偶有 0（参考实现 `tasks.mjs:153` 写的是 `r.points || t.points`），
     * 直接用 0 会让 `earned` 少算。
     *
     * ⚠️ 用 `magicrewPointsOf` 而**不是**裸 `typeof === 'number'`（2026-11-01 三审）：
     * 上游同一套服务在别处会下发**字符串**形态的积分数，只认 number 会把
     * `points:"80"` 当成「读不到」而回退到任务表 —— 那两份数字不一定相等，
     * 于是「实际领到 80」被显示成「领到任务表里的另一个数」。
     */
    const putPoints = magicrewPointsOf(envelope?.data?.points)
    const points = putPoints > 0 ? putPoints : status.points[code] ?? 0
    claimed.push({ key: code, title: status.titles[code] ?? code, points })
  }
  if (claimed.length === 0 && errors.length > 0) {
    // 一项都没领到且有失败 ⇒ 必须上抛（否则上层会包成「成功但没领到」）。
    throw new Error(`新人奖励领取失败：${errors.join('；')}`)
  }
  /**
   * ⚠️ `earned` 用「领之前的累计 + 本次新增」而不是重新 GET 一次：
   * 重新 GET 会在服务端有延迟写时少算，让 UI 出现「刚领完却显示 0」。
   */
  const claimedPoints = claimed.reduce((sum, item) => sum + item.points, 0)
  const earnedAfter = status.earned + claimedPoints
  return {
    claimed,
    skipped,
    earned: earnedAfter,
    /**
     * ⚠️ `total` 用 `max(读到的合计, earned)` 只为**不让进度条超过 100%**；
     * 它不是在修根因 —— 若上游某天只下发未完成项，`status.total` 会凭空缩小。
     * 保住下界即可，不要在这里编造「总分常量」（上游没给）。
     */
    total: Math.max(status.total, earnedAfter),
    ...errors.length > 0 ? { errors } : {},
    ...manualRequired.length > 0 ? { manualRequired } : {},
  }
}
