/**
 * 无头测量与回归闸门：把 `tools/model-label-shot.ts` 生成的 HTML 交给真浏览器
 * 排版，读回页面内量出的几何值并**断言**。
 *
 * ## 为什么必须有这一步
 *
 * 生成 HTML 的那一半只会「产出看起来对的东西」，几何判据全在浏览器里跑。
 * 没有这个闸门，整套工具就是个**永远绿**的截图器 —— 正是本仓反复登记的
 * 装饰性产物形态（守卫有牙 ≠ 取值正确）。布局回归（chip 被挤掉、两行变三行、
 * 名字没截而胶囊先没）只有在这里才会变红。
 *
 * ## 为什么需要真浏览器
 *
 * jsdom 不做布局：`getBoundingClientRect` 恒 0、`text-overflow` 不生效。
 * 参考实现（dsh-connect-workbuddy 的 `tools/section-shot.tsx`）与本仓
 * `docs/agent-notes/client-ui.md` 里那次开关被挤出可视区的实测，走的都是
 * 「从真实源码提取样式 → 无头 Edge 截图 + 页面内测量」这条路，理由相同。
 *
 * ## ⚠️ 它证明不了什么（如实登记，别当成视觉验收）
 *
 * 1. **悬停那句话截不到**：`title` 由操作系统绘制、需要真实鼠标停留,
 *    headless 的 `--screenshot` 拿不到它。所以那句改由 `--dump-dom` 以**文本**
 *    形式落进审计（`chip.title`）并在这里断言 —— 比一张截不到东西的图有用。
 * 2. **配色不可比**：参照行只拿到宿主 CSS module 的 4 条规则（badgedName /
 *    badgedNameText / badge / modelName），宿主那枚胶囊的填充色来自**它的 Tag
 *    组件**自己的样式表，不在其中 ⇒ 图里参照行是灰字、我们的是绿底描边。
 *    这张图证明的是**几何同构**，不是配色一致。
 * 3. 渲染方是**我们的替身 React**，不是宿主 ModelSelect ⇒ 菜单容器几何
 *    （.cell 那条）按宿主实测值手写，宿主改了这里不会跟着红。
 *
 * ## 用法
 *
 *   pnpm shot:label            # 生成 HTML
 *   pnpm shot:label:measure    # 出图 + 测量 + 断言
 *
 * 环境变量：
 *   DSH_HOST_ASAR   宿主 app.asar 路径（不设则跳过参照行，断言照常）
 *   DSH_BROWSER     浏览器可执行文件（缺省自动找 Edge / Chrome / Chromium）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HTML = join(tmpdir(), 'hub-model-label-preview.html')

/*
 * ⚠️ 闸门必须**自己生成** HTML，不能只读现成的那一份。
 * 实测踩到：变异验证里改完源码直接跑 measure，它量到的是**上一轮**留下的 HTML
 * （html mtime 19:54:28 < 源码 19:54:36）—— 于是「外来徽标被删」这组变异报出的
 * 红因是上一组「title 换成短标签」的判据，红因与被测腿完全无关。
 * 一个会看错产物的闸门比没有闸门更糟：它给出一条**错误的确凿证据**。
 */
const { spawnSync } = await import('node:child_process')
const generated = spawnSync('pnpm', ['vitest', 'run', '--config', 'vitest.shot.config.ts'], {
  cwd: process.cwd(), encoding: 'utf8', shell: process.platform === 'win32',
})
if (generated.status !== 0) {
  console.error('生成 HTML 失败：\n' + (generated.stdout ?? '') + (generated.stderr ?? ''))
  process.exit(1)
}
if (!existsSync(HTML)) {
  console.error('生成器没有写出 ' + HTML)
  process.exit(1)
}

/** 自动找浏览器：与参考实现同一取向（本机没有 Chrome，只有 Edge）。 */
function findBrowser() {
  if (process.env.DSH_BROWSER) {
    if (!existsSync(process.env.DSH_BROWSER)) {
      throw new Error('DSH_BROWSER 指向不存在的文件: ' + process.env.DSH_BROWSER)
    }
    return process.env.DSH_BROWSER
  }
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  const found = candidates.find((p) => existsSync(p))
  if (found === undefined) {
    throw new Error('没找到 Edge / Chrome；设 DSH_BROWSER=<可执行文件路径> 再跑')
  }
  return found
}

const browser = findBrowser()
const url = 'file:///' + HTML.replaceAll('\\', '/')
const work = mkdtempSync(join(tmpdir(), 'hub-label-shot-'))
const png = join(work, 'shot.png')
const dom = join(work, 'dom.html')

const FLAGS = ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1000,900']
execFileSync(browser, [...FLAGS, '--hide-scrollbars', `--screenshot=${png}`, url], { stdio: 'ignore' })
const html = execFileSync(browser, [...FLAGS, '--dump-dom', url], {
  maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
})
import { writeFileSync } from 'node:fs'
writeFileSync(dom, html)

const audit = /<pre id="audit">([\s\S]*?)<\/pre>/.exec(html)?.[1]
if (audit === undefined) {
  console.error('页面里没有 <pre id="audit"> —— 浏览器没跑起来或脚本被拦')
  process.exit(1)
}
const rows = JSON.parse(audit.trim())

/*
 * 断言。每格都必须**独立可失败**，否则整组是恒绿：
 *  - 判据打在「这一档宽度下发生了什么」，不是「有没有输出」。
 *  - 窄档与宽档成对出现（只有窄档会截、只有宽档不该截）——
 *    单向断言会被「永远截」或「永远不截」两种坏实现同时放过。
 */
const failures = []
const byCase = new Map()
for (const row of rows) {
  const key = String(row.case) + '@' + row.width
  if (!byCase.has(key)) byCase.set(key, row)
}

const chipCases = rows.filter((r) => r.chip !== null)
if (chipCases.length === 0) failures.push('一行 chip 都没量到（CSS 或渲染方出了问题）')

for (const row of chipCases) {
  const tag = `case${row.case}@${row.width}w`
  // ① chip 永远不许被挤出可视区（宿主规则是 badge flex:none）。
  if (row.chipFullyVisible !== true) {
    failures.push(tag + ': chip 溢出（chipRight=' + row.chipRight + ' cellRight=' + row.cellRight + '）')
  }
  // ①″ 名字那格必须**声明式地截断**：宿主规则是 text-overflow:ellipsis +
  // overflow:hidden。⚠️ 只量盒子几何抓不到它 —— 实测把 overflow:hidden 改成
  // visible 时名字的 getBoundingClientRect().right **完全不变**（文字只是画到框
  // 外面，压在胶囊底下）,于是 overlapsChip 与 clipped 两条都照旧通过。
  // ⇒ 这一格必须打在计算样式上，不能只打在盒子上。
  if (row.name.overflow !== 'hidden' && row.name.overflow !== 'clip') {
    failures.push(tag + ': 名字那格没有截断声明（overflow=' + (row.name.overflow || '空') + '）—— 文字会画到胶囊底下')
  }
  if (row.name.textOverflow !== 'ellipsis') {
    failures.push(tag + ': 名字没有 ellipsis（实测 ' + row.name.textOverflow + '）')
  }
  // ①″ 胶囊与名字之间必须有**实际间隙**。gap:0 不会让 chip 溢出、也不会让
  //    盒子重叠，只有直接量两者间的空隙才抓得到（实测把 .dim-jh-modelLabel 的
  //    gap 从 4px 改成 0 时，其余判据全绿）。宿主参照值是 4px，我们刻意同值,
  //    下限取 2px 以容忍整数舍入。
  if (!(typeof row.name.gap === 'number' && row.name.gap >= 2)) {
    failures.push(tag + ': 胶囊紧贴文字（实测间隙 ' + row.name.gap + 'px，应 ≥2）')
  }
  // ①′ 名字不许溢出到胶囊底下（盒子层面的重叠）。
  if (row.name.overlapsChip === true) {
    failures.push(tag + ': 名字画到了胶囊底下（nameRight > chipLeft，overflow=' + row.name.overflow + '）')
  }
  // ② 名字被截时必须是**名字**先让位，而不是胶囊。
  if (row.nameSacrificedFirst === false && row.name.clipped === false) {
    // 宽档：两者都完整，合法。
  } else if (row.nameSacrificedFirst !== true) {
    failures.push(tag + ': 挤压方向错（nameClipped=' + row.name.clipped
      + ' chipVisible=' + row.chipFullyVisible + '）')
  }
  // ③ 胶囊与名字必须同一行高（±12px）：不同行 = pill 骑在文本基线上,
  //    正是参考实现踩过的那格（裸 span + 空格 ⇒ inline-flex 的基线来自内部文字）。
  if (row.sameLine !== true) {
    failures.push(tag + ': 胶囊与名字不同行（chipH=' + row.chip.h + ' nameH=' + row.name.h + '）')
  }
  // ④ 胶囊必须真的是 flex:none —— 参与收缩就会自己变窄、文字被截。
  if (row.chip.flex !== '0 0 auto') {
    failures.push(tag + ': chip flex 不是 0 0 auto（实测 ' + row.chip.flex + '）')
  }
}

/*
 * ⑤ 成对判据：必须**同时**存在「名字被截的窄档」和「名字不被截的宽档」。
 * 只有前者 ⇒ 「永远截」也能过关；只有后者 ⇒ 挤压方向这条腿零覆盖。
 * 这一格是初版最容易被跳过的：三档宽度全没触发省略号时，上面所有
 * nameSacrificedFirst 断言都落在「宽档合法」分支里，全绿而什么都没测。
 */
const clipped = chipCases.filter((r) => r.name.clipped)
const unclipped = chipCases.filter((r) => !r.name.clipped)
if (clipped.length === 0) failures.push('没有任何一档把名字挤断 —— 宽度档位选得没跨过阈值，挤压方向那条腿零覆盖')
if (unclipped.length === 0) failures.push('没有任何一档完整显示名字 —— 无法证明「不是永远截」')

/*
 * ⑥ 悬停全文：截不到图，就以文本断言它**在 DOM 里**，且长过胶囊本身。
 * 「长过」这条不是凑数：若哪天只把短标签塞进 title，功能表面仍在、
 * 而用户真正要的那句（哪天过期）又消失了 —— 本次的起因正是这个。
 */
const own = rows.filter((r) => Number(r.case) === 0 && r.chip !== null)
if (own.length === 0) failures.push('case0（本插件候选行）缺席')
for (const row of own) {
  const title = row.chip.title ?? ''
  if (title === '') { failures.push(`case0@${row.width}w: 胶囊没有 title`); continue }
  if (!title.includes('每日赠送免费额度')) failures.push(`case0@${row.width}w: title 缺上游原话`)
  if (!/\d{4}年\d{1,2}月\d{1,2}日/.test(title)) failures.push(`case0@${row.width}w: title 缺有效期`)
  if (title.length <= row.chip.text.length) {
    failures.push(`case0@${row.width}w: title 不比胶囊长（${title.length} <= ${row.chip.text.length}）—— 长说明又没了`)
  }
}

/*
 * ⑦ 外来渠道的徽标必须仍被代画（single 槽的代价那条腿）。
 * 判据：case2 每一档都要有 chip，且 title 恰为短标签（我们没有它的长句,
 * 替上游编一句是本仓红线）。
 */
const foreign = rows.filter((r) => Number(r.case) === 2 && r.chip !== null)
if (foreign.length === 0) failures.push('case2（外来渠道代画宿主徽标）一行都没量到 —— 兄弟插件的徽标会整片消失')
for (const row of foreign) {
  if (row.chip.title !== row.chip.text) {
    failures.push(`case2@${row.width}w: 外来徽标的 title 不等于短标签（${JSON.stringify(row.chip.title)}）`)
  }
}

/*
 * ⑧ 宿主参照行（若存在）：我们的几何必须与它同构 —— 同一档宽度下,
 * 名字截断状态一致、胶囊都不溢出。这是「两套渲染方在一份菜单里并存」时
 * 唯一能锁住「看起来像同一个规则」的判据。
 */
const host = rows.filter((r) => Number(r.case) === 3 && r.chip !== null)
if (host.length === 0) {
  console.log('（参照行缺席：未设 DSH_HOST_ASAR 或该产物里取不到规则 —— 第⑧条判据本轮未执行）')
} else {
  for (const hRow of host) {
    const mine = byCase.get('0@' + hRow.width)
    if (mine === undefined || mine.chip === null) continue
    if (mine.name.clipped !== hRow.name.clipped) {
      failures.push(`w=${hRow.width}: 我们与宿主的名字截断状态不一致（我们=${mine.name.clipped} 宿主=${hRow.name.clipped}）`)
    }
    if (Math.abs(mine.chip.w - hRow.chip.w) > 8) {
      failures.push(`w=${hRow.width}: 胶囊宽度与宿主差 ${Math.abs(mine.chip.w - hRow.chip.w)}px（我们=${mine.chip.w} 宿主=${hRow.chip.w}）`)
    }
  }
}

// ⚠️ 外来渠道的**无徽标**行（case1）必须是裸名字：它证明我们没有把
// 「没有 badge」渲染成一枚空胶囊。这一组没有 chip ⇒ 上面所有断言都跳过了它,
// 所以单独数一次。
const bareRows = rows.filter((r) => Number(r.case) === 1)
if (bareRows.length === 0) failures.push('case1（外来无徽标行）缺席')
for (const row of bareRows) {
  if (row.chip !== null) failures.push(`case1@${row.width}w: 无 badge 的行却画出了胶囊`)
}

console.log('browser=' + browser)
console.log('png=' + png + ' (' + (existsSync(png) ? readFileSync(png).byteLength : 0) + ' B)')
console.log('rows=' + rows.length + ' chipRows=' + chipCases.length + ' clipped=' + clipped.length)
for (const row of rows) {
  if (row.chip === null) { console.log(`  case${row.case}@${row.width}w  裸名字`); continue }
  console.log(`  case${row.case}@${row.width}w  chip w=${row.chip.w} vis=${row.chipFullyVisible}`
    + ` nameClip=${row.name.clipped} ovf=${row.name.overflow}/${row.name.textOverflow} gap=${row.name.gap} overlap=${row.name.overlapsChip}`
    + (row.chip.title ? ' title=' + row.chip.title : ''))
}

if (failures.length > 0) {
  console.error('\n布局回归 ' + failures.length + ' 处：')
  for (const f of failures) console.error('  ✗ ' + f)
  console.error('  图: ' + png)
  process.exit(1)
}
console.log('\n✓ 几何与悬停文案全部通过')
