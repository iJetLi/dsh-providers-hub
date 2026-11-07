import {
  completeAstudioLogin,
  getAstudioGeeTestConfig,
  sendAstudioSmsCode,
  loginAstudioWithSms,
  loginAstudioWithPassword,
  startAstudioLoginFlow,
  type AstudioWechatAccount,
  type AstudioLoginIdentity,
  type AstudioLoginInput,
  type AstudioGeeTestConfig,
  type AstudioGeeTestResult,
  type AstudioSmsSendResult,
  type AstudioLoginFlowOptions,
  type StartedAstudioLoginFlow,
} from './astudio-oauth.js';
/**
 * AStudio 认证服务 —— **凭据双路径**（全部判据来自 2026-10-15 真机实测，
 * 见探索事实 372 / 374 / 377 / 380 / 383）。
 *
 * ## 为什么本家的「认证」与其余 provider 根本不同
 *
 * AStudio 的登录是**微信扫码**，授权页与回调都在客户端手里，插件**无法**走完
 * 任何 OAuth/PKCE 流程（所以 `astudio-oauth.ts` 做的是「导入本机既有会话」）。
 * 而推理要用的 `modelBearerToken` 又不归我们所有 —— 它是**客户端**写在自己
 * 数据目录里的一份明文。于是本模块的职责恰好两条：
 *
 * 1. **快路径**：直读磁盘 `…\AStudio Data\userdata\astron-session.json`
 *    的 `modelBearerToken`（零网络、零副作用）；
 * 2. **权威刷新路径**：`GET {authBaseUrl}/bot/models/configs`
 *    （Cookie 四字段鉴权，**无现算签名**），从 `data[].api_key` 取活体凭据，
 *    判据见 {@link extractAstudioApiKey}。
 *
 * ## ⚠️ 三条「不能按别的 provider 的习惯写」的实测结论
 *
 * 1. **磁盘没有任何 TTL / `expiresAt` / `refreshToken`** ⇒ 本地**无法**预判到期。
 *    写成「按 `loggedInAt + 2h` 猜」属于编造判据（fact 374 实测：全字段核对）。
 *    唯一可靠的失效信号是**上游推理返回 HTTP 401** ⇒ 刷新由 401 触发，不由时钟触发。
 * 2. **刷新是幂等纯读**（该端点不消费任何东西、不轮换 token），所以「重取一次」
 *    零代价；但**不得循环重试** —— 实测本家不轮换（fact 377：磁盘值与重取值逐字节
 *    相同），同一份 token 撞上 401 后重取到的还是它，第二次必然同样 401。
 *    这条由纯函数 `astudioAuthRetryPlan`（`astudio.ts`）钉住。
 * 3. **只读客户端文件，绝不回写**：`astron-session.json` 与 acode 的 `config.toml`
 *    是客户端的资产，写坏的后果由用户的登录态承担。刷新到的新值只进 **DSH 凭据库**
 *    （`ctx.credentials`）。
 *
 * ## 三条入口共用同一套判据
 *
 * ① 推理按需（`astudio-adapter.ts` 拿到 401 后调 {@link AstudioAuth.refreshOnce}）；
 * ② Jet Hub 面板「刷新」（{@link AstudioAuth.refreshAccountCredential}）；
 * ③ `src/index.ts` 定时器批量续期（{@link AstudioAuth.refreshAll}，接
 *    `jet-hub-rpc.ts` 的 `SELF_HEAL_REFRESHABLE_PROVIDERS`）。
 * 三处都只做「读 → 比 → 必要时远端重取」，且都是幂等纯读，因此并发不会互相
 * 消费掉什么（这与 accio/lobsterai 必须 per-ref 串行防止「一次成功、其余
 * `invalid_grant`」的情形**不同**：本家没有一次性 refresh_token 可烧）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  ASTUDIO,
  ASTUDIO_API_KEY_CONFIG_PATH,
  ASTUDIO_SESSION_FILE_ENV,
  defaultAstudioSessionFilePath,
  type AstudioProduct,
} from './astudio-product.js'
import { markLoginNeedsExternalAction } from './login-failure.js'
import {
  astudioControlHeaders,
  astudioCookieHeader,
  astudioCredentialFingerprint,
  astudioCredentialFromSessionFile,
  astudioDisplayNickname,
  isAstudioRefreshable,
  isAstudioSessionDeadError,
  parseAstudioCatalog,
  parseAstudioEnvelope,
  type AstudioCatalogModel,
  type AstudioCredential,
  type AstudioSessionFile,
} from './astudio.js'
import type { AccountPool } from './account-pool.js'

/**
 * 「需要人工重新登录」的终态错误。
 *
 * ⚠️ `name` **必须**恰为 `RefreshTokenExpiredError`：`src/refresh.ts` 的
 * `isRefreshTokenExpired` 用 `error.name` 而非 `instanceof` 作判据（本仓库各家
 * 的同名类**刻意是各自独立的类** —— 跨模块 identity 不同，用 `instanceof` 会让
 * 一个 provider 的失效信号穿透成「可重试」而无限重试）。
 * 名字写错 = 每 30 分钟对账号后端白撞一次，且 UI 永远显示「可刷新」。
 */
export class AstudioRefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
    // ⚠️ **本类的语义就是「只能人工重新登录，静默重试无意义」**（见下方
    //    `isAstudioTerminalRefreshError` 的说明与 `astudio.ts` 的
    //    `ASTUDIO_SESSION_DEAD_CODES`）⇒ 出路在 **AStudio 桌面端**（微信重新扫码），
    //    重新点「+ 新建账号」无用 ⇒ 在这里**一处**打标记，覆盖该类全部抛错点
    //    （判据依附**类型**，不逐个调用点抄 —— 8 处抄 8 遍必然漏）。
    //    ⚠️ 它只影响**登录失败**文案（`jet-hub-rpc.ts` 的 `loginFailureMessage`）；
    //    续期链路抛这个类时**不走**那条路径 ⇒ 行为不变。
    markLoginNeedsExternalAction(this)
  }
}

/**
 * 判断一次失败是否**终态**（只能人工重新登录，静默重试无意义）。
 *
 * 判据落在 `error.name` 而不是 `instanceof`（理由见 {@link AstudioRefreshTokenExpiredError}）。
 * 与 `isAccioTerminalRefreshError` 同形。
 */
export function isAstudioTerminalRefreshError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'RefreshTokenExpiredError') return true
  return isAstudioSessionDeadError(0, error.message)
}

/**
 * 会话文件路径（**环境变量覆盖优先**）。
 *
 * ⚠️ 覆盖项是 `DSH_ASTUDIO_SESSION_FILE`（与 `DSH_JET_HUB_STATE_DIR` /
 * `DSH_OFFICEACE_HOME` 同型；后者是安全整改时补的 —— 不覆盖时**单测会读到
 * 用户真实凭据**并据此发出真实请求）。默认值是实测的本机安装位置；换机必然
 * 不对，但那只影响「能不能零网络拿到凭据」，拿不到就自然走远端重取。
 */
export function astudioSessionFilePath(
  env: Record<string, string | undefined> = process.env,
  product: AstudioProduct = ASTUDIO,
): string {
  const override = env[ASTUDIO_SESSION_FILE_ENV]
  if (typeof override === 'string' && override.trim().length > 0) return override.trim()
  // ⚠️⚠️ **显式值优先，否则按传入的 `env` 推导**（2026-10-18 审计 P1 修复）。
  //    修前这里是 `return product.sessionFilePath`，而 `ASTUDIO.sessionFilePath`
  //    是写死的开发机绝对路径 ⇒ 除该机外**所有**用户的「一键导入本机凭据」
  //    必然失败（那是客户端的默认档）。
  //    ⚠️ 推导必须用**传入的 `env`**（而不是 `process.env`）：同一函数的两个输入
  //    要同源，否则「传 env 进来测」只能覆盖 override 那一腿，
  //    默认值那一腿永远测不动（守卫会退化成对常量的同义反复 —— 修前正是如此）。
  const explicit = product.sessionFilePath
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim()
  return defaultAstudioSessionFilePath(env)
}

/** 读会话文件原文（不存在 / 无权限 / 读失败一律 `undefined`，**绝不抛**）。 */
function readSessionText(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 解析会话文件原文 → {@link AstudioSessionFile}。
 *
 * 单独导出只为**单测能直接喂文本**而不必先落盘（生产路径经
 * {@link readAstudioSessionFile}）。坏 JSON / 顶层数组 ⇒ `undefined`。
 */
export function parseAstudioSessionJson(text: string | undefined): AstudioSessionFile | undefined {
  if (text === undefined || text.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as AstudioSessionFile
}

/**
 * 读磁盘会话文件（**只读**）。
 *
 * 未装 AStudio / 未登录的用户每次都会走到 `undefined`：那不是异常，不记日志
 * （噪声），由调用方决定回退。
 */
export function readAstudioSessionFile(
  env: Record<string, string | undefined> = process.env,
  product: AstudioProduct = ASTUDIO,
): AstudioSessionFile | undefined {
  return parseAstudioSessionJson(readSessionText(astudioSessionFilePath(env, product)))
}

/**
 * 磁盘凭据（快路径，零网络）。
 *
 * ⚠️ **刻意不做进程内缓存**：`dsh-credentials` 的铁律是「consumers re-resolve
 * at each operation and must not cache across operations」，而本家更极端 ——
 * 客户端是唯一权威写者，它随时可能因用户重登覆盖写盘。缓存一份旧值会让
 * 「客户端刚重登」必须靠重启插件才能生效。读盘只是本地 I/O，不省这点。
 */
export function readAstudioDiskCredential(
  env: Record<string, string | undefined> = process.env,
  product: AstudioProduct = ASTUDIO,
): AstudioCredential | undefined {
  return astudioCredentialFromSessionFile(readAstudioSessionFile(env, product))
}

/** `bot/models/configs` 的完整 URL（账号后端，与推理网关**不同域**）。 */
export function buildAstudioApiKeyConfigUrl(product: AstudioProduct = ASTUDIO): string {
  return `${product.authBaseUrl.replace(/\/+$/, '')}${product.apiKeyConfigPath ?? ASTUDIO_API_KEY_CONFIG_PATH}`
}

/** 解析凭据存储值；缺 `access_token` 时 `undefined`（账号池身份依赖该字段）。 */
export function parseAstudioCredential(value: string): AstudioCredential | undefined {
  try {
    const parsed = JSON.parse(value) as AstudioCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** {@link extractAstudioApiKey} 的结果（**带取证信息**，四种失败要能分开说）。 */
export interface AstudioApiKeyPick {
  /** 取到的 `api_key`；没取到为空串。 */
  apiKey: string
  /** 命中判据的那条 `data[]` 的 `model`（证明取的是哪个模型行的 key）。 */
  model: string
  /** 命中方式；`none` = 一条 api_key 都没有。 */
  via: 'is_current' | 'is_default' | 'first' | 'none'
  /** 是否**终态**（账号后端明确没有可用凭据 ⇒ 要人工重登）。 */
  terminal: boolean
  /** 失败/终态的可读原因（成功时为空串）。 */
  reason: string
}

/** 后端把布尔下发成 `1` / `"true"` 的形态实测出现过，故真值判定要宽容。 */
function truthyField(row: Record<string, unknown>, key: string): boolean {
  const value = row[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') return value === 'true' || value === '1'
  return false
}

/**
 * 从 `bot/models/configs` 的响应里取**活体模型凭据**。
 *
 * ## 取值判据（与客户端 `getAuthoritativeModelCredential` 一致）
 *
 * `data[].api_key` 先按 `is_current === true`，无则 `is_default === true`，
 * 再退 `data[0]`。实测本账号 9 行里 `astronclaw-auto` 是 `is_default:true`、
 * **没有任何一行 `is_current:true`** ⇒ 只判 `is_current` 会恒取不到；只判
 * `data[0]` 又会在客户端切换当前模型后取错行（三条都得留，顺序不能换）。
 *
 * ## ⚠️ `data` 是**数组**形态
 *
 * 实测：`{flag:true,code:0,desc:"成功",count:null,data:[{model,api_key,…}]}`。
 * 信封解析器（本轮之前）只认对象形态，会让这条链**恒失败** —— 症状是
 * 「凭据刷不动、每轮都要人工重登」，而这正是本模块唯一的自愈能力。
 * 修法在 `astudio.ts` 的 `parseAstudioEnvelope`（新增 `rows`）。
 *
 * ## 终态 vs 可重试（不得混淆）
 *
 * | 情形 | 判定 | 依据 |
 * |---|---|---|
 * | `code` 命中失效码（1002/1005） | 终态 | fact 344/328 的会话失效码 |
 * | `code:0` 但 `data` 空 / 全行无 `api_key` | 终态 | 客户端在此抛 `AuthoritativeModelCredentialError` |
 * | 其它非 0 码（实测无 Cookie 回 `99909001/系统异常`） | **可重试** | 把未知码固化成「账号已死」是本仓库 codearts 的**单向门**事故形态 |
 * | 网络抖动 / 5xx / 非 JSON | 可重试 | 网络问题不该让用户重新登录 |
 */
export function extractAstudioApiKey(body: unknown): AstudioApiKeyPick {
  const envelope = parseAstudioEnvelope(body)
  if (!envelope.ok) {
    return {
      apiKey: '',
      model: '',
      via: 'none',
      terminal: envelope.sessionDead,
      reason: envelope.message,
    }
  }
  const rows = (envelope.rows ?? []).filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  )
  if (rows.length === 0) {
    return {
      apiKey: '',
      model: '',
      via: 'none',
      terminal: true,
      reason: '账号后端未返回任何模型配置（data 为空）',
    }
  }
  // ⚠️ **不是**「命中 is_current 就只看那一行」：那一行的 api_key 可能是空串
  // （实测后端偶发下发 `api_key:""`），此时必须继续往下找，否则把「还能救」
  // 判成「账号已死」。故按优先级**逐档**扫，空值就退到下一档。
  const current = rows.find((row) => truthyField(row, 'is_current'))
  const fallback = rows.find((row) => truthyField(row, 'is_default'))
  const ladder: Array<{ row: Record<string, unknown>; via: AstudioApiKeyPick['via'] }> = []
  if (current !== undefined) ladder.push({ row: current, via: 'is_current' })
  if (fallback !== undefined && fallback !== current) ladder.push({ row: fallback, via: 'is_default' })
  if (rows[0] !== current && rows[0] !== fallback) ladder.push({ row: rows[0], via: 'first' })
  // 最后一道：全表扫（`is_current`/`is_default` 都不在、或那些行的 key 全为空时，
  // 仍可能有**某一行**带着可用 key —— 客户端的语义是「账号下有没有任何凭据」，
  // 不是「首选那一行有没有」）。
  for (const row of rows) ladder.push({ row, via: ladder.length === 0 ? 'first' : ladder.at(-1)!.via })
  for (const candidate of ladder) {
    const apiKey = typeof candidate.row.api_key === 'string' ? candidate.row.api_key.trim() : ''
    if (apiKey.length === 0) continue
    const model = typeof candidate.row.model === 'string' ? candidate.row.model : ''
    return { apiKey, model, via: candidate.via, terminal: false, reason: '' }
  }
  return {
    apiKey: '',
    model: '',
    via: 'none',
    terminal: true,
    reason: `账号后端返回 ${rows.length} 条配置但没有任何可用 api_key`,
  }
}

/**
 * 把磁盘那份与凭据库里那份**合并**成刷新用的种子。
 *
 * ## 为什么不能只用其中一份
 *
 * - 磁盘那份有 Cookie，但 `access_token` 可能是过期副本；
 * - 凭据库里那份（上一轮重取的、或被账号池投影过的）**可能没有 Cookie**，
 *   单独用它 ⇒ 永远凑不出 Cookie 串 ⇒ **刷新能力永久丢失**（这是最坏的一种：
 *   不报错，只是从此刷不动）。
 *
 * ⇒ 规则：`access_token` 与 Cookie 各字段一律**磁盘优先**（客户端只写盘），
 * 但**空值不覆盖另一侧的好值** —— 磁盘里 `token:""` 若直接铺开，会抹掉库里
 * 的真值，而 `astudioCookieHeader` 跳过空值 ⇒ 症状是「明明有会话却拼不出 Cookie」。
 */
export function mergeAstudioRefreshSeed(
  disk: AstudioCredential | undefined,
  stored: AstudioCredential | undefined,
): AstudioCredential | undefined {
  if (disk === undefined && stored === undefined) return undefined
  if (disk === undefined) return stored
  if (stored === undefined) return disk
  const kept: AstudioCredential = { ...stored, ...disk }
  // 逐字段互补（只在一侧为空时才取另一侧）。
  const fields: Array<keyof AstudioCredential> = [
    'access_token', 'account_id', 'uid', 'nickname', 'sso_session_id', 'token', 'login_method', 'logged_in_at',
  ]
  for (const field of fields) {
    const diskValue = disk[field]
    const storedValue = stored[field]
    if (typeof diskValue === 'string' && diskValue.length > 0) continue
    if (typeof storedValue === 'string' && storedValue.length > 0) {
      // ⚠️ 必须经 `unknown` 中转：`AstudioCredential` 的键全是协议字段名，TS 不认它
      // 与 `Record<string, unknown>` 可直接互转（TS2352），而这里做的正是
      // 「按字符串键写回」—— 绕过类型检查的唯一正当一处，别改成 `as any`。
      (kept as unknown as Record<string, unknown>)[field] = storedValue
    }
  }
  return kept
}

/** 展示名（手机号掩码到只露末 2 位）：供 Jet Hub 卡片复用，避免第二处实现。 */
export function astudioAccountNickname(
  credential: AstudioCredential | undefined,
  fallbackId: string,
): string {
  return astudioDisplayNickname(credential, fallbackId)
}

/** {@link AstudioAuth.refreshOnce} 的结果（**四态**，不是布尔）。 */
export interface AstudioRefreshOutcome {
  /** 刷新后的凭据；完全读不到时 `undefined`。 */
  credential: AstudioCredential | undefined
  /**
   * `access_token` 是否**真的变了**。
   *
   * ⚠️ 不变 ⇒ **重试无意义**（同 token 同 401 是确定性失败，实测本家不轮换）。
   * 调用方必须据此跳过重发并直接报终态 —— 用布尔把「没变」与「读不到」混成
   * 一格是本仓库 officeace 的 `RenewalOutcome` 整改过的同一缺陷。
   */
  changed: boolean
  /** 刷新前指纹（`sha256[:8]`；`''` = 本来没有凭据）。与客户端日志同算法，便于对账。 */
  before: string
  /** 刷新后指纹。 */
  after: string
  /** 本轮是否真的发了远端请求。 */
  fetched: boolean
  /** 取值判据（透传 {@link AstudioApiKeyPick.via}）。 */
  via: AstudioApiKeyPick['via']
  /** 是否终态（只能人工重登）。 */
  terminal: boolean
  /** 失败原因（成功时为空串）。⚠️ 必须能进错误文案：静默失败是本仓库明令禁止的。 */
  reason: string
}

/** 本服务对凭据库的最小需求（收窄成接口，单测可直接喂结构替身）。 */
export interface AstudioCredentialStore {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  set(ref: CredentialRef, value: string): Promise<void>
  unset(ref: CredentialRef): Promise<void>
}

/** `AstudioAuth` 的构造选项（**单测全靠它们注入 fixture 与假 fetch，不碰真实凭据/网络**）。 */
export interface AstudioAuthOptions {
  /** 注入的 fetch；缺省全局 `fetch`。 */
  fetcher?: typeof fetch
  /** 产品配置；缺省 {@link ASTUDIO}。 */
  product?: AstudioProduct
  /** 环境变量视图；缺省 `process.env`（单测把会话文件指到 fixture）。 */
  env?: Record<string, string | undefined>
  /** 注入的凭据库；缺省用宿主 `ctx.credentials`。 */
  store?: AstudioCredentialStore
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    astudioAuth: AstudioAuth
  }
}

/**
 * AStudio 认证服务：磁盘快路径 + 401 触发的权威重取（**不做本地到期预判**）。
 */
export class AstudioAuth extends Service {
  /** 本实例默认读写的凭据 ref 名称（`ASTUDIO_ACCESS_TOKEN`）。 */
  readonly credentialRefName: string

  /** 产品配置（端点、可选头、超时）。 */
  readonly product: AstudioProduct

  /** 登录态是否活跃；`stop()` / `logout()` 置 false，阻止在途刷新回写。 */
  private active = true

  constructor(ctx: Context, private readonly options: AstudioAuthOptions = {}) {
    const product = options.product ?? ASTUDIO
    // 服务名 = `${product.id}Auth`（文档「路径 B」硬要求：id 同时是 cordis 服务名）。
    super(ctx, `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /** 注入的环境变量视图（单测用它把会话文件指到 fixture）。 */
  private get env(): Record<string, string | undefined> {
    return this.options.env ?? process.env
  }

  /** 凭据库：注入的替身优先，否则用宿主 `ctx.credentials`。 */
  private get store(): AstudioCredentialStore {
    if (this.options.store !== undefined) return this.options.store
    return this.ctx.credentials as unknown as AstudioCredentialStore
  }

  /** 记录一条警告（经 `ctx.logger`）。 */
  private warn(message: string): void {
    this.ctx.logger?.warn?.(message)
  }

  /** 读凭据库里的存储值（失败 `undefined`，绝不抛）。 */
  async readStoredCredential(refName: string): Promise<AstudioCredential | undefined> {
    try {
      const resolved = await this.store.resolve(credentialRef(refName))
      if (resolved === undefined || resolved === null) return undefined
      return parseAstudioCredential(resolved.value)
    } catch {
      return undefined
    }
  }

  /** 把凭据写进 DSH 凭据库（**绝不写客户端文件**）。失败只记日志。 */
  private async saveCredential(refName: string, credential: AstudioCredential): Promise<void> {
    try {
      await this.store.set(credentialRef(refName), JSON.stringify(credential))
    } catch (error) {
      // ⚠️ 写库失败**不影响本次推理**（内存里那份是好的），但必须留字 ——
      // 静默会让下一次调用又读回旧值，表现为「刷新了但没用」。
      this.warn(`[astudio] 凭据写回凭据库失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 当前可用凭据：**磁盘优先**，退回凭据库里的存储值。
   *
   * ⚠️ 顺序不能倒：客户端是 `modelBearerToken` 的唯一权威写者（重登/自刷新都会
   * 覆盖写盘）。库里那份可能是**上一轮的陈旧副本**，甚至属于换掉之前的账号。
   */
  async currentCredential(refName?: string): Promise<AstudioCredential | undefined> {
    const disk = readAstudioDiskCredential(this.env, this.product)
    if (disk !== undefined) return disk
    return await this.readStoredCredential(refName ?? this.credentialRefName)
  }

  /**
   * 向账号后端要一份**权威**的 `modelBearerToken`（纯读、幂等、零副作用）。
   *
   * ⚠️ 请求**不带 `Authorization`**：实测该端点只认 Cookie（见
   * `astudioControlHeaders` 的注释 —— 「与客户端逐字一致」是唯一不需要证明的选项）。
   * ⚠️ Cookie 拼不出来时**不去撞**：直接抛终态 —— 没有会话就没有权威源，发一个
   * 必然空体的请求只会把「需要重新登录」延迟成更难归因的错误。
   */
  async fetchAuthoritativeCredential(
    seed?: AstudioCredential,
  ): Promise<AstudioCredential> {
    return (await this.fetchAuthoritativePick(seed)).credential
  }

  /**
   * {@link fetchAuthoritativeCredential} 的实现层，**多透出 `via`**。
   *
   * ⚠️ 为什么要拆成两个而不是把 `via` 塞进 `AstudioCredential`：`via` 是**记账/诊断**
   * 字段（命中判据是 `is_current` / `is_default` / `first` 哪一条），不属于协议凭据；
   * 混进凭据会跟着一起落盘，让「磁盘 JSON 的字段集」出现第四个来源不明的键
   * （fact 374：磁盘文件是客户端的，我们连写都不写，更不能改它的形状）。
   * `AstudioRefreshOutcome.via` 的注释原话就是「透传 {@link AstudioApiKeyPick.via}」——
   * 这一层是那条注释一直缺的实现。
   */
  private async fetchAuthoritativePick(
    seed?: AstudioCredential,
  ): Promise<{ credential: AstudioCredential; via: AstudioApiKeyPick['via'] }> {
    // 磁盘那份**总是先读**：Cookie 只活在磁盘会话文件里。只用 seed（凭据库里
    // 那份可能已被剥掉 Cookie）会让客户端重登后的新会话永远拿不到刷新能力。
    const disk = readAstudioDiskCredential(this.env, this.product)
    const stored = seed ?? (await this.readStoredCredential(this.credentialRefName))
    const credential = mergeAstudioRefreshSeed(disk, stored)
    const cookie = credential === undefined ? '' : astudioCookieHeader(credential)
    if (cookie.length === 0) {
      throw new AstudioRefreshTokenExpiredError(
        'astudio: 本机会话文件缺少登录 Cookie（ssoSessionId/sso_sessionid/account_id/token），'
        + '无法向账号后端重取模型凭据 ⇒ 请在 AStudio 客户端重新登录',
      )
    }
    // ⚠️ 上面那句 throw **不收窄** `credential`（`cookie.length === 0` 与
    // `credential === undefined` 不是同一个判据，TS 也无法据此推断），而下一行的
    // `astudioControlHeaders` 要的是非空 `AstudioCredential`（TS2345）。
    // 走到这里 cookie 已非空 ⇒ 唯一可能是「凭据压根没合出来」，语义与上一句相同，
    // 所以复用同一个终态错误类，不要新造第三种失败形态。
    if (credential === undefined) {
      throw new AstudioRefreshTokenExpiredError(
        'astudio: 本机会话与凭据库都没有可用的登录态凭据 ⇒ 请在 AStudio 客户端重新登录',
      )
    }
    let response: Response
    try {
      response = await this.fetchImpl(buildAstudioApiKeyConfigUrl(this.product), {
        method: 'GET',
        headers: astudioControlHeaders(credential, this.product),
        signal: AbortSignal.timeout(this.product.requestTimeoutMs),
      })
    } catch (error) {
      // ⚠️ 传输层失败**不是**终态：网络抖动不该让用户重新登录。
      throw new Error(
        `astudio: 凭据重取请求失败（网络）— ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const status = response.status
    const text = await response.text().catch(() => '')
    if (status === 401 || status === 403) {
      // 会话 Cookie 本身已死：本家**没有** refresh_token，唯一出路是人工重扫微信。
      throw new AstudioRefreshTokenExpiredError(
        `astudio: 账号后端拒绝本机登录 Cookie（HTTP ${status}）`
        + ' ⇒ 微信会话已失效，只能在 AStudio 客户端重新登录',
      )
    }
    if (!response.ok) {
      throw new Error(`astudio: 凭据重取 HTTP ${status} ${text.slice(0, 200)}`)
    }
    let body: unknown
    try {
      body = JSON.parse(text) as unknown
    } catch {
      // 非 JSON（登录页 HTML / 网关错误页）：账号后端的会话失效常以此形态出现。
      if (/登录|login|未授权/i.test(text.slice(0, 500))) {
        throw new AstudioRefreshTokenExpiredError(
          `astudio: 凭据重取返回非 JSON 且含登录相关字样（HTTP ${status}）⇒ 请在 AStudio 客户端重新登录`,
        )
      }
      throw new Error(`astudio: 凭据重取响应不是 JSON（HTTP ${status}）${text.slice(0, 200)}`)
    }
    const pick = extractAstudioApiKey(body)
    if (pick.apiKey.length === 0) {
      const message = `astudio: 账号后端未下发可用模型凭据 — ${pick.reason}`
      if (pick.terminal) throw new AstudioRefreshTokenExpiredError(`${message} ⇒ 请在 AStudio 客户端重新登录`)
      throw new Error(message)
    }
    const merged: AstudioCredential = {
      // 先铺开种子：Cookie 四字段、`uid`、`nickname` 等**不参与重取**的字段必须
      // 原样保留 —— 丢了 Cookie 就永久失去再次刷新的能力（本家唯一的自愈手段）。
      ...credential,
      access_token: pick.apiKey,
      source: 'account-backend',
    }
    return { credential: merged, via: pick.via }
  }

  /**
   * 刷新一次（**推理路径的 401 入口**），返回「值到底变了没有」。
   *
   * ⚠️ 本方法**不抛**：401 路径上抛错会把一次可归因的凭据问题变成适配器里的
   * 未捕获异常。失败以 `credential`/`reason`/`terminal` 回传，由适配器决定文案。
   * 之所以仍然要区分 `terminal`：终态意味着**再多的定时刷新也不会成功**，
   * 调用方据此停止调度并提示重登；非终态只是「这次没刷动」。
   */
  async refreshOnce(refName?: string): Promise<AstudioRefreshOutcome> {
    const name = refName ?? this.credentialRefName
    const disk = readAstudioDiskCredential(this.env, this.product)
    const stored = await this.readStoredCredential(name)
    const baseline = mergeAstudioRefreshSeed(disk, stored)
    const before = baseline?.access_token ?? ''
    try {
      // ⚠️ 走 `fetchAuthoritativePick` 而不是公开方法：只有它透出 `pick.via`。
      // 成功分支此前写死 `via: 'is_current'`，而实测本账号 9 行里**没有任何一行**
      // `is_current:true`（真正命中的是 `is_default`/`first`）⇒ 那个硬编码恒说谎，
      // 而 `via` 正是「这次刷新到底取的是哪一行」的唯一诊断线索。
      const picked = await this.fetchAuthoritativePick(baseline)
      if (!this.active) {
        return {
          credential: baseline,
          changed: false,
          before: astudioCredentialFingerprint(before),
          after: astudioCredentialFingerprint(before),
          fetched: true,
          via: 'none',
          terminal: false,
          reason: '服务已停止，未回写刷新结果',
        }
      }
      const fresh = picked.credential
      const after = fresh.access_token
      await this.saveCredential(name, fresh)
      return {
        credential: fresh,
        changed: after !== before,
        before: astudioCredentialFingerprint(before),
        after: astudioCredentialFingerprint(after),
        fetched: true,
        via: picked.via,
        terminal: false,
        reason: '',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        credential: baseline,
        changed: false,
        before: astudioCredentialFingerprint(before),
        after: astudioCredentialFingerprint(before),
        fetched: true,
        via: 'none',
        terminal: isAstudioTerminalRefreshError(error),
        reason: message,
      }
    }
  }

  /**
   * 续期**指定账号**（Jet Hub 账号卡片 / `ProviderRuntime.auth.refreshAccount`）。
   *
   * ⚠️ 本家的刷新**不需要额外材料**（Cookie 就在凭据里），因此不存在
   * 「无 refresh_token」那一格；可刷性判据就是「当前有 access_token」。
   * ⚠️ 失败必须**原样上抛**（终态抛 `AstudioRefreshTokenExpiredError`）：
   * 调度器靠 `error.name` 停掉本账号的定时刷新，吞掉它 = 每 30 分钟白撞一次。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const baseline = await this.currentCredential(refName)
    if (baseline === undefined || !isAstudioRefreshable(baseline)) {
      throw new AstudioRefreshTokenExpiredError(
        'astudio: 本机没有可刷新的凭据（磁盘会话与凭据库都读不到）⇒ 请在 AStudio 客户端登录',
      )
    }
    try {
      const fresh = await this.fetchAuthoritativeCredential(baseline)
      if (!this.active) return
      await this.saveCredential(refName, fresh)
      await this.syncExpiry(pool, fresh, accountId)
    } catch (error) {
      if (isAstudioTerminalRefreshError(error)) {
        throw new AstudioRefreshTokenExpiredError(error instanceof Error ? error.message : String(error))
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  /**
   * 批量续期（`src/index.ts` 启动首轮 + 30 分钟定时器；接
   * `jet-hub-rpc.ts` 的 `SELF_HEAL_REFRESHABLE_PROVIDERS`）。
   *
   * ## 两条不得过滤的铁律（本仓库真实事故同型）
   *
   * 1. **不看账号是否停用**：停用只影响自动选号，与「凭据是否保鲜」无关。
   * 2. **不按池里的 `refreshable` 过滤**：那个布尔是被对账的**结果**，拿它当
   *    门禁会把一次瞬时失败固化成**单向门**（账号从此永不自愈 —— codearts
   *    真实事故：「自动续期没有工作吗？重启也还是 401」）。
   *
   * ⇒ 权威判据只有凭据材料本身（{@link isAstudioRefreshable}）。
   * ⚠️ 本家的刷新是**幂等纯读、零副作用**（fact 374：可无条件定时重取），
   * 所以每轮全量重取不烧任何东西；它同时能救「客户端在别处重登、磁盘值已换新」
   * 这一类场景。
   * ⚠️ 单账号失败**不中断其余账号**，且必须**留日志**：静默会让账号在 UI 上
   * 永远显示「可刷新」却刷不动，无从排查。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      try {
        const disk = readAstudioDiskCredential(this.env, this.product)
        const stored = await this.readStoredCredential(entry.credentialRef)
        const baseline = mergeAstudioRefreshSeed(disk, stored)
        if (baseline === undefined || !isAstudioRefreshable(baseline)) {
          if (entry.refreshable) await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        if (entry.refreshable === false) {
          this.ctx.logger?.info?.(
            `[astudio] 账号 ${entry.id} 的凭据具备刷新材料，本轮恢复自动刷新（此前的标记与凭据不符）`,
          )
        }
        const fresh = await this.fetchAuthoritativeCredential(baseline)
        if (!this.active) continue
        await this.saveCredential(entry.credentialRef, fresh)
        await this.syncExpiry(pool, fresh, entry.id)
      } catch (error) {
        if (isAstudioTerminalRefreshError(error)) {
          if (entry.refreshable) {
            try {
              await pool.updateAccount(entry.id, { refreshable: false })
            } catch {
              // 忽略 updateAccount 自身的错误
            }
          }
          this.warn(`[astudio] 账号 ${entry.id} 的会话已终态失效：${error instanceof Error ? error.message : String(error)}`)
        } else {
          this.warn(
            `[astudio] 账号 ${entry.id} 刷新失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  /**
   * 回写账号池的 `refreshable`。
   *
   * ⚠️ 本家**没有**可用的 `expiresAt`（磁盘无 TTL，`astudioCredentialExpiresAtMs`
   * 恒 `undefined`）⇒ **绝不写 `expiresAt`**：把字段写成 `undefined` 落盘会被
   * `JSON.stringify` 整个丢弃，UI 于是从「已过期」变成「未知」，反而抹掉了既有
   * 信息（与 `src/expiry-sync.ts` 的同一约定，那里把这条列为硬规矩）。
   */
  private async syncExpiry(
    pool: AccountPool | undefined,
    credential: AstudioCredential,
    accountId: string | undefined,
  ): Promise<void> {
    if (pool === undefined) return
    try {
      const id = accountId !== undefined && accountId.length > 0
        ? accountId
        : await pool.findAccountIdByCredential(this.product.id, credential.access_token)
      if (id === undefined || id.length === 0) return
      await pool.updateAccount(id, { refreshable: isAstudioRefreshable(credential) })
    } catch (error) {
      // 索引是展示层数据，不该反噬凭据本身（此时凭据已经刷新成功）。
      this.warn(`[astudio] 账号池对账失败（凭据已刷新，不影响本次调用）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 拉取远端模型目录：`GET {catalogBaseUrl}{catalogPath}`，解
   * `{code:0,data:{models:[…]}}` 信封。
   *
   * ⚠️ **不能**走 `{maasBaseUrl}/models`：实测恒 **404/405**
   *（推理网关与 `/api/v1/model-manager/models` 是两个不同域/前缀，
   * 见 `astudio-product.ts` 模块头第 1 条）。
   * ⚠️ 返回**未过滤**的解析结果：可见性过滤（剔 `visibility:hide` 的内部别名）
   * 由适配器用 `astudioVisibleModels` 做 —— 一处只干一件事，且
   * `raw` 的全量 39 字段必须原样保留（内核 `modelInfo` 逐字段强校验）。
   * 失败返回空数组（调用方回退兜底表），与 `AccioAuth.fetchModels` 同语义。
   */
  async fetchCatalogModels(): Promise<readonly AstudioCatalogModel[]> {
    const credential = await this.currentCredential()
    if (credential === undefined) return []
    try {
      const url = `${this.product.catalogBaseUrl.replace(/\/+$/, '')}${this.product.catalogPath}`
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credential.access_token}`,
          Accept: 'application/json',
          ...credential.account_id !== undefined && credential.account_id.length > 0
            ? { 'X-Account-Id': credential.account_id }
            : {},
          clientType: this.product.clientType,
          studioVersion: this.product.studioVersion,
        },
        signal: AbortSignal.timeout(this.product.requestTimeoutMs),
      })
      if (!response.ok) {
        this.warn(`[astudio] fetchModels: HTTP ${response.status} ${response.statusText}`)
        return []
      }
      const parsed = parseAstudioCatalog(await response.json() as unknown)
      // 目录也要**判凭据**：实测目录端点对失效凭据回 200 + `code≠0`，
      // `parseAstudioCatalog` 会抛（那是「成功但没内容」的另一格）。
      return parsed
    } catch (error) {
      this.warn(`[astudio] fetchModels: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /**
   * 导入**本机 AStudio 客户端已有的登录会话**（纯本地读盘 + 写 DSH 凭据库，**零网络请求**）。
   *
   * ## 为什么本家没有 `startLogin`
   *
   * AStudio 不走 OAuth：推理凭据是客户端登录后**明文落盘**的 `modelBearerToken`
   * （`ASTUDIO.sessionFilePath`，fact 399/402），服务端 `Set-Cookie` 恒
   * `Max-Age=31536000`、bundle 内**不存在任何程序化续期接口** ⇒ 没有「授权页 +
   * 回调」这一步可返回 URL。用户动作是「在 AStudio 客户端里登录」，本函数只负责
   * 把那份会话**读进来** —— 它是 `jet-hub-rpc.ts` 的 `account.create` astudio
   * 分支的唯一取数入口（fact 472 缺口 B）。
   *
   * ⚠️ **磁盘优先，但绝不回写磁盘**：客户端是 `modelBearerToken` 的唯一权威写者
   * （fact 401 挂点约束），本函数只写 DSH 凭据库，与 `refreshOnce` 行为一致
   * （单测已断言磁盘 fixture 一字未改）。
   *
   * ⚠️ 读不到 ⇒ **抛** `AstudioRefreshTokenExpiredError`，不得返回 `undefined`
   * 让调用侧写出一个没有凭据的账号条目（那会被自愈/探测链当成「已登录但坏了」）。
   *
   * ⚠️ 写库**刻意不走 `saveCredential`**（那条吞错误只留日志）：导入失败必须让
   * 调用方看见，它才能 `pool.removeAccount` 清掉刚登记的幽灵条目。
   *
   * @param refName 账号池条目的 `credentialRef`（由 `account.create` 生成）。
   *                只用于并入库里既有值；凭据本身固定写在 `defaultCredentialRef`
   *                —— 本家是「单账号一份会话文件」的形态（fact 374），且与
   *                `currentCredential()` 缺省读取的 ref 对齐，避免读盘值与库里值分裂。
   */
  async importLocalSession(refName: string): Promise<AstudioCredential> {
    const disk = readAstudioDiskCredential(this.env, this.product)
    if (disk === undefined) {
      throw new AstudioRefreshTokenExpiredError(
        '未在本机找到可用的 AStudio 登录会话（astron-session.json 不存在、不可读，或缺少 modelBearerToken）。' +
          '请先启动 AStudio 客户端并登录，再新建该账号。',
      )
    }
    // 与刷新链同构：磁盘给新值，库里那份补齐磁盘上没有的字段（如历史 nickname/uid）。
    // `disk !== undefined` 时 `mergeAstudioRefreshSeed` 必返回非空，`?? disk` 只是给 TS 的收窄。
    const stored = await this.readStoredCredential(refName)
    const credential = mergeAstudioRefreshSeed(disk, stored) ?? disk
    await this.store.set(
      credentialRef(this.product.defaultCredentialRef),
      JSON.stringify(credential),
    )
    if (refName && refName !== this.product.defaultCredentialRef) {
      await this.store.set(
        credentialRef(refName),
        JSON.stringify(credential),
      )
    }
    return credential
  }

  /**
   * 微信扫码登录凭据兑换与会话持久化（completeLogin）。
   *
   * 对接微信扫码授权后拿到的 { uid, ssoSessionId, username }：
   * 1. 走 completeAstudioLogin 兑换完整推理凭据；
   * 2. 持久化写入凭据库。
   */
  /**
   * 将登录凭据回填并持久化写入凭据库（persistLogin）。
   *
   * 供 Carrier 载体页（startAstudioLoginFlow）或外部登录流程在拿到完整凭据后统一回填持久化。
   */
  async persistLogin(
    credential: AstudioCredential,
    options: { refName?: string } = {},
  ): Promise<AstudioCredential> {
    const targetRef = options.refName ?? this.credentialRefName
    const stored = await this.readStoredCredential(targetRef)
    const merged = mergeAstudioRefreshSeed(credential, stored) ?? credential
    await this.store.set(
      credentialRef(this.product.defaultCredentialRef),
      JSON.stringify(merged),
    )
    if (targetRef && targetRef !== this.product.defaultCredentialRef) {
      await this.store.set(
        credentialRef(targetRef),
        JSON.stringify(merged),
      )
    }
    return merged
  }

  async completeLogin(
    account: AstudioLoginInput,
    refName?: string,
  ): Promise<AstudioCredential> {
    const credential = await completeAstudioLogin(account, {
      fetcher: this.fetchImpl,
      authBaseUrl: this.product.authBaseUrl,
    });
    const targetRef = refName ?? this.credentialRefName;
    const stored = await this.readStoredCredential(targetRef);
    const merged = mergeAstudioRefreshSeed(credential, stored) ?? credential;
    await this.store.set(
      credentialRef(this.product.defaultCredentialRef),
      JSON.stringify(merged),
    );
    if (targetRef && targetRef !== this.product.defaultCredentialRef) {
      await this.store.set(
        credentialRef(targetRef),
        JSON.stringify(merged),
      );
    }
    return merged;
  }


  /** 移除已存储的凭据（账号条目由调用方决定是否删除）。**不碰客户端文件**。 */
  async logout(): Promise<void> {
    this.active = false
    try {
      await this.store.unset(credentialRef(this.credentialRefName))
    } catch (error) {
      this.warn(`[astudio] 登出时清除凭据失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 停止服务：置 inactive，阻止在途刷新回写已登出的凭据。 */
  stop(): void {
    this.active = false
  }
}

export {
  completeAstudioLogin,
  getAstudioGeeTestConfig,
  sendAstudioSmsCode,
  loginAstudioWithSms,
  loginAstudioWithPassword,
  startAstudioLoginFlow,
  type AstudioWechatAccount,
  type AstudioLoginIdentity,
  type AstudioLoginInput,
  type AstudioGeeTestConfig,
  type AstudioGeeTestResult,
  type AstudioSmsSendResult,
  type AstudioLoginFlowOptions,
  type StartedAstudioLoginFlow,
} from './astudio-oauth.js';
