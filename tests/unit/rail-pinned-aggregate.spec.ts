import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PINNED_PROVIDER_IDS,
  buildRailSections,
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

describe('buildRailSections（左侧导航的分区，行为级）', () => {
  // ⚠️ 这一格挡的是「源码断言可绕」：`renderRail` 是闭包、只能靠正则验证，
  // 而 `const { pinned } = splitPinnedProviders(PROVIDERS); const channels = PROVIDERS;`
  // 这种写法能让三条源码断言全绿（实测 9 条绿）、聚合却回到了渠道组里。
  // 把「拆分 + 分组」抽成纯函数后，这里传**真的 PROVIDERS** 进来断言。
  it('聚合不在任何一组里（已打开 / 已关闭都不得出现它），其余渠道一个不少', () => {
    const sections = buildRailSections(PROVIDER_REGISTRY, {})
    expect(sections.pinned.map((p) => p.id)).toEqual(['aggregate'])
    const groupIds = [...sections.open, ...sections.closed].map((p) => p.id)
    expect(groupIds).not.toContain('aggregate')
    expect(groupIds).toHaveLength(PROVIDER_REGISTRY.length - 1)
  })

  it('状态缺失（statuses === null）时只把普通渠道交给列表', () => {
    const sections = buildRailSections(PROVIDER_REGISTRY, null)
    expect(sections.pinned.map((p) => p.id)).toEqual(['aggregate'])
    expect(sections.channels.map((p) => p.id)).not.toContain('aggregate')
    expect(sections.open).toEqual([])
    expect(sections.closed).toEqual([])
  })
})

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
  // ⚠️ 先剥注释再断言：函数体里用注释写了「不要这样写」的**反例**（含
  // `splitPinnedProviders(PROVIDERS)` 等字样），不剥注释会让 `not.toContain`
  // 反而红。注释不是接线。
  const rail = hub
    .slice(start, hub.indexOf('};', start))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('renderRail 的分区来自 buildRailSections（拆分 + 分组都在纯函数里）', () => {
    expect(rail).toContain('buildRailSections(PROVIDERS, providerStatuses)')
    // ⚠️ 拆分/分组**不得**写回这个闭包：闭包没有导出、只能靠源码正则验证，
    // 而实测有两种写法（`const { pinned } = splitPinnedProviders(PROVIDERS); const channels = PROVIDERS;`
    // 与把 `groupProviders(channels, …)` 换成别名）能让「拆出置顶块」「分组只吃普通渠道」
    // 这三条断言**全绿**、聚合却回到渠道组里。行为级守卫见上面的 `buildRailSections` describe。
    expect(rail).not.toContain('splitPinnedProviders(PROVIDERS)')
    expect(rail).not.toContain('groupProviders(')
  })

  it('置顶块排在两个分组之前；状态未读到时也排在最前', () => {
    expect(rail).toMatch(/return \[\s*pinnedBlock,/)
    expect(rail).toContain('return [pinnedBlock, ...sections.channels.map(')
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
