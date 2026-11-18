/**
 * AgnesCode 的积分余额原语（订阅积分池，只读）。
 *
 * ## 口径（这是本文件最容易被后来者改错的地方）
 *
 * 上游给的是**一个订阅池的两个标量桶**：
 * - `permanent_balance`：平台自己叫「永久」；
 * - `time_sensitive_balance`：会过期，但**不给任何逐笔日期**（只有聚合值）。
 *
 * ⇒ 「限时」那一桶必须置 `expiryUnknown: true`。本仓红线（Issue IKTLMX）：
 *   「没有 `deductionEndTime`」在展示层会被读成**真·永久**，于是卡片写
 *   「永久 3000」—— 而它其实会作废。把「上游没给日期」说成「永不到期」
 *   正是那个 issue 的原始缺陷。
 *
 * ⚠️ `permanent_balance` **不标** `expiryUnknown`：那是平台明说的永久，
 * 反过来一律标未知会让「永久」这一类读数失真（Loomy 那种明说永久的必须还是永久）。
 *
 * ⚠️ 不反推日期（`remaining / 每日领取量 = 天数` 只在「每天都领」时成立，
 * 那是乐观上界，不是事实）。
 *
 * @module src/agnescode-credits.ts
 */

import type { CreditBalance, CreditPackage } from './credits.js'
import { fetchAgnescodeBalance } from './agnescode.js'
import { parseAgnescodeCredential, type AgnescodeCredential } from './agnescode.js'
import type { AgnescodeProduct } from './agnescode-product.js'
import type { ProviderBalanceDetail } from './provider-runtime.js'

/** 计价单位（与上游目录/余额页一致）。 */
const UNIT = 'credits'

/** 构造一个「只有聚合值」的包。 */
function packageOf(name: string, remaining: number, expiryUnknown: boolean): CreditPackage {
  return {
    name,
    unit: UNIT,
    remaining,
    total: remaining,
    // ⚠️ 上游只给当前余额、**没有**初始总额 ⇒ `totalKnown: false`，
    //    否则面板会显示「100/100 → 98/98」这种分母跟着余额跑的假读数。
    totalKnown: false,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    ...expiryUnknown ? { expiryUnknown: true } : {},
  }
}

/**
 * 查余额（带原因）。
 *
 * `credential` 是**已落库的 JSON 字符串**（`ProviderCredits` 的通用契约：
 * 端点表把 `entry.credentialRef` 解析出来的原值直接传进来）。
 */
export async function fetchAgnescodeBalanceDetailed(
  product: AgnescodeProduct,
  credential: unknown,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ProviderBalanceDetail> {
  const text = typeof credential === 'string'
    ? credential
    // 万一上层给的是已解析对象（其它 provider 的形态），回退成 JSON 再走同一条解析。
    : JSON.stringify(credential ?? {})
  const parsed: AgnescodeCredential | undefined = parseAgnescodeCredential(text, product)
  if (parsed === undefined) {
    return { balance: null, error: '凭据不可用或不是合法的 AgnesCode 会话凭据' }
  }
  const reading = await fetchAgnescodeBalance(parsed, product, fetcher)
  if (reading === null) {
    // ⚠️ `null` 是「查不到」，绝不是 0 —— 画成 0 会让用户以为额度被清空。
    return { balance: null, error: '余额查询失败（上游未返回可解析的订阅积分池）' }
  }
  const packages: CreditPackage[] = []
  if (reading.permanent > 0) packages.push(packageOf('永久积分', reading.permanent, false))
  if (reading.timeSensitive > 0) packages.push(packageOf('限时积分', reading.timeSensitive, true))
  return {
    balance: {
      // 合计用上游的 `total_balance`（两桶之和是它的口径，但上游已算好，直接用）。
      total: reading.total,
      packages,
      // 上游没有「已失效包」这一维度 ⇒ 0（不编造）。
      expiredTotal: 0,
    },
  }
}
