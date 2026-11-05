import { describe, expect, it, vi } from 'vitest'

/**
 * `ProviderPanel` 的**接线层行为级**守卫（2026-10-25 审计 P1-3 / A3-1 / B3）。
 *
 * ## 这个文件为什么必须存在
 *
 * 2026-10-22 的整页白屏事故，根因是 `probeNotice` 被写成**裸字符串**，而渲染端
 * 按对象读 `.details.length` ⇒ `TypeError` ⇒ React 卸载整棵设置页。
 *
 * 修复本身是对的（16 个写入点都过 `normalizeProbeNotice`），但审计实测发现：
 * **整条接线层零守卫** —— `tests/unit/notice-shape.spec.ts` 的三条**源码文本**
 * 断言各有一个真实旁路：
 *
 * | 旁路 | 形态 | 为什么逃得掉 |
 * |---|---|---|
 * | 三元字面量 | `setProbeNotice(x ? 'a' : 'b')` | 正则要求 `(` 后**紧跟**引号 |
 * | 下标读取 | `probeNotice.details['length']` | 正则只匹配 `.details.length` |
 * | 死分支包装 | `if (false) { setState(normalize(x)) }` | 「存在包装」的 `toMatch` 在死分支里照样命中 |
 *
 * 实测：三者**同时**注入（= 完整白屏回归态）时，41 条相关用例**全绿**，而同一份
 * 代码执行时确实抛 `TypeError`。
 *
 * ## 为什么行为级守卫是可行的（推翻一处错误前提）
 *
 * `notice-shape.spec.ts:33-36` 断言「单测环境是 `node`，`react` 是宿主注入的
 * external，`jet-hub.js` **根本 import 不了**，组件无法渲染」——**这是错的**：
 * 本仓库的 `tests/unit/jet-hub-tdz.spec.ts:99` 早就用 `vi.mock('react', …)` +
 * 真实 `await import('../../plugin-src/client/jet-hub.js')` 跑过运行时渲染。
 *
 * 那个错误前提正当化了「接线层不用行为级测试」，并让三条无牙断言看起来足够。
 * ⇒ 本文件用同一套替身**真正调用** `ProviderPanel`，把「渲染端读到什么形状」
 * 变成可断言的行为。
 *
 * ## 判据打在哪
 *
 * 不是「源码里有没有某个字面量」，而是：
 * 1. **写入端**：`ProviderPanel` 调 `setProbeNotice(...)` 之后，state 里存的
 *    必须是**对象**（`{tone,text,details}`）或 `null` —— 绝不是字符串；
 * 2. **渲染端**：拿 state 去渲染时**不得抛错**（这正是事故的那一行）。
 *
 * 任一条被破坏（含上述三个旁路任选其一），本文件会红。
 */

/** hook 槽位：每次「渲染」重置，模拟一次组件挂载。 */
let hooks: unknown[] = []
let cursor = 0
/** 本次渲染期间被 `useState` setter 写过的值（按写入顺序）。 */
let writes: Array<{ index: number; value: unknown }> = []
/** 本次渲染期间传进 `useCallback` 的回调（用于真实调用、观察写入形态）。 */
let callbacks: unknown[] = []
/** 本次渲染产出的 React 元素（只留 props：`onClick` 之类挂在这里）。 */
let elements: Array<{ type: unknown; props: unknown }> = []

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
    // ⚠️ 组件里读的是 `ref.current`，不是 `.v`（`slot` 给 useState 用的是后者）。
    // 改前这里直接返回 `slot(initial)` ⇒ `pollRef.current` 恒 `undefined` ⇒
    // 「上一次登录仍在进行中」那条守卫**恒真** ⇒ 所有「新建账号」路径提前 return，
    // 接线层根本走不到（2026-10-25 补「登录开窗」用例时实测）。
    const s = slot(initial) as { v: T; current?: T }
    if (!('current' in s)) s.current = s.v
    return s as unknown as { current: T }
  },
  useEffect() {},
  useLayoutEffect() {},
  // ⚠️ 真实 React 在**调用本函数之前**就求值了 deps（这正是 TDZ 会炸的原因），
  // 故这里不读 deps —— 与 `jet-hub-tdz.spec.ts` 同款，避免把 TDZ 测成「通过」。
  // ⚠️ **记录每次传进来的回调**：接线层（`setProbeNotice` 是不是归一化过的）
  // 只能靠「真调用它、看写出去什么」来判定 —— 源码文本断言有已知旁路。
  useCallback<T>(fn: T): T {
    callbacks.push(fn)
    return fn
  },
  useMemo<T>(fn: () => T): T {
    return fn()
  },
  // ⚠️ 记录每次 createElement 的 props：`createAccount` 是**普通函数**（不走 useCallback），
  // 只能从它被挂上去的 onClick 拿到（否则接线层永远够不着「新建账号」这条路径）。
  createElement: (type: unknown, props: unknown) => { elements.push({ type, props }); return null },
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
  Component: class {},
}

vi.mock('react', () => reactStub)

/** 一次「渲染」：重置槽位与写入记录。 */
function resetRender(): void {
  elements = []
  hooks = []
  cursor = 0
  writes = []
  callbacks = []
}

type RenderResult =
  | { ok: true; writes: Array<{ index: number; value: unknown }>; callbacks: unknown[] }
  | { ok: false; error: unknown }

/**
 * 渲染 `ProviderPanel` 一次，收集其写入行为。
 *
 * ⚠️ `ProviderPanel` 没有被 `export`（它是内部组件），故经由 `JetHubPage`
 * 的模块命名空间取不到。这里用 `rpcCall` 桩驱动它走「添加账号」路径 ——
 * 该路径正是事故现场（`res.existed` 分支曾传裸字符串）。
 */
async function renderPanel(
  rpcCall: (method: string, payload?: unknown) => Promise<unknown>,
  provider = 'opencode',
): Promise<RenderResult> {
  resetRender()
  try {
    const mod = await import('../../plugin-src/client/jet-hub.js')
    // 模块必须能加载（否则下面全是假绿）
    expect(typeof mod.JetHubPage).toBe('function')
    // 通过 `__testHost` 逃生口拿内部组件（见 jet-hub.js 的同名导出注释）
    const panel = (mod as unknown as { __providersPanelForTest?: (props: unknown) => unknown }).__providersPanelForTest
    if (typeof panel !== 'function') {
      // 逃生口未接线 ⇒ 明确失败，绝不静默跳过（否则整个文件会变成集体的假绿）
      return { ok: false, error: new Error('__providersPanelForTest 未导出：接线层无法被行为级守卫覆盖') }
    }
    panel({ provider, rpcCall })
    return { ok: true, writes, callbacks }
  } catch (error) {
    return { ok: false, error }
  }
}

describe('ProviderPanel 接线层（行为级）', () => {
  it('能真实渲染（防止「加载失败」被当成通过）', async () => {
    const r = await renderPanel(async () => ({ ok: true, order: [], statuses: {} }))
    expect(r.ok, r.ok ? '' : `渲染抛错：${String((r as { error: unknown }).error)}`).toBe(true)
  })

  /**
   * ★★ **所有 state 写入都不得是裸字符串**（事故的直接成因）。
   *
   * 判据打在**行为**上：读了 `useState` setter 的实际入参，而不是源码文本。
   * 三个已知旁路（三元字面量 / 死分支包装 / 间接变量）在行为层**无处可逃**
   * —— 只要值最终是字符串，这里就红。
   *
   * ⚠️ 允许 `null`（= 清除提示）与对象；只禁止**字符串**。
   */
  it('★★ 写入 state 的值不得是裸字符串（白屏事故的直接成因）', async () => {
    const r = await renderPanel(async () => ({ ok: true, order: [], statuses: {} }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const offenders = r.writes
      .filter((w) => typeof w.value === 'string')
      .map((w) => ({ slot: w.index, value: w.value }))
    expect(offenders, '有 state 被写入裸字符串 ⇒ 任何按对象读字段的渲染点都会抛 TypeError').toEqual([])
  })

  /**
   * ★★★ **归一化包装必须真的生效**（这是整条防线的承重腿）。
   *
   * ## 为什么必须「真调用回调」，不能只看源码
   *
   * 事故的第二道闸是 `setProbeNotice = useCallback(next => setState(normalize(next)))`。
   * 源码文本断言只能证明「这段文字在文件里」，而 `if (false) { setState(normalize(x)) }`
   * 这种**死分支**同样满足它（审计实测 M10-a：41 条相关用例全绿）。
   *
   * ⇒ 这里拿渲染时**真实传进 `useCallback` 的每一个回调**，逐个喂一个**裸字符串**：
   * 只要其中有一个把**字符串原样写进 state**，就说明归一化没接上（或走不到），
   * 这里立刻红。（喂裸字符串正是事故现场的输入形态。）
   */
  it('★★★ 写入端归一化真实生效：喂裸字符串，state 里不得留下字符串', async () => {
    const r = await renderPanel(async () => ({ ok: true, order: [], statuses: {} }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.callbacks.length, '没有任何 useCallback 被记录 ⇒ 探针本身失效').toBeGreaterThan(0)

    const PROBE = '该 key 已存在，已为你定位到原有账号。'
    let exercised = 0
    for (const cb of r.callbacks) {
      if (typeof cb !== 'function') continue
      const before = writes.length
      try {
        // ⚠️ 回调签名各异：`setProbeNotice(next)` 只吃一个参数；别的一参数回调
        // 拿到字符串最多是不做事或抛错 —— 抛错不算失败（那是别的回调）。
        ;(cb as (arg: unknown) => unknown)(PROBE)
      } catch {
        continue
      }
      // 只看这次调用**新产生**的写入
      for (const w of writes.slice(before)) {
        if (w.value === PROBE) {
          exercised += 1
        }
      }
    }
    expect(
      exercised,
      `有回调把**裸字符串原样**写进 state（${exercised} 次）⇒ 渲染端读 .details.length 必然抛 TypeError（白屏事故）`,
    ).toBe(0)
  })

  /**
   * ★★ **渲染端读到的 notice 必须能安全取 `.details.length`**。
   *
   * 这条是事故那行的**等价复现**：`probeNotice.details.length`。
   * 只要写入端存过字符串、且渲染端没做保护，这里就会抛。
   */
  it('★★ 渲染端对 notice.details 的读取不得抛错（事故那一行）', async () => {
    const r = await renderPanel(async () => ({ ok: true, order: [], statuses: {} }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 模拟渲染端：把每个写入值当成 notice 读 `.details.length`。
    // 裸字符串 ⇒ `undefined.length` ⇒ TypeError（修复前正是如此）。
    for (const w of r.writes) {
      if (w.value === null || w.value === undefined) continue
      expect(
        () => (w.value as { details?: unknown[] }).details?.length,
        `state[${w.index}] 读 .details.length 会抛 ⇒ 整页白屏`,
      ).not.toThrow()
    }
  })
})

/**
 * ★★ **`incognitoOpened === true` 时必须先问用户**（2026-10-25 合并审计的 P1）。
 *
 * ## 缺陷（`!147` 引入）
 *
 * 2026-10-24 那版把「宿主已开无痕窗 ⇒ 客户端不再开」改成「无条件再开一个」，
 * 理由是修无头部署（宿主窗口画在 Xvfb 上、用户看不到）。但它**静默**放回了
 * codearts / officeace 的老缺陷：那两家授权页在华为云 SSO 域，**普通浏览器里的
 * 会话会被静默复用** ⇒ 用户点开我们自己开的窗口、授权、登进去的还是上一个号
 * （「新建账号还是同一个号」）。
 *
 * ## 判据
 *
 * 真渲染 `ProviderPanel`、真调用回调，观察 `window.open` 与 `window.confirm`：
 * - 用户**取消** ⇒ 不得再开（只剩宿主的无痕窗，登录仍可完成）；
 * - 用户**确认** ⇒ 必须开（无头部署的用户要靠它）。
 *
 * ⚠️ 两条都要测：只测「取消」会让「反正永远不开」也全绿（那会把无头部署的
 * 真实报障原样放回来）。
 */
describe('登录开窗：宿主开过无痕窗时的用户裁决策略', () => {
  /** ⚠️ 面板里**不止这一处** confirm（`runLimitAction` 等）⇒ 只认登录开窗那条文案。 */
  const LOGIN_CONFIRM_MARKER = '无痕窗口'
  const loginConfirms = (calls: unknown[][]): unknown[][] =>
    calls.filter(args => String(args[0] ?? '').includes(LOGIN_CONFIRM_MARKER))
  function withWindow<T>(impl: { confirm: (message: string) => boolean; open: (...args: unknown[]) => unknown }, fn: () => Promise<T>): Promise<T> {
    const host = globalThis as unknown as { window?: unknown; confirm?: unknown; alert?: unknown }
    const previousWindow = host.window
    const previousConfirm = host.confirm
    const previousAlert = host.alert
    host.window = impl
    // ⚠️ 客户端里既有 `window.confirm` 也有**裸 `confirm`**（`runLimitAction` 就是裸调用）——
    // 本环境没有 DOM ⇒ 裸调用会抛 ReferenceError 并变成 unhandled rejection（vitest 报错）。
    // 两个都垫上，测试才不会污染报告（也顺带覆盖那条「限流重测」路径的早退）。
    host.confirm = (message: string) => impl.confirm(message)
    host.alert = () => {}
    return fn().finally(() => {
      host.window = previousWindow
      host.confirm = previousConfirm
      host.alert = previousAlert
    })
  }

  async function driveCreateAccount(
    providerName: string,
    confirmAnswer: boolean,
  ): Promise<{ open: unknown[][]; confirm: unknown[][] }> {
    const open: unknown[][] = []
    const confirmCalls: unknown[][] = []
    const rpcCalls: string[] = []
    const rpcCall = async (method: string) => {
      rpcCalls.push(method)
      if (method === 'account.create') {
        return {
          ok: true,
          loginUrl: 'https://auth.huaweicloud.com/authui/login?state=AAA',
          incognitoOpened: true,
        }
      }
      return { ok: true, order: [], statuses: {} }
    }
    const r = await renderPanel(rpcCall, providerName)
    expect(r.ok, r.ok ? '' : `渲染抛错：${String((r as { error: unknown }).error)}`).toBe(true)
    if (!r.ok) return { open, confirm: confirmCalls }
    // 触发「新建账号」：它的 onClick 是**无参**回调。逐个喂 undefined，
    // 由 `rpcCall('account.create')` 是否被调到来判断探针有没有命中。
    const errors: string[] = []
    // 1) `createAccount` 是普通函数 ⇒ 从它被挂上的 onClick 里取。
    const clickHandlers: Array<(arg?: unknown) => unknown> = []
    for (const element of elements) {
      const props = element.props as { onClick?: unknown } | null | undefined
      if (typeof props?.onClick === 'function') clickHandlers.push(props.onClick as never)
    }
    await withWindow({
      confirm: (...args: unknown[]) => { confirmCalls.push(args); return confirmAnswer },
      open: (...args: unknown[]) => { open.push(args); return { closed: false } },
    }, async () => {
      for (const cb of [...clickHandlers]) {
        try { await cb(undefined) } catch (error) { errors.push(String(error)) }
      }
    })
    expect(rpcCalls, `探针没触发 account.create ⇒ 本用例无牙（回调抛错：${errors.join(' | ') || '无'}）`).toContain('account.create')
    return { open, confirm: confirmCalls }
  }

  it('★★ 用户取消 ⇒ 不再开普通窗口（否则静默复用旧 SSO 会话 = 老缺陷复发）', async () => {
    const seen = await driveCreateAccount('codearts', false)
    expect(loginConfirms(seen.confirm).length, '根本没用 confirm 问过用户 ⇒ 仍然是无条件再开').toBeGreaterThan(0)
    const openedLogin = seen.open.filter(args => String(args[0] ?? '').includes('authui'))
    expect(openedLogin, '用户已经拒绝，仍开了普通窗口 ⇒ codearts 的「新建账号还是同一个号」复发')
      .toEqual([])
  })

  it('★★ 用户确认 ⇒ 必须开（无头部署的用户只能靠它，别把 2026-10-24 的报障放回来）', async () => {
    const seen = await driveCreateAccount('codearts', true)
    expect(loginConfirms(seen.confirm).length, '根本没问过用户 ⇒ 策略没接上').toBeGreaterThan(0)
    const openedLogin = seen.open.filter(args => String(args[0] ?? '').includes('authui'))
    expect(openedLogin.length, '用户明确要求「在本机浏览器再开一个」，却没有开 ⇒ 无头部署下窗口根本不出现')
      .toBeGreaterThan(0)
  })

  it('★ 宿主没开无痕窗（incognitoOpened 缺省）⇒ 直接开，且**不得**多问一句', async () => {
    const open: unknown[][] = []
    const confirmCalls: unknown[][] = []
    const rpcCalls: string[] = []
    const rpcCall = async (method: string) => {
      rpcCalls.push(method)
      if (method === 'account.create') return { ok: true, loginUrl: 'https://auth.huaweicloud.com/authui/login?state=BBB' }
      return { ok: true, order: [], statuses: {} }
    }
    const r = await renderPanel(rpcCall, 'codearts')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const clickHandlers: Array<(arg?: unknown) => unknown> = []
    for (const element of elements) {
      const props = element.props as { onClick?: unknown } | null | undefined
      if (typeof props?.onClick === 'function') clickHandlers.push(props.onClick as never)
    }
    await withWindow({
      confirm: (...args: unknown[]) => { confirmCalls.push(args); return false },
      open: (...args: unknown[]) => { open.push(args); return { closed: false } },
    }, async () => {
      for (const cb of clickHandlers) { try { await cb(undefined) } catch { /* 其它回调 */ } }
    })
    expect(rpcCalls).toContain('account.create')
    // 老宿主不返回该字段 ⇒ 必须走回退分支：直接开，且**不问**（升级期不能多一次弹窗）
    expect(loginConfirms(confirmCalls), '宿主没开过无痕窗却弹了确认框 ⇒ 升级期体验倒退').toEqual([])
    expect(open.filter(args => String(args[0] ?? '').includes('authui')).length).toBeGreaterThan(0)
  })
})

/**
 * ★★ 「负载均衡」开关的 **zcode 门控**（2026-10-31 对抗审计 P2-2 补牙）。
 *
 * ## 为什么必须行为级
 *
 * `supportsSessionBalance = provider === 'zcode'`（jet-hub.js）被改成恒真时，
 * 既有 panel-wiring 全绿 ⇒ **所有 provider 面板**都会渲染一个摆设开关
 * （点击后 RPC 报 `unknown provider` 或对别家无效）。与「订阅额度只对 Cline
 * 渲染」同一门控取向，判据打在**渲染产物**上：真渲染各 provider 的面板，
 * 数「负载均衡」label 是否只在 zcode 出现。
 */
describe('负载均衡开关的 zcode 门控（仅 zcode 渲染）', () => {
  const PROVIDERS = ['codearts', 'buddy', 'qoder', 'zcode', 'opencode', 'aggregate'] as const

  it('真渲染：开关只在 zcode 面板出现（其余 provider 一个都不渲染）', async () => {
    const perProvider = new Map<string, number>()
    for (const provider of PROVIDERS) {
      const r = await renderPanel(async (method: string) => {
        if (method === 'sessionBalance.getEnabled') return { ok: true, value: { enabled: true } }
        return { ok: true, order: [], statuses: {} }
      }, provider)
      expect(r.ok, `${provider} 渲染抛错：${r.ok ? '' : String((r as { error: unknown }).error)}`).toBe(true)
      let count = 0
      for (const element of elements) {
        const props = element.props as { className?: unknown } | null | undefined
        if (props?.className === 'dim-jh-nativeSearch') count += 1
      }
      perProvider.set(provider, count)
    }
    expect(perProvider.get('zcode'), 'zcode 面板必须有负载均衡开关').toBeGreaterThan(0)
    const offenders = [...perProvider.entries()].filter(([p, n]) => p !== 'zcode' && n > 0)
    expect(
      offenders,
      `非 zcode 面板渲染了摆设开关（去 zcode 门控的变异形态）：${JSON.stringify(offenders)}`,
    ).toEqual([])
  })
})

/**
 * 「锁定永久积分」按钮的**端到端接线**（2026-11-01 二审收尾）。
 *
 * ## 为什么必须补这一条
 *
 * magicrew 两站刚接上这个能力，此前的验证止步于**静态核对**：
 * 「`jet-hub.js` 里 `rpcCall('credits.permanentLock', { provider })` 的 provider
 * 来自 props，三处调用点没有字面量」。但静态核对抓不到两类真实回归：
 * ① 按钮**根本没渲染**（`supportsPermanentLock` 的判据被改坏 ⇒ 用户看不见入口）；
 * ② 按钮渲染了但 `onClick` 没接（或接成了别的方法 ⇒ 点下去零请求、零提示）。
 * 这两类在源码文本上都是「字面量还在」，只有**真渲染 + 真调用**才测得动。
 *
 * ## 判据打在哪
 *
 * 1. 两站各自渲染出**一个** `aria-label` 含「永久积分」的 `button`；
 * 2. 真调用它的 `onClick` ⇒ `rpcCall` 收到 `credits.permanentLock`，
 *    且 `provider` 是**当前那站**（不是另一站、不是字面量）、`locked === true`
 *    （未锁定态点一次 = 上锁）；
 * 3. 对照：不支持该能力的 provider（`opencode`）**一个按钮都不许渲染**，
 *    且**零** `credits.permanentLock` 请求（对不支持的 provider 发会拿到
 *    `bad-request`，控制台留下必然失败的报错）。
 *
 * ⚠️ **挂载时的读请求不会干扰计数**：本文件的 `useEffect` 桩是空实现（`useEffect() {}`），
 * 所以 `credits.permanentLock` 的**读**分支不执行 —— 收到的每一次都是**点击**触发的写。
 * 若哪天把这个桩改成真执行 effect，本用例的计数会变成 2，届时**要改的是断言而不是实现**。
 */
describe('锁定永久积分按钮的接线（magicrew 两站真渲染）', () => {
  /** 拿本次渲染产物里那个「永久积分」按钮（没有则 `undefined`）。 */
  function lockButton(): { props: Record<string, unknown> } | undefined {
    return elements.find((element) => {
      if (element.type !== 'button') return false
      const props = element.props as Record<string, unknown> | null | undefined
      const label = props?.['aria-label']
      return typeof label === 'string' && label.includes('永久积分')
    }) as { props: Record<string, unknown> } | undefined
  }

  /** 渲染一个 provider 的面板，返回它收到的 RPC 调用（按顺序）。 */
  async function renderAndRecord(provider: string) {
    const calls: Array<{ method: string; payload?: unknown }> = []
    const rpcCall = async (method: string, payload?: unknown) => {
      calls.push({ method, payload })
      if (method === 'credits.permanentLock') {
        return { ok: true, provider, locked: true, windowDays: 15 }
      }
      return { ok: true, order: [], statuses: {} }
    }
    const result = await renderPanel(rpcCall, provider)
    expect(result.ok, `${provider} 渲染抛错：${result.ok ? '' : String((result as { error: unknown }).error)}`).toBe(true)
    return calls
  }

  for (const provider of ['magicrew', 'magicrewintl'] as const) {
    it(`★★ 真渲染 + 真点击「${provider}」⇒ 发 credits.permanentLock，provider 原样透传且 locked: true`, async () => {
      const calls = await renderAndRecord(provider)
      const button = lockButton()
      expect(button, `${provider} 面板没有渲染锁定按钮（supportsPermanentLock 判据被改坏？）`).toBeDefined()
      // 未锁定态 ⇒ 按钮表达的动作是「锁定」，且 title 是整句文案（按钮上只有四个字）
      expect(button?.props['aria-label']).toBe('锁定永久积分')
      expect(typeof button?.props.title).toBe('string')
      expect(button?.props.title).not.toBe('')

      const onClick = button?.props.onClick as (() => unknown) | undefined
      expect(typeof onClick, '按钮没有 onClick（渲染了但点不动）').toBe('function')
      await onClick?.()
      // `onClick` 是 `() => void togglePermanentLock()`（fire-and-forget）⇒ 等一拍让它跑完
      await new Promise((resolve) => setTimeout(resolve, 0))

      const writes = calls.filter((call) => call.method === 'credits.permanentLock')
      expect(writes, `点击后应恰好发一次 credits.permanentLock，实际 ${writes.length} 次`).toHaveLength(1)
      expect(writes[0]?.payload).toEqual({ provider, locked: true })
    })
  }

  it('★★ 对照：不支持该能力的 provider 一个按钮都不渲染，且零请求（门控真的在）', async () => {
    const calls = await renderAndRecord('opencode')
    expect(lockButton(), 'opencode 不该有锁定按钮（会拿到 bad-request）').toBeUndefined()
    expect(calls.filter((call) => call.method === 'credits.permanentLock')).toEqual([])
  })
})

/**
 * ★★「+ 新建账号」对**浏览器登录型 provider** 必须开自绘登录弹窗，不得直落
 * `account.create`（2026-11-03 PR #171 合并审计 P0）。
 *
 * ## 为什么必须行为级
 *
 * 原实现漏了 monkeycode / monkeycodeintl / baizhi 三条分支 ⇒ 点按钮直接
 * `account.create`，而 `new-account.js` 的载荷不带 `mode: 'browser'` ⇒ 宿主
 * 回 `unknown provider`。**0 账号时用户没有任何添加入口**，而
 * `monkeycode-client-wiring.spec.ts` 那一组 `toContain` 源码断言**全绿**
 * （红队实测：把分支改成 `...false ?` 仍 45 passed）。
 *
 * ## 判据
 *
 * 真渲染对应 provider 的面板 → 真点「新建账号」→
 * ① **零** `account.create`（走弹窗而不是通用创建）；
 * ② 有一次 state 写入，值是带 `provider` 与 `error` 的弹窗状态对象
 *    （即 `setCredentialModal({ provider, error: '' })`）。
 */
describe('「新建账号」对浏览器登录型 provider 开弹窗（P0 接线）', () => {
  function createButton(): { props: Record<string, unknown> } | undefined {
    return elements.find((element) => {
      if (element.type !== 'button') return false
      const props = element.props as Record<string, unknown> | null | undefined
      return props?.['aria-label'] === '新建账号'
    }) as { props: Record<string, unknown> } | undefined
  }

  for (const provider of ['monkeycode', 'monkeycodeintl', 'baizhi'] as const) {
    it(`★★ ${provider}：点「新建账号」⇒ 零 account.create + 写入登录弹窗状态`, async () => {
      const rpcCalls: string[] = []
      const r = await renderPanel(async (method: string) => {
        rpcCalls.push(method)
        return { ok: true, order: [], statuses: {}, accounts: [] }
      }, provider)
      expect(r.ok, r.ok ? '' : `渲染抛错：${String((r as { error: unknown }).error)}`).toBe(true)
      if (!r.ok) return
      const button = createButton()
      expect(button, `${provider} 面板没有「新建账号」按钮`).toBeDefined()
      const onClick = button?.props.onClick as (() => unknown) | undefined
      expect(typeof onClick, '按钮没有 onClick').toBe('function')
      await onClick?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(
        rpcCalls,
        `${provider} 直接发了 account.create（缺登录弹窗分支 ⇒ 宿主回 unknown provider）`,
      ).not.toContain('account.create')
      const modalWrite = r.writes.find((entry) => {
        const value = entry.value as { provider?: unknown, error?: unknown } | null | undefined
        return value !== null && typeof value === 'object'
          && value.provider === provider && typeof value.error === 'string'
      })
      expect(modalWrite, `${provider} 没有写入登录弹窗状态（用户看不到任何入口）`).toBeDefined()
    })
  }
})

/**
 * ★★ 账号卡片上的三家入口（`改 Key` / `补登录态`）—— **行为级**。
 *
 * 红队实测（2026-11-03）：`monkeycode-client-wiring.spec.ts` 全是
 * `clientSource.toContain(...)` 源码文本断言，把下列任一分支改成永假后
 * **45 / 34 条仍然全绿**：
 *
 * - `...MONKEYCODE_PROVIDER_IDS.includes(provider) ? { onEditMonkeycodeKey } : {}`
 * - `...provider === 'baizhi' ? { onEditBaizhiKey } : {}`
 * - `...provider === 'baizhi' ? { onReadSession } : {}`
 * - AccountCard 里 `onEditMonkeycodeKey ? createElement(...) : null`
 *
 * 这里真渲染面板（含一张账号卡）→ 真点按钮 → 断言弹窗状态 / RPC 调用。
 *
 * ⚠️ 面板的 `useEffect` 在本 harness 里是空实现，账号列表由 `loadAccounts`
 * 这个 `useCallback` 拉取 ⇒ 先渲染一次、手动跑一次捕获到的回调、再渲染第二次
 * （hook 槽位复用，state 保留），卡片才会出现。
 */
describe('账号卡片的三家入口（MonkeyCode / 百智云，行为级）', () => {
  const ACCOUNT = {
    id: 'monkeycode-abcd1234',
    provider: 'monkeycode',
    enabled: true,
    credentialRef: 'MONKEYCODE_ACCOUNT_ABCD1234',
    nickname: '尼',
    monkeycodeKeyMask: 'oma_…abcd',
    monkeycodeHasSession: true,
  }
  const BAIZHI_ACCOUNT = {
    id: 'baizhi-abcd1234',
    provider: 'baizhi',
    enabled: true,
    credentialRef: 'BAIZHI_ACCOUNT_ABCD1234',
    nickname: '尼',
    baizhiKeyMask: 'sk-…abcd',
    baizhiHasSession: true,
  }

  /** 渲染两次（跑一次 loadAccounts），返回收到的 RPC 调用。 */
  async function renderWithCards(
    provider: string,
    accounts: unknown[],
  ): Promise<Array<{ method: string, payload?: unknown }>> {
    const calls: Array<{ method: string, payload?: unknown }> = []
    const rpcCall = async (method: string, payload?: unknown) => {
      calls.push({ method, payload })
      if (method === 'account.list') return { ok: true, accounts, order: [], statuses: {} }
      if (method === 'credits.balances') return { ok: true, rows: [] }
      if (method === 'credits.status') return { ok: true, statuses: {} }
      if (method === 'credits.permanentLock') return { ok: true, locked: false }
      if (method === 'sessionBalance.getEnabled') return { ok: true, value: { enabled: false } }
      return { ok: true, order: [], statuses: {}, accounts }
    }
    resetRender()
    const mod = await import('../../plugin-src/client/jet-hub.js')
    const panel = (mod as unknown as { __providersPanelForTest?: (props: unknown) => unknown })
      .__providersPanelForTest
    expect(typeof panel).toBe('function')
    panel!({ provider, rpcCall })
    // 跑一次挂载期回调（loadAccounts 等）。无参回调；带参的调用会抛，吞掉即可。
    for (const cb of [...callbacks]) {
      try { await (cb as () => unknown)() } catch { /* 其它需要参数的接线 */ }
    }
    // 第二次渲染：复用 hook 槽位（state 里有账号了），光标归零。
    cursor = 0
    panel!({ provider, rpcCall })
    // ⚠️ 本 harness 的 createElement 只记录不渲染函数组件 ⇒ 手动执行 AccountCard，
    //    卡片内部（改 Key / 登录按钮）才会进入 elements。面板传下去的 props 原样
    //    使用 ⇒ 「props 门控被改坏」的变异仍然打不中。
    const cards = elements.filter((element) => typeof element.type === 'function'
      && (element.type as { name?: string }).name === 'AccountCard')
    for (const card of cards) (card.type as (props: unknown) => unknown)(card.props)
    return calls
  }

  function buttonByTitle(fragment: string): { props: Record<string, unknown> } | undefined {
    return elements.find((element) => {
      if (element.type !== 'button') return false
      const props = element.props as Record<string, unknown> | null | undefined
      const title = props?.title
      return typeof title === 'string' && title.includes(fragment)
    }) as { props: Record<string, unknown> } | undefined
  }

  it('★★ MonkeyCode：卡片渲染「改 Key」且点击写入编辑弹窗状态', async () => {
    await renderWithCards('monkeycode', [ACCOUNT])
    const button = buttonByTitle('API Key')
    expect(button, 'MonkeyCode 卡片没有「改 Key」按钮（props 门控被改坏？）').toBeDefined()
    const onClick = button?.props.onClick as (() => unknown) | undefined
    expect(typeof onClick).toBe('function')
    await onClick?.()
    const modal = writes.find((entry) => {
      const v = entry.value as { provider?: unknown, accountId?: unknown } | null | undefined
      return v !== null && typeof v === 'object'
        && v.provider === 'monkeycode' && v.accountId === ACCOUNT.id
    })
    expect(modal, '点了「改 Key」但没有写入 monkeycode 的编辑弹窗状态').toBeDefined()
  })

  it('★★ 百智云：卡片渲染「改 Key」且点击写入编辑弹窗状态', async () => {
    await renderWithCards('baizhi', [BAIZHI_ACCOUNT])
    const button = buttonByTitle('API Key')
    expect(button, '百智云卡片没有「改 Key」按钮').toBeDefined()
    const onClick = button?.props.onClick as (() => unknown) | undefined
    await onClick?.()
    const modal = writes.find((entry) => {
      const v = entry.value as { provider?: unknown, accountId?: unknown } | null | undefined
      return v !== null && typeof v === 'object'
        && v.provider === 'baizhi' && v.accountId === BAIZHI_ACCOUNT.id
    })
    expect(modal, '点了「改 Key」但没有写入 baizhi 的编辑弹窗状态').toBeDefined()
  })

  it('★★ 百智云：卡片渲染「重新登录」且点击真的发 baizhi.startSession', async () => {
    const calls = await renderWithCards('baizhi', [BAIZHI_ACCOUNT])
    const button = buttonByTitle('已读到网页登录态')
    expect(button, '百智云卡片没有「重新登录」按钮（onReadSession 没传下来？）').toBeDefined()
    const onClick = button?.props.onClick as (() => unknown) | undefined
    await onClick?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const start = calls.filter((c) => c.method === 'baizhi.startSession')
    expect(start, '点了「重新登录」但没有发 baizhi.startSession').toHaveLength(1)
    expect(start[0]?.payload).toEqual({ accountId: BAIZHI_ACCOUNT.id })
  })

  it('★ 对照：MonkeyCode 面板不得出现百智云的「登录」按钮', async () => {
    await renderWithCards('monkeycode', [ACCOUNT])
    expect(buttonByTitle('百智云控制台'), 'MonkeyCode 面板渲染了百智云专属按钮').toBeUndefined()
  })
})
