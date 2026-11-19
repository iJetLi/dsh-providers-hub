import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

function stylesText(): string {
  const open = source.indexOf('`')
  const close = source.indexOf('`', open + 1)
  expect(open).toBeGreaterThan(-1)
  expect(close).toBeGreaterThan(open)
  return source.slice(open + 1, close)
}

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function withoutVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+,\s*#[0-9a-fA-F]{3,8}\)/g, 'VAR')
}

// ⚠️ `#15803d` / `#b45309` 刻意**不在**表里（PR #54 正向审计 P1）：
// 它们是「深绿 / 深琥珀**文字**」的原色（白底对比度 5.60 / 5.02，11px 达标），
// 而 DSH 主题的 `--dsw-alias-state-success-primary` / `-warn-primary` 是**填充亮色**
// （实测 #2e8e52 / #c08a33，当 11px 文字只有 4.11 / 3.03，不达标）。
// 所以这两处**文字色保留裸字面量**，只让背景/边框走变量；把它们放回表里会把
// 「文字看不清」这个缺陷重新钉死（见 pr54-pos-audit.md P1）。
const SEMANTIC: Record<string, string> = {
  '#1677ff': '--dsw-alias-brand-primary',
  '#d93025': '--dsw-alias-state-error-primary',
  '#b3261e': '--dsw-alias-label-danger',
  '#22c55e': '--dsw-alias-state-success-primary',
  '#e37400': '--dsw-alias-state-warn-primary',
  '#6b7280': '--dsw-alias-label-tertiary',
}

describe('★ Jet Hub 语义色走主题变量', () => {
  const css = withoutComments(stylesText())

  it('样式表里不再有裸写的语义色', () => {
    const bare = withoutVarFallbacks(css)
    const offenders: string[] = []
    for (const hex of Object.keys(SEMANTIC)) {
      const re = new RegExp(hex + '\\b', 'gi')
      const hits = bare.match(re)?.length ?? 0
      if (hits > 0) offenders.push(`${hex} × ${hits}`)
    }
    expect(offenders).toEqual([])
  })

  it('每个语义色的回退位都挂在正确的变量上（不许张冠李戴）', () => {
    const wrong: string[] = []
    for (const m of css.matchAll(/var\((--[\w-]+),\s*(#[0-9a-fA-F]{6})\)/g)) {
      const [, token, hex] = m
      const expected = SEMANTIC[hex.toLowerCase()]
      if (expected !== undefined && token !== expected && !(hex.toLowerCase() === '#1677ff' && token === '--dsw-alias-link')) {
        wrong.push(`${token} ← ${hex}`)
      }
    }
    expect(wrong).toEqual([])
  })

  // ⚠️ 上一格只覆盖「回退值在 SEMANTIC 里」的组合：把 `var(--dsw-alias-brand-primary, #1677ff)`
  // 的**回退值改成别的色**（例如 `#0000ff`）时，`SEMANTIC['#0000ff']` 是 `undefined`
  // ⇒ 上一格直接 `continue`，而第 1 格的「无裸写」也查不到它（它在 var 回退位里、
  // 且不在 SEMANTIC 白名单里）⇒ **两条都绿**（实测：改一处回退值后 5 条用例全绿）。
  // 而回退值正是「宿主不定义该变量时用户看到的颜色」，写错等于悄悄换掉主题色。
  //
  // 所以这里补一张**快照白名单**：`--token|回退值` 必须是 PR #54 之前那些裸色的
  // **原值**（逐字拷贝自 baseline 的 `jet-hub-styles.js`）。新增样式规则若引入新组合，
  // 必须先在 baseline 上确认那个字面量确实是原值，再登记到这里 —— 不许顺手加。
  const FALLBACK_SNAPSHOT = new Set<string>([
    '--dsw-alias-bg-danger|#fdecea',
    '--dsw-alias-bg-layer-1|#fff',
    '--dsw-alias-bg-layer-2|#f4f5f7',
    '--dsw-alias-bg-layer-2|#f7f8fa',
    '--dsw-alias-bg-layer-3|#fff',
    '--dsw-alias-border-danger|#f3b1ad',
    '--dsw-alias-border-default|#e5e5e5',
    '--dsw-alias-border-l2|#3a3d45',
    '--dsw-alias-border-l2|#d0d3d8',
    '--dsw-alias-border-l2|#d0d3d9',
    '--dsw-alias-border-l1|#eef0f3',
    '--dsw-static-deepseek-450|#5686fe',
    '--dsw-alias-border-l2|#dfe1e5',
    '--dsw-alias-border-l2|#e5e6eb',
    '--dsw-alias-border-l2|#eee',
    '--dsw-alias-border-l2|#eef0f3',
    '--dsw-alias-border-l2|#f0f1f3',
    '--dsw-alias-border-l3|#dee0e3',
    '--dsw-alias-border-l3|#e5e5e5',
    '--dsw-alias-border-l3|#eef0f3',
    '--dsw-alias-border-l3|#f0f1f3',
    '--dsw-alias-brand-primary|#1677ff',
    '--dsw-alias-button-primary-hover|#0f5fce',
    '--dsw-alias-color-success|#00875a',
    '--dsw-alias-color-success-light|#e8ffea',
    '--dsw-alias-label-danger|#b3261e',
    '--dsw-alias-label-error|#c0392b',
    '--dsw-alias-label-primary|#fff',
    '--dsw-alias-label-primary|#1a1a1a',
    '--dsw-alias-label-primary|#1f2329',
    '--dsw-alias-label-primary-foreground|#fff',
    '--dsw-alias-label-secondary|#4e5969',
    '--dsw-alias-label-secondary|#555',
    '--dsw-alias-label-secondary|#5f6672',
    '--dsw-alias-label-secondary|#646a73',
    '--dsw-alias-label-tertiary|#6b7280',
    '--dsw-alias-label-tertiary|#888',
    '--dsw-alias-label-tertiary|#8f959e',
    '--dsw-alias-label-tertiary|#9aa0a6',
    '--dsw-alias-state-error-primary|#d93025',
    '--dsw-alias-state-success-primary|#15803d',
    '--dsw-alias-state-success-primary|#16a34a',
    '--dsw-alias-state-success-primary|#22c55e',
    '--dsw-alias-state-success-primary|#25803c',
    '--dsw-alias-state-success-primary|#2ea043',
    '--dsw-alias-state-warn-primary|#b45309',
    '--dsw-alias-state-warn-primary|#d9822b',
    '--dsw-alias-state-warn-primary|#e37400',
    '--dsw-alias-text-secondary|#4e5969',
    '--dsw-alias-warning|#d48806',
  ])

  it('每个 var(--token, 回退值) 的组合都必须是 baseline 原值（防回退值写错仍全绿）', () => {
    const unknown: string[] = []
    for (const m of css.matchAll(/var\((--[\w-]+),\s*(#[0-9a-fA-F]{3,8})\)/g)) {
      const key = `${m[1]}|${m[2].toLowerCase()}`
      if (!FALLBACK_SNAPSHOT.has(key)) unknown.push(key)
    }
    expect(unknown).toEqual([])
  })

  it('主色填充的规则不得写死白色内容（必须成对取 label-primary-foreground）', () => {
    const offenders: string[] = []
    for (const rule of css.split('}')) {
      const fillsBrand = /background:\s*var\(--dsw-alias-(brand-primary|button-primary-fill)/.test(rule)
      const whiteText = /(^|[;{\s])color:\s*#fff\b/.test(rule)
      if (fillsBrand && whiteText) offenders.push(rule.trim().slice(0, 120))
    }
    expect(offenders).toEqual([])
    expect(css).toContain('.dim-jh-switch:checked::after { background: var(--dsw-alias-label-primary-foreground, #fff); }')
    expect(css).toContain(".dim-jh-providerSwitch[aria-checked='true'] .dim-jh-providerSwitchThumb { background: var(--dsw-alias-label-primary-foreground, #fff); }")
  })

  it('反向钉子：渠道图标的白底容器保持白底（logo 是透明底深色图形）', () => {
    expect(css).toMatch(/\.dim-jh-providerIcon\.codearts \{ background: white; \}/)
  })

  it('jet-hub.js 的内联样式同样不裸写错误色', () => {
    const hub = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')
    expect(hub).not.toMatch(/color: '#d93025'/)
  })
})

/**
 * ★★ 五档分档配色的**可分辨性**（2026-11-18 三档分档）。
 *
 * ## 为什么需要这条
 *
 * 用户要求「长期=绿、短期=黄、临期=红」，但**「永久」已经是绿色**
 * （服务端未给到期时间 ⇒ 永不作废，绿）。因此长期必须用**另一种绿**
 * 才能与永久分辨 —— 这是本仓 2026-10-12 立的硬要求
 * （「永久与长期必须分开，否则用户分不出哪些积分永远不会作废」）。
 *
 * 实现是 `color-mix(绿 78%, 灰 22%)`。本用例锁住三件事：
 *
 * 1. 长期与永久**不是同一个声明**（否则就是同色，要求被违反）；
 * 2. 混色比例**在窗口内**（低于 ~70% 浅色主题跌破正文级对比度；
 *    高于 ~85% 与永久色距过小）；
 * 3. 卡片那份与徽标那份**必须同值**（两处是同一套配色，改一处不改另一处
 *    会出现「设置页浅绿、徽标黄」的自相矛盾）。
 */
describe('★★ 五档分档配色：永久/长期必须是两种可分辨的绿', () => {
  const css = withoutComments(stylesText())

  it('永久用 ok、长期用 okSoft（不同 tone ⇒ 才有不同色）', () => {
    expect(css, '永久必须是 ok').toMatch(/\.dim-jh-creditPoolPart\[data-tone="ok"\]/)
    expect(css, '长期必须是 okSoft（新增 tone）').toMatch(/\.dim-jh-creditPoolPart\[data-tone="okSoft"\]/)
    expect(css, '短期用 warn').toMatch(/\.dim-jh-creditPoolPart\[data-tone="warn"\]/)
    expect(css, '临期用 error').toMatch(/\.dim-jh-creditPoolPart\[data-tone="error"\]/)
  })

  it('★★ okSoft 的混色比例在窗口内（70%~85%）', () => {
    const m = /\.dim-jh-creditPoolPart\[data-tone="okSoft"\] \{ color: color-mix\(in srgb, var\(--dsw-alias-state-success-primary[^)]*\) (\d+)%,/.exec(css)
    expect(m, 'okSoft 必须是 color-mix(... 绿 N%, 灰 ...) 形态').not.toBeNull()
    const pct = Number(m![1])
    expect(pct, `混色比例 ${pct}% 太低 ⇒ 浅色主题下对比度不足 4.5`).toBeGreaterThanOrEqual(70)
    expect(pct, `混色比例 ${pct}% 太高 ⇒ 与「永久」色距过小、分不清`).toBeLessThanOrEqual(85)
  })

  it('★★ 卡片与徽标两份 okSoft 必须逐字同值（否则两处配色自相矛盾）', () => {
    const card = /\.dim-jh-creditPoolPart\[data-tone="okSoft"\] \{ color: ([^;]+); \}/.exec(css)?.[1]?.trim()
    const badge = /\.dim-jh-badgeNotePart\[data-tone="okSoft"\] \{ color: ([^;]+); \}/.exec(css)?.[1]?.trim()
    expect(card, '卡片侧的 okSoft 声明').toBeDefined()
    expect(badge, '徽标侧的 okSoft 声明').toBeDefined()
    expect(badge, '两处必须同值').toBe(card)
  })

  it('⚠️ 反向对照：ok 与 okSoft 不能是同一份声明（同色就等于回到「分不清」）', () => {
    const ok = /\.dim-jh-creditPoolPart\[data-tone="ok"\] \{ color: ([^;]+); \}/.exec(css)?.[1]?.trim()
    const okSoft = /\.dim-jh-creditPoolPart\[data-tone="okSoft"\] \{ color: ([^;]+); \}/.exec(css)?.[1]?.trim()
    expect(ok).not.toBe(okSoft)
  })
})
