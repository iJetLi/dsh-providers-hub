/**
 * 超级麦吉（magicrew）**网页版登录**：开一个**独立 profile** 的浏览器窗口、让用户在里面
 * 完成登录，再从那个 profile 的 localStorage 里把凭据读回来。
 *
 * ## 三条登录路径里的第 ② 条
 *
 * | # | 路径 | 门槛 | 实现 |
 * |---|---|---|---|
 * | ① | 从本机浏览器已登录态导入（免开窗） | 零（用户日常浏览器里已登过） | `magicrew-local-browser.ts` |
 * | ② | **网页版登录（本文件）** | 低（开一个干净窗口，用户扫码/输密码） | `startMagicrewBrowserLogin` |
 * | ③ | 手机号 + 密码（宿主侧直接调上游） | 中（要密码，且上游有风控） | `loginMagicrew` |
 *
 * ②存在的原因：①在「用户从没在本机浏览器登过这个站」「用户用的是另一个 profile」
 * 两种情形下**读不到**（且那两种情况与「没登录」在结果上同形）；③要用户把密码交给插件。
 * ②是唯一「用户自己看着官方页面登录、凭据自然落盘」的路径。
 *
 * ## ⚠️⚠️ 为什么必须有**独立 profile**（不是复用用户真实浏览器）
 *
 * 两个理由，各自都踩过：
 *
 * 1. **不能碰用户的 profile**：真实 profile 里有用户的全部 cookie / 会话 / 书签，
 *    且**已被用户自己的浏览器进程独占**（`SingletonLock`）—— 拿它起第二个实例，
 *    Chromium 会把 URL 转交给已存在的实例、自己退出（CDP 端口永远不就绪）。
 * 2. **独立 profile 让「读到的凭据只可能是本次登录写进去的」**：一次性目录从空开始，
 *    于是「读到凭据」这件事本身就能当登录完成的判据。⚠️ 参考实现
 *    （`magpie-magicrew-auth/src/browser-login.mjs` 的 `newProfileDir` 注释）记录过
 *    复用目录的后果：第二个账号登录时一秒内读到**上一个账号**的 jwt ⇒ 建不出新账号
 *    （同一个 accountId/uid 被按契约判成「替换旧账号」）。
 *
 * ## ⚠️⚠️ 打开的是**网页域** `product.webOrigin`，不是 API 子域 `product.host`
 *
 * magicrew 的网页在 `https://www.letsmagic.cn`、API 在
 * `https://i-magic-service.letsmagic.cn`（`product.host`）。localStorage 的 key 是
 * `_https://<origin>\x00\x01<name>`，而**用户只会、也只能在网页域上登录** ——
 * 打开 API 子域会得到一个没有页面的域名（用户当场就懵），按它去扫 localStorage
 * 则**恒读不到**且完全静默。这两格都真实发生过（上一个任务踩过第一个）。
 *
 * ## 读凭据：复用 `magicrew-local-browser.ts`，**不要**重写一份配对逻辑
 *
 * 凭据的配对判据（`"key":"authorization"` × `"key":"organizationCode"`、按 origin
 * 截断窗口、每把 jwt 配**它自己后面**最近的组织码）是**上游错配 ⇒ HTTP 200 +
 * `code:403`** 换来的，只允许有一份实现。⇒ 本文件只做三件事：把
 * `readMagicrewLocalCreds` 的 `roots` 指到**本次的临时 profile 目录**、通过 CDP 读
 * **实时** localStorage、以及轮询。
 *
 * ## ⚠️⚠️ 必须「CDP 实时优先、磁盘兜底」——**只读磁盘是本模块曾经的真缺陷**
 *
 * 真机报障（2026-10-29）：用户在这个窗口里**登录成功**了，插件仍显示「尚未配置账号」，
 * 「网页版登录」白转 4 分钟。根因不是路径错、不是匹配逻辑错：
 *
 * - Chromium 把 localStorage **缓在内存**，只有关窗（或批量提交）才刷到
 *   `<profileDir>/Default/Local Storage/leveldb` ⇒ 「登录完那一刻」磁盘里**还没有**
 *   ⇒ 每 500ms 读一次永远是 `undefined` ⇒ 4 分钟超时。实测可复现：我们起的 profile
 *   目录路径是对的（`Default/Local Storage/leveldb` 存在）、用户真实浏览器里的
 *   leveldb 里两个 key 确实相邻（匹配逻辑没问题），但**那一刻**我们这份 leveldb
 *   是空的。
 * - CDP 通路实测可用：`Target.getTargets` → `Target.attachToTarget { flatten: true }`
 *   → `Runtime.evaluate`（带 `sessionId`）能读到页面里的实时 `localStorage`。
 *
 * ⇒ 读凭据的**主路径**是 {@link readCredentialViaCdp}（实时），
 * {@link createProfileCredentialReader}（磁盘）降级为**兜底**（老 Chromium /
 * `--remote-allow-origins` 限制下 CDP 可能不可用）。⚠️ **两腿都要留**：删掉磁盘那条腿
 * 会让「CDP 不可用」的机器变成必然失败；删掉 CDP 那条腿就退回本次报障。
 *
 * ## 浏览器基础设施：全部来自 `chromium-session.ts`
 *
 * 起 chromium / 挑空闲调试端口 / 校验应答端口 / 监听 `'error'` / `taskkill /T` /
 * profile 目录退避重试删除 —— 每一条都是真实缺陷换来的（见该模块头那张表）。
 * 这里**不重写**任何一条，只组合 {@link ChromiumSession}。
 */

import { isAbsolute } from 'node:path'

import {
  BrowserDeploymentError,
  ChromiumSession,
  browserCandidates,
  browserNotFoundMessage,
  findBrowserExecutable,
  sleep as defaultSleep,
} from './chromium-session.js'
import type { MagicrewCredential } from './magicrew-auth.js'
import {
  readMagicrewLocalCreds,
  type MagicrewLocalCreds,
} from './magicrew-local-browser.js'
import { MAGICREW, type MagicrewProduct } from './magicrew-product.js'

/**
 * 默认等待用户完成登录的上限（**4 分钟**）。
 *
 * ## ⚠️ 为什么是 4 分钟而不是 5 分钟
 *
 * 客户端的登录轮询上限是 **5 分钟**（`plugin-src/client/jet-hub.js` 的
 * `deadline = Date.now() + 300000`，是客户端自己的表、不是服务端超时）。
 * 两边的上限若相同，宿主给出的终态（「等超时了」）会与客户端收表**几乎同时**发生，
 * 用户大概率只看到「登录超时」那句泛化文案、看不到真正的终态原因。
 * ⇒ 宿主必须**早于**客户端收口，留一分钟余量把原因送到眼前。
 *
 * ⚠️ 同时它也是「用户实际需要多久」的实测区间上限（扫码/输密码 2–5 分钟）。
 */
export const MAGICREW_BROWSER_LOGIN_TIMEOUT_MS = 240_000

/** 轮询间隔（毫秒）。 */
export const MAGICREW_BROWSER_LOGIN_POLL_MS = 500

/**
 * 一次已起好的网页登录会话。
 *
 * ⚠️ 两个方法就是全部契约：`waitForCredential` **绝不**用抛错表示「用户还没登完」
 * —— 那是正常路径（用户正在输密码），抛错会把「等待」与「失败」混成一件事。
 */
export interface MagicrewBrowserLogin {
  /**
   * 收掉浏览器。**必须**在 `finally` 里调（否则窗口残留）。
   *
   * ⚠️ **幂等**：重复调用不炸（`finally` + 错误路径可能都会走到它）。
   */
  close(): void
  /**
   * 等待用户在窗口里完成登录，返回凭据；超时 / 已收窗 ⇒ `undefined`。
   *
   * ⚠️ 不抛错（见接口头的说明）。
   */
  waitForCredential(timeoutMs: number): Promise<MagicrewCredential | undefined>
}

/** {@link startMagicrewBrowserLogin} 的选项。 */
export interface MagicrewBrowserLoginStartOptions {
  /** 产品（国内 / 国际站）。缺省 {@link MAGICREW}。 */
  product?: MagicrewProduct
  /**
   * 注入点：**单测用假会话，绝不真起浏览器**。
   *
   * ⚠️ 单测**必须**走它（或缺省的 `createChromiumMagicrewLogin` 的
   * `resolveBrowser: () => undefined`）：真起浏览器会在用户桌面弹出窗口
   * ——本仓库记过两次「单测弹出真实浏览器窗口」的真实污染。
   */
  sessionFactory?: (url: string) => Promise<MagicrewBrowserLogin>
  /** 等待用户完成登录的上限（缺省 {@link MAGICREW_BROWSER_LOGIN_TIMEOUT_MS}）。 */
  timeoutMs?: number
  /**
   * 诊断输出（透传给 {@link createChromiumMagicrewLogin} 的 `log`）。
   *
   * ⚠️ 必须由**生产**接线接上（见 `magicrew-auth.ts` 的 `loginViaBrowser`）：
   * 放弃等待时那一行「CDP 与磁盘都没读到凭据」是下次报障时唯一能区分
   * 「用户没登」与「我们读的方式坏了」的东西。缺了它，那行日志等于不存在。
   */
  log?: (message: string) => void
}

/** 把任意外部传入的超时收成「一个合法的非负毫秒数」。 */
function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return MAGICREW_BROWSER_LOGIN_TIMEOUT_MS
  }
  return Math.floor(value)
}

/** 轮询间隔：非法值回落缺省（`0` / 负数会让下面的循环空转）。 */
function normalizePollMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return MAGICREW_BROWSER_LOGIN_POLL_MS
  }
  return Math.max(1, Math.floor(value))
}

/** 从 URL 取 hostname；非法 URL ⇒ 空串（**不猜**）。 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

// ════════════════════════════════════════════════════════════════════════
// CDP 实时读凭据（**主路径**，见文件头「必须 CDP 实时优先」）
// ════════════════════════════════════════════════════════════════════════

/**
 * 页面里的取值表达式。
 *
 * ⚠️ 四个值一次取完（**不是**四次 `Runtime.evaluate`）：来回四次会让「读到 jwt 之后、
 * 读组织码之前用户换了账号」这种情况出现窗口，而错配的 jwt × org 在上游是
 * HTTP 200 + `code:403`（见 `magicrew-local-browser.ts` 头部的配对纪律）。
 *
 * `n` 是 `localStorage.length`：**空 = 还没登完**（见下面的判据）。
 *
 * ## ⚠️⚠️ 键名有两套，**必须都试**（真机取证 2026-11-04）
 *
 * letsmagic 网页写进 localStorage 的真实键名带 `MAGIC:user:` 前缀 ——
 * 把本机 Edge 的 `Local Storage/leveldb/071584.ldb` 按 SSTable 解出来后，
 * 31 条 letsmagic 记录里凭据键是：
 *
 *     MAGIC:user:authorization / MAGIC:user:organizationCode /
 *     MAGIC:user:teamshareOrganizationCode
 *
 * 而本文件原来只读**裸键**（`authorization` 等）⇒ 用插件自己开的那个窗口登录时，
 * 页面写的同样是带前缀的键 ⇒ CDP 腿**恒读不到**，只有「磁盘兜底」在硬撑
 * （而磁盘那条腿当时又因为不解 Snappy 压缩块一起失效 ⇒ 两条腿全瞎）。
 *
 * ⇒ 现在两套都读：**裸键优先**（老版本前端 / 其它站点可能仍是裸键），
 *   裸键为空再取带前缀的。用 `||` 而不是 `??`：`getItem` 缺失时返回 `null`，
 *   但空串 `''` 同样不可用，两种都要让位给下面的回退。
 */
const CDP_CREDENTIAL_EXPRESSION = `JSON.stringify({
  a: localStorage.getItem('authorization') || localStorage.getItem('MAGIC:user:authorization'),
  o: localStorage.getItem('organizationCode') || localStorage.getItem('MAGIC:user:organizationCode'),
  t: localStorage.getItem('teamshareOrganizationCode') || localStorage.getItem('MAGIC:user:teamshareOrganizationCode'),
  n: localStorage.length,
})`

/**
 * 单条 CDP 命令的上限。
 *
 * ⚠️ **不能**用 `CdpConnection.send` 的 30 秒缺省：外层轮询是 500ms 一拍，
 * 一条卡死的命令会把整轮等待预算（4 分钟）吃掉一小半，且期间磁盘兜底也不会被读到。
 */
const CDP_CREDENTIAL_TIMEOUT_MS = 3_000

/**
 * `Page.navigate` 的上限。
 *
 * ⚠️ **不能**复用 {@link CDP_CREDENTIAL_TIMEOUT_MS}（3 秒）
 * （2026-10-30 四路审计 P3-1 修）：真机实测把页面导航到**黑洞地址**时，
 * `Page.navigate` **15 秒都没返回** ⇒ 3 秒超时会让用户看到
 * 「CDP Page.navigate 超时（3000ms）」这种**内部超时文案**（而不是
 * 「登录页打不开」这种能指路的文案）。
 *
 * ⇒ 导航是**一次性**动作（不是 500ms 一拍的轮询）⇒ 给它更宽的预算。
 */
const CDP_NAVIGATE_TIMEOUT_MS = 30_000

/** CDP 通道（只声明本文件用到的那个方法 ⇒ 单测注入假 `send` 即可）。 */
interface CdpChannel {
  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    sessionId?: string,
  ): Promise<unknown>
}

/** 一次「实时读」的结果。 */
export interface MagicrewRealtimeRead {
  /** 读到了就是它。 */
  readonly credential?: MagicrewCredential
  /**
   * 本次读**失败**的原因（CDP 不可用 / 通道抛错 / 返回不可解析）。
   *
   * ⚠️ `undefined` 有两种含义，**刻意不区分**：① 读到了凭据；② 读通了但用户还没登完
   * （`localStorage` 空 / 缺组织码）—— 后者是**正常路径**，不是故障。
   */
  readonly failure?: string
}

/** `eyJ…` 三段（JWT 形状）。⚠️ 形状对 ≠ 有效，但形状不对**一定**不是 jwt。 */
function isJwtShaped(value: string): boolean {
  if (!value.startsWith('eyJ')) return false
  const parts = value.split('.')
  return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_\-+/=]+$/.test(part))
}

/** 两个 host 是否同一个站点（`www.letsmagic.cn` 与 `letsmagic.cn` 视作同一个）。 */
function sameSite(left: string, right: string): boolean {
  const bare = (host: string): string => host.toLowerCase().replace(/^www\./, '')
  return left.length > 0 && right.length > 0 && bare(left) === bare(right)
}

/**
 * 一个 host 的全部写法（`www.letsmagic.cn` / `letsmagic.cn`，去重、保持顺序）。
 *
 * ⚠️ 与 `magicrew-local-browser.ts` 的同名内部辅助**刻意为同一口径**：磁盘那条腿
 * 用的是它，两条腿对「同一个站点」的判断必须一致，否则会出现「磁盘读到了、CDP 说
 * 没有这个页面」这种自相矛盾的诊断。
 */
function siteHostnames(hostname: string): string[] {
  const host = String(hostname ?? '').trim().toLowerCase()
  if (host.length === 0) return []
  const bare = host.replace(/^www\./, '')
  const hosts = [host, bare, `www.${bare}`]
  return hosts.filter((value, index) => value.length > 0 && hosts.indexOf(value) === index)
}

/** 在 `Target.getTargets` 的结果里找**命中站点**的那个 page target。 */
function pickPageTarget(
  targets: unknown,
  hostnames: readonly string[],
): { targetId: string, url: string } | undefined {
  const infos = (targets as { targetInfos?: unknown } | undefined)?.targetInfos
  if (!Array.isArray(infos)) return undefined
  for (const raw of infos) {
    const info = raw as { type?: unknown, url?: unknown, targetId?: unknown }
    if (info.type !== 'page') continue
    if (typeof info.url !== 'string' || typeof info.targetId !== 'string') continue
    const host = hostnameOf(info.url)
    if (!hostnames.some((candidate) => sameSite(host, candidate))) continue
    return { targetId: info.targetId, url: info.url }
  }
  return undefined
}

/** 解析 `Runtime.evaluate` 的返回值（`{ result: { value } }`）⇒ 读到的凭据。 */
function parseEvaluatedCredential(value: unknown): MagicrewCredential | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  let parsed: { a?: unknown, o?: unknown, t?: unknown, n?: unknown }
  try {
    parsed = JSON.parse(value) as typeof parsed
  } catch {
    return undefined
  }
  /**
   * ⚠️⚠️ **`localStorage` 为空要当「还没登完」返回 `undefined`，不要抛**：
   * 用户刚点开窗口那一刻必然是空的，而这条路径每 500ms 走一次。
   */
  if (parsed.n === 0) return undefined
  const authorization = typeof parsed.a === 'string' ? parsed.a : ''
  if (!isJwtShaped(authorization)) return undefined
  const organization = typeof parsed.o === 'string' && parsed.o.length > 0
    ? parsed.o
    : typeof parsed.t === 'string' && parsed.t.length > 0 ? parsed.t : ''
  // ⚠️ 缺组织码 ⇒ `undefined`（**不造假**）：空 org 配 jwt 在上游是 HTTP 200 + code:403。
  if (organization.length === 0) return undefined
  return { jwt: authorization, organizationCode: organization }
}

/**
 * 尝试**一次**通过 CDP 读实时凭据（并把失败原因带出来）。
 *
 * ## ⚠️ 调用序列是实测跑通的，不要改顺序
 *
 * `Target.getTargets` → `Target.attachToTarget { flatten: true }` →
 * `Runtime.evaluate`（**带 `sessionId`**）。少一步 `flatten` 或漏传 `sessionId`，
 * 页面级命令会落在浏览器端点上并回一句含糊的 `-32601 'Runtime.evaluate' wasn't found`
 * —— 看起来像「API 不存在」，实际是「你没说要发给哪个页面」（该实测记录见
 * `chromium-session.ts` 的 `CdpConnection.send` 注释）。
 *
 * ## ⚠️ 每轮都重新 attach（**不要缓存 sessionId**）
 *
 * 页面在登录过程中会导航（`/login` → `/global/super/workspace/…`），导航会让
 * 旧 `sessionId` 失效。缓存它 ⇒ 用户「登录成功那一秒恰好导航」之后整条等待**永不恢复**。
 *
 * ## ⚠️ 任何一步失败都**返回**（不抛），下一轮自然重试
 *
 * 失败原因只用于**超时那一行诊断**（见 {@link createMagicrewCredentialWaiter}）：
 * 下次报障时它直接区分「用户没登」与「我们读的方式坏了」。
 */
async function attemptCredentialViaCdp(
  session: { cdp: CdpChannel | undefined },
  hostnames: readonly string[],
): Promise<MagicrewRealtimeRead> {
  const cdp = session?.cdp
  if (cdp === undefined) return { failure: 'CDP 通道未就绪（浏览器未启动或已收窗）' }
  const hosts = hostnames.map((host) => host.trim()).filter((host) => host.length > 0)
  if (hosts.length === 0) return { failure: '没有可匹配的 hostname' }

  let sessionId: string | undefined
  try {
    const targets = await cdp.send('Target.getTargets', {}, CDP_CREDENTIAL_TIMEOUT_MS)
    const target = pickPageTarget(targets, hosts)
    if (target === undefined) {
      return { failure: `${hosts.join(' / ')} 的页面还没出现（用户可能还在加载登录页）` }
    }
    const attached = await cdp.send(
      'Target.attachToTarget',
      { targetId: target.targetId, flatten: true },
      CDP_CREDENTIAL_TIMEOUT_MS,
    ) as { sessionId?: unknown } | undefined
    const attachedId = typeof attached?.sessionId === 'string' ? attached.sessionId : ''
    if (attachedId.length === 0) return { failure: 'Target.attachToTarget 没给出 sessionId' }
    sessionId = attachedId

    const evaluated = await cdp.send(
      'Runtime.evaluate',
      { expression: CDP_CREDENTIAL_EXPRESSION, returnByValue: true },
      CDP_CREDENTIAL_TIMEOUT_MS,
      attachedId,
    ) as { result?: { value?: unknown }, exceptionDetails?: unknown } | undefined
    if (evaluated?.exceptionDetails !== undefined) {
      return { failure: 'Runtime.evaluate 在页面里抛错（页面可能正在导航）' }
    }
    const credential = parseEvaluatedCredential(evaluated?.result?.value)
    // ⚠️ 没读到 = 「用户还没登完」这种**正常**未完成态 ⇒ 不记 failure。
    return credential === undefined ? {} : { credential }
  } catch (error) {
    return { failure: `CDP 调用失败：${String(error)}` }
  } finally {
    /**
     * ⚠️ attach 会留下 session ⇒ **尽力** detach。
     *
     * 与 `Storage.getCookies` 那条既有口径一致（`chromium-session.ts`）：能 detach 就
     * detach，**不可用或失败都不因此失败** —— 有的 Chromium 版本/调试后端没有
     * `Target.detachFromTarget`，为它抛错会让「已经读到凭据」变成读不到。
     */
    if (sessionId !== undefined) {
      try {
        await cdp.send('Target.detachFromTarget', { sessionId }, CDP_CREDENTIAL_TIMEOUT_MS)
      } catch {
        // 尽力而为：收窗时整条通道一起关掉，残留 session 随之消失。
      }
    }
  }
}

/**
 * 通过 CDP 读**实时** localStorage。
 *
 * ⚠️ **必须走它而不是读磁盘**：Chromium 把 localStorage 缓在内存，不关浏览器不落盘
 * （真机报障 2026-10-29 —— 磁盘读取的 4 分钟等待里永远是 undefined）。
 *
 * @param session 带 `cdp` 通道的会话（`ChromiumSession` 即可）。
 * @param hostnames 站点 host（**网页域**，例如 `www.letsmagic.cn`；`www.` 前后互认）。
 * @returns 读到 ⇒ 凭据；未登完 / CDP 不可用 ⇒ `undefined`（**绝不抛**，下一轮重试）。
 */
export async function readCredentialViaCdp(
  session: { cdp: CdpChannel | undefined },
  hostnames: readonly string[],
): Promise<MagicrewCredential | undefined> {
  return (await attemptCredentialViaCdp(session, hostnames)).credential
}

/**
 * 同 {@link readCredentialViaCdp}，但把**失败原因**一并带出来。
 *
 * ⚠️ 存在的理由只有一个：那条「放弃等待」的诊断（见
 * {@link createMagicrewCredentialWaiter} 的 `log`）要能说清「CDP 为什么没读到」。
 * 生产接线用的就是它（把 `failure` 交给等待循环），单测也用它断言「`n === 0`
 * 是正常未完成态、**不是**读失败」—— 这两件事在 `credential` 上同形（都
 * `undefined`），只有 `failure` 能分开。
 */
export async function readCredentialViaCdpDetailed(
  session: { cdp: CdpChannel | undefined },
  hostnames: readonly string[],
): Promise<MagicrewRealtimeRead> {
  return await attemptCredentialViaCdp(session, hostnames)
}

/**
 * 造一个「从**本次临时 profile**里读 magicrew 凭据」的读函数。
 *
 * ## ⚠️⚠️ 这就是本模块与「本机浏览器导入」的**唯一**实质差异
 *
 * `readMagicrewLocalCreds` 缺省会扫**用户真实浏览器**的 User Data 根目录
 * （`magicrewBrowserRoots()`）。而网页版登录用的是 `mkdtempSync` 出来的临时目录，
 * 真实目录里**永远是空的**（用户在日常浏览器里登过也不在临时 profile 里）
 * ⇒ 不把 `roots` 指过去，`waitForCredential` 会**恒等到超时**，且完全静默。
 *
 * ⚠️ 注入 `roots: [profileDir]` 也让本函数在单测里可断言：给一个临时目录、
 * 里面写一段 leveldb 文本，就能验证「读得到」与「读的是哪个 origin」。
 *
 * @param profileDir 本次会话的 `--user-data-dir`（`ChromiumSession.userDataDir`）。
 * @param hostname   站点 host（**网页域**，见文件头）。
 */
export function createProfileCredentialReader(
  profileDir: string,
  hostname: string,
  deps: { readCreds?: typeof readMagicrewLocalCreds } = {},
): () => MagicrewCredential | undefined {
  const readCreds = deps.readCreds ?? readMagicrewLocalCreds
  return () => {
    if (profileDir.length === 0 || hostname.length === 0) return undefined
    let found: MagicrewLocalCreds | undefined
    try {
      found = readCreds(hostname, { roots: [profileDir] })
    } catch {
      // ⚠️ 读盘失败（文件被浏览器独占 / 权限）**不是**「用户没登录」——
      //    但也不能抛错（那是正常路径，见接口头）：下一轮再试即可。
      return undefined
    }
    if (found === undefined) return undefined
    // ⚠️ 只搬两个字段：`expiresAt` 不在 `MagicrewCredential` 里（三层凭证的到期
    //    时刻由 `apiKeyExpiresAt` 表达，网页 jwt 自己带 30 天）。
    return { jwt: found.jwt, organizationCode: found.organizationCode }
  }
}

/** {@link createMagicrewCredentialWaiter} 的依赖（全部可注入 ⇒ 零真实浏览器、零真实等待）。 */
export interface MagicrewCredentialWaiterDeps {
  /**
   * 读一次**磁盘**（`undefined` = 还没出现）。
   *
   * ⚠️ 这是**兜底**（CDP 不可用的老 Chromium）。主路径见 {@link readRealtime}。
   */
  read: () => MagicrewCredential | undefined | Promise<MagicrewCredential | undefined>
  /**
   * 读一次**实时** localStorage（CDP，见 {@link readCredentialViaCdp}）。
   *
   * ⚠️ 给了它就**先走它**：Chromium 把 localStorage 缓在内存，磁盘上「用户登录完那一刻」
   * 还没有（真机报障 2026-10-29）。不给则退化成纯磁盘轮询（老用例与降级路径）。
   */
  readRealtime?: () => MagicrewRealtimeRead | Promise<MagicrewRealtimeRead>
  /** 时钟（毫秒）。缺省 `Date.now`。 */
  now?: () => number
  /** 等待原语。缺省 `chromium-session` 的 `sleep`（可 `unref`）。 */
  sleep?: (ms: number) => Promise<void>
  /** 轮询间隔（缺省 {@link MAGICREW_BROWSER_LOGIN_POLL_MS}）。 */
  pollIntervalMs?: number
  /** 会话是否已收（收窗后立刻放弃等待，不必等到超时）。 */
  isStopped?: () => boolean
  /**
   * 诊断输出（缺省静默）。
   *
   * ⚠️ 唯一用途：**放弃等待时记一行**「CDP 与磁盘都没读到凭据（CDP 尝试 N 次 /
   * 最后一次 CDP 失败原因：…）」。下次报障时这一行直接区分「用户没登」与
   * 「我们读的方式坏了」—— 少了它，两者在日志里同形。
   */
  log?: (message: string) => void
}

/**
 * 轮询等待凭据 —— **本模块唯一的等待逻辑**（会话类与单测共用它，不写第二份）。
 *
 * 语义（每条都有用例钉住）：
 * 1. **先读一次再判停止/超时**：`timeoutMs = 0` 时也要给一次机会（否则「刚登完就
 *    超时」这种边界会被判成没登录）；同理，用户登完顺手关窗那一刻凭据已在磁盘上，
 *    停止判据必须**后于**读取（详见循环里的注释）。
 * 2. **每轮先实时（CDP）、再磁盘（兜底）**：顺序是语义，不是风格 —— 见文件头
 *    「必须 CDP 实时优先」。⚠️ 磁盘那条腿**不许删**（CDP 不可用的机器上它是唯一出路）。
 * 3. 到点返回 `undefined`，**不抛错**（见 {@link MagicrewBrowserLogin} 接口头）。
 * 4. 已收窗 / 浏览器已退出 ⇒ 立刻 `undefined`（不必耗满预算）。
 * 5. 每轮最多睡到**剩余预算**为止（不越过 deadline 多睡一格）。
 */
export function createMagicrewCredentialWaiter(
  deps: MagicrewCredentialWaiterDeps,
): (timeoutMs: number) => Promise<MagicrewCredential | undefined> {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? defaultSleep
  const interval = normalizePollMs(deps.pollIntervalMs)
  const isStopped = deps.isStopped ?? (() => false)
  const readRealtime = deps.readRealtime
  /** 实时读尝试了几次 / 最后一次的失败原因（只用于放弃时那一行诊断）。 */
  let realtimeAttempts = 0
  let lastRealtimeFailure: string | undefined

  /** 读一拍：**实时优先、磁盘兜底**。 */
  const readOnce = async (): Promise<MagicrewCredential | undefined> => {
    if (readRealtime !== undefined) {
      realtimeAttempts += 1
      let realtime: MagicrewRealtimeRead
      try {
        realtime = await readRealtime()
      } catch (error) {
        // ⚠️ 实时读**绝不许**把等待变成失败：它自己要抛也只是「这拍没读到」。
        realtime = { failure: String(error) }
      }
      if (realtime.credential !== undefined) return realtime.credential
      // 只有**失败**才覆盖原因：`{}` = 「读通了但用户还没登完」，那是正常路径，
      // 拿它盖掉真故障会让放弃时那一行说不出任何有用的话。
      if (realtime.failure !== undefined) lastRealtimeFailure = realtime.failure
    }
    try {
      return await deps.read()
    } catch {
      // ⚠️ 读盘失败（文件被浏览器独占 / 权限）**不是**「用户没登录」——
      //    但也不能抛错（那是正常路径）：下一轮再试即可。
      return undefined
    }
  }

  return async (timeoutMs: number) => {
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0
    const deadline = now() + budget
    for (;;) {
      /**
       * ① **先读、再判「已收窗」**（顺序是语义，不是风格）：用户登完那一刻可能顺手
       * 关掉了窗口，此时 `isStopped()` 为真而凭据**已经**在（实时或磁盘上）—— 先把
       * 停止判据放在读取之前，就会把一次**已成功的登录**误报成 `undefined`。
       */
      const found = await readOnce()
      if (found !== undefined) return found
      if (isStopped()) return undefined
      const remaining = deadline - now()
      if (remaining <= 0) break
      await sleep(Math.max(1, Math.min(interval, remaining)))
    }
    /**
     * ⚠️ 放弃等待时**必须**留一行诊断（真机报障 2026-10-29 的直接教训）：
     * 「用户没登」与「我们读的方式坏了」在用户那里同形，只有这一行能分开。
     */
    if (deps.log !== undefined) {
      deps.log(
        `[magicrew] CDP 与磁盘都没读到凭据（CDP 尝试 ${realtimeAttempts} 次 / `
          + `最后一次 CDP 失败原因：${lastRealtimeFailure ?? '（无；说明页面在，只是 localStorage 里还没有凭据 —— 用户没登完）'}）`,
      )
    }
    return undefined
  }
}

/**
 * 「**空白/新标签页**」的 URL 形态集合。
 *
 * ⚠️⚠️ **`chrome://newtab/` 不算 `about:blank`**（2026-10-30 四路审计 P1 D-05 修）：
 * 实测 `new URL('chrome://newtab/').hostname` = **`'newtab'``**（**非空**）⇒
 * `sameSite('newtab', 'www.letsmagic.cn')` = false ⇒ 旧实现会把它当成
 * 「一个普通页面」⇒ 兜底 `pages[0]` 被导航 ⇒ **冲掉用户正在看的标签页**。
 *
 * ⚠️ 真机实测（2026-10-30 正向审计）：带 URL 启动时 CDP 就绪那刻 page URL
 * **已经是**目标 URL；不带 URL 时是 **`chrome://newtab/`**（**不是**
 * `about:blank`）⇒ 「about:blank 竞态」这条 PR 声称的前提**真机未复现**。
 * ⇒ 但**空白页总得处理**：本集合把三种「空白」形态一视同仁。
 *
 * ⚠️⚠️ **判据必须用「前缀」而不是「全等」**（2026-10-30 第二轮审计 P3-1 修）：
 * 真机实测的空白页形态**远不止三种**（第二轮审计实测出 5 种漏网）：
 * ```
 * chrome://new-tab-page-third-party/     ← 第三方新标签页
 * chrome-search://local-ntp/...          ← 本地搜索新标签页
 * edge://newtab/                        ← Edge 的新标签页
 * chrome://new-tab-page/?foo=1           ← 带查询串
 * about:blank#x                         ← 带 fragment
 * ```
 * ⇒ 全等判据 ⇒ 这些**漏掉** ⇒ 用户面对空白首屏、且插件**不导航**。
 * ⇒ 改为「**前缀匹配**」：`about:blank` 走前缀、`chrome://new-tab-page` 与
 * `chrome-search://local-ntp` 与 `edge://newtab` 走前缀。
 */
const BLANK_PAGE_URL_PREFIXES: readonly string[] = [
  'about:blank',
  'chrome://newtab',
  'chrome://new-tab-page',
  'chrome-search://local-ntp',
  'edge://newtab',
  'brave://newtab',
  'vivaldi://newtab',
]

/** 这个 URL 是不是「空白页 / 新标签页」（⇒ 可以安全地导航它）。 */
export function isBlankPageUrl(url: string): boolean {
  return BLANK_PAGE_URL_PREFIXES.some((prefix) => url.startsWith(prefix))
}

/**
 * 把「初始仍是空白页」的窗口导航到登录页。
 *
 * CDP 就绪早于首屏导航时，启动参数里的 URL 可能尚未落到 page target。
 * 此时不能让用户面对空白页；已有同站点页面则不重复导航。
 *
 * ⚠️⚠️ **失败不抛**（2026-10-30 四路审计 P1 D-06 修）：
 * 旧实现抛错 ⇒ 冒泡到 `createChromiumMagicrewLogin` 的 catch ⇒
 * `session.dispose()` ⇒ `loginViaBrowser` 抛 ⇒ RPC 层 `failLogin` ⇒
 * **占位账号被删、整条登录腿失败** —— 而此时**窗口还开着**、用户完全可以
 * 自己操作 ⇒ 用户看到「登录失败」却明明有个窗口在。
 *
 * ⇒ 现在改成：**导航失败只记一条 warn，登录流程继续**（窗口留着，用户可以
 * 自己在里面登录；凭据等待循环照样能读到）。
 * ⚠️ 与同文件既有纪律同口径：`attemptCredentialViaCdp` 是「任何一步失败都
 * **返回**不抛」。
 * ⚠️ **唯一的例外**：`cdp === undefined`（通道压根没就绪）仍然抛 —— 那时连
 * 「窗口开着」都不成立。
 *
 * @param url - 登录页 URL。
 * @param log - 诊断出口（缺省不记）。
 */
export async function ensureMagicrewLoginPage(
  session: { cdp: CdpChannel | undefined },
  url: string,
  log?: (message: string) => void,
): Promise<void> {
  const cdp = session.cdp
  if (cdp === undefined) throw new Error('超级麦吉: 浏览器调试通道未就绪，无法打开登录页')
  let targets: { targetInfos?: Array<{ type?: unknown, targetId?: unknown, url?: unknown }> }
  try {
    targets = await cdp.send('Target.getTargets', {}, CDP_CREDENTIAL_TIMEOUT_MS) as {
      targetInfos?: Array<{ type?: unknown, targetId?: unknown, url?: unknown }>
    }
  } catch (error) {
    // ⚠️ 同上：**不抛**（窗口开着，用户可自己操作）。
    log?.(`[magicrew] 读取浏览器页面列表失败，登录页未自动打开：${String(error)}`)
    return
  }
  const pages = (targets.targetInfos ?? []).filter(
    (info): info is { targetId: string, url: string, type: string } => (
      info.type === 'page' && typeof info.targetId === 'string' && typeof info.url === 'string'
    ),
  )
  if (pages.some((page) => sameSite(hostnameOf(page.url), hostnameOf(url)))) return
  // ⚠️⚠️ **只导航「空白页」**（2026-10-30 审计 P1 D-05 修）：
  // 旧实现是 `pages.find(about:blank) ?? pages[0]` ⇒ 兜底会**抢走用户正在看
  // 的标签页**（实测 `chrome://newtab/` 的 hostname 是 `'newtab'`、非空 ⇒
  // 它既不是 `about:blank`、也不是同站点 ⇒ 落到 `pages[0]` 被导航）。
  // ⇒ 现在**只**导航三种空白形态；**没有空白页就不导航**（宁可让用户自己
  // 切到登录页，也不冲掉他的标签页）。
  const blank = pages.find((page) => isBlankPageUrl(page.url))
  if (blank === undefined) {
    log?.('[magicrew] 没有找到空白页，未自动打开登录页（请手动切换到登录页）')
    return
  }
  let attached: { sessionId?: unknown }
  try {
    attached = await cdp.send(
      'Target.attachToTarget', { targetId: blank.targetId, flatten: true }, CDP_CREDENTIAL_TIMEOUT_MS,
    ) as { sessionId?: unknown }
  } catch (error) {
    log?.(`[magicrew] 连接登录页面失败，登录页未自动打开：${String(error)}`)
    return
  }
  if (typeof attached.sessionId !== 'string' || attached.sessionId.length === 0) {
    log?.('[magicrew] 无法连接登录页面，登录页未自动打开')
    return
  }
  const sessionId = attached.sessionId
  try {
    const navigated = await cdp.send(
      'Page.navigate', { url }, CDP_NAVIGATE_TIMEOUT_MS, sessionId,
    ) as { errorText?: unknown }
    if (typeof navigated.errorText === 'string' && navigated.errorText.length > 0) {
      // ⚠️ **不抛**（同本函数头部注释）—— 只记一条诊断。
      log?.(`[magicrew] 打开登录页失败（${navigated.errorText}），窗口仍开着，可手动操作`)
    }
  } catch (error) {
    // ⚠️ **不抛**（同本函数头部注释）。
    log?.(`[magicrew] 打开登录页失败，窗口仍开着，可手动操作：${String(error)}`)
  } finally {
    try {
      await cdp.send('Target.detachFromTarget', { sessionId }, CDP_CREDENTIAL_TIMEOUT_MS)
    } catch {
      // 会话关闭时连接可能已断开；导航结果不能被清理错误覆盖。
    }
  }
}

/** {@link createChromiumMagicrewLogin} 的依赖（生产缺省全接线；单测逐个注入）。 */
export interface ChromiumMagicrewLoginDeps {
  /** 产品常量（只用于诊断文案）。 */
  product?: MagicrewProduct
  /**
   * 浏览器探测（缺省 {@link findBrowserExecutable}）。
   *
   * ⚠️ **可注入是为了能测「找不到浏览器」那条路**：真机上有浏览器时那条路永远走不到，
   * 而它恰恰是用户最常见的失败（本机没装 Chromium 内核浏览器）。
   */
  resolveBrowser?: () => string | undefined
  /** 平台（只影响「找不到浏览器」的文案措辞）。缺省 `process.platform`。 */
  platform?: NodeJS.Platform
  /** 显式指定可执行文件（跳过探测）。 */
  executablePath?: string
  /** 浏览器就绪上限（缺省 `ChromiumSession` 的 30 秒）。 */
  readyTimeoutMs?: number
  /** 等待用户完成登录的上限（缺省 {@link MAGICREW_BROWSER_LOGIN_TIMEOUT_MS}）。 */
  timeoutMs?: number
  /** 轮询间隔。 */
  pollIntervalMs?: number
  /** 读凭据原语（单测注入）。 */
  readCreds?: typeof readMagicrewLocalCreds
  /** 登录页导航原语（单测注入，验证 about:blank 修复而不起真实浏览器）。 */
  ensureLoginPage?: typeof ensureMagicrewLoginPage
  /** 实时读凭据原语（缺省 {@link readCredentialViaCdp}；单测注入假 session）。 */
  readRealtime?: (session: { cdp: CdpChannel | undefined }) => Promise<MagicrewRealtimeRead>
  /** 等待原语（单测注入 ⇒ 零真实等待）。 */
  sleep?: (ms: number) => Promise<void>
  /** 时钟（单测注入）。 */
  now?: () => number
  /** 诊断输出（缺省静默）。 */
  log?: (message: string) => void
}

/** 一个已起好浏览器的网页登录会话（实现 {@link MagicrewBrowserLogin}）。 */
class ChromiumProfileLogin implements MagicrewBrowserLogin {
  private closed = false
  private readonly wait: (timeoutMs: number) => Promise<MagicrewCredential | undefined>
  private readonly defaultTimeoutMs: number

  constructor(
    private readonly session: ChromiumSession,
    deps: MagicrewCredentialWaiterDeps,
    defaultTimeoutMs: number,
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs
    // ⚠️ `isStopped` 由**本类**提供（而不是让调用方再传一次）：收窗后必须立刻放弃
    //    等待，否则 `close()` 之后 `waitForCredential` 还会空转到超时。
    this.wait = createMagicrewCredentialWaiter({
      ...deps,
      isStopped: () => this.closed || session.exited,
    })
  }
  /**
   * 收掉浏览器（**幂等**）。
   *
   * ⚠️ 走 `ChromiumSession.dispose()`：它内部是 `kill()`（`taskkill /T /F`，同步等它
   * 退干净）+ 临时 profile 的**退避重试删除**。不要在别处自己 `rmSync` ——
   * 那些「每条都是真实缺陷换来的」纪律就在那里（见 `chromium-session.ts` 模块头）。
   * ⚠️ 收尾失败**不抛**：调用点在 `finally`，抛错会盖掉真正的登录结果。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.session.dispose()
    } catch {
      // 尽力而为：窗口/进程/目录各自都有兜底（系统会回收临时目录）。
    }
  }

  async waitForCredential(timeoutMs: number = this.defaultTimeoutMs): Promise<MagicrewCredential | undefined> {
    return await this.wait(timeoutMs)
  }
}

/**
 * 起浏览器并打开 magicrew 网页登录页（**独立 profile、可见窗口**）。
 *
 * 找不到浏览器 ⇒ 抛 {@link BrowserDeploymentError}（`deployKind: 'browser-not-found'`），
 * 文案里带 {@link browserNotFoundMessage} 的分平台提示与本次**真的尝试过**的候选清单。
 *
 * ⚠️ 这是**唯一**会 `spawn` 浏览器的函数；单测只允许以
 * `resolveBrowser: () => undefined`（测找不到那条路）或干脆不调它。
 */
export async function createChromiumMagicrewLogin(
  url: string,
  deps: ChromiumMagicrewLoginDeps = {},
): Promise<MagicrewBrowserLogin> {
  const hostname = hostnameOf(url)
  if (hostname.length === 0) {
    // ⚠️ 非法 origin 必须**立刻**报错，不能起一个浏览器然后永远等不到凭据
    //   （那两件事在用户眼里同形，而原因完全不同）。
    throw new Error(
      `超级麦吉: 网页登录地址非法（${JSON.stringify(url)}）—— 无法定位 localStorage`,
    )
  }
  /** 两种站点写法（`www.` 前后），CDP 与磁盘两条腿共用同一口径。 */
  const hostnames = siteHostnames(hostname)
  const executable = deps.executablePath ?? (deps.resolveBrowser ?? findBrowserExecutable)()
  if (executable === undefined || executable.length === 0) {
    /**
     * ⚠️⚠️ 文案**必须**由 {@link browserNotFoundMessage} 生成（不自己编）：
     * 它按平台说人话（macOS 上没有 scoop、`chrome.exe` 也不是那个文件名），
     * 并回显「本进程看到的候选清单」——那是用户唯一能自查的东西。
     *
     * ⚠️ `tried` 只列**真的会被尝试**的候选（绝对路径 + 非空）：`findBrowserExecutable`
     * 会跳过相对路径（空环境变量会拼出 `Google\Chrome\Application\chrome.exe`），
     * 而 `browserCandidates()` 原样返回它们 ⇒ 不过滤就会宣称「已尝试 N 条」
     * 而其中有几条根本没试过（该纪律的取证见 `chromium-session.ts` 同名注释）。
     *
     * ⚠️ 环境变量名用宿主共享的那个（`ZCODE_CHROME_PATH`）：`browserCandidates`
     * **只读它**，换一个名字写文案等于骗用户去设一个不会被读的变量。
     */
    throw new BrowserDeploymentError(
      '超级麦吉: 找不到可用的浏览器（网页版登录需要本机有一个 Chromium 内核浏览器）。'
        + browserNotFoundMessage(deps.platform ?? process.platform, 'ZCODE_CHROME_PATH', {
          tried: browserCandidates({ platform: deps.platform })
            .filter((candidate) => candidate.length > 0 && isAbsolute(candidate)),
          overrideValue: process.env.ZCODE_CHROME_PATH,
        }),
      'browser-not-found',
    )
  }

  const session = new ChromiumSession({
    executablePath: executable,
    /**
     * ⚠️⚠️ **窗口必须可见**（`hideWindow: false`）：用户要在这个窗口里自己登录。
     * 缺省是 `true`（把窗口移出屏幕 / 进不了任务栏）—— 那是给 captcha 用的，
     * 用在这里等于「点了没反应」。
     */
    hideWindow: false,
    windowSize: '1024,800',
    // 每次登录一个**一次性** profile（理由见文件头）。
    profilePrefix: 'magicrew-login-',
    initialUrl: url,
    ...deps.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: deps.readyTimeoutMs },
    label: '超级麦吉',
    notFoundHint: '（网页版登录需要本机有一个 Chromium 内核浏览器）',
    ...deps.log === undefined ? {} : { log: deps.log },
  })
  try {
    await session.start()
    // ⚠️⚠️ **导航失败不阻断登录**（2026-10-30 四路审计 P1 D-06 修）：
    // 旧实现在这里抛错 ⇒ catch ⇒ dispose ⇒ `loginViaBrowser` 抛 ⇒ RPC 层
    // `failLogin` ⇒ **占位账号被删**；而此时**窗口还开着**、用户完全可以
    // 自己登录 ⇒ 用户看到「登录失败」却明明有个窗口在。
    // ⇒ `ensureMagicrewLoginPage` 现在**自己**吞掉导航失败（只记 warn），
    //    这里只保留一个**兜底 try**（防未来实现变回抛错时又删号）。
    try {
      await (deps.ensureLoginPage ?? ensureMagicrewLoginPage)(session, url, deps.log)
    } catch (error) {
      deps.log?.(`[magicrew] 登录页未自动打开，窗口仍开着可手动操作：${String(error)}`)
    }
  } catch (error) {
    /**
     * ⚠️ 起不来时**必须** dispose：`launch()` 失败路径只 `kill()` 进程树，
     * 临时 profile 目录由 `dispose()` 才删（它内部有退避重试）。
     * 不调就会在 `%TEMP%` 里留下一个 `magicrew-login-*` 目录（每次失败一个）。
     */
    session.dispose()
    throw error
  }
  const profileDir = session.userDataDir ?? ''
  const read = createProfileCredentialReader(profileDir, hostname, {
    ...deps.readCreds === undefined ? {} : { readCreds: deps.readCreds },
  })
  /**
   * ⚠️⚠️ **实时（CDP）是主路径，磁盘是兜底**（见文件头「必须 CDP 实时优先」）：
   * 只读磁盘会出现「用户明明登录成功、插件白转 4 分钟」——Chromium 不关窗不落盘。
   *
   * `hostnames` 给两种写法（`www.letsmagic.cn` / `letsmagic.cn`），命中判据是
   * **同站点**而不是全串等值：登录成功后 URL 会变成
   * `/global/super/workspace/…`（用户截图里的真实形态）。
   */
  const readRealtime = deps.readRealtime
    ?? ((target: { cdp: CdpChannel | undefined }) => readCredentialViaCdpDetailed(target, hostnames))
  return new ChromiumProfileLogin(
    session,
    {
      read,
      readRealtime: () => readRealtime(session),
      ...deps.now === undefined ? {} : { now: deps.now },
      ...deps.sleep === undefined ? {} : { sleep: deps.sleep },
      ...deps.pollIntervalMs === undefined ? {} : { pollIntervalMs: deps.pollIntervalMs },
      ...deps.log === undefined ? {} : { log: deps.log },
    },
    normalizeTimeoutMs(deps.timeoutMs),
  )
}

/**
 * 起浏览器打开 magicrew 登录页（独立 profile），返回一个「等用户登完」的会话。
 *
 * ## ⚠️ 打开的 URL 是 `product.webOrigin`，**不是** `product.host`
 *
 * 理由见文件头第二段（API 子域上用户根本没法登录）。这一条有单测钉住
 * （断言注入的 `sessionFactory` 收到的就是 `webOrigin`），因为写错了**不会报错**、
 * 只会永远等不到凭据。
 *
 * @example
 * ```ts
 * const login = await startMagicrewBrowserLogin({ product: MAGICREW })
 * try {
 *   const credential = await login.waitForCredential(120_000)
 * } finally {
 *   login.close()   // ⚠️ 必须：否则窗口与进程残留
 * }
 * ```
 */
export async function startMagicrewBrowserLogin(
  options: MagicrewBrowserLoginStartOptions = {},
): Promise<MagicrewBrowserLogin> {
  const product = options.product ?? MAGICREW
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs)
  /**
   * ⚠️⚠️ **网页域 + `/login` 路径**（见文件头）。两个都要对：
   * - `product.host` 是 API 子域 `i-magic-service.letsmagic.cn` —— 用户不会在那上面
   *   登录，localStorage 也不会在那个 origin 下有条目；
   * - **光有裸域是首页、不是登录页**（2026-10-29 用户实测报障：弹出
   *   `https://www.letsmagic.cn/` 而参考实现弹的是 `/login?...`，用户在那页上
   *   找不到登录框）。
   * ⚠️ **不带邀请码**（用户 2026-10-29 明确要求）：`?invitation=` 会把新注册的号
   * 挂在某个邀请码下。本插件不代用户决定属于谁 —— 要带就由他自己在网页里填。
   */
  const url = `${product.webOrigin}/login`
  const factory = options.sessionFactory
    ?? ((target: string): Promise<MagicrewBrowserLogin> =>
      createChromiumMagicrewLogin(target, {
        product,
        timeoutMs,
        ...options.log === undefined ? {} : { log: options.log },
      }))
  return await factory(url)
}
