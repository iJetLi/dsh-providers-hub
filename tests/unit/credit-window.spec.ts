/**
 * per-provider 分档窗口（2026-11-19）的**行为守卫**。
 *
 * ## 这个功能的三个核心承诺（本文件逐条钉住）
 *
 * 1. **三级优先级**：本渠道设置 > 环境变量 > 内置默认；
 * 2. **保存即生效**：消费者每次现读，不得缓存（否则要重启/重选模型）；
 * 3. **向后兼容**：老 state.json 无该键 ⇒ 行为与改动前**逐字节一致**。
 */
import { describe, expect, it } from 'vitest'
import {
  sanitizeCreditWindows,
} from '../../src/jet-hub-store.js'
import {
  MAX_CREDIT_WINDOW_DAYS,
  isEmptyCreditWindowSetting,
  resolveCreditWindow,
} from '../../src/credit-window.js'

/** 造一个「环境变量」替身。 */
const envOf = (windowDays: number, imminentDays: number) => ({
  buddyExpiringWindowDays: () => windowDays,
  buddyImminentWindowDays: () => imminentDays,
})

/** 造一个「本渠道设置」读取器。 */
const readerOf = (setting) => () => setting

describe('sanitizeCreditWindows：存储层归一化', () => {
  it('★ 非对象 / null / 数组 ⇒ 空表（升级前行为）', () => {
    for (const raw of [undefined, null, [], 'x', 42, true]) {
      expect(sanitizeCreditWindows(raw), `${JSON.stringify(raw)} 应归空表`).toEqual({})
    }
  })

  it('★ 合法值原样保留（含 windowDays / imminentDays 各自单独存在）', () => {
    expect(sanitizeCreditWindows({ trae: { windowDays: 7, imminentDays: 3 } }))
      .toEqual({ trae: { windowDays: 7, imminentDays: 3 } })
    // 只设一项也合法
    expect(sanitizeCreditWindows({ trae: { windowDays: 7 } })).toEqual({ trae: { windowDays: 7 } })
    expect(sanitizeCreditWindows({ trae: { imminentDays: 3 } })).toEqual({ trae: { imminentDays: 3 } })
  })

  it('★★ `0` 必须被保留（它是「关掉该档」的合法值，不是「未设置」）', () => {
    expect(sanitizeCreditWindows({ trae: { windowDays: 0 } })).toEqual({ trae: { windowDays: 0 } })
    expect(sanitizeCreditWindows({ trae: { imminentDays: 0 } })).toEqual({ trae: { imminentDays: 0 } })
    // ⚠️ 反向：若用 `if (value)` 判，0 会被当假值丢掉 ⇒ 用户设了 0 却变回默认
  })

  it('⚠️ 脏值丢弃：负数 / 非有限数 / 数字字符串 / NaN', () => {
    expect(sanitizeCreditWindows({ a: { windowDays: -1 } })).toEqual({})
    expect(sanitizeCreditWindows({ a: { windowDays: Infinity } })).toEqual({})
    expect(sanitizeCreditWindows({ a: { windowDays: NaN } })).toEqual({})
    // ⚠️ 数字字符串**不接受**：`'7' * DAY` 会得到 NaN 或字符串拼接
    expect(sanitizeCreditWindows({ a: { windowDays: '7' } })).toEqual({})
  })

  it('⚠️ 空 provider id / 条目非对象 / 两字段都无效 ⇒ 整条丢弃', () => {
    expect(sanitizeCreditWindows({ '': { windowDays: 7 } })).toEqual({})
    expect(sanitizeCreditWindows({ a: 'x' })).toEqual({})
    expect(sanitizeCreditWindows({ a: [] })).toEqual({})
    expect(sanitizeCreditWindows({ a: {} })).toEqual({})
    // 一个字段有效、另一个脏 ⇒ 保留有效的那个
    expect(sanitizeCreditWindows({ a: { windowDays: 7, imminentDays: -1 } }))
      .toEqual({ a: { windowDays: 7 } })
  })
})

describe('resolveCreditWindow：三级优先级', () => {
  it('★★ 本渠道设置 > 环境变量 > 默认', () => {
    // ① 有设置 ⇒ 用设置（即使环境变量不同）
    const withSetting = resolveCreditWindow('trae', readerOf({ windowDays: 7, imminentDays: 3 }), envOf(30, 10))
    expect(withSetting.windowDays).toBe(7)
    expect(withSetting.imminentDays).toBe(3)
    expect(withSetting.source).toBe('setting')

    // ② 无设置 + 环境变量有值 ⇒ 用环境变量
    const withEnv = resolveCreditWindow('trae', readerOf(undefined), envOf(30, 10))
    expect(withEnv.windowDays).toBe(30)
    expect(withEnv.imminentDays).toBe(10)
    expect(withEnv.source).toBe('env')

    // ③ 都无 ⇒ 内置默认
    const withDefault = resolveCreditWindow('trae', readerOf(undefined), envOf(15, 5))
    expect(withDefault.windowDays).toBe(15)
    expect(withDefault.imminentDays).toBe(5)
    expect(withDefault.source).toBe('default')
  })

  it('★★ 只设一个字段 ⇒ 另一字段回落下一级（不是变 0）', () => {
    const partial = resolveCreditWindow('trae', readerOf({ windowDays: 7 }), envOf(15, 5))
    expect(partial.windowDays).toBe(7) // 设置
    expect(partial.imminentDays).toBe(5) // 回落默认
    expect(partial.source).toBe('setting') // 有一项来自设置就算 setting

    const partial2 = resolveCreditWindow('trae', readerOf({ imminentDays: 2 }), envOf(20, 5))
    expect(partial2.windowDays).toBe(20) // 回落环境变量
    expect(partial2.imminentDays).toBe(2)
    expect(partial2.source).toBe('setting')
  })

  it('★★★ 临期 > 短期 ⇒ 钳制到短期，且 `clamped` 为 true', () => {
    const r = resolveCreditWindow('trae', readerOf({ windowDays: 10, imminentDays: 20 }), envOf(15, 5))
    expect(r.windowDays).toBe(10)
    expect(r.imminentDays, '临期必须被钳到 ≤ 短期').toBe(10)
    expect(r.clamped, '必须标记钳制过（弹窗要据此提示用户）').toBe(true)
  })

  it('⚠️ 相等不算钳制（用户填 5/5 是合法配置）', () => {
    const r = resolveCreditWindow('trae', readerOf({ windowDays: 5, imminentDays: 5 }), envOf(15, 5))
    expect(r.imminentDays).toBe(5)
    expect(r.clamped).toBe(false)
  })

  it('★ `0` 生效：设 0 ⇒ 该档真的关掉，不是回落默认', () => {
    const r = resolveCreditWindow('trae', readerOf({ windowDays: 15, imminentDays: 0 }), envOf(15, 5))
    expect(r.imminentDays, '临期 0 ⇒ 全部落短期').toBe(0)
    expect(r.source).toBe('setting')

    const r2 = resolveCreditWindow('trae', readerOf({ windowDays: 0 }), envOf(15, 5))
    expect(r2.windowDays, '短期 0 ⇒ 全部算永久').toBe(0)
    expect(r2.imminentDays, '临期不能超过短期 0').toBe(0)
  })

  it('⚠️ 空 provider ⇒ 视为未设置（不查表）', () => {
    let called = false
    const r = resolveCreditWindow('', () => { called = true; return { windowDays: 7 } }, envOf(15, 5))
    expect(called, '空 provider 不该被查表').toBe(false)
    expect(r.source).toBe('default')
  })

  it('★★ 每次调用都现读：改设置后立刻反映（不需要重启）', () => {
    let current = { windowDays: 15, imminentDays: 5 }
    const reader = () => current
    expect(resolveCreditWindow('trae', reader, envOf(15, 5)).windowDays).toBe(15)
    // 模拟用户保存
    current = { windowDays: 7, imminentDays: 3 }
    expect(resolveCreditWindow('trae', reader, envOf(15, 5)).windowDays).toBe(7)
    expect(resolveCreditWindow('trae', reader, envOf(15, 5)).imminentDays).toBe(3)
  })
})

describe('isEmptyCreditWindowSetting', () => {
  it('undefined / 两字段皆空 ⇒ 视为空（「恢复默认」判据）', () => {
    expect(isEmptyCreditWindowSetting(undefined)).toBe(true)
    expect(isEmptyCreditWindowSetting({})).toBe(true)
  })

  it('★ `0` 不是空（它是合法的显式设置）', () => {
    expect(isEmptyCreditWindowSetting({ windowDays: 0 })).toBe(false)
    expect(isEmptyCreditWindowSetting({ imminentDays: 0 })).toBe(false)
  })
})

/**
 * **上限闸**（2026-11-21，PR #129 正向审计 P2）。
 *
 * `sanitizeCreditWindows` 挡掉了 `Infinity`，理由逐字写着「会让『永久』档永远为空
 * —— 一切都被判成临期/短期」。但**同型的有限大值没挡**：
 * `1e9` 通过 `Number.isFinite` ⇒ `windowMs = 8.64e13` ⇒ `remaining <= windowMs`
 * 恒真 ⇒ `permanent` 恒 0 —— 与 `Infinity` 症状**一模一样**。
 *
 * ⇒ 这组用例钉住「手改 state.json 写进超大值」这条路径。
 */
describe('上限闸：超大 windowDays 不得让「永久」档恒空', () => {
  const envOf = (w: number, i: number) => ({
    buddyExpiringWindowDays: () => w,
    buddyImminentWindowDays: () => i,
  })
  const readerOf = (setting: { windowDays?: number; imminentDays?: number } | undefined) =>
    () => setting

  it('★★ `windowDays: 1e9` ⇒ 钳制到上限（不是原样放行）', () => {
    const r = resolveCreditWindow('qoder', readerOf({ windowDays: 1e9 }), envOf(15, 5))
    expect(r.windowDays).toBe(MAX_CREDIT_WINDOW_DAYS)
    expect(r.windowDays).toBeLessThan(1e9)
    // 必须报「被钳制过」，否则弹窗会静默改写用户输入
    expect(r.clamped).toBe(true)
  })

  it('★★ `imminentDays: 1e9`（window 正常）⇒ 同样钳制', () => {
    const r = resolveCreditWindow('qoder', readerOf({ windowDays: 30, imminentDays: 1e9 }), envOf(15, 5))
    expect(r.imminentDays).toBe(30) // 先钳上限到 36500，再被 window 倒挂钳到 30
    expect(r.windowDays).toBe(30)
    expect(r.clamped).toBe(true)
  })

  it('★ 环境变量给超大值也受控（只钳 setting 会漏一级）', () => {
    const r = resolveCreditWindow('qoder', readerOf(undefined), envOf(1e9, 5))
    expect(r.windowDays).toBe(MAX_CREDIT_WINDOW_DAYS)
    expect(r.clamped).toBe(true)
  })

  it('★ 上限本身是合法值（36500 不被钳，边界精确）', () => {
    const atLimit = resolveCreditWindow('qoder', readerOf({ windowDays: MAX_CREDIT_WINDOW_DAYS }), envOf(15, 5))
    expect(atLimit.windowDays).toBe(MAX_CREDIT_WINDOW_DAYS)
    expect(atLimit.clamped).toBe(false)
  })

  it('★ 刚超一点点（36501）⇒ 钳制（边界另一侧）', () => {
    const r = resolveCreditWindow('qoder', readerOf({ windowDays: MAX_CREDIT_WINDOW_DAYS + 1 }), envOf(15, 5))
    expect(r.windowDays).toBe(MAX_CREDIT_WINDOW_DAYS)
    expect(r.clamped).toBe(true)
  })

  it('★★ 上限与客户端 `parseWindowInput` 同值（两端口径不得漂移）', async () => {
    /**
     * 客户端那边是**拒绝** `> 36_500`，后端是**钳制** —— 方向刻意不同，
     * 但**阈值必须同值**：否则会出现「UI 允许 40000、后端压到 36500」
     * 这种用户看得见却不理解的错位。
     */
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../plugin-src/client/credit-window-ui.js', import.meta.url), 'utf8'))
    expect(source).toContain('36_500')
    expect(MAX_CREDIT_WINDOW_DAYS).toBe(36_500)
  })
})
