/**
 * 豆包 provider 的**浏览器探测**与**登录按钮点击**（Gitee issue IKV5HC）。
 *
 * ## 缺陷原文（报障人，macOS 14 Apple Silicon + Chrome 已安装）
 *
 * > 点「+ 新建账号」/「重新读取」报
 * > `登录失败：豆包登录需要本机有 Chromium 内核浏览器（Chrome / 豆包客户端），未找到可执行文件。`
 *
 * ## 三处根因（本文件逐条钉住）
 *
 * 1. `doubaoLoginBrowserExecutable()` 的候选链**全是 Windows 路径** ⇒ macOS /
 *    Linux 上一条都不存在 ⇒ `undefined`；
 * 2. `doubaoSigninBrowserExecutable()` 同一份链 ⇒ 签到入口同样失败
 *    （**两个函数必须一起修**：只修登录会变成「扫码能进、签到照样报错」）；
 * 3. `clickLoginButton()` 用 `loginEl.click()`，而豆包登录按钮的处理器挂在
 *    `pointerdown` / `mousedown` 上（`HTMLElement.click()` 只发 `click`）
 *    ⇒ 自动点击形同虚设。
 *
 * ## ⚠️ 为什么必须注入 `exists` / `platform`
 *
 * 本仓库的开发机与 CI 都是 **Windows**。不注入的话：
 *
 * - `platform === 'darwin'` 那条分支**永远走不到**（结构上不可测 ⇒ 会静默烂掉，
 *   这正是 IKJKNT 的教训，`chromium-session.ts` 的 `browserCandidates` 因此
 *   早就加了口子）；
 * - 而「什么都没找到」那一格在本机上**恒为假**（本机真装了 Chrome）⇒ 想测
 *   「兜底也失败」只能注入。
 *
 * @module tests/unit/doubao-browser-discovery
 */

import { describe, expect, it, vi } from 'vitest'
import { browserCandidates } from '../../src/chromium-session.js'
import {
  clickDoubaoLoginButton,
  doubaoLoginBrowserExecutable,
  doubaoLoginBrowserHint,
  type DoubaoClickCdp,
} from '../../src/doubao-login.js'
import { doubaoSigninBrowserExecutable, doubaoSigninBrowserHint } from '../../src/doubao-signin.js'

/** macOS 上 `findBrowserExecutable()` 真的会解析到的路径（`MAC_BROWSER_BUNDLES` 首项）。 */
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** 两个函数都必须过的同一组判据（`[名字, 被测函数]`）。 */
const DISCOVERY: ReadonlyArray<readonly [name: string, resolve: typeof doubaoLoginBrowserExecutable]> = [
  ['登录（doubaoLoginBrowserExecutable）', doubaoLoginBrowserExecutable],
  ['签到（doubaoSigninBrowserExecutable）', doubaoSigninBrowserExecutable],
]

describe('★ 豆包浏览器探测：候选链必须兜到跨平台发现（IKV5HC）', () => {
  it.each(DISCOVERY)('%s：macOS 上必须解析到 .app 包里的 Chrome，而不是 undefined', (_name, resolve) => {
    const executable = resolve({
      platform: 'darwin',
      env: {},
      home: '/Users/jet',
      exists: (path) => path === MAC_CHROME,
    })

    expect(executable, 'macOS 上必须找到浏览器 —— 修复前这里恒为 undefined').toBe(MAC_CHROME)
    /**
     * ⚠️ 必须**一个反斜杠都没有**：macOS 的包内二进制是
     * `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，
     * 用 `path.join` 在 Windows 上拼会得到 `/Applications\Google Chrome.app\…`
     * —— 那是 Issue IKJKNT 的成因之一（`macBrowserCandidates` 因此用 `posix.join`）。
     */
    expect(executable).not.toContain('\\')
  })

  it.each(DISCOVERY)('%s：Linux 上同样必须兜到（PATH / AppStream 解析）', (_name, resolve) => {
    const linuxChrome = '/usr/bin/google-chrome'
    const executable = resolve({
      platform: 'linux',
      env: {},
      home: '/home/jet',
      exists: (path) => path === linuxChrome,
    })

    expect(executable).toBe(linuxChrome)
  })

  it.each(DISCOVERY)('%s：Windows 存量候选链**逐字节不变**（本项目自己的路径仍最优先）', (_name, resolve) => {
    const legacy = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    const executable = resolve({
      platform: 'win32',
      env: {},
      home: 'C:\\Users\\jet',
      exists: (path) => path === legacy || path === MAC_CHROME,
    })

    // 两条都存在时也必须返回 **legacy** —— 老用户的解析结果不能因为本次修复而漂移。
    expect(executable).toBe(legacy)
  })

  it.each(DISCOVERY)('%s：`DSH_DOUBAO_BROWSER_PATH` 仍是最优先的显式覆盖', (_name, resolve) => {
    const override = 'D:\\tools\\chrome.exe'
    const executable = resolve({
      platform: 'win32',
      env: { DSH_DOUBAO_BROWSER_PATH: override },
      home: 'C:\\Users\\jet',
      exists: (path) => path === override || path === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    })

    expect(executable).toBe(override)
  })

  it.each(DISCOVERY)('%s：一条都不存在时仍返回 undefined（错误文案的契约不变）', (_name, resolve) => {
    const executable = resolve({
      platform: 'darwin',
      env: {},
      home: '/Users/jet',
      exists: () => false,
    })

    expect(executable, '真没有浏览器时仍要返回 undefined —— 调用方据此抛「未找到可执行文件」').toBeUndefined()
  })

  it('★★ 真实 macOS 候选链：首项就是 Chrome 的包内二进制（不注入 exists 也能断言）', () => {
    const candidates = browserCandidates({ platform: 'darwin', env: {}, home: '/Users/jet' })

    expect(candidates[0], 'MAC_BROWSER_BUNDLES 首项 = Google Chrome').toBe(MAC_CHROME)
    // 全部候选都必须是绝对路径且无反斜杠（`findBrowserExecutable` 会滤掉相对的）。
    for (const candidate of candidates) {
      expect(candidate.startsWith('/'), `${candidate} 必须是绝对路径`).toBe(true)
      expect(candidate).not.toContain('\\')
    }
  })

  it('⚠️ 反向对照：Windows 候选链**不含** macOS 的 .app 路径（别把两套口径搅在一起）', () => {
    const candidates = browserCandidates({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\jet\\AppData\\Local' },
      home: 'C:\\Users\\jet',
    })

    expect(candidates.some((candidate) => candidate.includes('.app'))).toBe(false)
    expect(candidates.some((candidate) => candidate.includes('chrome.exe'))).toBe(true)
  })
})

// ── 登录按钮点击 ──

interface CdpCall {
  method: string
  params: Record<string, unknown>
  /**
   * ⚠️⚠️ **必须记录第三个实参**。第一版替身写的是 `send(method, params)` ——
   * `sessionId` 被**静默吞掉**，于是「事件打到页面会话上」这条判据根本没有观察面：
   * 把三处 `}, sessionId)` 全改成 `})`（= 发到浏览器级、没人接）依然 **15 passed 全绿**。
   * 这是本仓「替身少一个字段 ⇒ 整条分支静默失效」的又一例（同 client-ui 笔记的
   * `useRef` 只写 `cur` 不写 `current`）。
   */
  sessionId?: string
}

/**
 * 造一个**可编程**的假 CDP 通道。
 *
 * `evaluate` 依次返回 `values` 里的值（模拟「第一次求值拿坐标、第二次求值派发合成事件」）；
 * 其余方法只记录调用。返回 `{ cdp, calls }`。
 */
function makeCdp(values: unknown[]): { cdp: DoubaoClickCdp; calls: CdpCall[] } {
  const calls: CdpCall[] = []
  const queue = [...values]
  const cdp: DoubaoClickCdp = {
    async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
      calls.push({ method, params, sessionId })
      if (method === 'Runtime.evaluate') {
        const value = queue.shift()
        return { result: { value } }
      }
      return {}
    },
  }
  return { cdp, calls }
}

/**
 * ★★★ 把合成事件那段**页面脚本真的跑一遍**，记录 `dispatchEvent` 的实参顺序。
 *
 * 为什么必须这么做：合成事件是**一整段交给 CDP `Runtime.evaluate` 的字符串**，
 * 用例拿到的只是文本。原先这里用 `expression.indexOf(name)` 比下标，于是四个
 * bypass **全绿**（对抗审计实测）：
 *   ① 五个 `dispatchEvent` 各包一层 `if (false)` ⇒ 一个都不派发，文本照样在；
 *   ② 事件名只写在注释里 ⇒ `indexOf` 命中注释；
 *   ③ 源码顺序对、执行时用 `[4,3,2,1,0]` 反索引 ⇒ 实际倒序；
 *   ④ 五个字面量塞进一个**没人用**的对象 ⇒ 文本有、执行没有。
 * 而且合法重构（把序列搬进 helper）会让文本断言**假红**。
 *
 * 这里的做法是构造最小 `document` / `PointerEvent` / `MouseEvent` 替身，
 * 用 `new Function` 把**原文**执行一次并记录实参 —— 上面四个 bypass 全部变红，
 * 而「搬 helper 但顺序不变」保持绿。文本断言永远替代不了「跑一遍」。
 */
function runSyntheticScript(expression: string): string[] {
  const seen: string[] = []
  const loginEl = {
    textContent: '登录',
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 40 }),
    contains: () => false,
    dispatchEvent: (event: { kind: string }): boolean => {
      seen.push(event.kind)
      return true
    },
  }
  const document = { querySelectorAll: () => [loginEl] }
  class FakePointerEvent { readonly kind: string; constructor(type: string) { this.kind = `pointer:${type}` } }
  class FakeMouseEvent { readonly kind: string; constructor(type: string) { this.kind = type } }
  // eslint-disable-next-line no-new-func -- 被测对象**就是**一段字符串脚本
  const run = new Function('document', 'PointerEvent', 'MouseEvent', `return ${expression}`) as (
    doc: unknown, pe: unknown, me: unknown,
  ) => unknown
  run(document, FakePointerEvent, FakeMouseEvent)
  return seen
}

describe('★★★ 登录按钮点击：必须派发真鼠标事件（IKV5HC 第三条）', () => {
  it('★★★ 拿得到坐标 ⇒ 用 `Input.dispatchMouseEvent` 发 mousePressed + mouseReleased（受信任事件）', async () => {
    const { cdp, calls } = makeCdp([{ x: 100, y: 200 }])
    const log = vi.fn()

    const outcome = await clickDoubaoLoginButton(cdp, 'S1', log)

    expect(outcome).toBe('trusted')
    const dispatches = calls.filter((call) => call.method === 'Input.dispatchMouseEvent')
    /**
     * ⚠️ 修复前这里是 `loginEl.click()` —— **一条 dispatchMouseEvent 都没有**。
     * 只断言「没抛错」的话，旧实现照样绿（本仓「假绿」常客）⇒ 必须数调用。
     */
    expect(dispatches, '必须有两次鼠标事件（按下 + 抬起）').toHaveLength(2)
    expect(dispatches[0].params).toMatchObject({ type: 'mousePressed', x: 100, y: 200, button: 'left', buttons: 1, clickCount: 1 })
    expect(dispatches[1].params).toMatchObject({ type: 'mouseReleased', x: 100, y: 200, button: 'left', buttons: 0, clickCount: 1 })
    /**
     * ⚠️⚠️ 事件必须打到**页面会话**上 —— 不带 `sessionId` 时 `Input.dispatchMouseEvent`
     * 发到**浏览器级**，页面里没人接，点了个寂寞。
     *
     * 第一版这里只有下面那行 `expect(log)`（它只证明我们走到了 trusted 分支），
     * 于是一个「把三处 `}, sessionId)` 全删掉」的变异**全绿** —— 判据自己没牙。
     */
    expect(dispatches.map((call) => call.sessionId), '鼠标事件必须带页面 sessionId').toEqual(['S1', 'S1'])
    expect(calls[0].sessionId, '定位按钮的那次求值也必须带 sessionId').toBe('S1')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('受信任'))
  })

  it('★★ 按钮存在但盒子是 0×0 ⇒ 退化成合成事件序列（五个事件，顺序固定）', async () => {
    const { cdp, calls } = makeCdp(['no-box', true])

    const outcome = await clickDoubaoLoginButton(cdp, 'S1')

    expect(outcome).toBe('synthetic')
    // 拿不到坐标时**不许**发鼠标事件（坐标是 0,0 会点到左上角）。
    expect(calls.some((call) => call.method === 'Input.dispatchMouseEvent')).toBe(false)
    const script = calls.filter((call) => call.method === 'Runtime.evaluate')[1]?.params.expression
    expect(typeof script).toBe('string')
    const expression = String(script)
    /**
     * ⚠️ 这五个事件缺一不可：`click()` 只发最后一个，而豆包的处理器挂在
     * `pointerdown` / `mousedown` 上 —— **少发一个就回到缺陷原形**。
     *
     * ⚠️⚠️ 判据是**把脚本真跑一遍**看实际派发顺序，不是比文本下标 ——
     * 文本下标能被「包 `if (false)`」「写进注释」「反索引」「塞进死对象」四种方式
     * 绕过（对抗审计实测四个 bypass 全绿），也可能被合法重构弄成假红。
     */
    expect(runSyntheticScript(expression), '五个事件必须按 pointerdown → mousedown → pointerup → mouseup → click 实际派发').toEqual([
      'pointer:pointerdown', 'mousedown', 'pointer:pointerup', 'mouseup', 'click',
    ])
    /**
     * ⚠️⚠️ 只断言事件**名字**不够：把 `new PointerEvent('pointerdown', …)` 改成
     * `new MouseEvent('pointerdown', …)` 后字符串照样在、用例全绿 —— 而豆包的处理器
     * 就是按 `pointerdown` + `event.pointerType` 工作的（`MouseEvent` 没有 `pointerType`）。
     * 所以必须断言**构造器**。这一格是审计抓出来的真无牙。
     */
    expect(expression, '按下/抬起必须是真 PointerEvent').toContain("new PointerEvent('pointerdown'")
    expect(expression).toContain("new PointerEvent('pointerup'")
  })

  it('★★ 按钮压根没找到 ⇒ `not-found`，且**不**再发第二段求值（别对着空气派发事件）', async () => {
    const { cdp, calls } = makeCdp(['not-found'])
    const log = vi.fn()

    const outcome = await clickDoubaoLoginButton(cdp, 'S1', log)

    expect(outcome).toBe('not-found')
    expect(calls.filter((call) => call.method === 'Runtime.evaluate')).toHaveLength(1)
    expect(calls.some((call) => call.method === 'Input.dispatchMouseEvent')).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('没找到'))
  })

  it('★★★ 坐标是 `NaN` / `Infinity` ⇒ 不许当受信任点击（`typeof` 判据挡不住）', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { cdp, calls } = makeCdp([{ x: bad, y: 200 }, true])

      const outcome = await clickDoubaoLoginButton(cdp, 'S1')

      expect(outcome, `${String(bad)} 不是可点的坐标`).toBe('synthetic')
      expect(calls.some((call) => call.method === 'Input.dispatchMouseEvent')).toBe(false)
    }
  })

  it('★★★ 派发合成事件时按钮已消失 ⇒ 不许报 `synthetic`（否则是"点了但什么都没发生"的假成功）', async () => {
    const { cdp } = makeCdp(['no-box', false])
    const log = vi.fn()

    const outcome = await clickDoubaoLoginButton(cdp, 'S1', log)

    expect(outcome).toBe('not-found')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('已消失'))
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('已用合成事件序列点击'))
  })
})

// ── 找不到浏览器时的提示文案 ──

describe('★ 找不到浏览器时的提示：必须分平台说人话 + 点名环境变量（IKJKNT 同型）', () => {
  it('★★★ macOS 上必须提 `/Applications` 与 `DSH_DOUBAO_BROWSER_PATH`，且**不许**再出现 `chrome.exe`', () => {
    const hint = doubaoLoginBrowserHint({ platform: 'darwin', env: {}, home: '/Users/jet' })

    expect(hint).toContain('/Applications')
    expect(hint).toContain('DSH_DOUBAO_BROWSER_PATH')
    /**
     * ⚠️⚠️ 这正是 Issue IKJKNT 的形态：修复前那句统一写「可用 ZCODE_CHROME_PATH
     * 指定 **chrome.exe** 路径」，而 macOS 上根本没有 `chrome.exe` 这个名字 ——
     * 用户照着提示做只会更懵。豆包这次抽了共享文案，**这条断言就是防回退的那一格**。
     */
    expect(hint).not.toContain('chrome.exe')
  })

  it('★★★ Windows 上必须提 `chrome.exe`（与 macOS 的文案必须**不同**）', () => {
    const hint = doubaoLoginBrowserHint({ platform: 'win32', env: {}, home: 'C:\\Users\\jet' })

    expect(hint).toContain('chrome.exe')
    expect(hint).not.toContain('/Applications')
  })

  it('★★ 提示里必须回显 `DSH_DOUBAO_BROWSER_PATH` 在**本进程**里的值（用户最常见的死循环）', () => {
    const unset = doubaoLoginBrowserHint({ platform: 'darwin', env: {}, home: '/Users/jet' })
    expect(unset).toContain('（未设置）')

    const set = doubaoLoginBrowserHint({
      platform: 'darwin',
      env: { DSH_DOUBAO_BROWSER_PATH: '/opt/chrome' },
      home: '/Users/jet',
    })
    expect(set).toContain('/opt/chrome')
  })

  it('★★ 签到那边的提示同款（两个入口不能一个说人话、一个不说）', () => {
    const hint = doubaoSigninBrowserHint({ platform: 'darwin', env: {}, home: '/Users/jet' })

    expect(hint).toContain('/Applications')
    expect(hint).toContain('DSH_DOUBAO_BROWSER_PATH')
    expect(hint).not.toContain('chrome.exe')
  })
})

describe('★★ 环境变量覆盖必须**优先于**跨平台兜底', () => {
  it('★★★ 覆盖值与兜底浏览器同时存在 ⇒ 必须选覆盖值', () => {
    const OVERRIDE = 'D:\\tools\\chrome.exe'
    const FALLBACK = 'C:\\Users\\jet\\scoop\\apps\\chromium\\current\\chrome.exe'
    const found = doubaoLoginBrowserExecutable({
      platform: 'win32',
      env: { DSH_DOUBAO_BROWSER_PATH: OVERRIDE },
      home: 'C:\\Users\\jet',
      exists: (p) => p === OVERRIDE || p === FALLBACK,
    })
    /**
     * ⚠️ 只测「覆盖值存在时返回它」会被「把兜底搬到链首」的变异蒙过 ——
     * 那种情况下两条 exists 都真、返回的是兜底那个。必须让**两者都存在**。
     */
    expect(found).toBe(OVERRIDE)
  })
})

// ── 遮挡 / 视口外（P2-1）──

describe('★★★ 登录按钮被浮层遮挡或在视口外 ⇒ 不许报 `trusted`（假成功）', () => {
  it('★★★ `elementFromPoint` 命中别人 ⇒ 退回合成事件序列，并说清原因', async () => {
    const { cdp, calls } = makeCdp(['covered', true])
    const log = vi.fn()

    const outcome = await clickDoubaoLoginButton(cdp, 'S1', log)

    /**
     * ⚠️ 受信任点击打在**坐标**上：被引导浮层盖住时才点得到按钮，于是
     * `dispatchMouseEvent` 会落到浮层上，按钮自己**一个事件都收不到**，
     * 而旧代码照样 `return 'trusted'` ⇒ 用户看到「已点击」但二维码没弹（假成功）。
     * 合成事件是 `dispatchEvent` 到元素本身，能绕过遮挡 ⇒ 退回它才对。
     */
    expect(outcome).toBe('synthetic')
    expect(calls.some((call) => call.method === 'Input.dispatchMouseEvent')).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('遮挡'))
    // 遮挡判据必须**真的**在页面里算（不能靠 TS 侧猜）
    const expression = String(calls[0].params.expression)
    expect(expression).toContain('elementFromPoint')
  })
})

// ── 相对路径必须被拒绝（P3-6）──

describe('★★ 候选链只认绝对路径（否则 `existsSync` 相对 CWD 命中）', () => {
  const REL = 'audit-rel-chrome.exe'

  it('★★★ `DSH_DOUBAO_BROWSER_PATH` 是相对路径 ⇒ 登录侧**忽略**它', () => {
    // 共享腿 `browserCandidates` 本来就按绝对路径过滤，项目腿不跟上就会两边分叉
    const found = doubaoLoginBrowserExecutable({
      platform: 'win32',
      env: { DSH_DOUBAO_BROWSER_PATH: REL },
      home: 'C:\\Users\\jet',
      exists: (p) => p === REL,
    })
    expect(found).not.toBe(REL)
  })

  /**
   * ⚠️ `trim()` 不是洁癖：用户在面板里粘路径时很容易带上空格
   * （`DSH_DOUBAO_BROWSER_PATH=" /opt/my-chrome "`）。不做 trim 的话
   * `isAbsolute(' /opt/my-chrome ')` 判 false ⇒ 变量白设，而提示里还会回显
   * 「看到的值 = ' /opt/my-chrome '」—— 用户以为配对了、实际没生效。
   */
  it('★★★ 环境变量两侧带空格 ⇒ 先 trim 再用（否则 `isAbsolute` 判 false、变量白设）', () => {
    const found = doubaoLoginBrowserExecutable({
      platform: 'darwin',
      env: { DSH_DOUBAO_BROWSER_PATH: '  /opt/my-chrome  ' },
      home: '/Users/jet',
      exists: (candidate) => candidate === '/opt/my-chrome',
    })

    expect(found).toBe('/opt/my-chrome')
  })

  it('★★★ 签到侧同款', () => {
    const found = doubaoSigninBrowserExecutable({
      platform: 'win32',
      env: { DSH_DOUBAO_BROWSER_PATH: REL },
      home: 'C:\\Users\\jet',
      exists: (p) => p === REL,
    })
    expect(found).not.toBe(REL)
  })
})

// ── 豆包内核优先于通用 Chrome 兜底（M13 无牙的补丁）──

describe('★★ Windows: 豆包客户端内核排在**通用** Chrome 兜底之前', () => {
  it('★★★ 两条都在 ⇒ 必须选豆包内核（存量用户的解析结果不能漂）', () => {
    const KERNEL = 'D:\\Program File\\Doubao\\app\\Doubao.exe'
    const FALLBACK = 'C:\\Users\\jet\\scoop\\apps\\chromium\\current\\chrome.exe'
    const found = doubaoLoginBrowserExecutable({
      platform: 'win32',
      env: {},
      home: 'C:\\Users\\jet',
      exists: (p) => p === KERNEL || p === FALLBACK,
    })
    expect(found).toBe(KERNEL)
  })
})

// ── 生产接线：`clickLoginButton` 必须真的调三态实现（P2-3）──

describe('★★★ 生产接线守卫：`clickLoginButton` 不得退回 `loginEl.click()`', () => {
  it('★★★ 方法体必须调用 `clickDoubaoLoginButton`，且源文件里不许再有 `loginEl.click()`', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../../src/doubao-login.ts', import.meta.url), 'utf8')
    const start = source.indexOf('private async clickLoginButton')
    expect(start, 'clickLoginButton 不见了（改名？）').toBeGreaterThan(-1)
    const end = source.indexOf('\n  }', start)
    const body = source.slice(start, end > start ? end : start + 1500)

    /**
     * ⚠️ 这条是**接线**守卫，不是行为守卫：`DoubaoLoginSession.open()` 要真起浏览器，
     * 单测里没法跑完。但没有它，把 `await clickDoubaoLoginButton(this.cdp, sessionId, this.log)`
     * 整行删掉（或换回 `loginEl.click()`）**19 条用例全绿** —— 功能从产品里静默消失。
     * 本仓既有的 `jet-hub-structure-ast.spec.ts` 就是这个套路。
     */
    expect(body, '必须委托给三态实现').toContain('clickDoubaoLoginButton')
    /**
     * ⚠️ 扫**代码**而不是全文：这个文件有三处 doc 注释在讲「为什么不能只
     * `loginEl.click()`」（那是给人读的取证），全文扫描会把它们当违规。
     * 剥注释这一步不能省 —— 第一版就是这么假红的。
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code, '旧实现（只发合成 click）不许复活').not.toContain('loginEl.click()')
  })
})
