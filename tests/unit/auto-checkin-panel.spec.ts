/**
 * 定时签到面板的**纯函数**回归（用户报障 2026-10-18；2026-10-31 重建）。
 *
 * 报障原文：「为什么我按钮打开还是显示下次执行：不会执行（开关已关闭）」。
 * 根因不是逻辑算错，而是**把两种完全不同的状态混成了一个文案**：
 * 插件已更新（客户端新）但宿主进程仍是旧代码（启动早于构建）⇒ 响应里没有
 * `nextRunAt` 字段，旧实现把 `undefined` 与 `0` 一律说成「开关已关闭」，
 * 而同一面板上方的开关明明勾着 —— 自相矛盾，把人引向「去查开关」这个错方向。
 */
import { describe, expect, it } from 'vitest'
import { checkinCommitPlan, formatNextRunAt, isInsideCheckinDock, needsHostRestartNotice } from '../../plugin-src/client/checkin-panel-logic.js'

/** 2026-10-18 12:00（本地时区）。 */
const NOON = new Date(2026, 9, 18, 12, 0, 0).getTime()

describe('定时签到面板：下次执行文案', () => {
  it('★ 字段缺失（旧宿主）⇒ 明确说「宿主版本较旧」，**绝不**说成开关已关闭', () => {
    const text = formatNextRunAt(undefined, NOON)
    expect(text).toContain('宿主版本较旧')
    expect(text).not.toContain('开关已关闭')
    expect(formatNextRunAt(null, NOON)).not.toContain('开关已关闭')
    expect(formatNextRunAt(Number.NaN, NOON)).toContain('宿主版本较旧')
  })

  it('★ 值为 0 ⇒ 才是「不会执行（开关已关闭）」（宿主明确算出来的）', () => {
    expect(formatNextRunAt(0, NOON)).toBe('不会执行（开关已关闭）')
    expect(formatNextRunAt(-1, NOON)).toBe('不会执行（开关已关闭）')
  })

  it('今天稍后的时刻 ⇒ 「今天 HH:MM（N 小时 M 分后）」', () => {
    const at = new Date(2026, 9, 18, 21, 0, 0).getTime()
    expect(formatNextRunAt(at, NOON)).toBe('今天 21:00（9 小时 0 分后）')
  })

  it('明天的时刻 ⇒ 「明天 HH:MM」而不是「今天」', () => {
    const at = new Date(2026, 9, 19, 9, 0, 0).getTime()
    const text = formatNextRunAt(at, NOON)
    expect(text).toContain('明天 09:00')
    expect(text).not.toContain('今天')
  })

  it('已到点 / 毫秒级抖动 ⇒ 「马上执行」，不显示「0 分后」', () => {
    expect(formatNextRunAt(NOON, NOON)).toBe('马上执行（有时段待补）')
    expect(formatNextRunAt(NOON - 500, NOON)).toBe('马上执行（有时段待补）')
  })

  it('不足一小时 ⇒ 「N 分后」（不说成「0 小时 N 分后」）', () => {
    const at = NOON + 25 * 60_000
    expect(formatNextRunAt(at, NOON)).toBe('今天 12:25（25 分后）')
  })
})

describe('定时签到面板：旧宿主识别', () => {
  it('★ 缺 times ⇒ 判定为「旧宿主」，面板要显示重启提示', () => {
    expect(needsHostRestartNotice({ enabled: true, lastResult: 'x' })).toBe(true)
    expect(needsHostRestartNotice({ enabled: true, times: undefined })).toBe(true)
    expect(needsHostRestartNotice({ enabled: true, times: 'not-an-array' })).toBe(true)
  })

  it('有 times 数组 ⇒ 不是旧宿主（新宿主正常渲染下次执行）', () => {
    expect(needsHostRestartNotice({ enabled: true, times: ['09:00', '21:00'], nextRunAt: 123 })).toBe(false)
    expect(needsHostRestartNotice({ enabled: true, times: [] })).toBe(false)
  })

  it('状态还没读回来（null/undefined）⇒ 不报「旧宿主」（那是「读取中」）', () => {
    expect(needsHostRestartNotice(null)).toBe(false)
    expect(needsHostRestartNotice(undefined)).toBe(false)
  })
})

/**
 * 点击外部关闭的命中判据（用户 2026-10-31 报障：「点击外面的区域为什么不会收回」）。
 *
 * 两件事必须同时成立，任一漏掉都会让面板关不掉或关一次闪一次：
 * 1. 点在容器**之外** ⇒ 关闭；
 * 2. 点在容器**之内**（含触发按钮 ▾ 本身）⇒ 不关 —— 否则「点 ▾」会先被判定为
 *    外部而关闭、紧接着按钮 onClick 又打开，表现为「闪一下、关不掉」。
 */
describe('定时签到面板：点击外部关闭的命中判据', () => {
  /** 模拟 `wrap.contains`：只认自己登记过的节点。 */
  const makeContains = (inside) => (node) => inside.has(node)

  it('★ 点在容器内部（面板或按钮）⇒ 不关闭', () => {
    const panel = { name: 'panel' }
    const caret = { name: 'caret' }
    const inside = new Set([panel, caret])
    expect(isInsideCheckinDock({ contains: makeContains(inside), target: panel, isNode: true })).toBe(true)
    // ★ 触发按钮本身也必须在「内部」：否则点 ▾ 会闪一下又打开
    expect(isInsideCheckinDock({ contains: makeContains(inside), target: caret, isNode: true })).toBe(true)
  })

  it('★ 点在容器外部 ⇒ 关闭', () => {
    const panel = { name: 'panel' }
    const outside = { name: 'outside' }
    const inside = new Set([panel])
    expect(isInsideCheckinDock({ contains: makeContains(inside), target: outside, isNode: true })).toBe(false)
  })

  it('非节点 / null target ⇒ 按**外部**处理（认不出来就关，否则永远关不掉）', () => {
    const inside = new Set([{ name: 'panel' }])
    expect(isInsideCheckinDock({ contains: makeContains(inside), target: { name: 'x' }, isNode: false })).toBe(false)
    expect(isInsideCheckinDock({ contains: makeContains(inside), target: null, isNode: true })).toBe(false)
    expect(isInsideCheckinDock({ contains: makeContains(inside), target: undefined, isNode: true })).toBe(false)
  })
})

/**
 * 关闭面板时「该不该提交什么」的判据（真实缺陷，2026-11-01 实测）。
 *
 * 报障链条：改完时刻 → 点外部关闭 → 改动**静默丢失**，界面看不出异常。
 * 根因是关闭动作由**早期注册的监听**触发，闭包捕获的是旧 state ⇒ 提交的是旧草稿。
 * 修法：关闭时读 ref（最新值），并把「该不该提交」抽成纯函数以便测。
 */
describe('定时签到面板：关闭时的提交判据', () => {
  const HOST = ['09:00', '21:00']

  it('★ 时刻改过 ⇒ 必须提交（这就是「静默丢失」那一格）', () => {
    const plan = checkinCommitPlan({
      hostTimes: HOST, hostJitter: 0,
      draftTimes: ['23:30', '21:00'], draftJitterOn: false, draftJitterMinutes: 10,
    })
    expect(plan).not.toBeNull()
    expect(plan.times).toEqual(['23:30', '21:00'])
    expect(plan.jitterMinutes).toBe(0)
  })

  it('★ 只改浮动幅度 ⇒ 也必须提交（否则用户以为设置没生效）', () => {
    const plan = checkinCommitPlan({
      hostTimes: HOST, hostJitter: 0,
      draftTimes: [...HOST], draftJitterOn: true, draftJitterMinutes: 20,
    })
    expect(plan).not.toBeNull()
    expect(plan.jitterMinutes).toBe(20)
  })

  it('★ 什么都没改 ⇒ 不提交（避免白跑 RPC 与无谓重排）', () => {
    expect(checkinCommitPlan({
      hostTimes: HOST, hostJitter: 0,
      draftTimes: [...HOST], draftJitterOn: false, draftJitterMinutes: 10,
    })).toBeNull()
  })

  it('★ 改完又改回去 ⇒ 不提交（判据是「与宿主不一致」，不是 dirty 布尔）', () => {
    expect(checkinCommitPlan({
      hostTimes: HOST, hostJitter: 20,
      draftTimes: [...HOST], draftJitterOn: true, draftJitterMinutes: 20,
    })).toBeNull()
  })

  it('★ 宿主时刻读不到 ⇒ 绝不提交（否则会把真实设置覆盖成本地默认值）', () => {
    expect(checkinCommitPlan({
      hostTimes: undefined, hostJitter: 0,
      draftTimes: ['08:00', '20:00'], draftJitterOn: true, draftJitterMinutes: 20,
    })).toBeNull()
    expect(checkinCommitPlan({
      hostTimes: [], hostJitter: 0,
      draftTimes: ['08:00', '20:00'], draftJitterOn: true, draftJitterMinutes: 20,
    })).toBeNull()
    expect(checkinCommitPlan({
      hostTimes: ['09:00'], hostJitter: 0,
      draftTimes: ['08:00', '20:00'], draftJitterOn: true, draftJitterMinutes: 20,
    })).toBeNull()
  })

  it('浮动开关关掉 ⇒ 提交的 jitterMinutes 必须是 0（不是保留旧值）', () => {
    const plan = checkinCommitPlan({
      hostTimes: HOST, hostJitter: 20,
      draftTimes: [...HOST], draftJitterOn: false, draftJitterMinutes: 20,
    })
    expect(plan).not.toBeNull()
    expect(plan.jitterMinutes).toBe(0)
  })
})
