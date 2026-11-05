/**
 * ZCode 上游 HTTP 客户端（额度 / 签到 / 模型目录）。
 *
 * ## 这一层与其它 provider 的差异
 *
 * 其它 provider 的「额度 / 签到」是各家私有协议；ZCode 这套的**特点**是
 * 同一组请求头要在三处复用，且**鉴权要求按端点不同**（实测）：
 *
 * | 端点 | 需要 `Authorization: Bearer <jwt>` | 需要 `X-Device-Mid` |
 * |---|---|---|
 * | `GET /zcode-plan/billing/balance` | **是**（缺则 401） | **是**（缺则 400 code 3001） |
 * | `GET /zcode-plan/billing/preview` | 否 | 是 |
 * | `POST /api/v1/event/report` | 否 | 是 |
 * | `POST /zcode-plan/billing/claim` | **是** | 是（另需 captcha 头） |
 * | `GET /api/v1/client/configs` | **是** | 是 |
 *
 * ⚠ 这两条都踩过：不带 `Authorization` 查额度得 **401**；
 * 不带 `X-Device-Mid` 得 **400 `{"code":3001,"msg":"parameter error"}`**。
 *
 * ## 签到为什么要「补激活上报」
 *
 * 服务端**不会主动推送**活动。`preview` 的内容依赖**客户端活跃信号**：
 *
 * ```
 * 补 POST /api/v1/event/report {app_launch, app_daily_active} 之前：
 *   preview → {"code":0,"data":{"plans":[]}}          ← 空
 * 补之后：
 *   preview → {"code":0,"data":{"plans":[{plan_id:"zcode-v3-start-plan-trust-…"}]}}
 * ```
 *
 * **⇒ 「每日随机派发」不是随机推送，而是「服务端按活跃信号决定要不要给」。**
 * 所以要领额度必须**先补两条事件**，再查 preview，再 claim。
 */

import { randomUUID } from 'node:crypto'
import { release as osRelease } from 'node:os'

import type { ZcodeCredential } from './zcode.js'
import { ZCODE_APP_VERSION_FALLBACK } from './zcode.js'
import {
  extractZcodeLogId,
  formatZcodeEdgePageHint,
  hasZcodeUnusualActivity,
  looksLikeZcodeHtmlPage,
  parseZcodeBusinessCode,
} from './zcode-diagnostics.js'
import type { ZcodeRemoteModelLike } from './zcode-product.js'
/**
 * ⚠ **只取类型**：`zcode-captcha.ts` 反过来不 import 本文件，故无循环。
 * 用 `import type` 是为了在编译后**不产生运行时依赖** —— captcha 那侧会拉起
 * `chromium-session.js`（含 `node:child_process`），而本文件的调用方里有
 * 只需要「读配置」的纯网络路径。
 */
import type { ZcodeCaptchaConfig } from './zcode-captcha.js'

/** ZCode 平台 origin（官方默认）。 */
export const ZCODE_ORIGIN = 'https://zcode.z.ai'

/** 免费额度通道的 Anthropic 端点。 */
export const ZCODE_PLAN_MESSAGES_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`

/**
 * 按通道返回「Messages」端点。
 *
 * ⚠ **积分制（`start-plan`）无论账号是 bigmodel 还是 zai，都走 `zcode.z.ai`**
 * —— 官方分派表（`resources/config/provider/zcode-builtin.json`）的规则 2/5
 * 明确如此，2026-10-03 实测复核。**不要**因为账号是国际版就改域名。
 *
 * ⚠ 订阅制（`coding-plan`）才走 `api.z.ai`（官方规则 0/1，2026-10-03 实测
 * `GET https://api.z.ai/api/anthropic/v1/models` 返回 200 + 11 个模型）。
 */
export function zcodeMessagesUrl(channel: 'start-plan' | 'coding-plan'): string {
  if (channel === 'coding-plan') return 'https://api.z.ai/api/anthropic/v1/messages'
  return ZCODE_PLAN_MESSAGES_URL
}

/** 额度余额端点（**需要 Authorization**）。 */
export const ZCODE_BILLING_BALANCE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance`

/** 可领活动预览端点（**不需要 Authorization**）。 */
export const ZCODE_BILLING_PREVIEW_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/preview`

/** 领取端点（**需要 Authorization + captcha**）。 */
export const ZCODE_BILLING_CLAIM_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/claim`

/** 客户端活跃上报端点（**不需要 Authorization**）。 */
export const ZCODE_EVENT_REPORT_URL = `${ZCODE_ORIGIN}/api/v1/event/report`

/** 客户端配置端点（captcha 配置与模型池都从这里来）。 */
export const ZCODE_CLIENT_CONFIGS_URL = `${ZCODE_ORIGIN}/api/v1/client/configs`

/**
 * 营销投放查询端点（**只读**）。
 *
 * ## 来源（逆向官方 `app.asar` 实证，2026-10-23）
 *
 * 官方 Electron 产物的 `createMarketingTouchService`（scoop 安装版
 * `resources/app.asar` → `out/host/index.js`）：
 *
 * ```js
 * GET  /api/v1/marketing/touch?seq=<n>          // 查投放（deliveries[]）
 * POST /api/v1/marketing/touch/action           // 回执 {campaign_id, action_type}
 * ```
 *
 * 请求头只有四个：`X-Device-Mid` / `X-Client-Language` /
 * `X-ZCode-App-Version` /（可选）`Authorization`。
 */
export const ZCODE_MARKETING_TOUCH_URL = `${ZCODE_ORIGIN}/api/v1/marketing/touch`

/** 营销动作回执端点（`action_type` 实测只有 `confirm` / `cancel`）。 */
export const ZCODE_MARKETING_ACTION_URL = `${ZCODE_ORIGIN}/api/v1/marketing/touch/action`

/**
 * ★★ **受版本门控的功能**所需的**最低客户端版本**（实测，2026-10-23）。
 *
 * ## 门控在**两个端点上都成立**（两条独立实测）
 *
 * ### ① 营销投放（同一账号、同一套头，**只改这一个头**）
 *
 * | `X-ZCode-App-Version` | `GET /marketing/touch` 的 `data.deliveries` |
 * |---|---|
 * | `3.14.3`（本插件此前写入凭据的版本） | **`[]`（空）** |
 * | `3.16.3`（用户装的官方版） | `[{campaign_id:"2113475573403824128", …}]` |
 *
 * ### ② **领取**（`POST /zcode-plan/billing/claim`，2026-10-23 真机一发定音）
 *
 * | `X-ZCode-App-Version`（**其余头完全相同**） | claim 返回 |
 * |---|---|
 * | `3.14.3` | **`400 / code 1004 "no permission"`**（官方文案 `manualClaimPlan.claim.failure.ineligible` = 「当前账号或**客户端版本**不满足领取条件」） |
 * | `3.16.2` | **`200 / code 0`** + `data.plan.{user_plan_id, status:"active", entitlements:[3 亿 + 2 亿]}` ★ |
 *
 * ⇒ 只抬营销请求的版本**不够**：`1004` 会让「拿到了活动却领不到」，
 *   而它**看起来像账号没资格**（极具误导性）。两个端点必须**同抬**。
 *
 * ⚠ 官方客户端的 claim 也报自己的版本（`app.asar` → `out/host/index.js` 的
 *   `claimManualPlan`：`'X-ZCode-App-Version': Ir`；本机 `Ir` 即客户端版本
 *   `3.16.2`，同文件 `var Vu="3.16.2"`）⇒ **我们报 3.14.3 才是那个异类**。
 *
 * ⚠ **只对这两条门控路径覆盖版本**（`zcodeVersionGatedAppVersion()`），
 *   不改凭据里的 `app_version`、也**不**全局抬 `ZCODE_APP_VERSION_FALLBACK`：
 *   推理路径的既有实测结论（含 `3012` 的消融矩阵）都是在 3.14.3 上取到的，
 *   无证据地整体抬版本会把这些结论一起作废。
 *
 * ⚠ **下限逐期漂移，不是固定值**（2026-11-03 实测，用户报障「怎么领不到了」）：
 *   同一账号、同一套头，**只改** `X-ZCode-App-Version`，间隔 3 秒避 429：
 *
 *   | `X-ZCode-App-Version` | `GET /marketing/touch` 的 `data.deliveries` |
 *   |---|---|
 *   | `3.14.3` / `3.15.0` / `3.16.0` / **`3.16.3`** / `3.17.0` | **`[]`（空）** |
 *   | **`3.17.1`** | `[{… plan_id:"zcode-v3-start-plan-1103", grant_units:300000000 …}]` ★ |
 *
 *   ⇒ 1024 那期（2026-10-23）在 `3.16.3` 能拿到；1103 这期（ZCODE GLOBAL BUILD）
 *   把门槛抬到了 `3.17.1` —— 服务端是**按活动**下发门控的，定值必然腐坏。
 *   **下期若再抬，这里要重新二分**（别当成一次性结论）。
 */
export const ZCODE_VERSION_GATED_MIN_APP_VERSION = '3.17.1'

/**
 * **推理路径**的版本下限（与营销/领取的逐期门控**分开**）。
 *
 * ⚠️ 为什么不能共用：`buildZcodeHeaders` 的默认值同时服务推理请求
 * （`zcode-transport.ts` 的 `buildChannelRequest`），而推理路径的 405
 * `unusual activity` 结论是在 **3.16.3** 上验收的（2026-10-25 真机）。
 * 营销/领取的门控逐期漂移（1103 期已到 3.17.1），无证据地把推理头一起抬
 * 会把那条验收作废。
 */
export const ZCODE_INFERENCE_MIN_APP_VERSION = '3.16.3'

/**
 * 合法的客户端版本号形态（`major.minor.patch`，纯数字、**无前导零**）。
 *
 * ⚠ 它**是安全闸，不只是格式偏好**（2026-10-25 审计实测）：`app_version` 会原样
 * 进 `User-Agent` / `X-ZCode-App-Version` / **URL 的 query**。`Headers()` 对非法
 * 头值抛 `TypeError`（`"3.16.3\r\nX-Injected: 1"` 实测如此）⇒ 一份脏凭据（手改
 * 备份导入）能把整个 zcode 请求打成未分类错误；而 `'3.16.3-beta.1'` / `'3.016.3'`
 * 会被 `compareZcodeAppVersion` 当成「更大 / 等值」⇒ **绕过**门控。
 *
 * ⚠ 前导零也算脏：`3.016.3` 数值上等于 `3.16.3`，但不是官方会发出的形态。
 */
const ZCODE_APP_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

/**
 * 「每个账号一个、进程内稳定」的伪会话 id。
 *
 * ⚠ 官方每个会话一个 uuid（抓包实测 `x-session-id: df5db422-…`，同会话内恒定）。
 * 插件没有「会话」这一层，故退而求其次：**每个账号（`device_mid`）一个**、
 * 请求间复用 —— 比每请求换新更接近真实客户端。
 *
 * ⚠⚠ **不能做成 `randomUUID()` 的模块级常量**（2026-10-25 审计打穿）：
 * 那样**池里所有账号共用一个 session id**，上游完全可以把两个不同账号关联成
 * 「同一会话」，而我们恰恰在多账号轮换 —— 这个关联没有任何真实客户端会产出。
 */
const ZCODE_SESSION_IDS = new Map<string, string>()

/** 取该账号的伪会话 id（首见时生成，进程内复用）。 */
function zcodeSessionId(deviceMid: string | undefined): string {
  const key = typeof deviceMid === 'string' ? deviceMid : ''
  const existing = ZCODE_SESSION_IDS.get(key)
  if (existing !== undefined) return existing
  const created = randomUUID()
  ZCODE_SESSION_IDS.set(key, created)
  return created
}

/**
 * 官方客户端的「平台三件套」—— **必须同源**。
 *
 * ## ⚠⚠ 为什么三件套要由同一个函数产出（2026-10-25 审计打穿）
 *
 * 改前是 `X-Platform: 'win32-x64'` / `X-Os-Category: 'windows'` 两处**硬编码**，
 * 而 `X-Os-Version: os.release()` 是**真值** ⇒ 在非 Windows 宿主上同一请求里出现
 * 「Windows 平台 + Darwin 内核号（如 `24.6.0`）」这种**任何官方客户端都不会发出**
 * 的组合 —— 三件套自相矛盾本身就是一条新的指纹，与「对齐官方」的目的相反。
 *
 * ## 取舍
 *
 * - **win32 宿主**：三件套全取真值（`os.release()`，实测 `10.0.26100`）。
 * - **其它宿主**：三件套**一起**伪装成官方 Windows 客户端（本文件存在的理由就是
 *   「形状像官方」；只伪装一半反而是更强的异常信号）。
 *
 * ⚠ 残留且**已登记**的不一致：`system` 的 `# Environment` 段仍报**真实**平台
 * （`buildEnvironmentSection` 默认 `process.platform`）—— 那是模型看的自我描述，
 * 伪装它会降低工具使用正确率（bash vs powershell）。两者分属「请求指纹」与
 * 「模型上下文」，刻意不强行统一；改这里时别顺手把 `# Environment` 也改成 win32。
 */
const ZCODE_SPOOF_PLATFORM = Object.freeze({
  platform: 'win32-x64',
  osCategory: 'windows',
  osVersion: '10.0.26100',
})

/**
 * 该宿主该发的平台三件套（三值同源，见上方注释）。
 *
 * ⚠ 两个形参都**必须入参化**（默认取真实宿主）：三件套的自洽性只在「非 win32
 * 宿主」上才可能出问题，而 CI / 开发机大多是 win32 ⇒ 不注入就**永远测不到**那条
 * 分支。2026-10-25 审计实测：在 Windows 上把 `X-Os-Version` 换回 `os.release()`
 * 后，宿主机相关的断言**全绿** —— 因为本机的 `os.release()` 恰好就是
 * `10.0.26100`，与伪装值逐字相同。故内核版本也必须能注入。
 */
export function zcodeClientPlatform(
  hostPlatform: NodeJS.Platform = process.platform,
  hostOsVersion: string = osRelease(),
): {
  platform: string
  osCategory: string
  osVersion: string
} {
  if (hostPlatform === 'win32') {
    return { platform: 'win32-x64', osCategory: 'windows', osVersion: hostOsVersion }
  }
  return { ...ZCODE_SPOOF_PLATFORM }
}

/**
 * 构造 ZCode 的「来源标识」请求头。
 *
 * ## ★ 这些头的值以官方客户端的真实抓包为准（2026-10-25 逐字对齐）
 *
 * 官方 GUI 的一次 `/v1/messages` 带 **18 个头**。本函数此前只发 10 个，
 * 且其中**两个的值与官方不符**：
 *
 * | 头 | 官方 | 本函数（改前） |
 * |---|---|---|
 * | `x-release-channel` | `production` | `stable` ✗ |
 * | `x-platform` | `win32-x64` | `win32` ✗ |
 *
 * 并缺 7 个官方每次都带的头：`x-title` / `x-os-version` / `x-zcode-agent` /
 * `x-session-id` / `x-zcode-session-type` / `x-request-id` / `x-zcode-trace-id`。
 *
 * ⚠ 旧注释写「实测它们不是 3012 的判据」—— 那是**旧版客户端**上取到的结论。
 * 上游在 2026-10-23 升级到 `3.16.3` 之后，`405 + unusual activity` 开始在
 * **所有**插件请求上稳定出现（跨账号、跨会话），而官方客户端同账号同网络正常
 * ⇒ 头的形状重新成为首要嫌疑，故此处逐字对齐抓包。
 *
 * ⚠ `X-Device-Mid` **仍是硬需求**（缺它 billing 全家桶回 400）。
 */
export function buildZcodeHeaders(
  credential: Pick<ZcodeCredential, 'device_mid' | 'app_version'>,
  options: {
    authorization?: string
    json?: boolean
    captcha?: { param: string; region: string }
    /**
     * 覆盖 `app_version`（默认取凭据里的）。
     *
     * ⚠ 使用者**只有两处**，且都是实测过版本门控的
     * （见 {@link ZCODE_VERSION_GATED_MIN_APP_VERSION}）：
     * ① 营销投放查询 `fetchZcodeMarketingPlans`（版本低 ⇒ 投放为空）；
     * ② **领取** `claimZcodePlan`（版本低 ⇒ `1004 no permission`，真机一发定音）。
     * 两者都必须按请求覆盖，**不得**改凭据本身。
     *
     * ★ 未显式覆盖时走 {@link zcodeVersionGatedAppVersion}（凭据版本与
     * `3.16.3` 取较大者），**不再直接回落到凭据里的旧版本**。
     *
     * 依据（2026-10-25 真机取证）：官方客户端在 2026-10-23 升级到 `3.16.3`
     * 之后，本插件发的**推理**请求开始稳定 `405 + request has been blocked
     * due to unusual activity`（跨账号、跨会话；官方客户端同账号同网络正常）。
     * 版本号是当时**唯一**与官方不一致的请求特征 —— 身份块已逐字对齐（2632
     * 字符）、其余 11 个官方头（`Suc` 全量）也全部对齐 ⇒ 版本号成为首要嫌疑。
     */
    appVersion?: string
    /**
     * 覆盖平台三件套（**仅供测试**：非 win32 分支无法在 Windows 主机上自然触发）。
     * 生产调用一律不传 ⇒ 走 {@link zcodeClientPlatform}。
     */
    platform?: { platform: string; osCategory: string; osVersion: string }
  } = {},
): Record<string, string> {
  const appVersion = options.appVersion ?? zcodeVersionGatedAppVersion(credential, ZCODE_INFERENCE_MIN_APP_VERSION)
  const platform = options.platform ?? zcodeClientPlatform()
  const headers: Record<string, string> = {
    'User-Agent': `ZCode/${appVersion}`,
    'HTTP-Referer': ZCODE_ORIGIN,
    'X-Title': 'Z Code@electron',
    'X-ZCode-App-Version': appVersion,
    'X-Release-Channel': 'production',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'X-Device-Mid': credential.device_mid,
    'X-Platform': platform.platform,
    'X-Os-Category': platform.osCategory,
    'X-Os-Version': platform.osVersion,
    'X-ZCode-Agent': 'glm',
    'X-Session-Id': zcodeSessionId(credential.device_mid),
    'X-ZCode-Session-Type': 'other',
    'X-Request-Id': randomUUID(),
    'X-ZCode-Trace-Id': randomUUID(),
    'anthropic-version': '2023-06-01',
  }
  if (options.json !== false) headers['Content-Type'] = 'application/json'
  if (options.authorization !== undefined) headers['Authorization'] = options.authorization
  if (options.captcha !== undefined) {
    headers['x-aliyun-captcha-verify-param'] = options.captcha.param
    headers['x-aliyun-captcha-verify-region'] = options.captcha.region
  }
  return headers
}

/** 一次额度桶（`balances[]` 的一项）。 */
export interface ZcodeBalanceBucket {
  planId?: string
  /** 展示名（实测为模型名，如 `GLM-5.3-Flash`）。 */
  showName?: string
  /**
   * ★ **计量单位** —— 上游明确下发，实测为 `"token"`。
   *
   * ⚠ **真实缺陷**（用户报障）：「智谱 plan 给的不是积分是 tokens，
   * 应该显示 `Token: xx.yyM` 这种格式」。
   *
   * 上游 `billing/balance` 的桶里有两个字段直接说明单位：
   * ```json
   * { "meter": "model_usage", "unit_type": "token",
   *   "total_units": 100000000, "used_units": 5460725,
   *   "remaining_units": 94539275 }
   * ```
   * 此前我们把它当泛化的「积分」渲染，于是界面显示 `94539275`（无单位、
   * 且量级看起来像积分），而正确形态是 **`94.54M` tokens**。
   */
  unitType?: string
  /** 计量口径（实测 `model_usage`）。 */
  meter?: string
  totalUnits?: number
  usedUnits?: number
  remainingUnits?: number
  availableUnits?: number
  /** 到期时间（Unix 秒）。 */
  expiresAt?: number
  /**
   * ★★ **该桶专属的模型**（上游 `capabilities`，实测形状 `["model:glm-5.3"]`）。
   *
   * ## 为什么必须读它（真实缺陷，用户报障 2026-10-12）
   *
   * **用户报障原文**：「智谱账号送的 8m 算力其中分为 5.3-3m 和 5.3flsh-5m，
   * 插件判断这个账号没用完，就不会切换下一个账号使用」。
   *
   * 本机**只读实测**（`scripts/probe-zcode-plan-buckets.mjs`，启用账号）：
   *
   * ```json
   * [bucket] show_name=GLM-5.3        capabilities=["model:glm-5.3"]
   *          total_units=3000000   remaining_units=3000000
   * [bucket] show_name=GLM-5.3-Flash  capabilities=["model:glm-5.3-flash"]
   *          total_units=5000000   remaining_units=5000000
   * ```
   *
   * ⇒ **8M 就是这两个桶（3M + 5M），且上游明确下发了模型归属。**
   * 而此前本类型**没有这个字段**，`fetchZcodeBalance` 把它整体丢弃 ⇒
   * 插件只知道「总剩余 8M」，于是 GLM-5.3 的 3M 烧光、Flash 的 5M 还在时，
   * 折算层仍判「这账号有额度」（判据是全桶汇总的 `remaining > 0`）⇒
   * **该模型的标记永远不写**，auto/aggregate 继续把它当可用候选派发 GLM-5.3。
   *
   * ⚠️ **缺失/为空 ⇒ 视为「通用桶」**（覆盖所有模型），**不要**当成「不覆盖任何模型」：
   * 后者会让一个仍有余额的通用桶（如赠送的 1 亿 token）被忽略 ⇒ 一个**确实可用**
   * 的账号被判成「该模型已耗尽」而被**误封**（方向相反的错误，代价更大）。
   * 判据见 `zcode-entitlements.ts` 的 `bucketCoversModel`。
   */
  capabilities?: readonly string[]
  /**
   * 权益 id（实测 `ent_2_0817_glm_5p3` / `ent_2_0817_glm_5p3f`）。
   *
   * ⚠ **不参与任何判定** —— 判定一律走 {@link capabilities}
   *（它是上游下发的**语义**字段；`entitlement_id` 是命名约定，改版就可能变）。
   *
   * ⚠️⚠️ **它当前是「只写不读」的数据**（审计指出 2026-10-12）：`src/` 与
   * `plugin-src/client/` 里**零消费方**（唯一读者是本模块的单测）。
   * 保留它的理由是**排查留证**：出问题时能一眼看出「是哪个 entitlement
   * 在起作用」，而 `capabilities` 只给模型维度、给不出计划维度。
   * ⇒ 别把它当「已接线」的字段用；要用它请先加消费者（并删掉这句说明）。
   */
  entitlementId?: string
}

/** 余额查询结果。 */
export interface ZcodeBalanceResult {
  /** 是否为「企业版」等不下发额度数字的形态（此时 buckets 为空）。 */
  enterprise?: boolean
  buckets: readonly ZcodeBalanceBucket[]
  /** 汇总剩余额度（所有桶累加）。 */
  remaining: number
  /** 汇总总量。 */
  total: number
  /** 最早到期时间（Unix 秒），用于展示解禁时刻。 */
  expiresAt?: number
  /** 显示名（首个桶的模型名）。 */
  planName?: string
  /**
   * ★ 可领活动摘要（来自 `billing/preview`）。
   *
   * ⚠ **必需存在的原因**（2026-10-03 实测）：每日赠送的 start-plan 额度
   * **不在 `buckets` 里**，只在 `preview.plans` 里 ——
   * 同一账号 `balances` 返回 0 个桶、`preview` 返回 `…start-plan-trust-1003`。
   * 只读 `buckets` 会让面板显示 0，而用户实际能领 1 亿 tokens。
   *
   * ⚠ 取不到时是**空数组**（不 undefined）：preview 失败属降级，
   * 绝不能让它影响 `remaining`/`total` 本身。
   */
  claimablePlans: ZcodeClaimablePlanSummary[]
  /**
   * ★★ **已领取、但还没到生效时刻**的计划（实测 2026-10-23）。
   *
   * ## 现象（用户报障）
   *
   * 领完 1024 活动后，签到结果显示「+500.00MToken 领取成功」，
   * **但随后查额度仍是 0** ⇒ 用户以为白领了。
   *
   * ## 真因（不是 bug）
   *
   * 上游 `billing/balance` 对「已领未生效」的账号返回：
   *
   * ```json
   * { "balances": [],
   *   "plans": [{ "plan_id": "zcode-v3-start-plan-1024", "status": "active",
   *               "entitlements": [{ "grant_units": 300000000, "effective_at": 1792767600 },
   *                                { "grant_units": 200000000, "effective_at": 1792767600 }] }] }
   * ```
   *
   * ⇒ 额度已锁定在 `plans` 里，但 `balances` 桶**还是空的** ——
   * 桶要等 `effective_at`（实测 **23:00**）才建。
   * 官方成功弹窗的文案也正是「**将于 … 生效**」。
   *
   * ## 为什么必须单独一个字段（不能混进 `buckets`）
   *
   * `buckets` 是「**现在就能用**的额度」⇒ 把它算进 `remaining` 会让
   * 折算层（`aggregate-expiry.ts` 的 `zcodeExpiry`）判成「有额度」⇒
   * **在生效前就把渠道派发出去**（发出去必然失败：额度还不存在）。
   * ⇒ 二者必须分开：`buckets` = 现在能用；`pendingPlans` = 已领、等生效。
   */
  pendingPlans: ZcodePendingPlan[]
}

/** 「已领但未生效」的计划（`status: active` 且 `effective_at` 未到）。 */
export interface ZcodePendingPlan {
  planId: string
  name?: string
  /** 合计额度（同 `unitType` 才相加，规则同营销投放那条）。 */
  grantUnits?: number
  unitType?: string
  /** 生效时刻（Unix 秒）。 */
  effectiveAt?: number
  /** 到期时刻（Unix 秒）。 */
  endsAt?: number
}

/** 一次可领活动。 */
export interface ZcodeClaimablePlan {
  planId: string
  priority: number
  name?: string
  /**
   * ★ 本次领取能拿到的**额度数值**（实测自 `plan.entitlements[].grant_units`）。
   *
   * ⚠ 上游**不在** plan 顶层给额度，只在 `entitlements[]` 里。拿不到时
   *   留 undefined —— 此时 `toClaimOutcome` 退回 0（不谎报）。
   */
  grantUnits?: number
  /**
   * ★ 额度单位（`'token'` / 缺省按积分）。
   *
   * ⚠ ZCode 下发 `unit_type: "token"`，**不是**积分 —— 展示必须走
   *   `formatUnits`/`unitLabel`（`plugin-src/client/credits-format.js`）。
   */
  unitType?: string
  /**
   * ★ 若该 plan 来自**营销投放**（{@link fetchZcodeMarketingPlans}），
   *   这里是它所属的 `campaign_id`。
   *
   * 用途只有一个：领取成功后回报
   * `POST /marketing/touch/action {campaign_id, action_type:'confirm'}`，
   * 让服务端不再重复投放同一个活动（否则每次签到都会为一个**已领过**的
   * plan 再 mint 一次 captcha —— 那是设备级配额，见 `captcha-backoff.ts`）。
   *
   * ⚠ 来自 `billing/preview` 的 plan **没有**这个字段（preview 不走营销系统）。
   */
  marketingCampaignId?: string
}

/** 领取结果。 */
export interface ZcodeClaimOutcome {
  planId: string
  /** 上游业务码：`0` 成功、`1003` 已领取（幂等成功）。 */
  code?: number
  ok: boolean
  /** 已领取过（幂等，视为成功）。 */
  alreadyClaimed?: boolean
  httpStatus?: number
  message?: string
  /**
   * 上游的 `logid`（排障凭据，2026-10-12 新增）。
   *
   * ⚠ 与推理侧同源：由 {@link extractZcodeLogId} **双来源**取
   * （体顶层 `logid` 优先，HTTP 头 `x-request-id` 兜底）——
   * 后者让**边缘 HTML 页**也有凭据可取。
   * ⚠ 取不到即 `undefined`，不编造（诊断行会整项省略）。
   */
  logId?: string
}

/**
 * 从数字字段安全取值（上游可能给 `null`）。
 *
 * ⚠⚠ **只认 `number`，不认数字字符串** —— 对**业务码**来说那是个真实缺陷
 * （`{"code":"3012"}` 会被吃成 `undefined`，见 `claimZcodePlan` 里的说明），
 * 现已改用 {@link parseZcodeBusinessCode}。
 *
 * ⚠ 本函数仍用于**额度数值 / priority / 上下文窗口**这些字段：它们若以字符串
 * 下发，会静默退化成 `undefined`（`priority` → 0、`grantUnits` → 不显示额度）。
 * 这属于**既有行为、不在本次改动范围**（改它会牵动 plan 排序与额度展示，
 * 需单独的实发验证），故此处**如实标注限制而不擅自扩大改动**。
 */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 读一个桶的 `capabilities`（上游实测 `["model:glm-5.3"]`）。
 *
 * ⚠ **只收非空字符串**：上游可能在别的形态下给 `null` / 数字 / 空串，
 * 让它们进数组会污染 `bucketCoversModel` 的前缀解析（`String(null)` 会得到
 * `"null"` 这种看似合法的段）。
 *
 * ⚠ **全空时返回 `undefined`（而不是 `[]`）**：`undefined` 与 `[]` 在判据里
 * **语义不同** —— 前者是「上游没说」，后者是「上游说它不覆盖任何模型」。
 * 本仓库对这类「未知 vs 否定」的三态区分有明确规则（见 `inputModalities` 的
 * 注释），且这里的错误方向代价很大：把 `undefined` 当成 `[]` 会让一个**仍有
 * 余额的通用桶**被忽略，从而误封一个可用账号。
 */
function capabilitiesOf(record: Record<string, unknown>): readonly string[] | undefined {
  const raw = record.capabilities
  if (!Array.isArray(raw)) return undefined
  const out = raw.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return out.length > 0 ? out : undefined
}

/**
 * `fetch` 的超时包装（外部输入必须有上限）。
 *
 * ⚠ **必须用调用方传进来的 `fetchImpl`**，不能直接用全局 `fetch`。
 *
 * **真实缺陷**（做 ref 缺口探针时暴露）：早期这里写的是裸 `fetch(...)`，
 * 而所有公开函数都接收 `fetchImpl` 参数**却从不往下传** —— 于是
 * `ZcodeAuth` 注入的桩 fetch 对「额度 / 签到 / captcha 配置」全部无效：
 *   - 单测无法桩住网络（会真的打上游）；
 *   - `fetchImpl` 沦为**死参数**（签名说有、行为上没有）。
 *
 * 症状很隐蔽：`ZcodeAdapter` 的推理路径**自己**用 `this.fetchImpl`，
 * 所以「推理桩得住、额度桩不住」，看起来像是额度接口本身的问题。
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit & { timeoutMs?: number },
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 查余额。
 *
 * ⚠ **`Authorization` 必需**（缺则 401）；`X-Device-Mid` 也必需
 * （缺则 400 code 3001）。
 *
 * 企业版（`displayMode: "enterprise"`）不下发额度数字、只给外部链接 ——
 * 此时返回 `{enterprise:true, buckets:[]}`，**不要**显示成 0
 * （0 是「已用光」的语义）。
 */
export async function fetchZcodeBalance(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeBalanceResult | undefined> {
  const response = await fetchWithTimeout(fetchImpl, ZCODE_BILLING_BALANCE_URL, {
    method: 'GET',
    headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}` }),
  }, 30_000)
  if (!response.ok) return undefined

  let parsed: {
    code?: unknown
    data?: {
      displayMode?: unknown
      balances?: unknown
      plans?: unknown
    }
  }
  try {
    parsed = await response.json() as typeof parsed
  } catch {
    return undefined
  }
  const data = parsed.data
  if (data === undefined) return undefined
  if (typeof data.displayMode === 'string' && data.displayMode === 'enterprise') {
    // ⚠ 企业版**不下发额度数字**，也就没有可领活动 ⇒ 不发 preview 请求。
    return { enterprise: true, buckets: [], remaining: 0, total: 0, claimablePlans: [], pendingPlans: [] }
  }

  const rawBuckets = Array.isArray(data.balances) ? data.balances : []
  const buckets: ZcodeBalanceBucket[] = []
  for (const item of rawBuckets) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    buckets.push({
      planId: typeof record.plan_id === 'string' ? record.plan_id : undefined,
      showName: typeof record.show_name === 'string' ? record.show_name : undefined,
      // ⚠ 单位字段必须带上：上游说 `unit_type: "token"`，界面据此显示 M 量级。
      unitType: typeof record.unit_type === 'string' ? record.unit_type : undefined,
      meter: typeof record.meter === 'string' ? record.meter : undefined,
      totalUnits: num(record.total_units),
      usedUnits: num(record.used_units),
      remainingUnits: num(record.remaining_units),
      availableUnits: num(record.available_units),
      expiresAt: num(record.expires_at),
      // ★ 模型归属（实测 `["model:glm-5.3"]`）—— 按模型判定靠它（见字段注释）。
      ...(() => {
        const capabilities = capabilitiesOf(record)
        return capabilities === undefined ? {} : { capabilities }
      })(),
      ...typeof record.entitlement_id === 'string' ? { entitlementId: record.entitlement_id } : {},
    })
  }

  let remaining = 0
  let total = 0
  let expiresAt: number | undefined
  for (const bucket of buckets) {
    // 优先用 available（若给了），否则用 remaining。
    remaining += bucket.availableUnits ?? bucket.remainingUnits ?? 0
    total += bucket.totalUnits ?? 0
    const exp = bucket.expiresAt
    if (exp !== undefined && (expiresAt === undefined || exp < expiresAt)) expiresAt = exp
  }

  return {
    buckets,
    remaining,
    total,
    expiresAt,
    planName: buckets[0]?.showName,
    claimablePlans: await fetchClaimablePlans(credential, fetchImpl),
    pendingPlans: pendingPlansOf(data.plans),
  }
}

/**
 * 从 `billing/balance` 的 `plans[]` 里挑出「**已领、但还没生效**」的计划。
 *
 * ## 判据（三条，缺一不可）
 *
 * | 条件 | 为什么 |
 * |---|---|
 * | `status === 'active'` | 只有 active 的计划是「已领到、未作废」 |
 * | 有 `entitlements[].effective_at` | **生效时刻**；缺它就无法判断「还没生效」 |
 * | `effective_at` **晚于现在** | 已生效的计划会变成 `balances` 里的桶 ⇒ 不该重复计入 |
 *
 * ⚠ **只统计 `effective_at` 未到的那部分 entitlement**（不是整个 plan）：
 *   同一 plan 里可能混着已生效与未生效的条目。
 * ⚠ **额度按同 `unit_type` 求和**（与营销投放那条同规则），单位不同不混加。
 *
 * @param nowUnixSeconds 「现在」（Unix 秒）。留成参数是为了可测。
 */
export function pendingPlansOf(
  rawPlans: unknown,
  nowUnixSeconds: number = Math.floor(Date.now() / 1000),
): ZcodePendingPlan[] {
  if (!Array.isArray(rawPlans)) return []
  const out: ZcodePendingPlan[] = []
  for (const item of rawPlans) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.status !== 'active') continue
    const ents = Array.isArray(record.entitlements) ? record.entitlements : []
    let units = 0
    let unitType: string | undefined
    let effectiveAt: number | undefined
    let saw = false
    for (const ent of ents) {
      if (ent === null || typeof ent !== 'object') continue
      const entRecord = ent as Record<string, unknown>
      const eff = num(entRecord.effective_at)
      // ⚠ 已生效（effective_at 已到）的条目不在这里算 —— 它已变成 balances 桶。
      if (eff === undefined || eff <= nowUnixSeconds) continue
      const grant = num(entRecord.grant_units)
      if (grant === undefined) continue
      const type = typeof entRecord.unit_type === 'string' && entRecord.unit_type.length > 0
        ? entRecord.unit_type
        : undefined
      if (unitType === undefined) unitType = type
      if (type !== unitType) continue
      units += grant
      effectiveAt = effectiveAt === undefined ? eff : Math.min(effectiveAt, eff)
      saw = true
    }
    if (!saw) continue
    out.push({
      planId: typeof record.plan_id === 'string' ? record.plan_id : '',
      ...typeof record.name === 'string' ? { name: record.name } : {},
      grantUnits: units,
      ...unitType === undefined ? {} : { unitType },
      effectiveAt,
      endsAt: num(record.ends_at),
    })
  }
  return out
}

/** `ZcodeBalanceResult` 里由 `preview` 带出的可领活动。 */
export interface ZcodeClaimablePlanSummary {
  planId: string
  showName?: string
  amount?: number
}

/**
 * 取「可领活动」摘要（**只读**，不消耗额度）。
 *
 * ## 为什么 balance 要带它（2026-10-03 实测）
 *
 * 同一账号：
 * ```
 * GET /billing/balance  → data.balances = []                          ← 0 个桶
 * GET /billing/preview  → data.plans[0].plan_id = …start-plan-trust-1003
 * ```
 * ⇒ **每日赠送的 start-plan 额度不在 `balances` 桶里**，只在 `plans` 里。
 * 只读 `balances` ⇒ 面板显示 0，而用户实际能领 1 亿 tokens。
 *
 * ⚠ **失败一律降级为空数组**，绝不影响 `balance` 本身 ——
 *   余额是主体，preview 是补充。
 *
 * ⚠ 走**同一个** `preview` 端点与 `fetchZcodeClaimablePlans` 一致；
 *   这里只是不解析成领取结果、只留展示要的三个字段（少一次字段耦合）。
 */
async function fetchClaimablePlans(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch,
): Promise<ZcodeClaimablePlanSummary[]> {
  try {
    const appVersion = zcodeCredentialAppVersion(credential)
    const response = await fetchWithTimeout(
      fetchImpl,
      `${ZCODE_BILLING_PREVIEW_URL}?app_version=${encodeURIComponent(appVersion)}&platform=win32`,
      { method: 'GET', headers: buildZcodeHeaders(credential, { json: false, appVersion }) },
      15_000,
    )
    if (!response.ok) return []
    const parsed = await response.json() as { data?: { plans?: unknown } }
    const raw = Array.isArray(parsed.data?.plans) ? parsed.data.plans : []
    const out: ZcodeClaimablePlanSummary[] = []
    for (const item of raw as Array<Record<string, unknown>>) {
      if (typeof item !== 'object' || item === null) continue
      const planId = item['plan_id']
      if (typeof planId !== 'string' || planId.length === 0) continue
      out.push({
        planId,
        ...(typeof item['name'] === 'string' ? { showName: item['name'] } : {}),
        ...(typeof item['amount'] === 'number' ? { amount: item['amount'] } : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 补客户端活跃信号。
 *
 * ⚠ **这一步不能省**：不补这两条事件，`preview` 恒为空 `plans: []` ——
 * 于是「今天可领」永远是「没有可领」，用户以为签到坏了。
 *
 * 幂等（服务端按 device_mid + 日期去重），故每次查 preview 前都可以补。
 */
export async function reportZcodeActivation(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const appVersion = zcodeCredentialAppVersion(credential)
  for (const event of ['app_launch', 'app_daily_active']) {
    try {
      await fetchWithTimeout(fetchImpl, ZCODE_EVENT_REPORT_URL, {
        method: 'POST',
        headers: buildZcodeHeaders(credential, { json: true, appVersion }),
        body: JSON.stringify({
          event,
          device_mid: credential.device_mid,
          platform: 'win32',
          app_version: appVersion,
        }),
      }, 20_000)
    } catch {
      // 上报失败不阻塞（下一次调用会再补）。
    }
  }
}

/** 查当前可领的活动。 */
export async function fetchZcodeClaimablePlans(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly ZcodeClaimablePlan[]> {
  const appVersion = zcodeCredentialAppVersion(credential)
  const url = `${ZCODE_BILLING_PREVIEW_URL}?app_version=${encodeURIComponent(appVersion)}&platform=win32`
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: 'GET',
    headers: buildZcodeHeaders(credential, { json: false, appVersion }),
  }, 25_000)
  if (!response.ok) return []
  let parsed: { data?: { plans?: unknown } }
  try {
    parsed = await response.json() as typeof parsed
  } catch {
    return []
  }
  const raw = Array.isArray(parsed.data?.plans) ? parsed.data.plans : []
  const plans: ZcodeClaimablePlan[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.plan_id !== 'string' || record.plan_id.length === 0) continue
    /**
     * ★ 额度取自 `entitlements[]`（2026-10-03 实测）——
     * plan 顶层**没有**额度字段，只有 `entitlements[0].grant_units`。
     * 不读它 ⇒ `toClaimOutcome` 只能填 0 ⇒ 面板显示「+0 积分」。
     */
    const ents = Array.isArray(record.entitlements)
      ? record.entitlements as Array<Record<string, unknown>>
      : []
    const first = ents[0] ?? {}
    const grantUnits = num(first.grant_units)
    plans.push({
      planId: record.plan_id,
      priority: num(record.priority) ?? 0,
      name: typeof record.name === 'string' ? record.name : undefined,
      ...(grantUnits === undefined ? {} : { grantUnits }),
      ...(typeof first.unit_type === 'string' ? { unitType: first.unit_type } : {}),
    })
  }
  // priority 降序（与官方/第三方实现一致：先领高优先级）。
  plans.sort((a, b) => b.priority - a.priority)
  return plans
}

/** 比较两个点分版本号（只看数字段，缺失段按 0；非数字段取前导数字）。 */
export function compareZcodeAppVersion(a: string, b: string): number {
  const segments = (value: string): number[] =>
    value.split('.').map((part) => {
      const match = /^\s*(\d+)/.exec(part)
      return match === null ? 0 : Number(match[1])
    })
  const left = segments(a)
  const right = segments(b)
  const count = Math.max(left.length, right.length)
  for (let index = 0; index < count; index += 1) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * **受版本门控的请求**该用的 `app_version`：**凭据里的版本与最低版本取较大者**。
 *
 * 使用者只有两处（都是实测门控过的）：{@link fetchZcodeMarketingPlans} 与
 * {@link claimZcodePlan}。**其余请求一律用凭据里的版本**（见常量注释里的理由）。
 *
 * ⚠ 取较大者（而不是恒定 3.16.3）是为了**向前兼容**：用户若在更新的官方版上
 * 登录（凭据里写着 3.17.x），就用它自己的版本号，而不是把它降级成 3.16.3。
 * 依据与「为什么不能改凭据本身」见 {@link ZCODE_VERSION_GATED_MIN_APP_VERSION}。
 */
export function zcodeVersionGatedAppVersion(
  credential: Pick<ZcodeCredential, 'app_version'>,
  minAppVersion: string = ZCODE_VERSION_GATED_MIN_APP_VERSION,
): string {
  const stored = typeof credential.app_version === 'string' ? credential.app_version.trim() : ''
  if (!ZCODE_APP_VERSION_PATTERN.test(stored)) return minAppVersion
  return compareZcodeAppVersion(stored, minAppVersion) < 0
    ? minAppVersion
    : stored
}

/**
 * **不受门控**的请求（query / body 里的 `app_version`）该用的版本。
 *
 * ⚠ 与 {@link zcodeVersionGatedAppVersion} 的分工必须分清：
 * - 本函数 = 「凭据里的版本，但必须是干净的 semver」⇒ 拿不到干净的就用兜底值；
 * - 门控版 = 「与 `3.16.3` 取较大者」⇒ 只给**实测过门控**的路径（见常量注释）。
 *
 * ## 为什么必须存在（2026-10-25 审计打穿）
 *
 * 改前这些站点写的是 `credential.app_version ?? ZCODE_APP_VERSION_FALLBACK` ——
 * `??` **只挡 `undefined`/`null`**，于是空串会发出 `app_version=`、脏值会原样
 * 发出（换行注入会让 `Headers()` 抛 `TypeError`）。而同一请求的头走门控、
 * query 走凭据 ⇒ 还会出现「同一请求里两个版本号」的自相矛盾。
 */
export function zcodeCredentialAppVersion(
  credential: Pick<ZcodeCredential, 'app_version'>,
): string {
  const stored = typeof credential.app_version === 'string' ? credential.app_version.trim() : ''
  return ZCODE_APP_VERSION_PATTERN.test(stored) ? stored : ZCODE_APP_VERSION_FALLBACK
}

/** 投送物里一个 plan 的元数据（展示与排序用）。 */
interface ZcodeMarketingPlanMeta {
  name?: string
  priority?: number
  grantUnits?: number
  unitType?: string
}

/** 深度扫描投送物时的最大层数（投送物是服务端下发的任意 JSON）。 */
const MARKETING_SCAN_MAX_DEPTH = 8

/**
 * 把 `entitlements[]` 的 `grant_units` **求和**（同 `unit_type` 才相加）。
 *
 * ## ⚠ 为什么这里求和，而 `fetchZcodeClaimablePlans` 只取第一条
 *
 * 实测（2026-10-23，本机 4 个账号一致）1024 活动的 plan 有**两条** entitlement：
 *
 * ```json
 * entitlements: [
 *   { "show_name": "GLM-5.3-Flash", "unit_type": "token", "grant_units": 300000000 },
 *   { "show_name": "GLM-5.3",       "unit_type": "token", "grant_units": 200000000 }
 * ]
 * ```
 *
 * 「5 亿」= 3 亿 + 2 亿 ⇒ 只取第一条会把这次领取**少报 2 亿**
 * （用户看到的正是「5 亿 TOKENS」那行文案）。
 *
 * ⚠ **刻意不改 preview 那条路径**（它取 `entitlements[0]`）：那边实测每个 plan
 * 只有一条 entitlement，改口径会牵动 plan 排序与额度展示，属**无证据的扩大改动**。
 * 两条路径各有各的实测依据，故分开实现并在测试里分别钉住。
 */
function sumMarketingGrantUnits(plan: Record<string, unknown>): { units?: number; unitType?: string } {
  const raw = plan.entitlements
  if (!Array.isArray(raw)) return {}
  let units = 0
  let unitType: string | undefined
  let saw = false
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const value = num(record.grant_units)
    if (value === undefined) continue
    const type = typeof record.unit_type === 'string' && record.unit_type.length > 0 ? record.unit_type : undefined
    if (unitType === undefined) unitType = type
    // 单位不同不混加（宁可少报，也不把 token 与积分加成一个数）。
    if (type !== unitType) continue
    units += value
    saw = true
  }
  return saw ? { units, unitType } : { unitType }
}

/**
 * 收集一个投送物里所有「形如 plan」的对象（按 `plan_id` 索引）。
 *
 * ⚠ 必须**递归找**而不是写死路径：实测同一份 `zcode_plan` 元数据出现在
 * banner 的 `background.args`、`success_popup.hero.args` **等多处**
 * （服务端把同一份 plan 描述镜像到每个资产位），而 popup 形态的路径又不同。
 * 写死路径会在下一次投放改版时静默失效（少报额度、不发 confirm）。
 *
 * ⚠ 深度有上限（`MARKETING_SCAN_MAX_DEPTH`）：投送物是服务端可控的任意 JSON，
 * 递归必须有界（与 `captcha-asset` 那类「服务端数据也要设界」的纪律一致）。
 */
function collectZcodeMarketingPlanMetas(root: unknown): Map<string, ZcodeMarketingPlanMeta> {
  const out = new Map<string, ZcodeMarketingPlanMeta>()
  const visit = (node: unknown, depth: number): void => {
    if (depth > MARKETING_SCAN_MAX_DEPTH || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    const record = node as Record<string, unknown>
    const planId = record.plan_id
    if (typeof planId === 'string' && planId.length > 0) {
      const meta = out.get(planId) ?? {}
      if (typeof record.name === 'string' && record.name.length > 0) meta.name = record.name
      const priority = num(record.priority)
      if (priority !== undefined && meta.priority === undefined) meta.priority = priority
      const grant = sumMarketingGrantUnits(record)
      if (grant.units !== undefined) {
        meta.grantUnits = grant.units
        meta.unitType = grant.unitType
      }
      out.set(planId, meta)
    }
    for (const value of Object.values(record)) visit(value, depth + 1)
  }
  visit(root, 0)
  return out
}

/**
 * 取一个投送物里所有按钮（banner 本体 + banner 的 `success_popup` + popup 本体）。
 *
 * 依据：`out/renderer/assets/src-oukR4Y1K.js` 的投放 schema ——
 * `resource_position` 二选一（`banner` / `popup`），banner 另有 `success_popup`。
 */
function marketingButtonsOf(delivery: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const pushButtons = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const item of value) {
      if (item !== null && typeof item === 'object') out.push(item as Record<string, unknown>)
    }
  }
  const banner = delivery.banner
  if (banner !== null && typeof banner === 'object') {
    const record = banner as Record<string, unknown>
    pushButtons(record.buttons)
    const popup = record.success_popup
    if (popup !== null && typeof popup === 'object') pushButtons((popup as Record<string, unknown>).buttons)
  }
  const popup = delivery.popup
  if (popup !== null && typeof popup === 'object') pushButtons((popup as Record<string, unknown>).buttons)
  return out
}

/**
 * 从营销投送物里取出**可领 plan**（纯函数，便于单测）。
 *
 * 判据是按钮的 action：`{type:'claim_zcode_plan', args:{plan_id}}`
 * —— 官方 renderer 里这条 action 被翻译成 `{type:'claim_plan', planId}` 交给
 * 主进程的 `claimManualPlan()`，后者调的正是我们既有的
 * `POST /zcode-plan/billing/claim`（**带 captcha**）。
 *
 * ⚠ 其余 action（`close` / `open_url` / `navigate` / `copy_text`）一律**不是**领取，
 * 不得混进来（`close` 尤其危险：把它当领取会对着一个空 plan_id 发请求）。
 */
export function claimablePlansFromMarketingDeliveries(deliveries: unknown): ZcodeClaimablePlan[] {
  if (!Array.isArray(deliveries)) return []
  const plans: ZcodeClaimablePlan[] = []
  const seen = new Set<string>()
  for (const delivery of deliveries) {
    if (delivery === null || typeof delivery !== 'object') continue
    const record = delivery as Record<string, unknown>
    const campaignId = typeof record.campaign_id === 'string' && record.campaign_id.length > 0
      ? record.campaign_id
      : undefined
    const metas = collectZcodeMarketingPlanMetas(record)
    const fallbackPriority = num(record.priority) ?? 0
    for (const button of marketingButtonsOf(record)) {
      const action = button.action
      if (action === null || typeof action !== 'object') continue
      const actionRecord = action as Record<string, unknown>
      if (actionRecord.type !== 'claim_zcode_plan') continue
      const args = actionRecord.args
      const planId = args !== null && typeof args === 'object'
        ? (args as Record<string, unknown>).plan_id
        : undefined
      if (typeof planId !== 'string' || planId.length === 0) continue
      if (seen.has(planId)) continue
      seen.add(planId)
      const meta = metas.get(planId) ?? {}
      plans.push({
        planId,
        priority: meta.priority ?? fallbackPriority,
        ...meta.name === undefined ? {} : { name: meta.name },
        ...meta.grantUnits === undefined ? {} : { grantUnits: meta.grantUnits },
        ...meta.unitType === undefined ? {} : { unitType: meta.unitType },
        ...campaignId === undefined ? {} : { marketingCampaignId: campaignId },
      })
    }
  }
  return plans
}

/**
 * 查**营销投放**里的可领 plan（只读）。
 *
 * ## 为什么必须有这条来源（真实缺口，用户报障 2026-10-23）
 *
 * 用户报障原文：「我在 scoop 中装了 zcode 最新版 3.16.3，其中有 1024 程序员节
 * 送的 5 亿 token，把这个领取功能集成在每日签到中一并领取」。
 *
 * 本机**只读实测**（4 个账号、`scripts/probe-zcode-marketing-touch.mjs`）：
 *
 * | 端点 | 结果 |
 * |---|---|
 * | `billing/preview` | `data.plans = []`（**永远是空**） |
 * | `billing/balance` | `data.balances = []` |
 * | `marketing/touch`（`3.16.3`） | `deliveries[0].banner.buttons[1].action = claim_zcode_plan(zcode-v3-start-plan-1024)` |
 *
 * ⇒ **1024 活动根本不走 `preview`**，只在营销投放里。只领 preview 的签到
 * 永远看不到它（而它在 wire 上与「今天没活动」同形 —— 没有任何报错）。
 *
 * ⚠ **版本门控**：见 {@link ZCODE_VERSION_GATED_MIN_APP_VERSION}
 * （同一个账号、同一套头，只有版本号不同：`3.14.3` → `deliveries: []`）。
 *
 * ⚠ **失败一律降级为空数组**，绝不影响 preview 那条主路径（与
 * `fetchClaimablePlans` 同规矩：营销是补充，不是主体）。
 */
export async function fetchZcodeMarketingPlans(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly ZcodeClaimablePlan[]> {
  const appVersion = zcodeVersionGatedAppVersion(credential)
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${ZCODE_MARKETING_TOUCH_URL}?seq=0`,
      {
        method: 'GET',
        headers: buildZcodeHeaders(credential, {
          json: false,
          appVersion,
          authorization: `Bearer ${credential.zcode_jwt}`,
        }),
        redirect: 'error',
      },
      20_000,
    )
    if (!response.ok) return []
    const parsed = await response.json() as { data?: { deliveries?: unknown } }
    return claimablePlansFromMarketingDeliveries(parsed.data?.deliveries)
  } catch {
    return []
  }
}

/**
 * 回报一次营销动作（`confirm` / `cancel`）——**写操作，best-effort**。
 *
 * ## 为什么要回报（对应用户可见的代价）
 *
 * 官方 renderer 在动作**成功后**立刻 `p(delivery, 'confirm')`
 * （`out/renderer/assets/styles-n-UNIiNg.js`）。不回报的后果不是「少了记账」，
 * 而是**服务端会继续重复投放同一个 campaign** ⇒ 我们每轮签到都会为一个
 * 已经领过的 plan 再 mint 一次 captcha。captcha 是**设备级**配额
 * （阿里云同设备每小时 150 次，见 `captcha-backoff.ts` 的开头），
 * 为一个已领的 plan 反复消耗它是净负面。
 *
 * ⚠ **只在领取成功/已领取（`code 0` / `1003`）后调用**：`confirm` 的语义是
 *   「本次活动我已处理完」。若在**失败**时回报，就等于告诉服务端
 *   「别再给我看了」—— 用户会**白丢一次领取机会**（`cancel` 语义更明确地
 *   表示放弃，本实现**从不**发送）。
 *
 * ⚠ **不参与 `noteZcodeRequest*` 埋点**：那套是给 `3012` 风控画像统计
 *   「去推理/领取端点的请求」的，营销端点不是风控对象，混进去会污染画像。
 *
 * @returns 只有 `{code:0}` 才算成功（与官方 `z.object({code:z.literal(0)})` 同口径）。
 */
export async function reportZcodeMarketingAction(
  credential: ZcodeCredential,
  campaignId: string,
  actionType: 'confirm' | 'cancel',
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const appVersion = zcodeVersionGatedAppVersion(credential)
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      ZCODE_MARKETING_ACTION_URL,
      {
        method: 'POST',
        headers: buildZcodeHeaders(credential, {
          json: true,
          appVersion,
          authorization: `Bearer ${credential.zcode_jwt}`,
        }),
        body: JSON.stringify({ campaign_id: campaignId, action_type: actionType }),
        redirect: 'error',
      },
      15_000,
    )
    if (!response.ok) return false
    const parsed = await response.json() as { code?: unknown }
    return parseZcodeBusinessCode(parsed.code) === 0
  } catch {
    return false
  }
}

/**
 * 合并两个来源的可领 plan（**按 `planId` 去重 + priority 降序**）。
 *
 * ⚠ **`preview` 优先**：同一 `planId` 同时出现在两边时保留 preview 那份
 *   （它的额度口径是既有实测过的），只把 marketing 的 `campaign_id`
 *   **补进去**（否则那份 plan 领完了却不会回报 confirm）。
 *
 * ⚠ 排序按 `priority` 降序与两个来源各自的约定一致 —— 1024 活动的
 *   `priority` 是 **101**，实测高于每日赠送那条（`fetchZcodeClaimablePlans`
 *   的注释：官方「先领高优先级」），故它会排在最前、先被领取。
 */
export function mergeZcodeClaimablePlans(
  preview: readonly ZcodeClaimablePlan[],
  marketing: readonly ZcodeClaimablePlan[],
): ZcodeClaimablePlan[] {
  const byId = new Map<string, ZcodeClaimablePlan>()
  for (const plan of preview) if (!byId.has(plan.planId)) byId.set(plan.planId, plan)
  for (const plan of marketing) {
    const existing = byId.get(plan.planId)
    if (existing === undefined) {
      byId.set(plan.planId, plan)
      continue
    }
    if (existing.marketingCampaignId === undefined && plan.marketingCampaignId !== undefined) {
      byId.set(plan.planId, { ...existing, marketingCampaignId: plan.marketingCampaignId })
    }
  }
  return [...byId.values()].sort((a, b) => b.priority - a.priority)
}

/**
 * 领取一个 plan。
 *
 * ⚠ **captcha 是一次性的**：每个 plan 都必须**重新 mint** 一个新 param。
 * 复用同一个 param 在索要验证的窗口里会得到 `3007`（captcha 校验失败）；
 * 本路径**每个 plan 都现产一个新的**，不去赌上游这一次校不校验。
 *
 * 业务码语义（桥侧实测记录）：
 *
 * | code | 含义 | 处理 |
 * |---|---|---|
 * | `0` | 成功领取 | ok |
 * | `1003` | **已领取过（幂等，不是错误）** | 视为成功 |
 * | `1001` | plan 不存在 | 失败 |
 * | `1002` | 活动已结束 | 失败 |
 * | `1004` | 不符合条件 | 失败 |
 * | `1005` | 名额用完 | 失败 |
 * | `3007` | captcha 失败（需换新 param） | 失败 |
 * | 401 | 未登录 | 失败 |
 */
export async function claimZcodePlan(
  credential: ZcodeCredential,
  planId: string,
  captcha: { param: string; region: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeClaimOutcome> {
  let response: Response
  try {
    response = await fetchWithTimeout(fetchImpl, ZCODE_BILLING_CLAIM_URL, {
      method: 'POST',
      headers: buildZcodeHeaders(credential, {
        authorization: `Bearer ${credential.zcode_jwt}`,
        captcha,
        /**
         * ★★ **领取也必须抬版本**（2026-10-23 真机一发定音，见常量注释）：
         *
         * | `X-ZCode-App-Version`（其余头完全相同） | 返回 |
         * |---|---|
         * | `3.14.3`（凭据里的） | `400 / code 1004 "no permission"` |
         * | `3.16.2` | **`200 / code 0`** + `data.plan.{status:"active", …}` |
         *
         * ⚠ `1004` 的官方文案是「当前账号或**客户端版本**不满足领取条件」
         *   —— 不抬版本时，用户会看到「拿到了活动却领不到」，而它**看起来像
         *   账号没资格**（极易被误判成「这个账号不行」而不是「我们的版本号旧了」）。
         * ⚠ 官方客户端 claim 同样报自己的版本（`claimManualPlan` 的
         *   `'X-ZCode-App-Version': Ir`），**报 3.14.3 的才是我们**。
         */
        appVersion: zcodeVersionGatedAppVersion(credential),
      }),
      body: JSON.stringify({ plan_id: planId }),
    }, 60_000)
  } catch (error) {
    return {
      planId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  /**
   * ★★ 读响应体与解析业务码（真实缺陷，2026-10-05 对抗性审计打出）。
   *
   * ## ① `code` 必须认**纯数字字符串**
   *
   * 原先用 `num(parsed.code)`，而 `num()` **只认 `number`** ⇒ 上游回
   * `{"code":"3012","msg":"request has been blocked due to unusual activity."}`
   * 时 `code` 变成 `undefined`，风控码**整条丢失** —— 用户看到的正是本 issue
   * 要修的那句裸上游串（`…: request has been blocked due to unusual activity.`），
   * 因为该 `msg` 里**不含数字**，连「扫正文」都救不回来。
   * ⇒ 改用 `parseZcodeBusinessCode`（见 `zcode-diagnostics.ts`），
   * 它是全仓库**唯一**的业务码解析口径。
   *
   * ## ② 读体必须被包住（`F4`：此前的「自身不抛」是错的）
   *
   * 原先写成 `await response.text().catch(() => '')` —— 若 `fetch` 返回了
   * **非 Response**（如 `null`，自定义 fetch / 被包装过的实现可能出现），
   * `response.text` 的**属性访问**就同步抛 `TypeError`，`.catch` 根本挂不上
   * ⇒ 整条穿透给调用方。真实 `fetch` 不会回 `null`，故生产影响≈0，
   * 但 `claimDailyWith` 依赖「这里不抛」来配平埋点计数，故仍把它兜住。
   */
  let text = ''
  let code: number | undefined
  let message: string | undefined
  try {
    text = await response.text()
  } catch {
    // 体流中断 / 响应对象异常 ⇒ 按「读不到正文」处理，不让它穿透。
    text = ''
  }
  try {
    const parsed = JSON.parse(text) as { code?: unknown; msg?: unknown; message?: unknown }
    code = parseZcodeBusinessCode(parsed.code)
    message = typeof parsed.msg === 'string' ? parsed.msg
      : typeof parsed.message === 'string' ? parsed.message : undefined
  } catch {
    /**
     * ⚠⚠ **边缘/CDN 的 HTML 错误页不得当文案倒给用户**（2026-10-07 审计打出）：
     * 原先这里是 `text.slice(0, 200)`，于是用户看到的「领取失败原因」是
     * `<!doctypehtml><html lang="zh-cn">…<style>a,body,div,h2,html,p{m` ——
     * 一坨 CSS 噪声，且随 CDN 配置变化，将来无法据此复盘。
     *
     * ⇒ 与推理侧 `describeUpstreamError` **共用同一份**判据与文案
     * （`zcode-diagnostics.ts` 是唯一出处，两侧不得各写一份）。
     */
    message = looksLikeZcodeHtmlPage(text)
      ? formatZcodeEdgePageHint(text, response.status)
      : text.slice(0, 200)
  }
  /**
   * ★★ **正文里的风控必须在这里（能看到完整正文的地方）归一成 `code`**
   * （真实缺陷，2026-10-05 审计 N1）。
   *
   * ## 缺陷
   *
   * 上面那条 `message = text.slice(0, 200)` 是为**展示**做的截断，但下游的
   * 判据（`isClaimUnusualActivity`）读的**正是 `message`** ⇒ 当网关正文的
   * 噪声超过 200 字符、而风控短语落在截断点**之后**时，判据看到的是被截掉的串：
   *
   * ```
   * 完整 body 长度=230，hasZcodeUnusualActivity(全body)=true
   * → code=undefined，message 长度=200，含风控短语=false
   * → claimRecognized=false   ← 真风控被降级成通用失败
   * ```
   *
   * 症状**正是本 issue 的原症状**（用户只看到一句看不懂的失败）。
   *
   * ## 修法
   *
   * 判据移到**本层**：这里持有完整 `text`，判得准。命中即把 `code` 归一成
   * `3012`，让下游统一走「有码 ⇒ 只信码」的路径 —— 与
   * `parseZcodeBusinessCode` 同一思路（**在信息最全的地方归一，而不是在
   * 已经丢过信息的下游猜**）。
   *
   * ⚠ **只在 `code` 缺失时兜底**：上游给了权威业务码就绝不覆盖
   *   （`{"code":1005,"msg":"quota 3012 exceeded"}` 必须仍是 1005）。
   * ⚠ 判据是 `hasZcodeUnusualActivity`（**语义短语为主**）——
   *   它本身已排除 `13012` / 限流里的毫秒数等误判形态。
   *
   * ⚠⚠⚠ **边缘/CDN 的 HTML 错误页必须豁免**（2026-10-07 审计打出，
   * 与推理侧 `zcode-adapter.ts` 修掉的是**同一个缺陷的领取侧**）：
   * 实测 `<html><body>request has been blocked due to unusual activity.</body></html>`
   * 既 `looksLikeZcodeHtmlPage` 为真、`hasZcodeUnusualActivity` 也为真 ⇒
   * `code` 被归一成 `3012` ⇒ `zcode-auth.ts` 的 `isClaimUnusualActivity` 命中
   * ⇒ **短路本账号剩余 plan**，文案写「冷却惩罚 30 分钟→24 小时→停用」。
   *
   * ⇒ 一次**边缘拦截**被报成「账号风控、别重试」，还跳过了本可领取的 plan ——
   * 与「稍后重试」的用户动作**完全相反**。
   */
  if (code === undefined && !looksLikeZcodeHtmlPage(text) && hasZcodeUnusualActivity(text)) {
    code = 3012
  }

  // 1003 = 已领取过 —— **幂等成功，不是错误**。
  const alreadyClaimed = code === 1003
  const ok = response.ok && (code === 0 || alreadyClaimed)
  /**
   * ★ `logid` 在**持有 `response` 与完整 `text` 的这一层**提取（2026-10-12）——
   * 与上面把风控归一成 `code` 同一条纪律：**在信息最全的地方取，
   * 不要在已经丢过信息的下游猜**。下游（`zcode-auth.ts` 的 `toClaimOutcome`）
   * 只拿得到 `message` 字符串，那里既没有 header、正文也可能已被截断。
   */
  const logId = extractZcodeLogId(text, response.headers)
  return {
    planId,
    code,
    ok,
    alreadyClaimed,
    httpStatus: response.status,
    message: message ?? (ok ? undefined : `HTTP ${response.status}`),
    ...logId === undefined ? {} : { logId },
  }
}

/**
 * 拉服务端下发的 captcha 配置。
 *
 * ⚠ `platform` 必须是 **`unknown`** —— 实测 `win32` / `win64` / `windows` /
 * `electron` / `desktop` / `linux` 一律 `400 {"code":3001}`。
 * `unknown` 正是官方在非 Electron 上下文的取值。
 *
 * 失败返回 `undefined`，由调用方回退到内置兜底值
 * （{@link ZCODE_CAPTCHA_FALLBACK}）—— **不让配置拉取失败阻塞推理**。
 */
export async function fetchZcodeCaptchaConfig(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeCaptchaConfig | undefined> {
  const appVersion = zcodeCredentialAppVersion(credential)
  const url = `${ZCODE_CLIENT_CONFIGS_URL}?app_version=${encodeURIComponent(appVersion)}&platform=unknown`
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}`, json: false, appVersion }),
    }, 20_000)
    if (!response.ok) return undefined
    const parsed = await response.json() as {
      data?: {
        configs?: {
          captcha?: {
            region?: unknown
            prefix?: unknown
            sceneId?: unknown
            enabled?: unknown
            skip_model_request?: unknown
          }
        }
      }
    }
    const captcha = parsed.data?.configs?.captcha
    if (captcha === undefined) return undefined
    const region = captcha.region
    const prefix = captcha.prefix
    const sceneId = captcha.sceneId
    if (typeof region !== 'string' || typeof prefix !== 'string' || typeof sceneId !== 'string') {
      return undefined
    }
    /**
     * ★ 两个开关**只在真的是布尔时**才写进返回值 —— 与官方
     * `getCaptchaConfig()` 的 `typeof r === 'boolean' ? { skipModelRequest: r } : {}`
     * **逐字同口径**。
     *
     * ⚠ 不能写成 `enabled: captcha.enabled === true` 这类强制布尔化：
     *   那会把「字段缺席（不知道）」压成 `false`，而 `requiresCaptchaUpfront`
     *   靠**区分**二者来决定要不要在首发抖一个 param。
     *   压平的方向恰好是危险侧：`enabled: false` 会一票否决、
     *   `skipModelRequest: false` 会让它每请求白烧一个设备级配额。
     */
    return {
      region,
      prefix,
      sceneId,
      ...typeof captcha.enabled === 'boolean' ? { enabled: captcha.enabled } : {},
      ...typeof captcha.skip_model_request === 'boolean'
        ? { skipModelRequest: captcha.skip_model_request }
        : {},
    }
  } catch {
    return undefined
  }
}

/**
 * 从上游拉**模型目录**（含上下文窗口、最大输出、思考档位、视觉能力）。
 *
 * ## ⚠ 为什么要真拉，不能照抄兜底表
 *
 * **真实缺陷**（用户报障）：模型配置页里上下文窗口显示 **1,000,000**、
 * 最大输出 **128,000**，而思考档位选择器**根本没出现** —— 尽管 ZCode IDE
 * 里可以设置。
 *
 * 兜底表当时填的是 `200_000` / `32_768`（**凭空估的**），且模型都标了
 * `supportsImage: true`（但上游说只有 Flash 有 `capabilities.vision`）。
 * ⇒ 这类「能力字段」必须**抄上游**，不能按「同族应该一样」推断。
 *
 * ## 上游形状（`GET /api/v1/client/configs` 的 `data.builtinModels`）
 *
 * ⚠ `builtinModels` 是**对象**（key 不是模型 id，实测为序号字串），
 * 故必须 `Object.values(...)` 而不是数组下标。实测两条：
 *
 * ```json
 * { "modelId": "GLM-5.3-Flash", "contextWindow": 1000000,
 *   "maxCompletionTokens": 128000,
 *   "capabilities": { "vision": true },
 *   "modalities": { "input": ["text","image","video"], "output": ["text"] },
 *   "reasoning": { "levels": { "low": {...}, "max": {...}, "high": {...} },
 *                  "defaultLevel": "max" } }
 * ```
 *
 * ⚠ `reasoning.levels` 的**键序**就是官方展示顺序（实测 low → max → high
 * 的插入序，但客户端按 `low/high/max` 渲染 —— 故我们**显式排序**为
 * `low → high → max`，与 IDE 截图一致；未知档位排在后面保持原序）。
 *
 * 失败返回 `undefined`，由调用方回退兜底表（**不让目录拉取失败让 provider 不可用**）。
 */
export async function fetchZcodeModels(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeRemoteModelLike[] | undefined> {
  const appVersion = zcodeCredentialAppVersion(credential)
  const url = `${ZCODE_CLIENT_CONFIGS_URL}?app_version=${encodeURIComponent(appVersion)}&platform=unknown`
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}`, json: false, appVersion }),
    }, 20_000)
    if (!response.ok) return undefined
    const parsed = await response.json() as { data?: { builtinModels?: unknown } }
    const raw = parsed.data?.builtinModels
    if (typeof raw !== 'object' || raw === null) return undefined
    /**
     * ⚠ `builtinModels` 是**对象**（键为序号）—— 实测：
     * `{"0": {...GLM-5.3}, "1": {...GLM-5.3-Flash}}`。
     * 用 `Array.isArray` 判定会得到「0 个模型」的**假阴性**。
     */
    const entries = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>)
    const models: ZcodeRemoteModelLike[] = []
    for (const item of entries) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const id = record.modelId ?? record.id
      if (typeof id !== 'string' || id.length === 0) continue
      const contextWindow = num(record.contextWindow)
      const maxCompletionTokens = num(record.maxCompletionTokens ?? record.maxTokens)
      const capabilities = record.capabilities
      const vision = typeof capabilities === 'object' && capabilities !== null
        ? (capabilities as { vision?: unknown }).vision === true
        : false
      /** 档位：按 IDE 的展示序 `low → high → max`，未知档位按原序排后面。 */
      const reasoning = record.reasoning
      let reasoningLevels: string[] | undefined
      let defaultReasoningLevel: string | undefined
      if (typeof reasoning === 'object' && reasoning !== null) {
        const levels = (reasoning as { levels?: unknown }).levels
        if (typeof levels === 'object' && levels !== null) {
          const keys = Object.keys(levels as Record<string, unknown>)
          if (keys.length > 0) reasoningLevels = orderReasoningLevels(keys)
        }
        const def = (reasoning as { defaultLevel?: unknown }).defaultLevel
        if (typeof def === 'string' && def.length > 0) defaultReasoningLevel = def
      }
      models.push({
        id,
        name: typeof record.name === 'string' && record.name.length > 0 ? record.name : id,
        // 缺字段时给保守值（0 会让 DSH 认为无窗口）。
        contextWindow: contextWindow !== undefined && contextWindow > 0 ? contextWindow : 200_000,
        maxTokens: maxCompletionTokens !== undefined && maxCompletionTokens > 0
          ? maxCompletionTokens
          : 32_768,
        supportsImage: vision,
        ...reasoningLevels !== undefined ? { reasoningLevels } : {},
        ...defaultReasoningLevel !== undefined ? { defaultReasoningLevel } : {},
      })
    }
    return models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/**
 * 把档位键排成 IDE 的展示序。
 *
 * ⚠ **不能直接用对象的键序**：上游 JSON 里 `levels` 的插入序实测是
 * `low, max, high`，而 IDE 的档位条显示 `low, high, max`（用户截图为证）。
 * 已知档位按 `low → medium → high → xhigh → max` 排，未知的按原序追加。
 */
function orderReasoningLevels(keys: readonly string[]): string[] {
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const known = order.filter((level) => keys.includes(level))
  const unknown = keys.filter((key) => !order.includes(key))
  return [...known, ...unknown]
}
