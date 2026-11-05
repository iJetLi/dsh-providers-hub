/**
 * AutoClaw（智谱清言桌面端）积分钱包余额查询与每日签到领额度。
 *
 * ## 协议端点
 *
 * 1. 积分钱包余额查询（只读）：
 *    `GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`
 *    响应包含 total_balance 与各钱包明细（reward, daily, subscription, fuel_pack, other）。
 *    ⚠️ **无任何到期字段**（桌面端 Zod schema `.strict()` 五字段）——
 *    且服务端用 `display` 标记哪些池可展示（官方客户端据此过滤）。
 *
 * 2. 积分流水（只读，**唯一**的逐批次到期数据源）：
 *    `GET /agent-assetmgr/api/v1/ledgers_std?asset_type=point&wallet_type=all`
 *    每笔发放（`mutation_type === "credit"`）带 `wallet_expires_at`（unix 秒）。
 *    ⚠️⚠️ **但它是「历史发放额」，不是该批次的「当前剩余额」**（见
 *    `parseAutoclawLedgerBatches` 的说明与对照）⇒ 用户消耗过积分后，
 *    未过期批次之和 ≠ `total_balance` ⇒ **本渠道的逐批次分档目前无法稳定生效**。
 *    下游用「批次和 == `total_balance`」当守恒安全网，不守恒就回退钱包包
 *    （总额与长期数仍正确，只是没有临期档）。**未解决项已如实登记，不得声称
 *    本渠道已支持按批次分档。**
 *
 * 3. 每日签到领额度（写，幂等判据）：
 *    `POST /userapi/v1/user-info`
 *    Body: `{ source_id: 'autoclaw', device_id }`
 *    响应体中 `daily_check_in_completed_on_request`:
 *    - true: 签到成功（`kind: 'claimed'`）
 *    - false: 今日已完成签到（`kind: 'already-claimed'`）
 */

import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'
import type { ProviderBalanceDetail } from './provider-runtime.js'
import { randomUUID } from 'node:crypto'
import {
  AUTOCLAW,
  AUTOCLAW_SOURCE_ID,
  type AutoclawProduct,
} from './autoclaw-product.js'
import {
  calculateAutoclawSign,
  type AutoclawCredential,
} from './autoclaw.js'
import { refreshAutoclawToken } from './autoclaw-oauth.js'

export const AUTOCLAW_WALLETS_PATH = '/agent-assetmgr/api/v2/wallets'
export const AUTOCLAW_LEDGERS_PATH = '/agent-assetmgr/api/v1/ledgers_std'
export const AUTOCLAW_DAILY_CLAIM_PATH = '/userapi/v1/user-info'
export const AUTOCLAW_CREDITS_TIMEOUT_MS = 15_000

/**
 * 签到腿**刷新（登录事件）**的单次请求超时。
 *
 * ⚠️ 存在的理由（2026-10-27 审计 P2-2）：`refreshAutoclawToken` 会**依次试两个
 * 端点**，若沿用它的 60s 默认值，光刷新就 120s，加 claim 自身 15s ⇒ **135s**
 * （实测真实挂钟 120,015ms；修复前上界 15s，**9 倍**）。而这段等待发生在
 * **签到之前** ⇒ 用户点「一键领取积分」后界面最长转两分多钟，每个账号各付一次。
 *
 * 取值 5s：刷新是**增量能力**（登录事件 → 活动奖励），不值得为它拖长一个
 * 既有功能；两个端点各 5s ⇒ 最坏 10s，仍在可接受范围。
 */
export const AUTOCLAW_CLAIM_REFRESH_TIMEOUT_MS = 5_000
export const AUTOCLAW_CREDIT_UNIT = '积分'

/**
 * 流水翻页上限（页 × 100 条）。
 *
 * ⚠️ **必须有界**：余额徽标每 60 秒轮询一次，无界翻页会把徽标变成无限循环请求。
 * 实测该账号全部发放历史 = 28 条（1 页）。到达上限仍没对平时，走守恒回退
 *（见 `fetchAutoclawBalanceDetailed`）—— 宁可没有临期桶，也不给错数。
 *
 * ⚠️⚠️ **单次余额查询的总时间预算**（P2 修正）：翻页是**串行 await** 的，
 * 原先每页各自 arm 一份 `AUTOCLAW_CREDITS_TIMEOUT_MS`（15s）⇒ 钱包 1 页 +
 * 流水 5 页的最坏耗时 = **90 秒**，已经**超过徽标 60 秒的轮询周期**
 * ⇒ 请求叠加，上游一慢就把面板拖住（实测 6 次请求）。
 * ⇒ 翻页**共用一份总预算**（`AbortSignal.timeout` 只 arm 一次），
 *   把最坏耗时钉回单次请求的量级；预算耗尽即中止，靠守恒校验回退钱包包。
 */
export const AUTOCLAW_LEDGER_MAX_PAGES = 5

/** 钱包类型与默认展示名映射。 */
export const AUTOCLAW_WALLET_TYPE_LABELS: Readonly<Record<string, string>> = {
  reward: '奖励积分',
  daily: '每日积分',
  subscription: '签约积分',
  fuel_pack: '加油包积分',
  other: '其他积分',
}

export interface AutoclawWalletItem {
  readonly public_wallet_type?: string
  readonly display_name?: string
  readonly balance?: number
  readonly balance_view?: string
  readonly display?: boolean
  readonly priority?: number
}

export interface AutoclawWalletsResponseData {
  readonly schema_version?: string
  readonly total_balance?: number
  readonly wallets?: readonly AutoclawWalletItem[]
}

export interface AutoclawDailyClaimResponseData {
  readonly uid?: string
  readonly daily_check_in_completed_on_request?: boolean
}

export interface AutoclawCreditsOptions {
  readonly product?: AutoclawProduct
  readonly fetcher?: typeof fetch
  readonly deviceId?: string
  /**
   * 日志出口（可选）；宿主 RPC 层经 `ProviderCallContext.warn` 传入。
   *
   * ⚠️ 存在的理由（2026-10-27 审计 P1-3）：刷新失败原先被裸 `catch` 完全吞掉
   * ⇒ `outcome` 与**成功逐字相同**，而本文件**没有任何日志出口**（改前全仓零日志）。
   * 本 PR 的立论正是「没登录就没奖励」这个**静默缺失** —— 它引入的新失败路径
   * 不能同样是静默的。
   */
  readonly warn?: (message: string) => void
  /**
   * 把**轮换后的**凭据写回（可选）。
   *
   * ⚠️⚠️ 存在的理由（2026-10-27 审计 **P0**，两路独立审计各自命中）：
   * `refreshAutoclawToken` 会解析并返回轮换后的 `refresh_token`
   * （`autoclaw-oauth.ts` 的 `newRefresh`），而本文件的刷新腿原先**只取
   * `access_token`、把 `refresh_token` 直接丢弃**。
   *
   * 若服务端按 OAuth 2.1 RTR **一次性轮换**，丢弃就等于**每天烧掉一次续期能力**：
   * 旧 refresh_token 立即失效 ⇒ 此后每轮刷新的 401 被静默降级 ⇒ 活动奖励永不再发；
   * 而自愈/续期读到盘上的死 token 会抛 `RefreshTokenExpiredError` ⇒
   * `pool.updateAccount(…, { refreshable: false })` ⇒ 用户被要求重登，
   * **而重登拿到的 token 又会在下一次签到时被同样烧掉**。
   *
   * ⚠️ 判断依据不是「我觉得会轮换」，而是**本仓库自己的记载**：
   * `src/jet-hub-rpc.ts` 的续期注释明写「续期**会轮换** refresh_token，并发会让
   * 后写的把先写的新 token 覆盖成已失效的旧 token」（并为此建了
   * `balanceHealInFlight`）；同 provider 的 `autoclaw-auth.ts` 那条续期腿
   * **会** `credentials.set` 落盘 —— **同一字段两套口径**。
   * 而 `docs/agent-notes/providers-autoclaw.md` 把「续期端点是否仍接受这批
   * refresh_token」登记为**未测**。
   *
   * ⇒ 修法：把整份刷新结果交给调用方落盘（与 `autoclaw-auth.ts` 同源）。
   * **没有落盘出口时不得静默丢弃** —— 会 `warn` 出声（见实现）。
   */
  readonly persist?: (credential: AutoclawCredential) => Promise<void>
  /** 刷新腿的单次请求超时；缺省 {@link AUTOCLAW_CLAIM_REFRESH_TIMEOUT_MS}。 */
  readonly refreshTimeoutMs?: number
}

/**
 * **在飞刷新**：同一个 `refresh_token` 的并发调用共享一次请求。
 *
 * ⚠️⚠️ 存在的理由（2026-10-27 自查实测，由本文件的**落盘腿自己**引入的竞态）：
 *
 * 落盘腿让「刷新 → 写回新 `refresh_token`」成为一次**写操作**。而并发时两次
 * 刷新各自拿到一个新 token，写回的先后顺序**由网络抖动决定**，不由签发顺序决定
 * ⇒ **晚到的旧响应会把已作废的旧 token 覆盖回盘上**。
 *
 * 实测（有状态桩：同一 RT 宽限期内可用两次、只有最新签发有效；只给**第一次**响应
 * 加 50ms 延迟）：
 *
 * ```
 * [抖动] 签发次数 = 2 | 落盘序列 = ["RT-2","RT-1"]
 * [抖动] 服务端最新有效 RT = RT-2
 * [抖动] 最后落盘 = RT-1 | 它还有效吗 = false   ← 盘上留下作废 token
 * ```
 *
 * ⇒ 后果与 P0 同源同量级：下一次续期读到死 token ⇒ `RefreshTokenExpiredError`
 * ⇒ 账号被标 `refreshable:false`。而本仓库**早就为同一形态**给自愈腿建了
 * `balanceHealInFlight` 去重表，并逐字写下「并发会让后写的把先写的新 token
 * 覆盖成已失效的旧 token」—— 这条新腿此前不在任何闸门之内。
 *
 * 按 `refresh_token` 作键（而不是设备号或账号）：它**就是**被轮换的那个东西，
 * 同一个 RT 的并发刷新在语义上就是同一件事。任务落定即摘除，不会累积。
 */
const inflightRefreshes = new Map<string, Promise<AutoclawCredential | undefined>>()

/**
 * 归一化 token 字符串。
 *
 * ⚠️⚠️ **`typeof` 闸门不可省**（2026-10-27 审计 P1-2，本 PR 引入的**回归**）：
 * 原写法只挡 falsy（`if (!token) return ''`），而 `refresh_token` 的实际来源是
 * **用户可编辑的备份文件** —— `src/backup.ts` 只判外层 `typeof value === 'string'`，
 * 内层字段可以是数字 / 对象 / 布尔。传进来就会走到 `token.replace(...)` 抛
 * `TypeError: token.replace is not a function`，而按契约 `claimAutoclawDailyQuota`
 * **不抛异常**，且该调用写在 claim 的 `try` **之外** ⇒ 异常直接逃到
 * `collectClaimResults` 的裸 `JSON.parse` 出口，用户看到一句毫无出路的内部错误。
 * 修复前这条路径**根本不读** `refresh_token` ⇒ 那种凭据本来能正常签到。
 *
 * ⚠️ 同仓的 `cleanBearerToken`（`src/autoclaw.ts`）**已有** `typeof` 闸门 ——
 * 这里补齐，不再让同一语义有两套口径。
 */
function cleanToken(token?: unknown): string {
  if (typeof token !== 'string' || token.length === 0) return ''
  return token.replace(/^Bearer\s+/i, '').trim()
}

/**
 * 构造 AutoClaw API 认证请求头。
 */
export function buildAutoclawCreditsHeaders(
  product: AutoclawProduct,
  accessToken?: string,
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString()
  const sign = calculateAutoclawSign(product.appId, ts, product.appKey)
  const clean = cleanToken(accessToken)
  const authVal = clean ? `Bearer ${clean}` : ''

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Auth-Appid': product.appId,
    'X-Auth-TimeStamp': ts,
    'X-Auth-Sign': sign,
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
    'User-Agent': 'AutoClaw/2.1.0 (win)',
  }
  if (authVal) {
    headers['X-Authorization'] = authVal
    headers.Authorization = authVal
  }
  return headers
}

/** 构造单个资源包。 */
function makePackage(
  name: string,
  remaining: number,
  active = true,
): CreditPackage {
  return {
    name,
    unit: AUTOCLAW_CREDIT_UNIT,
    remaining,
    total: remaining,
    used: 0,
    active,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
}

/**
 * 解析并转换钱包明细列表为 CreditPackage 数组。
 * 按照 priority 排序（小者优先），若 display_name 存在则使用，否则回退映射类型名。
 *
 * ⚠️ **`display === false` 的钱包必须丢弃**（2026-10-17 用户报障「每日 0」红字）。
 * 官方桌面端同款过滤（main.cjs `readWallets`：`wallet.display === true`）——
 * 服务端用这个标记表达「该池不该展示」（实测 `daily/subscription/fuel_pack/other`
 * 四池全为 `display:false` 且余额 0）。此前本解析器**忽略**了该标记，
 * 把 4 个隐藏的 0 余额池也发了出去 ⇒ 客户端按池名匹配「每日积分」命中
 * `DAILY_POOL_NAMES`，渲染出红色的「每日 0」——而「每日红 + 刷新倒计时」
 * 是 Loomy 那种**当日重置池**的语义（未用完随重置作废），AutoClaw 的
 * 每日签到积分是发放进余额、按**批次到期**作废的，两码事。
 */
export function parseAutoclawWallets(walletsRaw: unknown): CreditPackage[] {
  if (!Array.isArray(walletsRaw)) return []

  const items: AutoclawWalletItem[] = []
  for (const raw of walletsRaw) {
    if (!raw || typeof raw !== 'object') continue
    const cast = raw as Record<string, unknown>
    items.push({
      public_wallet_type: typeof cast.public_wallet_type === 'string' ? cast.public_wallet_type : undefined,
      display_name: typeof cast.display_name === 'string' ? cast.display_name : undefined,
      balance: typeof cast.balance === 'number' && Number.isFinite(cast.balance) ? cast.balance : 0,
      balance_view: typeof cast.balance_view === 'string' ? cast.balance_view : undefined,
      // ⚠️⚠️ **缺字段必须判为「不可见」**，不是回退成可见（P2 修正）。
      //   官方桌面端是 `wallet.display === true` 的**严格**判断；
      //   原写法 `typeof cast.display === 'boolean' ? cast.display : true`
      //   在字段缺失时 fail-open ⇒ 「每日积分」池原样回归 ⇒ **原报障症状
      //   （红色「每日 0」）逐字复现**。过滤器的契约是「显式 `false` 才丢」，
      //   与官方判据必须逐格一致，否则同一份响应在两端得到不同的池集合。
      display: cast.display === true,
      priority: typeof cast.priority === 'number' && Number.isFinite(cast.priority) ? cast.priority : 100,
    })
  }

  // ⚠️ 与上面 `display` 的严格口径配套：只有**显式** `display === false` 才丢
  //    （`item.display !== false` 在严格归一后已等价于「display 为 true」）。
  const visible = items.filter((item) => item.display !== false)
  visible.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))

  return visible.map((item) => {
    const type = item.public_wallet_type ?? 'other'
    const defaultLabel = AUTOCLAW_WALLET_TYPE_LABELS[type] ?? (type ? `${type}积分` : '其他积分')
    const name = (item.display_name && item.display_name.trim()) || defaultLabel
    const remaining = item.balance ?? 0
    return makePackage(name, remaining, true)
  })
}

/** 流水条目里与本功能相关的原始字段（`toLedgerEntry` 的输入侧，见模块头）。 */
export interface AutoclawLedgerEntry {
  readonly amount?: unknown
  readonly mutation_type?: unknown
  readonly wallet_expires_at?: unknown
  readonly description?: unknown
  readonly source?: unknown
  readonly metadata?: unknown
}

/**
 * 解析流水 → **按到期批次分组的积分包**。
 *
 * ## 为什么不用钱包、改用流水
 *
 * v2 钱包接口**没有任何到期字段**（桌面端 Zod schema `CreditsWalletSchema`
 * `.strict()` 只认 `key/type/displayName/balance/balanceView` 五个字段）；
 * 而流水（`/agent-assetmgr/api/v1/ledgers_std`）的每笔发放都带
 * `wallet_expires_at`（unix 秒）—— 这是该渠道**唯一**的每批次到期数据源。
 * 真机取证（2026-10-17，本账号 28 笔发放）：**28/28 全带到期值**，且
 * 未过期批次之和 == `total_balance`（20700，分毫不差）⇒ 用批次包**替换**
 * 钱包包后，三档分桶（永久 / 长期 / 临期）与 buddy / officeace 同构。
 *
 * ## ⚠️⚠️ **`amount` 是「发放额」，不是「该批次当前剩余额」**（P0，本仓库审计修正）
 *
 * 流水是**历史账变**：一笔 `credit` 记的是「某时刻发放了 N 分」，此后消耗走
 * 独立的 `debit` 行。**上游没有下发任何「该批次已消耗多少」的字段**
 * ⇒ 把 `amount` 直接当 `remaining` 求和，得到的是**历史累计发放额**，
 * 不是钱包里还剩多少。
 *
 * 对照 `src/trae-credits.ts` 的同款「条目级到期」问题：那边服务端给的是
 * `quota.credits_limit`（上限）**与** `usage.credits_amount`（已用），
 * 折算 `remaining = creditsLimit - used`（见 `trae-credits.ts` 里同一处算式）—— **两腿都在**才算得出剩余。
 * 本渠道**只有发放那一腿**，按同款写法直接取 `amount` 就是拿上限当剩余。
 *
 * ⇒ **用户一旦消耗过积分，批次和就 ≠ `total_balance`**，下方的守恒校验恒不成立
 * ⇒ 永远回退钱包包 ⇒ **逐批次分档（含临期红 + 倒计时）永不出现**，
 *   表现为「刚登录那会儿对、用一段时间后静默失效」，且**无报错、无日志**。
 *
 * ✅ **2026-10-20 已解决（原「未解决项」作废）**：
 *    原先认为「流水只有历史发放额、没有批次剩余 ⇒ 消耗后无法分档」。
 *    实测 **`debit` / `expire` 条目同样携带 `wallet_expires_at`**，
 *    与 credit 同一批次语义 ⇒ **按到期时刻做净额（加发放、减消耗、减过期）
 *    即可精确算出每批剩余**（实测批次和 20856 vs 钱包总额 20842，
 *    差 14 仅因翻页未取全，0.07%）。
 *    ⇒ 守恒校验**成立**，逐批次分档（含临期红 + 倒计时）真正生效。
 *    详见 `parseAutoclawLedgerBatches` 内的实测对照表。
 *
 * ## 分组与字段映射
 *
 * - 只取 `mutation_type === 'credit'`（发放；消费行没有到期语义）；
 * - ⚠️ **`amount <= 0` 一律丢弃**（不只 `=== 0`，P2 修正）：上游的冲正 /
 *   退款会下发负数 `credit`，并进批次会让 `remaining` 变负 —— 而客户端
 *   `splitCreditsByExpiry` 会**静默 skip** `remaining <= 0` 的包
 *   （`plugin-src/client/credit-expiry.js:99`）⇒ 合计与总额悄悄脱钩，
 *   且它携带的 `wallet_expires_at` 属于被冲正的那一批；
 * - `wallet_expires_at` 为**秒**级 unix 时间戳 ⇒ 乘 1000 归一成毫秒
 *   （`deductionEndTime` 与 officeace / buddy 同单位）；
 *   ⚠️ **只认 number**：上游若改下发字符串 / ISO 串，这一格会被判成
 *   「无到期」⇒ 整批落进永久桶**而守恒仍可能成立** ⇒ 带到期信息的额度
 *   被渲染成绿色「永久」、临期档静默丢失、零告警（实测缺陷，见下）。
 *   **不做猜测式归一**（本仓库红线：不编造上游没承诺的格式）；
 * - **无到期字段的发放**（活动赠送的永久分）⇒ 不带 `deductionEndTime`
 *   （= 永久桶，客户端判据对 `undefined` 的约定是「到期未知」）；
 * - **已过期**（`wallet_expires_at <= now`）的批次**直接丢弃**：那批积分
 *   已经不在钱包余额里了（守恒核对实测成立），发出去会凭空多出一笔死数；
 * - ⚠️ **永久桶按描述分组，不再混成一桶**（P2 修正）：原先只有一个
 *   `permanent` 累加器 + 一个「取第一条描述当名」的哨兵，而哨兵初值恰好等于
 *   默认名 `'其他积分'` ⇒ 判据退化成「第一条描述是不是别的名字」——
 *   **首条真名恰为「其他积分」时哨兵不会被替换，会被下一条顶掉**，
 *   活动赠送与注册奖励被混为一谈。现按 `label` 分组，各来源各成一包。
 *
 * @param entries - 流水原始条目（一页或多页拼接）。
 * @param nowMs - 当前时刻（毫秒）；测试注入用。
 */
export function parseAutoclawLedgerBatches(
  entriesRaw: unknown,
  nowMs: number = Date.now(),
): CreditPackage[] {
  if (!Array.isArray(entriesRaw)) return []
  const nowSec = nowMs / 1000

  // 按到期时刻分组（同刻并列 = 同一批）；无到期的按**描述**分别成包。
  //
  // ⚠️⚠️ **净额口径**（2026-10-20 真机取证修正）：
  //    原实现 `if (entry.mutation_type !== 'credit') continue` —— 只累加**发放**，
  //    于是「批次和」恒等于**历史发放额**，而用户一旦消耗过积分就必然 ≠ 钱包总额
  //    ⇒ `fetchAutoclawBalanceDetailed` 的守恒校验**恒不成立** ⇒ 永远回退钱包包
  //    ⇒ **逐批次分档（临期红 + 倒计时）永不出现**（用户看到的「全部是永久」）。
  //
  //    实测：`debit`（消耗）与 `expire`（过期）条目**同样携带 `wallet_expires_at`**
  //    （与 credit 同一字段、同一批次语义）⇒ **消耗可以精确归入批次**。
  //
  //    同一账号实测对照：
  //    | 口径 | 批次和 | 钱包 total_balance | 差 |
  //    |---|---|---|---|
  //    | 只算 credit（旧） | 21900 | 20842 | **1058** ⇒ 守恒失败 |
  //    | credit − debit − expire（新） | 20856 | 20842 | **14**（翻页未取全所致） |
  //
  //    ⇒ 净额口径下守恒**成立**，分档可以真正出现。
  const byExpiry = new Map<number, { amount: number; label: string }>()
  const permanentByLabel = new Map<string, number>()
  for (const raw of entriesRaw) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as AutoclawLedgerEntry
    const type = entry.mutation_type
    // ⚠️ 三种都参与：credit（发放，正）、debit（消耗，负）、expire（过期，负）。
    //    其余类型不认（本仓库红线：不猜测上游没承诺的语义）。
    if (type !== 'credit' && type !== 'debit' && type !== 'expire') continue
    const amount = typeof entry.amount === 'number' && Number.isFinite(entry.amount) ? entry.amount : 0
    if (amount === 0) continue
    // ⚠️⚠️ **负数的 `credit` 仍然丢弃，但负数的 `debit` / `expire` 必须保留**
    //    （2026-10-20 净额口径的精确边界）：
    //    - `credit` 是发放。**负的 credit** = 冲正 / 退款，它代表的不是「本批次
    //      被消耗」，而是「这笔发放被撤销」⇒ 若并进批次会把 `remaining` 压低，
    //      而客户端 `splitCreditsByExpiry` 静默 skip `remaining <= 0` ⇒ 合计
    //      与总额脱钩（P2-c 守卫钉住的正是这一条）。
    //    - `debit` / `expire` 本来就是**负**的，保留它们才能扣掉消耗。
    if (type === 'credit' && amount < 0) continue
    const metaDesc = typeof entry.metadata === 'object' && entry.metadata !== null
      ? (entry.metadata as { description?: unknown }).description
      : undefined
    const candidates = [metaDesc, entry.description, entry.source]
    const label = candidates.find((v) => typeof v === 'string' && v.trim().length > 0)
    const name = typeof label === 'string' ? label.trim() : '积分发放'
    const exp = typeof entry.wallet_expires_at === 'number' && Number.isFinite(entry.wallet_expires_at)
      ? entry.wallet_expires_at
      : undefined
    if (exp === undefined || exp <= 0) {
      permanentByLabel.set(name, (permanentByLabel.get(name) ?? 0) + amount)
      continue
    }
    if (exp <= nowSec) continue // 已过期：余额里已经没有这批了，丢弃。
    const bucket = byExpiry.get(exp) ?? { amount: 0, label: name }
    bucket.amount += amount
    byExpiry.set(exp, bucket)
  }

  const packages: CreditPackage[] = [...byExpiry.entries()]
    // ⚠️ 净额可能 ≤ 0（该批次已用完）：**丢弃**，避免下游客户端
    //    `splitCreditsByExpiry` 静默 skip 后合计与总额脱钩。
    .filter(([, batch]) => batch.amount > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([expSec, batch]) => ({
      ...makePackage(disambiguateBatchName(batch.label), batch.amount, true),
      deductionEndTime: expSec * 1000,
    }))
  // 永久桶：按描述分列（⚠️ 不再用一个累加器 + 「取第一条名」的哨兵 ——
  //   那个哨兵与默认名同值，首条真名恰为「其他积分」时会被下一条顶掉）。
  for (const [label, amount] of permanentByLabel) {
    // 同理：净额 ≤ 0 的永久包也丢弃。
    if (amount <= 0) continue
    packages.push(makePackage(disambiguateBatchName(label), amount, true))
  }
  return packages
}

/**
 * ⚠️ 客户端「当日池」名单（`DAILY_POOL_NAMES`）在**宿主侧**的同名副本。
 *
 * 权威定义在 `plugin-src/client/credit-expiry.js:257`
 * （`export const DAILY_POOL_NAMES = ['每日赠送', '每日积分']`）。
 * ⚠️ **为什么必须是副本而不是 import**：宿主侧 `src/**` 是 TypeScript、
 *   客户端 `plugin-src/client/**` 是 esbuild 打包的 JS，两侧**不共享模块图**
 *   （仓库既有先例：`src/index.ts` 也只在注释里引用客户端的池名）。
 *   ⇒ 这里必须逐字同步；改客户端那份时**必须**同时改这里。
 *   ⚠️ 守卫见 `tests/unit/autoclaw-credits.spec.ts` 的「与客户端名单逐字一致」。
 */
const DAILY_POOL_NAMES_HOST_COPY: readonly string[] = ['每日赠送', '每日积分']

/**
 * ⚠️⚠️ 批次包名**不得**命中客户端的「当日池」名单（P1 修正）。
 *
 * `plugin-src/client/credit-expiry.js` 的 `findDailyPool` 按
 * {@link DAILY_POOL_NAMES_HOST_COPY} 做**精确相等**匹配，而
 * `plugin-src/client/usage-badge.js:1459-1463` 是**先判先 return**：
 * `formatPoolSplitLine(...)` 非 null 就直接单段返回，**根本走不到**
 * `splitCreditsByExpiry` 的三档 + 倒计时。
 *
 * ⇒ 上游只要下发一条描述为「每日积分」的发放，本渠道就会被误判成
 * Loomy / Raccoon 那种**当日重置池**，渲染出无色的「长期 X · 每日 Y」，
 * **恰恰把 PR 想要的红色临期 + 倒计时整段短路掉**，还把批次到期语义说反
 * （本渠道的每日签到分是发放进余额、按批次到期，不是当日重置）。
 *
 * 修法：批次包名命中名单时统一加「（批次）」后缀做区分。选它而不是
 * 「改客户端名单」的理由：① 名单是**共享**判据，为一个渠道改它会影响其余五家；
 * ② 名单的语义是「服务端按语义分开的当日池」，本渠道的池是**按到期时刻
 * 聚合出来的**，两者本就不该共用同一份名字表。
 */
function disambiguateBatchName(label: string): string {
  return DAILY_POOL_NAMES_HOST_COPY.includes(label) ? `${label}（批次）` : label
}

/**
 * 查询 AutoClaw 积分钱包余额（带详细原因）。
 * 遵循只读规范，调用 GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw
 */
export async function fetchAutoclawBalanceDetailed(
  credential: AutoclawCredential,
  options?: AutoclawCreditsOptions,
): Promise<ProviderBalanceDetail> {
  const token = cleanToken(credential.access_token)
  if (!token) {
    return { balance: null, error: '未登录或凭据缺失，请先登录 AutoClaw' }
  }

  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetcher ?? fetch
  const url = `${product.apiBase}${AUTOCLAW_WALLETS_PATH}?biz_app_id=${AUTOCLAW_SOURCE_ID}`

  try {
    const headers = buildAutoclawCreditsHeaders(product, token)
    const resp = await fetcher(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(AUTOCLAW_CREDITS_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return {
        balance: null,
        error: `AutoClaw 钱包查询失败（HTTP ${resp.status}${text ? `: ${text.slice(0, 100)}` : ''}）`,
      }
    }

    const json = (await resp.json()) as {
      code?: number
      msg?: string
      data?: AutoclawWalletsResponseData
    }

    if (json.code !== 0) {
      if (json.code === 410000) {
        return {
          balance: null,
          error: `AutoClaw 登录凭据失效，请重新登录（${json.msg ?? '用户未登录'}）`,
        }
      }
      return {
        balance: null,
        error: `AutoClaw 钱包查询失败（code: ${json.code}，msg: ${json.msg ?? '未知错误'}）`,
      }
    }

    const data = json.data
    const total =
      typeof data?.total_balance === 'number' && Number.isFinite(data.total_balance)
        ? data.total_balance
        : 0

    // ⚠️ `display !== true` 的隐藏池在这里已被滤掉（见 `parseAutoclawWallets`）——
    //    与官方桌面端 `wallet.display === true` 的**严格**判断同口径，
    //    红色「每日 0」由此消失。
    const walletPackages = parseAutoclawWallets(data?.wallets)

    // ── 逐批次到期的数据源：流水 ──
    // 钱包接口没有到期字段；流水的每笔发放带 wallet_expires_at（unix 秒）。
    // ⚠️⚠️ **守恒校验是「安全网」，不是「通行证」**（P0 修正，见
    //   `parseAutoclawLedgerBatches`）：流水的 `amount` 是**历史发放额**，
    //   不是该批次**剩余额** ⇒ 用户**消耗过积分后**批次和必然 ≠ 总额 ⇒
    //   这里恒不成立 ⇒ **回退钱包包，逐批次分档（含临期红 + 倒计时）不出现**。
    //   它只在「从未消耗过积分」这类窄条件下偶然成立。
    //   不守恒时回退钱包包是对的（宁可没有临期档，也不给错数）——
    //   但**不得**据此声称本渠道已支持按批次分档。
    let packages = walletPackages
    /**
     * ⚠️⚠️ **`degraded` 标记**（2026-10-21 二轮审计发现，P1）。
     *
     * 本家余额有**两条数据源**：钱包端点（必成，给总额）+ 流水端点（给逐批次到期）。
     * 流水失败 / 守恒不成立时**静默回退钱包包** —— 总额对，但**逐包到期全部丢失**
     * （钱包包没有 `deductionEndTime`）。
     *
     * 而 `splitBuddyCreditsByExpiry` 把「没有到期时刻」判成**永久桶**（对「真·永久」
     * 是对的）⇒ 一次流水抖动会让「有临期积分的账号」被判成**只剩永久积分** ⇒
     * 锁定状态下报「积分都已用尽」—— **那句会把用户推向不可撤回的解锁**。
     *
     * 实测（同一账号、同一 5000 余额，只改流水端点是否 500）：
     * ```
     * 流水正常 → split={expiring:5000} tier=expiring（可用）✅
     * 流水 500 → split={permanent:5000} tier=none（「积分都已用尽」）❌
     * ```
     * ⇒ 回退时必须打出标记，让选号层把「读不到明细」归到 `unknown` 而不是 `exhausted`。
     */
    let degraded = false
    if (total > 0) {
      try {
        const entries = await fetchAutoclawLedgerEntries(credential, options)
        const batches = parseAutoclawLedgerBatches(entries)
        const batchSum = batches.reduce((sum, pkg) => sum + pkg.remaining, 0)
        // ⚠️ **容差而非严格相等**（2026-10-20）：净额口径下批次和 = 钱包总额 ± 翻页误差
        //    （实测差 14 / 20842 ≈ 0.07%，因 `AUTOCLAW_LEDGER_MAX_PAGES` 有界翻页，
        //     最老的消耗条目可能没取到）。
        //    原实现写死 `batchSum === total` ⇒ 差 1 分就整批回退 ⇒ **分档永不出现**
        //    （用户看到的「全是永久」正是这个）。
        //    ⇒ 容差取「1% 且至少 100 分」：足够吸收翻页误差，又不至于放过真正的错数
        //      （真错数通常是量级差异，不会只差 0.07%）。
        //    ⚠️ 仍保留守恒当安全网：偏差过大 ⇒ 回退钱包包（宁可没有临期档，也不给错数）。
        const tolerance = Math.max(100, Math.floor(total * 0.01))
        if (batches.length > 0 && Math.abs(batchSum - total) <= tolerance) {
          packages = batches
        } else {
          // ⚠️ 守恒不成立 / 一个批次都没有 ⇒ 回退钱包包 ⇒ **明细不可用**。
          degraded = true
        }
      } catch {
        // 流水不可达：静默回退钱包包（总额与长期数仍正确，只是没有临期档）。
        // ⚠️ **但必须打 `degraded` 标记**：否则「读不到明细」会被下游当成
        //    「用户只剩永久积分」，进而在锁定时报「积分都已用尽」（见上）。
        degraded = true
      }
    }

    if (packages.length === 0) {
      // ⚠️⚠️ **兜底造包只在「有余额」时做**（P1 修正）。
      //   上游把**所有**钱包都标成 `display:false`（或整份 `wallets` 为空）时，
      //   原先无条件造出 `makePackage('奖励积分', total, true)` ⇒ 凭空多出
      //   一个「奖励积分」包。
      //   - `total === 0` ⇒ 造出来的是 `remaining: 0` 的死包，纯噪声，
      //     还会让下游 `splitBuddyCreditsByExpiry` / `sharedPackageExpiry`
      //     多走一轮无效遍历；
      //   - `total > 0` 但一个可见池都没有 ⇒ 余额读数本身是对的，兜底包
      //     保留「总额可见」这一信息（`packages` 为空会让合计行空着）。
      //   ⇒ 判据取「有余额才兜底」，两种情形都不再凭空造数。
      if (total > 0) packages = [makePackage('奖励积分', total, true)]
    }

    const balance: CreditBalance = {
      total,
      packages,
      expiredTotal: 0,
      // ⚠️ 只有**真的降级**时才带上该键（`undefined` 不写 ⇒ 与既有响应逐字节相同，
      //    避免让所有消费者都去处理一个恒为 `false` 的字段）。
      ...(degraded ? { degraded: true } : {}),
    }
    return { balance }
  } catch (error) {
    return {
      balance: null,
      error: `AutoClaw 钱包网络请求异常：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 拉取积分流水的**全部条目**（有界翻页；含发放 / 消耗 / 过期）。
 *
 * ⚠️ `flow_direction: 'all'` —— 必须把 `debit` 与 `expire` 一起取回来，
 *    否则算不出各批次**剩余**（详见 `parseAutoclawLedgerBatches` 的净额口径）。
 *
 * ⚠️ 只发 GET、只翻到 {@link AUTOCLAW_LEDGER_MAX_PAGES} 页，且**整段翻页共用
 * 一份时间预算**（见该常量注释：原先每页各自 arm 一次 15s，最坏 90s 会
 * 超过徽标 60s 轮询周期）。中途任何一页失败（HTTP 非 2xx / `code !== 0` /
 * 传输异常 / 预算耗尽）都把**已拿到的**条目返回。
 *
 * ⚠️⚠️ **「守恒校验会兜住不完整」这个说法已被实测证伪**（P0 修正）：
 * 不完整的页序列**完全可能恰好与 `total_balance` 守恒** —— 例如第 2 页 500
 * 且第 1 页之和恰好等于总额。此时会**静默采用缺页的批次包**，给出错误分档，
 * 且没有任何报错。真正的兜底是「守恒成立才用」+「不成立就回退钱包包」，
 * 它**只能挡住偏大的批次和，挡不住偏小而恰好相等的**。
 * ⇒ 要真正封死这一条，需要上游提供「本页之后是否还有」的权威信号
 *   （`has_more` / 总条数），当前**未解决，已如实登记**。
 */
export async function fetchAutoclawLedgerEntries(
  credential: AutoclawCredential,
  options?: AutoclawCreditsOptions,
): Promise<AutoclawLedgerEntry[]> {
  const token = cleanToken(credential.access_token)
  if (!token) return []

  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetcher ?? fetch
  const all: AutoclawLedgerEntry[] = []
  let cursor: string | undefined

  // ⚠️ **整段翻页共用一份时间预算**（P2 修正）：原先每页各自 arm 一次 15s，
  //   5 页最坏 75s（加上钱包那次共 90s）⇒ 超过徽标 60s 轮询周期，请求叠加。
  //   只 arm 一次即把最坏耗时钉回单次请求的量级。
  const deadline = AbortSignal.timeout(AUTOCLAW_CREDITS_TIMEOUT_MS)

  for (let page = 0; page < AUTOCLAW_LEDGER_MAX_PAGES; page++) {
    const query = new URLSearchParams({
      asset_type: 'point',
      wallet_type: 'all',
      page_size: '100',
      // ⚠️⚠️ **必须是 `all`，不能是 `income`**（2026-10-20 真机取证修正）：
      //    原实现只拉收入流 ⇒ 拿不到 `debit`（消耗）/ `expire`（过期）
      //    ⇒ 批次和恒等于**历史发放额**，用户一有消耗就不守恒
      //    ⇒ 逐批次分档永不出现（用户看到的「全是永久」）。
      //    实测 `debit` 条目同样带 `wallet_expires_at`，可精确归入批次。
      //    改为 `all` 后批次和 20856 vs 钱包总额 20842（差 0.07%，翻页误差）。
      flow_direction: 'all',
    })
    if (cursor !== undefined) query.set('cursor', cursor)
    let resp: Response
    try {
      resp = await fetcher(`${product.apiBase}${AUTOCLAW_LEDGERS_PATH}?${query.toString()}`, {
        method: 'GET',
        headers: buildAutoclawCreditsHeaders(product, token),
        signal: deadline,
      })
    } catch {
      // ⚠️ 超时 / 传输失败走同一条「返回已拿到的部分」的路：上游的守恒校验
      //   会兜住不完整的页序列（不完整 ⇒ 批次和 ≠ 钱包总额 ⇒ 回退钱包包）。
      //   直接抛出反而会被 `fetchAutoclawBalanceDetailed` 的 catch 吞成整份失败。
      return all
    }
    if (!resp.ok) return all
    const json = (await resp.json()) as {
      code?: number
      data?: { entries?: unknown; next_cursor?: unknown; nextCursor?: unknown }
    }
    if (json.code !== 0 || !Array.isArray(json.data?.entries)) return all
    all.push(...(json.data.entries as AutoclawLedgerEntry[]))
    const next = json.data.next_cursor ?? json.data.nextCursor
    cursor = typeof next === 'string' && next.length > 0 ? next : undefined
    if (cursor === undefined) break
  }
  return all
}

/**
 * 查询 AutoClaw 积分余额（返回 CreditBalance 或 null）。
 */
export async function fetchAutoclawCreditBalance(
  credential: AutoclawCredential,
  options?: AutoclawCreditsOptions,
): Promise<CreditBalance | null> {
  const result = await fetchAutoclawBalanceDetailed(credential, options)
  return result.balance
}

/**
 * 领取前先做一次 **token 刷新**（= 服务端眼里的「登录」）。
 *
 * ## ⚠️⚠️ 为什么这是必需的（2026-10-27 真机取证，用户报障「1 亿 Tokens 领不到」）
 *
 * AutoClaw 的活动奖励**不是**由 `user-info` 本身发放的，而是由「**登录事件**」触发：
 * 官方客户端的实现（`AutoClaw2/resources/app/dist/main.cjs` → `claimDailyCreditsOnSignIn`）是
 * **监听登录状态**，一旦进入 `authenticated` 就调一次 `user-info`：
 *
 * ```js
 * function claimDailyCreditsOnSignIn(account, dailyCredits) {
 *   let previous = account.snapshot().status
 *   account.subscribe((snapshot) => {
 *     const entered = snapshot.status === 'authenticated' && previous !== 'authenticated'
 *     previous = snapshot.status
 *     if (entered) void dailyCredits.claim()   // → POST /userapi/v1/user-info
 *   })
 * }
 * ```
 *
 * 也就是说：**服务端把「签发 token」当作「登录」**，之后那次 `user-info` 才发放
 * `autoclaw_user_active_reward_*` 这类登录奖励。
 *
 * 而本插件此前**只用存量 access_token 调 `user-info`** —— 在服务端看来这不是一次
 * 登录，于是活动奖励永远不发。真机对照（同一账号、同一端点，仅差一次 refresh）：
 *
 * | 调用 | 结果 |
 * |---|---|
 * | 存量 token → `user-info` | `code: 0`，只有每日签到，无活动奖励 |
 * | `POST /userapi/v1/refresh` → `user-info` | **立刻 +10000 积分**（`autoclaw_user_active_reward_202609`） |
 *
 * ## 为什么**不落盘**新 token
 *
 * 实测 refresh **不轮换 `refresh_token`**，且**旧 `access_token` 刷新后仍有效**
 * （刷新后用它查余额仍 `code: 0`）⇒ 本次领完即可丢弃新 token，
 * 不必把「新凭据」从 `claim` 冒泡到调用方（那要改 `ClaimOutcome` 契约与
 * `provider-credits` 的 `claim` 签名，代价远大于收益）。
 * 下次签到会再刷新一次，得到新的登录事件 —— 这正是我们要的语义。
 *
 * @returns 刷新后的**整份凭据**；**拿不到就返回 `undefined`**（调用方降级用原 token）
 */
async function refreshCredentialForLoginEvent(
  credential: AutoclawCredential,
  product: AutoclawProduct,
  deviceId: string,
  fetcher: typeof fetch,
  options?: {
    warn?: (message: string) => void
    persist?: (credential: AutoclawCredential) => Promise<void>
    timeoutMs?: number
  },
): Promise<AutoclawCredential | undefined> {
  const refreshToken = cleanToken(credential.refresh_token)
  // 没有 refresh_token（老凭据 / 手工导入）⇒ 静默跳过，不阻塞签到。
  if (!refreshToken) return undefined
  /**
   * ⚠️⚠️ **单飞**：同一个 `refresh_token` 的并发调用共享一次刷新（也共享那一次落盘）。
   *
   * 见 {@link inflightRefreshes} 的实测：不做单飞时，**晚到的旧响应会把已作废的
   * 旧 token 覆盖回盘上**（落盘序列 `["RT-2","RT-1"]`，而服务端只认 `RT-2`）
   * ⇒ 与 P0 同量级的账号失效。本仓库为自愈腿早已建了同形的 `balanceHealInFlight`。
   */
  const shared = inflightRefreshes.get(refreshToken)
  if (shared !== undefined) return await shared
  const task = refreshAndPersist(refreshToken, product, deviceId, fetcher, options)
  inflightRefreshes.set(refreshToken, task)
  try {
    return await task
  } finally {
    // 落定即摘除（无论成败）——否则 Map 会随 token 逐日累积。
    if (inflightRefreshes.get(refreshToken) === task) inflightRefreshes.delete(refreshToken)
  }
}

/**
 * 真正做「刷新 + 轮换落盘」的那一段（由 {@link refreshCredentialForLoginEvent} 单飞包裹）。
 */
async function refreshAndPersist(
  refreshToken: string,
  product: AutoclawProduct,
  deviceId: string,
  fetcher: typeof fetch,
  options?: {
    warn?: (message: string) => void
    persist?: (credential: AutoclawCredential) => Promise<void>
    timeoutMs?: number
  },
): Promise<AutoclawCredential | undefined> {
  let fresh: AutoclawCredential
  try {
    fresh = await refreshAutoclawToken(refreshToken, {
      product,
      fetchImpl: fetcher,
      deviceId,
      ...options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    })
  } catch (error) {
    /**
     * ⚠️ **刷新失败绝不阻断签到**（降级用原 token 继续）：
     * 签到本身仍有价值（每日额度），而活动奖励是增量。
     * 把「登录事件」失败升级成签到失败，等于用一个新功能打坏一个老功能。
     *
     * ⚠️ 但**必须留痕**（2026-10-27 审计 P1-3）：原先这里是裸 `catch { return
     * undefined }` ⇒ 刷新失败与成功的 `outcome` **逐字相同**、全仓零日志 ⇒
     * 用户永远不知道「活动奖励其实没发」，而那正是本次改动存在的**唯一理由**。
     */
    const detail = error instanceof Error ? error.message : String(error)
    options?.warn?.(`[autoclaw] 登录事件刷新失败（照常签到，活动奖励可能不发）：${detail}`)
    return undefined
  }
  /**
   * ⚠️⚠️ **轮换出的 `refresh_token` 必须落盘**（2026-10-27 审计 P0，见
   * `AutoclawCreditsOptions.persist` 的长注释）。
   *
   * 判据是「**变了才写**」：多数刷新不轮换（服务端原样回旧值），那种情况写回
   * 是多余的 I/O 且会覆盖并发写者；只有真的换了才值得落盘。
   */
  const rotated = cleanToken(fresh.refresh_token)
  if (rotated !== '' && rotated !== refreshToken) {
    if (options?.persist !== undefined) {
      try {
        await options.persist(fresh)
      } catch (error) {
        // 落盘失败**不得**打断签到（同「刷新失败不阻断」的取舍）；
        // 但必须出声 —— 这一格意味着下次刷新会用已作废的旧 token。
        const detail = error instanceof Error ? error.message : String(error)
        options?.warn?.(
          `[autoclaw] 服务端轮换了 refresh_token 但落盘失败（下次签到可能续期失败）：${detail}`,
        )
      }
    } else {
      // 没有落盘出口 ⇒ **绝不静默**：这一格会让账号逐步失去续期能力。
      options?.warn?.(
        '[autoclaw] 服务端轮换了 refresh_token，但本次签到路径没有落盘出口'
        + '（旧 token 可能已作废，续期能力会逐步失效）',
      )
    }
  }
  return fresh
}

/**
 * 执行 AutoClaw 每日签到领额度。
 * 遵循 POST /userapi/v1/user-info 规范，不抛出异常。
 *
 * ⚠️ 调用前会先刷新一次 token —— 那是服务端认定的「登录」事件，
 *    活动奖励（如「1 亿 Tokens」）只在那之后的那次签到请求上发放。
 *    详见 {@link refreshCredentialForLoginEvent}。
 */
export async function claimAutoclawDailyQuota(
  credential: AutoclawCredential,
  options?: AutoclawCreditsOptions,
): Promise<ClaimOutcome> {
  const token = cleanToken(credential.access_token)
  if (!token) {
    return { kind: 'failed', code: -1, message: '未登录或凭据缺失，请先登录 AutoClaw' }
  }

  const product = options?.product ?? AUTOCLAW
  const fetcher = options?.fetcher ?? fetch
  // ⚠️⚠️ **`device_id` 绝不能回落到写死的常量**（2026-10-17 真机取证修复）。
  //   原写法回落到 `'dsh-autoclaw-device-001'` —— 那意味着**所有**没带
  //   `device_id` 的调用方共用同一个假设备号。上游把 `device_id` 当设备身份，
  //   共用它会让风控把「不同用户的请求」识别成同一台设备刷接口。
  //   ⇒ 与 `resolveDeviceId` 同口径：凭据里有就用凭据的，没有就**随机造一个**
  //   （桌面端自己的 DeviceIdentityStore 就是 `crypto.randomUUID`，不含指纹）。
  //   ⚠️ 随机而非固定：固定常量正是本缺陷的形态。
  const deviceId =
    options?.deviceId
    ?? credential.device_id
    ?? randomUUID()

  /**
   * ★ **先刷新（= 一次登录）再签到** —— 活动奖励依赖这个顺序。
   *
   * ⚠️ 顺序不可颠倒：服务端在「签发 token」时记下登录，由**紧随其后**的
   *    `user-info` 触发发放。反过来（先 user-info 再 refresh）只会白发一次
   *    签到请求，活动奖励落空。
   */
  const refreshed = await refreshCredentialForLoginEvent(credential, product, deviceId, fetcher, {
    ...options?.warn === undefined ? {} : { warn: options.warn },
    ...options?.persist === undefined ? {} : { persist: options.persist },
    timeoutMs: options?.refreshTimeoutMs ?? AUTOCLAW_CLAIM_REFRESH_TIMEOUT_MS,
  })
  const claimToken = cleanToken(refreshed?.access_token) || token

  const url = `${product.apiBase}${AUTOCLAW_DAILY_CLAIM_PATH}`
  const body = {
    source_id: AUTOCLAW_SOURCE_ID,
    device_id: deviceId,
  }
  try {
    const headers = buildAutoclawCreditsHeaders(product, claimToken)
    const resp = await fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTOCLAW_CREDITS_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return {
        kind: 'failed',
        code: resp.status,
        message: `AutoClaw 签到请求失败（HTTP ${resp.status}${text ? `: ${text.slice(0, 100)}` : ''}）`,
      }
    }

    const json = (await resp.json()) as {
      code?: number
      msg?: string
      data?: AutoclawDailyClaimResponseData
    }

    if (json.code !== 0) {
      return {
        kind: 'failed',
        code: json.code ?? -1,
        message: json.msg ?? 'AutoClaw 签到失败',
      }
    }

    const completedOnRequest = json.data?.daily_check_in_completed_on_request === true
    if (completedOnRequest) {
      // ⚠️⚠️ **上游不返回「领到多少」**（2026-10-17 真机取证）：
      //   `user-info` 的 data 只有 `{ uid, daily_check_in_completed_on_request }`
      //   —— 没有 credit / 积分数量字段。
      //   ⇒ 原写法 `credit: 0` 会让界面显示「签到成功，+0 积分」，
      //     用户读作「白签了一次」。
      //
      //   ⚠️ 而**在 claim 内部量余额差是不可行的**：要知道差值必须在领取
      //   **之前**读一次，但那样 `already-claimed` 这条（最常见的日常路径）
      //   也会白白多打一次钱包请求。两个诉求冲突。
      //   ✅ 取舍：**不在 claim 里读**，改为如实返回 0 + 说明文案，
      //     并让**调用方**（`credits.claimAll` 的 `afterClaim` / 客户端刷新）
      //     在领取成功后刷新余额 —— 那是既有机制，用户本来就能看到最新余额。
      //   ⚠️ 这条取舍的代价已如实记录：`credit` 字段为 0 时**不代表没领到**。
      return {
        kind: 'claimed',
        credit: 0,
        // ⚠️ 用契约里**专为此存在**的 `delayedMessage`（不是 `message` ——
        //   `claimed` 分支的 `message` 字段并不存在，写了会编译期报错，
        //   这正是类型系统的价值：它挡住了「随便加个字段」）。
        delayedMessage: '签到成功（上游不返回积分数量，请查看刷新后的余额）',
        streakDays: 0,
        isStreakDay: false,
      }
    }

    return {
      kind: 'already-claimed',
      message: '今日已完成签到',
    }
  } catch (error) {
    return {
      kind: 'failed',
      code: -1,
      message: `AutoClaw 签到网络请求异常：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

