/**
 * AStudio（讯飞 AstronStudio 桌面端）provider 的产品配置 —— **唯一真相源**。
 *
 * ## 协议速览（2026-10-15 首测；推理基址 2026-11-07 迁移后复测，详见 `docs/agent-notes/providers-astudio.md`）
 *
 * | 用途 | 方法 | 地址 | 认证 |
 * |---|---|---|---|
 * | 对话 | POST | `https://maas-api.cn-huabei-1.xf-yun.com/v1/chat/completions` | `Authorization: Bearer <modelBearerToken>` |
 * | 模型目录 | GET | `https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager/models` | 同上 |
 * | 活体凭据（权威源） | GET | `https://agent.xfyun.cn/xingchen-studio/bot/models/configs` | `Cookie` 四字段串 |
 *
 * 三条与其余 provider 不同的**结构性事实**（都不是从代码推出来的，必须实测才知道）：
 *
 * 1. **两个基址不同域**：推理在 `maas-api.cn-huabei-1.xf-yun.com/v1`，目录在
 *    `astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager`。
 *    ⚠️ 2026-11-07 起旧的推理前缀 `astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1`
 *    整段下线：任何路径（含 `/chat/completions`）都回
 *    **HTTP 404 `{"error":{"message":"API endpoint not found","type":"not_found_error"}}`**；
 *    同一 token 打目录仍 200（证明不是鉴权失效），打新基址 200 且正常出流。
 *    网关迁移时不会发公告，故该常量必须能随实测更新（`ASTUDIO_MAAS_BASE_URL`）。
 *    ⚠️ 目录基址**没有** `/v1/models`（新推理基址的 `/v1/models` 是 405 `method not allowed`）——
 *    按「OpenAI 兼容网关必有 `/v1/models`」的直觉去拼会一路 404/405。
 * 2. **推理端点的 `model` 只认裸 slug**：本地回环网关（`127.0.0.1:4605/v1/models`）
 *    把每个模型下发**两份**（`builtin/<base64url(裸 slug)>` 为 `visibility:list`、
 *    裸 slug 为 `hide` 别名），那是 acode 内核的**内部路由标识**；而上游推理端点
 *    只认裸 slug —— 实测发 `builtin/eG9wZHN2NGZsYXNoMDczMWlu` 回
 *    **HTTP 502** `{"error":{"code":"model_not_found","message":"no category route found"}}`，
 *    发 `xopdsv4flash0731in` 正常 200。⇒ 本 provider 不复刻 `builtin/` 前缀。
 * 3. **失败有两种信封形态**（都要判，见 `astudio.ts`）：
 *    目录/账号面是 `{code, message, data}`（**HTTP 仍是 200**，`code !== 0` 即失败）；
 *    推理面是 OpenAI 裸体，失败时 `{"error":{code,message,type}}` 配非 2xx。
 *
 * ## 客户端形态（决定了本 provider 的「登录」与众不同）
 *
 * AStudio 是 Electron 桌面端（AUMID `cn.xfyun.acode`，产品版本 3.5.2），登录方式是
 * **微信扫码**，会话以**明文**落在 `<安装数据目录>\userdata\astron-session.json`。
 * 授权页与回调都在**客户端自己**手里（我们无从走完），所以 `astudio-oauth.ts` 做的是
 * **导入本机既有会话**，而不是再造一套 PKCE —— 造了也没有能走完它的授权端点。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 兜底模型条目（远端目录是动态拉取的，本表只作**离线回退**）。
 *
 * ⚠️ 逐字段来自 2026-10-15 `GET /api/v1/model-manager/models` 的真实返回，不是推测：
 * `contextWindow` ← `context_window`，`maxTokens` ← `max_output_tokens`，
 * `efforts` ← `supported_reasoning_levels[].effort`，`defaultEffort` ← `default_reasoning_level`。
 */
export interface AstudioFallbackModel {
  /**
   * **裸 slug**（上游 `model` 字段唯一认得的形态，见模块头第 2 条）。
   *
   * ⚠️ 绝不能填 `builtin/<base64>` 形态 —— 那是 acode 内核的内部别名，
   * 直接发给上游推理端点会 502 `model_not_found`，而症状是「模型不回复」
   * 这类最容易误导人的形态（与 accio「上行必须用 `modelCode`」同型的坑）。
   */
  id: string
  /** 展示名（远端 `display_name` 原值）。 */
  name: string
  contextWindow: number
  maxTokens?: number
  /** 远端 `supported_reasoning_levels[].effort`，**原样保留下发顺序**。 */
  efforts?: readonly string[]
  /** 远端 `default_reasoning_level`。 */
  defaultEffort?: string
  /**
   * 是否参与**思考能力**声明之外的图片输入。实测远端 `input_modalities`
   * 六个模型**全部是 `['text']`**（无一个声明 image）。
   *
   * ⚠️ 本字段是「远端自己声明的」，**不是我们实测图片通路的结果**（图片一次都没
   * 真机验过）⇒ 目录里据此写 `['text']`（= 明确不支持，DSH 在附件准入阶段就拒），
   * 并在 `docs/agent-notes/providers-astudio.md` 标 **TBD**：若将来实测某模型收图，
   * 改的是**判据**（继续以远端 `input_modalities` 为准），不是加白名单。
   */
  supportsImage?: boolean
}

export interface AstudioProduct {
  /** provider 标识（⚠️ 纯小写字母、不带连字符：同时是 cordis 服务名 / LLM 路由名 / 客户端 key）。 */
  id: 'astudio'
  displayName: string
  /** 推理网关基址（OpenAI 兼容）。 */
  maasBaseUrl: string
  /** 对话端点路径（接在 `maasBaseUrl` 之后）。 */
  chatPath: string
  /** 模型目录基址（与推理网关**同域不同前缀**，见模块头第 1 条）。 */
  catalogBaseUrl: string
  /** 模型目录路径。 */
  catalogPath: string
  /** 账号后端基址（活体凭据的权威源在这里）。 */
  authBaseUrl: string
  /** 活体凭据端点路径（GET，Cookie 鉴权，无请求体）。 */
  apiKeyConfigPath: string
  /**
   * **显式**的会话文件路径（缺省 `undefined` ⇒ 由 `astudioSessionFilePath()`
   * 按当前用户的 `%LOCALAPPDATA%` 推导）。
   *
   * ⚠️⚠️ **不得在这里写死某台机器的绝对路径**（2026-10-18 审计 P1）：那会让除该机
   * 外**所有**用户的「一键导入本机凭据」永久失败，且报错文案把用户引向一个不存在
   * 的动作（详见 `defaultAstudioSessionFilePath` 的说明）。
   *
   * ⚠️ 覆盖链优先级：env `DSH_ASTUDIO_SESSION_FILE` > 本字段 > 按传入 env 推导
   * （与 `DSH_JET_HUB_STATE_DIR` / `DSH_OFFICEACE_HOME` 同一先例 —— 单测必须
   * 能把它指到 fixture，否则会**读到用户真实凭据**并发出真实请求）。
   */
  sessionFilePath?: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /**
   * 客户端自报类型：`21` = win32、`22` = darwin（实测取自客户端请求头）。
   *
   * ⚠️ 实测**不带也能 200**；带上是为了与真实客户端形状一致。
   * 但**不能按当前 OS 去猜**：磁盘上那份会话是 win32 登录的，把 `clientType`
   * 换成 `22` 属于伪造客户端形态，收益为零、风险未知 ⇒ 固定 21。
   */
  clientType: string
  /** 客户端自报产品版本（同上，可选头）。 */
  studioVersion: string
  /** 控制面（目录 / 凭据）请求超时（毫秒）；对话流不适用。 */
  requestTimeoutMs: number
  /** 等待响应头的超时（毫秒）。 */
  chatHeaderTimeoutMs: number
  /** SSE 空闲超时（毫秒）：两次字节之间的上限。 */
  chunkTimeoutMs: number
  fallbackModels: readonly AstudioFallbackModel[]
}

// ── 端点路径 ────────────────────────────────────────────────────────────
export const ASTUDIO_CHAT_PATH = '/chat/completions'
export const ASTUDIO_CATALOG_PATH = '/api/v1/model-manager/models'
export const ASTUDIO_API_KEY_CONFIG_PATH = '/bot/models/configs'

/**
 * 推理网关基址（OpenAI 兼容）。
 *
 * ⚠️ **2026-11-07 真机复测：旧基址已整段下线。**
 * `https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1` 下任何路径
 * （含 `/chat/completions`）都回 HTTP 404 `API endpoint not found`；同一 token
 * 打模型目录仍 200，说明不是鉴权失效而是网关搬迁。AStudio 客户端 3.4.4+ 的
 * 推理基址即本值（与 AStudio2API 从客户端 bundle 提取的默认值一致）。
 */
export const ASTUDIO_MAAS_BASE_URL = 'https://maas-api.cn-huabei-1.xf-yun.com/v1'

/** 凭据文件路径的环境变量覆盖（单测/非默认安装位置用）。 */
export const ASTUDIO_SESSION_FILE_ENV = 'DSH_ASTUDIO_SESSION_FILE'

/**
 * 会话失效的业务码（语义：需要**人工重新登录**，静默重试无意义）。
 *
 * ⚠️ 只登记**实测见过**的三个：`1002` / `1005` / `80000`。其余非 0 码一律走
 * 「可重试」，不要在这里顺手加码 —— 加错会把一次瞬时故障固化成「账号已死」
 * （本仓库 codearts 有过同型的「单向门」事故）。
 *
 * ⚠️ `80000` 是**实测的账号后端会话失效形态**：HTTP **恒 200** +
 * `{code:80000, desc:"登录异常，请重新登录"}`（fact 402/403，两个额度端点与
 * `bot/models/configs` 都是这个形状）。它原先**不在**本集合里，后果链是
 * `parseAstudioEnvelope.sessionDead=false` → `extractAstudioApiKey.terminal=false`
 * → `refreshOnce` 的终态判定**只剩**「服务端中文文案命中正则」这一条兜底：
 * 文案一改，一次真失效就从「终态、停调度」退化成「可重试、每 30 分钟白撞一次」。
 * 客户端自己的 `isAuthoritativeModelCredentialFailure` 集合只含 {401,403,1002,1005}
 * 同样不含 80000 ⇒ 这是**客户端的真实缺陷**，我们这边必须按码值判，不能跟着漏。
 *
 * ⚠️ 与「换凭据触发条件」区分开：客户端侧实测**只有上游 HTTP 401** 才会重取
 * `modelBearerToken`（见 `astudio-auth.ts` 模块头），流内 `code` 不参与凭据轮换。
 * 本集合回答的是另一个问题：「重取之后仍然失败 ⇒ 是不是该报『请重新登录』」。
 */
export const ASTUDIO_SESSION_DEAD_CODES: ReadonlySet<number> = Object.freeze(new Set([1002, 1005, 80000]))

/**
 * 兜底模型表 —— **2026-10-15 实测上游目录里的全部 6 个模型**。
 *
 * ⚠️ 任务描述要求的 `glm5.3flash` **在本账号目录里不存在**（对全量 JSON 搜
 * `glm5.3` / `5.3flash` 零命中，`flash` 只命中 `DeepSeek-V4-Flash`）。最接近的
 * GLM 同族是 `GLM-5.2`（slug `xopglm52`）⇒ 端到端验证以它交付，并写明差异。
 * 这里**不编造**一个 `glm5.3flash` 条目：目录里放一个上游不认的 slug，症状是
 * 用户选中后 502 `model_not_found`，比「列表里没有它」糟糕得多。
 */
const ASTUDIO_FALLBACK_MODELS: readonly AstudioFallbackModel[] = Object.freeze([
  {
    id: 'xopglm52',
    name: 'GLM-5.2',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    efforts: ['none', 'high', 'max'],
    defaultEffort: 'high',
    supportsImage: false,
  },
  {
    id: 'astronclaw-auto',
    name: 'Auto',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    efforts: ['none', 'high'],
    defaultEffort: 'high',
    supportsImage: false,
  },
  {
    id: 'xopdsv4flash0731in',
    name: 'DeepSeek-V4-Flash',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    efforts: ['none', 'high', 'max'],
    defaultEffort: 'high',
    supportsImage: false,
  },
  {
    id: 'xopdeepseekv4pro0813',
    name: 'DeepSeek-V4-Pro',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    efforts: ['none', 'high', 'max'],
    defaultEffort: 'high',
    supportsImage: false,
  },
  {
    id: 'spark-x2.5',
    name: 'Spark-X2.5',
    contextWindow: 262_144,
    maxTokens: 256_000,
    efforts: ['none', 'high'],
    defaultEffort: 'high',
    supportsImage: false,
  },
  {
    id: 'spark-x2.6-preview',
    name: 'Spark-X2.6-Preview',
    contextWindow: 262_144,
    maxTokens: 256_000,
    efforts: ['none', 'high'],
    defaultEffort: 'high',
    supportsImage: false,
  },
])

/**
 * 桌面端明文凭据文件的**默认路径**（按当前用户推导）。
 *
 * ⚠️⚠️ **必须是推导值，不得写字面量绝对路径**（2026-10-18 审计 P1）。
 *
 * 原实现硬编码了开发机的
 * `E:\Users\<某人>\AppData\Local\Programs\AStudio Data\userdata\astron-session.json`，
 * 后果链是**静默且误导**的：
 * - 客户端的默认登录档就是「⚡ 一键导入本机桌面端凭据」（`jet-hub.js` 的
 *   `useState('local')`、`new-account.js` 的 `astudioLoginMethod ?? 'local'`）
 *   ⇒ 除该开发机外**所有**用户点这个按钮都必然失败；
 * - 而失败文案写「请先启动 AStudio 客户端并登录」（`astudio-auth.ts`）——
 *   用户的客户端**本来就登录着**，照做**永远不会成功**，因为代码查的是别人机器上
 *   的路径 ⇒ 文案把用户引向一个不存在的动作，且不提示唯一的自救手段
 *   （`DSH_ASTUDIO_SESSION_FILE`）。
 *
 * 同型先例（照抄其口径）：`src/chromium-session.ts` 用 `env.LOCALAPPDATA` 拼
 * Chrome 安装路径；`src/zcode.ts` 同法登记 `%LOCALAPPDATA%\Programs\ZCode\…`。
 *
 * ⚠️ 非 Windows 或 `LOCALAPPDATA` 缺失时回落到 `<homedir>/AppData/Local`：
 * AStudio 是 Windows Electron 桌面端（AUMID `cn.xfyun.acode`），该回落只为了让
 * 单测 / CI 拿到一个**可预期**的路径，不代表本家支持别的平台。
 */
export function defaultAstudioSessionFilePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const localAppData = (env['LOCALAPPDATA'] ?? '').trim()
  const base = localAppData.length > 0 ? localAppData : join(homedir(), 'AppData', 'Local')
  return join(base, 'Programs', 'AStudio Data', 'userdata', 'astron-session.json')
}

export const ASTUDIO: AstudioProduct = {
  id: 'astudio',
  // ⚠️ 与客户端 `PROVIDERS` 里的 label 逐字一致（rail 宽度算式依赖它）。
  displayName: 'AStudio',
  maasBaseUrl: ASTUDIO_MAAS_BASE_URL,
  chatPath: ASTUDIO_CHAT_PATH,
  catalogBaseUrl: 'https://astronstudio-api-volces-prod.xf-yun.com',
  catalogPath: ASTUDIO_CATALOG_PATH,
  authBaseUrl: 'https://agent.xfyun.cn/xingchen-studio',
  apiKeyConfigPath: ASTUDIO_API_KEY_CONFIG_PATH,
  defaultCredentialRef: 'ASTUDIO_ACCESS_TOKEN',
  clientType: '21',
  studioVersion: '3.5.2',
  requestTimeoutMs: 30_000,
  chatHeaderTimeoutMs: 60_000,
  // ⚠️ **必须 ≥300s**：长上下文模型的两次 SSE 字节之间实测可静默 >45s，
  // 而官方内核自己用的就是 `stream_idle_timeout_ms=300000`。120s 会把一次
  // 正常但慢的长思考**掐成** `TIMEOUT`（且 harness 会重试 ⇒ 双倍计费）。
  chunkTimeoutMs: 300_000,
  fallbackModels: ASTUDIO_FALLBACK_MODELS,
}
