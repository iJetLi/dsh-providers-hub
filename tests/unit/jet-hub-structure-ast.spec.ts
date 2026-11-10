import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = resolve(HERE, '../../plugin-src/client')
const source = readFileSync(resolve(CLIENT, 'jet-hub.js'), 'utf8')

/**
 * 客户端 JSX-free 源码里的**真实结构**只能靠 AST 判断，不能靠字符串切片的
 * 先后顺序 —— 后者在括号错位时仍然「看起来正确」。
 *
 * 本文件守的是 2026-10-26 那类**括号错位事故**：把排序提示挪进
 * `.dim-jh-panelHead` 时少关了一层，panelHead 一路包到文件末尾，
 * 于是补偿卡片（flex: 0 1 auto）被挤到按钮组同一行的最右侧 ——
 * 用户看到的症状是「为什么最右侧显示的是补偿积分已领取」。
 * 所有既有源码文本断言**全部通过**（它们只比 indexOf 先后），
 * 只有 AST 能发现这类错误。
 */

const sf = ts.createSourceFile('jet-hub.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1

/** 取 createElement 调用的字符串 className（不是字面量则 null）。 */
function classNameOf(node) {
  if (!node || !ts.isCallExpression(node)) return null
  const props = node.arguments[1]
  if (!props || !ts.isObjectLiteralExpression(props)) return null
  for (const p of props.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'className') {
      const v = p.initializer
      if (ts.isStringLiteral(v)) return v.text
    }
  }
  return null
}

/** 收集所有 createElement('section', ...) 调用。 */
function sectionCalls() {
  const out = []
  const walk = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = source.slice(node.expression.getStart(sf), node.expression.getEnd())
      const first = node.arguments[0]
      if (callee.endsWith('.createElement') && first && ts.isStringLiteral(first) && first.text === 'section') {
        out.push(node)
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return out
}

/**
 * 账号管理页那个 section。
 *
 * ⚠️ 2026-10-26 起它**有 className**（`dim-jh-accountSection`，滚动边界要用），
 *    所以不能再靠「section 且无 className」去认 —— 按类名直取，取不到再退回
 *    「行号在 4000~4900 之间的 section」这条老判据。
 */
function accountSectionCall() {
  const byClass = sectionCalls().find((s) => classNameOf(s) === 'dim-jh-accountSection')
  if (byClass) return byClass
  return sectionCalls().find((s) => {
    const ln = lineOf(s.getStart(sf))
    return ln > 4000 && ln < 4900
  })
}

/** 找唯一的 panelHead 调用。 */
function panelHeadCall() {
  let found = null
  const walk = (node) => {
    if (ts.isCallExpression(node) && classNameOf(node) === 'dim-jh-panelHead') found = node
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return found
}

/** 找唯一的 headerActions 调用（页头那两组里取面板那组）。 */
function headerActionsCalls() {
  const out = []
  const walk = (node) => {
    if (ts.isCallExpression(node) && classNameOf(node) === 'dim-jh-headerActions') out.push(node)
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return out
}

describe('★★ 账号管理页结构（AST 级，防括号错位）', () => {
  it('源码能被 TypeScript 正常解析（无语法错）', () => {
    // @ts-expect-error 内部字段
    const diags = sf.parseDiagnostics || []
    expect(diags.map((d) => `${lineOf(d.start)}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`))
      .toEqual([])
  })

  it('★★★ panelHead 的子节点只能是「标题行 + 状态提示 + 排序提示 + 严格手动顺序行 + 按钮组」', () => {
    const ph = panelHeadCall()
    expect(ph, '找不到 .dim-jh-panelHead').toBeTruthy()
    const children = ph.arguments.slice(2)
    // 2026-10-26 第二次改（用户「信息应该在按钮行上方行，而不是下方行」）：
    // 面板级状态提示从 section 直接子节点搬进 panelHead、排在按钮组**之前**。
    // 顺序契约：标题 → 7 条状态提示 → 排序提示三元 → 严格手动顺序行 → 按钮组。
    // ⚠️ 2026-11-09：新增「严格手动顺序」行（`.dim-jh-orderMode`，见
    //    `strict-manual-order.spec.ts`）。它**必须**紧跟在排序提示之后、
    //    按钮组之前 —— 这两句是同一个话题（「顺序是怎么用的」），拆开会让
    //    用户以为那个开关管的是别的东西。
    expect(
      children.length,
      `panelHead 应包 1 标题 + 7 条状态提示 + 1 排序提示 + 1 严格手动顺序行 + 1 按钮组 = 11 个子项，实际 ${children.length} 个`
      + `（多出来的是被括号错位圈进来的：第 12 个起是 ${children.slice(11)
        .map((c) => source.slice(c.getStart(sf), c.getStart(sf) + 40).replace(/\s+/g, ' '))
        .join(' | ')}）`,
    ).toBe(11)
    // ⚠️ 2026-11-06：第一个子项从 `.dim-jh-panelTitle` 变成
    //    `.dim-jh-panelTitleRow`（标题 + 最右侧的「供应商开关」图标**包了一层
    //    行容器**）。**不能**直接把标题改成 `flex: 1 1 auto` 了事 —— 那样
    //    标题 + 图标 + 按钮组会在宽屏下挤成一行（1400px 有约 930px 富余，
    //    wrap 不触发），2026-10-26 的「标题独占一整行」当场破掉。那条契约
    //    现在由 `.dim-jh-panelHead > .dim-jh-panelTitleRow { flex: 1 0 100% }`
    //    保证，见 `tests/unit/provider-toggle.spec.ts` 的「★★ 样式侧」。
    expect(classNameOf(children[0])).toBe('dim-jh-panelTitleRow')
    expect(classNameOf(children[children.length - 1])).toBe('dim-jh-headerActions')
    // 中间那个三元是排序提示（accounts.length > 1 ? <p.orderHint> : null）
    const orderHintIdx = children.findIndex((c) => source.slice(c.getStart(sf), c.getEnd())
      .includes("className: 'dim-jh-orderHint'"))
    expect(orderHintIdx, '排序提示必须在 panelHead 里、且紧挨在严格手动顺序行之前').toBe(children.length - 3)
    // ⚠️ 条件必须**恰好**是 accounts.length > 1：只判「文本里含 orderHint」时，
    //    把条件改成 `accounts.length > 1 && false` 仍然是绿的，而提示从此永不显示
    //    （变异验证实测 NO-TEETH）。故这里用 AST 取 condition 原文比对。
    const orderHintNode = children[orderHintIdx]
    expect(ts.isConditionalExpression(orderHintNode), '排序提示必须是三元表达式').toBe(true)
    const condText = source.slice(orderHintNode.condition.getStart(sf), orderHintNode.condition.getEnd())
    expect(condText.replace(/\s+/g, ' '), '排序提示的显示条件被改了').toBe('accounts.length > 1')
    /**
     * 「严格手动顺序」行：**必须在排序提示与按钮组之间**（2026-11-09）。
     *
     * ⚠️ 与排序提示同一条纪律 —— 只判「文本里含 orderMode」时，把条件改成
     * `canStrictOrder && false` 仍然全绿，而开关从此永不显示（变异实测
     * NO-TEETH 的同一个形态）。故这里也取 condition 原文比对。
     */
    const strictRowIdx = children.findIndex((c) => source.slice(c.getStart(sf), c.getEnd())
      .includes("className: 'dim-jh-orderMode'"))
    expect(strictRowIdx, '严格手动顺序行必须在 panelHead 里、紧跟排序提示').toBe(orderHintIdx + 1)
    const strictRowNode = children[strictRowIdx]!
    expect(ts.isConditionalExpression(strictRowNode), '严格手动顺序行必须是三元表达式').toBe(true)
    const strictCond = source.slice(strictRowNode.condition.getStart(sf), strictRowNode.condition.getEnd())
    // ⚠️ 条件是 `canStrictOrder`（= 只在走余额分档的渠道渲染）。
    //    改成 `true` 会让不分档的渠道也出现一个「打开后行为不变」的开关。
    expect(strictCond.replace(/\s+/g, ' '), '严格手动顺序行的渲染条件被改了').toBe('canStrictOrder')
    // 补偿卡片必须在按钮组**之前**（它曾经被挤到按钮组右侧，那次事故的根因）
    const compIdx = children.findIndex((c) => source.slice(c.getStart(sf), c.getEnd()) === 'compensationCard')
    expect(compIdx, '补偿卡片必须在 panelHead 里、且在按钮组之前').toBeGreaterThan(0)
    expect(compIdx).toBeLessThan(children.length - 1)
  })

  /**
   * ★ 用户 2026-10-26「信息应该在按钮行上方行，而不是下方行」：
   * 面板级状态提示**必须**在 panelHead 内、且在按钮组之前。
   *
   * ⚠️ 这条不能用「整份源码里 indexOf 比大小」来写：那些提示的关键字在
   *    section 之外的别处也有，改错位置不会变红。必须 AST 定位到 panelHead
   *    的子节点序列，逐个判 className 与位置。
   */
  it('★★ 七条状态提示都在 panelHead 内、且都排在按钮组之前', () => {
    const ph = panelHeadCall()
    expect(ph, '找不到 .dim-jh-panelHead').toBeTruthy()
    const children = ph.arguments.slice(2)
    const actionsIdx = children.findIndex((c) => classNameOf(c) === 'dim-jh-headerActions')
    expect(actionsIdx, 'panelHead 里找不到按钮组').toBeGreaterThan(-1)

    // 每条提示都以 .dim-jh-probeNotice 形态出现（compensationCard 内部自己带该类名，
    // 它在 panelHead 里是**标识符引用**而不是 createElement 调用 ⇒ 单独判）
    const noticeNodes = children.slice(0, actionsIdx).filter((c) => {
      const text = source.slice(c.getStart(sf), c.getEnd())
      return text.includes("className: 'dim-jh-probeNotice'") || text === 'compensationCard'
    })
    expect(
      noticeNodes.length,
      `按钮组之前应有 7 条状态提示（探测/锁定/领取/新手任务/登录链接/回调链接/补偿卡），实际 ${noticeNodes.length} 条`
      + '（少了说明有提示还留在 section 直接子级 ⇒ 会落到按钮行下方）',
    ).toBe(7)
  })

  /**
   * ★ 七条提示的**条件**必须是那七个具体变量。
   *
   * ⚠️ 只数「按钮组之前有几个 .dim-jh-probeNotice」是不够的：把
   *    `probeNotice ? ... : null` 改成 `null ? ... : null` 之后，节点数不变、
   *    文本里照样有那个类名 ⇒ 上一条用例仍然绿，而这条提示从此永不显示
   *    （变异验证实测 NO-TEETH，正是这条用例补上的）。
   */
  it('★★ 七条状态提示的条件必须是各自的变量（不许被短路成恒 null）', () => {
    const ph = panelHeadCall()
    expect(ph, '找不到 .dim-jh-panelHead').toBeTruthy()
    const children = ph.arguments.slice(2)
    const actionsIdx = children.findIndex((c) => classNameOf(c) === 'dim-jh-headerActions')
    const before = children.slice(0, actionsIdx).map((c) => source.slice(c.getStart(sf), c.getEnd()))

    const expected = ['probeNotice', 'lockNotice', 'claimNotice', 'onboardingNotice', 'loginUrlForManual', 'showCodeartsCallback', 'compensationCard']
    for (const name of expected) {
      /**
       * ⚠️⚠️ 判据必须是**精确标识符 + 词边界**，不能 `startsWith`（2026-10-27 对抗审计 P1-3）。
       *
       * 原写法 `t.startsWith(name)` 有一个真实旁路：插入
       * `const probeNoticeLegacy = null;` 并把子项换成 `probeNoticeLegacy ? …`
       * ⇒ `'probeNoticeLegacy ? …'.startsWith('probeNotice') === true`，节点数与
       * 类名文本全部照旧 ⇒ **8 条用例全绿，而该提示从此永不显示**（实测复现）。
       * 反向钉子 `^null\s*\?` 也挡不住它（首字符是 `p` 不是 `n`）。
       */
      const matched = before.some((t) => t === name || new RegExp(`^${name}\\s*\\?`).test(t.trim()))
      expect(
        matched,
        `按钮组之前的提示里找不到条件为「${name} ?」的那一条 —— 该提示要么被删了，`
        + '要么条件被换成了前缀相同的另一个标识符（如 '
        + `${name}Legacy ?）`
        + `（实际：${before.map((t) => t.slice(0, 24).replace(/\s+/g, ' ')).join(' | ')}）`,
      ).toBe(true)
    }
    // 反向钉子：不许出现 `null ?` 这种恒假短路（M3 的形态）
    expect(before.join('\n'), '提示条件被短路成恒 null ⇒ 提示永不显示').not.toMatch(/^null\s*\?/m)
    /**
     * ⚠️ 反向钉子之二（2026-10-27 对抗审计 P2）：「名字还在」不等于「真的会渲染」。
     * `const compensationCard = false && …` 这类**常量假条件**会让标识符仍在、
     * 子项数不变、上一条计数照样过 —— 而卡片永不显示。
     * ⇒ 对**裸标识符**形态的提示，追到它的声明，断言初始化式不是字面假值。
     */
    for (const name of expected) {
      const decl = new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]{0,60})`).exec(source)
      if (decl === null) continue
      const init = decl[1]!.trim()
      expect(
        /^(?:false|null|undefined|0)\b/.test(init),
        `${name} 的初始化式是常量假值（${init.slice(0, 24)}）⇒ 该提示永不渲染，`
        + '而节点计数与条件名断言都会照样通过',
      ).toBe(false)
      expect(
        /^(?:false|null)\s*&&/.test(init),
        `${name} 被短路成「假值 && …」⇒ 该提示永不渲染`,
      ).toBe(false)
    }
  })

  it('★★ 面板级提示必须在 panelHead 里独占整行（否则会与按钮组挤同一行）', () => {
    const styles = readFileSync(resolve(CLIENT, 'jet-hub-styles.js'), 'utf8')
    const rule = styles.match(/\.dim-jh-panelHead > \.dim-jh-probeNotice \{[^}]*\}/)?.[0]
    expect(rule, '缺少 .dim-jh-panelHead > .dim-jh-probeNotice 规则').toBeTruthy()
    expect(rule, '缺 flex: 1 0 100% ⇒ 提示会与按钮组挤在同一行（补偿卡那次报障的形态）')
      .toMatch(/flex:\s*1 0 100%/)
    expect(rule, 'margin-bottom 必须归零：行间距由 panelHead 的 gap 统一给').toMatch(/margin-bottom:\s*0/)
  })

  it('★★ section 的直接子节点里不得再出现任何状态提示', () => {
    const target = accountSectionCall()
    expect(target, '找不到账号管理页的 section').toBeTruthy()
    const childTexts = target.arguments.slice(2).map((c) => source.slice(c.getStart(sf), c.getEnd()))
    const phIdx = childTexts.findIndex((t) => t.includes("className: 'dim-jh-panelHead'"))
    expect(phIdx, 'section 里找不到 panelHead').toBeGreaterThan(-1)
    const after = childTexts.slice(phIdx + 1)
    // panelHead **之后**的子节点（= 视觉上落在按钮行下方的那些）不许有面板级提示卡片。
    // ⚠️ 判据必须是「**顶层就是** probeNotice」而不是「文本里含 probeNotice」：
    //    accountList 内部的 reorderError 提示也是 .dim-jh-probeNotice，但它在
    //    账号列表里面（顺序保存失败时贴着卡片显示，位置正确），文本包含判据
    //    会把它误报成「漏在按钮行下方」。
    const strays = after.filter((t) => /^\s*React\.createElement\('div',\s*\{\s*className:\s*'dim-jh-probeNotice'/.test(t))
    expect(
      strays.length,
      `panelHead 之后仍有 ${strays.length} 条面板级 .dim-jh-probeNotice —— 它们会显示在按钮行下方：`
      + strays.map((t) => t.slice(0, 60).replace(/\s+/g, ' ')).join(' | '),
    ).toBe(0)
    expect(after.join('\n'), '补偿卡片必须已搬进 panelHead').not.toContain('compensationCard')
    expect(after.join('\n'), '登录链接提示必须已搬进 panelHead').not.toContain('loginUrlForManual')
  })

  it('★★ 账号列表必须是 section 的直接子节点（不在 panelHead 里）', () => {
    const target = accountSectionCall()
    expect(target, '找不到账号管理页的 section').toBeTruthy()
    const childTexts = target.arguments.slice(2).map((c) => source.slice(c.getStart(sf), c.getEnd()))
    const phIdx = childTexts.findIndex((t) => t.includes("className: 'dim-jh-panelHead'"))
    expect(phIdx, 'section 里找不到 panelHead').toBeGreaterThan(-1)
    // panelHead 之后必须还有别的子节点（账号列表 / 各弹窗）
    expect(childTexts.length, 'section 只剩 panelHead 一个子节点 ⇒ 说明其余内容被圈进 panelHead 了')
      .toBeGreaterThan(5)
    const joined = childTexts.join('\n')
    // ⚠️ 2026-10-26 第二次改后：补偿卡片已搬进 panelHead（用户要求「信息应该在
    //    按钮行上方行」），故这里**不再**断言补偿卡在 section 下 —— 它现在
    //    必须出现在 panelHead 内（由上面那条「七条状态提示」用例守）。
    expect(joined, '账号列表必须挂在 section 下').toContain("className: 'dim-jh-accountList'")
    const after = childTexts.slice(phIdx + 1).join('\n')
    expect(after, '账号列表必须在 panelHead 之后').toContain("className: 'dim-jh-accountList'")
  })

  it('★★ headerActions 必须闭合在 panelHead 之前（不许把面板主体吞进去）', () => {
    const ha = headerActionsCalls()
    const ph = panelHeadCall()
    // ⚠️ 2026-11-05 侧边栏重构：**全局页头整个删掉了**（供应商 / 一键签到 /
    //    网关 / 用量 / 渠道原生搜索四个按钮搬进侧边栏底部操作行），所以
    //    headerActions 只剩账号面板里那一处。哪天有人把页头加回来，这条会红，
    //    提醒他同时检查「共用类名改默认值会不会波及另一处」。
    expect(ha.length, '页头按钮组只应剩账号面板里那一处（全局页头已删除）').toBe(1)
    const panelActions = ha.find((n) => n.getStart(sf) > ph.getStart(sf) && n.getEnd() < ph.getEnd())
    expect(panelActions, 'panelHead 内找不到 headerActions').toBeTruthy()
    // 面板那组的结束位置必须早于 panelHead 的结束位置，且两者之间只差收尾括号
    const gap = source.slice(panelActions.getEnd(), ph.getEnd())
    expect(gap.replace(/\s/g, ''), `panelHead 收尾多出内容：${JSON.stringify(gap)}`).toMatch(/^\)+$/)
    expect(gap.replace(/\s/g, '').length, 'panelHead 与按钮组之间只应差一个右括号').toBeLessThanOrEqual(2)
  })
})

/**
 * ⚠️⚠️ **客户端的「请求序号」闸门必须真实存在**（2026-11-05 合规审计：代码对、
 * 零守卫 —— 删掉闸门 242 条全绿）。
 *
 * `providerStatusSeqRef` 是「最后写者胜」的**唯一**实现：
 * `loadProviderStatuses` 每次进入占一个新序号，只有序号等于**当前**序号的响应
 * 才允许写 state（成功分支与失败分支各一道闸门，过期响应静默丢弃）。
 *
 * ## ⚠️⚠️ 2026-11-09 审计：这道闸门**曾经被整段删掉**（PR #52）
 *
 * 该 PR 删除了 `patchProviderStatus`（第二个更新点，改成整份重取），
 * 于是把本文件的 `describe` **整段**删掉了 —— 理由是「更新点从 2 变 1」。
 * 但那是**把一条有守卫的机制变成零守卫**：机制本身（占号 + 两道比较）一行没少，
 * 只是少了一个占号点。正确做法是**把计数从 2 改成 1**。
 * 域C 变异实测：把 `++` 改成不递增、或删掉 catch 里的比较，**12526 条全绿**。
 *
 * ## ⚠️ 为什么用 AST 而不是源码文本
 *
 * 本仓的已知教训：「源码文本断言的共同弱点是 `if (false)` 短路禁用」——
 * 一行字面量在死分支里照样存在 ⇒ 文本断言恒绿。⇒ 这里走 AST：
 * ① 找**更新点**（`providerStatusSeqRef.current` 作为 `++` / `+=` 的左操作数）；
 * ② 找**比较点**（`providerStatusSeqRef.current` 作为 `!==` 的一侧）。
 *
 * 计数判据（而非「包含」）：
 * - 更新点必须**恰好 1 处**（`loadProviderStatuses` 的 `++`）⇒ 删掉推进就红；
 * - 比较点必须**恰好 2 处**（成功分支 + 失败分支各一个「过期响应丢弃」闸门）
 *   ⇒ 删掉任一闸门就红。
 *
 * ⚠️ 若将来又出现第二个「写 providerStatuses 的入口」，**两个计数都要跟着改**，
 * 而不是把本 `describe` 删掉。
 */
describe('★★ 客户端 provider 状态序号闸门（AST 级）', () => {
  /** 该表达式是否就是 `providerStatusSeqRef.current`。 */
  function isSeqRef(node: ts.Node): boolean {
    return ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'providerStatusSeqRef'
      && node.name.text === 'current'
  }

  /** 找 `providerStatusSeqRef.current` 出现的位置（属性访问的父节点）。 */
  function seqRefUses(): { updates: number, comparisons: number, updateLines: number[] } {
    let updates = 0
    let comparisons = 0
    const updateLines: number[] = []
    const walk = (node: ts.Node): void => {
      // ① 更新点：`x.current++`（PrefixUnary）或 `x.current += 1`（Binary with +=）。
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusPlusToken) {
        if (isSeqRef(node.operand)) {
          updates += 1
          updateLines.push(lineOf(node.getStart(sf)))
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
        if (isSeqRef(node.left)) {
          updates += 1
          updateLines.push(lineOf(node.getStart(sf)))
        }
      }
      // ② 比较点：`x.current !== y`。
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        if (isSeqRef(node.left) || isSeqRef(node.right)) comparisons += 1
      }
      ts.forEachChild(node, walk)
    }
    walk(sf)
    return { updates, comparisons, updateLines }
  }

  it('★★ 更新点必须恰好 1 处（loadProviderStatuses 进入时占新序号）', () => {
    const { updates, updateLines } = seqRefUses()
    expect(updates, `providerStatusSeqRef.current 的更新点应恰好 1 处（实测行 ${updateLines.join(',')}）`)
      .toBe(1)
  })

  it('★★ 比较点必须恰好 2 处（成功分支 + 失败分支各一个「过期响应丢弃」闸门）', () => {
    const { comparisons } = seqRefUses()
    expect(comparisons, 'providerStatusSeqRef.current 的比较点应恰好 2 处').toBe(2)
  })

  it('★★ 失败分支也必须丢弃过期响应（否则旧失败的 catch 会盖掉新成功的 state）', () => {
    /**
     * ⚠️ 用 **AST** 定位 `loadProviderStatuses` 的声明，取其 initializer
     * （`React.useCallback(<fn>, …)`）的**精确**范围 —— 不是文本切片。
     *
     * ⚠️⚠️ 2026-11-09 二审（P2-1）：原实现是
     * `source.slice(at, at + 4000)`，而该函数体只有 900 余字符 ⇒ 窗口会**越界**
     * 到下一个函数（`commitProviderOrder`），于是「函数体内恰好 2 处」这条断言
     * 名不副实：把闸门从 `loadProviderStatuses` 搬到隔壁函数里照样绿。
     *
     * ⚠️ **本条的射程只有「语法计数」**：`if (false && seq !== ref.current)`、
     * 删 `return` 留空 `if` 体、把 `++` 搬到别的函数 —— 这三种「语义已死」
     * 的改法它都看不出来。真正的守卫是行为级
     * `tests/unit/checkin-panel-wiring.spec.ts` 的
     * 「迟到的旧 provider.status 不得覆盖新状态」（实测：删掉序号比较 ⇒ 变红）。
     * 两条判据缺一不可：这条挡「被整段删掉」，那条挡「留着但失效」。
     */
    let decl: ts.Node | undefined
    const findDecl = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === 'loadProviderStatuses'
        && node.initializer !== undefined
      ) {
        decl = node.initializer
      }
      ts.forEachChild(node, findDecl)
    }
    findDecl(sf)
    expect(decl, '找不到 loadProviderStatuses 的声明 ⇒ 本条会静默失明').toBeDefined()
    const body = decl as unknown as ts.Node

    let comparisonsInFn = 0
    const walk = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        if (isSeqRef(node.left) || isSeqRef(node.right)) comparisonsInFn += 1
      }
      ts.forEachChild(node, walk)
    }
    walk(body)
    expect(
      comparisonsInFn,
      'loadProviderStatuses 体内必须有 2 道序号闸门（成功分支 + 失败分支）',
    ).toBe(2)
  })
})
