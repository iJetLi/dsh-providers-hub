/**
 * 限流标记重测（retest）与重置（reset）。
 *
 * 背景：账号卡片上的「限额重置」只是**一次 429 事件的快照**——它记录的是
 * 服务端当时给出的"预计恢复时间"，而不是该账号此刻的真实可用性。服务端
 * 常在重置时间到达前提前放行，于是出现「显示超额使用但发消息正常回复」。
 * 本模块让用户能主动验证并清理这些过期标记。
 *
 * 两个动作，语义严格区分：
 *
 * - **重测（retest）**：对每个带限流标记的模型**真实发一次最小对话请求**。
 *   只有请求正常完成才清除该模型的标记；仍被拒绝（限流）则保留标记，并把
 *   原因回传给 UI。这样标记始终反映"最近一次实测结果"。
 * - **重置（reset）**：不做任何网络请求，直接清除标记。用于用户已知额度
 *   已恢复、只想清掉显示的情况。
 *
 * 与 e2e 探针（tests/e2e/buddy-ratelimit-probe.e2e.spec.ts）的关系：两者都
 * 发真实请求判定限流，但 e2e 用于人工排查、本模块供设置页按钮调用。为避免
 * 逻辑漂移，这里直接复用**真实适配器**（BuddyAdapter / CodeArtsAdapter）走
 * 完整请求链路，而不是各自手写 HTTP。
 *
 * 两点关键设计：
 *
 * 1. **不传 accountPool 给适配器**。适配器只在拿到 accountPool 时才会切换
 *    账号、写限流标记；探测必须只针对**指定账号**、且不能产生副作用，否则
 *    "重测 A 账号"会顺带污染其他账号的标记。
 * 2. **停用账号也要能重测**。用户明确要求这一点，因此凭据解析走
 *    `resolveCredentialForAccount`（按 id，不检查 enabled），而非
 *    `getAvailableAccount`（自动选择，只认启用账号）。
 */

import { createUserMessage, LlmError, type LlmAdapter } from '@deepseek-ai/dsh-llm'
import {
  creditExhaustedResetAtMs,
  explicitRateResetAtMs,
  isCreditExhausted,
  isRateLimited,
  parseRateLimitError,
} from './llm-adapter.js'
import { runtimeOf } from './provider-runtime.js'
// ⚠️ 这些类型仍被 `ProbeCredential` 联合使用（探测入参的**形状**仍由本文件约束），
//    只是**不再**由本文件构造适配器（那是 `index.ts` 的 `probe.createProbeAdapter`）。
import type { BuddyCredential } from './buddy.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { QoderCredential } from './qoder.js'
import type { ClineCredential } from './cline.js'
import type { ZcodeCredential } from './zcode.js'
import type { TraeCredential } from './trae.js'
import type { GeminiCredential } from './gemini.js'
import type {
  CodeArtsCredential,
  ProbeAccountResult,
  ProbeModelResult,
  ProviderAccountEntry,
  RpcResetResponse,
  RpcRetestResponse,
  RpcTestAccountResponse,
} from './types.js'

/**
 * 探测可能涉及的凭据联合类型。
 *
 * 提为具名别名而非在各处重复多元联合：新增 provider 时只需改这一处，
 * 避免签名与实现漂移（本文件已**四次**因「分派表没跟上新增 provider」出缺陷）。
 */
type ProbeCredential =
  | CodeArtsCredential
  | BuddyCredential
  | LobsteraiCredential
  | QoderCredential
  | ClineCredential
  | ZcodeCredential
  | TraeCredential
  | GeminiCredential

/** 探测请求的提示语（与 e2e 探针保持一致，最大化可比性）。 */
const PROBE_PROMPT = '只回答两个字：收到'

/**
 * 探测请求的 system 提示。
 *
 * ⚠️ **不可省略，也刻意不随产品切换**（真实缺陷，用户报障）。
 *
 * WorkBuddy 国际版网关（`www.workbuddy.ai`）**强制要求 `messages[0]` 是
 * `role:'system'`**，否则返回 HTTP 400 + `code 11128`
 * `"first message is not system prompt"`，且 `displayMsg` 把它**伪装成安全
 * 策略拦截**（「请求被安全策略拦截，请稍后重试或联系支持」）—— 与真实的限流/
 * 可用性毫无关系。
 *
 * 早期 `probeWithAdapter` 只传 `messages`、不传 `options.system`，而适配器仅在
 * `options.system` 非空时才 `unshift` system（见 `buddy-adapter.ts`），于是
 * wire 上首条就是 user。后果：WorkBuddy 面板的「重测 / 重测所有」**恒不可用**
 * ——既拿不到「已恢复」也拿不到「仍受限」，只有一句误导性的安全策略报错。
 *
 * 实测（2026-09-25，同一凭据各发一次最小请求）：
 *
 * | 端点 | 无 system | 有 system |
 * |---|---|---|
 * | `www.workbuddy.ai`（WorkBuddy） | **400 + 11128** | 200 正常 |
 * | `copilot.tencent.com`（CodeBuddy） | 200 正常 | 200 正常 |
 *
 * 即**只有 WorkBuddy 网关**有此硬性要求，但这里**无条件**给所有 provider 都带
 * 上：① 判据不该依赖「另一个产品碰巧不校验」这种易变的外部事实；② 探测本身
 * 与 system 内容无关，带上它对结论无影响；③ 分支特判会让将来新增的 provider
 * 再次踩同一个坑。
 *
 * 内容取最小可用值（对齐 `tests/e2e/buddy-pool-probe.e2e.spec.ts` 与
 * `scripts/verify-max-tokens.mjs` 里已被验证可用的同一句）。
 */
const PROBE_SYSTEM = 'You are a helpful assistant.'

/**
 * 单次探测的超时（毫秒）。
 *
 * CodeArts 适配器在排队时会以 10 秒间隔重试 chat 请求、最长 30 分钟
 * （QUEUE_MAX_ATTEMPTS）。设置页按钮显然不能等那么久，因此这里用
 * AbortSignal 给每次探测设硬上限：超时即判定"未能确认恢复"，保留标记。
 * 宁可保守留标记，也不要因为等太久让 UI 卡死。
 */
const PROBE_TIMEOUT_MS = 120_000

/**
 * 重测/重置所需的最小账号池接口。
 *
 * 只声明实际用到的方法，使本模块可脱离 Cordis 上下文单测；
 * 真实的 {@link AccountPool} 结构上即满足此接口。
 */
export interface ProbePool {
  /** 按 id 查找账号（含已停用）。 */
  findAccount(id: string): ProviderAccountEntry | undefined
  /** 列出某 provider 的全部账号（含已停用）。 */
  listAccountsByProvider(provider: string): ProviderAccountEntry[]
  /** 按 id 解析凭据（不检查 enabled）。 */
  resolveCredentialForAccount(id: string): Promise<ProbeCredential | undefined>
  /** 清除限流标记；modelIds 省略时清除全部。返回清除条数。 */
  clearModelRateLimits(accountId: string, modelIds?: readonly string[]): Promise<number>
  /**
   * 写入/更新某账号某模型的限流重置时刻。
   *
   * [patch-codearts-probe-ratelimit] 重测发现「仍受限」时需要它把上游给的
   * **新**时刻写回，否则存储停在旧值、UI 不再显示限流。
   */
  updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number): Promise<void>
  /**
   * 清除账号级**封禁**标记（Gitee issue IKS2MV）。
   *
   * 与限流标记是**两笔账**：封禁只能靠「实测通过 / 人工重置 / 重新登录」清除，
   * 不随时间过期。可选 —— 单测的替身池可能不实现它（缺了就跳过，不影响探测结论）。
   */
  clearAccountPolicyBlocked?(accountId: string): Promise<boolean>
}

/** 探测依赖注入点（测试可覆盖）。 */
export interface ProbeDeps {
  /** 发起探测请求的函数；默认使用真实适配器。 */
  probe?: (entry: ProviderAccountEntry, modelId: string) => Promise<ProbeModelResult>
  /** 单次探测超时；默认 {@link PROBE_TIMEOUT_MS}。 */
  timeoutMs?: number
}

/**
 * 判断一次探测失败是否**属于限流**。
 *
 * 区分限流与其他失败（鉴权过期、网络中断）很重要：只有限流才算
 * "标记仍然有效"，其他失败说明"无法确认"，两种都应该保留标记，
 * 但回传给用户的文案不同。
 */
function isRateLimitFailure(error: unknown): boolean {
  if (error instanceof LlmError) {
    // buddy/codearts 用字面量 'QUOTA_EXCEEDED'，harness 常量 QUOTA_EXCEEDED_CODE
    // 是 'QUOTA'——两者都认，避免因词汇差异把限流误判成"未知错误"。
    if (error.code === 'RATE_LIMIT' || error.code === 'QUOTA_EXCEEDED' || error.code === 'QUOTA') return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return isRateLimited(message)
}

/**
 * 按 provider 找到它的**探测适配器工厂**并造一个实例（Task 8）。
 *
 * ## ⚠️ 为什么未登记时**必须抛**，而不是落回某个默认适配器
 *
 * 旧实现是一条 `else if` 链，末尾的 `else` 兜底把**未登记的 provider** 交给
 * 「**华为云 HMAC 签名**的 `CodeArtsAdapter`」去发别家凭据 ⇒
 * 探测**必然失败**，而该 provider 的限流标记（UTC+8 当日 24:00）**永远清不掉**。
 * 症状只是「重测按钮点了没用」—— 极难定位（`account-probe.ts` 的注释记录该缺陷
 * **同型复发 4 次**：workbuddy → trae → qoder/qodercn/cline → zcode）。
 *
 * ⇒ 改为查能力注册表：**未登记 ⇒ 抛可读错误**（带 provider 名）。
 * 这是**行为收紧**：未登记的渠道从「发一次必然失败的请求」变成「明确报不支持重测」。
 * ⚠️ **该收紧是用户可见的**（2026-10-08 独立复审修正原注释的错误推论）：
 * 原注释称「客户端能力表 `accountTest` 目前**只有 `gemini`**，故其余渠道本就没有入口」——
 * 实测 `jet-hub.js` 里「重测所有」/「重置所有」/卡片级「重测」「重置」由
 * **`supportsRateLimit`**（缺省 `true`）门控，与 `accountTest`（另一个「测试」按钮）
 * **不是一个位** ⇒ 这些按钮对**所有未豁免 `rateLimit: false` 的渠道都会渲染**。
 * 故本函数抛出的错误是**用户点得到**的路径（经 RPC 外层 catch 变成
 * `jet-hub/handler-failed`），不是纯内部契约。
 *
 * ⚠️ 判据是 `runtime?.probe === undefined` —— **不能**只看 `runtimeOf(provider)`
 * 是否有值：只注册了 `expiry` 等其它域的 provider **同样不支持重测**。
 */
export function adapterForProbe(
  provider: string,
  refName: string,
  credential: unknown,
  entry?: ProviderAccountEntry,
): LlmAdapter {
  const runtime = runtimeOf(provider)
  if (runtime?.probe === undefined) {
    // ⚠️ 必须抛，不得落回 CodeArtsAdapter：那会用华为云 HMAC 签名去打别家端点，
    //    探测必然失败而限流标记永远清不掉（zcode / gemini 各踩过一次）。
    throw new Error(`${provider} 没有探测适配器（该 provider 不支持重测）`)
  }
  return runtime.probe.createProbeAdapter(refName, credential, entry)
}

/** 用真实适配器对指定账号的指定模型发一次最小请求。 */
async function probeWithAdapter(
  entry: ProviderAccountEntry,
  credential: ProbeCredential,
  modelId: string,
  timeoutMs: number,
): Promise<ProbeModelResult> {
  const signal = AbortSignal.timeout(timeoutMs)

  // 刻意不传 accountPool / fetchRemoteModels：
  // - 不传 accountPool → 只测这一个账号，且探测本身不写限流标记；
  // - 不传 fetchRemoteModels → 避免为一次探测额外拉取远端模型目录。
  //
  // refresh 设为 no-op：探测不应触发全局续期流程（那会影响其他账号与
  // 其他并发会话），凭据真的过期就让它以 AUTH 失败并如实上报。
  //
  // **七条产品线各自选适配器**，顺序不能颠倒也不能漏判：
  // - CodeBuddy 系（buddy / workbuddy）→ BuddyAdapter，按各自 product 发请求；
  // - LobsterAI → LobsteraiAdapter（自己的端点与头族）；
  // - Qoder 系（qoder / qodercn）→ QoderAdapter（WASM 加密体 + 签名头族）；
  // - Cline → ClineAdapter（WorkOS 凭据 + 自己的端点）；
  // - ZCode（智谱）→ ZcodeAdapter（Anthropic Messages 体 + 阿里云 captcha 参数）；
  // - TRAE → TraeAdapter（SOLO 格式请求体 + Cloud-IDE-JWT 头族）；
  // - 其余（codearts）→ CodeArtsAdapter（华为云 HMAC 签名）。
  //
  // ⚠️ **这个分派表已四次因「新增 provider 没同步」而出缺陷**，改它前先读完：
  //
  // 1. 初版只判断 `provider === 'buddy'` → workbuddy 落入 else，用华为云
  //    HMAC 签名去发 WorkBuddy 凭据而必然失败；
  // 2. 加了 lobsterai 分支后**仍漏掉 trae** → TRAE 账号同样落入 else，
  //    用 CodeArts 签名发 TRAE 请求而必然失败（2026-09-25 排查 workbuddy
  //    缺陷时发现，实测 `productById('trae')` 与 `lobsteraiProductById('trae')`
  //    均为 undefined）；
  // 3. 加了 trae 分支后**仍漏掉 qoder / qodercn / cline** → 三者同样落入
  //    else，被交给 CodeArtsAdapter 用华为云 HMAC 签名去发 Qoder / Cline
  //    凭据。它们的「重测 / 重置」按钮**确实会渲染**（`RATE_LIMIT_CAPABILITIES`
  //    对未登记的 provider 默认视为有限流，当时只有 loomy 显式登记为 false），
  //    且 Qoder 的额度受限**每次都会**写 `modelRateLimits`（按 UTC+8 当日
  //    24:00 标记），于是「点重测 → 拿到签名错误 → 标记也清不掉」成为稳定
  //    可复现的死循环；
  // 4. 补上 qoder / qodercn / cline 之后**仍漏掉 zcode**（本次）→ 同型第 4 次。
  //    它的写入点 `zcode-adapter.ts` 的 `switchAccountOnQuota()` 与 Qoder
  //    **完全同款**（同样按 UTC+8 当日 24:00 标记该模型），而那个写入点是
  //    在本分支建立**之后**才进 master 的 —— 正是「清单靠记忆维护」必漏的情形。
  //
  // ⚠️ **判据是「该 provider 会不会写 `modelRateLimits`」**（写了才有重测按钮、
  // 才需要在这里分派）。但**不要靠记忆维护清单**，直接机械核对写入方：
  //
  //     grep -n 'updateModelRateLimit(' src/*.ts    # 写点（池侧定义 + 各适配器直调）
  //     grep -n 'markLimited' src/*.ts              # 适配器侧经回调注入的写点
  //
  // ⚠️ **两条都要跑**：多数适配器是**直调** `pool.updateModelRateLimit(...)`，
  // 只有 `cline` / `opencode` 用 `markLimited` 这个名字 —— 只看第二条会把
  // 大部分家漏掉。
  //
  // ⚠️ **2026-10-08 独立复审修正：上面这段旧注释里有两处已过时的判断，
  // 原文保留在下方供对照，但**不得**再按它们维护清单**：
  //
  // - 旧文说「反例：loomy 的积分耗尽时静默降级、**不写**标记，故它落 else 无害」
  //   —— **实测证伪**：`loomy-adapter.ts` 有 `markLimited` 调用点，且 Task 8 已把
  //   loomy **加入注册**（同段旧文的末尾也这么写了，两半自相矛盾）。
  //   真相是：loomy 的**积分耗尽**确实静默降级不写标记，但它的**其它**限流类失败
  //   会写 —— 判据要看「有没有写点」，不是「某一种失败写不写」。
  // - 旧文说「反例：minimax 与 opencode **不写**标记」—— 对 **`opencode` 证伪**
  //   （`opencode-adapter.ts` 3 处 `markLimited`）。opencode 曾因此不在
  //   `index.ts` 的 probe 表里，理由是「探测材料拿不到」——
  //   ⚠️ **那个理由 2026-10-08 第二轮已实测证伪并补齐**（见 `index.ts` 的
  //   `probeById.opencode` 条目）：真正缺的只是「把 `entry` 交给工厂」。
  //   ⚠️ **对 `minimax` 的那半也已在 2026-10-11 证伪**（issue IKJW32）：它原先
  //   确实零写点，接上请求级换号 + 冷却后会写 `modelRateLimits`（额度 24h /
  //   限流 1h）⇒ 必须进 `probeById`。**这条旧文两次都被证明是「当时的快照」**，
  //   正是「清单靠记忆维护」必漏的又一个实例：判据只能是「现在有没有写点」。
  //   现在本链**14 家全在**，`PROBE_EXEMPT` 仍为空表。
  // ⚠️ **2026-10-08 Task 8：本链已改为查能力注册表**（原为 `else if` 链 + `else` 兜底）。
  //
  // 原实现的 `else` 会把**未登记的 provider** 交给「**华为云 HMAC 签名**的
  // `CodeArtsAdapter`」去发别家凭据 ⇒ 探测必然失败，而该 provider 的限流标记
  //（UTC+8 当日 24:00）**永远清不掉**（症状只是「重测按钮点了没用」，极难定位）。
  // ⚠️ 该缺陷**同型复发 4 次**：workbuddy → trae → qoder/qodercn/cline → zcode，
  // 根因是「清单靠记忆维护」。
  //
  // ⇒ 现在各家在 `src/index.ts` 注册 `probe.createProbeAdapter`，
  // **未登记 ⇒ 抛可读错误**（见 `adapterForProbe`），不再有 `else` 兜底。
  //
  // 新增 provider 时**先跑上面那两条 grep**，再补 `index.ts` 的注册与
  // `tests/unit/account-probe-adapter.spec.ts` 的对应用例；
  // 「登记了哪些家、哪些家刻意不登记」由 `index.ts` 的 `probeById` 头注释
  // 与 `PROBE_EXEMPT` 说明，本处不再重复一份易腐的清单。
  const adapter = adapterForProbe(entry.provider, entry.credentialRef, credential, entry)
  try {
    for await (const _chunk of adapter.stream({
      provider: entry.provider,
      model: modelId,
      messages: [createUserMessage({
        content: [{ type: 'text', text: PROBE_PROMPT }],
        source: { kind: 'user' },
      })],
      // ⚠️ **必须传 system**，否则 WorkBuddy 网关返回 400 + code 11128
      // 「first message is not system prompt」（伪装成安全策略拦截），
      // 使重测恒不可用。详见 PROBE_SYSTEM 的注释。
      system: PROBE_SYSTEM,
      signal,
    })) {
      // 消费整个流即可：能正常结束就说明服务端接受并完成了这次请求
      //（未被限流）。即使正文为空（少数模型只回 finish）也不算限流。
    }
    return { modelId, ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isRateLimitFailure(error)) {
      // [patch-codearts-probe-ratelimit] 上游的重置时刻是**滚动**的：每次撞限流都会
      // 把它往后推。这里必须把它解析出来一并回传，否则调用方只能保留存储里的旧值，
      // 旧值过期后 UI 就不再渲染「限额重置」（表现为"重测说仍受限、卡片却没有"）。
      // 解析失败（文案无时间）时不带该字段，调用方按「无法确认」处理、保留原标记。
      //
      // ⚠️⚠️ **额度耗尽（14018）不能用 `parseRateLimitError` 的 1 小时兜底**
      // （Gitee IKQ6HJ，2026-10-25 修）：它的报文里没有时间字段，而那 1 小时会让
      // 账号每小时被重新选中一次、必然再失败一次。
      //
      // ⚠️⚠️ **两条腿必须逐字同形**（对抗审计实测的真缺陷，本行第一版就是错的）：
      // 推理腿（`buddy-adapter.ts`）算的是
      // `explicitRateResetAtMs(errorText) ?? creditExhaustedResetAtMs()`，
      // 而本行第一版**只有后一半** ⇒ 同一条报文（14018 码 + 显式 `reset at` 时刻）
      // 在两条腿上算出**两个不同的解禁时刻**：
      // | 路径 | 报文含显式时刻时写下的标记 |
      // |---|---|
      // | 推理腿 | `2099-12-31T15:59:59Z`（按服务端声明） |
      // | 探测腿（第一版） | `2026-10-25T16:00:00Z`（按自然日） |
      // ⇒ 用户点一次「重测」就看到解禁时间跳变。**这不是理论风险**：实测两值不同。
      // 故这里补上 `explicitRateResetAtMs`，与推理腿逐字同形。
      //
      // ⚠️ 为什么不把两处抽成「一个函数」：探测层**不得**反向 import
      // `buddy-adapter.ts`（`account-probe-adapter.spec.ts` 会 `vi.mock` 它，
      // 让导出一起变成 `undefined`）。共享的只能放在 `llm-adapter.ts`，而
      // 「显式优先 + 自然日兜底」这两个原语已经都在那里 ⇒ 两处写出**同一个表达式**
      // 是本仓库在此约束下的最优解；该表达式由本文件与 buddy 两侧的用例共同锁住
      // （任一侧少了 explicit 腿，那条「服务端给了时刻以它为准」的用例就会红）。
      const parsed = parseRateLimitError(message, modelId)
      //
      // ⚠️⚠️ **入参是「适配器压平后的 message」，不是原始报文** —— 这带来一条
      // 已实测的窄风险（对抗审计 2026-10-25 登记，未修）：
      // `isCreditExhausted` 有一条**文案腿**（`积分|额度|余额` + `不足|耗尽|用尽`），
      // 它扫的是这段被包装过的文本。实测一条**普通限流**报文
      // `{"code":429,"msg":"所有账号的「15 天内到期」积分都已用尽…"}` 命中
      // `积分.{0,4}用尽` ⇒ 被判「额度耗尽」⇒ 写下**自然日**冷却，
      // 而它本该走 `+1h` / 服务端时刻。
      //
      // 触发面窄（要求 429 正文含那几句确定性格式），故**仅登记不改判据**：
      // 收窄文案腿会让「上游改措辞」时漏判（更常见的失败形态），
      // 而收窄的收益只是这一格。若将来实测到该形态，正确修法是
      // **让探测腿能拿到原始报文**（在 `ProbeModelResult` 上加一个原始 body 字段），
      // 而不是继续在压平文本上加正则。
      const creditExhausted = isCreditExhausted(message)
      const resetTimeMs = creditExhausted
        ? explicitRateResetAtMs(message) ?? creditExhaustedResetAtMs()
        : parsed?.resetTimeMs
      return {
        modelId,
        ok: false,
        // ⚠️ **额度耗尽不能只说「仍受限」**（Gitee IKQ6HJ 的另发现 1）：
        // 那个词把用户引向「等一会儿再试」，而真实出路是「等次日配额或充值」。
        // 两者在上游是**完全不同的恢复机制**，文案必须分出档次。
        //
        // ⚠️⚠️ **文案不得断言「已按 …… 设置」**（对抗审计实测为假话，本仓库红线）：
        // `AccountPool.updateModelRateLimit` 的语义是「只接受更长的时刻」
        //（`markerUnchanged = currentValid && current >= resetAtMs` ⇒ 静默忽略），
        // 而探测层**无从知道**这次写入是否真的生效 —— 池里若已有一个更晚的标记
        // （历史遗留，或 P0-2 那种两腿不一致的现场），存储里仍是旧值，而文案却说
        // 「已按当日 24:00 设置」。实测：写入被忽略时存储留 `2099-12-31`，文案照旧。
        //
        // ⇒ 处置：**只说事实**（额度耗尽、出路是等次日/充值），把「实际生效时刻」
        // 交给 UI 已有的 `resetTimeMs` / 徽章渲染 —— 那是从存储读出来的真值。
        //
        // ⚠️ 判据只用共享层的 `isCreditExhausted`，**不得**在这里 import
        // `buddy-adapter.ts` 的 `isContentRejection` /
        // `isChannelVerificationRejection`：探测层反向依赖某个渠道的适配器会
        // 被 `account-probe-adapter.spec.ts` 的 `vi.mock` 一起变成 `undefined`
        // （该陷阱已在本 issue 里被真实踩到一次）。其余两档（账号被封 /
        // 请求形态被拒）由上游原文自带指引（「账号存在异常行为，已被限制使用」
        // / 「请求被拦截」），故只做本档的措辞分辨。
        message: creditExhausted
          ? `额度已耗尽（不是频率限流）：该账号在该模型上的配额用光 —— 请等次日配额重置或充值；${message}`
          : `仍受限：${message}`,
        ...resetTimeMs !== undefined ? { resetTimeMs } : {},
      }
    }
    return { modelId, ok: false, message: `无法确认：${message}` }
  }
}

/** 默认探测实现：解析该账号凭据后用真实适配器发请求。 */
function makeDefaultProbe(pool: ProbePool, timeoutMs: number) {
  return async (entry: ProviderAccountEntry, modelId: string): Promise<ProbeModelResult> => {
    const credential = await pool.resolveCredentialForAccount(entry.id)
    if (credential === undefined) {
      return { modelId, ok: false, message: '无法确认：凭据不可用' }
    }
    return probeWithAdapter(entry, credential, modelId, timeoutMs)
  }
}

/**
 * 重测单个账号：对该账号每个带限流标记的模型发一次真实请求，
 * 正常返回的模型清除标记。
 */
export async function retestAccount(
  pool: ProbePool,
  accountId: string,
  deps: ProbeDeps = {},
): Promise<ProbeAccountResult> {
  const entry = pool.findAccount(accountId)
  if (entry === undefined) {
    return { accountId, tested: 0, cleared: [], stillLimited: [], error: `账号 ${accountId} 不存在` }
  }

  const modelIds = Object.keys(entry.modelRateLimits ?? {})
  const result: ProbeAccountResult = {
    accountId,
    nickname: entry.nickname,
    tested: modelIds.length,
    cleared: [],
    stillLimited: [],
  }
  if (modelIds.length === 0) return result

  const probe = deps.probe ?? makeDefaultProbe(pool, deps.timeoutMs ?? PROBE_TIMEOUT_MS)
  for (const modelId of modelIds) {
    const outcome = await probe(entry, modelId)
    if (outcome.ok) result.cleared.push(modelId)
    else result.stillLimited.push(outcome)
  }

  // 只有实测通过的模型才清除标记；仍受限/无法确认的一律保留。
  if (result.cleared.length > 0) {
    await pool.clearModelRateLimits(accountId, result.cleared)
  }
  // [patch-codearts-probe-ratelimit] 对「仍受限且上游给出了新重置时刻」的模型，
  // 把**新时刻**写回存储。不写回的话，存储会一直停在第一次撞限流的旧时刻；
  // 旧时刻过期后 UI 不再渲染「限额重置」（卡片空白），而账号实际仍在受限，
  // 选号逻辑也会误判为可用。上游时刻是滚动的，每次重测都可能往后推。
  for (const outcome of result.stillLimited) {
    if (outcome.resetTimeMs === undefined) continue
    await pool.updateModelRateLimit(accountId, outcome.modelId, outcome.resetTimeMs)
  }
  /**
   * ★ 全部被测模型**都通过** ⇒ 这个账号显然没被封（Gitee issue IKS2MV）：
   * 清掉账号级封禁标记，否则它会被选号侧永久排除、只能靠用户手动「重置」捞回来。
   *
   * ⚠️ 判据是 `tested > 0 && stillLimited.length === 0`：一次都没测（`tested === 0`）
   * 不能证明任何事；有一个模型仍受限也说明账号还没恢复（封禁是账号级，但
   * 「仍受限」也可能是限流，两者都该保守处理）。
   */
  if (result.tested > 0 && result.stillLimited.length === 0 && typeof pool.clearAccountPolicyBlocked === 'function') {
    await pool.clearAccountPolicyBlocked(accountId)
  }
  return result
}

/**
 * 重测某 provider 下的**全部**账号（含已停用账号）。
 *
 * 顺序执行而非并发：探测会真实消耗模型额度，并发发起容易触发真正想验证的
 * 限流，反而得到假阳性。
 */
export async function retestAllAccounts(
  pool: ProbePool,
  provider: string,
  deps: ProbeDeps = {},
): Promise<RpcRetestResponse> {
  const entries = pool.listAccountsByProvider(provider)
  const accounts: ProbeAccountResult[] = []
  for (const entry of entries) {
    accounts.push(await retestAccount(pool, entry.id, deps))
  }
  return {
    accounts,
    clearedCount: accounts.reduce((sum, a) => sum + a.cleared.length, 0),
  }
}

/**
 * 挑一个「测试」要用的模型 id（纯函数，无 IO —— 便于单测覆盖优先级）。
 *
 * 优先级：调用方显式指定 > 已有的限流标记 > 全量目录第一个。
 *
 * ## 为什么标记优先于目录
 *
 * 用户点「测试」最常见的动机是「这个账号显示着限流标记，它到底恢复了没有」，
 * 而那个标记指向的模型正是他关心的。取目录第一个（如 CodeBuddy 的
 * `glm-5.2`）会测一个与标记无关的模型 —— 结果既不能清标记、也不能解释标记。
 *
 * ## 为什么没有目录时返回空串而不是猜一个
 *
 * 猜错的模型名会得到 404，把「账号不可用」与「模型名不对」两件事混成同一条
 * 报错，用户据此会去做完全错误的动作（重新登录）。故调用方拿到空串时应
 * **如实报错**，而不是发出去。
 *
 * @param catalogIds 该 provider 的全量模型目录（调用方按需读取，可为空数组）。
 */
export function pickTestModel(
  entry: ProviderAccountEntry,
  catalogIds: readonly string[],
  requested?: string,
): string {
  if (typeof requested === 'string' && requested !== '') return requested
  const marked = Object.keys(entry.modelRateLimits ?? {})[0]
  if (marked !== undefined) return marked
  return catalogIds[0] ?? ''
}

/**
 * 「测试」单个账号：**无条件**真发一次请求，且不做任何存储写入。
 *
 * ## 与 {@link retestAccount} 的区别（这是本函数存在的全部理由）
 *
 * `retestAccount` 的触发条件是 `Object.keys(entry.modelRateLimits ?? {})`：
 * 账号没有限流标记时它在 `modelIds.length === 0` 处**提前返回，一次请求都不发**。
 * 于是「这个账号到底还能不能用」在**没有历史 429** 时没有任何手动探活入口 ——
 * 用户点「重测」看到瞬间返回，会以为按钮失灵（真实报障：
 * 「重测按钮你确认过会发请求吗，为什么响应这么快？」）。
 *
 * `testAccount` 不看标记、不下发清除指令、不写回重置时刻：它只回答
 * 「这一发请求成功了吗」。故它**不需要** `modelRateLimits` 存在，
 * 也不改变任何存储状态 —— 这一点与重测是硬性区别，不可为了复用而合并。
 *
 * @param modelId 要测的模型 id，由 {@link pickTestModel} 决定。
 */
export async function testAccount(
  pool: ProbePool,
  accountId: string,
  modelId: string,
  deps: ProbeDeps = {},
): Promise<RpcTestAccountResponse> {
  const entry = pool.findAccount(accountId)
  if (entry === undefined) {
    return { accountId, modelId, ok: false, message: `账号 ${accountId} 不存在` }
  }

  const probe = deps.probe ?? makeDefaultProbe(pool, deps.timeoutMs ?? PROBE_TIMEOUT_MS)
  let outcome: ProbeModelResult
  try {
    outcome = await probe(entry, modelId)
  } catch (error) {
    // 探测函数本身抛错（凭据解析异常等）：如实回报，不冒泡成 handler-failed。
    const reason = error instanceof Error ? error.message : String(error)
    return { accountId, modelId, ok: false, message: `无法确认：${reason}` }
  }

  return {
    accountId,
    ...entry.nickname === undefined ? {} : { nickname: entry.nickname },
    modelId: outcome.modelId,
    ok: outcome.ok,
    ...outcome.message === undefined ? {} : { message: outcome.message },
    ...outcome.resetTimeMs === undefined ? {} : { resetTimeMs: outcome.resetTimeMs },
  }
}

/**
 * 重置单个账号：不测试，直接清除该账号的全部限流标记。
 * @returns 清除的标记条数与涉及的账号数（此处恒为 0 或 1）。
 */
/**
 * 重置单个账号的限流标记。
 *
 * ⚠️ 同时清掉**账号级封禁标记**（Gitee issue IKS2MV）：这是「重置」按钮的语义
 * ——「我确认这个账号现在是好的，把它的坏状态全清掉」。只清限流而留下封禁，
 * 会让用户点了重置、面板仍红、选号仍排除它（按钮看起来失灵）。
 */
export async function resetAccount(pool: ProbePool, accountId: string): Promise<RpcResetResponse> {
  const cleared = await pool.clearModelRateLimits(accountId)
  const policyCleared = typeof pool.clearAccountPolicyBlocked === 'function'
    ? await pool.clearAccountPolicyBlocked(accountId)
    : false
  return { clearedCount: cleared, accountCount: cleared > 0 || policyCleared ? 1 : 0 }
}

/** 重置某 provider 下全部账号（含已停用账号）的限流标记与封禁标记。 */
export async function resetAllAccounts(pool: ProbePool, provider: string): Promise<RpcResetResponse> {
  const entries = pool.listAccountsByProvider(provider)
  let clearedCount = 0
  let accountCount = 0
  for (const entry of entries) {
    const cleared = await pool.clearModelRateLimits(entry.id)
    const policyCleared = typeof pool.clearAccountPolicyBlocked === 'function'
      ? await pool.clearAccountPolicyBlocked(entry.id)
      : false
    if (cleared > 0 || policyCleared) {
      clearedCount += cleared
      accountCount++
    }
  }
  return { clearedCount, accountCount }
}
