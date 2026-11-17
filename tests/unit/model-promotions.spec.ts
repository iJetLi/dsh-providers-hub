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
  qoderPromotionCandidate,
  selectPromotionAt,
  sortPromotions,
} from '../../src/model-promotions.js'
import { promotionActiveNow } from '../../src/qoder-adapter.js'
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
