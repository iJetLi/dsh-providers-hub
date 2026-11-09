import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PINNED_PROVIDER_IDS,
  groupProviders,
  isPinnedProvider,
  splitPinnedProviders,
} from '../../plugin-src/client/provider-toggle.js'
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const hub = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8').replace(/\r\n/g, '\n')
const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8').replace(/\r\n/g, '\n')
const css = styles.replace(/\/\*[\s\S]*?\*\//g, '')

const P = (id: string) => ({ id })

describe('splitPinnedProviders（纯逻辑）', () => {
  it('聚合被拆到置顶块，其余保持原顺序', () => {
    const list = [P('codearts'), P('buddy'), P('aggregate'), P('qoder')]
    const { pinned, channels } = splitPinnedProviders(list)
    expect(pinned.map((p) => p.id)).toEqual(['aggregate'])
    expect(channels.map((p) => p.id)).toEqual(['codearts', 'buddy', 'qoder'])
  })

  it('分组与计数只作用于普通渠道（不再把聚合算成一个渠道）', () => {
    const { channels } = splitPinnedProviders([P('codearts'), P('aggregate'), P('trae')])
    const { open, closed } = groupProviders(channels, { trae: { closed: true } })
    expect(open.map((p) => p.id)).toEqual(['codearts'])
    expect(closed.map((p) => p.id)).toEqual(['trae'])
  })

  it('入参异常时不抛', () => {
    expect(splitPinnedProviders(null as never)).toEqual({ pinned: [], channels: [] })
    expect(splitPinnedProviders([null, P('aggregate')] as never).pinned).toHaveLength(1)
  })

  it('置顶清单里的 id 都真实存在，且都不是普通渠道（channel: false）', () => {
    for (const id of PINNED_PROVIDER_IDS) {
      const descriptor = PROVIDER_REGISTRY.find((d) => d.id === id)
      expect(descriptor, `${id} 必须在注册表里`).toBeDefined()
      expect(descriptor?.channel, `${id} 必须登记为 channel: false`).toBe(false)
    }
    expect(isPinnedProvider('aggregate')).toBe(true)
    expect(isPinnedProvider('codearts')).toBe(false)
  })
})

describe('左侧导航接线（源码级）', () => {
  const start = hub.indexOf('const renderRail = () =>')
  const rail = hub.slice(start, hub.indexOf('};', start))

  it('renderRail 先拆出置顶块，分组只吃普通渠道', () => {
    expect(rail).toContain('splitPinnedProviders(PROVIDERS)')
    expect(rail).toContain('groupProviders(channels, providerStatuses)')
    expect(rail).not.toContain('groupProviders(PROVIDERS, providerStatuses)')
  })

  it('置顶块排在两个分组之前；状态未读到时也排在最前', () => {
    expect(rail).toMatch(/return \[\s*pinnedBlock,/)
    expect(rail).toContain('return [pinnedBlock, ...channels.map(')
  })

  it('置顶行带强调类名与副标题，且仍是 role=tab 的按钮（导航语义不变）', () => {
    const rowStart = hub.indexOf('const renderProviderRow = (p) => {')
    const row = hub.slice(rowStart, start)
    expect(row).toContain("'dim-jh-provider dim-jh-provider--pinned'")
    expect(row).toContain("'data-pinned': pinned ? 'true' : undefined")
    expect(row).toContain('dim-jh-providerSub')
    expect(row).toContain("role: 'tab'")
  })
})

describe('样式', () => {
  it('宽屏：置顶块与强调样式都有规则', () => {
    expect(css).toMatch(/\.dim-jh-railPinned \{[^}]*border-bottom:/)
    expect(css).toMatch(/\.dim-jh-provider--pinned \{[^}]*var\(--dsw-alias-brand-primary, #1677ff\)/)
    expect(css).toMatch(/\.dim-jh-providerSub \{[^}]*text-overflow: ellipsis/)
  })

  it('窄屏：置顶块展平进横向标签条、用竖线隔开、副标题收起', () => {
    const block = css.slice(css.indexOf('@media (max-width: 720px) {\n  .dim-jh-layout'))
    const narrow = block.slice(0, block.indexOf('\n}\n'))
    expect(narrow).toMatch(/\.dim-jh-railPinned \{ display: contents; \}/)
    expect(narrow).toMatch(/\.dim-jh-providerRow\[data-pinned="true"\] \{[^}]*border-right:/)
    expect(narrow).toMatch(/\.dim-jh-providerSub \{ display: none; \}/)
  })
})
