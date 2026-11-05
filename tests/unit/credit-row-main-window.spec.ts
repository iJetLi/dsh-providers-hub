/**
 * 积分行（`CreditBalanceRow`）**主行读数**的文本级渲染守卫。
 *
 * ## 为什么必须有（2026-11-05 审计 P0-3 / 无牙 M14）
 *
 * 本 PR 给主行加了「授信/充值窗口」（`mainText`），但当时**没有任何用例断言
 * 渲染出来的文本**：
 * - 变异「把 `creditWindow` 整个关掉」⇒ 全量 837 条**全绿**；
 * - 由此两个真实缺陷漏了过去：
 *   1. `raccoon` 也下发同名「充值积分」包 ⇒ 只按包名匹配会把它的主行从
 *      「总余额 500」劫持成「充值桶 200 / 200」（假分母 + 口径错）；
 *   2. baizhi 充值包的「反推期初」会退化成 `136.84 / 136.84`。
 *
 * ⇒ 本文件用**收集文本**的 React 替身真正调用 `CreditBalanceRow(...)`。
 * 与 `credit-balance-row-render.spec.ts` 的分工：那个只验证「不抛 TDZ」
 * （`createElement` 返回 `null`，拿不到文本）；本文件补上文本断言。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

interface CollectedElement {
  readonly type: unknown
  readonly props: Record<string, unknown> | null
  readonly children: readonly unknown[]
}

const reactStub = {
  useState: (initial: unknown) => [initial, () => {}] as const,
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useLayoutEffect: () => {},
  createElement: (type: unknown, props: unknown, ...children: unknown[]): CollectedElement => ({
    type,
    props: (props ?? null) as Record<string, unknown> | null,
    children: children.flat(Infinity),
  }),
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
}

vi.mock('react', () => reactStub)

/** 把元素树拼成纯文本（子节点里既有字符串也有嵌套元素/数组）。 */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'children' in (node as CollectedElement)) {
    return textOf((node as CollectedElement).children)
  }
  return ''
}

/** 造一个资源包（默认带 `totalKnown` 由调用方决定）。 */
function pkg(
  name: string,
  remaining: number,
  total: number,
  totalKnown?: boolean,
): Record<string, unknown> {
  return {
    name,
    unit: 'credit',
    remaining,
    total,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    ...totalKnown === undefined ? {} : { totalKnown },
  }
}

let render: (props: Record<string, unknown>) => string

beforeAll(async () => {
  const module = await import('../../plugin-src/client/jet-hub.js')
  const Row = module.__creditBalanceRowForTest as unknown as (
    props: Record<string, unknown>,
  ) => unknown
  render = (props) => textOf(Row({ loading: false, windowDays: 15, ...props }))
})

describe('CreditBalanceRow 主行：授信/充值窗口（baizhi）', () => {
  it('★ 授信账户显示 908 / 1000（上游权威分母）', () => {
    const text = render({
      provider: 'baizhi',
      balance: { total: 908, packages: [pkg('授信额度', 908, 1000, true)], expiredTotal: 0 },
    })
    expect(text).toContain('908 / 1000')
  })

  it('★★ 充值包 totalKnown:false ⇒ **不得**显示 136.84 / 136.84 假分母', () => {
    const text = render({
      provider: 'baizhi',
      balance: {
        total: 235.05,
        packages: [
          pkg('每日积分', 98.21, 100, true),
          pkg('充值积分', 136.84, 136.84, false),
        ],
        expiredTotal: 0,
      },
    })
    expect(text).toContain('136.84')
    expect(text).not.toContain('136.84 / 136.84')
    // 主行是**总余额**（同量纲相加），不是充值桶。
    expect(text).toContain('235.05')
  })
})

describe('CreditBalanceRow 主行：其它 provider 不得被同名包劫持（P0-3）', () => {
  it('★★ Raccoon 的「充值积分」包不得改写主行（仍显示总余额 500）', () => {
    const text = render({
      provider: 'raccoon',
      balance: {
        total: 500,
        packages: [
          pkg('奖励积分', 200, 200),
          pkg('每日积分', 100, 100),
          pkg('充值积分', 200, 200),
        ],
        expiredTotal: 0,
      },
    })
    expect(text).toContain('500')
    expect(text).not.toContain('200 / 200')
  })

  // 反向对照：baizhi 的同名包**必须**被认作窗口（否则上面那条恒真）。
  it('★ 对照：baizhi 的「充值积分」+ totalKnown:true 会显示窗口', () => {
    const text = render({
      provider: 'baizhi',
      balance: {
        total: 200,
        packages: [pkg('充值积分', 200, 1000, true)],
        expiredTotal: 0,
      },
    })
    // 剩余 200 / 总额 1000 是合法窗口（`total >= remaining`）⇒ 必须显示分母。
    expect(text).toContain('200 / 1000')
  })
})
