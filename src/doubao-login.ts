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
import { join } from 'node:path'
import { DOUBAO_PAGE_URL, type DoubaoCredential } from './doubao.js'
import { MiniCdp } from './doubao-signin.js'

/** 登录用浏览器（与签到共用候选链；可用 `DSH_DOUBAO_BROWSER_PATH` 覆盖）。 */
export function doubaoLoginBrowserExecutable(): string | undefined {
  const candidates = [
    process.env.DSH_DOUBAO_BROWSER_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'D:\\Program File\\Doubao\\app\\Doubao.exe',
  ]
  for (const p of candidates) if (typeof p === 'string' && p.length > 0 && existsSync(p)) return p
  return undefined
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
      throw new Error('豆包登录需要本机有 Chromium 内核浏览器（Chrome / 豆包客户端），未找到可执行文件')
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
    if (sessionId === undefined) return
    await this.cdp?.send('Runtime.evaluate', {
      expression: `(async()=>{
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        const loginEl = btns.find(b => b.textContent && b.textContent.trim() === '登录')
        if (loginEl) loginEl.click()
      })()`,
      awaitPromise: true, returnByValue: true,
    }, sessionId)
    this.log('[doubao-login] 已尝试点击「登录」按钮（弹出二维码）')
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
