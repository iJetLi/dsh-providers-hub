/**
 * Gemini 链路的**代理感知 fetcher**（Gitee issue IKLTZ2）。
 *
 * ## 缺陷背景
 *
 * Gemini（Cloud Code Assist）是本插件里**少数必须过墙**的渠道：令牌端点
 * （`oauth2.googleapis.com/token`）、userinfo、Cloud Code 的 `loadCodeAssist` /
 * `retrieveQuotaSummary` 与推理端点（`cloudcode-pa.googleapis.com`）全部在墙外。
 * 而本插件此前全链路用**裸 `fetch`**（Node 内置 undici），插件内**没有任何代理入口**：
 *
 * - undici **不读** Windows WinINET 系统代理（浏览器读，所以浏览器能打开授权页）；
 * - undici **不读** `HTTP(S)_PROXY`，除非额外开启 `NODE_USE_ENV_PROXY`（Node 22.21+/24+）。
 *
 * ⇒ 症状与 `gemini-oauth.ts` 文件头第 1 条注释（「浏览器显示授权成功，但面板里账号
 * 一直不出现」）**逐字同形**，极易被误判成 `client_secret` / `redirect_uri` 问题。
 *
 * ## 为什么复用 `opencode-proxy.ts` 的 `proxyFetch` 而不是自己写
 *
 * 缺陷 IKK4BY 已实测：外部 undici 的 Dispatcher 塞进**内置** fetch 的
 * `RequestInit.dispatcher` 会在 Node 22/24 上**恒抛** `UND_ERR_INVALID_ARG`
 * （两个 undici 版本的 handler 契约不同源）。故凡要传 dispatcher 的请求
 * **必须**走 `proxyFetch`（它内部用**同源**的 undici fetch）。这与 opencode
 * 是同一份实现，故直接复用，**不**写第二份。
 *
 * ## 作用域：**仅 Gemini**，不动全局 dispatcher
 *
 * opencode2dsh 的 R1 教训：两个插件抢全局槽位会互相短路整个路由层。
 * 宿主 DSH 启动器（`@deepseek-ai/dsh-http-proxy`）已在第一个插件加载前装过全局
 * dispatcher，用户导出 `HTTPS_PROXY` 时**裸 fetch 本来就被代理覆盖** —— 本模块
 * 补的是**宿主管不到的那一格**：只有环境变量、没有插件内出口时的 per-账号配置。
 */

import { asProxyText } from './account-pool.js'
import { networkBlockedHint } from './network-hint.js'
import { normalizeProxy, type NormalizedProxy } from './opencode.js'
import { proxyFetch } from './opencode-proxy.js'

export { normalizeProxy }

/**
 * 按**账号 id** 取该账号的代理串（读账号池字段；未配置时为空串 = 直连）。
 *
 * ⚠️ 返回**原始串**而不是 `NormalizedProxy`：归一可能失败（用户手填了非法地址），
 * 那必须**抛错**让用户看见，而不是静默退回直连。
 */
export type GeminiProxyLookup = (accountId: string) => string

/**
 * 按账号取 fetcher 的工厂（各调用点在**用到那一刻**解析，不预先缓存）。
 *
 * ⚠️ **为什么是「按账号现取」而不是构造时定一份**：适配器在一轮请求内会**换号**
 * （限流/401 时 `getAvailableAccount` 换人，见 `gemini-adapter.ts` 的轮换分支），
 * 出口必须跟着换；把 fetcher 在构造时固化会让换号后**仍走旧账号的出口**。
 */
export type GeminiFetcherResolver = (accountId: string) => typeof fetch

/**
 * 造「按账号取 fetcher」的解析器。
 *
 * ⚠️ **空账号 id（`''`）= 直连**：适配器在拿不到账号 id 时（无池 / 凭据不匹配）
 * 会用空串，此时**刻意直连**而不是查一个空 id 的账号 —— 查不到就是没配代理。
 */
export function createGeminiFetcherResolver(
  lookup: GeminiProxyLookup,
): GeminiFetcherResolver {
  return (accountId: string): typeof fetch => {
    // ⚠️ 空账号 id ⇒ **根本不查池**：查了会把「不知道是谁」变成「用某人的出口」。
    const raw = accountId === '' ? '' : asProxyText(lookup(accountId))
    if (raw.trim().length === 0) {
      // ⚠️ **退回全局 `fetch`**（而不是无脑用 undici fetch）：Node 24+ 的
      // `NODE_USE_ENV_PROXY` 等**宿主能力由内置 fetch 提供**，换成外部 undici
      // 会**静默丢掉**它们（`opencode-proxy.ts` 的 `proxyFetch` 内部也处理了这一格）。
      return fetch
    }
    const normalized = normalizeProxy(raw)
    if (!normalized.ok) {
      throw new Error(`gemini: 账号 ${accountId} 的代理地址无效 — ${normalized.reason}`)
    }
    const proxy: NormalizedProxy = normalized.proxy
    // ⚠️ 不直接返回 `proxyFetch` 本身：它的第三参是必填的 `proxy`，
    // 而调用方按 `typeof fetch` 的两参签名调用。
    const send = (input: string, init?: RequestInit): Promise<Response> =>
      proxyFetch(input, init ?? {}, proxy)
    return send as typeof fetch
  }
}

/**
 * 全仓**唯一**的 Gemini 账号代理解析器（Gitee issue IKLTZ2）。
 *
 * ## ⚠️ 为什么放这里而不是 `src/index.ts`
 *
 * 消费点有**三个**，其中两个在 `index.ts` 之前就能拿到引用：
 *
 * 1. `probeById.gemini`（`src/index.ts`，**模块级常量**，在 `apply()` 之前求值）；
 * 2. `GeminiAuth` / `GeminiAdapter` 的主接线（`src/index.ts` 的 `apply()`）；
 * 3. `credits.balances` 端点（`src/jet-hub-rpc.ts`）。
 *
 * 若把实例放在 `index.ts` 并从 `jet-hub-rpc.ts` 导入，就形成
 * `index → jet-hub-rpc → index` 的**环**（`index.ts` 本来就 import 它），
 * 在 ESM 下会把 `geminiFetchForAccount` 变成 TDZ 引用 ⇒
 * `credits.balances` 拿到 `undefined` 并**静默恒直连**（最难查的一类失效）。
 * ⇒ 单一实例住在**被依赖方向的下游**（本文件），两侧都只 import 它。
 *
 * ## 为什么池子要「可后填」
 *
 * `apply()` 里才有真正的 `AccountPool`，而上面第 1 个消费点在 `apply()` 之前
 * 就可能跑（账号卡片「测试」）。故用**可变引用** + 兜底直连，形状与 `index.ts`
 * 既有的 `sharedExpiryProbeRef` / `sharedChoiceCacheRef` 同款。
 */
let geminiPoolRef: GeminiProxyPoolLike | undefined

/** 解析器只需池子的「按账号读代理」这一个方法（结构化类型，便于单测注入）。 */
export interface GeminiProxyPoolLike {
  geminiProxyFor(accountId: string): string
  /**
   * ★ **该 provider 任一账号已配的代理**（可选 —— 旧注入方 / 单测替身不必实现）。
   *
   * ⚠️ **只给登录路径用**（见 {@link geminiLoginFetchForAccount}）：
   * 新账号还没落池 ⇒ `geminiProxyFor` 恒空 ⇒ 必需翻墙的用户登录不上。
   */
  geminiProxyForAny?(): string
}

/** 由 `apply()` 在池子就绪后注入（未注入 / 传 `undefined` 时恒直连）。 */
export function setGeminiProxyPool(pool: GeminiProxyPoolLike | undefined): void {
  geminiPoolRef = pool
}

/**
 * 进程内共用的 fetcher 解析器（三个消费点共用同一份，见上方「为什么放这里」）。
 *
 * ⚠️ 空账号 id / 池未就绪 ⇒ **直连**（不是抛错）：调用方（探测、换号后的重试）
 * 可能合法地拿不到账号 id，抛错会让「测试」按钮直接崩。
 */
export const geminiFetchForAccount: GeminiFetcherResolver = createGeminiFetcherResolver(
  (accountId) => (geminiPoolRef === undefined ? '' : geminiPoolRef.geminiProxyFor(accountId)),
)

/**
 * ★★★ **登录专用的代理感知 fetcher**（2026-11-26，issue #170）。
 *
 * ## 缺陷
 *
 * 用户报障「Gemini Code Assist 登录失败：`fetch failed`」，实际是**新账号登录时拿不到代理**：
 *
 * ```ts
 * geminiProxyFor(accountId)                       // 只按 id 查已落池的账号
 *   ⇒ 新账号的 id 刚生成、还没落池 ⇒ 恒返回 ''
 *   ⇒ createGeminiFetcherResolver 的 `raw === ''` 分支 ⇒ 返回裸 fetch
 *   ⇒ Google 在墙外 ⇒ TypeError: fetch failed
 * ```
 *
 * 而**推理**链一直有代理（`geminiFetchForAccount`），所以症状是
 * 「浏览器能打开授权页（浏览器读系统代理）、面板却一直不出现账号」。
 *
 * ## 修法
 *
 * 登录时：**先看该账号自己的代理；没有 ⇒ 借本 provider 任一已配代理的账号**。
 * 一个都没配 ⇒ 仍然直连（保持「没配代理就当不需要代理」的既有语义）。
 *
 * ⚠️ **绝不把这个回落用到推理 / 探测路径** —— 那里 `accountId` 是确定的，
 *   借别人的出口会让「这个号从哪出网」失真（也会让按 IP 判区的渠道误判）。
 */
export const geminiLoginFetchForAccount: GeminiFetcherResolver = createGeminiFetcherResolver(
  (accountId) => {
    if (geminiPoolRef === undefined) return ''
    const own = geminiPoolRef.geminiProxyFor(accountId)
    if (asProxyText(own).trim().length > 0) return own
    return geminiPoolRef.geminiProxyForAny?.() ?? ''
  },
)

/**
 * 连到 Google 超时/连不上时的**用户可读**提示（修法 3）。
 *
 * ## ⚠️ 为什么「文案本身就是出路」
 *
 * 缺陷的报障形态是「浏览器授权成功、面板里账号一直不出现」，而
 * `refresh.ts` 把 `fetch failed` 归入**可重试的瞬时网络错误**（60s 重试一次、
 * 面板零提示）—— 用户与排障者都看不到任何指向「代理」的线索。
 *
 * ⚠️ **不要把这类错误归 `AUTH` / `QUOTA`**：那两类码会连 message 一起吞掉
 * （Issue IKLBSH 的复发形态），恰好把唯一指路文案吃掉。
 *
 * @param error 原始异常。
 * @param aborted 是否是**自己 arm 的超时**触发（与真正的连接失败区分）。
 *   ⚠️ **调用方必须真的读 signal.aborted**，不能恒传 `false`
 *   （IKLTZ2 审计 P2-2：原三处调用点全是字面量 `false`，于是
 *   `AbortSignal.timeout()` 触发的墙外连接超时 —— 恰恰是 IKLTZ2 的主症状 ——
 *   因为没有 `UND_ERR_*` 错误码而拿不到任何提示；这形同「写进去却没人读」）。
 * @returns 有代理嫌疑时返回提示语，否则返回 `undefined`（调用方用原措辞）。
 */
/**
 * ★★★ **裸 `fetch failed` 的 Gemini 专属兜底文案**（2026-11-26，issue #170 审计 P1）。
 *
 * ## 为什么必须有它
 *
 * `geminiNetworkHint` 的判据吃的是 **`cause` 链上的错误码**（`network-hint.ts` 的 7 码表），
 * **不吃 `message`** —— 这个判据本身是对的（按码分类比按文案稳）。
 *
 * 但审计实测：**裸 `TypeError: fetch failed`（没有 `cause`、或 `cause` 的码不在表里）
 * ⇒ 返回 `undefined`** ⇒ 登录链退回原文案。而用户报障截图里显示的**正是裸的
 * 「登录失败：fetch failed」** ⇒ **修复会静默空跑**。
 *
 * ⇒ Gemini 是**唯一一个「端点全在墙外」的渠道**：对它来说 `fetch failed`
 *   几乎必然是网络不通（其余渠道失败时往往还有本地区域的连法）。
 *   故这里给一条**不依赖 cause 码**的兜底，只在 `geminiNetworkHint` 返回 `undefined`
 *   时使用（**不修改** `geminiNetworkHint` 本身 —— 它的判据是全仓共用的）。
 */
export const GEMINI_LOGIN_NETWORK_FALLBACK =
  '连不上 Google（网络层失败，未拿到具体错误码）。Gemini 全部端点都在墙外，插件进程不走系统代理。'
  + '解决办法二选一：①给任意一个已登录的 Gemini 账号配一个能出海的出口代理'
  + '（新建账号登录时会自动借用它），然后重试；'
  + '②在启动 DSH 之前导出 HTTPS_PROXY（Node 24+ 需同时设 NODE_USE_ENV_PROXY=1）。'
  + '⚠️ 浏览器能打开授权页是因为浏览器读系统代理 —— 插件进程不读，这不是同一个通道。'

/** `true` = 这是个**没有可用错误码**的网络层失败（用于挑兜底文案）。 */
export function isBareFetchFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  if (!/fetch failed/i.test(text)) return false
  // 有 cause 且 cause 带 code ⇒ 交给 `geminiNetworkHint` 的码表（那份更有信息量）
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  const code = typeof cause === 'object' && cause !== null
    ? (cause as { code?: unknown }).code
    : undefined
  return typeof code !== 'string' || code.length === 0
}

export function geminiNetworkHint(error: unknown, aborted: boolean): string | undefined {
  // 判据与码表在 `network-hint.ts`（全仓唯一一份）—— 这里只负责 Gemini 专属的出路文案。
  // 曾经的重复实现见 git 历史：同一码表在 `refresh.ts` / 此处各有一份，改一处漏一处。
  return networkBlockedHint({
    error,
    aborted,
    subject: 'Google',
    /**
     * ⚠️⚠️ **文案的每一条都必须是「此刻真的能做」的动作**（2026-11-26，issue #170 审计 P2）。
     *
     * 原来的第一出路写的是「账号卡片上的『代理』按钮」—— **那是假出路**：
     * `failLogin` 在记录终态的同时**会把占位账号删掉**（不留幽灵账号），
     * 所以用户读到这句话时**那张卡片已经不存在了**，找不到按钮。
     *
     * ⇒ 现在的顺序是「先有一个能配代理的地方，再谈这个新账号」：
     *   ① 给**任一已登录的 Gemini 账号**配代理（登录专用回落会借它 —— 见
     *      `geminiLoginFetchForAccount`）→ 然后重试；
     *   ② 一个 Gemini 账号都没有 / 不想借 ⇒ 启动 DSH 前导出 `HTTPS_PROXY`
     *      （宿主内置 fetch 在 Node 24+ 支持 `NODE_USE_ENV_PROXY`）。
     */
    remedy: 'Gemini 全部端点都在墙外，插件进程不走系统代理。'
      + '解决办法二选一：①给任意一个已登录的 Gemini 账号配一个能出海的出口代理'
      + '（新建账号登录时会自动借用它），然后重试；'
      + '②在启动 DSH 之前导出 HTTPS_PROXY（Node 24+ 需同时设 NODE_USE_ENV_PROXY=1）。'
      + '⚠️ 浏览器能打开授权页是因为浏览器读系统代理 —— 插件进程不读，这不是同一个通道。',
  })
}
