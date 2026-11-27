/**
 * Accio 认证服务。
 *
 * ## ⚠️⚠️ 续期：三条铁律，缺一不可（AGENTS.md 事故史）
 *
 * 1. **只按凭据材料过滤**（`refresh_token` 非空）
 *    - ⚠️ **不看 `enabled`**：停用只影响自动选号，与「凭据是否需要保鲜」无关。
 *      真实缺陷：两处都按 `enabled` 过滤 ⇒ 停用期间 refresh_token 一路放到失效，
 *      用户重新启用后拿到的是死凭据。
 *    - ⚠️ **也不按池里的 `refreshable` 过滤**：那个布尔是被对账的**结果**，
 *      拿它当门禁会把一次瞬时失败固化成**单向门**（codearts 真实事故）。
 * 2. **判终态前先重读凭据**：并发下服务端轮换的是**旧的**那一份，
 *    磁盘上此刻可能躺着一份**新的、可用的**凭据 ⇒ 那是「他处已续成功」，
 *    不是「本账号不可续期」。
 * 3. **per-`credentialRef` 串行**（`SerialQueue`）+ **锁内重读**。
 *
 * ## 为什么第 3 条对 Accio 尤其关键
 *
 * 参考实现明确记录「刷新会**轮换** refresh_token」。三条入口——
 * ① `src/index.ts` 的定时器（含启动首轮）、② 推理路径的按需续期
 * （DSH 会**并发**发主回复 + 标题生成 + 上下文压缩）、③ 面板「刷新」按钮——
 * 若不串行，必然「1 个成功、其余 `invalid_grant`」，而失败方会把**好账号标死**。
 *
 * ⚠️ **锁只在单进程内有效**：同机跑 web + desktop 两个实例时跨进程互踩，
 * 只能靠第 2 条兜 ⇒ **两处都得有**。
 *
 * ## ⚠️ 不注册任何斜杠命令
 *
 * 与其余 provider 一致：登录 / 续期 / 积分全部在 Jet Hub 设置页完成。
 *
 * ## 协议事实（2026-10-12 实测，详见 `docs/agent-notes/providers-accio.md`）
 *
 * - 标准 OAuth 2.0 + PKCE（公开客户端 `accio-work`，无 secret）⇒ **可完全脱离 IDE**；
 * - 回调落在**我们自己的** loopback（Accio 对 `return_url` 无白名单校验）；
 * - `expires_at` 上游给的是**秒**，`accio-oauth.ts` 已一次性归一化为毫秒。
 */

import { createServer } from 'node:http'
// ★ issue #177：登录后补一次身份（拿 activeTeam.teamId 供 `x-team-id`）
import { fetchAccioUserInfo } from './accio-credits.js'
import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  ACCIO,
  ACCIO_CATALOG_PATH,
  ACCIO_LOGIN_TIMEOUT_MS,
  ACCIO_REGIONS,
  ACCIO_REQUEST_TIMEOUT_MS,
  type AccioFallbackModel,
  type AccioRegion,
} from './accio-product.js'
import {
  accioCredentialExpiresAtMs,
  isAccioRefreshable,
  type AccioCredential,
} from './accio.js'
import {
  buildAccioAuthUrl,
  createAccioPkcePair,
  createAccioState,
  exchangeAccioCode,
  openBrowser,
  refreshAccioCredential,
} from './accio-oauth.js'
import type { AccioTokenResult } from './accio-oauth.js'
import { SerialQueue } from './serial-queue.js'
import { AccountPool } from './account-pool.js'
import {
  refreshAccountWithReconcile,
  shouldRefreshNow,
  syncAccountExpiry,
  type ExpiryAccessors,
} from './expiry-sync.js'

/** 回调路径。Accio 对 `return_url` **无白名单校验**，故路径由我们自己定。 */
const ACCIO_CALLBACK_PATH = '/auth/callback'

/**
 * 续期被服务端判定为**终态**（`refresh_token` 已不可用）时抛出的错误。
 *
 * ⚠️ **判据必须窄**：只有服务端明确说「这份 refresh_token 不认了」才算终态。
 * 网络抖动、5xx、超时、读体失败一律是**可重试**的普通 `Error` —— 把它们
 * 归为终态就是本仓库记录过的「一次瞬时失败固化成单向门」。
 * （同族的反例见 `docs/agent-notes/providers-*` 里 DPoP 那条：
 * `InvalidDPoPHeader` 说的是「这一次证明不合格」，与 token 能不能用无关。）
 */
export class AccioRefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccioRefreshTokenExpiredError'
  }
}

/**
 * 服务端明确表示「这份 refresh_token 不再被接受」的报文标记。
 *
 * ⚠️ 逐条都要求**指向 refresh_token 本身**：`unauthorized` / `403` 这类
 * 泛化状态词**不在**此列 —— 网关抖动、区域策略、风控都可能回它们，而把
 * 它们判成终态会让一个材料完好的账号被标死（正是要避免的方向）。
 */
const ACCIO_TERMINAL_REFRESH_MARKERS: readonly string[] = [
  'invalid_grant',
  'invalid refresh token',
  'invalid refresh_token',
  'refresh token has been used',
  'refresh_token has been used',
  'refresh token expired',
  'refresh_token expired',
  'expired refresh token',
  'NOT_LOGIN',
  'not_login',
]

/** 判断一次续期失败是不是**终态**（`refresh_token` 真的不能用了）。 */
export function isAccioTerminalRefreshError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lowered = message.toLowerCase()
  return ACCIO_TERMINAL_REFRESH_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()))
}

/**
 * 把外部传入的 region 归一化到白名单。
 *
 * ⚠️ 与 zcode 的 `normalizeZcodeLoginProvider` 同因（issue IKJLK3 E2）：
 * `region` 来自**客户端自报**的 RPC 载荷（没有 schema 校验），未登记的值会
 * 被原样写进凭据并决定登录域名。这里收敛到白名单，未知值回落 `'cn'`。
 */
export function normalizeAccioRegion(raw: unknown): AccioRegion {
  return ACCIO_REGIONS.includes(raw as AccioRegion) ? (raw as AccioRegion) : 'cn'
}

/**
 * 从存储值解析凭据 JSON；解析失败返回 undefined。
 *
 * ⚠️ 要求 `access_token` 是字符串：`AccountPool.findAccountIdByCredential`
 * 对非 codearts 的 provider 取的就是它作身份标识，缺它这条凭据无法归属账号。
 */
function parseCredential(value: string): AccioCredential | undefined {
  try {
    const parsed = JSON.parse(value) as AccioCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 把**一条**远端目录条目归一化为 `AccioFallbackModel`（与兜底表同形，
 * 便于适配器把「远端目录」与「兜底表」拼成一份、不必引入第二个模型类型）。
 *
 * ⚠️ `visible !== true` 一律剔除：不可见模型不该进目录。
 *
 * ⚠️ **这是全仓库唯一的 Accio 目录条目解析器**（`parseAccioCatalog` 也走它）。
 * 适配器（Task 6）应 `export { normalizeAccioModel } from './accio-auth.js'`
 * 复用本函数，**不要**再写第二份 —— 「同一份语义两套判据」是本仓库首条红线，
 * 而目录解析尤其容易分叉（`visible` / `multimodal` / `effectiveMultiple` 三处
 * 都是踩过坑的字段）。
 *
 * ⚠️ `supportsImage` 在这里是**二值投影**（`multimodal === true`）。设计文档
 * 要求 `inputModalities` 是**三态**（省略 = 未知，`['text']` = 明确不支持），
 * 而本字段表达不了「未知」—— 需要三态的一方（适配器）必须自己读原始
 * `multimodal`，**不要**把本字段的 `false` 当作「明确不支持」。
 */
export function normalizeAccioModel(raw: unknown): AccioFallbackModel | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const row = raw as Record<string, unknown>
  if (row.visible !== true) return undefined
  const id = typeof row.modelCode === 'string' ? row.modelCode : ''
  if (id === '') return undefined
  const displayName = typeof row.modelDisplayName === 'string' ? row.modelDisplayName : ''
  const contextWindow = typeof row.contextWindow === 'number' && Number.isFinite(row.contextWindow)
    ? row.contextWindow
    : 0
  const multiple = typeof row.effectiveMultiple === 'number' && Number.isFinite(row.effectiveMultiple)
    ? row.effectiveMultiple
    : undefined
  const maxTokens = typeof row.maxTokens === 'number' && Number.isFinite(row.maxTokens)
    ? row.maxTokens
    : undefined
  /**
   * ⚠️ 档位（`reasoningEfforts` / `defaultReasoningEffort`）—— **2026-10-13 新增**。
   *
   * ## 实测的形状要点（逐条真机验证）
   *
   * 1. **`reasoningEfforts` 可能是 `null`**（38 条里 31 条）—— 必须与「空数组」同样
   *    表达为「无档位」，**不能**当成 `[]` 后照常声明（那会让选择器空白）；
   * 2. **元素是字符串**（`low` / `medium` / `high` / `xhigh` / `max`），顺序是
   *    服务端给的**由弱到强**，**原样保留**（排序＝替服务端决定语义）；
   * 3. **`defaultReasoningEffort` 可以在 `efforts` 为 `null` 时单独存在**
   *    （GLM-5.3 `max`、MiniMax M3 `adaptive`）—— 实测**发过去服务端接受**，
   *    故它是**一个可用的单档**（用户要求「即使只有一档也要显示」正是这一格）；
   * 4. 非字符串 / 空串元素**丢弃**（脏值会让 DSH 的档位选择器渲染出空白项）。
   */
  const efforts = Array.isArray(row.reasoningEfforts)
    ? (row.reasoningEfforts as unknown[]).filter(
        (e): e is string => typeof e === 'string' && e.trim() !== '',
      )
    : []
  const defaultEffort = typeof row.defaultReasoningEffort === 'string'
    && row.defaultReasoningEffort.trim() !== ''
    ? row.defaultReasoningEffort
    : undefined
  return {
    id,
    name: displayName === '' ? id : displayName,
    contextWindow,
    supportsImage: row.multimodal === true,
    ...multiple === undefined ? {} : { multiple },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...efforts.length === 0 ? {} : { efforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
  }
}

/**
 * 解析 `POST /api/llm/config/v2` 的响应体（`data[].modelList[]`），
 * 按**倍率升序**（便宜在前）返回；无倍率的排最后。
 *
 * ⚠️ 目录**必须动态拉取**：`modelCode` 形如 `1Drift-N8kP2Q7wR5mX`（非人类可读），
 * 兜底表只作离线回退，无法凭名字手写维护。
 *
 * ⚠️ 适配器侧（Task 6）应直接消费 {@link AccioAuth.fetchModels} 的输出，
 * **不要**再写第二份目录解析 —— 同一份语义两套判据是本仓库的首条红线。
 */
export function parseAccioCatalog(body: unknown): AccioFallbackModel[] {
  const data = (body as { data?: unknown } | null | undefined)?.data
  if (!Array.isArray(data)) return []
  const models: AccioFallbackModel[] = []
  for (const group of data) {
    const list = (group as { modelList?: unknown } | null | undefined)?.modelList
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const entry = normalizeAccioModel(raw)
      if (entry !== undefined) models.push(entry)
    }
  }
  // ⚠️ 排序必须显式处理「两边都没有倍率」：`(a.multiple ?? Infinity) - (b.multiple ?? Infinity)`
  //    在两者都缺时会得到 `Infinity - Infinity = NaN`，而 `Array.prototype.sort` 的
  //    比较器返回 `NaN` 是**未定义行为**（V8 下会退化成不稳定的原序，且不报错）。
  //    ⇒ 缺倍率一律排在**最后**；两个都缺 ⇒ 返回 0（保持相对顺序，稳定）。
  return models.sort((a, b) => {
    const left = a.multiple
    const right = b.multiple
    if (left === undefined && right === undefined) return 0
    if (left === undefined) return 1
    if (right === undefined) return -1
    return left - right
  })
}

/**
 * Accio 凭据 → 账号池有效期所需的提取器（`refreshAll` 与按需续期共用一份）。
 *
 * ⚠️ `identityOf` 用 **`access_token`**：`AccountPool.findAccountIdByCredential`
 * 对非 codearts 的 provider 比对的就是这个字段，传 ref 名会恒匹配失败且**静默**。
 * ⚠️ 但 Accio 的 `access_token` **每次登录/续期都会轮换** ⇒ 反查**可能失效**。
 * 本仓库既有约定是「调用方已知 `entry.id` 时必须显式传，反查只是兜底」，
 * 本实现遵守该约定（设计文档 §4.7）。
 */
const ACCIO_EXPIRY_ACCESSORS: ExpiryAccessors<AccioCredential> = {
  expiresAtOf: accioCredentialExpiresAtMs,
  refreshableOf: isAccioRefreshable,
  identityOf: (credential) => credential.access_token ?? '',
}

/** Accio 的默认凭据 ref（单凭据路径的历史常量，多账号一律走 `ACCIO_ACCOUNT_XXX`）。 */
export const ACCIO_CREDENTIAL_REF = ACCIO.defaultCredentialRef

/** 一次两步式登录的启动结果。 */
export interface StartedAccioLogin {
  /** 供前端**立即** `window.open` 的授权页地址。 */
  loginUrl: string
  /** 用户完成授权（或超时/失败）后落定；**不 await 它也能拿到 loginUrl**。 */
  result: Promise<void>
  /** 关闭回调服务器；**幂等**，可重复调用。 */
  close: () => void
}

/**
 * 登录参数。
 *
 * ⚠️ `pool` / `accountId` 是**两步式占位条目**所需：本仓库的交互是
 * 「点击 → 弹出小窗 → 轮询 `login.poll`」，而 `login.poll` 靠
 * 「账号条目还在 + 凭据已写入」判断成功 ⇒ 必须先登记占位条目，
 * 失败时删除它（不留无凭据的幽灵账号）。
 */
export interface AccioLoginOptions {
  /** 登录区域（决定登录页域名）；缺省 `'cn'`。 */
  region?: AccioRegion
  /** 凭据 ref 名；缺省 {@link ACCIO_CREDENTIAL_REF}。 */
  refName?: string
  /** 账号池；与 `accountId` 成对提供时才登记 / 清理占位条目。 */
  pool?: AccountPool
  /** 账号 id（由 RPC 的 `account.create` 生成）。 */
  accountId?: string
}

/** `AccioAuth` 的构造选项。 */
export interface AccioAuthOptions {
  /** 注入的 fetch（测试用）；缺省全局 `fetch`。 */
  fetcher?: typeof fetch
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    accioAuth: AccioAuth
  }
}

/** 回调页的响应头。 */
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8' } as const

/**
 * 转义 HTML 文本。
 *
 * ⚠️ 回调页会回显 `?error=` 的值，而那是**外部可控**的（任何人都能往
 * loopback 回调地址投递查询串）—— 不转义就是一处反射型 XSS。
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 生成回调结果页。 */
function callbackPage(title: string, message: string): string {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + `<title>${escapeHtml(title)}</title></head>`
    + '<body style="font-family:system-ui;padding:2rem">'
    + `<p>${escapeHtml(message)}</p></body></html>`
}

/**
 * Accio 认证服务：两步式 PKCE 登录 + per-ref 串行续期。
 */
export class AccioAuth extends Service {
  /** 本实例默认读写的凭据 ref 名称（`ACCIO_ACCESS_TOKEN`）。 */
  readonly credentialRefName: string

  /**
   * 按凭据 ref 分的**续期互斥队列**（进程内）。
   *
   * 为什么必须有它（Accio 尤其致命）：参考实现记录「刷新会**轮换**
   * refresh_token」，而三条续期入口会并发消费**同一份** ——
   * ① `src/index.ts` 每 30 分钟（含启动首轮）的 `refreshAll`；
   * ② 推理路径的按需续期（DSH 会并发发主回复 + 标题生成 + 上下文压缩）；
   * ③ Jet Hub 账号面板的「刷新」按钮。
   * 不串行必然「1 个成功、其余 `invalid_grant`」，而失败方会把**好账号标死**。
   *
   * ⚠️ 这把锁只在**本进程**内有效：同机跑 dsh web 与 desktop 两个实例时
   * 各自持锁、跨进程互踩仍会发生 —— 那部分靠 `refreshAll` 里「判终态前先
   * 重读凭据」的防护兜住（**两处都必须有**，少一个都会复发）。
   */
  private readonly refreshQueues = new Map<string, SerialQueue>()

  /**
   * 已就「refresh_token 失效」告警过的 ref → 上次告警的服务端原文。
   *
   * 同一账号连续多轮撞上同一个终态错误时只说一次，避免每 30 分钟刷满日志；
   * 错误原文一变（说明状况变了）就重新告警。
   */
  private readonly terminalWarned = new Map<string, string>()

  /** 登录态是否活跃；`stop()` / `logout()` 置 false，阻止在途续期回写已登出的凭据。 */
  private active = true

  constructor(ctx: Context, private readonly options: AccioAuthOptions = {}) {
    super(ctx, `${ACCIO.id}Auth`)
    this.credentialRefName = ACCIO.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /** 取（或建）某个凭据 ref 的续期队列。 */
  private queueFor(refName: string): SerialQueue {
    let queue = this.refreshQueues.get(refName)
    if (queue === undefined) {
      queue = new SerialQueue()
      this.refreshQueues.set(refName, queue)
    }
    return queue
  }

  /** 读取某个凭据 ref 下的当前凭据；缺失或不可解析时 undefined。 */
  private async readCredential(refName: string): Promise<AccioCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    return parseCredential(resolved.value)
  }

  /**
   * 判断两份凭据是否「同一份」（用于识别他处是否已经续过）。
   *
   * ⚠️ 必须**按值**比：`parseCredential` 每次都产生新对象，引用比较恒为
   * 「不相等」，会让幂等短路在每一轮都误判成「凭据已更新」。
   */
  private sameCredential(a: AccioCredential, b: AccioCredential): boolean {
    return a.access_token === b.access_token
      && a.refresh_token === b.refresh_token
      && a.expires_at === b.expires_at
  }

  /** 记录一条警告（经 `ctx.logger`）。 */
  private warn(message: string): void {
    this.ctx.logger?.warn?.(message)
  }

  /**
   * 回写账号池的有效期（**失败只记日志、绝不上抛**）。
   *
   * `syncAccountExpiry` 自身已保证三条硬规矩：失败只 warn、优先用调用方给的
   * `accountId`、现值一致时不写盘；且**凭据里读不到过期时间时不覆盖池内旧值**
   * （写 `undefined` 落盘会被 `JSON.stringify` 丢弃，UI 会从「已过期」变成
   * 「未知」—— 保留旧信息更有价值）。
   */
  private async syncExpiry(
    pool: AccountPool | undefined,
    credential: AccioCredential,
    accountId: string | undefined,
    current: { expiresAt?: number; refreshable?: boolean } | undefined,
  ): Promise<void> {
    await syncAccountExpiry({
      pool,
      provider: ACCIO.id,
      credential,
      accessors: ACCIO_EXPIRY_ACCESSORS,
      accountId,
      current,
      tag: '[accio]',
      warn: (message) => this.warn(message),
    })
  }

  /**
   * 运行完整登录流程（**阻塞**：打开浏览器并等用户授权完成）。
   *
   * ⚠️ Jet Hub 的「+ 新建账号」**不得**用它 —— 浏览器只在用户点击后的短暂
   * 窗口（transient activation，约 5 秒）内允许 `window.open`，阻塞调用返回时
   * 手势早已过期，弹窗被拦后前端兜底会 `window.location.href = loginUrl`
   * 把整个设置页跳走。两步式请用 {@link startLogin}。
   */
  async login(options: AccioLoginOptions = {}): Promise<void> {
    const started = await this.startLoginFlow(options)
    try {
      openBrowser(started.loginUrl)
      await started.result
    } finally {
      started.close()
    }
  }

  /**
   * **两步式登录**：起 loopback → 生成 PKCE/state → **立即**返回 `loginUrl`
   * （不打开浏览器、不等用户），后台再等回调。
   *
   * 顺序说明：**先监听拿到端口，再拼授权 URL** —— `return_url` 必须写实际
   * 端口，否则回调会打到没人监听的地址上。
   */
  async startLogin(options: AccioLoginOptions = {}): Promise<StartedAccioLogin> {
    return await this.startLoginFlow(options)
  }

  /** 两步式与阻塞式共用的实现（落库逻辑必须完全一致）。 */
  private async startLoginFlow(options: AccioLoginOptions): Promise<StartedAccioLogin> {
    const rawRegion = options.region
    if (rawRegion !== undefined && !ACCIO_REGIONS.includes(rawRegion)) {
      // 未登记的值一律回落 `'cn'` 并留痕（不报错）：它会决定登录域名与凭据里的 region。
      this.warn(`[accio] 未识别的登录区域 ${String(rawRegion)}，已回落到 'cn'`)
    }
    const region = normalizeAccioRegion(rawRegion)
    const refName = options.refName ?? this.credentialRefName
    const pkce = createAccioPkcePair()
    const state = createAccioState()

    let settled = false
    let serverClosed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let resolveResult!: () => void
    let rejectResult!: (error: Error) => void
    const result = new Promise<void>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    // 先挂空处理器：结果可能在调用方 await 之前就落定（用户秒授权、或立刻超时），
    // 那一段窗口里 Node 会把它当成未处理拒绝并打印告警（错误仍传给真正的消费者）。
    result.catch(() => {})

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort ?? 0}`)
      if (url.pathname !== ACCIO_CALLBACK_PATH) {
        response.writeHead(404, HTML_HEADERS).end(callbackPage('Accio 授权', '未知的回调路径'))
        return
      }
      const params = url.searchParams
      // ⚠️ `state` 必须原样匹配：少了这一层，**任何**能往 loopback 投递查询串的
      // 本地进程都能把一份攻击者的授权码写进用户账号。
      if ((params.get('state') ?? '') !== state) {
        response.writeHead(400, HTML_HEADERS)
          .end(callbackPage('Accio 授权失败', 'state 校验失败，请回到面板重新发起登录'))
        fail(new Error('accio: 登录回调 state 不匹配（可能是伪造的回调）'))
        return
      }
      const errorCode = params.get('error')
      if (errorCode !== null && errorCode !== '') {
        response.writeHead(400, HTML_HEADERS)
          .end(callbackPage('Accio 授权失败', `授权被拒绝：${errorCode}`))
        fail(new Error(`accio: 授权被拒绝（${errorCode}）`))
        return
      }
      const code = params.get('code') ?? ''
      if (code === '') {
        response.writeHead(400, HTML_HEADERS)
          .end(callbackPage('Accio 授权失败', '回调里没有授权码'))
        fail(new Error('accio: 登录回调缺少授权码'))
        return
      }
      // 先回提示页、再在后台兑换：用户不必盯着一个转圈的标签页等换 token。
      response.writeHead(200, HTML_HEADERS)
        .end(callbackPage('Accio 授权', '授权已收到，可以关闭此页面并返回面板。'))
      void this.finishLogin({
        region,
        code,
        codeVerifier: pkce.verifier,
        redirectUri,
        refName,
        pool: options.pool,
        accountId: options.accountId,
      })
        .then(() => succeed())
        .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
    })

    /** 关闭回调服务器（幂等）。 */
    const closeServer = (): void => {
      if (serverClosed) return
      serverClosed = true
      server.close()
    }

    /**
     * 落定为**失败**：清定时器、关服务器、删占位条目，最后才 reject。
     *
     * ⚠️ **必须等占位条目删完再 reject**：前端 `login.poll` 靠「条目还在」
     * 判断进度，先 reject 会让调用方（与用例）观察到一个短暂的幽灵账号。
     */
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      closeServer()
      void this.removePlaceholder(options).finally(() => { rejectResult(error) })
    }

    /** 落定为**成功**（凭据已落盘、账号池已回填）。 */
    const succeed = (): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      closeServer()
      resolveResult()
    }

    // ⚠️ 兜底超时同样 `unref()`：它只是一个 10 分钟的窗口，不该独占事件循环。
    timer = setTimeout(() => {
      fail(new Error('accio: 登录超时（未收到授权回调）'))
    }, ACCIO_LOGIN_TIMEOUT_MS)
    timer.unref?.()

    // ⚠️ **必须先把 `'error'` 挂上再 `listen`**：`listen` 失败（EADDRINUSE 等）
    // 是**异步 `'error'` 事件**，不属于任何 Promise 链 —— 不挂监听器就会变成
    // 进程级未捕获异常，直接把宿主打挂（本仓库在 trae-oauth 里踩过同一坑）。
    let port: number
    try {
      port = await new Promise<number>((resolve, reject) => {
        let listenSettled = false
        const onListenError = (error: Error): void => {
          if (listenSettled) return
          listenSettled = true
          reject(error)
        }
        server.once('error', onListenError)
        // 只绑回环：这是本地 OAuth 回调，绑全网卡会让同局域网的其它机器
        // 也能往该端口投递伪造的 `?code=`。
        server.listen(0, '127.0.0.1', () => {
          listenSettled = true
          server.removeListener('error', onListenError)
          // 启动成功后降级为常驻监听：运行期错误（EMFILE 等）没有监听者
          // 会再次变成进程级崩溃，由上面的超时兜底即可。
          server.on('error', () => { /* 运行期错误：吞掉以免崩进程 */ })
          const address = server.address()
          resolve(typeof address === 'object' && address !== null ? address.port : 0)
        })
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const message = `accio: 回调端口无法监听（${reason}）；端口可能已被占用，请稍后重试。`
      // 启动失败也要把 `result` 落定，否则调用方 await 它会永远挂起。
      fail(new Error(message))
      throw new Error(message)
    }

    const redirectUri = `http://127.0.0.1:${port}${ACCIO_CALLBACK_PATH}`
    const loginUrl = buildAccioAuthUrl({ region, redirectUri, state, codeChallenge: pkce.challenge })

    // 占位条目必须在**返回 loginUrl 之前**登记，前端 login.poll 才能立刻看到进度。
    if (options.pool !== undefined && options.accountId !== undefined && options.accountId !== '') {
      try {
        await options.pool.addAccount({
          id: options.accountId,
          provider: ACCIO.id,
          nickname: options.accountId,
          enabled: true,
          credentialRef: refName,
          // 凭据还没拿到 ⇒ 此刻诚实标 false；登录成功后回填为真实值。
          refreshable: false,
          createdAt: Date.now(),
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        fail(new Error(`accio: 无法登记账号条目（${reason}）`))
        throw new Error(`accio: 无法登记账号条目（${reason}）`)
      }
    }

    return {
      loginUrl,
      result,
      close: () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        // 用户取消（前端关掉弹窗）：与失败同款处理，删掉占位条目不留幽灵账号。
        // ⚠️ 落定为**拒绝**是刻意的：`login.poll` 靠「条目还在」判进度，而前端
        // 取消时它随后就会被删 ⇒ 轮询自然看到账号消失。这里再给调用方一个
        // 明确的拒绝，避免那个 `result` 永远挂起。
        fail(new Error('accio: 登录已取消'))
        closeServer()
      },
    }
  }

  /** 删除登录占位条目；**任何异常只记日志**（清理不该反噬登录结果）。 */
  private async removePlaceholder(options: AccioLoginOptions): Promise<void> {
    const { pool, accountId } = options
    if (pool === undefined || accountId === undefined || accountId === '') return
    try {
      await pool.removeAccount(accountId)
    } catch (error) {
      this.warn(
        `[accio] 登录失败后删除占位条目 ${accountId} 失败（请手动删除）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 用授权码换 token、写凭据、回填账号池（两步式与阻塞式共用）。 */
  private async finishLogin(params: {
    region: AccioRegion
    code: string
    codeVerifier: string
    redirectUri: string
    refName: string
    pool?: AccountPool
    accountId?: string
  }): Promise<void> {
    const token = await exchangeAccioCode({
      region: params.region,
      code: params.code,
      codeVerifier: params.codeVerifier,
      redirectUri: params.redirectUri,
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
    })
    const credential: AccioCredential = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      // ⚠️ 已是**毫秒**（`accio-oauth.ts` 的兑换层做过一次性 ×1000）。
      expires_at: token.expires_at,
      // 登录时选的区域：续期与推理要按它选登录域（gateway 两个区域同一个）。
      region: params.region,
      ...token.sgcookie === undefined ? {} : { sgcookie: token.sgcookie },
    }
    /**
     * ★★★ **落盘之前补一次 `userinfo`**（issue #177，2026-11-27）。
     *
     * ## 为什么要补
     *
     * 兑换响应**不含任何身份字段**（本文件 `fillAccountEntry` 的注释早就写了这点，
     * 并留了「`userinfo` 落地后可在登录成功后补一次」的 TODO —— 那个模块后来存在了，
     * 但这一步一直没接 ⇒ `fetchAccioUserInfo` 在本仓**零调用**）。
     *
     * 后果：`credential.teamId` 永远为空 ⇒ 所有请求都不带 `x-team-id` ⇒
     * **团队空间的账号永远只看到/使用个人空间额度**（用户实测：团队 8000，插件 520）。
     *
     * ## 三样一起拿，都写进**凭据**（不是只写池）
     *
     * - `activeTeam.teamId` ⇒ 请求头 `x-team-id`（团队额度/模型/推理全依赖它）；
     * - `routeRegion` ⇒ 请求头 `x-accio-route-region`（官方同样注入）；
     * - `userName` ⇒ 账号卡片真实昵称（`fillAccountEntry` 读 `credential.nickname`）。
     *
     * ⚠️ **失败绝不影响登录**：凭据本身已可用，为一次身份补全让用户「登录失败」是更糟的交换。
     * ⚠️ 个人空间 `activeTeam` 为 `null` ⇒ 不写 `teamId` ⇒ 行为与改动前**逐字节相同**。
     */
    try {
      const info = await fetchAccioUserInfo(credential, {
        ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
      })
      if (info !== undefined) {
        if (typeof info.activeTeam?.teamId === 'string' && info.activeTeam.teamId !== '') {
          credential.teamId = info.activeTeam.teamId
          if (info.activeTeam.teamName !== undefined) credential.teamName = info.activeTeam.teamName
        }
        if (info.routeRegion !== '') credential.routeRegion = info.routeRegion
        if (info.userName !== '') credential.nickname = info.userName
      }
    } catch (error) {
      // ⚠️ 只记日志：身份补全失败不能变成「登录失败」。
      this.warn(`登录后补 userinfo 失败（不影响登录，但团队额度可能用不上）：${String(error)}`)
    }
    await this.persistLogin(credential, params.refName)
    // 回填占位条目。⚠️ 失败**只记日志**：凭据已经写好了，因写索引失败而抛错
    // 会让用户看到「登录失败」（而事实相反，只能重新登录一次）。
    if (params.pool !== undefined && params.accountId !== undefined && params.accountId !== '') {
      try {
        await this.fillAccountEntry(params.pool, params.accountId, credential)
      } catch (error) {
        this.warn(
          `[accio] 账号 ${params.accountId} 登录成功但回填账号池失败（不影响使用）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * 落盘凭据。
   *
   * ⚠️ **必须写调用方给的 ref**（Jet Hub 传的是 `ACCIO_ACCOUNT_XXX`），
   * 而不是本实例的默认单凭据 ref —— 后者会让「账号池里那个账号」拿不到凭据，
   * 表现为「登录成功、账号一发请求就报未配置凭据」（本仓库真实缺陷形态）。
   */
  private async persistLogin(credential: AccioCredential, refName: string): Promise<void> {
    this.active = true
    await this.ctx.credentials.set(credentialRef(refName), JSON.stringify(credential))
  }

  /**
   * 登录成功后回填账号池（占位条目的昵称 / 有效期 / 可续期标记）。
   *
   * ⚠️ 昵称暂时只有账号 id：兑换响应**不含任何身份字段**（`userinfo` 是另一个
   * 端点，属 Task 5 的 `accio-credits.ts`）。本任务刻意不 import 那个尚不存在的
   * 模块；它落地后可在登录成功后补一次 `userinfo` 拿真实昵称（与 Qoder 补昵称同款）。
   */
  private async fillAccountEntry(
    pool: AccountPool,
    accountId: string,
    credential: AccioCredential,
  ): Promise<void> {
    const expiresAt = accioCredentialExpiresAtMs(credential)
    const nickname = credential.nickname !== undefined && credential.nickname !== ''
      ? credential.nickname
      : accountId
    await pool.updateAccount(accountId, {
      nickname,
      // ⚠️ **刻意不写 `enabled`**：占位条目本来就是启用的，而在这里多写一次
      // 会在「把一个**已停用**的账号重新登录」时**静默重新启用**它 —— 那是用户
      // 没要求的状态变更（停用是显式意图，见 AGENTS.md「停用只影响自动选号」）。
      refreshable: isAccioRefreshable(credential),
      // ⚠️ 读不到过期时间时**不写这个键**：`updateAccount` 做的是
      // `{ ...entry, ...patch }`，写 `undefined` 落盘会被 `JSON.stringify`
      // 整个丢弃，UI 于是从「已过期」变成「未知」—— 保留旧信息更有价值。
      ...expiresAt === undefined ? {} : { expiresAt },
    })
  }

  /**
   * 按凭据 ref 续期**指定账号**的凭据（Jet Hub 账号卡片 / 定时器路径）。
   *
   * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT 的真实缺陷）：UI 账号
   * 卡片的「有效期」读的正是**池里的值**，而不是凭据里 access_token 的真实过期
   * 时间。只 `credentials.set` 的后果是「凭据续好了、界面一直显示已过期」，
   * 且没有任何自救手段（「重测」按钮的 refresh 是刻意的 no-op）。
   * ⇒ `pool` 与 `accountId` **在实际调用中必须传**（签名保持可选只为兼容既有形态）。
   *
   * @param pool 账号池；提供时把新 `expiresAt` / `refreshable` 写回。
   * @param accountId 账号 id。**调用方已知时请显式传入** —— 否则只能按凭据内容
   *   反查，而 Accio 的 `access_token` 每次都会轮换，反查**可能失效**。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    await this.queueFor(refName).run(async () => {
      const credential = await this.readCredential(refName)
      if (credential === undefined) throw new Error('凭据未配置')
      if (!isAccioRefreshable(credential)) {
        throw new AccioRefreshTokenExpiredError('无 refresh_token，请重新登录')
      }
      // ⚠️ **锁内重读**：排队等锁期间，另一条续期入口可能已经把它续好了。
      // 仍在有效期内就直接对账返回，不再发第二次请求（少烧一次 refresh_token）。
      if (!shouldRefreshNow(accioCredentialExpiresAtMs(credential))) {
        await this.syncExpiry(pool, credential, accountId, undefined)
        return
      }
      const refreshed = await this.refreshCredential(credential)
      if (!this.active) return
      await this.ctx.credentials.set(credentialRef(refName), JSON.stringify(refreshed))
      await this.syncExpiry(pool, refreshed, accountId, undefined)
    })
  }

  /**
   * 加锁续期：拿到锁后**重读凭据**，只在他处还没续过的时候真的发请求。
   *
   * 与 {@link refreshAccountCredential} 共用同一条 per-ref 队列，因此
   * 「批量续期」「按需续期」「面板刷新」三条入口在同一进程内必然串行；
   * 锁内重读则覆盖跨进程场景（同机 web + desktop 两个实例）—— 那种互斥锁
   * 管不到，只能靠「先看当前值」兜，少烧一次 refresh_token。
   *
   * @param credential 调用方读到的那份凭据（可能已在等锁期间被他处续期）。
   */
  private async refreshCredentialUnderLock(
    refName: string,
    credential: AccioCredential,
  ): Promise<AccioCredential> {
    return await this.queueFor(refName).run(async () => {
      const latest = (await this.readCredential(refName)) ?? credential
      if (!this.sameCredential(latest, credential)
        && !shouldRefreshNow(accioCredentialExpiresAtMs(latest))) {
        this.ctx.logger?.info?.(
          '[accio] 凭据已被他处续期，跳过本次续期请求（避免重复消费 refresh_token）',
        )
        return latest
      }
      return await this.refreshCredential(latest)
    })
  }

  /**
   * 对一份凭据执行一次续期并返回新凭据（**不触碰存储**）。
   *
   * 终态判定（只有服务端明确说 refresh_token 不认了才算）：
   * `isAccioTerminalRefreshError` 命中 ⇒ 抛 {@link AccioRefreshTokenExpiredError}；
   * 其余（网络抖动、5xx、超时、读体失败）⇒ 普通 `Error`，可重试。
   */
  private async refreshCredential(credential: AccioCredential): Promise<AccioCredential> {
    let token: AccioTokenResult
    try {
      token = await refreshAccioCredential({
        credential,
        ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
      })
    } catch (error) {
      if (isAccioTerminalRefreshError(error)) {
        throw new AccioRefreshTokenExpiredError(
          error instanceof Error ? error.message : String(error),
        )
      }
      // ⚠️ 传输层失败**不能**判为终态：网络抖动不该让用户重新登录。
      throw error instanceof Error ? error : new Error(String(error))
    }
    return {
      // 先铺开旧凭据：`region` / `user_id` / `accio_id` / `nickname` 等
      // **不参与续期**的字段必须原样保留（丢了 region 会选错登录域）。
      ...credential,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: token.expires_at,
      ...token.sgcookie === undefined ? {} : { sgcookie: token.sgcookie },
    }
  }

  /**
   * 批量续期本产品的所有账号（`src/index.ts` 的定时器，含启动首轮）。
   *
   * ## 两条**不得**过滤的铁律（各是一次真实事故）
   *
   * 1. **不看账号是否停用**：停用只应影响账号池的自动选号，与「凭据是否需要
   *    保鲜」无关。真实缺陷：两处都按停用过滤 ⇒ 停用期间 refresh_token 一路
   *    放到失效，用户重新启用后拿到的是**死凭据**，只能重新登录。
   * 2. **不按池里的 `refreshable` 过滤**：那个布尔是**每轮由凭据对账出来的
   *    结果**，不是「曾被服务端拒绝过」的案底。拿它当门禁会把一次瞬时失败
   *    固化成**单向门**（codearts 真实事故：池里 2 个账号被误标后
   *    「自动续期没工作、重启也还是 401」，而凭据本体完好）。
   *
   * ⇒ 权威判据只有**凭据材料**（`isAccioRefreshable`：`refresh_token` 非空）。
   * 凭据缺材料才写 false，且写前先比现值（定时器每 30 分钟一轮，别重复整体落盘）。
   *
   * ⚠️ **「本轮不刷」的分支绝不能直接跳过对账**：存量账号的凭据早已在别处
   * （IDE / 上一轮）续好，池里还是旧值；只修「续期时回写」是不够的，跳过时
   * 若不对账，UI 会**永远**显示「已过期」。判据是「与凭据不一致」（不是
   * 「池值已过期」），容差 1 秒 —— 由 `refreshAccountWithReconcile` 承担。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(ACCIO.id)
    for (const entry of accounts) {
      const ref = credentialRef(entry.credentialRef)
      let credential: AccioCredential | undefined
      try {
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          // 凭据确实不存在：这才是「不可续期」的真实含义（写盘前先比现值，
          // 避免每轮都把整个账号列表重写一遍）。
          if (entry.refreshable) await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        credential = parseCredential(resolved.value)
        if (credential === undefined || !isAccioRefreshable(credential)) {
          if (entry.refreshable) await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        if (entry.refreshable === false) {
          // 池里说不能续、凭据说能续 —— 以**凭据**为准。这里只记日志不回写：
          // 下面 `refreshAccountWithReconcile` 的有效期对账（`syncAccountExpiry`
          // 会比较 `refreshableOf(credential)` 与池内现值）本来就会把它改回来，
          // 多写一次只会让账号列表多一次无谓的整体落盘。
          this.ctx.logger?.info?.(
            `[accio] 账号 ${entry.id} 的凭据具备续期材料，本轮恢复自动续期（此前的标记与凭据不符）`,
          )
        }
        await refreshAccountWithReconcile({
          pool,
          provider: ACCIO.id,
          tag: '[accio]',
          accountId: entry.id,
          credential,
          accessors: ACCIO_EXPIRY_ACCESSORS,
          current: entry,
          refresh: (c) => this.refreshCredentialUnderLock(entry.credentialRef, c),
          save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
          makeTerminalError: (message) => new AccioRefreshTokenExpiredError(message),
          warn: (message) => this.warn(message),
          info: (message) => this.ctx.logger?.info?.(message),
        })
      } catch (error) {
        if (error instanceof AccioRefreshTokenExpiredError) {
          const detail = error instanceof Error ? error.message : String(error)
          // ⚠️ **判终态前先确认「我刚才用的那一份 refresh_token 还是不是当前那一份」**。
          // 并发下服务端拒的是**旧的**那一份（它已因别人的成功请求而失效），
          // 而磁盘上此刻躺着一份**新的、可用**的凭据。这属于「他处已续成功」，
          // 不是「本账号不能续期」—— 不加这层判据，一次交错就会把好账号永久标死。
          const latest = await this.readCredential(entry.credentialRef).catch(() => undefined)
          if (latest !== undefined
            && isAccioRefreshable(latest)
            && credential !== undefined
            && latest.refresh_token !== credential.refresh_token) {
            this.ctx.logger?.info?.(
              `[accio] 账号 ${entry.id} 续期被拒但凭据已被他处更新（并发重放），`
              + '按最新凭据对账，不标记为不可续期',
            )
            await this.syncExpiry(pool, latest, entry.id, entry)
            continue
          }
          if (entry.refreshable) {
            try {
              await pool.updateAccount(entry.id, { refreshable: false })
            } catch {
              // 忽略 updateAccount 本身的错误
            }
          }
          // 同一账号、同一服务端原因只告警一次：真失效时用户要做的是重新登录，
          // 每 30 分钟重复同一行只会把有用的信息埋掉。
          const last = this.terminalWarned.get(entry.credentialRef)
          if (last !== detail) {
            this.terminalWarned.set(entry.credentialRef, detail)
            this.warn(
              `[accio] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`
              + `；服务端原文：${detail}`,
            )
          }
        } else {
          // 非终态失败（网络抖动、5xx、超时…）也必须留日志：静默会让账号在 UI 上
          // 永远显示「可续期」却刷不动，无从排查。
          this.warn(
            `[accio] 账号 ${entry.id} 续期失败：`
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // 单账号失败不中断其余账号
      }
    }
  }

  /**
   * 拉取远端模型目录（`POST /api/llm/config/v2`，token 在 body）。
   *
   * 优先用账号池里的可用账号；无池或池为空时回退到本实例的默认凭据 ref。
   * 失败或未登录一律返回**空数组**（调用方回退到 `ACCIO.fallbackModels`），
   * 与 `TraeAuth.fetchModels` / `LobsteraiAuth.fetchModels` 同语义。
   *
   * ⚠️ **「没有凭据」不是异常**：未登录的用户每次列模型都会走到这条分支，
   * 打日志只会制造噪声。只有真正的失败（HTTP 非 2xx、网络异常）才记录。
   */
  async fetchModels(pool?: AccountPool): Promise<AccioFallbackModel[]> {
    let credential: AccioCredential | undefined
    if (pool !== undefined) {
      const available = await pool
        .getAvailableAccount<AccioCredential>(ACCIO.id, '')
        .catch(() => null)
      if (available !== null) credential = available.credential
    }
    if (credential === undefined) {
      credential = await this.readCredential(this.credentialRefName)
    }
    if (credential === undefined || credential.access_token.length === 0) return []
    try {
      const response = await this.fetchImpl(`${ACCIO.gatewayBaseUrl}${ACCIO_CATALOG_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          /**
           * ★★★ **目录也要带团队身份**（issue #177）。
           *
           * 官方对「除 `publicCatalog` 外的所有出站请求」都注入 `x-team-id` ——
           * 目录（`/api/llm/config/v2`）也在其中。团队空间可用的模型集可能与个人不同，
           * 不带就永远按个人空间下发。
           *
           * ⚠️ 空值不发（与 `accioHeaders` 的同名判据一致）。
           */
          ...typeof credential.teamId === 'string' && credential.teamId.trim() !== ''
            ? { 'x-team-id': credential.teamId.trim() }
            : {},
          ...typeof credential.routeRegion === 'string' && credential.routeRegion.trim() !== ''
            ? { 'x-accio-route-region': credential.routeRegion.trim() }
            : {},
          /**
           * ★★★ **目录可见性的关键头**（issue #177 作者实测）：
           * 国际站带 `x-package-region: GLOBAL` ⇒ **30 个模型含 9 个 GPT**；
           * 不带 ⇒ 16 条、**无 GPT/Claude/Gemini**。
           * ⚠️ 只对 `global`（`cn` 未实测）。
           */
          ...credential.region === 'global' ? { 'x-package-region': 'GLOBAL' } : {},
          ...credential.region === 'cn' ? { 'x-package-region': 'CN' } : {},
        },
        body: JSON.stringify({ token: credential.access_token }),
        signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        this.warn(`fetchModels: HTTP ${response.status} ${response.statusText}`)
        return []
      }
      return parseAccioCatalog(await response.json() as unknown)
    } catch (error) {
      this.warn(`fetchModels: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /** 移除已存储的凭据（账号条目由调用方决定是否删除）。 */
  async logout(): Promise<void> {
    this.active = false
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
  }

  /**
   * 停止服务：置 inactive，阻止在途续期回写已登出的凭据。
   *
   * 与 CodeArts 同因：登录态与续期都归属账号池条目，续期由 `src/index.ts` 的
   * 多账号调度器（{@link refreshAll}）驱动，本服务**没有**自己的调度器可停。
   */
  stop(): void {
    this.active = false
  }
}
