/**
 * ★★★ **源码级「调用实参」扫描器**（2026-11-28，PR #184 审结后抽出；PR #186 后第二轮修正）
 *
 * ## 为什么单独建这个模块（上游给出的判据）
 *
 * > **判据定位用的「手段」也可能有盲区。**
 * > 长度窗口 → 会被插注释打穿；
 * > 括号配平 → 会被字符串/注释里的括号打穿；
 * > **只有「跳过字符串和注释的真扫描」才是这类断言的稳定基础。**
 *
 * ## 版本史（每一代都是被打穿后改的）
 *
 * | 代 | 手段 | 打穿方式 |
 * |---|---|---|
 * | v1 | 固定字符窗口 `slice(at, at+600)` | 插一行注释 ⇒ **假红**（余量仅 13 字符）|
 * | v2 | 只数 `(` / `)` | 注释里未配对 `(` ⇒ 切片**越界到 93,876 字符** |
 * | v2 | 同上 | 一个未配对 `)` ⇒ 截断到 31 字符 ⇒ **假红** |
 * | v2 | `stripComments` 不剥字符串 | 字符串里写 `'imminentFloor: …'` ⇒ **假绿** |
 * | v3 | 跳字符串/模板/注释 | ✅ 封住上面全部 —— **但仍有 3 个洞**（见下）|
 * | **v4（本版）** | **+ 正则字面量识别 + 模板 `${}` 嵌套扫描** | — |
 *
 * ## v3 剩下的 3 个洞（本轮实测，全部能打穿）
 *
 * ⚠️ 诱饵必须放在**实参内部**才生效 —— 放在调用之前/之后都不影响（实测 9 组外部诱饵全绿）。
 *
 * | # | 诱饵（实参内部）| 后果 |
 * |---|---|---|
 * | **D1** | `re: /\\(/g` | 扫描器把 `\(` 的 `(` 当代码 ⇒ 深度不配平 ⇒ **切片吞到别处**（假绿）|
 * | **D2** | `re: /\\)/g` | `\)` 的 `)` 当代码 ⇒ 深度提前归零 ⇒ **截断**（假红）|
 * | **D6** | `` s: `${sumAvailableCredits(x, { expiringFloor: v })}` `` | 模板被整体跳过 ⇒ 嵌套调用**污染外层判断** |
 *
 * ⇒ v4 修法：**正则字面量识别**（含字符类 `[...]` 与转义）+ **模板 `${}` 内部按代码扫描**。
 *
 * ## ⚠️ 局限（如实登记）
 *
 * 1. **正则/除法歧义**用「前一个有效字符」启发式判断（同 JS 词法分析的常用做法）。
 *    极端构造（如 `a = b\n/re/` 这种 ASI 边界）可能判错 —— 本仓 client 代码无此写法。
 * 2. 这是**文本级**守卫，挡不住「把整段包进 `if (false)`」—— 那只由**行为级**用例负责。
 */

/** 扫描器内的词法状态。 */
type ScanState =
  | { kind: 'code', templateDepth: number }
  | { kind: 'single' }
  | { kind: 'double' }
  | { kind: 'regex', inClass: boolean }
  | { kind: 'lineComment' }
  | { kind: 'blockComment' }

/**
 * 正则字面量 `[` 内的字符原样取字面量 —— 本文件不序列化，仅供 `argMaxChars` 判定用。
 * （占位字段，保持代码可读）
 */

export interface CallArgsResult {
  /** 每处调用的实参原文（不含最外层括号）。 */
  args: string[]
  /** 跳过（未计入）的调用点数 —— 注释/字符串/正则里出现的伪调用点。 */
  skipped: number
}

/**
 * 判断 `source[i]` 处的 `/` 是否**正则字面量起点**（而非除号）。
 *
 * ## 判据（JS 词法分析的常用启发式）
 *
 * 看**上一个有效字符** `prev`：
 * - **是正则起点**：`prev` 为空 / 是运算符 / 是开括号 `([{,;:=!&|?+-*%~^<>` / 是关键字末尾（粗判）
 * - **是除号**：`prev` 是标识符字符 / 数字 / `)` / `]`
 *
 * ⚠️ 粗判的边界：`return /re/` 里 `prev` 是 `n`（标识符字符）⇒ 会**误判成除号**。
 *    本仓 client 代码里没有 `return /regex/` 写法；如未来出现，本函数需补关键字表。
 *    **如实登记这个已知误判面。**
 */
function isRegexStart(prev: string | null): boolean {
  if (prev === null) return true
  /** 标识符 / 数字 / `)` / `]` 之后 ⇒ 除号。 */
  if (/[A-Za-z0-9_$\]\)]/.test(prev)) return false
  /** 其余（运算符、开括号、逗号、空白后的符号）⇒ 正则起点。 */
  return true
}

/**
 * 从 `callee(` 起，**跳过字符串 / 模板（含 `${}` 嵌套）/ 正则 / 注释**做括号配平，
 * 返回每处调用的实参原文。
 *
 * @param source - 源码全文
 * @param callee - 函数名（**不含** `(`）
 * @returns 每处调用的实参原文（不含最外层括号）；找不到 ⇒ `[]`
 */
export function callArgsOf(source: string, callee: string): string[] {
  return scanCalls(source, callee).args
}

/** 同上，但同时回报「跳过了多少伪调用点」（供自检用例断言）。 */
export function scanCalls(source: string, callee: string): CallArgsResult {
  const needle = `${callee}(`
  const out: string[] = []
  let skipped = 0
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at < 0) break
    from = at + needle.length
    /** 行首是注释 ⇒ 跳过（避免命中文档里的 `callee(` 示例）。 */
    const lineStart = source.lastIndexOf('\n', at) + 1
    if (/^\s*(\*|\/\/|\/\*)/.test(source.slice(lineStart, at))) { skipped += 1; continue }

    let depth = 0
    let i = at + callee.length
    /** ⚠️ 模板 `${}` 需要一个**栈**：模板可嵌套（`` `a${`b${c}`}d` ``）。 */
    const stack: ScanState[] = [{ kind: 'code', templateDepth: 0 }]
    /** 上一个有效字符（用于 `/` 的正则/除法判别）。 */
    let prev: string | null = null

    for (; i < source.length; i += 1) {
      const ch = source[i]
      const top = stack[stack.length - 1]

      if (top.kind === 'single' || top.kind === 'double') {
        if (ch === '\\') { i += 1; continue }
        if (ch === (top.kind === 'single' ? "'" : '"')) stack.pop()
        continue
      }

      if (top.kind === 'regex') {
        if (ch === '\\') { i += 1; continue }
        /** 字符类 `[...]` 内的 `/` 不结束正则。 */
        if (ch === '[') { (top as { inClass: boolean }).inClass = true; continue }
        if (ch === ']') { (top as { inClass: boolean }).inClass = false; continue }
        if (ch === '/' && !(top as { inClass: boolean }).inClass) { stack.pop(); prev = '/'; continue }
        continue
      }

      if (top.kind === 'lineComment') {
        if (ch === '\n') stack.pop()
        continue
      }

      if (top.kind === 'blockComment') {
        if (ch === '*' && source[i + 1] === '/') { stack.pop(); i += 1 }
        continue
      }

      /**
       * ⚠️⚠️ **模板态必须在「引号判断」之前处理**（v4 修的真实 bug）。
       *
       * v4 初版把这个块放在 `if (ch === "'")` **之后** ⇒ 模板正文里的 `(` 落到
       * 通用代码分支 ⇒ 深度 +1 ⇒ 切片**吞到文件尾**（实测：实参里出现了邻处的
       * `expiringFloor` = 假绿）。
       *
       * ## 模板态的三件事
       *
       * 1. `${` ⇒ 压入一层**代码**（插值内是真代码，要照常扫描）
       * 2. `` ` `` ⇒ 弹回
       * 3. `}` ⇒ 弹回该层插值
       * 4. **其余一切（含 `(` `)` `'` `"` `/`）都是字面量正文 ⇒ 直接跳过**
       */
      if (top.templateDepth > 0) {
        if (ch === '$' && source[i + 1] === '{') {
          stack.push({ kind: 'code', templateDepth: 0 })
          i += 1
          prev = '{'
          continue
        }
        if (ch === '`') { stack.pop(); prev = '`'; continue }
        if (ch === '}') { stack.pop(); prev = '}'; continue }
        /** 模板字面量正文：跳过（**不得**进入引号/正则/括号判断）。 */
        continue
      }

      /** ── 代码态（非模板正文）── */
      if (ch === "'") { stack.push({ kind: 'single' }); continue }
      if (ch === '"') { stack.push({ kind: 'double' }); continue }
      /** 模板开始：进入模板态（`templateDepth: 1` 表示「当前在模板正文里」）。 */
      if (ch === '`') { stack.push({ kind: 'code', templateDepth: 1 }); continue }

      if (ch === '/' && source[i + 1] === '/') { stack.push({ kind: 'lineComment' }); i += 1; continue }
      if (ch === '/' && source[i + 1] === '*') { stack.push({ kind: 'blockComment' }); i += 1; continue }

      /**
       * ★ **正则字面量识别**（v4 新增）——
       * v3 把 `/` 当普通字符，于是 `/\\(/` 里的 `(` 和 `/\\)/` 里的 `)` 被当代码，
       * 分别导致「切片吞到别处」与「提前截断」。
       */
      if (ch === '/' && isRegexStart(prev)) {
        stack.push({ kind: 'regex', inClass: false })
        continue
      }

      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) break
      }
      /** 只在深度 0（= 本次调用的括号层）时更新 prev，避免被内部符号带偏。 */
      if (depth === 0 || true) prev = ch
    }
    out.push(source.slice(at + callee.length + 1, i))
  }
  return { args: out, skipped }
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
 * ⇒ 本函数把字符串内容替换成空，保留引号维持语法形态。
 *
 * ## ⚠️ v4 补充：模板 `${}` 内部**必须保留**（那是真代码）
 *
 * v3 把整个模板当字符串剥掉 ⇒ `${imminentFloor}` 这种**真代码**也被剥了。
 * 本版对模板做「保留 `${}` 内部、剥字面量正文」的处理。
 */
export function stripCommentsAndStrings(text: string): string {
  let out = ''
  let i = 0
  const stack: ScanState[] = [{ kind: 'code', templateDepth: 0 }]

  while (i < text.length) {
    const ch = text[i]
    const top = stack[stack.length - 1]

    if (top.kind === 'single' || top.kind === 'double') {
      if (ch === '\\') { i += 2; continue }
      if (ch === (top.kind === 'single' ? "'" : '"')) { stack.pop(); out += ch }
      i += 1
      continue
    }
    if (top.kind === 'regex') {
      if (ch === '\\') { i += 2; continue }
      if (ch === '[') { (top as { inClass: boolean }).inClass = true; i += 1; continue }
      if (ch === ']') { (top as { inClass: boolean }).inClass = false; i += 1; continue }
      if (ch === '/' && !(top as { inClass: boolean }).inClass) { stack.pop(); out += ch }
      i += 1
      continue
    }
    if (top.kind === 'lineComment') {
      if (ch === '\n') { stack.pop(); out += ch }
      i += 1
      continue
    }
    if (top.kind === 'blockComment') {
      if (ch === '*' && text[i + 1] === '/') { stack.pop(); i += 2; continue }
      i += 1
      continue
    }

    /**
     * ⚠️ 模板态**必须先于引号判断**（与 `callArgsOf` 同一个 bug，同一处修正）。
     * 模板正文里的一切都是字面量 ⇒ 丢弃，但保留 `${}` 内的真代码。
     */
    if (top.templateDepth > 0) {
      if (ch === '$' && text[i + 1] === '{') {
        stack.push({ kind: 'code', templateDepth: 0 })
        out += '${'
        i += 2
        continue
      }
      /** 模板正文：丢弃；但保留闭合标记以维持形态。 */
      if (ch === '`') { stack.pop(); out += ch }
      else if (ch === '}') { stack.pop(); out += ch }
      i += 1
      continue
    }

    if (ch === "'") { stack.push({ kind: 'single' }); out += ch; i += 1; continue }
    if (ch === '"') { stack.push({ kind: 'double' }); out += ch; i += 1; continue }
    if (ch === '`') { stack.push({ kind: 'code', templateDepth: 1 }); out += ch; i += 1; continue }

    if (ch === '/' && text[i + 1] === '/') { stack.push({ kind: 'lineComment' }); i += 2; continue }
    if (ch === '/' && text[i + 1] === '*') { stack.push({ kind: 'blockComment' }); i += 2; continue }
    /** 正则内容整体丢弃（与字符串同款）。 */
    if (ch === '/' && isRegexStart(out.length === 0 ? null : out[out.length - 1] ?? null)) {
      stack.push({ kind: 'regex', inClass: false })
      out += ch
      i += 1
      continue
    }

    out += ch
    i += 1
  }
  return out
}
