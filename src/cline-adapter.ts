/**
 * Cline LLM 适配器。
 *
 * ## 与既有 provider 的差异
 *
 * Cline 的推理端点是**标准 OpenAI 兼容**的
 * （`POST {apiBase}/api/v1/chat/completions`，实测标准 SSE），
 * 故 OpenAI 协议层（消息序列化 / SSE 消费 / 错误归类）**完全复用**
 * `src/openai-compat.ts` —— 与 Qoder 同做法。
 *
 * 差异只有三处：
 *
 * 1. **鉴权头是 `Bearer workos:<jwt>`**（前缀不可剥，见 `src/cline.ts`）；
 * 2. **思考字段是 `delta.reasoning`**（不是 `delta.reasoning_content`）——
 *    已由 `consumeOpenAiSse` 同时兼容；
 * 3. **模型目录来自两个端点**（`recommended-models` 给 free 集合、
 *    `/models` 给全量 id），见 `src/cline-models.ts`。
 *
 * ## 免费标注
 *
 * 免费模型在 `name` 里拼 ` · 免费`。⚠️ **必须写进 `name` 而非 `description`**：
 * composer 的模型切换菜单只渲染 `name`（`dsh-client-ui-model-selection` 的
 * ModelSelect 里只有 `title: model.name` 与 `children: model.name`）。
 * 这是被用户报障纠正过的结论。
 *
 * ⚠️ 免费资格是**服务端动态下发**的（`recommended-models` 的 `free` 数组），
 * 故本适配器**不硬编码任何免费模型名** —— 与 CodeArts benefit 集合同约定。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { createModelCatalog, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import type { CatalogHealth } from './types.js'
import {
  clineExhaustedAdvice,
  clineRateLimitResetAt,
  parseClineRateLimitHint,
  recordsClineRateLimit,
} from './cline-rate-limit.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import { isClineExpired, clineHeaders, type ClineCredential } from './cline.js'
import {
  clineDisplayName,
  hasClineRemoteModels,
  loadClineModels,
  type ClineModel,
  type ClineRemoteModels,
} from './cline-models.js'
import {
  CLINE,
  CLINE_CHAT_PATH,
  CLINE_DEFAULT_REASONING_EFFORT,
  CLINE_REASONING_EFFORTS,
  type ClineProduct,
} from './cline-product.js'
import { projectRequestImage, type ImageRequestTarget } from './image-budget.js'
import { applyModelsDevCatalog, makeClineModelsDevLoader, type ClineModelsDevEntry } from './cline-models-dev.js'
import { parseClineRouting } from './cline-routing.js'
import { recordClineRequest } from './cline-request-log.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'
import { planSessionTitleThinking } from './session-title.js'

/** 本适配器注册的 provider 路由名（等价于 `CLINE.id`）。 */
export const PROVIDER = 'cline'

/** 换号次数上限（对齐 buddy / lobsterai / trae 的 `MaxRotate = 3`）。 */
const CLINE_MAX_ROTATE = 3

/**
 * 单次请求输出上限的安全边界。
 *
 * ⚠️ 与 TRAE 的 `clampTraeMaxTokens` 同因：上游网关对超大 `max_tokens`
 * 会直接 4xx，而 DSH 可能注入一个来自其它 provider 的大值。
 * Cline 内嵌目录里最大的 `maxTokens` 是 **943718**
 * （`muse-spark-1.3-contributor`），故上界取它 —— 不自行编造更大的值。
 */
const CLINE_MAX_OUTPUT_TOKENS = 943_718

/** 收敛输出上限到安全区间；非法值返回 undefined（不编造）。 */
function clampClineMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const integer = Math.floor(value)
  if (integer <= 0) return undefined
  return Math.min(integer, CLINE_MAX_OUTPUT_TOKENS)
}

/**
 * 清洗工具参数 schema 里的 `enum`（递归）。
 *
 * ## 为什么必须清洗（实测 400，用户报障 2026-09-25）
 *
 * harness 下发的工具集里，某些参数的 `enum` 含**空字符串**成员。Gemini 系模型
 * （经 `google` / `vertex` provider）对此**严格校验**，直接拒绝整个请求：
 *
 * ```
 * GenerateContentRequest.tools[0].function_declarations[34]
 *   .parameters.properties[permission].enum[3]: cannot be empty
 * ```
 *
 * ⚠️ 该错误**只在部分 provider 上暴露**：上游一次请求会依次尝试多个 provider，
 * 实测命中 vertex 时报「maxOutputTokens 越界」、命中 google 时报上述 enum 错误。
 * 两者是**两个独立根因**，都要修，否则路由一漂移就复发。
 *
 * ⚠️ 本适配器**从不自己造 enum** —— `stream()` 原样透传
 * `options.tools[].parameters`，故脏数据来自上游 harness。但请求是我们发的，
 * 只能在我们这一侧拦住。
 *
 * ## 三条边界（都要守）
 *
 * - **只删空字符串**（含纯空白），其余成员原样保留 —— `enum` 可能是数字/布尔
 *   数组，按「只留字符串」过滤会把合法的数值枚举整段丢掉；
 * - 过滤后为空则**整个 `enum` 键丢弃**（空 `enum` 同样非法），而非留下 `[]`；
 * - **递归下钻**：`properties` / `items` 等嵌套层里的 `enum` 同罪。
 */
export function sanitizeClineToolParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeClineToolParameters)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'enum' && Array.isArray(raw)) {
      const cleaned = raw.filter((item) => !(typeof item === 'string' && item.trim().length === 0))
      if (cleaned.length > 0) out[key] = cleaned
      continue
    }
    out[key] = sanitizeClineToolParameters(raw)
  }
  return out
}

/**
 * SSE 空闲超时（毫秒）。
 *
 * 分两阶段：等待首 token 的窗口与两次 chunk 之间的最大静默，均可用环境变量
 * 覆盖（便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取**
 * —— 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，
 * adapter 的 generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_CLINE_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_CLINE_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/** `ClineAdapter` 的构造选项。 */
export interface ClineAdapterOptions {
  /** 默认凭据 ref（仅用于类型/日志，实际解析走 `resolveCredential`）。 */
  credentialRef: CredentialRef
  /** 从凭据存储解析凭据。 */
  resolveCredential: (modelId?: string) => Promise<ClineCredential | undefined>
  /** 静默续期凭据。 */
  refresh: () => Promise<void>
  /** 多账号池（用于限流时切换账号与模型黑名单）。 */
  accountPool?: AccountPool
  /**
   * 「本次实际使用的是哪个**账号池账号**」（池 id，如 `cline-bb211a53`）。
   *
   * ⚠️ **请求记录的「账号」列必须用池 id，不能用凭据里的 `account_id`**：
   * 面板拿 `cline.quota` 下发的**池 id** 去过滤记录，两个 id 空间不一致时
   * 过滤恒为空 → 表格**永远空白**（真实缺陷，用户报障「请求记录中数据空白」）。
   *
   * ⚠️ 回调**只用于首次确定起点**（与 `QoderAdapterOptions.currentAccountId` 同因）：
   * 它返回「池当前会给出的那个账号」，适配器内部换号后**不会跟着变**，
   * 故换号后必须用局部变量跟进。
   */
  currentAccountId?: () => string | undefined
  /**
   * 读取图片附件的原始字节（内联为 data URL 用）。
   *
   * 由调用方桥接 `ctx.attachments.readImage(ref)`；未提供时收到图片会报
   * `UNSUPPORTED_CONTENT`（而不是静默丢弃）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /**
   * 读取图片附件的**请求版本**（按像素预算与字节目标缩放后的字节）。
   *
   * ⚠️ 与 {@link readImage} 的错误契约**相反**：不可用时必须返回 `undefined`
   * 而不是抛错。判据与回退都在共享的 `projectRequestImage` 里。
   *
   * 背景（issue !IKITT9）：Cline 撞的是**请求体体积**（实测 24 张原图全过、
   * 32 张 ≈122 MiB 才 `TRANSPORT`），不是腾讯那道图片 token 预算 ——
   * 但解法同样是缩放，且阈值余量最小，所以配一个宽松的字节目标。
   */
  readImageRequest?: (
    attachment: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link CLINE}。 */
  product?: ClineProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 模型目录加载器覆盖（测试用）。
   *
   * 默认走 `loadClineModels`（两次远端请求）。注入后单测可完全离线。
   */
  loadModels?: (options: { credential?: ClineCredential }) => Promise<{
    models: ClineModel[]
    warnings: string[]
    /**
     * 远端原始结果（判「这次到底拿到目录没有」用）。
     *
     * ⚠ 注入式加载器（单测）可以不传：此时退回用 `models.length > 0` 判断，
     * 而默认的 `loadClineModels` **一定**会传（因为 `models` 里永远并着兜底表，
     * 用长度判断是死代码 —— 见 `hasClineRemoteModels` 的注释）。
     */
    remote?: ClineRemoteModels
  }>
  /**
   * models.dev 目录加载器覆盖（测试用）。
   *
   * 默认走 `makeClineModelsDevLoader`（拉 models.dev，带 TTL 缓存）。
   * 它同时补**名字/上下文窗口/图片能力**，见 `src/cline-models-dev.ts`。
   * ⚠️ 注入后单测可完全离线 —— 与 `loadModels` 同款理由。
   */
  loadModelsDev?: () => Promise<Map<string, ClineModelsDevEntry>>
  /**
   * 远端目录**落地后**的通知回调（issue IKJVTF）。
   *
   * 由 `registerClineLlm` 注入为 `broadcastCatalogChanged(ctx)`。适配器本身
   * 拿不到 `ctx`（它只被注册进 `ctx.llm`），故必须由接线层桥接 —— 这与
   * `readImage` 等回调同一模式。
   *
   * ⚠️ 必要性：客户端 `ModelCatalogDirectory` 在 `status === 'ready'` 时**短路
   * 返回缓存**，只在宿主事件上 `refresh()`。没有本回调时，冷启动首拉失败
   * 缓存的**兜底表**会永久留在对话框里，远端目录真的落地也不重读。
   */
  onCatalogLoaded?: () => void
}

/**
 * Cline 模型适配器。
 *
 * 使用 `Bearer workos:<jwt>` 鉴权，仅支持 SSE（与官方客户端一致）。
 */
export class ClineAdapter extends LlmAdapter {
  private readonly product: ClineProduct
  private readonly fetchImpl: typeof fetch
  /** 远端模型目录缓存（首次成功后填充）。 */
  private remoteModels: ClineModel[] | undefined
  /**
   * 已落缓存的目录是否**两个来源都取全**（issue IKJVTF）。
   *
   * ⚠️ **这是短路判据的第二半，绝不能省**：残缺目录**也**要落 `remoteModels`
   * （展示需要 —— 目录服务抖动时用户的模型列表不该整个消失），但那时**不能**
   * 短路，否则永远补不齐。修复前只判 `remoteModels !== undefined`，而残缺目录
   * 同样赋值 ⇒ `RemoteCatalogGate` 的冷却（`retryAt`）**永远读不到**
   * （`cooling()` 在生产里只有闸门自己那一处调用点，而它排在短路之后）
   * ⇒ 那 466 条按量计费模型再也拉不回来，只能重启 DSH。
   *
   * 判据用「已完整」而非「已定义」：残缺时放行到闸门，由冷却控制重试节奏
   * （30 秒一轮，不会打风暴）。
   *
   * ⚠️⚠️ **「完整」必须包含 models.dev**（issue IKKZUG，2026-10-12）。
   *
   * 修复前它只反映**两个 Cline 端点**（`remote.complete`），**不含 models.dev**
   * ⇒ models.dev 超时后 `remoteComplete` 仍是 `true` ⇒ 上面这个短路把闸门
   * 彻底旁路 ⇒ 闸门的冷却永远读不到 ⇒ models.dev 在整个进程生命周期内
   * 只被调 1 次。而 `cline-pass/*` 的模型条目与图片能力**只由 models.dev 提供**
   * ⇒ 它们会「明确不支持图片」到进程结束，**只能重启才能恢复**。
   *
   * 用户实测：桌面端 10-11 23:02 启动 → 10-12 00:30 仍稳定拒图。
   *
   * ⇒ 现在的口径是「**两个端点 + models.dev 都就绪**」。⚠️ 方向是「宁可多试
   * 一次」：多试的代价只是多发一次 models.dev 请求（自带 TTL 与闸门冷却），
   * 而漏判的代价是整个 provider 的图片能力永久失效。
   */
  private remoteComplete = false
  /**
   * 兜底目录的**记忆化**结果（issue IKL3YH）。
   *
   * ⚠️ 不是为了省那点构造开销，而是为了**数组身份稳定**：下面的
   * `entriesCache` / `catalogIndexCache` 都以「来源数组的 `===`」为失效判据，
   * 若 `fallbackCatalog()` 每次返回新数组，离线路径会**每调用一次就重建一份**
   * 缓存（先是白建，接着被下一次覆盖）—— 缓存等于没有，且**症状静默**。
   *
   * 它的取值只来自 `this.product.fallbackModels`（静态产品配置），故记忆化安全。
   */
  private fallbackModelsCache: ClineModel[] | undefined
  /**
   * 已构建好的 `CatalogEntry[]`，按**来源数组身份**失效（issue IKL3YH）。
   *
   * ⚠️⚠️ 这是本次性能缺陷的**主因**修复点。DSH 的 `buildModelCatalog` 形状是
   * 「1 次 `listModels` + **每模型一次** `resolveModelInfo`」，而 `dsh-llm` 的
   * `resolveModelInfo` 会**直连适配器、不做任何缓存**。共享骨架
   * `model-catalog.ts` 的 `resolveModel` 每次都 `await config.loadCatalog()`
   * ⇒ 整份目录被重建 N 次，叠加每个条目的模态查找就是 O(N²)。
   *
   * 实测（本仓产物，N=471 的宿主调用形状）：原实现 **293 ms/次**；
   * 只修模态查找是 121 ms；**再补上本缓存是 1.2 ms**。
   *
   * 失效判据用**身份**而不是长度：`ensureRemoteModels` 每次补齐都赋一个
   * **新数组**（`this.remoteModels = merged`），故「补齐 / 登录后重拉」都能
   * 自然失效；用长度会在「换了模型但条数相同」时读到陈旧目录。
   */
  private entriesCache: { source: readonly ClineModel[]; entries: readonly CatalogEntry[] } | undefined
  /**
   * `模型 id → 条目` 的 O(1) 索引，同样按来源数组身份失效。
   *
   * ⚠️ 只服务 `stream()` 的门禁（`inputModalitiesFor`）。`toCatalogEntry`
   * **不再走它** —— 它手上就有条目本体，直接读字段即可（见 `toCatalogEntry`）。
   */
  private catalogIndexCache:
    | { source: readonly ClineModel[]; index: Map<string, ClineModel> }
    | undefined
    /**
   * models.dev 目录（`模型 id → 条目`，含名字/窗口/图片能力）。
   *
   * ⚠️ `undefined` = **还没读到**（不是「空目录」）：读不到时目录照常工作，
   * 只是少了它补的那几条。这条区分是整个模块的要点 ——
   * 把「没读到」当「不支持」正是「支持图片的模型发不了图」那个缺陷的形态。
   */
  private modelsDev: Map<string, ClineModelsDevEntry> | undefined
  /** 正在进行中的 models.dev 加载（并发去重）。 */
  private modelsDevLoading: Promise<void> | undefined
  /** models.dev 加载器。 */
  private readonly loadModelsDev: () => Promise<Map<string, ClineModelsDevEntry>>

  /**
   * 目录加载闸门：并发去重 + 失败/空结果冷却。
   *
   * 此前这里只有 in-flight 去重（`private loading`），失败后立刻允许重试 ⇒
   * `buildModelCatalog` 的「每模型一次 resolveModel」会把一次失败放大成 N 次。
   * 详见 `src/remote-catalog-gate.ts` 的实测依据。
   */
  private readonly catalogGate: RemoteCatalogGate
  /**
   * ⚠️ **2026-10-08 Task 7d：三个方法收敛到共享骨架** `createModelCatalog`。
   * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架，
   * 现在只剩 `toCatalogEntry`（本家私有形状 + 免费集合 + 统一思考档位）。
   */
  private readonly catalog: ModelCatalog

  constructor(private readonly options: ClineAdapterOptions) {
    super()
    this.product = options.product ?? CLINE
    this.fetchImpl = options.fetchImpl ?? fetch
    this.loadModelsDev = options.loadModelsDev ?? makeClineModelsDevLoader({ fetcher: this.fetchImpl })
    // 目录落地后通知客户端重读（issue IKJVTF 的缺陷①）。回调由接线层桥接
    // （适配器拿不到 ctx），见 `ClineAdapterOptions.onCatalogLoaded`。
    this.catalogGate = new RemoteCatalogGate(
      options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded },
    )
    // ⚠️ 共享骨架（Task 7d）：门控 → 读目录 → 黑名单 → 回填 → 三态。
    this.catalog = createModelCatalog(
      { accountPool: options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
        // ⚠️ **未知 id 省略 `inputModalities`**（issue IKKZUG），与 buddy 同口径。
        // ⚠️ `unknownModelInputModalities` **刻意不提供**（返回 undefined）：
        // 骨架的契约是「不提供 ⇒ 省略该字段」（见 `ModelCatalogConfig` 的说明），
        // 而本家的 `supportsImage` 就是「远端没读到 ⇒ 未知」的高发场景
        // ——`cline-pass/*` 只由 models.dev 提供，报 `['text']` 会让宿主
        // 把图片静默投影成占位文本。
        // ⚠️ 与其余 12 家的 `['text']` **刻意不同**：它们的能力来源要么是
        // 编译期表（恒可用，不存在未知态）、要么已实测过保守方向；cline 有
        // 真实的「外部站点失败」场景。**不要**为了「统一」改回去。
        // ⚠️ 思考档位仍**统一给 5 档**（下方），那是另一条独立决策。
        // ⚠️ **未知模型也声明思考档位**（真实回归防线）：本家档位来自**产品配置**
        // （远端不下发），与具体模型无关 ⇒ 原实现对未知 id 同样给 5 档。
        // 由 cline-adapter.spec.ts 的「未知模型同样有 5 档」用例守着。
        unknownModelReasoning: () => ({
          efforts: CLINE_REASONING_EFFORTS.map((effort) => ({
            id: ReasoningEffortId(effort.id),
            name: effort.name,
          })),
          defaultEffort: ReasoningEffortId(CLINE_DEFAULT_REASONING_EFFORT),
        }),      },
    )
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
   * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 模型接受的输入模态；`undefined` = **能力未知**。
   *
   * ## 两级判据（**顺序不能颠倒**）
   *
   * 判据是**目录条目上的 `supportsImage`**，而它有两个来源（优先级即顺序）：
   * 1. **本地兜底表/内嵌目录**（`product.fallbackModels` 的策展条目）——
   *    从官方客户端内嵌目录提取的，比社区目录权威；显式 `false` 也照样赢。
   * 2. **models.dev**（`src/cline-models-dev.ts` 补进目录）—— 补前者覆盖不到的
   *    模型（`cline-pass/*` 等）。
   *
   * ## ⚠️⚠️ 三态：为什么 `undefined` 是**必需**的第三态（issue IKKZUG）
   *
   * 修复前恒返回两态，而这两态把**语义相反**的两种状态压成了同一个结果：
   * - 目录条目**明确** `supportsImage: false`（**确认不支持**）；
   * - 目录里**压根没有该 id**（**不知道**）。
   *
   * 而 cline 的「不知道」是**真实高频**的：`cline-pass/*` 的条目**只由
   * models.dev 提供**（网关 `recommended-models` 实测只下发 14 条，models.dev
   * 有 18 条），而 models.dev 是一个 5.39 MB 的外部站点、超时 20~60 秒
   * （用户实测直连三次：超时/超时/1.9 秒成功）。
   *
   * 报 `['text']` 的代价有二，第二个更隐蔽：
   * 1. 门禁文案说「模型不支持图片输入」，而真实原因是「目录还没拉到」——
   *    用户会去换模型、查文档，而解法只是**等目录就绪**；
   * 2. `['text']` 报给宿主后，DSH 见到「不含 image」的声明会按
   *    「**确认是纯文本模型**」把图片**静默投影成占位文本**
   *    （dsh-llm 的 `projectImagesForTextModel`）⇒ 图片既没进请求体、
   *    用户也拿不到任何原因。
   *
   * ✅ 宿主契约明写 `absent means unknown`（dsh-llm `types.d.ts` 的
   * `inputModalities`），故「不知道」必须表达为**省略该字段**。
   *
   * ⚠️ 与 `buddy-adapter.ts` 同构，但**判据的来源不同**：buddy 查四个来源
   * （远端 / 产品兜底表 / `IMAGE_MODELS` / 覆盖白名单），cline 只需查**目录
   * 条目这一个字段** —— 因为合并阶段已把两个来源都归一进条目了。
   *
   * ⚠️ **方向仍是保守**：未知**不放行**图片（见 `stream()` 的门禁），
   * 只是不再谎报「不支持」。
   */
  private inputModalitiesFor(model: string): readonly ('text' | 'image')[] | undefined {
    const source = this.remoteModels ?? this.fallbackCatalog()
    const entry = this.catalogIndexFor(source).get(model)
    // ⚠️ 必须判 `=== undefined`（**字段缺席**）而不是 `!== true`：
    // 后者把「明确 false」与「没这条记录」压成同一结果，正是本条要修的形态。
    if (entry?.supportsImage === undefined) return undefined
    return entry.supportsImage ? ['text', 'image'] : ['text']
  }

  /**
   * 目录健康快照（issue IKKZUG 第 5 点：可观测性）。
   *
   * ## 为什么需要
   *
   * 本家的目录来自**三个来源**，其中 `models.dev` 是 5.39 MB 的外部站点、
   * **经常拉不到**（用户实测直连三次：超时 / 超时 / 1.9 秒成功）。而失败时
   * 只有一行 `console.warn`，**宿主不落盘** ⇒ 用户与排障者看到的只是
   * 「贴不了图」，**无从判断**是「这个模型不支持图片」还是「目录还没拉到」。
   *
   * 用户正是靠手工推演才定位到这一层 —— 那不该是排障的常规成本。
   *
   * ## 三条纪律
   *
   * 1. ⚠️ **零 IO**：设置页挂载时对每个供应商都会调它，一旦触发网络请求
   *    就会拖慢首屏（本端点全程只用同步内存副本正是为此）。故只读内存字段。
   * 2. ⚠️ `note` **只在异常时给**：完整时不写该字段 —— 一句「一切正常」
   *    对排障毫无价值，真正需要看的正是异常时（也省掉前端一处渲染分支）。
   * 3. ⚠️ `complete: false` **不等于故障**：插件会按闸门冷却**自动重试**
   *    （见 `remoteComplete`），用户无需做任何事。它只说明「现在看到的
   *    列表与能力可能不全，但会自愈」—— 故文案里必须写明这一点，
   *    否则用户会以为要自己去修。
   */
  describeCatalogHealth(): CatalogHealth {
    const total = (this.remoteModels ?? this.fallbackCatalog()).length
    const modelsDevReady = this.modelsDev !== undefined
    return {
      total,
      complete: this.remoteComplete,
      ...this.remoteComplete ? {} : {
        note: modelsDevReady
          ? 'Cline 模型目录来源未取全（会自动重试）'
          : 'models.dev 未就绪 —— cline-pass/* 的模型与图片能力只由它提供（会自动重试）',
      },
    }
  }

  /**
   * 取（或建）`模型 id → 条目` 的 O(1) 索引，按来源数组身份失效。
   *
   * ⚠️ **原实现在这里做的是 `remoteModels.find(...)`**（issue IKL3YH 的热点）：
   * 每个模型一次全表线性扫描 ⇒ 整表 O(N²)。实测该形态**全仓只有这一处**
   * （其余家是 `remoteMeta.get()` / `fallbackIndex.get()` 或直接吃已解析的条目）。
   *
   * ⚠️ 判据必须是「来源数组身份变了」而**不是**「长度变了」：目录补齐会换上
   * 一个条数可能相同的新数组，只看长度会读到陈旧索引。
   */
  private catalogIndexFor(source: readonly ClineModel[]): Map<string, ClineModel> {
    if (this.catalogIndexCache !== undefined && this.catalogIndexCache.source === source) {
      return this.catalogIndexCache.index
    }
    const index = new Map(source.map((model) => [model.id, model]))
    this.catalogIndexCache = { source, index }
    return index
  }

  /**
   * 懒加载远端模型目录。
   *
   * `resolveModel` 可能先于 `listModels` 被调用（如直接进入会话），
   * 此时同样触发远端拉取。
   *
   * ⚠️ **并发去重**：`listModels` 与 `resolveModel` 会在启动时被 DSH 并发调用，
   * 不去重会打出多份重复的远端请求（两个端点各一次，乘以并发数）。
   */
  private async ensureRemoteModels(): Promise<void> {
    // ⚠️⚠️ **短路判据是「已完整」，不是「已定义」**（issue IKJVTF 的核心修复点）。
    //
    // 残缺目录**也**落 `remoteModels`（展示需要），若这里只判 `!== undefined`
    // 就再也不进闸门 ⇒ 闸门的冷却（`retryAt` / `cooling()`）**永远读不到**
    // ⇒ 残缺目录永久固化，那 466 条按量计费模型只能靠重启 DSH 才能回来。
    // 放行到闸门后，由闸门的 30 秒冷却控制重试节奏（不会打风暴）。
    if (this.remoteComplete) return
    await this.catalogGate.run(async () => {
      try {
        // 目录加载路径**没有**目标模型（它要一次列出全部模型），故不传 modelId：
        // 空串在 `getAvailableAccount` 里是「不按模型过滤」的合法语义，正是这里要的。
        const credential = await this.options.resolveCredential()
        const load = this.options.loadModels ?? ((opts: { credential?: ClineCredential }) =>
          loadClineModels(this.product, {
            ...opts.credential === undefined ? {} : { credential: opts.credential },
            fetcher: this.fetchImpl,
          }))
        const { models, warnings, remote } = await load({
          ...credential === undefined ? {} : { credential },
        })
        // ⚠ **不能**用 `models.length === 0` 判断「没拿到目录」：`mergeClineModels`
        // 会无条件把兜底表并进 `models`（展示需要），实测两个端点全挂时它仍是 5 条
        // ⇒ 旧判据是死代码，冷却永不触发、兜底被永久当成远端结果缓存。
        //
        // ⚠⚠ **`got` 与 `complete` 必须分开**（issue IKJVTF）：Cline 有**两个**
        // 独立来源（`recommended-models` 给 free 集合、`/api/v1/models` 给 466 条
        // 按量计费 id）。实测 `recommended-models` 成功、`/api/v1/models` 失败时：
        // - 只看「任一来源非空」（旧实现）⇒ 残缺目录被当成「已加载」**永久缓存**；
        // - 只看「两个都成功」⇒ 残缺时整个目录都不展示，用户的模型列表凭空消失。
        // ⇒ 残缺**也展示、也广播**（`got`），但**不永久缓存、要留冷却重试**（`complete`）。
        const got = remote !== undefined
          ? hasClineRemoteModels(remote)
          : models.length > 0
        // ⚠️ **完整与否由 `fetchClineRemoteModels` 显式给出**，不能拿
        // `warnings.length === 0` 反推 —— 「主动跳过」（无凭据时的 `/models`）
        // 与「取到了」在 warnings 上不可区分，那正是残缺被判成完整的另一条路径。
        // 注入式加载器（单测）不传 `remote` 时退回 `complete = got`
        //（那种形态下判不出残缺，与 `normalizeLoadResult` 的向后兼容口径一致）。
        //
        // ⚠️ 用 `=== true` 而非直接取值：万一有调用方（旧注入式替身）省了该字段，
        // 保守按**不完整**处理 —— 方向是「宁可多试一次」。
        // 反过来（把缺失当完整）会让残缺目录永久固化，那正是本 issue 的缺陷②。
        //
        // ⚠️⚠️ **完整必须同时包含 models.dev**（issue IKKZUG，2026-10-12）：
        // 它也是目录来源，而 `cline-pass/*` 的模型条目与图片能力**只有它提供**。
        // 漏掉它 ⇒ models.dev 超时后目录被判成「已完整」⇒ 下面的 `remoteComplete`
        // 短路永久生效 ⇒ 整个进程生命周期内不再重试 ⇒ 只能重启才能恢复。
        // 详见 `remoteComplete` 字段的注释与该 issue 的实测（23:02→次日 00:30）。
        const complete = remote === undefined ? got : remote.complete === true
        // ⚠️ **warnings 循环必须在 `if (!got)` 之前**（真实回退，审计发现）：
        // 基线里它排在 `if (!gotRemote) return false` **之前**，而基线那两个端点
        // 全挂时正是靠这两行日志给出现场证据（`[cline] 模型目录来源失败：models
        // fetch failed`，issue IKJVTF 就引用了它）。放到后面会让「全挂」这一
        // **最需要诊断**的场景变成静默。
        for (const warning of warnings) {
          // eslint-disable-next-line no-console
          console.warn(`[cline] 模型目录来源失败：${warning}`)
        }
        if (!got) return { got: false, complete: false }
        let merged = models
        if (models.length > 0) {
          // ⚠️ **models.dev 是目录的第三个来源**（补缺的模型 + 可读名 + 上下文
          // 窗口 + 图片能力），必须在这里合并 —— 合并进目录后，
          // `inputModalitiesFor` 只看目录条目就够了（见其注释）。
          // 它失败不影响目录本身（只记日志）。
          merged = applyModelsDevCatalog(models, await this.ensureModelsDev())
        }
        // ⚠️ 残缺目录也落缓存（否则每次 `listModels` 都重拉两个端点），
        // 但 `remoteComplete` 保持 false ⇒ 下次仍进闸门，由冷却控制重试。
        this.remoteModels = merged
        // ⚠️⚠️ 并上「models.dev 已读到」（issue IKKZUG）。
        // 判据是 `modelsDev !== undefined`（**读到过**，含读到空表），
        // 与「merged 里有没有补进条目」无关 —— 上游确实没有 cline-pass 块时
        // 读到的是空表，那同样属于「已就绪」，不该无限重试。
        this.remoteComplete = complete && this.modelsDev !== undefined
        return { got: true, complete: this.remoteComplete }
      } catch (error) {
        // 拉取失败保持未定义，后续 listModels/resolveModel 仍回退静态兜底表。
        // eslint-disable-next-line no-console
        console.warn(`[cline] 模型目录拉取失败：${error instanceof Error ? error.message : String(error)}`)
        return { got: false, complete: false }
      }
    })
  }

  /**
   * 懒加载 models.dev 目录，并发去重。
   *
   * ⚠️ **失败只记日志、返回空表**：拿不到就相当于「这一层没有补充」，
   * 目录与图片能力都退回本地兜底表；下一次调用会重试（`TtlCache` 不缓存失败）。
   * 它是**补充**信息，不能因为一次抖动就让整个 provider 不可用。
   *
   * @returns 读到的条目；失败返回空 Map（调用方无需区分）。
   */
  private async ensureModelsDev(): Promise<Map<string, ClineModelsDevEntry>> {
    if (this.modelsDev !== undefined) return this.modelsDev
    if (this.modelsDevLoading !== undefined) {
      await this.modelsDevLoading
      return this.modelsDev ?? new Map()
    }
    this.modelsDevLoading = (async () => {
      try {
        this.modelsDev = await this.loadModelsDev()
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[cline] models.dev 目录拉取失败（缺的模型与图片能力退回本地兜底表）：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        this.modelsDevLoading = undefined
      }
    })()
    await this.modelsDevLoading
    return this.modelsDev ?? new Map()
  }

  /** 兜底目录（远端不可用时的静态表，含 5 个免费模型）。 */
  private fallbackCatalog(): ClineModel[] {
    // ⚠️ 记忆化：`entriesCache` / `catalogIndexCache` 都以来源数组的 `===` 为
    // 失效判据，若这里每次返回新数组，离线路径会每调用一次就白建一份缓存
    // （见 `fallbackModelsCache` 的说明）。
    if (this.fallbackModelsCache !== undefined) return this.fallbackModelsCache
    this.fallbackModelsCache = this.product.fallbackModels.map((model) => ({
      id: model.id,
      name: model.name,
      isFree: model.isFree === true,
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.supportsImage === undefined ? {} : { supportsImage: model.supportsImage },
      ...model.description === undefined ? {} : { description: model.description },
    }))
    return this.fallbackModelsCache
  }

  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（免费标记）。
   *
   * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
   * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
   *
   * ⚠️ 本方法是**同步**的（与 RPC 层 `ModelCatalogSource` 契约一致），
   * 故它只能读已缓存的目录。首次调用若缓存为空会触发一次**后台**加载，
   * 由下一次调用（或 DSH 的目录刷新）拿到结果 —— 而 `model.list` 端点
   * 之前一定会先走 `ctx.llm.listModels()`（那会 await 加载完成），
   * 故实际使用中不会读到空目录。
   */
  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[] {
    return this.catalog.listAllModels()
  }

  /**
   * 把本家条目转成共享骨架的中间结构。
   *
   * ⚠️ 本家四处**真实差异**：
   * 1. **`isFree` 必须透出**：Jet Hub 的模型列表要按「计费/来源」分组
   *    （订阅 / 免费 / Cloud / 按量计费），而**免费集合是远端动态下发的**
   *    （见 `cline-models.ts` 的并集规则）—— 让客户端按前缀猜会漂移。
   *    ⚠️ 原声明把 `isFree` 写成**必填**（全仓唯一），而契约
   *    （`jet-hub-rpc.ts` 的 `ModelCatalogSource`）是**可选** ⇒ 此处按契约放宽
   *    （纯类型放宽，运行时行为不变：本家恒有值）。
   * 2. `description` 透传（`cline-models.ts` 的 `models.dev` 补缺）。
   * 3. `maxTokens` 过 `clampClineMaxTokens`（**必须声明**，否则上限永久退回网关默认）。
   * 4. `reasoning` 对**所有**模型统一声明（远端不下发档位，见产品配置注释）——
   *    这是 composer 里「思考强度」选择器的唯一入口。
   *
   * ⚠️⚠️ **`inputModalities` 直接读条目自己的 `supportsImage`**（issue IKL3YH）。
   * 原实现是 `this.inputModalitiesFor(model.id)`，即拿 id 回 `remoteModels` 里
   * **全表线性查找**一次 —— 而这里手上**就是那条条目**，查找纯属多余，且
   * 整表累积成 O(N²)。更糟的是它**掩盖了一个真缺陷**：搜索源只有
   * `remoteModels`，离线 / 首拉失败时它是 `undefined` ⇒ 兜底表里
   * `supportsImage: true` 的策划条目（`stealth/space-bunny-alpha` 等）
   * 被误报成**纯文本**，DSH 于是把图片静默投影成占位符。
   */
  private toCatalogEntry(model: ClineModel): CatalogEntry {
    const maxTokens = clampClineMaxTokens(model.maxTokens)
    return {
      id: model.id,
      // 免费标记拼进 `name`（**不是** `description`）：composer 的模型切换菜单
      // 只渲染 name，description 仅用于 /model 弹窗。
      name: clineDisplayName(model),
      // ⚠️ `resolveModel` 的 `name` **不带**免费标记（与 Qoder/TRAE 一致）：
      // 标记只属于「选择列表」语境；会话记录里带上它会污染历史展示。
      bareName: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      // ⚠️ 直接读字段，**不要**回头查索引（见方法注释：那是 O(N²) + 离线误报）。
      // ⚠️⚠️ 三态（issue IKKZUG）：`supportsImage` **缺席** = 未知 ⇒ 必须
      // **省略** `inputModalities` 字段（宿主契约 `absent means unknown`），
      // 报 `['text']` 会让 DSH 把图片静默投影成占位文本。
      ...(model.supportsImage === undefined
        ? {}
        : { inputModalities: model.supportsImage ? ['text', 'image'] as const : ['text'] as const }),
      ...model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {},
      ...maxTokens !== undefined ? { maxTokens } : {},
      isFree: model.isFree,
      reasoning: {
        efforts: CLINE_REASONING_EFFORTS.map((effort) => ({
          id: ReasoningEffortId(effort.id),
          name: effort.name,
        })),
        defaultEffort: ReasoningEffortId(CLINE_DEFAULT_REASONING_EFFORT),
      },
    }
  }

  /**
   * 把一份来源目录转成 `CatalogEntry[]`，**按来源数组身份缓存**（issue IKL3YH）。
   *
   * ⚠️ 必须缓存：`resolveModel` 会**每个模型**调用一次 `loadCatalog`，
   * 而 DSH 的 `buildModelCatalog` 恰好是「1 次 `listModels` + 每模型一次
   * `resolveModelInfo`」，且 `dsh-llm` 的 `resolveModelInfo` **不做缓存**。
   * 不缓存就是 N² 次条目构造 —— 实测 N=471 时 293 ms/次 对 1.2 ms/次。
   *
   * ⚠️ 失效判据用**身份**（`ensureRemoteModels` 每次落目录都赋新数组）
   * 而不是长度：补齐后的目录条数可能不变，只看长度会读到陈旧条目。
   */
  private catalogEntries(source: readonly ClineModel[]): readonly CatalogEntry[] {
    if (this.entriesCache !== undefined && this.entriesCache.source === source) {
      return this.entriesCache.entries
    }
    const entries = source.map((model) => this.toCatalogEntry(model))
    this.entriesCache = { source, entries }
    return entries
  }

  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    // 必须 await：冷缓存时目录尚未落地就返回，模型选择器会短暂显示错误的
    // 模型集合（Jet Hub 的模型开关也据此渲染）。
    // ⚠️ 目录里**已经**并入 models.dev（补缺的模型 / 可读名 / 图片能力），
    // 故这里不需要再单独 await 一次模态表。
    await this.ensureRemoteModels()
    return this.catalogEntries(this.remoteModels ?? this.fallbackCatalog())
  }

  /**
   * 同步视图（`listAllModels` 用）。
   *
   * ⚠️ 原实现的语义：读已缓存目录，**首次调用若缓存为空会触发一次后台加载**
   * （`void this.ensureRemoteModels()`），由下一次调用拿到结果 ——
   * 而 `model.list` 端点之前一定会先走 `ctx.llm.listModels()`（那会 await 加载完成），
   * 故实际使用中不会读到空目录。此处**逐字保留**该 fire-and-forget。
   */
  private syncCatalogEntries(): readonly CatalogEntry[] {
    const source = this.remoteModels ?? this.fallbackCatalog()
    if (this.remoteModels === undefined) void this.ensureRemoteModels()
    return this.catalogEntries(source)
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(_provider)
  }

  /**
   * 解析模型元信息。
   *
   * ⚠️ 原实现里的四处判据（context / maxTokens / reasoning / modalities）现已
   * 收敛到 `toCatalogEntry`；骨架的 `resolveModel` 只做回填与「不声明未知」。
   */
  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolveModel(provider, model, signal)
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `QoderAdapter` 同款 shim。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片能力按**模型**判定（内嵌目录 capabilities）。
    //
    // 这里**不能**放宽成「总是接受」：DSH 在 LlmRuntime 里按适配器播报的
    // `inputModalities` 决定要不要把图片投影成文本占位符，声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      // ⚠️ 判定能力之前先把**目录**读进来（`resolveModel` 通常已 await 过，
      // 这里命中缓存、不发请求）；`stream()` 也可能被直接调用而没有前置
      // `resolveModel`，缺了这一步会把支持图片的模型误判成纯文本
      // —— 那正是「支持图片的模型发不了图」的形态。
      await this.ensureRemoteModels()
      // ⚠️⚠️ **三态门禁**（issue IKKZUG）：未知**仍然拒绝**，但**不得**说成
      // 「不支持」—— 那会把「目录还没拉到」误导成「这个模型看不了图」，
      // 用户会去换模型、查文档，而解法只是等目录就绪。
      //
      // ⚠️ 错误码用 `INVALID_REQUEST`（**不在** harness 的可重试集合里）：
      // 这类「等一会儿就好」的错误**不该由 harness 自动重试** ——
      // 自动重试会让用户在 15 秒里看到 6 次闪动（500/1000/2000/4000/8000 ms）。
      // ⚠️ **不要**用 `TRANSPORT`：实测它在 `DEFAULT_RETRYABLE_CODES` 里。
      const modalities = this.inputModalitiesFor(options.model)
      if (modalities === undefined) {
        throw new LlmError(
          `cline: 模型 "${options.model}" 的能力列表尚未加载完成，暂时无法判断是否支持图片；请稍后重试。`,
          'INVALID_REQUEST',
        )
      }
      if (!modalities.includes('image')) {
        throw new LlmError(
          `cline: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('cline: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        // ⚠️ 先试**请求版本**（缩放），拿不到才发原图。
        // ⚠️ 先试**请求版本**（缩放），拿不到才发原图。
        const projected = await projectRequestImage(ref, {
          readImageRequest: this.options.readImageRequest,
          pixelBudget: this.product.imagePixelBudget,
          maxBytes: this.product.imageMaxBytes,
        })
        const image = projected ?? await readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 获取凭据（过期则先静默续期）
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isClineExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('cline: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 构造 OpenAI 请求体（复用共享序列化，含 0.1.7 消息形状归一化）
    const messages = serializeMessages(options.messages, imageUrls)
    const bodyObj: Record<string, unknown> = {
      model: options.model,
      messages: options.system !== undefined && options.system.length > 0
        ? [{ role: 'system', content: options.system }, ...messages]
        : messages,
      stream: true,
    }
    if (options.tools !== undefined && options.tools.length > 0) {
      bodyObj.tools = options.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          // ⚠️ parameters 必须清洗后再下发：harness 的工具 schema 里可能带
          // 空串 `enum` 成员，Gemini 系会直接 400（见 sanitizeClineToolParameters）。
          parameters: sanitizeClineToolParameters(tool.parameters),
        },
      }))
    }
    if (options.temperature !== undefined) bodyObj.temperature = options.temperature
    /**
     * 会话自动命名（`purpose: 'session-title'`）的思考与预算决策（issue IKKVDH）。
     *
     * DSH 用 **64 token** 发标题请求且**不传 `reasoningEffort`**，而宿主会把
     * `CLINE_DEFAULT_REASONING_EFFORT` 注入进来。本家档位是**产品级常量**
     * （`CLINE_REASONING_EFFORTS`，与模型无关）且**含 `none`** ⇒ 关得掉。
     */
    const titlePlan = planSessionTitleThinking({
      purpose: options.purpose,
      requestedEffort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      declaredEfforts: CLINE_REASONING_EFFORTS.map((effort) => effort.id),
      maxTokens: options.maxTokens,
    })
    const maxTokens = clampClineMaxTokens(titlePlan.maxTokens)
    if (maxTokens !== undefined) bodyObj.max_tokens = maxTokens
    if (options.stop !== undefined && options.stop.length > 0) bodyObj.stop = options.stop
    // 推理强度：DSH 注入的 `reasoningEffort` 原样透传给上游的 `reasoning_effort`。
    //
    // ⚠️ **这里绝不能加白名单校验**。档位表（`CLINE_REASONING_EFFORTS`）是客户端
    // 内嵌目录的快照，会随 Cline 版本变化；校验等于把上游新增的档位静默丢弃。
    // 且上游对**完全不认识**的档位也只是静默忽略 —— 实测
    // `reasoning_effort: 'banana'` 返回 HTTP 200、思考量为 0，**不报错**，
    // 故白名单既无必要也无收益。
    //
    // ⚠️ 标题请求改走 `titlePlan.effort`（本家恒有 `none` 档，故就是它）。
    if (titlePlan.effort !== undefined) {
      bodyObj.reasoning_effort = titlePlan.effort
    }

    const body = JSON.stringify(bodyObj)

    // 计时起点:**首次发起请求**的时刻(图片读取/凭据解析不算 —— 那是本地开销,
    // 记录的是「这笔请求等了多久」,与参考实现的 startedAt 同口径)。
    const startedAt = Date.now()

    // 3. 发送请求（401/403 时刷新一次凭据后重试）
    //
    // ⚠️ **403 必须先排除「地域限制」**：它与凭据无关，续期在这里永远无用，
    // 且最终会被归成 AUTH（UI 显示「API 密钥无效」），真实原因彻底丢失。
    // 命中时直接抛出带真实原因的错误（见 isClineRegionForbidden）。
    // ⚠️ 用**账号池 id** 起步，**不是**凭据里的 `account_id`（`usr-…`）：
    // 面板用 `cline.quota` 下发的池 id 过滤请求记录，用错 id 空间会让表格
    // **永远空白**（真实缺陷，用户报障「请求记录中数据空白」）。
    // ⚠️ 回调只用于**首次**确定起点，换号后由下面的局部变量跟进（与 Qoder 同因）。
    let currentAccountId = this.options.currentAccountId?.() ?? ''
    let response = await this.send(credential, body, options)
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      const forbiddenText = await response.text().catch(() => '')
      if (isClineRegionForbidden(response.status, forbiddenText)) {
        throw new LlmError(
          `cline: ${errorDetail(forbiddenText)}`,
          'PERMISSION_DENIED',
          { status: response.status },
        )
      }
      await this.options.refresh()
      const refreshed = await this.options.resolveCredential(options.model)
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('cline: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      response = await this.send(credential, body, options)
    }

    // 4. 非 2xx：限流时换号重试，其余如实报错。
    //
    // ⚠️ 与 buddy / lobsterai 一致：只有**限流**才换号。Cline 的账号额度是
    // 账户级余额（`/balance`），余额耗尽属于 `hard-credit` 语义，
    // 也值得换号 —— 两者都用状态码 429 / 402 + 文案判定。
    if (!response.ok) {
      let errorText = await response.text().catch(() => '')
      const shouldRotate = isClineRotatableFailure(response.status, errorText)
      if (this.options.accountPool !== undefined && shouldRotate) {
        const tried = new Set<string>()
        if (currentAccountId.length > 0) tried.add(currentAccountId)
        const maxRotate = CLINE_MAX_ROTATE - 1
        // ⚠️ 不再拼「最后一次失败的原样信息」：它会把上游英文整句复述进最终错误，
        // 而 `clineExhaustedAdvice` 已把语义（限流 / 当日免费额度 / 额度耗尽）用
        // 中文说清 —— 两遍叠加会让消息变成其它 provider 的两三倍长
        // （用户 2026-10-03 报障「这个报告和其它的供应商比起来是不是太长了」）。
        // 上游原文只在**没识别出语义**时由那个函数附上（见 src/cline-rate-limit.ts）。
        /**
         * 记下「刚失败的那个账号被限流到什么时候」。
         *
         * ⚠️ 必须**在每次失败后**都调用（含循环结束后的最后一次）：原来的写法把
         * 标记放在**下一轮的开头**，于是「换号次数用尽而退出」时，**最后一个**
         * 账号永远不会被标记 —— 它下一次又会被 `getAvailableAccount` 选中、
         * 立刻再撞一次同样的墙（本机 cline 只有一个账号，故这条尤其致命）。
         */
        let markedAccountId = ''
        const markLimited = async (): Promise<void> => {
          if (currentAccountId.length === 0) return
          if (currentAccountId === markedAccountId) return
          if (!recordsClineRateLimit(response.status, errorText)) return
          markedAccountId = currentAccountId
          await this.options.accountPool?.updateModelRateLimit(
            currentAccountId,
            options.model,
            clineRateLimitResetAt(response, errorText, options.model),
          )
        }
        for (let round = 0; round < maxRotate; round++) {
          await markLimited()
          const next = await this.options.accountPool.getAvailableAccount<ClineCredential>(
            this.product.id, options.model, tried,
          )
          if (next === null || next === undefined || tried.has(next.entry.id)) break
          tried.add(next.entry.id)
          credential = next.credential
          currentAccountId = next.entry.id
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consumeWithLog(response, options, {
              model: options.model,
              accountId: currentAccountId.length > 0 ? currentAccountId : (credential.account_id ?? ''),
              startedAt,
            })
            return
          }
          errorText = await response.text().catch(() => '')
          if (!isClineRotatableFailure(response.status, errorText)) break
        }
        // 循环退出前最后失败的那个账号（见 markLimited 的注释）。
        await markLimited()
        // 报文里能读到什么语义就说什么话：「当日免费额度」与「短时限流」的动作
        // 完全不同，而两者**都是 429**，只能靠文案区分（见 cline-rate-limit.ts）。
        const hint = parseClineRateLimitHint(errorText)
        const advice = clineExhaustedAdvice(
          response.status,
          hint,
          recordsClineRateLimit(response.status, errorText)
            ? clineRateLimitResetAt(response, errorText, options.model)
            : undefined,
        )
        // ⚠️ 文案要短（用户报障「比其它供应商长」）：前缀只说「哪个模型、账号都用完了」，
        // 其余全部交给 `clineExhaustedAdvice` —— 原始报文不再出现在这里。
        throw new LlmError(
          `cline: 模型 ${options.model} 的所有账号均不可用 —— ${advice}`,
          'QUOTA_EXCEEDED',
        )
      }
      throw new LlmError(
        `cline: ${errorDetail(errorText)}`,
        httpErrorCode(response.status, errorText),
        { status: response.status },
      )
    }

    // 5. 消费 SSE 流(并记录请求流水,见 consumeWithLog)
    yield* this.consumeWithLog(response, options, {
      model: options.model,
      // ⚠️ **池 id 优先**：面板按 `cline.quota` 的池 id 过滤记录，用凭据里的
      // `usr-…` 会让过滤恒空（表格永远空白）。只有**没有池账号**（回退到单凭据
      // ref 的模式）时才退回 `usr-…` —— 那种模式下 `cline.quota` 同样没有账号
      // 可翻页，记录查不到但至少不会张冠李戴。
      accountId: currentAccountId.length > 0 ? currentAccountId : (credential.account_id ?? ''),
      startedAt,
    })
  }

  /**
   * 消费 OpenAI 兼容 SSE 并**记录请求流水**（「订阅额度」面板的请求记录，
   * 见 `src/cline-request-log.ts`）。
   *
   * 记录字段对齐参考实现（`github.com/codeOct/dsh-cline-pass` 的请求记录部分）：
   * 总延迟、**首个内容块耗时（ttft）**、token 用量（含**思考 token** ——
   * 它是解释「为什么等了这么久才出字」的关键数字：这个网关不流式输出思考内容，
   * 思考量只出现在 usage 里）、失败原因。
   *
   * ⚠️ 与参考实现的**差异及理由**：
   * - 不记 `ttfb`（响应体首字节）：本适配器只有单一网关、无 upstream 路由，
   *   响应头到达与首块之间没有独立的「选路」阶段，展示位只剩两个 ——
   *   表格显示「首块 / 总延迟」两个数即可。
   * - 换号过程**不逐笔记**：只记**最终结果**一笔。参考实现会把 AUTH/QUOTA
   *   的每次 attempt 都记成失败行；本适配器的 429 换号风暴（最多 3 轮）
   *   会把 100 条上限刷满，而用户真正要看的是「这笔请求成了没、花了多少」，
   *   「所有账号均不可用」这行已包含换号语义。
   *
   * ⚠️ **失败也必须记**：失败的请求是排查「为什么没回复」的第一线索
   * （429 / 11140 安全策略 / 网络错误各是不同的原因）。记录本身绝不抛错
   * （`recordClineRequest` 已兜底），记账失败不得反噬推理。
   *
   * @param meta - `accountId` 是**最终服务的那笔**账号（换号后即最后一个）。
   */
  private async *consumeWithLog(
    response: Response,
    options: GenerateOptions,
    meta: { model: string; accountId: string; startedAt: number },
  ): AsyncIterable<StreamChunk> {
    /** 首个内容块耗时；0 表示还没有任何块到达。 */
    let ttftMs = 0
    /**
     * 首个**正文**块耗时；0 = 本次没有任何正文（纯思考/纯 usage 的响应）。
     *
     * ⚠️ 与 `ttftMs` 是**两个时刻**：Cline 会流式下发思考增量
     * （`delta.reasoning`），故「第一块」常常是思考块。展示层的「输出速率」
     * 必须让分子分母落在**正文阶段**（`outputTokens − reasoningTokens`
     * ÷ `totalMs − ttfcMs`），否则速率被无限放大 —— 用户报障的
     * `11814.8 t/s` 正是这样来的（见 `src/cline-request-log.ts` 的 `ttfcMs`）。
     */
    let ttfcMs = 0
    /**
     * usage 帧，**在它经过时捕获**：网关把它放在内容之后的最后一帧，
     * 流结束才记账的前提是「这块真的被读到了」—— 若调用方中途 abort、
     * 或上游提前断开，usage 帧可能永远没被消费到。此时**如实标为「未收到」**
     * （`usageReported: false`），由展示层显示 `—` 而不是 `0`
     * —— 0 会被读成「瞬间完成、没花 token」（参考实现同约定）。
     */
    let usage: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      reasoningTokens?: number
    } | undefined
    /**
     * 网关报告的**真实上游渠道**（`alibaba` / `baseten` / `GMICloud` …）。
     *
     * ⚠️ 逐帧观测、**最后一次非空为准**（参考实现注释：路由元数据出现在
     * 「携带它的那一帧」上）。读不到时留空串，展示层回落到模型命名空间
     * —— 「记录成模型前缀」正是用户报障的「上游显示不正确」，见
     * `src/cline-routing.ts`。
     */
    let upstream = ''
    const observeFrame = (frame: Record<string, unknown>): void => {
      const found = parseClineRouting(frame)
      if (found.length > 0) upstream = found
    }
    try {
      for await (const chunk of this.consume(response, options, observeFrame)) {
        if (ttftMs === 0) ttftMs = Date.now() - meta.startedAt
        // 正文块（文本 / 工具调用）才算「正文阶段」的起点：Cline 会先流式下发
        // 思考增量（`delta.reasoning`），把思考块当成正文会让速率的分子分母
        // 落在不同时间段（用户报障 11814.8 t/s 的根因）。
        if (ttfcMs === 0 && (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta')) {
          ttfcMs = Date.now() - meta.startedAt
        }
        if (chunk.type === 'usage' && typeof chunk.usage === 'object' && chunk.usage !== null) {
          usage = {
            inputTokens: Number(chunk.usage.inputTokens ?? 0) || 0,
            outputTokens: Number(chunk.usage.outputTokens ?? 0) || 0,
            // 缓存命中/思考量：有值才带（表格的 ⚡ / 🧠 两项据此出现）。
            ...(typeof chunk.usage.cacheReadTokens === 'number' && chunk.usage.cacheReadTokens > 0
              ? { cacheReadTokens: chunk.usage.cacheReadTokens }
              : {}),
            ...(typeof chunk.usage.reasoningTokens === 'number' && chunk.usage.reasoningTokens > 0
              ? { reasoningTokens: chunk.usage.reasoningTokens }
              : {}),
          }
        }
        yield chunk
      }
    } catch (error) {
      recordClineRequest({
        model: meta.model,
        accountId: meta.accountId,
        usageReported: usage !== undefined,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        // 推理强度：**DSH 注入的原值**（未指定时空串 ⇒ 记录里少一行 tooltip）。
        effort: options.reasoningEffort ?? '',
        upstream,
        ttftMs,
        ttfcMs,
        totalMs: Date.now() - meta.startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    recordClineRequest({
      model: meta.model,
      accountId: meta.accountId,
      usageReported: usage !== undefined,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      // 推理强度：**DSH 注入的原值**（未指定时空串 ⇒ 记录里少一行 tooltip）。
      effort: options.reasoningEffort ?? '',
      upstream,
      ttftMs,
      ttfcMs,
      totalMs: Date.now() - meta.startedAt,
    })
  }

  /** 消费 OpenAI 兼容 SSE（共享实现）。 */
  private consume(
    response: Response,
    options: GenerateOptions,
    onFrame?: (data: Record<string, unknown>) => void,
  ): AsyncIterable<StreamChunk> {
    return consumeOpenAiSse(response, { ...options.signal === undefined ? {} : { signal: options.signal } }, {
      label: 'cline',
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs(),
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      // 旁路观测网关路由元数据（真正服务这笔请求的上游渠道）。
      ...onFrame === undefined ? {} : { onFrame },
    })
  }

  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  private async send(
    credential: ClineCredential,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.product.apiBase}${CLINE_CHAT_PATH}`, {
        method: 'POST',
        // ⚠️ 头里的 Authorization 必须是**带 workos: 前缀**的值
        //（见 src/cline.ts 的 clineBearerValue 注释）。
        headers: {
          ...clineHeaders(credential, this.product),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      if (isTransportError(error)) {
        throw new LlmError(
          `cline: transport error: ${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT',
          { cause: error as Error },
        )
      }
      throw error
    }
  }
}

/**
 * 该失败是否值得**换号重试**。
 *
 * 判据与 buddy 系一致：429（频率限制）与 402（额度耗尽）。
 * 其余错误（400 请求格式错、5xx 服务端故障）换号也无用 ——
 * 5xx 是所有账号共用的服务端问题，400 是请求本身的问题。
 *
 * ⚠️ 限流标记该写多长、以及给用户什么建议，都在 `src/cline-rate-limit.ts`
 * （那里有 Cline 专属的等待时长解析：它把时长写在**英文句子**里，
 * 既没有 `retry-after` 头、也没有绝对时刻）。
 */
export function isClineRotatableFailure(status: number, body: string): boolean {
  if (status === 429 || status === 402) return true
  const lower = body.toLowerCase()
  return CLINE_CREDIT_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * 额度/限流文案标记。
 *
 * 中英双通道：Cline 是国际产品，但用户账号可能是中文界面，
 * 且网关在不同层可能给出不同文案。
 */
export const CLINE_CREDIT_MARKERS: readonly string[] = [
  'insufficient', 'quota', 'rate limit', 'too many requests', 'balance',
  'credit', 'payment required', 'exceeded',
  '积分不足', '额度不足', '余额不足', '频率限制', '超出限制',
]

/**
 * 该失败是否是**与凭据无关的访问限制**（地域封锁 / 模型未开通）。
 *
 * ## 为什么必须单独识别（真实缺陷，用户报障 2026-09-25）
 *
 * Cline 对「该地区不可用」的模型返回 **403**，而 401/403 在本适配器里原本一律
 * 被当作「凭据过期」：触发续期 → 重试 → 仍 403 → 最终 `httpErrorCode(403)`
 * 归成 `AUTH` → DSH 渲染成「**API 密钥无效**」。
 *
 * 实测 `cline-free/muse-spark-1.3-contributor`：
 *
 * ```
 * 403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor
 *       is not available in your region","success":false}
 * ```
 *
 * 后果有两个：① 真实原因（地域限制）被完全掩盖，用户以为要去重新登录；
 * ② 每次请求都白跑一次续期（续期还会成功，所以不会提前报错，纯属浪费）。
 *
 * ⚠️ **不能按状态码一刀切**：同一批 403 里既有真的凭据问题，也有地域限制，
 * 只能靠**响应体文案**区分。认三种表述（上游措辞可能微调，故取特征词）：
 * `not available in your region` / `access forbidden` / `region not supported`。
 *
 * ⚠️ 命中时**跳过续期**，并让错误文案带出真实原因 —— 续期在这里永远无用，
 * 反而拖慢失败反馈。
 */
export function isClineRegionForbidden(status: number, body: string): boolean {
  if (status !== 403) return false
  const lower = body.toLowerCase()
  return CLINE_REGION_FORBIDDEN_MARKERS.some((marker) => lower.includes(marker))
}

/** 地域/访问限制文案标记（小写比对）。 */
const CLINE_REGION_FORBIDDEN_MARKERS: readonly string[] = [
  'not available in your region',
  'access forbidden',
  'region not supported',
  'not available in your country',
]

/**
 * 在 `ctx.llm` 上注册 Cline provider 路由与适配器。
 *
 * 路由名与展示名由产品配置驱动，得到 `cline`。
 *
 * ⚠️ 刻意**不**向 DSH 声明可配置 provider（`registerConfigurableProviders`）——
 * 详见 `llm-register-compat.ts` 模块头。
 */
export function registerClineLlm(ctx: Context, options: ClineAdapterOptions): ClineAdapter {
  const product = options.product ?? CLINE
  const adapter = new ClineAdapter({
    ...options,
    // ⚠️ 注入**唯一**的广播实现（`src/catalog-broadcast.ts`），不要在这里
    // 另写一份 emit —— 两份实现必然漂移（issue IKJVTF 的缺陷① 就是「十处全漏」）。
    onCatalogLoaded: () => broadcastCatalogChanged(ctx),
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  // 返回实例：Jet Hub「显示列表」需要 `listAllModels()`（不受黑名单影响、
  // 带最终展示名）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
  return adapter
}
