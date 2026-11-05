/**
 * 智谱清言（chatglm.cn **网页端**）的 auth 服务对象（供 `JetHubAuths` 与
 * `auth.refreshAll` 接线）。
 *
 * ## 为什么必须有它
 *
 * 本家有**真实的续期端点** `POST /chatglm/user-api/user/refresh`（Bearer 用
 * **refresh token**），且凭据确实会过期（`chatglm_token` cookie TTL 30 天、
 * 官方客户端把「本地有效期」记成 `now + 2 小时`）。而
 * `credits.balance === true` 的渠道**必须**进
 * `SELF_HEAL_REFRESHABLE_PROVIDERS`（`credits-balance-self-heal.spec.ts` 双向锁死）——
 * 否则系统睡眠/挂起恢复后，积分行会报「未登录」而上游其实只需一次 refresh，
 * 而**日志零字**（issue IKKHL5 的形态，本仓库已复发多次）。
 *
 * ⇒ 两条腿缺一不可：① `index.ts` 的 `auths.chatglm`；② 自愈 Set 里的 `'chatglm'`。
 *
 * ## ⚠️⚠️ 单向门：`refresh_token` 可能轮换，必须落盘
 *
 * 与 `autoclaw` / `codely` 同源纪律：本模块**拿到新 `refresh_token` 就立刻写回**
 * 凭据库（`ChatglmCredential.chatglm_refresh_token`）。不写回的后果是
 * 「下次续期拿旧值被拒 ⇒ 账号被标死 ⇒ 只能重登」，而重登拿到的新 token
 * 又会在下一次被同样烧掉。
 *
 * ⚠️ 与 `codely` 的差别：有没有轮换，**实测未知**（没有真凭据可测）⇒ 本实现
 * **不假设「不轮换」**（codely 那次实测连续三次同值才敢沿用旧值），
 * 而是「上游给了就用新的、没给就保留旧值」—— 两种上游行为都正确。
 *
 * @module src/chatglm-auth-service.ts
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { parseChatglmCredential, type ChatglmCredential } from './chatglm.js'
import { refreshChatglmToken } from './chatglm-credits.js'

/** 凭据库最小接口。 */
interface CredentialStoreLike {
  resolve(ref: string): Promise<{ value?: string } | undefined>
  set(ref: string, value: string): Promise<void>
}

export class ChatglmAuth extends Service {
  constructor(
    ctx: Context,
    private readonly options: {
      credentials?: CredentialStoreLike
      /** 回写池条目有效期（可选；缺省不写，保持「尽力而为」）。 */
      writebackExpiry?: (accountId: string, expiresAtMs: number | undefined) => Promise<void>
    } = {},
  ) {
    // ⚠️ 服务名必须是 `chatglmAuth`（全小写 + `Auth` 后缀），与其余各家
    //    `${product.id}Auth` 同形 —— 写成别的名字，`AUTH_SERVICE` 表与实际
    //    服务名就对不上，下游一律取不到。
    super(ctx, 'chatglmAuth')
  }

  /** 记一条 warn（日志不可用不得影响续期）。 */
  private warn(message: string): void {
    try {
      this.ctx?.logger?.warn?.(`[chatglm-auth] ${message}`)
    } catch { /* 日志不可用不得影响续期 */ }
  }

  /**
   * 续期某一个账号。
   *
   * 四条早退**各记一条 warn**（凭据库未注入 / 读不到凭据 / 没有 refresh token /
   * 上游续期失败）—— 四种性质不同的原因若都不留痕，症状恒为
   * 「续期永不发生且日志零字」（`codely-auth-service.ts` 记录过同型失效）。
   */
  async refreshAccountCredential(
    refName: string,
    _pool: unknown,
    accountId: string,
  ): Promise<void> {
    const store = this.options.credentials
    if (store === undefined) {
      this.warn(`credentials 未注入，本实例续期功能整体不可用（账号 ${accountId} 已跳过）`)
      return
    }
    let current: ChatglmCredential | undefined
    try {
      const resolved = await store.resolve(refName)
      current = parseChatglmCredential(resolved?.value)
    } catch { current = undefined }
    if (current === undefined) {
      this.warn(`账号 ${accountId} 读不到凭据（ref=${refName}），跳过续期`)
      return
    }
    if (typeof current.chatglm_refresh_token !== 'string' || current.chatglm_refresh_token.length === 0) {
      // 属**账号级**问题：只能重新登录，续期救不了。
      this.warn(`账号 ${accountId} 没有 refresh token，无法续期，需重新登录`)
      return
    }
    const next = await refreshChatglmToken(current)
    if (!next.ok) {
      // 三种原因同形（refresh token 彻底失效 / 网络异常 / 上游协议变更）。
      // 不记账、不锁号（与换发侧同纪律），但必须留痕。
      this.warn(`账号 ${accountId} 续期失败（${next.error}），未记账`)
      return
    }
    const updated: ChatglmCredential = {
      ...current,
      chatglm_token: next.accessToken,
      // ⚠️ 单向门：上游给了新 refresh token 就换，没给就保留旧值
      //    （不假设「不轮换」—— 见模块头）。
      ...next.refreshToken === undefined ? {} : { chatglm_refresh_token: next.refreshToken },
      // ⚠️ 官方客户端把本地有效期记成 `now + 2 小时`（`chatglm.ts` 的 `RefreshToken`
      //    action 逐字可见）⇒ 续期成功后按同一口径更新。**这是上游自己的口径，
      //    不是编造**（与 autoclaw 那次「编造 +7 天」的 P0 事故刻意不同）。
      expires_at: Date.now() + 2 * 3600_000,
    }
    try {
      await store.set(refName, JSON.stringify(updated))
    } catch { /* 写回失败不阻断续期流程 */ }
    if (this.options.writebackExpiry !== undefined) {
      await this.options.writebackExpiry(accountId, updated.expires_at).catch(() => undefined)
    }
  }

  /**
   * 批量续期（`JetHubAuthLike.refreshAll` 契约的**单参**形式）。
   *
   * ⚠️ 读池抛错 / 空池 ⇒ 静默返回（一个渠道的池抖动不该让整轮续期炸掉）。
   * ⚠️ 必须逐个走 `refreshAccountCredential`（不直接调裸函数）：否则池里的
   *    `expiresAt` 不回写，界面有效期停在旧值。
   */
  async refreshAll(pool: unknown): Promise<void> {
    let accounts: readonly { id: string; credentialRef: string }[] = []
    try {
      const listed = (pool as { listAccountsByProvider?: (id: string) => unknown } | undefined)
        ?.listAccountsByProvider?.('chatglm')
      const resolved = await listed
      if (Array.isArray(resolved)) {
        accounts = resolved as { id: string; credentialRef: string }[]
      }
    } catch {
      return
    }
    for (const account of accounts) {
      await this.refreshAccountCredential(account.credentialRef, pool, account.id).catch(() => undefined)
    }
  }
}
