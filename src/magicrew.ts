/**
 * Magicrew provider 的**装配层**：把 product / auth / adapter / credits 组装成
 * `src/index.ts` 接线需要的形状（与其余 provider 的「服务入口」同一定位）。
 *
 * ⚠️ 本文件**不持有**任何状态（账号池由 `index.ts` 传入），也**不发**自发的请求
 * —— 唯一例外是 `login()` 里的「登录 + 签发」两步（那是登录语义的一部分）。
 *
 * ## ⚠️⚠️ 与 `MagicrewAuth` 的分工（**两层都留，别合并、别互相调用**）
 *
 * | | `MagicrewAuth`（`magicrew-auth.ts`） | `MagicrewService`（本文件） |
 * |---|---|---|
 * | 入参 / 出参 | `credentialRef` + `AccountPool` ⇒ `void` | **凭据对象** ⇒ 新凭据对象 |
 * | 账号池 | 读池 + `pool.updateAccount({ expiresAt })` 写回 | **完全不碰** |
 * | 凭据库 | 读 + 写（序列化自己做） | **不碰** |
 * | 一次性 token 串行 | `createMagicrewRefreshOnce` + `SerialQueue` | 无（调用方保证） |
 * | 语义 | 「按账号从池里续期并写回」—— 有副作用 | 「纯凭据变换」—— 无副作用 |
 *
 * ⇒ **多账号续期必须走 `MagicrewAuth.refreshAccountCredential` / `refreshAll`**
 * （那里才有写回 `expiresAt` 与串行器，issue !IKIRTT 的修法）；本文件的
 * `refresh()` 只服务「手上已有一份凭据」的场景（脚本 / 单测 / 一次性刷新）。
 *
 * ## ⚠️⚠️ `resolveCredential` / `fetchRemoteModels` **必须由接线层注入**
 *
 * `MagicrewServiceOptions` 只是 `MagicrewAdapterOptions` 的**子集**（本层不自己
 * 生产凭据，也不自己决定目录从哪来）⇒ 漏透传时适配器会退回到它自己的缺省值，
 * 而那两个缺省值都是**「看起来完整、实际不可用」**：
 *
 * - 缺 `resolveCredential` ⇒ 适配器的缺省是 `async () => undefined` ⇒ **每条请求**
 *   抛 `LlmError(…, 'AUTH')`「账号未登录或缺少 api_key，请重新登录」。已登录用户
 *   也看到这句，且 `AUTH` 会吞掉文案（本仓库 IKLBSH）⇒ 归因极难。
 * - 缺 `fetchRemoteModels` ⇒ 目录**只有静态兜底**，且**完全静默**（无日志、无报错）。
 *
 * ⇒ 故本文件的构造函数把这两项**逐项透传**（`undefined` 时不写该键，让适配器的
 * 缺省语义保持「未接线」而不是被一个 `undefined` 值覆盖）。接线层必须都给。
 *
 * ## ⚠️ 热路径绝不签发
 *
 * 签新 `mgw_` key 会**吊销旧 key**（`magicrew-auth.ts` 模块头第 1 条硬约束）⇒
 * 整个 provider 只允许两个签发入口：**登录**（本文件的 `login()`）与**续期**
 * （`refreshMagicrewKey`）。本文件不额外提供任何「顺手签一把」的方法。
 */

import {
  issueMagicrewGatewayKey,

  parseMagicrewCredential,
  refreshMagicrewKey,
  type MagicrewCredential,
} from './magicrew-auth.js'
import { MAGICREW, type MagicrewProduct } from './magicrew-product.js'
import { MagicrewAdapter, type MagicrewReadImage } from './magicrew-adapter.js'
import type { MagicrewAuth } from './magicrew-auth.js'
import { fetchMagicrewBalance, magicrewExpiry } from './magicrew-credits.js'
import { UNUSABLE } from './aggregate-core.js'
import type { AccountPool } from './account-pool.js'
import type { MagicrewCatalogModel } from './magicrew-catalog.js'
import type { ProviderExpiryContext } from './provider-runtime.js'
import type { CreditBalance } from './credits.js'

export interface MagicrewServiceOptions {
  readonly product?: MagicrewProduct
  /**
   * ⚠️ **必填**（2026-10-29，K1）：`login()` 的实现在 `MagicrewAuth` 上
   * （`account.create` 的 RPC 分派只能拿到 `JetHubAuths` 的实例），本 service 只是薄委托。
   */
  readonly auth?: MagicrewAuth
  readonly fetchImpl?: typeof fetch
  readonly warn?: (message: string) => void
  /**
   * 读图入口（`ctx.attachments.readImage` 的桥接）—— **必须能透到适配器**。
   *
   * ⚠️ 见 `MagicrewAdapterOptions.readImage`：缺省时遇到图片块**必须抛错**，
   * 绝不降级成占位文字（否则模型「看不到但以为看到了」= 幻觉，且上游零报错）。
   * 本字段存在只为让 `index.ts` 把宿主的读图能力交给适配器 —— 漏掉它时
   * 图片能力**静默不可用**。
   */
  readonly readImage?: MagicrewReadImage
  /**
   * 取当前账号凭据。**必须注入** —— 缺省时适配器每请求都会抛
   * 「账号未登录或缺少 api_key，请重新登录」（`magicrew-adapter.ts` 的缺省是
   * `async () => undefined`），而用户明明已登录。且它落 `AUTH`，宿主会把文案吞掉
   * ⇒ 症状是「已登录却永远说没登录」，几乎无法归因。
   */
  /**
   * ⚠️ **第二参 `sessionId` 是「轮换起点」的作用域键**（PR #59 正向审计 P1-b）。
   */
  readonly resolveCredential?: (modelId?: string, sessionId?: string) => Promise<MagicrewCredential | undefined>
  /**
   * 拉远端目录。缺省时目录只有静态兜底（**静默退化**：无日志、无报错，
   * 用户只会看到「模型列表里没有新模型」）。
   */
  readonly fetchRemoteModels?: () => Promise<readonly MagicrewCatalogModel[]>
  /** 账号池（目录缓存要按账号区分时用；缺省 = 不按账号，与适配器缺省同义）。 */
  readonly accountPool?: AccountPool
  /**
   * 时钟注入（毫秒）。本层用它给 `magicrewExpiry` 的 `expiresAt > now` 判据供时
   * —— 与「写死未来日期」的单测相互独立：测试传固定值即不依赖真实时钟。
   *
   * ⚠️ 刻意从**构造函数**注入而**不是** `expiry()` 的参数：任务 8c 的接线形状是
   * `credentialExpiry: (c, ctx) => service.expiry(c, ctx)`，多一个参数会改变它。
   */
  readonly now?: () => number
}

export class MagicrewService {
  readonly product: MagicrewProduct
  readonly adapter: MagicrewAdapter
  private readonly fetchImpl: typeof fetch
  private readonly warnImpl: (message: string) => void
  /** 注入的时钟；未注入时为 `undefined`（交给 `magicrewExpiry` 的 `Date.now()` 缺省）。 */
  private readonly nowImpl: (() => number) | undefined
  /** 登录实现的宿主（`auth.ts` 的 `MagicrewAuth.login`）；本 service 只做薄委托。 */
  private readonly auth: MagicrewAuth | undefined

  constructor(options: MagicrewServiceOptions = {}) {
    this.product = options.product ?? MAGICREW
    this.fetchImpl = options.fetchImpl ?? fetch
    this.warnImpl = options.warn ?? ((message: string) => { console.warn(message) })
    this.nowImpl = options.now
    this.auth = options.auth
    // ⚠️ `product` / `fetchImpl` **必须透传**：注入点是任务 4/4d 定的
    //    （适配器不自己读全局 `fetch`，否则单测会真发请求到 `i-magic-service`）。
    // ⚠️⚠️ `resolveCredential` / `fetchRemoteModels` **更要透传** —— 适配器对它们的
    //    缺省分别是「永远没有凭据」（每请求抛 `AUTH`）与「只有静态目录」（静默）
    //    ⇒ 漏传 = 一个「看起来完整、实际不可用」的 provider，见文件头。
    //    逐项 `=== undefined ? {} : {…}` 是本文件既有风格：不把一个 `undefined`
    //    值塞进去覆盖掉适配器的缺省语义。
    this.adapter = new MagicrewAdapter({
      product: this.product,
      fetchImpl: this.fetchImpl,
      warn: this.warnImpl,
      ...options.readImage === undefined ? {} : { readImage: options.readImage },
      ...options.resolveCredential === undefined
        ? {} : { resolveCredential: options.resolveCredential },
      ...options.fetchRemoteModels === undefined
        ? {} : { fetchRemoteModels: options.fetchRemoteModels },
      ...options.accountPool === undefined ? {} : { accountPool: options.accountPool },
      ...options.now === undefined ? {} : { now: options.now },
    })
  }

  /**
   * 从本机浏览器读取已登录的凭据（**不开窗口**）—— **薄委托**给
   * {@link MagicrewAuth.importFromLocalBrowser}。
   *
   * ⚠️ 实现刻意只长在 auth 层（与 `loginViaBrowser` 同因，见其注释）：`account.create`
   * 的 RPC 分派只能拿到 `JetHubAuths` 的实例。本方法存在只为「持有 service 的调用方
   * 不必再握住 auth 实例」。
   *
   * ⚠️ 未注入 `auth` 时**抛错**（不静默返回 `undefined`）：`undefined` 的语义是
   * 「本机浏览器里没有登录态」，而接线漏了 `auth` 是完全不同的一件事 —— 混成
   * 一个返回值会把装配缺陷伪装成「用户没登录」。
   */
  async importFromLocalBrowser(): Promise<MagicrewCredential | undefined> {
    if (this.auth === undefined) {
      throw new Error(
        'magicrew: 未注入 `auth`，无法从本机浏览器读取登录态'
        + '（接线层必须把 MagicrewAuth 传进 MagicrewServiceOptions）',
      )
    }
    return await this.auth.importFromLocalBrowser()
  }

  /**
   * **网页版登录**（开窗 → 等用户登完 → 取凭据）—— **薄委托**给
   * {@link MagicrewAuth.loginViaBrowser}。
   *
   * ⚠️ 与 {@link importFromLocalBrowser} **同一条腿的两种入口**：都不开/开窗口的差别，
   * 落库与签发 `mgw_` key 的纪律完全一致（那条腿只在 auth 层实现一份 ——
   * `account.create` 的 RPC 分派拿不到本 service）。
   *
   * ⚠️ 返回 `undefined` = **用户没登完**（超时 / 关掉了窗口），**不是**失败：
   * 调用方不得据此弹错（详见 auth 层同名方法的四条语义）。
   * ⚠️ 未注入 `auth` 时**抛错**（理由同上：不把装配缺陷伪装成「用户没登录」）。
   */
  async loginViaBrowser(options?: { timeoutMs?: number }): Promise<MagicrewCredential | undefined> {
    if (this.auth === undefined) {
      throw new Error(
        'magicrew: 未注入 `auth`，无法发起网页版登录'
        + '（接线层必须把 MagicrewAuth 传进 MagicrewServiceOptions）',
      )
    }
    return await this.auth.loginViaBrowser(options)
  }

  /**
   * 用 refresh_token 换新 api_key —— **薄包装：纯凭据变换，无副作用**。
   *
   * ⚠️ 只是 {@link refreshMagicrewKey} 的一层形状映射（凭据进 → 新凭据出），
   * **不碰账号池、不写凭据库**；分层理由见文件头那张表。别在这里另写一套续期，
   * 也别让它转调 `MagicrewAuth`（那样会把「写回 `expiresAt`」和「串行器」带进来，
   * 而本方法的调用方往往**没有**池）。
   *
   * ⚠️ `refreshToken` 是一次性轮换的 ⇒ 上游回了新 token 就必须用新的
   * （否则下一轮拿旧 token 去换必然失败）。串行由调用方负责 —— 并发两次会让其中一个
   * 的 token 立即失效。
   *
   * ⚠️ 没有 `refresh_token` 时**原样返回**（不是抛错）：凭据仍能用 jwt 拉目录 / 积分，
   * 把「没法续」当失败会让调用方无谓地走一遍重新登录。
   */
  async refresh(credential: MagicrewCredential): Promise<MagicrewCredential> {
    if (credential.refreshToken === undefined || credential.refreshToken.length === 0) {
      return credential
    }
    const key = await refreshMagicrewKey({
      refreshToken: credential.refreshToken,
      product: this.product,
      fetchImpl: this.fetchImpl,
    })
    return {
      ...credential,
      apiKey: key.apiKey,
      ...key.apiKeyExpiresAt === undefined ? {} : { apiKeyExpiresAt: key.apiKeyExpiresAt },
      ...key.refreshToken === undefined ? {} : { refreshToken: key.refreshToken },
    }
  }

  /**
   * 读积分余额 —— 薄委托 {@link fetchMagicrewBalance}。
   *
   * ⚠️ 这不是 {@link expiry} 的同义重复：后者的入参是「凭据 + DSH 的折算上下文」
   * 且只回**一个时刻**，而余额本身（`CreditBalance`，含逐批次明细）是 Jet Hub
   * 积分行的展示数据。删掉它 `login` / `refresh` / `credits` 三件套就缺一条腿。
   *
   * ⚠️ 必须**显式**把 `this.fetchImpl` 交给原语：`fetchImpl` 在本类是 `private`，
   * 外部拿不到 ⇒ 没有这个方法，调用方只能让原语退回全局 `fetch`，单测/接线
   * 的注入就**静默失效**（未来 credits 单测无法桩掉网络）。
   *
   * ⚠️ 失败返回 `undefined`（调用方**不得**把它当 0 —— 「查不到」与「余额为零」
   * 在 UI 上是两件事）。
   */
  async balance(credential: MagicrewCredential): Promise<CreditBalance | undefined> {
    return await fetchMagicrewBalance({
      jwt: credential.jwt,
      organizationCode: credential.organizationCode,
      product: this.product,
      fetchImpl: this.fetchImpl,
    })
  }

  /**
   * 聚合折算原语（`src/provider-expiry.ts` 的 `createProviderExpiry` 会挂它）。
   *
   * ⚠️⚠️ **只委托、不重算**：折算口径（余额为 0 / 批次到期 / 长期积分）全部在
   * {@link magicrewExpiry} 里 —— 本方法只做「凭据 → 它要的入参」这一层映射。
   * 在这里再写一遍折算必然与原语分叉（而该原语的口径刚被任务 5a 修正过：
   * 缓存缺席 / `null` / `undefined` 时**必须自己发请求**，否则该渠道折算恒
   * `UNUSABLE` ⇒ 在聚合候选表里**静默消失**）。
   *
   * ⚠️ 第二参是 DSH 的 {@link ProviderExpiryContext}（**不是**余额）：共享读数
   * 是 `context.cachedBalance(accountId)` 这条**按账号取数**的函数，而原语要的是
   * 「零参 thunk」⇒ 这里包一层转发（与 buddy / trae / astudio 同款）。
   * 原语在 thunk 缺席 / 返回 `null` / 返回 `undefined` 时都会自己取数。
   *
   * ⚠️ 凭据里没有 jwt ⇒ 连余额都查不到 ⇒ `UNUSABLE`（**不是** `NEVER`：
   * 后者会把一个不可用的渠道排到候选最前并当选）。判据复用
   * {@link parseMagicrewCredential}（它与适配器 / 池同一条「jwt 是唯一必需字段」口径）。
   *
   * ⚠️ 时钟**从构造函数注入**（`options.now`），**不是**本方法的参数：任务 8c 的
   * 接线形状是 `(c, ctx) => service.expiry(c, ctx)`，多一个参数就会改变它。
   * 注入后 `magicrewExpiry` 的 `expiresAt > now` 判据不再依赖真实时钟 ——
   * 否则单测里写死的「未来日期」会随时间自己变红（日期炸弹）。
   */
  async expiry(credential: unknown, context?: ProviderExpiryContext): Promise<number> {
    const parsed = parseMagicrewCredential(credential)
    if (parsed === undefined) return UNUSABLE
    const accountId = context?.accountId
    const cachedBalance = context?.cachedBalance
    const cachedThunk: (() => Promise<CreditBalance | null | undefined>) | undefined =
      cachedBalance === undefined
        ? undefined
        : () => cachedBalance(accountId) as Promise<CreditBalance | null | undefined>
    return await magicrewExpiry({
      jwt: parsed.jwt,
      organizationCode: parsed.organizationCode,
      product: this.product,
      fetchImpl: this.fetchImpl,
      ...cachedThunk === undefined ? {} : { cachedBalance: cachedThunk },
      ...this.nowImpl === undefined ? {} : { now: this.nowImpl() },
    })
  }
}
