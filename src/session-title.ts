/**
 * `purpose: 'session-title'`（DSH 会话自动命名）的**跨 provider 统一处置**。
 *
 * ## 为什么必须有这一层（issue IKKVDH）
 *
 * DSH 的 `@deepseek-ai/dsh-session-title-llm` 用**极小的输出预算**发一次
 * 辅助请求给模型，指望把预算全留给可见标题：
 *
 * - `maxTokens: 64`（`dsh-base` 的 `cordis.patch.yml` 默认值）
 * - **不传 `reasoningEffort`**
 * - 传 `purpose: 'session-title'`
 *
 * 官方 `dsh-llm-deepseek` 据此把思考**强制关掉**：
 *
 * ```js
 * const effort = options.purpose === "session-title" ? "off" : …
 * ```
 *
 * 而本插件各适配器**从未读 `options.purpose`** ⇒ 标题请求带着思考发出。
 * 实测（2026-10-11，本机真实凭据，CodeBuddy `deepseek-v4.1-flash`）：
 *
 * | 请求的思考控制 | `reasoning_tokens` | 正文 | `finish_reason` |
 * |---|---|---|---|
 * | `thinking:enabled` + `effort:high`，`max_tokens:64` | **64（吃满）** | **0 字符** | `length` |
 * | `thinking:enabled` + `effort:low`，`max_tokens:64` | **64（吃满）** | **0 字符** | `length` |
 * | 两个字段都不发，`max_tokens:64` | 0 | 10 字符 | `stop` |
 * | 开思考但 `max_tokens:512` | 153 | 10 字符 | `stop` |
 *
 * 即：**思考恰好把 64 个 token 全部占满，正文一个字都没轮到**。
 * `dsh-session-title-llm` 的 `finishError()` 见 `max-tokens` 直接拒绝
 * （`title output reached maxOutputTokens`），标题永远停在 fallback ——
 * 用户侧看到的就是「DSH 好像没有自动起标题功能」。
 *
 * 本机 737 个会话日志的统计佐证：240 次标题请求里 **109 次以 fallback 收场**，
 * 且成功/失败样本的 `maxTokens` **全是 64**（失败不能由预算差异解释），
 * 其中 106/109 例的同一会话主请求正常产出正文（凭据、网络、模型均无问题）。
 *
 * ## 抽象边界：**判据与预算共享，协议细节各家自留**
 *
 * 关思考的**字段形态**各家完全不同，且都是实测得来的，**不能强行统一**：
 *
 * | provider | 关闭思考的写法 | 依据 |
 * |---|---|---|
 * | buddy / workbuddy | deepseek 系**发裸请求**（不发 `thinking` 也不发 `reasoning_effort`） | 实测裸请求 `reasoning_content` 恒为 0 |
 * | codearts | 顶层 `thinking:{type:'disabled'}` | 实测 `reasoning_tokens` 3/3 全 0 |
 * | raccoon | `extra_body.thinking:{type:'disabled'}` | 实测 6/6、8/8 全 0 |
 * | minimax | `thinking:{type:'disabled'}`（仅 `switchable` 模型） | 实测 0 思考字符；M3.1 强制 adaptive 会被 400 |
 * | lobsterai / cline / loomy / opencode / qoder | 档位 `off` / `none` | 各家远端档位表 |
 *
 * 故本模块**只**回答三件与协议无关的事，协议细节留给各适配器：
 *
 * 1. {@link isSessionTitleCall} —— 这次是不是标题请求；
 * 2. {@link thinkingOffEffortOf} —— 该模型声明的档位里，哪一个是「关闭思考」；
 * 3. {@link SESSION_TITLE_MIN_MAX_TOKENS} —— **确实关不掉**思考时把预算抬到多少。
 *
 * ⚠️ **关得掉就不要抬预算**：抬预算是「花钱买通」而非修复 —— 它让思考先烧掉
 * 一百多个 token 才轮到正文（实测 153），而关掉思考时同一次请求
 * `credit` 为 **0**（思考是要计费的）。故两者的顺序是**先关、关不掉才抬**。
 */

import { isThinkingOffEffort } from './reasoning-ladder.js'
import { titleEffortWhenStrongest } from './reasoning-default.js'

/**
 * DSH 给辅助标题请求打的用途标记（`GenerateOptions.purpose` 的取值之一）。
 *
 * 另一个取值是 `'compaction'`（长会话压缩），它**不在**本模块的处置范围内：
 * 压缩需要真的理解上下文，关掉思考反而有害，且它的预算由
 * `compaction-basic.maxTokens` 决定（本机 profile 为 8192），不存在 64 token
 * 被思考吃满的问题。与官方适配器只特殊处理 `session-title` 的口径一致。
 */
export const SESSION_TITLE_PURPOSE = 'session-title'

/**
 * 会话标题请求的判据。
 *
 * ⚠️ **必须按 `purpose` 判，不能按 `maxTokens` 大小猜**：DSH 允许部署方改
 * `maxOutputTokens`（本机为 64，但可以调大），而 `purpose` 是契约字段。
 * 按预算猜会在用户调大预算后**静默失效**（思考不再被关，白烧 token）。
 *
 * @param options - 适配器收到的请求（只取 `purpose`）。
 * @returns 是否为会话标题请求。
 */
export function isSessionTitleCall(options: { purpose?: string } | undefined): boolean {
  return options?.purpose === SESSION_TITLE_PURPOSE
}

/**
 * **关不掉**思考时，发往上游的 `max_tokens` 下限。
 *
 * 依据（issue IKKVDH 的实测 A/B 对照，本仓库复现见模块头）：
 * 标题提示词只要求输出一行（约 10 个 CJK 字 ≈ 10 token），故模型思考完
 * 输出极短正文即 `stop`；问题只在于**思考本身**要占掉一百多个 token。
 * 实测 512 时：`reasoning_tokens: 153` + 正文 10 字符 + `finish_reason: stop` ✅。
 *
 * ⚠️ **这是兜底而非等价物**：它多烧约 150 个模型 token。只有在该模型
 * 确实没有任何「关闭思考」手段时才用（见 {@link thinkingOffEffortOf}）。
 */
export const SESSION_TITLE_MIN_MAX_TOKENS = 512

/**
 * 从模型声明的档位里挑出「关闭思考」那一档。
 *
 * 判据复用 {@link isThinkingOffEffort}（强度序 rank === 0），故各家的私有写法
 * （`off` / `none`）都能命中，不必逐家列举。
 *
 * ⚠️ **不支持「档位缺失即视为关闭」**：档位表为空有两种截然不同的含义 ——
 * 「该模型不支持思考」（不发即可）与「该模型默认就思考且关不掉」（本函数
 * 必须返回 `undefined`，让调用方走抬预算分支）。区分依据只能由各适配器
 * 提供（它们才知道自家目录的语义），故这里**只**回答「声明了哪个档」。
 *
 * @param declaredEfforts - 该模型声明的档位 id（顺序无关）。
 * @returns 「关闭思考」档的 id；该模型没有这一档时返回 `undefined`。
 */
export function thinkingOffEffortOf(declaredEfforts: readonly string[]): string | undefined {
  return declaredEfforts.find((effort) => isThinkingOffEffort(effort))
}

/**
 * 一次请求的思考与预算决策（{@link planSessionTitleThinking} 的产出）。
 */
export interface SessionTitleThinkingPlan {
  /** 是否为会话标题请求（非标题请求时其余字段与入参逐一相同）。 */
  readonly isTitle: boolean
  /**
   * 要下发给上游的档位；`undefined` 表示**不发该字段**。
   *
   * ⚠️ 标题请求下 `undefined` 有**三种**来源，调用方必须靠 {@link thinkingOff}
   * 区分（只看 `effort` 会误判）：
   * ① 该家靠「不发字段」关闭思考（buddy 的 deepseek 系，`thinkingOff: true`）；
   * ② 调用方**本来就没给**档位、且该家关不掉（`thinkingOff: false`）——
   *    此时「不发字段」**不等于**关闭思考，只是没有档位可发；
   * ③ 该家关不掉且调用方给了档位 → `effort` 就是那个档位（非 undefined）。
   *
   * ②是脆弱点：将来某家若引入「不发 = 关闭」的语义，此处会静默关掉思考而
   * `thinkingOff` 仍报 `false`。故**适配器应以 `thinkingOff` 为准**决定
   * 「是否还需要抬预算」，不要用 `effort === undefined` 反推思考已关。
   */
  readonly effort: string | undefined
  /**
   * 思考是否**确实关闭**了。
   *
   * `false` 意味着本次标题请求会把预算的一部分花在思考上（已由
   * {@link maxTokens} 抬预算兜底）。调用方可据此记日志。
   */
  readonly thinkingOff: boolean
  /** 要下发给上游的输出上限（关不掉时已抬到 {@link SESSION_TITLE_MIN_MAX_TOKENS}）。 */
  readonly maxTokens: number | undefined
}

/**
 * 算出一次请求该下发什么档位、以及预算要不要抬。
 *
 * 决策顺序（**顺序即优先级**，三条互斥）：
 * 1. 非标题请求 → **逐字段原样返回**（保证普通对话零行为变化）；
 * 2. 标题请求且**关得掉**（模型声明了 `off`/`none` 档，或 `disableByOmission`
 *    为真）→ 下发「关闭思考」档、**预算不动**；
 * 3. 标题请求但**关不掉** → 档位**降到最弱**的一档（2026-11-11 起；此前是
 *    「保留原档位」），并把预算抬到 {@link SESSION_TITLE_MIN_MAX_TOKENS}
 *    （只在原预算更小时抬，绝不调小）。
 *
 * @param input.purpose - `GenerateOptions.purpose`。
 * @param input.requestedEffort - 调用方给的档位（DSH 会把模型默认档注入这里）。
 * @param input.declaredEfforts - 该模型声明的档位 id。
 * @param input.maxTokens - 调用方给的输出上限。
 * @param input.disableByOmission - 该家是否「不发任何思考字段」即等于关闭思考
 *   （buddy 的 deepseek 系实测如此）。默认 `false`。
 * @returns 决策结果。
 */
export function planSessionTitleThinking(input: {
  purpose: string | undefined
  requestedEffort: string | undefined
  declaredEfforts: readonly string[]
  maxTokens: number | undefined
  disableByOmission?: boolean
}): SessionTitleThinkingPlan {
  if (!isSessionTitleCall({ purpose: input.purpose })) {
    return {
      isTitle: false,
      effort: input.requestedEffort,
      thinkingOff: false,
      maxTokens: input.maxTokens,
    }
  }
  const offEffort = thinkingOffEffortOf(input.declaredEfforts)
  if (offEffort !== undefined) {
    return { isTitle: true, effort: offEffort, thinkingOff: true, maxTokens: input.maxTokens }
  }
  if (input.disableByOmission === true) {
    // 不带档位 = 关闭（该家已实测）。`effort` 必须是 `undefined`，
    // 否则调用方一「补默认档」就把思考又打开了。
    return { isTitle: true, effort: undefined, thinkingOff: true, maxTokens: input.maxTokens }
  }
  /**
   * ⚠️ **关不掉时：降到最弱的一档 **并且** 抬高预算**（两件事都要做）。
   *
   * 2026-11-11 起本插件的默认档被 `reasoning-default.ts` 抬到**最强**档
   * （用户要求）。标题请求只给 64 token，若照原样保留「最强档」，思考会把预算
   * 吃满、正文 0 字符 —— 正是 issue IKKVDH 的原始形态，只是触发条件从
   * 「high」变成了「max/extra_high」。
   *
   * ⚠️ **只降档不改预算是不够的**：实测（模块头那张表）`effort:low` + 64 token
   * 同样是「64 吃满、正文 0 字符」⇒ 思考只要开着就至少吃掉几十个 token，64 永远
   * 不够。故两条腿缺一不可：档位取最弱（少吃）、预算抬到下限（够吃）。
   *
   * ⚠️ 这**不是**「静默降档」（原注释里被否掉的那种）：标题请求是一次**内部
   * 辅助请求**，用户从不在界面上为它选档位，且它的档位本来就由本函数全权决定
   * （`disableByOmission` 分支同理）。普通对话路径完全不受影响（上面第一段早退）。
   *
   * ⚠️⚠️ **降档只在「默认取最强档」开着时发生**（`titleEffortWhenStrongest`）：
   * 开关关掉后默认档回到各家自己的 `high`，此时再降档就是一次**白降**
   * （64 token 本来就够 `high` 用，实测 153 思考 + 10 字正文），用户看不到原因。
   */
  const weakest = titleEffortWhenStrongest(input.declaredEfforts)
  return {
    isTitle: true,
    // 有可用非关闭档 ⇒ 用最弱那一档；一个都没有（档位为空/只剩关闭档）⇒ 保留调用方的。
    effort: weakest ?? input.requestedEffort,
    thinkingOff: false,
    // ⚠️ 抬预算前先确认原值是**正安全整数**：`Math.max(NaN, 512)` 仍是 `NaN`，
    // 而 `NaN` 经 `JSON.stringify` 会变成 `null` 发给上游（DSH 只校验
    // `defaultMaxTokens`，**不校验** `options.maxTokens`，故这道防线在我们这侧）。
    // 非安全整数的原值原样返回（不编造、也不放大），与「未知不编造」一致。
    maxTokens: input.maxTokens !== undefined
      && Number.isSafeInteger(input.maxTokens)
      && input.maxTokens > 0
      ? Math.max(input.maxTokens, SESSION_TITLE_MIN_MAX_TOKENS)
      : input.maxTokens,
  }
}
