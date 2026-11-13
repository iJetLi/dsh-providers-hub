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
    // ⚠️⚠️ 必须同时写 `current`：真实 React 的 ref 对象上的属性就叫 `current`，
    //    而本替身原先只写了一个 `cur` 字段 —— 于是 `useRef(0)` 之后
    //    `++ref.current` 是 `++undefined` = **NaN**，而
    //    `NaN !== NaN` 恒真 ⇒ 任何「按序号丢弃过期响应」的闸门在本替身下
    //    **永远丢弃**（2026-11-09 审计实测：`loadProviderStatuses` 一次都
    //    没写进 state，症状是 `providerStatuses` 恒为 null）。
    //    `cur` 保留只为不破坏既有用例的写法。
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

/**
 * `target` 是否在 `subtree` 之内（含自身）。
 *
 * ⚠️ 用**对象身份**而非结构比较：`JSON.stringify` 比较在两个开关的 props 恰好
 * 相同的形态下会把「另一个分区的开关」判成同一个（本仓库踩过同型假绿）。
 */
function subtreeContains(subtree: AnyNode, target: AnyNode): boolean {
  let hit = false
  walk([subtree], (node) => { if (node === target) hit = true })
  return hit
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

    /**
     * 「思考强度」开关（2026-11-11 用户功能）。
     *
     * 这一条是为**真实报障**补的：用户实测「点击无效」。成因是宿主进程还在跑旧
     * 代码（客户端 bundle 热替换了、宿主侧 RPC 端点不存在）⇒ 客户端 catch 后把
     * 开关复原，界面**没有任何提示**。所以判据有两条腿：
     * ① 点击必须真的发出 `reasoningDefault.setEnabled`（不是「只改了个 state」）；
     * ② 宿主拒绝时**必须把失败说出来**（否则用户只能看到「点了又弹回去」）。
     */
    it('★★★ 点「思考强度」开关必须发出 reasoningDefault.setEnabled', async () => {
      const rpc = makeRpc()
      installDocument()
      await render({ rpcCall: rpc.rpcCall })
      ;(railAction('设置').props.onClick as () => void)()
      await flush(3)
      await render({ rpcCall: rpc.rpcCall })

      // 定位：先找标题为「思考强度」的分区，再取该分区子树里的 checkbox。
      // ⚠️ 必须按**分区**定位而不是「第一个 switch」：设置弹窗里现在有 3 个开关
      //    （定时签到 / 渠道原生搜索 / 思考强度），取第一个会测到别人身上。
      const section = findAll((node) => node.props?.className === 'dim-jh-settingsSection'
        && textsIn([node]).includes('思考强度'))[0]
      expect(section, '设置弹窗里找不到「思考强度」分区（开关被删了？）').toBeTruthy()
      const switches = findAll((node) => node.type === 'input'
        && node.props?.className === 'dim-jh-switch')
        .filter((node) => subtreeContains(section!, node))
      expect(switches.length, '「思考强度」分区里没有开关').toBe(1)

      ;(switches[0]!.props.onChange as (event: unknown) => void)({ target: { checked: false } })
      await flush(5)

      const writes = rpc.calls.filter((call) => call.method === 'reasoningDefault.setEnabled')
      expect(writes.length, '点开关没有发出 reasoningDefault.setEnabled').toBe(1)
      expect((writes[0]!.payload as { enabled?: unknown }).enabled, '写下去的值不对').toBe(false)
    })

    it('★★ 宿主没有这条 RPC（旧宿主）⇒ 必须显示失败提示，不能静默弹回', async () => {
      // 复刻真实报障：宿主还在跑旧代码，`reasoningDefault.*` 落进 default 分支。
      const calls: Array<{ method: string; payload: unknown }> = []
      const rpcCall = async (method: string, payload?: unknown): Promise<unknown> => {
        calls.push({ method, payload })
        if (method.startsWith('reasoningDefault.')) {
          throw new Error('bad-request: unknown method: reasoningDefault.setEnabled')
        }
        return {}
      }
      installDocument()
      await render({ rpcCall })
      ;(railAction('设置').props.onClick as () => void)()
      await flush(3)
      await render({ rpcCall })

      const hint = findAll((node) => node.props?.className === 'dim-jh-settingsInlineFail')[0]
      expect(hint, '宿主缺 RPC 时必须给出显式失败提示（否则用户只看到「点了又弹回去」）').toBeTruthy()
      expect(textsIn([hint!]).join('')).toContain('重新打开 DSH')
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

/**
 * ⚠️⚠️ **账号管理行「供应商开关」的点击接线**（2026-11-09 审计 M6 / F1）。
 *
 * ## 为什么必须另起一段
 *
 * PR #52 自己在描述里写：「`closeSettings` 丢了 `onClosed` 参数 ⇒ 点『网关』/
 * 『用量』/『供应商开关』什么都不发生，而 **127 条测试全绿**」。它把这一类
 * 缺陷写得很清楚 —— 然后**在同一个 PR 里又造了一个同型的**：
 *
 * 域C 变异 M6 把开关的 `onClick` 体整个包进 `if (false)`，**148 条全绿**。
 * 原因是 `provider-toggle.spec.ts` 那 130 条几乎全是**源码字符串 / 切片断言**
 * （除 `providerSwitchState` 纯函数），而 `model-center-panel.spec.ts:55-56`
 * 又写着「行为守卫在 `provider-toggle.spec.ts`」—— **循环指认，谁都没测**。
 *
 * 本段补的就是这一层：**真渲染 + 真 event handler + 真 RPC 桩**，
 * 断言「点下去到底发没发 `provider.setEnabled`」。
 *
 * ## 顺带锁住 F1（禁用原因可见）
 *
 * `disabled` 会把 Chromium 的原生 tooltip 关掉（`switchState.reason` 挂在
 * `title` 上）⇒ 用户与屏幕阅读器都拿不到「为什么点不动」。改用
 * `aria-disabled` + 点击早退之后，**禁用时点下去必须一次请求都不发** ——
 * 这条断言同时守住「早退没被删」和「没有把 disabled 换成静默可点」。
 */
describe('★★ 供应商开关的点击接线（真实组件 + 真 event handler）', () => {
  beforeEach(() => {
    slots = []
    committed = []
    cursor = 0
    pendingEffects = []
    root = undefined
    installDocument()
  })

  /**
   * 直接渲染 `ProviderPanel`。
   *
   * ⚠️⚠️ **不能从 `JetHubPage` 往下走**：本文件的 react 替身**不调用函数组件**，
   * 从 `JetHubPage` 渲染出来只看得到 `<ProviderPanel …>` 这个**元素本身**、
   * 看不到它内部的开关。这正是「源码文本断言 + 循环指认」漏掉 M6 的形态：
   * 断言「有 onClick」看得见，断言「点了真发请求」看不见。
   * ⇒ 走 `jet-hub.js` **既有**的 `__providersPanelForTest` 别名
   *   （`__creditBalanceRowForTest` 同款取舍）。⚠️ 不要为此再加一个
   *   `export function ProviderPanel` —— 同一个组件两条导入路径，
   *   下一个人不知道该用哪条。
   */
  async function renderPanel(overrides: Record<string, unknown> = {}): Promise<void> {
    const mod = await import('../../plugin-src/client/jet-hub.js') as unknown as {
      __providersPanelForTest?: (p: unknown) => unknown
    }
    const panel = mod.__providersPanelForTest
    expect(typeof panel, '__providersPanelForTest 必须被导出（本段的前提，不是被测行为）').toBe('function')
    const props: Record<string, unknown> = {
      provider: 'codearts',
      rpcCall: async () => ({}),
      providerStatuses: {},
      providerBusy: new Set<string>(),
      onToggleProvider: () => {},
      ...overrides,
    }
    // 渲染两拍：第一拍挂 effect，第二拍把 effect 里 setState 的结果画出来。
    for (let round = 0; round < 2; round += 1) {
      cursor = 0
      pendingEffects = []
      root = panel(props)
      await flush(3)
    }
  }

  function switches(): AnyNode[] {
    return findAll((node) => node.props?.className === 'dim-jh-providerSwitch')
  }

  it('★★ 点「已启用」的开关 ⇒ 必须真的调 onToggleProvider(provider, false)', async () => {
    const calls: Array<[string, boolean]> = []
    await renderPanel({
      providerStatuses: { codearts: { models: { total: 3, disabled: 0 } } },
      onToggleProvider: (id: string, enabled: boolean) => { calls.push([id, enabled]) },
    })

    const all = switches()
    expect(all.length, '账号管理行里找不到供应商开关 ⇒ 本段失效（组件结构已变）').toBe(1)
    const enabledSwitch = all[0]!
    expect(enabledSwitch.props['aria-checked'], '健康供应商必须显示为「已启用」').toBe('true')
    expect(enabledSwitch.props['aria-disabled'], '健康的供应商开关不得是禁用态').toBe('false')

    ;(enabledSwitch.props.onClick as () => void)()
    await flush(4)

    // 判别力：把 onClick 体整段包进 `if (false)` ⇒ 这里变 0（域C 变异 M6 实测）。
    expect(calls.length, '★ 点开关必须真的调 onToggleProvider（否则用户点了没反应）').toBe(1)
    expect(calls[0], '「已启用」的开关点下去 = 关闭它').toEqual(['codearts', false])
  })

  it('★★ 点「已关闭」的开关 ⇒ 必须调 onToggleProvider(provider, true)（IKP8OF 出口）', async () => {
    const calls: Array<[string, boolean]> = []
    await renderPanel({
      // ⚠️ 已关闭 + total 0 是**真实可达**形态（账号被删光）：开关必须仍可点开，
      //    否则用户既关不掉也打不开（IKP8OF 死锁）。
      providerStatuses: { codearts: { models: { total: 0, disabled: 0 }, closed: true } },
      onToggleProvider: (id: string, enabled: boolean) => { calls.push([id, enabled]) },
    })

    const all = switches()
    expect(all.length, '找不到供应商开关 ⇒ 本段失效').toBe(1)
    const closed = all[0]!
    expect(closed.props['aria-checked'], '已关闭的供应商必须显示为「已关闭」').toBe('false')
    expect(closed.props['aria-disabled'], '已关闭的供应商开关必须可点（IKP8OF）').toBe('false')

    ;(closed.props.onClick as () => void)()
    await flush(4)

    expect(calls.length, '★ 点「已关闭」的开关必须真的调 onToggleProvider').toBe(1)
    expect(calls[0], '「已关闭」的开关点下去 = 打开它').toEqual(['codearts', true])
  })

  it('★★ 禁用态的开关点下去必须一次都不调（aria-disabled 的早退腿）', async () => {
    const calls: Array<[string, boolean]> = []
    await renderPanel({
      // ⚠️ 空 statuses ⇒ `providerSwitchState(undefined)` ⇒ 「状态尚未读取」⇒ 禁用。
      providerStatuses: {},
      onToggleProvider: (id: string, enabled: boolean) => { calls.push([id, enabled]) },
    })

    const all = switches()
    expect(all.length, '找不到供应商开关 ⇒ 本段失效').toBe(1)
    const disabledSwitch = all[0]!
    expect(disabledSwitch.props['aria-disabled'], '状态未知时开关必须是禁用态').toBe('true')
    // 原因必须挂在 title 上（F1：`disabled` 会让 Chromium 连原生 tooltip 都不给）。
    expect(String(disabledSwitch.props.title), '禁用时必须给出原因').toContain('状态尚未读取')

    ;(disabledSwitch.props.onClick as () => void)()
    await flush(4)

    // `aria-disabled` 只是「告诉」AT，早退才是真拦 —— 删掉早退 ⇒ 这里变 1。
    expect(calls.length, '★★ 禁用态的开关点下去必须一次都不调').toBe(0)
  })
})

/**
 * ⚠️⚠️ 2026-11-09 审计（P2 死 import）：底部操作行的「网关」按钮原先**硬编码**
 * 文字 `'网关'`，于是 `gatewayButtonLabel` 从 `./openai-gateway-panel.js`
 * 引入后**零使用** —— 旧页头那个「网关 **●**」的运行态圆点搬过来时静默消失，
 * 运行/停止的差别只剩 `title` 里的一句话。
 *
 * ⚠️ 为什么必须单独写一条：`openai-gateway-panel.spec.ts:66-73` 仍在测
 * `gatewayButtonLabel` 那个**纯函数本身**（返回 `'网关 ●'` / `'网关'`），
 * 它照样全绿 —— 死的是**接线**，不是函数。
 * ⇒ 判据必须打在「渲染出 JetHubPage 之后，底部那个按钮的文字是什么」。
 */
describe('底部操作行的「网关」按钮：运行态圆点必须接上（2026-11-09 审计 P2）', { timeout: 30_000 }, () => {
  beforeEach(() => {
    slots = []
    committed = []
    cursor = 0
    pendingEffects = []
    root = undefined
  })

  /** 底部操作行里「网关」那个按钮的可见文字（拼起来）。 */
  function railGatewayText(): string {
    const buttons = findAll(
      (node) => node.type === 'button' && node.props?.className === 'dim-jh-btn dim-jh-railAction',
    )
    // 四个按钮的 className 完全相同，只能靠「点开的是网关弹窗」区分 ——
    // 这里反过来用「文字里含『网关』」找，因为正是它自己要被断言。
    const gateway = buttons.find((node) => textsIn([node]).some((text) => text.startsWith('网关')))
    expect(gateway, '底部操作行里找不到「网关」按钮 ⇒ 本段失效（结构已变）').toBeDefined()
    return textsIn([gateway]).join('')
  }

  it('★★ 网关正在运行 ⇒ 底部按钮必须显示「网关 ●」（圆点不得丢）', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage
    const rpcCall = async (method: string): Promise<unknown> => {
      // 只关心网关；其余一律给空壳（本用例不看它们）。
      if (method === 'gateway.getEnabled') return { running: true }
      return {}
    }
    await render({ rpcCall })

    // 判别力：把 `gatewayButtonLabel(gatewayStatus)` 改回硬编码 `'网关'`
    // ⇒ 这里拿到 `'网关'`，`toContain('●')` 变红。
    expect(railGatewayText(), '★★ 网关运行中时底部按钮必须带圆点（否则用户看不出它开着）').toContain('●')
  })

  it('★ 反向对照：网关没在运行 ⇒ 不得凭空画出圆点', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage
    const rpcCall = async (method: string): Promise<unknown> => {
      if (method === 'gateway.getEnabled') return { running: false }
      return {}
    }
    await render({ rpcCall })

    // ⚠️ 这条不是同义反复：把 `gatewayButtonLabel(status)` 换成一律返回
    //    `'网关 ●'` 的常量，上一条仍然绿、这一条变红。
    expect(railGatewayText(), '★ 网关没运行时不得显示圆点').not.toContain('●')
  })
})

/**
 * ⚠️⚠️ 2026-11-09 审计（F2）：`loadProviderStatuses` 原先**失败就 `setProviderStatuses(null)`**，
 * 于是**一次瞬态失败（429 / 502 / 超时）就让全部供应商开关变灰**，而唯一恢复路径是
 * 「设置 → 打开供应商开关 → 刷新」—— 那条路径在提示文案里一个字都没提。
 *
 * 修法 = 失败时**保留上一次读到的汇总**（它是「稍旧」不是「错的」，再点一次
 * 服务端会自己纠正）。
 *
 * ⚠️ 为什么必须写行为级：只断言源码里没有 `setProviderStatuses(null)` 会被
 * 「`if (false) setProviderStatuses(null)`」「设成 `{}`」这类写法绕过
 * （本仓 `client-ui.md` 记的 `if (false)` 短路禁用）。
 */
describe('provider.status 读失败：开关不得集体变灰（2026-11-09 审计 F2）', { timeout: 30_000 }, () => {
  beforeEach(() => {
    slots = []
    committed = []
    cursor = 0
    pendingEffects = []
    root = undefined
  })

  it('★★ 已有状态之后读失败 ⇒ 开关必须保持可点（只降级成「可能旧」，不是「全不可用」）', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage

    // ⚠️ 「已打开」而不是「已关闭」：页面有个一次性纠偏 effect 会把 `selected`
    //    切到自定义序里第一个**已打开**的供应商，用「已关闭」会把 codearts
    //    从渲染里换掉（本用例就找不到它了）。
    const OPEN = { models: { total: 3, disabled: 0 } }
    // ⚠️ 用**开关**而不是「第几次调用」来切失败：本文件的 react 替身里
    //    `useCallback` 每次渲染都返回新函数 ⇒ effect 依赖恒变 ⇒ 首屏就会
    //    发多次 `provider.status`（后到的会把先到的按序号丢弃）。
    //    按调用次数切会让「第一次成功」被这些重入吃掉。
    let shouldFail = false
    const rpcCall = async (method: string): Promise<unknown> => {
      if (method === 'provider.status') {
        if (shouldFail) throw new Error('502 Bad Gateway')
        return { statuses: { codearts: OPEN } }
      }
      return {}
    }
    // 关闭供应商前会弹 confirm（node 环境没有）—— 本用例只关心「读失败」这一腿。
    const originalConfirm = (globalThis as Record<string, unknown>).confirm
    ;(globalThis as Record<string, unknown>).confirm = () => true
    try {
      // ⚠️ 多渲染几拍：本文件的 react 替身里 `root` 存的是**上一次**创建的
      //    元素，props 永远滞后一拍（状态更新要下一拍才反映出来）。
      for (let i = 0; i < 6; i += 1) await render({ rpcCall })

      // ⚠️ 本文件的 react 替身**不渲染子组件**（见 `__providersPanelForTest`
      //    的注释），所以拿不到真正的 `<button role=switch>`。退一步读**传给
      //    ProviderPanel 的 props** —— 那正是开关状态与可点性的唯一来源，
      //    等价于「渲染出来的开关长什么样」，且不依赖 DOM 替身。
      const panelProps = (): Record<string, unknown> | undefined =>
        // ⚠️ 必须同时匹配 `providerStatuses`：`ProviderLogo` 也收 `provider`，
        //    只按 provider 找会命中那个图标组件（实测 props 里没有状态）。
        findAll(
          (node) => typeof node.type === 'function'
            && node.props?.provider === 'codearts'
            && 'providerStatuses' in node.props,
        )[0]?.props

      const before = panelProps()
      expect(before, '找不到 codearts 的 ProviderPanel ⇒ 本段失效').toBeDefined()
      expect((before!.providerStatuses as Record<string, unknown>).codearts, '第一拍必须读到「已启用」').toEqual(OPEN)

      // 关掉它 ⇒ 成功后重拉状态，而这一次 `provider.status` 抛 502。
      shouldFail = true
      await (before!.onToggleProvider as (id: string, enabled: boolean) => Promise<void>)('codearts', false)
      await flush(6)
      // ⚠️ 必须**再渲染**：`root` 里存的是上一次创建的元素，不重渲染就还是
      //    切换前的 props（这条漏过一次 —— 变异 ME 因此假绿）。
      for (let i = 0; i < 4; i += 1) await render({ rpcCall })

      const after = panelProps()
      expect(after, '读失败后 ProviderPanel 必须还在（不许整块消失）').toBeDefined()
      // ⚠️ 2026-11-09 审计（P3-5）：先单独判一次 `providerStatuses` 非 null，
      //    否则「读失败把它清成 null」这个缺陷会表现为
      //    `TypeError: Cannot read properties of null (reading 'codearts')`
      //    —— 报错指向的是**断言自己**，看不出「是哪条语义坏了」。
      const afterStatuses = after!.providerStatuses as Record<string, unknown> | null
      expect(
        afterStatuses,
        '★★ 一次读失败不得把已读到的汇总清成 null（那会让整页供应商管理不可用）',
      ).not.toBeNull()
      // 判别力：把 catch 里的「刻意不置 null」改回 `setProviderStatuses(null)`
      // ⇒ 上一条拿到 `null` ⇒ 变红（且报的是上面那句，不是 TypeError）。
      expect(afterStatuses?.codearts, '读失败后必须仍是上一次读到的「已启用」').toEqual(OPEN)
    } finally {
      ;(globalThis as Record<string, unknown>).confirm = originalConfirm
    }
  })

  /**
   * ⚠️⚠️ 2026-11-09 审计（P2-1 / 变异 M15）：恢复的 AST 闸门**只数语法**，
   * 一行 `if (false && (…)) return` 就能让「更新点 = 1、比较点 = 2」三个数字
   * 全不变，而闸门实际已死（34 条全绿）。⇒ 必须再有一条**行为级**用例把
   * 「迟到的旧响应不得覆盖新状态」钉死在运行时。
   *
   * 判别力：把 `if (!mounted.current || seq !== providerStatusSeqRef.current) return`
   * 里的序号比较删掉 ⇒ 慢的 `OLD` 后到并覆盖 `NEW` ⇒ 变红。
   */
  it('★★ 迟到的旧 provider.status 不得覆盖新状态（序号闸门的行为级守卫）', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage

    const NEW = { models: { total: 2, disabled: 0 } }
    const OLD = { models: { total: 9, disabled: 9 } }
    let call = 0
    const rpcCall = async (method: string): Promise<unknown> => {
      if (method !== 'provider.status') return {}
      call += 1
      // 第 1 次：立刻回「新状态」；第 2 次：**慢 40ms** 回「旧状态」。
      // 两者都按发起顺序编号，但返回顺序相反 —— 正是序号闸门要处理的场景。
      if (call === 1) return { statuses: { codearts: NEW } }
      if (call === 2) {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return { statuses: { codearts: OLD } }
      }
      // 第 3 次起永久挂起：否则最后一次读取渲染会把 OLD 洗成 NEW，判别力归零。
      return new Promise(() => {})
    }

    await render({ rpcCall })
    // 再渲染一拍 ⇒ effect 依赖（stub 里 `useCallback` 每次返回新函数）变化 ⇒
    // 发出第 2 次 `provider.status`（慢的那个）。
    await render({ rpcCall })
    // 等慢响应真的回来并（应当）被丢弃。
    await new Promise((resolve) => setTimeout(resolve, 80))
    await flush(6)

    const panel = findAll(
      (node) => typeof node.type === 'function'
        && node.props?.provider === 'codearts'
        && 'providerStatuses' in node.props,
    )[0]?.props as Record<string, unknown> | undefined
    expect(panel, '找不到 codearts 的 ProviderPanel ⇒ 本段失效').toBeDefined()
    const statuses = panel!.providerStatuses as Record<string, unknown> | null
    expect(statuses, '状态不得为空（本用例的前提）').not.toBeNull()
    expect(
      statuses?.codearts,
      '★★ 迟到的旧响应必须被丢弃（否则界面会回退成用户没做过的状态，且没有任何报错）',
    ).toEqual(NEW)
  })

  /**
   * ⚠️⚠️ 2026-11-09 审计（P2-2 / 变异 M17）：`toggleProvider` 自身当时**没有任何
   * busy 判据** —— `providerBusy` 是 state，要等下一次渲染才进 `switchBusy`，
   * 同一帧里连点两次读到的都是旧的 `false` ⇒ **两个写请求都发出去**。
   * `aria-disabled` 只是「告诉」AT，不是拦截。
   *
   * 判别力：删掉 `if (providerToggleInFlightRef.current.has(providerId)) return`
   * 或 `finally` 里的 `delete` 之外的任何一条腿 ⇒ 这里变 2。
   */
  it('★★ 同帧连点两次只发一次 provider.setEnabled（防双写）', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage

    const writes: Array<Record<string, unknown>> = []
    // ⚠️ 收集**所有**挂起的写，最后一起放行。若只放行「当前那一个」，
    //    去重腿被删掉时第二次写会永远挂着、用例变成**超时**而不是断言失败
    //    —— 那样「变红」的红因就不是被测腿了（本仓明写的假红形态）。
    const releasers: Array<() => void> = []
    const rpcCall = async (method: string, params?: unknown): Promise<unknown> => {
      if (method === 'provider.status') return { statuses: { codearts: { models: { total: 3, disabled: 0 } } } }
      if (method === 'provider.setEnabled') {
        writes.push(params as Record<string, unknown>)
        // 挂住写请求，让第二次点击**在它返回之前**发生（模拟真实双击）。
        await new Promise<void>((resolve) => { releasers.push(resolve) })
        return {}
      }
      // `gateway.getEnabled` / 其它一律给空壳。
      return {}
    }

    await render({ rpcCall })
    const panel = findAll(
      (node) => typeof node.type === 'function'
        && node.props?.provider === 'codearts'
        && 'providerStatuses' in node.props,
    )[0]?.props as Record<string, unknown> | undefined
    expect(panel, '找不到 codearts 的 ProviderPanel ⇒ 本段失效').toBeDefined()

    const toggle = panel!.onToggleProvider as (id: string, enabled: boolean) => Promise<void>
    // ⚠️ 打开方向（enabled=true）不会弹 confirm —— 本用例只验「防双写」这一腿。
    const first = toggle('codearts', true)
    const second = toggle('codearts', true)
    await flush(2)
    // 全部放行（正常实现下只有一个）。
    for (const release of releasers) release()
    await Promise.all([first.catch(() => {}), second.catch(() => {})])
    await flush(6)

    expect(
      writes.length,
      '★★ 同帧连点两次必须只发一次 provider.setEnabled（否则账号/模型状态被写两遍，第二次读到的是第一次的中间态）',
    ).toBe(1)
  })

  /**
   * ⚠️⚠️ 2026-11-09 审计（P3-1）：失败时挂的那条 warn 横幅原先**永远不会消失**
   * —— 成功分支只 `setProviderStatusFailed(false)`，而 `providerNotice` 只有
   * `toggleProvider` / `commitProviderOrder` 会清。一次瞬态 502 之后，哪怕后面
   * 每次读都成功，页头仍永久写着「显示的是上一次读到的状态」，与界面上的实时
   * 状态**自相矛盾**（用户会以为还在坏着）。
   *
   * 判别力：删掉成功分支里的
   * `setProviderNotice(prev => (prev?.source === 'provider-status' ? null : prev))`
   * ⇒ 这里仍读到那条 warn ⇒ 变红。
   */
  it('★ 读失败后恢复成功 ⇒ 那条「显示的是上一次读到的状态」必须收掉', async () => {
    page = (await import('../../plugin-src/client/jet-hub.js') as unknown as { JetHubPage: (p: unknown) => unknown }).JetHubPage

    const OPEN = { models: { total: 3, disabled: 0 } }
    let shouldFail = true
    const rpcCall = async (method: string): Promise<unknown> => {
      if (method === 'provider.status') {
        if (shouldFail) throw new Error('502 Bad Gateway')
        return { statuses: { codearts: OPEN } }
      }
      return {}
    }

    /**
     * 页面级供应商提示（`providerNotice`）的文字。
     *
     * ⚠️ 它不是 `ProviderPanel` 的 prop —— 它由 `JetHubPage` 直接渲染成
     * `div.dim-jh-probeNotice[data-tone]`（`plugin-src/client/jet-hub.js:11065-11071`），
     * 所以只能按 DOM 形状找。`style.margin` 是这条独有的（同页还有其它
     * `dim-jh-probeNotice`，都在各自面板里、margin 不是这个）。
     */
    const providerNoticeText = (): string => {
      const nodes = findAll(
        (node) => node.props?.className === 'dim-jh-probeNotice'
          && (node.props?.style as Record<string, unknown> | undefined)?.margin === '12px 24px 0',
      )
      return nodes.map((node) => textsIn([node]).join('')).join('\n')
    }

    // 第一拍：读失败 ⇒ 挂上 warn。
    for (let i = 0; i < 6; i += 1) await render({ rpcCall })
    expect(
      providerNoticeText(),
      '读失败必须给出提示（否则用户不知道看到的是旧状态）',
    ).toContain('供应商开关状态读取失败')

    // 第二拍：恢复成功 ⇒ 横幅必须收掉。
    shouldFail = false
    for (let i = 0; i < 8; i += 1) await render({ rpcCall })
    expect(
      providerNoticeText(),
      '★ 恢复成功后那条 warn 必须消失（否则界面永久自相矛盾）',
    ).toBe('')
  })
})
