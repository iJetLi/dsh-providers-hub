/**
 * `TokenLedgerPanel` 的**两种外壳**（`chrome: 'modal' | 'pane'`）行为守卫。
 *
 * ## 为什么必须单独一个文件、必须是行为级
 *
 * `ledger-tab-wiring.spec.ts` 只证明「注册进宿主的是什么东西」；它完全不碰
 * `jet-hub.js`。而本次改动真正危险的地方在**面板内部**：
 *
 * | # | 可能被静默改坏的接线 | 症状 |
 * |---|---|---|
 * | 1 | pane 分支漏了内容三件套中的某一个 | 标签页里少一整块（历史 / 汇总 / 明细） |
 * | 2 | pane 分支照抄了「完成」按钮 | 与标签页自己的 × 语义打架，点了会关错东西 |
 * | 3 | pane 分支包了遮罩（`dim-jh-modalOverlay`） | `position: fixed` 盖住整个应用 |
 * | 4 | modal 分支被顺手改成也走 pane | Jet Hub 页头的弹窗变成一块贴在页里的方块 |
 *
 * 第 1 条的三种子情形**都能单独发生**（删一行就少一块），故逐块断言而不是
 * 「渲染结果非空」。第 4 条是「重构顺手把别人也改了」的典型形态。
 *
 * ## 替身的诚实边界
 *
 * 替身 React 不实现协调协议：`useState` 按槽位保存、`useEffect` 按 deps 比较、
 * 不展开子组件（只展开一层）。故本文件证明的是**本组件自己产出的元素树**长什么样，
 * 不证明「React 真的会这么渲染」。真机验收另算。
 *
 * @module tests/unit/ledger-pane-chrome.spec.ts
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// ── 替身 React：按槽位保存 state / 按 deps 重跑 effect（本仓既有形态） ──
const reactStub = vi.hoisted(() => {
  const slots = []
  let cursor = 0
  const committed = []
  const pending = []

  const stub = {
    __reset() {
      slots.length = 0
      cursor = 0
      committed.length = 0
      pending.length = 0
    },
    __takeEffects() {
      const out = pending.splice(0)
      return out
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
      // ⚠️ current 与 cur 都要写（真实 React 的属性叫 current）
      if (!('cur' in slot)) { slot.cur = initial; slot.current = initial }
      return slot
    },
    useEffect(fn, deps) {
      const k = cursor++
      const prev = committed[k]
      const changed = prev === undefined || deps === undefined
        || deps.length !== (prev.deps?.length ?? -1)
        || deps.some((d, i) => d !== prev.deps[i])
      if (!changed) return
      committed[k] = { deps }
      pending.push(k)
      Promise.resolve().then(() => { try { fn() } catch { /* 取数失败由组件自己兜 */ } })
    },
    useLayoutEffect(fn) { Promise.resolve().then(() => { try { fn() } catch { /* ignore */ } }) },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    Fragment: 'Fragment',
    StrictMode: 'StrictMode',
    Component: class {
      constructor(props) { this.props = props; this.state = {} }
      setState(partial) {
        this.state = { ...this.state, ...(typeof partial === 'function' ? partial(this.state) : partial) }
      }
    },
  }
  return stub
})

vi.mock('react', () => reactStub)

type AnyNode = { type: unknown; props: Record<string, unknown>; children: unknown[] }

/** 递归收集元素树里满足条件的节点。 */
function findAll(node: unknown, predicate: (node: AnyNode) => boolean, out: AnyNode[] = []): AnyNode[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  const element = node as AnyNode
  if (!('props' in element)) return out
  if (predicate(element)) out.push(element)
  if (Array.isArray(element.children)) findAll(element.children, predicate, out)
  return out
}

/** 树里出现的所有 className 字符串。 */
function classNamesOf(tree: unknown): string[] {
  return findAll(tree, (node) => typeof node.props?.className === 'string')
    .map((node) => String(node.props.className))
}

/**
 * 树里出现过的**单个类名**（把 `className` 按空白切开）。
 *
 * ⚠️⚠️ 必须切开再判，不能对整串 `className` 做 `toContain` / `===`：
 * 变异实测（2026-11-12）—— 把 pane 的根类名改成
 * `'dim-jh-modalOverlay dim-jh-ledgerPane'`（**同一个字符串里多一个词**）时，
 * 「不含 dim-jh-modalOverlay」那条断言**无牙**：整串不等于目标词，而
 * `.some((name) => name.includes(...))` 又只查了 `dim-jh-modal--ledger`。
 * 那是典型的「判据看着在、其实绕过了」形态，故这里统一按词粒度判。
 */
function classTokensOf(tree: unknown): string[] {
  return classNamesOf(tree).flatMap((name) => name.split(/\s+/).filter(Boolean))
}

/** 树里的所有文本（递归到字符串）。 */
function textsOf(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textsOf(child, out); return out }
  if (typeof node !== 'object') return out
  const element = node as AnyNode
  if (Array.isArray(element.children)) for (const child of element.children) textsOf(child, out)
  return out
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await tick() }

let panel: ((props: Record<string, unknown>) => unknown) | undefined

beforeAll(async () => {
  const mod = await import('../../plugin-src/client/jet-hub.js') as unknown as {
    __tokenLedgerPanelForTest?: typeof panel
  }
  panel = mod.__tokenLedgerPanelForTest
  expect(typeof panel, 'jet-hub.js 没有导出 __tokenLedgerPanelForTest').toBe('function')
})

/**
 * 渲染一次并等逻辑稳定。
 *
 * ⚠️ 替身的 hooks 是**按调用顺序**取槽位，故每次重渲染都要先把游标归零。
 */
async function render(props: Record<string, unknown>): Promise<unknown> {
  reactStub.__reset()
  let tree = panel!(props)
  await flush(2)
  for (let round = 0; round < 4; round += 1) {
    const effects = reactStub.__takeEffects()
    if (effects.length === 0) break
    reactStub.__rewind()
    tree = panel!(props)
    await flush(2)
  }
  return tree
}

/** 一份最小可用账本：一个渠道 → 一个 provider → 一个账号 → 一个模型。 */
const SNAPSHOT = {
  channels: [{
    channel: 'direct',
    totals: { requests: 2, totalTokens: 200 },
    providers: [{
      provider: 'codearts',
      totals: { requests: 2, totalTokens: 200 },
      accounts: [{
        accountId: 'codearts-89d2d92a',
        totals: { requests: 2, totalTokens: 200 },
        models: [{ model: 'deepseek-v4.1-flash', requests: 2, totalTokens: 200 }],
      }],
    }],
  }],
  totals: { requests: 2, totalTokens: 200 },
  entries: [{
    ts: 1_794_284_557_890, channel: 'direct', provider: 'codearts', model: 'deepseek-v4.1-flash',
    accountId: 'codearts-89d2d92a', usageReported: true, inputTokens: 100, outputTokens: 100,
  }],
}

/**
 * 历史日聚合。**必须非空**：`renderHistory()` 在 `historyDays.length === 0` 时走
 * 「还没有历史用量」的空态分支，热力图与日树**都不会渲染** —— 拿空数组断言
 * 「热力图在」会得到一个假红（我第一版就是这么错的），而拿它断言「不在」又会让
 * 「pane 漏了历史区」这个真缺陷逃掉。
 */
const HISTORY = {
  history: [{
    day: '2026-11-11',
    totals: { requests: 2, totalTokens: 200 },
    channels: [{
      channel: 'direct',
      totals: { requests: 2, totalTokens: 200 },
      providers: [{
        provider: 'codearts',
        totals: { requests: 2, totalTokens: 200 },
        accounts: [{
          accountId: 'codearts-89d2d92a',
          totals: { requests: 2, totalTokens: 200 },
          models: [{ model: 'deepseek-v4.1-flash', requests: 2, totalTokens: 200 }],
        }],
      }],
    }],
  }],
  totals: { requests: 2, totalTokens: 200 },
}

/** 桩 rpcCall：按端点回两份固定数据。 */
function makeRpc() {
  return (endpoint: string) => {
    if (endpoint === 'usage.tokenLedger') return Promise.resolve({ snapshot: SNAPSHOT })
    if (endpoint === 'usage.tokenLedgerHistory') return Promise.resolve(HISTORY)
    if (endpoint === 'account.list') return Promise.resolve({ accounts: [] })
    return Promise.resolve(null)
  }
}

describe('modal 外壳（默认，Jet Hub 页头那个入口）', () => {
  beforeEach(() => { reactStub.__reset() })

  it('★ 默认 chrome 下渲染**遮罩 + dialog**（与改动前逐字节一致）', async () => {
    const tree = await render({ rpcCall: makeRpc(), onClose: () => {} })
    const tokens = classTokensOf(tree)
    expect(tokens, '默认不再是覆盖层 —— Jet Hub 页头的弹窗会变成页内方块').toContain('dim-jh-modalOverlay')
    expect(tokens).toContain('dim-jh-modal')
    expect(tokens).toContain('dim-jh-modal--ledger')
    // 「完成」按钮只在 modal 里
    expect(textsOf(tree), 'modal 缺「完成」按钮').toContain('完成')
  })

  it('modal 里有 dialog 语义（role / aria-modal / aria-label）', async () => {
    const tree = await render({ rpcCall: makeRpc(), onClose: () => {} })
    const dialogs = findAll(tree, (node) => node.props?.role === 'dialog')
    expect(dialogs, '找不到 role="dialog"').toHaveLength(1)
    expect(dialogs[0].props['aria-modal']).toBe('true')
    expect(dialogs[0].props['aria-label']).toBe('Token 用量')
  })
})

describe('pane 外壳（右侧栏标签页）', () => {
  beforeEach(() => { reactStub.__reset() })

  it('★★ 不渲染遮罩、不渲染 dialog 语义', async () => {
    const tree = await render({ rpcCall: makeRpc(), chrome: 'pane' })
    const tokens = classTokensOf(tree)
    expect(
      tokens,
      'pane 渲染了覆盖层 —— position: fixed 会盖住整个应用',
    ).not.toContain('dim-jh-modalOverlay')
    expect(
      tokens,
      'pane 用了弹窗的宽度类（min(960px,100%)）',
    ).not.toContain('dim-jh-modal--ledger')
    expect(
      tokens,
      'pane 用了弹窗的容器类',
    ).not.toContain('dim-jh-modal')
    expect(
      findAll(tree, (node) => node.props?.role === 'dialog'),
      'pane 不该有 dialog 语义 —— 标签页本身就是控件',
    ).toHaveLength(0)
    expect(
      findAll(tree, (node) => node.props?.['aria-modal'] !== undefined),
      'pane 不该有 aria-modal',
    ).toHaveLength(0)
  })

  it('★★ 不渲染「完成」按钮（关闭是标签页自己的 ×）', async () => {
    const tree = await render({ rpcCall: makeRpc(), chrome: 'pane' })
    expect(
      textsOf(tree),
      'pane 里有「完成」按钮 —— 与标签页的关闭语义打架',
    ).not.toContain('完成')
    // 「刷新」必须还在：它才有用
    expect(textsOf(tree), 'pane 里连「刷新」都没了').toContain('刷新')
  })

  it('★ 根节点是 dim-jh-ledgerPane，且带 data-chrome="pane"（容器查询的作用点）', async () => {
    const tree = await render({ rpcCall: makeRpc(), chrome: 'pane' })
    const root = tree as AnyNode
    expect(String(root.props?.className)).toContain('dim-jh-ledgerPane')
    expect(root.props?.['data-chrome']).toBe('pane')
  })

  it('★★ 标题行 / 说明行 / 内容区三件套都在（少一块就是少一整屏内容）', async () => {
    const tree = await render({ rpcCall: makeRpc(), chrome: 'pane' })
    const tokens = classTokensOf(tree)
    expect(tokens, '缺标题行').toContain('dim-jh-modalHead')
    expect(tokens, '缺说明行').toContain('dim-jh-modalHint')
    expect(tokens, '缺内容区（pane 专用滚动容器）').toContain('dim-jh-ledgerPaneBody')
    expect(tokens, 'pane 内容区用了弹窗的滚动类').not.toContain('dim-jh-modalBody')
    const texts = textsOf(tree)
    expect(texts, '缺标题文案').toContain('Token 用量')
    // 说明行的两句都要在（悬停口径那句是用户自查的唯一入口）
    expect(texts.join(' ')).toContain('悬停数字查看 Token 拆分与性能口径')
  })

  it('★★ 内容三件套的**渲染结果**都在：历史区 / 汇总树 / 明细表', async () => {
    const tree = await render({ rpcCall: makeRpc(), chrome: 'pane' })
    const tokens = classTokensOf(tree)
    const texts = textsOf(tree).join(' ')
    // 历史区（热力图）
    expect(tokens, '缺历史热力图').toContain('dim-jh-ledgerHeatmap')
    // 汇总树（provider / 账号 / 模型三层）
    expect(tokens.join(' '), '缺汇总卡').toContain('dim-jh-ledgerCard')
    expect(texts, '汇总树里没有这个 provider').toContain('codearts')
    // 明细表（表头 + 一行数据）
    expect(tokens, '缺明细表').toContain('dim-jh-ledgerTable')
    expect(texts, '明细表里没有模型名').toContain('deepseek-v4.1-flash')
  })

  it('两种外壳取的是**同一份数据**（同一个 rpcCall、同样三个端点）', async () => {
    const seen = []
    const rpc = (endpoint) => {
      seen.push(endpoint)
      return makeRpc()(endpoint)
    }
    await render({ rpcCall: rpc, chrome: 'pane' })
    expect(seen, 'pane 没有读账本').toContain('usage.tokenLedger')
    expect(seen, 'pane 没有读历史').toContain('usage.tokenLedgerHistory')
  })

  /**
   * ⚠️ 原来这条只写 `expect(tree).toBeTruthy()` —— 恒真（树永远是对象），
   * 删掉 `load()` 的 catch、甚至让它抛穿，都照样绿（2026-11-12 审计 P2-6）。
   * 真正的契约是：**没有 rpcCall 时不白屏**，给用户一句可读的失败与一个重试入口。
   */
  it('★ rpcCall 缺失时渲染失败提示 + 重试（不抛、也不留一片空白）', async () => {
    const tree = await render({ chrome: 'pane' })
    const alerts = findAll(tree, (node) => node.props?.role === 'alert')
    expect(alerts, '没有 rpcCall 时既没内容也没提示 —— 用户看到一片空白').toHaveLength(1)
    expect(
      textsOf(tree).join(' '),
      '失败提示里没有异常原文（用户/我们都没法定位）',
    ).toContain('rpcCall is not a function')
    expect(textsOf(tree), '失败提示里没有重试入口').toContain('重试')
  })
})

/**
 * 样式表侧的三条接缝。
 *
 * ⚠️⚠️ 2026-11-12 审计 P2-5：本 PR 新增的 `.dim-jh-ledgerPane*` 整块 CSS
 * **零守卫** —— 删掉 `.dim-jh-ledgerPane` 规则里 269 个字符（含
 * `container-type: inline-size`）之后 107 条相关用例全绿，而浏览器里
 * `@container` 整块**静默失效**（不报错，只是永不匹配 ⇒ 窄面板下明细表横向溢出）。
 *
 * 判据全部在**剥掉注释**的文本上做：本仓库已登记过「把声明包进 CSS 注释仍命中」
 * 的假绿（`credit-row-narrow-layout.spec.ts` 文件头 ②）。
 */
describe('样式表：pane 外壳的 CSS 接缝', () => {
  const styles = readFileSync(new URL('../../plugin-src/client/jet-hub-styles.js', import.meta.url), 'utf8')
  /** 剥掉 `/* … *\/` 注释后的样式文本（所有「某条声明在不在」都在它上面判）。 */
  const bare = styles.replace(/\/\*[\s\S]*?\*\//g, '')

  /**
   * 取一条**精确选择器**的规则体（选择器 + 空格 + `{` 后到第一个 `}`）。
   *
   * ⚠️ 只取第一条匹配 ⇒ 拿到的是**基础**规则，不是 `@container` 里的覆盖规则。
   * 需要覆盖规则时用 `blockOf` 先切范围。
   */
  function ruleOf(selector: string): string {
    const at = bare.indexOf(`${selector} {`)
    if (at < 0) return ''
    const open = bare.indexOf('{', at)
    const close = bare.indexOf('}', open)
    return bare.slice(open + 1, close)
  }

  it('★★ 根容器是容器查询锚点（丢了 container-type ⇒ 720px 覆盖整块静默失效）', () => {
    const rule = ruleOf('.dim-jh-ledgerPane')
    expect(rule, '找不到 .dim-jh-ledgerPane 规则 —— 标签页外壳没有样式').not.toBe('')
    expect(
      rule,
      '缺 container-type: inline-size —— 下面的 @container 永远不会匹配（浏览器不报错）',
    ).toContain('container-type: inline-size')
    // 面板在标签页里已被宿主框住，自己不能再抢视口
    expect(rule, 'pane 根容器带 position: fixed —— 会盖住整个应用').not.toContain('position: fixed')
  })

  it('★★ 内容区自己滚（复用 modalBody 会让 8 列定宽横向溢出）', () => {
    const rule = ruleOf('.dim-jh-ledgerPaneBody')
    expect(rule, '找不到 .dim-jh-ledgerPaneBody 规则').not.toBe('')
    expect(rule, '缺纵向滚动 —— 长账本会把面板撑高').toContain('overflow-y: auto')
    expect(rule, '缺横向裁剪 —— 8 列定宽会撑破面板').toContain('overflow-x: hidden')
    expect(rule, 'pane 内容区不该用弹窗的滚动类').not.toContain('dim-jh-modalBody')
  })

  it('★ 窄面板（@container max-width: 720px）里有明细表降级', () => {
    const at = bare.indexOf('@container (max-width: 720px)')
    expect(at, '找不到 @container (max-width: 720px) 块').toBeGreaterThanOrEqual(0)
    const block = bare.slice(at, bare.indexOf('@media', at))
    expect(
      block,
      '@container 块里没有 .dim-jh-ledgerPaneBody .dim-jh-ledgerTable 的字号降级 —— 窄面板下明细表会溢出',
    ).toContain('.dim-jh-ledgerPaneBody .dim-jh-ledgerTable')
    // ⚠️ 两条不同选择器各判一次：只判一条时「删掉其中一条腿」仍是绿的
    //    （2026-11-12 变异实测：删 ledgerTable 的两条规则后，只判 table 的
    //    断言仍被 `…Table td` 那条命中 ⇒ 无牙）。热力图那条是另一个独立目标。
    expect(
      block,
      '@container 块里没有 .dim-jh-ledgerHeatmapWrap 的横向滚动降级 —— 热力图会撑破面板',
    ).toContain('.dim-jh-ledgerPaneBody .dim-jh-ledgerHeatmapWrap')
  })
})
