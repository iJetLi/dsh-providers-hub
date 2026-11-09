/**
 * 腾讯 Marvis **令牌钱包**读取。
 *
 * ## 数据来源（2026-11-09 真机实测）
 *
 *     POST https://yybadaccess.3g.qq.com/v3/marvis_get_wallet
 *     Ual-Access-Businessid/Timestamp/Nonce/Signature/Guid/Access-Token/Login-Type/Openid
 *     {"{}"}  ——— body 就是字面量 `{}`
 *     → {"code":0,"msg":"","data":{
 *          "openid":"…","total_tokens":"10000000","used_tokens":"0",
 *          "frozen_tokens":"0","avail_tokens":"10000000","total_cost":0,"status":1}}
 *
 * ## ⚠️ 三个必须按「字符串」读的字段
 *
 * 上游把额度都下发成**字符串数字**（`"10000000"`）。直接 `Number()` 之外的
 * 任何算术都会得到 `NaN` 或字符串拼接；`typeof === 'number'` 的判据在这里
 * **恒假** ⇒ 会静默退化成「读不到余额」。
 *
 * ## ⚠️ 没有任何日期字段
 *
 * 钱包响应里**没有**重置时间、到期时间、周期字段（8 个真实账号逐一核对）。
 * 而 Marvis 的免费额度是**按自然日回满**的（README：每日 1000 万计费 token）。
 * ⇒ 只能置 `expiryUnknown: true`，**绝不**编造一个「明天 0 点」的日期：
 * 本仓库红线是「绝不编造日期」，而「上游没给日期」不等于「永不到期」。
 *
 * @module src/marvis-credits.ts
 */

import type { CreditBalance, CreditPackage } from './credits.js'
import { businessHeaders, marvisAccountOf, type MarvisCredential } from './marvis.js'
import { MARVIS, type MarvisProduct } from './marvis-product.js'

/** 上游钱包报文（只取用得到的字段）。 */
interface RawWallet {
  code?: unknown
  msg?: unknown
  data?: {
    total_tokens?: unknown
    used_tokens?: unknown
    frozen_tokens?: unknown
    avail_tokens?: unknown
    status?: unknown
  }
}

/**
 * 把额度字段收敛成安全整数。
 *
 * 接受 `number` 与**字符串数字**（实测就是字符串）；其余一律 `undefined`
 * （= 读不到），**绝不**回落成 `0` —— 0 的语义是「已用光」。
 */
export function readMarvisAmount(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined
  }
  return undefined
}

/** 可注入的依赖（单测用；生产不传）。 */
export interface MarvisCreditsDeps {
  fetchImpl?: typeof fetch
}

/**
 * 拉取令牌钱包余额。
 *
 * ## 为什么用 `Detailed`（失败要带原因）
 *
 * 三种失败的**用户动作完全不同**，压成笼统的「余额查询失败」会误导：
 *
 * - `401` / 业务码 `4100403` ⇒ **登录态过期** ⇒ 该续期或重新登录；
 * - `code !== 0` ⇒ 上游拒绝（常见于账号被风控/封禁）⇒ 换号，不是重新登录；
 * - `code === 0` 但缺字段 ⇒ **上游改版** ⇒ 该报「读数格式变了」，而不是「余额 0」。
 */
export async function fetchMarvisBalanceDetailed(
  credential: MarvisCredential,
  product: MarvisProduct = MARVIS,
  deps: MarvisCreditsDeps = {},
): Promise<{ balance: CreditBalance | null; error?: string }> {
  if (
    credential === undefined
    || credential === null
    || typeof credential.access_token !== 'string'
    || credential.access_token.length === 0
  ) {
    return { balance: null, error: '没有可用的 Marvis 登录凭据' }
  }

  const body = '{}'
  const fetchImpl = deps.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${product.baseUrl}${product.balancePath}`, {
      method: 'POST',
      // ⚠️ 业务接口**必须**带 UAL 签名头（与模型网关相反 —— 网关加了会被
      //    判「登录态过期」）。签名覆盖 query、所以这里的 query 就是 body。
      headers: businessHeaders(marvisAccountOf(credential), { query: body, method: 'POST' }),
      body,
      signal: AbortSignal.timeout(product.balanceTimeoutMs),
    })
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? '请求超时'
      : '网络请求失败'
    return { balance: null, error: `Marvis 令牌余额查询失败：${reason}` }
  }

  const text = await response.text().catch(() => '')

  if (response.status === 401 || response.status === 403) {
    return {
      balance: null,
      error: 'Marvis 登录态已过期或凭据无效（钱包端点返回 401/403），请在面板里重新登录该账号',
    }
  }

  let parsed: RawWallet
  try {
    parsed = JSON.parse(text) as RawWallet
  } catch {
    return {
      balance: null,
      error: `Marvis 余额响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`,
    }
  }

  if (parsed.code !== 0) {
    const message = typeof parsed.msg === 'string' && parsed.msg.length > 0 ? parsed.msg : ''
    return {
      balance: null,
      error: `Marvis 未返回令牌余额（业务码 ${String(parsed.code)}${message === '' ? '' : ` ${message}`}）`,
    }
  }

  const total = readMarvisAmount(parsed.data?.total_tokens)
  const used = readMarvisAmount(parsed.data?.used_tokens)
  if (total === undefined || used === undefined) {
    // ⚠️ **刻意不回落成 0**：0 的语义是「额度已用光」，而这里是「读不到数字」。
    return {
      balance: null,
      error: 'Marvis 钱包响应里没有 total_tokens/used_tokens（上游可能改版），无法显示余额',
    }
  }
  const available = readMarvisAmount(parsed.data?.avail_tokens) ?? Math.max(0, total - used)
  const frozen = readMarvisAmount(parsed.data?.frozen_tokens) ?? 0
  // `status: 1` = 钱包可用；其余（实测未见，但保留判据）视为账号被限制。
  const active = parsed.data?.status === 1 || parsed.data?.status === '1'

  const packages: CreditPackage[] = [{
    name: '令牌用量',
    // ⚠️ 单位必须是**单数** `'token'`。全仓的展示层（`credits-format.ts` 的
    //    `normalizeUnit` / `unitLabel` / `formatUnits`，以及宿主 `src/credits.ts`
    //    的 `normalizeCreditUnit`）只认 `'token'` 一个特例，其余**全部**当积分：
    //    写 `'tokens'` 会让徽标显示成「10000000 积分」（原始整数 + 错的单位），
    //    而不是「9.93MToken」。2026-11-09 真机报障后改。
    unit: 'token',
    remaining: available,
    total,
    used,
    active,
    // 上游**不下发任何时间字段** ⇒ 三个时间填空串（「不适用」），并标
    // `expiryUnknown`：额度会按自然日回满，但我们拿不到重置时刻。
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    expiryUnknown: true,
  }]

  return {
    balance: {
      /**
       * ⚠️⚠️ 这里是**剩余**（`avail_tokens`），不是每日额度上限。
       *
       * `CreditBalance.total` 的语义是「一共还能用多少」（徽标折叠态直接渲染它，
       * 见 `plugin-src/client/badge-model.js` 的 `creditGroupsOf`：`group.total += balance.total`）。
       * 初版写的是 `total`（= 每日上限 10,000,000）⇒ 徽标**永远显示 10,000,000**，
       * 用掉 7 万 token 也纹丝不动（2026-11-09 真机报障：「发完对话还是 1 亿」）。
       * 上限仍保留在包上（`packages[0].total`），所以弹窗里还能看到「9.93M / 10.00M」。
       */
      total: available,
      packages,
      // 冻结额不属于「已失效」，也**不并入 total**（与 modelscope 的
      // `frozen_amount` 同一条纪律：分开给，不并）。
      expiredTotal: 0,
      /**
       * ⚠️⚠️ 冻结额**必须**放 `usage`，不能当第 2 个包（2026-11-09 评审 I3）。
       *
       * 曾经把它 push 成一个 `{ remaining: frozen, total: frozen }` 的包，
       * 有两个后果，都不报错：
       * 1. **双计**：`splitCreditsByExpiry` 对每个 `active && remaining > 0` 的包
       *    求和 ⇒ `avail=850, frozen=50` 的账号卡片显示「到期未知 900」，
       *    比真实可用多 50；
       * 2. **烧光也判不死**：`avail=0, frozen=50` 时仍有一个正 remaining 的包
       *    ⇒ `sharedPackageExpiry` 判 `NEVER` 而非 `UNUSABLE`，折算层会继续
       *    往这个已经没额度的账号上派单，且每次必失败。
       * `usage` 是**纯展示行**（`{label, amount, unit}`），不参与任何求和 ——
       * 冻结中的量本来就该让用户看见、但不该被当成可用额度。
       */
      ...(frozen > 0
        ? { usage: { label: '冻结中', amount: frozen, unit: 'token' } }
        : {}),
    },
  }
}
