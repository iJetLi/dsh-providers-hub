/**
 * 豆包（Doubao）扫码登录 —— 浏览器会话落池。
 *
 * ## 登录形态（2026-11-03 实测）
 *
 * 打开 `https://www.doubao.com/chat/`（未登录态）→ 点击右上「登录」→
 * 页面内弹出**二维码模态框** → 用户用手机豆包 App 扫码 → 成功后
 * `.doubao.com` 种下 `sessionid` 等登录 cookie。
 *
 * ## 账号隔离（每个账号独立身份）
 *
 * - **一次性 profile**：每次登录一个全新临时目录 ⇒ 不同账号的 cookie 会话
 *   天然不串；
 * - 登录成功后从**该会话**读全量 cookie（`Storage.getCookies`，浏览器级，
 *   可读 HttpOnly —— kukuai 笔记 §5.4.5 的实测结论）落池；
 * - **设备身份**：落库时存 `accountKey`（= `sessionid`，账号稳定标识），
 *   签到时由它**确定性派生**每账号独享的 19 位数字设备号
 *   （`doubao.ts` 的 `doubaoDerivedDeviceIdentity`，对齐 TRAE
 *   `deriveDeviceId15` 的纪律）⇒ 规避服务端「每设备每天一次」配额。
 *
 * @module src/doubao-login.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  browserCandidates,
  browserNotFoundMessage,
  findBrowserExecutable,
  type BrowserLookup,
} from './chromium-session.js'
import { DOUBAO_PAGE_URL, type DoubaoCredential } from './doubao.js'
import { MiniCdp } from './doubao-signin.js'

/**
 * 登录用浏览器（与签到共用候选链；可用 `DSH_DOUBAO_BROWSER_PATH` 覆盖）。
 *
 * ## ⚠️⚠️ 为什么末尾必须兜到 `findBrowserExecutable()`（Gitee issue IKV5HC）
 *
 * 修复前这张表**全是 Windows 路径**（`C:\Program Files\…\chrome.exe`、
 * `D:\Program File\Doubao\app\Doubao.exe`），而 `process.platform` 是 macOS /
 * Linux 时一条都不存在 ⇒ 直接 `return undefined` ⇒ 用户点「+ 新建账号」只看到
 * 「豆包登录需要本机有 Chromium 内核浏览器…未找到可执行文件」，**而他的 Mac 上
 * Chrome 装得好好的**（报障人实测：macOS 14 Apple Silicon + Chrome）。
 *
 * 本仓其余四家浏览器登录（baizhi / magicrew / marvis / monkeycode）**都**是
 * `deps.resolveBrowser ?? findBrowserExecutable` 这个形状，豆包是唯一漏掉的
 * —— 所以这里不是「新增能力」，是**补齐既有的跨平台探测**。
 *
 * ⚠️ 顺序刻意保留「本项目自己的候选链在前」：存量 Windows 用户的解析结果
 * 逐字节不变（`DSH_DOUBAO_BROWSER_PATH` 仍最优先、豆包客户端内核仍排在
 * 通用 Chrome 之前），只有「前五条一条都不存在」时才会走到跨平台兜底。
 */
/** 候选链的环境变量名（错误提示要回显它）。 */
const DOUBAO_BROWSER_ENV = 'DSH_DOUBAO_BROWSER_PATH'

/**
 * 本项目自己的候选链（**不含**跨平台兜底；提示文案要逐条回显）。
 *
 * ⚠️⚠️ **Windows 专属候选按平台门控**。第一版修复只把「跨平台兜底」加在链尾、
 * 自有候选原样保留 ⇒ 在 macOS 上解析虽正确（那几条恒不存在），但**提示文案里
 * 会出现 `C:\Program Files\…\chrome.exe` 与 `/Program Files`**，因为
 * `path.win32.isAbsolute('C:\\…')` 在 macOS 上也是 `true`，过掉了 `isAbsolute`
 * 过滤 —— 结果正是 Issue IKJKNT 的形态（Mac 用户照着提示去找 `chrome.exe`）。
 * 门控后解析结果**逐字不变**，但语义自证、提示干净。
 *
 * `DSH_DOUBAO_BROWSER_PATH` **不门控** —— 任何平台都尊重用户覆盖。
 */
function doubaoLoginCandidates(lookup: BrowserLookup): string[] {
  const env = lookup.env ?? process.env
  const home = lookup.home ?? homedir()
  const platform = lookup.platform ?? process.platform
  const windows = platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
        // 兜底：豆包客户端内核（也是 Chromium 147，页面环境完整）。
        'D:\\Program File\\Doubao\\app\\Doubao.exe',
      ]
    : []
  return [env[DOUBAO_BROWSER_ENV], ...windows]
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
}

export function doubaoLoginBrowserExecutable(lookup: BrowserLookup = {}): string | undefined {
  const exists = lookup.exists ?? existsSync
  for (const candidate of doubaoLoginCandidates(lookup)) if (exists(candidate)) return candidate
  // 跨平台兜底：macOS 扫 `/Applications` 与 `~/Applications` 的 .app 包、
  // Linux 扫 PATH 与 AppStream 元数据、Windows 补 scoop / Edge / Chromium。
  return findBrowserExecutable(lookup)
}

/**
 * 找不到浏览器时的**用户可执行提示**（分平台说人话 + 回显候选清单）。
 *
 * ## ⚠️⚠️ 为什么必须复用 `browserNotFoundMessage` 而不是自己编一句
 *
 * 修复前那句是 `豆包登录需要本机有 Chromium 内核浏览器（Chrome / 豆包客户端），
 * 未找到可执行文件` —— 三处会把人带偏：
 *
 * 1. **不分平台**：macOS / Linux 上「豆包客户端」根本不在候选链里（那几条是
 *    `D:\Program File\Doubao\app\Doubao.exe` 这种 Windows 路径）；
 * 2. **不说变量名**：用户唯一真能自救的动作是设 `DSH_DOUBAO_BROWSER_PATH`，
 *    而原文案一个字都没提；
 * 3. **不回显候选**：报障人照着提示做只能猜。
 *
 * 这正是 Issue IKJKNT 的形态（当时 zcode 的提示让 Mac 用户去找 `chrome.exe`），
 * 共享模块的 {@link browserNotFoundMessage} 就是那次的产物 —— 本仓其余五家
 * 浏览器登录**全都**用它，豆包是唯一自己编的。
 */
export function doubaoLoginBrowserHint(lookup: BrowserLookup = {}): string {
  const platform = lookup.platform ?? process.platform
  const env = lookup.env ?? process.env
  return browserNotFoundMessage(platform, DOUBAO_BROWSER_ENV, {
    tried: [...doubaoLoginCandidates(lookup), ...browserCandidates(lookup)]
      .filter((candidate) => candidate.length > 0 && isAbsolute(candidate)),
    overrideValue: env[DOUBAO_BROWSER_ENV],
  })
}

/** CDP 通道的最小接口（只声明本文件用到的方法，便于单测注入假通道）。 */
export interface DoubaoClickCdp {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
}

/**
 * 点击「登录」按钮的结果 —— **三态**（单测靠它区分「走了真鼠标事件」还是
 * 「退化成合成事件」，二者对上游风控的可信度不同）。
 */
export type DoubaoLoginClickOutcome = 'trusted' | 'synthetic' | 'not-found'

/**
 * 点击豆包页面上的「登录」按钮（弹出二维码）。
 *
 * ## ⚠️⚠️ 为什么不能只 `loginEl.click()`（Gitee issue IKV5HC 第三条）
 *
 * 修复前是 `if (loginEl) loginEl.click()`。豆包登录按钮的处理器挂在
 * `pointerdown` / `mousedown` 上（报障人实测），而 `HTMLElement.click()`
 * **只派发 `click`**，`pointerdown` / `mousedown` / `pointerup` / `mouseup`
 * 一个都不发 ⇒ 处理器不触发、二维码不弹，用户得手动点（自动点击形同虚设）。
 *
 * ⇒ 两级策略：
 *
 * 1. **真鼠标事件（首选）**：先用 `Runtime.evaluate` 取按钮**中心点**，再
 *    `Input.dispatchMouseEvent` 发 `mousePressed` + `mouseReleased` —— 这是
 *    **浏览器进程**派发的受信任事件（`isTrusted === true`），Chromium 会按
 *    标准顺序自行派生 `pointerdown` / `mousedown` / `pointerup` / `mouseup` /
 *    `click`，与用户真点一下**等价**；
 * 2. **合成事件（兜底）**：按钮存在但**拿不到盒子**（`0×0`、被浮层裁掉、
 *    `display:none` 的祖先）时，用 JS 按同一顺序 `dispatchEvent` 一整套
 *    （`pointerdown → mousedown → pointerup → mouseup → click`）。这些事件
 *    `isTrusted === false`，但对「只监听事件、不校验 isTrusted」的页面足够。
 *
 * ⚠️ 返回三态而不是 `void`：单测必须能区分「走了第 1 级」「退化到第 2 级」
 * 「按钮压根没找到」—— 只断言「没抛错」的话，把整段换成 `loginEl.click()`
 * 也照样绿（本仓「假绿」列表里的常客）。
 */
export async function clickDoubaoLoginButton(
  cdp: DoubaoClickCdp,
  sessionId: string,
  log: (msg: string) => void = () => {},
): Promise<DoubaoLoginClickOutcome> {
  /** 找按钮并取中心点（`Input.dispatchMouseEvent` 的口径就是 CSS 像素）。 */
  const located = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      const loginEl = btns.find((b) => b.textContent && b.textContent.trim() === '登录')
      if (!loginEl) return 'not-found'
      const r = loginEl.getBoundingClientRect()
      if (!(r.width > 0) || !(r.height > 0)) return 'no-box'
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId) as { result?: { value?: unknown } } | undefined
  const value = located?.result?.value
  if (value === 'not-found') {
    log('[doubao-login] 页面上没找到「登录」按钮（可能需要手动点）')
    return 'not-found'
  }
  const point = value as { x?: unknown; y?: unknown } | null | undefined
  const x = typeof point?.x === 'number' ? point.x : undefined
  const y = typeof point?.y === 'number' ? point.y : undefined
  if (x !== undefined && y !== undefined) {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      }, sessionId)
    }
    log(`[doubao-login] 已用受信任鼠标事件点击「登录」（${x},${y}）`)
    return 'trusted'
  }
  // 按钮在、但盒子是 0×0 或被裁 ⇒ 拿不到可点的坐标，退回合成事件序列。
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      const loginEl = btns.find((b) => b.textContent && b.textContent.trim() === '登录')
      if (!loginEl) return false
      const r = loginEl.getBoundingClientRect()
      const base = {
        bubbles: true, cancelable: true, composed: true, button: 0,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }
      loginEl.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
      loginEl.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
      loginEl.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
      loginEl.dispatchEvent(new MouseEvent('mouseup', base))
      loginEl.dispatchEvent(new MouseEvent('click', base))
      return true
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId)
  log('[doubao-login] 已用合成事件序列点击「登录」（按钮无可点盒子）')
  return 'synthetic'
}

/**
 * 一次豆包扫码登录会话。用完必须 `close()`（收进程 + 删临时 profile）。
 *
 * 生命周期：`open()` → `waitForCredential()`（轮询）→ `close()`。
 */
export class DoubaoLoginSession {
  private closed = false
  private cdp: MiniCdp | undefined
  private readonly log: (msg: string) => void

  private constructor(
    private readonly child: ChildProcess,
    private readonly port: number,
    private readonly profileDir: string,
    log?: (msg: string) => void,
  ) {
    this.log = log ?? (() => {})
  }

  /** 起一个**可见**浏览器窗口并打开豆包（用户要扫码）。 */
  static async open(options: { executablePath?: string; log?: (msg: string) => void } = {}): Promise<DoubaoLoginSession> {
    const exe = options.executablePath ?? doubaoLoginBrowserExecutable()
    if (exe === undefined) {
      throw new Error('豆包登录需要本机有 Chromium 内核浏览器，未找到可执行文件。' + doubaoLoginBrowserHint())
    }
    const port = await pickFreePort()
    const profileDir = mkdtempSync(join(tmpdir(), 'doubao-login-'))
    const child = spawn(exe, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1100,860',
      // ⚠️ **可见窗口**（不用 headless）：用户要在这个窗口里扫码。
      DOUBAO_PAGE_URL,
    ], { stdio: 'ignore', windowsHide: false })
    const session = new DoubaoLoginSession(child, port, profileDir, options.log)
    process.on('exit', () => session.close())
    // 等浏览器就绪并连上浏览器级 CDP。
    const wsUrl = await browserWsUrl(port, 30_000)
    session.cdp = await MiniCdp.connect(wsUrl)
    session.log(`[doubao-login] 登录窗口已打开（端口 ${port}）`)
    return session
  }

  /**
   * 等待用户完成扫码登录，读出该账号的 cookie + 设备身份。
   *
   * ## 判定信号
   *
   * `Storage.getCookies`（浏览器级）里出现 `.doubao.com` 的 `sessionid`
   * ⇒ 登录成功。轮询期间任何 CDP 失败都**返回 `undefined` 继续**等
   * （页面在导航、用户还没扫，都不是终态）。
   */
  async waitForCredential(timeoutMs = 240_000): Promise<DoubaoCredential | undefined> {
    const deadline = Date.now() + timeoutMs
    // 页面加载后自动点「登录」弹二维码（失败不抛 —— 用户可手动点）。
    try { await this.clickLoginButton() } catch (e) { this.log(`[doubao-login] 自动点登录未成功（用户可手动点）：${String(e)}`) }
    while (Date.now() < deadline) {
      const credential = await this.readCredentialOnce()
      if (credential !== undefined) return credential
      await new Promise((r) => setTimeout(r, 1200))
    }
    return undefined
  }

  /** 尝试一次：找到「登录」按钮并点击（弹出二维码）。失败不抛（用户可手动点）。 */
  private async clickLoginButton(): Promise<void> {
    const sessionId = await this.attachPageSession()
    if (sessionId === undefined || this.cdp === undefined) return
    // 判据全在 `clickDoubaoLoginButton` 一处（真鼠标事件 → 合成事件兜底）。
    await clickDoubaoLoginButton(this.cdp, sessionId, this.log)
  }

  /** 尝试一次读凭据：`sessionid` 在 ⇒ 组装 `DoubaoCredential`。 */
  private async readCredentialOnce(): Promise<DoubaoCredential | undefined> {
    if (this.cdp === undefined) return undefined
    try {
      // ⚠️ 浏览器级 `Storage.getCookies`（不需要 sessionId，可读 HttpOnly）。
      const result = await this.cdp.send('Storage.getCookies', {}) as { cookies?: Array<{ name?: string; value?: string; domain?: string }> }
      const cookies = result?.cookies ?? []
      const byName = new Map<string, string>()
      const cookiePairs: string[] = []
      for (const c of cookies) {
        if (typeof c.name !== 'string' || typeof c.value !== 'string') continue
        if (typeof c.domain === 'string' && !c.domain.includes('doubao.com') && !c.domain.includes('bytedance.com')) continue
        if (c.name.length === 0 || c.value.length === 0) continue
        byName.set(c.name, c.value)
        cookiePairs.push(`${c.name}=${c.value}`)
      }
      const sessionid = byName.get('sessionid')
      if (typeof sessionid !== 'string' || sessionid.length === 0) return undefined
      this.log('[doubao-login] 检测到 sessionid，登录成功')
      return {
        cookie: cookiePairs.join('; '),
        // ⚠️ accountKey = sessionid（账号稳定标识）：设备身份由它**确定性派生**
        //    （每账号一套 19 位数字设备号，见 doubao.ts 的 doubaoDerivedDeviceIdentity）。
        //    不存 s_v_web_id/ttwid 当设备号 —— 那是 verify 前缀的预验证 id，
        //    服务端没注册过（多账号实测 710010702 的根因之一）。
        accountKey: sessionid,
      }
    } catch {
      return undefined
    }
  }

  /** attach 到豆包页面拿 sessionId（每次现取 —— 页面导航会让旧 sessionId 失效）。 */
  private async attachPageSession(): Promise<string | undefined> {
    if (this.cdp === undefined) return undefined
    try {
      const targets = await httpJsonList(this.port)
      const page = targets.find((t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes('doubao.com'))
        ?? targets.find((t) => t.type === 'page')
      if (!page || typeof page.id !== 'string') return undefined
      const attached = await this.cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true }) as { sessionId?: unknown }
      return typeof attached?.sessionId === 'string' ? attached.sessionId : undefined
    } catch { return undefined }
  }

  /** 收掉浏览器（幂等）：杀进程 + 删一次性 profile。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.cdp?.close()
    try { this.child.kill('SIGKILL') } catch { /* 忽略 */ }
    try { rmSync(this.profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

// ── 小工具 ──

function httpJsonList(port: number): Promise<Array<{ id?: string; type?: string; url?: string }>> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

function browserWsUrl(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) return reject(new Error(`浏览器 CDP 未就绪（127.0.0.1:${port}）`))
      http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => {
          try {
            const v = JSON.parse(b) as { webSocketDebuggerUrl?: string }
            if (typeof v.webSocketDebuggerUrl === 'string') resolve(v.webSocketDebuggerUrl)
            else setTimeout(attempt, 400)
          } catch { setTimeout(attempt, 400) }
        })
      }).on('error', () => setTimeout(attempt, 400))
    }
    attempt()
  })
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}
