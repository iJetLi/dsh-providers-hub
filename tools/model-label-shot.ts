// @vitest-environment node
/**
 * 模型选择器那一行的**无头出图与几何审计**（照 dsh-connect-workbuddy 的
 * `tools/section-shot.tsx` 那条路，见其 `pnpm section:shot`）。
 *
 * ## 它解决什么
 *
 * 本组件占的是 `conversation.input.model.label` —— 一个 `single` 槽，赢家替
 * **所有** provider 画行。jsdom 不做布局，所以「chip 会不会把模型名挤成省略号
 * 「pill 是否骑在文本基线上」「窄菜单里两者谁先没」这三件事**只能量**，
 * 只能靠真浏览器排版。参考实现踩过后者：chip 用「裸 span + 一个空格」时按
 * 文本基线对齐，而 chip 自己是 inline-flex、基线来自内部文字 ⇒ 同一份菜单里
 * 我们的行比宿主的行明显偏高（其注释记着这次实测）。
 *
 * ## ⚠️ 为什么不是截图证明悬停
 *
 * 长说明走的是原生 `title` 属性，由操作系统绘制、需要真实鼠标停留 ⇒
 * **headless 的 --screenshot 截不到它**。所以那句文案改由 `--dump-dom` 以
 * 文本形式落进审计（`chips[].title`），比一张截不到东西的图更有用。
 *
 * ## 用法（两条命令）
 *
 *   pnpm shot:label
 *   & 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' \
 *     --headless=new --hide-scrollbars --window-size=1000,760 \
 *     --screenshot=<out>.png file:///<生成的 html>
 *   # 读回测量值（含悬停全文）：
 *   & 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' \
 *     --headless=new --window-size=1000,760 --dump-dom file:///<生成的 html>
 *
 * 住在 `tools/`（**不是** `tests/`）的理由与参考实现逐字相同：它会写文件、
 * 并且需要真浏览器才能产出任何信息，`pnpm test` 永远不该收它 —— 一条
 * 故意 skip 的用例会让每次运行都报「1 skipped」，绿色就不再等于「全跑过」。
 *
 * ## 两份 CSS 的来源（不许手抄）
 *
 * - 本插件那几条规则**从 `plugin-src/client/jet-hub-styles.js` 现取**（正则），
 *   抄一份就会与产物漂移，那正是「测的是测试自己」。
 * - 宿主回落形态的规则**从本机 app.asar 现取**（`_9r0rkG_badgedName` 等）。
 *   取不到时整段降级为「只渲我们自己的形态」并在审计里写明 —— 宁缺毋滥,
 *   绝不写一份近似值冒充宿主实测。
 */
import { describe, it, expect, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

/** 元素树替身：本组件是纯 createElement，不需要真 React 也能拿到完整 DOM 形状。 */
interface Node { type: unknown; props: Record<string, any>; children: unknown[] }
const reactStub = {
  useState: (initial: unknown) => [initial, () => {}],
  useEffect: () => () => {},
  createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]): Node {
    return { type, props: props ?? {}, children }
  },
}
vi.mock('react', () => reactStub)

const esc = (value: string): string => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const styleText = (style: Record<string, string> | undefined): string =>
  style === undefined ? '' : Object.entries(style)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${v}`)
    .join(';')

function html(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(String(node))
  if (Array.isArray(node)) return node.map(html).join('')
  const item = node as Node
  if (typeof item.type !== 'string') return ''
  const attrs: string[] = []
  for (const [key, value] of Object.entries(item.props ?? {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'className') { attrs.push(`class="${esc(String(value))}"`); continue }
    if (key === 'style') { attrs.push(`style="${esc(styleText(value as Record<string, string>))}"`); continue
    }
    if (key.startsWith('data-')) { attrs.push(`${key}="${esc(String(value))}"`); continue }
    attrs.push(`${key}="${esc(String(value))}"`)
  }
  return `<${item.type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${item.children.map(html).join('')}</${item.type}>`
}

/** 本插件的样式：从源文件现取，绝不手抄。 */
async function ownRules(rootDir: string): Promise<string> {
  const source = await readFile(join(rootDir, 'plugin-src/client/jet-hub-styles.js'), 'utf8')
  const wanted = ['.dim-jh-modelLabel', '.dim-jh-modelLabelName', '.dim-jh-modelPromoChip']
  const out: string[] = []
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (wanted.some((w) => trimmed.startsWith(w + ' ') || trimmed.startsWith(w + '['))) out.push(trimmed)
  }
  return out.join('\n')
}

/** 宿主回落形态的样式：从 app.asar 现取；取不到就返回 undefined 并如实登记。 */
async function hostRules(asarPath: string | undefined): Promise<string | undefined> {
  if (asarPath === undefined) return undefined
  let text: string
  try {
    text = (await readFile(asarPath)).toString('latin1')
  } catch {
    return undefined
  }
  // ⚠️ 按**实际哈希前缀**逐条取规则，绝不手抄宿主 CSS，也不要「替成 .host」这种
  // 粗改写：上一版用 /\._[0-9A-Za-z]+_/ 替成 '.host'，把 `_9r0rkG_badge` 变成
  // `.hostbadge`（少一个连字符），而标记写的是 `.host-badge` ⇒ 选择器整段落空,
  // 量到的是**无样式**的行（症状：flex 报 0 1 auto、overflow 报 clip、高度差 1px）,
  // 却被当成宿主实测值读。现在直接按 (前缀, 后缀) 配对重建。
  const re = /\.(?:_[0-9A-Za-z]+_)(badgedName|badgedNameText|badge|modelName)\{([^}]*)\}/g
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    out.push(`.host-${match[1]}{${match[2].trim()}}`)
  }
  // 参照行必须至少拿到 badgedName + badge 两条，否则「宿主形态」是假的。
  if (!out.some((r) => r.startsWith('.host-badgedName{')) || !out.some((r) => r.startsWith('.host-badge{'))) {
    return undefined
  }
  // 宿主给名字的 ellipsis/overflow 依赖它的 .badgedNameText；一并带上 modelName。
  return out.join('\n')
}

describe('无头出图：模型选择器那一行', () => {
  it('生成可被真浏览器排版的 HTML', async () => {
    const rootDir = resolve(import.meta.dirname, '..')
    const mod = await import('../plugin-src/client/model-label.js') as typeof import('../plugin-src/client/model-label.js')

    // 候选表由**真实解析器**产出（不是手编夹具）：同一份判据、同一条路。
    const { parseTencentPromotions } = await import('../src/model-promotions.js')
    const promotions = parseTencentPromotions([{
      id: 'hy4-flash-free-trial-202611',
      kind: 'discount',
      enabled: true,
      priority: 200,
      modelIds: ['hy4flash-free'],
      badge: { label: '限时免费', labelEn: 'Free now', color: '#009273', display: 'activeOnly' },
      hover: { textZh: '11月16日–11月30日，每日赠送免费额度。' },
      schedule: {
        timezone: 'Asia/Shanghai',
        validFrom: '2026-11-16T00:00:00+08:00',
        validUntil: '2026-12-01T00:00:00+08:00',
      },
    }], [], 'Asia/Shanghai')
    const candidates = { buddy: promotions.map((p) => ({ modelId: 'hy4flash-free', promotion: p })) }
    const rpc = async () => ({ providers: candidates })
    mod.resetModelLabelCandidates()
    mod.registerModelLabelSlot({
      slots: { inject: (_n: string, cb: () => unknown) => { cb(); return () => {} }, register: () => () => {} },
      logger: { warn: () => {} },
    } as never, rpc as never)
    await Promise.resolve(); await Promise.resolve()

    const rows: Array<{ label: string; markup: string }> = []
    const render = (props: Record<string, unknown>): string =>
      html(mod.ModelLabel(props as never))

    rows.push({
      label: '本插件：候选成立（chip + 原生 title 悬停）',
      markup: render({
        provider: { id: 'buddy', name: 'CodeBuddy (腾讯)' },
        model: { id: 'hy4flash-free', name: 'Hy4 flash · x0.00→免费 FREE' },
        placement: 'option', rpcCall: rpc,
      }),
    })
    rows.push({
      label: '外来渠道：宿主目录里的 badge 由我们代画',
      markup: render({
        provider: { id: 'other-plugin', name: 'Other' },
        model: { id: 'x', name: 'Some Model · x0.79' },
        badge: undefined, placement: 'option', rpcCall: rpc,
      }),
    })
    rows.push({
      label: '外来渠道带徽标（长名字 ⇒ 看谁先被截断）',
      markup: render({
        provider: { id: 'other-plugin', name: 'Other' },
        // ⚠️ badge 必须挂在 **model** 上：组件读的是 `props.model.badge`（宿主
        // 目录字段），不是 props 顶层。上一版写在顶层 ⇒ 这一行渲染成「无徽标」,
        // 于是「外来行代画徽标」这条腿在出图里**根本没被量到**。
        model: {
          id: 'y',
          name: 'Deepseek-V4.1-Flash-1017 · x0.18→x0.09',
          badge: { text: { en: 'Free now', zh: '限时免费' }, tone: 'success' },
        },
        placement: 'option', rpcCall: rpc,
      }),
    })
    // 宿主自己的回落形态作为**参照行**：两行的基线/间距必须肉眼可比。
    const host = await hostRules(process.env.DSH_HOST_ASAR)
    if (host !== undefined) {
      rows.push({
        label: '宿主回落形态（参照行，CSS 取自 app.asar）',
        markup: '<span class="host-badgedName"><span class="host-badgedNameText">Hy4 flash · x0.00→免费 FREE</span>'
          + '<span class="host-badge">限时免费</span></span>',
      })
    }

    const own = await ownRules(rootDir)
    // ⚠️ 宽度必须**跨过挤压阈值**：上一版只测 260/320/420，而内容实测 161+58≈227,
    // 三档全都装得下 ⇒ 一条都没触发省略号，等于没回答「chip 会不会把模型名
    // 挤成省略号」这一整问（宿主 CSS 里 badge 是 flex:none、名字才带 ellipsis,
    // 判据只有窄到装不下时才可见）。180/220 是刻意选在阈值两侧。
    const widths = [180, 220, 260, 420]
    const body = rows.map((row, i) =>
      `<section class="case"><h2>${esc(row.label)}</h2>`
      + widths.map((w) => `<div class="menu" style="width:${w}px" data-w="${w}">`
        + `<div class="cell" data-case="${i}" data-w="${w}">${row.markup}</div></div>`).join('')
      + '</section>').join('\n')

    const audit = `
    <script>
    addEventListener('load', () => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } }
      const cs = (el, p) => getComputedStyle(el).getPropertyValue(p).trim()
      const out = []
      for (const cell of document.querySelectorAll('.cell')) {
        const chip = cell.querySelector('[class*=modelPromoChip], .host-badge')
        const name = cell.querySelector('[class*=modelLabelName], .host-badgedNameText')
        const rec = {
          case: cell.dataset.case, width: cell.dataset.w,
          cellH: box(cell).h,
          chip: chip ? { ...box(chip), text: chip.textContent, title: chip.getAttribute('title') || null,
            baseline: cs(chip, 'vertical-align'), flex: cs(chip, 'flex') } : null,
          name: name ? { ...box(name), clipped: name.scrollWidth > Math.ceil(name.getBoundingClientRect().width),
            // ⚠️ 两个字段不能混成一个：上一版把 overflow 记成
            // cs(name,'text-overflow') 的值 ⇒ 它永远是 'ellipsis'，于是
            // 「overflow:hidden 改成 visible」这一组变异恒绿（红因被字段名吃掉,
            // 与被测腿无关）。text-overflow 单独记，overflow 记它自己。
            // ⚠️ 本段在一个 JS 模板字符串里 ⇒ 注释里**不能出现反引号**
            //（会提前终止字符串、esbuild 报 Expected ';'；本仓 jet-hub-styles.js
            //  记着同一处事故，我这次又踩了一遍）。
            textOverflow: cs(name, 'text-overflow'),
            overflow: cs(name, 'overflow'),
            // 实际视觉间距 = 胶囊左缘 - 名字右缘。
            // ⚠️ 上一版读的是 cs(cell,'gap') —— 那是**外层菜单单元格**的 6px,
            //   不是本组件 .dim-jh-modelLabel 自己的 4px ⇒ 把我们的 gap 改成
            //   0 时读数不变、判据恒绿（实测）。量两个盒子之间的真空隙才作数。
            gap: chip !== null && name !== null
              ? Math.round(chip.getBoundingClientRect().left - name.getBoundingClientRect().right)
              : null,
            // ★ 重叠判据：名字**不该**画到胶囊的位置上。上一版没有这一条,
            //   于是把 overflow:hidden 改成 visible 时**全绿** —— 名字溢出到胶囊
            //   底下（chip 也没被挤出去、两格都在同一行）,而界面是坏的。
            //   量的方式：名字的右缘 vs 胶囊的左缘（同一个坐标系里比）。
            overlapsChip: chip !== null && name !== null
              ? Math.round(name.getBoundingClientRect().right) > Math.round(chip.getBoundingClientRect().left) + 1
              : false } : null,
        }
        // ⚠️ 判据必须落在**同一个坐标系**：上一版拿 chip 的绝对 left 去比 cell 的
        // 相对宽度（dataset.w），于是 131+58=189 与 180 相比 ⇒ 恒报 vis=false,
        // 而实际 chip 右缘 189 < cell 右缘 196，根本没溢出 —— 把「探针写错」读成
        // 了「chip 会溢出」这条结论。现在两侧都取各自的盒子。
        if (rec.chip && rec.name) {
          const cellBox = box(cell)
          rec.cellRight = cellBox.l + cellBox.w
          rec.chipRight = rec.chip.l + rec.chip.w
          rec.chipFullyVisible = rec.chipRight <= rec.cellRight + 1
          // ★ 挤压时的**取舍方向**：宿主规则是 badge flex:none、名字 ellipsis,
          // 所以名字该先被截、chip 必须完整。反过来（chip 被切 / 名字完整）
          // 说明我们的 CSS 与宿主不同构。
          rec.nameSacrificedFirst = rec.name.clipped && rec.chipFullyVisible
          rec.sameLine = Math.abs(rec.chip.h - rec.name.h) < 12
        }
        out.push(rec)
      }
      const pre = document.createElement('pre')
      pre.id = 'audit'
      pre.textContent = JSON.stringify(out)
      document.body.appendChild(pre)
    })
    </script>`

    const doc = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
    <style>
    :root{--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#4b5058;
      --dsw-alias-status-success:#15803d;--dsw-alias-status-info:#1d4ed8;
      --dsw-alias-status-warning:#b45309;--dsw-alias-bg-layer-1:#fff}
    html,body{margin:0;background:#eceef1;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#0f1115}
    h2{font-size:12px;font-weight:500;color:#4b5058;margin:18px 16px 6px}
    .menu{background:#fff;border:1px solid rgba(15,17,21,.12);border-radius:8px;margin:0 16px 8px;overflow:hidden}
    .cell{box-sizing:border-box;height:34px;padding:0 8px;font-size:13px;line-height:20px;display:flex;align-items:center;gap:6px}
    ${own}
    ${host ?? '/* 宿主参照行缺席：未设 DSH_HOST_ASAR 或该产物里取不到规则 */'}
    </style></head><body>
    ${body}
    ${audit}
    </body></html>`

    const outPath = join(tmpdir(), 'hub-model-label-preview.html')
    writeFileSync(outPath, doc, 'utf8')
    // 断言打在**产出**上：三行里必须有 chip、悬停全文必须含上游那句 + 有效期。
    expect(doc).toContain('每日赠送免费额度')
    expect(doc).toContain('限时免费')
    expect(own).toContain('.dim-jh-modelPromoChip')
    console.log('HTML=' + outPath)
    console.log('hostRules=' + (host === undefined ? 'ABSENT（未设 DSH_HOST_ASAR）' : 'OK'))
    console.log('rows=' + rows.length + ' widths=' + widths.join('/'))
  })
})
