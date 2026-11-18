import { describe, expect, it } from 'vitest'
import {
  rankBuddyAccountsByBalance,
  rankBuddyAccountsByManualOrder,
  rotateFromPreferred,
} from '../../src/buddy-balance-rank.js'
import { splitCreditsByExpiry } from '../../plugin-src/client/credit-expiry.js'
import {
  creditOrderOptionsOf,
  orderCreditRows,
  rotationIdsOf,
  rotationOrderOptionsOf,
} from '../../plugin-src/client/badge-model.js'

/**
 * **前后端轮换顺序对拍**（PR #127 返工新增）。
 *
 * PR 的核心承诺是「积分弹窗的顺序 = 后端真实选号顺序」。但两侧是**两套独立
 * 实现**：后端 `rotateFromPreferred`（`src/buddy-balance-rank.ts`）与客户端
 * `rotateRows`（`plugin-src/client/badge-model.js`，经 `orderCreditRows` 暴露）。
 *
 * ⚠️ 两侧各自的用例库再密也**打不到分叉** —— 变异范式打的是「某一侧被改坏」，
 * 而分叉是「两侧从一开始就不一样」。故本文件只做一件事：同一份输入喂两侧，
 * 断言输出逐个相同。任何一侧单独演进都会在这里立刻变红。
 *
 * 场景覆盖（每条对应我在独立复核里指出的一格）：
 * - 基础档位序（起点缺省 / 空串）
 * - 起点在候选里、各档位
 * - **起点不在候选里但在 `enabledAccountIds` 里**（起点被封禁/限流 —— 常见形态）
 * - **起点在候选里但不可用**（无余额 / 锁定态只剩永久）
 * - 锁定永久积分（`allowPermanent: false`）
 * - 起点是池里最后一位（绕回开头）
 * - 严格手动顺序
 */

const NOW = Date.parse('2026-11-18T12:00:00+08:00')
const DAY = 24 * 60 * 60 * 1000
const WINDOW_DAYS = 15
const IMMINENT_DAYS = 5

interface Pkg {
  remaining: number
  deductionEndTime: number
  active: boolean
}

/**
 * `daysFromNow` 天后作废的一笔积分。
 *
 * ⚠️ 金额字段是 **`remaining`**（`plugin-src/client/credit-expiry.js:258` 的
 * `Number(pkg.remaining)`），不是 `amount` —— 写错会让分桶静默全 0、两个世界
 * 都判「不可用」，于是对拍变成「不可用池的旋转」而不是三档场景（我第一版就踩了）。
 */
function pkg(remaining: number, daysFromNow: number): Pkg {
  return { remaining, deductionEndTime: NOW + daysFromNow * DAY, active: true }
}

/**
 * 一个账号在「两侧世界」里的等价表示。
 *
 * `pkgs` 走客户端真实的分桶实现（`splitCreditsByExpiry`），再把同一份 split
 * 喂给后端 —— 于是两边看到的是**同一组数值**，差异只可能来自排序/旋转逻辑本身。
 */
interface Account {
  id: string
  pkgs: Pkg[]
}

function clientRow(account: Account) {
  return { accountId: account.id, balance: { packages: account.pkgs } }
}

function backendBalance(account: Account) {
  const split = splitCreditsByExpiry(account.pkgs, WINDOW_DAYS, NOW, IMMINENT_DAYS)
  return {
    id: account.id,
    expiringBalance: split?.expiring ?? 0,
    imminentBalance: split?.imminent ?? 0,
    /**
     * ⚠️ 客户端的 split 把「永久」拆成**两个**字段，后端只有 `permanentBalance` 一个：
     * - `split.permanent` = **到期时间未知**（`deductionEndTime` 缺失）
     * - `split.longTerm` = **有到期时间但超出窗口**
     * 后端 `splitBuddyCreditsByExpiry` 的 `permanent` 是这两者的合并（「≥15 天
     * 或到期时间未知」）⇒ 这里必须相加。只读 `permanent` 会让「30 天后到期」
     * 的账号被判 `none`（不可用），对拍变红但红因在我的映射上（我第一版就踩了）。
     */
    permanentBalance: (split?.permanent ?? 0) + (split?.longTerm ?? 0),
  }
}

interface Scenario {
  name: string
  accounts: Account[]
  enabledAccountIds?: string[]
  rotationStartId?: string
  allowPermanent?: boolean
  strictManualOrder?: boolean
}

/**
 * 复刻**生产链路**（`src/buddy-balance-selector.ts:556-571`）：
 * 先按策略排序，再由 `rotateFromPreferred` 旋转。
 *
 * ⚠️ 不能只调 `rotateFromPreferred` —— 它的入参契约是「**已按策略排好序**的候选」，
 * 直接喂原始泳序会让对拍变成「原始序 vs 排序+旋转」，红因不在被测分支上。
 */
function backendOrder(scenario: Scenario): string[] {
  const options = {
    ...(scenario.rotationStartId === undefined ? {} : { rotationStartId: scenario.rotationStartId }),
    ...(scenario.enabledAccountIds === undefined
      ? {}
      : { enabledAccountIds: scenario.enabledAccountIds }),
    ...(scenario.allowPermanent === undefined ? {} : { allowPermanent: scenario.allowPermanent }),
    ...(scenario.strictManualOrder === undefined
      ? {}
      : { strictManualOrder: scenario.strictManualOrder }),
  }
  const balances = scenario.accounts.map(backendBalance)
  const rankedByStrategy =
    options.strictManualOrder === true
      ? rankBuddyAccountsByManualOrder(balances, options)
      : rankBuddyAccountsByBalance(balances, options)
  return rotateFromPreferred(rankedByStrategy, options).map((balance) => balance.id)
}

function clientOrder(scenario: Scenario): string[] {
  const rows = scenario.accounts.map(clientRow)
  const result = orderCreditRows(rows, {
    windowDays: WINDOW_DAYS,
    imminentDays: IMMINENT_DAYS,
    now: NOW,
    expanded: true,
    ...(scenario.rotationStartId === undefined ? {} : { rotationStartId: scenario.rotationStartId }),
    ...(scenario.enabledAccountIds === undefined
      ? {}
      : { enabledAccountIds: scenario.enabledAccountIds }),
    ...(scenario.allowPermanent === undefined ? {} : { allowPermanent: scenario.allowPermanent }),
    ...(scenario.strictManualOrder === undefined
      ? {}
      : { strictManualOrder: scenario.strictManualOrder }),
  })
  return result.shown.map((row) => row.accountId)
}

/** 三档齐备的池：临期 / 短期 / 永久。 */
function mixedPool(): Account[] {
  return [
    { id: 'A-perm', pkgs: [pkg(100, 30)] },
    { id: 'B-imminent', pkgs: [pkg(100, 1)] },
    { id: 'C-short', pkgs: [pkg(100, 10)] },
    { id: 'D-imminent', pkgs: [pkg(100, 2)] },
  ]
}

const PARITY: Scenario[] = [
  // ---- 基础：起点缺省 ----
  { name: '起点缺省 ⇒ 档位序', accounts: mixedPool() },
  { name: '起点空串 ⇒ 与缺省相同', accounts: mixedPool(), rotationStartId: '' },

  // ---- 起点在候选里 ----
  { name: '起点 = 永久档（S5：起点绝对第一）', accounts: mixedPool(), rotationStartId: 'A-perm' },
  { name: '起点 = 短期档', accounts: mixedPool(), rotationStartId: 'C-short' },
  { name: '起点 = 临期档第二个', accounts: mixedPool(), rotationStartId: 'D-imminent' },

  // ---- 起点不在候选里（被封禁/限流过滤掉），但仍在 enabledAccountIds ----
  {
    name: '★ 起点被封禁：池 [A,B,C,D]、C 不在候选',
    accounts: [mixedPool()[0]!, mixedPool()[1]!, mixedPool()[3]!],
    enabledAccountIds: ['A-perm', 'B-imminent', 'C-short', 'D-imminent'],
    rotationStartId: 'C-short',
  },
  {
    name: '★ 起点被封禁且是池里最后一位 ⇒ 绕回开头',
    accounts: [mixedPool()[0]!, mixedPool()[1]!],
    enabledAccountIds: ['A-perm', 'B-imminent', 'C-short'],
    rotationStartId: 'C-short',
  },
  {
    name: '起点已从池里删除（不在 enabledAccountIds）⇒ 原样',
    accounts: [mixedPool()[0]!, mixedPool()[1]!],
    enabledAccountIds: ['A-perm', 'B-imminent'],
    rotationStartId: 'Z-gone',
  },

  // ---- 起点在候选里但不可用 ----
  {
    name: '★ 起点无余额（none）⇒ 后端跳到下一个可用',
    accounts: [mixedPool()[0]!, { id: 'E-empty', pkgs: [] }, mixedPool()[1]!],
    rotationStartId: 'E-empty',
  },

  // ---- 锁定永久积分 ----
  {
    name: '★ 锁定永久（allowPermanent=false）⇒ 只剩永久的号沉底',
    accounts: mixedPool(),
    allowPermanent: false,
  },
  {
    name: '★ 锁定永久 + 起点是永久档（起点不可用）',
    accounts: mixedPool(),
    allowPermanent: false,
    rotationStartId: 'A-perm',
  },

  // ---- 锁定永久积分下「不可用」的两类账号之间的相对序（分组口径格）----
  {
    name: '★ 锁定永久：只剩永久（不可用）与无余额（不可用）的相对序',
    accounts: [{ id: 'E-empty', pkgs: [] }, mixedPool()[0]!],
    allowPermanent: false,
  },

  {
    name: '★ 锁定永久 + 起点可用：不可用的两类账号归哪一组（分组口径格）',
    accounts: [mixedPool()[1]!, { id: 'E-empty', pkgs: [] }, mixedPool()[0]!],
    allowPermanent: false,
    rotationStartId: 'B-imminent',
  },

  // ---- 严格手动顺序 ----
  { name: '严格手动顺序 ⇒ 只按位次', accounts: mixedPool(), strictManualOrder: true },
  {
    name: '严格手动顺序 + 起点',
    accounts: mixedPool(),
    strictManualOrder: true,
    rotationStartId: 'D-imminent',
  },
]

describe('前后端轮换顺序对拍（弹窗顺序必须等于真实选号顺序）', () => {
  for (const scenario of PARITY) {
    it(scenario.name, () => {
      expect(clientOrder(scenario)).toEqual(backendOrder(scenario))
    })
  }
})

/**
 * ★★ `rotationIdsOf` / `rotationOrderOptionsOf`：**生产接线的纯函数部分**。
 *
 * 背景：`usage-badge.js` 依赖宿主注入的 `react`（esbuild external，本仓
 * node_modules 里没有）⇒ 无法在 vitest 里 import，留在那里的 if 分支只能靠
 * 源码文本断言看守，而本仓已四次证明那类断言挡不住「留着但失效」。
 * ⇒ 把「从 `account.getRotation` 返回值构造排序参数」整段抽成纯函数，
 *   在**行为级**钉住两条不变量；接线层只剩一个 spread（另由
 *   `usage-badge-client.spec.ts` 做存在性断言 + 如实登记其局限）。
 *
 * 这两条不变量直接决定对拍用例里「起点被封禁」那格在**生产**上是否成立：
 * 少了 `enabledAccountIds`，弹窗就退化成「找不到起点 ⇒ 原样」，而真实选号
 * 已从起点之后的第一个可用号开始。
 */
describe('rotationOrderOptionsOf：起点参数的生产来源', () => {
  const state = (accounts: unknown, selected?: unknown) => ({ accounts, selected })

  it('★★ 有起点 + 有池序 ⇒ 两个字段都给', () => {
    expect(rotationOrderOptionsOf(state([{ id: 'a' }, { id: 'b' }], 'b')))
      .toEqual({ rotationStartId: 'b', enabledAccountIds: ['a', 'b'] })
  })

  it('★★ 无起点 ⇒ 两个字段**都不出现**（不是 undefined 值，是没有键）', () => {
    const options = rotationOrderOptionsOf(state([{ id: 'a' }], null))
    expect(Object.keys(options)).toEqual([])
    expect('rotationStartId' in options).toBe(false)
    expect('enabledAccountIds' in options).toBe(false)
  })

  it('★ 有起点但池序拿不到（老宿主 / RPC 超时后 state 为 null）⇒ 只给起点', () => {
    expect(rotationOrderOptionsOf(state([], 'b'))).toEqual({ rotationStartId: 'b' })
    expect(rotationOrderOptionsOf(state(undefined, 'b'))).toEqual({ rotationStartId: 'b' })
  })

  it('★ state 为 null / 非对象 ⇒ 空选项（不抛）', () => {
    for (const bad of [null, undefined, 'x', 42, true]) {
      expect(rotationOrderOptionsOf(bad)).toEqual({})
    }
  })

  it('★ 起点是空串 / 非字符串 ⇒ 空选项（与「无起点」同义）', () => {
    for (const bad of ['', 0, null, undefined, {}, []]) {
      expect(rotationOrderOptionsOf(state([{ id: 'a' }], bad))).toEqual({})
    }
  })

  it('★★ rotationIdsOf 逐条丢弃坏形状，且**不去重**', () => {
    expect(rotationIdsOf(state([{ id: 'a' }, null, 'x', { id: '' }, { id: 7 }, { id: 'b' }, { id: 'a' }])))
      .toEqual(['a', 'b', 'a'])
  })

  it('★ rotationIdsOf 对 null / 非数组 accounts 都返回空数组', () => {
    for (const bad of [null, undefined, {}, 'x', 42, { accounts: null }, { accounts: 'x' }]) {
      expect(rotationIdsOf(bad)).toEqual([])
    }
  })

  it('★★ 池序与弹窗候选序**不同**时，定位仍按池序（这两份列表不是同一样东西）', () => {
    // 候选（已按策略排）= [D-imminent, A-perm, B-imminent]；池序 = [A, B, C, D]。
    // 起点 C 不在候选里 ⇒ 池位次 2 ⇒ 候选里「池位次 ≥ 2」的第一个是 D。
    const accounts = [
      { id: 'A-perm' }, { id: 'B-imminent' }, { id: 'C-short' }, { id: 'D-imminent' },
    ]
    const options = rotationOrderOptionsOf(state(accounts, 'C-short'))
    expect(options.enabledAccountIds).toEqual(['A-perm', 'B-imminent', 'C-short', 'D-imminent'])
    /**
     * ⚠️ 必须过 `clientRow()` 转成**客户端行形状**（`{ accountId, balance.packages }`）：
     * 直接喂 `Account`（含 `pkgs`）时 `tierOf` 读不到 `balance.packages` ⇒
     * 全部判 `none` ⇒ 排序与旋转都不发生、静默返回原序（我第一版就这么假绿过一条）。
     */
    const rows = mixedPool()
      .filter((account) => account.id !== 'C-short')
      .map(clientRow)
    // 策略序（档位序）：临期 B、D → 短期（无）→ 永久 A
    /**
     * ⚠️ 窗口参数必须与 `clientOrder()` **同一份**：不传时 `orderCreditRows`
     * 走默认值（`undefined` ⇒ `splitCreditsByExpiry` 的内部默认），若与
     * `WINDOW_DAYS`/`IMMINENT_DAYS` 不同，分档结果与断言用常量不一致 ——
     * 我第一版漏传，症状是「所有行判 none ⇒ 旋转不发生 ⇒ 静默返回原序」，
     * 红因不在被测分支上。
     */
    const { shown } = orderCreditRows(rows, {
      windowDays: WINDOW_DAYS,
      imminentDays: IMMINENT_DAYS,
      now: NOW,
      limit: 99,
      expanded: true,
      ...options,
    })
    // ⚠️ 客户端行的身份字段是 `accountId`（`clientRow()` 的产物），不是 `id`。
    expect(shown.map((row) => row.accountId)).toEqual(['D-imminent', 'B-imminent', 'A-perm'])
  })
})

/**
 * ★★ **六个排序输入的行为级看守**（2026-11-18 正向审计 P1-2 的直接产物）。
 *
 * 审计在 `usage-badge.js` 上逐个删掉/写死这六个输入，**六个变异全部全绿**：
 * | 变异 | 用户可见后果 |
 * |---|---|
 * | 删 `imminentDays` | 临期档退化成短期档（三档变两档）|
 * | `allowPermanent` 写死 `true` | 「锁定永久」在弹窗里失效（开关显示已开）|
 * | 删 `rotationStartId` | 轮换起点整体失效 |
 * | 删 `windowDays` | 短期/长期边界错位 |
 * | `strictManualOrder` 写死 `false` | 「严格手动顺序」开关失效 |
 * | 渲染出口改 `accounts.map` | 排序结果整条丢弃 |
 *
 * 根因是该文件依赖宿主注入的 `react`、**无法 import 进 vitest**。前五个现已由
 * `creditOrderOptionsOf` 收进纯函数（本 describe 逐格钉死）；第六个（渲染出口）
 * 仍只能源码断言，其局限在 `usage-badge-client.spec.ts` 对应用例里如实登记。
 */
describe('creditOrderOptionsOf：六个排序输入都必须真的进选项', () => {
  const base = () => ({
    limit: 5,
    expanded: false,
    strictManualOrder: false,
    locked: false,
    windowDays: 15,
    imminentDays: 5,
    now: 1_700_000_000_000,
    rotationState: null,
  })

  it('★★ `strictManualOrder` 必须透传（写死 false ⇒ 严格手动顺序开关失效）', () => {
    expect(creditOrderOptionsOf({ ...base(), strictManualOrder: true }).strictManualOrder).toBe(true)
    expect(creditOrderOptionsOf({ ...base(), strictManualOrder: false }).strictManualOrder).toBe(false)
    // 非布尔一律按关闭（与后端 `=== true` 判据同口径）
    for (const bad of [undefined, null, 0, 1, 'true', {}]) {
      expect(creditOrderOptionsOf({ ...base(), strictManualOrder: bad }).strictManualOrder).toBe(false)
    }
  })

  it('★★ `locked` ⇒ `allowPermanent` 取反（写死 true ⇒ 锁定永久在弹窗失效）', () => {
    expect(creditOrderOptionsOf({ ...base(), locked: true }).allowPermanent).toBe(false)
    expect(creditOrderOptionsOf({ ...base(), locked: false }).allowPermanent).toBe(true)
    // 非 true 一律视为未锁定（与 `value?.locked === true` 同口径）
    for (const bad of [undefined, null, 0, 1, 'true', {}]) {
      expect(creditOrderOptionsOf({ ...base(), locked: bad }).allowPermanent).toBe(true)
    }
  })

  it('★★ `windowDays`/`imminentDays` 有限数才进选项，且 **0 是合法值**', () => {
    const options = creditOrderOptionsOf({ ...base(), windowDays: 20, imminentDays: 0 })
    expect(options.windowDays).toBe(20)
    // ⚠️ 0 必须保留：后端 `src/buddy-balance-rank.ts` 明写「`imminentDays: 0` 可关掉临期档」
    expect(options.imminentDays).toBe(0)
    expect('imminentDays' in options).toBe(true)
  })

  it('★★ 非有限数 ⇒ 键**不出现**（不是 `undefined` 值）', () => {
    const options = creditOrderOptionsOf({ ...base(), windowDays: undefined, imminentDays: NaN })
    expect('windowDays' in options).toBe(false)
    expect('imminentDays' in options).toBe(false)
    expect('rotationStartId' in options).toBe(false)
    expect('enabledAccountIds' in options).toBe(false)
  })

  it('★★ `now` 现取：传入则用传入值，不传/非有限数则取当前时刻', () => {
    expect(creditOrderOptionsOf({ ...base(), now: 1234 }).now).toBe(1234)
    const before = Date.now()
    const fallback = creditOrderOptionsOf({ ...base(), now: undefined }).now
    expect(fallback).toBeGreaterThanOrEqual(before)
    expect(Number.isFinite(fallback)).toBe(true)
  })

  it('★★ `limit`/`expanded` 透传（折叠逻辑）', () => {
    expect(creditOrderOptionsOf({ ...base(), limit: 3, expanded: true }))
      .toMatchObject({ limit: 3, expanded: true })
    expect(creditOrderOptionsOf({ ...base(), limit: undefined })).toMatchObject({ limit: 0, expanded: false })
  })

  it('★★ 轮换两项与六个输入**合并**（不是互相覆盖）', () => {
    const options = creditOrderOptionsOf({
      ...base(),
      rotationState: { selected: 'B-imminent', accounts: [{ id: 'A-perm' }, { id: 'B-imminent' }] },
    })
    expect(options.rotationStartId).toBe('B-imminent')
    expect(options.enabledAccountIds).toEqual(['A-perm', 'B-imminent'])
    // 六个输入仍在位
    expect(options).toMatchObject({ limit: 5, strictManualOrder: false, allowPermanent: true, windowDays: 15, imminentDays: 5 })
  })

  it('★ 入参为 null / 非对象 ⇒ 不抛，给一份可用默认值', () => {
    for (const bad of [null, undefined, 'x', 42]) {
      const options = creditOrderOptionsOf(bad)
      expect(options.limit).toBe(0)
      expect(options.allowPermanent).toBe(true)
      expect(Number.isFinite(options.now)).toBe(true)
    }
  })
})
