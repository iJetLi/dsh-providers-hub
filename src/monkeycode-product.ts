/**
 * MonkeyCode 产品配置（国内站 `monkeycode-ai.com` 与国际站 `monkeycode-ai.net`）。
 *
 * ## 为什么只有一个推理通道
 *
 * 2026-11-02 的实测把三套服务彻底分开了（用户当场指出「既然是独立的你为什么
 * 只做一个供应商账号」，这场改造就是答复）：
 *
 * | 服务 | 平台 | 模型网关 | 凭据 | 计费 |
 * |---|---|---|---|---|
 * | 国内 MonkeyCode | `monkeycode-ai.com` | `proxy.monkeycode-ai.com/v1` | `oma_…` + `signing_secret` | 每日额度 + 积分 |
 * | 国际 MonkeyCode | `monkeycode-ai.net` | `proxy.monkeycode-ai.net/v1` | 同构（独立账号池） | 同构 |
 * | 百智云 | `baizhi.cloud` | `ai-models.app.baizhi.cloud` | `sk-…` | 按量计费 |
 *
 * 三者**账号不互通**（实测：百智云 cookie 打 `monkeycode-ai.com` 是 401；
 * 国内 cookie 不认国际站；网关只认 `x-api-key` 不认 cookie）。所以本模块
 * 只描述 **MonkeyCode 系**（国内 + 国际），百智云是独立 provider（`baizhi-*.ts`）。
 *
 * ## ⚠️ 网关没有模型列表接口（实测 `GET /v1/models` 返回 405）
 *
 * 两个站都是 405（行为完全一致，这也是「同一个程序的两套部署」的证据）。
 * 所以目录**只有**内置常量 {@link MONKEYCODE_GATEWAY_MODELS}，没有远端来源。
 *
 * 这份清单是从平台侧 `GET /api/v1/users/models`（cookie 认证，非推理端点）
 * 抓下来的快照，**不是**猜的 —— 但它是快照，上游加模型后这里不会自动更新。
 * 命名规律（见 SPEC §3）：
 * - 带 `monkeycode-basic/` `monkeycode-pro/` `monkeycode-ultra/` 前缀 ⇒ 走**每日额度**，
 *   前缀即订阅档位；basic 账号请求 pro/ultra 前缀 ⇒ 403；
 * - 不带前缀（`deepseek-flash`、`glm-5`…）⇒ **直接扣积分**。
 *
 * ## ⚠️ 凭据 ref 前缀不能互相吃
 *
 * `MONKEYCODE_ACCESS_TOKEN` 与 `MONKEYCODEINTL_ACCESS_TOKEN` 是**超串关系**
 * （后者以前者开头）。`src/jet-hub-store.ts` 的 `ACCOUNT_REF_RE` 按**长度降序**
 * 匹配，故两者能各自归位；但新增站点时仍必须给不同的 `defaultCredentialRef`，
 * 否则账号在 `state.json` 缺失时会认错 provider（静默）。
 *
 * @module src/monkeycode-product.ts
 */

/**
 * MonkeyCode 系的站点 id。
 *
 * ⚠️ 这两个字面量同时是 cordis 服务名（`${id}Auth`）、LLM 路由名与
 * `provider-registry.ts` 的 `ProviderDescriptor.id`。`provider-registry` 要求
 * **纯小写字母**，故「国际版」只能是 `monkeycodeintl`，不能带连字符/下划线。
 */
export type MonkeycodeProviderId = 'monkeycode' | 'monkeycodeintl'

/** 产品配置（纯数据，无副作用）。 */
export interface MonkeycodeProduct {
  /** provider id。⚠️ `provider-registry.ts` 要求**纯小写字母**。 */
  readonly id: MonkeycodeProviderId
  readonly displayName: string
  /** OhMyAgent 网关 base（**已含** `/v1`）。 */
  readonly gatewayBaseUrl: string
  /** 网关推理路径（相对 {@link gatewayBaseUrl}，即 `/messages`）。 */
  readonly gatewayMessagesPath: string
  /**
   * 平台站 base —— 额度 / 积分 / 订阅 / 签到都在这边。
   *
   * ⚠️ 这一组接口**不接受 API Key**（实测 401），必须用浏览器 cookie。
   * 故它们与推理通道**完全解耦**：没有 cookie 时推理照常，只是查不到额度、
   * 签不了到 —— 必须优雅降级，不能让整个账号不可用。
   */
  readonly platformBaseUrl: string
  readonly walletPath: string
  readonly subscriptionPath: string
  /**
   * 平台用户资料（`GET /api/v1/users/status`）→ `data.user.{id,nickname}`。
   *
   * ⚠️ 这是**稳定账号身份**的唯一来源：兑换 Key 的响应里的 `id` 是「每签发
   * 一把 Key 就变」的记录 id，拿它判重会导致「同账号每登一次多一张卡」。
   */
  readonly profilePath: string
  readonly checkinPath: string
  readonly transactionPath: string
  readonly captchaChallengePath: string
  readonly captchaRedeemPath: string
  /**
   * 用**网页登录态**换一对网关凭据（`oma_…` + `signing_secret`）的写接口。
   *
   * ⚠️ 只认 Cookie、只接受 POST、body 传 `{}`；GET 同路径是 404。
   * 这是浏览器登录的**最后一跳** —— 拿到 cookie 之后靠它把凭据补齐，
   * 用户不必自己去抄 API Key 与签名密钥。
   */
  readonly apiKeysPath: string
  /**
   * Anthropic 协议版本头。网关透传 Anthropic 协议，实测接受 `2023-06-01`。
   */
  readonly anthropicVersion: string
  /**
   * 默认（单凭据）ref 名称。
   *
   * ⚠️ 必须与 `provider-registry.ts` / `jet-hub-store.ts` 的前缀表**一致**：
   * `credentialRef()` 只认 `/^[A-Za-z_][A-Za-z0-9_]*$/`，且解析要能按
   * `MONKEYCODE` / `MONKEYCODEINTL` 前缀反查回 provider id。
   */
  readonly defaultCredentialRef: string
  /** 平台请求的超时（毫秒）。 */
  readonly catalogTimeoutMs: number
}

/** MonkeyCode 国内站的产品常量。 */
export const MONKEYCODE: MonkeycodeProduct = {
  id: 'monkeycode',
  displayName: 'MonkeyCode',
  gatewayBaseUrl: 'https://proxy.monkeycode-ai.com/v1',
  gatewayMessagesPath: '/messages',
  platformBaseUrl: 'https://monkeycode-ai.com',
  walletPath: '/api/v1/users/wallet',
  subscriptionPath: '/api/v1/users/subscription',
  profilePath: '/api/v1/users/status',
  checkinPath: '/api/v1/users/wallet/checkin',
  transactionPath: '/api/v1/users/wallet/transaction',
  captchaChallengePath: '/api/v1/public/captcha/challenge',
  captchaRedeemPath: '/api/v1/public/captcha/redeem',
  apiKeysPath: '/api/v1/users/ohmyagent/api-keys',
  anthropicVersion: '2023-06-01',
  defaultCredentialRef: 'MONKEYCODE_ACCESS_TOKEN',
  catalogTimeoutMs: 10_000,
}

/**
 * MonkeyCode 国际站的产品常量。
 *
 * ⚠️ **契约同构但未真机验证**：`proxy.monkeycode-ai.net/v1/models` 实测同样
 * 返回 405（与国内站逐字节一致的行为），`/api/v1/users/models` 同样要求登录，
 * 说明是「同一个程序的两套部署」。但国际站的 `apiKeysPath` 与凭据格式
 * **没有用真实账号跑通过**（本机只有国内账号）—— 若将来 404/字段不同，
 * 改这一个常量即可，不要动 `monkeycode.ts` 的逻辑。
 */
export const MONKEYCODE_INTL: MonkeycodeProduct = {
  id: 'monkeycodeintl',
  displayName: 'MonkeyCode 国际版',
  gatewayBaseUrl: 'https://proxy.monkeycode-ai.net/v1',
  gatewayMessagesPath: '/messages',
  platformBaseUrl: 'https://monkeycode-ai.net',
  walletPath: '/api/v1/users/wallet',
  subscriptionPath: '/api/v1/users/subscription',
  profilePath: '/api/v1/users/status',
  checkinPath: '/api/v1/users/wallet/checkin',
  transactionPath: '/api/v1/users/wallet/transaction',
  captchaChallengePath: '/api/v1/public/captcha/challenge',
  captchaRedeemPath: '/api/v1/public/captcha/redeem',
  apiKeysPath: '/api/v1/users/ohmyagent/api-keys',
  anthropicVersion: '2023-06-01',
  defaultCredentialRef: 'MONKEYCODEINTL_ACCESS_TOKEN',
  catalogTimeoutMs: 10_000,
}

/** 全部站点（注册表按此列表展开）。 */
export const MONKEYCODE_PRODUCTS: readonly MonkeycodeProduct[] = [MONKEYCODE, MONKEYCODE_INTL]

/**
 * **deepseek 系**的账号级上下文硬上限（tokens）。
 *
 * 证据：SPEC 实测，服务端 400 原文
 * `This model's maximum context length is 1048576 tokens. However, you requested
 *  3186133 tokens …`；450 万字符 → `input_tokens 604,931` 成功。
 *
 * ⚠️⚠️ **这个数字只对 deepseek 成立，不能当成「整个网关所有模型的窗口」**
 * （2026-11-02 复审发现）：
 * 1. 网关目录里还有 `glm-5` 等别家模型，它们的窗口**各不相同**、彼此无关 ——
 *    照抄 deepseek 的数字就是**谎报**，而本文件的既定原则是「未知就省略，
 *    省略比谎报更安全」（见 {@link MonkeycodeModelEntry.contextWindow}）。
 * 2. 这个值不是只用于显示：适配器经 `createModelCatalog` 透传给宿主，
 *    **DSH 压缩模块（`dsh-compaction-basic`）拿它算压缩阈值** ⇒ 声明越大压缩接得越晚。
 *    给 glm-5 标 1,048,576 会让它在 90 万 token 才压缩 —— 那时单次请求的
 *    计费 token 已经高到不可接受（本产品按 `input + cache_read + 10×output`
 *    折算，见 SPEC §5）。
 * 3. 桌面端自己只敢播报 200,000（`config.json` 的 `context_window`）——即同一个
 *    上游，产品侧口径比硬上限小 5 倍。本插件在**有实测证据**的 deepseek 上
 *    播报硬上限（用户能真正用满），在**没有证据**的模型上不播报。
 */
export const MONKEYCODE_MAX_CONTEXT = 1_048_576

/** 目录条目（内部中间结构，与 `model-catalog.ts` 的 `CatalogEntry` 同形但更窄）。 */
export interface MonkeycodeModelEntry {
  readonly id: string
  readonly name: string
  /** 上下文窗口；省略 = **不声明**（不编造假窗口）。 */
  readonly contextWindow?: number
  /**
   * 是否支持图片输入。
   *
   * ⚠️ 只有**明确知道**支持时才写 `true`；未知就省略 ⇒ 适配器对图片抛
   * `UNSUPPORTED_CONTENT`（接入指南：省略比谎报 `['text']` 更安全，
   * 但必须显式抛错，不能静默丢图）。
   */
  readonly supportsImage?: boolean
}

/**
 * 网关的内置目录 —— 也是**唯一**的目录来源。
 *
 * ⚠️ **没有远端来源**（`GET /v1/models` 返回 405），这份表就是全量事实。
 * 来源：平台侧 `GET /api/v1/users/models` 的快照。上游加模型后需手工同步。
 *
 * ⚠️ 上下文窗口的声明策略：**有实测证据的 deepseek 系**统一声明
 * `MONKEYCODE_MAX_CONTEXT`（服务端 400 原文作证）；`glm-5` 等**未实测**的模型
 * 一律省略 —— 本文件的既定原则是「未知就省略，省略比谎报更安全」。
 *
 * 省略的代价要认下来：DSH 的上下文占用条只在声明了 `contextWindow` 时渲染，
 * 所以 `glm-5` 那几条没有占用条（2026-11-02 审查 A🟡-9 提出的「整条消失」）。
 * 反过来给没证据的模型标 1M，会让溢出压缩推迟到根本到不了的 token 数，
 * 而压缩阈值正是由这个字段算的 —— 谎报的代价比少一条进度条大得多。
 */
export const MONKEYCODE_GATEWAY_MODELS: readonly MonkeycodeModelEntry[] = [
  { id: 'monkeycode-basic/deepseek-flash', name: 'DeepSeek Flash（basic 额度）', contextWindow: MONKEYCODE_MAX_CONTEXT },
  { id: 'monkeycode-basic/deepseek-v4-flash', name: 'DeepSeek V4 Flash（basic 额度）', contextWindow: MONKEYCODE_MAX_CONTEXT },
  { id: 'monkeycode-pro/deepseek-flash', name: 'DeepSeek Flash（pro 额度）', contextWindow: MONKEYCODE_MAX_CONTEXT },
  { id: 'monkeycode-pro/deepseek-v4-pro', name: 'DeepSeek V4 Pro（pro 额度）', contextWindow: MONKEYCODE_MAX_CONTEXT },
  { id: 'monkeycode-ultra/deepseek-v4-pro', name: 'DeepSeek V4 Pro（ultra 额度）', contextWindow: MONKEYCODE_MAX_CONTEXT },
  // 不带前缀的 = 直接扣积分（不走每日额度），与订阅档位无关。
  { id: 'deepseek-flash', name: 'DeepSeek Flash（按积分计费）', contextWindow: MONKEYCODE_MAX_CONTEXT },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash（按积分计费）', contextWindow: MONKEYCODE_MAX_CONTEXT },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro（按积分计费）', contextWindow: MONKEYCODE_MAX_CONTEXT },
  // ⚠️ `glm-5` **刻意不声明** `contextWindow`：它不是 deepseek，窗口与
  //    {@link MONKEYCODE_MAX_CONTEXT} 毫无关系，照抄就是谎报（且会把 DSH 的
  //    溢出压缩推迟到不可能达到的 token 数）。未知就省略。
  { id: 'glm-5', name: 'GLM-5（按积分计费）' },
]

/** 兜底目录（供适配器的 `loadCatalog` / `syncCatalog` 用）。 */
export function monkeycodeFallbackModels(): readonly MonkeycodeModelEntry[] {
  return MONKEYCODE_GATEWAY_MODELS
}

/**
 * 每日额度的档位 → token 上限。
 *
 * ⚠️ 单位是**计费 token**（`(input + cache_read + 10 × output) × 1.5`），
 * 不是原始 token —— 拿它跟 `usage.input_tokens + usage.output_tokens` 比会
 * 得出完全错误的「还剩多少」（差 1.5~15 倍）。这是 SPEC §3 的实测口径。
 */
export const MONKEYCODE_PLAN_DAILY_LIMIT: Readonly<Record<string, number>> = {
  basic: 10_000_000,
  pro: 100_000_000,
  ultra: 300_000_000,
}
