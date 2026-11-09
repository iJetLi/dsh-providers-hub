/**
 * 腾讯 Marvis 的客户端登录弹窗（`marvis-login-modal.js`）+ 接线（`jet-hub.js`）。
 *
 * ## 为什么两半都要测
 *
 * ① **弹窗本体**用最小 React 替身**真渲染**：本仓记录过「TS 过了但运行时取不到值」
 *    的 TDZ 事故（`jet-hub-tdz.spec.ts`），纯源码文本断言抓不到组件真的渲染不出来。
 *    这里断言的是**行为**：点哪个按钮只调哪个回调、`busy` 时全禁用、
 *    「从 magpie 导入」不带任何参数（文件由宿主读）、错误文案留在弹窗内。
 *
 * ② **接线**只能锁源码（单测环境没有真 React，`jet-hub.js` 根本 import 不了）：
 *    - `createAccount` 里那条 `if (provider === 'marvis')` 必须是**独立一条**，
 *      且排在 opencode 分支**之前**（合并成 `||` 时后一家会静默不设防）；
 *    - 两个提交函数必须真的打 `account.create`，且 `mode` / `loginType` 字段名
 *      与宿主 `jet-hub-rpc.ts` 里读的**逐字一致**（拼错不会报错，只会回
 *      `unknown provider` 或建出一个 QQ 号却说是微信登录）；
 *    - 渲染分派必须把 `MarvisLoginModal` 挂上（漏了 = 弹窗永远空白）。
 *
 * ⚠️ 源码断言一律对**剥掉注释**的文本做：本文件头就会提到这些判据，
 *    不剥注释的话，注释本身就能把断言喂绿。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 本次渲染的 state 槽位（按 `useState` 调用序号分区，避免多 state 串号）。 */
let stateSlots: unknown[] = []
let stateCursor = 0
/** 上一次渲染的根节点。 */
let lastTree: unknown

interface RenderedNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

const reactStub = {
  useState (initial: unknown) {
    const index = stateCursor
    stateCursor += 1
    if (!(index in stateSlots)) stateSlots[index] = initial
    const read = () => stateSlots[index]
    const write = (next: unknown) => {
      stateSlots[index] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(read()) : next
    }
    return [read(), write]
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useLayoutEffect: () => {},
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => {
    const node = { type, props: (props ?? {}) as Record<string, unknown>, children }
    lastTree = node
    return node
  },
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
}

vi.mock('react', () => ({ default: reactStub, ...reactStub }))

const { MarvisLoginModal } = await import('../../plugin-src/client/marvis-login-modal.js')

function asNode (value: unknown): RenderedNode | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const node = value as RenderedNode
  return Array.isArray(node.children) ? node : undefined
}

function textOf (value: unknown): string {
  if (typeof value === 'string') return value
  const node = asNode(value)
  if (node === undefined) return ''
  return node.children.map((child) => textOf(child)).join('')
}

function walk (value: unknown, visit: (node: RenderedNode) => void): void {
  const node = asNode(value)
  if (node === undefined) return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

function findByText (tree: unknown, text: string): RenderedNode | undefined {
  let found: RenderedNode | undefined
  walk(tree, (node) => {
    if (found !== undefined) return
    if (node.type === 'button' && textOf(node).trim() === text) found = node
  })
  return found
}

function render (props: Record<string, unknown>): unknown {
  stateCursor = 0
  lastTree = undefined
  const tree = (MarvisLoginModal as (p: Record<string, unknown>) => unknown)(props)
  return tree ?? lastTree
}

describe('MarvisLoginModal（真渲染）', () => {
  beforeEach(() => {
    stateSlots = []
    stateCursor = 0
    lastTree = undefined
  })

  it('渲染中文标题、两条 OAuth 按钮与「从 magpie 导入」「取消」', () => {
    const tree = render({})
    expect(textOf(tree)).toContain('登录腾讯 Marvis')
    expect(findByText(tree, 'QQ 登录')).toBeDefined()
    expect(findByText(tree, '微信登录')).toBeDefined()
    expect(findByText(tree, '从 magpie 导入')).toBeDefined()
    expect(findByText(tree, '取消')).toBeDefined()
    // ⚠️ 2026-11-09 用户报障：这一格原先是「textarea + 手动粘贴」，现在**不许**
    //    再有输入框 —— 文件读取在宿主侧（`MarvisAuth.readMagpieCredential`）。
    let hasTextarea = false
    walk(tree, (node) => { if (node.type === 'textarea') hasTextarea = true })
    expect(hasTextarea).toBe(false)
  })

  it('QQ / 微信 / 取消各自只调自己那个回调（不串台）', () => {
    const onQq = vi.fn()
    const onWechat = vi.fn()
    const onClose = vi.fn()
    const onImport = vi.fn()
    const tree = render({ onQq, onWechat, onClose, onImport })
    ;(findByText(tree, 'QQ 登录')!.props.onClick as () => void)()
    expect(onQq).toHaveBeenCalledTimes(1)
    expect(onWechat).not.toHaveBeenCalled()
    ;(findByText(tree, '微信登录')!.props.onClick as () => void)()
    expect(onWechat).toHaveBeenCalledTimes(1)
    expect(onQq).toHaveBeenCalledTimes(1)
    ;(findByText(tree, '取消')!.props.onClick as () => void)()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onImport).not.toHaveBeenCalled()
  })

  it('★★ 「从 magpie 导入」**不带任何参数**（文件由宿主读，不让用户粘贴）', () => {
    const onImport = vi.fn()
    const tree = render({ onImport })
    const button = findByText(tree, '从 magpie 导入')!
    // 没有输入框 ⇒ 不存在「内容为空所以禁用」这一格：按钮只需要 `busy` 闸门。
    expect(button.props.disabled).toBe(false)
    ;(button.props.onClick as () => void)()
    // ⚠️ 必须**零参数**：传 `undefined` 也不算（宿主用 `trim() !== ''` 判「有没有
    //    给内容」，传空串会让它把「用户没填」误报成「粘贴内容解析失败」）。
    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onImport.mock.calls[0]).toHaveLength(0)
  })

  it('★ busy 时四个入口全部禁用，且 QQ 按钮文案变成「处理中…」', () => {
    const tree = render({ busy: true, onQq: vi.fn(), onWechat: vi.fn(), onImport: vi.fn(), onClose: vi.fn() })
    expect(findByText(tree, '处理中…')!.props.disabled).toBe(true)
    expect(findByText(tree, '微信登录')!.props.disabled).toBe(true)
    expect(findByText(tree, '从 magpie 导入')!.props.disabled).toBe(true)
    expect(findByText(tree, '取消')!.props.disabled).toBe(true)
  })

  it('错误文案渲染在弹窗内（role=alert），不把整页切成错误态', () => {
    const tree = render({ error: '授权码已失效，请重新点击新建账号' })
    let alert: RenderedNode | undefined
    walk(tree, (node) => {
      if (node.props.role === 'alert') alert = node
    })
    expect(alert).toBeDefined()
    expect(textOf(alert)).toContain('授权码已失效')
  })
})

// ---------------------------------------------------------------------------
// 接线（**行为级**，不在这里）
// ---------------------------------------------------------------------------

/**
 * ⚠️ 2026-11-10 集成审计 Important 1：本文件原先有 4 条「源码文本」接线断言
 * （`indexOf` / `toContain` / `toMatch`）。审计实测把它们对应的实现整段包进
 * `if (false) { … }`、给渲染分派加 `false &&`、再掏空 `createAccount` 的早退
 * 分支体 —— **4 条里 3 条照绿**，而 CI 全绿的那份代码点「QQ 登录」零请求。
 *
 * ⇒ 接线判据已搬到 `tests/unit/jet-hub-panel-wiring.spec.ts` 的
 * 「腾讯 Marvis 登录接线（行为级）」：真渲染 `ProviderPanel`、真点「新建账号」、
 * 拿渲染出来的弹窗元素、**真调它的回调**，断言打出去的 `account.create` 载荷。
 * 那里才是唯一有牙的写法（本仓库 2026-10-22 白屏事故的教训）。
 */
