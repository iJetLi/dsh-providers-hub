/**
 * Loomy（讯飞）产品配置。
 *
 * ## 为什么新建 `LoomyProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `LobsteraiProduct` / `QoderProduct` 的字段全部围绕各自
 * 协议设计（归属头、refresh 载荷、WASM 签名参数…），对 Loomy 无一有意义。
 * Loomy 需要的是：两个 base URL（账号 vs 业务）、讯飞 AccessKey、
 * 以及一张兜底模型表。故定义**平行**的接口 —— 共用的是架构**模式**
 * （产品差异收敛到单一真相源），不是那个类型。
 *
 * ## 数据来源
 *
 * - base URL / AccessKey / appId：`C:\Program Files\Loomy\resources\.env.prod`
 *   Loomy 官方也只是「随客户端分发 + AES 混淆」，本质同样是公开的。
 * - 兜底模型表：2026-09-26 用本机登录态实测 `GET /api/v1/models` 取得
 *   （11 条中 `type==='chat'` 的 8 条）。
 *
 * ## ⚠️ AccessKey 的定位
 *
 * 它只用于**讯飞账号**端点（`account.xfinfr.com`）的 HMAC-SHA1 签名
 * （短信验证码登录）。业务与推理端点用的是用户登录后的 `session`，
 * 与 AccessKey 无关。故 AccessKey 泄露不涉及任何用户数据。
 */

import { LOOMY_ACCOUNT_BASE, LOOMY_API_BASE } from './loomy.js'

/** 兜底模型目录中的一个条目。 */
export interface LoomyFallbackModel {
  /** 模型 ID（传给 `POST /chat/completions` 的 `model`）。 */
  id: string
  /** **已规范化**的展示名（含倍率，` · x{n}` 分隔）。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /**
   * 可选思考档位（远端 `reasoning_efforts` 的实测值）。
   *
   * ⚠️ 与远端**同名字段、同一口径**：远端可用时优先用它，兜底表只在远端整体
   * 失败时顶替。实测 8 个 chat 模型全部是
   * `['none','low','medium','high','xhigh']`、默认 `low`。
   */
  efforts?: string[]
  /** 远端声明的默认档位（`default_reasoning_effort`）。 */
  defaultEffort?: string
}

/**
 * Loomy 产品配置。
 */
export interface LoomyProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'loomy'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 业务基址（推理 / 模型列表 / 积分 / 新手任务）。 */
  apiBase: string
  /** 讯飞账号（CAccount）基址。 */
  accountBase: string
  /** 讯飞账号 AccessKeyId（HMAC-SHA1 签名的 `account {ak}:{sig}` 前半）。 */
  accessKeyId: string
  /** 讯飞账号 AccessKeySecret（HMAC-SHA1 的密钥）。 */
  accessKeySecret: string
  /** 讯飞 appId（账号请求体 `base.appid`）。 */
  appId: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 远端模型列表不可用时的兜底模型目录（8 个 chat 模型）。 */
  fallbackModels: readonly LoomyFallbackModel[]
  /**
   * 单张请求图片的像素预算。**当前刻意不赋值** —— 见下。
   *
   * ## ⚠️ 这里为什么是「声明了但不赋值」
   *
   * 本仓库既有文档曾记「loomy 实测 24 张全过、**无证据说明它有约束**」，
   * 并据此**未接缩放**。该结论**已被 Gitee issue IKKX0T 的独立实测质疑**：
   * 那边给出 `413 Request Entity Too Large`（纯 HTML）/ `504`。
   *
   * ⚠️ **关键换算**：本仓库 fixture 是 2.87 MiB/张、24 张 = **91.8 MiB**，
   * 而 issue（3.45 MiB/张）的边界区间是 **87.4~96.6 MiB** —— 91.8 **恰在区间内部**。
   * 即「24 张全过」很可能是**在边界内 4 MiB 处侥幸通过**，而不是「这家没有约束」。
   * 这正是「某次实测没看到**不能**推广成不存在」的又一实例。
   *
   * ⇒ 按本仓库既定规矩（「拿不到阈值就不定值」），定值前必须先复测：
   * `pnpm test:e2e:image-bisect`（`tests/e2e/image-limit-bisect.e2e.spec.ts`，
   * 二分到 ≤3 张并打印「张数 → 请求体 MiB」的换算）。
   *
   * ⚠️ **不要**照抄别家的 1 MiB（那是按各自实测边界推出来的，见
   * `src/image-budget.ts`），也**不要**因为「字段没人用」就删掉它 ——
   * 它是复测后定值的落点，且与其余按体积设限的家形状一致。
   */
  imagePixelBudget?: number
  /**
   * 单张请求图片的**编码字节目标**（base64 展开前）。**当前刻意不赋值** —— 理由同上。
   *
   * ⚠️ 复测出边界后**必须显式赋值**（不能靠 `requestImageTargetFor` 的默认参数兜底）：
   * 那个默认是 2 MiB，为腾讯系的**图片 token 预算**准备的，而 loomy 撞的是体积 ——
   * 同款缺陷与后果（越过上游硬限）见 `src/image-budget.ts` 的
   * `DEFAULT_BODY_LIMITED_IMAGE_MAX_BYTES` 与 `tests/unit/image-budget.spec.ts`
   * 的「按体积设限的家必须显式给 imageMaxBytes」段。
   */
  imageMaxBytes?: number
}

/**
 * 兜底模型目录（8 个 chat 模型）。
 *
 * 来源：2026-09-26 实测 `GET /api/v1/models`，取 `type === 'chat'` 的条目。
 * 顺序**照抄远端返回顺序**，不重排 —— 重排会让「与远端对比」这类排查失去可比性。
 *
 * ⚠️ `name` 已按 `loomyDisplayName` 规范化（远端原值是三种括号风格混用）。
 * ⚠️ `contextWindow` **不是**远端 `context_length` 的照抄 —— 见
 * {@link LOOMY_CONTEXT_WINDOW_OVERRIDES}（`spark-x` 远端虚高）。
 */
/**
 * 实测的思考档位（8 个 chat 模型**完全一致**，2026-09-28 用真实凭据采集）。
 *
 * ⚠️ 抽成常量而不是逐条写 8 遍：远端对全部 chat 模型下发同一份档位，
 * 逐条重复只会让将来上游变更时漏改其中几条。
 * ⚠️ 远端可用时**优先用远端的 `reasoning_efforts`**，本常量只在远端整体失败时
 * 顶替（与 `contextWindow` 同策略）。
 *
 * ⚠️⚠️ **导出供「目录外 id」复用**（2026-11-06）：本家的档位是**产品级**事实
 * （实测全部 chat 模型逐字相同，包括 2026-11-06 新上架的 `DeepSeek-V4.1-Flash`），
 * 与具体模型无关 ⇒ `loomy-adapter` 的 `unknownModelReasoning` 直接返回这一份，
 * 让**将来又一个**新上架模型在远端抓取失败时也不会退化成「无档位」。
 * 判据与同型先例（cline / codearts 的未知 id 仍声明档位）见
 * `src/model-catalog.ts` 的 `unknownModelReasoning` 表格。
 */
export const LOOMY_EFFORTS: readonly string[] = ['none', 'low', 'medium', 'high', 'xhigh']

/**
 * 本插件选用的默认档位（**用户要求 `high`**）。
 *
 * ⚠️ 远端 `default_reasoning_effort` 声明的是 **`low`**，这里**有意不沿用** ——
 * DSH 的「用户没选时发哪个档」完全取适配器声明的 `defaultEffort`
 * （见 `loomy-adapter.ts` 的 `LOOMY_PREFERRED_DEFAULT_EFFORT` 说明）。
 * 兜底表与适配器常量必须一致，否则「远端可用」与「远端失败」两条路径默认档不同。
 */
const LOOMY_DEFAULT_EFFORT = 'high'

/**
 * 上下文窗口的**逐模型硬覆盖**（`模型 id → 真实窗口`）。
 *
 * ## 为什么需要（真实缺陷，Gitee issue IKJW31）
 *
 * 远端 `GET /models` 对 **`spark-x` 声明 `context_length: 1048576`，而真实墙在
 * 262144**：宿主按 1M 放心打包，输入一旦越过 256K，上游**收下请求但 0 输出**并回
 * `finish_reason=length`，插件映射成 `max-tokens`，而 DSH 对它**不自动重试**
 * ⇒ 长会话表现为「有时候 token 截断 / 已达到输出 token 上限」。
 *
 * ### 硬证据（2026-10-08 复核）
 *
 * 1. **上游墙位**：报障会话 4 次失败的 prompt 总量**逐 token 相同** ——
 *    `261,818 + 320`、`58 + 262,080`（×2）、`252,346 + 9,792`，
 *    全部 = **262,138 = 262,144 − 6**；而同一晚直连（非 auto）的 zcode 473K /
 *    workbuddy 518K / codearts 644K 全部正常 ⇒ 墙**只属于**这一个模型。
 * 2. **官方客户端的本地表**：`C:\Users\Public\Loomy\<hash>\opencode\opencode.json`
 *    实测 `spark-x` 的 `limit.context = 262144`，而同一文件其余 7 个模型的
 *    `limit.context` **与远端逐条一致** ⇒ 官方**只对这一个是刻意降档**的。
 *    这正是旧注释里提到的 `MODEL_CONTEXT_OVERRIDES = { 'spark-x': 262144 }`。
 * 3. **远端自身也在漂移**：`GET /models` 的 chat 条目已从 8 条涨到 **9 条**
 *    （新增 `DeepSeek-V4.1-Flash`）⇒ 「照抄远端」注定过期，与远端**不一致**
 *    必须有显式的、带证据的覆盖点。
 *
 * ⚠️ **旧注释「本表先采信远端；若实测长上下文被拒，改为 262144」已按
 * `262144` 落地** —— 该条件早已满足（见上面第 1 条），别再改回去。
 *
 * ## ⚠️⚠️ 为什么**不能**改成「未验证的条目干脆不声明窗口」
 *
 * 这看起来更保守，实际更危险。本机实测 `dsh-compaction-basic`（DSH 0.2.0-rc.3）：
 *
 * ```
 * if (info.context === void 0)
 *   throw new TargetPressureConfigError(targetKey, `…; configure contextWindow on that adapter model`)
 * ```
 *
 * 而该异常在 `agent/pre-step` 被**吞成一条 warn**（`step compaction failed: …;
 * continuing the turn`，且同一目标只警告一次）⇒ **自动压缩从此永久静默失效**。
 *
 * 两者的可观测性差一个量级：**虚高**至少在越墙时留下「0 输出 + `max-tokens`」的
 * 现场；**不声明**则连压缩都不触发，用户与日志两边都零信息 —— 正是
 * `opencode-context-window.spec.ts`（issue IKJJ68）记录的同款症状。
 * ⇒ 有独立证据的条目写**真实值**，没有证据的**保留远端声明**，绝不改成不声明。
 */
export const LOOMY_CONTEXT_WINDOW_OVERRIDES: Readonly<Record<string, number>> = {
  // 远端虚报 1048576，官方客户端本地表与上游墙位都是 262144（见上）。
  // ⚠️ 键必须**小写**：查表经 `loomyCatalogKey()` 归一，混入大写键会恒不命中。
  'spark-x': 262_144,
}

/**
 * 模型 id 的**归一化查表键**：本家两张能力覆盖表唯一的查表口径。
 *
 * ## 为什么需要（2026-10-14 审计发现）
 *
 * 覆盖表原先用 `Set.has(modelId)` / `OVER[modelId]` 做**逐字节精确匹配**，而
 * 同一文件里读远端模态的 `readInputModalities()` 却把值 `.toLowerCase()` 归一了
 * ⇒ **同一个「模型身份」概念在相邻两处用了两套归一标准**。
 *
 * 后果是**静默失效**：一旦上游把 id 改成 `Qwen-3.8-Max` 或前后带空白，
 * 覆盖表恒不命中 ⇒ `inputModalities` 退回 `['text']` ⇒ DSH 附件准入闸门
 * （`MODEL_DOES_NOT_SUPPORT_IMAGES`）重新拒图，**用户看到的就是本次修复前的
 * 症状原样复现**，而全程不抛异常、不打日志、测试全绿。
 *（本仓库有同型前科：`docs/agent-notes/providers-zcode.md` 的
 * 「上游小写 vs 目录大写」。）
 *
 * ## ⚠️ 一个已权衡的取舍（如实登记，别当它不存在）
 *
 * 归一化后，**仅大小写不同的两个 id 会折叠成同一个键**。若上游真的同时上架
 * `spark-x` 与 `Spark-X` 两个不同模型、且只有一个能读图，本函数会把图也放给
 * 另一个（上游回一个更晚、更难懂的 400 —— 正是覆盖表注释警告的那种代价）。
 * 判定为**可接受**，理由：① 远端现有 8 条 chat 模型 id 两两不同、且本就混用
 * 大小写（`MiniMax-M3` / `spark-x`），说明上游按 id 区分模型而非按大小写；
 * ② 「仅大小写不同」的模型目录会让 DSH 自身的选择器也无法区分，属病态输入；
 * ③ 反向的代价（不归一 ⇒ 静默拒图）**已经真实发生过一次**。
 *
 * ## ⚠️ 只用于查表，**绝不改对外 id**
 *
 * `model.id` 同时是 `fallbackIndex`（`loomy-adapter.ts`）与 `effortsForModel`
 * 的索引键，也是 DSH 选择模型时用的身份。归一化只发生在**查表那一刻**，
 * 对外播报的 id 逐字节不变 —— 否则会重演 accio「改对外 id ⇒ 聚合补丁索引
 * 恒不命中」那类**静默**连带失效。
 *
 * @param modelId 待查的模型 id（远端原值或兜底表值）。
 * @returns 小写、去首尾空白的查表键。
 */
function loomyCatalogKey(modelId: string): string {
  return modelId.trim().toLowerCase()
}

/**
 * 取一个模型的**真实**上下文窗口。
 *
 * 覆盖表优先于远端，原因见 {@link LOOMY_CONTEXT_WINDOW_OVERRIDES}。
 * ⚠️ 远端与兜底表**两条路径都必须过这里** —— 只改兜底表无效（远端可用时
 * 走的是远端值），这是个曾经差点踩空的点。
 * ⚠️ 查表走 {@link loomyCatalogKey}（大小写/空白不敏感），理由见该函数。
 *
 * @param modelId 模型 id。
 * @param declared 声明值（远端 `context_length` 或兜底表的值）。
 * @returns 覆盖值（若有），否则原样返回 `declared`。
 */
export function loomyContextWindow(modelId: string, declared: number): number {
  return LOOMY_CONTEXT_WINDOW_OVERRIDES[loomyCatalogKey(modelId)] ?? declared
}

/**
 * 远端声明为**纯文本**、但实测**能读图**的模型（`input_modalities` 漏报）。
 *
 * ## 为什么需要（真实缺陷，2026-10-14 用户报障）
 *
 * 用户报障「loomy 的模型输入不能上图？尤其是 qwen3.8max」。根因与 raccoon 那起
 * （`tags.vision` 不是能力契约，见 `RACCOON_TEXT_ONLY_MODELS`）**同型**，
 * 只是这次的「元数据」是 `input_modalities` 而不是 `tags`：
 *
 * 1. 远端 `GET /api/v1/models` 对 `qwen-3.8-max` 下发
 *    `capabilities.input_modalities = ['text']`（`vision: false`）；
 * 2. 适配器原样直译 ⇒ `supportsImage: false` ⇒ `toCatalogEntry` 播报
 *    `inputModalities: ['text']`；
 * 3. DSH 按它做准入（`dsh-api-session-controller` 的
 *    `MODEL_DOES_NOT_SUPPORT_IMAGES`）与投影 ⇒ **图片根本发不出去**，
 *    用户看到的是「当前模型不支持图片，请切换支持图片的模型」。
 *
 * ### 硬证据（2026-10-14，真实凭据直连生产端点）
 *
 * 判据是**随机纯色 PNG**（纯标准库生成，64×64，约 137 B）：纯文本模型答不出颜色，
 * 读得到的模型答得出。`qwen-3.8-max` 两轮合计 **4/5 次答对**：
 *
 * | 判据 | 目标 | 模型回答 |
 * |---|---|---|
 * | 颜色名 | 紫 (150,40,200) | 「紫色」 |
 * | 颜色名 | 蓝 (40,70,220) | 「蓝色」 |
 * | RGB 三元组 | (144,127,136) | `142,132,140` |
 * | RGB 三元组 | (197,197,174) | `180,186,169` |
 * | RGB 三元组 | (129,204,71) | HTTP 504（上游网关超时，不计） |
 *
 * ### 同批实测的对照（一次一色，同一账号）
 *
 * | 模型 | 远端 `input_modalities` | 实测读图 | 备注 |
 * |---|---|---|---|
 * | `DeepSeek-V4.1-Flash` | text,image | ✅ | |
 * | `Kimi-k2.6` | text,image,video | ✅ | |
 * | `qwen3.8-flash` | text,image,video | ✅ | |
 * | `mimo-v2.5` | text,audio,image,video | ✅ | |
 * | `GLM-5.3-Flash` | text,image,video | ⚠️ | 颜色名答错一次；RGB 3 次中 2 次命中 |
 * | **`qwen-3.8-max`** | **text（漏报）** | ✅ | **本表要修的就是它** |
 * | `MiniMax-M3` | text,image,video | ❌ | 4/4 未命中；答案像经典 CSS 色值（`135,206,235`…）⇒ 疑似在编 |
 * | `deepseek-v4-flash-0731` | text | ❌ | 思考链吃满预算，正文为空 |
 * | `spark-x` | text | ❌ | 自称「我无法读取图片」 |
 * | `auto` | 无声明 | ❌ | 未定论（思考吃满 / 答「灰」） |
 *
 * ⚠️ **`MiniMax-M3` 的疑似假声明（声明 image、实测读不出）本次刻意不动**：
 * 用户 2026-10-14 明确「我主要关心 loomy 的 qwen3.8max」，且**降级**一个已声明的
 * 能力会改变既有可用路径 —— raccoon 的 `sn-glm-5-3` 就有「网关节点不一致、
 * 3 次只对 1 次」的先例 ⇒ 单账号证据不足以判死。它按**已知 provider 缺陷**
 * 记录在案，待多节点复核后再决定。
 *
 * ⚠️ **不要改成「该家恒支持图片」**：白名单只覆盖**实测确认**的个案。将来上架
 * 纯文本模型时恒 true 会把图放行，让上游回一个更难懂的 400（错误更晚、更难查）。
 *
 * ⚠️ 表内条目必须**小写**：查表经 `loomyCatalogKey()` 归一，混入大写条目会恒不命中。
 */
export const LOOMY_IMAGE_CAPABILITY_OVERRIDES: ReadonlySet<string> = new Set([
  'qwen-3.8-max',
])

/**
 * 取一个模型的**真实**图片能力。
 *
 * ⚠️ 远端与兜底表**两条路径都必须过这里** —— 与 {@link loomyContextWindow}
 * 同一条纪律：只改一侧，远端可用时那一侧就白改了（`contextWindow` 曾差点踩空）。
 * ⚠️ 与 raccoon 的**两个真相源**（兜底表 `supportsImage` + 远端判定函数）不同，
 * 本家只有一个真相源（本函数）——兜底表的 `supportsImage` 恒由 `false` 起算，
 * 故不存在「兜底表与远端判定分叉」的形态。
 * ⚠️ 查表走 {@link loomyCatalogKey}（大小写/空白不敏感），与
 * {@link loomyContextWindow} 同一口径 —— 两张覆盖表若口径不同，
 * 「同一条纪律」这句话本身就是假的（2026-10-14 审计发现）。
 *
 * @param modelId 模型 id。
 * @param declared 远端 `input_modalities` 是否含 `image`（兜底表一律传 `false`）。
 * @returns 覆盖值（若有），否则原样返回 `declared`。
 */
export function loomySupportsImage(modelId: string, declared: boolean): boolean {
  return LOOMY_IMAGE_CAPABILITY_OVERRIDES.has(loomyCatalogKey(modelId)) || declared
}

const LOOMY_FALLBACK_MODELS: readonly LoomyFallbackModel[] = [
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731 · x3.0', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  // ⚠️ 2026-11-06 新增：远端目录已上架该模型，而兜底表此前**没有**它 ⇒ 远端抓取失败时
  // 它会走「目录外 id」分支，**既不声明 reasoning 也不声明 context** ⇒ 用户持久化的
  // `xhigh` 被 `dsh-llm` 硬抛 `UNSUPPORTED_REASONING_EFFORT`（整轮失败，不发一个 token），
  // 同时自动压缩静默失效（`no context capacity`）。详见
  // `docs/agent-notes/providers-loomy-raccoon-minimax.md` 的「兜底表漂移」一节。
  // 值取自 2026-11-06 生产端点实测：`context_length: 1048576`、倍率 `x2.0`、
  // 档位与其余 chat 模型**完全一致**（`['none','low','medium','high','xhigh']`）。
  { id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash · x2.0', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'MiniMax-M3', name: 'MiniMax M3 · x4.0', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'Kimi-k2.6', name: 'Kimi k2.6 · x6.5', contextWindow: 262_144, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'qwen-3.8-max', name: 'Qwen 3.8 Max · x12.0', contextWindow: 1_000_000, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash · x0.8', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'qwen3.8-flash', name: 'qwen 3.8 flash · x0.8', contextWindow: 1_000_000, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'spark-x', name: 'Spark X2.5 · x0.1', contextWindow: 262_144, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'mimo-v2.5', name: 'MiMo V2.5 · x3.3', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
]

/**
 * Loomy provider 配置。
 */
export const LOOMY: LoomyProduct = {
  id: 'loomy',
  displayName: 'Loomy (讯飞)',
  apiBase: LOOMY_API_BASE,
  accountBase: LOOMY_ACCOUNT_BASE,
  // 取自 `.env.prod`（VITE_XFYUN_ACCESS_KEY_ID / _SECRET / _APP_ID）。
  accessKeyId: '2thryby66wxi53sk',
  accessKeySecret: 'zsak6eadrbawz683wf5r3m2snrwj868r',
  appId: 'GM3LOOMY',
  defaultCredentialRef: 'LOOMY_ACCESS_TOKEN',
  fallbackModels: LOOMY_FALLBACK_MODELS,
}

/** 全部 Loomy 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_LOOMY_PRODUCTS: readonly LoomyProduct[] = [LOOMY]

/**
 * 按 provider id 取 Loomy 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `lobsteraiProductById` 等分开：
 * 各自返回**不同类型**，合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function loomyProductById(id: string): LoomyProduct | undefined {
  return ALL_LOOMY_PRODUCTS.find((product) => product.id === id)
}
