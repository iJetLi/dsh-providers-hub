/**
 * Raccoon 计费活动 → 活动徽标（issue #101 的第五家，2026-11-18）。
 *
 * ## 这批用例问的两件事
 *
 * 1. **画什么**：`billing_status` 决定 chip 文案（限免中 / 限时折扣），倍率与说明
 *    来自上游字段 —— 文案逐字取自官方客户端 i18n（见 `src/model-promotions.ts`
 *    的 `raccoonPromotionCandidate` 模块注释，三处 asar 取证）。
 * 2. **什么时候必须消失**：`billing_discounts[]` 的 `start_at`/`end_at` 是**绝对窗口**，
 *    到点即不画；而「声明了却读不懂」必须 fail-closed，不能退化成「永久挂」——
 *    那正是 issue #101 点名的形态（活动结束而用户仍按优惠期选择）。
 *
 * ## fixture 全部来自真实报文（只读探测 2026-11-17 21:4x，`/api/web/llm/v2/model_catalog`）
 *
 *     { name: "sn-qwen4-max", description: "Qwen4-Max",
 *       billing_multiplier: 0.75, billing_effective_multiplier: 0.5,
 *       billing_status: "discount", billing_status_note: "限时折扣至11月22日",
 *       billing_discounts: [{ name: "限时折扣至11月22日", multiplier: 0.67, active: true,
 *                             start_at: "2026-11-15T16:00:00Z",
 *                             end_at: "2026-11-22T15:59:59Z" }] }
 *
 * ⚠️ 时钟一律显式传入，任何用例都不许依赖 `Date.now()`（否则会随墙上时间漂移）。
 */
import { describe, expect, it } from 'vitest'

import {
  promotionBadgeFor,
  raccoonPromotionCandidate,
  type RaccoonPromotionInput,
} from '../../src/model-promotions.js'
import { promotionTooltip } from '../../src/promotion-tooltip.js'
import { RaccoonAdapter } from '../../src/raccoon-adapter.js'
import { parseRaccoonModelCatalog } from '../../src/raccoon-auth.js'

/** 真实报文：折扣中的 Qwen4-Max（0.75 → 0.5，活动至 11月22日）。 */
const QWEN_RAW = {
  name: 'sn-qwen4-max',
  description: 'Qwen4-Max',
  visible: true,
  params: { context_window: 1_000_000, max_tokens: 100_000 },
  billing_multiplier: 0.75,
  billing_effective_multiplier: 0.5,
  billing_status: 'discount',
  billing_status_note: '限时折扣至11月22日',
  billing_discounts: [{
    name: '限时折扣至11月22日',
    multiplier: 0.67,
    active: true,
    start_at: '2026-11-15T16:00:00Z',
    end_at: '2026-11-22T15:59:59Z',
  }],
}

/** 真实报文：限免中的 SenseNova（0.5 → 0，限免到 11月30日）。 */
const SENSE_RAW = {
  name: 'sn-sensenova-6-8-flash',
  description: 'SenseNova-6.8-Flash',
  visible: true,
  params: { context_window: 256_000, max_tokens: 63_999 },
  billing_multiplier: 0.5,
  billing_effective_multiplier: 0,
  billing_status: 'limited_free',
  billing_status_note: '限免到11月30日',
  billing_discounts: [{
    name: '限免到11月30日',
    multiplier: 0,
    active: true,
    start_at: '2026-11-11T16:00:00Z',
    end_at: '2026-11-30T15:59:59Z',
  }],
}

/** 真实报文：普通计费的 GLM-5-3（`billing_discounts: []`）。 */
const GLM_RAW = {
  name: 'sn-glm-5-3',
  description: 'GLM-5-3',
  visible: true,
  params: { context_window: 1_000_000, max_tokens: 100_000 },
  billing_multiplier: 0.75,
  billing_effective_multiplier: 0.75,
  billing_status: 'normal',
  billing_status_note: '',
  billing_discounts: [],
}

/** 2026-11-18 08:00 Asia/Shanghai：两条活动都在窗口内的时刻。 */
const IN_WINDOW = Date.parse('2026-11-18T00:00:00Z')
/** 2026-11-23 08:00 Asia/Shanghai：Qwen4-Max 的活动已经结束。 */
const AFTER_QWEN = Date.parse('2026-11-23T00:00:00Z')
/** 2026-11-10 08:00 Asia/Shanghai：两条活动都还没开始。 */
const BEFORE_BOTH = Date.parse('2026-11-10T00:00:00Z')
/** 2026-11-19 08:00 Asia/Shanghai：位于「短活动已结束 / 长活动仍在跑」之间。 */
const BETWEEN_SHORT_AND_LONG = Date.parse('2026-11-19T00:00:00Z')
/** 把上游原文喂给真实解析层，取回这一条的 `promotion` 原料。 */
function promoOf(raw: Record<string, unknown>): RaccoonPromotionInput | undefined {
  const [model] = parseRaccoonModelCatalog({
    code: 0,
    data: { categories: [{ type: 'chat', models: [raw] }] },
  })
  return model?.promotion
}

/** 直接构造原料（不经解析层），用于钉住构造函数自己的边界。 */
function input(patch: Partial<RaccoonPromotionInput>): RaccoonPromotionInput {
  return { status: 'discount', baseMultiplier: 0.75, effectiveMultiplier: 0.5, ...patch }
}

describe('raccoonPromotionCandidate：画什么（判据逐字照抄官方客户端）', () => {
  it('★ discount ⇒ chip「限时折扣」，悬停是「原 X 倍，当前 Y 倍」（不是折扣比 0.67）', () => {
    const promotion = raccoonPromotionCandidate(promoOf(QWEN_RAW), 'sn-qwen4-max')
    expect(promotion).toBeDefined()
    expect(promotion?.badge.label).toBe('限时折扣')
    expect(promotion?.badge.labelEn).toBe('Limited-time discount')
    // ⚠️ 折后价只认 billing_effective_multiplier；multiplier 0.67 是**折扣比**，
    //    拿它当折后价会画成「当前 0.67 倍」（客户端也不显示它）。
    expect(promotion?.hover?.zh).toBe('原 0.75 倍，当前 0.5 倍')
    expect(promotion?.hover?.en).toBe('Was 0.75×, now 0.5×')
  })

  it('★ limited_free ⇒ chip「限免中」，悬停「原 0.5 倍，当前限免」', () => {
    const promotion = raccoonPromotionCandidate(promoOf(SENSE_RAW), 'sn-sensenova-6-8-flash')
    expect(promotion?.badge.label).toBe('限免中')
    expect(promotion?.badge.labelEn).toBe('Free for now')
    expect(promotion?.hover?.zh).toBe('原 0.5 倍，当前限免')
    expect(promotion?.hover?.en).toBe('Was 0.5×, now free for a limited time')
  })

  it('normal ⇒ 没有可画的活动（只有倍率，没有 chip）', () => {
    expect(raccoonPromotionCandidate(promoOf(GLM_RAW), 'sn-glm-5-3')).toBeUndefined()
    // 上游根本没发 billing_discounts 的条目：同样不画。
    expect(raccoonPromotionCandidate({ status: 'normal' }, 'sn-glm-5-3')).toBeUndefined()
  })

  it('没有原价时限免 ⇒ 退化成「当前限免」（客户端 originalLimitedFree 的 else 支）', () => {
    const promotion = raccoonPromotionCandidate(
      input({ status: 'limited_free', baseMultiplier: undefined, effectiveMultiplier: 0 }), 'm',
    )
    expect(promotion?.hover?.zh).toBe('当前限免')
    expect(promotion?.hover?.en).toBe('Free for a limited time')
  })

  it('没有 effective 时折扣的悬停退回上游整句说明；没有说明才退回「限时折扣」', () => {
    const withNote = raccoonPromotionCandidate(
      input({ effectiveMultiplier: undefined, statusNote: '限时折扣至11月22日' }), 'm',
    )
    expect(withNote?.hover?.zh).toBe('原 0.75 倍，限时折扣至11月22日')
    const noNote = raccoonPromotionCandidate(
      input({ effectiveMultiplier: undefined, statusNote: undefined }), 'm',
    )
    expect(noNote?.hover?.zh).toBe('原 0.75 倍，限时折扣')
  })

  it('倍率文案 = 客户端 aL（2 位小数去尾零）', () => {
    const promotion = raccoonPromotionCandidate(
      input({ baseMultiplier: 0.6666, effectiveMultiplier: 0.3333 }), 'm',
    )
    expect(promotion?.hover?.zh).toBe('原 0.67 倍，当前 0.33 倍')
    const one = raccoonPromotionCandidate(
      input({ baseMultiplier: 1, effectiveMultiplier: 0.5 }), 'm',
    )
    expect(one?.hover?.zh).toBe('原 1 倍，当前 0.5 倍')
  })

  it('上游不给颜色 ⇒ tone 落 neutral（不替上游发明 hex，与 lobsterai 同取舍）', () => {
    const promotion = raccoonPromotionCandidate(promoOf(QWEN_RAW), 'sn-qwen4-max')
    expect(promotionBadgeFor([promotion!], IN_WINDOW)?.tone).toBe('neutral')
  })

  it('modelId 非空才算（空串 ⇒ undefined，不造匿名候选）', () => {
    expect(raccoonPromotionCandidate(promoOf(QWEN_RAW), '')).toBeUndefined()
    expect(raccoonPromotionCandidate(undefined, 'm')).toBeUndefined()
  })
})

describe('raccoonPromotionCandidate：什么时候必须消失（绝对窗口）', () => {
  it('★ 活动期内画、结束后不画、开始前不画（同一份目录，三个时钟）', () => {
    const qwen = raccoonPromotionCandidate(promoOf(QWEN_RAW), 'sn-qwen4-max')
    expect(promotionBadgeFor([qwen!], IN_WINDOW)).toBeDefined()
    expect(promotionBadgeFor([qwen!], AFTER_QWEN)).toBeUndefined()
    expect(promotionBadgeFor([qwen!], BEFORE_BOTH)).toBeUndefined()
  })

  it('★ 窗口两端取自 billing_discounts（ISO-8601 UTC 带 Z），不是我们自己拼的', () => {
    const qwen = raccoonPromotionCandidate(promoOf(QWEN_RAW), 'sn-qwen4-max')
    expect(qwen?.schedule?.validFrom).toBe(Date.parse('2026-11-15T16:00:00Z'))
    expect(qwen?.schedule?.validUntil).toBe(Date.parse('2026-11-22T15:59:59Z'))
    expect(qwen?.timeDeclared).toBe(true)
  })

  it('★ 声明了日期却读不懂 ⇒ fail-closed（任何时刻都不画）+ 一条可诊断的 warn', () => {
    const warnings: string[] = []
    const bad = raccoonPromotionCandidate(
      input({
        discounts: [{ name: 'x', multiplier: 0.67, active: true, endAt: 'NEXT WEEK' }],
      }),
      'm',
      'Asia/Shanghai',
      (message) => warnings.push(message),
    )
    expect(bad).toBeDefined()
    // dailyUnusable ⇒ promotionWithinDailyWindow 恒 false ⇒ 永不成立。
    expect(bad?.schedule?.dailyUnusable).toBe(true)
    for (const now of [IN_WINDOW, AFTER_QWEN, BEFORE_BOTH]) {
      expect(promotionBadgeFor([bad!], now)).toBeUndefined()
    }
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('cannot be parsed')
  })

  it('★ 没有声明任何时间 ⇒ 退回 billing_status 快照（chip 仍然画）', () => {
    const snapshot = raccoonPromotionCandidate(
      input({ discounts: undefined }), 'm',
    )
    expect(snapshot?.timeDeclared).toBe(false)
    expect(snapshot?.schedule?.snapshotActive).toBe(true)
    // snapshotActive 是「上游说此刻在打折」⇒ 不依赖窗口中奖。
    expect(promotionBadgeFor([snapshot!], IN_WINDOW)).toBeDefined()
  })

  it('billing_discounts 是「空数组」= 没有活动，不是「读不懂」（不许 fail-closed）', () => {
    const promotion = raccoonPromotionCandidate(
      input({ discounts: [] }), 'm',
    )
    expect(promotion?.timeDeclared).toBe(false)
    expect(promotion?.schedule?.dailyUnusable).toBeUndefined()
    expect(promotionBadgeFor([promotion!], IN_WINDOW)).toBeDefined()
  })

  it('billing_discounts 类型漂移（非数组）⇒ chip 仍画（快照），但留一条 warn', () => {
    const warnings: string[] = []
    const promotion = raccoonPromotionCandidate(
      input({ discountsUnreadable: true }), 'm', 'Asia/Shanghai', (m) => warnings.push(m),
    )
    expect(promotionBadgeFor([promotion!], IN_WINDOW)).toBeDefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('not an array')
  })
})

describe('raccoonPromotionCandidate：每日时段', () => {
  const daily = input({
    discounts: [{
      name: '每日折扣', multiplier: 0.67, active: true,
      dailyStart: '09:00', dailyEnd: '22:00',
    }],
  })

  it('★ 两端齐 ⇒ 落 daily 窗口：窗口内画、窗口外不画', () => {
    const promotion = raccoonPromotionCandidate(daily, 'm')
    // 09:00 Asia/Shanghai = 01:00 UTC
    expect(promotionBadgeFor([promotion!], Date.parse('2026-11-18T01:00:00Z'))).toBeDefined()
    // 23:00 Asia/Shanghai = 15:00 UTC
    expect(promotionBadgeFor([promotion!], Date.parse('2026-11-18T15:00:00Z'))).toBeUndefined()
  })

  it('悬停把时区写进那句话（上游的 09:00 是 Asia/Shanghai 的 09:00）', () => {
    const promotion = raccoonPromotionCandidate(daily, 'm')
    expect(promotionTooltip(promotion!)).toContain('09:00–22:00 (Asia/Shanghai)')
  })

  it('只给一端 ⇒ 忽略时段（不拿半句话拼窗口）并留一条 warn', () => {
    const warnings: string[] = []
    const promotion = raccoonPromotionCandidate(
      input({ discounts: [{ name: 'x', multiplier: 0.67, dailyStart: '09:00' }] }),
      'm', 'Asia/Shanghai', (m) => warnings.push(m),
    )
    expect(promotion?.schedule?.daily).toBeUndefined()
    expect(promotion?.timeDeclared).toBe(false)
    expect(warnings[0]).toContain('only one side')
  })

  it('daily 两端都读不懂 ⇒ fail-closed（不是「全天」）', () => {
    const promotion = raccoonPromotionCandidate(
      input({ discounts: [{ name: 'x', multiplier: 0.67, dailyStart: '9点', dailyEnd: '晚上' }] }),
      'm',
    )
    expect(promotion?.schedule?.dailyUnusable).toBe(true)
    expect(promotionBadgeFor([promotion!], IN_WINDOW)).toBeUndefined()
  })
})

describe('raccoonPromotionCandidate：多条 discount 的取舍', () => {
  it('优先 active 且类型相符的那条（限免取 0 倍、折扣取 0<m<1）', () => {
    const promotion = raccoonPromotionCandidate(
      input({
        discounts: [
          { name: '未来的', multiplier: 0.5, active: false, endAt: '2026-12-01T00:00:00Z' },
          { name: '在跑的', multiplier: 0.67, active: true, endAt: '2026-11-22T15:59:59Z' },
        ],
      }),
      'm',
    )
    expect(promotion?.schedule?.validUntil).toBe(Date.parse('2026-11-22T15:59:59Z'))
  })
})

describe('parseRaccoonModelCatalog：原料归一（billing_discounts → camelCase）', () => {
  it('★ 只收「name 非空且 multiplier 是有限数」的条目（客户端逐字判据）', () => {
    const promotion = promoOf({
      ...QWEN_RAW,
      billing_discounts: [
        { name: '', multiplier: 0.5, active: true },
        { name: '缺倍率', active: true },
        { name: '好的', multiplier: 0.67, active: false, end_at: '2026-11-22T15:59:59Z' },
      ],
    })
    expect(promotion?.discounts).toHaveLength(1)
    expect(promotion?.discounts?.[0]).toEqual({
      name: '好的', multiplier: 0.67, active: false, endAt: '2026-11-22T15:59:59Z',
    })
  })

  it('空串日期视同缺失（客户端 text() = trim 后判空）', () => {
    const promotion = promoOf({
      ...QWEN_RAW,
      billing_discounts: [{ name: 'x', multiplier: 0.67, start_at: '  ', end_at: '' }],
    })
    expect(promotion?.discounts?.[0]?.startAt).toBeUndefined()
    expect(promotion?.discounts?.[0]?.endAt).toBeUndefined()
  })

  it('billing_discounts 不是数组 ⇒ discountsUnreadable（与「空数组」区分）', () => {
    expect(promoOf({ ...QWEN_RAW, billing_discounts: 'promo' })?.discountsUnreadable).toBe(true)
    expect(promoOf({ ...GLM_RAW, billing_discounts: [] })?.discounts).toEqual([])
  })
})

describe('RaccoonAdapter：徽标装配与悬停候选', () => {
  function makeAdapter(raws: unknown[], now: () => number, warn?: (m: string) => void): RaccoonAdapter {
    const models = parseRaccoonModelCatalog({
      code: 0,
      data: { categories: [{ type: 'chat', models: raws }] },
    })
    return new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => models,
      now,
      ...warn === undefined ? {} : { warn },
    })
  }

  it('★ listModels 的条目带 badge（装配时刻现算），且随注入时钟变', async () => {
    const before = await makeAdapter([QWEN_RAW], () => AFTER_QWEN).listModels('raccoon')
    expect(before.find((m) => m.id === 'sn-qwen4-max')?.badge).toBeUndefined()
    const during = await makeAdapter([QWEN_RAW], () => IN_WINDOW).listModels('raccoon')
    expect(during.find((m) => m.id === 'sn-qwen4-max')?.badge).toEqual({
      text: { en: 'Limited-time discount', zh: '限时折扣' },
      tone: 'neutral',
    })
  })

  it('★ 同一份目录：normal 的模型不带 badge（省略键，不是 undefined）', async () => {
    const models = await makeAdapter([QWEN_RAW, GLM_RAW], () => IN_WINDOW).listModels('raccoon')
    const glm = models.find((m) => m.id === 'sn-glm-5-3')
    expect(glm).toBeDefined()
    expect('badge' in (glm as object)).toBe(false)
  })

  it('★ promotionCandidates() 交出未决候选（悬停腿的原料），且只含有活动的模型', async () => {
    const adapter = makeAdapter([QWEN_RAW, SENSE_RAW, GLM_RAW], () => IN_WINDOW)
    await adapter.listModels('raccoon')
    const rows = adapter.promotionCandidates()
    expect(rows.map((row) => row.modelId).sort()).toEqual([
      'sn-qwen4-max', 'sn-sensenova-6-8-flash',
    ])
    // 交的是候选（含 schedule），不是挑好的徽标。
    expect(rows[0]?.promotion.schedule).toBeDefined()
  })

  it('离线（未拉到远端）时没有候选：兜底表是编译期快照、不带活动', () => {
    const adapter = new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => { throw new Error('offline') },
    })
    expect(adapter.promotionCandidates()).toEqual([])
  })

  it('★ 坏日期的 warn 按消息去重（每次 listModels × 每条模型都跑，不去重会刷屏）', async () => {
    const warnings: string[] = []
    const adapter = makeAdapter(
      [{ ...QWEN_RAW, billing_discounts: [{ name: 'x', multiplier: 0.67, end_at: 'NEXT WEEK' }] }],
      () => IN_WINDOW,
      (m) => warnings.push(m),
    )
    await adapter.listModels('raccoon')
    await adapter.listModels('raccoon')
    adapter.promotionCandidates()
    expect(warnings).toHaveLength(1)
  })
})

/**
 * 2026-11-18 审计补的两条**静默**缺口。
 *
 * 这两条的共同形态：**没有异常、没有红、没有日志**，只是「该有的 chip 不见了」
 * —— 与 issue #101 里最难查的那类（「徽标自己消失」）同形。故判据必须打在
 * 「有没有留下痕」上，而不是「有没有画」。
 */
describe('审计补漏：未知状态与「可解析但会误读」的时间戳', () => {
  it('★★ 未知 billing_status：不画 chip，但必须播一条诊断（否则上游加第四态 = 静默消失）', () => {
    const warnings: string[] = []
    const promotion = raccoonPromotionCandidate(
      { status: 'normal', statusUnknown: 'discount_trial', baseMultiplier: 0.75 },
      'sn-x',
      'Asia/Shanghai',
      (m) => warnings.push(m),
    )
    expect(promotion).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('discount_trial')
    // 反向对照：白名单状态**不许**播这条（否则每个模型一条噪声）。
    const clean: string[] = []
    raccoonPromotionCandidate(
      { status: 'normal', baseMultiplier: 0.75 }, 'sn-x', 'Asia/Shanghai', (m) => clean.push(m),
    )
    expect(clean).toEqual([])
  })

  it('★★ 没有时区指示符的时间戳必须**拒绝**，不能交给 Date.parse（本地时间会被读成 UTC）', () => {
    // ⚠️ 这一格是本条的全部意义：`Date.parse('2026-11-22T23:59:59')` 是**成功**的，
    //    在 UTC+8 机器上被读成 15:59:59Z —— 静默错 8 小时。判据必须断言「拒绝」。
    expect(Date.parse('2026-11-22T23:59:59')).not.toBeNaN()
    const warnings: string[] = []
    const promotion = raccoonPromotionCandidate(
      input({
        discounts: [{
          name: 'x', multiplier: 0.67, active: true,
          startAt: '2026-11-15T16:00:00', endAt: '2026-11-22T15:59:59',
        }],
      }),
      'sn-x', 'Asia/Shanghai', (m) => warnings.push(m),
    )
    expect(promotion?.schedule?.dailyUnusable).toBe(true)
    expect(promotion?.schedule?.validUntil).toBeUndefined()
    expect(promotionBadgeFor([promotion as never], IN_WINDOW)).toBeUndefined()
    expect(warnings.join('\n')).toContain('timezone designator')
  })

  it('★★ 只有日期的形态同样拒绝（`2026-11-22` = 当天 00:00Z，比「当天结束」差一天）', () => {
    const warnings: string[] = []
    const promotion = raccoonPromotionCandidate(
      input({ discounts: [{ name: 'x', multiplier: 0.67, active: true, endAt: '2026-11-22' }] }),
      'sn-x', 'Asia/Shanghai', (m) => warnings.push(m),
    )
    expect(promotion?.schedule?.dailyUnusable).toBe(true)
    expect(warnings).toHaveLength(1)
  })

  it('带偏移量的 ISO（`+08:00`）照常吃：严格判据只拒绝「没有时区」的形态', () => {
    const promotion = raccoonPromotionCandidate(
      input({
        discounts: [{
          name: 'x', multiplier: 0.67, active: true,
          startAt: '2026-11-16T00:00:00+08:00', endAt: '2026-11-22T23:59:59+08:00',
        }],
      }),
      'sn-x',
    )
    expect(promotion?.schedule?.validUntil).toBe(Date.parse('2026-11-22T23:59:59+08:00'))
    expect(promotion?.schedule?.dailyUnusable).toBeUndefined()
    expect(promotionBadgeFor([promotion as never], IN_WINDOW)).toBeDefined()
  })

  it('★★ 多条 active：取**结束得最晚**的那条（取早的那条会把还在跑的活动判成已结束）', () => {
    const promotion = raccoonPromotionCandidate(
      input({
        discounts: [
          { name: '旧', multiplier: 0.8, active: true, endAt: '2026-11-18T15:59:59Z' },
          { name: '新', multiplier: 0.67, active: true, endAt: '2026-12-01T15:59:59Z' },
        ],
      }),
      'sn-x',
    )
    expect(promotion?.schedule?.validUntil).toBe(Date.parse('2026-12-01T15:59:59Z'))
    // 反向对照：只留「旧」那一条时，同一时刻（11-18 之后）必须已经消失。
    const onlyOld = raccoonPromotionCandidate(
      input({
        discounts: [{ name: '旧', multiplier: 0.8, active: true, endAt: '2026-11-18T15:59:59Z' }],
      }),
      'sn-x',
    )
    const badgeOf = (p: typeof promotion) => (p === undefined ? undefined : [p])
    expect(promotionBadgeFor(badgeOf(onlyOld), BETWEEN_SHORT_AND_LONG)).toBeUndefined()
    expect(promotionBadgeFor(badgeOf(promotion), BETWEEN_SHORT_AND_LONG)).toBeDefined()
  })
})
