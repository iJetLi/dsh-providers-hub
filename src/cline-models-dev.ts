/**
 * Cline 模型的 **models.dev 目录来源**：补「名字 / 上下文窗口 / 图片能力」。
 *
 * ## 为什么需要（两处真实缺陷，用户报障 2026-09-30）
 *
 * ### ① 「支持图片的模型发送不了图片」
 *
 * 适配器判定图片能力时原先**只看本地兜底表**
 * （`product.fallbackModels[].supportsImage`，全表只有 5 条、且全是
 * `cline-free/*`），而远端两个目录端点**都不下发任何能力字段** ——
 * 实测 `recommended-models` 的条目只有 `{ id, name, description, tags }`，
 * `/api/v1/models` 只有裸 `id`。于是 `cline-pass/*` 一律被播报成纯文本：
 * DSH 按播报的 `inputModalities` 决定要不要把图片投影成占位符，
 * 用户**连发都发不出去**。
 *
 * ### ② 「cline-pass 部分模型列表不全」
 *
 * 网关 `recommended-models` 的 `clinePass` 数组**只有 14 条**，而实测
 * models.dev 的 `cline-pass` 块有 **18 条** —— 差的 4 条
 * （`kimi-k2.6` / `glm-5.2` / `kimi-k2.7-code` / `deepseek-v4-flash`）
 * 在本插件里**根本不存在**，用户既看不到也选不到。
 * 另外网关给 `cline-pass/*` 的 `name` **就是 id 本身**
 * （`name === 'cline-pass/mimo-v2.6-flash'`），而 models.dev 给的是
 * 可读名（`DeepSeek V4.1 Flash`）—— 列表里全是裸 id 也让人无从辨认。
 *
 * ## 实测依据（2026-09-30，本机直连 `https://models.dev/api.json`）
 *
 * `cline-pass` provider 块 18 条，逐条带 `modalities.input` 与 `limit`：
 *
 * | 模型 | `modalities.input` |
 * |---|---|
 * | `cline-pass/deepseek-v4.1-flash` | `["text","image"]` ← 用户当时用的就是它 |
 * | `cline-pass/mimo-v2.6-flash` | `["text","image","audio","video"]` |
 * | `cline-pass/minimax-m3` | `["text","image","video"]` |
 * | `cline-pass/glm-5.3` | `["text"]`（确实不带图） |
 *
 * 参考实现（`github.com/codeOct/dsh-cline-pass`）用的**正是同一来源**
 * （其 `MODELS_DEV_URL`）：它把这当作「官方扫描」并在面板里
 * 「adopt newly published models」——注释原文：*"Without it a model newer
 * than this release resolves to the `text` fallback and the harness refuses
 * every image for it, silently."* 与本仓库两处报障同型。
 *
 * ## 四条口径（与参考实现一致，别自作聪明）
 *
 * 1. **只认 `image`**：models.dev 还报 `audio` / `video` / `pdf`，而 DSH 的模态
 *    词表只有 `text` / `image`（参考实现同样**夹取**到这两个值）。
 * 2. **本地兜底表优先级更高**：它是从官方客户端内嵌目录策展出来的，
 *    本模块只补它覆盖不到的模型（见 `applyModelsDevCatalog`）。
 * 3. **不取 `limit.output`（maxTokens）**：那是「单次输出上限」，一旦下发就是
 *    真的写进请求体的 `max_tokens`；本仓库有过「据印象填大值 → vertex/google
 *    400」的真实缺陷（见 AGENTS.md 的 Gemini-400 段），故这里**只补展示名与
 *    上下文窗口**，不碰输出上限。
 * 4. **失败绝不抛到调用方**：拿不到就保持「未知」（退回本地兜底表），
 *    绝不能让一次目录抖动把**所有**模型的图片能力打回原形。
 */

import { readProviderModelsSync, refreshModelsDevAsync, type ModelRecord } from './models-dev-cache.js'
import type { ClineModel } from './cline-models.js'

/**
 * 社区模型目录（公开、无需认证）。与参考实现的 `MODELS_DEV_URL` 同源。
 *
 * ⚠️ **保留字面量只为文档可读性**（用户 2026-10-17）：真正的直连点已收敛到
 * `src/models-dev-cache.ts`，本模块不再发起请求。要改地址**改那一个模块**。
 */
export const CLINE_MODELS_DEV_URL = 'https://models.dev/api.json'

/** 单次目录请求超时（毫秒）。同 `models-dev-cache.ts` 的口径（那里才是真源）。 */
export const CLINE_MODELS_DEV_TIMEOUT_MS = 60_000

/**
 * ⚠️ 20s → 60s（issue IKKZUG，2026-10-12）。
 *
 * 实测（本机 Windows 直连 models.dev 三次）：`20010ms 超时` / `20010ms 超时` /
 * `1908ms 成功`。**成功只用 1.9 秒，失败的都是整段卡死** —— 说明这不是「慢」，
 * 而是「要么很快、要么整段挂住」，20 秒在 5.39 MB 的目标上偏紧。
 *
 * 方向是安全的：本模块**失败只记日志、返回空表**（见 `ensureModelsDev`），
 * 超时放宽只影响「多等一会儿」，不会让任何一次失败变成阻塞 —— 而收益是慢链路
 * 从「必然失败」变成「大概率成功」。
 */

/**
 * 缓存有效期。
 *
 * 用**长 TTL**（而不是像 captcha 配置那样 60 秒）：这份目录是**发布节奏**的
 * 数据（新模型上线才变），进程内按小时级刷新足够；每次会话都去拉一次既慢
 * 又无意义。⚠️ 仍要**有** TTL 而不是永久缓存 —— 上游新增模型后不该要求用户
 * 重启进程（这正是 `TtlCache` 模块头注释里记的那条缺陷）。
 */
export const CLINE_MODELS_DEV_TTL_MS = 6 * 60 * 60 * 1000

/** 从 models.dev 读到的一条模型信息（缺的字段**不编造**）。 */
export interface ClineModelsDevEntry {
  /** 本插件路由上使用的 id（已补 `cline-pass/` 前缀）。 */
  id: string
  /** 可读展示名（如 `DeepSeek V4.1 Flash`）。 */
  name?: string
  /** 上下文窗口（`limit.context`）。 */
  contextWindow?: number
  /** 是否接受图片输入（`modalities.input` 含 `image`）。 */
  supportsImage: boolean
}

/**
 * 带**日期/快照后缀**的模型 id。
 *
 * ⚠️ 只认两种**有日历意义**的形态（2026-11-03 对抗审计：原正则 `-\d{4}` 会把
 * `-4096`/`-1024` 这种上下文长度数字当快照剥掉，从而误继承基底的图片能力）：
 * - 4 位 `MMDD`（`-1017` = 10 月 17 日）；
 * - 8 位 `YYYYMMDD`（`-20241022`）。
 *
 * `-2024`（只有年份）、`-123`（3 位）、`-v2`、`-1017-suffix` 都**不剥** ——
 * 它们更可能是版本号/尺寸而不是快照日期，猜错会把不同模型并成一个。
 */
const SNAPSHOT_SUFFIX = /-(?:(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|(?:19|20)\d{6})$/

/** 剥掉末尾的快照后缀（形如 -1017 / -20241022）；无后缀时原样返回。 */
export function stripClineSnapshotSuffix(id: string): string {
  return id.replace(SNAPSHOT_SUFFIX, '')
}

/**
 * 在 models.dev 目录里查一个模型：**先精确、再剥快照后缀查基底**。
 *
 * ## 为什么必须有
 *
 * 上游常给模型加日期快照后缀（`qwen2.5-coder-7b-instruct-1017`），而
 * models.dev 只登记基底 id。精确匹配失败后：
 * - `contextWindow` / `name` / **`supportsImage`** 全部丢失；
 * - `supportsImage` 变成「未知」，宿主据此**放行图片**，发到不支持图的服务端。
 *
 * 返回的条目沿用基底能力，但 `id` 是请求的那个、`name` 带上后缀（避免两个
 * 不同快照在 UI 上同名）。
 */
export function findClineModelsDevEntry(
  id: string,
  dev: ReadonlyMap<string, ClineModelsDevEntry>,
): ClineModelsDevEntry | undefined {
  const exact = dev.get(id)
  if (exact !== undefined) return exact
  const baseId = stripClineSnapshotSuffix(id)
  if (baseId === id) return undefined
  const base = dev.get(baseId)
  if (base === undefined) return undefined
  const suffix = id.slice(baseId.length + 1)
  return {
    ...base,
    id,
    ...base.name !== undefined ? { name: `${base.name} (${suffix})` } : {},
  }
}

/**
 * 解析 models.dev 目录，得到 `模型 id → 条目`。
 *
 * ⚠️ provider 块的位置有**两种**实测形态（参考实现两者都认）：
 * `json['cline-pass']`（本机实测就是这种）与 `json.providers['cline-pass']`。
 *
 * ⚠️ 模型 id 可能是**裸 id**（`deepseek-v4.1-flash`）也可能已带前缀 ——
 * 前者补 `cline-pass/` 前缀后才是本插件路由上真正使用的 id。
 *
 * @returns 只含**能从目录读出结论**的条目；`modalities` 缺失时
 *   `supportsImage: false`（调用方据「本地兜底表优先」再兜一层）。
 */
export function parseClineModelsDev(value: unknown): Map<string, ClineModelsDevEntry> {
  const out = new Map<string, ClineModelsDevEntry>()
  if (typeof value !== 'object' || value === null) return out
  const root = value as Record<string, unknown>
  const providers = typeof root.providers === 'object' && root.providers !== null
    ? root.providers as Record<string, unknown>
    : undefined
  const block = providers?.['cline-pass'] ?? root['cline-pass']
  if (typeof block !== 'object' || block === null) return out
  const models = (block as Record<string, unknown>).models
  if (typeof models !== 'object' || models === null) return out

  for (const [rawId, rawEntry] of Object.entries(models as Record<string, unknown>)) {
    if (rawId.length === 0) continue
    if (typeof rawEntry !== 'object' || rawEntry === null) continue
    const entry = rawEntry as Record<string, unknown>
    const id = rawId.startsWith('cline-pass/') ? rawId : `cline-pass/${rawId}`
    const name = typeof entry.name === 'string' && entry.name.trim().length > 0
      ? entry.name.trim()
      : undefined
    const limit = typeof entry.limit === 'object' && entry.limit !== null
      ? entry.limit as Record<string, unknown>
      : undefined
    const context = Number(limit?.context)
    const modalities = typeof entry.modalities === 'object' && entry.modalities !== null
      ? entry.modalities as Record<string, unknown>
      : undefined
    const input = modalities?.input
    const supportsImage = Array.isArray(input)
      && input.some((item) => typeof item === 'string' && item.toLowerCase() === 'image')
    out.set(id, {
      id,
      ...name === undefined ? {} : { name },
      ...Number.isFinite(context) && context > 0 ? { contextWindow: Math.trunc(context) } : {},
      supportsImage,
    })
  }
  return out
}

/**
 * 把 models.dev 的条目合并进已有目录。
 *
 * 三条规则（顺序即优先级，**本地兜底表/网关已有的一律不覆盖**）：
 * 1. **补缺**：目录里没有的 id **追加**在该前缀最后一条之后（保持同族相邻，
 *    不会沉到 460 条远端 id 的末尾而无人可见）；
 * 2. **补名字**：`name` 等于 id 本身时（网关就把 id 当名字下发）用可读名替换；
 * 3. **补窗口**：`contextWindow` 缺失时用 models.dev 的值。
 *
 * ⚠️ **不合并 `maxTokens`**（口径 3，见模块头）。
 * ⚠️ **不覆盖**任何已有值：策展/网关数据优先于社区目录。
 */
export function applyModelsDevCatalog(
  models: readonly ClineModel[],
  dev: ReadonlyMap<string, ClineModelsDevEntry>,
): ClineModel[] {
  if (dev.size === 0) return [...models]
  const out: ClineModel[] = []
  const present = new Set(models.map((model) => model.id))
  // 新条目插在「同前缀最后一条」之后，保持 cline-pass/* 相邻。
  const pending = new Map<string, ClineModel[]>()
  const prefixOf = (id: string): string => {
    const slash = id.indexOf('/')
    return slash > 0 ? id.slice(0, slash) : ''
  }
  for (const [id, entry] of dev) {
    if (present.has(id)) continue
    const prefix = prefixOf(id)
    const bucket = pending.get(prefix) ?? []
    bucket.push({
      id,
      name: entry.name ?? id,
      isFree: false,
      ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
      // ⚠️⚠️ **必须原样落 `supportsImage`（含 `false`），不能只写 true**
      // （issue IKKZUG）。原写法是
      //   `...entry.supportsImage ? { supportsImage: true } : {}`
      // ⇒ models.dev **明确说 false**（实测 `cline-pass/glm-5.3` 就是不带图的）
      // 时字段**缺席**，在三态语义下被读成「**未知**」，而它其实是
      // 「**确认不支持**」。两个方向都真实有害：宿主会按「未知」**放行**图片
      // （发到不支持图的服务端），门禁文案也会说「能力尚未加载完成」——
      // 与事实相反。
      //
      // ⚠️ 这条在**两态**下无害（两边都归 `['text']`），是三态改造**暴露**的。
      // ⚠️ `ClineModelsDevEntry.supportsImage` 是**必填** boolean（不是可选），
      // 所以这里不存在「dev 没给」的情形，无需再判 undefined。
      supportsImage: entry.supportsImage,
    })
    pending.set(prefix, bucket)
  }

  // 该前缀在目录里**最后一次**出现的位置 —— 新条目追加其后，既相邻又排在
  // 同族末尾（不能挂在第一条后面：那会让新模型插到同族中间）。
  const lastIndexOfPrefix = new Map<string, number>()
  models.forEach((model, index) => { lastIndexOfPrefix.set(prefixOf(model.id), index) })

  models.forEach((model, index) => {
    // ⚠️ 用 `findClineModelsDevEntry`（先精确、再剥快照后缀）：带 `-1017`
    //    这类日期后缀的模型必须继承基底的能力，否则图片模态/窗口会被误杀。
    const entry = findClineModelsDevEntry(model.id, dev)
    out.push(entry === undefined
      ? model
      : {
          ...model,
          // 网关把 id 当名字下发时（`name === id`）才用可读名替换。
          ...entry.name !== undefined && model.name === model.id ? { name: entry.name } : {},
          ...model.contextWindow === undefined && entry.contextWindow !== undefined
            ? { contextWindow: entry.contextWindow }
            : {},
          // ⚠️ `supportsImage` 只在**本地缺失**时采用 models.dev 的值：本地兜底表
          // 显式 `false` 也照样赢（策展数据优先于社区目录，见模块头口径 2）。
          //
          // ⚠️⚠️ 但**必须原样采用，含 `false`**（issue IKKZUG）：原写法是
          // `&& entry.supportsImage`，于是 dev 说 false 时字段仍**缺席**
          // ⇒ 被读成「未知」。这与上面「补缺」分支是同一个缺陷的两个入口，
          // 只修一个就会从另一个入口漏回去。
          ...model.supportsImage === undefined ? { supportsImage: entry.supportsImage } : {},
        })
    const prefix = prefixOf(model.id)
    if (lastIndexOfPrefix.get(prefix) === index) {
      const extra = pending.get(prefix)
      if (extra !== undefined) {
        out.push(...extra)
        pending.delete(prefix)
      }
    }
  })
  // 没有任何同前缀条目的（理论上不会发生）追加在末尾，宁可多出来也不丢。
  for (const bucket of pending.values()) out.push(...bucket)
  return out
}

/** {@link makeClineModelsDevLoader} 的选项（全部可注入，便于离线单测）。 */
export interface ClineModelsDevLoaderOptions {
  /** 覆盖 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 覆盖 TTL（**已随共享缓存改造失效**，见下方注释）。 */
  ttlMs?: number
  /** 覆盖时钟（测试用）。 */
  now?: () => number
  /**
   * 覆盖刷新重试的退避 sleep（测试用）。
   *
   * ⚠️ 加它是因为共享缓存的重试是**指数退避**（2s → 4s）⇒ 失败路径的用例
   * 会真等 6 秒并撞上 vitest 的 5s 单测超时。注入立即 resolve 的替身后，
   * 用例可以在毫秒级验证「抛了 + 没有缓存被固化」。
   */
  sleep?: (ms: number) => Promise<void>
}

/**
 * 造一个「取 models.dev 目录」的加载器：**读共享本地缓存**，失败**向上抛**。
 *
 * ## ⚠️⚠️ 改前本模块**自己直连** models.dev（用户 2026-10-17）
 *
 * 改前它持有一套完整的直连实现（`TtlCache` + ETag 条件请求 + 独立超时），
 * 而 `opencode-capability.ts` 另有一套 —— **两处各连同一个 5 MB 的外部站点**，
 * 既是本仓库明令禁止的「一文件两套同义判据」，也让「拉 models.dev」这件事
 * 在插件里发生两次。
 *
 * ⇒ 现在直连收敛到 `src/models-dev-cache.ts`（全仓唯一直读点）：本加载器
 * 只做两件事 —— ① **同步**读共享缓存；② 缓存为空时**触发一次刷新并等它**。
 *
 * ## 为什么仍要「等一次刷新」而不是纯同步读（issue IKKZUG 的自愈闸门）
 *
 * `cline-pass/*` 的模型条目与图片能力**只有 models.dev 提供**，而
 * `ClineAdapter.remoteComplete` 用「本次是否读到」来判目录完整性与是否重试。
 * 纯同步读会让「首次运行」永远读到空表 ⇒ 该闸门**永久**认为残缺 ⇒ 每轮都重试，
 * 而重试本身又成了等待网络 —— 正好回到 2026-10-02「模型选择一直卡着」那条事故。
 *
 * ⇒ 折中：**先同步读**（有缓存就立刻返回，不付任何代价），**只在读不到时**
 * 才 await 一次刷新。冷启动命中缓存的用户与完全不受影响。
 *
 * ⚠️ 失败必须抛（而不是返回空表）：调用方据此区分「没读到」与「读到了且
 * 不支持」—— 把失败记成空表会把所有模型的图片能力永久打回纯文本。
 */
export function makeClineModelsDevLoader(
  options: ClineModelsDevLoaderOptions = {},
): () => Promise<Map<string, ClineModelsDevEntry>> {
  return async () => {
    // ① 同步读共享缓存：命中就直接返回，**零 await、零网络**。
    const cached = readProviderModelsSync('cline-pass')
    if (Object.keys(cached).length > 0) return parseClineModelsDev(envelopeOf(cached))
    // ② 没有缓存才触发一次刷新并等它（共享同一个在途槽，不会重复下载）。
    const ok = await refreshModelsDevAsync({
      ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
      // ⚠️ **必须透传退避 sleep**：否则失败路径真等 2s+4s，本模块的失败用例
      //   会直接撞上 vitest 的 5s 超时（实测踩过：5022ms 超时失败）。
      ...options.sleep === undefined ? {} : { sleep: options.sleep },
    })
    const after = readProviderModelsSync('cline-pass')
    if (Object.keys(after).length === 0) {
      // ⚠️ 刷新失败或上游确实没有 `cline-pass` 块：**向上抛**，让调用方的
      //   「未就绪」闸门照旧工作（它靠这个区分残缺与完整，issue IKKZUG）。
      throw new Error(ok ? 'models.dev 未提供 cline-pass 块' : 'models.dev 缓存不可用')
    }
    return parseClineModelsDev(envelopeOf(after))
  }
}

/**
 * 把共享缓存里**已投影**的条目包成 {@link parseClineModelsDev} 认识的信封。
 *
 * ## ⚠️ 为什么绕这一下，而不是给解析器加第二种入参形态
 *
 * 直接写一个「从投影条目解析」的函数，等于让本模块有**两套**字段归一逻辑
 * （`name` / `limit.context` / `modalities.input` 各读一遍）—— 那是本仓库
 * 明令禁止的「一文件两套同义判据」，且必然随字段演进而漂移。
 *
 * ⇒ 合成出与原始响应**同形**的信封，交给唯一那���解析器。
 * 成本是构造一个小对象（18 条量级），换来「字段归一只有一处」。
 */
function envelopeOf(models: Record<string, ModelRecord>): unknown {
  return { 'cline-pass': { models } }
}
