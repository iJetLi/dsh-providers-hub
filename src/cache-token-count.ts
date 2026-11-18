/**
 * 读取上游的「缓存读取量」计数，区分三态：
 *
 * - `undefined` = 上游没上报（字段缺席 / 类型不对 / 负数）
 * - `0`         = 上游明确报了「这次没命中缓存」
 * - `> 0`       = 命中量
 *
 * ⚠️ 这三个状态**不能折叠**：网关要把它们翻成三种不同的 wire 形态
 * （Chat 省略 `prompt_tokens_details` / Responses 补 `cache_read_reported: false`），
 * 而「明确 0」与「未上报」折叠后逐字节相同（issue #121）。
 *
 * ⚠️ 判据必须与 `llm-register-compat.ts` 的 `readCount()`、`token-ledger.ts` 的
 * `clampCount()` 同口径（`Number.isFinite` + `Math.trunc`），**不要用
 * `Number.isSafeInteger`**：那会把浮点与超界值一起判成「未上报」，而这两类在旧
 * 口径下是「截断后计入 inputTokens」的 —— 实测 `{inputTokens:60, cacheReadTokens:40.5}`
 * 会让 `totalTokens` 从 102 掉到 62（漏算），与 `usage.ts` 里「只会多算、绝不漏算」
 * 的红线相反。各家官方 schema 都声明该字段为 int ⇒ 浮点属防御性输入，但防御也要
 * 与既有口径一致，不能引入比旧代码更差的格。
 */
export function readCacheTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined
}
