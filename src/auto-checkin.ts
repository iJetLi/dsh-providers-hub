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
 * 下次启动会重试（见 `shouldMarkToday`）。延迟可用
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
 * 为什么是 09:00 / 21:00：本仓库各渠道的每日额度刷新时点集中在上午（Qoder 活动
 * 10:00 才刷新、其余多为 00:00 或登录触发）。09:00 那轮把「00:00 刷新」的那批
 * 领掉；21:00 那轮兜住「上午才刷新 / 上午那轮因凭据未续上而失败」的情况。
 * 间隔 12 小时，任一轮失败都还有另一轮兜底 —— 这正是用户要的「无遗漏」。
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
  lastResult: '',
  lastAt: 0,
  channels: [],
  dismissedRunAt: 0,
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
    lastResult: typeof record.lastResult === 'string' ? record.lastResult : '',
    lastAt: ms(record.lastAt),
    channels: sanitizeChannels(record.channels),
    dismissedRunAt: ms(record.dismissedRunAt),
  }
}

/**
 * 归一化时段列表：丢掉非法项、去重、升序，**不足/超出都回落到默认两个**。
 *
 * ⚠️ 不能「只补到两个」：旧文档没有 `times` 字段 ⇒ 空数组 ⇒ 若原样保留，自动
 * 签到会**永远等不到时段**（一天都不跑），而这正是本特性的核心失效形态。回落
 * 默认值让升级后立刻按 09:00/21:00 工作，用户再改。
 * ⚠️ 也不能保留多于两个：用户要求「一天两次」，多留的时段会变成「一天跑三次」，
 * 与「不多次重复触发」的既有语义冲突。多余项按排序后取前两个。
 */
export function sanitizeTimes(raw: unknown): string[] {
  const valid: string[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string' || !TIME_RE.test(item)) continue
      if (!valid.includes(item)) valid.push(item)
    }
  }
  if (valid.length < AUTO_CHECKIN_SLOT_COUNT) return [...DEFAULT_AUTO_CHECKIN_TIMES]
  return valid.sort().slice(0, AUTO_CHECKIN_SLOT_COUNT)
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
 * 当前时刻落在「哪个时段区间」：返回**已到点的最大时段 key**。
 *
 * 例（times = 09:00 / 21:00）：
 * - 今天 08:30 ⇒ 已到点的是**昨天 21:00**；
 * - 今天 09:05 ⇒ 今天 09:00；
 * - 今天 22:00 ⇒ 今天 21:00。
 */
export function latestDueSlotKey(nowMs: number, times: readonly string[]): string {
  const sorted = [...times].sort()
  if (sorted.length === 0) return ''
  const today = utc8DateString(nowMs)
  const hhmm = utc8TimeString(nowMs)
  let best = ''
  for (const time of sorted) {
    if (time <= hhmm) best = slotKey(today, time)
  }
  if (best !== '') return best
  // 今天还没有任何时段到点 ⇒ 往前推一天，取昨天最后一个时段。
  const yesterday = utc8DateString(nowMs - 86_400_000)
  const last = sorted[sorted.length - 1]
  return last === undefined ? '' : slotKey(yesterday, last)
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
 * 该不该现在跑一轮：**水位线落后于「已到点的最大时段」**就跑。
 *
 * ⚠️ 这里**不是**「今天跑过没有」，而是「到点的时段都处理完没有」——
 * 一天两个时段各自要跑一次，用「今天跑过」判会让第二个时段永远不触发。
 * ⚠️ `lastSlot` 为空（从未跑过）⇒ 只要有到点的时段就跑：这正是「首次启用
 * 立刻补跑」的行为。
 */
export function shouldRunNow(
  doc: Pick<AutoCheckinDoc, 'enabled' | 'times' | 'lastSlot'> & { jitterMinutes?: number },
  nowMs: number,
): boolean {
  if (!doc.enabled) return false
  // ⚠️ 这里刻意**也接受 lastDate**（下面一行用 `??` 兜底不到，故单列说明）：
  //   旧文档有 lastDate 但没有 lastSlot ⇒ 无法判断今天两个时段各自处理了没有。
  //   取「补跑」而不是「当成已跑」：签到是幂等的（对已领的号上游返回
  //   alreadyClaimed），代价是一轮请求；而误判成「已跑」的代价是**当天整天漏领**。
  const due = latestDueSlotKey(nowMs, doc.times)
  if (due === '') return false
  if (!((doc.lastSlot ?? '') === '' || doc.lastSlot < due)) return false
  //
  // ★ 随机浮动（2026-10-31）：水位线落后**不等于**现在就该跑 ——
  //   若给这个时段配了浮动，真实执行时刻是「时段时刻 + 偏移」。
  //   例：09:00 配 ±10 分、本轮偏移 +7 ⇒ 真实执行 09:07。
  //   在 09:05 时水位线已经落后（09:00 已到点），但**还没到** 09:07 ⇒ 不该跑。
  //
  // ⚠️ 但「**已过期很久**」的时段必须立刻补跑，不能因为偏移而永久卡住：
  //   判据是「真实执行时刻已过」即可 —— 与偏移是过去还是未来无关。
  //   这同时覆盖了「错过的时段」（真实时刻早已过去）。
  const jitter = sanitizeJitter(doc.jitterMinutes)
  if (jitter <= 0) return true
  const date = due.slice(0, 10)
  const time = due.slice(11, 16)
  const sorted = [...doc.times].sort()
  const index = sorted.indexOf(time)
  const gap = index >= 0 && index + 1 < sorted.length
    ? timeGapMinutes(time, sorted[index + 1]!)
    : timeGapMinutes(time, sorted[0] ?? time) + 24 * 60
  const realAt = slotMomentMs(date, time, jitter, gap)
  return nowMs >= realAt
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
   * ⚠️ 这是 {@link shouldMarkToday} **唯一**该看的口径 —— 不能用
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
 * 这一轮该不该把「今天」记为已跑。
 *
 * 判据：**至少有一个账号能证明「今天这一轮已被处理」**（`coversToday > 0`）才记。
 *
 * ⚠️⚠️ **为什么不能看 `claimed + alreadyClaimed`**（真实缺陷，2026-10-02 审查
 * PR !33 定位）：那两项里混着「**刷新前那一轮**」的痕迹。Qoder 的活动每日
 * 10:00（UTC+8）才刷新，于是上午 9 点跑的那一轮看到的是**昨天**那条 `CLAIMED`
 * —— 记成「今天已跑」之后，当天 10 点刷新出来的新额度**整天不会再被领**，
 * 而且界面还显示「1 个今天已领」，用户毫无提示。渠道自己用
 * `ClaimOutcome.coversToday` 标出「这条不算今天」，本函数只负责数。
 *
 * 反例（不记、下次启动重试）：
 * - 整轮零成功零已领（凭据全过期 / 网络不通 / 启动太早抢在续期之前）——
 *   若记了，用户当天就再也不会自动签到，且界面只说「上次：N 个失败」；
 * - 跑完但**没有一条能证明今天**（例如只有 Qoder 且赶在 10:00 之前）——
 *   同理不记，当天稍后还有机会；
 * - 一个渠道都没跑（全被跳过）：没有意义，不记。
 * 反之「有成功也有失败」要记：否则一个坏账号会让插件每次启动都把好账号再领一遍
 * （虽然幂等，但白白多发请求）。
 */
export function shouldMarkToday(totals: RunTotals): boolean {
  return totals.coversToday > 0
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
 * 下一个**尚未处理**的时段对应的毫秒时刻（UTC+8 基准）。
 *
 * 语义：返回「水位线之后、且还没到点的最近一个时段」。三种情形：
 * - 有已到点但没跑的时段（水位线落后）⇒ 返回**现在**（补跑马上执行）；
 * - 今天还有时段没到点 ⇒ 今天那个时刻；
 * - 今天的都过完了 ⇒ 明天第一个时刻。
 *
 * ⚠️ 「落后即现在」这一步不能省：否则「22:00 启动、水位线停在昨天」会被算成
 * 「下次明天 09:00」，而实际上一轮补跑马上就要执行 —— 面板会显示一个自相矛盾时间。
 */
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

export function nextRunAtOf(
  nowMs: number,
  doc: Pick<AutoCheckinDoc, 'enabled' | 'times' | 'lastSlot'> & { jitterMinutes?: number },
): number {
  if (!doc.enabled) return 0
  const sorted = [...doc.times].sort()
  if (sorted.length === 0) return 0
  const jitter = sanitizeJitter(doc.jitterMinutes)
  const due = latestDueSlotKey(nowMs, sorted)
  // ⚠️ 「水位线落后」时**返回现在**，不要套浮动：这一轮是**补跑**，用户期待它
  //    立刻开始；给它加个「再等 7 分钟」的偏移会让补跑看着像没生效。
  if (due !== '' && ((doc.lastSlot ?? '') === '' || doc.lastSlot < due)) return nowMs
  const today = utc8DateString(nowMs)
  const hhmm = utc8TimeString(nowMs)
  for (let i = 0; i < sorted.length; i += 1) {
    const time = sorted[i]!
    if (time <= hhmm) continue
    const key = slotKey(today, time)
    if ((doc.lastSlot ?? '') === '' || key > doc.lastSlot) {
      // 与**下一个**时段的间隔（末尾则用「到明天第一个」的间隔）。
      const gap = i + 1 < sorted.length
        ? timeGapMinutes(time, sorted[i + 1]!)
        : timeGapMinutes(time, sorted[0]!) + 24 * 60
      return slotMomentMs(today, time, jitter, gap)
    }
  }
  const tomorrow = utc8DateString(nowMs + 86_400_000)
  const gap = timeGapMinutes(sorted[0]!, sorted.length > 1 ? sorted[1]! : sorted[0]!)
  const effectiveGap = sorted.length > 1 ? gap : gap + 24 * 60
  return slotMomentMs(tomorrow, sorted[0]!, jitter, effectiveGap)
}

/**
 * 距下一次执行的毫秒数。
 *
 * ⚠️ 水位线落后（错过时段）时返回 **0** —— 调用方用 `Math.max(1_000, …)` 兜住，
 * 既保证「立刻补跑」，又不会在水位线尚未写盘时形成忙循环。
 */
export function nextRunDelayMs(
  nowMs: number,
  doc: Pick<AutoCheckinDoc, 'enabled' | 'times' | 'lastSlot'>,
): number {
  const due = latestDueSlotKey(nowMs, doc.times)
  if (doc.enabled && ((doc.lastSlot ?? '') === '' || doc.lastSlot < due)) return 0
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
    return {
      enabled: doc.enabled,
      times: [...doc.times],
      jitterMinutes: doc.jitterMinutes,
      lastSlot: doc.lastSlot,
      lastDate: doc.lastDate,
      ranToday: doc.lastSlot.startsWith(`${today()}#`),
      nextRunAt: nextRunAtOf(now(), doc),
      running,
      lastResult: doc.lastResult,
      lastAt: doc.lastAt,
      channels: doc.channels.map((entry) => ({ ...entry })),
      // 面板据它决定要不要渲染那行常驻状态文字
      dismissed: doc.lastAt > 0 && doc.dismissedRunAt === doc.lastAt,
    }
  }

  async function performRun(): Promise<void> {
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
    for (const provider of providers) {
      // ⚠️ 排除表先于**任何**上游请求生效（见 isAutoCheckinExcluded 的说明）：
      // zcode 的代价发生在**调用期间**（拉起浏览器产 captcha），事后再判断已经
      // 太晚 —— 必须在调 `claim` 之前就把它摘掉。
      if (isAutoCheckinExcluded(provider)) {
        totals.skipped += 1
        channels.push({ provider, text: '需手动签到' })
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
      totals.coversToday += summary.coversToday ?? (summary.claimed + summary.alreadyClaimed)
      channels.push({ provider, text: describeChannel(summary) })
    }

    if (!shouldMarkToday(totals)) {
      // ⚠️ 刻意**不写** lastDate：让「凭据还没续上 / 网络不通 / 赶在渠道刷新前
      // 跑的那一轮」能在下次启动重试，而不是当天就此放弃（判据见 shouldMarkToday）。
      //
      // ★★ 但**必须记失败次数**（2026-11-01 修忙循环）：不记账 ⇒ 水位线不动 ⇒
      //    `nextRunDelayMs` 恒返回 0 ⇒ 每秒重跑一轮。实测 5 轮内 claim 被调 10 次。
      //    记次数后 `armNext` 会按指数退避排下一次（1s→2s→4s→… 封顶 30 分钟）。
      dueFailures += 1
      deps.warn?.(
        `[jet-hub] 自动签到未记入今日（第 ${dueFailures} 次，将退避 ${Math.round(retryBackoffMs(dueFailures) / 1000)} 秒后重试）：${describeRun(totals)}`,
      )
      return
    }

    // ★ 水位线取「跑完之后已到点的最大时段」而不是「跑之前那个」：
    //   一轮可能跨过时段边界（例如 08:59 启动、跑完已 09:03），若记成跑之前的
    //   时段，09:00 这轮会被判成「没跑过」而立刻重跑一次。
    const finishedSlot = latestDueSlotKey(now(), doc.times)
    doc = {
      ...doc,
      lastDate: today(),
      lastSlot: finishedSlot === '' ? doc.lastSlot : finishedSlot,
      lastResult: describeRun(totals),
      lastAt: now(),
      channels,
      // ⚠️ 新一轮跑完要**清掉上一次的「已关闭」标记**：否则用户关过一次后，
      // 明天的新结果会被旧标记静默藏住（`dismissed` 的判据是 lastAt 相等）。
      dismissedRunAt: 0,
    }
    try {
      await deps.store.save(doc)
      // ★ 记账成功 ⇒ 清掉退避计数（下一轮是正常时段，不该带着旧退避）。
      dueFailures = 0
    } catch (error) {
      // 写盘失败 ⇒ 今天可能再跑一次（幂等，代价是多发一轮请求），如实告警。
      // ⚠️ 也记一次失败：否则关闭循环又变成每秒重试。
      dueFailures += 1
      deps.warn?.(`[jet-hub] 自动签到结果写入失败（今天可能重复触发一次）: ${String(error)}`)
    }
    deps.warn?.(`[jet-hub] 自动签到完成（${today()}）：${doc.lastResult}`)
  }

  function runIfDue(): Promise<void> {
    if (inflight !== null) return inflight
    if (!doc.enabled) return Promise.resolve()
    // ⚠️ 判据是「到点的时段处理完没有」，不是「今天跑过没有」：
    //   一天两个时段各自要跑一次，用「今天跑过」判会让第二个时段永不触发。
    if (!shouldRunNow(doc, now())) return Promise.resolve()
    running = true
    const task = performRun().catch((error: unknown) => {
      deps.warn?.(`[jet-hub] 自动签到异常: ${String(error)}`)
    }).finally(() => {
      running = false
      inflight = null
    })
    inflight = task
    return task
  }

  /**
   * 排定「下一次该跑的时段」，跑完后自动续排。
   *
   * 语义闭环（这是「每天两次无遗漏」的落点）：
   * 1. 启动时先延迟一轮（`start()`），到点判定是否有时段落后 ⇒ 补跑错过的时段；
   * 2. 每轮跑完再排一次 —— 目标时刻 = **下一个尚未处理的时段**。故 09:00 跑完后
   *    会自动排到 21:00，无需用户再做任何事；
   * 3. 用户改时段（`setTimes`）或改开关（`setEnabled`）都会**重排**，新时间立刻生效。
   *
   * ⚠️ 立刻到点的时段**不能**用 0 延迟递归 —— 那会在水位线还没写盘时形成忙循环。
   * 给 1 秒下限，让 `performRun` 有机会写盘。
   */
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

  /** 按连续失败次数算退避延迟（指数退避，封顶）。 */
  function retryBackoffMs(failures: number): number {
    const exponent = Math.min(failures, 16)
    return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (exponent - 1), RETRY_BACKOFF_MAX_MS)
  }

  function armNext(): void {
    pending?.cancel()
    pending = null
    if (!doc.enabled) return
    const normal = nextRunDelayMs(now(), doc)
    // ⚠️ 判据是「**有时段待跑**（normal === 0）」而不是「到了一秒」：
    //   只有这种情况才会形成忙循环，必须用退避延迟把它按住。
    const ms = normal > 0
      ? Math.max(1_000, normal)
      : dueFailures > 0
        ? retryBackoffMs(dueFailures)
        : RETRY_BACKOFF_BASE_MS
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
      // 打开开关时立刻尝试一轮（有时段没跑则由 runIfDue 内部拦住）。
      // ⚠️ 不 await：一轮要串行打十几个上游，让按钮等它会让界面像卡死；
      // `state()` 里的 `running` 会立刻变成 true，界面据此显示「进行中」。
      // ⚠️ 跑完必须 armNext()：否则「打开开关」这条路径不会排下一轮，
      //   09:00 打开的用户当天 21:00 那轮就永远不触发。
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
      doc = { ...doc, times: cleaned, jitterMinutes: jitter }
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