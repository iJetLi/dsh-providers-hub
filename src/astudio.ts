/**
 * AStudio 协议常量、凭据结构与**纯函数**（无网络副作用；网络流程见
 * `astudio-auth.ts` / `astudio-adapter.ts` / `astudio-oauth.ts`）。
 *
 * ## 本文件承载的四类「只能实测、不能推理」的判据
 *
 * 1. **信封**：控制面（模型目录、`bot/models/configs`）是 `{code, message, data}`，
 *    ⚠️ **HTTP 200 但 `code !== 0` 也是失败**（本仓库反复踩过的「成功但没内容」格）；
 *    推理面是 OpenAI 裸体，错误形态是 `{"error":{code,message,type}}`。
 * 2. **鉴权头**：`Authorization: Bearer <modelBearerToken>`，可选
 *    `X-Account-Id` / `clientType` / `studioVersion`（实测三者**都不带也能 200**）。
 *    ⚠️ **没有** bkn / DJB2 之类的现算签名（`astudioCookieHeader` 是纯字符串拼接）。
 * 3. **凭据失效的唯一触发点是上游 HTTP 401**：磁盘上**没有任何 TTL / expiresAt**，
 *    所以本地**无法**预判到期 —— 见 {@link astudioCredentialExpiresAtMs}。
 * 4. **思考档位实测生效**（`reasoning_effort`）：`none` 时
 *    `completion_tokens=1` 且无 `reasoning_tokens`；`max` 时
 *    `completion_tokens_details.reasoning_tokens=203`；非法值**不报错**、
 *    按最大档跑 ⇒ 档位必须**只声明远端下发的集合**（{@link astudioReasoningOf}）。
 */

import { createHash } from 'node:crypto'
import { maskLobsteraiPhoneTail } from './lobsterai.js'
import {
  ASTUDIO_SESSION_DEAD_CODES,
  type AstudioFallbackModel,
  type AstudioProduct,
} from './astudio-product.js'

// ── 凭据结构 ──

/**
 * 持久化的 AStudio 凭据。
 *
 * 字段名保持 `snake_case` 且**必须有 `access_token`**：
 * `AccountPool.findAccountIdByCredential` 对非 codearts 的 provider 统一取它作
 * 身份标识（文档「路径 B」的硬要求）。`access_token` 存的就是磁盘的
 * `modelBearerToken`（同一份值的插件内名称，别在下游再造第三个名字）。
 *
 * ## ⚠️ 为什么凭据里要装「Cookie 四字段」
 *
 * 本 provider 的续期不是「拿 refresh_token 换新 token」，而是
 * **拿登录会话 Cookie 重新问账号后端要一份 modelBearerToken**
 * （`GET /bot/models/configs`）。⇒ 只存 `access_token` 的凭据**永远续不了**，
 * 必须把 `sso_session_id` / `account_id` / `token` 一起持久化 ——
 * 这与 `LobsteraiCredential` 必须带 `uuid` / `first_keyfrom` 是同一类设计约束。
 */
export interface AstudioCredential {
  /** 活体模型凭据（`Authorization: Bearer <access_token>`），来自磁盘 `modelBearerToken`。 */
  access_token: string
  /** 账号 id（`X-Account-Id` 头的取值；实测与 `uid` 同值，但语义不同，各自保留）。 */
  account_id?: string
  /** 用户 id（对话请求体 `user` 字段与账号池身份）。 */
  uid?: string
  /** 昵称 / 手机号（UI 展示；手机号会被掩码，见 {@link astudioDisplayNickname}）。 */
  nickname?: string
  /** 登录会话 id（Cookie `ssoSessionId` 与 `sso_sessionid` 都用它，实测客户端就是**重复两次**）。 */
  sso_session_id?: string
  /** 账号后端 token（Cookie 第四字段；⚠️ 与 `access_token` 不是同一个东西）。 */
  token?: string
  /** 登录方式（磁盘 `loginMethod`，实测 `wechat`）。仅作展示与排障线索。 */
  login_method?: string
  /** 登录时刻（磁盘 `loggedInAt` 的 ISO 串）。⚠️ **不参与到期判定**（见模块头第 3 条）。 */
  logged_in_at?: string
  /**
   * 本凭据的来源标记（诊断用，不参与协议）。
   *
   * - `session-file`：直读磁盘 `astron-session.json`（快路径，零网络）；
   * - `account-backend`：从 `bot/models/configs` 重取的**权威**值。
   */
  source?: 'session-file' | 'account-backend'
}

/** 磁盘 `astron-session.json` 的**实测字段集**（全 10 个键，明文、无 TTL）。 */
export interface AstudioSessionFile {
  accountId?: string
  uid?: string
  token?: string
  ssoSessionId?: string
  banned?: boolean | string
  modelBearerToken?: string
  loginMethod?: string
  loggedInAt?: string
  mobile?: string
}

// ── 凭据读取与变更检测 ──

/**
 * 从磁盘会话文件对象构造凭据；**必需字段缺失时返回 `undefined`**。
 *
 * 判据：`modelBearerToken` 非空（启动侧的硬门槛是
 * `if (!session || !token || !isValidAstronModelCredential(token)) throw …`，
 * 我们只把它翻译成本地可读的「没有凭据」，不重复它的校验细节）。
 *
 * 展示名优先 `mobile`、退回 `accountId`：实测磁盘里 `mobile` 就是**手机号原值**
 * （与 lobsterai 的「服务端把手机号当昵称」同形）⇒ 交给
 * {@link astudioDisplayNickname} 统一掩码，绝不把完整号码写进 UI。
 *
 * ⚠️ 对**磁盘内容只读**：本插件绝不写 `astron-session.json` / `config.toml`
 * （那是客户端的文件，写坏的后果由用户的登录态承担）。
 */
export function astudioCredentialFromSessionFile(
  session: AstudioSessionFile | undefined,
): AstudioCredential | undefined {
  if (session === undefined || session === null) return undefined
  const accessToken = typeof session.modelBearerToken === 'string' ? session.modelBearerToken.trim() : ''
  if (accessToken.length === 0) return undefined
  const accountId = typeof session.accountId === 'string' ? session.accountId : ''
  return {
    access_token: accessToken,
    ...accountId.length > 0 ? { account_id: accountId } : {},
    ...typeof session.uid === 'string' && session.uid.length > 0 ? { uid: session.uid } : {},
    nickname: typeof session.mobile === 'string' && session.mobile.length > 0
      ? session.mobile
      : accountId,
    ...typeof session.ssoSessionId === 'string' ? { sso_session_id: session.ssoSessionId } : {},
    ...typeof session.token === 'string' ? { token: session.token } : {},
    ...typeof session.loginMethod === 'string' ? { login_method: session.loginMethod } : {},
    ...typeof session.loggedInAt === 'string' ? { logged_in_at: session.loggedInAt } : {},
    source: 'session-file',
  }
}

/**
 * 凭据的**变更检测指纹** = `sha256(access_token)` 前 8 位。
 *
 * ## 为什么需要它（而不是读客户端的 `credential_generation`）
 *
 * 客户端用 `astronModelRuntimeFingerprint(token, uid)` 派生一个 generation，
 * 但那个 Map 是**进程内存态**（实测只注入给 acode 内核做代际校验、不落盘）
 * ⇒ 反代读不到。磁盘值可能已被客户端换成新的（客户端才会写那两个文件），
 * 所以「我上次用的那一份还作数吗」只能**自己算指纹**比对 ——
 * 这也是客户端日志里用的同一套算法（`describeAstronCredential = sha256(token)[:8]`），
 * 便于和客户端日志对上，且**不会把明文写进日志**。
 *
 * 空串返回空串：调用方据此区分「没有凭据」与「有凭据但值变了」。
 */
export function astudioCredentialFingerprint(accessToken: string): string {
  if (accessToken.length === 0) return ''
  return createHash('sha256').update(accessToken).digest('hex').slice(0, 8)
}

/**
 * ⚠️ **恒返回 `undefined`** —— 这不是没写完，而是本 provider 的真实语义。
 *
 * 磁盘 `astron-session.json` 实测**没有** `expiresAt` / `ttl` / `refreshToken`
 * 任何一个（`loggedInAt` 只参与客户端的「换账号 epoch」哈希，与到期无关）。
 * 因此**任何本地到期预判都是编造**：把它写成「按 `loggedInAt + 2h` 猜」会让
 * 凭据明明还能用却被判死（或反过来），而唯一可靠的失效信号是**上游 HTTP 401**。
 *
 * 保留这个函数（而不是不实现）的原因：`ProviderRuntime.expiry` /
 * `ExpiryAccessors` / 账号池卡片都要求它存在。返回 `undefined` 的既有语义是
 * 「不判定过期」（见 `isLobsteraiExpired` 的同款处理），账号卡片据此显示
 * 「长期有效」而不是假的倒计时。
 */
export function astudioCredentialExpiresAtMs(_credential?: AstudioCredential): number | undefined {
  return undefined
}

/** 凭据是否可「刷新」——本家的刷新不需要额外材料（Cookie 在凭据里就算可刷）。 */
export function isAstudioRefreshable(credential: Pick<AstudioCredential, 'access_token'> | undefined): boolean {
  return credential !== undefined
    && typeof credential.access_token === 'string'
    && credential.access_token.length > 0
}

/**
 * AStudio 账号在 Jet Hub 里的展示名：手机号统一掩码到**只露末 2 位**。
 *
 * 复用 {@link maskLobsteraiPhoneTail}（跨 provider 借用**纯函数**在本仓库有先例：
 * `lobsterai.ts` / `trae.ts` 都从 `buddy.ts` 借 `jwtExpiresAtMs`）。
 * ⚠️ 刻意不复制一份掩码实现：两处判据必然漂移，而「手机号漏出几位」是用户
 * 明确定过的口径（lobsterai 侧因露 4 位被要求整改过）。
 */
export function astudioDisplayNickname(
  credential: Pick<AstudioCredential, 'nickname'> | undefined,
  fallbackId: string,
): string {
  const nickname = typeof credential?.nickname === 'string' ? credential.nickname.trim() : ''
  if (nickname.length === 0) return fallbackId
  return maskLobsteraiPhoneTail(nickname)
}

// ── 请求头 ──

/**
 * 构造控制面（账号后端）用的 **Cookie 串**。
 *
 * 实测客户端形态（`cookieHeader` @3374394）：`ssoSessionId` 与 `sso_sessionid`
 * **同值各发一次**（驼峰 + 蛇形两份），加上 `account_id` 与 `token`。
 * ⚠️ 这不是冗余失误，是服务端认的键名集合 —— 少任一个都可能命中不同的校验分支。
 * 缺失的字段**跳过键**而不是发空值（空 Cookie 项会让部分网关直接判未登录）。
 */
export function astudioCookieHeader(credential: AstudioCredential): string {
  const credRecord = credential as unknown as Record<string, unknown>
  const ssoId = credential.sso_session_id
    ?? (typeof credRecord.ssoSessionId === 'string' ? credRecord.ssoSessionId : undefined)
  const accId = credential.account_id
    ?? (typeof credRecord.accountId === 'string' ? credRecord.accountId : undefined)
  const tok = credential.token
    ?? (typeof credRecord.token === 'string' ? credRecord.token : undefined)
  const pairs: Array<[string, string | undefined]> = [
    ['ssoSessionId', ssoId],
    ['sso_sessionid', ssoId],
    ['account_id', accId],
    ['token', tok ?? ssoId],
  ]
  return pairs
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

/**
 * 构造**推理**请求头（Bearer 是唯一的必需项）。
 *
 * 三个可选头（`X-Account-Id` / `clientType` / `studioVersion`）实测**都不带也能 200**；
 * 带上是为了与真实客户端形状一致（服务端将来加强校验时我们不受影响）。
 */
export function astudioChatHeaders(
  credential: AstudioCredential,
  product: AstudioProduct,
  accept = 'application/json',
): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: accept,
    'Content-Type': 'application/json',
    ...credential.account_id !== undefined && credential.account_id.length > 0
      ? { 'X-Account-Id': credential.account_id }
      : {},
    clientType: product.clientType,
    studioVersion: product.studioVersion,
  }
}

/**
 * 构造**控制面**（`bot/models/configs`）请求头。
 *
 * ⚠️ 这里**不带** `Authorization`：实测该端点按 Cookie 鉴权（客户端也只发
 * `Accept` + `Cookie` + 自动注入的两个形状头）。带上 Bearer 反而可能触发
 * 「先验 apikey 再验会话」的分支，把一个 200 变成 401 —— 我们无从证实，
 * 但**与客户端逐字一致**是唯一不需要证明的选项。
 */
export function astudioControlHeaders(
  credential: AstudioCredential,
  product: AstudioProduct,
): Record<string, string> {
  const cookie = astudioCookieHeader(credential)
  return {
    Accept: 'application/json',
    ...cookie.length > 0 ? { Cookie: cookie } : {},
    clientType: product.clientType,
    studioVersion: product.studioVersion,
  }
}

// ── 统一信封 ──

/** 信封解析成功。 */
export interface AstudioEnvelopeSuccess {
  ok: true
  /**
   * `data` 的**对象**形态（模型目录 `{models:[…]}` 走这里）。
   *
   * ⚠️ `data` 是数组时这里是**空对象**而不是 `undefined` —— 读字段的一方
   * 因此不需要判 `undefined`，但**也不能**靠 `Object.keys(data).length>0`
   * 反推「信封有没有内容」（数组形态下恒为 0）。数组一方读 {@link rows}。
   */
  data: Record<string, unknown>
  /**
   * `data` 的**数组**形态（实测 `bot/models/configs` 就是数组：
   * `{flag:true,code:0,desc:"成功",count:null,data:[{model,api_key,…}]}`）。
   *
   * ⚠️⚠️ **这一条是本轮（#392）对着真实抓样修出来的缺陷**：本函数此前把
   * 「`data` 是数组」直接判成失败，而唯一的权威凭据源**恰好**就是数组形态
   * ⇒ 若没发现，401→重取这条自愈链会**永远**读不到 `api_key`，表现成
   * 「凭据刷不动、每轮都要人工重登」。两个形状共用一个 `{code,data}` 信封，
   * 只看一个形状的那份判据必然漏掉另一个。
   */
  rows?: readonly unknown[]
}
/** 信封解析失败。 */
export interface AstudioEnvelopeFailure {
  ok: false
  /** 业务码；读不出时为 `-1`。 */
  code: number
  /** 可读原因（优先服务端 `message`，缺失时给结构性说明）。 */
  message: string
  /** 本失败是否意味着**会话已死**（必须人工重新登录，静默重试无意义）。 */
  sessionDead: boolean
}
export type AstudioEnvelopeResult = AstudioEnvelopeSuccess | AstudioEnvelopeFailure

/** 从 JSON 安全读取字符串字段（兼容后端把数字返回成 number）。 */
export function astudioReadString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 从 JSON 安全读取数字字段（兼容字符串形态；上界防溢出，同 `readNumberField` 的理由）。 */
export function astudioReadNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 1e15 ? value : undefined
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && Math.abs(parsed) <= 1e15) return parsed
  }
  return undefined
}

/**
 * 解析 `{code, message, data}` 信封。
 *
 * 三条判据缺一不可：
 * 1. 响应体必须是对象；
 * 2. `code === 0`（⚠️ **HTTP 200 但 `code !== 0` 也是失败** —— 本仓库的反复教训）；
 * 3. `data` 必须是**对象**：`code:0` 但 `data:null` 是本家「会话失效」的真实形态
 *    （实测无 Cookie 时回 `{flag:false,code:99909001,desc:"系统异常",data:null}`），
 *    只看 `code` 会把它读成「成功但没数据」，随后在解引用处崩在更远的地方。
 *
 * ⚠️ 实测本家**同时**存在 `message` 与 `desc` 两种文案字段（后者出现在账号后端的
 * 另一族响应里），故按 `message` → `desc` → `code=N` 三级回退取可读原因。
 * 只读一个字段的那一族就会在 UI 上显示成「未知错误」。
 */
export function parseAstudioEnvelope(body: unknown): AstudioEnvelopeResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: -1, message: '响应不是 JSON 对象', sessionDead: false }
  }
  const record = body as Record<string, unknown>
  const rawCode = astudioReadNumber(record, 'code')
  const message = astudioReadString(record, 'message')
    || astudioReadString(record, 'desc')
  // ⚠️ `code` **缺席**与 `code !== 0` 必须区分：客户端 `parseGatewayCatalog` 的判据是
  // `code === undefined ? 直接取体 : code === 0 才取 data`（实测上游确有不带 code 的
  // 端点形态）。把「没有 code」当失败会让某个将来改形状的端点整体不可用。
  if (rawCode !== undefined && rawCode !== 0) {
    return {
      ok: false,
      code: rawCode,
      message: message.length > 0 ? message : `code=${rawCode}`,
      sessionDead: ASTUDIO_SESSION_DEAD_CODES.has(rawCode),
    }
  }
  const data = record.data
  // ⚠️ **两种形状都合法**：目录端点是 `data:{models:[…]}`（对象），账号后端
  // `bot/models/configs` 是 `data:[{model,api_key,…}]`（**数组**）。判据必须
  // 接受两者 —— 见 {@link AstudioEnvelopeSuccess.rows} 里登记的真实缺陷。
  // 「空」的定义：`null`/`undefined`、空对象 `{}`、空数组 `[]` 三种都算拿不到东西。
  if (data === null || data === undefined) {
    return {
      ok: false,
      code: rawCode ?? 0,
      message: message.length > 0 ? message : 'data 为空（会话可能已失效）',
      // `code:0` + 空 `data` 在读 `bot/models/configs` 时等价于「账号下没有可用模型
      // 凭据」⇒ 属终态（实测客户端在此抛 AuthoritativeModelCredentialError）。
      sessionDead: true,
    }
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return {
        ok: false,
        code: rawCode ?? 0,
        message: message.length > 0 ? message : 'data 为空数组（会话可能已失效）',
        sessionDead: true,
      }
    }
    // 数组形态下 `data` 给空对象：调用方读 `rows`，不会误以为「有字段可读」。
    return { ok: true, data: {}, rows: data }
  }
  if (typeof data !== 'object') {
    // 标量（字符串/数字/布尔）：既不是对象也不是数组 ⇒ 无有效载荷，判失败。
    return {
      ok: false,
      code: rawCode ?? 0,
      message: message.length > 0 ? message : 'data 不是对象或数组',
      sessionDead: true,
    }
  }
  return { ok: true, data: data as Record<string, unknown> }
}

/**
 * 判断一次**凭据重取**是否属于终态失败（必须人工重新登录，不得循环重试）。
 *
 * 判据对齐客户端的 `isAuthoritativeModelCredentialFailure` + 「data 里无 api_key」：
 * ①信封判出 `sessionDead`；②业务码命中已知失效码。其余（网络抖动、5xx、
 * 未知业务码）都是**可重试**，不能固化成「账号已死」—— 那是 codearts 的
 * 「单向门」事故形态。
 */
export function isAstudioSessionDeadError(code: number, message = ''): boolean {
  if (ASTUDIO_SESSION_DEAD_CODES.has(code)) return true
  // 文案兜底只认**明确**的措辞：账号后端的失效文案含「登录」字样。
  // 不用泛化的「失败」/「错误」，否则一次 500 也会被读成要重新登录。
  return /未登录|重新登录|会话(已)?(过期|失效)|登录(状态)?失效|not\s+logged\s*in|login\s+required/i.test(message)
}

// ── 401 → 重取 → 重试的**决策**（纯函数，供单测逐格覆盖） ──

/** {@link astudioAuthRetryPlan} 的三种结论。 */
export type AstudioAuthRetryAction = 'none' | 'refresh-and-retry' | 'terminal'

/**
 * 决定一次推理失败之后**该不该换凭据重试**。
 *
 * ## 为什么它是纯函数
 *
 * 本家的失效语义反直觉（磁盘无 TTL ⇒ 唯一信号是 HTTP 401），而三条入口
 * （推理按需 / 面板刷新 / 可选定时轮询）都共用这一套判断。写成函数体里的
 * `if` 会让「401 时重取几次」这条最关键的不变式只能靠 e2e 覆盖。
 *
 * ## 判据（每条都有实测依据）
 *
 * | 输入 | 结论 | 依据 |
 * |---|---|---|
 * | `status !== 401` | `none` | 客户端侧唯一自动重取点就是 `upstream.statusCode === 401`；**流内 code 不触发换凭据** |
 * | 401 且本轮还没试过重取 | `refresh-and-retry` | 重取是幂等纯读（`bot/models/configs` 零副作用），值得试一次 |
 * | 401 但已经重取过一次 | `terminal` | ⚠️ **不得无限循环**：换到同一份死凭据时，重试会永远 401 |
 * | `refreshFailed` | `terminal` | 权威源都拿不到 ⇒ 只能人工重新登录（本家没有 refresh_token） |
 *
 * ⚠️ `refreshSucceeded === true` **不**保证值变了（实测客户端就是「不等就换、
 * 相等就留」）；但值相同仍值得重试一次吗？—— 答案是**不**：同 token 同 401
 * 是确定性失败，重试只会白烧一轮。故「重取成功但指纹没变」由调用方传
 * `refreshFailed: false` + `attempted: true` 走到 `terminal`。
 */
export function astudioAuthRetryPlan(params: {
  status: number
  attemptedRefresh: boolean
  refreshFailed: boolean
}): AstudioAuthRetryAction {
  if (params.status !== 401) return 'none'
  if (params.refreshFailed) return 'terminal'
  if (params.attemptedRefresh) return 'terminal'
  return 'refresh-and-retry'
}

// ── 错误码 → DSH 错误码的映射 ──

/** 推理失败的语义分类。 */
export type AstudioErrorKind =
  | 'auth'            // 凭据失效（需要重取/重新登录）
  | 'model-not-found' // 上游没有该模型的路由
  | 'quota'           // 积分/额度耗尽
  | 'rate-limit'      // 限流
  | 'context-window'  // 上下文超限
  | 'timeout'         // 空闲超时
  | 'transport'       // 传输层
  | 'server'          // 上游故障（可重试）
  | 'bad-request'     // 请求形状问题（重试无意义）
  | 'unknown'

/** {@link classifyAstudioError} 的输出。 */
export interface AstudioErrorInfo {
  kind: AstudioErrorKind
  /** 建议的 `LlmError` code（DSH 用它决定是否重试 / 是否替换文案）。 */
  llmCode: string
  /** 给用户的可读文案（**必须含上游原文片段**，否则查不出原因）。 */
  message: string
}

/**
 * OpenAI 错误体里 `error.code` / `error.type` 的字面量 → 语义。
 *
 * 只登记**实测见过**的（`model_not_found`、`Unauthorized` 无 code 只有 message），
 * 其余按状态码兜底。⚠️ 状态码本身不足以分类：实测 401 的体有两种
 * （`HMAC signature cannot be verified: apikey not found` = 凭据本身无效；
 * `Unauthorized` = 没带凭据），两者都归 `auth`，但**都不能归 `bad-request`**。
 */
const ASTUDIO_WIRE_CODES: ReadonlyMap<string, AstudioErrorKind> = new Map([
  ['model_not_found', 'model-not-found'],
  ['invalid_api_key', 'auth'],
  ['apikey_not_found', 'auth'],
  ['insufficient_quota', 'quota'],
  ['quota_exceeded', 'quota'],
  ['rate_limit_exceeded', 'rate-limit'],
  ['context_length_exceeded', 'context-window'],
])

/** 读取 OpenAI 错误体 `{"error":{code,message,type}}` 的字段。 */
export function astudioOpenAiErrorFields(body: string): { code: string; message: string; type: string } | undefined {
  if (body.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const error = (parsed as Record<string, unknown>).error
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as Record<string, unknown>
  return {
    code: typeof record.code === 'string' ? record.code : (typeof record.code === 'number' ? String(record.code) : ''),
    message: typeof record.message === 'string' ? record.message : '',
    type: typeof record.type === 'string' ? record.type : '',
  }
}

/**
 * 把一次推理失败映射成 DSH 的 `LlmError` code。
 *
 * ## ⚠️ 两条不能合并的格子（都与「换凭据」有关）
 *
 * - `401/403` → `AUTH`：DSH **会**因此触发 `refreshAfterUnauthorized` 语义
 *   （本插件里由适配器自己完成重取，见 `astudio-adapter.ts`）。
 * - `429` → `RATE_LIMITED`：**不**换凭据（同账号的钱包是同一个，换 token 无意义）。
 *
 * ## ⚠️ `model-not-found` 刻意不归 `SERVER`
 *
 * 实测上游对未知 `model` 回 **502**（状态码本身像「可重试的服务端故障」），
 * 而体里写得很清楚 `model_not_found` / `no category route found`。按状态码归
 * 类会让 harness 白重试 5 次（本仓库 qoder 与 minimax 都因「用状态码代替业务
 * 语义」踩过同一类缺陷）⇒ **以响应体字面量为准，状态码只作辅助**。
 *
 * ## ⚠️ 错误码不得取 `AUTH` 之外的「会被替换文案」的码
 *
 * 本仓库的既有教训：`AUTH` 会被 DSH 客户端换成固定文案「API 密钥无效」并丢掉
 * 本条 message。本家**确实**要用户去重新登录，所以这条替换在 `auth` 格是
 * 可接受的；但 `model-not-found` / `quota` 必须保留原文（用户要靠它判断
 * 是「模型名写错」还是「额度用尽」）⇒ 那些格子用的是别的码。
 */
export function classifyAstudioError(
  status: number,
  body: string,
  options: { timeout?: boolean; transport?: boolean } = {},
): AstudioErrorInfo {
  if (options.transport === true) {
    return { kind: 'transport', llmCode: 'NETWORK', message: `astudio: 网络失败 — ${body.slice(0, 200)}` }
  }
  if (options.timeout === true) {
    return { kind: 'timeout', llmCode: 'TIMEOUT', message: 'astudio: 等待上游响应超时' }
  }
  const fields = astudioOpenAiErrorFields(body)
  const fromWire = fields === undefined ? undefined : ASTUDIO_WIRE_CODES.get(fields.code)
    ?? ASTUDIO_WIRE_CODES.get(fields.type)
  const detail = fields !== undefined && fields.message.length > 0
    ? fields.message
    : body.slice(0, 200)
  if (fromWire !== undefined) return describeAstudioError(fromWire, status, detail)
  if (status === 401 || status === 403) return describeAstudioError('auth', status, detail)
  if (status === 402) return describeAstudioError('quota', status, detail)
  if (status === 429) return describeAstudioError('rate-limit', status, detail)
  if (status === 400 || status === 404 || status === 405 || status === 422) {
    return describeAstudioError('bad-request', status, detail)
  }
  if (status >= 500) return describeAstudioError('server', status, detail)
  return describeAstudioError('unknown', status, detail)
}

/** 语义 → (DSH 错误码 + 文案)。集中一处，避免两处判据分叉。 */
function describeAstudioError(kind: AstudioErrorKind, status: number, detail: string): AstudioErrorInfo {
  const suffix = `（HTTP ${status}）${detail}`
  switch (kind) {
    case 'auth':
      // 文案必须**指路**：本家没有 refresh_token，唯一自救手段是重取；重取也失败
      // 就只能在客户端里重新微信扫码登录。
      return { kind, llmCode: 'AUTH', message: `astudio: 凭据未被上游接受，将重取一次；仍失败请在 AStudio 客户端重新登录${suffix}` }
    case 'model-not-found':
      // `PERMISSION_DENIED`：① 客户端不替换它（保住上面那句真实原因）；
      // ② `dead-model-store` 的 IGNORED_CODES 收它 ⇒ 不会把模型误记成「已下架 30 天」；
      // ③ 不在 DEFAULT_RETRYABLE_CODES ⇒ 不白退避。与 opencode 的 FreeTierError 同款裁决。
      return { kind, llmCode: 'PERMISSION_DENIED', message: `astudio: 上游没有该模型的推理路由。常见原因是把 acode 内核的内部别名（builtin/<base64>）当成 model 发了上来 —— 上游只认裸 slug${suffix}` }
    case 'quota':
      return { kind, llmCode: 'QUOTA_EXCEEDED', message: `astudio: 账号额度不足${suffix}` }
    case 'rate-limit':
      return { kind, llmCode: 'RATE_LIMITED', message: `astudio: 上游限流${suffix}` }
    case 'context-window':
      return { kind, llmCode: 'CONTEXT_WINDOW_EXCEEDED', message: `astudio: 上下文超出模型窗口${suffix}` }
    case 'bad-request':
      return { kind, llmCode: 'INVALID_REQUEST', message: `astudio: 请求被上游拒绝${suffix}` }
    case 'server':
      return { kind, llmCode: 'SERVER', message: `astudio: 上游故障${suffix}` }
    case 'timeout':
      return { kind, llmCode: 'TIMEOUT', message: 'astudio: 等待上游响应超时' }
    case 'transport':
      return { kind, llmCode: 'NETWORK', message: `astudio: 网络失败${suffix}` }
    case 'unknown':
    default:
      return { kind: 'unknown', llmCode: 'SERVER', message: `astudio: 请求失败${suffix}` }
  }
}

/**
 * 把上游/网络的异常**归一化成状态码**，供 {@link astudioAuthRetryPlan} 使用。
 *
 * 无 HTTP 状态（传输层失败 / 超时）时返回 `0`，绝不返回 401 ——
 * 那会让一次断网被误判成「凭据失效」并触发一次**必然也失败**的远端重取。
 */
export function astudioStatusOf(error: unknown): number {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    failure?: { status?: unknown }
    status?: unknown
  }
  const raw = typeof failure.failure?.status === 'number'
    ? failure.failure.status
    : typeof failure.status === 'number' ? failure.status : 0
  return Number.isFinite(raw) ? raw : 0
}

// ── 模型目录 ──

/**
 * 目录条目（**远端形状的精简视图** + 原始条目）。
 *
 * ⚠️ `raw` 必须保留**全量 39 字段**：实测 acode 内核的 `modelInfo` 对每条做
 * 逐字段强校验（`slug`/`display_name`/`base_instructions` 非空、`priority` 必须
 * safe integer、`shell_type` / `visibility` / `truncation_policy.mode` 只能在固定
 * 枚举里），**任一字段缺失即整份清单 `invalidCatalog`**。⇒ 「剔掉 18KB 的
 * `base_instructions`」只能是**对外展示时**的动作，绝不能顺手裁进 `raw`。
 */
export interface AstudioCatalogModel {
  /** **裸 slug**（= 上游 `model` 字段唯一认得的形态）。 */
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  efforts?: readonly string[]
  defaultEffort?: string
  /** 远端 `visibility`。⚠️ 本函数**不会**产出 `hide` 的别名条目（见下）。 */
  visibility: string
  /** 远端 `input_modalities`（实测六个模型全是 `['text']`）。 */
  inputModalities?: readonly string[]
  /** 原始条目（全量透传用）。 */
  raw: Record<string, unknown>
}

/**
 * 解开 acode 内核的内部别名 `builtin/<base64url(裸 slug)>`。
 *
 * ⚠️ **base64url 且无填充**：实测 `builtin/eG9wZ2xtNTI` → `xopglm52`，
 * 而 `builtin/c3BhcmsteDIuNQ`（`spark-x2.5`）长度不是 4 的倍数 ⇒ 用
 * 标准 `Buffer.from(x,'base64')` 也能解（Node 容忍缺填充），但 `-`/`_`
 * 必须先换成 `+`/`/`，否则 `spark-x2.6-preview` 这类含 `-` 的 slug 会解错。
 *
 * 解不出（不是 `builtin/` 前缀、或解出来不可打印）时**原样返回**：
 * 上游目录里本来就有裸 slug 形态，剥不出来就按它自己的 id 用。
 */
export function astudioBareSlugOf(slug: string): string {
  if (!slug.startsWith('builtin/')) return slug
  const encoded = slug.slice('builtin/'.length)
  try {
    const decoded = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    // 只接受「可打印且不含 '/'」的解码结果：否则判定为不是内部别名形态，原样返回。
    if (decoded.length > 0 && decoded !== encoded && !decoded.includes('\u0000') && !decoded.includes('/')) {
      return decoded
    }
  } catch {
    // 解不出就原样返回，绝不抛 —— 目录解析失败会让整个 provider 不可用。
  }
  return slug
}

/**
 * 解析模型目录响应。
 *
 * 三条实测驱动的规则：
 * 1. **信封先解**：`{code:0,message,data:{models:[…]}}`（推理网关 `/v1/models`
 *    是 404/405，必须走这个目录端点）。
 * 2. **按裸 slug 去重**：本地回环网关把每个模型下发**两份**（`builtin/…` 为
 *    `list`、裸 slug 为 `hide` 别名，能力字段逐字相同，实测 12 条 = 6 模型 × 2）。
 *    上游目前只给裸 slug 一份，但**去重必须现在就写**：否则上游/网关形状一变
 *    用户就会在选择器里看到成对重复模型，而这没有任何测试会失败。
 *    两份都在时**保留 `visibility:list` 的那份**（`hide` 是内部别名）。
 * 3. **不裁 `raw`**（见 {@link AstudioCatalogModel.raw} 的警告）。
 *
 * @returns 失败时抛 Error（调用方是 `fetchRemoteModels`，那里 catch 后回退兜底表）。
 */
export function parseAstudioCatalog(body: unknown): AstudioCatalogModel[] {
  const envelope = parseAstudioEnvelope(body)
  if (!envelope.ok) throw new Error(`astudio: 模型目录失败 — ${envelope.message}`)
  const models = envelope.data.models
  if (!Array.isArray(models)) throw new Error('astudio: 模型目录缺少 models 数组')

  const byId = new Map<string, AstudioCatalogModel>()
  for (const item of models) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const rawSlug = astudioReadString(record, 'slug')
    if (rawSlug.length === 0) continue
    const id = astudioBareSlugOf(rawSlug)
    const visibility = astudioReadString(record, 'visibility') || 'list'
    const effortList = Array.isArray(record.supported_reasoning_levels)
      ? (record.supported_reasoning_levels as unknown[])
        .map((level) => typeof level === 'object' && level !== null
          ? astudioReadString(level as Record<string, unknown>, 'effort')
          : '')
        .filter((effort) => effort.length > 0)
      : []
    const modalities = Array.isArray(record.input_modalities)
      ? (record.input_modalities as unknown[]).filter((m): m is string => typeof m === 'string')
      : undefined
    const entry: AstudioCatalogModel = {
      id,
      name: astudioReadString(record, 'display_name') || id,
      ...astudioReadString(record, 'description').length > 0 ? { description: astudioReadString(record, 'description') } : {},
      ...astudioReadNumber(record, 'context_window') !== undefined ? { contextWindow: astudioReadNumber(record, 'context_window') } : {},
      ...astudioReadNumber(record, 'max_output_tokens') !== undefined ? { maxTokens: astudioReadNumber(record, 'max_output_tokens') } : {},
      ...effortList.length > 0 ? { efforts: effortList } : {},
      ...astudioReadString(record, 'default_reasoning_level').length > 0 ? { defaultEffort: astudioReadString(record, 'default_reasoning_level') } : {},
      visibility,
      ...modalities !== undefined && modalities.length > 0 ? { inputModalities: modalities } : {},
      raw: record,
    }
    const existing = byId.get(id)
    // `list` 优先于 `hide`（内部别名不能盖掉真实条目）。
    if (existing === undefined || (existing.visibility === 'hide' && entry.visibility !== 'hide')) {
      byId.set(id, entry)
    }
  }
  return [...byId.values()]
}

/**
 * 把远端档位声明成 DSH 的 `reasoning`。
 *
 * ⚠️ **三格判据的顺序不可换**（与 `accioReasoningOf` 同形，但本家的远端**恒给**
 * `supported_reasoning_levels`，实测六个模型都非空）：
 * - 有数组 ⇒ 全列，`defaultEffort` **落在集合内才带**（DSH 会校验，指到集合外
 *   会让整条档位声明被静默丢弃）；
 * - 只有 default ⇒ **单档**；
 * - 两者都无 ⇒ **不声明**（编造档位 = 让用户选一个服务端不认的值）。
 *
 * ⚠️ 档位 id **原样当展示名**（`none` / `high` / `max`），不译成中文：
 * 这些是**要原样回发**的服务端字面量，译名会让用户对不上日志。
 * 本仓库 cline / accio 同样如此。
 */
export function astudioReasoningOf(
  model: Pick<AstudioCatalogModel, 'efforts' | 'defaultEffort'>,
): { efforts: readonly { id: string; name: string }[]; defaultEffort?: string } | undefined {
  const declared = model.efforts ?? []
  const fallback = model.defaultEffort
  if (declared.length > 0) {
    return {
      efforts: declared.map((effort) => ({ id: effort, name: effort })),
      ...fallback !== undefined && declared.includes(fallback) ? { defaultEffort: fallback } : {},
    }
  }
  if (fallback !== undefined && fallback.length > 0) {
    return { efforts: [{ id: fallback, name: fallback }], defaultEffort: fallback }
  }
  return undefined
}

/**
 * 从目录条目算出**档位声明**（含 `ReasoningEffortId` 品牌转换前的普通字符串形态）。
 *
 * 独立成一个函数只为单测能直接喂远端样本；适配器里用 {@link astudioReasoningOf}。
 */
export function astudioCatalogReasoningOf(model: AstudioCatalogModel):
  { efforts: readonly { id: string; name: string }[]; defaultEffort?: string } | undefined {
  return astudioReasoningOf(model)
}

// ── 流式帧：错误与「成功但没内容」的判别 ──

/**
 * 从一帧 OpenAI SSE 数据里读出**流内错误码**。
 *
 * ## 为什么需要它（本仓库反复踩过）
 *
 * 「HTTP 200 + 流内 code≠0」是**最难查的一类失败**：不看它就得到「模型返回空
 * 内容」这种误导性结论，而 harness **不会重试**（它看到的是成功）。
 * 本家的两种已知形态都在这里判：
 * - 裸信封形态 `{code:非0,…}`（上游某些代理层会这样把错误塞进流里）；
 * - OpenAI 错误形态 `{error:{code|type|message}}`。
 *
 * ⚠️ 判成功要「**有内容 且 无 error**」，两格缺一不可 —— 见
 * `astudioFrameLooksLikeError`。
 */
export function astudioStreamErrorCode(frame: unknown): number | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined
  const record = frame as Record<string, unknown>
  if (record.error !== undefined && record.error !== null) {
    // OpenAI 错误帧：`error.code` 可能是字符串（`model_not_found`）或数字。
    // 数字码原样返回；字符串码返回 -1（**有错**这个事实要紧，具体码在 message 里）。
    const error = record.error
    if (typeof error === 'object' && error !== null) {
      const code = (error as Record<string, unknown>).code
      if (typeof code === 'number' && Number.isFinite(code) && code !== 0) return code
      return -1
    }
    return -1 // `error: "字符串"` 同样是错误帧
  }
  const code = astudioReadNumber(record, 'code')
  if (code !== undefined && code !== 0) return code
  return undefined
}

/** 本帧是否是错误帧（含 `code:0` 的**正常**帧返回 `false`）。 */
export function astudioFrameLooksLikeError(frame: unknown): boolean {
  return astudioStreamErrorCode(frame) !== undefined
}

/**
 * 读出一帧里的错误文案（供错误消息带原文）。
 *
 * 三级回退：`error.message` → `error.type` → 信封的 `message`/`desc` → 整帧 JSON
 * 截断。绝不返回空串（空串的失败消息等于没有失败消息）。
 */
export function astudioStreamErrorMessage(frame: unknown): string {
  if (typeof frame !== 'object' || frame === null) return String(frame).slice(0, 200)
  const record = frame as Record<string, unknown>
  const error = record.error
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>
    const message = typeof e.message === 'string' ? e.message : ''
    const type = typeof e.type === 'string' ? e.type : ''
    const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : ''
    const joined = [code.length > 0 ? code : '', type.length > 0 && type !== code ? type : '', message]
      .filter((part) => part.length > 0)
      .join(' / ')
    if (joined.length > 0) return joined
  }
  const message = astudioReadString(record, 'message') || astudioReadString(record, 'desc')
  if (message.length > 0) return message
  try {
    return JSON.stringify(record).slice(0, 200)
  } catch {
    return 'unparsable error frame'
  }
}


// ── 流式：防御性「同一 id 累积全文 → 增量 diff」 ──

/**
 * 把「上一帧已交付的文本」与「本帧到达的文本」折算成**应当下发的增量**。
 *
 * ## 为什么需要它（ima / accio 两次真实踩坑的同型防护）
 *
 * AStudio 上游**实测**是标准 OpenAI 增量 SSE（fact 352/363：`delta.content` 逐片
 * 增长、末尾 `data: [DONE]`），共享消费器 {@link consumeOpenAiSse} 直接吃就好。
 * 但「累积全文」这个形状在同类网关里是**常见的第二形态**（ima 是逐帧全量、
 * accio 是「首帧无参、后续帧重复完整参数」），而上游哪天改形状**不会通知我们**：
 * 症状是正文**逐帧重复叠加**（"你好你" / "你好你好吗"），而不是报错 —— 最难查
 * 的一类缺陷。故这里做**形状无关**的防御：四种到达形态都能给出正确增量。
 *
 * | `previous` | `incoming` | 判定 | 返回 |
 * |---|---|---|---|
 * | `""` | `"你好"` | 首帧 | `"你好"` |
 * | `"你好"` | `"你好吗"` | **累积全文** | `"吗"`（剥前缀） |
 * | `"你好"` | `"你好"` | 全量**重复** | `""` |
 * | `"你好吗"` | `"你好"` | 乱序重发的**旧全量** | `""`（绝不回退删字） |
 * | `"你好"` | `"，世界"` | **真增量** | `"，世界"`（原样） |
 *
 * ⚠️ 第 4 行是**关键取舍**：`incoming` 比 `previous` 短且是其前缀时，宁可丢这一帧
 * 也不能下发负增量（下发「回退」会让已显示的文字被截掉，而丢一帧只是少几个字）。
 *
 * ⚠️ 第 5 行同样要紧：真增量与「前缀关系的全量」在单帧里**无从区分**，所以判据
 * 只能是「`incoming` 以 `previous` 开头 ⇒ 它是全量」。反过来（增量恰好以已有文本
 * 开头，如已收到 `"aa"` 又来 `"aab"`）会被误判成全量而**少发 2 个 a**。这在真实
 * 文本里概率极低（要求增量恰好逐字复述全部历史），而把判据放宽成「总是原样下发」
 * 则对**确凿的**累积形状（实测存在过的形态）恒错 ⇒ 取严格侧。
 */
export function astudioIncrementalDelta(previous: string, incoming: string): string {
  if (incoming.length === 0) return ''
  if (previous.length === 0) return incoming
  if (incoming === previous) return ''
  if (incoming.startsWith(previous)) return incoming.slice(previous.length)
  if (previous.startsWith(incoming)) return ''
  return incoming
}

/** {@link astudioIncrementalDelta} 的状态位：一个 `choices[i]` 的已交付文本。 */
export interface AstudioDeltaState {
  /** 已下发的全文（用于剥前缀）。 */
  sent: string
}

/**
 * 单帧改写：把 SSE 的 `data:` 负载里的**累积全文**就地改成**增量**。
 *
 * 返回 `{ payload, changed }`：
 * - `payload` 是要重新下发的负载（`null` = 整帧丢弃，如心跳与重复全量）；
 * - 非流式增量形状（真增量）时 `changed === false` ⇒ 调用方**原样透传**，
 *   不留任何改写痕迹（幂等：对已经是增量的流跑两遍，输出逐字节一致）。
 *
 * ⚠️ 只改 `choices[].delta.content` / `delta.reasoning_content` /
 * `delta.tool_calls[].function.arguments` 三处**文本位**，其余字段原样：
 * 整帧重写会把 `id`/`created`/`system_fingerprint` 等丢掉，而消费器依赖它们。
 * ⚠️ 解析失败（不是 JSON、不是对象、没有 choices）**一律原样透传**，绝不抛 ——
 * 本函数在流式管道里，抛错会把一次正常推理打死（同 qoder-envelope 的容错规则）。
 */
export function astudioRewriteSsePayload(
  payload: string,
  state: Map<string, AstudioDeltaState>,
): { payload: string | null; changed: boolean } {
  if (payload.length === 0) return { payload, changed: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return { payload, changed: false }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { payload, changed: false }
  }
  const record = parsed as Record<string, unknown>
  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) return { payload, changed: false }
  let changed = false
  for (let index = 0; index < choices.length; index++) {
    const choice = choices[index]
    if (typeof choice !== 'object' || choice === null) continue
    const delta = (choice as Record<string, unknown>).delta
    if (typeof delta !== 'object' || delta === null) continue
    const deltaRecord = delta as Record<string, unknown>
    const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : `anon:${index}`
    // 正文
    if (typeof deltaRecord.content === 'string') {
      const key = `${id}:c:${index}`
      const before = state.get(key)?.sent ?? ''
      const after = astudioIncrementalDelta(before, deltaRecord.content)
      if (after !== deltaRecord.content) {
        deltaRecord.content = after
        changed = true
      }
      // `before + after` 在三种形状下**都**等于「已交付全文」：真增量时是拼接、
      // 剥前缀时还原成本帧全量、乱序旧全量时 `after` 为空串（保持不后退）。
      state.set(key, { sent: before + after })
    }
    // 思考（实测走 `delta.reasoning_content`，fact 380）
    if (typeof deltaRecord.reasoning_content === 'string') {
      const key = `${id}:r:${index}`
      const before = state.get(key)?.sent ?? ''
      const after = astudioIncrementalDelta(before, deltaRecord.reasoning_content)
      if (after !== deltaRecord.reasoning_content) {
        deltaRecord.reasoning_content = after
        changed = true
      }
      state.set(key, { sent: before + after })
    }
    // 工具参数（按 index 分槽，与正文同理）
    if (Array.isArray(deltaRecord.tool_calls)) {
      for (const call of deltaRecord.tool_calls as unknown[]) {
        if (typeof call !== 'object' || call === null) continue
        const callRecord = call as Record<string, unknown>
        const fn = callRecord.function
        if (typeof fn !== 'object' || fn === null) continue
        const fnRecord = fn as Record<string, unknown>
        if (typeof fnRecord.arguments !== 'string') continue
        const slot = typeof callRecord.index === 'number' ? callRecord.index : 0
        const key = `${id}:t:${index}:${slot}`
        const before = state.get(key)?.sent ?? ''
        const after = astudioIncrementalDelta(before, fnRecord.arguments)
        if (after !== fnRecord.arguments) {
          fnRecord.arguments = after
          changed = true
        }
        state.set(key, { sent: before + after })
      }
    }
  }
  if (!changed) return { payload, changed: false }
  // 全量重复帧（增量为空串）⇒ **整帧丢弃**：下发 `content:""` 会让消费器产出一个
  // 空 delta（无害但无意义），而丢弃让流保持最小形状。finish_reason 帧不受影响
  // （它没有 content 字段 ⇒ 上面不会进改分支 ⇒ changed=false ⇒ 原样透传）。
  if (isAllEmptyDelta(record)) return { payload: null, changed: true }
  try {
    return { payload: JSON.stringify(record), changed: true }
  } catch {
    return { payload, changed: false }
  }
}

/** 本帧是否被改写成「所有文本位都是空串」的空 delta（该整帧丢弃）。 */
function isAllEmptyDelta(record: Record<string, unknown>): boolean {
  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) return false
  let sawDelta = false
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) return false
    const entry = choice as Record<string, unknown>
    if (typeof entry.finish_reason === 'string') return false
    const delta = entry.delta
    if (typeof delta !== 'object' || delta === null) return false
    const d = delta as Record<string, unknown>
    const keys = Object.keys(d).filter((key) => key !== 'role')
    if (keys.length === 0) continue
    for (const key of keys) {
      const value = d[key]
      if (typeof value === 'string') {
        if (value.length > 0) return false
        sawDelta = true
        continue
      }
      return false // 非文本位（tool_calls 等）⇒ 不丢弃
    }
  }
  return sawDelta
}

/**
 * 把上游响应包装成「累积全文已折算成增量」的响应。
 *
 * ⚠️ **只在确实是累积形状时才生效**（见 {@link astudioRewriteSsePayload} 的
 * `changed` 语义）：实测的标准增量流会逐帧原样透传，字节级等价于不包装。
 * ⚠️ 保留 `status`/`statusText` 与 `Content-Type`，只换 body —— 丢状态码会让
 * 上层的 401→重取判据失效（fact 374：唯一失效信号就是 HTTP 401）。
 */
export function astudioWrapIncremental(response: Response): Response {
  if (response.body === null || response.body === undefined) return response
  const state = new Map<string, AstudioDeltaState>()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        controller.enqueue(encoder.encode(rewriteLine(line, state) + '\n'))
        newline = buffer.indexOf('\n')
      }
    },
    flush(controller) {
      const rest = buffer.trim()
      if (rest.length > 0) controller.enqueue(encoder.encode(`${rewriteLine(rest, state)}\n`))
    },
  })
  const headers = new Headers(response.headers)
  if (!headers.has('content-type')) headers.set('Content-Type', 'text/event-stream')
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** 改写一行（非 `data:` 行原样返回）。 */
function rewriteLine(line: string, state: Map<string, AstudioDeltaState>): string {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!trimmed.startsWith('data:')) return line
  const payload = trimmed.slice('data:'.length).trim()
  if (payload.length === 0 || payload === '[DONE]') return line
  const rewritten = astudioRewriteSsePayload(payload, state)
  if (rewritten.payload === null) return ''
  if (!rewritten.changed) return line
  return `data: ${rewritten.payload}`
}

// ── 思考档位的本地校验（非法值上游**静默按最大档**跑，必须本地拦） ──

/** {@link astudioEffortForRequest} 的结果。 */
export interface AstudioEffortDecision {
  /** 应当**发给上游**的档位；`undefined` = 不发该字段。 */
  effort?: string
  /** 本档位是否被本地判为不可用而丢弃（供 warn 留痕，静默丢弃是本仓库明令禁止的）。 */
  dropped?: string
  /** 丢弃原因（`dropped` 存在时给出）。 */
  reason?: string
}

/**
 * 校验用户选的思考档位能不能发给上游。
 *
 * ## 为什么必须校验（fact 380 实测）
 *
 * 上游对**非法档位不报错**：`reasoning_effort:"bogus-value"` 回 HTTP 200 并以
 * `reasoning_tokens=389`（= 最大档）跑完。⇒ 若 provider 侧自造 `low`/`medium`
 * （DSH 的通用档位名），用户选「低」实际按「最大档」计费与延迟，**症状是"模型
 * 变慢了/变贵了"而不是报错**，事后无从归因。故：
 * - 档位 ∈ 远端 `supported_reasoning_levels` ⇒ 原样发；
 * - 远端**没有**该档位 ⇒ **不发** `reasoning_effort`（用上游自己的默认档），
 *   并回报 `dropped` 让适配器打日志。
 *
 * ⚠️ 刻意不「就近映射」成一个远端存在的档位（把 `low`→`none`）：那是替用户
 * 决定语义，而档位直接关联计费倍率与是否思考。
 * ⚠️ 也刻意**不抛错**：DSH 的 `UNSUPPORTED_REASONING_EFFORT` 会让整轮对话失败，
 * 而「不发这个字段」是可用的降级。
 */
export function astudioEffortForRequest(
  requested: string | undefined,
  declared: readonly string[] | undefined,
): AstudioEffortDecision {
  if (requested === undefined) return {}
  const effort = requested.trim()
  if (effort.length === 0) return {}
  const set = declared ?? []
  if (set.includes(effort)) return { effort }
  return {
    dropped: effort,
    reason: set.length === 0
      ? '上游目录未对该模型声明任何思考档位'
      : `该模型只声明 ${set.join('/')}`,
  }
}

// ── 请求体构造（纯函数，供单测逐字段断言） ──

/** {@link buildAstudioChatRequest} 的入参（对齐 DSH 的 `GenerateOptions` 子集）。 */
export interface AstudioChatRequestInput {
  /** **裸 slug**（上游唯一认得的形态，见模块头第 4 条与 {@link astudioBareSlugOf}）。 */
  model: string
  messages: readonly Record<string, unknown>[]
  system?: string
  tools?: readonly unknown[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  /** 已经过 {@link astudioEffortForRequest} 校验的档位；`undefined` = 不发。 */
  reasoningEffort?: string
  stream: boolean
  /** 账号 id → 请求体 `user`（实测客户端会带；上游不强求）。 */
  user?: string
}

/**
 * 构造 `POST {maasBaseUrl}/chat/completions` 的请求体。
 *
 * 三条实测驱动的取舍：
 * 1. **`model` 用裸 slug**：`builtin/<base64>` 形态会 502 `model_not_found`（fact 380），
 *    这里再兜一次 {@link astudioBareSlugOf} —— 目录将来若下发别名形态也不会翻车。
 * 2. **不发就省键**（`temperature` / `max_tokens` / `stop` / `reasoning_effort`）：
 *    写 `null` 会被火山网关当成显式空值（部分字段直接 400），省略才是「用服务端默认」。
 * 3. `stream` **恒带**，且流式时带 `stream_options.include_usage`（实测末 chunk
 *    只有这样才能拿到 usage；不带时流里没有 usage 帧，计费与统计双缺）。
 *
 * ⚠️ `system` 折成第一条 `role:'system'` 消息而不是顶层字段：OpenAI Chat
 * Completions 没有顶层 `system`，而本仓库的 `serializeMessages` 已经会把 harness
 * 消息里的 system 排好序，这里只补适配器**额外**拿到的 one-shot system。
 */
export function buildAstudioChatRequest(input: AstudioChatRequestInput): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = []
  if (typeof input.system === 'string' && input.system.length > 0) {
    messages.push({ role: 'system', content: input.system })
  }
  for (const message of input.messages) {
    if (typeof message !== 'object' || message === null) continue
    messages.push(message)
  }
  const body: Record<string, unknown> = {
    model: astudioBareSlugOf(input.model),
    messages,
    stream: input.stream,
  }
  if (input.stream === true) body.stream_options = { include_usage: true }
  if (typeof input.user === 'string' && input.user.length > 0) body.user = input.user
  if (input.tools !== undefined && input.tools.length > 0) body.tools = input.tools
  if (input.temperature !== undefined) body.temperature = input.temperature
  if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens
  if (input.stop !== undefined && input.stop.length > 0) body.stop = input.stop
  if (typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0) {
    body.reasoning_effort = input.reasoningEffort
  }
  return body
}

// ── 目录合并（远端 ?? 兜底） ──

/**
 * 把远端目录条目转成兜底表同形（少一个类型、少一处可能分叉的映射）。
 *
 * ⚠️ `supportsImage` 取**远端 `input_modalities` 是否含 image**：实测六个模型
 * 全是 `['text']`（fact 376/380），所以这里恒 `false` —— 但**判据是远端字段**，
 * 不是写死。上游哪天加个视觉模型，本行不改就自动生效。
 */
export function astudioCatalogToFallback(
  model: AstudioCatalogModel,
): AstudioFallbackModel {
  const modalities = model.inputModalities ?? []
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow ?? 0,
    ...model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {},
    ...model.efforts !== undefined && model.efforts.length > 0 ? { efforts: model.efforts } : {},
    ...model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {},
    supportsImage: modalities.includes('image'),
  }
}

/**
 * 目录的**可见性过滤**：只暴露裸 slug 形态的真实模型。
 *
 * 判据（fact 376/380 实测）：
 * - `visibility === 'hide'` 的条目是 acode 内核的**内部别名**，不能出现在选择器里；
 * - `base_instructions`（实测 18 278 B）**只影响展示**：对外必须剔掉，
 *   但它同时是内核 `modelInfo` 的必填字段 ⇒ 只能在**这份精简视图**里省，
 *   `AstudioCatalogModel.raw` 必须留全量（见其注释）。
 */
export function astudioVisibleModels(
  models: readonly AstudioCatalogModel[],
): AstudioCatalogModel[] {
  return models.filter((model) => model.visibility !== 'hide' && model.id.length > 0)
}
