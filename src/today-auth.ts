/**
 * Today（`today` / `todayintl`）认证服务：凭据保管、有效性对账与 Cookie/OTP 登录。
 *
 * Better Auth 的会话 Cookie 没有 OAuth `refresh_token`，因此 `refreshable` 恒为 `false`；
 * `refresh()` 与 `refreshAccountCredential()` 做对账（并在调用 `/api/token` 时缓存 API JWT）。
 *
 * @module src/today-auth.ts
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { AccountPool } from './account-pool.js'
import { syncAccountExpiry, type ExpiryAccessors } from './expiry-sync.js'
import { TODAY, type TodayProduct } from './today-product.js'
import {
  authenticateTodayCookie,
  parseTodayCredential,
  sendTodayEmailOtp,
  type TodayCredential,
  verifyTodayEmailOtp,
} from './today.js'

/** 面板只读登录状态。 */
export interface TodayLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  refreshable: boolean
  refreshError?: string
}

const TODAY_EXPIRY_ACCESSORS: ExpiryAccessors<TodayCredential> = {
  expiresAtOf: () => undefined,
  identityOf: (credential) => credential.user_id ?? credential.email ?? '',
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Today（国内版）认证服务实例。 */
    todayAuth: TodayAuth
    /** Today（国际版）认证服务实例。 */
    todayintlAuth: TodayAuth
  }
}

export interface TodayAuthOptions {
  product?: TodayProduct
  serviceName?: string
  fetcher?: typeof fetch
}

/** Today 认证服务。 */
export class TodayAuth extends Service {
  readonly product: TodayProduct
  readonly credentialRefName: string
  private readonly fetcher: typeof fetch
  private active = true

  constructor(ctx: Context, options: TodayAuthOptions = {}) {
    const product = options.product ?? TODAY
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
    this.fetcher = options.fetcher ?? globalThis.fetch
  }

  async logout(): Promise<void> {
    this.active = false
  }

  stop(): void {
    this.active = false
  }

  async authenticateCookie(rawCookie: string): Promise<TodayCredential> {
    return await authenticateTodayCookie(rawCookie, this.product, this.fetcher)
  }

  async sendEmailOtp(email: string): Promise<void> {
    await sendTodayEmailOtp(email, this.product, this.fetcher)
  }

  async verifyEmailOtp(email: string, otp: string): Promise<TodayCredential> {
    const cookieHeader = await verifyTodayEmailOtp(email, otp, this.product, this.fetcher)
    const cred = await authenticateTodayCookie(cookieHeader, this.product, this.fetcher)
    return {
      ...cred,
      ...(cred.email === undefined && email.trim().length > 0 ? { email: email.trim() } : {}),
    }
  }

  async saveCredential(credential: TodayCredential, refName = this.credentialRefName): Promise<boolean> {
    if (!this.active) return false
    await this.ctx.credentials.set(credentialRef(refName), JSON.stringify(credential))
    return true
  }

  async status(pool?: AccountPool): Promise<TodayLoginStatus> {
    if (pool === undefined) {
      const credential = await this.readCredential(this.credentialRefName)
      return credential === undefined
        ? { configured: false, refreshable: false }
        : { configured: true, source: 'cookie', refreshable: false }
    }
    for (const entry of pool.listAccountsByProvider(this.product.id)) {
      const credential = await this.readCredential(entry.credentialRef)
      if (credential === undefined) continue
      return { configured: true, source: 'cookie', refreshable: false }
    }
    return { configured: false, refreshable: false }
  }

  async refresh(): Promise<void> {
    const credential = await this.readCredential(this.credentialRefName)
    if (credential === undefined) {
      throw new Error(
        `${this.product.displayName}：凭据 ${this.credentialRefName} 不可用。`
        + `请在 Jet Hub 的「${this.product.displayName}」面板重新导入浏览器 Cookie。`,
      )
    }
  }

  async refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void> {
    const credential = await this.readCredential(refName)
    if (credential === undefined) {
      this.ctx.logger?.warn?.(
        `[${this.product.id}] 账号 ${accountId ?? '(未知)'} 的凭据 ${refName} 不可用，跳过对账`,
      )
      return
    }
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential,
      accessors: TODAY_EXPIRY_ACCESSORS,
      ...accountId === undefined ? {} : { accountId },
      tag: `[${this.product.id}]`,
    })
  }

  async refreshAll(pool?: AccountPool): Promise<void> {
    if (pool === undefined) return
    for (const entry of pool.listAccountsByProvider(this.product.id)) {
      const credential = await this.readCredential(entry.credentialRef)
      if (credential === undefined) {
        this.ctx.logger?.warn?.(`[${this.product.id}] 账号 ${entry.id} 的凭据 ${entry.credentialRef} 不可用，跳过对账`)
        continue
      }
      await syncAccountExpiry({
        pool,
        provider: this.product.id,
        credential,
        accessors: TODAY_EXPIRY_ACCESSORS,
        accountId: entry.id,
        current: {
          ...entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt },
          refreshable: entry.refreshable,
        },
        tag: `[${this.product.id}]`,
        warn: (message) => this.ctx.logger?.warn?.(message),
      })
    }
  }

  async checkExpired(pool?: AccountPool): Promise<boolean> {
    const status = await this.status(pool)
    return !status.configured
  }

  private async readCredential(refName: string): Promise<TodayCredential | undefined> {
    const resolved = await this.ctx.credentials
      .resolve(credentialRef(refName))
      .catch(() => undefined)
    if (resolved === undefined) return undefined
    return parseTodayCredential(resolved.value, this.product.realm)
  }
}
