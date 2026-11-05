/**
 * Qoder 积分余额查询与每日领取。
 *
 * ## 与前四个 provider 的差异
 *
 * Qoder 的用量接口**不需要 WASM 签名** —— 只需 `Bearer` + `Cosy-ClientType`
 * 头（源码 `Bx()`）。这一点与模型列表端点（`/api/v2/model/list`，需签名）
 * **不同**，早期因为只按 `/api/` 前缀搜索而误判「Qoder 无积分端点」。
 *
 * ## 端点与实测响应（2026-09-19，真实凭据）
 *
 * ```
 * GET {openApiBase}/sash/api/v2/me/usage
 * Authorization: Bearer <token>
 * Cosy-ClientType: 5
 * ```
 *
 * ```json
 * { "displayMode": "qoder",
 *   "qoderUsage": {
 *     "userType": "personal_standard",
 *     "userQuota":  { "total": 0,   "used": 0, "remaining": 0,   "unit": "credits" },
 *     "addOnQuota": { "total": 100, "used": 0, "remaining": 100, "unit": "credits" },
 *     "expiresAt": 253402214400000 } }
 * ```
 *
 * ⚠️ **余额不只在 `userQuota` 里**：实测该账号 `userQuota.remaining = 0`
 * 而 `addOnQuota.remaining = 100`（用户所说的「资源包 100 积分」正是后者）。
 * 只读 `userQuota` 会显示 0 —— 与其它 provider 的「漏读某一层」是同一类缺陷。
 *
 * ## 每日领取（2026-09-21 由抓包解出，keylog 解密）
 *
 * ```
 * GET  {openApiBase}/sash/api/v1/me/campaigns
 * POST {openApiBase}/sash/api/v1/me/campaigns/{campaignId}/claim   ← body **空**
 * ```
 *
 * 领取响应（实测，`grantedAt` 与 `claimedAt` 相差 200ms）：
 *
 * ```json
 * { "grantId": "01a0c475-d6f8-70de-90b2-d4c8058c554d",
 *   "status": "CLAIMED", "replayed": false,
 *   "benefit": { "kind": "CREDITS", "amount": 100,
 *                "modelScope": { "modelSeries": { "key": "ALL_MODELS" } },
 *                "validity": { "mode": "RELATIVE_DAYS", "days": 30 } },
 *   "campaignId": "01a0bf8d-…", "campaignKey": "act-20260921-308",
 *   "campaignVersion": 1,
 *   "claimedAt": "2026-09-21T14:54:12.176671Z",
 *   "grantedAt": "2026-09-21T14:54:12.393072Z",
 *   "expiresAt": "2026-10-21T14:54:12.176671Z" }
 * ```
 *
 * ⚠️ **幂等判据是响应体的 `replayed:true`**，不是 HTTP 状态码：
 * 重复领取同样返回 **200**，但 `replayed` 为 true、**不含 `benefit`**，
 * 且 `claimedAt` 是**上一次领取的旧时间**（实测 `2026-09-18`，而请求发生在
 * `2026-09-21`）。只看状态码会把「今天已领」误报成「领取成功 +100」。
 *
 * ⚠️ **请求体必须是空串**（抓包里 `content-length: 0`）。源码里领取走
 * `POST` 但无 payload；发 `{}` 之类未经验证的 body 属额外风险，故照实发空。
 *
 * ## 为什么不早做
 *
 * `/sash/api/v1/me/campaigns` 早期实测返回
 * `{"showCampaign":false,"claimable":false,"campaigns":[]}`，据此误判
 * 「Qoder 无签到端点」并把 `dailyCheckin` 登记为 false。真相是**那天已领**；
 * 活动状态是**每日 10:00（UTC+8）刷新**的（响应里
 * `description: "每日 10:00（UTC+8）刷新，领取后 30 天有效"`）。
 */

import { roundCredits, type CheckinStatus, type ClaimOutcome, type CreditBalance, type CreditPackage } from './credits.js'
import { QODER_BILLING_UTC_OFFSET_MS } from './model-queue.js'
import { networkBlockedHint } from './network-hint.js'
import { withQoderMachineHeadersAsync } from './qoder-machine.js'
import { qoderBearerToken, type QoderCredential } from './qoder.js'
import type { QoderProduct } from './qoder-product.js'
import type { ProviderBalanceDetail } from './provider-runtime.js'

/** 用量接口路径（挂 `openApiBase`）。 */
export const QODER_USAGE_PATH = '/sash/api/v2/me/usage'
/** 活动列表路径（挂 `openApiBase`）。 */
export const QODER_CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'

/**
 * Qoder 对 `userQuota`（套餐额度）下发的 **永久哨兵** 到期时刻
 * （毫秒）—— `253402214400000` = `9999-12-31T00:00:00.000Z`。
 *
 * ## 取证：**这不是任何东西的真实到期时刻**
 *
 * 2026-10-20，两个真实 qodercn 账号，`GET {openApiBase}/sash/api/v2/me/usage`
 * （`openApiBase` = `https://openapi.qoder.com.cn`）：
 *
 * ```json
 * { "displayMode": "qoder",
 *   "qoderUsage": {
 *     "userId": "…", "userType": "personal_standard", "usageType": "credits",
 *     "totalUsagePercentage": 0, "isQuotaExceeded": false,
 *     "expiresAt": 253402214400000,
 *     "upgradeUrl": "https://qoder.cn/pricing?client=qoder",
 *     "userQuota":  { "total": 0, "used": 0, "remaining": 0,
 *                     "percentage": 0, "unit": "credits" },
 *     "addOnQuota": { "total": 2000, "used": 0, "remaining": 2000,
 *                     "percentage": 0, "unit": "credits",
 *                     "detailUrl": "https://qoder.cn/account/usage" },
 *     "isPlanQuotaProrated": false } }
 * ```
 *
 * ⚠️ 三个必须分辨的事实（缺一就会把哨兵当到期时刻）：
 * - `expiresAt` 的**语义归属是 `userQuota`（套餐额度）**，**不是** `addOnQuota`，
 *   也**不是**任何一笔逐包到期；
 * - `addOnQuota`（用户截图里「个人资源包 1,900」）**只给聚合标量**
 *   （`total` / `used` / `remaining`）+ 一个 `detailUrl` 网页链接，
 *   **没有任何日期字段**；
 * - `dedicatedResourcePackages` 是**唯一**带真实逐包到期（`expiresAt` 字符串）
 *   的字段，而本机账号实测为 `undefined`。
 *
 * ## 权威旁证（Qoder 官方客户端 asar，来源同一次审计）
 *
 * `D:\Qoder\resources\app.asar` 的 `/out/renderer/assets/index-DDa3WwIe.js`
 * 与 `/out/main/index.js` 里客户端自己的用量面板 `buildUsageItemGroups()`：
 * - 对 `addOnQuota` **只渲染 used/total/remaining，不给任何日期**；
 * - 只有 `userQuota.expiresAt` 走 `renewson`（文案「将于 {{date}} 刷新」，
 *   语义是**订阅刷新日**，不是积分到期）；
 * - `dedicatedResourcePackages` 才走 `expiresOn`（文案「有效期至 {{date}}」）。
 *
 * ⇒ 官方客户端自己就不把 `expiresAt` 当作「这批积分何时作废」。
 *
 * ## ⚠️ 若把它写进 `deductionEndTime` 会发生什么（**可观测后果**）
 *
 * 客户端 `plugin-src/client/credit-expiry.js` 的 `formatPackageExpiry` 会把
 * `253402214400000` 渲染成 **`9999-12-31（约 2900000 天后）`** ——
 * 用户看到的是荒谬文案。反之，**不写** `deductionEndTime` 时
 * `packageExpiryMs` 返回 `null` ⇒ 显示**「长期」**，正是三档分档里
 * 「永久（未知到期）」那一档的展示形态。
 *
 * ⇒ 判据：`expiresAt >= 本常量`，**或**解析出的年份 `>= 9999`（兜住
 *   `9999-01-01`~`9999-12-30` 这类小于常量、但同样是哨兵的取值——
 *   它们落在 `253370764800000`~`253402214399999` 区间）。命中即
 *   **不写** `deductionEndTime`（保守方向：未知到期 ⇒ 永久桶）。
 */
export const QODER_PERMANENT_EXPIRY_MS = 253402214400000

/**
 * 该毫秒值是否是 Qoder 的**永久哨兵**（`9999-12-31` 那一族）。
 *
 * ⚠️ **两条支路共用本判据**（本仓库红线：同一语义只留一份实现）：
 * - 支路 A（`userQuota` 的数字 `expiresAt`）—— `qoderUsage.expiresAt`；
 * - 支路 B（`dedicatedResourcePackages[].expiresAt` 的 ISO 字符串，解析后）。
 *
 * 上一版只判了支路 A，于是支路 B 的哨兵会原样写进 `deductionEndTime` ⇒
 * 客户端渲染「9999-12-31（约 290 万天后）」，且该包被判成 `longTerm`
 * 而不是 `permanent`（锁定时**照样可选** ⇒ 锁定形同虚设）。
 * 详见 `toPackage` 里 `expIsPermanent` 那一段的实测记录。
 *
 * 判据三条（任一命中即哨兵）：
 * 1. `>= QODER_PERMANENT_EXPIRY_MS`（`9999-12-31T00:00:00Z` 及更晚）；
 * 2. 解析出的 **UTC 年份 >= 9999**（兜住 `9999-01-01`~`9999-12-30`，
 *    它们小于上面的常量但同样是哨兵）；
 * 3. 非有限值 —— 返回 `false`（「解析失败」不是哨兵，由调用方按「未知到期」
 *    处理；两者最终都落永久桶，但语义不同，不要混在一个判据里）。
 */
export function isPermanentSentinelMs(ms: number): boolean {
  if (!Number.isFinite(ms) || ms <= 0) return false
  return ms >= QODER_PERMANENT_EXPIRY_MS || new Date(ms).getUTCFullYear() >= 9999
}

/**
 * 每日活动**刷新时刻**（UTC+8 的小时）。来源是服务端自己下发的原文：
 * `description: "每日 10:00（UTC+8）刷新，领取后 30 天有效"`（见文件头）。
 *
 * ⚠️ 它的意义：**刷新之前**查到的活动列表属于「昨天那一轮」——
 * 看到 `CLAIMED` 只能说明昨天领过，**不能**说明今天已领。
 * 这个事实曾经造成过真实损失（见 {@link hasQoderCampaignRefreshedToday}）。
 */
export const QODER_CAMPAIGN_REFRESH_HOUR_UTC8 = 10

/**
 * 「今天的活动列表是否已经刷新」。
 *
 * **必须用算术平移而不是 `Date.getHours()`**：活动按 **UTC+8** 结算，
 * 取本机时区会让用户出差 / 改系统时区时得到错的答案（偏东会提前把当天
 * 记为已处理、真漏领；偏西会一天判两次）。口径与 `model-queue.ts` 的
 * `QODER_BILLING_UTC_OFFSET_MS` 一致，不另立偏移常量。
 */
export function hasQoderCampaignRefreshedToday(nowMs: number = Date.now()): boolean {
  const utc8 = new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS)
  return utc8.getUTCHours() >= QODER_CAMPAIGN_REFRESH_HOUR_UTC8
}

/** 单次请求超时（毫秒）。 */
const QODER_CREDITS_TIMEOUT_MS = 15_000

/**
 * 账号尚未在 Qoder 侧「开通过」时的提示文案。
 *
 * ⚠️ **真实缺陷（用户报障，2026-09-26）**：用本插件经 GitHub 授权**新注册**
 * 的 Qoder 账号，一键签到显示「当前没有可领取的活动」，用户以为是我们没做对
 * （「需要 qoder 登录后在 `~\.qoder` 下建立对应用户的 … 才能正确领取」）。
 *
 * 实测证明**不是设备身份问题**（4 个 uid 经 `runtime-info.exe` 产出**完全相同**
 * 的 token/type，即身份是设备级），而是**该账号在 Qoder 侧确实没有每日领取
 * 活动**。这类账号的活动列表里**只有 `VIEW_DETAILS`、没有 `CLAIM_BENEFIT`**
 * —— 这正是 {@link isQoderNotActivated} 现在的唯一判据（详见该函数的注释；
 * 早先用的 `addOnQuota` 缺失判据已在 IKJSHK 中作废）。
 *
 * 该文案要**可操作** —— 用户看完应知道「去 IDE 登录一次」，而不是面对
 * 「没有可领取的活动」无从下手。
 */
const NOT_ACTIVATED_HINT =
  '该账号尚未在 Qoder 侧开通每日领取（每日 100 Credits）。'
  + '请先用 Qoder 官方客户端登录一次该账号，开通后再回来领取。'

/**
 * 「今天的活动还没刷新」的提示。
 *
 * ⚠️ 必须与 {@link NOT_ACTIVATED_HINT} 区分开：前者是**等一会儿就好**（可重试），
 * 后者要用户去官方客户端操作。判错的代价是方向性的 —— 说成「已领取」会让用户
 * 真的错过今天的额度（2026-10-02 审查 PR !33 定位的缺陷）。
 */
const NOT_REFRESHED_YET_HINT =
  `今天的每日活动尚未刷新（每日 ${QODER_CAMPAIGN_REFRESH_HOUR_UTC8}:00（UTC+8）刷新），`
  + '当前看到的是昨天那一轮，请稍后再来领取。'

/**
 * 判断账号是否「尚未开通每日领取」。
 *
 * ## 判据只用**服务端活动列表**（`/sash/api/v1/me/campaigns` 的响应）
 *
 * 旧判据是「无 `CLAIM_BENEFIT` **且** 用量响应里 `addOnQuota` 字段缺失」。
 * 后者**实测不可靠**（用户报障 IKJSHK，2026-10-07）：已开通账号也常常没有
 * `addOnQuota`（只有 `userQuota`），11 个账号里 7 个被误判「未开通」。
 * 维护者复核确认「`addOnQuota` 不是『是否登录过官方客户端 / 是否开通』的可靠
 * 代理」——同一份响应形状在 `349569d`（2026-09-26）被判「真未开通」、在
 * 2026-10-07 被判「误报」，说明**字段形状本身分不开这两类账号**。
 *
 * ## 新判据（仅凭活动列表，全部是服务端信号）
 *
 * | 活动列表形态 | 判定 | 依据 |
 * |---|---|---|
 * | 含任意 `CLAIM_BENEFIT`（`CLAIMABLE` 或 `CLAIMED`） | **已开通** → false | 服务端给该账号下发了「领积分」活动（真实抓包 `qoder-claim.spec.ts` 的 `CAMPAIGNS_BODY` / `CAMPAIGNS_AFTER_CLAIM`）。⚠️ **证据边界见下方「这一格的证据强度」** —— 抓包样本里的 `CLAIM_BENEFIT` **全是每日领取那一条** |
 * | `showCampaign:true` 且**无** `CLAIM_BENEFIT`（只剩 `VIEW_DETAILS`） | **未开通** → true | 服务端认识该账号、给它看了活动页，但**没有下发任何可领福利** —— 「未开通」的形态（2026-09-26 实测，`CAMPAIGNS_ONLY_VIEW`）。⚠️ 该形态与「缺 machine 头」**逐项同形**，故必须配第三腿才成立 |
 * | 列表为空 / `showCampaign:false` / 未取到 | **无法判定** → false | 来自 **CLI 身份**（`Cosy-ClientType:'5'`）或「今天已领」，与「未开通」不可区分；宁可少提示，不可误报（`CAMPAIGNS_EMPTY`） |
 *
 * ### ⚠️⚠️ 这一格的证据强度：**判据读的是「任意福利」，文案宣称的是「每日领取」
 *
 * 上表第一行把「含**任意** `CLAIM_BENEFIT`」等同于「**已开通每日领取**」。
 * 这两条**不是同一件事**，而本仓**没有证据**支持它们等价：
 *
 * - 仓库里两份 `CLAIM_BENEFIT` 抓包样本（`CAMPAIGNS_BODY` / `CAMPAIGNS_AFTER_CLAIM`）
 *   的 `CLAIM_BENEFIT` **都是每日领取那一条**（`campaignKey: 'act-20260921-308'`）；
 * - 无任何观测能证明「未开通每日领取的账号不会下发**非每日**的 `CLAIM_BENEFIT`」；
 * - 而运营类活动在服务端**确实存在**（`docs/agent-notes/misc.md:639` 记着
 *   「实测还有 `VIEW_DETAILS` 型活动，如『Pro 首月翻倍』」）——只是现有样本里
 *   它们恰好是 `VIEW_DETAILS` 而非 `CLAIM_BENEFIT`；
 * - ⚠️ 本仓**目前也没有能力区分**：`campaignKey` 全仓只用于填 `activityName`
 *   展示（见本文件 `fetchQoderCheckinStatus`），没有任何地方按它分流。
 *
 * ⇒ **已知漏报边界**：若上游真给未开通账号下发一个运营福利 `CLAIM_BENEFIT`，
 * 该账号会被判「已开通」⇒ 落到「当前没有可领取的活动」，**当天 100 Credits
 * 静默漏领且零出路提示**。
 *
 * ⚠️ **本项目的取证纪律**（本文件下方「为什么不用『尝试领取』」那条）：
 * **用未经验证的信号代替服务端语义，正是本缺陷反复踩坑的根源** ——
 * 该纪律在此处的应用就是：**不假装这条等价关系已被验证**。
 * 故此处**如实标注**为未验证，而非据此再写一条对称外推去「收紧」判据
 * （那会用同类未验证假设替换同类未验证假设，且需要臆造 `campaignKey` 的
 * 生成规则——同样属于凭空发明线上协议）。
 *
 * ⏳ **待真机取证**：一个「真未开通、但服务端下发了非每日 `CLAIM_BENEFIT`」的
 * 账号。在此之前该格按「任意福利即已开通」执行（保守方向：宁可漏报不可误报）。
 *
 * ⚠️ **为什么不用「尝试领取、服务端拒绝」作为判据**（曾考虑，IKJSHK 建议的
 * 修法 1）：走到「未开通」判定这条路径时，活动列表里本就**没有可领的
 * `CLAIM_BENEFIT`**（只有 `VIEW_DETAILS`），手上**没有可领的 `campaignId`**；
 * 对一个 `VIEW_DETAILS` 活动发 claim 的响应形状**从未被抓包实测过**，据此判定
 * 等于凭空发明线上协议 —— 这正是本缺陷反复踩坑的根源（用未经验证的信号代替
 * 服务端语义）。故判据取**已被抓包实证**的活动列表三态。
 *
 * ⚠️ **必须与「今天已领」「还没刷新」「请求头不完整」区分开**：本函数只在
 * 列表**非空且 `showCampaign` 为真却又无 `CLAIM_BENEFIT`**、**且本次请求
 * 确实带上了成对 machine 头**时才返回 true；其余「拿不到 CLAIM_BENEFIT」
 * 的情况（空列表 / 未取到 / **机器头缺失**）一律 false，把「说成已领 /
 * 说成未开通」这两个代价更高的方向都留给上游按 `refreshed` 处理。
 *
 * ⚠️⚠️ **两个方向都要读，漏报边界见上**：
 * - **误报方向**（用户白跑）：缺 machine 头 → 由第三腿挡住（PR !117 审计 P0-1）；
 * - **漏报方向**（当天额度静默漏领）：非每日福利的 `CLAIM_BENEFIT` → **未修**，
 *   待真机取证（见「这一格的证据强度」）。
 *
 * ⚠️⚠️ **第三腿：机器头必须真的发出去了**（PR !117 审计 P1-1）。
 * 缺 machine 头时服务端的响应形态是 `showCampaign:true, claimable:false,
 * **1 条 `VIEW_DETAILS`**`（逐项消融表，见 `qoder-machine.ts` /
 * `qoder-product.ts`；同表亦见本文件 `creditsHeaders` 的注释）——这与
 * 「未开通」的形态**逐项同形**，本函数单看响应**无法**区分。
 *
 * ⚠️ 该形态是**纯插件用户的常态**：`withQoderMachineHeadersAsync` 拿不到
 * 身份时按 `qoder-machine.ts` 的保守降级路径「不带这两个头、照常发请求」，
 * 而 `qoder-machine.ts` 自己就记录了 exe 定位失败 / 陈旧缓存这条路
 * **2026-09-25 已复发过一次**。若不设这道闸，凡本机拿不到机器身份的用户，
 * 其**每一个**账号都会被判「未开通」，并被前端（`usage-badge.js` /
 * `jet-hub.js` 都只判 `actionRequired === true`）渲染成醒目的
 * 「请先用 Qoder 官方客户端登录一次」——而真正缺的是机器头，
 * **装了客户端也未必能拿到**（同一条复发路径 + spawn 超时），用户按指引白跑一趟。
 *
 * ✅ **这条区分信号一直在插件自己手上**（`creditsHeaders` 的返回值里就有
 * `Cosy-MachineToken`），不需要额外请求，也不依赖任何未经验证的推断。
 * 端到端复现与修复验证见 `docs/audit/pr117-qoder-audit.md`。
 *
 * @param campaigns 活动列表（undefined 表示未取到，此时无法判定 → false）
 * @param machineHeadersPresent 本次请求是否带上了成对 machine 头；
 *   **省略视作 false**（保守：无法证明头齐全就不下「未开通」结论）
 */
export function isQoderNotActivated(
  campaigns: QoderCampaigns | undefined,
  machineHeadersPresent = false,
): boolean {
  // 取不到活动列表时无法判定 —— 保守返回 false（宁可少提示，不可误报）
  if (campaigns === undefined) return false

  // ⚠️ 机器头缺失时，本函数看到的响应与「未开通」逐项同形（见上）⇒ 不判定。
  if (!machineHeadersPresent) return false

  // 含任意 CLAIM_BENEFIT（无论可领还是已领）⇒ 服务端下发了福利活动 ⇒ 已开通。
  // ⚠️ 这里读的是「**任意**福利活动」，而文案宣称的是「**每日**领取」——
  // 二者不等价且**未经实测**（仓库里的 `CLAIM_BENEFIT` 样本全是每日那条，
  // 且本仓没有按 `campaignKey` 分流的能力）。漏报边界见上方
  // 「这一格的证据强度」。⏳ 待真机取证。
  const hasBenefit = campaigns.campaigns.some((c) => c.actionType === 'CLAIM_BENEFIT')
  if (hasBenefit) return false

  // 空列表 / showCampaign:false ⇒ CLI 身份或「今天已领」等形态，
  // 与「未开通」不可区分 ⇒ 不能判成未开通。
  if (!campaigns.showCampaign || campaigns.campaigns.length === 0) return false

  // 非空、showCampaign 为真、却没有任何 CLAIM_BENEFIT ⇒ 只有 VIEW_DETAILS 之类
  // ⇒ 该账号在服务端没有「每日领取」活动 ⇒ 未开通（需用户去官方客户端登录开通）。
  return true
}

/**
 * `/sash/` 端点（用量、活动）的公共请求头。
 *
 * ⚠️ **两个头都必需，缺一都会让服务端不下发「可领取」的活动**：
 *
 * 1. `Cosy-ClientType` = `sashClientType`（`'10'` = 桌面 app 身份）。
 *    用 `clientMetadata.client_type`（`'5'` = CLI）时 `/sash/api/v1/me/campaigns`
 *    恒返回 `campaigns:[]`。
 * 2. `Cosy-MachineToken` + `Cosy-MachineType`（**必须成对**，见
 *    `qoder-machine.ts`）。只用 `'10'` 时服务端只回一条 `VIEW_DETAILS`，
 *    **没有** `CLAIM_BENEFIT/CLAIMABLE` → 插件误判「今天已领」。
 *
 * 这两点是**必要但不充分**的关系：`'10'` 是前提，machine 头才决定是否下发
 * 可领项。2026-09-25 的逐项消融实验（同一账号、同一 token、只改头）证实：
 *
 * | 头 | 结果 |
 * |---|---|
 * | 仅 `ClientType: '10'` | 1 条 `VIEW_DETAILS`，`claimable:false` |
 * | ＋ `MachineToken` ＋ `MachineType` | **2 条**，含 `CLAIM_BENEFIT/CLAIMABLE/100` |
 * | 去掉 `MachineToken` 或 `MachineType` 任一 | 退回 1 条 |
 *
 * 关键证据来自用户提供的 `qoder积分.pcapng`（配 `SSLKEYLOGFILE` 解密），
 * 其中 native 请求确实带了完整 machine 头族；详见 `qoder-machine.ts` 模块注释。
 *
 * 用量端点（`/sash/api/v2/me/usage`）对这些头**不敏感**，一并带上无副作用。
 *
 * ⚠️ 本函数是**异步**的：machine 身份要实时 spawn `runtime-info.exe` 生成
 * （首次约 3.8 秒，之后走进程内缓存），同步实现会阻塞事件循环。
 * 详见 `qoder-machine.ts`。
 */
async function creditsHeaders(
  credential: QoderCredential,
  product: QoderProduct,
): Promise<Record<string, string>> {
  return await withQoderMachineHeadersAsync({
    Accept: 'application/json',
    Authorization: `Bearer ${qoderBearerToken(credential)}`,
    // 桌面 app 身份（`'10'`）；服务端据此进入活动下发分支。
    'Cosy-ClientType': product.sashClientType,
    'User-Agent': 'Qoder',
  })
}

/** 安全读数字字段（容忍字符串与缺失）；无法解析时返回 undefined。 */
function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 安全读字符串字段。 */
function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 把一个 quota 对象转成 `CreditPackage`。
 *
 * `remaining` 优先取服务端字段；缺失时按 `total - used` 计算
 * （对齐源码 `tVe` 的 `Math.max(0, total - used)`）。
 * 负值一律 clamp 到 0：服务端在超额扣费/计量回滚下可能下发负值，
 * 原样透出会让卡片显示「-12.5 积分」。
 */
/**
 * 「套餐额度」这个包的**固定名**（本仓库自己合成的名字，服务端不下发）。
 *
 * ⚠️ 导出它是为了让「用量徽标」的套餐判定（`src/badge-subscription.ts`）与这里
 * **共用同一个字面量**：判定靠的是包名精确等于它，两处各写一份字符串会在将来
 * 改名时静默失配（表现为徽标永远不显示 Qoder 的订阅额度）。
 */
export const QODER_PLAN_PACKAGE = '套餐额度'

function toPackage(
  name: string,
  quota: unknown,
  options: {
    active?: boolean
    expiredTime?: string
    /**
     * `qoderUsage.expiresAt`（**数字毫秒**）。
     *
     * ⚠️ **只有 `userQuota` 那一条传它** —— `expiresAt` 的语义归属就是
     * `userQuota`（套餐额度）：见 {@link QODER_PERMANENT_EXPIRY_MS} 的取证。
     * `addOnQuota`（只给聚合标量、**任何日期字段都没有**）与
     * `dedicatedResourcePackages`（逐包自己带 `expiresAt` 字符串，走
     * `expiredTime` 那条既有路径）都**不传**。
     */
    expiresAtMs?: number
  } = {},
): CreditPackage | undefined {
  const total = readNumber(quota, 'total')
  const used = readNumber(quota, 'used')
  const remainingRaw = readNumber(quota, 'remaining')
  if (total === undefined && used === undefined && remainingRaw === undefined) return undefined
  const totalValue = Math.max(0, total ?? 0)
  const usedValue = Math.max(0, used ?? 0)
  const remaining = remainingRaw !== undefined
    ? Math.max(0, remainingRaw)
    : Math.max(0, totalValue - usedValue)
  /**
   * 到期时间归一化 —— **两条互斥判据**。
   *
   * ## ⚠️ 2026-10-20 更正：旧注释说「Qoder 没有独立到期，一律不设置
   * `deductionEndTime`」，那句话对 `userQuota` 一层**不成立**（它在说谎）
   *
   * 旧原文（本仓库历史）：
   * > 到期时间归一化：Qoder 的专用资源包用 expiredTime 字段（ISO 日期字符串）。
   * > 套餐额度/资源包没有独立到期（统一"领取后 30 天"），不设置 deductionEndTime，
   * > 前端 formatPackageExpiry 对 Qoder 的特定包名走"30 天内有效"的特殊显示。
   *
   * 两处不实：① `userQuota` 那层其实**有** `usage.expiresAt`（数字毫秒），
   * 只是个人版下发的恒是永久哨兵；② 前端 `formatPackageExpiry`（`credit-expiry.js`）
   * **没有**、也从来没有「对 Qoder 特定包名走 30 天内有效」的分支 ——
   * 它只按 `deductionEndTime` 是否有值分流（有 ⇒ 绝对日期 + 天数；无 ⇒ 「长期」）。
   * ⇒ 本次把它改写成下面这条真实的两分支判据。
   *
   * ## 判据（两条**互不重叠**的支路 —— 调用点按 pack 种类各自只走一支）
   *
   * | 支路 | 来源与调用点 | 命中条件 | 动作 |
   * |---|---|---|---|
   * | A（**本次新增**） | `options.expiresAtMs` = `qoderUsage.expiresAt`，只在 `userQuota` 那一条传 | 非有限值 / `<= 0` | 落到 B |
   * | A | 同上 | **永久哨兵**（`>= QODER_PERMANENT_EXPIRY_MS`，或解析出的年份 `>= 9999`） | **不写** `deductionEndTime` ⇒ 前端「长期」 |
   * | A | 同上 | 真实时间戳 | **写** `deductionEndTime` ⇒ 前端显示真实日期 |
   * | B（**既有，未改动**） | `options.expiredTime` = 逐包 ISO 字符串（`dedicatedResourcePackages[].expiresAt`） | `Date.parse` 有限 | **写** `deductionEndTime` |
   * | B | 同上 | 缺失 / 解析失败 | **不写** |
   *
   * ⚠️ 支路 B 是**既有行为、本次刻意不动**（Lead 2026-10-20 明确：该路径已在工作，
   * 既不是缺陷也不是本任务的新增能力）。它服务的是 `dedicatedResourcePackages[]`
   * —— 全上游**唯一**带真实逐包到期的字段，仍照旧精确折算。
   *
   * ⚠️ 「不写」是**保守方向**：`splitBuddyCreditsByExpiry` 对缺
   * `deductionEndTime` 的包按**永久桶**处理 —— 未知到期假定为长期，
   * 而临期判据宁可漏报也不瞎报（本仓库红线「绝不编造日期」）。
   */
  const explicitMs = options.expiresAtMs
  const explicitUsable = typeof explicitMs === 'number' && Number.isFinite(explicitMs) && explicitMs > 0
  // ⚠️ 与支路 B 共用 `isPermanentSentinelMs` 一份判据（含「年份 >= 9999」兜底，
  //    兜住 `9999-01-01`~`9999-12-30` 这些小于常量但同样是哨兵的取值）。
  const explicitIsPermanent = explicitUsable && isPermanentSentinelMs(explicitMs)
  const expMs = options.expiredTime && options.expiredTime.length > 0
    ? Date.parse(options.expiredTime.replace(' ', 'T'))
    : Number.NaN
  /**
   * ⚠️⚠️ **支路 B 也要过永久哨兵判据**（2026-10-21 合并审计发现，真实缺陷）。
   *
   * ## 缺陷是什么
   *
   * 上一版只对**支路 A**（`userQuota` 的数字 `expiresAt`）做了哨兵识别，
   * 判定为永久后**直接落到支路 B**（`expiredTime` 字符串）。而支路 B 服务的是
   * `dedicatedResourcePackages[].expiresAt` —— 那个字段**同样可能下发 9999 哨兵**，
   * 且本机账号恰好没有样本（`undefined`），所以这条路径从未被真机数据验证过。
   *
   * 实测（本机，构造报文）：
   * ```
   * toPackage('专用资源包', {total:100,used:0,remaining:100},
   *           { expiredTime: '9999-12-31T00:00:00.000Z' })
   *   → deductionEndTime = 253402214400000
   *   → 客户端 formatPackageExpiry 渲染成「9999-12-31（2912150 天后）」
   * ```
   * 这正是本 PR 在 `userQuota` 那一路**声称已消灭**的荒谬文案 ——
   * 只堵了一个入口，另一个入口原样漏着。
   *
   * ## 两个可观测后果（第二个更严重）
   *
   * 1. **荒谬展示**：卡片上出现「9999-12-31（约 290 万天后）」。
   * 2. **分桶错位**：该包落进 `longTerm`（约 290 万天后 ⇒ 远超 15 天窗口），
   *    而它的语义是**未知到期**（应落 `permanent`）。⚠️ 这两个桶**选号行为不同**：
   *    `longTerm` 在锁定永久积分时**仍然可选**，而 `permanent` 会被拦 ——
   *    于是「锁住的永久积分」在这一路径上**照样被烧**，锁定形同虚设。
   *
   * ## 修法
   *
   * 把「哨兵识别」抽成对**毫秒值**的纯判据 `isPermanentSentinelMs()`，两条支路
   * 共用同一份实现（本仓库红线：同一语义只留一处判据）。支路 B 解析出 `expMs`
   * 后先过它，命中就**不写** `deductionEndTime`（= 永久桶 = 前端「长期」）。
   *
   * ⚠️ 字符串里的「年份 >= 9999」也要认 —— 上游若发 `"9999-12-31"` 这种**纯日期**
   *    （不带 `T00:00:00Z`），`Date.parse` 仍能解析，落到同一个毫秒判据上。
   */
  const expIsPermanent = isPermanentSentinelMs(expMs)
  const deductionEndTime = explicitUsable && !explicitIsPermanent
    ? explicitMs
    : (Number.isFinite(expMs) && !expIsPermanent ? expMs : undefined)
  /**
   * ⚠️⚠️ **`expiredTime` 也必须过滤哨兵**（2026-10-21 对抗性审计发现，P1：
   * 上一版只挡住了 `deductionEndTime`，这条泄漏仍然存在）。
   *
   * ## 为什么挡住 `deductionEndTime` 还不够
   *
   * 客户端 `credit-expiry.js` 的 `packageExpiryMs()` 是**两段回落**：
   * ```js
   * // 1) 先读 deductionEndTime（数字）
   * // 2) 读不到 ⇒ 回落到 expiredTime（字符串，Date.parse）
   * ```
   * 于是即使 `deductionEndTime` 被正确清空，只要 `expiredTime` 里还留着原串，
   * tooltip 仍会渲染出哨兵日期。实测（本机，构造报文）：
   * ```
   * { deductionEndTime: undefined,
   *   expiredTime: '9999-12-31T00:00:00.000Z' }
   * → packageExpiryMs    = 253402214400000
   * → formatPackageExpiry = "9999-12-31（2912150 天后）"
   * ```
   * ⇒ 正是 `toPackage` 上方注释声称「已消灭」的那句荒谬文案，**换了个字段入口
   *   又回来了**。分桶不受影响（`permanent`，锁定会拦），但用户看到的明细
   *   仍然自相矛盾：三档行说「永久」、hover 里说「9999-12-31 到期」。
   *
   * ## 修法
   *
   * 哨兵命中时**连 `expiredTime` 一起清空**（置 `''`）。二者必须是同一份判据的
   * 两个出口 —— 只清一个就留了另一半泄漏。
   *
   * ⚠️ 非哨兵的真实日期**照旧原样透出**（tooltip 要显示上游原文），
   *    `undefined`（解析失败）也照旧透出（它不是哨兵，只是我们认不出）。
   */
  const expiredTimeRaw = options.expiredTime ?? ''
  return {
    name,
    unit: readString(quota, 'unit') ?? 'credits',
    remaining,
    total: totalValue,
    used: usedValue,
    active: options.active ?? true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: expIsPermanent ? '' : expiredTimeRaw,
    ...(deductionEndTime !== undefined ? { deductionEndTime } : {}),
  }
}

/**
 * 查询 Qoder 账号积分余额。
 *
 * 返回 `null` 表示**查不到**（网络失败 / 401 / 响应形状非法），
 * 与「余额为 0」严格区分 —— 失败时 UI 应显示原因而不是 0。
 *
 * 企业版账号（`displayMode === 'enterprise'`）返回 `null`：
 * 那种模式不提供额度数字，只给一个外部链接（`enterpriseUsage.detailUrl`），
 * 报 0 会误导用户以为没额度。
 */
export async function fetchQoderCreditBalance(
  credential: QoderCredential,
  product: QoderProduct,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const detailed = await fetchQoderBalanceDetailed(credential, product, { fetcher })
  return detailed.balance
}

/** {@link fetchQoderBalanceDetailed} 的可选项。 */
export interface QoderBalanceOptions {
  /** 注入 fetcher（测试用；生产用全局 `fetch`）。 */
  fetcher?: typeof fetch
  /**
   * 单次请求超时（毫秒）。默认 {@link QODER_CREDITS_TIMEOUT_MS}。
   *
   * ⚠️ 面板**并发**查询所有账号（2026-10-21 起），故 N 个账号的最坏总耗时
   *    约等于**单账号**的耗时，不再线性叠加。但单账号本身仍可能耗满本值：
   *    国际版被 SNI 阻断时实测 10.7s（undici 自己的 connect timeout 先于
   *    本值触发）⇒ 调小本值**不会**让墙外的失败更快返回，只能调大。
   */
  timeoutMs?: number
}

/**
 * 查询 Qoder 账号积分余额，**失败时带上可读原因**（Jet Hub 面板用）。
 *
 * ## 为什么需要这个并列函数（而不是改造上面那个）
 *
 * `fetchQoderCreditBalance` 的契约是「查不到就 `null`」—— 它服务于
 * `BuddyBalanceSelector`（选号/分档，只关心金额）与 `sharedPackageExpiry`
 * （折算到期，只关心日期）。那两处**不需要**原因，硬塞原因会让 20 多处
 * `balance!.total` 断言全破。
 *
 * 但**面板**需要原因：原实现的报障形态是「一直读取中」，最终只落到一句
 * 「积分查询失败（凭据失效或响应异常）」—— 这句话把**网络不通**、**401**、
 * **响应变形**、**企业版无数字**四种完全不同的处境压成同一句，用户无法据此
 * 做任何事。实测本机 Qoder 国际版：`openapi.qoder.sh` 的 TCP 443 能连通
 * （93ms），但 **TLS ClientHello 被丢**（12s 无响应），故 `fetch` 必在 10.7s
 * 后报 `UND_ERR_CONNECT_TIMEOUT` —— 这是**环境问题**，不是凭据问题。
 *
 * ## 判据分层（与 `astudio-credits.ts` 的 `fetchAstudioBalanceDetailed` 同款）
 *
 * 1. **传输层**：`aborted` / 错误码命中「出不去」⇒ 点名实际主机 + 出路。
 * 2. **HTTP 层**：401/403 = 凭据；其它非 2xx = 服务端（带状态码）。
 * 3. **形状层**：非 JSON / 非对象 / 缺 `qoderUsage` / 一个包都没解析出来。
 * 4. **企业版**：`displayMode === 'enterprise'` ⇒ 上游本就不给数字（不是故障）。
 *
 * @returns 成功时 `{ balance }`；失败时 `{ balance: null, error }`。
 *   ⚠️ 永远返回 `balance` 字段（共享骨架靠 `balance` 判定成败，
 *   `error` 只影响文案 —— 见 `provider-runtime.ts` 的 `ProviderBalanceDetail`）。
 */
export async function fetchQoderBalanceDetailed(
  credential: QoderCredential,
  product: QoderProduct,
  options: QoderBalanceOptions = {},
): Promise<ProviderBalanceDetail> {
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? QODER_CREDITS_TIMEOUT_MS
  const url = `${product.openApiBase}${QODER_USAGE_PATH}`
  /**
   * ⚠️⚠️ **构造请求头必须在 try 内**（2026-10-21 合并审计发现，!136 引入的回归）。
   *
   * `creditsHeaders` 会抛（凭据形状异常等），而本函数的契约是「**本身不抛**」——
   * 它一抛，`src/jet-hub-rpc.ts` 的 `Promise.all` 失败隔离就失效：
   * 一个坏账号让**整批** `credits.balances` 变成 `ok:false`，客户端把同一句
   * message 盖到该 provider 的**每一个**账号卡片上 —— 按账号给原因的能力
   * 在异常路径上一次性全丢。
   *
   * ⚠️ 并发改造**之前**是串行 `for` + 每格自己的错误分支，所以那时抛不出去；
   *    改成 `Promise.all` 时必须把这条腿一起包进来。实测对照：
   *    BASE（改动前）同一路径返回 `null`，HEAD 抛出 ⇒ 隔离确实被打破。
   *
   * ⚠️ 文案**不要**复用下面那条「网络异常」——凭据构造失败不是网络问题，
   *    照实说「凭据不可用」并带上根因（别吞 message）。
   */
  let headers: Record<string, string>
  try {
    headers = await creditsHeaders(credential, product)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { balance: null, error: `积分查询失败（凭据不可用）：${reason}` }
  }

  let response: Response
  // 自己 arm 的超时是否真的触发 —— `AbortSignal.timeout()` 超时**不带** `UND_ERR_*`
  // 错误码（IKLTZ2 审计 P2-2 的实际教训），只能靠读 `signal.aborted` 判断。
  // ⚠️ 这里**必须**自己持有 controller 才能读到；用 `AbortSignal.timeout()` 的
  //    返回值虽然也是 AbortSignal，但它在 catch 时才 aborted，语义等价 ——
  //    故仍直接用它，只是要在 catch 里读一次 `.aborted`。
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  try {
    response = await fetcher(url, { method: 'GET', headers, signal: timeoutSignal })
  } catch (error) {
    const hint = networkBlockedHint({
      error,
      aborted: timeoutSignal.aborted,
      subject: product.openApiBase,
      /**
       * ⚠️ **只给出路，不断言机制**（2026-10-21 合并审计发现）。
       *
       * 旧文案写死「Qoder **国际版**端点在本机被阻断（TCP 能连通、TLS 握手被丢）」，
       * 两处都错：
       * ① 本分支被 `isQoderFamily` **两站共用** ⇒ 中国版用户在自己公司网络里失败时，
       *    会读到与同一句里打印的主机名（`product.openApiBase`）**自相矛盾**的结论；
       * ② `remedy` 是常量 ⇒ 不论命中哪个码照发，而对 `ENOTFOUND`（DNS 解析不到）
       *    说「TCP 能连通」是**事实性错误**。
       * ⇒ 站点已由 `subject`（主机名）点名，机制留给用户自己看码；
       *    这里只保证**出路**是可操作的。
       *
       *    ⚠️ 2026-10-25 审计 A2-10：本句原先写「本插件目前**没有**按账号配代理的
       *    按钮，故只能说『换网络 / 启动前导出 HTTPS_PROXY』」—— `618a090` 起
       *    **已有**该按钮（Jet Hub 的 Qoder 账号卡片 →「代理」）⇒ 那段自述已过时。
       *    保留「换网络 / HTTPS_PROXY」作为**全局**出路仍正确（它们确实都能用），
       *    但不得再声称「没有按账号代理入口」。
       */
      remedy: '插件进程不走系统代理；请在能直接访问该地址的网络下使用，'
        + '或为插件进程配置出口代理后在启动 DSH 前导出 HTTPS_PROXY。',
    })
    if (hint !== undefined) return { balance: null, error: hint }
    // 不是「出不去」⇒ 老实说清楚是什么（含 message，别吞）。
    const reason = error instanceof Error ? error.message : String(error)
    return { balance: null, error: `积分查询失败（网络异常）：${reason}` }
  }

  // 401/403 是凭据问题，其它非 2xx 是服务端问题 —— 两者原因不同，不能混。
  if (!response.ok) {
    const status = response.status
    if (status === 401 || status === 403) {
      return {
        balance: null,
        error: `积分查询失败（HTTP ${status}，登录已失效）：请删除该账号后重新登录 Qoder`,
      }
    }
    return { balance: null, error: `积分查询失败（HTTP ${status}）` }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { balance: null, error: '积分查询失败（响应不是 JSON）' }
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { balance: null, error: '积分查询失败（响应不是对象）' }
  }
  const root = body as Record<string, unknown>

  // 企业版：无额度数字，只有外部链接。这不是故障 ⇒ 原因写清「上游不给数字」。
  if (root.displayMode === 'enterprise') {
    return {
      balance: null,
      error: '企业版账号不提供额度数字（上游只给网页版用量链接），请在 Qoder 网页端查看',
    }
  }

  const usage = root.qoderUsage
  if (typeof usage !== 'object' || usage === null) {
    return { balance: null, error: '积分查询失败（响应缺少 qoderUsage 字段）' }
  }

  const parsed = parseQoderUsage(usage as Record<string, unknown>)
  if (parsed === null) {
    return { balance: null, error: '积分查询失败（响应未包含任何额度包）' }
  }
  return { balance: parsed }
}

/**
 * 从 `qoderUsage` 对象解析出余额（纯函数，`fetchQoderCreditBalance` 与
 * `fetchQoderBalanceDetailed` 共用**同一份**解析 —— 红线：同一语义只留一处）。
 *
 * @returns 解析不出任何包时 `null`（= 查不到，而非余额 0）。
 */
function parseQoderUsage(qoderUsage: Record<string, unknown>): CreditBalance | null {
  const packages: CreditPackage[] = []
  // 顺序即展示顺序：套餐额度 → 赠送/资源包 → 专用资源包（⚠️ 顺序与「一个包都
  // 解析不出来就返回 null」这两条是**既有的、本次不动**）。
  // ⚠️ `usage.expiresAt`（数字毫秒）**只传给 `userQuota` 那一条** ——
  //    它的语义归属就是套餐额度，不是 `addOnQuota`（那一层只给聚合标量、
  //    连日期字段都没有），也不是任何逐包到期（那些走各自的 `expiredTime`）。
  //    传给别处会把哨兵/未知到期挂到错误的包上，分档随之错位。
  const userQuotaExpiresAtMs = readNumber(qoderUsage, 'expiresAt')
  const userQuota = toPackage(
    QODER_PLAN_PACKAGE,
    qoderUsage.userQuota,
    { expiresAtMs: userQuotaExpiresAtMs },
  )
  if (userQuota !== undefined) packages.push(userQuota)
  // ⚠️ 刻意**不传** `expiresAtMs`：`addOnQuota` 没有任何日期字段，
  //    传了就是把套餐的哨兵按到资源包头上。
  const addOnQuota = toPackage('资源包', qoderUsage.addOnQuota)
  if (addOnQuota !== undefined) packages.push(addOnQuota)

  const dedicated = qoderUsage.dedicatedResourcePackages
  if (Array.isArray(dedicated)) {
    for (const item of dedicated) {
      const pkg = toPackage(
        readString(item, 'name') ?? readString(item, 'id') ?? '专用资源包',
        item,
        { expiredTime: readString(item, 'expiresAt') ?? readString(item, 'expires_at') ?? '' },
      )
      if (pkg !== undefined) packages.push(pkg)
    }
  }

  // 一个包都没解析出来 → 视为「查不到」（响应形状与预期不符），
  // 而不是「余额为 0」——后者会让用户以为额度被清空了。
  if (packages.length === 0) return null

  const total = roundCredits(packages.reduce((sum, pkg) => sum + pkg.remaining, 0))
  return { total, packages, expiredTotal: 0 }
}

/** 把 `CreditBalance` 压成一行可读摘要（供探针与日志使用）。 */
export function describeQoderBalance(balance: CreditBalance | null): string {
  if (balance === null) return '查询失败'
  if (balance.total === 0) return '余额 0'
  return `${balance.total} credits（${balance.packages.length} 个包）`
}

// ── 每日领取 ──

/** 一个可领取的活动条目（`campaigns[]` 的一项，只保留实现需要的字段）。 */
export interface QoderCampaign {
  campaignId: string
  campaignKey?: string
  /**
   * 动作类型：`CLAIM_BENEFIT` = 可领取积分；`VIEW_DETAILS` = 仅跳转详情
   * （实测「Pro 首月翻倍」就是后者，**不该尝试领取**）。
   */
  actionType?: string
  /** `CLAIMABLE` / `CLAIMED` / … —— 领取前的权威判据。 */
  claimStatus?: string
  /** 可领积分（`benefit.amount`）。 */
  amount?: number
}

/**
 * 活动列表的一次解析结果。
 *
 * ⚠️ `claimable` 为 false 时**不代表没有活动** —— 实测今天已领后
 * 服务端返回 `showCampaign:false, claimable:false, campaigns:[]`，
 * 所以「无活动」与「已领完」在响应上无法区分。不要据此下结论。
 */
export interface QoderCampaigns {
  showCampaign: boolean
  claimable: boolean
  campaigns: QoderCampaign[]
}

/** 解析 `/sash/api/v1/me/campaigns` 的响应；形状非法时返回 undefined。 */
export function parseQoderCampaigns(body: unknown): QoderCampaigns | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const root = body as Record<string, unknown>
  const raw = root.campaigns
  const campaigns: QoderCampaign[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const id = readString(item, 'campaignId')
      if (id === undefined) continue
      campaigns.push({
        campaignId: id,
        ...readString(item, 'campaignKey') !== undefined ? { campaignKey: readString(item, 'campaignKey')! } : {},
        ...readString(item, 'actionType') !== undefined ? { actionType: readString(item, 'actionType')! } : {},
        ...readString(item, 'claimStatus') !== undefined ? { claimStatus: readString(item, 'claimStatus')! } : {},
        ...benefitAmount(item) !== undefined ? { amount: benefitAmount(item)! } : {},
      })
    }
  }
  return {
    showCampaign: root.showCampaign === true,
    claimable: root.claimable === true,
    campaigns,
  }
}

/** 读 `benefit.amount`（嵌套一层）。 */
function benefitAmount(item: unknown): number | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  return readNumber((item as Record<string, unknown>).benefit, 'amount')
}

/**
 * 拉取活动列表；失败或形状非法时返回 undefined。
 *
 * 抽出来是因为 `fetchQoderCheckinStatus` 与 `claimQoderDailyCheckin`
 * 都需要它 —— 早期两处各写一次，会**重复发一次 GET**。
 *
 * @returns 活动列表，以及**本次请求是否带上了成对 machine 头** ——
 *   后者是 {@link isQoderNotActivated} 的必要前置（缺它时服务端的响应
 *   与「未开通」逐项同形，无法区分，见该函数注释）。
 */
async function loadCampaigns(
  credential: QoderCredential,
  product: QoderProduct,
  fetcher: typeof fetch,
): Promise<{ campaigns: QoderCampaigns; machineHeadersPresent: boolean } | undefined> {
  const headers = await creditsHeaders(credential, product)
  const machineHeadersPresent =
    headers['Cosy-MachineToken'] !== undefined && headers['Cosy-MachineType'] !== undefined
  let response: Response
  try {
    response = await fetcher(`${product.openApiBase}${QODER_CAMPAIGNS_PATH}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(QODER_CREDITS_TIMEOUT_MS),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  let body: unknown
  try { body = await response.json() } catch { return undefined }
  const campaigns = parseQoderCampaigns(body)
  if (campaigns === undefined) return undefined
  return { campaigns, machineHeadersPresent }
}

/**
 * 查询活动列表（签到状态）。
 *
 * 返回 `null` 表示**查不到**（网络失败 / 非 2xx / 形状非法），
 * 与「无活动可领」严格区分。
 *
 * `CheckinStatus` 是五个 provider 共用的结构，此处按 Qoder 的语义映射：
 *
 * - `active`：**拿到响应即 true**。⚠️ 不按「列表非空」判定 ——
 *   服务端在「今天已领」时会把 `campaigns` 清空并回 `showCampaign:false`，
 *   若据此判 `active:false`，调用方（`collectClaimResults`）会先命中
 *   「活动未开启」分支，把「今天已领」误报成「签到活动未开启」。
 * - `todayCheckedIn`：**只有存在「领过」的领分类活动时才为 true**
 *   （`CLAIM_BENEFIT` 且 `claimStatus === 'CLAIMED'`）。
 *
 *   ⚠️ **不能写成「没有可领活动即为 true」**（真实缺陷，用户报障
 *   「没领过就显示已经领取，去 IDE 看还是可以领取的状态」）：
 *   「列表里没有可领项」**不等于**「今天领过了」—— 它还可能是
 *   ① 未到刷新时间（每日 10:00 UTC+8）、② 请求头不完整导致服务端未下发
 *   （实测缺 `Cosy-MachineToken`/`Cosy-MachineType` 时就会这样，
 *   见 `qoder-machine.ts`）、③ 该账号本就无此类活动。三者都不是「已领」。
 *
 *   2026-09-21 抓包给了**同一账号的领取前后对照**（这是判据可靠性的直接证据）：
 *
 *   | 时刻 | `claimable` | 那条 `CLAIM_BENEFIT` 的 `claimStatus` |
 *   |---|---|---|
 *   | 领取前 | `true` | `CLAIMABLE` |
 *   | 领取后 | `false` | `CLAIMED` |
 *
 *   故「有 `CLAIM_BENEFIT`+`CLAIMED`」是「已领」的**充分且可靠**判据。
 *   方向仍取保守：误报未领最多让用户多点一次（服务端幂等，回
 *   `replayed:true`，无害）；误报已领会让其**真的错过当天积分**。
 *
 *   ⚠️⚠️ **但它只对「刷新之后」成立**（真实缺陷，2026-10-02 审查 PR !33 定位）：
 *   活动每日 10:00（UTC+8）才刷新，故**刷新前**看到的那条 `CLAIMED` 属于
 *   **昨天**。上午 9 点查状态若照旧判 `todayCheckedIn:true`，界面会显示「今天
 *   已领」，而官方 IDE 里今天的活动其实还没出现 —— 正好落在「误报已领」那个
 *   **不可逆**的方向上。刷新前一律判 `false`（见 `hasQoderCampaignRefreshedToday`）。
 * - `dailyCredit`：可领活动声明的 `benefit.amount`（实测 100）。
 */
export async function fetchQoderCheckinStatus(
  credential: QoderCredential,
  product: QoderProduct,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<CheckinStatus | null> {
  const loaded = await loadCampaigns(credential, product, fetcher)
  if (loaded === undefined) return null
  const { campaigns: parsed, machineHeadersPresent } = loaded

  const refreshed = hasQoderCampaignRefreshedToday(nowMs)
  const claimable = claimableCampaigns(parsed)
  const benefitCampaigns = parsed.campaigns.filter((c) => c.actionType === 'CLAIM_BENEFIT')
  const claimedBenefit = benefitCampaigns.filter((c) => c.claimStatus === 'CLAIMED')

  // 无可领项且非「已领」时，进一步判断是否**未开通**（需要用户去官方客户端登录）。
  // 判据与 `claimQoderDailyCheckin` 完全一致 —— 两处必须同源，否则状态查询说
  // 「未领取」而领取时报「未开通」，用户会困惑。
  //
  // ⚠️ `refreshed` 不可省：活动每日 10:00（UTC+8）才刷新，**刷新前**看到的那条
  // `CLAIMED` 属于昨天。此处若不判，会在上午谎报「今天已领」—— 而误报已领
  // 正是那个会让用户**真的错过当天积分**的方向（见文件头与
  // `hasQoderCampaignRefreshedToday`）。
  const todayCheckedIn = refreshed && claimedBenefit.length > 0 && claimable.length === 0
  let actionRequired = false
  if (!todayCheckedIn && claimable.length === 0) {
    // 判据只读活动列表（服务端信号），不再额外拉一次用量响应 —— 见
    // `isQoderNotActivated` 的注释（`addOnQuota` 不是可靠的开通信号）。
    actionRequired = isQoderNotActivated(parsed, machineHeadersPresent)
  }

  return {
    active: true,
    // 真有「领过」的领分类活动、且当前无可领项 ⇒ 今天已领。
    // 列表为空 / 仅 VIEW_DETAILS / 请求头不完整导致的空态，一律判**未领**。
    todayCheckedIn,
    streakDays: 0,
    dailyCredit: claimable[0]?.amount ?? benefitCampaigns[0]?.amount ?? 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: [],
    activityName: benefitCampaigns[0]?.campaignKey ?? '',
    themeName: '',
    endTime: '',
    // 只在为 true 时才带上该字段，保持既有响应形状最小变化
    ...actionRequired ? { actionRequired: true } : {},
  }
}

/** 可领取的活动：`CLAIM_BENEFIT` 且当前为 `CLAIMABLE`。 */
function claimableCampaigns(parsed: QoderCampaigns): QoderCampaign[] {
  return parsed.campaigns.filter(
    (c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE',
  )
}

/** 领取响应里我们需要的字段。 */
interface QoderClaimResult {
  status?: string
  replayed?: boolean
  amount?: number
  /** 服务端拒绝码（如 ）。 */
  failureCode?: string
}

/** 解析 claim 响应。 */
function parseClaimResult(body: unknown): QoderClaimResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {}
  const top = body as Record<string, unknown>
  // ⚠️ 上游若把结果包一层 `data`，只看顶层会把「BLOCKED」读成「无结论」⇒
  // 旧逻辑会落到 claimed+0（假成功）。顶层没有 status 时下钻一层。
  const root = readString(top, 'status') === undefined
    && typeof top.data === 'object' && top.data !== null && !Array.isArray(top.data)
    ? top.data as Record<string, unknown>
    : top
  const failureCode = readString(root, 'failureCode') ?? readString(root, 'failure_code')
  return {
    ...readString(root, 'status') !== undefined ? { status: readString(root, 'status')! } : {},
    ...typeof root.replayed === 'boolean' ? { replayed: root.replayed } : {},
    ...failureCode !== undefined ? { failureCode: failureCode.trim() } : {},
    ...benefitAmount(root) !== undefined ? { amount: benefitAmount(root)! } : {},
  }
}

/**
 * 领取一个活动的积分。
 *
 * ⚠️ **幂等判据是响应体的 `replayed`，不是 HTTP 状态码**：重复领取同样
 * 返回 200，但 `replayed:true` 且**不含 `benefit`**、`claimedAt` 是旧时间。
 * 只看状态码会把「今天已领」误报成「领取成功 +100」。
 *
 * ⚠️ **请求体必须是空串**（抓包实测 `content-length: 0`）。
 */
export async function claimQoderCampaign(
  credential: QoderCredential,
  product: QoderProduct,
  campaignId: string,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const url = `${product.openApiBase}${QODER_CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { ...await creditsHeaders(credential, product), 'Content-Type': 'application/json' },
      body: '',
      signal: AbortSignal.timeout(QODER_CREDITS_TIMEOUT_MS),
    })
  } catch (error) {
    return { kind: 'failed', code: -1, message: error instanceof Error ? error.message : String(error) }
  }

  const text = await response.text().catch(() => '')
  let body: unknown
  try { body = text.length > 0 ? JSON.parse(text) : {} } catch {
    return { kind: 'failed', code: response.status, message: describeNonJson(response.status, text) }
  }
  if (!response.ok) {
    return { kind: 'failed', code: response.status, message: describeNonJson(response.status, text) }
  }

  const result = parseClaimResult(body)
  /**
   * ⚠️ failureCode 必须**先于** replayed/status 判：设备锁响应可能同时带
   * `replayed`，先判 replayed 会把设备锁原因吞掉。大小写/尾空格做归一。
   */
  const failureCode = result.failureCode?.trim().toUpperCase()
  if (failureCode === 'SAME_PERSON_ALREADY_CLAIMED') {
    return {
      kind: 'already-claimed',
      message: '同一设备今日已由其它 Qoder 账号领取（上游设备锁），换设备或明日再试',
    }
  }
  // `replayed:true` = 本次活动此前已领（服务端回放上次结果）。
  if (result.replayed === true) {
    return { kind: 'already-claimed', message: '今天已领取' }
  }
  if (result.status !== 'CLAIMED') {
    const suffix = failureCode === undefined ? '' : `，failureCode=${result.failureCode}`
    return { kind: 'failed', code: -1, message: `领取未成功（status=${result.status ?? '未返回'}）${suffix}` }
  }
  return { kind: 'claimed', credit: result.amount ?? 0, streakDays: 0, isStreakDay: false }
}

/** 非 JSON 响应的可读原因（凭据失效时网关返回 HTML）。 */
function describeNonJson(status: number, text: string): string {
  if (status === 401 || status === 403) return `凭据已失效（HTTP ${status}），请重新登录该账号`
  const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ')
  return `服务端返回了非 JSON 响应（HTTP ${status}）：${snippet}`
}

/**
 * 领取该账号**当前所有**可领活动。
 *
 * 一个账号可能同时有多个 `CLAIM_BENEFIT` 活动（实测有每日 100 Credits
 * 与其它运营活动），故逐个领取而非只领第一个。
 *
 * 返回的 `ClaimOutcome` 汇总为一条：
 * - 无可领活动 → `inactive`（⚠️ **不是** `already-claimed`）；
 * - 至少一个成功 → `claimed`（`credit` 为累计值）；
 * - 全部已领（`replayed:true`）→ `already-claimed`；
 * - 全部失败 → `failed`（带上第一条错误原因）。
 *
 * ⚠️ **「无可领活动」必须是 `inactive`，不能报 `already-claimed`**
 * （真实缺陷，用户报障「没领过就显示已经领取」）：旧实现在
 * `targets.length === 0` 时直接返回「今天已领取」，于是只要服务端没下发
 * 可领项（含**请求头不完整**、未到刷新时间、本就无活动三种情形），
 * 界面就显示「今天已领取」，与 IDE 的「可领取」直接矛盾。
 * 二者语义完全不同：`inactive` = 没东西可领；`already-claimed` = 领过了。
 */
export async function claimQoderDailyCheckin(
  credential: QoderCredential,
  product: QoderProduct,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<ClaimOutcome> {
  const loaded = await loadCampaigns(credential, product, fetcher)
  if (loaded === undefined) {
    return { kind: 'failed', code: -1, message: '活动列表查询失败' }
  }
  const { campaigns: parsed, machineHeadersPresent } = loaded

  // ⚠️ 今天的活动列表是否已刷新（每日 10:00 UTC+8）。**刷新前看到的全是
  // 昨天那一轮**：既不能报「今天已领」，领取成功也不能算作「今天已处理」。
  // 少了这一句，上层会把「昨天那条已领」记成今天已跑 ⇒ 当天新额度整天漏领
  // （真实缺陷，2026-10-02 审查 PR !33 定位；字段语义见 `credits.ts`）。
  const refreshed = hasQoderCampaignRefreshedToday(nowMs)
  const stale = refreshed ? undefined : { coversToday: false as const }

  const targets = claimableCampaigns(parsed)
  if (targets.length === 0) {
    // 区分三种「没领到」：
    //   ① 确实领过      → already-claimed（**但仅限刷新之后**）
    //   ② 账号未开通    → inactive，但要给出**可操作**的提示（见 NOT_ACTIVATED_HINT）
    //   ③ 只是暂时没活动 → inactive
    // 判据同 fetchQoderCheckinStatus（抓包实证：领取后该活动变 CLAIMED）。
    const claimedBefore = parsed.campaigns.some(
      (c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMED',
    )
    if (claimedBefore) {
      // 刷新前看到的那条 `CLAIMED` 属于**昨天**。说成「今天已领取」是谎报，
      // 且方向不可逆（用户会以为今天不必再领，官方 IDE 里却还没刷新）。
      if (!refreshed) return { kind: 'inactive', message: NOT_REFRESHED_YET_HINT }
      return { kind: 'already-claimed', message: '今天已领取' }
    }

    // 走到这里说明服务端**下发了非空活动列表、却没有任何 CLAIM_BENEFIT**
    // （只剩 VIEW_DETAILS 之类）。据此判「未开通」—— 判据只读活动列表
    // **加上本次请求是否真的带上了 machine 头**（缺头时该响应形态与
    // 「未开通」同形，必须由判据自己区分，见 `isQoderNotActivated`）。
    if (isQoderNotActivated(parsed, machineHeadersPresent)) {
      // ⚠️ `actionRequired: true` 是给 UI 的**显式信号**（而非让它去猜文案）：
      // 这条 inactive 需要用户去官方客户端登录一次，必须单独醒目展示。
      // 理由与前端约定见 `credits.ts` 的 `ClaimOutcome.actionRequired`。
      return { kind: 'inactive', message: NOT_ACTIVATED_HINT, actionRequired: true }
    }
    return { kind: 'inactive', message: '当前没有可领取的活动' }
  }

  let total = 0
  let firstError: string | undefined
  /**
   * ⚠️ already-claimed 的**具体原因**也要往上透传（2026-11-03 审计 P1）：
   * 设备锁（SAME_PERSON_ALREADY_CLAIMED）与「本账号今天领过」是两件事，
   * 旧汇总只收集 failed 的 message，设备锁文案会在这一层被换成通用
   * 「今天已领取」⇒ 用户以为本账号领过了，而实际是设备被别的账号占用。
   */
  let firstAlreadyClaimed: string | undefined
  for (const target of targets) {
    const outcome = await claimQoderCampaign(credential, product, target.campaignId, fetcher)
    if (outcome.kind === 'claimed') total += outcome.credit
    else if (outcome.kind === 'failed' && firstError === undefined) firstError = outcome.message
    else if (outcome.kind === 'already-claimed' && firstAlreadyClaimed === undefined) {
      firstAlreadyClaimed = outcome.message
    }
  }
  // ⚠️ 三条返回都带 `stale`：刷新前领到的是**昨天那条**的补领 —— 它是一次
  // 真实动作（该如实报「领取成功」），但**不证明今天已被处理**，记账方必须
  // 能把这两种情况分开（否则当天 10 点刷新后的额度就没人领了）。
  if (total > 0) return { kind: 'claimed', credit: total, streakDays: 0, isStreakDay: false, ...stale }
  if (firstError !== undefined) return { kind: 'failed', code: -1, message: firstError }
  return { kind: 'already-claimed', message: firstAlreadyClaimed ?? '今天已领取', ...stale }
}
