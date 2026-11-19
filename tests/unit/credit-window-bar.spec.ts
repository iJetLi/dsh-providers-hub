/**
 * 进度条算法与保存行为的守卫（2026-11-20 用户报障）。
 *
 * 三个报障：
 * 1. 红色框位置应该有进度条实时显示积分 —— **代码里压根没渲染条**（已补）
 * 2. 保存成功应自动关闭；失败应 alert
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MIN_VISIBLE_PERCENT,
  barPercent,
  coverageTotal,
} from '../../plugin-src/client/credit-window-ui.js'

const JET_HUB = join(process.cwd(), 'plugin-src', 'client', 'jet-hub.js')

describe('coverageTotal：进度条分母', () => {
  it('★ 三档求和', () => {
    expect(coverageTotal({ imminentAmount: 393.37, shortTermAmount: 607.10, permanentAmount: 27263 }))
      .toBeCloseTo(28263.47, 2)
  })

  it('⚠️ 脏数据 / 空对象 ⇒ 0（不抛）', () => {
    expect(coverageTotal(null)).toBe(0)
    expect(coverageTotal(undefined)).toBe(0)
    expect(coverageTotal({})).toBe(0)
    expect(coverageTotal({ imminentAmount: NaN })).toBe(0)
  })
})

describe('barPercent：进度条宽度', () => {
  it('★★★ 真实数据：小档位必须可见（这是报障的核心）', () => {
    // 用户截图：临期 393.37 / 短期 607.10 / 永久 27263
    const total = coverageTotal({ imminentAmount: 393.37, shortTermAmount: 607.10, permanentAmount: 27263 })
    // 裸比例只有 1.39%，228px 上约 3.2px —— 肉眼看不见
    expect((393.37 / total) * 100).toBeLessThan(MIN_VISIBLE_PERCENT)
    // ⇒ 必须被抬到最小可见宽度
    expect(barPercent(393.37, total)).toBe(MIN_VISIBLE_PERCENT)
    expect(barPercent(607.10, total)).toBe(MIN_VISIBLE_PERCENT)
    // 大档位保持真实比例
    expect(barPercent(27263, total)).toBeCloseTo(96.46, 1)
  })

  it('★★ 全部相同 ⇒ 各 1/3', () => {
    expect(barPercent(100, 300)).toBeCloseTo(33.33, 2)
  })

  it('★★★ 金额为 0 ⇒ 0（空档不能画假条）', () => {
    expect(barPercent(0, 1000)).toBe(0)
  })

  it('★★★ 总额为 0 ⇒ 0（不除零，避免 NaN 让整条不渲染）', () => {
    expect(barPercent(100, 0)).toBe(0)
    expect(barPercent(0, 0)).toBe(0)
    // ⚠️ 变异 M3 实测无牙后补：`100/0 = Infinity`，若只有 `!(a>0)` 这一道闸，
    //    `Number.isFinite(Infinity)` 是 false ⇒ 也返回 0，**两条路殊途同归**。
    //    ⇒ 必须钉住「负数总额」这一格：`100 / -100 = -1` 是**有限数**，
    //      没有 `!(t > 0)` 闸门时会被 `Math.max(3, -1)` 抬成 3 ⇒ 给空数据画假条。
    expect(barPercent(100, -100), '负数总额必须返回 0（否则会画假条）').toBe(0)
    expect(barPercent(-100, 100)).toBe(0)
  })

  it('⚠️ 脏数据 ⇒ 0', () => {
    expect(barPercent(NaN, 100)).toBe(0)
    expect(barPercent(100, NaN)).toBe(0)
    expect(barPercent(undefined, 100)).toBe(0)
    expect(barPercent(100, undefined)).toBe(0)
    expect(barPercent(Infinity, 100)).toBe(0)
  })

  it('⚠️ 异常占比 > 100% ⇒ 夹到 100（不溢出容器）', () => {
    expect(barPercent(200, 100)).toBe(100)
  })

  it('★ 最小可见宽度常量本身', () => {
    expect(MIN_VISIBLE_PERCENT).toBe(3)
  })
})

describe('★★★ 保存行为：成功自动关闭 / 失败 alert', () => {
  /** 取弹窗组件的源码（含 onSave）。 */
  function modalSource() {
    const source = readFileSync(JET_HUB, 'utf8')
    const start = source.indexOf('function CreditWindowModal')
    expect(start, '应能找到 CreditWindowModal').toBeGreaterThan(-1)
    const end = source.indexOf('function formatAmount', start)
    return source.slice(start, end > start ? end : start + 9000)
  }

  it('★★★ 保存成功 ⇒ 调用 onClose()（自动关闭弹窗）', () => {
    const src = modalSource()
    /**
     * ⚠️ 变异 M4 首轮**无牙**后改进：原来的正则允许 `[\s\S]{0,400}` 跨过
     * `} catch {`，于是把成功分支的 `onClose()` 注释掉、只要 400 字符内
     * 还有别处的 `onClose()`（取消按钮/遮罩）就仍然通过。
     * ⇒ 现在**只在 onSave 的 try 块内**找，且必须在 `setDraftImminent` 之后、
     *   `catch` 之前。
     */
    const onSaveStart = src.indexOf('const onSave = async')
    expect(onSaveStart).toBeGreaterThan(-1)
    const onSaveEnd = src.indexOf('const onReset = async', onSaveStart)
    const onSaveBody = src.slice(onSaveStart, onSaveEnd)
    // 取 try 块：从 `try {` 到 `} catch`
    const tryStart = onSaveBody.indexOf('try {')
    const catchIdx = onSaveBody.indexOf('} catch', tryStart)
    expect(tryStart).toBeGreaterThan(-1)
    expect(catchIdx).toBeGreaterThan(tryStart)
    const tryBlock = onSaveBody.slice(tryStart, catchIdx)
    /**
     * ⚠️⚠️ 必须**剥掉注释行**再判：变异 M4 把调用改成 `// onClose() removed`
     * 时，`toContain('onClose()')` 仍然命中注释里的字面量 ⇒ 假绿。
     * 这是本仓反复记录的「字面量在死分支/注释里照样存在」形态。
     */
    const codeOnly = tryBlock
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
      })
      .join('\n')
    expect(codeOnly, '保存成功分支（try 块内的**代码**）必须调用 onClose()').toMatch(/^\s*onClose\(\)\s*$/m)
  })

  it('★★★ 保存失败 ⇒ 调用 window.alert', () => {
    const src = modalSource()
    expect(src, '保存失败必须 alert 警告').toContain('window.alert(')
    // 且 alert 文案要点明是保存失败
    expect(src).toMatch(/window\.alert\([^)]*保存分档窗口失败/)
  })

  it('⚠️ alert 必须包在 try 里（宿主可能禁用 alert）', () => {
    const src = modalSource()
    const idx = src.indexOf('window.alert(')
    expect(idx).toBeGreaterThan(-1)
    // alert 前 200 字符内应有 try {
    const before = src.slice(Math.max(0, idx - 200), idx)
    expect(before, 'alert 必须被 try 保护（宿主/无头环境可能没有 alert）').toContain('try {')
  })

  it('★★ 失败时仍保留界面上的红字（alert 点掉就没了）', () => {
    const src = modalSource()
    // catch 块里应先 setSaveError 再 alert
    expect(src).toMatch(/setSaveError\(message\)[\s\S]{0,300}window\.alert/)
  })

  it('★★ 返回结构异常也要走失败路径（不能静默 return）', () => {
    const src = modalSource()
    // 原来是 setSaveError + return（不 alert、不关闭）；应改成 throw
    expect(src).toMatch(/throw new Error\('保存返回结构异常/)
  })
})

describe('★★★ 进度条必须真的被渲染（报障「怎么没有」）', () => {
  it('预览行必须含 dim-jh-windowPreviewBar 元素', () => {
    const source = readFileSync(JET_HUB, 'utf8')
    expect(source, '必须渲染进度条容器').toContain('dim-jh-windowPreviewBar')
    expect(source, '必须渲染进度条填充').toContain('dim-jh-windowPreviewFill')
  })

  /**
   * ⚠️ 变异 M6 首轮**无牙**后补：上面那条只看「字符串在不在」，
   * 把条改成 `null && React.createElement('span', { className: 'dim-jh-windowPreviewBar' },` 
   * 仍然全绿（字面量还在，只是死分支）。
   *
   * ⇒ 必须断言**条的创建语句没有被短路**：取其所在行，前面不得有
   *   `null &&` / `false &&` / `0 &&` 这类常量假条件。
   */
  it('★★★ 进度条的创建不得被常量假条件短路（变异 M6）', () => {
    const source = readFileSync(JET_HUB, 'utf8')
    const marker = "React.createElement('span', { className: 'dim-jh-windowPreviewBar' }"
    let idx = source.indexOf(marker)
    expect(idx, '应能找到进度条创建语句').toBeGreaterThan(-1)
    // 该语句所在行的前 60 字符
    const lineStart = source.lastIndexOf('\n', idx)
    const prefix = source.slice(Math.max(0, lineStart), idx)
    expect(prefix, `进度条创建前不得有常量短路：${prefix.trim()}`)
      .not.toMatch(/(null|false|0|undefined)\s*&&\s*$/)
  })

  it('条宽必须绑定 barPercent（实时随金额变化）', () => {
    const source = readFileSync(JET_HUB, 'utf8')
    expect(source, '宽度必须来自 barPercent').toMatch(/width:\s*`\$\{barPercent\(/)
  })

  it('CSS 必须有条的底色与填充色（否则看不见）', () => {
    const css = readFileSync(join(process.cwd(), 'plugin-src', 'client', 'jet-hub-styles.js'), 'utf8')
    expect(css).toMatch(/\.dim-jh-windowPreviewBar \{[\s\S]*?background:/)
    expect(css).toMatch(/\.dim-jh-windowPreviewFill\[data-tone="imminent"\] \{ background:/)
    expect(css).toMatch(/\.dim-jh-windowPreviewFill\[data-tone="short"\] \{ background:/)
    expect(css).toMatch(/\.dim-jh-windowPreviewFill\[data-tone="permanent"\] \{ background:/)
  })
})
