import { MARVIS } from './marvis-product.js'

/**
 * marvis 槽序的「会话分散」门控（PR #190 双审计返工：从 `src/index.ts` 抽出）。
 *
 * 为什么要抽出来：原实现是 `src/index.ts` 装配块里的一个内联 `if`，而它的守卫
 * **全是源码文本断言**（`readFileSync` + `toMatch`）。审计实测三种真实失效都绿：
 *
 * - `if (false && sessionId !== undefined && …)` —— 两个子串仍在；
 * - `pool.orderAccountsForSession(…); return slots`（丢弃结果）—— 调用仍在；
 * - `!pool.sessionBalanceEnabled()`（反向读）—— 名字仍在。
 *
 * 这正是本仓反复踩的那条红线：**源码文本断言挡不住「留着但失效」**。判定搬进
 * 纯函数后，三种失效都会落到行为级用例上（`tests/unit/marvis-slot-ordering.spec.ts`）。
 *
 * ⚠️ 语义（与 `src/account-pool.ts` 的 `orderAccountsForSession` JSDoc 一致）：
 * - `sessionId` 空/未传 ⇒ **原样返回**，不洗牌（槽制的「第一个」是稳定性保证）；
 * - 面板开关关 ⇒ **原样返回**（面板文案「关闭后回到『手动顺序优先』的选号方式」
 *   的实现依据）；
 * - 否则 ⇒ 交给池按 rendezvous 哈希 + 溢出沉底重排。
 *
 * ⚠️ 本函数**不做**候选过滤（`enabled` / 封禁 / 模型限流）—— 那是调用方的事
 * （`src/index.ts` 的 `usable` 链已经滤过一遍）。
 *
 * ⚠️⚠️ **已知限制（不要在别处偷偷补）**：本地 OpenAI 网关进来的请求没有
 * `sessionId`（`src/openai-gateway/messages.ts` 的 `toGenerateOptions` 不设它，
 * 因为网关是无状态的、请求体里没有可信的会话标识）⇒ 走第一个分支原样返回 ⇒
 * **网关流量仍是「1 主 N 备」**。审计建议「在网关侧给 `GenerateOptions` 补
 * `sessionId`」，本 PR **不做**，理由见 `docs/agent-notes/providers-marvis.md`
 * 的已知限制节：`options.sessionId` 在本仓被 **18 个文件 / 48 处**读取，包括
 * `src/codely-sign.ts` 会把它**上行**成 `x-litellm-session-id` 头、
 * `src/gemini-adapter.ts` 以「显式钉了 sessionId ⇒ 不升代恢复」为判据 ——
 * 把一个客户端可控的串塞进 `sessionId` 是跨渠道的行为变更，必须单独一个 PR
 * + 独立审计，不能夹在这里。
 */
export interface SlotOrderingPool {
  sessionBalanceEnabled(): boolean
  orderAccountsForSession<T extends { readonly id: string }>(
    provider: string,
    accounts: readonly T[],
    sessionId?: string,
  ): T[]
}

export function orderMarvisSlots<T extends { readonly id: string }>(
  pool: SlotOrderingPool,
  slots: readonly T[],
  sessionId: string | undefined,
): readonly T[] {
  if (sessionId === undefined || sessionId.length === 0) return slots
  if (!pool.sessionBalanceEnabled()) return slots
  return pool.orderAccountsForSession(MARVIS.id, slots, sessionId)
}
