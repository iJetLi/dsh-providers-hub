/**
 * Accio（阿里）的**积分与账号身份查询** —— 三个只读端点。
 *
 * ## ⚠️⚠️ 本文件唯一的陷阱：三个端点的**传参方式各不相同**
 *
 * 逐条实测（`docs/agent-notes/providers-accio.md` §6；探针
 * `.tmp-accio/probe-credits.mjs` / `probe-login.mjs` 全部 200）：
 *
 * | 端点 | 方法 | token 位置 |
 * |---|---|---|
 * | `/api/auth/userinfo` | **POST** | **body**（`{accessToken}`） |
 * | `/api/entitlement/currentSubscription` | **GET** | **query**（`?accessToken=…`） |
 * | `/api/entitlement/quota` | **GET** | **query** |
 *
 * **用错即 `405 Method Not Allowed` / `400 Bad Request`**（笔记原文：
 * 「`userinfo` 必须 POST + body（GET 会 405），其余 GET + query（缺 token 会 400）」）。
 * 故 {@link callAccioEndpoint} 里 method 与 token 位置**由同一个 `method` 参数决定**，
 * 调用点无法只改一处而漏掉另一处 —— 这是本文件刻意维持的形状，**不要**为了「统一好看」
 * 把三个端点收成一个公共形状。
 *
 * 官方客户端 bundle（`.tmp-accio/extract/out__main__gateway-worker.js`）里有同一
 * 事实的第二份证据：它的重试助手把新 token 写回 **body JSON**
 * （`n.accessToken = t; body = JSON.stringify(n)`），而另一条路径拼的是
 * **query**（`accessToken=${encodeURIComponent(t)}`）—— 两种形态并存，不是笔误。
 * 同一份 bundle 的端点 schema 也确认 `POST /auth/userinfo` 的响应含
 * `userId` / `userName` / `maskedMobile` / `userLevel` / `routeRegion`（与
 * {@link AccioUserInfo} 逐字段对上）。
 *
 * ## ⚠️ 失败语义：`null` 表达「查不到」，**绝不编造 0**
 *
 * 0 是「已用光」的语义。把一次网络失败画成 `0` 会让用户以为额度被清空
 * （本仓库反复记录的缺陷形态；`src/provider-credits.ts` 文件头有同一约定）。
 * 故 {@link fetchAccioBalanceDetailed} 的任何失败路径都返回 `balance: null` **加**原因。
 *
 * ## ⚠️ 401 / `NOT_LOGIN` 必须与「一般查询失败」区分
 *
 * 两者的**用户动作完全不同**：未登录 ⇒ 去重新登录；一般失败 ⇒ 查网络/上游。
 * 压成同一句「查询失败」会让用户按错误方向排查。
 * 判据照官方客户端：HTTP 401/403，或响应体 `code` 为 `'401'` / `'NOT_LOGIN'`
 * （实测该形态是 **HTTP 200 + body `{success:false, code:'401', message:'NOT_LOGIN'}`**，
 * 只看 HTTP 状态码会漏判）。
 *
 * ⚠️⚠️ `code` 必须按**标量**归一后再比（{@link readScalarString}）：官方客户端写的是
 * `String(e.code) === '401'`，说明它**可能不是字符串**。若只认字符串，上游某天发
 * `code: 401`（数字）时判据恒不命中 ⇒ 用户看到的是「查询失败」而不是「未登录」——
 * 方向性误诊。失败摘要同理要兼容 `{error:'…'}` 这种不带 `message` 的信封。
 *
 * ## 三类积分桶
 *
 * `data.entitlement` 下的 `daily` / `monthly` / `referral`（笔记 §6）：
 * - **值为 0 的桶保留**（用户要看到「还有 0」）；
 * - **缺席的桶不产出**（不是产出一条 0 —— 那会把「没有这个桶」说成「桶是空的」）。
 *
 * ## 只读、不消耗积分
 *
 * 三个端点**全是只读**（笔记 §6 标题即「积分：没有签到端点」）。本文件
 * **不实现任何签到/领取**：Accio 的每日 200 积分由**登录**触发服务端发放，
 * 没有可调用的签到 API（`provider-registry.ts` 的 `dailyCheckin: false` 是如实登记）。
 *
 * ## 为什么不带 `appKey` / `version` / `utdid` 头
 *
 * 推理端点（`/api/adk/llm/generateContent`）需要 `accioHeaders()` 那套头；
 * 但这三个**只读网关端点**的实测探针只发了 `Accept`（POST 另加 `Content-Type`）
 * 就全部 200。**照实测发**，不把推理端的头「顺手」带过来 —— 未实测的组合是
 * 单向下注（本仓库的既有纪律）。
 */

import {
  ACCIO,
  ACCIO_QUOTA_PATH,
  ACCIO_REQUEST_TIMEOUT_MS,
  ACCIO_SUBSCRIPTION_PATH,
  ACCIO_USERINFO_PATH,
} from './accio-product.js'
import type { AccioCredential } from './accio.js'
import { roundCredits, type CreditBalance, type CreditPackage } from './credits.js'
import type { ProviderBalanceDetail } from './provider-runtime.js'
import type { RpcCreditsBalanceExtra } from './types.js'

/** 账号身份（`POST /api/auth/userinfo`，字段与官方 schema 逐字对应）。 */
export interface AccioUserInfo {
  userId: string
  userName: string
  /** 服务端按账号下发的区域（实测 `CN`）。⚠️ 与登录时选的区域是**两回事**。 */
  routeRegion: string
  /** 会员等级（实测 `freeMember`）。 */
  userLevel: string
  /** 脱敏手机号（实测 `+86 186****6665`）。未绑定手机时上游为 `null`。 */
  maskedMobile: string
  /**
   * ★★★ **当前所在空间的团队**（issue #177，2026-11-27）。
   *
   * ## 这个字段一直就在响应里，只是本仓从来没解析过
   *
   * 用户报告「团队订阅 0 / 8000 积分，插件只看到 520」——根因是他**处于团队空间**，
   * 而本仓所有 accio 请求都**不带 `x-team-id`** ⇒ 上游按「默认/个人空间」返回额度。
   *
   * 证据链（issue #177 作者逆向 `app.asar` + 本机实测）：
   * - 官方客户端 `yo()` 统一注入 `x-team-id`（值来自 `po()` = 当前 teamId）与
   *   `x-accio-route-region`（来自 `go()`），并由 `addRequestInterceptor` 合并进**所有**出站请求；
   * - 官方 `activeTeam: {teamId, teamName, role} | null`；
   * - ⚠️ **本机 `%APPDATA%\Accio\remembered-accounts.json` 的 `auth` 对象里就有 `activeTeam`**
   *   —— 而那个 `auth` 正是 `POST /api/auth/userinfo` 的返回 ⇒ **证明该端点确实下发它**。
   *
   * ⇒ `null` = 个人空间（本项目实测如此）；有值 = 团队空间，**必须**在请求里带上 `teamId`。
   *
   * ## ⚠️⚠️ **实测更正（2026-11-27，issue #177 作者用团队账号实读）**
   *
   * 上面那句「有值 = 团队空间」是**官方 schema 的描述，不是实测结果**。实测是：
   *
   * > 「网页版团队空间下 `activeTeam` **仍是 `null`**」
   * > 「插件侧 `phoenix-gw/api/auth/userinfo` 基线 / `+x-team-id` / `+sgcookie+region`
   * >  三种请求形态，**三个响应逐字相同，全是 `null`**」
   * > 「字段清单里没有 space / tenantId / orgId / spaceType / teams / teamId」
   *
   * ⇒ **`activeTeam` 是「账号快照字段」，团队账号下也可能是 `null`。**
   *   **本仓解析它不会拿到 `teamId`** —— 保留解析只为「上游哪天真的下发了」时不丢信息，
   *   **不要**指望它解决团队额度问题。
   *
   * **团队额度的真实形态**（同一条实测）：网页版（`www.accio-ai.com/gateway` + **cookie 会话**）
   * 在团队空间下**直接**返回 `TEAM/8000`，而插件走的
   * `phoenix-gw.alibaba.com` + **query token** 恒返回 `FREE/520` ——
   * ⇒ 这是**链路差异**，不是「切空间」差异。**改请求头解决不了。**
   */
  activeTeam?: { teamId: string, teamName?: string, role?: string } | null
}

/** 一类积分桶（`flattenAccioCredits` 的一行）。 */
export interface AccioCreditRow {
  /** 展示名（`每日积分` / `每月积分` / `推荐积分`）。 */
  label: string
  total: number
  used: number
  remaining: number
}

/** 配额读数（`GET /api/entitlement/quota`）。 */
export interface AccioQuota {
  /** 已用百分比。 */
  usagePercent?: number
  /** 距下一次刷新（每日额度重置）的秒数，实测 `86400`。 */
  refreshCountdownSeconds?: number
}

/** 三个查询函数的公共可选参数。 */
export interface AccioCreditsOptions {
  /** 注入的 fetch（单测替身 / 代理）。省略时用全局 `fetch`。 */
  fetcher?: typeof fetch
}

/** 积分单位。量纲是**积分**（不是 token，与 zcode 不同）。 */
const ACCIO_CREDIT_UNIT = 'credit'

/**
 * 三类桶的**固定顺序**与展示名。
 *
 * ⚠️ 顺序固定（daily → monthly → referral）而不是按响应键序：键序由服务端决定，
 * 同一账号两次读数的排列可能不同，面板会「跳行」。
 *
 * ⚠️ **`每日积分` 是测试逐字锁定的**（brief 的 `rows[0]` 断言）；`每月积分` /
 * `推荐积分` 是展示名选择 —— 上游只下发英文键 `monthly` / `referral`，
 * 未实测其中文名，故按与 `每日积分` 同构的构词法取（改这两个不会打破任何实测事实，
 * 但要一起改本表与客户端面板的用词）。
 */
const ACCIO_CREDIT_BUCKETS: readonly { key: string; label: string }[] = Object.freeze([
  { key: 'daily', label: '每日积分' },
  { key: 'monthly', label: '每月积分' },
  { key: 'referral', label: '推荐积分' },
])

/**
 * 「未登录」文案。
 *
 * ⚠️ 必须同时含「未登录」与 `NOT_LOGIN` 两个词：前者给用户看，后者是服务端原文，
 * 排查时可以直接对上日志。**不要**把它与「查询失败」合并成一句话
 * （两者要用户做的事完全不同）。
 */
const ACCIO_NOT_LOGIN_BASE = '未登录或登录已过期（NOT_LOGIN），请重新登录 Accio 账号'

/**
 * 已登记的上游 `userLevel` → 面板短标签。
 *
 * ⚠️ **只登记实测过的 `freeMember`**：未登记的值在
 * {@link accioAccountTierExtra} 里**原样展示**，不猜 —— 猜错会把 Free 显示成 Pro，
 * 而用户是按这个标签决定要不要充值的（与客户端 `quotaWindowLabel` 的
 * 「未识别原样显示」同一条纪律）。
 */
const ACCIO_TIER_LABELS: ReadonlyMap<string, string> = new Map([
  ['freemember', 'Free'],
])

/** 一次请求拆出的信封。 */
interface AccioEnvelope {
  httpStatus: number
  /** `success !== false` **且** HTTP 2xx **且** 拿到了 `data`。 */
  ok: boolean
  /** HTTP 401/403，或 body `code` 为 `401` / `NOT_LOGIN`。 */
  authFailed: boolean
  data?: Record<string, unknown>
  /** 给排查者的原文摘要（HTTP 状态 + `code` + `message`）。 */
  message: string
}

/** 桶行 + 它的键（内部用；对外经 `flattenAccioCredits` 剥掉键）。 */
interface AccioCreditBucketRow extends AccioCreditRow {
  key: string
}

/** 取 token；缺失时返回空串（**不伪装成有效**）。 */
function accioAccessToken(credential: AccioCredential): string {
  return typeof credential?.access_token === 'string' ? credential.access_token : ''
}

/** 读成普通对象；数组 / null / 标量一律视为「不是对象」。 */
function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * ★★★ **读 `activeTeam`**（issue #177，2026-11-27）。
 *
 * ## 三态，别压成两态
 *
 * | 响应 | 含义 | 返回 |
 * |---|---|---|
 * | 字段缺失 / `null` | **个人空间**（本项目实测这台机器就是如此）| `null` |
 * | `{teamId: "..."}` | **团队空间** ⇒ 所有请求必须带 `x-team-id` | `{teamId, …}` |
 * | 有对象但 `teamId` 不是非空串 | **畸形** | `null`（**降级到个人空间**，不编造 id）|
 *
 * ⚠️ **`teamId` 必须是非空字符串**才算团队：把 `''` 当成团队会把 `x-team-id: `
 * 发出去（空头值），比不发更糟 —— 上游可能据此判「无效团队」而不是回落到个人。
 *
 * ⚠️ 另外两个字段（`teamName` / `role`）只为**展示**，缺了不影响请求。
 */
function readAccioActiveTeam(source: Record<string, unknown>): AccioUserInfo['activeTeam'] {
  const raw = source.activeTeam
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const teamId = typeof record.teamId === 'string' ? record.teamId.trim() : ''
  if (teamId === '') return null
  const teamName = typeof record.teamName === 'string' && record.teamName !== '' ? record.teamName : undefined
  const role = typeof record.role === 'string' && record.role !== '' ? record.role : undefined
  return {
    teamId,
    ...(teamName === undefined ? {} : { teamName }),
    ...(role === undefined ? {} : { role }),
  }
}
/** 读成字符串；非字符串返回空串。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 读成**标量字符串**：字符串或数字都接受，其余（对象 / 数组 / 布尔 / `null`）返回空串。
 *
 * ⚠️⚠️ 为什么 `code` / `message` / `error` 必须走这个而**不是** {@link readString}：
 * 官方客户端 bundle 把同一条判据写成
 * `n = e.code == null ? '' : String(e.code); return n === '401' || n === 'NOT_LOGIN'`
 * —— 那句**显式**的 `String()` 说明设计者预期 `code` **可能不是字符串**。
 * 实测形态虽为 `code:'401'`（字符串），但只要上游某天发 `code: 401`（数字），
 * `readString` 会把它读成空串 ⇒ `authFailed` 为 false ⇒ 结果落进通用分支、
 * 报成「积分查询失败」，而真相是「未登录」—— 这正是本文件开头禁止的
 * **方向性误诊**（用户会去查网络，而该做的是重新登录）。
 *
 * ⚠️ **只给「标量语义」的字段用**：`code` / `message` / `error` 都是「服务端想说什么」
 * 的信封字段，上游用字符串或数字表达同一件事。真正的字符串字段（`userId` 等）
 * 仍走 {@link readString} —— 不静默放宽无关的读取器。
 *
 * ⚠️ 顺带 `trim()`：`' 401'` / `'NOT_LOGIN\n'` 这类带空白的下发同样要能对上判据，
 * 且拼进错误摘要时不该带首尾空白。
 */
function readScalarString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 读成有限数字；读不到返回 `undefined`（**不编造 0**）。
 *
 * ⚠️ 接受**数字字符串**：上游把额度下发成字符串是有先例的
 * （`docs/agent-notes/providers-zcode.md` 的「额度下发成字符串时判 0 ⇒ 锁死账号」）。
 * ⚠️ 但 `''` / `null` / `undefined` / 非数字串一律返回 `undefined` ——
 * 它们**不是** 0，把它们读成 0 就是「查不到判死」。
 * ⚠️ 真的 `0`（数字 0 或字符串 `'0'`）**照实返回 0**：0 是合法读数，
 * 调用方必须能区分「0」与「读不到」。
 */
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 拆信封。
 *
 * `ok` 的判据是 `success !== false`（而不是 `success === true`）：实测响应都带
 * `success:true`，但把判据写成「必须显式 true」会让上游某天省掉该字段时**整个余额
 * 消失**；而 `success:false` 是明确的失败，必须挡住。两侧都照实。
 */
function parseAccioEnvelope(parsed: unknown, httpStatus: number, text: string): AccioEnvelope {
  const statusOk = httpStatus >= 200 && httpStatus < 300
  const record = readRecord(parsed)
  if (record === undefined) {
    // 非 JSON 响应（实测形态：网关故障页 / 纯文本）。原文截断保留，供排查。
    return {
      httpStatus,
      ok: false,
      authFailed: httpStatus === 401 || httpStatus === 403,
      message: `HTTP ${httpStatus} ${text.slice(0, 200)}`.trim(),
    }
  }

  // ⚠️ `code` / `message` / `error` 走**标量**读取（字符串或数字）：上游可能把
  //    `code` 下发成数字 `401`，用只认字符串的读取器会把它读成空串 ⇒ 误判成
  //    「查询失败」而不是「未登录」。见 readScalarString 的注释。
  const code = readScalarString(record, 'code')
  // ⚠️ 服务端原文有两种信封形态：`{code, message}` 与 `{error}`（实测都出现）。
  //    只读 `message` 时后者会退化成只剩 `HTTP 200`，丢掉排查线索。
  const message = readScalarString(record, 'message') || readScalarString(record, 'error')
  const data = readRecord(record.data)
  const codeUpper = code.toUpperCase()
  const authFailed = httpStatus === 401
    || httpStatus === 403
    || codeUpper === '401'
    || codeUpper === 'NOT_LOGIN'
    || message.toUpperCase() === 'NOT_LOGIN'

  const summary = [
    httpStatus > 0 ? `HTTP ${httpStatus}` : '',
    code.length > 0 ? `code=${code}` : '',
    message,
  ].filter((part) => part.length > 0).join(' ')

  return {
    httpStatus,
    ok: statusOk && record.success !== false && data !== undefined,
    authFailed,
    data,
    message: summary.length > 0 ? summary : `HTTP ${httpStatus}`,
  }
}

/**
 * 发一次请求 —— **method 同时决定 token 的位置**（见文件头表格）。
 *
 * 本函数**不抛错**：余额查询属「尽力而为」，批量查多个账号时单个账号失败
 * 不应中断其余（与 `raccoon-credits.ts` 的 `requestJson` 同取舍）。
 */
async function callAccioEndpoint(options: {
  path: string
  method: 'GET' | 'POST'
  credential: AccioCredential
  fetcher: typeof fetch
}): Promise<AccioEnvelope> {
  const token = accioAccessToken(options.credential)
  const base = `${ACCIO.gatewayBaseUrl}${options.path}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  /**
   * ★★★ **团队身份**（issue #177，2026-11-27）。
   *
   * ⚠️ 这**不违反**本文件上方「只读端点不把推理端那些头顺手带过来」的纪律 ——
   *    那条纪律针对的是 `utdid` / `version` / `appKey` / `sgcookie`（实测不需要）。
   *    `x-team-id` 不同：**官方对「除 publicCatalog 外的所有出站请求」都注入它**，
   *    带着它才是「对齐官方」，不带才是「少发」。
   *
   * 证据：issue #177 作者逆向 `app.asar`（偏移 75632621 的 `yo()` + 75663647 的
   * `addRequestInterceptor`），并在本机 `%APPDATA%\Accio
emembered-accounts.json`
   * 的 `auth.activeTeam` 里找到同一份数据。
   *
   * ⚠️ 无值 ⇒ **不发这个头**（与官方拦截器「空值即删」的语义一致）；
   *    个人空间账号的行为因此与改动前**逐字节相同**。
   */
  const teamId = typeof options.credential.teamId === 'string' ? options.credential.teamId.trim() : ''
  if (teamId !== '') headers['x-team-id'] = teamId
  const routeRegion = typeof options.credential.routeRegion === 'string' ? options.credential.routeRegion.trim() : ''
  if (routeRegion !== '') headers['x-accio-route-region'] = routeRegion
  /**
   * ★ `x-package-region: GLOBAL`（issue #177 实测有效：国际站模型可见性）。
   * 与团队额度无关（那是服务端会话状态），但**这一条真能多出 9 个 GPT**。
   */
  // ★ 两个站都发（`cn` => `CN`）：官方 `aa()` 的归一化白名单就是 `CN|GLOBAL`。
  if (options.credential.region === 'global') headers['x-package-region'] = 'GLOBAL'
  else if (options.credential.region === 'cn') headers['x-package-region'] = 'CN'

  let url = base
  let body: string | undefined
  if (options.method === 'POST') {
    // ★ userinfo：token 在 **body**（放 query 会 400，放 Authorization 头也不是它的形状）
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify({ accessToken: token })
  } else {
    // ★ currentSubscription / quota：token 在 **query**（缺它会 400）
    url = `${base}?${new URLSearchParams({ accessToken: token }).toString()}`
  }

  const init: RequestInit = {
    method: options.method,
    headers,
    signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
    ...body === undefined ? {} : { body },
  }

  try {
    const response = await options.fetcher(url, init)
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      parsed = undefined
    }
    return parseAccioEnvelope(parsed, response.status, text)
  } catch (error) {
    return {
      httpStatus: 0,
      ok: false,
      authFailed: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 「未登录」错误文案；带上服务端原文（排查时唯一的线索）。 */
function accioNotLoginMessage(envelope: AccioEnvelope): string {
  return envelope.message.length > 0
    ? `${ACCIO_NOT_LOGIN_BASE}（服务端原文：${envelope.message}）`
    : ACCIO_NOT_LOGIN_BASE
}

/**
 * 把 `data.entitlement` 拍平成桶行（**带键**，供余额构造用）。
 *
 * 两条判据都刻意用「对象存在」而不是「值为真」：
 * - 桶对象存在 ⇒ **留下**（`remaining: 0` 也要留下 —— 用户要看到「还有 0」）；
 * - 桶对象缺席 ⇒ **不产出**（不是产出一条 0 行）。
 *
 * ⚠️ 桶存在但 `remaining` **读不到**时**跳过该桶**：那是「数据不足」，
 * 按 0 展示等于把「查不到」说成「已用光」（`providers-zcode.md` 的
 * 「查不到不得判死」）。`total` / `used` 读不到才退回 0 —— 那两项不是主读数，
 * 且偏小展示不会让用户误以为额度被清空。
 */
function accioCreditBuckets(subscription: unknown): AccioCreditBucketRow[] {
  const root = readRecord(subscription)
  if (root === undefined) return []
  const entitlement = readRecord(root.entitlement)
  if (entitlement === undefined) return []

  const rows: AccioCreditBucketRow[] = []
  for (const bucket of ACCIO_CREDIT_BUCKETS) {
    const value = readRecord(entitlement[bucket.key])
    if (value === undefined) continue
    const remaining = readNumber(value, 'remaining')
    if (remaining === undefined) continue
    rows.push({
      key: bucket.key,
      label: bucket.label,
      total: readNumber(value, 'total') ?? 0,
      used: readNumber(value, 'used') ?? 0,
      remaining,
    })
  }
  return rows
}

/**
 * 把订阅响应的 `data` 拍平成三类桶。
 *
 * @param subscription - `currentSubscription` 响应的 `data`（含 `entitlement`）。
 * @returns 每类**存在**的桶一行；缺席的桶不产出。`daily` 恒在首位。
 */
export function flattenAccioCredits(subscription: unknown): AccioCreditRow[] {
  return accioCreditBuckets(subscription).map((row) => ({
    label: row.label,
    total: row.total,
    used: row.used,
    remaining: row.remaining,
  }))
}

/**
 * 查询账号身份（`POST /api/auth/userinfo`）。
 *
 * @returns 失败（含未登录 / 结构不对 / 网络错）一律 `undefined` ——
 * 身份是**附加信息**，取不到不该让余额行变成错误。
 */
export async function fetchAccioUserInfo(
  credential: AccioCredential,
  options: AccioCreditsOptions = {},
): Promise<AccioUserInfo | undefined> {
  const fetcher = options.fetcher ?? fetch
  if (accioAccessToken(credential) === '') return undefined

  const envelope = await callAccioEndpoint({
    path: ACCIO_USERINFO_PATH,
    method: 'POST',
    credential,
    fetcher,
  })
  if (!envelope.ok || envelope.data === undefined) return undefined

  const data = envelope.data
  return {
    userId: readString(data, 'userId'),
    userName: readString(data, 'userName'),
    routeRegion: readString(data, 'routeRegion'),
    /**
     * ★ **必须解析**（issue #177）：少了它，团队空间的账号永远只看到个人额度。
     * ⚠️ 形状按官方 `activeTeam: {teamId, teamName, role} | null`；
     *    `null` 是**合法值**（个人空间），不能被当成「解析失败」。
     */
    activeTeam: readAccioActiveTeam(data),
    userLevel: readString(data, 'userLevel'),
    maskedMobile: readString(data, 'maskedMobile'),
  }
}

/**
 * 查询配额读数（`GET /api/entitlement/quota`）。
 *
 * ⚠️ `usagePercent` **不**进余额：它是百分比，塞进 `CreditBalance` 就是
 * 「把百分比假装成积分」（本仓库明确反对的形态，见 `credits-format.js` 的
 * `QUOTA_UNIT` 一节）。而订阅响应里的逐桶 `used` / `total` 已经是同一件事的
 * **更精确**读数，故本模块只用 `refreshCountdownSeconds`（见
 * {@link accioQuotaResetIso}），`usagePercent` 保留在返回值里供将来使用。
 */
export async function fetchAccioQuota(
  credential: AccioCredential,
  options: AccioCreditsOptions = {},
): Promise<AccioQuota | undefined> {
  const fetcher = options.fetcher ?? fetch
  if (accioAccessToken(credential) === '') return undefined

  const envelope = await callAccioEndpoint({
    path: ACCIO_QUOTA_PATH,
    method: 'GET',
    credential,
    fetcher,
  })
  if (!envelope.ok || envelope.data === undefined) return undefined

  const data = envelope.data
  const usagePercent = readNumber(data, 'usagePercent')
  const refreshCountdownSeconds = readNumber(data, 'refreshCountdownSeconds')
  return {
    ...usagePercent === undefined ? {} : { usagePercent },
    ...refreshCountdownSeconds === undefined ? {} : { refreshCountdownSeconds },
  }
}

/**
 * 每日额度的重置时刻（ISO 串），由 `refreshCountdownSeconds` 现算。
 *
 * ⚠️ 落点是 `CreditPackage.cycleEndTime`（字段本义就是「计量周期结束时间」），
 * 于是**既有**客户端代码（`jet-hub.js` 的 `本周期至 …`）无需改动就能显示它。
 * ⚠️ **不**写 `deductionEndTime`：那个字段的语义是「这批积分什么时候作废」，
 * 而 `refreshCountdownSeconds` 只说「额度何时刷新」—— 两者在 Accio 上未被实测为同一
 * 时刻，把推断值写进去就是编造（`CreditBalance` 的注释明确要求
 * 「`undefined` = 到期时间未知」，未知时**留空**才是如实的）。
 *
 * @returns 读不到倒计时（或缺席）时返回**空串**（调用方据此不显示该行）。
 */
function accioQuotaResetIso(quota: AccioQuota | undefined, nowMs: number = Date.now()): string {
  const seconds = quota?.refreshCountdownSeconds
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return ''
  return new Date(nowMs + seconds * 1000).toISOString()
}

/**
 * 账号等级 → `extra.accountTier`（面板「账号规格」那一行）。
 *
 * 形态与理由**照抄 gemini 的先例**（`src/provider-credits.ts` 的 gemini 分支）：
 * 档位搭余额这趟车回来，`label` 是短标签（面板只放得下一个词），
 * `title` 是上游原文（hover 才看得到）。取不到等级时 `extra` 缺席，
 * 面板**整行不渲染**（**不是错误** —— 它只是一栏附注信息）。
 *
 * ⚠️ 未登记的等级**原样展示**（见 {@link ACCIO_TIER_LABELS}）。
 *
 * ⚠️ 查表用 `Map` 而**不是**普通对象下标：`userLevel` 是**外部输入**，
 * 而 `obj['constructor']` 会命中原型链上的键 —— 那时 `label` 会变成一个**函数**，
 * 面板上就出现 `function Object() { [native code] }`。本仓库已把
 * 「查表用 `Object.hasOwn` / 导出助手，不要用下标」记为通用判据
 * （见 AGENTS.md 的注册表一节），`Map` 从根上免除这一类。
 */
function accioAccountTierExtra(userInfo: AccioUserInfo | undefined): RpcCreditsBalanceExtra | undefined {
  const level = userInfo?.userLevel ?? ''
  if (level === '') return undefined
  const label = ACCIO_TIER_LABELS.get(level.toLowerCase()) ?? level
  return { accountTier: { label, title: `Accio 账号等级（${level}）` } }
}

/** 造一个资源包（`active` 恒 true、周期字段留空 —— 上游没下发就**不臆造**）。 */
function makeAccioPackage(
  name: string,
  total: number,
  used: number,
  remaining: number,
  cycleEndTime: string,
): CreditPackage {
  return {
    name,
    unit: ACCIO_CREDIT_UNIT,
    remaining,
    total,
    used,
    active: true,
    cycleStartTime: '',
    cycleEndTime,
    expiredTime: '',
  }
}

/**
 * 聚合三个只读端点，返回**带原因**的余额。
 *
 * ```
 * fetchAccioBalanceDetailed(credential)
 *   ├─ GET  /api/entitlement/currentSubscription?accessToken=…   → 三类桶（**必需**）
 *   ├─ GET  /api/entitlement/quota?accessToken=…                 → 重置倒计时（失败可容忍）
 *   └─ POST /api/auth/userinfo  {accessToken}                    → 账号等级（失败可容忍）
 * ```
 *
 * ⚠️ **`currentSubscription` 必须第一个发**：它是「必需」的那一个，先发可以让
 * 未登录 / 网络故障**短路返回**，不再白发两个注定失败的请求。
 *
 * ⚠️ 三条失败路径都返回 `balance: null` + `error`，**没有一条会退化成 0**：
 * 1. 未登录（HTTP 401/403 或 body `code` 为 `401`/`NOT_LOGIN`）⇒ 提示重新登录；
 * 2. 一般查询失败（网络 / HTTP / 信封 `success:false`）⇒ 带 HTTP 状态与服务端原文
 *    （`message` 缺席时回退读 `error`）；
 * 3. 查询成功但**响应里既没有桶也没有总余额**（形状不认识）⇒ 明说「未包含余额字段」。
 *    ⚠️ 这条判据排在 `quota` / `userinfo` **之前**：形状不认识时那两个请求注定救不回来。
 *
 * 反之，**查到了就是查到了**：桶全为 0 时如实返回 `total: 0`（那才是「额度已用光」），
 * 与上面三条 `null` 严格区分。
 */
/**
 * ★★★ **团队额度（team space）本仓刻意不支持 —— 这是查证过的结论，不是 TODO**（issue #177，2026-11-27）
 *
 * ## 一句话
 *
 * **accIO 的团队额度只存在于「网页会话 cookie」那条链路上，而本仓是无头进程、只有 OAuth token。**
 *
 * ## 证据链（三条独立来源，全部实测）
 *
 * | 来源 | 事实 |
 * |---|---|
 * | 报障者用**团队账号**实读 | 网页版 `GET /gateway/subscription/current?teamId=<id>` ⇒ `{"type":"TEAM","total":8000,…}` |
 * | 同上，去掉 cookie 再试 | ① `Authorization: Bearer <token>` ⇒ **401 `login required`**；② `?accessToken=<token>` ⇒ **401 `login required`** |
 * | 同一枚 token 打本仓现在用的端点 | `phoenix-gw/api/entitlement/currentSubscription` ⇒ **200 `FREE/520`** |
 *
 * ⇒ **token 是有效的**（否则第二条会是 401 而不是 200）。**是 `/gateway/*` 这套链路只认 cookie。**
 *
 * ## ⚠️⚠️ 两条**已被证伪**的错路 —— 不要再试
 *
 * 1. **`x-team-id` 请求头**：官方客户端确实注入它（`app.asar` 偏移 75632621 的 `yo()`），
 *    但报障者实测「加 `x-team-id: <teamId>` ⇒ 响应**逐字不变**（仍 FREE/520）」。
 *    **空间是服务端会话态**（`POST /space/switch`），不是请求头。
 * 2. **`userinfo.activeTeam`**：官方 schema 里有 `{teamId,teamName,role}|null`，
 *    但**团队账号下实测仍是 `null`**；且 `phoenix-gw` 的 `userinfo` 在
 *    基线 / `+x-team-id` / `+sgcookie+region` **三种形态下响应逐字相同、全是 null**。
 *    字段清单里**没有** space / tenantId / orgId / spaceType / teams / teamId。
 *
 * ## 唯一可能的出路（未做，成本需另评估）
 *
 * 官方**桌面客户端**走 `localhost:4097` 本机网关 + **Basic Auth**，那套会话来自客户端登录态。
 * 要支持团队额度就得**复用本机 Accio 客户端的会话** ——
 * 这与本仓「纯 OAuth、无浏览器依赖」的架构**分叉**，需要单独决策，不是顺手能加的。
 *
 * ## 仍然**有效**的那条修复
 *
 * `x-package-region`（见 `accioHeaders`）：报障者真机确认「目录从 16 条 → **30 条**，
 * 含 GPT 6 Luna / GPT 5.6 Luna / Claude / Gemini」。**那条是会改 wire 的，与本函数无关。**
 */
export async function fetchAccioBalanceDetailed(
  credential: AccioCredential,
  options: AccioCreditsOptions = {},
): Promise<ProviderBalanceDetail> {
  const fetcher = options.fetcher ?? fetch

  // 本地就能判定的「未登录」：不拿空 token 去打一个必然 400 的请求
  // （那会让用户看到「查询失败」，而真相是「这个账号没有凭据」）。
  if (accioAccessToken(credential) === '') {
    return { balance: null, error: ACCIO_NOT_LOGIN_BASE }
  }

  // ① 必需端点：三类桶
  const subscription = await callAccioEndpoint({
    path: ACCIO_SUBSCRIPTION_PATH,
    method: 'GET',
    credential,
    fetcher,
  })
  if (subscription.authFailed) {
    return { balance: null, error: accioNotLoginMessage(subscription) }
  }
  if (!subscription.ok || subscription.data === undefined) {
    return { balance: null, error: `积分查询失败：${subscription.message}` }
  }

  const data = subscription.data
  const buckets = accioCreditBuckets(data)

  // ⚠️ 总余额优先取**服务端自己算的** `data.remaining`（各有效桶剩余之和），
  //    只有它缺席时才回退到逐桶求和 —— 让用户能与官方客户端核对同一个数。
  const topRemaining = readNumber(data, 'remaining')

  // ⚠️ 形状判据**必须排在下面两个可容忍请求之前**：响应「成功」但既没有桶、
  //    也没有总余额时，`quota` 与 `userinfo` **注定救不回来**（两者都不产出任何
  //    余额字段），先发就是白发两个请求（文件头承诺了这条短路）。
  //    判据只读上面已算好的 `buckets` / `topRemaining`，**不依赖**那两个请求的结果，
  //    故这是纯顺序调整、语义不变。
  if (buckets.length === 0 && topRemaining === undefined) {
    // 查询「成功」但形状不认识 ⇒ 仍然**不编造 0**（0 会被读成「额度已用光」）。
    return { balance: null, error: '积分查询失败：响应未包含余额字段' }
  }

  // ② ③ 可容忍端点：并行发，任一失败都不影响上面的桶
  const [quota, userInfo] = await Promise.all([
    fetchAccioQuota(credential, { fetcher }),
    fetchAccioUserInfo(credential, { fetcher }),
  ])

  const dailyResetAt = accioQuotaResetIso(quota)
  const packages: CreditPackage[] = buckets.map((bucket) => makeAccioPackage(
    bucket.label,
    roundCredits(bucket.total),
    roundCredits(bucket.used),
    roundCredits(bucket.remaining),
    // 只有 daily 知道周期何时结束（quota 的倒计时）；其余留空而不是复用它的值。
    bucket.key === 'daily' ? dailyResetAt : '',
  ))

  const total = roundCredits(
    topRemaining ?? buckets.reduce((sum, bucket) => sum + bucket.remaining, 0),
  )

  // 服务端给了总余额却没给任何桶（实测可能出现：`entitlement: {}`）时补一个包，
  // 否则 UI 拿到空列表、连总额都不显示（与 `raccoon-credits.ts` 同取舍）。
  if (packages.length === 0) {
    packages.push(makeAccioPackage('可用积分', total, 0, total, dailyResetAt))
  }

  const balance: CreditBalance = { total, packages, expiredTotal: 0 }
  const extra = accioAccountTierExtra(userInfo)
  return {
    balance,
    ...extra === undefined ? {} : { extra },
  }
}
