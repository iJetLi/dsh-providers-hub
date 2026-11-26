/**
 * 豆包（Doubao）`a_bogus` 签名 —— 跑**仓库内置**的官方 bdms SDK。
 *
 * ## 背景
 *
 * 签到的 `POST /alice/ug/campaign/landing/checkin` 必须带 query `a_bogus`，它由页面里的
 * `window.bdms.frontierSign(...)` 生成。原实现为此必须起一个 Chromium（CDP 路径），
 * 从而把「签到」绑死在「运行环境里有浏览器」上。
 *
 * bdms 本身并不需要真浏览器：它是一坨自包含的 rspack chunk（163KB），只用到
 * `document` / `navigator` / `location` / `performance` / `XMLHttpRequest`（风控埋点，
 * 签名不依赖）。⇒ 在 `node:vm` 里造一个最小环境就能跑起来，零浏览器、零额外依赖。
 *
 * ## ⚠️ 安全口径（2026-11-26 复审后重写）
 *
 * 1. **SDK 随包内置，运行时零下载零网络**。早年实现是「运行时从豆包 CDN 拉 163KB JS
 *    再在主进程 `node:vm` 里执行」——那等于把 `hub` 主进程（它持有全部 provider 的
 *    凭据）的执行权交给外部 CDN，且没有任何完整性校验。现在源码就在
 *    `src/assets/doubao-bdms-sdk.<hash>.js`，进 git 可审、离线可用。
 * 2. **sha256 钉扎**。内置文件在装载前必须与 {@link DOUBAO_BDMS_SDK_SHA256} 逐字节一致，
 *    不匹配直接抛错（不执行）。升级上游 SDK 时是「改文件 + 改常量」的显式动作。
 * 3. **不往 sandbox 里递任何宿主对象**。`vm` 不是安全边界，而只要有一个宿主函数/对象
 *    进了上下文，就能经 `constructor.constructor` 摸到宿主的 `process`。
 *    ⇒ 这里把 `document` / `navigator` / `atob` / `btoa` / `require('SE')` 的替身
 *    **全部在上下文内部造**，宿主只交出一个字符串（SDK 源码）。
 * 4. **`require` 白名单**。SDK 只 `__webpack_require__("SE")`（拿 process 替身），
 *    其余一律抛错；替身里**故意不带 `versions.node`** ⇒ SDK 判定「非 Node」，
 *    走它自带的纯 JS md5 分支（正是浏览器里的那条腿），也就不需要 `crypto` / `Buffer`。
 *
 * ## 上下文里**没有**的宿主全局（TextDecoder / URL / AbortController …）
 *
 * SDK 源码里出现 `URL` ×42、`TextDecoder` ×2，但**签名路径一次都没走到**（实测
 * `frontierSign` 正常返回 16 字符），所以这里没有照抄一份半吊子的实现 —— 造错的
 * `URL` / `TextDecoder` 会**静默**签出与服务端不一致的指纹，比直接抛错难查得多。
 *
 * 若上游改版后真的走进这些分支，表现是 `ReferenceError: URL is not defined` 之类的
 * **可诊断**抛错（`doubao-signin.ts` 会把它原样写进失败文案）⇒ 那时按报错补实现，
 * 并**同时**加一条「补的实现与 Node 宿主语义一致」的断言。**不会**静默失败。
 *
 * ## 纪律
 *
 * - **失败绝不静默**：文件缺失 / 哈希不符 / SDK 结构变化 / 签名空串，全部抛带原因的
 *   Error，由 `doubao-signin.ts` 原样写进用户的失败文案；
 * - **实例缓存**：初始化要跑 163KB 代码，签到是每天每账号一次 ⇒ 进程内复用同一实例；
 * - **只做签名**，不发任何网络请求（SDK 里那条 `XMLHttpRequest` 是 Slardar 埋点，
 *   沙箱里是空实现）。
 *
 * @module src/doubao-bdms.js
 */

import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DOUBAO_WEB_USER_AGENT } from './doubao.js'

/** 内置 SDK 的文件名（内容随上游发版更新；文件名带 hash，便于在 diff 里认出换版）。 */
const SDK_FILE = 'doubao-bdms-sdk.173db50026.js'

/** 内置 SDK 的 sha256 —— 装载前逐字节校验，**升级 SDK 时必须同步改这里**。 */
export const DOUBAO_BDMS_SDK_SHA256 = '4be42e52f0b691d74b14dac00d305e95aadd4f4dba5f305dcbf14ed8ec33b32d'

/** SDK 脚本在源码树与构建产物里的位置（`src/assets/…` → `lib/assets/…`，见 copy-assets）。 */
const SDK_URL = new URL(`./assets/${SDK_FILE}`, import.meta.url)

/** 沙箱初始化超时（163KB 代码 + 一堆 polyfill，正常一两百毫秒足够）。 */
const INIT_TIMEOUT_MS = 20_000

/**
 * 校验 SDK 源码与钉扎的 sha256 是否一致（导出仅为单测）。
 *
 * @throws 内容被改动 / 文件不是内置那一份。
 */
export function verifyDoubaoBdmsSdkSource(source: string): void {
  const actual = createHash('sha256').update(source, 'utf8').digest('hex')
  if (actual !== DOUBAO_BDMS_SDK_SHA256) {
    throw new Error(
      `bdms SDK 校验失败：内置文件的 sha256 是 ${actual}，期望 ${DOUBAO_BDMS_SDK_SHA256}。` +
        '若这是有意的升级，请同步更新 src/assets 里的文件与本模块的常量（不要把未校验的脚本送进 vm）。',
    )
  }
}

/** 读内置 SDK（同步、零网络），并做完整性校验。 */
export function loadDoubaoBdmsSdk(): string {
  let source: string
  try {
    source = readFileSync(fileURLToPath(SDK_URL), 'utf8')
  } catch (error) {
    throw new Error(
      `读不到内置 bdms SDK（${SDK_FILE}）：${error instanceof Error ? error.message : String(error)}。` +
        '构建产物里 `lib/assets/` 必须随包发布（`npm run build:assets`）。',
    )
  }
  verifyDoubaoBdmsSdkSource(source)
  return source
}

/**
 * 沙箱预置代码：**在上下文内部**造出 SDK 需要的最小环境。
 *
 * ⚠️ 这里刻意不接收宿主传进来的任何对象 —— 全部 `document` / `navigator` / `atob` /
 * `require` 都在上下文里现造，宿主只递一个字符串（SDK 源码）。
 */
const SANDBOX_PRELUDE = `
(function () {
  var CHAT = 'https://www.doubao.com/chat/';
  function noop() {}
  function makeEl() {
    return {
      addEventListener: noop,
      removeEventListener: noop,
      appendChild: noop,
      setAttribute: noop,
      getContext: function () { return null; },
      style: {},
      children: [],
    };
  }
  var documentStub = {
    // 设备指纹会读 cookie；给一组稳定的假值（真正的账号 cookie 不进签名输入）。
    cookie: 'ttwid=1; s_v_web_id=verify_doubao_sandbox',
    referrer: CHAT,
    title: '\\u8c46\\u5305',
    readyState: 'complete',
    createElement: function () { return makeEl(); },
    getElementsByTagName: function () { return [makeEl()]; },
    querySelector: function () { return makeEl(); },
    querySelectorAll: function () { return []; },
    addEventListener: noop,
    removeEventListener: noop,
    documentElement: makeEl(),
    head: makeEl(),
    body: makeEl(),
    location: { href: CHAT },
  };
  var g = this;
  g.document = documentStub;
  g.location = {
    href: CHAT,
    host: 'www.doubao.com',
    hostname: 'www.doubao.com',
    origin: 'https://www.doubao.com',
    protocol: 'https:',
    pathname: '/chat/',
    search: '',
  };
  g.navigator = {
    userAgent: __UA__,
    language: 'zh-CN',
    languages: ['zh-CN'],
    platform: 'Win32',
    webdriver: false,
    hardwareConcurrency: 8,
    deviceMemory: 8,
  };
  g.screen = { width: 1536, height: 864, availWidth: 1536, availHeight: 824, colorDepth: 24, pixelDepth: 24 };
  g.performance = {
    now: function () { return Date.now(); },
    timeOrigin: Date.now() - 1000,
  };
  // Slardar 埋点用的 XHR：空实现，签名不需要它（真的发请求反而越界）。
  g.XMLHttpRequest = function XhrStub() {
    return { open: noop, send: noop, setRequestHeader: noop, addEventListener: noop, status: 0, responseText: '' };
  };
  g.addEventListener = noop;
  g.removeEventListener = noop;
  g.dispatchEvent = noop;
  g.innerWidth = 1536;
  g.innerHeight = 864;
  g.devicePixelRatio = 1;
  g.fetch = function () { return new Promise(function () {}); };
  // 不用宿主 setTimeout：微任务即可（SDK 只在极少数环境探测里排一次回调）。
  g.setTimeout = function (fn) {
    Promise.resolve().then(function () { try { fn(); } catch (e) {} });
    return 0;
  };
  g.clearTimeout = noop;
  g.setInterval = noop;
  g.clearInterval = noop;

  // base64：纯 JS 实现（不递宿主 Buffer）。
  // 走「字节流」而不是「按 4 字符组拼 char」——后者在带 "=" 补齐的输入上会多吐
  // 一个空字节（第一次实现踩过），而 SDK 拿它算指纹时那一个字节就足以改变结果。
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_LOOKUP = null;
  function lookup() {
    if (B64_LOOKUP !== null) return B64_LOOKUP;
    B64_LOOKUP = {};
    for (var i = 0; i < B64.length; i += 1) B64_LOOKUP[B64.charAt(i)] = i;
    return B64_LOOKUP;
  }
  function bytesOf(input) {
    var bytes = [], i, code;
    for (i = 0; i < input.length; i += 1) {
      code = input.charCodeAt(i);
      bytes.push(code > 255 ? code & 0xff : code);
    }
    return bytes;
  }
  g.btoa = function (input) {
    var bytes = bytesOf(String(input)), out = '', i, b0, b1, b2;
    for (i = 0; i < bytes.length; i += 3) {
      b0 = bytes[i];
      b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64.charAt(b0 >> 2)
        + B64.charAt(((b0 & 3) << 4) | (b1 >> 4))
        + (i + 1 < bytes.length ? B64.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '=')
        + (i + 2 < bytes.length ? B64.charAt(b2 & 63) : '=');
    }
    return out;
  };
  g.atob = function (input) {
    // 去掉空白与尾部 "="：**补齐字符不进字节流**，剩下的字符数天然决定字节数
    // （floor(len*6/8)），再做一次减法会把尾字节吃掉。
    var s = String(input).replace(/[\\s]/g, '').replace(/=+$/, '');
    var table = lookup(), bytes = [], buf = 0, bits = 0, i, value;
    for (i = 0; i < s.length; i += 1) {
      value = table[s.charAt(i)];
      if (typeof value !== 'number') continue;
      buf = (buf << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buf >> bits) & 0xff);
      }
    }
    var out = '';
    for (i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  };

  // SDK 唯一的跨 chunk 依赖是 "__webpack_require__('SE')"，只当 process 用。
  // ⚠️ 替身里**不带 versions.node** ⇒ SDK 判定「非 Node」，走自带的纯 JS md5，
  //    也就不会去 require('crypto') / require('buffer')。
  var processShim = {
    env: { NODE_ENV: 'production' },
    platform: 'linux',
    versions: {},
    browser: true,
    argv: [],
    cwd: function () { return '/'; },
  };
  g.require = function (name) {
    if (name === 'SE') return processShim;
    throw new Error('bdms SDK 不允许 require(' + String(name) + ')');
  };

  g.window = g;
  g.self = g;
  g.globalThis = g;
  g.top = g;
  g.parent = g;
  documentStub.defaultView = g;
}).call(this);
`

/**
 * 建一个纯净上下文并跑预置代码（导出仅为单测：用来断言上下文里没有宿主对象）。
 */
export function createBdmsContext(): vm.Context {
  const context = vm.createContext(Object.create(null))
  const prelude = SANDBOX_PRELUDE.replace('__UA__', JSON.stringify(DOUBAO_WEB_USER_AGENT))
  vm.runInContext(prelude, context, { timeout: INIT_TIMEOUT_MS, filename: 'bdms-sandbox-prelude.js' })
  vm.runInContext('var self = this;', context, { timeout: INIT_TIMEOUT_MS })
  return context
}

/**
 * 把 SDK 脚本跑进上下文，返回 `frontierSign`。
 *
 * ⚠️ 模块 id `Cc2` 是当前版本的常量；上游改了 id 时按「逐个调用直到 `window.bdms`
 * 出现」兜底 —— 比按名字猜更稳（签名入口只有这一个副作用）。
 * ⚠️ factory 也在**上下文内部**调用：`{}` 参数由上下文自己造，不把宿主对象递进去。
 */
function createSigner(script: string): (input: Record<string, string>) => string {
  const context = createBdmsContext()
  vm.runInContext(script, context, { timeout: INIT_TIMEOUT_MS, filename: SDK_FILE })

  vm.runInContext(
    `(function () {
      var pushed = this.rspackChunkapp_flow_chat;
      var modules = pushed && pushed[0] && pushed[0][1];
      if (!modules) throw new Error('bdms SDK 结构不认识（chunk 没有 push 出模块表）');
      var factory = modules.Cc2;
      if (typeof factory === 'function') { factory({}, {}, this.require); return; }
      var names = Object.keys(modules);
      for (var i = 0; i < names.length; i += 1) {
        var candidate = modules[names[i]];
        if (typeof candidate !== 'function') continue;
        try { candidate({}, {}, this.require); } catch (e) { /* 不是这个模块 */ }
        if (this.bdms !== undefined) break;
      }
    }).call(this);`,
    context,
    { timeout: INIT_TIMEOUT_MS, filename: 'bdms-bootstrap.js' },
  )

  const bdms = vm.runInContext(
    `(function () {
      if (typeof this.bdms === 'undefined') return null;
      return typeof this.bdms.frontierSign === 'function' ? 'ok' : 'no-frontierSign';
    }).call(this)`,
    context,
    { timeout: INIT_TIMEOUT_MS },
  ) as 'ok' | 'no-frontierSign' | null
  if (bdms === null) throw new Error('bdms SDK 初始化后没有 window.bdms（上游改了导出结构）')
  if (bdms === 'no-frontierSign') throw new Error('bdms SDK 初始化后没有 frontierSign（上游改了导出结构）')

  return (input) => {
    const bogus = vm.runInContext(
      `(function () {
        var signed = this.bdms.frontierSign({ 'X-MS-STUB': '' });
        return signed && typeof signed['X-Bogus'] === 'string' ? signed['X-Bogus'] : '';
      }).call(this)`,
      context,
      { timeout: INIT_TIMEOUT_MS },
    ) as string
    if (typeof bogus !== 'string' || bogus.length === 0) throw new Error('bdms 签名返回空串')
    return bogus
  }
}

let cachedSigner: { sign: (input: Record<string, string>) => string } | undefined

/**
 * 产出一枚 `a_bogus`（等价于页面里的 `window.bdms.frontierSign({'X-MS-STUB':''})`）。
 *
 * @throws 读不到内置 SDK / 哈希不符 / SDK 结构变化 / 签名空串 —— 调用方把原因写进失败文案。
 */
export async function signDoubaoBogus(options: { log?: (msg: string) => void } = {}): Promise<string> {
  const log = options.log ?? (() => {})
  if (cachedSigner === undefined) {
    log(`[doubao] 装载内置 bdms SDK（${SDK_FILE}，sha256 钉扎）`)
    cachedSigner = { sign: createSigner(loadDoubaoBdmsSdk()) }
    log('[doubao] bdms SDK 已在 Node 沙箱内就绪（零浏览器、零网络）')
  }
  return cachedSigner.sign({ 'X-MS-STUB': '' })
}

/** 清缓存（单测 / 升级内置 SDK 后强制重载用）。 */
export function resetDoubaoBdmsSigner(): void {
  cachedSigner = undefined
}
