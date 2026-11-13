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
    async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      calls.push({ method, params })
      if (method === 'Runtime.evaluate') {
        const value = queue.shift()
        return { result: { value } }
      }
      return {}
    },
  }
  return { cdp, calls }
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
    // 事件必须打到**页面会话**上（不带 sessionId 会发到浏览器级、没人接）。
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
     */
    const order = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', "'click'"].map((name) => expression.indexOf(name))
    for (const [index, at] of order.entries()) {
      expect(at, `合成序列里缺少第 ${index + 1} 个事件（${['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'][index]}）`).toBeGreaterThan(-1)
    }
    expect([...order].sort((a, b) => a - b), '五个事件必须按 pointerdown → mousedown → pointerup → mouseup → click 排列').toEqual(order)
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
