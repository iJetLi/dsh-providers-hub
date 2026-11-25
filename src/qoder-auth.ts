/**
 * Qoder 认证服务。
 *
 * 结构与 `src/lobsterai-auth.ts` / `src/buddy-auth.ts` **刻意保持一致**：
 * 同样的 `RefreshScheduler` 续期语义、同样的登出竞态保护、同样的
 * `refreshAll(pool)` 批量续期。这是本插件已被三个产品验证过的模式，
 * 复用它可以减少一类「某个 provider 的续期行为与众不同」的意外。
 *
 * 与 LobsterAI 侧的实质差异只有两处：
 *
 * 1. **没有客户端版本号**。LobsterAI 的 exchange/续期/签到都要带 `version`，
 *    Qoder 不需要，故本服务没有 `resolveClientVersion`。
 * 2. **续期载荷是 `{refresh_token, machine_id}`**，`machine_id` 必须随凭据
 *    持久化并原样回传（见 `qoderRefreshBody`）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  QODER_REQUEST_TIMEOUT_MS,
  QODER_REFRESH_PATH,
  applyQoderRefresh,
  isQoderExpired,
  isQoderRefreshable,
  parseQoderTokenPayload,
  qoderCredentialExpiresAtMs,
  qoderRefreshBody,
  type QoderCredential,
} from './qoder.js'
import { QODER, type QoderFallbackModel, type QoderProduct } from './qoder-product.js'
import { fetchQoderRemoteModels, mergeQoderAppOnlyModels } from './qoder-catalog.js'
import {
  runQoderLoginFlow,
  startQoderLoginFlow,
  type QoderLoginFlowOptions,
  type QoderLoginFlowResult,
} from './qoder-oauth.js'
import { RefreshScheduler } from './refresh.js'
import { AccountPool } from './account-pool.js'
import {
  refreshAccountWithReconcile,
  syncAccountExpiry,
  type ExpiryAccessors,
} from './expiry-sync.js'

/**
 * Qoder 凭据 → 账号池有效期所需的提取器（`refreshAll` 与按需续期共用一份）。
 *
 * `QoderAuth` 一个类服务两个产品（`qoder` / `qodercn`），故调用处的 tag 取
 * `this.product.id`，日志里能区分是哪个面板。
 *
 * ⚠️ `identityOf` 用 `access_token` 而**不是** `security_oauth_token`：
 * `AccountPool.findAccountIdByCredential` 对非 codearts 的 provider 比对的就是
 * `access_token`（见其 `identifierKey`），选错字段会恒匹配失败且静默。
 * Qoder 凭据里这两个字段是**双写同值**的（见 `QoderCredential` 注释），
 * 故取 `access_token` 与客户端的取用顺序（`security_oauth_token ?? access_token`）
 * 并不冲突。
 */
const QODER_EXPIRY_ACCESSORS: ExpiryAccessors<QoderCredential> = {
  expiresAtOf: qoderCredentialExpiresAtMs,
  refreshableOf: isQoderRefreshable,
  identityOf: (credential) => credential.access_token ?? '',
}

/**
 * Qoder 的默认凭据 ref。
 *
 * 等价于 `QODER.defaultCredentialRef`，保留此导出仅为兼容既有导入方；
 * 新代码请用 `QODER.defaultCredentialRef`。
 */
export const QODER_CREDENTIAL_REF = 'QODER_ACCESS_TOKEN'

/**
 * 续期被后端判定为终态（refresh_token 失效）时抛出的错误。
 *
 * 与其它 provider 的同名类**刻意是各自独立的类**：
 * `src/refresh.ts` 的 `isRefreshTokenExpired` 用 `error.name` 而非
 * `instanceof` 作判据，正是因为这些类跨模块 identity 不同。
 * 故这里也必须保证 `name` 恰为 `RefreshTokenExpiredError`。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 一次成功登录的结果。 */
export interface QoderLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 打开的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/** 用于配置界面的只读登录状态。 */
export interface QoderLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  /** 存储的凭据是否可通过刷新令牌静默续期。 */
  refreshable: boolean
  /** 最近一次刷新失败的原因（如有）。 */
  refreshError?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Qoder 的认证服务实例。
     *
     * 与 `buddyAuth` / `workbuddyAuth` / `codeartsAuth` / `lobsteraiAuth` 并列：
     * cordis 的 `Service` 构造时按名称注册，同名第二次注册会抛
     * `service "..." has been registered`，故每个 provider 各占一个服务名。
     */
    qoderAuth: QoderAuth
    /**
     * Qoder **中国版**的认证服务实例。
     *
     * 与 `qoderAuth` 是**两个独立实例**（同一 `QoderAuth` 类，不同 `product`），
     * 正如 `buddyAuth` 与 `workbuddyAuth`。服务名由 `${product.id}Auth` 派生，
     * 故不会与国际版撞名 —— 这也是 `id` 必须区分两站的原因。
     *
     * ⚠️ **键名必须由 product id 逐字拼出**：id 是 `qodercn`（**不带连字符、
     * 全小写**），故服务名是 `qodercnAuth`。本声明一度按变量名的驼峰惯例拼成了
     * 「Qoder + Cn + Auth」，与运行时注册名**大小写不符** ⇒ 按那个错名取服务
     * 恒得 `undefined`，而正确的 `ctx.qodercnAuth` 在 TS 里**不可见**
     * （2026-10-08 修正；因长期零读取者而未暴露）。
     * ⚠️ 同类陷阱见 `AGENTS.md` 的「provider id 一律纯小写字母」。
     */
    qodercnAuth: QoderAuth
  }
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
function parseCredential(value: string): QoderCredential | undefined {
  try {
    const parsed = JSON.parse(value) as QoderCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** `QoderAuth` 的构造选项。 */
export interface QoderAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /**
   * **按账号**取出口代理的 fetcher（真实报障 2026-10-21）。
   *
   * ⚠️ 国际版 `openapi.qoder.sh` 在本机被 SNI 阻断（TLS ClientHello 被丢），
   * 而**中国版**直连只要 160ms ⇒ 只能按账号配，不能用全局环境变量
   * （那会让中国版也一起去挤代理）。
   *
   * ⚠️ 不传 ⇒ 恒直连（与既有行为逐字一致，所有单测不受影响）。
   * ⚠️ 空账号 id（登录流程还没有账号）⇒ 由解析器去查
   * `QODER_PENDING_PROXY_KEY`（见 `src/qoder-proxy.ts`），否则「墙外环境下
   * 新建账号」是死锁：登录要代理，而代理要按已存在的账号配。
   */
  fetchFor?: (accountId: string) => typeof fetch
  /** 产品配置；默认 {@link QODER}。 */
  product?: QoderProduct
  /** 服务名覆盖（默认由产品 id 派生为 `qoderAuth`）。 */
  serviceName?: string
}

/**
 * Qoder 认证服务：PKCE 设备码登录 + refresh_token 静默续期。
 */
export class QoderAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: QoderProduct

  /** 本实例默认读写的凭据 ref 名称（`QODER_ACCESS_TOKEN`）。 */
  readonly credentialRefName: string

  private readonly scheduler = new RefreshScheduler(
    () => this.refresh(),
    (error) => {
      if (error instanceof RefreshTokenExpiredError) {
        // 失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。
        this.markRefreshTokenInvalid()
        return
      }
      this.lastRefreshError = error instanceof Error ? error.message : String(error)
    },
  )
  /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
  private refreshTokenInvalid = false
  private lastRefreshError: string | undefined
  /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
  private active = true

  constructor(ctx: Context, private readonly options: QoderAuthOptions = {}) {
    const product = options.product ?? QODER
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /**
   * 按**账号**取出口 fetcher（真实报障 2026-10-21）。
   *
   * ⚠️ 优先级与 `GeminiAdapter` 同款：`fetcher`（单测替身）> `fetchFor`（生产代理）
   * > 全局 `fetch`。单测想拦上游时只需传 `fetcher`，不必关心代理。
   *
   * ⚠️ **每次调用现取**而不是构造期固化：续期循环会在账号之间移动
   * （`refreshAll` 逐个账号），出口必须跟着换。
   *
   * ⚠️ `accountId` 允许为 `undefined`（登录流程还没有账号）：此时解析器会去查
   * `QODER_PENDING_PROXY_KEY`，那是墙外环境下「新建账号」的唯一出路。
   */
  private fetcherForAccount(accountId?: string): typeof fetch {
    if (this.options.fetcher !== undefined) return this.options.fetcher
    if (this.options.fetchFor !== undefined) return this.options.fetchFor(accountId ?? '')
    return fetch
  }

  /**
   * 同 {@link fetcherForAccount}，但**没有专门出口时返回 `undefined`**。
   *
   * 存在的理由：登录流程的两个 `runQoderLoginFlow` / `startQoderLoginFlow`
   * 调用点要把 fetcher **作为可选字段透传**（它们的 `fetcher` 缺省即全局
   * fetch）。若这里硬塞一个 `globalThis.fetch`，那些「未传即用默认」的
   * 分支会被改成「显式传入」，虽然行为等价，但会让替身注入的优先级
   * 与 `GeminiAdapter` 的写法不再对称，也让单测里「没传 fetcher」这件事
   * 变得不可表达。
   */
  private fetcherForAccountOrUndefined(accountId?: string): typeof fetch | undefined {
    if (this.options.fetcher !== undefined) return this.options.fetcher
    if (this.options.fetchFor !== undefined) return this.options.fetchFor(accountId ?? '')
    return undefined
  }

  /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false。 */
  private markRefreshTokenInvalid(): void {
    this.refreshTokenInvalid = true
    this.lastRefreshError = 'refresh_token 已失效，请重新登录'
  }

  /**
   * 运行完整登录流程并持久化凭据。
   *
   * `accountId` + `pool` 同时提供时，登录成功后自动把账号登记进账号池
   * （Jet Hub 的「+ 新建账号」路径）。
   */
  async login(
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } & Partial<QoderLoginFlowOptions> = {},
  ): Promise<QoderLoginResult> {
    this.active = true
    // ⚠️ 登录流程本身也要出口：`startQoderLoginFlow` 会先打设备码端点，
    // 墙外环境下没代理连登录都起不来（死锁：登录要代理，代理按已存在账号配）。
    // 此时 `accountId` 可能还是空的 ⇒ `fetcherForAccount('')` 会去查
    // `QODER_PENDING_PROXY_KEY`（见 `src/qoder-proxy.ts`）。
    const loginFetcher = this.fetcherForAccountOrUndefined(flowOptions.accountId)
    const flow = await runQoderLoginFlow({
      product: this.product,
      ...loginFetcher === undefined ? {} : { fetcher: loginFetcher },
      ...flowOptions,
    })
    return this.persistLogin(flow, flowOptions)
  }

  /**
   * **两步式登录**：立即返回登录 URL，由调用方先打开窗口。
   *
   * 与 CodeArts 的 `CodeArtsAuth.startLogin` / LobsterAI 的同名方法同因
   * （真实缺陷）：Jet Hub 的「+ 新建账号」原先调用阻塞式 {@link login}，
   * 而浏览器只在用户点击后的短暂窗口（transient activation，约 5 秒）内
   * 允许 `window.open`。等阻塞调用返回时手势早已过期，`window.open` 被
   * 弹窗拦截器拒绝并返回 `null`，前端兜底逻辑便执行
   * `window.location.href = loginUrl`，把**整个设置页**跳转到登录页。
   *
   * 调用方拿到 `loginUrl` 后应当**立即** `window.open`，再 await `result`。
   */
  async startLogin(
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } & Partial<QoderLoginFlowOptions> = {},
  ): Promise<{ loginUrl: string; result: Promise<QoderLoginResult>; close: () => Promise<void> }> {
    this.active = true
    const loginFetcher = this.fetcherForAccountOrUndefined(flowOptions.accountId)
    const started = await startQoderLoginFlow({
      product: this.product,
      ...loginFetcher === undefined ? {} : { fetcher: loginFetcher },
      ...flowOptions,
    })
    const result = started.result.then((flow) => this.persistLogin(flow, flowOptions))
    // 与 startQoderLoginFlow 同理：结果可能早于调用方 await 而落定，
    // 先挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
    result.catch(() => {})
    return { loginUrl: started.loginUrl, result, close: started.close }
  }

  /**
   * 持久化一次登录结果：写凭据、重置失效状态、武装续期、按需登记账号池。
   *
   * 抽成独立方法供 {@link login} 与 {@link startLogin} 共用 ——
   * 两条路径的差别只在「何时返回 loginUrl」，落库逻辑必须完全一致。
   */
  private async persistLogin(
    flow: QoderLoginFlowResult,
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } = {},
  ): Promise<QoderLoginResult> {
    const ref = flowOptions.refName ? credentialRef(flowOptions.refName) : credentialRef(this.credentialRefName)
    await this.ctx.credentials.set(ref, flow.access)
    this.refreshTokenInvalid = false
    this.lastRefreshError = undefined
    this.scheduleRefresh()
    const credential = parseCredential(flow.access)
    // 多账号：accountId 提供时自动注册到 pool
    if (flowOptions.accountId !== undefined && flowOptions.pool !== undefined) {
      await flowOptions.pool.addAccount({
        id: flowOptions.accountId,
        provider: this.product.id,
        nickname: credential?.nickname !== undefined && credential.nickname.length > 0
          ? credential.nickname
          : flowOptions.accountId,
        enabled: true,
        credentialRef: flowOptions.refName ?? this.credentialRefName,
        createdAt: Date.now(),
        expiresAt: credential ? qoderCredentialExpiresAtMs(credential) : undefined,
        refreshable: credential !== undefined && isQoderRefreshable(credential),
      })
    }
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: flow.refreshable,
    }
  }

  /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
  async status(): Promise<QoderLoginStatus> {
    const ref = credentialRef(this.credentialRefName)
    const info = await this.ctx.credentials.describe(ref)
    if (!info.configured) return { configured: false, refreshable: false }
    let expiresAt: number | undefined
    let refreshable = false
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved) {
      const credential = parseCredential(resolved.value)
      if (credential) {
        expiresAt = qoderCredentialExpiresAtMs(credential)
        refreshable = isQoderRefreshable(credential) && !this.refreshTokenInvalid
      }
    }
    return {
      configured: true,
      source: info.source,
      expiresAt,
      refreshable,
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /**
   * 静默续期：`refresh_token` + `machine_id` 换取新令牌。
   *
   * 终态判定：
   * - HTTP 401/403、或响应缺 token → 抛 {@link RefreshTokenExpiredError}，
   *   让调度器停止续期；
   * - 其余错误（网络抖动、5xx、429）→ 抛普通 Error，走调度器的可重试路径。
   */
  async refresh(): Promise<void> {
    const ref = credentialRef(this.credentialRefName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('未配置凭据，请先登录')
    const credential = parseCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isQoderRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    try {
      const refreshed = await this.refreshCredential(credential)
      // 登出竞态保护：在途刷新期间已 logout()/stop() 时，跳过凭据回写与调度武装，
      // 避免已登出的凭据被在途刷新复活。
      if (!this.active) return
      await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
      this.refreshTokenInvalid = false
      this.lastRefreshError = undefined
      this.scheduleRefresh()
    } catch (error) {
      if (error instanceof RefreshTokenExpiredError) this.markRefreshTokenInvalid()
      throw error
    }
  }

  /**
   * 按凭据 ref 续期**指定账号**的凭据。
   *
   * 与 {@link refresh} 的区别（与 `BuddyAuth.refreshAccountCredential` 同因）：
   * `refresh()` 读写本实例的默认单凭据 ref（`QODER_ACCESS_TOKEN`），
   * 而 Jet Hub 账号卡片对应的是 `QODER_ACCOUNT_XXX` ——
   * 用 `refresh()` 刷账号池里的账号，实际刷的是另一个凭据。
   *
   * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
   * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
   *
   * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT 的真实缺陷）：
   * UI 账号卡片的「有效期」读的正是池里的值，而不是凭据里 access_token 的真实
   * 过期时间。早期这里只 `credentials.set`，于是调用 `account.refresh` 后凭据确实续好了、
   * 界面却**一直显示「已过期」**，且没有任何自救手段（「重测」按钮的 refresh
   * 是刻意的 no-op）。
   *
   * @param pool 账号池；提供时会把新 `expiresAt` / `refreshable` 写回。
   * @param accountId 账号 id。**调用方已知时请显式传入** ——
   *   否则只能按凭据内容反查（代价高，且反查会跳过已停用账号）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isQoderRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    const refreshed = await this.refreshCredential(credential, accountId)
    await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential: refreshed,
      accessors: QODER_EXPIRY_ACCESSORS,
      accountId,
      tag: `[${this.product.id}]`,
      warn: (message) => this.ctx.logger?.warn?.(message),
    })
  }

  /**
   * 对一份凭据执行一次续期并返回新凭据（不触碰存储）。
   *
   * 抽出来供 `refresh()` 与 `refreshAll()` 共用，避免两处各写一遍
   * 「发请求 → 判终态 → 合并字段」的逻辑而逐渐分叉。
   *
   * @param accountId 该凭据所属的账号 id（**决定走哪条出口代理**）。
   *   不传 ⇒ 登录预置那条（`QODER_PENDING_PROXY_KEY`）或直连。
   */
  private async refreshCredential(
    credential: QoderCredential,
    accountId?: string,
  ): Promise<QoderCredential> {
    let response: Response
    try {
      response = await this.fetcherForAccount(accountId)(`${this.product.openApiBase}${QODER_REFRESH_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': `${this.product.userAgentPrefix}/1.0.0`,
        },
        body: JSON.stringify(qoderRefreshBody(credential)),
        signal: AbortSignal.timeout(QODER_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      // 传输层失败：**不能**判为终态 —— 网络抖动不该让用户重新登录。
      // 用普通 Error 让 RefreshScheduler 安排重试。
      throw new Error(`Qoder 续期网络失败：${error instanceof Error ? error.message : String(error)}`)
    }

    if (response.status === 401 || response.status === 403) {
      throw new RefreshTokenExpiredError(`Qoder 续期被拒绝（HTTP ${response.status}），请重新登录`)
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      throw new Error(`Qoder 续期响应不是 JSON（HTTP ${response.status}）`)
    }

    if (!response.ok) {
      // 非 401/403 的失败（5xx、429…）属可重试，交给调度器。
      const detail = JSON.stringify(parsed).slice(0, 200)
      throw new Error(`Qoder 续期失败（HTTP ${response.status}）：${detail}`)
    }

    const payload = parseQoderTokenPayload(parsed)
    if (payload.accessToken.length === 0) {
      // 拿到 200 却没有 token：视为无法续期（需重新登录），
      // 而不是当成可重试的瞬时故障。
      throw new RefreshTokenExpiredError('续期响应缺少访问令牌，请重新登录')
    }
    return applyQoderRefresh(credential, payload)
  }

  /**
   * 批量续期本产品的所有账号。
   *
   * **包含已停用账号**（只按 `refreshable` 过滤）：停用只应影响账号池的自动
   * 选号，不该让凭据烂掉 —— 否则用户重新启用时只能重新登录。
   * 详见 `BuddyAuth.refreshAll` 的注释（同一缺陷）。
   * 单账号失败不影响其他账号（与 `BuddyAuth.refreshAll` 同语义）。
   *
   * ⚠️ **lead-time 过滤**（issue !IKIRTT）：早先这里是**无条件全量续期** ——
   * 定时器每 30 分钟就把每个账号的 refresh_token 轮换一次，与「凭据还剩多久」
   * 无关。现复用单凭据时代 `REFRESH_LEAD_MS` 的语义：**距过期不足 1 小时才刷**。
   * 跳过的账号仍会做一次**有效期对账**（见 `refreshAccountWithReconcile`），
   * 因为「不刷」与「不回写池值」正是 UI 假过期的两个来源，必须分开处理。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      if (!entry.refreshable) continue
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const credential = parseCredential(resolved.value)
        if (!credential || !isQoderRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        await refreshAccountWithReconcile({
          pool,
          provider: this.product.id,
          // tag 取 product.id：本类一个实例服务 qoder 与 qodercn 两个面板。
          tag: `[${this.product.id}]`,
          accountId: entry.id,
          credential,
          accessors: QODER_EXPIRY_ACCESSORS,
          current: entry,
          // ⚠️ **必须把 `entry.id` 传下去**（真实缺口，2026-10-21 随代理接线发现）：
          //    `refreshCredential` 用它选出口代理。漏传 ⇒ 每次续期都退到
          //    `QODER_PENDING_PROXY_KEY` 或直连 ⇒ 墙外环境下**续期恒失败**，
          //    而失败被归为「可重试」⇒ 用户看到的是「账号一直显示可续期却永远
          //    刷不动」，与代理完全无关的表象（最难查的一类）。
          refresh: (c) => this.refreshCredential(c, entry.id),
          save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
          makeTerminalError: (message) => new RefreshTokenExpiredError(message),
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false })
          } catch {
            // 忽略 updateAccount 本身的错误
          }
          this.ctx.logger?.warn?.(
            `[${this.product.id}] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`,
          )
        } else {
          // 非终态失败（网络抖动、5xx、429…）：**必须留下日志**。
          // 静默失败会让账号在 UI 上仍显示「可续期」却永远刷不动，无从排查。
          this.ctx.logger?.warn?.(
            `[${this.product.id}] 账号 ${entry.id} 续期失败（将按调度器策略重试）: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // 单账号失败不中断循环
      }
    }
  }

  /**
   * 拉取**远端模型目录**（`/api/v2/model/list?Encode=1`）。
   *
   * ## 为什么由 auth 服务做，而不是让适配器自己解析凭据
   *
   * 适配器手上的取凭据入口是 `resolveCredential`，而它**有副作用**：
   * 选中账号时会 `reportAccount(id)`（`index.ts` 的接线把它写成
   * `activeQoderAccountId.set(...)`，用于额度报错时标记「本次实际使用的账号」）。
   * 目录请求是**周期性**的（20 分钟刷新器 + 冷启动预热 + 每次列模型），
   * 若走同一条路，它会在聊天请求选号之后把那个 Map **改写成目录用的账号**
   * ⇒ 额度标记可能落到**无辜账号**上（`index.ts` 那段注释逐字警告过这个后果）。
   *
   * 故照其余 11 家的形态：目录取数只做**池的只读读取**
   * （`getAvailableAccount`，不写任何账），池空时回退本实例的默认 ref。
   *
   * ## 语义
   *
   * - 失败 / 未登录 / 形状不符一律返回 **`[]`**，由调用方回退编译期兜底表
   *   （与 `AccioAuth.fetchModels` / `TraeAuth.fetchModels` 同语义）；
   * - 「没有凭据」**不打日志**（未登录用户每次列模型都会走到这里）；
   * - 真正的失败（HTTP 非 2xx / 网络异常 / WASM trap）必须留痕 ——
   *   否则「倍率不更新」这个症状没有任何可查的证据。
   *
   * ⚠️ **整段（含取凭据）都必须在 `try` 内**（缺陷，2026-10-20 对抗审计）：
   * 原先只有「拉目录」被 `try` 罩住，而 `pool.getAvailableAccount` 的 `await`
   * 在它**外面** —— 池读一旦 reject（存储损坏 / 并发写坏档），rejection 会
   * **直接抛穿 `fetchModels`**，绕开「失败即回退兜底表」这条契约，把一次目录
   * 读取失败升级成 `listModels` 抛错（DSH 侧表现为 provider 报错）。
   * 变异验证：删掉那一行 `.catch(() => null)` 后 111 条用例**全绿** ⇒ 这条腿
   * 当时**零守卫**；现已补「池读 reject」用例并把整段收进 `try`。
   */
  async fetchModels(pool?: AccountPool): Promise<QoderFallbackModel[]> {
    try {
      let credential: QoderCredential | undefined
      let accountId: string | undefined
      if (pool !== undefined) {
        const available = await pool
          .getAvailableAccount<QoderCredential>(this.product.id, '')
          .catch(() => null)
        if (available !== null) {
          credential = available.credential
          accountId = available.entry.id
        }
      }
      credential ??= await this.resolveStoredCredential()
      if (credential === undefined) return []
      // ⚠️ 模型目录端点也在 `openapi.qoder.sh` 上 ⇒ 墙外环境下没有代理时
      // 恒失败、列表退用内置兜底表（看上去像「倍率从不更新」）。
      // 代理按**账号**取：池里可能同时有国际版（需要）与中国版（不需要）。
      const modelFetcher = this.fetcherForAccountOrUndefined(accountId)
      const fetchOptions = modelFetcher === undefined ? {} : { fetcher: modelFetcher }

      // 第一腿保留已验证的 CLI 目录与旧兜底语义。
      let cliModels: QoderFallbackModel[] = []
      let cliError: unknown
      try {
        cliModels = await fetchQoderRemoteModels(credential, this.product, fetchOptions)
      } catch (error) {
        cliError = error
      }

      // 第二腿只探测桌面 app 目录，不改 search / 常规模型的 client metadata。
      // 空 app 目录是账号资格结果（例如 Teams/Enterprise），不算 transport 错误。
      let appModels: QoderFallbackModel[] = []
      let appError: unknown
      if (this.product.appClientMetadata !== undefined) {
        try {
          appModels = await fetchQoderRemoteModels(credential, this.product, {
            ...fetchOptions,
            metadata: this.product.appClientMetadata,
            allowEmpty: true,
          })
        } catch (error) {
          appError = error
        }
      }

      const appHungerG = mergeQoderAppOnlyModels(cliModels, appModels)
        .filter((model) => model.requiresAppIdentity)
      const baseModels = cliModels.length > 0
        ? cliModels
        : (appHungerG.length > 0 ? this.product.fallbackModels : [])
      const models = mergeQoderAppOnlyModels(baseModels, appModels)
      const cliIdsForLog = cliModels.map((model) => model.id).sort()
      const appIdsForLog = appModels.map((model) => model.id).sort()
      const appOnlyIdsForLog = models.filter((model) => model.requiresAppIdentity).map((model) => model.id)
      this.ctx.logger?.info?.(
        `[${this.product.id}] 模型目录 CLI=${cliModels.length} [${cliIdsForLog.join(',')}]; `
        + `app=${appModels.length} [${appIdsForLog.join(',')}]; app-only=[${appOnlyIdsForLog.join(',')}]`,
      )

      if (cliError !== undefined && models.length > 0) {
        this.ctx.logger?.warn?.(
          `[${this.product.id}] CLI 模型目录不可用，app-only HungerG 仍保留，常规模型使用静态兜底表：`
          + (cliError instanceof Error ? cliError.message : String(cliError)),
        )
      }
      if (appError !== undefined) {
        // Missing app entitlement/network must not hide or error out the normal CLI catalog.
        this.ctx.logger?.warn?.(
          `[${this.product.id}] app-only catalog probe failed; CLI models remain independent: `
          + (appError instanceof Error ? appError.message : String(appError)),
        )
      }
      if (models.length === 0) {
        if (cliError !== undefined) throw cliError
        if (appError !== undefined) throw appError
      }
      return models
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[${this.product.id}] 远端模型目录读取失败，模型列表将退用内置兜底表：`
        + (error instanceof Error ? error.message : String(error)),
      )
      return []
    }
  }

  /**
   * 移除已存储的凭据并停止任何待处理的刷新。
   */
  async logout(): Promise<void> {
    // 先置 inactive，再清凭据：在途刷新完成后不得回写/重新武装调度。
    this.active = false
    this.scheduler.stop()
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
  }

  /** 停止刷新调度（不清理凭据）。 */
  stop(): void {
    this.active = false
    this.scheduler.stop()
  }

  /** 启动时若已有可刷新凭据则安排续期（由 apply 调用）。 */
  scheduleRefresh(): void {
    void this.ctx.credentials.resolve(credentialRef(this.credentialRefName)).then((resolved) => {
      if (!resolved) return
      const credential = parseCredential(resolved.value)
      if (!credential || !isQoderRefreshable(credential)) return
      const expiresAt = qoderCredentialExpiresAtMs(credential)
      if (expiresAt !== undefined) this.scheduler.arm(expiresAt)
    })
  }

  /** 从存储重载凭据，返回是否已过期（供 UI 判断是否需要提示重新登录）。 */
  async checkExpired(): Promise<boolean> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return true
    const credential = parseCredential(resolved.value)
    return credential === undefined ? true : isQoderExpired(credential)
  }

  /**
   * 解析本实例默认凭据 ref 下的凭据；不可用时返回 undefined。
   *
   * 供 e2e 探针与 `account-probe` 使用。
   */
  async resolveStoredCredential(): Promise<QoderCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return undefined
    return parseCredential(resolved.value)
  }
}
