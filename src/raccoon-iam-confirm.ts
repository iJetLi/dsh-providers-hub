/**
 * ★★★ **Raccoon（商汤小浣熊）的 IAM 业务会话确认**（issue #147）。
 *
 * ## 缺陷
 *
 * 2026-11-14 起扫码登录整体迁到 **IAM**（`POST /api/iam/v1/auth/mp/qrcode*`，
 * 本仓 `raccoon-oauth.ts` 已跟进），由此换回的 `access_token` 是一枚 **IAM 令牌**
 * （JWT `iss` 以 `/iam` 结尾）—— **它不能直接调用业务 API**：业务侧要求先执行一次
 * 「业务会话确认」建立会话。
 *
 * 症状（issue 实测，真实凭据）：登录本身成功、token 已落库，但账号**完全不可用** ——
 * 五个业务端点全部返回
 *
 * ```
 * HTTP 400 {"code":200901,"message":"iam_confirm_required","details":"IAM confirmation required"}
 * ```
 *
 * | 端点 | 用途 |
 * |---|---|
 * | `GET /api/web/points/v1/balance` | 积分余额 |
 * | `GET /api/web/points/v1/bills` | 账单 / 登录奖励 |
 * | `GET /api/web/auth/v1/user_info` | 登录后补昵称 |
 * | `GET /api/web/llm/v2/model_catalog` | 模型目录 |
 * | `POST /api/web/llm/v2/chat/completions` | 对话 |
 *
 * ## 官方形态（issue 从 Web 端 chunk 逆向 + 真机验证）
 *
 * ```js
 * POST /api/web/auth/v1/iam/confirm
 * headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${iamToken}` }
 * body: JSON.stringify(context)   // 常规场景为空对象
 * // 成功判据：HTTP 2xx 且 body.code === 0
 * ```
 *
 * 真机对照（同一凭据、同一端点）：
 *
 * ```
 * 确认前：GET /points/v1/balance → 400 {"code":200901}
 * 确认后：GET /points/v1/balance → 200 {"available_points":6894, "reward_points":6000}
 * ```
 *
 * ## 本实现的四条约束
 *
 * 1. **幂等 + 按令牌去重**：进程内 `Set` 记住已确认的 `access_token`，
 *    并发/重复调用**只发一次**请求。续期后 token 变化 ⇒ 自然触发对新令牌的再确认。
 * 2. **失败不抛错**：返回 `false`，调用方按原路径继续 —— 确认失败时业务 API 自身
 *    会返回 `200901`，那个错误比我编的更准确（也带 `details`）。
 * 3. **失败不记入去重集**：下次调用仍会尝试（否则一次瞬时失败会让该令牌永久跳过确认）。
 * 4. **只发这一条腿**：不重试、不换号、不改任何既有请求头 —— 它是一次**前置握手**。
 */
import { isRaccoonIamToken } from './raccoon-authorize.js'
import type { RaccoonProduct } from './raccoon-product.js'
import { raccoonHeaders, type RaccoonCredential } from './raccoon.js'

/**
 * 已确认过的 `access_token`（进程内）。
 *
 * ⚠️ 用 **token 本身**作键、不用账号 id：续期后 token 变了就必须重新确认，
 * 而账号 id 不变 —— 拿 id 去重会**跳过续期后的必要确认**。
 *
 * ⚠️ 上限：一个进程内实际只会出现「当前活跃账号数 × 续期次数」个 token，
 * 量级极小，故不做 LRU。真要防泄漏再加，别为此把逻辑复杂化。
 */
const confirmedTokens = new Set<string>()

/** 仅供测试：清空去重集合（生产路径不会调用）。 */
export function resetRaccoonIamConfirmCacheForTest(): void {
  confirmedTokens.clear()
}

/**
 * 确保该凭据的业务会话已确认。**永不抛错**，返回是否「已确认」。
 *
 * ⚠️ 调用点应当**忽略返回值**直接继续（确认失败时业务 API 会给出更准的错误），
 *    只有需要诊断时才读它。
 */
export async function ensureRaccoonSessionConfirmed(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch,
): Promise<boolean> {
  const token = credential.access_token
  if (typeof token !== 'string' || token.length === 0) return false
  /**
   * ★★★ **只有 IAM 令牌才需要确认**（2026-11-23 修正，第一版漏了这道闸）。
   *
   * issue #147 的前提是「扫码登录**迁到 IAM 之后**换回的令牌是 IAM 令牌」——
   * 2026-11-14 之前签发的**旧令牌不是**，它们本来就能直接调业务 API。
   *
   * ⚠️ 第一版对**所有**令牌都打 `iam/confirm`，实测**打红了一整批既有 raccoon 用例**
   *    （`stream` 的 `fetchImpl` 桩被多调用一次、401 刷新那条直接走错分支）。
   *    那不只是测试问题：对旧令牌多发一条无意义请求，也是**每次请求**的额外往返。
   *
   * ⚠️ 判定复用 `raccoon-authorize.ts` 里那个**已有**的 `isRaccoonIamToken`
   *    （查 JWT 的 `iss` 是否以 `/iam` 结尾）—— 不新写一套判据（本仓红线）。
   *
   * ⚠️ 非 IAM 令牌返回 `true`：语义是「**不需要**确认」，不是「确认失败」。
   */
  if (!isRaccoonIamToken(token)) return true
  if (confirmedTokens.has(token)) return true

  const url = `${product.apiBase}${product.authApiPrefix}/iam/confirm`
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: raccoonHeaders(credential, {
        platform: product.clientPlatform,
        version: product.clientVersion,
      }),
      // ⚠️ 官方是 `JSON.stringify(context)`，常规场景为空对象 ⇒ 逐字发 `{}`。
      body: '{}',
    })
    if (!response.ok) return false
    // 判据与官方一致：HTTP 2xx **且** `body.code === 0`。
    const payload = await response.json() as { code?: unknown } | null
    if (payload === null || typeof payload !== 'object') return false
    if (typeof payload.code === 'number' && payload.code !== 0) return false
    // ⚠️ **只有成功才记入去重集** —— 失败记进去会让该令牌永久跳过确认。
    confirmedTokens.add(token)
    return true
  } catch {
    // ⚠️ 传输错误可能是 HTTPS 检查代理或瞬时故障；**不抛**、不记入、下次再试。
    return false
  }
}
