/**
 * Raccoon Work（商汤小浣熊）产品配置。
 *
 * ## 为什么新建 `RaccoonProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `LobsteraiProduct` / `QoderProduct` / `LoomyProduct` 的字段
 * 全部围绕各自协议设计（归属头、refresh 载荷、WASM 签名参数、讯飞 AccessKey…），
 * 对 raccoon 无一有意义。raccoon 需要的是：一套 API 前缀、桌面端身份标识、
 * 手机号加密密钥、阿里云验证码配置，以及一张兜底模型表。
 * 故定义**平行**的接口 —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## 数据来源
 *
 * - API 基址与各前缀：`app.asar` 的 `.env.electron`
 * - 手机号加密密钥：渲染层模块 68284 的 `yv(e, t = "senseraccoon2023")`
 * - 阿里云验证码：渲染层模块 37907 的 `q3`（SceneId）/ `$j`（prefix）
 * - 兜底模型表：2026-09-26 用本机登录态实测
 *   `GET /api/web/llm/v2/model_catalog` 取 `visible:true` 的 6 条
 */

import { RACCOON_API_BASE, RACCOON_PHONE_CIPHER_SECRET } from './raccoon.js'
import { RACCOON_REQUEST_IMAGE_MAX_BYTES } from './image-budget.js'

/**
 * 思考档位：小浣熊**只有两态（开 / 关）**，这是实测确证的。
 *
 * ## ⚠️ 为什么是「开 / 关」而不是「high / 关闭」
 *
 * 服务端**接受** `reasoning_effort`（8 个枚举值，报错原文：
 * ``expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `ultra`, `max` ``），
 * 但它**不产生任何可观测效果** —— 8 轮配对实验（`temperature=0`）：
 *
 * | 档位 | `reasoning_tokens` 均值 |
 * |---|---|
 * | `minimal` | 197 |
 * | `max` | 226 |
 *
 * 逐轮配对差值 `max - minimal`：**正差 4 次 / 负差 4 次**（纯随机）。
 * 4 轮小样本时曾观察到「单调趋势」（175→288），8 轮后消失 —— 那是巧合。
 * 且 `none` 均值 301 ≠ `disabled` 的 0，说明**它也不控制思考开关**。
 *
 * ⇒ `reasoning_effort` 只是被 JSON schema 接受，不影响行为。
 *
 * ## 唯一有效通道：`extra_body.thinking.type`
 *
 * 报错原文：``thinking.type: expected one of `adaptive`, `enabled`, `disabled` ``。
 * 实测（每组 6~8 次，判据为服务端上报的 `reasoning_tokens`）：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | 基线（不发参数） | 均值 **222**，6/6 有思考 |
 * | `extra_body.thinking={type:'disabled'}` | **6/6、8/8 全为 0** → ✅ 真关闭 |
 * | `extra_body.thinking={type:'enabled'}` | 均值 **218** → ✅ 与默认等价 |
 *
 * 故我们**只暴露这两态**：开（enabled）与关（disabled）。
 *
 * ## ⚠️ 无效的写法（都实测过，别照着试）
 *
 * | 写法 | 结果 |
 * |---|---|
 * | `extra_body.enable_thinking=false` | ❌ 无效 |
 * | `extra_body.extra_body.enable_thinking=false`（双层） | ❌ 无效 |
 * | `reasoning_effort`（单层/双层/顶层） | ❌ 被接受但**无效果**（见上） |
 * | `thinking` 放**顶层**（不在 `extra_body` 内） | ❌ 被忽略（非法值也不报错） |
 * | `thinking.budget_tokens` | ⚠️ 仅被**格式校验**（`max_tokens < budget_tokens` 回 400），1~4096 全接受但思考量无规律 |
 *
 * ⚠️ 客户端注释说 `extra_body` 双层嵌套是 **LiteLLM SDK 的调用约定**
 *（"LiteLLM expects another provider-owned extra_body object inside that body"）——
 * 但实测**单层才生效**，故以实测为准。
 */

/**
 * 档位 id：**开启**思考（`thinking:{type:'enabled'}`）。
 *
 * ⚠️ id 用 `on` 而不是 `high`：服务端虽接受 `high` 字样，但它走的是
 * `reasoning_effort` 通道、**实测无效果**。用 `on` 避免让用户误以为
 * 「选的是高强度档」—— 我们能表达的只有「开 / 关」。
 */
export const RACCOON_EFFORT_ON = 'on'

/** 档位 id：**关闭**思考（`thinking:{type:'disabled'}`）。 */
export const RACCOON_EFFORT_OFF = 'off'

/**
 * 档位展示名（DSH 直接渲染 `efforts[].name`，不本地化）。
 *
 * ⚠️ **用词**取「开启」「关闭」两个词，而不是「深度思考」「关闭思考」（用户 2026-09-28 要求：
 * 「现在开启档位显示的深度思考，就显示开启就行了」）。
 * （⚠️ 这里说的是**用哪两个词**，不是顺序 —— 顺序见上一段的强度序说明。）
 *
 * ⚠️ 本表是**名称映射**、与顺序无关（键是 id）。**声明顺序**在
 * {@link RACCOON_REASONING_EFFORTS}，那才是「关闭 → 开启」的强度序。
 *
 * 理由是**如实**：我们能表达的只有「思考开 / 关」这一个布尔维度，
 * 没有任何强度档位（`reasoning_effort` 实测无效）。叫「深度思考」会让用户
 * 以为存在「浅度思考」之类的其他档位可选，而实际上没有。
 */
export const RACCOON_EFFORT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  [RACCOON_EFFORT_ON]: '开启',
  [RACCOON_EFFORT_OFF]: '关闭',
})

/**
 * 该模型可选的思考档位（**顺序 = 强度序：弱 → 强**，Issue IKLIDV）。
 *
 * ⚠️ **所有 6 个可见模型都返回这两档** —— 实测 `extra_body.thinking` 是
 * **provider 级方言**，与模型无关（`thinking.type` 的枚举在服务端全局一致）。
 * 故不做 per-model 分派（那会是凭空猜测）。
 *
 * ⚠️ **顺序是「关闭 → 开启」，不是「默认档排第一」**：DSH 的契约把该数组当
 * **展示顺序**（`dsh-llm/lib/types/types.d.ts`：`adapter-preferred display order`），
 * 客户端**直接 `map` 不排序**（`dsh-client-ui-model-selection/lib/client.js`）
 * ⇒ 把默认档 `on` 排在最前，会让「开启」落在横向档位轴的最左（左强右弱）。
 * 强度序的权威是本仓库 `REASONING_EFFORT_RANK`（`off: 0` / `on: 5`）。
 * ⚠️ `defaultEffort` 与数组位置是**两件事**（见 {@link RACCOON_DEFAULT_EFFORT}）。
 *
 * ⚠️ **有代码依赖本数组的顺序吗**：见 `raccoon-adapter.ts` 的
 * `raccoonReasoningInfo()` —— 它的兜底分支原先读 `[0]`（=「第一项即默认档」），
 * 调整顺序后**必须**改成读 {@link RACCOON_EFFORT_ON} 字面量，否则该分支会
 * 静默回退成「关闭思考」。那是一处**方向取反**，比顺序本身严重得多。
 */
export const RACCOON_REASONING_EFFORTS: readonly string[] = Object.freeze([
  RACCOON_EFFORT_OFF,
  RACCOON_EFFORT_ON,
])

/**
 * 默认档位 = `on`。
 *
 * 依据：实测「不发参数」与「显式 `{type:'enabled'}`」的思考量**等价**
 *（均值 222 vs 218），即**服务端默认就是开启**。故默认标成 `on`
 * 是**如实描述**，不是我们强行改变行为。
 */
export const RACCOON_DEFAULT_EFFORT = RACCOON_EFFORT_ON

/**
 * 兜底模型目录中的一个条目。
 */
export interface RaccoonFallbackModel {
  /** 模型 ID（传给 `chat/completions` 的 `model`）。 */
  id: string
  /** **已规范化**的展示名（含倍率，` · ` 分隔；免费显示「免费」）。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 单次输出上限（远端 `params.max_tokens`）。 */
  maxTokens: number
  /**
   * 是否支持图片输入。
   *
   * ⚠️ 语义是「**默认支持**」：只有在 {@link RACCOON_TEXT_ONLY_MODELS} 里的
   * 纯文本模型才为 `false`。判据见 {@link raccoonSupportsImage}。
   */
  supportsImage: boolean
}

/** Raccoon Work 产品配置。 */
export interface RaccoonProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'raccoon'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** API 基址。 */
  apiBase: string
  /** 认证端点前缀。 */
  authApiPrefix: string
  /** 推理与模型目录前缀。 */
  llmApiPrefix: string
  /** 积分端点前缀。 */
  pointsApiPrefix: string
  /** 桌面端端点前缀。 */
  desktopApiPrefix: string
  /**
   * 单张请求图片的像素预算（issue !IKITT9 的 raccoon 变体）。
   *
   * ⚠️ **raccoon 的约束与腾讯不是一回事**：它按**请求体字节**卡 ——
   * 实测 `HTTP_413: request body exceeds 10MB`，一张 2560×1600 的截图
   *（原图 2.87 MiB → base64 后 ≈3.9 MB）过、四张必爆。
   * 所以真正起作用的是下面的 `imageMaxBytes`；像素预算只是让图不至于
   * 大到编码器压不进那个字节目标。
   */
  imagePixelBudget?: number
  /**
   * 单张请求图片的**编码字节目标**（base64 展开前）。
   *
   * 取 **512 KB**：base64 膨胀 4/3 → 每张约占 683 KB，
   * 10 MB 的配额可放约 **14 张**（原图只能放 2 张）。
   * ⚠️ 这是"每张固定预算"路线的固有上限：图再多仍会 413。
   * 按张数分摊总配额会把每张压到 600×400 以下、UI 小字直接糊掉，
   * 权衡后选择「保住可辨认性 + 覆盖到 14 张」（用户 2026-09-28 定，方案 A）。
   */
  imageMaxBytes?: number
  /** User-Agent（仅记录用；实测该端点不校验 UA）。 */
  userAgent: string
  /**
   * 客户端平台标识。
   *
   * ⚠️ 取值必须是 `desktop-windows` / `desktop-macos` / `desktop-linux`
   * —— 依据主进程 `desktopDeviceIdentity.js` 的 `resolveDesktopClientPlatform`
   * （`win32` → `desktop-windows`）。`desktop/v1/login/points/grant`
   * **要求**该头，猜错会被拒。
   */
  clientPlatform: string
  /** 客户端版本（带 `v` 前缀，如 `v1.0.35`）。 */
  clientVersion: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 手机号传输层加密密钥（见 `raccoon.ts` 的说明：公开常量，非安全边界）。 */
  phoneCipherSecret: string
  /** 阿里云滑块验证码配置（短信登录必需）。 */
  aliyunCaptcha: { sceneId: string; prefix: string }
  /** 远端模型列表不可用时的兜底目录（6 个可见模型）。 */
  fallbackModels: readonly RaccoonFallbackModel[]
}

/**
 * 兜底模型目录（6 个 `visible:true` 模型）。
 *
 * 来源：2026-09-26 实测 `GET /api/web/llm/v2/model_catalog`。
 * 顺序**照抄远端返回顺序**，不重排 —— 重排会让「与远端对比」这类排查失去可比性。
 *
 * ⚠️ 展示名由 `raccoonDisplayName` 的输出形态固化（` · x倍率` / ` · 免费` /
 * ` · x原价→x折后价`），与远端 `billing_effective_multiplier` 逐条对应：
 *
 * | id | 原价 | 生效价 | 展示 |
 * |---|---|---|---|
 * | `sn-sensenova-6-8-flash` | 0.5 | 0 | 免费 |
 * | `sn-sensenova-6-8-flash-lite` | 0.5 | 0 | 免费 |
 * | `sn-glm-5-3` | 0.75 | 0.75 | x0.75 |
 * | `sn-kimi-k3` | 1 | 1 | x1 |
 * | `sn-glm-5-3-flash` | 0.2 | 0.1 | x0.2→x0.1 |
 * | `sn-deepseek-v4-1-flash` | 0.25 | 0.25 | x0.25 |
 *
 * ⚠️ **不含** `Raccoon-Auto`：它是客户端 i18n 条目（`modelPicker.auto`）渲染的
 * 「自动选模」入口，不是远端模型 —— 直接发给 `chat/completions` 会 404。
 * ⚠️ 也不含 3 个 `visible:false` 的 `raccoon-*` 内部模型。
 *
 * ⚠️⚠️ **`maxTokens` 不是远端原值**（issue IKS1L5）：远端目录对这几个模型发的是
 * `100_000`，而上游网关对 `max_tokens` **硬校验 1..65536**（命中即整轮 400，
 * 且该 model group 没有 fallback）。这里统一写 `65_536` = 上游能接受的上限。
 * 适配器侧还有两道夹子（声明值 + 请求体，见 `clampRaccoonMaxTokens`），
 * 表里的值只是「不要再把已知会 400 的数字写回来」。
 */
const RACCOON_FALLBACK_MODELS: readonly RaccoonFallbackModel[] = [
  {
    id: 'sn-sensenova-6-8-flash',
    name: 'SenseNova-6.8-Flash · 免费',
    contextWindow: 256_000,
    maxTokens: 63_999,
    supportsImage: true,
  },
  {
    id: 'sn-sensenova-6-8-flash-lite',
    name: 'SenseNova-6.8-Flash-Lite · 免费',
    contextWindow: 256_000,
    maxTokens: 63_999,
    supportsImage: true,
  },
  {
    id: 'sn-glm-5-3',
    name: 'GLM-5-3 · x0.75',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    supportsImage: true,
  },
  {
    id: 'sn-kimi-k3',
    // ⚠️ 1 倍也要显示（用户报障「为什么 Kimi-K3 没有倍率，ide 是 1 倍，
    // 1 倍也要显示倍率」）—— 见 `raccoonDisplayName` 的注释。
    name: 'Kimi-K3 · x1',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    supportsImage: true,
  },
  {
    id: 'sn-glm-5-3-flash',
    name: 'GLM-5-3-Flash · x0.2→x0.1',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    // ⚠️ 远端 tags 不含 `vision`，但**实测能看图**（tags 不是能力契约，见
    // `RACCOON_TEXT_ONLY_MODELS` 的注释）。
    supportsImage: true,
  },
  {
    id: 'sn-deepseek-v4-1-flash',
    name: 'DeepSeek-V4.1-Flash · x0.25',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    // ⚠️ 同上：远端 tags 不含 `vision`，实测 5/5 读对随机数字。
    supportsImage: true,
  },
]

/**
 * **实测确认不能读图**的模型（**基础 id**）—— 图片能力「默认支持」策略的唯一刹车。
 *
 * ## 当前策略（2026-10-21 用户定）：默认支持识图，只禁真正的纯文本模型
 *
 * `raccoonSupportsImage()` 对**不在本集合**的模型一律返回 `true`（声明
 * `['text','image']`），不再看远端 `tags`。理由链：
 *
 * 1. 远端**从未下发**任何模态字段：已穷举一次 `model_catalog` 的键并集
 *    （顶层 14 键、`params` 只有 `context_window` / `max_tokens`），用
 *    `/modal|vision|image|img|multimodal|media|type|capab|support|input|output/i`
 *    扫描**命中 0 个**。
 * 2. 唯一的信号 `tags.vision` 是**客户端「Raccoon-Auto 选模」的偏好标签**，
 *    不是服务端能力契约：2026-10-03 实测 6 个可见模型**全部**能读图，其中
 *    `sn-deepseek-v4-1-flash` / `sn-glm-5-3-flash` 的 tags 根本不含 `vision`。
 * 3. 远端会滚动上架同族版本（`-1017` 等），新 id 的 `tags` 原样继承 ⇒
 *    白名单式判据**必然腐坏**：2026-10-21 `sn-deepseek-v4-1-flash-1017`
 *    就被打回 `['text']`，而实测它带图 200、四象限色全对。
 *
 * ⇒ 判据翻转为「**默认 image**」；真正的纯文本模型登记到本集合里**显式禁掉**。
 *
 * ## ⚠️ 代价（必须知道）
 *
 * 若远端上线一个**真正的纯文本模型**而我们没及时登记，DSH 会放行图片，
 * 上游则可能**静默忽略**（不是报错）⇒ 模型凭文字幻觉作答。这与 accio 的
 * GLM 5.1 实测同型（`multimodal:false` 不报错而是忽略）。
 * ⇒ 本集合是唯一刹车；**新增条目必须先实测**，判据是「带图请求被明确拒绝
 * （4xx / 明确错误码），而不是『200 但答非所问』」。
 *
 * ## 既有实测证据（保留，便于下次核对）
 *
 * 同一张「随机 6 位数字」图（模型无法猜）打 `POST /api/web/llm/v2/chat/completions`：
 *
 * | 模型 | 远端 tags 含 vision | 实测读图 |
 * |---|---|---|
 * | `sn-deepseek-v4-1-flash` | ❌ | ✅ **5/5**（208063/942977/999889/123015/478368） |
 * | `sn-glm-5-3-flash` | ❌ | ✅ 1/1 |
 * | `sn-sensenova-6-8-flash` | ✅ | ✅ 2/2 |
 * | `sn-sensenova-6-8-flash-lite` | ✅ | ✅ 1/1 |
 * | `sn-kimi-k3` | ✅ | ✅ 1/1 |
 * | `sn-glm-5-3` | ✅ | ⚠️ 1/3（**provider 侧节点不一致**，见下） |
 *
 * 2026-10-21 同一张 16×16 四象限纯色 PNG（左上红/右上绿/左下蓝/右下白）：
 *
 * | 模型 | 状态 | 正文（ANSWER） |
 * |---|---|---|
 * | `sn-deepseek-v4-1-flash` | 200 | `红/绿/蓝/白` |
 * | `sn-deepseek-v4-1-flash-1017` | 200 | `红/绿/蓝/白` |
 *
 * ## ⚠️ 顺带发现：`sn-glm-5-3` 节点不一致（provider 侧缺陷，不归我们）
 *
 * 它 3 次里只对 1 次，两次回「当前模型不支持图片或视频输入」。错误体暴露网关有
 * 3 个 fallback 组（`raccoon-4eb26a` / `raccoon-0c119c` / `raccoon-ecc5fd`），
 * **部分节点是纯文本的**。这是节点问题、不是模型能力，故**不**登记到本集合
 * （登记了会把整条模型禁成 text，而正常节点其实能看图）。
 */
export const RACCOON_TEXT_ONLY_MODELS: ReadonlySet<string> = new Set<string>([
  // 当前目录（10 条：3 个 visible:false 内部模型 + 7 个可见模型）里**没有**
  // 实测确认的纯文本模型 ⇒ 空集。新增条目必须先有带图实测证据（见上方「代价」）。
])

/**
 * 远端同族模型的**版本后缀**（如 `sn-deepseek-v4-1-flash-1017` 的 `-1017`）。
 *
 * ⚠️ 只在「查纯文本集合」时剥离，**不用于展示名 / 请求 id**：
 * 请求必须用远端下发的完整 id（剥了会 404），展示名也要保留版本号让用户能区分。
 * 故这是一条**局部归一化**，不是全局 `normalizeModelId`（codearts 那边剥后缀
 * 是因为 chat 端点只认无后缀 id，两家的原因相反）。
 */
const RACCOON_MODEL_VERSION_SUFFIX = /-\d{4}$/

/**
 * 图片能力判定的**纯函数内核**（入参化，便于单测注入 `textOnly` 集合）。
 *
 * ⚠️ 为什么要入参化：集合在生产里是空集（当前没有纯文本模型），如果判据直接
 * 闭包读常量，**「纯文本模型被禁」这条分支永远测不到**（只能测到恒 true）。
 * 与 `raccoonDefaultEffort` 的教训同型：不可达分支必须靠注入才测得动。
 *
 * @param textOnly 纯文本模型集合（基础 id 或完整 id）。
 * @param modelId 远端模型 id（可带 `-NNNN` 版本后缀）。
 */
export function raccoonSupportsImageWith(
  textOnly: ReadonlySet<string>,
  modelId: string,
): boolean {
  if (textOnly.has(modelId)) return false
  // 同族滚版本：`sn-deepseek-v4-1-flash-1017` → `sn-deepseek-v4-1-flash`。
  // 纯文本模型同样会滚版本，必须按基础 id 命中，否则新版会漏禁。
  const baseId = modelId.replace(RACCOON_MODEL_VERSION_SUFFIX, '')
  if (baseId !== modelId && textOnly.has(baseId)) return false
  return true
}

/**
 * 远端目录条目的图片能力判定 —— **默认支持**，只有 {@link RACCOON_TEXT_ONLY_MODELS}
 * 里的模型才返回 `false`。
 *
 * ⚠️ 兜底表路径（`fallbackToRemote`）不走本函数：它的真相源是
 * `RACCOON_FALLBACK_MODELS[].supportsImage`（按同一批实测证据全部为 `true`）。
 * 两个真相源由 `tests/unit/raccoon-product.spec.ts` 的
 * 「兜底表与远端判定必须一致」一条锁死 —— **别让它们悄悄分叉**。
 *
 * @param modelId 模型 id（远端下发形态，可带版本后缀）。
 */
export function raccoonSupportsImage(modelId: string): boolean {
  return raccoonSupportsImageWith(RACCOON_TEXT_ONLY_MODELS, modelId)
}

/** Raccoon Work provider 配置。 */
export const RACCOON: RaccoonProduct = {
  id: 'raccoon',
  // ⚠️ 用『Raccoon (商汤)』而非『Raccoon Work (商汤)』—— 后者在 Jet Hub 的
  // provider Tab 里**触发换行**（用户报障）。客户端内的品牌名是 `Raccoon Work`，
  // 但那个词组太长；缩短成 `Raccoon` 后与其余 provider 的标签长度一致
  //（`CodeBuddy (腾讯)` / `LobsterAI (有道)` / `WorkBuddy (国际版)`）。
  displayName: 'Raccoon (商汤)',
  apiBase: RACCOON_API_BASE,
  authApiPrefix: '/api/web/auth/v1',
  llmApiPrefix: '/api/web/llm/v2',
  pointsApiPrefix: '/api/web/points/v1',
  desktopApiPrefix: '/api/web/desktop/v1',
  userAgent: 'Raccoon Work/1.0.35 (Windows)',
  clientPlatform: 'desktop-windows',
  clientVersion: 'v1.0.35',
  defaultCredentialRef: 'RACCOON_ACCESS_TOKEN',
  // 实测该网关按**请求体字节**卡（`HTTP_413: request body exceeds 10MB`），
  // 所以字节目标是主约束；像素预算保证图不至于大到压不进那个字节目标。
  imagePixelBudget: 640_000,
  imageMaxBytes: RACCOON_REQUEST_IMAGE_MAX_BYTES,
  phoneCipherSecret: RACCOON_PHONE_CIPHER_SECRET,
  aliyunCaptcha: { sceneId: '1pkmy0x3', prefix: 'hk1r5l' },
  fallbackModels: RACCOON_FALLBACK_MODELS,
}

/** 全部 Raccoon 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_RACCOON_PRODUCTS: readonly RaccoonProduct[] = [RACCOON]

/**
 * 按 provider id 取产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `lobsteraiProductById` / `loomyProductById`
 * 分开：各自返回**不同类型**，合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function raccoonProductById(id: string): RaccoonProduct | undefined {
  return ALL_RACCOON_PRODUCTS.find((product) => product.id === id)
}
