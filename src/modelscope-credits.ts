/**
 * ModelScope（魔搭）**魔粒余额**查询。
 *
 * ## 数据来源
 *
 *     GET https://www.modelscope.cn/openapi/v1/magicubes/balance
 *     Authorization: Bearer <ms-…>
 *     → {"success":true,"data":{"total_balance":281,"available_balance":281,"frozen_amount":0}}
 *
 * ## ⚠️⚠️ 这个端点是怎么找到的（务必留档，否则会被当成「已穷尽探测」）
 *
 * 本仓库与 PR 作者都曾判定「魔搭没有额度查询 API」，并把 `credits.balance`
 * 登记为 `false`。**那个结论是错的**，错在两处：
 *
 * 1. **前缀漏了**：那批探测只试过 `/api/v1/*` 与 `/v1/*`，而真端点在
 *    **`/openapi/v1/*`**。⇒ 用错前缀时它落在 SPA 的 catch-all 路由上，
 *    对**任何**路径都回 `200 text/html`（本仓库在 accio 记过同款「假 200」）
 *    或 404，两种都会让人误判成「不存在」。
 * 2. **静态扫 bundle 找不到**：前端主 bundle（`umi.js`，10MB）里 179 条
 *    `/v1/` 路径中**没有**它，「魔粒」二字也只出现 1 次（在 i18n 文案里）。
 *    它藏在按需加载的 chunk 中 ⇒ **只能靠抓真实网络请求定位**。
 *
 * 定位过程（可复现）：CDP 监听 `/my/overview` 的 XHR → 首页页头有个
 * `<button>` 显示余额 → React fiber 上组件名是 `MagicCubeButton`、
 * props 是 `{isLogin, balance}` → 硬刷新并在全部响应体里搜字段名，
 * 命中 `/openapi/v1/magicubes/balance`。
 *
 * ## ⚠️ 为什么 `balance` **可以**用 API Key（推翻了「必须网页会话」的中间结论）
 *
 * 曾一度以为账户体系只认网页登录会话（`/api/v1/users/info` 在 API Key 下报
 * `400 获取用户信息失败`）。但**魔粒这个端点不同** —— 实测三种认证：
 *
 * | 认证 | 结果 |
 * |---|---|
 * | `Authorization: Bearer <ms-key>` | **200，返回真实余额** |
 * | 网页会话 cookie | 200，同一数值 |
 * | 无凭据 | **401 `InvalidAuthentication`** |
 *
 * ⇒ 它**确实在校验凭据**（不是公开端点，这一条符合仓库「目录能读 ≠ 凭据有效」
 * 的纪律要求），且**API Key 就够** ⇒ 因此**不需要**网页登录态、**不需要**
 * 采集 cookie、**不需要**起浏览器。
 *
 * ## ⚠️ 「它是真余额」的判据是**实测会随消耗下降**，不是字段名像余额
 *
 * 实测：读数 281 → 发 2 次推理（旗舰档每次扣 2 魔粒）→ 再读 277，**恰好 -4**。
 * ⚠️ 对照组：`/api/v1/quota/status` 虽然也带 `Quota` 字样且 API Key 能读，
 * 但它是**任务奖励**（点赞/分享/绑定云账号），发 3 次推理后数值**逐字节不变**
 * ⇒ 字段名像余额**不等于**是余额。这类判据必须用「会不会随消耗变化」来分。
 *
 * @module src/modelscope-credits.ts
 */

import { modelscopeHeaders } from './modelscope.js'
import type { ModelscopeCredential } from './modelscope.js'
import { modelscopeDailyGrantExpiry } from './modelscope-checkin.js'
import { roundCredits, type CreditBalance, type CreditPackage } from './credits.js'
import { MODELSCOPE, type ModelscopeProduct } from './modelscope-product.js'

/**
 * 上游余额报文（只取用得到的字段，其余忽略）。
 *
 * ⚠️ **绝不容忍缺字段**：本仓库红线「绝不编造数字」——
 * `total_balance` 缺失时必须判失败，**不得**回落成 `0`（0 的语义是「已用光」）。
 */
interface RawMagicubeBalance {
  success?: unknown
  data?: {
    total_balance?: unknown
    available_balance?: unknown
    frozen_amount?: unknown
  }
}

/** 保留魔粒的小数部分；不是有限非负数时返回 `undefined`（表示「读不到」）。 */
function readAmount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return roundCredits(value)
}

/**
 * 拉取魔粒余额。
 *
 * ## ⚠️ 为什么用 `fetchBalanceDetailed` 而不是 `fetchBalance`
 *
 * 三种失败的**用户动作完全不同**，压成笼统的「余额查询失败」会误导：
 *
 * - `401` ⇒ **Key 无效 / 没配凭据** ⇒ 用户该去控制台重新生成；
 * - `200 + success:false` ⇒ **Key 有效但该端点拒绝**（如账号未实名）⇒ 换 Key 没用；
 * - `200 + 缺 total_balance` ⇒ **上游改版** ⇒ 该报「读数格式变了」，而不是「余额 0」。
 *
 * ⚠️ 「魔粒需完善个人信息后才可用」是魔搭的真实规则（前端 i18n 原文：
 * 「重要提示：为保障账号正常使用，请完善个人信息（包括验证邮箱），平台魔粒需在
 * 个人信息完善后方可使用」）⇒ 未实名账号读不到是**预期**，不是故障。
 */
export async function fetchModelscopeBalanceDetailed(
  credential: ModelscopeCredential,
  product: ModelscopeProduct = MODELSCOPE,
): Promise<{ balance: CreditBalance | null; error?: string }> {
  const apiKey = credential?.access_token
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return { balance: null, error: '没有可用的 API Key' }
  }

  let response: Response
  try {
    response = await fetch(product.balanceUrl, {
      method: 'GET',
      headers: {
        ...modelscopeHeaders(apiKey, 'application/json'),
        referer: 'https://www.modelscope.cn/my/overview',
      },
      signal: AbortSignal.timeout(product.balanceTimeoutMs),
      redirect: 'error',
    })
  } catch (error) {
    // ⚠️ 只报可读原因，不把整段 fetch 错误糊给用户。
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? '请求超时'
      : '网络请求失败'
    return { balance: null, error: `魔粒余额查询失败：${reason}` }
  }

  const text = await response.text().catch(() => '')

  if (response.status === 401) {
    return { balance: null, error: 'API Key 无效或已失效（魔搭返回 401），请到 modelscope.cn 重新生成访问令牌' }
  }

  let body: RawMagicubeBalance
  try {
    body = JSON.parse(text) as RawMagicubeBalance
  } catch {
    return {
      balance: null,
      error: `魔粒余额响应不是 JSON（HTTP ${response.status}）`,
    }
  }

  if (!response.ok || body?.success !== true) {
    // ⚠️ `success:false` 与「Key 无效」是**两回事**：这里 Key 大概率是有效的，
    //    是端点侧拒绝（常见于账号未完善个人信息/未实名）。
    return {
      balance: null,
      error: `魔搭未返回魔粒余额。若该账号刚注册，可能需要先在 modelscope.cn 完善个人信息并实名认证（平台规则：魔粒需个人信息完善后方可使用）`,
    }
  }

  const total = readAmount(body.data?.total_balance)
  if (total === undefined) {
    // ⚠️ **刻意不回落成 0**：0 的语义是「额度已用光」，而这里是「读不到数字」。
    return { balance: null, error: '魔搭响应里没有 total_balance 字段（上游可能改版），无法显示余额' }
  }

  const available = readAmount(body.data?.available_balance) ?? total
  // ⚠️ `frozen_amount`（冻结中，实测恒为 0）**刻意不呈现**：`CreditBalance`
  //    只有 total/packages/expiredTotal 三个字段，**没有**放冻结额的位置。
  //    而 `expiredTotal` 的语义是「已失效包的剩余」—— 塞进冻结额会让 UI 标成
  //    「已失效 N」，那是**错的语义**（冻结 ≠ 失效）。实测恒 0，故当前不影响
  //    正确性；将来若它非 0，需要**扩契约**而不是复用错字段。
  //    ⚠️ 主动扩 `CreditBalance` 会牵动全部渠道的读数与对拍用例，故不在此擅动。

  // ⚠️ 单个包：`total_balance` 即全部可用额度。
  //    `frozen_amount`（冻结中）**不并入** total —— 它不可用于扣费，
  //    并进去会让用户以为自己还有那么多可用（与 `CreditBalance.expiredTotal`
  //    存在的理由同源：分开给，不并）。
  const packages: CreditPackage[] = [{
    name: '魔粒',
    total,
    used: roundCredits(Math.max(0, total - available)),
    remaining: available,
    unit: 'credit',
    active: true,
    /**
     * ⚠️⚠️ **必须显式 `false`（PR #83 正向审计 P2-6，2026-11-15）。**
     *
     * 上游只给「当前可用余额」（`available_balance`），**没有**初始总额 ——
     * `total` 与 `remaining` 在这里是同一个数。若标 `true`（缺省），面板会把
     * 两者并列显示成 `277 / 277`，而每消耗一点就变成 `275 / 275` ——
     * 正是用户 2026-11-05 报障的「**分母跟着余额跑**」的假读数
     * （见 `src/credits.ts` 的 `CreditPackage.totalKnown` 契约原文与
     * `plugin-src/client/jet-hub.js` 的红线：`totalKnown:false` 的包必须让
     * 「总积分」退化成 `—`）。
     *
     * 命中同款的另两家：`baizhi` / `monkeycode`。
     */
    totalKnown: false,
    // ⚠️ 三个时间字段对魔搭**没有意义**（上游不下发任何时间），填空串 = 「不适用」，
    //    与 trae / raccoon / qoder / lobsterai / gemini / codearts / loomy /
    //    accio / cline **十家逐一相同**的写法一致。
    //    ⚠️ **刻意不编造**具体日期：本仓库红线「绝不编造数字」——宁可让 UI 按
    //    「无周期概念」渲染，也不要写一个看似真实的过期时间。
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }]

  // 余额是聚合标量，发放记录不能证明某笔还有多少剩余。
  const dailyGrantExpiresAt = available > 0
    ? await modelscopeDailyGrantExpiry(apiKey).catch(() => undefined)
    : undefined

  return {
    balance: {
      total: available,
      ...(dailyGrantExpiresAt === undefined ? {} : { dailyGrantExpiresAt }),
      packages,
      expiredTotal: 0,
    },
  }
}