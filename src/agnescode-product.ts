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
  /** 能否收图。上游目录只声明 `model_type: "text"`，观测到之前一律 `false`。 */
  readonly vision: boolean
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
