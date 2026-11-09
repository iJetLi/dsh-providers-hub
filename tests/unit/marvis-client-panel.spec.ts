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
// 接线（源码级）
// ---------------------------------------------------------------------------

const jetHubSource = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')

function stripComments (source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const jetHubCode = stripComments(jetHubSource)

describe('jet-hub.js 的 Marvis 接线（源码级）', () => {
  it('★★ `createAccount` 里是**独立**一条 if，且排在 opencode 之前', () => {
    const marvisIf = jetHubCode.indexOf("if (provider === 'marvis')")
    const opencodeIf = jetHubCode.indexOf("if (provider === 'opencode')")
    expect(marvisIf).toBeGreaterThanOrEqual(0)
    expect(opencodeIf).toBeGreaterThanOrEqual(0)
    expect(marvisIf).toBeLessThan(opencodeIf)
    // 合并成 `|| provider === 'marvis'` 是这条守卫要防的形态：
    // 那种写法下 opencode 的 key 弹窗分支会把 marvis 一起吞掉。
    expect(jetHubCode).not.toMatch(/provider === 'opencode' \|\| provider === 'marvis'/)
    expect(jetHubCode).not.toMatch(/provider === 'marvis' \|\| provider === 'opencode'/)
    // 而且必须是「开弹窗 + return」，不是落进通用路径。
    expect(jetHubCode).toMatch(/if \(provider === 'marvis'\) \{\s*setCredentialModal\(\{ provider, error: '' \}\);\s*return;/)
  })

  it('★ 登录提交真的打 `account.create`，字段名与宿主逐字一致', () => {
    expect(jetHubCode).toContain("rpcCall('account.create'")
    expect(jetHubCode).toMatch(/provider: 'marvis',\s*mode: 'browser',\s*marvisLoginType: loginType,/)
    // ⚠️ 2026-11-09 用户报障：导入分支**不许**再带 `magpieCredential` ——
    //    带了就要用户自己找文件、复制 JSON；文件由宿主的 `readMagpieCredential()` 读。
    expect(jetHubCode).toMatch(/provider: 'marvis',\s*mode: 'magpie-import',/)
    expect(jetHubCode).not.toContain('magpieCredential: text')
    // 回调也必须是零参数（`onImport: (text) => …` 会把用户粘贴的文本再带回来）。
    expect(jetHubCode).toContain('onImport: () => void submitMarvisMagpieImport()')
    // 登录成功后必须起轮询（宿主返回空 loginUrl，走不了 window.open 那条腿）。
    expect(jetHubCode).toMatch(/startLoginPoll\(\{ accountId, provider: 'marvis' \}\)/)
  })

  it('★ 两个按钮分别传上游码值 `1` / `2`（不是 QC / WX）', () => {
    expect(jetHubCode).toContain("onQq: () => void submitMarvisLogin('1')")
    expect(jetHubCode).toContain("onWechat: () => void submitMarvisLogin('2')")
  })

  it('★ 弹窗必须被渲染挂上（漏了 = 点「新建账号」后什么都不发生）', () => {
    expect(jetHubCode).toMatch(
      /credentialModal && credentialModal\.provider === 'marvis' \? React\.createElement\(MarvisLoginModal,/,
    )
    expect(jetHubCode).toContain("import { MarvisLoginModal } from './marvis-login-modal.js';")
  })
})
