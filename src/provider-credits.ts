/**
 * 各 provider 的**积分能力实现表** —— `ProviderRuntime.credits` 域的唯一真源。
 *
 * ## 它解决什么
 *
 * 重构前，`credits.balances` 是一个 **441 行**的 `case`，里面 11 段
 * `if (req.provider === X.id)` 各自重复同一套编排（逐账号 resolve 凭据 →
 * 调用本家的余额原语 → 拼 `{accountId, nickname, balance, error}`）。
 * 那些分支里**没有一行是协议逻辑** —— 协议早已封装在各家 `fetch*Balance` 内，
 * RPC 层看到的只是「选哪个函数」（设计文档 §3.5 的边界）。
 *
 * 本文件把「选哪个函数」抽成数据；编排仍留在既有的共享骨架
 *（`collectCreditBalances` / `collectCreditsStatus`）里，**一行不重写**。
 *
 * ## ⚠️ 哪些渠道**不在这里**（形态与骨架根本不匹配，刻意保留特例）
 *
 * | 渠道 | 为什么不进表 |
 * |---|---|
 * | `opencode` | 它的「余额」是**本地派生的通道可用性**（读账号池的 `modelRateLimits`），**零网络请求**。套进 `fetchBalance(credential, …)` 形状会逼它去发一个不存在的上游请求。 |
 * | `qoder` / `qodercn` | `fetchQoderCreditBalance` 只吃 `QoderCredential`、且 product 来自同族注册表；旧实现因此**没有**走 `collectCreditBalances` 的 `(credential, product)` 泛型。 |
 *
 * 这两段留在 `jet-hub-rpc.ts` 的 `credits.balances` 里、**先于查表短路**，
 * 并有各自的行为用例锁死（见 `credits-runtime-parity.spec.ts` 的
 * 「特例的优先级」）。强行套骨架会丢语义 —— 那是本仓库反复记录的缺陷形态。
 *
 * ## ⚠️ 为什么有些渠道用 `fetchBalanceDetailed` 而不是 `fetchBalance`
 *
 * `fetchBalance` 的 `null` 由共享骨架统一翻译成「余额查询失败」。但有几家的
 * 失败原因**必须区分**（用户会按原因决定去重新登录、还是去充值、还是什么
 * 都不用做）：
 *
 * - `codearts`：三态 —— 「Token 计费账户」/「非积分计费账户」/「未返回积分数据」；
 * - `gemini`：「尚未授权 Google 账号」与「查询失败」是两回事；
 * - `zcode`：「企业版不下发额度数字」不是故障；
 * - `cline` / `loomy` / `raccoon`：协议原语自己带**具体**原因
 *  （含 HTTP 状态码与错误体摘要），压成笼统一句会丢掉唯一有用的线索。
 * - `accio`：三条失败路径的**用户动作完全不同**（未登录 / 一般查询失败 /
 *   响应里没有余额字段），而 `fetchAccioBalanceDetailed` 自己给得出这三句。
 *
 * 故这些渠道给 `fetchBalanceDetailed`，文案由实现自己负责。
 * **绝不允许把「查不到」写成 0**（0 是「已用光」的语义）。
 *
 * ## ⚠️ 为什么是**工厂**而不是常量表
 *
 * `loomy` / `raccoon` / `zcode` 的余额查询走**各自 auth 实例上的方法**
 *（`fetchCreditBalance` / `fetchBalanceFor`），因为那些实例可能带注入的
 * `fetchImpl`（测试替身 / 代理）。重构前 RPC 就是这么调的，这里原样保留。
 * 未传实例时回退到自由函数 + 全局 `fetch` —— 与 `index.ts` 的实际构造
 *（三者都没传 `fetchImpl`）逐字等价，故生产行为不变。
 */

import { CODEBUDDY, WORKBUDDY } from './product.js'
import type { BuddyCredential } from './buddy.js'
import { CLINE } from './cline-product.js'
import { GEMINI } from './gemini.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { LOOMY } from './loomy-product.js'
import { MINIMAX, MINIMAX_INTL } from './minimax-product.js'
import { RACCOON } from './raccoon-product.js'
import { TRAE } from './trae-product.js'
import { fetchClineCreditBalance } from './cline-credits.js'
import { claimCodeArtsDailyCheckin, fetchCodeArtsAccountInfoDetailed } from './codearts-credits.js'
import { fetchGeminiCreditBalance, type GeminiCreditOptions } from './gemini-credits.js'
import { claimLobsteraiDailyCheckin, fetchLobsteraiCreditBalance } from './lobsterai-credits.js'
import { claimLoomyDailyQuota, fetchLoomyCreditBalance } from './loomy-credits.js'
import {
  claimMinimaxDailyCheckin,
  fetchMinimaxCreditBalanceDetailed,
  fetchMinimaxSigninStatus,
} from './minimax-credits.js'
import { fetchRaccoonCreditBalance } from './raccoon-credits.js'
// ⚠️ **本 fork 独有**（魔搭，2026-10-17）：魔粒余额原语。
import { fetchModelscopeBalanceDetailed } from './modelscope-credits.js'
import type { ModelscopeCredential } from './modelscope.js'
import { MODELSCOPE } from './modelscope-product.js'
// ⚠️ 腾讯 Marvis（2026-11-09）：钱包余额原语（`/v3/marvis_get_wallet`）。
import { fetchMarvisBalanceDetailed } from './marvis-credits.js'
import type { MarvisCredential } from './marvis.js'
import { MARVIS } from './marvis-product.js'
// ⚠️ **本 fork 独有**（超级麦吉 Magicrew，2026-10-29）：积分余额原语。
import { fetchMagicrewBalanceDetailed } from './magicrew-credits.js'
// ⚠️ **本 fork 独有**（Magicrew 每日签到，2026-11-01 用户要求接入）：
//    `POST /login-gift`，国内 +200/天、国际 +50/天，两站逐字符同构。
import { claimMagicrewLoginGift } from './magicrew-checkin.js'
import { MAGICREW, MAGICREW_INTL } from './magicrew-product.js'
// ⚠️ **本 fork 独有**（Codely/Unity，2026-10-19）：积分余额原语。
// 2026-10-20 起接每日签到（`/api/points/check-in`，实测 200）。
import { claimCodelyDailyCheckIn, fetchCodelyBalanceDetailed } from './codely-credits.js'
import type { CodelyCredential } from './codely-auth.js'
import { fetchAccioBalanceDetailed } from './accio-credits.js'
import { fetchAstudioBalanceDetailed, claimDaily } from './astudio-credits.js'
// ⚠️ **本 fork 独有**（豆包，2026-10-29）：签到/余额原语（端点待实测，如实 inactive）。
import { claimDoubaoDailyCheckin, fetchDoubaoBalanceDetailed } from './doubao-credits.js'
import type { DoubaoCredential } from './doubao.js'
import { fetchAutoclawBalanceDetailed, claimAutoclawDailyQuota } from './autoclaw-credits.js'
import { AUTOCLAW_INTL } from './autoclaw-product.js'
import { fetchTraeCreditBalance, claimTraeDailyCheckin, fetchTraeCheckinStatus } from './trae-credits.js'
import { collectBuddyGrowth } from './buddy-growth.js'
import { fetchZcodeBalance, type ZcodeBalanceResult } from './zcode-upstream.js'
import {
  claimDailyCheckin,
  fetchCheckinStatus,
  fetchCreditBalance,
  type CheckinStatus,
  type ClaimOutcome,
  type CreditBalance,
  type CreditPackage,
} from './credits.js'
import type { ProviderCredits } from './provider-runtime.js'
import type { CodeArtsCredential, RpcCreditsBalanceExtra } from './types.js'
import type { AccioCredential } from './accio.js'
import type { AstudioCredential } from './astudio.js'
import type { AutoclawCredential } from './autoclaw.js'
import type { ClineCredential } from './cline.js'
import type { GeminiCredential } from './gemini.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { LoomyCredential } from './loomy.js'
import type { MinimaxCredential } from './minimax.js'
import type { RaccoonCredential } from './raccoon.js'
import type { TraeCredential } from './trae.js'
import { participateTraeLottery } from './trae-lottery.js'
import type { ZcodeCredential } from './zcode.js'
// ⚠️ **本 fork 独有**（MonkeyCode，2026-11-02）：平台侧读数（积分余额 / 每日额度 /
//    订阅档位 / 每日签到）。⚠️ 它的读数走**网页 Cookie**（`session_cookie`），
//    与推理用的 `sk-` / `oma_` API Key 是两套凭据 —— 没配会话时一律降级成
//    一句可行动的说明，**绝不抛错**（见 `monkeycode-credits.ts` 模块头）。
import {
  claimMonkeycodeDailyCheckin,
  fetchMonkeycodeBalanceDetailed,
} from './monkeycode-credits.js'
// 百智云（2026-11-02）：积分在**主站控制台**（`baizhi.cloud`），不在模型网关。
//   钱包接口只认网页登录态 cookie；`x-api-key` 打过去一律 401。
//   两套凭据的分工与实测报文见 `baizhi-credits.ts` 模块头。
import { claimBaizhiDailyCheckin, fetchBaizhiBalanceDetailed } from './baizhi-credits.js'
import type { BaizhiCredential } from './baizhi.js'
import { BAIZHI } from './baizhi-product.js'
import type { MonkeycodeCredential } from './monkeycode.js'
import { MONKEYCODE, MONKEYCODE_INTL } from './monkeycode-product.js'

/**
 * 三家「余额查询挂在 auth 实例上」的渠道所需的最小接口。
 *
 * ⚠️ **结构化类型而不是 `LoomyAuth` / `RaccoonAuth` / `ZcodeAuth`**：
 * 本模块只需这三个方法，导入三个 auth 类会把 `@deepseek-ai/cordis` 与
 * 一整套登录流程拖进依赖图 —— 而它只被 `index.ts`（已经持有实例）与
 * 单测使用。结构化类型同时让单测可以传**只带一个方法的替身**。
 */
export interface ProviderCreditsDeps {
  /** Loomy auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
  readonly loomy?: {
    fetchCreditBalance(credential: LoomyCredential): Promise<CreditBalance | null>
    /** 一键签到：触发每日额度（`POST /points/first-login`）。 */
    claimDailyQuota(credential: LoomyCredential): Promise<ClaimOutcome>
  }
  /** Raccoon auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
  readonly raccoon?: {
    fetchCreditBalance(credential: RaccoonCredential): Promise<CreditBalance | null>
  }
  /** ZCode auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
  readonly zcode?: { fetchBalanceFor(credential: ZcodeCredential): Promise<ZcodeBalanceResult | undefined> }
  /**
   * LobsterAI 的**客户端版本号**解析器。
   *
   * ⚠️ 必须**惰性**调用（`() => lobsterai.resolveClientVersion()`），不能注册时
   * 先 await 一个字符串：该值由远端更新接口解析（带 TTL 缓存），把它固化成闭包
   * 里的常量会让「缓存过期后拿到新版本」失效 —— 而它是签到接口的**必填** query 参数。
   */
  readonly lobsteraiClientVersion?: () => Promise<string>
  /**
   * MiniMax **国际站**绕地理分流用的 `X-Forwarded-For` 值（issue IKMEVG）。
   *
   * ⚠️ 必须**惰性**读（`() => pool.minimaxXff()`），不能注册时固化成字符串：
   * 用户随时可能在面板里改这个设置，固化会让「改了却不生效」变成静默失效。
   *
   * ⚠️ 省略等价于「不附头」（与修复前行为逐字节一致）。**只对
   * `minimaxintl` 生效** —— 判据在 `minimaxHeadersFor` 里按 product id 分流。
   */
  readonly minimaxXff?: () => string | undefined
  /**
   * Gemini 的**按账号 fetcher**（Gitee issue IKLTZ2）。
   *
   * ⚠️ Gemini 的配额端点（`retrieveQuotaSummary`）在墙外，而积分行是**用户
   * 点一下就等**的主路径：不接代理时它恒报「配额查询网络失败：fetch failed」，
   * 且**零线索**指向代理。
   *
   * ⚠️ 与其余各家同理，必须**惰性**调用（按 `accountId` 现取），不能在注册时
   * 固化成一份 fetcher —— 账号可能随时在面板里改代理。
   */
  readonly geminiFetchFor?: (accountId: string) => typeof fetch
  /**
   * MiniMax **国际站**的按账号 fetcher（PR !145 审计 P0 修法）。
   *
   * ## ⚠️⚠️ 为什么必须有它（真实缺陷，本 PR 自己声称要修却没修）
   *
   * PR !145 的提交说明与 `index.ts` 注释都写「登录 / 续期 / 目录 / 身份 / 推理 /
   * **积分**六条链路都走 `minimaxIntlFetchForAccount`」，但本文件（三个积分入口
   * 的所在处）**一行都没改** —— 三个原语的第二参仍是 `undefined`（⇒ 默认参数
   * = 全局 `fetch`）。而 `agent.minimax.io` 按出口 IP 国别分流，大陆出口直连
   * 恒 307 到中国站，中国站不认国际站 token ⇒ 401。
   *
   * ⇒ **用户配好代理后，对话能用了，积分行却仍报「余额查询失败」、一键签到仍
   * 失败** —— 症状与 issue IKMEVG 逐字相同，只是从「全部链路」缩到「积分」这一面。
   *
   * ⚠️ 与 {@link geminiFetchFor} **刻意分成两个字段**：两家语义与主机都不同
   *（Gemini 是「墙外连不上」，国际站是「连得上却被分流」），共用会让
   *「清掉一家的代理」连带清掉另一家的出口配置。
   *
   * ⚠️ 同样必须**惰性**调用（按 `accountId` 现取）：账号可能随时在面板里改代理。
   */
  readonly minimaxIntlFetchFor?: (accountId: string) => typeof fetch
}

/**
 * 把 ZCode 的额度桶映射成 `CreditBalance`。
 *
 * ⚠️ **逐桶映射，不是只取第一个桶**（真实缺陷）：旧实现只取
 * `result.planName`（= `buckets[0]?.showName`）拼**一个**包 —— 多桶账号的
 * 其余额度被**静默丢掉**，而 `result.remaining` / `total` 却是**全桶汇总**，
 * 于是那一个包的数字比它自己的 `totalUnits` 还大，自相矛盾。
 * 实测本机账号只回一个桶，但**不能按「只有一个桶」来写** —— 那正是把缺陷
 * 固化成契约。
 *
 * ## 空桶的兜底
 *
 * 上游可能一个桶都不给。此时**不能**返回空 `packages`（前端会显示成
 * 「没有额度」而不是「查不到」），故给一个具名占位包，让 UI 至少能显示
 * 「0 / 0」并带上 `result.planName`。
 */
export function buildZcodeBalance(result: ZcodeBalanceResult): CreditBalance {
  const packages: CreditPackage[] = result.buckets.map((bucket) => {
    const remaining = bucket.availableUnits ?? bucket.remainingUnits ?? 0
    const total = bucket.totalUnits ?? 0
    return {
      name: bucket.showName ?? result.planName ?? 'ZCode 免费额度',
      // ⚠ 单位是 **token**（不是 credit）—— 如实标注，
      // 避免用户以为 ZCode 有 1 亿积分。
      unit: 'token',
      remaining,
      total,
      used: Math.max(0, total - remaining),
      active: true,
      // ZCode 的额度按日刷新（`period: 'one_time'` 的活动包到点失效），
      // 故周期起止都留空，只用 `expiredTime` 给到期时刻。
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: bucket.expiresAt !== undefined
        ? new Date(bucket.expiresAt * 1000).toISOString()
        : (result.expiresAt !== undefined ? new Date(result.expiresAt * 1000).toISOString() : ''),
    }
  })
  if (packages.length === 0) {
    packages.push({
      name: result.planName ?? 'ZCode 免费额度',
      unit: 'token',
      remaining: result.remaining,
      total: result.total,
      used: Math.max(0, result.total - result.remaining),
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: result.expiresAt !== undefined
        ? new Date(result.expiresAt * 1000).toISOString()
        : '',
    })
  }
  /**
   * ★★ 「**已领、但还没到生效时刻**」的计划 —— 单独成一个包（2026-10-23 实测）。
   *
   * ## 为什么必须显示（用户报障）
   *
   * 领完 1024 活动后签到显示「+500.00MToken 领取成功」，**但额度查询仍是 0**
   * ⇒ 用户以为白领了（实测上游：`balances` 桶为空、`plans[]` 里 `status: active`
   * 且 `effective_at` = 23:00 ⇒ 额度**已锁定**、只是还没建桶）。
   *
   * ## 为什么不并进 `remaining`
   *
   * `remaining` 是「**现在就能用**」的额度；并进去会让折算层
   * （`aggregate-expiry.ts` 的 `zcodeExpiry`）判成「有额度」⇒
   * **在生效前就把渠道派发出去**（必然失败：额度还不存在）。
   * ⇒ 独立成包，且 `remaining/total` 都给 0（此刻确实不能用），
   *   只用 `expiredTime` 之外的 `cycleStartTime` 携带**生效时刻**。
   *
   * ⚠ `active: false` —— 它**不是**当前可用额度（前端据此不计入可用合计）。
   */
  for (const pending of result.pendingPlans ?? []) {
    packages.push({
      name: pending.name ?? 'ZCode 活动额度（待生效）',
      unit: pending.unitType ?? 'token',
      remaining: 0,
      total: pending.grantUnits ?? 0,
      used: 0,
      active: false,
      // ⚠ **生效时刻**放在 cycleStartTime（前端「待生效/生效倒计时」读它）。
      cycleStartTime: pending.effectiveAt !== undefined
        ? new Date(pending.effectiveAt * 1000).toISOString()
        : '',
      cycleEndTime: pending.endsAt !== undefined
        ? new Date(pending.endsAt * 1000).toISOString()
        : '',
      expiredTime: pending.endsAt !== undefined
        ? new Date(pending.endsAt * 1000).toISOString()
        : '',
    })
  }
  return {
    // 仍是**全桶汇总**，与 `packages` 逐项之和一致（`fetchZcodeBalance` 就是这么累加的）。
    total: result.remaining,
    // ZCode 不在同一响应里区分「已失效包」，故为 0。
    expiredTotal: 0,
    packages,
  }
}

/** 组装一条「有余额」的带原因结果。 */
function ok(balance: CreditBalance): { balance: CreditBalance } {
  return { balance }
}

/** 组装一条「查不到」的带原因结果（`error` 必须是可读原因，不是 0）。 */
function fail(error: string): { balance: null; error: string } {
  return { balance: null, error }
}

/**
 * TRAE：在**签到收尾**参与 1024 打卡抽奖，并把结果压成**一句话提示**。
 *
 * ## ⚠️⚠️ 三条纪律（每条对应一次真实事故或实测）
 *
 * 1. **绝不影响签到成败**：抽奖是不可逆写操作，且会因「今日已参与」「不在活动期」
 *    「无资格」失败 —— 那些都**不是**签到失败。故本函数**永不抛**，只回提示或 `undefined`。
 *    （本仓库有两轮「登录成功却因记账失败被报成失败」的事故史。）
 * 2. **不该抽时零请求、零提示**：判定为 `skipped`（已抽过 / 窗口外 / 无资格）时
 *    返回 `undefined` ⇒ 调用方不追加任何文案（那是「本来就不该抽」，报出来是噪声）。
 * 3. **奖品如实转述**：真机抽到的是**券**（`prize_text: "AI Build 专属抵扣券"`
 *    + `coupon_face_amount_fen: 1000`），**没有** `credits` 字段 ⇒ 只用积分数会让
 *    「抽到券」退化成「所得未知」，把已知信息白丢。
 *
 * ⚠️ 内部三道闸门见 `trae-lottery.ts`（先读状态 → 只对 `participate` 发请求 → **不重试**）。
 */
async function runTraeLotteryForUi(credential: TraeCredential): Promise<string | undefined> {
  try {
    const result = await participateTraeLottery(credential, TRAE)
    if (result.kind === 'ok') {
      if (result.prizeText !== undefined) return `1024 打卡抽奖：${result.prizeText}`
      if (result.credits !== undefined) return `1024 打卡抽奖：${result.credits} 积分`
      return '1024 打卡抽奖：已参与（所得以 IDE 面板为准）'
    }
    if (result.kind === 'failed') {
      // ⚠️ 服务端文案如实透传（「今日已参与」之类是唯一线索，不得替换成通用话术）。
      return `1024 打卡抽奖未成功：${result.message ?? result.reason ?? '未知原因'}`
    }
    return undefined
  } catch {
    // 抽奖的任何异常都不得上抛（见纪律 1）。
    return undefined
  }
}

/**
 * 构造「id → 积分能力」的表。
 *
 * ⚠️ **只覆盖余额查得到资源包的渠道**。`opencode` 与 `qoder` 系刻意缺席
 *（见文件头），`aggregate` 没有自己的账号与余额。
 */
export function createProviderCredits(
  deps: ProviderCreditsDeps = {},
): Readonly<Record<string, ProviderCredits>> {
  /**
   * MiniMax 国际站该用哪个 fetcher（**三个入口共用这一份判据**）。
   *
   * ## ⚠️⚠️ 为什么抽成一处（PR !145 审计 P0 的修法）
   *
   * 三个入口（余额 / 签到状态 / 领取）都要按账号取出口，而它们的**取法完全相同**。
   * 写成三份内联三元就是本仓库反复记录的「同义判据两份实现必然漂移」——
   * 漏改一份的症状是「余额走了代理、签到没走」，而这种半通状态比全不通更难归因。
   *
   * ## 判据
   *
   * - 没注入 `minimaxIntlFetchFor`（单测 / 旧接线）⇒ **全局 `fetch`**，
   *   与修复前**逐字节等价**；
   * - 注入但拿不到账号 id（`undefined` / 空串）⇒ **全局 `fetch`**：
   *   不知道是谁就不该猜一个账号去用它的出口（那会把请求发到错误的出口上）；
   * - 都拿到 ⇒ 按账号现取（`fetchFor` 内部会读池里的 `minimaxIntlProxy`）。
   *
   * ⚠️ `fetchFor` 在代理串非法时**会抛错**（见 `minimax-proxy.ts` 的模块头：
   * 「归一可能失败，那必须抛错让用户看见，而不是静默退回直连」）。本函数
   * **不吞**它 —— 吞掉就退化成静默直连，那正是这次要消灭的形态。
   */
  const minimaxIntlFetcher = (accountId: string | undefined): typeof fetch => {
    if (deps.minimaxIntlFetchFor === undefined) return fetch
    if (accountId === undefined || accountId === '') return fetch
    return deps.minimaxIntlFetchFor(accountId)
  }

  return {
    /**
     * CodeArts（华为云）：余额搭 `statistics/plugin` 的账户类型检测回来，
     * 故必须用带原因的形态 —— 非积分账户要显示「Token 计费账户」而不是
     * 误导性的「余额查询失败」。
     *
     * ⚠️ 这三条文案是用户报障修来的，**逐字保留**。
     */
    codearts: {
      fetchBalanceDetailed: async (credential) => {
        // 用带原因的版本：`fetchCodeArtsAccountInfo` 只回 null，会把
        // 「AK 限流」「签名失败」「凭据过期」压成同一句笼统文案，
        // 用户与排查者都拿不到线索（本端点就因此把一次 401 显示成了
        // 无信息量的「账户信息查询失败」）。
        const result = await fetchCodeArtsAccountInfoDetailed(credential as CodeArtsCredential)
        if (!result.ok) return fail(`账户信息查询失败：${result.message}`)
        const info = result.info
        if (!info.isCreditPackage) {
          return fail(
            info.isTokenPackage
              ? 'Token 计费账户，无积分余额'
              : '非积分计费账户，无积分余额',
          )
        }
        // 积分账户但没有 credit metric：如实报「无积分数据」，
        // 不显示成 0 —— 0 会让用户以为自己把积分用光了。
        if (info.credit === undefined) return fail('未返回积分数据')
        return ok(info.credit)
      },
      /**
       * CodeArts（华为云）走**签名**协议，与两个腾讯系 provider 都不同源：
       * 领取流程自带「账户类型 + 活动列表」预检（见 `claimCodeArtsDailyCheckin`），
       * 故 `precheckStatus: false` 跳过外部那次 CodeBuddy 式的状态查询 ——
       * 用 `fetchCheckinStatus` 打华为端点既发错请求又必然失败。
       */
      claim: (credential) => claimCodeArtsDailyCheckin(credential as CodeArtsCredential),
      precheckStatus: false,
    },

    lobsterai: {
      fetchBalance: (credential) =>
        fetchLobsteraiCreditBalance(credential as LobsteraiCredential, LOBSTERAI),
      /**
       * LobsterAI 的 `clientVersion` 是签到必填参数，需**动态**解析
       *（带 TTL 缓存，通常无额外网络开销）—— 故必须惰性调用，不能在注册时
       * 固化成常量：缓存过期后拿到新版本这件事会失效。
       *
       * ⚠️ 解析器缺席时回落到产品的兜底常量（与 `lobsterai-adapter.ts` 同法）：
       * 该值一直发假值 `0.1.0` 也没被拒绝，故兜底可用。
       *
       * 领取流程内部已做 slot/context 预检 ⇒ `precheckStatus: false`
       *（外部再查一次纯属重复请求）。
       */
      claim: async (credential) => {
        const clientVersion = deps.lobsteraiClientVersion !== undefined
          ? await deps.lobsteraiClientVersion()
          : LOBSTERAI.fallbackClientVersion
        return claimLobsteraiDailyCheckin(credential as LobsteraiCredential, LOBSTERAI, clientVersion)
      },
      precheckStatus: false,
    },

    trae: {
      fetchBalance: (credential) =>
        fetchTraeCreditBalance(credential as TraeCredential, TRAE),
      /**
       * ⚠️ **必须开启状态预检**（`precheckStatus: true`）。
       *
       * TRAE 的 claim 对「今天已签到」是**幂等**的：实测重复领取同样返回
       * `{code:0, message:"success"}`，与真正领取成功**无法区分**。
       * 早期照抄 LobsterAI 传了 `precheckStatus: false`（那是「领取流程内部
       * 已做 slot/context 预检」的理由，TRAE 没有这回事），于是已签到的账号
       * 被报成「领取成功」（用户报障：**显示成功但 +0 积分**）。
       * 判据只能是状态端点的 `checked_in`。
       *
       * ⚠️ 这里用 {@link ProviderCredits.claimStatus} 而**不是** `fetchStatus`：
       * `credits.status` 对 trae **刻意仍回 `null`**（Task 3 的决定，见该字段注释）。
       */
      claimStatus: (credential) =>
        fetchTraeCheckinStatus(credential as TraeCredential, TRAE),
      claim: (credential, entry, call) =>
        claimTraeDailyCheckin(
          credential as TraeCredential,
          TRAE,
          fetch,
          // ⚠️ 设备指纹代次按 `entry.id` 从**账号池**读写 —— 这是 `claim` 必须
          //    收 `entry` 的唯一理由（见 ProviderCredits.claim 的注释）。
          call.accountPool.traeCheckinDeviceGenerationFor(entry.id),
          (next) => call.accountPool.updateTraeCheckinDeviceGeneration(entry.id, next),
        ),
      /**
       * ★★ **签到收尾顺带参与 1024 打卡抽奖**（2026-10-20 用户指定：
       *    「点签到按钮时触发」）。
       *
       * ## ⚠️⚠️ 为什么**不能**挂在 `claim` 里（第一版就是这么写的，实测失效）
       *
       * 本家 `precheckStatus: true` ⇒ `credits.claimAll` 会**先查状态**，
       * 今天已签到就直接回 `already-claimed`、**根本不调 `claim`**。
       * 而「已签到」恰恰是最该抽奖的时机（签到后才解锁抽奖）
       * ⇒ 挂在 claim 内等于**几乎永不触发**。
       * 用户实测：4 个账号全显示「今天已签到」，一条抽奖信息都没有。
       *
       * ⇒ 改挂 `afterClaimNote`：它对 `claimed` **与** `already-claimed` 都会跑。
       */
      afterClaimNote: (credential) => runTraeLotteryForUi(credential as TraeCredential),
      precheckStatus: true,
    },

    /**
     * ModelScope（魔搭）：**本 fork 独有**（2026-10-17 接入魔粒余额）。
     *
     * ⚠️⚠️ **这一条推翻了 PR 的核心前提**。PR（及本仓库一度）判定「魔搭没有额度
     * 查询 API」并把 `credits.balance` 登记为 `false`、还写进了豁免表。**那是错的**：
     * 真端点是 `GET https://www.modelscope.cn/openapi/v1/magicubes/balance`，
     * **带 API Key 直接返 200**（实测 281 → 发 2 次推理 → 277，恰好 -4）。
     * ⇒ 不需要网页登录态、不需要 cookie、不需要起浏览器。
     *
     * ⚠️ 用 {@link ProviderCredits.fetchBalanceDetailed}：三种失败的**用户动作**
     * 完全不同（Key 失效 → 重生成；端点侧拒绝 → 多半是账号未实名，换 Key 无用；
     * 缺字段 → 上游改版该报「读数格式变了」），压成笼统的「查询失败」会误导。
     */
    modelscope: {
      fetchBalanceDetailed: async (credential) =>
        fetchModelscopeBalanceDetailed(credential as ModelscopeCredential, MODELSCOPE),
    },

    /**
     * 腾讯 Marvis（2026-11-09）：**本 fork 独有**。
     *
     * 真端点 `POST https://yybadaccess.3g.qq.com/v3/marvis_get_wallet`（UAL 业务
     * 签名头 + body `"{}"`），实测 200 返回
     * `{total_tokens:"10000000", used_tokens:"0", frozen_tokens:"0",
     *   avail_tokens:"10000000", total_cost:0, status:1}` ——
     * ⚠️ **数字是字符串**（解析在 `fetchMarvisBalanceDetailed` 内），且
     * ⚠️ **没有任何日期字段** ⇒ 包必须标 `expiryUnknown`（不得编造每日重置时刻）。
     *
     * ⚠️ 用 `fetchBalanceDetailed`（不是 `fetchBalance`）：401/403 / 业务码非 0 /
     * 缺字段三种失败的**用户动作**完全不同（重新登录 / 上游改版 / 账号未开通），
     * 压成笼统的「查询失败」会误导。
     */
    marvis: {
      fetchBalanceDetailed: async (credential) =>
        fetchMarvisBalanceDetailed(credential as MarvisCredential, MARVIS),
      /**
       * ⚠️ 2026-11-09 整支评审 M5：Marvis **没有**签到端点（钱包 `/v3/marvis_get_wallet`
       * 是只读的，9 条候选端点全 404）。UI 隐藏了「一键签到」按钮，但绕过 UI 调
       * `credits.claimAll` 时若不给这句，用户拿到的是泛化的
       * `unsupported provider: marvis` —— 而 `provider-runtime.ts` 的头注释明写
       * 「能力缺失必须给可读文案、不得退化成 unsupported provider」。
       */
      claimUnavailableReason: 'Marvis 没有每日签到接口：令牌额度由服务端每日发放，无需手动领取',
    },

    /**
     * Codely（Unity 团结引擎）：**本 fork 独有**（2026-10-19 接入积分余额）。
     *
     * 真端点 `GET /api/user/usage/summary`（Bearer + X-User-Agent），实测 200
     * 返回 `remaining_points:"2400"` —— ⚠️ 数字是**字符串**，解析在
     * `fetchCodelyBalanceDetailed` 内（string | number 双形态）。
     *
     * ⚠️ registry 里 `channel:false` 但 `balance:true` —— 这是全仓第一例
     * 「有余额能力、无 auth 服务」的组合：登录走设备码纯函数（无 XxxAuth）、
     * 余额原语是自由函数，二者都不需要 auth 实例。它**不**违反
     * `provider-runtime-wiring.spec.ts` 那条「balance ⇒ runtime.credits」守卫 ——
     * 该守卫只检查**已注册 runtime** 的渠道，codely 没有 runtime（无 adapter）
     * 而被跳过；端点侧的表（`jet-hub-rpc.ts` 的 `createProviderCredits`）
     * 不依赖 runtime。
     */
    codely: {
      fetchBalanceDetailed: async (credential) =>
        fetchCodelyBalanceDetailed(credential as CodelyCredential),
      /**
       * 每日签到（2026-10-20 实测接通）：两步端点
       * `POST /api/points/check-in/init` → `POST /api/points/check-in`，
       * 幂等判据在 `init` 的 `can_check_in`，**内部自带状态预检** ⇒
       * `precheckStatus: false`（与 autoclaw / codearts 同因：外部再查一次
       * 属于重复请求，且骨架默认的 buddy 式 `fetchCheckinStatus` 打它的端点
       * 必然失败 —— 那是一次发错端点的真实上游请求）。
       *
       * ⚠️ 网页 dashboard 同款流程；官方 CLI 二进制里没有签到调用（它只管
       * 推理/余额），端点来源是网页 SPA bundle —— 见 `codely-credits.ts`。
       */
      claim: (credential) => claimCodelyDailyCheckIn(credential as CodelyCredential),
      precheckStatus: false,
    },

    /**
     * Cline：协议原语自带**具体**原因（含 HTTP 状态码与错误体摘要），
     * 压成「余额查询失败」会丢掉唯一有用的线索。
     *
     * ⚠️ 它的 `claimUnavailableReason` 与条目一起写在下方（与 buddy 系同处），
     * 免得同一家的字段散落两处。
     */
    cline: {
      fetchBalanceDetailed: async (credential) => {
        const result = await fetchClineCreditBalance(credential as ClineCredential, CLINE)
        // 查不到时带上具体原因，而不是笼统一句「查询失败」—— 卡片显示原因而非 0
        //（0 是「已用光」的语义，会误导用户）。
        return result.balance === null
          ? fail(result.error ?? '积分查询失败（凭据失效或响应异常）')
          : ok(result.balance)
      },
      claimUnavailableReason: 'Cline 不支持每日签到（其后端没有签到接口）',
    },

    /** Loomy：`/points/records`（**只读**，无副作用；`first-login` 是写端点）。 */
    loomy: {
      fetchBalanceDetailed: async (credential) => {
        // ⚠️ 判**方法存在**而不是 `deps.loomy !== undefined`：调用方常常只持有
        //   一个部分替身（单测的 `{}` 桩），用 `!== undefined` 会走进
        //   `undefined is not a function` 并被骨架吞成一条笼统错误 —— 那正是
        //   「静默降级」的形态。判方法则如实回退到自由函数。
        const viaInstance = deps.loomy?.fetchCreditBalance
        const balance = typeof viaInstance === 'function'
          ? await viaInstance.call(deps.loomy, credential as LoomyCredential)
          : await fetchLoomyCreditBalance(credential as LoomyCredential, LOOMY)
        // 查不到时带原因（不显示成 0，0 是「已用光」的语义）。
        return balance === null ? fail('积分查询失败（凭据失效或响应异常）') : ok(balance)
      },
      /**
       * Loomy 的「签到」= `POST /points/first-login`（触发每日赠送额度）。
       *
       * ⚠️ 语义**不是**「+5000 积分」：`dailyBalance = dailyQuota - dailyConsumed`，
       * 消耗后不回补。文案由 `claimLoomyDailyQuota` 的 `already-claimed` 表达。
       *
       * ⚠️ **必须显式 `precheckStatus: false`，这是最容易漏的一格**：
       * 它**没有**独立的签到状态端点（幂等判据在 claim 响应体的 `alreadyProcessed`），
       * 而骨架的默认值是 true ⇒ 不传 false 时骨架会拿 **buddy 式**的
       * `fetchCheckinStatus` 去打 Loomy 端点 —— 一次**必然失败的真实上游请求**。
       *
       * ⚠️ 走的是**共享骨架**（不再自写循环）：`claimLoomyDailyQuota` 已返回
       * `ClaimOutcome`，与骨架的 `claim` 入参同型。旧 RPC 分支之所以自己写循环，
       * 只是因为当时它按「不传 product」的方式调用 —— **不是语义不兼容**。
       * 三个返回分支都**没有**设 `coversToday` ⇒ 一律 `true`（「今天已处理过」），
       * 与旧循环逐条一致（`already-claimed` 也算今天处理过）；由
       * `tests/unit/claim-runtime-parity.spec.ts` 显式锁住。
       */
      claim: async (credential) => {
        const viaInstance = deps.loomy?.claimDailyQuota
        return typeof viaInstance === 'function'
          ? await viaInstance.call(deps.loomy, credential as LoomyCredential)
          : await claimLoomyDailyQuota(credential as LoomyCredential, LOOMY)
      },
      precheckStatus: false,
    },

    /** Raccoon：`/points/v1/balance`（**只读**，无副作用）。 */
    raccoon: {
      fetchBalanceDetailed: async (credential) => {
        const viaInstance = deps.raccoon?.fetchCreditBalance
        const balance = typeof viaInstance === 'function'
          ? await viaInstance.call(deps.raccoon, credential as RaccoonCredential)
          : await fetchRaccoonCreditBalance(RACCOON, credential as RaccoonCredential)
        // ⚠️ 查不到时带原因（**不显示成 0** —— 0 是「已用光」的语义，
        // 把「查询失败」显示成 0 会让用户以为自己积分没了）。
        return balance === null ? fail('积分查询失败（凭据失效或响应异常）') : ok(balance)
      },
      /**
       * ⚠️ **raccoon 没有签到端点**：每日 300 积分由服务端按日自动发放
       *（账单里的 `daily_grant`，实测注册后 1 分钟即到账）⇒ **刻意不提供 `claim`**。
       * 客户端按能力矩阵（`raccoon: { balance: true, onboardingTasks: true }`，
       * **无** `dailyCheckin`）根本不会渲染「一键领取积分」按钮。
       *
       * ⚠️ 文案**逐字保留**，含那句可操作指引「登录奖励请在『新手任务』中领取」
       * —— 用户看完才知道下一步该点哪里（压成泛化模板会丢掉它）。
       */
      claimUnavailableReason: 'Raccoon Work 不支持每日签到（每日积分由服务端自动发放；'
        + '登录奖励请在「新手任务」中领取）',
    },

    /**
     * Accio（阿里）：三个**只读**端点聚合出的带原因余额。
     *
     * ⚠️ **必须用 `fetchBalanceDetailed`**（不是 `fetchBalance`）：三类失败
     * 的用户动作**完全不同** —— 未登录（去重新登录）/ 一般查询失败（查网络）/
     * 响应里没有余额字段（上游形状变了）。压成共享骨架那句笼统的
     * 「余额查询失败」会让用户按错误方向排查，而这三条文案是 Task 5 实测修来的。
     *
     * ⚠️ **刻意不提供 `claim`**：Accio **没有签到端点**（每日 200 积分由
     *    **登录**触发服务端发放），故也**不给 `claimUnavailableReason`** ——
     *    客户端按能力矩阵（`dailyCheckin: false`）根本不会渲染「一键领取积分」，
     *    与 raccoon 同形。给它一句文案反而会让面板多出一个永远点不动的入口。
     */
    autoclaw: {
      fetchBalanceDetailed: async (credential) =>
        await fetchAutoclawBalanceDetailed(credential as AutoclawCredential),
      /**
       * ⚠️ **必须把 `call.warn` 与 `call.persistCredential` 透传下去**
       * （2026-10-27 Gitee PR #153 审计 P0/P1-3）：
       * - `warn`：刷新失败原先被裸 `catch` 吞掉，`outcome` 与成功逐字相同 ⇒
       *   用户永远不知道「活动奖励其实没发」；
       * - `persistCredential`：刷新**可能轮换** `refresh_token`，新值若没人接住，
       *   旧值立即作废 ⇒ 账号续期能力被**逐日烧掉**（详见
       *   `ProviderCallContext.persistCredential` 的长注释）。
       *   ⚠️ 这里用 `entry.credentialRef` 绑 ref —— 与 `resolve` 那条腿**同一个
       *   ref 约定**（`credentialRef(entry.credentialRef)`），不要自己拼。
       */
      claim: (credential, entry, call) =>
        claimAutoclawDailyQuota(credential as AutoclawCredential, {
          warn: (message) => call?.warn(message),
          ...call?.persistCredential === undefined
            ? {}
            : {
                persist: (next: AutoclawCredential) =>
                  call.persistCredential!(
                    entry?.credentialRef as unknown as string,
                    JSON.stringify(next),
                  ),
              },
        }),
      precheckStatus: false,
    },
    /**
     * **AutoClaw 国际版**（`autoclawintl`）。
     *
     * ⚠️⚠️ **必须显式传 `product: AUTOCLAW_INTL`** —— 不传会走默认的国内基址，
     *    用户的国际账号余额恒查不到（表现为 `410000 用户未登录`）。
     *    这是「同一实现两个实例」最容易踩的一处：`fetchAutoclawBalanceDetailed`
     *    的默认参数是 `AUTOCLAW`（国内），漏传会**静默**查错站。
     *
     * 实测（2026-10-20）：国际站返回 `code=0`、`total_balance=13000`，
     * 两个批次包（`AutoClaw Weekly Perks` 3000 / `New-user credits` 10000）。
     */
    autoclawintl: {
      fetchBalanceDetailed: async (credential) =>
        await fetchAutoclawBalanceDetailed(
          credential as AutoclawCredential,
          { product: AUTOCLAW_INTL },
        ),
      /** 与 `autoclaw` 同形（含 `warn` / `persistCredential` 透传），只差产品基址。 */
      claim: (credential, entry, call) =>
        claimAutoclawDailyQuota(credential as AutoclawCredential, {
          product: AUTOCLAW_INTL,
          warn: (message) => call?.warn(message),
          ...call?.persistCredential === undefined
            ? {}
            : {
                persist: (next: AutoclawCredential) =>
                  call.persistCredential!(
                    entry?.credentialRef as unknown as string,
                    JSON.stringify(next),
                  ),
              },
        }),
      precheckStatus: false,
    },
    accio: {
      fetchBalanceDetailed: async (credential) =>
        await fetchAccioBalanceDetailed(credential as AccioCredential),
    },

    /**
     * 豆包（Doubao，字节跳动）：签到/余额结构已接通，**上游端点待实测**。
     *
     * ⚠️ 用 `fetchBalanceDetailed` + 显式 `claim`：两个原语（`doubao-credits.ts`）
     *    在凭据缺失时给出可读原因，在端点未实测时如实回 `null` / `inactive`
     *   （不落 0、不发假请求）。将来拿到真实端点后，只需把这两个原语换成
     *    实测实现，本表项**不用动**（签名已对齐骨架）。
     */
    doubao: {
      fetchBalanceDetailed: async (credential) =>
        await fetchDoubaoBalanceDetailed(credential as DoubaoCredential),
      claim: async (credential) =>
        await claimDoubaoDailyCheckin(credential as DoubaoCredential),
      // ⚠️ `precheckStatus: false`：本家没有独立的签到状态端点（claim 内部
      //    直接回 inactive），骨架默认会用 buddy 式 `fetchCheckinStatus` 去打它
      //    —— 那是一次发错端点的真实请求。与 codely / loomy 同因。
      precheckStatus: false,
    },

    /**
     * AStudio（讯飞 AstronStudio）：额度来自账号后端
     * `GET /xingchen-studio/points/balance`，只认 Cookie 的 ssoSessionId。
     *
     * ⚠️ 同样**必须用 `fetchBalanceDetailed`**（不是 `fetchBalance`）：三类失败的
     * 用户动作完全不同 —— 会话失效（HTTP 恒 **200** + `code=80000`，唯一出路是去
     * 客户端**人工重登**，实测无程序化续期接口）/ 服务不可用（可重试，**不得**报成
     * 需重登，那会让用户白重登一次）/ 响应里没有 `totalBalance`（上游形状变了）。
     * 查不到时由 `astudio-credits.ts` 返回 `null` + 原因，**绝不写成 0**。
     *
     * ⚠️ **签到已接入**（2026-10-16 推翻早期「AStudio 无签到端点」的推论）：
     * `client-popups/pending` 取待领弹窗（`DAILY_REWARD_DIALOG` / `NEW_USER_DIALOG`）
     * → `client-popups/complete` 领取，实现在 `astudio-credits.ts` 的 `claimDaily`，
     * 事实登记见 `docs/agent-notes/providers-astudio.md` §3。
     * 能力矩阵因此是 `dailyCheckin: true`（`provider-registry.ts:460`），
     * 客户端**会**渲染「一键领取积分」。
     *
     * ⚠️ 本条曾写作「**刻意不提供 `claim`**……能力矩阵里 `dailyCheckin: false`
     * ⇒ 客户端根本不渲染」——那是被本 PR 自己的文档 §3 推翻的**旧结论残留**，
     * 与紧邻的实现（下面的 `claim`）**逐字相反**。2026-10-18 审计订正。
     */
    astudio: {
      fetchBalanceDetailed: async (credential) =>
        await fetchAstudioBalanceDetailed(credential as AstudioCredential),
      claim: async (credential) =>
        await claimDaily(credential as AstudioCredential),
      precheckStatus: false,
    },

    /**
     * ZCode：额度单位是 **token**（不是积分）。`balance: null` 表示**查不到**
     * （不显示成 0，0 是「已用光」的语义）。
     */
    zcode: {
      fetchBalanceDetailed: async (credential) => {
        const viaInstance = deps.zcode?.fetchBalanceFor
        const result = typeof viaInstance === 'function'
          ? await viaInstance.call(deps.zcode, credential as ZcodeCredential)
          : await fetchZcodeBalance(credential as ZcodeCredential)
        if (result === undefined) return fail('额度查询失败（凭据失效或网络异常）')
        // 企业版不下发额度数字、只给外部链接 —— 如实说明，不显示 0。
        if (result.enterprise === true) {
          return fail('企业版账号不下发额度数字，请在 ZCode 内查看')
        }
        return ok(buildZcodeBalance(result))
      },
    },

    /**
     * MiniMax Code **中国版**：`GET /minimax-cloud/api/v1/credit/details`。
     *
     * ⚠️ 该端点是**平铺响应**（`total_count` 与 `base_resp` 同级、没有 `data` 键），
     * `fetchMinimaxCreditBalance` 内部已兼容两种形状。
     * ⚠️ 查不到时（null）由共享骨架统一补「余额查询失败」—— 卡片显示原因而非 0
     *（本机实测 `total_count: 0` 且 `details` 缺失正是「真的为 0」）。
     *
     * ⚠️ 第二个实参传 `undefined`（**不是** `fetch`）：三个原语的签名是
     * `(credential, fetcher = fetch, product = MINIMAX)`，传 `undefined` 会触达
     * 同一个默认参数 ⇒ 与「不传」逐字节等价，只把**站点**显式钉住。
     */
    minimax: {
      /**
       * ⚠️⚠️ **必须走 `fetchBalanceDetailed`**（真实缺陷，2026-10-17 审计打穿）。
       *
       * `fetchBalance` 的 `null` 会被共享骨架统一补一句写死的「余额查询失败」，
       * 于是 `requestEnvelope` 辛苦构造的地理路由两条出路 / `invalid signature` /
       * `凭据已失效` **一行都到不了 UI** —— 用户报障的那句话修复后逐字未变。
       * ⇒ 本家正式加入 `fetchBalanceDetailed` 那一批（codearts / gemini / cline…），
       * 原因由实现自己给。
       */
      fetchBalanceDetailed: async (credential) => {
        const { balance, error } = await fetchMinimaxCreditBalanceDetailed(
          credential as MinimaxCredential, undefined, MINIMAX,
        )
        return { balance, ...error === undefined ? {} : { error } }
      },
      // ⚠️ **有**独立的签到状态端点，与「如实返回 null」的那几家不同。
      // 判据是 `is_today && status===3`（见 `minimaxPanelToCheckinStatus`），
      // 不是「没有 Claimable」。`active` 恒 true（拿到响应即 true）。
      //
      // ⚠️ 它同时是**领取预检**的数据源（`precheckStatus` 缺省 true，见下）——
      //    预检与面板读数是同一个端点，故**只声明一次**（不再写 `claimStatus`：
      //    两处声明同一实现会漂移）。
      //
      // ⚠️ 预检只需要「能不能判」，不需要原因 ⇒ 用无原因的简单变体即可。
      fetchStatus: (credential) =>
        fetchMinimaxSigninStatus(credential as MinimaxCredential, undefined, MINIMAX),
      /**
       * ⚠️ **必须开启状态预检**（`precheckStatus` 缺省 true，不要传 false）。
       *
       * 理由与 TRAE 同型：`claimMinimaxDailyCheckin` 靠响应体的 `claim_result`
       * 判幂等（`1`=真领取、`2`=已领过），这在 **HTTP 层**是可靠的；但状态预检是
       * 第二道防线 —— 若某天服务端对已领账号也回 `claim_result: 1`，预检能靠
       * `todayCheckedIn` 先挡住，避免把「今天已领」报成「+积分」。
       * 反之传 false 会让已签到账号走到 claim 请求（多发一次 POST）。
       */
      claim: (credential) =>
        claimMinimaxDailyCheckin(credential as MinimaxCredential, undefined, MINIMAX),
    },

    /**
     * MiniMax Code **国际版**（`minimaxintl`）—— 与上面的中国版**同形**，
     * 只把 `product` 换成 {@link MINIMAX_INTL}（主机 `agent.minimax.io`、
     * ref 前缀 `MINIMAXINTL_*`）。
     *
     * ⚠️ **必须各占一条**：三个原语都用 `product.apiHost` 构造 URL —— 共用一条
     * 会让国际站账号的签到/余额打到 `agent.minimax.cn`，而两站**账号不互通**
     * ⇒ 必然 401，症状是「国际站账号的积分永远查询失败」，且**不报错到面板以外**。
     *
     * ⚠️ **验证状态如实标注**（2026-10-16 合并审计修正 —— 原文写「三项未真机验证」
     * 并指向一个**并不存在**的「未实测清单」，与 `src/minimax-product.ts`
     * 文件头的「✅ 已真机验证」互相否定）：**签到 / 积分三个入口已真机验证通过**
     * （2026-10-15，真实国际站账号返回 200；见 `src/minimax-product.ts` 文件头与
     * `tests/e2e/minimaxintl-probe.e2e.spec.ts`）。**未验证的只有兜底模型表**
     * （与国内站共用同一份，仅远端失败时兜底）。
     *
     * ⚠️ **`X-Forwarded-For` 必须传**（issue IKMEVG，2026-10-17 真机实测）：
     * `agent.minimax.io` 按**出口 IP 国别**把中国大陆来源 307 到中国站，而
     * 跟到中国站后国际站 token 只会得到 `401 invalid access token`
     *（与「凭据失效」逐字同形）。用户可在面板里填一个海外 IP 绕开这个分流；
     * 不填则行为与修复前完全一致（不附该头）。
     *
     * ⚠️ 每次调用**现读** `deps.minimaxXff()`（用户随时可能改设置）。
     *
     * ⚠️⚠️ **三个入口都必须走该账号的出口**（PR !145 审计 P0 修法，真实缺陷）：
     * PR !145 只把按账号 fetcher 接进了 `BuddyBalanceSelector`（**选号器**），
     * 而**积分面板**走的是本文件的三个入口 —— 它们当时仍传 `undefined`
     *（= 全局 `fetch`）⇒ 配好代理后对话能用、积分行却仍报「余额查询失败」、
     * 一键签到仍失败。症状与 issue IKMEVG 逐字相同。
     *
     * ⚠️ **三个入口的「账号 id 从哪来」并不相同**（实测三个调用点的签名，
     * 别按「看起来统一」去改）：
     *
     * | 入口 | 第二参 | 账号 id 来源 |
     * |---|---|---|
     * | `fetchBalanceDetailed` | `call: ProviderCallContext` | `call?.accountId` |
     * | `fetchStatus` | `product`（**不是** call） | 拿不到 ⇒ 直连（见下） |
     * | `claim` | `entry: ProviderAccountEntry` | `entry.id` |
     *
     * ⇒ `fetchStatus` 那条**结构上拿不到账号 id**（骨架 `collectCreditsStatus` /
     * `collectClaimResults` 传的第二参都是 `product`），故它只能直连。这是
     * **如实登记的限制**，不是漏改：要修它得先改两个骨架的签名（波及十家
     * provider 的 `fetchStatus` 实现），超出本次修复范围。
     * ⚠️ 后果：**签到状态预检**在国际站上仍走直连 ⇒ 大陆出口下 `credits.status`
     * 与「一键签到」的预检那一步仍可能失败。`claim` 本身已走代理。
     */
    minimaxintl: {
      // ⚠️ 走 Detailed（理由同中国版）：否则「地理分流 / 凭据失效 / 网关签名」
      //    这些**唯一能指路**的原因会被压成一句「余额查询失败」。
      fetchBalanceDetailed: async (credential, call) => {
        const { balance, error } = await fetchMinimaxCreditBalanceDetailed(
          credential as MinimaxCredential,
          minimaxIntlFetcher(call?.accountId),
          MINIMAX_INTL,
          deps.minimaxXff?.(),
        )
        return { balance, ...error === undefined ? {} : { error } }
      },
      // ⚠️ **第二参是 `product` 不是 `call`**（`ProviderCredits.fetchStatus` 的
      //    签名是 `(credential, call)`，但两个骨架调用点传的都是 `product` ——
      //    见上表的限制说明）。这里**刻意显式忽略**该参并直连：
      //    硬写 `(credential, call) => ... call?.accountId` 会得到一个恒
      //    `undefined` 的 `accountId`（因为传进来的是 product），
      //    症状是「看起来接了代理、实际永远直连」—— 比不接更难查。
      fetchStatus: (credential) =>
        fetchMinimaxSigninStatus(
          credential as MinimaxCredential,
          undefined,
          MINIMAX_INTL,
          deps.minimaxXff?.(),
        ),
      // 预检与幂等理由同中国版（见上）。
      //
      // ⚠️ **第二参是 `entry` 不是 `call`**（`ProviderCredits.claim` 的签名是
      //    `(credential, entry, call)` —— 收 `entry` 是为了 TRAE 的指纹代次）。
      //    账号 id 从 `entry.id` 取。
      //    ⚠️ 写成 `call?.accountId` 会**编译不过**（`entry` 上没有该字段），
      //    这正是它比运行时静默更安全的地方 —— 别为了「看起来统一」而改签名。
      claim: (credential, entry) =>
        claimMinimaxDailyCheckin(
          credential as MinimaxCredential,
          minimaxIntlFetcher(entry.id),
          MINIMAX_INTL,
          deps.minimaxXff?.(),
        ),
    },

    /**
     * Gemini：余额 = **配额窗口**（不是充值积分），两个桶的剩余比例。
     * 「未授权」与「查询失败」是两回事，故用带原因的形态。
     *
     * ⚠️ 账号规格（Pro / Free / Ultra）搭这趟车回来：`loadCodeAssist` 与配额
     * 是同一函数里**并行**发的两个端点，档位挂在 `result.tier` 上。这里翻译成
     * 面板要的 `extra.accountTier` —— `label` 是短标签（面板只放得下一个词），
     * `title` 是上游原文（hover 才看得到）。取不到时 `extra` 缺席，
     * 面板不渲染那一行（**不是错误**）。
     */
    gemini: {
      fetchBalanceDetailed: async (credential, call) => {
        const accountId = call?.accountId
        // ⚠️ **省略 fetcher 时恒直连**（缺 `geminiFetchFor` 的单测与兜底），
        // 这里只在解析器在场且拿到了账号 id 时传 —— 保持「三者都没传时逐字
        // 等价」的既有约定（不少单测只注入 credential）。
        // ⚠️ 必须**先建对象再展开**：三元里的条件表达式直接展开会得到
        // `{} | {fetcher}` 联合类型，tsc 判它不可迭代（TS2488）。
        const creditOptions: GeminiCreditOptions = (
          deps.geminiFetchFor === undefined || accountId === undefined || accountId === ''
            ? {}
            : { fetcher: deps.geminiFetchFor(accountId) }
        )
        const { balance, error, tier } = await fetchGeminiCreditBalance(
          credential as GeminiCredential, GEMINI, creditOptions,
        )
        const extra: RpcCreditsBalanceExtra | undefined = tier === undefined
          ? undefined
          : { accountTier: { label: tier.label, title: `${tier.name}（${tier.id}）` } }
        return {
          balance,
          ...error === undefined ? {} : { error },
          ...extra === undefined ? {} : { extra },
        }
      },
    },

    buddy: {
      fetchBalance: (credential) =>
        fetchCreditBalance(credential as BuddyCredential, CODEBUDDY),
      fetchStatus: (credential) =>
        fetchCheckinStatus(credential as BuddyCredential, CODEBUDDY),
      // 预检与面板读数是同一个端点 ⇒ 只声明 `fetchStatus`（端点回落到它），
      // 不再写一份 `claimStatus`（两处声明同一实现必然漂移）。
      claim: (credential) =>
        claimDailyCheckin(credential as BuddyCredential, CODEBUDDY),
      /**
       * ⚠️ **成长中心（22 项任务）的唯一入口** —— 只有 CodeBuddy 中国版提供。
       *
       * ⚠️ 产品配置由**本闭包捕获**（`CODEBUDDY`），不从调用侧转发：通用分支
       * 拿不到 product（它传 `undefined`），转发过去就是
       * `collectBuddyGrowth(credential, undefined, …)`，成长中心当场打坏。
       *
       * ⚠️ `workbuddy`（国际版）**刻意不提供**：contributor 在 !62 复审中实测确认
       * `www.workbuddy.ai` 后端**根本没有成长中心**（无任务列表、无 claim 端点）。
       */
      afterClaim: (credential, entry, run) =>
        collectBuddyGrowth(
          credential as BuddyCredential, CODEBUDDY, entry, run.budgetMs, run.roundDeadlineAt,
        ),
    },

    workbuddy: {
      fetchBalance: (credential) =>
        fetchCreditBalance(credential as BuddyCredential, WORKBUDDY),
      // ⚠️ 国际版**没有签到接口**，但**状态端点**与余额一样存在（两个产品通用），
      // 故这里注册 fetchStatus。真正禁止的是 `claimAll`（那由能力表与
      // `credits.claimAll` 的显式守卫成对拦住）。
      fetchStatus: (credential) =>
        fetchCheckinStatus(credential as BuddyCredential, WORKBUDDY),
      /**
       * ⚠️ **这条守卫是载荷性的，必须有**：没有它时 `workbuddy` 会落到
       * `credits.claimAll` 的通用分支，用**国际版**凭据去发**国内版**的签到
       * 请求 —— 必然失败，而且是一次**真实的上游请求**。而「每日首次启动自动
       * 签到」（`src/auto-checkin.ts`）正是靠「调 `claimAll`、按返回的信封判
       * 跳过」来决定遍历范围的，它**不维护第二份能力名单** ⇒ 这里漏一个守卫，
       * 它就会真去发一轮必然失败的请求。
       */
      claimUnavailableReason: 'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）',
    },

    /**
     * 超级麦吉（Magicrew，2026-10-29）。
     *
     * ⚠️ 用 `fetchBalance` 而不是 `fetchBalanceDetailed`：本家的失败面只有「读不到」
     * 一种（网络 / 业务码非 1000 / 缺 `total_points`），没有需要让用户做**不同动作**
     * 的子原因 —— 而 `fetchBalanceDetailed` 的存在理由正是「三种失败的出路不同」
     * （见 {@link ProviderCredits.fetchBalanceDetailed} 的注释）。
     * ⚠️ `?? null`：原语用 `undefined` 表达「读不到」，而本接口契约是 `null`
     * —— 两者**同义**，但 `undefined` 会被上层当成「没实现」。
     * ## ✅ `claim`（2026-11-01 用户要求接入）
     *
     * `POST /api/v1/login-gift`，**请求体存在且为空串**（`body: ''` ——
     * ⚠️ **不是省略 body**：参考实现也显式发空串，删掉它就是协议回归），
     * 幂等（当天已领回 `granted:false`，HTTP 仍 200）。
     * 国内站 **+200/天**、国际站 **+50/天**，两站逐字符同构 ⇒
     * 两家共用 `claimMagicrewLoginGift`，只差传进来的 `product`。
     *
     * ⚠️ **不会重复扣/领**：端点本身幂等，且 `granted:false` 被映射成
     * `already-claimed`（**不是** `claimed`）—— 后者会让用户以为每天真的加了积分。
     * ⚠️ 原先这里写「刻意不接（会消耗真实积分）」是**误判**：`login-gift` 是
     * **发放**登录积分，不消耗任何东西。用户 2026-11-01 明确要求接上。
     */
    /**
     * 超级麦吉（Magicrew，2026-10-29）。
     *
     * ## ⚠️⚠️ 必须用 `fetchBalanceDetailed`（2026-11-04 真机更正）
     *
     * 原注释写「本家的失败面只有『读不到』一种（网络 / 业务码非 1000 / 缺
     * `total_points`），没有需要让用户做**不同动作**的子原因」—— **那句被真机
     * 报障证伪**：同一天两站九个账号全部返回 **HTTP 403**（本机代理出口在境外，
     * 上游火山 WAF 按来源地区拒绝），而卡片只有一句「余额查询失败」，用户被引去
     * 重登、去查组织码，白做一整轮 —— 凭据其实一个都没坏。
     *
     * 三类成因的用户动作**完全不同**：403 ⇒ 改代理 / 直连；401 ⇒ 重新登录；
     * 业务码 `2182` ⇒ 登录时没选组织。这正是 {@link ProviderCredits.fetchBalanceDetailed}
     * 的存在理由（与上面 `codearts` 那条「非积分账户」同因）。
     *
     * ⚠️ `?? null` 那套不再需要：详细变体自带 `balance: null + error` 契约；
     * 凭据缺 `jwt` 时直接给一句**能指认**的原因，而不是回落到「余额查询失败」。
     * ⚠️ `product` 必须**显式传**（2026-11-01 三审）：原靠 `?? MAGICREW` 缺省，
     * 而国际站条目显式传 ⇒ 两条腿不对称，后人照抄国内条目到新站就会静默打错 host。
     */
    magicrew: {
      fetchBalanceDetailed: async (credential) => {
        const parsed = credential as { jwt?: unknown, organizationCode?: unknown } | null | undefined
        if (typeof parsed?.jwt !== 'string' || parsed.jwt.length === 0) {
          return fail('账号未登录（缺少 JWT），请重新登录')
        }
        return await fetchMagicrewBalanceDetailed({
          jwt: parsed.jwt,
          organizationCode: typeof parsed.organizationCode === 'string' ? parsed.organizationCode : '',
          product: MAGICREW,
        })
      },
      claim: async (credential) => {
        const parsed = credential as { jwt?: unknown, organizationCode?: unknown } | null | undefined
        if (typeof parsed?.jwt !== 'string' || parsed.jwt.length === 0) {
          return { kind: 'failed', code: -1, message: '账号未登录（缺少 JWT），请重新登录' }
        }
        return await claimMagicrewLoginGift({
          jwt: parsed.jwt,
          organizationCode: typeof parsed.organizationCode === 'string' ? parsed.organizationCode : '',
          product: MAGICREW,
        })
      },
      /**
       * ⚠️ `precheckStatus: false` —— 本家**没有**与 `CheckinStatus` 同构的
       * 状态端点（`login-gift` 的响应只在调用时才知道今天领没领）。
       * 置 `true` 会让运行时先去调 `fetchStatus` 拿幂等判据，而它不存在
       * ⇒ 每次签到都先报一条「未实现状态查询」的错（见 `claim-runtime-parity.spec.ts`）。
       */
      precheckStatus: false,
    },

    /**
     * **MagiCrew 国际站**（`magicrewintl`，2026-11-01 接入）。
     *
     * 与国内版**共用全部实现**，只有 `product` 常量不同（判据与理由见
     * `src/magicrew-product.ts` 的 `MAGICREW_INTL` 注释）。
     *
     * ⚠️ 两站必须**各自登记一项**：`creditsOf` 按 provider id 取值，
     * 漏了 `magicrewintl` 的症状是「只登国际站的用户没有一键签到按钮」。
     * ⚠️ 国际站签到的金额是 **+50/天**（国内 +200），但这个差异由**服务端**
     * 决定，本层不做任何金额假设 —— 只如实回传上游的 `point_amount`。
     */
    magicrewintl: {
      /**
       * ⚠️ 与国内站**逐字同构**，只差 `product`（2026-11-04 真机更正：原先是
       * `fetchBalance`，会让国际站的 405 / WAF 拦截塌成「余额查询失败」）。
       */
      fetchBalanceDetailed: async (credential) => {
        const parsed = credential as { jwt?: unknown, organizationCode?: unknown } | null | undefined
        if (typeof parsed?.jwt !== 'string' || parsed.jwt.length === 0) {
          return fail('账号未登录（缺少 JWT），请重新登录')
        }
        return await fetchMagicrewBalanceDetailed({
          jwt: parsed.jwt,
          organizationCode: typeof parsed.organizationCode === 'string' ? parsed.organizationCode : '',
          product: MAGICREW_INTL,
        })
      },
      claim: async (credential) => {
        const parsed = credential as { jwt?: unknown, organizationCode?: unknown } | null | undefined
        if (typeof parsed?.jwt !== 'string' || parsed.jwt.length === 0) {
          return { kind: 'failed', code: -1, message: '账号未登录（缺少 JWT），请重新登录' }
        }
        return await claimMagicrewLoginGift({
          jwt: parsed.jwt,
          organizationCode: typeof parsed.organizationCode === 'string' ? parsed.organizationCode : '',
          product: MAGICREW_INTL,
        })
      },
      precheckStatus: false,
    },

    /**
     * MonkeyCode：**本 fork 独有**（2026-11-02 用户要求接入）。
     *
     * ## 为什么用 `fetchBalanceDetailed` 而不是 `fetchBalance`
     *
     * 它有三种**用户动作完全不同**的失败：
     * 1. **没配会话**（`session_cookie` 为空）⇒ 用户要用「浏览器登录」重新添加，
     *    或点卡片上的「改 Key」只补 session cookie；
     *    （⚠️ 2026-11-02 四审自查：原写「去粘贴 Cookie」——那枚 cookie
     *    是 **HttpOnly**，`document.cookie` 读不到。）
     * 2. **会话过期**（401/403）⇒ 用户要重新登录网页再更新 Cookie；
     * 3. 平台改版 / 网络故障 ⇒ 什么都不用做，等修复。
     *
     * `fetchBalance` 的 `null` 会被共享骨架统一补一句「余额查询失败」——
     * 前两种最关键的分流就没了（这正是 minimax 2026-10-17 那次审计的同款缺陷）。
     *
     * ## ⚠️ 为什么 `dailyCheckin: true` 却仍要 `precheckStatus: false`
     *
     * `claimMonkeycodeDailyCheckin` **内部第一步就是** `GET /wallet/checkin`
     * 判 `checked_in`（幂等 + 省一次 50 题的 PoW）。骨架的默认预检会拿
     * `fetchStatus` **再打一遍同一个端点** ⇒ 多一次请求、多一次会话失效的
     * 失败面，换不到任何信息。⇒ 显式关掉，预检职责由 claim 自己承担。
     *
     * ## ⚠️⚠️ 为什么**刻意不登记 `fetchStatus`**
     *
     * 那个端点只回一个布尔 `{ checked_in }` —— 没有连续天数、没有每日奖励、
     * 没有活动期（详见 `monkeycode-credits.ts` 的
     * `fetchMonkeycodeCheckinStatus` 注释）。而 `CheckinStatus` 契约要求
     * `streakDays` / `dailyCredit` / `checkinDates` 等字段存在 ⇒ 只能填 0 / 空串，
     * 面板于是显示「连续 0 天」「每日 +0」这种**看起来像真实读数**的假数据。
     *
     * 这正是本表那条守卫（`credits-runtime-parity.spec.ts` 的
     * 「fetchStatus 只登记在真有同构状态端点的渠道上」）要防的形态
     * ⇒ 与 codearts / lobsterai / trae 同型：`credits.status` 如实回 `null`，
     * 面板不显示签到状态行，「一键签到」按钮照常工作（幂等由 claim 自己判）。
     */
    monkeycode: {
      fetchBalanceDetailed: async (credential, call) =>
        fetchMonkeycodeBalanceDetailed(
          credential as MonkeycodeCredential,
          MONKEYCODE,
          { warn: call.warn },
        ),
      claim: (credential, _entry, call) =>
        claimMonkeycodeDailyCheckin(
          credential as MonkeycodeCredential,
          MONKEYCODE,
          { warn: call.warn },
        ),
      precheckStatus: false,
    },
    /**
     * MonkeyCode 国际站（2026-11-02）—— 与国内站**同一个实现**，只换 product。
     *
     * ⚠️ 这不是「复制一份判据」：`fetchMonkeycodeBalanceDetailed` /
     *    `claimMonkeycodeDailyCheckin` 的第二个参数就是站点，两站共用同一套
     *    wallet / checkin / PoW 代码（`MONKEYCODE_PRODUCTS` 是唯一真相源）。
     * ⚠️ `precheckStatus: false` 的理由与国内站相同：上游 `wallet/checkin`
     *    只回一个布尔，凑不出「连续 N 天」的读数字段。
     */
    monkeycodeintl: {
      fetchBalanceDetailed: async (credential, call) =>
        fetchMonkeycodeBalanceDetailed(
          credential as MonkeycodeCredential,
          MONKEYCODE_INTL,
          { warn: call.warn },
        ),
      claim: (credential, _entry, call) =>
        claimMonkeycodeDailyCheckin(
          credential as MonkeycodeCredential,
          MONKEYCODE_INTL,
          { warn: call.warn },
        ),
      precheckStatus: false,
    },
    /**
     * 百智云（2026-11-02 二版）—— **有积分，但要网页登录态**。
     *
     * 第一版把它登记成「无积分渠道」（`credits: { balance: false, … }` + 进
     * `CREDITS_TABLE_EXEMPT`），理由是模型网关 `ai-models.app.baizhi.cloud`
     * 除了 `/v1/models` / `/v1/messages` 全 404。那个实测没错，但结论错了：
     * 积分在**主站** `baizhi.cloud`：
     *
     * - `GET /api/v1/user/wallet/balance` →
     *   `{available_credit_cents:23505, temporary_credit_cents:9821,
     *     permanent_credit_cents:13684, frozen_credit_cents:0,
     *     daily_temporary_credit_claimed:true}`（单位 1/100 积分）
     * - `GET /api/v1/user/wallet/app-credit-usage?period=month` →
     *   `{items:[{period:'2026-11-02', app_id:22, call_count:31, credit:364.95}]}`
     *
     * 与用户控制台截图逐位吻合（235.05 / 98.21 / 136.84 / 364.95 / 31 次）。
     *
     * ⚠️ `claim` 登记（2026-11-03 真机取证）：每日临时积分领取
     *    `POST /api/v1/user/wallet/daily-temporary-credit` 要先过 Cap 验证码，
     *    但那是**纯本地 PoW**（`challenge → 解 50 题 → redeem`），不是图形码。
     *    `claimBaizhiDailyCheckin` 复用 `src/cap-pow.ts`（与 MonkeyCode 同协议），
     *    实测完整跑通并到账 100 积分，故不再以「400 captcha binding mismatch」拒绝。
     * ⚠️ `precheckStatus: false`：预检已在 `claimBaizhiDailyCheckin` 内部用
     *    钱包的 `daily_temporary_credit_claimed` 完成（与 monkeycode 同型）。
     */
    baizhi: {
      fetchBalanceDetailed: async (credential, call) =>
        fetchBaizhiBalanceDetailed(
          credential as BaizhiCredential,
          BAIZHI,
          { warn: call.warn },
        ),
      claim: (credential, _entry, call) =>
        claimBaizhiDailyCheckin(
          credential as BaizhiCredential,
          BAIZHI,
          { warn: call.warn },
        ),
      precheckStatus: false,
    },
  }
}

/**
 * 按 provider id 从表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `constructor`），
 * 把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `jet-hub-rpc.ts` 的 `authOf` 同因。
 */
export function creditsOf(
  table: Readonly<Record<string, ProviderCredits>>,
  provider: string,
): ProviderCredits | undefined {
  if (!Object.hasOwn(table, provider)) return undefined
  return table[provider]
}
