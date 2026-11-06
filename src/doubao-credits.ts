/**
 * 豆包（Doubao，字节跳动）积分余额与每日签到（薄壳）。
 *
 * ## 实测结论（2026-11-03，真机接通）
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
 * - **无独立余额端点**：豆包没有积分/额度余额概念（签到给的是「每日额度」权益，
 *   非积分包）⇒ 余额查询如实回 `null`。
 *
 * ## 模块分工
 *
 * - 本文件：**余额**（如实回 `null`）与**签到薄壳**（把凭据转给 `doubao-signin.ts`）；
 * - `src/doubao-signin.ts`：真正的 **CDP 页面会话驱动**（起豆包内核 + 挂其 User Data，
 *   在页面里用 `bdms.frontierSign` 签名再领取）。签名逻辑只在那一份，别在这里抄。
 *
 * @module src/doubao-credits.ts
 */

import type { ClaimOutcome, CreditBalance } from './credits.js'
import type { DoubaoCredential } from './doubao.js'

export const DOUBAO_HTTP_TIMEOUT_MS = 15_000

// ── 余额：如实回 null（无余额端点，不编造）──

/**
 * 拉取豆包积分余额（`fetchBalanceDetailed` 形态：失败自带可读原因）。
 *
 * ## 为什么恒回 `null`（不是 0，也不是编造的端点）
 *
 * 豆包**没有积分/额度余额概念**：签到给的是「每日额度」权益（每日对话次数），
 * 不是可累积的积分包。仓库红线是「上游不下发 ⇒ 我们不编造」⇒ 余额如实回 `null`，
 * 文案说明「无积分余额概念」，而不是发一次猜出来的请求。
 */
export async function fetchDoubaoBalanceDetailed(
  credential: DoubaoCredential,
): Promise<{ balance: CreditBalance | null; error?: string }> {
  if (typeof credential?.cookie !== 'string' || credential.cookie.length === 0) {
    return { balance: null, error: '没有可用的豆包登录会话（请先在账号卡上完成登录）' }
  }
  // 豆包没有积分余额概念，如实回 null（不落 0，0 是「已用光」的语义）。
  return { balance: null, error: '豆包无积分余额概念（签到给的是每日额度权益，非积分包）' }
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
