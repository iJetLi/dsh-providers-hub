/**
 * ZCode 的**可观测诊断**：为 `3012` 这类「只有一句话、没有第二条信息」的错误
 * 补齐排查所需的现场数据。
 *
 * ## 为什么需要它（Gitee issue IKJI0Y）
 *
 * `3012 unusual activity` 的既有文案只有**固定句 + 原始响应**。用户遇到时
 * 只能确认一件事：「我猜的请求体大概是对的」。剩下全是猜：
 *
 * - 本次是账号池里**第几个账号**？（分不清是账号自身被标记，还是恰好轮到它）
 * - 这个账号此前**成功过几次**？**最近一次成功**是什么时候？
 *   —— 这两条决定「一直如此」还是「突然开始」，两者的排查方向完全不同；
 * - **实际发出**的身份块有多少字符？首轮 user 到底带没带日期块？
 * - 本次距**上一条** zcode 请求隔了多久？（频率风控的唯一直观证据）
 *
 * ## 三条设计红线
 *
 * 1. **绝不写凭据**。账号只以「进程内自增序号」出现（{@link accountOrdinal}），
 *    不含 accountId、JWT、device_mid、账号名中的任何一个字符片段。
 *    回归用例用「凭据标识的每个子串都不得出现在文案里」来钉死这条。
 * 2. **只诊断「实际发出的请求体」**，不诊断「我们以为发出了什么」。
 *    {@link describeZcodeRequestShape} 直接读已构造好的 `system` / `messages`
 *    —— 这样一旦真出现「身份块没进去」，诊断会**如实显示 0 字符**，
 *    而不是显示常量里的 2898 把问题盖住。
 * 3. **进程级、不落盘**。与 {@link file://./captcha-requirement.ts} 同口径：
 *    `$DSH_HOME/jet-hub/state.json` 是同机多 profile 共享的 home 级文档，
 *    落盘会把一个 profile 的账号画像传染给另一个。
 *
 * ## ★ 本模块同时是 `3012` 判据与文案的**唯一出处**（Gitee issue IKJOQB）
 *
 * **真实缺陷**：`3012` 的文案曾在**两个地方各写一份** ——
 * `zcode-adapter.ts` 的 `describeUpstreamError`（推理路径，带冷却警告）
 * 与 `zcode-auth.ts` 的 `toClaimOutcome`（领取路径，**只有裸上游串**）。
 * 于是领取路径的用户看到的是
 * `zcode-v3-start-plan-trust-1005: request has been blocked due to unusual activity.`
 * —— 既看不出这是**风控**，更看不到「请勿连续重试」这条**唯一正确的动作**
 * （`3012` 有账号冷却惩罚，反复触发会 30 分钟 → 24 小时 → 停用）。
 *
 * ⇒ 判据（{@link isZcodeUnusualActivityCode} / {@link looksLikeZcodeUnusualActivity}）
 * 与文案（{@link formatZcodeUnusualActivityMessage}）都收敛到本文件，
 * 两条路径**引用同一份**。改文案只需改这里，不会再漂移。
 */

/**
 * 上游 `3012`（unusual activity）的**判据**之一：业务码精确命中。
 *
 * ⚠ 上游把码给成数字 `3012`，但**字符串 `"3012"` 也在线上出现过**
 * （`{"code":"3012"}` 这类把数字写成字符串的响应），故两者都认。
 * 与 `httpErrorCodeForZcode` 同口径（那边用的是 `body.includes('3012')`）。
 */
export function isZcodeUnusualActivityCode(code: unknown): boolean {
  if (code === 3012) return true
  if (typeof code !== 'string') return false
  return code.trim() === '3012'
}

/**
 * 把上游 `code` 归一成数字：认 `number`，**也认纯数字字符串**。
 *
 * ## ⚠⚠ 为什么必须认字符串（真实缺陷，2026-10-05 对抗性审计打出）
 *
 * `zcode-upstream.ts` 原先用 `num(parsed.code)` 解析业务码，而它**只认 number**：
 * ```js
 * function num(v){ return typeof v === 'number' && Number.isFinite(v) ? v : undefined }
 * ```
 * 于是上游回 `{"code":"3012","msg":"request has been blocked due to unusual activity."}`
 * 时，`code` 被解析成 **`undefined`** ⇒ 风控码**整条丢失**，用户看到的正是
 * issue 要修的那句裸上游串：
 *
 * ```
 * zcode-v3-start-plan-trust-1005: request has been blocked due to unusual activity.
 * ```
 *
 * ⇒ 本函数让 `3012` 的**字符串形态**不再在解析层被吃掉。
 *
 * ⚠ 这同时修掉了本文件 {@link isZcodeUnusualActivityCode} 那个字符串分支的
 *   **死代码**状态：它有分支、但领取侧的调用方永远拿不到字符串输入
 *   （上游更早的 `num()` 已经把它变成了 `undefined`）。
 * ⚠ 只认**纯数字**字符串（`/^-?\d+$/`），不认 `"3012 "` 以外的怪值更不认
 *   `"abc"` —— 避免把任意文本静默变成业务码。
 */
export function parseZcodeBusinessCode(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : undefined
}

/**
 * 正文里是否**表达了上游风控** —— 这是「仅凭正文」判定风控的**唯一**入口。
 *
 * ## ⚠⚠ 为什么不能只看裸数字（真实缺陷，2026-10-05 对抗性审计打出）
 *
 * 词边界正则解决了 `13012` / `plan-3012` 这类**紧邻**形态，但拦不住
 * **自然语言里恰好出现的独立数字**。审计实测被误判的形态：
 *
 * | 正文（`code` 缺失） | 仅词边界 | 本函数 |
 * |---|---|---|
 * | `too many requests, retry after 3012 ms` | ❌ **误判成风控** | ✅ 不命中 |
 * | `<h1>Error 3012</h1>upstream connect timeout` | ❌ **误判成风控** | ✅ 不命中 |
 * | `request has been blocked due to unusual activity.` | ❌ **漏判** | ✅ 命中 |
 *
 * 前者后果**不是文案问题**：`too many requests` 是**限流、稍后重试即可**，
 * 被改写成「风控、**别重试**」—— 两者用户动作**完全相反**；且领取路径据此
 * **短路**，跳过本可领取的 plan（审计实测 3 个 plan 只发 1 发）。
 *
 * ## ⚠⚠ 为什么也**不能**用「独立词 3012」当门禁
 *
 * 上游 `3012` 的 `msg` **原文就是** `request has been blocked due to unusual
 * activity.` —— **它不含任何数字**（数字在 `code` 字段里）。以上游真实文案
 * 做样本时，「必须有独立词 3012」这条门禁会**反过来把它漏掉**：
 * 写用例时实测到该断言为 `false`。
 * ⇒ 判据以**语义短语**为主，数字只作兜底（配合 `block` 字样）。
 *
 * ⚠ `code` 已解析出来时**不走本函数**（它只用于「仅凭正文」的兜底，
 *   见 {@link hasZcodeUnusualActivity}）—— 有权威业务码时不该猜文本。
 */
export function mentionsZcodeUnusualActivity(body: string): boolean {
  /**
   * ★ 主判据：上游风控的**实测原文**语义。
   * 覆盖 `request has been blocked due to unusual activity.` 及其变体。
   */
  if (/unusual activity|blocked due to/i.test(body)) return true
  /**
   * 兜底：独立词 `3012` 与 `block` 字样**紧邻**（≤10 字符），
   * 如 `3012 blocked by waf`。
   *
   * ## ⚠⚠ 为什么必须「紧邻」，而不是全文任意共现
   *
   * 第一版写成「独立词 `3012` **且** 全文含 `block`」，仍会误判**限流**
   * 正文（真实缺陷，2026-10-05 审计 N2）：
   *
   * | 正文（无码） | 40 字符窗口 | **10 字符紧邻**（本实现） |
   * |---|---|---|
   * | `rate limited: request blocked, retry after 3012 ms` | ❌ 仍误判（距 14） | ✅ 不命中 |
   * | `temporarily blocked; see error 3012` | ❌ 仍误判（距 12） | ✅ 不命中 |
   * | `3012 blocked by waf` | ✅ | ✅（距 1） |
   *
   * ⚠ 窗口不是随便取的：写第一版修复时用 40，**实测发现两个反例仍命中**
   *   （`blocked` 与 `3012` 之间只隔 `, retry after ` / `; see error `），
   *   故收紧到 10 —— 它仍容纳 `3012 block…` 这类紧邻，而把两个反例排除。
   * ⚠ 限流是「稍后重试即可」、风控是「**别重试**」，动作相反，不能混。
   * ⚠ 单靠数字**永远**不算（见上方的毫秒数反例）。
   */
  return looksLikeZcodeUnusualActivity(body)
    && /3012[^]{0,10}?block|block[^]{0,10}?3012/i.test(body)
}

/** 从响应正文里读出业务码（认 `number` 与纯数字字符串）。 */
export function readZcodeBusinessCodeFromBody(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body.trim()) as { code?: unknown } | null
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parseZcodeBusinessCode(parsed.code)
  } catch {
    // 非 JSON（网关 HTML / 纯文本）⇒ 无码可读，由调用方决定是否看正文。
    return undefined
  }
}

/**
 * 响应正文里是否表达了**上游风控**（`3012`）—— 给「只有一段正文」的调用方用
 * （`zcode-adapter.ts` 的 `httpErrorCodeForZcode` 与 `describeUpstreamError`）。
 *
 * 判据**有优先级**：
 * ① 正文能解析出业务码 ⇒ **只信码**（`3012` 即风控，`13012` 不是）；
 * ② 无码可读 ⇒ 才看正文，且要求**风控语义共现**（见
 *    {@link mentionsZcodeUnusualActivity}）。
 *
 * ⚠ 这个优先级是必须的：`{"code":3012}` 这种正文**不含语义词**，
 *   若直接走 ② 会漏判 ⇒ `httpErrorCodeForZcode` 返回 `SERVER`，
 *   而 `SERVER` 在 harness 的 `DEFAULT_RETRYABLE_CODES` 里 ⇒
 *   有冷却惩罚的风控错误被**白重试 5 次**（`qoder` 那边记过同型缺陷）。
 *
 * ⚠⚠ **这里刻意没有「剥标签再判一遍」的兜底**（2026-10-07 实测后删掉）：
 * 审计曾提议对 `<h1>Error 3012</h1> request has been blocked…` 这类
 * 「标签包裹的风控」剥标签重判。实测 8 种形态后确认那是**多余的**：
 * 它们本来就靠主判据（`unusual activity` / `blocked due to`）命中，
 * 剥不剥标签**结果完全一样**。
 *
 * ⇒ 而它有真实代价：`stripHtmlTags` 把相邻文本**粘在一起**
 * （`blocked</b><i>3012` → `blocked3012`），会让 `looksLikeZcodeUnusualActivity`
 * 的**词边界**失效（`3012` 紧跟字母 ⇒ 不算独立词）——
 * 即「制造出新的漏判」。为一条用不上的兜底加这个风险，不划算。
 *
 * ⚠ 真正需要优先级判断的地方是 `describeUpstreamError` /
 * `httpErrorCodeForZcode` 的 HTML 短路，见那两处的注释。
 */
export function hasZcodeUnusualActivity(body: string): boolean {
  const code = readZcodeBusinessCodeFromBody(body)
  if (code !== undefined) return isZcodeUnusualActivityCode(code)
  return mentionsZcodeUnusualActivity(body)
}

/**
 * 正文是否是**边缘/CDN 的 HTML 或 XML 错误页**（而不是业务层响应）。
 *
 * ## 为什么要它（Gitee issue IKJRM4，2026-10-07 实测 405 + 阿里云 ESA 页）
 *
 * 实测拿到的是 `text/html`，正文是边缘页：
 *
 * ```
 * <!doctypehtml><html lang="zh-cn">…<title>405</title><style>a,body,div{…}
 * ```
 *
 * 它会同时打穿**两处**：
 * ① 文案侧 —— 非 JSON 兜底 `slice(0,200)` 把 CSS 选择器当错误文案倒给用户；
 * ② **判据侧（本条的主因，更严重）** —— 各处 `body.includes('1005')` 是**裸子串**，
 * 而边缘页里出现 `1005` 是完全正常的（`<title>1005</title>`、`width:1005px`）。
 * 实测 3 账号池：边缘页含 `1005` ⇒ 连换两个号，并把两个**完全可用**的账号
 * 标记成「该模型当日额度用尽」直到次日 0 点，而同一条文案正写着「更换账号无效」。
 *
 * ⇒ 判据必须**在分类之前**短路，且**四处判据共用这一份**
 * （`isZcodeQuotaExhausted` / `isZcodeConcurrencyLimited` / `isZcodeCaptchaRejected` /
 * `shouldFallbackToOtherChannel` / `httpErrorCodeForZcode` / `describeUpstreamError`）——
 * 少改一处就是又一次「只改了一半」（同 {@link httpErrorCodeForZcode} 头部记的 3012 事故）。
 *
 * ## 判据三条（任一成立即算）
 *
 * 1. **文档级前缀**：`<!doctype` / `<?xml` / `<!--`（BOM 与前导空白已剥）；
 * 2. **文档骨架标签开头**：`<html` / `<head` / `<body` / `<title` / `<pre` / `<script` …
 *    —— 见 {@link ZCODE_HTML_DOCUMENT_TAGS}；
 * 3. **整篇都是标签**（兜住自定义错误页）：把正文按空白切开，
 *    **每一段**都像标签（`<x…>` / `</x>` / 自闭合 `<x/>` / `<!…>`）才算。
 *
 * ## ⚠⚠ 判据只回答「形态」，**不回答「该怎么办」**（2026-10-07 审计定稿）
 *
 * 上游会把**业务码包在零散标签里**下发，而那种形态**不是**边缘页：
 *
 * ```
 * <h1>Error 3012</h1>upstream connect timeout
 * <h1>Error 3012</h1> request has been blocked due to unusual activity.
 * ```
 *
 * 但**反过来也有真实页面只有一个标题标签**：
 *
 * ```
 * <h1>Gateway Timeout</h1>
 * ```
 *
 * ⇒ 二者**在形态上无法区分**（都含 `</h1>`、都带裸文本）。任何单看形态的
 * 阈值都会在一端出错：收得太松 ⇒ 业务报文被当成页面；收得太紧 ⇒
 * 极简错误页漏判（实测 `<h1>Gateway Timeout</h1>` 会被判成非页面，
 * 于是 `429` 下走进「并发限流」分支）。
 *
 * ⇒ **本函数只做「像不像一页 HTML」，不做「是不是业务错误」**。
 * 后者由消费层按优先级决定（见 `describeUpstreamError` /
 * `httpErrorCodeForZcode`：**有权威码 ⇒ 只信码；无码但有业务语义 ⇒ 也不是页面**）。
 * 试图在形态判据里编码优先级，正是本条判据被反复推翻的原因。
 *
 * ⚠ **`JSON.parse` 能过的正文恒不命中**（JSON 值不能以 `<` 开头），
 * 故本函数为真 ⟹ `message` 必为 `undefined`，调用方无需再判一次。
 *
 * ⚠ 判据 ③ 刻意**只认闭合标签 `</x>`**、不认自闭合 `<x/>`：
 * 后者（`<custom-widget/>`、`<hgroup/>`）在真实错误页里罕见，
 * 而收紧这一条能少一类误判。
 */
export function looksLikeZcodeHtmlPage(body: string): boolean {
  // ⚠ BOM 必须**显式剥**：它不是空白字符，`trimStart()` 拿它没办法，
  // 而带 BOM 的 HTML 页在真实文件/流里并不罕见。
  const text = body.replace(/^﻿/, '').trimStart()
  if (!text.startsWith('<')) return false
  // ① 文档级前缀
  if (/^<(!doctype|\?xml|!--)/i.test(text)) return true
  // ② 文档骨架标签开头（大小写不敏感：`<Error>` 与 `<error>` 都见过）
  const name = /^<([a-z][a-z0-9-]*)/i.exec(text)?.[1]?.toLowerCase()
  if (name !== undefined && ZCODE_HTML_DOCUMENT_TAGS.has(name)) return true
  // ③ 存在闭合标签（含极简错误页 `<h1>Gateway Timeout</h1>`；
  //    自闭合 `<x/>` **不**算，见上方注释）
  return /<\/[\w-]+\s*>/.test(text)
}

/**
 * **文档骨架标签**白名单 —— 见 {@link looksLikeZcodeHtmlPage} 的判据 ②。
 *
 * ⚠⚠ **刻意不含正文小节标签**（`h1`/`h2`/`p`/`span`/`b`/`code`/…）：
 * 上游会把业务码包在它们里下发（`<h1>Error 3012</h1>upstream connect timeout`），
 * 收进来就把**业务报文**误判成边缘页 ⇒ 把「别重试」说成「稍后重试」。
 *
 * ⚠ 收录标准：**真实错误页在正文最开头就会出现的**结构性标签。
 * 纯文本形态（`<service unavailable, retry later>`）不会命中任何一条 ——
 * 它没有闭合标签、也不在白名单里。
 */
const ZCODE_HTML_DOCUMENT_TAGS = new Set([
  // HTML 文档骨架
  'html', 'head', 'body', 'title', 'meta', 'link', 'base',
  // 轻量错误页 / SPA 兜底 / 网关页的根
  'div', 'pre', 'script', 'style', 'iframe', 'noscript', 'template', 'svg',
  // XML 错误文档的根（S3 / OSS / Azure 形态：`<Error><Code>…</Code></Error>`）
  'error', 'fault', 'response', 'result',
])

/**
 * 响应是否来自**阿里云 ESA**（ZCode 的上游边缘 CDN）。
 *
 * ## 为什么抽成独立导出（2026-10-25，issue IKQ4B4）
 *
 * 这个判据原先**内联**在 {@link formatZcodeEdgePageHint} 里，而
 * `describeUpstreamError` 需要区分「ESA 专属措辞」与「405 风控措辞」
 * —— 两处都要用同一个判据。若在 `describeUpstreamError` 里再抄一份正则，
 * 就是「同一语义两套判据」（本仓库红线），将来改一处必漏另一处。
 *
 * 特征：`data-spm` 是 ESA 的埋点属性名，`aliyuncs.com` 是它的资源域名。
 */
export function looksLikeZcodeEsaPage(body: string): boolean {
  return /data-spm/i.test(body) || /aliyuncs\.com/i.test(body)
}

/**
 * 边缘/CDN 错误页的**文案** —— 与 {@link looksLikeZcodeHtmlPage} 同源同批维护。
 *
 * ## 三条写作要求（都是被真实事故逼出来的）
 *
 * 1. **必须写明「更换账号无效」**：这是边缘拦截与「额度/凭据」最要命的区别。
 *    归错方向会让用户去充值或重新登录，白跑一趟（issue IKJRM4 的原始诉求）。
 * 2. **刻意不承诺根因**（如「上游改规则了」）—— 边缘页能证明的只是
 *    「响应不是业务层 JSON」，具体原因页面本身通常不写。
 * 3. **不得出现「额度」「凭据失效」等业务词**：本函数只用在**已确认是 HTML 页**的
 *    场景，出现业务词等于给用户一个互相矛盾的指令（见 `describeUpstreamError`
 *    的 401 分支事故）。判据全在这一个函数里，便于逐条审。
 *
 * ⚠ 文案里的 `**` 是**刻意**的：与本仓库既有用户可见文案同惯例
 * （`index.ts` 的「这些账号**可能仍有**」等），不是 Markdown 泄漏。
 *
 * @param body - 原始响应体（只用于取页面标题与识别边缘厂商）。
 * @param status - HTTP 状态码（通用分支会写进文案，便于排查对照）。
 */
export function formatZcodeEdgePageHint(body: string, status: number): string {
  const title = body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim()
  // ⚠ 标题同样可能很长（甚至由攻击面控制）⇒ 截断，别把它变成新的泄漏面。
  // ⚠ **截断必须带省略号**：否则 40 与 41 字符的标题输出**完全一样**，
  //   用户无从判断标题被截过。
  // ⚠ 只截**长度**不筛**内容**（标题里的业务词仍会回显）是**刻意取舍**：
  //   标题是排查时最有价值的一手信息，过滤它反而丢线索；而它由远端控制，
  //   已经过长度上限约束，不会变成注入面。
  const shown = title !== undefined && title !== ''
    ? `（页面标题：${title.slice(0, 40)}${title.length > 40 ? '…' : ''}）`
    : ''
  // 阿里云 ESA 的特征由 {@link looksLikeZcodeEsaPage} 判定（判据只留一份：
  // `describeUpstreamError` 的 405 分支也要区分 ESA 与普通页面）。
  if (looksLikeZcodeEsaPage(body)) {
    return `上游返回的是边缘CDN 的 HTML 错误页${shown}，不是业务层JSON —— `
      + '请求未到达 ZCode 服务端（通常是访问链路被拦截或上游临时故障）。'
      + '此类问题**更换账号无效**，建议稍后重试；若持续出现，请向 ZCode 官方确认服务状态。'
  }
  return `上游返回的是 HTML 页面${shown}而不是业务层 JSON（HTTP ${status}），`
    + '说明响应可能来自网关或中间层，未到达 ZCode 服务端。'
    + '此类问题**更换账号无效**，建议稍后重试；持续出现时请向 ZCode 官方确认服务状态。'
}

/**
 * 从响应里取上游的 **`logid`**（排障凭据）—— 双来源，体优先、头兜底。
 *
 * ## 为什么这个函数必须存在（issue IKJI0Y 的原始记录）
 *
 * 笔记原话：「响应体还带 **`logid`** —— 向用户索取现场时**优先要它**
 * （上游侧排障凭据）」。但**此前它从未被解析过**（全仓 grep `logid` 零命中），
 * 于是用户报障时我们只能给出「账号#1 · 身份块 2898 字符 · HTTP 405」——
 * **没有一样是上游能据以查日志的东西**，排障只能来回猜。
 *
 * ## 本机一手实测（`scripts/probe-zcode-logid-shape.mjs`，只发 GET、零额度）
 *
 * 四个端点（`client/configs` / `billing/preview` / `billing/balance` /
 * `event/report`）全部**同时**带这两个，且值**逐字相同**：
 *
 * ```
 * [header] x-request-id = 20261012145652694e8f48d3614ae49634
 * [body]   logid        = 20261012145652694e8f48d3614ae49634
 * ```
 *
 * ## 两个来源各自覆盖哪一类故障（**都不能省**）
 *
 * | 来源 | 覆盖 | 为什么另一条盖不住 |
 * |---|---|---|
 * | 响应体顶层 `logid` | **业务层错误**（`{"code":3012,…}`） | 主路，值是上游业务日志的 id |
 * | HTTP 头 `x-request-id` | **边缘 / 网关的 HTML 页**（502 / 504 / 阿里云 ESA） | 那种响应**体里没有 `logid`**，而它正是另一类高频故障 |
 *
 * ⚠ **体优先于头**：两者同时存在时取体的值 —— 那是业务侧记账的 id。
 *   （实测二者相同，故这条只在将来分叉时才有可观测差异；写成显式优先级
 *   是为了「分叉时行为确定」，而不是依赖「它们恰好相等」。）
 *
 * ⚠ **取不到一律 `undefined`**，绝不编造、也不返回空壳：
 *   空白值（`""` / `"   "`）与非字符串（数字 / 对象）**都不算现场** ——
 *   后者若被 `String()` 化会渲染出 `logid [object Object]`，
 *   比没有更糟（会让人以为拿到了凭据）。
 */
export function extractZcodeLogId(
  body: string,
  headers?: Record<string, string> | { get?: (name: string) => string | null },
): string | undefined {
  // ① 响应体顶层 `logid`（业务错误主路）。
  const fromBody = ((): string | undefined => {
    if (typeof body !== 'string' || body.length === 0) return undefined
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { return undefined }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return nonEmptyString((parsed as { logid?: unknown }).logid)
  })()
  if (fromBody !== undefined) return fromBody

  // ② HTTP 头 `x-request-id`（边缘 HTML 页只有这条）。
  return readHeaderCaseInsensitive(headers, 'x-request-id')
}

/**
 * 归一一个「非空字符串」：非字符串 / 空白一律 `undefined`。
 *
 * ⚠ **必须判类型**，不能 `String(value)`：数字或对象会被 stringify 成
 * `12345` / `[object Object]`，渲染进诊断行比没有更糟
 * （会让人以为拿到了凭据）。
 * ⚠ 空白串（`""` / `"   "`）也算「没有」—— 上游确实下发过空 logid。
 */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 大小写不敏感地读一个头。
 *
 * ⚠ HTTP 头名**本就大小写不敏感**，而 `Response.headers.get()` 已处理好；
 * 但单测与调用方可能传**普通对象**（`{ 'X-Request-Id': … }`），
 * 那种情况必须自己遍历键 —— 写死小写键会**静默取不到**（本仓库记过
 * 「判据静默恒不命中」那类缺陷）。
 */
function readHeaderCaseInsensitive(
  headers: Record<string, string> | { get?: (name: string) => string | null } | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined
  // `Headers` 形态（有 `get`）：优先用它，它是权威的大小写无关实现。
  const getter = (headers as { get?: (n: string) => string | null }).get
  if (typeof getter === 'function') {
    try {
      const viaGetter = nonEmptyString(getter.call(headers, name))
      if (viaGetter !== undefined) return viaGetter
    } catch { /* 落到下面的对象遍历 */ }
  }
  const record = headers as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== name) continue
    const found = nonEmptyString(value)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 上游 `3012` 的**判据**之二：正文里以**独立词**出现 `3012`。
 *
 * ⚠⚠ **必须是词边界匹配，不能是 `body.includes('3012')`**（真实缺陷，
 * 2026-10-05 自审发现）。裸 `includes` 会把**其它码里的数字片段**一并命中：
 *
 * | 正文 | `includes('3012')` | 本函数（词边界） |
 * |---|---|---|
 * | `{"code":3012}` | ✅ | ✅ |
 * | `{"code":13012}` | ❌ **误命中** | ✅ 不命中 |
 * | `plan-3012-trust` | ❌ **误命中** | ✅ 不命中 |
 * | `quota 3012 remaining` | ✅（且**可能**是真风控文案） | ✅ |
 *
 * 误判的后果**不是「文案不好看」**：领取路径据此**短路**（`break`）⇒
 * 把一个「plan 名里恰好含 3012」的普通失败当成风控，**跳过本可领取的 plan**，
 * 并把真实业务码（如 `1005` 额度用尽）改写成 `3012` ——
 * 而这两者的用户动作**完全相反**（等额度重置 vs 别重试）。
 *
 * ## ⚠ 边界字符是「数字、字母**以及 `-` / `_`**」
 *
 * 初版只写 `(?<!\d)3012(?!\d)`，于是 `plan-3012-trust` **仍然命中** ——
 * `3012` 前后是连字符，不是数字（写单测时实测到）。第二版补了字母，
 * `plan-3012-trust` **还是**命中（连字符与下划线都不属于 `[0-9A-Za-z]`）。
 * ⇒ 标识符形态（`plan-3012`、`trust_3012`、`x3012y`、`13012`）必须**全部**
 * 排除，故边界集取 `[0-9A-Za-z_-]`。
 *
 * ⚠ `.` / `,` / `}` / `:` / 空格 / 行首行尾都**不**被排除，
 * 上游真实形态 `{"code":3012,"msg":"…"}` 与自然语言 `error: 3012 blocked`
 * 因此照常命中。
 */
export function looksLikeZcodeUnusualActivity(body: string): boolean {
  return /(?<![0-9A-Za-z_-])3012(?![0-9A-Za-z_-])/.test(body)
}

/**
 * `3012` 的**共用文案** —— 推理路径与领取路径引用同一份（Gitee issue IKJOQB）。
 *
 * ## 为什么必须共用
 *
 * 这两条路径是**同一个错误的两个入口**，而用户该做的事完全不同：
 * `3012` 不是「重试就能过」（那是 `3007`/`3009`），而是**有账号冷却惩罚**：
 * 30 分钟起步，反复触发升级到 24 小时乃至停用。
 * ⇒「请勿连续重试」是这段文案里**最重要的一句**，绝不能只在其中一条路径上有。
 *
 * ## 参数语义
 *
 * @param options.subject 定位信息（领取路径传 `planId`），**非空时**并入首句。
 *   推理路径不传 ⇒ 首句与历史输出**逐字一致**（单测钉住了这一点）。
 * @param options.diagnostic {@link formatZcodeDiagnostic} 的产物。**为空则整段省略**
 *   —— 与 `describeUpstreamError` 的历史行为一致（不写空壳「本机诊断：」）。
 * @param options.rawResponse 原始响应（上游 `msg` 或截断后的正文）。
 */
export function formatZcodeUnusualActivityMessage(options: {
  subject?: string
  diagnostic?: string
  rawResponse?: string
} = {}): string {
  const subject = typeof options.subject === 'string' && options.subject.length > 0
    ? ` · ${options.subject}`
    : ''
  const diag = typeof options.diagnostic === 'string' && options.diagnostic.length > 0
    ? `本机诊断：${options.diagnostic}\n`
    : ''
  const raw = typeof options.rawResponse === 'string' && options.rawResponse.length > 0
    ? `原始响应：${options.rawResponse}`
    : ''
  return (
    `上游风控拦截（3012 unusual activity）${subject}。` +
    `⚠ 该错误有账号冷却惩罚（30 分钟，反复触发会升级到 24 小时乃至停用），` +
    `请勿连续重试。\n${diag}${raw}`
  )
}

/** 账号的进程级画像。key 与 {@link accountOrdinal} 用的是同一个。 */
interface AccountProfile {
  /** 进程内自增序号（1 起），**不含任何凭据派生信息**。 */
  ordinal: number
  /** 已发出的请求数。 */
  sent: number
  /** 拿到 HTTP 2xx 的次数。 */
  ok: number
  /** 拿到 HTTP 非 2xx 的次数。 */
  failed: number
  /** 最近一次成功时刻（毫秒）。从未成功为 undefined。 */
  lastOkAt: number | undefined
  /** 最近一次「发出请求」的时刻（毫秒）。 */
  lastSentAt: number | undefined
  /**
   * **上上条**发出请求的时刻（毫秒）—— 即「距上一条」的分母。
   *
   * ⚠⚠ 必须与 `lastSentAt` 分开存，**不能拿 `lastSentAt` 顶替**：
   * 适配器的调用顺序是「先 {@link noteZcodeRequestSent} 记本次、再在失败时
   * {@link formatZcodeDiagnostic} 诊断」，两者用的是同一个 `sentAt`
   * ⇒ 若诊断时读 `lastSentAt`，算出来恒为 `0ms`，这一项就永远没有信息量
   * （写脚本做端到端验证时真的打印出过 `距上条 0ms`）。
   */
  previousSentAt: number | undefined
}

const profiles = new Map<string, AccountProfile>()
let nextOrdinal = 1

/** 空/缺失的账号 id 归一成 `-`（与 `captchaRequirementKey` 同口径）。 */
function normalizeKey(accountId: string | undefined): string {
  return accountId === undefined || accountId === '' ? '-' : accountId
}

/**
 * 取账号的进程内序号，**首次见到时分配**（之后稳定不变）。
 *
 * ⚠ 同一个账号在多次请求里拿到同一个序号 —— 否则「本次是第几个账号」这句话
 * 会随请求变化，跨请求对比就失去意义（这正是 issue 要解决的问题）。
 */
export function accountOrdinal(accountId: string | undefined): number {
  const key = normalizeKey(accountId)
  const existing = profiles.get(key)
  if (existing !== undefined) return existing.ordinal
  const profile: AccountProfile = {
    ordinal: nextOrdinal,
    sent: 0,
    ok: 0,
    failed: 0,
    lastOkAt: undefined,
    lastSentAt: undefined,
    previousSentAt: undefined,
  }
  nextOrdinal += 1
  profiles.set(key, profile)
  return profile.ordinal
}

/**
 * 记一次「请求已发出」。
 *
 * @param sentAt 本次的出发时刻（毫秒）。**在真正 `fetch` 之前取**，
 *   否则算出来的「距上一条」会把本次的排队/等待时间算进去。
 */
export function noteZcodeRequestSent(accountId: string | undefined, sentAt: number): void {
  const key = normalizeKey(accountId)
  accountOrdinal(accountId)
  const profile = profiles.get(key)
  if (profile === undefined) return
  profile.sent += 1
  // ⚠ 旧值下沉一格再写新的 —— 诊断要的「距上条」是**上一条**，不是本次。
  profile.previousSentAt = profile.lastSentAt
  profile.lastSentAt = sentAt
}

/** 记一次成功（拿到 HTTP 2xx）。 */
export function noteZcodeRequestOk(accountId: string | undefined, at: number): void {
  const profile = profiles.get(normalizeKey(accountId))
  if (profile === undefined) return
  profile.ok += 1
  profile.lastOkAt = at
}

/** 记一次失败（HTTP 非 2xx）。 */
export function noteZcodeRequestFailed(accountId: string | undefined): void {
  const profile = profiles.get(normalizeKey(accountId))
  if (profile === undefined) return
  profile.failed += 1
}

/**
 * 把毫秒差写成一眼能读的形态。
 *
 * ⚠ 秒以上的换算**逐档单独写过**：初版把分钟档写成
 * `${Math.floor(seconds % 60)}分…`，于是 90 秒被渲染成「30分30秒」
 * —— 分位取的是**秒的余数**而不是已算好的分钟数。
 * 这个错误是在**真实探针输出**里发现的（「最近成功 29分29秒前」），
 * 纯函数单测当时没覆盖到 ≥60 秒的区间。
 */
function formatGap(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) {
    const rest = totalSeconds % 60
    return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`
  }
  const hours = Math.floor(minutes / 60)
  const restMin = minutes % 60
  return restMin === 0 ? `${hours}小时` : `${hours}小时${restMin}分`
}

/** 「最近一次成功距今」的文案（从未成功过要如实说「无」，不写 0）。 */
function formatSinceLastOk(at: number | undefined, now: number): string {
  return at === undefined ? '从未成功过' : `${formatGap(now - at)}前`
}

/**
 * 请求体形态的实测描述 —— **读的是真正要发出去的那个对象**。
 *
 * ⚠ 这里刻意**不读** `OFFICIAL_IDENTITY_CHARS` 常量：常量只能证明
 * 「源码里写了多少字」，证明不了「线上发出去多少字」。两者一旦不一致
 * （例如某条改动把 `system` 顶掉了），只有读实际值才看得出来。
 */
export interface ZcodeRequestShape {
  /** `system` 块数组的块数（不是数组则 0）。 */
  systemBlocks: number
  /** 前两块（官方身份块）的字符数合计。 */
  identityChars: number
  /** 逐块的字符数（异常时能看出是哪一块短了）。 */
  identityBlockChars: readonly number[]
  /** 第一块（cliPrefix）的字符数。 */
  cliPrefixChars: number
  /** 首条 user 消息是否带 `<system-reminder>` 日期块。 */
  hasDateBlock: boolean
  /** 首条消息的 role（诊断「历史首条不是 user」这类异常）。 */
  firstRole: string
}

/** 取一个 system 块的 text 长度（非 text 块记 0）。 */
function blockChars(block: unknown): number {
  if (typeof block !== 'object' || block === null) return 0
  const text = (block as { text?: unknown }).text
  return typeof text === 'string' ? text.length : 0
}

/** 从已构造好的请求体里抽出形态信息。 */
export function describeZcodeRequestShape(
  system: unknown,
  messages: unknown,
): ZcodeRequestShape {
  const blocks = Array.isArray(system) ? system : []
  const identityBlockChars = blocks.slice(0, 2).map(blockChars)
  const first = Array.isArray(messages) && messages.length > 0
    ? messages[0]
    : undefined
  const firstRecord = (typeof first === 'object' && first !== null)
    ? first as { role?: unknown, content?: unknown }
    : {}
  const content = firstRecord.content
  const firstContentBlock = Array.isArray(content) && content.length > 0 ? content[0] : undefined
  const firstText = (typeof firstContentBlock === 'object' && firstContentBlock !== null)
    ? (firstContentBlock as { text?: unknown }).text
    : undefined
  return {
    systemBlocks: blocks.length,
    identityChars: identityBlockChars.reduce((sum, n) => sum + n, 0),
    identityBlockChars,
    cliPrefixChars: identityBlockChars[0] ?? 0,
    hasDateBlock: typeof firstText === 'string' && firstText.startsWith('<system-reminder>'),
    firstRole: typeof firstRecord.role === 'string' ? firstRecord.role : '(无)',
  }
}

/** 传给 {@link formatZcodeDiagnostic} 的现场快照。 */
export interface ZcodeDiagnosticInput {
  /** 本次使用的账号（只用于取序号与画像，不进文案）。 */
  accountId: string | undefined
  /** 本次请求的出发时刻（毫秒）。 */
  sentAt: number
  /** 上游 HTTP 状态码。 */
  status: number
  /**
   * 实际发出的请求体形态。
   *
   * ★ **可选**（Gitee issue IKJOQB）。推理请求体有 `system` / `messages`，
   * 而**领取请求体只有 `{ plan_id }`** —— 两者结构完全不同，
   * 不能照搬 `describeZcodeRequestShape(system, messages)`。
   *
   * ⚠ 缺省时**只省略**依赖它的两项（`身份块` / `日期块`），
   * **其余五项照常输出** —— 账号序号、成功/失败计数、最近成功、距上条、HTTP
   * 这五项与请求形态**无关**，恰恰是 `3012` 排查里最有价值的部分
   * （「一直如此还是突然开始」「是否频率风控」全靠它们回答）。
   * 为了缺一个 shape 就把整行丢掉是错的取舍。
   */
  shape?: ZcodeRequestShape
  /**
   * ★ 本次请求**实际发出**的客户端版本（`User-Agent` / `X-ZCode-App-Version`）。
   *
   * ⚠ 2026-11-05 新增（Issue #45）：3012 的判据是「**版本号与身份块同代**」，
   * 跨代即 405 —— 而此前的诊断行只渲染身份块字符数，**版本号完全不可见** ⇒
   * 报障者（与维护者）都无法发现「版本 3.17.2 + 3.16 身份块」这种组合。
   * 取值必须来自 {@link zcodeInferenceAppVersion}（与真实请求头同源），
   * **不得**在这里另写一份门控。
   * ⚠ 缺省时整项省略（领取路径没有推理版本号）。
   */
  appVersion?: string
  /**
   * 上游的 `logid`（排障凭据，见 {@link extractZcodeLogId}）。
   *
   * ⚠ **可选**：取不到时整项**省略**（不留 `logid ` 空壳）。
   * ⚠ 与 `shape` 同一条纪律：**不编造**。它由 `extractZcodeLogId` 从
   * 真实响应（体或头）里读，读不到就是没有。
   */
  logId?: string
  /** 取当前时刻（可注入，便于单测）。 */
  now: number
}

/**
 * 把现场数据渲染成一行**不含任何凭据**的诊断摘要。
 *
 * ⚠ 字段顺序按 issue 的建议排：账号序号 → 计数 → 字符数 → 间隔 ——
 * 「最常被怀疑的」在前，「最容易被忽略的」在后。
 *
 * ⚠ `shape` 缺省时（领取路径，见 {@link ZcodeDiagnosticInput.shape}）
 * **只**少掉 `身份块` / `日期块` 两项，其余照常 —— 不要因为缺 shape
 * 就整行返回空串。
 */
export function formatZcodeDiagnostic(input: ZcodeDiagnosticInput): string {
  const key = normalizeKey(input.accountId)
  const profile = profiles.get(key)
  const ordinal = profile?.ordinal ?? accountOrdinal(input.accountId)
  const gap = profile?.previousSentAt === undefined
    ? '—'
    : formatGap(input.sentAt - profile.previousSentAt)
  /**
   * ★ 形态相关的两项单独成组，**缺 shape 时整组消失**。
   * ⚠ 判定用 `!== undefined` 而不是真值判断：`shape` 是对象，恒为真；
   *   真正的分支是「传了 / 没传」。
   */
  const shapeParts = input.shape === undefined
    ? []
    : [
      /**
       * ⚠⚠ **块数必须渲染出来**（2026-10-25 审计打穿）：405 的判据就是
       * 「system 是否为官方那 3 块」，而 `systemBlocks` 此前只被赋值、
       * **从没被渲染** ⇒ 3 块与 4 块构造出的诊断行**逐字相同**，
       * 下一次 405 报障完全看不出「是不是又变 4 块了」。
       * 这是排查该缺陷**唯一**的现成出口，别删。
       */
      `system ${input.shape.systemBlocks} 块`,
      `身份块 ${input.shape.identityChars} 字符(${
        input.shape.identityBlockChars.length > 0
          ? input.shape.identityBlockChars.join('+')
          : '无'
      })`,
      /**
       * ⚠ 版本号紧跟在身份块之后：两者**必须同代**（Issue #45 的唯一判据），
       * 放在相邻位置才能一眼看出「版本 3.17.2 + 2608 字符身份块」这类跨代组合。
       */
      ...input.appVersion === undefined || input.appVersion.length === 0
        ? []
        : [`版本 ${input.appVersion}`],
      `日期块 ${input.shape.hasDateBlock ? '有' : '无'}`,
    ]
  return [
    `账号#${ordinal}`,
    `本进程 成功 ${profile?.ok ?? 0}/失败 ${profile?.failed ?? 0}`,
    `最近成功 ${formatSinceLastOk(profile?.lastOkAt, input.now)}`,
    `距上条 ${gap}`,
    ...shapeParts,
    `HTTP ${input.status}`,
    /**
     * ⚠ `logid` 排在**最后**：它最长（32 位十六进制），
     * 放前面会把「账号 / 计数 / 身份块」这些一眼要看的信息挤到屏幕外。
     * ⚠ 只有在**真的有值**时才出现 —— 取不到时整项消失（不编造）。
     */
    ...input.logId === undefined || input.logId.length === 0
      ? []
      : [`logid ${input.logId}`],
  ].join(' · ')
}

/**
 * 清空全部进程级状态（**只给单测的 `beforeEach` 用**）。
 *
 * ⚠ 与 `resetCaptchaRequirementMemory()` 同款：序号分配器也一并归零，
 * 否则同一进程里跑两轮用例会拿到不同的 `账号#N`，断言就得写成相对值。
 */
export function resetZcodeDiagnostics(): void {
  profiles.clear()
  nextOrdinal = 1
}
