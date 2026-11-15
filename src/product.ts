/**
 * CodeBuddy 系产品配置。
 *
 * 这些产品同源：共用同一 CLI 内核、同一认证协议（cli-external-link）与同一套
 * ProductProvider 机制，差异全部收敛到这里，使多个 provider 共用一套实现。
 *
 * 实测依据（2026-09-14，逆向各产品 cli/product.json + 真实请求）：
 *
 * | 产品              | endpoint                    | platform       | genieVersion |
 * |-------------------|-----------------------------|----------------|--------------|
 * | CodeBuddy（中国） | https://copilot.tencent.com | ide            | 4.12.2       |
 * | WorkBuddy（国际） | https://www.workbuddy.ai    | workbuddy-ai   | 5.9.4        |
 *
 * ⚠️⚠️ **`genieVersion` 是本表最关键的一列**：客户端发出去的 `X-IDE-Version` 与
 * `User-Agent` 里的版本**都取它**（反编译实证见 `CODEBUDDY.clientVersion` 的注释）。
 * 它来自客户端 `product.json` 的 `genieVersion`，**不是**同文件的 `version`
 * （后者是 VS Code 基底版本，只在 `genieVersion` 缺失时兜底）。
 * 实测值来源（2026-10-30）：
 * - CodeBuddy：`CodeBuddy CN/resources/app/product.json` → `version=1.106.1`、`genieVersion=4.12.2`
 * - WorkBuddy：`WorkBuddyAI/resources/app.asar.unpacked/cli/product.json` → `genieVersion=5.9.4`
 *
 * ⚠️ **本仓仍缺一个客户端会发的头：`X-Product-Version`**（= 客户端的
 * `productVersion`，与 `platformVersion` 是两个量）。官方拦截器会发它，我们没发。
 * 当前不发也能 200（实测），故先登记为缺口、不擅自新增未验证的信号。
 *
 * 关于「模型列表为何不能共用」：两者的**路径与响应解析完全相同**
 * （`GET /v3/config` → `data.data.models` / `data.data.agents`），
 * 差异只来自 endpoint —— 不同区域的后端返回不同的模型池
 * （中国版含 glm/hy/deepseek 系，国际版含 claude/gpt/gemini/kimi 系）。
 * 因此 endpoint 必须随产品切换，不能被当成全局常量。
 *
 * 迁移关系（重要）：
 * 本模块中与 `src/buddy.ts` / `src/buddy-auth.ts` 重名的取值，将从后者**迁移**到
 * 本模块，由本模块作为唯一真相源（single source of truth）。在后续参数化任务完成、
 * 旧常量被删除之前，本模块的这些字面量必须与 `src/buddy.ts` / `src/buddy-auth.ts`
 * 中的对应常量**保持完全一致**：任何一处取值变更都必须同步另一处，否则各产品的
 * 认证/请求行为会分叉。
 *
 * 之所以此处仍写死字面量而不 import 常量：`buddy-auth.ts` 后续任务将改为
 * `import product.ts`，若本模块反向 import `buddy-auth.ts` 会形成循环依赖；
 * 为保持一致性，这些字段全部维持字面量写法。
 */

/** 兜底模型目录中的一个条目（字段对齐远端 `/v3/config` 的 `data.models[]`）。 */
export interface BuddyFallbackModel {
  id: string
  name: string
  /** 上下文窗口（对应远端 `maxInputTokens`）。 */
  contextWindow?: number
  /**
   * 单次请求输出上限（对应远端 `maxOutputTokens`）。
   *
   * 远端可达时以远端为准；本字段只在远端不可用或未覆盖该模型时补位。
   * 取值依据见 `deepseek-v4.1-flash` 条目的注释。
   */
  maxOutputTokens?: number
  /** 是否接受图片输入（对应远端 `supportsImages`）。 */
  supportsImages?: boolean
  /** 可选思考等级（对应远端 `reasoning.supportedEfforts`）。 */
  reasoningEfforts?: readonly string[]
  /** 默认思考等级（对应远端 `reasoning.defaultEffort`）。 */
  defaultReasoningEffort?: string
}

/** 一条「模型族 → User-Agent」覆盖规则。 */
export interface BuddyUserAgentRule {
  /** 模型 id 前缀；命中即采用本规则的 ua。 */
  match: string
  /** 命中后使用的 User-Agent。 */
  ua: string
}

/**
 * 国际版（WorkBuddy AI）模型线 → UA 分档规则。
 *
 * 判据来自 IDE 客户端形态：国际版产品名是 `WorkBuddy AI`，其客户端出站 UA
 * 遵循官方三段式 `WorkBuddy/<ver> WorkBuddy AI/<ver> CLI/<ver>`。GPT / Gemini
 * 系仅在国际版池中提供，归入国际版形态；国内系模型（glm/hy/kimi/minimax）
 * 虽在国际版池中也可见，但仍沿用国内客户端形态（`WorkBuddy/<ver> WorkBuddy/...`），
 * 与 realm 无关。
 */
const WORKBUDDY_UA_INTL = 'WorkBuddy/5.9.4 WorkBuddy AI/5.9.4 CLI/5.9.4'
const WORKBUDDY_UA_CN = 'WorkBuddy/5.9.4 WorkBuddy/5.9.4 CLI/5.9.4'

/** 一个 CodeBuddy 系产品的全部差异配置。 */
export interface BuddyProduct {
  /** provider 标识：注册到 ctx.llm 的路由名，也是账号列表的 provider 字段值 */
  id: 'buddy' | 'workbuddy'
  /** auth/state 的 platform 查询参数 */
  platform: string
  /**
   * API endpoint（含协议），所有 `/v2/plugin/*`、`/v3/config` 与 chat 请求
   * 都以此为基址。**这是不同区域产品之间最关键的差异**：模型池由它决定。
   */
  endpoint: string
  /**
   * 用于 `X-Domain` 请求头的域名（通常等于 endpoint 的主机名）。
   * 注意与 `endpoint` 分开：历史实现里该头传的是不带协议的域名。
   */
  apiDomain: string
  /**
   * 成长中心领奖端点的基址（含协议，无尾斜杠），成长任务 claim 与 web 域上报
   * 以此为基址。
   *
   * 与 `endpoint` 分开的原因：API 域名与网页域名不是同一个站。buddy 中国版的
   * `endpoint` 是 `copilot.tencent.com`，而成长中心领奖与 web 域遥测在另一个站。
   *
   * 证据状态：`www.workbuddy.cn` 是实测可达的中国区成长中心站（2026-10-05，
   * 两个真实账号领奖成功）；它与登录站 `www.codebuddy.cn`（见 buddy.ts
   * WEBSITE_HOME）的关系未经核实，两者都返回 HTTP 200，故此处填实测值而非推断值。
   * 国际版未实测，暂按 `endpoint` 同域填写。
   */
  claimBase: string
  /**
   * web 域遥测上报的 Origin（含协议，无尾斜杠），资料库点击一类判据只认
   * web 域事件，桌面域不计分。
   *
   * 与 `claimBase` 分开的原因：领奖走产品 API 站，web 遥测走网页站，两者
   * 的 `Origin` / `Referer` 需要各自独立配置，不能共用一个回退值。
   *
   * 证据状态：与 `claimBase` 同为实测可达站点（2026-10-05，Library_read判据
   * 在两个真实账号上领奖成功）。
   */
  webBase: string
  /** 设置页展示名 */
  displayName: string
  /** X-Product-Code 请求头值 */
  productCode: string
  /**
   * 默认 User-Agent（无按模型分档命中时使用）。
   *
   * 腾讯后台的「使用端」列按出站 UA 归因，故该值必须**含对应产品品牌字样**
   * （`WorkBuddy/...` 或 `CodeBuddyIDE/...`），否则账单显示为 `-`。
   */
  userAgent: string
  /**
   * 按模型族覆盖 User-Agent 的规则表（先命中先返回）。
   *
   * 为什么需要按模型分档：国际版与国内版共用同一后端协议，但模型池分属不同
   * 产品线 —— 实测同一账号下，走 `gpt-*` 系与走 `glm-*` 系时官方客户端形态
   * 并不一致，后台按 UA 归因的「使用端」也随之不同。仅用一个全局 UA 无法让
   * 两类模型都归因正确。
   *
   * 匹配规则：`match` 为模型 id 前缀（大小写敏感，与模型 id 一致）；
   * 空数组或未提供时全部回退到 {@link BuddyProduct.userAgent}。
   */
  userAgentByModelFamily?: readonly BuddyUserAgentRule[]
  /**
   * 归属头名（`X-IDE-Name` / `X-IDE-Type` / `X-Product` 三头共用同一取值）。
   *
   * 注意语义：`X-Product` 是**用量归属名**，不是部署类型 —— 历史实现把它发成
   * `SaaS`（部署类型语义）导致后台归因不到产品，故此处按产品名下发。
   */
  attributionName: string
  /** `X-IDE-Version` 头取值（客户端形态版本号） */
  clientVersion: string
  /** User-Agent 第三段 `CLI/<ver>` 的版本号 */
  cliVersion: string
  /** 默认凭据 ref（无账号池时的单凭据回退） */
  defaultCredentialRef: string
  /**
   * 远端模型列表不可用时的**兜底模型目录**。
   *
   * 为什么需要它：各产品的模型池只由服务端按认证上下文下发，而插件的
   * CLI token 未必能取到完整集合（实测 WorkBuddy 国际版经 CLI token 只能
   * 拿到 13 个别名，拿不到 GPT 系列）。此表是 IDE 自身也在用的机制 ——
   * IDE 的 `product.json` 内置静态模型表，远端配置只是覆盖层。
   *
   * 取值来自 IDE 的本地缓存（`~/.workbuddy-ai/local_storage/*.info`，
   * 由 `WorkbuddyAuthProductCoordinator` 写入），即 IDE 输入框实际使用的清单。
   */
  fallbackModels?: readonly BuddyFallbackModel[]
  /**
   * 登录 URL 是否需要追加 `version` 与 `loginSessionId`。
   * CodeBuddy 不需要；WorkBuddy 需要（对齐 workbuddy-desktop 认证配置）。
   */
  appendSessionParams: boolean
  /** 追加到登录 URL 的版本号（appendSessionParams 为 true 时使用） */
  pluginVersion?: string
  /**
   * 该产品**合法的凭据 `domain` 值集合**（凭据里 `domain` 的语义是「登录站点」，
   * 即 token 的 `iss` 主机，**不是**请求端点域名）。
   *
   * ## 为什么需要它（真实缺陷，独立审计实测证伪）
   *
   * `pruneAccountsWithForeignDomain` 原先的判据是「`domain !== product.apiDomain`
   * 就删账号」。该判据**语义不成立**：
   *
   * - `domain` 记录的是**登录站**（`src/buddy-adapter.ts` 明文写着这一点），
   *   且 `X-Domain` 实际以 `this.product.apiDomain || credential.domain` 取值 ——
   *   凭据里的 `domain` 只是**兜底**，故 `domain ≠ apiDomain` **不蕴含**
   *   「凭据发不到当前端点」。本机实测 buddy 的 20 个真实账号里，`domain`
   *   合法地存在 `www.codebuddy.cn`（登录站）与 `copilot.tencent.com`（API 域）
   *   两种值，而那 12 个 `www.codebuddy.cn` 的账号**一直是正常可用的**。
   * - 该判据之所以在 buddy 上没出事，**只是因为上游恰好没对 `CODEBUDDY` 调用
   *   这个函数**（唯一调用点是 `WORKBUDDY`）。一旦推广到 buddy，会一次性删掉
   *   那 12 个账号。
   *
   * ⇒ 判据改为「domain **属于该产品的已知域集合**就保留，只有**确证属于其它
   * 产品**（即命中别的产品的集合）才删」。本字段就是这个集合。
   *
   * ⚠️ 空数组表示「没有已知域信息」⇒ 调用方应**保守保留**（无法判定不等于失配）。
   * ⚠️ 新增同源产品时必须登记它的登录站，否则跨产品导入的账号会被误判。
   */
  knownDomains?: readonly string[]
  /**
   * 单张请求图片的像素预算（issue !IKITT9）。
   *
   * 适配器据此把附件派生成**缩放后的请求版本**再内联，而不是直接发原图。
   * 背景：网关对「单次请求的图片视觉 token 总量」另有约 100,000 的限制，
   * 与模型上下文窗口（这里声明的是 1,000,000）是两回事 —— 一张 1721×997
   * 的截图就值 ≈2,781 token，攒到 36 张顶穿后整个会话每轮都失败且不可恢复。
   *
   * 取值口径与「为什么是每张固定预算而非按张数分摊」记在 `src/image-budget.ts`。
   * 未配置时适配器使用 `DEFAULT_IMAGE_PIXEL_BUDGET`（640,000 px）。
   */
  imagePixelBudget?: number
}

/**
 * CodeBuddy（腾讯 CodeBuddy，中国版），platform = ide。
 *
 * 以下字段与既有常量重复，属**待删除的重复定义**（等后续参数化任务把
 * `src/buddy.ts` / `src/buddy-auth.ts` 改为从本模块取值后即可删除）：
 * - `platform: 'ide'`          ↔ `src/buddy.ts`  `PLATFORM`
 * - `productCode: 'codebuddy'` ↔ `src/buddy.ts`  `BUDDY_PRODUCT_CODE`
 * - `userAgent: 'CodeBuddyIDE/4.12.2'` ↔ `src/buddy.ts`  `BUDDY_USER_AGENT`
 * - `defaultCredentialRef: 'BUDDY_ACCESS_TOKEN'` ↔ `src/buddy-auth.ts`  `BUDDY_CREDENTIAL_REF`
 * - `endpoint`/`apiDomain`     ↔ `src/buddy.ts`  `API_ENDPOINT` / `API_DOMAIN`
 *
 * 迁移完成前两处取值必须保持一致，改动需同步（见文件头「迁移关系」）。
 */
/**
 * CodeBuddy（中国版）的内置模型目录。
 *
 * 数据来源：`/v3/config` 的 `craft` agent 白名单，并**逐个用真实请求验证可用**
 * （`POST /v2/chat/completions`，stream 模式）。只收录实测返回可用的模型 ——
 * 远端 `data.models` 里另有一批 `code=11102 service info not found` 的条目
 * （glm-4.6/4.7/5.0、minimax-m2.5、kimi-k2.5/k2.8-preview、hunyuan-* 等），
 * 列进选择器只会让用户选中后报错，故一律不收录。
 */
const CODEBUDDY_FALLBACK_MODELS: readonly BuddyFallbackModel[] = [
  {
    id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
  },
  {
    id: 'hy3', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
    reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
  },
  {
    id: 'hy3-x', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
    reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
  },
  {
    // maxOutputTokens 实测（2026-09-19）：scoped 端点 128000、/v3/config 131072。
    // 取 **128000**（两个端点的较小者）：它是服务端真正接受的额度，131072 是
    // /v3/config 的声明值。取小者避免因端点差异被上游拒绝；远端可用时仍以
    // 远端下发值为准，本字段只在远端缺失时补位。
    id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
  },
  {
    id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
  },
  {
    // 2026-09 补录：远端 /v3/config 与 scoped 端点均返回该模型，且实测能看图
    // （纯红图问答答出「红色」）。它不在 craft/cli agent 白名单里，但可正常调用，
    // 也是适配器 DEFAULT_MODEL 的取值。
    //
    // 档位沿用适配器静态表 REASONING_EFFORTS 的既有取值 [low,high,max]（该表有
    // 实测依据：三档会显著改变返回的 reasoning_content 长度）。注意上游
    // /v3/config 声明的是 [low,high,xhigh]，与本表不一致。
    //
    // ⚠️⚠️ 原注释写「实测服务端对 low/medium/high/xhigh/max 一律返回 200（不报
    // 非法参数），无法据此判定哪一组才真实生效」—— **该结论已被推翻**
    // （issue IKJQSH，2026-10-06 实测）：服务端**确实校验档位枚举**，拼错的
    // `banana` 会回 HTTP 400（国际版 `code:11133` + `extError.code=model_param_invalid`；
    // 中国版更明确：`code:11150` + `the reasoning effort value is not supported by
    // the current model`）。故「不报非法参数」只对**合法值**成立，
    // 判定合法性的正确手法是发一个**明确的非法值**作对照。
    // ⚠️ 该模型本身尚未按新手法复测，故本表取值维持不变（不擅自改动既有行为）；
    // 复测时须带上 `banana` 对照，否则「200」什么也证明不了。
    id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 50_000,
  },
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
  },
  {
    id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 32_000,
  },
  {
    id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
  },
  {
    // supportsImages 为 true 有实测依据：纯红图问答答出「红色」。
    // 注意 scoped 端点（/console/enterprises/personal/models）对它返回
    // supportsImages=false，与 /v3/config、IDE 缓存、wb2api 清单三处矛盾；
    // 实测以「能看到图」为准，故保留 true（远端若下发 true 则两者一致，
    // 只有 scoped 端点先命中时才会被它的 false 覆盖，见 buddy-adapter 的
    // supportsImagesFor 修正）。
    id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'],
    maxOutputTokens: 48_000,
  },
  {
    id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'],
    maxOutputTokens: 64_000,
  },
  {
    id: 'kimi-k3-1', name: 'Kimi-K3-1', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'],
    maxOutputTokens: 32_000,
  },
  {
    // 2026-09 补录：旧注释曾把它列为「service info not found」而排除，但实测
    // 可正常调用且能看图（纯红图问答答出「红色」），远端两端点也都在下发。
    id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
  },
  {
    id: 'kimi-k2.7', name: 'Kimi-K2.7', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'],
    maxOutputTokens: 32_000,
  },
  {
    id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'],
    maxOutputTokens: 32_000,
  },
  {
    id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, supportsImages: true, reasoningEfforts: ['medium'],
    maxOutputTokens: 64_000,
  },
]

export const CODEBUDDY: BuddyProduct = {
  id: 'buddy',
  platform: 'ide',
  endpoint: 'https://copilot.tencent.com',
  apiDomain: 'copilot.tencent.com',
  claimBase: 'https://www.workbuddy.cn',
  webBase: 'https://www.workbuddy.cn',
  displayName: 'CodeBuddy (腾讯)',
  productCode: 'codebuddy',
  userAgent: 'CodeBuddyIDE/4.12.2',
  // 中国版只有一条产品线，无需按模型分档：全部模型沿用 IDE UA。
  userAgentByModelFamily: [],
  attributionName: 'CodeBuddy',
  // ⚠️⚠️ **本值 = 客户端 `product.json` 的 `genieVersion`**（2026-10-30 反编译实证，
  // 不是猜的）：`extensions/genie` 的 `getPlatformVersion()` 实现是
  // ```js
  // const product = JSON.parse(readFileSync(join(env.appRoot, 'product.json')))
  // if (product.genieVersion) return product.genieVersion   // ← 优先
  // return version                                          // 兜底 = product.json.version
  // ```
  // 而 `CustomHeadersHttpProxyInterceptor` 里：
  // ```js
  // if (ci.platformVersion) {
  //   headers['X-IDE-Version'] = ci.platformVersion
  //   setCodeBuddyVersion(ci.platformVersion)   // ← UA 用同一个值
  // }
  // ```
  // ⇒ `X-IDE-Version` 与 `User-Agent` **同源**（都取 `genieVersion`）。
  // ⚠️ 本机 `CodeBuddy CN/resources/app/product.json` 实测：
  // `version = 1.106.1`（VS Code 基底）而 **`genieVersion = 4.12.2`**（产品版本）
  // ⇒ 发 `1.106.1` 是**发错了字段**（那是兜底值，只有在 `genieVersion` 缺失时才用）。
  // ⚠️ 交叉验证：`WorkBuddyAI/.../cli/product.json` 的 `genieVersion = 5.9.4`，
  // 与客户端「关于」里显示的 `版本: 5.9.4 (fa0a0901)` 一致 ⇒ 该字段确实是
  // **对外报的版本**。⇒ 本仓 `WORKBUDDY.clientVersion` 的权威取值就是它。
  clientVersion: '4.12.2',
  cliVersion: '2.137.1',
  defaultCredentialRef: 'BUDDY_ACCESS_TOKEN',
  appendSessionParams: false,
  // 合法登录站 / API 域：中国版登录站在 www.codebuddy.cn（`buddy.ts` 的
  // WEBSITE_HOME），API 域是 copilot.tencent.com。两者都在本机真实凭据里出现过
  // （12 条 `www.codebuddy.cn` + 8 条 `copilot.tencent.com`）。
  //
  // ⚠️⚠️ **`www.workbuddy.cn` 刻意不在这里**（虽然它是本产品的 `claimBase`）：
  // 本字段的语义是「凭据里 `domain` 的合法值集合」，而 `domain` = token 的 `iss`
  // 主机 = **登录站 / 认证 realm**。`www.workbuddy.cn` 是**成长中心网页站**
  // （`claimBase` / `webBase`），**不签发 token**，因此永远不会作为 `iss` 出现在
  // 凭据里 —— 把它登记进来属于**语义错位**。
  //
  // ⚠️ 更关键：`providerFromIssuer`（`plugin-src/client/backup-convert.js`）按
  // 「host 含子串 `workbuddy`」分派，会把该域分派给 **workbuddy**；若这里也登记它，
  // 两套判据对同一域给出**矛盾归属**（域表说 buddy、分派说 workbuddy）。
  // 实测核对：登记它会让「knownDomains 归属 vs providerFromIssuer 归属」出现 1 处矛盾。
  // ⇒ 两套判据必须同构：**只登记真正的 realm 主机**。
  //
  // ⚠️ 那「中国区旧 workbuddy 账号清不掉」怎么办？见 `knownDomains` 的注释：
  // 未知域**保守保留**是刻意取舍（误留的代价远小于误删），且该域作为 realm
  // **无任何实证**（本机 5 条 workbuddy 凭据的 `iss` 全是 `www.workbuddy.ai`）。
  // 若将来拿到实证，正确修法是**同时**改分派判据与域表，不要只改一处。
  knownDomains: ['copilot.tencent.com', 'www.codebuddy.cn', 'codebuddy.cn'],
  fallbackModels: CODEBUDDY_FALLBACK_MODELS,
}

/**
 * WorkBuddy 国际版的内置模型目录。
 *
 * 数据来源：IDE 的本地缓存 `~/.workbuddy-ai/local_storage/*.info`
 * （`WorkbuddyAuthProductCoordinator` 写入的 ProductManager 合并结果），
 * 即 IDE 模型选择器实际展示的清单与元数据。
 *
 * 顺序即 IDE 的展示顺序（`cli` agent 白名单顺序），不要随意重排。
 */
const WORKBUDDY_FALLBACK_MODELS: readonly BuddyFallbackModel[] = [
  // 注：以下 maxOutputTokens 全部来自 2026-09-19 对国际版 `/v3/config` 的实测
  // （`node scripts/dump-max-output.mjs`）。该值就是用户在 IDE 里实际拿到的
  // 单次输出额度，远端不可用时由本表顶替。远端未下发的模型保持 undefined。
  { id: 'default-model', name: 'Auto', contextWindow: 176_000, supportsImages: true, maxOutputTokens: 24_000 },
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 32_000 },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 32_000 },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, supportsImages: true, reasoningEfforts: ['high'], maxOutputTokens: 72_000 },
  { id: 'deep-model', name: 'Deep', contextWindow: 176_000, supportsImages: true, maxOutputTokens: 24_000 },
  {
    id: 'hy4-preview-f', name: 'Hy4 preview', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
  },
  {
    // 2026-09 补录：/v3/config 的 cli agent 白名单里有它，但兜底表原先漏了，
    // 于是被 reconcileWithFallback 丢弃、模型选择器里看不到。实测能看图。
    id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
  },
  {
    id: 'hy3', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
    reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
  },
  {
    // ⚠️ 档位取 5 档（issue IKJQSH）。本表是这两个模型的**唯一档位来源**：
    // 国际版 `/v3/config` 对它们**不下发 supportedEfforts**，只给一个单值
    // `reasoning: {effort:"high", summary:"auto"}`（即「固定 high、不提供选择」）。
    // 而 `parseModelMeta`（src/buddy.ts）只认 `supportedEfforts` 数组与
    // `defaultEffort`，**不认识 `effort`** —— 故远端这个表态会被静默忽略，
    // 最终落到本表。写 `['high']` 意味着用户永远只有 high 可选，max 从未出现过。
    //
    // 实测（2026-10-06，真实登录态直打 www.workbuddy.ai，同一条长前缀提示）：
    //   low/medium/high/xhigh/max 五档**全部 HTTP 200 且都有真实 reasoning_content**
    //   （4093 / 8670 / 9023 / 4105 / 10559 字符）；拼错的 `banana` 被拒：
    //   HTTP 400 `code:11133` / `extError.code=model_param_invalid`。
    // ⇒ 服务端**确实校验档位枚举**，故这 5 档是「实测可行」而非推测。
    // ⚠️ 这条同时推翻了本文件下方 deepseek-v4-flash 那条「服务端对各档一律返回 200、
    // 无法判定哪组生效」的旧记录：非法值会 400，可据此判定。
    // ⚠️ 强度序**不可**从思考长度反推：xhigh(4105) 实测比 low(4093) 还短。
    //
    // ⚠️ 若将来 scoped 端点（/console/enterprises/personal/models）恢复并为这两个
    // 模型下发列表，`mergeRemoteModels` 会以 scoped 为准（只比 id、不逐字段补齐），
    // 本表才真正退居「远端缺失时补位」—— 但仍应保持这 5 档：它是「远端没表态时
    // 我们对外的承诺」。
    id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
  },
  {
    // 2026-09 补录：新加坡区的同代模型（-sg 后缀），远端下发且实测能看图。
    // 档位依据同上：国际版 `/v3/config` 对它同样只给 `reasoning.effort:"high"`、
    // 不下发列表，故本表是唯一来源。实测五档同样全部 200 且有思考输出
    // （3833 / 3761 / 5020 / 6345 / 16947 字符），`banana` 同样被 400 拒绝。
    //
    // ⚠️ 与 CodeBuddy 的 `-sg` 不是一回事：中国版端点上该模型不存在
    // （实测 `code:11102 service info not found`），故 CODEBUDDY 兜底表未收录它。
    // 这里是国际版专属条目，不要照抄到 CODEBUDDY 那张表。
    id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
  },
  {
    id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
  },
  {
    id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
  },
  {
    id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
  },
  {
    id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
  },
  {
    id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
  },
  {
    id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 72_000,
  },
  // gpt-5.3-codex：远端未下发 maxOutputTokens，故不填（保持 undefined，
  // 交由网关默认），不臆造数值。
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 65_536 },
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 48_000,
  },
  {
    id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 48_000,
  },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 32_000 },
  {
    // 2026-09 补录：远端 /v3/config 的 cli agent 白名单里有它，兜底表原先漏了。
    id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 32_000,
  },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 32_000 },
]

/**
 * WorkBuddy 国际版（腾讯 WorkBuddy AI），platform = workbuddy-ai。
 *
 * 逆向自 `C:\Users\Jet\AppData\Local\Programs\WorkBuddyAI`（5.9.4）的 cli/product.json：
 * - `applicationName` = "workbuddy-ai"
 * - `endpoint` = "https://www.workbuddy.ai"（**与中国版不同**，模型池随区域变化）
 * - `authentication.attributes.platform` = "workbuddy-ai"
 * - `prefixPath` = "/plugin"（与中国版相同）
 *
 * ## ⚠️ 2026-11-15 更正：签到**有**，成长任务**没有**
 *
 * 原文写「该产品**没有**每日签到积分接口（内核中只有 `/v2/billing/meter/get-dosage-notify`）」
 * —— **这句话是错的**，它把「CLI 内核里没硬编码这个路径」当成了「后端没有这个端点」。
 * 实测（GitHub issue #86）：国际版的签到端点与国内版**逐字同形**
 * （`POST /v2/billing/meter/checkin-activity-status` 查状态、
 * `POST /v2/billing/meter/daily-checkin` 领取），只有 baseURL 不同；同一个坑
 * `src/credits.ts` 对余额端点 `get-user-resource` 已经记过一次。
 * 能力表已据此改成 `dailyCheckin: true`（PR #87），
 * 活跃上报/连登回读在 `src/workbuddy-intl-activity.ts`。
 *
 * **但「成长任务/成长中心」确实没有**（这一半仍然成立）：contributor 在 !62 复审中
 * 实测确认 `www.workbuddy.ai` 后端无任务列表、无 claim 端点。故宿主侧
 * `src/provider-credits.ts` 里**只有 buddy** 挂 `credits.afterClaim`，
 * 客户端 `GROWTH_TASK_PROVIDERS` 也据此排除 `workbuddy`。
 *
 * ⚠️ 下面的 `claimBase` / `webBase` 是**占位值**（为满足 `BuddyProduct` 的必填形状），
 * 本产品**没有任何代码路径会读取它们**：成长任务的唯一入口是 `afterClaim`，
 * 而 `workbuddy` 没挂它 ⇒ `runTasks: true` 传不进来。
 *
 *    ⚠️ 2026-10-08（Task 4）：宿主侧原先另有一张手抄的 `GROWTH_CAPABLE_PROVIDERS`
 *    集合，**已删除** —— 「哪家有成长中心」现在由「该家是否提供 `credits.afterClaim`」
 *    回答（能力注册表说了算，不再有第二份可漂移的名单）。
 *
 * 两个字段保留是因为 `BuddyProduct` 把它们声明为必填；若将来类型放宽为可选，
 * 这里可以删掉（`claimBaseOf` / `webBaseOf` 已能正确处理空值并给出可读错误）。
 */
export const WORKBUDDY: BuddyProduct = {
  id: 'workbuddy',
  platform: 'workbuddy-ai',
  endpoint: 'https://www.workbuddy.ai',
  apiDomain: 'www.workbuddy.ai',
  /** ⚠️ 占位值：本产品无成长中心，无任何读取点（见上方注释）。 */
  claimBase: 'https://www.workbuddy.ai',
  /** ⚠️ 占位值：本产品无成长中心，无任何读取点（见上方注释）。 */
  webBase: 'https://www.workbuddy.ai',
  displayName: 'WorkBuddy (国际版)',
  productCode: 'workbuddy',
  // 默认档：国际版产品形态（无按模型命中时使用）。
  userAgent: WORKBUDDY_UA_INTL,
  userAgentByModelFamily: [
    // 国际版独有模型线（GPT / Gemini / Claude 系）→ 国际版形态。
    { match: 'gpt-', ua: WORKBUDDY_UA_INTL },
    { match: 'gemini-', ua: WORKBUDDY_UA_INTL },
    { match: 'claude-', ua: WORKBUDDY_UA_INTL },
    // 国内系模型（glm / hy / kimi / minimax）→ 国内客户端形态。
    { match: 'glm-', ua: WORKBUDDY_UA_CN },
    { match: 'hy', ua: WORKBUDDY_UA_CN },
    { match: 'kimi-', ua: WORKBUDDY_UA_CN },
    { match: 'minimax-', ua: WORKBUDDY_UA_CN },
  ],
  attributionName: 'WorkBuddy',
  clientVersion: '5.9.4',
  cliVersion: '5.9.4',
  defaultCredentialRef: 'WORKBUDDY_ACCESS_TOKEN',
  appendSessionParams: true,
  pluginVersion: '5.9.4',
  // 国际版登录站与 API 域都是 www.workbuddy.ai（本机 5 条真实凭据的 iss 全是此值，
  // 且本产品的 `apiDomain` 自引入起就从未是 `.cn`）。
  // ⚠️ 这里列的是 `.ai` 的各 realm 主机形态。**没有 `.cn` 条目**：本机与 git 历史
  // 均无 `.cn` 作为 WorkBuddy realm 的实证（`www.workbuddy.cn` 是中国区**成长中心**
  // 站，见 `claimBase`，不是登录站）。
  // ⚠️ 宁可多列本产品的合法域：`pruneAccountsWithForeignDomain` 只在**命中别的产品
  // 的集合**时才删账号（见 `knownDomains` 的注释），故漏列会让跨机导入的账号被静默
  // 删除；反之多列只会让一个本该清理的旧账号多留一会儿（它至多续期失败并在日志可见）。
  knownDomains: ['www.workbuddy.ai', 'workbuddy.ai', 'auth.workbuddy.ai', 'api.workbuddy.ai'],
  fallbackModels: WORKBUDDY_FALLBACK_MODELS,
}

/** 全部产品配置，供按 id 查询与遍历注册使用。 */
export const ALL_PRODUCTS: readonly BuddyProduct[] = [CODEBUDDY, WORKBUDDY]

/** 按 provider id 取产品配置；未知 id 返回 undefined。 */
export function productById(id: string): BuddyProduct | undefined {
  return ALL_PRODUCTS.find((product) => product.id === id)
}

/**
 * 按模型 id 解析该产品应使用的 User-Agent（按模型族分档）。
 *
 * 命中规则：`userAgentByModelFamily` 中**先命中先返回**（`match` 为前缀）。
 * 未命中任何规则时回退到 `product.userAgent`。这条回退链保证新模型上线时
 * 仍有一个确定的、含产品品牌字样的 UA，不会退化成框架默认的 harness UA。
 *
 * @param product - 产品配置
 * @param model - 模型 id（如 `gpt-5.6-sol` / `glm-5.2`）
 */
export function resolveUserAgent(product: BuddyProduct, model: string): string {
  for (const rule of product.userAgentByModelFamily ?? []) {
    if (model.startsWith(rule.match)) return rule.ua
  }
  return product.userAgent
}
