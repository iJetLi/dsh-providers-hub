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

const SEMANTIC: Record<string, string> = {
  '#1677ff': '--dsw-alias-brand-primary',
  '#d93025': '--dsw-alias-state-error-primary',
  '#b3261e': '--dsw-alias-label-danger',
  '#15803d': '--dsw-alias-state-success-primary',
  '#22c55e': '--dsw-alias-state-success-primary',
  '#b45309': '--dsw-alias-state-warn-primary',
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
