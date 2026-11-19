/**
 * ★★ **「保存即全量生效」的接线守卫**（用户 2026-11-19 明确要求）：
 *
 * > 「是不是修改窗口后，点击保存就马上对全部会话的该 provider 生效，
 * >  不需要重启或者重选模型或者切换到会话上打开一次积分窗口？」
 *
 * ## 这个承诺靠什么保证
 *
 * 1. 消费者（选号 + 展示）**每次现读** `pool.creditWindow(provider)`，不缓存；
 * 2. 保存只更内存 + 落盘，**不重建 selector**；
 * 3. 不允许把窗口值注入构造期字段（`deps.windowMs` 只服务单测覆盖）。
 *
 * ⇒ 本文件用**同一实例、不重建**的方式验证：改设置后下一次 select 立刻用新值。
 *    这是对「不需要重启」最直接的行为级证明。
 */
import { describe, expect, it } from 'vitest'
import { resolveCreditWindow } from '../../src/credit-window.js'

const DAY = 86_400_000

describe('★★★ 保存即生效：同一实例、不重建，下一次取值立刻变', () => {
  /** 模拟 AccountPool 的最小可写存储。 */
  class FakePool {
    constructor() {
      this.table = {}
    }
    creditWindow(provider) {
      const entry = this.table[provider]
      return entry === undefined ? undefined : { ...entry }
    }
    setCreditWindow(provider, setting) {
      if (setting === undefined) delete this.table[provider]
      else this.table[provider] = { ...setting }
    }
  }

  const env = { buddyExpiringWindowDays: () => 15, buddyImminentWindowDays: () => 5 }

  it('★★★ 改设置后，同一 pool 的下一次 resolve 立刻用新值（无需重启）', () => {
    const pool = new FakePool()
    // 初始：无设置 ⇒ 默认 15 / 5
    let r = resolveCreditWindow('trae', (id) => pool.creditWindow(id), env)
    expect(r).toMatchObject({ windowDays: 15, imminentDays: 5, source: 'default' })

    // 用户保存 7 / 3
    pool.setCreditWindow('trae', { windowDays: 7, imminentDays: 3 })

    // 同一个 pool、没有重建任何实例 ⇒ 立刻生效
    r = resolveCreditWindow('trae', (id) => pool.creditWindow(id), env)
    expect(r, '保存后必须立刻生效').toMatchObject({ windowDays: 7, imminentDays: 3, source: 'setting' })
  })

  it('★★ 恢复默认后立刻回落环境变量（不是保留旧值）', () => {
    const pool = new FakePool()
    pool.setCreditWindow('trae', { windowDays: 7, imminentDays: 3 })
    expect(resolveCreditWindow('trae', (id) => pool.creditWindow(id), env).windowDays).toBe(7)

    pool.setCreditWindow('trae', undefined)
    const r = resolveCreditWindow('trae', (id) => pool.creditWindow(id), env)
    expect(r, '恢复默认后应回落 env').toMatchObject({ windowDays: 15, imminentDays: 5, source: 'default' })
  })

  it('★ per-provider 隔离：改 trae 不影响 workbuddy', () => {
    const pool = new FakePool()
    pool.setCreditWindow('trae', { windowDays: 7, imminentDays: 3 })
    const trae = resolveCreditWindow('trae', (id) => pool.creditWindow(id), env)
    const wb = resolveCreditWindow('workbuddy', (id) => pool.creditWindow(id), env)
    expect(trae.windowDays).toBe(7)
    expect(wb.windowDays, '另一个 provider 必须仍是默认').toBe(15)
    expect(wb.source).toBe('default')
  })

  it('★★ 读取返回副本：调用方改返回值不污染存储', () => {
    const pool = new FakePool()
    pool.setCreditWindow('trae', { windowDays: 7 })
    const got = pool.creditWindow('trae')
    got.windowDays = 999
    expect(pool.creditWindow('trae').windowDays, '存储不该被外部改动影响').toBe(7)
  })
})
