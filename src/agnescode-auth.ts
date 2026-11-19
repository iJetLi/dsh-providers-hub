/**
 * AgnesCode 认证服务：**凭据保管 + 有效期对账 + 本机会话导入**。
 *
 * ## 这家没有 refresh，也没有 OAuth 授权页
 *
 * AgnesCode 的凭据是桌面客户端的登录态：一枚 JWT（约 28 天），没有 refresh
 * 端点。因此：
 *
 * - `refreshAll()` **不发网络请求**，只按凭据自己的 `exp` 对账池里的 `expiresAt`；
 * - `refresh()` / `refreshAccountCredential()` **绝不伪造「续期成功」**
 *   （与 qiniu / loomy / monkeycode 同口径）：凭据不可读时抛可读错误，
 *   引导用户重新导入；
 * - 进 `SELF_HEAL` 的名单里**不能有它**（那个名单是「有 refresh 端点」的镜像）。
 *
 * ## 凭据从哪来
 *
 * ① **本机导入**（主路径，Windows）：`%APPDATA%\AgnesCode` 里的
 *    `code-auth-session*.v1` + 兄弟文件 `Local State`。读取与解密全在
 *    `agnescode.ts`（纯函数 + 注入式 IO），本服务只负责「把它落成凭据」。
 * ② **手工粘贴**（备用）：用户从桌面端复制一段 JSON 或裸 token。
 *
 * @module src/agnescode-auth.ts
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { AccountPool } from './account-pool.js'
import { AGNESCODE, type AgnescodeProduct } from './agnescode-product.js'
import {
  AGNESCODE_HARVEST_TIER,
  agnescodeExpiryMs,
  harvestAgnescodeLocalSession,
  parseAgnescodeCredential,
  type AgnescodeCredential,
  type AgnescodeHarvestAttempt,
} from './agnescode.js'
import { syncAccountExpiry, type ExpiryAccessors } from './expiry-sync.js'

/** 用于 Jet Hub 面板的只读登录状态。 */
export interface AgnescodeLoginStatus {
  configured: boolean
  /**
   * 恒为 `'local-session'` —— 两种入口（本机导入 / 手工粘贴）拿到的都是
   * 同一枚桌面端会话 JWT，凭据结构上无从分辨。
   */
  source?: string
  expiresAt?: number
  /** 恒为 `false`（上游没有续期机制）。 */
  refreshable: boolean
  /** 最近一次对账失败的原因（如有）。 */
  refreshError?: string
}

/** 本机导入的结果：成功带凭据，失败带诊断行（**绝不带凭据值**）。 */
export type AgnescodeLocalImportResult =
  | { ok: true; credential: AgnescodeCredential; attempts: AgnescodeHarvestAttempt[] }
  | { ok: false; attempts: AgnescodeHarvestAttempt[] }

/** 凭据 → 池里的有效期（读 `expires_at` / JWT `exp`）。 */
const AGNESCODE_EXPIRY_ACCESSORS: ExpiryAccessors<AgnescodeCredential> = {
  expiresAtOf: agnescodeExpiryMs,
  // ⚠️ 身份判据用 `user_id`（稳定），不用 token：重新登录会换一枚 JWT，
  // 用它判「身份变了」会让同一账号每登一次都被当成新身份回写。
  identityOf: (credential) => credential.user_id ?? '',
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** AgnesCode（国内站）的认证服务实例。 */
    agnescodeAuth: AgnescodeAuth
    /** AgnesCode（国际版）的认证服务实例。 */
    agnescodeintlAuth: AgnescodeAuth
  }
}

/** `AgnescodeAuth` 的构造选项。 */
export interface AgnescodeAuthOptions {
  /** 产品配置；默认 {@link AGNESCODE}。 */
  product?: AgnescodeProduct
  /** 服务名覆盖（默认由产品 id 派生为 `${id}Auth`）。 */
  serviceName?: string
  /** 本机采集的注入点（单测离线跑；生产缺省走真文件 + 真 DPAPI）。 */
  harvest?: typeof harvestAgnescodeLocalSession
}

/**
 * AgnesCode 认证服务：凭据保管 + 有效期对账 + 本机会话导入。
 */
export class AgnescodeAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: AgnescodeProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string
  private readonly harvest: typeof harvestAgnescodeLocalSession
  /** 本实例是否仍在服役（登出 / 插件停用时置 false）。 */
  private active = true

  constructor(ctx: Context, options: AgnescodeAuthOptions = {}) {
    const product = options.product ?? AGNESCODE
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
    this.harvest = options.harvest ?? harvestAgnescodeLocalSession
  }

  /** 登出：只关掉「在途导入是否还该落库」这道闸门（不删凭据）。 */
  async logout(): Promise<void> {
    this.active = false
  }

  /** 插件被停用时调用（与 {@link logout} 同因）。 */
  stop(): void {
    this.active = false
  }

  /**
   * 读本机桌面端的登录态，**不写库**。
   *
   * 之所以把「读」和「落」分开：调用方（RPC 的 `account.create`）需要先拿它
   * 去判重（同一账号反复导入不得攒出多张卡），再决定写到哪个 ref。
   */
  async importLocal(): Promise<AgnescodeLocalImportResult> {
    const result = await this.harvest({ product: this.product })
    if (!result.ok) {
      return { ok: false, attempts: result.attempts }
    }
    const credential = parseAgnescodeCredential(
      JSON.stringify({
        access_token: result.session.accessToken,
        bff_base: result.session.bffBase,
        ...result.session.userId === '' ? {} : { user_id: result.session.userId },
        ...result.session.nickname === '' ? {} : { nickname: result.session.nickname },
      }),
      this.product,
    )
    if (credential === undefined) {
      // 会话解析成功却在凭据层失败 —— 只可能是 base 不过钉扎（上层已挡过一次）。
      // 如实报成 `untrusted_base`，不要把它归为「没登录」。
      return {
        ok: false,
        attempts: [{
          file: null,
          // ⚠️ 用常量而不是字面量：本文件 `agnescode.ts` 的档位表是唯一真相源，
          //    这里再写一遍 `'untrusted_base'` 就是「一文件两套同义判据」的翻版
          //（改档位名时这张诊断行会静默变成另一个字符串）。
          tier: AGNESCODE_HARVEST_TIER.UNTRUSTED_BASE,
          detail: 'the harvested session base failed origin pinning',
        }],
      }
    }
    return { ok: true, credential, attempts: result.attempts }
  }

  /**
   * 把一段手工粘贴的内容解析成凭据。
   *
   * 接受两种形态：完整 JSON（`{access_token, bff_base?}`）或**裸 token**
   * （只有一串 JWT —— 用站点常量补 base）。
   *
   * ⚠️ 裸 token 补 base 是**唯一**允许 base 缺省的路径（见 `agnescode.ts`
   * `parseAgnescodeCredential`）。
   */
  parseManual(input: string): AgnescodeCredential | undefined {
    const text = input.trim()
    if (text === '') return undefined
    if (text.startsWith('{')) return parseAgnescodeCredential(text, this.product)
    return parseAgnescodeCredential(JSON.stringify({ access_token: text }), this.product)
  }

  /**
   * 把凭据写进指定 ref（`account.create` / 手工录入的落库步骤）。
   *
   * ⚠️ 等待/采集是秒级以上的过程，期间插件可能被停用 ⇒ 回来时**再判一次**
   * `active`，不能把已停用插件的凭据写进库。
   *
   * @returns 是否真的写进去了。**必须把结果交给调用方**：静默 `return` 会让
   *   `account.create` 接着 `updateAccount(...)` 并报成功，池里留下一张
   *   「有账号、没凭据」的幽灵卡（导入按钮按一次多一张，且永远不可用）。
   */
  async saveCredential(credential: AgnescodeCredential, refName = this.credentialRefName): Promise<boolean> {
    if (!this.active) return false
    await this.ctx.credentials.set(credentialRef(refName), JSON.stringify(credential))
    return true
  }

  /** 面板状态：只看池里有没有该 provider 的可用凭据（与其余 provider 同判据）。 */
  async status(pool?: AccountPool): Promise<AgnescodeLoginStatus> {
    if (pool === undefined) {
      const credential = await this.readCredential(this.credentialRefName)
      return this.statusOf(credential)
    }
    for (const entry of pool.listAccountsByProvider(this.product.id)) {
      const credential = await this.readCredential(entry.credentialRef)
      if (credential === undefined) continue
      return this.statusOf(credential)
    }
    return { configured: false, refreshable: false }
  }

  /**
   * 单凭据路径的「续期」。
   *
   * ⚠️ **不发网络请求、不写凭据**：AgnesCode 没有 refresh 端点。只做一次
   * 有效性对账：不可读时抛可读错误（引导重新导入）。
   */
  async refresh(): Promise<void> {
    const credential = await this.readCredential(this.credentialRefName)
    if (credential === undefined) {
      throw new Error(
        // ⚠️ 两站共用一个类 ⇒ 名字必须走 `product`（写死 AgnesCode 会让国际版
        //    用户去国内站的入口里找「重新导入」按钮）。
        `${this.product.displayName}：凭据 ${this.credentialRefName} 不可用。`
        + `${this.product.displayName} 的登录态没有续期端点，请在 Jet Hub 的 `
        + `${this.product.displayName} 面板重新「导入本机登录态」。`,
      )
    }
  }

  /**
   * 按**凭据 ref** 对账指定账号（RPC `account.refresh` 的分派目标）。
   *
   * ⚠️ `pool` / `accountId` 必须接受并透传：它们是「续期后回写 `expiresAt`」
   * 的唯一入口（`refresh-bootstrap-wiring.spec.ts` 会逐个 provider 扫这条不变式）。
   */
  async refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void> {
    const credential = await this.readCredential(refName)
    if (credential === undefined) {
      // ⚠️ **不抛错**（与 `refresh()` 刻意不同）：本家**没有** refresh 端点，
      //    「续期」在这里只意味着「用凭据自己的值重算 `expiresAt`」。
      //    凭据读不出来时**没有可对账的东西**，抛错只会让
      //    `account.refresh` 在面板上报一个用户无法执行的失败
      //（他能做的只有「重新导入」，而那句话已经在面板的导入入口上）。
      //    于是按 `refreshAll` 的同口径：记一条 warn、跳过这一条。
      //    ⚠️ 真正的「未登录」由 `status()` / `checkExpired()` 表达，不靠这里抛。
      this.ctx.logger?.warn?.(
        `[${this.product.id}] 账号 ${accountId ?? '(未知)'} 的凭据 ${refName} 不可用，跳过对账`
        + '（AgnesCode 无续期端点，需要时请在面板重新导入本机登录态）',
      )
      return
    }
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential,
      accessors: AGNESCODE_EXPIRY_ACCESSORS,
      ...accountId === undefined ? {} : { accountId },
      tag: `[${this.product.id}]`,
    })
  }

  /**
   * 批量对账（启动首轮 + 每 30 分钟）。
   *
   * 与 monkeycode 逐条同款：**不看 `enabled`、不看 `refreshable`**，
   * 判据只用凭据自己的值（池里的 `expiresAt` 正是可能陈旧的那份）。
   */
  async refreshAll(pool?: AccountPool): Promise<void> {
    if (pool === undefined) return
    for (const entry of pool.listAccountsByProvider(this.product.id)) {
      const credential = await this.readCredential(entry.credentialRef)
      if (credential === undefined) {
        // 一个坏条目不该让整池停止对账。
        this.ctx.logger?.warn?.(`[${this.product.id}] 账号 ${entry.id} 的凭据 ${entry.credentialRef} 不可用，跳过对账`)
        continue
      }
      await syncAccountExpiry({
        pool,
        provider: this.product.id,
        credential,
        accessors: AGNESCODE_EXPIRY_ACCESSORS,
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

  /** 凭据是否被判定为已失效（供门控与面板用）。 */
  async checkExpired(pool?: AccountPool): Promise<boolean> {
    const status = await this.status(pool)
    if (!status.configured) return true
    if (status.expiresAt === undefined) return false
    return status.expiresAt <= Date.now()
  }

  /** 把一个可解析的凭据映射成面板状态。 */
  private statusOf(credential: AgnescodeCredential | undefined): AgnescodeLoginStatus {
    if (credential === undefined) return { configured: false, refreshable: false }
    const expiresAt = agnescodeExpiryMs(credential)
    return {
      configured: true,
      source: 'local-session',
      refreshable: false,
      ...expiresAt === undefined ? {} : { expiresAt },
    }
  }

  /** 读一个 ref 下的凭据（不可用 / 非 JSON / 形状不对时 undefined）。 */
  private async readCredential(refName: string): Promise<AgnescodeCredential | undefined> {
    const resolved = await this.ctx.credentials
      .resolve(credentialRef(refName))
      .catch(() => undefined)
    if (resolved === undefined) return undefined
    return parseAgnescodeCredential(resolved.value, this.product)
  }
}
