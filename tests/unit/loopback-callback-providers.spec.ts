import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 「手动回调链接」的**服务范围**与**两条通道**的行为级守卫（PR #8 审计返工）。
 *
 * ## 这个文件为什么必须存在
 *
 * PR #8 的全部用户价值就是一句话：**让 codearts / trae 之外的回环回调渠道也拿到
 * 那个粘贴框**（gemini / accio / astudio / autoclaw / autoclawintl / lobsterai）。
 *
 * 而合入时这条主张**零覆盖**：
 * - `tests/unit/login-submit-callback.spec.ts` 只测**服务端端点**（19 条，不碰客户端）；
 * - `tests/unit/jet-hub-panel-wiring.spec.ts` 里 7 条接线用例**全部固定**
 *   `provider = 'codearts'` 或 `'trae'`；
 * - `tests/unit/jet-hub-structure-ast.spec.ts` 只认「`showManualCallback ?` 这条子项存在」，
 *   判据是**标识符在不在**，不是**集合里有哪些 id**。
 *
 * ⇒ 把分发判据 `PROVIDERS_WITH_LOOPBACK_CALLBACK` 整体换回 `new Set(['codearts','trae'])`
 *   （= 回到 PR #8 之前的状态，六家渠道的功能**从产品里消失**），全套 13276 条用例
 *   **全绿**。这与本仓反复记录过的「接线层零守卫」是同一个坑（PR #57 / #58 各踩过一次）。
 *
 * ## 判据为什么必须是「真渲染 + 真点 + 真发 RPC」
 *
 * 三条可以想见的源码文本断言各有旁路：
 * - 断言「集合里有 8 个 id」—— `if (false) { }` 之外还能被 `.has(provider) ? … : …`
 *   的三元常量假分支骗过；
 * - 断言「`showManualCallback` 里引用了 `PROVIDERS_WITH_LOOPBACK_CALLBACK`」——
 *   集合内容换了它照样命中；
 * - 断言「`submitManualCallback` 里出现过 `login.submitCallback`」——
 *   两条通道合并成一条时字面量还在。
 *
 * ⇒ 只能走行为：**渲染某家的面板 → 真点「新建账号」→ 看有没有输入框**；
 *   **粘贴 → 真点「提交」→ 看发的是哪条 RPC、payload 长什么样**。
 */

/** hook 槽位：每次「渲染」重置，模拟一次组件挂载。 */
let hooks: unknown[] = []
let cursor = 0
/** 本次渲染期间被 `useState` setter 写过的值（按写入顺序）。 */
let writes: Array<{ index: number; value: unknown }> = []
/** 本次渲染期间传进 `useCallback` 的回调。 */
let callbacks: unknown[] = []
/** 本次渲染产出的 React 元素（只留 props）。 */
let elements: Array<{ type: unknown; props: unknown; children?: unknown[] }> = []

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
    // ⚠️ 组件读的是 `ref.current`，不是 `.v`。替身少写一个字段会让整条分支静默失效
    //（本仓踩过：`useRef(0)` 后 `++ref.current` = NaN ⇒ 所有序号闸门恒真）。
    const s = slot(initial) as { v: T; current?: T }
    if (!('current' in s)) s.current = s.v
    return s as unknown as { current: T }
  },
  useEffect() {},
  useLayoutEffect() {},
  useCallback<T>(fn: T): T {
    callbacks.push(fn)
    return fn
  },
  useMemo<T>(fn: () => T): T {
    return fn()
  },
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => {
    elements.push({ type, props, children }); return null
  },
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
  Component: class {},
}

vi.mock('react', () => reactStub)

type RenderResult = { ok: true } | { ok: false; error: unknown }

/** 渲染 `ProviderPanel` 一次（重置槽位 = 模拟一次挂载）。 */
async function mount(
  rpcCall: (method: string, payload?: unknown) => Promise<unknown>,
  provider: string,
): Promise<RenderResult> {
  hooks = []
  cursor = 0
  writes = []
  callbacks = []
  elements = []
  try {
    const mod = await import('../../plugin-src/client/jet-hub.js')
    expect(typeof mod.JetHubPage).toBe('function')
    const panel = (mod as unknown as { __providersPanelForTest?: (props: unknown) => unknown }).__providersPanelForTest
    if (typeof panel !== 'function') {
      // 逃生口未接线 ⇒ 明确失败，绝不静默跳过（否则整个文件变成集体假绿）。
      return { ok: false, error: new Error('__providersPanelForTest 未导出：接线层无法被行为级守卫覆盖') }
    }
    panel({ provider, rpcCall })
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

/** 同一次挂载内的重渲染（只清渲染产物，保留 hooks 槽位）。 */
async function rerender(
  rpcCall: (method: string, payload?: unknown) => Promise<unknown>,
  provider: string,
): Promise<void> {
  elements = []
  writes = []
  callbacks = []
  cursor = 0
  const mod = await import('../../plugin-src/client/jet-hub.js')
  const panel = (mod as unknown as { __providersPanelForTest?: (props: unknown) => unknown }).__providersPanelForTest
  if (typeof panel !== 'function') throw new Error('__providersPanelForTest 未导出')
  panel({ provider, rpcCall })
}

type Box = { type: unknown; props: Record<string, unknown> | null; children?: unknown[] }
const boxes = (): Box[] => elements as Box[]

/** 按 `aria-label` 找元素（「新建账号」按钮走这条）。 */
const byLabel = (label: string): Box | undefined =>
  boxes().find((e) => (e.props)?.['aria-label'] === label)

/**
 * 找「手动回调链接」输入框。
 *
 * 判据刻意**不用 placeholder 全文**（那样会把「输入框没了」和「文案改了」
 * 混成同一个红），而是「class 是 dim-jh-input **且** placeholder 提到 127.0.0.1」
 * —— 这个组合只可能是粘贴框（该面板里没有第二个带 127.0.0.1 提示的输入框）。
 */
const callbackInput = (): Box | undefined =>
  boxes().find((e) => {
    const props = e.props
    return props?.className === 'dim-jh-input'
      && typeof props?.placeholder === 'string'
      && props.placeholder.includes('127.0.0.1')
  })

/**
 * 按可见文字找按钮。
 *
 * ⚠️ 必须**同时**判 `type === 'button'`：只按 class + 文字找的话，把
 * `<button>` 换成 `<span className="dim-jh-btn">` 依旧命中，而这个替换是
 * **真实退化**（丢键盘可达性与 `role=button`，2026-11-13 变异实测 M6 全绿）。
 */
const buttonWithText = (needle: string): Box | undefined =>
  boxes().find((e) => {
    const props = e.props
    const text = (e.children ?? []).map((child) => String(child)).join('')
    return e.type === 'button' && props?.className === 'dim-jh-btn' && text.includes(needle)
  })

/**
 * 七家回环渠道的**真实回调路径**（逐个取自宿主源码）。
 *
 * ⚠️ 它们**不许**出现在 placeholder 里（PR #8 审计 P3）：原先只给 trae 一家写了
 * 专属提示，其余六家一律展示 `/oauth/callback?code=…`，用户照抄格式手拼就会
 * 拼出错路径。变异实测：把 placeholder 改回写死 `/oauth/callback?code=…`，
 * 若只看「提到 127.0.0.1」则**全绿**（M7）⇒ 必须逐条断言「不含具体路径」。
 */
const CONCRETE_CALLBACK_PATHS = [
  '/oauth/callback',
  '/oauth-callback',
  '/auth/callback-zai',
  '/auth/callback',
  '/authorize',
]

/** 临时装一个假 `window`（`window.open` 必须返回「已打开」否则面板会走手动链接分支）。 */
function withWindow<T>(fn: () => Promise<T>): Promise<T> {
  const host = globalThis as unknown as { window?: unknown; confirm?: unknown; alert?: unknown }
  const previousWindow = host.window
  const previousConfirm = host.confirm
  const previousAlert = host.alert
  host.window = { open: () => ({ closed: false }), location: { href: '' } }
  host.confirm = () => false
  host.alert = () => {}
  return fn().finally(() => {
    host.window = previousWindow
    host.confirm = previousConfirm
    host.alert = previousAlert
  })
}

/** 让链式 `await`（宿主往返 + 轮询起始）全部结算。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const intervals: Array<ReturnType<typeof setInterval>> = []
let realSetInterval: typeof globalThis.setInterval
beforeAll(() => {
  realSetInterval = globalThis.setInterval
  globalThis.setInterval = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    const id = realSetInterval(fn, ms, ...args)
    intervals.push(id)
    return id
  }) as typeof globalThis.setInterval
})
afterEach(() => {
  for (const id of intervals.splice(0)) clearInterval(id)
  vi.restoreAllMocks()
})
afterAll(() => {
  globalThis.setInterval = realSetInterval
})

interface RpcEntry { method: string; payload?: unknown }
type Rpc = (method: string, payload?: unknown) => Promise<unknown>

/**
 * 通用的 `rpcCall` 桩。
 *
 * ⚠️ `account.create` 必须返回 `{ ok: true, accountId, loginUrl }` —— 面板只有在
 * **拿到 accountId 之后**才会挂上粘贴框（`setManualCallback({ accountId, … })`），
 * 返回形状不对会让「输入框不出现」与「功能被删」同形（假红）。
 */
function makeRpc(calls: RpcEntry[], accountId = 'spec-acct-1'): Rpc {
  return async (method, payload) => {
    calls.push({ method, payload })
    if (method === 'account.create') {
      return {
        ok: true,
        accountId,
        loginUrl: 'https://example.invalid/authorize?state=AAA',
        incognitoOpened: true,
      }
    }
    return { ok: true, order: [], statuses: {}, enabled: false }
  }
}

/** 走到「输入框已出现」所需的三步：点新建账号 → 重渲染 → 等结算。 */
async function openPasteBox(
  rpcCall: Rpc, provider: string,
): Promise<void> {
  const button = byLabel('新建账号')
  expect(button, `${provider} 面板没有「新建账号」按钮`).toBeDefined()
  await withWindow(async () => {
    await ((button?.props)?.['onClick'] as (() => unknown) | undefined)?.()
    await flush()
  })
  // ⚠⚠ **两拍**：zcode / accio / astudio / autoclaw(+intl) 的「新建账号」先弹
  //     **接入预选窗**（登录渠道 / 区域 / 模式，见 `newAccountAsksChannel`），
  //     点掉弹窗的「确定并打开认证页」才真正发 `account.create`。
  //     只点第一拍的话，这五家的粘贴框永远不出现 —— 而**功能本身没问题**，
  //     红的是用例少走了一步（2026-11-13 实测：accio / autoclaw / autoclawintl 三条就是这个原因）。
  //
  // ⚠ 顺序不能反：**先重渲染**再看弹窗 —— 弹窗是 `setPendingLogin(false)` 之后
  //    才进 element 树的，在第一拍的旧 element 列表里永远找不到它。
  await rerender(rpcCall, provider)
  await flush()
  const confirmButton = buttonWithText('确定并')
  if (confirmButton !== undefined) {
    await withWindow(async () => {
      await ((confirmButton.props)?.['onClick'] as (() => unknown) | undefined)?.()
      await flush()
    })
    await rerender(rpcCall, provider)
    await flush()
  }
}

/** 往输入框写值并重渲染。 */
async function typeInto(rpcCall: Rpc, provider: string, value: string): Promise<void> {
  const input = callbackInput()
  const onChange = (input?.props)?.['onChange'] as ((event: unknown) => unknown) | undefined
  expect(typeof onChange, `${provider} 的输入框没有 onChange`).toBe('function')
  await (onChange as (event: unknown) => unknown)({ target: { value } })
  await rerender(rpcCall, provider)
  await flush()
}

/** 点「提交回调链接」并返回这次发出的全部 RPC。 */
async function submit(rpcCall: Rpc, provider: string): Promise<void> {
  const button = buttonWithText('提交回调链接')
  expect(button, `${provider} 没有「提交回调链接」按钮`).toBeDefined()
  await ((button?.props)?.['onClick'] as (() => unknown) | undefined)?.()
  await flush()
}

/**
 * 回环回调渠道 = 授权跳转落在 `http://127.0.0.1:<port>/…` 的那些。
 *
 * ⚠️ 这份清单**逐家对过宿主源码**（PR #8 审计）：
 * - `codearts` → `src/login.ts` 的 `startOAuthCallbackServer`（`REDIRECT_PATH` = `/oauth/callback`）；
 * - `gemini` → `src/gemini-oauth.ts` 的 `createServer`（`GEMINI_CALLBACK_PATH` = `/oauth-callback`）；
 * - `accio` → `src/accio-auth.ts`（`ACCIO_CALLBACK_PATH` = `/auth/callback`）；
 * - `lobsterai` → `src/lobsterai-oauth.ts`（`/auth/callback`）；
 * - `autoclaw` / `autoclawintl` → `src/autoclaw-oauth.ts`（`/auth/callback-zai`）；
 * - `trae` → `src/trae-oauth.ts`（`/authorize`）。
 */
/**
 * 真的开了 **OAuth 回调端口**的 6 家。
 *
 * ⚠️ PR #8 审计 P1-2（2026-11-13 实测）把集合从 8 家收窄到 6 家 ——
 * `astudio` 与国内 `autoclaw` 都**没有可落定的 OAuth 回调**（见下方
 * `NO_CALLBACK_PROVIDERS` 的理由），留着它们会让用户粘一条只能拿到 404 的地址。
 */
const LOOPBACK_CALLBACK_PROVIDERS = [
  'codearts',
  'lobsterai',
  'trae',
  'gemini',
  'accio',
  'autoclawintl',
] as const

/**
 * **不**该有粘贴框的渠道（每一家都给一句「为什么没有地址可粘」）。
 *
 * ⚠️ 这条反向清单是判据的另一半：只测「该有的有」挡不住「把设备码渠道也塞进来」
 *（多渲染一格会让用户去找一条不存在的地址）。
 */
const NO_CALLBACK_PROVIDERS: Array<{ id: string; why: string }> = [
  { id: 'qoder', why: '设备码 / 轮询式登录，没有浏览器回调' },
  { id: 'zcode', why: '设备码 / 轮询式登录，没有浏览器回调' },
  { id: 'minimax', why: '设备码登录（`src/minimax-oauth.ts`）' },
  { id: 'raccoon', why: '本机载体页 + 上游轮询（`src/raccoon-login-page.ts`）' },
  { id: 'cline', why: '设备码登录（`src/cline-oauth.ts`）' },
  // ⚠ astudio 是**最容易误收**的一家（它确实 `listenOnRandomPort`）：
  //    但它开的是**登录载体页**，`ASTUDIO_CARRIER_PATHS` 里没有任何 OAuth 回调路径，
  //    登录结果由 `/astudio/poll` 的页面轮询交付 ⇒ 没有可粘贴的回调地址。
  { id: 'astudio', why: '本机载体页 + `/astudio/poll` 页面轮询，没有 OAuth 回调路径（`src/astudio-oauth.ts`）' },
  // ⚠ 国内 `autoclaw` 与 `autoclawintl` **必须分开**（PR #8 审计 P1-2）：
  //    客户端 `autoclawSmsAvailable = provider === 'autoclaw'`（短信 + 一键导入本机凭据）、
  //    `autoclawZaiAvailable = provider === 'autoclawintl'`（Z.ai OAuth）；
  //    而 `src/autoclaw-oauth.ts:1386` 的回调处理器又用
  //    `product.id !== AUTOCLAW_INTL.id` 把 Z.ai 回调**限死为仅国际版**。
  //    ⇒ 国内版粘任何地址都只会拿到 404（旧实现还会把它包成 ok:true = 假成功）。
  { id: 'autoclaw', why: '只有短信 + 一键导入本机凭据；Z.ai 回调被 `src/autoclaw-oauth.ts` 门控为仅国际版' },
]

describe('「手动回调链接」的服务范围（PR #8）：该有的必须有', () => {
  it.each(LOOPBACK_CALLBACK_PROVIDERS)('★★ %s 点「新建账号」后必须出现粘贴框', async (provider) => {
    const calls: RpcEntry[] = []
    const rpcCall = makeRpc(calls)
    const r = await mount(rpcCall, provider)
    expect(r.ok, r.ok ? '' : `渲染抛错：${String((r as { error: unknown }).error)}`).toBe(true)

    await openPasteBox(rpcCall, provider)

    const input = callbackInput()
    expect(
      input,
      `${provider} 点「新建账号」后没有出现手动回调链接输入框：`
        + 'PROVIDERS_WITH_LOOPBACK_CALLBACK 里少了它，或 showManualCallback 的判据被改坏了',
    ).toBeDefined()
    // 反向钉子：粘贴框必须有「提交」按钮，否则输入框只是个摆设。
    expect(buttonWithText('提交回调链接'), `${provider} 的粘贴框没有提交按钮`).toBeDefined()
    // 反向钉子：提示语**不许写死具体回调路径**（七家路径各不相同，照抄必错）。
    const hint = input?.props?.placeholder
    expect(typeof hint, `${provider} 的输入框没有 placeholder 提示`).toBe('string')
    for (const path of CONCRETE_CALLBACK_PATHS) {
      expect(
        String(hint).includes(path),
        `${provider} 的提示语写死了回调路径 ${path}：七家路径各不相同，`
          + '照抄它会拼出错地址（应只说「地址栏里的完整地址，原样粘贴」）',
      ).toBe(false)
    }
  })
})

describe('「手动回调链接」的服务范围（PR #8）：不该有的必须没有', () => {
  it.each(NO_CALLBACK_PROVIDERS)('★★ $id 不得出现粘贴框（$why）', async ({ id }) => {
    const calls: RpcEntry[] = []
    const rpcCall = makeRpc(calls)
    const r = await mount(rpcCall, id)
    expect(r.ok, r.ok ? '' : `渲染抛错：${String((r as { error: unknown }).error)}`).toBe(true)

    await openPasteBox(rpcCall, id)

    expect(
      callbackInput(),
      `${id} 没有浏览器回调地址可粘（见用例标题），却渲染了粘贴框 —— `
        + 'PROVIDERS_WITH_LOOPBACK_CALLBACK 里多了它，用户会去找一条不存在的地址',
    ).toBeUndefined()
  })
})

describe('「手动回调链接」的两条通道（PR #8）：不许合并', () => {
  /**
   * ★★★ 六家新渠道走的是**盲发 GET**（`login.submitCallback`），不是
   * `account.submitCallback`（后者要求宿主侧已登记专用解析器，只有 codearts / trae 有）。
   *
   * 变异实测：把 `submitManualCallback` 里两条通道合并成只发 `account.submitCallback`
   * ⇒ gemini 提交会撞上「这轮登录已经结束或不在本进程内」⇒ **粘贴框对六家永久失效**。
   */
  it('★★★ gemini 提交必须走 login.submitCallback，且不发 account.submitCallback', async () => {
    const calls: RpcEntry[] = []
    const rpcCall = makeRpc(calls, 'gemini-spec-1')
    const r = await mount(rpcCall, 'gemini')
    expect(r.ok).toBe(true)

    await openPasteBox(rpcCall, 'gemini')
    const url = 'http://127.0.0.1:42813/oauth-callback?code=4/abc&state=XYZ'
    await typeInto(rpcCall, 'gemini', url)
    await submit(rpcCall, 'gemini')

    const viaLogin = calls.filter((entry) => entry.method === 'login.submitCallback')
    expect(
      viaLogin,
      'gemini 的「提交回调链接」没有发出 login.submitCallback ⇒ 六家新渠道的功能不存在',
    ).toHaveLength(1)
    expect(viaLogin[0]?.payload).toEqual({ url })
    // 反向钉子：不许顺手也发专用通道（那条对 gemini 必然失败）。
    expect(
      calls.filter((entry) => entry.method === 'account.submitCallback'),
      'gemini 不该发 account.submitCallback（宿主只给 codearts / trae 登记了解析器）',
    ).toHaveLength(0)
  })

  /**
   * ★★★ 反向：codearts 必须走**专用解析**通道（能给出「回调未携带 refreshToken」
   * 这类精确原因），不许被合并到盲发 GET —— 合并会丢掉全部精确文案。
   */
  it('★★★ codearts 提交必须走 account.submitCallback，且不发 login.submitCallback', async () => {
    const calls: RpcEntry[] = []
    const rpcCall = makeRpc(calls, 'codearts-spec-1')
    const r = await mount(rpcCall, 'codearts')
    expect(r.ok).toBe(true)

    await openPasteBox(rpcCall, 'codearts')
    const url = 'http://127.0.0.1:42814/oauth/callback?code=abc&state=XYZ'
    await typeInto(rpcCall, 'codearts', url)
    await submit(rpcCall, 'codearts')

    const viaAccount = calls.filter((entry) => entry.method === 'account.submitCallback')
    expect(viaAccount, 'codearts 的「提交回调链接」没有发出 account.submitCallback').toHaveLength(1)
    expect(viaAccount[0]?.payload).toEqual({ accountId: 'codearts-spec-1', callbackUrl: url })
    expect(
      calls.filter((entry) => entry.method === 'login.submitCallback'),
      'codearts 不该发 login.submitCallback（会丢掉宿主专用解析器的精确文案）',
    ).toHaveLength(0)
  })
})
