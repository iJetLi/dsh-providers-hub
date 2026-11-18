/**
 * `src/model-promotions.ts` 的判据守卫（GitHub issue #101 的徽标腿）。
 *
 * ## 这批用例问的唯一问题
 *
 * 「上游说了什么就画什么；上游没说的一律不画，也绝不编」。
 * 每一条都对应参考实现（`dsh-connect-workbuddy` / `dsh-connect-qoder`）里一条
 * **踩过坑的**判据，或本机真实上游报文（见下）。
 *
 * ## ⚠️ 时钟一律显式传入
 *
 * 徽标是「此刻」的函数。任何用例都不许依赖 `Date.now()`，否则用例会随墙上时间
 * 漂移（本仓 `#263` 的到期断言就为时区敏感起过一次红）。
 *
 * ## 真实上游报文（只读探测 2026-11-17，`www.workbuddy.ai` 的 `/v3/config`）
 *
 *     data.modelPromotions = [{ id: "hy4-flash-free-trial-202611", enabled: true,
 *         priority: 200, modelIds: ["hy4flash-free"],
 *         badge: { label: "Free now", color: "#FF0000", display: "activeOnly" },
 *         schedule: { timezone: "Asia/Shanghai",
 *                     validFrom: "2026-11-16T00:00:00+08:00",
 *                     validUntil: "2026-12-01T00:00:00+08:00" } }]
 *     data.modelTiers = [{ id: "gpt-pro-only", priority: 200,
 *         badge: { label: "Pro Only", color: "#009273" },
 *         modelIds: ["gpt-6-astra", …] }]          // ⚠️ 没有 schedule
 *
 * 同一次探测里换成**纯 CLI 身份**（`CLI/2.63.2 CodeBuddy/2.63.2`）要同一个 URL：
 * `data` 只剩 5 个键、**两个数组都不在里面**。那是上游的下发行为、不是本模块的
 * 判据，故这里不测它（测了也只能测桩）。上面那份报文在下面被当作「真实形状」逐字段用。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  nextPromotionEdgeMs,
  parseTencentPromotions,
  promotionActiveAt,
  promotionBadgeColor,
  promotionBadgeFor,
  promotionRunningAt,
  promotionStandingAt,
  promotionTone,
  promotionWithinDailyWindow,
  qoderPromotionCandidate,
  selectPromotionAt,
  sortPromotions,
  traePromotionCandidate,
  type ModelPromotion,
} from '../../src/model-promotions.js'
import { promotionActiveNow } from '../../src/qoder-adapter.js'
import { promotionTooltip } from '../../src/promotion-tooltip.js'
import { parsePromotions } from '../../src/buddy.js'

/** epoch 构造器：全部按 UTC 字面量写死，用例与本机时区无关。 */
function at(iso: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error('bad fixture instant: ' + iso)
  return ms
}

/** 2026-11-17 08:00 Asia/Shanghai（= 00:00 UTC），白天、夜间窗口之外。 */
const DAY_SH = at('2026-11-17T00:00:00Z')
/** 2026-11-17 23:30 Asia/Shanghai（= 15:30 UTC），夜间窗口之内。 */
const NIGHT_SH = at('2026-11-17T15:30:00Z')

describe('parseTencentPromotions：真实上游形状', () => {
  const promotions = [{
    id: 'hy4-flash-free-trial-202611',
    kind: 'discount',
    enabled: true,
    priority: 200,
    modelIds: ['hy4flash-free'],
    badge: { label: 'Free now', color: '#FF0000', display: 'activeOnly' },
    discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
    hover: { textZh: 'Nov 16 – Dec 1: free daily usage.' },
    schedule: {
      timezone: 'Asia/Shanghai',
      validFrom: '2026-11-16T00:00:00+08:00',
      validUntil: '2026-12-01T00:00:00+08:00',
    },
  }]
  const tiers = [{
    id: 'gpt-pro-only',
    priority: 200,
    badge: { label: 'Pro Only', color: '#009273' },
    modelIds: ['gpt-6-astra', 'gpt-5.6-sol'],
    requiredUserType: 'standard',
    tier: 'standard',
  }]

  it('两条数组都读出来，字段逐一对齐上游原值', () => {
    const parsed = parseTencentPromotions(promotions, tiers)
    expect(parsed).toHaveLength(2)
    const free = parsed[0]!
    expect(free.id).toBe('hy4-flash-free-trial-202611')
    expect(free.source).toBe('promotion')
    expect(free.modelIds).toEqual(['hy4flash-free'])
    expect(free.badge.label).toBe('Free now')
    expect(free.badge.color).toBe('#FF0000')
    expect(free.badge.display).toBe('activeOnly')
    expect(free.priority).toBe(200)
    expect(free.schedule?.timezone).toBe('Asia/Shanghai')
    expect(free.schedule?.validFrom).toBe(at('2026-11-15T16:00:00Z'))
    expect(free.schedule?.validUntil).toBe(at('2026-11-30T16:00:00Z'))
    expect(free.hover).toEqual({ zh: 'Nov 16 – Dec 1: free daily usage.' })
    // ⚠️ 折扣价**不在这里算**（取舍 3）：价格腿继续走 src/buddy.ts 的 parsePromotions。
    expect(free).not.toHaveProperty('discount')
    const tier = parsed[1]!
    expect(tier.source).toBe('tier')
    expect(tier.modelIds).toEqual(['gpt-6-astra', 'gpt-5.6-sol'])
    // ⚠️ tier 没有 schedule ⇒ 它**不算在跑**，只可能常驻（见 selectPromotionAt 那一组）。
    expect(tier.schedule).toBeUndefined()
  })

  it('★ 活动期内该画、活动结束（validUntil 端点**不含**）就不该画', () => {
    const parsed = parseTencentPromotions(promotions, [])
    const inside = at('2026-11-20T04:00:00Z')
    expect(selectPromotionAt(parsed, inside)?.id).toBe('hy4-flash-free-trial-202611')
    // 结束的那一刻：端点不含 ⇒ 已经过期。这正是 issue #101 点名的形态。
    const ended = at('2026-11-30T16:00:00Z')
    expect(selectPromotionAt(parsed, ended)).toBeUndefined()
    expect(selectPromotionAt(parsed, ended - 1)).toBeDefined()
  })

  it('⚠️ display:activeOnly 的活动一旦过期，徽标必须跟着消失', () => {
    const parsed = parseTencentPromotions(promotions, [])
    // 常驻判据不该给 activeOnly 条目放行 —— 上游说的是「只在活动期内出现」。
    expect(promotionStandingAt(parsed[0]!, at('2026-12-05T04:00:00Z'))).toBe(false)
    // 对照：同一个 schedule、去掉 activeOnly ⇒ 常驻判据只受有效期约束。
    const standing = parseTencentPromotions(
      promotions.map((item) => ({ ...item, badge: { label: 'Free now', color: '#FF0000' } })),
      [],
    )
    expect(promotionStandingAt(standing[0]!, at('2026-11-20T04:00:00Z'))).toBe(true)
    expect(promotionStandingAt(standing[0]!, at('2026-12-05T04:00:00Z'))).toBe(false)
  })
})

describe('parseTencentPromotions：丢弃与退化形态', () => {
  it('★ 非促销条目（无 badge / 无 modelIds）被丢弃，不会画到界面上', () => {
    // 实测 modelPromotions 里混着 hy-image-3.5 / kling-video-v3 这类条目：
    // 只有 tags / videoGeneration，既没有 badge 也没有 modelIds。
    const parsed = parseTencentPromotions([
      { id: 'hy-image-3.5', tags: ['image'], modelIds: ['hy-image-3.5'] },
      { id: 'no-models', badge: { label: 'x' } },
      { id: 'empty-models', badge: { label: 'x' }, modelIds: [] },
      { id: 'blank-label', badge: { label: '   ' }, modelIds: ['m'] },
    ], [])
    expect(parsed).toEqual([])
    // 反向对照：同形状但 badge 齐备 ⇒ 必须活下来（否则上面是「恒绿的丢弃」）。
    expect(parseTencentPromotions([{ badge: { label: 'Free' }, modelIds: ['m'] }], [])).toHaveLength(1)
  })

  it('enabled:false 丢弃；**缺省即启用**（上游只在关掉时才写该字段）', () => {
    const entry = { badge: { label: 'A' }, modelIds: ['m'] }
    expect(parseTencentPromotions([{ ...entry, enabled: false }], [])).toEqual([])
    expect(parseTencentPromotions([entry], [])).toHaveLength(1)
    expect(parseTencentPromotions([{ ...entry, enabled: true }], [])).toHaveLength(1)
  })

  it('modelIds 去重、空串与数字项被剔除', () => {
    const parsed = parseTencentPromotions(
      [{ badge: { label: 'A' }, modelIds: ['a', 'a', '', 42, 'b'] }], [],
    )
    expect(parsed[0]!.modelIds).toEqual(['a', 'b'])
  })

  it('无 id 时按 source:modelIds 合成（日志与对账要能点名）', () => {
    const parsed = parseTencentPromotions(
      [{ badge: { label: 'A' }, modelIds: ['m1', 'm2'] }],
      [{ badge: { label: 'B' }, modelIds: ['m3'] }],
    )
    expect(parsed.map((p) => p.id)).toEqual(['promotion:m1,m2', 'tier:m3'])
  })

  it('priority 缺失或非数字按 0；负数照实保留', () => {
    const parsed = parseTencentPromotions([
      { badge: { label: 'A' }, modelIds: ['a'] },
      { badge: { label: 'B' }, modelIds: ['b'], priority: '200' },
      { badge: { label: 'C' }, modelIds: ['c'], priority: -5 },
    ], [])
    expect(parsed.map((p) => p.priority)).toEqual([0, 0, -5])
  })
})

describe('每日时段：窗口语义与退化', () => {
  const withDaily = (daily: unknown, timezone: unknown = 'Asia/Shanghai') => parseTencentPromotions(
    [{ id: 'p', badge: { label: '夜间折扣' }, modelIds: ['m'], schedule: { daily, timezone } }],
    [],
  )

  it('★ 跨零点窗口（23:00–7:50）：夜里「在跑」，白天只剩「常驻」', () => {
    const parsed = withDaily([{ start: '23:00', end: '7:50' }])
    expect(promotionActiveAt(parsed[0]!, NIGHT_SH)).toBe(true)
    expect(promotionActiveAt(parsed[0]!, DAY_SH)).toBe(false)
    expect(promotionRunningAt(parsed[0]!, NIGHT_SH)).toBe(true)
    expect(promotionRunningAt(parsed[0]!, DAY_SH)).toBe(false)
    expect(selectPromotionAt(parsed, NIGHT_SH)).toBeDefined()
    // ⚠️ 白天**仍然画**这一枚 —— 这是照搬参考实现的语义，不是漏判：
    // 上游用「每日时段」管辖**折扣**，用 badge.display 管辖**徽标存续**。
    // 本条没有 activeOnly ⇒ 它是常驻徽标（实测 CN 站的 glm-5.2 就是这么表达的：
    // 夜里那条带折扣、白天另发一条只带同一个角标，两条互补）。
    // 价格腿在白天不会给出折扣价（parsePromotions 按窗口判），所以
    // 「徽标挂着 + 原价」与上游自己的 UI 一致。真正会在窗口关闭后消失的是
    // activeOnly 那一类，见上面「display:activeOnly 过期后必须消失」那条。
    expect(selectPromotionAt(parsed, DAY_SH)).toBeDefined()
    expect(promotionStandingAt(parsed[0]!, DAY_SH)).toBe(true)
  })

  it('起点含、终点不含；7:50 那一刻已经不算（小时**不补零**的写法要能吃下）', () => {
    const parsed = withDaily([{ start: '23:00', end: '7:50' }])
    // 07:49 Asia/Shanghai = 前一日 23:49 UTC
    expect(promotionActiveAt(parsed[0]!, at('2026-11-16T23:49:00Z'))).toBe(true)
    // 07:50 ⇒ 终点不含
    expect(promotionActiveAt(parsed[0]!, at('2026-11-16T23:50:00Z'))).toBe(false)
  })

  it('★★ start === end 是**空区间**（半开区间没有成员），与价格腿同判', () => {
    // ⚠️ 这条用例此前断言 `true`（「同钟点 = 全天」）—— 那与价格腿
    // `src/qoder-adapter.ts` 的 `promotionActiveNow`（`minutes >= start && minutes < end`）
    // **反向**。两条腿对同一上游输入必须给出同一裁决，否则零长度窗口会让
    // 徽标全天挂「限时免费」而价格按原价（issue #101 的形态）。
    const parsed = withDaily([{ start: '22:00', end: '22:00' }])
    expect(promotionActiveAt(parsed[0]!, DAY_SH)).toBe(false)
    expect(promotionActiveAt(parsed[0]!, NIGHT_SH)).toBe(false)
  })

  it('★★★ 与价格腿**同判**：同一份窗口两条腿必须给同一裁决', () => {
    // 本模块（徽标腿）与 `src/qoder-adapter.ts` 的 `promotionActiveNow`（价格腿）
    // 读的是**同一份上游活动窗口**。两条腿若反向，用户会看到
    // 「徽标写限时免费、价格按原价」（issue #101 要修的形态）。
    // 这条用例把两张判据钉在一起：以后任何一方单改都会红。
    const windows: readonly [string, string][] = [
      ['22:00', '22:00'],  // 零长度（半开区间 = 空集）
      ['00:00', '00:00'],  // 零长度
      ['09:00', '10:00'],  // 普通
      ['23:00', '07:50'],  // 跨零点
      ['00:00', '24:00'],  // 真·全天
      ['23:00', '24:00'],  // 24:00 作为终点（P2-2：三处判据必须统一）
      ['12:00', '24:00'],
      // ⚠️ `24:00` 当**起点**是非法写法（当日末尾不是任何窗口的起点）。
      // 两条腿都必须判「永不成立」：徽标腿靠「声明过但一条窗口都没活下来」
      // ⇒ dailyUnusable；价格腿靠 `toMinutes(windowStart)` 无 allowEndOfDay。
      ['24:00', '24:00'],
      ['24:00', '07:50'],
      ['09:60', '10:00'],  // 分钟越界
      ['soon', 'later'],   // 换形
    ]
    for (const [start, end] of windows) {
      const parsed = withDaily([{ start, end }])
      for (const moment of [DAY_SH, NIGHT_SH]) {
        const badgeLeg = promotionActiveAt(parsed[0]!, moment)
        const priceLeg = promotionActiveNow(
          { active: true, windowStart: start, windowEnd: end } as never,
          new Date(moment),
        )
        expect(badgeLeg, `${start}-${end} @${new Date(moment).toISOString()}`).toBe(priceLeg)
      }
    }
  })

  it('★★ 24:00 只作为**终点**接受（三处判据统一，P2-2）', () => {
    // 徽标腿早就接受 `24:00` 作终点（`clockMinute` 有专门分支），但价格腿
    // （buddy 的 `parseHHMM` / qoder 的 `toMinutes`）此前一律要求 `h < 24`
    // ⇒ buddy 丢掉整个 slot（不出价）、qoder 退回 `promotion.active` 快照
    // ⇒ **三处三种答案**。现在三处统一：`24:00` = 当日末尾 1440。
    for (const [start, end] of [['23:00', '24:00'], ['00:00', '24:00']] as const) {
      const parsed = withDaily([{ start, end }])
      expect(parsed[0]!.schedule?.daily, `${start}-${end}`).toEqual([{ start, end }])
      expect(parsed[0]!.schedule?.dailyUnusable, `${start}-${end} 不该 unusable`).toBeUndefined()
    }
    // 23:30 在 [23:00, 24:00) 内；00:30 不在。
    const late = withDaily([{ start: '23:00', end: '24:00' }])
    expect(promotionActiveAt(late[0]!, at('2026-11-16T15:30:00Z'))).toBe(true)   // 23:30 SH
    expect(promotionActiveAt(late[0]!, at('2026-11-16T16:30:00Z'))).toBe(false)  // 00:30 SH 次日
  })

  it('★★ 23:60 / 24:30 这类「格式漂移」必须被判死（P3-7）', () => {
    // `minute > 59` 闸门此前零覆盖 —— 只留 `hour > 24` 时 `23:60` 会被当 1440
    // 接受（= 次日 0 点），把上游的 `H:MM` 误写静默吞成合法值。
    for (const bad of ['23:60', '24:30', '25:00', '12:99']) {
      const parsed = withDaily([{ start: '08:00', end: bad }])
      expect(parsed[0]!.schedule?.dailyUnusable, bad).toBe(true)
    }
  })

  it('24:00 只作为**终点**接受；作为起点拒绝', () => {
    const asEnd = withDaily([{ start: '23:00', end: '24:00' }])
    expect(asEnd[0]!.schedule?.daily).toEqual([{ start: '23:00', end: '24:00' }])
    expect(promotionActiveAt(asEnd[0]!, NIGHT_SH)).toBe(true)
    expect(promotionActiveAt(asEnd[0]!, DAY_SH)).toBe(false)
    const asStart = withDaily([{ start: '24:00', end: '23:00' }])
    // 起点读不懂 ⇒ 整条 daily 一条都没活下来 ⇒ dailyUnusable（不许当成全天）
    expect(asStart[0]!.schedule?.dailyUnusable).toBe(true)
    expect(promotionActiveAt(asStart[0]!, NIGHT_SH)).toBe(false)
  })

  it('★ 多条时段是「或」关系（实测 hy4 白天条目有两条）', () => {
    const parsed = withDaily([{ start: '0:00', end: '8:00' }, { start: '23:00', end: '23:59' }])
    // 03:00 Asia/Shanghai ⇒ 命中第一条；23:30 ⇒ 命中第二条。
    expect(promotionActiveAt(parsed[0]!, at('2026-11-16T19:00:00Z'))).toBe(true)
    expect(promotionActiveAt(parsed[0]!, NIGHT_SH)).toBe(true)
    // 14:00 Asia/Shanghai ⇒ 两条都不在（8:00 那一刻终点不含，故不能拿 DAY_SH 当样本）。
    expect(promotionActiveAt(parsed[0]!, at('2026-11-17T06:00:00Z'))).toBe(false)
  })

  it('daily 缺省 / 空数组 = **全天活动**（有效期内一直成立）', () => {
    const missing = withDaily(undefined)
    const empty = withDaily([])
    expect(missing[0]!.schedule?.daily).toBeUndefined()
    expect(empty[0]!.schedule?.daily).toBeUndefined()
    expect(empty[0]!.schedule?.dailyUnusable).toBeUndefined()
    for (const parsed of [missing, empty]) {
      expect(promotionActiveAt(parsed[0]!, DAY_SH)).toBe(true)
      expect(promotionActiveAt(parsed[0]!, NIGHT_SH)).toBe(true)
    }
  })

  it('★★ dailyUnusable：下发了 daily 却一条都读不懂 ⇒ **永不成立**，且点名告警一次', () => {
    const warn = vi.fn()
    const parsed = parseTencentPromotions(
      [{ id: 'broken-window', badge: { label: 'A' }, modelIds: ['m'],
        schedule: { daily: [{ start: '24:30', end: '99:99' }], timezone: 'Asia/Shanghai' } }],
      [], 'Asia/Shanghai', warn,
    )
    expect(parsed).toHaveLength(1)
    const promotion = parsed[0]!
    expect(promotion.schedule?.dailyUnusable).toBe(true)
    // 「读不懂」绝不能被当成「全天」—— 那会把一个夜间活动画成全天徽标。
    expect(promotionRunningAt(promotion, NIGHT_SH)).toBe(false)
    expect(promotionStandingAt(promotion, NIGHT_SH)).toBe(false)
    expect(selectPromotionAt([promotion], NIGHT_SH)).toBeUndefined()
    // 告警在**解析路径**上、每次文档一次，并点名到条目 id。
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('broken-window')
  })

  it('★★ issue #139 的**第二个入口**：直接喂进来的条目里窗口是数字 ⇒ 不画，且不抛错', () => {
    // 解析路径已经把数字端点挡在 asText 那一层（上一条覆盖的就是它）。
    // 但 clockMinute 还有一条**不经过解析**的路：手构条目 / 将来的持久化回读
    // （参考实现 dsh-connect-workbuddy 就是被那条路咬的 —— 促销对象原样穿过
    // settings schema 落盘再读回，那里没有任何类型检查）。
    // 变异 M4：删掉 clockMinute 第一行的类型闸门 ⇒ 本条必须红（它会抛
    // value.trim is not a function，症状从「少一枚徽标」升级成「整条渠道没了」）。
    const poisoned = {
      id: 'poisoned', source: 'promotion' as const, modelIds: ['m'],
      badge: { label: '夜间折扣' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: 1380, end: 450 }] },
      timeDeclared: true, standingEligible: true, priority: 100,
    }
    // 本条的牙在 not.toThrow：闸门被删时 value.trim() 直接抛 TypeError。
    expect(() => promotionActiveAt(poisoned as never, NIGHT_SH)).not.toThrow()
    // 数字窗口求不出任何成立的时段 ⇒ 此刻**不在跑**。
    expect(promotionActiveAt(poisoned as never, NIGHT_SH)).toBe(false)
    expect(promotionRunningAt(poisoned as never, NIGHT_SH)).toBe(false)
    // ⚠️ 但它仍可以「常驻」出现 —— 这是**刻意的**，不是漏判：
    // 把常驻也关掉的那道闸是 schedule.dailyUnusable，而它由**解析层**在
    // 「上游下发了 daily 却一条都没活下来」时置位（上面 dailyUnusable 那一组覆盖）。
    // 手构条目没带那个标记 ⇒ 模块只能按「上游没说它有时间」处理。
    // 换言之：隐藏靠的是**事实标记**，不是「我读不懂所以猜一个最保守的」。
    expect(selectPromotionAt([poisoned as never], NIGHT_SH)).toBeDefined()
    // 带上标记的那一份 ⇒ 两个方向都关掉（这才是上游真实下发的形态）。
    const flagged = { ...poisoned, schedule: { ...poisoned.schedule, dailyUnusable: true as const } }
    expect(() => selectPromotionAt([flagged as never], NIGHT_SH)).not.toThrow()
    expect(selectPromotionAt([flagged as never], NIGHT_SH)).toBeUndefined()
    // ⚠️ 反向对照：同一份结构、端点是合法字符串 ⇒ 必须成立（否则上面是恒假）。
    const fixed = {
      ...poisoned,
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:30' }] },
    }
    expect(promotionActiveAt(fixed as never, NIGHT_SH)).toBe(true)
  })
  it('⚠️ issue #139 回归：非字符串的窗口端点必须被拒绝，**不许在渲染路径抛错**', () => {
    // 落盘缓存是第二个入口，那条路上没有任何类型检查。
    // 一旦让 1380 这种数字走到 .trim()，症状是「整条渠道的模型列表消失」
    // （目录装配抛错被宿主吞成空目录），而不是「少一枚徽标」。
    const parsed = parseTencentPromotions(
      [{ badge: { label: 'A' }, modelIds: ['m'],
        schedule: { daily: [{ start: 1380, end: 450 }, { start: '23:00', end: '7:50' }] } }],
      [],
    )
    expect(parsed).toHaveLength(1)
    // 数字那条被丢弃，同批里可读的那条活下来 ⇒ 既没抛错，也没退化成全天。
    expect(parsed[0]!.schedule?.daily).toEqual([{ start: '23:00', end: '7:50' }])
    expect(promotionActiveAt(parsed[0]!, NIGHT_SH)).toBe(true)
    expect(promotionActiveAt(parsed[0]!, DAY_SH)).toBe(false)
  })
})

describe('时区口径', () => {
  it('★ 窗口按**上游声明的时区**算，与读者所在时区无关', () => {
    const parsed = parseTencentPromotions(
      [{ badge: { label: '夜间折扣' }, modelIds: ['m'],
        schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Asia/Shanghai' } }],
      [],
    )
    // 15:30 UTC = 23:30 Asia/Shanghai ⇒ 成立；同一时刻在 UTC 是 15:30 ⇒ 若误用本地时区就会漏。
    expect(promotionActiveAt(parsed[0]!, NIGHT_SH)).toBe(true)
    // 换声明成 UTC ⇒ 同一 epoch 时刻**不再**成立（证明时区真的参与了计算，而不是恒真）。
    const asUtc = parseTencentPromotions(
      [{ badge: { label: '夜间折扣' }, modelIds: ['m'],
        schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'UTC' } }],
      [],
    )
    expect(promotionActiveAt(asUtc[0]!, NIGHT_SH)).toBe(false)
    expect(promotionActiveAt(asUtc[0]!, at('2026-11-17T23:30:00Z'))).toBe(true)
  })

  it('★★ 上游没写时区时用**调用方传入的**兜底（与价格腿同判据，不许各猜一个）', () => {
    const record = [{ badge: { label: '夜间折扣' }, modelIds: ['m'],
      schedule: { daily: [{ start: '23:00', end: '7:50' }] } }] as unknown[]
    const shanghai = parseTencentPromotions(record, [], 'Asia/Shanghai')
    const utc = parseTencentPromotions(record, [], 'UTC')
    // 同一个 epoch 时刻，两种兜底给出两种答案 ⇒ 兜底值确实参与了判定。
    // 价格腿（src/buddy.ts 的 zonedMinutes）兜底 Asia/Shanghai ⇒ 徽标腿必须同值，
    // 否则同一份报文会在「价格」与「徽标」上差 8 小时说话。
    expect(promotionActiveAt(shanghai[0]!, NIGHT_SH)).toBe(true)
    expect(promotionActiveAt(utc[0]!, NIGHT_SH)).toBe(false)
    // 默认参数即 Asia/Shanghai（腾讯价格腿的取值）。
    const dflt = parseTencentPromotions(record, [])
    expect(promotionActiveAt(dflt[0]!, NIGHT_SH)).toBe(true)
  })

  it('★ 非法时区名 ⇒ **不算在跑**，绝不静默退回本地/UTC 时区', () => {
    const parsed = parseTencentPromotions(
      [{ badge: { label: 'A' }, modelIds: ['m'],
        schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Not/AZone' } }],
      [],
    )
    expect(promotionRunningAt(parsed[0]!, NIGHT_SH)).toBe(false)
    expect(promotionActiveAt(parsed[0]!, NIGHT_SH)).toBe(false)
    // ⚠️ 决定性取样：05:00 UTC 的**墙上分钟数 300**正好落在 23:00–7:50 之内。
    // 若实现「读不懂就退回本地/UTC」（变异 M10 就是把 undefined 兜底重算一次），
    // 这一格会变成 true ⇒ 一个上游说了有窗口、我们读不懂的活动被画成「正在打折」。
    // 只有这一格才让「退回兜底时区」这个方向真的有牙。
    const insideIfFallback = at('2026-11-17T05:00:00Z')
    expect(insideIfFallback / 60_000 % 1440).toBe(300) // 自证取样落在窗口内
    expect(promotionActiveAt(parsed[0]!, insideIfFallback), '读不懂的时区不许退回本地').toBe(false)
    expect(promotionRunningAt(parsed[0]!, insideIfFallback)).toBe(false)
    // 同一时刻在**合法**时区下的对照（Asia/Shanghai 的 13:00 ⇒ 窗口外 ⇒ 也 false）,
    // 以及一个合法时区下为 true 的时刻 ⇒ 证明上面的 false 不是「恒假」。
    const shanghai = parseTencentPromotions(
      [{ badge: { label: 'A' }, modelIds: ['m'],
        schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Asia/Shanghai' } }],
      [],
    )
    expect(promotionActiveAt(shanghai[0]!, insideIfFallback)).toBe(false)
    expect(promotionActiveAt(shanghai[0]!, NIGHT_SH)).toBe(true)
  })

  it('⚠️ 非法时区 + display:activeOnly ⇒ 整条不画（两个方向都不替上游背书）', () => {
    const parsed = parseTencentPromotions(
      [{ badge: { label: 'A', display: 'activeOnly' }, modelIds: ['m'],
        schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Not/AZone' } }],
      [],
    )
    expect(selectPromotionAt(parsed, NIGHT_SH)).toBeUndefined()
  })

  it('注册分叉（如实登记）：读不懂时区只关掉「在跑」，常驻徽标照旧', () => {
    // 腾讯的夜间折扣本来就是成对下发（夜里那条带折扣、白天那条只带角标），
    // 「徽标全天挂着 + 折扣按窗口」是上游的语义 ⇒ 时区读不懂时关掉 running
    // 是保守方向，而 standing 仍成立**不是**谎报价格（徽标只说「这是一条活动」，
    // 价格由 buddy.ts 的价格腿单独判定，那条腿在时区读不懂时另有「不误杀」口径）。
    const parsed = parseTencentPromotions(
      [{ badge: { label: '夜间折扣' }, modelIds: ['m'],
        schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Not/AZone' } }],
      [],
    )
    expect(promotionStandingAt(parsed[0]!, NIGHT_SH)).toBe(true)
    expect(selectPromotionAt(parsed, NIGHT_SH)?.badge.label).toBe('夜间折扣')
    expect(promotionBadgeFor(parsed, NIGHT_SH)!.text).toBe('夜间折扣')
  })
})

describe('selectPromotionAt：running 与 standing 的顺序', () => {

  it('★ 同分时活动（promotion）先于等级标记（tier）', () => {
    const parsed = parseTencentPromotions(
      [{ badge: { label: 'Free now' }, modelIds: ['m'], priority: 200 }],
      [{ badge: { label: 'Pro Only' }, modelIds: ['m'], priority: 200 }],
    )
    expect(parsed.map((p) => p.source)).toEqual(['promotion', 'tier'])
    expect(sortPromotions(parsed).map((p) => p.badge.label)).toEqual(['Free now', 'Pro Only'])
  })

  it('★★ 没有 schedule 的等级标记**不算在跑**：不许压掉真的在开的低价活动', () => {
    // 参考实现里的 hasSchedule 就是为此存在。反例：tier priority 200（无 schedule）、
    // 活动 priority 100（窗口此刻开着）⇒ 必须选活动。
    const tier = { id: 't', badge: { label: 'Pro Only' }, modelIds: ['m'], priority: 200 }
    const live = {
      id: 'p', badge: { label: '限时免费' }, modelIds: ['m'], priority: 100,
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
    }
    const parsed = parseTencentPromotions([live], [tier])
    // 数组顺序里 tier 因为 promotions 先解析而排在**后面**，所以这不靠顺序碰运气：
    // running 那一支必须在前面。
    expect(parsed[0]!.source).toBe('promotion')
    expect(selectPromotionAt(parsed, NIGHT_SH)?.id).toBe('p')
    // 窗口外 ⇒ running 那一支全落空，才轮到 tier 常驻。
    expect(selectPromotionAt(parsed, DAY_SH)?.id).toBe('t')
  })

  it('★ priority 高的先；夜间/白天成对条目各在其时段胜出', () => {
    // 实测 glm-5.2：一条带夜间时段（priority 100）、一条带白天时段（priority 50）。
    const parsed = parseTencentPromotions([
      { id: 'night', badge: { label: '夜间折扣' }, modelIds: ['glm-5.2'], priority: 100,
        schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] } },
      { id: 'day', badge: { label: '夜间折扣' }, modelIds: ['glm-5.2'], priority: 50,
        schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '7:50', end: '23:00' }] } },
    ], [])
    expect(selectPromotionAt(parsed, NIGHT_SH)?.id).toBe('night')
    expect(selectPromotionAt(parsed, DAY_SH)?.id).toBe('day')
    // 白天那条**没写 activeOnly** ⇒ 徽标全天可挂（上游用「一条带夜间折扣、
    // 一条只带角标」表达「全天挂着同一个徽标、折扣只在夜里生效」）。
    expect(promotionStandingAt(parsed[1]!, NIGHT_SH)).toBe(true)
  })

  it('★★★ 两条活动同时开 + priority 相同 ⇒ 选择器必须给出**确定且稳定**的赢家（不能随数组顺序抖）', () => {
    // 对抗审计 P2-2：M11（同分 tie）无牙 —— 原来没有用例让两条**都 running** 的活动打到
    // sortPromotions 的 tie 分支。这里两条都在窗口内、priority 都是 100。
    const a = { id: 'a', badge: { label: 'A 活动' }, modelIds: ['m'], priority: 100,
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '24:00' }] } }
    const b = { id: 'b', badge: { label: 'B 活动' }, modelIds: ['m'], priority: 100,
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '24:00' }] } }
    // sortPromotions 是**稳定排序**、同优先级同来源时返回 0（不按 id 兜底）⇒
    // 赢家 = 输入顺序里的第一个。断言这一点即可：若比较方向被写反（M10/M11），
    // 结果会变；两向都锁住说明「确定性由输入顺序决定，不是随机」。
    expect(selectPromotionAt(parseTencentPromotions([a, b], []), NIGHT_SH)?.id).toBe('a')
    expect(selectPromotionAt(parseTencentPromotions([b, a], []), NIGHT_SH)?.id).toBe('b')
  })

  it('★★ 两条活动同时开、priority 不同 ⇒ 高的赢；同时把「running 优先于 standing」再钉一遍', () => {
    // 覆盖 M10（sort 升序变异）：若比较方向反过来，priority 低的会先出。
    const high = { id: 'high', badge: { label: '高优先' }, modelIds: ['m'], priority: 300,
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '24:00' }] } }
    const low = { id: 'low', badge: { label: '低优先' }, modelIds: ['m'], priority: 50,
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '24:00' }] } }
    expect(selectPromotionAt(parseTencentPromotions([low, high], []), NIGHT_SH)?.id).toBe('high')
  })

  it('★ 空时段（start === end）不算在跑（M14）', () => {
    const empty = { id: 'e', badge: { label: '空时段' }, modelIds: ['m'], priority: 100,
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '09:00', end: '09:00' }] } }
    expect(selectPromotionAt([empty as never], NIGHT_SH)).toBeUndefined()
  })

  it('★★ 星期闸门：weekdays 声明了就必须命中今天，空数组/全非法一律不成立（M15 对照组）', () => {
    // parseDailyWindows 只回填 { start, end }、**不搬 weekdays 字段**（见它函数体），
    // 所以经 parseTencentPromotions 造的候选根本没有 weekdays ⇒ 走那条路测不到
    // withinDailyWindows 的星期闸门。这里直接构造。
    // ⚠️ 断言必须打在 promotionWithinDailyWindow 上，**不能**打 selectPromotionAt：
    // 后者对这条输入无论星期闸门开不开都返回 undefined（全天窗口即便「在跑」，
    // promotionStandingAt 也会因 standingEligible=false 挡掉）⇒ 变异不可见。
    // ⚠️ 必须用**对照对**（命中 vs 不命中），单靠「空数组 ⇒ false」抓不住
    // `days.length === 0 ⇒ false` 那行：空数组时 `days.includes(today)` 本就 false，
    // 那行只是提前退出、行为上冗余（本用例第一版就因此对 M15 变异无牙）。
    const mk = (weekdays?: number[]) => ({
      id: 'n', source: 'promotion' as const, modelIds: ['m'],
      badge: { label: '星期' }, priority: 100, timeDeclared: true,
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '24:00', ...weekdays === undefined ? {} : { weekdays } }] },
    })
    // 2026-11-17 是周二（isoWeekday=2）
    expect(promotionWithinDailyWindow(mk([2]), NIGHT_SH)).toBe(true)      // 命中今天 → 成立
    expect(promotionWithinDailyWindow(mk([3]), NIGHT_SH)).toBe(false)     // 只有周三 → 不成立
    expect(promotionWithinDailyWindow(mk([]), NIGHT_SH)).toBe(false)      // 空数组 → 不成立（fail-closed）
    expect(promotionWithinDailyWindow(mk([0, 8, 1.5]), NIGHT_SH)).toBe(false) // 全非法 → 不成立
    expect(promotionWithinDailyWindow(mk(undefined), NIGHT_SH)).toBe(true)    // 缺席 = 每天 → 成立
  })

  it('空候选与 undefined 都不抛错（下游对「没有活动」必须拿到 undefined 而不是异常）', () => {
    expect(selectPromotionAt(undefined, DAY_SH)).toBeUndefined()
    expect(selectPromotionAt([], DAY_SH)).toBeUndefined()
    expect(promotionBadgeFor(undefined, DAY_SH)).toBeUndefined()
  })
})

describe('宿主徽标装配（promotionBadgeFor）', () => {
  it('★ 上游同时给了中英文 ⇒ 出**表**形态且必须带 en（缺 en 宿主会把胶囊整条丢）', () => {
    const parsed = parseTencentPromotions(
      [{ badge: { label: '错峰 4 折', labelEn: 'Off-Peak 60% off' }, modelIds: ['m'],
        schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '0:00', end: '24:00' }] } }],
      [],
    )
    const badge = promotionBadgeFor(parsed, DAY_SH)!
    expect(badge.text).toEqual({ en: 'Off-Peak 60% off', zh: '错峰 4 折' })
    if (typeof badge.text !== 'string') {
      // 这条断言看着像同义反复，但它守的是「表形态必须有 en」：
      // 宿主 resolveText 对没有 en 的表返回 undefined ⇒ 徽标凭空消失。
      expect(Object.prototype.hasOwnProperty.call(badge.text, 'en')).toBe(true)
      expect(badge.text.en).toBe(badge.text['en'])
    } else {
      throw new Error('双语必须出表形态，实际拿到裸字符串')
    }
  })

  it('★ CN 只发中文 ⇒ 塌成裸字符串，**绝不编英文**', () => {
    const parsed = parseTencentPromotions(
      [{ badge: { label: '限时免费' }, modelIds: ['m'],
        schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '0:00', end: '24:00' }] } }],
      [],
    )
    const badge = promotionBadgeFor(parsed, DAY_SH)!
    expect(badge.text).toBe('限时免费')
    expect(typeof badge.text).toBe('string')
  })

  it('tone 就近映射；上游没给颜色一律 neutral', () => {
    const toneOf = (color: string | undefined) => promotionTone(mkPromo(color))
    expect(toneOf('#009273')).toBe('success')   // CN 每个「免费/折扣」用的绿
    expect(toneOf('#1E90FF')).toBe('info')      // 会员/等级蓝
    expect(toneOf('#FF0000')).toBe('warning')   // 实测 Free now 用的红
    expect(toneOf('#FFA500')).toBe('warning')
    expect(toneOf(undefined)).toBe('neutral')
    expect(toneOf('#777777')).toBe('neutral')
    // ⚠️ 三位 hex 按 CSS 语义展开成 6 位再算（`#abc` ≡ `#aabbcc`）。
    // 原先这里断言 `neutral`，而同一行注释写的是「三位 hex 也必须能算出档位」——
    // **自相矛盾**：绿色的 `#0f0` 被画成灰，与上面「绿色 → success」直接冲突。
    expect(toneOf('#0f0')).toBe('success')      // #0f0 ≡ #00ff00
    expect(toneOf('#00f')).toBe('info')         // #00f ≡ #0000ff
    expect(toneOf('#f00')).toBe('warning')      // #f00 ≡ #ff0000
  })

  it('★ 颜色闸门：只有 hex 能进样式，其它写法一律拒绝', () => {
    for (const color of ['rgb(0,255,0)', 'var(--brand)', 'red', '009273', '#00', '#1234567']) {
      expect(promotionBadgeColor(mkPromo(color)), color).toBeUndefined()
    }
    expect(promotionBadgeColor(mkPromo('#009273'))).toBe('#009273')
    expect(promotionBadgeColor(mkPromo('#0f0'))).toBe('#0f0')
  })

  it('⚠️ 不成立时返回 undefined，**不是**一个空对象（宿主按 undefined 走回落分支）', () => {
    const expired = parseTencentPromotions(
      [{ badge: { label: 'A', display: 'activeOnly' }, modelIds: ['m'],
        schedule: { validUntil: '2026-01-01T00:00:00+08:00' } }], [],
    )
    expect(promotionBadgeFor(expired, DAY_SH)).toBeUndefined()
  })
})

function mkPromo(color: string | undefined) {
  const parsed = parseTencentPromotions(
    [{ badge: { label: 'L', ...(color === undefined ? {} : { color }) }, modelIds: ['m'] }], [],
  )
  return parsed[0]!
}

describe('Qoder 的 promotion（qoderPromotionCandidate）', () => {
  const base = {
    active: false,
    windowStart: '22:00',
    windowEnd: '08:00',
    badgeZh: '错峰 4 折',
    badgeEn: 'Off-Peak 60% off',
    timezone: 'Asia/Shanghai',
  }

  it('有窗口 ⇒ 窗口说了算，**active 完全不参与**（否则白天启动的进程永远不画）', () => {
    const candidate = qoderPromotionCandidate(base, 'qmodel_38max')!
    expect(candidate.timeDeclared).toBe(true)
    expect(candidate.schedule?.daily).toEqual([{ start: '22:00', end: '08:00' }])
    expect(candidate.standingEligible).toBe(false)
    expect(promotionRunningAt(candidate, NIGHT_SH)).toBe(true)
    expect(promotionRunningAt(candidate, DAY_SH)).toBe(false)
    // active 是目录下发那一刻的快照：夜里读到 false 也不许挡住窗口。
    expect(promotionRunningAt({ ...candidate, schedule: { ...candidate.schedule!, snapshotActive: false } }, NIGHT_SH)).toBe(true)
  })

  it('★ 窗口外**什么都不画**（宿主徽标没有悬停位，不许说「错峰 4 折」）', () => {
    const candidate = qoderPromotionCandidate(base, 'qmodel_38max')!
    expect(selectPromotionAt([candidate], DAY_SH)).toBeUndefined()
    expect(promotionBadgeFor([candidate], DAY_SH)).toBeUndefined()
    expect(promotionStandingAt(candidate, DAY_SH)).toBe(false)
  })

  it('上游没给窗口 ⇒ 只能信 active 快照（true 画、false 不画）', () => {
    const on = qoderPromotionCandidate({ active: true, badgeZh: '错峰 2 折' }, 'm')!
    expect(on.timeDeclared).toBe(false)
    expect(promotionRunningAt(on, DAY_SH)).toBe(true)
    expect(selectPromotionAt([on], DAY_SH)?.badge.label).toBe('错峰 2 折')
    const off = qoderPromotionCandidate({ active: false, badgeZh: '错峰 2 折' }, 'm')!
    expect(promotionRunningAt(off, DAY_SH)).toBe(false)
    expect(selectPromotionAt([off], DAY_SH)).toBeUndefined()
  })

  it('★★ 声明了窗口但读不懂 ⇒ 整条不画：既不当全天，也不退回 active', () => {
    const warn = vi.fn()
    const candidate = qoderPromotionCandidate(
      { active: true, windowStart: '24:30', windowEnd: '08:00', badgeZh: '错峰 4 折' },
      'm', 'Asia/Shanghai', warn,
    )!
    expect(candidate.schedule?.dailyUnusable).toBe(true)
    expect(candidate.timeDeclared).toBe(true)
    // active 是 true，但读不懂的窗口不许被放大成「全天都在打折」。
    expect(promotionRunningAt(candidate, DAY_SH)).toBe(false)
    expect(selectPromotionAt([candidate], DAY_SH)).toBeUndefined()
    expect(selectPromotionAt([candidate], NIGHT_SH)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('24:30')
    // 只给一端同样是「声明了但读不懂」。
    const half = qoderPromotionCandidate({ active: true, windowStart: '22:00', badgeZh: 'A' }, 'm')!
    expect(half.schedule?.dailyUnusable).toBe(true)
    expect(selectPromotionAt([half], NIGHT_SH)).toBeUndefined()
  })

  it('badge 两个字段都没有 ⇒ 整条丢弃（插件不替上游编文案）', () => {
    expect(qoderPromotionCandidate({ active: true, windowStart: '22:00', windowEnd: '08:00' }, 'm')).toBeUndefined()
    expect(qoderPromotionCandidate(undefined, 'm')).toBeUndefined()
    // 只有 en 也要能画（国际站形态）。
    const onlyEn = qoderPromotionCandidate({ active: true, badgeEn: 'Off-Peak' }, 'm')!
    expect(onlyEn.badge.label).toBe('Off-Peak')
    expect(onlyEn.badge.labelEn).toBe('Off-Peak')
    expect(promotionBadgeFor([onlyEn], DAY_SH)!.text).toBe('Off-Peak')
  })

  it('⚠️ 上游没写 timezone ⇒ 兜底必须与价格腿一致（Asia/Shanghai，不是 UTC）', () => {
    const candidate = qoderPromotionCandidate(
      { active: true, windowStart: '23:00', windowEnd: '07:50', badgeZh: 'A' }, 'm',
    )!
    expect(candidate.schedule?.timezone).toBe('Asia/Shanghai')
    expect(promotionRunningAt(candidate, NIGHT_SH)).toBe(true)
    expect(promotionRunningAt(candidate, DAY_SH)).toBe(false)
    expect(qoderPromotionCandidate({ active: true, windowStart: '23:00', windowEnd: '07:50', badgeZh: 'A' }, 'm', 'UTC')
      .schedule?.timezone).toBe('UTC')
  })

  it('id 用 rule_id，缺失时按 promotion:modelId 合成', () => {
    expect(qoderPromotionCandidate({ active: true, badgeZh: 'A', ruleId: 'idle_time_model_credit_discount' }, 'm')!.id)
      .toBe('idle_time_model_credit_discount')
    expect(qoderPromotionCandidate({ active: true, badgeZh: 'A' }, 'm')!.id).toBe('promotion:m')
  })

  it('空 modelId 直接丢弃（否则会把徽标挂到一个不存在的行上）', () => {
    expect(qoderPromotionCandidate({ active: true, badgeZh: 'A' }, '')).toBeUndefined()
  })

  /**
   * 悬停那句（GitHub PR #110 建的出口）：官方把 `promotion.description` 当
   * `promotionDescription` 塞进条目 detail —— 即**悬停正文**，而 `badge` 只是行上短标签。
   *
   * ⚠️ 本仓原先**整条丢掉** description（只读 badge），而两站今天**都在发**
   * （2026-11-18 实测：CN「错峰时段4折优惠（10 PM-8 AM UTC+8）」、国际版同句英文）。
   */
  it('★ 上游给了 description ⇒ 进 hover，并按读者语言挑；缺了就不带（不编文案）', () => {
    const withCopy = qoderPromotionCandidate({
      active: false,
      windowStart: '22:00',
      windowEnd: '08:00',
      badgeZh: '错峰 4 折',
      badgeEn: 'Off-Peak 60% off',
      descriptionZh: '错峰时段4折优惠（10 PM-8 AM UTC+8）',
      descriptionEn: 'Off-Peak 60% off (10 PM-8 AM UTC+8)',
    }, 'qmodel_38max')!
    expect(withCopy.hover).toEqual({
      zh: '错峰时段4折优惠（10 PM-8 AM UTC+8）',
      en: 'Off-Peak 60% off (10 PM-8 AM UTC+8)',
    })
    // 悬停 = 上游原话 · 每日时段（有时段才写），三件都来自上游自己的字段。
    expect(promotionTooltip(withCopy, 'zh-CN')).toContain('错峰时段4折优惠')
    expect(promotionTooltip(withCopy, 'zh-CN')).toContain('22:00–08:00')
    expect(promotionTooltip(withCopy, 'en-US')).toContain('Off-Peak 60% off (10 PM-8 AM UTC+8)')
    // 只有中文那句时，英文读者退回中文（与 `pickCopy` 同口径），而不是整句消失。
    const zhOnly = qoderPromotionCandidate({
      active: false, windowStart: '22:00', windowEnd: '08:00', badgeZh: 'A',
      descriptionZh: '中文说明',
    }, 'm')!
    expect(zhOnly.hover).toEqual({ zh: '中文说明' })
    expect(promotionTooltip(zhOnly, 'en-US')).toContain('中文说明')

    const noCopy = qoderPromotionCandidate({
      active: false, windowStart: '22:00', windowEnd: '08:00', badgeZh: 'A',
    }, 'm')!
    expect(noCopy.hover).toBeUndefined()
    expect(promotionTooltip(noCopy, 'zh-CN')).not.toContain('undefined')
    expect(promotionTooltip(noCopy, 'zh-CN')).toContain('22:00–08:00')
  })
})

describe('nextPromotionEdgeMs：窗口边界（保鲜排程的依据）', () => {
  const fromTencent = (schedule: unknown) => parseTencentPromotions(
    [{ badge: { label: 'A' }, modelIds: ['m'], schedule }], [],
  )

  it('★ 取**严格大于此刻**的最近边界：每日端点按上游时区取下一次', () => {
    const parsed = fromTencent({ timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] })
    // 此刻 08:00 Asia/Shanghai（白天，窗口关着）⇒ 下一个边界是今晚 23:00。
    const now = at('2026-11-17T00:00:00Z')
    expect(nextPromotionEdgeMs(parsed, now)).toBe(at('2026-11-17T15:00:00Z'))
    // 此刻 23:30（窗口开着）⇒ 下一个边界是明早 7:50。
    const inside = at('2026-11-17T15:30:00Z')
    expect(nextPromotionEdgeMs(parsed, inside)).toBe(at('2026-11-17T23:50:00Z'))
  })

  it('跨零点窗口不能把边界算歪一天（早 7:50 在晚 23:00 之前）', () => {
    const parsed = fromTencent({ timezone: 'UTC', daily: [{ start: '23:00', end: '7:50' }] })
    const now = at('2026-11-17T00:00:00Z')
    expect(nextPromotionEdgeMs(parsed, now)).toBe(at('2026-11-17T07:50:00Z'))
  })

  it('validFrom / validUntil 参与；过去的边界一律不取', () => {
    const parsed = fromTencent({
      timezone: 'Asia/Shanghai',
      validFrom: '2026-12-01T00:00:00+08:00',
      validUntil: '2026-12-31T00:00:00+08:00',
    })
    expect(nextPromotionEdgeMs(parsed, at('2026-11-17T00:00:00Z'))).toBe(at('2026-11-30T16:00:00Z'))
  })

  it('读不懂的时区 / 已过期的条目 ⇒ undefined（**不排**，也不猜一个时刻）', () => {
    const badZone = fromTencent({ timezone: 'Not/AZone', daily: [{ start: '23:00', end: '7:50' }] })
    expect(nextPromotionEdgeMs(badZone, at('2026-11-17T00:00:00Z'))).toBeUndefined()
    const expired = fromTencent({ validUntil: '2020-01-01T00:00:00+08:00' })
    expect(nextPromotionEdgeMs(expired, at('2026-11-17T00:00:00Z'))).toBeUndefined()
  })

  it('没有 schedule / 空候选 ⇒ undefined（未登录与「上游没有活动」都不该空转）', () => {
    expect(nextPromotionEdgeMs([], DAY_SH)).toBeUndefined()
    expect(nextPromotionEdgeMs(parseTencentPromotions([{ badge: { label: 'A' }, modelIds: ['m'] }], []), DAY_SH))
      .toBeUndefined()
  })

  // ── PR #104 双审计（2026-11-17）补的判据 ──────────────────────────────

  describe('上游时间字段「声明过却读不懂」必须 fail-closed（PR #104 正向审计 P1-1）', () => {
    // 原先的判据只认「daily 是数组但全读不懂」这一种。上游**换形**时就会静默
    // fail-open：`daily: '23:00-07:50'`（字符串）⇒ schedule 只剩 {timezone} ⇒
    // `timeDeclared:false` ⇒ **徽标天天挂**；`validUntil` 是 epoch 数字 / 垃圾串
    // ⇒ 绝对窗口被丢弃 ⇒ **过期活动到 2030 年还挂 badge**。
    // 两者都是 issue #101 的原始症状，也正是本模块自称最该防的方向。
    const parseOne = (schedule: Record<string, unknown>, warn = vi.fn()) =>
      parseTencentPromotions(
        [{ badge: { label: 'A' }, modelIds: ['m'], schedule }], [], 'Asia/Shanghai', warn,
      )[0]!

    it('★★ daily 被写成字符串（而非数组）⇒ dailyUnusable，徽标不得常驻', () => {
      const warn = vi.fn()
      const promotion = parseOne({ daily: '23:00-07:50', timezone: 'Asia/Shanghai' }, warn)
      expect(promotion.schedule?.dailyUnusable).toBe(true)
      expect(promotionStandingAt(promotion, DAY_SH)).toBe(false)
      expect(promotionStandingAt(promotion, NIGHT_SH)).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('★★ validUntil 是 epoch 数字 ⇒ dailyUnusable（否则过期活动永挂）', () => {
      const promotion = parseOne({ validUntil: 1_794_931_200_000, timezone: 'Asia/Shanghai' })
      expect(promotion.schedule?.dailyUnusable).toBe(true)
      expect(promotionStandingAt(promotion, DAY_SH)).toBe(false)
    })

    it('★★ validUntil 是垃圾串 / validFrom 是对象 ⇒ dailyUnusable', () => {
      const garbage = parseOne({ validUntil: 'someday', timezone: 'Asia/Shanghai' })
      const objectFrom = parseOne({ validFrom: {}, timezone: 'Asia/Shanghai' })
      expect(garbage.schedule?.dailyUnusable).toBe(true)
      expect(objectFrom.schedule?.dailyUnusable).toBe(true)
      expect(promotionStandingAt(garbage, DAY_SH)).toBe(false)
      expect(promotionStandingAt(objectFrom, DAY_SH)).toBe(false)
    })

    it('daily 缺省 / 空数组**不算**声明过（既有契约：无时段 = 全天活动）', () => {
      const warn = vi.fn()
      const missing = parseOne({ timezone: 'Asia/Shanghai' }, warn)
      const empty = parseOne({ daily: [], timezone: 'Asia/Shanghai' }, warn)
      expect(missing.schedule?.dailyUnusable).toBeUndefined()
      expect(empty.schedule?.dailyUnusable).toBeUndefined()
      expect(promotionStandingAt(missing, DAY_SH)).toBe(true)
      expect(promotionStandingAt(empty, DAY_SH)).toBe(true)
      expect(warn).not.toHaveBeenCalled()
    })
  })

  describe('Qoder 徽标腿必须听价格腿的时区（PR #104 正向审计 P2-3）', () => {
    // 价格腿 `promotionActiveNow` 硬算 UTC+8（目录 timezone 与用户一致，故无需换算）；
    // 徽标腿若去听上游 `promotion.timezone`，上游发 `Asia/Tokyo` 时两腿就会反向。
    // 修法是**新腿对齐老腿**：一律用调用方给的 fallback（= UTC+8）。
    it('★★ 上游发 Asia/Tokyo 时，候选的时区仍必须是调用方的 fallback', () => {
      const candidate = qoderPromotionCandidate(
        { active: true, windowStart: '22:30', windowEnd: '07:50', badgeZh: '夜间折扣', timezone: 'Asia/Tokyo' },
        'm', 'Asia/Shanghai',
      )
      expect(candidate?.schedule?.timezone).toBe('Asia/Shanghai')
    })
  })

  describe('buddy 价格腿必须接受 `24:00` 作终点（PR #104 对抗审计 P1-2）', () => {
    // 上游「全天活动」最可能写成 `00:00–24:00`。原先 `parseHHMM` 硬要 `h < 24`
    // ⇒ 该 slot 被丢 ⇒ `windowed` 为假 ⇒ `0x` 被当成「已结束占位」丢掉
    // ⇒ **徽标全天挂「免费」而价格按原价**（正是 #101 要修的形态）。
    it('★★ 00:00–24:00 的免费活动必须真的算出折后价', () => {
      const promotions = parsePromotions({
        modelPromotions: [{
          enabled: true,
          modelIds: ['m'],
          badge: { label: 'Free now' },
          discount: { factor: 0 },
          schedule: { daily: [{ start: '00:00', end: '24:00' }], timezone: 'Asia/Shanghai' },
        }],
      }, new Date(DAY_SH))
      expect(promotions.get('m')).toBeDefined()
    })
  })

  describe('Qoder 窗口「声明了却读不懂」不得回退目录快照（PR #104 对抗审计 P1-3）', () => {
    // `windowStart`/`windowEnd` **缺席** ⇒ 回退 `active`（既有契约，上游没给窗口就信快照）；
    // **声明了却读不懂** ⇒ 必须 fail-closed，不能回退 —— 否则价格腿退回一个冻结在
    // 目录下发时刻的布尔，而徽标腿已把该窗口判死 ⇒ 两腿反向（同语义两个渠道相反展示）。
    const at = (iso: string) => new Date(iso)

    it('★★ 字段缺席 ⇒ 回退快照（既有契约，不能被本条修法误伤）', () => {
      expect(promotionActiveNow({ active: true } as never, at('2026-11-17T04:00:00Z'))).toBe(true)
      expect(promotionActiveNow({ active: false } as never, at('2026-11-17T04:00:00Z'))).toBe(false)
    })

    it('★★ 读不懂的窗口 ⇒ false（不得回退快照）', () => {
      for (const [start, end] of [['24:00', '24:00'], ['24:00', '07:50'], ['soon', 'later'], ['09:60', '10:00']]) {
        const promotion = { active: true, windowStart: start, windowEnd: end } as never
        expect(promotionActiveNow(promotion, at('2026-11-17T04:00:00Z')), `${start}-${end}`).toBe(false)
      }
    })
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// 带星期维度的每日时段 + TRAE 闲时候选（2026-11-17 真机取证后新增）
//
// 真机（scripts/probe-trae-promo.mjs，账号 1905882027265802，HTTP 200）：
//   activity_discount.data.off_peak = {
//     before_consumption_rate: 0.2, after_consumption_rate: 0.1, discount: 50,
//     time_zone: <26/32 行**缺席**>,
//     time_windows: [ { weekdays: [1..7], start_minute: 0, end_minute: 480 },
//                     { weekdays: [1..7], start_minute: 1320, end_minute: 1440 } ] }
//   另一形态（off_peak_member_discount_18_9）给 time_zone: "Asia/Shanghai"，
//   且窗口按「工作日三段 + 周末整日」下发。
// ─────────────────────────────────────────────────────────────────────────────

/** 一条最小候选：只关心 schedule 的判据，其余字段取 TRAE 实际用的那组。 */
function offPeakFixture(schedule: Parameters<typeof promotionActiveAt>[0]['schedule']): ModelPromotion {
  return {
    id: 'fixture:off-peak',
    source: 'promotion',
    modelIds: ['deepseek-v4-flash'],
    badge: { label: '闲时 5 折', labelEn: 'Off-peak 50% off' },
    ...schedule === undefined ? {} : { schedule },
    timeDeclared: true,
    standingEligible: false,
    priority: 100,
  }
}

describe('带星期维度的每日时段（TRAE 闲时窗口的形状）', () => {
  // 2026-11-17 = 周二；2026-11-21 = 周六（探针的时点表逐字确认过）。
  const TUE_10 = at('2026-11-17T02:00:00Z')   // 10:00 Asia/Shanghai
  const SAT_10 = at('2026-11-21T02:00:00Z')   // 10:00 Asia/Shanghai

  it('同一分钟、不同星期：工作日窗口在周末不成立（反向对照=不带星期则成立）', () => {
    const weekdayOnly = offPeakFixture({
      timezone: 'Asia/Shanghai',
      daily: [{ start: '00:00', end: '12:00', weekdays: [1, 2, 3, 4, 5] }],
    })
    expect(promotionActiveAt(weekdayOnly, TUE_10), '周二 10:00 必须在窗口内').toBe(true)
    expect(promotionActiveAt(weekdayOnly, SAT_10), '周六同一分钟必须不成立').toBe(false)
    // 反向对照：不带 weekdays 的同一窗口两天都成立 —— 否则上一条是恒真。
    const everyDay = offPeakFixture({ timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '12:00' }] })
    expect(promotionActiveAt(everyDay, TUE_10)).toBe(true)
    expect(promotionActiveAt(everyDay, SAT_10)).toBe(true)
  })

  it('周末整日窗口（真机第四条 weekdays:[6,7] 0–1440）', () => {
    const weekend = offPeakFixture({
      timezone: 'Asia/Shanghai',
      daily: [{ start: '00:00', end: '24:00', weekdays: [6, 7] }],
    })
    expect(promotionActiveAt(weekend, SAT_10)).toBe(true)
    expect(promotionActiveAt(weekend, TUE_10)).toBe(false)
  })

  it('weekdays 非法一律 fail-closed：空数组 / 越界 / 非整数都不成立，且不许退化成常驻', () => {
    const bad: Array<readonly unknown[]> = [[], [0], [8], [1.5], ['6'] as unknown as number[]]
    for (const days of bad) {
      const promotion = offPeakFixture({
        timezone: 'Asia/Shanghai',
        // 测试替身：直接塞非法值，走的是运行期闸门而不是解析期。
        daily: [{ start: '00:00', end: '12:00', weekdays: days as never }],
      })
      expect(promotionActiveAt(promotion, TUE_10), JSON.stringify(days) + ' 必须不成立').toBe(false)
      expect(promotionRunningAt(promotion, TUE_10)).toBe(false)
      // ⚠️ 常驻那道闸**不看**每日时段（取舍 4 之外它只受有效期约束），
      // 所以「读不懂的星期」绝不能靠 standing 漏出来：本家靠 standingEligible=false。
      expect(promotionStandingAt(promotion, TUE_10), 'standingEligible=false 必须挡住常驻').toBe(false)
    }
  })

  it('跨零点 + 星期：判定按**当前日历日**（周六 01:00 不算周五的夜窗）', () => {
    const FRI_23 = at('2026-11-20T15:00:00Z') // 23:00 Asia/Shanghai，周五
    // ⚠️ 这个时刻**曾经写错**：`2026-11-21T17:00:00Z` 是北京时间**周日** 01:00，
    // 而它的注释写「周六 01:00」。错在哪很关键 —— 周日 01:00 在「按当前日历日」
    // 与「按窗口开始那天」两种实现下**都是 false**，于是那条用例看似锁住了语义、
    // 实际两种实现都通过（PR #106 双审计独立发现，假绿）。
    const SAT_01 = at('2026-11-20T17:00:00Z') // 2026-11-21 01:00 Asia/Shanghai，周六
    const promotion = offPeakFixture({
      timezone: 'Asia/Shanghai',
      daily: [{ start: '22:00', end: '02:00', weekdays: [5] }],
    })
    expect(promotionActiveAt(promotion, FRI_23)).toBe(true)
    // 真机上游从不发这种组合（它把夜间拆成 0–480 与 1320–1440 两段），
    // 这里锁的是「万一发了，本仓取**保守侧**：不替上游把窗口延长到次日」。
    // 判据是**当前日历日**（= 周六），不是窗口开始那天（周五）——
    // 排程路径 `nextPromotionEdgeMs` 走的是「开始那天」，两条路径的措辞差异
    // 已在 README 与 docs §18 里写明，不假装一致。
    expect(promotionActiveAt(promotion, SAT_01)).toBe(false)
  })

  it('★ 跨零点 + 星期：把窗口挂到**当前日历日**（周六）才成立 —— 与上一条互为正对照', () => {
    // 这是那条假绿的补丁：只有「窗口星期 = 当前日历日」时两种实现才分叉
    // （按当前日 ⇒ true；按开始那天 ⇒ 前一日周五 ⇒ false）。上一条锁 false，
    // 这一条锁 true，两条一起才能固定「本仓按当前日历日」这个选择。
    const SAT_01 = at('2026-11-20T17:00:00Z') // 2026-11-21 01:00 Asia/Shanghai，周六
    const promotion = offPeakFixture({
      timezone: 'Asia/Shanghai',
      daily: [{ start: '22:00', end: '02:00', weekdays: [6] }],
    })
    expect(promotionActiveAt(promotion, SAT_01)).toBe(true)
  })
})

describe('nextPromotionEdgeMs：星期维度的排程', () => {
  it('单工作日窗口从周六起算必须跨到**下周五**（旧实现只扫 4 天 ⇒ 静默没有边界）', () => {
    const SAT_0030 = at('2026-11-21T16:30:00Z') // 周六 00:30 Asia/Shanghai
    const promotion = offPeakFixture({
      timezone: 'Asia/Shanghai',
      daily: [{ start: '18:00', end: '24:00', weekdays: [5] }],
    })
    const edge = nextPromotionEdgeMs([promotion], SAT_0030)
    expect(edge, '必须排出边界，否则「窗口关了徽标还在」只能等 20 分钟刷新').toBeDefined()
    // 下一个周五 = 2026-11-27，18:00 Asia/Shanghai = 10:00Z。
    expect(edge).toBe(at('2026-11-27T10:00:00Z'))
    // 这条同时把「搜索上界」钉住：改回 dayShift <= 3 本例立刻 undefined。
    expect((edge! - SAT_0030) / 86_400_000).toBeGreaterThan(4)
  })

  it('weekdays 全非法 ⇒ 没有边界（不许排一次「重算后什么都没变」的空播报）', () => {
    const promotion = offPeakFixture({
      timezone: 'Asia/Shanghai',
      daily: [{ start: '18:00', end: '24:00', weekdays: [] }],
    })
    expect(nextPromotionEdgeMs([promotion], at('2026-11-21T16:30:00Z'))).toBeUndefined()
  })

  it('end=24:00 的边界落在次日零点，但**星期归属今天**（周五窗口关在周六零点）', () => {
    const FRI_20 = at('2026-11-20T12:00:00Z') // 周五 20:00 Asia/Shanghai
    const promotion = offPeakFixture({
      timezone: 'Asia/Shanghai',
      daily: [{ start: '18:00', end: '24:00', weekdays: [5] }],
    })
    // 18:00 已过 ⇒ 下一个边界是**周五的** 24:00 = 2026-11-20T16:00Z（= 周六零点，
    // 但归属周五那条窗口）。若实现按「换算后时刻的星期」过滤，这里会跳到下周五，
    // 于是周六零点那一刻没人播报，周五夜窗的徽标多挂一个刷新周期。
    expect(nextPromotionEdgeMs([promotion], FRI_20)).toBe(at('2026-11-20T16:00:00Z'))
  })
})

describe('traePromotionCandidate：TRAE 闲时折扣 → 候选', () => {
  /** 真机原样（DeepSeek-V4-Flash）。 */
  const REAL = {
    beforeRate: 0.2,
    rate: 0.1,
    discountPercent: 50,
    subKey: 'off_peak_discount',
    windows: [
      { weekdays: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 480 },
      { weekdays: [1, 2, 3, 4, 5, 6, 7], startMinute: 1320, endMinute: 1440 },
    ],
  }

  it('当日分钟数换算成 HH:mm，1440 落成 24:00（合法的当日终点）', () => {
    const promotion = traePromotionCandidate(REAL, 'deepseek-v4-flash')
    expect(promotion).toBeDefined()
    expect(promotion!.schedule?.daily).toEqual([
      { start: '00:00', end: '08:00', weekdays: [1, 2, 3, 4, 5, 6, 7] },
      { start: '22:00', end: '24:00', weekdays: [1, 2, 3, 4, 5, 6, 7] },
    ])
    expect(promotion!.timeDeclared).toBe(true)
    // 取舍 4：窗口外什么都不画。
    expect(promotion!.standingEligible).toBe(false)
    expect(promotion!.modelIds).toEqual(['deepseek-v4-flash'])
  })

  it('此刻在窗口内才画；窗口外徽标整个消失（不是降饱和）', () => {
    const promotion = traePromotionCandidate(REAL, 'deepseek-v4-flash')!
    const INSIDE = at('2026-11-17T15:30:00Z')  // 周二 23:30 Asia/Shanghai
    const OUTSIDE = at('2026-11-17T02:00:00Z') // 周二 10:00 Asia/Shanghai
    expect(promotionBadgeFor([promotion], INSIDE)).toEqual({
      text: { en: 'Off-peak 50% off', zh: '闲时 5 折' },
      tone: 'neutral',
    })
    // ⚠️ 必须是 undefined 而不是 badge: undefined —— 宿主判的是 badge === void 0。
    expect(promotionBadgeFor([promotion], OUTSIDE)).toBeUndefined()
  })

  it('不是真降价就不产候选（真机未生效的 limited 形态正是 before === rate）', () => {
    expect(traePromotionCandidate({ ...REAL, rate: 0.2 }, 'm')).toBeUndefined()
    expect(traePromotionCandidate({ ...REAL, rate: 0.3 }, 'm')).toBeUndefined()
    expect(traePromotionCandidate({ ...REAL, beforeRate: 0 }, 'm')).toBeUndefined()
    expect(traePromotionCandidate(undefined, 'm')).toBeUndefined()
    expect(traePromotionCandidate(REAL, '')).toBeUndefined()
  })

  it('上游没给 time_zone ⇒ 用调用方兜底；给了就用上游的（两形态真机都有）', () => {
    const fallback = traePromotionCandidate(REAL, 'm', 'Asia/Shanghai')!
    expect(fallback.schedule?.timezone).toBe('Asia/Shanghai')
    const declared = traePromotionCandidate({ ...REAL, timeZone: 'Asia/Tokyo' }, 'm', 'Asia/Shanghai')!
    expect(declared.schedule?.timezone).toBe('Asia/Tokyo')
    // 兜底值不同会让同一份报文在「价格」与「徽标」上差 8 小时说话。
    const tokyoFallback = traePromotionCandidate(REAL, 'm', 'Asia/Tokyo')!
    expect(tokyoFallback.schedule?.timezone).toBe('Asia/Tokyo')
    // ⚠️ **不传**第三个参数也要落在 `Asia/Shanghai`：这条默认值与价格腿同源，
    // 而生产唯一调用点恰好显式传了它 ⇒ 上面三条都测不到默认值（正向审计 P3：
    // 默认参数零覆盖，改坏了没人知道）。以前只有显式传的用例，删掉默认值也全绿。
    expect(traePromotionCandidate(REAL, 'm')!.schedule?.timezone, '默认兜底必须与价格腿同值').toBe('Asia/Shanghai')
  })

  it('窗口声明了却全读不懂 ⇒ dailyUnusable + 恰一条日志 + 永不成立', () => {
    const warn = vi.fn()
    const promotion = traePromotionCandidate({
      beforeRate: 0.2, rate: 0.1, discountPercent: 50,
      windows: [
        { startMinute: 600, endMinute: 600 },   // 空区间
        { startMinute: 900, endMinute: 300 },   // 倒挂
        { startMinute: -1, endMinute: 300 },    // 越界
        { startMinute: 10.5, endMinute: 300 },  // 非整数
        { endMinute: 300 },                     // 缺起点
      ],
    }, 'deepseek-v4-flash', 'Asia/Shanghai', warn)
    expect(promotion).toBeDefined()
    expect(promotion!.schedule?.daily).toBeUndefined()
    expect(promotion!.schedule?.dailyUnusable).toBe(true)
    expect(promotion!.timeDeclared, '声明了时间就必须走「此刻」判定，不许退回任何快照').toBe(true)
    expect(promotionRunningAt(promotion!, at('2026-11-17T15:30:00Z'))).toBe(false)
    expect(promotionStandingAt(promotion!, at('2026-11-17T15:30:00Z'))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('只有窗口内**留下**的时段才算声明；全部缺席 = 全天活动而非读不懂', () => {
    const promotion = traePromotionCandidate({ beforeRate: 0.2, rate: 0.1, windows: [] }, 'm')!
    expect(promotion.schedule?.dailyUnusable).toBeUndefined()
    expect(promotion.schedule?.daily).toBeUndefined()
    // 没有时段 = 只要在有效期内就全天跑。
    expect(promotionRunningAt(promotion, at('2026-11-17T02:00:00Z'))).toBe(true)
  })

  it('文案：整十折算成「x 折」，换算不出就退回不带数字的那句（绝不四舍五入）', () => {
    const text = (discountPercent: number | undefined): string => {
      const promotion = traePromotionCandidate({ beforeRate: 0.2, rate: 0.1, ...discountPercent === undefined ? {} : { discountPercent } }, 'm')!
      const badge = promotionBadgeFor([promotion], at('2026-11-17T02:00:00Z'))!
      return typeof badge.text === 'string' ? badge.text : badge.text.zh
    }
    expect(text(50)).toBe('闲时 5 折')
    // ⚠️ 25 换算成「2.5 折」在算术上没错，但那是**上游没写过小数的措辞**被我们
    // 补成了小数 —— 本仓的红线方向是「宁可少说一个数字，不多说一个字」。
    // 真机 off_peak 只出现过 50（member 那批的 25 不产候选），故此规则今天零代价。
    expect(text(25)).toBe('闲时折扣')
    expect(text(33)).toBe('闲时折扣')   // 3.3 折是上游没说过的话
    expect(text(undefined)).toBe('闲时折扣')
    expect(text(0)).toBe('闲时折扣')    // 0% = 全免，不是「0 折」
    expect(text(100)).toBe('闲时折扣')  // 100% = 原价，压根不是折扣
  })

  it('★★ 上游声明了 time_windows 却一条都读不懂 ⇒ dailyUnusable，绝不退化成全天（正审 P1-1）', () => {
    // `readTraeOffPeakDiscount` 对非数组 / 元素读不出 `start_minute` 的行都产出
    // `windows: []`。只看留下的条数时它与「上游没给时段」同形 ⇒ 徽标 24/7 常亮，
    // 而「全天画折扣」正是本模块唯一禁止的夸大方向。`windowsDeclared` 就是那条分界。
    const warn = vi.fn()
    const promotion = traePromotionCandidate({
      beforeRate: 0.2, rate: 0.1, discountPercent: 50,
      windows: [],
      windowsDeclared: true,
    }, 'deepseek-v4-flash', 'Asia/Shanghai', warn)
    expect(promotion).toBeDefined()
    expect(promotion!.schedule?.daily).toBeUndefined()
    expect(promotion!.schedule?.dailyUnusable).toBe(true)
    expect(promotionRunningAt(promotion!, at('2026-11-17T02:00:00Z'))).toBe(false)
    expect(promotionStandingAt(promotion!, at('2026-11-17T02:00:00Z'))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)

    // 对照：没有这一位时同一份输入会退化成「全天」——这就是修之前的行为。
    const degenerate = traePromotionCandidate({
      beforeRate: 0.2, rate: 0.1, discountPercent: 50, windows: [],
    }, 'm')!
    expect(degenerate.schedule?.dailyUnusable).toBeUndefined()
    expect(promotionRunningAt(degenerate, at('2026-11-17T02:00:00Z')), '对照组：无标记 = 全天').toBe(true)
  })

  it('★ weekdays 声明了却一条都不合法 ⇒ 整条窗口丢掉（不许退化成「每天」）', () => {
    // 省略键的语义是「每天」，绝不能拿它兜住解析失败：上游若改用 0-based 星期
    // （`[0]` = 周日），会把「只在周日」静默放成「每天」。判定层
    // `withinDailyWindows` 对同一输入本来就有 fail-closed 分支，两层必须同向。
    const warn = vi.fn()
    const promotion = traePromotionCandidate({
      beforeRate: 0.2, rate: 0.1, discountPercent: 50,
      windows: [
        { startMinute: 1320, endMinute: 1440, weekdays: [0] },
        { startMinute: 1320, endMinute: 1440, weekdays: [8] },
        { startMinute: 1320, endMinute: 1440, weekdays: [1.5] },
        { startMinute: 1320, endMinute: 1440, weekdays: [] },
        { startMinute: 1320, endMinute: 1440, weekdays: ['6'] as unknown as number[] },
        { startMinute: 1320, endMinute: 1440, weekdays: '6' as unknown as number[] },
      ],
    }, 'deepseek-v4-flash', 'Asia/Shanghai', warn)
    expect(promotion!.schedule?.daily).toBeUndefined()
    expect(promotion!.schedule?.dailyUnusable, '六条全非法 ⇒ 与「声明了但读不懂」同档').toBe(true)
    // 周五 23:50 不许因为「退化成每天」而亮。
    expect(promotionRunningAt(promotion!, at('2026-11-20T15:50:00Z'))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('★★ discount 与 before/after 矛盾时退回不带数字的文案（只信 rate 那条腿）', () => {
    // 三个键本该同源（真机 32 条逐条吻合），但上游只改一半完全做得到。
    const text = (beforeRate: number, rate: number, discountPercent: number): string => {
      const promotion = traePromotionCandidate(
        { beforeRate, rate, discountPercent, windows: [{ startMinute: 0, endMinute: 1440 }] },
        'm',
      )!
      const badge = promotionBadgeFor([promotion], at('2026-11-17T02:00:00Z'))!
      return typeof badge.text === 'string' ? badge.text : badge.text.zh
    }
    // 真机三条：折数都能从 rate 复算出来 ⇒ 照上游给的数字画。
    expect(text(0.2, 0.1, 50)).toBe('闲时 5 折')
    expect(text(0.72, 0.36, 50)).toBe('闲时 5 折')
    expect(text(0.12, 0.06, 50)).toBe('闲时 5 折')
    // 矛盾：真实只降 25%，上游却说 50 ⇒ 不许画成 5 折。
    expect(text(0.2, 0.15, 50)).toBe('闲时折扣')
    // 矛盾：真实降 50%，上游说 90 ⇒ 同理。
    expect(text(0.2, 0.1, 90)).toBe('闲时折扣')
    // 四舍五入容差内照画（0.33→0.22 真实 33.3%，上游给 33）。
    expect(text(0.33, 0.22, 33)).toBe('闲时折扣') // 33 不是整十 ⇒ 本来就不带数字
    expect(text(0.33, 0.22, 10)).toBe('闲时折扣')
  })
})
