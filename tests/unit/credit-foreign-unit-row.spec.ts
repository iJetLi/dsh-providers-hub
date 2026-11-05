import { describe, expect, it, vi } from 'vitest'

/**
 * 「第二套量纲」的账号卡片渲染守卫（`CreditBalanceRow`）。
 *
 * ## 为什么需要（用户 2026-11-02 报障）
 *
 * 报障原文：**「每日额度应该在账号积分处单独显示出来」**。
 *
 * 根因不在服务端 —— `buildMonkeycodeBalance` 一直如实给两个包
 * （`积分余额` 的单位是 `credit`、`每日额度` 的单位是 `token`，二者不可折算，
 * 见 `src/monkeycode-credits.ts` 的注释）。问题在渲染层：
 *
 * ```js
 * const unit = all.find(p => p && p.unit)?.unit   // ← 只认第一个包
 * ```
 *
 * 于是 token 那个包从未被任何代码路径读过 ⇒ 卡片上只有积分，用户找不到
 * 「今天还剩多少额度」。
 *
 * ## 守的三条
 *
 * ① 存在第二套量纲时，**在主行里**多一段后缀（`每日额度 9.24M / 10.00M`）；
 * ② **没有**第二套量纲时 DOM 逐字不变（不产生任何额外 span）——
 *    20+ 家既有 provider 必须零影响；
 * ③ 上限与剩余相同时**不**写 `/ 上限`（上游只给一个标量时，重复写两遍
 *    同一个数会让人以为那是个「总额」）。
 *
 * ⚠️ 形态由用户 2026-11-02 20:47 亲自定调：**「不用渲染单独行，像其他供应商
 *    一样在积分后面显示每日即可」** —— LoomY 的读数是
 *    `26465 永久 21465 · 每日 5000`，所有 provider 的卡片都必须是
 *    `标签 | 主值 + 后缀` 的单行形状。
 *
 * ⚠️ 用替身 React **真正调用**组件：TS 编译通过不代表运行时取得到值
 *    （本仓 2026-10-27 有过 TDZ 事故，见 `credit-balance-row-render.spec.ts`）。
 */

/** 返回结构对象的替身：只有这样才能断言「渲染出几行、每行是什么」。 */
const reactStub = {
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useLayoutEffect: () => {},
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
}

vi.mock('react', () => reactStub)

/** 两个包：积分（credit）+ 每日额度（token），与 MonkeyCode 的真实形态一致。 */
const MIXED_PACKAGES = [
  {
    name: '积分余额', unit: 'credit', remaining: 235.05, total: 235.05, used: 0,
    active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
  },
  {
    name: '每日额度', unit: 'token', remaining: 9_236_980, total: 10_000_000, used: 763_020,
    active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
  },
]

/** 单一量纲：与既有 provider（例如 codearts / zcode）同形。 */
const SINGLE_UNIT_PACKAGES = [
  {
    name: '基础积分包', unit: 'credit', remaining: 500, total: 500, used: 0,
    active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
  },
]

function balanceOf(packages: unknown[], total = 235.05) {
  return { total, packages, expiredTotal: 0 }
}

interface StubNode {
  readonly type: unknown
  readonly props: Record<string, unknown>
  readonly children: unknown[]
}

let moduleUnderTest: typeof import('../../plugin-src/client/jet-hub.js')

async function load() {
  moduleUnderTest ??= await import('../../plugin-src/client/jet-hub.js')
  return moduleUnderTest
}

async function render(props: Record<string, unknown>): Promise<StubNode> {
  const mod = await load()
  const Row = mod.__creditBalanceRowForTest
  expect(typeof Row, 'CreditBalanceRow 未被导出（测试钩子丢了）').toBe('function')
  return (Row as unknown as (p: Record<string, unknown>) => StubNode)({
    error: undefined,
    loading: false,
    windowDays: undefined,
    provider: 'monkeycode',
    actions: undefined,
    ...props,
  })
}

/** 从主行 dd 里取出跨量纲后缀（`.dim-jh-creditPools` 且文本含「每日额度」）。 */
function crossUnitOf(node: StubNode): StubNode | undefined {
  const dd = node.children[1] as StubNode | undefined
  const kids = Array.isArray(dd?.children) ? (dd!.children as StubNode[]) : []
  return kids.find(child => child && typeof child === 'object'
    && child.props?.className === 'dim-jh-creditPools'
    && Array.isArray(child.children)
    && String(child.children[0] ?? '').includes('每日额度'))
}

/** 主行 dd 里所有 `.dim-jh-creditPools` 后缀的文本（顺序即渲染顺序）。 */
function poolsTextsOf(node: StubNode): string[] {
  const dd = node.children[1] as StubNode | undefined
  const kids = Array.isArray(dd?.children) ? (dd!.children as StubNode[]) : []
  return kids
    .filter(child => child && typeof child === 'object' && child.props?.className === 'dim-jh-creditPools')
    .map(child => String((child.children as unknown[])[0] ?? ''))
}

describe('CreditBalanceRow · 跨量纲后缀（积分后面跟每日额度）', () => {
  it('★★ 每日额度必须显示在**积分同一行**的后缀里（用户给定形态）', async () => {
    const node = await render({ balance: balanceOf(MIXED_PACKAGES) })

    expect(node.type, '恒为单节点，不再包 Fragment').toBe('div')
    const suffix = crossUnitOf(node)
    expect(suffix, '每日额度那段后缀没渲染出来').toBeDefined()
    // 9236980 → 9.24M，10000000 → 10.00M。
    expect(suffix!.children[0]).toBe('每日额度 9.24M / 10.00M')
  })

  it('★★ 单一量纲时不产生任何额外后缀（既有 provider 的 DOM 必须逐字不变）', async () => {
    const node = await render({ balance: balanceOf(SINGLE_UNIT_PACKAGES, 500) })

    expect(node.type).toBe('div')
    expect(node.props.className).toBe('dim-jh-metaRow')
    expect(node.children, '单量纲时多出了后缀').toHaveLength(3) // dt / dd / actions(null)
    expect(poolsTextsOf(node), '单量纲时不该有跨量纲后缀').toHaveLength(0)
  })

  it('★ 上限与剩余相同时不写「/ 上限」（避免让人以为那是总额）', async () => {
    const node = await render({
      balance: balanceOf([
        MIXED_PACKAGES[0],
        { ...MIXED_PACKAGES[1], remaining: 10_000_000, total: 10_000_000 },
      ]),
    })
    const suffix = crossUnitOf(node)
    expect(suffix!.children[0]).toBe('每日额度 10.00M')
    expect(suffix!.children[0]).not.toContain('/')
  })

  it('★ 主单位取第一个包：token 在前时后缀变成积分（不写死 provider）', async () => {
    const node = await render({
      balance: balanceOf([MIXED_PACKAGES[1], MIXED_PACKAGES[0]], 10_000_000),
    })
    // 主值走 token 口径，后缀里的积分带自己的标签。
    const suffix = crossUnitOf(node)
    expect(suffix, '后缀内容应当换成积分包').toBeUndefined()
    expect(poolsTextsOf(node).join('|')).toContain('积分余额')
    expect(poolsTextsOf(node).join('|')).toContain('235.05')
  })

  it('★ 没有包时不抛错、也不产生后缀', async () => {
    const node = await render({ balance: balanceOf([]) })
    expect(node.type).toBe('div')
    expect(poolsTextsOf(node)).toHaveLength(0)
  })
})
