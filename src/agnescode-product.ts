/**
 * AgnesCode 系的站点常量（国内站 + 国际版）。
 *
 * ## 为什么是**两个 provider id**，而不是一个 id 带站点参数
 *
 * AgnesCode 的两站（`*.agnes-ai.cn` / `*.agnes-ai.com`）是两套账号体系，
 * 且本仓的**模型目录按 provider 缓存一份**（`model-catalog.ts`）——
 * 单 id 下另一站的模型要么不进列表、要么被静默回退成本站模型。
 * 与 `minimax` / `minimaxintl`、`qoder` / `qodercn` 同构，两站各占一个 id。
 *
 * ⚠️ `provider-registry.ts` 要求 id **纯小写字母**（`^[a-z]+$`），
 * 故国际版只能是 `agnescodeintl`，不能带连字符/下划线。
 *
 * ## 为什么这里**没有** base URL 常量
 *
 * 推理与 BFF 的 base 是**每账号数据**：它来自桌面端会话文件里的
 * `bffPublicBaseUrl`，并经过 {@link ./agnescode.ts} 的 origin 钉扎。
 * 把一个 base 写成常量就等于「所有账号都打到同一个站」——这正是国际版
 * 凭据被发到国内站的成因。本文件的 `fallbackBffBase` 只服务一种场景：
 * 用户**手工粘贴 token** 且没给 base（自动采集路径永远用会话里的那份）。
 *
 * @module src/agnescode-product.ts
 */

/** AgnesCode 的站点 id（同时是 cordis 服务名、LLM 路由名与注册表 id）。 */
export type AgnescodeProviderId = 'agnescode' | 'agnescodeintl'

/**
 * 站点身份（与参考实现的 `AgnescodeDomain` 同义）。
 *
 * ⚠️ 它唯一的作用是**决定先读哪一个桌面会话文件**：
 * 国内构建写 `code-auth-session.cn.v1`，国际构建写不带标记的
 * `code-auth-session.v1`。`bffPublicBaseUrl` 才是凭据真正的归属判据，
 * 文件顺序只决定「先试哪个账号」。
 */
export type AgnescodeDomain = 'cn' | 'intl'

/** 产品配置（纯数据，无副作用）。 */
export interface AgnescodeProduct {
  readonly id: AgnescodeProviderId
  readonly domain: AgnescodeDomain
  readonly displayName: string
  /**
   * 单凭据回退 ref（池里没有该站账号时用，与其余 provider 同约定）。
   *
   * ⚠️ 两站必须**不同名**：账号池重建索引时靠 ref 前缀反推 provider，
   * 同名会让国际站账号被认成国内站（静默）。
   */
  readonly defaultCredentialRef: string
  /**
   * 手工录入时的兜底 BFF base（**已含** `/v1`）。
   *
   * ⚠️ 正常路径**不用它**：`bffPublicBaseUrl` 才是权威。它存在的唯一理由是
   * 手工粘贴 token 的表单没有 base 字段，而「没有 base 就无法发请求」不该
   * 让整条渠道不可用。
   */
  readonly fallbackBffBase: string
  /** BFF 单次请求的超时（毫秒）。三个端点共用一个值（同一个 BFF 进程）。 */
  readonly fetchTimeoutMs: number
}

/** AgnesCode 国内站。 */
export const AGNESCODE: AgnescodeProduct = {
  id: 'agnescode',
  domain: 'cn',
  displayName: 'AgnesCode',
  defaultCredentialRef: 'AGNESCODE_ACCESS_TOKEN',
  fallbackBffBase: 'https://api-agnes-code.agnes-ai.cn/v1',
  fetchTimeoutMs: 30_000,
}

/** AgnesCode 国际版。 */
export const AGNESCODE_INTL: AgnescodeProduct = {
  id: 'agnescodeintl',
  domain: 'intl',
  displayName: 'AgnesCode (国际版)',
  defaultCredentialRef: 'AGNESCODEINTL_ACCESS_TOKEN',
  fallbackBffBase: 'https://api-agnes-code.agnes-ai.com/v1',
  fetchTimeoutMs: 30_000,
}

/** 两站的产品常量（唯一真相源）。 */
export const AGNESCODE_PRODUCTS: readonly AgnescodeProduct[] = Object.freeze([AGNESCODE, AGNESCODE_INTL])

/** 目录/兜底表共用的条目形状。 */
export interface AgnescodeModelEntry {
  readonly id: string
  readonly name: string
  /** 输入上下文窗口（上游 `max_input_tokens`）。 */
  readonly contextWindow?: number
  /**
   * 单次输出上限（上游 `max_output_tokens`）。
   *
   * ⚠️ 必须进 `CatalogEntry.maxTokens`：不声明它，宿主不下发 `maxTokens`，
   * 出站只能回落 4096 ⇒ 长回答被静默截断（baizhi 那条 P0 的同型形态）。
   */
  readonly maxTokens?: number
  /**
   * 上游的**计费倍率**（`points_cost_multiplier`）。
   *
   * ⚠️ `0` 是真实价格（「免费」），不是缺值；缺字段才表示「上游没报价」。
   * 实测（2026-11-19 真机）：`0` / `0.3` / `1` / `1.5` / `2.2` / `6` / `7.5` / `25`。
   */
  readonly multiplier?: number
  /**
   * 上游的订阅门控（`allowed_subscription`）。
   *
   * 空数组 = 不需要订阅；非空 = 该模型要这些档位之一（免费账号请求会
   * 403 `subscription_required`，实测 2026-11-19）。**只用于展示**，
   * 不得据此从目录里摘掉模型（参考实现同口径：门控是账号状态，不是模型事实）。
   */
  readonly subscriptions?: readonly string[]
  /** 能否收图。上游目录只声明 `model_type: "text"`，观测到之前一律 `false`。 */
  readonly vision: boolean
}

/**
 * 目录里显示的名字：倍率挂在名字后面（` · x6.00`），缺字段则原样。
 *
 * ⚠️ 为什么倍率必须进 `name`（2026-11-19 真机取证 + 参考实现同款）：本仓的模型
 * 选择器**没有**展示价格的通道（宿主 `LlmModelInfo` 只有 `description` / `badge`），
 * 而 `points_cost_multiplier` 是**计费事实**：`kimi-k3` 是 6×、`gpt-6-astra` 是 25×，
 * 不标出来用户会在「看起来一样」的两行里选中贵 25 倍的那个。参考实现用的正是
 * ` · x{n.toFixed(2)}` 这个写法（与 SenseNova / WorkBuddy 选择器一致）。
 * ⚠️ `0` 要显示成 `x0.00`（它是「免费」这条真实报价），不能当缺值吞掉。
 */
export function agnescodeDisplayName(entry: Pick<AgnescodeModelEntry, 'name' | 'multiplier'>): string {
  const multiplier = entry.multiplier
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) return entry.name
  return `${entry.name} · x${multiplier.toFixed(2)}`
}

/** 订阅门控的说明文字（不需要订阅时 `undefined`）。 */
export function agnescodeSubscriptionNote(
  entry: Pick<AgnescodeModelEntry, 'subscriptions'>,
): string | undefined {
  const tiers = entry.subscriptions
  if (tiers === undefined || tiers.length === 0) return undefined
  return `需要 ${tiers.join(' / ')} 订阅；免费档请求会被上游 403（subscription_required）`
}

/** 「免费模型」判据：倍率为 **0**（这正是上游报价的含义，不是缺值）。 */
export function agnescodeIsFree(entry: Pick<AgnescodeModelEntry, 'multiplier'>): boolean | undefined {
  return entry.multiplier === 0 ? true : undefined
}

/**
 * 兜底目录（**刻意留空**）。
 *
 * ⚠️⚠️ 本仓红线：静态兜底表必然腐坏（Qoder 那次把「0.1×」写死在表里，
 * 上游早改成免费，插件还按老价展示）。更关键的是本 provider 的目录行为
 * **只有远端一个来源**：`{apiRoot}/v2/models` 是账号级下发（不同订阅档
 * 看到不同条目），任何一行写死在这里都可能与用户账号的真实目录冲突。
 *
 * 留空的代价是**可控的**：没有可用账号时注册表侧的目录门控本来就隐藏
 * 整家 provider（`providerCatalogVisible()` + `DSH_HIDE_MODELS_WITHOUT_ACCOUNT`
 * 默认开启，见 `account-pool.ts`），所以「空目录」只会出现在「不该显示」的时刻，
 * 不会出现「登录了却选不到模型」。
 *
 * 若将来要补表，**必须**先有真机取证（`test/live-agnescode.mjs` 同款探针），
 * 不接受按印象编 id / 窗口 / 上限。
 */
export const AGNESCODE_FALLBACK_MODELS: readonly AgnescodeModelEntry[] = Object.freeze([])

/**
 * 取该站的兜底目录。
 *
 * 目前两站同表（理由见 {@link AGNESCODE_FALLBACK_MODELS}），保留函数形态是
 * 为了让「国际版有一天取证到自己的表」时只改本函数，不改所有调用点。
 */
export function agnescodeFallbackModels(_product: AgnescodeProduct): readonly AgnescodeModelEntry[] {
  return AGNESCODE_FALLBACK_MODELS
}
