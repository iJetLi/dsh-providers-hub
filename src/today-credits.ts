/**
 * Today（`today` / `todayintl`）积分/套餐余额原语。
 *
 * 从 `GET /v1/pricing/status` 读取 `data.status`：
 * - `plan`: 字符串或 `{ id }`
 * - `usage.progress`: 已用百分比（0..100）
 * - `usage.resetAt`: 重置时刻（ISO 字符串，缺席时置 `expiryUnknown: true`）
 * - `usage.progressText`: 描述文本
 *
 * @module src/today-credits.ts
 */

import type { CreditBalance, CreditPackage } from './credits.js'
import type { TodayProduct } from './today-product.js'
import {
  TodayUpstreamError,
  fetchTodayPricingStatus,
  parseTodayCredential,
  type TodayCredential,
} from './today.js'
import type { ProviderBalanceDetail } from './provider-runtime.js'

const UNIT = '%'

function readPlanName(status: Record<string, unknown>): string | undefined {
  if (typeof status.plan === 'string' && status.plan.trim().length > 0) {
    return status.plan.trim()
  }
  if (typeof status.plan === 'object' && status.plan !== null) {
    const id = (status.plan as Record<string, unknown>).id
    if (typeof id === 'string' && id.trim().length > 0) return id.trim()
  }
  return undefined
}

function readNumeric(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** 解析 `/v1/pricing/status` 中的 `data.status` 为标准 `CreditBalance`。 */
export function parseTodayBalanceFromStatus(status: Record<string, unknown>): CreditBalance | null {
  const usage = (typeof status.usage === 'object' && status.usage !== null
    ? status.usage
    : undefined) as Record<string, unknown> | undefined
  if (usage === undefined) return null

  const usedPercentRaw = readNumeric(usage.progress)
  if (usedPercentRaw === undefined) return null

  const used = Math.max(0, Math.min(100, Math.round(usedPercentRaw * 100) / 100))
  const remaining = Math.max(0, Math.min(100, Math.round((100 - used) * 100) / 100))

  const resetAt = typeof usage.resetAt === 'string' ? usage.resetAt.trim() : ''
  const resetMs = resetAt.length > 0 ? Date.parse(resetAt) : Number.NaN
  const hasReset = Number.isFinite(resetMs) && resetMs > 0

  const plan = readPlanName(status)
  const progressText = typeof usage.progressText === 'string' ? usage.progressText.trim() : ''
  const pkgName = plan ? `Today (${plan})` : (progressText || 'Today 套餐')

  const pkg: CreditPackage = {
    name: pkgName,
    unit: UNIT,
    remaining,
    total: 100,
    totalKnown: true,
    used,
    active: remaining > 0,
    cycleStartTime: '',
    cycleEndTime: hasReset ? resetAt : '',
    expiredTime: hasReset ? resetAt : '',
    ...(hasReset ? { deductionEndTime: resetMs } : { expiryUnknown: true }),
  }

  return {
    total: remaining,
    packages: [pkg],
    expiredTotal: 0,
  }
}

/**
 * 查询 Today 账号剩余套餐百分比（带错误原因）。
 */
export async function fetchTodayBalanceDetailed(
  product: TodayProduct,
  credential: unknown,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ProviderBalanceDetail> {
  const text = typeof credential === 'string' ? credential : JSON.stringify(credential ?? {})
  const parsed: TodayCredential | undefined = parseTodayCredential(text, product.realm)
  if (parsed === undefined) {
    return { balance: null, error: '凭据不可用或不是合法的 Today 会话凭据' }
  }
  try {
    const status = await fetchTodayPricingStatus(parsed, product, { fetcher })
    const balance = parseTodayBalanceFromStatus(status)
    if (balance === null) {
      return { balance: null, error: '余额查询失败（上游未返回 usage 进度信息）' }
    }
    return { balance }
  } catch (error) {
    if (error instanceof TodayUpstreamError && (error.status === 401 || error.status === 403)) {
      return { balance: null, error: `登录态已失效（HTTP ${error.status}），请重新更新 Cookie` }
    }
    return {
      balance: null,
      error: `余额查询失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
