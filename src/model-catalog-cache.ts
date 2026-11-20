/**
 * **模型目录的磁盘缓存**（2026-11-20，用户要求「重启后无感加载」）。
 *
 * ## 它解决什么
 *
 * 冷启动时宿主 `buildModelCatalog` 会对**每个** provider `await listModels()`，
 * 而目录只能从上游现拉 ⇒ 实测首屏 **~2 秒**（各家网络往返里最慢那家决定）。
 *
 * ⚠️ 这不是可选优化：`resolveModel` 也会 `await loadCatalog()`，宿主会对
 * **每个模型**再调一次 —— 目录没落地时这条路径同样等网络。
 *
 * ## 方案：stale-while-revalidate（用户原话「先使用缓存的数据，等远端拉取
 * 完成后就无感使用远端真实数据替换缓存数据」）
 *
 * ```
 * listModels()
 *   ├─ ① 同步读磁盘缓存（<10ms）⇒ **立即返回**（可能是上次的目录）
 *   ├─ ② 后台拉远端（不阻塞 ①）
 *   └─ ③ 成功 ⇒ 写盘 + 广播 `llm/adapters-updated` ⇒ 宿主重读 ⇒ **无感替换**
 * ```
 *
 * ⚠️ 第 ③ 步的「无感替换」**不需要本模块做任何事** —— 各适配器早已在目录落地时
 * 调 `onCatalogLoaded` → `broadcastCatalogChanged(ctx)`，那正是宿主的重读信号。
 * 本模块只负责「读盘」与「写盘」两件事。
 *
 * ## ⚠️⚠️ 只在 `complete === true` 时写盘（硬约束）
 *
 * `RemoteCatalogGate` 把 `got`（拿到非空）与 `complete`（**所有来源**拿全）
 * 分开了。写盘必须判后者：
 *
 * - cline 有 **3 个来源**（`recommended-models` + `/api/v1/models` + models.dev）；
 * - 若只拿到 2 个就落盘 ⇒ **残缺目录被固化成「上次的好缓存」**；
 * - 下次启动读到它 ⇒ 那 466 条按量计费模型**永久消失**（只能删缓存文件才能恢复）。
 *
 * 这条与 `RemoteCatalogGate` 的既有语义**完全一致**（它也只按 `complete` 清冷却），
 * 由 `tests/unit/model-catalog-cache.spec.ts` 的「残缺不落盘」一组用例钉住。
 *
 * ## ⚠️ 磁盘格式与原子写
 *
 * 与 `models-dev-cache.ts` 同款（那套已验证过）：
 * - **先写 `.tmp` 再 `rename`**：直接 `writeFile` 时进程中途被杀会留下半截 JSON，
 *   下次冷启动解析失败 ⇒ 缓存彻底失效**且静默**；
 * - `version` 字段：格式演进时旧文件被**丢弃**而不是被当成有效数据；
 * - 解析失败一律 `try/catch` 回退（**缓存坏了不能影响功能**）。
 *
 * ## 为什么不设 TTL 上限
 *
 * 用户的取舍原话：「有缓存就先返回，后台会自动远端拉取，然后自动替换缓存，
 * 所以没必要丢弃缓存，加快展示是目标」。
 *
 * ⇒ 本模块**不判 `at` 是否太旧**：任何能解析出来的缓存都会先返回，
 * 新鲜度由各适配器的 `isCatalogFresh` + 后台刷新负责。最坏情况是用户看到
 * 一天前的模型列表**几百毫秒**，随后被真实目录替换 —— 比空白或等 2 秒好。
 *
 * ⚠️ 但**必须有「不新鲜就触发后台刷新」的判据**，否则会永远停在缓存上。
 * 那由调用方（骨架）用 `isCatalogFresh` 判，本模块只管存取。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { CatalogEntry } from './model-catalog.js'

/**
 * 磁盘缓存格式版本。
 *
 * ⚠️ `CatalogEntry` 的字段变化时**必须** +1：旧文件会被静默当成有效数据继续用，
 * 缺字段的表现是「某个模型突然没有上下文窗口 / 没有图片能力」—— 那种症状
 * 与「上游就没下发」完全同形，极难归因。
 */
const CACHE_VERSION = 1

/**
 * ★★★ **缓存总开关（进程级）** —— 2026-11-20，被测试污染逼出来的必需机制。
 *
 * ## 为什么必须有它（真实事故）
 *
 * 第一版没有开关，`createModelCatalog` 一接上就**真的往**
 * `~/.dsh/cache/model-catalog/` 写盘 —— 于是：
 *
 * - 单测里每个用例的假目录**写进真实缓存**；
 * - 下一个用例启动时**先读到上一个用例的假目录** ⇒ 用例互相串味；
 * - 实测 `buddy-adapter.spec.ts` 一次 **5 条**莫名其妙失败
 *  （`expected 'Hy4 preview' to be 'GLM-5.3 · x0.79'` —— 名字对不上，
 *   因为读到了另一个用例的目录）。
 *
 * ⚠️ 这类失败**极难归因**：单独跑那条用例是绿的，跑整个文件就红。
 *
 * ## 语义
 *
 * 与 `models-dev-cache.ts` 的「注入的 fetcher 不落盘」同款思路：
 * **测试环境默认关闭**，要看真实行为时显式打开。
 *
 * - 由 `tests/setup.ts`（或各 spec 的 `beforeEach`）调 `setCatalogCacheEnabledForTest(false)`；
 * - 生产路径**不调它**，默认 `true`。
 *
 * ## ⚠️ 为什么做成模块级可变标志而不是环境变量
 *
 * 环境变量在**测试进程内**改不了已求值的模块级常量；而本模块的单测需要
 * 「开关打开时测真实读写、关闭时测无副作用」两种形态**在同一进程内**切换。
 */
let cacheEnabled = true

/**
 * 开关磁盘缓存（**只给测试用**，生产路径不要调）。
 *
 * ⚠️ 关闭后 {@link readCatalogCache} 恒返回 `undefined`、{@link writeCatalogCache}
 * 恒返回 `false` —— 即「完全没有缓存」的形态，调用方行为回到加缓存前。
 */
export function setCatalogCacheEnabledForTest(enabled: boolean): void {
  cacheEnabled = enabled
}

/** 当前是否启用（诊断与单测用）。 */
export function isCatalogCacheEnabled(): boolean {
  return cacheEnabled
}

/** 一个 provider 的缓存文件内容。 */
interface CacheFile {
  version: number
  /** 写入时刻（ms）。⚠️ 仅作诊断用：读取时**不判过期**（见模块头）。 */
  at: number
  provider: string
  entries: readonly CatalogEntry[]
  /**
   * 写入时该目录是否「所有来源都拿全」。
   *
   * ⚠️ 落盘时**必须是 `true`**（见模块头的硬约束）。读出来时仍保留该字段，
   * 供将来诊断与「读到残缺缓存要立即清掉」的兜底。
   */
  complete: true
}

/** 缓存目录（`$DSH_HOME/cache/model-catalog`）。 */
export function modelCatalogCacheDir(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'cache', 'model-catalog')
}

/**
 * 某 provider 的缓存文件路径。
 *
 * ⚠️ **provider id 必须过一遍白名单净化**：它来自 `product.id`，正常形态是
 * `[a-z]+`，但缓存路径直接拼字符串 ⇒ 一个含 `../` 的 id 会写到目录外。
 * 这里不抛错（那是调用方的问题），只把非法字符替换成 `_`，保证**路径不逃逸**。
 */
export function modelCatalogCacheFile(provider: string): string {
  const safe = provider.replace(/[^A-Za-z0-9_-]/g, '_')
  return join(modelCatalogCacheDir(), `${safe}.json`)
}

/**
 * **同步**读某 provider 的磁盘目录缓存。
 *
 * 同步是刻意的（与 `models-dev-cache.ts` 的 `loadDiskCacheSync` 同因）：
 * 它跑在 `listModels` 的**渲染路径前置**，异步会让首屏多等一个 microtask 轮次，
 * 而文件只有几十 KB。实测 readFileSync + parse ≈ 1~5ms。
 *
 * @returns 目录条目；**没有缓存 / 解析失败 / 版本不符 / 形状非法**一律 `undefined`
 *（调用方据此走「无缓存」路径，即原来的兜底表 + 立即拉远端）。
 */
export function readCatalogCache(provider: string): readonly CatalogEntry[] | undefined {
  // ⚠️ 开关关闭（测试）⇒ 等同「没有缓存」，**连文件都不碰**。
  if (!cacheEnabled) return undefined
  let raw: string
  try {
    raw = readFileSync(modelCatalogCacheFile(provider), 'utf8')
  } catch {
    // 没有缓存文件是**正常**的（首次运行），不是错误。
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CacheFile>
    if (parsed.version !== CACHE_VERSION) return undefined
    if (parsed.provider !== provider) return undefined
    if (!Array.isArray(parsed.entries)) return undefined
    // ⚠️ 逐条校验**最小形状**：缓存文件可能被手改/截断，一条坏数据不该让
    //    整个目录作废（但也不能放行没有 id 的条目 —— 那会让选择器出现空白项）。
    const entries = parsed.entries.filter(
      (entry): entry is CatalogEntry =>
        typeof entry === 'object' && entry !== null
        && typeof (entry as CatalogEntry).id === 'string'
        && (entry as CatalogEntry).id.length > 0
        && typeof (entry as CatalogEntry).name === 'string',
    )
    // ⚠️ 过滤后为空 ⇒ 当作「没有缓存」：空目录与「没读到」对调用方是同一件事，
    //    但对**写盘**是两件事（见 `writeCatalogCache` 的不变式）。
    return entries.length > 0 ? entries : undefined
  } catch {
    // 半截 JSON / 编码问题：缓存坏了不能影响功能，当作没有。
    return undefined
  }
}

/**
 * 写某 provider 的目录缓存（原子写：`tmp` → `rename`）。
 *
 * ## ⚠️ 两条必须守的不变式
 *
 * 1. **`complete` 必须为 `true`** —— 残缺目录不得落盘（模块头的硬约束）。
 *    本函数把它做成**必填参数**且只接受字面量 `true`，让「传 false」在类型层
 *    就不可能（调用方若确实拿到残缺目录，应当**根本不调用**本函数）。
 * 2. **空目录不写盘** —— 那会把磁盘上已有的好数据覆盖成空文件 ⇒ 下次冷启动
 *    真的什么都没有。这与 `models-dev-cache` 的
 *    「空结果不写盘」是同一条不变式。
 *
 * ## ⚠️ 写盘失败**不抛错**
 *
 * 缓存是**纯优化**：写不进去（磁盘满 / 权限 / 杀毒软件锁文件）只该少一次加速，
 * 绝不能让 `listModels` 因此失败。故整段 `try/catch` 并返回布尔。
 *
 * @returns 是否真的写成功（供诊断与单测；调用方通常忽略）
 */
export function writeCatalogCache(
  provider: string,
  entries: readonly CatalogEntry[],
  complete: true,
  now: number = Date.now(),
): boolean {
  // ⚠️ 空目录不写（见不变式 2）。`complete` 为真的空目录意味着「上游确实没有模型」，
  //    那也不该覆盖磁盘上可能更好的旧缓存 —— 下次启动读旧缓存比读空好。
  if (entries.length === 0) return false
  // ⚠️ 开关关闭（测试）⇒ **一个字都不写盘**，避免污染真实缓存目录（见开关的注释）。
  if (!cacheEnabled) return false
  try {
    mkdirSync(modelCatalogCacheDir(), { recursive: true })
    const path = modelCatalogCacheFile(provider)
    const payload: CacheFile = {
      version: CACHE_VERSION,
      at: now,
      provider,
      entries,
      complete: true,
    }
    // ⚠️ 先写 .tmp 再 rename（见模块头：直接 writeFile 会留下半截 JSON）。
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/** 删掉某 provider 的缓存（诊断 / 单测用；生产路径不需要）。 */
export function clearCatalogCache(provider: string): void {
  try {
    unlinkSync(modelCatalogCacheFile(provider))
  } catch {
    // 不存在 = 已经干净，不是错误。
  }
}

/**
 * 读某 provider 缓存的写入时刻（`0` = 没有缓存）。
 *
 * ⚠️ 只给**诊断与单测**用。生产路径**不判过期**（见模块头），故没有
 * 「超过 X 就丢弃」的判据读它。
 */
export function readCatalogCacheAt(provider: string): number {
  try {
    const parsed = JSON.parse(readFileSync(modelCatalogCacheFile(provider), 'utf8')) as Partial<CacheFile>
    return parsed.version === CACHE_VERSION && typeof parsed.at === 'number' ? parsed.at : 0
  } catch {
    return 0
  }
}