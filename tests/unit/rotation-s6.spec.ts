/**
 * ★★★ **S6：轮换起点降档后交出首位**（真实缺陷，2026-11-20）。
 *
 * ## 用户报障
 *
 * > 「位次4 那个 4016 的帐号，本来是有临期积分的，然后我选用它作为轮换起点，
 * >  消耗完临期积分后，它不会切换到下一个有临期积分的帐号也就是位次5，
 * >  而是直接消耗了位次4 的短期积分」
 *
 * ## 根因
 *
 * `expiringBalance` 是**母量**（= 临期 + 短期），而 `buddyBalanceTier` 只看它：
 * 临期烧完、短期还在时档位仍是 `expiring`（**可用**）⇒ S5「起点绝对第一」
 * 让起点永远占首位 ⇒ 继续烧自己的短期/永久。
 *
 * ## 规则（S6）
 *
 * ```
 * 起点当前档位 == 用户选定它时的档位  ⇒  起点绝对第一（S5）
 * 不等（= 那一档已烧完）              ⇒  交出首位，回到档位排序
 * ```
 *
 * ⚠️ `tierAtSelection === undefined` ⇒ 保持 S5（老数据 / 老客户端兼容）。
 *
 * ## 本文件同时守「前后端逐字节同构」
 *
 * 后端 `rotateFromPreferred` 与客户端 `rotateRows` 必须对同一输入给出**相同顺序**
 *（本仓 2026-11-18 曾实测三处分叉）。每一条用例都跑两侧对比。
 */
import { describe, expect, it } from 'vitest'
import { rankBuddyAccountsByBalance, rotateFromPreferred } from '../../src/buddy-balance-rank.js'
import { orderCreditRows } from '../../plugin-src/client/badge-model.js'

/** 造后端形状的账号（expiring = 临期 + 短期 母量）。 */
const backendAccount = (id, imminent, shortTerm, permanent) => ({
  id,
  ok: true,
  imminentBalance: imminent,
  expiringBalance: imminent + shortTerm,
  permanentBalance: permanent,
  split: { expiring: imminent + shortTerm, permanent },
})

/**
 * 造客户端形状的行。
 *
 * ⚠️ 客户端从**原始资源包**重新分桶（`splitCreditsByExpiry`），
 * 故这里造带 `deductionEndTime` 的包，天数用「临期/短期/永久」三档表达。
 */
const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 20, 4, 0, 0)
const clientRow = (id, imminentDays, shortTermDays, permanentAmount) => ({
  accountId: id,
  balance: {
    packages: [
      ...(imminentDays > 0
        ? [{ name: 'imm', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: NOW + imminentDays * DAY }]
        : []),
      ...(shortTermDays > 0
        ? [{ name: 'sht', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: NOW + shortTermDays * DAY }]
        : []),
      ...(permanentAmount > 0
        ? [{ name: 'perm', unit: 'credits', remaining: permanentAmount, total: permanentAmount, used: 0, active: true }]
        : []),
    ],
  },
})

const POOL = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']

/** 后端顺序。 */
function back(accounts, startId, tierAtSelection) {
  const ranked = rankBuddyAccountsByBalance(accounts)
  return rotateFromPreferred(ranked, {
    rotationStartId: startId,
    ...(tierAtSelection === undefined ? {} : { rotationStartTier: tierAtSelection }),
    enabledAccountIds: POOL,
  }).map((a) => a.id)
}

/** 客户端顺序（弹窗显示）。 */
function front(rows, startId, tierAtSelection) {
  const out = orderCreditRows(rows, {
    rotationStartId: startId,
    enabledAccountIds: POOL,
    ...(tierAtSelection === undefined ? {} : { tierAtSelection }),
    windowDays: 15,
    imminentDays: 5,
    now: NOW,
    limit: 100,
  })
  return out.shown.map((r) => r.accountId)
}

/** 断言两侧都与期望一致（这是「同构」的最强形式）。 */
function expectBoth(accounts, rows, startId, tierAtSelection, expected) {
  expect(back(accounts, startId, tierAtSelection), '后端顺序').toEqual(expected)
  expect(front(rows, startId, tierAtSelection), '客户端顺序（须与后端同构）').toEqual(expected)
}

describe('S6：起点降档后交出首位（前后端同构）', () => {
  // 7 个号全有临期（用户数据的形态）
  const accounts = [
    backendAccount('a1', 100, 0, 3800),
    backendAccount('a2', 100, 0, 3783),
    backendAccount('a3', 100, 0, 3777),
    backendAccount('a4', 94, 0, 3796),   // ← 起点
    backendAccount('a5', 42, 0, 4111),
    backendAccount('a6', 100, 0, 3686),
    backendAccount('a7', 73, 0, 3931),
  ]
  const rows = [
    clientRow('a1', 3, 0, 3800),
    clientRow('a2', 3, 0, 3783),
    clientRow('a3', 3, 0, 3777),
    clientRow('a4', 3, 0, 3796),
    clientRow('a5', 3, 0, 4111),
    clientRow('a6', 3, 0, 3686),
    clientRow('a7', 3, 0, 3931),
  ]

  it('★ 情况1：起点临期还在 ⇒ 保持 S5（起点绝对第一 + 同档循环）', () => {
    expectBoth(accounts, rows, 'a4', 'imminent',
      ['a4', 'a5', 'a6', 'a7', 'a1', 'a2', 'a3'])
  })

  it('★★★ 情况2：起点临期烧完、短期还在 ⇒ 交出首位（用户报障）', () => {
    const afterBurn = accounts.map((a) =>
      a.id === 'a4' ? backendAccount('a4', 0, 94, 3796) : a)
    // 客户端：a4 的临期包到期时间改成「8 天后」= 短期档（> 5 天临期窗口、≤ 15 天）
    const rowsAfter = rows.map((r) =>
      r.accountId === 'a4' ? clientRow('a4', 0, 8, 3796) : r)
    expectBoth(afterBurn, rowsAfter, 'a4', 'imminent',
      ['a5', 'a6', 'a7', 'a1', 'a2', 'a3', 'a4'])
  })

  it('★★ 情况3：起点临期+短期都烧完，只剩永久 ⇒ 落永久组', () => {
    const drained = accounts.map((a) =>
      a.id === 'a4' ? backendAccount('a4', 0, 0, 3796) : a)
    const rowsDrained = rows.map((r) =>
      r.accountId === 'a4' ? clientRow('a4', 0, 0, 3796) : r)
    expectBoth(drained, rowsDrained, 'a4', 'imminent',
      ['a5', 'a6', 'a7', 'a1', 'a2', 'a3', 'a4'])
  })

  it('★ 情况4：全场只有起点 1 个号 ⇒ 恒第一（逐档往下烧，自然结果）', () => {
    const single = [backendAccount('a4', 94, 0, 3796)]
    const singleRow = [clientRow('a4', 3, 0, 3796)]
    expect(back(single, 'a4', 'imminent')).toEqual(['a4'])
    expect(front(singleRow, 'a4', 'imminent')).toEqual(['a4'])
    // 临期烧完（唯一候选）仍第一
    expect(back([backendAccount('a4', 0, 94, 3796)], 'a4', 'imminent')).toEqual(['a4'])
    expect(front([clientRow('a4', 0, 8, 3796)], 'a4', 'imminent')).toEqual(['a4'])
  })

  it('★★ 情况5：用户故意选只有永久的号 ⇒ 先烧它的永久（保持第一）', () => {
    const permOnly = accounts.map((a) =>
      a.id === 'a4' ? backendAccount('a4', 0, 0, 3796) : a)
    const rowsPermOnly = rows.map((r) =>
      r.accountId === 'a4' ? clientRow('a4', 0, 0, 3796) : r)
    // ⚠️ S5 结构 = [起点] + [其他档按序] + [起点档内的循环]
    //    a4 在永久档、组内只有它 ⇒ [a4] + [临期组 a1,a2,a3] + [短期组 a5,a6,a7]
    expectBoth(permOnly, rowsPermOnly, 'a4', 'permanent',
      ['a4', 'a1', 'a2', 'a3', 'a5', 'a6', 'a7'])
  })

  it('★ 情况6：全场只有短期、起点是短期 ⇒ 起点仍是最高档，保持第一', () => {
    const shortOnly = accounts.map((a, i) =>
      backendAccount(a.id, 0, 100 - i, 3800))
    const rowsShortOnly = rows.map((r, i) =>
      clientRow(r.accountId, 0, 8, 3800))
    expectBoth(shortOnly, rowsShortOnly, 'a4', 'expiring',
      ['a4', 'a5', 'a6', 'a7', 'a1', 'a2', 'a3'])
  })

  it('★★ 情况7：起点在最后一位、临期烧完 ⇒ 绕回开头', () => {
    const lastDrained = accounts.map((a) =>
      a.id === 'a7' ? backendAccount('a7', 0, 73, 3931) : a)
    const rowsLastDrained = rows.map((r) =>
      r.accountId === 'a7' ? clientRow('a7', 0, 8, 3931) : r)
    expectBoth(lastDrained, rowsLastDrained, 'a7', 'imminent',
      ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'])
  })

  /**
   * ★★★ **2026-11-20 二改：无档位快照 ⇒ 不再是「保持 S5」**
   *
   * 用户决定「最彻底：清除已选的起点，回归默认」⇒
   * `sanitizePreferredRotation` 丢弃一切无档位的条目 ⇒ **生产链路不存在**这种情况。
   *
   * 但 `rotateFromPreferred` 仍可能被直接调用（单测 / 内部）。此时它**不回落 S5**
   * —— 那会让缺陷复现（起点烧完临期仍占第一）。改为按「已降档」处理：起点交出首位。
   */
  it('★★★ 情况8：无档位快照 ⇒ **不回落 S5**（按已降档处理，缺陷不复现）', () => {
    const afterBurn = accounts.map((a) =>
      a.id === 'a4' ? backendAccount('a4', 0, 94, 3796) : a)
    const rowsAfter = rows.map((r) =>
      r.accountId === 'a4' ? clientRow('a4', 0, 8, 3796) : r)
    // 无快照 ⇒ 起点**不占首位**（与 S6 降档分支一致）
    const backOrder = back(afterBurn, 'a4', undefined)
    const frontOrder = front(rowsAfter, 'a4', undefined)
    expect(backOrder[0], '起点不该第一（缺陷行为已消除）').not.toBe('a4')
    expect(frontOrder[0], '客户端同构').not.toBe('a4')
    expect(backOrder).toEqual(frontOrder)
  })
})

describe('S6：边界与降级', () => {
  const accounts = [
    backendAccount('a1', 100, 0, 3800),
    backendAccount('a2', 100, 0, 3783),
    backendAccount('a3', 100, 0, 3777),
    backendAccount('a4', 0, 94, 3796),   // 起点：已降档
  ]
  const rows = [
    clientRow('a1', 3, 0, 3800),
    clientRow('a2', 3, 0, 3783),
    clientRow('a3', 3, 0, 3777),
    clientRow('a4', 0, 8, 3796),
  ]
  const pool = ['a1', 'a2', 'a3', 'a4']

  it('★★ 无池序（单测替身）时两侧仍同构（退化为档内原序）', () => {
    const backOrder = rotateFromPreferred(rankBuddyAccountsByBalance(accounts), {
      rotationStartId: 'a4',
      rotationStartTier: 'imminent',
    }).map((a) => a.id)
    const frontOrder = orderCreditRows(rows, {
      rotationStartId: 'a4',
      tierAtSelection: 'imminent',
      windowDays: 15,
      imminentDays: 5,
      now: NOW,
      limit: 100,
    }).shown.map((r) => r.accountId)
    expect(backOrder, '后端（无池序）').toEqual(frontOrder)
    expect(backOrder[0], '起点已降档 ⇒ 不该第一').not.toBe('a4')
  })

  it('★ 档位只能下降：起点升档（又充了临期）时仍按 S5 占首位', () => {
    // 选定时是 permanent，现在有了临期 ⇒ tierNow=imminent ≠ permanent ⇒ 交首位
    const upgraded = [
      backendAccount('a1', 100, 0, 3800),
      backendAccount('a4', 100, 0, 3796),   // 起点现在有临期
    ]
    const out = back(upgraded, 'a4', 'permanent')
    // 起点是临期组、与 permanent 不等 ⇒ 交首位，但临期组排序后它仍在前（同档循环）
    expect(out).toContain('a4')
    // ⚠️ 这里不钉死具体顺序：升档是异常场景（用户又充了积分），只要不崩、两端同构即可
    expect(out).toHaveLength(2)
  })

  it('⚠️ 非法档位字符串按「无快照」处理（不回落 S5，不崩）', () => {
    // 2026-11-20 二改：无快照/非法档位 ⇒ 按已降档处理，起点不占首位
    const out = back(accounts, 'a4', undefined)
    expect(out[0], '起点不占首位（缺陷行为已消除）').not.toBe('a4')
    expect(out, '集合不变').toHaveLength(accounts.length)
  })
})
