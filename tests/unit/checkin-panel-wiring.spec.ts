/**
 * 定时签到面板的**接线层**守卫（真实组件 + 忠实 effect 语义）。
 *
 * ## 为什么必须单独有这一个文件
 *
 * 2026-11-01 两路独立审计各自实测打穿同一个真缺陷：
 *
 * > 打开面板 → 改执行时刻 → **点面板外面**关闭 ⇒ 改动**静默丢失**，无任何提示；
 * > 而同一份草稿用「完成」关闭却能存。
 *
 * 根因在**接线层**：`document` 的 `mousedown` 监听注册在
 * `React.useEffect(..., [showSettings])` 里，闭包停在「打开那一刻」；
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

/**
 * 装配 rpcCall 桩：`usage.autoCheckin` 返回宿主状态，其余给最小空壳。
 *
 * @param options.failWrites 写请求（带 `times` 的那条）一律 reject。
 *   用来测「保存失败」路径（出口③ / 出口④ 的 `else` 分支）。
 */
function makeRpc(options: { failWrites?: string; hangWrites?: boolean } = {}): {
  calls: Array<{ method: string; payload: unknown }>
  rpcCall: (m: string, p?: unknown) => Promise<unknown>
} {
  const calls: Array<{ method: string; payload: unknown }> = []
  const rpcCall = async (method: string, payload?: unknown): Promise<unknown> => {
    calls.push({ method, payload })
    if (method === 'usage.autoCheckin') {
      if (payload !== undefined && typeof payload === 'object' && payload !== null && 'times' in payload) {
        // ⚠️ 「写请求永不返回」：模拟宿主 RPC 卡死（服务端阻塞 / 连接半开）。
        //    `rpcCall` 直通 `connection.rpc.call`，那一层没有超时。
        if (options.hangWrites === true) return new Promise<never>(() => {})
        if (options.failWrites !== undefined) throw new Error(options.failWrites)
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
 * 收集一棵子树里所有**文本**（任意深度的字符串）。
 *
 * ⚠️ 不能复用 `walk` —— 它在「`raw` 不是对象」时直接 `continue`，而文字
 * 恰恰是字符串。而 `[node.children].flat(Infinity)` 也不够：button 的
 * children 是 `[图标 svg, 文字 span]` **两个对象**，文字挂在 span 的
 * children 上（四条用例曾因此全报「找不到按钮」）。
 */
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

/** 按标签 + 可见文字找元素。 */
function byText(tag: string, text: string): AnyNode | undefined {
  return findAll((node) => node.type === tag && textsIn([node]).includes(text))[0]
}

/**
 * 在底部操作行里按可见文字找按钮 —— 四个按钮的 className 完全相同
 * （`dim-jh-btn dim-jh-railAction`），只能靠文字区分。
 */
function railAction(label: string): AnyNode {
  const buttons = findAll((node) => node.props?.className === 'dim-jh-btn dim-jh-railAction')
  const hit = buttons.find((button) => textsIn([button]).includes(label))
  expect(hit, `底部操作行里找不到「${label}」按钮 ⇒ 本文件失效（组件结构已变）`).toBeTruthy()
  return hit!
}

/**
 * 打开设置弹窗 → 把第一个时刻改成 `nextTime` → 用指定方式关闭。
 *
 * ⚠️ 2026-11-05 侧边栏重构后，「定时签到」不再是页头下方的下拉卡
 * （`.dim-jh-checkinPanel` + ▾ 按钮 + document 级 mousedown 监听），
 * 而是设置弹窗里的第 ② 个分区：入口 = 侧边栏底部操作行的「设置」按钮，
 * 出口 = 弹窗右上角的「完成」或点遮罩。**这三条路径都必须仍然写回宿主**，
 * 否则「改完时刻点关闭」又会静默丢改动（2026-11-01 审计 P1-1）。
 *
 * @param closeWith - `'outside'` = 点遮罩；`'done'` = 点「完成」。
 */
async function editThenClose(
  rpc: { calls: Array<{ method: string; payload: unknown }>; rpcCall: (m: string, p?: unknown) => Promise<unknown> },
  nextTime: string | null,
  closeWith: 'outside' | 'done',
): Promise<void> {
  installDocument()
  await render({ rpcCall: rpc.rpcCall })

  ;(railAction('设置').props.onClick as () => void)()
  // 事件 → setState → 渲染；`loadAutoCheckin` 的 promise 在这一拍之后才落定
  await render({ rpcCall: rpc.rpcCall })
  await render({ rpcCall: rpc.rpcCall })

  if (nextTime !== null) {
    const input = findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻')
    expect(input.length, '时间输入框没渲染出来 ⇒ 面板没打开').toBe(1)
    ;(input[0]!.props.onChange as (event: unknown) => void)({ target: { value: nextTime } })
    await render({ rpcCall: rpc.rpcCall })
  }

  if (closeWith === 'done') {
    const done = byText('button', '完成')
    expect(done, '「完成」按钮没渲染出来 ⇒ 本文件失效（组件结构已变）').toBeTruthy()
    // ⚠️⚠️ **必须带事件对象调用**（2026-11-06 十一审，审查员 e4e74842 报的 P1-2）。
    //
    // React 真实调用是 `onClick(SyntheticEvent)`。若这里写成零参 `onClick()`，
    // 那么「把 `onClick: () => closeSettings()` 改回去箭头包装」这个回归
    // **不会抛错** —— `closeSettings` 的形参 `onClosed` 会拿到 `undefined`，
    // 而 `onClosed?.()` 对 `undefined` 安全短路。
    //
    // 实测（审查员 A09 变异「完成按钮去箭头包装」）：
    // - 零参调用 ⇒ **12 passed 但 exit=1**（unhandled rejection 被 vitest
    //   记成 `Errors 1 error`，而 `Tests` 行仍是绿的 ⇒ 只看 summary 会误判）；
    // - 带事件调用 ⇒ 抛 `TypeError: onClosed is not a function` @
    //   `plugin-src/client/jet-hub.js`，**测试行直接红**。
    ;(done!.props.onClick as (e: unknown) => void)({ type: 'click' })
  } else {
    const overlay = find((node) => node.props?.className === 'dim-jh-modalOverlay')
    expect(overlay, '设置弹窗的遮罩没渲染出来 ⇒ 本文件失效（组件结构已变）').toBeTruthy()
    ;(overlay!.props.onClick as (event: unknown) => void)({ target: overlay, currentTarget: overlay })
  }
  await flush(10)
}

describe('定时签到面板：关闭即保存（接线层，行为级）', { timeout: 60_000 }, () => {
  // ⚠️ hooks 槽位是**文件级**的（替身要跨渲染保留），故每个用例必须重置 ——
  //    否则上一个用例的 `showSettings=true` 会漏到下一个（实测第一个受影响
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

  it('★ 首次打开 → 改时刻 → 用「完成」关闭 ⇒ 同样写回（两条关闭路径必须同结果）', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage
    const rpc = makeRpc()
    await editThenClose(rpc, '10:00', 'done')
    const writes = timeWrites(rpc.calls)
    expect(writes.length).toBe(1)
    expect(writes[0]!.times).toEqual(['10:00', '21:00'])
  })

  it('★★ 保存成功路径必须 clearTimeout 掉 15 秒兜底定时器', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage
    expect(typeof page).toBe('function')
    // ⚠️ 用 `spyOn` 而不是 `useFakeTimers`：本文件的渲染辅助函数是
    //    microtask 链（`await render(...)`），fake timers 会把整条链挂死
    //    （实测三种 `toFake` 组合都是 300s 超时）。spy 只观察「清定时器」
    //    这个动作，不接管时钟。
    //
    //    判据必须**成对**：`setTimeout` 被调过（兜底真的装了）**且**
    //    `clearTimeout` 也被调过（兜底真的拆了）。只看后者的话，
    //    「根本没装定时器」也会绿 —— 而那就意味着超时兜底失效。
    const setSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    try {
      const rpc = makeRpc()
      await editThenClose(rpc, '10:00', 'outside')
      expect(timeWrites(rpc.calls).length, '保存必须已发生（否则本用例没测到清理路径）').toBe(1)
      // 15 秒的那个兜底
      const installed = setSpy.mock.calls.some(([, delay]) => delay === 15_000)
      expect(installed, '★★ 15 秒兜底定时器必须真的装过（否则本用例无意义）').toBe(true)
      // ⚠️ 判别力：删掉 `clearTimeout(timeoutTimer)` 这一行 ⇒ 本断言变红。
      //
      //    ⚠️⚠️ 而且**必须检查句柄不是 `undefined`**（十二审变异 M2 实测）：
      //    第一版写成 `clearSpy.mock.calls.length > 0`，于是「把
      //    `timeoutTimer = setTimeout(...)` 的赋值删掉、只留
      //    `setTimeout(...)`」这个变异**照样全绿** —— 因为
      //    `clearTimeout(undefined)` 也是一次「调用」，而它是**合法的
      //    no-op**（定时器根本没被清掉，泄漏照旧）。
      const clearedRealHandle = clearSpy.mock.calls.some(([handle]) => handle !== undefined)
      expect(clearedRealHandle, '★★ 保存成功后必须 clearTimeout 掉兜底定时器（传真实句柄，不是 undefined）').toBe(true)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
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
    // 失败后仍应重新渲染出面板（showSettings 保持 true）
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
    installDocument()
    await render({ rpcCall: rpc.rpcCall })
    ;(railAction('设置').props.onClick as () => void)()
    await render({ rpcCall: rpc.rpcCall })
    await render({ rpcCall: rpc.rpcCall })
    ;(findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻')[0]!.props.onChange as (e: unknown) => void)({ target: { value: '10:00' } })
    await render({ rpcCall: rpc.rpcCall })
    const outside = (): void => {
      const overlay = find((node) => node.props?.className === 'dim-jh-modalOverlay')
      expect(overlay, '设置弹窗的遮罩没渲染出来 ⇒ 本文件失效').toBeTruthy()
      ;(overlay!.props.onClick as (event: unknown) => void)({ target: overlay, currentTarget: overlay })
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
      '★ 第二次关闭手势后 `showSettings` 仍为 true ⇒ 面板死锁').toBe(0)
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
    installDocument()
    await render({ rpcCall: rpc.rpcCall })
    ;(railAction('设置').props.onClick as () => void)()
    await render({ rpcCall: rpc.rpcCall })
    await render({ rpcCall: rpc.rpcCall })
    ;(findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻')[0]!.props.onChange as (e: unknown) => void)({ target: { value: '10:00' } })
    await render({ rpcCall: rpc.rpcCall })
    const outside = (): void => {
      const overlay = find((node) => node.props?.className === 'dim-jh-modalOverlay')
      expect(overlay, '设置弹窗的遮罩没渲染出来 ⇒ 本文件失效').toBeTruthy()
      ;(overlay!.props.onClick as (event: unknown) => void)({ target: overlay, currentTarget: overlay })
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

  /**
   * ★★★ 2026-11-06 真回归的**后半条**（`checkinPendingCloseRef` 排队）：
   *
   * 保存进行中（`checkinSavingRef.current === true`）点「网关」/「用量」时，
   * `closeSettings` 走出口② —— **早退、不执行 `onClosed`**。如果把实参直接
   * 丢掉，那一次点击就**被吞了**（用户看到「什么都没发生」，且不会重试）。
   *
   * 正确行为：把回调**存进 `checkinPendingCloseRef`**，等保存结束后无条件
   * 执行（无论成功还是失败 —— 失败时面板留着、但目标弹窗还是要打开，
   * 否则用户会以为按钮坏了）。
   */
  it('★★★ 保存进行中切「网关」⇒ 保存完成后必须真的打开（不得静默无反应）', async () => {
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
    installDocument()
    await render({ rpcCall: rpc.rpcCall })
    ;(railAction('设置').props.onClick as () => void)()
    await render({ rpcCall: rpc.rpcCall })
    await render({ rpcCall: rpc.rpcCall })
    await render({ rpcCall: rpc.rpcCall })
    // 改草稿 ⇒ plan 非 null ⇒ 关闭会走异步保存
    ;(findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻')[0]!.props.onChange as (e: unknown) => void)({ target: { value: '10:00' } })
    await render({ rpcCall: rpc.rpcCall })
    // 第一次关闭：进入「保存中」
    ;(findAll((node) => node.type === 'button' && textsIn([node]).includes('完成'))[0]!.props.onClick as () => void)()
    await flush(3)
    // 保存还没回来时点「网关」⇒ 必须排队
    ;(railAction('网关').props.onClick as () => void)()
    await flush(3)
    await render({ rpcCall: rpc.rpcCall })
    expect(findAll((node) => (node.type as { name?: string } | undefined)?.name === 'GatewayPanel').length,
      '保存进行中不该立刻打开网关弹窗（要先等保存完成）').toBe(0)
    // 保存完成 ⇒ 排队的回调必须执行
    release!()
    await flush(10)
    await render({ rpcCall: rpc.rpcCall })
    expect(findAll((node) => (node.type as { name?: string } | undefined)?.name === 'GatewayPanel').length,
      '保存完成后必须执行排队回调 —— 否则那次点击被静默吞掉').toBe(1)
  })

  /**
   * ★★★ 2026-11-06 十审（真缺陷）：排队会被「纯关闭」覆盖。
   *
   * 出口② 原本无条件 `checkinPendingCloseRef.current = onClosed`。而
   * **纯关闭手势**（「完成」按钮 / 点遮罩 / 再点一次「设置」）传的是
   * `undefined` ⇒ 它会**覆盖**掉之前排队的那个回调。
   *
   * 后果链：用户点「网关」（排队）→ 保存还没回来 → 随手点「完成」
   * （覆盖成 `undefined`）⇒ 保存完成后什么都不执行 ⇒ 那次「打开网关」
   * 的意图**永久丢失**，而界面上看不出任何异常。
   */
  it('★★★ 排队期间再点「完成」⇒ 不得覆盖「网关」的排队回调', async () => {
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
    installDocument()
    await render({ rpcCall: rpc.rpcCall })
    ;(railAction('设置').props.onClick as () => void)()
    await render({ rpcCall: rpc.rpcCall })
    await render({ rpcCall: rpc.rpcCall })
    await render({ rpcCall: rpc.rpcCall })
    ;(findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻')[0]!.props.onChange as (e: unknown) => void)({ target: { value: '10:00' } })
    await render({ rpcCall: rpc.rpcCall })
    // 进入「保存中」
    ;(findAll((node) => node.type === 'button' && textsIn([node]).includes('完成'))[0]!.props.onClick as () => void)()
    await flush(3)
    // 排队「网关」
    ;(railAction('网关').props.onClick as () => void)()
    await flush(3)
    // ★ 再点「完成」（纯关闭，传的是 undefined）—— 不得覆盖排队回调
    ;(findAll((node) => node.type === 'button' && textsIn([node]).includes('完成'))[0]!.props.onClick as () => void)()
    await flush(3)
    release!()
    await flush(10)
    await render({ rpcCall: rpc.rpcCall })
    expect(findAll((node) => (node.type as { name?: string } | undefined)?.name === 'GatewayPanel').length,
      '★★★ 纯关闭不得覆盖排队回调 —— 否则先点「网关」再点「完成」会让网关永久打不开').toBe(1)
  })

})

  /**
   * ★★★ 2026-11-06 真回归（重建阶段 3 引入，**127 条测试全绿也抓不到**）：
   *
   * `closeSettings` 的签名从 `(onClosed) =>` 变成 `() =>`，而四个入口里有三个
   * 仍然写成 `closeSettings(() => setShowXxx(true))` ⇒ 实参被**静默丢弃** ⇒
   * 用户点「网关」/「用量」/「供应商开关」**什么都不发生**。
   *
   * ⚠️ 为什么原有的 127 条全绿：它们只断言源码文本里存在
   *    `closeSettings(() => {` 这个**字符串** —— 那只证明「调用处写了回调」，
   *    完全不证明「回调会被调用」。**凡「传回调给一个只负责『关闭』的函数」，
   *    必须有一条行为断言证明回调真的被调用了。**
   */
  describe('底部操作行的「打开别的弹窗」入口必须真的打开（2026-11-06 真回归）', () => {
    // ⚠️⚠️ **本 describe 必须有自己的 `beforeEach`**（2026-11-06 十一审，
    //    审查员 e4e74842 报的 P0-1 假绿）。
    //
    // hooks 槽位是**文件级**的（替身要跨渲染保留），而 `useState` 的槽位化
    // 实现靠 `cursor` 索引取值。前一个 describe 里「保存进行中切「网关」」
    // 那条用例会把 `showGateway` 留成 `true` —— 于是即使「点「网关」」这条
    // 用例的回调被整个丢掉，`findAll(GatewayPanel).length` 仍然是 1 ⇒ **假绿**。
    //
    // 实测（审查员 A01 变异：出口① 删 `onClosed?.()`）：
    // - 同 describe 的「用量」「供应商开关」都红；
    // - **只有「点网关」绿** —— 正是这个泄漏。
    // - 加上本 `beforeEach` 后：A01 变异 ⇒ 3 failed（三条全红）。
    beforeEach(() => {
      slots = []
      committed = []
      cursor = 0
      pendingEffects = []
      root = undefined
    })
    /**
     * 渲染页面 → 点底部操作行的某个按钮 → 断言目标弹窗被挂载。
     *
     * ⚠️ 判据用**组件引用**（`node.type.name`）而不是 `aria-label` 之类的
     *    属性：本文件的 react 替身只渲染 `JetHubPage` 自己，子组件**内部
     *    不展开**，所以只能看「这个 createElement 有没有被生成」。
     */
    const clickAndFindPanel = async (label: string, panelName: string): Promise<number> => {
      const rpc = makeRpc()
      installDocument()
      await render({ rpcCall: rpc.rpcCall })
      ;(railAction(label).props.onClick as () => void)()
      await flush(3)
      await render({ rpcCall: rpc.rpcCall })
      return findAll((node) => (node.type as { name?: string } | undefined)?.name === panelName).length
    }

    it('★★★ 点「网关」必须打开网关弹窗（onClosed 丢失时这里是 0）', async () => {
      expect(await clickAndFindPanel('网关', 'GatewayPanel'),
        '「网关」按钮的回调没有被调用 ⇒ closeSettings 丢了 onClosed 参数').toBe(1)
    })

    it('★★★ 点「用量」必须打开用量弹窗', async () => {
      expect(await clickAndFindPanel('用量', 'TokenLedgerPanel'),
        '「用量」按钮的回调没有被调用').toBe(1)
    })

    it('★★★ 设置弹窗里的「打开供应商开关」必须真的打开供应商开关弹窗', async () => {
      const rpc = makeRpc()
      installDocument()
      await render({ rpcCall: rpc.rpcCall })
      // 先打开设置弹窗（供应商入口在它里面，不在底部操作行）
      ;(railAction('设置').props.onClick as () => void)()
      await flush(3)
      await render({ rpcCall: rpc.rpcCall })
      const entry = findAll((node) => node.type === 'button' && textsIn([node]).includes('打开供应商开关'))[0]
      expect(entry, '设置弹窗里找不到「打开供应商开关」入口').toBeTruthy()
      ;(entry!.props.onClick as () => void)()
      await flush(3)
      await render({ rpcCall: rpc.rpcCall })
      expect(findAll((node) => (node.type as { name?: string } | undefined)?.name === 'ProviderSwitchPanel').length,
        '「打开供应商开关」的回调没有被调用').toBe(1)
    })

    it('★★ 反向对照：点「设置」必须打开设置弹窗（不是「什么都不发生」）', async () => {
      const rpc = makeRpc()
      installDocument()
      await render({ rpcCall: rpc.rpcCall })
      ;(railAction('设置').props.onClick as () => void)()
      await flush(3)
      await render({ rpcCall: rpc.rpcCall })
      expect(findAll((node) => node.props?.className === 'dim-jh-modalOverlay').length,
        '「设置」按钮必须打开设置弹窗').toBe(1)
    })

    it('★★★ 设置弹窗开着时点「网关」⇒ 设置必须真的关掉（出口① 的 setShowSettings 不能被删）', async () => {
      // ⚠️⚠️ 2026-11-06 十一审（审查员 A10 变异）。
      //
      // 上面那条「点「网关」」用例**根本没打开设置弹窗** ⇒ 出口① 里的
      // `setShowSettings(false)` 是**幂等无操作** ⇒ 删掉它也照样绿。
      //
      // 而真实用户路径恰好相反：设置弹窗**开着**，用户点底部操作行的「网关」
      // ⇒ 必须先把设置关掉、再打开网关，否则两个全屏遮罩叠在一起。
      const rpc = makeRpc()
      installDocument()
      await render({ rpcCall: rpc.rpcCall })
      ;(railAction('设置').props.onClick as () => void)()
      await flush(3)
      await render({ rpcCall: rpc.rpcCall })
      expect(findAll((node) => node.props?.className === 'dim-jh-modalOverlay').length,
        '前置：设置弹窗必须已经打开').toBe(1)
      ;(railAction('网关').props.onClick as () => void)()
      await flush(3)
      await render({ rpcCall: rpc.rpcCall })
      expect(findAll((node) => node.props?.className === 'dim-jh-modalOverlay').length,
        '★★★ 设置弹窗必须关闭（否则两个全屏遮罩叠在一起）').toBe(0)
      expect(findAll((node) => (node.type as { name?: string } | undefined)?.name === 'GatewayPanel').length,
        '网关弹窗必须打开').toBe(1)
    })

    it('★★★ 保存失败过之后再点「网关」⇒ 必须能打开（出口③ 的 onClosed 不能被删）', async () => {
      // ⚠️⚠️ 2026-11-06 十一审（审查员 A05 变异）。
      //
      // 出口③ 是「上次保存失败过」分支：直接关 + 执行回调，**不重试保存**。
      // 现有用例里没有一条在「保存失败过」之后触发**带回调**的关闭
      // （「★ 保存失败后再关一次」走的是点遮罩，`closeSettings()` 无参）。
      // ⇒ 删掉出口③ 的 `onClosed?.()` 全绿。
      //
      // 真实用户路径：改时刻 → 保存失败（面板留着 + 显示错误）→ 点「网关」
      // ⇒ 出口③ 必须关掉设置并打开网关。
      const rpc = makeRpc({ failWrites: '模拟保存失败' })
      installDocument()
      await render({ rpcCall: rpc.rpcCall })
      ;(railAction('设置').props.onClick as () => void)()
      await flush(3)
      await render({ rpcCall: rpc.rpcCall })
      const input = findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻')
      expect(input.length, '时间输入框没渲染出来 ⇒ 面板没打开').toBe(1)
      ;(input[0]!.props.onChange as (event: unknown) => void)({ target: { value: '10:00' } })
      await render({ rpcCall: rpc.rpcCall })
      // 点「完成」⇒ 保存失败 ⇒ 设置弹窗留着 + 记下失败标记
      ;(byText('button', '完成')!.props.onClick as (e: unknown) => void)({ type: 'click' })
      await flush(10)
      await render({ rpcCall: rpc.rpcCall })
      expect(findAll((node) => node.props?.className === 'dim-jh-modalOverlay').length,
        '前置：保存失败时设置弹窗必须留着（否则用户看不到错误）').toBe(1)
      // 再点「网关」⇒ 走出口③
      ;(railAction('网关').props.onClick as () => void)()
      await flush(3)
      await render({ rpcCall: rpc.rpcCall })
      expect(findAll((node) => (node.type as { name?: string } | undefined)?.name === 'GatewayPanel').length,
        '★★★ 保存失败过之后点「网关」必须能打开（出口③ 的 onClosed 不能被删）').toBe(1)
    })

    it('★★★ 保存进行中切「网关」+ 保存**失败** ⇒ 网关不得打开（出口④ 的 pending 必须在 if 里）', async () => {
      // ⚠️⚠️ 2026-11-06 十一审（审查员 A08 变异）。
      //
      // 出口④ 的 `.then((okSaved) => { … if (okSaved) { …; pending?.(); } else { … } })`
      // 里，`pending?.()` **必须在 `if (okSaved)` 内**：保存失败时面板留着、
      // 排队动作**不能**执行（否则设置弹窗还在，网关又叠上来）。
      //
      // 现有用例里所有保存都**成功** ⇒ 把 `pending?.()` 挪出 `if` 全绿。
      // 本条用「保存失败」的桩补上这一格。
      const rpc = makeRpc({ failWrites: '模拟保存失败' })
      installDocument()
      await render({ rpcCall: rpc.rpcCall })
      ;(railAction('设置').props.onClick as () => void)()
      await flush(3)
      await render({ rpcCall: rpc.rpcCall })
      const input = findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻')
      ;(input[0]!.props.onChange as (event: unknown) => void)({ target: { value: '10:00' } })
      await render({ rpcCall: rpc.rpcCall })
      // 点「完成」⇒ 进入保存中
      ;(byText('button', '完成')!.props.onClick as (e: unknown) => void)({ type: 'click' })
      // **保存还没回来** ⇒ 立刻点「网关」（走出口② 排队）
      ;(railAction('网关').props.onClick as () => void)()
      await flush(10)
      await render({ rpcCall: rpc.rpcCall })
      expect(findAll((node) => (node.type as { name?: string } | undefined)?.name === 'GatewayPanel').length,
        '★★★ 保存失败时排队的「打开网关」不得执行（否则设置弹窗和网关叠在一起）').toBe(0)
    })

    /**
     * ⚠️⚠️ 宿主 RPC **没有超时** ⇒ 必须由客户端兜底（2026-11-07 十一审 P3 #3）。
     *
     * `rpcCall` 直通 `plugin-src/client/index.js` 的
     * `callManagementRpc(ctx.connection, …, signal)`，而那一层只是
     * `connection.rpc.call(...)` —— **没有任何超时**。链路卡死（服务端阻塞、
     * 连接半开）时那个 Promise 永远不 resolve。
     *
     * 而 `closeSettings` 用 `checkinSavingRef.current` 做单飞闸门：
     * 保存链挂着 ⇒ 闸门永远是 `true` ⇒ **设置弹窗彻底关不掉**，
     * 连「完成」按钮都不响应，用户只能刷新页面。
     *
     * 兜底是 `saveCheckinTimesWith` 里的 `Promise.race([rpcCall, timeout])`：
     * 15 秒后按「保存失败」返回 `false` ⇒ 走 `checkinSaveFailedRef` 那条路
     * ⇒ **再点一次就能关掉**（「已经提示过失败」正是这条兜底要的终态）。
     *
     * ⚠️ 用 fake timers 而不是真等 15 秒 —— 否则这一条会让整个文件慢 15 秒。
     */
    it('★★★ 保存请求永不返回 ⇒ 15 秒后必须按失败处理，面板不得死锁', { timeout: 60_000 }, async () => {
      // ⚠️ `shouldAdvanceTime: true`：本文件的 `flush()` 用
      //    `setTimeout(resolve, 0)` 推进微任务，纯 fake timers 会让它永不
      //    resolve（`await flush()` 直接挂到用例超时）。开了自动推进后，
      //    真实时间照常流动，而 `advanceTimersByTimeAsync` 仍能一次跨过 15 秒。
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const rpc = makeRpc({ hangWrites: true })
        page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage
        installDocument()
        await render({ rpcCall: rpc.rpcCall })
        ;(railAction('设置').props.onClick as () => void)()
        await flush(3)
        await render({ rpcCall: rpc.rpcCall })
        const input = findAll((node) => node.props?.['aria-label'] === '第 1 个执行时刻')
        ;(input[0]!.props.onChange as (event: unknown) => void)({ target: { value: '10:00' } })
        await render({ rpcCall: rpc.rpcCall })
        // 点「完成」⇒ 进入保存中（请求永不返回）
        ;(byText('button', '完成')!.props.onClick as (e: unknown) => void)({ type: 'click' })
        await flush(6)
        await render({ rpcCall: rpc.rpcCall })
        // 保存中：面板必须还在（这是正确行为 —— 不能假装成功）
        expect(findAll((node) => node.props?.className === 'dim-jh-modalOverlay').length,
          '保存进行中面板必须留着（不许乐观关闭）').toBe(1)
        // 推进 15 秒 ⇒ 超时兜底触发 ⇒ 按失败处理
        await vi.advanceTimersByTimeAsync(15_000)
        await flush(6)
        await render({ rpcCall: rpc.rpcCall })
        // 再点一次「完成」⇒ 走 checkinSaveFailedRef 那条「直接关」的出口
        ;(byText('button', '完成')!.props.onClick as (e: unknown) => void)({ type: 'click' })
        await flush(6)
        await render({ rpcCall: rpc.rpcCall })
        expect(findAll((node) => node.props?.className === 'dim-jh-modalOverlay').length,
          '★★★ 超时后必须能关掉面板（否则用户只能刷新页面）').toBe(0)

        // ★★ 定时器必须已被清理（十一审 P3 #3 复核）：`Promise.race` 只负责
        //    「谁先 settle」，**不会**清另一侧的定时器。不 `clearTimeout` 的话，
        //    正常路径（几十毫秒）会留下一个 15 秒的孤儿定时器 —— 测试里
        //    表现为 pending timer 警告，真实环境里是关不掉的 CPU 唤醒，
        //    而且**每点一次就多一个**。
        expect(vi.getTimerCount(), '超时兜底的定时器必须已 clearTimeout').toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })
