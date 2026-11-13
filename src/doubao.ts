/**
 * 豆包（Doubao，字节跳动）凭据模型与共享常量。
 *
 * ## 鉴权形态（2026-11-03 真机实测接通）
 *
 * 豆包是 **cookie 鉴权**（不是 OAuth / Bearer）：会话态由 `.doubao.com` 上的
 * `sessionid` / `sid_tt` / `ttwid` 等一组 cookie 承载（实测抓包见
 * `scripts/probe-doubao-capture.cjs`）。本插件把这一组 cookie 直接存成凭据字段，
 * 签到时原样回拼成 `Cookie` 头。
 *
 * ⚠️ **签名不是 header，是 query 的 `a_bogus`**（与 TRAE 的 `X-Bogus` 不同源）：
 * 它由豆包页面上下文里的 `bdms.frontierSign` 生成（`window.bdms` 只在
 * doubao.com 页面里存在），⇒ **签到必须走 CDP 页面会话**（与 zcode captcha /
 * magicrew 浏览器登录同型），纯 Node fetch 产不出合法 `a_bogus`。
 *
 * ## 设备身份
 *
 * 签到 URL 的公共 query 带 `device_id` / `web_id`（实测见抓包）。两者都来自
 * 豆包客户端的 `Local State`（`device.device_id` 与 cookie 的 `ttwid` 派生），
 * 按账号稳定 ⇒ 存进凭据，签到时原样回用。
 *
 * @module src/doubao.ts
 */

import { createHash } from 'node:crypto'

/** 豆包凭据（cookie 鉴权 + 设备指纹）。 */
export interface DoubaoCredential {
  /** 会话 cookie 串（`name=value; ...`，签到时原样放进 `Cookie` 头）。 */
  cookie?: string
  /**
   * 账号标识（`sessionid` 或 uid），用于**确定性派生**该账号的设备身份。
   *
   * ⚠️ 与 TRAE 的 `deriveDeviceId15(uid)` 同型纪律（`src/trae.ts`）：
   * 每个账号基于它永远得到同一套数字设备号，规避服务端「每设备每天一次」
   * 的配额；不同账号天然不同设备。
   */
  accountKey?: string
  /** 设备 id（签到 query 的 `device_id`，19 位数字形态）。 */
  deviceId?: string
  /** web id（签到 query 的 `web_id` / `tea_uuid`，19 位数字形态）。 */
  webId?: string
  /** 账号昵称（展示用，不参与鉴权）。 */
  nickname?: string
}

/** 解析池里那份 JSON 凭据；坏 JSON / 非对象一律 `undefined`（不抛）。 */
export function parseDoubaoCredential(raw: string | undefined | null): DoubaoCredential | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const o = parsed as Record<string, unknown>
  const out: DoubaoCredential = {}
  if (typeof o.cookie === 'string' && o.cookie.length > 0) out.cookie = o.cookie
  if (typeof o.accountKey === 'string' && o.accountKey.length > 0) out.accountKey = o.accountKey
  if (typeof o.deviceId === 'string' && o.deviceId.length > 0) out.deviceId = o.deviceId
  if (typeof o.webId === 'string' && o.webId.length > 0) out.webId = o.webId
  if (typeof o.nickname === 'string' && o.nickname.length > 0) out.nickname = o.nickname
  return out
}

// ── 设备身份确定性派生（对齐 `src/trae.ts` 的 `deriveDeviceId15` 纪律）──

/**
 * SHA-256 确定性伪随机流（与 `src/trae.ts` 的 `seededStream` 同算法）。
 *
 * 输入 `(seed, salt)` 永远产生相同的输出序列。
 */
function seededStream(seed: string, salt: string, nbytes: number): number[] {
  const prefix = `${salt}:${seed}`
  const result: number[] = []
  let counter = 0
  while (result.length < nbytes) {
    const counterBuf = new Uint8Array(4)
    counterBuf[0] = (counter >> 24) & 0xFF
    counterBuf[1] = (counter >> 16) & 0xFF
    counterBuf[2] = (counter >> 8) & 0xFF
    counterBuf[3] = counter & 0xFF
    const h = createHash('sha256')
    h.update(prefix, 'utf8')
    h.update(counterBuf)
    for (const b of h.digest()) {
      result.push(b)
      if (result.length >= nbytes) break
    }
    counter++
  }
  return result.slice(0, nbytes)
}

/** 确定性派生 N 位数字字符串（19 位对齐豆包实测的 device_id/web_id 形态）。 */
function seededDigits(n: number, seed: string, salt: string): string {
  const bs = seededStream(seed, salt, n)
  return bs.map((b) => (b % 10).toString()).join('')
}

/**
 * ★ **豆包账号的设备身份（每账号一套，确定性派生）**。
 *
 * ## 为什么不直接用登录会话的 `s_v_web_id` / `ttwid`
 *
 * 实测（2026-11-03 多账号）：
 * - `s_v_web_id` 形如 `verify_mw0tswwg_…`（verify 前缀的**预验证** id），
 *   不是服务端注册的正式设备号；
 * - 真实抓包里官方 query 用的是 **19 位数字**的 `device_id` / `web_id` / `tea_uuid`；
 * - 每次一次性 profile 产出的都不同 ⇒ 服务端没「见过」这些设备。
 *
 * ## 派生纪律（对齐 TRAE `deriveDeviceId15` / Qoder 机器头族的教训）
 *
 * - **同一账号永远同一套**（`accountKey` = `sessionid`，账号的稳定标识）；
 * - **不同账号天然不同** ⇒ 规避「同设备多账号签到互斥」（TRAE `device_id`
 *   注释记的实测形态：同一天两账号共用同一 device_id 会被「该设备已签到」拦截）；
 * - 形态合法（19 位数字），与官方抓包一致。
 */
export function doubaoDerivedDeviceIdentity(accountKey: string): { deviceId: string, webId: string, teaUuid: string } {
  return {
    deviceId: seededDigits(19, accountKey, 'dbdev'),
    webId: seededDigits(19, accountKey, 'dbweb'),
    teaUuid: seededDigits(19, accountKey, 'dbtea'),
  }
}

/**
 * 判断一个「存的设备号」是否是**合法的注册形态**（19 位数字）。
 *
 * ⚠️ 登录会话早期版本存过 `s_v_web_id`（`verify_…` 前缀）和 `ttwid`
 * （含 `%`/`|` 的 URL 编码串）——它们是**预验证 id**，服务端没注册过
 * （多账号实测 710010702 的根因之一）。这类值**一律视为无效**，回落到
 * 确定性派生。
 */
function isRegisteredDeviceShape(value: string | undefined): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  return /^\d{15,21}$/.test(value)
}

/**
 * 从凭据取「本账号的设备身份」：优先用**确定性派生**（`accountKey` 在场时），
 * 显式存的值只在**合法注册形态**（15–21 位纯数字）时才用（老凭据里存的
 * verify 形态 id 无效，一律走派生）。
 *
 * ⚠️ `accountKey` 缺席时用 cookie 里的 `sessionid` 当种子（同样是账号稳定标识）。
 */
export function doubaoDeviceIdentityOf(credential: DoubaoCredential): { deviceId: string, webId: string, teaUuid: string } {
  const seed = credential.accountKey?.length ? credential.accountKey : (sessionIdFromCookie(credential.cookie) ?? 'doubao-anon')
  const derived = doubaoDerivedDeviceIdentity(seed)
  return {
    deviceId: isRegisteredDeviceShape(credential.deviceId) ? credential.deviceId : derived.deviceId,
    webId: isRegisteredDeviceShape(credential.webId) ? credential.webId : derived.webId,
    teaUuid: derived.teaUuid,
  }
}

/** 从 cookie 头里取 `sessionid` 的值（账号稳定标识）。 */
export function sessionIdFromCookie(cookie: string | undefined): string | undefined {
  if (typeof cookie !== 'string' || cookie.length === 0) return undefined
  for (const pair of cookie.split(';')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    if (pair.slice(0, eq).trim() !== 'sessionid') continue
    const value = pair.slice(eq + 1).trim()
    return value.length > 0 ? value : undefined
  }
  return undefined
}

/** 豆包主站基址（签到/活动端点都挂在它下面）。 */
export const DOUBAO_BASE_URL = 'https://www.doubao.com'

/** 每日签到领取端点路径（实测接通，2026-11-03）。 */
export const DOUBAO_CHECKIN_PATH = '/alice/ug/campaign/landing/checkin'

/** 签到活动组码（`pc_incentive_task_mvp_v3`，实测自 `Local State` 的 user-growth 快照）。 */
export const DOUBAO_CAMPAIGN_GROUP_CODE = 'pc_incentive_task_mvp_v3'

/** 签到请求的公共 query（`a_bogus` 由页面签名另算，不在这里）。 */
export function doubaoCheckinQuery(credential: DoubaoCredential): string {
  // ⚠️ 设备身份用**确定性派生**（每账号一套，见 doubaoDeviceIdentityOf）。
  const { deviceId, webId, teaUuid } = doubaoDeviceIdentityOf(credential)
  return [
    'version_code=20800',
    'language=zh',
    'device_platform=web',
    'doubao_device_platform=web',
    'aid=497858',
    'real_aid=497858',
    'pkg_type=release_version',
    `device_id=${encodeURIComponent(deviceId)}`,
    `web_id=${encodeURIComponent(webId)}`,
    `tea_uuid=${encodeURIComponent(teaUuid)}`,
    'region=CN',
    'sys_region=CN',
    'samantha_web=1',
    'web_platform=desktop',
    'use-olympus-account=1',
  ].filter((s) => s.length > 0).join('&')
}

/** 签到活动状态查询端点（两步签到的第一步，只读）。 */
export const DOUBAO_CHECKIN_STATUS_PATH = '/alice/ug/campaign/landing/get'

/** 签到会话要打开的页面（`bdms` 只在 doubao.com 页面上下文里存在）。 */
export const DOUBAO_PAGE_URL = 'https://www.doubao.com/chat/'
