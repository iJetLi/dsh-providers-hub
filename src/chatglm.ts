/**
 * 智谱清言（chatglm.cn **网页端**）凭据模型、端点常量与请求头签名。
 *
 * ## 与 `zcode` / `autoclaw` 的关系（**三个完全不同的产品面**，别混）
 *
 * | provider | 域名 | 鉴权 | 签到 |
 * |---|---|---|---|
 * | `zcode` | `zcode.z.ai` / `bigmodel.cn` | OAuth + `zcode_jwt` | 有（需阿里云 captcha） |
 * | `autoclaw` | `autoglm-acceleration-api.zhipuai.cn` | 桌面端 token | 有（刷新即登录事件） |
 * | **`chatglm`（本文件）** | **`chatglm.cn`** | **cookie / Bearer `chatglm_token`** | **有（`daily_login_score`）** |
 *
 * 三者同属智谱，但**端点、鉴权、签到协议完全不同**，凭据不互通。
 *
 * ## 鉴权（2026-11-04 逆向 + 消融矩阵实测）
 *
 * - **只有 `Authorization: Bearer <chatglm_token>` 是硬闸门**；
 *   其余 `X-Sign` / `X-Nonce` / `X-Timestamp` / `X-Device-Id` / `App-Name` /
 *   `X-App-*` / `X-Exp-Groups` / `Content-Type` **删掉都照过**
 *   （实测判据：40102 = 过闸仅 token 无效；40003 = 被前置拒绝。
 *   37 格消融里只有「全不带」+「仅 UA」两种形态回 40003）。
 * - token 存在 cookie `chatglm_token`（`expires: 30` 天），refresh token 存
 *   cookie `chatglm_refresh_token`（`expires: 180` 天）；续期走
 *   `POST /chatglm/user-api/user/refresh`（**Bearer 用 refresh token**）。
 *
 * ## ⚠️ 签名照抄但仍要发（软闸门的正确姿势）
 *
 * 上面的消融只证明「服务端**现在**不校验」。发错误的签名与不发**一样通过**，
 * 但这意味着上游随时可以收紧而**没有任何前置征兆**。故本模块仍然**按官方算法
 * 产出真签名**（`chatglmSign`）—— 成本是一次 md5，收益是收紧时不至于整条渠道
 * 突然全 40003。
 *
 * ## ⚠️⚠️ 账号隔离判据（用户明确要求核对的那一格）
 *
 * **智谱清言不是按 `device_id` / `web_id` 隔离账号**，实测三条：
 *
 * 1. 主包（6.0 MB）里 `web_id` 只出现 **1 次**，在 `sdata.chatglm.cn` 埋点 SDK 的
 *    `_s_byte_id`（字节的 `web_id`）—— **与鉴权/签到无关**；
 *    `X-Web-Id` / `tea_uuid` / `x_device` 命中数为 0。
 * 2. `X-Device-Id` 的来源是 `localStorage['chatglm-deid']`（32 位 hex，没有就
 *    `genV4()` 去横线后写回）—— 它是**请求指纹**，不是账号归属。
 * 3. 消融矩阵：`X-Device-Id` 取空 / 31 位 / 带横线 / 大写，**全部仍过闸**。
 *
 * ⇒ **隔离维度是 token**（`chatglm_token` 一值一账号）。这与 TRAE
 * （`src/trae.ts` 实测「同一天两账号共用 device_id 会被『该设备已签到』拦截」）
 * **机制不同**，不要照抄那边的「设备号互斥」叙事。
 *
 * ⚠️ 但仍**每账号确定性派生一套 32 位 hex 设备号**（{@link chatglmDeviceIdOf}），
 * 与 TRAE `deriveDeviceId15` / 豆包 `doubaoDerivedDeviceIdentity` 同纪律：
 * 上游一旦启用设备维度，结构性防御已经就位，且**当前零副作用**（闸门不校验它）。
 *
 * @module src/chatglm.ts
 */

import { createHash } from 'node:crypto'

/** 智谱清言主站基址（所有端点都挂在它下面，路径自带 `/chatglm` 前缀）。 */
export const CHATGLM_BASE_URL = 'https://chatglm.cn'

/** 端点路径集合（全部实测自 `main.28af679a.js` 的模块 85048 / 71690 / 86129）。 */
export const CHATGLM_PATHS = Object.freeze({
  /** 登录态续期（Bearer = refresh token）。 */
  refresh: '/chatglm/user-api/user/refresh',
  /** 用户信息（含 `member_info.left_score` = 可用积分）。 */
  userInfo: '/chatglm/user-api/user/info',
  /** ★ 每日登录积分领取（**签到本体**，幂等）。 */
  dailyLoginScore: '/chatglm/member-api/member/daily_login_score',
  /** 积分流水（`page` / `page_size` / `record_type`）。 */
  scoreRecord: '/chatglm/member-api/member/score_record',
  /** 消费抽券活动状态（只读）。 */
  scoreActivityStatus: '/chatglm/member-api/member/score_activity_status',
  /** 活动是否开放（**免 token**，可在登录前探活）。 */
  scoreActivityOpen: '/chatglm/member-api/member/score_activity_open',
  /** 暑期/返校季赠分：查是否已领。 */
  summerDayClaimStatus: '/chatglm/member-api/member/summer_day_claim_status',
  /** 暑期/返校季赠分：领取。 */
  summerDayGiveScore: '/chatglm/member-api/member/summer_day_give_score',
})

/** 官方签名盐（`86129` 模块的 `w()` 里逐字：`${stamp}-${nonce}-<SALT>`）。 */
export const CHATGLM_SIGN_SALT = '8a1317a7468aa3ad86e997d08f3f31cb'

/** 请求超时（单请求）。 */
export const CHATGLM_HTTP_TIMEOUT_MS = 15_000

/**
 * 智谱清言凭据。
 *
 * ⚠️ **字段名与 cookie 名对齐**（`chatglm_token` / `chatglm_refresh_token`），
 * 这样从浏览器 cookie 串直接映射时不用改名，减少一处漂移点。
 */
export interface ChatglmCredential {
  /** 访问 token（`Authorization: Bearer <它>`）。cookie 名 `chatglm_token`。 */
  chatglm_token?: string
  /** 续期 token（`refresh` 端点用它当 Bearer）。cookie 名 `chatglm_refresh_token`。 */
  chatglm_refresh_token?: string
  /** 访问 token 到期时刻（毫秒）。上游不给，登录/续期时按「+2 小时」落（官方同款）。 */
  expires_at?: number
  /** 用户 id（`user/info` 的 `result._id`；仅展示与判重）。 */
  user_id?: string
  /** 昵称（展示用，不参与鉴权）。 */
  nickname?: string
  /**
   * 设备号（`X-Device-Id`，32 位 hex）。
   *
   * ⚠️ 见模块头 §账号隔离：**它不是账号归属判据**（消融实测闸门不校验）。
   * 存在这里是为了「上游某天开始校验时不至于全渠道 40003」。
   */
  device_id?: string
}

/** 解析池里那份 JSON 凭据；坏 JSON / 非对象一律 `undefined`（不抛）。 */
export function parseChatglmCredential(raw: string | undefined | null): ChatglmCredential | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const o = parsed as Record<string, unknown>
  const out: ChatglmCredential = {}
  if (typeof o.chatglm_token === 'string' && o.chatglm_token.length > 0) out.chatglm_token = o.chatglm_token
  if (typeof o.chatglm_refresh_token === 'string' && o.chatglm_refresh_token.length > 0) out.chatglm_refresh_token = o.chatglm_refresh_token
  if (typeof o.expires_at === 'number' && Number.isFinite(o.expires_at)) out.expires_at = o.expires_at
  if (typeof o.user_id === 'string' && o.user_id.length > 0) out.user_id = o.user_id
  if (typeof o.nickname === 'string' && o.nickname.length > 0) out.nickname = o.nickname
  if (typeof o.device_id === 'string' && o.device_id.length > 0) out.device_id = o.device_id
  return out
}

// ── 设备身份（确定性派生，每账号一套 32 hex） ──

/**
 * SHA-256 确定性伪随机流（与 `src/trae.ts` 的 `seededStream` / `src/doubao.ts` 同算法）。
 */
function seededStream(seed: string, salt: string, nbytes: number): number[] {
  const prefix = `${salt}:${seed}`
  const result: number[] = []
  let counter = 0
  while (result.length < nbytes) {
    const counterBuf = new Uint8Array(4)
    counterBuf[0] = (counter >> 24) & 0xFF
    counterBuf[1] = (counter >> 16) & 0xFF
    counterBuf[2] = (counter >> 8) & 0xFF
    counterBuf[3] = counter & 0xFF
    const h = createHash('sha256')
    h.update(prefix, 'utf8')
    h.update(counterBuf)
    for (const b of h.digest()) {
      result.push(b)
      if (result.length >= nbytes) break
    }
    counter++
  }
  return result.slice(0, nbytes)
}

/** 合法设备号形态：32 位小写 hex（官方 `chatglm-deid` 的 `^[a-f0-9]{32}$`）。 */
function isChatglmDeviceShape(value: string | undefined): value is string {
  if (typeof value !== 'string') return false
  return /^[a-f0-9]{32}$/.test(value)
}

/**
 * 解出 access/refresh token 的 JWT payload（**只解析，不验签**）。
 *
 * ## ⚠️⚠️ 为什么必须解析它（2026-11-04 实测发现两处编造）
 *
 * token 是 JWT（`HS256`），payload 里带着**权威**的会话事实：
 *
 * ```jsonc
 * {
 *   "sub":  "7e028697fb254b45b788bb6491e28952",
 *   "exp":  1793857636,          // ← 真实寿命：exp − iat = 86400s = **24 小时**
 *   "iat":  1793771236,
 *   "uid":  "6aeac6e4c18a82be3199e01b",
 *   "device_id": "72b875712e784cbaa46493406846a706",  // ← **服务端下发**，32 hex
 *   "is_guest": true,            // ← **游客态**：站点对未登录访客也发 token！
 *   "mode": 1,
 *   "type": "access"
 * }
 * ```
 *
 * ⇒ 三条结论（都推翻了我先前的推断）：
 *
 * 1. **`expires_at` 必须读 `exp`**，不能按 cookie TTL 算 ——
 *    ⚠️ `chatglm_token` cookie 的 `expires: 30`（天）与 JWT 的**真实寿命 24 小时**
 *    **不是一回事**（cookie 活得比 token 久）。按 30 天算会让「有效期」
 *    比真实寿命长 29 天 ⇒ `refreshAll` 的 lead-time 永不触发 ⇒
 *    **过期前不自愈、过期后也不自愈**（正是 `autoclaw` 那次 P0 的同型形态，
 *    我在 `chatglm-login.ts` 里还特意声称「30 天是 cookie 真实 TTL、不是猜的」
 *    —— 那句话本身没错，但**用它当 token 寿命就是错的**）。
 * 2. **`device_id` 是服务端下发的**，优先用它；`chatglmDeviceIdOf` 的派生只是兜底。
 * 3. ⚠️⚠️ **`is_guest: true` 是游客态**：站点给**未登录访客**也发一套
 *    `chatglm_token` / `chatglm_refresh_token`。**绝不能把游客 token 当登录成功** ——
 *    那会让「打开窗口」立刻被判成「已登录」并把窗口关掉（真实缺陷：
 *    用户根本来不及看到登录窗口）。判据见 {@link chatglmTokenIsGuest}。
 *
 * ⚠️ 不验签的理由：签名验证需要服务端密钥（我们没有），且 token 来源是
 * **浏览器 cookie jar**（不是不可信输入）。这里只做**解码 + 读事实**。
 */
export interface ChatglmTokenPayload {
  sub?: string
  exp?: number
  nbf?: number
  iat?: number
  jti?: string
  uid?: string
  device_id?: string
  is_guest?: boolean
  mode?: number
  type?: string
}

/** 解一层 base64url（JWT 段）。失败回 `undefined`（不抛）。 */
function decodeJwtSegment(segment: string): unknown {
  try {
    // JWT 用 base64url（`-`/`_`），Node 的 base64 解码器只认 `+`/`/`。
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

/**
 * 解 token 的 payload；不是 JWT / 段数不对 / JSON 坏 ⇒ `undefined`（**不抛**）。
 *
 * ⚠️ 只读第 2 段，**不验签**（见 {@link ChatglmTokenPayload} 的说明）。
 */
export function decodeChatglmToken(token: string | undefined): ChatglmTokenPayload | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const payload = decodeJwtSegment(parts[1] as string)
  if (typeof payload !== 'object' || payload === null) return undefined
  const o = payload as Record<string, unknown>
  const out: ChatglmTokenPayload = {}
  if (typeof o.sub === 'string') out.sub = o.sub
  if (typeof o.exp === 'number') out.exp = o.exp
  if (typeof o.nbf === 'number') out.nbf = o.nbf
  if (typeof o.iat === 'number') out.iat = o.iat
  if (typeof o.jti === 'string') out.jti = o.jti
  if (typeof o.uid === 'string') out.uid = o.uid
  if (typeof o.device_id === 'string') out.device_id = o.device_id
  if (typeof o.is_guest === 'boolean') out.is_guest = o.is_guest
  if (typeof o.mode === 'number') out.mode = o.mode
  if (typeof o.type === 'string') out.type = o.type
  return out
}

/**
 * 该 token 是不是**游客态**。
 *
 * ⚠️⚠️ **这是登录是否成功的唯一判据**（2026-11-04 实测）：
 * 站点对**未登录访客**也下发一套完整的 `chatglm_token` / `chatglm_refresh_token`
 * （payload 里 `is_guest: true`）⇒ 「cookie jar 里有 token」**不等于**「用户已登录」。
 *
 * ⚠️ 解不出来（非 JWT）时**按非游客处理**：上游若改成不透明 token，
 * 我们就无从判断，此时不能反过来把真登录判成游客（那会让登录永远不成功）。
 * 这条 fail-open 是**刻意的**，且与「读不到就不写」的纪律不冲突 ——
 * 它只影响「是否继续等」，不影响任何落盘数据。
 */
export function chatglmTokenIsGuest(token: string | undefined): boolean {
  const payload = decodeChatglmToken(token)
  return payload?.is_guest === true
}

/**
 * 从 token 的 `exp` 取到期毫秒；读不到 ⇒ `undefined`（**绝不编造**）。
 *
 * ⚠️ 这不是可有可无的装饰：`expires_at` 是 `refreshAll` 的 lead-time 与
 * 积分按需自愈的**唯一**判据。编造一个偏大的值 ⇒ 永不自愈且日志零字
 * （`autoclaw` 的 P0 事故形态，见模块头 §1）。
 */
export function chatglmTokenExpiresAtMs(token: string | undefined): number | undefined {
  const payload = decodeChatglmToken(token)
  if (typeof payload?.exp !== 'number') return undefined
  const ms = payload.exp * 1000
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/**
 * 取本账号的设备号（`X-Device-Id`）。
 *
 * 优先级（**权威在前**）：
 * 1. 凭据里的存量值（若形态合法）；
 * 2. **token 的 `device_id` 字段**（服务端下发，实测 32 hex —— 这是真值）；
 * 3. 由 `accountKey` 确定性派生（**兜底**，见模块头 §账号隔离）。
 */
export function chatglmDeviceIdOf(credential: ChatglmCredential, accountKey?: string): string {
  if (isChatglmDeviceShape(credential.device_id)) return credential.device_id
  // ⚠️ JWT 里的 `device_id` 是服务端下发的真值，比派生值更权威
  //    （消融实测闸门不校验它，但假值会污染埋点与风控画像，真值更好）。
  const fromToken = decodeChatglmToken(credential.chatglm_token)?.device_id
  if (isChatglmDeviceShape(fromToken)) return fromToken
  const seed = accountKey?.length
    ? accountKey
    : (credential.user_id?.length
      ? credential.user_id
      : (credential.chatglm_token ?? 'chatglm-anon').slice(-32))
  const bytes = seededStream(seed, 'glmdev', 16)
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── 签名与请求头 ──

/**
 * 官方 `w()` 的时间戳归一化（逐字照抄，别"优化"）。
 *
 * 官方实现：
 * ```js
 * o = Date.now().toString();
 * t = o.split('').map(Number).reduce((a, b) => a + b, 0) - Number(o[o.length - 2]);
 * stamp = o.slice(0, -2) + (t % 10) + o.slice(-1);
 * ```
 * ⚠️ 结果是「倒数第 2 位被替换成 `(各位数字和 − 原倒数第 2 位) % 10`」——
 * **不是「时间戳本身」**。服务端当前不校验（见模块头消融），但仍按官方算。
 */
export function chatglmTimestamp(nowMs: number = Date.now()): string {
  const raw = String(Math.floor(nowMs))
  const digits = raw.split('').map((c) => Number(c))
  const sum = digits.reduce((a, b) => a + b, 0)
  const tweaked = (sum - digits[digits.length - 2]) % 10
  return raw.slice(0, -2) + String(tweaked) + raw.slice(-1)
}

/** 32 位 hex 随机串（官方 `nonce = genV4() 去横线`）。 */
function hex32(): string {
  const bytes = seededStream(`${Date.now()}-${Math.random()}`, 'glmnonce', 16)
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 官方签名：`md5("<stamp>-<nonce>-<salt>")`。 */
export function chatglmSign(timestamp: string, nonce: string): string {
  return createHash('md5').update(`${timestamp}-${nonce}-${CHATGLM_SIGN_SALT}`, 'utf8').digest('hex')
}

/**
 * 构造一次请求的头。
 *
 * `token` 缺省时**不带** `Authorization`（只有 `scoreActivityOpen` 这类免鉴权端点该这么发）。
 */
export function chatglmHeaders(
  token?: string,
  options: { deviceId?: string; appFr?: string } = {},
): Record<string, string> {
  const timestamp = chatglmTimestamp()
  const nonce = hex32()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json;charset=utf-8',
    'App-Name': 'chatglm',
    'X-Device-Id': options.deviceId ?? hex32(),
    'X-Request-Id': hex32(),
    'X-App-Platform': 'pc',
    'X-App-Version': '0.0.1',
    'X-App-fr': options.appFr ?? 'default',
    'X-Lang': 'zh',
    'X-Exp-Groups': '',
    'X-Device-Model': '',
    'X-Device-Brand': '',
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Sign': chatglmSign(timestamp, nonce),
  }
  if (typeof token === 'string' && token.length > 0) headers['Authorization'] = `Bearer ${token}`
  return headers
}

/**
 * 从「一次 CDP 读到的 cookie 表」归一出凭据 —— **登录是否成功的唯一判据**。
 *
 * ## ⚠️⚠️ 为什么必须抽成纯函数（2026-11-04 变异验证抓到的盲区）
 *
 * 这段判据原先直接写在 `ChatglmLoginSession.readCredentialOnce()` 里
 * （一个带 CDP 状态的私有方法）。后果是：**任何单测都测不到它** ——
 * 把「游客态拦截」换成「有 token 就算成功」（= 旧实现的原样），
 * 或者把 `expires_at` 换回「now + 30 天」，**整套用例全绿**。
 *
 * ⇒ 「守卫全绿」不足以证明它有牙（本仓库已记录过同型教训）。抽成纯函数后，
 *   两条真实缺陷都能被行为用例钉住，且**被测的就是生产路径用的那一份**。
 *
 * @param cookies 浏览器级 `Storage.getCookies` 的原始条目（可能含其它域）
 * @param domainFilter 只接受域名含该子串的 cookie（缺省 `chatglm.cn`）
 * @returns 非游客且 token 在 ⇒ 凭据；否则 `undefined`（调用方继续等待）
 */
export function chatglmCredentialFromCookies(
  cookies: ReadonlyArray<{ name?: unknown; value?: unknown; domain?: unknown }>,
  domainFilter = 'chatglm.cn',
): {
  credential?: ChatglmCredential
  /** 有 token 但它是**游客态** —— 调用方据此提示「继续等待用户登录」。 */
  guest: boolean
} {
  const byName = new Map<string, string>()
  for (const c of cookies) {
    if (typeof c.name !== 'string' || typeof c.value !== 'string') continue
    if (typeof c.domain === 'string' && !c.domain.includes(domainFilter)) continue
    if (c.name.length === 0 || c.value.length === 0) continue
    byName.set(c.name, c.value)
  }
  const token = byName.get('chatglm_token')
  if (typeof token !== 'string' || token.length === 0) return { guest: false }
  /**
   * ⚠️⚠️ **游客态不是登录成功**（实测真实缺陷）。
   *
   * 站点对**未登录访客**也下发一套完整的 `chatglm_token` / `chatglm_refresh_token`
   * （JWT payload `is_guest: true`）。旧实现只看「cookie 里有 token」⇒
   * **窗口一打开就被判成「登录成功」**，`finally` 立刻 `close()` 把窗口杀掉，
   * 用户根本看不到登录界面。
   */
  if (chatglmTokenIsGuest(token)) return { guest: true }
  const credential: ChatglmCredential = { chatglm_token: token }
  /**
   * ⚠️⚠️ **`expires_at` 读 JWT 的 `exp`，不按 cookie TTL 算**。
   *
   * JWT 实测 `exp − iat = 86400s` ⇒ **真实寿命 24 小时**，而 cookie 的
   * `expires: 30`（天）**比 token 活得久**（两者不是一回事）。
   * 按 30 天算 ⇒ `expires_at` 偏大 29 天 ⇒ `refreshAll` 的 lead-time
   * **永不触发** ⇒ 过期前不自愈、过期后也不自愈、日志零字
   * （`autoclaw` 的 P0 形态）。读不到 `exp` ⇒ **不写该字段**（宁缺勿造）。
   */
  const expiresAt = chatglmTokenExpiresAtMs(token)
  if (expiresAt !== undefined) credential.expires_at = expiresAt
  const refresh = byName.get('chatglm_refresh_token')
  if (typeof refresh === 'string' && refresh.length > 0) credential.chatglm_refresh_token = refresh
  // 设备号取 token 里的 `device_id`（服务端下发的真值，实测 32 hex）。
  const payload = decodeChatglmToken(token)
  if (isChatglmDeviceShape(payload?.device_id)) credential.device_id = payload?.device_id
  // ⚠️ 用户 id：cookie 优先，token 的 `uid` 兜底（实测两者同值）。
  const cookieUserId = byName.get('chatglm_user_id')
  if (typeof cookieUserId === 'string' && cookieUserId.length > 0) credential.user_id = cookieUserId
  else if (typeof payload?.uid === 'string' && payload.uid.length > 0) credential.user_id = payload.uid
  return { credential, guest: false }
}

// ── 上游信封 ──

/**
 * 统一信封：`{status, message, result, rid}`。
 *
 * ⚠️ **判据是 `status` 而不是 HTTP 状态码** —— 实测：token 无效时 HTTP 401 但
 * `status=40102`；`bad request` 时 HTTP 400 但 `status=40003`。
 * 故 `chatglmStatusOf` 只认信封，不认 HTTP 码。
 */
export interface ChatglmEnvelope<T = unknown> {
  status?: number
  message?: string
  result?: T
  rid?: string
}

/** 一次上游调用的规范化结果（**不抛错**：失败也带可读原因）。 */
export interface ChatglmWireResult<T = unknown> {
  /** 信封 `status`；网络层失败 / 非 JSON 时为 `undefined`。 */
  status?: number
  /** 是否拿到可解析的信封。 */
  ok: boolean
  result?: T
  /** 失败原因（`ok === false` 时必有）。 */
  error?: string
  /** HTTP 状态码（仅诊断用）。 */
  httpStatus?: number
}

/**
 * 发一次请求并解析信封。
 *
 * ⚠️ **绝不抛错**：三种失败（网络异常 / 非 JSON / 信封 status≠0）都折成
 * `{ok:false, error}`，由调用方给出用户动作，而不是让异常穿透到 RPC 层
 * （本仓库对「catch 把失败包成 ok:true」有明确事故史，这里反过来：失败要**带原因**）。
 */
export async function chatglmPost<T = unknown>(
  path: string,
  options: {
    method?: 'GET' | 'POST'
    body?: unknown
    token?: string
    deviceId?: string
    timeoutMs?: number
  } = {},
): Promise<ChatglmWireResult<T>> {
  const method = options.method ?? 'GET'
  const url = `${CHATGLM_BASE_URL}${path}`
  const timeoutMs = options.timeoutMs ?? CHATGLM_HTTP_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers: chatglmHeaders(options.token, { deviceId: options.deviceId }),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    const text = await response.text()
    const httpStatus = response.status
    let envelope: ChatglmEnvelope<T> | undefined
    try {
      envelope = JSON.parse(text) as ChatglmEnvelope<T>
    } catch {
      return { ok: false, httpStatus, error: `响应不是 JSON（HTTP ${httpStatus}）：${text.slice(0, 120)}` }
    }
    if (typeof envelope.status !== 'number') {
      return { ok: false, httpStatus, error: `响应缺 status 字段（HTTP ${httpStatus}）` }
    }
    if (envelope.status !== 0) {
      return {
        ok: false,
        httpStatus,
        status: envelope.status,
        result: envelope.result,
        error: envelope.message ?? `status=${envelope.status}`,
      }
    }
    return { ok: true, httpStatus, status: envelope.status, result: envelope.result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: controller.signal.aborted ? `请求超时（${timeoutMs}ms）` : `网络异常：${message}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 从 cookie 串里取某个 cookie 的值（`name=value; …` 形态）。 */
export function chatglmCookieValue(cookie: string | undefined, name: string): string | undefined {
  if (typeof cookie !== 'string' || cookie.length === 0) return undefined
  for (const pair of cookie.split(';')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    if (pair.slice(0, eq).trim() !== name) continue
    const value = pair.slice(eq + 1).trim()
    return value.length > 0 ? value : undefined
  }
  return undefined
}

/**
 * 从「浏览器导出的 cookie 串 / 裸 token」归一出凭据。
 *
 * 用户最可能的输入形态是**整条 cookie**（`chatglm_token=…; chatglm_refresh_token=…`），
 * 其次才是裸 token。两种都吃，避免「粘错了就静默登录失败」。
 */
export function chatglmCredentialFromInput(input: string): ChatglmCredential | undefined {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text.length === 0) return undefined
  if (text.includes('=')) {
    const token = chatglmCookieValue(text, 'chatglm_token')
    const refresh = chatglmCookieValue(text, 'chatglm_refresh_token')
    if (token === undefined && refresh === undefined) return undefined
    const credential: ChatglmCredential = {}
    if (token !== undefined) credential.chatglm_token = token
    if (refresh !== undefined) credential.chatglm_refresh_token = refresh
    return credential
  }
  // 裸值：长度够长的无空白串才当 token（避免把「随手打的字」当凭据）。
  if (!/^[A-Za-z0-9._-]{20,}$/.test(text)) return undefined
  return { chatglm_token: text }
}
