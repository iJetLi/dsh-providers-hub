/**
 * Today（`today` / `todayintl`）认证服务：凭据保管与池内元数据对账。
 *
 * Better Auth 的会话 Cookie 没有 OAuth `refresh_token` / 上游 refresh 端点，
 * 因此 `refreshable` 恒为 `false`；`refresh()` 与 `refreshAccountCredential()` 仅校验
 * 凭据存在性并完成 `AccountPool` 元数据对账（短寿命 API JWT 在请求期内存按需换取）。
 *
 * @module src/today-auth.ts
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { AccountPool } from './account-pool.js'
import { syncAccountExpiry, type ExpiryAccessors } from './expiry-sync.js'
import { TODAY, type TodayProduct } from './today-product.js'
import {
  parseTodayCredential,
  type TodayCredential,
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
}

/** Today 认证服务。 */
export class TodayAuth extends Service {
  readonly product: TodayProduct
  readonly credentialRefName: string

  constructor(ctx: Context, options: TodayAuthOptions = {}) {
    const product = options.product ?? TODAY
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
  }

  async logout(): Promise<void> {}

  stop(): void {}

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
