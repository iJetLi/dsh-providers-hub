/**
 * 「每日首次启动自动签到」—— 开关、当日记录与执行体。
 *
 * ## 它做什么
 *
 * DSH 启动后延迟一小段（默认 30 秒，见下），若这个开关开着、且**今天（UTC+8）
 * 还没跑过**，就串行遍历「账号池里真的有账号的渠道」，逐个调内部
 * `credits.claimAll`；跑完把日期与**逐渠道结果**写进文档 ⇒ **当天不再触发**。
 * 用户手动点「全部渠道签到」不受此限（那是显式操作，永远放行）。
 *
 * ⚠️ **开关默认打开**（用户 2026-10-02 明确要求：「自动签到默认保持打开状态」）。
 * 这与「这是代用户打上游的写操作」相权：该特性本身是用户要的，默认开启才符合
 * 「每日第一次打开 DSH 就自动签到」的预期；用户随时可以在状态灯上关掉。
 * 判据是**只有显式 `false` 才算关闭**（与本仓库账号的 `enabled !== false` 同惯例）。
 *
 * ## 为什么延迟 30 秒
 *
 * 两个理由，任一成立都不该立刻跑：
 * 1. **不跟启动抢资源**：一轮签到是「渠道数 × 账号数」次串行上游请求（反风控
 *    口径，见 `collectCreditBalances` 的顺序查询），启动瞬间打它会拖慢首屏；
 * 2. **等凭据续期先跑一轮**：宿主启动时的续期调度器**本身也要立刻跑一轮**
 *    （见 `index.ts` 的注释：短寿命 provider 的凭据在关机期间早就过期）。
 *    若抢在续期之前签到，过期凭据会让整轮变成失败。
 * 即便如此仍可能抢在续期完成前（多账号时续期本身就要几秒到几十秒），故**再加
 * 一道保险**：整轮跑完**没有任何一条能证明「今天已被处理」**时**不记日期**，
 * 下次启动会重试（见 {@link runnableSlotKey} 与逐渠道水位线）。延迟可用
 * `DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS` 覆盖，`0` 合法（表示立刻跑，单测用它）。
 *
 * ## 什么算「今天已被处理」
 *
 * ⚠️ **不是** `claimed + alreadyClaimed`，而是各渠道用
 * `ClaimOutcome.coversToday` 声明出来的 `summary.coversToday`
 * （真实缺陷，2026-10-02 审查 PR !33 定位：Qoder 活动每日 10:00（UTC+8）才刷新，
 * 上午那轮看到的 `CLAIMED` 属于**昨天**，拿它记账会让当天额度**整天漏领**）。
 *
 * ## 为什么单独一份文档，而不是塞进 ui-preferences.json
 *
 * `ui-preferences.json` 是**同 dsh home、多 profile 共享**的文档，而本仓库写盘
 * 是**整体替换**语义（见 `badge-preferences.ts` 的文件头对 state.json 记过的
 * 同一条理由）。同机上另一条工作区跑着**没有本功能**的旧版本插件时，它保存显示
 * 偏好会把这里的字段静默抹掉 —— 后果是「开关自己关了」或「今天又跑一次」。
 * 独立文档的读写者只有本文件，旧版本代码碰不到它。
 *
 * ## ⚠️ 不支持的渠道怎么判：**不建第二份能力名单**
 *
 * 「哪些渠道能签到」的权威是客户端的 `credits-capabilities.js`（12 个渠道逐项
 * 登记）。在本模块再抄一份必然漂移（本仓库已有「两份名单漂移」的真实缺陷）。
 * 故判据交给 `credits.claimAll` 自己：cline / raccoon / **workbuddy** 三条分支
 * **不发任何上游请求**就返回「不支持每日签到」，本模块把这类错误计为**跳过**，
 * 既不算失败也不重试。
 *
 * ⚠️ 其中 **workbuddy 的那条守卫是本功能先补上的**：此前它会落到 buddy 产品
 * 分支、真去发必然失败的签到请求（客户端从不调用它，是因为能力表写着 false，
 * 所以这个洞一直没被触发）。补上之后，「调用即判定」这条规则才真正安全。
 *
 * ## ⚠️「调用即判定」管不到的一类：签到**有代价**的渠道
 *
 * zcode 有签到，但每次领取都要现场产阿里云 captcha（web 版会拉起 headful
 * Chromium，且阿里云按设备限流 150 次/小时）。「等它返回错误再判定」来不及 ——
 * 代价发生在**调用期间**。故另有一张**排除表** `isAutoCheckinExcluded()`，
 * 在调 `claim` **之前**生效（详见那里的说明与维护口径）。用户仍可手动签到。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { QODER_BILLING_UTC_OFFSET_MS } from './model-queue.js'
import { resolveJetHubHome } from './jet-hub-store.js'
import { formatClaimGains } from './credits.js'
import { descriptorOf } from './provider-registry.js'
import type { BadgeRpcResult } from './usage-badge.js'
import type { RpcCreditsClaimAllResponse, RpcUsageAutoCheckinState } from './types.js'

/** 独立文档的文件名（与 state.json / ui-preferences.json 同目录）。 */
export const AUTO_CHECKIN_FILE = 'auto-checkin.json'

const SCHEMA = 'dsh-codearts-auth/auto-checkin/v1'

/**
 * 文档内容。
 *
 * `lastDate` / `lastResult` 既是「当天不重复触发」的判据，也是状态灯提示的来源
 * （用户要求「记录签到状态，不多次重复触发」）。`channels` 是**逐渠道**结果，
 * 供面板上那行常驻的自动签到状态文字使用（用户 2026-10-02：「自动签到状态下，
 * 下方应该也显示文字状态，这样才能够知道各个渠道的签到状态」）。
 */
export interface AutoCheckinDoc {
  /**
   * 自动签到开关。**默认打开**（用户 2026-10-02 明确要求：「自动签到默认保持打开
   * 状态」）—— 故判据是「只有显式 `false` 才算关闭」，与本仓库账号的
   * `enabled !== false` 惯例一致。
   */
  enabled: boolean
  /**
   * 每天**两个**执行时刻（`HH:MM`，UTC+8，升序、去重、恰好两个）。
   *
   * 用户 2026-10-18 要求：「每天几点自动启动…一天两次实现无遗漏」—— 原先的
   * 「每日首次启动跑一次」在「早上开过 DSH 就再也不跑」时，会让 21:00 之后才刷新
   * 额度的渠道整天漏领。两个时段各自独立记账（见 {@link lastSlot}）。
   *
   * ⚠️ 2026-10-31 重建：上一版实现随一次 `git reset --hard` 升级被清空，本字段
   * 与 `lastSlot` 是按同一设计**重新实现**的（不是从 stash 恢复）。
   */
  times: string[]
  /**
   * 随机浮动幅度（分钟）：0 = 精确按 `times` 执行；>0 = 每轮在 ±N 分钟内随机偏移。
   *
   * 用户 2026-10-31：「搞得像真人一样有时间波动」—— 固定到分钟的签到时刻是
   * 很明显的脚本特征。取 0 即关闭（默认，与旧行为等价）。
   *
   * ⚠️ 偏移**每轮重新抽**，而不是「每天固定一个偏移量」：后者的指纹仍然每天相同
   *（例如每天都晚 7 分钟），和固定时刻一样可识别。
   */
  jitterMinutes: number
  /** 上次**完成**自动签到的 UTC+8 日期（`YYYY-MM-DD`）；空串 = 从未跑过。 */
  lastDate: string
  /**
   * 已完成时段的**水位线**（`YYYY-MM-DD#HH:MM`）。
   *
   * 语义：**key 不大于它的时段都算已处理**。用单条水位线而不是逐时段布尔表，
   * 是因为时段天然单调，一条水位线就能表达「今天 09:00 跑过了、21:00 还没到」；
   * 而逐时段表会随时间无限增长，还得写清理逻辑。
   *
   * ⚠️ 空串 = 从未跑过 ⇒ **已到点的时段都算待补**（见 `shouldRunNow`）。
   * 这是「启动后补跑错过时段」的落点：DSH 没开时那一刻不会触发，下次启动看到
   * 水位线落后就会补跑。
   */
  lastSlot: string
  /**
   * 正在**补领**的时段（`YYYY-MM-DD#HH:MM`）；空串 = 没有待补的渠道。
   *
   * ## 为什么需要它（2026-11-01 审计 P1-5）
   *
   * 水位线是**整轮**粒度：一轮里只要**有一个**渠道证明「今天已处理」，整轮就记账，
   * 于是「10:00 才刷新额度」的渠道（Qoder 活动）在 09:00 那轮拿到的是昨天的痕迹
   * 却**再也不会被单独重试** ⇒ 当天漏领。实测：混合池 + 21:00 前关 DSH，
   * Qoder 在 10:00 之后的调用次数为 **0**。
   *
   * 修法：把「哪个渠道已经处理到哪个时段」记成逐渠道水位线
   *（{@link providerSlots}），本轮没领到的渠道留在 `pendingSlot` 上按退避重试，
   * 重试时**只打**那些渠道（`performRun` 会跳过已处理的）。
   */
  pendingSlot: string
  /**
   * **逐渠道**水位线：该渠道已处理到哪个时段 key。
   *
   * 语义与 `lastSlot` 同构，只是粒度是渠道：
   * - 缺失 / 空串 ⇒ 该渠道还没处理过任何时段；
   * - `>= 目标时段` ⇒ 本轮跳过它（不重复打上游）。
   *
   * ⚠️ 只保留**当前池里出现过的**渠道键（`performRun` 每轮用 `listProviderIds()`
   * 的结果重建），故不会无限增长 —— 渠道总数就 12 个。
   */
  providerSlots: Record<string, string>
  /** 上次结果摘要（中文短句，展示在状态灯提示里）。 */
  lastResult: string
  /** 上次跑完的时刻（毫秒）；0 = 从未跑过。 */
  lastAt: number
  /** 逐渠道结果（顺序即遍历顺序）；空数组 = 没有可展示的逐渠道信息。 */
  channels: Array<{ provider: string; text: string }>
  /**
   * 用户点过「关闭」的那一轮（存的是那一刻的 `lastAt`）。
   *
   * ⚠️ 存 `lastAt` 而不是布尔：新一轮跑出来 `lastAt` 变了，状态文字就会**重新出现**
   *（否则用户关过一次以后就再也看不到新的结果）。0 = 未曾关闭过。
   */
  dismissedRunAt: number
}

/**
 * 默认两个执行时刻（UTC+8）。
 *
 * ## 为什么保持 **09:00 / 21:00**（2026-11-01 第二轮审计推翻了「改成 10:05」）
 *
 * 本仓库各渠道的每日额度刷新时点**不统一**：多数在 00:00，而 Qoder 活动要
 * **10:00（UTC+8）** 才刷新（见文件头与 `credits.ts`）。09:00 那轮对 Qoder 拿到的是
 * **昨天**的 `CLAIMED`（`coversToday === 0`）——旧实现因此整天漏领。
 *
 * 曾经把默认改成 10:05 来回避，但那有两个真问题：
 * ① **修不到存量用户**：`FileAutoCheckinStore.save` 每轮都会把 `times` 写盘，跑过一轮的
 *   文档里 09:00 已被固化 ⇒ 只有「从没跑过的新装」才变成 10:05，两批用户行为不一致；
 * ② **多跑一整轮**：工作日 09:00–18:00 的用户会看到「每天两轮全渠道扫」（12 渠道
 *   24 次写请求），而某些开关机组合会从「1 轮/天」变成「某天 0 轮」。
 *
 * 真正的修法是**逐渠道水位线 + 补领**（见 {@link AutoCheckinDoc.pendingSlot}）：
 * 09:00 那轮 Qoder 没证明今天 ⇒ 只重试 Qoder，10:00 刷新后自然领到；
 * 窗口 3 小时（`LAG_RETRY_WINDOW_MS`）覆盖「浮动把 09:00 提前到 07:00」的最坏情形。
 */
export const DEFAULT_AUTO_CHECKIN_TIMES: readonly string[] = ['09:00', '21:00']

/** 恰好两个时段：用户明确要求「一天两次」。 */
export const AUTO_CHECKIN_SLOT_COUNT = 2

/** `HH:MM`（24 小时制，两位补零）。 */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** `YYYY-MM-DD#HH:MM`（水位线）。 */
const SLOT_RE = /^(\d{4}-\d{2}-\d{2})#([01]\d|2[0-3]):([0-5]\d)$/

/** 默认：打开 + 默认时段 + 无记录。 */
export const DEFAULT_AUTO_CHECKIN: AutoCheckinDoc = {
  enabled: true,
  times: [...DEFAULT_AUTO_CHECKIN_TIMES],
  jitterMinutes: 0,
  lastDate: '',
  lastSlot: '',
  pendingSlot: '',
  providerSlots: {},
  lastResult: '',
  lastAt: 0,
  channels: [],
  dismissedRunAt: 0,
}

/** 逐渠道水位线的上限（渠道共 12 个，留余量；脏数据不该撑大文档）。 */
const MAX_PROVIDER_SLOTS = 64

/** 归一化逐渠道水位线：丢掉非法项（只认 `YYYY-MM-DD#HH:MM`），限制条数。 */
function sanitizeProviderSlots(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  let count = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 64) continue
    if (typeof value !== 'string' || !SLOT_RE.test(value)) continue
    out[key] = value
    count += 1
    if (count >= MAX_PROVIDER_SLOTS) break
  }
  return out
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 逐渠道条目的上限：渠道总数就 12 个，留一点余量即可（脏数据不该撑大文档）。 */
const MAX_CHANNEL_ENTRIES = 24

/** 归一化逐渠道结果（丢非法项、截断超长文本、限制条数）。 */
function sanitizeChannels(raw: unknown): Array<{ provider: string; text: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ provider: string; text: string }> = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.provider !== 'string' || record.provider.length === 0) continue
    if (typeof record.text !== 'string') continue
    out.push({ provider: record.provider, text: record.text.slice(0, 120) })
    if (out.length >= MAX_CHANNEL_ENTRIES) break
  }
  return out
}

/**
 * 归一化文档：非法值一律回落默认值（**不抛错**）。
 *
 * ⚠️ 与 RPC 写入路径的严格校验**不冲突**：那条路径面对用户输入，要拒绝非法值；
 * 这条路径面对**磁盘上的脏数据**（手工编辑过、被旧版本写坏），回落比整机不可用
 * 更合理 —— 判据口径与 `sanitizeBadgePreference` 一致。
 * ⚠️ 缺新字段的**旧文档**（没有 `channels` / `lastAt` / `enabled`）必须照常读出来：
 * 前两个是本功能上线后追加的，而 `enabled` 缺失要按**默认打开**处理（不是关闭）。
 */
export function sanitizeAutoCheckin(raw: unknown): AutoCheckinDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_AUTO_CHECKIN }
  const record = raw as Record<string, unknown>
  const ms = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  return {
    // ⚠️ **只有显式 `false` 才算关闭**（默认是打开的，见 `AutoCheckinDoc.enabled`）：
    // 写成 `=== true` 会让旧文档（没有该字段）与脏数据把开关静默关掉，与
    // 「默认保持打开状态」相反。`'false'` / `0` 这些非布尔值一律按打开处理 ——
    // 它们不是用户点出来的值。
    enabled: record.enabled !== false,
    times: sanitizeTimes(record.times),
    jitterMinutes: sanitizeJitter(record.jitterMinutes),
    lastDate: typeof record.lastDate === 'string' && DATE_RE.test(record.lastDate) ? record.lastDate : '',
    lastSlot: typeof record.lastSlot === 'string' && SLOT_RE.test(record.lastSlot) ? record.lastSlot : '',
    pendingSlot: typeof record.pendingSlot === 'string' && SLOT_RE.test(record.pendingSlot) ? record.pendingSlot : '',
    providerSlots: sanitizeProviderSlots(record.providerSlots),
    lastResult: typeof record.lastResult === 'string' ? record.lastResult : '',
    lastAt: ms(record.lastAt),
    channels: sanitizeChannels(record.channels),
    dismissedRunAt: ms(record.dismissedRunAt),
  }
}

/**
 * 归一化时段列表：丢掉非法项、去重、升序，**不足回落到默认两个**、**多于保留首尾**。
 *
 * ⚠️ 不能「只补到两个」：旧文档没有 `times` 字段 ⇒ 空数组 ⇒ 若原样保留，自动
 * 签到会**永远等不到时段**（一天都不跑），而这正是本特性的核心失效形态。回落
 * 默认值让升级后立刻按 09:00/21:00 工作，用户再改。
 * ⚠️ 也不能保留多于两个：用户要求「一天两次」，多留的时段会变成「一天跑三次」。
 * ⚠️ 但**多余项要留首尾**，不是「排序后前两个」（2026-11-01 第二轮审计 P3）：
 * 取前两个会把**最晚那一轮**静默丢掉（`["09:00","14:00","21:00"]` ⇒ 只剩
 * 09:00/14:00，晚上那次没了）。留首尾至少保住全天的覆盖跨度。
 */
export function sanitizeTimes(raw: unknown): string[] {
  const valid: string[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string' || !TIME_RE.test(item)) continue
      if (!valid.includes(item)) valid.push(item)
    }
  }
  const sorted = valid.sort()
  if (sorted.length < AUTO_CHECKIN_SLOT_COUNT) return [...DEFAULT_AUTO_CHECKIN_TIMES]
  if (sorted.length === AUTO_CHECKIN_SLOT_COUNT) return sorted
  return [sorted[0]!, sorted[sorted.length - 1]!]
}

/**
 * 严格校验用户提交的浮动幅度（RPC 写入路径专用）。
 *
 * ⚠️ 与 {@link sanitizeJitter} 分开：那个面对磁盘脏数据（回落 0），本函数面对
 * 用户输入（**抛错**）。回落会让「设置没生效」看起来像「保存成功」。
 */
export function sanitizeJitterStrict(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`jitterMinutes 必须是数字（收到：${JSON.stringify(raw)}）`)
  }
  if (raw < 0) throw new Error(`jitterMinutes 不能为负（收到：${raw}）`)
  if (raw > MAX_CHECKIN_JITTER_MINUTES) {
    throw new Error(`jitterMinutes 不能超过 ${MAX_CHECKIN_JITTER_MINUTES} 分钟（收到：${raw}）`)
  }
  return Math.floor(raw)
}

/** 随机浮动的上限（分钟）。超过 2 小时就不再是「波动」而是「随机跑」，会破坏「两次覆盖全天」的设计。 */
export const MAX_CHECKIN_JITTER_MINUTES = 120

/**
 * 归一化随机浮动幅度。
 *
 * ⚠️ 非法值一律回落 **0**（= 关闭浮动），而不是回落默认值：读不出「用户到底要多少」
 * 时，宁可**精确执行**（可预期）也不要随机漂移 —— 后者会让「今天怎么没跑」难以排查。
 * ⚠️ 上限 `MAX_CHECKIN_JITTER_MINUTES`：超过 2 小时的偏移会让某个时段的执行落到
 * 另一个时段附近，两个时段可能合并成一次，破坏「两次覆盖」的前提。
 */
export function sanitizeJitter(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(Math.floor(raw), MAX_CHECKIN_JITTER_MINUTES)
}

/** 时段文本是否合法（`HH:MM`）。RPC 写入路径用它拒非法值。 */
export function isLegalTimeText(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value)
}

/**
 * 取「UTC+8 的当天日期」（`YYYY-MM-DD`）。
 *
 * ⚠️ 必须用**算术平移**而不是本机时区：日界归服务端（各渠道的每日额度按 UTC+8
 * 结算），取本机时区会在用户出差/改系统时区时得到错的「今天」—— 偏东会提前把
 * 当天记为已跑（真的漏签），偏西会一天跑两次。偏移量复用 `model-queue.ts` 的
 * `QODER_BILLING_UTC_OFFSET_MS`（同一口径，不另立常量）。
 */
export function utc8DateString(nowMs: number = Date.now()): string {
  return new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 取「UTC+8 的当前时刻」（`HH:MM`）。与 `utc8DateString` 同源平移。
 *
 * ⚠️ 同样不能用本机时区：时段是用户按 UTC+8 心智设定的（上游额度也按 UTC+8 结算），
 * 用本机时区会在改系统时区时整体偏移。
 */
export function utc8TimeString(nowMs: number = Date.now()): string {
  return new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS).toISOString().slice(11, 16)
}

/**
 * `YYYY-MM-DD` + `HH:MM`（UTC+8）⇒ 毫秒时刻。
 *
 * ⚠️ 必须手动拼 UTC 再减偏移，**不能**用 `new Date('2026-10-18T09:00')`：
 * 后者按**本机时区**解析，用户改系统时区时会算错（与 `utc8DateString` 同一条理由）。
 */
export function utc8MomentMs(date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return Date.UTC(y!, m! - 1, d!, hh!, mm!, 0, 0) - QODER_BILLING_UTC_OFFSET_MS
}

/**
 * 把「日期 + 时刻」拼成可比较的水位线 key。
 *
 * ⚠️ 比较必须用**字符串**而非 Date：key 的字典序恰好等于时间序（定宽
 * `YYYY-MM-DD#HH:MM`），而跨时区用 Date 反而容易算错 —— 本模块的日界一律按
 * UTC+8 算术平移，不需要也不应该引入本地 Date 语义。
 */
export function slotKey(date: string, time: string): string {
  return `${date}#${time}`
}

/**
 * 一个时段的解析结果：`key` 用于水位线比较，`realAt` 是**真实执行时刻**
 * （= 时段时刻 + 该轮确定性偏移）。
 */
export interface CheckinSlot {
  key: string
  realAt: number
}

/**
 * 枚举 [昨天, 今天, 明天] 三天的全部时段，按 `realAt` 升序。
 *
 * ## 为什么把「偏移」算进时段本身（2026-11-01 审计 P1-2）
 *
 * 旧实现先按**时段时刻**取 `due`，再拿 `realAt` 比 `now`。偏移为负时
 * （真实执行时刻在时段**之前**），`due` 还没轮到那个时段 ⇒ `shouldRunNow`
 * 恒 false ⇒ **负偏移是死代码**，「±N 浮动」实际只有 `[0, +N]`。
 * 实测：全年 730 个时段里负偏移占 49.7%、**提前执行 0 次**；而且约一半的日子
 * 精确在 `HH:MM:00` 执行 —— 正是浮动想消掉的那个脚本指纹。
 *
 * 把 `realAt` 作为**唯一**判据（「到点」= `realAt <= now`）之后：
 * - 负偏移的时段会在时段**之前**被判为到点 ⇒ `±N` 真的是双向的；
 * - 「已到点但真实时刻未到」这个中间态**不存在**了 ⇒ `nextRunDelayMs` 不再
 *   恒返回 0，`armNext` 的每秒空转自动消失（审计 P1-3）。
 *
 * ⚠️ 偏移的夹紧保证 `span <= 与下一时段间隔的一半` ⇒ `realAt` 的先后顺序与
 * 时段 key 的字典序**一致**，故水位线仍可用字符串比较。
 */
export function checkinSlotsAround(nowMs: number, times: readonly string[], jitterMinutes = 0): CheckinSlot[] {
  const sorted = [...times].sort()
  if (sorted.length === 0) return []
  const jitter = sanitizeJitter(jitterMinutes)
  const out: CheckinSlot[] = []
  for (const dayShift of [-1, 0, 1]) {
    const date = utc8DateString(nowMs + dayShift * 86_400_000)
    for (let i = 0; i < sorted.length; i += 1) {
      const time = sorted[i]!
      // 与**下一个**时段的间隔（末尾用「到明天第一个」），用于夹紧浮动幅度。
      const gap = i + 1 < sorted.length
        ? timeGapMinutes(time, sorted[i + 1]!)
        : timeGapMinutes(time, sorted[0]!) + 24 * 60
      out.push({ key: slotKey(date, time), realAt: slotMomentMs(date, time, jitter, gap) })
    }
  }
  return out.sort((a, b) => a.realAt - b.realAt)
}

/**
 * 当前时刻**已经真的到点**的最大时段 key（含浮动偏移）。
 *
 * 例（times = 09:00 / 21:00，jitter = 0）：
 * - 今天 08:30 ⇒ **昨天 21:00**；
 * - 今天 09:05 ⇒ 今天 09:00；
 * - 今天 22:00 ⇒ 今天 21:00。
 *
 * 配了浮动后判据换成「时段时刻 + 偏移 <= now」：偏移为负 ⇒ 会在时段之前到点。
 *
 * @param jitterMinutes - 浮动幅度（分钟）；省略 = 0（与旧签名兼容）。
 */
export function latestDueSlotKey(nowMs: number, times: readonly string[], jitterMinutes = 0): string {
  const slots = checkinSlotsAround(nowMs, times, jitterMinutes)
  let best = ''
  for (const slot of slots) {
    if (slot.realAt <= nowMs) best = slot.key
  }
  return best
}

/** 下一个**真实执行时刻还没到**的时段；没有（`times` 为空）⇒ `null`。 */
export function nextSlotRef(nowMs: number, times: readonly string[], jitterMinutes = 0): CheckinSlot | null {
  for (const slot of checkinSlotsAround(nowMs, times, jitterMinutes)) {
    if (slot.realAt > nowMs) return slot
  }
  return null
}

/**
 * 为某个时段算一个「随机但确定」的执行偏移（毫秒）。
 *
 * ## 为什么要「确定」
 *
 * 偏移必须**同一个时段每次算出来都一样**，否则同一轮会出现两种时间：
 * 面板显示的「下次执行」与实际触发时刻不一致（用户会发现「说 9:05 却 9:12 才跑」）。
 * 故用 (日期, 时刻) 作为**种子**做哈希 —— 同一天同一时段恒定，换一天/换时段就变。
 *
 * ## 为什么不用 Math.random()
 *
 * `Math.random()` 每次调用都不同 ⇒ 上面那条立刻不成立；而且它不可测（单测无法固定）。
 * 这里用一个极简的字符串哈希（FNV-1a 变体），纯函数、可复现、零依赖。
 *
 * ## 边界：偏移绝不许越过下一个时段
 *
 * ⚠️ 若 09:00 那轮被 +60 分钟推到 10:00，而下一时段是 10:30，就可能出现两轮贴着跑；
 * 更糟的是若推到 21:00 之后，两个时段会**合并成一次**，「一天两次」就失效了。
 * 故偏移幅度取 `min(jitter, 与下一时段间隔的一半)`。
 *
 * @param date - UTC+8 日期（`YYYY-MM-DD`）。
 * @param time - 该时段的原始时刻（`HH:MM`）。
 * @param jitterMinutes - 用户配置的浮动幅度（0 = 不浮动）。
 * @param nextGapMinutes - 与下一时段的间隔分钟数（用于夹紧）。
 * @returns 毫秒偏移；正负都可能。
 */
export function checkinJitterOffsetMs(
  date: string,
  time: string,
  jitterMinutes: number,
  nextGapMinutes: number,
): number {
  const jitter = sanitizeJitter(jitterMinutes)
  if (jitter <= 0) return 0
  // 夹紧：不许越过与下一时段间隔的一半（避免两轮合并 / 贴太近）
  const gapHalf = Number.isFinite(nextGapMinutes) && nextGapMinutes > 0
    ? Math.floor(nextGapMinutes / 2)
    : jitter
  const span = Math.min(jitter, gapHalf)
  if (span <= 0) return 0
  // 确定性哈希：同 (date, time) 恒定，换日期/时刻即变。
  const seed = `${date}#${time}`
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  // 把 32 位无符号映射到 [0, 2*span] 的整数分钟，再减去 span ⇒ [-span, +span]
  const bucket = (hash >>> 0) % (span * 2 + 1)
  return (bucket - span) * 60_000
}

/**
 * 现在该为**哪个时段**跑一轮：`''` = 不用跑。
 *
 * 判据优先级：
 * 1. `pendingSlot`（上一轮还有渠道没领到，例如 10:00 才刷新额度的渠道）——
 *    只要它还没被新时段顶掉，就继续打它（审计 P1-5：旧实现只认「整轮是否
 *    证明今天」，混合渠道池里只要别的渠道证明过今天，Qoder 这类 10:00 才刷新
 *    的渠道就再也不会被单独重试 ⇒ 当天漏领）；
 * 2. 水位线落后于**已到点的最大时段** ⇒ 跑那个时段。
 *
 * ⚠️ 这里**不是**「今天跑过没有」：一天两个时段各自要跑一次，用「今天跑过」
 * 判会让第二个时段永远不触发。
 * ⚠️ `lastSlot` 为空（从未跑过）⇒ 只要有到点的时段就跑：这正是「首次启用
 * 立刻补跑」的行为。
 */
export function runnableSlotKey(
  doc: Pick<AutoCheckinDoc, 'enabled' | 'times' | 'lastSlot'> & {
    jitterMinutes?: number
    pendingSlot?: string
  },
  nowMs: number,
): string {
  if (!doc.enabled) return ''
  // ⚠️ 这里刻意**也接受 lastDate** 的旧语义（文档字段仍在写）：
  //   旧文档有 lastDate 但没有 lastSlot ⇒ 无法判断今天两个时段各自处理了没有。
  //   取「补跑」而不是「当成已跑」：签到是幂等的（对已领的号上游返回
  //   alreadyClaimed），代价是一轮请求；而误判成「已跑」的代价是**当天整天漏领**。
  const due = latestDueSlotKey(nowMs, doc.times, doc.jitterMinutes ?? 0)
  const pending = doc.pendingSlot ?? ''
  // ⚠️「还有渠道没领到」优先（`pendingSlot`），但**不许**比当前已到点的时段还旧：
  //   若重试拖过了下一个时段，旧的那个已无意义 ⇒ 直接改打新时段。
  if (pending !== '' && due !== '' && pending >= due) return pending
  if (due !== '' && ((doc.lastSlot ?? '') === '' || doc.lastSlot < due)) return due
  return ''
}

export function shouldRunNow(
  doc: Pick<AutoCheckinDoc, 'enabled' | 'times' | 'lastSlot'> & {
    jitterMinutes?: number
    pendingSlot?: string
  },
  nowMs: number,
): boolean {
  return runnableSlotKey(doc, nowMs) !== ''
}

/** 环境变量：启动后延迟多久再尝试自动签到（毫秒）。 */
export const DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS = 'DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS'

/** 默认延迟（毫秒）。理由见文件头「为什么延迟 30 秒」。 */
export const AUTO_CHECKIN_DELAY_MS = 30_000

/**
 * 读延迟配置。
 *
 * ⚠️ 不能写成 `Number(env.X) || 默认值`：`0` 是**合法**值（立刻执行），
 * 而 `0` 是 falsy 会被静默换成 30 秒 —— 与本仓库 `DSH_JET_HUB_BADGE_TTL_MS`、
 * `DSH_QODER_QUEUE_TIMEOUT_MS` 记过的是同一个坑。
 */
export function autoCheckinDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]
  if (typeof raw !== 'string' || raw.trim().length === 0) return AUTO_CHECKIN_DELAY_MS
  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : AUTO_CHECKIN_DELAY_MS
}

/** 文档后端：文件（正常）或内存（定位不到 dsh home 时的显式降级）。 */
export type AutoCheckinStoreKind = 'file' | 'memory'

/** 文档读写接口（同步读、异步写，与 `BadgePreferenceStore` 同款约定）。 */
export interface AutoCheckinStore {
  readonly kind: AutoCheckinStoreKind
  /** 载入文档；不存在 / 损坏 / 字段非法时返回默认值。 */
  load(): AutoCheckinDoc
  /** 整份写入（原子写）。 */
  save(doc: AutoCheckinDoc): Promise<void>
}

class MemoryAutoCheckinStore implements AutoCheckinStore {
  readonly kind = 'memory' as const
  private doc: AutoCheckinDoc = { ...DEFAULT_AUTO_CHECKIN }

  load(): AutoCheckinDoc {
    return { ...this.doc }
  }

  async save(doc: AutoCheckinDoc): Promise<void> {
    this.doc = { ...doc }
  }
}

class FileAutoCheckinStore implements AutoCheckinStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): AutoCheckinDoc {
    try {
      if (!existsSync(this.path)) return { ...DEFAULT_AUTO_CHECKIN }
      return sanitizeAutoCheckin(JSON.parse(readFileSync(this.path, 'utf-8')) as unknown)
    } catch (error) {
      // 损坏时回落默认值而不是抛错：这是后台任务，读不到文档不该让插件起不来。
      // ⚠️ 默认值现在是「**打开**」（见 `DEFAULT_AUTO_CHECKIN`），所以回落的后果
      // 是「今天照常自动签到」，不是「不签」。早先这里写的是「= 开关关闭」，
      // 那是默认值翻转前的旧语义 —— 留着会把排障引到反方向。
      this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，自动签到按默认设置（开启）处理: ${String(error)}`)
      return { ...DEFAULT_AUTO_CHECKIN }
    }
  }

  async save(doc: AutoCheckinDoc): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({
      schema: SCHEMA,
      enabled: doc.enabled,
      times: doc.times,
      jitterMinutes: doc.jitterMinutes,
      lastDate: doc.lastDate,
      lastSlot: doc.lastSlot,
      pendingSlot: doc.pendingSlot,
      providerSlots: doc.providerSlots,
      lastResult: doc.lastResult,
      lastAt: doc.lastAt,
      channels: doc.channels,
      dismissedRunAt: doc.dismissedRunAt,
    }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

/** 创建文档后端（home 与账号池 / 偏好文档用**同一个** `resolveJetHubHome`）。 */
export function createAutoCheckinStore(ctx: Context): AutoCheckinStore {
  const home = resolveJetHubHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，自动签到开关仅存在于内存中')
    return new MemoryAutoCheckinStore()
  }
  return new FileAutoCheckinStore(join(home, 'jet-hub', AUTO_CHECKIN_FILE), ctx.logger)
}

/** 一轮执行的累计口径（账号级计数来自各渠道的 `summary`）。 */
interface RunTotals {
  /** 真正跑过 `claimAll` 的渠道数（不含被跳过的）。 */
  providers: number
  claimed: number
  totalCredit: number
  /**
   * ★ **按单位分组**的合计（2026-10-04）。
   *
   * ⚠️ 展示路径**必须**用它而不是 {@link totalCredit}：后者跨单位求和，
   * 会把 ZCode 的 token 与其余渠道的积分加成一个数（真实缺陷，见
   * `RpcCreditsClaimSummary.totalByUnit`）。
   */
  totalByUnit: Record<'token' | 'credit', number>
  alreadyClaimed: number
  inactive: number
  failed: number
  /**
   * 其中**能证明「今天这一轮已被处理」**的账号数（来自 `summary.coversToday`）。
   *
   * ⚠️ 这是**唯一**该看的口径（逐渠道判据也用它）—— 不能用
   * `claimed + alreadyClaimed`：那两项里混着「刷新前那一轮」的痕迹
   * （Qoder 活动 10:00 UTC+8 才刷新），拿它们记账会让当天新额度整天漏领。
   * 字段语义见 `src/credits.ts` 的 `ClaimOutcomeCommon.coversToday`。
   */
  coversToday: number
  /** 渠道级：不支持签到（`claimAll` 未发上游请求就返回的那些）。 */
  skipped: number
  /** 渠道级：其它错误（凭据、网络……）。 */
  errors: number
}

function emptyTotals(): RunTotals {
  return { providers: 0, claimed: 0, totalCredit: 0, totalByUnit: { token: 0, credit: 0 }, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0, skipped: 0, errors: 0 }
}

/**
 * 「不支持每日签到」的判据：`credits.claimAll` 对 cline / raccoon / workbuddy
 * 返回的**显式**错误文案（这三条分支都不发上游请求）。
 *
 * ⚠️ 兜底认 `unsupported provider`：那是 `productById` 找不到产品时的文案，
 * 语义同样是「这个渠道没有可用的签到实现」，计成失败只会制造假警报。
 * ⚠️ 判据必须**窄**：只匹配这两个短语，不要泛化成「含 unsupported」之类，
 * 免得把真正的参数错误也吞掉。
 */
export function isUnsupportedCheckin(message: string): boolean {
  return message.includes('不支持每日签到') || message.includes('unsupported provider')
}

/**
 * ⚠️ **自动签到不适合**的渠道：领取过程需要**用户在场 / 外部程序**。
 *
 * ## 为什么不靠「错误文案」判（真实缺陷，2026-10-02 审查 PR !33 定位）
 *
 * 本文件原先的规则是「判据交给 `credits.claimAll` 自己：不支持的渠道会
 * **不发上游请求**就返回错误」。那对 cline / raccoon / workbuddy 成立 ——
 * 它们的守卫在 `claimAll` 里，返回前一个请求都没发。
 *
 * 但**漏了一类**：zcode **有**签到，只是每次领取都要现场产一个阿里云
 * captcha param（`jet-hub-rpc.ts` 的 zcode 分支无条件调 `zcode.mintCaptcha`）。
 * web 版下它会**拉起 headful Chromium**（约 200–400MB），而阿里云按**设备**
 * 限流「同设备每小时 150 次」。默认开启的自动签到等于：用户什么都没点，
 * 开 DSH 就起一棵浏览器进程树、白耗设备级配额；一旦这轮失败又不写 `lastDate`
 * ⇒ **每次启动都重来**，一天开十次就是十轮 captcha。
 *
 * ## 判据与维护口径
 *
 * - 这张表是**第二份名单**，但它记的不是「谁有签到接口」（那仍由
 *   `claimAll` 的守卫 + 客户端能力表负责），而是「谁有签到**代价**」——
 *   后者无处可查，只能显式登记。**新增带 captcha / 外部浏览器的 provider 时，
 *   必须同时登记到这里**（`tests/unit/auto-checkin.spec.ts` 有反向守护用例：
 *   一旦 zcode 的 claim 分支又开始调 `mintCaptcha`，而本表没登记，用例会红）。
 * - 用户仍可在面板里**手动**点 zcode 的「一键领取积分」—— 那是有意行为，
 *   浏览器弹出来是用户自己能理解的交互。
 */
export function isAutoCheckinExcluded(provider: string): boolean {
  // ⚠️ 2026-10-08 改：判据从**硬编码** `provider === ZCODE.id` 改为查
  //    `PROVIDER_REGISTRY` 的 `autoCheckinExcluded` —— 原先改 registry 的该字段
  //    **行为完全不变**（宿主侧另有一份副本），是「唯一真相源」名不副实的一处。
  //    ⚠️ 用 `=== true` 而不是 truthy：该字段可选，省略 = 不排除。
  return descriptorOf(provider)?.autoCheckinExcluded === true
}

/** 把一轮结果拼成一句中文摘要（给状态灯提示与日志用）。 */
export function describeRun(totals: RunTotals): string {
  const parts: string[] = []
  if (totals.claimed > 0) {
    // ★ 按单位分别报（2026-10-04，真实缺陷）：原先写 `+${totals.totalCredit} 积分`，
    //   而 `totalCredit` 是**跨单位求和** —— ZCode 的 1 亿 token 与 100 积分会被
    //   加成 `100000100` 并标成「积分」。用户报障原文给的期望形态就是
    //   `+100Mtoken, +100积分`（见 `credits.ts` 的 `formatClaimGains`）。
    const amounts = formatClaimGains(totals.totalByUnit ?? { credit: totals.totalCredit })
    parts.push(`${totals.claimed} 个账号领取成功${amounts === null ? '' : `（${amounts}）`}`)
  }
  if (totals.alreadyClaimed > 0) parts.push(`${totals.alreadyClaimed} 个今天已领`)
  if (totals.failed > 0) parts.push(`${totals.failed} 个失败`)
  if (totals.errors > 0) parts.push(`${totals.errors} 个渠道出错`)
  if (totals.skipped > 0) parts.push(`${totals.skipped} 个渠道不支持签到`)
  if (parts.length === 0) return `${totals.providers} 个渠道：没有需要领取的账号`
  return `${totals.providers} 个渠道：${parts.join('，')}`
}

/**
 * 单个渠道的短状态（面板上那行常驻文字用它逐渠道列出，用户要求「这样才能够知道
 * **各个渠道**的签到状态」）。
 *
 * ⚠️ 必须**短**：十余个渠道要挤在 280px 的面板里一行一个片段，长文案会撑成好几屏。
 * （⚠️ 这里**刻意不写死渠道数** —— 2026-10-16 合并审计实测：原文写「9 个」，
 * 加 `minimaxintl` 后已是 10 个。写死数字必然腐坏。）
 * 故只给「几个账号 + 什么结果」，不带渠道名（渠道名由展示层补）。
 */
export function describeChannel(summary: {
  claimed: number
  totalCredit: number
  alreadyClaimed: number
  inactive: number
  failed: number
  /** 见 `RpcCreditsClaimSummary.coversToday`；缺省按 `claimed+alreadyClaimed` 兜底。 */
  coversToday?: number
  /**
   * ★ 按单位分组的合计（2026-10-04）。**缺省回落到「全部按积分」**，
   * 以兼容尚未上报该字段的旧响应（与 `coversToday` 的兜底同思路）。
   */
  totalByUnit?: Partial<Record<'token' | 'credit', number>>
}): string {
  const parts: string[] = []
  if (summary.claimed > 0) {
    // ⚠️ 「领到了但 +0 分」与「今天已领」必须能分辨：前者写成「已领」会和
    // alreadyClaimed 撞词，用户无法判断这次到底有没有动作。
    //
    // ★ 单位感知（2026-10-04）：原先写裸数字 `+${summary.totalCredit}`，
    //   于是 ZCode 那行显示 `1 个 +100000000` —— 既看不出单位，量级也读不出来。
    //   用户给的期望形态是 `+100Mtoken`（见 `credits.ts` 的 `formatClaimGains`）。
    const amounts = formatClaimGains(summary.totalByUnit ?? { credit: summary.totalCredit })
    parts.push(amounts === null ? `${summary.claimed} 个领取成功` : `${summary.claimed} 个 ${amounts}`)
  }
  if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今天已领`)
  if (summary.failed > 0) parts.push(`${summary.failed} 个失败`)
  if (summary.inactive > 0) parts.push(`${summary.inactive} 个未开启`)
  if (parts.length === 0) return '无可领'
  // ⚠️ 声称「今天已领」之前先自问一句：这些痕迹是不是**今天这一轮**的？
  // Qoder 在 10:00（UTC+8）刷新前看到的 `CLAIMED` 属于昨天 —— 此时那句
  // 「今天已领」既不准确，又会让用户以为今天不必再领。
  const coversToday = summary.coversToday ?? (summary.claimed + summary.alreadyClaimed)
  if (coversToday === 0 && (summary.claimed + summary.alreadyClaimed) > 0) {
    parts.push('非今日轮次')
  }
  return parts.join('，')
}

/**
 * 严格校验用户提交的时段列表（RPC 写入路径专用）。
 *
 * ⚠️ 与 {@link sanitizeTimes} **刻意分开**，两者面对的数据源不同：
 * - `sanitizeTimes` 面对**磁盘脏数据** ⇒ 必须回落默认值，因为「读不回来」不该
 *   让整个特性失效；
 * - 本函数面对**用户输入** ⇒ 非法值必须**抛错**。回落会让「设置没生效」看起来像
 *   「保存成功」，用户之后永远等不到那轮签到却毫无提示。
 *
 * 约束（用户要求「一天两次」）：恰好 {@link AUTO_CHECKIN_SLOT_COUNT} 个、格式
 * `HH:MM`、**不许重复**、自动升序（顺序对执行时机无影响，统一排序让水位线可比较）。
 */
export function sanitizeTimesStrict(raw: readonly unknown[]): string[] {
  if (raw.length !== AUTO_CHECKIN_SLOT_COUNT) {
    throw new Error(`需要恰好 ${AUTO_CHECKIN_SLOT_COUNT} 个时刻（收到 ${raw.length} 个）`)
  }
  const out: string[] = []
  for (const item of raw) {
    if (!isLegalTimeText(item)) {
      throw new Error(`时刻必须是 HH:MM（24 小时制，如 09:00），收到：${JSON.stringify(item)}`)
    }
    if (out.includes(item)) throw new Error(`两个时刻不能相同（重复：${item}）`)
    out.push(item)
  }
  return out.sort()
}

/**
 * 取某时段「加上随机浮动后」的真实执行毫秒。
 *
 * ⚠️ `nextGapMinutes` 由调用方算好传进来（不在这里查 `times`），是为了让本函数
 * 成为纯函数：`checkinJitterOffsetMs` 的夹紧逻辑依赖它，而「下一时段是谁」
 * 在跨天（最后一个时段的下一个是**明天第一个**）时要特别小心 —— 交给调用方
 * 在明确知道上下文的地方算，比在这里猜更可靠。
 */
function slotMomentMs(date: string, time: string, jitterMinutes: number, gapMinutes: number): number {
  return utc8MomentMs(date, time) + checkinJitterOffsetMs(date, time, jitterMinutes, gapMinutes)
}

/** 两个 `HH:MM` 之间的分钟差。 */
function timeGapMinutes(from: string, to: string): number {
  const [fh, fm] = from.split(':').map(Number)
  const [th, tm] = to.split(':').map(Number)
  return (th! - fh!) * 60 + (tm! - fm!)
}

/**
 * 下一个**尚未处理**的时段对应的毫秒时刻（UTC+8 基准）。
 *
 * 三种情形：
 * - 有时段待跑（水位线落后，或上一轮还有渠道没领到）⇒ 返回**现在**；
 * - 下一个时段的**真实执行时刻**还没到 ⇒ 返回那一刻（含浮动偏移）；
 * - `times` 为空 / 开关关 ⇒ 0。
 *
 * ⚠️ 「待跑即现在」这一步不能省：否则「22:00 启动、水位线停在昨天」会被算成
 * 「下次明天 10:05」，而实际上一轮补跑马上就要执行 —— 面板会显示自相矛盾的时间。
 * ⚠️ 但它**只覆盖「马上要跑」这一格**：退避重试期间真实的下一次尝试由
 * `state().nextRunAt` 取 `armNext` 排定的时刻（见 `nextAttemptAt`），不再在这里
 * 编一个「现在」（审计 P1-4：旧实现在退避期间一直显示「马上执行」，实际 30 分钟后）。
 */
export function nextRunAtOf(
  nowMs: number,
  doc: Pick<AutoCheckinDoc, 'enabled' | 'times' | 'lastSlot'> & {
    jitterMinutes?: number
    pendingSlot?: string
  },
): number {
  if (!doc.enabled) return 0
  if (doc.times.length === 0) return 0
  if (runnableSlotKey(doc, nowMs) !== '') return nowMs
  const next = nextSlotRef(nowMs, doc.times, doc.jitterMinutes ?? 0)
  return next === null ? 0 : next.realAt
}

/**
 * 距下一次执行的毫秒数。
 *
 * ⚠️ 待跑（水位线落后 / 有渠道没领到）时返回 **0** —— 调用方用
 * `Math.max(1_000, …)` 兜住，既保证「立刻补跑」，又不会在水位线尚未写盘时形成忙循环。
 *
 * ⚠️⚠️ 旧实现在这里留了一个坑（审计 P1-3）：「时段已到点、但浮动后的真实时刻还没到」
 * 也会返回 0 ⇒ `armNext` 每秒醒一次（实测 2 小时 2653 次唤醒）。现在「到点」的判据
 * 本身含偏移（见 `checkinSlotsAround`），这个中间态不存在了 ⇒ 会返回正的等待时长。
 */
export function nextRunDelayMs(
  nowMs: number,
  doc: Pick<AutoCheckinDoc, 'enabled' | 'times' | 'lastSlot'> & {
    jitterMinutes?: number
    pendingSlot?: string
  },
): number {
  if (runnableSlotKey(doc, nowMs) !== '') return 0
  const target = nextRunAtOf(nowMs, doc)
  if (target === 0) return 0
  return Math.max(0, target - nowMs)
}

/** 装配层注入的依赖（全部可替换 ⇒ 单测零网络、零文件系统、零等待）。 */
export interface AutoCheckinDeps {
  store: AutoCheckinStore
  /**
   * 列出**账号池里有账号**的渠道 id。
   * 只遍历有账号的渠道：没有账号的渠道调 `claimAll` 只会拿到空结果，白白走一遍
   * 12 条分支。
   */
  listProviderIds(): Promise<string[]>
  /**
   * 调某个渠道的签到 —— **必须复用 `credits.claimAll` 的实现**（装配层直接调内部
   * `handleMethod`）。本模块不认任何具体渠道，只按返回的信封判「跳过 / 失败」。
   */
  claim(provider: string): Promise<BadgeRpcResult<RpcCreditsClaimAllResponse>>
  now?(): number
  /** 延迟毫秒数；默认读环境变量。 */
  delayMs?: number
  /** 排定延迟执行（注入以便单测零等待）。返回值交给 `stop()` 取消。 */
  schedule?(fn: () => void, ms: number): { cancel(): void }
  warn?(message: string): void
}

/** 自动签到执行体。 */
export interface AutoCheckin {
  /** 实时状态（供 RPC 与状态灯；`enabled` 等取自内存，不重新读盘）。 */
  state(): RpcUsageAutoCheckinState
  /** 写开关；**打开时若有时段没跑，立刻跑一轮**（否则用户会以为开关没生效）。 */
  setEnabled(enabled: boolean): Promise<RpcUsageAutoCheckinState>
  /**
   * 写两个执行时刻（`HH:MM`，UTC+8）。
   *
   * ⚠️ 校验必须在**写入前**：非法值一律拒绝（抛错由 RPC 层转成 `bad-request`），
   * **不做静默回落** —— 回落会让「设置没生效」看起来像「保存成功」。
   * ⚠️ 写完要**重排定时器**：否则新的 21:00 要等到明天才生效。
   */
  setTimes(times: readonly string[], jitterMinutes?: number): Promise<RpcUsageAutoCheckinState>
  /**
   * 关闭面板上那行**常驻的**自动签到状态文字（用户点它上方的小按钮时调用）。
   *
   * ⚠️ 与手动签到的结果提示不同：那条是**按时自动消失**；这一条是用户要求
   * 「不要自动取消、给我开放手动关闭」。关闭记的是**这一轮**（当前的 `lastAt`），
   * 故下一轮跑出新结果时它会重新出现。
   */
  dismiss(): Promise<RpcUsageAutoCheckinState>
  /** 启动时调用一次：延迟后排定一轮（内部自己判开关与当天是否已跑）。 */
  start(): void
  /** 立刻按判据跑一轮（供「刚打开开关」与单测用）。 */
  runIfDue(): Promise<void>
  /** 取消尚未执行的延迟任务（不打断已开始的一轮）。 */
  stop(): void
}

/** 创建自动签到执行体。 */
export function createAutoCheckin(deps: AutoCheckinDeps): AutoCheckin {
  const now = deps.now ?? (() => Date.now())
  let doc = deps.store.load()
  let running = false
  /** 在飞去重：`setEnabled(true)` 与启动排定可能同时想跑。 */
  let inflight: Promise<void> | null = null
  let pending: { cancel(): void } | null = null

  const today = (): string => utc8DateString(now())

  function state(): RpcUsageAutoCheckinState {
    const nowMs = now()
    const todayKey = `${today()}#`
    return {
      enabled: doc.enabled,
      times: [...doc.times],
      jitterMinutes: doc.jitterMinutes,
      lastSlot: doc.lastSlot,
      lastDate: doc.lastDate,
      // ⚠️ 判据是**水位线落在今天**，不是「今天有没有写盘」：补跑昨天 21:00 那轮会
      //   更新 `lastAt`，但今天自己的时段还一个都没跑 ⇒ 仍该说「今天尚未执行」。
      ranToday: doc.lastSlot.startsWith(todayKey),
      // ★ 用 `armNext` 实际排定的时刻（含退避），不要用 `nextRunAtOf` 的「现在」：
      //   退避重试期间后者恒等于 now，面板会一直显示「马上执行」却什么都不发生。
      nextRunAt: doc.enabled ? (nextAttemptAt > 0 ? nextAttemptAt : nextRunAtOf(nowMs, doc)) : 0,
      pendingSlot: doc.pendingSlot,
      running,
      lastResult: doc.lastResult,
      lastAt: doc.lastAt,
      channels: doc.channels.map((entry) => ({ ...entry })),
      // 面板据它决定要不要渲染那行常驻状态文字
      dismissed: doc.lastAt > 0 && doc.dismissedRunAt === doc.lastAt,
    }
  }

  async function performRun(): Promise<void> {
    const startedAt = now()
    /**
     * ★ 本轮的**目标时段**在起跑时就定死（2026-11-01 审计 P1-6）。
     *
     * 旧实现取「跑完那一刻已到点的最大时段」，于是「08:58 启动补跑昨天 21:00、
     * 09:05 跑完」会把 **09:00 那轮**标成已完成 —— 它从未单独执行过。
     * 改成起跑时的时段后：跑完只推进到「这轮本来为哪个时段跑」，
     * 09:00 那轮该跑还是会跑（多跑一轮幂等，漏一轮可能丢一天额度）。
     *
     * ⚠️ 必须复用 {@link runnableSlotKey}（**唯一**判据），不要在这里再写一遍
     * 「pendingSlot 优先」：两处判据一旦漂移，就会出现「判据说跑 A、这轮打的是 B」
     * ⇒ 水位线推错、或同一时段被反复打。
     */
    const targetSlot = runnableSlotKey(doc, startedAt)
    const totals = emptyTotals()
    let providers: string[] = []
    try {
      providers = [...new Set(await deps.listProviderIds())].sort()
    } catch (error) {
      // 账号池读不出来：不记日期，下次启动重试。
      deps.warn?.(`[jet-hub] 自动签到：读取账号池失败，本次跳过: ${String(error)}`)
      return
    }
    const channels: Array<{ provider: string; text: string }> = []
    /**
     * 本轮已确认「这个时段处理过了」的渠道 —— 逐渠道水位线的写入集。
     *
     * ⚠️ 判据是**逐渠道**的 `coversToday`，不是整轮合计（审计 P1-5）：
     * 混合池里只要有别的渠道证明今天，整轮就会记账，Qoder 这类 **10:00 才刷新
     * 额度**的渠道于是再也不会被单独重试 ⇒ 当天漏领。
     */
    const proven = new Set<string>()
    /**
     * 「设计上就不该重试」的渠道（排除表 / 无签到接口）。
     *
     * ⚠️ 它们既不构成「今天跑过」（`proven`），也不该拖住水位线（`lagging`）——
     * 否则一个 zcode 账号会让整条链永远在重试（而它每次都是零请求，纯浪费）。
     */
    const unretryable = new Set<string>()
    /**
     * 逐渠道水位线的**当前有效值**：只保留池里还存在的渠道。
     *
     * ⚠️ 为什么会残留（2026-11-01 第二轮审计 P3）：渠道被删 / 改名后，键还留在文档里；
     * 用户再把同一渠道加回来时，那条**旧水位线**会让它被判成「本轮已处理」而跳过
     * 上游签到（实测：池空 → 加回同一渠道 ⇒ 12:00 那次 `claim` 调用次数 = 0）。
     * 故每轮开始时按当前池**重建**这张表。
     */
    const prunedSlots: Record<string, string> = {}
    for (const provider of providers) {
      const value = doc.providerSlots?.[provider] ?? ''
      if (value !== '') prunedSlots[provider] = value
    }
    const prunedChanged = Object.keys(prunedSlots).length !== Object.keys(doc.providerSlots ?? {}).length
    if (prunedChanged) doc = { ...doc, providerSlots: prunedSlots }
    for (const provider of providers) {
      // 逐渠道水位线：该渠道在这个时段已经处理过 ⇒ 跳过（重试时不再重复打上游）。
      if (targetSlot !== '' && (prunedSlots[provider] ?? '') >= targetSlot) {
        channels.push({ provider, text: '本轮已处理' })
        proven.add(provider)
        continue
      }
      // ⚠️ 排除表先于**任何**上游请求生效（见 isAutoCheckinExcluded 的说明）：
      // zcode 的代价发生在**调用期间**（拉起浏览器产 captcha），事后再判断已经
      // 太晚 —— 必须在调 `claim` 之前就把它摘掉。
      if (isAutoCheckinExcluded(provider)) {
        totals.skipped += 1
        channels.push({ provider, text: '需手动签到' })
        unretryable.add(provider)
        continue
      }
      let result: BadgeRpcResult<RpcCreditsClaimAllResponse>
      try {
        result = await deps.claim(provider)
      } catch (error) {
        totals.errors += 1
        channels.push({ provider, text: '出错' })
        deps.warn?.(`[jet-hub] 自动签到：${provider} 调用异常: ${String(error)}`)
        continue
      }
      if (!result.ok) {
        const message = typeof result.error?.message === 'string' ? result.error.message : ''
        if (isUnsupportedCheckin(message)) {
          totals.skipped += 1
          channels.push({ provider, text: '无签到接口' })
          unretryable.add(provider)
          continue
        }
        totals.errors += 1
        channels.push({ provider, text: '出错' })
        deps.warn?.(`[jet-hub] 自动签到：${provider} 失败: ${message || '未知错误'}`)
        continue
      }
      totals.providers += 1
      const summary = result.value?.summary
      if (summary === undefined) {
        channels.push({ provider, text: '无可领' })
        continue
      }
      totals.claimed += summary.claimed
      totals.totalCredit += summary.totalCredit
      // ★ 按单位累加（2026-10-04）：`totalByUnit` 缺省时回落到「全部按积分」，
      //   兼容尚未上报该字段的旧宿主响应 —— 与 `coversToday` 的兜底同思路。
      const byUnit = summary.totalByUnit ?? { credit: summary.totalCredit, token: 0 }
      totals.totalByUnit.credit += Number(byUnit.credit) || 0
      totals.totalByUnit.token += Number(byUnit.token) || 0
      totals.alreadyClaimed += summary.alreadyClaimed
      totals.inactive += summary.inactive
      totals.failed += summary.failed
      // ⚠️ 记账口径**只认**这一项：渠道用 `coversToday` 自己声明「这条痕迹是不是
      // 今天这一轮的」。缺省回落到 `claimed + alreadyClaimed`，是为了兼容尚未
      // 上报该字段的旧响应（缺字段 ≠ 0，否则整轮会被判成「什么都没证明」）。
      const coversToday = summary.coversToday ?? (summary.claimed + summary.alreadyClaimed)
      totals.coversToday += coversToday
      channels.push({ provider, text: describeChannel(summary) })
      if (coversToday > 0) proven.add(provider)
    }

    if (providers.length === 0) {
      // 一个渠道都没有：没有可领的东西，也不该推进水位线（用户随时可能加账号）。
      // 与旧行为一致地记账失败 ⇒ 走退避（此时**零上游请求**，不会轰炸）。
      dueFailures += 1
      // ⚠️ 但**要把清掉的逐渠道水位线落盘**：否则「渠道被删 → 又加回来」时，
      //   磁盘上那条旧水位线会让它被判成「本轮已处理」而跳过签到（第二轮审计 P3）。
      if (prunedChanged) {
        try {
          await deps.store.save(doc)
        } catch (error) {
          deps.warn?.(`[jet-hub] 自动签到：清理逐渠道水位线写入失败: ${String(error)}`)
        }
      }
      deps.warn?.(`[jet-hub] 自动签到：账号池里没有可签到的渠道（第 ${dueFailures} 次）`)
      return
    }

    if (proven.size === 0) {
      // ⚠️ **整轮没有任何一条渠道能证明「今天已被处理」** ⇒ **不推进**水位线（保留
      //   旧语义，当时由「整轮 coversToday>0」判 —— 现在逐渠道判）：
      //   - 凭据全过期 / 网络不通 / 启动太早抢在续期之前；
      //   - 「只有 zcode」这类**全部被跳过**的池子：跳过不构成「今天跑过」。
      //   下一次按退避重试（`dueFailures` 记账，避免退回每秒一轮的忙循环）。
      //
      // ★ 但**必须**把这轮的可读结果写下来（2026-11-01 第二轮审计 P2-8）：旧实现
      //   在这里直接 return，`lastResult` / `channels` 停在几天前那一轮 ⇒ 凭据全过期
      //   时面板永远显示「上次：昨天的成功」，用户看不到「今天一直在失败」。
      dueFailures += 1
      doc = {
        ...doc,
        lastResult: `${describeRun(totals)}（本轮未计入今日，稍后重试）`,
        lastAt: now(),
        channels,
        // 与成功路径同一条理由：新一轮结果出来，之前「已关闭」的标记要失效。
        dismissedRunAt: 0,
      }
      try {
        await deps.store.save(doc)
      } catch (error) {
        deps.warn?.(`[jet-hub] 自动签到失败结果写入失败: ${String(error)}`)
      }
      deps.warn?.(
        `[jet-hub] 自动签到未记入今日（第 ${dueFailures} 次，将退避 ${Math.round(retryBackoffMs(dueFailures) / 1000)} 秒后重试）：${describeRun(totals)}`,
      )
      return
    }

    const nextProviderSlots: Record<string, string> = {}
    for (const provider of providers) {
      const value = proven.has(provider) ? targetSlot : (prunedSlots[provider] ?? '')
      if (value !== '') nextProviderSlots[provider] = value
    }
    // ★ 待补 = 「有渠道证明了今天，但这个渠道还没有，且它**有可能**领到」。
    //   设计上不该重试的（排除表 / 无签到接口）不算待补，否则它们会拖住水位线。
    const lagging = providers.filter((provider) => !proven.has(provider) && !unretryable.has(provider))
    // 补领预算：**按时间**而不是按次数（2026-11-01 第二轮审计 P2-1）。
    //
    // ⚠️ 旧实现按「14 次」算 ⇒ 累计只有 7447 秒（124 分钟），而最坏情况需要
    //   「09:00 时段被 -120 分钟浮动推到 07:00，等 Qoder 10:00 刷新」= **180 分钟**
    //   ⇒ 预算先耗尽，当天 Qoder 仍然漏领。改成时间窗 3 小时后覆盖得住；
    //   次数上限只作为「时间不可信（时钟回拨）」时的兜底。
    if (lagSince === 0 || doc.pendingSlot !== targetSlot) {
      // 换了一个时段、或**本进程刚接手**（`lagSince` 还是 0，例如重启后文档里
      // 已带着 `pendingSlot`）⇒ 预算从这一刻重新计 3 小时窗。
      // ⚠️ 少了 `lagSince === 0` 这一腿，重启后的补领会**永远不计时**、也就永远不会
      //    放弃（实测：3h05m 后仍在重试）。
      lagSince = now()
      lagAttempts = 0
    }
    lagAttempts += 1
    const overWindow = lagSince > 0 && now() - lagSince > LAG_RETRY_WINDOW_MS
    const giveUp = lagging.length > 0 && (overWindow || lagAttempts > LAG_RETRY_MAX)

    if (lagging.length > 0 && !giveUp) {
      // ★ 部分完成：**不动** `lastSlot`（这个时段还没处理完），改用 `pendingSlot`
      //   记住它，并按退避只重试没领到的渠道（`providerSlots` 让已领的跳过）。
      dueFailures += 1
      doc = {
        ...doc,
        pendingSlot: targetSlot,
        providerSlots: nextProviderSlots,
        lastResult: `${describeRun(totals)}（${lagging.length} 个渠道待补）`,
        lastAt: now(),
        channels,
        dismissedRunAt: 0,
      }
      try {
        await deps.store.save(doc)
      } catch (error) {
        deps.warn?.(`[jet-hub] 自动签到部分结果写入失败: ${String(error)}`)
      }
      deps.warn?.(
        `[jet-hub] 自动签到部分完成（${targetSlot}）：${lagging.join('、')} 还没证明今天，`
        + `第 ${lagAttempts} 次重试将在 ${Math.round(retryBackoffMs(dueFailures) / 1000)} 秒后`,
      )
      return
    }

    // 全部渠道都处理完（或放弃重试）：推进水位线。
    const finishedSlot = targetSlot === '' ? doc.lastSlot : targetSlot
    doc = {
      ...doc,
      lastDate: today(),
      lastSlot: finishedSlot,
      pendingSlot: '',
      providerSlots: nextProviderSlots,
      lastResult: giveUp
        ? `${describeRun(totals)}（${lagging.length} 个渠道放弃补领，等下一个时段）`
        : describeRun(totals),
      lastAt: now(),
      channels,
      // ⚠️ 新一轮跑完要**清掉上一次的「已关闭」标记**：否则用户关过一次后，
      // 明天的新结果会被旧标记静默藏住（`dismissed` 的判据是 lastAt 相等）。
      dismissedRunAt: 0,
    }
    try {
      await deps.store.save(doc)
      // ★ 记账成功 ⇒ 清掉退避计数（下一轮是正常时段，不该带着旧退避），
      //   同时把**补领预算**归零（下一个时段重新计 3 小时窗）。
      dueFailures = 0
      lagAttempts = 0
      lagSince = 0
    } catch (error) {
      // 写盘失败 ⇒ 今天可能再跑一次（幂等，代价是多发一轮请求），如实告警。
      // ⚠️ 也记一次失败：否则关闭循环又变成每秒重试。
      dueFailures += 1
      deps.warn?.(`[jet-hub] 自动签到结果写入失败（今天可能重复触发一次）: ${String(error)}`)
    }
    deps.warn?.(`[jet-hub] 自动签到完成（${finishedSlot || today()}）：${doc.lastResult}`)
  }

  function runIfDue(): Promise<void> {
    if (inflight !== null) return inflight
    if (!doc.enabled) return Promise.resolve()
    // ⚠️ 判据是「到点的时段处理完没有」，不是「今天跑过没有」：
    //   一天两个时段各自要跑一次，用「今天跑过」判会让第二个时段永不触发。
    if (!shouldRunNow(doc, now())) return Promise.resolve()
    running = true
    const task = performRun().catch((error: unknown) => {
      // ⚠️ 抛错也必须记账（2026-11-01 审计）：否则 `dueFailures` 不动 ⇒ `armNext`
      //    恒走 1 秒分支 ⇒「每秒重跑一轮」的忙循环会从「异常」这个入口原样复发。
      dueFailures += 1
      deps.warn?.(`[jet-hub] 自动签到异常（第 ${dueFailures} 次）: ${String(error)}`)
    }).finally(() => {
      running = false
      inflight = null
    })
    inflight = task
    return task
  }

  /**
   * 连续「跑了但没记账」的次数 —— 用于退避。
   *
   * ⚠️⚠️ 这个计数器修的是一个**真实的忙循环**（2026-11-01 实测）：上一版排定用
   * `Math.max(1_000, nextRunDelayMs(...))`，而「有时段到点但没跑成」时
   * `nextRunDelayMs` 恒返回 **0** ⇒ 每秒重跑一轮。实测 5 轮内 `claim` 被调用
   * **10 次**（2 渠道 × 5 轮）；凭据持续失效时等于**每秒打一轮上游** ——
   * 既烧请求也触发风控（签到是写操作）。
   *
   * 修法：失败后按 `RETRY_BACKOFF_BASE_MS` 指数退避（1s→2s→4s→…封顶 30 分钟），
   * 成功记账后清零。
   */
  let dueFailures = 0

  /** 退避起点：1 秒（保持「立刻补一次」的手感，但不至于每秒重来）。 */
  const RETRY_BACKOFF_BASE_MS = 1_000

  /** 退避上限：30 分钟。超过它就该等下一个正常时段，而不是继续重试。 */
  const RETRY_BACKOFF_MAX_MS = 30 * 60_000

  /**
   * 同一时段的补领**时间窗**：3 小时。
   *
   * 最坏情况是「09:00 时段被浮动（上限 120 分钟）推到 07:00，而 Qoder 10:00 才刷新」
   * ⇒ 需要等 **180 分钟**。窗口按时间算（而不是按次数）才覆盖得住。
   * ⚠️ 第一版按「14 次」估算，实际累计只有 7447 秒（124 分钟），少算 40% ——
   *   第二轮审计实测那条路径仍然漏领。改时间窗后不再取决于退避曲线怎么长。
   */
  const LAG_RETRY_WINDOW_MS = 3 * 3_600_000

  /**
   * 补领次数上限（兜底）。
   *
   * 时间窗在「时钟回拨 / 系统休眠导致 `now()` 不前进」时可能永远不到期，
   * 故再加一道次数闸：40 次 ×（最长 30 分钟）远大于 3 小时窗，正常路径不会先撞到它。
   */
  const LAG_RETRY_MAX = 40

  /** 当前时段已补领了几次（与 `dueFailures` 分开：后者是「整轮失败」的退避计数）。 */
  let lagAttempts = 0

  /** 当前时段的补领起点（换时段时重置）。 */
  let lagSince = 0

  /** 按连续失败次数算退避延迟（指数退避，封顶）。 */
  function retryBackoffMs(failures: number): number {
    const exponent = Math.min(failures, 16)
    return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (exponent - 1), RETRY_BACKOFF_MAX_MS)
  }

  /**
   * 下一次真实尝试的毫秒时刻（0 = 没有排定）。
   *
   * ⚠️ 存在的理由（2026-11-01 审计 P1-4）：`nextRunAtOf` 在「有时段待跑」时
   * 返回**现在**，而退避重试期间真实的下一次可能在 30 分钟后 ⇒ 面板会一直写
   * 「马上执行」却什么都不发生。故把 `armNext` 实际排定的时刻记下来供 `state()` 用。
   */
  let nextAttemptAt = 0

  /**
   * 排定「下一次该跑的时段」，跑完后自动续排。
   *
   * 语义闭环（这是「每天两次无遗漏」的落点）：
   * 1. 启动时先延迟一轮（`start()`），到点判定是否有时段落后 ⇒ 补跑错过的时段；
   * 2. 每轮跑完再排一次 —— 目标时刻 = **下一个尚未处理的时段**（或退避后的重试时刻）。
   *    故第一个时段跑完后会自动排到第二个，无需用户再做任何事；
   * 3. 用户改时段（`setTimes`）或改开关（`setEnabled`）都会**重排**，新时间立刻生效。
   *
   * ⚠️ 立刻到点的时段**不能**用 0 延迟递归 —— 那会在水位线还没写盘时形成忙循环。
   * 给 1 秒下限，让 `performRun` 有机会写盘。
   */
  function armNext(): void {
    pending?.cancel()
    pending = null
    nextAttemptAt = 0
    if (!doc.enabled) return
    const normal = nextRunDelayMs(now(), doc)
    // ⚠️ 判据是「**有时段待跑**（normal === 0）」而不是「到了一秒」：
    //   只有这种情况才会形成忙循环，必须用退避延迟把它按住。
    const ms = normal > 0
      ? Math.max(1_000, normal)
      : dueFailures > 0
        ? retryBackoffMs(dueFailures)
        : RETRY_BACKOFF_BASE_MS
    nextAttemptAt = now() + ms
    pending = (deps.schedule ?? defaultSchedule)(() => {
      pending = null
      void runIfDue().finally(() => { armNext() })
    }, ms)
  }

  return {
    state,
    async setEnabled(enabled) {
      doc = { ...doc, enabled }
      await deps.store.save(doc)
      // 开关一关就撤掉定时器：否则关掉之后还挂着下一轮，用户会以为「关了还在跑」。
      if (!enabled) { armNext(); return state() }
      // ★ 用户手点「打开」= 想让 **现在** 试一轮，不该带着上一轮的退避计数
      //   （否则刚打开就显示「30 分钟后重试」）。
      dueFailures = 0
      // 打开开关时立刻尝试一轮（有时段没跑则由 runIfDue 内部拦住）。
      // ⚠️ 不 await：一轮要串行打十几个上游，让按钮等它会让界面像卡死；
      // `state()` 里的 `running` 会立刻变成 true，界面据此显示「进行中」。
      // ⚠️ 跑完必须 armNext()：否则「打开开关」这条路径不会排下一轮，
      //   10:05 打开的用户当天 21:00 那轮就永远不触发。
      void runIfDue().finally(() => { armNext() })
      return state()
    },
    async setTimes(times, jitterMinutes) {
      // ⚠️ 校验在写入**之前**、且抛错而不是回落：回落会让「设置没生效」看起来像
      //    「保存成功」。
      if (!Array.isArray(times)) throw new Error('times 必须是字符串数组')
      const cleaned = sanitizeTimesStrict(times)
      // `jitterMinutes` 省略 = **不改动**（与 times 的语义独立：用户可能只调时刻）。
      // 给出时必须是合法数字，否则同样抛错而不是静默回落。
      const jitter = jitterMinutes === undefined
        ? doc.jitterMinutes
        : sanitizeJitterStrict(jitterMinutes)
      // ★ 改时段 = 重新开始记账：
      //   - `pendingSlot` 是**旧时刻表**下的时段 key，留着会指向一个不存在的时刻；
      //   - `dueFailures` 不清零的话，改完时刻后的第一次重试还要等 30 分钟
      //     （审计 P1-4 的附带症状：用户改完设置却半小时没动静）。
      doc = { ...doc, times: cleaned, jitterMinutes: jitter, pendingSlot: '' }
      dueFailures = 0
      await deps.store.save(doc)
      // 新时间立刻生效：撤掉按旧时刻排的那一轮，按新时刻重排。
      armNext()
      return state()
    },
    start() {
      if (pending !== null) return
      const ms = deps.delayMs ?? autoCheckinDelayMs()
      const fire = (): void => {
        pending = null
        // 跑完再排下一轮：这是「每天两次」能自动续上的关键。
        void runIfDue().finally(() => { armNext() })
      }
      // 延迟为 0 = 立刻跑（单测的默认形态，也是用户把环境变量设成 0 时的语义）。
      if (ms <= 0) {
        fire()
        return
      }
      pending = (deps.schedule ?? defaultSchedule)(fire, ms)
    },
    runIfDue,
    async dismiss() {
      // 记「关闭的是哪一轮」（当前的 lastAt）：下一轮跑完 lastAt 会变，文字自动回来。
      doc = { ...doc, dismissedRunAt: doc.lastAt }
      try {
        await deps.store.save(doc)
      } catch (error) {
        // 写盘失败 ⇒ 重开面板时那行文字会再出现（还可再点一次关闭），如实告警。
        deps.warn?.(`[jet-hub] 自动签到状态文字关闭标记写入失败: ${String(error)}`)
      }
      return state()
    },
    stop() {
      pending?.cancel()
      pending = null
      // 清掉「已排定时刻」的记录：之后 `state().nextRunAt` 会**回落到**「按当前时刻
      // 算出的下一时段」，而不是一个本进程已经取消掉的时刻。
      // ⚠️ 别指望它变 0：开关仍是开着的，回落值可能是「现在（有待跑时段）」也可能是
      //   下一个时段的时刻。0 只在开关关闭时才出现（`armNext` 的清零 + `state()` 判 enabled）。
      nextAttemptAt = 0
    },
  }
}

/**
 * 默认排定：`setTimeout` + `unref()`。
 *
 * ⚠️ `unref()` 是必须的：否则一个 30 秒的待执行定时器会**拖住宿主进程退出**
 *（用户关掉 DSH 后进程还要多活半分钟）。与 `index.ts` 的续期定时器同一处理。
 */
function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}
