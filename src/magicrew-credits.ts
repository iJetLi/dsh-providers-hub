/**
 * Magicrew 的积分余额与**聚合临期折算**。
 *
 * ## 报文（实测 2026-10-28）
 *
 * ```json
 * GET /api/v1/quota/points/total → { code: 1000, data: {
 *   total_points: 1093,
 *   expiring_quota_details: [{ quota_id, expires_at: "2026-11-27 13:47:42", remaining_points: 93 }]
 * }}
 * ```
 *
 * ## ⚠️ `expires_at` **无时区** ⇒ 按 UTC+8 解释
 *
 * 上游给的是 `2026-11-27 13:47:42`（不带偏移）。按北京时间解析的依据：
 * magpie 侧用的就是 UTC+8（`beijingDay`），且其「每日积分北京时间 23:59 到期」
 * 已实跑吻合。⚠️ 若上游将来改按 UTC 存，折算会**差 8 小时**（早或晚到期）。
 *
 * ## ⚠️ 倍率口径：`input_points ÷ 2000`
 *
 * 逐个核对：`deepseek-v4.1-flash` 0.10×2000=**200** ↔ 实测 200；
 * `qwen3.5-flash` 0.01×2000=**20**；`qwen3.8-max` 0.60×2000=**1200**。
 */

import {
  MAGICREW,
  MAGICREW_MODEL_POINTS_PATH,
  MAGICREW_POINTS_PATH,
  type MagicrewProduct,
} from './magicrew-product.js'
// ⚠️ 两个哨兵**定义在 `aggregate-core.ts`**（`NEVER = Number.POSITIVE_INFINITY`、
//    `UNUSABLE = -1`），不在 `provider-expiry.ts` —— 后者只是消费它们。
import { NEVER, UNUSABLE } from './aggregate-core.js'
import { magicrewDecimalOf, magicrewSignedDecimalOf } from './magicrew-number.js'
import type { CreditBalance, CreditPackage } from './credits.js'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** 每「1×」倍率对应多少积分（magpie 侧实测口径）。 */
const MAGICREW_RATE_BASE = 2000

/** 北京时间相对 UTC 的偏移（毫秒）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Magicrew 业务 API 的请求头 —— **全仓唯一一份**。
 *
 * ⚠️ 导出（2026-11-01）：签到（`magicrew-checkin.ts`）与积分走同一个 Go 服务、
 * 同一套网关校验。此前 `magicrew-auth.ts` 与本文各有一份私有实现
 *（`magicrewHeaders` / `headersOf`），形状已经**几乎**一样但 UA 取值不同 ——
 * 再复制第三份就是「一份语义三处实现」。签到侧复用本函数。
 *
 * ⚠️ `origin` 必带：网关会看 Origin，缺了偶发 403。
 * ⚠️ `organization-code` 只在非空时附 —— 国际站缺了会被上游拒绝，所以**调用方**
 * 必须保证 `organizationCode` 真的取到了（不是这里补空串）。
 *
 * ⚠️ **形态以实测为准，别抄「HTTP 500 + 裸文本」**（2026-11-01 二审纠错）：那是
 * **聊天网关**（`/v1/*`）的旧观察且至今未定（见 `magicrew-product.ts` 的
 * `needsOrgOnGateway` 说明）；**业务 API**（本文件与签到共用的 Go 服务）缺组织码时
 * 回的是 `{"code":2182,"message":"用户所在组织不存在"}` —— 见
 * `src/magicrew-checkin.ts` 的实测记录，两处不得写成同一种形态。
 */
export function magicrewApiHeaders(params: {
  jwt: string
  organizationCode: string
  product: MagicrewProduct
}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${params.jwt}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
    origin: params.product.webOrigin,
  }
  if (params.organizationCode.length > 0) headers['organization-code'] = params.organizationCode
  return headers
}

/**
 * 解析 `2026-11-27 13:47:42`（**无时区**）为毫秒时间戳，按 UTC+8 解释。
 *
 * 解析不出来返回 `undefined`（**不编造**）。
 */
export function magicrewParseExpiresAt(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second] = match
  const utcMs = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  )
  if (!Number.isFinite(utcMs)) return undefined
  /**
   * ⚠️⚠️ **必须回读校验**（2026-11-01 二审实测的真缺陷）：`Date.UTC` 对越界分量是
   * **静默归一化**，不是 `NaN` —— `Date.UTC(2026, 12, 45, 25, 99, 99)` 会被算成 2027-02-15，
   * 于是 `"2026-13-45 25:99:99"` 这种**明显非法的日期**被当成真实到期时刻：前端落「长期」、
   * 后端落「永久」，**没有任何告警**。
   * 本函数契约是「解析不出来返回 `undefined`，绝不编造」，所以把归一化后的六个分量读回来
   * 逐个比对；任何一个变了就说明输入越界 ⇒ `undefined`。真实上游只给合法值 ⇒ 回读恒等，
   * 无行为变化。
   */
  const back = new Date(utcMs)
  if (
    back.getUTCFullYear() !== Number(year)
    || back.getUTCMonth() !== Number(month) - 1
    || back.getUTCDate() !== Number(day)
    || back.getUTCHours() !== Number(hour)
    || back.getUTCMinutes() !== Number(minute)
    || back.getUTCSeconds() !== Number(second)
  ) return undefined
  return utcMs - BEIJING_OFFSET_MS
}

export async function fetchMagicrewBalance(params: {
  jwt: string
  organizationCode: string
  product?: MagicrewProduct
  fetchImpl?: typeof fetch
}): Promise<CreditBalance | undefined> {
  const product = params.product ?? MAGICREW
  const fetchImpl = params.fetchImpl ?? fetch
  const response = await fetchImpl(`${product.host}${MAGICREW_POINTS_PATH}`, {
    // ⚠️ 超时（2026-10-29 最终审查 I5）：其余每家 `*-credits.ts` 都有；零超时会让积分面板
    //    转圈到 undici 默认 ~300s（本家 `requestTimeoutMs` 是业务 API 口径）。
    signal: AbortSignal.timeout(product.requestTimeoutMs),
    headers: magicrewApiHeaders({ jwt: params.jwt, organizationCode: params.organizationCode, product }),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  // ⚠️ `JSON.parse('null') === null` ⇒ **信封本身**可能是 `null`，直接读 `.code`
  //    会抛 `TypeError: Cannot read properties of null`（2026-10-29 实测）。
  //    契约是「取数失败 ⇒ `undefined`」（调用方 `magicrewExpiry` 据它判 `UNUSABLE`），
  //    抛出去会变成「折算整轮 reject」，与「取数失败」不同形。
  //    同型守卫见 `src/credits.ts:526-529`。
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const envelope = parsed as { code?: unknown, data?: Record<string, unknown> }
  if (typeof envelope.code === 'number' && envelope.code !== 1000) return undefined
  const data = envelope.data ?? {}
  /**
   * ⚠️ **`total_points` 必须容错解析，不能要求 `typeof === 'number'`**（2026-11-01 二审）：
   * 上游把它改成字符串 `"2661"` 时，旧判据直接 `return undefined` ⇒ 面板「查询失败」、
   * 锁定态选号判 `none` ⇒ **两家 provider 的积分与选号同时全死**，且与「凭据失效」同形。
   * ⚠️ 用 `magicrewSignedDecimalOf`（**允许负数**）而**不是** `magicrewDecimalOf`：
   * 上游实测过 `total_points: -31`（欠费），拒绝负数会让整条余额消失。
   */
  const total = magicrewSignedDecimalOf(data.total_points)
  if (total === undefined) return undefined
  const rawBatches = Array.isArray(data.expiring_quota_details) ? data.expiring_quota_details : []
  const packages: CreditPackage[] = []
  for (const raw of rawBatches) {
    if (typeof raw !== 'object' || raw === null) continue
    const batch = raw as Record<string, unknown>
    // ⚠️ **必须容错解析**（2026-11-01 二审实测）：上游把 `remaining_points` 写成字符串
    //    `"50"`（最常见的类型漂移）时，旧的 `typeof === 'number'` 判据会**静默丢弃该批次**，
    //    差额由 `total − Σ批次` 的残差吸收 ⇒ **临期积分被误标成永久积分** ⇒ 锁定永久积分时
    //    误拒这个账号（方向恰好反了：它能用的积分被当成不能用的）。
    //    非负/非法值仍归 0（随后 `<= 0 ⇒ continue`），语义不变。
    const remaining = magicrewDecimalOf(batch.remaining_points) ?? 0
    if (remaining <= 0) continue
    const expiresAt = typeof batch.expires_at === 'string'
      ? magicrewParseExpiresAt(batch.expires_at)
      : undefined
    packages.push({
      name: '限时积分',
      unit: '积分',
      remaining,
      total: remaining,
      used: 0,
      // ⚠️ 上游是否只回「还没过期」的批次**未取证**；有效性与否由 `magicrewExpiry`
      //    按 `expiresAt > now` 判（本字段只是展示用的快照，不是判据）。
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
      ...(expiresAt === undefined ? {} : { deductionEndTime: expiresAt }),
    })
  }
  /**
   * ⚠️ **合成「永久积分」包**（I3，2026-10-29 引入；2026-11-01 取证后**改名**）。
   *
   * ## 取证：残差就是「上游不给到期时间」的那部分
   *
   * 2026-11-01 对两站真实账号各做一次**只读**探测（`GET /api/v1/quota/points/total`）：
   *
   * | 站 | `total_points` | `expiring_quota_details` | 残差 |
   * |---|---|---|---|
   * | 国内 | 2661 | 11 条、合计 1661（最远 `2027-11-03 23:02:08`） | **1000** |
   * | 国际 | 347 | 2 条、合计 247（最远 `2027-11-03 23:45:12`） | **100** |
   *
   * 两条结论（**都推翻了旧注释**）：
   *
   * 1. 旧注释写「上游只下发**临期**批次」**不准确** —— 批次里含 2027 年的**远期**
   *    批次 ⇒ `expiring_quota_details` 的真实语义是「**所有带到期时间的批次**」。
   * 2. 残差`total_points − Σ批次remaining` 在两站都是**正整数**（1000 / 100），
   *    而它没有任何到期时刻 ⇒ 这才是上游**不下发到期时间**的积分
   *（注册奖励 / 活动赠送 / 后台充值），也就是用户口径里的**永久积分**。
   *
   * ## 为什么原名「长期积分」是**命名错误**（不只是措辞问题）
   *
   * 前端的判据（`plugin-src/client/credit-expiry.js` 的 `splitCreditsByExpiry`）是
   * 「**有没有 `deductionEndTime`**」：没有 ⇒ 落 `permanent`（绿）、超窗口 ⇒
   * `longTerm`（黄）、窗口内 ⇒ `expiring`（红）。
   * ⇒ 这个包**没有** `deductionEndTime`，落的是 **permanent** 桶，名字却叫「长期」
   *（longTerm）—— 名字与落桶自相矛盾，用户会去找一个并不存在的「长期」分组。
   *
   * 不合成的话：账号卡片的 hover 列包只列批次、合计对不上 `total_points`
   * ⇒ 用户以为丢了积分。合成后 `sum(remaining) === total`。
   *
   * ⚠️⚠️ **刻意不给 `deductionEndTime`**（两条腿都不能动）：
   * · 少了它 ⇒ `magicrewExpiry` 的 `expiresAt === undefined ⇒ 跳过` 那条腿跳过，
   *   「只有永久积分」的号仍得 `NEVER`（排最后但不剔除）；
   * · **编一个远期值** ⇒ 它会落进 `longTerm`（黄）并让 `splitBuddyCreditsByExpiry`
   *   把它算进「可烧」的永久桶 —— 而锁定永久积分保护的正是它。
   */
  /**
   * ⚠️⚠️ **守恒裁剪**（2026-11-01 二审 P2-2）：上游可能下发「批次合计 > `total_points`」
   * 的自相矛盾报文（行为红队构造实测：`total 100` + 批次 `200 + 50`）。
   *
   * `total_points` 是**权威余额** —— 面板合计、`magicrewExpiry` 的 `total > 0` 判据都以它
   * 为准；`expiring_quota_details` 只是「其中这部分会过期」的细分。两者冲突时以 total 为准，
   * 按**到期时间从早到晚**保留、用满 total 为止。
   *
   * ⚠️ 顺序**不能反**：必须**临期优先保留**（先到期先消耗）。反过来先保留远期，会让
   * 被裁掉的那笔变成「少显示的临期积分」—— 用户以为它还能用，而锁定态选号也会据此
   * 误判（临期没了 ⇒ 判 `exhausted`/`locked`，方向恰好反了）。
   *
   * 不裁的后果：三档合计 **大于** 账户实际余额（实测 350 vs 100），用户无法判断哪个是真的。
   */
  const rawListed = packages.reduce((sum, item) => sum + item.remaining, 0)
  /**
   * ⚠️⚠️ **`total <= 0` 时不做裁剪**（2026-11-02，PR #168 对抗审计 B5 实测）。
   *
   * 上游可以回**负数** `total_points`（欠费，实测 −31）。旧写法 `budget = total`
   * ⇒ 循环首轮就 `budget <= 0` ⇒ **break** ⇒ 它的正批次被**整条丢弃**、
   * `packages = []` ⇒ 面板只剩「积分 -31」（无包、三档行不渲染），
   * 而同一份报文里其实给了可用批次。
   *
   * 语义上「欠费」与「批次额度」是两件事：`total` 是净额、批次是各项余额。
   * 报文自相矛盾时**如实两样都显示**（合计 −31 + 批次明细），比把明细删掉
   * 让用户以为「什么都没有」更可诊断。
   */
  const trimBudget = Math.max(0, total)
  // ⚠️ 只在 total >= 0 时裁剪：total < 0 是「欠费净额」，与批次是两件事（见上）。
  if (total >= 0 && rawListed > trimBudget) {
    const byExpiry = [...packages].sort(
      (a, b) => (a.deductionEndTime ?? Number.POSITIVE_INFINITY) - (b.deductionEndTime ?? Number.POSITIVE_INFINITY),
    )
    packages.length = 0
    let budget = trimBudget
    for (const item of byExpiry) {
      if (budget <= 0) break
      const keep = Math.min(item.remaining, budget)
      packages.push(keep === item.remaining ? item : { ...item, remaining: keep, total: keep })
      budget -= keep
    }
  }
  const listedRemaining = packages.reduce((sum, item) => sum + item.remaining, 0)
  const permanentRemaining = total - listedRemaining
  if (permanentRemaining > 0) {
    packages.push({
      name: '永久积分',
      unit: '积分',
      remaining: permanentRemaining,
      total: permanentRemaining,
      used: 0,
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
    })
  }
  // ⚠️ `expiredTotal` = 0：上游**不下发**失效额度（既无 frozen 字段、也不回已失效桶），
  //    如实为 0 并在此注明「**不是**算出来的 0」（口径同 `src/astudio-credits.ts:166-167`）。
  return { total, packages, expiredTotal: 0 }
}

/**
 * `input_points` 的「**已知**」判据 —— 倍率与免费标记**共用这一处**（不写第二份）。
 *
 * ⚠️ 入参是 `unknown`，强转有洞：`Number([]) === 0`、`Number(true) === 1`、
 * `Number(null) === 0` ⇒ 原本会把 `[]` 判成「0 积分 = 免费」、把 `true` 判成
 * 0.0005 倍率。故只放行 **`number`** 与 **十进制数字字符串**，其余一律「未知」。
 *
 * ⚠️⚠️ **判据已抽到 `magicrew-number.ts`**（2026-11-01 三审）：本文件此前自带一份
 * 同名实现、**没有**「只认十进制」的约束，于是 `input_points: "0x10"` 在这里被
 * 当成 **16**（倍率 0.008），而签到侧的同名字段被当成 **0** —— 同一个上游字段
 * 在两个模块解释不同。现在统一走 `magicrewDecimalOf`（契约同为 `number | undefined`）。
 */
function magicrewPointsOf(entry: { input_points?: unknown }): number | undefined {
  return magicrewDecimalOf(entry.input_points)
}

/** 从计费条目算倍率；缺价格返回 `undefined`（**不猜**）。 */
export function magicrewRateOf(entry: { input_points?: unknown }): number | undefined {
  const points = magicrewPointsOf(entry)
  return points === undefined ? undefined : points / MAGICREW_RATE_BASE
}

/**
 * 该模型是否**免费**：厂商**已知**声明 `input_points === 0`。
 *
 * ⚠️ 不得用 `magicrewRateOf(entry) === 0` 反推：那是「值恰好为 0」，而这里要的是
 * 「**已知且**为 0」。一旦哪天有人把「未知」压成 0（或上游补了个 0 占位），
 * `rate === 0` 就会把**没有价格的模型全判成免费**。故判据与倍率共用
 * {@link magicrewPointsOf}（同一套「已知」），先判已知、再判值。
 */
export function magicrewIsFree(entry: { input_points?: unknown }): boolean {
  return magicrewPointsOf(entry) === 0
}

/**
 * 拉每个模型的计费（用于「免费 / 倍率」标记）。失败返回空对象（不挡列表）。
 *
 * ## ⚠️ 以下形状**未取证**
 *
 * `POST { model_ids: [...] }` 在本仓**只此一处**，没有任何材料取证过这个请求体
 * 与它换回的响应；设计规格 §1.7 的**唯一实发报文是单对象**：
 *
 * ```json
 * { "model_id": "deepseek-v4.1-flash", "billing_type": "TextTokens",
 *   "input_points": 200, "output_points": 800 }
 * ```
 *
 * ⇒ 故这里同时兼容**对象与数组**两种（数组 = 既有假设，对象 = §1.7 实测形状）。
 * 若上游确认为其一，请收紧并补真机取证。
 */
export async function fetchMagicrewModelPoints(params: {
  jwt: string
  organizationCode: string
  modelIds: readonly string[]
  product?: MagicrewProduct
  fetchImpl?: typeof fetch
}): Promise<Record<string, { inputPoints?: number, outputPoints?: number }>> {
  const product = params.product ?? MAGICREW
  const fetchImpl = params.fetchImpl ?? fetch
  const response = await fetchImpl(`${product.host}${MAGICREW_MODEL_POINTS_PATH}`, {
    // ⚠️ 超时（I5）：同上一处。
    signal: AbortSignal.timeout(product.requestTimeoutMs),
    method: 'POST',
    headers: magicrewApiHeaders({ jwt: params.jwt, organizationCode: params.organizationCode, product }),
    body: JSON.stringify({ model_ids: [...params.modelIds] }),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  // ⚠️ 同 `fetchMagicrewBalance`：`JSON.parse('null') === null` ⇒ 直接读 `.code`
  //    会抛 `TypeError`。本函数的失败语义是「返回空对象（不挡列表）」，故这里 `{}`。
  if (typeof parsed !== 'object' || parsed === null) return {}
  const envelope = parsed as { code?: unknown, data?: unknown }
  if (typeof envelope.code === 'number' && envelope.code !== 1000) return {}
  // ⚠️ 两种形状都认（见函数注释）：数组照遍历；**单个对象**当「一个元素的数组」。
  const rows: unknown[] = Array.isArray(envelope.data)
    ? envelope.data
    : typeof envelope.data === 'object' && envelope.data !== null
      ? [envelope.data]
      : []
  // ⚠️ 先按 `model_id` 分组、再**每组选一行**：`billing_type === 'TextTokens'` 优先，
  //    没有 `TextTokens` 就保留**首行**。
  //    不能 last-wins：同一模型可能同时下发 `TextTokens` 与图片类（如 `ImageCount`）
  //    两行 ⇒ last-wins 会按响应顺序拿到**错的那一行**（倍率与 free 跟着错）。
  const chosen = new Map<string, Record<string, unknown>>()
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const id = typeof row.model_id === 'string' ? row.model_id : ''
    if (id.length === 0) continue
    const previous = chosen.get(id)
    if (previous === undefined) {
      chosen.set(id, row)
      continue
    }
    // 只在「新行是 TextTokens 而旧行不是」时覆盖；其余（首发即 TextTokens、
    // 两行都不是 TextTokens）一律保留首行 ⇒ 不随响应顺序乱跳。
    if (row.billing_type === 'TextTokens' && previous.billing_type !== 'TextTokens') {
      chosen.set(id, row)
    }
  }
  const out: Record<string, { inputPoints?: number, outputPoints?: number }> = {}
  for (const [id, row] of chosen) {
    out[id] = {
      ...(typeof row.input_points === 'number' ? { inputPoints: row.input_points } : {}),
      ...(typeof row.output_points === 'number' ? { outputPoints: row.output_points } : {}),
    }
  }
  return out
}

/**
 * 聚合折算原语：该账号的积分**最早作废时刻**。
 *
 * ## ⚠️⚠️ 必须**自己取数**（`src/provider-runtime.ts:218-231` 的契约）
 *
 * `cachedBalance` 只是**共享读数入口**（`src/balance-cache.ts`），不是唯一来源：
 * 它缺席、返回 `null`（查询失败）、或返回 `undefined`（本次没有共享读数）时，
 * **必须回落到自己发请求**（{@link fetchMagicrewBalance}）。
 *
 * 折算的可用性**不得**依赖那份缓存 —— 否则「未接线」会变成「该渠道折算恒
 * {@link UNUSABLE}」⇒ 该渠道在聚合候选表里**静默消失**（本仓库复发过三次的形态）。
 *
 * - 有余额 + 有到期批次 ⇒ 最早那个批次的时刻（`rankCandidates` 据此排先后）
 * - 有余额但无到期批次 ⇒ {@link NEVER}（**永久积分**：排最后但**不剔除**）
 * - 余额为 0 / 取数失败（`fetchMagicrewBalance` 返回 `undefined`） ⇒ {@link UNUSABLE}（**剔除**）
 *
 * ⚠️ 「有余额但无到期时间」必须是 `NEVER` 而**不是** `UNUSABLE`：
 * 后者会把一个真能用的渠道从聚合轮换里剔掉。
 * ⚠️ 反之「余额为 0」必须 `UNUSABLE`：否则余额耗尽的账号仍会被选中、请求随即失败。
 */
export async function magicrewExpiry(params: {
  jwt: string
  organizationCode: string
  /**
   * 共享读数；**缺席、返回 null 或 undefined 时都必须自己发请求取**
   * （`src/provider-runtime.ts:218-231` 的契约：折算可用性不得依赖缓存）。
   */
  cachedBalance?: () => Promise<CreditBalance | null | undefined>
  product?: MagicrewProduct
  fetchImpl?: typeof fetch
  /** 判 `expiresAt > now` 用的时钟（可注入，单测不必等真时间）。 */
  now?: number
}): Promise<number> {
  const cached = await params.cachedBalance?.()
  // ⚠️ `null` 与 `undefined` 都是「没有读数」⇒ 两种都必须回落自取。
  //    （`null` = 查询失败，**不是** UNUSABLE、更不许让它变成 TypeError。）
  const balance = cached !== null && cached !== undefined
    ? cached
    : await fetchMagicrewBalance({
        jwt: params.jwt,
        organizationCode: params.organizationCode,
        ...(params.product === undefined ? {} : { product: params.product }),
        ...(params.fetchImpl === undefined ? {} : { fetchImpl: params.fetchImpl }),
      })
  if (balance === undefined) return UNUSABLE
  if (!(balance.total > 0)) return UNUSABLE
  const now = params.now ?? Date.now()
  let earliest = Number.POSITIVE_INFINITY
  /**
   * 是否存在**任何可用**批次（含「有额度但无到期时刻」= 永久）。
   *
   * ⚠️ 没有它的话，「只剩已作废批次」会走到 `return NEVER`（长期）——
   * 而那是「有额度」的意思 ⇒ 该渠道被排进候选、每轮先失败一次
   * （2026-11-02，对抗审计 B1 的同族；buddy 系与 `sharedPackageExpiry` 已修）。
   */
  let hasUsable = false
  /** 是否**存在任何**（`remaining > 0` 的）批次 —— 用于区分「无批次」与「批次全作废」。 */
  let sawBatch = false
  for (const item of balance.packages) {
    if (item.remaining <= 0) continue
    sawBatch = true
    const at = item.deductionEndTime
    /**
     * ⚠️ **判据与其余三处同一份**（`buddy-balance-rank.ts` 的
     * `splitBuddyCreditsByExpiry` / `aggregate-expiry.ts` 的 `sharedPackageExpiry` /
     * 前端 `credit-expiry.js`）：接受 **number 或数字字符串**，其余（`true` / `[ms]` /
     * `{valueOf}`）一律当「未知」。
     *
     * 2026-11-02 审计实测：本原语原先只认 `typeof === 'number'` ⇒ 数字字符串在
     * **聚合侧判「永久」**而在**面板判「临期」** —— 与 PR #168 §三.4 判为
     * 「同一语义两套判据」的那格同型，只是换到了 magicrew 自己这一家。
     * 生产主路径不可达（`fetchMagicrewBalance` 恒写 number），可达面是旧缓存 /
     * 备份导入 / 手改 `state.json`。
     */
    const atIsNumeric = typeof at === 'number' || typeof at === 'string'
    const atMs = atIsNumeric && Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : undefined
    // ⚠️ 批次有效性按**时刻**判，不是硬编码 `active: true`：若上游过期后仍回该批次
    //（`deductionEndTime` 是**过去**时刻）而不判，该账号永远被判「最早作废」⇒
    //    聚合里每轮排最前。参考 `src/credits.ts:676-678`。
    // 已作废 ⇒ 扣不到，既不算可用、也不参与排序。
    if (atMs !== undefined && atMs <= now) continue
    hasUsable = true
    if (atMs !== undefined && atMs < earliest) earliest = atMs
  }
  // ⚠️ 两种「不可用」要分开：
  // ① **一个批次都没给**（`packages: []`）但 `total > 0`：上游只说有余额、不说批次
  //    ⇒ 如实当「长期」（排最后但不剔除）—— 这是既有语义，别改成 UNUSABLE。
  // ② **有批次但全作废**：那些额度扣不到 ⇒ `UNUSABLE`（钱已经没了）。
  if (!sawBatch) return NEVER
  if (!hasUsable) return UNUSABLE
  return Number.isFinite(earliest) ? earliest : NEVER
}
