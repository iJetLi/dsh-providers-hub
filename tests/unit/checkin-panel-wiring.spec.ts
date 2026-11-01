/**
 * 定时签到面板的**接线层**守卫（真实组件 + 忠实 effect 语义）。
 *
 * ## 为什么必须单独有这一个文件
 *
 * 2026-11-01 两路独立审计各自实测打穿同一个真缺陷：
 *
 * > 打开面板 → 改执行时刻 → **点面板外面**关闭 ⇒ 改动**静默丢失**，无任何提示；
 * > 而同一份草稿用 ▾ 关闭却能存。
 *
 * 根因在**接线层**：`document` 的 `mousedown` 监听注册在
 * `React.useEffect(..., [showCheckinPanel])` 里，闭包停在「打开那一刻」；
 * 首次打开时 `autoCheckin` 还是 `null` ⇒ 提交判据走「读不到宿主就不提交」
 * 分支。创建一个 `useRef` 保存宿主状态即可修好 —— 但这是**接线**，不是纯逻辑。
 *
 * `auto-checkin-panel.spec.ts` 全部 18 条都打在纯函数
 * （`checkinCommitPlan` / `isInsideCheckinDock` / `formatNextRunAt`）上，
 * **两个 spec 都根本不 import `jet-hub.js`** ⇒ 把修法整条删掉也是 86/86 全绿。
 * 本文件补的就是这一层。
 *
 * ## 为什么不能复用 `jet-hub-panel-wiring.spec.ts` 的 react 替身
 *
 * 那个替身把 `useEffect` 写成**空函数** —— 任何「effect 闭包捕获旧 state」类的
 * 缺陷在它下面都不可能被发现。这里的替身按 React 18 的最小语义实现：
 * hooks 按调用序槽位化、`useEffect(fn, deps)` 与**上一次提交的 deps** 逐项比较，
 * 变了才重跑。于是「闭包停在注册那一拍」这件事被如实还原。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** hooks 槽位（跨渲染保留，顺序即调用顺序）。 */
let slots: Array<{ v?: unknown; cur?: unknown }> = []
let cursor = 0
/** 每个 effect 槽位上一次提交的 deps。 */
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
    if (!('cur' in s)) s.cur = initial
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
    // React 在提交阶段（渲染之后）执行 effect
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
const flush = async (n = 6): Promise<void> => { for (let i = 0; i < n; i += 1) await tick() }

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

function find(pred: (node: AnyNode) => boolean): AnyNode | undefined {
  let hit: AnyNode | undefined
  walk([root], (node) => { if (hit === undefined && pred(node)) hit = node })
  return hit
}
function findAll(pred: (node: AnyNode) => boolean): AnyNode[] {
  const out: AnyNode[] = []
  walk([root], (node) => { if (pred(node)) out.push(node) })
  return out
}

let page: ((props: unknown) => unknown) | undefined

/** 渲染一次（保留 hooks，重置游标与树）。 */
async function render(props: { rpcCall: (method: string, payload?: unknown) => Promise<unknown> }): Promise<void> {
  cursor = 0
  pendingEffects = []
  root = page!(props)
  await flush(3)
  // effect 里可能 setState ⇒ 再渲染几拍（与真实 React 的提交-再渲染一致）
  let guard = 0
  while (pendingEffects.length > 0 && guard < 3) {
    pendingEffects = []
    cursor = 0
    root = page!(props)
    await flush(3)
    guard += 1
  }
}

/** 装一个最小的 `document`：本仓库单测跑在 `environment: 'node'`，没有 DOM。 */
function installDocument(): { listeners: Array<{ type: string; fn: (event: unknown) => void }> } {
  const listeners: Array<{ type: string; fn: (event: unknown) => void }> = []
  ;(globalThis as Record<string, unknown>).document = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners.push({ type, fn }) },
    removeEventListener: () => {},
  }
  ;(globalThis as Record<string, unknown>).Node = class Node {}
  return { listeners }
}

const HOST_STATE = {
  enabled: true,
  times: ['09:00', '21:00'],
  jitterMinutes: 0,
  lastSlot: '2026-11-01#21:00',
  lastDate: '2026-11-01',
  pendingSlot: '',
  ranToday: false,
  nextRunAt: Date.now() + 3_600_000,
  running: false,
  lastResult: '',
  lastAt: 0,
  channels: [],
  dismissed: false,
}

/** 装配 rpcCall 桩：`usage.autoCheckin` 返回宿主状态，其余给最小空壳。 */
function makeRpc(): { calls: Array<{ method: string; payload: unknown }>; rpcCall: (m: string, p?: unknown) => Promise<unknown> } {
  const calls: Array<{ method: string; payload: unknown }> = []
  const rpcCall = async (method: string, payload?: unknown): Promise<unknown> => {
    calls.push({ method, payload })
    if (method === 'usage.autoCheckin') {
      if (payload !== undefined && typeof payload === 'object' && payload !== null && 'times' in payload) {
        return { autoCheckin: { ...HOST_STATE, times: (payload as { times?: string[] }).times ?? HOST_STATE.times } }
      }
      return { autoCheckin: HOST_STATE }
    }
    return {}
  }
  return { calls, rpcCall }
}

/** 本用例只关心「有没有把 times 写回宿主」。 */
function timeWrites(calls: Array<{ method: string; payload: unknown }>): Array<Record<string, unknown>> {
  return calls
    .filter((call) => call.method === 'usage.autoCheckin')
    .map((call) => call.payload as Record<string, unknown> | undefined)
    .filter((payload): payload is Record<string, unknown> => payload !== undefined && typeof payload === 'object' && payload !== null && 'times' in payload)
}

/**
 * 打开面板 → 把第一个时刻改成 `nextTime` → 用指定方式关闭。
 *
 * @param closeWith - `'outside'` = 点面板外部（document 的 mousedown）；
 *                    `'caret'` = 再点一次 ▾。
 */
async function editThenClose(
  rpc: { calls: Array<{ method: string; payload: unknown }>; rpcCall: (m: string, p?: unknown) => Promise<unknown> },
  nextTime: string | null,
  closeWith: 'outside' | 'caret',
): Promise<void> {
  const { listeners } = installDocument()
  await render({ rpcCall: rpc.rpcCall })

  const caret = find((node) => node.props?.className === 'dim-jh-btn dim-jh-checkinCaret')
  expect(caret, '▾ 按钮没渲染出来 ⇒ 本文件失效（组件结构已变）').toBeTruthy()
  ;(caret!.props.onClick as () => void)()
  // 事件 → setState → 渲染；`loadAutoCheckin` 的 promise 在这一拍之后才落定
  await render({ rpcCall: rpc.rpcCall })
  await render({ rpcCall: rpc.rpcCall })

  if (nextTime !== null) {
    const input = findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻')
    expect(input.length, '时间输入框没渲染出来 ⇒ 面板没打开').toBe(1)
    ;(input[0]!.props.onChange as (event: unknown) => void)({ target: { value: nextTime } })
    await render({ rpcCall: rpc.rpcCall })
  }

  if (closeWith === 'caret') {
    const again = find((node) => node.props?.className === 'dim-jh-btn dim-jh-checkinCaret')
    ;(again!.props.onClick as () => void)()
  } else {
    const down = listeners.filter((listener) => listener.type === 'mousedown')
    expect(down.length, '没有任何 mousedown 监听注册 ⇒ 点击外部关闭这条路径没接上').toBeGreaterThan(0)
    down[down.length - 1]!.fn({ target: (globalThis as Record<string, unknown>).document })
  }
  await flush(10)
}

describe('定时签到面板：关闭即保存（接线层，行为级）', { timeout: 60_000 }, () => {
  // ⚠️ hooks 槽位是**文件级**的（替身要跨渲染保留），故每个用例必须重置 ——
  //    否则上一个用例的 `showCheckinPanel=true` 会漏到下一个（实测第一个受影响
  //    的用例就是「面板已经在开着的状态」）。
  beforeEach(() => {
    slots = []
    committed = []
    cursor = 0
    pendingEffects = []
    root = undefined
  })
  it('★★ 首次打开 → 改时刻 → **点面板外部**关闭 ⇒ 必须写回宿主（审计 P1-1）', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage
    expect(typeof page).toBe('function')
    const rpc = makeRpc()
    await editThenClose(rpc, '10:00', 'outside')
    const writes = timeWrites(rpc.calls)
    // 判别力：修法（宿主状态也走 ref）被删掉时这里是 0 次 —— 改动静默丢失
    expect(writes.length, '★ 改完时刻点外部关闭后一次都没提交 ⇒ 改动被静默丢弃').toBe(1)
    expect(writes[0]!.times).toEqual(['10:00', '21:00'])
  })

  it('★ 首次打开 → 改时刻 → 用 ▾ 关闭 ⇒ 同样写回（两条关闭路径必须同结果）', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage
    const rpc = makeRpc()
    await editThenClose(rpc, '10:00', 'caret')
    const writes = timeWrites(rpc.calls)
    expect(writes.length).toBe(1)
    expect(writes[0]!.times).toEqual(['10:00', '21:00'])
  })

  it('★ 什么都没改就关闭 ⇒ 一次都不写（不许把「打开看一眼」变成写盘）', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage
    const rpc = makeRpc()
    await editThenClose(rpc, null, 'outside')
    expect(timeWrites(rpc.calls)).toEqual([])
  })

  it('★ 保存失败 ⇒ 面板留着（否则错误文案渲染在已关闭的面板里，用户永远看不到）', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage
    const rpc = makeRpc()
    // 让写回失败一次
    const failing = {
      calls: rpc.calls,
      rpcCall: async (method: string, payload?: unknown) => {
        if (method === 'usage.autoCheckin' && payload !== undefined && typeof payload === 'object' && payload !== null && 'times' in payload) {
          rpc.calls.push({ method, payload })
          throw new Error('bad-request: 时刻必须是 HH:MM')
        }
        return rpc.rpcCall(method, payload)
      },
    }
    await editThenClose(failing, '10:00', 'outside')
    // 失败后仍应重新渲染出面板（showCheckinPanel 保持 true）
    await render({ rpcCall: failing.rpcCall })
    const alert = find((node) => node.props?.role === 'alert'
      && (node.children ?? []).some((child) => typeof child === 'string' && child.includes('HH:MM')))
    expect(alert, '★ 保存失败时必须把面板留着并显示原始错误，否则用户看不到任何提示').toBeTruthy()
  })

  it('★ 保存失败后再关一次 ⇒ 必须能关掉（否则面板死锁，用户没有出口）', async () => {
    // 2026-11-01 第二轮审计 P2-3：修好「失败保住面板」之后，面板会变成**关不掉** ——
    // 每次关闭手势都重试保存、都失败（实测 4 次关闭动作全部重试，可关闭 = false）。
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage
    const { calls, rpcCall } = makeRpc()
    let failWrites = true
    const rpc = {
      calls,
      rpcCall: async (method: string, payload?: unknown) => {
        if (method === 'usage.autoCheckin' && payload !== undefined && typeof payload === 'object' && payload !== null && 'times' in payload) {
          calls.push({ method, payload })
          if (failWrites) throw new Error('bad-request: 时刻必须是 HH:MM')
          return { autoCheckin: { ...HOST_STATE, times: (payload as { times?: string[] }).times } }
        }
        return rpcCall(method, payload)
      },
    }
    const { listeners } = installDocument()
    await render({ rpcCall: rpc.rpcCall })
    ;(find((node) => node.props?.className === 'dim-jh-btn dim-jh-checkinCaret')!.props.onClick as () => void)()
    await render({ rpcCall: rpc.rpcCall })
    await render({ rpcCall: rpc.rpcCall })
    ;(findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻')[0]!.props.onChange as (e: unknown) => void)({ target: { value: '10:00' } })
    await render({ rpcCall: rpc.rpcCall })
    const outside = (): void => {
      const down = listeners.filter((listener) => listener.type === 'mousedown')
      down[down.length - 1]!.fn({ target: (globalThis as Record<string, unknown>).document })
    }
    outside()
    await flush(10)
    await render({ rpcCall: rpc.rpcCall })
    const writesAfterFirst = timeWrites(calls).length
    expect(writesAfterFirst).toBe(1)
    // 第二次关闭手势：必须真的关掉，且**不再**发写请求
    outside()
    await flush(10)
    await render({ rpcCall: rpc.rpcCall })
    expect(timeWrites(calls).length, '第二次关闭又重试了一次保存 ⇒ 面板会永远关不掉').toBe(1)
    expect(findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻').length,
      '★ 第二次关闭手势后 `showCheckinPanel` 仍为 true ⇒ 面板死锁').toBe(0)
  })

  it('★ 保存进行中连点关闭 ⇒ 只发一次请求（不许重复提交）', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage
    const { calls, rpcCall } = makeRpc()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const rpc = {
      calls,
      rpcCall: async (method: string, payload?: unknown) => {
        if (method === 'usage.autoCheckin' && payload !== undefined && typeof payload === 'object' && payload !== null && 'times' in payload) {
          calls.push({ method, payload })
          await gate
          return { autoCheckin: { ...HOST_STATE, times: (payload as { times?: string[] }).times } }
        }
        return rpcCall(method, payload)
      },
    }
    const { listeners } = installDocument()
    await render({ rpcCall: rpc.rpcCall })
    ;(find((node) => node.props?.className === 'dim-jh-btn dim-jh-checkinCaret')!.props.onClick as () => void)()
    await render({ rpcCall: rpc.rpcCall })
    await render({ rpcCall: rpc.rpcCall })
    ;(findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻')[0]!.props.onChange as (e: unknown) => void)({ target: { value: '10:00' } })
    await render({ rpcCall: rpc.rpcCall })
    const outside = (): void => {
      const down = listeners.filter((listener) => listener.type === 'mousedown')
      down[down.length - 1]!.fn({ target: (globalThis as Record<string, unknown>).document })
    }
    outside()
    await flush(3)
    // 第一次写还没回来，再点一次外部
    outside()
    await flush(3)
    expect(timeWrites(calls).length, '★ 慢 RPC 下连点会发出两条相同 payload 的写请求').toBe(1)
    release!()
    await flush(10)
    await render({ rpcCall: rpc.rpcCall })
    expect(findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻').length,
      '保存成功后应当关闭面板').toBe(0)
  })
})
