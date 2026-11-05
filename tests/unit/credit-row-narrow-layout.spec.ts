import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 账号卡片「积分行」在**窄容器**（仅设置页）下的布局守卫
 * （用户 2026-10-27：「面板在仅设置页时按钮与信息重叠，其次将积分和详细积分
 * 进行分行处理，避免越界；仅在侧栏显示的话，宽度足够，可以考虑不用处理」）。
 *
 * ## 定稿方案（用户同日第二次确认）
 *
 * 「详细积分也别换行了，就继续在后面，越界部分使用 ... 替代，悬浮可看详情」
 * ⇒ **不换行**、单行省略号、完整内容挂 title。本文件锁的就是这一套。
 *
 * ⚠️ 纯样式缺陷，单测环境没有浏览器 ⇒ 只能做源码级断言。但每一条都对应一个
 * **已确认的真实根因**，不是拿字符串匹配凑数：
 *
 * ① 父规则 `.dim-jh-metaRow dd` 带 `white-space: nowrap`，而积分行原先是
 *    `display: flex` + `overflow: visible` ⇒ 整串分桶文字被当成一个不可断行
 *    的整体、按内容宽撑开、画到右侧按钮列上（**已用截图复现**）。
 * ② `text-overflow: ellipsis` 在 **flex 容器上不生效** —— 光加 ellipsis 而不
 *    改 display，省略号根本不出现（实测：flex 子项各自 nowrap 撑开）。
 * ③ 三列 grid 的按钮列是 `auto`，窄容器下把积分列压到 ~200px，按钮组还会被
 *    挤出卡片右边缘。
 * ④ 容器查询必须挂 `container-type: inline-size`，否则整块静默失效。
 *
 * ⚠️ 反向钉子同样重要：**宽容器（侧栏）不得被牵连**。用户明说那边够宽、
 * 不用处理。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
const hub = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')

/**
 * 剥掉注释后的样式文本 —— **所有**「某条声明在不在」的判据都必须在它上面做。
 *
 * ⚠️⚠️ 2026-10-28 审计实测：把 `container-type: inline-size;` 包进 CSS 注释
 *    （`/* … *\/`）之后，原先直接匹配**源文件字符串**的判据仍然命中 ⇒ 本文件
 *    **12 条全绿**，而浏览器里 `@container` 整块静默失效（浏览器不报错，
 *    只是永不匹配）。同一个坑在本仓库已登记多次（判据必须先剥注释）。
 */
const stylesBare = styles.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取一条 CSS 规则（选择器 + 第一对花括号）。 */
function ruleOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = stylesBare.match(new RegExp(`${escaped} \\{[^}]*\\}`))?.[0]
  expect(found, `找不到规则 ${selector}`).toBeDefined()
  return found!
}

/** 取 `@container (max-width: Npx)` 整块（在剥注释后的文本上取）。 */
function containerBlock(): string {
  const start = stylesBare.indexOf('@container (max-width: 420px)')
  expect(start, '找不到窄容器查询块').toBeGreaterThan(-1)
  const end = stylesBare.indexOf('\n}', start)
  expect(end, '窄容器查询块没有闭合').toBeGreaterThan(start)
  return stylesBare.slice(start, end)
}

describe('★ 积分行：单行 + 省略号（窄容器）', () => {
  it('★★ 根因②：积分值节点必须是块级容器，省略号才会生效', () => {
    const rule = ruleOf('.dim-jh-metaRow dd.dim-jh-creditValue')
    // ⚠️ flex 容器上 text-overflow: ellipsis 不生效（只作用于块级容器的
    //    行内内容）⇒ 保留 display: flex 等于「加了 ellipsis 但看不到省略号」。
    expect(rule, '必须是 display: block —— flex 上 ellipsis 不生效')
      .toMatch(/display:\s*block/)
    expect(rule, 'display: flex 会让省略号失效').not.toMatch(/display:\s*flex/)
  })

  it('★★ 不换行 + 省略号三件套齐全（用户定稿：不换行，越界用 ...）', () => {
    const rule = ruleOf('.dim-jh-metaRow dd.dim-jh-creditValue')
    expect(rule, '必须禁止折行（用户明确要求「别换行了」）').toMatch(/white-space:\s*nowrap/)
    expect(rule, '必须裁掉溢出，否则文字仍压到按钮上').toMatch(/overflow:\s*hidden/)
    expect(rule, '必须有省略号').toMatch(/text-overflow:\s*ellipsis/)
    // 反向钉子：overflow: visible 是报障形态（内容画到按钮列上）。
    expect(rule, 'overflow 不许回到 visible（那正是越界盖住按钮的形态）')
      .not.toMatch(/overflow:\s*visible/)
  })

  it('★★ 子元素 inline 化，且段间距由相邻兄弟选择器提供', () => {
    // 改成 block 后子元素必须回到 inline 流，省略号才有「整体被截断」的语义。
    expect(stylesBare, '缺少子元素 inline 化规则')
      .toMatch(/\.dim-jh-metaRow dd\.dim-jh-creditValue > \* \{[^}]*display:\s*inline/)
    // 原 flex gap 已不存在，间距必须另有来源，否则各段黏成一团。
    expect(stylesBare, '缺少段间距规则（原 flex gap 已移除）')
      .toMatch(/\.dim-jh-metaRow dd\.dim-jh-creditValue > \* \+ \* \{[^}]*margin-left:\s*6px/)
  })

  it('★★ 悬浮可看详情：title 必须包含行内全文（不只是资源包明细）', () => {
    // ⚠️ 原先 title 只挂资源包明细，不含行内分桶文字 ⇒ 行内被截断后，
    //    hover 反而看不到被截掉的那几个数字。必须拼上 lineText。
    expect(hub, '缺少行内全文变量').toContain('const lineText = [')
    expect(hub, '缺少 hover 全文变量').toContain('const hoverTitle = ')
    // 判据：dd 的 title 用的是 hoverTitle，不是旧的 quotaDetail/detail。
    const at = hub.indexOf("className: 'dim-jh-creditValue',")
    expect(at, '找不到积分值节点').toBeGreaterThan(-1)
    const ddProps = hub.slice(at, at + 260)
    expect(ddProps, 'title 必须挂 hoverTitle（行内全文 + 明细）').toContain('title: hoverTitle')
    // 反向钉子：旧的「只有明细」写法必须已删除。
    expect(ddProps, 'title 仍是旧的明细写法 ⇒ 被截断的数字看不到')
      .not.toContain('quotaDetail ?? (detail || undefined)')
  })

  it('★★ hoverTitle 的各段必须与行内同源（不许重算主数值）', () => {
    const start = hub.indexOf('const lineText = [')
    expect(start).toBeGreaterThan(-1)
    const body = hub.slice(start, hub.indexOf('const hoverTitle = ', start))
    // 行内那几段全部要在场：主数值、池分桶、三档分桶、独立池、资源包计数。
    for (const token of ['mainText', 'poolSplitText', 'expiryParts', 'exclusiveRemaining', 'activeCount']) {
      expect(body, `hoverTitle 少了行内那一段：${token}`).toContain(token)
    }
    // ⚠️ 判据收窄到**主数值**：`formatUnits(exclusiveRemaining, ...)` 与
    //    `formatUnits(balance.expiredTotal, ...)` 是行内那两段本身的格式化
    //    （逐字照搬，不是第二套算法）。真正要防的是**重新算主数值** ——
    //    那会与 `quotaText ?? total` 分叉，hover 与行内显示两个数。
    expect(body, 'hoverTitle 不得重算主数值（应与行内的 quotaText ?? total 同源）')
      .not.toMatch(/formatUnits\(\s*(?:balance\.)?total\b/)
    expect(body, 'hoverTitle 不得自行拼主数值的百分比')
      .not.toMatch(/formatQuota\(/)
  })
})

describe('★ 窄容器：按钮组下移，不与积分文字同行', () => {
  it('★★ 根因③：窄容器下按钮组下移一行、独占整宽', () => {
    const block = containerBlock()
    const rule = block.match(/\.dim-jh-metaRow--actions \{[^}]*\}/)?.[0]
    expect(rule, '窄容器下缺少积分行重排规则').toBeDefined()
    expect(rule, '必须是两列两行（标签 + 积分 / 按钮整行）')
      .toMatch(/grid-template-areas:\s*\n?\s*"label value"\s*\n?\s*"actions actions"/)
    const actions = block.match(/\.dim-jh-metaRow--actions > \.dim-jh-accountActions \{[^}]*\}/)?.[0]
    expect(actions, '找不到窄容器下的按钮组规则').toBeDefined()
    expect(actions, '按钮组必须跨满整行').toMatch(/grid-column:\s*1 \/ -1/)
    expect(actions, '按钮组必须贴右（与宽容器视觉一致）').toMatch(/justify-content:\s*flex-end/)
  })

  it('★★ 窄容器下按钮组允许换行（5～6 个按钮在 300px 级容器里放不下）', () => {
    const block = containerBlock()
    const actions = block.match(/\.dim-jh-metaRow--actions > \.dim-jh-accountActions \{[^}]*\}/)?.[0]
    expect(actions, '窄容器下按钮组必须 wrap，否则最后一个按钮被推出卡片外')
      .toMatch(/flex-wrap:\s*wrap/)
  })

  it('★★ 用户定稿：主数值**不再**独占一行（与「别换行」一致）', () => {
    const block = containerBlock()
    // 反向钉子：曾经实现过「积分与详细积分分行」，用户随后明确否决。
    expect(block, '主数值独占一行的规则必须已移除（用户要求不换行）')
      .not.toMatch(/creditTotal \{[^}]*flex:\s*0 0 100%/)
  })

  it('★★ 根因④：容器查询必须有锚点，否则整块静默失效', () => {
    const meta = ruleOf('.dim-jh-accountMeta')
    expect(meta, '缺 container-type ⇒ @container 块永远不匹配（浏览器不报错）')
      .toMatch(/container-type:\s*inline-size/)
  })

  it('⚠️ 阈值必须落在设置页与侧栏两档宽度之间', () => {
    const at = stylesBare.indexOf('@container (max-width:')
    expect(at, '找不到 @container 阈值').toBeGreaterThan(-1)
    const px = Number(/max-width:\s*(\d+)px/.exec(stylesBare.slice(at, at + 60))?.[1])
    expect(Number.isFinite(px), '@container 阈值不是像素值').toBe(true)
    // 设置页卡片内容宽约 300–380px、侧栏约 520–700px（实测区间）。
    expect(px, `阈值 ${px}px 太低，设置页会漏`).toBeGreaterThan(380)
    expect(px, `阈值 ${px}px 太高，侧栏也被拖进两行布局`).toBeLessThan(520)
  })
})

describe('⚠️ 反向钉子：宽容器（侧栏）不得被牵连', () => {
  it('★★ 基础 .dim-jh-accountActions 仍是 nowrap（侧栏观感逐字不变）', () => {
    const rule = ruleOf('.dim-jh-accountActions')
    expect(rule, '基础规则被改成 wrap 会波及侧栏（用户明说那边不用处理）')
      .toMatch(/flex-wrap:\s*nowrap/)
  })

  it('★★ 基础积分行仍是三列（按钮贴最右），重排只在 @container 里', () => {
    const rule = ruleOf('.dim-jh-metaRow--actions')
    expect(rule, '基础规则必须保持三列').toMatch(/grid-template-columns:\s*52px minmax\(0, 1fr\) auto/)
    expect(rule, '两行布局不许写在基础规则里').not.toContain('grid-template-areas')
  })
})
