/**
 * 活动徽标的**悬停文案**（issue #101 的表现腿，方案 A）。
 *
 * ## 它解决什么
 *
 * 宿主 0.2.2 的徽标契约只有 `{ text, tone }` 两个字段（实测 dsh-llm 0.2.2-rc.3 的
 * listModels 白名单只写出这两格，且 `hover` / `tooltip` / `title` 三个词在该文件里
 * **各 0 次命中**），而宿主自己的回落渲染 `jsx(Tag, { tone, children: resolveText(text) })`
 * **不带 title**。于是上游那句活动说明（`hover.textZh`）与有效期（`validFrom` /
 * `validUntil` / `daily`）在数据面上**无处可放** —— 用户看到一枚「限时免费」却不知道
 * 它哪天过期，正是本次要补的那一格。
 *
 * 唯一的出口是 `conversation.input.model.label` 槽位（宿主文档原文：「A contribution
 * replaces both and receives the badge in its owner props」）—— 由占位者自己画名字 +
 * 徽标 + 悬停。本模块就是那句悬停，**纯函数、零 DOM**，宿主侧与浏览器侧共用一份实现
 * （本仓纪律：同一 schema 不写两套判据）。
 *
 * ## 三条判据（与参考实现 dsh-connect-workbuddy/client/promo-badge.ts 同口径）
 *
 * 1. **不替上游说话**：每一句都是上游自己的 `hover.textZh` / `hover.textEn`，
 *    插件不翻译、不改写、不从 `discount.factor` 反推措辞。
 * 2. **日期按上游声明的时区读**：上游写 `validFrom: "2026-07-06T00:00:00+08:00"`，
 *    自己的文案说「7月6日」。拿读者的时区格式化会在 UTC 以西显示成 7月5日 ——
 *    同一句悬停里自相矛盾。
 * 3. **`validUntil` 端点不含，展示要减 1 毫秒**：上游把它写成「活动次日的零点」,
 *    文案却说「– 10月31日」。原值渲染会多说一天。
 *
 * ## 空件不占位
 *
 * 只发了一个 `badge` 的规则就只有一个悬停标题；缺哪件就**不出现分隔符**，
 * 全缺 ⇒ 返回空串（展示层据此**不写 title 属性**，而不是写一个空 title）。
 */

import { promotionBadgeColor } from './model-promotions.js'
import type { ModelPromotion, ModelPromotionCopy } from './model-promotions.js'

/**
 * 一条**未决**候选：某个模型挂着某条活动。
 *
 * ## 为什么要它（方案 A 的接缝）
 *
 * 宿主徽标契约只有 `{ text, tone }`，装不下悬停那句（模块头已取证）。所以
 * `conversation.input.model.label` 的**占位者**必须自己拿到候选表、自己在渲染时
 * 按此刻挑一枚、自己画 chip + title。
 *
 * ⚠️ 交出去的是**候选表**（未挑定），不是挑好的徽标：徽标在装配时刻求值并缓存
 * 正是 issue #101 要修的形态（取舍 1）。浏览器侧每次渲染都重读时钟 ⇒ 跨过窗口
 * 边界那一分钟，行上的徽标会自己变，不需要重拉目录。
 *
 * ⚠️ `ModelPromotion` 的每个字段都是 JSON 原生类型（string / number / boolean /
 * 数组 / 嵌套对象），可直接过 RPC，**不需要**再造一层序列化形状 —— 多一层就
 * 多一份会漂移的判据。
 */
export interface PromotionCandidateRow {
  readonly modelId: string
  readonly promotion: ModelPromotion
}

/**
 * 读者语言。浏览器里取 `navigator.language`；宿主侧（无 navigator）与单测**显式传入**。
 *
 * ⚠️ 返回值恒为字符串：调用方会 `.toLowerCase()`，`navigator` 存在但 `language`
 * 缺失（内嵌 webview、被替换的 navigator 对象、测试替身）都会让那里抛错 ——
 * 而这一句跑在**渲染路径**上，抛错的代价是整行装饰消失。
 */
export function promotionReaderLanguage(): string {
  if (typeof navigator === 'undefined') return ''
  return navigator.language ?? ''
}

/** 是否英文界面。判据与参考实现一致：以 'en' 开头。 */
function readerIsEnglish(language: string | undefined): boolean {
  return (language ?? '').toLowerCase().startsWith('en')
}

/**
 * 双语件按读者语言取一句，**另一句兜底**。
 *
 * ⚠️ 兜底不是可选项：国际站把英文散文写在 `textZh` 里而**根本不发** `textEn`
 * （参考实现 docs 记着这条实测），只认 `textEn` 会让英文界面整句悬停消失。
 */
function pickCopy(copy: ModelPromotionCopy | undefined, english: boolean): string | undefined {
  if (copy === undefined) return undefined
  const first = english ? copy.en : copy.zh
  return first ?? (english ? copy.zh : copy.en)
}

/**
 * 一个时刻的日历日，按**上游声明的时区**读数、按读者语言排版。
 *
 * `medium` 形态（「Jul 6, 2026」/「7月6日」）而不用 `MM/DD`：这是活动的存续期,
 * 「07/06」读起来是一个要用户解码的数字，而一句日期读起来是日期。
 *
 * 非法 locale 或非法时区**不许带走整条悬停** ⇒ 退回 ISO 日期。
 */
export function formatPromotionDay(
  ms: number,
  language: string,
  timeZone: string | undefined,
): string {
  try {
    return new Intl.DateTimeFormat(language === '' ? undefined : language, {
      year: 'numeric', month: 'short', day: 'numeric',
      ...timeZone === undefined ? {} : { timeZone },
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

/**
 * 活动的绝对有效期两端（`validFrom` – `validUntil`）。
 *
 * @returns 两端都没有 ⇒ undefined。只有一端时保留破折号表达「开区间」。
 */
export function promotionLifetimeText(
  promotion: ModelPromotion,
  language: string,
): string | undefined {
  const schedule = promotion.schedule
  if (schedule === undefined) return undefined
  const zone = schedule.timezone
  const from = schedule.validFrom === undefined
    ? undefined
    : formatPromotionDay(schedule.validFrom, language, zone)
  // ⚠️ 减 1 毫秒 = 端点不含（见模块头判据 3）。
  const to = schedule.validUntil === undefined
    ? undefined
    : formatPromotionDay(schedule.validUntil - 1, language, zone)
  if (from === undefined && to === undefined) return undefined
  if (from === undefined) return `– ${to ?? ''}`
  if (to === undefined) return `${from} –`
  return `${from} – ${to}`
}

/**
 * 每日时段（`daily`），**并带上游声明的时区**。
 *
 * 时区是这句话的一部分：「23:00–7:50」对另一个时区的读者没有意义，而上游的窗口
 * 写在**它自己的**时区里（CN 站 = Asia/Shanghai），不是读者的。
 *
 * ⚠️ `dailyUnusable` 的条目**不写时段**：上游说了有窗口而我们读不懂，替它编一个
 * 时刻就是在替上游说话（与徽标腿同一个 fail-closed 方向）。
 */
export function promotionHoursText(promotion: ModelPromotion): string | undefined {
  const schedule = promotion.schedule
  if (schedule === undefined || schedule.dailyUnusable === true) return undefined
  const daily = schedule.daily
  if (daily === undefined || daily.length === 0) return undefined
  const windows = daily.map((window) => `${window.start}–${window.end}`).join(', ')
  const zone = schedule.timezone
  return zone === undefined ? windows : `${windows} (${zone})`
}

/**
 * 一条活动的完整悬停：上游原话 · 有效期 · 每日时段。
 *
 * @returns 三件全缺 ⇒ **空串**（调用方据此不写 title 属性）。
 */
export function promotionTooltip(
  promotion: ModelPromotion,
  language: string = promotionReaderLanguage(),
): string {
  const parts: string[] = []
  const copy = pickCopy(promotion.hover, readerIsEnglish(language))
  if (copy !== undefined && copy.length > 0) parts.push(copy)
  const lifetime = promotionLifetimeText(promotion, language)
  if (lifetime !== undefined) parts.push(lifetime)
  const hours = promotionHoursText(promotion)
  if (hours !== undefined) parts.push(hours)
  return parts.join(' \u00b7 ')
}

/**
 * 徽标该说的话（短标签，按读者语言）。
 *
 * ⚠️ 与 `promotionBadgeFor` 的 `text` 同源但**不共用**：那份是给宿主契约的
 * 表形态（宿主按读者语言自己挑），这里要的是**已经挑好的一句字符串**,
 * 因为占位者组件自己就是渲染方。两者都读同一份 `badge.label` / `badge.labelEn`,
 * 判据一致：有英文档且读者读英文 ⇒ 用英文档，否则用本地区文案。
 */
export function promotionBadgeLabel(
  promotion: ModelPromotion,
  language: string = promotionReaderLanguage(),
): string {
  const badge = promotion.badge
  if (readerIsEnglish(language) && badge.labelEn !== undefined) return badge.labelEn
  return badge.label
}

/**
 * 徽标颜色：上游 hex（只接受 hex，见 `promotionBadgeColor`）,
 * 缺省 ⇒ undefined，由展示层落语义色。
 */
export function promotionChipColor(promotion: ModelPromotion): string | undefined {
  return promotionBadgeColor(promotion)
}
