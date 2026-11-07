/**
 * Qoder **远端模型目录**（`/api/v2/model/list?Encode=1`）。
 *
 * ## 为什么需要它（真实缺陷，2026-10-20 用户报障）
 *
 * 本插件此前**恒用编译期兜底表**（`QoderProduct.fallbackModels`，快照日期
 * 国际版 2026-09-21 / 中国版 2026-09-27），一次远端请求都不发。而上游改价、
 * 改免费额度、上/下架模型都不会通知任何人 ⇒ 纯静态快照必然腐坏：
 *
 * | 现象（2026-10-20 真机对账） | 兜底表 | 上游实际 |
 * |---|---|---|
 * | `dfmodel`（DeepSeek-Flash） | `price_factor = 0.1` | **`0` + `is_free` + 原价 0.1**（IDE 显示 `0.1×`划掉`0×`） |
 * | `mmodel` | `MiniMax-M2.7` / 0.2 | **`MiniMax-M3.1-Flash` / 0.1** |
 * | `fast` | 无此条 | 有（`price_factor 0.8`，受客户端版本闸门控制） |
 *
 * ⇒ 模型列表**必须以远端为准**，兜底表只作「拉不到时别把菜单变空」的回退
 * （与其余 12 家的 `loadCatalog` / `syncCatalog` 两段式同形）。
 *
 * ## 协议（取自本机 IDE 产物 + 真机实测）
 *
 * 端点与请求形状来自客户端 `qoder-worker-runtime` 的 `listModelsFromRemote`：
 *
 * ```js
 * let s = "/api/v2/model/list?Encode=1"          // 可再拼 &outerProviders=…
 * let l = async () => {
 *   let A = JqA(g, s, this.authManager)          // ← WASM 签名（prepareRequest）
 *   return await this.fetchWithTrace({ operation:"listModels", endpointType:"infer",
 *     method:"GET", path:s, url:A.url, init:{ method:"GET", headers:A.headers } })
 * }
 * let E = rb(await B.text())                     // ← rb = decrypt_server_response（失败即明文）
 * let u = JSON.parse(E)                          // { 场景: [模型…] }
 * ```
 *
 * 四条**实测边界**（2026-10-20，真实凭据，两个产品各验一遍）：
 *
 * 1. **host = `encryptedInferBase`**（CN `gateway.qoder.com.cn` / 国际 `api2.qoder.sh`），
 *    WASM 会在路径前补 `/algo` ⇒ 实发 `…/algo/api/v2/model/list?Encode=1`。
 * 2. **只发 GET、不带 body**，鉴权是 WASM 生成的 `Bearer COSY.<载荷>.<签名>`
 *    （18 个头）—— 用普通 `Bearer <token>` 会被拒。
 * 3. **`Encode=1` 不保证响应加密**：实测两个产品都回**明文 JSON**
 *    （`decrypt_server_response` 失败 ⇒ 走「失败即明文」回退，与官方 `rb()` 逐字同形）。
 *    故解密那一步**不能**当成必成功。
 * 4. **响应是 `{场景: [模型]}`**，顶层实际键：
 *    `chat / developer / assistant / inline / quest / qwork / experts / qwake / app /
 *    byok_teams / byok_enterprise`。本插件取 {@link QODER_CATALOG_SCENES}
 *    （`chat` ∪ `app`）—— **只取 `chat` 会漏掉 `QoDuck`**，见下一节。
 *
 * ## ⚠️ 为什么必须并 `app` 场景：`QoDuck`（`lmodel`）只发布在 `app` 里
 *
 * 2026-11-07 实测（真实凭据；声明版本 `1.1.49` / `1.1.69` / `1.1.70` 三档各拉
 * 一遍，`scripts/probe-qoder-duck.mts`）：
 *
 * `app` 场景 ≡ `chat` 场景 **+ `lmodel`（`QoDuck`）**，**逐版本成立**；
 * 反向差集（`chat` 有而 `app` 没有的）**一条都没有**。
 *
 * 而 `QoDuck` 条目里**根本没有 `minimal_version` 字段** ⇒ 它不受版本闸门管辖，
 * 抬版本一分都拿不到它（抬到 1.1.70 多出的是另一个模型 `fast`）。只读 `chat`
 * 的旧实现因此**结构性地**看不见它 —— 这不是「声明版本太低」，是**读错了场景**。
 *
 * 可用性已实测：`QoderAdapter.stream({ model: 'lmodel' })` 回 200 + 正文正常
 * （`scripts/probe-qoder-duck-call.mts`）。⚠️ 首包 **91.4s**，而 `dfmodel` 只要
 * **3.7s** —— 上游模型特性，不是插件问题；接进列表后会体现为「这个模型很慢」。
 *
 * 并场景后它自动走同一条展示/能力链路：窗口 **1M**（`parseContextWindow` 取
 * `context_config` 最大值，**刻意不认** `max_input_tokens: 180000`，理由见该函数
 * 注释）、`supportsImage: true`（`is_vl`）、三档思考 `low/high/xhigh`（默认
 * `high`）、`isFree: true`（`price_factor: 0`，原价 `0.5×`）。
 *
 * ## ⚠️ 版本闸门（`minimal_version`）
 *
 * 模型条目可带 `minimal_version: {app, cli, qoder_wake, vsc}`，服务端按
 * **请求方自称的客户端类型**选对应的命名空间比较：
 *
 * | 实测用例（同一账号、只改身份与版本） | `chat` 条数 | `fast` |
 * |---|---|---|
 * | `client_type=5`（cli） + `1.1.49`（2026-10 的旧值） | 14 | ✗ |
 * | `client_type=5` + `1.1.69` | 14 | ✗ |
 * | `client_type=5` + `1.1.70` | 15 | ✓ |
 * | `client_type=5` + `1.1.79` / `1.1.80` / `1.2.0` / `9.9.9` | 15 | ✓ |
 * | `client_type=10`（app，IDE 用它） + `0.4.8` | 14 | ✗ |
 * | `client_type=10` + `1.1.66` | 15 | ✓ |
 * | `client_type=10` + `1.1.69`（= IDE 的 SDK 版本常量） | 15 | ✓ |
 *
 * 即 `fast` 的闸门是 `{app: 1.1.66, cli: 1.1.70}`，**且目录在 1.1.70 处封顶**
 * （1.1.79 / 1.1.80 / 1.2.0 / 9.9.9 与 1.1.70 逐条相同）。
 *
 * ⚠️ **2026-11-07 起 `COSY_VERSION` 抬到 `1.1.79`**（用户要求）。依据：本机两个
 * 产品都装到 IDE **0.5.6**，其 `logs/runs/<run>/manifest.json` 的 `cli_version` 恒为
 * **`1.1.79-hotfix.18`**（`~/.qoder` 与 `~/.qoder-cn` 各取最新一条 run 实测一致）
 * ⇒ 官方客户端自称的就是 1.1.79 这一档。取 `1.1.79`（**不带** `-hotfix.18`
 * 预发布后缀）以保持 semver 单调 —— 预发布版本按 semver **低于**同位正式版，
 * 若上游哪天把闸门抬到 `1.1.79` 本身，带后缀会静默判不过。
 *
 * ⚠️ 该常量**同时进推理签名**（`QoderContext` 的 `Cosy-Version` 与签名载荷），
 * 故抬版本必须**实测推理仍 200**：`scripts/probe-qoder-duck-call.mts` 在 1.1.79
 * 下对 `lmodel` / `dfmodel` 各发一次，均 HTTP 200 + 正文正常（2026-11-07）。
 *
 * ## ⚠️ 与「本地 catalog-v6」的区别（不要混用）
 *
 * IDE 的 `~/.qoder/.models/{uid}/catalog-v6` 也能解出同一份数据，且**离线**、
 * 不需要签名。但它是**该账号在本地 IDE 里打开过**才有的产物：纯插件用户
 * （没装 IDE / 没在 IDE 登录过该账号）恒为空 —— 那正是「未开通」那类账号。
 * 故线上路径走本模块（签名远端），本地缓存只用于排查对账。
 */

import type { QoderCredential } from './qoder.js'
import type { QoderFallbackModel, QoderModelPromotion, QoderProduct } from './qoder-product.js'
import { QoderEncryptedInfer, decryptServerResponseOrRaw, describeWasmFailure } from './qoder-wasm.js'

/**
 * 目录端点（挂 `encryptedInferBase`）。
 *
 * ⚠️ **不要**写成 `/algo/api/v2/model/list`：`/algo` 前缀由 WASM 的
 * `prepareRequest` 自己补（与 `webSearch/oneSearch` 同款），手写会变成
 * `/algo/algo/…` 而 404。
 */
export const QODER_MODEL_LIST_PATH = '/api/v2/model/list?Encode=1'

/** 目录响应的**场景键**（见模块头第 4 条）。 */
export const QODER_CATALOG_SCENE = 'chat'

/**
 * 参与合并的**场景键**，**按优先级降序**（前面的赢）。
 *
 * ⚠️ 必须并 `app`：`QoDuck`（`lmodel`）只发布在 `app` 场景，且**不带**
 * `minimal_version`（完整论证见模块头「为什么必须并 `app` 场景」）。
 * 实测 `app` ≡ `chat` + `lmodel`，逐版本成立，故并进来**只多这一个模型**。
 *
 * 顺序即优先级：`chat` 是加密推理端点实际走的那一类会话，同一 id 在两边都
 * 出现时取 `chat` 那条（与旧实现的取值逐字节一致 ⇒ 并场景不改变既有模型）。
 */
export const QODER_CATALOG_SCENES: readonly string[] = ['chat', 'app']

/**
 * 单次目录请求预算（毫秒）。
 *
 * 官方客户端的目录请求超时是 `Sqc = 12e4`（120s，见 `HzA/Sqc` 常量对），
 * 但那是**后台目录同步**的预算；本插件在 `listModels` 的宿主路径上被 await，
 * 拖满两分钟会让模型选择器卡死。取 15s（与 `qoder-credits.ts` 的
 * `QODER_CREDITS_TIMEOUT_MS` 同值同因），超时即回退兜底表。
 */
export const QODER_CATALOG_TIMEOUT_MS = 15_000

/**
 * 思考档位白名单（官方产物常量 `k3`）。
 *
 * ⚠️ **必须过滤**：不在白名单里的键会被官方客户端静默丢弃
 * （`xsn()` → `ci()` 逐个判白名单），而我们若把它声明进 `efforts`，
 * DSH 的档位选择器就会把它渲染出来、用户选中后带着一个上游不认的值发请求
 * （`trae-adapter.ts` 记着这条教训：给不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`）。
 *
 * ⚠️⚠️ **只有 6 个值、没有 `minimal`**（2026-10-20 从本机 IDE 产物逐字复核）：
 *
 * ```js
 * k3 = ["none","low","medium","high","xhigh","max"], yhc = new Set(k3)
 * ```
 *
 * 本文件原先多写了一个 `minimal`，依据是更早一次逆向留下的注释
 * （`qoder-adapter.ts` 的档位中文名表里也记着它"在白名单 `Qj` 里"）——
 * 那次快照与当前产物不符。**中文名表保留 `minimal`**（i18n 里确有它的显示名），
 * 但**线上白名单以本常量为准**：上游真下发它时按官方行为**丢掉**。
 */
const EFFORT_WHITELIST: ReadonlySet<string> = new Set([
  'none', 'low', 'medium', 'high', 'xhigh', 'max',
])

/** 档位别名（官方常量 `xhc`，与我们逐字一致）。 */
const EFFORT_ALIASES: ReadonlyMap<string, string> = new Map([
  ['disabled', 'none'],
  ['off', 'none'],
])

/** 读非空字符串字段。 */
function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 把任意值收窄成记录（数组与非对象都返回 undefined，与官方 `JsA()` 同口径）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 读有限数字字段（容忍数字字符串）。 */
function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 把目录里的档位名归一化到白名单取值；不在白名单内返回 undefined。 */
function normalizeEffort(raw: string): string | undefined {
  const key = raw.trim().toLowerCase()
  const aliased = EFFORT_ALIASES.get(key) ?? key
  return EFFORT_WHITELIST.has(aliased) ? aliased : undefined
}

/**
 * 从 `efforts` 字段取档位 —— **三种形态都认**，与官方 `sgi()` 逐格对齐：
 *
 * ```js
 * function sgi(A) {
 *   if (Array.isArray(A)) { let e = xsn(A); return e ? { efforts: e, supportsDisabled: false } : undefined }
 *   if (typeof A === 'string') { let e = xsn(A.split(/[,\s]+/)); … }
 *   …对象：遍历键，ci() 归一、vhc() 判 is_default/isDefault…
 * }
 * ```
 *
 * ⚠️ **只认对象是本模块的第一版**（真机两站实测都是对象），对抗审计把
 * 「数组/字符串」两种形态验成**零覆盖**（变异后 4 个 spec 175 条全绿）——
 * 上游一改形状，档位选择器会**静默消失**。故按官方实现补齐三形态。
 *
 * ⚠️ **不要排序**：对象形态的键序**就是**官方 IDE 的渲染序（客户端用
 * `Object.entries` 遍历），排序会让我们与 IDE 的档位条不一致 ——
 * 完整论证见 `QoderFallbackModel.efforts` 的注释（Issue IKLIDV）。
 */
function parseEfforts(value: unknown): { efforts: string[]; defaultEffort?: string } {
  const dedupe = (raw: readonly unknown[]): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const key = normalizeEffort(item)
      if (key === undefined || seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
    return out
  }

  if (Array.isArray(value)) return { efforts: dedupe(value) }
  if (typeof value === 'string') return { efforts: dedupe(value.split(/[,\s]+/)) }

  const record = asRecord(value)
  if (record === undefined) return { efforts: [] }
  const efforts: string[] = []
  const seen = new Set<string>()
  let defaultEffort: string | undefined
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = normalizeEffort(rawKey)
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    efforts.push(key)
    // 官方 `vhc()`：蛇形与驼峰**都认**。
    const flag = asRecord(rawValue)
    if (flag?.is_default === true || flag?.isDefault === true) defaultEffort = key
  }
  return defaultEffort === undefined ? { efforts } : { efforts, defaultEffort }
}

/** 该条目的思考档位与「能否关闭思考」。 */
interface QoderThinking {
  efforts: string[]
  defaultEffort?: string
  supportsDisable: boolean
}

/**
 * 复刻官方 `R3()`：从**条目**上按固定顺序找档位。
 *
 * ```js
 * function R3(A) {
 *   let e = bhc(A), t = Psn(A)            // t: A 自身的档位字段（含 thinking_config? 否——见下）
 *   if (t) return ysn(t, e)
 *   for (let k of ogi) {                  // ogi = ['thinking_config','thinkingConfig']
 *     let b = JsA(A[k]); if (!b) continue
 *     let n = Psn(b); if (n) return ysn(n, e)
 *     for (let s of Rhc) {                // Rhc = ['enabled','enabledConfig']
 *       let c = JsA(b[s]); if (!c) continue
 *       let n = Psn(c); if (n) return ysn(n, e)
 *     }
 *   }
 * }
 * ```
 *
 * ⚠️ `ogi` / `Rhc` 这两个命名空间列表是官方原样，**不要顺手扩**。
 */
function effortsFromEntry(entry: Record<string, unknown>): { efforts: string[]; defaultEffort?: string } {
  const top = parseEfforts(entry.efforts)
  if (top.efforts.length > 0) return top
  for (const blockKey of ['thinking_config', 'thinkingConfig']) {
    const block = asRecord(entry[blockKey])
    if (block === undefined) continue
    const direct = parseEfforts(block.efforts)
    if (direct.efforts.length > 0) return direct
    for (const enabledKey of ['enabled', 'enabledConfig']) {
      const enabled = asRecord(block[enabledKey])
      if (enabled === undefined) continue
      const nested = parseEfforts(enabled.efforts)
      if (nested.efforts.length > 0) return nested
    }
  }
  return { efforts: [] }
}

/**
 * 该条目的思考档位与「能否关闭思考」。
 *
 * 四条口径**逐条对齐官方客户端**（`R3()` / `Mhc()` / `vhc()` / 那行
 * `a = R3(e) ?? R3({thinking_config: e.available_reasoning_effort})`）：
 *
 * 1. 档位优先取 `thinking_config.enabled.efforts`，其次 `thinking_config.efforts`、
 *    条目顶层的 `efforts`；
 * 2. **`available_reasoning_effort` 是「一个 `thinking_config` 对象」**，
 *    不是档位表本身 —— 必须包一层再解析（见下）；
 * 3. `defaultEffort`：先取档位对象里的 `is_default`/`isDefault`，
 *    都没有时才用顶层 `default_effort`/`defaultEffort`；
 * 4. `supportsDisable` = `thinking_config.disabled` 存在（`Mhc()`）
 *    **或**顶层 `supports_disabled`/`supportsDisabled` 为真（官方那行 `l = …`）。
 *
 * ⚠️ 3 与 4 **相互独立**：实测 `gfmodel` 有档位但不能关闭，而
 * `qmodel` / `qmodel_latest` 没有档位但能关闭（只有 `disabled` + `enabled.is_default`）。
 */
/** `thinking_config` 块里是否存在 `disabled` 分支（官方 `Mhc()`：存在且不为 null/false）。 */
function hasDisabledBranch(block: Record<string, unknown> | undefined): boolean {
  if (block === undefined) return false
  return block.disabled !== undefined && block.disabled !== null && block.disabled !== false
}

function parseThinking(entry: Record<string, unknown>): QoderThinking {
  let ownDisabled = false
  for (const blockKey of ['thinking_config', 'thinkingConfig']) {
    if (hasDisabledBranch(asRecord(entry[blockKey]))) ownDisabled = true
  }

  let parsed = effortsFromEntry(entry)
  let sourceDisabled = ownDisabled
  /**
   * ⚠️ **只有「条目自身既无档位、也无 `disabled`」时才去看 `available_reasoning_effort`**
   * —— 这是官方 `a = R3(e) ?? R3({thinking_config: e.available_reasoning_effort})`
   * 的**短路语义**：`R3(e)` 在「有 disabled 但无档位」时也返回非 undefined
   * （`{efforts: [], supportsDisabled: true}`），此时包装对象**根本不会被读**。
   * 同样地，包装对象里的 `disabled` 只在它真被读到时才算数。
   */
  if (parsed.efforts.length === 0 && !ownDisabled) {
    const alt = asRecord(entry.available_reasoning_effort ?? entry.availableReasoningEffort)
    if (alt !== undefined) {
      // ⚠️ 官方原样：该字段是 **thinking_config 形状的对象**，故包一层再解析；
      //    直接当档位表解析只会拿到 `enabled`/`disabled` 两个键（全被白名单丢掉）
      //    ⇒ 档位选择器静默消失。
      parsed = effortsFromEntry({ thinking_config: alt })
      if (hasDisabledBranch(alt)) sourceDisabled = true
    }
  }

  let supportsDisable = sourceDisabled
  if (entry.supports_disabled === true || entry.supportsDisabled === true) supportsDisable = true

  if (parsed.defaultEffort === undefined) {
    // 官方 `c = ci(e.default_effort ?? e.defaultEffort)`，用作档位对象未给默认时的兜底。
    const top = entry.default_effort ?? entry.defaultEffort
    if (typeof top === 'string') parsed = { ...parsed, defaultEffort: normalizeEffort(top) }
  }
  return { ...parsed, supportsDisable }
}

/**
 * 上下文窗口：取**档位表的最大档**。
 *
 * ⚠️ **不取 `max_input_tokens`** —— 两者经常自相矛盾（CN `dmodel`：
 * `max_input_tokens` 96000、档位表却到 1M），而官方客户端只认档位表
 * （`zX()` 一旦发现档位表存在就只检查成员资格）。完整论证见
 * `qoder-product.ts` 里 CN 表前的长注释。
 *
 * 都取不到时返回 **0**（= 不声明），由 `toCatalogEntry` 丢掉该字段 ——
 * 编造一个窗口会让 DSH 在错误的点上触发压缩。
 */
function parseContextWindow(entry: Record<string, unknown>): number {
  const maxOf = (values: readonly unknown[]): number => {
    let max = 0
    for (const value of values) {
      const token = typeof value === 'object' && value !== null
        ? readNumber(value, 'token_count')
        : typeof value === 'number' ? value : undefined
      if (token !== undefined && token > max) max = token
    }
    return max
  }
  const config = entry.context_config
  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    const max = maxOf(Object.values(config as Record<string, unknown>))
    if (max > 0) return max
  }
  const windows = entry.available_context_windows ?? entry.availableContextWindows
  if (Array.isArray(windows)) {
    const max = maxOf(windows)
    if (max > 0) return max
  }
  return 0
}

/**
 * 错峰折扣（目录 `promotion`）。
 *
 * ⚠️ `active` 是**目录下发那一刻**的快照，长期运行的会话里会过期 ——
 * 展示时按 `windowStart`/`windowEnd` 本地推算（`qoderDisplayName`）。
 * 故这里原样保留它，让「窗口字段缺失」时仍有回退判据。
 */
function parsePromotion(raw: unknown): QoderModelPromotion | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const discountFactor = readNumber(record, 'discount_factor')
  const beforePromotionPriceFactor = readNumber(record, 'before_promotion_price_factor')
  const windowStart = readString(record, 'window_start')
  const windowEnd = readString(record, 'window_end')
  if (discountFactor === undefined && beforePromotionPriceFactor === undefined
    && windowStart === undefined && windowEnd === undefined) {
    return undefined
  }
  const badgeZh = readString(record.badge, 'zh')
  return {
    active: record.active === true,
    ...discountFactor === undefined ? {} : { discountFactor },
    ...beforePromotionPriceFactor === undefined ? {} : { beforePromotionPriceFactor },
    ...windowStart === undefined ? {} : { windowStart },
    ...windowEnd === undefined ? {} : { windowEnd },
    ...badgeZh === undefined ? {} : { badgeZh },
  }
}

/**
 * 把一个远端模型条目转成兜底表同形（`QoderFallbackModel`）。
 *
 * ⚠️ **刻意复用兜底表的结构**：下游的 `qoderDisplayName`（倍率拼名）、
 * `qoderEffortsFor`（档位）、`toCatalogEntry`（能力）全都按该形状实现，
 * 转换放这里 ⇒ 远端与兜底表**走完全同一条展示/能力链路**，
 * 不会出现「远端条目少了某个字段于是倍率不显示」这类分叉。
 *
 * 形状不符（缺 key / 缺 display_name）或 `enable === false` 的条目返回 undefined
 * —— 后者是上游的「已停用」标记，客户端也把它滤掉。
 */
export function qoderRemoteModelToFallback(raw: unknown): QoderFallbackModel | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entry = raw as Record<string, unknown>
  if (entry.enable === false) return undefined
  const id = readString(entry, 'key') ?? readString(entry, 'model_key')
  const name = readString(entry, 'display_name')
  // DSH 的 `listModels` 校验要求 `name` **非空字符串**（见 `canonical-models.ts`
  // 记的 `INVALID_CATALOG`），故两者缺一即丢弃而不是填占位符。
  if (id === undefined || name === undefined) return undefined

  const priceFactor = readNumber(entry, 'price_factor')
  const originalPriceFactor = readNumber(entry, 'original_price_factor')
  const promotion = parsePromotion(entry.promotion)
  const thinking = parseThinking(entry)
  return {
    id,
    name,
    contextWindow: parseContextWindow(entry),
    supportsImage: entry.is_vl === true,
    // ⚠️ 这是**请求体 `model_config.is_reasoning` 的透传值**，不是「支持思考」的开关
    //    —— CN `dfmodel` 实测 `is_reasoning=false` 但思考与档位都正常（档位来自
    //    `thinking_config`）。完整论证见 `QoderFallbackModel.supportsThinking`。
    supportsThinking: entry.is_reasoning === true,
    ...entry.is_free === true ? { isFree: true } : {},
    ...priceFactor === undefined ? {} : { priceFactor },
    ...originalPriceFactor === undefined ? {} : { originalPriceFactor },
    ...promotion === undefined ? {} : { promotion },
    ...thinking.efforts.length === 0 ? {} : { efforts: thinking.efforts },
    ...thinking.defaultEffort === undefined ? {} : { defaultEffort: thinking.defaultEffort },
    ...thinking.supportsDisable ? { supportsDisable: true } : {},
  }
}

/**
 * 解析 `/api/v2/model/list` 的响应体。
 *
 * @param body - 已解密的 JSON。
 * @param scene - 场景键；缺省 {@link QODER_CATALOG_SCENE}。
 * @returns 该场景的模型列表；**响应形状不符时返回 `undefined`**（与「空列表」
 *   严格区分：前者是协议变了，后者是上游真的没给模型，两者对调用方的含义不同）。
 */
export function parseQoderRemoteModels(
  body: unknown,
  scene: string = QODER_CATALOG_SCENE,
): QoderFallbackModel[] | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const list = (body as Record<string, unknown>)[scene]
  if (!Array.isArray(list)) return undefined
  const models: QoderFallbackModel[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const model = qoderRemoteModelToFallback(raw)
    // ⚠️ 去重：DSH 的 `listModels` 对**重复 id** 会抛 `INVALID_CATALOG`
    //（整个 provider 从选择器里消失），而上游按场景合并时可能给出重复 key。
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/**
 * 解析**多个场景**并合并（按 `scenes` 顺序去重，靠前的赢）。
 *
 * 为什么不直接「逐个场景各调一次 {@link parseQoderRemoteModels} 再拼」：那样
 * **跨场景**会留下重复 id，而 DSH 的 `listModels` 对重复 id 抛 `INVALID_CATALOG`
 * —— 整个 provider 从选择器里消失（比少一个模型更糟）。去重必须与合并同时做。
 *
 * @param body - 已解密的 JSON。
 * @param scenes - 参与合并的场景键，**按优先级降序**；缺省
 *   {@link QODER_CATALOG_SCENES}。
 * @returns 合并后的模型列表；**一个场景都不是数组**时返回 `undefined`
 *   （协议变了）。⚠️ 与「空列表」严格区分：`chat` 空但 `app` 有模型时
 *   **照常返回** `app` 的那些（不能被「空 `chat`」判成协议变更）。
 */
export function parseQoderRemoteModelsForScenes(
  body: unknown,
  scenes: readonly string[] = QODER_CATALOG_SCENES,
): QoderFallbackModel[] | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const models: QoderFallbackModel[] = []
  const seen = new Set<string>()
  let found = false
  for (const scene of scenes) {
    const list = record[scene]
    if (!Array.isArray(list)) continue
    found = true
    for (const raw of list) {
      const model = qoderRemoteModelToFallback(raw)
      if (model === undefined || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
  }
  return found ? models : undefined
}

/** {@link fetchQoderRemoteModels} 的可注入依赖（测试用）。 */
export interface QoderRemoteCatalogOptions {
  /** 注入的 fetch；缺省用全局。 */
  fetcher?: typeof fetch
  /** 单次请求预算（毫秒）；缺省 {@link QODER_CATALOG_TIMEOUT_MS}。 */
  timeoutMs?: number
}

/**
 * 拉取远端模型目录（WASM 签名 → GET → 解密 → 解析）。
 *
 * ⚠️ **失败一律抛错**，由调用方（`QoderAdapter.ensureRemoteModels`）回退兜底表：
 * 这里吃掉的失败会让「目录挂了」表现为「模型变少了」，而回退兜底表至少保住菜单。
 *
 * ⚠️ **凭据的 `uid` 与 `machine_id` 是必需项**：前者参与
 * `generate_runtime_auth_fields`（缺了会产出**签名无效**的请求），后者进
 * `QoderContext`。缺任一项直接抛，不发一次注定失败的请求。
 */
export async function fetchQoderRemoteModels(
  credential: QoderCredential,
  product: QoderProduct,
  options: QoderRemoteCatalogOptions = {},
): Promise<QoderFallbackModel[]> {
  const fetcher = options.fetcher ?? fetch
  const uid = credential.uid
  if (uid === undefined || uid.length === 0 || credential.machine_id.length === 0) {
    throw new Error('凭据缺 uid / machine_id，无法签名模型目录请求（请重新登录该账号）')
  }

  // 🔴 `QoderEncryptedInfer` 持有 wasm `QoderContext`，**用完必须释放**：
  // 进程级共享的 wasm 堆只增不减，长会话最终以裸 `RuntimeError: unreachable`
  // 暴毙（完整事故史见 `qoder-wasm.ts` 文件头）。目录请求是**周期性**的
  // （20 分钟一轮 × N 个账号），漏释放会让这条泄漏比推理路径更快累积。
  let client: QoderEncryptedInfer | undefined
  try {
    client = await QoderEncryptedInfer.create({
      user: { uid, securityOauthToken: credential.security_oauth_token ?? credential.access_token },
      machineId: credential.machine_id,
      metadata: { ...product.clientMetadata },
      host: product.encryptedInferBase,
    })
    const request = client.prepareRequest(
      product.encryptedInferBase, QODER_MODEL_LIST_PATH, 'GET', 'auth',
    )
    const response = await fetcher(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? QODER_CATALOG_TIMEOUT_MS),
    })
    if (!response.ok) {
      // ⚠️ **必须带上响应体片段**：本家目录端点的失败形态里，
      // `401`/`403` 既可能是「token 过期」也可能是「签名无效（101）」——
      // 只看状态码分不开，而两者对用户的出路完全不同（重新登录 vs 协议回归）。
      // 这段文案最终会进 `warn` 日志，是唯一能事后定性的证据。
      const snippet = await response.text().catch(() => '')
      throw new Error(
        `模型目录请求失败（HTTP ${response.status}）${snippet.length === 0 ? '' : `：${snippet.trim().slice(0, 200)}`}`,
      )
    }
    // ⚠️ 「解密失败即明文」是**协议的一部分**（官方 `rb()` 就是这么写的），
    //    故不能把解密失败当错误 —— 实测两个产品都回明文。
    const plain = await decryptServerResponseOrRaw(await response.text())
    const models = parseQoderRemoteModelsForScenes(JSON.parse(plain) as unknown)
    if (models === undefined) {
      throw new Error(
        `模型目录响应形状非法（无 ${QODER_CATALOG_SCENES.join(' / ')} 场景数组）`,
      )
    }
    if (models.length === 0) throw new Error('模型目录响应为空')
    return models
  } catch (error) {
    // wasm trap（裸 `unreachable`）在 glue 层已被改写，这里再兜一次，
    // 保证调用方的日志里是可读成因而不是一个词。
    throw describeWasmFailure(error)
  } finally {
    // ⚠️ **释放失败绝不能顶替 `try` 里的原始错误**（JS 的 `finally` 里 `throw`
    // 会无条件覆盖 `try` 的 `throw`，而 `freePointer` 在堆耗尽时**确实会抛**）
    // ⇒ 与 `qoder-adapter.ts` 的 `buildRequest` 同款取舍：清理动作失败不改结论。
    try {
      client?.dispose()
    } catch {
      // 刻意吞掉：目录读取的结论已定，释放失败只影响后续（堆已耗尽时也无从补救）。
    }
  }
}
