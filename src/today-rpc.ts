/**
 * Today（`today` / `todayintl`）专用 RPC 方法处理函数。
 *
 * 对不认识的方法返回 `undefined`，让主 switch 继续分派。
 *
 * @module src/today-rpc.ts
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { TodayProduct } from './today-product.js'
import type { ProviderAccountEntry } from './types.js'
import {
  authenticateTodayCookie,
  parseTodayCredential,
  sendTodayEmailOtp,
  todayAccountSuffix,
  type TodayCredential,
  verifyTodayEmailOtp,
} from './today.js'

export interface TodayPoolLike {
  listAccountsByProvider(provider: string): Array<{ id: string; enabled: boolean; credentialRef: string; nickname?: string }>
  addAccount(entry: ProviderAccountEntry): Promise<void>
  updateAccount(accountId: string, patch: Partial<ProviderAccountEntry>): Promise<void>
  removeAccount(accountId: string): Promise<void>
}

export interface RpcTodayAddAccountRequest {
  cookie: string
  nickname?: string
}

export interface RpcTodaySetCookieRequest {
  accountId: string
  cookie: string
}

export interface RpcTodaySendOtpRequest {
  email: string
}

export interface RpcTodayVerifyOtpRequest {
  email: string
  otp: string
  nickname?: string
}

export interface RpcTodayAccountResponse {
  accountId: string
  existed: boolean
  nickname: string
}

export function todaySlotNamesOf(
  product: TodayProduct,
  credential: Pick<TodayCredential, 'user_id' | 'cookie_raw'>,
): { id: string; refName: string } {
  const suffix = todayAccountSuffix(credential)
  return {
    id: `${product.id}-${suffix}`,
    refName: `${product.refPrefix}_ACCOUNT_${suffix.toUpperCase()}`,
  }
}

async function findTodayDuplicate(
  ctx: Context,
  pool: TodayPoolLike,
  product: TodayProduct,
  credential: TodayCredential,
): Promise<{ id: string; credentialRef: string; nickname?: string } | undefined> {
  for (const entry of pool.listAccountsByProvider(product.id)) {
    const resolved = await ctx.credentials.resolve(credentialRef(entry.credentialRef)).catch(() => undefined)
    if (resolved === undefined) continue
    const existing = parseTodayCredential(resolved.value, product.realm)
    if (existing === undefined) continue
    if (credential.user_id && existing.user_id && existing.user_id === credential.user_id) {
      return entry
    }
    if (credential.email && existing.email && existing.email.toLowerCase() === credential.email.toLowerCase()) {
      return entry
    }
    if (existing.cookie_raw === credential.cookie_raw) {
      return entry
    }
  }
  return undefined
}

async function upsertTodayAccount(
  ctx: Context,
  pool: TodayPoolLike,
  product: TodayProduct,
  credential: TodayCredential,
  nicknameOverride?: string,
): Promise<RpcTodayAccountResponse> {
  const nickname = typeof nicknameOverride === 'string' && nicknameOverride.trim().length > 0
    ? nicknameOverride.trim()
    : (credential.nickname ?? credential.email ?? `${product.displayName}`)

  const duplicate = await findTodayDuplicate(ctx, pool, product, credential)
  if (duplicate !== undefined) {
    await ctx.credentials.set(credentialRef(duplicate.credentialRef), JSON.stringify({
      ...credential,
      nickname: duplicate.nickname ?? nickname,
    }))
    await pool.updateAccount(duplicate.id, {
      refreshable: false,
      ...(credential.nickname && !duplicate.nickname ? { nickname: credential.nickname } : {}),
    })
    return {
      accountId: duplicate.id,
      existed: true,
      nickname: duplicate.nickname ?? nickname,
    }
  }

  let { id, refName } = todaySlotNamesOf(product, credential)
  if (pool.listAccountsByProvider(product.id).some((a) => a.id === id)) {
    const disambiguator = createHash('sha256')
      .update(`${credential.cookie_raw}:${Date.now()}`)
      .digest('hex')
      .slice(0, 8)
    id = `${id}-${disambiguator}`
    refName = `${refName}_${disambiguator.toUpperCase()}`
  }

  await ctx.credentials.set(credentialRef(refName), JSON.stringify({
    ...credential,
    nickname,
  }))
  try {
    await pool.addAccount({
      id,
      provider: product.id,
      nickname,
      enabled: true,
      credentialRef: refName,
      refreshable: false,
      createdAt: Date.now(),
    })
  } catch (error) {
    await ctx.credentials.unset(credentialRef(refName)).catch(() => {})
    throw error
  }
  return { accountId: id, existed: false, nickname }
}

/** 处理 `today.*` / `todayintl.*` 专用 RPC 方法。 */
export async function handleTodayRpc(
  ctx: Context,
  pool: TodayPoolLike,
  method: string,
  payload: unknown,
  product: TodayProduct,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<unknown> {
  const prefix = `${product.id}.`
  if (!method.startsWith(prefix)) return undefined
  const sub = method.slice(prefix.length)
  const fail = (message: string) => ({ ok: false as const, error: { code: 'bad-request', message } })
  const done = <T>(value: T) => ({ ok: true as const, value })

  try {
    switch (sub) {
      case 'addAccount': {
        const req = (payload ?? {}) as RpcTodayAddAccountRequest
        const cookie = typeof req.cookie === 'string' ? req.cookie.trim() : ''
        if (cookie.length === 0) {
          return fail('请粘贴 Today 浏览器 Cookie（或整段 Cookie 头 / Copy as cURL）')
        }
        const credential = await authenticateTodayCookie(cookie, product, fetcher)
        const saved = await upsertTodayAccount(ctx, pool, product, credential, req.nickname)
        return done(saved)
      }

      case 'setCookie': {
        const req = (payload ?? {}) as RpcTodaySetCookieRequest
        const accountId = typeof req.accountId === 'string' ? req.accountId.trim() : ''
        const cookie = typeof req.cookie === 'string' ? req.cookie.trim() : ''
        if (accountId.length === 0) return fail('缺少 accountId')
        if (cookie.length === 0) return fail('请粘贴新的 Today Cookie')
        const existing = pool.listAccountsByProvider(product.id).find((a) => a.id === accountId)
        if (existing === undefined) return fail(`未找到账号 ${accountId}`)
        const credential = await authenticateTodayCookie(cookie, product, fetcher)
        const keepNickname = existing.nickname && existing.nickname.length > 0
          ? existing.nickname
          : (credential.nickname ?? accountId)
        await ctx.credentials.set(credentialRef(existing.credentialRef), JSON.stringify({
          ...credential,
          nickname: keepNickname,
        }))
        await pool.updateAccount(accountId, { refreshable: false })
        return done({ accountId, nickname: keepNickname })
      }

      case 'sendOtp': {
        const req = (payload ?? {}) as RpcTodaySendOtpRequest
        const email = typeof req.email === 'string' ? req.email.trim() : ''
        if (email.length === 0) return fail('请输入邮箱地址')
        await sendTodayEmailOtp(email, product, fetcher)
        return done({ sent: true })
      }

      case 'verifyOtp': {
        const req = (payload ?? {}) as RpcTodayVerifyOtpRequest
        const email = typeof req.email === 'string' ? req.email.trim() : ''
        const otp = typeof req.otp === 'string' ? req.otp.trim() : ''
        if (email.length === 0 || otp.length === 0) return fail('请输入邮箱和验证码')
        const cookieHeader = await verifyTodayEmailOtp(email, otp, product, fetcher)
        const credential = await authenticateTodayCookie(cookieHeader, product, fetcher)
        const enriched: TodayCredential = {
          ...credential,
          ...(credential.email === undefined ? { email } : {}),
        }
        const saved = await upsertTodayAccount(ctx, pool, product, enriched, req.nickname)
        return done(saved)
      }

      default:
        return undefined
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
