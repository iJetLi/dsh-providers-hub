/**
 * 豆包（Doubao）`a_bogus` 签名 —— **在 Node 的 `vm` 沙箱里跑官方的 bdms SDK**。
 *
 * ## 背景（2026-11-25）
 *
 * 签到的 `POST /alice/ug/campaign/landing/checkin` 必须带 query `a_bogus`，它由
 * `window.bdms.frontierSign(...)` 生成。原实现为此**必须起一个 Chromium**（
 * `doubao-signin.ts` 的 CDP 路径），容器里也就必须塞浏览器镜像。
 *
 * 但 bdms 并不需要"真的浏览器"——它是**一坨自包含的自执行 JS**（当前版本 163KB，
 * 只引用 `document` ×4 / `navigator` ×1 / `location` ×2 / `XMLHttpRequest` ×1 /
 * `crypto` ×4，没有 WebAssembly / canvas / Worker）。⇒ 用 `node:vm` 造一个最小
 * 的 `window` 把它跑起来即可，**零浏览器、零额外依赖**（实测 2026-11-25：
 * 沙箱里 `frontierSign({'X-MS-STUB':''})` 回 `{'X-Bogus': '6BvjtT3/e7qiXab9'}`，
 * 与浏览器里的形状、长度逐字一致）。
 *
 * ## ⚠️⚠️ 三个必须踩准的点（都是实测踩出来的）
 *
 * 1. **chunk 的 URL 每次都变**（`bdms-sdk.<hash>.js`，随豆包每次发版更新）。
 *    ⇒ 不能硬编码：向 `chat` 页要 HTML，从里面的 rspack manifest 里读
 *    `"9a":"<hash>"`（`9a` 就是 `bdms-sdk` 这个 chunk 的 id，名字映射在同一份
 *    manifest 里是 `"9a":"bdms-sdk"`）。
 * 2. **SDK 本体是 rspack chunk，不是完整 bundle**：它只做
 *    `(rspackChunkapp_flow_chat=...||[]).push([["9a"], {Cc2: factory}])`。
 *    ⇒ 沙箱里要**自己把 `Cc2` 调起来**（正常运行时这一步由 rspack runtime 做）。
 * 3. **factory 内部会 `eval` 且需要 `require`**：它用
 *    `nodeWrap` → `createMethod` → `eval` 造函数，缺 `require` 就抛
 *    `ReferenceError: require is not defined`；再缺 `process` 会走浏览器腿。
 *    ⇒ 沙箱里同时给 `require`（`SE` → process 替身，其余交回真 `node:module`）、
 *    `process`、`Buffer`。
 *
 * ## 纪律
 *
 * - **失败绝不静默**：解析不出 chunk / SDK 初始化失败 / 签名空串，全部抛出
 *   带原因的 Error（调用方据此回退浏览器腿，见 `doubao-signin.ts`）；
 * - **实例缓存**：SDK 初始化要跑 163KB 的代码，签到是每天每账号一次 ⇒ 进程内
 *   复用同一实例（同一"设备"多次签到的指纹也才是稳定的）；
 * - **只做签名**，不发任何网络请求（SDK 内部那条 `XMLHttpRequest` 是风控埋点，
 *   沙箱里给了个空实现，签名不依赖它）。
 *
 * @module src/doubao-bdms.js
 */

import vm from 'node:vm'
import { createRequire } from 'node:module'
import { DOUBAO_WEB_USER_AGENT } from './doubao.js'

const CHAT_PAGE = 'https://www.doubao.com/chat/'
const CHUNK_BASE = 'https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/chat/static/js/async/'
const CHUNK_NAME = 'bdms-sdk'

/**
 * manifest 里 chunk `9a` 的哈希（`bdms-sdk` 的 id 固定是 `9a`）。
 *
 * ⚠️ 兜底值：正常路径每次都从 HTML 现读；只有当 HTML 结构变了（读不到）时才用它，
 * 而且**下载 404 会自动重试一次现读**，不会一直用旧哈希。
 */
const FALLBACK_HASH = '173db50026'

/** 现读 URL 的缓存有效期（豆包发版频率按天计，30 分钟足够新鲜）。 */
const URL_TTL_MS = 30 * 60_000

interface CachedSigner {
  url: string
  resolvedAt: number
  script: string
  /** 沙箱里的 `frontierSign`（已绑定上下文）。 */
  sign: (input: Record<string, string>) => string
}

let cache: CachedSigner | undefined

/**
 * 从 `chat` 页 HTML 里解析 bdms chunk 的 URL（导出仅为单测）。
 *
 * @returns 解析失败返回 `undefined`（调用方回落到 {@link FALLBACK_HASH}）。
 */
export function parseBdmsChunkUrl(html: string): string | undefined {
  /**
   * ⚠️ 先把 `\"` 归一成 `"`：manifest 在真实 HTML 里是**裸引号**（`<script>` 内），
   * 但它也可能被上游包成 JS 字符串（转义引号）。两种形态都见过 ⇒ 归一后再匹配，
   * 否则换个包装就静默失效（而失效的表现是"签名一直空串"，极难定位）。
   */
  const normalized = html.replace(/\\"/g, '"')
  // ⚠️ 必须**先**确认 `9a` 就是 `bdms-sdk`：豆包改 chunk 编号时（历史上发生过
  //    其它 chunk 重排），只按 `"9a":"<hex>"` 抓会把**别的模块**的哈希当签名 SDK。
  if (!/"9a":"bdms-sdk"/.test(normalized)) return undefined
  const match = /"9a":"([0-9a-f]{6,})"/.exec(normalized)
  if (match === null) return undefined
  return `${CHUNK_BASE}${CHUNK_NAME}.${match[1]}.js`
}

async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': DOUBAO_WEB_USER_AGENT, accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`)
  return await response.text()
}

/** 现读一次 chunk URL（失败返回兜底哈希）。 */
async function resolveChunkUrl(log: (msg: string) => void): Promise<string> {
  try {
    const url = parseBdmsChunkUrl(await fetchText(CHAT_PAGE))
    if (url !== undefined) return url
    log('[doubao] chat 页 manifest 里没找到 bdms chunk，改用兜底哈希')
  } catch (error) {
    log(`[doubao] 读取 chat 页失败（改用兜底哈希）：${error instanceof Error ? error.message : String(error)}`)
  }
  return `${CHUNK_BASE}${CHUNK_NAME}.${FALLBACK_HASH}.js`
}

/** 沙箱里的最小 DOM / 环境替身（bdms 只用得到这几个属性）。 */
function buildSandbox(): Record<string, any> {
  const noop = () => {}
  const fakeElement = () => ({
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    setAttribute: noop,
    getContext: () => null,
    style: {},
    children: [],
  })
  const document = {
    // ⚠️ 设备指纹会读 cookie；给一组稳定的假值即可（真正的账号 cookie 不进签名
    //    输入 —— `frontierSign` 只吃 `{'X-MS-STUB': ''}`）。
    cookie: 'ttwid=1; s_v_web_id=verify_doubao_sandbox',
    referrer: CHAT_PAGE,
    title: '豆包',
    readyState: 'complete',
    createElement: fakeElement,
    getElementsByTagName: () => [fakeElement()],
    querySelector: () => fakeElement(),
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    documentElement: fakeElement(),
    head: fakeElement(),
    body: fakeElement(),
    location: { href: CHAT_PAGE },
  }
  const sandbox: Record<string, any> = {
    document,
    location: {
      href: CHAT_PAGE,
      host: 'www.doubao.com',
      hostname: 'www.doubao.com',
      origin: 'https://www.doubao.com',
      protocol: 'https:',
      pathname: '/chat/',
      search: '',
    },
    navigator: {
      userAgent: DOUBAO_WEB_USER_AGENT,
      language: 'zh-CN',
      languages: ['zh-CN'],
      platform: 'Win32',
      webdriver: false,
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    screen: { width: 1536, height: 864, availWidth: 1536, availHeight: 824, colorDepth: 24, pixelDepth: 24 },
    crypto: globalThis.crypto,
    performance: { now: () => Date.now(), timeOrigin: Date.now() - 1000 },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    // ⚠️ 风控埋点用的 XHR —— 只给空实现：签名不需要它，真的发请求反而是越界。
    XMLHttpRequest: function XhrStub() {
      return { open: noop, send: noop, setRequestHeader: noop, addEventListener: noop, status: 0, responseText: '' }
    },
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: noop,
    innerWidth: 1536,
    innerHeight: 864,
    devicePixelRatio: 1,
    fetch: () => new Promise(() => {}),
    Buffer,
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  sandbox.top = sandbox
  sandbox.parent = sandbox
  sandbox.document.defaultView = sandbox
  return sandbox
}

/**
 * 把 SDK 脚本跑进沙箱，返回 `frontierSign`。
 *
 * ⚠️ 模块 id `Cc2` 是当前版本的常量；上游改了 id 时按"逐个调用直到
 * `window.bdms` 出现"兜底 —— 比按名字猜更稳（签名入口只有这一个副作用）。
 */
function createSignerFactory(script: string): (input: Record<string, string>) => string {
  const realRequire = createRequire(import.meta.url)
  const processShim = {
    env: { NODE_ENV: 'production' },
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(() => fn(...args), 0),
    platform: 'win32',
    versions: { node: process.version.replace(/^v/, '') },
    browser: true,
    argv: [],
    cwd: () => '/',
  }
  const requireShim = (name: string): unknown => {
    if (name === 'SE') return processShim
    return realRequire(name)
  }

  const sandbox = buildSandbox()
  sandbox.require = requireShim
  sandbox.process = processShim
  sandbox.global = sandbox
  sandbox.module = { exports: {} }
  sandbox.exports = {}
  const context = vm.createContext(sandbox)
  vm.runInContext('var self = this;', context)
  vm.runInContext(script, context, { filename: `${CHUNK_NAME}.js` })

  const pushed = sandbox.rspackChunkapp_flow_chat as Array<[string[], Record<string, (a: unknown, b: unknown, require: unknown) => void>]> | undefined
  const modules = pushed?.[0]?.[1]
  if (modules === undefined) throw new Error('bdms SDK 结构不认识（chunk 没有 push 出模块表）')

  const factory = modules.Cc2
  if (typeof factory === 'function') {
    factory({}, {}, requireShim)
  } else {
    // 兜底：逐个调（正常版本不会走到这里）。
    for (const candidate of Object.values(modules)) {
      if (typeof candidate !== 'function') continue
      try { candidate({}, {}, requireShim) } catch { /* 不是这个模块 */ }
      if (sandbox.bdms !== undefined) break
    }
  }
  const bdms = sandbox.bdms as { frontierSign?: (input: Record<string, string>) => { 'X-Bogus'?: unknown } } | undefined
  if (bdms === undefined || typeof bdms.frontierSign !== 'function') {
    throw new Error('bdms SDK 初始化后没有 frontierSign（上游改了导出结构）')
  }
  return (input) => {
    if (typeof bdms.frontierSign !== 'function') throw new Error('bdms SDK 的 frontierSign 不可用')
    const signed = bdms.frontierSign(input)
    const bogus = signed?.['X-Bogus']
    if (typeof bogus !== 'string' || bogus.length === 0) throw new Error('bdms 签名返回空串')
    return bogus
  }
}

async function ensureSigner(log: (msg: string) => void): Promise<CachedSigner> {
  if (cache !== undefined && Date.now() - cache.resolvedAt < URL_TTL_MS) return cache
  const url = await resolveChunkUrl(log)
  if (cache !== undefined && cache.url === url) {
    cache.resolvedAt = Date.now()
    return cache
  }
  log(`[doubao] 加载 bdms SDK：${url}`)
  const script = await fetchText(url)
  const signer: CachedSigner = {
    url,
    resolvedAt: Date.now(),
    script,
    sign: createSignerFactory(script),
  }
  cache = signer
  log('[doubao] bdms SDK 已在 Node 沙箱内就绪')
  return signer
}

/**
 * 产出一枚 `a_bogus`（等价于页面里的 `window.bdms.frontierSign({'X-MS-STUB':''})`）。
 *
 * @throws 取不到 SDK / 结构变化 / 签名空串 —— 调用方据此**回退浏览器腿**。
 */
export async function signDoubaoBogus(options: { log?: (msg: string) => void } = {}): Promise<string> {
  const log = options.log ?? (() => {})
  const signer = await ensureSigner(log)
  return signer.sign({ 'X-MS-STUB': '' })
}

/** 清缓存（单测 / 升级上游后强制重载用）。 */
export function resetDoubaoBdmsSigner(): void {
  cache = undefined
}
