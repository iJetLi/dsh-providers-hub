/**
 * 「这是**上游网关**故障」的**唯一判据**（2026-11-21，GitHub issue #130）。
 *
 * ## 为什么必须只有一份
 *
 * 本仓库已有多家适配器各自面对同一个形态：上游网关返回 HTML 错误页
 * （`<html>…<title>504 Gateway Time-out</title>…openresty/1.15.8.2</html>`）
 * 或「服务暂时不可用」。
 *
 * 这个字符串判据原先只长在 `qoder-adapter.ts` 里（2026-10-20 对抗审计加的：
 * 扫本机 **1374 个会话 / 163 条真实 qoder 失败**，`504 Gateway Time-out` **74 次**
 * + `First Token Timeout` **6 次** 全落 `other` ⇒ 不换号、还因终态 `SERVER`
 * 被宿主白重试 5 次）。
 *
 * ⇒ 两处会漂移的写法都被本仓库明令禁止（「一文件两套同义判据」是红线），
 *   而 loomy 的 issue #130 正是这条红线被违反的后果：同一份报文在 qoder 上
 *   判 `upstream`、在 loomy 上判 `other`（实测 23 次/单会话）。
 *
 * ## 口径（窄，刻意窄）
 *
 * **只认网关/上游的字面形态**，不认泛化的 `server error` / `timeout`。
 * 理由：`400 参数错` 的文案里也可能带 "gateway"/"upstream" 字样，一旦泛化就会
 * 把确定性失败判成「可换号」⇒ 逐个号重打一遍、白烧整池（本仓库 2026-10-06 的
 * 「全池被封」事故就是放开了错误类别的后果）。
 *
 * ⚠️ 调用方**还必须**自己加 `status >= 500` 之类的状态码闸门 —— 本函数只回答
 * 「文案像不像上游故障」，不知道 HTTP 状态。loomy/raccoon 的分类器就是
 * `status >= 500 && looksLikeUpstreamProviderError(text)` 两段合判。
 *
 * @param text - 失败报文（大小写不敏感；调用方传原文即可，内部不自作 lower）。
 * @returns true = 看起来是上游网关/超时故障。
 */
export function looksLikeUpstreamProviderError(text: string): boolean {
  if (/provider_error|provider\s+error|upstream\s+(?:provider\s+)?error|error\s+in\s+upstream\s+response/i.test(
    text,
  )) return true
  /**
   * 网关 5xx：HTML 错误页（`504 Gateway Time-out` / `502 Bad Gateway`）、
   * 上游超时（`First Token Timeout or Upstream Timeout`）、以及**中文网关文案**。
   *
   * ## ⚠️ 中文那两条是 loomy issue #130 的**主体形态**，第一版漏了
   *
   * 报障者实测的 23 次里 **18 次**是 `503 + 该模型服务暂时不可用，请切换其他模型试试`
   * —— 只有英文 `service unavailable` 是不够的。我第一版只写了英文，重跑探针时
   * `classifyLoomyFailure(中文文案, 503)` 仍是 `other`（当场发现并补上）。
   *
   * ⚠️ 口径仍**窄**：只认「暂时不可用」「服务不可用」这两种**确定性**的字面，
   * 不收「不可用」「失败」「超时」这类泛词 —— 400 参数错的文案里也可能出现它们，
   * 泛化会让确定性失败变成「可换号」而白烧整池。
   * ⚠️ 本函数**不含状态码闸门**，调用方必须自己加 `status >= 500`。
   */
  return /gateway\s+time-?out|bad\s+gateway|service\s+(?:temporarily\s+)?unavailable|(?:first\s+token|upstream)\s+timeout|暂时不可用|服务不可用/i.test(
    text,
  )
}
