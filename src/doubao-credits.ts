/**
 * 豆包（Doubao，字节跳动）积分/额度余额与每日签到（薄壳）。
 *
 * ## 实测结论（2026-11-03 签到 / 2026-11-22 额度，真机接通）
 *
 * - **签到端点**：`POST https://www.doubao.com/alice/ug/campaign/landing/checkin`
 *   （公共 query 见 `src/doubao.ts` 的 `doubaoCheckinQuery`），body
 *   `{"scene":"pc_incentive_task_mvp_v3"}`，响应
 *   `{data:{checked_in,checkin_date,continuous_days,idempotent,reward_amount,…},code:0}`。
 * - **鉴权 = cookie**（`sessionid`/`sid_tt`/`ttwid` 等），无 `Authorization`。
 * - **签名 = query 的 `a_bogus`**，由豆包页面上下文的 `window.bdms.frontierSign` 生成
 *   （`bdms` 只在 doubao.com 页面里存在）⇒ **签到必须走 CDP 页面会话**，
 *   纯 Node fetch 产不出合法 `a_bogus`（实测裸 fetch 恒 `710010702 系统错误`）。
 * - **幂等**：`idempotent: true`（重复调用安全，今日已签会回 `checked_in:true`）。
 *
 * ## ⚠️ 2026-11-22 更正：「豆包无余额概念」是错的
 *
 * 旧注释写「豆包没有积分/额度余额概念，余额查询如实回 null」——
 * **那只对签到口径成立**。豆包账号面板确实有额度：
 * `POST /alice/commerce/sale/subscription/quota/summary/` 真机回
 * `{ data: { current_subscription: { display: { short_name: "免费体验" } },
 *   incentive_quota_section: { window_limit_groups: [{ feature_group_name: "活动赠送额度",
 *   window_limits: [{ total_amount: "1,600", used_amount: "<1", end_time: … }] }] } }, code: 0 }`。
 * 这些是**真实额度窗口**，本模块如实读出来，不再回 null。
 * 协议细节（header/query/解析）见 `src/doubao-upstream.ts`。
 *
 * ## 模块分工
 *
 * - 本文件：**余额**（真实读 quota）+ **签到薄壳**（把凭据转给 `doubao-signin.ts`）；
 * - `src/doubao-upstream.ts`：额度/模型/对话三条腿的共享协议；
 * - `src/doubao-signin.ts`：真正的 **CDP 页面会话驱动**（起豆包内核 + 挂其 User Data，
 *   在页面里用 `bdms.frontierSign` 签名再领取）。签名逻辑只在那一份，别在这里抄。
 *
 * @module src/doubao-credits.ts
 */

import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'
import type { DoubaoCredential } from './doubao.js'
import {
  DOUBAO_HTTP_TIMEOUT_MS,
  DOUBAO_QUOTA_PATH,
  DOUBAO_WEB_BASE_URL,
  doubaoHeaders,
  doubaoQuery,
  doubaoSubscriptionName,
  doubaoQuotaWindows,
  parseDoubaoEnvelope,
} from './doubao-upstream.js'

// ── 余额：真实读 quota/summary ──

/**
 * 拉取豆包账号额度（`fetchBalanceDetailed` 形态：失败自带可读原因）。
 *
 * ⚠️ 请求由**凭据里的 cookie** 发，不用全局 fetch 的隐式 cookie jar。
 */
export async function fetchDoubaoBalanceDetailed(
  credential: DoubaoCredential,
): Promise<{ balance: CreditBalance | null; error?: string }> {
  if (typeof credential?.cookie !== 'string' || credential.cookie.length === 0) {
    return { balance: null, error: '没有可用的豆包登录会话（请先在账号卡上完成登录）' }
  }
  const url = DOUBAO_WEB_BASE_URL + DOUBAO_QUOTA_PATH + '?' + doubaoQuery(credential).toString()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: doubaoHeaders(credential.cookie, { 'Content-Type': 'application/json' }),
      body: '{}',
      signal: AbortSignal.timeout(DOUBAO_HTTP_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { balance: null, error: '豆包额度查询返回 HTTP ' + response.status }
    }
    const raw = await response.text()
    const env = parseDoubaoEnvelope(raw)
    if (env === undefined) {
      return { balance: null, error: '豆包额度查询响应不是 JSON' }
    }
    if (typeof env.code === 'number' && env.code !== 0) {
      return { balance: null, error: '豆包额度查询失败：上游错误 ' + env.code }
    }
    const windows = doubaoQuotaWindows(env)
    if (windows.length === 0) {
      return { balance: null, error: '豆包额度查询未返回可用窗口（账号可能没有活动额度）' }
    }
    const subscription = doubaoSubscriptionName(env)
    const packages: CreditPackage[] = windows.map((w) => ({
      name: w.featureGroupName || w.featureGroup || '豆包额度',
      unit: '额度',
      total: w.total,
      remaining: Math.max(0, w.total - w.used),
      used: w.used,
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: w.endTime !== undefined ? new Date(w.endTime).toISOString() : '',
      totalKnown: true,
      ...(subscription !== undefined ? { description: subscription } : {}),
    }))
    const remaining = packages.reduce((sum, p) => sum + p.remaining, 0)
    return {
      balance: {
        total: remaining,
        packages,
        expiredTotal: 0,
      },
    }
  } catch {
    // 底层异常可能附带登录态或请求参数，不传给账号页。
    return { balance: null, error: '豆包额度查询失败：无法读取上游响应' }
  }
}

// ── 签到：薄壳，转发给 CDP 页面会话驱动 ──

/**
 * 执行豆包每日签到领取。
 *
 * 真正的 CDP 页面会话驱动在 `src/doubao-signin.ts` 的 `claimDoubaoDailyViaPage`
 * （起豆包内核 + 挂其 User Data，在页面里用 `bdms.frontierSign` 签名再领取）。
 * 本函数是它的薄壳：把凭据原文转过去。
 *
 * ⚠️ 凭据必须带 `cookie`（登录会话）；没有它 ⇒ `inactive`（不发请求）。
 */
export async function claimDoubaoDailyCheckin(
  credential: DoubaoCredential,
): Promise<ClaimOutcome> {
  if (typeof credential?.cookie !== 'string' || credential.cookie.length === 0) {
    return { kind: 'inactive', message: '没有可用的豆包登录会话（请先在账号卡上完成登录）' }
  }
  const { claimDoubaoDailyViaPage } = await import('./doubao-signin.js')
  return claimDoubaoDailyViaPage(JSON.stringify(credential))
}
