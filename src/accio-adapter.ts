/**
 * Accio（阿里 Accio Work）LLM 适配器。
 *
 * 骨架取自 `src/trae-adapter.ts` / `src/lobsterai-adapter.ts`（`LlmAdapter` 子类 +
 * `createModelCatalog` 共享目录骨架 + `prepareCall` 包装），但**协议层完全不同**：
 *
 * | 项 | Accio | Trae / LobsterAI |
 * |---|---|---|
 * | 信封 | Gemini 风格（`contents` / `parts` / `system_instruction`），键 **snake_case** | OpenAI 风格 |
 * | 鉴权 | **token 在 body**（放 `Authorization` 头恒流内 402） | Bearer / Cloud-IDE-JWT |
 * | 响应 | 顶层 `content.parts[]` + `thought` 标记 | OpenAI SSE / SOLO 自定义事件 |
 * | 签名 | **不需要**（实测不带 `pctb-x-*` 同样 200） | 无 / WASM 加密 |
 *
 * ## 复用边界
 *
 * - 帧归一化与消费：`src/accio-messages.ts` 的 `consumeAccioSse`（内部复用
 *   `consumeGeminiSse`）。本文件**不重写** SSE 解析。
 * - 目录解析：`normalizeAccioModel` / `parseAccioCatalog` 的**唯一实现**在
 *   `src/accio-auth.ts`，本文件只 `import` 并**再导出**（兼容导入路径）——
 *   「同一语义两套判据」是本仓库首条红线。
 *
 * ## ⚠️ 三处**实测**修正（2026-10-13，真实凭据，唯一变量对照）
 *
 * 1. **`system_instruction` 必须是字符串**（⚠️ **源头已修**，本条只留作背景）。
 *    `buildAccioBody` **初版**产出 Gemini 风格对象 `{parts:[{text}]}`，实测**恒**回
 *    `HTTP 200 + 流内 {"error_code":"400","error_message":"Invalid request format"}`；
 *    同一文本改成字符串则 200。官方客户端 proto 里该字段本就是 `string`。
 *    ⚠️ 该纯函数已由 **commit `3034d03`** 修正为直接产出**字符串**，
 *    `tests/unit/accio-product.spec.ts` 也同步锁定**字符串**形态。
 *    ⇒ {@link AccioAdapter.stream} 里对 `system_instruction` 的改写**保留为
 *    纵深防御**（不改写也正确；把「wire 上该键必为字符串」这条硬约束显式写在
 *    适配器里，纯函数或上游形状若再次漂移仍能兜住）。**刻意不删。**
 *
 * 2. **工具调用是分片的，且共享消费者不合并**。上游把**一次**调用拆成多帧
 *    （首帧 `{id,name}` 无参数，后续帧**重复完整的** `args_json`）。
 *    `consumeAccioSse` 对每个 `functionCall` part 各产出一个**独立**的
 *    tool-call 块 ⇒ 一次调用会变成 N 个块（首个参数 `{}`），harness 会
 *    **执行 N 次**。合并职责归适配器（设计如此）⇒ 见
 *    {@link accioToolCallMergeTransform}。
 *
 * 3. **思考关不掉**。`includeThoughts` / `thinkingBudget` / `thinkingLevel` /
 *    `reasoningEffort` 四类字段逐格实测：思考字符数**一个都没变**
 *    （`reasoningEffort=off` 甚至回 505）。⇒ 会话命名只能走
 *    `planSessionTitleThinking` 的**抬预算**兜底（issue IKKVDH）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { createModelCatalog, isCatalogFreshFor, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
// ⚠️ 对外 id 的归一规则**必须与聚合共用**（见 `accioModelIdOf` 的注释）。
import { normalizeNameKey } from './canonical-models.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { reportLedgerAccount } from './token-ledger.js'
import { planSessionTitleThinking } from './session-title.js'
import {
  ACCIO,
  ACCIO_LLM_PATH,
  ACCIO_REQUEST_TIMEOUT_MS,
  type AccioFallbackModel,
  type AccioProduct,
} from './accio-product.js'
import {
  accioHeaders,
  accioRequestId,
  accioSgK,
  buildAccioBody,
  isAccioExpired,
  type AccioCredential,
} from './accio.js'
import {
  ACCIO_IMAGE_PIXEL_BUDGET,
  consumeAccioSse,
  isAccioErrorFrame,
  serializeAccioMessages,
  toAccioTools,
} from './accio-messages.js'
import { normalizeHarnessMessages } from './message-shape.js'
// ⚠️ 额度冷却终点复用**仓库唯一实现**（UTC+8 当日 24:00），与 zcode / qoder /
// codearts / loomy 同款。**不**自己算「现在 + 24h」—— 那是 IKL80H 记过的
// 「滑动 24h 让 0 点后仍报未到重置时间」缺陷。
import { nextUtc8DayStartMs } from './model-queue.js'
// ⚠️ 图片守卫必须复用**共享的递归收集器**（它按 `tool-result` 递归下钻）——
// 本仓库其余适配器（buddy / lobsterai / trae / gemini / cline / qoder / …）全部走它，
// 不在这里手写第三份判据（「同一语义两套判据」是首条红线）。
import { collectImages, detailFieldText } from './openai-compat.js'
// ⚠️ 像素预算与「取请求版本」投影同样复用共享实现（issue IKLR7V 的接线建议）。
import { projectRequestImage } from './image-budget.js'
import { resolveToolPairing } from './sse.js'
// ⚠️ 目录解析的**唯一实现**在 `accio-auth.ts`（`AccioAuth.fetchModels` 用的就是它们）。
// 本文件只再导出，**不写第二份** —— 否则就是本仓库红线「同一语义两套判据」。
import { normalizeAccioModel, parseAccioCatalog } from './accio-auth.js'

export { normalizeAccioModel, parseAccioCatalog }

/** 本适配器注册的 provider 路由名。 */
export const ACCIO_PROVIDER = 'accio'

/**
 * SSE 空闲超时（毫秒）。
 *
 * ⚠️ 与 `ACCIO_REQUEST_TIMEOUT_MS`（30s，整个请求的上限）**不是一回事**：
 * 这里是「多久没有新字节就认定流卡死」。上游生成大工具参数期间可能长时间不
 * flush，裸 `reader.read()` 会无限期挂起（症状「发消息后永远转圈」）。
 * 归 `TIMEOUT`（可重试）。
 */
export const ACCIO_SSE_IDLE_TIMEOUT_MS = 120_000

/**
 * 单次用户请求最多尝试的账号数（含首号）。
 *
 * ⚠️ 与 loomy / raccoon / minimax 同语义，设上限**只为防病态池**：正常情况下
 * `tried` 集合本身就有界（池里没有未试过的账号时 `getAvailableAccount` 返回
 * `null` ⇒ 循环自然终止），这条是第二道闸。
 */
const ACCIO_MAX_ROTATE = 8

/** 429 限流冷却：1 小时（与 loomy / raccoon / trae soft-rate 同档）。 */
const ACCIO_RATE_LIMIT_COOLDOWN_MS = 3_600_000

/**
 * 进程内稳定的 `utdid`（设备标识）兜底值。
 *
 * ⚠️ **实测上游不校验它**：真机值、自造值、完全不带、空串四种情况下
 * 上游都返回正常内容帧。故一个进程内稳定的本地值即可满足协议形状。
 * Task 7 的接线层可从 `~/.accio/utdid` 注入真实值（`options.utdid`）。
 *
 * 形状对齐实测值（24 字符、base64url 字符集）。
 */
const FALLBACK_UTDID = `accio-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`

/**
 * 工具结果内嵌图片被提升为独立 user 消息时，加在它前面的说明文字。
 *
 * ⚠️ **不可省**：`functionResponse` 只吃字符串、没有承载图片的位置，所以内嵌图
 * 只能挂到 `role:'tool'` 之后。而一张**没有任何上下文**的图片会让模型无从判断
 * 它是「工具的输出」还是「用户新发的内容」—— 本常量就是那句上下文
 * （与 `trae-adapter.ts` 的 `TOOL_RESULT_IMAGE_TEXT` 同一用途）。
 */
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/**
 * 把 `modelDisplayName` 与**计费倍率**拼成展示名：`模型名 · x倍率`。
 *
 * ## 为什么倍率必须进 `name`（不是 `description`）
 *
 * composer 的模型切换菜单**只渲染 `name`**（`description` 完全不读）——
 * 倍率写进 description 等于没写。倍率跨度 0.013 ~ 2.8（**215 倍**），
 * 是用户选型时最重要的信号。
 *
 * ## 三条边界
 *
 * - **倍率 1 照拼**（`1` 不是「无」）；
 * - **倍率 0 照拼**（免费是**合法**倍率，与「没有倍率信息」语义不同，
 *   故判据必须是 `!== undefined` 而不是真值判断）；
 * - **非有限值不拼**（不产出 `xNaN` / `xInfinity`）。
 *
 * 安全性：`name` 纯属展示 —— DSH 的选择与持久化只用 `id`。
 */
export function displayNameOfAccioModel(model: { name: string; multiple?: number }): string {
  const multiple = model.multiple
  if (multiple === undefined || !Number.isFinite(multiple)) return model.name
  return `${model.name} · x${multiple}`
}

/**
 * 把一个 accio 模型条目映射成 DSH 的**思考档位声明**；无可声明时返回 `undefined`。
 *
 * ## ⚠️ 核心判据：`efforts` 为空但 `defaultEffort` 有值时，也要**声明一档**
 *
 * 用户要求原文：「需要有档位**即使是只有一档也要显示**，使用远端真实下发的档位」。
 *
 * 远端实测（38 条）：只有 7 条给了 `reasoningEfforts` 数组；而 **5 条只给了
 * `defaultReasoningEffort`、数组是 `null`**（GLM-5.3 `max` / GLM-5.2 `max` /
 * GLM 5.3 Flash `max` / DeepSeek V4.1 Flash `high` / DeepSeek V4 Pro `high` /
 * MiniMax M3 `adaptive`）。⚠️ 这几个的 default **实测发过去服务端接受**
 * （`max` 与 `adaptive` 都 ✅ 返回正常正文）⇒ 它就是一个**真实可用的档位**。
 *
 * ⇒ 三格判据（**顺序不可换**）：
 *
 * | 形态 | 声明 |
 * |---|---|
 * | `efforts` 非空 | 全部档位；`defaultEffort` **落在集合内才带**（DSH 会校验，指到集合外会抛 `UNSUPPORTED_REASONING_EFFORT`） |
 * | `efforts` 空、`defaultEffort` 有值 | **单档**（就声明那一个） |
 * | 两者都无 | **不声明**（`undefined`）—— 编造档位 = 让用户选一个服务端不认的值 |
 *
 * ## 显示名
 *
 * ⚠️ **原样用上游的档位 id 当 `name`**，不做「low→低」这类翻译：
 * - 这些 id 是**服务端认的字面量**（要原样回发），译成中文会让用户
 *   在排查时对不上日志；
 * - 本仓库既有先例：`cline` 的档位用 `CLINE_REASONING_EFFORTS` 的**固定英文名**
 *   （`Low` / `Medium` / …）—— 名字属于**展示层契约**，而 accio 的 id 本身
 *   已经是可读英文，无需再造一份映射表（造了就有「两处判据」腐坏风险）。
 */
export function accioReasoningOf(
  model: Pick<AccioFallbackModel, 'efforts' | 'defaultEffort'>,
): NonNullable<CatalogEntry['reasoning']> | undefined {
  const declared = model.efforts ?? []
  const fallback = model.defaultEffort
  // ── 格 1：远端给了档位数组（可能同时给 default） ──
  if (declared.length > 0) {
    return {
      efforts: declared.map((id) => ({ id: ReasoningEffortId(id), name: id })),
      // ⚠️ `defaultEffort` **必须落在 `efforts` 内**才带：DSH 会校验，
      //    指到集合外会让整条记录的档位声明被丢弃（`model-catalog.ts` 里那段
      //    `legal` 检查）—— 那不是崩溃，但会让「默认档」静默消失。
      ...fallback !== undefined && declared.includes(fallback)
        ? { defaultEffort: ReasoningEffortId(fallback) }
        : {},
    }
  }
  // ── 格 2：只有 default（数组是 null）⇒ **单档**（用户要求的「只有一档也要显示」）──
  if (fallback !== undefined) {
    return {
      efforts: [{ id: ReasoningEffortId(fallback), name: fallback }],
      defaultEffort: ReasoningEffortId(fallback),
    }
  }
  // ── 格 3：两者都无 ⇒ 不声明（不编造） ──
  return undefined
}

/**
 * 一个 accio 模型条目的**对外 id**（DSH 目录里的 `id`，也是注入给模型的身份）。
 *
 * ## 为什么必须是「人话」（用户要求，2026-10-13）
 *
 * 用户追问（附模型自报截图）：「为什么现在还是回复中的模型不是标准模型 id」。
 *
 * 上游 `modelCode` 形如 `1Drift-F8hS3mK7pL2n` —— **故意不可读**的内部代号，
 * 真名只在 `modelDisplayName` 里。而 DSH 把 `CatalogEntry.id` 注入给模型当身份
 * ⇒ 模型只能自报一串乱码（它自己也无从知道那是哪个基座）。
 *
 * ⇒ 对外 id 改用**展示名归一后的 slug**（`qwen-3-8-flash`）。
 *
 * ## ⚠️ 与聚合**共用同一套归一规则**
 *
 * 用 `normalizeNameKey`（`canonical-models.ts`），**不自己写第二份**：
 * 聚合的规范键就是这么算的，两处若各写一份必然漂移 —— 而漂移的后果是
 * 「直连看到的 id」与「聚合里的键」对不上，用户无法把两处对应起来。
 *
 * ## ⚠️ 兜底：归一后为空时回退原始 id
 *
 * 展示名可能是空白 / 只由分隔符组成（`'·'`）⇒ 归一后得空串 ⇒ 若原样返回，
 * DSH 的目录校验会因**空 id** 抛 `INVALID_CATALOG`，**整个 provider 不可用**。
 * ⇒ 宁可回退成一个不可读但非空的 id（与改造前行为一致），也不产出空串。
 */
export function accioModelIdOf(model: Pick<AccioFallbackModel, 'id' | 'name'>): string {
  const slug = normalizeNameKey(model.name)
  return slug === '' ? model.id : slug
}

/**
 * 由**对外 slug** 反查上游 `modelCode`（上行请求必须用它）；查不到则**原样返回**。
 *
 * ⚠️ **上行绝不能发 slug**：Accio 的推理端点只认 `modelCode`，发 slug 会请求打空，
 * 而症状是「模型不回复」这种极具误导性的形态。
 *
 * ⚠️ **查不到时原样返回入参**（不抛错、不返回空串）：
 * - 用户可能手填一个 id（DSH 允许），此时应由**上游**报错，而不是在这里
 *   静默变成空模型名（那会让请求发到一个空 `model` 字段）；
 * - 抛错则会把这个未知 id 变成一次**本地失败**，掩盖上游的真实错误信息。
 */
export function accioModelCodeOf(
  models: readonly Pick<AccioFallbackModel, 'id' | 'name'>[],
  slug: string,
): string {
  const hit = models.find((model) => accioModelIdOf(model) === slug)
  return hit === undefined ? slug : hit.id
}

/** 解析 `AccioAdapter` 的构造选项。 */
export interface AccioAdapterOptions {
  /**
   * 解析本轮要用的凭据。
   *
   * ⚠️ 入参是**本轮要用的模型 id**：多账号池的选号会按它过滤限流账号，
   * 传空串会让限流过滤整体短路（与 `TraeAdapterOptions.resolveCredential` 同因）。
   */
  resolveCredential: (modelId?: string, sessionId?: string) => Promise<AccioCredential | undefined>
  /** 静默续期凭据（过期 / 401 时调用）。 */
  refresh: () => Promise<void>
  /** 动态拉取远端模型目录；失败或未登录时回退 `product.fallbackModels`。 */
  fetchRemoteModels?: () => Promise<AccioFallbackModel[]>
  /** 注入的 fetch（测试用）；缺省全局 `fetch`。 */
  fetchImpl?: typeof fetch
  /**
   * 内联一张图片为**原始字节**（由调用方桥接 `ctx.attachments.readImage`）。
   *
   * ⚠️ 契约与 `buddy-adapter.ts` 一致：**读不到必须返回 `undefined`**（不是抛错，
   * 也不是返回空）—— 由 {@link AccioAdapter.stream} 统一判成
   * `UNSUPPORTED_CONTENT`。静默丢图会让用户以为图片被模型看到了。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /**
   * 取**请求版本**图片（附件服务按目标尺寸缩放）。
   *
   * ⚠️ 契约与 `readImage` **相反**：不可用时返回 `undefined`（不是抛错）——
   * 缩放是优化，拿不到就发原图（见 `image-budget.ts`）。
   */
  readImageRequest?: (
    attachment: unknown,
    target: { width: number; height: number; maxBytes: number },
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 多账号池（用于记录当前账号归属）。 */
  accountPool?: AccountPool
  /**
   * 设备标识（`utdid`）。
   *
   * ⚠️ 实测上游**不校验**它（自造值同样 200），故缺省用进程内稳定的兜底值；
   * 接线层可注入 `~/.accio/utdid` 的真实值。
   */
  utdid?: string
  /** 产品配置；默认 {@link ACCIO}。 */
  product?: AccioProduct
  /**
   * 时钟（注入以便单测推进目录 TTL；缺省 `Date.now`）。
   *
   * ⚠️ 只用于**目录新鲜度**（`ensureRemoteModels` 的 `isCatalogFresh`），
   *    不用于超时/退避计时 —— 那些仍走真实时钟。
   *    ⚠️ **buddy 是例外**：它的 `catalogGate` 也吃这个时钟（冷却与
   *    「距上次尝试 ≥10 秒」判定都走它），所以别把本行当成全仓库通用口径。
   */
  now?: () => number
  /**
   * 远端目录**落地后**的通知回调（issue IKJVTF）。
   *
   * 由 `registerAccioLlm` 注入为 `broadcastCatalogChanged(ctx)` —— 适配器本身
   * 拿不到 `ctx`，必须由接线层桥接。
   */
  onCatalogLoaded?: () => void
}

/** 把内容载荷展平为纯文本（与 `accio-messages.ts` 的 `flattenText` 同口径）。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => (block as { type?: unknown } | undefined)?.type === 'text')
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('')
}

/**
 * 把 **DSH 原生消息块** 转成 `serializeAccioMessages` 认得的 **OpenAI 传输形状**。
 *
 * ## 为什么必须有这一层（真实缺陷，本任务的测试当场抓到）
 *
 * `serializeAccioMessages`（Task 3）是按 **OpenAI 形状**实现的：
 * 它读 `message.tool_calls[]`（`{id, function:{name,arguments}}`）与
 * `message.tool_call_id` / `message.name`。而 DSH 交给适配器的是**原生块**：
 *
 * ```jsonc
 * { "role": "assistant", "content": [{ "type": "tool-call", "id": "c1", "name": "read_file", "arguments": "…" }] }
 * { "role": "tool", "toolCallId": "c1", "content": "…" }        // 0.1.7 一等消息
 * ```
 *
 * 直接把原生块喂进去的后果是**全字段静默丢失**（实测）：
 * `tool_calls` 不存在 ⇒ 一个 `functionCall` 都不产出；`tool_call_id` 不存在 ⇒
 * `functionResponse.id` 落成空串、`name` 也落成空串 —— 而 Accio 的
 * `functionResponse` **按 name 配对**，空 name 的响应等于把工具结果丢掉。
 *
 * 这与 `trae-adapter.ts` / `lobsterai-adapter.ts` 的 `serializeMessages`
 * 是**同一步骤、同一原因**（那两家的注释里记着同一个真实缺陷）。
 *
 * ## 两条既有防线必须保留
 *
 * 1. **入口先 `normalizeHarnessMessages`**（DSH 0.1.7 把工具结果改为一等
 *    `role:'tool'` 消息）—— 漏掉它 `tool-result` 判据恒不命中，
 *    `resolveToolPairing` 会把 assistant 的 `tool_calls` **整体剔除**；
 * 2. **孤儿工具调用/结果必须剔除**（上游对无法配对的条目回 400）。
 *
 * ## 图片（issue IKLR7V 接线，2026-10-14）
 *
 * ⚠️ 本层**必须保留图片块**，不能只取文本。三种位置都要覆盖：
 *
 * | 位置 | 处理 |
 * |---|---|
 * | user 消息的顶层 `content[]` | `content` 产出**数组**（含 `image` 块）⇒ 由 `serializeAccioMessages` 的 `accioUserParts` 内联 |
 * | `tool-result` **内嵌**的图片 | **提升**为紧随其后的一条 user 消息（协议约束见下） |
 * | 其余 | 维持原样（纯文本仍然产出**字符串** `content`，线上格式逐字节不变） |
 *
 * ⚠️ **工具结果内嵌图片不能就地并进 `functionResponse`**：`functionResponse` 只吃
 * `responseJson`（一个**字符串**），塞图片没有位置。沿用 `trae-adapter.ts` 的
 * `flushToolImages` 范式 —— 该图挂到 `role:'tool'` **之后**的独立 user 消息里，
 * 并带一句 `TOOL_RESULT_IMAGE_TEXT` 说明来路（否则模型看到一张**没有上下文**的图）。
 */
export function toAccioWireMessages(
  messages: readonly { role: string; content?: unknown }[],
): Array<Record<string, unknown>> {
  const normalized = normalizeHarnessMessages(messages)
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized)

  // ⚠️ 先扫全消息建 `tool-call id → name` 映射：上游的 `functionResponse`
  // **按 name 配对**（`serializeAccioMessages` 读 `message.name`），而 0.1.7 的
  // 一等 `tool` 消息**不带 name** —— 不建这张表就永远回填不出工具名。
  const toolNames = new Map<string, string>()
  for (const message of normalized) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const b = block as { type?: unknown; id?: unknown; name?: unknown } | null
      if (b !== null && typeof b === 'object' && b.type === 'tool-call') {
        toolNames.set(String(b.id), String(b.name ?? ''))
      }
    }
  }

  const wire: Array<Record<string, unknown>> = []
  /**
   * 待发的「工具结果内嵌图片」—— **跨消息累积**（2026-10-21 修，与 trae 同因）。
   *
   * ⚠️⚠️ **原实现把它声明在循环体内、并在每条消息末尾无条件 flush** ⇒ 当一个
   * assistant 发 **≥2 个 `tool_call`**、且**非最后一个**结果内嵌图片时，图片被 push
   * 成一条独立 user 消息**插在两条 `functionResponse` 之间** ⇒ 配对约束被破坏。
   *
   * ⚠️ 该约束本文件自己逐字记过（见上面 `deferred` 的注释）：「Accio 是 Gemini 风格
   * ⇒ **函数响应必须紧跟发起该调用的 model 消息** —— 中间插任何东西都会破坏配对」，
   * 并引用了 `trae-adapter.ts` 的 4027 事故。⇒ 这次修的是**同一条约束的第二个入口**：
   * `deferred` 只守住了「本条自己的正文/图片」，**没守住工具结果内嵌图的跨消息批处理**。
   *
   * ⚠️ 实测（修复前，2 个 tool_call、图在第 1 个结果里）：
   * ```
   * model[functionCall×2] → user[functionResponse] → user[图片] → user[functionResponse]
   *                                                   ↑ 插在配对之间
   * ```
   * 对照：同一夹具喂共享实现 `openai-compat.ts`（10 家共用）得
   * `assistant → tool → tool → user`（相邻、正确）⇒ 缺陷只在**本文件自己的**组装里。
   * ⚠️ trae 那次是用户报障（4027 明确报错）；本家是 Gemini 形态，配对破裂的**上游表现
   * 未实测**（可能报错、也可能被静默丢弃）⇒ 两种都不可接受。
   *
   * ⇒ 只在两处落地：① 进入下一条 assistant 之前；② 循环结束之后。
   */
  const pending: Array<Record<string, unknown>> = []
  /** 把累积的图片作为一条 user 消息发出（**幂等**：无挂起时 no-op）。 */
  const flushToolImages = (): void => {
    if (pending.length === 0) return
    // `functionResponse` 只吃 `responseJson` 字符串，没有承载图的位置 ⇒ 只能单独成条。
    wire.push({ role: 'user', content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pending] })
    pending.length = 0
  }
  for (const message of normalized) {
    if (message.role === 'assistant') {
      // ⚠️ **进入新的 assistant 之前必须 flush**（2026-10-21 修）：上一批工具结果
      // **已经全部下发完毕**（`role:'tool'` 只会紧跟其 assistant）⇒ 此时落地安全，
      // 且不会过界到下一批。⚠️ 不在这里 flush 会让图片一直挂到循环结束、被挤到更后面。
      flushToolImages()
      const content = Array.isArray(message.content) ? message.content : []
      const toolCalls = content
        .filter((block): block is { type: string; id: unknown; name: unknown; arguments: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
        .filter((block) => keepCallIds.has(String(block.id)))
        .map((block) => ({
          id: String(block.id),
          type: 'function' as const,
          function: {
            name: String(block.name),
            // ⚠️ 必须是**原始参数串**（`serializeAccioMessages` 原样透传成 `argsJson`）。
            arguments: typeof block.arguments === 'string' ? block.arguments : '{}',
          },
        }))
      wire.push({
        role: 'assistant',
        content: contentToText(message.content),
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    // user / tool 角色：工具结果搭载在 user 消息里（0.1.5 形状）或是一等消息（0.1.7，
    // 已被归一化层降级），此处统一展开为独立的 `role:'tool'` 传输消息。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter(
      (block): block is { type: string; toolCallId: unknown; content: unknown } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result',
    )
    const text = contentToText(message.content)
    /**
     * ⚠️ **只取本消息自己的图片**（先剔掉 `tool-result` 块）：工具结果内嵌的图片
     * 由下面 `pendingToolImages` 挂到 `role:'tool'` **之后**。一并收进来会把它们
     * 排到 tool 消息**之前** —— 那正是 `trae-adapter.ts` 记的 4027 事故形态
     * （「tool 消息必须紧跟其 assistant tool_calls 的应答，中间插任何东西都被拒」）。
     */
    const ownBlocks = imageBlocksOf(
      content.filter(
        (block) => !(typeof block === 'object' && block !== null
          && (block as { type?: unknown }).type === 'tool-result'),
      ),
    )
    /**
     * ⚠️⚠️ **判据必须把 `ownBlocks.length > 0` 算进去**（真实缺陷，本文件的洞探针抓到）：
     * 初版是 `if (text.length > 0 || toolResults.length === 0)`，于是
     * 「**只有图片 + 工具结果、没有文本**」的消息（`content: [image, tool-result]`）
     * 两腿**同时为假** ⇒ 整条消息被跳过 ⇒ **图片被静默丢弃**（没有任何报错）。
     * 这与本函数承诺的「绝不静默丢弃」直接矛盾，也与 `collectImages` 收得到它
     * （守卫认为「有图」）相矛盾 —— 那种「收了却发不出去」正是最隐蔽的形态。
     */
    const hasOwn = text.length > 0 || ownBlocks.length > 0
    /**
     * ⚠️⚠️ **带工具结果时，本消息的正文/图片必须延后到 `role:'tool'` 之后**
     * （与 `trae-adapter.ts` 的 `deferred` 同一理由、同一范式）。
     *
     * Accio 是 **Gemini 风格**：工具结果下发为 `{role:'user', parts:[{functionResponse}]}`，
     * 而**函数响应必须紧跟发起该调用的 model 消息** —— 中间插任何东西都会破坏配对。
     * `trae-adapter.ts` 记的 4027 事故（`Messages with role 'tool' must be a response to
     * a preceding message with 'tool_calls'`）就是这条约束在另一协议形态下的爆炸：
     * 坏报文一旦落进会话历史，**每轮原样重放**、5 次重试与「继续」全部无效，
     * 只有换 provider 才能恢复。⇒ 顺序不是风格问题，是**会话能不能继续**的问题。
     */
    const deferred = toolResults.length > 0
    /**
     * 组装「本消息自己的正文 + 图片」的 wire 形态。
     *
     * ⚠️ **空文本块必须剔除**（`text === ''` 时不加 `{type:'text'}`）：
     * 「只有图片、没有正文」的消息（`content: [image]`）很常见，
     * 带上 `{text:''}` 会产出一个**空 part** —— 上游对空 part 的处理未实测，
     * 而本仓库既有的纯文本路径也不会产出空文本块（`if (text !== '')`）。
     * 保持两侧一致，少一个未实测的形状。
     */
    const ownFrame = (): Record<string, unknown> => {
      if (ownBlocks.length === 0) return { role: 'user', content: text }
      return {
        role: 'user',
        content: text === '' ? ownBlocks : [...ownBlocks, { type: 'text', text }],
      }
    }
    if (hasOwn && !deferred) wire.push(ownFrame())
    for (const result of toolResults) {
      const id = String(result.toolCallId)
      // 丢弃孤儿工具结果（没有对应 tool_call 同样会被上游拒绝）。
      if (!keepResultIds.has(id)) continue
      const embedded = imageBlocksOf(Array.isArray(result.content) ? result.content : [])
      wire.push({
        role: 'tool',
        tool_call_id: id,
        // ⚠️ **name 必须回填**：Accio 的 `functionResponse` 按 name 配对。
        name: toolNames.get(id) ?? '',
        content: contentToText(result.content) || (embedded.length > 0 ? TOOL_RESULT_IMAGE_TEXT : '(no output)'),
      })
      pending.push(...embedded)
    }
    // 延后的本消息正文/图片：排在 `role:'tool'` **之后**（成因见上 `deferred`）。
    if (deferred && hasOwn) wire.push(ownFrame())
    // ⚠️⚠️ **这里绝不能无条件 flush**（2026-10-21 修）：原实现在每条消息末尾都发一次
    // ⇒ 同一批工具结果里**非最后一个**结果的图会被插到下一条 `role:'tool'` 之前
    //（实测：`user[functionResponse] → user[图片] → user[functionResponse]`）。
    // ⇒ 图片改为跨消息累积，只在「进入下一条 assistant 前」与「循环收尾」两处落地。
  }
  // 循环收尾：把最后一批挂起的图片发出去（此时所有 tool 消息已下发完毕）。
  flushToolImages()
  return wire
}

/**
 * 取出 content 里的 `image` 块（**原样保留**，含 `attachment` 引用）。
 *
 * ⚠️ 只收**本层**的 `image` 块，**不递归**进 `tool-result`：递归由调用方
 * 按「工具结果图片要排到 tool 消息之后」的位置约束单独处理。
 */
function imageBlocksOf(content: readonly unknown[]): Array<Record<string, unknown>> {
  return content.filter(
    (block): block is Record<string, unknown> =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'image',
  )
}

/** 安全读取 `Error.message`。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/** 传输级错误判定（网络抖动，归可重试的 `TRANSPORT`）。 */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (error.name.startsWith('UND_ERR_')) return true
  if (message.includes('fetch failed')) return true
  if (message.includes('terminated') || message.includes('econnreset')) return true
  if (message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/**
 * HTTP 状态码 → provider-neutral 错误码。
 *
 * ⚠️ **402 必须归 `QUOTA_EXCEEDED`**（不得归 `SERVER`）：`SERVER` 在 harness 的
 * `DEFAULT_RETRYABLE_CODES`（`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` /
 * `TRANSPORT`）里 ⇒ 额度耗尽这种**确定性**失败会被原样重发 5 次（退避约 15.5 秒），
 * 每次都必然同样失败。这与 trae 的 4006 是同一类错误归因。
 */
function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA_EXCEEDED'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

// ── 请求级账号轮换（issue IKM3ZV，2026-10-18）────────────────────────────
//
// ## 为什么必须有这一段
//
// 修复前本适配器**整条请求路径零换号**：`resolveCredential` 取回一个账号 →
// 不成即抛错。实测复现（issue IKM3ZV）：池里两个启用账号，首号额度耗尽
// （`402`）后，**第二个账号从未被尝试**，整轮直接失败 ——「登录 N 个账号
// 并未带来 N 倍可用性」。全仓 18 个 `*-adapter.ts` 里当时只有 3 家
// （accio / autoclaw / officeace）没有换号循环。
//
// ## 语义表（照 `minimax-adapter.ts` / `loomy-adapter.ts` 的类别→动作表逐格搬）
//
// | 类别 | 判据 | 换号 | 写冷却 |
// |---|---|---|---|
// | `quota` | 402 / 流内 `error_code:402` | ✅ | ✅ 至 UTC+8 当日 24:00 |
// | `rate`  | 429 | ✅ | ✅ 1h |
// | `auth`  | 401 / 403 | ✅ | ❌ **绝不写** |
// | `other` | 其余（400 参数错、5xx、风控拦截页…） | ❌ | ❌ |
//
// ⚠️ **认证类只换号、绝不写冷却**是 2026-10-06「全池被封」事故换来的不变式：
// 上游网关对**全池**回 401 时，若每个号都被写长冷却，一个请求就能把整个
// provider 封一天。这与 loomy / raccoon / minimax 同一条铁律。
//
// ⚠️ **本表按 `status` 判、**不**再扫报文文案**（与 minimax / loomy 的四通道
// 判据刻意不同）：本家的两条通道已经把类别**穷尽**了 ——
//   - HTTP 层：`httpErrorCode` 已把 401/402/403/429 各自映射成固定错误码；
//   - 流内层：`accioErrorFrame` 只把 `error_code === '402'` 认作额度，其余
//     非 200 码一律归 `SERVER`（见 `accio-messages.ts`）。
// 再加一条文案扫描腿只会引入过宽判据（把 400 参数错判成额度 → 白封账号一天），
// 而这一家缺文案腿的代价是「上游用文案而非状态码表达额度」时不换号 —— 那是
// **漏判**（少换一次号），方向与 minimax 那条「宁可漏判不可误伤」一致。
//
// ⚠️ **`EMPTY_RESPONSE` / `UNSUPPORTED_CONTENT` 等本地错误一律不换号**
// （它们在换号判定之前就抛出了，根本到不了这里）。

/** Accio 的失败类别（`auth` 只换号、绝不写冷却，见上文语义表）。 */
export type AccioFailureClass = 'quota' | 'rate' | 'auth' | 'other'

/**
 * 失败类别 → 该不该**换号**（写不写冷却另由 {@link recordsAccioRateLimit} 判）。
 *
 * ⚠️ 必须把 `httpErrorCode` / `accioErrorFrame` 的**产出**喂进来，不得重扫状态码
 * —— 同一仓库两套同义判据是本仓库首条红线（PR !62 的事故）。
 */
export function accioFailureClassOf(code: string): AccioFailureClass {
  if (code === 'QUOTA_EXCEEDED') return 'quota'
  if (code === 'RATE_LIMIT') return 'rate'
  if (code === 'AUTH') return 'auth'
  return 'other'
}

/**
 * 该类别是否值得**换号重试**。
 *
 * ⚠️ `other` 为 false 的理由与 minimax / loomy 同款：400 参数错、5xx、
 * 风控拦截页这些是**请求本身或环境**的问题，换号只会白烧整池。
 */
export function shouldRotateAccioAccount(code: string): boolean {
  return accioFailureClassOf(code) !== 'other'
}

/**
 * 该类别是否**写冷却标记**。
 *
 * ⚠️ **认证类恒 false**（见上文语义表的不变式）—— 这条是「一个请求封死整池」
 * 与「坏账号永远轮不到」之间的取舍点，两家都选前者。
 */
export function recordsAccioRateLimit(code: string): boolean {
  const cls = accioFailureClassOf(code)
  return cls === 'quota' || cls === 'rate'
}

/** 从错误体里抠出可读 detail（**逐字保留服务端原文**，不吞）。 */
function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const parts = [
      typeof data.error_code === 'string' || typeof data.error_code === 'number'
        ? `error_code=${String(data.error_code)}` : undefined,
      typeof data.error_message === 'string' ? data.error_message : undefined,
      typeof data.code === 'string' || typeof data.code === 'number' ? `code=${String(data.code)}` : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      typeof data.error === 'string' ? data.error : undefined,
      // ⚠️ 上游代理的 `{"error":"…","detail":"<真实原因>"}` 形态（IKLBSH A1）。
      // 判据只留一份实现（本文件已经在 import `openai-compat`）；必须是最后一条腿。
      detailFieldText(data),
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch { /* 非 JSON 错误体：原样返回 */ }
  return body
}

/**
 * 把访问令牌写进请求体（**唯一**的 token 落点）。
 *
 * ## 为什么必须有这个函数（真实缺陷，本轮修复）
 *
 * Accio 的令牌走的是 **body 的 `token` 字段**（放 `Authorization` 头恒流内 402，
 * 见文件头），而 `send()` 只把 `credential` 用于 `sgcookie` **请求头**。
 * 于是「401/403 后刷新凭据再重试」这条分支原先**重发的是刷新前的旧 token**
 * —— 结构上不可能成功，`refresh()` 白烧一次 `refresh_token`
 * （AGENTS.md 记着同型事故：反复消费 `refresh_token` ⇒ `invalid_grant` ⇒ 账号被标死）。
 *
 * ⚠️ 更糟的是 harness 兜不住：`AUTH` **不在** `DEFAULT_RETRYABLE_CODES`
 * （`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`）里，
 * 所以一个本可自愈的凭据会退化成**硬失败**。
 *
 * ## 为什么是「原地改一个键」而不是「重建 body」
 *
 * `message_id` 与 `request_id` 必须**逐字节不变**（它们是**一次逻辑请求**的身份；
 * 重建 body 会经 `accioMessageId()` 掺入新的随机量，等于换了请求身份）。
 * 故这里只覆盖 token 这一个字段，其余键（含 `properties` / `sg_k` 依赖的
 * `request_id`）原样保留。
 */
function applyAccessToken(body: Record<string, unknown>, accessToken: string): void {
  body.token = accessToken
}

/**
 * 合并一次工具调用的多个参数分片。
 *
 * ## 实测形状（2026-10-13，三轮取样，每次都是同一形态）
 *
 * ```
 * frame#8  {"function_call":{"id":"call_x","name":"read_file"}}                              ← 无参数
 * frame#9  {"function_call":{"id":"call_x","name":"read_file","args_json":"{\"file_path\":\"a.txt\"}"}}
 * frame#10 {"function_call":{"id":"call_x","name":"read_file","args_json":"{\"file_path\":\"a.txt\"}"}}
 * ```
 *
 * 即**首帧无参数、后续帧重复完整的参数**（不是增量、也不是逐帧增长）。
 * 但「重复全量」与「逐帧增长」在真机上都可能出现，故本函数两种都处理：
 *
 * 1. **累积式**（后一份以前一份为前缀）⇒ 取**最后一份**（它就是全量）；
 * 2. **增量式**（不是前缀关系）⇒ 把各片段**依次拼接**。
 *
 * 两条分支都不编造内容：全为空时返回空串，由调用方决定是否省略 `args_json`。
 */
export function mergeAccioToolArgs(fragments: readonly string[]): string {
  const nonEmpty = fragments.filter((fragment) => fragment !== '')
  if (nonEmpty.length === 0) return ''
  let cumulative = true
  for (let i = 1; i < nonEmpty.length; i++) {
    if (!nonEmpty[i]!.startsWith(nonEmpty[i - 1]!)) { cumulative = false; break }
  }
  if (cumulative) return nonEmpty[nonEmpty.length - 1]!
  let merged = ''
  for (const fragment of nonEmpty) {
    // 已包含在累积值里（同一份全量重复）⇒ 直接替换；否则当作增量追加。
    merged = fragment.startsWith(merged) ? fragment : merged + fragment
  }
  return merged
}

/**
 * 把 Accio 的**分片**工具调用合并成「一次调用一帧」的 SSE 改写流。
 *
 * ## 为什么必须由适配器做（而不是共享消费者）
 *
 * `consumeAccioSse` → `consumeGeminiSse` 对每个 `functionCall` part 各产出一个
 * **独立且完整**的 tool-call 块（它把 `args_json` 一次性发完再关块，不做跨帧累积）。
 * 实测把上面的三帧喂进去得到 **3 个** tool-call 块，首个参数是 `{}`：
 *
 * ```
 * block-end {type:'tool-call', name:'read_file', arguments:'{}'}            ← 空参数
 * block-end {type:'tool-call', name:'read_file', arguments:'{"file_path":"a.txt"}'}
 * block-end {type:'tool-call', name:'read_file', arguments:'{"file_path":"a.txt"}'}
 * ```
 *
 * ⇒ 不合并的后果是 harness **执行同一个工具 N 次**（首个还带空参数）。
 *
 * ## 四条纪律
 *
 * 1. **只缓冲工具调用 part**：同一帧里的**非工具 part（正文 / `thought`）原样
 *    透传**，绝不丢 —— 上游确实会把 `text` 与 `function_call` 放在**同一帧**里
 *    （本函数的用例覆盖该形态）；整帧丢弃会**静默吞掉正文**。
 * 2. **流序**：flush 缓冲时把它排在**当前行之前** —— 工具调用仍出现在
 *    它后面那些帧（usage / finish）之前，与上游顺序一致；
 * 3. **按 `id` 分组**：不同 `id` 是不同调用，绝不误合并；
 * 4. **非 `data:` 行原样透传**（注释心跳、空行分隔符都不能丢）。
 *
 * ## ⚠️ 已知边界（如实登记，不改）
 *
 * 缓冲只在「遇到没有工具调用的帧」或流结束时 flush。若上游把**同一次**调用的分片
 * 与正文**交错**下发（`call(id)` → `text` → `call(id,args)`），中间的正文帧会触发
 * 一次提前 flush ⇒ 该调用会被拆成两块（首块无参数）。
 *
 * **实测未出现该形态**：三轮取样的分片帧都是**连续**到达的
 * （如 frame#13/#14/#15）。要彻底消除它必须把正文也缓冲到流结束 —— 那会**牺牲
 * 首字延迟**（TTFT）并让正文与思考的增量下发全部失效，代价远大于收益。
 * ⇒ 保留当前策略；若将来真机上观测到交错，应先取证再改。
 */
/**
 * 抽取一帧上的**终帧元数据**（`turn_complete` / `usage_metadata` / `finish_reason`）。
 *
 * ⚠️ 只抽这三个键，**不透传整帧**：工具分片帧还带 `partial` / `raw_response_json`
 * （后者是整份 OpenAI 原始 chunk，体积大且与合并产物无关）—— 拼进 flush 帧会
 * 让每帧体积膨胀数倍且语义混乱。元数据三键是消费侧真正读的（归一化层把它们
 * 映射成 `usageMetadata` / `finishReason`，`turn_complete` 仅作标记）。
 */
function frameMetaOf(frame: unknown): Record<string, unknown> | undefined {
  if (frame === null || typeof frame !== 'object') return undefined
  const f = frame as Record<string, unknown>
  const meta: Record<string, unknown> = {}
  if (f.turn_complete !== undefined) meta.turn_complete = f.turn_complete
  if (f.usage_metadata !== undefined) meta.usage_metadata = f.usage_metadata
  if (f.usageMetadata !== undefined) meta.usageMetadata = f.usageMetadata
  if (f.finish_reason !== undefined) meta.finish_reason = f.finish_reason
  if (f.finishReason !== undefined) meta.finishReason = f.finishReason
  return Object.keys(meta).length > 0 ? meta : undefined
}

/**
 * 从一个 `function_call` 上抽**参数串**（`args_json` / `argsJson` / 对象 `args`）。
 *
 * ⚠️ 三种形态与 `normalizeAccioPart`（`src/accio-messages.ts`）**同口径**：
 * 上游实测下发 snake 的**字符串** `args_json`，但标准 Gemini 形态是对象 `args`，
 * camel 的 `argsJson` 也被归一化层容忍。本层原先只认 `args_json`
 * ⇒ 另两种形态被**静默清空为 `{}`**（模型以为执行了，实际用空参数跑工具）。
 *
 * ⚠️⚠️ **空串必须继续回退**（2026-10-13 对抗验证查出）：原先写
 * `if (typeof raw === 'string') return raw` —— `args_json: ""` 是**字符串**，
 * 于是直接返回空串、**永不回退**到同帧的 `args` 对象。而归一化层
 * （`normalizeAccioPart` 的 `parseArgsJson` 对空串返回 `undefined`）**会**回退 ⇒
 * 同一个帧「合并层得 `{}`、归一化层得真实参数」——**两层判据不一致**，
 * 且症状正是上面那句「静默空参数」。⇒ 空串按「没有」处理。
 *
 * ⚠️ `args` 是对象时**序列化成串**：本层的缓冲按「字符串片段累积」工作
 * （`mergeAccioToolArgs` 处理分片），对象直传会破坏合并语义。
 */
function accioArgsTextOf(call: Record<string, unknown>): string {
  const raw = call.args_json ?? call.argsJson
  if (typeof raw === 'string' && raw !== '') return raw
  const obj = call.args
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    try { return JSON.stringify(obj) } catch { return '' }
  }
  return ''
}

/**
 * 取一份 `usage` 上的 **total**（用于「取最大 total」判定；读不到时 `-1`）。
 *
 * ⚠️ 与 `consumeGeminiSse` 的 `noteUsage`（`src/gemini-messages.ts`）**同口径**：
 * snake `total_token_count` 与 camel `totalTokenCount` 都认。
 */
function usageTotalOf(u: unknown): number {
  if (u === null || typeof u !== 'object' || Array.isArray(u)) return -1
  const r = u as Record<string, unknown>
  const raw = r.totalTokenCount ?? r.total_token_count
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : -1
}

/**
 * 合并两帧的**终帧元数据**（被吸收帧上的 `turn_complete` / `usage_metadata` /
 * `finish_reason`）。
 *
 * ## 两类键的语义**不同**，必须分开处理
 *
 * - `finish_reason` / `turn_complete` 等：**后者覆盖前者**（终帧的就是最终值）；
 * - `usage`（`usage_metadata` / `usageMetadata`）：⚠️⚠️ **取「total 更大」的那一份**，
 *   相等时后者胜 —— 这正是消费侧 `noteUsage` 的语义。
 *
 * ## ⚠️⚠️ 为什么必须取最大（2026-10-13 审计修正）
 *
 * 原实现是**无差别字段级后覆盖先**，注释却声称「与消费侧取最大 total 的语义一致」
 * —— 注释与代码**不一致**，而实测代价是**合并路径比透传路径更弱**：
 *
 * | 终帧 usage | 合并（吸收）路径 | 透传路径（`noteUsage`） |
 * |---|---|---|
 * | 部分键（无 prompt/cached/thoughts） | 丢掉先前那份的键 | 保住 |
 * | 空对象 `{}` | usage **全零** | 保住先前完整值 |
 * | total 偏小（336→4） | 取**偏小**值 | 取 336 |
 *
 * 同样两份 usage，只是「帧上带不带 `function_call`」，计量结果就不同 —— 这属于
 * 「同一个量两条判据」，且合并路径是**更差**的那条。⇒ 与消费侧统一为取最大 total。
 *
 * ⚠️⚠️ **首份也必须收敛**（2026-10-13 对抗验证查出）：原先 `prev === undefined`
 * 时直接 `return { ...next }` **早退**，于是「首帧同时带两个 usage 键」时两个键
 * **都被保留** ⇒ 归一化层恒取 snake（`f.usage_metadata ?? f.usageMetadata`）⇒
 * **陈旧的小值胜出**（实测：首帧 snake total=10 / camel total=3100 ⇒ 得 10，
 * 期望 3100）。⇒ 收敛逻辑必须**覆盖首份**，不能靠早退绕过。
 *
 * ⚠️ 收敛后**只留一个 usage 键**：两个键并存时另一个永远是死的（归一化层恒取
 * snake），还可能是陈旧值。
 */
function mergeFrameMeta(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = prev === undefined ? {} : { ...prev }
  // 非 usage 键：后者覆盖前者。
  for (const [key, value] of Object.entries(next)) {
    if (key === 'usage_metadata' || key === 'usageMetadata') continue
    out[key] = value
  }
  // usage：先把**两侧**的候选都收集起来（各自可能是 snake 或 camel），取 total 最大者，
  // 最后统一写回**单一**的 `usage_metadata` 键。
  const candidates: unknown[] = [out.usage_metadata, out.usageMetadata, next.usage_metadata, next.usageMetadata]
  delete out.usage_metadata
  delete out.usageMetadata
  let winner: unknown
  for (const c of candidates) {
    if (c === undefined || c === null) continue
    if (winner === undefined || usageTotalOf(c) >= usageTotalOf(winner)) winner = c
  }
  if (winner !== undefined) out.usage_metadata = winner
  return out
}

export function accioToolCallMergeTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  /** 本次待合并的调用：`id` → 已见到的参数片段（**保持首见顺序**）。 */
  const pending = new Map<string, { id: string; name: string; fragments: string[] }>()
  /**
   * ⚠️⚠️ 被吸收帧上携带的**终帧元数据**（`usage_metadata` / `finish_reason` /
   * `turn_complete` 等，2026-10-13 wire 探针定罪的真实缺陷）：
   * 上游把**最后一个 `function_call` 分片**与终帧元数据放在**同一帧**里
   * （`{content:{parts:[{function_call:{…,args_json}}]}, turn_complete:true,
   * usage_metadata:{…}, finish_reason:"STOP"}`）。吸收工具 part 时若不把
   * 这些字段暂存下来，flush 只吐工具 part ⇒ usage 恒归零、finish 恒兜底
   * `stop` —— 正是用户报障「思考一下就中断」的根因（工具帧其实到了，
   * 但终帧元数据被合并缓冲吞掉）。
   */
  let pendingMeta: Record<string, unknown> | undefined

  /** 把已缓冲的调用拼成**一帧**交出去（无缓冲时是空操作）。 */
  const flushPending = (out: string[]): void => {
    if (pending.size === 0) {
      // ⚠️ 无工具调用时元数据也要交出去：终帧可能不带 function_call
      //（纯文本轮次的收尾帧就是这种），吸收路径根本没跑过 —— 但若
      // `pendingMeta` 有值（理论上不会），仍照发，宁多勿丢。
      if (pendingMeta !== undefined) {
        out.push(`data: ${JSON.stringify(pendingMeta)}`)
        pendingMeta = undefined
      }
      return
    }
    const parts: unknown[] = []
    for (const entry of pending.values()) {
      const args = mergeAccioToolArgs(entry.fragments)
      parts.push({
        function_call: {
          id: entry.id,
          name: entry.name,
          // ⚠️ 参数为空时**省略**该键（与上游「首帧无参数」同形），
          // 不写空串 —— 那会让消费侧解析出一个空参数对象。
          ...args === '' ? {} : { args_json: args },
        },
      })
    }
    pending.clear()
    // ⚠️ 终帧元数据**拼在同一帧**上（与上游原形一致）：归一化层会把
    // `usage_metadata`/`finish_reason` 映射到 `usageMetadata`/`finishReason`，
    // 消费侧于是拿到真实的用量与结束原因。
    const frame: Record<string, unknown> = {
      content: { role: 'model', parts },
      partial: true,
      ...(pendingMeta !== undefined ? pendingMeta : {}),
    }
    pendingMeta = undefined
    out.push(`data: ${JSON.stringify(frame)}`)
  }

  /**
   * 生成一个**不与已有键冲突**的匿名调用键。
   *
   * ⚠️ 原先用 `anon-${pending.size}`：一旦上游**显式**下发 `id: "anon-0"` 之类，
   * 两者会撞进同一个 `pending` 条目 ⇒ **两个调用被误合并成一个**（名字被后者覆盖、
   * 参数串接成非法 JSON，消费侧解析失败退化成 `{}`）。本 PR 把顶层 `function_call`
   * 也纳入合并路径后，这条路才变得可达。
   */
  const anonKey = (): string => {
    let n = pending.size
    while (pending.has(`anon-${n}`)) n++
    return `anon-${n}`
  }

  /**
   * 把一帧里的工具调用 part 收进缓冲（按 `id` 分组、保持首见顺序）。
   * `content.parts` 形状与改写后的顶层 `function_call` 形状共用这一条路径。
   *
   * ⚠️ **同时暂存帧上的终帧元数据**：上游会把最后一个分片与
   * `turn_complete`/`usage_metadata`/`finish_reason` 放在同一帧（见
   * `pendingMeta` 的注释）。只吸收 part 不存元数据 = 吞掉 usage 与 finish。
   *
   * ⚠️⚠️ **畸形 part 只跳过、绝不抛**（2026-10-13 审计修正）：`function_call` 为
   * `null` / 非对象时原先直接解引用 `call.id` ⇒ **裸 `TypeError` 打断整条流**，
   * 且 `transform` 的异常发生在 `controller.enqueue` **之前** ⇒ **同一个 chunk 里
   * 已经解析出的正文/思考一起被丢掉**（这正是 `consumeAccioSse` 的 `pendingError`
   * 设计要避免的同型缺陷，在上一层复发）。而且裸 `TypeError` 不是 `LlmError` ⇒
   * harness 归类 `UNKNOWN`、**不在可重试集合**，用户只能重新发。
   * ⇒ 判据与 `normalizeAccioPart` 保持一致：**不是对象就跳过**（那里同样丢弃无名调用）。
   */
  const absorbCallParts = (callParts: unknown[], meta: Record<string, unknown> | undefined): void => {
    for (const part of callParts) {
      const call = (part as { function_call?: unknown } | null)?.function_call
      if (call === null || typeof call !== 'object' || Array.isArray(call)) continue
      const c = call as Record<string, unknown>
      const id = typeof c.id === 'string' && c.id !== '' ? c.id : anonKey()
      const name = typeof c.name === 'string' ? c.name : ''
      // ⚠️ 参数三种形态与 `normalizeAccioPart` **同口径**（`args_json` snake 实测 /
      // `argsJson` camel / 对象 `args`）。原先只认 `args_json` ⇒ 另两种形态被
      // **静默清空为 `{}`**（模型以为执行了，实际用空参数跑工具 —— 比报错更坏）。
      const args = accioArgsTextOf(c)
      const entry = pending.get(id)
      if (entry === undefined) pending.set(id, { id, name, fragments: args === '' ? [] : [args] })
      else {
        if (name !== '') entry.name = name
        if (args !== '') entry.fragments.push(args)
      }
    }
    if (meta !== undefined) pendingMeta = mergeFrameMeta(pendingMeta, meta)
  }

  /** 处理一行；把要交出的行推进 `out`。 */
  const handleLine = (line: string, out: string[]): void => {
    if (!line.startsWith('data:')) { out.push(line); return }
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') { flushPending(out); out.push(line); return }
    let parsed: unknown
    try { parsed = JSON.parse(payload) } catch { flushPending(out); out.push(line); return }
    const frame = parsed as { content?: { parts?: unknown }; function_call?: unknown; [key: string]: unknown } | null

    /**
     * ⚠️⚠️ **流内错误帧绝不能被吸收**（2026-10-13 审计修正，本 PR 引入的净回归）。
     *
     * 错误判据（`accioErrorFrame`）在**下一层** `consumeAccioSse` 的 `processLine` 里，
     * 而本层跑在它**之前**。若错误帧恰好与工具 part **同帧**（上游确实会在帧上混发
     * `error_code`），本层的改写/吸收会新造一个只含 `content.parts` 的帧 ⇒
     * `error_code` / `error_message` 被吞 ⇒ 下一层的判据再也看不到它 ⇒
     * **额度/认证失败被反转成「工具调用成功」**，服务端原文一个字都到不了用户眼前
     * （违反铁律「流内错误必须抛出」「绝不丢服务端原文」）。
     *
     * ⇒ 错误帧**原样透传**（不 flush、不改写、不吸收），把判据留给下一层。
     * 判据复用 `isAccioErrorFrame` —— **只此一处**，不在这里另写一份（两份必然漂移）。
     *
     * ⚠️ **投递边界的如实说明**（2026-10-13 对抗验证追问）：错误帧**之前**已产出的帧
     * 一定交付（本层先 `flushPending`/已 `enqueue`，下一层也是先交出再抛）；
     * 与错误帧**同 chunk** 且在其**之后**的帧也会交付（同一批 `out`）；
     * 但**跨 chunk 的后续帧不会交付** —— 下一层抛出后流即终止，这是「流内错误
     * ⇒ 整条流作废」的**刻意设计**，不是丢失。此处不要试图「抢救」后续帧：
     * 上游报错后继续读只会得到无意义的数据。
     */
    if (isAccioErrorFrame(frame)) { flushPending(out); out.push(line); return }

    const parts = frame?.content?.parts
    const hasPartsArray = Array.isArray(parts)
    const topCall = frame?.function_call ?? frame?.functionCall
    /**
     * ⚠️ **改写的触发条件看「`content.parts` 不是数组」，不是「`content` 缺失」**
     * （2026-10-13 审计修正）。上游确实会下发 `{content:{role:'model'}}`
     * （**有 content 无 parts**，PR 文档 §4.4.0 自己记录的真实终帧形状）——
     * 原先要求 `content` 完全缺失，于是这种帧里的顶层 `function_call` 被**静默丢弃**
     * ⇒ 工具调用凭空消失 ⇒ 又回到「思考一下就中断」。
     *
     * ⚠️ **改写是加性的**：用 `{...frame}` 保留帧上其余顶层字段
     * （`usage_metadata` / `finish_reason` / 上游将来新增的字段）。新造只含
     * `content` 的帧会把它们一并丢弃。
     *
     * ⚠️ **如实登记一处已知损失**（2026-10-13 对抗验证追问）：被**吸收**的工具帧最终由
     * `flushPending` **重新合成**（`{content:{role,parts}, ...pendingMeta}`）⇒
     * 原帧 `content` 内的**非 `parts`** 字段（如上游附加键）**不会**出现在合成帧里。
     * 实测这**不影响下游**：消费侧只读 `content.parts` / `usageMetadata` /
     * `finishReason`（`consumeGeminiSse` 的 `processFrame`）。故**刻意不为它增加
     * 一条元数据通道** —— 那会让合并层多背一个「原帧 content 附加键」的包袱，
     * 收益为零。若将来上游出现消费侧真正要读的 content 级字段，**必须**在此处
     * 一并接上（否则会被静默丢弃）。
     *
     * ⚠️ **`candidates` 已存在时绝不改写**：那种帧是**标准 Gemini 形状**，
     * 归一化层对它是「原样透传」（`normalizeAccioFrame` 的 `Array.isArray(f.candidates)`
     * 分支）。本层若照改写就会把 `candidates` 里的正文**整帧吞掉** ——
     * 两层判据不一致（AGENTS.md 反复记的「一文件两套同义判据」）。
     */
    let effectiveLine = line
    if (!hasPartsArray
      && frame !== null && typeof frame === 'object'
      && topCall !== null && typeof topCall === 'object' && !Array.isArray(topCall)
      && !Array.isArray(frame.candidates)) {
      effectiveLine = `data: ${JSON.stringify({
        ...frame,
        content: { role: 'model', parts: [{ function_call: topCall }] },
      })}`
    }
    // ⚠️ 帧上的终帧元数据（`turn_complete`/`usage_metadata`/`finish_reason`）：
    // 与最后一个工具分片同帧到达（见 pendingMeta 注释），吸收时必须一并暂存。
    const meta = frameMetaOf(frame)
    if (effectiveLine !== line) {
      const rewritten = JSON.parse(effectiveLine.slice(5).trim()) as { content?: { parts?: unknown } }
      const rewrittenParts = rewritten.content?.parts
      if (Array.isArray(rewrittenParts)) {
        absorbCallParts(rewrittenParts, meta)
        return
      }
    }
    if (!hasPartsArray) { flushPending(out); out.push(line); return }

    const isCall = (part: unknown): boolean =>
      part !== null && typeof part === 'object'
      && (part as { function_call?: unknown }).function_call !== undefined
    const callParts = parts.filter(isCall)
    // 本帧没有工具调用：把缓冲 flush 到**本行之前**，再原样交出本行。
    if (callParts.length === 0) { flushPending(out); out.push(line); return }

    /**
     * ⚠️ **本帧混有非工具 part 时，必须把那些 part 原样发出**（真实缺陷，自审抓到）：
     * 上游会把 `text` 与 `function_call` 放进**同一帧**的 `parts` 里，
     * 整帧吸收进缓冲会**静默吞掉正文**（模型写的话凭空消失）。
     *
     * ⚠️ **顺序不可颠倒**：先发本帧的非工具 part，**再**把工具 part 收进缓冲。
     * 反过来（先 flush 再收）会把**同一个调用**拆成两个块 ——
     * 首帧 flush 出的那个还没有参数，正是本函数要消灭的形态。
     * 缓冲要等到「某个没有工具调用的帧」或流结束才 flush（见上面的提前 return）。
     */
    const otherParts = parts.filter((part) => !isCall(part))
    if (otherParts.length > 0) {
      out.push(`data: ${JSON.stringify({ ...frame, content: { ...frame!.content, parts: otherParts } })}`)
    }
    absorbCallParts(callParts, meta)
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      const out: string[] = []
      for (const line of lines) {
        const trimmedEnd = line.endsWith('\r') ? line.slice(0, -1) : line
        handleLine(trimmedEnd, out)
      }
      if (out.length > 0) controller.enqueue(encoder.encode(`${out.join('\n')}\n`))
    },
    flush(controller) {
      // ⚠️ 先刷解码器里的残留多字节序列，再处理余量 —— 否则跨 chunk 的
      // 最后一个字符（以及最后一条事件）会被丢弃。
      buffer += decoder.decode()
      const out: string[] = []
      if (buffer !== '') handleLine(buffer, out)
      flushPending(out)
      if (out.length > 0) controller.enqueue(encoder.encode(out.join('\n')))
    },
  })
}

/**
 * Accio 模型适配器。
 */
export class AccioAdapter extends LlmAdapter {
  private readonly product: AccioProduct
  private readonly fetchImpl: typeof fetch
  private readonly utdid: string
  /** 远端目录缓存（成功拉取后保留 20 分钟）。 */
  private remoteModels: AccioFallbackModel[] | undefined
  /**
   * ⚠️ 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
   *
   * ⚠️ 与 `remoteModels` **并存**、不是替代：`remoteModels` 存「有哪些模型」，
   *    本字段存「何时读到的」。只有 `remoteModels` 时目录**永不刷新**（原行为）。
   */
  private catalogAt = 0
  /** 目录加载闸门：并发去重 + 失败/空结果冷却。 */
  private readonly catalogGate: RemoteCatalogGate
  /** 共享目录骨架（门控 → 读目录 → 黑名单 → 回填 → 三态）。 */
  private readonly catalog: ModelCatalog

  constructor(private readonly options: AccioAdapterOptions) {
    super()
    this.product = options.product ?? ACCIO
    this.fetchImpl = options.fetchImpl ?? fetch
    this.utdid = options.utdid ?? FALLBACK_UTDID
    this.catalogGate = new RemoteCatalogGate(
      options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded },
    )
    this.catalog = createModelCatalog(
      { accountPool: options.accountPool },
      {
        product: this.product,
        loadCatalog: () => this.loadCatalogEntries(),
        syncCatalog: () => this.syncCatalogEntries(),
        /**
         * ★ **强制重拉**（供后台 20 分钟刷新器与「用户改设置」）。
         *
         * ⚠️ 与 `loadCatalog` 的差别：后者内部有 `isCatalogFresh` 判据 ⇒ 新鲜时**不拉**。
         * 本回调要的是「无视新鲜度，强制拉一次」，故先清时刻再调同一个方法 ——
         * **不另写一份拉取逻辑**（那会让两条路的上游行为分叉）。
         */
        refresh: async () => {
          this.catalogAt = 0
          await this.ensureRemoteModels()
        },
        /**
         * ⚠️ **未知 id**（用户手填）：保守报 `['text']`。
         *
         * 本家目录条目的 `multimodal` 字段**从不缺失** ⇒ 已知模型没有「未知」态
         * （见 `toCatalogEntry`）。而**未知 id** 的能力真的无从得知，故取保守侧：
         * 报 `['text']` 让 DSH 在附件准入阶段就拒图，而不是把图放行到一个
         * **可能静默忽略它**的服务端（实测 `multimodal: false` 的模型正是那种行为）。
         *
         * ⚠️ 与 `stream()` 的未知 id 判据**同向**（那里同样保守拒绝）——
         * 两处必须一致，否则会出现「准入放行、适配器再拒」这种白撞一轮的形态。
         */
        unknownModelInputModalities: () => ['text'] as const,
      },
    )
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 懒加载远端模型目录（**每 20 分钟**重新拉一次，用户 2026-10-18 的要求；
   * 失败/空结果走闸门冷却）。
   */
  private async ensureRemoteModels(): Promise<void> {
    const fetchRemote = this.options.fetchRemoteModels
    // ⚠️ `fetchRemote === undefined` 那半边**原样保留** —— 它判的是「有没有远端
    //    可拉」（无凭据/无接线），与新鲜度是两件事。
    if (fetchRemote === undefined) return
    // ⚠️ 判据来源：`isCatalogFresh`（`model-catalog.ts` 的**唯一**实现）。
    // ⚠️ **入口用 `isCatalogFreshFor`**：用户在 Jet Hub 改开关后要**立即**重拉
    //    （规格 §6 的正确性要求，见 `invalidateCatalogCache`）。gate 之后**不再**
    //    判失效 —— 那里问的是「手上这份旧读数还能不能用」。
    if (this.remoteModels !== undefined
      && isCatalogFreshFor(this.product.id, this.catalogAt, this.options.now?.() ?? Date.now())) {
      return
    }
    await this.catalogGate.run(async () => {
      const models = await fetchRemote()
      if (models.length === 0) return false
      this.remoteModels = models
      // ⚠️ **只在成功赋值后**记时刻：失败/空结果不写，否则一次抖动会把上界
      //    刷新掉、下轮还要等满 20 分钟才发现上游没恢复。
      this.catalogAt = this.options.now?.() ?? Date.now()
      return true
    })
  }

  /**
   * 把本家条目转成共享骨架的中间结构。
   *
   * ## ⚠️⚠️ `inputModalities` 的三态决策（2026-10-14 真机实测后**已改**）
   *
   * ### 改之前的判据（已废弃，别再改回去）
   *
   * 原先**恒省略**，理由是「本 provider 的图片通路整体未实测」——那时确实没有
   * 任何一次真实图片请求被验证过，故「未知」是唯一诚实的编码。
   *
   * ### 现在为什么可以写数组
   *
   * issue IKLR7V 的真机实测把那个前提消掉了：
   *
   * | 声明 | 实测（四象限色块图） |
   * |---|---|
   * | `multimodal: true`（3 个模型） | **3/3 四色全对**（红/绿/蓝/白）⇒ 真收图 |
   * | `multimodal: false`（3 个模型） | **3/3 未认图**；GLM-5.3 / Qwen 3.5 A3B 明说「没看到图片」，**GLM 5.1 幻觉**出一份答案 |
   *
   * 且远端 15 条可见模型的 `multimodal` 字段**从不缺失**（38 条原始行里
   * 可见的都有该键）、与兜底表 **100% 一致**。
   *
   * ### ⇒ 本家**不再有「未知」态**，与 loomy / raccoon / zcode / minimax / qoder 同形
   *
   * DSH 的三态语义在这里落成：
   * - `supportsImage === true` ⇒ `['text','image']`；
   * - `supportsImage === false` ⇒ **`['text']`（明确不支持）**。
   *
   * ⚠️⚠️ **`false` 必须写成 `['text']`，不能省略** —— 这是本次实测最重要的结论：
   * 上游对 `multimodal: false` 的模型**不报错，而是静默忽略图片**（GLM 5.1 甚至
   * 据此编造答案）。若省略（= 未知），DSH 会把图片一路放行到适配器，用户就会拿到
   * 一份**基于幻觉的、看起来正常的回答** —— 这是最难排查的一类失败。
   * 写 `['text']` 则让 DSH 在**附件准入阶段**就拒掉，用户当场得到「当前模型不支持图片」。
   *
   * ⚠️ 与 `model-catalog-parity.spec.ts` 的 `OMIT_UNKNOWN_MODALITIES` **必须同改**：
   * 那条用例按「真实适配器」双向断言，只改一处会变红并点名 accio。
   */
  private toCatalogEntry(model: AccioFallbackModel): CatalogEntry {
    const reasoning = accioReasoningOf(model)
    return {
      // ⚠️ **对外 id 是「人话」slug**（用户要求，2026-10-13）：上游 `modelCode`
      //    形如 `1Drift-…` 是内部代号，而 DSH 会把它注入给模型当身份 ⇒
      //    模型只能自报乱码。上行仍用 `modelCode`（见 `stream` 的 `accioModelCodeOf`）。
      id: accioModelIdOf(model),
      // 倍率写进 `name`（**不是** `description`）：composer 的模型切换菜单只渲染 name。
      name: displayNameOfAccioModel(model),
      // ⚠️ `resolveModel` 用**不带倍率**的裸名 ⇒ 显式提供 `bareName`。
      bareName: model.name,
      // ⚠️ 逐模型声明（判据见上）：`false` 是**明确不支持**，不是「未知」。
      inputModalities: model.supportsImage ? ['text', 'image'] : ['text'],
      ...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
      ...model.maxTokens !== undefined && Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0
        ? { maxTokens: model.maxTokens }
        : {},
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  /** 本家全部条目（远端优先，未落地时回退兜底表）。 */
  private catalogEntries(): readonly CatalogEntry[] {
    const source = this.remoteModels ?? this.product.fallbackModels
    return source.map((model) => this.toCatalogEntry(model))
  }

  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    await this.ensureRemoteModels()
    return this.catalogEntries()
  }

  /**
   * 同步视图（`listAllModels` 用）。
   *
   * ⚠️ **不能** `await ensureRemoteModels()`（同步契约）—— 读缓存，
   * 未落地时回退兜底表（否则冷缓存下返回空数组，设置页会把 provider
   * 误显示成「已关闭」）。
   */
  private syncCatalogEntries(): readonly CatalogEntry[] {
    return this.catalogEntries()
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(provider)
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolveModel(provider, model, signal)
  }

  /**
   * 全量目录（**不套用户黑名单**），带最终展示名（含倍率）。
   *
   * 设置页必须能渲染已关闭的模型（否则用户无法重新打开），而 `listModels`
   * 会按黑名单过滤掉它们 ⇒ RPC 层只能凭裸 id 补回、展示名与倍率随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。
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
   * 兼容 0.1.1-rc.2+：`LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`。**必须包它**（PR !66 的教训：
   * 包装适配器时漏了 `prepareCall` 会让凭据续期 / 模型解析走偏，
   * 且记账包装也会静默失效）。
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
    /**
     * 1. 图片：**收集 → 判定模型能力 → 读字节内联**（issue IKLR7V 接线，2026-10-14）。
     *
     * ## 为什么不再是「发现即抛」
     *
     * 本 provider 原先 `inputModalities` **恒省略**（= 未知 ⇒ DSH 不投影、图片一路走到这里），
     * 而本函数**显式抛 `UNSUPPORTED_CONTENT`**。两个保守选择叠加出的形态是
     * **每次带图都白撞一轮**（失败约 1 秒后切换下一个候选），且 accio 在聚合里
     * 被折算成「不支持图片」而被剔出候选表。
     *
     * 2026-10-14 真机实测（issue IKLR7V）推翻了这条前提：
     * - 上游**原生收图**，形状是 Gemini 风格的 `parts[].inline_data = {mime_type,data}`；
     * - `multimodal: true` 的模型**四色全对**（3/3 样本），`multimodal: false` 的模型
     *   **静默忽略图片**（3/3 样本：两家明说「没看到图片」，一家**幻觉**出答案）；
     * - 远端 15 条可见模型的 `multimodal` 字段**从不缺失**，且与兜底表 **100% 一致**。
     *
     * ⇒ 通路接通，且 `inputModalities` 按**逐模型**的 `supportsImage` 如实声明
     * （见 `toCatalogEntry`）。
     *
     * ## 三条判据（顺序不可换）
     *
     * 1. **递归收集**（共享 `collectImages`，它按 `tool-result` 下钻）—— 只扫顶层会漏掉
     *    工具结果内嵌图片，然后被序列化层静默丢掉（守卫形同虚设）；
     * 2. **模型能力**：`supportsImage !== true` ⇒ 显式报错。⚠️ 绝不能「照发不误」：
     *    实测 `multimodal: false` 的模型**不报错、而是静默忽略图片**（GLM 5.1 还
     *    据此**幻觉**出一份看似合理的答案）—— 那正是最难排查的静默失败形态；
     * 3. **附件服务**：未接线 ⇒ 显式报错（绝不静默退化成纯文本）。
     */
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let images: Map<string, { mediaType: string; data: string }> | undefined
    if (imageRefs.size > 0) {
      const sourceModels = this.remoteModels ?? this.product.fallbackModels
      const declared = sourceModels.find((model) => accioModelIdOf(model) === options.model)
        ?? sourceModels.find((model) => model.id === options.model)
      // ⚠️ 未知 id（用户手填）**保守拒绝**：能力无从得知，而「发过去被静默忽略」比报错更难查。
      //    （与 `toCatalogEntry` 的未知 id 处理一致：不编造能力。）
      if (declared?.supportsImage !== true) {
        throw new LlmError(
          `accio: 模型 "${options.model}" 不接受图片输入`
          + '（上游对声明 multimodal:false 的模型会**静默忽略图片**，'
          + '故这里显式拒绝而不是照发）。',
          'UNSUPPORTED_CONTENT',
        )
      }
      /**
       * ⚠️ **两个桥接都没接线时必须显式报错**（绝不退化成纯文本）：静默丢图会让
       * 用户以为模型看到了图。
       *
       * ⚠️ 判据是**两者皆缺**，不是「`readImage` 缺失」：只接了「请求版本」投影
       * （`readImageRequest`）也能完成内联 —— 那正是「优先缩放、拿不到才发原图」
       * 这条设计的正常形态。把它判成「需要附件服务」会让一个**能工作的配置**报错。
       */
      const readImage = this.options.readImage
      if (readImage === undefined && this.options.readImageRequest === undefined) {
        throw new LlmError(
          'accio: 图片输入需要附件服务（readImage / readImageRequest 均未提供）；'
          + '请确认当前 profile 已装载 @deepseek-ai/dsh-attachment-local。',
          'UNSUPPORTED_CONTENT',
        )
      }
      images = new Map()
      for (const [id, ref] of imageRefs) {
        // ⚠️ 先试**请求版本**（按像素预算缩放，`ACCIO_IMAGE_PIXEL_BUDGET` 正是为此定义）；
        // 拿不到才发原图。缩放的合理性与「为什么预算做成固定值」见 `src/image-budget.ts`。
        const projected = await projectRequestImage(ref, {
          readImageRequest: this.options.readImageRequest,
          pixelBudget: ACCIO_IMAGE_PIXEL_BUDGET,
        })
        let inline = projected
        if (inline === undefined && readImage !== undefined) {
          try {
            inline = await readImage(ref)
          } catch (error) {
            // 读取抛错必须冒泡成明确的 LlmError（与 buddy 同口径）：吞掉会表现为
            // 「图片凭空消失、模型答非所问」。
            throw new LlmError(
              `accio: 读取图片附件失败（${id}）：${errorMessage(error)}`,
              'UNSUPPORTED_CONTENT',
              { cause: error as Error },
            )
          }
        }
        if (inline === undefined || inline.data.byteLength === 0) {
          throw new LlmError(
            `accio: 图片附件读取不到内容（${id}）；附件服务可能未就绪，或该对象已不存在。`,
            'UNSUPPORTED_CONTENT',
          )
        }
        images.set(id, {
          mediaType: inline.mediaType === '' ? 'image/png' : inline.mediaType,
          data: Buffer.from(inline.data).toString('base64'),
        })
      }
    }

    /**
     * 1b. ⚠️⚠️ **`options.model` 是「人话」slug，上行的 body 必须用上游 `modelCode`**。
     *
     * 对外 id 自 2026-10-13 起是 slug（`qwen-3-8-flash`），因为 DSH 把
     * `CatalogEntry.id` 注入给模型当身份 —— 用上游代号会让模型只会自报乱码
     * （用户追问「为什么不是标准模型 id」）。
     *
     * ⚠️ 但**上游只认 `modelCode`** ⇒ 这里必须映射回去。漏了这一步的后果：
     * 请求体带上 slug、服务端不认，症状是「模型不回复」这种**极具误导性**的形态
     * （不是参数错误）。故本行是**功能承重**，不是装饰。
     *
     * ⚠️ 未知 id **原样透传**（`accioModelCodeOf` 的语义）：用户手填的 id 应由
     * 上游报错，本地不得静默改成空模型名。
     */
    const sourceModels = this.remoteModels ?? this.product.fallbackModels
    const wireModel = accioModelCodeOf(sourceModels, options.model)

    // 2. 凭据（过期则先静默续期）。
    // ⚠️ 传 `options.model`：多账号池按它过滤限流账号（与 trae 同因）。
    let credential = await this.options.resolveCredential(options.model, options.sessionId)
    if (credential === undefined || isAccioExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model, options.sessionId)
    }
    if (credential === undefined || credential.access_token === '') {
      throw new LlmError('accio: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 3. 记录当前账号（Token 账本用；失败不影响请求）。
    //
    // ⚠️⚠️ **账号 id 必须是可变局部量，不是常量**（2026-10-18，issue IKM3ZV 修复）：
    // 下面第 6 步的换号循环会换到另一个账号，而 `resolveCredential` 只在**首次**
    // 调用（它返回「池当前会给出的那个」，换号后**不会跟着变**）⇒ 若继续用这里
    // 的常量，冷却标记与账本都会**记到无辜账号头上**，而真正耗尽的号永不被标记
    // ⇒ 下次请求又选中它（minimax / zcode 记过的同款事故）。
    let currentAccountId = ''
    if (this.options.accountPool !== undefined) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id,
          credential.access_token,
        )
      } catch { /* 账号不匹配不影响请求 */ }
    }
    if (currentAccountId !== '') reportLedgerAccount(this.product.id, currentAccountId)

    // 4. 会话命名的思考与预算决策（issue IKKVDH）。
    // ⚠️ Accio **关不掉思考**（实测四类字段全部无效，见文件头第 3 条）⇒
    // `declaredEfforts` 恒为空 ⇒ 走 `planSessionTitleThinking` 的**抬预算**分支
    // （64 → 512），否则思考会把 64 token 吃满、正文零产出、标题静默失败。
    const titlePlan = planSessionTitleThinking({
      purpose: options.purpose,
      requestedEffort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      declaredEfforts: [],
      maxTokens: options.maxTokens,
    })

    // 5. 构造信封。
    //
    // ⚠️ **必须先经 `toAccioWireMessages`** 把 DSH 原生块转成 OpenAI 传输形状：
    // `serializeAccioMessages` 读的是 `tool_calls[]` / `tool_call_id` / `name`，
    // 原生块里这三个字段一个都不存在（见该函数的说明 —— 后果是工具调用与
    // 工具结果**全字段静默丢失**）。
    const requestId = accioRequestId()
    const wireMessages = toAccioWireMessages(
      options.messages as unknown as readonly { role: string; content?: unknown }[],
    )
    /**
     * ⚠️ `options.system` 是 `GenerateOptions` 的**独立字段**，不在 `messages` 里。
     * `serializeAccioMessages` 只从 messages 里抽 system ⇒ 不显式插进去，
     * system prompt 会被**整体静默丢弃**（模型收不到任何系统指令）。
     */
    if (options.system !== undefined && options.system !== '') {
      wireMessages.unshift({ role: 'system', content: options.system })
    }
    // ⚠️ `images` 为 `undefined` 表示**本请求无图** ⇒ `serializeAccioMessages`
    // 走原来的纯文本路径（线上格式逐字节不变）。
    const { contents, systemInstruction } = serializeAccioMessages(wireMessages, images)
    const body = buildAccioBody({
      // ⚠️ **上行用 `wireModel`（= 上游 `modelCode`），不是 `options.model`（slug）** ——
      //    见上面 1b 的说明。这是本次改动最容易漏、且后果最隐蔽的一处。
      model: wireModel,
      accessToken: credential.access_token,
      contents,
      systemInstruction,
      // ⚠️ `toAccioTools` 同样吃 **OpenAI 形状**（`{type:'function',function:{…}}`），
      // 而 DSH 给的是**扁平** `ToolSchema`（`{name,description,parameters}`）——
      // 不包一层会得到 `undefined`（工具一个都不下发）。
      tools: toAccioTools((options.tools ?? []).map((tool) => ({
        type: 'function' as const,
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))),
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      // ⚠️ `maxOutputTokens` **必须下发**（不能只用来过滤）。
      ...titlePlan.maxTokens === undefined ? {} : { maxOutputTokens: titlePlan.maxTokens },
      utdid: this.utdid,
      requestId,
    })
    /**
     * ⚠️ **`system_instruction` 必须是字符串**（实测缺陷，见文件头第 1 条）。
     *
     * ⚠️ **源头已修**：`buildAccioBody` 初版产出 Gemini 风格对象 `{parts:[{text}]}`，
     * 而 Accio 的推理端点**只接受字符串** —— 对象形态实测**恒**回
     * `HTTP 200 + 流内 {"error_code":"400","error_message":"Invalid request format"}`，
     * 症状是「模型没返回内容」而不是参数错误（极具误导性）。
     * **commit `3034d03`** 已把该纯函数改成直接产出字符串，
     * `tests/unit/accio-product.spec.ts` 也同步锁定字符串形态。
     *
     * ⇒ 这里的改写**保留为纵深防御**（不改写也正确）：把「wire 上该键必为字符串」
     * 这条硬约束显式落在适配器里，纯函数或上游形状若再次漂移仍能兜住。
     * **刻意不删。**
     */
    if (systemInstruction !== '') body.system_instruction = systemInstruction
    else delete body.system_instruction
    if (options.stop !== undefined && options.stop.length > 0) body.stop_sequences = options.stop

    // 6. 发送 + **请求级账号轮换**（issue IKM3ZV）。
    //
    // ⚠️⚠️ **换号前必须把新令牌写回 body**（真实缺陷，2026-10-13 修）：
    // 令牌在 `body.token` 里，而 `send()` 只从 `credential` 取 `sgcookie` 头 ⇒
    // 不更新 body 就是「刷新/换号后重发旧 token」，该分支**结构性失效**
    // （且 `AUTH` 不在 harness 的可重试集合里，兜不住）。
    // 用 {@link applyAccessToken} 与初次构造走**同一条**落点，避免第二处写法漂移。
    //
    // ## 两层重试，各司其职（issue 的核心诉求）
    //
    // | 层 | 触发 | 上界 | 谁负责 |
    // |---|---|---|---|
    // | **账号级** | 401/402/403/429 | 可用账号数（`tried` 保证） | 本循环 |
    // | harness 级 | 其余可重试码 | 5 次 / 约 15.5s | DSH `DEFAULT_RETRYABLE_CODES` |
    //
    // 修复前只有第二层，而 402 被刻意归 `QUOTA_EXCEEDED`（**不**在 harness 的
    // 可重试集合里）⇒ 确定性失败被原样冒泡成整轮失败。
    //
    // ⚠️ **401/403 的「刷新一次再重发」保留在最前面**：本家凭据可能被服务端
    // 提前撤销而本地 `expiresAt` 仍在未来，续期救得回来的号不该被当成坏号轮换掉。
    // 续期仍失败才落到换号（与 loomy / raccoon / minimax 的顺序一致）。
    applyAccessToken(body, credential.access_token)
    /** 已试过的账号 id；换号时传给池做排除（见 `AccountPool.getAvailableAccount`）。 */
    const tried = new Set<string>()
    if (currentAccountId !== '') tried.add(currentAccountId)

    /**
     * 给**当前**账号记冷却（额度至 UTC+8 当日 24:00 / 限流 1h；认证类绝不记）。
     *
     * ⚠️ 必须在**每次失败后立刻调用**（含第一次、也在轮换预算用尽之前），不能挪到
     * 循环开头：那样最后一个失败账号永远等不到下一次迭代，就此漏记（minimax 记过：
     * 8 账号全耗尽时只记 7/8，末号漏记 ⇒ 下次请求又选中它）。
     */
    const markCurrentAccount = async (failureCode: string): Promise<void> => {
      if (this.options.accountPool === undefined) return
      if (currentAccountId === '' || !recordsAccioRateLimit(failureCode)) return
      /**
       * ⚠️⚠️ **记账失败绝不能中断换号**（对抗审计 P2-1，2026-10-18 实证）。
       *
       * 池的写盘失败（磁盘满 / 权限）会抛裸 `Error`；若不隔离，它会冒到
       * `rotate()` 之前 ⇒ **整个轮换流程被掐断** ⇒ 一次写盘失败就退化成
       * 「零换号」—— 正是本 issue 要修的那个症状。
       *
       * ⇒ 两道纪律：① `try/catch` 隔离；② **即便记账失败也照常换号**
       *   （记账是「锦上添花」，换号是「本轮能不能成」）。
       */
      try {
        await this.options.accountPool.updateModelRateLimit(
          currentAccountId,
          options.model,
          accioFailureClassOf(failureCode) === 'quota'
            ? nextUtc8DayStartMs()
            : Date.now() + ACCIO_RATE_LIMIT_COOLDOWN_MS,
        )
      } catch {
        // ⚠️ 记账失败**如实留日志**（静默吞掉会让「号没被标记」变成不可排查的
        // 现象 —— 本仓库记过多次同款）。拿不到 logger 时用 console.warn 兜底。
        const detail = `accio: 写入限流标记失败（账号 ${currentAccountId} / 模型 ${options.model}）`
        if (typeof console !== 'undefined') console.warn(detail)
      }
    }

    /** 发一次；HTTP 401/403 时续期当前账号并重发一次。 */
    const sendOnce = async (): Promise<Response> => {
      // ⚠️ `credential!` 的非空断言是**必需**的：TS 不把上面 `if (credential === undefined) throw`
      // 的收窄带进闭包（`credential` 是 `let`，闭包捕获的是可变量）。
      // ⚠️ 断言**安全**的原因是可判定的：进入本闭包之前已抛错退出 ⇒ 此处恒非空。
      const sent = await this.send(credential!, body, options)
      if (sent.ok || (sent.status !== 401 && sent.status !== 403)) return sent
      // ⚠️⚠️ 续期后**必须重新反查账号 id**（minimax `51ded6a` / loomy 同款）：
      // 续期走的是**池内第一个可用账号**（见 `src/index.ts` 的 accio `refresh`），
      // 二者可能不是同一个号 ⇒ 续期后取回的凭据属于另一个账号，而
      // `currentAccountId` 还停在旧号上，冷却标记会**记到无辜账号头上**
      // （没耗尽的被封、真该封的下次仍被选中）。
      /**
       * ⚠️ **续期抛错降级为「没有新凭据」**（对抗审计 P2-1）：`refresh()` 失败时
       * 裸 `Error` 会冒泡、丢掉 `AUTH` 语义。⇒ 返回 `sent`（原响应），
       * 由调用方按原始错误（401/403）如实处理。
       */
      try {
        await this.options.refresh()
      } catch (error) {
        console.warn(`accio: 续期失败（不阻断本轮）：${errorMessage(error)}`)
        return sent
      }
      const refreshed = await this.options.resolveCredential(options.model, options.sessionId)
      if (refreshed === undefined || refreshed.access_token === '') return sent
      /**
       * ⚠️⚠️ **反查必须先于 `credential` 赋值**（对抗审计 P1-2，2026-10-18 实证）。
       *
       * 旧顺序（`credential = refreshed` 在前、反查在后且 `catch {}` 静默）会造出
       * 三处状态错位，**全部可复现**：
       *   ① `credential` 已是新号、`currentAccountId` 却停在旧号 ⇒ 后续冷却
       *      **记到无辜账号头上**，而真正失败的号永不被标记；
       *   ② `tried` 没加新号 ⇒ `rotate()` 可能把它取回来 ⇒ **同一 token 重发**；
       *   ③ 「已发出请求的账号」与「被记账的账号」不一致 ⇒ 用户看到「登录了
       *      2 个号却只有 1 个可用」。
       *
       * ⚠️ **可达性不是假设**：`findAccountIdByCredential` 在账号被停用、或
       * `access_token` 因并发续期已轮换（`accio-auth.ts` 记着「每次都会轮换」）
       * 时都会返回 `''` ⇒ 走的正是这条分支。
       */
      let nextAccountId = currentAccountId
      let reverseLookupOk = false
      if (this.options.accountPool !== undefined) {
        try {
          const resolved = await this.options.accountPool.findAccountIdByCredential(
            this.product.id, refreshed.access_token,
          )
          if (resolved !== '') {
            nextAccountId = resolved
            reverseLookupOk = true
          }
        } catch { /* 反查失败不阻断主路径：见下面的降级处置 */ }
      } else {
        reverseLookupOk = true   // 无池 ⇒ 没有账号 id 这条腿，视为「无需更新」
      }
      if (reverseLookupOk && nextAccountId !== currentAccountId) {
        /**
         * ⚠️⚠️ **只「加」新账号，绝不「删」旧账号**（对抗审计复核时发现的真缺陷）。
         *
         * 旧写法是 `tried.delete(currentAccountId); tried.add(nextAccountId)`
         * —— `delete` 的意图是「让池能重新取到新账号」，但它**把旧账号从已试集里
         * 摘掉了** ⇒ 旧账号（acc-1，那个刚回 401 的）**重新变成可取回候选**
         * ⇒ 后续 `rotate()` 会把它再取回来 ⇒ **同一个 token 重发**。
         *
         * ⚠️ 实测（`accio-account-rotation.spec.ts` 的「续期后的账号反查」那条）
         * token 序列从 `[A, B, C]` 退化成 `[A, B, A, C]` —— `A` 被发两次。
         *
         * ⇒ 正确处置：`tried` 是「**本轮已试过的账号**」，只会**单调增长**。
         * 换到新账号时**加**它即可；旧账号必须**留在**集里（它确实试过、且失败了）。
         */
        tried.add(nextAccountId)
        currentAccountId = nextAccountId
        reportLedgerAccount(this.product.id, currentAccountId)
      } else if (!reverseLookupOk) {
        /**
         * ⚠️⚠️ **反查失败 ⇒ 整段放弃这次续期重发**（对抗审计 P1-2 的正解）。
         *
         * 此刻我们知道 `refreshed` 属于**某个**账号，但**不知道是哪个**。
         * 若照样换上它发出去，就会造出「**发请求的账号**」与「**被记账的账号**」
         * 分裂 —— 后果有两条，都实测过：
         *   ① 后续冷却记到**无辜账号**头上，真凶漏记；
         *   ② 该账号不在 `tried` 里 ⇒ `rotate()` 会把它取回来 ⇒ **同一 token 重发**
         *      （新增守卫实测序列 `['TOK-A','TOK-B','TOK-B']`）。
         *
         * ⇒ 正确处置是**不重发**：把原响应（401/403）退回给调用方，由它按
         * **账号级错误**走「记账 + 换号」—— 那条路径的 `currentAccountId` 是
         * **可判定的**（就是 `currentAccountId` 本身）。宁可这次换号慢一拍，
         * 也不要用一个「不知道属于谁」的凭据发请求。
         */
        return sent
      }
      credential = refreshed
      applyAccessToken(body, refreshed.access_token)
      return await this.send(credential, body, options)
    }

    /**
     * 取下一个账号并重发；成功则返回新响应，不可换号或没有下一个则返回 `undefined`。
     *
     * ⚠️ **必须传真实 modelId 且传 `tried`**：
     * - 传空串会让限流过滤整体短路（`if (modelId.length === 0) return true`），
     *   刚标记的账号立刻又被选中 —— 换号形同虚设（trae 记过的用户报障）；
     * - 不传 `tried` 会在 A/B 之间反复空转（qoder 踩过，见
     *   `qoder-adapter.ts` 的 `switchAccountOnQuota` 注释）。
     */
    const rotate = async (): Promise<Response | undefined> => {
      if (this.options.accountPool === undefined) return undefined
      /**
       * ⚠️ **取号失败（池抛错）降级为「无可换账号」而非冒泡**（对抗审计 P2-1）。
       *
       * 池读盘失败时抛的是裸 `Error`（不在 harness 的可重试码里）⇒ 直接冒泡会让
       * 用户看到 `POOL BOOM` 这种内部串，且**丢掉 `QUOTA_EXCEEDED` 语义**
       * （额度耗尽被伪装成内部错误）。
       * ⇒ 降级成「换不到号」⇒ 由调用方按**原始错误**如实抛出。
       */
      let next: { entry: { id: string; credentialRef: string }; credential: AccioCredential } | null
      try {
        next = await this.options.accountPool.getAvailableAccount<AccioCredential>(
          this.product.id, options.model, tried,
        )
      } catch (error) {
        console.warn(`accio: 从账号池取下一个账号失败：${errorMessage(error)}`)
        return undefined
      }
      if (next === null || next === undefined || tried.has(next.entry.id)) return undefined
      tried.add(next.entry.id)
      /**
       * ⚠️ 池里的凭据是**裸 `JSON.parse`**（`AccountPool.getAvailableAccount`
       * 不做形状校验），手工编辑过的备份 / 损坏条目可能是 `{}`。
       * ⇒ 判空后**继续换下一个**而不是放弃整池（minimax 的同款修复：
       * 写成 `next.credential.access_token.length` 会抛 `TypeError`（非 `LlmError`）
       * 且用 `break` ⇒ 一个坏号把整个轮换掐断）。
       */
      if (typeof next.credential?.access_token !== 'string'
        || next.credential.access_token === '') return await rotate()
      credential = next.credential
      currentAccountId = next.entry.id
      reportLedgerAccount(this.product.id, currentAccountId)
      applyAccessToken(body, credential.access_token)
      return await this.send(credential, body, options)
    }

    let response = await sendOnce()

    /**
     * ⚠️ **空 body 早抛，且刻意只在 `response.ok` 时判**。
     *
     * 非 2xx 的响应 body 可能是 `null`（HEAD / 204 / 某些 4xx）—— 那不是
     * 「空响应」而是「错误响应」，必须让下面的段①按状态码分类，**否则一个
     * 402 会被误报成 `EMPTY_RESPONSE`、丢掉额度语义**（`other` 类不换号）。
     */
    if (response.ok && response.body === null) {
      throw new LlmError('accio: empty model response body', 'EMPTY_RESPONSE')
    }
    /**
     * ⚠️⚠️ **必须校验 `content-type`：HTTP 200 也可能是一张风控拦截页**
     * （2026-10-13 真机实测发现，与本仓库记过的「流内 402 被 HTTP 200 掩盖」同型）。
     *
     * ## 现象
     *
     * 请求**不带 `utdid`**（或只放 header 不放 `properties.utdid`）时，阿里网关回：
     * - **HTTP `200`**（不是 4xx！）；
     * - `content-type: text/html;charset=UTF-8`；
     * - body 是一段跳转脚本：`<a id="a-link" href="https://bixi-intl.alicdn.com/punish/…">`
     *   + `window._config_ = {"action":"deny",…}` + `<!--rgv587_flag:sm-->`。
     *
     * ## 不校验的后果（**静默**）
     *
     * 这段 HTML 会被喂给 SSE 解析器 ⇒ **一帧都解析不出来** ⇒ 最终报
     * 「模型未返回任何内容块」。用户看到的是「模型不回复」，而真因是**风控**，
     * 排查方向完全错（本轮实测就曾被它误导成「档位无效」）。
     *
     * ## 为什么判 `content-type` 而不是判 body 文本
     *
     * 正常响应恒为 `text/event-stream`（实测）；而 body 文本的形态（脚本内容、
     * 域名、标记）都可能变 —— 判结构比判内容稳。
     *
     * ⚠️ 归类 `SERVER`（**不重试**）：风控是**身份/环境**问题，原样重发只会
     * 再被拦（与 `trae-adapter.ts` 的 4006 不重试同理）。
     *
     * ⚠️ **刻意抽成函数**：换号后取回的响应也要走同一格（换号后拿到风控页
     * 完全可能），而流内换号与 HTTP 换号是同一个循环里的两段 —— 判据必须
     * 只有一份，否则两段会漂移（这是「同一语义两套判据」的本仓库首条红线）。
     */
    const assertEventStream = async (target: Response): Promise<void> => {
      const contentType = target.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) return
      // ⚠️ 读 body 只为**把服务端原文带给用户/日志**（诊断用），失败不影响判据。
      const peek = await target.text().catch(() => '')
      throw new LlmError(
        `accio: 上游未返回事件流（content-type: ${contentType || '(空)'}）——`
        + `通常是被风控拦截（网关返回 200 + HTML 拦截页）。`
        + `${peek === '' ? '' : ` 服务端原文：${peek.slice(0, 200)}`}`,
        'SERVER',
        { status: target.status },
      )
    }
    // ⚠️ **刻意不在这里先 `await assertEventStream(response)`**：
    // 首次响应可能压根不是 2xx（`!ok`），而 `assertEventStream` 会把任何
    // 非 SSE 响应判成「风控拦截页」（`SERVER`）⇒ 402/400 的真实分类被覆盖。
    // 它只在下面循环的 ② 格（**已确认 2xx 之后**）被调用。

    // 7. 消费 SSE —— **含流内账号级错误的换号**（issue IKM3ZV）。
    //
    // ⚠️ **流内 402 由 `consumeAccioSse` 抛 `QUOTA_EXCEEDED`**（HTTP 仍是 200），
    // 而这恰恰是本家**最常见的额度失败形态**（上游把 402 包在 SSE 帧里回，
    // 实测 `{"turn_complete":true,"error_code":"402","error_message":"unauthorized"}`）。
    // ⚠️ **绝不 catch-and-rewrap** —— 重包会丢掉额度语义、把它降级成
    // 「模型没返回内容」（Task 3 修过的真实缺陷）。
    //
    // ⚠️ **只有「尚未产出任何 chunk」才允许换号重发**：换号会**重放整次请求**，
    // 而新的 `consumeAccioSse` 是**全新生成器** ⇒ 已产出正文后再换号，用户会
    // 看到两份内容被拼在一起（比不换号更糟），且工具会被执行两次
    // （lobsterai 记过同款事故：`https://example.invalid` 真实被点了两次）。
    const consumeOnce = async function* (
      target: Response,
    ): AsyncGenerator<StreamChunk, void, undefined> {
      const body = target.body
      if (body === null) throw new LlmError('accio: empty model response body', 'EMPTY_RESPONSE')
      // ⚠️ 工具调用分片先经 `accioToolCallMergeTransform` 合并（见该函数的说明）。
      const merged = body.pipeThrough(accioToolCallMergeTransform())
      yield* consumeAccioSse({
        body: merged,
        ...options.signal === undefined ? {} : { signal: options.signal },
        idleTimeoutMs: ACCIO_SSE_IDLE_TIMEOUT_MS,
      })
    }

    /**
     * ⚠️⚠️ **一个循环，两段**（这是本实现最关键的结构决定，2026-10-18）。
     *
     * 初版写成「HTTP 层换号循环 + 流内换号循环」两个独立 `for` ⇒ 实测三条
     * 用例被打穿（全部有牙）：
     *
     * | 症状 | 根因 |
     * |---|---|
     * | 流内 402 换号后取回的账号**在 HTTP 层就失败** ⇒ 报「模型未返回任何内容块」 | 流内循环把 `!ok` 的响应直接塞回 `consumeOnce`，它于是去读一个 402 的 JSON 体当 SSE |
     * | 已产出内容后遇流内 402 ⇒ **连冷却都不记** | 同上：内容在错误分类前就被绕过了 |
     * | 坏凭据被跳过后**整池不再换号** | 两个循环各自计数，预算被重复消耗 |
     *
     * ⇒ 合并后 HTTP 失败与流内失败走**同一条**「记账 + 换号」路径，
     * `round` 也只有**一个**预算。两条通道的差异只剩「错误码从哪来」。
     */
    let producedAny = false
    for (let round = 0; ; round++) {
      // ── ① HTTP 层 ──
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const code = httpErrorCode(response.status)
        // ⚠️ 非账号级 ⇒ 原样抛（不再往下走流内格）。
        if (!shouldRotateAccioAccount(code)) {
          throw new LlmError(`accio: ${errorDetail(text)}`, code, { status: response.status })
        }
        // ⚠️ **必须在 `rotate()` 之前无条件记账**（不只是预算用尽那一格）：
        // 挪到换号之后 ⇒ 换号成功时当前账号**永不被标记** ⇒ 下次请求又选中它
        // （「卡死在一个号上」的残余形态）。
        await markCurrentAccount(code)
        if (round >= ACCIO_MAX_ROTATE - 1) {
          throw new LlmError(`accio: ${errorDetail(text)}`, code, { status: response.status })
        }
        const rotated = await rotate()
        if (rotated === undefined) {
          throw new LlmError(`accio: ${errorDetail(text)}`, code, { status: response.status })
        }
        response = rotated
        // ⚠️ **必须 `continue` 回顶部重新判 HTTP 层**：换到的账号可能又在
        // HTTP 层失败（这是实测打穿的那一格）。
        continue
      }
      if (response.body === null) {
        throw new LlmError('accio: empty model response body', 'EMPTY_RESPONSE')
      }
      // ── ② content-type + 流内 ──
      try {
        await assertEventStream(response)
        for await (const chunk of consumeOnce(response)) {
          producedAny = true
          yield chunk
        }
        return
      } catch (error) {
        const code = error instanceof LlmError ? error.code : ''
        // ⚠️ 三条早退，缺一不可：
        // ① **已产出内容** ⇒ 换号会重放请求、拼正文、重复执行工具 ⇒ 如实抛；
        // ② **用户取消**（`aborted` 但 `reason` 不一定带语义）⇒ 不换号；
        // ③ **非账号级错误**（参数错 / 5xx / 风控）⇒ 换号无益、白烧整池。
        if (producedAny) {
          // ⚠️ **已产出内容后仍必须记账**（否则这个已明确失败的账号永不被冷却，
          // 下次请求又选中它 —— 「卡死在一个号上」的残余形态）。
          if (!options.signal?.aborted && code !== '') await markCurrentAccount(code)
          throw error
        }
        if (options.signal?.aborted === true) throw error
        if (!shouldRotateAccioAccount(code)) throw error
        await markCurrentAccount(code)
        if (round >= ACCIO_MAX_ROTATE - 1) throw error
        const rotated = await rotate()
        if (rotated === undefined) throw error
        response = rotated
      }
    }
  }

  /** 发起一次推理请求；网络失败映射为可重试的 `TRANSPORT`。 */
  private async send(
    credential: AccioCredential,
    body: Record<string, unknown>,
    options: GenerateOptions,
  ): Promise<Response> {
    const requestId = String(body.request_id)
    const url = `${this.product.gatewayBaseUrl}${ACCIO_LLM_PATH}?sg_k=${accioSgK(requestId)}`
    const headers = accioHeaders({
      utdid: this.utdid,
      ...credential.sgcookie === undefined ? {} : { sgcookie: credential.sgcookie },
    })
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`accio: transport error: ${errorMessage(error)}`, 'TRANSPORT', {
          cause: error as Error,
        })
      }
      throw error
    }
  }
}

/**
 * 在 `ctx.llm` 上注册 Accio provider 路由与适配器。
 */
export function registerAccioLlm(ctx: Context, options: AccioAdapterOptions): AccioAdapter {
  const product = options.product ?? ACCIO
  const adapter = new AccioAdapter({
    ...options,
    // ⚠️ 注入**唯一**的广播实现（`src/catalog-broadcast.ts`），不要在这里
    // 另写一份 emit —— 两份实现必然漂移。
    onCatalogLoaded: () => broadcastCatalogChanged(ctx),
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  // 返回实例：Jet Hub 的「显示列表」需要它的 `listAllModels()`。
  return adapter
}
