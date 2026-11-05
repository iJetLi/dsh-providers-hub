/**
 * 会话 cookie 归一化 —— **两家共用一份实现**。
 *
 * ## 为什么单独抽出来（三审 F🟢-6）
 *
 * `src/monkeycode-credits.ts` 与 `src/baizhi-credits.ts` 此前**各有一份**
 * `looksLikeCookieHeader`（逐字节相同）与一份 `normalizeCookie`（只差常量名）。
 * 三审发现时两份已经**开始漂**：monkeycode 侧接受 `raw: string`、baizhi 侧接受
 * `string | undefined`。这类「复制之后各自演化」的判据是**鉴权类**代码，
 * 漂一次就是恒 401（本仓库已踩过：模板里多写一个 `=` 拼出 `name==value`，
 * 排查两小时）。所以合并成一份，两家的差异只剩**参数**（cookie 名列表 + 兜底名）。
 *
 * ## 三种输入都要能用
 *
 * 1. 完整串 `a=1; b=2` ⇒ 原样（剥掉可能的 `cookie:` 前缀）；
 * 2. 只有裸值 `abc123` ⇒ 补兜底名字前缀；
 * 3. 空 / 纯空白 ⇒ `undefined`（调用方据此回「未配置会话」）。
 */

/**
 * 这段值是不是一个完整的 `Cookie:` 请求头内容？
 *
 * ⚠️ 不能用 `value.includes('=')` 判 —— 裸值本身可能就是 base64（`YWJj==`），
 * 那样会把 cookie 名丢掉、发出 `Cookie: YWJj==`，服务端解析不出 name/value ⇒ 恒 401
 * ⇒ 上层误判成「用户还没登完」⇒ 浏览器登录空转到超时（2026-11-02 审查发现）。
 */
export function looksLikeCookieHeader(value: string, knownNames: readonly string[]): boolean {
  const parts = value.split(';').map((part) => part.trim()).filter((part) => part.length > 0)
  if (parts.length === 0) return false
  // 多段 ⇒ 用户粘的就是整串（哪怕名字我们不认识，也不该替他改写）。
  if (parts.length > 1) return true
  const first = parts[0] as string
  const eq = first.indexOf('=')
  if (eq <= 0) return false
  const name = first.slice(0, eq)
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false
  if (knownNames.includes(name)) return true
  // 名字不认识且只有一段：值以 `=` 开头（base64 填充）就说明这是裸值。
  const rest = first.slice(eq + 1)
  return rest.length > 0 && !rest.startsWith('=')
}

/**
 * 把 `session_cookie` 归一成可直接放进 `Cookie` 头的字符串。
 *
 * @param raw         凭据里存的原始值（可能是整串、可能是裸值、可能是空）
 * @param knownNames  该平台**认可的** cookie 名（用于判断「这串是不是已经写了名字」）
 * @param fallbackName 只有裸值时补哪个名字
 *
 * ⚠️ 补名字必须用**常量模板** `${fallbackName}=${value}`，不要手写出
 * `'name=' + value` 之外多余字符：2026-11-02 的 monkeycode 版本就因为模板里
 * 多写了一个 `=`，拼出 `name==value`，服务端解析不出 name/value ⇒ 恒 401。
 */
export function normalizeSessionCookie(
  raw: string | undefined,
  knownNames: readonly string[],
  fallbackName: string,
): string | undefined {
  if (typeof raw !== 'string') return undefined
  let value = raw.trim()
  if (value.length === 0) return undefined
  if (/^cookie\s*:/i.test(value)) value = value.replace(/^cookie\s*:/i, '').trim()
  if (value.length === 0) return undefined
  return looksLikeCookieHeader(value, knownNames) ? value : `${fallbackName}=${value}`
}
