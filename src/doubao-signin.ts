/**
 * 豆包（Doubao）每日签到 —— CDP 页面会话驱动（**按账号隔离**）。
 *
 * ## 账号隔离（2026-11-03 支点验证后重写）
 *
 * **每个账号有独立的 cookie / device_id / web_id**，签到时必须严格按账号隔离：
 *
 * - **独立临时 profile**（不是豆包客户端的 User Data）：起一个干净的 Chromium，
 *   **不带**任何账号的登录态；
 * - **按账号注入 cookie**：把池里**该账号**的 cookie 用 `Network.setCookie`
 *   注入到这个干净 profile（`credentials:'include'` 读的就是它）；
 * - **按账号拼 query**：`device_id` / `web_id` / `tea_uuid` 由**该账号的
 *   `accountKey`（sessionid）确定性派生**（每账号一套 19 位数字设备号，
 *   对齐 TRAE `deriveDeviceId15` 的纪律 —— 规避服务端「每设备每天一次」
 *   配额），不是页面随机的 verify id。
 *
 * ⇒ 多账号场景下，选哪个账号就签哪个账号（实测：注入 A 号 cookie 签到，
 *   返回的是 A 号的 `checkin_date` / `continuous_days`）。
 *
 * ## 为什么不能复用豆包客户端的 User Data
 *
 * 那会固定打在「客户端当前登录的那个号」上 —— 注入的账号 cookie 会被
 * profile 里的 cookie 覆盖（同名键），且 device_id 读的是 Local State 里的
 * 当前号。这是「账号隔离失效」的真实根因（本次重写前的缺陷形态）。
 *
 * @module src/doubao-signin.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  browserCandidates,
  browserNotFoundMessage,
  findBrowserExecutable,
  type BrowserLookup,
} from './chromium-session.js'
import {
  DOUBAO_CAMPAIGN_GROUP_CODE,
  DOUBAO_CHECKIN_PATH,
  DOUBAO_CHECKIN_STATUS_PATH,
  DOUBAO_PAGE_URL,
  doubaoCheckinQuery,
  parseDoubaoCredential,
  type DoubaoCredential,
} from './doubao.js'

/**
 * 签到用的浏览器可执行文件（任意 Chromium 系即可，**不需要**豆包内核）。
 *
 * ## ⚠️⚠️ 为什么末尾必须兜到 `findBrowserExecutable()`（Gitee issue IKV5HC）
 *
 * 与 `doubao-login.ts` 的 {@link doubaoLoginBrowserExecutable} **同因同修**：
 * 候选链全是 Windows 路径 ⇒ macOS / Linux 上一条都不存在 ⇒ `undefined` ⇒
 * 签到入口同样报「未找到可执行文件」。**两个函数必须一起改**：只修登录
 * 会让「扫码能进、签到照样失败」，症状与「豆包今天没活动」同形。
 */
/** 候选链的环境变量名（错误提示要回显它）。 */
const DOUBAO_BROWSER_ENV = 'DSH_DOUBAO_BROWSER_PATH'

/**
 * 签到这边的候选链（**不含**跨平台兜底；提示文案要逐条回显）。
 *
 * ⚠️⚠️ **Windows 专属候选按平台门控** —— 理由与 `doubao-login.ts` 同名函数
 * 逐字相同：无条件入链会让 macOS 的提示里出现 `chrome.exe`（Issue IKJKNT 的
 * 形态），而解析结果并不因此改变。`DSH_DOUBAO_BROWSER_PATH` 不门控。
 */
function doubaoSigninCandidates(lookup: BrowserLookup): string[] {
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
  // ⚠️ 环境变量先 trim：理由与 doubao-login.ts 同款（`'   '` 会假装"已设置"）。
  return [env[DOUBAO_BROWSER_ENV]?.trim(), ...windows]
    /**
     * ⚠️ **必须拒绝相对路径**（`isAbsolute`）：`DSH_DOUBAO_BROWSER_PATH=chrome.exe`
     * 会让 `existsSync` 相对**当前工作目录**命中一个同名文件（实测返回
     * `audit-rel-chrome.exe`）—— 共享腿 `browserCandidates` 本来就按绝对路径过滤，
     * 项目腿不跟上的话两边就分叉了（同 `client-ui` 笔记「一文件两套同义判据」）。
     */
    .filter((candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0 && isAbsolute(candidate))
}

export function doubaoSigninBrowserExecutable(lookup: BrowserLookup = {}): string | undefined {
  const exists = lookup.exists ?? existsSync
  for (const candidate of doubaoSigninCandidates(lookup)) if (exists(candidate)) return candidate
  // 跨平台兜底（macOS 的 .app 包 / Linux 的 PATH 与 AppStream / Windows 的 scoop、Edge）。
  return findBrowserExecutable(lookup)
}

/**
 * 签到找不到浏览器时的提示（分平台说人话 + 回显候选清单）。
 *
 * 与 {@link doubaoSigninBrowserExecutable} 同因：修复前那句「未找到可用的浏览器
 * （Chrome / 豆包内核）——签到需要它的 bdms 签名环境」同样**不分平台、不提变量名、
 * 不回显候选**。本仓其余五家浏览器登录都用 `browserNotFoundMessage`，豆包不该是例外。
 */
export function doubaoSigninBrowserHint(lookup: BrowserLookup = {}): string {
  const platform = lookup.platform ?? process.platform
  const env = lookup.env ?? process.env
  return browserNotFoundMessage(platform, DOUBAO_BROWSER_ENV, {
    tried: [...doubaoSigninCandidates(lookup), ...browserCandidates(lookup)]
      .filter((candidate) => candidate.length > 0 && isAbsolute(candidate)),
    overrideValue: env[DOUBAO_BROWSER_ENV],
  })
}

/** 极简 CDP 通道（Node 内置 WebSocket，零依赖）。登录会话（`doubao-login.ts`）也复用它。 */
export class MiniCdp {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event: MessageEvent) => {
      let m: { id?: number; error?: { message?: string }; result?: unknown }
      try { m = JSON.parse(String(event.data)) as typeof m } catch { return }
      if (m.id === undefined) return
      const slot = this.pending.get(m.id)
      if (!slot) return
      this.pending.delete(m.id)
      if (m.error) slot.reject(new Error(m.error.message ?? JSON.stringify(m.error)))
      else slot.resolve(m.result)
    })
  }

  static async connect(wsUrl: string): Promise<MiniCdp> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
    })
    return new MiniCdp(ws)
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)) }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try {
        this.ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
      } catch (e) {
        clearTimeout(timer); this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  close(): void { try { this.ws.close() } catch { /* 忽略 */ } }
}

/** 在调试端口上找豆包页面 target 的 targetId。 */
async function findPageTargetId(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await new Promise<Array<{ id?: string; type?: string; url?: string }>>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
          let b = ''
          res.on('data', (c) => (b += c))
          res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
        }).on('error', reject)
      })
      const page = list.find((t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes('doubao.com'))
        ?? list.find((t) => t.type === 'page')
      if (page && typeof page.id === 'string') return page.id
    } catch { /* 还没起来，继续等 */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('豆包页面未就绪（CDP 找不到 doubao.com target）')
}

/** 调试端口的浏览器级 webSocket 地址。 */
async function browserWsUrl(port: number): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const v = await new Promise<{ webSocketDebuggerUrl?: string }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => {
          let b = ''
          res.on('data', (c) => (b += c))
          res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
        }).on('error', reject)
      })
      if (typeof v.webSocketDebuggerUrl === 'string') return v.webSocketDebuggerUrl
    } catch { /* 浏览器还没起来，继续等 */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`浏览器 CDP 未就绪（127.0.0.1:${port} 超时）`)
}

/** 挑一个空闲端口。 */
async function pickFreePort(): Promise<number> {
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

/**
 * 把账号 cookie 逐条注入到当前会话的页面域（`.doubao.com` / `.bytedance.com`）。
 *
 * ⚠️ cookie 串是 `name=value; …` 形态；逐条 `Network.setCookie` 写到对应域。
 *    与 `scripts/probe-doubao-isolation.cjs` 的支点验证同法（实测签到成功）。
 */
async function injectAccountCookies(
  cdp: MiniCdp,
  sessionId: string,
  cookieHeader: string,
): Promise<number> {
  let written = 0
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name.length === 0 || value.length === 0) continue
    // msToken 属 .bytedance.com，其余属 .doubao.com。
    const domain = name === 'msToken' ? '.bytedance.com' : '.doubao.com'
    const secure = name.endsWith('_ss') || name === 'ttwid' || name === 'sid_ucp_v1' || name === 'ssid_ucp_v1'
    await cdp.send('Network.setCookie', { name, value, domain, path: '/', secure, httpOnly: false }, sessionId)
    written++
  }
  return written
}

/** 页面签到脚本（两步：landing/get 查状态 → 有活动才 checkin；bdms 签名；cookie 已注入）。 */
function buildCheckinPageScript(credential: DoubaoCredential): string {
  const qs = doubaoCheckinQuery(credential)
  return `(async()=>{
    const qs=${JSON.stringify(qs)};
    const scene=${JSON.stringify(DOUBAO_CAMPAIGN_GROUP_CODE)};
    const path=${JSON.stringify(DOUBAO_CHECKIN_PATH)};
    const statusPath=${JSON.stringify(DOUBAO_CHECKIN_STATUS_PATH)};
    if (!(window.bdms && typeof window.bdms.frontierSign === 'function')) {
      return JSON.stringify({ fatal: 'bdms_not_ready' });
    }
    let bogus = '';
    try {
      const sig = window.bdms.frontierSign({ 'X-MS-STUB': '' });
      bogus = (sig && sig['X-Bogus']) ? sig['X-Bogus'] : '';
    } catch (e) {
      return JSON.stringify({ fatal: 'sign_failed', detail: String(e && e.message || e) });
    }
    if (!bogus) return JSON.stringify({ fatal: 'sign_empty' });
    const call = async (p) => {
      const res = await fetch(p + '?' + qs + '&a_bogus=' + encodeURIComponent(bogus), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Agw-Js-Conv': 'str' },
        body: JSON.stringify({ scene }),
        credentials: 'include',
      });
      return { status: res.status, body: (await res.text()).slice(0, 1000) };
    };
    // 第一步：查活动状态（只读，仅用于丰富文案）。
    //   ⚠️ **不能**据它短路：实测（2026-11-03）已签账号的 landing/get 也回空活动
    //   （签完当天就没有可领对象了），短路会把「今天已签」误报成「没有活动」。
    //   checkin 本身幂等（已签回 checked_in:true, idempotent:true），始终发。
    const status = await call(statusPath);
    // 第二步：领取（幂等，安全）。
    const claim = await call(path);
    return JSON.stringify({ status: claim.status, body: claim.body, statusBody: status.body });
  })()`
}

/** 页面签到响应形状。 */
interface DoubaoCheckinWire {
  data?: {
    checked_in?: boolean
    checkin_date?: string
    continuous_days?: number
    idempotent?: boolean
    reward_amount?: number
    reward_code?: string
    reward_status?: number
    reward_type?: string
  }
  code?: number
  msg?: string
  message?: string
}

/**
 * 执行豆包每日签到（**按账号隔离**：独立 profile + 注入该账号 cookie/device_id）。
 *
 * @param rawCredential 池里那份 JSON 凭据（含 `cookie` / `deviceId` / `webId`）。
 */
export async function claimDoubaoDailyViaPage(
  rawCredential: string,
  options: { log?: (msg: string) => void; executablePath?: string; timeoutMs?: number } = {},
): Promise<import('./credits.js').ClaimOutcome> {
  const credential = parseDoubaoCredential(rawCredential)
  if (!credential?.cookie) {
    return { kind: 'inactive', message: '没有可用的豆包登录会话（请先在账号卡上完成登录）' }
  }
  const exe = options.executablePath ?? doubaoSigninBrowserExecutable()
  if (exe === undefined) {
    return { kind: 'failed', code: -1, message: '未找到可用的浏览器 —— 签到需要它的 bdms 签名环境。' + doubaoSigninBrowserHint() }
  }
  const timeoutMs = options.timeoutMs ?? 60_000
  const log = options.log
  const port = await pickFreePort()
  // ⚠️ **独立临时 profile**：不带任何账号登录态，签到靠「注入该账号 cookie」。
  const profileDir = mkdtempSync(join(tmpdir(), 'doubao-signin-'))
  let child: ChildProcess | undefined
  const kill = () => { try { child?.kill('SIGKILL') } catch { /* 忽略 */ } }
  try {
    log?.(`[doubao] 启动签到会话（端口 ${port}，独立 profile）`)
    child = spawn(exe, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      DOUBAO_PAGE_URL,
    ], { stdio: 'ignore', windowsHide: true })
    process.on('exit', kill)
    // ⚠️ 先等浏览器本身的 /json/version 就绪（它起来了才谈得上找页面 target）。
    const wsUrl = await browserWsUrl(port)
    const targetId = await findPageTargetId(port, 30_000)
    const cdp = await MiniCdp.connect(wsUrl)
    try {
      // attach 到页面拿 sessionId（页面级命令都带它）。
      const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId?: unknown }
      const sessionId = typeof attached?.sessionId === 'string' ? attached.sessionId : ''
      if (sessionId.length === 0) return { kind: 'failed', code: -1, message: 'CDP attach 没拿到 sessionId' }
      // ① 注入该账号的 cookie（隔离的关键）。
      const injected = await injectAccountCookies(cdp, sessionId, credential.cookie)
      log?.(`[doubao] 已注入 ${injected} 条账号 cookie`)
      // ② 重新加载页面让 cookie 生效 + bdms 就绪。
      await cdp.send('Page.enable', {}, sessionId)
      await cdp.send('Page.navigate', { url: DOUBAO_PAGE_URL }, sessionId)
      await new Promise((r) => setTimeout(r, 6000))
      // ③ 页面里签名 + 领取。
      const evaluated = await cdp.send('Runtime.evaluate', {
        expression: buildCheckinPageScript(credential),
        awaitPromise: true,
        returnByValue: true,
      }, sessionId, timeoutMs) as { result?: { value?: unknown } } | undefined
      const raw = typeof evaluated?.result?.value === 'string' ? evaluated.result.value : ''
      if (raw.length === 0) {
        return { kind: 'failed', code: -1, message: '页面签到脚本没有返回结果（页面可能未加载完成）' }
      }
      let parsed: { status?: number; body?: string; fatal?: string; detail?: string }
      try { parsed = JSON.parse(raw) as typeof parsed } catch { return { kind: 'failed', code: -1, message: '页面签到脚本返回不是 JSON' } }
      if (typeof parsed.fatal === 'string') {
        return { kind: 'failed', code: -1, message: `签到签名失败（${parsed.fatal}${parsed.detail ? '：' + parsed.detail : ''}）` }
      }
      const wire = (() => { try { return JSON.parse(String(parsed.body ?? '')) as DoubaoCheckinWire } catch { return undefined } })()
      if (wire === undefined) {
        return { kind: 'failed', code: -1, message: `签到响应不是 JSON（HTTP ${parsed.status}）` }
      }
      const code = typeof wire.code === 'number' ? wire.code : -1
      const data = wire.data
      if (code === 0 && data?.checked_in === true) {
        const amount = typeof data.reward_amount === 'number' ? data.reward_amount : 0
        const days = typeof data.continuous_days === 'number' ? data.continuous_days : 0
        log?.(`[doubao] 签到成功：+${amount}（连续 ${days} 天）`)
        return { kind: 'claimed', credit: amount, streakDays: days, isStreakDay: days > 0 }
      }
      if (data?.idempotent === true && data.checked_in === false) {
        return { kind: 'already-claimed', message: '今天已签到' }
      }
      /**
       * ⚠️ `710010702`（2026-11-03 多账号实测，含官方客户端环境复现）：当前
       * **没有可领的签到活动**（landing/get 同时刻回 `code:0` 但活动内容全空）。
       * 覆盖三种上游形态：今日已领完 / 活动未对该账号投放 / 活动已收摊 ——
       * 对用户的动作都一样（明天再看），不是故障，不按网络错误排查。
       */
      if (code === 710010702) {
        return { kind: 'inactive', message: '当前没有可领取的豆包签到活动（可能今日已领完、或活动未对当前账号/时段投放）' }
      }
      return { kind: 'failed', code, message: wire.msg ?? wire.message ?? `签到失败（code=${code}）` }
    } finally {
      cdp.close()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'failed', code: -1, message: `豆包签到会话失败：${message}` }
  } finally {
    kill()
    // 临时 profile 即用即弃（含注入的账号 cookie）。
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}
