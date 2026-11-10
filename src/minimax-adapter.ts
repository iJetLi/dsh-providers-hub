/**
 * MiniMax Code 模型适配器。
 *
 * ## 推理已实现（2026-09-29，真实请求验证）
 *
 * 走 **Anthropic Messages** 协议（`POST {apiHost}/mavis/api/v1/llm/v1/messages`），
 * 请求体构造与 SSE 消费在 `src/minimax-messages.ts`。
 *
 * 实测（4 个模型全部 HTTP 200，文本 / 思考 / 工具调用均正常）：
 * - `MiniMax-M3.1-Flash-Preview`：**必须** `thinking.type='adaptive'`，
 *   档位走 `output_config.effort`；传 `disabled` ⇒ `400 ... (2013)`。
 * - `M3` / `M2.7` / `M2.7-highspeed`：**不发 thinking 即接受**，
 *   且服务端默认会思考（M2.7 实测 `thinking_tokens: 250`）。
 *
 * ## 两个必须记住的口径
 *
 * 1. **窗口取档位表最大档**：`MiniMax-M3.1-Flash-Preview` 的 `limit.context`
 *    是 512000，但 `context_window_options` 是 `[512000, 1000000]`。
 *    填 512K 会让 DSH 远早于官方能力触发压缩（与 Qoder 同口径）。
 * 2. **只有 M3.1-Flash-Preview 有档位**：其余三个远端没有 `effort_options`。
 *    给它们编档位就是凭空猜测（Qoder 同型教训）。
 *
 * ## ⚠️ 未实现：图片
 *
 * `MiniMax-M3.1` / `M3` 的目录条目声明支持图片（`supportsImage: true`，
 * 用于 `inputModalities` 播报），但**带图请求未实测**，
 * 故 `serializeMinimaxMessages` 遇到 image 块**显式抛错**（不静默丢弃）。
 * 静默丢弃会让用户以为图片被模型看到了。
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { createModelCatalog, isCatalogFresh, isCatalogFreshFor, type CatalogEntry, type ModelCatalog } from './model-catalog.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import type { AccountPool } from './account-pool.js'
import { httpErrorCode, collectImages } from './openai-compat.js'
import { MINIMAX, MINIMAX_INFER_PATH, type MinimaxProduct } from './minimax-product.js'
import { describeMinimaxGeoRoute, minimaxInferHeadersFor } from './minimax.js'
import { planSessionTitleThinking } from './session-title.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import {
  buildMinimaxMessagesPayload,
  consumeMinimaxSse,
  type MinimaxInlineImage,
} from './minimax-messages.js'
import {
  isMinimaxExpiringWithin,
  minimaxFallbackEntries,
  minimaxFetch,
  type MinimaxCredential,
  type MinimaxModelEntry,
} from './minimax.js'

/**
 * 请求前预判的**最小剩余有效期**（2026-10-24 本地试验版）。
 *
 * 旧判据是 `isMinimaxExpired`（已过期才续）—— 401 都发出去一轮了才补。
 * 改成「剩余不足 60s 就先续」，与官方 `oauth-core` 的
 * `getAccessToken({minValidityMs})` 同语义：让 token 在**临死前**换新，
 * 而不是让用户的请求撞在正在死掉的 token 上。60s 取官方 30s 的两倍宽：
 * 一次续期 grant 实测 ~300ms，60s 足够覆盖慢网络下的整轮续期。
 *
 * ⚠️ 巡检（60s tick、5min margin）正常在跑时，这里的命中应**接近于零**；
 * 命中变多说明巡检没跟上（宿主刚唤醒 / 巡检被阻塞），它兜的是那个底。
 */
const MINIMAX_ONDEMAND_MIN_VALIDITY_MS = 60_000

/**
 * 前缀识别「必须 adaptive thinking」的模型。
 *
 * ⚠️ 按**前缀**而非全等：`MiniMax-M3.1-Flash-Preview` 是 preview 名，
 * 正式版可能叫 `MiniMax-M3.1`，前缀能同时覆盖两者；
 * 而 `MiniMax-M3` **不能**被这个前缀命中（它不需要 adaptive，实测 200）——
 * 故必须是 `M3.1` 而不是 `M3`。
 */
const MINIMAX_ADAPTIVE_ONLY_PREFIX = 'MiniMax-M3.1'

/**
 * 由模型条目构造 DSH 的思考档位声明。
 *
 * ⚠️ 返回 `undefined` 表示**不声明** `reasoning` —— DSH 的档位选择器会显示
 * 「当前模型未提供推理等级」（对应官方 IDE 的「不支持」）。
 *
 * ## ⚠️ 两种能力都要表达（2026-09-29 补的真实缺口）
 *
 * 远端 `thinking_config.mode` 实测三种值，**语义完全不同**：
 *
 * | 模型 | `mode` | `effort_options` | 实测行为 |
 * |---|---|---|---|
 * | M3.1-Flash-Preview | `forced_on` | ✅ 6 档 | 传 `disabled` **硬 400**（2013） |
 * | **M3** | **`switchable`** | ❌ 无 | 不传/`disabled` → **0 思考块**；`adaptive` → 有 |
 * | M2.7 / M2.7-highspeed | `forced_on` | ❌ 无 | 传 `disabled` **静默忽略**（仍有思考） |
 *
 * ⚠️ **初版只看了 `effort_options`，于是 M3 被声明成「无推理等级」**
 * —— 而它**实际可以开关思考**（真机实测）。那是**功能缺失**：
 * 用户在 UI 上无法为 M3 关闭思考。
 *
 * 修法（照客户端 `thinking.js` 的**权威词汇**）：
 * - `efforts` 取远端 `effort_options`（只有 M3.1 有）；
 * - `thinkingMode === 'switchable'` 时给出**开/关两态**：
 *   `on`（→ `thinking:{type:'adaptive'}`）与 `none`（→ `{type:'disabled'}`）；
 *   ⚠️ **数组顺序是 `none` 在前、`on` 在后**（强度序，见下）。
 *   ⚠️ 客户端用的就是 `on` / `off` 这两个词
 *   （`isMiniMaxM3ThinkingMode`：`value === 'on' || value === 'off'`），
 *   `off` 在 DSH 侧的惯用名是 `none`（Qoder 的「关闭思考」也用 `none`）；
 * - 两者皆无 ⇒ `undefined`（不声明）。
 *
 * ⚠️⚠️ **必须给 `on`，不能只给 `none`**（我第一版就只给了 `none`）：
 * 实测 M3 **不发 `thinking` 时默认「不思考」**（两轮各 0 字符），
 * 而 `adaptive` 有 **2785 / 2797** 字符。若只声明 `none`，用户**只能关、无法开**
 * —— 那比不给选项更糟（把模型的强项藏起来了）。
 *
 * ⚠️⚠️ **这两个档位的追加顺序是 `none` → `on`（强度序），不是 `on` → `none`**
 *（Issue IKLIDV）：DSH 把 `reasoning.efforts` 当**展示顺序**、客户端**直接 `map`
 * 不排序** ⇒ 原写法会让「开启」落在横向档位轴的最左（左强右弱）。
 * 详见函数体内 `switchable` 分支的注释。
 *
 * ⚠️ `forced_on` 的模型**绝不**追加任何开关：M3.1 会硬 400，
 * M2.7 会被静默忽略（那会让用户以为关掉了、实际没关）。
 *
 * ⚠️ **展示名**：远端档位用原文字面量（官方 IDE 就是 `default` / `low` / …），
 * 但 `on` / `none` 是我们**追加**的（远端没有这两个名字），给中文名
 * 「开启思考」/「关闭思考」以免用户看不懂。
 */
export function minimaxReasoningInfo(
  entry: MinimaxModelEntry,
): LlmModelReasoningInfo | undefined {
  const options = entry.effortOptions
  const switchable = entry.thinkingMode === 'switchable'
  // ⚠️ 两种能力任一存在就要声明；只有两者皆无才返回 undefined。
  if ((options === undefined || options.length === 0) && !switchable) return undefined
  const ids = [...(options ?? [])]
  if (switchable) {
    // ⚠️ 顺序：**先 `none` 后 `on`**（= 强度序，弱 → 强），Issue IKLIDV。
    //
    // ⚠️⚠️ 原实现是**先 `on` 后 `none`**，理由是「DSH 按数组顺序渲染，把默认档
    // 放前面更符合直觉」。那个动机只在**纵向列表**里成立：DSH 实际把该数组当
    // **展示顺序**（`dsh-llm/lib/types/types.d.ts`：`adapter-preferred display
    // order`），客户端**直接 `map` 不排序**（`dsh-client-ui-model-selection`）。
    // 一旦按数组顺序铺成**横向档位轴**，`['on','none']` 就变成「左强右弱」——
    // 「开启」贴最左、「关闭」贴最右。强度序的权威是本仓库
    // `REASONING_EFFORT_RANK`（`none: 0` / `on: 5`）⇒ `none` 必须在前。
    // 同一形态在 codearts（`llm-adapter.ts`）与 raccoon（`raccoon-product.ts`）
    // 各有一处，三处已一并按同一条规则规整。
    //
    // ⚠️ 默认档**不靠位置**表达：M3 远端没给 `default_effort`，故它**没有**
    // `defaultEffort`（保持服务端默认 = 实测不思考，见下）。移动位置不改变这一点。
    //
    // ⚠️ 远端 `effort_options` 那段**保持原序**（如实镜像上游，不重排）——
    // 只有这一对我们自己追加的两档按强度序排。故当远端档位存在时，
    // 整条数组**不一定全局单调**（如 M3.1 的 `default` 本就未登记强度）；
    // 而 M3 这种「只有我们追加的两档」的情形是全局升序的。
    // 幂等：远端若哪天自己下了这几个名字，不重复追加。
    if (!ids.includes('none')) ids.push('none')
    if (!ids.includes('on')) ids.push('on')
  }
  const efforts = ids.map((id) => {
    if (id === 'none') return { id: ReasoningEffortId(id), name: '关闭思考' }
    if (id === 'on') return { id: ReasoningEffortId(id), name: '开启思考' }
    return { id: ReasoningEffortId(id), name: id }
  })
  // ⚠️ 默认档必须落在档位表内，否则**不发**（照 Qoder 的 resolveModel）。
  // ⚠️ M3 没有 `default_effort` ⇒ 不设 `defaultEffort` ⇒ 保持服务端默认
  //（实测 = 不思考）。**不要**擅自把它设成 `on` —— 那会改变用户既有行为。
  const defaultEffort = entry.defaultEffort !== undefined && ids.includes(entry.defaultEffort)
    ? ReasoningEffortId(entry.defaultEffort)
    : undefined
  return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

/** {@link MinimaxAdapter} 的构造选项。 */
export interface MinimaxAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string, sessionId?: string) => Promise<MinimaxCredential | undefined>
  /** 凭据失效时的处理。 */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<readonly MinimaxModelEntry[]>
  /**
   * 「现在」的注入点（**只供单测**推进 TTL；生产缺省 `Date.now()`）。
   *
   * ⚠️ 为何要注入：TTL 是本 Task 的核心判据，而真实时间无法在用例里推进 ——
   *    只能靠 `sleep` 的用例会 flaky 且慢。既有同形态先例：`auto-adapter` 的 `now`。
   */
  now?(): number
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /**
   * 内联一张图片为**裸 base64**（由调用方桥接 `ctx.attachments.readImage`）。
   *
   * ⚠️ 未提供时收到图片会**报错**而不是静默丢图 —— 静默丢图会让用户以为
   * 图片被模型看到了（与 cline / lobsterai 的既有契约一致）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link MINIMAX}。 */
  product?: MinimaxProduct
  /**
   * 远端目录**落地后**的通知回调（issue IKJVTF）。
   *
   * 由 `registerMinimaxLlm` 注入为 `broadcastCatalogChanged(ctx)`。适配器本身
   * 拿不到 `ctx`，故必须由接线层桥接（与 `readImage` 等回调同一模式）。
   *
   * ⚠️ 必要性：客户端 `ModelCatalogDirectory` 在 `status === 'ready'` 时**短路
   * 返回缓存**，只在宿主事件上 `refresh()`。没有本回调时，冷启动首拉失败
   * 缓存的**兜底表**会永久留在对话框里，远端目录真的落地也不重读。
   */
  onCatalogLoaded?: () => void
  /**
   * 告警出口（2026-10-27 审计补，与 `autoclaw-adapter.ts` / `astudio-adapter.ts` 同型）。
   *
   * ⚠️ 存在的理由是**「预判续期失败后降级发送」必须留痕**：那条降级把
   * 「续期失败」从「请求失败」里摘了出来，若静默，用户看到请求成功、
   * 却不知道凭据其实没续上（下一轮还会撞同一个问题）。日志是唯一的归因线索。
   *
   * ⚠️ 省略时退回 `console.warn`（**不是**吞掉）—— 与 autoclaw 同约定。
   */
  warn?: (message: string) => void
  /**
   * 按**账号 id** 取该账号的出口（MiniMax 国际站代理支持）。
   *
   * ## 为什么要有它
   *
   * `agent.minimax.io` 按**出口 IP 国别**分流：大陆来源恒被 307 到中国站
   * `agent.minimaxi.com`，而中国站不认国际站 token ⇒ 报出与「凭据失效」
   * **逐字同形**的 401（issue IKMEVG）。既有的 `X-Forwarded-For` 只是**声明**
   * 一个海外 IP（上游不信任该头即失效），真正换出口要靠代理。
   *
   * ⚠️ 必须是**函数**而不是一份定好的 fetcher：本适配器在一轮请求内会**换号**
   * （限流 / 额度时 `getAvailableAccount` 换人），出口必须跟着换 —— 固化一份
   * 会让换号后**仍走旧账号的出口**（症状「换了号还是被分流」，且零报错，
   * 属最难查的一类静默失效）。
   *
   * ⚠️ 优先级：`fetchImpl`（单测替身）> `fetchFor(accountId)` > 全局 `fetch`。
   * 未注入时行为**逐字节不变**。
   */
  fetchFor?: (accountId: string) => typeof fetch
  /** 注入的 fetch（**仅单测**；优先级最高，见 {@link fetchFor}）。 */
  fetchImpl?: typeof fetch
  /**
   * **显式**指定本适配器代表哪个账号（探测路径专用）。
   *
   * ## ⚠️ 为什么必须有它（与 Gemini 的 `accountIdOverride` 同型缺陷）
   *
   * 出口代理是**账号维度**的，而「本适配器正在替哪个账号发请求」在**探测路径**
   * 上根本查不到：`account-probe.ts` 刻意**不传 `accountPool`**（既定语义：
   * 只测这一个账号、不写任何标记）⇒ 下面那条「按 access_token 反查账号 id」
   * 的路**不存在** ⇒ `activeAccountId` 恒为 `''` ⇒ 解析器按「空 id = 直连」
   * 处理 ⇒ **该账号的代理被完全绕过**。
   *
   * 症状与报障同形：国际站「测试 / 重测」**恒失败**，而这个失败与「账号已失效」
   * 在 UI 上**完全同形** ⇒ 用户会去误删好号。
   *
   * ## ⚠️ 为什么是「显式传入」而不是「探测时也传 accountPool」
   *
   * 传池会把探测接进换号 / 写标记的整套编排，而探测的**既定语义**就是不写任何
   * 东西、只测这一个账号。改 `account-probe.ts` 会破坏那套语义并波及十家适配器。
   *
   * ⚠️ **优先于**反查：探测时反查恰恰是拿不到的那条路；即便将来有人给探测
   * 也挂了池，显式值也是更权威的（调用方明确说了「我代表这个账号」）。
   */
  accountIdOverride?: string
  /**
   * 显式指定 X-Forwarded-For（探测路径专用）。
   *
   * ## ⚠️ 为什么必须有它（2026-10-24 活体实测）
   *
   * 探测适配器刻意**不传 `accountPool`** ⇒ `send()` 里那份「从池读
   * `minimaxXff()`」的取法在探测路径上**恒空** ⇒ 用户设好的 XFF 在「测试 /
   * 重测」上不生效 ⇒ 大陆出口的探测恒 307 → 401，报错文案与「凭据失效」
   * 同形（真机报文 `{"error":"invalid access token"}`），用户会去误删好号。
   *
   * ⚠️ XFF 是**只读**的展示性设置，探测带它不违反「探测不写任何状态」的
   * 既定语义（与 `accountIdOverride` 同一条界线：显式传值，不挂编排）。
   *
   * ⚠️ **优先于**池读法（生产池有池可读时以显式值为准，两者一致）。
   */
  xffOverride?: string
}

// ── 请求级账号轮换（issue IKJW32，2026-10-11）────────────────────────────
//
// 为什么必须有这一段：本适配器原先**没有**任何换号 / 冷却记账（14 家里唯一）
// —— 首号额度耗尽（实测报文 `402 + insufficient_balance_error`）就把错误抛给
// harness，而 `resolveCredential` 下次仍按池的手动顺序取回**同一个号** ⇒
// 「卡死在一个号上」，池里其余账号完好却永远轮不到。
//
// ## 语义表（照 `loomy-adapter.ts` / `raccoon-adapter.ts` 的类别→动作表逐格搬）
//
// | 类别 | 判据 | 换号 | 写冷却 |
// |---|---|---|---|
// | `quota` | 402 / 额度文案 / `insufficient_balance_error` | ✅ | ✅ 24h |
// | `rate` | 429 / `rate_limit_error` / `overloaded_error` | ✅ | ✅ 1h |
// | `auth` | 401 / 403 / `authentication_error` | ✅ | ❌ **绝不写** |
// | `other` | 其余 4xx（400 参数错等） | ❌ | ❌ |
//
// ⚠️ **认证类只换号、绝不写冷却**是 2026-10-06「全池被封」事故换来的不变式：
// 上游网关对**全池**回 401 时，若每个号都被写 24h 标记，一个请求就能把整个
// provider 封一天（下一次请求报 `no usable credential; log in first`）。
// 这与 loomy / raccoon / buddy 同一条铁律，别因为「记账更完整」而放宽。
//
// ⚠️ **本判据表不是 loomy / raccoon 那张表的同族实现**（协议不同源：本家是
// Anthropic Messages，那两家是 OpenAI 兼容族），故**不**与它们对拍；共享的
// 只有上面那两条不变式（401/403 先判、认证类不写标记）。本家多一路判据：
// Anthropic 错误体的 `error.type`（实测 400 体形状为
// `{"type":"error","error":{"type":"invalid_request_error","message":"… (2013)"}}`）。

/** 单次用户请求最多尝试的账号数（含首号）。与 loomy / raccoon 同语义，设上限只为防病态池。 */
const MINIMAX_MAX_ROTATE = 8
/** 额度耗尽的冷却兜底：24h（日配额；本家无可靠重置字段，与 raccoon quota 同档）。 */
const MINIMAX_QUOTA_COOLDOWN_MS = 24 * 3_600_000
/** 429 限流冷却：1 小时（与 loomy / raccoon / trae soft-rate 同档）。 */
const MINIMAX_RATE_LIMIT_COOLDOWN_MS = 3_600_000

/** MiniMax 的失败类别（`auth` 只换号、绝不写冷却，见上文语义表）。 */
export type MinimaxFailureClass = 'quota' | 'rate' | 'auth' | 'other'

/**
 * Anthropic 错误体里**自报类别**的判据（`error.type`）。
 *
 * ⚠️ 用**子串**而非全等：服务端可能用 `insufficient_balance_error` /
 * `insufficient_quota_error` 等变体表达同一语义，只认全等会漏判
 *（同 CodeArts `4291` 的子串口径）。三组之间**不重叠**。
 *
 * ⚠️ `rate_limit` 只匹配**下划线**形态（`rate_limit_error`）：裸 `rate limit`
 *（空格）在 `invalid_request_error: rate limit field invalid` 里也会出现，
 * 归 rate 会白写 1h 冷却（方向与「宁可漏判不可误伤」相反）。
 */
const MINIMAX_QUOTA_ERROR_TYPES = ['insufficient_balance', 'insufficient_quota', 'insufficient_credit', 'billing_error']
const MINIMAX_RATE_ERROR_TYPES = ['rate_limit', 'overloaded']
const MINIMAX_AUTH_ERROR_TYPES = ['authentication_error', 'permission_error', 'unauthorized']

/** 与 `insufficient` **共现**才算额度的「钱」义词。 */
const MINIMAX_MONEY_WORDS = ['point', 'credit', 'balance', 'quota']

/**
 * 明确的英文余额不足短语（**不含** `insufficient`）。
 *
 * ⚠️ Anthropic 的真实低余额文案是 `Your credit balance is too low to access the API`
 * —— 它既没有 `insufficient`、也没有中文对，只靠共现判据会**漏判** ⇒ 换号静默失效
 * （本 issue 要修的那件事在英文文案下原样残留）。
 */
const MINIMAX_QUOTA_PHRASES = [
  'credits exhausted',
  'balance is too low',
  'balance not enough',
  'not enough balance',
  'not enough credit',
  'out of credits',
  'insufficient funds',
]

/**
 * `insufficient` 是否与「钱」义词共现。
 *
 * ⚠️⚠️ **`token` 必须按词边界匹配**（本文件初版用的是 `lower.includes('token')`）：
 * Anthropic Messages 报文里 `max_tokens` / `input_tokens` / `budget_tokens` 都是
 * 一等字段名 ⇒ `insufficient max_tokens for the requested thinking budget`
 *（真实的 **400 参数错**）会被判成 `quota` ⇒ `recordsMinimaxRateLimit` 为真 ⇒
 * **一个请求内每个被轮换到的账号各写 24h**。那正是「全池被封」不变式要防的形态，
 * 只换了触发词；词表抄自 loomy / raccoon（同一缺陷），但本家此前从不写标记，
 * 是这次改动第一次把「过宽判据」接到「写 24h」上。
 */
function minimaxHasMoneyWord(lower: string): boolean {
  if (MINIMAX_MONEY_WORDS.some((word) => lower.includes(word))) return true
  // ⚠️ `_` 也算词内字符：`max_tokens` 里的 `tokens` 前面是 `_` ⇒ **不命中**。
  return /(?:^|[^a-z0-9_])tokens?(?:[^a-z0-9_]|$)/.test(lower)
}

/**
 * **自家信封**的业务码通道（`{"code":401,"message":"auth failed"}`）。
 *
 * 实测（2026-10-11，真机）：认证失败的体是自家信封、**不是** Anthropic 形状，
 * 且 `code` 与 HTTP 语义同值。MiniMax 系有「HTTP 200 + 业务码」的既有习惯
 *（签到、`timezone_id` 放错位置都是 200），故 200 流内错误同样按码归类 ——
 * 只按 Anthropic 形状解析会让额度错误整段丢失 ⇒ 换号静默失效。
 *
 * ⚠️ **只认这四个码**（与状态码通道同一集合），其余码不猜。
 */
function minimaxEnvelopeClass(lower: string): MinimaxFailureClass | undefined {
  const matched = /code\D{0,4}(401|402|403|429)(?!\d)/.exec(lower)
  if (matched === null) return undefined
  const code = matched[1]
  if (code === '401' || code === '403') return 'auth'
  return code === '402' ? 'quota' : 'rate'
}

/**
 * 判定失败类别（状态码 + 自报类别 + 自家信封码 + 文案，四通道）。
 *
 * ⚠️ **401 / 403 / 402 / 429 先按状态码判**，再谈文案 —— 网关侧故障常在报文里
 * 捎带余额提示（loomy / raccoon 的 2026-10-06 事故形态：`401 + 余额不足` 被判成
 * `quota` 后写 24h 冷却，一个请求封完全池）。**状态码与额度文案并存时以状态码为准。**
 *
 * ⚠️ 文案通道里 `insufficient` **单独出现过宽**（上下文窗口超长、权限不足、
 * `max_tokens` 预算都会命中），必须与「钱」义词共现才算额度（见
 * {@link minimaxHasMoneyWord}）；方向是**宁可漏判不可误伤**：漏判只是不换号，
 * 误判会封可用账号 24h。
 */
export function classifyMinimaxFailure(errorText: string, status: number): MinimaxFailureClass {
  // ① 真实 HTTP 状态码（优先级最高，见上）。
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'quota'
  if (status === 429) return 'rate'
  const lower = errorText.toLowerCase()
  // ② 服务端**自报**的错误类别（Anthropic `error.type`）——确定性最高的一组。
  if (MINIMAX_AUTH_ERROR_TYPES.some((t) => lower.includes(t))) return 'auth'
  if (MINIMAX_QUOTA_ERROR_TYPES.some((t) => lower.includes(t))) return 'quota'
  if (MINIMAX_RATE_ERROR_TYPES.some((t) => lower.includes(t))) return 'rate'
  // ③ 自家信封的业务码（实测 401 体 `{"code":401,…}`；200 流内错误也走这里）。
  const byCode = minimaxEnvelopeClass(lower)
  if (byCode !== undefined) return byCode
  // ⚠️ 权限类文案必须在额度文案**之前**：`insufficient permissions to access
  //    this resource` 与额度无关，而它含 `insufficient`（同 loomy/raccoon 的教训）。
  if (lower.includes('insufficient permissions') || lower.includes('auth failed')) return 'auth'
  /**
   * ④ **5xx 只信上面三条确定性通道**：服务端 / 网关故障常在报文里捎带余额提示
   *（`500 + insufficient balance` 实测会被判成额度），按文案给整池写 24h 冷却
   * 是把上游故障放大成一天不可用 —— 与 2026-10-06 事故同一方向。
   * 代价是「真额度 + 500」会漏判（不换号），那正是刻意选择的保守方向。
   */
  if (status >= 500) return 'other'
  // ⑤ 文案通道（与 loomy / raccoon 同一张词表：本家报文同样可能只给中文/英文文案）。
  const quotaText = MINIMAX_QUOTA_PHRASES.some((phrase) => lower.includes(phrase))
    || (lower.includes('insufficient') && minimaxHasMoneyWord(lower))
    || (lower.includes('积分') && (lower.includes('不足') || lower.includes('耗尽')))
    || (lower.includes('额度') && (lower.includes('不足') || lower.includes('耗尽')))
    || (lower.includes('余额') && (lower.includes('不足') || lower.includes('耗尽')))
    || (lower.includes('quota') && (lower.includes('exceeded') || lower.includes('exhausted')))
  if (quotaText) return 'quota'
  // ⚠️ 只认标准 429 措辞：裸 `rate limit` 会命中「字段名 / 参数错」
  //（实测 `400 + invalid_request_error: rate limit field invalid`）⇒ 白写 1h 冷却。
  if (lower.includes('too many requests')) return 'rate'
  return 'other'
}

/**
 * 该失败是否值得「换下一个账号」重试。
 *
 * ⚠️ 入参是**已判定的类别**，不是「原文 + 状态码」：那样 `stream()` 只能内联写
 * `failureClass !== 'other'`，同一个判据就在文件里出现**两处**
 *（AGENTS.md 明列的「一文件两套同义判据」坑）。现在它是唯一入口，`stream()` 真的调它。
 */
export function shouldRotateMinimaxAccount(cls: MinimaxFailureClass): boolean {
  return cls !== 'other'
}

/** 该类别是否要写冷却标记（`auth` 不在其中，见 {@link MinimaxFailureClass}）。 */
export function recordsMinimaxRateLimit(cls: MinimaxFailureClass): boolean {
  return cls === 'quota' || cls === 'rate'
}

/** MiniMax Code 模型适配器。 */
export class MinimaxAdapter extends LlmAdapter {
  private readonly product: MinimaxProduct
  private remoteModels: readonly MinimaxModelEntry[] | undefined
  /**
   * ⚠️ 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
   *
   * ⚠️ 与 `remoteModels` **并存**、不是替代：`remoteModels` 存「有哪些模型」，
   *    本字段存「何时读到的」。两者缺一都会坏：只有 `remoteModels` 则目录永不更新
   *    （现状）；只有 `catalogAt` 则无内容可展示。
   */
  private catalogAt = 0
  /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
  private readonly catalogGate: RemoteCatalogGate
  /**
   * ⚠️ **2026-10-08 Task 7a：三个方法收敛到共享骨架** `createModelCatalog`。
   * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架
   * （实测与 `loomy` / `raccoon` 归一化后逐字相同），现在只剩 `toCatalogEntry`。
   */
  private readonly catalog: ModelCatalog

  constructor(private readonly options: MinimaxAdapterOptions) {
    super()
    this.product = options.product ?? MINIMAX
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
        /**
         * ★ **强制重拉**（供后台 20 分钟刷新器与「用户改设置」）。
         *
         * ⚠️ 与 `loadCatalog` 的差别：后者内部有 `isCatalogFresh` 判据 ⇒ 新鲜时**不拉**。
         * 本回调要的是「无视新鲜度，强制拉一次」，故先清时刻再调同一个方法 ——
         * **不另写一份拉取逻辑**（那会让两条路的上游行为分叉）。
         */
        refresh: async () => {
          this.catalogAt = 0
          await this.loadModels()
        },
      },
    )
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 取**某个账号**该走的 fetcher（MiniMax 国际站代理支持）。
   *
   * ⚠️⚠️ **必须按账号现取，不能在构造 / 循环外固化**：本适配器在一轮请求内会
   * **换号**（限流 / 额度时 `getAvailableAccount` 换人），出口必须跟着换 ——
   * 固化一份会让换号后**仍走旧账号的出口**（症状「换了号还是被分流」，零报错）。
   *
   * ⚠️ 优先级：`fetchImpl`（单测替身）> `fetchFor(accountId)` > 全局 `fetch`。
   * 未注入 `fetchFor`（中国站 / 旧接线）⇒ 恒走既有路径，**行为逐字节不变**。
   *
   * ⚠️ 空账号 id（`''`）= 直连：`fetchFor` 的解析器按「空 id = 没配代理」处理
   * （见 `minimax-proxy.ts`）—— 拿不到账号时不该去查一个空 id。
   */
  private fetcherFor(accountId: string): typeof fetch {
    if (this.options.fetchImpl !== undefined) return this.options.fetchImpl
    if (this.options.fetchFor !== undefined) return this.options.fetchFor(accountId)
    return fetch
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
  private async loadModels(): Promise<readonly MinimaxModelEntry[]> {
    // ⚠️⚠️ **两处判据都要改**（方法入口 + gate 后复查）。只改入口的话，
    //    第二次复查会把「刚拉到的」当成陈旧而再拉一次（放大成每轮两次上游请求）。
    //
    // ⚠️ 判据来源：`isCatalogFresh`（`model-catalog.ts` 的**唯一**实现）；聚合
    //    那条缓存短路（`aggregate-adapter.ts` 的 `refreshCatalog`）也走它。
    //    ⚠️ **不是「逐字相同」**：那边另有两处本家没有的前提（`force` 与
    //    `options.catalogTtlMs` 覆盖的 60s TTL），本家用的是 20 分钟默认周期。
    //
    // ⚠️ 第 ① 处（方法入口）用 `isCatalogFreshFor`：用户在 Jet Hub 改开关后要
    //    **立即**重拉（规格 §6 的正确性要求，见 `invalidateCatalogCache`）。
    //    ⚠️ 第 ② 处（gate 之后复查）**刻意仍用 `isCatalogFresh`**：那里问的是
    //    「手上这份旧读数还能不能用」—— 若也判失效，一次失败的拉取会把**完整旧
    //    目录**判成不可用 ⇒ 回落兜底表（子集）⇒ 用户看到「模型反而变少」。
    if (this.remoteModels !== undefined
      && isCatalogFreshFor(this.product.id, this.catalogAt, this.options.now?.() ?? Date.now())) {
      return this.remoteModels
    }
    const fetchRemote = this.options.fetchRemoteModels
    if (fetchRemote !== undefined) {
      await this.catalogGate.run(async () => {
        const fetched = await fetchRemote()
        if (fetched.length === 0) return false
        this.remoteModels = fetched
        // ⚠️ **只在成功时**记时刻：失败不写，否则一次抖动会把上界刷新掉、
        //    下轮还要等满 20 分钟才发现上游没恢复。
        this.catalogAt = this.options.now?.() ?? Date.now()
        return true
      })
      if (this.remoteModels !== undefined
        && isCatalogFresh(this.catalogAt, this.options.now?.() ?? Date.now())) {
        return this.remoteModels
      }
    }
    return minimaxFallbackEntries(this.product)
  }

  /**
   * 完整目录（**不套黑名单**），供 Jet Hub「显示列表」用。
   *
   * ⚠️ **必须同步返回数组，不能是 `async`**（真实缺陷，2026-09-29 修正）。
   *
   * 本插件 8 个既有适配器的 `listAllModels()` 全是同步返回 `readonly {...}[]`
   * （见 `llm-adapter.ts`、`raccoon-adapter.ts` 等），
   * `jet-hub-rpc.ts` 的接口（`ModelCatalogSource` 的 `listModels` / `listAllModels`）也是同步，
   * 且两处消费者**都不 await**：
   * - `catalog = [...all]`
   * - `ids = all.map((model) => model.id)`
   *
   * 早期这里写成 `async`，返回的是 Promise —— Promise **不是** `undefined`，
   * 故两处都会走进 `all !== undefined` 分支并抛
   * `TypeError: all is not iterable` / `TypeError: all.map is not a function`
   * ⇒「显示列表」与「关闭全部」两个功能同时崩。
   *
   * 当时未被发现，是因为 minimax 尚未接入 `src/index.ts` 的 `modelAdapters`
   * （无调用方），一旦接线即爆发。
   *
   * ⚠️ 读缓存而非 `await loadModels()` 是**正确**的：RPC 路径在调用本方法**之前**
   * 已先 `await llm.listModels(provider)`（`jet-hub-rpc.ts`），
   * 而 `listModels` 内部会 `await this.loadModels()` 落缓存。
   *
   * ⚠️ **2026-10-08 Task 7a**：本条同步契约**原样上移到共享骨架**
   * （`src/model-catalog.ts` 的 `listAllModels` + `ModelCatalogConfig.syncCatalog`），
   * 上面这段缺陷史也随之上移；此处只剩委托。
   * ⇒ 骨架里**同样**不能把它改成 `async`（同一个 `all is not iterable` 后果）。
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

  private toCatalogEntry(model: MinimaxModelEntry): CatalogEntry {
    const reasoning = minimaxReasoningInfo(model)
    const maxTokens = model.maxTokens
    const contextWindow = model.contextWindow
    return {
      id: model.id,
      name: model.name,
      // ⚠️ 本家**不剥倍率**（`resolveModel` 也用 `name`）⇒ 不提供 `bareName`。
      inputModalities: this.inputModalitiesFor(model),
      ...contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {},
      ...maxTokens !== undefined ? { maxTokens } : {},
      ...reasoning !== undefined ? { reasoning } : {},
    }
  }

  private async loadCatalogEntries(): Promise<readonly CatalogEntry[]> {
    const all = await this.loadModels()
    return all.map((model) => this.toCatalogEntry(model))
  }

  private syncCatalogEntries(): readonly CatalogEntry[] {
    const source = this.remoteModels ?? minimaxFallbackEntries(this.product)
    return source.map((model) => this.toCatalogEntry(model))
  }

  private inputModalitiesFor(
    entry: MinimaxModelEntry | undefined,
  ): readonly ('text' | 'image')[] {
    return entry?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.listModels(_provider)
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolveModel(provider, model, signal)
  }

  /** 兼容 0.1.1-rc.2 的 `prepareCall` shim（与其余适配器同款）。 */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 走 **Anthropic Messages** 协议发一次流式请求。
   *
   * ⚠️ 凭据过期先静默续期一次（与其余九个适配器同款）。
   *
   * ⚠️ **错误必须抛错**，不静默返回空流（Qoder 早期同型缺陷）。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    /**
     * 本次请求是否**在跟随之前**观测到「国际站被地理路由」（issue IKMEVG）。
     *
     * ⚠️ 必须在这里声明、由 `send()` 的 `onGeoRoute` 置位：一旦跟到中国站，
     * 国际站 token 得到的 `401 invalid access token` 与「凭据真失效」**逐字同形**
     * （本机实测），事后无法区分。故判定的时机只能卡在 307 那一跳。
     */
    let geoRouted = false
    let credential = await this.options.resolveCredential(options.model, options.sessionId)
    if (credential === undefined || isMinimaxExpiringWithin(credential, MINIMAX_ONDEMAND_MIN_VALIDITY_MS)) {
      /**
       * ⚠️⚠️ **续期失败不得让请求直接死掉**（2026-10-27 审计修）。
       *
       * ## 修前的缺陷
       *
       * 这里是裸 `await this.options.refresh()`。而 `isMinimaxExpiringWithin`
       * 是 **fail-open** 的（读不到 `expires_at` ⇒ 返回 `true` = 该续）
       * ⇒ 对于「凭据缺 / 非法 `expires_at`」的账号，**每个请求**都会走到这里；
       * 一旦续期抛错，请求**一次上游都不发**就失败了。
       *
       * 实测（构造一条无 `expires_at` 的凭据 + refresh 抛 `invalid_grant`）：
       * `fetch` 调用 **0 次**、请求直接失败 —— 而旧判据（`isMinimaxExpired`）
       * 会正常放行，让请求用掉最后那段时间。
       *
       * ## 修法：降级为「用现有凭据继续发」
       *
       * 手上有 `credential` 且 `access_token` 非空 ⇒ 先发出去，让**上游**来否决
       * （它才是权威）。401 之后下面还有一条专门的「401 先续期再重发」路径兜底，
       * 那一步的 `refresh()` 失败会正确地报 `AUTH`。
       *
       * ⚠️ 这一格**不会**掩盖真终态：续期失败的原因会进 `warn`（含 error message），
       *   且 401 兜底那条路径仍按原语义分类。它只把「预判失败」与「请求失败」
       *   解耦 —— 预判是**优化**，不该是**门禁**。
       */
      try {
        await this.options.refresh()
        credential = await this.options.resolveCredential(options.model, options.sessionId)
      } catch (error) {
        if (credential === undefined || credential.access_token === '') {
          // 手上根本没有可用凭据 ⇒ 只能报错（与原行为一致）
          throw error
        }
        this.options.warn?.(
          `[minimax] 请求前预判续期失败，改用现有凭据继续发送（由上游判定是否有效）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (credential === undefined || credential.access_token === '') {
      throw new LlmError('minimax: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }
    /**
     * 本次请求实际使用的账号 id（请求级轮换的记账键 **且是取出口的键**）。
     * 语义与 loomy / raccoon 同款：按 access_token 反查池内条目；单凭据回退时
     * 保持空串（无池即无「下一个号」，轮换自然失效，不误标）。
     *
     * ⚠️ 反查的第二参是**凭据内容**而不是 ref 名（传 ref 名会恒匹配失败且**静默**）。
     *
     * ⚠️ `accountIdOverride` **优先于**反查：探测路径拿不到池，只能靠调用方
     * 显式说明「我代表这个账号」（见该字段的注释）。
     */
    let activeAccountId = this.options.accountIdOverride ?? ''
    if (activeAccountId === '' && this.options.accountPool) {
      try {
        activeAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id, credential.access_token,
        ) ?? ''
      } catch { /* 反查失败不阻断主路径：轮换退化为「不标记」 */ }
    }

    const entry = (await this.loadModels()).find((item) => item.id === options.model)

    // ⚠️ 图片：先判定模型是否支持，再内联。
    // **不能**放宽成「总是接受」：DSH 按适配器播报的 `inputModalities` 决定要不要
    // 把图片投影成文本占位符，声明支持就必须真支持；声明不支持却收到图片
    // 应当**报错**而不是发出去让服务端 400。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let images: Map<string, MinimaxInlineImage> | undefined
    if (imageRefs.size > 0) {
      if (entry?.supportsImage !== true) {
        throw new LlmError(
          `minimax: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError(
          'minimax: 图片输入需要附件服务（readImage 未提供）',
          'UNSUPPORTED_CONTENT',
        )
      }
      images = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        const inline = await readImage(ref)
        if (inline === undefined) continue
        // ⚠️ Anthropic 的 `source.data` 要**裸 base64**，不加 `data:` 前缀
        //（实测；加前缀是否为 400 未单独验证，但没必要冒这个风险）。
        images.set(id, {
          mediaType: inline.mediaType,
          data: Buffer.from(inline.data).toString('base64'),
        })
      }
    }

    // ⚠️ **只有 M3.1-Flash-Preview 必须 adaptive**：实测传 `disabled` 会被拒
    //（`400 ... requires adaptive thinking ... not allowed (2013)`）。
    // 其余模型不发 thinking 即接受（实测 200），且服务端默认会思考。
    const requiresAdaptiveThinking = options.model.startsWith(MINIMAX_ADAPTIVE_ONLY_PREFIX)
    // ⚠️ 档位合法性：不仅要「在 effortOptions 里」，还要考虑 `none`
    //（「关闭思考」）—— 它是我们**为 switchable 模型追加**的档，
    // **不在**远端 `effortOptions` 里，故不能只按 effortOptions 过滤。
    // 判据与 `minimaxReasoningInfo` 的产出**保持一致**（否则 UI 给了选项、
    // 请求却把它丢掉 —— 用户选了「关闭思考」而模型仍在思考）。
    const requested = options.reasoningEffort === undefined
      ? undefined
      : String(options.reasoningEffort)
    const declared = entry === undefined ? undefined : minimaxReasoningInfo(entry)
    /**
     * 会话自动命名（`purpose: 'session-title'`）的思考与预算决策（issue IKKVDH）。
     *
     * DSH 用 **64 token** 发标题请求且**不传 `reasoningEffort`**。若照常让模型
     * 思考，思考会把 64 个 token 吃满、正文 0 字符 ⇒ `dsh-session-title-llm`
     * 直接拒绝，标题永远停在 fallback。
     *
     * ⚠️ **本家关不关得掉要看模型**（见 `minimaxReasoningInfo` 的表格），
     * 这正是「决策共享、细节各家自留」要处理的形态：
     * - **M3**（`switchable`，档位表里有我们追加的 `none`）→ **关得掉**；
     * - **M3.1-Flash-Preview**（`forced_on`）→ **关不掉**：传 `disabled` 会硬 400
     *   （`2013`），故只能走抬预算兜底；
     * - **M2.7 系**（`forced_on` 且无档位）→ **关不掉**：传 `disabled` 被**静默
     *   忽略**（思考照旧），故同样只能抬预算。
     */
    const titlePlan = planSessionTitleThinking({
      purpose: options.purpose,
      requestedEffort: requested,
      declaredEfforts: declared?.efforts.map((e) => String(e.id)) ?? [],
      maxTokens: options.maxTokens,
    })
    const effort = titlePlan.effort !== undefined
      && declared?.efforts.some((e) => String(e.id) === titlePlan.effort) === true
      ? titlePlan.effort
      : undefined

    const payload = buildMinimaxMessagesPayload({
      model: options.model,
      messages: options.messages,
      system: options.system,
      tools: options.tools,
      temperature: options.temperature,
      maxTokens: titlePlan.maxTokens,
      stop: options.stop,
      effort,
      requiresAdaptiveThinking,
      ...images === undefined ? {} : { images },
    })

    /**
     * 发送一次推理请求（**含传输级重试**）。
     *
     * ⚠️ 头取**闭包里的当前** `credential`（换号后只需改这个变量）—— 与
     * raccoon 的 `send()` 同款，避免把 token 当参数传来传去而漏传一处。
     *
     * ## ⚠️⚠️ 为什么必须有传输级重试（2026-10-15 真实缺陷）
     *
     * 用户报障：「模型连接测试失败，显示 `fetch failed`」。
     *
     * 本机取证（同一凭据、同一端点、连打 10 次）：
     * ```
     * 签到 (signin/status): 成功 5/10 —— 失败全是
     *   fetch failed ← self-signed certificate in certificate chain [SELF_SIGNED_CERT_IN_CHAIN]
     * 目录 (models)       : 成功 10/10
     * ```
     * ⇒ 约 **50%** 概率被**环境里的 HTTPS 检查代理**（企业/杀软/Clash 的 MITM 证书）
     * 打断。这是**环境问题**，但症状落在插件上：一次偶发中断 = 整轮请求失败，
     * 用户看到 `fetch failed`，而重试一次几乎必然成功。
     *
     * ⚠️ **只重试传输错误，绝不重试 HTTP 状态错误**：4xx/5xx 是**服务端的明确答复**
     *（401 要续期、402 要充值、429 要冷却），重发只会原样再失败，还会掩盖真实原因、
     * 浪费时间。判据与退避都在 `minimaxFetchWithRetry`（`src/minimax.ts`）里，
     * **与目录路径共用同一份实现** —— 本文件不再另写一份（同义判据分两处必然漂移）。
     *
     * ⚠️ **abort 绝不重试**：用户点了停止还继续发 3 次是**不可接受**的行为
     *（本仓库 `llm-adapter.ts` 记过同型缺陷）。
     */
    const send = async (): Promise<Response> => {
      // ⚠️ 每次现读闭包变量：`credential` 是 `let`（换号会替换它），TS 不会把
      // 上面的 `undefined` 判据窄化进闭包，故这里自己兜一次（正常路径不可达）。
      const current = credential
      if (current === undefined) {
        throw new LlmError('minimax: no usable credential; log in first', 'MISSING_CREDENTIAL')
      }
      /**
       * ⚠️⚠️ 必须走 `minimaxFetch`（重试 + **保凭据跟随重定向**），不能裸 `fetch`。
       *
       * 真实缺陷（2026-10-17，issue IKMEVG）：`agent.minimax.io` 对所有路径恒返
       * `307 → agent.minimaxi.com`，而 fetch **跨 origin 跟随会剥掉
       * `Authorization`** ⇒ 第二跳无凭据 ⇒ `401 {"message":"token is required"}`。
       * 用户看到的是「模型连接测试失败」，真因却是重定向丢头。
       *
       * ⚠️ 头必须由 `buildInit` **每跳重新构造**（这里每次现读 `current`，
       * 换号后连第一跳也会带上新 token）。
       *
       * ⚠️ 国际站另需附用户设置的 `X-Forwarded-For`（绕开 Akamai 按出口 IP
       * 的地理分流）。**每次现读**池里的设置，不缓存 —— 用户随时可能在面板里改。
       *
       * ⚠️ **必须用 `typeof` 判一下**：`accountPool` 是结构化类型（`AccountPool`），
       * 而单测/旧接线可能传**只实现了一部分方法**的替身 —— 直接
       * `this.options.accountPool?.minimaxXff()` 会在那种替身上抛 `TypeError`
       * （`?.` 只挡 `null`/`undefined`，挡不住「对象上没有这个方法」）。
       * 实测后果：`minimax-adapter.spec.ts` 的轮换组 16 条用例全红。
       *
       * ⚠️ **探测路径（无池）必须仍能拿到 XFF**：探测适配器刻意不传
       * `accountPool`（既定语义：不写任何标记），那 XFF 就读不到 ⇒ 大陆出口
       * 的「测试」恒 307→401，与「凭据失效」同形（2026-10-24 活体实测：
       * 用户已设 XFF，`account.test` 仍报 invalid access token）。
       * 故提供 `xffOverride`：探测槽显式传入池里的当前值 —— 它是**只读**的
       * 展示性设置，探测带它不违反「不写状态」的语义。
       */
      const pool = this.options.accountPool
      const xff = this.options.xffOverride
        ?? (typeof pool?.minimaxXff === 'function' ? pool.minimaxXff() : undefined)
      return minimaxFetch(
        `${this.product.apiHost}${MINIMAX_INFER_PATH}`,
        () => ({
          method: 'POST',
          headers: minimaxInferHeadersFor(current, xff, this.product.id),
          body: JSON.stringify(payload),
          signal: options.signal,
        }),
        {
          /**
           * ⚠️ **推理主路径必须走该账号的出口**（国际站代理）。
           *
           * `send()` 会被**多次**调用（401 续期后重发、轮换换号后重发），故这里
           * 必须**每次按当时的 `activeAccountId` 现取** fetcher —— 在闭包外固化
           * 一份会让换号后**仍走旧账号的出口**（症状「换了号还是被分流」，零报错）。
           */
          fetcher: this.fetcherFor(activeAccountId),
          signal: options.signal,
          // 记下「地理路由」：跟随后 401 与「凭据失效」同形，只能在此刻判。
          onGeoRoute: () => { geoRouted = true },
        },
      )
    }


    /**
     * 该响应体是否**明确不是** SSE。
     *
     * ⚠️ 判据必须是「**明确**非流式」而不是「不是 SSE」：`new Response(string)`
     * 的默认 content-type 是 `text/plain`，网关也可能用别的类型转发 SSE ——
     * 把它们当错误体会让**正常回答整轮失败**。故只认两种明确的非流式类型
     *（`application/json` / `text/html`），其余一律按 SSE 处理。
     *
     * ⚠️ 仍然必要：本家（MiniMax 系）有「HTTP 200 + 业务码」的既有习惯
     *（签到、`timezone_id` 放错位置都是 200），推理端点也可能用 200 + JSON 信封
     * 表达失败。那种响应**一个 SSE 帧都没有** ⇒ 只交给 `consumeMinimaxSse` 的话
     * 永远只得到「模型未返回任何内容块」，额度信息整段丢失 ⇒ 判 `other` ⇒ 不换号。
     *（content-type 缺失的非标准错误体由 `consumeMinimaxSse` 的原文样本兜住。）
     */
    const isDefinitelyNotSse = (response: Response): boolean => {
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      return contentType.includes('application/json') || contentType.includes('text/html')
    }

    /**
     * 消费一次 2xx 响应。
     *
     * 返回 `undefined` = 正常结束；返回 `{ error, text }` = **尚未产出任何内容**
     * 就失败（此时换号重发是安全的，用户无感）。
     *
     * ⚠️ **一旦产出过任何 chunk 就原样抛错、绝不重发**：重发会让用户看到重复
     * 内容（harness 侧也会收到两份 text-delta）。
     *
     * ⚠️ 多出这一层（loomy / raccoon 的成功分支是直接消费）是因为「200 + 业务码」
     * 在本家是既有习惯，故流内 `event: error` 帧与「非 SSE 的 200」都必须走同一条
     * 轮换判据，不能只覆盖 HTTP 非 2xx。
     */
    const consumeOkResponse = async function* (
      response: Response,
    ): AsyncGenerator<StreamChunk, { error: unknown; text: string } | undefined> {
      if (isDefinitelyNotSse(response)) {
        // 明确非流式的 200：读原文（自家信封 `{"code":402,…}` / 网关 HTML），
        // 交给同一条分类判据；原文进错误文案，用户至少能看到服务端说了什么。
        const text = await response.text().catch(() => '')
        return {
          error: new LlmError(
            `minimax: 推理端点返回了非 SSE 响应（HTTP 200）${text === '' ? '' : ` — ${text.slice(0, 500)}`}`,
            /**
             * ⚠️⚠️ **不能用 `SERVER`**（2026-10-17 审计发现的真缺陷，本行是既有代码）。
             *
             * 本对象会被 `attempt()` 原样当作 `streamError`，**不经过**
             * `httpErrorCode()` 重新归类（实测最终 `error.code === 'SERVER'`）。
             * 而 DSH 的 `DEFAULT_RETRYABLE_CODES` 含 `'SERVER'`、
             * `DEFAULT_MAX_RETRIES = 5` ⇒ 这条**确定性失败**（网关就是没给 SSE，
             * 同一请求重发大概率还是同样结果）会被 `dsh-llm-retry` 自动重试 5 次，
             * 每次都重跑整条换号循环。
             *
             * 用 `INVALID_REQUEST` 的理由与地理路由处同源：它**不在**默认可重试集合、
             * 也**不会**被 harness 替换文案（只用 `QUOTA` / `AUTH` 替换）。
             * 语义也对位 ——「这次响应格式不可用」是请求层面的确定性拒绝。
             */
            'INVALID_REQUEST',
          ),
          text,
        }
      }
      const body = response.body
      if (body === null) {
        // ⚠️ body 缺失既不是额度也不是限流（换号无益），故交回调用点的
        // `other` 分支**原样**抛既有错误对象（保住 `EMPTY_RESPONSE` 错误码）。
        return { error: new LlmError('minimax: 响应缺少 body', 'EMPTY_RESPONSE'), text: '响应缺少 body' }
      }
      let yieldedAny = false
      try {
        for await (const chunk of consumeMinimaxSse({ body, signal: options.signal })) {
          yieldedAny = true
          yield chunk
        }
        return undefined
      } catch (error) {
        if (yieldedAny) throw error
        return { error, text: error instanceof Error ? error.message : String(error) }
      }
    }

    let response = await send()

    /**
     * 401 / 403：先续期一次再重发（与 loomy / raccoon 同款）。
     *
     * 必要性：本家凭据可能被服务端提前撤销而本地 `expiresAt` 仍在未来 —— 只靠
     * 上面的过期预判不会续期，401 会白打一轮。
     *
     * ⚠️⚠️ **续期失败必须分类处理**（2026-10-27 第二轮审计打穿）：
     * `minimax-auth` 的续期会抛 `MinimaxRefreshTokenExpiredError`（RT 确实已死）。
     * 那种情形下正确的出口是**把「请重新登录」这条指路文案传出去**，而不是吞成
     * `AUTH` —— `AUTH` 会被客户端替换成固定文案「API 密钥无效」并丢掉原文
     *（本仓库的既有纪律：`IKLBSH`，凡「文案本身就是出路」的错误必须避开 `AUTH`）。
     *
     * ⚠️ 同时留一条 warn，让「续期失败」与「续了但没用」可分。
     */
    if (response.status === 401 || response.status === 403) {
      let refreshError: unknown
      try {
        await this.options.refresh()
      } catch (error) {
        refreshError = error
        this.options.warn?.(
          `[minimax] 401 后按需续期失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const refreshed = refreshError === undefined
        ? await this.options.resolveCredential(options.model, options.sessionId)
        : undefined
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        /**
         * ⚠️ 终态（RT 已死）⇒ 抛出**带指路文案**的错误，**不用 `AUTH`**。
         * 其余情形（续期成功了但拿不到凭据 / 网络类失败）仍按原 `AUTH` 口径 ——
         * 那是「凭据暂时取不到」，与「需要重新登录」是两件事。
         */
        const terminal = refreshError !== undefined
          && (refreshError as { name?: unknown }).name === 'MinimaxRefreshTokenExpiredError'
        if (terminal) {
          throw new LlmError(
            `minimax: refresh_token 已失效，请重新登录（${refreshError instanceof Error ? refreshError.message : String(refreshError)}）`,
            'INVALID_REQUEST',
            { status: response.status },
          )
        }
        throw new LlmError('minimax: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      /**
       * ⚠️ **必须跟着重新反查账号 id**（与 loomy / raccoon 的 `51ded6a` 同款）：
       * 续期走的是**池内第一个可用账号**（见 `src/index.ts` 的 minimax `refresh`），
       * 二者可能不是同一个号 ⇒ 续期后取回的凭据属于另一个账号，而
       * `activeAccountId` 还停在旧号上，冷却标记会**记到无辜账号头上**
       *（没耗尽的被封、真该封的下次仍被选中）。
       */
      if (this.options.accountPool) {
        try {
          activeAccountId = await this.options.accountPool.findAccountIdByCredential(
            this.product.id, refreshed.access_token,
          ) ?? ''
        } catch { /* 反查失败不阻断主路径：轮换退化为「不标记」 */ }
      }
      response = await send()
    }

    /** 当前失败的可读原文（轮换循环内每次失败都刷新）。 */
    let errorText = ''
    /** 当前失败的 HTTP 状态码；**流内错误 / 非 SSE 的 200** 时为 0（没有状态码可用）。 */
    let status = response.status
    /**
     * 失败的原错误对象。
     *
     * ⚠️ 非空时一律**原样抛出**（而不是包成新的 `LlmError`）：那是既有的错误
     * 形状（`consumeMinimaxSse` 抛的 `Error('minimax: 流内错误：…')`），
     * 换成别的会让这条路径的行为发生变化。
     */
    let streamError: unknown
    /** 首轮失败类别（拿到 `errorText` / `status` 后重算）。 */
    let failureClass: MinimaxFailureClass = 'other'
    const accountPool = this.options.accountPool

    /**
     * 给**当前**账号记冷却（配额 24h / 限流 1h），认证类不记。
     *
     * ⚠️ 必须**每次失败后立刻调用**（含第一次、也在轮换预算用尽之前），不能挪到
     * `for` 循环开头：那样最后一个失败账号永远等不到下一次迭代，就此漏记
     *（loomy 实测：8 账号全耗尽时只记 7/8，末号漏记 ⇒ 下次请求又选中它）。
     * ⚠️ 闭包读的是**实时**的 `activeAccountId` / `failureClass`，不是创建时的快照。
     */
    const markCurrentAccount = async (): Promise<void> => {
      if (accountPool === undefined) return
      // ⚠️ auth 类**不写标记**：认证失败是账号态而非模型冷却，写了会把网关侧
      //    授权故障放大成「全池封 24h」（2026-10-06 事故，见文件头的语义表）。
      if (activeAccountId === '' || !recordsMinimaxRateLimit(failureClass)) return
      await accountPool.updateModelRateLimit(
        activeAccountId,
        options.model,
        Date.now() + (failureClass === 'rate'
          ? MINIMAX_RATE_LIMIT_COOLDOWN_MS
          : MINIMAX_QUOTA_COOLDOWN_MS),
      )
    }

    /**
     * **已产出内容后**才失败的收尾。
     *
     * 不能换号重发（会让用户看到重复内容），但**必须记账** —— 否则这个已明确
     * 失败的账号永不被冷却，下次请求又选中它（「卡死在一个号上」的残余形态：
     * 报错帧紧跟 `content_block_start` 时就是它）。
     */
    const notePartialFailure = async (error: unknown): Promise<never> => {
      // ⚠️ 用户中断（abort）不是账号失败：不记账、原样抛。
      if (options.signal?.aborted === true) throw error
      failureClass = classifyMinimaxFailure(error instanceof Error ? error.message : String(error), 0)
      await markCurrentAccount()
      throw error
    }

    /** 消费一次 2xx 响应；已产出内容后才失败时，记账并原样抛出。 */
    const attempt = async function* (
      target: Response,
    ): AsyncGenerator<StreamChunk, { error: unknown; text: string } | undefined> {
      try {
        return yield* consumeOkResponse(target)
      } catch (error) {
        await notePartialFailure(error)
      }
    }

    /** 抛出「不该换号」时的原错误（HTTP 形状逐字保留既有文案与错误码）。 */
    const throwCurrent = (): never => {
      if (streamError !== undefined) throw streamError
      /**
       * ⚠️⚠️ **地理路由要解释背景，但不能吞掉真实错误**（issue IKMEVG，自查修正）。
       *
       * 判据是 `geoRouted`（跟随**之前**看到的 307→minimaxi.com），不是状态码：
       * 跟到中国站后国际站 token 得到的 `401` 与「凭据真失效」逐字同形，
       * 拿它判会把「换个网络就能用」误报成「请重新登录」。
       *
       * ⚠️⚠️ **但 `geoRouted` 只说明「经历过 307」，不说明失败原因就是它**
       * （真实反例：`307 → 402 insufficient_balance_error`）。初版在此
       * **无条件**把错误码改成 `SERVER`，于是 402 的 `QUOTA_EXCEEDED` 被覆盖
       * ⇒ 用户看到「去填 IP / 走代理」，而**「去充值」这个唯一有效动作消失**。
       *
       * ⇒ 现在的口径：**错误码优先保留真实语义**（402 仍是 `QUOTA_EXCEEDED`），
       * 地理路由只作为**文案附加说明**。
       *
       * ⚠️⚠️ **地理路由用 `INVALID_CREDENTIAL` 而不是 `SERVER`**（自查发现的真缺陷）：
       *
       * DSH 的 `dsh-llm/lib/types/retry-policy.js` 里
       * `DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`，
       * `DEFAULT_MAX_RETRIES = 5` ⇒ 用 `SERVER` 会被 `dsh-llm-retry` **自动重试 5 次**。
       * 而地理路由是**确定性失败**（出口 IP 不会因重试而变）⇒ 每次重试都会重新选号、
       * 重新 307、重新跟到中国站、重新 401，用户白等约 15s 退避、日志凭空多一串失败。
       *
       * `INVALID_CREDENTIAL` 的官方注释恰好是同一理由
       *（"Deliberately outside the default retryable set — a malformed credential
       * fails identically on every attempt"），且它不会被文案替换
       *（DSH 只在 `QUOTA` / `AUTH` 上替换 message）。
       * ⇒ 语义对位：**确定性、不可重试、文案必须保留**。
       */
      if (geoRouted) {
        const geoDetail = errorText === '' ? undefined : errorText.slice(0, 200)
        // 402 = 余额不足，语义比「地理路由」更具体，必须保住 QUOTA_EXCEEDED。
        if (status === 402) {
          throw new LlmError(
            `minimax: ${describeMinimaxGeoRoute(geoDetail)}`,
            'QUOTA_EXCEEDED',
            { status },
          )
        }
        const code = httpErrorCode(status)
        /**
         * 只有「真实状态没有更具体语义」的档位才让地理路由接管错误码。
         * ⚠️ 接管时一律用 `INVALID_CREDENTIAL`（不可重试，见上）；
         * 若直接沿用 `AUTH` 会被 harness 的文案替换吞掉 message
         *（本仓库 IKLBSH 记过的复发形态），沿用 `SERVER` 则会触发 5 次自动重试。
         */
        const geoOwnsCode = code === 'SERVER' || code === 'AUTH'
        throw new LlmError(
          `minimax: ${describeMinimaxGeoRoute(geoDetail)}`,
          geoOwnsCode ? 'INVALID_CREDENTIAL' : code,
          status === 0 ? {} : { status },
        )
      }
      // ⚠️ 402 是**余额不足**，必须原样透出 —— 它是最常见的真实失败，
      // 归成 SERVER/AUTH 会让用户看不到「去充值」这个唯一有效动作。
      const code = status === 402 ? 'QUOTA_EXCEEDED' : httpErrorCode(status)
      throw new LlmError(
        `minimax: HTTP ${status}${errorText === '' ? '' : ` — ${errorText.slice(0, 500)}`}`,
        code,
        { status },
      )
    }

    if (response.ok) {
      const failure = yield* attempt(response)
      if (failure === undefined) return
      streamError = failure.error
      errorText = failure.text
      // ⚠️ 流内错误 / 非 SSE 的 200 都没有可用的错误状态码 ⇒ 传 0，
      //    只走「自报类别 + 自家信封码 + 文案」三条通道。
      status = 0
    } else {
      errorText = await response.text().catch(() => '')
    }

    failureClass = classifyMinimaxFailure(errorText, status)

    if (accountPool !== undefined && shouldRotateMinimaxAccount(failureClass)) {
      /**
       * 请求级账号轮换（issue IKJW32，2026-10-11）。
       *
       * - **可换号**：额度耗尽（402 / `insufficient_balance_error` / 余额不足等）、
       *   限流（429 / `rate_limit_error`）、认证（401/403）。
       * - **每个账号只试一次**：`tried` 传给 `getAvailableAccount` —— 不排除会拿回
       *   同一个号（池排序不因失败而变），换号形同虚设。
       * - **只有配额 / 限流类才写冷却**（{@link recordsMinimaxRateLimit}）。
       * - **全部试完才报错**，且带**最后一次**的真实原因 —— 笼统的「所有账号均
       *   不可用」会丢掉服务端真正说的东西（buddy 上的同款教训）。
       * - ⚠️ 换到的号**不经过**任何余额选号器（本家没有），池的手动顺序就是次序。
       */
      const tried = new Set<string>()
      if (activeAccountId !== '') tried.add(activeAccountId)
      await markCurrentAccount()

      const maxRotate = MINIMAX_MAX_ROTATE - 1
      for (let round = 0; round < maxRotate; round++) {
        const next = await accountPool.getAvailableAccount<MinimaxCredential>(
          this.product.id, options.model, tried,
        )
        if (!next || tried.has(next.entry.id)) break
        tried.add(next.entry.id)
        const nextCredential = next.credential
        /**
         * ⚠️ 池里的凭据是**裸 `JSON.parse`**（`AccountPool.getAvailableAccount`
         * 不做形状校验），手工编辑过的备份 / 损坏条目可能是 `{}`。初版写成
         * `nextCredential.access_token.length` ⇒ 这里抛 `TypeError`（**非 LlmError**）
         * 并且用的是 `break` ⇒ **一个坏号会把整个轮换掐断**，后面的好号永远轮不到。
         * ⇒ 判空后 `continue`：跳过这个坏号（不必发一发注定 401 的请求），
         *   但不放弃整池。
         */
        if (nextCredential === undefined
          || typeof nextCredential.access_token !== 'string'
          || nextCredential.access_token.length === 0) continue
        activeAccountId = next.entry.id
        credential = nextCredential
        streamError = undefined
        response = await send()
        if (response.ok) {
          const failure = yield* attempt(response)
          if (failure === undefined) return
          streamError = failure.error
          errorText = failure.text
          status = 0
        } else {
          errorText = await response.text().catch(() => '')
          status = response.status
        }
        failureClass = classifyMinimaxFailure(errorText, status)
        await markCurrentAccount()
        if (!shouldRotateMinimaxAccount(failureClass)) throwCurrent()
      }

      throw new LlmError(
        `minimax: 模型 ${options.model} 所有账号均不可用（${errorText === '' ? `HTTP ${status}` : errorText.slice(0, 500)}）`,
        failureClass === 'rate' ? 'RATE_LIMIT'
          : failureClass === 'auth' ? 'AUTH'
            : 'QUOTA_EXCEEDED',
        status === 0 ? {} : { status },
      )
    }
    throwCurrent()
  }
}

/** 在 `ctx.llm` 上注册 minimax provider 路由与适配器。 */
export function registerMinimaxLlm(
  ctx: Context,
  options: MinimaxAdapterOptions,
): MinimaxAdapter {
  const product = options.product ?? MINIMAX
  const adapter = new MinimaxAdapter({
    ...options,
    // ⚠️ 注入**唯一**的广播实现（`src/catalog-broadcast.ts`），不要在这里
    // 另写一份 emit —— 两份实现必然漂移（issue IKJVTF 的缺陷① 就是「十处全漏」）。
    onCatalogLoaded: () => broadcastCatalogChanged(ctx),
    // ⚠️ 告警必须真的能被看见（2026-10-27 审计）：`warn` 承载
    // 「预判续期失败 → 降级发送」这条**静默风险**，缺省退回 `console.warn`
    // 而不是吞掉（与 autoclaw / astudio 同约定）。
    warn: options.warn ?? ((message: string) => { ctx.logger.warn(message) }),
  })
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
