/**
 * 「严格手动顺序」的**装配对账**：`BALANCE_TIERED_PROVIDERS` 必须与
 * `src/index.ts` 里真实的 `balance: { kind: 'buddy' | 'loomy' }` 装配点
 * **双向一一对应**。
 *
 * ## 为什么需要这个文件（它兑现的是一句**假宣称**）
 *
 * `src/provider-registry.ts` 与 `plugin-src/client/credits-capabilities.js`
 * 的注释都写着「`tests/unit/strict-manual-order-wiring.spec.ts` 会扫描
 * `src/index.ts` 的真实装配并对账 —— 漏一家会变红」。2026-11-09 审计实测：
 * **该文件根本不存在**，全树只有 `strict-manual-order.spec.ts`，而它是
 * **硬编码 id 名单**（正向 12 个），既不读 `index.ts`、也漏了
 * `autoclawintl` / `magicrewintl` 两家。
 *
 * 漏一家的后果是**静默**的：该渠道的分档渠道拿不到「严格手动顺序」开关，
 * 面板上只有「拖动卡片调整排序，按顺序选号」这句在它身上是假话 ——
 * 正是本功能被报障的形态。
 *
 * ## 判据为什么必须读 `index.ts`（而不是只读那张表）
 *
 * 单纯断言「表里有 14 条」是**同义反复**（改表即改断言）。真正的不变式是
 * **表与装配点同源**：`src/index.ts` 是唯一装配处，表只是它的派生视图。
 * ⇒ 判据取「装配点集合 === 表」的双向差集，并在失败信息里点名缺哪家。
 *
 * ## 解析方式
 *
 * `balance` 块里 `kind:` 与本块的 `product:` 常量在同一段对象字面量内，
 * 故取「`kind:` 之前**最近**一个 `product: CONST_NAME,`」。产品常量散落在
 * `src/*-product.ts`，这里用命名空间合并成一张表（新增产品时若忘了在这里
 * 加 import，报错信息会点名那个常量，不会静默跳过）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BALANCE_TIERED_PROVIDERS, isBalanceTieredProvider } from '../../src/provider-registry.js'
import * as buddyProductModule from '../../src/product.js'
import * as lobsteraiProductModule from '../../src/lobsterai-product.js'
import * as qoderProductModule from '../../src/qoder-product.js'
import * as traeProductModule from '../../src/trae-product.js'
import * as loomyProductModule from '../../src/loomy-product.js'
import * as minimaxProductModule from '../../src/minimax-product.js'
import * as autoclawProductModule from '../../src/autoclaw-product.js'
import * as magicrewProductModule from '../../src/magicrew-product.js'
import * as astudioProductModule from '../../src/astudio-product.js'
import * as officeaceProductModule from '../../src/officeace-product.js'

const INDEX_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
  'utf8',
)

/**
 * 去掉注释再解析。
 *
 * ⚠️ 只去「块注释」与「整行注释」，**不要**用 `//.*$` 去砍行尾：`index.ts`
 * 里有 `'https://…'` 这类字符串字面量，砍掉后半行会让同一行上的
 * `kind:` 一起消失（本仓已在多处踩过「注释里的花括号 / 斜杠破坏解析」）。
 */
const CODE = INDEX_SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n')

/** 产品常量 → 产品对象（`id` 才是 provider id）。 */
const PRODUCT_CONSTANTS: Record<string, unknown> = Object.assign(
  {},
  buddyProductModule,
  lobsteraiProductModule,
  qoderProductModule,
  traeProductModule,
  loomyProductModule,
  minimaxProductModule,
  autoclawProductModule,
  magicrewProductModule,
  astudioProductModule,
  officeaceProductModule,
)

interface BalanceBlock {
  /** 该块 `product:` 的常量名（如 `CODEBUDDY`）。 */
  readonly product: string
  readonly kind: 'buddy' | 'loomy'
}

/**
 * 从 `src/index.ts` 抽出所有 `balance: { kind: 'buddy' | 'loomy' }` 装配点。
 *
 * ⚠️ 找不到 `product:` 时**抛错**（而不是跳过）：跳过会让「新增一家却忘了
 * 加 product 常量」这类改动静默通过。
 */
function balanceBlocks(): BalanceBlock[] {
  const blocks: BalanceBlock[] = []
  for (const match of CODE.matchAll(/kind:\s*'(buddy|loomy)'/g)) {
    const before = CODE.slice(0, match.index)
    const productMatches = [...before.matchAll(/product:\s*([A-Z][A-Z0-9_]*)\s*,/g)]
    const productMatch = productMatches.at(-1)
    if (productMatch === undefined) {
      throw new Error(
        `无法在第 ${(match.index ?? 0) + 1} 个字符附近解析出 balance 块的 product 常量`
        + '（装配形态变了？见本文件顶部说明）',
      )
    }
    blocks.push({ product: productMatch[1]!, kind: match[1] as 'buddy' | 'loomy' })
  }
  return blocks
}

/** 产品常量名 → provider id。 */
function providerIdOf(constName: string): string {
  const value = PRODUCT_CONSTANTS[constName]
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      `找不到产品常量 ${constName}（新增 provider 时请把它的 *-product.ts 加进本文件的 import）`,
    )
  }
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`产品常量 ${constName} 没有非空字符串 id`)
  }
  return id
}

describe('严格手动顺序：src/index.ts 装配 ↔ BALANCE_TIERED_PROVIDERS 对账', () => {
  const blocks = balanceBlocks()

  it('能解析出装配点（判据自检：一个都解析不出说明本文件的解析前提失效）', () => {
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(() => providerIdOf(block.product), `产品常量 ${block.product}`).not.toThrow()
    }
  })

  it('★★ 双向差集必须为空（漏一家 ⇒ 该渠道的开关静默消失）', () => {
    const assembled = blocks.map((block) => providerIdOf(block.product))
    const missing = assembled.filter((id) => !BALANCE_TIERED_PROVIDERS.includes(id))
    const extra = BALANCE_TIERED_PROVIDERS.filter((id) => !assembled.includes(id))
    expect(
      { missing, extra },
      'missing = index.ts 装配了但不在表里（该渠道拿不到「严格手动顺序」开关）；'
      + 'extra = 表里有但 index.ts 没装配（面板会渲染一个点了没用的开关）',
    ).toEqual({ missing: [], extra: [] })
  })

  it('装配点不重复（同一 provider 两个 balance 块 ⇒ 后一个静默覆盖前一个）', () => {
    const assembled = blocks.map((block) => providerIdOf(block.product))
    expect(assembled.length).toBe(new Set(assembled).size)
  })

  it('`isBalanceTieredProvider` 与表逐条一致（含反例）', () => {
    for (const id of BALANCE_TIERED_PROVIDERS) {
      expect(isBalanceTieredProvider(id), id).toBe(true)
    }
    // ⚠️ officeace 刻意**不**进表：它的分档只发生在「锁定态」，接入会让
    //    未锁定时也按余额重排（见 `BALANCE_TIERED_PROVIDERS` 的注释）。
    expect(CODE).toContain('OFFICEACE')
    expect(isBalanceTieredProvider('officeace')).toBe(false)
    expect(isBalanceTieredProvider('codearts')).toBe(false)
  })

  it('loomy 协议只有一家（多一家说明 `kind: \'loomy\'` 被误复制）', () => {
    const loomyIds = blocks
      .filter((block) => block.kind === 'loomy')
      .map((block) => providerIdOf(block.product))
    expect(loomyIds).toEqual(['loomy'])
  })
})
