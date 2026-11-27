/**
 * ★★★ **D5：客户端其余三处档位判据也必须接阈值**（2026-11-27 第二轮审计）
 *
 * ## 审计原话
 *
 * > 「另 3 处客户端 tier 判据不接阈值（`badge-model` 1269/1305、`usage-badge` 2596）
 * >  ⇒ **排序/分组分叉**」
 *
 * 加上我自查发现的另外两处（`sumAvailableCredits` / `expiringOf`），共 **5 处**：
 *
 * | # | 位置 | 用途 | 不接的后果 |
 * |---|---|---|---|
 * | 1 | `sumAvailableCredits` | 锁定态「可用积分」| **数字骗人** |
 * | 2 | `orderCreditRows` 的 `tierOf` | 弹窗**排序** | 顺序与选号分叉 |
 * | 3 | `orderCreditRows` 的 `tierOfGroup` | 弹窗**分组** | 分档显示错 |
 * | 4 | `creditRowTierOf`（`usage-badge`）| 起点档位**提示** | 提示说错档位 |
 * | 5 | `expiringOf`（`usage-badge`）| `no-expiring` **不可用判据** | 显示可选、实际跳过 |
 *
 * ## ⚠️ 本文件能测 #1~#3（纯函数）
 *
 * #4 / #5 在 `usage-badge.js`（`import * as React`），**import 不进单测**
 * ⇒ 只能靠源码位置守卫（见文件末尾）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  backendOrderTier,
  creditOrderOptionsOf,
  orderCreditRows,
  sumAvailableCredits,
  CREDIT_ORDER_TIER,
} from '../../plugin-src/client/badge-model.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '../../plugin-src/client')

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 27, 0, 0, 0)

/** 一个账号行：`imminent` 落在临期窗口、`permanent` 远期。 */
function row(id: string, imminent: number, permanent: number) {
  return {
    id,
    accountId: id,
    balance: {
      total: imminent + permanent,
      packages: [
        ...(imminent > 0
          ? [{ name: 'B', unit: 'credit', remaining: imminent, total: imminent, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 2 * DAY }]
          : []),
        ...(permanent > 0
          ? [{ name: 'P', unit: 'credit', remaining: permanent, total: permanent, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 400 * DAY }]
          : []),
      ],
      expiredTotal: 0,
    },
  }
}

/**
 * 公共 options（`windowDays: 15` / `imminentDays: 5`）。
 *
 * ⚠️ **`limit` 必须 > 0**：`orderCreditRows` 的 `shown` 是
 * `ordered.slice(0, limit)` ⇒ `limit: 0` 会返回**空数组**（我第一版就这么错了）。
 */
function opts(extra: Record<string, unknown> = {}) {
  return { windowDays: 15, imminentDays: 5, now: NOW, limit: 99, ...extra }
}

describe('★★★ (D5-1) sumAvailableCredits：可用积分不得含已降档部分', () => {
  it('★★★ 临期 5（阈值 20 ⇒ 降档）⇒ 可用积分应为 **0**', () => {
    /**
     * 语义：锁定永久积分时「实际还能用多少」= 短期 + 临期。
     * 设阈值后被降档的部分在锁定态**真的不能用**（`none`）⇒ 不能算进来。
     */
    const accounts = [row('a', 5, 800)]
    const off = sumAvailableCredits(accounts, { locked: true, windowDays: 15, imminentDays: 5 })
    const on = sumAvailableCredits(accounts, {
      locked: true, windowDays: 15, imminentDays: 5, imminentFloor: 20,
    })
    console.log('  [可用积分] 阈值关=' + String(off) + '  阈值20=' + String(on))
    expect(off, '★ 阈值关闭 ⇒ 5 分可用').toBe(5)
    expect(on, '★★★ 阈值 20 ⇒ 那 5 分不算可用').toBe(0)
  })

  it('★★ 反向对照：充足的不受影响', () => {
    const accounts = [row('a', 500, 800)]
    const on = sumAvailableCredits(accounts, {
      locked: true, windowDays: 15, imminentDays: 5, imminentFloor: 20,
    })
    expect(on, '★★ 500 > 20 ⇒ 全额可用').toBe(500)
  })
})

describe('★★★ (D5-2/3) orderCreditRows：排序与分组都必须接阈值', () => {
  it('★★★ 设阈值 ⇒ 降档的号**排到后面**', () => {
    /**
     * `a`（临期 5，会被降档）+ `b`（临期 500）。
     * 阈值关闭：两者都在 imminent 档 ⇒ 按位次 ⇒ `a` 在前。
     * 阈值 20：`a` 降到 permanent ⇒ **`b` 在前**。
     */
    const rows = [row('a', 5, 800), row('b', 500, 0)]
    const off = orderCreditRows(rows, opts())
    const on = orderCreditRows(rows, opts({ imminentFloor: 20 }))
    const offOrder = off.shown.map((r: { id: string }) => r.id)
    const onOrder = on.shown.map((r: { id: string }) => r.id)
    console.log('  [排序] 阈值关=' + offOrder.join(',') + '  阈值20=' + onOrder.join(','))
    expect(offOrder[0], '★ 阈值关 ⇒ a 在前').toBe('a')
    expect(onOrder[0], '★★★ 阈值 20 ⇒ a 被降档 ⇒ b 在前').toBe('b')
  })

  it('★★★ `creditOrderOptionsOf` 必须透传两个阈值', () => {
    /**
     * ⚠️ 这条守的是**入口**：`orderCreditRows` 的判据再对，
     * 若 `creditOrderOptionsOf` 不透传，`options.imminentFloor` 仍是 `undefined`。
     */
    const o = creditOrderOptionsOf({
      windowDays: 15, imminentDays: 5, imminentFloor: 20, expiringFloor: 30, now: NOW,
    }) as Record<string, unknown>
    expect(o.imminentFloor, '★★★ 必须透传 imminentFloor').toBe(20)
    expect(o.expiringFloor, '★★★ 必须透传 expiringFloor').toBe(30)
  })

  it('★★ 不传阈值 ⇒ options 里没有该键（零回归）', () => {
    const o = creditOrderOptionsOf({ windowDays: 15, imminentDays: 5, now: NOW }) as Record<string, unknown>
    expect(o.imminentFloor, '★ 不传 ⇒ undefined（不是 0，保持形状不变）').toBeUndefined()
  })
})

describe('★★★ (D5-4/5) usage-badge 两处位置守卫', () => {
  /**
   * ⚠️ `usage-badge.js` 里 `import * as React` ⇒ **import 不进单测**（react 是
   * esbuild external）。故那两处只能做**源码位置守卫**：
   * 断言「`backendOrderTier(...)` / `splitCreditsByExpiry(...)` 附近出现了 floor」。
   *
   * ⚠️ 这比纯函数守卫弱（挡不住 `if(false)`），但那两处的**行为**无法在单测里跑 ——
   * 如实登记这个局限。服务端 4 处回传有行为守卫（`credit-floor-rpc.spec.ts`），
   * 整条链路**不会静默失效**。
   */
  const src = readFileSync(join(SRC, 'usage-badge.js'), 'utf8')

  it('★★★ `creditRowTierOf` 必须传两个阈值给 backendOrderTier', () => {
    /** 起点档位提示：说错比不说更糟。 */
    expect(
      src,
      '★★★ creditRowTierOf 的 backendOrderTier 必须带 floor（否则提示说错档位）',
    ).toMatch(/value\?\.locked !== true,\s*\n\s*\/\*\*[\s\S]{0,600}?Number\.isFinite\(value\?\.imminentFloor\)/)
  })

  it('★★★ `expiringOf` 必须按阈值过滤（否则「不可用」判据错）', () => {
    expect(
      src,
      '★★★ expiringOf 必须按 floor 过滤后才返回（否则显示可选、实际被跳过）',
    ).toMatch(/const countsImminent = imminent > imminentFloor/)
  })

  it('★★★ `creditOrderOptionsOf` 的调用点必须传两个阈值', () => {
    expect(
      src,
      '★★★ 不传 ⇒ 弹窗排序 / 分组仍按 >0 判档',
    ).toMatch(/imminentFloor: value\?\.imminentFloor,[\s\S]{0,80}expiringFloor: value\?\.expiringFloor,/)
  })
})

describe('★★★ (D5-入口) 服务端 4 处 usage 载荷必须回传阈值', () => {
  /**
   * ⚠️ **这是整条链路的最后一环**：服务端不回传 ⇒ 客户端全部回落 0
   * ⇒ 上面所有守卫都退化成「阈值关闭」= 等于没做。
   */
  it('★★★ `jet-hub-rpc.ts` 里 4 处 usage 载荷都带 floor', () => {
    const rpc = readFileSync(join(HERE, '../../src/jet-hub-rpc.ts'), 'utf8')
    const n = (rpc.match(/imminentFloor: w\.imminentFloor/g) ?? []).length
    expect(n, '★★★ 4 处 usage 载荷（usage.badge + 3×credits.balances）都必须回传').toBe(4)
  })
})
