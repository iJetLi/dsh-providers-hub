/**
 * 上游**活动信息**的解析与「此刻该画哪一枚徽标」（GitHub issue #101）。
 *
 * ## 它解决什么
 *
 * 服务商的模型目录**自带**活动字段（限时免费 / 夜间折扣 / 错峰折扣 / 订阅优先）。
 * 本插件此前只把**倍率**抄进模型展示名（形如 GLM-5.2 · x0.79→x0.50），而那个箭头是
 * **取目录那一刻**算出来的字符串 —— 活动一过期，名字里的折扣还在，用户按优惠期
 * 选择模型却被按原价计费。issue #101 要的正是让「活动过期而用户仍按优惠期选择」
 * 这件事可被避免。
 *
 * 本模块补的是**徽标**这条腿：把上游的活动声明读成一份**未决**（不预先挑定）的候选表，
 * 由目录在**被读取的那一刻**按当前时钟挑一枚，画成宿主官方的 LlmModelInfo.badge ——
 * DSH 0.2.2 起模型选择器自己会渲染它（宿主 ModelSelect 的 renderModelLabel 回落分支
 * 就是 Tag{tone: badge.tone} + 名字；宿主 LlmRuntime.listModels 与 buildModelCatalog
 * 都把 badge 逐字透传，实测于本机 app.asar）。
 *
 * ## 移植来源（两条腿各取一家，判据不重写）
 *
 * - dsh-connect-workbuddy（src/promo.ts + docs/PROMO_BADGE.md）：腾讯系 /v3/config 的
 *   data.modelPromotions / data.modelTiers 形状，以及六条判据 —— running 优先于 standing、
 *   dailyUnusable 不许当成全天、validUntil 端点不含、display activeOnly、
 *   同分时活动先于等级标记、无颜色即 neutral。
 * - dsh-connect-qoder（src/promo.ts）：Qoder 目录 promotion 的形状，以及两条判据 ——
 *   有窗口时窗口说了算（active 只是无窗口时的回退）、**声明了窗口但读不懂**
 *   ⇒ 整条不画，既不当全天也不退回 active。
 *
 * ## ⚠️ 四条不能改的取舍
 *
 * 1. **判定放在读取时刻，不放在解析时刻**。一次目录读取会被宿主缓存很久
 *    （本仓后台刷新器 20 分钟一轮）。在解析时把徽标定死，等于「22:59 读到的
 *    夜间折扣，第二天 08:00 还挂在行上」—— 那正是本 issue 要修的形态。
 *    ⇒ 解析保留**全部候选**（parseModelsFromConfig 把它们挂在每条模型的 promos 上），
 *    挑选一枚发生在 toCatalogEntry 里。
 * 2. **不替上游说话**。文案一律是上游自己的 badge.label / badge.zh / badge.en，
 *    插件不翻译、不改写、不从 discount_factor 反推措辞。上游没给任何可显示的文案
 *    （无 badge）⇒ **整条丢弃**：腾讯的 modelPromotions 数组里混着
 *    hy-image-3.5 / kling-video-v3 这类**非促销**条目（只有 tags / videoGeneration），
 *    「无 badge 即丢弃」正是把它们挡在界面外的那道闸。
 * 3. **徽标只是提示，不改任何行为**。本模块不改写请求体、不改价格链路：倍率后缀继续走
 *    既有 parsePromotions + formatCreditsRate 那条已实测的路（src/buddy.ts，含
 *    「x 前后缀两套写法」「factor 0 = 免费」「无窗口 0x 视为占位」等判据，一律不动）。
 *    两条腿读的是**同一份上游文档** ⇒ **零新增请求**（这就是 issue 里
 *    「信息来自你获取模型的端点，不用担心时效性」那句的依据）。
 * 4. **窗口外不画「还没到点」**。参考实现的**卡片**可以画一枚降饱和胶囊并在悬停里写
 *    「几点生效」；宿主徽标契约**只有 text + tone、没有悬停位** ⇒ 窗口外把同一句
 *    「错峰 4 折」画出来就是在说一件没发生的事。所以那一家只画「此刻成立」，
 *    窗口外什么都没有（行上的原价后缀已经把「现在按原价」讲明白）。
 *    这是与参考实现**刻意不同**的一处，不是漏接。见 ModelPromotion.standingEligible。
 *
 * ## ⚠️ 时区兜底必须与**价格腿**同判据
 *
 * 上游没写 timezone 时，本仓价格腿（src/buddy.ts 的 zonedMinutes、
 * src/qoder-adapter.ts 的 promotionActiveNow）都按 **UTC+8** 算。徽标腿若默认 UTC，
 * 同一个窗口就会差 8 小时 —— 那是「一文件两套同义判据」的复发形态。
 * ⇒ 两个入口都**必须**传入与价格腿一致的 fallbackTimeZone，不许各猜一个。
 *
 * ## 与「用量徽标」的区别
 *
 * plugin-src/client/badge-model.js 与 usage-badge.js 是**本插件自己的**用量徽标
 * （挂在 conversation.input.right），与这里的「上游活动徽标」（数据面 = 宿主目录
 * badge 字段、渲染面 = 选择器每一行）不是同一条通路，别混为一谈。
 *
 * @module src/model-promotions
 */

/** 宿主徽标的语义档（DSH 0.2.2 起 LlmModelBadgeTone 的四个取值）。 */
export type ModelPromotionTone = 'neutral' | 'info' | 'success' | 'warning'

/** 上游自己声明的徽标外观与文案。 */
export interface ModelPromotionBadge {
  /**
   * 上游的**本地区**文案（CN 站「夜间折扣」，国际站「Free now」）。
   *
   * ⚠️ 必需字段：没有它就没有可画的东西，整条活动在解析阶段被丢弃（取舍 2）。
   */
  label: string
  /** 上游的英文文案，**只在它真的下发时**才有。 */
  labelEn?: string
  /**
   * 上游给的颜色（hex，实测 #009273 / #1E90FF / #FF0000）。
   *
   * ⚠️ 必须是**可选**的：腾讯 modelTiers 与 Qoder promotion 都**不下发**颜色
   * （实测 2026-10-21），缺省落 neutral。
   */
  color?: string
  /**
   * 'activeOnly' —— 徽标属于活动的**进行期**，活动一结束就必须消失。
   *
   * 缺省 —— **常驻**徽标：描述这个模型「在该条活动存续期间」的性质，而活动自己的
   * 每日时段只管**折扣**、不管徽标。腾讯的「夜间折扣」就是成对下发的（一条带夜间
   * 时段、一条带白天时段，同一个徽标），靠的就是这条区别。
   */
  display?: 'activeOnly'
}

/** 一条每日时段，写在**上游自己声明**的时区里。 */
export interface ModelPromotionWindow {
  /** 'HH:mm'，**起点含**。实测小时可能不补零（7:50）。 */
  start: string
  /**
   * 'HH:mm'，**终点不含**。
   *
   * end ≤ start 表示**跨零点**（23:00→7:50 是实测的夜间窗口）；end === start 表示**全天**。
   */
  end: string
}

/** 活动什么时候跑。 */
export interface ModelPromotionSchedule {
  /** 上游声明的 IANA 时区（实测 Asia/Shanghai / Asia/Singapore）。 */
  timezone?: string
  /** epoch 毫秒；活动在此之前**还没开始**。 */
  validFrom?: number
  /**
   * epoch 毫秒；活动**到该时刻即结束**（**端点不含**）。
   *
   * ⚠️ 上游写的是「活动次日的零点」，自己的文案却说「– 10月31日」。拿原值当最后一天
   * 渲染会多说一天 ⇒ 展示侧要减 1 毫秒。
   */
  validUntil?: number
  /** 每日时段（可多条）。**缺席** = 这条活动只要在有效期内就全天跑。 */
  daily?: readonly ModelPromotionWindow[]
  /**
   * 上游**下发了** daily，但每一条都读不懂。
   *
   * ⚠️ 这**不等于**「没有 daily」：没有 = 24 小时活动；读不懂 = 上游说了有时段而我们
   * 不知道是几点。把后者当成「全天」会把一个夜间活动画成全天徽标 —— 那是本模块唯一
   * 会**夸大上游声明**的方向。带此标记的条目**永不**算生效。
   */
  dailyUnusable?: true
  /**
   * 上游在**取目录那一刻**给出的「常驻活动此刻开不开」快照（Qoder 的 promotion.active）。
   *
   * 只有「没给任何窗口」时才读它，见 promotionRunningAt 第 2 支。腾讯不发这种字段，故缺省。
   */
  snapshotActive?: boolean
}

/** 上游的活动说明（腾讯 hover / Qoder description，都是双语）。 */
export interface ModelPromotionCopy {
  zh?: string
  en?: string
}

/** 一条已解析的上游活动（来自 modelPromotions / modelTiers / promotion）。 */
export interface ModelPromotion {
  /** 上游条目 id（缺失时用 source:modelIds / promotion:modelId 合成）。 */
  id: string
  /** 来自上游哪张表。同分时**活动先于等级标记**，见 sortPromotions。 */
  source: 'promotion' | 'tier'
  /** 这条活动挂在哪些模型 id 上。 */
  modelIds: readonly string[]
  /** 徽标说什么、长什么样。 */
  badge: ModelPromotionBadge
  /** 上游的解释文案（宿主徽标契约没有悬停位；保留数据，见取舍 4）。 */
  hover?: ModelPromotionCopy
  /** 活动时间声明。**缺席** = 上游对时间什么都没说（腾讯 modelTiers）。 */
  schedule?: ModelPromotionSchedule
  /**
   * 上游是否**声明了**时间（每日时段或有效期）。
   *
   * ⚠️ 必须显式带着走，**不能**由 schedule !== undefined 反推：Qoder 会下发
   * { active: false } 而没有任何窗口 —— 那是「常驻活动此刻没开」；而腾讯
   * modelTiers 的「没有 schedule」是「这条陈述无条件成立」。两者若合并，
   * promotionRunningAt 的第 2 支（退回快照）永远走不到。
   */
  timeDeclared: boolean
  /**
   * 此刻不在窗口内时，能否画成**常驻**徽标。
   *
   * 腾讯 = true（白天那条「只带角标」的活动靠它让徽标全天挂着）；
   * Qoder = false（取舍 4：宿主没有悬停位，窗口外不许说「错峰 4 折」）。
   */
  standingEligible: boolean
  /** 上游 ordering 权重：数字越大越重要。缺失按 0（最低）。 */
  priority: number
}

/**
 * 宿主 LlmModelBadge.text 的形状（本地声明）。
 *
 * ⚠️ 表形态**必须显式写出 en**：宿主类型是
 * LocalizedText = string | { readonly en: string; readonly [locale: string]: string }，
 * 裸 Record<string, string> **不可赋值** —— 必需的 en 只存在于字面量类型里。
 * 把 en 写进类型不是绕编译错误，而是把「少了 en 会让胶囊整个消失」交给编译器检查。
 */
export type ModelPromotionBadgeText = string | ({ en: string } & Record<string, string>)

/**
 * 一条已定徽标：宿主契约的两个字段。
 *
 * ⚠️ **刻意不 import LlmModelBadge / LlmModelBadgeTone**：本包 peer 下界是
 * ^0.1.2-rc.1，那里的 LlmModelInfo **没有** badge 字段（0.2.2 才加）。导入一个低界
 * 不存在的类型名会让下界编译不过 —— dsh-connect-workbuddy 的 adapter.ts 正因为
 * 这件事把结构就地声明。形状稳定：{ text, tone }。
 */
export interface ModelPromotionBadgeValue {
  text: ModelPromotionBadgeText
  tone: ModelPromotionTone
}

/** 记录型值的窄化：非对象（含 null 与数组）返回 undefined。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 去空白的非空字符串。 */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 有限数（不要求非负：上游 priority 可以是负权重）。 */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 'HH:mm' → 当日分钟数；读不懂返回 undefined。
 *
 * 24:00 只作为**终点**接受（「到当天结束」），映射成 1440；作为**起点**拒绝 ——
 * 24:00 开始的「今天」是明天，那是另一句话。
 *
 * ⚠️ **第一行的类型闸门是承重的，不是装饰**（dsh-connect-workbuddy issue #139）。
 * 上游给的是字符串，看起来后面的正则已经挡住了数字 —— 但**落盘缓存**是这个函数的
 * 第二个入口，那条路上没有任何东西做类型检查：{ start: 1380 } 会一路走到这里。
 * 一旦让非字符串碰到 .trim() 就是**渲染期**抛 value.trim is not a function，
 * 而调用点在目录装配里 ⇒ 整条渠道的模型列表消失，症状与「上游挂了」逐字同形。
 */
function clockMinute(value: unknown, role: 'start' | 'end'): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
  if (minute > 59 || hour > 24) return undefined
  if (hour === 24) return role === 'end' && minute === 0 ? 24 * 60 : undefined
  return hour * 60 + minute
}

/**
 * ISO 时刻 → epoch 毫秒。**数字刻意拒绝**：秒与毫秒是两种含义
 * （本仓 accio 的 expires_at 就踩过秒/毫秒混淆），猜错方向会把活动判成
 * 「还没开始」或「三年前就结束了」。
 */
function instantMs(value: unknown): number | undefined {
  const raw = asText(value)
  if (raw === undefined) return undefined
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? undefined : ms
}

/** 上游 modelIds → 去重后的 id 列表；空列表返回 undefined（= 非活动条目）。 */
function parseModelIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  for (const entry of value) {
    const id = asText(entry)
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids.length === 0 ? undefined : ids
}

/** 上游 badge → 本模块形状；没有可显示文案 ⇒ undefined（整条丢弃）。 */
function parseBadge(value: unknown): ModelPromotionBadge | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  const label = asText(raw.label) ?? asText(raw.labelEn)
    ?? asText(raw.shortLabel) ?? asText(raw.shortLabelEn)
    ?? asText(raw.zh) ?? asText(raw.en)
  if (label === undefined) return undefined
  const labelEn = asText(raw.labelEn) ?? asText(raw.en)
  const color = asText(raw.color)
  return {
    label,
    ...labelEn === undefined ? {} : { labelEn },
    ...color === undefined ? {} : { color },
    ...(raw.display === 'activeOnly' ? { display: 'activeOnly' as const } : {}),
  }
}

/** 上游 hover（腾讯）/ description（Qoder）双语字段 → 共用形状。 */
function parseCopy(value: unknown): ModelPromotionCopy | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  const zh = asText(raw.textZh) ?? asText(raw.zh)
  const en = asText(raw.textEn) ?? asText(raw.en)
  if (zh === undefined && en === undefined) return undefined
  return { ...zh === undefined ? {} : { zh }, ...en === undefined ? {} : { en } }
}

/**
 * 上游 daily → 可求值的时段集合。
 *
 * 读不懂的时段**丢弃**而不是猜：一份错的窗口会把一个真实活动画成另一个样子。
 * 「下发了但一条都没活下来」由 parseTencentSchedule 标成 dailyUnusable。
 *
 * ⚠️ 本函数**不打日志**：日志留在解析入口（每家每次目录读取一条）。判定路径
 * 每次渲染都跑，在那里打日志会变成刷屏。
 */
function parseDailyWindows(value: unknown): ModelPromotionWindow[] | undefined {
  if (!Array.isArray(value)) return undefined
  const windows: ModelPromotionWindow[] = []
  for (const entry of value) {
    const raw = asRecord(entry)
    if (raw === undefined) continue
    const start = asText(raw.start)
    const end = asText(raw.end)
    if (start === undefined || end === undefined) continue
    if (clockMinute(start, 'start') === undefined) continue
    if (clockMinute(end, 'end') === undefined) continue
    windows.push({ start, end })
  }
  return windows.length === 0 ? undefined : windows
}

/**
 * Intl.DateTimeFormat 的两份缓存（按小时读数 / 按日历日读数）。
 *
 * ## 为什么必须有它（实测 2026-11-17，本机 Node）
 *
 * 判定路径**每次 listModels 都按模型跑一遍**，而 new Intl.DateTimeFormat 实测
 * **约 119µs/次** —— 比它要做的实际计算贵两个量级；460 条规模的渠道单趟就是
 * 50ms+。本仓有过一次同形状的事故（cline 目录 O(N²)：471 条实测 312ms ⇒ 1.5ms,
 * 见 docs/agent-notes/providers-cline.md），而 listModels 是宿主 buildModelCatalog
 * 反复调的那条路（catalog-prewarm.ts 的头注就记着「首屏加载模型巨长」）。
 * 缓存后同一时区只剩 formatToParts 本身的成本。
 *
 * ⚠️ **上限必须有**：zone 是**上游字符串**，无上限缓存等于让一个乱发的 feed
 * 把我们的内存当它的字典。超出上限就退回「现造一个不入缓存」—— 行为完全不变,
 * 只是不省时间；**绝不**因为缓存满而让判定失败（那会把性能优化变成新的失效方向）。
 */
const MAX_ZONE_FORMATTERS = 16
const minuteFormatters = new Map<string, Intl.DateTimeFormat>()
const dayFormatters = new Map<string, Intl.DateTimeFormat>()

/** 取（或造）一个 formatter；缓存满时现造一个**不入缓存**。构造失败照旧抛出。 */
function cachedFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  zone: string,
  build: () => Intl.DateTimeFormat,
): Intl.DateTimeFormat {
  const hit = cache.get(zone)
  if (hit !== undefined) return hit
  const formatter = build()
  if (cache.size < MAX_ZONE_FORMATTERS) cache.set(zone, formatter)
  return formatter
}
/**
 * 某时刻在指定时区里的当日分钟数；时区读不懂返回 undefined（= 不画）。
 *
 * ⚠️ **绝不静默退回本地时区**：那会让一个跨零点窗口在别的时区错位几小时，比不画
 * 更糟（dsh-connect-qoder/promo.ts 同判据）。zone 为 undefined 时按**调用方传入的**
 * 兜底时区算 —— 兜底值必须与价格腿一致，见模块头那条「时区兜底」警告。
 */
function zonedMinute(nowMs: number, timeZone: string | undefined): number | undefined {
  const zone = timeZone === undefined || timeZone === '' ? 'UTC' : timeZone
  try {
    // hourCycle 'h23' 是刻意的：部分引擎在 hour12 false 下把午夜报成 24，
    // 那会让 22:00–08:00 在 00:00 判定失败。
    const parts = cachedFormatter(minuteFormatters, zone, () => new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })).formatToParts(new Date(nowMs))
    const read = (type: string): number | undefined => {
      const item = parts.find((part) => part.type === type)?.value
      if (item === undefined) return undefined
      const value = Number(item)
      return Number.isFinite(value) ? value : undefined
    }
    const hour = read('hour')
    const minute = read('minute')
    if (hour === undefined || minute === undefined) return undefined
    return (hour % 24) * 60 + minute
  } catch {
    return undefined
  }
}

/** nowMinutes 是否落在时段集合里的某一段。 */
function withinDailyWindows(windows: readonly ModelPromotionWindow[], nowMinutes: number): boolean {
  return windows.some((window) => {
    const start = clockMinute(window.start, 'start')
    const end = clockMinute(window.end, 'end')
    if (start === undefined || end === undefined) return false
    // 同钟点 = 全天（起点含 + 终点不含 ⇒ 同一时刻即覆盖整日）。
    if (start === end) return true
    if (end > start) return nowMinutes >= start && nowMinutes < end
    return nowMinutes >= start || nowMinutes < end
  })
}

/**
 * 活动的**绝对有效期**在 nowMs 是否成立。
 *
 * 它单独就是一道闸：一条已经结束的活动不该继续自我宣传，无论它的每日时段怎么说。
 * 常驻徽标同样受它约束（见 promotionStandingAt）—— 这是「活动过期而徽标还在」
 * 最直接的成因，也是 issue #101 点名的形态。
 */
export function promotionWithinAbsoluteWindow(
  promotion: ModelPromotion,
  nowMs: number = Date.now(),
): boolean {
  const schedule = promotion.schedule
  if (schedule === undefined) return true
  // ⚠️ **界值存在却不是有限数 ⇒ 判「不在窗口内」**（不画），而不是让它穿过闸门。
  // 这不是假想：`nowMs < '2026-11-16T00:00:00+08:00'` 两边都是 NaN 比较 ⇒ 恒 false,
  // 于是「已经过期」会读成「没过期」—— 一个结束的活动继续自我宣传，正是
  // issue #101 点名的事故形态；而本函数的**全部**意义就是挡住它。
  // 生产路径上 parseTencentSchedule 只会写 number，所以这是给第二个入口
  // （持久化往返 / 别的调用方直接构造）准备的闸门，与 clockMinute 第一行同规。
  if (schedule.validFrom !== undefined) {
    if (typeof schedule.validFrom !== 'number' || !Number.isFinite(schedule.validFrom)) return false
    if (nowMs < schedule.validFrom) return false
  }
  if (schedule.validUntil !== undefined) {
    if (typeof schedule.validUntil !== 'number' || !Number.isFinite(schedule.validUntil)) return false
    if (nowMs >= schedule.validUntil) return false
  }
  return true
}

/** 活动的**每日时段**（含上游声明的时区）在 nowMs 是否成立。 */
export function promotionWithinDailyWindow(
  promotion: ModelPromotion,
  nowMs: number = Date.now(),
): boolean {
  const schedule = promotion.schedule
  if (schedule === undefined) return true
  // 说了有时段却读不懂 ⇒ 永不成立（不许退化成「全天」）。
  if (schedule.dailyUnusable === true) return false
  if (schedule.daily === undefined || schedule.daily.length === 0) return true
  const minutes = zonedMinute(nowMs, schedule.timezone)
  if (minutes === undefined) return false
  return withinDailyWindows(schedule.daily, minutes)
}

/** 绝对有效期 ∧ 每日时段。**不**含「上游是否声明了时间」这道闸。 */
export function promotionActiveAt(
  promotion: ModelPromotion,
  nowMs: number = Date.now(),
): boolean {
  return promotionWithinAbsoluteWindow(promotion, nowMs)
    && promotionWithinDailyWindow(promotion, nowMs)
}

/**
 * 这条活动在 nowMs **正在跑**吗（可画实心徽标）。三条分支缺一不可：
 *
 * 1. 上游**声明了**时间（窗口或有效期）⇒ 按 nowMs 现算，**不看** snapshotActive。
 *    目录是缓存的快照，active 会过期；而窗口是「此刻」的纯函数，快照多旧都不会说错话。
 *    若把 active 也当成门，白天启动的进程会拿着 16:00 的 active false 一直到退出 ——
 *    22:00 窗口开了也不画，这个功能对「一直开着 DSH」的用户等于不存在。
 * 2. 上游没声明时间、只给了 active 快照（Qoder 的 { active: true } 无窗口形态）
 *    ⇒ 只能信快照：那是上游对「常驻活动此刻开不开」的唯一表态。
 * 3. 上游既没声明时间也没有快照（腾讯 modelTiers）⇒ **不算在跑**，它只可能「常驻」。
 *    否则一个高优先级的等级标记会压掉一个真的在跑的低价活动
 *    （参考实现里的 hasSchedule 就是为此存在）。
 */
export function promotionRunningAt(
  promotion: ModelPromotion,
  nowMs: number = Date.now(),
): boolean {
  if (promotion.timeDeclared) return promotionActiveAt(promotion, nowMs)
  return promotion.schedule?.snapshotActive === true
}

/**
 * 此刻不在窗口内时，这条活动能否画成**常驻**徽标。
 *
 * - badge.display 是 activeOnly ⇒ 不可以：那是「只在活动期内出现」的徽标；
 * - standingEligible false ⇒ 不可以：取舍 4（Qoder 没有悬停位可说「还没到点」）；
 * - dailyUnusable ⇒ 不可以：读不懂的时段不能替上游背书；
 * - 其余 ⇒ 只受**绝对有效期**约束：一条过期活动的常驻徽标同样不许挂。
 */
export function promotionStandingAt(
  promotion: ModelPromotion,
  nowMs: number = Date.now(),
): boolean {
  if (promotion.badge.display === 'activeOnly') return false
  if (!promotion.standingEligible) return false
  if (promotion.schedule?.dailyUnusable === true) return false
  return promotionWithinAbsoluteWindow(promotion, nowMs)
}

/**
 * priority 降序；同分时**活动先于等级标记**。
 *
 * 上游把两者都标成 200（实测 2026-10-21），而一句「Free now / 限时免费」比一句
 * 「Pro Only / 订阅优先」对用户更有行动价值。同分不能靠数组顺序碰运气 ——
 * 比较器显式覆盖它，调用方因此不必依赖 Array#sort 的稳定性。
 */
export function sortPromotions(promotions: readonly ModelPromotion[]): ModelPromotion[] {
  return [...promotions].sort((a, b) => b.priority - a.priority
    || (a.source === b.source ? 0 : a.source === 'promotion' ? -1 : 1))
}

/**
 * 此刻该画的那一条活动，或 undefined（不画）。
 *
 * 两步顺序就是全部要点：
 * 1. **正在跑的**赢（promotionRunningAt）；
 * 2. 否则取**常驻**徽标（promotionStandingAt）。
 *
 * 每个模型**只画一枚**：选择器一行只有一条宽度，两枚会把模型名挤出去。
 *
 * ⚠️ 调用方**不得**在解析时刻调它并把结果存进缓存 —— 那等于把「此刻」冻进目录，
 * 正是本模块存在的理由要修的事（取舍 1）。
 */
export function selectPromotionAt(
  promotions: readonly ModelPromotion[] | undefined,
  nowMs: number = Date.now(),
): ModelPromotion | undefined {
  if (promotions === undefined || promotions.length === 0) return undefined
  const sorted = sortPromotions(promotions)
  const running = sorted.find((promotion) => promotionRunningAt(promotion, nowMs))
  if (running !== undefined) return running
  return sorted.find((promotion) => promotionStandingAt(promotion, nowMs))
}

/**
 * 只接受 hex（#RGB / #RRGGBB）。
 *
 * ⚠️ 值最终会进样式，而上游只发 hex。其它写法一律拒绝，由展示侧回落语义色。
 * **不要**在这里放行 rgb() 或 CSS 变量 —— 那不是上游会发的东西，放行等于把
 * 未校验字符串送进样式属性。
 */
export function promotionBadgeColor(promotion: ModelPromotion): string | undefined {
  const color = promotion.badge.color
  if (color === undefined) return undefined
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(color) ? color : undefined
}

/**
 * 上游 hex 颜色 → 宿主语义档。
 *
 * ## 为什么映射而不是原样送颜色
 *
 * 宿主的 badge 只认 tone（四档），由主题 token 上色，从而在每个主题下都保证可读；
 * 任意 hex 做不到这件事。所以就近映射：绿色（CN 每个「免费/折扣」活动用的都是它）
 * → success；蓝 → info；暖色（琥珀/红）→ warning；**其余 neutral，不替上游发明含义**。
 *
 * 上游没给颜色（Qoder promotion、腾讯 modelTiers）同样落 neutral —— 实测如此，不是兜底。
 */
export function promotionTone(promotion: ModelPromotion): ModelPromotionTone {
  const color = promotionBadgeColor(promotion)
  if (color === undefined) return 'neutral'
  const hex = color.slice(1)
  if (hex.length !== 6) return 'neutral'
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return 'neutral'
  // 绿色明显最强时是「免费/折扣」绿，不能被读成警告。
  if (g > r + 24 && g > b + 24) return 'success'
  // 蓝色是「成员专属 / 等级」类标记，不是价格事件。
  if (b > r + 24 && b > g + 8) return 'info'
  // 暖色（琥珀/红）意思是「选之前先看看这句」。
  if (r > b + 24) return 'warning'
  return 'neutral'
}

/**
 * 候选表 → 宿主 badge 值（此刻该画的那一枚），不成立时 undefined。
 *
 * ## 为什么出「表」形态
 *
 * 宿主按**读者**的语言解析 badge.text，而本函数跑在宿主进程里，看不到浏览器语言。
 * 给一张表让宿主自己挑；给一个裸字符串就是把一种语言强加给所有用户。
 *
 * ## 什么时候塌成裸字符串
 *
 * CN 大多数活动**只发中文**，于是 en 就是那句中文，两端相同 ⇒ 塌成字符串。
 * 这是刻意的：**编造英文文案比给英文读者看上游自己的中文更糟**（取舍 2）。
 */
export function promotionBadgeFor(
  promotions: readonly ModelPromotion[] | undefined,
  nowMs: number = Date.now(),
): ModelPromotionBadgeValue | undefined {
  const selected = selectPromotionAt(promotions, nowMs)
  if (selected === undefined) return undefined
  const en = selected.badge.labelEn ?? selected.badge.label
  return {
    text: selected.badge.label === en ? en : { en, zh: selected.badge.label },
    tone: promotionTone(selected),
  }
}

/** 日志**不该**让解析失败：宿主 logger 可能没绑定或自己抛。 */
function safeWarn(warn: ((message: string) => void) | undefined, message: string): void {
  if (warn === undefined) return
  try {
    warn(message)
  } catch { /* 丢弃 */ }
}

/** 上游是否在这条 schedule 里**说了**它有时间。 */
function tencentScheduleDeclaredTime(schedule: ModelPromotionSchedule | undefined): boolean {
  if (schedule === undefined) return false
  return schedule.dailyUnusable === true
    || (schedule.daily !== undefined && schedule.daily.length > 0)
    || schedule.validFrom !== undefined
    || schedule.validUntil !== undefined
}

/**
 * 腾讯 schedule → 本模块形状。
 *
 * @returns undefined = 上游这一项里**什么时间声明都没有**（不等于解析失败：
 * 那种情形由 dailyUnusable 表达）。
 */
function parseTencentSchedule(
  value: unknown,
  id: string,
  warn?: (message: string) => void,
): ModelPromotionSchedule | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  const timezone = asText(raw.timezone)
  const validFrom = instantMs(raw.validFrom)
  const validUntil = instantMs(raw.validUntil)
  const daily = parseDailyWindows(raw.daily)
  // 下发了 daily（数组且非空）却一条都没活下来 ⇒ **解析失败**，不是「没有时段」。
  const dailyUnusable = daily === undefined
    && Array.isArray(raw.daily)
    && (raw.daily as unknown[]).length > 0
  if (dailyUnusable) {
    // 日志留在**宿主侧、解析路径**上：每次上游文档只跑一遍，而判定路径每次渲染都跑。
    // 缺了这条，徽标只是消失、全仓零日志（dsh-connect-workbuddy issue #139 的症状）。
    safeWarn(warn, 'promotion "' + id + '": dropped every daily window, badge stays hidden '
      + '(the upstream may have changed the time format)')
  }
  if (timezone === undefined && validFrom === undefined && validUntil === undefined
    && daily === undefined && !dailyUnusable) return undefined
  return {
    ...timezone === undefined ? {} : { timezone },
    ...validFrom === undefined ? {} : { validFrom },
    ...validUntil === undefined ? {} : { validUntil },
    ...daily === undefined ? {} : { daily },
    ...dailyUnusable ? { dailyUnusable: true as const } : {},
  }
}

/**
 * 腾讯系 /v3/config：data.modelPromotions + data.modelTiers → 候选表。
 *
 * 真实形态（docs/PROMO_BADGE.md 留档；2026-10-21 实测 CN 站 8 条促销 + 1 条等级标记），
 * 一条促销条目原文（截断）：
 *
 *     { "id": "hy3-free-trial-202608", "kind": "discount", "enabled": true,
 *       "priority": 200, "modelIds": ["hy3"],
 *       "badge": { "label": "限时免费", "color": "#009273", "display": "activeOnly" },
 *       "discount": { "discountedCredits": "0x", "displayMode": "replace", "factor": 0 },
 *       "hover": { "textZh": "7月6日–10月31日，每日赠送免费额度。" },
 *       "schedule": { "timezone": "Asia/Shanghai",
 *                     "validFrom": "2026-07-06T00:00:00+08:00",
 *                     "validUntil": "2026-11-01T00:00:00+08:00",
 *                     "daily": [{ "start": "23:00", "end": "7:50" }] } }
 *
 * modelTiers 同形但**没有** schedule / badge.color，多一个 requiredUserType。
 *
 * 三条丢弃判据（都在解析层做完，下游可假定每条都画得出来）：
 * - enabled === false（**缺省即启用**：上游只在关掉时才写这个字段）；
 * - 无 modelIds —— 数组里混着图片/视频模型的**非促销**条目；
 * - 无 badge 文案 —— 没有可显示的话，插件不该自己编。
 *
 * ⚠️ **折扣价不在这里算**（取舍 3）：腾讯的促销价继续走 src/buddy.ts 的 parsePromotions。
 * 同一份文档读两套判据，**请求仍只有一次**。
 *
 * ⚠️ fallbackTimeZone 必须与价格腿一致（见模块头）：腾讯价格腿用 Asia/Shanghai。
 *
 * @param rawPromotions - 上游 data.modelPromotions。
 * @param rawTiers - 上游 data.modelTiers。
 * @param fallbackTimeZone - 上游未写 timezone 时用的时区（与价格腿同值）。
 * @param warn - 可选日志出口（时段读不懂时点名到条目）。
 */
export function parseTencentPromotions(
  rawPromotions: unknown,
  rawTiers: unknown,
  fallbackTimeZone: string = 'Asia/Shanghai',
  warn?: (message: string) => void,
): ModelPromotion[] {
  const promotions: ModelPromotion[] = []
  for (const entry of Array.isArray(rawPromotions) ? rawPromotions : []) {
    const promotion = parseTencentEntry(entry, 'promotion', fallbackTimeZone, warn)
    if (promotion !== undefined) promotions.push(promotion)
  }
  for (const entry of Array.isArray(rawTiers) ? rawTiers : []) {
    const promotion = parseTencentEntry(entry, 'tier', fallbackTimeZone, warn)
    if (promotion !== undefined) promotions.push(promotion)
  }
  return promotions
}

/** 上游一条 modelPromotions / modelTiers 条目 → 候选；不是活动则 undefined。 */
function parseTencentEntry(
  value: unknown,
  source: 'promotion' | 'tier',
  fallbackTimeZone: string,
  warn?: (message: string) => void,
): ModelPromotion | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  if (raw.enabled === false) return undefined
  const modelIds = parseModelIds(raw.modelIds)
  if (modelIds === undefined) return undefined
  const badge = parseBadge(raw.badge)
  if (badge === undefined) return undefined
  // id 先算出来，好让「读不懂的时段」能在日志里点名到条目
  // （parseTencentSchedule 自己读不到 id，它在上一层）。
  const id = asText(raw.id) ?? source + ':' + modelIds.join(',')
  const schedule = parseTencentSchedule(raw.schedule, id, warn)
  if (schedule !== undefined && schedule.timezone === undefined) {
    schedule.timezone = fallbackTimeZone
  }
  const hover = parseCopy(raw.hover)
  const priority = asFiniteNumber(raw.priority)
  return {
    id,
    source,
    modelIds,
    badge,
    ...hover === undefined ? {} : { hover },
    ...schedule === undefined ? {} : { schedule },
    timeDeclared: tencentScheduleDeclaredTime(schedule),
    standingEligible: true,
    priority: priority ?? 0,
  }
}

/**
 * 本仓 Qoder 目录条目的 promotion（错峰折扣）→ **一条**候选（只挂它自己那一行）。
 *
 * ⚠️ 输入是 src/qoder-product.ts 的**已解析**形状（camelCase），不是上游的 snake_case：
 * 本仓 qoder-catalog.ts 已把远端条目归一成与编译期兜底表同形的结构，远端与兜底表
 * 因此**走完全同一条展示链路**。若在这里再写一份 snake_case 解析，就是同一个 schema
 * 的两套判据 —— 本仓的反复出缺陷形态。
 *
 * 三个必须处理的形态，与参考实现 dsh-connect-qoder/promo.ts 逐条同口径：
 * 1. **窗口读得懂** ⇒ timeDeclared true + daily，窗口说了算（active 完全不参与）；
 * 2. **窗口声明了但读不懂**（24:30、只给一端、非 HH:mm）⇒ dailyUnusable ⇒ 既不当全天
 *    也不退回 active（running 与 standing 两道闸都拒）；
 * 3. **完全没给窗口** ⇒ timeDeclared false + snapshotActive，由 promotionRunningAt
 *    第 2 支读快照。
 *
 * ⚠️ badge.zh 与 badge.en 都没有 ⇒ 返回 undefined：没有可显示的话就不该画（取舍 2）。
 * 此时**折扣价照旧**由 qoderDisplayName 的箭头承载，两条腿互不依赖。
 *
 * ⚠️ fallbackTimeZone 必须与价格腿一致：qoder-adapter.ts 的 promotionActiveNow 按
 * UTC+8 硬算（目录时区与用户一致），故这里传 Asia/Shanghai。
 */
export function qoderPromotionCandidate(
  promotion: {
    readonly active: boolean
    readonly windowStart?: string | undefined
    readonly windowEnd?: string | undefined
    readonly badgeZh?: string | undefined
    readonly badgeEn?: string | undefined
    readonly timezone?: string | undefined
    readonly ruleId?: string | undefined
  } | undefined,
  modelId: string,
  fallbackTimeZone: string = 'Asia/Shanghai',
  warn?: (message: string) => void,
): ModelPromotion | undefined {
  if (promotion === undefined) return undefined
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined
  const label = promotion.badgeZh ?? promotion.badgeEn
  if (label === undefined) return undefined
  const labelEn = promotion.badgeEn
  const windowStart = promotion.windowStart
  const windowEnd = promotion.windowEnd
  // 「声明」与「读得懂」是两件事，必须分开算（见 dailyUnusable 的说明）。
  const declaredWindow = windowStart !== undefined || windowEnd !== undefined
  const usableWindow = windowStart !== undefined && windowEnd !== undefined
    && clockMinute(windowStart, 'start') !== undefined
    && clockMinute(windowEnd, 'end') !== undefined
  if (declaredWindow && !usableWindow) {
    safeWarn(warn, 'qoder promotion on "' + modelId + '": window is unreadable (start: '
      + (windowStart ?? 'absent') + ', end: ' + (windowEnd ?? 'absent')
      + '), badge stays hidden')
  }
  const schedule: ModelPromotionSchedule = {
    timezone: promotion.timezone ?? fallbackTimeZone,
    ...usableWindow ? { daily: [{ start: windowStart as string, end: windowEnd as string }] } : {},
    ...(declaredWindow && !usableWindow ? { dailyUnusable: true as const } : {}),
    ...promotion.active === true ? { snapshotActive: true as const } : {},
  }
  return {
    id: promotion.ruleId ?? 'promotion:' + modelId,
    source: 'promotion',
    modelIds: [modelId],
    badge: { label, ...labelEn === undefined ? {} : { labelEn } },
    timeDeclared: declaredWindow,
    // 取舍 4：宿主徽标没有悬停位，窗口外不画「还没到点」。
    standingEligible: false,
    priority: 100,
    schedule,
  }
}

// ── 保鲜：下一个会改变徽标的时刻 ────────────────────────────────────────────────

/** 边界查找的默认上界（一年）：超出即认为「没有排定的边界」，不排定时器。 */
const PROMOTION_EDGE_HORIZON_MS = 365 * 24 * 3_600_000

/**
 * 候选表里**下一个**会改变徽标的时刻（epoch 毫秒）；找不到返回 undefined。
 *
 * ## 为什么需要它
 *
 * 徽标是「此刻」的函数，而宿主缓存的是**一次目录读取**的结果（本仓后台刷新器
 * 20 分钟一轮）。于是 23:00 开的窗口要靠用户恰好在那一分钟打开菜单才会出现，
 * 而 7:50 关的窗口会在那之后最长 20 分钟里继续挂着 —— 后者正是 issue #101
 * 点名的「活动过期而用户仍按优惠期选择」。
 *
 * ⇒ 边界到了必须**主动播报**一次目录变更，让客户端重读。本函数是它的排程依据。
 *
 * ⚠️ **播报不等于重打上游**：重读走 loadCatalog，而 ensureRemoteModels 的
 * 20 分钟新鲜度判据会短路 ⇒ 边界时刻只是**用新时钟重算一遍候选表**，
 * 零网络请求。这条是「徽标自己会消失」能常驻开启的前提。
 *
 * 会改变徽标的时刻有四类：validFrom、validUntil，以及每条 daily 的两端
 * （后者按**每日重复**取「下一次」）。
 *
 * ⚠️ 全部按上游声明的时区算，而不是本地时区：23:00 说的是 Asia/Shanghai 的
 * 23:00，用户人在 UTC+0 时也一样。
 *
 * @param promotions - 全部候选（**不要**先筛过：读不懂的条目本来就没有边界）。
 * @param nowMs - 起算时刻。
 * @returns 严格大于 nowMs 的最近边界；一年内没有则 undefined。
 */
export function nextPromotionEdgeMs(
  promotions: readonly ModelPromotion[],
  nowMs: number = Date.now(),
): number | undefined {
  let best: number | undefined
  const consider = (candidate: number | undefined): void => {
    if (candidate === undefined || candidate <= nowMs) return
    if (candidate - nowMs > PROMOTION_EDGE_HORIZON_MS) return
    if (best === undefined || candidate < best) best = candidate
  }
  for (const promotion of promotions) {
    const schedule = promotion.schedule
    if (schedule === undefined) continue
    consider(schedule.validFrom)
    consider(schedule.validUntil)
    if (schedule.daily === undefined) continue
    for (const window of schedule.daily) {
      consider(nextClockInstantMs(window.start, schedule.timezone, nowMs))
      consider(nextClockInstantMs(window.end, schedule.timezone, nowMs))
    }
  }
  return best
}

/**
 * HH:mm 在指定时区的**下一次**出现时刻。
 *
 * 实现把「下一次」拆成「今天 / 明天 / 后天 / 大后天」四个候选日历日（按**该时区**
 * 的日历日取），逐个求出该时区墙上钟点 hh:mm 对应的 epoch 时刻，
 * 取第一个严格大于 nowMs 的。四天足够覆盖夏令时切换的极端；
 * 读不懂（时间或时区）返回 undefined —— 与判定路径同一个方向：
 * **不知道就不排**，绝不排一个猜出来的时刻。
 */
function nextClockInstantMs(
  hhmm: string,
  timeZone: string | undefined,
  nowMs: number,
): number | undefined {
  const minute = clockMinute(hhmm, 'end')
  if (minute === undefined) return undefined
  for (let dayShift = 0; dayShift <= 3; dayShift += 1) {
    const reference = nowMs + dayShift * 24 * 3_600_000
    const day = zoneCalendarDay(reference, timeZone ?? 'UTC')
    if (day === undefined) return undefined
    // 24:00 = 「当天结束」= 次日 00:00：把日历日往前挪一天再落 0 分。
    const target = minute === 1440
      ? { day: { year: day.year, month: day.month, day: day.day }, minute: 0, nextDay: true }
      : { day, minute, nextDay: false }
    const instant = zonedLocalInstantMs(
      target.day.year,
      target.day.month,
      target.day.day,
      target.nextDay ? 0 : target.minute,
      timeZone ?? 'UTC',
      target.nextDay,
    )
    if (instant !== undefined && instant > nowMs) return instant
  }
  return undefined
}

/** 该时区把 ms 读成哪个日历日（读不懂返回 undefined）。 */
function zoneCalendarDay(
  ms: number,
  timeZone: string,
): { year: number, month: number, day: number } | undefined {
  try {
    const parts = cachedFormatter(dayFormatters, timeZone, () => new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })).formatToParts(new Date(ms))
    const read = (type: string): number | undefined => {
      const value = parts.find((part) => part.type === type)?.value
      if (value === undefined) return undefined
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    const year = read('year')
    const month = read('month')
    const day = read('day')
    if (year === undefined || month === undefined || day === undefined) return undefined
    return { year, month, day }
  } catch {
    return undefined
  }
}

/**
 * 求「timeZone 的日历日 year-month-day（nextDay 时为**次日**）的墙上第 minuteOfDay
 * 分钟」对应的 epoch 时刻；求不出 ⇒ undefined（**不排**，与判定路径同方向）。
 *
 * 做法：先按「当地墙上时间 == UTC 字面量」造一个候选，再用该时区在候选处的墙上
 * 读数把它往目标拉回，迭代三次收敛。最后**校验**候选确实被该时区读成目标日 +
 * 目标分钟 —— 不成立就返回 undefined。这一步不是防御性装饰：夏令时「春天跳过、
 * 秋天重复」的那一类本地时刻**根本不存在/不唯一**（部分时区恰好在午夜切换，
 * 24:00 与 0:00 会撞在同一天），收敛不到目标读数时宁可**没有边界**，也绝不
 * 排一个说错话的时刻。
 */
function zonedLocalInstantMs(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string,
  nextDay: boolean,
): number | undefined {
  // nextDay：先做**日历**加一天（UTC 空间的纯日历运算，与时区无关），
  // 再按那个新日历日求墙上时刻。
  let targetYear = year
  let targetMonth = month
  let targetDay = day
  if (nextDay) {
    const shifted = new Date(Date.UTC(year, month - 1, day) + 24 * 3_600_000)
    targetYear = shifted.getUTCFullYear()
    targetMonth = shifted.getUTCMonth() + 1
    targetDay = shifted.getUTCDate()
  }
  const targetDayStartUtc = Date.UTC(targetYear, targetMonth - 1, targetDay)
  let candidate = targetDayStartUtc + minuteOfDay * 60_000
  for (let i = 0; i < 3; i += 1) {
    const actualMinute = zonedMinute(candidate, timeZone)
    const actualDay = zoneCalendarDay(candidate, timeZone)
    if (actualMinute === undefined || actualDay === undefined) return undefined
    const readDayStartUtc = Date.UTC(actualDay.year, actualDay.month - 1, actualDay.day)
    // 「墙上读数 − 目标」换算成需要回拉的分钟数（含跨日的整数天差）。
    const dayDiffMinutes = (targetDayStartUtc - readDayStartUtc) / 60_000
    const delta = minuteOfDay - actualMinute + dayDiffMinutes
    if (delta === 0) break
    candidate += delta * 60_000
  }
  const finalMinute = zonedMinute(candidate, timeZone)
  const finalDay = zoneCalendarDay(candidate, timeZone)
  if (finalMinute === undefined || finalDay === undefined) return undefined
  const dayMatches = finalDay.year === targetYear
    && finalDay.month === targetMonth
    && finalDay.day === targetDay
  return dayMatches && finalMinute === minuteOfDay ? candidate : undefined
}

