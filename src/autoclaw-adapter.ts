/**
 * AutoClaw LLM 适配器。
 *
 * 把 DSH 的 `LlmAdapter` 调用转发到智谱 AutoClaw 桌面端代理网关。
 * 遵循 OpenAI Chat Completions 协议，并实施必要的 406 绕过前缀校验与动态签名。
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import {
  AUTOCLAW,
  AUTOCLAW_DECLARED_EFFORTS,
  AUTOCLAW_DEFAULT_EFFORT,
  AUTOCLAW_EFFORT_LABELS,
  inputModalitiesOf,
  type AutoclawFallbackModel,
  type AutoclawProduct,
} from './autoclaw-product.js'
import {
  AUTOCLAW_CHAT_PATH,
  AUTOCLAW_MODEL_CONFIG_PATH,
  autoclawHttpErrorCode,
  calculateAutoclawSign,
  cleanBearerToken,
  normalizeAutoclawModel,
  autoclawMaxTokens,
  autoclawEffortForRequest,
  parseAutoclawRemoteModels,
  prepareAutoclawMessages,
  buildAutoclawHeaders,
  type AutoclawCredential,
  type ChatMessage,
} from './autoclaw.js'
import {
  serializeMessages,
  collectImages,
  consumeOpenAiSse,
} from './openai-compat.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import { createModelCatalog, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

export interface AutoclawAdapterOptions {
  /** 凭据获取函数。支持按模型选号。 */
  resolveCredential?: (modelId?: string, sessionId?: string) => Promise<AutoclawCredential | undefined>
  /** 凭据获取函数（旧兼容）。 */
  credentialProvider?: () => Promise<AutoclawCredential | undefined>
  /** 探测凭据函数。 */
  probeCredential?: () => Promise<AutoclawCredential | undefined>
  /** 覆盖默认的 fetch（测试注入）。 */
  fetchImpl?: typeof fetch
  /**
   * 凭据续期回调。
   *
   * ## ⚠️⚠️ 签名为什么带参数（2026-10-27 审计修的 P1）
   *
   * 修前是**零参** `refresh()`，调用方（`index.ts`）只能自己再问池要一个账号
   * （`pool.getAvailableAccount(provider, '')`）。而请求实际用的凭据来自
   * `resolveCredential` → `createCredentialResolver`，本家接了
   * `balance: { kind: 'buddy' }` ⇒ **用哪个号由余额分档决定**，与
   * `getAvailableAccount` 的「手动序第一个」**是两套规则**：
   *
   * | 判据 | 分档（请求用） | `getAvailableAccount`（续期用） |
   * |---|---|---|
   * | 排序 | 按到期档位（`pickBuddyAccount`） | 用户手动序第一个 |
   * | 限流过滤 | 按**真 modelId** | 传 `''` ⇒ **整体短路**（`account-pool.ts` 的 `modelId.length === 0`） |
   *
   * 实测（真跑 `createCredentialResolver` + 复刻池逻辑）：请求用 B 号，
   * 续期却续 A 号 ⇒ **续了 A、重发仍用 B 的旧 token** ⇒ 401 原样复现，
   * 而 A 被白轮换一把 RT。端到端三次请求的结果是 `["AUTH","AUTH","AUTH"]`。
   *
   * ⇒ 现在把**本次实际用的凭据**交给回调，并允许它**直接返回续好的新凭据**：
   *   ① 续的必定是刚才那次请求用的那个号（不再二次选号）；
   *   ② 重发用的就是返回值，**不再** `resolveCredential`（那会重新选号，
   *      即使续对了也可能挑回另一个号）。
   *
   * ⚠️ 返回值保持**可选**（`void | AutoclawCredential`）：既有的零参实现、
   *   `probeById` 里的 `refresh: async () => {}` 都仍然合法 —— 返回 `undefined`
   *   时退回旧行为（重新 `resolveCredential`），不破坏任何调用方。
   */
  refresh?: (used?: AutoclawCredential) => Promise<void | AutoclawCredential>
  /**
   * 账号池（**黑名单、关闭意图、目录门控的唯一数据源**）。
   *
   * ⚠️⚠️ **2026-10-23 迁移**：本家此前手写 `listModels`，黑名单与关闭意图靠
   * `disabledModels` / `providerClosed` 两个**选项回调**传进来。那两个字段
   * 已随迁移删除 —— 现在统一由共享骨架（`model-catalog.ts`）从本池读取。
   *
   * ⚠️ 省略时（单测 / 嵌入方）行为退回「不过滤、不判关闭意图」；
   * **生产接线必须传**（`index.ts` 负责，且 `ikp8of-provider-closed.spec.ts`
   * 会逐家点名）。
   */
  accountPool?: import('./account-pool.js').AccountPool
  /**
   * 读取图片附件字节（**图片通路必需**，2026-10-17 审计 P0 修复）。
   *
   * ⚠️ `zai_auto-fast` 的 `supportsImage: true` 有实测依据
   * （`docs/autoclaw-models.md:42`：AutoClaw 体系内唯一支持图文多模态的通道），
   * 而 `resolveModel` 已据此向宿主声明 `['text','image']` ⇒ 宿主**不投影**
   * 图片、**原样**下发（`dsh-llm/lib/index.js:2311`）⇒ 适配器必须真能收图，
   * 否则用户贴图后必然失败（**声明即承诺**）。
   *
   * ⚠️ **缺省时带图请求抛 `UNSUPPORTED_CONTENT`**（与 modelscope / opencode /
   *   loomy 同约定）：不静默丢图，否则用户以为模型看到了图。
   *   `src/index.ts` 必须注入，否则这条路径恒抛。
   */
  readImage?: (ref: unknown) => Promise<
    { data: Uint8Array; mediaType: string } | undefined
  >
  /** 目录加载完成通知。 */
  onCatalogLoaded?: () => void
  /**
   * 告警出口（2026-10-18 审计 P0 新增，与 `astudio-adapter.ts` 同型）。
   *
   * ⚠️ 存在的理由是**丢弃思考档位必须留痕**：上游对非法档位回 200 并按最贵
   * 那档跑，若静默丢弃，用户付了 `max` 的钱却在 UI 上看到「未思考」——
   * 没有日志就等于把账算到模型头上。
   */
  warn?: (message: string) => void
  /** 产品配置。 */
  product?: AutoclawProduct
}

export class AutoclawAdapter extends LlmAdapter {
  private readonly product: AutoclawProduct
  private readonly warnImpl: (message: string) => void
  /**
   * 共享目录骨架（`model-catalog.ts`）——**黑名单 / 关闭意图 / 目录门控 /
   * 映射**的唯一实现处（2026-10-23 迁移，见 `listModels` 的注释）。
   */
  private readonly skeletonCatalog: ModelCatalog
  private announced = false
  /**
   * 远端模型规格缓存（2026-10-17 审计 P1 修复）。
   *
   * ⚠️ **必须有**：修复前远端只在 `listModels` 里被读一次，而
   *   `resolveModel`（宿主每次请求前都调、也是**能力声明的唯一来源**）
   *   读的是编译期兜底表 ⇒ 远端值算出来就被丢掉。
   * ⚠️ 缓存失效判据用 **`undefined` 表示「已知无远端信息」** 而非「未取过」，
   *   避免远端挂掉时每次请求都重打一次（那会让上游限流）。
   */
  private remoteMeta: ReturnType<typeof parseAutoclawRemoteModels> | undefined
  private remoteMetaFetched = false
  private remoteMetaInFlight: Promise<void> | undefined

  constructor(private readonly options: AutoclawAdapterOptions = {}) {
    super()
    this.product = options.product ?? AUTOCLAW
    this.warnImpl = options.warn ?? ((message: string) => { console.warn(message) })
    // ⚠️⚠️ **`accountPool` 必须是真池**（2026-10-23 迁移）：骨架里
    //    `deps.accountPool?.disabledModelsFor` 与 `providerClosedFor?.(...)`
    //    全靠它；传 `{}` 或 `undefined` 会让 `?.` 变成静默 no-op
    //    （Gitee IKP8OF 实测过的形态：关掉的模型照样可选、关整个供应商也无效）。
    this.skeletonCatalog = createModelCatalog(
      this.options.accountPool === undefined ? {} : { accountPool: this.options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
        // ⚠️ 未知 id **保守报 `['text']`**（与本文件 `resolveModel` 的取向一致：
        //    未知模型的 `inputModalitiesOf(undefined)` 也是 text）。
        unknownModelInputModalities: () => ['text'] as const,
      },
    )
  }

  private async resolveCredential(modelId?: string, sessionId?: string): Promise<AutoclawCredential | undefined> {
    if (this.options.resolveCredential) {
      return this.options.resolveCredential(modelId, sessionId)
    }
    if (this.options.credentialProvider) {
      return this.options.credentialProvider()
    }
    return undefined
  }

  private async probeCredential(): Promise<AutoclawCredential | undefined> {
    if (this.options.probeCredential) {
      return this.options.probeCredential()
    }
    return this.resolveCredential()
  }

  /**
   * 取远端模型规格（**带进程内缓存 + 在飞去重**）。
   *
   * ⚠️ 为什么必须缓存（2026-10-17 审计 P1 修复）：`resolveModel` 是宿主
   *   **每次请求前**都调的（能力声明的唯一来源），若每次都打远端 ⇒ 每轮会话
   *   多一个上游往返，且远端一限流就把全部请求拖慢。
   * ⚠️ 在飞去重是必需的：`resolveModel` 与 `listModels` 会被并发调用
   *   （宿主预热目录时），没有它就会同时打两个请求。
   */
  private async loadRemoteMeta(): Promise<
    ReturnType<typeof parseAutoclawRemoteModels> | undefined
  > {
    if (this.remoteMetaFetched) return this.remoteMeta
    this.remoteMetaInFlight ??= (async () => {
      try {
        const credential = await this.probeCredential()
        // ⚠️ 无凭据时**不**标记为「已取过」：等用户登录后仍要能取到。
        if (!credential) return
        this.remoteMeta = await this.fetchRemoteModelMeta(credential)
      } finally {
        this.remoteMetaFetched = true
        this.remoteMetaInFlight = undefined
      }
    })()
    await this.remoteMetaInFlight
    return this.remoteMeta
  }

  /**
   * 把远端校正值套到兜底表的一条上（**只覆盖远端确实给了的字段**）。
   *
   * ⚠️ 拿不到远端信息时**原样返回兜底条目** —— 绝不编造数值（本仓库红线）。
   */
  private entryOf(model: string): AutoclawFallbackModel | undefined {
    const fallback = this.product.fallbackModels.find((m) => m.id === model)
    if (!fallback) return undefined
    const patch = this.remoteMeta?.get(fallback.id)
    if (!patch) return fallback
    return {
      ...fallback,
      ...(patch.contextWindow !== undefined ? { contextWindow: patch.contextWindow } : {}),
      ...(patch.maxOutputTokens !== undefined ? { maxOutputTokens: patch.maxOutputTokens } : {}),
      ...(patch.supportsImage !== undefined ? { supportsImage: patch.supportsImage } : {}),
    }
  }

  get provider(): string {
    return this.product.id
  }

  async getProviderInfo(id: string): Promise<{ id: string; name: string }> {
    return { id, name: this.product.displayName }
  }

  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[] {
    return this.product.fallbackModels.map((m) => ({
      id: m.id,
      name: m.name,
      isFree: m.isFree === true,
    }))
  }

  /**
   * 模型选择器的目录 —— **委托共享骨架**（`model-catalog.ts`）。
   *
   * ## ⚠️⚠️ 2026-10-23 迁移（用户要求：实体 provider 一律走共享骨架）
   *
   * 迁移前本方法**手写**了四件事：判 `providerClosed`、过滤 `disabledModels`、
   * 凭据探活门控、手工 map 成 `LlmModelInfo`。其中「关闭意图 / 黑名单 /
   * `provider` 回填」与其余 13 家**逐字同义** ⇒ 各写一份正是 Gitee IKP8OF
   * 那类漂移缺陷的温床。
   *
   * 现在那三条由骨架承担，**本家独有的两条**放进 `loadCatalog`
   * （`loadCatalogEntries`）：
   * - **凭据探活门控**（`probeCredential()` 拿不到凭据 ⇒ 隐藏整个分组）；
   * - 探活成功后**真读远端规格**（`loadRemoteMeta()`）+ 广播（`announceLater`）。
   *
   * ⚠️ **门控口径变更（刻意，已与用户确认）**：骨架额外要求「账号池里有已登录
   * 账号」（`providerCatalogVisible`）。对本家而言这比原来的单凭据探活更贴近
   * 用户预期 —— 池里没有账号时那个 provider 本就没有可用号，显示出来只会让
   * 用户选中一个必然失败的模型。
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return await this.skeletonCatalog.listModels(_provider)
  }

  /**
   * 异步读目录并转成骨架的中间结构。
   *
   * ⚠️⚠️ **本家独有门控全在这里**：
   * ① 凭据探活（拿不到 ⇒ `[]` ⇒ 隐藏分组）；
   * ② 探活成功 ⇒ 真读远端规格并广播（原 `listModels` 的主体）。
   */
  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    // ⚠️ 先探活：无凭据 ⇒ 空目录（隐藏整个 provider 分组，**不抛错** ——
    //    抛错会多一条 provider 级报错，UI 表现为「供应商加载失败」）。
    const credential = await this.probeCredential()
    if (!credential) return []

    this.announceLater()

    // ⚠️⚠️ **一次调用即完成「探活 + 真读目录」**（2026-10-17 审计 P1 修复）。
    //   远端挂掉时它内部返回 `undefined` 并回落兜底表（**不抛错**）：
    //   目录是只读展示面，不该因上游抖动整体失败。
    await this.loadRemoteMeta()

    return this.product.fallbackModels.map((m) => this.toCatalogEntry(m))
  }

  /** **同步**全量目录（`listAllModels()` 用；同样读已缓存的远端校正值）。 */
  private syncCatalogEntries(): readonly CatalogEntry[] {
    return this.product.fallbackModels.map((m) => this.toCatalogEntry(m))
  }

  /**
   * 本家私有形状 → 骨架的 `CatalogEntry`（**唯一**转换点）。
   *
   * ⚠️⚠️ **必须复用 `entryOf` + `inputModalitiesOf`，不得硬编码 `['text']`**
   * （2026-10-17 审计 P0 修复）。原写法全模型一刀切 `['text']`，而
   * `resolveModel` 按 `supportsImage` 给 `['text','image']` ⇒ **同一模型在两个
   * 入口对宿主说了两套相反的话**：
   *   • 宿主拿 `resolveModel` 那份做**请求前门禁**（不声明 image 就把图片投影成占位符）
   *   • `listModels` 那份进模型选择器与聚合目录
   * ⇒ 对 `zai_auto-fast`（`supportsImage: true`）用户在选择器看到「支持图片」，
   *   而门禁放行后 `stream()` 必然抛错。
   * ⚠️ 走 `entryOf`（**远端校正后**的条目）⇒ 远端若改模态，两处仍**同向**。
   */
  private toCatalogEntry(m: AutoclawFallbackModel): CatalogEntry {
    const resolved = this.entryOf(m.id) ?? m
    return {
      id: m.id,
      name: m.name,
      inputModalities: inputModalitiesOf(resolved),
      // ⚠️⚠️ **必须显式给 `isFree`（含 `false`），不得只在 true 时写**
      //（2026-10-23 迁移第一版就踩到了：`expected undefined to be false`）。
      // 理由：`listAllModels()` 的契约是把目录条目**原样摊给设置页**，而
      // 徽标那侧按 `isFree === true` 分免费桶。省略 false 会与「从未声明」同形
      // ⇒ `autoclaw.spec.ts` 的「实测每次扣约 1 点 ⇒ 不得标成免费」当场变红。
      isFree: m.isFree === true,
    }
  }

  /**
   * 拉取并解析远端模型规格（**失败/形状不认识一律返回 `undefined`**）。
   *
   * ⚠️ **永不抛错**：目录是只读展示面，远端挂掉不该让它整个失败 ——
   *   回落兜底表即可（与原实现的可用性一致）。
   */
  private async fetchRemoteModelMeta(
    credential: AutoclawCredential,
  ): Promise<ReturnType<typeof parseAutoclawRemoteModels> | undefined> {
    try {
      const f = this.options.fetchImpl ?? fetch
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8_000)
      try {
        const ts = Math.floor(Date.now() / 1000).toString()
        const r = await f(`${this.product.apiBase}${AUTOCLAW_MODEL_CONFIG_PATH}`, {
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Appid': this.product.appId,
            'X-Auth-TimeStamp': ts,
            'X-Auth-Sign': calculateAutoclawSign(this.product.appId, ts, this.product.appKey),
            // ⚠️⚠️ **这里必须是标准 `Authorization`，不能用 `X-Authorization`**
            // （2026-10-17 真机实测：同一个 token 走 `X-Authorization` 一律
            //   `401 {"error":"Invalid token"}`，走 `Authorization` 立刻 200）。
            // ⚠️ **两个端点的认证头是相反的**（实测，别想当然统一）：
            //   • chat/completions（`buildAutoclawHeaders`）只认 `X-Authorization`
            //   • autoclaw-model-config（本处）只认 `Authorization`
            // ⇒ 凭据「看起来失效」的第一个症状就是这里 401，而真实原因是**头名不对**
            //   —— 若照着字面理解为「token 过期」，会导致无谓的重新登录。
            // ⚠️ 桌面端源码也印证：它的托管网关头构造用 `headers.Authorization`
            //   （`createZworkManagedHeaderOptions`），而非 `X-Authorization`。
            Authorization: `Bearer ${cleanBearerToken(credential.access_token)}`,
            'X-Client-Type': 'pc',
          },
          signal: ctrl.signal,
        })
        if (!r.ok) return undefined
        const parsed = parseAutoclawRemoteModels(await r.json())
        // ⚠️ 解析不出任何东西时返回 `undefined`（= 无远端信息），
        //   而不是一个空 Map —— 后者会让调用方误以为「远端确认了 0 个模型」。
        return parsed.size > 0 ? parsed : undefined
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return undefined
    }
  }

  private announceLater(): void {
    if (this.announced) return
    this.announced = true
    setTimeout(() => {
      try {
        this.options.onCatalogLoaded?.()
      } catch {
        // ignore
      }
    }, 0)
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const norm = normalizeAutoclawModel(model)
    // ⚠️⚠️ **必须先取远端校正值再解析**（2026-10-17 审计 P1 修复）。修复前
    //   这里只查编译期兜底表，而远端值只在 `listModels` 里被读一次就丢掉
    //   ⇒ 能力声明（宿主唯一依据）永远来自兜底表，远端规格形同虚设。
    await this.loadRemoteMeta()
    const known = this.entryOf(norm) ?? this.entryOf(model)
    const baseName = known?.name ?? model
    return {
      provider,
      id: model,
      name: baseName,
      inputModalities: inputModalitiesOf(known),
      ...(known === undefined ? {} : {
        context: {
          contextWindow: known.contextWindow,
        },
        // ⚠️⚠️ **单次输出上限必须走顶层 `defaultMaxTokens`，不能塞进 `context`**
        // （2026-10-17 审计 P0 修复）。原写法
        // `context: { contextWindow, maxOutputTokens }` 有两个致命问题：
        //   ① 宿主契约 `LlmModelContext` **只有 `contextWindow` 一个字段**
        //      （`@deepseek-ai/dsh-llm/lib/types/types.d.ts:316-320`）；
        //   ② 宿主的 `normalizeModelInfo` 做的是**白名单重建**
        //      （`lib/index.js:2124`：`context: { contextWindow: context.contextWindow }`）
        //      ⇒ 多写的字段被**主动丢弃**，且**静默无告警**。
        // ⇒ 后果链：`defaultMaxTokens` 为 `undefined` ⇒ 宿主 `lib/index.js:2170`
        //   不做兜底 ⇒ `stream()` 收到的 `options.maxTokens` 通常是 `undefined`
        //   ⇒ `max_tokens` **整个字段不发** ⇒ 退回网关默认值（本仓库
        //   protocol-wire 笔记记载过这类退回 = 长回答被砍成 `finish_reason:length`）。
        // ⚠️ `tsc` 拦不住：写在对象展开里时 excess property check 不生效。
        // ✅ 宿主对该字段有**硬校验**（`lib/index.js:2116`）：非安全正整数直接抛
        // `INVALID_MODEL_MAX_TOKENS` ⇒ 这里按同一口径先过滤，坏值宁可不发。
        ...(known.maxOutputTokens !== undefined
          && Number.isSafeInteger(known.maxOutputTokens)
          && known.maxOutputTokens > 0
          ? { defaultMaxTokens: known.maxOutputTokens }
          : {}),
        // ⚠️ **只在已知模型上声明档位**（跨家契约，见
        //    `tests/unit/model-catalog-parity.spec.ts` 的 `DECLARE_UNKNOWN_REASONING`）：
        //    档位是**该模型**的能力，上游随时可能新增/下线模型，对未知 id 声明
        //    等于凭空捏造。同文件里的 `context` 本来就是条件给的，两处必须同向 ——
        //    否则「未知模型」这一格会在 `context` 上诚实、在 `reasoning` 上撒谎。
        reasoning: {
          // ⚠️ 三档 id 与默认档全部取自 `autoclaw-product.ts` 的**唯一定义处**
          //   （`AUTOCLAW_DECLARED_EFFORTS` / `AUTOCLAW_DEFAULT_EFFORT`），
          //   不在本文件另写一份数组 —— 本仓库记载过「同一文件两份同义数组，
          //   只改一份导致档位轴反向」的真实缺陷。
          // ⚠️ **数组顺序 = 强度序（弱→强）**，不是「默认档排第一」——
          //   宿主把它当展示顺序、官方客户端直接 `map` 不排序
          //   （AGENTS.md：铺成横向档位轴时，「开启」会贴到最左）。
          efforts: AUTOCLAW_DECLARED_EFFORTS.map((id) => ({
            id: ReasoningEffortId(id),
            name: AUTOCLAW_EFFORT_LABELS[id],
          })),
          // ⚠️ 默认档用**具名常量**表达，不得用 `efforts[0]` 反推
          //   （AGENTS.md 记载：顺序一改就会静默翻成最弱档）。
          //   为什么是 `high` 而非 `max`：见 `AUTOCLAW_DECLARED_EFFORTS` 的注释
          //   （`max` 实测单次可达 170~192 秒，日常等待代价过高）。
          defaultEffort: ReasoningEffortId(AUTOCLAW_DEFAULT_EFFORT),
        },
      }),
    }
  }

  /**
   * 解析消息里的图片附件为 data URL（2026-10-17 审计 P0 修复新增）。
   *
   * ⚠️ **按模型判定，不是按 provider 一刀切**（原实现是 provider 级拒绝）：
   *   `zai_auto-fast` 的 `supportsImage: true` 有实测依据
   *   （`docs/autoclaw-models.md:42`），其余三个是纯文本 ⇒ 同一 provider 内
   *   **必须**存在两条通路。判据与 `resolveModel` 同源（`inputModalitiesOf`），
   *   杜绝「声明与实现各说一套」。
   *
   * ⚠️ **模型不支持图片时抛 `UNSUPPORTED_CONTENT`** 而不是静默丢弃 ——
   *   静默丢图会让用户以为模型看到了图（本仓库 Qoder 图片事故的教训）。
   *   ⚠️ 抛**带码**的 `LlmError`（原写法是裸 `Error` ⇒ 宿主归 `'UNKNOWN'`）。
   *
   * ⚠️ 附件字节读不出来时**不写入该条**：`serializeMessages` 遇到缺失会产出
   *   `[image unavailable]` 占位，至少让模型知道「这里本该有张图但没拿到」。
   */
  private async resolveImageUrls(
    model: string,
    messages: readonly { content: unknown }[] | undefined,
  ): Promise<ReadonlyMap<string, string> | undefined> {
    const refs = new Map<string, unknown>()
    for (const message of messages ?? []) {
      if (Array.isArray(message.content)) collectImages(message.content, refs)
    }
    if (refs.size === 0) return undefined

    const entry = this.product.fallbackModels.find((m) => m.id === model)
    // ⚠️ 判据与 `resolveModel`/`listModels` 同源（都走 `inputModalitiesOf`），
    //   这里用 `!== true` 的直判只为避开元组联合的窄化，语义与前者等价：
    //   `inputModalitiesOf` 含 image ⟺ `supportsImage === true`。
    if (entry?.supportsImage !== true) {
      throw new LlmError(
        `autoclaw: 模型 "${model}" 不支持图片输入（能力以兜底表为准）`,
        'UNSUPPORTED_CONTENT',
      )
    }
    if (this.options.readImage === undefined) {
      throw new LlmError('autoclaw: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
    }
    const readImage = this.options.readImage
    const out = new Map<string, string>()
    for (const [id, ref] of refs) {
      const image = await readImage(ref)
      if (image === undefined) continue
      out.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
    }
    return out
  }

  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const model = options.model
    let credential = await this.resolveCredential(model, options.sessionId)
    if (!credential) {
      // ⚠️ **必须带错误码**（2026-10-17 审计 P0 修复）：原写法是裸 `Error`
      // ⇒ 宿主 `harnessErrorCode`（`dsh-llm/lib/adapter-failure.js:105-107`）
      // 对非 `HarnessError` 一律返回 `'UNKNOWN'` ⇒ 不被归类、不触发任何
      // 针对性处置。`MISSING_CREDENTIAL` 是宿主既有的**同名既有码**
      // （见 `src/dead-model-store.ts:52` 的注释枚举），语义精确。
      throw new LlmError(
        '未找到 AutoClaw 凭据：请先在 AutoClaw 桌面端完成登录，或在 Jet Hub 账号管理中添加 AutoClaw 账号',
        'MISSING_CREDENTIAL',
      )
    }

    const f = this.options.fetchImpl ?? fetch
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort)

    // ⚠️ **图片必须真发出去，不能一律拒绝**（2026-10-17 审计 P0 修复）。
    //   原写法是 `if (imageRefs.size > 0) throw ...` 的 provider 级一刀切，
    //   与 `resolveModel` 的逐模型声明**直接对立**：`zai_auto-fast` 已向宿主
    //   承诺 `['text','image']`，宿主据此不投影、图片原样到达这里 ⇒ 必抛。
    const imageUrls = await this.resolveImageUrls(normalizeAutoclawModel(model), options.messages)

    // 序列化消息：带入 options.system（若有）并通过 prepareAutoclawMessages 注入 406 绕过前缀与人设隔离标记
    const rawSerialized = serializeMessages(options.messages, imageUrls)
    if (options.system !== undefined && options.system.trim().length > 0) {
      rawSerialized.unshift({ role: 'system', content: options.system.trim() })
    }
    const wireMessages = prepareAutoclawMessages(rawSerialized as unknown as ChatMessage[])

    const upstreamModel = normalizeAutoclawModel(model)

    // ⚠️ 夹取只在这里算一次（原先的写法在对象展开里调用两次，既难读也可能
    // 在两次求值之间拿到不同结果）。判据见下方 `max_tokens` 那段注释。
    const wireMaxTokens = autoclawMaxTokens(
      options.maxTokens,
      this.product.fallbackModels.find((m) => m.id === upstreamModel)?.maxOutputTokens,
    )

    // ⚠️⚠️ **档位本地校验**（2026-10-18 审计 P0）：上游对非法档位**回 200 并按
    //   最贵那档跑**，静默透传等于让用户为 `max` 付钱却在 UI 上看到「未思考」。
    //   ⇒ 丢弃时**必须留痕**，否则事后无从归因（与 max_tokens 夹取同一纪律）。
    //   ⚠️ 声明集合取 `AUTOCLAW_DECLARED_EFFORTS` —— 与 `resolveModel` 同一份
    //   常量，本家档位是**全渠道统一**的三档，不按模型分。
    const effortDecision = autoclawEffortForRequest(
      options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      AUTOCLAW_DECLARED_EFFORTS,
    )
    if (effortDecision.dropped !== undefined) {
      this.warnImpl(
        `[autoclaw] 丢弃思考档位 ${effortDecision.dropped}：${effortDecision.reason ?? ''}`,
      )
    }

    // 转换 tools 为 OpenAI function calling 标准格式
    const tools = options.tools && options.tools.length > 0
      ? options.tools.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            ...(tool.description && tool.description.length > 0 ? { description: tool.description } : {}),
            ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
          },
        }))
      : undefined

    const bodyObj: Record<string, unknown> = {
      model: upstreamModel,
      messages: wireMessages,
      stream: true,
      // ⚠️⚠️ `max_tokens` **双向夹取 + 强制保底**（2026-10-20 新增）。
      //   下限 10000：**不是**原先的 16384 —— `docs/autoclaw-models.md:53-55`
      //   明写官方约束是「`>= 10000` **或完全不传递**，传 `< 10000`（如 IDE
      //   默认的 4096）回 406」⇒ 抬到 16384 属**编造上游没承诺的数字**
      //   （本仓库红线），用户只想输出 2000 token 时被强行发 16384。
      //   上限：**必须**按本模型已声明的 `maxOutputTokens` 夹住 —— 原实现只做
      //   下限，宿主请求 500000 时会原样发出，而 `zai_auto` 声明仅 393216
      //   ⇒ 超上限且宿主不转可读错误。
      //   ⚠️ 两者都取不到时**不发该字段**（网关默认），绝不编造数值。
      //
      //   ⚠️⚠️ **国际站对 `max_tokens` 的要求与国内站完全一致**（2026-10-20 实测）。
      //     本行曾一度被改成「`wireMaxTokens === undefined` 时强制补 10000」，
      //     依据是「国际站不发该字段会回 406」—— **那条依据是错的**：
      //     当时手动复现同时加了 10 个客户端头，把真正起决定作用的
      //     `X-Version`（缺它 → 500）误判成了 `max_tokens` 的问题。
      //     二分实测（带 `X-Version`、同一 body）：
      //       不发 max_tokens → 200 / =10000 → 200 / =512 → 406
      //     ⇒ 国际站同样接受「不发」，保底既**没必要**、又**违反**
      //       「绝不编造数字」的 P0 红线，已撤销。真修复见 `buildAutoclawHeaders`
      //       的 `X-Version`。
      ...(wireMaxTokens === undefined ? {} : { max_tokens: wireMaxTokens }),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      // ⚠️⚠️ **档位必须先过 `autoclawEffortForRequest` 本地校验**（2026-10-18 审计 P0）。
      //   原实现是裸透传 `String(options.reasoningEffort)`，而上游对**非法档位
      //   不报错**：`turbo` / `ultra` / `off` 实测全部回 HTTP 200 并跑完
      //   （`docs/audit/pr111-autoclaw-audit.md` 的取证表）。⇒ 用户选到集合外的
      //   值时**按最贵那档计费与延迟**，症状是「变慢 / 变贵」而非报错，
      //   事后无从归因 ⇒ 必须在本地拦。
      //   ⚠️ 只发 `reasoning_effort`，**不再双发 `thinking_level`**（2026-10-17 修复）：
      //   桌面端 `AutoClaw2\resources\app\dist\main.cjs` 的托管网关请求体里只出现
      //   `reasoning_effort`；而 `thinking_level` 的 27 处命中全属 SQLite 的
      //   `work_runs.thinking_level` 列与埋点字段，是**本地会话状态**而非协议字段。
      //   ⇒ 保留双发的风险是给上游不认识的字段赋值（最坏被 schema 校验拒整个请求）。
      ...(effortDecision.effort !== undefined ? {
        reasoning_effort: effortDecision.effort,
      } : {}),
      ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
    }
    if (tools !== undefined && tools.length > 0) {
      bodyObj.tools = tools
    }

    const payload = JSON.stringify(bodyObj)

    const headers = buildAutoclawHeaders({
      product: this.product,
      accessToken: credential.access_token,
      modelId: upstreamModel,
      stream: true,
      deviceId: credential.device_id,
    })

    let response: Response
    try {
      response = await f(`${this.product.apiBase}${AUTOCLAW_CHAT_PATH}`, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      })
    } catch (err) {
      options.signal?.removeEventListener('abort', onAbort)
      throw err
    }

    if (!response.ok && (response.status === 401 || response.status === 403) && this.options.refresh) {
      try {
        /**
         * ⚠️⚠️ **把「本次实际用的凭据」交给回调，并优先用它的返回值重发**
         * （2026-10-27 审计修的 P1，详见 `AutoclawAdapterOptions.refresh`）。
         *
         * 修前是 `await this.options.refresh()` 然后**重新** `resolveCredential`：
         * ① 回调内部自己问池要号（与请求用的号是两套规则）；
         * ② 重发前又选一次号（即使续对了也可能挑回另一个号）。
         * 实测三次 401 ⇒ 三次 `AUTH`，被白轮换的是**无关账号**的 RT。
         */
        const renewed = await this.options.refresh(credential)
        // ⚠️ 只有「形状可用」的返回值才采信：空 token 等于没续，
        //    交给下面的 `resolveCredential` 兜底（与旧行为一致）。
        const refreshed = renewed !== undefined && typeof renewed.access_token === 'string'
          && renewed.access_token.length > 0
          ? renewed
          : await this.resolveCredential(model, options.sessionId)
        if (refreshed && refreshed.access_token.length > 0) {
          credential = refreshed
          const retryHeaders = buildAutoclawHeaders({
            product: this.product,
            accessToken: credential.access_token,
            modelId: upstreamModel,
            stream: true,
            deviceId: credential.device_id,
          })
          response = await f(`${this.product.apiBase}${AUTOCLAW_CHAT_PATH}`, {
            method: 'POST',
            headers: retryHeaders,
            body: payload,
            signal: controller.signal,
          })
        }
      } catch (error) {
        /**
         * ⚠️⚠️ **绝不能完全静默**（2026-10-27 第二轮审计打穿）。
         *
         * 修前这里是裸 `catch {}`，注释写着「忽略重试失败，交由下方错误检测」。
         * 而「下方错误检测」只会看见**第一次** response 的 401 并如实报 `AUTH`
         * —— 于是「续期为什么没成功」这条**唯一能指路的信息**彻底消失。
         *
         * 实测的后果链（P0）：`index.ts` 的 refresh 闭包在「反查不到本次使用的账号」
         * 时会**显式抛错**，那个错误被这里吃掉 ⇒ **一次上游都不发、用户看到 401、
         * 日志零字**，比修复前的「静默空转」更难查（修前至少还会试一次
         * `defaultCredentialRef`）。
         *
         * ⇒ 现在留一条 warn。**仍然不外抛**（重试失败不该改变主路径的错误分类：
         * 用户该看到的是第一次那个 401 的语义），但日志里必须能查到**为什么**没重发。
         */
        this.warnImpl(
          `[autoclaw] 401 后的续期/重发失败，本次不重发（将按首次响应报错）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    if (!response.ok) {
      // ⚠️⚠️ **必须先读体、再按语义分类**（2026-10-17 审计 P0 修复）。
      //   原写法是裸 `Error`（无错误码）⇒ 宿主 `harnessErrorCode`
      //   （`dsh-llm/lib/adapter-failure.js:105-107`）对非 `HarnessError`
      //   恒返回 `'UNKNOWN'` ⇒ 429 不换号、额度耗尽不提示充值、
      //   400/406 不归 `INVALID_REQUEST`（AGENTS.md：额度须用**字面量**
      //   `'QUOTA_EXCEEDED'`，harness 常量 `QUOTA_EXCEEDED_CODE` 的字面值
      //   是 `'QUOTA'`，会被客户端把 message 整个丢掉）。
      //   ⚠️ body 只能读一次 ⇒ 读出来**一次性**喂给分类器，不再二次读。
      const errText = await response.text().catch(() => '')
      options.signal?.removeEventListener('abort', onAbort)
      throw new LlmError(
        `autoclaw: 请求失败 [${response.status} ${response.statusText}]: ${errText.slice(0, 300)}`,
        autoclawHttpErrorCode(response.status, errText),
        { status: response.status },
      )
    }

    try {
      yield* consumeOpenAiSse(
        response,
        { ...options.signal === undefined ? {} : { signal: options.signal } },
        {
          label: 'autoclaw',
          firstTokenTimeoutMs: 120_000,
          chunkTimeoutMs: 60_000,
          ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        },
      )
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * 在 `ctx.llm` 上注册 AutoClaw provider 路由与适配器。
 */
export function registerAutoclawLlm(
  ctx: Context,
  options: AutoclawAdapterOptions,
): AutoclawAdapter {
  const product = options.product ?? AUTOCLAW
  const adapter = new AutoclawAdapter({
    ...options,
    onCatalogLoaded: () => broadcastCatalogChanged(ctx),
    // ⚠️ 兜底 `console.warn` 而不是吞掉：丢弃档位属于「用户付了钱但没生效」，
    //   日志是唯一的归因线索（同 `refreshTargets` 的可观测性纪律）。
    warn: options.warn ?? ((message: string) => { ctx.logger.warn(message) }),
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
