/**
 * 豆包（Doubao）每日签到 —— **纯 HTTP（无浏览器）**。
 *
 * ## 从「CDP 页面会话」迁到「沙箱签名 + 直连」（2026-11-25）
 *
 * 老实现在临时 Chromium 里注入该账号的 cookie、由页面自己的 `window.bdms.frontierSign`
 * 产 `a_bogus`，再带 `credentials:'include'` POST。这条腿要求镜像里有 Chromium
 * （300MB + Xvfb + VNC），而 hub 在容器 / 无桌面服务器上的部署形态里并没有浏览器
 * ⇒ 浏览器腿已整段删除，改为「沙箱签名 + 直连」。
 *
 * 页面腿做的事只有三件，HTTP 腿逐一等价替换：
 *
 * | 页面腿 | HTTP 腿 |
 * |---|---|
 * | 注入该账号 cookie（`Network.setCookie`） | `Cookie` 请求头（凭据里的 `cookie`） |
 * | `window.bdms.frontierSign({…})` | `doubao-bdms.ts`：把同一个 SDK 放进 `node:vm` 沙箱签名 |
 * | `fetch(url, { credentials:'include' })` | 裸 `fetch`（自己拼 query / 头 / body） |
 *
 * 请求体、查询串、`Content-Type: application/json`、`Agw-Js-Conv: str` 与页面上
 * 那一版**逐字相同**（实测签名输出形状一致：`{'X-Bogus': …}`）。
 *
 * ## 账号隔离
 *
 * `device_id` / `web_id` / `tea_uuid` 由**该账号的 `accountKey`（sessionid）确定性派生**
 * （每账号一套 19 位数字设备号，对齐 TRAE `deriveDeviceId15` 的纪律 —— 规避服务端
 * 「每设备每天一次」配额），与登录腿共用同一份派生函数（`doubao.ts`）。
 *
 * ## 为什么不能"只发 checkin、不查状态"
 *
 * `landing/get` 只用于丰富文案：**不能据它短路** —— 已签账号的 `landing/get`
 * 也回空活动（签完当天就没有可领对象了），短路会把「今天已签」误报成「没有活动」。
 * `checkin` 本身幂等（已签回 `checked_in:true, idempotent:true`），始终发。
 *
 * @module src/doubao-signin.ts
 */

import {
  DOUBAO_BASE_URL,
  DOUBAO_CAMPAIGN_GROUP_CODE,
  DOUBAO_CHECKIN_PATH,
  DOUBAO_CHECKIN_STATUS_PATH,
  DOUBAO_WEB_USER_AGENT,
  doubaoCheckinQuery,
  parseDoubaoCredential,
} from './doubao.js'
import { signDoubaoBogus } from './doubao-bdms.js'

/** 签到响应形状。 */
interface DoubaoCheckinWire {
  data?: {
    checked_in?: boolean
    checkin_date?: string
    continuous_days?: number
    idempotent?: boolean
    reward_amount?: number
    reward_code?: string
    reward_status?: number
    reward_type?: string
  }
  code?: number
  msg?: string
  message?: string
}

/**
 * 把签到响应映射成统一的三态结果。
 *
 * ⚠️ 单独抽出的理由：状态查询与领取是两个请求、响应体同形，文案与判据必须
 * 只存在于**一处** —— 复制两份必然出现「710010702 一处报失败、另一处报无活动」
 * 这种同义分叉（本仓记录过多次）。
 */
function mapDoubaoCheckinWire(
  wire: DoubaoCheckinWire | undefined,
  httpStatus: number,
  log?: (msg: string) => void,
): import('./credits.js').ClaimOutcome {
  if (wire === undefined) {
    return { kind: 'failed', code: -1, message: `签到响应不是 JSON（HTTP ${httpStatus}）` }
  }
  const code = typeof wire.code === 'number' ? wire.code : -1
  const data = wire.data
  if (code === 0 && data?.checked_in === true) {
    const amount = typeof data.reward_amount === 'number' ? data.reward_amount : 0
    const days = typeof data.continuous_days === 'number' ? data.continuous_days : 0
    log?.(`[doubao] 签到成功：+${amount}（连续 ${days} 天）`)
    return { kind: 'claimed', credit: amount, streakDays: days, isStreakDay: days > 0 }
  }
  if (data?.idempotent === true && data.checked_in === false) {
    return { kind: 'already-claimed', message: '今天已签到' }
  }
  /**
   * ⚠️ `710010702`（2026-11-03 多账号实测，含官方客户端环境复现）：当前
   * **没有可领的签到活动**（landing/get 同时刻回 `code:0` 但活动内容全空）。
   * 覆盖三种上游形态：今日已领完 / 活动未对该账号投放 / 活动已收摊 ——
   * 对用户的动作都一样（明天再看），不是故障，不按网络错误排查。
   */
  if (code === 710010702) {
    return { kind: 'inactive', message: '当前没有可领取的豆包签到活动（可能今日已领完、或活动未对当前账号/时段投放）' }
  }
  return { kind: 'failed', code, message: wire.msg ?? wire.message ?? `签到失败（code=${code}）` }
}

/**
 * 只读探活：判断一份粘进来的 cookie 是否还有登录态（**不发 checkin**）。
 *
 * ⚠️ 判据来自 2026-11-26 实测：
 * - 空 cookie / 假 `sessionid` ⇒ `{"code":710012001,"msg":"登录已过期，请重新登录"}`
 * - 有效账号 ⇒ `code:0`（或 `710010702`「当前没有可领的活动」）
 *
 * ⇒ **只有 `710012001` 代表登录态失效**，其余错误码（活动类 / 时段类）与登录态
 *    无关，不能拿来拦用户。网络失败或签名不可用时返回 `sessionOk: undefined`
 *    （"没验成"），调用方按**放行**处理 —— 宁可让用户先建号，也不要因为一次
 *    网络抖动把有效 cookie 拒之门外。
 */
export async function probeDoubaoSession(
  rawCredential: string,
  options: {
    log?: (msg: string) => void
    timeoutMs?: number
    /** 测试注入点：返回 `a_bogus`（生产路径不要传）。 */
    sign?: () => Promise<string>
  } = {},
): Promise<{ sessionOk?: boolean, code?: number, message?: string }> {
  const credential = parseDoubaoCredential(rawCredential)
  if (!credential?.cookie) return { sessionOk: false, message: '没有可用的豆包登录会话（cookie 为空）' }
  let bogus: string
  try {
    bogus = await (options.sign ?? (() => signDoubaoBogus({ log: options.log })))()
  } catch (error) {
    return { sessionOk: undefined, message: `签名环境不可用：${error instanceof Error ? error.message : String(error)}` }
  }
  const query = `${doubaoCheckinQuery(credential)}&a_bogus=${encodeURIComponent(bogus)}`
  try {
    const response = await fetch(`${DOUBAO_BASE_URL}${DOUBAO_CHECKIN_STATUS_PATH}?${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'agw-js-conv': 'str',
        cookie: credential.cookie,
        'user-agent': DOUBAO_WEB_USER_AGENT,
        referer: `${DOUBAO_BASE_URL}/chat/`,
        origin: DOUBAO_BASE_URL,
      },
      body: JSON.stringify({ scene: DOUBAO_CAMPAIGN_GROUP_CODE }),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
    const text = await response.text()
    let wire: DoubaoCheckinWire | undefined
    try { wire = JSON.parse(text.slice(0, 4_194_304)) as DoubaoCheckinWire } catch { wire = undefined }
    if (wire === undefined) {
      return { sessionOk: undefined, message: `探活响应不是 JSON（HTTP ${response.status}）` }
    }
    const code = typeof wire.code === 'number' ? wire.code : -1
    if (code === 710012001) {
      return { sessionOk: false, code, message: wire.msg ?? '登录已过期，请重新登录' }
    }
    return { sessionOk: true, code }
  } catch (error) {
    return { sessionOk: undefined, message: `探活请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 豆包签到的 HTTP 腿：沙箱签名 + 直接 POST（**不接受任何浏览器兜底**）。
 *
 * @param options.sign 测试注入点（默认走 `doubao-bdms.ts` 的 vm 沙箱签名）。
 *                     生产路径不要传。
 */
export async function claimDoubaoDailyViaHttp(
  rawCredential: string,
  options: {
    log?: (msg: string) => void
    timeoutMs?: number
    /** 测试注入点：返回 `a_bogus`。缺省 = `signDoubaoBogus()`（vm 沙箱）。 */
    sign?: () => Promise<string>
  } = {},
): Promise<{ outcome: import('./credits.js').ClaimOutcome; signerError?: string }> {
  const credential = parseDoubaoCredential(rawCredential)
  if (!credential?.cookie) {
    return { outcome: { kind: 'inactive', message: '没有可用的豆包登录会话（请先在账号卡上完成登录）' } }
  }
  let bogus: string
  try {
    bogus = await (options.sign ?? (() => signDoubaoBogus({ log: options.log })))()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    /**
     * ⚠️ 文案要点：**不要**再提「装浏览器」—— 这条腿是唯一的签到路径，运行环境里
     *    本来就没有 Chromium（也不该为一个签到装它）。
     *    说清楚「签名环境出了问题 + 原因」，剩下的交给日志。
     */
    return {
      outcome: {
        kind: 'failed',
        code: -1,
        message: `豆包签到签名环境不可用（不需要浏览器，问题在 bdms SDK 这一侧）：${reason}`,
      },
      signerError: reason,
    }
  }
  const timeoutMs = options.timeoutMs ?? 20_000
  const query = `${doubaoCheckinQuery(credential)}&a_bogus=${encodeURIComponent(bogus)}`
  const call = async (path: string): Promise<{ status: number, body: string }> => {
    const response = await fetch(`${DOUBAO_BASE_URL}${path}?${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // ⚠️ 服务端按它决定 JSON 的编码方式；页面腿也带这个头，不能省。
        'agw-js-conv': 'str',
        cookie: credential.cookie ?? '',
        'user-agent': DOUBAO_WEB_USER_AGENT,
        referer: `${DOUBAO_BASE_URL}/chat/`,
        origin: DOUBAO_BASE_URL,
      },
      body: JSON.stringify({ scene: DOUBAO_CAMPAIGN_GROUP_CODE }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: response.status, body: await response.text() }
  }
  try {
    // 与页面腿同序：先 `landing/get`（只读，丰富文案）再 `checkin`。
    const status = await call(DOUBAO_CHECKIN_STATUS_PATH)
    const claim = await call(DOUBAO_CHECKIN_PATH)
    let wire: DoubaoCheckinWire | undefined
    try { wire = JSON.parse(claim.body.slice(0, 4_194_304)) as DoubaoCheckinWire } catch { wire = undefined }
    return { outcome: mapDoubaoCheckinWire(wire, claim.status, options.log) }
  } catch (error) {
    return {
      outcome: { kind: 'failed', code: -1, message: `豆包签到请求失败：${error instanceof Error ? error.message : String(error)}` },
    }
  }
}

/**
 * ★ **豆包每日签到入口**（只有 HTTP 一条腿，**全程无浏览器**）。
 *
 * ⚠️ `executablePath` / `browserFallback` 两个选项已随浏览器腿一起删除：调用方
 * （`doubao-credits.ts`、`auto-checkin.ts`）传进来也只是被忽略，不如让类型层面
 * 就拒绝 —— 免得以后有人以为"传个路径就能回退浏览器"。
 */
export async function claimDoubaoDaily(
  rawCredential: string,
  options: {
    log?: (msg: string) => void
    timeoutMs?: number
    /** 测试注入点：返回 `a_bogus`（生产路径不要传）。 */
    sign?: () => Promise<string>
  } = {},
): Promise<import('./credits.js').ClaimOutcome> {
  const http = await claimDoubaoDailyViaHttp(rawCredential, {
    log: options.log,
    timeoutMs: options.timeoutMs,
    sign: options.sign,
  })
  if (http.signerError !== undefined) {
    options.log?.(`[doubao] 签名不可用（${http.signerError}）—— 签到走 HTTP 腿失败，且已无浏览器兜底`)
  }
  return http.outcome
}
