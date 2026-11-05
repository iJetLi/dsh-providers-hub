import { describe, expect, it } from 'vitest'
import {
  BADGE_PREFERENCE_LABELS,
  BADGE_PREFERENCES,
  BADGE_SEP,
  DEFAULT_BADGE_PREFERENCE,
  HOST_STALE_HINT,
  badgeView,
  creditGroupsOf,
  creditSectionLabel,
  describeBadgeError,
  formatUpdatedAt,
  normalizeBadgePreference,
  orderCreditRows,
  planGroupsOf,
  windowPreview,
} from '../../plugin-src/client/badge-model.js'
// 宿主侧的同一份枚举：两边必须逐字一致（`usage.badgePreference` 会拒绝非法值）
import { BADGE_PREFERENCES as HOST_BADGE_PREFERENCES } from '../../src/badge-preferences.js'
import { formatUnits, formatQuotaLine, unitLabel, QUOTA_UNIT } from '../../plugin-src/client/credits-format.js'

/**
 * 用量徽标**折叠态**的纯逻辑回归（不依赖 react，故可直接 import 真实现）。
 *
 * 锁的是「用户定的口径」本身：**窗口 > 套餐包 > 积分**（2026-10-01 定），
 * 以及三态偏好对它的影响。每一条文案断言都是完整字符串 —— 徽标上就是这一行
 * 字，改口径必然改文案，用例会红。
 */

/** 构造余额行。 */
function row(accountId, packages, error) {
  const balance = packages === null
    ? null
    : { total: packages.reduce((sum, item) => sum + item.remaining, 0), packages, expiredTotal: 0 }
  return { accountId, nickname: accountId, balance, ...error === undefined ? {} : { error } }
}

/** 构造资源包。 */
function pkg(name, remaining, unit = 'credits') {
  return { name, unit, remaining, total: remaining, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '' }
}

describe('偏好枚举与宿主同步', () => {
  it('三态取值与宿主完全一致', () => {
    expect([...BADGE_PREFERENCES]).toEqual([...HOST_BADGE_PREFERENCES])
    expect(DEFAULT_BADGE_PREFERENCE).toBe('auto')
  })

  it('每个档位都有中文展示名（弹窗里的三态开关）', () => {
    for (const value of BADGE_PREFERENCES) {
      expect(typeof BADGE_PREFERENCE_LABELS[value], value).toBe('string')
      expect(BADGE_PREFERENCE_LABELS[value].length).toBeGreaterThan(0)
    }
  })

  it('归一化：未知值 / 大小写变体 / 非字符串一律回落到默认', () => {
    expect(normalizeBadgePreference('credits')).toBe('credits')
    expect(normalizeBadgePreference('Credits')).toBe('auto')
    expect(normalizeBadgePreference(undefined)).toBe('auto')
    expect(normalizeBadgePreference(null)).toBe('auto')
    expect(normalizeBadgePreference(1)).toBe('auto')
  })
})

describe('窗口预览', () => {
  it('只取前两个，且已知窗口按固定顺序（five_hour → weekly → monthly）', () => {
    expect(windowPreview([
      { type: 'monthly', percentUsed: 48 },
      { type: 'weekly', percentUsed: 2 },
      { type: 'five_hour', percentUsed: 6 },
    ])).toEqual([
      { type: 'five_hour', label: '5 小时', percent: 6 },
      { type: 'weekly', label: '本周', percent: 2 },
    ])
  })

  it('缺失的已知窗口顺延给未知窗口（网关新增窗口也能显示）', () => {
    expect(windowPreview([
      { type: 'weekly', percentUsed: 10 },
      { type: 'daily', percentUsed: 3 },
    ])).toEqual([
      { type: 'weekly', label: '本周', percent: 10 },
      { type: 'daily', label: 'daily', percent: 3 },
    ])
  })

  it('百分比夹取到 0–100（网关下发 120 / -5 都不该画到条外）', () => {
    expect(windowPreview([{ type: 'five_hour', percentUsed: 120 }])[0].percent).toBe(100)
    expect(windowPreview([{ type: 'five_hour', percentUsed: -5 }])[0].percent).toBe(0)
    expect(windowPreview([{ type: 'five_hour', percentUsed: 'abc' }])[0].percent).toBe(0)
  })

  it('非数组输入不炸（脏数据兜底）', () => {
    expect(windowPreview(undefined)).toEqual([])
    expect(windowPreview(null)).toEqual([])
  })
})

describe('积分的按单位分组', () => {
  it('单账号：合计即该账号余额', () => {
    const groups = creditGroupsOf([row('a', [pkg('Bonus Pack', 100), pkg('Free Plan', 96.87)])])
    expect(groups.groups).toEqual([{ unit: 'credit', label: '积分', total: 196.87, accountCount: 1 }])
    expect(groups.failedCount).toBe(0)
    expect(groups.okCount).toBe(1)
  })

  it('多账号：按单位求和，**绝不跨单位相加**', () => {
    const groups = creditGroupsOf([
      row('a', [pkg('Bonus Pack', 100)]),
      row('b', [pkg('Bonus Pack', 50)]),
      row('c', [pkg('GLM-5.2', 94_539_275, 'token')]),
    ])
    expect(groups.groups).toEqual([
      { unit: 'credit', label: '积分', total: 150, accountCount: 2 },
      { unit: 'token', label: 'Token', total: 94_539_275, accountCount: 1 },
    ])
  })

  it('失败的账号不进合计，只计入 failedCount（0 与「查不到」必须分开）', () => {
    const groups = creditGroupsOf([row('a', [pkg('Bonus Pack', 10)]), row('b', null, '凭据未配置')])
    expect(groups.groups[0].total).toBe(10)
    expect(groups.failedCount).toBe(1)
    expect(groups.okCount).toBe(1)
  })

  it('一个包都没有时按空单位分组（显示为「积分」）', () => {
    const groups = creditGroupsOf([{ accountId: 'a', nickname: 'a', balance: { total: 5, packages: [], expiredTotal: 0 } }])
    expect(groups.groups).toEqual([{ unit: 'credit', label: '积分', total: 5, accountCount: 1 }])
  })

  /**
   * ⚠️ 真实缺陷回归（2026-10-03，用户报障：胶囊显示 `341.78积分 · 100积分`）。
   *
   * 服务端对**同一个单位**有两种拼法，逐包实测（`probe-workbuddy-units.mjs`）：
   * 账号 `…01CC739A` 的包是 `credit`（Bonus Pack 241.78）+ `credits`
   * （Free Plan Subscription 100），账号 `…297957E1` 的是 `credits`。
   * 按原值分组会把两个账号拆成两组，渲染出两个一模一样的「积分」标签。
   *
   * 下面这组用例就是那两个账号的**原样形状**：断言「几个账号都只产生一个数字」。
   */
  it('同义异拼（credit / credits / 空串）必须落进同一组 —— 两个账号一个合计', () => {
    const groups = creditGroupsOf([
      { accountId: 'a', nickname: 'a', balance: { total: 341.78, packages: [pkg('Bonus Pack', 241.78, 'credit'), pkg('Free Plan Subscription', 100, 'credits')], expiredTotal: 0 } },
      { accountId: 'b', nickname: 'b', balance: { total: 100, packages: [pkg('Free Plan Subscription', 100, 'credits')], expiredTotal: 0 } },
    ])
    expect(groups.groups).toEqual([{ unit: 'credit', label: '积分', total: 441.78, accountCount: 2 }])
  })

  /** 折叠态整句：这才是用户实际看到的那一行（分组对了文案才可能对）。 */
  it('WorkBuddy 国际版两个账号 → 只显示一个合计（不再并排两个「积分」）', () => {
    const accounts = [
      { accountId: 'a', nickname: 'a', balance: { total: 341.78, packages: [pkg('Bonus Pack', 241.78, 'credit')], expiredTotal: 0 } },
      { accountId: 'b', nickname: 'b', balance: { total: 100, packages: [pkg('Free Plan Subscription', 100, 'credits')], expiredTotal: 0 } },
    ]
    const view = badgeView({ providerLabel: 'WorkBuddy (国际版)', preference: 'auto', subscription: undefined, accounts })
    expect(view.text).toBe('WorkBuddy (国际版) • 441.78积分')
    // 保护性断言：文案里「积分」只出现一次（旧缺陷的形态是两个）
    expect(view.reading.split('积分')).toHaveLength(2)
  })

  it('账号数再多也只产生一个数字（5–6 个号不会拉成长串）', () => {
    const units = ['credit', 'credits', '', 'Credit', 'CREDITS']
    const accounts = units.map((unit, i) => ({
      accountId: `a${i}`, nickname: `a${i}`,
      balance: { total: 100, packages: [pkg('Bonus Pack', 100, unit)], expiredTotal: 0 },
    }))
    const view = badgeView({ providerLabel: 'WorkBuddy (国际版)', preference: 'auto', subscription: undefined, accounts })
    expect(view.text).toBe('WorkBuddy (国际版) • 500积分')
  })

  it('token 与积分**仍然分开**（归一化只收敛同义拼法，不跨量纲求和）', () => {
    const view = badgeView({
      providerLabel: 'ZCode',
      preference: 'auto',
      subscription: undefined,
      accounts: [row('a', [pkg('GLM-5.2', 94_539_275, 'token')]), row('b', [pkg('Bonus Pack', 100, 'credits')])],
    })
    // 分组按单位名排序（credit < token），故积分在前
    expect(view.text).toBe('ZCode • 100积分 · 94.54MToken')
  })
})

describe('套餐的归组', () => {
  it('按（包名 + 单位）求和，给出账号数与最早到期时刻', () => {
    const groups = planGroupsOf([
      { accountId: 'a', plan: { name: 'Free Plan Subscription', remaining: 100, total: 200, unit: 'credits', deductionEndTime: 900 } },
      { accountId: 'b', plan: { name: 'Free Plan Subscription', remaining: 300, total: 300, unit: 'credits', deductionEndTime: 500 } },
      { accountId: 'c', plan: { name: 'Bonus Plan', remaining: 50, total: 50, unit: 'credits' } },
    ])
    expect(groups[0]).toMatchObject({ name: 'Free Plan Subscription', remaining: 400, total: 500, accountCount: 2, deductionEndTime: 500 })
    // 排序按剩余降序 ⇒ 折叠态取第一条就是「最大的那份套餐」
    expect(groups.map((group) => group.name)).toEqual(['Free Plan Subscription', 'Bonus Plan'])
  })

  it('plan 为 null 的账号被跳过；单位不同不合并', () => {
    const groups = planGroupsOf([
      { accountId: 'a', plan: null },
      { accountId: 'b', plan: { name: '套餐', remaining: 1, total: 2, unit: 'token' } },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].unit).toBe('token')
    expect(groups[0].label).toBe('Token')
  })

  /**
   * ⚠️ 与 `creditGroupsOf` 同款缺陷的另一处：分组键里也含单位。
   * 同一份套餐在不同账号上被服务端拼成 `credit` / `credits` 时，若用原值当键，
   * 弹窗里的「2 个账号合计」会退化成两行、每行各一个账号。
   */
  it('同一份套餐的单位拼法不同（credit / credits）必须合并成一条', () => {
    const groups = planGroupsOf([
      { accountId: 'a', plan: { name: 'Free Plan Subscription', remaining: 100, total: 500, unit: 'credits' } },
      { accountId: 'b', plan: { name: 'Free Plan Subscription', remaining: 300, total: 500, unit: 'credit' } },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ name: 'Free Plan Subscription', remaining: 400, total: 1000, accountCount: 2, unit: 'credit' })
  })
})

describe('badgeView：模式与文案', () => {
  const windows = {
    kind: 'windows',
    accounts: [{ accountId: 'a', nickname: 'a', ok: true, windows: [
      { type: 'five_hour', percentUsed: 6, resetsAt: '' },
      { type: 'weekly', percentUsed: 2, resetsAt: '' },
    ] }],
  }
  const plan = {
    kind: 'plan',
    accounts: [{ accountId: 'a', nickname: 'a', plan: { name: 'Free Plan Subscription', remaining: 300, total: 500, unit: 'credits' } }],
  }

  /**
   * ⚠️ 2026-10-03 **优先级反转**（用户报障）：
   * 胶囊显示「个人体验版 500 / 500积分」，而设置页里可用积分是 2434.96。
   * 套餐读数是「某一份包还剩多少」，余额才是「一共还能用多少」—— 前者必然少报。
   * 故 `auto` 改为**余额优先**，窗口/套餐退到 `subscription` 档。
   */
  it('auto：**余额优先**——即使有窗口与套餐，也显示一共能用的积分', () => {
    const view = badgeView({ providerLabel: 'Cline', preference: 'auto', subscription: windows, accounts: [row('a', [pkg('Cline 账户余额', 5)])] })
    expect(view.mode).toBe('credits')
    expect(view.text).toBe('Cline • 5积分')
    expect(view.reading).toBe('5积分')
    expect(view.detail).toBe('')
    expect(view.tone).toBe('ok')
  })

  it('auto：有套餐包也有余额时显示**余额合计**（用户报障的那一例）', () => {
    // 复刻报障现场：有「体验版」套餐包，但余额合计是 2434.96
    const view = badgeView({ providerLabel: 'CodeBuddy', preference: 'auto', subscription: plan, accounts: [row('a', [pkg('个人体验版', 2434.96)])] })
    expect(view.mode).toBe('credits')
    expect(view.text).toBe('CodeBuddy • 2434.96积分')
    // ⚠️ 套餐读数**没有消失**，只是不再是折叠态的默认 —— 它仍在返回结构里
    expect(view.planGroups).toHaveLength(1)
    expect(view.windows).toEqual([])
  })

  it('subscription 偏好：窗口优先（想盯百分比的人切这一档）', () => {
    const view = badgeView({ providerLabel: 'Cline', preference: 'subscription', subscription: windows, accounts: [row('a', [pkg('Cline 账户余额', 5)])] })
    expect(view.mode).toBe('windows')
    // ⚠️ 分隔符是 BADGE_SEP（' • '），不再是 ' · '；' · ' 只用于读数**内部**分段。
    expect(view.text).toBe('Cline • 5 小时 6% · 本周 2%')
    expect(view.name).toBe('Cline')
    expect(view.detail).toBe('')
    expect(view.reading).toBe('5 小时 6% · 本周 2%')
  })

  it('subscription 偏好：无窗口时显示套餐（剩余 / 总量 + 单位）', () => {
    const view = badgeView({ providerLabel: 'CodeBuddy', preference: 'subscription', subscription: plan, accounts: [row('a', [pkg('Bonus Pack', 20)])] })
    expect(view.mode).toBe('plan')
    expect(view.text).toBe('CodeBuddy • Free Plan Subscription 300 / 500积分')
    // 包名进 detail（渲染层里**最先**被省略的那一段），数字进 reading
    expect(view.detail).toBe('Free Plan Subscription')
    expect(view.reading).toBe('300 / 500积分')
  })

  it('三种偏好的候选顺序各自完整（不允许某档漏掉回落）', () => {
    // auto：余额 → 窗口 → 套餐（三级回落，任一级为空都要继续往下走）
    const noCredits = { kind: 'windows', accounts: [{ accountId: 'a', nickname: 'a', ok: true, windows: [{ type: 'five_hour', percentUsed: 6, resetsAt: '' }] }] }
    expect(badgeView({ providerLabel: 'Cline', preference: 'auto', subscription: noCredits, accounts: [row('a', null, '查询失败')] }).mode).toBe('windows')
    expect(badgeView({ providerLabel: 'CodeBuddy', preference: 'auto', subscription: plan, accounts: [row('a', null, '查询失败')] }).mode).toBe('plan')
    // subscription：窗口 → 套餐 → 余额
    expect(badgeView({ providerLabel: 'CodeBuddy', preference: 'subscription', subscription: undefined, accounts: [row('a', [pkg('Bonus Pack', 20)])] }).mode).toBe('credits')
    // credits：**只看余额**（有窗口也不显示窗口）
    expect(badgeView({ providerLabel: 'Cline', preference: 'credits', subscription: windows, accounts: [row('a', [pkg('Cline 账户余额', 5)])] }).mode).toBe('credits')
  })

  it('auto：两者都没有时显示积分合计', () => {
    const view = badgeView({
      providerLabel: 'CodeBuddy',
      preference: 'auto',
      subscription: undefined,
      accounts: [row('a', [pkg('Bonus Pack', 100)]), row('b', [pkg('Bonus Pack', 96.87)])],
    })
    expect(view.mode).toBe('credits')
    // 用户 2026-10-03 定：胶囊里不再写「合计」（那个词占位但不提供信息）
    expect(view.text).toBe('CodeBuddy • 196.87积分')
    expect(view.reading).toBe('196.87积分')
    expect(view.detail).toBe('')
  })

  it('credits 偏好：即使有窗口也显示积分（套餐误判时的兜底开关）', () => {
    const view = badgeView({ providerLabel: 'Cline', preference: 'credits', subscription: windows, accounts: [row('a', [pkg('Cline 账户余额', 5)])] })
    expect(view.mode).toBe('credits')
    expect(view.text).toBe('Cline • 5积分')
  })

  it('窗口存在但一条都没有时**回落**到积分（不能显示成只有渠道名）', () => {
    const empty = { kind: 'windows', accounts: [{ accountId: 'a', nickname: 'a', ok: true, windows: [] }] }
    const view = badgeView({ providerLabel: 'Cline', preference: 'auto', subscription: empty, accounts: [row('a', [pkg('Cline 账户余额', 12)])] })
    expect(view.mode).toBe('credits')
    expect(view.text).toBe('Cline • 12积分')
  })

  it('窗口取第一个**读到数**的账号（失败的账号不参与）', () => {
    const mixed = {
      kind: 'windows',
      accounts: [
        { accountId: 'bad', nickname: 'bad', ok: false, windows: [], error: '凭据未配置' },
        { accountId: 'good', nickname: 'good', ok: true, windows: [{ type: 'five_hour', percentUsed: 33, resetsAt: '' }] },
      ],
    }
    // ⚠️ 显式用 subscription 档：auto 已改为**余额优先**，用它就测不到窗口选取了
    // （那正是本用例存在的意义 —— 别为了「让 auto 也过」而弱化断言）。
    const view = badgeView({ providerLabel: 'Cline', preference: 'subscription', subscription: mixed, accounts: [row('good', [pkg('Cline 账户余额', 1)])] })
    expect(view.mode).toBe('windows')
    expect(view.text).toBe('Cline • 5 小时 33%')
  })

  it('token 渠道按 M 显示（ZCode 的 1 亿 token 不能画成「1 亿积分」）', () => {
    const view = badgeView({
      providerLabel: 'ZCode (智谱)',
      preference: 'credits',
      subscription: undefined,
      accounts: [row('a', [pkg('GLM-5.2', 94_539_275, 'token')])],
    })
    expect(view.text).toBe('ZCode (智谱) • 94.54MToken')
  })

  it('没有启用账号 → 明确文案；全部读取失败 → 另一句（下一步动作不同）', () => {
    const none = badgeView({ providerLabel: 'CodeBuddy', preference: 'auto', subscription: undefined, accounts: [] })
    expect(none.mode).toBe('empty')
    expect(none.text).toBe('CodeBuddy • 未配置启用账号')
    expect(none.tone).toBe('muted')

    const allFailed = badgeView({ providerLabel: 'CodeBuddy', preference: 'auto', subscription: undefined, accounts: [row('a', null, '凭据未配置')] })
    expect(allFailed.mode).toBe('empty')
    expect(allFailed.text).toBe('CodeBuddy • 用量不可用')
    expect(allFailed.tone).toBe('error')
    expect(allFailed.failureReason).toBe('凭据未配置')
  })
})

describe('badgeView：色调', () => {
  function toneOfWindows(percent) {
    // ⚠️ subscription 档：auto 已改为余额优先，用它拿到的是**余额**的色调，
    // 就测不到「取最紧张的那个窗口」这条规则了。
    return badgeView({
      providerLabel: 'Cline',
      preference: 'subscription',
      subscription: { kind: 'windows', accounts: [{ accountId: 'a', nickname: 'a', ok: true, windows: [{ type: 'five_hour', percentUsed: percent, resetsAt: '' }] }] },
      accounts: [row('a', [pkg('Cline 账户余额', 1)])],
    }).tone
  }

  it('窗口：≥90 红 / ≥70 黄 / 其余绿（取最紧张的那个窗口）', () => {
    expect(toneOfWindows(95)).toBe('error')
    expect(toneOfWindows(70)).toBe('warn')
    expect(toneOfWindows(12)).toBe('ok')
  })

  it('套餐耗尽与积分为 0 都提示（warn，而不是当成错误）', () => {
    const planEmpty = badgeView({
      providerLabel: 'CodeBuddy',
      preference: 'auto',
      subscription: { kind: 'plan', accounts: [{ accountId: 'a', plan: { name: 'Free Plan', remaining: 0, total: 100, unit: 'credits' } }] },
      accounts: [row('a', [pkg('Bonus Pack', 0)])],
    })
    expect(planEmpty.tone).toBe('warn')

    const creditsEmpty = badgeView({ providerLabel: 'CodeBuddy', preference: 'credits', subscription: undefined, accounts: [row('a', [pkg('Bonus Pack', 0)])] })
    expect(creditsEmpty.mode).toBe('credits')
    expect(creditsEmpty.tone).toBe('warn')
  })
})

describe('badgeView：首屏状态（真实报障的回归）', () => {
  it('首次读数还没到 → 「读取中…」，**不是**「未配置启用账号」', () => {
    // 报障（2026-10-02）：徽标一开始显示「未配置启用账号」，其实只是还没读到。
    const view = badgeView({ providerLabel: 'CodeBuddy', preference: 'auto', subscription: undefined, accounts: [], loading: true })
    expect(view.mode).toBe('loading')
    expect(view.text).toBe('CodeBuddy • 读取中…')
    expect(view.tone).toBe('muted')
    expect(view.groups).toEqual([])
  })

  it('首次读数就失败 → 「用量不可用」，与「没有账号」区分开', () => {
    const view = badgeView({ providerLabel: 'CodeBuddy', preference: 'auto', subscription: undefined, accounts: [], failed: true })
    expect(view.mode).toBe('empty')
    expect(view.text).toBe('CodeBuddy • 用量不可用')
    expect(view.tone).toBe('error')
  })

  it('有数据时刷新失败**不降级**成空态（保留旧读数）', () => {
    // 组件只在 `snapshot === null` 时传 loading/failed；有数据时必须照常显示读数。
    const view = badgeView({
      providerLabel: 'CodeBuddy',
      preference: 'auto',
      subscription: undefined,
      accounts: [row('a', [pkg('Bonus Pack', 100)])],
      loading: false,
      failed: false,
    })
    expect(view.mode).toBe('credits')
    expect(view.text).toBe('CodeBuddy • 100积分')
  })
})

/**
 * 用户 2026-10-03 报障的回归：胶囊显示成「LobsterAI (有道) · 合计 …」，
 * **数字被截掉**。
 *
 * 两条断言分别锁住「修法的两半」，缺一不可：
 * 1. 文案口径（本文件）—— 分隔符与「名字 / 中段 / 读数」三段字段；
 * 2. 结构（usage-badge-client.spec.ts）—— 渲染成**多个** span 且各有收缩权重。
 *
 * ⚠️ 只锁 ① 是不够的：文案再对，塞回一个 overflow:hidden 的 span 里照样会把
 * 数字省略掉 —— 那正是本次报障的形态。
 */
describe('折叠态三段结构（真实报障：数字被截掉）', () => {
  it('恒有 text === name + BADGE_SEP + detail + reading（渲染层与整句不会走偏）', () => {
    const cases = [
      { providerLabel: 'WorkBuddy (国际版)', preference: 'credits', subscription: undefined, accounts: [row('a', [pkg('Bonus Pack', 200)])] },
      { providerLabel: 'LobsterAI (有道)', preference: 'credits', subscription: undefined, accounts: [row('a', [pkg('Bonus Pack', 842.06)])] },
      {
        providerLabel: 'CodeBuddy',
        preference: 'auto',
        subscription: { kind: 'plan', accounts: [{ accountId: 'a', plan: { name: 'Free Plan Subscription', remaining: 300, total: 500, unit: 'credits' } }] },
        accounts: [],
      },
      { providerLabel: 'Cline', preference: 'credits', subscription: undefined, accounts: [], loading: true },
      { providerLabel: 'Cline', preference: 'credits', subscription: undefined, accounts: [] },
    ]
    for (const input of cases) {
      const view = badgeView(input)
      const middle = view.detail === '' ? '' : `${view.detail} `
      expect(view.text, input.providerLabel).toBe(`${view.name}${BADGE_SEP}${middle}${view.reading}`)
      // 三段都不该自带分隔符（否则渲染层会出现两个「•」）
      expect(view.name).not.toContain('•')
      expect(view.detail).not.toContain('•')
      expect(view.reading).not.toContain('•')
    }
  })

  it('分隔符是单独常量（渲染层与文案共用同一个字形，不会一边 • 一边 ·）', () => {
    expect(BADGE_SEP).toBe(' • ')
    const view = badgeView({ providerLabel: 'LobsterAI (有道)', preference: 'credits', subscription: undefined, accounts: [row('a', [pkg('Bonus Pack', 842.06)])] })
    expect(view.text).toBe('LobsterAI (有道) • 842.06积分')
    expect(view.text.split(BADGE_SEP)).toEqual(['LobsterAI (有道)', '842.06积分'])
  })

  it('用户给的两个样例逐字命中', () => {
    const workbuddy = badgeView({ providerLabel: 'WorkBuddy (国际版)', preference: 'credits', subscription: undefined, accounts: [row('a', [pkg('Bonus Pack', 200)])] })
    expect(workbuddy.text).toBe('WorkBuddy (国际版) • 200积分')
    const lobster = badgeView({ providerLabel: 'LobsterAI (有道)', preference: 'credits', subscription: undefined, accounts: [row('a', [pkg('Bonus Pack', 842.06)])] })
    expect(lobster.text).toBe('LobsterAI (有道) • 842.06积分')
  })

  it('数值与单位之间不留空格（省 px，且与用户样例一致）', () => {
    const credits = badgeView({ providerLabel: 'Cline', preference: 'credits', subscription: undefined, accounts: [row('a', [pkg('Cline 账户余额', 200)])] })
    expect(credits.reading).toBe('200积分')
    const tokens = badgeView({ providerLabel: 'ZCode (智谱)', preference: 'credits', subscription: undefined, accounts: [row('a', [pkg('GLM-5.2', 94_539_275, 'token')])] })
    expect(tokens.reading).toBe('94.54MToken')
  })
})

/**
 * 「合计不完整」的提示（2026-10-03，用户要求）。
 *
 * 账号越多越容易撞上：六个号里坏一个，胶囊上的合计就少一截，而数字本身
 * **看不出任何异常**（色调仍是 ok）。故必须单独给一句说明，由渲染层挂成角标。
 */
describe('incompleteNote：合计少算了账号时要说明', () => {
  const ok = row('a', [pkg('Bonus Pack', 100)])
  const dead = row('b', null, '凭据未配置')

  it('积分模式：有账号读不到 → 说清「是余额没读到」「不计入合计」', () => {
    const view = badgeView({ providerLabel: 'WorkBuddy (国际版)', preference: 'auto', subscription: undefined, accounts: [ok, dead] })
    expect(view.mode).toBe('credits')
    expect(view.reading).toBe('100积分')
    expect(view.incompleteNote).toBe('另有 1 个账号的余额读取失败，未计入合计')
    expect(view.failedCount).toBe(1)
  })

  it('它**不进** reading / text —— 那是纯读数，供 title 与读屏单独拼', () => {
    const view = badgeView({ providerLabel: 'WorkBuddy (国际版)', preference: 'auto', subscription: undefined, accounts: [ok, dead] })
    expect(view.text).toBe('WorkBuddy (国际版) • 100积分')
    expect(view.reading).not.toContain('读取失败')
    expect(view.text).not.toContain('读取失败')
  })

  it('全部读到数 → 空串（没有提示要显示）', () => {
    const view = badgeView({ providerLabel: 'CodeBuddy', preference: 'auto', subscription: undefined, accounts: [ok, row('c', [pkg('Bonus Pack', 50)])] })
    expect(view.incompleteNote).toBe('')
  })

  it('一个都没读到 → 也空串（模式已回落到「用量不可用」，再加一句是噪音）', () => {
    const view = badgeView({ providerLabel: 'CodeBuddy', preference: 'auto', subscription: undefined, accounts: [dead, row('c', null, '网络超时')] })
    expect(view.mode).toBe('empty')
    expect(view.reading).toBe('用量不可用')
    expect(view.incompleteNote).toBe('')
  })

  it('窗口 / 套餐模式**不套用**这句话（它们本来就不是合计，说了就是错的）', () => {
    const windows = {
      kind: 'windows',
      accounts: [{ accountId: 'a', nickname: 'a', ok: true, windows: [{ type: 'five_hour', percentUsed: 6, resetsAt: '' }] }],
    }
    const windowView = badgeView({ providerLabel: 'Cline', preference: 'subscription', subscription: windows, accounts: [ok, dead] })
    expect(windowView.mode).toBe('windows')
    expect(windowView.incompleteNote).toBe('')

    const plan = { kind: 'plan', accounts: [{ accountId: 'a', plan: { name: 'Free Plan Subscription', remaining: 300, total: 500, unit: 'credit' } }] }
    const planView = badgeView({ providerLabel: 'CodeBuddy', preference: 'subscription', subscription: plan, accounts: [ok, dead] })
    expect(planView.mode).toBe('plan')
    expect(planView.incompleteNote).toBe('')
  })

  it('占位态（读取中 / 首屏失败）也有这个字段 —— 调用方不必做形状判断', () => {
    expect(badgeView({ providerLabel: 'Cline', preference: 'auto', subscription: undefined, accounts: [], loading: true }).incompleteNote).toBe('')
    expect(badgeView({ providerLabel: 'Cline', preference: 'auto', subscription: undefined, accounts: [], failed: true }).incompleteNote).toBe('')
  })
})

/**
 * 弹窗积分列表的排序 + 折叠（2026-10-03 用户要求）。
 *
 * 为什么值得单测：这两条规则都是**看不见的**——排序错了用户只会觉得「找不到能用的
 * 那个号」，折叠边界错了只会觉得「怎么少了一个号」。而组件里那部分测不到
 * （`usage-badge.js` 依赖宿主注入的 react，本仓库装不了），故逻辑必须住在这里。
 */
describe('orderCreditRows：按余额降序 + 折叠', () => {
  const acc = (id, total) => ({ accountId: id, nickname: id, balance: total === null ? null : { total, packages: [], expiredTotal: 0 } })
  const ids = (rows) => rows.map((row) => row.accountId)

  it('按余额降序（用户先要看到「还有哪个号能用」）', () => {
    const { shown, hidden } = orderCreditRows([acc('a', 10), acc('b', 300), acc('c', 50)], { limit: 5, expanded: false })
    expect(ids(shown)).toEqual(['b', 'c', 'a'])
    expect(hidden).toBe(0)
  })

  it('读不到数的排**最后**（不能当 0 混进小余额里 —— 那格显示的是错误文案）', () => {
    const { shown } = orderCreditRows([acc('dead', null), acc('a', 5), acc('b', 100)], { limit: 5, expanded: false })
    expect(ids(shown)).toEqual(['b', 'a', 'dead'])
  })

  it('排序稳定：余额相同的账号保持原顺序（否则每次渲染 DOM 抖动）', () => {
    const first = orderCreditRows([acc('a', 100), acc('b', 100), acc('c', 100)], { limit: 5, expanded: false })
    const second = orderCreditRows([acc('a', 100), acc('b', 100), acc('c', 100)], { limit: 5, expanded: false })
    expect(ids(first.shown)).toEqual(['a', 'b', 'c'])
    expect(ids(second.shown)).toEqual(['a', 'b', 'c'])
  })

  it('折叠：只给 limit 条，`hidden` 如实报出被收起的条数', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, index) => acc(id, index))
    const collapsed = orderCreditRows(rows, { limit: 5, expanded: false })
    expect(collapsed.shown).toHaveLength(5)
    expect(collapsed.hidden).toBe(2)
    // 「展开其余 N 个」按 hidden 报数，展开后 hidden 不变（按钮换成「收起」）
    const expanded = orderCreditRows(rows, { limit: 5, expanded: true })
    expect(expanded.shown).toHaveLength(7)
    expect(expanded.hidden).toBe(2)
  })

  it('刚好等于 limit 时不产生折叠按钮（hidden 为 0）', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id, index) => acc(id, index))
    expect(orderCreditRows(rows, { limit: 5, expanded: false }).hidden).toBe(0)
  })

  it('脏数据不炸：非数组 / 缺 limit 都退化，不抛错', () => {
    expect(orderCreditRows(undefined, { limit: 5 }).shown).toEqual([])
    expect(orderCreditRows(null, {}).shown).toEqual([])
    expect(ids(orderCreditRows([acc('a', 1)], {}).shown)).toEqual([])   // limit 缺省 0 ⇒ 不显示
  })

  it('不改动入参数组（组件每轮都拿同一个数组，原地排序会污染宿主给的读数）', () => {
    const rows = [acc('a', 1), acc('b', 2)]
    orderCreditRows(rows, { limit: 5, expanded: false })
    expect(ids(rows)).toEqual(['a', 'b'])
  })
})

describe('formatUpdatedAt', () => {
  it('含日期与秒（宿主是长生命周期进程，只有时钟会让昨天的读数看起来像刚刚）', () => {
    const at = new Date(2026, 9, 1, 16, 39, 32).getTime()
    expect(formatUpdatedAt(at)).toBe('2026/10/1 16:39:32')
  })

  it('非法值返回空串（不显示 NaN）', () => {
    expect(formatUpdatedAt(undefined)).toBe('')
    expect(formatUpdatedAt(Number.NaN)).toBe('')
  })
})

describe('describeBadgeError：把「宿主没重启」翻译成可行动的一句话', () => {
  /**
   * ⚠️ 真实故障回归（2026-10-02 用户报障）：徽标显示「用量不可用」，弹窗里
   * 赫然写着裸的 `unknown method: usage.badgePreference`。
   *
   * 根因不是代码错，而是**两侧加载时机不同**：宿主在启动时把 `lib/` 加载进内存，
   * 客户端 bundle 却每次从磁盘读 —— 刷新页面后浏览器拿到新 UI，宿主仍跑旧代码。
   * 用户完全不知道要重启，故必须翻译。
   */
  it('宿主缺方法 → 提示重启，而不是透出裸错误', () => {
    expect(describeBadgeError(new Error('unknown method: usage.badgePreference'))).toBe(HOST_STALE_HINT)
    expect(describeBadgeError({ message: 'unknown method: usage.badge' })).toBe(HOST_STALE_HINT)
  })

  /**
   * ★ 第二种「宿主跑旧代码」的形态（2026-10-11 PR !84 复审**实测取证**）。
   *
   * `jet-hub-auto` 的徽标分支是客户端新增的：客户端会去请求这个 provider 的余额，
   * 而**旧宿主不认它**。在 master（旧宿主）上真跑 `usage.badge` 端点，拿到的回包是：
   *
   * ```
   * {"ok":false,"error":{"code":"bad-request","message":"unsupported provider: jet-hub-auto"}}
   * ```
   *
   * 原判据只认 `unknown method` ⇒ 用户看到的就是这句裸技术文案，而实际动作同样
   * 只有「重启 DSH」。⇒ 不翻译等于让新客户端在旧宿主上变成一个看不懂的错误。
   */
  it('★ 宿主不认 auto 这个 provider（旧宿主）→ 同样提示重启', () => {
    // 逐字使用实测取证到的文案。
    expect(describeBadgeError(new Error('unsupported provider: jet-hub-auto'))).toBe(HOST_STALE_HINT)
    expect(describeBadgeError({ message: 'unsupported provider: jet-hub-auto' })).toBe(HOST_STALE_HINT)
  })

  it('其它错误原样透出（凭据/网络类文案本身就有指向性，不能被吞掉）', () => {
    expect(describeBadgeError(new Error('凭据已过期'))).toBe('凭据已过期')
    expect(describeBadgeError({ message: 'bad-request: provider 不能为空' })).toBe('bad-request: provider 不能为空')
  })

  it('拿不到消息时回落到调用方给的兜底', () => {
    expect(describeBadgeError(new Error(''), '偏好保存失败')).toBe('偏好保存失败')
    expect(describeBadgeError(undefined, '偏好保存失败')).toBe('偏好保存失败')
    expect(describeBadgeError({}, '')).toBe('')
  })

  it('判据要窄：不把泛词误判成「宿主未重启」', () => {
    // 「未知模型」是真实业务错误，不能被当成「宿主缺方法」
    expect(describeBadgeError(new Error('未知模型 id'))).toBe('未知模型 id')
    expect(describeBadgeError(new Error('该渠道不支持此操作'))).toBe('该渠道不支持此操作')
    // ⚠️ 中文「不支持」同样不得命中（两种宿主的英文短语才是指纹）。
    expect(describeBadgeError(new Error('该账号不支持此功能'))).toBe('该账号不支持此功能')
    // ⚠️ 反向：`unsupported provider` 是**指纹**，但泛化的 `unsupported` 不是 ——
    //    断言本函数**不会**因为别处的 `unsupported` 就误报「请重启」。
    expect(describeBadgeError(new Error('unsupported reasoning effort'))).toBe('unsupported reasoning effort')
  })
})

describe('与设置页共用同一套格式化（防止两处数字不一致）', () => {
  it('数字与单位标签都走 credits-format', () => {
    expect(formatUnits(196.87, 'credits')).toBe('196.87')
    expect(formatUnits(94_539_275, 'token')).toBe('94.54M')
    expect(unitLabel('token')).toBe('Token')
    expect(unitLabel(undefined)).toBe('积分')
  })
})

/**
 * 用户报障（2026-10-03）原文：「95 积分；为什么显示的是积分不是额度，
 * 计划里应该说了会显示额度」。
 *
 * 三层错误叠在一起：标签（`unitLabel` 的「其余 ⇒ 积分」兜底）、
 * 数字（`formatCredits` 把 94.5 补成 `94.50`）、以及 94.5 本身——
 * 它是宿主把两个窗口剩余比例取的平均值，**上游根本没有这个数**。
 * 计划 §3.3 明确要求「面板会显示『5 小时窗口 99% / 周窗口 99%』
 * 而非『N 积分』……不要假装成积分数字」。
 */
describe('配额窗口（Gemini）：逐窗口百分比，不显示均值也不显示「积分」', () => {
  /** 配额包：单位 `%`，`remaining` 是剩余百分比。 */
  const quotaPkg = (name, remaining, cycleEndTime = '') => ({
    name, unit: QUOTA_UNIT, remaining, total: 100, used: 100 - remaining,
    active: true, cycleStartTime: '', cycleEndTime, expiredTime: '',
  })

  /** 配额账号行：`total` 是宿主算的两窗口均值（这里就是真实形状）。 */
  const quotaRow = (accountId, packages) => ({
    accountId,
    nickname: accountId,
    balance: {
      total: packages.reduce((sum, item) => sum + item.remaining, 0) / packages.length,
      packages,
      expiredTotal: 0,
    },
  })

  it('单位 `%` 走百分比格式化与「额度」标签', () => {
    expect(formatUnits(94.5, QUOTA_UNIT)).toBe('95%')
    expect(unitLabel(QUOTA_UNIT)).toBe('额度')
  })

  it('逐窗口列出各自的剩余百分比，不做求和也不取均值', () => {
    const packages = [quotaPkg('5 小时窗口', 0), quotaPkg('周窗口', 90)]
    expect(formatQuotaLine(packages, QUOTA_UNIT)).toBe('5 小时窗口 0% · 周窗口 90%')
  })

  it('非配额单位返回 null（调用方原样走积分 / token 分支，零影响）', () => {
    expect(formatQuotaLine([pkg('Bonus Pack', 100)], 'credits')).toBe(null)
    expect(formatQuotaLine(undefined, QUOTA_UNIT)).toBe(null)
  })

  it('分组带逐账号窗口行，且均值不再出现在文案里', () => {
    const groups = creditGroupsOf([quotaRow('a', [quotaPkg('5 小时窗口', 0), quotaPkg('周窗口', 90)])])
    expect(groups.groups[0].quotaLines).toEqual(['5 小时窗口 0% · 周窗口 90%'])
    const view = badgeView({ providerLabel: 'Gemini', accounts: [quotaRow('a', [quotaPkg('5 小时窗口', 0), quotaPkg('周窗口', 90)])] })
    expect(view.mode).toBe('credits')
    // ⚠️ 分隔符是 ` • `（`BADGE_SEP`，上游 2026-10-03 改的）；` · ` 只用于读数内部。
    expect(view.text).toBe('Gemini • 5 小时窗口 0% · 周窗口 90%')
    // 「合计 45 额度」是被修掉的形状：均值既不是上游的数，「合计」也暗示可累加
    expect(view.text).not.toContain('合计')
    expect(view.text).not.toContain('45')
  })

  it('色调取**最紧张**的窗口，不被均值抹平', () => {
    // 均值 (0+90)/2 = 45% ⇒ 老判据 `total > 0` 会画绿点，而 5 小时窗口已耗尽
    const view = badgeView({ providerLabel: 'Gemini', accounts: [quotaRow('a', [quotaPkg('5 小时窗口', 0), quotaPkg('周窗口', 90)])] })
    expect(view.tone).toBe('error')
  })

  it('窗口都宽裕时是 ok（不是一律告警）', () => {
    const view = badgeView({ providerLabel: 'Gemini', accounts: [quotaRow('a', [quotaPkg('5 小时窗口', 80), quotaPkg('周窗口', 90)])] })
    expect(view.tone).toBe('ok')
  })

  it('★ 多账号：同一窗口**聚合**为一个值（取最紧张），不再逐账号并列', () => {
    // 用户 2026-10-05 报障：两个 Gemini 账号时胶囊读数是
    //   `5 小时窗口 82% · 周窗口 79% · 5 小时窗口 98% · 周窗口 98%`
    // —— 四段必然被省略号截断，且同一个窗口名出现两次、读者无法比对。
    // 聚合后每个窗口只出现一次，取跨账号**最紧张**的那个值。
    const view = badgeView({
      providerLabel: 'Gemini',
      accounts: [quotaRow('a', [quotaPkg('周窗口', 90)]), quotaRow('b', [quotaPkg('周窗口', 30)])],
    })
    expect(view.text).toBe('Gemini • 周窗口 30%')

    // 多窗口 × 多账号：仍只按窗口名出两条
    const both = badgeView({
      providerLabel: 'Gemini',
      accounts: [
        quotaRow('a', [quotaPkg('5 小时窗口', 82), quotaPkg('周窗口', 79)]),
        quotaRow('b', [quotaPkg('5 小时窗口', 98), quotaPkg('周窗口', 98)]),
      ],
    })
    // 聚合取 min：5 小时窗口 min(82,98)=82；周窗口 min(79,98)=79
    expect(both.text).toBe('Gemini • 5 小时窗口 82% · 周窗口 79%')

    // ⚠️ 聚合口径必须与圆点色调**同源**（toneOf 也用 min）——
    // 否则会出现「点已报警、数字看着还挺多」的自相矛盾。
    expect(both.tone).toBe('ok')
    const tight = badgeView({
      providerLabel: 'Gemini',
      accounts: [
        quotaRow('a', [quotaPkg('5 小时窗口', 95)]),
        quotaRow('b', [quotaPkg('5 小时窗口', 5)]),
      ],
    })
    // 最紧张的那个账号（5%）决定读数与色调，两者一致
    expect(tight.text).toBe('Gemini • 5 小时窗口 5%')
    expect(tight.tone).not.toBe('ok')
  })

  it('单账号：聚合结果与逐账号行**逐字相同**（既有行为不变）', () => {
    const view = badgeView({
      providerLabel: 'Gemini',
      accounts: [quotaRow('a', [quotaPkg('5 小时窗口', 0), quotaPkg('周窗口', 90)])],
    })
    expect(view.text).toBe('Gemini • 5 小时窗口 0% · 周窗口 90%')
    // 逐账号明细仍留在 quotaLines 里（弹窗空间足够，不该丢账号粒度）
    const groups = creditGroupsOf([quotaRow('a', [quotaPkg('5 小时窗口', 0), quotaPkg('周窗口', 90)])])
    expect(groups.groups[0].quotaLines).toEqual(['5 小时窗口 0% · 周窗口 90%'])
  })

  it('包上没有可用数字时给出「额度不可用」，不画成 0', () => {
    const broken = { accountId: 'a', nickname: 'a', balance: { total: 0, packages: [quotaPkg('周窗口', undefined)], expiredTotal: 0 } }
    const view = badgeView({ providerLabel: 'Gemini', accounts: [broken] })
    expect(view.text).toBe('Gemini • 额度不可用')
  })

  it('其它单位的文案与色调逐字不变（回归护栏）', () => {
    const credits = badgeView({ providerLabel: 'ZCode', accounts: [row('a', [pkg('Bonus Pack', 100)])] })
    expect(credits.text).toBe('ZCode • 100积分')
    expect(credits.tone).toBe('ok')
    const tokens = badgeView({ providerLabel: 'ZCode', accounts: [row('a', [pkg('GLM-5.2', 94_539_275, 'token')])] })
    expect(tokens.text).toBe('ZCode • 94.54MToken')
  })
})

/**
 * ★ 「积分区」**节标题**的单位标签（真实缺陷，2026-10-05 复审 PR !56 时发现）。
 *
 * 节标题原写作 `quotaGroup === undefined ? '积分' : unitLabel(...)` —— 兜底分支
 * 假定「所有非配额渠道都是积分」，而 **ZCode 的额度单位是 token**。于是浮层里
 * 出现**自相矛盾的一屏**：标题写「积分」、下面每个数值写「94.54MToken」。
 *
 * ⚠️ 这是「展示路径写死『积分』」这类缺陷的**第三个实例**
 * （前两个：逐账号明细行 `+100.00M Token`、领取汇总行 `++100.00MToken`），
 * 它至今没被发现是因为**只在「该渠道只发 token」时显形**，而 12 个渠道里
 * 只有 ZCode 是这种形状。
 */
describe('★ 积分区节标题：单位标签必须按数据走，不写死「积分」', () => {
  it('★★ ZCode（只发 token）⇒ 标题是「Token」，不是「积分」（报障形态）', () => {
    const groups = creditGroupsOf([row('a', [pkg('ZCode 免费额度', 94_539_275, 'token')])]).groups
    expect(groups[0].unit).toBe('token')
    // 修复前这里是「积分」—— 与同屏的 `94.54MToken` 自相矛盾
    expect(creditSectionLabel(groups)).toBe('Token')
  })

  it('普通积分渠道 ⇒ 仍是「积分」（行为逐字不变）', () => {
    const groups = creditGroupsOf([row('a', [pkg('Bonus Pack', 100)])]).groups
    expect(creditSectionLabel(groups)).toBe('积分')
  })

  it('配额窗口（Gemini）⇒ 「额度」，不是「积分」也不是「%」', () => {
    const quotaPkg = { name: '周窗口', unit: QUOTA_UNIT, remaining: 90, total: 100, used: 10, active: true }
    const groups = creditGroupsOf([{ accountId: 'a', nickname: 'a', balance: { total: 90, packages: [quotaPkg], expiredTotal: 0 } }]).groups
    expect(creditSectionLabel(groups)).toBe('额度')
  })

  it('无分组 ⇒ 回落到「积分」（空态不抛错、也不显示空串）', () => {
    expect(creditSectionLabel([])).toBe('积分')
    expect(creditSectionLabel(undefined)).toBe('积分')
    expect(creditSectionLabel(null)).toBe('积分')
  })

  it('多单位并列 ⇒ 取第一个（与分组排序一致，结果确定）', () => {
    // `creditGroupsOf` 末尾按 unit 排序，故「第一个」不依赖对象键序
    const groups = creditGroupsOf([
      row('a', [pkg('普通包', 100)]),
      row('b', [pkg('ZCode 免费额度', 94_539_275, 'token')]),
    ]).groups
    expect(groups.map((g) => g.unit)).toEqual(['credit', 'token'])
    expect(creditSectionLabel(groups)).toBe('积分')
  })

  it('同一账号多量纲（MonkeyCode 积分 + 每日额度 token）⇒ 各自成组、不相加', () => {
    const groups = creditGroupsOf([{
      accountId: 'a',
      nickname: 'a',
      balance: {
        total: 235,
        packages: [
          pkg('积分余额', 235, 'credit'),
          pkg('每日额度', 9_240_000, 'token'),
        ],
        expiredTotal: 0,
      },
    }]).groups
    expect(groups.map((g) => g.unit)).toEqual(['credit', 'token'])
    expect(groups.find((g) => g.unit === 'credit')?.total).toBe(235)
    expect(groups.find((g) => g.unit === 'token')?.total).toBe(9_240_000)
  })

  it('脏数据（缺 unit / 非对象项）不抛错', () => {
    expect(creditSectionLabel([null, undefined, {}, { unit: 123 }])).toBe('积分')
  })
})
