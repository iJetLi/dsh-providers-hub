/**
 * Magicrew（超级麦吉）**账号资料**：昵称 / 真实姓名 / 手机号。
 *
 * ## 为什么必须有这个模块（真机报障 2026-10-29）
 *
 * 账号卡片把「超级麦吉」当昵称显示，而用户自己的昵称是 `Nick`。原因不在渲染层：
 * `magicrewDisplayNickname` 只能看到凭据里的 `phone`，而**浏览器登录**那条腿落库的
 * 凭据里既没有 `phone` 也没有任何展示名 ⇒ 恒回落 `product.displayName`（=「超级麦吉」）。
 *
 * 昵称只在上游这一个端点里，所以登录时得**主动取一次**（见 `magicrew-auth.ts` 的
 * `withProfileNickname`）。
 *
 * ## 报文（用户真实凭据实测，2026-10-29）
 *
 * ```http
 * GET {host}/api/v1/contact/accounts/me/users
 * authorization: Bearer <jwt>
 * organization-code: <org>          ← ⚠️ **两个头都要**，缺一个读不到
 * ```
 *
 * ```json
 * { "code": 1000, "data": { "items": [
 *   { "nickname": "Jet", "real_name": "Jet", "phone": "…", "status": … }
 * ] } }
 * ```
 *
 * ⚠️⚠️ **`/api/v1/contact/accounts/me`（不带 `/users`）实测 404** —— 别用那个地址。
 *
 * ## ⚠️ 两种形状都要认（`data.items` 不保证是数组）
 *
 * 参考实现 magpie 的 `fetchWho`（`api.mjs:518-529`）写的是
 * `body?.data?.items ?? body?.data ?? {}` ⇒ 上游可能把**单个对象**直接放在 `items`，
 * 也可能把条目直接放在 `data`。三者都认，且**都不猜**：一个都取不到就抛。
 *
 * ## ⚠️ 取名字的优先级与 magpie 不同（刻意）
 *
 * magpie 的展示优先级是 `phone || email || nickname || real_name`（它要的是「人能认出的
 * 一串字符」）；本模块的产物是**卡片昵称的唯一来源**，故只保留「真实名字」这一路：
 * `nickname → real_name`，**不含 phone**（脱敏手机号由 `magicrewDisplayNickname`
 * 在**没有昵称时**兜底，两处合起来才等于 magpie 的那条链 —— 且它比 magpie 更克制：
 * 不会把一个 10 位本地号当昵称显示）。
 *
 * ⚠️ 上游的 `phone` 是**本地号码（实测 10 位）**，不是 11 位 ⇒ **不要**把它写进
 * `MagicrewCredential.phone`：那条字段的消费者是 `magicrewDisplayNickname` 的
 * 11 位脱敏判据（`/^\d{11}$/`），填进去只会得到一个错位的掩码串。
 */

import { MAGICREW_USER_AGENT, type MagicrewProduct } from './magicrew-product.js'

/** 账号资料端点（⚠️ **带 `/users`**；不带的那条实测 404）。 */
export const MAGICREW_PROFILE_PATH = '/api/v1/contact/accounts/me/users'

/** 一个账号的资料。三个字段都归一成字符串（缺失 = 空串，不编造）。 */
export interface MagicrewProfile {
  /** 展示昵称（`nickname`，缺失时回落 `real_name`）。 */
  readonly nickname: string
  /** `real_name`（上游可能不返回 ⇒ 空串）。 */
  readonly realName: string
  /** 上游本地号码（**10 位**，仅展示参考；本插件不写进凭据）。 */
  readonly phone: string
}

/** 上游业务码：`1000` = ok，其余都是错误。 */
const MAGICREW_OK_CODE = 1000

/**
 * 上游 UA 来自 {@link MAGICREW_USER_AGENT}（单一定义处）。
 *
 * ⚠️ **不要在这里恢复一份字面量**（issue IKTPRV）：账号资料 GET 与其余四腿打同一个
 * `product.host`，漏改的症状是「昵称恒回落 displayName」这类静默降级。
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 读本账号的资料。**拿不到 ⇒ 抛**（不静默降级成「没有昵称」）。
 *
 * ⚠️ 失败语义刻意是**抛**（`magicrew-credits.ts` 的两处取数是「返回 undefined / 空对象」）：
 * 那个契约属于「不该挡住列表」的**展示**取数；这里是**登录**路径上的一次主动取数，
 * 调用方（`MagicrewAuth.withProfileNickname`）必须能区分「上游说没有昵称」与
 * 「我们根本没读到」—— 后者要留痕（本仓库已记过「静默停摆、功能上线起一次都没成功过」
 * 的教训），前者只该安静回落。
 */
export async function fetchMagicrewProfile(params: {
  jwt: string
  organizationCode: string
  product: MagicrewProduct
  fetchImpl?: typeof fetch
}): Promise<MagicrewProfile> {
  const { product } = params
  const fetchImpl = params.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    authorization: `Bearer ${params.jwt}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': MAGICREW_USER_AGENT,
    origin: product.webOrigin,
    // ⚠️⚠️ `referer` 缺了**恒 403 空 body**（2026-11-04 真机二分实测：同一套头只差
    //    这一条，本端点 403 ⇄ 200）。这正是「昵称恒回落 displayName」的真因。
    referer: `${product.webOrigin}/`,
  }
  // ⚠️ 两个头**都要**：`organization-code` 有值时必须带（实测缺了读不到本账号资料）。
  if (params.organizationCode.length > 0) headers['organization-code'] = params.organizationCode
  const response = await fetchImpl(`${product.host}${MAGICREW_PROFILE_PATH}`, {
    // ⚠️ 超时必须有（与两个姐妹模块同款）：零超时会让登录卡到 undici 默认 ~300s。
    //    这里的 6 秒小超时由调用方**换 `product.requestTimeoutMs`** 兑现
    //    （见 `MagicrewAuth.MAGICREW_PROFILE_TIMEOUT_MS` 的注释）。
    signal: AbortSignal.timeout(product.requestTimeoutMs),
    headers,
  })
  /**
   * ⚠️ 顺序：**先判 HTTP 状态、再解 JSON**（与 `magicrew-auth.ts` 的 `magicrewCall` 相反，
   * 那里是为了让 `200 + code:403` 走到业务码那条腿）。
   *
   * 这里刻意反过来的理由：本端点至少有一个**真实可达的 404**（那条不带 `/users` 的
   * 路径就在同一命名空间下），而 404 的响应体是 HTML/纯文本 ⇒ 先解 JSON 会把
   * 「地址写错了」报成「返回的不是 JSON」，把唯一的线索（状态码）抹掉。
   * 业务码那条腿不受影响：`200 + code:403` 时 `response.ok` 仍为真。
   */
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text)
  } catch {
    throw new Error(`返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  // ⚠️ `JSON.parse('null')` 是合法 JSON，`null` 上取 `.code` 会抛 `TypeError`
  //    （同型守卫见 `magicrew-auth.ts` 的 `magicrewCall`）。
  if (!isObject(parsed)) {
    throw new Error(`返回的不是对象（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  const envelope = parsed as { code?: unknown, message?: unknown, data?: unknown }
  const code = typeof envelope.code === 'number' ? envelope.code : undefined
  if (code !== undefined && code !== MAGICREW_OK_CODE) {
    // 优先用上游原文（`token无效` / `无权限` 这类文案本身就是出路）。
    const message = typeof envelope.message === 'string' ? envelope.message : `code ${code}`
    throw new Error(message)
  }
  const data = envelope.data
  const rawItems = isObject(data) ? data.items : undefined
  const rows: unknown[] = Array.isArray(rawItems)
    ? rawItems
    : isObject(rawItems)
      // ⚠️ 单个对象（magpie 的 `?? body?.data ?? {}` 覆盖的就是这一格）。
      ? [rawItems]
      // ⚠️ `items` 整个缺失时把 `data` 自己当条目（有些端点直接把对象放在 data）。
      : isObject(data) ? [data] : []
  const item = rows.find(isObject)
  if (item === undefined) {
    throw new Error(`账号资料为空（上游没有返回任何条目）：${text.slice(0, 200)}`)
  }
  const nickname = readString(item, 'nickname') ?? readString(item, 'real_name')
  const realName = readString(item, 'real_name') ?? ''
  const phone = readString(item, 'phone') ?? ''
  if (nickname === undefined && realName.length === 0 && phone.length === 0) {
    // 条目在、但三个字段一个都没有 ⇒ 这仍然是「没拿到资料」，如实抛出（不返回空串
    // 假装成功 —— 那样调用方就分不出「上游没有昵称」与「端点形状变了」）。
    throw new Error(`账号资料里没有任何可用字段（nickname/real_name/phone）：${text.slice(0, 200)}`)
  }
  return {
    nickname: nickname ?? '',
    realName,
    phone,
  }
}
