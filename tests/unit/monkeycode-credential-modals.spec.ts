/**
 * 凭据弹窗的**编辑态语义**守卫（`MonkeycodeKeyModal` / `BaizhiKeyModal`）。
 *
 * ## 为什么需要（2026-11-02 二审 D 报告 🟡2 / 🟡3 / 🟡4）
 *
 * 两个弹窗此前**没有任何测试 import**，于是下面三件事改坏了也不会红：
 *
 * ① **编辑态判据**：原来是 `typeof currentMasked === 'string' && currentMasked !== ''`。
 *    但宿主对空 mask 是**省略字段**下发（`maskMonkeycodeKey` 在小于 12 位时返回空串、
 *    `maskBaizhiKey` 正则不过返回空串），于是「`accountId` 有值但 mask 为空」是
 *    合法状态 —— 弹窗会显示「添加 / 确定」而提交却按 `accountId` 走 `setApiKey`。
 *    现在判据由父组件的 `accountId` 派生、经 `editing` prop 传入。
 *
 * ② **只补会话 cookie**：卡片 tooltip 在 `monkeycodeHasSession === false` 时建议
 *    「补一次登录态」，而原先 `apiKey === '' ⇒ return` 让那条路在 UI 上根本走不通。
 *    现在编辑模式下允许 API Key 留空、只填 cookie（父组件走 `setSession`）。
 *
 * ③ **`signing_secret` 必填**：placeholder 与提示语都写着必填，但两端都不校验
 *    ⇒ 用户能建出一个每次推理都 403 `invalid ohmyagent request` 的账号。
 *    现在**新建**模式本地拦住，编辑模式仍可留空（宿主 `?? previous` 沿用旧值）。
 *
 * ⚠️ 用替身 React **真正调用**组件（本仓 2026-10-27 有过 TS 过了但运行时取不到值的
 *    TDZ 事故）；替身的 `createElement` 会把 `ref.current` 指到一个可写节点，
 *    这样才能像用户那样往三个 input 里填值。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 记录组件内 `useState` 的最新值，供「提交被拦住后重新渲染」时读到内联错误。
 *
 * ⚠️ **单槽位**（三审 E🟢-11）：它只认 `inlineError` 这一个 state。将来弹窗里再加
 * 第二个 `useState`（例如「显示/隐藏密码」），两个 state 会写进同一个槽位、互相串号。
 * 届时要改成按初始化值或调用序号分区的 Map。
 */
const stateBox: { inlineError: string } = { inlineError: '' }

/** 本次渲染创建出来的 input 节点（按出现顺序：apiKey / signing_secret / session cookie）。 */
let inputs: Array<{ node: { value: string }, props: Record<string, unknown> }> = []
/** 上一次渲染的整棵树，用于取按钮与标题文本。 */
let lastTree: unknown

const reactStub = {
  useState: (initial: unknown) => [
    stateBox.inlineError === '' ? initial : stateBox.inlineError,
    (next: unknown) => { stateBox.inlineError = String(next) },
  ],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useLayoutEffect: () => {},
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => {
    const node = { type, props: props ?? {}, children }
    if (type === 'input') {
      const ref = (props as { ref?: { current: unknown } } | undefined)?.ref
      const writable = { value: '' }
      if (ref !== undefined) ref.current = writable
      inputs.push({ node: writable, props: (props ?? {}) as Record<string, unknown> })
    }
    lastTree = node
    return node
  },
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
}

vi.mock('react', () => reactStub)

const { MonkeycodeKeyModal } = await import('../../plugin-src/client/monkeycode-key-modal.js')
const { BaizhiKeyModal } = await import('../../plugin-src/client/baizhi-key-modal.js')

interface RenderedNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

function asNode(value: unknown): RenderedNode | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const node = value as RenderedNode
  return Array.isArray(node.children) ? node : undefined
}

/** 递归收集一段文本（供标题/提示断言）。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  const node = asNode(value)
  if (node === undefined) return ''
  return node.children.map((child) => textOf(child)).join('')
}

/** 在一棵树里找第一个满足判据的节点。 */
function findNode(value: unknown, pick: (node: RenderedNode) => boolean): RenderedNode | undefined {
  const node = asNode(value)
  if (node === undefined) return undefined
  if (pick(node)) return node
  for (const child of node.children) {
    const hit = findNode(child, pick)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 点「确定 / 添加 / 更新」那颗主按钮。 */
function clickPrimary(): void {
  const button = findNode(
    lastTree,
    (node) => node.type === 'button' && node.props.className === 'dim-jh-btn dim-jh-btnPrimary',
  )
  expect(button, '弹窗里必须有一颗主按钮').toBeDefined()
  const onClick = button?.props.onClick as (() => void) | undefined
  expect(onClick, '主按钮必须挂 onClick').toBeDefined()
  onClick?.()
}

function reset(): void {
  stateBox.inlineError = ''
  inputs = []
  lastTree = undefined
}

/** 往第 index 个 input 里填值（0=apiKey / 1=signing_secret / 2=session cookie）。 */
function fill(index: number, value: string): void {
  const target = inputs[index]
  expect(target, `第 ${index} 个 input 不存在（本弹窗只有 ${inputs.length} 个）`).toBeDefined()
  target.node.value = value
}

function renderMonkeycode(props: Record<string, unknown> = {}): {
  onSubmit: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const onSubmit = vi.fn()
  const onClose = vi.fn()
  const apiKeyRef = { current: null as null | { value: string } }
  MonkeycodeKeyModal({
    provider: 'monkeycode',
    error: '',
    busy: false,
    inputRef: apiKeyRef,
    onSubmit,
    onClose,
    ...props,
  } as never)
  /**
   * ⚠️⚠️ 这里**不许**再写 `apiKeyRef.current = inputs[0].node` 兜底（三审 E🟡-3）。
   *
   * 替身的 `createElement` 只在**组件真的把 `ref` 传给了某颗 input** 时才写 `ref.current`
   * （见上面 `if (ref !== undefined) ref.current = writable`）。加了这行兜底之后，
   * 无论组件漏传 `ref`、还是把 `ref: secretRef` 传给了 API Key，`apiKeyRef.current`
   * 都会被强行指向第 0 颗 input ⇒ 四条用例输出**逐字节相同**（E 实测）。
   * 真机上那等于「API Key 永远读不到 ⇒ 点确定静默关窗」，而测试全绿。
   * ⇒ 改成硬断言：父组件传进来的 `inputRef` 必须被组件挂到某颗 input 上。
   */
  expect(apiKeyRef.current, '组件必须把 `inputRef` 挂到 API Key 那颗 input 上').not.toBeNull()
  return { onSubmit, onClose }
}

describe('MonkeycodeKeyModal · 新建模式', () => {
  beforeEach(reset)

  it('★★ 填了 API Key 但没填 signing_secret ⇒ 本地拦住，不发 onSubmit', () => {
    const { onSubmit, onClose } = renderMonkeycode()
    fill(0, 'oma_aaaaaaaaaaaaaaaaaaaaaaaa')
    clickPrimary()
    expect(onSubmit, '缺 signing_secret 建出来的账号每次推理都会 403').not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // 重新渲染一次：内联错误由替身 state 带出，必须出现在 DOM 里。
    renderMonkeycode()
    expect(textOf(lastTree)).toContain('signing_secret 必填')
  })

  it('★ 三个字段齐全 ⇒ 原样交给 onSubmit', () => {
    const { onSubmit } = renderMonkeycode()
    fill(0, 'oma_aaaaaaaaaaaaaaaaaaaaaaaa')
    fill(1, 'old-secret-0123456789')
    fill(2, 'monkeycode_ai_session=abc')
    clickPrimary()
    expect(onSubmit).toHaveBeenCalledWith({
      apiKey: 'oma_aaaaaaaaaaaaaaaaaaaaaaaa',
      signingSecret: 'old-secret-0123456789',
      sessionCookie: 'monkeycode_ai_session=abc',
    })
  })

  it('新建模式下什么都不填就点确定 ⇒ 静默关窗（不报错的既有语义要保住）', () => {
    const { onSubmit, onClose } = renderMonkeycode()
    clickPrimary()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

describe('MonkeycodeKeyModal · 编辑模式', () => {
  beforeEach(reset)

  it('★★ editing 由 prop 决定，不靠 mask（mask 为空也必须显示「更新」）', () => {
    renderMonkeycode({ editing: true, currentMasked: '' })
    const text = textOf(lastTree)
    expect(text).toContain('更新 MonkeyCode 账号')
    expect(text, 'mask 为空时要给「未记录打码值」的兜底，不能拼出「当前 Key：」后面空白')
      .toContain('未记录打码值')
  })

  it('★★ 只填 session cookie（API Key 留空）⇒ 仍然提交，交给父组件走 setSession', () => {
    const { onSubmit, onClose } = renderMonkeycode({ editing: true, currentMasked: 'oma_…abcd' })
    fill(2, 'monkeycode_ai_session=abc')
    clickPrimary()
    expect(onClose).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledWith({
      apiKey: '',
      signingSecret: '',
      sessionCookie: 'monkeycode_ai_session=abc',
    })
  })

  it('编辑模式下 signing_secret 可以留空（宿主会沿用旧值）', () => {
    const { onSubmit } = renderMonkeycode({ editing: true, currentMasked: 'oma_…abcd' })
    fill(0, 'oma_bbbbbbbbbbbbbbbbbbbbbbbb')
    clickPrimary()
    expect(onSubmit).toHaveBeenCalledWith({
      apiKey: 'oma_bbbbbbbbbbbbbbbbbbbbbbbb',
      signingSecret: '',
      sessionCookie: '',
    })
  })

  it('编辑模式下什么都不填 ⇒ 关窗（不能发一个空 payload 出去）', () => {
    const { onSubmit, onClose } = renderMonkeycode({ editing: true, currentMasked: 'oma_…abcd' })
    clickPrimary()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

describe('BaizhiKeyModal · 编辑态', () => {
  beforeEach(reset)

  it('★ editing 由 prop 决定（mask 为空也算编辑）', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    BaizhiKeyModal({
      error: '',
      busy: false,
      inputRef: { current: null },
      onSubmit,
      onClose,
      editing: true,
      currentMasked: '',
    } as never)
    const text = textOf(lastTree)
    expect(text).toContain('更新')
  })
})

describe('MonkeycodeKeyModal · 输入即清错与回车提交（三审 E 🟡-6 / 🟢-13）', () => {
  beforeEach(reset)

  it('★★ 三颗 input 都必须挂 onChange，且一输入内联错误就消失', () => {
    renderMonkeycode()
    fill(0, 'oma_aaaaaaaaaaaaaaaaaaaaaaaa')
    clickPrimary()
    // 缺 signing_secret ⇒ 内联错误出现。
    renderMonkeycode()
    expect(textOf(lastTree)).toContain('signing_secret 必填')

    /**
     * ⚠️ 只断言「错误文本出现过」是**无牙**的：把三处 `onChange: clearInlineError`
     * 全删掉，用例照样绿 —— 用户看到的是「我明明在改，红字却一直挂着」。
     */
    // 本用例渲染了两次（第一次触发内联错误、第二次带错误重渲染）⇒ 取最后一轮的 3 颗。
    const current = inputs.slice(-3)
    expect(current.length).toBe(3)
    for (const [index, input] of current.entries()) {
      expect(typeof input.props.onChange, `第 ${index} 颗 input 缺 onChange`).toBe('function')
    }
    ;(current[1].props.onChange as () => void)()
    expect(stateBox.inlineError, '输入后内联错误必须被清空').toBe('')
  })

  it('★★ 三颗 input 都必须能回车提交（粘完 Key 回车是最自然的动作）', () => {
    renderMonkeycode()
    /**
     * ⚠️ 每次 render 都会新建一组 spy **和一组 ref 对象**（替身 `useRef` 每次返回
     * `{ current: initial }`），而 handlers 是**该次渲染**的闭包 ⇒ 值必须填进
     * **最后一轮**的节点、断言也必须用最后一轮返回的 `onSubmit`。否则 submit()
     * 读到的是空 ref（⇒ 校验拦住、零提交），看起来像「回车没接上」。
     */
    const { onSubmit } = renderMonkeycode()
    const current = inputs.slice(-3)
    for (const [index, input] of current.entries()) {
      expect(typeof input.props.onKeyDown, `第 ${index} 颗 input 缺 onKeyDown`).toBe('function')
    }
    current[0].node.value = 'oma_aaaaaaaaaaaaaaaaaaaaaaaa'
    current[1].node.value = 'b'.repeat(48)
    const event = { key: 'Enter', preventDefault: vi.fn() }
    ;(current[2].props.onKeyDown as (e: unknown) => void)(event)
    expect(event.preventDefault, '回车必须 preventDefault（否则会触发表单默认行为）').toHaveBeenCalled()
    expect(onSubmit, '三颗字段齐全 + 回车 ⇒ 应当提交').toHaveBeenCalledTimes(1)
  })
})

describe('BaizhiKeyModal · 空 mask 与可访问名（三审 E 🟡-8 / 🟢-12）', () => {
  beforeEach(reset)

  it('★ 编辑态但 mask 为空 ⇒ 兜底成「未记录打码值」，不能拼出「当前 Key：。」', () => {
    BaizhiKeyModal({
      provider: 'baizhi',
      error: '',
      busy: false,
      editing: true,
      currentMasked: '',
      onSubmit: vi.fn(),
      onClose: vi.fn(),
    } as never)
    const text = textOf(lastTree)
    expect(text).toContain('未记录打码值')
    expect(text).not.toContain('当前 Key：。')
  })

  it('★ 弹窗必须有 aria-label（role=dialog 没有可访问名等于没标）', () => {
    BaizhiKeyModal({
      provider: 'baizhi',
      error: '',
      busy: false,
      editing: false,
      currentMasked: '',
      onSubmit: vi.fn(),
      onClose: vi.fn(),
    } as never)
    const dialog = findNode(lastTree, (node) => node.props.role === 'dialog')
    expect(dialog, '必须渲染 role=dialog 的外层').toBeDefined()
    expect(String(dialog?.props['aria-label'] ?? '')).toContain('百智云')
  })
})
