/**
 * 模型目录的**共享骨架**（设计文档 §3.5.4）。
 *
 * ## 它解决什么
 *
 * 14 家的 `listModels` / `resolveModel` / `listAllModels` 三个方法此前各自实现，
 * 但骨架**逐字同构**（实测：`loomy` / `minimax` / `raccoon` 三家归一化后逐字相同）：
 *
 * ```
 * listModels(provider)
 *   ├─ ① providerCatalogVisible(accountPool, product.id)?
 *   │      └─ 否 → 返回 []，**绝不抛错**
 *   ├─ ② 读目录（远端缓存 ?? 兜底表）
 *   ├─ ③ 黑名单过滤（disabledModelsFor）
 *   └─ ④ map → { provider: product.id, id, name, inputModalities }
 *
 * resolveModel(provider, model)      ← ⚠️ provider/id 必须按入参回填
 *   ├─ ① 按 id 找 entry（**找不到不抛错**）
 *   ├─ ② name：entry.bareName → entry.name → **裸 model**（三级回退，绝不空）
 *   │      ⚠️ **`bareName` 优先**，与设计文档 §3.5.4.3 写的「entry.name →
 *   │         entry.bareName」**相反** —— 以实现为准，理由见 `resolveModel` 内注释。
 *   │         （本节原先把顺序写反了，2026-10-08 复审修正。）
 *   ├─ ③ context：未知就不声明
 *   ├─ ④ maxTokens：可选
 *   └─ ⑤ reasoning：efforts 非空才声明；defaultEffort 必须落在 efforts 内
 * ```
 *
 * 各家仍在自己模块内做一次 `toCatalogEntry()` —— 把「私有形状」转成本文件的
 * `CatalogEntry`。此后共享骨架**不再关心原始形状**。
 *
 * ## ⚠️ 边界（别把这里做成「一套配置驱动 14 家」）
 *
 * 抽象的是**骨架**（顺序、回填、三态、过滤），**不是协议**：
 * - 倍率是否拼进 `name`、怎么剥掉 —— 各家在 `toCatalogEntry` 里决定；
 * - `inputModalities` 的**两种来源**（静态表按 id 查 / 远端对象读字段）——
 *   在 `toCatalogEntry` 里收敛成**一个字段**；
 * - 兜底表长什么样 —— 各家私有（`loadCatalog` 内部自己选）。
 */

import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'

import { providerCatalogVisible, type AccountPool } from './account-pool.js'

/**
 * `listModels` 实际返回的模型信息：宿主契约 + **附加的 `contextWindow`**。
 *
 * ⚠️ 宿主 `LlmModelInfo` 没有该字段（窗口只在 `resolveModel` 的 `context` 里）。
 * ⚠️⚠️ **不能只靠它给网关供数**：宿主 `LlmRuntime.listModels()` 会按白名单
 * 重建对象（只留 provider/id/name/description/inputModalities），这个附加字段
 * 到网关时已经被剥掉。网关的 `/v1/models` 实际走 `resolveModelInfo().context`
 * （见 `openai-gateway/models.ts` 的 `collectGatewayModelDetails`）。
 * 此处保留是给**直接消费适配器 `listModels`** 的调用方与将来宿主扩展契约用。
 */
export interface CatalogModelInfo extends LlmModelInfo {
  readonly contextWindow?: number
}

/**
 * 各家的**中间结构** —— 只承载「DSH 契约需要什么」，不承载私有信息。
 *
 * ⚠️ 缺省语义全部是「**省略即不声明**」（而不是给一个默认值）：
 * DSH 侧对「未知」与「明确否定」的处理**不同**（见 `inputModalities`）。
 */
export interface CatalogEntry {
  readonly id: string
  /**
   * **目录展示名**（`listModels()` 用）。
   *
   * ⚠️ 倍率是否拼进来由**各家在转换时**决定（buddy / loomy / raccoon 拼，
   * codearts 不拼）—— 真实差异，保留在各家的 `toCatalogEntry` 里。
   */
  readonly name: string
  /**
   * **`resolveModel` 用的裸名**（不带倍率）。
   *
   * ⚠️ **提供它即表示「`resolveModel` 用这个、不用 `name`」**（它优先于 `name`）。
   * 省略时 `resolveModel` 回退到 `name`。
   *
   * ⚠️ 必须与 `name` 分成两个字段：`raccoon-adapter.ts` 与 `loomy-adapter.ts`
   * 都做「剥掉 ` · x{n}` 后缀」，而 `listModels` 用带倍率的、`resolveModel` 用裸的。
   * 若只留一个 `name`，剥离逻辑就得回到共享骨架里 —— 那会让骨架**认识倍率格式**，
   * 而各家格式不同（loomy 用 `splitLoomyRate`，raccoon 用正则）。
   */
  readonly bareName?: string
  /**
   * 可选描述（DSH 的 `LlmModelInfo.description`）。
   *
   * ⚠️ **设计文档的 `CatalogEntry` 漏了这个字段**（2026-10-08 预检发现）：
   * `cline-adapter.ts` 与 `lobsterai-adapter.ts` 都会下发它，漏掉就是**静默丢字段**。
   * ⚠️ 但**免费标记不要写这里** —— `cline-adapter.ts` 有铁律：
   * 「免费模型在 `name` 里拼 ` · 免费`。**必须写进 `name` 而非 `description`**」。
   */
  readonly description?: string
  /**
   * 输入模态。**三态**（DSH 的类型注释原文：`absent means unknown, while an
   * explicit omission is negative capability`）：
   * - 数组 = 已知能力；
   * - **省略 = 未知**（交给宿主判断）；
   * - `['text']` = **明确声明不支持图片**（图片会被拒）。
   *
   * ⚠️ **两者后果不同，不能合并**：把「未知」写成 `['text']` 会**静默把图片能力
   * 关掉** —— 功能看似正常，只是图片发不出去（`buddy` 实测会拿不到远端能力表）。
   */
  readonly inputModalities?: readonly ('text' | 'image')[]
  /** 上下文窗口；`undefined` ⇒ **不声明**（不编造假窗口）。 */
  readonly contextWindow?: number
  /** 单次输出上限；`undefined` ⇒ 不声明。 */
  readonly maxTokens?: number
  /** 思考档位；`undefined` ⇒ 不声明（UI 不出现档位选择器）。 */
  readonly reasoning?: LlmResolvedModelInfo['reasoning']
  /** 是否免费（供 Jet Hub 模型列表分组）。 */
  readonly isFree?: boolean
}

export interface ModelCatalogDeps {
  readonly accountPool?: AccountPool
}

export interface ModelCatalogConfig {
  readonly product: { readonly id: string }
  /**
   * **目录里没有该 id** 时 `resolveModel` 该报什么模态。
   *
   * ⚠️⚠️ **本字段是「三态」里最容易做错的一处**（Task 7b 实测踩到）。
   * 各家对「未知模型 id」的处理**不同**，且**不能统一**：
   *
   * | 家 | 未知 id ⇒ | 理由 |
   * |---|---|---|
   * | `buddy`（含 `workbuddy`） | **省略该字段**（不提供本回调） | 它的 `inputModalitiesFor` 用 `imageCapabilityKnown` 区分「明确 false」与「全都没查到」，后者**只报未知**（交给宿主判断） |
   * | 其余 **12 家** | `['text']` | **保守报 text**：宁可少报能力（用户改用文本描述），也不要报一个服务端可能不认的模态 |
   *
   * ⚠️ **家数实测为 12（2026-10-08 二次复核修正）** —— 本节先后写错过**两次**：
   * 原写「**5 家**」（`loomy/minimax/raccoon/gemini/qoder`，本字段刚引入时的快照），
   * 再改「**10 家**」（那数是**源码处数**，不是家数），现按**家数**修正为 12。
   *
   * ⚠️ **两个口径必须分清**（这正是上一次改错的原因）：
   *
   *     源码处数 = 10 —— `unknownModelInputModalities` 这个键在 `src/` 里出现 10 次
   *                 （`qoder-adapter.ts` 一处同时服务 `qoder` 与 `qodercn`）
   *     家数     = 12 —— 14 个 `channel` provider 里，减去 `buddy`/`workbuddy`
   *                 （二者共用适配器、都省略该键）
   *
   * ⚠️ 14 家里 `opencode` **不走本骨架**（门控/黑名单/模态/context 有协议级差异），
   * 但它**同样**对未知 id 保守报 `['text']`，故它在「12 家」里。
   * 复核方式：剥注释后数**代码里**有没有这个键，别把注释本身或目录转换算进来。
   * ⚠️ 该名单有**逐 provider 的行为守卫**（`model-catalog-parity.spec.ts` 的
   * `OMIT_UNKNOWN_MODALITIES`，跑真实适配器）—— 名单再腐坏会点名到具体哪一家。
   *
   * ⚠️ 若把这 12 家统一成「省略」，用户手填的未知模型会从「明确不支持图片」
   * 变成「未知」⇒ **图片会被放行**、发到不支持的服务端（请求失败）。
   * 反之若把 `buddy` 统一成 `['text']`，会**静默关掉图片能力**（见
   * `CatalogEntry.inputModalities` 的说明）。
   * ⇒ **两个方向都会出真缺陷，故本回调必须逐家提供**，骨架不替各家决定。
   *
   * ⚠️⚠️ **必须传 `modelId`**（2026-10-21 接 codearts 图片时踩到）：`codearts` 的
   * VL 模型（`kimi-k2.6-vl` / `Qwen3-VL-235B`）**刻意不进对话目录**（上下文小、
   * 不支持工具调用），但它们**能收图**、且识图工具要按 id 借它们 ⇒ 它们走的正是
   * 本回调这条「目录外」路径。不传 id 就只能在「恒 `['text']`」与「全都给 image」
   * 之间二选一：前者让 VL 模型永远声明不了 image（DSH 在入库阶段拒图，真缺陷），
   * 后者让文本模型也能被发图（上游 406，每轮都失败）。
   * ⇒ 传 id 后实现方才能**按 id 判能力**，两个方向都正确。
   */
  unknownModelInputModalities?(modelId: string): readonly ('text' | 'image')[] | undefined
  /**
   * **目录里没有该 id** 时 `resolveModel` 该报什么思考档位。
   *
   * ⚠️ 与 `unknownModelInputModalities` **同一个形态**：各家处理不同，且不能统一。
   *
   * | 家 | 未知 id ⇒ | 理由 |
   * |---|---|---|
   * | `cline` | **仍声明 5 档** | 档位来自**产品配置**（远端不下发），与具体模型无关 ⇒ 对未知模型同样给 |
   * | `codearts` | **仍声明 2 档**（关闭/开启，**强度序**） | 本网关唯一生效的思考控制是顶层 `thinking.type`，与模型无关 |
   * | 其余 | 不声明 | 档位来自**该模型的**远端配置，未知模型无从得知 |
   *
   * ⚠️ **不提供本回调 ⇒ 未知模型不声明 reasoning**（这是多数家的正确行为：
   * 档位是「该模型的能力」，未知模型不该臆造）。
   * ⚠️ 反之若把 cline/codearts 也改成「不声明」，用户在**手填模型 id** 时会
   * 失去思考档位选择器（它们的档位本就与模型无关）。
   */
  unknownModelReasoning?(): LlmResolvedModelInfo['reasoning']
  /**
   * **目录里没有该 id** 时 `resolveModel` 该报什么上下文窗口。
   *
   * ⚠️ 与上面两个回调**同一个形态**：各家处理不同，且**不能统一**。
   *
   * | 家 | 未知 id ⇒ | 理由 |
   * |---|---|---|
   * | `codearts` | **仍给具名兜底**（`CODEARTS_FALLBACK_CONTEXT_WINDOW`） | 本家目录的窗口**全部来自本地静态表**（上游端点不下发），且缺窗口会让用户的上下文占用条**整条消失**、自动压缩阈值失去唯一输入 |
   * | 其余 | 不提供 ⇒ 未知模型**不声明** context | 多数家的窗口来自**远端该模型的**配置，未知 id 无从得知 ⇒ 编一个就是假窗口 |
   *
   * ⚠️ **不提供本回调 ⇒ 沿用旧行为**（`entry` 缺失时不落 `context`），
   * 这是刻意的：本字段是为 codearts 那个真实报障加的，**不得**顺手把其余
   * 12 家也改成「未知 id 给兜底」—— 那会给它们造出**假窗口**（分母错 ⇒ 占用比
   * 与压缩阈值一起错，且比"不显示"更难发现）。
   *
   * ⚠️ 与 `CatalogEntry.contextWindow` 的关系：**后者管目录内条目，本回调管
   * 目录外 id**，两条路径必须都覆盖，否则「选择器里能选到的」与「手填的」
   * 会分叉（codearts 的报障正是从「目录内条目漏了」来的）。
   *
   * ⚠️⚠️ **必须传 `modelId`**（2026-10-21 全量测试实测踩到）：本回调最初没有入参，
   * 于是「目录里没有该 id」时只能给一个**与模型无关**的常数 ⇒ 真实缺陷：
   * `glm-5.3` 在静态窗口表里是 1M，却**不在静态兜底目录**（`DEFAULT_MODELS`）里
   * ⇒ 离线/首次启动时它算「目录外 id」⇒ 拿到常数兜底 524_288 ⇒ **占用比分母错
   * 2 倍**（而用户报障的正是这个模型）。传 `modelId` 后实现方才能做
   * 「**表内优先、查不到才兜底**」，与目录内路径**同口径**。
   */
  unknownModelContextWindow?(modelId: string): number | undefined
  /**
   * 异步读原始目录并**转换**成 `CatalogEntry[]`。
   *
   * ⚠️ 读取与转换**合一**而不是拆成两个回调：拆开会让「读的是远端、
   * 转换用的是兜底」这类错配成为可能。
   *
   * ⚠️ 它内部已把「远端缓存 / 兜底表 / 静态表」的选择做完（各家自己知道
   * 该用哪个），共享骨架只看到**一份已合并的 `CatalogEntry[]`**。
   */
  loadCatalog(): readonly CatalogEntry[] | Promise<readonly CatalogEntry[]>
  /**
   * **同步**全量目录（`listAllModels()` 用）。
   *
   * ## ⚠️⚠️ 为什么必须有这个回调（而不是复用 `loadCatalog`）
   *
   * `listAllModels()` 被契约要求是**同步**方法：
   * - `jet-hub-rpc` 的 `ModelCatalogSource` 要求同步，且消费者**不 await**
   *   ⇒ 改成 async 会抛 `all is not iterable`（`dead-model-store.ts` 有记录）；
   * - `provider.status` 会在**冷缓存**下直接调它并据条数算 `models.total`，
   *   判据是 `closed = total > 0 && disabled === total`。
   *
   * ⚠️ **真实缺陷史**（`aggregate-adapter.ts`）：冷缓存时 `total` 只有 1（`auto`）
   * ⇒ 用户一关掉 `auto`，`aggregate` 就被**误显示为「已关闭」**（掉进设置页的
   * 「已关闭」分组）。⇒ 本回调**不得在未加载时返回空数组**，而应返回各家的
   * **兜底表**（语义即 `this.remoteModels ?? 兜底表`）。
   *
   * ⚠️ **不要在这里写「几家」**：本节原写「这正是 **3 家**现有实现……」——
   * 那数是 `3229e3c`（迁移首批 3 家）时的快照；改造完成后该形态已扩散到**多数家**
   * （含 `buddy` / `cline` / `trae` / `zcode` 等），而注释一直没跟着更新。
   * 这类「家数」是**必然腐坏**的快照 —— 本文件另一处名单已因此写错过**两次**
   * （5 → 10 → 12），故此处**刻意不写数字**。
   * ⇒ 该契约的真正守卫是**逐 provider 的行为用例**
   * （`model-catalog-parity.spec.ts` 的 (j)：冷缓存下 `listAllModels()` 非空，
   * 用**全新适配器**跑，漏一家会点名），不是注释里的数字。
   *
   * ⚠️ 复核本条时实测踩到「测量工具骗人」：只扫 `syncCatalog` **直接**调用的
   * 那个函数体会漏掉**委托层**（`trae` 的 `syncCatalogEntries()` 体只是
   * `return this.catalogEntries()`，兜底在下一层），据此得出的家数比真值少 1。
   * 测「谁具备某语义」必须**顺着委托递归**，不能只看一层。
   *
   * ⇒ 本回调是**必需**的，不是可选优化。（设计文档说「`loadCatalog` 是唯一必须
   * 实现的回调」，那一条在同步契约下不成立 —— 本文件是更正后的口径。）
   */
  syncCatalog(): readonly CatalogEntry[]
  /**
   * ★ **强制重拉远端目录**（可选；供后台 20 分钟刷新器与「用户改设置」调用）。
   *
   * ⚠️ **与 `loadCatalog` 的差别**：`loadCatalog` 是「取一份目录」，各家的实现
   * 内部**自带新鲜度判据**（`isCatalogFresh`）⇒ 新鲜时它**不拉远端**。
   * 而本回调的语义是「**无视新鲜度，强制拉一次**」。
   *
   * ⚠️ 省略 ⇒ 该 provider 不参与后台刷新（`opencode` 这类本地派生渠道本来就零网络）。
   */
  refresh?(): void | Promise<void>
}

/**
 * 模型目录的定期刷新周期（毫秒）—— **20 分钟**。
 *
 * ## 为什么是 20 分钟（用户 2026-10-18 的要求）
 *
 * 「各个模型的模型列表缓存也要带定时更新，20 分钟更新一次，如果不更新随高峰低谷
 * 变化的积分消耗倍率是更新不到实际的倍率」
 *
 * ⚠️ **不按 provider 差异化**：本仓库铁律是「同一语义不得两套判据」，而各家倍率
 * 的变化频率无法从协议层可靠判定（实测记录多为「结构上可达、零实测」）。
 * ⇒ 统一一个周期，是唯一不会在将来漂移的写法。
 */
export const CATALOG_REFRESH_INTERVAL_MS = 1_200_000

/**
 * 这一份目录读数是否还够新。
 *
 * ## ⚠️⚠️ 本函数是「目录够不够新」的**唯一**实现
 *
 * 9 个适配器（loomy / minimax / zcode / raccoon / trae / lobsterai / accio /
 * codearts 系 / buddy）各自的 `remoteModels` 都要判这个，**各写一份就是
 * 「同一语义两套判据」** —— 本仓库红线（`docs/agent-notes/misc.md` 记着
 * 「一条文件两套同义判据」曾被当成 PR 修复项）。
 *
 * ## 判据形状
 *
 * `at === 0 || undefined` ⇒ **恒不新鲜**。这是刻意的：那表示「从未成功读过」，
 * 而各家的兜底表是**编译期快照且是子集**（`docs/agent-notes/client-ui.md`：
 * cline 实测 3/460）⇒ 必须真去拉一次，不能拿兜底表冒充新鲜读数。
 *
 * @param at - 上次**成功**读到的时刻（毫秒）
 * @param now - 当前时刻
 * @param ttlMs - 允许陈旧的时长；缺省 {@link CATALOG_REFRESH_INTERVAL_MS}
 */
export function isCatalogFresh(
  at: number | undefined,
  now: number,
  ttlMs: number = CATALOG_REFRESH_INTERVAL_MS,
  invalidatedAt?: number,
): boolean {
  if (at === undefined || at === 0) return false
  // ⚠️⚠️ **正交输入：被用户主动失效**（Task 9，见 {@link invalidateCatalogCache}）。
  //
  // 判据是「这份读数**不晚于**失效时刻」⇒ 它是在用户改设置**之前**读到的 ⇒ 陈旧。
  //
  // ⚠️ **默认 `undefined` ⇒ 本函数逐字等价于加入本参数之前的行为** ——
  //    这是刻意的：本函数是各家共用的**唯一**判据（仓库红线），
  //    「多久算新鲜」这一半**一个字都没动**（下面的 `age < ttlMs` 原样保留），
  //    新加的只是「用户刚要求过失效」这个**与 TTL 无关的**正交输入。
  //    不传它的调用点（含全部既有单测、以及各适配器 gate **之后**的复查）
  //    行为逐字不变 —— 由 `catalog-invalidation.spec.ts` 的
  //    「既有语义逐字不变」一组用例钉住。
  //
  // ⚠️ 边界用 `<=`：失效与上次读取落在**同一毫秒**时宁可多拉一次上游，
  //    也不要让「用户点完开关、目录纹丝不动」成为可能（那正是本 Task 要修的
  //    症状）。代价是「一次成功重拉恰好也落在同一毫秒」时会**再**多拉一次 ——
  //    生产里 Web 请求的往返必然 ≥ 1ms，故这个代价实际观测不到；
  //    单测用冻结时钟时它会表现为「多一次」，由 `catalog-invalidation.spec.ts`
  //    的「失效会自愈」那一条显式钉住（推进 1ms 后即不再重拉）。
  if (invalidatedAt !== undefined && invalidatedAt > 0 && at <= invalidatedAt) return false
  // ⚠️ 边界用 `<`：与 `TtlCache.peek()` 的 `now - atMs >= ttlMs` 判陈旧**同口径**
  //    （`src/ttl-cache.ts`），两处不一致会让「缓存多久算新鲜」在运行时才确定。
  const age = now - at
  // ⚠️ `age < 0`（时钟回拨）判**新鲜**：否则一次 NTP 校时会让全部目录同时判陈旧，
  //    下一轮把 9 个上游一起打一遍。
  //    （此处不写 `age >= 0 &&`：那一条会与上面这句注释、与 `isCatalogFresh` 的
  //     时钟回拨用例**互相矛盾** —— `at` 在未来时 age 为负，必须放行。）
  return age < ttlMs
}

/**
 * provider → 「用户主动要求目录立即失效」的时刻（毫秒）。
 *
 * ## ⚠️⚠️ 为什么是「一张按 provider 分键的表」而不是「把各家的 `catalogAt` 置 0」
 *
 * 需求（规格 §6）是「用户在 Jet Hub 改完开关 ⇒ 该渠道的目录**立即**失效，
 * 不要等满 20 分钟的 TTL」，且**只**作用于被改的那一个 provider。
 *
 * 三种落点方案，核实后**只取第三种**：
 *
 * | 方案 | 为什么不取 |
 * |---|---|
 * | 各适配器**构造时**登记 `provider → 闭包`（brief 的 Step 3） | 「**最后构造者赢**」：`src/index.ts` 的 `probeById` 每次「重测 / 测试」都会 `new` 一个**临时**适配器（`createProbeAdapter`），它构造时会把生产实例的登记**挤掉** ⇒ 此后 `invalidateCatalogCache` 作用在一个用完即弃的实例上，生产实例**完全不受影响**。症状是「点过一次重测之后，改开关就再也不生效了」，且**零日志、无法自愈**（只能重启插件）。`qoder`/`qodercn` 与 `buddy`/`workbuddy` 共用类、`codearts` 走 `LlmAdapter` 基类，登记表还要靠各自的 `options.product.id` 自己报 —— 而 `probeById` 里那些临时实例同样会报同一个 id，冲突不可避免 |
 * | 直接把各家的 `catalogAt = 0` | 那个字段在**两家**上另兼第三个用途：`aggregate-adapter` 的 `catalogReadyForBulkWrite` 判 `catalogAt === 0` 为「从未成功推导过（冷帧）」，`officeace-adapter` 判它为「冷启动无旧读数可留」⇒ 置 0 会让「改完聚合面板的开关后马上点『关闭聚合供应商』」被误拒、并让 officeace 的目录分组在刷新失败时**整个消失** |
 * | **本表（provider → 失效时刻）** | ✅ 不碰任何适配器的字段语义；按 provider 分键天然满足「不连带作废其余几家」；未登记的 provider 静默 |
 *
 * ## ⚠️ **两个时刻必须来自同一个时钟**
 *
 * 判据是「`catalogAt <= invalidatedAt`」，而 `catalogAt` 由**各适配器自己的**
 * 时钟写入（生产 = `Date.now()`；单测常注入假时钟）。⇒ 失效时刻**必须**取自
 * 同一个时钟，否则比较毫无意义。
 * 生产路径（`src/jet-hub-rpc.ts`）两家都用 `Date.now()` ⇒ 默认值即正确；
 * 单测若要覆盖「失效」这一腿，必须把假时钟的值显式传进来（见
 * `catalog-invalidation.spec.ts`）。
 *
 * ## ⚠️ 失效标记**不需要清理**（自愈）
 *
 * 适配器一旦成功读到新目录就会把 `catalogAt` 写成**此刻**（晚于失效时刻）
 * ⇒ 下一次判据自然回到 TTL 那一半。表里最多留 `providers` 个数字，无泄漏面。
 * ⚠️ 拉取**失败**时 `catalogAt` 不推进 ⇒ 标记继续生效、下一次再试
 * —— 这正是我们要的（「用户改了设置」这件事在成功读到新目录之前一直成立）。
 *
 * ⚠️ **时钟回拨**会让旧标记重新生效（`at` 变小）⇒ 多拉一次上游。那与
 * `isCatalogFresh` 对回拨的既有取舍同族：宁可多打一次，也不要让目录冻住。
 */
const catalogInvalidations = new Map<string, number>()

/**
 * 把某 provider 的目录读数置为**陈旧**（下一次读取会重新拉取远端）。
 *
 * ## ⚠️⚠️⚠️ 接线规则（本函数所有调用点的**唯一**判据）
 *
 * > **凡是写入「目录或门控相关表」的端点，成功之后都要
 * > `invalidateCatalogCache(req.provider)`**
 * > （聚合那几处写 `AGGREGATE_PROVIDER` —— 只失效聚合**自己**）。
 *
 * 「目录或门控相关表」= 模型黑名单 `disabledModels`、模型失效表（dead models）、
 * 聚合拒绝表、聚合白名单、聚合手工顺序表、聚合排序模式 `orderMode`。
 * 成对条件：① 端点真的写了其中之一；② 调用点在**写盘成功之后**（校验 `return`、
 * 写入抛错、目录核实不过而拒绝 ⇒ 一个字都没改，失效只是白打一次上游）。
 *
 * ⚠️⚠️ **`provider.setEnabled` 曾被漏掉过一次**（2026-10-19 复审发现的真实漏网）：
 *   它是 Jet Hub 里**最显眼**的供应商级开关（左栏每行尾），写的正是**同一张模型
 *   黑名单**（`clearDisabledModels` / `setModelsDisabled`），症状与单条
 *   `model.setDisabled` 逐字相同 —— 却一度没接线。
 *   ⇒ **按「已核实到的行号清单」接线必然漏**（清单是抽样，不是全集）；
 *     必须按上面那条规则逐个端点自查。规则原文另见 `src/jet-hub-rpc.ts` 的
 *   `invalidateCatalogCache` import 上方。
 *
 * ## 调用点（`src/jet-hub-rpc.ts` 的**十一处**写入端点，2026-10-19 由 7 补齐到 11）
 *
 * | # | 端点 | 失效的 provider | 为什么必接线（写的那张表） |
 * |---|---|---|---|
 * | 1 | `model.setDisabled` | `req.provider` | 模型黑名单 |
 * | 2 | `model.clearDead` | `req.provider` | 模型失效表（dead models） |
 * | 3 | `model.setAllDisabled` | `req.provider` | 模型黑名单 |
 * | 4 | `model.setDisabledMany` | `req.provider` | 模型黑名单（按分组批量） |
 * | 5 | `aggregate.setRejected` | `aggregate` | 聚合拒绝表 |
 * | 6 | `aggregate.setAllowed` | `aggregate` | 聚合白名单 |
 * | 7 | `aggregate.setOrder` | `aggregate` | 聚合手工顺序表 |
 * | 8 | **`provider.setEnabled`** | `req.provider` | 模型黑名单（供应商级一次写全；**曾漏**） |
 * | 9 | **`aggregate.clearRejected`** | `aggregate` | 聚合拒绝表（批量清空；兄弟端点 5 已接线） |
 * | 10 | **`aggregate.setOrderMode`** | `aggregate` | `orderMode`（`routingFingerprint()` 的四项输入之一） |
 * | 11 | **`aggregate.rejectNonExpiring`** | `aggregate` | 聚合白名单（批量清；与 6 同表） |
 *
 * ⚠️ 4 是 brief 那 6 处之外的**同类**写入端点（同一张黑名单，只是按分组批量）；
 *   8~11 是 2026-10-19 复审按上面那条**规则**补齐的 —— 原实现只按已核实到的行号
 *   接线，规则同样指向这 4 处却没接，属**选择性应用判据**。
 * ⚠️ 8~11 都排在**写盘成功之后**：8 排在 `setAccountsEnabled` 之后（关闭方向的
 *   `remoteError` / `notReady` / `ids.length === 0` 三条拒绝分支一个字都没改；
 *   那段 `fullCatalogIds` 远端核实（Task 7 为「只关 auto 却返回成功」的 IKJW33
 *   形态加的守卫）**不**因失效调用而改变行为 —— 失效只置陈旧、**不删条目**）。
 * ⚠️ 5~11 **只**失效 `aggregate` 自己的目录缓存；**不得**顺手失效全部渠道
 *   （那会让「改一个开关」连带作废其余几家的目录 ⇒ 下次打开面板打十几个上游）。
 *
 * ## ⚠️⚠️ **这几处失效并不是为了让聚合目录重算**（2026-10-19 复审核实的订正）
 *
 * 复审逐行核实了推导链并**证伪**了初版注释里的因果陈述。真实链路是：
 * `refreshCatalog` 的 `catalogs[provider] = await ctx.llm.listModels(provider)`
 * ⇒ `buildVirtualModels(catalogs)`（`aggregate-catalog.ts`），而
 * `buildVirtualModels` **只读各渠道目录的 `id` / `name` 与归一映射** ——
 * **完全不读拒绝表、白名单、顺序表、排序模式**。
 *
 * ⇒ 5~11 这几处失效的**真实**目的：**语义对齐 / 兜底** —— 保持上面那条规则
 *   不破例（万一将来 `buildVirtualModels` 真的依赖了它们，这里**已经**是对的），
 *   而**不是**为了让当前实现下的聚合目录重算（改这三张表，推导结果逐字节相同）。
 * ⇒ 那三张表**真实**影响的是：`gateOf` / `rejectedFor`（每次现算、无缓存）、
 *   `pickerNameOf` / `isAllDefaultsUnopened`（每次 `listModels` 现算、无缓存）、
 *   以及 `routingFingerprint()` 的键。
 * ⇒ 「改这三张表 ⇒ 候选序缓存失效」的**真实**机制是 **`clearChoiceCache()`**
 *   （`choiceCache`，60 秒 TTL）；正确性另有 `routingFingerprint()` 兜底
 *   （缓存键含这三张表的指纹），故 `clearChoiceCache` 是「立刻生效 + 释放内存」。
 *
 * ⚠️ **本仓库红线：注释必须与实现相符** —— 在**判据权威文件**里写一段假因果，
 *   比不写更危险（它会被后续改动当作依据）。因此这段订正是成文要求，不是可选润色。
 *
 * ## ⚠️⚠️ **只置陈旧，不删内容**
 *
 * 本函数**不**触碰任何适配器的 `remoteModels`。删掉已缓存的目录会让用户读到
 * **编译期兜底表**，而它是远端的**子集**（`docs/agent-notes/client-ui.md`：
 * cline 实测 3/460）⇒ 用户会看到「刚关掉一个开关，模型反而少了几十个」。
 * 置陈旧则「下一次读取先去拉一遍；拉不到就沿用上次那份完整列表」。
 *
 * ⚠️ 「拉不到时沿用旧读数」是各家**既有**实现（A 类四家的第二处复查
 * `isCatalogFresh(this.catalogAt, …)`、其余家的 `this.remoteModels ?? 兜底表`）
 * ⇒ 本函数不需要、也**不得**在这里复制一份内容。
 *
 * @param provider - 渠道 id（与 `modelAdapters` 的键同源）；**未登记时静默无操作**
 *   （不抛错：RPC 端点不该因为一个陌生 provider id 让已落盘的开关变成失败）
 * @param at - 失效时刻。**必须与写 `catalogAt` 的那个时钟同源**；缺省 `Date.now()`
 *   （生产口径）。单测注入假时钟时必须显式传它 —— 否则两边的数值不可比。
 *   ⚠️⚠️ **fail-open 方向（刻意）**：传 `0` / `NaN` / `±Infinity` / 任何非正的值
 *   ⇒ 判据里 `invalidatedAt > 0` 为假 ⇒ 本次调用**静默不失效**，行为退回本次改动
 *   之前的样子（只受 20 分钟 TTL 约束）。这是**安全**方向：误用最多让效果「晚一点」，
 *   而不会把用户**刚改完**的开关变成异常。
 *   ⚠️ **刻意不改成抛错**：一个参数校验异常会让「设置已落盘、但 RPC 回失败」，
 *   用户看到的是「开关没生效」并去重复点击 —— 那比静默退回 TTL 坏得多。
 *   （守卫那一格在 {@link isCatalogFresh} 的 `invalidatedAt > 0`，两者必须同向。）
 */
export function invalidateCatalogCache(provider: string, at: number = Date.now()): void {
  // ⚠️ 取 `max` 而不是直接覆盖：同一毫秒内的两次失效不能把标记**往回**拨
  //    （回拨会让「更早那次失效」之前的读数被误判成新鲜）。
  const previous = catalogInvalidations.get(provider)
  catalogInvalidations.set(provider, previous === undefined ? at : Math.max(previous, at))
}

/**
 * 该 provider 的「用户主动失效」时刻；从未失效过时为 `0`。
 *
 * ⚠️ **只给判据与单测用**，生产消费点一律走 {@link isCatalogFreshFor}
 * （避免「有的地方比时刻、有的地方比布尔」这种两套判据）。
 */
export function catalogInvalidatedAt(provider: string): number {
  return catalogInvalidations.get(provider) ?? 0
}

/**
 * ⚠️⚠️⚠️ **测试专用逃生门 —— 生产路径不得调用。**
 *
 * 清空失效表（**只给单测**）。
 *
 * ⚠️ 本函数清空的是**整张**失效表（不是某一个 provider）⇒ 任何生产调用方误调
 * **一次**，就把「用户改完设置 ⇒ 目录立即失效」这**整个功能静默关闭**，且
 * **零日志、无法自愈**（要等到下一次有写入端点被调用才恢复）。
 * 症状是「开关明明点了，最坏要等 20 分钟才生效」—— 与「功能压根没接线」同形。
 *
 * ⚠️ 为什么**只**靠注释约束不够、但仍**不加机制**：本文件是**判据权威**，
 *   加运行时守卫（如 `NODE_ENV !== 'test'` 时抛错）会在生产 bundle 里留一条
 *   永远走不到的分支，且让本仓库最忌讳的「死分支恒绿」判据重新有地方可长。
 *   ⇒ 处置：把约束**写在函数头正上方**（而不是行尾，避免被滚动吞掉），
 *   并由 `catalog-invalidation.spec.ts` 在注释所指的唯一位置使用它。
 *
 * ⚠️ 用它的**唯一**理由：进程级全局状态会在用例之间串味（上一条把 `loomy`
 *   置失效后，下一条的「周期内不得重拉」会假失败）。
 */
export function clearCatalogInvalidations(): void {
  catalogInvalidations.clear()
}

/**
 * 「该 provider 这份目录读数还能不能用」—— **入口短路**的判据。
 *
 * ## ⚠️ 它**不是**第二份「多久算新鲜」的实现
 *
 * 本函数体里**没有任何时间算术**：查一次失效表，然后把两样东西原样交给
 * {@link isCatalogFresh}。语义（TTL、边界、时钟回拨）仍然只由那一个函数持有 ——
 * 这是本仓库红线（「同一语义两套判据」）。
 *
 * ## ⚠️⚠️ 只能用在**「要不要去拉远端」那一处**，不得用于「拉完之后要不要用旧值」
 *
 * 用例：`loomy-adapter.ts` 的 `loadModels` 有**两处**判据 —— 方法入口（要不要拉）
 * 与 `catalogGate` 之后的复查（拉完了有没有新数据可用）。**只有入口该用它**：
 *
 * | 位置 | 该用哪个 | 理由 |
 * |---|---|---|
 * | 入口 | 本函数 | 用户改过设置 ⇒ 即使 TTL 内也要去拉一次 |
 * | gate 后复查 | **`isCatalogFresh`（不带失效）** | 拉取**失败**时 `catalogAt` 仍是旧值；此处若也判「被失效」，就会把手上那份**完整的旧目录**判成不可用 ⇒ 回落兜底表（**子集**）⇒ 用户看到「模型反而变少」，正是规格 §7 要避免的形态 |
 *
 * 换言之：失效的语义是「**去拉一次**」，不是「**把已有内容丢掉**」。
 */
export function isCatalogFreshFor(
  provider: string,
  at: number | undefined,
  now: number,
  ttlMs: number = CATALOG_REFRESH_INTERVAL_MS,
): boolean {
  return isCatalogFresh(at, now, ttlMs, catalogInvalidatedAt(provider))
}

export interface ModelCatalog {
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo>
  /** 「显示列表」要的全量目录（**不套黑名单**）。 */
  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[]
  /**
   * ★ **强制重拉远端目录**（后台 20 分钟刷新器与「用户改设置」共用）。
   *
   * ## ⚠️ 为什么是**可选**成员
   *
   * `createModelCatalog` 有 12 家在用，加**必选**成员会一次性打破所有实现
   * （本仓库铁律：不得改 12 家依赖的既有形状）。可选成员则「实现了就生效、
   * 没实现就跳过」—— `opencode` 那类本地派生渠道（零网络）本来就是空转。
   *
   * ## ⚠️ 与 `listModels` 的差别
   *
   * `listModels` 是**读驱动**：过期才拉（`isCatalogFresh` 判）。
   * 本方法**无视新鲜度**，无条件拉一次 —— 这正是「定时保鲜」与「用户主动刷新」需要的语义。
   *
   * @returns 无；失败由实现自己消化（后台刷新没有调用方可通知）
   */
  refresh?(): Promise<void>
}

export function createModelCatalog(
  deps: ModelCatalogDeps,
  config: ModelCatalogConfig,
): ModelCatalog {
  const providerId = config.product.id

  /**
   * `listAllModels()` 用的同步视图。
   *
   * ⚠️ 缓存的是 `loadCatalog()` 的**成功结果**，而**不是**「读到了远端」——
   * 因为 `loadCatalog` 内部已经做过「远端 ?? 兜底」的选择，它返回的**就是**
   * 当前该展示的全量目录。未调用过时回落到 `syncCatalog()`。
   */
  let cached: readonly CatalogEntry[] | undefined

  /**
   * 把 `CatalogEntry` 摊成 `LlmModelInfo` 的公共字段（三态在这里落实）。
   *
   * ⚠️ `contextWindow` **不在宿主 `LlmModelInfo` 契约里**（窗口在
   * `LlmResolvedModelInfo.context`，需逐模型 `resolveModel`）。这里作为
   * **附加字段**带出，供直接消费适配器返回值的调用方使用。
   * ⚠️⚠️ 它**到不了网关**：宿主 `LlmRuntime.listModels()` 会按白名单重建对象；
   * 网关的 `/v1/models` 走 `collectGatewayModelDetails` 的 `resolveModelInfo`
   * （见 `openai-gateway/models.ts`），不要以为本字段能修 issue #36。
   */
  function toModelInfo(entry: CatalogEntry): CatalogModelInfo {
    const info: {
      provider: string
      id: string
      name: string
      description?: string
      inputModalities?: readonly ('text' | 'image')[]
      contextWindow?: number
    } = { provider: providerId, id: entry.id, name: entry.name }
    // ⚠️ 三态：只有 `!== undefined` 才写入 —— 写 `['text']` 会明确声明不支持图片。
    if (entry.inputModalities !== undefined) info.inputModalities = entry.inputModalities
    if (entry.description !== undefined) info.description = entry.description
    if (entry.contextWindow !== undefined) info.contextWindow = entry.contextWindow
    return info
  }

  return {
    async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
      // ⚠️ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider
      // 分组隐藏。**必须返回空数组而不能抛错**（抛错会被归入 catalog 的
      // failures，界面上反而多一条 provider 报错）。
      if (!await providerCatalogVisible(deps.accountPool, providerId)) return []
      // ⚠️⚠️ **「供应商整体关闭」必须在这里短路**（Gitee issue IKP8OF）。
      //
      // 关闭供应商时只把**当时目录**的 id 写进黑名单；目录随后变长（cline 三源
      // 异步 + models.dev 可恢复、其余家后台刷新器补进上游新模型）⇒ 新 id 不在
      // 黑名单里 ⇒ **仍可选**，而 `provider.status` 的 `closed` 同时翻回 false。
      //
      // 意图判据（`providerClosedFor`）与目录快照无关，故它是唯一能覆盖
      // 「关闭之后才出现的模型」的判据。
      //
      // ⚠️ **放在这里覆盖的是「经本骨架 `listModels` 的 13 家」**（实测：`src/` 里
      //    有 14 个文件 `import` 本函数，但 `aggregate-adapter.ts` 只在注释里提到它、
      //    自己实现了 `listModels`）。另 5 家**手写** `listModels`、必须各自接线：
      //    `autoclaw`（国内+国际两实例）/ `modelscope` / `officeace` / `opencode` /
      //    `aggregate`。⚠️ 别在这里写死家数（本仓库的家数注释已腐坏过多次）——
      //    权威守卫是 `ikp8of-provider-closed.spec.ts` 的**逐家点名**用例。
      //
      // ⚠️ 返回值必须是 `[]` 而不是「过滤掉已知 id」：意图为真时目录里**每一条**
      //    都该消失，而其中可能包含我们**从未见过**的 id（黑名单里没有它们）。
      //
      // ⚠️⚠️ **短路不能挡住 `cached` 的写入**（独立审计提出，已实测核对）：
      //    `listAllModels()` 读的是 `cached ?? syncCatalog()`，而 `cached` 只由
      //    本方法 / `refresh()` 写入。若这里「提前 return」而不写 `cached`，
      //    关闭态下的设置页（`model.list` → `listAllModels()`）会退化成各家的
      //    **编译期兜底子集**（cline 实测 3 条 vs 远端 460+）⇒ 用户**看不到**
      //    远端模型，也就没有入口逐条打开它们，而 `provider.status` 的 `total`
      //    也会跟着失真。
      //    ⇒ 先正常读目录（写 `cached`），**再**决定要不要返回 `[]`。
      //    ⚠️ 代价：关闭态下多读一次目录。这是**必要**的 —— 设置页必须能列出
      //      全部模型（含新增的），否则用户无法逐条打开（本文件的设计承诺）。
      const closedWholeProvider = deps.accountPool?.providerClosedFor?.(providerId) === true
      const all = await config.loadCatalog()
      cached = all
      if (closedWholeProvider) return []

      const disabled = deps.accountPool?.disabledModelsFor(providerId)
      const listed = disabled === undefined || disabled.size === 0
        ? all
        : all.filter((entry) => !disabled.has(entry.id))
      return listed.map(toModelInfo)
    },

    /**
     * ★ **强制重拉**（无视新鲜度）。
     *
     * ⚠️ **未提供 `config.refresh` 时整个成员不出现**（返回 `undefined`）——
     * 这是刻意的：调用方据此判「这家参不参与后台刷新」，比一个「调了什么都不做」
     * 的假函数更容易发现接线错误（后者会让「刷新器说跑了 9 家、实际只刷了 3 家」
     * 完全静默）。
     */
    ...config.refresh === undefined ? {} : {
      async refresh(): Promise<void> {
        await config.refresh!()
        // ⚠️ 同步视图必须跟着失效：`syncCatalog()` 供**同步**的 `listAllModels()` 用，
        //    而它在 `cached` 未设置时回落到兜底表。刷新后不更新 `cached` 的话，
        //    `listAllModels` 会在下一次 `listModels` 之前一直看到旧目录。
        //    ⚠️ 不清成 `undefined`（那会退回兜底表 —— 兜底表是**子集**，
        //    用户会以为「刷新后模型反而变少了」）。
        try {
          cached = await config.loadCatalog()
        } catch {
          // ⚠️ 刷新失败**保留旧值**：后台刷新没有调用方可通知，清空只会让
          //    UI 从「完整列表」退化成「兜底子集」，比不刷新更糟。
        }
      },
    },

    async resolveModel(
      provider: string,
      model: string,
      _signal?: AbortSignal,
    ): Promise<LlmResolvedModelInfo> {
      const all = await config.loadCatalog()
      cached = all
      const entry = all.find((item) => item.id === model)
      // ⚠️ name 三级回退，**绝不空**（空名会让选择器出现空白项）：
      //    `bareName` → `name` → 裸 `model`。
      //
      // ⚠️⚠️ **`bareName` 优先**（不是 `name` 优先）—— 这一条与设计文档 §3.5.4.3
      //    里写的「entry.name → entry.bareName」**相反**，以本节为准。证据：
      //    - `bareName` 的**存在意义**就是「`resolveModel` 用的裸名」（见其字段注释）；
      //    - 设计文档**自己的验收表**也写「`bareName` 仅 raccoon / loomy 有；
      //      断言 `resolveModel().name` **不含 ` · x`**」；
      //    - 现有实现逐字如此：`loomy` 用 `splitLoomyRate(entry.name).name`、
      //      `raccoon` 用 `entry.name.replace(/ · .*$/, '')`；
      //    - ⚠️ 而 `minimax` **不剥**（`entry?.name ?? model`）⇒ 它**不提供**
      //      `bareName`，于是自然回退到 `name`。
      //    ⇒ 若按「name 优先」实现，loomy/raccoon 的 `resolveModel().name` 会**带上
      //      倍率后缀**，被 `loomy-adapter.spec.ts` 的「name 不带倍率」用例当场抓住
      //      （本 Task 实测：`expected 'Spark X2.5 · x0.1' to be 'Spark X2.5'`）。
      const resolved: LlmResolvedModelInfo = {
        provider,
        id: model,
        name: entry?.bareName ?? entry?.name ?? model,
      }
      if (entry !== undefined) {
        if (entry.inputModalities !== undefined) {
          resolved.inputModalities = entry.inputModalities
        }
        if (entry.description !== undefined) resolved.description = entry.description
      } else {
        // ⚠️ **未知 id**：由各家自己的判据决定（见 `unknownModelInputModalities`）。
        // 骨架**不替各家决定** —— 两个方向统一都会出真缺陷：统一成「省略」会让用户
        // 手填的未知模型从「明确不支持图片」变成「未知」（用户以为能发图）；
        // 统一成 `['text']` 则会让**故意省略**的家失去「未知」这个第三态。
        // ⇒ 家数**只在上面那个接口字段的表格里维护**，这里**刻意不抄数字**
        // （原先抄了个「10 家」并写成只有 `buddy` 省略，与那张表**互相矛盾**，
        // 正是「同一事实写多处 ⇒ 必有一处先腐坏」）。
        // ⚠️ **必须把 `model` 传进去**：`codearts` 的 VL 模型刻意不在目录里，
        //    却仍要按 id 声明 `image`（见该回调的注释）。
        const unknownModalities = config.unknownModelInputModalities?.(model)
        if (unknownModalities !== undefined) resolved.inputModalities = unknownModalities
      }
      // ⚠️ 未知模型**默认不编造** context（宁可让 DSH 用默认值，也不报一个假窗口）。
      //
      // ⚠️ 但**声明了 `unknownModelContextWindow` 的家**（当前只有 `codearts`）例外：
      //    它的窗口本就全部来自本地静态表、且缺窗口的后果是「占用条整条消失 +
      //    自动压缩阈值失去唯一输入」⇒ 用**具名兜底**而不是省略。
      //    判据与理由见该回调的注释；**不得**把它推广到其余各家。
      const knownContextWindow = entry?.contextWindow
      if (knownContextWindow !== undefined && knownContextWindow > 0) {
        resolved.context = { contextWindow: knownContextWindow }
      } else if (entry === undefined) {
        // ⚠️ **必须把 `model` 传进去** —— 实现方要能「表内优先、查不到才兜底」。
        //    不传会让「静态窗口表里有、但静态兜底目录里没有」的 id（如 `glm-5.3`）
        //    在离线路径上拿到常数兜底，与目录内路径的取值分叉（实测过）。
        const fallbackContextWindow = config.unknownModelContextWindow?.(model)
        // ⚠️ 同样要过「正整数」闸门：0/负数/NaN 会让 DSH 抛
        //    `INVALID_MODEL_CONTEXT`，**整轮对话起不来**（不是降级，是崩）。
        if (fallbackContextWindow !== undefined
          && Number.isInteger(fallbackContextWindow)
          && fallbackContextWindow > 0) {
          resolved.context = { contextWindow: fallbackContextWindow }
        }
      }
      // ⚠️ 非法值必须过滤：0/负数/NaN 会让 DSH 抛 INVALID_MODEL_MAX_TOKENS，
      // **整轮对话起不来**（不是降级，是崩）。
      const maxTokens = entry?.maxTokens
      if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
        resolved.defaultMaxTokens = maxTokens
      }
      // ⚠️ `efforts` 非空才声明；且 `defaultEffort` **必须落在 `efforts` 内** ——
      // 指向不存在的档位会让选择器显示空白，比不给更糟（DSH 会抛
      // UNSUPPORTED_REASONING_EFFORT）。
      const reasoning = entry !== undefined ? entry.reasoning : config.unknownModelReasoning?.()
      if (reasoning !== undefined && reasoning.efforts.length > 0) {
        const defaultEffort = reasoning.defaultEffort
        const legal = defaultEffort === undefined
          || reasoning.efforts.some((effort) => effort.id === defaultEffort)
        if (legal) resolved.reasoning = reasoning
      }
      return resolved
    },

    /**
     * ⚠️ **同步**（契约要求，见 `ModelCatalogConfig.syncCatalog` 的说明）。
     * **不套黑名单** —— 设置页要能看到已关闭模型的倍率（用户报障：
     * 「关闭的就没有显示倍率」）。
     */
    listAllModels(): readonly { id: string; name: string; isFree?: boolean }[] {
      const source = cached ?? config.syncCatalog()
      return source.map((entry) => ({
        id: entry.id,
        name: entry.name,
        ...(entry.isFree === undefined ? {} : { isFree: entry.isFree }),
      }))
    },
  }
}

/**
 * ★ 模型目录的**后台刷新器**：每 20 分钟叫醒所有「实现了 `refresh`」的 provider。
 *
 * ## 为什么需要它（用户 2026-10-18 的原话）
 *
 * 「各个模型的模型列表缓存也要带定时更新，20 分钟更新一次，如果不更新随高峰低谷
 * 变化的积分消耗倍率是更新不到实际的倍率」
 *
 * ⚠️ 前序 Task 加的 `isCatalogFresh` 是**读驱动**的判据：只有有人读、且发现过期，
 * 才会真去拉。没人读时缓存永远是旧的 —— 本类补上「没人读也要保鲜」那一半。
 *
 * ## ⚠️⚠️ 三条必须遵守的约束
 *
 * 1. **逐 provider 顺序执行**，不得 `Promise.all` —— 并发打上游会触发风控
 *    （`collectCreditBalances` 的既有实测结论）。
 * 2. **单家失败不得中断其余** —— 一个渠道的凭据坏了不该让另外 8 家停止保鲜。
 * 3. **单飞**：一轮含真实网络请求、可达数十秒；上一轮未结束时跳过本轮。
 */
export interface CatalogRefresherOptions {
  /** 当前注册的 provider id（顺序即刷新顺序）。 */
  listProviders(): readonly string[]
  /**
   * 强制刷新一家。
   *
   * ⚠️ **未实现 `refresh` 的 provider 必须由调用方过滤掉**（返回 `undefined` 即跳过），
   * 否则刷新器会静默地对它们空转，日志里看不出「实际只刷了 3 家」。
   */
  refreshOf(provider: string): void | Promise<void> | undefined
  /** 定时器工厂（注入以便单测用假定时器）。缺省用全局 `setInterval`。 */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void }
  /** 刷新周期（毫秒）。缺省 {@link CATALOG_REFRESH_INTERVAL_MS}。 */
  intervalMs?: number
  /** 日志出口。 */
  info?(message: string): void
  warn?(message: string): void
}

export interface CatalogRefresher {
  /** 武装定时器（**幂等**：重复调用不会叠加 interval）。 */
  start(): void
  /** 立即跑一轮（不 await 的入口由 `start` 用；单测直接 await 它）。 */
  tick(): Promise<void>
  stop(): void
  isArmed(): boolean
}

export function createCatalogRefresher(options: CatalogRefresherOptions): CatalogRefresher {
  const intervalMs = options.intervalMs ?? CATALOG_REFRESH_INTERVAL_MS
  const setIntervalImpl = options.setInterval
    ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  /**
   * ⚠️ 注入假定时器时**不得**用全局 `clearInterval` 去停它（句柄对不上）⇒ 自己分流。
   * 宁可少一个能力，也不要留一个「看起来停了、实际还在跑」的定时器。
   */
  const clearImpl = options.setInterval === undefined
    ? (handle: unknown) => { clearInterval(handle as ReturnType<typeof setInterval>) }
    : () => {}
  let timer: { unref?: () => void } | undefined
  /** ⚠️ 防重入闸门**必须有**：一轮含真实网络请求，可达数十秒。 */
  let running = false

  const tick = async (): Promise<void> => {
    if (running) {
      options.warn?.('[jet-hub] 上一轮目录刷新尚未结束，跳过本轮')
      return
    }
    running = true
    try {
      // ⚠️ **逐 provider 顺序**（约束 1）：并发打上游会触发风控。
      //
      // ⚠️⚠️ **必须统计「本轮有几家真的参与」**（2026-10-20 修正）：
      //    `refreshOf` 返回 `undefined` 是「这家不参与后台刷新」的**合法**表达，
      //    但此前**没有任何东西**区分「有意不参与」与「忘了接线」——
      //    而 `be42b25` 实测正是后者：13 家适配器**都没有**把 `catalog.refresh`
      //    转发成自己的 `refresh` 成员（它们只给了 `createModelCatalog` 的 config
      //    回调），于是每一轮都是 **0 家**，而 `start()` 的「已武装」日志照打 ⇒
      //    功能整体失效却**一行日志都没有**。
      //    ⚠️ `be42b25` 的原注释声称「返回 undefined 比一个『调了什么都不做』的
      //    假函数更容易发现接线错误」—— **实测恰好相反**：假函数至少会真发请求。
      //    ⇒ 零参与必须 warn（强信号：几乎可断定是接线缺口）。
      let total = 0
      let participated = 0
      for (const provider of options.listProviders()) {
        total += 1
        try {
          const outcome = options.refreshOf(provider)
          // ⚠️ 判据是「**是否返回了东西**」：`index.ts` 的实现保证「适配器有
          //    `refresh` 成员 ⇒ 返回 Promise；没有 ⇒ 返回 undefined」。
          if (outcome !== undefined) participated += 1
          await outcome
        } catch (error) {
          // ⚠️ 绝不上抛（约束 2）：单家失败不得让刷新器停摆、也不得中断其余家。
          options.warn?.(
            `[jet-hub] ${provider} 目录刷新失败（照常继续）：`
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      if (total > 0 && participated === 0) {
        options.warn?.(
          `[jet-hub] 模型目录刷新器本轮**无一家参与**（共 ${total} 家）—— `
          + '刷新器已武装却形同空转，几乎可断定是接线缺口：'
          + '各家适配器必须把 `catalog.refresh` 转发为自己的 `refresh` 成员'
          + '（`pruned()` 的 Proxy 只透传适配器**自己的**成员）。',
        )
      } else if (participated < total) {
        // ⚠️ 部分参与不 warn（有些家有意不参与），但必须留痕 ——
        //    否则「说跑了 N 家、实际只刷了 M 家」仍然是静默的。
        options.info?.(
          `[jet-hub] 模型目录刷新器本轮参与 ${participated}/${total} 家`,
        )
      }
    } finally {
      running = false
    }
  }

  return {
    start() {
      // ⚠️ **幂等**（约束 3 的配套）：重复武装会叠加 interval，刷新频率翻倍。
      if (timer !== undefined) return
      timer = setIntervalImpl(() => { void tick() }, intervalMs)
      timer.unref?.()   // 不拦进程退出（与既有定时器同款）
      options.info?.(
        `[jet-hub] 模型目录刷新器已武装（每 ${Math.round(intervalMs / 60_000)} 分钟一轮）`,
      )
    },
    tick,
    stop() {
      if (timer === undefined) return
      // ⚠️ **必须真的停表**：只置 `undefined` 会让 interval 继续跑（看起来停了、实际没停，
      //    且症状是「插件已卸载但仍在打上游」—— 零报错）。
      clearImpl(timer)
      timer = undefined
    },
    isArmed: () => timer !== undefined,
  }
}
