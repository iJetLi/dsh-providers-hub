/**
 * 跨插件只读余额投影。读取复用宿主已有的余额编排，不接收凭据、账号池或 fetch。
 * 只允许白名单数值和展示字段跨越服务边界，登录标识与原始错误留在宿主内。
 */
export interface CreditBalanceService {
  supportedProviders(): Array<{ id: string; displayName: string }>
  creditsBalances(providerId: string): Promise<{ accounts: PublicCreditAccount[] }>
}

export interface PublicCreditPackage {
  name: string
  unit: string
  remaining?: number
  total?: number
  used?: number
  active?: boolean
  expiredTime?: string
  deductionEndTime?: number
}

export interface PublicCreditAccount {
  /** 仅在本次响应内区分账号，不暴露登录标识，也不保证跨响应稳定。 */
  accountId: string
  nickname: string
  balance: { total: number; packages: PublicCreditPackage[]; unit?: string } | null
  stale?: boolean
  error?: 'unknown' | 'upstream-invalid-response' | 'stale-balance'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    creditBalance: CreditBalanceService
  }
}

interface ProviderDescriptor {
  readonly id: string
  readonly label: string
  readonly credits: { readonly balance: boolean }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function amount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function label(value: unknown, fallback: string): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) || fallback
    : fallback
}

function failure(reason: 'unknown' | 'upstream-invalid-response'): Error & { safeReason: string } {
  return Object.assign(new Error(reason), { safeReason: reason })
}

function projectPackage(value: unknown, index: number): PublicCreditPackage | undefined {
  const source = record(value)
  if (source === undefined) return undefined
  for (const key of ['remaining', 'total', 'used']) {
    if (source[key] !== undefined && !amount(source[key])) return undefined
  }
  if (!amount(source.remaining) && !(amount(source.total) && amount(source.used))) return undefined
  const projected: PublicCreditPackage = {
    name: label(source.name, `额度包 ${index + 1}`),
    unit: label(source.unit, 'credit'),
  }
  if (amount(source.remaining)) projected.remaining = source.remaining
  if (amount(source.total)) projected.total = source.total
  if (amount(source.used)) projected.used = source.used
  if (typeof source.active === 'boolean') projected.active = source.active
  // 保留宿主明确的毫秒单位；未知或越界时间不制造到期判据。
  if (amount(source.deductionEndTime) && source.deductionEndTime > 0 && source.deductionEndTime <= 8.64e15) {
    projected.deductionEndTime = source.deductionEndTime
  }
  if (typeof source.expiredTime === 'string' && source.expiredTime !== '') {
    const timestamp = Date.parse(source.expiredTime)
    if (Number.isFinite(timestamp)) projected.expiredTime = new Date(timestamp).toISOString()
  }
  return projected
}

function projectAccount(value: unknown, index: number): PublicCreditAccount {
  const result: PublicCreditAccount = {
    accountId: `account-${index + 1}`,
    nickname: `账号 ${index + 1}`,
    balance: null,
  }
  const source = record(value)
  if (source === undefined) return { ...result, error: 'upstream-invalid-response' }
  if (source.stale === true) return { ...result, stale: true, error: 'stale-balance' }
  if (source.error !== undefined && source.error !== null && source.error !== '') {
    return { ...result, error: 'unknown' }
  }
  const balance = record(source.balance)
  if (balance === undefined) return { ...result, error: 'unknown' }
  if (!amount(balance.total) || !Array.isArray(balance.packages)) {
    return { ...result, error: 'upstream-invalid-response' }
  }
  const packages = balance.packages.map(projectPackage)
  // 不丢弃坏包后再返回成功，避免误报成少量余额或真实的零余额。
  if (packages.some((entry) => entry === undefined)) return { ...result, error: 'upstream-invalid-response' }
  result.balance = {
    total: balance.total,
    packages: packages as PublicCreditPackage[],
    ...(typeof balance.unit === 'string' ? { unit: label(balance.unit, 'credit') } : {}),
  }
  return result
}

export function createCreditBalanceService(deps: {
  providers: () => readonly ProviderDescriptor[]
  read: (providerId: string) => Promise<unknown>
}): CreditBalanceService {
  const supportedProviders = () => deps.providers()
    .filter((provider) => provider.credits.balance === true)
    .map((provider) => ({ id: provider.id, displayName: provider.label }))
  return {
    supportedProviders,
    async creditsBalances(providerId) {
      if (!supportedProviders().some((provider) => provider.id === providerId)) {
        const error = new Error('unsupported-provider')
        error.name = 'UnsupportedProviderError'
        throw error
      }
      let response: unknown
      try {
        response = await deps.read(providerId)
      } catch {
        throw failure('unknown')
      }
      const envelope = record(response)
      if (envelope?.ok === false) throw failure('unknown')
      const payload = record(envelope?.value)
      if (envelope?.ok !== true || !Array.isArray(payload?.accounts)) throw failure('upstream-invalid-response')
      return { accounts: payload.accounts.map(projectAccount) }
    },
  }
}
