import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { getRandomValues, randomUUID, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodeArtsCredential, CodeArtsCredentialResponse, LoginFlowOptions, LoginFlowResult } from './types.js'
import {
  CLIENT_ID, REDIRECT_PATH, credentialFromTokenResponse, exchangeAuthorizationCode,
  generateDpopKeyPair, generatePkcePair,
} from './oauth.js'
import type { DpopKeyPair, PkcePair } from './oauth.js'

export const CODEARTS_LOGIN_BASE = 'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect'
export const HUAWEI_AUTH_BASE = 'https://auth.huaweicloud.com/authui/login.html'
export const CREDENTIAL_ENDPOINT = 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket'

const PLUGIN_NAME = 'snap_jetbrains'
const PLUGIN_VERSION = '26.3.3'

/** 与重定向流程共享的随机 64 字符小写十六进制密钥。 */
export function generateRandomSecret(): string {
  const bytes = getRandomValues(new Uint8Array(32))
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 构建 doer/redirect URL 及包裹它的华为认证页面 URL。 */
export function buildLoginUrl(port: number, ticketId: string): { redirectUrl: string; loginUrl: string } {
  const callbackUrl = `http://127.0.0.1:${port}/authentication`
  const redirectUrl = `${CODEARTS_LOGIN_BASE}?IdeaType=jetbrains&auth_callback_url=${encodeURIComponent(callbackUrl)}&plugin-name=${PLUGIN_NAME}&plugin-version=${PLUGIN_VERSION}&ticket_id=${encodeURIComponent(ticketId)}`
  const loginUrl = `${HUAWEI_AUTH_BASE}?service=${encodeURIComponent(redirectUrl)}`
  return { redirectUrl, loginUrl }
}

/** 将一次 ticket 响应归一化为凭据，未完成时返回 null。 */
export function parseCredentialResponse(data: CodeArtsCredentialResponse): CodeArtsCredential | null {
  if (data.credential) {
    const access = data.credential.access ?? ''
    const st = data.credential.securitytoken ?? data.credential.securityToken ?? ''
    if (access && st) {
      return {
        access_key_id: access,
        secret_access_key: data.credential.secret ?? '',
        security_token: st,
        expires_at: data.credential.expires_at ?? data.credential.expiresAt ?? '',
        domain_id: data.domain_id ?? '',
        user_id: data.user_id ?? '',
        user_name: data.user_name ?? '',
      }
    }
  }
  if (data.result) {
    const ak = data.result.accessKeyId ?? ''
    const st = data.result.securityToken ?? ''
    if (ak && st) {
      return {
        access_key_id: ak,
        secret_access_key: data.result.secretAccessKey ?? '',
        security_token: st,
        expires_at: data.result.expiration ?? data.result.expiresAt ?? '',
      }
    }
  }
  return null
}

/** 凭据的过期时间戳（毫秒）；时间戳无法解析时回退为 +24 小时。 */
export function expiresFromCredential(credential: CodeArtsCredential): number {
  if (credential.expires_at) {
    const parsed = Date.parse(credential.expires_at)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now() + 86_400_000
}

/**
 * 轮询 ticket 端点，直到收到完整凭据或尝试
 * 次数耗尽。瞬时失败会被跳过，不会视为致命错误。
 */
export async function pollForCredential(
  ticketId: string,
  secret: string,
  options: { fetcher?: typeof fetch; maxAttempts?: number; pluginName?: string; pluginVersion?: string } = {},
): Promise<CodeArtsCredential> {
  const fetcher = options.fetcher ?? fetch
  const maxAttempts = options.maxAttempts ?? 120
  const pluginName = options.pluginName ?? PLUGIN_NAME
  const pluginVersion = options.pluginVersion ?? PLUGIN_VERSION
  const url = `${CREDENTIAL_ENDPOINT}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'plugin-name': pluginName,
          'plugin-version': pluginVersion,
        },
      })
    } catch {
      continue
    }
    if (!response.ok) continue
    let data: CodeArtsCredentialResponse | null
    try {
      data = (await response.json()) as CodeArtsCredentialResponse
    } catch {
      continue
    }
    const credential = data ? parseCredentialResponse(data) : null
    if (credential) return credential
  }
  throw new Error('CodeArts login timed out')
}

/**
 * 使用平台默认打开器打开 URL；永不抛出异常。
 *
 * ⚠️ **「永不抛出」必须靠 `'error'` 监听器兑现**（真实缺陷，2026-10-03）。
 *
 * `spawn` 的失败（`ENOENT` / `EACCES`）是以**异步 `'error'` 事件**上报的，
 * 外层 `try/catch` **接不住**它。而 `ChildProcess` 是 EventEmitter ——
 * `'error'` 没有监听器时会被 `throw` 成**未捕获异常**。
 *
 * POSIX 上这很容易踩：无桌面环境的 `open`（macOS）/ `xdg-open`（Linux）
 * 常常不存在 ⇒ `ENOENT` ⇒ **直接把宿主进程带走**。
 * （Windows 的 `cmd` 恒存在，所以只在 POSIX 上暴露 —— 典型的「本地测不出来」。）
 *
 * ⚠️ 用 `child.unref()` + 监听器，不能只 `unref` 就完事：前者让父进程
 * 不因它挂起，后者补上缺失的监听器，二者缺一不可。
 */
export function openBrowser(url: string): void {
  const warn = (error: unknown): void => {
    console.error('[codearts-auth] failed to open browser; open manually:', url, error)
  }
  const win = process.platform === 'win32'
  if (win) {
    // Windows 下 cmd /c start 会把 URL 中每个 '&' 当作命令分隔符，导致参数被截断
    // （浏览器只收到 '?theme=2'）。必须把整个 URL 加引号作为单个参数传给 cmd，
    // 并用 windowsVerbatimArguments 关闭 Node 的二次转义。start 的窗口标题参数
    // 必须显式传 '""'——空字符串参数会被 Node 丢弃，start 会把 URL 当成标题。
    const args = ['/c', 'start', '""', `"${url}"`]
    try {
      const child = spawn('cmd', args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      child.on('error', warn)
      child.unref()
      return
    } catch (error) {
      warn(error)
      return
    }
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' })
    child.on('error', warn)
    child.unref()
  } catch (error) {
    warn(error)
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
}

/**
 * 从 Windows 注册表取默认浏览器的可执行文件路径与参数模板。
 *
 * ## 为什么需要它（而不是直接用 `openBrowser`）
 *
 * `cmd /c start` 只能把 URL 交给系统默认打开器，**无法附加 `--incognito`**；
 * 而 `window.open` 在客户端也无法请求无痕模式（该标志是进程级启动参数、
 * 不是 JS 能控制的窗口特性）。
 *
 * 故要走无痕只能在宿主侧**直接拉起浏览器可执行文件**，而它的路径只有注册表
 * 这个真相源（用户装的可能是 Chrome / Edge / 360 / Firefox，路径各不相同，
 * 不能硬编码）。读 `UrlAssociations\https\UserChoice` 拿 ProgId，再读该
 * ProgId 的 `shell\open\command`。
 *
 * @returns 可执行文件路径；读不到时 `undefined`（调用方回退到 `openBrowser`）。
 */
export function defaultBrowserExecutable(): string | undefined {
  if (process.platform !== 'win32') return undefined
  // ⚠️ 只用 `reg.exe` 而不引第三方依赖：注册表读取是本功能唯一的平台相关调用，
  //    为它加一个 native 依赖不划算（且本插件的 peer 约束不允许）。
  const query = (key: string, value: string): string | undefined => {
    try {
      const out = execFileSync('reg', ['query', key, '/v', value], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      })
      // 形如：`    ProgId    REG_SZ    360ChromeXURL`
      const m = /REG_SZ\s+(.+?)\s*$/m.exec(out)
      return m?.[1]?.trim()
    } catch {
      return undefined
    }
  }
  const progId = query(
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
    'ProgId',
  )
  if (progId === undefined || progId.length === 0) return undefined
  // ⚠️ 三个位置都要试：`UserChoice` 的 ProgId 可能只注册在 HKCR（合并视图）
  //    或 HKCU\Software\Classes（用户级安装，本机 360 就是这种）。
  for (const root of [
    `HKCR\\${progId}\\shell\\open\\command`,
    `HKCU\\SOFTWARE\\Classes\\${progId}\\shell\\open\\command`,
    `HKLM\\SOFTWARE\\Classes\\${progId}\\shell\\open\\command`,
  ]) {
    try {
      const out = execFileSync('reg', ['query', root, '/ve'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      })
      // 形如：`    (Default)    REG_SZ    "C:\...\360ChromeX.exe" -- "%1"`
      const m = /REG_SZ\s+(.+?)\s*$/m.exec(out)
      const raw = m?.[1]
      if (raw === undefined) continue
      // 取命令行里的**第一个**被引号包裹的路径；没有引号则取到第一个空格前。
      const quoted = /^"([^"]+)"/.exec(raw)
      const exe = quoted?.[1] ?? raw.split(' ')[0]
      if (exe !== undefined && exe.length > 0 && existsSync(exe)) return exe
    } catch { /* 试下一个位置 */ }
  }
  return undefined
}

/**
 * 为一次「换账号登录」准备**独立的浏览器 profile 目录**
 * （Gitee issue IKM741 修法，2026-10-16 真机三次对照实测）。
 *
 * ## 为什么必须按窗口独立（而不是复用默认 profile）
 *
 * 见 {@link openIncognitoWindow} 里那张三格对照表：`--incognito` 的 cookie jar
 * 是**按浏览器进程**共享的，故**只有**「独立 `--user-data-dir`」能让第二个窗口
 * 真正拿到自己的会话。默认 profile 下两个窗口共享 jar ⇒ 第二个号登不进去。
 *
 * ## 生命周期与清理（⚠️ 这里有一条**刻意保守**的取舍）
 *
 * - 目录名带**随机后缀** ⇒ 两次开窗必然不同（同名会被浏览器复用同一个 jar，
 *   那就等于没修）。
 * - ⚠️⚠️ **只清理「够旧」的遗留目录**（超过 {@link STALE_PROFILE_MAX_AGE_MS}），
 *   **不是**「所有其他同前缀目录」。理由：上一轮我第一版写的是后者，那会在
 *   **第一个窗口仍开着**时去删它正在使用的 profile —— Windows 上被占用的文件
 *   删不掉（会被 catch 吞掉），但**部分未占用的文件可能被删成功** ⇒ 那个
 *   正在登录的窗口的 profile 被撕裂。那是我自己引入的、比原缺陷更糟的风险。
 * - 用 6 小时这个阈值是**启发式而非证明**（如实登记）：一次换账号登录在几分钟内
 *   结束，6 小时前的目录不可能还有窗口在用它。**代价**：若用户在同一天内连续
 *   登很多账号，这些目录会保留到 6 小时后才被下次开窗顺手清掉
 *（每个 Chromium profile 目录几 MB 级，不清理会缓慢增长，故需要这个闸门）。
 * - ⚠️ **绝不删本次刚建的那个**：浏览器此刻正在用它。
 */
function prepareIncognitoProfileDir(nowMs = Date.now()): string {
  const prefix = INCOGNITO_PROFILE_PREFIX
  const dir = join(tmpdir(), `${prefix}${randomBytes(8).toString('hex')}`)
  // 清「够旧」的遗留：同前缀、不是本次这个、且 mtime 超过阈值。
  // ⚠️ 清理是**尽力而为**（失败一律忽略），绝不该阻断登录。
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (!entry.startsWith(prefix)) continue
      const stale = join(tmpdir(), entry)
      if (stale === dir) continue
      try {
        const age = nowMs - statSync(stale).mtimeMs
        if (age <= STALE_PROFILE_MAX_AGE_MS) continue
        rmSync(stale, { recursive: true, force: true })
      } catch { /* 正被某个窗口使用 ⇒ 留给下次（这正是阈值要保护的情形） */ }
    }
  } catch { /* 读不到 tmp 目录 ⇒ 跳过清理 */ }
  try {
    mkdirSync(dir, { recursive: true })
  } catch { /* 建不出来也照常传参：浏览器会自己尝试创建 */ }
  return dir
}

/** 独立 profile 目录的前缀（清理时按它筛；同前缀才可能是我们留下的）。 */
const INCOGNITO_PROFILE_PREFIX = 'dsh-officeace-login-'

/**
 * 遗留 profile 目录的保留时长（6 小时）。
 *
 * ⚠️ 这是**启发式**：它的作用是「保证不删可能正在被窗口使用的目录」，
 * 而不是「精确判断谁在用」。取值远大于任何一次登录交互（分钟级）。
 */
const STALE_PROFILE_MAX_AGE_MS = 6 * 60 * 60 * 1000

/**
 * 构造**无痕窗口**的浏览器命令行参数 —— 抽成**纯函数**以便确定性地单测
 * （Gitee issue IKM741 修法）。
 *
 * ⚠️ 抽出来的理由与 `officeacePendingTtlMs` 同源：`openIncognitoWindow` **会真的
 * `spawn` 浏览器**，故它本身在单测里被 `NODE_ENV === 'test'` 断路器挡住 ⇒
 * 「参数到底传对了没有」这一格**在单测里不可达**。把参数构造抽成纯函数后，
 * 这一格可以在零副作用下被逐项断言（本仓库既有范式：`raccoonDefaultEffort`）。
 *
 * @param exe - 浏览器可执行文件（只看是否 Firefox 决定分支）。
 * @param url - 授权页 URL。
 * @param profileDir - **本次专用的**独立 profile 目录（须每次不同）。
 */
export function incognitoWindowArgs(exe: string, url: string, profileDir: string): string[] {
  // ⚠️ Firefox 用 `-private-window` 且**不认** `--user-data-dir`（它用 `-profile`），
  //    故**刻意不给它加**该参数（加了会被当成未知参数）。
  //
  // ⚠️⚠️ **如实登记一处未修的缺口**：Firefox 的 `-private-window` 之间同样会
  //    **共享**私有浏览会话 ⇒ Firefox 上「连续新建两个账号」仍会复用同一个号。
  //    本机**没有 Firefox**，无法实测 `-profile <新目录>` 能否真正隔离 ——
  //    按仓库铁律「拿不到阈值就不定值」，故**不凭猜测**改它。
  if (/firefox\.exe$/i.test(exe)) return ['-private-window', url]
  return [`--user-data-dir=${profileDir}`, '--incognito', '--new-window', url]
}

/**
 * 用**无痕窗口**打开 URL（华为云 OAuth 换账号登录用）。
 *
 * ## 为什么必须无痕（实测依据，2026-10-13）
 *
 * 华为 `authui` 会**静默复用**浏览器已有的登录会话：带着已登录 cookie 打开
 * 授权页会直接放行，**看不到登录框**，于是「新建账号」永远只能建出同一个号。
 * 实测三条：
 *
 * | 试验 | 结果 |
 * |---|---|
 * | `authui/login.html?service=<authorize>` | 200 直接返回页面（复用会话）|
 * | authorize 追加 `&prompt=login` | **仍 200，无重定向** ⇒ authui 忽略该参数 |
 * | `authui/logout?service=<authorize>` | 302 先清会话再跳 authorize |
 *
 * ⇒ 只有两条路：先 logout，或换一个 cookie jar。**选后者**：
 * `logout` 的作用域是整个 `auth.huaweicloud.com` 域（实测 `Set-Cookie` 含
 * `cloud_verify_ticket` 清除与 `IAMIdentity` 重写），会**连带登出用户日常浏览器
 * 里的华为云控制台**；无痕窗口则是全新 cookie jar，天然无会话，
 * **既不碰用户既有会话、也不需要 logout**。
 *
 * ⚠️ 官方客户端（果办）也没有解决这点：它的 `LoginPage` 用
 * `window.open(url, 'officeclaw-login', 'popup,…')` 开共享 cookie 的小窗，
 * 「重新登录」则走 `authui/logout`（`LoginCallbackPage`）。即官方同样无法
 * 换账号登录 —— 别把它当参考实现。
 *
 * @returns 是否成功以无痕方式拉起（`false` 时调用方应回退到普通打开）。
 */
export function openIncognitoWindow(url: string): boolean {
  // ⚠️⚠️ **测试环境断路器**（2026-10-13，我自己踩出来的真实污染）。
  //
  // 本函数**会真的 spawn 浏览器**。而 `officeace-rpc-multi-account.spec.ts`
  // 之类的用例会走**真实的 `account.create` RPC**，其桩数据里带着
  // `authorizeUrl: 'https://auth.huaweicloud.com/stub'` ⇒ 每跑一次 `pnpm test`
  // 就在用户桌面上弹一个 `auth.huaweicloud.com/stub` 窗口。
  //
  // ⇒ 判据用 `NODE_ENV === 'test'`（Vitest 会设）。**返回 `false` 而不是抛错**：
  // 调用方据此走正常的「回退到 window.open」分支，断言形态与生产一致，
  // 唯一的差别是不真开窗 —— 这正是单测想要的。
  //
  // ⚠️ 不要改成「检测到 stub URL 就跳过」：那是**按数据打补丁**，
  // 下一个用例换个 URL 就会复发。必须按**运行环境**一刀切断。
  if (process.env.NODE_ENV === 'test') return false
  const exe = defaultBrowserExecutable()
  if (exe === undefined) return false
  // ⚠️⚠️ **不要用「app 模式」开关**（2026-10-13 真机实测证伪，阻断级）。
  //
  // 初版传了「app 模式」+ URL，想让窗口去掉地址栏、视觉上更像个授权小窗。
  // 在 360 极速浏览器 X（本机默认浏览器）上实测：窗口开了，但页面显示
  //   「域名解析错误 —— 请检查域名拼写，可用"360断网急救箱"检查网络」
  // 即它把该开关后面的值当成**域名/搜索词**去解析了，而不是当成 URL。
  //
  // 隔离探针（本地 HTTP 服务器 + 独立 `--user-data-dir`）显示该开关本身
  // 能被 Chromium 正确解析并发出请求 ⇒ 这是**该浏览器对它的改写/拦截**，
  // 不是我们的 URL 编码问题（实测 28 个 `%` 序列逐字送达服务器）。
  //
  // ⇒ 结论：**换取账号这个核心目的不依赖「app 模式」**，而它带来的失败是
  // 阻断级（用户看到的是一个错误页，根本无法登录）。故只用无痕开关，
  // 窗口形态交给浏览器（有地址栏，但功能完全正确）。
  //
  // ⚠️ 无痕开关是 Chromium 家族的通用参数（Chrome / Edge / 360 / Brave /
  //    Vivaldi 等）。Firefox 用 `-private-window` 且不认它 —— **分支判定在
  //    `incognitoWindowArgs` 里**（那是纯函数，可被单测逐项断言；
  //    本函数因会真开窗而在单测里被断路器挡住）。
  //
  // ⚠️⚠️ **每次开窗都必须给一个独立的 `--user-data-dir`**（Gitee issue IKM741
  //    真机实测，2026-10-16）。
  //
  // 为什么单靠 `--incognito` **不够**（本轮实证）：原实现只传 `--incognito`，
  // 注释里写「无痕窗口 = 全新 cookie jar」。那句话对**第一个**窗口成立，对
  // **第二个**不成立 —— Chromium 的 `--incognito` 是**按浏览器进程**共享一个
  // 临时 cookie jar，**不是每窗口一个**。第一个窗口还开着时，第二个
  // `--incognito` 只是**加入同一个 jar**。
  //
  // 真机三次测量的对照（本地 HTTP 服务器按「是否已带 `jar` cookie」决定要不要
  // 重种，故回报里的 cookie 值直接暴露 jar 是否共享）：
  //   场景 A：`--incognito` ×2（同一 profile）      ⇒ A43993 / **A43993** ❌ 共享
  //   场景 B：独立 profile ×2（**无** incognito）    ⇒ C85845 / D85845    ✅ 隔离
  //   场景 C：**独立 profile + `--incognito`** ×2    ⇒ E88407 / F88407    ✅ 隔离
  // ⚠️ B 与 C 都测是**刻意的**（本仓库纪律：对照矩阵必须检查每个变量是否真的
  //    独立）—— 只测 B 会让 `--incognito` 这个变量没被验证，而修法恰恰要带上它。
  //
  // 端到端后果（真实账号登录，同一次 e2e 运行）：
  //   第一个号耗时 83 秒 → 登录框出现了，用户真的操作了
  //   第二个号耗时  4 秒 → 人类不可能这么快 ⇒ 授权页**直接放行**
  //   两者云侧 `accountId` **完全相同** ⇒ 两次登的是**同一个华为号**
  //
  //    ⇒ 「华为 authui 静默复用会话」这条**根因判断是对的**，但初版修法
  //    **只挡住了一半**：它防住了「复用用户**日常浏览器**的会话」，没防住
  //    「复用**我们上一个无痕窗口**的会话」。用户报障「新建账号那个链接就自动
  //    用之前登录的账号授权了」的**后半句**（连续新建两个号）正是这一格。
  //
  // 目录的生命周期：用**独立的临时目录**而不是复用浏览器默认 profile
  //（复用默认 profile 就等于**没有**隔离，那正是缺陷）；目录名带随机后缀
  // ⇒ 两次开窗必然不同；启动时只清**够旧**的遗留目录（见
  // `prepareIncognitoProfileDir` 的保留时长取舍）。
  const profileDir = prepareIncognitoProfileDir()
  const args = incognitoWindowArgs(exe, url, profileDir)
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
    // ⚠️ 必须挂 'error' 监听器 + unref：理由见 `openBrowser` 的长注释
    //    （spawn 的失败是异步 'error' 事件，外层 try/catch 接不住，
    //    无监听器时会变成未捕获异常把宿主带走）。
    child.on('error', (error) => {
      console.error('[codearts-auth] failed to open incognito window:', error)
    })
    child.unref()
    return true
  } catch (error) {
    console.error('[codearts-auth] failed to open incognito window:', error)
    return false
  }
}

function pickToken(params: URLSearchParams): string {
  return params.get('token')
    ?? params.get('access_token')
    ?? params.get('accessToken')
    ?? params.get('authCode')
    ?? ''
}

/** 浏览器重定向的本地回调服务器；当某个分支完成时 resolve `result`。 */
export function startCallbackServer(
  ticketId: string,
  secret: string,
  options: LoginFlowOptions,
): Promise<{ port: number; server: ReturnType<typeof createServer>; result: Promise<LoginFlowResult> }> {
  let resolveResult!: (value: LoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`)
    if (url.pathname !== '/authentication' && !url.pathname.startsWith('/authentication')) {
      response.writeHead(404).end('Not found')
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS).end()
      return
    }
    const params = url.searchParams
    const directToken = pickToken(params)
    if (directToken) {
      response.writeHead(200, CORS_HEADERS).end()
      resolveResult({ access: directToken, expires: Date.now() + 86_400_000, loginUrl: '' })
      return
    }
    const fingerprint = params.get('fingerprint')
    if (fingerprint) {
      try {
        const decoded = Buffer.from(fingerprint, 'base64').toString()
        const fpToken = pickToken(new URL(decoded).searchParams)
        if (fpToken) {
          response.writeHead(200, CORS_HEADERS).end()
          resolveResult({ access: fpToken, expires: Date.now() + 86_400_000, loginUrl: '' })
          return
        }
      } catch {
        /* fingerprint 格式错误：继续到 400 */
      }
    }
    const callbackSecret = params.get('secret')
    if (callbackSecret) {
      response.writeHead(200, CORS_HEADERS).end()
      void pollForCredential(ticketId, callbackSecret, options).then(
        (credential) => resolveResult({
          access: JSON.stringify(credential),
          expires: expiresFromCredential(credential),
          loginUrl: '',
        }),
        (error) => rejectResult(error),
      )
      return
    }
    response.writeHead(400).end('Missing token or secret')
  })

  return new Promise((resolveStart, rejectStart) => {
    server.on('error', (error) => rejectStart(error))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveStart({ port, server, result })
    })
  })
}

/** 运行完整的浏览器登录流程，返回已存储的凭据值。 */
export async function runLoginFlow(options: LoginFlowOptions = {}): Promise<LoginFlowResult> {
  const ticketId = randomUUID()
  const secret = generateRandomSecret()
  const { port, server, result } = await startCallbackServer(ticketId, secret, options)
  const { loginUrl } = buildLoginUrl(port, ticketId)
  try {
    const opener = options.openBrowser ?? openBrowser
    await opener(loginUrl)
    const outcome = await result
    return { ...outcome, loginUrl }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** 新式 IAM OAuth 的 portal 授权端点（对齐真实插件的 getPortalHost + /authorize）。 */
export const PORTAL_AUTHORIZE_BASE = 'https://codearts.huaweicloud.com/portal/authorize'
/** portal 登录结果页（登录完成后重定向目标，对齐真实插件回调处理器的 login_succeed 页）。 */
export const PORTAL_LOGIN_BASE = 'https://codearts.huaweicloud.com/portal/login'

/** 构建 portal 登录结果页 URL（真实插件在回调成功后 307 重定向到此页）。 */
export function buildPortalLoginResultUrl(succeeded: boolean): string {
  return `${PORTAL_LOGIN_BASE}?login_succeed=${succeeded}&uri_scheme=${CLIENT_ID}&locale=${OAUTH_LOCALE}`
}
/** portal 期望的插件名（逆向常量，硬编码）。 */
export const LOGIN_PLUGIN_NAME = 'snap_AIIDE'
/** portal 期望的插件版本（逆向常量，硬编码为真实扩展版本，勿用本包版本）。 */
export const LOGIN_PLUGIN_VERSION = '5.2.0'
/** 主题色 kind（对齐 IDE 的 activeColorTheme.kind：2 = Dark）。 */
export const OAUTH_THEME = '2'
/** 界面语言（对齐 env.language）。 */
export const OAUTH_LOCALE = 'zh-cn'

/** 构建新式 IAM OAuth 的 portal 授权 URL（参数完全对齐真实插件 buildLoginUrl）。 */
export function buildOAuthLoginUrl(port: number, pkce: PkcePair, ticketId: string): string {
  return `${PORTAL_AUTHORIZE_BASE}?theme=${OAUTH_THEME}&locale=${OAUTH_LOCALE}`
    + `&uri_scheme=${CLIENT_ID}&client_id=${CLIENT_ID}&port=${port}`
    // code_challenge_method 对齐真实插件 PKCEGenerator.CODE_CHALLENGE_METHOD = "SHA-256"
    // （非 RFC 标准缩写 S256；portal 以此识别 OAuth 授权，错值会回退旧 ticket 流程）。
    + `&code_challenge=${pkce.codeChallenge}&code_challenge_method=SHA-256`
    // 注意：真实插件 URL 不含 auth_callback_url——portal 仅凭 port 参数构造回调。
    // 多余的 auth_callback_url 会被 portal 视为异常并回退旧流程，切勿添加。
    + `&ticket_id=${ticketId}&plugin-name=${LOGIN_PLUGIN_NAME}&plugin-version=${LOGIN_PLUGIN_VERSION}`
}

/**
 * OAuth 回调收码闸门 —— 授权码**唯一的落点**（手动回调链接）。
 *
 * ## 为什么抽出来
 *
 * `code` 有两条来路：
 * 1. 浏览器被 portal 跳回本地回调服务器（原路径）；
 * 2. 用户在**别的设备**上完成登录后，把回调链接**手动粘贴**进设置页。
 *
 * 手机/另一台电脑的浏览器打不开宿主本机的 `127.0.0.1:<port>`，那条跳转必然失败，
 * 但地址栏里躺着一个**合法的 code** —— 它只对签发它的 PKCE/DPoP 与端口有效。
 *
 * 两条来路必须**走同一段收码逻辑**：code 一次性、只能换一次；换取用的
 * `code_verifier` / DPoP 密钥对 / 回调端口三者缺一不可
 * （`redirect_uri` 必须与授权时逐字一致，见 `exchangeAuthorizationCode`）。
 * 若手动那条另写一套，必然出现「一条能换、一条换不了」或「各换一次把 code 烧掉」。
 *
 * ## 幂等与竞态
 *
 * `settled` 闸门是必须的：用户可能在浏览器跳转成功的**同一瞬间**又粘一次，
 * 或先粘错再粘对 ⇒ 第二次 `exchangeAuthorizationCode` 必然报 code 已被使用，
 * 不拦就会把**已经成功**的那次结果 reject 掉。
 */
function createOAuthCallbackReceiver(
  ticketId: string,
  pkce: PkcePair,
  keyPair: DpopKeyPair,
  options: LoginFlowOptions,
): OAuthCallbackReceiver {
  let resolveResult!: (value: LoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  let settled = false

  const acceptSecret = (secret: string): boolean => {
    if (settled || typeof secret !== 'string' || secret.trim() === '') return false
    settled = true
    // 旧流程回退：portal 判定 OAuth 授权不可用时以 secret+redirect 回调。
    // 后台轮询 ticket 端点换取凭据（plugin-name/version 必须用 portal 那套）。
    void pollForCredential(ticketId, secret.trim(), {
      ...options,
      pluginName: LOGIN_PLUGIN_NAME,
      pluginVersion: LOGIN_PLUGIN_VERSION,
    }).then(
      (credential) => resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: '' }),
      (error) => rejectResult(error),
    )
    return true
  }

  /**
   * 用授权码换凭据（新式流程）。
   *
   * @param port - `redirect_uri` 里的端口，**必须是 portal 看到的那个**：
   *   本地服务器这条腿是它自己的监听端口；手动粘贴这条腿来自**链接本身**。
   *   ⚠️ 不能改用手动路径时「当前服务器」的端口 —— 那是另一个地址，
   *   STS 会以 `redirect_uri` 不匹配直接拒掉。
   * @returns 交换结果（**永不拒绝**）；已被占用或参数不合法时 `undefined`。
   *
   * ⚠️⚠️ 返回的 promise **绝不能 reject**：手动提交那条路径会丢弃它
   *   （只关心「有没有接管」），一个被丢弃的拒绝就是**未处理的 Promise 拒绝**
   *   ⇒ 宿主日志里冒出 `Unhandled Rejection`，而用户其实只是粘错了一条链接。
   *   真实成败仍由 `result` 的 resolve/reject 表达（那是调用方 await 的那一个）。
   */
  const acceptCode = (code: string, port: number): Promise<boolean> | undefined => {
    if (settled || typeof code !== 'string' || code.trim() === '') return undefined
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined
    // 先占住闸门：换 token 是一次网络往返，期间的重复提交必须被拒。
    settled = true
    return exchangeAuthorizationCode(code.trim(), pkce.codeVerifier, port, keyPair, options.fetcher)
      .then((token) => {
        const credential = credentialFromTokenResponse(token, pkce, keyPair)
        resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: '' })
        return true
      }, (error) => {
        rejectResult(error instanceof Error ? error : new Error(String(error)))
        // 浏览器那一侧据此把 307 跳到 login_succeed=false；本 promise 不 reject。
        return false
      })
  }

  return { result, acceptCode, acceptSecret, isSettled: () => settled }
}

/** 新式 OAuth 的本地回调服务器：收到 code（新流程）或 secret（旧流程回退）后换取凭据并 resolve。 */
export function startOAuthCallbackServer(
  ticketId: string,
  pkce: PkcePair,
  keyPair: DpopKeyPair,
  options: LoginFlowOptions,
): Promise<{ port: number; server: ReturnType<typeof createServer>; result: Promise<LoginFlowResult>; receiver: OAuthCallbackReceiver }> {
  const receiver = createOAuthCallbackReceiver(ticketId, pkce, keyPair, options)

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`)
    if (url.pathname !== REDIRECT_PATH && !url.pathname.startsWith(REDIRECT_PATH)) {
      response.writeHead(404).end('Not found')
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS).end()
      return
    }
    // 旧流程回退：portal 判定 OAuth 授权不可用时以 secret+redirect 回调。
    // 对齐真实插件：立即 307 重定向到 redirect 参数，后台轮询 ticket 端点换取凭据。
    const callbackSecret = url.searchParams.get('secret')
    if (callbackSecret) {
      const redirectTo = url.searchParams.get('redirect') ?? buildPortalLoginResultUrl(true)
      response.writeHead(307, { ...CORS_HEADERS, Location: redirectTo }).end()
      receiver.acceptSecret(callbackSecret)
      return
    }
    const code = url.searchParams.get('code')
    if (code) {
      // localPort 在监听中的服务器上必然存在；?? 0 仅用于类型收窄。
      const exchanged = receiver.acceptCode(code, request.socket.localPort ?? 0)
      if (exchanged === undefined) {
        response.writeHead(400).end('This callback is already in progress')
        return
      }
      // 对齐真实插件：换取成功 307 到 login_succeed=true，失败则 307 到 false。
      // ⚠️ `acceptCode` 的 promise **永不 reject**，故这里只需判布尔值。
      exchanged.then((succeeded) => {
        response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(succeeded) }).end()
      })
      return
    }
    response.writeHead(400).end('Missing authorization code or secret')
  })

  return listenOnCallbackPort(server).then((port) => ({ port, server, result: receiver.result, receiver }))
}

/** 新式 OAuth 回调等待预算（浏览器打开 + 用户操作，180 秒）。 */
const OAUTH_CALLBACK_TIMEOUT_MS = 180_000
/** 回调端口下限（对齐真实插件对回调端口的 ≥10000 要求）。 */
const MIN_CALLBACK_PORT = 10_000

/** 启动回调服务器并确保监听端口 ≥10000（真实插件要求，低端口会被 portal 拒绝）。 */
function listenOnCallbackPort(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        const assigned = typeof address === 'object' && address ? address.port : 0
        if (assigned >= MIN_CALLBACK_PORT) {
          resolve(assigned)
          return
        }
        // 端口 < 10000：关闭后用随机 [10000, 65535] 端口重试（对齐真实插件）。
        server.close(() => {
          const retry = Math.floor(Math.random() * (65_536 - MIN_CALLBACK_PORT)) + MIN_CALLBACK_PORT
          tryListen(retry)
        })
      })
    }
    tryListen(0)
  })
}

/** 手动回调链接解析失败时统一使用的前缀（RPC 层原样展示，不再改写）。 */
export const MANUAL_CALLBACK_FAIL_PREFIX = '回调链接无法使用'

/** 手动粘贴的回调链接解析结果。 */
export type ManualCallbackParseResult =
  | { kind: 'code'; code: string; port: number }
  | { kind: 'secret'; secret: string }
  | { kind: 'error'; code: ManualCallbackErrorCode; message: string }

/** 解析失败的原因码（`message` 才是给用户看的文案）。 */
export type ManualCallbackErrorCode =
  | 'EMPTY'
  | 'NOT_A_URL'
  | 'NOT_LOOPBACK'
  | 'WRONG_PATH'
  | 'NO_PORT'
  | 'PORT_OUT_OF_RANGE'
  | 'NO_CODE'

/** 本机回调允许的主机名（portal 只会把浏览器跳到这些）。 */
const MANUAL_CALLBACK_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
/** 形如 `https://…` 的绝对 URL。 */
const MANUAL_CALLBACK_ABSOLUTE_URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
/** 回调路径（与 `REDIRECT_PATH` 同值；此处独立一份是为了让解析器不依赖导入顺序）。 */
const MANUAL_CALLBACK_PATH = '/oauth/callback'

const MANUAL_CALLBACK_REASONS: Readonly<Record<ManualCallbackErrorCode, string>> = {
  EMPTY: '回调链接是空的。请把手机（或另一台电脑）浏览器地址栏里的整条链接复制过来粘贴。',
  NOT_A_URL: '这不像一条回调链接（无法解析成网址）。请从地址栏整条复制，不要只复制一部分。',
  NOT_LOOPBACK: '这条链接的主机不是本机回调地址。授权回调只会跳转到 127.0.0.1 / localhost —— '
    + '若你复制的是 portal 的结果页（codearts.huaweicloud.com/portal/login…），它不含授权码。',
  WRONG_PATH: '这条链接的路径不是授权回调路径（应为 /oauth/callback）。'
    + 'portal 的「登录成功」结果页不含授权码，请回到跳转失败的那一页复制地址栏。',
  NO_PORT: '这条回调链接里没有可用的端口号，无法知道是哪一轮登录的回调。请整条复制（应含 :端口）。',
  PORT_OUT_OF_RANGE: '这条链接的端口号超出有效范围（1–65535），不像真实的授权回调地址。',
  NO_CODE: '这条回调链接里既没有 code 也没有 secret，无法完成登录。'
    + '请确认复制的是「跳转失败 / 无法访问」那一页的地址栏，而不是已成功的页面。',
}

function manualCallbackError(code: ManualCallbackErrorCode): ManualCallbackParseResult {
  return { kind: 'error', code, message: MANUAL_CALLBACK_REASONS[code] }
}

function manualCallbackPort(text: string): number | undefined {
  if (!/^\d{1,5}$/.test(text)) return undefined
  const port = Number(text)
  return port > 0 && port <= 65_535 ? port : undefined
}

/** 从一段文本里抓显式声明的端口（`new URL` 对越界端口会直接抛，故先自己判）。 */
function manualCallbackDeclaredPort(text: string): string | undefined {
  const match = /:(\d{1,5})(?=[/?#]|$)/.exec(text)
  return match === null ? undefined : match[1]
}

function manualCallbackReadParams(
  params: URLSearchParams,
  port: number | undefined,
): ManualCallbackParseResult {
  const code = params.get('code')
  if (typeof code === 'string' && code.trim().length > 0) {
    if (port === undefined) return manualCallbackError('NO_PORT')
    return { kind: 'code', code: code.trim(), port }
  }
  const secret = params.get('secret')
  if (typeof secret === 'string' && secret.trim().length > 0) {
    return { kind: 'secret', secret: secret.trim() }
  }
  return manualCallbackError('NO_CODE')
}

function manualCallbackParseAbsolute(text: string): ManualCallbackParseResult {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    const rest = text.split('://')[1] ?? ''
    const declared = manualCallbackDeclaredPort(`http://${rest}`)
    if (declared !== undefined && manualCallbackPort(declared) === undefined) {
      return manualCallbackError('PORT_OUT_OF_RANGE')
    }
    return manualCallbackError('NOT_A_URL')
  }
  if (!MANUAL_CALLBACK_LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return manualCallbackError('NOT_LOOPBACK')
  }
  if (url.pathname !== MANUAL_CALLBACK_PATH && !url.pathname.startsWith(MANUAL_CALLBACK_PATH)) {
    return manualCallbackError('WRONG_PATH')
  }
  return manualCallbackReadParams(url.searchParams, manualCallbackPort(url.port))
}

function manualCallbackParseQueryOnly(text: string): ManualCallbackParseResult {
  const hashAt = text.indexOf('#')
  const withoutHash = hashAt >= 0 ? text.slice(0, hashAt) : text
  const questionAt = withoutHash.indexOf('?')
  let query: string
  if (withoutHash.startsWith('?')) {
    query = withoutHash.slice(1)
  } else if (questionAt >= 0) {
    query = withoutHash.slice(questionAt + 1)
  } else {
    query = withoutHash
  }
  return manualCallbackReadParams(new URLSearchParams(query), undefined)
}

/**
 * 解析用户在**另一台设备**上复制回来的 OAuth 回调链接 —— 纯函数。
 *
 * ## 为什么需要它
 *
 * portal 把授权跳转定向到宿主本机的 `http://127.0.0.1:<port>/oauth/callback?code=…`。
 * 用户在手机上完成登录时，那个浏览器打不开宿主所在的 `127.0.0.1` ⇒ 跳转必然失败，
 * 但地址栏里留下一条**完全合法**的回调链接。用户把它复制回来粘贴，
 * 就能在本机完成原来只有浏览器才能完成的那一跳。
 *
 * ## 纪律
 *
 * 1. **纯函数**：结果只取决于入参，故每一种坏输入都能在单测里逐条断言。
 * 2. **文案由这里给出**：调用方不得再各写一份同义判据。
 * 3. 返回的 `port` 一律是**链接里那个**端口，绝不是「当前服务器」的端口 ——
 *    `redirect_uri` 必须与授权时逐字一致。
 *
 * @param raw - 用户粘贴的原文（允许首尾空白、尖括号、引号包裹）。
 */
export function parseManualCallbackUrl(raw: unknown): ManualCallbackParseResult {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return manualCallbackError('EMPTY')
  // 从邮件 / 微信 / 文档里复制时常见的包裹字符。
  const stripped = text.replace(/^[<"']+|[>"']+$/g, '').trim()
  if (stripped.length === 0) return manualCallbackError('EMPTY')
  if (MANUAL_CALLBACK_ABSOLUTE_URL_RE.test(stripped)) {
    return manualCallbackParseAbsolute(stripped)
  }
  const looksLikeQuery = stripped.includes('?') || stripped.startsWith('#')
    || /^(?:code|secret)=/.test(stripped) || /[?&](?:code|secret)=/.test(stripped)
  if (looksLikeQuery) return manualCallbackParseQueryOnly(stripped)
  return manualCallbackError('NOT_A_URL')
}

/** 一轮 OAuth 回调的收码器（本地回调服务器与手动粘贴链接共用同一个实例）。 */
export interface OAuthCallbackReceiver {
  /** 这一轮的最终结果；成功后 resolve 凭据，失败后 reject。 */
  result: Promise<LoginFlowResult>
  /**
   * 用授权码换凭据。已被占用或端口不合法时返回 `undefined`（**不抛**）。
   *
   * @param port - `redirect_uri` 里的端口，必须与 portal 授权时那个一致。
   */
  acceptCode: (code: string, port: number) => Promise<boolean> | undefined
  /** 旧流程回退：用 secret 轮询 ticket 端点。已被占用或不合法时返回 `false`。 */
  acceptSecret: (secret: string) => boolean
  /** 这一轮是否已经落定（成功或失败）。 */
  isSettled: () => boolean
}

/**
 * 已启动但尚未完成的 OAuth 登录流程。
 *
 * 拆出这一层是为了支持**两步式登录**（Jet Hub 的「+ 新建账号」）：
 * 调用方先拿到 `loginUrl` 立刻打开窗口，再自行 await `result`。
 *
 * 为什么必须拆：浏览器只在用户点击后的短暂窗口（transient activation，
 * 约 5 秒）内允许 `window.open`。若把「起服务器 → 打开浏览器 → 等用户授权」
 * 整个流程做成一次阻塞调用，调用方拿到 URL 时手势早已过期，`window.open`
 * 会被弹窗拦截器拒绝。
 */
export interface StartedOAuthFlow {
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 用户完成授权（或超时/失败）后落定的结果。 */
  result: Promise<LoginFlowResult>
  /** 关闭回调服务器；**幂等**，可重复调用。 */
  close: () => Promise<void>
  /**
   * 手动提交回调链接（另一台设备完成登录后，把地址栏整条链接粘回来）。
   *
   * ⚠️ 只解析 + 交给**同一轮**的收码器，不另写一套换取逻辑：
   * 两处各写一份必然出现「一条能换、一条换不了」或「各换一次把 code 烧掉」。
   * ⚠️ 失败**返回可读文案而不抛**：RPC 层原样回给前端，用户输入错误
   * 不该让宿主进程异常退出。
   */
  submitManualCallback: (raw: unknown) => ManualCallbackSubmitResult
}

/** `StartedOAuthFlow.submitManualCallback` 的结果。 */
export interface ManualCallbackSubmitResult {
  ok: boolean
  /** 失败时可直接展示给用户的原因。 */
  message?: string
}

/**
 * 启动 OAuth 登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * `result` 已内置超时：两步式路径没有外层 try/finally 兜底，
 * 若超时不在此处生效，回调服务器会一直挂着。
 * 结果一旦落定就自动关闭服务器，避免两步式路径泄漏监听端口。
 */
export async function startOAuthFlow(options: LoginFlowOptions = {}): Promise<StartedOAuthFlow> {
  const ticketId = randomBytes(32).toString('hex')
  const pkce = generatePkcePair()
  const keyPair = await generateDpopKeyPair()
  const { port, server, result, receiver } = await startOAuthCallbackServer(ticketId, pkce, keyPair, options)
  const loginUrl = buildOAuthLoginUrl(port, pkce, ticketId)

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const resultWithUrl = Promise.race([
    result,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('CodeArts OAuth login timed out')), OAUTH_CALLBACK_TIMEOUT_MS)
      timer.unref?.()
    }),
  ]).then((outcome) => ({ ...outcome, loginUrl }))

  // 先挂一个空处理器：结果可能在调用方 await 之前就落定（用户授权极快、
  // 或立刻超时），那一段窗口里 Node 会把它当成未处理拒绝并打印告警。
  resultWithUrl.catch(() => {}).finally(() => { void close() })

  /**
   * 手动提交回调链接（另一台设备完成登录后粘回来）。
   *
   * ⚠️ 不另写收码逻辑：只解析并交给**同一轮**的 `receiver`。
   * ⚠️ 端口一律取链接里的那个 —— `redirect_uri` 必须与授权时逐字一致。
   */
  const submitManualCallback = (raw: unknown): ManualCallbackSubmitResult => {
    const parsed = parseManualCallbackUrl(raw)
    if (parsed.kind === 'error') {
      return { ok: false, message: `${MANUAL_CALLBACK_FAIL_PREFIX}：${parsed.message}` }
    }
    const accepted = parsed.kind === 'code'
      ? receiver.acceptCode(parsed.code, parsed.port) !== undefined
      : receiver.acceptSecret(parsed.secret)
    if (!accepted) {
      return {
        ok: false,
        message: '这轮登录已经结束了（成功或超时），这份回调未再使用。请重新点击「+ 新建账号」。',
      }
    }
    return { ok: true }
  }

  return { loginUrl, result: resultWithUrl, close, submitManualCallback }
}

/**
 * 运行完整的新式 IAM OAuth 登录流程（默认登录方式）。
 *
 * 阻塞语义：打开浏览器并等待用户完成授权后才返回。
 * 需要「立即拿到 URL」的场景（Jet Hub 两步式登录）请用 {@link startOAuthFlow}。
 */
export async function runOAuthFlow(options: LoginFlowOptions = {}): Promise<LoginFlowResult> {
  const started = await startOAuthFlow(options)
  try {
    const opener = options.openBrowser ?? openBrowser
    await opener(started.loginUrl)
    return await started.result
  } finally {
    await started.close()
  }
}
