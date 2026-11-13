/**
 * 「Token 用量」面板的**账号层 / 账号列**接线守卫（真渲染 + 真 RPC 桩）。
 *
 * ## 为什么必须另起一个文件、必须行为级
 *
 * `token-ledger-panel.spec.ts` 测的是**纯函数**（`accountLabel` / `buildAccountNameMap`），
 * 它们全绿完全不代表界面上真的用上了名字 —— 本仓库反复记录过这个形态：
 * 「纯函数测得动 + 源码字面量断言照得住」而**接线层零守卫**，于是
 * `panel.spec` 全绿而面板上恒显示裸 id。三处接线各自都能被独立改坏：
 *
 * | # | 接线点 | 被改坏的症状 |
 * |---|---|---|
 * | 1 | `account.list` 调用 | 传 `{}` 而不是 `{ provider }`（宿主 `account.list` 的过滤是 `a.provider === provider`）⇒ **恒空数组且不报错**，账号列全是裸 id |
 * | 2 | `accountLabel(id, accountNames)` | 漏传第二参 ⇒ 名字永远不生效（与「没实现」同形） |
 * | 3 | 表头 / 行同时加「账号」列 | 只改一处 ⇒ **所有列错位**（比不加列更糟） |
 *
 * ## 判据打在哪
 *
 * 不是「源码里有没有某个字面量」，而是：
 * 1. **真渲染** `TokenLedgerPanel`（经 `__tokenLedgerPanelForTest`），喂一份真实形状的
 *    账本快照 + 一份真实的 `account.list` 返回；
 * 2. 断言**渲染出来的树**里，账号行/账号格显示的是**名字**（不是裸 id）；
 * 3. 断言表头 9 列的顺序与行里 `td` 的顺序**逐格对应**（防错位）；
 * 4. 断言 `account.list` 是**按 provider 逐家**调的（不是一次 `{}` 扫全池）。
 *
 * ## ⚠️ 本文件的 react 替身刻意与 `checkin-panel-wiring.spec.ts` 同款
 *
 * `useState` 按槽位保存、`useEffect` 按 deps 逐项比较后才重跑 —— 这正是
 * 「`effect` 闭包停在第一次渲染」这类缺陷唯一能被抓住的地方。
 * ⚠️ `useRef` **必须同时写 `cur` 与 `current`**（真实 React 的 ref 对象属性叫
 * `current`；少了它 `ref.current` 恒 `undefined`，所有「只拉一次」的闸门会静默失效）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 样式文件全文（视觉契约断言要用；`here` 供 `resolve` 定位仓库根）。 */
const here = dirname(fileURLToPath(import.meta.url))

/** hooks 槽位（跨渲染保留，下标即调用顺序）。 */
let slots: Array<{ v?: unknown; cur?: unknown; current?: unknown }> = []
let cursor = 0
/** 每个 effect 槽位上上一次提交的 deps。 */
let committed: Array<{ deps: unknown[] | undefined }> = []
let root: unknown = undefined
let pendingEffects: number[] = []

interface Node { type: unknown; props: Record<string, unknown>; children: unknown[] }

const reactStub = {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const k = cursor++
    if (!(k in slots)) slots[k] = {}
    const s = slots[k]!
    if (!('v' in s)) s.v = typeof initial === 'function' ? (initial as () => T)() : initial
    return [s.v as T, (next) => {
      s.v = typeof next === 'function' ? (next as (prev: T) => T)(s.v as T) : next
    }]
  },
  useRef<T>(initial: T) {
    const k = cursor++
    if (!(k in slots)) slots[k] = {}
    const s = slots[k]!
    // ⚠️⚠️ `current` 与 `cur` 都要写：真实 React 的 ref 属性叫 `current`。
    //    只写 `cur` 会让 `ref.current` 恒 `undefined` ⇒ `namedProviders` 那类
    //    「只拉一次」的闸门退化成「每次都拉」甚至「永远不拉」。
    if (!('cur' in s)) { s.cur = initial; (s as { current?: T }).current = initial }
    return s as unknown as { current: T }
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    const k = cursor++
    const prev = committed[k]
    const changed = prev === undefined || deps === undefined
      || deps.length !== (prev.deps?.length ?? -1)
      || deps.some((d, i) => d !== prev.deps![i])
    if (!changed) return
    committed[k] = { deps }
    pendingEffects.push(k)
    Promise.resolve().then(() => { try { fn() } catch { /* 与本用例无关的副作用忽略 */ } })
  },
  useLayoutEffect(fn: () => void) { Promise.resolve().then(() => { try { fn() } catch { /* ignore */ } }) },
  useCallback<T>(fn: T): T { return fn },
  useMemo<T>(fn: () => T): T { return fn() },
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node {
    return { type, props: props ?? {}, children }
  },
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
  Component: class {},
}

vi.mock('react', () => reactStub)

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const flush = async (n = 8): Promise<void> => { for (let i = 0; i < n; i += 1) await tick() }

type AnyNode = { type: unknown; props: Record<string, unknown>; children: unknown[] }

function walk(nodes: unknown[], visit: (node: AnyNode) => void): void {
  for (const raw of nodes) {
    if (Array.isArray(raw)) { walk(raw, visit); continue }
    if (raw === null || typeof raw !== 'object') continue
    const node = raw as AnyNode
    if (!('props' in node)) continue
    visit(node)
    if (Array.isArray(node.children)) walk(node.children, visit)
  }
}

function findAll(pred: (node: AnyNode) => boolean): AnyNode[] {
  const out: AnyNode[] = []
  walk([root], (node) => { if (pred(node)) out.push(node) })
  return out
}

/** 收集任意深度上的字符串（`textsIn` 的同款；不能复用 `walk` —— 字符串不是对象）。 */
function textsIn(nodes: unknown[]): string[] {
  const out: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { out.push(value); return }
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (value === null || typeof value !== 'object') return
    visit((value as AnyNode).children)
  }
  visit(nodes)
  return out
}

/** 每个 `display: none` 的祖先都要过滤掉？本替身不展开子组件，故不需要。 */
let panel: ((props: { rpcCall: (m: string, p?: unknown) => Promise<unknown>; onClose: () => void }) => unknown) | undefined

async function renderPanel(rpcCall: (m: string, p?: unknown) => Promise<unknown>): Promise<void> {
  cursor = 0
  pendingEffects = []
  root = panel!({ rpcCall, onClose: () => {} })
  await flush(3)
  let guard = 0
  while (pendingEffects.length > 0 && guard < 6) {
    pendingEffects = []
    cursor = 0
    root = panel!({ rpcCall, onClose: () => {} })
    await flush(3)
    guard += 1
  }
}

/**
 * 一份**真实形状**的账本快照：
 * - `qodercn` 下**两个账号，各 1 个模型** ⇒ 都会走「单模型合并行」（账号 → 模型）；
 * - `workbuddy` 下**只有一个账号**（决策 Q3：单账号也分层），且它有 **2 个模型**
 *   ⇒ 走「不合并」分支（账号行 + 缩进的模型行）；
 * - 明细里有一笔 `accountId` 为空的请求（账户列的「未归属」格）。
 *
 * ⚠️ 这样一份 fixture **同时覆盖两条分支**（合并 / 不合并），
 *    任何一条被判据写错都会立刻变红。三个账号全同构的 fixture 测不出分叉。
 */
const SNAPSHOT = {
  channels: [
    {
      channel: 'direct',
      totals: { requests: 3, totalTokens: 300 },
      providers: [
        {
          provider: 'qodercn',
          totals: { requests: 2, totalTokens: 200 },
          accounts: [
            {
              accountId: 'qodercn-c5a414d5',
              totals: { requests: 1, totalTokens: 100 },
              models: [{ model: 'dfmodel', requests: 1, totalTokens: 100 }],
            },
            {
              accountId: 'qodercn-f01648a6',
              totals: { requests: 1, totalTokens: 100 },
              models: [{ model: 'qmodel_38max', requests: 1, totalTokens: 100 }],
            },
            // ⚠️ 服务端的**空账号哨兵**：`src/token-ledger.ts` 把空 accountId 归一成
            //    `'-'`（Map 键不能缺失），原样传给客户端。界面必须显示「（未知帐号）」
            //    而不是裸 `-`（用户 2026-11-11 报障「怎么出现一条没有帐号的呢」）。
            {
              accountId: '-',
              totals: { requests: 1, totalTokens: 50 },
              models: [{ model: 'dfmodel', requests: 1, totalTokens: 50 }],
            },
          ],
        },
        {
          provider: 'workbuddy',
          totals: { requests: 2, totalTokens: 200 },
          accounts: [
            {
              accountId: 'workbuddy-4c6e5683',
              totals: { requests: 2, totalTokens: 200 },
              models: [
                { model: 'deepseek-v4.1-flash', requests: 1, totalTokens: 100 },
                { model: 'gpt-6-sol', requests: 1, totalTokens: 100 },
              ],
            },
          ],
        },
      ],
    },
  ],
  totals: { requests: 3, totalTokens: 300 },
  entries: [
    { ts: 1_794_284_557_890, channel: 'direct', provider: 'qodercn', model: 'dfmodel', accountId: 'qodercn-c5a414d5', usageReported: true, inputTokens: 50, outputTokens: 50 },
    { ts: 1_794_284_500_000, channel: 'direct', provider: 'qodercn', model: 'qmodel_38max', accountId: 'qodercn-f01648a6', usageReported: true, inputTokens: 50, outputTokens: 50 },
    { ts: 1_794_284_400_000, channel: 'direct', provider: 'workbuddy', model: 'deepseek-v4.1-flash', accountId: 'workbuddy-4c6e5683', usageReported: true, inputTokens: 50, outputTokens: 50 },
    // ⚠️ 这一笔**没有** accountId：账号列必须显示「未归属」，不许渲染空白格。
    { ts: 1_794_284_300_000, channel: 'direct', provider: 'workbuddy', model: 'deepseek-v4.1-flash', usageReported: true, inputTokens: 10, outputTokens: 10 },
  ],
}

/**
 * `account.list` 的桩：**按 provider 过滤**（与宿主 `pool.listAccounts` 同判据）。
 * ⚠️ 传 `{}`（无 provider）时必须返回**空数组** —— 这正是真实宿主的行为，
 * 也是「只调一次 `account.list` 就以为能拿到全部账号」那个缺陷的症状来源。
 */
const ACCOUNTS: Record<string, Array<Record<string, unknown>>> = {
  qodercn: [
    // nickname 优先：用户自己填的备注名赢过上游用户名。
    { id: 'qodercn-c5a414d5', nickname: 'M籾 959', accountName: 'mylzscy4' },
    // nickname 是空串 ⇒ 用 accountName（上游真实用户名）。
    { id: 'qodercn-f01648a6', nickname: '', accountName: 'upstream-016' },
  ],
  workbuddy: [
    { id: 'workbuddy-4c6e5683', nickname: 'clover e', accountName: 'clover-upstream' },
  ],
}

function makeRpc(): { calls: Array<{ method: string; payload: unknown }>; rpcCall: (m: string, p?: unknown) => Promise<unknown> } {
  const calls: Array<{ method: string; payload: unknown }> = []
  const rpcCall = async (method: string, payload?: unknown): Promise<unknown> => {
    calls.push({ method, payload })
    if (method === 'usage.tokenLedger') return { snapshot: SNAPSHOT }
    if (method === 'usage.tokenLedgerHistory') return { history: [], totals: { requests: 0, totalTokens: 0 } }
    if (method === 'account.list') {
      const provider = (payload as { provider?: unknown } | undefined)?.provider
      const list = typeof provider === 'string' ? ACCOUNTS[provider] ?? [] : []
      return { accounts: list }
    }
    return {}
  }
  return { calls, rpcCall }
}

describe('★ Token 面板按账号归档 · 接线层行为守卫', () => {
  // ⚠️ 组件必须在 `vi.mock('react')` 已生效之后再取 —— 顶层 `import` 会被提升到
  //    mock 之前，那样拿到的是**真实** React（本仓库没有依赖它）⇒ 直接报错。
  beforeAll(async () => {
    const mod = await import('../../plugin-src/client/jet-hub.js') as unknown as {
      __tokenLedgerPanelForTest?: typeof panel
    }
    panel = mod.__tokenLedgerPanelForTest
    expect(typeof panel, 'jet-hub.js 没有导出 __tokenLedgerPanelForTest').toBe('function')
  })

  beforeEach(() => {
    slots = []
    committed = []
    cursor = 0
    pendingEffects = []
    root = undefined
  })

  it('★★ account.list 必须**按 provider 逐家**调（传 {} 会恒空而且不报错）', async () => {
    const { calls, rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const listCalls = calls.filter((c) => c.method === 'account.list')
    // 账本里出现过 2 家 ⇒ 至少各调一次（去重后不会更多）。
    const providers = listCalls.map((c) => (c.payload as { provider?: unknown } | undefined)?.provider)
    expect(providers).toContain('qodercn')
    expect(providers).toContain('workbuddy')
    // 每一条都必须**带** provider —— 不带的调用在宿主侧恒返回空数组。
    for (const p of providers) expect(typeof p).toBe('string')
    // 不许多调：同一 provider 只拉一次（否则切窗口/翻页会把凭据重读一遍）。
    expect(providers.filter((p) => p === 'qodercn')).toHaveLength(1)
    expect(providers.filter((p) => p === 'workbuddy')).toHaveLength(1)
  })

  it('★★ 账号层显示**名字**（nickname 优先，其次 accountName），不是裸 id', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const accountHeads = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountName')
    const labels = accountHeads.map((node) => textsIn([node]).join(''))
    // nickname 优先
    expect(labels).toContain('M籾 959')
    // nickname 空串 ⇒ accountName
    expect(labels).toContain('upstream-016')
    expect(labels).toContain('clover e')
    // 裸 id 一个都不该露在**文本**里（它们只允许出现在 title 悬停里）。
    expect(labels).not.toContain('qodercn-c5a414d5')
    expect(labels).not.toContain('workbuddy-4c6e5683')
    // 完整 id 仍可从 title 悬停看到（决策 Q2-A）。
    const titles = accountHeads.map((node) => node.props?.title)
    expect(titles).toContain('qodercn-c5a414d5')
    expect(titles).toContain('workbuddy-4c6e5683')
  })

  it('★★★ 单账号也分层（决策 Q3：不加开关，1 个账号同样渲染账号行）', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const accountRows = findAll((node) => node.props?.className === 'dim-jh-ledgerAccount')
    // workbuddy 只有 1 个账号 —— 改前它会被平铺，账号行根本不出现。
    // ⚠️ 2026-11-11 起不再靠 `data-single` 找单账号（该属性已删，样式统一）：
    //    判据改成「那个 provider 子树里确实只有这一段账号行」。
    const heads = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountName')
      .map((node) => textsIn([node]).join(''))
    // 单账号的 workbuddy 必须有自己的账号行（名字来自 nickname）。
    expect(heads).toContain('clover e')
    // 且它**没有**兄弟账号行 —— 证明这是「单账号」那一格，不是多账号碰巧命中。
    expect(heads.filter((t) => t === 'clover e')).toHaveLength(1)
    // 账号行数量 = 4（qodercn 三个：两个真账号 + 一个空账号哨兵 -；workbuddy 一个），不多不少。
    expect(accountRows).toHaveLength(4)
  })

  it('★★ 层级样式：账号行必须挂色块类名，模型行不挂（视觉区分度的接线守卫）', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    // 账号头是**色块分组头**：className 必须是 ledgerAccountHead。
    // 3 个账号（qodercn×2 单模型 + workbuddy×1 双模型）⇒ 3 个账号头，
    // 单模型合并**不会减少账号头**（它只吞掉下面的模型行）。
    const heads = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountHead')
    expect(heads.length).toBe(4)
    // 模型行必须是 ledgerModel（不带 Account 语义），否则样式会套错。
    const models = findAll((node) => node.props?.className === 'dim-jh-ledgerModel')
    expect(models.length).toBeGreaterThan(0)
    // ⚠️ 死代码守卫：`data-single` 已随「单账号与多账号完全一样」的决策删除。
    //    判据只认**属性键**（渲染出来的 props），不认源码注释。
    expect(findAll((node) => 'data-single' in (node.props ?? {}))).toHaveLength(0)
  })

  /**
   * ★★★ 单模型账号合并（用户 2026-11-11 需求）
   *
   * 规则：账号下**只有 1 个模型** ⇒ 合并成一行 `账号 → 模型  次数  [右侧统计]`；
   * 多个模型 ⇒ 保持现状（账号行 + 缩进模型行）。
   *
   * 实测本机账本：44 个账号桶里 **20 个（45.5%）** 只有 1 个模型，所以这条
   * 分支覆盖近一半的真实数据，必须有行为级守卫。
   */
  it('★★★ 单模型账号必须合并成一行：账号 → 模型（带箭头与行内模型名）', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    // 合并行 = 账号头里同时有「箭头」和「行内模型名」两个 span
    const arrows = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountArrow')
    const inlineModels = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountModel')
    // qodercn 的两个账号都是单模型 ⇒ 2 条合并行
    expect(arrows, '单模型账号必须出现 → 箭头').toHaveLength(3)
    expect(inlineModels).toHaveLength(3)
    const modelTexts = inlineModels.map((node) => textsIn([node]).join(''))
    expect(modelTexts).toContain('dfmodel')
    expect(modelTexts).toContain('qmodel_38max')
    // ⚠️ 反向：合并后这 2 个模型**不得**再作为缩进模型行出现（否则重复计数）
    const nested = findAll((node) => node.props?.className === 'dim-jh-ledgerModel')
      .map((node) => textsIn([node]).join(''))
    expect(nested.some((t) => t.includes('dfmodel'))).toBe(false)
    expect(nested.some((t) => t.includes('qmodel_38max'))).toBe(false)
  })

  it('★★★ 多模型账号**不合并**：仍保留账号行 + 缩进的模型行', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    // workbuddy 那个账号有 2 个模型 ⇒ 它的账号头里**不许**有箭头
    const heads = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountHead')
    const wbHead = heads.find((node) => textsIn([node]).join('').includes('clover e'))
    expect(wbHead, '找不到 workbuddy 的账号头').toBeTruthy()
    expect(wbHead!.children.some((c) => (c as AnyNode)?.props?.className === 'dim-jh-ledgerAccountArrow'))
      .toBe(false)
    // 它的两个模型必须以缩进模型行出现（带 ↳ 的 .dim-jh-ledgerModel）
    const nested = findAll((node) => node.props?.className === 'dim-jh-ledgerModel')
      .map((node) => textsIn([node]).join(''))
    expect(nested.some((t) => t.includes('deepseek-v4.1-flash'))).toBe(true)
    expect(nested.some((t) => t.includes('gpt-6-sol'))).toBe(true)
  })

  it('★★★ 统计信息包在 StatGroup 里，且「次数」在组内第一格（不是紧跟模型名）', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const heads = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountHead')
    expect(heads.length).toBeGreaterThan(0)
    for (const head of heads) {
      const classes = head.children.map((c) => (c as AnyNode)?.props?.className).filter(Boolean)
      // 左侧：[账号名]（+ 单模型时的箭头/模型名），右侧整组统计
      expect(classes[0]).toBe('dim-jh-ledgerAccountName')
      expect(classes, '账号头必须以 StatGroup 结尾').toContain('dim-jh-ledgerStatGroup')
      // ⚠️ 次数/首字/总处理**不再平铺**在账号头里 —— 它们收进 StatGroup 内
      expect(classes).not.toContain('dim-jh-ledgerAccountReq')
    }
    // StatGroup 内部顺序：次数 → perf → 总处理
    const groups = findAll((node) => node.props?.className === 'dim-jh-ledgerStatGroup')
    expect(groups.length).toBeGreaterThan(0)
    for (const g of groups) {
      const inner = g.children.map((c) => (c as AnyNode)?.props?.className).filter(Boolean)
      const idxReq = inner.findIndex((c) => c === 'dim-jh-ledgerAccountReq' || c === 'dim-jh-ledgerModelReq')
      const idxTok = inner.findIndex((c) => c === 'dim-jh-ledgerModelTokens' || c === 'dim-jh-ledgerAccountSum')
      expect(idxReq, '组内第一格必须是次数').toBe(0)
      expect(idxTok, '总处理必须在次数之后').toBeGreaterThan(idxReq)
    }
    const styles = readFileSync(resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
    expect(styles).toMatch(/\.dim-jh-ledgerStatGroup\s*\{[^}]*width:\s*460px/)
  })

  it('★★★ 账号行的「总处理」：单模型加粗、多模型不加粗', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const heads = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountHead')
    for (const head of heads) {
      const group = head.children.find((c) => (c as AnyNode)?.props?.className === 'dim-jh-ledgerStatGroup')
      expect(group, '账号头缺少 StatGroup').toBeTruthy()
      const inner = (group as AnyNode).children.map((c) => (c as AnyNode)?.props?.className).filter(Boolean)
      // 单模型（有箭头）⇒ ModelTokens（加粗）；多模型 ⇒ AccountSum（不加粗）
      const isMerged = head.children.some((c) => (c as AnyNode)?.props?.className === 'dim-jh-ledgerAccountArrow')
      if (isMerged) {
        expect(inner, '单模型合并行的总处理必须加粗（ModelTokens）').toContain('dim-jh-ledgerModelTokens')
        expect(inner).not.toContain('dim-jh-ledgerAccountSum')
      } else {
        expect(inner, '多模型账号合计必须不加粗（AccountSum）').toContain('dim-jh-ledgerAccountSum')
        expect(inner).not.toContain('dim-jh-ledgerModelTokens')
      }
    }
  })

  it('★★ 空账号哨兵 `-` 必须渲染成「（未知帐号）」', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    // fixture 里补一条 accountId 为 '-' 的账号（服务端空账号哨兵）
    const labels = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountName')
      .map((node) => textsIn([node]).join(''))
    // 不许出现裸 `-`
    expect(labels).not.toContain('-')
    // 应当显示「（未知帐号）」
    expect(labels).toContain('（未知帐号）')
  })

  it('★★★ 明细表「账号」列：表头与行的顺序逐格对应（只改一处会让所有列错位）', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const table = findAll((node) => node.props?.className === 'dim-jh-ledgerTable')[0]
    expect(table, '明细表没渲染出来 ⇒ 本文件失效（结构已变）').toBeTruthy()

    const ths = findAll((node) => node.type === 'th').map((node) => textsIn([node]).join(''))
    expect(ths).toEqual(['时间', '渠道', '账号', '模型', 'TOKEN', '首字', '速率', '耗时', '状态'])

    const rows = findAll((node) => node.type === 'tr' && Array.isArray(node.children)
      && node.children.some((c) => (c as AnyNode)?.type === 'td'))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const tds = row.children.filter((c) => (c as AnyNode)?.type === 'td') as AnyNode[]
      // ⚠️ 行与表头的列数必须相等 —— 缺一格就是「所有列整体左移」。
      expect(tds).toHaveLength(ths.length)
    }
  })

  it('★★ 明细表的账号格显示名字；没有 accountId 的行显示「未归属」', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const cells = findAll((node) => node.props?.className === 'dim-jh-ledgerEntryAccount')
    const cellTexts = cells.map((node) => textsIn([node]).join(''))
    expect(cellTexts).toContain('M籾 959')
    expect(cellTexts).toContain('upstream-016')
    expect(cellTexts).toContain('clover e')
    // 第四笔没有 accountId ⇒ 「未归属」（不是空白）。
    expect(cellTexts).toContain('未归属')
    // 裸 id 不许出现在单元格文本里。
    expect(cellTexts).not.toContain('qodercn-c5a414d5')
  })

  it('★★★ 明细表的模型格显示 provider/模型（不是裸模型 id）', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    const cells = findAll((node) => node.props?.className === 'dim-jh-ledgerEntryModel')
    const cellTexts = cells.map((node) => textsIn([node]).join(''))
    // 四笔明细：qodercn×2 / workbuddy×2
    expect(cellTexts).toContain('qodercn/dfmodel')
    expect(cellTexts).toContain('qodercn/qmodel_38max')
    expect(cellTexts).toContain('workbuddy/deepseek-v4.1-flash')
    // ⚠️ 反向：裸模型名**不得**单独出现（那就是本需求未实现）
    expect(cellTexts).not.toContain('dfmodel')
    expect(cellTexts).not.toContain('qmodel_38max')
    // title 挂完整串（窄屏省略号截断时靠悬停看全）
    const titles = cells.map((node) => node.props?.title)
    expect(titles).toContain('qodercn/dfmodel')
  })

  it('★★ 明细表包在横向滚动容器里（9 列固定宽，窄屏放不下）', async () => {
    const { rpcCall } = makeRpc()
    await renderPanel(rpcCall)
    expect(findAll((node) => node.props?.className === 'dim-jh-ledgerTableScroll')).toHaveLength(1)
  })

  it('★ account.list 失败必须静默：面板照常显示，账号回落 id', async () => {
    const calls: string[] = []
    const rpcCall = async (method: string, payload?: unknown): Promise<unknown> => {
      calls.push(method)
      if (method === 'usage.tokenLedger') return { snapshot: SNAPSHOT }
      if (method === 'usage.tokenLedgerHistory') return { history: [], totals: {} }
      if (method === 'account.list') throw new Error('模拟凭据读取失败')
      return {}
    }
    // ⚠️ 不 catch ⇒ 名字加载的 rejection 若冒泡，这里会直接把用例打红。
    await renderPanel(rpcCall)
    const labels = findAll((node) => node.props?.className === 'dim-jh-ledgerAccountName')
      .map((node) => textsIn([node]).join(''))
    // 账本主数据照常显示，名字回落**内部 id**（这是对的：账号可能真被删了）。
    expect(labels).toContain('qodercn-c5a414d5')
    expect(labels).toContain('workbuddy-4c6e5683')
    // 面板本体没被顶掉。
    expect(findAll((node) => node.type === 'table').length).toBe(1)
  })
})
