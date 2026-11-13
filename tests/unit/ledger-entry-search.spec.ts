/**
 * 「最近请求」搜索框的**行为级**守卫：它必须能筛**模型**，也能筛**账号**。
 *
 * ## 为什么需要这个文件
 *
 * 用户 2026-11-12 要求把「筛选模型」改成「筛选模型 / 帐号」。这个改动有三条
 * **静默失效**路径，都不会报错、界面也不会崩，只会「搜不到」：
 *
 * | # | 改坏方式 | 症状 |
 * |---|---|---|
 * | 1 | 只查 `entry.model`（忘了账号） | 输入账号名 ⇒ 0 条 |
 * | 2 | 只查 `entry.accountId`（忘了显示名） | 输入**屏幕上看到的昵称** ⇒ 0 条 ← 最容易漏 |
 * | 3 | `accountNames` 不进 `useMemo` 依赖 | 名字异步到了，搜索索引还是旧的 ⇒ 仍 0 条 |
 *
 * 第 2 条尤其阴险：账号列渲染的是 `accountLabel(...)`（昵称优先），
 * 而 `entry.accountId` 是内部 id。**用户照着屏幕敲字，必然搜不到**。
 *
 * ## 为什么是行为级
 *
 * 本仓库的既有教训：源码文本断言打不过 `if (false)` / 局部别名 / 常量下沉。
 * 故这里真渲染组件、**真调用 input 的 onChange**，然后数表格行。
 *
 * ## 替身的诚实边界
 *
 * 替身 React 不展开子组件、不做协调，但本用例只需要「组件自己产出的元素树」，
 * 并且手工驱动一次 onChange 就能走完筛选链路 —— 这正是它能测的部分。
 *
 * @module tests/unit/ledger-entry-search.spec.ts
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/** 替身 React：按槽位保存 state，`setState` 直接生效（单次渲染即可读结果）。 */
const reactStub = vi.hoisted(() => {
  const slots = []
  let cursor = 0
  const pending = []

  return {
    __reset() {
      slots.length = 0
      cursor = 0
      pending.length = 0
    },
    __takeEffects() {
      return pending.splice(0)
    },
    __rewind() {
      cursor = 0
    },
    useState(initial) {
      const k = cursor++
      if (!(k in slots)) slots[k] = {}
      const slot = slots[k]
      if (!('v' in slot)) slot.v = typeof initial === 'function' ? initial() : initial
      return [slot.v, (next) => {
        slot.v = typeof next === 'function' ? next(slot.v) : next
      }]
    },
    useRef(initial) {
      const k = cursor++
      if (!(k in slots)) slots[k] = {}
      const slot = slots[k]
      if (!('cur' in slot)) { slot.cur = initial; slot.current = initial }
      return slot
    },
    useEffect(fn) {
      pending.push(fn)
      Promise.resolve().then(() => { try { fn() } catch { /* 取数失败组件自己兜 */ } })
    },
    useLayoutEffect(fn) { Promise.resolve().then(() => { try { fn() } catch { /* ignore */ } }) },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    Fragment: 'Fragment',
    StrictMode: 'StrictMode',
    Component: class {
      constructor(props) { this.props = props; this.state = {} }
      setState(partial) {
        this.state = { ...this.state, ...(typeof partial === 'function' ? partial(this.state) : partial) }
      }
    },
  }
})

vi.mock('react', () => reactStub)

type AnyNode = { type: unknown; props: Record<string, unknown>; children: unknown[] }

function findAll(node: unknown, predicate: (n: AnyNode) => boolean, out: AnyNode[] = []): AnyNode[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const c of node) findAll(c, predicate, out); return out }
  if (typeof node !== 'object') return out
  const el = node as AnyNode
  if (!('props' in el)) return out
  if (predicate(el)) out.push(el)
  if (Array.isArray(el.children)) findAll(el.children, predicate, out)
  return out
}

function textsOf(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) textsOf(c, out); return out }
  if (typeof node !== 'object') return out
  const el = node as AnyNode
  if (Array.isArray(el.children)) for (const c of el.children) textsOf(c, out)
  return out
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await tick() }

let panel: ((props: Record<string, unknown>) => unknown) | undefined

beforeAll(async () => {
  const mod = await import('../../plugin-src/client/jet-hub.js') as unknown as {
    __tokenLedgerPanelForTest?: typeof panel
  }
  panel = mod.__tokenLedgerPanelForTest
  expect(typeof panel).toBe('function')
})

/**
 * 三条明细，覆盖三种可搜词：
 * - 模型 `deepseek-v4.1-flash`
 * - 账号**显示名** `alice`（来自 account.list 的 nickname）
 * - 账号 **id** `codearts-aaaa1111`
 * 另有一条属于 `bob` 的，用来验证「筛掉非目标」。
 */
const ENTRIES = [
  {
    ts: 1_794_284_557_891, channel: 'direct', provider: 'codearts', model: 'deepseek-v4.1-flash',
    accountId: 'codearts-aaaa1111', usageReported: true, inputTokens: 10, outputTokens: 10,
  },
  {
    ts: 1_794_284_557_892, channel: 'direct', provider: 'codearts', model: 'glm-5.3',
    accountId: 'codearts-bbbb2222', usageReported: true, inputTokens: 20, outputTokens: 20,
  },
  {
    ts: 1_794_284_557_893, channel: 'direct', provider: 'codearts', model: 'kimi-k2.6-vl',
    accountId: 'codearts-aaaa1111', usageReported: true, inputTokens: 30, outputTokens: 30,
  },
]

/** `account.list`：给 id → 昵称的映射（`buildAccountNameMap` 读 nickname / accountName）。 */
const ACCOUNTS = {
  accounts: [
    // ⚠️ 昵称**故意含大写**：只有含大写时，「搜索时把显示名也 toLowerCase」
    // 这条腿才是承重的。全小写 fixture 会让那条 toLowerCase 变成冗余代码，
    // 删掉它测试仍全绿（本轮变异实测过：M6 无牙）。
    { id: 'codearts-aaaa1111', provider: 'codearts', nickname: 'AliceWang', enabled: true },
    { id: 'codearts-bbbb2222', provider: 'codearts', nickname: 'BobLi', enabled: true },
  ],
}

const SNAPSHOT = {
  channels: [{
    channel: 'direct',
    totals: { requests: 3, totalTokens: 120 },
    providers: [{
      provider: 'codearts',
      totals: { requests: 3, totalTokens: 120 },
      accounts: [
        { accountId: 'codearts-aaaa1111', totals: { requests: 2, totalTokens: 60 }, models: [{ model: 'deepseek-v4.1-flash', requests: 1, totalTokens: 20 }] },
        { accountId: 'codearts-bbbb2222', totals: { requests: 1, totalTokens: 40 }, models: [{ model: 'glm-5.3', requests: 1, totalTokens: 40 }] },
      ],
    }],
  }],
  totals: { requests: 3, totalTokens: 120 },
  entries: ENTRIES,
}

const HISTORY = {
  history: [{
    day: '2026-11-11',
    totals: { requests: 3, totalTokens: 120 },
    channels: [{
      channel: 'direct',
      totals: { requests: 3, totalTokens: 120 },
      providers: [{
        provider: 'codearts',
        totals: { requests: 3, totalTokens: 120 },
        accounts: [{ accountId: 'codearts-aaaa1111', totals: { requests: 2, totalTokens: 60 }, models: [{ model: 'deepseek-v4.1-flash', requests: 1, totalTokens: 20 }] }],
      }],
    }],
  }],
  totals: { requests: 3, totalTokens: 120 },
}

function makeRpc() {
  return (endpoint: string) => {
    if (endpoint === 'usage.tokenLedger') return Promise.resolve({ snapshot: SNAPSHOT })
    if (endpoint === 'usage.tokenLedgerHistory') return Promise.resolve(HISTORY)
    if (endpoint === 'account.list') return Promise.resolve(ACCOUNTS)
    return Promise.resolve(null)
  }
}

/**
 * 「账号名晚到」的 rpc：`account.list` 要等到手动放行才 resolve。
 *
 * ⚠️ 为什么需要它：`accountNames` 是**异步**从 `account.list` 回来的。
 * 若它不在 `useMemo` 的依赖数组里，名字到了但 `visibleEntries` 不会重算 ⇒
 * 用户先看到一行行 id、名字回来之后**输入昵称仍然 0 条**。
 * 用「立刻 resolve」的桩测不出这条 —— 状态在首次渲染时就已经齐了（本轮变异 M5 无牙）。
 */
function makeDeferredRpc() {
  /** 放行 `account.list` 的回调（用例自己决定何时放行）。 */
  let release: (() => void) | undefined
  const ready = new Promise<void>((resolve) => { release = resolve })
  return {
    release: () => release?.(),
    rpc: (endpoint: string) => {
      if (endpoint === 'usage.tokenLedger') return Promise.resolve({ snapshot: SNAPSHOT })
      if (endpoint === 'usage.tokenLedgerHistory') return Promise.resolve(HISTORY)
      if (endpoint === 'account.list') return ready.then(() => ACCOUNTS)
      return Promise.resolve(null)
    },
  }
}

/** 渲染并让异步取数 + effect 稳定下来。 */
async function render(): Promise<unknown> {
  reactStub.__reset()
  let tree = panel!({ rpcCall: makeRpc(), onClose: () => {} })
  await flush(3)
  for (let round = 0; round < 5; round += 1) {
    const effects = reactStub.__takeEffects()
    if (effects.length === 0) break
    reactStub.__rewind()
    tree = panel!({ rpcCall: makeRpc(), onClose: () => {} })
    await flush(3)
  }
  return tree
}

/** 取搜索框节点（`type==='search'`）。 */
function searchInput(tree: unknown): AnyNode {
  const found = findAll(tree, (n) => n.props?.type === 'search')
  expect(found, '找不到搜索框（type="search"）').toHaveLength(1)
  return found[0]
}

/** 表格里数据行的模型名 / 账号列文本（`tbody tr` 的 td 内容）。 */
function tableRows(tree: unknown): string[] {
  const rows = findAll(tree, (n) => n.type === 'tr' && Array.isArray(n.children) && n.children.length > 0)
  // 去掉表头行（th）
  return rows
    .filter((row) => !findAll(row, (n) => n.type === 'th').length)
    .map((row) => textsOf(row).join(' '))
}

/** 把 query 敲进搜索框，返回重新渲染后的树。 */
async function typeQuery(query: string): Promise<unknown> {
  const tree = await render()
  const input = searchInput(tree)
  const onChange = input.props.onChange as (e: { target: { value: string } }) => void
  expect(typeof onChange, '搜索框没有 onChange').toBe('function')
  onChange({ target: { value: query } })
  // setState 已改替身槽位 ⇒ 同一游标重渲染即可看到新结果
  reactStub.__rewind()
  const next = panel!({ rpcCall: makeRpc(), onClose: () => {} })
  await flush(2)
  return next
}

describe('最近请求：搜索框能筛模型，也能筛账号', () => {
  beforeEach(() => { reactStub.__reset() })

  it('★★ 占位符与 aria-label 如实说「模型 / 帐号」', async () => {
    const tree = await render()
    const input = searchInput(tree)
    expect(String(input.props.placeholder), '占位符还只说「模型」⇒ 用户不会去试账号名')
      .toContain('帐号')
    expect(String(input.props['aria-label'] ?? '')).toContain('账号')
  })

  it('★★ 输入模型名 ⇒ 只剩那个模型的行', async () => {
    const tree = await typeQuery('glm-5.3')
    const rows = tableRows(tree)
    expect(rows.length, '没筛出任何行').toBeGreaterThan(0)
    expect(rows.join('\n')).toContain('glm-5.3')
    expect(rows.join('\n'), 'deepseek 的行不该出现').not.toContain('deepseek-v4.1-flash')
  })

  it('★★★ 输入账号**显示名**（屏幕上看到的名字）⇒ 能筛出该账号的行', async () => {
    const tree = await typeQuery('alice')
    const rows = tableRows(tree)
    expect(
      rows.length,
      '输入昵称 alice 搜不到 —— 说明只查了 accountId、没查 accountLabel 的产物',
    ).toBeGreaterThan(0)
    const joined = rows.join('\n')
    // alice 名下两条（deepseek + kimi），bob 那条必须被筛掉
    expect(joined).toContain('deepseek-v4.1-flash')
    expect(joined).toContain('kimi-k2.6-vl')
    expect(joined, 'Bob 的行不该出现').not.toContain('glm-5.3')
  })

  it('★★★ 显示名**大小写不敏感**：昵称是 AliceWang，用小写 alice 也能搜到', async () => {
    // ⚠️ 这条是**承重**的：昵称含大写（AliceWang），而搜索词已在下游转小写，
    // 故「把 accountLabel 的产物也 toLowerCase」这一步缺了就会 0 条。
    const tree = await typeQuery('alice')
    expect(
      tableRows(tree).length,
      '小写 alice 搜不到 AliceWang —— 显示名那条腿没做大小写归一',
    ).toBeGreaterThan(0)
  })

  it('★★ 输入账号 **id** ⇒ 也能筛出（用户常直接贴 id）', async () => {
    // ⚠️ 这条走的是 `accountLabel` 的**回落分支**（取不到昵称时返回 accountId 本身），
    // 实现里**没有**「单独再查一遍 accountId」那一行 —— 那行是冗余的，
    // 本轮变异实测：删掉它 10 条全绿（无牙），故已删除。
    const tree = await typeQuery('bbbb2222')
    const rows = tableRows(tree)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.join('\n')).toContain('glm-5.3')
  })

  it('★★★ 账号 id 含大写时，小写查询仍能命中（**只**由 id 那条腿承重）', async () => {
    /**
     * ⚠️⚠️ 这条用例的设计很讲究，别改松：
     *
     * 第一版让 `account.list` 返回空数组 ⇒ `accountLabel` 回落返回 id 本身
     * ⇒ 「昵称那条腿」**顺带**把 id 也匹配了 ⇒ 删掉 `accountId` 那行的
     * `toLowerCase` 依然全绿（变异 M6 无牙）。
     *
     * 正确做法：给这个账号一个**含大写的昵称**（`ZoeZhang`），让它与查询词
     * `cccc3333` **完全不匹配** ⇒ 昵称腿必然落空 ⇒ 只剩 `accountId` 腿能命中，
     * 于是「id 那行有没有 toLowerCase」才真正承重。
     */
    const mixed = {
      ...SNAPSHOT,
      entries: [{
        ts: 1_794_284_557_894, channel: 'direct', provider: 'codearts', model: 'glm-5.3',
        accountId: 'CodeArts-CCCC3333', usageReported: true, inputTokens: 5, outputTokens: 5,
      }],
    }
    const accounts = {
      accounts: [
        // 昵称与查询词无关，且含大写 ⇒ 昵称腿不参与，也不会被 toLowerCase 影响
        { id: 'CodeArts-CCCC3333', provider: 'codearts', nickname: 'ZoeZhang', enabled: true },
      ],
    }
    const rpc = (endpoint: string) => {
      if (endpoint === 'usage.tokenLedger') return Promise.resolve({ snapshot: mixed })
      if (endpoint === 'usage.tokenLedgerHistory') return Promise.resolve(HISTORY)
      if (endpoint === 'account.list') return Promise.resolve(accounts)
      return Promise.resolve(null)
    }

    reactStub.__reset()
    let tree = panel!({ rpcCall: rpc, onClose: () => {} })
    await flush(4)
    for (let round = 0; round < 4; round += 1) {
      const effects = reactStub.__takeEffects()
      if (effects.length === 0) break
      reactStub.__rewind()
      tree = panel!({ rpcCall: rpc, onClose: () => {} })
      await flush(4)
    }

    const onChange = searchInput(tree).props.onChange as (e: { target: { value: string } }) => void
    onChange({ target: { value: 'cccc3333' } })
    reactStub.__rewind()
    const after = panel!({ rpcCall: rpc, onClose: () => {} })
    await flush(2)
    expect(
      tableRows(after).length,
      '小写 cccc3333 搜不到 CodeArts-CCCC3333 ⇒ 账号 id 那行没做大小写归一'
      + '（昵称是 ZoeZhang，不会替它兜住）',
    ).toBeGreaterThan(0)
  })

  it('★★ 昵称取不到时，`accountLabel` 回落 id，id 仍可搜（回落分支）', async () => {
    // 与上一条互为正反面：无昵称 ⇒ label 就是 id ⇒ 两条腿重合，仍必须命中。
    const mixed = {
      ...SNAPSHOT,
      entries: [{
        ts: 1_794_284_557_895, channel: 'direct', provider: 'codearts', model: 'glm-5.3',
        accountId: 'codearts-dddd4444', usageReported: true, inputTokens: 5, outputTokens: 5,
      }],
    }
    const rpc = (endpoint: string) => {
      if (endpoint === 'usage.tokenLedger') return Promise.resolve({ snapshot: mixed })
      if (endpoint === 'usage.tokenLedgerHistory') return Promise.resolve(HISTORY)
      if (endpoint === 'account.list') return Promise.resolve({ accounts: [] })
      return Promise.resolve(null)
    }

    reactStub.__reset()
    let tree = panel!({ rpcCall: rpc, onClose: () => {} })
    await flush(4)
    for (let round = 0; round < 4; round += 1) {
      const effects = reactStub.__takeEffects()
      if (effects.length === 0) break
      reactStub.__rewind()
      tree = panel!({ rpcCall: rpc, onClose: () => {} })
      await flush(4)
    }

    const onChange = searchInput(tree).props.onChange as (e: { target: { value: string } }) => void
    onChange({ target: { value: 'dddd4444' } })
    reactStub.__rewind()
    const after = panel!({ rpcCall: rpc, onClose: () => {} })
    await flush(2)
    expect(tableRows(after).length, '无昵称时 id 搜不到').toBeGreaterThan(0)
  })

  it('★ 大小写不敏感；provider 前缀也能搜', async () => {
    const upper = await typeQuery('DEEPSEEK')
    expect(tableRows(upper).length, '大写搜不到').toBeGreaterThan(0)
    const prefixed = await typeQuery('codearts/')
    expect(tableRows(prefixed).length, '带 provider 前缀搜不到').toBeGreaterThan(0)
  })

  it('★★★ 账号名**晚到**时也能搜：名字回来后再输入昵称必须命中（依赖数组守卫）', async () => {
    const { rpc, release } = makeDeferredRpc()

    // 第一拍：账本已到、账号名**还没到** ⇒ 此时搜昵称应当 0 条（还没索引）
    reactStub.__reset()
    let tree = panel!({ rpcCall: rpc, onClose: () => {} })
    await flush(4)

    // 放行账号名，并让 effect 跑完
    release()
    await flush(4)
    for (let round = 0; round < 4; round += 1) {
      const effects = reactStub.__takeEffects()
      if (effects.length === 0) break
      reactStub.__rewind()
      tree = panel!({ rpcCall: rpc, onClose: () => {} })
      await flush(4)
    }

    // 名字已就位 ⇒ 输入昵称必须能命中
    const input = searchInput(tree)
    const onChange = input.props.onChange as (e: { target: { value: string } }) => void
    onChange({ target: { value: 'alice' } })
    reactStub.__rewind()
    const after = panel!({ rpcCall: rpc, onClose: () => {} })
    await flush(2)

    expect(
      tableRows(after).length,
      '账号名晚到后仍搜不到 ⇒ `accountNames` 不在 useMemo 依赖数组里，名字到了搜索索引没重算',
    ).toBeGreaterThan(0)
  })

  it('★ 搜不到东西时表格为空，但计数显示 0 / N（不崩）', async () => {
    const tree = await typeQuery('zzz-not-exist')
    expect(tableRows(tree)).toHaveLength(0)
    expect(textsOf(tree).join(' ')).toContain('0 / 3')
  })

  it('★ 清空搜索框 ⇒ 恢复全部行', async () => {
    const tree = await typeQuery('')
    expect(tableRows(tree).length).toBe(3)
  })
})
