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

describe('★★★ (D5-4/5) usage-badge 两处：现已升级为**行为级**', () => {
  /**
   * ⚠️ 2026-11-27：这两处原先是**源码位置守卫**（因为 `usage-badge.js`
   * `import * as React` ⇒ 单测 import 不进来）。
   *
   * 现已搬进 `credit-floor-pure.js`（纯函数）⇒ **行为级守卫在
   * `credit-floor-pure.spec.ts` 里**（真值断言，能挡 `if(false)`）。
   *
   * ⇒ 本组保留两条**接线守卫**：确认 `usage-badge.js` 真的**调用**了新模块，
   *   而不是把旧实现留着自己算（那会让新模块形同虚设）。
   */
  const src = readFileSync(join(SRC, 'usage-badge.js'), 'utf8')

  it('★★★ `creditRowTierOf` 必须调用抽出的 `startTierOf`（不能自己算）', () => {
    expect(src, '★★★ 必须调用 startTierOf（否则行为级守卫只管新模块、管不到实际渲染）')
      .toMatch(/return startTierOf\(packages, value \?\? \{\}, value\?\.locked !== true, Date\.now\(\)\)/)
  })

  it('★★★ `expiringOf` 必须调用抽出的 `expiringUsableOf`（不能自己算）', () => {
    expect(src, '★★★ 必须调用 expiringUsableOf')
      .toMatch(/return expiringUsableOf\(packages, value \?\? \{\}, undefined\)/)
  })

  it('★★ 那两个闭包内不得再有内联计算（搬走后不许留两份实现）', () => {
    /**
     * ⚠️ **不能简单断言「文件里没有 `splitCreditsByExpiry`」** ——
     * `expirySplitParts`（金额展示）**仍然需要它**，且那里**刻意不用阈值过滤**
     *（用户第 6 条定案：降级只改排队顺序，不改烧包顺序）。
     *
     * ⇒ 精确判据：**在 `expiringOf` / `creditRowTierOf` 两个函数的函数体内**，
     *   不得再出现 `splitCreditsByExpiry` / `backendOrderTier` 调用。
     */
    /**
     * ⚠️ **取「函数体」要精确**：上一版从函数名往后截 900 字符，
     * 把**紧邻的 `reasonOf` 注释里提到的 `splitCreditsByExpiry`** 也算进来了 ⇒ 假红。
     *
     * ⇒ 改为「从函数名到**它自己的 `return` 行**」—— 这两个函数都是
     *   「找 row → 调纯函数 → return」的一段式，`return` 就是函数体末尾。
     */
    const bodyOf = (name: string): string => {
      const start = src.indexOf(name)
      if (start < 0) return ''
      const retAt = src.indexOf('return ', start)
      if (retAt < 0) return ''
      /** 取到该 return 语句结束（行尾分号）。 */
      const end = src.indexOf(';', retAt)
      return src.slice(start, end < 0 ? retAt + 200 : end + 1)
    }
    for (const fn of ['function expiringOf', 'const creditRowTierOf = ']) {
      const body = bodyOf(fn)
      expect(body, `★★ ${fn} 必须已改为调用纯函数`).not.toBe('')
      expect(
        body.includes('splitCreditsByExpiry(') || body.includes('backendOrderTier('),
        `★★ ${fn} 内仍有内联计算 ⇒ 会与 credit-floor-pure.js 形成两份实现。\n`
          + `实际函数体：${body.slice(0, 200)}`,
      ).toBe(false)
    }
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
