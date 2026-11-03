/**
 * 百智云（BaiZhiCloud）产品配置与内置兜底模型表。
 *
 * **纯数据 + 纯常量，无副作用**：不读环境变量、不发网络请求、不写日志。
 * 单测可以直接 import 而不需要搭 cordis 运行时。
 *
 * 只记录**实测过**的事实：
 * - Anthropic 兼容端点 `https://ai-models.app.baizhi.cloud/api/anthropic/v1/messages`，
 *   头 `x-api-key` + `anthropic-version: 2023-06-01`，返回标准 Anthropic SSE；
 * - 凭据是**长期静态 Key**（无 refresh 端点、无 expires_at），与 MonkeyCode
 *   平台完全独立（独立账号、独立凭据、按量计费）；主站控制台另有积分体系，
 *   每日临时积分需过 Cap 验证码领取（见 `src/baizhi-credits.ts`）；
 * - 账号级上下文硬上限 1,048,576 tokens（400 原文
 *   `This model's maximum context length is 1048576 tokens`）；
 * - `max_tokens=100000` 实测可成功；
 * - 思考 `{type:'enabled', budget_tokens}` 生效、`{type:'disabled'}` 生效；
 *   顶层 `effort` 参数**无实际作用**（low/xhigh 各 2 次思考长度无差异）
 *   ⇒ 本产品**不暴露** effort 档位；
 * - 支持图片输入（Anthropic `image` 块 + `source.base64`，实测 1x1 PNG 能描述）。
 *
 * @module src/baizhi-product.ts
 */

/** 百智云产品配置。字段与 `src/monkeycode-product.ts` 的同名配置保持一致形状。 */
export interface BaizhiProduct {
  /** provider id：本仓要求**纯小写字母**（同时是 cordis 服务名 `${id}Auth` 与 LLM 路由名）。 */
  readonly id: 'baizhi'
  /** 界面上显示的名字。 */
  readonly displayName: string
  /** Anthropic 兼容 base URL（含 `/api/anthropic`，**不带**尾斜杠）。 */
  readonly baseUrl: string
  /** Messages 端点相对路径。 */
  readonly messagesPath: string
  /** 模型目录端点相对路径。 */
  readonly modelsPath: string
  /** Anthropic 协议版本头。 */
  readonly anthropicVersion: string
  /** 拉远端模型目录的超时（毫秒）。 */
  readonly catalogTimeoutMs: number
  /** 默认凭据 ref 名（Jet Hub 里没有账号时读这个）。 */
  readonly defaultCredentialRef: string
  /**
   * **控制台**站点根（不是模型网关）。
   *
   * ⚠️ 积分/用量/用户资料在 `baizhi.cloud` 主站；但**推理 Key 不在那里**
   * （见 {@link consoleBaseUrl}）。两处都只认网页登录态 cookie，`x-api-key` 打过去 401。
   */
  readonly platformBaseUrl: string
  /** 积分余额（实测 `{available,temporary,permanent,frozen}_credit_cents`，单位=1/100 积分）。 */
  readonly walletBalancePath: string
  /** 用量明细（`?period=week|month|year`，`month` 实测返回逐日 `items`）。 */
  readonly walletUsagePath: string
  /** 控制台用户资料（GET `data.id` 是数字 user_id）。 */
  readonly profilePath: string
  /**
   * 每日临时积分领取（**写操作**）。
   *
   * 实测 `POST` body `{captcha_token}` → `{claimed, amount_credit_cents, expires_at}`；
   * `claimed: false` 表示**今天已经领过**（不是失败）。
   */
  readonly dailyTemporaryCreditPath: string
  /** Cap 验证题下发（实测 201）。 */
  readonly captchaChallengePath: string
  /** Cap 验证题兑换（body `{token, solutions}`，回 `{token, success}`）。 */
  readonly captchaRedeemPath: string
  /**
   * **推理 Key 的真正来源** —— 大模型商店（`ai-models.app.baizhi.cloud`）的
   * console 接口，不是 `baizhi.cloud` 控制台。
   *
   * ⚠️ 两者是**两套不同的密钥**，实测过（2026-11-02）：
   *   · `baizhi.cloud/api/v1/user/api-keys` → `bzy_` + 11 位（15 字符）
   *     ⇒ 打 `ai-models…/api/anthropic/v1/messages` 恒 401；
   *   · `ai-models.app.baizhi.cloud/api/console/api-keys` → `sk-` + 64 位（67 字符）
   *     ⇒ 就是 MonkeyCode 桌面端 `config.json` 里那 45 条共用的那把。
   *
   * ⚠️ 认证用的是 **`baizhi.cloud` 的 cookie**（登录 `baizhi.cloud` 即可），
   *   而 ai-models 自己存的那枚 `sl-session` 打这个接口反而 401 —— 别搞反。
   */
  readonly consoleBaseUrl: string
  readonly consoleApiKeysPath: string
}

/** 百智云（BaiZhiCloud）常量。 */
export const BAIZHI: BaizhiProduct = {
  id: 'baizhi',
  displayName: '百智云',
  baseUrl: 'https://ai-models.app.baizhi.cloud/api/anthropic',
  messagesPath: '/v1/messages',
  modelsPath: '/v1/models',
  anthropicVersion: '2023-06-01',
  catalogTimeoutMs: 10_000,
  defaultCredentialRef: 'BAIZHI_ACCESS_TOKEN',
  platformBaseUrl: 'https://baizhi.cloud',
  walletBalancePath: '/api/v1/user/wallet/balance',
  walletUsagePath: '/api/v1/user/wallet/app-credit-usage',
  profilePath: '/api/v1/user/profile',
  dailyTemporaryCreditPath: '/api/v1/user/wallet/daily-temporary-credit',
  captchaChallengePath: '/api/v1/public/captcha/challenge',
  captchaRedeemPath: '/api/v1/public/captcha/redeem',
  consoleBaseUrl: 'https://ai-models.app.baizhi.cloud',
  consoleApiKeysPath: '/api/console/api-keys',
}

/**
 * 账号级上下文硬上限。
 *
 * 这是**服务级**硬上限（实测 400 原文 `This model's maximum context length is 1048576 tokens`），
 * 不是逐模型窗口；单条模型没实测过窗口时不要拿它冒充 per-model 窗口。
 */
export const BAIZHI_MAX_CONTEXT = 1_048_576

/** 单次输出上限（`max_tokens=100000` 实测可成功）。 */
export const BAIZHI_MAX_OUTPUT_TOKENS = 100_000

/** 兜底/能力表中的一条模型。形状对齐 `model-catalog.ts` 的 `CatalogEntry` 子集。 */
export interface BaizhiModelEntry {
  readonly id: string
  readonly name: string
  /** 省略 = **不知道**（不要编）。只有实测过窗口的模型才写。 */
  readonly contextWindow?: number
  /** 省略 = **未知**（不等于「明确不支持」）。只对明确知道的写 true。 */
  readonly supportsImage?: boolean
}

/** 模型的已知能力；未列出的字段一律表示「不知道」。 */
export interface BaizhiCapability {
  readonly contextWindow?: number
  readonly supportsImage?: boolean
}

/**
 * 已知模型能力表（**只写实测/明确知道的部分**）。
 *
 * 来源：`GET /api/anthropic/v1/models` 实测快照（45 个 id）中的这些 id。
 * 窗口只在**有实测证据**的 4 条 deepseek 上声明（值 `BAIZHI_MAX_CONTEXT`
 * = 1,048,576，与 `src/monkeycode-product.ts` 的 `MONKEYCODE_MAX_CONTEXT`
 * 同源同值 —— 都是「上游服务端 400 原文 `maximum context length is 1048576
 * tokens`」这条实测事实）；其余模型没有逐模型窗口证据 ⇒ 省略。
 *
 * ⚠️ 2026-11-02 审查修正：本注释原写「只在 `MONKEYCODE_BAIZHI_MODELS` 已声明过的
 *    那 4 条上重复声明」，而那个常量在拆站（白泽独立成 `baizhi` provider）时就
 *    删掉了 —— 照着找会扑空。
 *
 * `supportsImage` 同样保守：只有明确知道能看图的才写 true，
 * 其余省略 —— 适配器对「省略」的模型收到图片时会抛 `UNSUPPORTED_CONTENT`，
 * 不会静默丢图。
 */
const BAIZHI_KNOWN_CAPABILITIES: readonly (BaizhiCapability & { readonly id: string })[] = [
  // deepseek 系列（4 条，窗口与 monkeycode-product.ts 保持一致）
  { id: 'deepseek-v4-pro', contextWindow: BAIZHI_MAX_CONTEXT },
  { id: 'deepseek-v4-flash', contextWindow: BAIZHI_MAX_CONTEXT },
  { id: 'deepseek-v4-flash-vision-exp', contextWindow: BAIZHI_MAX_CONTEXT, supportsImage: true },
  { id: 'deepseek-flash', contextWindow: BAIZHI_MAX_CONTEXT },
  // 其余已知 id：窗口未知、是否支持图片未逐一实测 ⇒ 只列 id
  { id: 'minimax-m2.7', supportsImage: true },
  { id: 'minimax-m2.5' },
  { id: 'glm-5.1', supportsImage: true },
  { id: 'glm-5' },
  { id: 'glm-4.7' },
  { id: 'kimi-k2.6', supportsImage: true },
  { id: 'kimi-k2.5' },
  { id: 'qwen3.6-plus' },
  { id: 'qwen3.5-plus', supportsImage: true },
  { id: 'qwen3.5-flash' },
  { id: 'qwen-flash' },
]

/**
 * 内置兜底模型表（远端目录拉不到时用）。
 *
 * `name` 一律用 id：远端 `display_name` 拿不到时**不编**展示名，
 * 与 `parseBaizhiModelList` 的降级规则保持一致。
 */
export const BAIZHI_FALLBACK_MODELS: readonly BaizhiModelEntry[] = BAIZHI_KNOWN_CAPABILITIES.map(
  (capability) => ({
    id: capability.id,
    name: capability.id,
    ...capability.contextWindow === undefined ? {} : { contextWindow: capability.contextWindow },
    ...capability.supportsImage === undefined ? {} : { supportsImage: capability.supportsImage },
  }),
)

/** 查某个模型 id 的已知能力；未知 id 返回 `undefined`（**不要**返回空对象假装知道）。 */
export function baizhiCapabilityOf(modelId: string): BaizhiCapability | undefined {
  const id = modelId.trim()
  if (id.length === 0) return undefined
  const found = BAIZHI_KNOWN_CAPABILITIES.find((capability) => capability.id === id)
  if (found === undefined) return undefined
  // 剥掉内部的 `id`：`BaizhiCapability` 只描述**能力**，身份由调用方手里的 id 表达。
  // 不剥的话返回的其实是「能力和 id 混在一起」的条目，调用方做深比较/序列化时会多出字段。
  return {
    ...found.contextWindow === undefined ? {} : { contextWindow: found.contextWindow },
    ...found.supportsImage === undefined ? {} : { supportsImage: found.supportsImage },
  }
}

/** 是否在已知清单里。 */
export function isKnownBaizhiModel(modelId: string): boolean {
  return baizhiCapabilityOf(modelId) !== undefined
}

/** 在兜底表里查模型条目。 */
export function findBaizhiFallback(modelId: string): BaizhiModelEntry | undefined {
  const id = modelId.trim()
  if (id.length === 0) return undefined
  return BAIZHI_FALLBACK_MODELS.find((model) => model.id === id)
}

/**
 * 兜底表快照。
 *
 * 返回新数组而不是内部常量，避免调用方 `sort`/`push` 污染全局状态
 * （表格是模块级常量，被意外改写会影响所有测试）。
 */
export function baizhiFallbackModels(): readonly BaizhiModelEntry[] {
  return BAIZHI_FALLBACK_MODELS.map((model) => ({ ...model }))
}
