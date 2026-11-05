/**
 * CodeBuddy / WorkBuddy 的「按积分何时作废」分档（`src/buddy-balance-rank.ts`）。
 *
 * ## 本文件锁死什么
 *
 * 1. **15 天这条线**（用户 2026-09-29 定的判据）：距扣费截止 < 15 天算临时、
 *    ≥ 15 天算永久。边界必须钉住 —— 判错一天就会把「马上作废」的积分当永久
 *    供起来（结果白白过期），或反过来提前烧掉长期积分。
 * 2. **口径是 `remaining`（本计费周期剩余）**，不是终身剩余。实测 CodeBuddy
 *    体验版套餐终身剩 500 而本周期剩 0 —— 那 500 实际扣不到，算进可用余额会
 *    让账号「看起来有钱却用不了」。
 * 3. **失效包（`active: false`）不参与**。
 * 4. **到期时间未知归永久**（保守方向：宁可少用一个号，不可误烧长期积分）。
 * 5. **锁定永久积分**时只剩永久积分的账号 → `none`（不可用）。
 * 6. 档内保持传入顺序（= Jet Hub 拖拽的手动顺序）。
 */
import { describe, expect, it } from 'vitest'
import {
  BUDDY_BALANCE_TIER,
  BUDDY_EXPIRING_WINDOW_DAYS,
  BUDDY_EXPIRING_WINDOW_MS,
  buddyBalanceTier,
  buddyExpiringWindowDays,
  buddyExpiringWindowMs,
  buddyTierUsable,
  describeBuddyCreditSplit,
  rankBuddyAccountsByBalance,
  splitBuddyCreditsByExpiry,
} from '../../src/buddy-balance-rank.js'
import type { CreditBalance, CreditPackage } from '../../src/credits.js'

const DAY = 24 * 60 * 60 * 1000
/** 固定「当前时刻」，避免用例随真实时间漂移（也便于精确测边界）。 */
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)

/** 造一个资源包。默认「有效 + 本周期还有 100 + 30 天后到期」。 */
function pkg(overrides: Partial<CreditPackage> = {}): CreditPackage {
  return {
    name: 'Bonus Pack',
    unit: 'credits',
    remaining: 100,
    total: 100,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    deductionEndTime: NOW + 30 * DAY,
    ...overrides,
  }
}

function balance(...packages: CreditPackage[]): CreditBalance {
  return { total: 0, packages, expiredTotal: 0 }
}

describe('窗口常量', () => {
  it('15 天（用户定的判据）与毫秒换算一致', () => {
    expect(BUDDY_EXPIRING_WINDOW_DAYS).toBe(15)
    expect(BUDDY_EXPIRING_WINDOW_MS).toBe(15 * DAY)
  })
})

/**
 * 窗口的运行时解析（`DSH_BUDDY_EXPIRING_WINDOW_DAYS`）。
 *
 * ## 为什么需要这道逃生门（真实数据）
 *
 * 实测 2026-09-29：15 天这条线在两站效果差别极大 —— WorkBuddy 的 Bonus Pack
 * 是 8～9 天（锁定后 5 个号里 4 个仍可用），而 CodeBuddy 中国版的裂变包按 30 天
 * 发放、剩余密集落在 **17～30 天** ⇒ 整池都被判成永久，锁定后**立刻无可用账号**。
 * 判据没错，但那类池想用小窗口就必然踩空，故允许显式放宽（如 31）。
 */
describe('buddyExpiringWindowDays（环境变量覆盖）', () => {
  const KEY = 'DSH_BUDDY_EXPIRING_WINDOW_DAYS'

  it('未设置时用默认的 15 天', () => {
    expect(buddyExpiringWindowDays({})).toBe(15)
    expect(buddyExpiringWindowDays({ [KEY]: '' })).toBe(15)
    expect(buddyExpiringWindowDays({ [KEY]: '   ' })).toBe(15)
  })

  it('给出正数时生效（可放宽到 31 天）', () => {
    expect(buddyExpiringWindowDays({ [KEY]: '31' })).toBe(31)
    expect(buddyExpiringWindowDays({ [KEY]: ' 7 ' })).toBe(7)
    expect(buddyExpiringWindowDays({ [KEY]: '15.5' })).toBe(15.5)
  })

  /**
   * ⚠️ **0 必须被当作合法值**：它的语义是「没有临时积分」⇒ 锁定期间整池不可用。
   * 写成 `parseInt(raw) || 默认值` 会让 0 被静默换成 15（本仓库在 Qoder
   * 排队超时上踩过同一个坑）。
   */
  it('0 是合法值（不被默认值吞掉）', () => {
    expect(buddyExpiringWindowDays({ [KEY]: '0' })).toBe(0)
    expect(buddyExpiringWindowMs({ [KEY]: '0' })).toBe(0)
  })

  it('非法值回落默认（配置写错不能让插件起不来）', () => {
    for (const bad of ['abc', '-1', 'NaN', 'Infinity', '15d', '{}']) {
      expect(buddyExpiringWindowDays({ [KEY]: bad }), bad).toBe(15)
    }
  })

  it('毫秒换算与天数一致', () => {
    expect(buddyExpiringWindowMs({ [KEY]: '2' })).toBe(2 * DAY)
    expect(buddyExpiringWindowMs({})).toBe(BUDDY_EXPIRING_WINDOW_MS)
  })

  /** 端到端：窗口放宽后，原本算永久的包应改判临时。 */
  it('窗口可注入到拆分函数（31 天时 17 天的包算临时）', () => {
    const split = splitBuddyCreditsByExpiry(
      balance(pkg({ remaining: 100, deductionEndTime: NOW + 17 * DAY })),
      NOW,
      31 * DAY,
    )
    expect(split).toEqual({ expiring: 100, permanent: 0 })
  })
})

describe('splitBuddyCreditsByExpiry（按到期时间拆分两桶）', () => {
  it('距到期 14 天 → 临时桶', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({ deductionEndTime: NOW + 14 * DAY })), NOW)
    expect(split).toEqual({ expiring: 100, permanent: 0 })
  })

  it('距到期 9 天（实测 WorkBuddy Bonus Pack 的形状）→ 临时桶', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({
      name: 'Bonus Pack',
      deductionEndTime: NOW + 9 * DAY,
      remaining: 250,
    })), NOW)
    expect(split).toEqual({ expiring: 250, permanent: 0 })
  })

  it('距到期 3008 天（实测两站套餐的形状）→ 永久桶', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({
      name: 'Free Plan Subscription',
      deductionEndTime: NOW + 3008 * DAY,
      remaining: 100,
    })), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 100 })
  })

  /**
   * ⚠️ 边界：**恰好 15 天**算永久（判据是「不足 15 天才算临时」）。
   * 反向写（<=）会把「还有 15 天」的包归入临时 —— 实测中国版裂变包的到期分布
   * 正好密集落在 17～30 天，边界方向错一档就会让大量账号被误判成「有临时积分」。
   */
  it('恰好 15 天 → 永久桶（不足才叫临时）', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({ deductionEndTime: NOW + BUDDY_EXPIRING_WINDOW_MS })), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 100 })
  })

  it('差 1 毫秒满 15 天 → 临时桶', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({ deductionEndTime: NOW + BUDDY_EXPIRING_WINDOW_MS - 1 })), NOW)
    expect(split).toEqual({ expiring: 100, permanent: 0 })
  })

  it('同一账号的两类包分别入桶并累加', () => {
    const split = splitBuddyCreditsByExpiry(balance(
      pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY }),
      pkg({ name: '裂变包', remaining: 100, deductionEndTime: NOW + 17 * DAY }),
      pkg({ name: '裂变包', remaining: 300, deductionEndTime: NOW + 208 * DAY }),
    ), NOW)
    expect(split).toEqual({ expiring: 250, permanent: 400 })
  })

  it('本周期口径：只算 remaining，不算终身余额', () => {
    // 实测 CodeBuddy 体验版：remaining(本周期)=0 而 CapacityRemain(终身)=500
    const split = splitBuddyCreditsByExpiry(balance(pkg({
      name: 'CodeBuddy个人体验版',
      remaining: 0,
      total: 500,
      deductionEndTime: NOW + 3008 * DAY,
    })), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 0 })
  })

  it('失效包（active: false）不参与，即使还剩余额', () => {
    const split = splitBuddyCreditsByExpiry(balance(
      pkg({ active: false, remaining: 999, deductionEndTime: NOW + 3 * DAY }),
      pkg({ remaining: 100, deductionEndTime: NOW + 20 * DAY }),
    ), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 100 })
  })

  /**
   * ⚠️ 到期时间缺失 / 非法 → 归**永久**桶（保守）。
   * 反过来归临时会让「服务端没给到期时间」的包在锁定期间被消耗掉 ——
   * 而它可能是不会作废的长期积分，属于不可逆损失。
   */
  it('到期时间未知归永久桶', () => {
    const split = splitBuddyCreditsByExpiry(balance(
      pkg({ deductionEndTime: undefined }),
      pkg({ deductionEndTime: 0 }),
      pkg({ deductionEndTime: Number.NaN }),
    ), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 300 })
  })

  /**
   * ⚠️ **2026-11-02 改（PR #168 对抗审计 B1）**：原先断言它进 `expiring`（临时桶）。
   * 那会让 `buddyBalanceTier` 判「可用」、聚合把它排第一先烧，而那 100 **扣不到**
   * （请求必失败）。现在单列 `expired`、`expiring` 归零 ⇒ 档位 `none`。
   */
  it('已经过期（扣费截止在过去）但服务端仍说有效的包 → **expired 桶，不算可用**', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({ deductionEndTime: NOW - DAY })), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 0, expired: 100 })
    // ⚠️ 档位用常量比，别写字面量：none 的**数值**是 2，写成 'none' 会假红。
    expect(buddyBalanceTier({ expiringBalance: split.expiring, permanentBalance: split.permanent }, { allowPermanent: false })).toBe(BUDDY_BALANCE_TIER.none)
  })

  /**
   * ⚠️ 拆分结果**不做规整**（服务端精确值带浮点尾数，如 `74.61000076`）：
   * 分档只比较大小，规整只会引入误差；要给人看时才 round
   * （见 `describeBuddyCreditSplit`）。这里断言「累加到 200」用近似口径。
   */
  it('小数累加保留原始精度（不在拆分时规整）', () => {
    const split = splitBuddyCreditsByExpiry(balance(
      pkg({ remaining: 74.61000076, deductionEndTime: NOW + 9 * DAY }),
      pkg({ remaining: 125.39, deductionEndTime: NOW + 10 * DAY }),
    ), NOW)
    expect(split!.expiring).toBeCloseTo(200, 5)
    expect(split!.permanent).toBe(0)
    // 展示层才规整到两位小数
    expect(describeBuddyCreditSplit(split)).toBe('15 天内到期 200 · 永久 0')
  })

  it('脏余额（负数 / NaN）不计入', () => {
    const split = splitBuddyCreditsByExpiry(balance(
      pkg({ remaining: -5 }),
      pkg({ remaining: Number.NaN }),
      pkg({ remaining: 10 }),
    ), NOW)
    expect(split).toEqual({ expiring: 0, permanent: 10 })
  })

  it('null / undefined（余额查询失败）返回 undefined，与「两桶都为 0」严格区分', () => {
    expect(splitBuddyCreditsByExpiry(null, NOW)).toBeUndefined()
    expect(splitBuddyCreditsByExpiry(undefined, NOW)).toBeUndefined()
    // 空包列表是「真的没钱」，不是「查不到」
    expect(splitBuddyCreditsByExpiry(balance(), NOW)).toEqual({ expiring: 0, permanent: 0 })
  })

  it('窗口可覆盖（单测与未来调整用）', () => {
    const split = splitBuddyCreditsByExpiry(balance(pkg({ deductionEndTime: NOW + 20 * DAY })), NOW, 30 * DAY)
    expect(split).toEqual({ expiring: 100, permanent: 0 })
  })

  /**
   * ★★ **`deductionEndTime` 是「数字字符串」时必须与前端同判**
   * （2026-10-21 对抗性审计发现，P2：全仓唯一一处真正的「同一语义两套判据」）。
   *
   * ## 两侧原来不同判
   *
   * | 输入 | 前端 `splitCreditsByExpiry` | 后端（旧） |
   * |---|---|---|
   * | `1760432000000`（number） | 临期 | 临期 |
   * | `"1760432000000"`（字符串） | **临期**（用 `Number()`） | **永久**（用 `typeof`）|
   *
   * ⇒ 用户可见症状正是本仓库反复要防的：**面板说「临期 100」，而锁定永久积分时
   *   选号判 `none`、报「积分已用尽」**。
   *
   * ## 可达性（如实标注：低但非零）
   *
   * 三个 PR 新接的 provider 全部经 `Number()` / `Date.parse` 归一化后才写该字段，
   * **生产主路径不可达**。可达的是外部写进 `credits.balances` 的数据
   *（旧缓存 / 备份导入 / 手工编辑 state.json）。
   */
  it('★★ 数字字符串形态的 deductionEndTime 与前端同判（临期）', () => {
    const split = splitBuddyCreditsByExpiry(
      balance(pkg({ deductionEndTime: String(NOW + 3 * DAY) as unknown as number })),
      NOW,
    )
    expect(split, '字符串毫秒必须被认成「有确切到期时刻」⇒ 临期').toEqual({ expiring: 100, permanent: 0 })
  })

  it('★ 反向对照：null / 空串 / 非数字串仍判「未知到期」（不得被 Number() 宽松成时刻 0）', () => {
    for (const bad of [null, '', 'abc', ' ', undefined]) {
      const split = splitBuddyCreditsByExpiry(
        balance(pkg({ deductionEndTime: bad as unknown as number })),
        NOW,
      )
      expect(split, `${String(bad)} 必须判未知到期 ⇒ 永久桶`).toEqual({ expiring: 0, permanent: 100 })
    }
  })

  /**
   * ★★ **`Number()` 的两格意外翻转必须挡住**（2026-10-21 二轮审计自查发现）。
   *
   * ## 缺陷
   *
   * 我把判据从 `typeof === 'number'` 改成 `Number()` 时，只想到了
   * 「数字字符串」那种**合法**输入翻成「已知」（那是**有意变更**），
   * 却漏了 `Number()` 的两格**类型污染**：
   *
   * | 输入 | `Number(x)` | 旧 `typeof` | 只写 `Number()` 时 | 后果 |
   * |---|---|---|---|---|
   * | `true` | **1** | 未知 ⇒ 永久桶 | **已知 ⇒ 时刻 1ms（1970）** | 误判「早已过期」⇒ 进 `expiring` 桶 |
   * | `[1760432000000]` | **1760432000000** | 未知 ⇒ 永久桶 | **已知** | 单元素数组被当成数字 |
   *
   * 两格的共同方向是「把**非数字**放宽成已知」—— 与「认数字字符串」不同源。
   * ⇒ 判据收窄为「**只接受 number 或 string**」。
   *
   * ⚠️ 这条用例的存在理由：**我第一版就漏了这两格**，而且是逐格对比新旧才发现的
   *    （不是靠跑测试 —— 当时 40 条全绿）。
   */
  it('★★ true / 数组 / 对象 不得被 Number() 放宽成「已知到期」', () => {
    const contaminations: Array<[string, unknown]> = [
      ['true（Number(true)===1 ⇒ 1970）', true],
      ['false', false],
      ['单元素数组（Number([ms])===ms）', [NOW + 3 * DAY]],
      ['空数组', []],
      ['空对象', {}],
    ]
    for (const [label, bad] of contaminations) {
      const split = splitBuddyCreditsByExpiry(
        balance(pkg({ deductionEndTime: bad as unknown as number })),
        NOW,
      )
      expect(
        split,
        `${label} 必须判未知到期 ⇒ 永久桶（不得被 Number() 放宽成已知）`,
      ).toEqual({ expiring: 0, permanent: 100 })
    }
  })

  /**
   * ★★ **`packages` 里含 `null` / `undefined` 元素时不得抛错**
   * （2026-10-21 对抗性审计发现，P2：与前端判据不对称）。
   *
   * 前端 `splitCreditsByExpiry` 第一句就是 `if (!pkg || pkg.active !== true) continue`，
   * 而后端原来直接读 `pkg.active` ⇒ `packages: [null]` 抛**裸 TypeError**
   *（`Cannot read properties of null (reading 'active')`）。
   *
   * 后果不是「无可用账号」那句文案，而是未捕获异常穿出 `select()`
   *（`BuddyBalanceSelector.select` 无 try/catch）⇒ 用户看到内部错误，
   * 而池里可能还有别的健康账号。
   *
   * 可达性：各 provider 目前都在 push 前过滤非对象条目 ⇒ **当前不可达**；
   * 但这是防御缺口且与前端不对称，故补齐。
   */
  it('★★ packages 含 null / undefined 元素时不抛错（与前端同判：跳过）', () => {
    // ⚠️ 断言「剩下那个包被正常计入」而不是「合计 100」：`pkg()` 默认**不带**
    //    `deductionEndTime` ⇒ 它落**永久桶**（50），这才是正确结果。
    //    （第一版我把期望写成 `expiring:100` 是错的 —— 那是把它当成临期了。）
    const withNull = { packages: [null as never, pkg({ remaining: 50 })] } as never
    expect(() => splitBuddyCreditsByExpiry(withNull, NOW)).not.toThrow()
    expect(
      splitBuddyCreditsByExpiry(withNull, NOW),
      'null 元素被跳过，剩下的包（无到期时间）应落永久桶',
    ).toEqual({ expiring: 0, permanent: 50 })
    expect(splitBuddyCreditsByExpiry({ packages: [undefined as never] } as never, NOW))
      .toEqual({ expiring: 0, permanent: 0 })
  })
})

describe('buddyBalanceTier（档位判定）', () => {
  it('有临时积分 → expiring（优先），即使同时有大量永久积分', () => {
    expect(buddyBalanceTier({ expiringBalance: 1, permanentBalance: 99999 }))
      .toBe(BUDDY_BALANCE_TIER.expiring)
  })

  it('只剩永久积分（未锁定）→ permanent', () => {
    expect(buddyBalanceTier({ expiringBalance: 0, permanentBalance: 100 }))
      .toBe(BUDDY_BALANCE_TIER.permanent)
  })

  it('两桶都为 0 → none', () => {
    expect(buddyBalanceTier({ expiringBalance: 0, permanentBalance: 0 }))
      .toBe(BUDDY_BALANCE_TIER.none)
  })

  it('查询失败（字段 undefined）→ none', () => {
    expect(buddyBalanceTier({})).toBe(BUDDY_BALANCE_TIER.none)
  })
})

/**
 * ⚠️ **锁定永久积分**（用户需求：CodeBuddy 与 WorkBuddy 各加一个开关）。
 *
 * 锁定后**只允许消耗会近期作废的积分**，永久积分不参与选号 ——
 * 只剩永久积分的账号在锁定期间**等同于不可用**。
 *
 * 用户原话（与 Loomy 那次相同）：「锁定永久积分后没有临时积分后找可用账号就是
 * 没有可用账号，解锁以后才能再没有临时积分的时候找到有永久积分的账号」。
 */
describe('锁定永久积分（allowPermanent: false）', () => {
  it('只剩永久积分（含 30 天后到期的包）→ 不可用', () => {
    expect(buddyBalanceTier(
      { expiringBalance: 0, permanentBalance: 5000 },
      { allowPermanent: false },
    )).toBe(BUDDY_BALANCE_TIER.none)
  })

  it('有临时积分的账号不受锁定影响', () => {
    expect(buddyBalanceTier(
      { expiringBalance: 250, permanentBalance: 0 },
      { allowPermanent: false },
    )).toBe(BUDDY_BALANCE_TIER.expiring)
  })

  it('allowPermanent 缺省为 true（不改变既有行为）', () => {
    expect(buddyBalanceTier({ expiringBalance: 0, permanentBalance: 100 }))
      .toBe(BUDDY_BALANCE_TIER.permanent)
  })

  it('none 档不可用，其余可用', () => {
    expect(buddyTierUsable(BUDDY_BALANCE_TIER.none)).toBe(false)
    expect(buddyTierUsable(BUDDY_BALANCE_TIER.expiring)).toBe(true)
    expect(buddyTierUsable(BUDDY_BALANCE_TIER.permanent)).toBe(true)
  })
})

describe('rankBuddyAccountsByBalance（稳定分档排序）', () => {
  it('临时积分的号排在只剩永久的号之前', () => {
    const ranked = rankBuddyAccountsByBalance([
      { id: 'a', expiringBalance: 0, permanentBalance: 100 },
      { id: 'b', expiringBalance: 250, permanentBalance: 0 },
    ])
    expect(ranked.map(a => a.id)).toEqual(['b', 'a'])
  })

  it('档内保持传入顺序（= 用户手动拖拽的顺序，不重排）', () => {
    const ranked = rankBuddyAccountsByBalance([
      { id: 'a', expiringBalance: 10, permanentBalance: 0 },
      { id: 'b', expiringBalance: 999, permanentBalance: 0 },
      { id: 'c', expiringBalance: 5, permanentBalance: 0 },
    ])
    expect(ranked.map(a => a.id)).toEqual(['a', 'b', 'c'])
  })

  it('查询失败的号排最后（宁可发给能确认余额的号）', () => {
    const ranked = rankBuddyAccountsByBalance([
      { id: 'broken' },
      { id: 'ok', expiringBalance: 1 },
      { id: 'permanent', permanentBalance: 100 },
    ])
    expect(ranked.map(a => a.id)).toEqual(['ok', 'permanent', 'broken'])
  })

  it('锁定时把只剩永久积分的号降到最后一档', () => {
    const ranked = rankBuddyAccountsByBalance([
      { id: 'permanent-only', expiringBalance: 0, permanentBalance: 100 },
      { id: 'has-expiring', expiringBalance: 100, permanentBalance: 0 },
      { id: 'nothing' },
    ], { allowPermanent: false })
    expect(ranked.map(a => a.id)).toEqual(['has-expiring', 'permanent-only', 'nothing'])
    // 首位可用、其余不可用 —— 选号器据此判定「有没有可用账号」
    expect(buddyTierUsable(buddyBalanceTier(ranked[0]!, { allowPermanent: false }))).toBe(true)
    expect(buddyTierUsable(buddyBalanceTier(ranked[1]!, { allowPermanent: false }))).toBe(false)
  })

  it('不修改入参数组', () => {
    const input = [
      { id: 'a', expiringBalance: 0, permanentBalance: 1 },
      { id: 'b', expiringBalance: 1, permanentBalance: 0 },
    ]
    const ranked = rankBuddyAccountsByBalance(input)
    expect(ranked).not.toBe(input)
    expect(input.map(a => a.id)).toEqual(['a', 'b'])
  })
})

describe('describeBuddyCreditSplit（展示文案）', () => {
  it('两桶都给出，并带上窗口天数', () => {
    expect(describeBuddyCreditSplit({ expiring: 250, permanent: 100.5 }))
      .toBe('15 天内到期 250 · 永久 100.5')
  })

  it('都为 0 时说「无可用积分」而不是两个 0', () => {
    expect(describeBuddyCreditSplit({ expiring: 0, permanent: 0 })).toBe('无可用积分')
  })

  it('查询失败说清楚', () => {
    expect(describeBuddyCreditSplit(undefined)).toBe('余额查询失败')
  })
})
