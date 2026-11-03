/**
 * MonkeyCode 认证服务：**凭据保管与有效期对账**（浏览器登录 + 手工 Key 两条入口，无续期）。
 *
 * ## 与 qiniu 同型：没有 OAuth、不能续期 —— 但**有浏览器登录**
 *
 * 两种凭据都是用户在 MonkeyCode 平台（或桌面客户端）里**手工生成**的静态材料：
 *
 * - 白泽 `sk-…`：平台「API Keys」页生成；
 * - 网关 `oma_…` + `signing_secret`：平台「OhMyAgent」页生成。
 *
 * 既没有 OAuth 授权页，也没有 refresh 端点 ⇒ 不实现 `login()` / `startLogin()`，
 * **但实现了 `loginViaBrowser()`**（四审 H-2 更正：本节此前写成「无登录、入口是
 * 粘贴 Key 弹窗、不跳浏览器」，与本文件 `loginViaBrowser()` 的实现完全相反）。
 *
 * 两条入口并存，**浏览器登录是主路径**：
 *
 * - **主路径** — `account.create { mode: 'browser' }` ⇒ `loginViaBrowser()` 自己开窗、
 *   读 `monkeycode_ai_session` cookie（HttpOnly，`document.cookie` 拿不到），
 *   由宿主 `src/jet-hub-rpc.ts` 调用。一次能拿齐 `oma_…` Key + `signing_secret`
 *   + session cookie ⇒ 积分 / 额度 / 签到都有数据。
 * - **备用路径** — 面板上的**粘贴 Key 弹窗** ⇒ `monkeycode.addAccount`，同步一步
 *   完成（写凭据 + 落账号条目）。缺 session cookie 时积分与签到不可用，可事后
 *   点卡片上的「改 Key」只补这一栏。
 *
 * ⚠️ 注意与「两步式登录」的区别：`account.create` 的两步式（先返回 `loginUrl`
 * 再异步回填）是给**浏览器 OAuth** 那一类用的；本 provider 的浏览器登录走的是
 * `ChromiumSession` 读 cookie，不是 OAuth 回调。
 *
 * ## `refreshAll()` 只看凭据、**不看 `enabled`**
 *
 * 本仓库铁律：停用只影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关。
 * 本 provider 没有网络请求可发（静态材料），但**接口形态必须与其余 provider
 * 一致** —— 否则将来上游若推出 refresh 端点，这里会成为一个单向门。
 *
 * ## 服务名
 *
 * 由产品 id 派生为 `monkeycodeAuth`（cordis 的 `Service` 同名二次注册会抛错，
 * 故每个 provider 各占一个服务名）。
 *
 * @module src/monkeycode-auth.ts
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'

import {
  isMonkeycodeExpired,
  monkeycodeCredentialExpiresAtMs,
  monkeycodeIdentityOf,
  type MonkeycodeCredential,
} from './monkeycode.js'
import { MONKEYCODE, type MonkeycodeProduct } from './monkeycode-product.js'
import {
  MONKEYCODE_BROWSER_LOGIN_TIMEOUT_MS,
  startMonkeycodeBrowserLogin,
  type MonkeycodeBrowserLogin,
  type MonkeycodeBrowserLoginStartOptions,
} from './monkeycode-browser-login.js'
import { exchangeMonkeycodeSessionForKey, fetchMonkeycodeProfile, isMonkeycodeSessionExpiredError } from './monkeycode-credits.js'
import { AccountPool } from './account-pool.js'
import { syncAccountExpiry, type ExpiryAccessors } from './expiry-sync.js'

/**
 * 「会话还没生效」之后的重试间隔（毫秒）。
 *
 * ⚠️ 不要调成 0：这个重试的等待对象是**用户本人**（在浏览器窗口里输账号密码），
 * 每秒几次的空转会白白打爆 `POST /api/v1/users/ohmyagent/api-keys`。
 */
const SESSION_RETRY_MS = 3_000

/** 极简延时（不引第三方 sleep，也不依赖 `chromium-session` 的内部实现）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, Math.max(0, ms)) })
}

/**
 * MonkeyCode 凭据 → 账号池有效期的提取器。
 *
 * ⚠️ **刻意不提供 `refreshableOf`**：`isMonkeycodeRefreshable` **恒为 `false`**
 * （上游没有 refresh 端点，这是**诚实标记**）。若让共享实现据此回写池里的
 * `refreshable`，会把「账号落池时明确写 false」变成「每轮对账都写一次」
 * ——语义没错，但会让整个账号列表每 30 分钟落盘一次
 * （`syncAccountExpiry` 的「变了才写盘」短路失效）。与 qiniu / loomy 同处理。
 */
const MONKEYCODE_EXPIRY_ACCESSORS: ExpiryAccessors<MonkeycodeCredential> = {
  expiresAtOf: monkeycodeCredentialExpiresAtMs,
  // ⚠️ `ExpiryAccessors.identityOf` 要求 `string`（不是 `string | undefined`）：
  // 共享实现的「凭据身份变了 ⇒ 回写」判据不接受缺失身份。而
  // `parseMonkeycodeCredential` 已保证 `access_token` 非空，故这里的兜底
  // 空串**实际不可达**，只是为了满足类型。
  identityOf: (credential) => monkeycodeIdentityOf(credential) ?? '',
}

/** 用于 Jet Hub 面板的只读登录状态。 */
export interface MonkeycodeLoginStatus {
  configured: boolean
  /**
   * 恒为 `'api-key'` —— 注意这里**不是**「用户手工粘贴」的意思（2026-11-02 五审更正）：
   * 上游既没有 OAuth 授权页也没有 refresh 端点，浏览器登录拿到的同样是一把
   * `oma_…` 静态 Key ⇒ 两种来源在凭据结构上无从分辨，一律标 `api-key`。
   */
  source?: string
  expiresAt?: number
  /** 恒为 `false`（上游没有续期机制）。 */
  refreshable: boolean
  /** 最近一次对账失败的原因（如有）。 */
  refreshError?: string
  /**
   * 凭据里是否带了平台会话 cookie。
   *
   * ⚠️ 这**不影响推理可用性**，只决定「额度 / 积分 / 签到」能不能查。
   * 单独暴露它是为了让面板能显示「未配置会话」而不是一个空洞的
   * 「查询失败」——两者对用户的行动指引完全不同。
   */
  hasSession?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** MonkeyCode 的认证服务实例。 */
    monkeycodeAuth: MonkeycodeAuth
  }
}

/**
 * 从存储值解析凭据 JSON；解析失败返回 undefined。
 *
 * ⚠️ 只校验主键 `access_token` 是非空字符串，**不校验前缀**：
 * 白泽 `sk-` / 网关 `oma_` 之外，上游将来可能加新前缀；把前缀写死成
 * 白名单会让新 Key 直接被判「凭据不完整」（opencode 的 IKPLRU 教训）。
 * 形状是否可用留给请求层（它会给出真实的 HTTP 错误）。
 */
export function parseMonkeycodeCredential(value: string): MonkeycodeCredential | undefined {
  try {
    const parsed = JSON.parse(value) as MonkeycodeCredential
    if (typeof parsed !== 'object' || parsed === null) return undefined
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** `MonkeycodeAuth` 的构造选项。 */
export interface MonkeycodeAuthOptions {
  /** 产品配置；默认 {@link MONKEYCODE}。 */
  product?: MonkeycodeProduct
  /** 服务名覆盖（默认由产品 id 派生为 `monkeycodeAuth`）。 */
  serviceName?: string
  /**
   * 浏览器登录工厂（**单测唯一该注入的东西**；生产缺省
   * {@link startMonkeycodeBrowserLogin}，即真起一个可见窗口）。
   *
   * ⚠️ 缺省值**不要**在单测里被调用 —— 那会真的拉一个 Chromium 起来。
   */
  browserLoginFactory?: (options: MonkeycodeBrowserLoginStartOptions) => Promise<MonkeycodeBrowserLogin>
  /**
   * 会话换网关凭据的原语（单测注入；生产缺省
   * {@link exchangeMonkeycodeSessionForKey}）。
   */
  exchangeKey?: typeof exchangeMonkeycodeSessionForKey
  /**
   * 平台用户资料读取（单测注入；生产缺省
   * {@link fetchMonkeycodeProfile}）。
   *
   * ⚠️ 必须有注入点：它是登录成功后额外一次**真网络请求**，单测若不注入就会
   * 真发到 `monkeycode-ai.com`（本仓库红线「单测不许发真网络」；本轮实测
   * 一条用例因此从 2ms 变成 4.4s）。
   */
  profileOf?: typeof fetchMonkeycodeProfile
}

/**
 * MonkeyCode 认证服务：**凭据保管与有效期对账**（浏览器登录 + 手工 Key 两条入口，无续期）。
 */
export class MonkeycodeAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: MonkeycodeProduct
  /** 本实例默认读写的凭据 ref 名称（`MONKEYCODE_ACCESS_TOKEN`）。 */
  readonly credentialRefName: string
  private readonly browserLoginFactory: (options: MonkeycodeBrowserLoginStartOptions) => Promise<MonkeycodeBrowserLogin>
  private readonly exchangeKey: typeof exchangeMonkeycodeSessionForKey
  private readonly profileOf: typeof fetchMonkeycodeProfile
  /**
   * 本实例是否仍在服役（登出 / 插件被停用时置 false）。
   *
   * ⚠️ 与 `magicrew-auth.ts` 同因：等用户登录是**分钟级**的，期间插件可能已被停用
   * 或账号已被删除。那个在途的登录若照常返回凭据，就会把一个**已停用插件的凭据**
   * 写进库 —— 之后没人续期、也没人展示它。
   */
  private active = true

  constructor(ctx: Context, options: MonkeycodeAuthOptions = {}) {
    const product = options.product ?? MONKEYCODE
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
    this.browserLoginFactory = options.browserLoginFactory ?? startMonkeycodeBrowserLogin
    this.exchangeKey = options.exchangeKey ?? exchangeMonkeycodeSessionForKey
    this.profileOf = options.profileOf ?? fetchMonkeycodeProfile
  }

  /**
   * **网页版登录**：开一个独立 profile 的浏览器窗口，用户在官方页面上登录后，
   * 插件自动读 `monkeycode_ai_session` 并用它换一对网关凭据。
   *
   * ## 为什么这才是「跟插件搭」的那条路
   *
   * 用户明确要求（2026-11-02）：「新建账号是浏览器登录」。手工粘三格
   * （API Key / Signing Secret / Session Cookie）被判为不符合插件范式 ——
   * 尤其 cookie 是 HttpOnly 的，用户**在浏览器里根本拿不到它**。
   *
   * ## 返回 `undefined` 的两种情形（都**不是**异常）
   *
   * 1. 用户没登完就关了窗口 / 等满 `timeoutMs`；
   * 2. 等待期间本插件被停用（`this.active` 转 false）—— 同
   *    `refreshAccountCredential` 那道闸门，不能把已停用插件的凭据写进库。
   *
   * ## 抛错的唯一情形
   *
   * 已读到会话，但**换凭据失败**（`POST /api/v1/users/ohmyagent/api-keys` 拒绝 / 网络异常）。
   * 此时**不能**退化成「只有 cookie 的账号」：那种账号查得到额度却完全不能推理，
   * 在面板上长得像「已配置」而用户一用就 error —— 比明确报错更糟。
   *
   * @param options.timeoutMs 等用户登录的上限（缺省 240 秒）。
   */
  async loginViaBrowser(
    options: { timeoutMs?: number } = {},
  ): Promise<MonkeycodeCredential | undefined> {
    const timeoutMs = options.timeoutMs ?? MONKEYCODE_BROWSER_LOGIN_TIMEOUT_MS
    const login = await this.browserLoginFactory({
      product: this.product,
      timeoutMs,
      ...this.ctx.logger === undefined ? {} : { log: (message: string) => this.ctx.logger?.info?.(message) },
    })
    try {
      const deadline = Date.now() + timeoutMs
      let lastSessionError: string | undefined
      while (Date.now() < deadline) {
        const cookie = await login.waitForSessionCookie(deadline - Date.now())
        if (cookie === undefined) return undefined
        // ⚠️ 回来时**再判一次**：等用户登录是分钟级的，期间插件可能已被停用/登出。
        if (!this.active) return undefined
        /**
         * ⚠️⚠️ **第三个参数 `product` 绝不能省**（2026-11-02 国际站真机踩到）：
         * `exchangeMonkeycodeSessionForKey(cookie, deps, product = MONKEYCODE)` 的
         * `product` 缺省是**国内站**。国际站的窗口读到的 cookie 打到 `.com` 的
         * `/api/v1/users/ohmyagent/api-keys` ⇒ 恒 401 ⇒ 被判成「还没登进去」⇒
         * 一路重试到 240 秒超时，而窗口里明明已经登录成功、账号卡永远停在
         * 「凭据未配置」。实测：同一个 cookie 打 `.net` 是 200 并签发 oma_ 凭据，
         * 打 `.com` 是 401 —— 差别**只在这个参数**。
         */
        const issued = await this.exchangeKey(cookie, {
          ...this.ctx.logger === undefined
            ? {} : { warn: (message: string) => this.ctx.logger?.warn?.(message) },
        }, this.product)
        if (issued.ok) {
          // ⚠️⚠️ **稳定的 `user_id` 必须取自 `/users/status`，不能取兑换响应的
          // `id`**（2026-11-03 真机取证：同一账号连续兑换两次，`id` 从
          // `2b37a3dd…` 变成 `0848857d…`，而 `data.user.id` 恒为 `01a19fa3…`）。
          // 取错会让「同一账号第二次浏览器登录」被判成新账号（重复卡片 + 多签发
          // Key），也会让邀请链接拼出一个无效的 `?ic=`。
          const profile = await this.profileOf(cookie, this.product, {
            ...this.ctx.logger === undefined
              ? {} : { warn: (message: string) => this.ctx.logger?.warn?.(message) },
          })
          return {
            access_token: issued.key.apiKey,
            signing_secret: issued.key.signingSecret,
            session_cookie: cookie,
            ...profile?.userId === undefined ? {} : { user_id: profile.userId },
            ...profile?.nickname === undefined ? {} : { nickname: profile.nickname },
          }
        }
        /**
         * ⚠️⚠️ **401/403 不是失败，是「用户还没登进去」**（2026-11-02 真机踩到）：
         * 窗口一打开，服务端就下发了一个匿名 `monkeycode_ai_session`，
         * 所以「读到 cookie」远早于「用户登完」—— 拿它换 Key **必然** 401。
         * 那时若直接抛错，用户在窗口里刚登完看到的却是「会话已失效」，
         * 窗口还被我们收掉，等于白登一次。
         * ⇒ 正确做法是**继续等**：用户登录后 cookie 才会变成有效会话。
         */
        if (!isMonkeycodeSessionExpiredError(issued.error)) {
          throw new Error(
            `MonkeyCode：已读到网页登录态，但换取网关凭据失败（${issued.error}）。`
            + '请重试；若持续失败，可在 ' + this.product.platformBaseUrl + ' 的「OhMyAgent」页面手动生成 Key。',
          )
        }
        lastSessionError = issued.error
        await delay(Math.min(SESSION_RETRY_MS, Math.max(0, deadline - Date.now())))
      }
      throw new Error(
        `MonkeyCode：浏览器窗口里还没有完成登录（${lastSessionError ?? '等待超时'}）。`
        + '请重新点击「+ 新建账号」，并在弹出的窗口里走完登录流程。',
      )
    } finally {
      // ⚠️ 无条件收窗：窗口/进程/临时 profile 都靠它回收。
      login.close()
    }
  }

  /**
   * 登出：只关掉「在途登录是否还该落库」这道闸门。
   *
   * ⚠️ **不删凭据**（那是账号池 `removeAccount` 的事）：本方法只防「登出之后
   * 一个在途的网页登录回来，又把凭据写回去」。
   */
  async logout(): Promise<void> {
    this.active = false
  }

  /** 插件被停用时调用（与 {@link logout} 同因）。 */
  stop(): void {
    this.active = false
  }

  /**
   * 面板状态：只看**池里有没有该 provider 的凭据**（与其余 provider 的门控
   * 判据完全一致，不为单凭据 ref 开例外）。
   *
   * ⚠️ 无池（headless / 单测）时退化为读默认 ref —— 与 qiniu 同型兼容路径。
   */
  async status(pool?: AccountPool): Promise<MonkeycodeLoginStatus> {
    if (pool === undefined) {
      const credential = await this.readCredential(this.credentialRefName)
      return this.statusOf(credential)
    }
    const entries = pool.listAccountsByProvider(this.product.id)
    for (const entry of entries) {
      const credential = await this.readCredential(entry.credentialRef)
      if (credential === undefined) continue
      return this.statusOf(credential)
    }
    return { configured: false, refreshable: false }
  }

  /**
   * 单凭据路径的「续期」。
   *
   * ⚠️ **不发任何网络请求、不写凭据**：MonkeyCode 没有 refresh 端点。
   * 它只做一次**有效性对账**：凭据不可读时抛可读错误（引导用户重新粘贴），
   * 可读时静默通过。**绝不返回「续期成功」的假象**（与 loomy / qiniu 同口径）。
   */
  async refresh(): Promise<void> {
    const credential = await this.readCredential(this.credentialRefName)
    if (credential === undefined) {
      throw new Error(
        `MonkeyCode：凭据 ${this.credentialRefName} 不可用。`
        + 'MonkeyCode 的 API Key 没有续期端点，请在 Jet Hub 的 MonkeyCode 面板重新粘贴一个 Key。',
      )
    }
  }

  /**
   * 按**凭据 ref** 对账指定账号（RPC `account.refresh` 的分派目标）。
   *
   * ⚠️ 签名里的 `pool` / `accountId` **必须接受并透传**给 `syncAccountExpiry`：
   * 它们是「续期后把新的 `expiresAt` 回写账号池」这条链路的唯一入口
   * （issue IKIRTT）。MonkeyCode 通常没有 `expires_at` 可写，但**接口不能少**
   * —— `tests/unit/refresh-bootstrap-wiring.spec.ts` 会逐个 provider 扫这条
   * 不变式，缺参数能编译、类型全绿，但会静默丢回写。
   *
   * @param refName   账号的凭据 ref（**不是**默认单凭据 ref）。
   * @param pool      账号池；提供时才回写 `expiresAt`。
   * @param accountId 账号 id；提供时免去按凭据身份反查。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const credential = await this.readCredential(refName)
    if (credential === undefined) {
      throw new Error(
        `MonkeyCode：凭据 ${refName} 不可用或不是合法的 API Key 凭据。`
        + '请在 Jet Hub 的 MonkeyCode 面板重新粘贴一个 Key。',
      )
    }
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential,
      accessors: MONKEYCODE_EXPIRY_ACCESSORS,
      ...accountId === undefined ? {} : { accountId },
      tag: '[monkeycode]',
    })
  }

  /**
   * 批量对账（启动首轮 + 每 30 分钟的定时器）。
   *
   * ## ⚠️ 三条必须同时满足（见 AGENTS.md 的「续期三件事缺一不可」）
   *
   * 1. **不看 `enabled`**：停用账号的凭据同样要保持新鲜；
   * 2. **不过滤 `refreshable`**：那个布尔只是**凭据材料的镜像**，拿它当门禁会把
   *    一次瞬时失败固化成永久状态。本家凭据恒 `refreshable:false`，用它会变成
   *    **一条都进不来**；
   * 3. **判据用凭据自己的值，不用池里的 `expiresAt`**：池值正是可能陈旧的那份。
   *
   * 本 provider 的「跳过」分支**只跳过对账之外的动作**，且每轮仍会调用
   * `syncAccountExpiry` —— 存量账号的池值即便早已陈旧（例如上一版插件从未
   * 回写过），也会在第一次运行后被自动更正。
   */
  async refreshAll(pool?: AccountPool): Promise<void> {
    if (pool === undefined) return
    const entries = pool.listAccountsByProvider(this.product.id)
    for (const entry of entries) {
      // ⚠️ 刻意**不判** entry.enabled、**不判** entry.refreshable（见上）。
      const credential = await this.readCredential(entry.credentialRef)
      if (credential === undefined) {
        // 凭据读不出来：如实记一条，但**不中断**其余账号（一个坏条目不该
        // 让整池停止对账）。
        this.ctx.logger?.warn?.(
          `[monkeycode] 账号 ${entry.id} 的凭据 ${entry.credentialRef} 不可用，跳过对账`,
        )
        continue
      }
      await syncAccountExpiry({
        pool,
        provider: this.product.id,
        credential,
        accessors: MONKEYCODE_EXPIRY_ACCESSORS,
        accountId: entry.id,
        current: {
          ...entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt },
          refreshable: entry.refreshable,
        },
        tag: '[monkeycode]',
        warn: (message) => this.ctx.logger?.warn?.(message),
      })
    }
  }

  /** 凭据是否被判定为已失效（供门控与面板用）。 */
  async checkExpired(pool?: AccountPool): Promise<boolean> {
    const status = await this.status(pool)
    if (!status.configured) return true
    if (status.expiresAt === undefined) return false
    return isMonkeycodeExpired({ expires_at: String(status.expiresAt) })
  }

  /** 把一个可解析的凭据映射成面板状态（`status()` 的两条路径共用）。 */
  private statusOf(credential: MonkeycodeCredential | undefined): MonkeycodeLoginStatus {
    if (credential === undefined) return { configured: false, refreshable: false }
    const expiresAt = monkeycodeCredentialExpiresAtMs(credential)
    return {
      configured: true,
      source: 'api-key',
      refreshable: false,
      hasSession: typeof credential.session_cookie === 'string' && credential.session_cookie.length > 0,
      ...expiresAt === undefined ? {} : { expiresAt },
    }
  }

  /** 读一个 ref 下的凭据（不可用或非 JSON 时返回 undefined）。 */
  private async readCredential(refName: string): Promise<MonkeycodeCredential | undefined> {
    const resolved = await this.ctx.credentials
      .resolve(credentialRef(refName))
      .catch(() => undefined)
    if (resolved === undefined) return undefined
    return parseMonkeycodeCredential(resolved.value)
  }
}
