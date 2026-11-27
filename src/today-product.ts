/**
 * Today（国内版 `todayai.cn` + 国际版 `today.ai`）站点常量与模型元数据。
 *
 * ## 为什么是两个独立的 provider id
 *
 * - 国内版（`today`，`todayai.cn`）与国际版（`todayintl`，`today.ai`）账号体系、
 *   Cookie 与模型套餐配额相互独立、互不通用；
 * - 模型目录在宿主按 provider id 各自缓存一份，合并成单 id 会导致两站账号目录串台；
 * - `provider-registry.ts` 要求 id 必须为纯小写字母（`^[a-z]+$`），故国际版命名为
 *   `todayintl`（与 `minimaxintl` / `autoclawintl` / `agnescodeintl` 同约定）。
 *
 * @module src/today-product.ts
 */

/** Today 站点 provider id。 */
export type TodayProviderId = 'today' | 'todayintl'

/** Today 上游区域。 */
export type TodayRealm = 'cn' | 'global'

/** Today 站点产品配置（纯数据）。 */
export interface TodayProduct {
  readonly id: TodayProviderId
  readonly realm: TodayRealm
  readonly displayName: string
  readonly appBase: string
  readonly apiBase: string
  readonly authBase: string
  /**
   * 凭据引用默认前缀/名称。
   * ⚠️ 两站必须不同名且与 `jet-hub-store.ts` 的 `REF_PREFIX_TO_PROVIDER` 对应。
   */
  readonly defaultCredentialRef: string
  readonly refPrefix: string
  /** 是否支持邮箱 OTP 验证码登录（国内版 todayai.cn 上游已停用）。 */
  readonly supportsEmailOtp: boolean
  /** 轮询等待回复的总超时（毫秒）。 */
  readonly fetchTimeoutMs: number
  /** 初始轮询间隔（毫秒）。 */
  readonly initialPollIntervalMs: number
  /** 轮询间隔上限（毫秒）。 */
  readonly maxPollIntervalMs: number
}

/** Today 国内版（`todayai.cn`）。 */
export const TODAY: TodayProduct = {
  id: 'today',
  realm: 'cn',
  displayName: 'Today (国内版)',
  appBase: 'https://todayai.cn',
  apiBase: 'https://api.todayai.cn',
  authBase: 'https://auth.todayai.cn',
  defaultCredentialRef: 'TODAY_SESSION',
  refPrefix: 'TODAY',
  supportsEmailOtp: false,
  fetchTimeoutMs: 240_000,
  initialPollIntervalMs: 200,
  maxPollIntervalMs: 1_000,
}

/** Today 国际版（`today.ai`）。 */
export const TODAY_INTL: TodayProduct = {
  id: 'todayintl',
  realm: 'global',
  displayName: 'Today (国际版)',
  appBase: 'https://today.ai',
  apiBase: 'https://api.today.ai',
  authBase: 'https://auth.today.ai',
  defaultCredentialRef: 'TODAYINTL_SESSION',
  refPrefix: 'TODAYINTL',
  supportsEmailOtp: true,
  fetchTimeoutMs: 240_000,
  initialPollIntervalMs: 200,
  maxPollIntervalMs: 1_000,
}

/** 两站产品常量（唯一真相源）。 */
export const TODAY_PRODUCTS: readonly TodayProduct[] = Object.freeze([TODAY, TODAY_INTL])

/** 上游模型条目。 */
export interface TodayModelEntry {
  readonly optionId: string
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  readonly maxTokens?: number
}

/**
 * 已知模型兜底表。
 *
 * 上游真实可用清单由 `GET /v1/pricing/status` 的 `modelOptions.options[]` 实时下发
 * （随账号套餐变化）。这里仅作无缓存/探测失败时的保守兜底与显示名参考；
 * 未知模型 id 仍可按 `model.<id>` 约定透传给上游判定。
 */
export const TODAY_KNOWN_MODELS: readonly TodayModelEntry[] = Object.freeze([
  {
    optionId: 'model.deepseek-v4.1-flash',
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 131_072,
    maxTokens: 8_192,
  },
  {
    optionId: 'model.glm-5.3',
    id: 'glm-5.3',
    name: 'GLM 5.3',
    contextWindow: 131_072,
    maxTokens: 8_192,
  },
  {
    optionId: 'model.minimax-m31-flash',
    id: 'minimax-m31-flash',
    name: 'MiniMax M3.1 Flash',
    contextWindow: 131_072,
    maxTokens: 8_192,
  },
])

/** 按 id 或 optionId 解析模型，未收录时按 `model.<bare>` 动态构造。 */
export function resolveTodayModelEntry(modelId: string): TodayModelEntry | undefined {
  const needle = modelId.trim().toLowerCase()
  if (needle.length === 0) return undefined
  for (const m of TODAY_KNOWN_MODELS) {
    if (needle === m.id || needle === m.optionId || needle === `model.${m.id}`) {
      return m
    }
  }
  const bare = needle.startsWith('model.') ? needle.slice('model.'.length) : needle
  if (bare.length === 0) return undefined
  return {
    optionId: `model.${bare}`,
    id: bare,
    name: bare,
  }
}

/** 按 provider id 取对应的 TodayProduct。 */
export function todayProductOf(provider: string): TodayProduct {
  return provider === TODAY_INTL.id ? TODAY_INTL : TODAY
}
