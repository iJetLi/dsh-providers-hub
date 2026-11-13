import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * **Token 账本**（全 provider 的用量流水 + 渠道 × provider × 模型三维聚合）。
 *
 * ## 为什么它必须存在（issue 诉求）
 *
 * 全部适配器在流结束时都已产出 dsh-llm 的标准 `type:'usage'` chunk
 * （`TokenUsage`：`inputTokens / outputTokens / cacheReadTokens /
 * cacheWriteTokens / reasoningTokens / totalTokens`），但解析完就丢弃 ——
 * 用户无法回答「今天用了多少 token」「直连与网关各用多少」。本模块把
 * 「存下来」这一跳补上，**不改任何适配器的推理路径**。
 *
 * ## 记账点：注册收敛层（单点覆盖）
 *
 * 记账由 {@link ./llm-register-compat.ts} 的包装注册调用（每笔请求恰好一次），
 * 不碰 13 个适配器。渠道区分靠网关侧打标（`src/openai-gateway/channel.ts`）：
 * 网关请求在 `GenerateOptions` 上带 `gatewayChannelMark`，读到即 `gateway`，
 * 否则 `direct` —— **精确打标，不是差值估算**。
 *
 * ## 存储是进程内存，重启即丢（刻意，第 1 期与 cline-request-log 同决策）
 *
 * 高频写入的派生数据持久化会把每笔推理变成一次磁盘写；「本周用量」这类
 * 长周期诉求随第 2 期持久化一并做。上限 {@link TOKEN_LEDGER_LIMIT} 条，
 * 写满淘汰最旧。聚合树在读取时按需重建（条数有限，O(n) 足够快，
 * 不为省这点计算引入增量维护的双写复杂度）。
 *
 * ## ⚠️ record() **绝不抛错**：它在推理的关键路径上
 *
 * 与 `src/cline-request-log.ts` 同款约束：这里抛错会把记账失败反噬成
 * 推理失败。所有入参截断/钳制，`Object.freeze` 防止调用方修改共享对象。
 */

/** 一条请求记录。 */
export interface TokenLedgerEntry {
  /** 请求**发起**时刻（毫秒时间戳）。 */
  ts: number
  /** 流量来自哪条通道：DSH 宿主对话 = `direct`；OpenAI 兼容网关 = `gateway`。 */
  channel: 'direct' | 'gateway'
  /** provider id（如 `codearts` / `qoder`）。 */
  provider: string
  /** 模型 id（wire 上的 `model`）。 */
  model: string
  /**
   * **服务本笔请求的账号**（账号池条目 id）。
   *
   * ⚠️ 第 2 期（账号维度）加入。归属口径与 cline-request-log 相同：
   * 以**实际解析出凭据的账号**为准（`resolveCredential` / 池查询回报）。
   * 取不到时为空串 —— 未知账号与「没有账号体系」不能混成一个假 id，
   * 展示层对空串整段不渲染（或归入「未归属」）。
   */
  accountId?: string
  /**
   * 是否收到过 usage chunk。
   *
   * ⚠️ 与「token 为 0」**不是一回事**：没收到 usage（abort / 上游提前断开 /
   * 请求失败）时表格必须显示 `—`，给 0 会被读成「瞬间完成、没花 token」
   * （`cline-request-log` 同约定）。
   */
  usageReported: boolean
  /** 输入 token（未命中缓存的部分，dsh-llm 口径）。 */
  inputTokens: number
  /** 输出 token（含思考 token）。 */
  outputTokens: number
  /** 缓存命中的输入 token（缺失时省略）。 */
  cacheReadTokens?: number
  /** 缓存写入的 token（缺失时省略）。 */
  cacheWriteTokens?: number
  /** 思考 token（缺失时省略；已含在 outputTokens 内）。 */
  reasoningTokens?: number
  /**
   * **首个内容块耗时**（毫秒）—— 用户口中的「首字用时」。
   *
   * 口径 = 收到**内容帧**（文本 / 思考 / 图片 / 工具调用，含各自的 delta 形态）的
   * 时刻 − 请求发起。⚠️ **刻意忽略 `block-start` / `block-end` / `usage` / `finish`
   * 等结构帧与元数据帧**：它们不代表「模型开始说话」，算进去会把首字用时记成
   * 「适配器建流的时刻」（真实缺陷，本次修复；见 `llm-register-compat.ts` 的
   * `isContentChunk`）。
   *
   * ⚠️ **与 `cline-request-log.ttftMs` 有已知分叉**（不要照着这里的措辞去断言两者
   * 一致）：Cline 那一份（`src/cline-adapter.ts` 的 `if (ttftMs === 0) ttftMs = …`）
   * 仍是「**任何** chunk 到达即计时」的旧口径，故「只有结构帧 / 只有 usage 的
   * 空响应」在两处的读数不同（本处省字段、展示为 `—`；Cline 处给出一个非 0 值）。
   * 分叉方向是**本处更严**（更贴近「首字」语义）；Cline 那份的同步属于独立改动，
   * 需连带核对其请求表的展示，本次未动。
   *
   * 0 = 整个流没有产出任何内容帧（失败 / 秒回空），展示层按「不可测」处理
   * （显示 `—`），不显示 0。
   */
  ttftMs?: number
  /**
   * 全程耗时里**扣除首块之后**的输出速率（tok/s）。
   *
   * 口径对齐官方（`tokens-per-second.js` 抄的 DeepSeek 口径）：分子是
   * **全部输出 token（含思考）**，分母 = `durationMs − ttftMs`（首块之后
   * → 结束）。任一前提缺失（无 usage / 无首块 / 分母 ≤ 0）时**省略字段** ——
   * 不可测与 0 tok/s 是两回事。
   */
  tps?: number
  /** 全程耗时（毫秒）。 */
  durationMs: number
  /** 失败原因；成功行省略。 */
  error?: string
}

/** 渠道 → provider → 账号 → 模型 聚合里模型粒度的一行。 */
export interface TokenLedgerModelRow {
  model: string
  /** 请求数（含失败）。 */
  requests: number
  /** 收到过 usage 的请求数（usageReported = true 的子集）。 */
  reportedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** 总处理量 = 未命中缓存的输入 + 缓存命中输入 + 输出；缓存写入不重复计入。 */
  totalTokens: number
  /** 失败请求数。 */
  errors: number
  /**
   * 平均首字用时（毫秒）—— **只对有实测值（ttftMs > 0）的请求取均值**。
   * 失败/秒回空（ttftMs 缺省）的请求不摊薄均值；无任何可测请求时为
   * `undefined`（显示 `—`，与「平均 0ms」严格区分）。
   */
  avgTtftMs?: number
  /**
   * 平均输出速率（tok/s）—— 对**有 tps 实测值**的请求取均值（不加权，
   * 「每笔请求的速率」的算术平均，口径与用户直觉一致）。无可测请求时
   * `undefined`。
   *
   * ⚠️ **是算术均值，对离群样本敏感**：保留该字段以兼容既有口径；同时提供
   * 基于持久化直方图估算的 P50/P90，便于观察典型速度和慢速尾部。
   *
   * ⚠️ 已落盘的 `tpsSum/tpsCount` 仍可能含早期离群样本；P50/P90 从直方图完整
   * 覆盖样本后才显示，避免把不完整的分布误当成完整统计。
   */
  avgTps?: number
  /** 日志 TPS 直方图估算的中位数与 P90；旧账本没有样本时省略。 */
  p50Tps?: number
  p90Tps?: number
}

/** 一个 provider 下、某个账号的聚合（模型行 + 自身小计）。 */
export interface TokenLedgerAccountRow {
  /**
   * 账号池条目 id。
   *
   * ⚠️⚠️ **两条聚合路径的空值形态不一样，两种都必须认**（2026-11-13 PR #69 双向审计）：
   * - **内存聚合**（本文件 `:781` 附近）与**落盘日聚合**（`:1055` 附近）都用哨兵
   *   **`'-'`** —— `Map` 的键不能缺失，所以「凭据没回报账号」的请求统一落 `'-'` 桶。
   *   `'-'` 是**真实存在的分组**（`channel: false` 的纯签到渠道命中的就是它），不是脏数据。
   * - **明细**（`TokenLedgerEntry.accountId`）同样情形是**空串**（可选字段，取不到就没有）。
   *
   * 客户端因此必须两条腿都在：`'-'` 渲染成「（未知帐号）」、空串渲染成「未归属」，
   * 其余原样显示（见 `plugin-src/client/token-ledger-panel.js` 的 `accountLabel`）。
   * 只写「空串」一种形态会让 `'-'` 原样漏到界面上（本 PR 修的正是这条）。
   */
  accountId: string
  models: TokenLedgerModelRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
}

/** 一个 provider 下的聚合（账号行 + 自身小计）。 */
export interface TokenLedgerProviderRow {
  provider: string
  accounts: TokenLedgerAccountRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
}

/** 一个渠道下的聚合（provider 行 + 自身小计）。 */
export interface TokenLedgerChannelRow {
  channel: 'direct' | 'gateway'
  providers: TokenLedgerProviderRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
}

/** 读侧返回：三维聚合树 + 全局小计 + 最近明细。 */
export interface TokenLedgerSnapshot {
  channels: TokenLedgerChannelRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
  /** 最近明细（最新在前），`entries` 的条数即 `limit`（不超上限）。 */
  entries: TokenLedgerEntry[]
}

/** 流水上限。500 条足够回溯近期活动，内存占用可忽略。 */
export const TOKEN_LEDGER_LIMIT = 500

/**
 * TPS 计算的**最小解码时长**（毫秒）：短于此值 ⇒ 该笔不可测，不计入均值。
 *
 * ⚠️ 为什么是 100 而不是 0（用户 2026-10-07 报障「982.5 tok/s」）：`decodeMs`
 * 是「首块之后 → 结束」，当这两个时刻几乎贴在一起时它会塌缩到个位数毫秒，
 * 除出来的速率高达数十万 tok/s。100ms 的门槛覆盖了「至少出了一小段正文」的
 * 情形 —— 单流文本生成的正常首段就远超 100ms，故此门槛**不会**误伤真实样本。
 *
 * ⚠️ 该门槛只影响**新增**记账；已落盘的 `tpsSum/tpsCount` 仍是污染值
 * （见 `flush`/迁移说明）。
 */
export const MIN_DECODE_MS_FOR_TPS = 100

/**
 * 关闭上游流时的**等待上限**（毫秒），见 {@link withTokenLedgerAccountContext}。
 *
 * ⚠️ 为什么必须有：关闭动作挂起时，`finally` 永不返回，会把「本层已捕获的错误」
 * 一起吞掉 —— 消费方永久卡在 `for await` 里（与「停止按钮无效」同型的症状）。
 *
 * ⚠️⚠️ **超时的确切语义（实测，勿再写错）**：它是**放弃等待**，**不是取消动作**。
 * 实测时间线（上游关闭耗时 3s）：
 * ```
 * return() 开始      @1ms     ← break 后本层立刻转发了关闭信号
 * 消费方 break 返回   @2004ms  ← 2s 超时到，不再等
 * 上游清理完成        @3009ms  ← 被"放弃"等待的那个 promise 仍在后台跑完
 * ```
 * ⇒ 上游清理（`releaseLock()` / `removeEventListener()` / `sigStore.flush()`）
 * **最终仍会执行**，只是消费方不再阻塞等它。
 * ⚠️ **本注释曾错误地写成「清理永不执行 / 永久停在 await 上」**（首版实现 + 两轮
 * 审计都这么写，属未经验证的推断）；实测推翻了它，故按事实更正。
 *
 * ⚠️ 真实代价因此是**有界**的：清理完成前上游资源（连接 / reader / 监听器）仍占着，
 * 且高频取消时会有若干个清理在后台并发堆积 —— 但不会永久泄漏。
 * ⚠️ 也**不要**因为「偶尔超时也不报错」就忽略它：若日志里频繁出现，说明某些适配器
 * 的清理动作确实很慢甚至挂起，应去修那个适配器，而不是调大这个值。
 */
export const CLOSE_STREAM_TIMEOUT_MS = 2_000

/** 稀疏对数直方图：每八分之一倍频程一个桶，覆盖 0.1 到约 1.5M tok/s。 */
export const TPS_HISTOGRAM_BINS = 192
const TPS_HISTOGRAM_MIN = 0.1
const TPS_HISTOGRAM_STEPS_PER_OCTAVE = 8

function tpsBin(value: number): number {
  return Math.min(TPS_HISTOGRAM_BINS - 1, Math.max(0,
    Math.floor(Math.log2(Math.max(value, TPS_HISTOGRAM_MIN) / TPS_HISTOGRAM_MIN)
      * TPS_HISTOGRAM_STEPS_PER_OCTAVE),
  ))
}

function tpsBinRepresentative(bin: number): number {
  const value = TPS_HISTOGRAM_MIN * 2 ** ((bin + 0.5) / TPS_HISTOGRAM_STEPS_PER_OCTAVE)
  return Math.round(value * 10) / 10
}

function addTpsSample(histogram: Record<string, number>, value: number): void {
  const key = String(tpsBin(value))
  histogram[key] = (histogram[key] ?? 0) + 1
}

function mergeTpsHistograms(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
  subtract = false,
): Record<string, number> {
  const out: Record<string, number> = { ...(a ?? {}) }
  for (const [key, value] of Object.entries(b ?? {})) {
    const next = (out[key] ?? 0) + (subtract ? -value : value)
    if (next > 0) out[key] = next
    else delete out[key]
  }
  return out
}

function histogramQuantile(histogram: Record<string, number>, quantile: number): number | undefined {
  const entries = Object.entries(histogram)
    .map(([key, count]) => [Number(key), count] as const)
    .filter(([bin, count]) => Number.isInteger(bin) && bin >= 0 && bin < TPS_HISTOGRAM_BINS && count > 0)
    .sort(([a], [b]) => a - b)
  const total = entries.reduce((sum, [, count]) => sum + count, 0)
  if (total === 0) return undefined
  const target = Math.ceil(total * quantile)
  let seen = 0
  for (const [bin, count] of entries) {
    seen += count
    if (seen >= target) return tpsBinRepresentative(bin)
  }
  return undefined
}

function histogramSampleCount(histogram: Record<string, number>): number {
  return Object.values(histogram).reduce((sum, count) => sum + count, 0)
}

/** 内存中的流水（最新在前）。 */
let ledger: TokenLedgerEntry[] = []

/**
 * 「该 provider 最近一次解析出的账号」**兜底**注册表（第 2 期 · 账号维度）。
 *
 * ## 为什么是「最近一次」而不是「本次」
 *
 * 账号归属的**权威**来源在各适配器内部（`currentAccountId` 局部变量），
 * 包装层（`recordThroughStream`）看不到它。为不重写 13 个适配器，采用
 * **侧信道回报**：`index.ts` 的 `resolveCredential` 回调与各适配器的
 * 凭据解析点调用 {@link reportLedgerAccount}，包装层在**收到 usage 帧**
 * 时读取（彼时凭据必然已解析，见 `llm-register-compat.ts` 的时序说明）。
 *
 * ## ⚠️ 生产路径已**不再读这张表**（如实记录，勿据旧注释推断它有用）
 *
 * 每个记账流通过 AsyncLocalStorage 持有独立账号上下文，并发请求不会互相覆盖，
 * 流内换号时适配器的后续回报会更新当前请求归属。**当前生产装配下所有
 * `reportLedgerAccount` 调用点都落在 ALS 上下文内**（`prepareCall` 与返回的
 * `call.stream` 都由包装层包住），因此 {@link reportLedgerAccount} 的 `else` 分支
 * （写本表）与 {@link peekLedgerAccount} 的回退读**在生产不可达** ——
 * 两者现在只服务单测。
 *
 * ⚠️ **仍然保留，不删**：它是「ALS 上下文外回报」的**防御性兜底** —— 将来若有
 * 新的初始化路径（例如某 provider 在 `prepareCall` 之前就解析凭据）在上下文外
 * 回报，有表则归属仍能落到账本，删掉则**静默丢失**该归属。代价只是一张极小的
 * Map（按 provider 去重，条数 ≤ provider 数）。
 * ⚠️ 与之配套的**旧注释「用于尚未进入记账流的初始化路径」是不实的**（该路径在
 * 本仓库中不存在），故此处改写为「防御性兜底」，避免后来者以为它正在生效。
 */
const reportedAccounts = new Map<string, string>()
const requestAccount = new AsyncLocalStorage<{ accountId: string }>()

/** 为一次调用创建可跨 prepareCall 与 stream 传递的账号上下文。 */
export function createTokenLedgerAccountContext(): { accountId: string } {
  return { accountId: '' }
}

/** 在指定调用上下文中执行同步或异步工作。 */
export function runWithTokenLedgerAccountContext<T>(
  context: { accountId: string },
  action: () => T,
): T {
  return requestAccount.run(context, action)
}

/**
 * 回报本请求解析出的账号（凭据解析点调用）。
 *
 * ⚠️ 绝不抛错：它与 {@link recordTokenUsage} 同在推理关键路径上。
 * 空串 / 非串入参直接忽略（不清空旧值 —— 清空语义属于 {@link clearLedgerAccount}）。
 */
export function reportLedgerAccount(provider: string, accountId: string): void {
  try {
    if (typeof provider !== 'string' || provider.length === 0) return
    if (typeof accountId !== 'string' || accountId.length === 0) return
    const scoped = requestAccount.getStore()
    if (scoped !== undefined) {
      scoped.accountId = accountId.slice(0, 64)
      return
    }
    reportedAccounts.set(provider.slice(0, 64), accountId.slice(0, 64))
  } catch {
    // 回报失败绝不反噬推理。
  }
}

/**
 * 读取该 provider 当前记录的账号。
 *
 * ⚠️ **生产路径已不再调用本函数**（`recordThroughStream` 改为只读 ALS 上下文的
 * `accountContext`）—— 它现在只服务单测，以及「上下文外回报」的防御性回退读
 * （见 {@link reportedAccounts} 的长注释）。保留理由与代价写在那里，**不要**
 * 因为「只有测试用」就删掉：删了会让上下文外的回报彻底无处可读。
 */
export function peekLedgerAccount(provider: string): string {
  const scoped = requestAccount.getStore()?.accountId
  if (scoped) return scoped
  return reportedAccounts.get(provider) ?? ''
}

/**
 * 每次推进异步流时绑定独立上下文，避免并发请求串用账号归属。
 *
 * ⚠️⚠️ **必须转发 `return()` / `throw()` 到内层迭代器**（真实缺陷，本包装器首版
 * 漏了这一层）。手写 `while + yield` 的生成器**不会**自动把消费方的关闭信号传给
 * 它包着的迭代器 —— V8 在 `yield` 处收到 `return()` 时只关闭**本**生成器，`finally`
 * 之后的 `iterator.return()`（如果没写）根本不存在。后果：消费方提前关流时，
 * 上游适配器的 `finally` **永不执行** ⇒ SSE `reader.releaseLock()` 不执行、
 * zcode 的 `clearTimeout` / `removeEventListener` 不执行 ⇒ 用户点「停止」后连接与
 * 定时器一齐泄漏（与 `providers-zcode` 的「卡住 + 停止按钮无效」同型）。
 *
 * ⚠️ 消费侧确实会调它：`dsh-llm` 在流未读完时 `finally { await iterator.return() }`；
 * `dsh-agent-loop` 的取消路径是 `signal.throwIfAborted()` 在循环体内**抛错**。
 * 两条路径都要求这里转发 —— 只转发 `return()` 挡不住 `throw()`，故用 `try/finally`
 * 兜住「未正常结束」的所有情形（正常 `done` 时 `return()` 是 no-op）。
 *
 * ⚠️ 转发动作本身**也要在 ALS 上下文内**执行：清理期间若有 `reportLedgerAccount`
 * 回报，落回全局表会污染其他并发请求的归属。
 *
 * ⚠️⚠️ **关闭阶段必须有超时**：`finally` 里若直接 `await iterator.return()`，而上游的
 * 关闭动作**迟迟不 resolve**（例如适配器 `finally` 里 `await reader.cancel()` 卡在一个
 * 已经断开的连接上），那么 `finally` 永不返回 ⇒ **本层已经捕获到的错误永远传不出去**，
 * 消费方（`dsh-agent-loop`）会卡在 `for await` 里。实测：上游 `next()` 抛
 * `upstream-500` + `return()` 挂起时，无超时版本判为 `HUNG`（错误被吞），加超时后
 * 原始错误照常上抛。这与 `providers-zcode` 的「卡住 + 停止按钮无效」同型，故不能省。
 *
 * ⚠️ 超时是**放弃等待**而非**取消动作**（实测语义，详见 {@link CLOSE_STREAM_TIMEOUT_MS}
 * 的注释）：转发出去的关闭 promise 仍在后台跑完，上游清理最终仍会发生。故本层
 * 只保证「消费方不被关流拖住 + 原始错误不被吞」，**不保证**清理此刻已完成。
 */
export async function* withTokenLedgerAccountContext<T>(
  iterable: AsyncIterable<T>,
  context: { accountId: string },
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  let completed = false
  try {
    while (true) {
      const result = await requestAccount.run(context, () => iterator.next())
      if (result.done) {
        completed = true
        return
      }
      yield result.value
    }
  } finally {
    // 正常走完（done）时无需再关；只有「被提前关闭 / 抛错」才需要把信号传下去。
    // ⚠️ 多条路径都被这一处覆盖：外部 `break`、`for await` 循环体抛错（消费侧会调
    // `return()`）、以及显式 `iterator.throw()` —— 后者的错误在本 finally 之后继续
    // 向上传播，这里的清理不吞掉它。
    if (!completed) {
      // ⚠️ 超时不可省，见函数 doc 末段：关闭动作挂起会**永久掩盖**原始错误。
      // ⚠️ 定时器必须在 race 结束后 `clearTimeout`：否则每次提前关闭都留一个 2 秒的
      // 待触发定时器（实测 50 次取消 = 50 个），靠 `unref` 才不拖住进程退出。
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.resolve(requestAccount.run(context, () => iterator.return?.())),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, CLOSE_STREAM_TIMEOUT_MS)
            // ⚠️ `unref`：关闭超时不该拖住进程退出（浏览器/测试环境可能没有）。
            timer.unref?.()
          }),
        ])
      } catch {
        // 关闭内层失败不得覆盖调用方已得到的错误/结果。
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  }
}

/** 诊断用：注册表当前条数。 */
export function ledgerAccountCount(): number {
  return reportedAccounts.size
}

/** 测试专用：清空回报表。 */
export function resetLedgerAccountsForTests(): void {
  reportedAccounts.clear()
}

/**
 * 日聚合存储后端的**最小契约**（`token-ledger-store.ts` 的实现满足它）。
 *
 * 只声明记账侧真正用到的两个方法 —— 账本模块刻意不 import store 的实现，
 * 以免把 `node:fs` 拖进纯逻辑模块（该模块要能在无盘环境被单测）。
 */
export interface TokenLedgerBackend {
  /** 把一笔请求并入日聚合（内存即时、落盘节流）。 */
  append(entry: TokenLedgerEntry): void
  /** 读取日聚合表（**纯内存读**，不碰磁盘 —— 见 store 的注释）。 */
  load(): TokenLedgerDayMap
  /** 删除单个 UTC+8 日期的历史累计。 */
  deleteDay?(day: string): boolean
}

/**
 * 日聚合后端的**挂载点**（第 2 期 · 落盘 / 第 4 期 · 历史视图共用）。
 *
 * 由 `index.ts` 在插件启动时 {@link attachTokenLedgerStore} 注入；记账路径只调
 * `append`，RPC 只调 `load` —— 与 `record()` 绝不抛错同款约束，持久化失败绝不能
 * 反噬推理。
 *
 * ⚠️ 原先拆成「持久化钩子」与「历史读取器」**两个**独立的挂载点，由 `index.ts`
 * 分别挂、分别摘。那带来了一个真实风险：插件 fiber 重启时新 apply 与旧 fiber 的
 * 异步 dispose **交错执行**（本仓库已确证的事故，见 `llm-register-compat.ts`
 * 模块头），旧实例的 dispose 会把**新实例刚挂上**的钩子一并摘空 ⇒ 落盘彻底停摆
 * 且历史视图恒为空。现在合并为**一个**挂载点，并在 dispose 时做**所有权校验**。
 */
let backend: TokenLedgerBackend | undefined

/**
 * 当前挂载的**唯一身份令牌**。
 *
 * ⚠️ 不能用 `backend === owned` 做判据（审计发现并已复现）：后端对象可能被
 * **同一个对象重复挂载**，此时两个 disposer 的 `owned` 都等于 `backend`，
 * 先调用的那个会把后一次挂载误摘掉。用每次挂载**新生成**的令牌做判据即可根治
 * —— 令牌永不复用，且 `undefined` 之间也不会互相误判。
 */
let backendToken: object | undefined

/**
 * 注入日聚合后端，返回**该次挂载专属的 disposer**。
 *
 * ⚠️ 返回的 disposer 只在「当前挂载的仍是我自己」时才清空 —— 这样 fiber 重启
 * 交错时，旧实例的 dispose 不会摘掉新实例的挂载（见 {@link backend} 的说明）。
 *
 * ⚠️ **幂等性由令牌判据单独提供，不再另设 `disposed` 标志**（审计发现）：
 * 曾经有一个 `if (disposed) return` 守卫，但它是**不可观测的冗余** —— 令牌每次
 * 挂载都新生成且永不复用，故 disposes 重入时 `backendToken === token` 必然为假、
 * 必然让位；删掉守卫行为完全相同（变异测试：删掉后 24 条用例仍全绿，证明它
 * 无法被任何时序观测到）。与其保留一段无用例覆盖、只在注释里声称"幂等"的代码，
 * 不如把它删掉，让"幂等来自令牌判据"成为**唯一**且可被用例锁定的事实。
 *
 * @param next - 后端实现；传 `undefined` = 卸载（测试隔离用）。
 */
export function attachTokenLedgerStore(next: TokenLedgerBackend | undefined): () => void {
  backend = next
  // 每次挂载都换一个新令牌（即使 next 是 undefined、或与上次是同一个对象）。
  const token: object = {}
  backendToken = token
  return () => {
    // ⚠️ 只摘自己的：令牌不匹配说明期间已被别的实例接管（或本 disposer 已被调用
    // 过一次 —— 那时 backendToken 已换代或清空，故重入天然是空操作）。
    if (backendToken === token) {
      backend = undefined
      backendToken = undefined
    }
  }
}

/** RPC 侧读取日聚合表；未挂载（headless 等）返回空表。 */
export function readTokenLedgerDayMap(): TokenLedgerDayMap {
  return backend?.load() ?? new Map()
}

/** 日期键必须是真实日历日期，避免把任意值传入持久化删除接口。 */
export function isValidTokenLedgerDayKey(day: unknown): day is string {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const parsed = new Date(`${day}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day
}

/**
 * 删除历史日累计，不改进程内实时流水（`entries`）及其他任何状态。
 * 持久化后端同步完成删除；没有可删除能力或日期无效时返回 false。
 */
export function deleteTokenLedgerDay(day: string): boolean {
  if (!isValidTokenLedgerDayKey(day)) return false
  return backend?.deleteDay?.(day) ?? false
}

/**
 * **UTC+8 日键**（`YYYY-MM-DD`）。
 *
 * ⚠️ 必须用**算术**换算（+8h 后取 UTC 日期），绝不能用 `Date.setHours` 等
 * 本机时区方法 —— 与 `qoder-adapter.ts` 的 `nextUtc8DayStartMs` 同一条纪律：
 * 各渠道的每日额度都按 UTC+8 结算，本机时区不同（出差/改设置）会算错日界。
 */
export function utc8DayKey(ts: number): string {
  const shifted = new Date(ts + 8 * 60 * 60 * 1000)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${month}-${day}`
}

/** 数值字段的统一钳制：非有限值/负数 → 0，截断小数。 */
function clampCount(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

/**
 * 记录一笔请求。
 *
 * ⚠️ **本函数绝不抛错**（见模块头）。字段全部截断/钳制，写满即淘汰最旧。
 */
export function recordTokenUsage(entry: Omit<TokenLedgerEntry, 'ts'>): void {
  try {
    const usageReported = entry.usageReported === true
    const cacheRead = clampCount(entry.cacheReadTokens)
    const cacheWrite = clampCount(entry.cacheWriteTokens)
    const reasoning = clampCount(entry.reasoningTokens)
    // 账号：空串/缺失统一省略字段（「未归属」与「空账号」不伪造）。
    const accountId = typeof entry.accountId === 'string' ? entry.accountId.slice(0, 64) : ''
    const ttft = clampCount(entry.ttftMs)
    const duration = clampCount(entry.durationMs)
    const outputTokens = clampCount(entry.outputTokens)
    // TPS（官方口径）：分子 = 全部输出 token（含思考），分母 = 首块之后 → 结束。
    //
    // ⚠️ **分母必须设下限**（真实缺陷，用户 2026-10-07 报障）：原判据只有
    // `decodeMs > 0`，于是「首块与结束几乎同时发生」的样本（空回复 / 纯 usage 帧 /
    // 上游秒回 200 但正文为空 / 被 cancel）算出 1269 ÷ 0.001s = **126 万 tok/s**。
    // 单笔这样的样本就能把该渠道的均值从 ~180 拉到 **60 万**（实测复现）——
    // 用户界面显示 lobsterai「982.5 tok/s」，而真实值在 50~200 量级。
    //
    // ⚠️ 为什么不用「钳制分母」而要**整体丢弃该样本**：把 decodeMs 抬到
    // MIN_DECODE 只是把那笔的离谱值换成另一个离谱值（仍是假数据，且看起来
    // 「有值」无从分辨）。不测量的东西应当不出现，而不是被修正成一个看似
    // 合理的数 —— 与 ttft「0 = 无任何块 ⇒ 省略」同一条纪律。
    const decodeMs = duration - ttft
    const rawTps = ttft > 0 && decodeMs >= MIN_DECODE_MS_FOR_TPS && usageReported
      ? outputTokens / (decodeMs / 1000)
      : undefined
    const tps = rawTps !== undefined && Number.isFinite(rawTps)
      ? Math.round(rawTps * 10) / 10
      : undefined
    const record = Object.freeze({
      ts: Date.now(),
      // channel 只认两个合法值，垃圾值一律落回 `direct`（保守缺省）。
      channel: entry.channel === 'gateway' ? 'gateway' : 'direct',
      provider: String(entry.provider ?? '').slice(0, 64),
      model: String(entry.model ?? '').slice(0, 160),
      ...(accountId.length > 0 ? { accountId } : {}),
      usageReported,
      inputTokens: clampCount(entry.inputTokens),
      outputTokens,
      // ⚠️ 0 / 缺失一律**省略字段**而不是写 0：与接口注释一致，
      // 「没有缓存命中」与「命中 0 个」无从区分时，缺省是更诚实的表示。
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
      ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
      // 首字用时：0 = 无任何块（失败/秒回空）⇒ 省略（不可测 ≠ 0ms）。
      ...(ttft > 0 ? { ttftMs: ttft } : {}),
      ...(tps !== undefined ? { tps } : {}),
      durationMs: duration,
      ...(typeof entry.error === 'string' && entry.error.length > 0
        ? { error: entry.error.slice(0, 200) }
        : {}),
    }) as TokenLedgerEntry
    ledger.unshift(record)
    if (ledger.length > TOKEN_LEDGER_LIMIT) ledger.length = TOKEN_LEDGER_LIMIT
    // 每日聚合落盘（第 2 期）：后端内部自己节流与兜错，这里不再包 try ——
    // 挂载契约要求 append 绝不抛错（见 attachTokenLedgerStore 的说明）。
    try {
      backend?.append(record)
    } catch {
      // 持久化失败绝不反噬推理（双重防御：后端违约也不炸）。
    }
  } catch {
    // 记账失败绝不反噬推理（见函数注释）。
  }
}

/** 空聚合行（防重复初始化代码）。返回**累加形态**，finalize 由读取层收尾。 */
function emptyTotals(): AccumulatingTotals {
  return {
    requests: 0,
    reportedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    errors: 0,
    // 均值的**累加器**：先攒 Σ 与份数，读取收尾时才算除法（见 finalizeAverages）。
    ttftSumMs: 0,
    ttftCount: 0,
    tpsSum: 0,
    tpsCount: 0,
    tpsHistogram: {},
  }
}

/** 聚合行的内部形态：均值以 Σ/份数 累加，最终快照前收尾成 `avgXxx`。 */
export interface AccumulatingTotals extends Omit<TokenLedgerModelRow, 'model' | 'totalTokens' | 'p50Tps' | 'p90Tps'> {
  ttftSumMs: number
  ttftCount: number
  tpsSum: number
  tpsCount: number
  tpsHistogram: Record<string, number>
}

/**
 * Σ/份数 → 均值（无样本时省略字段；均值取 1 位小数与 TPS 精度对齐）。
 *
 * ⚠️ **逐字段显式挑选，不得写成 `{...t}` 展开**：`AccumulatingTotals` 比
 * `TokenLedgerModelRow` 多四个**内部累加器**（`ttftSumMs` / `ttftCount` /
 * `tpsSum` / `tpsCount`）。展开会把它们一并带进返回值 —— 类型签名声明的是
 * `Omit<TokenLedgerModelRow,'model'>`，于是「类型与实际不符」：这四个字段会真的
 * 下发到 RPC 载荷（UI 不读 = 纯虚胖），更危险的是调用方若误用 `ttftSumMs`
 * 会拿到 **Σ 而不是均值**（名字只差一个 `avg`）。
 */
function finalizeAverages(t: AccumulatingTotals): Omit<TokenLedgerModelRow, 'model'> {
  /**
   * v1 日桶没有分布数据 ⇒ 只在「直方图覆盖全部 TPS 样本」时才公布分位数。
   *
   * ⚠️ **判据刻意是严格相等**（不是 `> 0`）：直方图只覆盖**升级后**的样本，而
   * `tpsCount` 含升级前累计的样本；两者同增但差值恒定，故**升级前已累计过速率
   * 样本**的日期永不满足 —— 这是**有意的**「不把不完整分布冒充完整统计」，代价是
   * 该日期在 90 天保留期内一直不显示 P50/P90（README 已如实写明，不要再改回
   * 「暂不显示」那种会让人以为会自愈的说法）。
   *
   * ⚠️ **精确边界**（红队复审指出，勿写成「升级前的日期都不显示」）：若某日升级前
   * 就只有请求、**一个速率样本都没累计**（`tpsCount === 0`，例如当天全是失败请求），
   * 升级后新增的样本会让等式成立 ⇒ **该日会正常显示分位数**。差异在「有没有历史
   * 样本」，不在「日期新不新」。
   *
   * ⚠️ 也别改成 `histogramSampleCount(t.tpsHistogram) > 0` 来「让它早点显示」：
   * 那会把「只有最近几笔新样本」的分布当成全天分布，P50/P90 会有系统性偏差
   * 且比现在更难解释（样本量越小偏差越大，而 UI 无法表达「样本不足」）。
   */
  const hasCompleteTpsHistogram = histogramSampleCount(t.tpsHistogram) === t.tpsCount
  const p50Tps = hasCompleteTpsHistogram ? histogramQuantile(t.tpsHistogram, 0.5) : undefined
  const p90Tps = hasCompleteTpsHistogram ? histogramQuantile(t.tpsHistogram, 0.9) : undefined
  return {
    requests: t.requests,
    reportedRequests: t.reportedRequests,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    reasoningTokens: t.reasoningTokens,
    errors: t.errors,
    totalTokens: t.inputTokens + t.cacheReadTokens + t.outputTokens,
    ...(t.ttftCount > 0 ? { avgTtftMs: Math.round(t.ttftSumMs / t.ttftCount) } : {}),
    ...(t.tpsCount > 0 ? { avgTps: Math.round((t.tpsSum / t.tpsCount) * 10) / 10 } : {}),
    ...(p50Tps !== undefined ? { p50Tps } : {}),
    ...(p90Tps !== undefined ? { p90Tps } : {}),
  }
}

/** 把一条记录累加进聚合行。 */
function accumulate(totals: AccumulatingTotals, entry: TokenLedgerEntry): void {
  totals.requests += 1
  if (entry.usageReported) totals.reportedRequests += 1
  if (entry.error !== undefined) totals.errors += 1
  // 均值的样本采集：**只收有实测值**的请求。失败/秒回空（ttft 缺省）与
  // 不可测 TPS 不参与 —— 它们没有测量值，混进去等于用「没测到」摊薄「测到的」。
  if (entry.ttftMs !== undefined && entry.ttftMs > 0) {
    totals.ttftSumMs += entry.ttftMs
    totals.ttftCount += 1
  }
  if (entry.tps !== undefined && entry.tps > 0) {
    totals.tpsSum += entry.tps
    totals.tpsCount += 1
    addTpsSample(totals.tpsHistogram, entry.tps)
  }
  // ⚠️ 只有 usageReported 的行才计入 token 汇总：失败行/未报行写 0 会把
  // 「没收到用量」混进「真的用了 0」，摊薄均值类读数。
  if (!entry.usageReported) return
  totals.inputTokens += entry.inputTokens
  totals.outputTokens += entry.outputTokens
  totals.cacheReadTokens += entry.cacheReadTokens ?? 0
  totals.cacheWriteTokens += entry.cacheWriteTokens ?? 0
  totals.reasoningTokens += entry.reasoningTokens ?? 0
}

/** 排序键：token 合计降序（谁烧得多谁在前），纯读取层约定。 */
function sumTokens(t: Omit<TokenLedgerModelRow, 'model'>): number {
  return t.totalTokens
}

/** 汇总一份内部统计或日桶；分位数直方图与计数同步合并。 */
function addAggregateTotals(
  target: AccumulatingTotals,
  source: AccumulatingTotals | TokenLedgerDayBucket,
): void {
  target.requests += source.requests
  target.reportedRequests += source.reportedRequests
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.reasoningTokens += source.reasoningTokens
  target.errors += source.errors
  target.ttftSumMs += source.ttftSumMs
  target.ttftCount += source.ttftCount
  target.tpsSum += source.tpsSum
  target.tpsCount += source.tpsCount
  target.tpsHistogram = mergeTpsHistograms(target.tpsHistogram, source.tpsHistogram)
}

/**
 * 读取账本快照（聚合树 + 全局小计 + 最近明细）。
 *
 * 纯读取、不改状态；每次按需重建聚合树（见模块头「不为 O(n) 引入双写」）。
 * 聚合与明细都来自同一份 `ledger`，**天然同源**——不存在「树与小计各算一遍」
 * 的口径漂移。各级排序：渠道按 `direct → gateway`、provider/账号/模型按 token
 * 合计降序（谁烧得多谁在前）。
 */
export function readTokenLedger(options: { limit?: number } = {}): TokenLedgerSnapshot {
  const limit = Math.max(0, Math.min(options.limit ?? TOKEN_LEDGER_LIMIT, TOKEN_LEDGER_LIMIT))

  // ── 第一遍：逐条累加进四级聚合（全局小计顺路算出）──
  // ⚠️ 各级小计都是 **AccumulatingTotals**（Σ/份数累加）—— 父级均值必须由
  // 「全部样本的 Σ/份数」算出，若按「子级均值再平均」会在样本数不等时算错
  //（3 笔 100ms 与 1 笔 200ms，先平均再平均得 150，正确值 125）。
  const totals = emptyTotals()
  /** channel → provider → account → model → 聚合行（累加形态） */
  const channelMap = new Map<TokenLedgerEntry['channel'], Map<string, Map<string, Map<string, AccumulatingTotals>>>>()
  for (const entry of ledger) {
    accumulate(totals, entry)
    let providers = channelMap.get(entry.channel)
    if (providers === undefined) {
      providers = new Map()
      channelMap.set(entry.channel, providers)
    }
    let accounts = providers.get(entry.provider)
    if (accounts === undefined) {
      accounts = new Map()
      providers.set(entry.provider, accounts)
    }
    // ⚠️ 空账号统一落 `'-'` 桶（Map 键不能缺失）：它是**真实存在的分组**
    // （「未归属」——凭据解析没回报的请求），不能并进任何一个账号。
    const accountKey = entry.accountId !== undefined && entry.accountId.length > 0 ? entry.accountId : '-'
    let models = accounts.get(accountKey)
    if (models === undefined) {
      models = new Map()
      accounts.set(accountKey, models)
    }
    let row = models.get(entry.model)
    if (row === undefined) {
      row = emptyTotals()
      models.set(entry.model, row)
    }
    accumulate(row, entry)
  }

  // ── 第二遍：把 Map 树落成数组并逐级求小计（父级 = 子级之和，Σ/份数直加）──
  // 收尾顺序：模型行 → 账号小计 → provider 小计 → 渠道小计 → 全局小计，
  // 每级在「把 Σ/份数交给父级之后」才 finalize（finalize 只做除法不改 Σ）。
  const channels: TokenLedgerChannelRow[] = [...channelMap.entries()]
    .sort(([a], [b]) => (a === 'direct' ? -1 : 1) - (b === 'direct' ? -1 : 1))
    .map(([channel, providers]) => {
      const channelTotals = emptyTotals()
      const providerRows: TokenLedgerProviderRow[] = [...providers.entries()].map(([provider, accounts]) => {
        const providerTotals = emptyTotals()
        const accountRows: TokenLedgerAccountRow[] = [...accounts.entries()].map(([accountId, models]) => {
          const accountTotals = emptyTotals()
          const modelRows: TokenLedgerModelRow[] = [...models.entries()].map(([model, row]) => {
            // 账号小计 = 其各模型行之和（Σ/份数直加，均值收尾在后面）
            addAggregateTotals(accountTotals, row)
            return { model, ...finalizeAverages(row) }
          }).sort((a, b) => sumTokens(b) - sumTokens(a))
          // provider 小计 = 其各账号之和
          addAggregateTotals(providerTotals, accountTotals)
          return { accountId, models: modelRows, totals: finalizeAverages(accountTotals) }
        }).sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
        // 渠道小计 = 其各 provider 之和
        addAggregateTotals(channelTotals, providerTotals)
        return { provider, accounts: accountRows, totals: finalizeAverages(providerTotals) }
      }).sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
      return { channel, providers: providerRows, totals: finalizeAverages(channelTotals) }
    })

  return {
    channels,
    totals: finalizeAverages(totals),
    entries: ledger.slice(0, limit),
  }
}

/**
 * 测试与 dispose 专用：清空账本。
 *
 * ⚠️ 不导出给 RPC/UI —— 正常运行时账本不该被外部清空（用户看到「突然归零」
 * 会以为丢了数据）；只有单测需要隔离状态。
 */
export function resetTokenLedgerForTests(): void {
  ledger = []
}

/** 当前保留的流水条数（诊断用）。 */
export function tokenLedgerSize(): number {
  return ledger.length
}

/**
 * **每日聚合**的落盘负载（第 2 期持久化）。
 *
 * 键结构：`日键 → 渠道|provider|账号|模型 → 累计值`。与「明细不持久化」的
 * 决策一致：明细在 UI 已有内存版（500 条），落盘只解决「重启后还能看历史
 * 总量」的诉求，而这个诉求的天然粒度就是**日**。
 */
export interface TokenLedgerDayKey {
  channel: 'direct' | 'gateway'
  provider: string
  /** 空串 = 未归属。 */
  accountId: string
  model: string
}

/** 一个日聚合桶的累计值。 */
export interface TokenLedgerDayBucket {
  requests: number
  reportedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  errors: number
  /** Σ(首字用时) 与样本数 —— 均值由读取方计算（Σ/份数，避免存小数漂移）。 */
  ttftSumMs: number
  ttftCount: number
  /** Σ(TPS) 与样本数（同上）。 */
  tpsSum: number
  tpsCount: number
  /** 稀疏对数直方图；v1 历史桶缺此字段时保留均值、分位数从升级后开始累计。 */
  tpsHistogram?: Record<string, number>
}

/** 每日聚合表：`日键 → (桶键 → 桶)`。序列化形态由 store 负责。 */
export type TokenLedgerDayMap = Map<string, Map<string, TokenLedgerDayBucket>>

/** 桶键（同进程内用 `|` 拼；含转义，见 `dayBucketKeyOf`）。 */
export function dayBucketKeyOf(key: TokenLedgerDayKey): string {
  /**
   * ⚠️⚠️ **这个转义是不可逆的，会造成静默合并**（红队复审实测，`0779fe8` 起就如此）。
   *
   * `esc` 把 `|` 换成 `/`，而 `/` 是**合法且常见**的模型名分隔符（`vendor/model`），
   * 于是 `provider: 'a|b'` 与 `provider: 'a/b'` 会算出**同一个桶键** ⇒ 两个不同
   * provider（或 account / model）的用量**合并成一行**，端到端实测：`mod|el` 的 100
   * 与 `mod/el` 的 7 合成 107，而 `parseDayBucketKey` 只能还原成 `a/b`（`a|b` 的
   * 信息已丢失）。
   *
   * ⚠️ **为什么仍然保留它**：`|` 是本键的分隔符，不转义会让 4 段结构被拆错
   *（那比合并更糟：段数不符 ⇒ 整桶被读取侧拒绝 ⇒ 该桶用量静默消失）。两害相权取
   * 此。真实账号池 id 与模型 id 实测不含 `|`，故生产中不触发。
   * ⚠️ 想根治需换成**长度前缀**或 JSON 编码的键（存储格式改动，会与旧文档不兼容），
   * 超出本次范围 —— **不要**以为这是「无损防御性转义」。
   */
  const esc = (s: string): string => s.replaceAll('|', '/')
  /**
   * ⚠️ **channel 必须归一**：`parseDayBucketKey`（读取侧的唯一判据）只接受
   * `direct` / `gateway`。若这里原样拼一个别的值（例如调用方传 `channel: 'foo'`），
   * 就会**写出一份自己读不回的桶** —— 落盘后重启该日直接消失（红队复审实测：
   * `store.append({channel:'foo'})` 写盘成功、`parseDayBucketKey` 拒绝、读回为空）。
   * 生产路径经 `recordTokenUsage` 已归一，但 `store.append` 是公开接口，故在**键的
   * 构造处**兜住，保证「写出去的键必然是读得回来的键」。
   * 取 `direct` 为兜底（与 `channelOfOptions` 对未知输入的保守取值一致）。
   */
  const channel = key.channel === 'gateway' ? 'gateway' : 'direct'
  return `${channel}|${esc(key.provider)}|${esc(key.accountId)}|${esc(key.model)}`
}

/** 把一笔记录累加进日聚合表（store 的 load/merge 共用）。 */
export function mergeDayEntry(days: TokenLedgerDayMap, entry: TokenLedgerEntry): void {
  const day = utc8DayKey(entry.ts)
  let buckets = days.get(day)
  if (buckets === undefined) {
    buckets = new Map()
    days.set(day, buckets)
  }
  const key = dayBucketKeyOf({
    channel: entry.channel,
    provider: entry.provider,
    accountId: entry.accountId ?? '',
    model: entry.model,
  })
  let bucket = buckets.get(key)
  if (bucket === undefined) {
    bucket = {
      requests: 0,
      reportedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      errors: 0,
      ttftSumMs: 0,
      ttftCount: 0,
      tpsSum: 0,
      tpsCount: 0,
      tpsHistogram: {},
    }
    buckets.set(key, bucket)
  }
  bucket.requests += 1
  if (entry.usageReported) bucket.reportedRequests += 1
  if (entry.error !== undefined) bucket.errors += 1
  // 均值样本：与内存聚合同口径，只收有实测值的请求。
  if (entry.ttftMs !== undefined && entry.ttftMs > 0) {
    bucket.ttftSumMs += entry.ttftMs
    bucket.ttftCount += 1
  }
  if (entry.tps !== undefined && entry.tps > 0) {
    bucket.tpsSum += entry.tps
    bucket.tpsCount += 1
    bucket.tpsHistogram ??= {}
    addTpsSample(bucket.tpsHistogram, entry.tps)
  }
  if (!entry.usageReported) return
  bucket.inputTokens += entry.inputTokens
  bucket.outputTokens += entry.outputTokens
  bucket.cacheReadTokens += entry.cacheReadTokens ?? 0
  bucket.cacheWriteTokens += entry.cacheWriteTokens ?? 0
  bucket.reasoningTokens += entry.reasoningTokens ?? 0
}

// ───────────────────────── 历史视图（第 4 期）─────────────────────────

/**
 * 解析日聚合桶键（`channel|provider|account|model`）为结构化键。
 *
 * ⚠️⚠️ **这是「桶键是否合法」的唯一定义**，`token-ledger-store.ts` 的落盘读取
 * 必须调用它、**不得**再写一份自己的校验（真实缺陷：store 首版另写了一个
 * 要求 model 非空的 `isValidBucketKey`，与这里分叉 ⇒ `model` 为空串的桶写盘后
 * 重启读不回，该日用量静默消失）。
 *
 * ⚠️ **`model` 允许为空串**：写入侧的 `options.model` 可能缺失/垃圾值，仓库既有
 * 用例 `token-ledger-wiring.spec.ts` 的「model 缺失/垃圾值记空串不抛错」把该行为
 * 锁为**既定语义**。故这里不能要求它非空 —— 单方面加严会让**已经写进盘**的数据
 * 读不回来。`accountId` 同理允许为空（单账号 provider 的合法取值）。
 *
 * 判据只保证「段数与 channel 取值合法」，不保证各段内容可信 —— 那是调用方
 * （store 的字段钳制）的事。
 */
export function parseDayBucketKey(key: string): TokenLedgerDayKey | undefined {
  // dayBucketKeyOf 用 `|` 拼接且把值里的 `|` 转义成 `/`，故 split 恒得 4 段。
  const parts = key.split('|')
  if (parts.length !== 4) return undefined
  const [channel, provider, accountId, model] = parts
  if (channel !== 'direct' && channel !== 'gateway') return undefined
  return { channel, provider, accountId: accountId ?? '', model: model ?? '' }
}

/** 一天的历史用量行（`readTokenLedgerHistory` 的返回元素）。 */
export interface TokenLedgerHistoryDay {
  /** UTC+8 日键（`YYYY-MM-DD`）。 */
  day: string
  channels: TokenLedgerChannelRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
}

/**
 * 从日聚合表读取**历史视图**（可按日期范围过滤）。
 *
 * ⚠️ 数据源是**落盘的日聚合**（重启保留），与内存明细（500 条、重启清空）
 * 是**两份独立数据**：历史视图答「本周/本月用了多少」，明细答「每一笔
 * 长什么样」。读取是纯计算（Map 树 → 数组），不碰磁盘。
 *
 * @param days - 日聚合表（store 的 `load()` 结果，含启动时从盘上加载的历史）。
 * @param options.sinceDays - 只看最近 N 天（**含今天**，UTC+8 日界）；
 *   省略 = 全部历史（上限 {@link TOKEN_LEDGER_HISTORY_MAX_DAYS}）。
 * @param options.fromDay / options.toDay - 按 UTC+8 日键筛选闭区间。
 */
export function readTokenLedgerHistory(
  days: TokenLedgerDayMap,
  options: { sinceDays?: number; fromDay?: string; toDay?: string } = {},
): { days: TokenLedgerHistoryDay[]; totals: Omit<TokenLedgerModelRow, 'model'> } {
  // 过滤窗口：today（UTC+8）往前推 sinceDays-1 天；0/负数按「仅今日」处理。
  const sinceDaysRaw = options.sinceDays
  const sinceDays = typeof sinceDaysRaw === 'number' && Number.isFinite(sinceDaysRaw) && sinceDaysRaw > 0
    ? Math.floor(sinceDaysRaw)
    : undefined
  // ⚠️ `utc8DayKey` 内部已做 +8h 平移，这里必须传**原始**时刻：
  // 先平移再传会让 cutoff 再多 8 小时（cutoff 落到「明天」，连今天都被裁掉）。
  const todayKey = utc8DayKey(Date.now())
  const cutoffKey = sinceDays === undefined
    ? undefined
    : utc8DayKey(Date.now() - (sinceDays - 1) * 24 * 60 * 60 * 1000)
  const fromDay = isValidTokenLedgerDayKey(options.fromDay) ? options.fromDay : undefined
  const toDay = isValidTokenLedgerDayKey(options.toDay) ? options.toDay : undefined

  const grandTotals = emptyTotals()
  const historyDays: TokenLedgerHistoryDay[] = []
  // 日键排序：新在前（字符串比较即时间序，YYYY-MM-DD 是字典序安全的）。
  const dayKeys = [...days.keys()].sort((a, b) => b.localeCompare(a))
  for (const day of dayKeys) {
    if (day > todayKey) continue // 未来键（手工编辑）：不展示也不入合计
    if (cutoffKey !== undefined && day < cutoffKey) continue // 窗口外
    if (fromDay !== undefined && day < fromDay) continue
    if (toDay !== undefined && day > toDay) continue
    const buckets = days.get(day)
    if (buckets === undefined || buckets.size === 0) continue
    // ── 一天的桶 → 四级聚合树（复用与内存版相同的两级收尾模式）──
    const dayTotals = emptyTotals()
    const channelMap = new Map<'direct' | 'gateway', Map<string, Map<string, Map<string, TokenLedgerDayBucket>>>>()
    for (const [key, bucket] of buckets) {
      const parsed = parseDayBucketKey(key)
      if (parsed === undefined) continue
      let providers = channelMap.get(parsed.channel)
      if (providers === undefined) {
        providers = new Map()
        channelMap.set(parsed.channel, providers)
      }
      const accountKey = parsed.accountId.length > 0 ? parsed.accountId : '-'
      let accounts = providers.get(parsed.provider)
      if (accounts === undefined) {
        accounts = new Map()
        providers.set(parsed.provider, accounts)
      }
      let models = accounts.get(accountKey)
      if (models === undefined) {
        models = new Map()
        accounts.set(accountKey, models)
      }
      models.set(parsed.model, bucket)
    }
    const channels: TokenLedgerChannelRow[] = [...channelMap.entries()]
      .sort(([a], [b]) => (a === 'direct' ? -1 : 1) - (b === 'direct' ? -1 : 1))
      .map(([channel, providers]) => {
        const channelTotals = emptyTotals()
        const providerRows: TokenLedgerProviderRow[] = [...providers.entries()].map(([provider, accounts]) => {
          const providerTotals = emptyTotals()
          const accountRows: TokenLedgerAccountRow[] = [...accounts.entries()].map(([accountId, models]) => {
            const accountTotals = emptyTotals()
            const modelRows: TokenLedgerModelRow[] = [...models.entries()].map(([model, bucket]) => {
              addAggregateTotals(accountTotals, bucket)
              const row = emptyTotals()
              addAggregateTotals(row, bucket)
              return { model, ...finalizeAverages(row) }
            }).sort((a, b) => sumTokens(b) - sumTokens(a))
            addAggregateTotals(providerTotals, accountTotals)
            return { accountId, models: modelRows, totals: finalizeAverages(accountTotals) }
          }).sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
          addAggregateTotals(channelTotals, providerTotals)
          return { provider, accounts: accountRows, totals: finalizeAverages(providerTotals) }
        }).sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
        // 日小计 = 其各渠道之和
        addAggregateTotals(dayTotals, channelTotals)
        return { channel, providers: providerRows, totals: finalizeAverages(channelTotals) }
      })
    // 全局合计按**日**累加（Σ/份数直加），不是日均值的均值。
    accumulateBucket(grandTotals, dayTotals)
    historyDays.push({ day, channels, totals: finalizeAverages(dayTotals) })
  }
  return { days: historyDays, totals: finalizeAverages(grandTotals) }
}

/** 把一个**日聚合桶的合计**累加进另一个累加器（历史全局合计用）。 */
function accumulateBucket(target: AccumulatingTotals, source: AccumulatingTotals): void {
  addAggregateTotals(target, source)
}

/** 历史视图的最大回看天数（防一次下发过大；落盘本身已有 90 天淘汰）。 */
export const TOKEN_LEDGER_HISTORY_MAX_DAYS = 90
