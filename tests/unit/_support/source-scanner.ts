/**
 * ★★★ **源码级「调用实参」扫描器**（2026-11-28，PR #184 审结后抽出）
 *
 * ## 为什么单独建这个模块（上游给出的判据）
 *
 * > **判据定位用的「手段」也可能有盲区。**
 * > 长度窗口 → 会被插注释打穿；
 * > 括号配平 → 会被字符串/注释里的括号打穿；
 * > **只有「跳过字符串和注释的真扫描」才是这类断言的稳定基础。**
 *
 * ## 它修掉的三个真实打穿（都是上游对抗审计实测）
 *
 * | 朴素实现 | 注入 | 后果 |
 * |---|---|---|
 * | 固定字符窗口 `slice(at, at+600)` | 在两处之间插一行注释 | **假红**（余量仅 13 字符）|
 * | 只数 `(` / `)` | 注释里一个未配对 `(` | 切片**静默越界**（极端到 93,876 字符）|
 * | 同上 | 一个未配对 `)` | 截断到 31 字符 ⇒ **假红** |
 * | `stripComments` 不剥字符串 | 字符串里写 `'imminentFloor: value?.imminentFloor'` | **假绿** |
 *
 * ## ⚠️ 最该看的那条（决定性打穿）
 *
 * > **弹窗那处真删两个阈值**（对照：不加注释 ⇒ 2 failed）
 * > **加一条行尾注释**写 `sumAvailableCredits(` ⇒ **6 passed**
 *
 * 机制：注释里那个假调用点的切片**吞到文件尾**，把真弹窗调用点跳过；
 * `count` 仍 = 2，而吞进来的第三处字段**替它过关**。
 *
 * ⇒ **一句行尾注释就够打穿朴素计数。** 本模块的存在理由就是它。
 *
 * ## ⚠️ 局限（如实登记）
 *
 * 这是**文本级**守卫，不是行为级。它挡不住「把整段代码包进 `if (false)`」——
 * 那只由**行为级**用例（真跑函数看返回值）负责。两者互补，不是替代。
 */

/**
 * 从 `callee(` 起，**跳过字符串 / 模板 / 注释**做括号配平，返回每处调用的实参原文。
 *
 * ## 跳过规则
 *
 * | 构造 | 处理 |
 * |---|---|
 * | `'…'` / `"…"` / `` `…` `` | 进入引号态，只找配对引号；`\\` 转义跳过下一字符 |
 * | `// …` | 跳到行尾 |
 * | `/* … *\/` | 跳到 `*\/` |
 * | 行首是注释的行（`*` / `//` / `/*`）| 整处**不算调用点**（文档示例里的 `callee(` 不算）|
 *
 * ⚠️ **不做正则字面量识别**：本仓 client 代码里 `/…/` 极少，且真出现时
 * 里面的括号通常配平。**如实登记这个未覆盖面**，不为它编造复杂逻辑。
 *
 * @param source - 源码全文
 * @param callee - 函数名（**不含** `(`）
 * @returns 每处调用的**实参原文**（不含最外层括号）；找不到 ⇒ `[]`
 */
export function callArgsOf(source: string, callee: string): string[] {
  const needle = `${callee}(`
  const out: string[] = []
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at < 0) break
    from = at + needle.length
    /** 行首是注释 ⇒ 跳过（避免命中文档里的 `callee(` 示例）。 */
    const lineStart = source.lastIndexOf('\n', at) + 1
    if (/^\s*(\*|\/\/|\/\*)/.test(source.slice(lineStart, at))) continue

    let depth = 0
    let i = at + callee.length
    let quote: string | null = null
    for (; i < source.length; i += 1) {
      const ch = source[i]
      if (quote !== null) {
        if (ch === '\\') { i += 1; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
      /** 行注释：跳到行尾。 */
      if (ch === '/' && source[i + 1] === '/') {
        const nl = source.indexOf('\n', i)
        i = nl < 0 ? source.length : nl
        continue
      }
      /** 块注释：跳到结束。 */
      if (ch === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2)
        i = end < 0 ? source.length : end + 1
        continue
      }
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    out.push(source.slice(at + callee.length + 1, i))
  }
  return out
}

/**
 * 去掉**注释与字符串内容**，只留「代码骨架」。
 *
 * ## 为什么必须剥字符串（上游实测的假绿）
 *
 * 旧实现 `stripComments` **只剥注释**。于是：
 *
 * ```js
 * // 攻击：在某个函数体里写一行字符串
 * const note = 'imminentFloor: value?.imminentFloor'
 * ```
 *
 * ⇒ 旧守卫 `args.includes('imminentFloor:')` **仍然为真** ⇒ **假绿**。
 *
 * ⇒ 本函数把字符串内容替换成 `''`（保留引号，维持语法形态可读）。
 *
 * @param text - 任意源码片段
 * @returns 剥掉注释与字符串内容后的文本
 */
export function stripCommentsAndStrings(text: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < text.length) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\') { i += 2; continue }
      if (ch === quote) { quote = null; out += ch; i += 1; continue }
      /** 字符串内容整体丢弃（不保留，否则内容仍能被 `includes` 命中）。 */
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}
