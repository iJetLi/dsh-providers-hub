import type { DpopPrivateJwk } from './oauth.js'
import type { BadgePreference } from './badge-preferences.js'
import type { TokenLedgerSnapshot, TokenLedgerHistoryDay, TokenLedgerModelRow } from './token-ledger.js'
/**
 * ⚠️ 反向的类型环，但是安全的：`jet-hub-store.ts` 以 `import type` 引入本模块的
 * `ProviderAccountEntry`，这里也以 `import type` 引入它的 `PanelEntry`。
 * 两处都是 type-only ⇒ 编译后**完全擦除**，不产生运行时边，也没有初始化顺序问题。
 * 定义留在 `jet-hub-store.ts`：那里同时持有该枚举的运行时取值表与 sanitize，
 * 拆开会让「三个真源分居两个文件」，正是本仓库反复记录的漂移形态。
 */
import type { PanelEntry } from './jet-hub-store.js'

/** snap-manager ticket 端点响应的传输格式。 */
export interface CodeArtsCredentialResponse {
  credential?: {
    access?: string
    secret?: string
    securitytoken?: string
    securityToken?: string
    expires_at?: string
    expiresAt?: string
  }
  result?: {
    accessKeyId?: string
    secretAccessKey?: string
    securityToken?: string
    expiration?: string
    expiresAt?: string
  }
  domain_id?: string
  user_id?: string
  user_name?: string
  error_code?: string
  error_msg?: string
}

/**
 * ========================================
 * ProviderAccountEntry 与多账号相关类型
 * ========================================
 */

/** 每个模型的重置时间信息 */
export interface RateLimitInfo {
  /** 模型 ID（如 'deepseek-v4-flash'） */
  modelId: string
  /** 重置时间戳（毫秒）；0 或缺失 = 不在重置期 */
  resetAtMs: number
}

/** 账号索引条目（存于 ctx.settings，非 credentials） */
export interface ProviderAccountEntry {
  /** 账号唯一标识：{provider}-{shortid}（如 'codearts-a1b2c3d4'） */
  id: string
  /** provider 名称：'codearts' | 'buddy' */
  provider: string
  /** 用户可读昵称 */
  nickname: string
  /** 是否启用（停用不参与自动切换） */
  enabled: boolean
  /** 对应的 credential ref 名称：{PROVIDER}_ACCOUNT_{UUID_SHORT}（如 'CODEARTS_ACCOUNT_A1B2C3D4'） */
  credentialRef: string
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /**
   * 凭据过期时间（毫秒时间戳），用于展示。
   *
   * ⚠️ **不保证是 `Date` 可表示的值**（最终审计登记的「同族未加固格」）：
   * 本字段来自**用户可编辑的备份文件**，而 `sanitizeAccounts` **不过滤它**
   * （与 `modelRateLimits` 不同 —— 那个已由 `isValidResetAtMs` 加固，见
   * `src/jet-hub-store.ts`）。故池里可能存在 `1e308` 这类超出 `Date` 范围的值。
   *
   * 当前**无崩溃可达**（已核实）：唯一对它调 `new Date()` 的是
   * `src/raccoon-auth.ts` 的 `refreshAll`，而那条分支被 `isRaccoonExpired(credential)`
   * 门控 —— 那个判据从**凭据**算过期、不读池值 ⇒ 池里坏值不可达；
   * 客户端 `jet-hub.js` 的判据是 `typeof === 'number' && > 0 && <= Date.now()`，
   * 对 `1e308` 恒 false，也安全。
   *
   * ⚠️ **但这是「补了 A 格、漏了同族 B 格」的形态**：将来若有人把某处判据改成读
   * 池值，或在 UI 里加 `new Date(account.expiresAt)` 的格式化，就会与
   * `modelRateLimits` 那个 `RangeError` 缺陷**完全同型**地炸。
   * ⇒ 新增读取点前先确认值域，或**在此处统一加固**（加过滤）。
   */
  expiresAt?: number
  /** 是否可静默续期 */
  refreshable: boolean
  /**
   * 每个模型的重置时间，key=模型ID（毫秒时间戳）。
   *
   * ⚠️ 值域由 `isValidResetAtMs`（`src/jet-hub-store.ts`）保证：**有限、正、
   * 且在 `Date` 范围内**（上界 8.64e15）。任何写入/读取点都必须走该谓词，
   * 不要内联 `Number.isFinite(v) && v > 0` —— 那会漏掉「超出 Date 范围」这一格，
   * 导致 `new Date(v).toISOString()` 抛 `RangeError`（真实缺陷，见该谓词注释）。
   */
  modelRateLimits?: Record<string, number>
  /**
   * 「账号被上游策略封禁」的**首次观测时刻**（毫秒）；缺省/0 = 未封禁。
   *
   * ## 为什么必须与 `modelRateLimits` 分开（Gitee issue IKS2MV）
   *
   * 两者的**恢复方式**完全不同，混在一张表里必然出事：
   *
   * | | `modelRateLimits` | 本字段 |
   * |---|---|---|
   * | 语义 | 限流（**单个模型**） | 封号（**整个账号**） |
   * | 上游形态 | HTTP 429 + `code 6004` + **明确的重置时刻** | HTTP 403（2026-10-16 起也可能是 400）+ `code 11140` + `账号存在异常行为`，**不给时刻** |
   * | 能否自愈 | 等时间到 | **只能重新登录 / 人工解封** |
   *
   * 旧实现把 11140 也写进 `modelRateLimits`（30 分钟冷却），于是：30 分钟后标记
   * 自动过期 ⇒ 面板恢复「已就绪」⇒ 用户以为账号好了 ⇒ 下一轮再撞 403 ⇒ 循环。
   * 用户报障原话：「11 个账号 8 个被封，面板上全部绿色『已就绪』」。
   *
   * ## 清除路径（**不自动过期**）
   *
   * 1. 该账号**实测成功**：`account.retest`（要求**所有**带标记的模型都通过 ——
   *    证据强度足够的那一条）；
   * 2. 用户点「重置」（`account.reset` / `account.resetAll`，清限流标记时一并清它）；
   * 3. 账号被删除。
   *
   * 选号侧也据此**排除整个账号**（封号是账号级）—— 与 `modelRateLimits` 的
   * 逐模型过滤不同，见 `AccountPool.candidateAccounts`。
   */
  policyBlockedAtMs?: number
  /**
   * 上游封禁报文的原文（`displayMsg`，如「账号存在异常行为，已被限制使用」）。
   *
   * 仅用于**展示**（面板上那行红字），不参与任何判据 —— 判据只看
   * {@link policyBlockedAtMs}。值域由 `sanitizeAccounts` 截断到 200 字符。
   */
  policyBlockedMessage?: string
  /**
   * TRAE 签到设备轮换代次（仅 `trae` provider 使用）。
   *
   * 业务码 `9074`（签到人数过多）的限流范围是 **device_id 而非账号**：
   * 命中后把代次 +1，即可由 `device_id` 派生出一个全新的签到设备号绕开它
   * （见 `src/trae.ts` 的 `deriveCheckinDeviceId`）。
   *
   * 这里只存**整数代次**而不是新设备号本身：派生结果由
   * `(credential.device_id, generation)` 唯一决定，故无需改写凭据本体
   * （登录凭据里的 `device_id` 是设备指纹，动它会牵涉风控）。
   *
   * 缺省/0 = 使用凭据原始 `device_id`，既有账号行为完全不变。
   */
  traeCheckinDeviceGeneration?: number
  /**
   * **opencode** 账号的出口代理（空/缺省 = 直连）。
   *
   * ⚠️ 代理是**账号维度**的：一个 NAT 后的多台 PC 共享同一出口 IP，而
   * OpenCode Zen 的匿名通道按**出口 IP** 限流、认证通道按**账号**限流，
   * 故「让各账号真正分开」只能给各账号各配一条出口。
   *
   * 空串是合法值（= 用户显式清除了代理，回到「与其它无代理账号共享本机
   * 出口」），**不可**用 falsy 判据把它与「未设置」混为一谈 ——
   * 那会让面板上的「清除代理」点了没反应。
   */
  opencodeProxy?: string
  /**
   * **opencode** 账号的指纹代次（见 `src/opencode.ts` 的 `deriveProjectId`）。
   *
   * 只存**整数代次**而非指纹本体：project id 由 `(api_key, generation)`
   * 唯一决定，用户点「轮换」时 +1 即可整体换一份新 project id，
   * 无需让调用方拼哈希（与 `traeCheckinDeviceGeneration` 同款取舍）。
   *
   * ⚠️ 接线层必须**以本字段为权威**重新派生 project id（`max(本字段,
   * 凭据内代次)`），不能直接透传凭据里的 `fingerprint` ——
   * 否则代次涨了而 project id 不变，且不报错，是最难排查的一类静默失效。
   *
   * 缺省/0 = 用凭据里派生的初始指纹。
   */
  opencodeFingerprintGeneration?: number
  /**
   * **Gemini** 账号的出口代理（空/缺省 = 直连，Gitee issue IKLTZ2）。
   *
   * ⚠️ Gemini 全部端点（`oauth2.googleapis.com/token`、userinfo、
   * `cloudcode-pa.googleapis.com`）都在墙外，而 undici **既不读 Windows WinINET
   * 系统代理、也不读 `HTTP(S)_PROXY`**（除非额外开 `NODE_USE_ENV_PROXY`）⇒
   * 「浏览器能授权、面板里账号一直不出现」正是本字段存在的理由。
   *
   * ⚠️ 与 `opencodeProxy` **刻意分成两个字段**而不是共用一个：两者的
   * **语义不同**（opencode 是「多账号要分份额度」，Gemini 是「单账号能不能连通」），
   * 共用会让「清掉 Gemini 的代理」连带清掉 opencode 的出口配置。
   *
   * 空串是合法值（= 用户显式清除，回到直连），**不可**用 falsy 判据把它与
   * 「未设置」混为一谈 —— 那会让面板上的「清除代理」点了没反应。
   */
  geminiProxy?: string
  /**
   * **Qoder**（国际版 `openapi.qoder.sh`）账号的出口代理（空/缺省 = 直连）。
   *
   * ## 为什么必须有（真实报障 2026-10-21）
   *
   * 国际版整站被阻断：DNS 正常、TCP 443 握手正常，但 **TLS ClientHello 被丢**
   * （SNI 阻断，典型 GFW 行为）。实测两个真实账号：
   *
   * - 余额端点 `GET /sash/api/v2/me/usage` ⇒ 10.7–11.3s 后 `UND_ERR_CONNECT_TIMEOUT`；
   * - 推理通道 `/api/v1/agent_chat_generation` ⇒ 同样 10.7s `TRANSPORT: fetch failed`。
   *
   * ⇒ 整个渠道**没有实际推理能力**，不只是「查不到余额」。中国版
   * （`openapi.qoder.com.cn`）完全正常（余额 160ms、推理 434ms）。
   *
   * ## ⚠️ 为什么此前只能靠导出 `HTTPS_PROXY`
   *
   * 本字段存在之前，Qoder 是**唯一**有「墙外端点」却没有 per-账号代理入口的渠道
   * （opencode 有、Gemini 有）—— 用户唯一出路是在启动 DSH 前导出环境变量，
   * 而那会**让所有渠道一起走代理**（包括本来直连更快的中国版）。
   *
   * ## 作用范围：余额查询 + 推理通道（**两条腿都要**）
   *
   * 只接推理不接余额 ⇒ 面板照旧 10.8s 才报错、锁定时照旧判「无法确认」；
   * 只接余额不接推理 ⇒ 面板显示正常但一发请求就超时。两者都必须过代理。
   *
   * ⚠️ 与 `opencodeProxy` / `geminiProxy` **刻意分成三个字段**：三者的语义不同
   * （opencode = 多账号分份额度，Gemini = 墙外授权，Qoder = 国际版整站阻断），
   * 共用会让「清掉 Qoder 的代理」连带清掉其它渠道的出口配置。
   *
   * 空串是合法值（= 用户显式清除，回到直连），**不可**用 falsy 判据把它与
   * 「未设置」混为一谈 —— 那会让面板上的「清除代理」点了没反应。
   *
   * ⚠️ **中国版账号配了也照用**：没人拦着用户给 `qodercn` 配代理（他的网络
   * 环境可能恰好相反）。判据不按 provider 分叉，只看该账号有没有配。
   */
  qoderProxy?: string
  /**
   * **minimaxintl**（MiniMax 国际站）账号的出口代理（空/缺省 = 直连）。
   *
   * ⚠️ `agent.minimax.io` 按**出口 IP 所在国家**分流：中国大陆来源会被 307 到
   * 中国站 `agent.minimaxi.com`，而中国站不认国际站 token ⇒ 报出与「凭据失效」
   * **逐字同形**的 401（issue IKMEVG）。本字段存在的理由就是换一个海外出口。
   *
   * ⚠️ 与既有的 `X-Forwarded-For` 设置（`pool.minimaxXff()`）**互补而非替代**：
   * XFF 只是**声明**一个海外 IP（上游若不信任该头即失效），本字段是**真正**
   * 改出口。两者可叠加。
   *
   * ⚠️ 与 `geminiProxy` / `opencodeProxy` **刻意分成三个字段**：三家语义不同
   * （分份额度 / 能不能连通 / 绕地理分流），共用会让「清掉一家」连带清掉别家。
   *
   * 空串是合法值（= 用户显式清除，回到直连），**不可**用 falsy 判据把它与
   * 「未设置」混为一谈 —— 那会让面板上的「清除代理」点了没反应。
   */
  minimaxIntlProxy?: string
}

/** 账号详细状态（返回给 Client 展示） */
export interface ProviderAccountStatus extends ProviderAccountEntry {
  /** 最近刷新错误 */
  refreshError?: string
  /** 来源（env/file 等） */
  source?: string
  /**
   * 账号名（用户名，如 `mylzscy4`）。
   *
   * ## 为什么不在 `ProviderAccountEntry` 上
   *
   * 账号池（`jet-hub/state.json`）的条目**不存**这个值 —— 它只在**凭据**里
   * （`user_info.displayName`）。本字段是 `account.list` 在返回前**现从该账号
   * 自己的 credential ref 里读出来**的派生值，故属于「状态」而非「存储」。
   *
   * 为什么不写回池：凭据可能被用户在别处更新（换账号名）、且池的
   * `sanitizeAccounts`（`src/jet-hub-store.ts`）只保留
   * `id`/`provider`/`credentialRef` 三个字段，写进去也会被丢掉。
   */
  accountName?: string
  /**
   * 脱敏手机号（`159****0100`）。
   *
   * ⚠ 由 17 位 `user_id` 前 11 位**派生**（上游不下发手机号字段），
   * 取不到合法前缀时**不设该字段** —— 宁可不显示，也不猜。详见
   * `src/zcode.ts` 的 `phoneFromUserId`。
   */
  phone?: string
  /**
   * ⚠️ **本 fork 独有**（modelscope，2026-10-17）：**打码后**的访问令牌
   * （`ms-…62f3`），供账号卡片展示与「编辑」入口。
   *
   * ⚠️⚠️ **绝不下发明文**：凭据经 RPC 明文下发等于把它摊到客户端 devtools、
   * 日志与崩溃上报里。取不到合法打码时**不设该字段**（宁可不显示）。
   * 打码由**宿主**的 `maskModelscopeKey()` 完成 —— 两端各写一份必然漂移，
   * 且客户端那份一旦漏判形状就会回显原文。
   */
  modelscopeKeyMask?: string
  /**
   * 七牛云 API Key 的**打码串**（宿主侧 `maskQiniuKey` 生成，形如 `sk-a…wxyz`）。
   *
   * ⚠️ 只下发打码串，**绝不下发明文**（凭据经 RPC 明文下发等于把它摊到客户端的
   * devtools / 日志 / 崩溃上报里）。与 `modelscopeKeyMask` 同款。
   */
  qiniuKeyMask?: string
  /**
   * MonkeyCode API Key 的**打码串**（宿主侧 `maskMonkeycodeKey` 生成，形如
   * `oma_…wxyz`）。
   *
   * ⚠️ 只下发打码串，**绝不下发明文**（同 `qiniuKeyMask` / `modelscopeKeyMask` /
   * `baizhiKeyMask`）—— 打码由宿主算好，客户端拿不到凭据，两端各写一份判据必然漂移。
   *
   * ⚠️ 这里**没有**、也不再有 `channel` 字段：2026-11-02 拆站后 `monkeycode`
   * 与 `monkeycodeintl` 是两个独立 provider，一个账号只可能属于其中一个，
   * 「这个账号走哪条通道」不再存在（拆站前那个 `monkeycodeChannel` 已删）。
   */
  monkeycodeKeyMask?: string
  /**
   * 该账号凭据里是否带了平台会话 cookie（决定额度行渲染「未配置会话」还是读数）。
   *
   * ⚠️ 额度/积分/签到需要 web 会话 cookie，没有它时卡片要给出「未配置会话」提示，
   * 而不是显示一个假的 0。
   *
   * ⚠️ 2026-11-02 三审 F🟡-9：本处原有一段讲 `monkeycodeChannel`（`baizhi` 白泽直连 /
   * `gateway` 网关）的注释 —— 那个字段在 2026-11-02 拆站时**已删**（现在
   * `monkeycode` 与 `monkeycodeintl` 是两个独立 provider），而注释没同步删。
   * → 已删除该段，字段本体（`monkeycodeHasSession`）保留。
   */
  monkeycodeHasSession?: boolean
  /**
   * 百智云账号的**打码** API Key（形如 `sk-a…wxyz`）。
   *
   * ⚠️ 只下发打码串，**绝不下发明文**（同 `qiniuKeyMask` / `monkeycodeKeyMask`）。
   * ⚠️ 打码由宿主 `maskBaizhiKey` 算好：客户端拿不到凭据，两端各写一份判据必然漂移。
   */
  baizhiKeyMask?: string
  /**
   * 是否存有百智云**控制台**网页登录态（`session_cookie`）。
   *
   * 卡片据此决定积分行的显示方式：没有会话时不该报「查询失败」红字，而应
   * 显示「用浏览器登录后可查看积分」（2026-11-02 用户报障：只填 Key 的账号
   * 积分行空白且没有任何引导）。
   */
  baizhiHasSession?: boolean
}

/** Jet Hub 在 ctx.settings 中的 schema */
export interface JetHubConfig {
  accounts: ProviderAccountEntry[]
  /**
   * 模型黑名单：provider id → 模型 id → true。
   *
   * **黑名单制**：只有键存在且为 true 的模型被隐藏，未记录的模型默认打开。
   */
  disabledModels?: Record<string, Record<string, boolean>>
}

/** RPC 端点请求/响应类型 */
export interface RpcListAccountsRequest {
  provider: string
}
export interface RpcListAccountsResponse {
  accounts: ProviderAccountStatus[]
}

export interface RpcCreateAccountRequest {
  provider: string
  /**
   * 登录方式（**仅 Magicrew / 超级麦吉需要**）。
   *
   * 超级麦吉有三条登录路径，其中「从本机浏览器读已登录态」这条**零门槛**
   * （用户只要在 Edge / Chrome 里登录过 `www.letsmagic.cn`，凭据就已经在
   * 本地 leveldb 里，不需要开窗口、也不需要手机号密码）：
   *
   * - 缺省：按 `phone` + 密码登录（见下两个字段）；
   * - `'local-browser'`：不开窗口，直接从本机浏览器 localStorage 取登录态；
   *   读不到 ⇒ 返回可读错误，**不建账号**。
   * - `'browser'`：**开一个独立 profile 的浏览器窗口**让用户在网页里登录，登完
   *   再把凭据读回来（分钟级；走 `login.poll` 三步式，不在 `account.create` 里等）。
   *   用户没登完 ⇒ `login.poll` 报终态并**删掉**占位条目。
   *
   * ⚠️ 来自客户端自报的 RPC 载荷（无 schema 校验）⇒ 读取侧按字面量白名单判，
   * 未登记的值一律当作缺省路径（**不报错、不静默改变语义**）。
   */
  mode?: 'local-browser' | 'browser' | 'magpie-import'
  /**
   * 手机号（**仅 Loomy 需要**）。
   *
   * 其余 7 个 provider 是「返回 loginUrl 让用户在浏览器里授权」，
   * 不需要手机号；Loomy 走**短信验证码**登录，故须由前端先收集。
   */
  phone?: string
  /**
   * 密码（**仅 Magicrew / 超级麦吉需要**）。
   *
   * ⚠️ 只用于**一次性登录请求体**，**绝不落盘**（凭据里只有 jwt / apiKey /
   * refreshToken；`MagicrewCredential` 没有 password 字段，这是刻意的）。
   * ⚠️ 它的存在让 `account.create` 多了一条「带密码」的分支 —— 其余 provider
   * 仍是「返回 loginUrl 让用户在浏览器里授权」。
   */
  password?: string
  /**
   * 登录渠道（**仅 ZCode 需要**）。
   *
   * ZCode 服务端支持两个 OAuth provider，凭据落点不同（见
   * `zcode-login.ts` 的 `ZCODE_LOGIN_PROVIDER` 注释）：
   *
   * - `'bigmodel'`（缺省）：智谱开放平台（国内），授权页 `bigmodel.cn`
   * - `'zai'`：z.ai 国际版，授权页 `chat.z.ai`
   *
   * ⚠️ **缺省必须视为 `'bigmodel'`**：既有调用方不传该字段，
   * 行为必须逐字节不变。
   */
  zcodeProvider?: 'bigmodel' | 'zai'
  /**
   * **minimaxintl** 账号的出口代理（**仅 MiniMax 国际站需要**）。
   *
   * ⚠️ 用途是**登录期**：换 token 那一次请求发生在凭据落盘**之前**，此时只有
   * 池里那条**占位条目**认得这个账号 ⇒ 代理只能从载荷带（或从同 provider 的
   * 既有账号继承，见 `jet-hub-rpc.ts` 的 minimax 分支）。不带 ⇒ 大陆网络下
   * 国际站**登录恒失败**，而用户**没法给一个还不存在的账号配代理** ⇒ 死锁。
   *
   * ⚠️ 与 `ProviderAccountEntry.minimaxIntlProxy` 是**同一个语义的两个入口**：
   * 那一个是「账号存在后」的面板设置，本字段是「账号还没建立时」的一次性输入。
   *
   * ⚠️ 来自客户端自报的 RPC 载荷（无 schema 校验）⇒ 读取侧必须过
   * `normalizeProxy` 归一，非法值一律拒绝（与 `accioRegion` 同一条纪律）。
   */
  minimaxIntlProxy?: string
  /**
   * 登录区域（**仅 Accio 需要**）。
   *
   * ⚠️ **gateway 与区域无关**（`phoenix-gw.alibaba.com` 两个区域同一个），
   * 区域只决定**登录页域名**（`'cn'` → `www.accio-ai.com`，
   * `'global'` → `zh.accio.com`）。它会被写进凭据并随续期保留。
   *
   * ⚠️ 来自**客户端自报**的 RPC 载荷（无 schema 校验）⇒ 必须过
   * `normalizeAccioRegion` 白名单，未登记值回落 `'cn'`（与 `zcodeProvider`
   * 同因，issue IKJLK3 E2）。
   */
  accioRegion?: 'cn' | 'global'
  /**
   * 出口代理（**仅 Gemini 需要**；Gitee issue IKLTZ2 审计 P2-1）。
   *
   * ## ⚠️ 为什么登录载荷要带它（真实缺陷：死锁）
   *
   * Gemini 的换 token 请求发生在**凭据落盘之前**，而出口代理是**账号维度**的
   * ⇒ 它只能从池里那条**占位条目**读。于是顺序是：
   *
   * 1. 客户端 `account.create`（此时账号还不存在）；
   * 2. 占位条目入库；
   * 3. 换 token（**此刻才读代理**）。
   *
   * 若占位条目不带代理，墙外环境下第 3 步恒直连 ⇒ **登录恒失败**；而用户
   * **没法给一个还不存在的账号配代理**（面板的「代理」按钮按 `accountId` 打开）
   * ⇒ **死锁**：唯一出路是导出 `HTTPS_PROXY` 环境变量。
   *
   * ⚠️ 实际触发路径很常见：refresh_token 失效时用户的既定动作是
   * 「删号重登」（面板就是这么建议的，见 `plugin-src/client/jet-hub.js`），
   * 而重登会造一个**全新 id** ⇒ 旧号上的代理配置必然丢失。
   *
   * ⚠️ **只对 Gemini 有意义**，其余 provider 忽略（它们的端点不在墙外）。
   * ⚠️ 缺省 = 空串 = 直连，与既有行为**逐字一致**。
   */
  geminiProxy?: string
  /**
   * 出口代理（**仅 Qoder 需要**；真实报障 2026-10-21）。
   *
   * ## ⚠️ 为什么登录载荷要带它（与 `geminiProxy` 逐字同因的死锁）
   *
   * Qoder 国际版 `openapi.qoder.sh` 被 SNI 阻断，**登录的设备码端点也在同一台
   * 主机上** ⇒ 墙外环境下没有出口就**连登录都起不来**。而出口是账号维度的，
   * 只能从池里那条**占位条目**读 ⇒ 占位条目不带代理时第 3 步（换 token）恒直连
   * ⇒ 登录恒失败；用户又**没法给一个还不存在的账号配代理**（面板的「代理」
   * 按钮按 `accountId` 打开）⇒ **死锁**。
   *
   * 与 Gemini 那份的唯一差别：Qoder 的登录流程在拿到 `accountId` 之前就会发
   * 设备码请求，所以 `qoder-proxy.ts` 额外有一条 `QODER_PENDING_PROXY_KEY`
   * 兜底（见那里的注释）。本字段负责的是「`accountId` 已存在」那一半。
   *
   * ⚠️ 缺省 = 空串 = 直连，与既有行为**逐字一致**。
   */
  qoderProxy?: string
  /**
   * 登录渠道（**仅腾讯 Marvis 需要**）。
   *
   * Marvis 只有两种 OAuth：`'1'` = QQ、`'2'` = 微信。缺省 `'1'`（与
   * `MarvisCredential.login_type` 的取值域逐字相同 —— 不是 `'QQ'` / `'WX'`）。
   *
   * ⚠️ 来自客户端自报的 RPC 载荷（无 schema 校验）⇒ 读取侧按字面量白名单判，
   *    未登记的值一律当作缺省（`'1'`），不报错。
   */
  marvisLoginType?: '1' | '2'
  /**
   * magpie 的 `plugin-auth.json` 片段（**仅 Marvis 的 `mode: 'magpie-import'` 需要**）。
   *
   * 用户从 `~/.config/magpie/plugin-auth.json` 里复制 `marvis` 那一项（可以是整份
   * 文件、也可以是那一项本身）粘进来 ⇒ 凭据已含 `access` / `refresh` /
   * `metadata.openid` / `metadata.guid`，**不需要任何上游请求**。
   *
   * ⚠️ 它与 `password` 同一条纪律：**只用于一次性导入**，解析后立刻转成
   *    `MarvisCredential` 落凭据库，绝不原样留存。
   */
  magpieCredential?: string
}
export interface RpcCreateAccountResponse {
  accountId: string
  /**
   * 登录页地址。
   *
   * ⚠️ `loginMode === 'sms'` 时为**空串** —— 短信登录没有可打开的 URL，
   * 前端必须据此渲染验证码表单而不是弹窗。
   */
  loginUrl: string
  /**
   * 登录交互形态。
   *
   * - `'url'`（或缺省）：前端 `window.open(loginUrl)` 并轮询 `login.poll`。
   * - `'sms'`：前端渲染手机号 + 验证码表单，走 `login.sendSms` / `login.submitSms`。
   *
   * ⚠️ **缺省必须视为 `'url'`**：既有 7 个 provider 不传该字段，
   * 行为必须逐字节不变。
   */
  loginMode?: 'url' | 'sms'
  /**
   * 本次「添加账号」**没有新建条目**，而是复用了池里已有的账号。
   *
   * ## 现状（2026-10-05 起 zcode 不再产生它）
   *
   * 曾经 ZCode 会「复用本机官方客户端写的凭据」而返回该值；那条能力已随
   * 「不读本机 IDE 数据」的决策整体删除 ⇒ **当前没有任何 provider 会返回
   * `true`**。
   *
   * ⚠️ 字段与前端的 `res.reused` 分支**仍然保留**：那是**契约防御** ——
   * 判据写成「后端若声明复用，则 `loginUrl` 为空串是正常的」，
   * 比反过来假设「空串必是错误」更稳，且不必为一次能力下线去改前端渲染分支。
   */
  reused?: boolean
  /**
   * MiniMax：**保证需要重新登录**的授权链接（2026-10-24）。
   *
   * ## 为什么 `loginUrl` 不够
   *
   * `loginUrl`（`/oauth-authorize?user_code=…`）**不含身份**，身份全在浏览器
   * cookie ⇒ 带已有会话打开就直接复用上一个账号（上游不认任何 `prompt=*`
   * 强制参数，实测五个参数全被忽略）。
   *
   * 本字段是上游「切换账号」按钮的等价物：`/unified-login?login_redirect=<授权页>`，
   * 由宿主用**无 cookie** 的服务端请求换来，登录完自动回到授权页放行**新**账号。
   *
   * ## 三条纪律
   *
   * 1. **可选**：拿不到时**不填**（客户端退回 `loginUrl`，行为与从前逐字节相同）；
   * 2. 客户端判据必须是 `typeof === 'string' && length > 0`（老宿主 `undefined`）；
   * 3. 它**不消耗凭据**（纯 GET，无 `Authorization`）⇒ 与
   *    「诊断脚本不得对真实凭据发起 refresh」那条铁律不冲突。
   */
  forcedLoginUrl?: string
  /**
   * MiniMax：打开 `forcedLoginUrl` **之前**应当先访问一次的上游**登出**地址
   * （2026-10-24，方案 A：「登出 → 授权页」两跳）。
   *
   * ## 为什么有了 `forcedLoginUrl` 还需要它
   *
   * `forcedLoginUrl` 只保证「这条链接**要求**登录」（我实测：全新浏览器打开它
   * 会显示登录表单 —— 微信扫码 / 手机号 / 账号密码，无「授权」按钮）。
   * 但它**不主动注销**浏览器里已存在的会话：
   *
   * - 若用户浏览器里已有 `account.minimax.cn` 的 `_sid`，统一登录页可能**直接
   *   放行**（实测未能覆盖这一半 —— 我没有用户账号，无法构造合法的旧会话）；
   * - 更糟的是**登录完成后的新会话会覆盖旧的**，用户下次又带着「上一个号」。
   *
   * 用户的实际症状正是这个：「要手动清理浏览器 token 不然还是会带上个账号登录态」。
   *
   * ## 上游登出端点（实测 2026-10-24，两站都有）
   *
   * ```
   * GET https://account.minimax.cn/oauth2/logout
   *   → 302 Location: /unified-login
   *   → Set-Cookie: _sid=; path=/; HttpOnly; secure; SameSite=Lax
   * GET https://account.minimax.io/oauth2/logout    （国际站同形）
   * ```
   *
   * ⚠️ 它**不接受任何回跳参数**（实测 `redirect` / `redirect_url` / `return_to` /
   * `returnTo` / `url` / `service` / `target` / `to` / `continue` / `next_url` /
   * `next` 共 11 个参数名，`Location` 恒为 `/unified-login`）⇒ 所以必须**两跳**：
   * 先访问本地址，再打开 `forcedLoginUrl`。
   *
   * ⚠️⚠️ **副作用必须让用户知道**：作用域是整个 `account.minimax.cn` 网页会话 ——
   * 用户在同一浏览器里登录的 MiniMax **网页版**会被一起登出（登录完成后新会话
   * 立即重建，影响很小但真实存在）。故客户端打开前**必须**给出提示，不得静默执行。
   *
   * ## 纪律
   *
   * 1. **可选**：拿不到时不填，客户端退化为只开 `forcedLoginUrl`（旧行为）；
   * 2. 客户端**先登出、再打开** `forcedLoginUrl`，中间留一个短延迟（见客户端注释）；
   * 3. 它是**普通页面**（导航即可），不要用 `fetch` —— 需要浏览器**真正写入**
   *    那个清 cookie 的 `Set-Cookie`，而 `fetch` 在无 `credentials` 时可能不落地；
   * 4. 仅对 `minimax` / `minimaxintl` 下发，且**只在「新建账号」**路径（其它 provider
   *    的授权页不在该 cookie 域，登出无意义且有害）。
   */
  logoutUrl?: string
}

export interface RpcPollLoginRequest {
  accountId: string
  provider: string
}

/**
 * RPC: 手动提交回调链接（codearts 华为云 / trae 字节跳动）。
 *
 * 用途：授权回调被定向到**宿主本机**的 `127.0.0.1:<port>`，用户在手机 /
 * 另一台电脑上完成登录时那一跳打不开，但地址栏里留下一条合法的回调链接。
 * 把它交回来即可在本机完成原来只有浏览器能完成的那一步。
 *
 * 两家机制不同（codearts 回传 code 需交换、trae 直传 token），但「人工搬运
 * 回调链接」是同一语义 ⇒ 共用本端点；由登记时的 provider 决定转调哪个提交入口。
 */
export interface RpcSubmitCallbackRequest {
  /** `account.create` 返回的占位账号 id（本进程内存里的那一轮登录）。 */
  accountId: string
  /**
   * 用户粘贴的整条回调链接。
   * - codearts：`http://127.0.0.1:<port>/oauth/callback?code=…`（或旧流程 `secret=`）；
   * - trae：`http://127.0.0.1:<port>/authorize?refreshToken=…&userInfo=…&userJwt=…`。
   */
  callbackUrl: string
}
/**
 * RPC: 轮询登录进度（`login.poll`）。
 *
 * ## 三态 —— ⚠️ 必须按 `done` **与** `success` 两个字段判
 *
 * | 形态 | 含义 |
 * |---|---|
 * | `{done:false}` | 进行中：用户还没完成授权（**正常**中间态） |
 * | `{done:true, success:true}` | 成功：凭据已落盘、账号池已回填 |
 * | `{done:true, success:false, error}` | **终态失败**：`error` 是可直接展示给用户的原因 |
 *
 * ⚠️⚠️ **客户端判据必须写成「先判 `success === false`，再判 `done`」**，
 * 不要写成「在 `done:true` 分支里判 `success`」——
 * Gitee issue IKLI7J 的根因就是前端只判 `done`：
 * 后端早已把失败原因放进 `error`，而 `if (!pollRes?.done) return;` 把它整体丢掉，
 * 于是**任何 provider 的登录失败都变成静默转圈 5 分钟**（5 分钟是客户端自己的
 * 轮询上限，不是服务端超时），用户无法区分网络问题 / 账号未开通服务 / 自己关掉了
 * 弹窗 / 插件 bug。判据对 `done` 的取值保持不敏感，也让这个契约将来能演进。
 */
export interface RpcPollLoginResponse {
  done: boolean
  success?: boolean
  error?: string
}

export interface RpcUpdateAccountRequest {
  accountId: string
  patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled'>>
}

export interface RpcDeleteAccountRequest {
  accountId: string
}

/**
 * RPC: 重排某 provider 的账号顺序（Jet Hub 拖拽排序）。
 *
 * 传该 provider **全部**账号 id 的目标顺序；服务端据此重写数组顺序，
 * 该顺序即自动选号/限流换号的候选优先级（见 `AccountPool.reorderAccounts`）。
 */
export interface RpcReorderAccountsRequest {
  provider: string
  /** 该 provider 全部账号 id，按目标顺序排列。 */
  orderedIds: string[]
}

export interface RpcRefreshAccountRequest {
  accountId: string
}
export interface RpcRefreshAccountResponse {
  /**
   * ⚠️ **只可能为 `true`**：续期失败**不回**本响应，而是回
   * `{ok:false, error:{code:'bad-request', message}}`（Gitee issue IKJOZA）。
   *
   * 此前失败被包成 `{ok:true, value:{success:false}}`，而客户端
   * `unwrapRpcResult` 只判 `ok` —— 只判 `ok` 的调用方会把失败读成成功
   * （报告方一个工具因此把 17/18 次失败显示成「✅」）。
   *
   * ⇒ 判定失败**只有一个**判据：顶层 `ok === false`（或 catch 住 `unwrapRpcResult`
   * 抛出的 `Error`，其 `message` 即 `error.message`）。
   */
  success: boolean
}

/**
 * ========================================
 * 限流标记重测 / 重置
 * ========================================
 */

/** 单个模型的探测结果。 */
export interface ProbeModelResult {
  modelId: string
  ok: boolean
  /** 失败时的可读原因（限流文案 / HTTP 状态等）。 */
  message?: string
  /**
   * 探测发现「仍受限」时，上游给出的**新重置时刻**（epoch ms）。
   *
   * [patch-codearts-probe-ratelimit] 为什么必须带出来：限流是**滚动窗口**，
   * 每次撞到都会把重置时间往后推。探针若只报「仍受限」而不回传该时刻，
   * 存储里会一直留着**第一次**的旧时刻；旧时刻一旦过期，UI 的
   * `modelRateLimits[v] > Date.now()` 就判为已过期而**不渲染「限额重置」**，
   * 于是出现「重测弹窗说仍受限、账号卡片却一条都不显示」的矛盾，
   * 且选号逻辑也会误以为该账号可用。实测偏差可达数小时
   * （如存储 09-23 16:33 vs 上游 09-24 08:31）。
   */
  resetTimeMs?: number
}

/** 单个账号的重测结果。 */
export interface ProbeAccountResult {
  accountId: string
  nickname?: string
  /** 探测的模型数；0 表示该账号没有限流标记，无需重测。 */
  tested: number
  /** 确认恢复正常、标记已清除的模型。 */
  cleared: string[]
  /** 仍受限的模型。 */
  stillLimited: ProbeModelResult[]
  /** 探测过程中的异常（凭据不可用、网络失败等）。 */
  error?: string
}

/** 重测单个账号（使用该账号自己的凭据发送探测消息）。 */
export interface RpcRetestAccountRequest {
  accountId: string
}
/** 重测该 provider 下的全部账号（**包含已停用账号**）。 */
export interface RpcRetestAllRequest {
  provider: string
}
/** 重测结果（单账号与全部共用同一响应结构）。 */
export interface RpcRetestResponse {
  accounts: ProbeAccountResult[]
  /** 汇总：清除的限流标记总数。 */
  clearedCount: number
}

/**
 * 「测试」单个账号：**无条件**真发一次请求（不依赖是否存在限流标记）。
 *
 * 与 {@link RpcRetestAccountRequest} 的区别是**触发条件**：重测只测那些已经有
 * `modelRateLimits` 标记的模型（无标记即零请求），测试则不看标记、直接挑一个
 * 模型发出去。它补齐的是「账号到底还能不能用」在没有历史 429 时**没有手动
 * 探活入口**的缺口。
 */
export interface RpcTestAccountRequest {
  accountId: string
  /** 指定要测的模型 id；省略则由服务端推断（见 `testAccount` 的 `testModelFor`）。 */
  modelId?: string
}

/**
 * 「测试」结果。
 *
 * ⚠️ 它**不带** `cleared` / `tested` 字段，这是刻意的：测试不写任何存储
 * （不清标记、不写回新的重置时刻），所以没有「清除了几条」可报。
 * 结果里的 `resetTimeMs` 仅供展示。
 */
export interface RpcTestAccountResponse {
  accountId: string
  nickname?: string
  /** 实际发出请求用的模型 id；推断失败时为空串。 */
  modelId: string
  /** 服务端接受并完成了这次请求。 */
  ok: boolean
  /** 失败时的可读原因（`仍受限：…` / `无法确认：…`）。 */
  message?: string
  /** 失败且上游给出重置时刻时带出（**不落盘**）。 */
  resetTimeMs?: number
}

/** 重置单个账号的限流标记（不测试，直接清除）。 */
export interface RpcResetAccountRequest {
  accountId: string
}
/** 重置该 provider 下全部账号的限流标记（**包含已停用账号**）。 */
export interface RpcResetAllRequest {
  provider: string
}
/** 重置结果。 */
export interface RpcResetResponse {
  /** 清除的限流标记总数。 */
  clearedCount: number
  /** 实际被清除了标记的账号数。 */
  accountCount: number
}

/**
 * ========================================
 * 每日签到（积分领取）
 * ========================================
 */

/** RPC: 查询签到状态请求 */
export interface RpcCreditsStatusRequest {
  provider: string
}
/** 单个账号的签到状态 */
export interface RpcCreditsAccountStatus {
  accountId: string
  nickname: string
  /** 状态查询失败（网络错误/凭据损坏）时为 null */
  status: import('./credits.js').CheckinStatus | null
}
/** RPC: 查询签到状态响应 */
export interface RpcCreditsStatusResponse {
  accounts: RpcCreditsAccountStatus[]
}

/** RPC: 一键领取积分请求 */
export interface RpcCreditsClaimAllRequest {
  provider: string
  /**
   * 是否同时执行成长中心任务（**CodeBuddy 中国版专有**）。
   *
   * ⚠️ **不是**「buddy / workbuddy 专有」：WorkBuddy（国际版）后端**根本没有**
   * 成长中心（contributor 在 !62 复审中实测确认：无任务列表、无 claim 端点），
   * `src/provider-credits.ts` 只给 `buddy` 挂 `afterClaim`。
   * 客户端那侧 `GROWTH_TASK_PROVIDERS` 同样只含 `buddy`（决定按钮渲不渲染）。
   *
   * ⚠️ **缺省为 `false`，且必须保持这样**：`credits.claimAll` 同时是「每日首次
   * 启动自动签到」的执行体（见 `src/auto-checkin.ts` 的 `claim` 回调），而成长
   * 一轮单账号实测 90～270s、全串行、任务间 1.5s 节流。若默认开启，每次启动都会
   * 自动打几十个上游请求 —— 那不是签到。
   *
   * 只有用户手点「一键领取积分」时才传 `true`。
   */
  runTasks?: boolean
  /**
   * 成长任务单账号时间预算（毫秒），透传给 `runGrowthTaskCompletions`。
   * 缺省由实现取 10 分钟；传 0 或负数表示不限时（本地排障用）。
   */
  budgetMs?: number
}
/** 单个账号的领取结果 */
export interface RpcCreditsClaimAccountResult {
  accountId: string
  nickname: string
  outcome: import('./credits.js').ClaimOutcome
}
/** 领取汇总 */
export interface RpcCreditsClaimSummary {
  claimed: number
  totalCredit: number
  alreadyClaimed: number
  inactive: number
  failed: number
  /**
   * 其中**能证明「今天这一轮已被处理」**的条数（`claimed` + `alreadyClaimed`
   * 里 `coversToday !== false` 的那些）。
   *
   * ⚠️ 它**不是** `claimed + alreadyClaimed`：那两项里可能混着「刷新前那一轮」的
   * 痕迹（Qoder 活动 10:00 UTC+8 才刷新），拿它们记账会导致当天新额度整天漏领。
   * 判据见 `src/credits.ts` 的 `ClaimOutcomeCommon.coversToday`。
   */
  coversToday: number
  /**
   * ★ **按单位分组**的领取合计（2026-10-04）。
   *
   * ## 为什么必须有它（真实缺陷，用户报障）
   *
   * 用户报障原文：
   * > 插件的这个一键签到，Zcode 获得的是 token 数量，但是这里显示成获得积分。
   * > 正文「…ZCode（智谱）+100000000（共 +100000100）」
   * > 应当显示为「…ZCode（智谱）+100Mtoken（共 +100Mtoken, +100积分）」
   *
   * 根因是 {@link totalCredit} 这个标量**把不同量纲加在了一起**：ZCode 的额度
   * 单位是 token、其余渠道是积分，1 亿 token + 100 积分 = `100000100`，
   * 而下游拿到的只有一个数、只能标成「积分」。故单位必须在**汇总这一层**
   * 就分开保留。
   *
   * ⚠️ 两个键**恒存在**（没有该单位的领取时为 `0`），不要写成可选 ——
   * 消费方（`auto-checkin.ts` / 两个客户端面板）都要读它，可选字段会让
   * 「宿主旧版本没这个字段」与「本次真的没有 token」混为一谈。
   *
   * ⚠️ {@link totalCredit} **保留**：它是既有字段，且对**单一单位**的渠道
   * （其余 11 个）语义完全正确。消费方若只需一个数，应先确认本次只有一个单位。
   */
  totalByUnit: import('./credits.js').ClaimTotalsByUnit
}
/** RPC: 一键领取积分响应 */
export interface RpcCreditsClaimAllResponse {
  results: RpcCreditsClaimAccountResult[]
  summary: RpcCreditsClaimSummary
  /**
   * 逐账号的成长任务明细，**仅在请求方传了 `runTasks: true` 且该 provider
   * 有成长中心时**给出。
   *
   * ⚠️ 它与 `results` 并列而非塞进 `outcome.message`：成长有 22 项任务、每项
   * 的处置不同（完成 / 需客户端 / 失败），折进一句文案就丢掉了逐项判据 ——
   * 而那正是排查「为什么这项没涨」的唯一线索。
   */
  growth?: RpcBuddyGrowthAccountResult[]
}

/** RPC: 成长中心任务一键全自动化请求 */
export interface RpcBuddyGrowthTasksRequest {
  provider: string
  /**
   * 单账号时间预算（毫秒）。缺省由实现取 10 分钟；传 0 或负数表示不限时。
   * 该值会**原样**透传给 `runGrowthTaskCompletions` 的 `budgetMs`。
   */
  budgetMs?: number
}
/** 单个成长任务的完成结果 */
export interface RpcBuddyGrowthTaskResult {
  taskCode: string
  ok: boolean
  message: string
  /** 判据在服务端推不动、如实归为「需客户端」而非「失败」。 */
  clientOnly?: boolean
}
/** 单个账号的成长任务执行结果 */
export interface RpcBuddyGrowthAccountResult {
  accountId: string
  nickname: string
  /**
   * 执行是否成功完成整轮。
   *
   * `ok:false` 表示有任务失败或时间预算用尽 —— 逐项明细看 `tasks`。
   */
  ok: boolean
  completed: number
  /** 需客户端动作的项数（微信动作、夜窗未到、判据推不动）。 */
  clientOnly: number
  failed: number
  /** 扫尾自动领到的任务数。 */
  claimedCount: number
  /** 扫尾自动领到的积分。 */
  claimedCredit: number
  /** 时间预算用尽、本轮提前收住。 */
  timedOut: boolean
  /** 逐项明细（含事件数 / progress / 失败原因）。 */
  tasks: RpcBuddyGrowthTaskResult[]
  /** 执行失败原因（凭据失效、任务列表查询失败等）。 */
  error?: string
}
/** RPC: 成长中心任务一键全自动化响应 */
export interface RpcBuddyGrowthTasksResponse {
  results: RpcBuddyGrowthAccountResult[]
}

/**
 * ========================================
 * 积分余额（Credits Balance）
 * ========================================
 */

/** RPC: 查询某 provider 下全部账号的积分余额请求 */
export interface RpcCreditsBalancesRequest {
  provider: string
  /**
   * 只查这些账号（**可选**；省略 = 全部账号，即积分面板的语义）。
   *
   * ## ⚠️ 存在的理由（用户 2026-10-15 的性能诉求）
   *
   * 用量徽标只需要**启用账号**的读数（停用账号既不进合计、也不渲染明细）⇒
   * 让它传启用账号的 id 列表，能**少查**几个号（每次渲染省 N 个顺序上游请求）。
   *
   * ⚠️ **它不影响自愈**：`credits.balances` 入口的 `healExpiredAccounts` 仍对
   * **全部**账号跑（AGENTS.md 的成文铁律：「续期不得按 `enabled` 过滤」——
   * 停用只影响自动选号，与凭据是否需要保持新鲜无关）。本字段只裁剪**余额查询**
   * 那一批。
   * ⚠️ 省略时**逐字节**保持既有行为（含停用账号 —— 积分面板的现状语义）。
   * ⚠️ 传空数组 = 一条都不查（而不是「查全部」）：那是最容易被写成反义的一格，
   * 故有一条用例专门锁它。
   */
  accountIds?: string[]
  /**
   * `true` = **绕过共享读数缓存**（含陈旧兼顶），强制回源（面板「刷新积分」按钮）。
   *
   * ## ⚠️ 为什么必须有它（2026-10-16 审计 P1-1，实测确认的回归）
   *
   * 引入共享缓存（`balance-cache`）后 `credits.balances` 会吃缓存，于是面板的
   * 「刷新积分」按钮**在 120 秒内点了等于没点** —— 而该按钮的 `title` 写着
   * 「余额由服务端实时计算，点此可刷新」，此时是**假的**。
   *
   * ⚠️ 更隐蔽的一档是**陈旧兼顶**：上游已挂 10 分钟时，点「刷新」仍返回
   * 15 分钟兼顶上限内的旧值 +「本次查询失败」。用户的诉求是「给我新数据」，
   * 实现给「再读一次旧数据」—— **比报错更糟**，因为它看起来成功了。
   *
   * ⚠️ **省略时行为不变**（吃缓存，与引入缓存前一致）。
   *
   * @see BalanceCache.readStale 的 `force` 语义（`force` 下**不兼顶**）
   */
  force?: boolean
}

/**
 * RPC: Loomy「锁定永久积分」开关的读写请求。
 *
 * ⚠️ 该开关是 **Loomy 全局**的（不分账号）：锁定后选号只允许消耗今日赠送额度，
 * 永久积分不参与 —— 只剩永久积分的账号在锁定期间等同于不可用。
 *
 * `locked` 省略表示**只读查询**；给出布尔值表示写入。
 */
export interface RpcLoomyPermanentLockRequest {
  locked?: boolean
}

/** RPC: Loomy「锁定永久积分」开关响应。 */
export interface RpcLoomyPermanentLockResponse {
  /** 当前是否已锁定。 */
  locked: boolean
}

/**
 * RPC: 通用「锁定永久积分」开关的读写请求（**provider 维度**）。
 *
 * ## 为什么不是 Loomy 那个单字段开关的扩展
 *
 * 「锁定永久积分」这件事**三个 provider 都有**，但「什么算永久积分」各不相同：
 *
 * | provider | 临时积分 | 永久积分 |
 * |---|---|---|
 * | Loomy | `dailyBalance`（**当日**到期，次日重新发放） | `balance`（注册奖励 + 新手任务） |
 * | CodeBuddy / WorkBuddy | 资源包中**扣费截止距今 < 15 天**者（实测 14/30/365 天） | 其余包（实测套餐的扣费截止在 8 年后） |
 *
 * ⚠️ 判据不同但**开关语义相同**（「只消耗会近期作废的积分」），故共用一个端点
 * 与一张持久化表，而不是每个 provider 加一条 case —— 平行分支越多，漏接概率越高
 * （`account.refresh` 端点对 workbuddy 漏接 case 就是这么一直坏着的）。
 *
 * `locked` 省略表示**只读查询**；给出布尔值表示写入。
 */
export interface RpcPermanentLockRequest {
  /** provider id（`loomy` / `buddy` / `workbuddy`）。 */
  provider: string
  locked?: boolean
}

/** RPC: 通用「锁定永久积分」开关响应。 */
export interface RpcPermanentLockResponse {
  /** 回显请求的 provider（前端并发切换时据此对号）。 */
  provider: string
  /** 当前是否已锁定。 */
  locked: boolean
  /**
   * 当前生效的「临时积分」窗口（天）—— **仅两个 buddy 返回**。
   *
   * ⚠️ 必须回传而不是让前端写死：窗口可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS`
   * 覆盖，前端写死 15 就会出现「提示说只烧 15 天内的，实际按 31 天筛号」。
   * Loomy 没有窗口概念（它看服务端的当日池），故不带该字段。
   */
  windowDays?: number
}

/**
 * 单个账号的积分余额。
 *
 * 与签到状态的设计取舍不同：余额**带回每个包的明细**而不只是总数 ——
 * 用户看到「347.87」时通常还想知道它由哪些包构成、各自何时到期（实测一个
 * 账号常同时有「Bonus Pack」与「Free Plan Subscription」两个周期不同的包）。
 * 明细只有几项，一次带回比让前端再发一次请求更划算。
 */
export interface RpcCreditsBalanceAccount {
  accountId: string
  nickname: string
  /** 余额查询失败（网络/凭据/响应异常）时为 null —— 与「余额为 0」严格区分。 */
  balance: import('./credits.js').CreditBalance | null
  /** 查询失败的原因，供 UI 提示（成功时为 undefined）。 */
  error?: string
  /**
   * 与余额**并列**的附加读数（不属于余额语义，故不塞进 `CreditBalance`）。
   *
   * 目前只有 Gemini 用：它的「账号规格」（Google AI Pro / Free）来自
   * `loadCodeAssist`，与配额是两个端点，但搭同一次 `credits.balances` 回来。
   * 缺省 = 该 provider 没有附加读数 / 这次没取到 ⇒ 面板不渲染对应行。
   */
  extra?: RpcCreditsBalanceExtra
}

/**
 * 逐账号附加读数。
 *
 * ⚠️ 用**对象**而不是把字段平铺到 {@link RpcCreditsBalanceAccount} 上：
 * 平铺会让 `usage-badge.ts` / 卡片里所有逐账号形状的断言都跟着膨胀，
 * 而这类读数注定还会增加（每加一个 provider 就多一批字段）。
 */
export interface RpcCreditsBalanceExtra {
  /**
   * 账号规格短标签（`Pro` / `Free` / `Ultra`）。
   *
   * `title` 放上游原文（`Google AI Pro（g1-pro-tier）`），hover 才看得到
   * —— 面板空间只够一个词。
   */
  accountTier?: { label: string; title: string }
}

/** RPC: 查询积分余额响应 */
export interface RpcCreditsBalancesResponse {
  accounts: RpcCreditsBalanceAccount[]
  /**
   * 当前生效的「临时积分」窗口（天）—— **CodeBuddy / WorkBuddy / TRAE /
   * LobsterAI 返回**。
   *
   * 面板据此把每个资源包分成临时 / 长期两桶显示（`credit-expiry.js`），
   * 且必须在**渲染时**用当前时刻现算 —— 分类是时间的函数，把结果存下来就会
   * 让越线的包继续被当成长期（宿主长期开着，时间只向前流）。
   *
   * ⚠️ 为什么由后端回传而不是前端写死：窗口可被
   * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，前端写死就会出现
   * 「提示说只烧 15 天内的、实际按 31 天筛号」。
   * Loomy / Raccoon **不带**该字段：它们的积分由服务端按语义分成多个池下发
   * （其中有「每日刷新」池），走的是**池名分桶**（`formatPoolSplitLine`），
   * 不是到期时间分桶。
   *
   * ⚠️ **Qoder（`qoder` / `qodercn`）2026-10-20 起已接入分桶展示** ——
   * 此前那句「虽有包到期字段但未接入分桶展示（仅 hover 明细）」是上一版实现的
   * **失实**表述（既低估了能力，也漏了 `windowDays` 这个渲染闸门；
   * 缺口本体与修复见 `jet-hub-rpc.ts` 里 qoder 分支的长注释）。
   *
   * ⚠️ 但**如实标注其实际分档形态**，勿读成「面板一定是三行数字」：
   * Qoder 的**逐包到期上游拿不到**（`addOnQuota` 只给聚合标量；逐包明细端点
   * 只对浏览器登录态开放；`dedicatedResourcePackages` 是唯一带真实 `expiresAt`
   * 的字段，本机账号实测为 `undefined`）⇒ `packages[]` 全员进
   * **永久（未知到期）**桶 ⇒ **临期桶只在真有 `dedicatedResourcePackages`
   * 的账号上才非 0**。这不是缺陷，是「上游不下发 ⇒ 不编造」的如实结果（本仓库红线）。
   */
  windowDays?: number
}

/**
 * ========================================
 * Cline 订阅额度与请求记录
 * ========================================
 *
 * 与 `credits.balances`（余额）**语义不同，两个端点不能互相替代**：
 *
 * | | 余额 | 订阅额度 | 请求记录 |
 * |---|---|---|---|
 * | 回答的问题 | 还剩多少钱 | 各时间窗用掉百分之几 | 每一笔请求花了多少 |
 * | 端点 | `/users/{id}/balance` | `/users/me/plan/usage-limits` | `/users/{id}/usages` |
 *
 * 参考实现：`github.com/codeOct/dsh-cline-pass` 的额度管理与请求记录部分
 * （见 `src/cline-quota.ts` 的模块头注释）。
 */

/** RPC: 查询某 provider 的**订阅额度窗口**（当前只有 Cline 支持）。 */
/** RPC: 查询某账号的 **CodeBuddy 限时补偿积分**状态（2026-10-16 新增）。
 *
 * ⚠️ 这是**一次性限时活动**，不是每日签到能力 ⇒ **不接 `credits.claimAll`**。
 * ⚠️ 端点走 buddy 的 **`webBase`** —— `src/product.ts` 里该值是
 * `https://www.workbuddy.cn`；`www.codebuddy.cn` 只是三个实测可达 host 之一，
 * **不是 `webBase` 本身**（PR !106 初版把两者混为一谈，2026-10-16 审计更正）。
 * 三个 host 均可达这件事见 `src/buddy-compensation.ts` 模块头。
 *
 * ⚠️⚠️ **客户端契约**：`rpcCall` 成功时返回的是**解包后的 `value`**（**没有
 * `ok` 字段**），失败时**抛错**（`plugin-src/management-rpc.mjs` 的
 * `unwrapRpcResult`）⇒ 消费方**判 `res.ok` 恒假**，必须走字段判据 + try/catch。
 * 见 `plugin-src/client/compensation-panel-logic.js` 模块头。
 */
export interface RpcBuddyCompensationStatusRequest {
  /** 目前只有 `'buddy'`（CodeBuddy 中国版）。 */
  provider: string
  /** 目标账号 id（补偿是**按账号**的，不是全局）。 */
  accountId: string
}

/** RPC: CodeBuddy 补偿状态响应。字段名**逐字对应上游**，不做重命名。 */
export interface RpcBuddyCompensationStatusResponse {
  /** 本账号是否已领取。 */
  claimed: boolean
  /** 活动是否仍在进行。 */
  active: boolean
  /** 可领取的积分数（上游 `credit_num`）。 */
  creditNum: number
  /** 上游 `validity_period`，含义未说明，**原样透传**。 */
  validityPeriod?: number
  /** 截止时间（上游原样字符串，如 `"2026-10-22 23:59:59"`）。 */
  endTime?: string
}

/** RPC: 领取某账号的 CodeBuddy 补偿积分（**写操作，只能成功一次**）。
 *
 * ⚠️ **只由面板按钮显式触发**，不得接进定时器 / 自动签到（见模块头）。
 */
export interface RpcBuddyClaimCompensationRequest {
  provider: string
  accountId: string
}

/** RPC: 领取响应。成功即空对象（领取后由调用方重新查询状态刷新展示）。 */
export interface RpcBuddyClaimCompensationResponse {}

/** RPC: 查询某 provider 的**订阅额度窗口**（当前只有 Cline 支持）。 */
export interface RpcClineQuotaRequest {
  provider: string
}

/**
 * 单个账号的订阅额度读数。
 *
 * ⚠️ **`ok:false` 与「窗口为 0 个」是两件不同的事**：前者是查询失败
 * （凭据失效、网关报错），后者是「账号确实没有任何额度窗口」。
 * 面板对两者的文案必须不同 —— 把失败显示成「无额度」会让用户
 * 以为额度没了（与本仓库「查不到不显示成 0」的一贯约定同源）。
 */
export interface RpcClineQuotaAccount {
  accountId: string
  nickname: string
  ok: boolean
  /** 窗口按网关原序透传（网关新增窗口类型时无需改插件）。 */
  windows: Array<{ type: string; percentUsed: number; resetsAt: string }>
  error?: string
}

/** RPC: 订阅额度响应。 */
export interface RpcClineQuotaResponse {
  accounts: RpcClineQuotaAccount[]
}

/**
 * RPC: 查询**请求记录**（本插件自己发出的推理请求流水，按时间倒序）。
 *
 * ⚠️ **不是**网关的 `/users/{id}/usages`（那是该账号在官方所有渠道的
 * 消费账单：没有延迟/首块时间，表格字段也对不齐参考实现）。见
 * `src/cline-request-log.ts`。
 *
 * `accountId` 必传：面板用**同一个**翻页索引同时切「额度窗口」与
 * 「请求记录」，两个区域必须看同一个账号。
 */
export interface RpcClineRequestLogRequest {
  provider: string
  accountId: string
  /** 最多返回多少条（省略用上限）。 */
  limit?: number
}

/** 请求记录的一行。 */
export interface RpcClineRequestLogRow {
  /** 请求**发起**时刻（毫秒时间戳）。 */
  ts: number
  /** 模型 id（wire 上的 `model`）。 */
  model: string
  /**
   * 真正服务这笔请求的**上游渠道**（网关下发的路由元数据，如 `alibaba`）。
   *
   * ⚠️ 与「模型命名空间」（`cline-pass` / `cline-free`）**不是一回事**：
   * 后者是订阅通道，甚至可能是厂商名（`deepseek/…`）。网关本次没报路由时
   * 这里回落到命名空间 —— 取值顺序见 `src/cline-routing.ts` 与 RPC 侧注释。
   */
  upstream: string
  /**
   * 是否收到过 usage 帧。
   *
   * ⚠️ 与「token 为 0」不是一回事：网关没发 usage 时（abort / 上游提前断开）
   * 必须显示 `—`，给 0 会被读成「瞬间完成、没花 token」（参考实现同约定）。
   */
  usageReported: boolean
  /** 输入 token（未命中缓存的部分）。 */
  inputTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 缓存命中的输入 token（表格的 ⚡ 那一项；缺失时省略）。 */
  cacheReadTokens?: number
  /** 思考 token（表格的 🧠 那一项；缺失时省略）。 */
  reasoningTokens?: number
  /**
   * 本次请求的**推理强度**（DSH 注入的 `options.reasoningEffort`）。
   *
   * ⚠️ 空串 = 本次没指定，展示层据此**整行不渲染**（参考实现同约定）；
   * 不要改成 `'auto'` —— 那会被读成「确实选了自动这一档」。
   */
  effort: string
  /** 首个内容块耗时（毫秒）—— 解释「为什么等了这么久才出字」。 */
  ttftMs: number
  /**
   * 首个**正文**块耗时（毫秒；0 = 本次没有任何正文/工具调用块）。
   *
   * ⚠️ 「输出速率」必须让分子分母落在**正文阶段**：分子 =
   * `outputTokens − reasoningTokens`（思考 token 计入 `completion_tokens`，
   * 且产生于 `ttftMs` 之前），分母 = `totalMs − ttfcMs`。缺这个字段，
   * 速率会把思考 token 除进正文窗口 → 虚高到物理不可能的值（用户报障）。
   */
  ttfcMs: number
  /** 全程耗时（毫秒）。 */
  totalMs: number
  /** 失败原因；成功行省略。 */
  error?: string
}

/** RPC: 请求记录响应（最新在前）。 */
export interface RpcClineRequestLogResponse {
  rows: RpcClineRequestLogRow[]
}

/**
 * ========================================
 * 短信验证码登录（仅 Loomy）
 * ========================================
 *
 * Loomy 是唯一**没有 loginUrl** 的 provider（短信登录），故不能复用
 * `login.poll` 那套轮询流程，需要两个专用端点。
 */

/** RPC: 为某个待登录账号下发短信验证码（Loomy **备用**登录路径）。 */
export interface RpcSendSmsRequest {
  accountId: string
  provider: string
  /**
   * 手机号。
   *
   * ⚠️ **由本请求自己携带**，不从 `account.create` 的中间态取 ——
   * 主路径是**微信扫码**，`account.create` 不再收集手机号
   * （那正是「新建账号失败：Loomy 短信登录需要手机号」那个**顺序死锁**
   * 缺陷的成因：表单要等 `account.create` 返回才渲染，却要求它先有手机号）。
   */
  phone: string
}
/** RPC: 下发短信验证码的响应。 */
export interface RpcSendSmsResponse {
  /** 服务端返回的 msgid（服务端已缓存在占位条目上，前端只需知道已发出）。 */
  msgid: string
}

/** RPC: 提交短信验证码完成登录。 */
export interface RpcSubmitSmsRequest {
  accountId: string
  provider: string
  code: string
}
/** RPC: 提交验证码的响应。 */
export interface RpcSubmitSmsResponse {
  /** 登录是否完成（凭据已写入）。 */
  done: boolean
  /** 失败原因（`done: false` 时给出）。 */
  error?: string
}

/**
 * ========================================
 * 新手任务（仅 Loomy）
 * ========================================
 *
 * ⚠️ 与 `credits.*`（每日签到）**语义独立**：新手任务是**一次性**的
 * （每号只能领一次 10000 分），故有独立端点，不参与「一键签到」遍历。
 */

/** RPC: 查询某账号的新手任务状态。 */
export interface RpcOnboardingStatusRequest {
  provider: string
  accountId: string
}
/** RPC: 新手任务状态响应。 */
export interface RpcOnboardingStatusResponse {
  /** 8 个 task key 的完成状态。 */
  tasks: Record<string, boolean>
  /** 本地现算的已领积分。 */
  earned: number
  /** 总分（10000）。 */
  total: number
  /** task key → 中文标题（供前端渲染清单）。 */
  titles: Record<string, string>
  /** task key → 积分。 */
  points: Record<string, number>
}

/** RPC: 领取某账号的全部新手任务。 */
export interface RpcOnboardingClaimRequest {
  provider: string
  accountId: string
}
/** RPC: 领取新手任务的响应。 */
export interface RpcOnboardingClaimResponse {
  /** 本次处理的任务（含幂等重放）。 */
  claimed: { key: string; title: string; points: number }[]
  /** 此前已完成、本次跳过的 key。 */
  skipped: string[]
  /** 领取后本地现算的累计已领。 */
  earned: number
  total: number
  /**
   * 本次**尝试了但失败**的任务（`"<key>: <原因>"`）。可选。
   *
   * ⚠️ 与 {@link skipped} 语义**不同**，不得混用：
   * - `skipped` = 「**此前已完成**」（前端渲染成「N 个此前已完成」）
   * - `errors`  = 「本次做了但没成功」⇒ 用户需要知道并可能重试
   *
   * ⚠️ 存在的理由（2026-11-01 协议审查）：magicrew 有 8 项新人任务，
   * 其中 1 项失败 + 7 项成功时，旧形状**没有任何字段能表达那一项失败**
   * ⇒ 失败被静默吞掉，用户以为全领到了。部分成功**不上抛**（上抛会让整轮
   * 报成"失败"，而实际已领到 7 项的分），故用本字段承载。
   */
  errors?: string[]
  /**
   * 需要用户**手动操作**才能完成的任务 key（服务端拒绝自动完成）。可选。
   *
   * ⚠️ 存在的理由（2026-11-01 协议审查）：magicrew 的 `first_ai_work` 固定回
   * `9303`「该新人引导任务不支持手动完成」—— 必须真发一条消息才置位。
   * 旧实现把它塞进 {@link skipped}，于是前端显示「1 个此前已完成」，
   * 而它**既没完成也没领到分** —— 典型的「把没做写成做过」。
   * ⇒ 单列一个字段，前端据此渲染「需手动完成」而不是「已完成」。
   */
  manualRequired?: string[]
}

/**
 * ========================================
 * 模型列表可见性（黑名单开关）
 * ========================================
 */

/** RPC: 列出某 provider 的模型请求 */
export interface RpcModelListRequest {
  provider: string
}

/**
 * 单个模型在设置页的展示条目。
 *
 * `disabled` 由服务端按黑名单回填，`name` 是适配器播报的展示名 ——
 * 两者都取自**权威来源**（适配器的 listModels），而不是前端自己再拼一份
 * 模型清单，否则远端模型池变化时设置页与对话框会显示两套不同的列表。
 */
export interface RpcModelListEntry {
  id: string
  name: string
  /** true = 已关闭（不出现在对话框的模型选择里）。 */
  disabled: boolean
  /**
   * 是否为**免费额度模型**（适配器按远端 `free` 集合判定的权威标记）。
   *
   * ⚠️ **缺失 = 该适配器没报**（不是「确认收费」）：Jet Hub 的模型列表按
   * 「计费/来源」分组时，缺失项**保守归入「按量计费」**，但字段本身保持
   * 「未知」语义 —— 不编造 `false`（与全仓「未知不编造」的约定一致）。
   */
  isFree?: boolean
  /**
   * 该模型是否已被判定为**上游下架**（`dead-models.json` 命中）。
   *
   * ⚠️ 恒为布尔值、**不省略**：缺失即 false。客户端据此灰显并给出「重新显示」
   * 入口（`model.clearDead`）。
   *
   * ⚠️ **必须显式列出失效模型而不能静默剔除**（2026-10-06 复审 !66 实测）：
   * 适配器侧会把它们从目录里过滤掉，若这里不补回，用户在设置页**连开关都摸不着**
   * —— 而失效模型用户**选不到 ⇒ 不可能再成功 ⇒ 记录永不自动清除**，等于永久失去
   * 恢复路径。这是「误判代价不对称」的必然要求：能藏，但必须能找回。
   */
  dead: boolean
}

/** RPC: 列出某 provider 的模型响应 */
export interface RpcModelListResponse {
  models: RpcModelListEntry[]
}

/** RPC: 打开/关闭某个模型请求 */
export interface RpcModelSetDisabledRequest {
  provider: string
  modelId: string
  disabled: boolean
}

/** RPC: 打开/关闭某个模型响应（回传写入后的完整黑名单，便于前端校验） */
export interface RpcModelSetDisabledResponse {
  provider: string
  disabledModels: Record<string, boolean>
  /**
   * 「本次操作没有它看上去那么有效」的说明（Issue IKJW33）。
   *
   * ⚠️ **缺省 = 无警告**，不是空数组 —— 与全仓「未知不编造」的约定一致，
   * 也让既有调用方（只读 `disabledModels`）逐字节不受影响。
   *
   * ## 为什么需要它
   *
   * 对**已从上游目录消失**的模型 id 调开关时，旧实现返回「成功 1」却
   * **什么都没发生、且没有任何警告**：脚本与 AI 助手据此以为开关生效了
   * （issue 作者本人就据此误判过一次，回查目录才发现是空操作）。
   *
   * ⚠️ **为什么是 warnings 而不是 `ok:false` + `not-found`**（issue 的原始建议
   * 未被采纳，两个理由）：
   *
   * 1. **打开方向是幽灵条目的唯一清理路径**：`model.setAllDisabled` 的注释已立
   *    此约定 —— 「曾被关闭、后来从服务端目录下线」的历史死键**只能靠打开方向
   *    清掉**。按目录拒绝会让这些键永远留在配置里，正好加重 issue 抱怨的第 2 条。
   * 2. **目录可能读不出来**（凭据过期 / 远端故障）：此时若按「不在目录」拒绝，
   *    用户会连开关都动不了。
   *
   * ⇒ **照常写入**（既有语义逐字节不变），只在响应里说明真相。
   */
  warnings?: string[]
}

/**
 * 聚合设置面板的一条候选（`aggregate.catalog` 的条目）。
 *
 * ⚠️ **不含余额**（规格 §8.3）：本端点只回答「有哪些候选、哪些被拒」，
 * 余额仍由各渠道自己的面板负责 —— 否则打开面板就会对每个渠道打一次上游请求。
 */
export interface RpcAggregateCandidate {
  provider: string
  /** 该渠道的**真实** modelId（面板要让用户看到它以便人工核查）。 */
  realId: string
  /** 该渠道的展示名（含倍率等运行时信息）。 */
  realName: string
  /** 倍率（`Infinity` = 无标注）。 */
  price: number
  /** 是否靠**显式补丁**归一（面板标 `⚠️补丁` 供人工核查）。 */
  viaPatch: boolean
  /**
   * 该候选当前**是否参与轮换**（= `state === 'allowed'`）。
   *
   * ⚠️ 语义已**收窄**（用户 2026-10-15）：升级前它等于「用户显式拒绝」，现在等于
   * 「当前不参与轮换」—— 含**新增的**「未接入临期折算 ⇒ 默认不参与」这一态。
   * 保留本字段是为了不动既有客户端渲染与既有用例；新代码一律读 `state`。
   */
  rejected: boolean
  /**
   * 三态门控结果（**权威**，由宿主 `resolveCandidateGate` 判定）：
   * `'allowed'` 参与 / `'rejected'` 用户显式拒绝 / `'default-rejected'` 未接入折算的默认不参与。
   *
   * ⚠️ 客户端**只渲染、不判定**（本仓库「同一语义两套判据」的红线）。
   */
  state: 'allowed' | 'rejected' | 'default-rejected'
  /**
   * 该渠道是否**已接入临期折算**（`WIRED_EXPIRY_PROVIDERS`）。
   *
   * ⚠️ 客户端读它是「读宿主下发的**事实**」，不是「自己重算接入状态」⇒ 不违反红线。
   * 它唯一的用途是决定「关掉一条候选时该写拒绝表还是白名单」（未接入渠道的「不参与」
   * 与「拒绝」同义 ⇒ 写白名单回到默认态，而不是往拒绝表里堆无作用的条目）。
   */
  expiryWired: boolean
}

/** 聚合设置面板的一个虚拟模型（`aggregate.catalog` 的条目）。 */
export interface RpcAggregateModel {
  canonicalId: string
  name: string
  candidates: RpcAggregateCandidate[]
  /**
   * 该模型的**手工顺序**（元素 = `` `${provider}\u0000${realId}` ``）。
   *
   * ⚠️ 宿主已**按当前候选集过滤**（id 漂移的脏键不会下发）⇒ 客户端渲染与拖拽
   * **不需要第二个读端点**。空数组 = 未自定义（展示与轮换都回落临期序）。
   */
  order: string[]
}

/** RPC: 列出聚合目录（虚拟模型 + 各自候选 + 三态门控）响应 */
export interface RpcAggregateCatalogResponse {
  models: RpcAggregateModel[]
  /**
   * 当前排序模式（`'expiry'` = 按临期，升级前行为；`'manual'` = 按手工顺序）。
   *
   * ⚠️ 权威在宿主：客户端进入面板时用它初始化，**不得**自己推导（例如「顺序表非空就是手工」——
   * 用户可以切到手工模式却一条都没拖过）。
   */
  orderMode: 'expiry' | 'manual'
}

/** RPC: 设置某条候选是否拒绝参与轮换请求 */
export interface RpcAggregateSetRejectedRequest {
  canonicalId: string
  provider: string
  realId: string
  rejected: boolean
}

/**
 * RPC: 设置某条候选是否**显式允许**参与轮换（用户 2026-10-15 的「手工打开」）。
 *
 * ⚠️ 与 {@link RpcAggregateSetRejectedRequest} 是**同一枚开关的两个方向**，但落在
 * **两张不同的表**上：本端点的目标域是「未接入临期折算」的候选（默认不参与），
 * 那个端点的目标域是「已接入」的候选（默认参与）。**两表不做互斥归一**
 *（用户 2026-10-15 的修正：键域天然不相交，写一侧不得改另一侧）。
 */
export interface RpcAggregateSetAllowedRequest {
  canonicalId: string
  provider: string
  realId: string
  allowed: boolean
}

/** RPC: 写入某虚拟模型的**手工顺序**（`order` 必须整体提交，碎片化追加不在设计内） */
export interface RpcAggregateSetOrderRequest {
  canonicalId: string
  order: string[]
}

/** RPC: 手工顺序写入后的响应（回传**服务端过滤后**的权威数组，客户端据此校正本地状态） */
export interface RpcAggregateSetOrderResponse {
  canonicalId: string
  order: string[]
}

/** RPC: 切换排序模式请求 */
export interface RpcAggregateSetOrderModeRequest {
  mode: 'expiry' | 'manual'
}

/** RPC: 排序模式切换后的响应 */
export interface RpcAggregateSetOrderModeResponse {
  orderMode: 'expiry' | 'manual'
}

/**
 * RPC: 一键「拒绝非临期」响应（把所有**未接入**折算渠道的手工打开恢复为默认不参与）。
 *
 * ⚠️ `cleared === 0` 也要回 `ok: true`（幂等点击不是错误），面板据计数决定文案：
 * 0 ⇒ 「没有需要恢复的候选」，>0 ⇒ 「已把 N 条候选恢复为…」。
 */
export interface RpcAggregateRejectNonExpiringResponse {
  cleared: number
  aggregateAllowed: Record<string, Record<string, Record<string, boolean>>>
}

/** RPC: 清空拒绝表请求（`canonicalId` / `provider` 都可省略；都省略 = 清空全部） */
export interface RpcAggregateClearRejectedRequest {
  canonicalId?: string
  provider?: string
}

/**
 * RPC: 聚合路由表变更后的统一响应（回传写入后的**两张表**，便于前端一次校正）。
 *
 * ⚠️ 必须同时回两张表：面板的逐条开关要按三态显示，只回拒绝表会让白名单条目
 * 在下一次点击前一直是陈旧值（与 `rejectionsFromCatalog()` 的既有回填机制同款）。
 */
export interface RpcAggregateRejectionsResponse {
  aggregateRejections: Record<string, Record<string, Record<string, boolean>>>
  aggregateAllowed: Record<string, Record<string, Record<string, boolean>>>
}

/**
 * RPC: 聚合 provider「上次实际转发成功的渠道」响应（P3，供用量徽标）。
 *
 * ⚠️ `provider` 为 `null` 表示**无历史**（尚未发过任何请求 / 插件重启后内存清空）
 * ⇒ 客户端**不渲染**徽标（规格 §6.3 的 P4）。**不做预测**。
 */
export interface RpcAggregateActiveProviderResponse {
  provider: string | null
}

/**
 * RPC: 「按临期排序」用的候选到期时刻（面板可选按钮，用户 2026-10-07 选定）。
 *
 * `order` 是 `{ <provider>: expiry }`（毫秒时间戳；`-1` = 查不到、`Infinity` = 长期）。
 * ⚠️ 该端点**会做余额探测**（每个已接入渠道一次上游 GET），
 * 故只在用户显式点「按临期排序」时调用 —— 面板默认不探测（规格 §8.3）。
 */
export interface RpcAggregateExpiryOrderResponse {
  order: Record<string, number>
}

/**
 * RPC: 把某个模型从「已失效」表里移除（让它重新出现在目录中）。
 *
 * ## 为什么必须有这个端点（2026-10-06 复审 !66 确认）
 *
 * 失效记录的**唯一**自愈路径是 TTL 过期（默认 30 天）—— 因为模型被剔除后
 * 用户**选不到**，不可能靠「再成功一次」触发重记清除。于是**误判即永久损伤**
 * （用户连手工编辑 `dead-models.json` 都不会）。
 *
 * ⚠️ 这与 Jet Hub 已有的模型开关**不对等**：用户能一键关模型，却不能一键
 * 「复活」一个被误记的模型。故必须有显式恢复入口。
 *
 * ⚠️ `modelId` **可选**：省略则清空该 provider 的全部失效记录（「全部重新显示」）。
 * 与 `disabled` 一样**没有默认值** —— 传 `""` 视为非法，避免「字段名写错 ⇒
 * 静默清空全表」。
 */
export interface RpcModelClearDeadRequest {
  provider: string
  modelId?: string
}

/** RPC: 恢复失效模型的响应（回传该 provider 剩余的失效 id，便于前端刷新） */
export interface RpcModelClearDeadResponse {
  provider: string
  deadModels: string[]
}

/**
 * RPC: 批量打开/关闭某 provider 的全部模型请求。
 *
 * 两个方向**刻意不对称**（见 `AccountPool.setModelsDisabled` /
 * `clearDisabledModels`）：
 * - `disabled: true` 关闭全部：按当前目录逐项加入黑名单，服务端需要读目录；
 * - `disabled: false` 打开全部：直接清空该 provider 的黑名单，不读目录 ——
 *   这样「曾被关闭、后来从服务端目录里下线」的历史遗留键才能被清掉。
 *
 * `disabled` **没有默认值**：缺失或非布尔一律拒绝。若默认成 `true`，一次字段名
 * 写错的前端改动会静默关闭用户全部模型；默认成 `false` 则反向静默打开 ——
 * 两个方向都是灾难性且难察觉的。
 */
export interface RpcModelSetAllDisabledRequest {
  provider: string
  disabled: boolean
  /**
   * 是否**同时**落「供应商整体关闭」意图（默认 `true`，保持既有语义）。
   *
   * ## ⚠️⚠️ 为什么需要这个开关（2026-10-21 合并审计发现，阻断级）
   *
   * 关闭方向原本**无条件**落意图（`writeModelsWithProviderClosed(…, true)`），
   * 而意图的三个后果是：
   * ① `provider.status` 报 `closed: true` ⇒ 左侧分组变成「已关闭」；
   * ② 各适配器的 `listModels` 直接返回 `[]` ⇒ 该家模型在选择器里**一个都没有**；
   * ③ **打开任意一个模型会顺带把整个供应商打开**（`setModelDisabled` 的打开
   * 方向会清意图）。
   *
   * ⇒ 用户在「模型列表」屏点一次「全关」（只想关这家模型），
   * 却把**整个供应商**也关了；再打开**任意一个**模型，供应商又被顺带打开。
   * 两头都与用户的意图相反，且**零提示**。
   *
   * ## 两个方向的取值
   *
   * - `true`（默认）：维持既有语义 —— 「关闭全部模型」**等价于**「关闭该供应商」
   *   （既有供应商级开关 `provider.setEnabled(false)` 走的是同一条路径）。
   * - `false`：**只**改模型黑名单，**不动**供应商的关闭意图。
   *
   * ⚠️⚠️ **`false` 的语义是「不动」，不是「清除」**（2026-11-04 修正）：
   * 早先的实现把 `false` 落成 `delete providerClosed[provider]`，于是「模型列表屏
   * 点一次全关」会**静默删掉**用户此前用「关闭供应商」设下的意图 —— 等目录变长
   * （插件更新 / 上游新增模型）派生判据失配，那家供应商就**自己变回「启用」**。
   * 真机现场：`state.json` 里 `providerClosed` 只剩 `{accio:true}`，818 条黑名单
   * 却对应 29 家 —— 靠「关闭供应商」关过的其它家全都不见了。
   *
   * ⇒ 现在传 `false` 时内部走三态的 `'keep'`（**连 `providerClosedCache` 的浅拷贝
   * 都不做**），已有关闭意图**原样保留** ⇒ 供应商仍「已关闭」、账号仍不可用。
   * 「清除意图」是**打开供应商**的职责，走 `clearModelsWithProviderClosed`
   *（`provider.setEnabled(true)`），**不**由本开关承担。
   *
   * ⚠️ **缺省即 `true`**：既有调用方（`provider.setEnabled(false)` 与既有的
   * 「模型列表」屏的「关闭全部」）的语义**逐字不变**。
   */
  closeProvider?: boolean
}

/** RPC: 批量打开/关闭响应（回传写入后的完整黑名单，与单条端点同结构） */
export type RpcModelSetAllDisabledResponse = RpcModelSetDisabledResponse

/**
 * RPC: 批量打开/关闭**指定的一批**模型（Jet Hub 模型列表里「按分组」的
 * 本组全开 / 本组全关）。
 *
 * 与 {@link RpcModelSetAllDisabledRequest} 的区别是**范围**：那个是「该 provider
 * 的全部模型」（且打开方向刻意顺带清掉已下线模型的历史死键），本端点只动传进来
 * 的 id —— **分组开关必须用本端点**，否则一次「本组全开」会把用户特意关着的
 * 其它组一起打开。
 *
 * ⚠️ `modelIds` **不接受空数组**：空组不该出现在界面上（前端按钮也按
 * `bulkButtonState` 禁用），服务端再拒一次，避免一次无意义的写入与广播。
 * ⚠️ `disabled` 同样**没有默认值**（与单条/全量端点同约定）。
 */
export interface RpcModelSetDisabledManyRequest {
  provider: string
  modelIds: string[]
  disabled: boolean
}

/** RPC: 分组批量开关响应（回传写入后的完整黑名单，与其它两个开关端点同结构） */
export type RpcModelSetDisabledManyResponse = RpcModelSetDisabledResponse

/**
 * 单个供应商的汇总状态（Jet Hub 左侧导航的分组与一键开关据此渲染）。
 *
 * 存在的意义：左侧要一次拿到**全部**供应商的状态才能分组，若逐个供应商调
 * `account.list` + `model.list`，8 个供应商就是 16 次往返，且每次都要走
 * 异步的凭据解析。这里一次返回，且服务端全程只用**同步的内存副本**。
 */
export interface ProviderStatus {
  /** 模型计数：total 为**不套黑名单**的全量目录条数，disabled 为其中已关闭的条数。 */
  models: { total: number; disabled: number }
  /** 账号计数：enabled 为其中处于启用状态的条数。 */
  accounts: { total: number; enabled: number }
  /**
   * 该供应商是否**已关闭**。
   *
   * 判据：`models.total > 0 && models.disabled === models.total` ——
   * **全部模型都已关闭**才算关闭。两条边界都不能省：
   * - `total > 0`：没有任何可用模型时**不算**「已关闭」（没有模型可关，
   *   就不该说它被关闭了），此时前端把开关置为不可用；
   * - `disabled === total`：只要还剩一个打开的模型，该供应商就仍是「已打开」。
   *
   * ⚠️ 与前端 `allModelsDisabled(models)`（`plugin-src/client/account-model-link.js`）
   * 的判据**语义同源、形态不同**：那个函数看的是模型**条目数组**，这里看的是计数。
   * 两者必须同步修改，否则「左侧说已关闭、账号联动说没全关」会自相矛盾。
   */
  closed: boolean
  /**
   * 目录核实**失败**的原因（**可选** —— 只有「派生判据说已关闭、但核实腿
   * 没能证明它」时才出现）。
   *
   * ⚠️⚠️ 这个字段是为了让 `closed: false` 不再与 `models.disabled === models.total`
   * **自相矛盾**（2026-11-05 三审端到端 P1-2）。现场：
   * ```
   * provider.status = {"models":{"total":2,"disabled":2},"closed":false}
   * ```
   * 界面显示「已关闭 2」，开关却是「已打开」；用户点开关 ⇒ `provider.setEnabled(false)`
   * 返回「没有可关闭的模型：<远端原因>」⇒ **三者矛盾且用户拿不到原因**。
   *
   * 两条腿的语义：
   * - `closed: false` 是**保守**的（目录不完整时不敢报「已关闭」，否则会出现
   *   IKJW33 那种「界面说关了、模型却仍可选」）；
   * - `verifyFailed` 说明**为什么没能证明** —— 冷帧（`notReady`）与远端读失败
   *   （`remoteError`）两种形态用户动作不同（前者等重试、后者查网络）。
   *
   * ⚠️ 字段缺席 = 核实成功或未需要核实。
   */
  verifyFailed?: string
  /**
   * 目录健康快照（**可选** —— 只有目录来自**多个外部来源**的适配器实现它）。
   *
   * 存在的意义（issue IKKZUG 第 5 点）：`cline` 的目录来自**三个来源**，
   * 其中 models.dev 是 5.39 MB 的外部站点、经常拉不到；失败时只有
   * `console.warn`，而**宿主不落盘** ⇒ 用户与排障者看到的只是「贴不了图」，
   * 无从判断是「模型不支持图片」还是「目录还没拉到」。
   *
   * ⚠️ `complete: false` 是**可操作**的信号：它意味着目录处于残缺态，
   * 本插件会继续按闸门冷却重试（不需要用户做任何事）。
   *
   * ⚠️ **字段缺席 = 该适配器不提供诊断**，不是「诊断失败」—— 前端与
   * 排障脚本都必须按 `undefined` 判「无信息」，不得当成「一切正常」
   * （那是把「没测」当成「没问题」，正是本仓库反复出现的静默形态）。
   */
  catalog?: CatalogHealth
}

/**
 * 目录来源的就绪度（`ProviderStatus.catalog`）。
 *
 * ⚠️ `total` 是**已载入**的条数（不是远端真实条数）—— 远端条数在失败时
 * 无从得知，编造一个数比不报更糟。
 */
export interface CatalogHealth {
  /** 当前已载入的模型条数（目录 = 远端已读到的 ∪ 本地兜底表）。 */
  total: number
  /**
   * 目录是否**完整**（所有来源都已就绪）。
   *
   * ⚠️ `false` 时插件**仍会按闸门冷却自动重试**，用户无需操作；
   * 它只是告诉排障者「现在看到的列表/能力可能不全，且会自愈」。
   */
  complete: boolean
  /** 人类可读的现场说明（如 `models.dev 未就绪`）；省略时前端不必渲染。 */
  note?: string
}

/** RPC: 读取多个供应商的汇总状态请求 */
export interface RpcProviderStatusRequest {
  /** 要查询的 provider id 列表（Jet Hub 一次性传全部 8 个）。 */
  providers: string[]
}

/** RPC: 读取多个供应商的汇总状态响应 */
export interface RpcProviderStatusResponse {
  /** provider id → 状态。请求里未识别的 id 不出现在结果中。 */
  statuses: Record<string, ProviderStatus>
}

/**
 * RPC: 供应商级一键开关请求。
 *
 * 语义（用户已确认）：
 * - `enabled: false`（关闭）= **先关掉它的全部模型，再停用它的全部账号**；
 * - `enabled: true`（打开）= 清空它的模型黑名单，并启用它的全部账号。
 *
 * `enabled` **没有默认值**：缺失或非布尔一律拒绝。与
 * {@link RpcModelSetAllDisabledRequest} 同理 —— 默认成 `true` 会静默打开
 * 用户特意关闭的供应商，默认成 `false` 则反向静默关闭，两个方向都难察觉。
 */
export interface RpcProviderSetEnabledRequest {
  provider: string
  enabled: boolean
}

/** RPC: 供应商级一键开关响应（回传实际变更数，供前端给出准确提示）。 */
export interface RpcProviderSetEnabledResponse {
  provider: string
  enabled: boolean
  /**
   * **实际被改变的**模型数（关闭方向 = 本次真正新关掉的条数；打开方向 = 清空的条目数）。
   *
   * ⚠️ 关闭方向**不是**「本次写入黑名单的条数」：`setModelsDisabled` 是**合并**
   * 语义，传入的并集里可能有相当一部分早就关着（历史遗留的完整黑名单 / 用户此前
   * 逐条关过），按写入条数报会**少报**用户看到的实际结果。与 {@link accounts}
   * 的口径（只算实际变更数）保持一致。
   */
  models: number
  /** 实际被改变的账号数（已是目标状态的账号不计入）。 */
  accounts: number
}

/**
 * RPC: 读取供应商自定义显示顺序（Jet Hub「供应商开关」弹窗的拖拽排序）。
 *
 * `order` 为空数组表示用户尚未自定义（或文档缺失该键），展示侧按 `PROVIDERS`
 * 的声明顺序渲染（见 `plugin-src/client/provider-toggle.js` 的
 * `sortOpenProvidersByOrder`）。
 */
export interface RpcGetProviderOrderResponse {
  order: string[]
}

/**
 * RPC: 写入供应商自定义显示顺序。
 *
 * 数组含**全部**供应商 id：拖拽提交时 = 拖后的「已打开」序列 + 已关闭的
 * 按声明序缀尾。展示侧对数组中不认识 / 缺失的 id 都有稳定兜底，故插件
 * 跨版本增删 provider 时不需要迁移（见 `sortOpenProvidersByOrder`）。
 */
export interface RpcSetProviderOrderRequest {
  order: string[]
}

/**
 * RPC: 本机 OpenAI 网关状态。
 *
 * ⚠️ 三个字段必须**分开回传**，不能只回一个 `enabled`：设置页里的开关读的是
 * `enabled`（用户的选择），而端口是否真的在监听取决于另外两个条件 ——
 * `blockedByEnv` 为真时，用户的选择**不会**让网关跑起来（`env` 是运维级
 * 停用，优先级更高）。只回一个布尔会让 UI 显示「已打开」而实际没监听，
 * 用户完全无从判断该改哪里。
 */
export interface RpcGatewayStatusResponse {
  /** 用户在设置页里的选择（持久化状态）。 */
  enabled: boolean
  /** 当前是否真的在监听端口。 */
  running: boolean
  /** 是否被 `DSH_OPENAI_GATEWAY_ENABLED` 显式停用（此时设置页改开关无效）。 */
  blockedByEnv: boolean
  /**
   * 「允许局域网访问」开关（持久化状态，2026-10-20）。
   *
   * `true` = 用户选择绑 `0.0.0.0`；`false` = 只绑回环/env 地址。⚠️ 与
   * {@link hostFromEnv} 同看：env 显式给了 host 时本开关不生效，UI 必须明说。
   */
  allowLan: boolean
  /**
   * env 是否显式给了 `DSH_OPENAI_GATEWAY_HOST`（运维口径，优先于上面的开关）。
   * 为 `true` 时设置页应禁用局域网开关并说明原因——「打开了却没生效」比
   * 「禁用并解释」更让人困惑（与 `blockedByEnv` 禁用主开关的同一取舍）。
   */
  hostFromEnv: boolean
  /** 实际监听地址；未运行或被 env 停用时为 `null`。 */
  address: { host: string; port: number } | null
  /**
   * 网关正在使用的凭据。
   *
   * ⚠️ 明文密钥。网关尚未创建过实例时为 `null`（例如被 env 停用、或插件刚
   * 启动还没起过网关），此时设置页应提示「启用后自动生成」而**不是**编一个
   * 占位串 —— 复制出去必然 401，比不给更让人困惑。
   */
  apiKey: RpcGatewayApiKey | null
  /**
   * 当前可用的模型 ID 列表（`provider/模型名`）。
   *
   * 存在的理由：**有些 agent 不会主动扫描模型目录**（如 ZCode），要靠用户
   * 手工把 ID 填进它的配置。而 `/v1/models` 需要 Bearer 鉴权，浏览器地址栏
   * 直接打开只会得到 401 —— 用户在设置页外没有任何途径看到这些 ID。
   *
   * ⚠️ 无凭据的 provider 已在采集阶段被跳过，故不会出现在这里。
   */
  models: RpcGatewayModel[]
  /**
   * 目录是从哪来的 —— 用于在清单为空时**说清原因**。
   *
   * ⚠️ 这个字段存在的唯一理由：此前 `models: []` 只有一种含义，用户看到
   * 「还没有可用模型」就去检查自己的登录，而真实原因可能是宿主根本没给出任何
   * 可枚举的 provider（插件加载异常）。空状态必须能自解释。
   *
   * - `catalog`：来自 `ctx.llm.listProviders()`（权威，正常路径）
   * - `adapters`：该方法不可用，退化为用本插件已注册的适配器 key 枚举
   * - `none`：两者都拿不到，目录必然为空
   */
  modelsSource: 'catalog' | 'adapters' | 'none'
  /**
   * 期望运行**却没能监听**的原因（Issue #11 的建议 ②）。
   *
   * ⚠️ 存在的理由：`running: false` 有四种完全不同的成因，而面板原先只能表达
   * 其中三种（被 env 停用 / 用户关了主开关 / 端口被占），**第四种「期望运行但
   * 启动失败」没有任何可区分的信号** —— 它与「用户自己关了」在响应里逐字相同，
   * 于是报障者只能看到「网关没了」，而下游全部 connection refused 又被误读成
   * API-key 问题。
   *
   * 取值：
   * - `null`：没有异常（正常在跑，或用户/ env 主动关闭）
   * - `start-failed`：`shouldRun` 为真但 `start()` 失败（端口冲突等），
   *   `reason` 带上游错误原文（如 `listen EADDRINUSE ...`）
   * - `factory-missing`：插件装配异常，压根没有可用的网关实例工厂
   */
  lastError: RpcGatewayLastError | null
  /**
   * 对外地址（env `DSH_OPENAI_GATEWAY_PUBLIC_URL` 的解析结果），非法值降级为 `null`。
   *
   * ⚠️ **必填**（不是 `?`）：三个网关 RPC（`gateway.getEnabled` /
   * `gateway.setEnabled` / `gateway.setAllowLan`）都必须回传它 —— 客户端
   * `setGatewayStatus(res)` 拿到响应就整份覆盖本地状态（`plugin-src/client/jet-hub.js`
   * 三处），漏一处 ⇒ 用户拨一下开关，面板就把该字段冲成 `undefined`，地址退回
   * `0.0.0.0` 并重新弹出「把 0.0.0.0 换成本机局域网 IP」的提示（PR #54 审计 P1）。
   * 写成必填，新增构造点漏字段时由 `tsc` 拦下，不再靠人记。
   */
  publicUrl: string | null
}

/** 网关「期望运行但未监听」的结构化原因（见 {@link RpcGatewayStatusResponse.lastError}）。 */
export interface RpcGatewayLastError {
  kind: 'start-failed' | 'factory-missing'
  /** 上游错误原文（`start-failed` 时必有；`factory-missing` 时为说明文案）。 */
  reason: string
  /**
   * 该失败发生的时刻（`Date.now()`）。
   *
   * ⚠️ 存在的理由（对抗审计 P1-2）：`disposeGatewayRuntime()` 收尾时要清掉
   * 「上一轮遗留」的失败痕迹，但**不能**清掉「本轮 dispose 期间新一轮收敛真的
   * 失败」的那条（实测：dispose 在飞时新收敛撞 `EADDRINUSE`，尾巴把它清成 null
   * ⇒ 面板显示「网关已关闭」，真因丢失）。时间戳让这个判据可判，且比比较对象
   * 引用更稳（新一轮可能写入形状相同的对象）。
   */
  at: number
}

/** RPC: 网关可用的模型条目（设置页内嵌展示用）。 */
export interface RpcGatewayModel {
  /** 可直接填进 agent 配置的完整 ID（`provider/模型名`）。 */
  id: string
  /**
   * 该条目所属的 provider key（**采集侧给的权威拆分**，不是从 `id` 切出来的）。
   *
   * ⚠️ 存在的理由：设置页要按「一家供应商一张卡片」分组，而模型名里**允许带
   * 斜杠**（实测 Cline 的 `cline/anthropic/claude-sonnet-5.5`）。前端按首个 `/`
   * 反推 provider 在正常数据上恰好也对，但那是**巧合**而非契约 —— 一旦某家
   * provider 的模型名以 `/` 开头、或 provider key 本身含 `/`，反推就错位，
   * 表现为「模型被分到了不存在的那一家」。分组是用户的语义，故由采集侧给定。
   */
  provider: string
  /**
   * provider **内部**的模型名（不含 `<provider>/` 前缀）。
   *
   * 卡片头已经把供应商写清楚了，行内再重复一遍前缀只是噪声：实测
   * `codearts/deepseek-v4.1-flash` 这类 id 会占满整行，窄面板下被截成
   * `codearts/deepse…` —— 用户既看不出模型名，也读不到能复制的 ID。
   */
  model: string
  /** 模型展示名，仅供人辨认。 */
  name: string
  /**
   * 模型接受的输入模态（如 `['text']`、`['text','image']`）。
   *
   * 设置页据此标出**哪些模型能发图片** —— 不标的话用户只能靠撞一次
   * `unsupported_content` 才知道。缺省为 `['text']`（与各适配器「不声明即
   * 保守按 text 处理」一致）。
   */
  input: readonly string[]
  /**
   * 思考档位视图（与 `/v1/models` 的 `reasoning` 字段**同一份**）。
   *
   * 存在的理由与 `models` 相同，但更硬：各 provider 的档位 id 是**上游私有值**
   * （TRAE 的 `light`/`extra_high`、LobsterAI 的 `xhigh`（界面上叫 Max）、
   * Cline 的 `max`（界面上叫 Extra）），而 OpenAI 客户端只有固定 8 档词汇。
   * 用户只能照 DSH 界面上的名字猜着填，猜错就是 400。
   * `openai_efforts` 就是「该填哪几个」的机读答案。
   *
   * 缺省表示该模型**未声明**档位（网关不下发该参数、按模型默认走），
   * 与「声明了但为空」不是一回事。
   */
  reasoning?: {
    /** 模型真实接受的 id，以及它在客户端里该写成的规范名。 */
    efforts: Array<{ id: string; name: string; canonical?: string }>
    /** 适配器配置的默认档（省略表示交给上游默认）。 */
    default?: string
    /** 可直接填进客户端的规范名清单（与 `efforts` 一一对应，无翻译损失）。 */
    openai_efforts: string[]
  }
}

/** RPC: 本机 OpenAI 网关开关写入请求。 */
export interface RpcGatewaySetEnabledRequest {
  enabled: boolean
}

/** RPC: 「允许局域网访问」开关写入请求（响应 = 整份 {@link RpcGatewayStatusResponse}）。 */
export interface RpcGatewaySetAllowLanRequest {
  allowLan: boolean
}

/**
 * RPC: 「默认取最强思考档」开关的读取响应（2026-11-11）。
 *
 * 开 = 在模型选择器里选完模型后，思考强度自动落在该模型支持的最高档；
 * 关 = 逐字节回到改动前的行为（各家适配器自己声明的 `defaultEffort`）。
 */
export interface RpcReasoningDefaultGetEnabledResponse {
  enabled: boolean
}

/** RPC: 「默认取最强思考档」开关写入请求。 */
export interface RpcReasoningDefaultSetEnabledRequest {
  enabled: boolean
}

/**
 * RPC: 「默认取最强思考档」开关写入响应。
 *
 * ⚠️ 回传的是**落盘后重读的值**，不是请求里的值 —— 与 `gateway.setEnabled`
 * 同取向：客户端一律以后端回传为准，不做乐观更新。
 */
export interface RpcReasoningDefaultSetEnabledResponse {
  enabled: boolean
}

/** RPC: 「渠道原生搜索」开关的读取响应。 */
export interface RpcNativeSearchGetEnabledResponse {
  /** `true` = 支持原生搜索的渠道走自己后端的搜索接口；`false` = 全部回官方搜索。 */
  enabled: boolean
}

/** RPC: 「渠道原生搜索」开关写入请求。 */
export interface RpcNativeSearchSetEnabledRequest {
  enabled: boolean
}

/**
 * RPC: 「渠道原生搜索」开关写入响应。
 *
 * ⚠️ 回传的是**落盘后重读的值**，不是请求里的值 —— 与 `gateway.setEnabled`
 * 同取向：客户端一律以后端回传为准，不做乐观更新。
 */
export interface RpcNativeSearchSetEnabledResponse {
  enabled: boolean
}

/** RPC: 「ZCode 会话负载均衡」开关的读取响应。 */
export interface RpcSessionBalanceGetEnabledResponse {
  /**
   * `true` = ZCode 多账号按 DSH sessionId 做会话亲和（无 sessionId 随机分摊）；
   * `false` = 回到「手动顺序首个可用账号」的既有语义。
   */
  enabled: boolean
}

/** RPC: 「ZCode 会话负载均衡」开关写入请求。 */
export interface RpcSessionBalanceSetEnabledRequest {
  enabled: boolean
}

/**
 * RPC: 「ZCode 会话负载均衡」开关写入响应。
 *
 * ⚠️ 回传的是**落盘后重读的值**，不是请求里的值 —— 与 `nativeSearch.setEnabled`
 * 同取向：客户端一律以后端回传为准，不做乐观更新。
 */
export interface RpcSessionBalanceSetEnabledResponse {
  enabled: boolean
}

/**
 * RPC: 「严格手动顺序」开关的读取请求（按 provider 维度）。
 *
 * ⚠️ **必须带 `provider`**：它是**按渠道的稀疏表**（`buddy` 开了不影响
 * `qodercn`），不是全局布尔。看完 {@link RpcSessionBalanceGetEnabledResponse}
 * 那条的读者很容易以为可以省掉这个字段 —— 省掉就只能返回「全体」，而面板
 * 每张卡片的开关语义是「只改这一家」。
 */
export interface RpcStrictManualOrderGetRequest {
  provider: string
}

/** RPC: 「严格手动顺序」开关的读取响应。 */
export interface RpcStrictManualOrderGetResponse {
  /**
   * `true` = 拖拽顺序是**唯一**的选号优先级（档位只当可用性判据）；
   * `false`（缺键默认）= 余额分档优先、档内才看手动顺序（升级前行为）。
   */
  enabled: boolean
}

/** RPC: 「严格手动顺序」开关写入请求。 */
export interface RpcStrictManualOrderSetRequest {
  provider: string
  enabled: boolean
}

/**
 * RPC: 「严格手动顺序」开关写入响应。
 *
 * ⚠️ 回传的是**落盘后重读的值**，不是请求里的值 —— 与 `sessionBalance.setEnabled`
 * 同取向：客户端一律以后端回传为准，不做乐观更新。
 */
export interface RpcStrictManualOrderSetResponse {
  enabled: boolean
}

/**
 * RPC: 「面板入口」的读取响应（插件详情页设置卡片里的下拉）。
 *
 * 语义：Jet Hub 的**唯一**入口位置，两个取值严格互斥 ——
 * `'sidebar'` = 主导航里那一行（`settings.section` 那一节注销）；
 * `'settings'` = 只剩「设置 → 插件 → Jet Hub」（主导航那一行注销）。
 *
 * ⚠️ 为什么这个偏好住**宿主**（`state.json`）而不是浏览器 `localStorage`：
 * 本插件的三条进入路径（Web / 桌面 / headless）共用同一份 `~/.dsh` 状态，
 * 而 Web 侧的 origin 是 `127.0.0.1:<随机端口>` —— **每次启动端口都变**，
 * `localStorage` 会随旧 origin 一起被抛弃，表现为「改掉的入口下次启动又变回来了」。
 */
export interface RpcPanelEntryGetResponse {
  entry: PanelEntry
}

/** RPC: 「面板入口」写入请求。 */
export interface RpcPanelEntrySetRequest {
  entry: PanelEntry
}

/**
 * RPC: 「面板入口」写入响应。
 *
 * ⚠️ 与 `nativeSearch.setEnabled` 同取向：回传的是**落盘后重读的值**，
 * 客户端一律以后端回传为准，不做乐观更新（宿主侧可能因为脏文档把值归一）。
 */
export interface RpcPanelEntrySetResponse {
  entry: PanelEntry
}

/**
 * RPC: MiniMax 国际站 `X-Forwarded-For` 设置的读取响应（issue IKMEVG）。
 *
 * ⚠️ `xff` 是**归一后的实际值**，空串表示「未设置 / 不附头」。
 * 客户端照它渲染输入框 —— 不要用用户输入的原文（非法值会被归一成空）。
 */
export interface RpcMinimaxXffResponse {
  /** 当前生效的 `X-Forwarded-For`；`''` = 不附头（走真实出口 IP）。 */
  xff: string
}

/**
 * RPC: MiniMax 国际站 `X-Forwarded-For` 设置的写入请求。
 *
 * ⚠️ **空串表示清除**（回到「不附头」），不是「设成空值头」——
 * 空值的 `X-Forwarded-For` 在 Akamai 侧与不附头等价，但会污染上游日志。
 */
export interface RpcMinimaxXffRequest {
  xff: string
}

/**
 * RPC: 网关凭据信息。
 *
 * ⚠️ 这是**明文凭据**，只应回传给调用方用于展示/复制，**不得**写进日志。
 * 单独成类型是为了让「拿到它」这件事在代码里显式可见，便于 review 时留意。
 */
export interface RpcGatewayApiKey {
  /** 密钥本体。 */
  value: string
  /** 是否来自 `DSH_OPENAI_GATEWAY_API_KEY`（此时 UI 不该显示文件路径）。 */
  fromEnv: boolean
  /** 密钥文件路径；`fromEnv` 为真时为 `null`。 */
  path: string | null
}

/** 存储在 CODEARTS_ACCESS_TOKEN 下的归一化临时凭据。 */
export interface CodeArtsCredential {
  access_key_id: string
  secret_access_key: string
  security_token: string
  expires_at: string
  domain_id?: string
  user_id?: string
  user_name?: string
  /** 刷新令牌（新式 IAM OAuth 流程签发；缺失表示旧 ticket 凭据，不可静默刷新）。 */
  refresh_token?: string
  /** PKCE 验证器，刷新换取时与 refresh_token 一起提交。 */
  code_verifier?: string
  /** DPoP ES256 私钥 JWK（随凭据持久化，刷新换取时签发 DPoP JWS）。 */
  dpop_private_key_jwk?: DpopPrivateJwk
  /** 模型速率限制/重置时间（框架层附加的运行时元数据，刷新凭据时需保留）。 */
  model_rate_limits?: Record<string, unknown>
}

/** 一次登录流程的结果：已存储的凭据值及其过期时间。 */
export interface LoginFlowResult {
  /** 原始令牌（token/fingerprint 分支）或 JSON.stringify(CodeArtsCredential)（轮询分支）。 */
  access: string
  /** 凭据过期的毫秒时间戳。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
}

/** runLoginFlow 和 startCallbackServer 接受的选项。 */
export interface LoginFlowOptions {
  /** pollForCredential 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 在浏览器中打开登录 URL；默认使用平台打开器。 */
  openBrowser?: (url: string) => void | Promise<void>
  /** 轮询尝试次数上限；默认为 120。 */
  maxAttempts?: number
  /** 登录流程选择：'oauth'（默认）或 'ticket'（旧流程回退）。 */
  flow?: 'oauth' | 'ticket'
  /**
   * 回调等待预算（毫秒）；默认 180 秒。
   *
   * ⚠️ 只为**可测**而存在：超时后必须把收码器标记为已结算，否则用户粘回来的
   * 链接会被接受并回「成功」（PR #57 正向审计 P3-8）。没有这个入口就只能
   * 真等 180 秒，超时分支的守卫等于没有。
   */
  callbackTimeoutMs?: number
}

/**
 * buddy (腾讯 CodeBuddy) 凭据，存储在 BUDDY_ACCESS_TOKEN 下。
 * 定义与解析工具放在 buddy.ts（与 CodeBuddy 协议常量同处一处）。
 */
export type { BuddyCredential } from './buddy.js'

/**
 * ========================================
 * 账号备份（导出 / 导入）
 * ========================================
 */

/** 备份文件格式标识（自包含，与 DSH 版本无关）。 */
export const BACKUP_FORMAT = 'dsh-codearts-auth/backup'

/** 备份格式版本：格式演进时递增并保留迁移逻辑。 */
export const BACKUP_VERSION = 1

/**
 * 备份载荷（导出结果 / 导入输入）。
 *
 * 设计要点：
 * - `credentials` 的值保存凭据 JSON **原文字符串**（与 `ctx.credentials`
 *   存储形态一致），导入时 `set(ref, value)` 直接回写，不重新序列化，
 *   避免字段丢失或变形；
 * - `accounts` 是账号池索引（ProviderAccountEntry 原文），`disabledModels`
 *   是模型黑名单 —— 两者与 `JetHubState` 同构，导入后整体替换；
 * - 整个文件自包含且带 `format` / `version` 标记，因此与 DSH 版本无关：
 *   换版本后导入时按**当前版本**的存储契约重建。
 */
export interface BackupPayload {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  /** 导出时间（ISO 8601），用于展示与可选的新旧校验。 */
  exportedAt: string
  /** credentialRef → 凭据 JSON 原文（字符串）。 */
  credentials: Record<string, string>
  /** 账号池索引（ProviderAccountEntry 原文）。 */
  accounts: ProviderAccountEntry[]
  /** 模型黑名单：provider id → 被关闭的模型 id → true。 */
  disabledModels: Record<string, Record<string, boolean>>
  /**
   * 各 provider 的「锁定永久积分」开关：provider id → 已锁定。
   *
   * ⚠️ **可选**：老备份文件里没有该字段，导入时保持当前值（不重置）。
   * 导出时总写完整表（含空表），故新备份一律自包含。
   */
  permanentLocks?: Record<string, boolean>
  /**
   * Loomy「锁定永久积分」开关（**兼容字段**，权威值在 {@link permanentLocks}）。
   *
   * ⚠️ **可选**：老备份文件里没有该字段，导入时保持当前值（不重置），
   * 因此不需要提升 {@link BACKUP_VERSION}。
   *
   * ⚠️ 导出时**继续双写**：老版本只读这一个字段，缺了它回退版本会看到
   * 「锁定悄悄失效」——而锁定失效的后果是**真的把永久积分烧掉**，
   * 属于不可逆损失，所以宁可留一个冗余字段。
   */
  loomyPermanentLocked?: boolean
}

/** RPC: 导出备份响应。 */
export interface RpcBackupExportResponse {
  payload: BackupPayload
  /** 未能读取凭据的账号 id（凭据缺失/损坏，不中断导出）。 */
  warnings: string[]
}

/**
 * 导入模式。
 *
 * - `replace`：**整体替换**账号池与模型黑名单（还原快照）。既有的「恢复」行为。
 * - `merge`：**只追加**——按 id 判重，已存在的账号跳过；**不碰**模型黑名单、
 *   永久积分锁定表与其余账号的凭据。用于「单独导入一个账号」。
 *
 * ⚠️ 两者都**不提升** {@link BACKUP_VERSION}：模式是**导入时的选择**，不是
 * 文件格式的一部分 —— 同一份备份文件既可整体还原也可合并追加。
 */
export type BackupImportMode = 'replace' | 'merge'

/** RPC: 导入备份请求。 */
export interface RpcBackupImportRequest {
  /** 备份载荷（明文 JSON 解析后的对象；加密文件在浏览器侧解密后传入）。 */
  payload: unknown
  /**
   * 导入模式，缺省 `replace`（保持既有调用方行为不变）。
   *
   * ⚠️ 必须是**可选**字段：老客户端不带它，后端必须按旧的「整体替换」处理。
   */
  mode?: BackupImportMode
}

/** RPC: 导出备份请求。 */
export interface RpcBackupExportRequest {
  /**
   * 只导出这些账号 id（单独导出某个账号时传**一个**元素）。
   * 缺省 / 空数组 = 导出全部账号。
   */
  accountIds?: string[]
}

/** RPC: 导入备份响应。 */
export interface RpcBackupImportResponse {
  /** 写入的凭据条数。 */
  credentialsImported: number
  /** 写入的账号数（合并模式下 = 实际新增的账号数）。 */
  accountsImported: number
  /**
   * 合并模式下因 id 已存在而**跳过**的账号 id。
   * `replace` 模式恒为空数组。
   */
  accountsSkipped: string[]
  /** 跳过的凭据 ref（非法 ref 等）。 */
  skipped: string[]
  /**
   * 导入的账号中「凭据已过期」的条数（账号条目的 `expiresAt <= 当前时刻`）。
   * 这类账号即使 refresh_token 尚有效也会在下一次请求时先静默续期；若
   * refresh_token 也已失效（导出后搁置过久 / CodeArts 一次性轮换），则需
   * 重新登录。前端据此提示用户。
   */
  expiredAccounts: number
  /**
   * 导入的账号中「凭据缺失」的条数：账号条目存在，但其 credentialRef 不在
   * 备份的 credentials 字典里。这类账号导入后无凭据可用，对应 provider 的
   * 模型目录会被门控隐藏（像未登录一样）。前端据此提示用户重新登录该账号。
   */
  missingCredentials: number
}

/**
 * RPC: 查询当前账号池统计（导入前的覆盖提示用）。
 *
 * `withoutExpiry` 统计缺 `expiresAt` 的账号条目——这正是 DSH 版本切换后
 * 自动恢复（`bootstrapFromCredentialRefs`）产生的条目特征：反推只按凭据
 * ref 名重建，不读凭据值，故拿不到有效期。正常登录的账号基本都带
 * `expiresAt`。该数字用于导入前提示「有 N 个自动恢复的账号将被覆盖」。
 */
export interface RpcBackupStatusResponse {
  /** 当前账号池的账号总数。 */
  accounts: number
  /** 缺 `expiresAt` 的账号条目数（疑似自动恢复产物）。 */
  withoutExpiry: number
  /**
   * 当前账号池的账号摘要（**可选**）：导出弹窗据此渲染「勾选要导出的账号」。
   *
   * ⚠️ 只含展示所需的字段，**不含任何凭据内容** —— 用户勾选时不需要看到
   * 密钥，多传一份只会扩大泄漏面。
   */
  accountList?: Array<{
    id: string
    provider: string
    nickname: string
    enabled: boolean
  }>
}

/**
 * RPC: 内部载体问「现在要不要产 param」。
 *
 * 需求位为 `false` 时 client **一次都不产**（零配额消耗）——阿里云按同设备
 * 每小时 150 次限流，白产比不产更贵（判据见 `src/captcha-supply.ts` 文件头
 * 「与预取池的区别」）。
 */
export interface RpcCaptchaDemandResponse {
  active: boolean
}

/**
 * RPC: 内部载体问「载体页在哪个地址」（评审 C1/C2）。
 *
 * ⚠ 为什么 client 不能自己拼：载体页必须待在**一个与 Host 端口不同**的回环端口上
 *   ——桌面版主进程的 `allowedNavigation()` / `onBeforeRequest` 都以
 *   `isApplicationHost(url)` 拒绝「端口相同 + 主机相同/回环」的地址
 *   （DSH Desktop 0.2.0-rc.2，`app.asar/lib/main.js`）。
 *   端口由 server 运行时挑（`src/captcha-carrier-server.ts`）⇒ 只能问。
 *
 * ⚠ `null` = **现在没有可用地址**（env 关掉 / 候选端口全被占）。client 拿到它就
 *   安静退出（本轮不建 guest、不导航）；这不是错误，别当异常报。
 */
export interface RpcCaptchaCarrierUrlResponse {
  url: string | null
}

/**
 * RPC: 内部载体回传一个 param。
 *
 * ⚠ **故意没有** `atMs` / 任何绝对时间戳字段：产出时刻由 server 用
 * 「自己的到达时刻 − `elapsedMs`」推算（见 `jet-hub-rpc.ts` 的该 case 注释）。
 * client 传绝对时间戳会把跨端时钟漂移引进时效闸 —— 快了永不判过期、
 * 慢了一投放就过期，两种都表现为**内部载体静默不可用**。
 */
export interface RpcCaptchaContributeRequest {
  /** guest 里 SDK 产出的 param。空串/全空白一律不收。 */
  param: string
  /**
   * client 侧「开始产 → 发这条 RPC」的**相对耗时**（毫秒）。
   *
   * 相对耗时是同机单向差值，比绝对时钟可靠；非法值（负数、非整数、
   * ≥ 5 分钟）一律退回 0，即按到达时刻记账。
   */
  elapsedMs?: number
  /**
   * 这一发是不是被降级成了**交互式验证**（评审 I2）。
   *
   * ⚠ 这是内部载体**唯一**的设备信誉预警：chromium 那条腿在
   *   `ZcodeAuth.captchaPoolInstance()` 里已经会 `warn`，而内部载体这段此前
   *   只打进 client 控制台 —— host 侧看不到，等于没有预警。
   * 缺省 / 非 `true` 一律当「无感通过」（不要把缺字段说成有）。
   */
  interactive?: boolean
}

/** RPC: 内部载体回传 param 的结果（`false` = 没进槽，client 可决定要不要重试）。 */
export interface RpcCaptchaContributeResponse {
  accepted: boolean
}

/**
 * ========================================
 * 用量徽标（模型选择器旁）
 * ========================================
 *
 * 一个端点回答「当前选中的渠道还剩多少」，供会话输入区那枚徽标使用：
 * 折叠态给一个数字（订阅优先 / 积分兜底），展开后给逐账号明细。
 *
 * ⚠️ 与 `credits.balances` 的关系：**读数是同一份**（本端点内部直接复用
 * `credits.balances` 的实现），差别有三处 ——
 * 1. 只返回**启用**账号（停用账号不计入合计，另给 `disabledCount` 说明）；
 * 2. 多带一份订阅读数（窗口 / 套餐），形状由 `badge-subscription.ts` 判定；
 * 3. 结果带**宿主侧 TTL 缓存**（`cached` 标出来），因为徽标会按分钟轮询，
 *    而余额是逐账号打上游的（见 `collectCreditBalances` 的「顺序查询」）。
 */

/** RPC: 读取用量徽标读数。 */
export interface RpcUsageBadgeRequest {
  /** 渠道 id（与 provider id 同名，即模型选择器里的路由 id）。 */
  provider: string
  /** `true` = 绕过宿主 TTL 缓存（手动刷新、签到之后用）。 */
  force?: boolean
}

/**
 * 套餐读数（**折叠态只显示一条**，故每个账号先折算成一条）。
 *
 * ⚠️ 与窗口式订阅（Cline）是**两种形态**，不要合并：
 * 窗口答「各时间窗用掉百分之几」，套餐答「这份套餐还剩多少额度」。
 */
export interface RpcUsageBadgePlanReading {
  /** 展示名：套餐包名，或「整个余额即套餐」时的固定名（见 `badge-subscription.ts`）。 */
  name: string
  remaining: number
  total: number
  /**
   * `total` 是否是上游真实下发的周期总额（同 {@link CreditPackage.totalKnown}）。
   *
   * `false` = 上游只给当前余额 ⇒ 客户端**不得**把两者并列显示
   * （否则 `100/100 → 98/98` 的假分母会从积分区漏到套餐区）。
   */
  totalKnown?: boolean
  /** 额度单位（`credits` / `token`），渲染标签与数字格式化都按它走。 */
  unit: string
  /** 扣费截止（毫秒）；缺省 = 服务端未下发（**不是**已过期）。 */
  deductionEndTime?: number
}

/** 套餐读数：一个账号一条（`plan` 为 `null` = 该账号没有可用套餐包）。 */
export interface RpcUsageBadgePlanAccount {
  accountId: string
  nickname: string
  plan: RpcUsageBadgePlanReading | null
  /** 余额本身查询失败时的原因（与 `plan: null` 严格区分）。 */
  error?: string
}

/** 订阅读数：窗口（Cline）或套餐（Qoder / ZCode / 两个 buddy）。 */
export type RpcUsageBadgeSubscription =
  | { kind: 'windows'; accounts: RpcClineQuotaAccount[] }
  | { kind: 'plan'; accounts: RpcUsageBadgePlanAccount[] }

/** RPC: 用量徽标读数响应。 */
export interface RpcUsageBadgeResponse {
  /** 回显请求的渠道（前端并发切换时据此对号，避免把 A 的读数画到 B 上）。 */
  provider: string
  /** 宿主**生成**这份读数的时刻（毫秒）；UI 的「更新于」用它，不用到达时刻。 */
  generatedAt: number
  /** `true` = 命中宿主 TTL 缓存（这一轮没有真的打上游）。 */
  cached: boolean
  /** 逐账号余额（**仅启用账号**），形状与 `credits.balances` 一致。 */
  accounts: RpcCreditsBalanceAccount[]
  /** 被停用而**未计入**的账号数（弹窗脚注说明用；为 0 时不渲染脚注）。 */
  disabledCount: number
  /** 临时 / 长期分桶的窗口天数（沿用 `credits.balances` 的口径）。 */
  windowDays?: number
  /** 订阅读数；该渠道没有订阅数据、或订阅查询失败时**整个字段缺席**。 */
  subscription?: RpcUsageBadgeSubscription
  /** 当前生效的显示偏好（顺带回传，省一次往返）。 */
  preference: BadgePreference
  /**
   * 「每日首次启动自动签到」的实时状态（顺带回传，供弹窗右上角那盏状态灯）。
   *
   * ⚠️ 与 `preference` 同理**不进 TTL 缓存**：`running` / `ranToday` 会在宿主
   * 后台任务跑起来后变化，缓存住会让界面一直停在旧状态（看起来像「开关点了没反应」）。
   */
  autoCheckin: RpcUsageAutoCheckinState
  /**
   * `jet-hub-auto` 本次**实际**发往的渠道与模型（仅当请求的是 auto 且已发过请求时存在）。
   *
   * ⚠️ 宿主端的 auto 没有自己的账号与余额，`usage.badge` 会把请求改写成「临期胜者」
   * 再去查余额；这份字段就是告诉客户端「改写成了谁」，供折叠胶囊显示
   * 「实际在用的渠道 + 模型」—— 徽标是**止损工具**，用户原话「以为在用 A，
   * 实际在烧 B，等发现时积分已经没了」。
   *
   * ⚠️ 上游 `ba10f4f` 重写 aggregate 时把本字段一并删掉了（旧 auto 的徽标随之失效）。
   * 这里补回来（用户 2026-10-08 选定「两条都修」）。
   */
  autoActual?: { provider: string; model: string; viaImageFallback: boolean }
  /**
   * 本次 auto 胜者的额度失效时刻（毫秒）—— 折叠胶囊的临期倒计时用。
   *
   * ⚠️ **只有有限值才回传**：`Infinity`（只有长期积分）会被 JSON 序列化成 `null`，
   * 客户端按 `typeof === 'number'` 判空。故 `null` 与「字段缺席」在语义上等价，
   * 客户端只需判 `typeof`。
   */
  autoExpiryAt?: number
  /**
   * auto 本次目标的**计费倍率**（`priceFactorFromName` 的结果）。
   *
   * ⚠️ 只有**有限**值才回传：`Infinity` 是「无标注」的哨兵，拼进文案会渲染出
   * `xInfinity`。`0` 是合法值（显示「免费」）。
   *
   * ⚠️ 存在的理由（用户报障 2026-10-08「没倍率显示？」）：auto 是跨渠道的单一
   * 模型名，**它自己没有倍率** —— 倍率取决于这次选中谁。模型选择器显示的是
   * `listModels` 的静态名（对所有请求都一样），往那里写死倍率就是编造。
   * ⇒ 倍率只能显示在胶囊里（那里才有「实际用了谁」）。
   */
  autoPrice?: number
}

/**
 * RPC: 读写「用量徽标显示偏好」。
 *
 * ⚠️ `preference` **省略 = 只读**；给出时必须是 `auto` / `subscription` /
 * `credits` 三者之一 —— 非法值一律 `bad-request`，**不做**静默回落
 *（回落会让「设置没生效」看起来像「保存成功」）。读取侧的容错在
 * `sanitizeBadgePreference`，那里面对的是**磁盘上的脏数据**，不是用户输入。
 */
export interface RpcUsageBadgePreferenceRequest {
  preference?: BadgePreference
}

/** RPC: 用量徽标显示偏好响应（回显写入后的生效值）。 */
export interface RpcUsageBadgePreferenceResponse {
  preference: BadgePreference
}

/**
 * RPC: 读取 **Token 账本**快照（「Token 用量」面板的唯一数据源）。
 *
 * 数据来自进程内存的 `src/token-ledger.ts`：记账点在注册收敛层
 * （`llm-register-compat.ts` 的包装适配器），渠道由网关侧打标区分。
 * **重启即丢**（第 1 期不持久化），UI 需说明这一点而不是伪装成历史报表。
 */
export interface RpcUsageTokenLedgerRequest {
  /** 明细最多多少条；省略 = 服务端上限（`TOKEN_LEDGER_LIMIT`）。 */
  limit?: number
}

/** Token 账本快照响应（形状直透 `TokenLedgerSnapshot`，不另造一份平行类型）。 */
export interface RpcUsageTokenLedgerResponse {
  snapshot: TokenLedgerSnapshot
}

/**
 * RPC: 读取 **历史日聚合**（第 4 期 · 「Token 用量」弹窗的历史视图）。
 *
 * 数据源是落盘的日聚合（重启保留），与内存明细是两份独立数据 ——
 * 历史答「本周/本月用了多少」，明细答「每一笔长什么样」。
 */
export interface RpcUsageTokenLedgerHistoryRequest {
  /**
   * 只看最近 N 天（**含今天**，UTC+8 日界）；省略 = 全部历史
   * （服务端钳到 `TOKEN_LEDGER_HISTORY_MAX_DAYS`）。自选范围可传 fromDay / toDay。
   */
  sinceDays?: number
  /** 自选日期范围起点（UTC+8 日键，含当日）；与 toDay 配合使用。 */
  fromDay?: string
  /** 自选日期范围终点（UTC+8 日键，含当日）；与 fromDay 配合使用。 */
  toDay?: string
}

/** 历史日聚合响应（形状直透，不另造平行类型）。 */
export interface RpcUsageTokenLedgerHistoryResponse {
  history: TokenLedgerHistoryDay[]
  /** 所选窗口的合计（按日累加，均值按全部样本 Σ/份数计算）。 */
  totals: Omit<TokenLedgerModelRow, 'model'>
}

/** RPC: 删除某一天的历史日累计；不影响进程内 Token 明细。 */
export interface RpcUsageTokenLedgerDeleteDayRequest {
  day: string
}

export interface RpcUsageTokenLedgerDeleteDayResponse {
  day: string
  deleted: true
}

/**
 * 「每日定时自动签到」的实时状态。
 *
 * 语义要点：
 * - 开关是**全局**的（不分渠道），作用范围是**全部有账号的渠道**；
 * - 「今天」按 **UTC+8** 日界算（各渠道的每日额度都按 UTC+8 结算）；
 * - ★ 2026-10-18 起从「每日首次启动跑一次」改成**每天两个固定时刻**；
 *   `lastSlot` 是「不多次重复触发」的新凭据：水位线之后的时段才需要跑。
 *   ⚠️ 2026-10-31 重建（上一版随 `git reset --hard` 升级被清空）。
 */
export interface RpcUsageAutoCheckinState {
  /**
   * 开关是否打开。默认**打开**（`auto-checkin.ts` 的 `DEFAULT_AUTO_CHECKIN`：
   * 用户 2026-10-02 明确要求「自动签到默认保持打开」）。⚠️ 本注释早于那次
   * 决定、写的是「默认关闭」，已按实现更正 —— 改默认值前先改这里，别让注释
   * 与实现分家（那正是本 PR 审查发现的一处矛盾）。
   */
  enabled: boolean
  /**
   * 每天两个执行时刻（`HH:MM`，UTC+8，升序）。
   *
   * 用户 2026-10-18：「每天几点自动启动…一天两次实现无遗漏」—— 用**两个时段**
   * 替代原先的「每日首次启动跑一次」，否则早上开过 DSH 后，21:00 才刷新额度的
   * 渠道当天就再也领不到。
   */
  times: string[]
  /**
   * 随机浮动幅度（分钟）：0 = 精确按时刻执行；>0 = 每轮在 ±N 分钟内随机偏移。
   *
   * 用户 2026-10-31：「搞得像真人一样有时间波动」—— 固定到分钟的签到时刻是
   * 明显的脚本特征。偏移**每轮重新抽**（不是每天固定一个偏移量，后者指纹依然稳定）。
   */
  jitterMinutes: number
  /**
   * 已完成时段的**水位线**（`YYYY-MM-DD#HH:MM`）；空串 = 从未跑过。
   *
   * 含义：key 不大于它的时段都算已处理。故 `lastSlot` 落后于「已到点的最大
   * 时段」时就该补跑 —— 这也是「DSH 没开时错过的那轮，启动后补跑」的判据。
   */
  lastSlot: string
  /** 上次**完成**自动签到的 UTC+8 日期（`YYYY-MM-DD`）；空串 = 从未跑过。 */
  lastDate: string
  /** 今天是否已经跑过至少一个时段（`lastSlot` 的日期部分是今天）。 */
  ranToday: boolean
  /**
   * 下一次自动执行的毫秒时刻；0 = 不会执行（开关关闭）。
   *
   * ⚠️ 客户端渲染它时**必须区分三态**（非数字 = 宿主是旧代码 / `<=0` = 开关
   * 关闭 / `>0` = 正常时刻）。把前两者混成一句「开关已关闭」会造成「开关明明
   * 勾着却说已关闭」的自相矛盾（2026-10-18 真实报障）。
   */
  nextRunAt: number
  /**
   * 正在**补领**的时段（`YYYY-MM-DD#HH:MM`）；空串 = 没有待补的渠道。
   *
   * ⚠️ 这是「逐渠道水位线」的对外投影：一个时段里只要还有渠道没证明「今天已处理」
   * （典型：**10:00 才刷新额度**的 Qoder 在 10:00 之前那轮），本字段非空，宿主会
   * 按退避**只重试那些渠道**，而不是等下一个时段。面板据此显示「N 个渠道待补」。
   */
  pendingSlot: string
  /** 正在执行中（刚打开开关会立刻跑一轮，此时为 true）。 */
  running: boolean
  /** 上次结果摘要（中文短句，展示在状态灯提示里）。 */
  lastResult: string
  /** 上次跑完的时刻（毫秒）；0 = 从未跑过。面板上的时间戳用它。 */
  lastAt: number
  /**
   * **逐渠道**结果（顺序即遍历顺序，文本形如 `2 个 +800` / `今天已领` /
   * `无签到接口` / `出错`）。
   *
   * 用户 2026-10-02：「自动签到状态下，下方应该也显示文字状态，这样才能够知道
   * 各个渠道的签到状态」—— 汇总句看不出是哪个渠道，故这里给逐渠道明细。
   */
  channels: Array<{ provider: string; text: string }>
  /**
   * 用户是否已手动关闭那行**常驻**的自动签到状态文字。
   *
   * ⚠️ 判据是「关闭的是当前这一轮」：新一轮跑出结果后自动变回 `false`
   *（否则用户关过一次就再也看不到新结果了）。
   */
  dismissed: boolean
}

/**
 * RPC: 读写「每日首次启动自动签到」开关，以及关闭常驻状态文字。
 *
 * ⚠️ `enabled` 与 `dismiss` 都**省略 = 只读**；给出时必须是布尔值 —— 非法值一律
 * `bad-request`，**不做**静默回落（与本仓库 `usage.badgePreference` 同口径：
 * 回落会让「设置没生效」看起来像「保存成功」）。磁盘脏数据的容错在
 * `sanitizeAutoCheckin`。
 * ⚠️ 打开开关时宿主会**立刻尝试一轮**（今天已跑过则内部拦住）：否则用户今天点了
 * 开关要等到明天才有动作，看起来像没生效。
 * ⚠️ `dismiss: true` 只关掉**当前这一轮**的状态文字（下一轮结果会重新出现）——
 * 手动签到的结果提示是按时自动消失的，两者语义不同，别合并。
 */
export interface RpcUsageAutoCheckinRequest {
  enabled?: boolean
  /**
   * 改写两个执行时刻（`HH:MM`，UTC+8）。
   *
   * ⚠️ 必须**恰好两项**、格式合法、互不相同 —— 任一不满足都回 `bad-request`，
   * 不做静默回落（回落会让「设置没生效」看起来像「保存成功」）。
   */
  times?: string[]
  /**
   * 随机浮动幅度（分钟，0–120）。省略 = **不改动**（与 `times` 语义独立）。
   * 给出但非法（负数 / 非数字 / 超上限）⇒ `bad-request`，不静默回落。
   */
  jitterMinutes?: number
  dismiss?: boolean
}

/** RPC: 自动签到开关响应（回显写入后的生效状态）。 */
export interface RpcUsageAutoCheckinResponse {
  autoCheckin: RpcUsageAutoCheckinState
}
