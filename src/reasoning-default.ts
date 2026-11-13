/**
 * 「选择模型后默认取**最强思考档**」的策略层。
 *
 * ## 为什么必须在这一层（三段实测证据）
 *
 * 用户要求：在模型选择器里选完模型，思考强度自动落在最高档（`max` / `extra_high`
 * 这类），而不是各家适配器写的 `high`。四条可能的实现路线逐条核对后只剩这一条：
 *
 * | 路线 | 结局 |
 * |---|---|
 * | ① 请求期改写（`agent/request` 瀑布 / `prepareRequest`） | ❌ **不可行**：`dsh-agent-loop/lib/index.js` 的 `prepareRequest` 有一条硬不变式 —— `proposedConfig.reasoningEffort !== selection.reasoningEffort` 就**直接抛错**（「use agent.model.select() before step preparation」），整轮对话起不来 |
 * | ② 逐个适配器改 `defaultEffort` 常量 | ❌ 二十余处，且 trae / buddy / zcode 等档位来自**远端目录**，根本不在常量里 ⇒ 必然漂移（本仓库「一文件两套同义判据」是红线） |
 * | ③ 在 `stream()` 里补档位 | ❌ 界面标签不变（用户看不到生效）、网关 `resolveCallWithInfo` 仍按声明校验、二十个适配器各写一份 |
 * | ④ **改适配器声明的 `reasoning.defaultEffort`**（本文件） | ✅ 一处覆盖全部渠道，且三端同时一致 |
 *
 * ④ 成立的依据是宿主这三处**逐字**行为（2026-11-11 核对 0.2.2-rc.1 产物）：
 *
 * ```
 * dsh-client-ui-model-selection/lib/client.js:1201
 *   selection = { provider, model, ...model.reasoning?.defaultEffort }
 *   // ← 菜单里选中某个模型时带的档位，就是**适配器声明的那一个**
 * 同文件 :872-884（`select()`）与 :1987（`/model` 弹窗的 `selectionOf`）
 *   // ← 两个入口共用同一份数据 ⇒ 改声明即两处同时生效
 * dsh-llm/lib/index.js:2198
 *   const effective = requested ?? reasoning.defaultEffort
 *   // ← 宿主不传档位时，用的也是声明里的默认档
 * ```
 *
 * 于是「声明里给最强档」= 用户选模型后 UI 标签、实际下发、网关 `/v1/models`
 * 三处都落在最强档，且**不需要碰任何 `stream()`**。
 *
 * ## ⚠️ 必须同时包 `resolveModel` 与 `prepareCall().model`（只包前者是假绿）
 *
 * 生产路径是 `adapter.prepareCall(...)` → `normalizeModelInfo(adapterCall.model)`
 * → `resolveCallWithInfo`，**从不**调用顶层 `resolveModel`。这与
 * `llm-register-compat.ts` 里 Token 记账踩过的坑同型（见
 * `tests/unit/token-ledger-wiring.spec.ts` 的「两层包装」段）：
 * 只包界面那一条腿会得到「选择器显示 Max、请求仍按 high 发」。
 *
 * ## ⚠️ 本文件推翻的四处**既有决策**（别再当成回归改回去）
 *
 * | 位置 | 原决策 | 现在 |
 * |---|---|---|
 * | `trae-adapter.ts` 的 `defaultTraeEffort` | 采信上游 `default_level`（理由：一律取最强档会让每轮顶格思考） | 函数保留为「模型默认」，但用户偏好由本层覆盖为最强档 |
 * | `loomy-adapter.ts` 的 `LOOMY_PREFERRED_DEFAULT_EFFORT` | `high`（理由同上） | 同上 |
 * | `cline-product.ts` | `high`，「用户明确要求」的既定口径 | 现在变 `max`（UI 名 **Extra**） |
 * | `aggregate-adapter.ts` 的 `aggregateReasoningInfo` | `high`，理由明写「取 `max` 最费 token/积分」 | 现在变 `max`（**封顶 `max`，不进 `ultra`**，见下） |
 *
 * 代价（用户已知悉并明确要求）：思考 token 计入 `completion_tokens`，与正文共享
 * 额度 ⇒ 同样 `max_tokens` 下正文更早撞 `length`、首字更慢。这是**功能本身**，
 * 不是缺陷。
 *
 * ## ⚠️ 封顶在 `max`（`ultra` 不选）
 *
 * `REASONING_EFFORT_RANK` 里 `ultra: 9` 比 `max: 8` 还高，但它只是「CC Switch
 * 枚举里最强的一档」，本仓库此前**没有任何渠道**把它当真实 wire 值（它的存在意义
 * 是翻译）。聚合渠道把 8 个规范档全声明了，若不封顶，聚合模型的默认档会变成
 * `ultra` —— 用户从界面上看是一个谁都没验证过的档位。⇒ 选档时**优先在
 * `rank <= max` 里挑**；只有模型**仅**声明了比 `max` 更强的档位时才退回用它们
 * （那样至少比「不动」更贴合意图）。
 */

import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'

import { CANONICAL_REASONING_EFFORTS, reasoningRankOf } from './reasoning-ladder.js'
import { PROVIDER_REGISTRY } from './provider-registry.js'

/**
 * 开关的读取源：返回 `true` = 默认取最强档（当前行为），`false` = 逐字节回到
 * 改动前的行为（各适配器自己声明的 `defaultEffort`）。
 *
 * ⚠️ 是一个**回调**而不是一个布尔：用户随时可能在设置里切换，而每次请求都会
 * 走 `prepareCall` ⇒ 必须**每次现读**（与 `nativeWebSearchEnabled` 同一条约定：
 * 缓存住回调的返回值就等于「改了不生效，要重启」）。
 *
 * ⚠️ 缺省（未接线）时为 `true`：插件装配没传 store 时保持功能开启，
 * 与本功能引入时的行为一致。
 */
let enabledSource: (() => boolean) | undefined

/**
 * 接线开关来源（由 `index.ts` 在装配阶段调用一次）。
 *
 * @param source - 返回「是否默认取最强档」的回调；`undefined` 表示回到「恒开」。
 */
export function configureStrongestReasoningEnabled(source: (() => boolean) | undefined): void {
  enabledSource = source
}

/**
 * 当前是否启用「默认取最强档」。
 *
 * ⚠️ 读取失败**按开启**处理（与文档缺键语义同一条取向）：抛错的回调若被当成
 * 「关闭」，用户会看到功能无缘无故消失，且毫无线索。
 *
 * @returns 启用时为 true。
 */
export function strongestReasoningEnabled(): boolean {
  if (enabledSource === undefined) return true
  try {
    return enabledSource() !== false
  } catch {
    return true
  }
}

/**
 * 封顶档（`rank` 上界）：本层**不会**选出比它更强的档。
 *
 * ⚠️ 与 `REASONING_EFFORT_RANK` 的关系：那是**强度序的唯一权威**，这里只读它，
 * 不另立阈值数字（改顺序表时这里自动跟随，除 `ultra` 这一格是刻意的产品选择）。
 */
const EFFORT_CAP = 'max'

/** 模型声明的思考档（`LlmResolvedModelInfo['reasoning']` 的子集，便于纯函数测试）。 */
export type DeclaredReasoning = NonNullable<LlmResolvedModelInfo['reasoning']>

/**
 * 从**已声明**的档位里挑最强的一档。
 *
 * 规则（顺序即优先级）：
 * 1. 只考虑 `REASONING_EFFORT_RANK` 里**登记过**的 id —— 拿一个不认识的私有名字
 *    当「最强」等于凭空猜强度（与 `translateReasoningEffort` 同口径）；
 * 2. `rank === 0`（`off` / `none`）**永不**被选为「最强」（那是关闭思考）；
 * 3. 在 `rank <= EFFORT_CAP` 的候选里取 `rank` 最大者；一个都没有时才退到
 *    全体已知档位（只声明了 `ultra` 这类极端形态），再没有就返回 `undefined`；
 * 4. **同 rank 取规范名更靠后的那个**（`high` 胜 `on`）—— 同距取强是仓库既有
 *    口径，且它让 `codearts`/`raccoon` 的 `['off','on']` 稳定落到 `on`。
 *
 * @param efforts - 模型声明的档位 id（顺序无关）。
 * @returns 最强档的 id；模型没有任何「开思考」的已知档位时返回 `undefined`。
 */
export function strongestDeclaredEffort(efforts: readonly string[]): string | undefined {
  const capRank = reasoningRankOf(EFFORT_CAP) ?? Number.POSITIVE_INFINITY
  let capped: { effort: string; rank: number } | undefined
  let any: { effort: string; rank: number } | undefined
  for (const effort of efforts) {
    const rank = reasoningRankOf(effort)
    // 未登记 ⇒ 不知道强度，不猜；0 ⇒ 关闭思考，绝不能当「最强」。
    if (rank === undefined || rank === 0) continue
    if (any === undefined || betterEffort(effort, rank, any.effort, any.rank)) any = { effort, rank }
    if (rank > capRank) continue
    if (capped === undefined || betterEffort(effort, rank, capped.effort, capped.rank)) {
      capped = { effort, rank }
    }
  }
  return (capped ?? any)?.effort
}

/**
 * 从**已声明**的档位里挑「最省思考、但又不是关闭」的一档。
 *
 * 用途：会话标题请求（`purpose: 'session-title'`，宿主只给 64 token）。
 * 关得掉思考时用「关闭档」；**关不掉**时（trae / gemini / zcode / lobsterai…）
 * 原先保留调用方给的档位 —— 而本层把默认档抬到最强之后，那等于让 64 token 的
 * 标题请求顶格思考。⇒ 改成降到最弱一档：省 token、且标题只要一行。
 *
 * @param efforts - 模型声明的档位 id（顺序无关）。
 * @returns 最弱的非关闭档；模型没有任何「开思考」档位时返回 `undefined`。
 */
export function weakestThinkingEffort(efforts: readonly string[]): string | undefined {
  let best: { effort: string; rank: number } | undefined
  for (const effort of efforts) {
    const rank = reasoningRankOf(effort)
    if (rank === undefined || rank === 0) continue
    if (best === undefined || betterEffort(best.effort, best.rank, effort, rank)) best = { effort, rank }
  }
  return best?.effort
}

/**
 * `a` 是否比 `b` 更该被选中（同一条判据给「最强」与「最弱」两处用，方向由参数决定）。
 *
 * @param aEffort - 候选 a 的 id。
 * @param aRank - 候选 a 的强度。
 * @param bEffort - 候选 b 的 id。
 * @param bRank - 候选 b 的强度。
 * @returns a 更优时为 true。
 */
function betterEffort(aEffort: string, aRank: number, bEffort: string, bRank: number): boolean {
  if (aRank !== bRank) return aRank > bRank
  // 同 rank：规范名更靠后的胜（`high` 胜 `on`）。两处都不在规范名表里时保持原序。
  return canonicalIndex(aEffort) > canonicalIndex(bEffort)
}

/** 规范名表里的位置；未登记返回 -1（比任何登记值都小，故不会抢占同 rank 的登记名）。 */
function canonicalIndex(effort: string): number {
  return CANONICAL_REASONING_EFFORTS.indexOf(effort)
}

/**
 * 会话标题请求该用哪一档（**跟随开关**）。
 *
 * 关掉「默认取最强档」时返回 `undefined` —— 调用方据此走**改动前**的分支
 * （保留调用方给的档位 + 抬预算）。开关是**一对**语义：提档与降档必须同开同关，
 * 只留降档会让「关不掉思考」的模型在标题请求里被无理由降档（那是一次白降，
 * 用户看不出原因）。
 *
 * ⚠️ 为什么单独包一层而不是让调用方判开关：判据只能有一处。若 `session-title.ts`
 * 自己判 `strongestReasoningEnabled()`，将来开关语义变化就要改两个文件 ——
 * 正是本仓库反复记载的「一文件两套同义判据」。
 *
 * @param declaredEfforts - 模型声明的档位 id。
 * @returns 最弱的非关闭档；开关关闭或没有可用档位时为 `undefined`。
 */
export function titleEffortWhenStrongest(declaredEfforts: readonly string[]): string | undefined {
  if (!strongestReasoningEnabled()) return undefined
  return weakestThinkingEffort(declaredEfforts)
}

/**
 * 把一份模型元数据里的 `defaultEffort` 改成最强档。
 *
 * 三条不变式：
 * - **只在真的变化时**返回新对象；否则**原样返回入参**（同一引用）—— 下游会
 *   `deepFreeze` / 比较身份，白拷一份既浪费也让「无变化」无法断言；
 * - 选出来的档位**必定来自 `efforts`** ⇒ 不可能触发 `INVALID_MODEL_REASONING`
 *   （`dsh-llm` 校验 `defaultEffort` 必须在声明内）；
 * - 模型没声明档位（`reasoning === undefined` / `efforts` 为空）时**不动**
 *   —— 那五家（officeace / codely / marvis / baizhi / monkeycode）本来就
 *   没有档位可调，见 {@link PROVIDERS_WITHOUT_REASONING}。
 *
 * @param info - 适配器 `resolveModel` / `prepareCall` 产出的元数据。
 * @returns 可能被改写的元数据（无变化时是同一对象）。
 */
export function withStrongestDefaultEffort<T extends { reasoning?: DeclaredReasoning }>(info: T): T {
  // ⚠️ 开关关掉时**原样返回入参**（同一引用）：下游会 `deepFreeze` / 比较身份，
  //    且「关掉 = 逐字节回到改动前」这条承诺靠的就是这里什么都不做。
  if (!strongestReasoningEnabled()) return info
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.efforts.length === 0) return info
  const declared = reasoning.efforts.map((effort) => String(effort.id))
  const strongest = strongestDeclaredEffort(declared)
  // 没有可选的「开思考」档（如 modelscope 的 `['none']`）⇒ 保持原声明。
  if (strongest === undefined || strongest === String(reasoning.defaultEffort)) return info
  const effort = reasoning.efforts.find((candidate) => String(candidate.id) === strongest)
  if (effort === undefined) return info
  return { ...info, reasoning: { ...reasoning, defaultEffort: effort.id } } as T
}

/**
 * **不声明任何思考档位**的渠道（Jet Hub 面板里给灰字提示用）。
 *
 * ⚠️ 这份名单是**行为事实**，不是配置：它列的每一家适配器的 `resolveModel`
 * 都**从不**返回 `reasoning`。名单由 `tests/unit/model-catalog-parity.spec.ts`
 * 的第 (j) 格钉住（跑真实适配器，逐家点名）。
 *
 * ⚠️ **`reasoning` 字段缺席有两种成因**，必须分开（本名单只收第 ① 种）：
 * ① **结构上没有**（本名单）：适配器的 `toCatalogEntry` 里根本不写该字段 ——
 *    灰字对它们永远成立；
 * ② **暂时没有**（远端驱动，冷缓存时为空）：`trae` / `lobsterai` / `accio` /
 *    `qiniu` 的档位来自上游目录，没有远端数据时 `efforts` 是空数组、`reasoning`
 *    整个缺席 —— 热缓存下它们有档位。
 * ⇒ ② 类渠道**绝不能**进本名单：那会让面板对它们说「没有思考档位」，而用户
 *    一拉目录就能看到档位选择器（对用户说假话）。
 */
export const PROVIDERS_WITHOUT_REASONING: readonly string[] = Object.freeze([
  // 华为 MaaS 云端直连：`resolveModel` 只回 name / inputModalities / context。
  'officeace',
  // 白泽 + 网关常量两段合并的目录，条目里没有档位字段。
  'monkeycode',
  'monkeycodeintl',
  // 百智云：兜底表与远端条目都不带档位（`baizhi-adapter` 全程不写 `reasoning`）。
  'baizhi',
  // 腾讯 Marvis：`marvis-adapter.ts` 明写「思考默认开且关不掉 ⇒ 刻意不声明」。
  'marvis',
  // Codely：能力表里的 `reasoning` 是**徽标**（`CODERLY_ABILITY_LABEL`），
  // 不是 DSH 的档位声明 —— `resolveModel` 从不返回 `reasoning`。
  'codely',
])

/**
 * 该渠道是否**完全不提供**思考档位（面板据此显示灰字）。
 *
 * ⚠️ 只认 {@link PROVIDERS_WITHOUT_REASONING}，**不**按 `listModels` 结果猜 ——
 * 猜需要逐模型 `resolveModelInfo`（设置页每展开一家就要 N 次调用，且聚合渠道
 * 冷帧会返回「没有档位」的保守元数据 ⇒ 变成**假话**）。
 *
 * @param provider - provider id。
 * @returns 该渠道不提供档位时为 true。
 */
export function providerWithoutReasoning(provider: string): boolean {
  return PROVIDERS_WITHOUT_REASONING.includes(provider)
}

/**
 * 已注册渠道全集（守卫用例与面板共用，避免两处各列一份）。
 *
 * ⚠️ 取自 `PROVIDER_REGISTRY`（渠道权威清单），**不含** `aggregate` / `auto`
 * 这两个本插件自造的虚拟 provider —— 它们的档位由聚合层机械投影，不参与上述判据。
 */
export function registeredChannelIds(): readonly string[] {
  return PROVIDER_REGISTRY.map((entry) => entry.id)
}

/** 适配器的最小形状（本层只碰这两个方法，其余原样透传）。 */
interface ReasoningCapableAdapter {
  resolveModel?(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
  prepareCall?(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
  [key: string]: unknown
}

/**
 * 给适配器包上「默认档 = 最强档」。
 *
 * 用 Proxy 而不是对象展开：适配器是 **class 实例**，原型方法在展开后会全部丢失
 * （`listModels` 变成 not a function ⇒ 整个 provider 的目录失效）。这与
 * `wrapAdapterWithTokenLedger` 的取舍逐字同因。
 *
 * 只拦两个方法：
 * - `resolveModel` —— 目录 / 选择器 / 网关 `/v1/models` 读的是它；
 * - `prepareCall` —— ⚠️ **生产路径唯一会走到的那个**，包的是**返回值的 `model`**
 *   （不是 `prepareCall` 自身：`call.stream` 与 `model` 是两个字段）。
 *
 * @param providers - 该适配器注册的 provider id 列表（只取第一个做日志标签）。
 * @param adapter - 适配器实例。
 * @returns 同一个适配器（包装后）；`resolveModel` / `prepareCall` 缺席时原样返回。
 */
export function withStrongestReasoningDefault<T extends object>(providers: readonly string[], adapter: T): T {
  const target = adapter as ReasoningCapableAdapter
  const label = providers[0] ?? ''
  const bound = new Map<PropertyKey, unknown>()
  /** 懒建一次并缓存：下游按函数身份缓存时不会失配（同 `dead-model-store.ts` 的写法）。 */
  const wrapOnce = (key: PropertyKey, make: () => unknown): unknown => {
    if (!bound.has(key)) bound.set(key, make())
    return bound.get(key)
  }

  return new Proxy(adapter, {
    get(obj, prop, receiver) {
      if (prop === 'resolveModel' && typeof target.resolveModel === 'function') {
        return wrapOnce(prop, () => async (...args: unknown[]): Promise<unknown> => {
          const info = await target.resolveModel!.apply(target, args as never)
          return grewEffort(label, info)
        })
      }
      if (prop === 'prepareCall' && typeof target.prepareCall === 'function') {
        return wrapOnce(prop, () => async (...args: unknown[]): Promise<unknown> => {
          const call = await target.prepareCall!.apply(target, args as never)
          if (call === null || typeof call !== 'object') return call
          const record = call as { model?: unknown }
          if (record.model === undefined) return call
          const rewritten = grewEffort(label, record.model)
          // 无变化时**原样返回**（不重造对象）：下游有按身份比较的路径。
          return rewritten === record.model ? call : { ...(call as object), model: rewritten }
        })
      }
      // 其余成员原样透传，且 `this` 绑回**原适配器**（私有字段 #x 对 Proxy 不可见）。
      return Reflect.get(obj, prop, receiver)
    },
  })
}

/**
 * 已打过「档位被提升」日志的 `provider/model`（进程级，**只用于去重日志**）。
 *
 * ⚠️ 必须有：每轮对话的**每一步**都会走 `prepareCall`，每次都返回新对象
 * （档位确实被改写）⇒ 不去重就是每步刷一条日志，把真正有用的行淹掉。
 * ⚠️ 用 `Set` 而不是 `WeakMap`：键是短字符串、数量等于模型总数（几十个），
 * 且进程生命周期内不会回收 —— 与「每步一条」相比这是可以忽略的内存。
 */
const announced = new Set<string>()

/**
 * 改写一次元数据，并在**首次**提升时留一行日志。
 *
 * ⚠️ 日志只在**该模型第一次**被提升时打（见 {@link announced}）：既让用户/排障者
 * 看得到「哪些模型被提档了」，又不会每步刷屏。
 *
 * ⚠️ 日志走 `console.info` 而不是 `ctx.logger`：包装发生在注册漏斗，`ctx` 不在
 * 作用域内；而这不是告警（是一次**预期的**偏好覆盖），不该进 error 通道。
 *
 * @param provider - 适配器标签（日志用）。
 * @param info - 适配器产出的元数据。
 * @returns 改写后的元数据（无变化时同一引用）。
 */
function grewEffort(provider: string, info: unknown): unknown {
  if (info === null || typeof info !== 'object') return info
  const record = info as { id?: unknown; reasoning?: DeclaredReasoning }
  const before = record.reasoning?.defaultEffort
  const after = withStrongestDefaultEffort(record as { reasoning?: DeclaredReasoning })
  if (after === record) return info
  const next = after.reasoning?.defaultEffort
  const key = `${provider}/${String(record.id ?? '?')}`
  if (!announced.has(key)) {
    announced.add(key)
    console.info(
      `[jet-hub] 思考档位默认取最强：${key} `
      + `${before === undefined ? '（原本未声明默认档）' : String(before)} → ${String(next)}`,
    )
  }
  return after
}

/** 清空 {@link announced}（**只供单测**：用例之间不得互相影响日志去重态）。 */
export function resetReasoningDefaultAnnouncements(): void {
  announced.clear()
}
