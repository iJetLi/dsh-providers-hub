import { describe, expect, it, vi } from 'vitest'

/**
 * 全局统计带的**接线层行为级**守卫（2026-11-13 对抗审计 P2）。
 *
 * ## 为什么必须再写一个文件（`jet-hub-global-stats.spec.ts` 不够）
 *
 * 那个文件的 10 条 `it` **全是源码文本断言**（`source.slice` + 正则 / `toContain`）。
 * 对抗审计实测：在 `for (const list of balances)` 之前加一句 `if (false) {`，
 * 整段聚合变成**死代码**，而 **10 条用例全部仍然全绿** —— 字面量还在，行为已经没了。
 * 这与本仓库登记过的两次事故同型（`notice-shape` 的 41 条假绿、`model-center-panel`
 * 的循环指认）。
 *
 * ## 判据打在哪
 *
 * 真渲染 `JetHubPage({ rpcCall })`（`react` 用替身），拿渲染期登记下来的
 * `useCallback` 回调**真的调用** `loadGlobalStats`，喂一份受控的上游数据，
 * 然后断言**它写进 state 的那个对象**的三个字段。
 *
 * 于是「聚合整段被 `if (false)` 包住」「`totalCredits +=` 挪到别的分支」
 * 「`partial` 忘了置位」这类改动**无处可逃** —— 只要最终算出的数字变了，这里就红。
 *
 * ## 数据设计（故意让每个判据都能单独打红）
 *
 * | 账号 | `balance.total` | 包 | 期望 |
 * |---|---|---|---|
 * | A | 100 | `{total: 500, active: true}` | 总 +500 / 剩余 +100 |
 * | B | 200 | `{total: 900, active: false}` | 总 **+0**（失效包不算）/ 剩余 +200 |
 * | C | 300 | `{total: 400, totalKnown: false}` | 总 **+0**（假分母不算）/ 剩余 +300 |
 * | D | `null`（读失败） | — | `creditsPartial = true` |
 *
 * ⚠️ 三个包的总 `total` 分别是 500 / 900 / 400，**两两不同且都不等于 0**
 * —— 任何「取错字段」「漏判一个条件」都会让断言里的数字变，不会恰好撞上。
 */

/** hook 槽位：每次「渲染」重置，模拟一次组件挂载。 */
let hooks: unknown[] = []
let cursor = 0
/** 本次渲染期间被 `useState` setter 写过的值（按写入顺序）。 */
let writes: Array<{ index: number; value: unknown }> = []
/** 本次渲染期间传进 `useCallback` 的回调（用于真实调用、观察写入形态）。 */
let callbacks: unknown[] = []

function slot<T>(initial: T | (() => T)): { v: T } {
  const key = cursor++
  if (!(key in hooks)) {
    hooks[key] = { v: typeof initial === 'function' ? (initial as () => T)() : initial }
  }
  return hooks[key] as { v: T }
}

const reactStub = {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const s = slot(initial)
    const index = cursor - 1
    return [
      s.v,
      (next) => {
        s.v = typeof next === 'function' ? (next as (prev: T) => T)(s.v) : next
        writes.push({ index, value: s.v })
      },
    ]
  },
  useRef<T>(initial: T) {
    // ⚠️ 组件里读的是 `ref.current`（不是 `.v`）—— 少这一个字段会让「按序号丢弃
    //    过期响应」的闸门恒真（2026-11-09 实测过的替身缺陷）。
    const s = slot(initial) as { v: T; current?: T }
    if (!('current' in s)) s.current = s.v
    return s as unknown as { current: T }
  },
  useEffect() {},
  useLayoutEffect() {},
  useCallback<T>(fn: T): T {
    // ⚠️ 真实 React 在调用本函数**之前**就求值了 deps（这正是 TDZ 会炸的原因），
    //    故这里不读 deps 参数 —— 与 `jet-hub-tdz.spec.ts` 同款。
    callbacks.push(fn)
    return fn
  },
  useMemo<T>(fn: () => T): T {
    return fn()
  },
  createElement(type: unknown, props: unknown, ...children: unknown[]) {
    void type
    void props
    void children
    return null
  },
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
  Component: class {},
}

vi.mock('react', () => reactStub)

/** 一次「渲染」：重置槽位与写入记录。 */
function resetRender(): void {
  hooks = []
  cursor = 0
  writes = []
  callbacks = []
}

type Stats = {
  accounts: number
  totalCredits: number | null
  remainingCredits: number | null
  creditsLoading: boolean
  creditsPartial: boolean
  totalUnknown?: boolean
}

/**
 * 真渲染 `JetHubPage`，然后**真的调用** `loadGlobalStats`，返回它最后一次写进
 * state 的统计对象。
 *
 * ⚠️ 为什么用「把每个 `useCallback` 都调一遍」而不是按名字取：
 *    `loadGlobalStats` 是组件内部的 `const`，模块外拿不到。
 *    ⚠️ 被误调的回调最多是不做事或抛错 —— 抛错**不算失败**（那是别的回调），
 *       但**写进 state 的对象**只可能来自 `setGlobalStats`（唯一写 `totalCredits` 的）。
 */
async function runGlobalStats(
  rpcCall: (method: string, payload?: unknown) => Promise<unknown>,
): Promise<Stats[]> {
  resetRender()
  const mod = await import('../../plugin-src/client/jet-hub.js')
  // 模块必须能加载（否则下面全是假绿）。
  expect(typeof mod.JetHubPage).toBe('function')
  mod.JetHubPage({ rpcCall })

  const seen: Stats[] = []
  for (const cb of callbacks) {
    if (typeof cb !== 'function') continue
    let out: unknown
    try {
      out = (cb as () => unknown)()
    } catch {
      continue
    }
    if (out !== null && typeof out === 'object' && typeof (out as Promise<unknown>).then === 'function') {
      try {
        await out
      } catch {
        /* 别的异步回调失败与统计带无关 */
      }
    }
  }
  for (const w of writes) {
    const v = w.value as Record<string, unknown> | null
    if (v !== null && typeof v === 'object' && 'totalCredits' in v) seen.push(v as Stats)
  }
  return seen
}

/** 受控上游：三个渠道各给一份设计好的数据（见文件头表格）。 */
function makeRpc(overrides: Record<string, unknown> = {}) {
  return async (method: string, payload?: unknown): Promise<unknown> => {
    const provider = (payload as { provider?: string } | undefined)?.provider ?? ''
    if (method === 'account.list') {
      const count = provider === 'codearts' ? 2 : provider === 'buddy' ? 1 : 0
      return { accounts: Array.from({ length: count }, (_, i) => ({ id: `${provider}-${i}` })) }
    }
    if (method === 'credits.balances') {
      if (provider in overrides) {
        const v = overrides[provider]
        if (v instanceof Error) throw v
        return { accounts: v }
      }
      if (provider === 'codearts') {
        return {
          accounts: [
            { id: 'codearts-0', balance: { total: 100, packages: [{ total: 500, active: true }] } },
            { id: 'codearts-1', balance: { total: 200, packages: [{ total: 900, active: false }] } },
          ],
        }
      }
      if (provider === 'buddy') {
        return {
          accounts: [
            { id: 'buddy-0', balance: { total: 300, packages: [{ total: 400, totalKnown: false }] } },
          ],
        }
      }
      return { accounts: [] }
    }
    return {}
  }
}

describe('全局统计带（行为级）', () => {
  it('能真实渲染并真的写出统计对象（防止「加载失败」被当成通过）', async () => {
    const stats = await runGlobalStats(makeRpc())
    expect(stats.length, '没有任何 setGlobalStats 写入 ⇒ 探针本身失效').toBeGreaterThan(0)
    // 两段式：第一段 totalCredits:null（loading），第二段落定。
    expect(stats[0].creditsLoading).toBe(true)
    expect(stats[0].totalCredits).toBeNull()
    expect(stats[stats.length - 1].creditsLoading).toBe(false)
  })

  it('★★★ 真实聚合：总积分只算「有效且周期总额可知」的包（假分母必红）', async () => {
    const stats = await runGlobalStats(makeRpc())
    const last = stats[stats.length - 1]
    // 500（A 有效且可知）+ 0（B 失效）+ 0（C 不可知）
    // ⚠️ 三包 total 是 500 / 900 / 400，任何「取错字段」「漏判条件」都会变数。
    expect(
      last.totalCredits,
      '总积分必须是 500 —— 900 是 active:false 的失效包、400 是 totalKnown:false 的假分母，'
      + '两者计入会让「总积分」与「剩余积分」同形（2026-11-05 报障）',
    ).toBe(500)
  })

  it('★★ 真实聚合：剩余积分 = 各账号 balance.total 之和（读失败的账号不加 0）', async () => {
    const stats = await runGlobalStats(makeRpc())
    const last = stats[stats.length - 1]
    // 100 + 200 + 300（codearts-0 / codearts-1 / buddy-0）
    expect(last.remainingCredits).toBe(600)
  })

  it('★★★ 有 totalKnown:false 的包 ⇒ totalUnknown 必须置位（容错不能静默）', async () => {
    const stats = await runGlobalStats(makeRpc())
    const last = stats[stats.length - 1]
    expect(
      last.totalUnknown,
      'buddy-0 的包 totalKnown:false ⇒ 总积分不可知，必须置 totalUnknown 让渲染退化成 —',
    ).toBe(true)
    // 反向对照：把那个包改成可知 ⇒ 标记必须消失（否则这个字段就是恒真的死代码）
    const known = await runGlobalStats(makeRpc({
      buddy: [{ id: 'buddy-0', balance: { total: 300, packages: [{ total: 400, active: true }] } }],
    }))
    expect(known[known.length - 1].totalUnknown).toBe(false)
    expect(known[known.length - 1].totalCredits).toBe(900) // 500 + 400
  })

  it('★★ 任一渠道读取失败 ⇒ creditsPartial 置位，但其余渠道照常求和（部分数据比没有有用）', async () => {
    const stats = await runGlobalStats(makeRpc({ codearts: new Error('unsupported provider: boom') }))
    const last = stats[stats.length - 1]
    expect(last.creditsPartial, 'codearts 抛错 ⇒ 必须标记 partial（否则读数静默偏小）').toBe(true)
    // buddy 仍然算进来
    expect(last.remainingCredits).toBe(300)
    // 反向对照：全部成功 ⇒ 不得置位（恒真就无意义了）
    const clean = await runGlobalStats(makeRpc())
    expect(clean[clean.length - 1].creditsPartial).toBe(false)
  })

  it('★★★ 账号某一条 balance 为 null ⇒ partial 置位且不加 0（读不到 ≠ 一分没有）', async () => {
    const stats = await runGlobalStats(makeRpc({
      codearts: [
        { id: 'codearts-0', balance: null },
        { id: 'codearts-1', balance: { total: 200, packages: [{ total: 900, active: true }] } },
      ],
    }))
    const last = stats[stats.length - 1]
    expect(last.creditsPartial, 'balance:null 是「读取失败」，必须计入 partial').toBe(true)
    // ⚠️ 500 = codearts-1 的 200 + buddy-0 的 300（`balance:null` 那条**不加 0**，
    //    也不吃掉别的渠道的读数 —— 若把 null 当成 0 之外的任何值，这里都会变）。
    expect(last.remainingCredits, 'null 账号不得贡献 0 —— 只算真读到的那条').toBe(500)
    // 900 只来自 codearts-1 的有效包；buddy 的包 totalKnown:false ⇒ 不计总分。
    expect(last.totalCredits).toBe(900)
  })

  it('★★ 账号数只数 account.list 回来的条目，不数 provider 个数', async () => {
    const stats = await runGlobalStats(makeRpc())
    const last = stats[stats.length - 1]
    // codearts 2 + buddy 1（其余 provider 回 [])
    expect(last.accounts).toBe(3)
  })
})
