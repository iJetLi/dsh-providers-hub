/**
 * Gemini（Cloud Code Assist）认证服务。
 *
 * 登录走**浏览器回调式 OAuth**（见 `gemini-oauth.ts`：本地 `createServer` 起回调、
 * 立即返回 `loginUrl`），续期走 `refresh_token` grant。
 *
 * ## ⚠️ `refreshAll` 照 `src/service.ts`（codearts）范式，**不照** `minimax-auth.ts`
 *
 * 旧范式第一行是 `if (!entry.refreshable) continue` —— 那让这个布尔变成一道
 * **单向门**：任何一次把它写成 false 的路径都会让该账号此后**永远不进循环**，
 * 「自动续期没工作、重启也还是 401」，而凭据本体可能完全健康。
 * 现在的口径：`refreshable` 只是**凭据材料的镜像**，每轮由凭据本体对账得出；
 * 缺材料才写 false，凭据齐全而被误写成 false 时本轮**自动改回 true（自愈）**。
 *
 * 本方法**不看 `enabled`**：停用只应影响账号池的自动选号，不该让凭据烂掉。
 */

import { Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountPool } from './account-pool.js'
import {
  refreshAccountWithReconcile,
  shouldRefreshNow,
  syncAccountExpiry,
  type ExpiryAccessors,
} from './expiry-sync.js'
import { SerialQueue } from './serial-queue.js'
import {
  GEMINI,
  GEMINI_OAUTH_TIMEOUT_MS,
  geminiAccountLabel,
  geminiCredentialExpiresAtMs,
  isGeminiRefreshable,
  parseGeminiCredential,
  type GeminiCredential,
  type GeminiProduct,
} from './gemini.js'
import {
  credentialFromGeminiGrant,
  fetchGeminiUserInfo,
  refreshGeminiCredential,
  startGeminiOAuthFlow,
  type StartedGeminiLoginFlow,
} from './gemini-oauth.js'
import { geminiNetworkHint } from './gemini-proxy.js'

/**
 * 把诊断提示接在一段文案后面（`undefined` 时不加任何东西）。
 *
 * ⚠️ **唯一实现**：`geminiNetworkHint` 有三个消费点，每处都要
 * 「有提示才加、没提示不加」这条小逻辑 —— 写成三份正是本仓库反复记录的那类漂移。
 */
function hintSuffix(hint: string | undefined): string {
  return hint === undefined ? '' : `；${hint}`
}

/**
 * 过期信息提取器（供共享实现 `refreshAccountWithReconcile` 用）。
 *
 * ⚠️ `identityOf` 的语义是「**凭据内容**」（这里取 access_token）而**不是** ref 名
 * —— 传 ref 名会恒匹配失败且**静默无报错**（`src/expiry-sync.ts` 记录的坑）。
 *
 * `refreshableOf` 是**诚实**的：Gemini 确实有 refresh 端点（`oauth2.googleapis.com/token`
 * 的 `refresh_token` grant），故提供它，让共享实现据此把池里的 `refreshable` 对账。
 */
export const GEMINI_EXPIRY_ACCESSORS: ExpiryAccessors<GeminiCredential> = {
  expiresAtOf: (credential) => geminiCredentialExpiresAtMs(credential),
  refreshableOf: (credential) => isGeminiRefreshable(credential),
  identityOf: (credential) => credential.access_token,
}

/** refresh_token 已失效，需要重新登录。 */
export class GeminiRefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    // ⚠️ `name` **必须**是 `'RefreshTokenExpiredError'`（与其余九个 provider 一致）。
    //
    // `src/refresh.ts` 的终态判据是结构化比较：
    //   `if (error.name === 'RefreshTokenExpiredError') return true`
    //   `return /refresh[_ ]?token/i.test(error.message)`
    //
    // 写成类名（`'GeminiRefreshTokenExpiredError'`）会让第一个分支**恒不命中**，
    // 只能靠第二个分支的**文案正则**兜底 —— 文案一改即静默退化成「可重试」，
    // `RefreshScheduler` 会无限重试一个永远不可能成功的续期。
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 认证服务选项。 */
export interface GeminiAuthOptions {
  /** 产品配置；默认 {@link GEMINI}。 */
  product?: GeminiProduct
  /** 服务名覆盖（默认由产品 id 派生为 `geminiAuth`）。 */
  serviceName?: string
  /**
   * ★★★ **登录专用**的按账号 fetcher（2026-11-26，issue #170）。
   *
   * ⚠️ 与 {@link fetchFor} **必须是两个入口**：
   * - `fetchFor`（推理 / 续期 / 探测）：`accountId` 是确定的，**不许借别人的出口**；
   * - `loginFetchFor`（`startLogin`）：新账号**还没落池** ⇒ 自己的代理必然为空
   *   ⇒ 必须能回落到「本 provider 任一已配代理的账号」，否则必需翻墙的用户**永远登录不上**。
   *
   * 不传 ⇒ 回落到 `fetchFor`（与改动前逐字节相同，单测替身不受影响）。
   */
  loginFetchFor?: (accountId: string) => typeof fetch
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 按**账号 id** 取 fetcher（Gitee issue IKLTZ2 的代理支持）。
   *
   * ⚠️ **为什么不是再给一个 `fetchImpl` 就够了**：登录与续期都可能发生在
   * **任意账号**上（`refreshAll` 逐账号、`refreshAccountCredential` 由 RPC
   * 指定账号），而代理是**账号维度**的 ⇒ 必须能按账号现取，不能构造时定一份。
   *
   * ⚠️ **优先于 `fetchImpl`**：测试注入的单替身要盖过生产接线，否则单测里的
   * `fetchImpl` 会被账号代理悄悄顶掉。
   */
  fetchFor?: (accountId: string) => typeof fetch
  /** 回调端口覆盖（0 = 动态端口，默认）。 */
  callbackPort?: number
}

/** 登录流程句柄（与 `gemini-oauth.ts` 同形，此处直接复用其类型）。 */
export type { StartedGeminiLoginFlow } from './gemini-oauth.js'

/** Gemini 认证服务。 */
export class GeminiAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: GeminiProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string

  /**
   * per-ref 续期互斥队列。
   *
   * ⚠️ 没有它时，「定时续期」与「按需续期」可能并发消费**同一份**
   * `refresh_token`：Google 对 refresh_token 有重放检测，交错请求会让其中一次
   * 拿到 `invalid_grant`，进而被误判成「终态失效」把好账号标死。
   */
  private readonly refreshQueues = new Map<string, SerialQueue>()
  /** 终态告警去重：同账号同服务端原因只告警一次。 */
  private readonly terminalWarned = new Map<string, string>()

  constructor(ctx: Context, private readonly options: GeminiAuthOptions = {}) {
    const product = options.product ?? GEMINI
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /**
   * 取某账号的 fetcher（Gitee issue IKLTZ2）。
   *
   * ⚠️ **空账号 id = 直连**：`refresh()` 的单凭据兜底路径拿不到账号 id，
   * 此时不查池（查了也是空）⇒ 退回全局 fetch。
   *
   * ⚠️ `fetchImpl`（单测替身）**优先**于 `fetchFor`：否则单测注入的替身会被
   * 生产接线里的账号解析器顶掉，用例就测不到真正被调用的那条腿了。
   */
  private fetcherFor(accountId: string): typeof fetch {
    if (this.options.fetchImpl !== undefined) return this.options.fetchImpl
    if (this.options.fetchFor !== undefined) return this.options.fetchFor(accountId)
    return fetch
  }

  /**
   * ★ 登录专用的 fetcher（issue #170）。
   *
   * ⚠️ **顺序**：`loginFetchFor` → `fetchFor` → `fetch`。
   * 前者的关键能力是「新账号没配代理时借用同类账号的出口」——
   * 少了它，必需翻墙的用户在 `startLogin` 阶段必然 `fetch failed`（浏览器却显示授权成功）。
   */
  private loginFetcherFor(accountId: string): typeof fetch {
    if (this.options.fetchImpl !== undefined) return this.options.fetchImpl
    if (this.options.loginFetchFor !== undefined) return this.options.loginFetchFor(accountId)
    if (this.options.fetchFor !== undefined) return this.options.fetchFor(accountId)
    return fetch
  }

  private queueFor(refName: string): SerialQueue {
    let queue = this.refreshQueues.get(refName)
    if (queue === undefined) {
      queue = new SerialQueue()
      this.refreshQueues.set(refName, queue)
    }
    return queue
  }

  private async readCredential(refName: string): Promise<GeminiCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    return parseGeminiCredential(resolved.value)
  }

  /** 按值比较两份凭据（引用比较恒不相等）。 */
  private sameCredential(a: GeminiCredential, b: GeminiCredential): boolean {
    return a.access_token === b.access_token
      && a.refresh_token === b.refresh_token
      && a.expiry === b.expiry
  }

  /**
   * 两步式登录：**立即**返回 `loginUrl`，浏览器回调完成后落定 `result`。
   *
   * ⚠️ 不能在这里阻塞等授权完成 —— 前端 `window.open` 只在
   * transient activation 窗口内有效（见 AGENTS.md「两步式登录」）。
   *
   * @param options.accountId **占位账号的 id**（Gitee issue IKLTZ2）：
   *   换 token 那一次请求必须能走该账号自己的代理，而登录开始时凭据还没落盘、
   *   只有池里的占位条目认得它。缺省则直连。
   */
  async startLogin(options: { accountId?: string } = {}): Promise<StartedGeminiLoginFlow> {
    const started = await startGeminiOAuthFlow({
      fetcher: this.loginFetcherFor(options.accountId ?? ''),
      ...this.options.callbackPort === undefined ? {} : { callbackPort: this.options.callbackPort },
      // 身份正常情况下从令牌响应的 `id_token` 解出（零额外请求）；这里的
      // userinfo 只是兜底。**兜底失败必须留日志** —— 2026-10-03 用户报障
      // 「昵称退化成池 id」时，失败被静默吞成 `{}`，现场零线索可查。
      onIdentityFailure: (reason) => {
        this.ctx.logger?.warn?.(
          `[gemini] 登录时兜底拉取账号身份失败（不影响登录，但昵称可能退化成账号 id）：${reason}`,
        )
      },
    })
    // 与 `cline-auth.ts` 同理：结果可能早于调用方 `await` 而落定，
    // 先挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
    started.result.catch(() => {})
    // 落盘交给调用方（RPC 的 `account.create` 分支要顺带回填 nickname/expiresAt/refreshable）。
    return started
  }

  /**
   * 落盘凭据（登录成功后调用）。
   *
   * ⚠️ 返回的 `accountId` 是 OIDC `sub` —— 它只适合当**稳定标识**
   *（换邮箱、改昵称都不影响），**不要**拿它拼展示名：`sub` 是 21 位数字，
   * 截前 8 位得到 `Gemini 10500520` 这种用户认不出的名字（2026-10-03 报障）。
   * 展示名走 `geminiAccountLabel`（邮箱优先，回退 `sub`）。
   */
  async persistLogin(
    credential: GeminiCredential,
    options: { refName: string },
  ): Promise<{ accountId?: string }> {
    await this.ctx.credentials.set(credentialRef(options.refName), JSON.stringify(credential))
    return credential.sub === undefined ? {} : { accountId: credential.sub }
  }

  /** 解析默认单凭据。 */
  private async resolveDefaultCredential(): Promise<GeminiCredential | undefined> {
    return await this.readCredential(this.credentialRefName)
  }

  /** 续期默认单凭据（批量续期表的兜底路径）。 */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) {
      throw new GeminiRefreshTokenExpiredError('凭据未配置，请先登录')
    }
    if (!isGeminiRefreshable(credential)) {
      throw new GeminiRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    const next = await this.refreshCredential(credential, '')
    await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next))
  }

  /**
   * 续期**指定 ref**（RPC `account.refresh` / 定时器）。
   *
   * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref。
   * ⚠️ **走共享实现 `refreshAccountWithReconcile`** —— 它保证「凭据仍有效」时
   * 也把池值对账（否则 UI 会永远显示「已过期」）。
   *
   * ⚠️ `accountId` **刻意不读 `refName`** 反查账号：账号 id 与 ref 名之间没有
   * 可逆映射（ref 由 RPC 随机生成），只能由调用方传入。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const id = accountId ?? ''
    await this.queueFor(refName).run(async () => {
      const credential = await this.readCredential(refName)
      if (credential === undefined) throw new Error('凭据未配置')
      if (!isGeminiRefreshable(credential)) {
        throw new GeminiRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
      }
      const ref = credentialRef(refName)
      // 无账号池时退化为「直接续期 + 落盘」（单凭据路径）。
      if (pool === undefined) {
        const next = await this.refreshCredential(credential, id)
        await this.ctx.credentials.set(ref, JSON.stringify(next))
        return
      }
      await refreshAccountWithReconcile({
        pool,
        provider: this.product.id,
        tag: `[${this.product.id}]`,
        accountId: id,
        credential,
        accessors: GEMINI_EXPIRY_ACCESSORS,
        refresh: (c) => this.refreshCredential(c, id),
        save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
        makeTerminalError: (message) => new GeminiRefreshTokenExpiredError(message),
        warn: (message) => this.ctx.logger?.warn?.(message),
        info: (message) => this.ctx.logger?.info?.(message),
      })
    })
  }

  /**
   * 批量续期所有 Gemini 账号。
   *
   * **包含已停用账号**：停用只应影响自动选号，不该让凭据烂掉 ——
   * 否则用户重新启用时只能重新登录。
   *
   * 单账号失败不影响其他账号，但**必须留日志**：静默失败会让账号在 UI 上
   * 仍显示「可续期」却永远刷不动，无从排查。
   *
   * ⚠️ 判据读**凭据**，不读账号池里的 `refreshable`（见文件头注释）。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      const ref = credentialRef(entry.credentialRef)
      let credential: GeminiCredential | undefined
      // ⚠️ 本账号这轮续期的 signal（IKLTZ2 审计 P2-2）：`refreshCredential`
      // 内部 arm 了 `AbortSignal.timeout(GEMINI_OAUTH_TIMEOUT_MS)`，而判据在
      // catch 里 ⇒ 必须经这个局部量把「是不是我们自己超时了」带出来，否则
      // 墙外连接超时（**不带** `UND_ERR_*` 码）拿不到任何提示。
      // ⚠️ **每个账号各有一个**（不是循环外共享）：共享会让 B 的日志引用 A 的 signal。
      let refreshSignal: AbortSignal | undefined
      try {
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          // 凭据确实不存在：这才是「不可续期」的真实含义（写盘前先判，避免每轮重复写）。
          if (entry.refreshable) await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        credential = parseGeminiCredential(resolved.value)
        if (credential === undefined || !isGeminiRefreshable(credential)) {
          if (entry.refreshable) await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        if (!entry.refreshable) {
          // 池里说不能续、凭据说能续 —— 以凭据为准。这里**只记日志不回写**：
          // 下面 `refreshAccountWithReconcile` 的有效期对账本来就会把它改回来，
          // 多写一次只会让账号列表多一次无谓的整体落盘。
          this.ctx.logger?.info?.(
            `[gemini] 账号 ${entry.id} 的凭据具备续期材料，本轮恢复自动续期（此前的标记与凭据不符）`,
          )
        }
        await refreshAccountWithReconcile({
          pool,
          provider: this.product.id,
          tag: `[${this.product.id}]`,
          accountId: entry.id,
          credential,
          accessors: GEMINI_EXPIRY_ACCESSORS,
          current: entry,
          refresh: (c) => this.refreshCredentialUnderLock(entry.credentialRef, c, entry.id, (s) => {
            refreshSignal = s
          }),
          save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
          makeTerminalError: (message) => new GeminiRefreshTokenExpiredError(message),
          warn: (message) => this.ctx.logger?.warn?.(message),
          info: (message) => this.ctx.logger?.info?.(message),
        })
      } catch (error) {
        if (error instanceof GeminiRefreshTokenExpiredError) {
          const detail = error instanceof Error ? error.message : String(error)
          // ⚠️ **判终态前先确认「我刚才用的那一份 refresh_token 还是不是当前那一份」**。
          // 并发下服务端拒的是**旧的**那一份（它已因别人的成功请求而失效），
          // 而磁盘上此刻躺着一份**新的、可用**的凭据。这属于「他处已续成功」，
          // 不是「本账号不能续期」—— 不加这层判据，一次交错就会把好账号永久标死。
          const latest = await this.readCredential(entry.credentialRef).catch(() => undefined)
          if (latest !== undefined
            && isGeminiRefreshable(latest)
            && credential !== undefined
            && latest.refresh_token !== credential.refresh_token) {
            this.ctx.logger?.info?.(
              `[gemini] 账号 ${entry.id} 续期被拒但凭据已被他处更新（并发重放），`
              + `按最新凭据对账，不标记为不可续期`,
            )
            await syncAccountExpiry({
              pool,
              provider: this.product.id,
              credential: latest,
              accessors: GEMINI_EXPIRY_ACCESSORS,
              accountId: entry.id,
              current: entry,
              tag: `[${this.product.id}]`,
              warn: (message) => this.ctx.logger?.warn?.(message),
            })
            continue
          }
          if (entry.refreshable) {
            try {
              await pool.updateAccount(entry.id, { refreshable: false })
            } catch {
              // 忽略 updateAccount 本身的错误
            }
          }
          const last = this.terminalWarned.get(entry.credentialRef)
          if (last !== detail) {
            this.terminalWarned.set(entry.credentialRef, detail)
            this.ctx.logger?.warn?.(
              `[gemini] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`
              + `；服务端原文：${detail}`,
            )
          }
        } else {
          // 非终态失败（网络抖动、5xx…）**必须留下日志**。
          // ⚠️ Gitee issue IKLTZ2：连不上 Google 时必须**点名代理**——
          // 缺了它，`fetch failed` 会退化成一句无信息量的话，用户与排障者都
          // 看不到「这需要代理」这个唯一出路（issue 原话：面板上完全看不出
          // 是网络/代理原因，用户只能看到授权失败）。
          this.ctx.logger?.warn?.(
            `[gemini] 账号 ${entry.id} 续期失败：`
            + `${error instanceof Error ? error.message : String(error)}`
            + hintSuffix(geminiNetworkHint(error, refreshSignal?.aborted === true)),
          )
        }
      }
    }
  }

  /**
   * 一次性修复**老账号**的展示名（与 `RaccoonAuth` / `TraeAuth` 同一模式）。
   *
   * 成因：2026-10-03 之前的版本在解析令牌响应时丢掉了 `id_token`，身份只剩
   * 「userinfo 那次跨域请求」这一个失败面；它一失败（且当时**静默吞异常**），
   * 凭据就只落了 token 而无 `sub`/`email`，`geminiAccountLabel` 返 `undefined`，
   * 账号昵称于是退化成一串池 id（`gemini-6a53dbca`），用户认不出是谁。
   *
   * 光改代码只影响**新登录**的账号，故这里在启动时主动补一次。
   *
   * ## 契约
   *
   * - **幂等**：昵称已是目标值时不算变化，不触发写入。
   * - **失败不阻塞**：逐账号 catch，任何异常只记 warn。
   * - **只读补字段**：最多发一次 userinfo GET（不续期、不换 token），
   *   且**拿不到就什么都不做** —— 绝不退回去用凭据里的池 id 重算昵称，
   *   那会覆盖掉用户在 Jet Hub 里手动改过的昵称。
   *
   * @returns 被修复的账号 id 列表（供日志）
   */
  async repairAccountNicknames(pool: AccountPool): Promise<string[]> {
    const repaired: string[] = []
    let entries: Awaited<ReturnType<AccountPool['listAccounts']>>
    try {
      entries = await pool.listAccounts(this.product.id)
    } catch {
      return repaired
    }

    for (const entry of entries) {
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) continue
        let credential = parseGeminiCredential(resolved.value)
        if (credential === undefined) continue

        // 缺身份时补一次 userinfo（只读 GET）。注意此处**不写日志失败**——
        // 老账号的 access_token 可能早已过期，拿不到是常态，不值得刷告警。
        if (geminiAccountLabel(credential) === undefined) {
          // ⚠️ **必须传 `signal`**（与 `refreshCredential` 同族的缺陷）：
          // `fetchGeminiUserInfo` 只在 `options.signal !== undefined` 时才设置
          //（`src/gemini-oauth.ts` 的 `if (options.signal !== undefined) init.signal = options.signal`），
          // 不传则这次 GET **完全没有超时**，卡住时只能等 undici 默认
          // `headersTimeout`（实测 305 秒）。本方法是启动期的账号修复循环，
          // 一个挂住的账号会把后面所有账号的修复一起拖住。
          //
          // ⚠️ signal 建在 try **之外**、错误在 catch 里判 ⇒ 它必须**跨 try 可见**
          //（IKLTZ2 审计 P2-2：原先 `aborted` 恒传字面量 `false`，于是这次自己
          // arm 的超时 —— 墙外连接超时的**主症状** —— 因不带 `UND_ERR_*` 码而
          // 拿不到任何提示；那形同「写进去却没人读」的死参数）。
          const userInfoSignal = AbortSignal.timeout(GEMINI_OAUTH_TIMEOUT_MS)
          try {
            const info = await fetchGeminiUserInfo(credential.access_token, {
              fetcher: this.fetcherFor(entry.id),
              signal: userInfoSignal,
            })
            if (info.sub !== undefined || info.email !== undefined) {
              credential = { ...credential }
              if (info.sub !== undefined) credential.sub = info.sub
              if (info.email !== undefined) credential.email = info.email
              await this.ctx.credentials.set(ref, JSON.stringify(credential))
            }
          } catch (error) {
            // ⚠️ 只读补字段，失败**不阻断**后面的流程（与文件头「失败不阻塞」约定
            // 一致）：拿不到身份就保持原样，绝不退回用池 id 重算昵称。
            this.ctx.logger?.debug?.(
              `[gemini] 账号 ${entry.id} 补拉账号身份失败（昵称将保持原样）：`
              + `${error instanceof Error ? error.message : String(error)}`
              + hintSuffix(geminiNetworkHint(error, userInfoSignal.aborted)),
            )
          }
        }

        const target = geminiAccountLabel(credential)
        // ⚠️ 只在**确实变化**时写账号池：`updateAccount` 是整体 replace，
        // 每次启动都写会平白落盘一次（同 Raccoon / Trae 的处理）。
        if (target !== undefined && target !== entry.nickname) {
          await pool.updateAccount(entry.id, { nickname: target })
          repaired.push(entry.id)
        }
      } catch (error) {
        // ⚠️ 这一层只覆盖**非网络**失败（凭据解析、池写入、userinfo 补字段
        // 之外的路径）—— userinfo 那一腿有自己的 catch（带 signal）。
        // 这里没有 arm 过超时 ⇒ `aborted` 恒为 false 是**如实**的（不是死参数）。
        this.ctx.logger?.warn?.(
          `[gemini] 修复账号 ${entry.id} 的显示名失败（不影响使用）：`
          + `${error instanceof Error ? error.message : String(error)}`
          + hintSuffix(geminiNetworkHint(error, false)),
        )
      }
    }
    return repaired
  }

  /**
   * 锁内续期：轮到自己时**重读**当前凭据，若已被他处续好就跳过本次请求。
   *
   * 队列只保证同一 ref 的续期串行，管不到「另一个进程/另一条路径刚刷完」；
   * 那种情况下再发一次请求会白白消费一次 refresh_token（Google 有重放检测）。
   */
  private async refreshCredentialUnderLock(
    refName: string,
    credential: GeminiCredential,
    accountId: string,
    onSignal?: (signal: AbortSignal) => void,
  ): Promise<GeminiCredential> {
    return await this.queueFor(refName).run(async () => {
      const latest = (await this.readCredential(refName)) ?? credential
      if (!this.sameCredential(latest, credential)
        && !shouldRefreshNow(GEMINI_EXPIRY_ACCESSORS.expiresAtOf(latest))) {
        this.ctx.logger?.info?.(
          '[gemini] 凭据已被他处续期，跳过本次续期请求（避免重复消费 refresh_token）',
        )
        return latest
      }
      return await this.refreshCredential(latest, accountId, onSignal)
    })
  }

  /**
   * 用 refresh_token 换取一份新凭据（**不触碰存储**）。
   *
   * 抽出来供 `refresh` / `refreshAccountCredential` / `refreshAll` 共用 ——
   * 一旦字段合并逻辑分叉，就会出现「某条路径丢了 sub/email」。
   *
   * @param accountId 该凭据所属账号（空串 = 直连，见 `fetcherFor`）。
   * @param onSignal 拿到本次请求 signal 的回调（IKLTZ2 审计 P2-2：调用方的
   *   catch 需要区分「我们自己超时了」与「上游报错」—— 前者才是墙外症状，
   *   而它**不带** `UND_ERR_*` 码，只能靠 `signal.aborted` 判）。
   */
  private async refreshCredential(
    credential: GeminiCredential,
    accountId: string,
    onSignal?: (signal: AbortSignal) => void,
  ): Promise<GeminiCredential> {
    const refreshToken = credential.refresh_token
    if (!refreshToken) {
      throw new GeminiRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    try {
      // ⚠️ **必须传 `signal`**（真实缺陷，对抗审计实测）：`refreshGeminiCredential`
      // 只在 `options.signal !== undefined` 时才把它交给 `postGeminiForm`
      //（`src/gemini-oauth.ts` 的 `if (signal !== undefined) init.signal = signal`），
      // 不传则这次 `fetch` **完全没有超时**，只能等 undici 默认的
      // `headersTimeout`（实测 **305 秒**）。
      //
      // 为什么这在本改动下变得关键：自愈把「续期」搬到了**用户点一下就等**的
      // 积分查询主路径，且逐账号 `await` —— 一个卡住的 gemini 续期会让整条
      // 积分行（乃至账号卡片）最长 5 分钟无响应；而其余九家都带 30~60s 超时。
      // 顺带修好了既有缺陷：`GEMINI_OAUTH_TIMEOUT_MS` 此前**零引用**（只有定义），
      // 现由本处用上。
      const signal = AbortSignal.timeout(GEMINI_OAUTH_TIMEOUT_MS)
      onSignal?.(signal)
      const grant = await refreshGeminiCredential(refreshToken, {
        fetcher: this.fetcherFor(accountId),
        signal,
      })
      // `credentialFromGeminiGrant` 保留 sub/email/cloudaicompanionProject，
      // 并在 Google 轮换 refresh_token 时回写新值。
      return credentialFromGeminiGrant(grant, credential)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/invalid_grant|invalid_client|expired|revoked|unauthorized/i.test(message)) {
        throw new GeminiRefreshTokenExpiredError('refresh_token 已失效，请重新登录')
      }
      throw error
    }
  }
}
