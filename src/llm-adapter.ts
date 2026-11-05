import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError,
  isQuotaExceededError, LlmAdapter, LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { createModelCatalog, isCatalogFreshFor, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import { claimCodeArtsBenefit } from './codearts-credits.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import { isCodeArtsBenefitModelKnown, type RemoteModel } from './models.js'
import { normalizeHarnessMessages } from './message-shape.js'
import { signRequestHuawei } from './sign.js'
// ⚠️ `detailFieldText`（`detail` 那条腿）**只留一份实现** —— 本仓库 6 份同义的
// `errorDetail` 各写一条判据必然漂移（见 `openai-compat.ts` 的注释，IKLBSH A1）。
//
// ⚠️⚠️ **`serializeMessages` / `collectImages` 也改用共享实现**（2026-10-21）：
// 本文件原有一份**只处理文本**的私有 `serializeMessages`（注释还写着「其余非
// 文本块（图片）被丢弃」）。接图片时若在私有那份上再加一条腿，就会变成
// 「同一语义两套实现」—— 而共享实现已经把 12 家的坑（工具结果内嵌图片提升为
// 独立 user 消息、空 Map 不降级、`[image unavailable]` 占位符、递归深度与
// `collectImages` 对齐）全部踩过了。**故直接复用，不另写。**
import { collectImages, contentToText, detailFieldText, serializeMessages } from './openai-compat.js'

/**
 * 重新导出共享的 `serializeMessages`（**只为了让既有调用方与测试的导入路径不变**）。
 *
 * ⚠️ 这里**没有**第二份实现 —— 上面那条 import 就是唯一来源。写成
 * `export { serializeMessages }` 而不是在这里再包一层，是为了让「有两份实现」
 * 这件事在类型层面就不可能发生。
 *
 * ⚠️ 使用者（`tests/unit/session-replay.spec.ts` 等）测的是「0.1.7 形状与
 * 0.1.5 形状等价」，判据与实现份数无关，故保留原导入路径即可。
 */
export { serializeMessages }
import { createBlankReasoningSuppressor, createDsmlMarkerNormalizer, createReasoningLoopDetector, fixDsmlMarkers, hasUsableToolName, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, reasoningLoopFailure, resolveEmptyResponseReason, resolveToolPairing, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from './sse.js'
import { planSessionTitleThinking } from './session-title.js'
import type { CodeArtsCredential } from './types.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import { CODEARTS_PROVIDER, codeartsAcceptsImage, codeartsVisionModel } from './codearts-vision.js'
import { reportLedgerAccount } from './token-ledger.js'

export const CHAT_API_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2'
/**
 * CodeArts 推理请求的 `User-Agent` —— **必须是官方客户端的身份**。
 *
 * ## ⚠️⚠️ 为什么不能沿用宿主的 `attributionHeaders()`（2026-11-05 真机实测）
 *
 * 宿主的 `attributionHeaders()` 恒发
 * `deepseek-harness/<ver> (+https://github.com/deepseek-ai/deepseek-harness)`，
 * 而**华为 WAF 按这个前缀拒发**：报文
 * `403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}`，
 * 响应头带 `server: CW` / `set-cookie: HWWAFSESID=…`（WAF 侧，不是 APIG）。
 *
 * ⚠️ **症状极具误导性**：403 落到 {@link httpErrorCode} 的 `AUTH` 分支 ⇒ 客户端
 * 把整条 message 换成「**API 密钥无效**」（`dsh-client-ui-chat` 的
 * `message.failure.auth`）⇒ 用户以为凭据坏了去重新登录，而凭据**完全有效**。
 * 且 `isAuthError` 对 403 恒真 ⇒ 每次失败还**白跑一次凭据续期**（CodeArts 的
 * `refresh_token` 是**一次性轮换**的，见 `tests/e2e/codearts-credential.ts` 的
 * 注释 ⇒ 这不是无害副作用）。
 *
 * ## 实测对照（同一账号、同一份签名、逐字节相同的 body，只改 UA）
 *
 * | `User-Agent` | 结果 |
 * |---|---|
 * | `deepseek-harness/0.2.1-rc.2 (+https://…)` | **403 TM.00000001** |
 * | `deepseek-harness/0.2.1`（无 url 段） | **403 TM.00000001** |
 * | `deepseek-harness`（无 `/版本`） | 200 |
 * | `deepseek-harness-x/1.0` / `DEEPSEEK-HARNESS/1.0` | 200 |
 * | `VSCode/1.95.3` / `Mozilla/5.0 …` / `curl/8.4.0` | 200 |
 * | `claude-code` / `opencode` / `cline` | 200（**不是**「拦所有 AI 客户端」） |
 *
 * ⇒ 拒发判据是**大小写敏感的前缀 `deepseek-harness/`**（4 个账号全部一致，
 * 交替顺序 3 轮可复现）。故本家必须显式覆盖该头。
 *
 * ## 取值 = 官方 IDE 的身份（不是随手编一个能过的值）
 *
 * `codearts/1.0.0-1147257973136832` 逐字取自本机 CodeArts Agent 内核进程的
 * 启动参数（`~/.codeartsdoer/codearts-data/log/kernel_error_*.log`：
 * `Args: "…AgentKernel_Vscode_….exe" "--user-agent=codearts/1.0.0-1147257973136832"`）
 * ⇒ 与真实客户端同形。终值部分只影响指纹相似度（WAF 只拒 `deepseek-harness/`）。
 *
 * ⚠️ UA **不参与** SDK-HMAC-SHA256 签名（`signRequestHuawei` 只签
 * `host` / `x-sdk-date` / `x-sdk-content-sha256` / `x-security-token` /
 * `content-type` / 显式传入的 `extraHeaders`）⇒ 覆盖它**不会**打破验签。
 * ⚠️ 覆盖只作用于**推理**路径：目录（`fetchSignedGet`）/ 积分 / 签到路径
 * **不显式设置** UA —— 实测 Node 的 `fetch` 会补 `user-agent: node`（本机验证），
 * 而 WAF 只拒 `deepseek-harness/` 前缀 ⇒ 那三条腿本来就过 WAF，无需改动。
 */
export const CODEARTS_USER_AGENT = 'codearts/1.0.0-1147257973136832'
/**
 * codearts 的 provider id。
 *
 * ⚠️ 字面量的**唯一定义处在 `codearts-vision.ts`**（叶子模块）—— 注册期包装
 *（`llm-register-compat.ts` 的 analyzeImage 摘除）与工具层判据必须同源，
 * 两条腿不一致会让「摘掉」与「执行期断言」分叉。此处只是具名转出。
 */
export const PROVIDER = CODEARTS_PROVIDER
/**
 * 本家**恒声明**的两档思考开关 —— 顺序即**强度序（弱 → 强）**（Issue IKLIDV）。
 *
 * ## 为什么顺序是「关闭 → 开启」
 *
 * DSH 的契约把该数组当作**展示顺序**
 *（`dsh-llm/lib/types/types.d.ts` 原文：`Supported efforts in adapter-preferred
 * display order`），而官方客户端**直接 `map`、不排序**
 *（`dsh-client-ui-model-selection/lib/client.js` 的 `effortChoices`：
 * `[…, ...reasoning.efforts.map(…)]`）。故任何「把档位数组铺成一条轴」的渲染
 * —— 官方那个纵向 `menuitemradio` 列表、以及第三方横向滑条 —— 都直接吃这个顺序。
 *
 * 原实现写成 `['on','off']`（把默认档排在最前）。那个动机在**纵向列表**里成立，
 * 一旦铺成**横向轴**就变成「左强右弱」：「开启」贴最左、「关闭」贴最右，
 * 与「左弱右强」的直觉相反。
 *
 * 强度序的**唯一权威**是本仓库的 `reasoning-ladder.ts`
 *（`REASONING_EFFORT_RANK`：`off: 0` / `on: 5`）⇒ `off` 必须在前。
 * 三处旁证同向：
 * - DSH 自家 `dsh-llm-deepseek` 声明 `[off, low, high, max]`；
 * - DSH 自家 `dsh-llm-pi-ai` 的 `THINKING_LEVELS` 是
 *   `[off, minimal, low, medium, high, xhigh, max]`；
 * - 本仓库 `zcode-upstream.ts` 的 `orderReasoningLevels` **主动**把上游的
 *   乱序（实测插入序 `low, max, high`）排成 `none → minimal → low → … → max`。
 *
 * ⚠️ **`defaultEffort` 与数组位置是两件事**：默认档由 {@link CODEARTS_DEFAULT_EFFORT}
 * 单独表达，**不**靠「排在首位」。故本顺序的调整不改变任何默认行为。
 *
 * ⚠️ **本声明的顺序不参与任何语义判断**：关闭思考靠
 * `thinkingOffEffortOf` 的 `.find(isThinkingOffEffort)`（按 rank 找，不按位置），
 * `session-title` 那条路径也只用它当集合。
 *
 * ⚠️ **本常量是这两档的唯一定义处**：同一文件里原先写了**两份**逐字相同的
 * 数组（已知模型的 `toCatalogEntry` 与未知模型的 `unknownModelReasoning`）——
 * 那正是「一文件两套同义判据」的形态，改一处必漏另一处（用户手填模型 id 时会
 * 看到与已知模型相反方向的档位轴）。现已收敛到这一份。
 *
 * ⚠️ 网关的 `openai_efforts` 是这份顺序的**机械投影**
 *（`openai-gateway/effort-view.ts` 逐个 push `canonical`），故本顺序同时决定
 * `/v1/models` 里那一列的可读性：升序 ⇒ `["none","high"]`。
 */
export const CODEARTS_REASONING_EFFORTS: readonly { id: ReturnType<typeof ReasoningEffortId>; name: string }[] =
  Object.freeze([
    { id: ReasoningEffortId('off'), name: '关闭' },
    { id: ReasoningEffortId('on'), name: '开启' },
  ])

/**
 * 默认思考档 = `开启`。
 *
 * 依据（实测 2026-09-29）：不传 `thinking` 与服务端默认等价，而服务端**默认就开着**
 *（`{type:'enabled'}` 与不传的 `reasoning_tokens` 落在同一基线）⇒ 标成 `on`
 * 是**如实描述**，不是我们强行改变行为。
 *
 * ⚠️ 必须落在 {@link CODEARTS_REASONING_EFFORTS} 内：DSH 在 `normalizeModelInfo`
 * 里校验「`defaultEffort` 必须是被声明过的 id」，不在则抛 **`INVALID_MODEL_REASONING`**
 *（整轮对话起不来）。
 * ⚠️ 别与 `UNSUPPORTED_REASONING_EFFORT` 混淆 —— 那个码是**另一回事**：
 * 指「**请求**里带的档位不在该模型声明内」（`resolveCallWithInfo` 抛）。
 * 审计实测（2026-10-14，`dsh-llm/lib/index.js`）：`defaultEffort='on'` 而
 * `efforts=[low,high]` ⇒ code 为 `INVALID_MODEL_REASONING`。本行原写
 * `UNSUPPORTED_REASONING_EFFORT` 是**张冠李戴**（同型措辞在 `raccoon-adapter.ts`
 * 与 `trae-adapter.ts` 是既有问题，本次只修这一处新增注释）。
 */
export const CODEARTS_DEFAULT_EFFORT = 'on'

/**
 * 「该账号没有 benefit（免费额度）包」的稳定失败码。
 *
 * CodeArts 对**积分制**账户（体验版等，没有 benefit 免费额度包）会以
 * HTTP 200 + SSE `InferHub.4004.200 benefit not found` 拒绝带
 * `maas_type: benefit` 的请求，而同一个模型不带该头可以正常出流（实测
 * 2026-10-01，deepseek-v4.1-flash）。`stream()` 命中该码后去掉该头重试一次。
 */
const BENEFIT_NOT_FOUND_CODE = 'BENEFIT_NOT_FOUND'
/** CodeArts 在账号没有 benefit 包时下发的事件 error_code。 */
const CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE = 'InferHub.4004.200'

/**
 * ⚠️⚠️ **本进程内「补头成功过」的模型 id**（2026-10-27 审计 P1 修）。
 *
 * ## 为什么需要它
 *
 * `benefitHeaderPromoted` 是 `stream()` 局部的 ⇒ 远端集合取不到时
 * （本机常态：`gateway/config` 回 `4000 invalid channel`），benefit-only 模型
 * **每条请求**都要「无头 404 → 补头 → 成功」两次 chat。修前（有静态表）只需 1 次
 * ⇒ 这是 PR156 引入的净回归。实测：连续两次 `stream()` 头序列
 * `[null,'benefit',null,'benefit']`，一轮 3 条并发 ⇒ **6 次上游**。
 *
 * ## 边界（如实登记）
 *
 * - **只在进程内**，不落盘：落盘会污染「权威集合」的语义（那只能由远端
 *   `gateway/config` 写）。重启后重新探测一次，代价仅 1 轮。
 * - 只记「补头后**真的成功了**」的模型（`markCodeArtsBenefitLearned` 只在
 *   收到成功响应后调用）⇒ 不会把「上游根本不存在这个模型」记成 benefit。
 * - 上限 {@link CODEARTS_BENEFIT_LEARNED_MAX} 条，防「用户狂换模型 id」把内存撑爆。
 */
const codeArtsBenefitLearned = new Set<string>()
/** 学习集合上限（CodeArts 目录实际只有十来条，留足余量）。 */
const CODEARTS_BENEFIT_LEARNED_MAX = 64

/** 该模型在本进程内是否已被「补头成功」证明过要带 `maas_type: benefit`。 */
export function codeArtsBenefitLearnedFor(model: string): boolean {
  return codeArtsBenefitLearned.has(model)
}

/** 记下「该模型补头后成功」；只由成功路径调用。 */
export function markCodeArtsBenefitLearned(model: string): void {
  if (model.length === 0) return
  if (codeArtsBenefitLearned.size >= CODEARTS_BENEFIT_LEARNED_MAX) {
    // 淘汰最早的（Set 迭代序＝插入序），保持内存有界。
    const oldest = codeArtsBenefitLearned.values().next()
    if (!oldest.done) codeArtsBenefitLearned.delete(oldest.value)
  }
  codeArtsBenefitLearned.add(model)
}

/** 清空学习集合（仅供单测隔离）。 */
export function resetCodeArtsBenefitLearned(): void {
  codeArtsBenefitLearned.clear()
}

/**
 * ⚠️⚠️ **领取福利的跨请求去重表**（2026-10-27 审计 P2 修）。
 *
 * 修前只有 `stream()` 局部的 `benefitClaimAttempted` ⇒ 3 条并发请求各领一次
 * （实测 `claims=3`）。而领取是**写操作**，标题/压缩是后台请求，用户看不到
 * 它们的失败但写请求照发；若上游对领取做了限流/审计，等于每次对话 3 发。
 *
 * ⇒ 按 `access_token` 的短哈希做 key，**同一个 Promise 在 60s 内复用**：
 * - 并发场景：3 条同时进入 ⇒ 拿到**同一个** Promise ⇒ 只发 1 次写；
 * - 跨轮场景：60s 内第二轮复用结果 ⇒ 不再重复领。
 *
 * ⚠️ 用 token 短哈希而不是完整 token：表只在内存里，但别把凭据原文当 key
 *   （本仓库纪律：日志/索引都不留凭据原文）。
 */
const CODEARTS_BENEFIT_CLAIM_DEDUPE_MS = 60_000
interface ClaimDedupEntry { at: number; promise: Promise<string> }
const codeArtsBenefitClaimFlight = new Map<string, ClaimDedupEntry>()

/** 领取去重的 key：凭据标识的短哈希（不落原文）。 */
function claimDedupKey(credential: CodeArtsCredential): string {
  // ⚠️ CodeArts 凭据没有 `access_token`（那是别的 provider 的形状），
  //    身份是 `access_key_id`（+ 可选的 `user_id`）。
  const token = `${credential.access_key_id ?? ''}:${credential.user_id ?? ''}`
  let hash = 0
  for (let i = 0; i < token.length; i += 1) {
    hash = (hash * 31 + token.charCodeAt(i)) | 0
  }
  return `${token.length}:${(hash >>> 0).toString(16)}`
}

/**
 * 领取福利（跨请求去重版）。返回 `claimCodeArtsBenefit` 的原字符串。
 *
 * ⚠️ 去重窗口内**复用同一个 Promise**，因此并发的三条请求只会真正发一次写请求。
 * ⚠️ 失败结果也复用（避免「失败 → 立刻重试」放大写请求）；窗口过了才重新领。
 */
export async function claimCodeArtsBenefitShared(
  credential: CodeArtsCredential,
  fetcher: typeof fetch,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const key = claimDedupKey(credential)
  const now = Date.now()
  const existing = codeArtsBenefitClaimFlight.get(key)
  if (existing !== undefined && now - existing.at < CODEARTS_BENEFIT_CLAIM_DEDUPE_MS) {
    return existing.promise
  }
  const promise = claimCodeArtsBenefit(credential, fetcher, options)
  codeArtsBenefitClaimFlight.set(key, { at: now, promise })
  // ⚠️ 结算后**不移除**条目：窗口内要复用结果（含失败）。过期条目在下次调用时
  //    被替换，且上限兜底防泄漏。
  if (codeArtsBenefitClaimFlight.size > 128) {
    const oldest = codeArtsBenefitClaimFlight.keys().next()
    if (!oldest.done) codeArtsBenefitClaimFlight.delete(oldest.value)
  }
  return promise
}

/** 清空领取去重表（仅供单测隔离）。 */
export function resetCodeArtsBenefitClaimFlight(): void {
  codeArtsBenefitClaimFlight.clear()
}

/**
 * 「模型未注册」的稳定失败码 —— 用于反向补 `maas_type: benefit`。
 *
 * CodeArts 对**只按 benefit 通道注册**的模型（如 `glm-5.3-flash`）会以
 * HTTP 200 + SSE `InferHub.002002009.404 The model is not registered` 拒绝
 * 不带 `maas_type: benefit` 的请求；带上该头才能出流。它与
 * {@link BENEFIT_NOT_FOUND_CODE} 恰好**互为镜像**：一个说「该带头却没带」，
 * 一个说「不该带却带了」。`stream()` 两条都要能自愈。
 */
const MODEL_NOT_REGISTERED_CODE = 'MODEL_NOT_REGISTERED'
/** CodeArts 在「该模型只按 benefit 通道注册」时下发的事件 error_code。 */
const CODEARTS_MODEL_NOT_REGISTERED_ERROR_CODE = 'InferHub.002002009.404'

/**
 * 额度用尽时抛出的错误码 —— **字面量 `'QUOTA_EXCEEDED'`，不是 harness 常量**。
 *
 * ## ⚠️ 为什么不能用 `QUOTA_EXCEEDED_CODE`（真实缺陷，Gitee issue IKJVCW）
 *
 * harness 导出的 `QUOTA_EXCEEDED_CODE` 字面值是 **`'QUOTA'`**，而 DSH 客户端
 * 对这三个码会**丢弃适配器精心写的 message、换成一句固定文案**
 * （实测 `dsh-client-ui-chat/lib/client.js`，桌面端 `app.asar` 内为逐字节同串）：
 * ```js
 * if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
 * return code === "AUTH" ? t("message.failure.auth") : message;
 * ```
 * locale 表：`"message.failure.quota": "当前请求的额度已用尽"`。
 *
 * 于是 {@link codeartsQuotaExhaustedMessage} 里那句**带解禁时间**的说明
 * （「预计 5.5 小时后重置（按 UTC+8 自然日结算…）可改用其它模型…」）
 * 一个字都到不了用户眼前 —— 用户只看到「当前请求的额度已用尽」，
 * 既没有原因也没有出路。这与 `docs/agent-notes/client-ui.md` 记的
 * 「凡是要把自定义文案送到用户眼前，码必须避开这三个」是**同一条铁律**；
 * buddy 的 `11140` 当初正因如此才从 `AUTH` 改成 `PERMISSION_DENIED`。
 *
 * ## 为什么取字面量而不是 `PERMISSION_DENIED`
 *
 * ① **语义准确**：额度用尽的出路是「等重置 / 充值 / 换模型」，不是「没权限」。
 *    仓库里 buddy / cline / lobsterai / trae / zcode / minimax 等 **~20 处**
 *    额度错误一律用字面量 `'QUOTA_EXCEEDED'`，且**都不被客户端替换** ——
 *    本处改用 harness 常量才是异类（codearts 是**唯一**用它的 provider，
 *    这正是缺陷只在本家复现的原因）。
 * ② **可重试性不变**：`'QUOTA_EXCEEDED'` 与 `'QUOTA'` **同样不在**
 *    harness 的 `DEFAULT_RETRYABLE_CODES`（`EMPTY_RESPONSE / RATE_LIMIT /
 *    SERVER / TIMEOUT / TRANSPORT`）里 ⇒ 仍是「确定性、不白退避」。
 * ③ **下游判据已双认**：`account-probe.isRateLimitFailure` 与
 *    `qoder-adapter.isQuotaExceededError` 都同时接受 `'QUOTA_EXCEEDED'`
 *    与 `'QUOTA'`；`dead-model-store` 的 `IGNORED_CODES` 更是**只收**
 *    `'QUOTA_EXCEEDED'` —— 原先靠 `NOT_GONE_PATTERNS` 的 `/额度/` 文案兜底
 *    才没被误记成模型失效，改后是显式命中，比原来更稳。
 *
 * ⚠️ **不要改回 `QUOTA_EXCEEDED_CODE`**，也不要为「与 harness 词汇一致」
 * 而改回 `'QUOTA'`：那正是本缺陷的成因，会让解禁时间再次从 UI 上消失。
 */
const CODEARTS_QUOTA_EXHAUSTED_CODE = 'QUOTA_EXCEEDED'

// DeepSeek V4（CodeArts Agent 模型列表新增，UI 标注"每日 1000 万免费 Tokens"福利）：
//
// 修正（2026-09-23，对齐 deveco-code-rust fb1b4a2）：早期注释称
// 「deepseek-v4-flash-0731 后端未注册」，该结论**有误** —— 实测它返回 404 的
// 真实原因是**缺少 `maas_type: benefit` 头**；带上该头即成功。带日期后缀与
// 无后缀是后端上两个不同的模型，均有注册，不能互相替代：
//   - deepseek-v4-flash-0731 / deepseek-v4-pro-0813 → benefit 模型（需 maas_type）
//   - deepseek-v4-flash / deepseek-v4-pro（无后缀）  → 非 benefit（带该头会
//     `unsupported model`）
// gateway/config 返回的是 benefit 那组，故下方静态表保留无后缀形态
// （无后缀始终可用，不依赖 benefit 头）。
//
// ## ⚠️⚠️ 2026-10-27 全表实测校准（逐条真机请求，两个账号交叉验证）
//
// 旧表 9 条里 **3 条已彻底失效**、4 条上游新模型完全缺席。实测结果：
//
// | 条目 | 不带头实测 | 处置 |
// |---|---|---|
// | `GLM-5.2` | 200 | 保留 |
// | `GLM-5.1` | **200（仍可用！）** | 保留 —— 不在 builtin 目录里**不等于**不可用 |
// | `GLM-5` | **404 InferHub.002002009** | **删除** |
// | `glm-5.3-flash` | **404 InferHub.002002009** | **删除** |
// | `openpangu-2.0-flash` / `-pro` | 200 | 保留 |
// | `deepseek-v4-flash` | **200（仍可用！）** | 保留 |
// | `deepseek-v4-pro` | **404 ModelArts.81009 Invalid model** | **删除** |
// | `deepseek-v4.1-flash` | 200 | 保留 |
// | `glm-5.3` / `glm-5.2-sft-harmony` | 200 | **新增**（上游有、旧表漏） |
// | `deepseek-v4.1-flash-1017` | 200 | **新增**（issue IKQY27 的新模型） |
// | `kimi-k3` | 200 | **新增** |
//
// ⚠️ **判据是「真机能不能调通」，不是「在不在 builtin 目录里」**：`GLM-5.1`
// 与 `deepseek-v4-flash` 实测 200，若按目录比对删掉就会让用户少两个可用模型
// （这正是 `dead-model-store.ts` 头注释里「不从残缺目录反推」那条铁律）。
//
// ⚠️ VL 模型（`kimi-k2.6-vl` / `Qwen3-VL-235B`）**刻意不入本表**：它们被
// `catalogEntries` 的可见性过滤挡在主列表外，只经 `analyzeImage` 间接调用。
//
// ⚠️⚠️ **`kimi-k3` 也不在本表**（2026-10-30 第二轮审计 P1 N-1 修）：
// 它是**只在 AgentCenter 出现**的模型（builtin 漏发）⇒ AgentCenter
// **不下发倍率** ⇒ 它进目录必然是**裸名** ⇒ `priceFactorFromName` 恒
// `Infinity` ⇒ 聚合里 codearts 恒排最后、永远不被挑中（静默）。
// ⇒ **窗口源条目一律不进对话目录**（两条路径：远端与冷缓存兜底）。
// ⚠️ 它的**上下文窗口**仍可用：见 `CONTEXT_WINDOWS`（静态兜底）与
// `remoteContextWindows`（动态权威）—— 用户手填 `kimi-k3` 时分母是对的。
export const DEFAULT_MODELS: readonly string[] = [
  'GLM-5.2', 'GLM-5.1',
  'glm-5.3', 'glm-5.2-sft-harmony',
  'openpangu-2.0-flash', 'openpangu-2.0-pro',
  'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017',
]

/**
 * 模型上下文窗口（最大合并请求+响应 token 数）。
 *
 * ## 权威来源与取证（2026-10-21 重取证）
 *
 * ⚠️⚠️ **不是从 HTTP 端点读的** —— 本家两个目录端点**都不下发窗口**：
 * `snap-access /v1/model/builtin` 的条目键全集实测只有
 * `channel_source, credit, display_enabled, enable, intervals, model_category,
 *  model_desc, model_id, model_name, model_sku, provider, supports_images, time_slots`
 * （**无任何 context/window/length/token 类字段**）；`opengw gateway/config`
 * 本机 4 个账号全回 `4000 invalid channel, group not found`。
 *
 * 权威来源是 **CodeArts Agent IDE 自己下发的 provider 配置**：
 * 内核日志 `cag-global-server` 的 `provider models replace body is {…}` 里
 * `provider["inferhub-provider"].models[*].limit.context`。
 * 本机取证范围 **2026-09-11 ~ 2026-10-21，42 份内核日志**，按日期收敛：
 *
 * | 模型 | `limit.context` | 取值历史 |
 * |---|---|---|
 * | `GLM-5.2` | **202_752** | 09-11~10-20 是 `202_752`；**10-21 改 1_048_576**；
 * | | | **10-29 IDE 0.2.6 抓包 + AgentCenter 又改回 202_752**（三次漂移，见下） |
 * | `glm-5.3` | **1_048_576** | 同上（09 月表里没有它，10-17 起出现，先 202752 后 1M） |
 * | `glm-5.2-sft-harmony` | **202_752** | 全期稳定（09-11~10-29，AgentCenter 一致） |
 * | `openpangu-2.0-flash` / `-pro` | **524_288** | 全期稳定（AgentCenter 一致） |
 * | `deepseek-v4.1-flash` | **1_048_576** | 全期稳定（本表原先写 1_000_000，**已按 IDE 权威值改正**） |
 * | `kimi-k3` | **1_048_576** | 2026-10-29 补（IDE 0.2.6 + AgentCenter 一致；此前缺行走 524_288 兜底） |
 * | `glm-5.3-flash` | **1_048_576** | 逆向自 IDE gateway/config（对齐 deveco-code-rust 90aeb17d） |
 * | `deepseek-v4-flash` / `-pro` | **1_048_576** | UI 标注「每日 1000 万免费 Tokens」同批（对齐 fb1b4a2） |
 *
 * ⚠️⚠️ **`GLM-5.2` 的窗口是本表唯一三次漂移的行**：202_752（09~10-20）→
 * 1_048_576（10-21 校准）→ **202_752（10-29 复测，IDE 0.2.6 抓包 + AgentCenter
 * 动态源双源一致）**。⇒ 结论：**10-21 那次不是「上游永久上调」而是临时值/灰度**。
 * 本表现按 2026-10-29 权威写回 202_752 —— 但它是**兜底**（冷缓存/AgentCenter
 * 失败时才用到）：运行时权威已由 AgentCenter 动态下发（`RemoteModel.contextWindow`，
 * 优先于本表），下次上游再漂移不再依赖改这张表。
 *
 * ⚠️ **本表查不到时不再省略 `context`** —— 见 {@link CODEARTS_FALLBACK_CONTEXT_WINDOW}。
 */
const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['GLM-5.2', 202_752],
  ['glm-5.3', 1_048_576],
  ['glm-5.3-flash', 1_048_576],
  ['glm-5.2-sft-harmony', 202_752],
  ['openpangu-2.0-flash', 524_288],
  ['openpangu-2.0-pro', 524_288],
  ['deepseek-v4-flash', 1_048_576],
  ['deepseek-v4-pro', 1_048_576],
  ['deepseek-v4.1-flash', 1_048_576],
  // ⚠️ `-1017` 是上游**独立注册**的模型（`/v1/model/builtin` 与
  //    `deepseek-v4.1-flash` 同时下发，`src/models.ts` 用**原始 `model_id`**
  //    当对外 id 与去重键——2026-10-27 修，见 `parseModelInfo`），
  //    但**窗口与老版一致**（用户 2026-10-27 确认）。
  //    不补这一行会让它走 524_288 的具名兜底 ⇒ 分母错 2 倍、压缩阈值偏早
  //    （正是 `CODEARTS_FALLBACK_CONTEXT_WINDOW` 注释里记录的那条报障形态）。
  ['deepseek-v4.1-flash-1017', 1_048_576],
  // ⚠️ `kimi-k3` 在 IDE 0.2.6 与 AgentCenter 目录里都有（2026-10-29 取证），
  //    但 2026-10-29 前的 `/v1/model/builtin` 快照**没有它** ⇒ 曾走 524_288
  //    兜底（分母错 2 倍）。现由 AgentCenter 动态补目录 + 窗口，本行是兜底。
  ['kimi-k3', 1_048_576],
])

/**
 * 本表查不到时**必须**给的那个窗口（`undefined` 在本家是不可接受的）。
 *
 * ## 为什么不能「查不到就省略」（真实报障，2026-10-21）
 *
 * 用户报障「codearts 对话后，DSH 下方本该显示上下文占用比的地方没有显示」。
 * 判据链在宿主侧：
 * 1. `dsh-client-ui-conversation/lib/client.js` 的 `contextOccupancy()`：
 *    `if (usedTokens === void 0 || pressure?.contextWindow === void 0) return null`，
 *    而 `ContextMeter` 在 `context === null` 时 **`return null`** ⇒
 *    整个环 + 百分比 + 弹层**都不渲染**（不是显示 0%，是**根本不出现**）；
 * 2. 分母 `contextWindow` 来自 `dsh-agent-loop` 写入的 `request/context` 事件，
 *    值就是适配器 `resolveModel()` 返回的 `context.contextWindow`。
 *
 * ⇒ **本家任何一条目录条目缺窗口，用户就少一个占用条**。实测当时 7 条目录里
 * 只有 2 条有窗口（`glm-5.3` / `openpangu-*` / `glm-5.2-sft-harmony` 全缺）。
 * 会话落盘对照（`session-fd3e2786`，同一会话内切模型）：
 * `{"model":"deepseek-v4.1-flash","contextWindow":1000000}` 有 ⇒ 条在；
 * `{"model":"glm-5.3"}` 无 ⇒ 条消失。
 *
 * ## 为什么是「具名兜底」而不是继续省略
 *
 * 仓内先例：`aggregate-adapter.ts` 的 `AGGREGATE_COLD_CONTEXT_WINDOW` —— 同一个
 * 宿主约束（`dsh-compaction-basic` 在 `info.context === undefined` 时抛
 * `TargetPressureConfigError: no context capacity for …`）⇒ 纪律是
 * 「**宁给具名兜底，不省略**」。本家是直连适配器，省略即同时丢掉占用条与
 * 压缩阈值的唯一输入。
 *
 * ## 取值 524_288 的取舍（用户 2026-10-21 选定）
 *
 * 取**当前目录里最小的真实窗口**（`openpangu-*` 实测值）：
 * - 偏小 ⇒ 对 1M 模型会**偏早**触发自动压缩（代价：多压一次，不报错）；
 * - 偏大 ⇒ 若某未知模型其实更小，就变成**上游溢出报错**而不是自动压缩
 *   （代价：一轮对话报废）。
 * ⇒ 取偏小一侧。⚠️ **本值不是「实测的该模型窗口」**，只是安全边界；
 * 命名与注释都不得声称它是真值（与 `AGGREGATE_COLD_CONTEXT_WINDOW` 同纪律）。
 */
export const CODEARTS_FALLBACK_CONTEXT_WINDOW = 524_288

/**
 * 取某模型的上下文窗口：**静态表优先、查不到用具名兜底**（恒返回正数）。
 *
 * ⚠️ 兜底**必须**在 `resolveModel` 与目录两条路径上都生效 —— 只改一条会让
 * 「选择器里显示了」与「对话里不显示」分叉（本家目录与 `resolveModel`
 * 共用 `CONTEXT_WINDOWS`，故收敛到这里）。
 */
export function codeartsContextWindow(modelId: string): number {
  const known = CONTEXT_WINDOWS.get(modelId)
  return known !== undefined && known > 0 ? known : CODEARTS_FALLBACK_CONTEXT_WINDOW
}

/**
 * 把上游 `ratio_display` 原串转成**仓内倍率口径**（`x0.7`）。
 *
 * ## 为什么必须转（2026-10-21 合并审计发现）
 *
 * 上游 `/v1/model/builtin` 的 `ratio_display` 是 `0.7x`（**x 在数字后**），
 * 而全仓其余各家的展示名是 ` · x{n}`（**x 在数字前**）：buddy（`x0.29`）、
 * loomy（`x0.1`）、trae（`x0.08`）、accio（`x0.013`）、lobsterai（`x1.08`）。
 *
 * ⚠️ 而 `src/aggregate-core.ts` 的 `priceFactorFromName` 是**全仓唯一的倍率解析口**
 * （聚合的「同临期档内倍率升序」与选择器的 `· 最低 x{n}` 都走它），它的正则
 * `·\s*[×x]?\s*(\d+(?:\.\d+)?)...$` 把 `[×x]?` 放在数字**之前** ⇒
 * ` · 0.18x` **匹配不上** ⇒ 恒返回 `Infinity`。
 *
 * ⇒ 后果：codearts 是聚合渠道（`AGGREGATE_CHANNELS` 第 1 位），它的候选价格
 *   恒为 `Infinity` ⇒ 聚合**永远挑不到 codearts**（同临期档内它排最后），
 *   选择器的「· 最低 x{n}」也漏掉它。
 *
 * ## 转换的边界（红线：绝不臆造）
 *
 * - **只改形态，不改数值** —— 数值仍逐字取自上游 `ratio_display`；
 * - **认不出就返回 `undefined`**（调用方据此不显示倍率，**不用占位值冒充**）；
 * - ⚠️ 上游若改形态（比如也改成 `x0.7`）⇒ 这里认不出 ⇒ 不显示倍率
 *   （**保守方向**：少显示好过显示一个错的数）。此时应更新本函数与
 *   `RemoteModel.rateLabel` 的注释。
 */
export function codeartsRateSuffix(display: string): string | undefined {
  if (typeof display !== 'string') return undefined
  const m = /^\s*(\d+(?:\.\d+)?)\s*x\s*$/i.exec(display)
  if (m === null) return undefined
  return `x${m[1]}`
}

/**
 * 单次请求输出上限的安全边界。
 *
 * ⚠️ 取值依据是**本文件下方出站处的实测**（参考实现 deveco-code-rust e2e：
 * 65536 可用，131072 反而触发空流被后端拒绝）。**不是**「拒绝 128000」——
 * CodeArts 语境下仓库里没有任何 128000 的实测记录（README 那张
 * 128000/131072 表属于 buddy/workbuddy；`deepseek-v4.1-flash` 两个 provider
 * 都有该 id，极易张冠李戴）。
 *
 * ⚠️ 这是**全 provider 统一**的边界，不是逐模型表：本适配器的出站点只有一个，
 * 而 `CONTEXT_WINDOWS` 之上方已注明「窗口的权威来源是 IDE 下发的 provider 配置」——
 * 拿不到实测就不该臆造更小的值。故凡走本适配器的模型一律收敛到此上限。
 * ⚠️ 与窗口**不是同一件事**：窗口缺失走的是 `CODEARTS_FALLBACK_CONTEXT_WINDOW`
 * （有兜底），输出上限这里是**恒定收敛**（无兜底分支）。
 */
const CODEARTS_MAX_OUTPUT_TOKENS = 65_536

/**
 * `maxTokens` **缺省时**下发的输出上限 —— 与 IDE 逐字一致（2026-10-30 取证）。
 *
 * ## 为什么有两个常量（`CODEARTS_MAX_OUTPUT_TOKENS` vs 本值）
 *
 * 它们回答的是**两个不同问题**，混用会让其中一个静默失效：
 *
 * | 常量 | 回答的问题 | 值 |
 * |---|---|---|
 * | {@link CODEARTS_MAX_OUTPUT_TOKENS} | 「上游**最多**接受多少」的**安全边界** | 65_536 |
 * | **本值** | 「**没人指定时我们该发多少**」的**默认预算** | 32_000 |
 *
 * ## 取证
 *
 * Reqable 抓包 4 条真实 IDE 聊天请求，`model=deepseek-v4.1-flash-1017` 的
 * `max_tokens` **恒为 32000**（4/4，无一例外），而 AgentCenter 的
 * `model_parameters.max_tokens` 给的**上限**是 65536。
 * ⇒ IDE 的 32000 是**客户端默认预算**，不是模型能力上限。
 *
 * ## ⚠️⚠️ 为什么不能直接把 {@link CODEARTS_MAX_OUTPUT_TOKENS} 改成 32000
 *
 * 那个常量是**钳制上界**（`clampCodeArtsMaxTokens` 用它 `Math.min`）。改成
 * 32000 会**静默削掉**调用方明确要求的长输出 —— 而长输出正是本家接
 * `tool_stream` 的理由（大文件 write 的参数 JSON 需数万 token，截断会产出
 * 非法 JSON，harness 报 `invalid arguments`）。⇒ 两者必须分开：
 * **默认值降级对齐 IDE，上界保持 65536**。
 *
 * ⚠️ 与 `RemoteModel.maxOutputTokens` 的取舍一致：上游声明的上限**不**当默认
 * 预算用（否则宿主的压缩预留会跟着变，见 `readAgentCenterWindow` 的注释）。
 */
const CODEARTS_DEFAULT_MAX_OUTPUT_TOKENS = 32_000

/**
 * 收敛输出上限到安全区间；非法值返回 undefined（不编造，交由调用方取默认）。
 *
 * ⚠️ 存在的理由与 TRAE 的 `clampTraeMaxTokens`、Cline 的 `clampClineMaxTokens`
 * 完全同因：上游网关对超大 `max_tokens` 会直接 4xx，而 DSH 可能注入一个来自
 * 其它 provider 的大值（`maxTokens` 是 agent 的一等构造参数，只校验
 * 「正安全整数」、**无上限校验**）。网关层的 `normalizeMaxTokens` 只覆盖
 * 走 `/v1/chat/completions` 与 `/v1/responses` 的请求，**直连路径完全绕过它**
 * ⇒ 本函数是最后一道防线。
 */
function clampCodeArtsMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const integer = Math.floor(value)
  if (integer <= 0) return undefined
  return Math.min(integer, CODEARTS_MAX_OUTPUT_TOKENS)
}

export interface CodeArtsAdapterOptions {
  credentialRef: CredentialRef
  resolveCredential: () => Promise<CodeArtsCredential | undefined>
  refresh: () => Promise<void>
  /** 动态拉取远端模型列表；失败时调用方回退到静态列表。 */
  fetchRemoteModels?: () => Promise<RemoteModel[]>
  /**
   * 最近一次目录拉取的**各来源成败**（issue IKJVTF，审计 I3）。
   *
   * CodeArts 的目录来自**两个独立端点**（`opengw gateway/config` 给 benefit 模型、
   * `snap-access /v1/model/builtin` 给常规模型），而失败路径都**静默**返回
   * `undefined` ⇒ 「一个成功、一个失败」时 `models.length > 0`，旧判据会把它
   * 当成「已拿到目录」⇒ **永久缓存**（短路）⇒ 残缺目录固化，只能重启 DSH。
   *
   * ⚠️ 用**回调**而非直接读 `service` 的内部状态：适配器不该依赖 `CodeArtsAuth`
   * 的字段形状（它由 `index.ts` 接线，且单测用替身）。接线层把它桥接成
   * 「读 `service.lastCatalogOutcome`」，见 `src/index.ts`。
   *
   * 返回 `undefined` 时按「无法判定」处理 —— 与 `normalizeLoadResult` 的
   * 向后兼容口径一致（`complete = got`）。
   */
  catalogComplete?: () => boolean | undefined
  /**
   * 时钟（注入以便单测推进目录 TTL；缺省 `Date.now`）。
   *
   * ⚠️ 只用于**目录新鲜度**（`ensureRemoteModels` 的 `isCatalogFresh`），
   *    不用于超时/退避计时 —— 那些仍走真实时钟。
   *    ⚠️ **buddy 是例外**：它的 `catalogGate` 也吃这个时钟（冷却与
   *    「距上次尝试 ≥10 秒」判定都走它），所以别把本行当成全仓库通用口径。
   */
  now?: () => number
  fetchImpl?: typeof fetch
  chatId?: string
  sessionId?: string
  /** 多账号池（用于限流时切换账号） */
  accountPool?: AccountPool
  /**
   * 远端目录**落地后**的通知回调（issue IKJVTF）。
   *
   * 由 `registerCodeArtsLlm` 注入为 `broadcastCatalogChanged(ctx)`。适配器本身
   * 拿不到 `ctx`，故必须由接线层桥接（与 `readImage` 等回调同一模式）。
   *
   * ⚠️ 必要性：客户端 `ModelCatalogDirectory` 在 `status === 'ready'` 时**短路
   * 返回缓存**，只在宿主事件上 `refresh()`。没有本回调时，冷启动首拉失败
   * 缓存的**兜底表**会永久留在对话框里，远端目录真的落地也不重读。
   */
  onCatalogLoaded?: () => void
  /**
   * 读图片字节（内联为 data URL 发上游）。
   *
   * ## 为什么必须由接线层桥接
   *
   * 适配器拿不到 `ctx`，而图片字节在附件服务（`ctx.attachments.readImage`）里。
   * 接线层用 `makeReadImage(ctx)` 注入 —— 与其余 14 家**同一个**桥接件，
   * 不另写第二套（本仓纪律：同一语义只留一份实现）。
   *
   * ## ⚠️ 只有 VL 模型能收图（实测）
   *
   * 见 {@link CODEARTS_VL_MODELS}：`kimi-k2.6-vl` / `Qwen3-VL-235B` 收图 200，
   * 文本模型（含 `glm-5.3`）一律 `InferHub.001001020.406 The request model is
   * not multimodal`。故本回调只会在**目标模型声明了 image 模态**时被调用
   * （模态声明见 `toCatalogEntry` 的 `inputModalities`）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string }>
}



/**
 * 能**原生收图**的模型（`supports_images: true`，`model_category: 图片理解`）。
 *
 * ## 实测（2026-10-21，只读探测 `/v1/model/builtin`，8 条目录逐条核对）
 *
 * | 模型 | `supports_images` | `model_category` |
 * |---|---|---|
 * | `kimi-k2.6-vl` | **true** | **图片理解** |
 * | `Qwen3-VL-235B` | **true** | **图片理解** |
 * | `GLM-5.2` / `glm-5.3` / `glm-5.2-sft-harmony` / `openpangu-2.0-flash` / `openpangu-2.0-pro` / `deepseek-v4.1-flash` | false | 文本生成 |
 *
 * ⇒ 只有这两条能收图，其余**发图必被上游拒**：
 * `{"error_code":"InferHub.001001020.406","error_msg":"The request model is not multimodal"}`
 * （实测 glm-5.3，见 `CODEARTS_VL_MODELS` 的探测记录）。
 *
 * ## ⚠️ 与「VL 模型不进目录」的关系（**刻意保留**）
 *
 * `toCatalogEntry` / `catalogEntries` 仍**把 VL 模型从对话目录里过滤掉**
 *（`-VL-` / `-vl` 判据）—— 它们上下文小、不支持工具调用，当 agent 主模型会
 * 踩别的坑。本表**只用于两件事**：
 * 1. 判断「某个模型能不能收图」（{@link codeartsAcceptsImage}）；
 * 2. `analyzeImage` 工具内部挑一个 VL 模型去做识图（{@link codeartsVisionModel}）。
 *
 * 即：**用户仍然不能在模型选择器里选 VL 模型，但主模型可以借它识图** ——
 * 这与 IDE 自己的行为一致（IDE 也是 `fetchMultimodalModelId` 选一个 VL 模型
 * 去服务 `analyzeImage` 工具，见 `docs/agent-notes/providers-codearts.md`）。
 */
// ⚠️ 「哪个模型能收图」与「analyzeImage 用哪个 VL 模型」的**唯一定义处**在
//    `codearts-vision.ts`（无依赖叶子模块，理由见其模块头）：那里同时被**注册期包装**
//    （`llm-register-compat.ts` 逐请求摘除 analyzeImage）与工具层使用，
//    写在这里会让 `llm-register-compat → llm-adapter → llm-register-compat` 成环。
//    本文件只**转出**这两个符号，既有导入路径（`from './llm-adapter.js'`）不变。
export { codeartsAcceptsImage, codeartsVisionModel }

/**
 * 把 harness 的图片块转成 CodeArts 接受的 wire 形态。
 *
 * ## ⚠️⚠️ 只有一种形态被接受（2026-10-21 实测四选一）
 *
 * 对 `kimi-k2.6-vl` 与 `Qwen3-VL-235B` 各发一张 8×8 纯红 PNG、问「是什么颜色」：
 *
 * | 形态 | 结果 |
 * |---|---|
 * | **`{type:'image_url', image_url:{url:'data:…'}}`** | **HTTP 200，答「红色」** ✅ |
 * | `{type:'image_url', image_url:'data:…'}`（字符串） | 406 `InferHub.001001046` multimodal content incorrect |
 * | `{type:'image', source:{type:'base64',…}}`（Anthropic 系） | 400 `ModelArts.81001` unsupported content type |
 * | `{type:'input_image', image_url:…}`（Responses 系） | 406 `InferHub.001001046` |
 *
 * ⇒ **必须是 OpenAI 的「对象套 url」形态**，且 url 是 base64 data URL。
 * 反向对照：同一份格式发给文本模型 `glm-5.3` 得
 * `InferHub.001001020.406 The request model is not multimodal` ⇒ 这条判据有判别力。
 *
 * @param dataUrl - 已经拼好的 `data:image/…;base64,…` 串
 */
export function codeartsImagePart(dataUrl: string): { type: 'image_url'; image_url: { url: string } } {
  return { type: 'image_url', image_url: { url: dataUrl } }
}

/**
 * 判断模型是否为 deepseek-v4 系列（flash/pro）。
 *
 * deepseek-v4 对标准 OpenAI 格式的 `tool_calls.arguments` 采用一次性打包
 * 生成：模型在生成超大工具参数（如 2000 行 write content）期间 SSE 流
 * 长时间无数据，APIG 网关 ~60s 空闲超时必然掐断连接（`terminated`），
 * 且后端不会对任何请求头发送心跳保活（实测 2026-08-22：无论是否携带
 * app-id/plugin-name/x-ot-* 等 IDE 头、是否带 `accept: text/event-stream`、
 * `tool_stream`、调整 `max_tokens`，SSE 流均无 `:` 注释行，60s 静默必断）。
 *
 * 但 deepseek-v4 原生支持 DSML 工具调用格式：工具调用直接写入
 * `delta.content`（形如 `<｜DSML｜tool_calls>...`），走与 reasoning 相同的
 * 流式通道。实测（2026-08-22 e2e 探测）：1000 行 write content 的 DSML
 * 流全程最大静默仅 204ms，146s 完整结束；标准 tool_calls 模式 100 行也
 * 会在 17.7s 静默后一次性到达、300 行即 60s 断连。因此对 deepseek-v4
 * 模型将工具 schema 注入 system 消息、请求体不发送 `tools` 字段，让模型
 * 以 DSML 流式输出工具调用，从根上规避网关空闲断连。
 */
/**
 * ⚠️ **已移至共享层 `./dsml.js`**（2026-10-13）。
 *
 * OfficeAce 通道复用不到本文件的实现 ⇒ 漏注入 DSML 提示 ⇒ 模型臆造
 * `<｜DSML｜ calls>` 语法。协议定义**必须只有一份**。
 */
export { isDeepseekV4Model, needsDsmlToolMode, buildDsmlSystemPrompt } from './dsml.js'
import {
  buildDsmlSystemPrompt,
  DsmlContentExtractor,
  isDeepseekV4Model,
  needsDsmlToolMode,
} from './dsml.js'

/**
 * 工具名匹配大参数写文件类工具（content/arguments 可能达到数万 token）。
 * 仅用于对非 deepseek-v4 模型的 DSML 模式降级判定（当前全量模式不再使用此列表）。
 */
/**
 * 判断模型是否应使用 DSML 原生工具调用语法输出。
 *
 * deepseek-v4 模型始终走 DSML 模式（不论工具列表中包含什么工具），原因：
 * - 标准 `tool_calls` 模式要求参数一次性打包生成，SSE 流在生成参数期间长时间
 *   无数据，APIG 网关 ~60s 空闲超时必然掐断连接（`terminated`），且后端不对
 *   任何请求头发送心跳保活；
 * - 除 write/file_write/apply_patch 外，`subagent` 的 `prompt` 参数也可能很长
 *   （包含详细任务描述与上下文），同样面临网关断连风险；
 * - DSML 模式使工具调用通过 `delta.content` 流式输出（全程有数据流），从根上
 *   规避网关空闲断连，实测 1000 行 write content 的 DSML 流全程最大静默仅
 *   204ms，146s 完整结束；
 * - 模型行为统一，避免不同步骤间标准/DSML 模式切换引入的不一致。
 *
 * 非 deepseek-v4 模型（如 openpangu / GLM-5.2 等）使用华为标准 IAM AK/SK 鉴权，
 * 不走 CodeArts Agent APIG 网关，无 60s 空闲断连问题，继续保持标准 tool_calls。
 */
/**
 * CodeArts 并发排队端点。当后端按账户的会话
 * 并发上限达到时，chat completions 请求会以
 * `TM.00001041`（"并发会话数已达上限"）失败，调用方需轮询
 * 排队状态端点，直到后端再次允许该会话。
 */
export const QUEUE_STATUS_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status'

/** 在 CodeArts 队列中等待时的轮询间隔。 */
const QUEUE_RETRY_DELAY_MS = 10_000
/** 轮询上限：180 × 10 秒 = 30 分钟，与 deveco-code 参考实现一致。 */
const QUEUE_MAX_ATTEMPTS = 180

/**
 * APIG「正文哈希对不上」时**直接重发**的次数上限。
 *
 * 取 2：该故障是上游网关侧的瞬时状态，实测两次连续失败后第三次即可成功；
 * 再多只是把真正的持续故障拖长，反而掩盖问题。
 */
const SIGNATURE_RETRY_MAX = 2
/** 重发的退避基数：第 n 次等 n × 该值（500ms、1000ms）。 */
const SIGNATURE_RETRY_DELAY_MS = 500

/**
 * SSE 流空闲超时。CodeArts 后端 / APIG 网关对 SSE 连接有 ~60 秒无数据即
 * 断开的策略：当模型生成超长推理或大工具调用参数时，两次 chunk 之间可能
 * 静默数十秒，连接被服务端掐断后 Node undici 的 reader.read() 抛
 * `TypeError: terminated`。该错误非 HarnessError，被 normalizeLlmFailure
 * 归类为 UNKNOWN（不可重试），harness 直接失败。
 * 主动以略小于网关超时的窗口检测空闲：超时则取消 reader 并抛可重试的
 * TIMEOUT，让 harness 重试该步骤（历史已持久化，重试会带相同上下文）。
 *
 * SSE 流超时配置（对齐 CodeArts Agent IDE agentkernelServer 逆向实证：
 * `firstTokenTimeout = 300000` / `chunkTimeout = 600000`）。
 *
 * 历史背景：原实现用单一 `SSE_IDLE_TIMEOUT_MS = 55_000`（55s），对齐
 * APIG 网关 ~60s 空闲断连。但 deepseek-v4-flash 生成大文件 write 工具
 * 调用的 content 参数时，会先输出 file_path 参数然后长时间静默（模型
 * 在内部做长文本生成但不在 SSE 上 flush），实测三次均在 ~55s 处被掐断、
 * 重试后又重复相同模式——55s 对这类"思考型长生成"太短。
 *
 * IDE 的方案是拆成两个超时：
 * - firstTokenTimeout=300s：等第一个 token 的窗口，到点才报错
 * - chunkTimeout=600s：每收到一个 chunk 就重置；两次 chunk 之间超过 10 分钟才报错
 *
 * 两者均可通过环境变量覆盖（毫秒，整数），便于测试用短超时触发 TIMEOUT
 * 路径，或在线上针对特定模型调优。环境变量在每次 stream() 调用时读取，
 * 避免模块顶层常量在 import 时定型、测试运行中设置环境变量不生效。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 300_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 600_000
}

/**
 * 判断一个错误是否为 SSE 传输级故障（连接被对端掐断 / socket 重置 /
 * undici 内部 socket 错误），而非业务错误。这类错误可安全重试整个
 * chat 请求，因此映射为可重试的 TRANSPORT code，而非 UNKNOWN。
 */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  // undici / Node 流在连接被对端关闭时抛 "terminated"
  if (message.includes('terminated')) return true
  // undici socket 错误（UND_ERR_SOCKET / UND_ERR_HEADERS_TIMEOUT 等）
  if (error.name.startsWith('UND_ERR_')) return true
  // fetch 网络层失败
  if (message.includes('fetch failed')) return true
  // TCP 重置 / 对端中断
  if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/**
 * SSE 流内可重试的排队/限流错误信号。CodeArts 后端有时以 HTTP 200 +
 * SSE 内嵌错误的形式返回排队/限流（如 `InferHub.ModelArts.81111.429`
 * TPM 超限），而不是 4xx——适配器把这种响应当成排队处理：延迟后
 * 重新发起整个 chat 请求，与 TM.00001041 行为一致。
 */
class SseQueueRetryError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SseQueueRetryError'
    this.code = code
  }
}

/**
 * SSE 流内「额度已用尽」的信号（**不可重试**）。
 *
 * ⚠️ 必须与 {@link SseQueueRetryError} **分开**：排队是「等一会儿就通」，
 * 额度是「等多久都没用」。把它当排队处理正是本次缺陷的表象
 * （静默重试 30 分钟、界面零输出）。
 *
 * 之所以要单独一个类而不是直接抛 `LlmError`：`stream()` 需要在**同一个地方**
 * 完成「标记账号受限 + 切下一个账号 + 如实抛出」三件事，且要能 `continue`
 * 重试循环 —— 这件事只有捕获点的上下文（`credential` / `currentAccountId` /
 * `rateLimitTried`）才做得到。
 */
class SseQuotaExhaustedError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SseQuotaExhaustedError'
    this.code = code
  }
}

/**
 * 把「距重置还有多久」格式化成中文短句。
 *
 * 用户需求（2026-10-02）：「其它渠道限额到了会提示多少时间后会解除限额，
 * 这个 codearts 的也加上吧」—— 其它渠道（buddy / workbuddy）由**服务端**
 * 在错误文案里给出重置时刻，故 `parseRateLimitError` 能解析；CodeArts 的
 * benefit 额度报文里**没有**任何时间字段（实测 `InferHub.4291.200` 的
 * `details` 只有 requestId / timestamps / modelId / traceId），因此按
 * **UTC+8 自然日**自行推算（见 {@link codeartsQuotaExhaustedMessage}）。
 *
 * @param resetAtMs - 解禁时刻（UTC 毫秒）。
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export function formatResetIn(resetAtMs: number, nowMs: number = Date.now()): string {
  const diff = resetAtMs - nowMs
  if (diff <= 0) return '即将重置'
  if (diff < 60_000) return '不到 1 分钟'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟`
  // 保留一位小数：额度按自然日结算，剩余时间通常在 1~24 小时之间，
  // 只报整数会让「还有 1 小时」与「还有 1.9 小时」看起来一样。
  return `${Math.round(diff / 360_000) / 10} 小时`
}

/**
 * 额度用尽时给用户看的完整说明（**含解禁时间**，这是用户明确要求的）。
 *
 * ## 为什么按「UTC+8 次日 00:00」推算
 *
 * CodeArts 的 benefit（免费额度）模型（`glm-5.3-flash` / `deepseek-v4.1-flash`）
 * 额度按**自然日**结算（IDE 模型卡标注「每日 1000 万免费 Tokens」），而
 * `InferHub.4291.200` 的报文里**不给重置时刻**。故与 `qoder` / `zcode` 的
 * 额度处理同款：复用 {@link nextUtc8DayStartMs} 取 UTC+8 当日 24:00，
 * **不能**复用 `parseRateLimitError`（它解析不到时间时退回「1 小时后」，
 * 对按日结算的额度会让标记过早失效，用户 1 小时后再撞一次同样的墙）。
 *
 * ⚠️ 措辞对「这是我们的推算」保持诚实：写「预计」，不谎称是服务端给的时间。
 *
 * @param model - 请求的模型 id（用户据此决定换哪个）。
 * @param resetAtMs - 推算出的解禁时刻。
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export function codeartsQuotaExhaustedMessage(
  model: string,
  resetAtMs: number,
  nowMs: number = Date.now(),
): string {
  const when = formatResetIn(resetAtMs, nowMs)
  return (
    `codearts: 模型 ${model} 的免费额度（benefit）已用尽，`
    + `预计 ${when}后重置（按 UTC+8 自然日结算，预计 ${new Date(resetAtMs).toISOString()}）。`
    + '可改用其它模型，或在 Jet Hub 的 CodeArts 面板切换/添加账号。'
  )
}

/** CodeArts 后端返回的一次排队状态响应。 */
export interface CodeArtsQueueStatus {
  readonly status: 'waiting' | 'working' | 'error' | 'queue_full'
  readonly queuePosition: number
  readonly message: string
}

/** 判断 HTTP 错误体是否表示 CodeArts 并发排队限流。 */
function isQueueError(status: number, body: string): boolean {
  return status === 400
    && (body.includes('TM.00001041')
      || /peak\s+usage|try\s+again\s+after|peak\s+hours/i.test(body)
      || /high\s+demand|too\s+many\s+requests/i.test(body))
}

/* ──────────────── 三个「非凭据问题」的业务码（2026-11-05） ──────────────── */

/**
 * 上游「网络繁忙」的业务码 —— 实测是**华为 WAF 按 `User-Agent` 首 product token
 * 拒发**（`^deepseek-harness/`），不是真的繁忙。
 *
 * 见 {@link CODEARTS_USER_AGENT} 的完整对照表。本判据存在的意义是**兜底**：
 * 我们已把 UA 覆盖成官方 IDE 的身份，但上游策略随时可能再变（或用户跑的是旧版），
 * 届时这条 403 会落到 `httpErrorCode` 的 `401/403 → AUTH` ⇒ 客户端把报文整条换成
 * 「API 密钥无效」⇒ 用户去重登/换 token，方向全错。
 */
const CODEARTS_GATEWAY_BUSY_CODE = 'TM.00000001'

/** 账号级并发上限的业务码（实测每账号同时最多 3 个请求）。 */
const CODEARTS_CONCURRENCY_LIMIT_CODE = 'TM.00001041'

/**
 * 「模型未在本租户开通」的业务码。
 *
 * ⚠️ **来源是 Gitee PR #175 评审里的一条实测记录**（`deepseek-v4-flash` 恒回该码），
 * 本仓库**没有**独立复现 —— 因此只做「归类 + 文案」，不与其它判断合并，
 * 也不据此推断任何账号/模型的能力。拿到本机报文后应在此登记。
 */
const CODEARTS_TENANT_NOT_ENABLED_CODE = 'TM.000010051'

/**
 * 错误体里是否带某个**精确**业务码（数字后缀必须断开）。
 *
 * ## ⚠️ 为什么不能用裸 `body.includes(code)`
 *
 * 本仓库已经踩过同型坑（{@link isSseQueueErrorCode} 的 `429` 命中 `InferHub.4291.200`）：
 * 业务码是**纯数字后缀**，`TM.00000001` 是 `TM.000000011` 的前缀。
 * 用裸子串匹配会把「另一个码」也吃进来，而这三条的处理方式各不相同
 *（一个不重试、一个等 1~2 分钟、一个换模型）。
 *
 * ⚠️ 大小写**敏感**：上游恒为大写 `TM.`，放宽只会扩大误判面。
 */
function hasBusinessCode(body: string, code: string): boolean {
  if (typeof body !== 'string' || body.length === 0) return false
  return new RegExp(`${code.replace(/\./g, '\\.')}(?![0-9])`).test(body)
}

/** 错误体是否为「网关按客户端标识拒发」（`TM.00000001`）。 */
export function isGatewayBusyError(body: string): boolean {
  return hasBusinessCode(body, CODEARTS_GATEWAY_BUSY_CODE)
}

/** 错误体是否为「账号级并发上限」（`TM.00001041`）。 */
export function isConcurrencyLimitError(body: string): boolean {
  return hasBusinessCode(body, CODEARTS_CONCURRENCY_LIMIT_CODE)
}

/** 错误体是否为「模型未在本租户开通」（`TM.000010051`，见常量注释的取证强度）。 */
export function isTenantNotEnabledError(body: string): boolean {
  return hasBusinessCode(body, CODEARTS_TENANT_NOT_ENABLED_CODE)
}

/**
 * 「网关按客户端标识拒发」给用户看的完整说明。
 *
 * ⚠️ 三条措辞不可省：
 * 1. **不是凭据问题**（否则用户去重登，白费一轮）；
 * 2. **重试无效**（同 UA 重试恒 403 —— 这是它与并发上限的**本质区别**；
 *    映射成 `RATE_LIMIT` 会让宿主白退避重试 5 次，每次都打上游一次 403）；
 * 3. **本插件已发官方 IDE UA**（告诉用户「这是上游策略、不是你没配好」，
 *    并给出可执行的下一步：升级插件 / 贴日志）。
 */
export function codeartsGatewayBusyMessage(model: string): string {
  return (
    `codearts: 上游网关拒绝了本客户端的标识（${CODEARTS_GATEWAY_BUSY_CODE}「网络繁忙」，`
    + '实测是华为 WAF 按 `User-Agent` 首 product token 拒发，不是真的繁忙）。'
    + '这不是凭据问题，重试也无效 —— 本插件已改为发送官方 CodeArts IDE 的 UA；'
    + `若你看到这句，说明上游策略又变了或插件版本过旧 ⇒ 请升级插件，`
    + `并把本句与 error_code（含 logid）一起反馈。（当前模型：${model}）`
  )
}

/**
 * 账号级并发上限给用户看的完整说明。
 *
 * ⚠️ 措辞必须交代三件事（缺一件用户就会走错方向）：不是密钥问题 / 上限是 3 /
 * 等一会儿会自己好（或换账号立即解除）。
 * ⚠️ 刻意**不写死秒数**：实测槽位释放是变长的（等 60s 恢复，但没有公开的确切时长）。
 */
export function codeartsConcurrencyLimitMessage(model: string): string {
  return (
    `codearts: 账号级并发上限已达（上游 ${CODEARTS_CONCURRENCY_LIMIT_CODE}，`
    + '实测每个账号同时最多 3 个请求）。'
    + '这不是凭据问题 —— 请等 1~2 分钟让上一个请求释放后重试，'
    + '或改用其它模型，也可在 Jet Hub 的 CodeArts 面板切换/添加账号（换账号立即解除）。'
    + `（当前模型：${model}）`
  )
}

/** 「模型未在本租户开通」给用户看的说明（出路是换模型/换账号，不是重试）。 */
export function codeartsTenantNotEnabledMessage(model: string): string {
  return (
    `codearts: 上游返回「模型未在本租户开通」（${CODEARTS_TENANT_NOT_ENABLED_CODE}）。`
    + '这不是凭据问题，重试无效 —— 请改用其它模型，'
    + `或换一个已开通该模型的账号。（当前模型：${model}）`
  )
}

/**
 * 判断 HTTP 错误是否表示凭据已失效、可通过 refresh_token 续期后重试。
 * CodeArts 经华为 APIG 网关鉴权：SecurityToken 过期/无效时网关返回
 * `APIG.0602`（"Invalid token"），HTTP 状态通常是 401，但也观察到 403。
 * 本适配器在入口已按 expires_at 预判过期，但 SecurityToken 可能被后端
 * 提前吊销、或本地时钟与签发端有偏差——此时首次请求会命中本错误。
 * 策略：触发一次静默 refresh，用新 AK/SK/SecurityToken 重试一次；仍失败
 * 才抛 AUTH，避免把可自愈的瞬时鉴权失败暴露给用户。
 */
function isAuthError(status: number, body: string): boolean {
  if (status === 401 || status === 403) {
    // ⚠️ 先排除「网关瞬时签名故障」（`body hash mismatch`），否则会白跑一次
    // 凭据续期：它与 AK/SK、security_token 都无关，重发就能过（见
    // {@link isTransientSignatureFailure} 的实测依据）。
    if (isTransientSignatureFailure(status, body)) return false
    // ⚠️ 同理排除「本机代理拒发改写请求」（bili，Gitee IKQ7AP）：它与凭据**无关**，
    // 刷新后压缩仍在、重签凭据仍缺 ⇒ bili 依旧拒发 ⇒ 白跑一次 STS 网络往返，
    // 然后落 AUTH 把唯一的指路文案吞掉。见 {@link isProxyResignRefusal} 的实测表。
    //
    // ⚠️ 这两条排除**不破坏**「401/403 先判、恒归认证类」的铁律：那条管的是
    // 「上游报文里的**额度/上下文措辞**不得抢在状态码之前改写分类」（网关故障常
    // 捎带余额词）；这里排除的是**非网关来源**的 401/403 —— 判据锚定的是
    // bili 独有的三个 marker，与 APIG 的报文形态零重叠。
    if (isProxyResignRefusal(status, body)) return false
    /**
     * ⚠️ 同理排除三个「**非凭据问题**」的业务码（2026-11-05，Gitee PR #175 的
     * 评审 + 本仓库 UA 修复的兜底）：
     *
     * - `TM.00000001` = 网关按客户端标识拒发（UA 门控，见 {@link CODEARTS_USER_AGENT}）；
     * - `TM.00001041` = 账号级并发上限（等 1~2 分钟或换号即好）；
     * - `TM.000010051` = 模型未在本租户开通（换模型/换账号）。
     *
     * 三者与 AK/SK/security_token **无关** ⇒ 刷新只会白跑一次真实 STS 网络往返
     *（CodeArts 的 `refresh_token` 是**一次性轮换**的，见
     * `tests/e2e/codearts-credential.ts` 的注释），然后落 `AUTH` 把上面三条
     * **唯一出路**的文案吞掉。判据只认**精确业务码**（{@link hasBusinessCode}），
     * 与 APIG 的报文形态零重叠 ⇒ 不破坏「401/403 先判」的铁律。
     */
    if (isGatewayBusyError(body) || isConcurrencyLimitError(body) || isTenantNotEnabledError(body)) return false
    return true
  }
  return body.includes('APIG.0602') || /invalid\s+token|token\s+expired|token\s+is\s+invalid/i.test(body)
}

/**
 * 判断 SSE 流内返回的 error_code 是否属于**可重试**的排队/限流错误。
 *
 * CodeArts 以 HTTP 200 + SSE 内嵌 `error_code` 返回这类错误（例如
 * `InferHub.ModelArts.81111.429` TPM 每分钟 token 超限），而不是 4xx——
 * 适配器把它们当成排队处理：延迟后重试整个 chat 请求，与 TM.00001041
 * 行为一致，避免"思考后无输出"。
 *
 * ## ⚠️ 判据必须锚定「429」这个**独立数字**，不能用裸子串（真实缺陷）
 *
 * 原实现写作 `/81111|TPM|429|rate.?limit|…/`，其中 `429` 是**无边界子串**匹配，
 * 于是额度耗尽码 `InferHub.4291.200` 里的 `4291` **命中了 `429` 前缀** ——
 * 被误判成「可重试的排队限流」，进入每 10 秒重试、上限 180 次（30 分钟）的
 * 静默重试循环。
 *
 * 实测（2026-10-02，用户在本机真实凭据上的会话）：
 * ```
 * isSseQueueErrorCode('InferHub.4291.200') === true    ← 误判
 * 匹配到的子串: "429"
 * ```
 * 后果是**界面完全无输出**：`stream()` 在排队期间刻意不产出任何内容块
 * （见下方排队循环的长注释），而它误以为自己"在排队"。实测真实适配器
 * 25 秒内发出 4 次 chat 请求 + 3 次排队探测、**产出 0 个 chunk**，最终由
 * 用户手动中止（会话记录里是 `turn/end aborted` + `stream: []`，**没有任何
 * error 事件** —— 因为错误根本没被抛出）。这正是用户报障的「CodeArts Agent
 * 没反应」。
 *
 * ⇒ 现在 `429` 用 `(^|[^0-9])429([^0-9]|$)` 锚定为独立数字：`…81111.429`（结尾）
 * 与 `429 Too Many Requests`（后接空格）仍命中，而 `4291` 不再命中。
 * 额度耗尽的 `4291` 由 {@link isSseQuotaExhaustedErrorCode} 单独识别。
 *
 * 导出仅供单测直接锁定「`429` 的边界」这一判据本身 —— 若只靠调用点的先后顺序
 * （额度判据排在排队判据之前）来兜住 `4291`，那么把边界改回裸子串时**任何**
 * 端到端用例都不会变红（实测确认过），边界就成了没人守的装饰。
 */
export function isSseQueueErrorCode(code: string): boolean {
  return code === 'TM.00001041'
    || /81111|TPM|(^|[^0-9])429([^0-9]|$)|rate.?limit|too many requests|排队|限流/i.test(code)
}

/**
 * 判断 SSE 流内返回的 error_code 是否表示**额度已用尽**（不可重试）。
 *
 * 实测报文（2026-10-02，真实凭据）：
 * ```
 * HTTP 200  data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota",
 *                 "details":[…requestId…timestamps…modelId: deepseek-v4.1-flash…traceId…]}
 * ```
 * 同账号的 `deepseek-v4-flash`（非 benefit 通道）仍正常出流 —— 故这是
 * 「该模型 + 该账号的免费额度用尽」，不是账号欠费（同期 `statistics/plugin`
 * 显示积分余额仍有 8499.84）。
 *
 * 与「排队/限流」是**本质不同**的两件事，绝不可合并（同 `qoder` 的
 * `10605` 排队 vs `110` 额度那次教训，见 `AGENTS.md`）：
 *
 * | | 排队/TPM 限流 | 额度用尽 |
 * |---|---|---|
 * | 语义 | **暂时**受阻，等一会儿就通 | **额度真的没了**，重试无意义 |
 * | 处理 | 内部等待后重试 | **立即失败**并如实告知 |
 *
 * 判据用**子串** `4291`（而非全等）是刻意的：该码由服务端下发，本地产物里
 * 没有硬编码（同 `qoder` 的 `110`），若上游改用 `InferHub.4291.xxx` 的其它
 * 尾号表达同一语义，只认全等会漏判。`4291` 与排队族的 `81111` / 独立的
 * `429` 均不冲突。
 *
 * 文案兜底（`insufficient quota`）不可省：万一上游换了码值，序列化后的
 * detail 文本仍能命中 —— 与 `zcode` / `qoder` 的既有做法一致。
 */
export function isSseQuotaExhaustedErrorCode(code: string, message: string): boolean {
  return code.includes('4291') || /insufficient[\s_-]+quota/i.test(message)
}

/**
 * HTTP **4xx** 报文里是否表示「该账号没有 benefit（免费额度）包」。
 *
 * ## 为什么需要它（Gitee issue IKLBSH A6）
 *
 * 同一个上游条件走**两条**通道下发：
 *
 * | 通道 | 形态 | 修复前 |
 * |---|---|---|
 * | SSE | HTTP 200 + `{error_code:"InferHub.4004.200", …}` | ✅ 已接（`consumeSse` 抛 `BENEFIT_NOT_FOUND_CODE`）|
 * | HTTP | **4xx** + 同一码 | ❌ **未接** ⇒ 去头重试一次也不试，直接归 `INVALID_REQUEST` 抛出 |
 *
 * 「SSE 能自愈、4xx 却硬报错」＝同一个语义两套判据，正是本仓库首条红线的形态。
 *
 * ⚠️ **该缺陷已被独立锁定**：`origin/issue/IKJOF7-benefit-diagnostics` 分支
 *（2026-10-05）用 `it.fails` 显式锁死了它（「HTTP 4xx + 正文含
 * `InferHub.4004.200` 时也应当去头重试」），当时结论是「已确认，但本分支不修」。
 *
 * ⚠️ **判据复用同一个码值常量**（`CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE`），
 * 不另写第二份 —— 与 SSE 通道的判据（`consumeSse` 的 `===` 比较）**同源**，
 * 否则两条通道会在上游改码时分别漂移（这正是本缺陷的成因形态）。
 *
 * ⚠️ 与 {@link isSseQuotaExhaustedErrorCode} 的 `4291` **刻意不同**：那条腿用
 * 子串是为了容忍 `InferHub.4291.xxx` 的其它尾号，而 `4004` 这一族里
 * **没有证据**表明其它尾号是同一语义（`4004.200` 是实测唯一的 benefit 码）。
 * 按证据收紧到**全等**：放宽成 `InferHub.4004.` 前缀会把该族里未知语义的
 * 报文也变成可重试，属行为变更。将来真抓到别的尾号**再按实测放宽**。
 *
 * ⚠️ 不解析 JSON 而直接判原文：4xx 的报文形态与 SSE 不同（字段名可能不叫
 * `error_code`），这正是上面那条注释记录的教训。
 */
export function isBenefitNotFoundBody(body: string): boolean {
  return body.includes(CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE)
}

/**
 * 错误体是否是「该模型只按 benefit 通道注册」（`InferHub.002002009.404`）。
 *
 * 与 {@link isBenefitNotFoundBody} 互为镜像：一个说「该带头却没带」，
 * 一个说「不该带却带了」。判据同样按**实测全等**，不放松成前缀。
 */
export function isModelNotRegisteredBody(body: string): boolean {
  /**
   * ⚠️⚠️ **优先按 JSON 的 `error_code` 全等判，裸子串只作兜底**（2026-10-27 审计修）。
   *
   * 修前是裸 `body.includes('InferHub.002002009.404')` —— 对抗审计构造了一个
   * **与「未注册」完全无关**的 400：正文是
   * `invalid tool call arguments: {"q":"InferHub.002002009.404"}`（用户内容被回显）
   * ⇒ 也命中 ⇒ 多打一次上游，还把 `maas_type` 送给一个非 benefit 模型。
   *
   * 而 SSE 通道那条用的是 `data.error_code === '…'` **全等**判据 ——
   * 所以 PR 注释里「两条通道同源同判据」是**不实**的（现在按全等优先，才真的同源）。
   *
   * ⚠️ 兜底保留裸子串的理由：4xx 的报文形态与 SSE 不同（字段名可能不叫
   * `error_code`），本函数上方注释记载过这条教训（`isBenefitNotFoundBody` 同型）。
   * 兜底只在「解析不出结构化 error_code」时才走。
   */
  const trimmed = body.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const code = typeof parsed === 'object' && parsed !== null
        ? (parsed as { error_code?: unknown; errorCode?: unknown }).error_code
          ?? (parsed as { errorCode?: unknown }).errorCode
        : undefined
      if (typeof code === 'string') {
        // 结构化字段存在 ⇒ 只认全等，不再看正文（避免把回显内容当信号）。
        return code === CODEARTS_MODEL_NOT_REGISTERED_ERROR_CODE
      }
    } catch {
      // 不是合法 JSON ⇒ 走下面的兜底
    }
  }
  return body.includes(CODEARTS_MODEL_NOT_REGISTERED_ERROR_CODE)
}

/**
 * 从错误体提取可分类的 detail 文本（OpenAI 风格 error 或 CodeArts error_code/error_msg）。
 *
 * ⚠️ **本次只「加腿」，且如实标注证据强度**：新增顶层字符串 `error` 一条。
 *
 * 该项的**证据是「同族实现已修」+「形态确实无法解析」，不是 codearts 的线上实录**
 * （141 个真实会话里没有 codearts 的 `{"error":"<字符串>"}` 报文）——
 * `src/openai-compat.ts` 的**同名函数**早已修过这个形态，其注释写明
 * 「只认 code/message/msg 会把整个 JSON 原样返回，用户看到一坨不可读的裸 JSON」，
 * 而本文件的这份没跟上（「一文件两套同义判据」是本仓库点名的复发形态，
 * 两处改一处时**必须同时改另一处**）。
 *
 * 之所以加：该形态在本份实现里**必然**退化成整段裸 JSON（`parts` 为空 ⇒
 * `return body`），而修法是把另一份已被验证的腿搬过来，零新增取舍 ——
 * 与 `httpErrorCode` 那次「调整判据优先级」不同，这里**不改变任何已有分类**，
 * 纯属补齐漏掉的形态（codearts 的 `errorDetail` 与 OpenAI 兼容报文同源）。
 *
 * ⚠️ **绝不「减腿」**：原有的 `error.code` / `error.type` / `error.message` /
 * `error_code`+`error_msg` / 顶层 `message` 五条**必须全部保留** ——
 * OpenAI 形态常把额度语义写在 `{"error":{"code":"insufficient_quota"}}` 里，
 * 少了 code 那条腿，该报文会从额度**掉回** `AUTH`/`INVALID_REQUEST`
 * （实测：`isQuotaExceededError` 对 `insufficient_quota` 为 true，
 * 但只有在它被拼进 detail 时才生效）。改的第一版真的把几条腿一起删了。
 *
 * ⚠️ **导出仅供单测直接锁定「形态覆盖」这一判据本身**（与
 * {@link isSseQueueErrorCode} / {@link isSseQuotaExhaustedErrorCode} 同款惯例）。
 * **不要**绕道「分类结果」去测它：`{"error":"insufficient balance"}` 这种报文，
 * 即使字符串腿失效、函数退回整段 JSON，**整段 JSON 里也含该短语** ⇒
 * 额度判据照样命中 ⇒ 那是**假守卫**（实测确认过，第一版就是这么错的）。
 * 直接断言本函数的**返回值**才测得到那条腿。
 *
 * ## ⚠️⚠️ 本函数是**展示**出口；分类出口是 {@link errorDetailForClassify}
 *
 * 无条件把 `detail` 计入产物会**翻转错误码**（真实净回归，两轮审计独立确证）：
 *
 * | 报文 | 只算既有腿 | 加上 detail 腿 |
 * |---|---|---|
 * | `{"message":"bad request","detail":"insufficient quota"}` | `INVALID_REQUEST` | **`QUOTA_EXCEEDED`** |
 * | `{"message":"bad request","detail":"prompt is too long for this model"}` | `INVALID_REQUEST` | **`CONTEXT_WINDOW_EXCEEDED`** |
 *
 * 后者还会**触发 DSH 的上下文溢出压缩**。本函数是 `httpErrorCode` 与 4xx 额度判据
 * 的**唯一分类输入** ⇒ 那两处**必须**改走 {@link errorDetailForClassify}，
 * 否则一个纯展示改进会静默改变分类行为（且我加的用例只断言返回值，零分类守卫）。
 *
 * ⚠️ **本份（codearts）与 `openai-compat.ts` 那份是同名不同实现**，
 * 两条出口的语义必须两处一致。
 */
export function errorDetail(body: string): string {
  return errorDetailImpl(body, true)
}

/**
 * 从错误体提取**分类用**的可读文本 —— **不含**顶层 `detail` 字段。
 *
 * ⚠️ 分类调用点（`httpErrorCode` / `isSseQuotaExhaustedErrorCode`）**必须**走本出口：
 * 它保证分类输入与「加 detail 腿之前」**逐字节相同**（见 {@link errorDetail} 的实测表）。
 */
export function errorDetailForClassify(body: string): string {
  return errorDetailImpl(body, false)
}

/**
 * `errorDetail` 的唯一实现（两条出口共用，**不各写一份** —— 那是本仓库首条红线
 * 「同一语义两套判据」，且必然漂移）。
 *
 * @param includeDetailField - `true` = 展示出口；`false` = 分类出口。
 */
function errorDetailImpl(body: string, includeDetailField: boolean): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const error = typeof data.error === 'object' && data.error !== null
      ? data.error as Record<string, unknown>
      : undefined
    // 顶层 `error` 是**字符串**的形态（`openai-compat` 那份已覆盖，本份原先漏掉）。
    const errorText = typeof data.error === 'string' ? data.error : undefined
    const parts = [
      typeof error?.code === 'string' ? error.code : undefined,
      typeof error?.type === 'string' ? error.type : undefined,
      typeof error?.message === 'string' ? error.message : undefined,
      errorText,
      typeof data.error_code === 'string' ? data.error_code : undefined,
      typeof data.error_msg === 'string' ? data.error_msg : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      // ⚠️ 上游代理的 `{"error":"acp-proxy failure","detail":"<真实原因>"}` 形态
      //（Gitee issue IKLBSH A1）—— 只认 `error` 会丢掉真正的原因。
      // 判据**只留一份实现**（`openai-compat.ts` 的 `detailFieldText`）；本仓库
      // 6 份同义 `errorDetail` 各写一条必然漂移（「同一语义两套判据」）。
      // ⚠️ **只在展示出口计入**（见上）。
      includeDetailField ? detailFieldText(data) : undefined,
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体：直接用原文分类。
  }
  return body
}

/**
 * 将 CodeArts 错误响应归一化为 harness 错误码，与 deepseek 适配器的
 * httpErrorCode 词汇一致：400 且命中上下文超限措辞时归为
 * CONTEXT_WINDOW_EXCEEDED（触发 dsh compaction 自动压缩上下文），
 * 而不是不可重试的 HTTP_400，避免长会话在接近窗口上限时直接中断。
 *
 * ⚠️ **额度判据不得抢到 401/403 之前**（曾被审计建议改成这样，**已否决**）：
 * 「同一文案用 400 归额度、用 403 归 `AUTH`」看起来不一致，但那正是**有意**的 ——
 * codearts 的 401/403 来自**网关**（APIG.0602 Invalid token / APIG.0301 验签失败），
 * 而本仓库有一条**成文铁律**（`AGENTS.md` 的「同族判据必须逐格同构」）：
 * > **401/403 先判**，恒归认证类 —— 状态码与额度文案并存时
 * > （网关侧故障常在报文里捎带余额提示）**以状态码为准**
 *
 * 该铁律是 2026-10-06 raccoon / loomy「一个请求内 6 个号各被封 24h」事故的产物。
 * 把额度判据提到前面，就等于让网关故障时捎带的余额词**改写分类** ⇒
 * 真凭据失效被说成「额度用尽」，用户被引向「等额度恢复」而不是重新登录。
 *
 * ⚠️ 而且「codearts 会用 401/403 下发额度文案」这一前提**没有实测支撑**：
 * 141 个真实会话里 `InferHub.4291` 仅 1 次命中（还是在讨论参考实现的 Rust 源码），
 * 无任何真实 401/403 + 额度文案的记录。**将来若真抓到该报文，再按实测处理** ——
 * 不要据构造的报文改分类顺序。
 */
function httpErrorCode(status: number, body: string): string {
  // ⚠️ bili 拒发改写请求：**非网关来源**的 401/403，必须在 AUTH 短路**之前**单列
  //（Gitee IKQ7AP）。判据锚定 bili 独有 marker，与 APIG 形态零重叠（见
  // {@link isProxyResignRefusal}）—— 它不破坏「401/403 先判」的铁律，理由见
  // {@link isAuthError} 内的同款注释。
  //
  // ⚠️ **码绝不能取 `AUTH`**（IKLBSH 同族）：`AUTH` 会被客户端整条替换成
  // 「API 密钥无效」，而这条错误的 message **本身就是出路**（告诉用户怎么让
  // bili 拿到重签凭据）⇒ 取 AUTH 等于把唯一的指路句子吞掉。实测修复前 message
  // 只剩 `model request failed with HTTP 403`，`bili_resign_unavailable` 完全丢失。
  if (isProxyResignRefusal(status, body)) return PROXY_REFUSED_SIGNED_CODE
  if (status === 401 || status === 403) return 'AUTH'
  // ⚠️ **分类必须走 `errorDetailForClassify`**（不含 detail 腿）—— 用展示出口会让
  // detail 里的额度/超限措辞**翻转错误码**（实测表见 `errorDetail` 的 doc）。
  const detail = errorDetailForClassify(body)
  if (isQuotaExceededError(detail)) return CODEARTS_QUOTA_EXHAUSTED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * 华为 API 网关（APIG）**瞬时**签名故障的判据。
 *
 * 报文形态（用户报障 2026-10-03 的会话日志原文）：
 * `401 APIG.0301 Incorrect IAM authentication information: calc ak sk
 *  signature fail:body hash mismatch x-sdk-content-sha256 header`
 *
 * 为什么必须单独判它：这句说的是「网关收到的正文哈希 ≠ 我方
 * `x-sdk-content-sha256` 头」，**与 AK/SK、security_token 都无关**。
 * 本模块的签名实现（`sign.ts`）用**同一份字节**算哈希与发请求
 * （`signRequestHuawei(…, new TextEncoder().encode(body), …)` 的入参与
 * 传给 `fetch` 的 `body` 是同一个字符串）⇒ 本方不存在能把两者算岔的路径。
 * ⚠️ 这一点是**读码推导**，不是逐请求实测：仓库里没有对应的探针脚本。
 * 2026-10-19 审计已复核该不变量本身成立（空串 / 中文 / emoji /
 * 20 万字符 / 组合字符 5 组样本的 `sha256(body)` 与头恒等），但当时引用的
 * 「已用探针逐请求核对过」在本仓库**不存在** —— 按证据强度如实标注。
 *
 * 处置：直接重发（见 `SIGNATURE_RETRY_MAX`），**不要**刷新凭据 ——
 * 凭据与此故障无关，刷新只是白跑一次网络往返；
 * 也就不能让它落入 {@link isAuthError} 的「静默 refresh + 重发」分支。
 *
 * ⚠️ 判据刻意只认 `body hash mismatch`：`APIG.0301` 的另一半
 * （`verify ak sk signature fail`）**同时覆盖真实的 AK/SK 错误**
 * （`AGENTS.md` 记录了把 `Agent-Type` 误当签名头传入也会得到它），
 * 按它放宽会把真凭据问题误判成瞬时故障、让用户永远等不到「请重新登录」。
 */
export function isTransientSignatureFailure(status: number, body: string): boolean {
  if (status !== 401 && status !== 403) return false
  return typeof body === 'string' && /body hash mismatch/i.test(body)
}

/**
 * 本机上下文压缩代理（bili / billion-context）按 **compress-or-refuse contract**
 * 拒发**被改写过**的签名请求。
 *
 * 报文形态（真实会话 `session-016866dc` turn 7，逐字，Gitee IKQ7AP）：
 * ```json
 * {"error":{"type":"signed_request_requires_resign","code":"bili_resign_unavailable",
 *  "message":"bili refused to forward this sdk-hmac-sha256 …-signed request:
 *  the signature covers the request body, and any rewrite (context compression)
 *  would invalidate it upstream … No re-sign credential was available for this scheme.",
 *  "type":"session_dead"}}
 * ```
 *
 * ## ⚠️⚠️ 它为什么**绝不能**落进 {@link isAuthError}（真实缺陷，2026-10-25 实测复现）
 *
 * 三条根因链逐行成立（行号以 `9f76d46` 为准）：
 *
 * 1. {@link isTransientSignatureFailure} 只认 `body hash mismatch`（APIG 网关侧
 *    瞬时故障）—— bili 的三个 marker 不命中；
 * 2. {@link isAuthError} 对 401/403 恒真 ⇒ 进入「静默 refresh 一次再重试」分支；
 * 3. 重试时**压缩仍在、重签凭据仍缺** ⇒ bili 依旧拒发 ⇒ `httpErrorCode` 的
 *    第一条把 403 归成 `AUTH`。
 *
 * 实测四格（真实 `CodeArtsAdapter` + 逐字报文）：
 *
 * | 观测 | 修复前 | 修复后 |
 * |---|---|---|
 * | 错误码 | `AUTH` | `PROXY_REFUSED_SIGNED` |
 * | `refresh()` 调用 | **1 次**（白跑一次 STS 网络往返） | **0 次** |
 * | message | `codearts: model request failed with HTTP 403`（**一句话**） | 保留 bili 原文与可执行出路 |
 * | `bili_resign_unavailable` 可搜 | **否** | **是** |
 *
 * ## 语义与 {@link isTransientSignatureFailure} 的**关键区别**
 *
 * | | APIG `body hash mismatch` | bili 拒发 |
 * |---|---|---|
 * | 成因 | 网关侧一次性故障 | 代理**有意拒绝**（契约行为） |
 * | 重发 | **有效**（实测重发即过） | **无效**（压缩仍在、凭据仍缺，必然再撞） |
 * | 出路 | 等一下再试 | 用户/宿主侧补重签凭据，或临时放行 |
 *
 * ⇒ 这条**不是**「重发即可」，是「重发不可，需用户/宿主侧补凭据」——
 * 与凭据无关：刷新、重试、换号都**不会好**（换号只会让**下一个账号**的凭据
 * 同样到不了 bili 手里）。
 *
 * ## ⚠️ 判据刻意只认 bili 的三个 marker
 *
 * `APIG.0301` 的另一半（`verify ak sk signature fail`）**同时覆盖真实的 AK/SK
 * 错误**（见 {@link isTransientSignatureFailure} 的注释），**绝不**把 `APIG.0301`
 * 或 `SignatureDoesNotMatch` 加进本判据 —— bili 的 `message` 里**恰好引用了**那
 * 两个词（描述它为什么拒发），按它们放宽会让真凭据问题误判成代理拒发。
 * 只认 `signed_request_requires_resign` / `bili_resign_unavailable` /
 * `bili refused to forward` 三个 **bili 独有**的串。
 *
 * @param status - HTTP 状态码；bili 实测回 **403**（issue 原报文），401 一并接
 *   （代理版本差异时可能换码，同属「拒发」语义）。
 * @param body - 响应体（可能为空串）。
 */
export function isProxyResignRefusal(status: number, body: string): boolean {
  if (status !== 401 && status !== 403) return false
  return typeof body === 'string'
    && /signed_request_requires_resign|bili_resign_unavailable|bili refused to forward/i.test(body)
}

/** {@link isProxyResignRefusal} 命中时的错误码。 */
export const PROXY_REFUSED_SIGNED_CODE = 'PROXY_REFUSED_SIGNED'

/**
 * 构造 bili 拒发时的错误文案。
 *
 * ## 文案必须回答用户的三个问题（与 `reasoningLoopFailure` 同一条纪律）
 *
 * 1. **真实原因**：是本机代理拒发，不是凭据失效 —— 并**显式否认**「重新登录」；
 * 2. **为什么**：签名覆盖正文、压缩改写了正文、代理拿不到重签凭据（三句因果链）；
 * 3. **可执行的下一步**（issue 的建议修法 C，逐条保留）：让 bili 能重签（两法），
 *    或临时放行。
 *
 * ⚠️ **必须保留 `bili_resign_unavailable` 字样**（issue 验收标准第 5 条）：
 * 它是用户可搜索、文档可指路的锚点；`AUTH` 之所以是错误的码，正因为它会把
 * 整条 message 替换成「API 密钥无效」（IKLBSH 同族）。
 *
 * ⚠️ 文案里**不得**出现 Markdown 强调符：错误 message 是纯文本渲染。
 *
 * @param body - 响应体原文（把 bili 的解释拼进文案，保住可诊断性）。
 */
export function proxyResignRefusalFailure(body: string): { message: string; code: string } {
  const detail = body.trim().length > 0 ? body.trim().slice(0, 600) : '(响应体为空)'
  return {
    message:
      '本机上下文压缩代理（bili）拒发了这条签名请求：请求体被压缩改写，而签名覆盖正文，'
      + '代理拿不到重签凭据（bili_resign_unavailable）。凭据本身有效，重新登录无用。'
      + '修法二选一：① 让 bili 能重签 —— 在 Jet Hub 保证存在一个 codearts 账号'
      + '（enabled 且凭据可解析出 access_key_id / secret_access_key），'
      + '或用 BILI_CODEARTS_REF / resign["sdk-hmac-sha256"].credentialRef 钉一个；'
      + `② 临时放行 —— BILI_RESIGN_PASSTHROUGH=1（该 scheme 逐字节直穿、不压缩）。上游：${detail}`,
    code: PROXY_REFUSED_SIGNED_CODE,
  }
}

/** 可中止的休眠；当信号中止时立即 resolve。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 安全读取 Error.message，避免访问器抛异常。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/**
 * 在空闲超时内读取一个流块（实现见 {@link readWithIdleTimeout}）。
 * 此处用 codearts 标签包一层，保持错误消息前缀与历史行为一致。
 */
function readCodeArtsChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal,
  phase: 'first-token' | 'chunk' = 'chunk',
): Promise<{ done: boolean; value: Uint8Array | undefined }> {
  return readWithIdleTimeout(reader, timeoutMs, 'codearts', signal, phase)
}

/**
 * DSML 工具调用格式提取器。
 *
 * 某些模型（如 deepseek-v4）在未通过 `tools` 字段告知工具模式、或工具
 * 模式与模型训练格式不匹配时，会把工具调用以原生 DSML XML 风格直接写入
 * `delta.content`，形如：
 *   `<｜DSML｜tool_calls><｜DSML｜invoke name="bash">
 *    <｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>
 *    </｜DSML｜invoke></｜DSML｜tool_calls>`
 * 适配器若原样作为 text-delta 输出，原始 token 会泄漏到 web UI（表现为
 * "dump 出奇怪的一段内容后终止"）。本提取器以流式状态机从 content 增量
 * 中识别完整 DSML 块并解析为结构化 tool-call；非 DSML 文本原样放行，
 * 保持流式输出不阻塞。
 *
 * 同时支持 DeepSeek-V4 Thinking 模式：模型在工具调用前会把推理过程包裹
 * 在 `<thought>...</thought>` 标记中写入 `delta.content`。本提取器把
 * `<thought>` 内容作为 reasoning 增量流式输出（与 `delta.reasoning_content`
 * 行为一致，显示在 web 的 Think 区域而非正文），避免推理文本泄漏到用户
 * 可见区域。参考 DSML 官方介绍：
 * https://blog.csdn.net/gitblog_00855/article/details/152146045
 *
 * 设计要点：
 * - 增量友好：content 可能跨多个 SSE chunk 分片到达，提取器维护内部
 *   缓冲区与多模式状态机（normal / in-thought / in-dsml），仅对已完成
 *   的 DSML 块产出 tool-call；reasoning 增量流式输出；未完成部分保留
 *   到下次 feed；非 DSML/thought 文本立即 flush，避免延迟。
 * - 容错：若缓冲区包含开标签前缀但长时间未闭合，且后续内容不像该标签
 *   （例如只是普通文本里碰巧出现该前缀），在 flush 时把残留作为纯文本
 *   输出，避免吞掉用户可见内容。
 * - 边界：DSML 标签使用全角 `｜`（U+FF5C）而非半角 `|`，与模型实际
 *   输出一致。`<thought>` 为半角普通 XML 标签，与 DSML 官方文档一致。
 */

/** 兼容 OpenAI 格式的 CodeArts 模型适配器，使用华为请求签名。 */
export class CodeArtsAdapter extends LlmAdapter {
  /**
   * 声明宿主级重试策略（issue #21）。
   *
   * CodeArts 的失败面里 `TRANSPORT` / `TIMEOUT` / `EMPTY_RESPONSE` / `SERVER`
   * 都是**瞬态**（网关抖动、长上下文偶发空响应），交给宿主按指数退避重试，
   * 而不是把一次抖动直接抛给用户（长任务被迫手动重跑）。
   *
   * ⚠️ **必须显式保留 `RATE_LIMIT`**：不声明策略时宿主 fallback 的默认集合
   * 含它（TPM/并发 429 是瞬态，退避后大概率可过）；一旦声明就**替换**默认集，
   * 漏掉它会让 429 从「重试 5 次」变成「立即失败」——这是无意的收窄。
   *
   * ⚠️ 不动 `AUTH` / `QUOTA` / `INVALID_REQUEST`：这些重试只会白烧账号。
   * ⚠️ 只对自己这一路 provider 生效；未注册的 provider 返回 undefined。
   */
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    if (provider !== PROVIDER) return undefined
    // `satisfies` 让编译器按宿主契约逐字段校验（比 `as` 强），
    // 同时把数组也冻上（浅 freeze 只冻外层，调用方仍可 push）。
    return Object.freeze({
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: Object.freeze([
        'TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE', 'SERVER', 'RATE_LIMIT',
      ]),
      initialDelayMs: 2_000,
      maxDelayMs: 10_000,
      jitterRatio: 0.25,
    }) satisfies ResolvedRetryPolicy
  }

  private readonly fetchImpl: typeof fetch
  private readonly chatId: string
  private readonly sessionId: string
  /**
   * ⚠️ **2026-10-08 Task 7b：三个方法收敛到共享骨架** `createModelCatalog`。
   * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架，
   * 现在只剩 `toCatalogEntry`（本家私有形状 + VL 过滤 + 静态 context 表）。
   */
  private readonly catalog: ModelCatalog

  constructor(private readonly options: CodeArtsAdapterOptions) {
    super()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.chatId = options.chatId ?? crypto.randomUUID().replace(/-/g, '')
    this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, '')
    // 目录落地后通知客户端重读（issue IKJVTF 的缺陷①）。
    this.catalogGate = new RemoteCatalogGate(
      options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded },
    )
    // ⚠️ 共享骨架（Task 7b）：门控 → 读目录 → 黑名单 → 回填 → 三态。
    this.catalog = createModelCatalog(
      { accountPool: options.accountPool },
      {
        product: { id: PROVIDER },
        loadCatalog: () => this.catalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
        // ⚠️ 未知 id 的模态：**VL 模型例外**（2026-10-21 接图片时发现）。
        //
        // 历史：这里原写死 `['text']`，理由是「本家是纯文本网关、VL 模型已被滤掉」。
        // 该理由**只对目录内条目成立** —— VL 模型被 `catalogEntries()` 滤掉后，
        // `resolveModel('kimi-k2.6-vl')` 走的是**未知 id 分支**（`entry === undefined`），
        // 于是拿到这里的 `['text']`，而 `toCatalogEntry` 里算出的 `['text','image']`
        // **根本轮不到**（那条只在目录命中时生效）。
        // ⇒ 症状：VL 模型声明不了 image ⇒ DSH 在**入库阶段**就拒图（真缺陷，
        //    由 `codearts-image-input.spec.ts` 的守卫 ① 当场抓住）。
        // ⇒ 修法：按 id 判能力（`codeartsAcceptsImage`），其余仍恒 `['text']`。
        //
        // ⚠️ 这也解释了为什么**不能**把 VL 模型放进目录来解决：那会改变「选择器里
        //    能选到什么」（用户可见行为），而本次只需要「识图工具能按 id 借它」。
        unknownModelInputModalities: (modelId) => codeartsAcceptsImage(modelId)
          ? ['text', 'image'] as const
          : ['text'] as const,
        // ⚠️ **未知模型也声明思考档位**（7b 曾在此引入回归、7d 补回）：
        // 本网关唯一生效的思考控制是顶层 `thinking.type`，与模型无关 ⇒
        // 原实现对未知 id 同样给这两档。
        // ⚠️ 顺序规则见 `CODEARTS_REASONING_EFFORTS` 的长注释（**强度序：弱 → 强**）。
        // 未知模型与已知模型必须同一份顺序，否则用户手填 id 时档位轴会翻向。
        unknownModelReasoning: () => ({
          efforts: [...CODEARTS_REASONING_EFFORTS],
          defaultEffort: ReasoningEffortId(CODEARTS_DEFAULT_EFFORT),
        }),
        /**
         * ⚠️ **未知 id 也给窗口**（用户手填模型 id 时否则永远没有上下文占用条）。
         *
         * 与 `unknownModelInputModalities` / `unknownModelReasoning` **同一形态**：
         * 本家这两项都与「具体模型」无关（纯文本网关 / 顶层 `thinking.type`），
         * 窗口这一项在本家同样有本地兜底可用（目录窗口本就全来自静态表）。
         *
         * ⚠️⚠️ **必须走 `codeartsContextWindow(modelId)`，不能直接返回常数兜底**
         *    （2026-10-21 全量测试实测踩到）：`glm-5.3` 在静态窗口表里是 1M，
         *    但**不在静态兜底目录**（`DEFAULT_MODELS`）里 ⇒ 远端失败时它算
         *    「目录外 id」⇒ 直接返回常数会让它拿到 524_288（**分母错 2 倍**），
         *    而它**正是用户报障的那个模型**。
         *
         * ⚠️ **不要推广到别家**：多数家的窗口来自远端该模型的配置，对未知 id
         *    编一个就是**假窗口**（分母错 ⇒ 占用比与压缩阈值一起错）。
         *    取值理由见 `CODEARTS_FALLBACK_CONTEXT_WINDOW` 的长注释。
         *
         * ⚠️ 2026-10-29 修订（AgentCenter 接入）：取值顺序改为「动态值优先、
         *    静态表兜底」—— 此前「目录窗口全来自静态表」已过期；AgentCenter
         *    与 IDE 内核权威逐值一致（GLM-5.2 现值 202752），静态表有三次漂移史
         *    （见 `CONTEXT_WINDOWS` 的 GLM-5.2 行）；远端失败/无该 id 时仍回静态表。
         */
        unknownModelContextWindow: (modelId) =>
          this.remoteContextWindowOf(modelId) ?? codeartsContextWindow(modelId),
        /**
         * ★ **强制重拉**（供后台 20 分钟刷新器与「用户改设置」）。
         *
         * ⚠️ 与 `loadCatalog` 的差别：后者内部有 `isCatalogFreshFor` 判据
         *    ⇒ 新鲜时**不拉**。本回调要的是「无视新鲜度，强制拉一次」，
         *    故先清 `catalogAt` 再调**同一个** `ensureRemoteModels()` ——
         *    **不另写一份拉取逻辑**（那会让两条路的上游行为分叉）。
         *    ⚠️ `ensureRemoteModels` 的入口就是 TTL gate ⇒ 清掉 `catalogAt`
         *    正是让它失效的承重动作（与 loomy / zcode 等家同型）。
         */
        refresh: async () => {
          this.catalogAt = 0
          await this.ensureRemoteModels()
        },
      },
    )
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 与 BuddyAdapter 同款防御：DSH 校验 `info.id === provider`，且模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部 `provider.toUpperCase()`）。
   * 入参异常时回退到 PROVIDER 常量，避免客户端抛
   * `undefined.toUpperCase is not a function`。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : PROVIDER
    return { id, name: 'CodeArts Agent' }
  }

  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  private remoteModels: RemoteModel[] | undefined

  /**
   * AgentCenter 动态窗口表（**独立于目录可见性**）。
   *
   * ⚠️⚠️ **为什么必须与目录解耦**（2026-10-30 四路审计 P3 D6 定案）：
   * `src/model-catalog.ts` 的 `unknownModelContextWindow` 调用点**只在
   * `entry === undefined`（模型不在目录里）时**才走；而旧实现查的是
   * `this.remoteModels` —— 可 `catalogEntries()` 正是由 `this.remoteModels`
   * 映射而来 ⇒ **「在 remoteModels 里」⟺「在目录里」** ⇒ 动态腿在
   * 「手填模型 id」场景**基本不可达**（实测唯一例外是 VL 模型，而 VL 走
   * `analyzeImage` 那条路**根本不需要窗口** ⇒ 实际收益 ≈ 0）。
   *
   * ⇒ 这张表只装「AgentCenter 下发的窗口」，**与目录可见性无关**：
   * 任何 id 只要 AgentCenter 给过窗口，就能查到正确分母。
   *
   * ⚠️ 键用**原始 id**（不做 `normalizeModelId` 归一）—— 与
   * `src/models.ts` 的 `seen` 键口径一致（归一会把 `deepseek-v4.1-flash` 与
   * `deepseek-v4.1-flash-1017` 并成一条，那是**两个不同模型**）。
   */
  private remoteContextWindows = new Map<string, number>()

  /**
   * 「只作窗口源」的模型 id 集合（**独立于目录**）。
   *
   * ⚠️⚠️ **必须是独立集合，不能只看条目的 `windowOnly` 属性**
   * （2026-10-30 第二轮审计 P1 N-1 修）：原先只看属性 ⇒ **只在「远端拉取
   * 成功」时生效** ⇒ 冷缓存（首启 / 远端失败 / 上游抖动）走 `DEFAULT_MODELS`
   * 兜底 ⇒ 那些条目**没有** `windowOnly` 属性 ⇒ `kimi-k3` 以**裸名**进目录
   * ⇒ `priceFactorFromName('kimi-k3')` = `Infinity` ⇒ 聚合里 codearts 恒排
   * 最后 ⇒ 第一轮 P1-2 的症状**原样复发**（实测）。
   *
   * ⇒ 这里在**远端拉到窗口源条目时**记下它们的 id ⇒ 之后**冷缓存也记得**
   * ⇒ 两条路径口径一致。
   */
  private windowOnlyIds = new Set<string>()

  /**
   * AgentCenter 动态窗口优先查（2026-10-29 接入；2026-10-30 改为查独立表）。
   *
   * ⚠️ 查**表**（O(1)）而不是扫数组：旧实现是线性 `find`，且因与目录耦合
   * 而基本走不到；改成表之后它才真的会被调用（手填 id 场景）。
   */
  private remoteContextWindowOf(modelId: string): number | undefined {
    const w = this.remoteContextWindows.get(modelId)
    return typeof w === 'number' && w > 0 && Number.isFinite(w) ? w : undefined
  }

  /**
   * 已落缓存的目录是否**所有来源都取全**（issue IKJVTF，审计 I3）。
   *
   * ⚠️ **这是短路判据的第二半**：CodeArts 有两个目录端点，残缺目录也落
   * `remoteModels`，故只判「已定义」会让残缺永久固化（见 `ensureRemoteModels`）。
   */
  private remoteComplete = false

  /**
   * ⚠️ 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
   *
   * ⚠️ 与 `remoteModels` **并存**、不是替代：`remoteModels` 存「有哪些模型」，
   *    本字段存「何时读到的」。只有 `remoteModels` 时目录**永不刷新**（原行为）。
   */
  private catalogAt = 0

  /**
   * 目录加载闸门：并发去重 + 失败冷却。
   *
   * ⚠ **不能省**：DSH 的 `buildModelCatalog` 对每个 provider `await listModels()`
   * 后再对每个模型 `await resolveModelInfo()`，两处都会走到这里。原实现失败
   * 直接返回（不落缓存）⇒ 一次网络故障被放大成「每模型重试一次」，每次顶着
   * 10s 超时（`src/models.ts FETCH_TIMEOUT_MS`），首屏因此长时间空转。
   */
  private readonly catalogGate: RemoteCatalogGate

  /**
   * 懒加载远端模型目录（**每 20 分钟**重新拉一次，用户 2026-10-18 的要求）。
   *
   * resolveModel 可能先于 listModels 被调用（如直接进入会话），此时同样触发远端拉取。
   */
  private async ensureRemoteModels(): Promise<void> {
    const fetchRemote = this.options.fetchRemoteModels
    // ⚠️ `fetchRemote === undefined` 那半边**原样保留** —— 它判的是「有没有远端
    //    可拉」（无凭据/无接线），与新鲜度是两件事。
    if (fetchRemote === undefined) return
    // ⚠️⚠️ **短路判据是「已完整」+「未超 20 分钟」，不是「已定义」**
    //    （issue IKJVTF 复审，审计 I3；TTL 由 `isCatalogFresh` 给出）。
    //
    // CodeArts 有两个独立目录端点，残缺目录**也**要落 `remoteModels`
    //（展示需要 —— 目录服务抖动时用户的模型列表不该整个消失），但那时**不能**
    // 短路：`RemoteCatalogGate` 的冷却（`retryAt` / `cooling()`）在生产里只有
    // 闸门自己那一处调用点，而它排在短路**之后** ⇒ 残缺目录一旦落缓存，
    // 冷却永远读不到、残缺永远补不齐（与 Cline 的缺陷② 完全同构）。
    //
    // ⚠️⚠️ **加 TTL 为什么不会破坏残缺恢复**（加 TTL 前逐行核实）：
    // TTL 那一腿是 `&&` 的**后半截**，前半截 `remoteComplete` 未变。残缺时
    // `remoteComplete === false` ⇒ 短路判据恒为假 ⇒ **残缺目录不会被判为
    // 「新鲜」，闸门冷却与补齐逻辑原样生效**。TTL 只让「重新拉取」变得可发生
    // （完整目录满 20 分钟会被重新拉，倍率/目录变化能跟上），不改变残缺的纠正路径。
    // ⇒ **未改任何合并逻辑**（两个端点各自成败仍由接线层经 `catalogComplete` 上报）。
    // ⚠️ **TTL 那一腿用 `isCatalogFreshFor`**（带「用户主动失效」）：用户在 Jet Hub
    //    改开关后要**立即**重拉（规格 §6 的正确性要求，见 `invalidateCatalogCache`）。
    //    ⚠️ 本家走 `LlmAdapter` 基类、`createModelCatalog` 的 `product` 是
    //    `{ id: PROVIDER }` ⇒ 登记的 provider id 恒为 `PROVIDER`（`codearts`），
    //    没有「一个类服务两个站」的情况（qoder / buddy 才有）。
    //    ⚠️ 失效腿与完整性腿是 `&&` ⇒ 失效让整条合取为假、照常进闸门；
    //    拉取失败时**保留**旧 `remoteModels`（本方法不清它）⇒ 用户看到的仍是
    //    上次那份完整列表，不会退化成兜底**子集**（规格 §7 的核心取舍）。
    if (this.remoteComplete
      && isCatalogFreshFor(PROVIDER, this.catalogAt, this.options.now?.() ?? Date.now())) {
      return
    }
    await this.catalogGate.run(async () => {
      const models = await fetchRemote()
      // 空目录同样算「没拿到」：既不应落缓存（否则再也拉不回来），
      // 也不应立刻重试（否则每个模型都打一次空请求）。
      if (models.length === 0) return false
      this.remoteModels = models
      // ⚠️⚠️ **同步重建窗口表**（2026-10-30 审计 P3 D6 修）：
      //    动态窗口**必须与目录可见性解耦** —— `unknownModelContextWindow`
      //    只在「模型不在目录里」时被调，而旧实现查的是 `remoteModels`
      //    ⇒ 「在 remoteModels 里」⟺「在目录里」⇒ 动态腿在「手填模型 id」
      //    场景**基本不可达**（实测唯一例外是 VL，而 VL 不需要窗口）。
      //    ⇒ 这里把**全部**带窗口的条目（含 `windowOnly` 的窗口源条目）
      //    收进表里，与目录可见性无关。
      //
      //    ⚠️ 键用**原始 id**（不做归一）—— 与 `src/models.ts` 的 `seen` 键
      //    口径一致（归一会把 `deepseek-v4.1-flash` 与 `-1017` 并成一条，
      //    那是**两个不同模型**）。
      const windows = new Map<string, number>()
      for (const model of models) {
        const w = model.contextWindow
        if (typeof w === 'number' && Number.isFinite(w) && w > 0) windows.set(model.id, w)
      }
      this.remoteContextWindows = windows
      // ⚠️⚠️ **同时记下「窗口源 id」**（2026-10-30 第二轮审计 P1 N-1 修）：
      //    这些 id **只在 AgentCenter 出现**（builtin 没有）⇒ 若它们进目录，
      //    就是**裸名**（AgentCenter 不下发倍率）⇒ `priceFactorFromName` 恒
      //    `Infinity` ⇒ 聚合里 codearts 恒排最后。
      //    ⇒ 记进**独立集合**（`windowOnlyIds`）⇒ 之后**冷缓存也记得**
      //    ⇒ 远端路径与兜底路径口径一致。
      this.windowOnlyIds = new Set(
        models.filter((m) => m.windowOnly === true).map((m) => m.id),
      )
      // ⚠️ **只在成功赋值后**记时刻：失败/空结果不写，否则一次抖动会把上界
      //    刷新掉、下轮还要等满 20 分钟才发现上游没恢复。
      this.catalogAt = this.options.now?.() ?? Date.now()
      // ⚠️ 完整性由接线层桥接的数据源上报（两来源各自的成败）。
      // 拿不到判定时退回 `got`（= 旧行为），避免把「判不出」当成「残缺」
      // 而让每个 provider 都反复重拉。
      this.remoteComplete = this.options.catalogComplete?.() ?? true
      return { got: true, complete: this.remoteComplete }
    })
  }

  /**
   * 完整模型目录（**不应用用户黑名单**）。
   *
   * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
   * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。CodeArts 目录虽无倍率，但同样
   * 需要正确的 `name`（否则关闭项显示 `deepseek-v4-flash` 这类裸 id）。
   *
   * ⚠️ **2026-10-08 Task 7b**：骨架已上移到 `src/model-catalog.ts`，此处只剩委托。
   * ⚠️ 本家有一处**特有**的「可见性过滤」（VL 多模态不参与，见 `toCatalogEntry`），
   * 它在 `listModels` 与 `listAllModels` **两条路径上都要生效** ——
   * 故放在 `toCatalogEntry` 之前的取数回调里（`catalogEntries()`）。
   */
  /**
   * ★ **后台目录刷新器入口**（`src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`）。
   *
   * ⚠️⚠️ 必须由适配器**显式转发** `catalog.refresh`：`ModelCatalog`（`model-catalog.ts`）
   *    上的这个成员**不会**自动变成适配器的成员 —— `pruned()` 的 Proxy 只透传
   *    **适配器自己的**成员（`dead-model-store.ts:748-749`）。
   *    漏转发 ⇒ 刷新器「已武装」却对这家**空转**，且**零日志**（`refreshOf` 返回
   *    `undefined` 时静默跳过 —— `index.ts` 的装配注释写着这件事）。
   *    ⚠️ 与 `options.refresh`（HTTP 401 后的**凭据**重取）**不是同一件事**，
   *    两者同名纯属巧合，**不得合并**。
   */
  async refresh(): Promise<void> {
    await this.catalog.refresh?.()
  }

  listAllModels(): readonly { id: string; name: string }[] {
    return this.catalog.listAllModels()
  }

  /**
   * 把本家条目转成共享骨架的中间结构。
   *
   * ⚠️ 本家三处**真实差异**（不要「顺手统一」）：
   * 1. **VL 多模态不参与目录**（`-VL-` / `-VL` 结尾的 id 被滤掉）——
   *    这是本家的可见性判据，骨架不认识；
   * 2. `contextWindow` 来自静态 `CONTEXT_WINDOWS` 表（不是远端字段 ——
   *    本家两个目录端点都**不下发**窗口，取证见该表的注释），表里查不到时
   *    走具名兜底 {@link CODEARTS_FALLBACK_CONTEXT_WINDOW}（**恒有值**）；
   * 3. `reasoning` 是**恒声明**的两档（关闭/开启，**强度序**），与 entry 无关 ——
   *    实测（2026-09-29）：本网关**唯一**真正生效的思考控制是顶层
   *    `thinking.type`，`reasoning_effort`（含 low/high/none/minimal）与嵌套
   *    `reasoning.effort` 都被服务端接受但**完全无效果**（判据为服务端上报的
   *    `reasoning_tokens`，落在基线噪声内；`none` 也照常思考）。
   *    故**不**臆造 low/high/max 强度阶梯。
   */
  private toCatalogEntry(model: RemoteModel): CatalogEntry {
    // ⚠️ **恒有值**（远端动态值优先 → 静态表 → 具名兜底，恒返回正数）——
    //    缺它用户就没有上下文占用条，见 `CODEARTS_FALLBACK_CONTEXT_WINDOW`
    //    的长注释（真实报障 2026-10-21）。
    //    2026-10-29 起动态源：AgentCenter 带回的窗口与 IDE 内核权威逐值一致，
    //    静态表只是冷缓存/失败兜底（GLM-5.2 漂移史见 `CONTEXT_WINDOWS`）。
    //    ⚠️ 这里**直接读条目自身的 `contextWindow`**（条目本就来自
    //    `this.remoteModels`，再 `find` 一遍是 O(N²) 重建——IKL3YH 同型）；
    //    `DEFAULT_MODELS` 的骨架条目没有该字段 ⇒ 走静态表。
    const contextWindow = typeof model.contextWindow === 'number' && model.contextWindow > 0 && Number.isFinite(model.contextWindow)
      ? model.contextWindow
      : codeartsContextWindow(model.id)
    // ⚠️ 倍率拼进 `name`（与 officeace / buddy / loomy / raccoon 同款：
    //    `name` 带倍率、`resolveModel` 用裸名，骨架只认 `name`）。
    //
    // ⚠️⚠️ **必须同时给 `bareName`**（2026-10-21 合并审计发现）：共享骨架
    //    `model-catalog.ts:640` 的取值是 `entry?.bareName ?? entry?.name ?? model`
    //    ⇒ 省略 `bareName` 就回退到**带倍率**的 `name` ⇒ `resolveModel().name`
    //    会带上倍率。全仓其余六家拼倍率的渠道（loomy / raccoon / accio /
    //    lobsterai / trae / buddy）**全部**提供了 `bareName`，本家是唯一例外。
    //    ⚠️ 本家比别家更严重：倍率**随时间变**（错峰档 21:00–次日 08:00）⇒
    //    同一个模型的 `resolveModel().name` 一天变两次（`· 0.09x` ↔ `· 0.18x`）。
    //
    // ⚠️ **形态必须转成仓内口径 ` · x{n}`**（2026-10-21 合并审计发现）：
    //    上游 `ratio_display` 原串是 `0.7x`（**x 在数字后**），而全仓其余各家
    //    是 ` · x{n}`（**x 在数字前**），且 `src/aggregate-core.ts` 的
    //    `priceFactorFromName` 的正则把 `[×x]?` 放在数字**之前** ⇒ ` · 0.18x`
    //    **解析不出** ⇒ 恒返回 `Infinity`。
    //    ⇒ 后果：codearts 是聚合渠道（`AGGREGATE_CHANNELS` 第 1 位），
    //      它的候选价格恒为 `Infinity` ⇒ `rankCandidates` 的第三判据
    //      「同临期档内倍率升序」永远挑不到 codearts，`pickerNameOf` 的
    //      `· 最低 x{n}` 也漏掉它。
    //    ⚠️ 转换**只改形态、不改数值**（数值仍来自上游 `ratio_display`，
    //    绝不臆造上游未下发的数 —— 见 `RemoteModel.rateLabel` 的注释）。
    const rate = model.rateLabel !== undefined
      ? codeartsRateSuffix(model.rateLabel)
      : undefined
    const name = rate !== undefined ? `${model.name} · ${rate}` : model.name
    return {
      id: model.id,
      name,
      // ⚠️ `resolveModel` 用的**裸名**（不含倍率）—— 价格只属于选择列表语境
      //    （与 loomy / raccoon / trae / lobsterai 同款，见 `model-catalog.ts`
      //    的 `bareName` 字段注释）。
      bareName: model.name,
      // ⚠️ 模态**逐模型判定**（2026-10-21 接图片时改）：VL 模型声明
      //    `['text','image']`，其余恒 `['text']`。
      //
      //    为什么以前是「恒 `['text']`」：那时 VL 模型全被下面的可见性过滤滤掉，
      //    目录里一条都不剩，所以写死无害。现在 VL 模型**仍不进目录**（理由见
      //    `CODEARTS_VL_MODELS` 的注释），但 `analyzeImage` 工具会按 id 直接
      //    `resolveModel('kimi-k2.6-vl')` —— 那条路径必须看到 `image`，
      //    否则 DSH 的图片准入闸门会在**发请求之前**就拒掉。
      inputModalities: codeartsAcceptsImage(model.id) ? ['text', 'image'] as const : ['text'] as const,
      // ⚠️ **无条件落键**（`codeartsContextWindow` 恒返回正数）—— 写成
      //    `...contextWindow !== undefined ? {...} : {}` 就是本缺陷的成因。
      contextWindow,
      // ⚠️⚠️ **刻意不声明 `maxTokens`**（2026-10-30 四路审计 P1-1 定案）：
      //
      //    上游 AgentCenter 的 `max_tokens`（单次输出上限）**看起来**该落这里，
      //    但 DSH 的契约不是「上限」而是「**默认输出预算**」：
      //    `dsh-llm` 把 `defaultMaxTokens` 注入 `config.maxTokens`
      //    （`node_modules/@deepseek-ai/dsh-llm/lib/index.js:2183-2185`），
      //    而 `dsh-compaction-basic` 的 `reservedCompletionTokens(agent,
      //    defaultMaxTokens)`（`lib/index.js:757`）读的**正是同一个值** ——
      //    它把该值当作「**输出侧预留**」**从上下文窗口里扣掉**。
      //
      //    ⇒ 落键的后果（实测，宿主默认 thresholdRatio=0.8 / headroom=65536）：
      //      GLM-5.2 压缩触发点 **162,201 → 109,772**、压力预算 **137,216 → 71,680**；
      //      窗口 131,072 的模型配上 65536 的预留 ⇒ pressure=0 ⇒ 宿主**抛**
      //      `TargetPressureConfigError`（**不是降级**）。
      //    ⇒ 而 `master` 的 `toCatalogEntry` **全文没有 `maxTokens` 键**
      //      ⇒ `defaultMaxTokens` 恒 undefined ⇒ 预留恒 0 ⇒ 上述回归是
      //      **本 PR 新引入的**。
      //
      //    ⚠️ 与本仓既有先例同口径：`src/opencode-adapter.ts:392-413`
      //    **刻意不声明** `defaultMaxTokens`，理由逐字为「能力表里的
      //    `limit.output` 是**模型单次输出上限**，不是『合理的默认输出预算』……
      //    下发等于**我们替用户决定**每轮按上限请求」。本家照此办理。
      //    ⚠️ 出站侧的钳制**不受影响**：`clampCodeArtsMaxTokens` 只 `Math.min`
      //    向下、不抬预算，默认预算仍由 `CODEARTS_MAX_OUTPUT_TOKENS` 单点决定
      //    （`src/llm-adapter.ts:1965`）⇒ 撤掉本键**不改变实际发出去的
      //    `max_tokens`**（上游声明值 65535 与本地 65536 的 1 token 差异也一并消失）。
      reasoning: {
        // ⚠️ 顺序 = **强度序（弱 → 强）**，逐条理由见 `CODEARTS_REASONING_EFFORTS`
        // 的长注释（Issue IKLIDV）—— 简言之：DSH 把该数组当展示顺序、客户端不排序，
        // 故 `['on','off']` 会让「开启」落在横向轴的最左。
        // ⚠️ `defaultEffort` 仍由 `CODEARTS_DEFAULT_EFFORT` 单独表达，与位置无关。
        efforts: [...CODEARTS_REASONING_EFFORTS],
        defaultEffort: ReasoningEffortId(CODEARTS_DEFAULT_EFFORT),
      },
    }
  }

  /**
   * 本家全部条目（**含 VL 可见性过滤**）。
   *
   * ⚠️ `await this.ensureRemoteModels()` 是**必需**的（不是可选优化）：
   * 早期实现用 `void` 丢弃 Promise，冷缓存时远端目录尚未落地就走静态兜底表，
   * 模型选择器会短暂显示错误的模型集合（Jet Hub 的模型开关也据此渲染，
   * 会造成「关掉的模型又冒出来」）。
   */
  private async catalogEntries(): Promise<readonly CatalogEntry[]> {
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? DEFAULT_MODELS.map((id) => ({ id, name: id }))
    return source
      .filter((m) => this.isVisibleCatalogEntry(m))
      .map((m) => this.toCatalogEntry(m))
  }

  /**
   * 一条远端条目**该不该进对话目录**（**两条路径共用**，2026-10-30 第二轮审计 P1 N-2 修）。
   *
   * ⚠️⚠️ **必须共用**（实测踩到）：`catalogEntries()`（异步，给 `listModels` /
   * `resolveModel` 用）与 `syncCatalogEntries()`（同步，给 `listAllModels` 用）
   * **原本各写一遍** ⇒ 守卫只覆盖了异步那条 ⇒ 变异「删掉同步那条的过滤」
   * ⇒ **全量 11476 条用例全绿**（零保护）⇒ 而 `listAllModels()` 是
   * **Jet Hub 模型开关清单**的数据源（`src/jet-hub-rpc.ts` 的 `fullCatalogIds()`）
   * ⇒ 窗口源条目会**以裸名**出现在设置页（正是 P1-2 想消灭的形态）。
   *
   * ⇒ 现在**一份判据、两条路径共用** ⇒ 不可能再分叉。
   *
   * 判据两条：
   * 1. ⚠️ **窗口源条目不进目录** —— AgentCenter 不下发倍率 ⇒ 进目录就是裸名
   *    ⇒ `priceFactorFromName` 恒 `Infinity` ⇒ 聚合里 codearts 恒排最后、
   *    永远不被挑中（静默）。它们的**窗口**仍可用 ——
   *    见 {@link remoteContextWindows}。
   *    ⚠️⚠️ **判据是「id 集合」而不是「条目属性」**（2026-10-30 第二轮审计
   *    P1 N-1 修）：原先只看条目的 `windowOnly` 属性 ⇒ **只在「远端拉取成功」
   *    时生效** ⇒ 冷缓存（首启 / 远端失败 / 上游抖动）走
   *    `DEFAULT_MODELS` 兜底 ⇒ 那里的条目**没有** `windowOnly` 属性 ⇒
   *    `kimi-k3` 以**裸名**进目录 ⇒ 第一轮 P1-2 的症状**原样复发**。
   *    ⇒ 现在判据是 {@link windowOnlyIds} 这个**独立 id 集合**（远端来时填、
   *    **冷缓存时也留着**）⇒ 两条路径口径一致。
   * 2. ⚠️ **VL 多模态不进对话目录**（上下文小、不支持工具调用；当 agent 主模型
   *    会踩别的坑）。⚠️ 与 `src/models.ts` 的 `parseModelInfo` **同口径**
   *    （大小写**不敏感**）。
   */
  private isVisibleCatalogEntry(model: { id: string, windowOnly?: boolean }): boolean {
    if (model.windowOnly === true) return false
    if (this.windowOnlyIds.has(model.id)) return false
    return !/-VL-/i.test(model.id) && !/-VL$/i.test(model.id)
  }

  /**
   * 同步视图（`listAllModels` 用）。
   *
   * ⚠️ **不能** `await ensureRemoteModels()`（同步契约）—— 读 `remoteModels`
   * 缓存，未落地时回退静态兜底表（这正是原实现的语义）。
   */
  private syncCatalogEntries(): readonly CatalogEntry[] {
    const source = this.remoteModels ?? DEFAULT_MODELS.map((id) => ({ id, name: id }))
    // ⚠️⚠️ **判据与 `catalogEntries()` 共用**（`isVisibleCatalogEntry`）——
    //    原先两条路径**各写一遍** ⇒ 守卫只覆盖异步那条 ⇒ 同步那条（**Jet Hub
    //    模型开关清单**的数据源）零保护（2026-10-30 第二轮审计 P1 N-2 修）。
    return source
      .filter((m) => this.isVisibleCatalogEntry(m))
      .map((m) => this.toCatalogEntry(m))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(_provider)
  }

  /**
   * 「这份 `listAllModels()` **确认**来自远端完整读取」——供 `model.list` 的
   * 「已下架」判据用（见 `ModelCatalogSource.catalogConfirmedRemote` 的注释）。
   *
   * ## 判据（两条腿都必须成立，缺一即 `false`）
   *
   * 1. `remoteModels !== undefined` —— 至少成功读到过一次远端目录。
   *    ⚠️ `syncCatalogEntries()` 在未落地时回退**编译期兜底表**，那是远端目录的
   *    **子集**（Issue IKJW33 的实测形态）⇒ 不能当「在售集合」。
   * 2. `remoteComplete === true` —— 接线层经 `catalogComplete` 上报「**两个**
   *    目录端点都取全」。只有一个端点成功时目录同样是子集。
   *
   * ## 保守方向
   *
   * 冷启动 / 远端降级 / 残缺时返回 `false` ⇒ `model.list` **放弃**判据、照旧补回
   * 黑名单条目。代价是可能多留一个「点开会 404」的幽灵条目；反向的代价是用户在售
   * 模型从设置页**彻底消失且无法重新打开**（不可自愈）⇒ 两害相权取其轻。
   *
   * ⚠️ 本方法必须能被 `withDeadModelPruning` 的 Proxy **原样透传**（它有接线守卫：
   * `dead-model-store.spec.ts` 的「catalogConfirmedRemote 经包装后仍可调用」）。
   */
  catalogConfirmedRemote(): boolean {
    return this.remoteModels !== undefined && this.remoteComplete
  }

  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolveModel(provider, model, signal)
  }

  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    // ⚠️⚠️ **不得在这里再写一次 `inputModalities`**（2026-10-21 接图片时发现）：
    // 原代码是 `{ ...await this.resolveModel(...), inputModalities: ['text'] }` ——
    // 即**硬覆盖**目录里刚算出的模态。那与「同一事实写两处」同型：只要目录里
    // 开始按模型区分模态（VL 收图、文本模型不收），这行就会**静默把它抹平**，
    // 症状是「VL 模型明明声明了 image，发图仍被 DSH 在入库阶段拒掉」。
    // ⇒ 模态只由 `toCatalogEntry` 一处决定，这里原样透传。
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let credential = await this.options.resolveCredential()
    if (credential === undefined || Date.parse(credential.expires_at) <= Date.now()) {
      await this.options.refresh()
      credential = await this.options.resolveCredential()
    }
    if (credential === undefined || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
      throw new LlmError('codearts: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // Track current account id for rate limit tracking
    let currentAccountId = ''
    if (this.options.accountPool && credential?.access_key_id) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          'codearts',
          credential.access_key_id,
        )
      } catch (error) {
        console.warn('[codearts] 账号匹配失败（不影响本次请求）:', error)
      }
      // Token 账本（第 2 期）：回报「本笔请求解析出的账号」（空串不回报）。
      if (currentAccountId) reportLedgerAccount(PROVIDER, currentAccountId)
    }

    // ⚠️ **图片：只有 VL 模型收，且必须走共享实现**（2026-10-21 实测接线）。
    //
    //  - 模态闸门：`codeartsAcceptsImage(model)` 为假时**不读字节、不拼 parts**
    //    ⇒ 请求与改造前逐字节相同（文本模型发图仍会被上游 406，但我们不会
    //    先把图内联进去浪费一次请求；真正的准入在 DSH 侧由 `inputModalities`
    //    拦下，见 `toCatalogEntry`）。
    //  - `imageUrls === undefined` ⇒ 共享 `serializeMessages` 走**纯文本**老路径，
    //    与改造前一致；非 undefined（含空 Map）时把 user 消息升级为多模态 parts。
    //    ⚠️ 空 Map 不能降级为 undefined —— 那会让「图片在但字节读失败」的
    //    `[image unavailable]` 占位符也被跳过，图片静默消失（与 officeace 同因）。
    let imageUrls: Map<string, string> | undefined
    if (codeartsAcceptsImage(options.model)) {
      const imageRefs = new Map<string, unknown>()
      for (const message of options.messages) {
        if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
      }
      if (imageRefs.size > 0) {
        imageUrls = new Map()
        for (const [id, ref] of imageRefs) {
          if (this.options.readImage === undefined) {
            // 附件服务没接线：留空 Map（图片显示为 `[image unavailable]`），
            // 而不是抛错把整轮对话打死 —— 与其余家同一取向。
            continue
          }
          try {
            const image = await this.options.readImage(ref)
            imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
          } catch {
            // 单张读失败不拖垮整轮：其余图片照发，这张落占位符。
          }
        }
      }
    }

    const messages = serializeMessages(options.messages, imageUrls)
    /**
     * IDE 的 `user_prompt`：**回看原始 `options.messages`（不是序列化后的 wire 数组）**
     * 里最后一条**真正的用户发言**的纯文本。
     *
     * ⚠️⚠️ **必须从原始入参取，不能从 `messages` 取**：
     * 1. **语义正确性**：`user_prompt` 的值域是「用户原话」，从原始入参取让
     *    取值判据独立于 `serializeMessages` 的投影方式。实测（对抗审计 M16
     *    三场景探针）当前投影把工具结果发成独立 `role:'tool'`、永不命中
     *    `role==='user'`，两取法**逐字同形** —— 但那是投影的**当前巧合**，
     *    不是取值判据的依据；投影一改（如工具结果折回 user 消息），从 wire
     *    取就会静默变成「几百 KB 的文件内容」，与 IDE 的「用户一句话」语义
     *    完全相反。
     * 2. `messages` 已被 `unshift` 插入 system、且可能被 DSML 模式注入过提示
     *    ⇒ 扫 wire 数组要多绕开这些注入项。
     */
    const lastUserPromptText = (() => {
      for (let i = options.messages.length - 1; i >= 0; i--) {
        const message = options.messages[i]
        if (message.role !== 'user') continue
        // 该条是否**只**含工具结果（没有真正的用户文本）⇒ 跳过
        const text = contentToText(message.content).trim()
        if (text.length > 0) return text
      }
      return undefined
    })()
    // harness 的 GenerateOptions.system 是独立的系统提示（如标题生成的
    // systemPrompt、agent 的 persona）。后端 chat/completions 只接受
    // messages 数组里的 system 角色，必须显式插入——否则模型看不到
    // system 指令，只见到 user prompt 本身（实测 2026-08-22：session
    // 标题变成了 "We need to generate a session title..." 的 prompt 回显）。
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    // 将 harness 工具模式以 OpenAI function 格式告知模型，
    // 与 deepseek 适配器序列化 GenerateOptions.tools 的方式一致。
    const tools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
    // deepseek-v4 大文件写入修复（详见 isDeepseekV4Model 注释）：标准
    // tool_calls 参数一次性打包生成，SSE 静默 >60s 被网关掐断。仅当工具
    // 列表含大参数写文件类工具（write/file_write/apply_patch）时切换到
    // DSML：不发送 tools 字段、把 schema 注入 system 提示，让模型以
    // DSML 流式输出工具调用，全程有数据流、不触发网关空闲断连。read/
    // bash 等小参数工具保持标准 tool_calls，避免 DSML 带来的额外开销。
    let wireTools = tools
    if (wireTools !== undefined && needsDsmlToolMode(options.model, wireTools.map(tool => tool.function.name))) {
      // DSML 工具说明置于 system 之后、user 之前：与 CodeArts Agent IDE
      // 实际请求体一致（IDE 把工具说明作为 system 消息放在最前）。实证
      // （2026-08-22）：DSML 提示 push 到 messages 末尾时，deepseek-v4
      // 倾向把思考写入 content（正文）而非 reasoning_content；unshift 到
      // user 之前后模型恢复走 reasoning 通道，思考不再泄漏到正文。
      messages.splice(messages.findIndex(m => m.role === 'system') + 1, 0, { role: 'system', content: buildDsmlSystemPrompt(wireTools) })
      wireTools = undefined
    }
    /**
     * 会话自动命名（`purpose: 'session-title'`）的思考与预算决策（issue IKKVDH）。
     *
     * DSH 用 **64 token** 发标题请求且**不传 `reasoningEffort`**，而宿主会把
     * 本模型声明的默认档（本家恒为 `'on'`）注入进来
     * （`effective = requested ?? reasoning.defaultEffort`）。照常开思考时实测
     * 64 个 token 会被思考**全部吃满**、正文 0 字符、`finish_reason:'length'`
     * ⇒ `dsh-session-title-llm` 直接拒绝，标题永远停在 fallback。
     *
     * 本家的档位表是**恒声明的两档**（`on`/`off`，见 `resolveModel`），
     * 与具体模型无关 ⇒ 任何模型都**关得掉**，故这里必然走「关掉思考」分支，
     * 不需要抬预算（抬预算是「花钱买通」，思考本身要计费）。
     */
    const titlePlan = planSessionTitleThinking({
      purpose: options.purpose,
      requestedEffort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      // ⚠️ 与 `resolveModel` 声明的档位**同源**（`CODEARTS_REASONING_EFFORTS`）——
      // 各写一份必然漂移，而漂移的症状是「标题请求挑的关闭档不在声明里」。
      // ⚠️ `thinkingOffEffortOf` 按 **rank** 找关闭档（不按位置），故顺序调整不影响它。
      declaredEfforts: CODEARTS_REASONING_EFFORTS.map((effort) => String(effort.id)),
      maxTokens: options.maxTokens,
    })
    const body = JSON.stringify({
      model: options.model,
      messages,
      stream: true,
      /**
       * ⚠️⚠️ **以下字段集与 IDE 抓包逐项对齐**（2026-10-30 真机对照）。
       *
       * ## 取证（Reqable 抓包，4 条真实 IDE 聊天请求，键集 4/4 完全一致）
       *
       * IDE 的 11 个键：
       * `enable_thinking, max_tokens, messages, model, stream, stream_options,
       *  temperature, tool_choice, tool_stream, tools, user_prompt`
       *
       * 插件此前**多发 3 个**（IDE 一个都不发）、**少发 5 个**：
       *
       * | 字段 | 旧插件 | IDE | 本次处置 |
       * |---|---|---|---|
       * | `prompt_cache_key` | 发 | **不发** | **保留**（见下，有实测收益） |
       * | `include` | 发 | **不发** | **移除**（IDE 不请求加密 reasoning） |
       * | `reasoning_summary` | 发 | **不发** | **移除**（同上） |
       * | `enable_thinking` | 不发 | `true` | **新增**（唯一真正生效的思考开关） |
       * | `stream_options` | 不发 | `{include_usage:true}` | **新增**（要 usage 帧） |
       * | `temperature` | 不发 | `0` | **新增** |
       * | `tool_choice` | 不发 | `'auto'` | **新增** |
       * | `user_prompt` | 不发 | 用户原话 | **新增** |
       *
       * ## ⚠️ `prompt_cache_key` 为什么**不**跟着删（与 IDE 一致的那条唯一例外）
       *
       * IDE 不发它也能吃到缓存（实测 `cached_tokens 148480/148949`，99.7% 命中，
       * 靠服务端自动前缀缓存）。但插件显式发会话 id 有**独立收益**：
       * 会话级亲和让同一会话的多轮/并发请求落同一后端实例 ⇒ 命中率稳定。
       * 2026-10-30 真机 A/B：带它 200 且 `cached=256`，不带也 200 且同样 `cached=256`
       * ⇒ **无害**，故保留（不是「与 IDE 不一致」的误配）。
       *
       * ## ⚠️⚠️ `enable_thinking` 是**唯一真正生效**的思考开关（实测判别）
       *
       * 用「17×23 step by step」+ `reasoning_tokens` 作判据，三轮真机：
       *
       * | 请求 | `reasoning_tokens` | reasoning 字符 |
       * |---|---|---|
       * | `enable_thinking: true`  | **34** | 129 |
       * | `enable_thinking: false` | **n/a（无该字段）** | **0** |
       * | 不发该字段              | 45 | 175 |
       *
       * ⇒ `true`/`false` **双向都生效**；不发 = 服务端默认（开）。
       * ⚠️ 这推翻了本文件上方「顶层 `thinking.type` 是唯一生效控制」的旧结论
       * —— 那是 2026-09-29 只测了 `thinking.type` 得出的，**两条腿并存**：
       * `enable_thinking:false`（IDE 方言）与 `thinking:{type:'disabled'}`（旧方言）
       * 实测**等价**（都让 `reasoning_tokens` 归零），故按 IDE 用前者。
       */
      // ⚠️ 删 `include` / `reasoning_summary` 的依据：IDE 从不下发它们，
      // 而本仓也没有任何消费者读「加密 reasoning」⇒ 纯冗余出站字段。
      // ⚠️ `prompt_cache_key` **保留**（唯一有意偏离 IDE 的字段，理由见上方长注释）。
      prompt_cache_key: this.sessionId,
      // 思考开关：按 IDE 的 `enable_thinking`（关档发 false，其余发 true）。
      // ⚠️ **不发 `thinking:{type:'disabled'}`** —— 与 IDE 对齐后两者只留一份，
      //    避免「同一语义两个字段」（旧方言仍被服务端接受，但不该再发）。
      enable_thinking: !(titlePlan.thinkingOff || options.reasoningEffort === 'off'),
      // IDE 每次请求都带 `stream_options.include_usage`（要 usage 帧）。
      // ⚠️ 本仓的 usage 消费方（token-meter / 占用条）依赖 `assistant/message.usage`，
      //    拿不到 usage 会让分子的唯一来源变空 ⇒ 这不是可选美化项。
      stream_options: { include_usage: true },
      // ⚠️ `temperature: 0` 与 IDE 逐字一致（IDE 4/4 请求全是 0）。
      temperature: 0,
      // ⚠️ `tool_choice: 'auto'`：只在真带工具时发（无工具时下发的 `tools` 已省略，
      //    此时发 `tool_choice` 是无意义字段，IDE 也只在有工具时发它）。
      ...wireTools !== undefined && wireTools.length > 0 ? { tool_choice: 'auto' as const } : {},
      // 对齐 CodeArts Agent IDE 请求体（deveco-code 内核日志实证）：
      // tool_stream=true 让后端将超大工具调用参数（如大文件 file_write）
      // 分段流式传输，避免单次 SSE 事件过大导致连接被掐断
      // （error decoding response body）。deepseek-v4 的 DSML 路径不受此
      // 影响，保留该字段与 IDE 对齐。
      tool_stream: true,
      // 输出上限（对齐 deveco-code-rust 参考实现 codearts.rs 的 max_tokens 配置）：
      // 大文件 write 工具参数（如 1000-2000+ 行文档）需要数万 token 的生成空间，
      // 若沿用后端默认输出上限，参数 JSON 会在中途被截断成非法 JSON，harness
      // 工具校验报 `invalid arguments: "arguments" must be an object`。
      // 参考实现 e2e 实测：65536 可用，131072 反而触发空流被后端拒绝。
      //
      // ⚠️ **必须钳制，不能只兜底**（与 TRAE 的 `clampTraeMaxTokens`、
      // Cline 的 `clampClineMaxTokens` 同因）：`options.maxTokens` 原样透传时，
      // 上游对超大 `max_tokens` 会直接 4xx（`The request param is invalid`），
      // 而 **DSH 可能注入一个来自其它 provider 的大值** —— `maxTokens` 是 agent
      // 的一等构造参数（`dsh-agent-loop` 只校验「正安全整数」，**无上限校验**），
      // 走网关的路径由 `openai-gateway/messages.ts` 的 `normalizeMaxTokens`
      // 预先收敛，但**不经过网关的直连路径完全绕过那道判据**。
      // ⇒ 这里是最后一道防线，必须自己收敛，不能依赖上游调用方守规矩。
      // ⚠️ 抬预算（`titlePlan.maxTokens`，关不掉思考时才有值）必须走**同一个**
      // 钳制函数，否则会被钳回原值、兜底静默失效。标题请求的 512 远小于上限，
      // 故实际不会被钳；这里统一走一遍是为了「预算只有一个出口」。
      max_tokens: clampCodeArtsMaxTokens(titlePlan.maxTokens) ?? CODEARTS_DEFAULT_MAX_OUTPUT_TOKENS,
      ...wireTools !== undefined && wireTools.length > 0 ? { tools: wireTools } : {},
      /**
       * ⚠️ `user_prompt` = **最后一条 user 消息的纯文本**（IDE 的语义）。
       *
       * 实测（Reqable 4 条 IDE 请求）它的值恒为「用户这一轮的原话」，例如
       * `"继续按照设计稿优化UI代码dart，然后每完成一个模块，就提交一个git"`。
       *
       * ## 它是什么 / 不是什么
       *
       * - **不是**发给模型的提示（模型看的是 `messages`），大概率是服务端用于
       *   **会话计费/审计/标题**的旁路字段 ⇒ 缺失不影响出流（旧的插件请求
       *   不带它也能稳定 200，两年实测如此）。
       * - 但既然用户要求「尽量与 IDE 一致」，就按 IDE 下发：取值语义必须**对齐**
       *   （用户原话，不是拼好的 system 或工具结果），否则不如不发。
       *
       * ⚠️ 取不到（无 user 消息 / 内容全是工具结果）时**省略该键** —— 发一个
       * 空串会与 IDE 的真实形态（恒非空）不符，反而制造新的差异。
       */
      ...lastUserPromptText !== undefined ? { user_prompt: lastUserPromptText } : {},
    })
    const url = `${CHAT_API_BASE}/chat/completions`

    // CodeArts 按账户限制并发：当会话上限
    // 达到时请求以 TM.00001041 失败（或 SSE 流内返回
    // InferHub.ModelArts.81111.429 等排队/限流错误）。对齐参考实现
    // （deveco-code-rust runner.rs）：排队时不等待状态端点
    // working，而是每 QUEUE_RETRY_DELAY_MS 直接重试 chat 请求，
    // 上限 QUEUE_MAX_ATTEMPTS 次（180 × 10s = 30 分钟）。
    let response: Response
    let queueAttempts = 0
    // 鉴权失败（APIG.0602 / 401 / 403）后已刷新过凭据：避免死循环，
    // 同一次 stream() 调用最多 refresh 一次。
    let authRefreshed = false
    // 上游网关瞬时签名故障（正文哈希对不上）已重发的次数：
    // 与 `authRefreshed` 分开计，它**不是**鉴权失败，不该消耗续期名额。
    let signatureRetries = 0
    // 该账号不带 benefit 包时去掉 `maas_type: benefit` 头重试一次：
    // 只试一次，避免与真实失败互相掩盖。
    let benefitHeaderDropped = false
    // 反向：该模型只按 benefit 通道注册（不带该头 → InferHub.002002009.404）
    // 时补上该头重试一次。与 `benefitHeaderDropped` 互斥且各只一次。
    //
    // ⚠️ 实测（2026-10-27 审计）**最坏是三次发送**，不是「两轮」：
    //    无头(404) → 补头(4004.200，此时可能先领一次) → 去头(404) → 抛。
    //    即 `benefitHeaderPromoted` 与 `benefitHeaderDropped` **不互斥**（先补后去），
    //    两条自愈都允许发生一次 ⇒ 序列长度 3。断言「最多两轮」会与实际不符。
    let benefitHeaderPromoted = false
    /**
     * 本轮请求**实际带上了** `maas_type: benefit` 没有。
     *
     * ⚠️ 去头自愈必须以此为准，而不是「该模型是 benefit 模型」：若首轮根本没带
     * 该头，收到的 `4004.200` 只能来自**别处**（本机另有一个会重签 CodeArts
     * 请求的压缩插件 billion-context，它按自己的名单补该头），此时「去掉头」
     * 是**逐字节相同的重发**，只会白白用掉唯一一次自愈名额并把它锁死
     * （`benefitHeaderDropped` 同时挡住补头方向，见下方 catch）。
     */
    let benefitHeaderSent = false
    // ⚠️ 限时福利领取只试一次（对标 codearts2api 的 `benefit_auto_claim`：领取幂等，
    // 但上游若仍报 benefit-not-found 就该降级了，反复领只是白打接口）。
    let benefitClaimAttempted = false
    // 因限流已尝试过的账号 id：保证每个账号只试一次，试完才判定"全部受限"。
    const rateLimitTried = new Set<string>()
    if (currentAccountId) rateLimitTried.add(currentAccountId)
    // 该模型要不要带 `maas_type: benefit`：**唯一权威来源是远端 gateway/config
    // 的模型清单**。官方 CodeArts Agent 内核的判据与此完全一致 —— 它只在
    // `chat.headers` 钩子里写 `if (model_id ∈ gatewayConfig.models) headers.maas_type
    // = "benefit"`，没有任何静态表（2026-10-26 逆向 `agentkernelServer-win32-x64.exe`）。
    // 本仓库曾另有一张静态兜底表，两次都因后端改注册通道而误判，已删除：
    // 猜错的代价是**首条消息直接报 4004.200**，比"首次多一轮 404 往返"贵得多。
    const benefitHeaderCertain = isCodeArtsBenefitModelKnown(options.model)
    /**
     * ⚠️⚠️ **本进程内「补头成功」的记忆**（2026-10-27 审计 P1 修）。
     *
     * ## 为什么必须有
     *
     * `benefitHeaderPromoted` 是 `stream()` 的**局部变量** ⇒ 下一轮从"没带头"
     * 重新开始。而远端集合取不到时（本机常态：`gateway/config` 回
     * `4000 invalid channel`，见 `docs/agent-notes/providers-codearts.md:57`），
     * `benefitHeaderCertain` 恒 `false` ⇒ benefit-only 模型（`glm-5.3-flash`，
     * 在 `DEFAULT_MODELS` 里）**每条请求**都要「无头 404 → 补头 → 成功」两次 chat。
     *
     * 实测（对抗审计）：连续两次 `stream()` 的头序列 `[null,'benefit',null,'benefit']`；
     * DSH 一轮 3 条并发（主回复/标题/压缩）⇒ **6 次上游**。
     * 而修前（有静态表）同场景只需 1 次 ⇒ 这是本 PR 引入的**净回归**。
     *
     * ## 为什么是进程内（不落盘）
     *
     * 落盘会污染「权威集合」的语义（那必须只由远端 `gateway/config` 写），
     * 而这里只是"实践证伪了远端集合的完备性"的**观测**：进程内学习足够消除
     * 同一次运行里的重复代价，重启后重新探测一次也无妨（代价仅 1 轮）。
     */
    const learnedThisProcess = codeArtsBenefitLearnedFor(options.model)
    /**
     * 领一次限时福利（幂等）。`true` = 领到 ⇒ 调用方**保持** `maas_type: benefit`
     * 头重试；`false` = 领不到 ⇒ 退回既有的去头降级。
     *
     * ⚠️⚠️ **两个门禁，缺一不可**（2026-10-27 审计 P2 修）：
     * 1. 调用方的 `benefitClaimAttempted` —— 「本次 `stream()` 内只领一次」；
     * 2. {@link claimCodeArtsBenefitShared} 的**跨请求去重** —— 「同一凭据
     *    在一段时间内只领一次」。
     *
     * 修前**只有**第 1 条，而它是 `stream()` 局部变量 ⇒ 3 条并发请求各领一次
     * （实测 `claims=3`）。而领取是**写操作**，标题/压缩请求是后台的、用户看不到
     * 它们的失败，但写请求照发。
     */
    const claimBenefitOnce = async (): Promise<boolean> => {
      // 闭包里拿不到外层「credential 已判非空」的收窄（`let` 可变），自己再判一次。
      if (credential === undefined) return false
      /**
       * ⚠️⚠️ **只有远端集合确认过的模型才允许领取**（2026-10-27 审计 P1 修）。
       *
       * `InferHub.4004.200` 这个码**不区分**两种语义：
       * ① 该账号没有 benefit 包；② 这个模型根本不该带该头（PR 自己取证过：
       * 把该头送给非 benefit 模型就回 `4004.200`）。
       *
       * 而补头方向（`MODEL_NOT_REGISTERED`）会把**任意**未确认模型也带上该头
       * ⇒ 于是「模型不存在 / 打错 id」这种与福利无关的场景，会走到这里**领一次福利**
       * （实测：一次 `stream()` 里 4 次 chat + 1 次写）。
       *
       * ⇒ 领取的前置条件收紧成「该模型由远端 `gateway/config` **确认**过」
       *   （或本进程内补头成功过）。未确认时直接返回 `false`，走既有的去头降级 ——
       *   那条路径**只发读请求**。
       */
      if (!benefitHeaderCertain && learnedThisProcess === false) return false
      try {
        return (await claimCodeArtsBenefitShared(credential, this.fetchImpl, options)) === 'success'
      } catch {
        // 领取路径的任何异常都不得掩盖原失败：领不到就走降级。
        return false
      }
    }
    for (;;) {
      // `maas_type: benefit` 参与 SDK-HMAC-SHA256 签名（不签就 401），故只能在这里
      // 决定。首次是否带只看三条腿：远端确认 / 本进程补头成功过 / 本次已补头。
      // 其余一律先发常规请求 —— 与官方内核「model_id ∈ gatewayConfig.models 才写该头」
      // 同一口径。后端若另有安排，由下方两个自愈方向兜住（各一次）。
      const extraSignedHeaders = !benefitHeaderDropped
        && (benefitHeaderCertain || learnedThisProcess || benefitHeaderPromoted)
        ? { maas_type: 'benefit' }
        : undefined
      benefitHeaderSent = extraSignedHeaders !== undefined
      const signed = await signRequestHuawei(
        credential.access_key_id,
        credential.secret_access_key,
        credential.security_token,
        'POST',
        url,
        new TextEncoder().encode(body),
        extraSignedHeaders,
      )
      const headers = new Headers(attributionHeaders())
      // ⚠️⚠️ **必须覆盖宿主的 `user-agent`**（华为 WAF 拒发
      // `deepseek-harness/` 前缀 ⇒ 403 ⇒ 客户端报「API 密钥无效」）。
      // 取证、对照表与「为什么不参与签名」见 {@link CODEARTS_USER_AGENT}。
      headers.set('user-agent', CODEARTS_USER_AGENT)
      // 签名 map 中的额外头（如 maas_type）必须随请求发送——它们已参与
      // canonical 计算、包含在 SignedHeaders 列表中，缺失会导致服务端验签失败。
      signed.forEach((value, key) => { if (key !== 'content-type') headers.set(key, value) })
      headers.set('Content-Type', 'application/json')
      headers.set('Chat-Id', this.chatId)
      headers.set('Session-Id', this.sessionId)
      headers.set('lang', 'en')

      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
      if (response.ok) {
        // 200：消费 SSE 流。CodeArts 有时以 HTTP 200 + SSE 内嵌
        // error_code/error_msg 返回排队/限流（如 InferHub.ModelArts.81111.429
        // TPM 超限），而非 4xx——consumeSse 检测到可重试排队错误时抛
        // SseQueueRetryError，落入下方排队重试逻辑，与 TM.00001041 一致。
        try {
          yield* this.consumeSse(response, options)
          /**
           * ⚠️⚠️ **补头后真的出流成功 ⇒ 记入进程内学习集合**（2026-10-27 审计 P1 修）。
           *
           * 只有走到这里（`consumeSse` 正常返回、没抛任何自愈错误）才算
           * 「这个模型确实需要 `maas_type: benefit`」⇒ 下一轮请求直接带头，
           * 不再每次先付一轮 404 往返（远端集合取不到时那是**每条请求**的代价，
           * 实测一轮 3 条并发 = 6 次上游）。
           *
           * ⚠️ 刻意**不**在 `benefitHeaderPromoted = true` 那一刻记 —— 那只是
           * 「决定补头」，补上去仍可能失败（模型不存在 / 账号无权限）。记错了会让
           * 后续请求把该头送给一个不该带的模型，而那正是本 PR 要修的缺陷形态。
           */
          if (benefitHeaderPromoted) markCodeArtsBenefitLearned(options.model)
          break
        } catch (error) {
          if (error instanceof SseQuotaExhaustedError) {
            // ── 额度用尽（InferHub.4291.200）：标记 + 换号 + 如实报出解禁时间 ──
            //
            // ⚠️ 这块**必须与排队分支分开**，且**不能** `continue` 去重试：
            // 额度是按自然日结算的确定性失败，重试 180 次（30 分钟）也还是同一个
            // 结果，只会让 UI 长期停在「运行中」且零输出 —— 那正是本次报障。
            //
            // 标记时限按 **UTC+8 当日 24:00** 推算（报文里没有时间字段），
            // 与 qoder / zcode 的额度处理同款。标记写进 `modelRateLimits` 后，
            // Jet Hub 的「限额重置 · <模型> · N 小时后」徽章与池的选号
            // （`getAvailableAccount` 会跳过未到期的账号）同时生效。
            const message = codeartsQuotaExhaustedMessage(options.model, nextUtc8DayStartMs())
            // ① 先给**当前**账号记上限流标记（UI 徽章与池的选号都依赖它）。
            if (this.options.accountPool && currentAccountId) {
              await this.options.accountPool.updateModelRateLimit(
                currentAccountId, options.model, nextUtc8DayStartMs(),
              )
              rateLimitTried.add(currentAccountId)
            }
            // ② 取下一个可用账号。
            //
            // ⚠️ 必须传 `tried`：池按用户手动顺序返回候选，**刚失败的账号可能仍排
            // 第一**（当失败类别不写标记时尤甚），不排除就会拿回同一个、命中
            // `tried.has` 而立即放弃切换（换号形同虚设）。
            if (this.options.accountPool) {
              const next = await this.options.accountPool.getAvailableAccount<CodeArtsCredential>(
                'codearts', options.model, rateLimitTried,
              )
              if (next && !rateLimitTried.has(next.entry.id)) {
                rateLimitTried.add(next.entry.id)
                credential = next.credential
                currentAccountId = next.entry.id
                authRefreshed = false // 新凭据：重置「已刷新过」标记
                continue // 用下一个账号重试
              }
            }
            // ③ 没有可用账号（或没有账号池）：如实抛出，带上解禁时间。
            throw new LlmError(message, CODEARTS_QUOTA_EXHAUSTED_CODE, { status: 200 })
          }
          if (error instanceof SseQueueRetryError) {
            // 落入下方排队重试
          } else if (
            error instanceof LlmError
            && error.code === MODEL_NOT_REGISTERED_CODE
            && !benefitHeaderSent
            && !benefitHeaderDropped
            && !benefitHeaderPromoted
          ) {
            // 反向自愈：该模型只按 benefit 通道注册，而我们这次**没带**该头
            // （见上方 `benefitHeaderCertain` 的说明）。补上该头重放一次。
            //
            // ⚠️ 这里**不再**要求「该模型是 benefit 模型」：那正是被删掉的静态
            // 表才能回答的问题，而它过时正是本类缺陷的根源。判据改成「本轮没带
            // 头 + 上游说未注册」，对新模型同样成立，代价最多多一轮往返。
            benefitHeaderPromoted = true
            continue
          } else if (
            error instanceof LlmError
            && error.code === BENEFIT_NOT_FOUND_CODE
            && benefitHeaderSent
            && !benefitHeaderDropped
          ) {
            // 上游报「benefit not found」。两种解读**可能都成立**：
            // ① 该账号没有 benefit 包；② 有资格但**还没领取**（领取幂等）。
            // 先领一次：领到就**保持**该头重放；领不到才去头降级。
            if (!benefitClaimAttempted) {
              benefitClaimAttempted = true
              if (await claimBenefitOnce()) continue // 保持 maas_type: benefit 重放
            }
            // 没领到（或已试过领取）⇒ 去头降级（只试一次）。
            benefitHeaderDropped = true
            continue
          } else {
            throw error
          }
        }
      } else {
        const errorText = await response.text().catch(() => '')
        // 上游网关瞬时签名故障（`APIG.0301 … body hash mismatch`）：直接重发。
        //
        // 为什么值得自动重发：这是用户可见的一次性失败 —— 2026-10-03 用户报障
        // 「华为的还是用不了」，会话日志里两次 401（13:55、15:23）都带着
        // `APIG.0301 … body hash mismatch`，而此前同一会话的 135 轮调用全部正常、
        // 事后同一凭据重放也立刻成功。也就是说这一次失败**本来重发就能过去**，
        // 原实现却把它当凭据问题（先白刷一次凭据、再报「API 密钥无效」）。
        if (isTransientSignatureFailure(response.status, errorText) && signatureRetries < SIGNATURE_RETRY_MAX) {
          // ⚠️ **abort 后必须立刻停手**（2026-10-19 审计 I1）。`delay()` 在信号
          // 中止时是**静默 resolve**（不是 reject），若不判就直接 `continue`，
          // 循环会回到顶部**再发一次完整请求** —— 用户已经按了「停止」，网关
          // 却还在收请求（实测：基线 abort 后恒 2 次，加了这条重发后涨到 3 次）。
          //
          // ⚠️ 与下方排队路径 L1571 的 `if (options.signal?.aborted) throw` 是
          // **同一处置**，不是两份判据：排队与签名重发都要在退避后复检信号。
          if (options.signal?.aborted) {
            throw new LlmError('codearts: request aborted while retrying after a transient gateway signature failure', 'ABORTED')
          }
          signatureRetries += 1
          await delay(SIGNATURE_RETRY_DELAY_MS * signatureRetries, options.signal)
          continue
        }
        // ⚠️⚠️ 本机代理拒发改写请求（bili，Gitee IKQ7AP）：**在 AUTH 刷新之前**
        // 直接抛出，不进入刷新/换号路径。
        //
        // 为什么位置在 `isAuthError` 分支之前、且是**独立早退**而不是只靠
        // `isAuthError` 排除：`isAuthError` 返回 false 只保证「不白刷凭据」，
        // 但 403 还会继续落到下面的额度/限流/`httpErrorCode` 分类链。
        // `httpErrorCode` 那格已改成返回 `PROXY_REFUSED_SIGNED`（码正确），
        // 但**文案**会走通用的 `model request failed with HTTP …` 模板 ——
        // 那句唯一的指路话（怎么让 bili 拿到重签凭据）仍到不了用户眼前。
        // ⇒ 在这里直接用 {@link proxyResignRefusalFailure} 抛完整文案。
        //
        // ⚠️ **重发无效**：与 `isTransientSignatureFailure` 那条的本质区别
        //（见其注释的对照表）—— 压缩仍在、重签凭据仍缺，重发/刷新/换号都不会好。
        // ⚠️ **不换号**：换号只会让下一个账号的凭据同样到不了 bili 手里；
        // 且与 codearts 不做 permanentLock 的既有决定一致 —— 「代理拒发」不是
        // 「账号死亡」，任何永久化都不该由这条 403 触发（issue 的反面教材：
        // 同源缺陷在另一实现上把账号**永久禁用**了）。
        if (isProxyResignRefusal(response.status, errorText)) {
          const failure = proxyResignRefusalFailure(errorText)
          throw new LlmError(failure.message, failure.code, { status: response.status })
        }
        // 鉴权失败（SecurityToken 过期/被吊销/APIG.0602）：刷新一次凭据后
        // 重试整个 chat 请求。入口的 expires_at 预判无法覆盖后端提前吊销
        // 或时钟偏差场景，这里做兜底，避免把可自愈的鉴权失败抛给用户。
        if (isAuthError(response.status, errorText) && !authRefreshed) {
          authRefreshed = true
          await this.options.refresh()
          credential = await this.options.resolveCredential()
          if (credential === undefined || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
            throw new LlmError('codearts: credential missing after refresh; log in again', 'MISSING_CREDENTIAL')
          }
          continue
        }
        // 额度用尽（**不可重试**）：与下面「限流/排队」是本质不同的两类。
        //
        // ⚠️ 必须在 `isRateLimited` **之前**判定：`insufficient quota` 这类文案
        // 若被限流判据先接走，就会被当成「重试可自愈」，而它其实是按自然日结算的
        // 确定性失败（同 `qoder` 的 `110` vs `10605` 那次教训）。
        // 实测该码主要走 SSE 通道（HTTP 200），但服务端同样可能以 4xx 下发 ——
        // 两条通道都接，避免哪天改了形态就漏（`AGENTS.md` 的既有铁律）。
        //
        // ⚠️ 判据用整个错误体（`errorDetail` 会拼出 `error_code` + `error_msg`）：
        // 4xx 的报文形态与 SSE 不同，不能指望顶层 `error_code` 字段名一致。
        // ⚠️ **分类必须走 `errorDetailForClassify`**（不含 detail 腿）—— 理由同上，
        // 用展示出口会让 detail 里的额度措辞翻转这条判据。
        if (isSseQuotaExhaustedErrorCode(errorDetailForClassify(errorText), errorText)) {
          const message = codeartsQuotaExhaustedMessage(options.model, nextUtc8DayStartMs())
          if (this.options.accountPool) {
            if (currentAccountId) {
              await this.options.accountPool.updateModelRateLimit(
                currentAccountId, options.model, nextUtc8DayStartMs(),
              )
              rateLimitTried.add(currentAccountId)
            }
            const next = await this.options.accountPool.getAvailableAccount<CodeArtsCredential>(
              'codearts', options.model, rateLimitTried,
            )
            if (next && !rateLimitTried.has(next.entry.id)) {
              rateLimitTried.add(next.entry.id)
              credential = next.credential
              currentAccountId = next.entry.id
              authRefreshed = false
              continue
            }
          }
          throw new LlmError(message, CODEARTS_QUOTA_EXHAUSTED_CODE, { status: response.status })
        }
        // ── benefit 去头重试的 **4xx 通道**（Gitee issue IKLBSH A6）──
        //
        // 同一个上游条件（该账号没有 benefit 免费额度包）会走**两条**通道下发：
        // SSE 200（`consumeSse` 已接，见 `CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE`）
        // 与 HTTP 4xx。此前**只有 200 那条接上了** —— 4xx 形态会径直落到
        // `httpErrorCode` 归成 `INVALID_REQUEST` 抛出，**去头重试一次也不试**，
        // 于是「同一条件下 SSE 能自愈、4xx 却硬报错」。
        //
        // ⚠️ 这不是推断：`origin/issue/IKJOF7-benefit-diagnostics` 分支
        //（2026-10-05 取证提交）用 `it.fails` **显式锁定**了该缺陷
        //（「HTTP 4xx + 正文含 InferHub.4004.200 时也应当去头重试」），
        // 当时的结论是「已确认，但本分支不修」——本处即补上那一半。
        //
        // 判据复用既有的 `benefitHeaderDropped` 门禁（**只试一次**）——它与
        // SSE 通道**共享同一个标记**，故两条通道叠加也只会去头一次，不会
        // 「各试一次」把请求放大成两轮。
        //
        // ⚠️ 不采纳 issue 建议的「1s / 2s / 3s 递增退避重试最多 3 次」：
        // 去头重试是**一次**（`benefitHeaderDropped` 的既有语义，注释写明
        // 「只试一次，避免与真实失败互相掩盖」），且 issue 自己给的证据是
        // 「去掉请求头后密集取样 9 次全部 200」——那说明的正是**去头即通**，
        // 而非「需要多次退避」。按证据改，不按建议改。
        //
        // ⚠️ 与 SSE 通道**共用同一对门禁**（`benefitClaimAttempted` /
        // `benefitHeaderDropped`）⇒ 先领一次；领不到才去头，且两条通道叠加
        // 也只各一次，不会把请求放大成多轮。
        if (benefitHeaderSent && !benefitHeaderDropped && isBenefitNotFoundBody(errorText)) {
          if (!benefitClaimAttempted) {
            benefitClaimAttempted = true
            if (await claimBenefitOnce()) continue // 保持 maas_type: benefit 重放
          }
          benefitHeaderDropped = true
          continue
        }
        // 反向自愈的 4xx 孪生分支：与 SSE 通道同源同判据（本仓库红线：
        // 同一语义不得有两套判据）。只在该头**未带**时才补，且各只一次。
        if (
          !benefitHeaderSent
          && !benefitHeaderDropped
          && !benefitHeaderPromoted
          && isModelNotRegisteredBody(errorText)
        ) {
          benefitHeaderPromoted = true
          continue
        }
        // 限流处理：记录当前账号在该模型上的重置时间，然后切换账号重试
        // （外层 for(;;) 会在拿到新凭据后重新签名发请求）。用 tried 集合
        // 保证每个账号只尝试一次，试完才判定"全部受限"——避免只试一个
        // 就下结论，导致 UI 限流状态与实际判定不一致。
        //
        // ⚠️ 必须把 `response.status` 一并传入：服务端可能返回**空体**的 429，
        // 而只按正文判定时对空体恒为 false → 整段换号逻辑被跳过，本可自愈的
        // 限流被直接抛给用户（见 `isRateLimited` 的说明）。
        if (this.options.accountPool && isRateLimited(errorText, response.status)) {
          // ⚠️ 状态码必须传到 `parseRateLimitError` —— **与上面外层判据同源**。
          // 空体 429 时 `isRateLimited` 因状态码判真而放行进来，但只按正文解析的
          // `parseRateLimitError` 返回 `null`，下面的 `if (parsed)` 会把**整块**
          // （写限流标记 + 换号 + `continue`）一起跳过：既不换号、也不落标记，
          // 最终按原错误抛出 —— 「空体 429 在 CodeArts 上依旧不自愈」。
          // 这正是本补丁要修的缺陷，本处是第三条（也是最后一条）调用点。
          const parsed = parseRateLimitError(errorText, options.model, response.status)
          if (parsed) {
            if (currentAccountId) {
              await this.options.accountPool.updateModelRateLimit(
                currentAccountId, parsed.modelId, parsed.resetTimeMs,
              )
              /**
               * ⚠️⚠️ **必须把首号加进 `rateLimitTried`**（2026-10-18 审计补齐）。
               *
               * 这一格原先**既没加首号、也没把 `rateLimitTried` 传给池** —— 两处都漏。
               * 加首号是**承重**的：它是「本轮已试过」的记账，
               * 漏了它 ⇒ 首次 429 换号时排除集为空 ⇒ 池按手动顺序**把刚失败的
               * 首号再返回一次** ⇒ `rateLimitTried.has` 命中 → **换号立即终止**
               * ⇒ 报「所有账号均受限」而池里其实有可用账号。
               *
               * ⚠️ 与同文件 `:1323`（SSE 额度格）、`:1393`（HTTP 额度格）**同型** ——
               * 那两格一直都有这一行，只有本格漏了。
               */
              rateLimitTried.add(currentAccountId)
            }
            // ⚠️ 必须传 `rateLimitTried`（⚠️⚠️ **2026-10-18 修复：这一行原先漏传**）
            // —— 池按用户手动顺序返回候选，**刚被标记的账号可能仍排第一**
            // （模型级过滤命中时不会，但 `parsed.resetTimeMs` 若落在
            // `modelIds` 之外、或标记与本模型键不一致时就挡不住）⇒ 拿回同一个
            // ⇒ 命中下面的 `rateLimitTried.has` 而立即放弃换号，报
            // 「所有账号均受限」而池里其实有可用账号。
            // 与同文件 `:1331`（额度耗尽换号）、`:1395` 两处**同型同修**。
            // 该缺陷与 2026-09-17 的 `81706da`（`excludeAccountIds` 的引入
            // 动机）逐字同构，只是那一次漏在了这一格。
            const next = await this.options.accountPool.getAvailableAccount<CodeArtsCredential>(
              'codearts', options.model, rateLimitTried,
            )
            if (next && !rateLimitTried.has(next.entry.id)) {
              rateLimitTried.add(next.entry.id)
              credential = next.credential
              currentAccountId = next.entry.id
              authRefreshed = false // Reset auth refresh flag for new credential
              continue // Retry request with new credential
            }
            throw new LlmError(
              `codearts: 模型 ${options.model} 所有账号均受限，请稍后再试`,
              'QUOTA_EXCEEDED',
            )
          }
        }
        if (!isQueueError(response.status, errorText)) {
          // 非 TM.00001041 错误也未必没排队：openpangu 等模型的并发限流
          // 错误码/HTTP 状态可能与 GLM 不同，但仍会进入后端队列。先探测
          // 排队状态端点——只有端点确认会话在排队（waiting/queue_full）时
          // 才进入排队流程；端点不可达或未排队（working）则按原错误分类
          // 立即抛出，避免把真错误（如 401/400）拖成 30 分钟超时。
          const probe = await this.queryQueueStatus(credential, options.model, options.signal)
          if (probe === undefined || probe.status === 'working') {
            /**
             * ⚠️⚠️ 三个「非凭据问题」的业务码必须在**通用模板之前**单列
             *（2026-11-05，Gitee PR #175 评审 + 本仓库 UA 修复的兜底）。
             *
             * 通用模板 `codearts: model request failed with HTTP ${status}` 一个字
             * 都没说「这是上游策略 / 并发上限 / 租户未开通」，而
             * `httpErrorCode(403)` 会把它归成 `AUTH` ⇒ 客户端整条换成
             * 「API 密钥无效」（IKLBSH 同族红线）⇒ 用户去重登凭据，方向全错。
             *
             * ## 错误码为什么三条各不相同（**别合并**）
             *
             * | 码 | 成因 | 重试有效？ | 宿主码 |
             * |---|---|---|---|
             * | `TM.00000001` | 网关按客户端标识拒发 | **否**（同 UA 恒 403） | `PERMISSION`（**不可重试**） |
             * | `TM.00001041` | 账号级并发上限（403 形态） | **是**（等 1~2 分钟即好） | `RATE_LIMIT`（可重试） |
             * | `TM.000010051` | 模型未在本租户开通 | **否** | `PERMISSION` |
             *
             * ⚠️ 把 `TM.00000001` 也归 `RATE_LIMIT` 是**错的**：宿主
             * `DEFAULT_RETRYABLE_CODES` 含 `RATE_LIMIT`（`maxRetries 5`）⇒
             * 确定性失败会被白退避重试 5 次，每次都打上游一次 403。
             * ⚠️ 与 qoder 那条「网关 5xx 白重试」是**同型缺陷**，只是方向相反。
             *
             * ## 为什么 403 + `TM.00001041` 也走这里而不是排队流程
             *
             * {@link isQueueError} 只认 `400`（**400 形态的自愈路径不可动**：
             * 本仓库 4 条既有用例用它锁「撞上限后自动重试即成功」）。
             * 403 形态进不了排队 ⇒ 只能在这里给「等一会儿就好」的文案 + 可重试码。
             */
            if (isGatewayBusyError(errorText)) {
              throw new LlmError(codeartsGatewayBusyMessage(options.model), 'PERMISSION', {
                status: response.status,
              })
            }
            if (isConcurrencyLimitError(errorText)) {
              throw new LlmError(codeartsConcurrencyLimitMessage(options.model), 'RATE_LIMIT', {
                status: response.status,
              })
            }
            if (isTenantNotEnabledError(errorText)) {
              throw new LlmError(codeartsTenantNotEnabledMessage(options.model), 'PERMISSION', {
                status: response.status,
              })
            }
            // 与 deepseek 适配器的 httpErrorCode 词汇保持一致；
            // 400 + 上下文超限措辞归为 CONTEXT_WINDOW_EXCEEDED（触发 compaction）。
            const code = httpErrorCode(response.status, errorText)
            throw new LlmError(`codearts: model request failed with HTTP ${response.status}`, code, { status: response.status })
          }
          // probe.status 为 'waiting' 或 'queue_full' → 落入下方排队流程。
        }
      }
      // TM.00001041 / 状态端点确认排队 / SSE 内排队错误：对齐参考实现
      // 直接重试 chat 请求，每 QUEUE_RETRY_DELAY_MS（10s）一次，上限
      // QUEUE_MAX_ATTEMPTS（180）次，不等待状态端点 working。排队期间
      // 不产出任何内容块（StreamChunk 协议没有独立的瞬态状态通道，
      // 任何 reasoning/text 块都会被 BlockAssembler 组装进 assistant
      // 消息并持久化到会话历史，reasoning 块还会显示在 web 的 Think
      // 区域，且 visible 回退可能把推理文本作为正文回传给模型），因此
      // 保持静默，web 显示 harness 自身的"运行中"状态。每次重试前查询
      // 状态端点：终态（error/queue_full）立即抛错，其余情况
      // （waiting/working/端点不可达）等待后直接重试 chat。
      queueAttempts += 1
      if (queueAttempts > QUEUE_MAX_ATTEMPTS) {
        throw new LlmError('codearts: queue wait timed out after 30 minutes', 'QUEUE')
      }
      if (options.signal?.aborted) throw new LlmError('codearts: request aborted while waiting in queue', 'QUEUE')
      const status = await this.queryQueueStatus(credential, options.model, options.signal)
      if (status?.status === 'error' || status?.status === 'queue_full') {
        throw new LlmError(`codearts: ${status.message || `queue status: ${status.status}`}`, 'QUEUE')
      }
      await delay(QUEUE_RETRY_DELAY_MS, options.signal)
      // 直接重试 chat 请求（外层 for(;;) 循环）
    }
  }

  /**
   * 消费一个 HTTP 200 的 SSE chat 响应并产出 StreamChunk。
   *
   * CodeArts 后端有时以 HTTP 200 + SSE 内嵌错误事件的形式返回排队/限流
   * （如 `InferHub.ModelArts.81111.429` TPM 超限，事件形如
   * `{"text":"[DONE]","error_code":"...","error_msg":"..."}`），而不是
   * 4xx——这类错误若直接当成流结束会被静默吞掉（表现为"思考后无输出"）。
   * 本方法解析每个 SSE 事件的 `error_code`/`error_msg`：可重试的排队/限流
   * 错误抛 {@link SseQueueRetryError} 让外层重试循环按 TM.00001041 同等
   * 处理（10s 间隔重试整个 chat 请求）；不可重试错误抛普通 LlmError。
   */
  private async *consumeSse(
    response: Response,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('codearts: empty model response body', 'EMPTY_RESPONSE')
    // 块组装状态：文本 / 推理 / 工具调用各自拥有唯一
    // 索引，与 harness StreamChunk→ContentBlock 契约一致。
    const blocks: Array<{
      index: number
      kind: 'text' | 'reasoning'
      text: string
    }> = []
    let nextIndex = 0
    const toolCalls = new Map<number, {
      index: number
      text: string
      callId?: string
      name?: string
      /** 是否已发过 `block-start`（名字可用的那一刻才发，见下方 tool_calls 分支）。 */
      announced: boolean
    }>()
    const toolOrder: number[] = []
    /**
     * `tool_call` 分片 index → 后端签发的真实 id。
     *
     * ⚠️ **本兜底不可省略**（真实缺陷，2026-09-29 定位）：OpenAI 兼容协议里
     * `id` 只在**首个**分片出现，但实测华为侧偶发**完全不返回 `id`**（或返回空串）。
     * 早期实现直接把 `call.id` 写进 `block.callId`，缺失时落成**空串** id，
     * 于是 assistant 消息里留下 `{type:'tool-call', id:''}`：
     *
     * 1. `tool/call` 带着 `callId:''` 被持久化；
     * 2. 该调用完成后写 `tool/result` 时，DSH 的格式 v4 校验
     *    （`assertV4ToolResultMessage`）要求 `message.toolCallId === source.callId`
     *    且**都非空**，于是抛
     *    `format v4 tool/result at seq N requires toolCallId matching its tool source`；
     * 3. 该轮直接失败，且**会话永久报废** —— 日志停在 `tool/call`，崩溃恢复
     *    (`interruptedTurnClosers`) 按空 callId 合成修补结果时**再次**命中同一校验，
     *    既写不进也修不好。
     *
     * 空 id 同样过不了 `SessionFormatError`（它判 `length === 0`），故判据必须是
     * 「非空字符串」而不是「!== undefined」。
     *
     * 兄弟适配器（`openai-compat.ts` / `buddy-adapter.ts` / `lobsterai-adapter.ts` /
     * `trae-adapter.ts`）**都**有这层 `toolIds` 兜底，只有本文件漏了 —— 这正是
     * 该缺陷只在 `codearts` provider 复现的原因。
     *
     * ⚠️ 兜底 id 用 `call_${wireIndex}` 而非随机值：同一次响应内 index 唯一，
     * 且它必须是**稳定**的 —— 后续分片每片都要得到同一个 id。
     */
    const toolIds = new Map<number, string>()
    let buffer = ''
    let streamEnded = false
    let finishReason: 'stop' | 'tool_calls' | 'length' | undefined
    /**
     * 思考死循环检测（见 `createReasoningLoopDetector`）。命中后丢弃后续
     * reasoning 增量，收尾时发截断后的 block，并让 finish 报 max-tokens。
     *
     * 本适配器有**两处** reasoning 出口，两处都必须喂入同一判据（漏一处
     * 就等于漏一条路径）：① `emitDsmlFeed` 的 `reasoning` 聚合参数；
     * ② `delta.reasoning_content` → `dsmlReasoningExtractor` → `thinking`。
     */
    const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
    let loopDetected = false
    /**
     * **正文**死循环检测（**独立实例**，见 `createReasoningLoopDetector`）。
     *
     * 真实缺陷（用户报障，2026-09-25）：唯一活动 session 出现**正文**循环，
     * 而旧实现只在 reasoning 分支调 `observe` → 正文循环完全看不见。
     *
     * ⚠️ 两个实例不可合并：判据看尾部 3000 字符窗口的行去重率，两条通道
     * 混进同一窗口会互相稀释，使守卫双双失效。
     *
     * ⚠️ 语义差异：实测正文循环的工具调用在循环正文**之后**到达且有效，
     * 故正文守卫**只截断文本**，绝不 `reader.cancel()`、绝不改 finish reason。
     *
     * ⚠️ **本适配器刻意不做 `</think:hex>` 归位**（与其余四个适配器不同）：
     * 实测那 28 处标签**全部出自 `workbuddy`**（`hy4-preview-f` 25 处、
     * `workbuddy/deepseek-v4.1-flash` 3 处），codearts 一条都没有。
     * 更关键的是，本适配器的正文出口带 **`visible` 回退**（正文为空且无工具
     * 调用时用推理文本回填可见区）—— 若在此处把正文归位成空串，回退会立刻
     * 把整段思考**复制回正文**，等于归位失效并放大问题。故此处只加守卫。
     */
    const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
    /**
     * DSML 标记归一化器（见 sse.ts `createDsmlMarkerNormalizer`）。
     * ⚠️ **每个 `stream()` 调用一个实例**：待定缓冲是跨帧状态，共用会串流。
     */
    const dsmlFix = createDsmlMarkerNormalizer()
    let proseLoopDetected = false
    /**
     * 纯空白思考抑制器（见 `createBlankReasoningSuppressor`）。与 `blocks` /
     * `loopGuard` 同生命周期：**每个 `stream()` 调用建一个实例**。
     *
     * ⚠️ **本适配器的两个 reasoning 出口必须共用这一个实例**：
     * ① `emitDsmlFeed` 的 `reasoning` 参数、② `delta.reasoning_content` →
     * `thinking`。两处都用 `blocks.find(kind === 'reasoning')` 找**同一个**
     * reasoning 块 —— 若各持一个 helper，第二处就会从空态重新开始累积
     * （明明已有非空白内容却被判为「至今仍空白」），`text()` 也随之错乱。
     *
     * 为什么必须延后建块：`BlockAssembler` 在**没有 `block-end`** 时同样会用
     * `partial.text` 组装出块，故只在出口过滤挡不住空 Think 块 —— 必须从一开始
     * 就不发任何 chunk（与「空名字 tool_call」同型修法）。
     */
    const suppressor = createBlankReasoningSuppressor()
    // DSML 提取器：从 delta.content 中识别模型以原生 DSML XML 风格
    // 写入的工具调用（deepseek-v4 等模型在工具模式不匹配时会直接
    // 输出 `<｜DSML｜tool_calls>...`），解析为结构化 tool-call，
    // 避免原始 token 泄漏到 web UI。
    // content 与 reasoning_content 两个通道使用各自独立的 DSML 提取器。
    // 早期实现共用单个提取器，但 deepseek-v4 有时在 content 通道输出
    // <thought> 开标签（提取器进入 in-thought 状态）后，把后续推理与
    // DSML 工具调用写到 reasoning_content 通道——共用提取器会把
    // reasoning_content 的 DSML 块当作 thought 内容吞掉，不解析为
    // tool-call，最终残留 DSML 标签经 visible 回退泄漏到正文（实测
    // session-067dcf78 turn1 step13 / turn2 step3）。独立提取器让各
    // 通道状态机互不污染。
    const dsmlContentExtractor = new DsmlContentExtractor()
    const dsmlReasoningExtractor = new DsmlContentExtractor()
    // 分流 DSML 提取结果：正文文本进入 text 块、thought 进入 reasoning
    // 块、解析出的工具调用进入 tool-call 块。
    async function* emitDsmlFeed(
      text: string,
      reasoning: string,
      dsmlCalls: Array<{ name: string; arguments: string }>,
    ): AsyncIterable<StreamChunk> {
      if (text.length > 0) {
        let block = blocks.find(candidate => candidate.kind === 'text')
        if (block === undefined) {
          block = { index: nextIndex++, kind: 'text', text: '' }
          blocks.push(block)
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        // 正文死循环守卫（见 `proseLoopGuard` 注释）。命中后只停止累积与发射，
        // 绝不 `reader.cancel()`、绝不改 finish reason。
        if (proseLoopGuard !== undefined) {
          if (proseLoopGuard.observe(text)) proseLoopDetected = true
        }
        if (!proseLoopDetected) {
          // ⚠️ **先归一化再累积**（2026-10-13）：本文件是 codearts 等多家渠道的
          //    基础正文出口，此前**漏接**归一化 —— 实测重启后会话仍有 270 处
          //    `<｜｜DSML｜｜` 坏标记，正是走这条路径（首批只覆盖了
          //    openai-compat 与 buddy）。push() 流式安全，
          //    见 sse.ts `createDsmlMarkerNormalizer`。
          const fixedText = dsmlFix.push(text)
          block.text += fixedText
          if (fixedText.length > 0) {
            yield { type: 'text-delta', index: block.index, text: fixedText }
          }
        }
      }
      if (reasoning.length > 0) {
        // 死循环守卫：命中后不再累积、不再发射。
        //
        // ⚠️ 这里**只跳过发射**：真正的止损（`reader.cancel()` + `break`）在
        // 本 chunk 的行循环**全部处理完之后**、外层 `for (;;)` 末尾执行（见下方
        // ★ 止损块）—— 这样同一 chunk 里已到达的 usage / [DONE] 仍会被处理。
        // 若在此处直接 `break`，本 chunk 剩余的行会被整块跳过。
        // ⚠️ 也**不能用 `continue`**（Task 2 审查发现并已实测复现）：它会
        // 连带跳过**同一帧内**位于本分支之后的处理（`usage` 记账、DSML
        // tool-call 解析），导致 token 统计静默丢失。故用 `if (!loopDetected)`
        // 守卫分支体。
        if (loopGuard !== undefined) {
          if (loopGuard.observe(reasoning)) loopDetected = true
        }
        if (!loopDetected) {
          // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发，
          // 于是既不建块、也不消耗 `nextIndex`（见 helper 注释）。
          const emit = suppressor.feed(reasoning)
          if (emit !== undefined) {
            let block = blocks.find(candidate => candidate.kind === 'reasoning')
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'reasoning', text: '' }
              blocks.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
            }
            // ⚠️ **整块回写**（赋值，不是 `+=`）：helper 内部已累积全部文本，
            // 用 `+=` 会双写。本适配器两个出口共用同一 helper，故回写值恒为
            // 两处共同累积的完整文本。
            block.text = suppressor.text()
            yield { type: 'reasoning-delta', index: block.index, text: emit }
          }
        }
      }
      for (const call of dsmlCalls) {
        // 与 delta 路径同一条判据：名字不可用的调用**一个 chunk 都不产出**
        // （否则 `BlockAssembler` 会组装出 `name:''` 的块并污染会话，
        // 让下游端点以 400 code 11133 拒绝之后每一次请求）。
        if (!hasUsableToolName(call.name)) continue
        const wireIndex = toolCalls.size
        // DSML 语法没有 provider 签发的 call id，必须生成唯一 id：
        // harness 的 tool/call ↔ tool/result 配对与 web UI 的工具行
        // 渲染都用 callId 作为 key（见 client-runtime 匹配器
        // `tool/call -> id: String(callId)`），空 id 会让同一响应的
        // 多个工具调用（或历史重放）配对冲突，UI 只能回退为泛化的
        // "Tool call" 行而丢失 read/write 专属控件。
        const block = {
          index: nextIndex++,
          text: call.arguments,
          name: call.name,
          callId: ToolCallId(`dsml-${crypto.randomUUID().replace(/-/g, '')}`),
          announced: true,
        }
        toolCalls.set(wireIndex, block)
        toolOrder.push(block.index)
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.callId,
          name: block.name,
          argumentsDelta: call.arguments,
        }
      }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // 首 token 与 chunk 间超时分阶段使用（对齐 CodeArts Agent IDE）：
    // 第一次读取用 firstTokenTimeout（5min），收到首 chunk 后切换为
    // chunkTimeout（10min），并在每次成功读取后重置。deepseek-v4-flash
    // 生成大文件 write 的 content 参数时，首 token 后可能长时间静默，
    // 需要远大于网关 60s 的窗口才不会误判可重试 TIMEOUT 而反复重试。
    let firstTokenReceived = false
    try {
      for (;;) {
        if (streamEnded) break
        // CodeArts 网关对 SSE 有 ~60s 空闲超时：模型生成长推理 / 大工具
        // 参数时两次 chunk 间可能静默数十秒，连接被对端掐断后 reader.read()
        // 抛 `TypeError: terminated`（非 HarnessError → UNKNOWN 不可重试 →
        // harness 直接失败）。以略小于网关超时的窗口主动检测空闲：超时则
        // 取消 reader 并抛可重试 TIMEOUT；同时把传输级错误映射为可重试
        // TRANSPORT，让 harness 重试该步骤而非直接失败。
        let done: boolean
        let value: Uint8Array | undefined
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs()
          const phase = firstTokenReceived ? 'chunk' : 'first-token'
          const result = await readCodeArtsChunk(reader, timeoutMs, options.signal, phase)
          done = result.done
          value = result.value
          if (!done) firstTokenReceived = true
        } catch (error) {
          if (options.signal?.aborted) throw error
          if (error instanceof LlmError) throw error
          if (isTransportError(error)) {
            throw new LlmError(`codearts: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error })
          }
          throw error
        }
        if (done) break
        buffer += decoder.decode(value!, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            streamEnded = true
            break
          }
          let data: {
            error_code?: string
            error_msg?: string
            choices?: Array<{
              delta?: {
                content?: string
                reasoning_content?: string
                tool_calls?: Array<{
                  index?: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string
            }>
            usage?: Record<string, number>
          }
          try {
            data = JSON.parse(payload)
          } catch {
            continue
          }
          // SSE 内嵌错误检测：CodeArts 以 HTTP 200 + error_code/error_msg
          // 返回排队/限流（如 InferHub.ModelArts.81111.429 TPM 超限）。
          if (typeof data.error_code === 'string' && data.error_code.length > 0) {
            const message = typeof data.error_msg === 'string' && data.error_msg.length > 0
              ? data.error_msg
              : data.error_code
            // ⚠️ 顺序不可颠倒：额度耗尽（InferHub.4291.200）必须**先**于排队判据
            // 检查。历史上它们混淆过一次 —— `4291` 被 `429` 的裸子串匹配吃掉，
            // 额度错误因此被当成「可重试的排队」，进入 30 分钟静默重试循环，
            // 界面零输出（用户报障「没反应」的直接原因）。
            // 现在两个判据已互斥（裸 `429` 已锚定为独立数字），这里的先后仍保留：
            // 它把「额度优先」表达成代码结构，防止后续再有人放宽 `429` 判据。
            if (isSseQuotaExhaustedErrorCode(data.error_code, message)) {
              throw new SseQuotaExhaustedError(data.error_code, message)
            }
            if (isSseQueueErrorCode(data.error_code)) {
              throw new SseQueueRetryError(data.error_code, message)
            }
            if (data.error_code === CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE) {
              // 账号没有 benefit 包（积分制账户）：交给 stream() 去掉该头重试
              throw new LlmError(`codearts: ${message}`, BENEFIT_NOT_FOUND_CODE, { status: 200 })
            }
            if (data.error_code === CODEARTS_MODEL_NOT_REGISTERED_ERROR_CODE) {
              // 该模型只按 benefit 通道注册：交给 stream() 补上该头重试
              throw new LlmError(`codearts: ${message}`, MODEL_NOT_REGISTERED_CODE, { status: 200 })
            }
            throw new LlmError(`codearts: ${message}`, 'INVALID_REQUEST', { status: 200 })
          }
          const choice = data.choices?.[0]
          const delta = choice?.delta
          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length'
          }
          if (delta?.content) {
            // 通过 DSML 提取器：纯文本作为 text-delta 放行，
            // <thought> 内容作为 reasoning-delta 放行（显示在 Think 区域），
            // DSML 块解析为结构化 tool-call（与 delta.tool_calls 路径
            // 合并到同一 toolCalls/toolOrder 状态）。
            const { text, reasoning, toolCalls: dsmlCalls } = dsmlContentExtractor.feed(delta.content)
            yield* emitDsmlFeed(text, reasoning, dsmlCalls)
          }
          if (delta?.reasoning_content) {
            // 模型放在 reasoning_content 通道的内容就是思考，必须进入
            // reasoning 块（Think 区域），绝不能作为正文输出。实测
            // （2026-08-22）：deepseek-v4-flash 的 reasoning_content 通常
            // 没有 <thought> 标签，提取器会把整段当作 `text` 返回——若把
            // `text` 发给正文块，思考就泄漏到正文（TUI 显示 The user wants
            // me to... 跑到正文）。因此这里把 `text + reasoning` 合并后
            // 全部作为 reasoning 输出，仅 DSML 工具调用块单独解析执行。
            const { text, reasoning, toolCalls: reasoningDsmlCalls } = dsmlReasoningExtractor.feed(delta.reasoning_content)
            const thinking = text + reasoning
            if (thinking.length > 0) {
              // 死循环守卫：与上面 `emitDsmlFeed` 的 `reasoning` 分支同一判据，
              // 两条出口都要接（漏一处就等于漏一条路径）。
              //
              // ⚠️ 守卫必须**同时包住** `block.text += thinking` 与 `yield`
              // 两行 —— 只拦 yield 的话，累积文本仍含循环内容，收尾的截断
              // 就失效了。这里**只跳过发射**：止损（`reader.cancel()` + `break`）
              // 在本 chunk 行循环处理完之后执行（见下方 ★ 止损块），故同帧的
              // usage 记账不受影响；**也不能用 `continue`**（会连带跳过本帧
              // 之后的 usage 记账）。
              if (loopGuard !== undefined) {
                if (loopGuard.observe(thinking)) loopDetected = true
              }
              if (!loopDetected) {
                // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发。
                // ⚠️ 与出口①共用**同一个** `suppressor`：两处落在同一个
                // `blocks.find(kind === 'reasoning')` 块上，各自累积会错乱
                // （出口②会误判「整块迄今仍空白」而丢弃本已有内容的块）。
                const emit = suppressor.feed(thinking)
                if (emit !== undefined) {
                  let block = blocks.find(candidate => candidate.kind === 'reasoning')
                  if (block === undefined) {
                    block = { index: nextIndex++, kind: 'reasoning', text: '' }
                    blocks.push(block)
                    yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
                  }
                  // ⚠️ **整块回写**（赋值，不是 `+=`）。
                  block.text = suppressor.text()
                  yield { type: 'reasoning-delta', index: block.index, text: emit }
                }
              }
            }
            for (const call of reasoningDsmlCalls) {
              // 同 delta 路径：名字不可用者一个 chunk 都不产出（见上）。
              if (!hasUsableToolName(call.name)) continue
              const wireIndex = toolCalls.size
              const block = {
                index: nextIndex++,
                text: call.arguments,
                name: call.name,
                callId: ToolCallId(`dsml-${crypto.randomUUID().replace(/-/g, '')}`),
                announced: true,
              }
              toolCalls.set(wireIndex, block)
              toolOrder.push(block.index)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: block.callId,
                name: block.name,
                argumentsDelta: call.arguments,
              }
            }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0
            // ⚠️ 只接受**非空** id 并记住它：后续分片可能新一轮又给空串/缺失，
            // 无条件覆盖会把首片拿到的真实 id 抹成空（与 `function.name` 同因）。
            if (typeof call.id === 'string' && call.id.length > 0) toolIds.set(wireIndex, call.id)
            const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`
            let block = toolCalls.get(wireIndex)
            if (block === undefined) {
              block = { index: nextIndex++, text: '', announced: false }
              toolCalls.set(wireIndex, block)
            }
            block.callId = callId
            // 后续参数分片会带上空的 function.name（""），它不是 undefined，
            // 直接覆盖会把首个分片解析出的真实工具名清空，导致
            // `unknown tool ""`。只有非空名字才允许更新。
            if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
              block.name = call.function.name
            }
            const fragment = call.function?.arguments ?? ''
            block.text += fragment
            // ⚠️ **名称为空前不发射任何 chunk**（与 `openai-compat.ts` / `buddy-adapter.ts`
            // 同因同修）。只跳过收尾的 `block-end` 不够 —— `BlockAssembler`
            // 会把没有 block-end 的 partial 也组装成 `name:''`，污染会话后让
            // 腾讯系端点以 400 code 11133 拒绝之后每一次请求。
            if (!block.announced) {
              if (!hasUsableToolName(block.name)) continue
              block.announced = true
              toolOrder.push(block.index)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: ToolCallId(callId),
                name: block.name!,
                argumentsDelta: block.text,
              }
              continue
            }
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(callId),
              ...block.name !== undefined ? { name: block.name } : {},
              argumentsDelta: fragment,
            }
          }
          if (data.usage) {
            const promptTokens = data.usage.prompt_tokens ?? 0
            const cachedTokens = (data.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens
              ?? (data.usage as { prompt_cache_hit_tokens?: number }).prompt_cache_hit_tokens
              ?? 0
            const cacheWriteTokens = (data.usage as { prompt_tokens_details?: { cache_write_tokens?: number } }).prompt_tokens_details?.cache_write_tokens
            const reasoningTokens = (data.usage as { completion_tokens_details?: { reasoning_tokens?: number } }).completion_tokens_details?.reasoning_tokens
            yield {
              type: 'usage',
              usage: {
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
                ...cacheWriteTokens !== undefined && cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
                ...reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {},
              },
            }
          }
        }
        // ★ 止损（终审 C1）：命中死循环后**中止上游**，否则 128000 token 照烧。
        // 原实现只跳过下行累积/发射，`for (;;)` 仍把流读到底 —— 实测上游
        // 200 帧被读 200 帧（守卫在 ~2304 字符即命中，99.5% 的额度仍被消耗）。
        //
        // ⚠️ 位置：内层行循环**之后**、外层 `for (;;)` 末尾 —— 同一 chunk 里已到达
        // 的 `usage` / `[DONE]` 因此仍会被处理，但命中后**立即**退出，不再读下一块。
        //
        // ⚠️ 只 cancel **reader**，绝不 abort `options.signal`：后者是调用方信号，
        // abort 会被上层报成「用户取消」而非**标记为不完整**的 `max-tokens`
        // （DSH 在 `max-tokens` 时**不自动重试**，由用户/上层决定是否继续）。
        // ⚠️ `.catch(() => {})` 不可省：连接已断时 `cancel()` 会抛错，不吞掉会把
        // 「正常止损」变成一次失败。
        if (loopDetected) {
          await reader.cancel().catch(() => {})
          break
        }
      }
    } finally {
      reader.releaseLock()
    }
    // 流结束：分别 flush content 与 reasoning_content 两个独立 DSML 提取器。
    // 若模型输出了不完整的 DSML 块（被 max_tokens 截断或模型异常终止），
    // 残留内容作为纯文本放行，避免吞掉用户可见内容；不完整的 <thought>
    // 块作为 reasoning 放行，避免推理泄漏到正文；同时让 finish_reason='length'
    // 路径生效，触发 harness max-tokens 续写而非执行不完整工具调用。
    // 复用 emitDsmlFeed 把残留 text/reasoning 路由到对应块。
    {
      const f = dsmlContentExtractor.flush()
      if (f.text.length > 0 || f.reasoning.length > 0) yield* emitDsmlFeed(f.text, f.reasoning, [])
    }
    {
      const f = dsmlReasoningExtractor.flush()
      if (f.text.length > 0 || f.reasoning.length > 0) yield* emitDsmlFeed(f.text, f.reasoning, [])
    }
    // 按创建顺序关闭每个块。GLM 端点偶尔把整个回答作为 reasoning_content
    // 发出且 content 为空：此时正文区为空，回退用推理文本填充可见区。
    // 但若推理中解析出了 DSML 工具调用（deepseek-v4 的 reasoning_content
    // 内嵌工具块），正文由工具调用承担，不再把推理复制为可见文本。
    const textBlock = blocks.find(block => block.kind === 'text')
    const reasoningBlock = blocks.find(block => block.kind === 'reasoning')
    // 命中死循环时只保留循环前的干净前缀（`cutAt`）。`block-end` 是
    // **权威覆盖**（已由 `scripts/verify-blockend-override.ts` 实证）：
    // 即便前面已 yield 了全部重复 delta，这里发截断后的 block 即可，无需撤回。
    //
    // ⚠️ 行首 `course` / `课` 泄漏清洗（`stripCourseLeak`）**在此处一次性完成**：
    // `reasoningText` 同时供 `reasoningHasDsml` 判定、`visible` 回退与
    // reasoning `block-end` 使用，故在此清洗可覆盖全部三处出口，
    // 不会出现「正文干净而 Think 区仍脏」或反之的不一致。
    const reasoningText = stripCourseLeakIfEnabled(
      loopDetected && loopGuard?.cutAt !== undefined
        // ⚠️ 文本以 helper 为权威（`suppressor.text()`），**不用**
        // `reasoningBlock.text` —— 两个出口共用同一 helper，以它为准才能保证
        // 累积口径一致；`reasoningBlock` 仅用于取块 `index`。
        ? suppressor.text().slice(0, loopGuard.cutAt)
        : suppressor.text(),
    )
    // visible 回退：正文为空且无工具调用时，用推理文本填充可见区（GLM 端点
    // 偶尔把整个回答作为 reasoning_content 输出）。但若推理含 DSML 标签
    // （deepseek-v4 在推理中引用 DSML 语法讨论实现方案，非完整工具调用块），
    // 不能复制为正文——DSML 标签泄漏到正文会被模型当用户输入，导致任务
    // 终止或循环（实测 session-a69fa289 turn2 step26：推理仅含 DSML 闭合
    // 标签片段，visible 回退复制到正文后任务终止）。此时正文留空，推理仍
    // 在 Think 区域可见。
    //
    // ⚠️ 回退必须用**截断后**的 `reasoningText`，不能用 `reasoningBlock.text`：
    // 命中死循环时正文恰好为空且无工具调用，用原文会把病态循环全文复制进
    // 正文块并持久化，下次重放又要重新吃一遍（正是本守卫要根除的问题）。
    const reasoningHasDsml = reasoningText.includes('｜DSML｜')
    // ⚠️ 正文出口也必须清洗 —— 不能只清 reasoning。
    //
    // 本适配器的 `visible` 有**两条来源**：正文块，或（正文为空且无工具调用时的）
    // reasoning 回退。初版只对 reasoning 侧调了 `stripCourseLeakIfEnabled`，
    // 正文侧直接取 `textBlock.text` 原值 —— 于是「正文块里带行首泄漏」这一路径
    // 完全没被覆盖，`block-end` 发出去的仍是脏文本（同型缺陷见
    // `buddy-adapter.ts` / `lobsterai-adapter.ts` / `trae-adapter.ts` 的
    // text 出口，那几处均已清洗）。
    //
    // 清洗放在**取值处**而非 `block-end` 处：`visible` 同时供 text `block-end`
    // 与下方回退判定使用，在此清洗可保证两条出口一致（不会出现「正文块干净、
    // 回退脏」或反之）。`reasoningText` 已是清洗后的值，故回退分支无需再清。
    // 正文死循环截断：只保留循环前的干净前缀。
    // ⚠️ **不改 finish reason**：工具调用仍要被执行。
    //
    // ⚠️ 截断必须在 `visible` 回退**之前**应用：否则「正文命中循环 → 截断后为空
    // → 回退又把推理文本复制进正文」会把病态循环原样搬到可见区。
    // ── DSML 归一化收尾：下发待定缓冲 ──（与 openai-compat.ts / buddy 同款）
    // 扣住的尾部在流结束时必须放行，否则最后几个字符永远不到达宿主。
    {
      const tail = dsmlFix.flush()
      if (tail.length > 0 && !proseLoopDetected) {
        const tailBlock = blocks.find(candidate => candidate.kind === 'text')
        if (tailBlock !== undefined) {
          tailBlock.text += tail
          yield { type: 'text-delta', index: tailBlock.index, text: tail }
        }
      }
    }
    const truncatedText = proseLoopDetected && proseLoopGuard?.cutAt !== undefined
      ? (textBlock?.text ?? '').slice(0, proseLoopGuard.cutAt)
      : undefined
    const visible = truncatedText !== undefined
      ? stripCourseLeakIfEnabled(truncatedText)
      : textBlock !== undefined && textBlock.text !== ''
        ? stripCourseLeakIfEnabled(textBlock.text)
        // ⚠️ `!loopDetected` 门禁**不可省**：命中思考死循环时若仍做该回退，
        // `visible` 会变成那段**被截断的循环垃圾**，于是下面的
        // `reasoningLoopIsSoleOutput` 判据恒为假 → 永远落回 max-tokens，
        // 「有分辨力的错误提示」在 codearts 这条路径上**静默失效**。
        // 且把循环垃圾回填进正文正是本守卫要根除的问题（见上方注释）。
        : reasoningBlock !== undefined && toolOrder.length === 0 && !reasoningHasDsml && !loopDetected
          ? reasoningText
          : ''
    /**
     * 本次响应**实际会发出的 `block-end` 数量**（＝真正落进 assistant 消息的块数）。
     *
     * ⚠️ **不能写成 `blocks.length`**：`blocks` 里可能留着**不会发出**的条目 ——
     * 纯空白思考块（已被 `suppressor` 压制，连 `block-start` 都没发）、
     * 或被 `cutAt` / `course` 清洗成空串的块。用 `blocks.length` 会把
     * 「零块响应」误判成「有块」，于是静默结束的缺陷原样保留。
     *
     * 故此处**在每个 `block-end` 的发射点自增**，与下面三段发射逻辑逐条对齐。
     * 本适配器有**两个**容易算错的地方：
     *
     * 1. **正文块的条件含 `visible` 回退**：判据是
     *    `textBlock !== undefined || visible !== ''`（不是只看 `textBlock`）。
     *    `visible` 在「正文为空且无工具调用」时用推理文本填充 —— 此时
     *    `textBlock` 可能是 `undefined`（正文一个 delta 都没收到），
     *    但块**确实会发出**。只数 `textBlock` 会漏掉它、把一个非空响应
     *    误判成零块。
     * 2. **reasoning 块是双层条件**：外层 `trim() !== ''`、内层
     *    `reasoningText !== ''`。只有两层都过才真的发 `block-end`。
     */
    let blockCount = 0
    for (const index of toolOrder) {
      const block = [...toolCalls.values()].find(candidate => candidate.index === index)!
      // `toolOrder` 只收「名字已可用」的块，故此处名字必然可用；不回退成
      // `?? ''` —— 那会把空名字块写进会话，正是本次修复要根除的污染路径。
      if (!hasUsableToolName(block.name)) continue
      blockCount += 1
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          // ⚠️ 判据用 `||`（同时兜 undefined 与空串），**不可**退回成
          // `block.callId ?? ''`：空串 id 会被格式 v4 校验拒绝（它判
          // `length === 0`），落库即等于报废整条会话（见上方 `toolIds` 注释）。
          // 正常路径下 `block.callId` 已在建块时填好，此处仅为最后一道防线。
          id: ToolCallId(block.callId || `call_${index}`),
          name: block.name!,
          // 同上：空分片补 {}，残缺参数保持原样交由截断判定处理。
          arguments: isTruncatedArguments(block.text)
            ? block.text
            : normalizeToolArguments(block.text),
        },
      }
    }
    // ⚠️ 计数条件必须与上面的**发射**条件逐字一致（含 `|| visible !== ''`）：
    // `visible` 回退会用推理文本回填正文，只数 `textBlock` 会把「有正文」误判成
    // 零块、进而错报 EMPTY_RESPONSE。
    //
    // 就当前实现而言，`|| visible !== ''` 这一半在**计数**上是冗余的防御
    // （`visible !== ''` 蕴含 reasoning 那块也非空，下一段的计数必命中，
    // 故块数不会因此为 0）—— 已用变异测试证实。但在**发射**上它是必需的
    // （去掉它会让 `llm-adapter.spec.ts` 的 visible 回退用例失败）。
    if (textBlock !== undefined || visible !== '') {
      blockCount += 1
      yield { type: 'block-end', index: textBlock?.index ?? nextIndex, block: { type: 'text', text: visible } }
    }
    // ⚠️ 判据收紧为 `trim() !== ''`：纯空白思考不得被算作「有 reasoning 产出」。
    // 文本改用上面的 `reasoningText`（源自 `suppressor.text()`，已应用 cutAt
    // 截断与 course 清洗），保证与 `visible` 回退、`reasoningHasDsml` 同一口径。
    if (reasoningBlock !== undefined && reasoningBlock.text.trim() !== '') {
      if (reasoningText !== '') {
        blockCount += 1
        yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningText } }
      }
    }
    // finish_reason 映射顺序很关键：'length'（输出被 max_tokens 截断）必须优先于
    // 工具调用检查。若先看 toolOrder.length > 0，截断的工具调用会被报告为
    // 'tool-calls'，harness 将执行其不完整的 JSON 参数（报 INVALID_ARGS），并
    // 把截断参数持久化进会话历史——web 加载历史时 presenter 解析也会失败
    // （"Unterminated string in JSON"）。报告 max-tokens 后，dsh 会丢弃不完整的
    // 工具调用并触发 max-tokens 续写（分批生成），避免脏数据与错误执行。
    //
    // 另：丢弃了无名 tool-call 且没有留下任何可用调用时，同样报 max-tokens 而
    // 非 stop —— 否则模型本意调工具、harness 却认为「正常答完了」，
    // 又是一次无报错中断（与 `openai-compat.ts` 同因同修）。
    const droppedUnnamedCalls = [...toolCalls.values()].some(block => !block.announced)
    /**
     * 思考死循环是否**是唯一的产出**（无可见正文、无工具调用）。
     *
     * ⚠️ 与 `buddy-adapter.ts` / `openai-compat.ts` 同因同修（Gitee !IKIZNK）：
     * 只有该步没有可见产出时才报 `error` —— `error` 路径**不落
     * `assistant/message`**（实测 219 会话里 222 例），有可见内容时报它会把内容
     * 整块丢掉。
     *
     * ⚠️ 判据用 `visible`（＝真正会发出去的正文块文本）而**不是** `textBlock`：
     * 本适配器有「正文为空且无工具调用时用推理文本回填正文」的回退（见下方
     * `visible` 的定义），该回退会让正文块非空 —— 只看 `textBlock` 会误判成
     * 「没有可见产出」，于是报 error 把那块回填文本静默丢掉。
     * 为配合本判据，回退分支也已加上 `!loopDetected` 门禁（见下方注释）。
     */
    const reasoningLoopIsSoleOutput = loopDetected
      && visible === ''
      && toolOrder.length === 0
    const reason = reasoningLoopIsSoleOutput
      // 思考死循环且无可见产出：报**有分辨力的 error**（见 REASONING_LOOP_CODE）。
      // ⚠️ 不能报 max-tokens —— UI 对它的固定文案是「已达到输出 token 上限」，
      // 把「检测到死循环」误导成「额度用满」（真实缺陷，Gitee !IKIZNK）。
      ? { kind: 'error' as const, failure: reasoningLoopFailure(
          loopGuard?.diagnostics,
          options.maxTokens,
          'reasoning',
        ) }
      // 循环命中但另有可见产出：只能报 max-tokens（保住内容），不能报 error。
      : loopDetected
        ? { kind: 'max-tokens' as const }
      : finishReason === 'length'
        || (droppedUnnamedCalls && toolOrder.length === 0)
        ? { kind: 'max-tokens' as const }
        : finishReason === 'tool_calls' || toolOrder.length > 0
          ? { kind: 'tool-calls' as const }
          : { kind: 'stop' as const }
    // 零内容块响应（例如本次只收到过那个被压制的空白 reasoning）否则会以
    // `stop` 收场 —— 那是 DSH `EMPTY_RESPONSE` 契约明令禁止的静默结束。
    // ⚠️ 传入的是**上面已算好的** `reason`（含 loopDetected / length /
    // 无名 tool-call 等全部既存判据）；helper 只在 `kind === 'stop'` 时改写。
    yield { type: 'finish', reason: resolveEmptyResponseReason(reason, blockCount) }
  }

  /**
   * 查询某个会话的 CodeArts 并发队列状态。该端点
   * 与 chat API 一样使用 AK/SK 签名；GET 不携带请求体，因此无 content-type。
   * @param credential - 用于签名请求的 AK/SK/SecurityToken。
   * @param model - 模型 id，作为 `model` 查询参数回传。
   * @param signal - 状态请求的取消信号。
   * @returns 解析后的排队状态，或当端点不可达
   *   或返回无法识别的载荷时返回 `undefined`。
   */
  private async queryQueueStatus(
    credential: CodeArtsCredential,
    model: string,
    signal?: AbortSignal,
  ): Promise<CodeArtsQueueStatus | undefined> {
    const url = `${QUEUE_STATUS_BASE}?model=${encodeURIComponent(model)}&task_id=${encodeURIComponent(this.sessionId)}`
    const signed = await signRequestHuawei(
      credential.access_key_id,
      credential.secret_access_key,
      credential.security_token,
      'GET',
      url,
      new Uint8Array(),
    )
    const headers = new Headers()
    signed.forEach((value, key) => { if (key !== 'content-type') headers.set(key, value) })
    headers.set('x-snap-traceid', crypto.randomUUID())
    headers.set('Agent-Type', 'INFERHUB_AGENT')
    headers.set('X-Language', 'en')
    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers, signal })
    } catch {
      return undefined
    }
    if (response.status !== 200) return undefined
    let body: Record<string, unknown>
    try {
      body = await response.json() as Record<string, unknown>
    } catch {
      return undefined
    }
    const status = body.status
    if (status !== 'waiting' && status !== 'working' && status !== 'error' && status !== 'queue_full') return undefined
    return {
      status,
      queuePosition: Number(body.queue_position ?? -1),
      message: typeof body.message === 'string' ? body.message : '',
    }
  }
}

/** 在 ctx.llm 上注册 codearts 提供商路由和适配器。 */
export function registerCodeArtsLlm(ctx: Context, options: CodeArtsAdapterOptions): CodeArtsAdapter {
  const adapter = new CodeArtsAdapter({
    ...options,
    // ⚠️ 注入**唯一**的广播实现（`src/catalog-broadcast.ts`），不要在这里
    // 另写一份 emit —— 两份实现必然漂移（issue IKJVTF 的缺陷① 就是「十处全漏」）。
    onCatalogLoaded: () => broadcastCatalogChanged(ctx),
  })
  registerAdapterIdempotent(ctx.llm, [PROVIDER], adapter)
  // 返回实例：Jet Hub「显示列表」需要 `listAllModels()`（不受黑名单影响、
  // 带最终展示名）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
  return adapter
}

/**
 * CodeBuddy 系（buddy / workbuddy）表示「用量超出频率限制」的业务码。
 *
 * 判据优先用结构化业务码而非文案：**它与语言无关**，且不受服务端改文案影响。
 * 国际版与国内版用的是同一个码（实测均为 6004），只有 msg 文案分中英文。
 */
const RATE_LIMIT_BUSINESS_CODE = 6004

/**
 * 限流文案的**自然语言兜底**判据。
 *
 * 为什么需要兜底：并非所有限流错误都带得上结构化 code —— SSE 流内错误、
 * 网关返回的裸文本、以及 CodeArts（华为云）的中文错误都只有文案可判。
 *
 * ⚠️ **中英文都必须列全**。历史缺陷（用户报障，仅国际版暴露）：此处早期只有
 * 中文词（频率限制 / 使用量已超出 / 频率超出 / 重置），而国际版 WorkBuddy
 * （www.workbuddy.ai）返回的是英文
 * `usage exceeds frequency limit ... your usage will reset at <时间> UTC+8`。
 * 结果 `isRateLimited` 恒为 false → 适配器**跳过整个账号切换分支**，直接抛出
 * 原始 6004 JSON；错误码也因 HTTP 400 退化成 INVALID_REQUEST 而非
 * QUOTA_EXCEEDED。国内版返回中文文案，所以该缺陷只在国际版复现。
 *
 * `too many requests` 是标准 OpenAI 429 措辞，一并纳入。
 */
const RATE_LIMIT_PATTERN =
  /频率限制|频率超出|使用量已超出|重置|rate.?limit|frequency limit|usage exceeds|too many requests/i

/**
 * 腾讯网关「**模型饱和**」业务码（HTTP 429）。
 *
 * ## 它必须与额度限流（6004）分开（真实报障，2026-10-05）
 *
 * 用户第一次用 `buddy/space-bunny` 就报「模型 space-bunny 所有账号均受限」。
 * 直连实测（`scripts/probe-buddy-error-catalog.mjs`）逼出了服务端原话：
 * ```json
 * {"code":14003,"msg":"too many requests",
 *  "displayMsg":{"zh":"模型繁忙，请换模型或稍后重试"},
 *  "displayTips":{"zh":"这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。"},
 *  "actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]}
 * ```
 *
 * ⚠️ **它自己就说明了「这不是账号问题」**（注意 `actions` 里根本没有换号的选项，
 * 只有 `SWITCH_MODEL`）。但 `isRateLimited` 对 **429 无条件返回 true** ⇒
 * 适配器把每个账号都写上「1 小时限流」标记（报文无「将在…重置」，
 * 故取 `RATE_LIMIT_FALLBACK_MS` 兜底）⇒ 4 个独立账号在 20 秒内**全部**被锁
 * ⇒ 用户等到 1 小时也不能用，且**期间连别的模型都受影响**（同一个账号池）。
 *
 * 实测证据（同型缺陷的判据来源）：
 * | 观测 | 结果 |
 * |---|---|
 * | 4 个不同腾讯 uid 的账号 | 20 秒内**全部**被标记 `space-bunny` |
 * | 标记解禁时刻 | 全部等于「写入 + 整 1 小时」= 兜底值，**非**服务端给的时刻 |
 * | 4 MB 输入 | 稳定逼出 `429 / 14003`（46~111 秒才返回） |
 * | 小请求 30 发 | 全 200，但耗时 841ms ~ 216s —— 上游是**时变**背压 |
 *
 * ⇒ 「4 个互不相干的账号同时中招」在账号级限流下无法解释，**只能**是模型级。
 * 与 zcode `3009 model concurrency limit exceeded` 同型（那边结论同样是
 * 「退避重试，**不换号、不标记**」）。
 *
 * ⚠️ **不许把 14003 并进 `RATE_LIMIT_BUSINESS_CODE`**：两者的正确动作相反 ——
 * 6004 是「这个账号在这模型上的额度用完了」（换号有效、必须标记）；
 * 14003 是「这个模型此刻整体饱和」（换号**无益**、**不许**标记）。
 */
export const MODEL_SATURATION_BUSINESS_CODE = 14003

/**
 * 「模型饱和」的**自然语言兜底**判据。
 *
 * 与额度限流同理：码值由服务端下发，本地产物里没有硬编码
 * （实测搜 `14003` 在本仓库源码中零命中才敢新增），上游可能改用别的码值表达
 * 同一语义，故需要文案兜底。
 *
 * ⚠️ **关键词必须窄**：`busy` / `saturated` 这种泛词若不加限定，
 * 模型正文里恰好讨论「服务器繁忙」就会被误判。这里只认腾讯原话里的组合，
 * 且判据本身**要求 HTTP 状态码 ≥ 400**（见 {@link isModelSaturationError}）。
 */
const MODEL_SATURATION_PATTERN = /模型繁忙|请求量饱和|model\s+busy|currently\s+saturated/i

/**
 * 判断一次失败是否为**模型饱和**（上游背压），而非账号级额度限流。
 *
 * ## 为什么这个区分是**行为分叉**而不是措辞问题
 *
 * | | 额度限流 `6004` | 模型饱和 `14003` |
 * |---|---|---|
 * | 语义 | 该**账号**在该模型上额度用完 | 该**模型**此刻整体饱和 |
 * | 换号 | **有效**（别的账号有独立额度） | **无益**（所有账号撞同一堵墙） |
 * | 写限流标记 | **必须**（否则每轮重撞） | **绝对不许**（会把整池锁 1 小时） |
 * | 建议 | 等解禁 / 换账号 | **换模型** / 稍后重试 |
 *
 * 实测 `actions` 字段本身就写着 `SWITCH_MODEL` 而**没有**换号选项 ——
 * 服务端与我们的结论一致。
 *
 * ⚠️ **必须先于 `status === 429` 的无条件判定**：14003 恰恰是 429，
 * 若先判状态码就永远走不到这里（这正是缺陷的成因，见常量注释）。
 *
 * @param status - HTTP 状态码。为 `undefined`（只有文案可判）时仍检查业务码；
 *   但**文案分支要求状态码 ≥ 400** —— 否则一段正常正文里出现「模型繁忙」
 *   就会被判成错误。
 * @param body - 响应体（可能为空串）。
 */
export function isModelSaturationError(status: number | undefined, body: string): boolean {
  // 状态码已知且 < 400 ⇒ 这是正常响应，正文里的字样不算错误。
  if (typeof status === 'number' && status < 400) return false
  if (body.length === 0) return false
  try {
    const code = (JSON.parse(body) as Record<string, unknown>).code
    if (code === MODEL_SATURATION_BUSINESS_CODE
      || code === String(MODEL_SATURATION_BUSINESS_CODE)) return true
    // ⚠️⚠️ **结构化降级：报文自带「额度限流」业务码时，一律不判模型饱和**
    // （2026-10-17 对抗审计实测的真缺陷）。
    //
    // 本函数的**码值腿是权威的**，文案腿只是「上游可能改用别的码值」的兜底；
    // 因此当报文**明确给出了另一个已知业务码**时，那才是权威信号。
    //
    // 实测（buddy 额度限流）：`{"code":6004,"msg":"请求量饱和，请稍后再试"}`
    // → `MODEL_SATURATION_PATTERN` 的「请求量饱和」命中 ⇒ 判成**模型级**饱和。
    // 后果不是措辞问题，而是**行为分叉**（见上表）：
    // | | 额度限流 6004 | 误判成模型饱和 |
    // |---|---|---|
    // | 换号 | 有效 | 退化成「原账号退避重试」 |
    // | 写限流标记 | 必须 | **绝对不许** |
    // ⇒ 一个**额度已耗尽**的账号会被判成「换账号无效、换模型吧」，
    // 而池里其它账号的额度是独立的、可用。
    //
    // ⚠️ 为什么要**降级而不是直接 return false**：6004 之外的码还可能是别的语义
    // （上游新码 / 未知码），此时文案兜底仍有价值。故只在**已知对立法**（额度限流）
    // 成立时降级，未知码仍走文案腿。
    if (code === RATE_LIMIT_BUSINESS_CODE || code === String(RATE_LIMIT_BUSINESS_CODE)) {
      return false
    }
  } catch {
    // 非 JSON：交给文案兜底。
  }
  return MODEL_SATURATION_PATTERN.test(body)
}

/**
 * 结构化判定：响应体是可解析 JSON 且 `code` 为该业务码。
 *
 * 不采用「全文包含 6004」的写法：`requestId` 是 UUID，任意数字子串都可能
 * 偶然出现，文本匹配会产生假阳性；这里只认 JSON 顶层的 `code` 字段。
 * 兼容 `"6004"`（字符串）与 `6004`（数字）两种编码。
 */
function hasRateLimitBusinessCode(body: string): boolean {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const code = data.code
    return code === RATE_LIMIT_BUSINESS_CODE || code === String(RATE_LIMIT_BUSINESS_CODE)
  } catch {
    // 非 JSON：交给文案兜底
    return false
  }
}

/**
 * 判断错误文本是否为频率限制错误。
 *
 * @param body - 响应体（可能为空串）
 * @param status - HTTP 状态码（可选，但**手里有 Response 就必须传**）。为 `429`
 *   时无条件判为限流，即使响应体为空、不含任何可识别文案。
 *
 * ⚠️ **`status` 判据是真实缺陷的修复，不是可选便利**：本函数原先只接收响应体，
 * 而服务端（网关 / CDN / 限流中间件）完全可能返回**空体**的 429 —— 此时
 * `hasRateLimitBusinessCode` 与 `RATE_LIMIT_PATTERN` **双双不命中**，函数返回
 * `false`，于是适配器里整段「记录重置时间 + 切换账号」逻辑被**整体跳过**，
 * 把一个本可自愈的限流直接抛给用户（表现为「账号池里明明还有可用账号，插件却
 * 报错且不换号」）。
 *
 * 判据顺序刻意是「状态码优先」：429 是 HTTP 语义上**唯一**的限流信号，无需也不应
 * 再去猜文案；下面的文案 / 业务码兜底只服务于「状态码不是 429、但正文表达了限流」
 * 的场景（业务码 6004、SSE 流内错误、网关包装过的 200/400）。
 *
 * ⚠️ 反向的约束同样重要：**非 429 绝不能因为「有状态码」就判为限流** ——
 * 404「模型不存在」这类换号无益的错误若被识别成限流，会被吞成「所有账号均受限」，
 * 用户既看不到真实原因、插件还会白试一遍全池账号。
 */
export function isRateLimited(body: string, status?: number): boolean {
  if (status === 429) return true
  return hasRateLimitBusinessCode(body) || RATE_LIMIT_PATTERN.test(body)
}

/**
 * 重置时间的两种句式（中文 / 英文），并**捕获实际时区**而非硬编码 UTC+8。
 *
 * 中文（buddy 国内版）："您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置"
 * 英文（workbuddy 国际版）："... your usage will reset at 2026-09-17 09:09:36 UTC+8, alternatively, ..."
 *
 * 早期只列了中文句式，导致国际版即使判定为限流也只能走「1 小时后重试」的
 * 兜底，丢掉服务端给出的真实重置时刻（UI 限流徽章因此显示错误时间）。
 */
const RESET_TIME_PATTERN = /(?:将在|reset at)\s+([\d-]+\s+[\d:]+)\s+(UTC[+-]\d+(?::\d+)?)/i

/**
 * 限流文案里解析不出重置时刻时的**兜底时长**（1 小时）。
 *
 * 为什么需要兜底而不是「解析不到就不记标记」：网关 / CDN 返回的 429 常常既没有
 * 重置时间、甚至**没有响应体**，而标记是 UI「限额重置」徽章与「重测 / 重置」
 * 两条人工解禁路径的**唯一**依据 —— 静默跳过记录会让用户既看不到限流、也无从操作。
 *
 * ⚠️ 1 小时是**快照式**兜底（标记可被重测刷新），与 `BUDDY_POLICY_BLOCK_COOLDOWN_MS`
 * 的 30 分钟**语义不同**（那是「安全策略拦截」的本地冷却，报文里根本没有时间字段），
 * 也与 Qoder「按自然日 24:00」不同（那是按日的额度结算）。三者不要合并成一个常量。
 *
 * 导出是给 `buddy-adapter` 用的：它需要在**没拿到可解析体**时也能写出标记，
 * 且必须与这里 `parseRateLimitError` 的兜底**同值**，否则两处口径会漂。
 */
export const RATE_LIMIT_FALLBACK_MS = 3_600_000

/**
 * 额度耗尽的业务码（CodeBuddy 系实测值）。
 *
 * ⚠️ 与 {@link RATE_LIMIT_BUSINESS_CODE}（6004 = 频率限流）**不可合并**：
 * 两者动作相同但**冷却终点相反**（见 {@link isCreditExhausted} 的表）。
 */
export const CREDIT_EXHAUSTED_BUSINESS_CODE = 14018

/**
 * 额度耗尽的文案兜底判据（`14018` 的码值腿之外的唯一通道）。
 *
 * 上游原话（`www.workbuddy.ai`，HTTP 429）：
 * `Credits exhausted. Please visit the link below to purchase add-on packs…`
 *
 * ⚠️ **关键词必须窄**：`insufficient` 单独出现**过宽**（见
 * {@link isCreditExhausted} 的说明）。
 */
const CREDIT_EXHAUSTED_PATTERN =
  /credits?\s+exhausted|quota\s+exhausted|积分.{0,4}(?:不足|耗尽|用尽)|额度.{0,4}(?:不足|耗尽|用尽)|余额.{0,4}(?:不足|耗尽|用尽)/i

/**
 * 额度**耗尽**（不是频率限流）的判据 —— 「钱用光了」，不是「发太快」。
 *
 * ## ⚠️⚠️ 为什么必须与 {@link isRateLimited} 分开（真实缺陷，Gitee IKQ6HJ）
 *
 * 两者的**动作完全相同**（换号 + 写冷却标记），但**冷却终点的语义相反**：
 *
 * | | 频率限流（6004 / 429） | 额度耗尽（14018 / Credits exhausted） |
 * |---|---|---|
 * | 恢复方式 | 时间到了就恢复（分钟级滚动窗口） | **等次日配额 / 充值** |
 * | 冷却终点 | 服务端声明时刻，否则 +1h 兜底 | **UTC+8 当日 24:00** |
 * | 写成 +1h 的后果 | 无（本来就该 1 小时） | **每小时被重新选中一次、必然再失败** |
 *
 * 用户侧症状（原始报障）：「面板说可以用了，一试又不行」——面板的『限额重置』
 * 显示的是失败时刻 + 1 小时，到点后账号被重新选中，必然再失败一次，再写一条
 * 1 小时标记，**循环往复**。而真实出路是等次日配额或充值。
 *
 * ## 为什么是「UTC+8 当日 24:00」而不是「+24h」
 *
 * 与 `loomyCooldownResetAtMs`（Gitee IKL80H 那起事故）**同一条纪律**：
 * 额度按 UTC+8 自然日结算，用滑动 24h 会让 23:50 烧光的账号被封到**次日 23:50**
 * ——用户 0 点后上游明明已放行、插件仍说「没到重置时间」，白等近一整天。
 * 四家同口径的既有实现：`loomyCooldownResetAtMs` / `qoder-adapter` /
 * `zcode-adapter` / `llm-adapter` 的 codearts 分支。
 *
 * ## 判据刻意**窄**
 *
 * 只认 `14018` 码值与 `credits exhausted` 完整短语。**不收** `insufficient` 这类
 * 泛词 —— 上下文超长报文里的 `the context window is insufficient for this model`
 * 会被误伤，而那是「换号无益」的另一类失败（同类误伤在
 * `classifyLoomyFailure` / `classifyRaccoonFailure` 各踩过一次）；
 * 中文侧同样只收「额度/积分/余额 + 不足/耗尽」的**确定性组合**。
 *
 * ⚠️ **本函数只看响应体，不看状态码**：14018 实测回 **HTTP 429**，但它与
 * 频率限流共用 429 ⇒ 状态码对这一格**没有判别力**，只能靠码值/文案。
 *
 * @param body - 响应体（可能为空串）。
 */
export function isCreditExhausted(body: string): boolean {
  if (body.length === 0) return false
  // ① 结构化业务码：只认 JSON 的 `code` 字段（与 `hasRateLimitBusinessCode` 同一
  //    取舍 —— 全文搜 `14018` 会被 UUID 里的数字子串误命中）。
  //
  //    ⚠️ **必须同时认嵌套形态**：buddy 系的真实报文是
  //    `{"error":{"data":{"code":14018,"msg":"…"}}}`（码在**第二层**），
  //    只看顶层 `code` 会让码值腿在这家**恒不命中**、只剩英文文案腿 ——
  //    而上游一改文案就静默失效（同族教训：`channelVerificationUpstreamId`
  //    的注释记录了「判据认了某字段、出口却提不出该字段」的漂移）。
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const inner = typeof data.error === 'object' && data.error !== null
      ? data.error as Record<string, unknown>
      : undefined
    const nested = typeof inner?.data === 'object' && inner.data !== null
      ? inner.data as Record<string, unknown>
      : undefined
    const codes = [data.code, inner?.code, nested?.code]
    if (codes.some(code => code === CREDIT_EXHAUSTED_BUSINESS_CODE
      || code === String(CREDIT_EXHAUSTED_BUSINESS_CODE))) {
      return true
    }
  } catch {
    // 非 JSON：交给文案腿。
  }
  // ② 文案腿（网关包装过的 200/400、纯文本错误页、以及 `errorDetail` 产物）。
  return CREDIT_EXHAUSTED_PATTERN.test(body)
}

/**
 * 额度耗尽的冷却终点：**UTC+8 当日 24:00**。
 *
 * 与 {@link isCreditExhausted} 配套，供 `buddy-adapter` 的换号记账分支与
 * `account-probe` 的重测回写共用 —— **只留一份实现**，两处各算一次必然漂移
 * （本仓库首条红线「同一语义两套判据」）。
 *
 * ⚠️ **必须放在本文件（共享层）而不是某个渠道的适配器里**：`account-probe.ts`
 * 也要用它（重测时把同一时刻回传给存储），而探测层不得反向依赖某个渠道的
 * 适配器 —— `tests/unit/account-probe-adapter.spec.ts` 普遍
 * `vi.mock('../../src/buddy-adapter.js')`，形成依赖后那个 mock 会把该函数
 * 一起变成 `undefined`（Gitee IKQ6HJ 报告里记录的同一处陷阱）。
 *
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export function creditExhaustedResetAtMs(nowMs: number = Date.now()): number {
  return nextUtc8DayStartMs(nowMs)
}

/**
 * 只取**服务端显式声明**的重置时刻；解析不到就返回 `undefined`（**不兜底**）。
 *
 * ## 为什么必须与 {@link parseRateLimitError} 并存
 *
 * `parseRateLimitError` 的语义是「调用方需要一个可写的标记」，故它**必然**
 * 给出一个时刻（解析不到就 `+1h`）。而额度耗尽那一格需要区分
 * 「服务端真给了时刻」与「它压根没给」：
 *
 * - 服务端给了 ⇒ **以它为准**（上游比我们更清楚何时恢复）；
 * - 服务端没给 ⇒ 走 {@link creditExhaustedResetAtMs} 的 UTC+8 自然日，
 *   **不是** `+1h`。
 *
 * 两者混用会让 14018 继续落进 1 小时兜底（正是 Gitee IKQ6HJ 的缺陷形态）。
 *
 * @param body - 响应体（可能为空串）。
 * @returns 服务端声明的重置时刻（epoch ms），无则 `undefined`。
 */
export function explicitRateResetAtMs(body: string): number | undefined {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    // ⚠️ 只读 `msg`（与 `parseRateLimitError` **同源**：两句真实文案都写在该字段里）。
    // 若哪天上游把时刻挪到别的字段，两处必须**同批**改，不能只改一处。
    //
    // ⚠️ 嵌套形态也要认（`{"error":{"data":{"msg":"… reset at …"}}}`）：
    // 只读顶层会让本函数在 buddy 系的真实报文形态上恒为 `undefined` —— 那不会
    // 报错，只会静默退回自然日终点（「服务端给了时刻却不采用」）。
    const inner = typeof data.error === 'object' && data.error !== null
      ? data.error as Record<string, unknown>
      : undefined
    const nested = typeof inner?.data === 'object' && inner.data !== null
      ? inner.data as Record<string, unknown>
      : undefined
    const candidates = [data.msg, inner?.msg, nested?.msg]
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue
      const resetMatch = RESET_TIME_PATTERN.exec(candidate)
      if (!resetMatch) continue
      const resetMs = Date.parse(`${resetMatch[1]} ${resetMatch[2]}`)
      if (!Number.isNaN(resetMs)) return resetMs
    }
    return undefined
  } catch {
    // ⚠️⚠️ **非 JSON（纯文本）也必须扫一遍** —— 这不是兜底洁癖，是**真实主路径**
    // （对抗审计实测打穿的缺陷）：
    //
    // `account-probe.ts` 拿到的 `message` 是**适配器抛出的 `LlmError.message`**，
    // 而适配器早已把上游报文压平成纯文本：
    // `workbuddy: Credits exhausted. Your quota will reset at 2099-12-31 23:59:59 UTC+8`
    // ⇒ `JSON.parse` 必然失败 ⇒ 本函数恒 `undefined` ⇒ 探测腿永远退回自然日，
    // 而推理腿（拿**原始报文**）能取到显式时刻 ⇒ 两条腿对同一条报文算出两个值。
    //
    // 实测三格（同一份 `14018 + reset at 2099` 报文）：
    // | 输入形态 | 修前 | 修后 |
    // |---|---|---|
    // | 原始 JSON（推理腿） | 2099 | 2099 |
    // | 压平后的 message（探测腿） | **undefined** ⇒ 自然日 | **2099** |
    //
    // ⚠️⚠️ **「正常正文凑不出这个形状」这句断言已被实测证伪，别再引用它**
    // （对抗审计 2026-10-25 实测）：`'…配额将在 2099-12-31 23:59:59 UTC+8 重置…'`
    // 与 `'…will reset at 2099-12-31 23:59:59 UTC+8…'` **都能凑出**且 `Date.parse`
    // 正常解析 ⇒ 纯文本回退本身有误命中面。
    //
    // 当前**不可达**：两个调用点（推理腿 `buddy-adapter.ts` / 探测腿
    // `account-probe.ts`）都在 `isCreditExhausted(body)` 门禁**之内**，
    // 而上面那句纯限流正文实测 `isCreditExhausted = false` ⇒ 到不了扫描。
    //
    // ⚠️ 但这是**结构性**风险：门禁（本函数上方）与扫描（这里）分处两个函数，
    // 将来任何人放宽/重排门禁、或给第三条腿接 `explicitRateResetAtMs`，误命中会
    // **静默**打开。**新接调用点前先读这段**，并确认新路径同样有额度门禁。
    const bareMatch = RESET_TIME_PATTERN.exec(body)
    if (bareMatch !== null) {
      const bareMs = Date.parse(`${bareMatch[1]} ${bareMatch[2]}`)
      if (!Number.isNaN(bareMs)) return bareMs
    }
    return undefined
  }
}

/**
 * 从限流错误中提取重置时间；体里没有时间时返回 {@link RATE_LIMIT_FALLBACK_MS} 兜底。
 *
 * @param status - HTTP 状态码（可选）。为 `429` 时即使**体为空、或无任何可识别文案**
 *   也按兜底时长返回一条，避免调用方「识别出限流却没有标记可写」（见
 *   {@link RATE_LIMIT_FALLBACK_MS} 的说明）。
 */
export function parseRateLimitError(
  body: string,
  currentModel: string,
  status?: number,
): { modelId: string; resetTimeMs: number } | null {
  const fallback = (): { modelId: string; resetTimeMs: number } => ({
    modelId: currentModel,
    resetTimeMs: Date.now() + RATE_LIMIT_FALLBACK_MS,
  })
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const msg = typeof data.msg === 'string' ? data.msg : ''
    const resetMatch = RESET_TIME_PATTERN.exec(msg)
    if (resetMatch) {
      // 用捕获到的真实时区拼接（不再写死 UTC+8），Date.parse 能正确解析该写法。
      const resetMs = Date.parse(`${resetMatch[1]} ${resetMatch[2]}`)
      if (!Number.isNaN(resetMs)) {
        return { modelId: currentModel, resetTimeMs: resetMs }
      }
    }
    // 标准 OpenAI 429 格式，或带业务码但文案无法解析出时间
    if (isRateLimited(body, status)) {
      return fallback()
    }
    return null
  } catch {
    // 非 JSON（空体、纯文本、CDN 的 HTML 错误页）：只剩状态码可判。
    return status === 429 ? fallback() : null
  }
}
