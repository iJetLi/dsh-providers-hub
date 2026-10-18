/**
 * Raccoon Work LLM 适配器。
 *
 * ## 为什么复用 `openai-compat.ts`
 *
 * 实测 `POST /api/web/llm/v2/chat/completions` 是**标准 OpenAI 兼容 + 标准 SSE**
 * （`chat.completion.chunk` + `data: [DONE]`，无加密、无信封、无格式转换），
 * 与 Qoder / Loomy 同形，正是 `openai-compat.ts` 的适用场景。
 *
 * ⚠️ **不改 `openai-compat.ts` 的内部逻辑** —— 它当前服务 qoder 与 loomy；
 * raccoon 是第三个消费者。若实测发现字段形态不符，应在**本文件**内做局部适配，
 * 而不是改共享层（那会影响另外两个 provider 的既有行为）。
 *
 * ## 两个必须真的做到的点
 *
 * 1. **`tools` 必须下发到请求体顶层** —— Qoder 与 TRAE 都因漏发而让模型
 *    在正文里臆造 XML 工具调用、harness 认不出 → 任务终止。
 * 2. **`listAllModels()` 必须实现** —— 设置页要显示被关闭的模型及其倍率；
 *    缺了它会退化为裸 id（AGENTS.md 记录的真实缺陷）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { createModelCatalog, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import { isRaccoonExpired, type RaccoonCredential } from './raccoon.js'
import {
  RACCOON,
  RACCOON_DEFAULT_EFFORT,
  RACCOON_EFFORT_NAMES,
  RACCOON_EFFORT_OFF,
  RACCOON_EFFORT_ON,
  RACCOON_REASONING_EFFORTS,
  type RaccoonFallbackModel,
  type RaccoonProduct,
} from './raccoon-product.js'
import { projectRequestImage, type ImageRequestTarget } from './image-budget.js'
import { planSessionTitleThinking } from './session-title.js'
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

/** 本适配器注册的 provider 路由名（等价于 `RACCOON.id`）。 */
export const PROVIDER = 'raccoon'

/**
 * 把 DSH 的档位 id 映射成请求体的 `extra_body.thinking` 字段。
 *
 * ## 为什么是这个形态（实测确证，别改）
 *
 * 唯一**有效**的思考控制通道是 **`extra_body.thinking`**（Anthropic 风格对象），
 * 服务端报错原文确认其枚举：``expected one of `adaptive`, `enabled`, `disabled` ``。
 *
 * 实测（判据为服务端上报的 `reasoning_tokens`）：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | `extra_body.thinking={type:'disabled'}` | **6/6、8/8 全为 0** → 真关闭 |
 * | `extra_body.thinking={type:'enabled'}` | 均值 218 ≈ 基线 222 → 与默认等价 |
 *
 * ⚠️ **`reasoning_effort` 虽然被服务端接受（8 个枚举值），但实测无效果** ——
 * 8 轮配对实验里 `max - minimal` 正差 4 次 / 负差 4 次（纯随机），
 * 且 `none` 不关闭思考（均值 301 vs `disabled` 的 0）。
 * 故**不用它**表达档位，详见 `raccoon-product.ts` 的常量注释。
 *
 * ⚠️ **无效的写法**（都实测过）：`extra_body.enable_thinking`、
 * 双层 `extra_body.extra_body.*`、把 `thinking` 放**顶层**（不在 `extra_body` 内）、
 * `thinking.budget_tokens`（仅被格式校验）。
 *
 * ## 语义
 *
 * - 档位为 `off` → `{ thinking: { type: 'disabled' } }`（真的不产生思考内容）
 * - 其余（含 `on`）→ `{ thinking: { type: 'enabled' } }`
 *
 * ⚠️ **不传档位时返回 `undefined`**（不发该字段），保持服务端默认行为 ——
 * 实测默认就是开启，故与 `on` 等价，但**少发一个字段**更稳。
 *
 * @returns 要写进 `extra_body` 的对象；`undefined` 表示不发该字段。
 */
export function raccoonThinkingExtraBody(
  effort: string | undefined,
): { thinking: { type: 'enabled' | 'disabled' } } | undefined {
  if (effort === undefined || effort.length === 0) return undefined
  // 只有明确的「关闭」才关；未知档位一律按开启处理（宁可多思考，不可静默关掉
  // —— 用户看不到思考内容会以为模型坏了）。
  const type = effort === RACCOON_EFFORT_OFF ? 'disabled' : 'enabled'
  return { thinking: { type } }
}

/**
 * 从「已声明的档位」里挑出**默认档**（Issue IKLIDV 的方向取反修复）。
 *
 * ## 为什么单独抽成入参化的纯函数
 *
 * 原实现的兜底分支是 `RACCOON_REASONING_EFFORTS[0] ?? RACCOON_EFFORT_ON`
 * —— 把「数组第一项」当成了「默认档」。那个等价关系**只在旧顺序下偶然成立**
 *（`['on','off']` 的首项恰是 `on`）。顺序按强度序规整成 `['off','on']` 后，
 * 该分支会静默回退成 **`off`（关闭思考）**：与「实测服务端默认即开启」相反，
 * 且是无人察觉的行为变更。
 *
 * ⚠️ **该分支在生产里不可达**（`RACCOON_DEFAULT_EFFORT` 恒在列表内）
 * ⇒ 任何「喂真实常量」的断言都**恒真**，抓不到它。
 * 故这里把 `declared` / `preferred` 都做成**入参**，让用例能构造
 * 「首选档不在列表里」这一格，从而真正锁住兜底方向。
 *
 * ⚠️ 兜底值是**语义上正确的「开启」**，与顺序彻底解耦：
 * 有序数组的下标表达位置，不表达语义。
 *
 * ⚠️⚠️ **取舍（已实测，审计登记）**：兜底值 `RACCOON_EFFORT_ON` 可能**不在
 * `declared` 里**（若将来有人把该常量删掉）。那一刻新旧两种写法的失败形态不同：
 * - 旧式 `declared[0]`：返回值**恒在列表内**，但会静默给出 `off`（**错档**）；
 * - 本式：返回列表外的 `on` ⇒ `dsh-llm` 的 `normalizeModelInfo` 抛
 *   **`INVALID_MODEL_REASONING`**（**响亮报错**，实测确认）。
 *
 * 本函数**刻意选后者**：这是「静默给错档」与「响亮的配置错误」之间的取舍，
 * 而后者更容易被发现。⚠️ 又因该分支**生产不可达**（`RACCOON_DEFAULT_EFFORT`
 * 恒在列表内），这个取舍当前无任何现实影响 —— 记在这里是为了避免下一个人
 * 看到「返回值可能不在列表内」时误以为是漏了防御而改回去。
 *
 * @param declared - 该模型声明的档位 id。
 * @param preferred - 期望的默认档。
 * @returns `preferred`（若它确实被声明），否则为 `RACCOON_EFFORT_ON`（**可能不在
 *   `declared` 内** —— 见上方取舍）。
 */
export function raccoonDefaultEffort(
  declared: readonly string[],
  preferred: string,
): string {
  return declared.includes(preferred) ? preferred : RACCOON_EFFORT_ON
}

/**
 * 该模型在 UI 上可选的思考档位。
 *
 * ⚠️ **所有模型都返回同样两档** —— 实测 `extra_body.thinking` 是 **provider 级
 * 方言**，与模型无关。故不做 per-model 分派（那会是凭空猜测）。
 *
 * ⚠️ `defaultEffort` 必须落在 `efforts` 内 —— DSH 会直接拿它发请求，
 * 给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`。
 */
export function raccoonReasoningInfo(): {
  efforts: Array<{ id: ReturnType<typeof ReasoningEffortId>; name: string }>
  defaultEffort: ReturnType<typeof ReasoningEffortId>
} {
  const efforts = RACCOON_REASONING_EFFORTS.map((id) => ({
    id: ReasoningEffortId(id),
    name: RACCOON_EFFORT_NAMES[id] ?? id,
  }))
  const defaultEffort = ReasoningEffortId(
    raccoonDefaultEffort(RACCOON_REASONING_EFFORTS, RACCOON_DEFAULT_EFFORT),
  )
  return { efforts, defaultEffort }
}

/** 远端模型条目（已归一）。 */
export interface RaccoonRemoteModel {
  id: string
  /** **已规范化**的展示名（含倍率）。 */
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
}

/**
 * 只放行**安全正整数**。
 *
 * ⚠️ 远端是外部输入：`0` / 负数 / `NaN` 会让 DSH 在
 * `defaultMaxTokens` 的硬校验上抛 `INVALID_MODEL_MAX_TOKENS`，
 * **整轮对话起不来**（不是降级，是崩）。
 */
function positiveMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: RaccoonFallbackModel): RaccoonRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // 兜底表**声明**图片能力（它有该字段）；与 loomy 不同（那边兜底表没有该信息）。
    supportsImage: model.supportsImage,
  }
}

/** {@link RaccoonAdapter} 的构造选项。 */
export interface RaccoonAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<RaccoonCredential | undefined>
  /** 凭据失效时的处理（raccoon 有 refresh 端点，会真续期）。 */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<RaccoonRemoteModel[]>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /**
   * 读取图片附件的**请求版本**（按字节目标缩放后的字节）。
   *
   * ⚠️ 与 {@link readImage} 的错误契约相反：**不可用时要返回 `undefined`**
   * 而不是抛错，适配器据此回退原图。理由与桥接实现见
   * `src/index.ts` 的 `makeReadImageRequest`、`src/image-budget.ts` 的
   * `projectRequestImage`。
   *
   * 背景（issue !IKITT9 的 raccoon 变体）：该网关按**请求体字节**设限，
   * 实测 `HTTP_413: request body exceeds 10MB` —— 两张 2560×1600 的截图
   *（base64 后各 ≈3.9 MB）再加别的内容就可能被拒。
   */
  readImageRequest?: (
    attachment: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link RACCOON}。 */
  product?: RaccoonProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 远端目录**落地后**的通知回调（issue IKJVTF）。
   *
   * 由 `registerRaccoonLlm` 注入为 `broadcastCatalogChanged(ctx)`。适配器本身
   * 拿不到 `ctx`，故必须由接线层桥接（与 `readImage` 等回调同一模式）。
   *
   * ⚠️ 必要性：客户端 `ModelCatalogDirectory` 在 `status === 'ready'` 时**短路
   * 返回缓存**，只在宿主事件上 `refresh()`。没有本回调时，冷启动首拉失败
   * 缓存的**兜底表**会永久留在对话框里，远端目录真的落地也不重读。
   */
  onCatalogLoaded?: () => void
}

// ── 请求级账号轮换（2026-10-05，用户报障「余额用完一个号就卡死」）────────

/** 单次用户请求最多尝试的账号数（含首号）。与 buddy 的全池遍历同语义，设上限只为防病态池。 */
const RACCOON_MAX_ROTATE = 8
/** 额度耗尽的冷却兜底：raccoon 的额度错误没有可靠重置字段（与 trae 4008 同形），按日配额记 24h。 */
const RACCOON_QUOTA_COOLDOWN_MS = 24 * 3_600_000
/** 429 限流冷却：1 小时（与 trae soft-rate 同档）。 */
const RACCOON_RATE_LIMIT_COOLDOWN_MS = 3_600_000

/**
 * raccoon 的失败类别。**「要不要换号」与「要不要写冷却」是两件事**，
 * 由本分类分别决定（混为一谈曾酿成事故，见下）。
 *
 * | 类别 | 判据 | 换号？ | 写冷却？ |
 * |---|---|---|---|
 * | `quota` | `14018` / `Credits exhausted` / `insufficient` / 「积分·额度·余额 + 不足·耗尽」/ `quota exceeded`；HTTP 402 | ✅ | ✅ 24h（日配额） |
 * | `rate` | HTTP 429 | ✅ | ✅ 1h |
 * | `auth` | HTTP 401 / 403（如 `code=200003 authorization_verify_error`） | ✅ | ❌ **绝不写** |
 * | `other` | 其余 4xx（400 参数错等） | ❌ | ❌ |
 *
 * ## 为什么 `auth` 必须「换号但不写冷却」（真实事故，2026-10-06 凌晨）
 *
 * 上游网关对**全池**回 `401 + authorization_verify_error`（网关侧授权校验故障，
 * 与某个号的额度无关）。当时的实现把 401 也当「可换号」，且冷却时长写成
 * `status === 429 ? 1h : 24h` ⇒ 401 落到 **24h**，于是一次请求内的换号循环
 * 连试 6 个号、给每个都写了 24 小时 ⇒ 池内候选筛空 ⇒
 * **整个 provider 被封一天**（下一次请求报 `no usable credential; log in first`）。
 *
 * buddy 的既有实现正是分开的：只有限流类写标记，认证类只 `continue` 换号。
 * 认证失败是**账号态**（凭据失效），不是「该模型冷却」；写标记会让池把无辜
 * 账号长期排除，且把网关侧故障放大成全池不可用。
 */
export type RaccoonFailureClass = 'quota' | 'rate' | 'auth' | 'other'

/**
 * 判定失败类别（文案 + 状态码双通道，与 `isRateLimited` 同构）。
 *
 * ## ⚠️ 401/403 **必须先判**（PR !71 审计）
 *
 * 早期实现把文案判定放在状态码之前，于是 `403 + "insufficient permissions to
 * access this resource"` 被判成 `quota` ⇒ **给一个只是没权限的账号写 24 小时
 * 冷却**。这与 {@link RaccoonFailureClass} 记的 2026-10-06「全池被封」事故
 * **同型**（那次触发词是 `authorization_verify_error`，这次是
 * `insufficient permissions`）：认证类只换号、绝不写标记，是那次事故换来的
 * 不变式，不能被文案判据绕过。
 *
 * ⚠️ 顺序不能调换回去：把「先按文案判门禁、再解析」当通则会静默误伤 ——
 * 401/403 与额度文案并存时（网关侧故障常在报文里带余额提示）必须以状态码为准。
 *
 * ⚠️ **本函数与 `classifyLoomyFailure`（`src/loomy-adapter.ts`）是同一张判据表的
 * 两个实现，必须逐格同构**。真实教训（2026-10-06，**同型复发**）：本函数在
 * `7b524ff` 收窄后 loomy 那份**未同步**，于是同一报文
 * （`403 + insufficient permissions` / `403 + 积分不足` / `401 + 余额不足`）
 * 在 loomy 上仍判 `quota` ⇒ **给无辜账号写 24h 冷却**，在 raccoon 上判 `auth`。
 * 改动任一侧都必须同步另一侧，并跑 `tests/unit/loomy-adapter.spec.ts` 的
 * 「与 raccoon 对拍」段（同一批真实报文喂两个分类器，分叉即红）。
 */
export function classifyRaccoonFailure(errorText: string, status: number): RaccoonFailureClass {
  // 认证类先判：403 可能只是权限/授权问题，绝不能落到 quota 而被写 24h 冷却。
  if (status === 401 || status === 403) return 'auth'
  const lower = errorText.toLowerCase()
  const quotaText = lower.includes('14018')
    || lower.includes('credits exhausted')
    // ⚠️ `insufficient` 单独出现**过宽**（PR !71 审计实测误伤 5 类），必须与
    // 邻近的「钱」义词共现才算额度：上下文窗口超长（"context window is
    // insufficient for this model"）、数据不足等都与额度无关。
    // 方向仍是「宁可漏判不可误伤」—— 漏判只是不换号，误判会封可用账号 24h。
    || (lower.includes('insufficient')
      && ['point', 'credit', 'balance', 'quota', 'token'].some((w) => lower.includes(w)))
    || (lower.includes('积分') && (lower.includes('不足') || lower.includes('耗尽')))
    || (lower.includes('额度') && (lower.includes('不足') || lower.includes('耗尽')))
    || (lower.includes('余额') && (lower.includes('不足') || lower.includes('耗尽')))
    || (lower.includes('quota') && (lower.includes('exceeded') || lower.includes('exhausted')))
  if (quotaText || status === 402) return 'quota'
  if (status === 429) return 'rate'
  return 'other'
}

/**
 * 该失败是否值得「换下一个账号」重试。
 *
 * 可换：额度耗尽、限流、认证（另一号的 token 可能有效）。
 * 不可换：其余 4xx（400 参数错、404 路由错等）——换号无益，请求本身有问题，
 * 换谁都会失败；按原错误抛，避免吞成「均不可用」。
 */
export function shouldRotateRaccoonAccount(errorText: string, status: number): boolean {
  return classifyRaccoonFailure(errorText, status) !== 'other'
}

/**
 * 499「客户端断开」口径的统一抛出：归 aborted 形态，而非普通错误。
 *
 * 🔴 实测（2026-10-11，本会话多次）：raccoon 网关返回 **HTTP 499 + body
 * `client has aborted request`**（nginx「client closed request」＝ 连接在响应
 * 完成前被断开，多为**请求体过大/网关超时**）。旧路径把它包成普通
 * `LlmError`（code=httpErrorCode(499)）⇒ agent loop 按 name/code 归
 * `kind:'error'` ⇒ 终端显示「本轮运行失败」，用户误以为 provider 坏了。
 *
 * 归 **aborted** 的语义收益：
 * - 终端显示「已中止」而非「运行失败」（如实：请求没跑完，重发即可）；
 * - **不改道**：499 的真实成因多为请求体过大（长上下文），换号重发**照样 499**
 *   —— 改道只会烧光轮换预算；真正的恢复是压缩上下文（pressure-lane 的
 *   预警/compaction 兜底正是干这个的）。
 * ⚠️ 与 `aggregate-adapter.ts` 的 `isAbortLike` 第四条判据同口径（aborted
 * request|HTTP_?499）—— aggregate 侧判「要不要原样重抛」，本侧判「直接抛
 * 什么形态」，两处覆盖不同的到达路径（raccoon 是直接 provider，不经 aggregate）。
 *
 * ## ⚠️⚠️ 已知缺口：**只覆盖 HTTP 状态码路径，不覆盖 SSE 内嵌错误帧**
 *（2026-10-12 审计实测登记）
 *
 * 本函数只在**两个 HTTP 非 ok 的抛出点**被调用。而本文件末尾自己写着
 * 「业务失败也可能以 **HTTP 200 + SSE 内嵌错误帧**返回，由 `consumeOpenAiSse`
 * 处理」—— 那条路径**不经过这里**：
 *
 * ```
 * SSE 帧 {statusCodeValue:499, message:'client has aborted request'}（HTTP 200）
 *   → consumeOpenAiSse 抛 LlmError(code='SERVER')，name ≠ 'AbortError'
 *   → 外层判据 (signal.aborted || code==='ABORTED') === false
 *   → kind:'error' ⇒ 终端仍显示「本轮运行失败」
 * ```
 *
 * ⇒ 即**本修复的语义收益在 SSE 路径上没拿到**，两条路径口径不一致。
 *
 * ⚠️ **本分支不擅自扩大改动面**：修它要动 `src/openai-compat.ts` 的
 * `consumeOpenAiSse`（**所有 provider 共享**的错误归类层），影响面远超本次
 * 范围。故此处**如实登记**，留给维护者决定是否统一。
 * 若要修，正确的做法是在那一层也识别 499/`aborted request` 并抛 `ABORTED`
 *（而不是在 adapter 里再兜一层）。
 */
function abortLikeOrNormal(errorText: string, status: number): LlmError {
  const message = `raccoon: ${errorDetail(errorText)}`
  if (status === 499 || /aborted request|HTTP_?499/i.test(errorText)) {
    const e = new LlmError(message, 'ABORTED', { status })
    e.name = 'AbortError'
    return e
  }
  return new LlmError(message, httpErrorCode(status, message), { status })
}

/**
 * 该类别是否要写冷却标记。
 *
 * ⚠️ `auth` 不在其中 —— 见 {@link RaccoonFailureClass} 的事故说明。
 */
export function recordsRaccoonRateLimit(cls: RaccoonFailureClass): boolean {
  return cls === 'quota' || cls === 'rate'
}

/** Raccoon Work 模型适配器。 */
export class RaccoonAdapter extends LlmAdapter {
  private readonly product: RaccoonProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, RaccoonFallbackModel>
  /** 远端模型缓存；未拉取时为 undefined。 */
  private remoteModels: RaccoonRemoteModel[] | undefined
  /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
  private readonly catalogGate: RemoteCatalogGate
  /**
   * ⚠️ **2026-10-08 Task 7a：三个方法收敛到共享骨架** `createModelCatalog`。
   * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架
   * （实测与 `loomy` / `minimax` 归一化后逐字相同），现在只剩 `toCatalogEntry`。
   */
  private readonly catalog: ModelCatalog

  constructor(private readonly options: RaccoonAdapterOptions) {
    super()
    this.product = options.product ?? RACCOON
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
    // 目录落地后通知客户端重读（issue IKJVTF 的缺陷①）。
    this.catalogGate = new RemoteCatalogGate(
      options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded },
    )
    // ⚠️ 共享骨架（Task 7a）：门控 → 读目录 → 黑名单 → 回填 → 三态。
    this.catalog = createModelCatalog(
      { accountPool: options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        // ⚠️ 未知 id 保守报 ['text']（宁可少报能力，也不报服务端可能不认的模态）。
        unknownModelInputModalities: () => ['text'] as const,
        syncCatalog: () => this.syncCatalogEntries(),
      },
    )
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串，直接回退到本产品的 id。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），带最终展示名。
   *
   * 设置页需要它渲染被关闭的模型 —— 否则那些条目只能凭 `disabledMap` 的 key
   * 补回，而那条路径拿不到展示名，会退化成裸 id（倍率与模型名随之丢失）。
   *
   * ⚠️ **2026-10-08 Task 7a**：骨架（含上面这条理由）已上移到共享实现
   * `src/model-catalog.ts`，此处只剩委托。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.catalog.listAllModels()
  }

  /**
   * 把本家私有条目转成共享骨架的中间结构。
   *
   * ⚠️ 这里是**唯一**还认识「倍率格式」与 `supportsImage` 的地方 ——
   * 骨架不认识它们（各家格式不同）。
   */
  private toCatalogEntry(
    model: RaccoonRemoteModel,
    fallback: RaccoonFallbackModel | undefined,
  ): CatalogEntry {
    const contextWindow = model.contextWindow ?? fallback?.contextWindow
    const maxTokens = positiveMaxTokens(model.maxTokens ?? fallback?.maxTokens)
    return {
      id: model.id,
      name: model.name,
      // ⚠️ `resolveModel` 用**裸名**（与 qoder/trae/loomy 一致）：
      // 价格只属于选择列表语境。本家原本用 `replace(/ · .*$/, '')`。
      bareName: model.name.replace(/ · .*$/, ''),
      // ⚠️ 三态：本家远端条目**总是**带 `supportsImage` 布尔 ⇒ 恒为数组。
      inputModalities: model.supportsImage === true ? ['text', 'image'] : ['text'],
      ...contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {},
      ...maxTokens !== undefined ? { maxTokens } : {},
      // 思考档位（两态：深度思考 / 关闭思考）。实测确证见 `raccoonReasoningInfo`。
      // ⚠️ 所有模型一致 —— `extra_body.thinking` 是 provider 级方言，与模型无关。
      reasoning: raccoonReasoningInfo(),
    }
  }

  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    const all = await this.loadModels()
    return all.map((model) => this.toCatalogEntry(model, this.fallbackIndex.get(model.id)))
  }

  private syncCatalogEntries(): readonly CatalogEntry[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => this.toCatalogEntry(model, this.fallbackIndex.get(model.id)))
  }

  /**
   * 取远端模型目录；**失败时不把兜底表写进缓存**。
   *
   * ⚠ 原实现是 `this.remoteModels = fallback; return fallback` —— 把兜底表当成
   * 「已加载」记下，于是一次瞬时失败会让该 provider **整个进程生命周期**都只剩
   * 兜底模型（用户看不到自己的模型，且无从触发重试，只能重启）。
   * 改为：只缓存**真实远端目录**，兜底表每次现算（纯本地、零成本），
   * 并用 {@link RemoteCatalogGate} 的冷却挡住「每模型重试一次」的放大。
   */
  private async loadModels(): Promise<RaccoonRemoteModel[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    const fetchRemote = this.options.fetchRemoteModels
    if (fetchRemote !== undefined) {
      await this.catalogGate.run(async () => {
        const fetched = await fetchRemote()
        if (fetched.length === 0) return false
        this.remoteModels = fetched
        return true
      })
      if (this.remoteModels !== undefined) return this.remoteModels
    }
    return this.product.fallbackModels.map(fallbackToRemote)
  }

  private inputModalitiesFor(model: RaccoonRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(_provider)
  }

  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolveModel(provider, model, signal)
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法。与其余适配器同款 shim。
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
    // 图片能力按**模型**判定。不能放宽成「总是接受」：DSH 在 LlmRuntime 里
    // 按适配器播报的 `inputModalities` 决定要不要把图片投影成文本占位符，
    // 声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(`raccoon: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('raccoon: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        // ⚠️ 先试**请求版本**：这家网关按请求体字节设限（实测
        // `HTTP_413: request body exceeds 10MB`），原图直发时两张大截图
        // 就能把配额吃掉大半。拿不到（老宿主 / 拒绝投影 / 缺尺寸）就回退原图。
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

    // 1. 取凭据（过期则先续期）
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isRaccoonExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('raccoon: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }
    /**
     * 当前请求实际使用的账号 id（请求级轮换的记账键）。
     *
     * ⚠️ 语义与 buddy 的 `currentAccountId` 同款：凭据来自池时按
     * `findAccountIdByCredential` 反查；来自单凭据兜底（池空/旧安装）时
     * 保持空串——此时轮换自然失效（没有池就没有「下一个号」），行为与
     * 旧版一致，不会误标。
     */
    let activeAccountId = ''
    if (this.options.accountPool) {
      try {
        // 第二参是「凭据唯一标识」字段值（raccoon 用 access_token，与 buddy 系同键）。
        activeAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id, credential.access_token,
        ) ?? ''
      } catch { /* 反查失败不阻断主路径：轮换退化为「不标记」 */ }
    }

    const messages = serializeMessages(options.messages, imageUrls)

    /**
     * 前置 system 消息（若有）。
     *
     * ⚠️ 必须**先拼再放进对象**，不要在对象字面量里写两次 `messages` ——
     * 后者依赖「后面的键覆盖前面」这一隐式行为，读者极易误判成漏了 system。
     */
    const wireMessages = options.system !== undefined && options.system.length > 0
      ? [{ role: 'system', content: options.system }, ...messages]
      : messages

    /**
     * 思考档位 → `extra_body` 内容。
     *
     * ⚠️ 在 `buildBody` **之外**算一次：`buildBody` 会在重试时被多次调用，
     * 每次重算虽无害但没必要。
     *
     * ⚠️ **会话自动命名（`purpose: 'session-title'`）必须关闭思考**（issue
     * IKKVDH）：DSH 用 **64 token** 发标题请求且**不传 `reasoningEffort`**，
     * 而宿主会把本模型的默认档（本家恒为 `'on'`）注入进来
     * （`effective = requested ?? reasoning.defaultEffort`）。照常开思考时实测
     * 均值约 222 个思考 token，必然顶穿 64 ⇒ 正文 0 字符、
     * `finish_reason:'length'` ⇒ DSH 直接拒绝、标题永远停在 fallback。
     *
     * 本家的档位表是**恒声明的两档**（`on`/`off`，与模型无关，见
     * `raccoon-product.ts`）⇒ 任何模型都**关得掉**，故不需要抬预算。
     */
    const titlePlan = planSessionTitleThinking({
      purpose: options.purpose,
      requestedEffort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      declaredEfforts: RACCOON_REASONING_EFFORTS,
      maxTokens: options.maxTokens,
    })
    const thinking = raccoonThinkingExtraBody(titlePlan.effort)

    /** 构造请求体。 */
    const buildBody = (): string => JSON.stringify({
      model: options.model,
      messages: wireMessages,
      stream: true,
      ...titlePlan.maxTokens !== undefined ? { max_tokens: titlePlan.maxTokens } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
      // ⚠️ tools 必须真的下发到请求体**顶层**：Qoder/TRAE 都因漏发而让模型
      // 在正文里臆造 XML 工具调用，harness 认不出 → 任务终止。
      ...options.tools !== undefined && options.tools.length > 0
        ? {
            tools: options.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                ...tool.description.length > 0 ? { description: tool.description } : {},
                ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
              },
            })),
          }
        : {},
      // 思考档位（开 / 关）。⚠️ **必须在 `extra_body` 内** —— 实测放顶层会被忽略
      //（连非法值都不报错）。不传档位时不发该字段，保持服务端默认（= 开）。
      ...thinking !== undefined ? { extra_body: thinking } : {},
    })

    const headers = (): Record<string, string> => ({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential?.access_token ?? ''}`,
      'X-Org-Code': credential?.office_identity ?? '',
      'X-Raccoon-Language': 'zh',
      'X-Client-Platform': this.product.clientPlatform,
    })

    /** 发送一次 chat 请求。 */
    const send = async (): Promise<Response> => {
      try {
        return await this.fetchImpl(
          `${this.product.apiBase}${this.product.llmApiPrefix}/chat/completions`,
          {
            method: 'POST',
            headers: headers(),
            body: buildBody(),
            signal: options.signal,
          },
        )
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `raccoon: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    let response = await send()
    // 401/403 时续期一次并重试（raccoon 有 refresh_token 轮换）。
    if (response.status === 401 || response.status === 403) {
      await this.options.refresh()
      const refreshed = await this.options.resolveCredential(options.model)
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('raccoon: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      // ⚠️ **必须跟着重新反查账号 id**（PR !71 审计发现）：`resolveCredential`
      // 是「池优先」的（`src/index.ts` 的 raccoon 分支先 `getAvailableAccount`
      // 再回退单凭据 ref），而 `refresh()` 续期的是**默认单凭据 ref**。
      // ⇒ 续期后取回的凭据**可能属于另一个账号**，但 `activeAccountId` 还停在
      // 刷新前的那个号上。
      // 后果（实测可复现）：A 的 token 过期 → 刷新后拿到 B 的凭据 → B 随后
      // 返回额度耗尽，而冷却标记却**记在 A 头上** ⇒ 没耗尽的 A 被封 24h，
      // 真该封的 B 下次仍被选中（本段要修的「卡死在一个号上」照旧）。
      // 这与 AGENTS.md 记的 Qoder「标记用了会变的回调导致标错账号」同型。
      if (this.options.accountPool) {
        try {
          activeAccountId = await this.options.accountPool.findAccountIdByCredential(
            this.product.id, refreshed.access_token,
          ) ?? ''
        } catch { /* 反查失败不阻断主路径：轮换退化为「不标记」 */ }
      }
      response = await send()
    }

    if (!response.ok) {
      let errorText = await response.text().catch(() => '')
      let status = response.status
      /**
       * 请求级账号轮换（2026-10-05，用户报障「余额用完一个号就卡死」）。
       *
       * ## 为什么必须有这一段
       *
       * `resolveCredential` 从池里取号按**手动顺序**（`getAvailableAccount`
       * 的既有语义），失败类别不写标记时，下次请求取回的**仍是同一个号**。
       * 首号余额耗尽（`14018 Credits exhausted`）→ 错误抛给 harness →
       * 下次请求还是它 ⇒ 用户看到的是「卡死在一个号上」，池里其余账号
       * 完好却永远轮不到。
       *
       * ## 语义对齐 buddy（本项目无感换号的基准实现）
       *
       * - **可换号**的失败类别：余额/额度耗尽（14018 / Credits / quota /
       *   积分不足等）、限流（429）、认证（401/403——单号凭据失效时池里
       *   可能有别的好号）；**非额度且非限流**（400 参数错等）换号无益，
       *   按原错误抛（避免把「请求本身有问题」吞成「均不可用」）。
       * - **每个账号只试一次**：`tried` 传给 `getAvailableAccount`——不排除
       *   会拿回同一个号（池排序不因失败而变），换号形同虚设。
       * - **只有配额 / 限流类才写冷却**（`recordsRaccoonRateLimit`）：
       *   认证类（401/403）**只换号、绝不写标记** —— 详见
       *   {@link RaccoonFailureClass} 记的 2026-10-06 全池被封事故。
       * - **全部试完才报错**，且带**最后一次**的真实原因——笼统的
       *   「所有账号均不可用」会丢掉服务端真正说的东西（buddy 上同款教训）。
       * - **冷却时长按类别**：`quota` 记 24 小时（日配额；无可靠重置字段，
       *   与 trae 4008 同形）、`rate` 记 1 小时。
       */
      let failureClass = classifyRaccoonFailure(errorText, status)
      const accountPool = this.options.accountPool
      if (accountPool && failureClass !== 'other') {
        const tried = new Set<string>()
        if (activeAccountId) tried.add(activeAccountId)
        const markCurrentAccount = async (): Promise<void> => {
          // 每次失败后立即记账，包括轮换预算用尽的最后一个账号。
          // 认证错误只换号，不写模型冷却。
          if (!activeAccountId || !recordsRaccoonRateLimit(failureClass)) return
          await accountPool.updateModelRateLimit(
            activeAccountId,
            options.model,
            Date.now() + (failureClass === 'rate'
              ? RACCOON_RATE_LIMIT_COOLDOWN_MS
              : RACCOON_QUOTA_COOLDOWN_MS),
          )
        }
        await markCurrentAccount()
        const maxRotate = RACCOON_MAX_ROTATE - 1
        for (let round = 0; round < maxRotate; round++) {
          const next = await accountPool.getAvailableAccount<RaccoonCredential>(
            this.product.id, options.model, tried,
          )
          if (!next || tried.has(next.entry.id)) break
          tried.add(next.entry.id)
          credential = next.credential
          activeAccountId = next.entry.id
          response = await send()
          if (response.ok) {
            // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回（既有说明见下）。
            yield* consumeOpenAiSse(response, { signal: options.signal }, {
              label: 'raccoon',
              firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
              chunkTimeoutMs: resolveChunkTimeoutMs(),
              ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
            })
            return
          }
          errorText = await response.text().catch(() => '')
          status = response.status
          failureClass = classifyRaccoonFailure(errorText, status)
          await markCurrentAccount()
          if (failureClass === 'other') {
            // 新账号失败但不是可换号类别：按原错误分类抛出（buddy 同款）。
            throw abortLikeOrNormal(errorText, status)
          }
        }
        throw new LlmError(
          `raccoon: 模型 ${options.model} 所有账号均不可用（${errorDetail(errorText)}）`,
          failureClass === 'rate' ? 'RATE_LIMIT'
            : failureClass === 'auth' ? 'AUTH'
              : 'QUOTA_EXCEEDED',
          { status },
        )
      }
      throw abortLikeOrNormal(errorText, status)
    }

    // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回，由 consumeOpenAiSse 处理。
    yield* consumeOpenAiSse(response, { signal: options.signal }, {
      label: 'raccoon',
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs(),
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    })
  }
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_RACCOON_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_RACCOON_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/**
 * 在 `ctx.llm` 上注册 raccoon provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerRaccoonLlm(ctx: Context, options: RaccoonAdapterOptions): RaccoonAdapter {
  const product = options.product ?? RACCOON
  const adapter = new RaccoonAdapter({
    ...options,
    // ⚠️ 注入**唯一**的广播实现（`src/catalog-broadcast.ts`），不要在这里
    // 另写一份 emit —— 两份实现必然漂移（issue IKJVTF 的缺陷① 就是「十处全漏」）。
    onCatalogLoaded: () => broadcastCatalogChanged(ctx),
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
