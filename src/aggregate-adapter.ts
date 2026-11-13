/**
 * 聚合 provider：**一个规范模型名，多渠道候选**，按临期积分自动选渠道。
 *
 * ## 与 `jet-hub-auto` 的分工
 *
 * | | `jet-hub-auto/auto` | `aggregate/auto` | `aggregate/<规范模型>` |
 * |---|---|---|---|
 * | 候选来源 | 5 个渠道的所有模型 | 所有渠道的所有模型 | **该虚拟模型**的候选表 |
 * | 渠道内选模型 | 按倍率挑最便宜 | 同左 | 固定 realId，无选择 |
 * | 用途 | 不挑模型，谁临期烧谁 | 同左 | 锁定模型质量，渠道间轮询 |
 *
 * 两者**共用** `aggregate-core` 的排序与哨兵口径（见该模块头：两份实现必然漂移）。
 *
 * ## 目录是**动态**的
 *
 * 虚拟模型表由各渠道的**当前**目录推导（`buildVirtualModels`）⇒ 用户新增/关闭
 * 渠道模型后，下次 `listModels` 自动反映，无需重启。⚠️ 故**不缓存**目录，
 * 只缓存「一次选型」的结果（见 {@link AggregateAdapterOptions.ttlMs}）。
 *
 * ## DSH 的两条硬约束（违反即报错）
 *
 * 1. `listModels` 每条必须 `provider === 注册路由`、id/name 非空且**id 不重复**
 *    （否则 `INVALID_CATALOG`）；
 * 2. `resolveModel` 返回的 `provider`/`id` 必须与请求**逐字相符**
 *    （否则 `INVALID_MODEL_INFO`）—— 这是「多虚拟模型」必须按入参回填的原因。
 *
 * @module src/aggregate-adapter.ts
 */

import type { Context } from '@deepseek-ai/cordis'
// ⚠️ `contentHasImage` 是**值导入**（`auto-adapter.ts` 同款）：带图判定必须与宿主
// capability 判据**同一函数**（它含 tool-result 递归），自己写一遍必然漂移。
import { LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, contentHasImage } from '@deepseek-ai/dsh-llm'
import type { LlmErrorOptions } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AccountPool } from './account-pool.js'
// ⚠️ 只导入**类型**（拒绝表的结构）—— 运行时读写由装配层注入的 `rejections()` 承担，
// 适配器不直接碰 `state.json`（保持「适配器不持有持久化」的分层）。
import type { AggregateAllowedMap, AggregateOrderMap, AggregateRejectionMap } from './jet-hub-store.js'
import { buildVirtualModels, type VirtualModel } from './aggregate-catalog.js'
import { bindAggregateDispatch } from './aggregate-dispatch-context.js'
// ⚠️ `NEVER` / `UNUSABLE` **必须**从这里导入（Task 3 的共享底座）。它们从不在
// `auto-adapter.ts` 里 `export` —— 从那里导入会编译失败（Task 3 复审已确认）。
// ⚠️ `ExpiryProbe` 也在这里：它是**纯类型**，而 `aggregate-expiry.ts`（探针实现）
// 与 `auto-adapter.ts` 都要引用它 ⇒ 放底座才能让两者都依赖底座而**不互相依赖**。
// ⚠️ `resolveCandidateGate` / `CandidateGate` 也在这里：三态判据**只留这一份实现**
//（面板渲染、选型报价、建池过滤都读它的结果，客户端读宿主下发的 `state`）。
import {
  NEVER,
  UNUSABLE,
  pickDiversified,
  rankCandidates,
  resolveCandidateGate,
  type CandidateGate,
  type ExpiryProbe,
  type RankedCandidate,
} from './aggregate-core.js'
import { CANONICAL_REASONING_EFFORTS, translateReasoningEffort } from './reasoning-ladder.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
// ⚠️ 目录落地的**广播**也只留一份实现（`catalog-broadcast.ts`）：12 家适配器都由
//    `registerXxxLlm` 把 `broadcastCatalogChanged(ctx)` 注入成 `onCatalogLoaded`。
//    本适配器原先**完全没有**广播 ⇒ 后台那一轮无论多久落地，客户端都不会自动重读
//    （它在 `status === 'ready'` 时短路，只认这四个宿主事件）⇒ 用户必须自己再开一次
//    选择器才能看到虚拟模型。见 {@link AggregateAdapter.onCatalogLanded}。
import { broadcastCatalogChanged } from './catalog-broadcast.js'
// ⚠️ 冷启动（目录尚未读到）时 `resolveModel` 要回**保守展示名**，必须是**同一份**
//    规范化实现（与 `aggregate-catalog.ts` 的 `buildVirtualModels` 同源）——
//    自己写一遍会与目录里的名字漂移（同一个模型两套名字）。
import { canonicalDisplayName } from './canonical-models.js'
// ⚠️ 「目录够不够新」只留**一份实现**（`model-catalog.ts` 的 `isCatalogFresh`）。
//    本文件原先自己内联 `now - this.catalogAt < ttl`，与 9 个适配器里的同一判据
//    构成「同一语义两套判据」（仓库红线，`docs/agent-notes/misc.md`）。
import { isCatalogFreshFor } from './model-catalog.js'
// ⚠️ 只导入**常量**（不导入 `createExpiryProbe`）⇒ 依赖方向仍是
// `aggregate-adapter → aggregate-expiry → aggregate-core`，无环。
import { WIRED_EXPIRY_PROVIDERS } from './aggregate-expiry.js'

/** 注册到 `ctx.llm` 的路由，也是 `providerInfo().id`（DSH 校验二者相等）。 */
export const AGGREGATE_PROVIDER = 'aggregate'

/** 「不挑模型」的虚拟模型 id。 */
export const AGGREGATE_AUTO_MODEL = 'auto'

/**
 * 临期探针的类型 `ExpiryProbe` 定义在 **`aggregate-core.ts`**（纯类型、零 IO）——
 * 实现是 `aggregate-expiry.ts` 的 `createExpiryProbe`，`auto-adapter.ts` 的
 * `expiryOf` 也复用它（薄委托）。
 *
 * ⚠️ **未接入的 provider 必须返回 `UNUSABLE`** —— 返回 `NEVER` 会让一个我们对其
 * 余额一无所知的渠道以「永久积分」身份参与轮换（见 `aggregate-expiry.ts` 的
 * 逐渠道判据表与长注释）。
 */

/** 聚合层的选型缓存时长（与 auto 同量级）。 */
export const AGGREGATE_TTL_MS = 60_000

/** 目录推导的缓存时长。
 *
 * ⚠️ **必须有这个缓存**：`refreshCatalog` 要向**每一个**渠道调 `listModels`，
 * 而其中数家会**发网络请求**取远端目录（buddy / workbuddy / lobsterai / trae /
 * cline / zcode）。而模型选择器会频繁问目录 ⇒ 没有缓存时，每打开一次选择器都会
 * 扇出十几次上游请求。
 *
 * ⚠️ 但**不能缓存太久**：用户新增/关闭渠道模型后，聚合目录要跟着变（这正是
 * 「目录是动态的」那条设计）。60 秒与各家自己的目录缓存同量级。
 */
export const AGGREGATE_CATALOG_TTL_MS = 60_000

/**
 * 后台那一轮目录刷新的**放弃等待**预算（毫秒）。
 *
 * ## ⚠️⚠️ 为什么必须有它（`catalogRefreshInFlight` 的单向门，2026-10-18 复审实测）
 *
 * `startBackgroundCatalogRefresh` 的单飞标记只在 `.finally` 里清 —— 那假设了
 * 「一轮刷新**总会结束**」。而上游会**永不 resolve**（实测：`loomy` 的目录读取
 * 卡住时 `ctx.llm.listModels` 既不 resolve 也不 reject）⇒ `.finally` 永不执行
 * ⇒ 标记永不清 ⇒ 此后**所有** `listModels` 都不再起后台刷新 ⇒ 目录**永久冻在
 * 冷帧**，且**零报错**（单向门形态）。
 *
 * ⚠️ 修的必须是「**放弃等待**」而不是「取消」：`LlmRuntime.listModels(provider)`
 * **只接受一个参数、没有 signal 通道**（`dsh-llm/lib/index.js` 的
 * `async listModels(provider)`）⇒ 正在挂住的那次读取**无法中断**，`AbortSignal`
 * 对它无效（`throwIfAborted` 只能在它**返回之后**生效）。故用
 * {@link withBackgroundDeadline}：到点就 reject、清标记、**保留旧目录**，
 * 被放弃的那一轮若日后真的落地，仍会正常写入并广播（不丢结果）。
 *
 * ⚠️ 取值与目录 TTL 同量级（60 秒）：正常一轮刷新的实测最坏值是 7 秒级
 * （`provider=aggregate` 逐渠道读取之和），60 秒足够宽；而它同时是
 * 「上游挂死后，用户最多等多久才能再触发一次后台读取」。
 */
export const AGGREGATE_BACKGROUND_REFRESH_TIMEOUT_MS = 60_000

/**
 * **单个候选**能力解析（`resolveModelInfo`）的超时预算（毫秒）。
 *
 * ## ⚠️⚠️ 为什么必须逐候选设预算（用户报障 2026-10-20 实测）
 *
 * 报障现象：`aggregate/deepseek-v4-1-flash` 有 **21%** 的请求在**到达上游之前**
 * 就等了 55–239 秒（同模型**直连** workbuddy 只有 1%）。用严格一对一配对测得：
 *
 * ```
 * aggregate/deepseek-v4-1-flash   n=336  中位=60.3s  p90=83.0s  ≥55s=231 (68.5%)
 * workbuddy/deepseek-v4.1-flash   n=265  中位= 0.8s  p90= 1.1s  ≥55s=  0 ( 0.0%)
 * ```
 *
 * 根因不是余额折算（43 个账号全串行实测 11.2 秒）、不是目录刷新（20 分钟 TTL），
 * 而是**候选池里只要有一个渠道的 `resolveModelInfo` 会挂住/失败**，就每轮都要
 * 重新等它一次 —— 因为失败结果不进 `capabilityCache`（见那里的注释），而
 * `contextWindowFor` 又要求「全部候选都成功」才记忆化（见那里的注释）。
 *
 * 实测复现（`autoclaw` 的目录端点在 DNS/TCP 层 ETIMEDOUT，`AbortController`
 * 管不到它自己的 8 秒 timer）：
 * ```
 * 第1次 prepareCall = 16015 ms   第2次 = 8001 ms   第3次 = 8009 ms
 * contextWindowCache 命中? ★否 —— 永不记忆化
 * ```
 * 而 `buildModelCatalog` 会对目录里**每个虚拟模型**各调一次 `resolveModelInfo`
 * ⇒ 1/5/10 个虚拟模型 = 508/2551/5102 ms，**严格线性放大**。
 *
 * ## 为什么是 3 秒
 *
 * 各渠道的 `resolveModelInfo` 绝大多数是**纯本地查表**（`createModelCatalog` 的
 * `loadCatalog`，实测 1–17ms）；只有少数会在目录未就绪时真发网络，正常也在
 * 100–800ms 量级。3 秒是「健康路径的 3–30 倍余量、坏候选的 1/7」——
 * 既不会误伤慢但正常的渠道，也不会让一个挂住的候选吃掉整轮预算。
 *
 * ⚠️ **超时不等于取消**：这里放弃的只是一次**能力元数据**解析（窗口/档位/图片），
 * 不涉及用户请求本身。放弃后按保守方向回落（无档位 / 不支持图片 / 无窗口），
 * 由 {@link AGGREGATE_FALLBACK_CONTEXT_WINDOW} 兜住窗口，行为与「解析失败」完全一致。
 */
export const AGGREGATE_CAPABILITY_TIMEOUT_MS = 3_000

/**
 * **失败**的能力解析结果的缓存时长（毫秒），远小于目录 TTL（60 秒）。
 *
 * ## ⚠️⚠️ 这是「不缓存失败」与「每轮重试坏候选」之间的折中
 *
 * `capabilityCache` 的注释明确禁止把失败缓存 60 秒 —— 那会把**瞬时**故障
 * 固化成单向门（`AGENTS.md` 反复记录的缺陷形态）。但「完全不缓存」在候选池里
 * 存在**持续**故障的渠道时走向另一个极端：每一轮请求、每一次目录构建都要
 * 重新等它超时（实测 8–21 秒 × 每轮）。
 *
 * ⇒ 取 30 秒：比一次用户交互长（同轮内的多次 `capabilityOf` 调用全部命中缓存，
 * `buildModelCatalog` 的线性放大随之消失），又比目录 TTL 短一半（上游恢复后
 * 最迟 30 秒自动重试成功，不需要重启插件）。
 *
 * ⚠️ **恢复即清**：解析成功时立刻 `delete` 该键的失败记录，不必等 TTL 到期。
 */
export const AGGREGATE_CAPABILITY_FAILURE_TTL_MS = 30_000

/**
 * **退化**的窗口判决（有候选没解析成功）的缓存时长（毫秒）。
 *
 * ## ⚠️⚠️ 为什么退化判决也必须记忆化（用户报障 2026-10-20 实测）
 *
 * 原实现是「只有**每一个**候选都解析成功时才记忆化」（见
 * {@link AggregateAdapter.contextWindowFor} 的长注释）。那条判据的**动机是对的**
 * （不能把瞬时故障固化成 60 秒的单向门），但**手段过强**：
 *
 * ```
 * 第1次 prepareCall = 16015 ms   第2次 = 8001 ms   第3次 = 8009 ms
 * contextWindowCache 命中? ★否 —— 永不记忆化
 * ```
 *
 * 候选池里只要有一个渠道持续故障，该虚拟模型的窗口声明就**永不进缓存** ⇒
 * 每一轮请求、每一次 `buildModelCatalog` 都要把全部候选重新解析一遍。
 *
 * ⇒ 改为「退化判决也记忆化，但只记 30 秒」：既不再每轮重试，又比目录 TTL
 * （60 秒）短一半 —— 上游恢复后最迟 30 秒自动拿到完整判决，不需要重启插件。
 * ⚠️⚠️ **退化期间声明的窗口方向是「可能偏大」，不是「偏保守」**（2026-10-20 对抗审计实测证伪）：
 *
 * | 情形 | 声明值 | 与真实窗口比 | 后果 |
 * |---|---|---|---|
 * | 有候选解析成功 | 已成功那部分的最大值 | **≤** 真实最大值 | 保守（提前压缩） |
 * | **全部候选都失败** | `AGGREGATE_FALLBACK_CONTEXT_WINDOW`（200_000） | 可能 **>** 真实值 | **偏大** ⇒ 压缩阈值推后 ⇒ 上游 `CONTEXT_WINDOW_EXCEEDED` |
 *
 * 实测：唯一候选真实窗口 131_072（128K）而解析失败 ⇒ 声明 **200_000**（大 52%）。
 * 同文件的**冷帧**常量 `AGGREGATE_COLD_CONTEXT_WINDOW`=131_072 才是真保守 ⇒
 * 两个「保守兜底」方向相反（该取值是**既有行为**，master 上同样是 200_000，
 * 不是本 PR 引入；本 PR 引入的只是那句写错方向的注释）。
 */
export const AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS = 30_000

/**
 * **冷帧**（目录尚未推导出来）时 `resolveModel` 声明的上下文窗口。
 *
 * ## ⚠️⚠️ 这不是「聚合模型的窗口」，是「此刻我们还不知道」时的**保守声明**
 *
 * `DSH` 要求每个可路由模型都声明一个**正整数**窗口：`dsh-compaction-basic` 在
 * `info.context === undefined` 时**抛** `TargetPressureConfigError`。故冷帧也必须给值。
 *
 * 取 **131072（128K）**，即本仓库各渠道已声明窗口里的**下界量级**
 * （`llm-adapter.ts` 的 `CONTEXT_WINDOWS` 最小档、`buddy` 的 `glm-5.1` 等 200K
 * 之下的保守端）。方向是刻意的：窗口声明**偏小**的后果只是「压缩阈值提前触发」
 * （多发一次压缩、多花一点 token），而**偏大**的后果是上下文超限被上游拒绝
 * （整轮失败）。未知时宁可偏小。
 *
 * ⚠️ 与 {@link AGGREGATE_FALLBACK_CONTEXT_WINDOW}（200_000，候选窗口**都取不到**时
 * 的语义兜底）**刻意分开**：两者是**不同的状态** —— 那个是「候选在、但没声明窗口」，
 * 这个是「候选表还没读到」。混用会让排障者无法区分冷帧与「渠道没声明窗口」。
 * ⇒ 它同时是冷帧元数据的**可辨识特征**（见 {@link AggregateAdapter.coldModelInfo}）。
 */
export const AGGREGATE_COLD_CONTEXT_WINDOW = 131_072

/**
 * 取不到任何候选窗口时的**兜底**声明值。
 *
 * ## ⚠️⚠️ 这不是「聚合模型的窗口」，只是「我们不知道」时的占位
 *
 * 真实缺陷（用户报障 2026-10-07）：本适配器的 `resolveModel` 把这个值当成
 * **所有**虚拟模型的窗口硬编码下发（`context: { contextWindow: 200_000 }`，
 * `auto` 与具名虚拟模型两处），于是 `aggregate/deepseek-v4-1-flash` 在界面上
 * 只显示 `~x / 200k` —— 而同一个模型**直连** buddy / codearts 时声明的都是
 * **1M**（`product.ts` 的兜底表 1_000_000、`llm-adapter.ts` 的
 * `CONTEXT_WINDOWS` 1_000_000）。
 *
 * 设计文档 §4.1 写的口径是「ctx / 图片 / 档位取**候选集的能力并集**」，
 * 档位与图片都按该口径落地了（见 {@link aggregateReasoningInfo} 与
 * `capabilityOf`），**只有 ctx 这一项**留在了 P1 的写死占位值上。
 *
 * ## 两个真实消费者（所以它不只是展示问题）
 *
 * | 消费者 | 位置 | 后果 |
 * |---|---|---|
 * | 自动压缩阈值 | `dsh-compaction-basic/lib/index.js` 读 `info.context.contextWindow` 算 `thresholdTokens` | 上下文涨到 `200k × ratio` 就触发压缩，**永远吃不到 1M** |
 * | 上下文占用指示器 | `dsh-client-ui-conversation` 读 `pressure.contextWindow` | 界面显示 `~x / 200k` |
 *
 * ## ⚠️ 为什么不能「不声明」
 *
 * `dsh-compaction-basic` 在 `info.context === undefined` 时**抛**
 * `TargetPressureConfigError: no context capacity for …; configure contextWindow
 * on that adapter model`。即 DSH 要求每个可路由的模型都声明一个**正整数**窗口
 * ⇒ 兜底值必须存在且为正，这不是可选的美化。
 *
 * ⇒ 正确口径见 {@link AggregateAdapter.contextWindowFor}：**取候选集的最大值**；
 * 本常量只在「一个候选的窗口都取不到」时使用（如候选渠道全部未登录、
 * 或该渠道的 `resolveModel` 不声明窗口 —— zcode 之外的多数渠道都有可能）。
 */
export const AGGREGATE_FALLBACK_CONTEXT_WINDOW = 200_000

/**
 * 一条候选（provider + realId）的**能力缓存**：窗口 / 档位 / 图片。
 *
 * ⚠️ 三项**共用同一次 `resolveModelInfo` 调用** —— 这是把窗口推导做成
 * 「顺带取回」而不是「另查一遍」的原因（见 {@link AggregateAdapter.capabilityOf}）。
 */
interface CandidateCapability {
  /** 该候选声明的上下文窗口；远端/静态表都没给时为 `undefined`。 */
  contextWindow?: number
  /** 该候选声明的思考档位 id（供逐候选翻译用，见 `dispatch`）。 */
  efforts: readonly string[]
  /**
   * 该候选是否声明支持图片输入。
   *
   * ⚠️ **解析失败时必须是 `false`**（保守方向）：把「不知道」当成「支持」会让带图
   * 请求被发到一个可能收不了图的渠道，而失败现象是**上游报错**（用户看不出真因）；
   * 当成「不支持」最多是**少用一个候选**（带图时换一个已声明支持的），代价小得多。
   * 与全仓「未知不编造」一致。
   */
  imageCapable: boolean
  /**
   * 本次能力是**真的解析成功**了，还是失败后的保守回落。
   *
   * ⚠️ 存在的唯一理由是让调用方能区分「这个候选没声明窗口」与「这次没问出来」——
   * 前者可以记忆化，**后者绝不能**（见 {@link AggregateAdapter.contextWindowFor}：
   * 把瞬时故障记忆化会把它固化成持续错误，正是本仓库反复修过的单向门形态）。
   * ⚠️ 它**不进** {@link DispatchTarget} 的语义面，只是随缓存对象一起流动的内部标记。
   */
  resolved: boolean
}

/**
 * 一条**窗口判决**缓存项（{@link AggregateAdapter.contextWindowCache} 的值）。
 *
 * ⚠️ 为什么不直接存 `number`：判决分两种质量，它们的有效期**必须不同** ——
 * 全部候选都解析成功的是**完整判决**（有效期 = 目录 TTL，因为它是纯函数），
 * 有候选没解析成功的是**退化判决**（有效期只有 30 秒，见
 * {@link AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS}）。只存数字就无法区分这两者。
 */
interface ContextWindowEntry {
  /** 声明的窗口值（`widest ?? AGGREGATE_FALLBACK_CONTEXT_WINDOW`）。 */
  window: number
  /** 判决时刻（用于 TTL 判定）。 */
  at: number
  /**
   * 是否**退化**判决：`true` = 当时至少有一个候选没解析成功。
   *
   * ⚠️ 退化判决仍然可用（窗口值是「已成功解析那部分的最大值」，偏保守），
   * 只是有效期短 —— 上游恢复后要尽快拿到完整判决。
   */
  degraded: boolean
}

export interface AggregateAdapterOptions {
  accountPool: AccountPool
  /** 注入的当前时刻（测试用）。 */
  now?: () => number
  /** 选型缓存时长（测试用）。 */
  ttlMs?: number
  /** 目录推导缓存时长（测试用；生产用 {@link AGGREGATE_CATALOG_TTL_MS}）。 */
  catalogTtlMs?: number
  /**
   * 后台那一轮目录刷新的**放弃等待**预算（测试用；生产用
   * {@link AGGREGATE_BACKGROUND_REFRESH_TIMEOUT_MS}）。
   *
   * ⚠️ 存在的理由只有一个：它必须是**可注入**的，否则那条「上游永不 resolve ⇒
   * 标记永不清」的守卫用例得跑满 60 秒（本仓库明确禁止这种 flaky 判据）。
   */
  backgroundRefreshTimeoutMs?: number
  /**
   * 单个候选能力解析的超时预算（测试用；生产用
   * {@link AGGREGATE_CAPABILITY_TIMEOUT_MS}）。
   *
   * ⚠️ 存在的理由与 `backgroundRefreshTimeoutMs` 同：它必须是**可注入**的，
   * 否则那条「坏候选不得拖住整轮」的守卫用例得跑满 3 秒 × N，本仓库明确禁止
   * 这种拖慢全量套件的判据。
   */
  capabilityTimeoutMs?: number
  /**
   * 失败的能力解析结果的缓存时长（测试用；生产用
   * {@link AGGREGATE_CAPABILITY_FAILURE_TTL_MS}）。
   *
   * ⚠️ 同上：不可注入就无法在单测里验证「TTL 到期后会重试」，只能等 30 秒。
   */
  capabilityFailureTtlMs?: number
  /**
   * **退化**窗口判决的缓存时长（测试用；生产用
   * {@link AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS}）。
   *
   * ⚠️ 同上：不可注入就只能等 30 秒才能验证「到期后重新解析」。
   */
  contextWindowDegradedTtlMs?: number
  /**
   * 目录**落地**（后台那一轮成功写入 `this.catalog`）后的通知钩子。
   *
   * ⚠️ 由 `registerAggregateLlm` 注入为 `() => broadcastCatalogChanged(ctx)`，
   * 与其余 12 家适配器的 `onCatalogLoaded` **同一口径、同一实现**。
   * 省略时静默不广播（单测替身常见形态）。
   *
   * ⚠️ **只在「目录真的变了」时调**（见 {@link AggregateAdapter.onCatalogLanded}）：
   * 每次 `listModels` 都广播会让客户端反复重读，形成广播风暴。
   */
  onCatalogLanded?: () => void
  /** 临期探针（省略时用 `createExpiryProbe`；单测注入替身）。 */
  expiryProbe?: ExpiryProbe
  /**
   * 读取「拒绝轮换」表（虚拟模型 id → provider → realId → true）。
   *
   * ⚠️ 必须是**函数**而不是快照：设置面板上的开关改完后，**下一次请求**就要生效。
   * 传快照会让用户以为开关坏了（要重启插件才生效）。
   * 省略时视为「没有任何拒绝」（全部候选参与轮换）。
   *
   * ⚠️ 与 `choiceCache` 的耦合：改了拒绝表必须调
   * {@link AggregateAdapter.clearChoiceCache}，否则 60 秒 TTL 内仍会用旧的候选序
   *（RPC 端点负责这件事，见 `aggregate.setRejected`）。
   */
  rejections?: () => AggregateRejectionMap
  /**
   * 读取「**显式允许**参与轮换」白名单（虚拟模型 id → provider → realId → true）。
   *
   * ⚠️ 与 {@link rejections} 同为**函数**（不是快照）且理由相同：面板改完开关，
   * **下一次请求**就要生效。
   * 省略时视为「没有任何手工打开」⇒ 未接入临期折算的渠道**全部默认不参与**
   *（这是用户 2026-10-15 选定的默认态；已接入渠道不受影响）。
   */
  allowed?: () => AggregateAllowedMap
  /**
   * 读取**手工顺序**表（虚拟模型 id → 候选键数组）。
   *
   * ⚠️ 省略时视为「未自定义任何顺序」⇒ 全部按临期序（升级前行为）。
   */
  order?: () => AggregateOrderMap
  /**
   * 读取**排序模式**（`'expiry'` / `'manual'`）。
   *
   * ⚠️ 省略时视为 `'expiry'`（升级前行为）。
   */
  orderMode?: () => 'expiry' | 'manual'
}

/** 聚合适配器。 */
export class AggregateAdapter extends LlmAdapter {
  /** 上次目录读取结果（面板与 listModels 共用一次推导）。 */
  private catalog: VirtualModel[] = []
  /** 上次推导时刻（目录缓存的判据）。 */
  private catalogAt = 0
  /**
   * 「已有一轮后台目录刷新在飞」标记（{@link startBackgroundCatalogRefresh} 的单飞闸门）。
   *
   * ⚠️ **不合并就会扇出**：宿主对目录的调用是高频的（选择器一开就一轮），
   * 而每次「缓存不新鲜」都会起一轮 ⇒ 十几家渠道被反复并发读取，正是
   * {@link AGGREGATE_CATALOG_TTL_MS} 注释里要防的形态。
   * ⚠️ 与 `catalogAt` 的区别：那个记「上次**成功**的时刻」，本标记记「此刻有没有人在跑」
   * ——两者不可互相推导（在飞期间 `catalogAt` 仍是旧值）。
   *
   * ⚠️⚠️ **它必须由「预算到期」也能清掉**（不只是 `finally`）：上游会**永不
   * resolve**（实测 `loomy` 的目录读取挂住）⇒ `.finally` 永不执行 ⇒ 标记永不清
   * ⇒ 后续所有 `listModels` 都不再起后台刷新 ⇒ 目录**永久冻在冷帧**且零报错。
   * 故起一轮时同时 arm 一份**放弃等待预算**
   * （{@link AGGREGATE_BACKGROUND_REFRESH_TIMEOUT_MS}），到期即清标记（保留旧值）。
   */
  private catalogRefreshInFlight = false
  /**
   * 在飞那一轮的**门票**（每次起轮自增）。
   *
   * ⚠️ 存在的唯一理由是**解决竞态**：被放弃的那一轮日后仍可能真的落地，而那时
   * 「在飞」的可能是**新的一轮**。若被放弃的那一轮在自己的 `finally` 里无条件清标记，
   * 就会把**新那一轮**的单飞闸门提前打开 ⇒ 又一次扇出。⇒ 只有「我这一轮仍是在飞
   * 那一轮」时才清。
   */
  private catalogRefreshTicket = 0
  /**
   * **按虚拟模型**缓存的候选序（键 = 虚拟模型 id）。
   *
   * ## 为什么需要它（规格 §9 要求，初版漏实现 ⇒ 死配置）
   *
   * `candidatesFor` 会对每个候选渠道 `await probe(...)` —— 那是一次**上游余额
   * GET**。而 `prepareCall` 是**每请求一次**（`dsh-llm/lib/index.js:1667`），
   * 于是 `auto` 最坏每轮要打十几次余额查询；而**旧的 `auto` 有 60 秒缓存**
   * （`auto-adapter.ts` 的 `AUTO_CHOICE_TTL_MS`）⇒ 新主路径反而**严格劣于**旧路径。
   *
   * ⚠️ 必须**按模型分别缓存**（规格 §9）：不同虚拟模型的候选表不同，共用一条会让
   * A 模型的候选序被 B 模型的请求覆盖。
   * ⚠️ 缓存的是**候选序**，不是「最终选中的渠道」—— 失败切换仍在同一次请求内
   * 逐个尝试（那是 `dispatch` 的事，与本缓存无关）。
   * ⚠️ 一分钟内临期时刻不会显著变化，故 60 秒 TTL 不破坏「临期优先」的语义。
   */
  private readonly choiceCache = new Map<string, { at: number; targets: DispatchTarget[] }>()

  /**
   * 「上次**实际**转发成功的渠道」——按虚拟模型分别记录（P3，供用量徽标显示）。
   *
   * ## ⚠️ 语义是**真实历史**，不是预测
   *
   * 只在**产出可见内容时**写入（= 这个候选真的成功了）。**不做预测**：
   * 预测的胜者可能因失败切换而实际未被使用，徽标显示一个错的渠道比不显示更误导。
   *
   * ## ⚠️ 纯内存、进程内
   *
   * 插件重启即清空 ⇒ 徽标「无历史 ⇒ 不渲染」（规格 §6.3 的 P4）。
   * ⚠️ **不落盘**：这是展示用的瞬时状态，写盘只会带来无谓的 IO 与陈旧值
   *（重启后显示一个早已不用的渠道，反而误导）。
   *
   * ⚠️ 与 `choiceCache` 的区别：那个缓存的是**候选序**（可预测），
   * 本表记录的是**实际结果**（已发生）——两者不可互相推导。
   */
  private readonly activeProviderByModel = new Map<string, string>()

  /**
   * 每个候选（`provider\0realId`）的**能力**缓存：窗口 / 档位 / 图片。
   *
   * ## 为什么需要它
   *
   * 窗口推导（{@link contextWindowFor}）与派发前的能力解析（{@link capabilityOf}）
   * 问的是**同一件事**，而两者都会被高频调用：
   * - DSH 的 `buildModelCatalog` 对**目录里每个模型**都调一次 `resolveModelInfo`
   *   （`dsh-api-session-controller/lib/index.js:506`）⇒ 窗口推导会在用户每次打开
   *   模型选择器时对全部虚拟模型的全部候选各问一次；
   * - `prepareCall` 每次请求都会对本次候选逐个解析能力。
   *
   * 没有缓存时同一份元数据会被反复解析（对**远端目录**类适配器是本地查表，
   * 但对目录尚未拉全的适配器会重试拉取）。缓存让两者共用一次结果。
   *
   * ## ⚠️ 只缓存**成功**的结果，绝不缓存失败
   *
   * 失败时 `capabilityOf` 返回保守默认值（无档位 / 不支持图片 / 无窗口）。
   * 把「这一次没问出来」缓存 60 秒会把**瞬时**故障固化成单向门 —— 那正是
   * 本仓库反复修过的缺陷形态（见 `AGENTS.md` 的「`refreshable` 单向门」）。
   * ⇒ 失败不写本缓存；**失败记录进 {@link capabilityFailureCache}，只有 30 秒**，
   * 见那里的注释（完全不缓存会让持续故障的候选每轮都被重试一遍）。
   *
   * ⚠️ 与目录同生命周期：{@link refreshCatalog} 重建目录时清空 —— 目录变了，
   *    「哪些候选存在」就变了，缓存必须跟着失效。
   */
  private readonly capabilityCache = new Map<string, CandidateCapability>()

  /**
   * **失败**的能力解析记录（`provider\0realId` → 失败时刻）。
   *
   * ## ⚠️⚠️ 为什么需要它（用户报障 2026-10-20 实测）
   *
   * 只有 {@link capabilityCache}（只存成功）时，候选池里**任何一个**持续故障的
   * 渠道都会让每一轮请求都重新等它超时：
   *
   * ```
   * 第1次 prepareCall = 16015 ms   第2次 = 8001 ms   第3次 = 8009 ms
   * contextWindowCache 命中? ★否 —— 永不记忆化
   * ```
   *
   * 而 `buildModelCatalog` 对目录里**每个虚拟模型**各调一次 `resolveModelInfo`
   * ⇒ 坏候选的代价被乘以虚拟模型数（实测 1/5/10 个 = 508/2551/5102 ms）。
   *
   * ## 与「不得缓存失败」的关系
   *
   * 本表**不是**把失败当成成功缓存：命中时返回的仍是 `resolved: false` 的保守值，
   * 且 TTL 只有 {@link AGGREGATE_CAPABILITY_FAILURE_TTL_MS}（30 秒，目录 TTL 的一半）。
   * 它解决的是「同一轮内反复问同一个坏候选」，不是「永远不再问」。
   *
   * ⚠️ **解析成功时立刻 `delete` 该键**：上游恢复后不必等 TTL 到期。
   * ⚠️ **中止（`isAbortLike`）不写本表**：中止不是「候选坏了」，写进去会让用户
   *    取消一次请求后，该候选在 30 秒内被当成故障候选（真实缺陷形态，见
   *    `capabilityOf` 的 catch 分支注释）。
   * ⚠️ 与目录同生命周期：{@link refreshCatalog} 重建目录时一并清空。
   */
  private readonly capabilityFailureCache = new Map<string, number>()

  /**
   * **在飞**的能力解析（`provider\0realId` → 该次解析的 Promise）。
   *
   * ## ⚠️⚠️ 为什么必须有它（2026-10-20 独立审计实测的重复扇出）
   *
   * {@link capabilityCache} 只在 `await` **之后**才写 ⇒ 同一拍的重复询问全部穿透：
   *
   * - 宿主 `buildModelCatalog` 对**每个虚拟模型**并行调 `resolveModelInfo`，而一个
   *   候选常常**同时**挂在多个虚拟模型下（同一个 realId 在多渠道归一成一个键）；
   * - `auto` 的池与具名模型的候选表**重叠**。
   *
   * 实测（18 渠道 × 40 模型、41 个虚拟模型并行）：**738** 次 `resolveModelInfo`
   * 调用、单候选最多被重复解析 **2** 次；改前（无封顶、无在飞合并）峰值 720。
   *
   * ⇒ 本表把「同一个候选的并发询问」合并成**一次**底层解析（`Promise` 共享）。
   * ⚠️ **不得缓存失败的 Promise**：`finally` 里无条件删（成功/失败都删），否则
   * 一次失败会像「失败短缓存」那样被固化 —— 那只由
   * {@link capabilityFailureCache} 按 30 秒显式控制。
   * ⚠️ 与目录同生命周期：{@link refreshCatalog} 一并清空（`Map.clear()` 只丢引用，
   * 已在飞的 Promise 仍会跑完并各自写 `capabilityCache`，无害）。
   */
  private readonly capabilityInFlight = new Map<string, Promise<CandidateCapability>>()

  /**
   * 每个虚拟模型（含 `auto`）的**窗口声明值**缓存。
   *
   * ⚠️ 判决结果是「候选集的最大值」，是个**纯函数**（同一份目录 + 同一份能力缓存
   * 必然得到同一个值）⇒ 记忆化不改变语义，只是避免每次 `resolveModel` 都重算。
   * ⚠️ 同样在 {@link refreshCatalog} 里清空（目录变了 ⇒ 候选集变了 ⇒ 最大值可能变）。
   * ⚠️ 值是 {@link ContextWindowEntry} 而不是裸 `number`：**退化判决**（有候选没解析
   * 成功）的 TTL 必须比正常判决短得多，见那里的注释。
   */
  private readonly contextWindowCache = new Map<string, ContextWindowEntry>()

  constructor(private readonly ctx: Context, private readonly options: AggregateAdapterOptions) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: '聚合（跨渠道临期优先）' }
  }

  /**
   * 该虚拟模型下被**拒绝轮换**的候选集合，键是 `` `${provider}\u0000${realId}` ``。
   *
   * ⚠️ 用 `\u0000` 作分隔符（不是 `:` 或 `/`）：provider id 与 realId 里都可能含
   * 冒号或斜杠（如 `cline-free/deepseek-v4.1-flash`），用它们会**误判**（把
   * `a/b` + `c` 与 `a` + `b/c` 拼成同一个键）。NUL 在两者里都不可能出现。
   */
  rejectedIn(canonicalId: string): ReadonlySet<string> {
    const table = this.options.rejections?.() ?? {}
    const byProvider = table[canonicalId]
    const out = new Set<string>()
    if (byProvider === undefined) return out
    for (const [provider, byRealId] of Object.entries(byProvider)) {
      for (const [realId, flag] of Object.entries(byRealId)) {
        if (flag === true) out.add(`${provider}\u0000${realId}`)
      }
    }
    return out
  }

  /**
   * 该虚拟模型下**实际应被拒绝**的候选集合（**含 D4 的 id 漂移降级**）。
   *
   * ## ⚠️ 为什么需要它（规格 §0.3 D4 + §1.9 + §5.1 的成文要求）
   *
   * 规格 §5.1 的判据表：
   * ```
   * 查 (虚拟模型, provider, realId) 是否有拒绝记录
   * ├─ 有精确匹配 → 拒绝该候选
   * ├─ 无精确匹配，但该 (虚拟模型, provider) 下有**任何**拒绝记录
   * │     且该记录对应的 realId **已不在当前候选中**（id 漂移）
   * │     → 降级为渠道级拒绝（该虚拟模型下该渠道全部候选都被拒），并记一条 warn
   * └─ 无记录 → 参与轮换
   * ```
   *
   * ## ⚠️ 不实现它的**真实后果**（规格 §1.9 记录的静默失效）
   *
   * `lobsterai` 的候选 id 会随「远端可用 / 兜底」切换：远端是 `deepseek-flash`
   *（真 V4.1 Flash），兜底表是 `deepseek-v4-flash`（更旧的型号）。
   * 若拒绝记录只锁 `realId`，**状态一翻转就匹配不上、静默失效** ——
   * 用户明确拒绝过的候选**悄悄复活**，而他以为还拒着。
   *
   * ⚠️ 降级判据是「该记录对应的 realId **已不在当前候选中**」——
   *    **不是**「没有精确匹配」（那样会把「同渠道的另一个候选没被拒」也降级掉，
   *    那是过度拒绝，方向相反的错误）。
   *
   * @param virtual - 当前的虚拟模型（用来知道该渠道眼下有哪些 realId）
   * @returns 应拒绝的 `provider\u0000realId` 集合（**已展开为渠道级**，若降级发生）
   */
  rejectedFor(virtual: { key: string; candidates: readonly { provider: string; realId: string }[] }): ReadonlySet<string> {
    const table = this.options.rejections?.() ?? {}
    const byProvider = table[virtual.key]
    const out = new Set<string>()
    if (byProvider === undefined) return out

    for (const [provider, byRealId] of Object.entries(byProvider)) {
      // 该渠道眼下有哪些 realId（用于判断「记录里的 id 是否已漂移走」）。
      const currentIds = new Set(
        virtual.candidates.filter((c) => c.provider === provider).map((c) => c.realId),
      )
      // ⚠️ 只把**当前候选里**被拒的那些放进返回集：
      //    已漂移走的旧 id 不该出现在返回集里（它匹配不到任何候选，留着只是噪音）。
      let hasExact = false
      for (const realId of currentIds) {
        if (byRealId[realId] === true) {
          out.add(`${provider}\u0000${realId}`)
          hasExact = true
        }
      }
      // 该渠道眼下没有候选 ⇒ 无从降级（不是漂移，是这个渠道眼下没候选）。
      if (currentIds.size === 0) continue
      // 该渠道**是否已有精确命中**：有的话漂移规则不适用（规格判据的「无精确匹配」前提）。
      if (hasExact) continue
      // 走到这里 = 该渠道在当前候选里**一条都没精确命中**。
      // 再看它是否有**任何** `true` 记录（那些 realId 都不在当前候选里 ⇒ 即漂移）。
      const hasDrifted = Object.entries(byRealId).some(([, flag]) => flag === true)
      if (!hasDrifted) continue
      // ⚠️ 只在「无精确命中 + 有记录漂移走」时降级为渠道级（规格 §5.1 的判据）。
      this.ctx.logger?.warn?.(
        `[aggregate] ${virtual.key} 下 ${provider} 的拒绝记录已漂移`
        + `（记录里的 realId 不在当前候选 ${JSON.stringify([...currentIds])} 中）`
        + `⇒ **降级为渠道级拒绝**（该渠道在这个虚拟模型下全部候选都被拒）。`
        + `⚠️ 若这是误判，请在设置页「聚合」面板的该模型子列表里重新打开它`
        + `（那会**清掉该渠道的全部拒绝记录**，含已漂移的旧 id，故降级随即解除）。`,
      )
      // ⚠️⚠️ **这里刻意**不做**任何状态写入**（真实教训）：
      //    我第一版让本方法「顺手把漂移的旧键迁移到当前 realId」——
      //    但本方法是**读取路径**（每次路由决策、每次面板刷新都调），
      //    在读操作里改状态会在面板刷新时产生莫名其妙的持久化写入，
      //    也让判据依赖于「有没有成功写盘」。⇒ 恢复能力改由**写路径**提供：
      //    `AccountPool.setAggregateRejected(..., false)` 在「重新打开」时会
      //    一并清掉该 (虚拟模型, 渠道) 下**全部**记录（含漂移的旧 id）
      //    ⇒ 表里既无精确命中也无漂移记录 ⇒ 降级自然解除。
      //    见 `src/account-pool.ts` 的长注释与 `tests/unit/aggregate-rejections.spec.ts`。
      for (const realId of currentIds) out.add(`${provider}\u0000${realId}`)
    }
    return out
  }

  /**
   * 清空选型缓存。
   *
   * ⚠️ **改了拒绝表之后必须调它**：`choiceCache` 的 TTL 是 60 秒，而面板上的开关
   * 是「立刻生效」的语义 —— 不清缓存的话，用户在面板上关掉的候选在 60 秒内仍会被
   * 尝试（用户会以为开关坏了）。RPC 的 `aggregate.setRejected` / `clearRejected`
   * 负责调用。
   */
  clearChoiceCache(): void {
    this.choiceCache.clear()
  }

  /**
   * 清空**临期折算缓存**（领取成功后由 RPC 调用）。
   *
   * ## ⚠️⚠️ 为什么领取之后必须清（真实缺陷，对抗审计实测证伪，2026-10-07）
   *
   * 折算缓存**也缓存 `UNUSABLE`**，而 `zcodeExpiry` 现在把「余额为 0」判成
   * `UNUSABLE`（修掉「额度已尽仍被 auto 选中」的真实缺陷）。zcode 的每日赠送额度
   * **要先领取才进 `balances` 桶** ⇒ 「先撞额度尽（写 `UNUSABLE`）→ 去签到 → 立刻用
   * auto」时，**最长 60 秒内 auto 仍说没有候选**，用户会以为签到没用。
   *
   * ⚠️ 已有的两个清理入口（`pool.onAccountAdded` / 拒绝表变更）**都不覆盖领取**。
   *
   * ⚠️ 必须清**共享的**那一份探针（装配层 `src/index.ts` 把同一个实例同时给
   * aggregate 与 auto）—— 只清一份会让 auto 仍看到旧的 `UNUSABLE`。
   * 故这里清的是注入进来的 `options.expiryProbe`（与 auto 同一个对象）。
   */
  clearExpiryCache(): void {
    // ⚠️ 类型是 `ExpiryProbe`（不含 `clear`），故按结构化判据探测 ——
    //    单测注入的替身通常没有 `clear`，那时静默跳过（不报错）。
    const probe = this.options.expiryProbe as { clear?: () => void } | undefined
    probe?.clear?.()
  }

  /**
   * 「上次**实际**转发成功的渠道」（P3，供用量徽标）。
   *
   * ⚠️ **纯内存读、零网络零余额查询** —— 徽标在**门控阶段**就要拿到它
   *（规格 §6.3 的 P2：重定向必须发生在门控之前），查网络会让外层渲染抖动。
   *
   * @param canonicalId - 虚拟模型 id。**省略时返回「最近一次任意虚拟模型的转发渠道」**
   *   （规格 §8.4：徽标只关心「当前在跑的是哪个渠道」，不必区分模型）。
   *   实现上「最近一次」取 `Map` 的**最后一个插入项** —— 但 `Map` 的迭代顺序是
   *   **插入顺序**而非「最近写入顺序」（覆盖已存在的键**不改变**其位置）。
   *   ⚠️ 故这里**显式维护一个「最近写入」指针**，而不是依赖迭代顺序
   *   （否则「切回一个之前用过的渠道」时顺序会错，徽标显示旧渠道）。
   * @returns 渠道 id；无历史时 `null`（调用方据此**不渲染**徽标）。
   */
  activeProvider(canonicalId?: string): string | null {
    if (typeof canonicalId === 'string' && canonicalId.length > 0) {
      return this.activeProviderByModel.get(canonicalId) ?? null
    }
    return this.lastActiveProvider
  }

  /** 最近一次（任意虚拟模型）实际转发成功的渠道；无历史时 `null`。 */
  private lastActiveProvider: string | null = null

  /**
   * 「按临期排序」用的候选到期时刻（面板的可选按钮，用户 2026-10-07 选定方案 C）。
   *
   * ## ⚠️⚠️ 这是**唯一**会做余额探测的面板端点 —— 且**只在用户显式点击时**调用
   *
   * 为什么必须单独一个方法而不是给 `describeCatalog` 加参数：那个方法的契约是
   * **零余额查询**（规格 §8.3，且有专门用例断言 `expiryProbe` 零调用）。
   * 面板一打开就打十几次上游请求是不可接受的；而「按临期排序」**必须**探测才知道顺序。
   * ⇒ 两者分开：默认零探测，用户点按钮才走这里。
   *
   * ## 为什么需要它（用户报障）
   *
   * 面板标题写「临期优先」，但候选列表来自 `aggregate-catalog.ts` 的
   * `candidates.sort(...)` —— 那是按 `provider` **字母序**
   * （用户原话：「codearts 的 4.1 flash 没有显示在最后」）。
   * ⇒ 标题与列表**矛盾**（面板没说真话）。
   *
   * ## 返回形状
   *
   * `{ <provider>: expiry }` —— 按渠道去重（同一渠道的多个候选共享一次探测，
   * 与 `candidatesFor` 的 `seen` 表同一口径，避免重复打上游）。
   * ⚠️ 探测失败（`UNUSABLE`）也如实返回该值，由客户端决定怎么显示/排序
   *（`sortCandidatesByExpiry` 把非有限值排最后）。
   *
   * ⚠️ **只读**：不改拒绝表、不写缓存、不落盘。
   *
   * @param force - `true` 时绕过探针自己的折算缓存（`EXPIRY_CACHE_TTL_MS` 60 秒）。
   *   面板的「每 5 分钟自动重探」与用户手动点击都传 `true`（那两种情形要的是**新鲜**值）；
   *   进入模式时那次传 `false`（省一次上游请求）。
   */
  async describeExpiryOrder(signal?: AbortSignal, force = false): Promise<Record<string, number>> {
    await this.ensureCatalog()
    signal?.throwIfAborted()
    const probe = this.expiryProbe()
    // ⚠️ 探针的缓存失效入口是**可选**的（`ExpiryProbeWithCache.clear`）：单测注入的替身
    //    没有它 ⇒ 用可选链。⚠️ 缺 `clear` 时**静默不生效**而不是报错：`force` 只是
    //    「尽量拿新鲜值」的优化，不该因为替身没有缓存而让面板报错。
    if (force) (probe as { clear?: () => void }).clear?.()
    const out: Record<string, number> = {}
    // ⚠️ 按渠道去重：同一渠道在多个虚拟模型下重复出现，只探一次。
    for (const virtual of this.catalog) {
      for (const candidate of virtual.candidates) {
        // ⚠️ **只探「已接入临期折算」的渠道** —— 这是**刻意**的，不是漏改（2026-10-15 复核）：
        //    未接入的渠道**没有折算原语可调**，探测它只会白打一次上游请求，而结果
        //    必然是 `UNUSABLE`（`credentialExpiry` 对未接入渠道短路返回 `UNUSABLE`）。
        //
        // ⚠️ 它**不是**「第 4 个漏改的可见性过滤点」：本方法只影响面板的**排序展示**
        //   （「按临期排序」模式下给候选算位次），不决定任何东西的**可见性** ——
        //    手工打开的未接入候选在**手工模式**下由手工位次排序，**不需要**临期值
        //   （见 `manualRankOf`：未排过的尾巴回落 `NEVER`，与这里的跳过自洽）。
        if (!WIRED_EXPIRY_PROVIDERS.includes(candidate.provider)) continue
        if (Object.hasOwn(out, candidate.provider)) continue
        signal?.throwIfAborted()
        try {
          out[candidate.provider] = await probe(candidate.provider, signal)
        } catch (error) {
          // ⚠️ **中止不得被吞成默认值**（与 `candidatesFor` 同一口径）：
          //    用户取消时应该立刻以 AbortError 结束，而不是把每个渠道都记成
          //    「查不到」后返回一份全错的有序表。
          if (isAbortLike(error, signal)) throw error
          out[candidate.provider] = UNUSABLE
        }
      }
    }
    return out
  }

  /**
   * 组装给设置面板的目录（**只读、零余额查询**，规格 §8.3）。
   *
   * ⚠️⚠️ **不得调用 `expiryProbe` / `resolveModelInfo`** —— 面板一打开就会对每个
   * 渠道打一次上游请求；而本端点只回答「有哪些虚拟模型、各自有哪些候选、哪些被拒」，
   * 与余额无关。实时余额仍由各渠道自己的面板负责。
   *
   * ⚠️ 「按临期排序」需要探测 ⇒ 它走**单独的** {@link describeExpiryOrder}，
   * 不在这里加参数（那会破坏本方法的零查询契约，且有专门用例断言）。
   *
   * ⚠️ 也**不得**改动拒绝表（纯读）。
   *
   * @param force - **绕过目录 TTL 缓存**（面板的「刷新」按钮用）。
   *   ⚠️ 真实缺陷（对抗审计实测证伪）：初版**不传 force**，而 `refreshCatalog` 有
   *   60 秒缓存 ⇒ 面板的「刷新」按钮实际是「读缓存」，用户在渠道侧新增/关闭模型后
   *   点刷新**看不到任何变化**，会以为聚合坏了。同时 `refreshCatalog` 的 `force`
   *   参数在**全仓零调用点**（死参数）—— 两处都是这条缺陷的一部分。
   *   ⚠️ 只有**用户显式点刷新**时才传 `true`：`listModels` 等高频路径必须继续走缓存，
   *   否则每次打开模型选择器都会重推整个目录。
   */
  async describeCatalog(force = false, signal?: AbortSignal): Promise<{
    models: Array<{
      canonicalId: string
      name: string
      candidates: Array<{
        provider: string
        realId: string
        realName: string
        price: number
        viaPatch: boolean
        rejected: boolean
        state: CandidateGate
        expiryWired: boolean
      }>
      order: string[]
    }>
    orderMode: 'expiry' | 'manual'
  }> {
    const catalog = await this.refreshCatalog(force, signal)
    const models = catalog.map((virtual) => {
      // ⚠️ 用 `rejectedFor`（含 D4 的 id 漂移降级）的**信息**，但三态判定统一走
      //    `gateOf`（唯一判据）—— 两者读的是同一张拒绝表，`gateOf` 内部用
      //    「该键在不在降级后的集合里」表达，故不会出现第二套判据。
      const rejected = this.rejectedFor(virtual)
      // ⚠️⚠️ **不得过滤掉「未接入临期折算」的候选**（用户 2026-10-15 的诉求 IKL7F9）。
      //
      // ## 这条过滤曾经存在，为什么删掉
      // 升级前这里有一条 `WIRED_EXPIRY_PROVIDERS.includes(candidate.provider)` 的过滤，
      // 理由是「面板不该显示一个永远不会被用的渠道」（2026-10-07 用户报障）。
      // 现在**语义变了**：那些候选**可以**被手工打开并真的参与轮换（赋 `NEVER`，
      // 见 `candidatesFor`）⇒ 把它们藏起来会让用户在面板里**找不到它们**，
      // 「手工打开」这个功能就无从操作（issue IKL7F9 的诉求本身就是「让它们进聚合」）。
      //
      // ⚠️ 那条「面板在撒谎」的顾虑由**三态**承担：每条候选带 `state`，未接入且未打开的
      //    候选显示为「无临期积分 · 默认不参与」—— 面板依然**说真话**，只是把选择权交给用户。
      const candidates = virtual.candidates.map((candidate) => {
        const state = this.gateOf(virtual.key, candidate.provider, candidate.realId, rejected)
        return {
          provider: candidate.provider,
          realId: candidate.realId,
          realName: candidate.realName,
          price: candidate.price,
          // ⚠️ 面板据此标 `⚠️补丁`（规格 §7.1）—— 补丁条目是人工核查的重点。
          viaPatch: candidate.via === 'patch',
          // ⚠️ 语义收窄：本字段现在等于「当前不参与轮换」（含默认不参与）。
          rejected: state !== 'allowed',
          state,
          expiryWired: WIRED_EXPIRY_PROVIDERS.includes(candidate.provider),
        }
      })
      // ⚠️ 手工顺序**按当前候选集过滤**后下发：顺序表里可能留着 id 漂移的脏键
      //（该渠道的模型改了名/下架了），把它发给客户端会让拖拽列表出现幽灵条目。
      const currentKeys = new Set(candidates.map((c) => `${c.provider}\u0000${c.realId}`))
      const order = (this.options.order?.() ?? {})[virtual.key]?.filter((key) => currentKeys.has(key)) ?? []
      return {
        canonicalId: virtual.key,
        name: this.nameOf(virtual),
        candidates,
        order,
      }
    })
    // ⚠️ `orderMode` **由宿主下发**（不是让客户端从「顺序表非空」推导：用户可以切到
    //    手工模式却一条都没拖过 ⇒ 面板会显示成「按临期」，与宿主实际用的一致但**不是
    //    用户选的那个**，下次切换就会「跳」）。
    return { models, orderMode: this.options.orderMode?.() === 'manual' ? 'manual' : 'expiry' }
  }

  /**
   * 某条候选当前的三态门控（**唯一判据**，同步、零网络：只读注入的三张表）。
   *
   * ⚠️⚠️ **只有这一处实现**：`describeCatalog` 下发 `state`、`pickerNameOf` 统计
   * 「当前参与」的价格，都调它。两处各写一遍判据必然漂移（本仓库有过「同一文件
   * 两套同义判据」的缺陷史）。
   *
   * ⚠️ `WIRED_EXPIRY_PROVIDERS` 的引用也**只在此一处**（`candidatesFor` 的建池过滤
   * 同样走本方法）⇒ 「谁的默认态是什么」这个问题全仓只有一个答案。
   *
   * @param degraded - 省略时内部算（`rejectedFor`）。传入可让调用方在循环里复用
   *   同一次降级计算（`describeCatalog` 对每个虚拟模型算一次，避免每候选重算）。
   */
  private gateOf(
    canonicalId: string,
    provider: string,
    realId: string,
    degraded?: ReadonlySet<string>,
  ): CandidateGate {
    const rejectedSet = degraded
      ?? this.rejectedFor({
        key: canonicalId,
        candidates: [{ provider, realId }],
      })
    return resolveCandidateGate({
      // ⚠️ 用**降级后**的集合（D4：渠道级拒绝也算该候选被拒）。
      rejected: rejectedSet.has(`${provider}\u0000${realId}`),
      allowed: (this.options.allowed?.() ?? {})[canonicalId]?.[provider]?.[realId] === true,
      expiryWired: WIRED_EXPIRY_PROVIDERS.includes(provider),
    })
  }

  /**
   * 聚合路由状态的**内容指纹**（参与 `choiceCache` 的键，见 `candidatesFor`）。
   *
   * ⚠️ **四项缺一不可**（用户 2026-10-15 起：拒绝表 + 白名单 + 手工顺序表 + 排序模式）：
   * 任何一项变了，缓存里的候选序（含**次序**）都不再成立。漏一项的症状是
   * 「用户改了门控/顺序，随后最多 60 秒内仍按旧的走」—— **静默**（用户会以为开关坏了）。
   *
   * ⚠️ 拒绝表与白名单用**排序后的拼接**（与键的书写顺序无关：同一集合的不同书写顺序
   * 是同一张表，不该导致缓存失效）；顺序表**不能**排序（它的**顺序本身就是语义**）；
   * 模式直接拼接。
   *
   * ⚠️ 不要改成「条目数」之类的摘要：本仓库有过「缓存失效判据按数组长度」被实测证伪的
   * 教训（两条不同内容长度相同 ⇒ 恒不失效）。
   */
  private routingFingerprint(): string {
    const enabledKeys = (table: Record<string, Record<string, Record<string, boolean>>>): string[] => {
      const parts: string[] = []
      for (const [canonicalId, byProvider] of Object.entries(table)) {
        for (const [provider, byRealId] of Object.entries(byProvider)) {
          for (const [realId, flag] of Object.entries(byRealId)) {
            if (flag === true) parts.push(`${canonicalId}\u0000${provider}\u0000${realId}`)
          }
        }
      }
      return parts.sort()
    }
    const order = this.options.order?.() ?? {}
    // ⚠️ 顺序表按**键**排序后拼接（不同模型的书写顺序无关），但**每个模型的数组保持原序**
    //   （那才是语义）。
    const orderParts = Object.keys(order).sort().map((key) => `${key}=${order[key]!.join(',')}`)
    return [
      enabledKeys(this.options.rejections?.() ?? {}).join('\u0001'),
      enabledKeys(this.options.allowed?.() ?? {}).join('\u0001'),
      orderParts.join('\u0002'),
      this.options.orderMode?.() === 'manual' ? 'manual' : 'expiry',
    ].join('\u0003')
  }

  /**
   * 手工位次函数：`orderMode === 'manual'` 且该模型**有**顺序表时给出，否则 `undefined`
   *（⇒ `rankCandidates` 走临期序）。
   *
   * ⚠️ `auto` **恒为 `undefined`**（用户 2026-10-15 的取舍 Q6=C）：`auto` 的池是跨全部渠道的
   *    巨池，「手工顺序」在那里没有可解释的含义 —— 用户拖的是**某个虚拟模型**的候选。
   *
   * ⚠️ 未排在数组里的候选返回 `undefined` ⇒ `rankCandidates` 把它们按
   *    **临期↑ → 倍率↑** 追加在已排过的**之后**（新增候补因此不会消失）。
   */
  private manualRankOf(model: string): ((candidate: RankedCandidate) => number | undefined) | undefined {
    if (model === AGGREGATE_AUTO_MODEL) return undefined
    if (this.options.orderMode?.() !== 'manual') return undefined
    const order = (this.options.order?.() ?? {})[model]
    if (order === undefined || order.length === 0) return undefined
    const rank = new Map<string, number>()
    // ⚠️ 只认**第一次**出现：数组理论上已由服务端去重（`sanitizeAggregateOrder` 与
    //    `AccountPool.setAggregateOrder` 都去重），这里是**纵深防御** —— 重复位次会让
    //    比较器非确定（同一候选有两个名次），而 `sort` 的非确定行为极难复现。
    for (const [index, key] of order.entries()) if (!rank.has(key)) rank.set(key, index)
    return (candidate) => rank.get(`${candidate.provider}\u0000${candidate.realId}`)
  }

  /**
   * 重新推导虚拟模型表（**带 TTL 缓存**，理由见 {@link AGGREGATE_CATALOG_TTL_MS}）。
   *
   * ⚠️ 逐个渠道 `try/catch`：某一个渠道目录读取失败**不得**让整个聚合目录变空
   * （那会让用户在别的渠道都正常时突然看不到任何模型）。
   *
   * @param force - 绕过缓存（设置页手动刷新用）。
   */
  async refreshCatalog(force = false, signal?: AbortSignal): Promise<VirtualModel[]> {
    const now = this.options.now?.() ?? Date.now()
    // ⚠️ TTL **是 aggregate 自己的既有配置**（默认 {@link AGGREGATE_CATALOG_TTL_MS}
    //    = 60s，`options.catalogTtlMs` 可覆盖），**不是**各渠道的 20 分钟
    //    （`CATALOG_REFRESH_INTERVAL_MS`）—— 两者是不同的量，不要顺手改。
    //    `catalogAt === 0`（从未成功推导过）由 `isCatalogFresh` 恒判陈旧，
    //    与原先的 `this.catalogAt !== 0` 一格等价。
    //
    // ⚠️ 用 `isCatalogFreshFor(AGGREGATE_PROVIDER, …)`（多一个**正交**的「用户主动
    //    失效」输入）。⚠️⚠️ **准确的因果（2026-10-19 复审订正 —— 别在这里写
    //    「用户在面板改拒绝表 ⇒ 这个聚合目录要立刻重推」**不成立**，那句话是错的：
    //    本函数下游只有 `buildVirtualModels(catalogs)`（`aggregate-catalog.ts`），
    //    而它**只读各渠道目录的 `id` / `name` 与归一映射** ⇒ **完全不读拒绝表、
    //    白名单、顺序表、排序模式** ⇒ 当前实现下改这三张表，推导结果逐字节相同。
    //    这一腿是**语义对齐 / 兜底**：保持「凡是写入目录或门控相关表的端点都失效」
    //    这条规则不破例（见 `jet-hub-rpc.ts` import 处的规则注释），万一将来
    //    `buildVirtualModels` 真的依赖了它们，这里**已经**是对的。
    //    ⇒ 那三张表**真实**影响的是 `gateOf` / `rejectedFor`、`pickerNameOf` /
    //      `isAllDefaultsUnopened`（都每次现算、无缓存）与 `routingFingerprint()`；
    //      「改表 ⇒ 候选序缓存失效」的**真实**机制是 `clearChoiceCache()`
    //      （正确性另有 `routingFingerprint()` 兜底，见 `candidatesFor`）。
    //    ⚠️ **不得**改成「失效全部渠道」：那会让改一个开关连带作废其余 11 家的
    //    目录缓存（用户改一个开关却付出十几个上游请求）。
    //    ⚠️ 刻意**不**把 `this.catalogAt` 置 0：那个字段另有第三个读者
    //    `catalogReadyForBulkWrite`（判 `catalogAt === 0` 为「从未成功推导过」的冷帧）
    //    ⇒ 置 0 会让「改完面板开关马上点『关闭聚合供应商』」被误拒。
    if (!force && isCatalogFreshFor(
      AGGREGATE_PROVIDER,
      this.catalogAt,
      now,
      this.options.catalogTtlMs ?? AGGREGATE_CATALOG_TTL_MS,
    )) {
      return this.catalog
    }

    // ⚠️ **中止必须在最前面查**（真实缺陷，对抗审计实测证伪 —— 这是同型缺陷的**第四处**）：
    //    本函数原先**没有 `signal` 形参**，逐渠道 `catch` 吞掉**一切**错误
    //   （含 `AbortError`），随后**仍然** `this.catalogAt = now` ⇒ **截断的目录被缓存
    //    60 秒**。后果：用户取消一次请求后，被取消的那个渠道会**从聚合目录里消失
    //    60 秒**，而理由是「读取 xxx 目录失败」—— 与「用户主动取消」完全无关，
    //    且与「该渠道真的没登录」无法区分。
    //    ⚠️ 与模块头铁律一致：「中止 **立刻抛 `AbortError`**，绝不折算」。
    signal?.throwIfAborted()

    const providers = this.providerIds()
    const catalogs: Record<string, readonly { id: string; name?: string }[]> = {}
    for (const provider of providers) {
      try {
        // ⚠️ `LlmRuntime.listModels(provider)` 只接受一个参数、**没有 signal 通道**
        //   （`dsh-llm/lib/index.js:1471`），故无法把 signal 透传下去；中止靠
        //    下面 catch 里的 `isAbortLike` 与循环开头的 `throwIfAborted` 兜住。
        catalogs[provider] = await this.ctx.llm.listModels(provider)
      } catch (error) {
        // ⚠️ **中止不得被吞成 warn**（本函数此前正是这样：把「用户取消」记成
        //    「读目录失败」并继续，且把截断结果缓存 60 秒）。
        signal?.throwIfAborted()
        if (isAbortLike(error, signal)) throw error
        this.ctx.logger?.warn?.(
          `[aggregate] 读取 ${provider} 目录失败，本次跳过该渠道：${String(error)}`,
        )
      }
      signal?.throwIfAborted()
    }
    // ⚠️⚠️ 这里**曾经**有一条 `WIRED_EXPIRY_PROVIDERS` 过滤，已于 2026-10-15 **删除**
    //（本 PR，用户诉求 IKL7F9）。**不要再加回来**，理由如下：
    //
    // ## 它原来在挡什么
    // 目录会推导出「候选全来自未接入临期折算渠道」的虚拟模型，而那些候选一律被折算成
    // `UNUSABLE` ⇒ 用户选中它拿到的是
    //   `MISSING_CREDENTIAL | 「xxx」当前没有任何可用候选…`
    // 即把「该渠道的折算尚未实现」**谎报成**「你没登录 / 渠道被关」。
    //
    // ## 为什么现在可以删
    // ① **判据已恒真**：`providerIds()`（见其注释）返回 `AGGREGATE_CHANNELS ∩ 存活路由`
    //    ⇒ 每条候选的 `provider` 必然在 `AGGREGATE_CHANNELS` 内 ⇒ 换成渠道全集即恒 `true`
    //   （即「按渠道全集过滤」= 什么都不做）。
    // ② **它让用户点不动**：未接入渠道的**独有模型**会被这条过滤**整条剔掉** ⇒
    //    用户在面板里手工打开候选后，模型选择器里**仍然看不到它**，「打开」看起来毫无效果。
    // ③ **误导性报错已由两条正路解决**（此时更该让用户看见它）：
    //    - 面板对「全部候选未参与轮换」给出**显式提示**（含「无临期积分 · 默认不参与」这一新原因）；
    //    - 请求失败文案补上第 4 种原因，并指向**真实存在**的面板（见 `stream` 的
    //      `targets.length === 0` 分支）。
    //
    // ⚠️⚠️ **不得改成「至少一个候选当前参与轮换」**：那会让「用户把某模型的候选全部拒绝」
    //    把该模型**从选择器里移除**，而 `jet-hub-store.ts`（`AggregateRejectionMap` 上方那段）
    //    与面板的 `isAllCandidatesRejected` 都**明文要求**「候选全被拒 ≠ 关闭模型，
    //    它仍在目录里，请求时如实报错」。⇒ **目录身份必须与用户门控无关**
    //   （`this.catalog` 也因此保持稳定，`provider.status` 的 `total` 不随用户点击漂移）。
    //
    // ⚠️ `auto` **不参与**任何过滤（它不在 `this.catalog` 里，由 `listModels` /
    //    `listAllModels` 单独合成）。
    //
    // ⚠️ 先记下**上一次**推导出的全量目录（下面的判据要用它判断「用户关的是整个 provider」）。
    const previousIds = [AGGREGATE_AUTO_MODEL, ...this.catalog.map((m) => m.key)]
    const derived = buildVirtualModels(catalogs)
    // ⚠️ 判断「目录是否真的变了」用的是**推导结果**而不是「这次是否真读了上游」
    //   （`refreshCatalog` 也会被 `force` 或 TTL 过期触发，而重推的可能是同一份目录）。
    const changed = !this.sameCatalogAs(derived)
    this.catalog = derived
    this.catalogAt = now
    // ⚠️⚠️ **目录变了 ⇒ 能力缓存与窗口缓存必须一起失效**（与目录同生命周期）。
    //
    // 为什么不能留着：
    // - 窗口缓存的键是虚拟模型 id，而**候选集会变**（登录/登出渠道、用户黑名单、
    //   上游下架模型都会改候选表）⇒ 留着旧值会让 `aggregate/deepseek-v4-1-flash`
    //   一直按「当时那批候选的最大值」声明，即使后来只挂了一个窗口更小的候选；
    // - 能力缓存的键是 `provider\0realId`，**跨目录也仍然指向同一个真实模型**，
    //   但它记录的是「上一次解析时远端下发的能力」。上游改窗口（或某次解析赶在
    //   远端目录就绪之前、拿到了较旧的值）同样需要重取一次。
    // 两者都是「几十到几百条小对象」，整表清空的开销可以忽略，而漏清的代价是
    // 用户看到的窗口与压缩阈值**长期错误**（本适配器刚修的就是这类缺陷）。
    this.capabilityCache.clear()
    this.contextWindowCache.clear()
    this.capabilityFailureCache.clear()
    this.capabilityInFlight.clear()
    // ⚠️⚠️ **维持「整个 provider 已关闭」的语义**（真实缺陷，实测复现）。
    //
    // ## 机制（本适配器的**动态目录**与宿主「一键关闭」的**快照**假设相撞）
    //
    // 宿主的「供应商一键关闭」（`jet-hub-rpc.ts` 的 `provider.setEnabled`）把**当时的**
    // 全量目录 id 写进黑名单；而 `provider.status` 的判据是
    // `closed = total > 0 && disabled === total`，`total` 取自 `listAllModels()`。
    //
    // ⚠️ 对**其余 14 家**，目录是**固定**的 ⇒ 「写一次快照」永远成立；
    //    而本适配器的目录是**动态推导**的（登录新渠道就长出新的虚拟模型）
    //    ⇒ 旧黑名单**盖不住**新模型 ⇒ `disabled < total` ⇒
    //    **开关自动翻回「已打开」**，且新模型**可被选中**（用户明明关了聚合）。
    //
    // 实测（探针，修前）：
    // ```
    // ① 关闭 ⇒ 黑名单 [auto, deepseek-v4-1-flash]，status {total:2,disabled:2,closed:true}
    // ② 登录 codearts ⇒ 目录 [auto, deepseek-v4-1-flash, glm-5-3]
    //    status {total:3,disabled:2,closed:false} ⇒ 开关显示「已打开」   ← 缺陷
    // ③ aggregate.listModels() 播报 ["glm-5-3"]                       ← 泄漏
    // ```
    //
    // ## 判据（只在「整个 provider 已关闭」时补写）
    //
    // 「整个 provider 已关闭」= 黑名单非空，**且**它覆盖了**上一次**推导出的全量目录
    //（`previousIds` 里每个 id 都被标记为关闭）。那说明用户关的是**整个 provider**。
    //
    // ⚠️ **不得无条件补写**：
    //   - 用户从未关闭过（黑名单为空）⇒ 凭空补写会**静默关闭整个 provider**（灾难且难察觉）；
    //   - 用户只是**逐个**关了某几个模型（黑名单没覆盖上快照）⇒ 不该被升级成整 provider 关闭。
    //
    // ⚠️⚠️ **必须 `await`**（2026-11-05 三审并发 P2-1）。原实现是
    // fire-and-forget（`void writeDisabled(...).catch(...)`），于是「读黑名单
    // → 算 missing → 写黑名单」这三步与用户操作**交错**：用户在看到补写完成前
    // 打开某个聚合模型，会被这次补写**重新关掉**（窗口秒级，且无任何提示）。
    // 代价是目录返回晚一次写盘（`setModelsDisabled` 走池的串行队列）；
    // 正确性优先 —— 用户报障的正是「开关状态自己变」。
    await this.maintainProviderClosedState(previousIds)
    // ⚠️⚠️ **目录落地后必须广播**（与其余 12 家适配器的 `onCatalogLoaded` 同一口径）。
    //
    // 不广播的后果（本条修的就是它）：客户端 `ModelCatalogDirectory` 在
    // `status === 'ready'` 时**短路返回缓存**，只认四个宿主事件；而 Task 7 之后
    // 后台那一轮刷新是**异步落地**的（不在任何一次 `listModels` 的调用栈上）⇒
    // 无论它多久落地，客户端都**不会**自动重读 ⇒ 用户必须自己再开一次选择器才能
    // 看到虚拟模型。成因与唯一实现见 `catalog-broadcast.ts`。
    //
    // ⚠️ **只在目录真的变了时广播**：`refreshCatalog` 也会被 TTL 过期或 `force`
    // 触发，而重推的往往是同一份目录 —— 每轮都广播会让客户端反复重读（广播风暴）。
    if (changed) this.onCatalogLanded()
    return this.catalog
  }

  /**
   * 通知「目录已落地」——**唯一**出口（`broadcastCatalogChanged` 与 12 家适配器同源）。
   *
   * ⚠️ **失败只记日志**：目录已经写好了，因通知失败而抛错会让调用方
   *（`listModels` 的宿主路径）以为目录加载失败 —— 与 `catalog-broadcast.ts`
   * 自己的约定、以及 `jet-hub-rpc.ts` 的「通知失败不能反噬已落盘的开关」同一条。
   */
  private onCatalogLanded(): void {
    try {
      this.options.onCatalogLanded?.()
    } catch (error) {
      this.ctx.logger?.warn?.(`[aggregate] 广播目录变更失败（目录已落地，不影响可用性）：${String(error)}`)
    }
  }

  /**
   * 两份推导结果是否**逐条相同**（判定「目录真的变了」用）。
   *
   * ⚠️ 判据必须比到**候选表**，不能只比虚拟模型 id 的数量：候选增减（用户新登录
   *    一个渠道、某渠道下架了一个 realId）同样改变目录语义，而 id 集合可能不变。
   * ⚠️ 顺序也要比：`buildVirtualModels` 的结果顺序是**稳定**的（候选数降序、
   *    同数按 key 升序）⇒ 同内容必然同序；不同序即不同内容。
   */
  private sameCatalogAs(next: readonly VirtualModel[]): boolean {
    if (next.length !== this.catalog.length) return false
    for (let i = 0; i < next.length; i += 1) {
      const a = next[i]!
      const b = this.catalog[i]!
      if (a.key !== b.key || a.name !== b.name) return false
      if (a.candidates.length !== b.candidates.length) return false
      for (let j = 0; j < a.candidates.length; j += 1) {
        const ca = a.candidates[j]!
        const cb = b.candidates[j]!
        if (ca.provider !== cb.provider || ca.realId !== cb.realId) return false
        if (ca.realName !== cb.realName || ca.price !== cb.price || ca.via !== cb.via) return false
      }
    }
    return true
  }

  /**
   * 若聚合 provider 处于「整个已关闭」态，则把**新增的**虚拟模型补进黑名单。
   *
   * ⚠️ 详见 {@link refreshCatalog} 末尾的长注释：这是为了弥补宿主
   * 「一键关闭写快照」与「聚合目录动态推导」之间的语义缺口。
   *
   * @param previousIds - **上一次**推导出的全量目录（含 `auto`）——
   *   用它判断「用户关的是整个 provider」而不是逐个关了某几个模型。
   */
  private async maintainProviderClosedState(previousIds: readonly string[]): Promise<void> {
    // ⚠️ **防御性取值**：`listDisabledModels` 是 `AccountPool` 的方法，而单测的池桩
    //    往往只实现被测到的那几个（`disabledModelsFor` / `getAvailableAccount`…）。
    //    这里缺方法时**直接跳过**（而不是抛）—— 否则本方法会把 67 条既有用例全打红
    //    （实测：`TypeError: this.options.accountPool.listDisabledModels is not a function`）。
    //    ⚠️ 语义上也正确：拿不到黑名单就无从判断「是否整 provider 关闭」，
    //    保守地什么都不做（不写任何状态）。
    const readDisabled = (this.options.accountPool as {
      listDisabledModels?: (provider: string) => Record<string, boolean>
    }).listDisabledModels
    if (typeof readDisabled !== 'function') return
    const disabled = readDisabled.call(this.options.accountPool, AGGREGATE_PROVIDER)
    // 从未关闭过 ⇒ 什么都不做（凭空补写会静默关闭整个 provider）。
    const hasAnyDisabled = Object.values(disabled).some((flag) => flag === true)
    if (!hasAnyDisabled) return
    // ⚠️ 关键判据：上一次的全量目录**是否全被标记为关闭**。
    //    是 ⇒ 用户关的是**整个 provider** ⇒ 新长出来的模型也要补上。
    //    否 ⇒ 用户只是逐个关了某几个模型 ⇒ 不碰（不该升级成整 provider 关闭）。
    const closedWholeProvider = previousIds.length > 0
      && previousIds.every((id) => disabled[id] === true)
    if (!closedWholeProvider) return
    // 本次**新增**的（尚未被标记的）模型。
    const missing = [AGGREGATE_AUTO_MODEL, ...this.catalog.map((m) => m.key)]
      .filter((id) => disabled[id] !== true)
    if (missing.length === 0) return
    // ⚠️ 同理防御：写方法也来自池，缺了就跳过。
    const writeDisabled = (this.options.accountPool as {
      setModelsDisabled?: (provider: string, ids: readonly string[]) => Promise<void>
    }).setModelsDisabled
    if (typeof writeDisabled !== 'function') return
    // ⚠️ 失败只记 warn（下次目录推导会再试），但**必须 `await`**：
    // 不 await 时「读黑名单 → 算 missing → 写黑名单」会与用户操作交错，
    // 把用户刚打开的模型重新关掉（2026-11-05 三审并发 P2-1）。
    try {
      await writeDisabled.call(this.options.accountPool, AGGREGATE_PROVIDER, missing)
    } catch (error: unknown) {
      this.ctx.logger?.warn?.(
        `[aggregate] 补写「整个 provider 已关闭」的黑名单失败（下次目录推导会再试）：${String(error)}`,
      )
    }
  }

  /**
   * 参与聚合的渠道 id 白名单 —— **只含本插件注册的渠道**。
   *
   * ## ⚠️ 为什么必须是白名单，不能用 `listProviders()`
   *
   * 初版直接 `ctx.llm.listProviders()` 并注释成「本插件注册的全部渠道」，但那个 API
   * 返回的是**宿主全部**存活路由 —— 它会纳入 `deepseek-account`、`pi-ai` 等
   * **别的插件**的 provider（真实缺陷，全分支终审 I1）。后果：
   *
   * 1. **广告出无法路由的虚拟模型**：那些渠道的临期折算没接入（`createExpiryProbe`
   *    只接了 buddy / workbuddy / loomy / codearts / zcode），一律折算成 `UNUSABLE`
   *    ⇒ 它们的虚拟模型**永远没有可用候选**。用户选中后拿到的是
   *    「没有任何可用候选（渠道被关闭、模型被关、或所有渠道都无可用账号）」——
   *    把「该渠道尚未接入」**谎报成「你没登录」**，正是本仓库反复修的误导性报错。
   * 2. **跨渠道归一被污染**：宿主自带 provider 的模型会被并进聚合目录
   *    （实测 `deepseek-account:deepseek-flash` 与 `qoder:dfmodel` 会被合并成同一个
   *    虚拟模型），使「跨渠道归一」把**非本插件渠道**也算成候选。
   *
   * ⚠️ 用字面量而非 import 各 `product.ts` 的常量：那要引入 12 个模块，显著加重本文件
   * 的依赖；而这些 id 是**稳定契约**（`index.ts` 的 `modelAdapters` 表同样用字面量）。
   * 新增 provider 时**两处都要加**。
   *
   * ## ⚠️ 本清单**有守卫**（2026-10-12 补）
   *
   * 原先本行写的是「（与 `modelAdapters` 同一约定）」—— 那句是**误导**：`modelAdapters`
   * 当时已有两条守卫（源码文本抓多余键 + 行为抓漏键），而**本数组一条都没有**。
   * 实测（对抗性审计）：从本数组删掉 `'gemini'` 后全量测试**依然全绿**，而线上后果是
   * 该渠道的模型**永不进聚合目录**、用户看不到、`auto` 也不用，**无报错无日志**。
   *
   * 现由 `tests/unit/aggregate-adapter.spec.ts` 的
   * 「★★ 聚合渠道白名单与 registry 对齐」守：它用 `listModels` 的**调用记录**反推本
   * 数组（该常量是私有的，行为路径才拿得到），与 `PROVIDER_REGISTRY.filter(d => d.channel)`
   * 做**集合**比对，漏一家即红并点名。
   * ⚠️ 判据是**集合**不是有序：本数组与 registry 的尾部顺序**本来就不同**
   *（本数组 `… gemini, zcode, opencode`，registry `… zcode, opencode, gemini`），
   * 故不能要求有序相等；顺序本身在本数组内有语义，由下面的排列体现。
   */
  private static readonly AGGREGATE_CHANNELS: readonly string[] = Object.freeze([
    'codearts',
    'buddy',
    'workbuddy',
    'lobsterai',
    'qoder',
    'qodercn',
    'trae',
    'cline',
    'loomy',
    'raccoon',
    'minimax',
    // ⚠️ MiniMax Code 国际版（2026-10-15）：与 `minimax` 是**两个 provider**
    //    （账号不互通、API 主机不同）⇒ 必须各自登记，否则它的模型
    //    **永不进聚合目录、静默不可见**（同款陷阱已复发三次：cline → accio → officeace）。
    //
    //    ⚠️⚠️ **但本行只是第 ① 层（模型层归并）**：决定候选表可见性的还有第二道
    //    闸门 —— `WIRED_EXPIRY_PROVIDERS`（`aggregate-expiry.ts`）。minimax 系
    //    （含国际版）**未接入临期折算**（`ProviderRuntime.expiry` 为 `undefined`）
    //    ⇒ 折算恒 `UNUSABLE` ⇒ 它们的候选**仍被本文件那 4 处
    //    `WIRED_EXPIRY_PROVIDERS` 过滤剔掉**。这与国内站**行为一致**（既有设计），
    //    本次不改变它 —— 登记本数组只是让「目录层」两站都在，与国内站同款。
    'minimaxintl',
    'gemini',
    'zcode',
    'opencode',
    // ⚠️ **本 fork 独有**（modelscope，2026-10-16）：`channel: true` ⇒ 必须进聚合目录，
    //    否则它的模型**永不进聚合、静默不可见**。
    //    ⚠️ 2026-10-17（用户明确要求）**已接入 `WIRED_EXPIRY_PROVIDERS`**（折算原语
    //    `modelscopeExpiry`）：此前那句「不接，因没有额度 API ⇒ 折算恒 UNUSABLE」
    //    **已被证伪** —— 真端点是 `/openapi/v1/magicubes/balance`（带 API Key 返
    //    200、随消耗下降）。它属「有余额但不下发到期时间」那一类：有余额即
    //    `NEVER`、烧光即 `UNUSABLE`。
    //    ⚠️⚠️ **代价（用户已知并接受）**：魔粒烧光时**不会被提前剔出轮换**
    //    （平台既不下发重置时刻，也没有别的额度端点）⇒ 耗尽后仍会被选中、失败一次。
    //    ⚠️ **不许用「猜一个每日 UTC+8 零点」消除它** —— 那是凭空造一个上游从未
    //    承诺的重置时刻（本仓库红线「绝不编造数字」）。
    'modelscope',
    // ⚠️ qiniu（七牛云，2026-10-29）：`channel: true` ⇒ 必须进聚合目录，否则它的
    //    模型**永不进聚合、静默不可见**。
    //
    // ⚠️⚠️ **本数组只是第一道门**（模型层归并）。决定「在不在候选表里」的是
    //    `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS` —— 而 qiniu **刻意不进
    //    那张表**：七牛云**没有余额端点**（用量只在控制台可见）⇒ 折算恒
    //    `UNUSABLE`，与 cline / raccoon / gemini 同格。它已登记在
    //    `expiry-runtime-parity.spec.ts` 的 `NOT_EXPIRY_WIRED` 豁免表里，
    //    由「豁免理由被验证」那条用例钉住。
    'qiniu',
    // ⚠️ monkeycode（MonkeyCode，2026-11-02）：`channel: true` ⇒ 必须进本清单，
    //    否则它的模型**永不进聚合目录、静默不可见**。
    //
    // ⚠️⚠️ **本数组只是第一道门**（模型层归并）。决定「在不在候选表里」的是
    //    `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`。
    //
    //    📌 **2026-11-02 三审 F🟡-1 更正**：这段注释原写「monkeycode **刻意不
    //    进**那张表」，**已过期** —— 三家（`monkeycode` / `monkeycodeintl` /
    //    `baizhi`）早已补进 `WIRED_EXPIRY_PROVIDERS`（`aggregate-expiry.ts:259-261`）
    //    与 `provider-expiry.ts` 的 `createProviderExpiry()`（折算原语
    //    `monkeycodeExpiry`）。当时的理由「wallet 报文只有标量、没有到期时刻」只对
    //    一半：真正接入的是**每日额度的重置时刻**（次 UTC+8 零点，`nextUtc8DayStartMs`），
    //    不是积分包的到期时间 ⇒ 属「有余额但不下发到期时间」那一类：有额度即
    //    `NEVER`、烧光即 `UNUSABLE`。
    //    ⚠️ 该陷阱（只改本数组、忘了那张表 ⇒ 候选层被静默剔掉）在本仓库已复发 5 次。
    'monkeycode',
    // ⚠️ monkeycodeintl（MonkeyCode 国际站，2026-11-02 拆站）：与 `monkeycode`
    //    **逐字同构** —— 同一套代码的另一部署（`proxy.monkeycode-ai.net` 实测
    //    与 .com 一样对 `GET /v1/models` 回 405），`channel: true` ⇒ 必须进本清单。
    //    ⚠️ **已进** `WIRED_EXPIRY_PROVIDERS`（同上，2026-11-02 三审 F🟡-1 更正），
    //    折算原语与国内站共用（`monkeycodeExpiry`），但必须传 `MONKEYCODE_INTL`
    //    —— 两站账号池不互通、域名不同（国际站 cookie 打国内站回 401）。
    'monkeycodeintl',
    // 百智云（2026-11-02）：`channel: true` ⇒ 必须进本清单，否则它在聚合目录里
    // 永远不可见（**静默**）。它是 `x-api-key: sk-…` 的按量付费网关，
    // 与 MonkeyCode 两站的 oma_ 凭据/每日额度完全无关，只是同源上游。
    'baizhi',
    // officeace（2026-10-12）：华为 MaaS 云端直连渠道，`channel: true`
    // ⇒ 必须进聚合目录，否则它的模型**永不进聚合、静默不可见**。
    // ⚠️ 本数组**只是第一道门**（模型层归并）。真正决定「在不在候选表里」的是
    //    `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`：
    //      ① **轮换候选**的闸门 = `aggregate-expiry.ts` 的「未接入 ⇒ `UNUSABLE`」短路
    //         （下面 `candidatesFor` 的建池处**不**按它过滤 —— 未接入渠道由那条短路
    //          折算成 `UNUSABLE`，再由 `rankCandidates` 剔除）；
    //      ② 本文件另有 **4 处**按它过滤（探测排序 / 面板候选 / 虚拟模型播报 /
    //         选择器价格后缀），管的是面板与元数据面。
    //    只加本数组是**无效接线**，症状静默；且「渠道会进聚合目录」**只在它的模型
    //    与已接入渠道共用规范名时成立** —— **独有模型**会被 `refreshCatalog` 的
    //    `.some(...)` 过滤整个剔掉，连目录都进不去。
    // ✅ officeace 白名单**已于 2026-10-13 补齐**（`026a7db` "feat(officeace):
    //    接入聚合轮换"）：折算原语 `officeaceExpiry`（与 buddy 系同形，逐包
    //    `expiresAt`）+ `WIRED_EXPIRY_PROVIDERS` + `provider-expiry.ts` 的
    //    `createProviderExpiry()` 三处同改，后两者的一致性由
    //    `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁住。
    //    ⚠️ 本注释此前写着「officeace **未接入**……可接而未接」，那句在
    //    2026-10-13 之后**已过期**（同类陷阱再次出现，见 accio 那条）——
    //    留着它会让人以为聚合里看不到 officeace，故更正。
    'officeace',
    // ⚠️⚠️ accio（阿里 Accio Work，2026-10-13）—— 两件事**都要**做，缺一即静默：
    //    ① 加进本数组（进聚合目录）；
    //    ② 加进 `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`（进**候选表**）。
    //
    //    ⚠️ **只做 ① 是无效接线**（2026-10-13 合并审计实测）：决定候选可见性的
    //    是 `WIRED_EXPIRY_PROVIDERS` —— 本文件有 4 处按它过滤（探测/候选/虚拟模型/
    //    价格）。当时 accio 的 `PRIMARY_CHANNEL` 与 `CANONICAL_OVERRIDES` 都配对了
    //    （`canonicalKeyFor` 返回 `via: 'patch'` ⇒ 归并到 `qwen3-8-flash`），
    //    但候选层被那道闸门剔掉 ⇒ **用户要的「轮换列表里要有 accio」并没有实现**，
    //    且症状静默（无报错、无日志）。现两处都补齐。
    'accio',
    'autoclaw',
    // ⚠️ AutoClaw 国际版（2026-10-20）：`channel: true` ⇒ 必须进聚合目录，
    //    否则它的模型**永不进聚合、静默不可见**（同款陷阱已复发四次：
    //    cline → accio → officeace → autoclaw）。
    //    与 `autoclaw` 一样**已接入** `WIRED_EXPIRY_PROVIDERS`（三处同改：
    //    本数组 + `aggregate-expiry.ts` 的清单 + `provider-expiry.ts` 的条目）。
    //    ⚠️ `provider-expiry.ts` 里必须传 `AUTOCLAW_INTL` —— 传国内版会用国内
    //    基址查国际账号余额（410000）⇒ 折算恒 `UNUSABLE` ⇒ 又回到静默不可见。
    'autoclawintl',
    // ⚠️ **AStudio**（讯飞 AstronStudio，2026-10-20 **改判**）
    //
    // 原注释（2026-10-16 定案）写着「有意**不进** AGGREGATE_CHANNELS」，三条理由
    // 在 2026-10-20 用户报障后逐条复核，**全部不成立或已不适用**：
    //
    // | 原理由 | 复核结论 |
    // |---|---|
    // | 「模型目录来自上游动态 catalog」 | 与是否接入聚合无关 —— `aggregate-adapter` 读的是 `listModels()`（本家适配器已实现），不关心它内部怎么取 |
    // | 「额度语义不同」 | **当时是没查证**。实测 `/points/balance` 三池各带 `*NextExpireTime`（赠送池实测 `"2026-11-20T01:50:14"`），与 buddy 系同形，`sharedPackageExpiry` 直接适用 |
    // | 「失效语义不同（HTTP 200 + code 80000 = 需重登）」 | 只影响**额度读数失败时**的文案分流（`fetchAstudioBalanceDetailed` 的 terminal 判定），与「该渠道何时作废」的折算无关 |
    //
    // ⚠️ 第 4 条原理由是「两处均未补齐」—— 那是**当时的实现状态**，不是设计约束。
    //    本次三处同时补齐：本数组 + `WIRED_EXPIRY_PROVIDERS` + `createProviderExpiry()`
    //    的 `astudioExpiry`（缺任一处都静默失效，见上面 accio/autoclaw 的教训）。
    //
    // ⚠️⚠️ **只加本数组是无效接线**（2026-10-13 合并审计实测）：决定候选可见性的
    //    是 `WIRED_EXPIRY_PROVIDERS` —— 本文件有 4 处按它过滤。用户报障
    //    「astudio 缺永久/长期/临期三档」的直接成因之一就是这条「有意不接入」。
    'astudio',
    // ⚠️ **Codely**（Unity，2026-10-22 A6）：推理 / 目录 / 余额 / 签到 / 续期全部已接线，
    //    `channel` 已翻 `true` ⇒ **必须进本数组**，否则它的模型**永不进聚合目录**。
    //    ⚠️ 但**不进** `WIRED_EXPIRY_PROVIDERS`：它的余额端点**不下发任何到期时间**
    //    （`expiredTime` 是空串），而候选表的第一判据就是临期档 ⇒ 它的候选
    //    会被那 4 处 `WIRED_EXPIRY_PROVIDERS` 过滤剔掉（**与 minimax 系列当前行为一致**）。
    //    ⇒ 目录层有它、轮换候选层没它；上游一旦开始下发到期时间，
    //    补一个折算原语 + 两处登记即可。
    'codely',
    // ⚠️ Magicrew（超级麦吉，2026-10-29）：与 accio / officeace / autoclaw 同款，
    //    **只加本数组不够** —— 决定候选表可见性的是 `aggregate-expiry.ts` 的
    //    `WIRED_EXPIRY_PROVIDERS`，漏了它 ⇒ 折算恒 UNUSABLE ⇒ 该渠道静默消失。
    'magicrew',
    // ⚠️ **MagiCrew 国际版**（`magicrewintl`，2026-11-01）：与 `magicrew` 是
    //    **两个 provider**（host 不同、账号体系物理隔离）⇒ 必须各自登记，
    //    否则国际站的模型**永不进聚合目录、静默不可见**
    //    （同款陷阱已复发五次：cline → accio → officeace → autoclaw → magicrew）。
    //    ⚠️ 与 `magicrew` 一样**不只加本数组**：还要进 `aggregate-expiry.ts` 的
    //    `WIRED_EXPIRY_PROVIDERS` 与 `provider-expiry.ts` 的条目，
    //    且后者必须传 `MAGICREW_INTL`（传国内版会拿国内基址查国际账号余额）。
    'magicrewintl',
    // ⚠️ 腾讯 Marvis（2026-11-09，本 fork 独有）：`channel: true` ⇒ 必须进本数组，
    //    否则它的模型**永不进聚合目录、静默不可见**。
    //    ⚠️⚠️ **本数组只是第一道门**（模型层归并）。决定「在不在候选表里」的是
    //    `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS` —— Marvis 已接入
    //    （折算原语 `marvisExpiry`，属「有余额但不下发到期时间」那一类：
    //    有余额即 `NEVER`、烧光即 `UNUSABLE`）。
    'marvis',
  ])

  /**
   * 本插件注册的渠道 id（`aggregate` 与 `jet-hub-auto` 自身除外）。
   *
   * ⚠️ 先取 `listProviders()` 的**存活路由**再与白名单取交集：这样宿主没装载的渠道
   * 不会进目录（否则会广告出连适配器都没有的模型），同时**排除**别的插件的 provider。
   */
  private providerIds(): string[] {
    let alive: ReadonlySet<string>
    try {
      alive = new Set(this.ctx.llm.listProviders().map((info) => info.id))
    } catch {
      // `listProviders` 缺席或抛错时退回空表 —— 目录为空比崩溃好（调用方会看到
      // 只有 auto 的聚合目录，用户仍可用 auto 与其它 provider 直连）。
      alive = new Set()
    }
    return AggregateAdapter.AGGREGATE_CHANNELS
      .filter((id) => alive.has(id) && id !== AGGREGATE_PROVIDER && id !== 'jet-hub-auto')
  }

  /**
   * 对外播报虚拟模型（含 `auto`），**套用户黑名单**。
   *
   * ## ⚠️⚠️ 2026-10-16：另加一条「**全部候选都是「无临期积分且没打开」**⇒ 不播报」
   *
   * 用户验收反馈原话：「默认不参与轮换的无临期模型（没有一个打开轮换）则**不显示在
   * 选择模型的列表中的聚合模型下属的列表中**」。
   *
   * ### 为什么这条**不违反**「候选全被拒 ≠ 关闭模型」的成文不变式（判据是**分档**）
   *
   * 两种「没有任何候选在轮换」必须分开对待 —— 这是本次改动的**全部要害**：
   *
   * | 情形 | 选择器 | 理由 |
   * |---|---|---|
   * | 用户**主动**把候选全拒（`rejected`） | **仍播报** | 那是既有成文不变式（`jet-hub-store.ts` 的「候选全被拒 ≠ 关闭模型」）。模型留在选择器里，用户选中它拿到**如实**报错，回面板重新打开即恢复 —— 若藏起来，恢复入口就消失了 |
   * | 候选**全是**「无临期积分且用户没打开」（`default-rejected`） | **不播报** | 用户**从未**对该模型做过任何决定，它进选择器只会得到「没有任何可用候选」（第 4 种原因的报错）。⚠️ 它**仍在聚合面板里**（那才是唯一的打开入口），故**恢复路径没有丢** |
   * | 混合（一部分被拒、一部分默认） | **仍播报** | 里面含用户**主动**做的决定 ⇒ 归第一档 |
   *
   * ⇒ 判据是「**所有**候选都 `default-rejected`」，**不是**「没有候选在轮换」。
   * ⚠️ 别把它简化成后者 —— 那会把「用户主动全拒」的模型也藏掉，正是上面那张表第一行禁止的。
   *
   * ⚠️ **只作用于本方法（模型选择器）**：
   *   - `describeCatalog`（聚合面板）**不受影响** —— 面板必须能看到并打开它们；
   *   - `listAllModels`（设置页的开关清单）与 `provider.status` 的 `total` **不受影响**
   *     —— 目录身份保持稳定（`this.catalog` 不随门控漂移，这是上面那份不变式的另一半）。
   */
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️⚠️ **「聚合供应商整体关闭」必须在这里短路**（Gitee issue IKP8OF）。
    //
    // 本家手写 `listModels`（不走 `model-catalog.ts` 的共享骨架），故必须显式判一次。
    // 实测遗漏形态：关闭聚合后登录一个新渠道 ⇒ 目录推导出新虚拟模型 ⇒
    // 它**不在**旧黑名单里 ⇒ 仍可选。本文件虽有 `maintainProviderClosedState`
    // 异步补写黑名单，但那条路有**两个前置条件**（黑名单非空 + 覆盖上一次全量目录），
    // 且补写是 fire-and-forget（落盘失败只记 warn）⇒ 存在「补写落地之前」
    // 的窗口，窗口内新模型**可被选中**。意图判据没有这个窗口。
    //
    // ⚠️ 放在 `catalogForListModels()` **之前**：关闭态下连目录推导都不必等
    //（冷启动时那次推导要打全部渠道的上游，纯属浪费）。
    if (this.options.accountPool.providerClosedFor?.(AGGREGATE_PROVIDER) === true) return []
    const models = await this.catalogForListModels()
    const disabled = this.options.accountPool.disabledModelsFor(AGGREGATE_PROVIDER)
    const entries: LlmModelInfo[] = []
    if (!disabled.has(AGGREGATE_AUTO_MODEL)) entries.push(this.autoModelInfo())
    for (const model of models) {
      if (disabled.has(model.key)) continue
      // ⚠️ 见方法头那张表：**只有**「所有候选都 default-rejected」才跳过。
      if (this.isAllDefaultsUnopened(model)) continue
      /**
       * issue #36：把**已经算出来**的窗口带上（供 OpenAI 网关 `/v1/models`
       * 使用）。这里**刻意不触发新的解析** —— `contextWindowFor()` 可能要打
       * 全部候选的上游，放在目录列表里会拖慢每一次 `listModels`；只读缓存，
       * 未命中就不声明（与「未知」同义，不猜）。
       */
      const contextWindow = this.cachedContextWindowOf(model.key)
      const entry: LlmModelInfo & { contextWindow?: number } = {
        provider,
        id: model.key,
        name: this.pickerNameOf(model),
        inputModalities: ['text', 'image'],
        ...contextWindow === undefined ? {} : { contextWindow },
      }
      entries.push(entry)
    }
    return entries
  }

  /**
   * 模型选择器用的目录：**缓存新鲜就同步返回；不新鲜就先返旧目录、后台补算**。
   *
   * ## ⚠️⚠️ 为什么不能在这里 `await refreshCatalog()`（2026-10-18，实测 7 秒）
   *
   * 实测排障日志：
   * ```
   * [buildModelCatalog] provider=aggregate 全部完成：listModels=…ms，总耗时=7028ms
   * [buildModelCatalog] provider=loomy     全部完成：…              总耗时=6852ms
   * ```
   * 两者**同步出现且数值相近** ⇒ 共享同一个下游。真实机制（核对代码得出）：
   * `refreshCatalog` 会**逐渠道 `await ctx.llm.listModels(provider)`**，即每个渠道
   * 一次**远端目录读取**（`loomy` 的 `listModels` → `loadModels()` →
   * `fetchRemoteModels()` 真发网络请求）。聚合的总耗时 = 各渠道目录读取之和，
   * loomy 那 6852ms 是其中最大的一项 ⇒ 宿主 `buildModelCatalog` 里
   * `provider=aggregate` 这一个分组就把它的选择器拖住整 7 秒，而 `auto` 这类
   * 不需要目录的东西也被一起拖住。
   *
   * ⇒ `listModels` **不再等**：先播报**已知**目录（冷启动时可能只有 `auto`），
   * 折算/读取交给后台，落地后下一次 `listModels` 自然带上它。
   *
   * ## 三条口径（缺一条都会让某条既有行为漂移）
   *
   * 1. **缓存新鲜 ⇒ 完全同步返回**（`isCatalogFresh`，与 `refreshCatalog` 的短路
   *    **是同一个判据**）—— 常见路径（60 秒内重复打开选择器）行为与改前逐字相同；
   * 2. **不新鲜 ⇒ 返回已知目录 + 起一次后台刷新**，**不 await**；
   * 3. ⚠️ **后台任务必须复用 {@link refreshCatalog}**，不另写折算+读取逻辑 ——
   *    它已经是「重新推导 + 清缓存 + 补写关闭态」的**唯一**入口，另写一份会让两条路
   *    的上游行为分叉。
   *
   * ## ⚠️ 为什么**不传 signal**
   *
   * 后台任务没有调用方要通知（`listModels(provider)` 的契约里根本没有 signal 通道），
   * 传了反而是错的。而不传**不会**破坏 `refreshCatalog` 里那段 abort 铁律：
   * 那段逻辑由 `signal?.throwIfAborted()` 与 `isAbortLike(error, signal)` 组成，
   * `signal` 为 `undefined` 时两者都**静默不做任何事** ⇒ 逐渠道真实的读取失败仍照旧
   * 只记 warn 并跳过（既有语义），AbortError 也不会被误吞成目录缓存 —— 因为**没有**
   * AbortError 可言（没有 signal 就没有取消源）。
   *
   * ## ⚠️ 单飞（不得并发两次）
   *
   * 选择器可能在后台那一轮还没跑完时被再开一次（宿主对目录的调用是高频的）。
   * 若每次不新鲜都起一轮，就会对**十几个渠道**并发扇出（正是
   * `AGGREGATE_CATALOG_TTL_MS` 注释里要防的形态）⇒ 必须靠 {@link catalogRefreshInFlight}
   * 合并成一轮。
   *
   * ## 行为代价（如实登记）
   *
   * 冷启动（或距上次成功读取超过 60 秒）后的**第一次**打开选择器，聚合分组里
   * 可能**只有 `auto`**，虚拟模型会在后台读取完成后出现（用户再开一次即见）。
   * 这是「目录不再同步等上游」的必然代价，与 `auto-adapter.ts` 的
   * `resolveModel` 那次修复（实测 70 秒）同一取舍。
   */
  private async catalogForListModels(): Promise<readonly VirtualModel[]> {
    const now = this.options.now?.() ?? Date.now()
    // ⚠️ 与 `refreshCatalog` **同一个判据**（含 `isCatalogFreshFor` 的失效腿）——
    //    两处若不一致，用户改完面板开关后 `refreshCatalog` 想去重推、而这里却
    //    认为「还新鲜、不必起后台那一轮」⇒ 失效形同虚设。
    //    ⚠️ 本方法**无论新鲜与否都返回旧目录**（`this.catalog`）⇒ 用带失效的判据
    //    不会让用户看到内容变少，只是多起一次后台推导。
    if (isCatalogFreshFor(
      AGGREGATE_PROVIDER,
      this.catalogAt,
      now,
      this.options.catalogTtlMs ?? AGGREGATE_CATALOG_TTL_MS,
    )) {
      return this.catalog
    }
    this.startBackgroundCatalogRefresh()
    return this.catalog
  }

  /**
   * 起一轮后台目录刷新（幂等：已有在跑的一轮就**不**再起）。
   *
   * ⚠️ 见 {@link catalogForListModels}：**必须复用** {@link refreshCatalog}。
   * ⚠️ **必须 `.catch()`**：这是 fire-and-forget，未捕获的 rejection 会变成
   *    unhandled rejection 并可能打崩进程（与注册预热同一口径）。
   * ⚠️ 清在飞标记：失败后下一轮 `listModels` 必须仍能再试一次
   *    （否则一次瞬时失败会把目录**永久**冻在空目录上 —— 那是本仓库反复修过的
   *    「单向门」形态）。
   *
   * ## ⚠️⚠️ 「清标记」必须有**两条**路径：settle 与**预算到期**
   *
   * 初版只有 `.finally`，即假设「一轮刷新**总会结束**」。上游会**永不 resolve**
   * （实测 `loomy` 的目录读取挂住）⇒ `.finally` 永不执行 ⇒ 标记永不清 ⇒
   * 此后**所有** `listModels` 都不再起后台刷新 ⇒ 目录永久冻在冷帧，零报错。
   *
   * ⇒ 这里同时 arm 一份放弃等待预算（{@link withBackgroundDeadline}）：
   * - **settle**（成功或失败）⇒ 清标记、正常返回；
   * - **预算到期** ⇒ 清标记、记一条 warn、**保留旧目录**。被放弃的那一轮若日后
   *   真的落地，仍会正常写 `this.catalog` 并广播（不丢结果）。
   *
   * ⚠️ 清标记时比对 {@link catalogRefreshTicket}：被放弃那一轮的 `.finally` 迟到时，
   *   绝不能把**新那一轮**的单飞闸门提前打开（那会重新引入扇出）。
   */
  private startBackgroundCatalogRefresh(): void {
    if (this.catalogRefreshInFlight) return
    this.catalogRefreshInFlight = true
    const ticket = ++this.catalogRefreshTicket
    /** 只有「我这一轮仍是在飞那一轮」时才清标记（见方法头最后一段）。 */
    const releaseIfCurrent = (): void => {
      if (this.catalogRefreshTicket !== ticket) return
      this.catalogRefreshInFlight = false
    }
    const budgetMs = this.options.backgroundRefreshTimeoutMs ?? AGGREGATE_BACKGROUND_REFRESH_TIMEOUT_MS
    void withBackgroundDeadline(this.refreshCatalog(), budgetMs).then(
      // ⚠️ `.then(onOk, onErr)` 而不是 `.then().catch().finally()`：后者的 `finally`
      //    在「预算到期」时**也会**跑到（那正是我们要的「两条路径都清」），但也意味着
      //    迟到的真实结果会在标记已清之后再写一次 —— 那是**无害**的（目录本就该更新）。
      //    这里显式分开两条，是为了让「到期」与「失败」的日志可区分。
      () => { releaseIfCurrent() },
      (error: unknown) => {
        // ⚠️ 到期时**不**把旧目录清空（后台刷新失败保留旧值，这是本适配器的既有口径）。
        if (isBackgroundDeadlineError(error)) {
          this.ctx.logger?.warn?.(
            `[aggregate] 后台刷新目录超过 ${budgetMs}ms 仍未返回，本轮放弃等待`
            + '（保留当前已知目录；上游若稍后返回，其结果仍会被采用并广播）',
          )
        } else {
          this.ctx.logger?.warn?.(`[aggregate] 后台刷新目录失败（不影响本次目录播报）：${String(error)}`)
        }
        releaseIfCurrent()
      },
    )
  }

  /**
   * 该虚拟模型的候选是否**全部**是「无临期积分且用户没打开」（`default-rejected`）。
   *
   * ⚠️ **判据必须逐条看三态**，不能写成「没有 allowed」—— 后者会把
   * 「用户主动全拒」（`rejected`）也算进来，而那**必须仍播报**（见 `listModels` 的表）。
   *
   * ⚠️ 无候选 ⇒ `false`（「无候选」是另一回事：那是该渠道模型下架，不是用户的选择）。
   */
  private isAllDefaultsUnopened(model: VirtualModel): boolean {
    if (model.candidates.length === 0) return false
    const rejected = this.rejectedFor(model)
    return model.candidates.every((candidate) =>
      this.gateOf(model.key, candidate.provider, candidate.realId, rejected) === 'default-rejected')
  }

  /**
   * **不套黑名单**的全量目录 —— 设置页要用它渲染开关。
   *
   * ⚠️ 与其余 14 个适配器的同名方法同约定：被用户关闭的模型也必须出现在这里，
   * 否则用户在设置页**连开关都摸不着**（`jet-hub-rpc.ts` 对 `model.list` 的
   * 注释记录了该缺陷）。
   * ⚠️ 必须是**同步**方法（`jet-hub-rpc.ts` 的 `ModelCatalogSource` 契约要求），
   * 故只读上一次推导结果（由 {@link listModels} 刷新）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return [
      { id: AGGREGATE_AUTO_MODEL, name: this.autoModelInfo().name },
      ...this.catalog.map((model) => ({ id: model.key, name: this.pickerNameOf(model) })),
    ]
  }

  /** `auto` 的元数据。 */
  private autoModelInfo(): LlmModelInfo {
    return {
      provider: AGGREGATE_PROVIDER,
      id: AGGREGATE_AUTO_MODEL,
      name: 'Auto（聚合 · 跨渠道）',
      description: '不指定模型：在所有渠道的所有可用模型里挑积分最快作废的那个。',
      inputModalities: ['text', 'image'],
    }
  }

  /** 虚拟模型的展示名 —— **设置页与解析路径用**（不带倍率，见 {@link pickerNameOf}）。
   *
   * ⚠️ **不加「（单渠道）」之类的后缀**（与 brief 初版的 `nameOf` 不同）：
   * 设计文档 §12.1（`docs/superpowers/specs/2026-10-06-aggregate-provider-design.md`
   * 的「关于 `auto-adapter.ts` 的三处名字」一节）把新 provider
   * 定成「目录展示规范名 + 运行期渠道后缀」**单一形态**，并逐字写死三处的名字都是
   * 规范名（`listModels` / `resolveModel` → `DeepSeek V4.1 Flash`；`prepareCall`
   * → `DeepSeek V4.1 Flash · buddy`）。加后缀会让选择器与服务端目录名不一致，
   * 且 `prepareCall` 会拼出 `…（单渠道） · buddy` 这类双重后缀。
   * 「有没有冗余渠道」是**设置页**的信息（§7.3：按厂商分组、组内按候选渠道数降序、
   * 展开看逐条候选），不该混进模型展示名。
   *
   * ⚠️ 本方法**保持无倍率**：`resolveModel` 与 `describeCatalog` 的返回值被三处
   * 既有断言逐字钉住（`aggregate-adapter.spec.ts:88`、`aggregate-rejections.spec.ts:251`、
   * `aggregate-catalog.spec.ts:21` 全是 `'DeepSeek V4.1 Flash'`），且 `describeCatalog`
   * 的候选子列表**逐条**显示倍率（`candidateRowLabel`）—— 在模型名上再叠一次
   * 会出现「两个倍率」的重复展示。倍率只加在**模型选择器**那一条路径上，
   * 即 {@link pickerNameOf}。
   */
  private nameOf(model: VirtualModel): string {
    return model.name
  }

  /**
   * 聚合目录**此刻是否可用于「关闭整个供应商」这类写操作**（同步、零 IO）。
   *
   * ## ⚠️⚠️ 为什么必须有这个探测（Critical：`provider.setEnabled` 的冷帧假成功）
   *
   * Task 7 之后 `listModels` **不再同步等上游** ⇒ 冷启动时它立刻返回 `['auto']`。
   * 而 `jet-hub-rpc.ts` 的 `fullCatalogIds` 判据是「远端读到即可」（`remoteError`
   * 为空 ⇒ 认为成功）⇒ 用户在冷帧点「关闭聚合供应商」，黑名单只写进 `auto` 一条，
   * `provider.setEnabled` 返回 `ok:true` / `changedCount:1`，而另外两个虚拟模型
   * **仍然可选**。改前它必然 2000ms 超时 ⇒ `remoteError` ⇒ 走拒绝分支，所以这是
   * **Task 7 重新打开**的 IKJW33 缺陷形态（该文件 `:6298` 的注释明文禁止它）。
   *
   * 同一份冷帧数据还让 `provider.status` 把 `closed` 从**安全方向**（`false`）
   * 翻成危险方向（`true`）—— 两个端点同一个根因，故判据只留**这一处**。
   *
   * ## 判据：**只认「从未成功推导过」**（`catalogAt === 0`）
   *
   * 这是「读到的是不是完整目录」唯一**权威**的本地事实：`catalogAt` 只由
   * `refreshCatalog` 在**跑完一轮逐渠道读取之后**写（与 `this.catalog` 同一处赋值，
   * 两者锁定），而冷帧下上游挂住时它**永远**是 0（那正是本次要防的形态）。
   *
   * ### ⚠️ 为什么**不**把另两个信号算进来（都试过，都会造成更坏的误判）
   *
   * | 候选判据 | 看起来能挡冷帧 | 实际后果 |
   * |---|---|---|
   * | `catalogRefreshInFlight` | ✅ 冷帧必在飞 | 也覆盖「TTL 过期后的稳态」：`listModels` 在目录**非空**时同样会起后台刷新 ⇒ 用户点「关闭聚合」被无故拒绝，而那次关闭本来是完全正确的（旧目录里的模型全都写进黑名单了，新增的由 `maintainProviderClosedState` 补写） |
   * | `catalog.length === 0` | ✅ 冷帧必为空 | 也覆盖「**所有渠道都未登录**」：此时聚合确实一个虚拟模型都没有，用户却再也关不掉聚合供应商（与 `provider.setEnabled` 注释里「无账号供应商永远关不掉」那条既有取舍直接冲突）；而且 `maintainProviderClosedState` 已保证「关掉后新长出来的模型会被自动补写」 |
   *
   * ⇒ 那些更严的判据换来的是**误报**（安全但不可用），而 `catalogAt === 0`
   * 精确命中「读到的必然残缺」这一种状态。
   *
   * ⚠️ 三个条件都只读本适配器自己的内存状态：**零网络、零 await** ⇒
   * `provider.status` 那些「常见路径零网络」的承诺不受影响。
   *
   * ⚠️ 不实现成 `describeCatalogHealth`：那是 cline 专用的「目录**来源**健康度」
   *    诊断（多外部站点拼装），语义与「有没有读到」不同，混用会让两件事的判据漂移。
   */
  catalogReadyForBulkWrite(): { ready: boolean; reason?: string } {
    // ⚠️ 两个字段永远同时写（见 `refreshCatalog`），这里仍显式判两次：
    //    将来若有人只改其中一处的赋值顺序，这条探测也不会静默放行。
    if (this.catalogAt === 0 || this.catalog.length === 0) {
      return {
        ready: false,
        reason: this.catalogAt === 0
          ? '聚合目录尚未成功推导过（冷启动 / 上游目录读取尚未返回）'
          : '聚合目录当前为空',
      }
    }
    return { ready: true }
  }

  /**
   * **模型选择器**里的展示名 = 规范名 + 倍率后缀（如 `GLM-5.3-Flash · 最低 x0.06`）。
   *
   * ## 为什么需要它（用户报障 2026-10-08）
   *
   * 用户原话：「没倍率显示？」—— 切到聚合后，选择器里每条虚拟模型**都没有倍率**，
   * 而同屏的普通渠道（`GLM-5.3-Flash · x0.06`）有。用户据此无法判断「聚合给我
   * 挑的是不是便宜的那个」，而本功能的全部卖点正是「省钱烧临期」。
   *
   * 根因：`nameOf` 只回规范名，而倍率其实**早就算好了** ——
   * `aggregate-catalog.ts` 的 `CandidateEntry.price` 就是 `priceFactorFromName(realName)`
   * 的结果，只是从没被展示层用过。
   *
   * ## ⚠️⚠️ 为什么文案是「**最低** x…」而不是直接 `· x…`（真实缺陷，复审实测）
   *
   * 初版取全局最小 `price` 并直接拼成 `· x0.03`，其注释推理是「轮换的**第二**判据
   * 是同临期档内倍率升序 ⇒ 最便宜候选最可能被选中」。**该推理在跨临期档时不成立**：
   * `rankCandidates` 的第一判据是**临期升序**，倍率只在**同档内**才起作用。
   * 复审实测（真实 `lib/aggregate-adapter.js` + 真实 `prepareCall`）：
   *
   * ```
   * 候选：buddy x0.29（临期 100，最早） / codearts x0.03（临期 900）
   * 选择器显示："DeepSeek V4.1 Flash · x0.03"   <-- 让用户以为会挑便宜的
   * 实际发往  ：["buddy"]                         <-- 实际挑的是最贵的
   * ```
   *
   * ⇒ 直接写 `x0.03` 会**误导用户**，与本 PR 自己在 `types.ts` 立下的判据
   *（「往静态名里写死倍率就是编造」）同型：显示的价与实际会用的价不符。
   *
   * ⚠️ 修法**不是**「按临期最早那档取最便宜候选」：`CandidateEntry` 里**没有**
   * `expiry`（临期是运行期由 `expiryProbe` 折算的，见 `aggregate-expiry.ts`），
   * 而本方法被 `listModels` / `listAllModels` 调用、**契约要求同步**
   *（`ModelCatalogSource` 的注释）⇒ 这里根本拿不到临期档。若为它改成异步或
   * 触发一轮余额查询，代价远大于收益（选择器渲染路径不能打网络）。
   * ⇒ 采用**如实表达下界**的口径：`最低 x0.03` 的语义是「这个虚拟模型下最便宜的
   * 可路由候选」，它**不声称**本次会选它 —— 用户据此仍能判断「值不值得选这个
   * 模型」，且不会被误导成「一定会用 0.03」。
   *
   * ⚠️ **不显示「区间」**（如 `x0.03–x0.29`）：那会变成最长行，而选择器是窄菜单
   *（与 `buddy-adapter.ts` 的「不写 `（促销 …）`」同一取舍）。
   *
   * ## 三条不显示倍率的规则（都是既有约定）
   *
   * 1. **全部候选都无标注**（`Infinity`）⇒ 不加后缀。直接拼会渲染出
   *    `xInfinity`，那是明显的渲染缺陷（`aggregate-panel-logic.js` 同款判据）。
   * 2. **`0` 显示「免费」**（本仓库既有口径，见 `candidateRowLabel`）。
   * 3. **解析不出就不猜**：宁可没有倍率，也不编一个（`buddy.ts` 同款理由：
   *    编造倍率比不显示更糟）。
   *
   * ⚠️ 只用于 `listModels` / `listAllModels`（选择器与设置页「显示列表」）。
   * **不得**用于 `resolveModel` / `describeCatalog` —— 见 {@link nameOf} 的注释。
   */
  private pickerNameOf(model: VirtualModel): string {
    // ⚠️ 降级集合**算一次**（`rejectedFor` 含 D4 的 id 漂移降级，逐候选重算纯属浪费）。
    const rejected = this.rejectedFor(model)
    const prices = model.candidates
      // ⚠️ 只取**当前参与轮换**的候选（`gateOf(...) === 'allowed'`）—— 判据已从
      //    「已接入折算」升级为完整三态（用户 2026-10-15）：未接入渠道的候选**未手工打开时**
      //    永远不会被路由到，把它的价格显示出来等于替一个用不上的候选报价；而**手工打开的**
      //    未接入候选**真的会参与**（赋 `NEVER`），它的价格该算进去。
      //
      // ⚠️ 若这里保留「已接入」判据：用户手工打开一个更便宜的未接入候选后，选择器里的
      //    「· 最低 x0.03」会**说谎** —— 正是本方法头警告的那类误导。
      //
      // ⚠️ `gateOf` 是同步、零网络的（只读注入的三张表）⇒ 本方法「同步 + 零网络」的
      //    契约不变（`listModels` / `listAllModels` 的渲染路径不能打网络）。
      .filter((candidate) => this.gateOf(model.key, candidate.provider, candidate.realId, rejected) === 'allowed')
      .map((candidate) => candidate.price)
      .filter((price) => Number.isFinite(price))
    if (prices.length === 0) return model.name
    const best = Math.min(...prices)
    // ⚠️ 「最低」二字不可省：见方法头那段实测 —— 省掉会让用户以为本次就用这个价。
    return `${model.name} · 最低 ${best === 0 ? '免费' : `x${best}`}`
  }

  /**
   * 解析一个虚拟模型 —— **目录已有就用它；目录为空时立刻回保守元数据、绝不等待**。
   *
   * 目录**命中**时（热路径）的三条既有口径不变：
   * - `provider`/`id` 必须**按入参回填**（DSH 的 `normalizeModelInfo` 逐字校验，
   *   不符即 `INVALID_MODEL_INFO`）；
   * - `inputModalities` 恒含 `image`：聚合是整池，池里有能看图的渠道，如实声明；
   *   「这次选中的渠道收不收得了图」由分发阶段改道保证；
   * - **档位**声明规范化档位的并集（不是候选集交集，见 {@link aggregateReasoningInfo}）；
   * - **窗口**声明候选集的<u>最大值</u>（不是写死、也不是取小）——
   *   理由与失效形态见 {@link AggregateAdapter.contextWindowFor}。
   *
   * ## ⚠️⚠️ 为什么本方法**不得** `await ensureCatalog`（2026-10-18 复审 + 控制方实测）
   *
   * Task 7 把 `listModels` 改成「先返已知目录、读取转后台」后，排障日志里的
   * `listModels=` 那一格确实降到 1ms —— 但**总耗时仍是 7 秒级**。原因是 DSH 的
   * `buildModelCatalog`（`dsh-api-session-controller/lib/index.js`）的形状是：
   *
   * ```js
   * const models = await ctx.llm.listModels(provider.id)          // ← 1ms（Task 7）
   * const entries = await Promise.all(models.map(async (model) =>
   *   ctx.llm.resolveModelInfo(provider.id, model.id)))           // ← 7 秒全在这里
   * ```
   *
   * 而 `resolveModelInfo` 落到本方法，本方法原先首行就是 `await this.ensureCatalog()`
   * ⇒ 耗时只是从 `listModels=` 那格**搬到了总耗时那格**，用户感知**没有任何改善**。
   * 控制方实测：`listModels` 返回 `["auto"]` 用 1ms，`resolveModel` 仍跑满 407ms
   * （上游卡住时是 7 秒）。
   *
   * ⇒ 与 Task 6 的 `auto-adapter.ts:393` **同构**：目录命中就用；未命中立刻返回
   * 一份**保守元数据**并把读取转后台（复用 {@link startBackgroundCatalogRefresh}）。
   *
   * ## ⚠️ `prepareCall` 路径**不受影响**（发消息必须拿真实目录）
   *
   * `prepareCall` 自己在首行 `await this.ensureCatalog(signal)`（见该方法注释）——
   * 那条路径有 abort 铁律，必须拿到真实目录；本方法只负责**目录加载路径**的
   * 非阻塞。⚠️ 行为差异因此只落在「选择器首次渲染的能力元数据」上（真实代价如实
   * 登记：冷帧下窗口声明的是 {@link AGGREGATE_COLD_CONTEXT_WINDOW} 而不是候选集的
   * 最大值，档位暂不声明）。
   *
   * ## 保守元数据的三条「不撒谎」规则（见 {@link coldModelInfo}）
   *
   * 1. `provider`/`id` 按**入参**回填（DSH 逐字校验，否则 `INVALID_MODEL_INFO`）；
   * 2. **不声明 `reasoning`** —— 档位表要等目录落地才知道，此刻编一份等于替用户
   *    承诺一个可能不存在的档位；
   * 3. 窗口给一个**具名常量**（{@link AGGREGATE_COLD_CONTEXT_WINDOW}），不声称
   *    「目标模型的窗口是多少」。DSH 要求必须声明（`dsh-compaction-basic` 在
   *    `info.context === undefined` 时抛 `TargetPressureConfigError`）⇒ 不能省略。
   *
   * ## ⚠️ abort 语义不变
   *
   * 原先那条 `signal?.throwIfAborted()` 在 `refreshCatalog` 的首行；冷帧**不再进**
   * `refreshCatalog` ⇒ 必须在入口保留一次，否则「已取消的请求仍能拿到元数据」。
   * 热路径的取消仍由 `contextWindowFor` → `capabilityOf` 的
   * `signal?.throwIfAborted()` + `isAbortLike` 逃逸负责（未改动）。
   */
  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    // ⚠️ 中止必须在最前面查（理由见方法头最后一段）。
    signal?.throwIfAborted()
    // ⚠️⚠️ **目录为空 ⇒ 冷帧**：立刻回保守元数据 + 触后台读取，**不 await**。
    //    这条判据（`this.catalog.length === 0`）与 `ensureCatalog` 的短路判据
    //    **逐字同源** ⇒ 「已有目录」的两条路径不会给出两套答案。
    if (this.catalog.length === 0) {
      this.startBackgroundCatalogRefresh()
      return this.coldModelInfo(provider, model)
    }
    if (model === AGGREGATE_AUTO_MODEL) {
      const info = this.autoModelInfo()
      return {
        provider,
        id: model,
        name: info.name,
        ...(info.description === undefined ? {} : { description: info.description }),
        inputModalities: ['text', 'image'],
        // `auto` 的候选池 = **所有渠道的所有模型**（与 `candidatesFor` 的池同语义）
        // ⇒ 它的窗口是整池的最大值（通常就是池里最大的那个 1M）。
        context: { contextWindow: await this.contextWindowFor(model, this.autoCandidates(), signal) },
        reasoning: aggregateReasoningInfo(),
      }
    }
    const virtual = this.catalog.find((entry) => entry.key === model)
    if (virtual === undefined) {
      const available = this.catalog.slice(0, 5).map((entry) => entry.key).join('、')
      // ⚠️ **不要把用户指向不存在的 UI**（第 3 轮审计实测）：
      // 初版文案说「完整清单见 Jet Hub 设置页的「聚合」面板」—— 但那个面板**不存在**
      //（客户端 `PROVIDERS` 里没有 `aggregate`；逐候选拒绝的子列表属 P2）。用户按提示
      // 去找会找不到，属误导性指引。
      // ⇒ 指向**真实存在**的位置：模型选择器里的 `aggregate` 分组（存活路由即可见）。
      throw new LlmError(
        `aggregate: 未知模型「${model}」。当前可用：auto${available === '' ? '' : `、${available}`}`
        + '（完整清单见模型选择器里的「聚合（跨渠道临期优先）」分组）',
        'INVALID_REQUEST',
      )
    }
    return {
      provider,
      id: model,
      name: this.nameOf(virtual),
      inputModalities: ['text', 'image'],
      context: { contextWindow: await this.contextWindowFor(model, virtual.candidates, signal) },
      reasoning: aggregateReasoningInfo(),
    }
  }

  /**
   * **冷帧**（目录尚未推导出来）时 `resolveModel` 的保守元数据。
   *
   * ## ⚠️⚠️ 「保守」的三条硬约束：**可辨识、不撒谎、不编造**
   *
   * | 字段 | 冷帧给什么 | 为什么是这个 |
   * |---|---|---|
   * | `provider` / `id` | **按入参原样回填** | DSH 的 `normalizeModelInfo` 逐字校验；不符即 `INVALID_MODEL_INFO`（整个 provider 分组变成 failure） |
   * | `name` | 该虚拟模型的**规范化展示名** | 用与目录**同一份** `canonicalDisplayName` ⇒ 同一个模型在冷帧与热帧**同名**，不会出现「先是 `glm-5-3`、后是 `GLM-5.3`」的跳变 |
   * | `inputModalities` | `['text', 'image']` | 与热路径同口径：聚合是整池，池里有能看图的渠道；**真正能不能收图由分发阶段改道保证**（`dispatch` 的 `imageTargets`） |
   * | `context.contextWindow` | {@link AGGREGATE_COLD_CONTEXT_WINDOW} | DSH **强制**要求正整数（`dsh-compaction-basic` 在 `context === undefined` 时抛 `TargetPressureConfigError`）⇒ 不能省略；给一个**具名常量**且**不声称**它是目标模型的真实窗口 |
   * | `reasoning` | **不声明**（字段缺席） | 档位表要等目录落地才知道。编一份等于替用户承诺一个可能不存在的档位（`auto-adapter.ts` 的降级路径同一取舍） |
   * | `description` | **不给** | 同上：任何「目标是 xxx」的描述在冷帧都是编造 |
   *
   * ⚠️ **`auto` 与具名虚拟模型走同一份冷帧元数据**（只差 `name`）：冷帧时
   * `this.catalog` 是空的，`auto` 的候选池也就无从谈起 —— 此时若给 `auto` 一个
   * 更「丰富」的元数据，那只能是编的。
   *
   * ⚠️ **不要把本方法当成「永久降级」**：目录落地后（最长 60 秒 TTL，通常远短于
   * 一次选择器的打开时长）下一次 `resolveModel` 就走热路径，窗口与档位都变成真值。
   */
  private coldModelInfo(provider: string, model: string): LlmResolvedModelInfo {
    return {
      provider,
      id: model,
      // ⚠️ `auto` 用它自己的那个名字（它不是虚拟模型，`canonicalDisplayName('auto')`
      //    会把键原样返回成 `auto`，与热路径的「Auto（聚合 · 跨渠道）」不一致）。
      name: model === AGGREGATE_AUTO_MODEL ? this.autoModelInfo().name : canonicalDisplayName(model),
      inputModalities: ['text', 'image'],
      context: { contextWindow: AGGREGATE_COLD_CONTEXT_WINDOW },
    }
  }

  /**
   * `auto` 的候选池：所有虚拟模型的候选**并集**（按 `provider\0realId` 去重）。
   *
   * ⚠️ 与 `candidatesFor` 的 `auto` 分支同语义（那边还要叠加拒绝表过滤；本方法
   *    **不过滤拒绝** —— 窗口声明是「这个池里最大能到多少」，被拒的候选仍在池的
   *    物理能力范围内，且拒绝表随时可能被改回来）。
   * ⚠️ 去重是必要的：同一候选可能归属多个虚拟模型（如同一 realId 同时归入两个
   *    规范名），重复解析虽被 `capabilityCache` 吸收，但会让循环做无用功。
   */
  private autoCandidates(): Array<{ provider: string; realId: string }> {
    const seen = new Set<string>()
    const out: Array<{ provider: string; realId: string }> = []
    for (const virtual of this.catalog) {
      for (const candidate of virtual.candidates) {
        const key = `${candidate.provider}\u0000${candidate.realId}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ provider: candidate.provider, realId: candidate.realId })
      }
    }
    return out
  }

  /**
   * 目录为空时先推导一次（避免 `prepareCall` / 面板在 `listModels` 之前被调用时找不到模型）。
   *
   * ⚠️⚠️ **必须接收并透传 `signal`**（真实缺陷，独立审计实测证伪）：
   *   本方法原先调 `this.refreshCatalog()` **不传 signal** ⇒ **真实请求路径**
   *  （`prepareCall` → 本方法）的中止**不生效** ——
   *   实测「取消于 50ms 仍跑满 312ms 的 `listModels` 才抛错」。
   *   此前只有 `describeCatalog`（面板路径）串了 signal，故 `refreshCatalog`
   *   自己的中止逃逸是对的，但**调用它的真实路径拿不到取消信号**。
   *
   * ⚠️ **2026-10-18 起本方法不再是 `resolveModel` 的调用方**（那会让目录加载
   *    路径同步等上游 7 秒，见 `resolveModel` 的方法头）。现在的调用方只有
   *    **发消息**与**面板**两条路径 —— 它们都**必须**拿到真实目录，故仍同步等待。
   */
  private async ensureCatalog(signal?: AbortSignal): Promise<void> {
    if (this.catalog.length === 0) await this.refreshCatalog(false, signal)
  }

  /** 当前的临期探针：注入优先，否则保守返回 UNUSABLE。 */
  private expiryProbe(): ExpiryProbe {
    return this.options.expiryProbe ?? (() => Promise.resolve(UNUSABLE))
  }

  /**
   * 绑定「本次候选序」到一次分发。
   *
   * ⚠️ 候选序必须在**这里**算好（`prepareCall` 是异步的）：返回的 `stream` 闭包
   * 契约是**同步返回 AsyncIterable**（`PreparedAdapterCall`），闭包里拿不到
   * `await` 的机会 ⇒ 临期折算、档位表都得在这之前备齐。
   */
  async prepareCall(
    _provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    // ⚠️⚠️ **发消息路径必须显式拿真实目录**（2026-10-18）。
    //
    // 以前这一行**不存在**：`resolveModel` 自己在首行 `await this.ensureCatalog(signal)`，
    // 于是 `prepareCall` 顺带拿到了目录。现在 `resolveModel` 为了「目录加载不得同步等
    // 上游」**不再等待**（见其方法头），⇒ 若这里不补，`prepareCall` 会拿到**冷帧元数据**
    // （无 `reasoning`、窗口是保守常量），而那是**请求真正要发出去的**元数据。
    //
    // ⇒ 这里显式等一次，且必须排在 `resolveModel` **之前**：目录没落地时
    // `resolveModel` 走冷帧分支、直接返回保守元数据，那正是本条要避免的。
    //
    // ⚠️ **`signal` 必须透传**（真实缺陷，独立审计实测证伪）：`refreshCatalog` 里
    // 逐渠道读取之间靠 `signal?.throwIfAborted()` 中止；不透传 ⇒ 用户取消后仍会把
    // 所有渠道读完（实测「取消于 50ms 仍跑满 312ms」），且截断目录会被缓存 60 秒。
    //
    // ⚠️ 既有行为不变：`ensureCatalog` 只在目录**为空**时真刷新 ⇒ 热缓存下零成本。
    await this.ensureCatalog(signal)
    // ⚠️ 关于「目录刷新后是否会服务陈旧缓存」（第 5 轮审计实测）：
    // **不会**，但**不是**因为这两行的先后顺序 —— 而是因为 `candidatesFor` **自己也调
    // `ensureCatalog()`**（其首行），故无论谁先跑都会先刷新目录。
    // 实测：把两者调换顺序，行为不变（我最初据此写了一条「顺序保证」用例 + 注释，
    // 但交换顺序后该用例**仍通过** ⇒ 它是同义反复，已删除；注释也就此订正）。
    //
    // 真正的保证是：`ensureCatalog` 一旦刷新，`this.catalog` 即**当前**目录，于是
    // 已下架的模型既过不了 `resolveModel`（抛 `INVALID_REQUEST`）、也进不了
    // `candidatesFor` 的候选序。
    // ⚠️ 唯一残留的陈旧面是 `choiceCache`（60 秒）：它可能在 TTL 内仍含**某个候选**
    //（该虚拟模型的一个已下架 realId）。但它是在 `resolveModel` 通过**之后**才被读，
    // 而那时该虚拟模型已确认**当前存在** ⇒ 最坏情况是「发一个已下架候选、失败、切换」，
    // 由 `dispatch` 的失败切换兜住。
    const resolved = await this.resolveModel(AGGREGATE_PROVIDER, model, signal)
    const targets = await this.candidatesFor(model, signal)
    if (targets.length === 0) {
      // ⚠️ **不要指向不存在的 UI**（第 3 轮审计实测）：初版说「请在 Jet Hub 设置页的
      //  「聚合」面板检查」，但那个面板当时**不存在** ⇒ 那样写是骗用户。
      //  ⚠️ 2026-10-15 更新：那个面板**现在真的存在**了（标题逐字是「聚合」，
      //  见 `plugin-src/client/jet-hub.js` 的 `AggregatePanel`）⇒ 可以（也应该）指向它。
      //
      // ⚠️⚠️ **必须列出第 4 种原因**「候选在聚合面板里未参与轮换」（用户 2026-10-15 的新功能）：
      //    未接入临期折算渠道的候选**默认不参与**，而它们现在**会出现在目录里** ⇒
      //    用户能选中一个「没有任何候选在轮换」的模型。若文案不提这一种，
      //    用户会把它读成「我明明登录了渠道却报没账号」（本仓库反复修的误导性报错）。
      //    ⚠️ 错误码保持 `MISSING_CREDENTIAL` **不变**：改码会翻转宿主的错误分类与既有用例，
      //    本处要的只是让 message 说真话。
      throw new LlmError(
        `aggregate: 「${model}」当前没有任何可用候选（渠道被关闭、模型被关、`
        + '所有渠道都无可用账号，或该模型的候选在聚合面板里未参与轮换）。'
        + '请在 Jet Hub 设置页的「聚合」面板里检查各候选是否参与轮换'
        + '（无临期积分的候选默认不参与，可逐条打开），'
        + '或换用「聚合（跨渠道临期优先）」分组下的其它模型、或直连对应渠道使用该模型。',
        'MISSING_CREDENTIAL',
      )
    }
    // ⚠️ 带图候选序**预解析**（`prepareCall` 是异步的，而 `stream` 闭包必须同步返回）
    // —— 与主候选序共用同一批 `DispatchTarget`，只做一次 `filter`，零额外开销。
    const imageTargets = targets.filter((target) => target.imageCapable)

    return {
      /**
       * ⚠️ 模型名后缀附的是「**首选**渠道」（候选序第一个 = 临期最早的那个），
       * **不是**「本次实际发往的渠道」。
       *
       * ## 为什么做不到「实际发往」（架构约束，不是疏忽）
       *
       * `prepareCall` 是**同步返回元数据 + 一个 stream 入口**的函数，而 DSH 在
       * **发起请求之前**就要拿到 `model.name`（它用于 UI 展示与账目归属）。
       * 而「实际发往哪个渠道」只有在 {@link dispatch} 真正尝试成功之后才确定
       *（候选序第一个可能失败并切换）。两者是**不同时刻**的信息。
       *
       * ⚠️ 我用 `· <渠道>` 加 `title` 说明它是**首选**（而不是改文档去承诺做不到的事）。
       * 真实历史由 `activeProvider()` 记录，由用量徽标显示（那条链路是准确的）。
       * ⚠️ README 原写「本次实际发往的渠道」—— **那是过度承诺**，已同步订正。
       */
      model: {
        ...resolved,
        // 后缀是**首选**渠道（临期最早），失败时会切换。
        name: `${resolved.name} · ${targets[0]!.provider}`,
        description: `聚合路由：首选 ${targets[0]!.provider}（临期最早）；失败会按候选序自动切换`,
      },
      stream: (options: GenerateOptions) => {
        // 带图判定必须在闭包里做：`prepareCall` 只拿到 provider/model，拿不到
        // `options.messages`。⚠️ 用与宿主 capability 同一函数（含 tool-result 递归）。
        const hasImage = options.messages.some((message) => contentHasImage(message.content))
        if (!hasImage) return this.dispatch(targets, options, model)
        if (imageTargets.length === 0) {
          // 全池都不支持图片：**如实报错**，不把图降级成文字占位（后者会让模型
          // 「看到一张图被抹掉」却不知道用户发了什么，属静默丢数据）。
          throw new LlmError(
            `aggregate: 「${model}」的候选渠道都不支持图片输入。`
            + '请换一个支持图片的模型，或去掉图片后重试。',
            'INVALID_REQUEST',
          )
        }
        // 带图时只用声明支持图片的候选（顺序仍是临期升序）。
        this.ctx.logger?.warn?.(
          `[aggregate] 带图请求：改用支持图片的 ${imageTargets.length} 个候选`
          + `（共 ${targets.length} 个），首个为 ${imageTargets[0]!.provider}（${imageTargets[0]!.realId}）`,
        )
        return this.dispatch(imageTargets, options, model)
      },
    }
  }

  /**
   * 构造本次请求的候选序（临期升序 → 倍率升序），并备好每条的档位表。
   *
   * ⚠️ **带按虚拟模型的 TTL 缓存**（规格 §9）—— 否则每次 `prepareCall` 都要对每个
   * 候选渠道重跑一次上游余额查询（见 {@link choiceCache} 的长注释）。
   */
  private async candidatesFor(model: string, signal?: AbortSignal): Promise<DispatchTarget[]> {
    await this.ensureCatalog()
    signal?.throwIfAborted()
    const now = this.options.now?.() ?? Date.now()
    const ttl = this.options.ttlMs ?? AGGREGATE_TTL_MS
    // ⚠️ **缓存键含「拒绝表指纹」**：这样面板改了拒绝表之后，即使调用方**忘记**
    //    清缓存，本方法也不会命中旧条目（旧键的指纹不同）。
    //    为什么不让调用方负责清：忘了清 = 用户在面板上关掉的候选在 60 秒内仍被尝试
    //    = 用户以为开关坏了，而这类「依赖调用方记得」的约定在本仓库已多次静默失效。
    //    `clearChoiceCache()` 仍保留（RPC 调它可立即释放内存），但**正确性不依赖它**。
    const cacheKey = `${model}\u0000${this.routingFingerprint()}`
    const cached = this.choiceCache.get(cacheKey)
    // ⚠️ 命中缓存**不查 signal**（与旧 auto 的注释同因）：`prepareCall` 每次都会
    // 调本方法，若命中分支也查 signal，同一个取消事件在 60 秒窗口的不同位置会产出
    // 两种不同结果（极难复现）。真正的中止由入口处的 `throwIfAborted()` 与
    // `dispatch` 的逐候选检查负责。
    if (cached !== undefined && now - cached.at < ttl) return cached.targets
    const probe = this.expiryProbe()

    // `auto`：候选池是所有渠道的所有模型（与 jet-hub-auto 同语义）。
    // ⚠️ 被「拒绝轮换」的候选**不进池**（规格 §5 的 L3）——在**建池时**就排除，
    //    而不是折算后过滤：后者会白白为它做一次余额探测（一次上游 GET）+ 一次能力解析。
    //    ⚠️ `auto` 分支的拒绝键是**空串**（`auto` 不是虚拟模型，没有自己的拒绝表）——
    //    这不代表「auto 不受拒绝影响」：`auto` 的池是**所有虚拟模型的候选并集**，
    //    故下面在遍历每个 virtual 时**按那个 virtual 的键**取拒绝集。
    const pool: RankedCandidate[] = []
    if (model === AGGREGATE_AUTO_MODEL) {
      for (const virtual of this.catalog) {
        const rejected = this.rejectedFor(virtual)
        for (const candidate of virtual.candidates) {
          // ⚠️⚠️ **门控必须在建池阶段**（早于 `availableByModel` 与探针）：
          //    ① 被排除的候选不该触发账号池查询与上游余额请求（纯浪费）；
          //    ② 与既有「显式拒绝」的过滤位置**同处**，避免出现两套时序。
          //    判据 = `resolveCandidateGate`（显式拒绝 > 显式允许 > 默认；
          //    未接入临期折算的渠道**默认不参与**，可手工打开）。
          if (this.gateOf(virtual.key, candidate.provider, candidate.realId, rejected) !== 'allowed') continue
          pool.push({ provider: candidate.provider, realId: candidate.realId, expiry: NEVER, price: candidate.price })
        }
      }
    } else {
      const virtual = this.catalog.find((entry) => entry.key === model)
      if (virtual === undefined) return []
      // ⚠️ `rejectedFor`（含 D4 漂移降级）—— 这是**建池**路径，用户拒绝的候选必须真的不进池。
      const rejected = this.rejectedFor(virtual)
      for (const candidate of virtual.candidates) {
        if (this.gateOf(virtual.key, candidate.provider, candidate.realId, rejected) !== 'allowed') continue
        pool.push({ provider: candidate.provider, realId: candidate.realId, expiry: NEVER, price: candidate.price })
      }
    }

    // ⚠️⚠️ **先按候选自己的 `realId` 复核账号可用性，再折算临期**（真实缺陷，2026-10-07）。
    //    顺序是刻意的：本地过滤先于上游余额探测 —— 被剔除的候选不必再打一次余额接口
    //    （与上方「拒绝轮换在建池时就排除」同一取舍）。
    //
    // ⚠️⚠️ **被剔除的候选必须显式置 `expiry = UNUSABLE`，不能只把它从折算循环里拿掉**
    //（真实缺陷，对抗审计实测证伪，2026-10-07 —— 我自己上一版正是这么错的）。
    //
    // 机制：建池时每个候选的 `expiry` 初值是 `NEVER`（见上方 `pool.push({…, expiry: NEVER})`），
    // 而 `rankCandidates`（`aggregate-core.ts`）**只剔除 `UNUSABLE`** ——
    // `NEVER` 是合法排序值（语义是「可用、只是不临期」）。于是「只把候选从
    // `usable` 里拿掉」时，它的 `expiry` 仍是 `NEVER` ⇒ **照样进入候选序**，
    // 只是排在最后 ⇒ 当前面的候选失败时**回落到它**（`targets` 是逐个尝试的）。
    //
    // 实测（探针）：buddy 可用、codearts 在该模型上额度已尽 ⇒ 候选序
    // `[buddy, codearts]`；buddy 失败后请求**发往 codearts**，即那个额度已尽的
    // 渠道仍被尝试 —— 缺陷只是被**推迟**而非消除。
    //
    // ⇒ 判据必须落到 `expiry` 上（那才是 `rankCandidates` 读的字段）。
    const available = await this.availableByModel(pool, signal)
    const usable = pool.filter((candidate) => {
      if (available.get(candidate) !== false) return true
      // ⚠️ 关键一行：显式标记为不可用，否则它会以 `NEVER` 的身份留在候选序里。
      candidate.expiry = UNUSABLE
      return false
    })

    // 逐候选折算临期（同一渠道只探一次）。
    const seen = new Map<string, number>()
    for (const candidate of usable) {
      // ⚠️⚠️ **未接入临期折算的渠道：不探针，直接 `NEVER`**（本功能最容易做错、
      //    做错了**完全静默**的一处）。
      //
      // ## 为什么不能让它走 probe
      // `credentialExpiry` 对未接入渠道**恒返回 `UNUSABLE`**（`aggregate-expiry.ts` 的短路）
      // ⇒ `rankCandidates` 会再次把它剔除 ⇒ 症状是「我明明在面板上打开了，它还是不参与」，
      //   **零报错、零日志**。而它恰好是 issue IKL7F9 要解决的场景。
      //
      // ## 为什么这个分支成立
      // 能走到这里的未接入候选，必然是白名单里**显式放行**的那几条
      //（未放行的已在上面 `gateOf` 的建池过滤里剔除）⇒ 它们是「可用、只是没有临期信息」，
      //  正是 `NEVER` 的定义。
      //
      // ⚠️ **用例必须两个方向都覆盖**（未放行 ⇒ 不在池里且**零探针**；放行 ⇒ 在池里且
      //    探针**没被调用**），否则把门控整段删掉那些用例仍然全绿（本任务实测过这一点）。
      if (!WIRED_EXPIRY_PROVIDERS.includes(candidate.provider)) {
        candidate.expiry = NEVER
        continue
      }
      let expiry = seen.get(candidate.provider)
      if (expiry === undefined) {
        try {
          expiry = await probe(candidate.provider, signal)
        } catch (error) {
          // ⚠️⚠️ **中止不得被吞成 `UNUSABLE`**（与 `aggregate-expiry.ts` 的
          // `createExpiryProbe` 同一口径，见那里的长注释）。
          //
          // 探针在「探测途中被取消」时会**刻意重抛** `AbortError`；若这里直接
          // `expiry = UNUSABLE`，取消请求的用户会看到「没有任何可用候选」而不是
          // 中止 —— 且因为**每个**渠道都被这样折算，整池候选会被全部剔除，
          // 该报错与「真的没登录」无法区分。
          // ⚠️ 真实缺陷（Task 7 复审 M4）：本处是同一缺陷的**第二实例** ——
          // `aggregate-expiry.ts` 已修，这里漏了。
          //
          // ⚠️⚠️ **判据必须与 `isAbortLike` 逐格同构（2026-10-12 审计实测补全）**：
          // 本处原先只认 `name === 'AbortError'`，于是同一份 499 报文在
          // `dispatch` 里归**中止**、在这里却被折算成 `UNUSABLE` ⇒ 用户取消后
          // 看到的是「当前没有任何可用候选」而不是中止（正是 M4 那个形态的
          // 新实例）。故改为直接复用共享判据，杜绝再次分叉。
          signal?.throwIfAborted()
          if (isAbortLike(error, signal)) throw error
          expiry = UNUSABLE
        }
        seen.set(candidate.provider, expiry)
      }
      candidate.expiry = expiry
    }
    signal?.throwIfAborted()

    const ranked = rankCandidates(pool, this.manualRankOf(model))
    // 尝试上限 = **所有虚拟模型里最长候选表的长度**。
    //
    // ## 为什么这个值同时满足两个看似矛盾的要求
    //
    // | 场景 | 候选数 | 与 limit 的关系 | 结果 |
    // |---|---|---|---|
    // | 指定虚拟模型 | ≤ limit（limit 取的就是最长表） | 全部保留 | **末位候选轮得到** |
    // | `auto`（池 = 所有渠道所有模型） | 可达 100+，远大于 limit | 被截断 | **有封顶** |
    //
    // ⇒ 同一个值既保证「指定模型不漏候选」，又给 `auto` 的巨池封顶。这正是 issue
    // 记录的口径（「`MAX_ATTEMPTS` 必须 ≥ 最长候选表长度，否则末位候选永远轮不到；
    // 且要封顶」）。
    //
    // ⚠️⚠️ **不要写成 `Math.max(ranked.length, maxAttemptsFor(...))`**（初版的错误）：
    // 那会让 `limit ≥ ranked.length` 恒成立 ⇒ `slice(0, limit)` **永不截断** ⇒
    // 上限形同虚设、`maxAttemptsFor` 变成死代码。实测（Task 6 复审）：把
    // `maxAttemptsFor` 改成 `return 1` 对该路径**毫无行为影响** —— 那就是架空。
    // 真实代价：`auto` 全候选失败时会依次尝试 100+ 次（trae 一家就 32 个模型），
    // 每次都可能是网络超时 ⇒ 长时间挂起。
    const limit = maxAttemptsFor(this.catalog)
    // ⚠️⚠️ **并发解析，不是串行**（2026-10-20 审计补修 —— PR 的根因分析点名了这条路径
    //    却没改它）。
    //
    // 原实现是 `for (const candidate of ranked.slice(0, limit)) { await this.capabilityOf(...) }`
    // ⇒ 总耗时是**各候选之和**。而被 `slice` 截断后的长度是 `maxAttemptsFor(catalog)`
    // = **所有虚拟模型里最长候选表的长度**（实测 14，`auto` 池可达 182+）⇒ 只要其中
    // 有 k 个候选各自要等满 `AGGREGATE_CAPABILITY_TIMEOUT_MS`（默认 3 秒），
    // `prepareCall` 就要白等 `k × 3s`。
    //
    // 实测（`capabilityTimeoutMs: 120`、3 个挂死候选）：
    // ```
    // 串行：prepareCall = 130ms（≈ 1×预算，因为三者中只有一个真挂）
    //      换成 3 个全挂 ⇒ ≈ 3×预算；候选越多越线性放大
    // 并发：恒 ≈ 1×预算
    // ```
    // `contextWindowFor` 早已并发（同一轮里它先跑，故那条路径的耗时是 1× 预算），
    // 只改一半时 `prepareCall` 仍被本段拖回 `N×` —— 这正是「修了一半」的形态。
    //
    // ⚠️ 并发是安全的：每个候选的 `capabilityOf` 只读 `resolveModelInfo` 并写**自己的**
    // 缓存键（`provider\0realId`），彼此无依赖、无共享可变状态。
    // ⚠️ `Promise.all` 而非 `allSettled`：中止（`AbortError`）必须原样逃逸
    //（与 `contextWindowFor` 同口径）；非中止的失败已被 `capabilityOf` 折算成
    // `resolved: false` 的保守值，不会让 `Promise.all` reject。
    // ⚠️ **保序**：`Promise.all` 的结果与输入同序 ⇒ `targets` 的顺序仍是
    // `rankCandidates` 给出的临期序（派发顺序是这个适配器的核心语义，绝不能乱）。
    // ⚠️ `auto` 的池是所有渠道的所有模型：直接 `slice` 会让同一渠道占满名额（2026-11-14
    //    生产故障：前 9 名全是 qoder，账号整体排队时 9 次切换全在 qoder 内部打转）。
    //    ⇒ 第一轮每家最多 2 个、再按原序补齐（见 `pickDiversified`）。指定虚拟模型的
    //    候选表本来就是「每家一个」，保持原样。
    const picked = model === AGGREGATE_AUTO_MODEL ? pickDiversified(ranked, limit) : ranked.slice(0, limit)
    const capabilities = await Promise.all(
      picked.map((candidate) => this.capabilityOf(candidate.provider, candidate.realId, signal)),
    )
    const targets: DispatchTarget[] = picked.map((candidate, index) => {
      const capability = capabilities[index]!
      // ⚠️ 只取 `DispatchTarget` 需要的两项：`capability` 上的 `contextWindow` /
      //    `resolved` 是本适配器内部的推导中间量，摊进目标对象只会在日志与
      //    序列化里留下无意义的字段（`resolved` 尤其容易被误读成「这次请求成功了」）。
      return { ...candidate, efforts: capability.efforts, imageCapable: capability.imageCapable }
    })
    // ⚠️ 只在**非空**时写缓存：空候选通常意味着「所有渠道都不可用」——那是**瞬时**
    // 状态（如额度刚好用尽、账号正在限流），缓存 60 秒会让用户在这期间即使恢复了
    // 也仍报「没有任何可用候选」。
    if (targets.length > 0) this.choiceCache.set(cacheKey, { at: now, targets })
    return targets
  }

  /**
   * 逐个候选问账号池「该候选**自己的模型**上还有可用账号吗」。
   *
   * ## ⚠️⚠️ 为什么返回**映射**而不是「过滤后的数组」（真实缺陷，对抗审计实测证伪）
   *
   * 我上一版返回「过滤后的数组」，调用方拿它去折算临期 —— 但**建池时每个候选的
   * `expiry` 初值是 `NEVER`**，而 `rankCandidates`（`aggregate-core.ts`）
   * **只剔除 `UNUSABLE`**（`NEVER` 是合法排序值：「可用、只是不临期」）。
   * ⇒ 被过滤掉的候选 `expiry` 仍是 `NEVER`，**照样进入候选序**、只是排最后；
   * 当前面的候选失败时**回落到它**（`targets` 逐个尝试）。
   *
   * 实测：buddy 可用 + codearts 在该模型上额度已尽 ⇒ 候选序 `[buddy, codearts]`，
   * buddy 失败后请求**发往 codearts** —— 缺陷只是被推迟而非消除。
   *
   * ⇒ 必须让调用方**显式把 `expiry` 置 `UNUSABLE`**（那才是 `rankCandidates` 读的字段）。
   * 返回映射就是为了让「谁不可用」这个事实能落到调用方的赋值上。
   *
   * ## ⚠️⚠️ 为什么必须按 `realId` 复核，不能只靠临期折算
   *
   * 各 provider 的「额度耗尽」是按 **modelId** 记账的：
   * `AccountPool.getAvailableAccount` / `listAvailableCredentials` 都按
   * `entry.modelRateLimits[modelId]` 过滤候选（`account-pool.ts`），
   * 而 codearts 的 benefit（免费额度）耗尽正是写进那里的
   * （`llm-adapter.ts` 的三处 `updateModelRateLimit` 调用）。
   *
   * 但 `createExpiryProbe` 取号时用的模型键是**该渠道目录的第一个模型**
   * （`src/index.ts` 的 `firstModelIdOf`：`models[0]?.id`），而**聚合层要派发的是
   * 候选自己的 `realId`** —— 两者常常不是同一个模型（一个虚拟模型会挂多渠道多模型的
   * 候选表）。于是：
   *
   * | 场景 | 探测用的键 | 实际派发 | `modelRateLimits` 过滤 | 结果 |
   * |---|---|---|---|---|
   * | auto | `firstModelOf`（= 实际派发） | 同一个 | ✓ 生效 | 已覆盖 |
   * | **aggregate** | `models[0]` | **候选 `realId`** | ✗ **失效** | **缺口可达** |
   *
   * ## 返回值
   *
   * `Map<候选, 是否有可用账号>`：`false` = 明确查到「该模型上无可用账号」；
   * `true` = 有可用账号 / 池未实现该方法 / 查询异常（后两者是**保留**的取舍）。
   * ⚠️ 用 `Map` 而非 `Set` 是为了让「查过且为真」与「没查」在类型上可区分 ——
   * 虽然调用方按 `=== false` 判据处理，两者等价。
   *
   * ## 取舍
   *
   * - ⚠️ **只在池实现了 `getAvailableAccount` 时过滤**：它是既有 API，但大量单测桩
   *   只实现了 `disabledModelsFor`（见 `{@link refreshCatalog}` 的注释）。缺失时**跳过过滤**而不是
   *   判成不可用 —— 宁可少筛一层，不可把整池误剔除（与 `aggregate-expiry.ts` 对
   *   `listAvailableCredentials` 缺失时的降级同一取向）。
   * - ⚠️ 查询失败（抛错）时**保留该候选**：一次池查询异常不该让渠道整体消失。
   * - ⚠️ **中止必须原样逃逸**（与 `candidatesFor` / `capabilityOf` 同一口径，
   *   本仓库已在该缺陷上复发三次）。
   */
  private async availableByModel(
    pool: readonly RankedCandidate[],
    signal?: AbortSignal,
  ): Promise<Map<RankedCandidate, boolean>> {
    const out = new Map<RankedCandidate, boolean>()
    const accountPool = this.options.accountPool as unknown as {
      getAvailableAccount?: (provider: string, modelId: string) => Promise<unknown>
    }
    if (typeof accountPool.getAvailableAccount !== 'function') return out
    for (const candidate of pool) {
      signal?.throwIfAborted()
      try {
        const available = await accountPool.getAvailableAccount(candidate.provider, candidate.realId)
        out.set(candidate, available !== null && available !== undefined)
      } catch (error) {
        if (isAbortLike(error, signal)) throw error
        // 查询异常 ⇒ 保留该候选（见方法注释的取舍）。
        out.set(candidate, true)
      }
    }
    return out
  }

  /**
   * 取目标模型的**三项**能力：**上下文窗口**、**思考档位 id**、**是否收得了图片**。
   *
   * ⚠️ 三项**共用同一次 `resolveModelInfo` 调用** —— 不额外发请求。这是把窗口与
   * 图片能力做成「顺带取回」而不是「另查一遍」的原因（选型路径上每次请求都会走这里，
   * 多一次解析就是多一次上游交互）。
   *
   * ⚠️ 失败时按**保守**方向回落：窗口 `undefined`（不编造，由调用方兜底）、
   * 档位为空（不下发该字段）、图片为 `false`（不把它当带图候选）。
   * 理由见 {@link DispatchTarget.imageCapable} 与 {@link AGGREGATE_FALLBACK_CONTEXT_WINDOW}。
   *
   * ⚠️ **成功的解析结果进 {@link capabilityCache}**（见那里的长注释：失败**不**缓存）。
   *
   * ⚠️⚠️ **每次解析都有独立预算**（{@link AGGREGATE_CAPABILITY_TIMEOUT_MS}，默认 3 秒）。
   * 没有它时，候选池里一个在 DNS/TCP 层挂住的渠道（实测 `autoclaw` 的目录端点
   * ETIMEDOUT 21.6 秒，它自己的 8 秒 `AbortController` 管不到）会让**每一轮**请求
   * 都白等一次；`buildModelCatalog` 又会把它乘以虚拟模型数。见常量处的实测数据。
   */
  private async capabilityOf(
    provider: string,
    realId: string,
    signal?: AbortSignal,
  ): Promise<CandidateCapability> {
    const key = `${provider}\u0000${realId}`
    const cached = this.capabilityCache.get(key)
    if (cached !== undefined) return cached
    // ⚠️ 失败短缓存（{@link capabilityFailureCache}）：TTL 内的重复询问直接回保守值，
    //    不再等一次超时。命中**不算**成功，返回的仍是 `resolved: false`。
    const now = this.options.now?.() ?? Date.now()
    const failedAt = this.capabilityFailureCache.get(key)
    if (failedAt !== undefined) {
      const ttl = this.options.capabilityFailureTtlMs ?? AGGREGATE_CAPABILITY_FAILURE_TTL_MS
      if (now - failedAt < ttl) return { efforts: [], imageCapable: false, resolved: false }
      // 到期即清（不要留着陈旧时刻，否则下次再看还得重算一遍）。
      this.capabilityFailureCache.delete(key)
    }
    // ⚠️⚠️ **在飞合并**（{@link capabilityInFlight}）：同一候选的并发询问共享一次
    //    底层解析。实测宿主对 41 个虚拟模型并行 `resolveModelInfo` 时，同一候选会被
    //    重复解析 2 次（`capabilityCache` 在 `await` 之后才写，挡不住同一拍）。
    //    ⚠️ **只共享成功值**：失败不进 `capabilityInFlight`（`finally` 无条件删），
    //    失败固化只由 `capabilityFailureCache` 按 30 秒显式控制。
    const inFlight = this.capabilityInFlight.get(key)
    if (inFlight !== undefined) return await inFlight
    const task = this.resolveCapability(provider, realId, key, now, signal)
    this.capabilityInFlight.set(key, task)
    try {
      return await task
    } finally {
      // ⚠️ 无条件删（成功与失败都删）：失败**不得**在这里被记住 —— 那只由
      //    {@link capabilityFailureCache} 按 30 秒显式控制。
      if (this.capabilityInFlight.get(key) === task) this.capabilityInFlight.delete(key)
    }
  }

  /**
   * {@link capabilityOf} 的**单次**解析体（在飞合并的实际执行部分）。
   *
   * ⚠️ 抽出来是为了让「在飞合并」只包一层：`capabilityOf` 负责查两张缓存 + 登记/清除在飞表，本方法只做「问一次 + 折算」。
   */
  private async resolveCapability(
    provider: string,
    realId: string,
    key: string,
    now: number,
    signal?: AbortSignal,
  ): Promise<CandidateCapability> {
    try {
      const info = await this.resolveWithBudget(provider, realId, signal)
      const efforts = (info.reasoning?.efforts ?? [])
        .map((effort) => String(effort.id))
        .filter((id) => id.length > 0)
      // ⚠️ DSH 已校验过 `context.contextWindow` 是**正整数**
      //（`dsh-llm/lib/index.js` 的 `normalizeModelInfo`：非整数或 ≤0 抛
      // `INVALID_MODEL_CONTEXT`），故这里不必重复校验；但仍按「不编造」口径
      // 只在**有值**时记录，缺省保持 `undefined`。
      const capability: CandidateCapability = {
        efforts,
        imageCapable: info.inputModalities?.includes('image') === true,
        resolved: true,
        ...info.context === undefined ? {} : { contextWindow: info.context.contextWindow },
      }
      this.capabilityCache.set(key, capability)
      // ⚠️ 清掉失败记录。**当前这一步没有行为效果**（变异测试实测：删掉它全部用例仍绿）：
      //    `capabilityCache` 在方法开头就先查，成功写入后失败记录再也不会被读到
      //    （唯一会清 `capabilityCache` 的 `refreshCatalog` 同时清本表）。
      //    保留它是**防御性**的：①内存卫生（不留 30 秒的死条目）；
      //    ②若将来有人调整两个缓存的查询优先级，这里不会变成「成功之后仍被
      //    30 秒前的失败记录压住」的静默缺陷。
      this.capabilityFailureCache.delete(key)
      return capability
    } catch (error) {
      // ⚠️⚠️ **中止不得被折算成「无档位 / 不支持图片」**（真实缺陷，全分支终审 I3：
      // 这是同一缺陷的**第三处** —— `aggregate-expiry.ts` 与 `candidatesFor` 各修过一处）。
      //
      // `resolveModelInfo` **接收 `signal`**（`dsh-llm/lib/index.js` 的
      // `resolveModelInfo(provider, model, signal)`）⇒ 中止时它会抛 `AbortError`，
      // 而这个 throw 落在本 `try` 内。若直接回落到保守默认值，取消请求的用户会看到
      // 「候选渠道都不支持图片输入」这类**与中止无关**的误导性报错，且整轮不会中止。
      // 与本仓库口径相反：中止应**立刻**以 `AbortError` 结束
      //（`aggregate-core.ts` 的哨兵注释：「abort 立刻抛，绝不折算」）。
      //
      // ⚠️⚠️ **判据必须与 `isAbortLike` 逐格同构（2026-10-12 审计实测补全）**：
      // 本处原先只认 `name === 'AbortError'`，同族分叉的**第三处**。
      // 不修的话，同一份 499 报文在这里会被折算成 `{imageCapable:false}` ⇒
      // 用户看到「候选渠道都不支持图片输入」这类与中止无关的误导性报错。
      signal?.throwIfAborted()
      if (isAbortLike(error, signal)) throw error
      // ⚠️ 走这里的结果**不进** `capabilityCache`（见那里的注释）——否则一次瞬时
      //    失败会让该候选在整段目录 TTL 内恒被当成「无档位 / 不支持图片 / 无窗口」。
      // ⚠️ 但**要进** `capabilityFailureCache`（只有 30 秒）：完全不记会让持续故障的
      //    候选在每一轮请求、每一次目录构建里都被重新等一次超时（见那里的注释）。
      this.capabilityFailureCache.set(key, now)
      return { efforts: [], imageCapable: false, resolved: false }
    }
  }

  /**
   * 带**独立预算**的 `resolveModelInfo`。
   *
   * ## ⚠️ 为什么不能用 `AbortSignal.timeout` 单独了事
   *
   * 超时后必须**区分**「预算用尽」与「调用方中止」：前者按「这个候选暂时问不出来」
   * 处理（保守回落 + 记失败短缓存），后者必须原样抛出 `AbortError`（否则用户取消
   * 后整轮还在跑）。故这里自己造一个 `controller`，超时时抛一个**名字可辨识**的
   * 哨兵错误，由 {@link capabilityOf} 的 catch 分支按 `isAbortLike` 区分。
   *
   * ⚠️ 与 {@link withBackgroundDeadline} 同一口径：**放弃等待 ≠ 取消**。
   * `resolveModelInfo` 会透传 `signal` 给各适配器，故这里额外把预算信号
   * `AbortSignal.any([signal, budget])` 传下去 —— 预算到期时底层请求能被打断的
   * 部分会被打断；打不断的（DNS 解析、TCP 建连）由我们这边**不再等**兜住。
   *
   * ⚠️ 定时器必须 `unref()`（与 `withBackgroundDeadline` 同约定）：宿主常驻进程里
   * 一个 pending 的 3 秒定时器不该拖住退出。
   */
  private async resolveWithBudget(
    provider: string,
    realId: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const budgetMs = this.options.capabilityTimeoutMs ?? AGGREGATE_CAPABILITY_TIMEOUT_MS
    // ⚠️ 预算 ≤ 0 视为「不设预算」（测试里想模拟真实上游挂住时用得到）。
    if (budgetMs <= 0) return this.ctx.llm.resolveModelInfo(provider, realId, signal)
    const controller = new AbortController()
    const composed = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal])
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    /** 构造「放弃等待」哨兵（**只在这一处构造**，见下方 catch 分支的注释）。 */
    const deadlineError = (): Error => {
      const error = new Error(
        `aggregate: 候选 ${provider}/${realId} 的能力解析超过 ${budgetMs}ms（放弃等待，不取消用户请求）`,
      )
      error.name = CAPABILITY_DEADLINE_NAME
      return error
    }
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        // ⚠️ **顺序是承重件**：先 `reject` 哨兵、再 `abort`。
        //
        // 反过来写（先 abort 再 reject）时，`abort` 会**同步**触发底层适配器的
        // `signal` 监听器 —— 真实实现（fetch / undici）在那里以 `AbortError`
        // 结算 ⇒ 该 Promise 的 race 反应**先于**哨兵入队 ⇒ `Promise.race` 以
        // `AbortError` 结算 ⇒ `capabilityOf` 的 `isAbortLike` 把它读成「用户取消」
        // 原样抛出 ⇒ **整轮请求失败**，而真相只是某个渠道的元数据读慢了
        // （实测复现：`THREW name=AbortError`，见 `aggregate-adapter.spec.ts` 的
        // 「预算到期 ≠ 调用方取消」）。
        reject(deadlineError())
        // ⚠️ 再 abort：`resolveModelInfo` 的适配器实现会检查 `signal`，
        //    abort 能让**可中断**的部分立刻收尾，避免泄漏在途请求。
        controller.abort()
      }, budgetMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    try {
      // ⚠️ 底层 Promise 必须**自己挂一个 catch**：`Promise.race` 只接管赢家的结算，
      //    输掉的那条若随后 reject（预算到期我们 abort 了 `composed` ⇒ 底层请求
      //    抛 `AbortError`）就会变成**未处理拒绝**，在宿主里打出噪音甚至在严格
      //    运行时直接终止进程。这里吞掉它是有意的：赢家已经把结论交付给调用方了。
      const pending = this.ctx.llm.resolveModelInfo(provider, realId, composed)
      void pending.catch(() => {})
      return await Promise.race([pending, budget])
    } catch (error) {
      // ⚠️⚠️ **兜住「abort 抢赢 race」这条竞态**（真实缺陷，2026-10-20 两轮独立
      //    审计 + 本轮复核实测）。上面的顺序调整能让哨兵**通常**赢，但胜负取决于
      //    微任务入队次序，而各适配器的结算形态不同（`async` 包装会多一拍、
      //    裸 `new Promise` 在 abort 里同步 reject 则少一拍）⇒ **不能只靠顺序**。
      //    判据用 `timedOut`（我们自己的预算确实到期了）：此时无论谁赢，结论都是
      //    「放弃等待」而不是「调用方取消」⇒ 一律折算成哨兵。
      //    ⚠️ 调用方真取消（`signal.aborted`）时 `timedOut` 为 `false`，
      //    原样抛出 `AbortError` —— 两条语义仍然分得开。
      if (timedOut) throw deadlineError()
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * 该虚拟模型的**上下文窗口声明值**：**候选集的最大值**。
   *
   * ## 口径（设计文档 §4.1「ctx / 图片 / 档位取候选集的能力并集」）
   *
   * 取**最大值**而不是最小值/交集，理由与档位取并集同源：
   *
   * - 声明的窗口是给**宿主**看的（压缩阈值 + 占用指示器），而一次请求实际发往
   *   哪个候选**在声明时还没定**（`prepareCall` 是发起请求之前就返回元数据的）。
   *   取最小值意味着「池里有一条 262144 的候选，就把整池按 262144 声明」——
   *   用户明明在用 1M 的渠道，界面与压缩却按最小的那条算，与本条报障同类；
   * - 取最大值后，若某次真的切到了窗口更小的候选，**由既有的失败切换兜住**
   *   （上游报超长 → 换下一个候选重试）。代价是可能白跑一轮，而最小值口径的
   *   代价是**每一次**请求都被按最小窗口过早压缩 —— 后者持续存在，前者只在
   *   恰好选中小窗口候选时发生。
   *
   * ⚠️ **一个候选的窗口都取不到时**（渠道全部未登录 / 该渠道的 `resolveModel`
   * 不声明窗口）回落到 {@link AGGREGATE_FALLBACK_CONTEXT_WINDOW} —— 不能返回
   * `undefined`，`dsh-compaction-basic` 会抛 `TargetPressureConfigError`。
   *
   * ⚠️ 本方法**不做任何余额探测**（`resolveModel` 会被 `buildModelCatalog` 对
   * 目录里每个模型各调一次），只是读/填能力缓存。
   *
   * ⚠️ **取不到窗口的候选也进入循环**：它不拉低结果，但要为它解析一次能力 ——
   * 解析结果会进缓存，供同一候选在派发路径上复用。
   *
   * ## ⚠️⚠️ 退化判决也记忆化，但只活 30 秒（2026-10-20 用户报障后改）
   *
   * 原实现是「只有**每一个**候选都解析成功时才记忆化」。那条判据的**动机是对的**
   * （不能把瞬时故障固化成持续状态 —— `AGENTS.md` 的「`refreshable` 单向门」），
   * 但**手段过强**：候选池里只要有一个渠道持续故障，本方法就**永不**写缓存，
   * 于是每一轮请求、每一次 `buildModelCatalog` 都要把全部候选重新解析一遍。
   *
   * 实测（`aggregate/deepseek-v4-1-flash`，候选 13 家，其中 `autoclaw` 的目录端点
   * 在 DNS/TCP 层 ETIMEDOUT 21.6 秒）：
   *
   * ```
   * 第1次 prepareCall = 16015 ms   第2次 = 8001 ms   第3次 = 8009 ms
   * contextWindowCache 命中? ★否 —— 永不记忆化
   * ```
   *
   * 用户侧的观感是「每次发消息先白等 60 多秒」，而同模型直连 `workbuddy` 只有 0.8 秒。
   *
   * ⇒ 现行口径：**退化判决照样写缓存**，但打上 `degraded` 标记，有效期只有
   * {@link AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS}（30 秒，目录 TTL 的一半）。
   * 这样既不再每轮重试坏候选，又能在上游恢复后最迟 30 秒自动纠正 ——
   * 「不固化瞬时故障」这条**约束**仍然成立，只是把「永不缓存」换成了「缓存很短」。
   * ⚠️⚠️ **退化期间声明的窗口方向是「可能偏大」，不是「偏保守」**（2026-10-20
   * 对抗审计实测证伪）：
   *
   * | 情形 | 声明值 | 与真实窗口比 | 后果 |
   * |---|---|---|---|
   * | 有候选解析成功 | 已成功那部分的最大值 | **≤** 真实最大值 | 保守（提前压缩） |
   * | **全部候选都失败** | `AGGREGATE_FALLBACK_CONTEXT_WINDOW`（200_000） | 可能 **>** 真实值 | **偏大** ⇒ 压缩阈值推后 ⇒ 上游 `CONTEXT_WINDOW_EXCEEDED` |
   *
   * 实测：唯一候选真实窗口 131_072（128K）而解析失败 ⇒ 声明 **200_000**（大 52%）。
   * 同文件的**冷帧**常量 `AGGREGATE_COLD_CONTEXT_WINDOW`=131_072 才是真保守 ⇒
   * 两个「保守兜底」方向相反（该取值是**既有行为**，master 上同样是 200_000，
   * 不是本 PR 引入；本 PR 引入的只是那句写错方向的注释）。
   *
   * ⚠️ 完整判决（全部候选都解析成功）的有效期跟目录 TTL 走，因为它由
   * {@link refreshCatalog} 重建目录时统一清空兜住。
   *
   * @param modelKey - 虚拟模型 id（含 `auto`），仅用于记忆化。
   * @param candidates - 该虚拟模型的候选表（`auto` 传全池候选）。
   */
  /**
   * 只读缓存里的窗口判决；未命中或已过期返回 `undefined`（不触发解析）。
   *
   * 供 `listModels` 带出 `contextWindow` 用（issue #36）：目录列表要快，
   * 不能为了窗口去逐候选打上游。
   */
  private cachedContextWindowOf(modelKey: string): number | undefined {
    const remembered = this.contextWindowCache.get(modelKey)
    if (remembered === undefined) return undefined
    const now = this.options.now?.() ?? Date.now()
    const ttl = remembered.degraded
      ? this.options.contextWindowDegradedTtlMs ?? AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS
      : this.options.catalogTtlMs ?? AGGREGATE_CATALOG_TTL_MS
    if (now - remembered.at >= ttl) {
      this.contextWindowCache.delete(modelKey)
      return undefined
    }
    return remembered.window
  }

  private async contextWindowFor(
    modelKey: string,
    candidates: readonly { provider: string; realId: string }[],
    signal?: AbortSignal,
  ): Promise<number> {
    const now = this.options.now?.() ?? Date.now()
    const remembered = this.contextWindowCache.get(modelKey)
    if (remembered !== undefined) {
      // ⚠️ 两种判决的有效期不同：完整判决跟目录 TTL 走（它由目录缓存的重建兜住），
      //    退化判决只活 30 秒 —— 否则上游恢复后仍要等满整个目录 TTL 才纠正。
      const ttl = remembered.degraded
        ? this.options.contextWindowDegradedTtlMs ?? AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS
        : this.options.catalogTtlMs ?? AGGREGATE_CATALOG_TTL_MS
      if (now - remembered.at < ttl) return remembered.window
      // 到期即清（留着陈旧项只会让下一次命中再算一遍 TTL）。
      this.contextWindowCache.delete(modelKey)
    }
    // ⚠️⚠️ **必须先去重 + 封顶，再并发**（2026-10-20 独立审计实测的放大面）：
    //
    // `auto` 的候选表是 `autoCandidates()` = **全池去重**（实测 1–2 百条），而
    // `candidatesFor` 那条路径有 `ranked.slice(0, limit)`（`maxAttemptsFor`，实测 14）
    // 封顶。本方法原先**没有任何封顶** ⇒ 一次 `auto` 的窗口推导会同时发起全池
    // 条 `resolveModelInfo`；再叠加宿主 `buildModelCatalog` 对**每个模型**的并行
    // 调用 ⇒ 实测峰值在飞 **364**（14 渠道 × 13 模型）、只解析 `auto` 时 **182**。
    //
    // 同时候选表里**重复项**（同一个 `provider\0realId` 出现多次）会被**并发重复**
    // 解析 —— `capabilityCache` 是在 `await` **之后**才写的，挡不住同一拍的重复
    // 请求。实测「4 个虚拟模型并发」时 12 个候选各被解析 2 次（`peak=27`）。
    //
    // ⇒ 两条腿一起补：① `Map` 按 `provider\0realId` 去重（顺带天然合并在飞请求）；
    //   ② 与 `candidatesFor` **同一个封顶**（`maxAttemptsFor`）。
    //   ⚠️ `maxAttemptsFor` 本就等于「最长候选表长度」⇒ 对**具名**虚拟模型不会
    //   截断任何候选；只有 `auto` 的巨池会被封顶（那正是要防的）。
    const keyOf = (candidate: { provider: string; realId: string }): string =>
      `${candidate.provider}\u0000${candidate.realId}`
    const unique = new Map<string, { provider: string; realId: string }>()
    for (const candidate of candidates) {
      if (!unique.has(keyOf(candidate))) unique.set(keyOf(candidate), candidate)
    }
    const picked = [...unique.values()].slice(0, maxAttemptsFor(this.catalog))
    // ⚠️⚠️ **并发解析而不是串行**（用户报障 2026-10-20 实测）：
    //    串行时总耗时是「全部候选之和」，而候选可达 13+ 家；其中任何一家慢
    //    （实测 autoclaw 的目录端点在 DNS/TCP 层挂 21.6 秒）都会把整轮拖满。
    //    这里要的只是「各自的能力」，彼此无依赖 ⇒ 并发是安全的。
    //    ⚠️ `Promise.all` 而非 `allSettled`：中止（`AbortError`）必须原样逃逸，
    //    而 `capabilityOf` 已把「非中止的失败」折算成 `resolved: false`。
    const capabilities = await Promise.all(
      picked.map((candidate) => this.capabilityOf(candidate.provider, candidate.realId, signal)),
    )
    let widest: number | undefined
    let allResolved = true
    for (const capability of capabilities) {
      if (!capability.resolved) allResolved = false
      const window = capability.contextWindow
      // ⚠️ 只用**已声明**的窗口参与取大：把 `undefined` 当成 0 参与比较是错的
      //    （那会让「没声明」拉低结果），当成 `Infinity` 更错（那是凭猜测放大窗口）。
      if (window !== undefined && (widest === undefined || window > widest)) widest = window
    }
    const resolved = widest ?? AGGREGATE_FALLBACK_CONTEXT_WINDOW
    // ⚠️ **退化判决也记忆化**，但标记 `degraded` 让它的 TTL 只有 30 秒
    //（见 {@link AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS} 的实测数据：
    // 不记忆化会让每一轮请求都重试坏候选）。
    this.contextWindowCache.set(modelKey, { window: resolved, at: now, degraded: !allResolved })
    return resolved
  }

  /**
   * 按候选序**逐个尝试**，成功即返回；全部失败则抛最后一个错误。
   *
   * ## 为什么必须自己实现失败切换
   *
   * DSH 层没有跨 provider 重试：`dsh-llm-retry` 的 `retryStateKey(provider, policyKey)`
   * 只重试**同一** provider/model。故跨渠道切换只能在这里做。
   *
   * ## 为什么 `catch` 要包在**迭代过程**外层
   *
   * 生产路径只走 `prepareCall` 返回的 `call.stream`，而真实错误发生在**迭代
   * 过程中**（dsh-llm 的 `iterator.next()`），不是 `prepareCall` 自己抛的
   * ⇒ `try` 必须包住 `for await`。
   *
   * ## ⚠️⚠️ 只在「一个 chunk 都还没产出」时才能切换（本实现的关键约束）
   *
   * 已 `yield` 出去的内容**收不回来**。若某个候选先吐了「答案是……」然后中途失败，
   * 我们再切到下一个候选，用户看到的是：
   *
   * ```
   * 答案是……答案是 42。
   *      ↑ A 的半截        ↑ B 的完整答案
   * ```
   *
   * 这是**两段拼接的畸形回答**，比「半截 + 报错」严重得多 —— 前者看起来像一句
   * 正常但奇怪的话，用户会当成模型的问题；后者至少明确告诉用户失败了。
   * 本仓库对「静默降级」有明确红线（反复修过的那类缺陷），而拼接畸形内容更甚。
   *
   * ⇒ 规则：**该候选只要产出过「可见内容」，其后任何失败都直接向上抛**，不再尝试下一个。
   * 「切换」只发生在「尚未产出任何可见内容」的失败上（连接失败、认证失败、上游立刻
   * 返回错误 —— 这些恰好是跨渠道切换真正有价值的情形）。
   *
   * ## ⚠️ 为什么判据是「可见内容」而不是「任何 chunk」（Task 6 复审 M23）
   *
   * 初版用「产出过任何 chunk」作判据，于是候选**只吐了 `block-start` / `usage`
   * 这类元数据帧**就失败时，也会放弃切换 —— 那是**过度保守**，白白丢掉一次
   * 本可成功的切换机会。
   *
   * 而只产出元数据帧时切换是**安全**的（实测 `BlockAssembler` 的语义）：
   * - `block-start` 是**幂等**的（`if (!this.partials.has(chunk.index))`）——
   *   下一个候选重发同 index 的 `block-start` 不会产生重复块；
   * - `usage` 是**覆盖**语义（`this._usage = chunk.usage`）—— 后到的会顶掉前一个；
   * - 两者都**不含用户可见的正文**。
   *
   * ⇒ 判据：只有 `text` / `reasoning` / `image` / `tool-call` / `tool-result`
   * 以及 `*-delta` / `block-end` 算「可见内容」；`block-start` 与 `usage` 不算。
   * ⚠️ 未知类型一律**算可见内容**（保守方向：宁可少切换，不可拼接畸形回答）。
   *
   * ## 档位必须逐候选翻译
   *
   * 请求里的 `reasoningEffort` 来自**上一次对话**，可能带着别的模型族的档位名
   * （如给只声明 `enabled` 的模型发 `xhigh`）。原样转发会被 DSH 按 id 严格校验
   * 拦下 `UNSUPPORTED_REASONING_EFFORT`。故复用仓库既有的
   * {@link translateReasoningEffort}：不可表达时**不下发该字段**而非抛错。
   */
  private dispatch(
    targets: readonly DispatchTarget[],
    options: GenerateOptions,
    /**
     * 本次请求的虚拟模型 id（`auto` 或规范键）—— 用于给「上次实际选中的渠道」
     * 记录**归属**（P3：徽标按虚拟模型分别记忆，规格 §6.3 的 P3「每虚拟模型一条」）。
     */
    modelKey: string,
  ): AsyncIterable<StreamChunk> {
    const self = this
    return (async function* () {
      let lastError: unknown
      /**
       * 已透出的 `block-start` 块（`index → blockType`），**跨候选累积**。
       *
       * ⚠️ 为什么需要它（真实缺陷，对抗审计用真实 `BlockAssembler` 实测证伪）：
       * `BlockAssembler` 对 `block-start` 的判据是**按 `index` 幂等且不更新
       * `blockType`** ⇒ 候选 A 开了 `tool-call` 块后失败、候选 B 重开同 index 的
       * `text` 块时，B 的正文会被灌进 A 的 tool-call 块 ⇒ 下游只看到**空 tool-call**、
       * 用户答案丢失（`finish=stop`，无报错）。
       *
       * ⚠️ 实测三种组合（真实 `BlockAssembler`）：
       *   text→text ✅ 安全 ｜ usage→text ✅ 安全 ｜ tool-call→text ❌ 丢答案
       * ⇒ 记录类型，切换前判定（`text` 是安全类型，因为它最可能就是下一个候选要开的）。
       */
      const openedBlocks = new Map<number, string>()
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index]!
        // 该候选是否已经产出过内容（决定失败时能否安全切换，见上方长注释）。
        let emitted = false
        /**
         * 本候选「已产出可见内容 ⇒ 待定记录」的渠道（`undefined` = 没产出过内容）。
         *
         * ⚠️ 只有**整个流正常结束**才提交进 `activeProviderByModel`（规格 §6.3 P3
         * 的「只在成功时写」）—— 见产出内容处的注释与流结束后的提交处。
         */
        let pendingProvider: string | undefined
        try {
          // ⚠️ 派发必须带上「聚合调用」标记（见 `aggregate-dispatch-context.ts`）：
          //    渠道据此把「暂时排队」改判为「本候选失败」，让这里能切到下一个候选，
          //    而不是被 qoder 的排队等待锁死（2026-11-14 生产故障）。
          //
          // ⚠️⚠️ **但只在「还有下一个候选」时才挂标记**（真实回归，对抗审计 + 独立
          //    复现双双实测）：挂上标记后渠道把排队判成本候选失败，而失败后的切换
          //    条件是 `index + 1 < targets.length` —— 本候选是**最后一个**时无处可切，
          //    于是**本可恢复的排队被翻成硬失败**。
          //
          //    实测（`tests/unit/aggregate-qoder-single-candidate.spec.ts`）：单候选
          //    虚拟模型 + 上游排队两次后第 3 次恢复 ⇒ 不挂标记时拿到 `ok`（等了 2 次），
          //    挂标记时立刻 `code=QUEUE` 失败。单候选是**常态**而非边缘情况 ——
          //    `buildVirtualModels()`（`src/aggregate-catalog.ts`）不按 `candidates >= 2`
          //    过滤，任何渠道**独有**的模型（如 qoder 的 `ultimate`、`performance`）
          //    在聚合里都只有一个候选。
          //
          //    最后一个候选没有退路，「等」总比「死」好；用户显式设
          //    `DSH_QODER_QUEUE_WAIT_MODE=fast` 时仍会立即失败 —— 那是用户的选择，
          //    由 `resolveQueueWaitMode()` 负责，与本标记无关。
          const hasNextCandidate = index + 1 < targets.length
          const stream = hasNextCandidate
            ? bindAggregateDispatch(() => self.streamThrough(target, options))
            : self.streamThrough(target, options)
          for await (const chunk of stream) {
            // ⚠️⚠️ **必须在置 `emitted` 之前**判这个失败帧（顺序是语义性的）。
            //
            // 为什么需要这一段：`streamThrough` 走的是**嵌套公共入口**
            // `ctx.llm.stream(...)`，而它把适配器失败**归一化成终止 chunk 而不是抛出**
            //（`dsh-llm/lib/index.js`：`catch (error) { yield adapterFailureChunk(...);
            // return }`，两处；宿主版 JSDoc 原文「Adapter selection, dispatch, and
            // iteration failures become terminal `error` or `aborted` finish chunks」）。
            //
            // 故**只靠 `catch` 永远等不到上游失败** —— 拿到的是一个普通的
            // `{ type: 'finish', reason: { kind: 'error' } }`。若照常置 `emitted`
            // 并 yield，内层生成器正常结束、`return` ⇒ **第二个候选永不尝试**，
            // 整个「失败切换」在生产路径上完全失效（真实缺陷，Task 6 复审实测）。
            //
            // ⚠️ 该帧**不 yield**：它讲的是「这个候选失败了」，而我们要换候选重试；
            // 把它透出去会让消费者以为整轮已经结束。
            if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
              // ⚠️⚠️ **必须保真上游的 `code`，不能拍平成 `'SERVER'`**（真实缺陷，
              // 全分支终审 C1 实测）。
              //
              // 为什么：`'SERVER'` **在** DSH 的 `DEFAULT_RETRYABLE_CODES`
              // （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`，
              // `dsh-llm/lib/index.js:251`）里，而 `QUOTA_EXCEEDED` / `AUTH` /
              // `MISSING_CREDENTIAL` **不在**。拍平后：
              // - 「今日额度已用尽」这类**确定性**错误会被当可重试 ⇒
              //   `dsh-llm-retry` 按 code 判定（`retryStateKey`），每次重试都会
              //   **重跑整个候选循环** ⇒ 最坏 5 × N 次上游调用 + 退避（≈15.5s）。
              //   这正是 AGENTS.md 第 9 条记录的用户报障形态（qoder `110` 被归
              //   `SERVER` 后「白重试 5 次」）。
              // - 它还会**绕过 `dead-model-store` 的豁免**：`IGNORED_CODES` 豁免
              //   `AUTH` / `QUOTA_EXCEEDED` / `RATE_LIMIT` / `MISSING_CREDENTIAL` /
              //   `PERMISSION_DENIED`，但**不豁免 `SERVER`** ⇒ 上游的认证/额度错误
              //   会被 `isModelGoneError` 的文案判据命中，把**整个虚拟模型**记成
              //   30 天失效（终审 C2）。
              // - 也违反 spec §4.3 的成文要求：「复用各适配器抛出的既有
              //   `LlmError.code`（`QUOTA_EXCEEDED` / `RATE_LIMIT` / `AUTH` …）；
              //   不自行解析上游 body」—— 初版既没复用也没解析，而是**丢弃**。
              //
              // ⚠️ 兜底：上游可能不给 `code`（或给空串）—— 那时才退回 `'SERVER'`
              //（它至少是「可重试」的合理默认；给出空 code 会让 DSH 无法归类）。
              const upstreamCode = chunk.reason.failure.code
              // ⚠️ **必须把 failure 的其余事实一并带上**（真实缺陷，对抗审计实测证伪）：
              //    旧实现只传 `message` + `code` ⇒ **丢弃** `status` /
              //    `providerRetryAfterMs` / `requestId`。而 `LlmError` 的第三参
              //    明确接受并校验这三者（`dsh-llm/lib/index.js:1026-1048`）。
              //
              //    ⚠️ 其中 `providerRetryAfterMs` 是**服务端指定延迟**的机器通道 ——
              //    丢了它，退避只能靠固定策略（AGENTS.md 第 8 条记录的 qoder 排队
              //    问题同源：服务端要等 30 秒，而固定退避最多 8 秒 ⇒ 永远等不到）。
              //    ⚠️ `status` / `requestId` 则是排障时定位上游故障的关键线索。
              //
              //    ⚠️⚠️ **不要在这里重写 `LlmError` 的校验**（真实缺陷，独立审计实测证伪：
              //    我自己上一版正是这么写的，结果在**边界值**上反而**丢弃**了原始失败）。
              //
              //    上一版写「`status` 是整数且 ≥100、`providerRetryAfterMs` 有限、
              //    `requestId` 非空」，而 `LlmError` 的真实校验（`dsh-llm/lib/index.js:1037-1039`）
              //    更严：`status` **还要 ≤599**、`providerRetryAfterMs` **还要 >0**。
              //    ⇒ `status=700` / `providerRetryAfterMs=0` 时 `LlmError` **抛校验错**
              //      ⇒ 原始的上游 `message` / `code` **全丢** —— 一个「保真」修复
              //      在边界上**丢弃**了失败。这正是本仓库首条红线的形态
              //      （「同一语义两套判据，必有一处是错的」）。
              //
              //    ⇒ 修法：**判据只留一份**（在 `LlmError` 里）。先试带全部事实，
              //      若它拒绝（抛校验错）就**退回最小集合**（message + code）——
              //      我方永不与它分叉，且**任何**边界值都不会丢掉原始失败。
              const failure = chunk.reason.failure
              const message = `aggregate: ${target.provider}（${target.realId}）上游失败`
                + `${describeFailure(failure)}`
              const code = typeof upstreamCode === 'string' && upstreamCode.length > 0
                ? upstreamCode : 'SERVER'
              // ⚠️⚠️ **逐字段独立回退**（不是整袋回退）。
              //
              // 我先前的两版都有问题：
              // ① 第一版**自己重写**了 `LlmError` 的校验，而它与真实校验不一致
              //   （缺 `status ≤ 599`、缺 `providerRetryAfterMs > 0`）⇒ 边界值上
              //   `LlmError` **抛校验错** ⇒ 上游 message/code **全丢**（Critical）。
              // ② 第二版改成「试全字段、失败就退回最小集合」——修好了 ①，
              //   但**整袋回退**会让**合法**字段陪葬：实测
              //   `status:429 + providerRetryAfterMs:30000 + requestId:''`
              //   ⇒ 合法的 429 与 30000ms 退避**一并被丢**（而 30000ms 正是
              //   服务端指定退避的机器通道，AGENTS.md 第 8 条）。
              //
              // ⇒ 正确做法：**每个字段各自试探**。判据仍只有 `LlmError` 一份
              //  （我方不重写校验），但一个字段越界**只丢它自己**。
              const accepted: LlmErrorOptions = {}
              const probe = (field: keyof LlmErrorOptions, value: unknown): void => {
                if (value === undefined) return
                try {
                  // 用**真实校验**试探：构造一个只带该字段的错误，被拒就丢弃该字段。
                  void new LlmError(message, code, { [field]: value } as LlmErrorOptions)
                  Object.assign(accepted, { [field]: value })
                } catch {
                  // ⚠️ 只丢**这一个**字段，其余照常保真。
                }
              }
              probe('status', failure.status)
              probe('providerRetryAfterMs', failure.providerRetryAfterMs)
              // ⚠️ `requestId` 是 branded 类型（`ProviderRequestId`）——
              //    必须经构造函数 brand（与 `ReasoningEffortId` 同款先例，
              //    见本文件 `resolveModel` 的档位声明），不能直接传 `string`。
              probe('requestId', typeof failure.requestId === 'string'
                ? ProviderRequestId(failure.requestId) : undefined)
              lastError = new LlmError(message, code, accepted)
              throw lastError
            }
            // ⚠️ `aborted` ≠ `error`：中止是**调用方的意愿**，绝不能当成「换个候选
            // 重试」（那会让用户取消后仍继续跑）。与本仓库既有口径一致
            //（`aggregate-core.ts` 的哨兵注释：「abort **立刻抛 AbortError**，
            // 绝不折算」；`auto-adapter.ts` 同款注释）。
            if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') {
              throw abortError()
            }
            // ⚠️ 只在产出**可见内容**时才算「已吐内容」（Task 6 复审 M23）：
            // 仅 `block-start` / `usage` 这类元数据帧是**可安全重放**的，不该
            // 因此放弃切换机会。判据与理由见 `isVisibleContent`。
            //
            // ⚠️⚠️ 但 `block-start` 的「可重放」**只对同类型成立**（真实缺陷，
            // 对抗审计用真实 `BlockAssembler` 实测证伪）：
            // `BlockAssembler.push` 对 `block-start` 的判据是**按 `index` 幂等且
            // 不更新 `blockType`** ⇒ 若候选 A 开了 `tool-call` 块后失败、候选 B
            // 重开同 index 的 `text` 块，**B 的 `blockType` 被忽略**、B 的正文被
            // 灌进 A 的 tool-call 块 ⇒ 下游只看到一个**空 tool-call**、
            // **用户答案丢失**且 `finish=stop`（无报错）。
            // 实测三种组合（真实 `BlockAssembler`）：
            //   text→text ✅ 安全 ｜ usage→text ✅ 安全 ｜ tool-call→text ❌ 丢答案
            // ⇒ 记录**已开块的类型**，切换时若新候选要开**不同类型**则禁止切换。
            if (chunk.type === 'block-start') {
              openedBlocks.set(chunk.index, chunk.blockType)
            }
            if (isVisibleContent(chunk)) {
              emitted = true
              // ⚠️ **先记「待定」渠道，不立刻写进 Map**（真实缺陷，对抗审计实测证伪）。
              //
              // 规格 §6.3 P3 的原文是「**只在成功时写** —— 写失败候选会让徽标指向一个
              // 刚刚失败、甚至已无额度的渠道」。而旧实现写在「首个可见 chunk」时：
              // 若该候选吐了一个 `text-delta` **之后整轮失败**（如 `socket hang up`），
              // 用户**什么也没拿到**，徽标却记下了这个**失败**的渠道。
              //
              // ⇒ 改为：这里只记 `pendingProvider`，等**这一轮的 `for await` 正常结束**
              //   （即候选真的把整轮跑完）才提交进 Map。见下方 `return` 之前的提交处。
              pendingProvider = target.provider
            }
            yield chunk
          }
          // ⚠️ 走到这里 = 该候选的流**正常结束**（没有抛错、没有失败帧）⇒ 提交「实际选中」。
          if (pendingProvider !== undefined) {
            // ⚠️ 是**实际发往**的 `target.provider`，不是候选序第一个（带图改道时可能不同）。
            // ⚠️ 同时更新「最近一次」指针：`Map` 的迭代顺序是**插入顺序**，
            //    覆盖已存在的键**不改变**其位置 ⇒ 不能靠它取「最近」。
            self.activeProviderByModel.set(modelKey, pendingProvider)
            self.lastActiveProvider = pendingProvider
          }
          return
        } catch (error) {
          lastError = error
          // ⚠️ 中止/取消**不换候选**，立刻向上抛。
          if (isAbortLike(error, options.signal)) throw error
          if (emitted) {
            // 已经吐过内容：不能切换（否则把两段回答拼在一起）。
            self.ctx.logger?.warn?.(
              `[aggregate] ${target.provider}（${target.realId}）在产出内容后失败，`
              + `不再切换候选（已产出的内容无法撤回）：${String(error)}`,
            )
            throw error
          }
          // ⚠️⚠️ **已开过任何块 ⇒ 不得切换**（含 `text`）。
          //
          // ## 为什么不能按类型豁免（我先前的修法有**实证明文的盲区**）
          //
          // 我第一版按「已开的块类型」判断：开过**非 `text`** 才拒绝切换。
          // 但适配器**无法预知**下一个候选会开什么类型 ⇒ 若 A 开 `text`
          //（守卫眼中的「安全类型」）而 B 开 `tool-call`，则 B 的 `blockType`
          // 被 `BlockAssembler` 忽略（它按 `index` 幂等、**不更新 `blockType`**）
          // ⇒ **工具调用丢失**。探针（真实 `BlockAssembler`）逐字输出：
          // ```
          // A 开 text → B 开 tool-call
          // blocks = [{"type":"text","text":""}]   ← tool-call 消失，只剩空 text 块
          // ```
          // ⇒ 按类型豁免**必然有缺口**，两个方向都要堵。
          //
          // ## 代价（有意的、可接受的）
          //
          // `text→text` 实测是**安全**的（同类型重放不丢内容），而一刀切会让这种
          // 情形也放弃切换 —— 但那只是**少一次重试**（用户看到一次失败），
          // 而盲区的代价是**工具调用/答案丢失**（用户拿到残缺结果且无报错）。
          // 方向取**安全**：宁可少切换，不可丢内容。
          //
          // ## ⚠️ 已知代价（对抗审计实测指出，**有意保留**）
          //
          // 本守卫收得**比必要更紧**：它在「B 用**从未用过的 index**」时也拒绝切换，
          // 而那种重放**实测是安全的** —— 探针（真实 `BlockAssembler`）：
          // ```
          // A 开 text(0) → B 开 text(7)
          // blocks = [{"type":"text","text":""},{"type":"text","text":"B的答案"}]
          // ```
          // ⇒ B 的答案**完整保留**（只多一个来自 A 的**空块**）。
          //
          // 即：**在切换前无法知道** B 会用新 index 还是复用旧 index（那是上游的自由），
          // 故「按 index 是否复用」收窄需要**预读 B 的第一个 block-start** —— 那会把
          // 本方法从「透传流」改成「带前瞻的缓冲」，属更大的改动面
          //（与下方「延迟 block-start」的替代方案是同一类改动）。
          //
          // ⚠️ 代价的**方向**是刻意的：过紧只是**少一次重试**（用户看到一次失败，可重发），
          //    而过松（允许切换）在**复用 index** 时会**丢答案/丢工具调用**（静默、无报错）。
          //    两者不对称，故取过紧。
          //
          // ⚠️ 另：`openedBlocks` 在 `block-end` 时**也不清**（保持「开过就记住」的简单语义）。
          //    ⚠️ 我一度用「闭合后 index 仍被占用」为它辩护 —— 那个**前提经探针证实是对的**
          //   （`block-end` 只往 partial 挂 `block` 字段、**不删** `partials` 条目 ⇒
          //    后续 `block-start(同 index)` 仍被忽略），
          //    ⚠️ 但**本场景实际拦切换的是 `emitted`，不是 `openedBlocks`**：
          //    `isVisibleContent` 只排除 `block-start` / `usage` ⇒ `block-end` **算可见内容**
          //    ⇒ 收到它时 `emitted` 已置真 ⇒ 由「已吐内容不切换」拦住。
          //    这是**反向验证发现的**：故意让 `block-end` 清掉 `openedBlocks`，79 条仍全绿。
          //    ⇒ 不清理的理由是**简单**（而非「清了会错」）；若将来真的因此放行了切换，
          //      再由那时的新证据决定 —— 现在不为一个未触发的场景加复杂度。
          //
          // ⚠️ 严格的替代方案是**延迟 `block-start`**（缓冲到第一个 delta 一起发，
          //    使「已开块」等价于「已吐内容」）—— 那确实是本仓库既有做法
          //   （`buddy-adapter.ts` 的 `announced: '名字可用的那一刻才发'`），
          //    但它要改动**所有**候选的产出路径（含 tool-call 的 id/name 装配时机），
          //    属于比本修复更大的改动面。留给后续任务，此处取安全的一刀切。
          if (openedBlocks.size > 0) {
            const opened = [...openedBlocks.values()]
            self.ctx.logger?.warn?.(
              `[aggregate] ${target.provider}（${target.realId}）已开启 `
              + `${JSON.stringify(opened)} 块后失败，不再切换候选`
              + `（BlockAssembler 对 block-start 按 index 幂等且不更新 blockType，`
              + `而下一个候选会开什么类型不可预知 ⇒ 切换可能把它的内容灌进错误类型的块）：`
              + `${String(error)}`,
            )
            throw error
          }
          if (index + 1 < targets.length) {
            self.ctx.logger?.warn?.(
              `[aggregate] ${target.provider}（${target.realId}）失败，切换下一个候选：${String(error)}`,
            )
          }
        }
      }
      throw lastError ?? new LlmError('aggregate: 所有候选都失败', 'SERVER')
    })()
  }

  /** 把请求转发给一个候选，按目标档位表翻译 `reasoningEffort`。 */
  private streamThrough(target: DispatchTarget, options: GenerateOptions): AsyncIterable<StreamChunk> {
    const base = { ...options, provider: target.provider, model: target.realId }
    const requested = options.reasoningEffort
    if (requested === undefined) return this.ctx.llm.stream(base)
    const requestedEffort = String(requested)
    if (target.efforts.length === 0) {
      return this.ctx.llm.stream({ ...base, reasoningEffort: undefined })
    }
    const mapped = translateReasoningEffort(requestedEffort, target.efforts)
    if (mapped.kind === 'exact') return this.ctx.llm.stream(base)
    if (mapped.kind === 'mapped') {
      return this.ctx.llm.stream({
        ...base,
        reasoningEffort: ReasoningEffortId(mapped.effort) as GenerateOptions['reasoningEffort'],
      })
    }
    return this.ctx.llm.stream({ ...base, reasoningEffort: undefined })
  }

  /** 从不直接被 stream（总是先经 prepareCall）；兜底抛错而非静默。 */
  async *stream(): AsyncIterable<StreamChunk> {
    throw new LlmError('aggregate: 请通过模型选择器使用', 'INVALID_REQUEST')
  }
}

/** 一个转发目标：候选 + 该模型声明的档位 id + 它收不收得了图片。 */
interface DispatchTarget extends RankedCandidate {
  /** 该候选声明的思考档位 id（供逐候选翻译用，见 `dispatch`）。 */
  efforts: readonly string[]
  /**
   * 该候选是否声明支持图片输入。
   *
   * ⚠️ **解析失败时必须是 `false`**（保守方向）：把「不知道」当成「支持」会让带图
   * 请求被发到一个可能收不了图的渠道，而失败现象是**上游报错**（用户看不出真因）；
   * 当成「不支持」最多是**少用一个候选**（带图时换一个已声明支持的），代价小得多。
   * 与全仓「未知不编造」一致。
   */
  imageCapable: boolean
}

/**
 * 候选循环的**尝试上限**。
 *
 * ⚠️ **不得写死常量**（issue 明确记录：那个参数在 contributor 的实现里调整过 4 次
 * 才固化）。写死一个偏小的值会让**末位候选永远轮不到** —— 等于「加了渠道但没生效」。
 */
export function maxAttemptsFor(models: readonly VirtualModel[]): number {
  let longest = 1
  for (const model of models) {
    if (model.candidates.length > longest) longest = model.candidates.length
  }
  return Math.max(1, longest)
}

/**
 * 聚合模型的**档位声明** —— 规范化档位的**并集**（不是候选集交集）。
 *
 * ## 为什么是并集而不是交集（真实数据修正）
 *
 * 初版设计写的是「取候选集的能力交集」。**该口径在真实数据下是错的**：各渠道的
 * 档位命名空间彼此几乎不相交 ——
 *
 * | 渠道 | 档位 id |
 * |---|---|
 * | codearts | `off` / `on`（只有开关，声明顺序即强度序；注释明确「不臆造强度阶梯」） |
 * | buddy / workbuddy | `low` / `high` / `max`（**逐模型不同**） |
 * | zcode | `low` / `high` / `max` |
 * | loomy | `none` / `low` / `medium` / `high` / `xhigh` |
 * | trae | `light` / `high` / `extra_high`（**私有名**） |
 * | lobsterai | `off` / `high` / `xhigh` |
 * | raccoon | `off` / `on`（同 codearts，强度序） |
 *
 * `deepseek-v4.1-flash` 跨 buddy + codearts + cline ⇒ **交集为空**。而空档位的后果
 * 本仓库有明确记录（`opencode-adapter.ts`：「档位为空时**不声明**本字段，声明空数组
 * 会让 UI 出现一个没有任何档位的空选择器」）⇒ 取交集会让**聚合模型的档位选择器
 * 全部消失**，与本功能目标相反。
 *
 * ⇒ 声明规范化并集，转发时由 `translateReasoningEffort` 逐候选翻译（Task 6）：
 * `exact` 原样、`mapped` 就近同族（同距取更强）、`unexpressible`/`unknown` 时
 * **不下发该字段**让上游走自己的默认。
 *
 * ## 展示名用官方中文
 *
 * DSH 客户端**直接渲染 `efforts[].name`**（不本地化、不查字典）⇒ 必须给中文。
 * 权威来源是 Qoder IDE 的 i18n 词条（`qoder-product.ts` 有逐字记录）：
 * `none:关闭思考 / minimal:最小 / low:低 / medium:中 / high:高 / xhigh:极高 / max:最大`。
 *
 * ⚠️ `unknown` 档位（`CANONICAL_REASONING_EFFORTS` 里没有的）**回退为 id 本身** ——
 * 宁可显示英文原值，也不猜一个可能错译的中文（与 `opencode-adapter` 同取向）。
 */
export function aggregateReasoningInfo(): LlmModelReasoningInfo {
  return {
    efforts: CANONICAL_REASONING_EFFORTS.map((effort) => ({
      id: ReasoningEffortId(effort),
      name: AGGREGATE_EFFORT_LABELS[effort] ?? effort,
    })),
    // ⚠️ 默认档取 `high`，**与各渠道自己的默认一致**：实测 buddy / trae / lobsterai
    // 的 `defaultReasoningEffort` 清一色是 `high`（`product.ts` 里 14 处）。取它
    // 则聚合与直连的体感一致；取 `medium` 会让用户觉得「聚合比直连想得少」，取
    // `max` 则最费 token/积分 —— 与本功能「省钱烧临期」的目标相反。
    defaultEffort: ReasoningEffortId('high'),
  }
}

/** 规范档位 → 官方中文名（来源：Qoder IDE i18n 词条，见 {@link aggregateReasoningInfo}）。 */
const AGGREGATE_EFFORT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  none: '关闭思考',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  ultra: '最强',
})

/**
 * 该 chunk 是否含**用户可见的内容**（决定失败时能否安全切换到下一个候选）。
 *
 * ## ⚠️⚠️ 判据（**已订正**：`block-start` **不可**跨候选重放）
 *
 * 只有**真正可无条件重放**的帧才允许切换。实测 `BlockAssembler` 的语义：
 *
 * | 帧 | `BlockAssembler` 的处理 | 可否跨候选重放 |
 * |---|---|---|
 * | `usage` | `this._usage = chunk.usage` ⇒ **覆盖**，且**不建块** | ✅ 可 |
 * | `block-start` | `if (!this.partials.has(index))` ⇒ **按 index 幂等** | ❌ **不可** |
 * | `text` / `reasoning` / `image` / `tool-call` / `tool-result` | 累积进正文 | ❌ 不可 |
 * | `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` | 累积进正文 | ❌ 不可 |
 * | `finish` | 终止帧（本函数在此之前已单独处理） | — |
 *
 * ## ⚠️ 为什么 `block-start` **不可**重放（真实缺陷，对抗审计用真实 `BlockAssembler` 证伪）
 *
 * 旧注释断言「`block-start` 幂等 ⇒ 可安全重放」—— **那是错的**：
 * 幂等判据**只看 `index`**，**不更新 `blockType`**：
 *
 * ```js
 * case 'block-start': {
 *   if (!this.partials.has(chunk.index)) {   // ← 已存在 ⇒ 直接 return
 *     this.order.push(chunk.index)
 *     this.partials.set(chunk.index, { blockType: chunk.blockType, … })
 *   }
 *   return
 * }
 * ```
 *
 * ⇒ 候选 A 开了 `block-start(0, 'tool-call')` 后失败、候选 B 重发
 * `block-start(0, 'text')` 时，**B 的 `blockType` 被忽略**、**B 的正文被灌进
 * A 的 tool-call 块**。探针（真实 `BlockAssembler`）逐字输出：
 * ```
 * blocks   = [{"type":"tool-call","id":"call-0","name":"","arguments":""}]
 * partials = [[0,{"blockType":"tool-call","text":"B 的正文",…}]]
 * finish   = {"kind":"stop"}
 * ```
 * ⇒ 下游只看到一个**空的 tool-call**、**用户可见答案丢失**，且 `finish=stop`
 * 看起来是干净结束（**无任何报错**）。
 *
 * ## ⇒ 判据
 *
 * **只有 `usage` 不算可见内容**（覆盖语义 + 不建块）；其余一律算。
 *
 * ⚠️ **未知类型一律算可见内容**（返回 `true`）：保守方向是「宁可少切换，
 * 不可拼接畸形回答」—— 拼接两段回答比报错严重得多（前者看起来像一句正常但
 * 奇怪的话，用户会当成模型的问题）。
 */
function isVisibleContent(chunk: StreamChunk): boolean {
  // ⚠️ `block-start` / `usage` 都**不算**可见内容 —— 但**能否切换还要看"有没有开过块"**
  //    （见 `dispatch` 里的 `openedBlocks` 判定）：`block-start` 对 `index`
  //    幂等且**不更新 `blockType`**，故**同类型**重放安全、**异类型**会丢答案。
  return chunk.type !== 'block-start' && chunk.type !== 'usage'
}

/**
 * 把一个 LLM 失败描述成一句可读文案（供日志与抛错消息用）。
 *
 * ⚠️ `failure` 的 `message` / `code` 都是**上游或适配器给的**，可能为空串 ——
 * 空串会让文案变成「上游失败」而后跟一片空白，排查时毫无线索。故缺失时回落到
 * 各自的占位说明，而不是拼出 `：` 结尾的悬空句。
 *
 * ⚠️ **`status` 只打「会被 `LlmError` 接受」的值**（真实缺陷，对抗审计实测指出）：
 * 旧实现写 `typeof failure.status === 'number'` ⇒ `NaN` / `200.5` / `700` 这些
 * **越界值会被打进文案**，而它们在构造 `LlmError` 时被**丢弃**（见下方逐字段试探）
 * ⇒ **日志说了一个实际没生效的值**（排查时按 `status=700` 去查上游会白费功夫）。
 * 判据与 `LlmError` 逐字一致（`100 ≤ n ≤ 599` 的整数）。
 */
function describeFailure(failure: { message?: string; code?: string; status?: number }): string {
  const parts: string[] = []
  if (typeof failure.message === 'string' && failure.message.length > 0) parts.push(failure.message)
  if (typeof failure.code === 'string' && failure.code.length > 0) parts.push(`code=${failure.code}`)
  if (typeof failure.status === 'number' && Number.isInteger(failure.status)
    && failure.status >= 100 && failure.status <= 599) {
    parts.push(`status=${failure.status}`)
  } else if (typeof failure.status === 'number') {
    // ⚠️ 越界值**如实标注为「已丢弃」**（而不是默默丢掉、也不是伪装成有效值）——
    //    这样日志既不说谎，也不隐藏「上游给了一个奇怪的状态码」这个排查线索。
    parts.push(`status=${String(failure.status)}（越界，已丢弃）`)
  }
  return parts.length === 0 ? '（上游未给出原因）' : `：${parts.join(' ')}`
}

/**
 * 造一个「调用方中止」类错误。
 *
 * ⚠️ **必须同时带 `name` 与 `code` 两个判据**（对抗审计实测订正）：
 *
 * 我们抛出的错误会被**外层** DSH 的 `adapterStream` 捕获，再经
 * `adapterFailureChunk(error, signal)` 归类，其判据是：
 *
 * ```js
 * signal?.aborted || failure.code === 'ABORTED' ? { kind: 'aborted' } : { kind: 'error' }
 * ```
 *
 * ⇒ 若只设 `name`（初版就是如此），当 **signal 未被标记**时（上游适配器自行判定
 * 取消、抛了 `code='ABORTED'` 的错误 → 归一化成 `finish/aborted` 帧 → 我们重抛），
 * 外层会把它归成 **`kind: 'error'`** ⇒ 消费者看到「错误」而不是「已中止」，
 * 与「中止是调用方意愿」的语义相反。
 *
 * ⇒ 两个判据都设上：`name` 供本文件与 `aggregate-expiry.ts` 的 `isAbortLike` 识别，
 * `code` 供外层 `adapterFailureChunk` 识别。
 */
function abortError(): Error {
  const error = new Error('aggregate: 请求已中止')
  error.name = 'AbortError'
  ;(error as unknown as { code: string }).code = 'ABORTED'
  return error
}

/**
 * 「后台刷新**放弃等待**到期」的专用哨兵名。
 *
 * ⚠️ **不得**用 `AbortError`：那条名字在 `isAbortLike` 里等于「调用方取消」，
 * 而本情形**没有任何调用方取消**（后台任务根本没有 signal 通道，
 * `LlmRuntime.listModels(provider)` 只接受一个参数）。混用会让日志把
 * 「上游挂住」误报成「用户取消了请求」—— 本仓库反复修过的归因错误。
 */
const BACKGROUND_DEADLINE_NAME = 'AggregateCatalogDeadline'

/**
 * 「**单个候选**的能力解析放弃等待」到期时的专用哨兵名。
 *
 * ⚠️ 同样**不得**复用 `AbortError`：那条名字在 `isAbortLike` 里等于「调用方取消」，
 * 而本情形是**我们**不等了（用户没取消）。混用会让 `capabilityOf` 的 catch 分支
 * 把「这个候选暂时问不出来」当成「用户取消了整轮请求」原样抛出去 ——
 * 用户会看到一次莫名其妙的失败，而真相只是某个渠道的元数据读慢了。
 *
 * ⚠️ 与 {@link BACKGROUND_DEADLINE_NAME} 也**必须分开**：那条是「后台目录刷新」的
 * 语义，走的是另一条恢复路径（清在飞标记、保留旧目录），与本处互不相干。
 */
const CAPABILITY_DEADLINE_NAME = 'AggregateCapabilityDeadline'

/** 该错误是否是 {@link withBackgroundDeadline} 的「放弃等待」哨兵。 */
function isBackgroundDeadlineError(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && (error as { name?: unknown }).name === BACKGROUND_DEADLINE_NAME
}

/**
 * 给一个**可放弃等待**的后台 Promise 加一份预算：超时即 reject 一个专用哨兵。
 *
 * ## ⚠️ 它只是「不再等」，**不是取消**
 *
 * 被等待的 `refreshCatalog()` 内部逐渠道 `await ctx.llm.listModels(provider)`，而
 * `LlmRuntime.listModels` **只接受一个参数、没有 signal 通道**
 * （`dsh-llm/lib/index.js` 的 `async listModels(provider)`）⇒ 正在挂住的那次读取
 * **无法中断**。`AbortSignal.timeout` 在这里无效（没人检查它的 `aborted`）。
 *
 * ⇒ 语义只能是「调用方不等了」：**保留旧目录**、清在飞标记让下一轮可以再试，
 * 而被放弃那一轮的结果**照样有效**（它日后 resolve 时仍会写 `this.catalog` 并广播）。
 * 这与 `jet-hub-rpc.ts` 的 `withTimeout` 同一口径（那里也明确写了「不取消底层请求」）。
 *
 * ⚠️ 定时器必须 `unref()`：这是宿主常驻进程里的后台任务，一个 60 秒的
 *    pending 定时器不该拖住宿主退出（与 `auto-checkin.ts` 同约定）。
 */
function withBackgroundDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`aggregate: 后台目录刷新超过 ${ms}ms 仍未返回（放弃等待，不取消上游）`)
      error.name = BACKGROUND_DEADLINE_NAME
      reject(error)
    }, ms)
    // ⚠️ `unref` 在部分运行时不存在（如浏览器环境）⇒ 按结构化判据探测。
    ;(timer as unknown as { unref?: () => void }).unref?.()
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * 该错误是否是「调用方中止」类，而不是「这个候选坏了」类。
 *
 * ⚠️ 两者**必须分开**：中止时换候选会让用户在取消后仍继续跑（且最终抛出的
 * 可能是个误导性的上游错误）。判据取四条：
 * - `signal.aborted` —— 最权威（调用方确实取消了）；
 * - `name === 'AbortError'` —— `throwIfAborted` / `timers/promises` 的形态；
 * - `code === 'ABORTED'` —— 某些适配器上报失败时的机器码；
 * - 🔴 `message` 含 `aborted request` / `HTTP_499` / `HTTP 499` —— **上游网关的
 *   499 口径**（nginx「client closed request」＝ 连接在响应完成前被断开）。
 *   实测（2026-10-11，本会话两次 + 工单 `raccoon-499/01` 取证）：raccoon 网关把
 *   这类断开报成 `provider: client has aborted request HTTP_499` 的 **error 帧**，
 *   三条旧判据全不命中 ⇒ 被归成「本轮运行失败」⇒ 消费者看到误导性的 provider
 *   故障，而真相是「请求没跑完，重发即可」。归 aborted 的语义收益：终端不再
 *   显示「运行失败」，且外层不把它当「候选坏了」去改道（重发是新请求，不是换候选）。
 * ⚠️ **本函数是共享判据**（2026-10-15 导出）：装配层与 `balance-cache` 都应当用它，
 *    而不是各写一份 —— 本仓库此前已有 **4 份**同义实现（本文件、`aggregate-expiry.ts`
 *    的简化版、`auto-adapter.ts`、`raccoon-adapter.ts` 的内联），别再添第五份。
 */
export function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (error === null || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
  if (candidate.name === 'AbortError' || candidate.code === 'ABORTED') return true
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return /aborted request|HTTP_?499/i.test(message)
}

/** 在 `ctx.llm` 上注册聚合路由（幂等）。 */
export function registerAggregateLlm(
  ctx: Context,
  options: AggregateAdapterOptions,
): AggregateAdapter {
  // ⚠️ **注入目录落地广播**（Issue IKJVTF 同款接线，与其余 12 家适配器的
  //   `onCatalogLoaded: () => broadcastCatalogChanged(ctx)` **逐字同构**）。
  //
  // 为什么必须在**装配层**注入而不是让适配器自己 `emit`：适配器拿不到 ctx 的
  // 事件能力契约（12 家都靠这个注入点），且广播实现只允许有一份
  //（`catalog-broadcast.ts`；两份实现必然漂移 —— 本仓库既有约定）。
  //
  // ⚠️ 调用方**显式传了** `onCatalogLanded` 时以它为准（单测替身/自定义装配用），
  //   否则注入默认实现。不要改成「恒覆盖」：那会让替身永远收不到通知。
  const adapter = new AggregateAdapter(ctx, {
    ...options,
    onCatalogLanded: options.onCatalogLanded ?? (() => broadcastCatalogChanged(ctx)),
  })
  registerAdapterIdempotent(
    ctx.llm,
    [AGGREGATE_PROVIDER],
    adapter,
    message => ctx.logger?.warn?.(message),
    // ⚠️ **聚合必须完全不参与「失效模型」机制**（`enabled: false`：不记录、**也不过滤**）
    // —— 真实缺陷（全分支终审 C2 + 审计轮次二补修的残留面）。
    // 本机制是为「**编译期兜底快照**跟不上上游下架」设计的，而聚合层的目录是
    // **动态推导**的（上游下架后下次推导自然消失）⇒ 既不需要记录，也不该被过滤。
    // ① 记录的危害：观察到的是 `aggregate` + **虚拟键**（实测），于是「某一个渠道
    //    没有该 realId」被记成「**整个规范模型**失效」，而它在其余渠道上完全可用；
    //    且恢复入口 `model.clearDead` 的 UI 在设置页 provider 面板里，而客户端
    //    `PROVIDERS` **没有 `aggregate`** ⇒ **没有任何 UI 能恢复**。
    // ② 过滤的危害（补修的那半）：初版只跳过记录、仍保留过滤 ⇒ 若表里**已有**
    //    旧版本写下的 `aggregate` 记录（C2 修复前跑过一次就会有），虚拟模型**仍被
    //    隐藏**且同样无 UI 可恢复。实测探针：预置 `aggregate/m1` 后经真实装配的
    //    `listModels` 只返回 `['auto','m2']`（`m1` 被隐藏）。
    { enabled: false },
  )
  // ⚠️ **注册后主动预热一次目录**（fire-and-forget，不阻塞注册）。
  //
  // 为什么必须预热：`listAllModels()` 被契约要求是**同步**方法，只能读上一次
  // 推导结果；而 `provider.status`（`jet-hub-rpc.ts`）会在**冷缓存**下直接
  // 调它并据条数算 `models.total`，判据是
  // `closed = total > 0 && disabled === total`（该分支即 `provider.status` 的 models.total 判据）。
  // 冷缓存时 `total` 只有 1（`auto`）⇒ 用户一关掉 `auto`，`disabled === total`
  // 即成立 ⇒ `aggregate` 被**误显示为「已关闭」**（掉进设置页的「已关闭」分组）。
  // 预热后 `this.catalog` 在**有已登录渠道时**非空（`refreshCatalog` 只在被调用时
  // 重推、从不主动清空）⇒ `total` 反映真实条目数，该误判不再发生。
  // ⚠️ 全部渠道都未登录时目录**本就**为空（各家 `listModels` 受门控返回 `[]`），
  // `total` 仍为 1 —— 那种状态下聚合确实无模型可选，`closed` 的判定与事实相符。
  //
  // 成本可控：各家的 `listModels` 内部都有 `providerCatalogVisible` 门控
  //（`buddy-adapter.ts` 等，门控在 `ensureRemoteModels()` **之前**）——
  // 未登录的渠道直接返回空目录、不发网络请求；已登录渠道本就会被模型选择器
  // 触发同一批请求，预热只是提前一次，随后 60 秒内走 `AGGREGATE_CATALOG_TTL_MS`。
  //
  // ⚠️ 必须 `.catch()` 兜住：这是 fire-and-forget，未捕获的 rejection 会变成
  // unhandled rejection（注册失败只是目录晚一点就绪，绝不能反噬注册）。
  void adapter.refreshCatalog().catch((error: unknown) => {
    ctx.logger?.warn?.(`[aggregate] 注册后预热目录失败（不影响可用性）：${String(error)}`)
  })
  return adapter
}
