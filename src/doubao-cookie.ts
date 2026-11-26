/**
 * 豆包 cookie 导入的**文本归一化**（2026-11-26）。
 *
 * ## 为什么单独成模块
 *
 * 用户实际会粘进来的形态至少三种，任何一种处理不好都是「导入失败但不知道为什么」：
 *
 * 1. `sessionid=…; ttwid=…`（DevTools 里 Headers → Cookie 那一行）；
 * 2. `Cookie: sessionid=…; ttwid=…`（带前缀，常被一起复制）；
 * 3. **整段 cURL**（`Copy as cURL` 最省事：Chrome 新版会把 `cookie` 头折叠，
 *    很多人干脆复制 cURL）—— 里面 cookie 在 `-H 'cookie: …'` 或 `-b …` 里。
 *
 * ⚠️ 只做「取出看起来像 cookie 的部分」，**不校验语义**：`sessionid` 在不在、
 *    值对不对由调用方（`jet-hub-rpc.ts` 的 `mode: 'cookie'` 分支）判。
 *
 * @module src/doubao-cookie
 */

/** 从 cURL 命令里抽 cookie 串（`-H 'cookie: …'` 或 `-b '…'` / `--cookie '…'`）。 */
function cookieFromCurl(text: string): string | undefined {
  const header = text.match(/-H\s*(['"])cookie:\s*([^'"]+)\1/i)
  if (header?.[2] !== undefined) return header[2]
  const flag = text.match(/(?:-b|--cookie)\s*(['"])([^'"]+)\1/i)
  if (flag?.[2] !== undefined) return flag[2]
  // `-H cookie: a=1; b=2`（不带引号，整段命令里就这一个头）
  const bare = text.match(/-H\s*cookie:\s*([^'"]+?)(?:\s+-H|\s*$)/i)
  return bare?.[1]
}

/** 把任意形态的粘贴内容归一成 `a=1; b=2`（取不出任何 pair 时返回空串）。 */
export function normalizePastedCookie(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let text = raw.trim()
  if (text.length === 0) return ''
  if (/curl|wget/i.test(text.slice(0, 40)) && /-H|--cookie|-b\s/.test(text)) {
    text = cookieFromCurl(text) ?? text
  }
  text = text.replace(/^\s*cookie\s*:\s*/i, '').replace(/\r?\n/g, ' ')
  const pairs = text.split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0 && pair.indexOf('=') > 0 && !/^(curl|wget)$/i.test(pair))
  const joined = pairs.join('; ')
  /**
   * ## ⚠️ 超长必须**拒绝**，不能截断（2026-11-26 双审 P2）
   *
   * 旧实现是 `joined.slice(0, 8192)` —— **静默切出半截 cookie**，而调用方只看
   * 「返回非空 ⇒ 成功」：
   *
   * - RPC 回 `ok: true`、面板弹「已用 cookie 导入豆包账号」；
   * - 而库里存的是**被切断的 `sessionid`**（对抗审计探针实测 182/300 字符）；
   * - 之后用户重粘完整 cookie，因为 `sessionid` 不同 ⇒ **不判重** ⇒ **变两张卡**；
   * - 那半截 cookie 拿去请求必然失败，但界面显示「已登录」。
   *
   * ⇒ 超长基本是**误贴了整页 HTML/日志**。这种情况要的是「让用户重新贴」，
   *   不是「悄悄用一半」。返回空串 ⇒ 调用方走 `ok:false` + 可操作文案 ⇒ 不建号。
   *
   * 正常豆包 cookie 不到 2KB（实测），8KB 已是 4 倍余量。
   */
  if (joined.length > 8_192) return ''
  return joined
}
