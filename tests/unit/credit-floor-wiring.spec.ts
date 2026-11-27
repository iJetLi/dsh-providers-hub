/**
 * ★★★ **积分阈值：存储 / 解析 / 覆盖数**
 *
 * 覆盖三个容易漏的环节：
 *
 * | 环节 | 漏了的后果 |
 * |---|---|
 * | `sanitizeCreditWindows` | 阈值存进去读不回来（静默消失）|
 * | `resolveCreditWindow` | 读到了但没传给选号层 |
 * | `computeCoverage` | 面板显示「覆盖 5 个号」，实际只认 2 个（覆盖数骗人）|
 * | `isWindowDirty` | 只改阈值 ⇒ 保存按钮不亮 ⇒ **改不掉** |
 */
import { describe, expect, it } from 'vitest'

import { isEmptyCreditWindowSetting, resolveCreditWindow } from '../../src/credit-window.js'
import { sanitizeCreditWindows } from '../../src/jet-hub-store.js'
import { computeCoverage, isWindowDirty, parseFloorInput, resolveFloor } from '../../plugin-src/client/credit-window-ui.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 27, 0, 0, 0)

describe('★★★ 阈值存储：sanitizeCreditWindows', () => {
  it('★★★ 两个阈值能存能读（往返不丢）', () => {
    const out = sanitizeCreditWindows({
      buddy: { windowDays: 15, imminentDays: 5, imminentFloor: 20, expiringFloor: 30 },
    })
    expect(out.buddy?.imminentFloor, '★★★ 临期阈值必须保留').toBe(20)
    expect(out.buddy?.expiringFloor, '★★★ 短期阈值必须保留').toBe(30)
  })

  it('★★★ **0 会保留成 0**（不归一成 undefined）', () => {
    /**
     * ⚠️ 用户输 `0` 时，面板必须显示他输的值。
     * 若这里把 0 归一成 undefined，用户会看到「我输的 0 变成空白」。
     *
     * ⚠️ 选号语义上 0 与 undefined **等价**（都是关闭），但**存储不合并**。
     */
    const out = sanitizeCreditWindows({ buddy: { windowDays: 15, imminentFloor: 0 } })
    expect(out.buddy?.imminentFloor, '★ 0 必须原样保留').toBe(0)
  })

  it('★★★ 只配阈值、不配窗口天数 ⇒ **整条不能丢**', () => {
    /**
     * ⚠️ 这是最容易漏的一格。原判据是
     * 「windowDays/imminentDays/subagent 三者都没读到 ⇒ 整条丢弃」。
     *
     * 若不把两个阈值加进这条判据，「只设阈值、用默认窗口」这种**合法配置**
     * 会被整条丢掉 ⇒ 阈值静默失效（下次读回是默认值 = 没有阈值）。
     */
    const out = sanitizeCreditWindows({ buddy: { imminentFloor: 20 } })
    expect(out.buddy, '★★★ 只配阈值也必须保留整条').toBeDefined()
    expect(out.buddy?.imminentFloor).toBe(20)
    expect(out.buddy?.windowDays).toBeUndefined()
  })

  it('★★ 非法阈值（负数 / NaN / 字符串）⇒ 丢弃该字段', () => {
    const out = sanitizeCreditWindows({
      a: { windowDays: 15, imminentFloor: -5 },
      b: { windowDays: 15, imminentFloor: '20' },
      c: { windowDays: 15, expiringFloor: Number.NaN },
    })
    expect(out.a?.imminentFloor, '★ 负数丢弃').toBeUndefined()
    expect(out.b?.imminentFloor, '★ 数字字符串丢弃（与 readDays 同纪律）').toBeUndefined()
    expect(out.c?.expiringFloor, '★ NaN 丢弃').toBeUndefined()
  })

  it('★★ 空对象仍然整条丢弃（不留噪音键）', () => {
    expect(sanitizeCreditWindows({ buddy: {} })).toEqual({})
  })
})

describe('★★★ 阈值解析：resolveCreditWindow', () => {
  const mk = (setting: { imminentFloor?: number, expiringFloor?: number } | undefined) =>
    resolveCreditWindow('buddy', () => setting as never, {
      buddyExpiringWindowDays: () => 15,
      buddyImminentWindowDays: () => 5,
    })

  it('★★★ 阈值被解析出来（恒为数字）', () => {
    const r = mk({ imminentFloor: 20, expiringFloor: 30 })
    expect(r.imminentFloor, '★★★ 必须解析出临期阈值').toBe(20)
    expect(r.expiringFloor, '★★★ 必须解析出短期阈值').toBe(30)
  })

  it('★★★ 未设置 ⇒ **0**（不是 undefined）', () => {
    /**
     * ⚠️ 声明为「恒数字」是有意的：调用方（`buddyBalanceTier`）直接做
     * `> floor` 即可。若允许 undefined，每个消费点都得再判一次，必然有人漏。
     */
    const r = mk(undefined)
    expect(r.imminentFloor, '★★ undefined ⇒ 0').toBe(0)
    expect(r.expiringFloor).toBe(0)
  })

  it('★★ 非法阈值 ⇒ 归 0（方向保守：不降级）', () => {
    const r = mk({ imminentFloor: -10, expiringFloor: Number.NaN })
    expect(r.imminentFloor, '★ 负数 ⇒ 0').toBe(0)
    expect(r.expiringFloor, '★ NaN ⇒ 0').toBe(0)
  })

  it('★★ 阈值不参与 `source` 判定（它没有 env / default 两级）', () => {
    /**
     * ⚠️ 「来源」问的是「**窗口天数**从哪来」。阈值只有「用户设了/没设」，
     * 没有环境变量与默认值 ⇒ 只设阈值时不该把 source 变成 `'setting'`。
     */
    const r = mk({ imminentFloor: 20 })
    expect(r.source, '★★ 只设阈值 ⇒ source 仍为 default').toBe('default')
  })

  it('★★ `isEmptyCreditWindowSetting` 必须把阈值算进来', () => {
    /**
     * ⚠️ 只看窗口天数的话，「只配了阈值」会被判成「空」
     * ⇒ 某个「空就清掉整条」的分支会**静默删掉用户的阈值**。
     */
    expect(isEmptyCreditWindowSetting({ imminentFloor: 20 }), '★★ 只设阈值 ⇒ 非空').toBe(false)
    expect(isEmptyCreditWindowSetting({ expiringFloor: 30 }), '★★ 同上').toBe(false)
    expect(isEmptyCreditWindowSetting({}), '★ 真空 ⇒ 空').toBe(true)
    expect(isEmptyCreditWindowSetting(undefined), '★ undefined ⇒ 空').toBe(true)
  })
})

describe('★★★ 覆盖数：computeCoverage 接阈值', () => {
  /** 一包「2 天后到期、剩 2 点」= 临期但量很少。 */
  const fewImminent = [{ remaining: 2, active: true, deductionEndTime: NOW + 2 * DAY }]
  /** 一包「2 天后到期、剩 500 点」。 */
  const muchImminent = [{ remaining: 500, active: true, deductionEndTime: NOW + 2 * DAY }]

  it('★★★ 临期不足阈值 ⇒ **不计入**临期覆盖', () => {
    /**
     * 用户明确要求「改阈值立刻看到覆盖数变化」。
     *
     * ⚠️ 若不接阈值：面板显示「临期覆盖 1 个号」，而实际选号只有 0 个
     *   ⇒ **覆盖数骗人** —— 比没有这个功能更糟。
     */
    const accounts = [{ id: 'a', packages: fewImminent }]
    const off = computeCoverage(accounts, 15, 5, NOW, 0, 0)
    const on = computeCoverage(accounts, 15, 5, NOW, 20, 0)
    expect(off.imminentAccounts, '★ 阈值关闭 ⇒ 临期覆盖 1 个').toBe(1)
    expect(on.imminentAccounts, '★★★ 阈值 20（剩余 2 不足）⇒ 临期覆盖 0 个').toBe(0)
  })

  it('★★★ 但**金额照样累加**（降级不消灭积分）', () => {
    /**
     * 用户第 6 条定案：降级只改**排队顺序**，不改「烧包顺序」。
     * ⇒ 那点临期还在，金额必须照样显示。
     */
    const accounts = [{ id: 'a', packages: fewImminent }]
    const on = computeCoverage(accounts, 15, 5, NOW, 20, 0)
    expect(on.imminentAmount, '★★★ 金额不受阈值影响（那 2 点还在）').toBe(2)
  })

  it('★★ 充足预算不受影响（避免「一律清零」的假绿）', () => {
    const accounts = [{ id: 'a', packages: muchImminent }]
    const on = computeCoverage(accounts, 15, 5, NOW, 20, 0)
    expect(on.imminentAccounts, '★★ 剩 500 > 阈值 20 ⇒ 仍算临期').toBe(1)
  })
})

describe('★★★ dirty 判据：只改阈值必须能保存', () => {
  const saved = { windowDays: 15, imminentDays: 5, imminentFloor: 20, expiringFloor: 30 }

  it('★★★ 只改阈值 ⇒ dirty（否则保存按钮不亮 = 改不掉）', () => {
    /**
     * ⚠️ 这是最容易漏的一格：窗口天数的 dirty 判据看起来很「完整」，
     * 漏掉阈值 ⇒ 用户改阈值后保存按钮**不亮** ⇒ 静默改不掉（且无报错）。
     */
    const d = isWindowDirty({
      saved,
      draftWindow: '15',
      draftImminent: '5',
      draftImminentFloor: '25',
      draftExpiringFloor: '30',
    })
    expect(d, '★★★ 临期阈值 20→25 ⇒ 必须 dirty').toBe(true)
  })

  it('★★★ 全部一致 ⇒ 不 dirty（否则按钮永远亮着 = 假脏）', () => {
    const d = isWindowDirty({
      saved,
      draftWindow: '15',
      draftImminent: '5',
      draftImminentFloor: '20',
      draftExpiringFloor: '30',
    })
    expect(d, '★★ 无改动 ⇒ 不 dirty').toBe(false)
  })

  it('★★★ 0 / 空串 / undefined 归一化后等价（避免假脏）', () => {
    /**
     * ⚠️ 用户把一个已设的阈值清空 ⇒ 保存后后端存 `0` ⇒ 回填草稿是 `''`。
     * 若三者不归一，重新打开弹窗会**立刻显示「可保存」**（假脏）。
     */
    const savedZero = { windowDays: 15, imminentDays: 5, imminentFloor: 0 }
    const d = isWindowDirty({
      saved: savedZero,
      draftWindow: '15',
      draftImminent: '5',
      draftImminentFloor: '',
    })
    expect(d, '★★ 存 0 + 草稿空 ⇒ 不 dirty').toBe(false)
  })
})

describe('★★★ 阈值输入解析：parseFloorInput', () => {
  it('★★★ 合法值', () => {
    expect(parseFloorInput('20'), '★ 正常数字').toBe(20)
    expect(parseFloorInput('0'), '★ **0 合法**（= 关闭）').toBe(0)
    expect(parseFloorInput('36500'), '★ 上限').toBe(36500)
    expect(parseFloorInput('  7  '), '★ 两侧空白可容忍').toBe(7)
  })

  it('★★★ 空 = undefined（未填），不是 0', () => {
    expect(parseFloorInput('')).toBeUndefined()
    expect(parseFloorInput('   ')).toBeUndefined()
  })

  it('★★ 非法值 ⇒ null', () => {
    expect(parseFloorInput('-1'), '★ 负数').toBeNull()
    expect(parseFloorInput('abc'), '★ 非数字').toBeNull()
    expect(parseFloorInput('5.5'), '★ 小数（积分是整数）').toBeNull()
    expect(parseFloorInput('36501'), '★ 超上限').toBeNull()
  })

  it('★★ resolveFloor：非法/空 ⇒ 回落已存值；合法 ⇒ 用输入', () => {
    expect(resolveFloor(25, 20), '★ 用户输入优先').toBe(25)
    expect(resolveFloor(null, 20), '★ 非法 ⇒ 回落已存值（不静默改写）').toBe(20)
    expect(resolveFloor(undefined, 20), '★ 空 ⇒ 回落已存值').toBe(20)
    expect(resolveFloor(undefined, undefined), '★ 都没有 ⇒ 0').toBe(0)
    expect(resolveFloor(0, 20), '★★ 用户输 0 ⇒ **用它**（关掉）').toBe(0)
  })
})
