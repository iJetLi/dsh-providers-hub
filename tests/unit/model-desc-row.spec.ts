import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

/**
 * 「模型介绍」第二行的行为级守卫（2026-11-17）。
 *
 * ## 这条修法要解决什么
 *
 * CodeArts `/v1/model/builtin` 的 `model_desc`（实测 12 条全带，如
 * `【限时体验】许愿式编程一键成真`）是 CodeArts 客户端选择器那行灰字的来源。
 * 插件此前**不读该字段** ⇒ 上游下发了、我们丢掉。
 *
 * ## 为什么落点是插件面板而不是宿主 `/model` 弹层
 *
 * 宿主 `dsh-client-ui-model-selection` 把 `description` 塞进弹层的 `detail`，
 * 而 `detail` 是**同一行行尾的 12px 灰字**（`dsh-client-ui-commands` 的
 * `PopupSelectView`：`.detail{white-space:nowrap;text-overflow:ellipsis}`，
 * 弹层 `min-width:min(220px,100%)`）⇒ 一句 20～60 字的介绍会被截成几个字，
 * 还会把模型名挤短。用户本人的原话是「我从来没见到 DSH 显示副行，都是一行的」。
 * ⇒ 要看得见的第二行，只能在插件自己的「模型列表」弹窗里做。
 *
 * ## ⚠️ 为什么必须真渲染
 *
 * `model-center-panel.spec.ts` 是**源码级**的，`ModelToggle` 的渲染分支一条都
 * 没被执行过。本仓「接线层零守卫」的事故史（`if (false)` 旁路、三条源码断言
 * 各有一个真实旁路而 41 条用例全绿）说明：判据必须打在**产物**上。
 */

/** 极简 React 元素树：只要能把 props 与文本子节点走一遍。 */
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] }

const reactStub = {
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node =>
    ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
}

vi.mock('react', () => reactStub)

type ToggleProps = {
  provider: string
  model: Record<string, unknown>
  busy: boolean
  onToggle: (id: string, disabled: boolean) => void
  onRestore: (id: string) => void
}

async function renderRow(model: Record<string, unknown>): Promise<Node> {
  const mod = await import('../../plugin-src/client/jet-hub.js') as unknown as {
    __modelToggleForTest: (props: ToggleProps) => Node
  }
  expect(mod.__modelToggleForTest, '客户端必须导出 __modelToggleForTest 才能真渲染').toBeTypeOf('function')
  return mod.__modelToggleForTest({
    provider: 'codearts',
    model,
    busy: false,
    onToggle: () => {},
    onRestore: () => {},
  })
}

function walk(node: Node): Node[] {
  const out: Node[] = [node]
  for (const child of node.children) {
    if (child !== null && typeof child === 'object' && 'props' in (child as Node)) {
      out.push(...walk(child as Node))
    }
  }
  return out
}

function byClass(root: Node, className: string): Node[] {
  return walk(root).filter((node) => typeof node.props.className === 'string'
    && String(node.props.className).split(/\s+/).includes(className))
}

/** 把一个子树的文本子节点拼起来（`createElement` 的第三参起）。 */
function textsOf(node: Node): string {
  return node.children.filter((child) => typeof child === 'string').join('')
}

const BASE = { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017 · 0.18x', disabled: false }

describe('模型行 · 模型介绍（第二行 + 完整描述进 title）', () => {
  it('★★★ 有介绍 ⇒ 恰好一枚第二行元素，文案原样、title 为完整描述', async () => {
    const DESC = '【限时体验】许愿式编程一键成真'
    const row = await renderRow({ ...BASE, description: DESC })

    const descs = byClass(row, 'dim-jh-modelDesc')
    expect(descs, '有介绍时必须画第二行').toHaveLength(1)
    // ⚠️ 文案必须**逐字**是上游给的（不裁 `【限时体验】`、不改写措辞）。
    expect(textsOf(descs[0]!)).toBe(DESC)
    // 行内会被 ellipsis 截断 ⇒ 完整描述必须在 title 里能看到。
    expect(descs[0]!.props.title).toBe(DESC)
    // 行本身的 title 让给介绍（不再是裸 id）。
    expect(row.props.title).toBe(DESC)
  })

  it('★★ 第二行必须排在 name / id **之后**（不能把模型名顶到第二行）', async () => {
    // 布局机制是 `flex: 0 0 100%` + 父容器 `flex-wrap`（见下方 CSS 用例），
    // 而 DOM 顺序决定「谁在第一行」：介绍先出现的话，name/id 会被挤到第二行。
    const row = await renderRow({ ...BASE, description: '【限时体验】能力更高, 速度更快' })
    const info = byClass(row, 'dim-jh-modelInfo')
    expect(info).toHaveLength(1)

    const order = info[0]!.children
      .filter((child): child is Node => child !== null && typeof child === 'object' && 'props' in (child as Node))
      .map((child) => String(child.props.className))
    expect(order.indexOf('dim-jh-modelDesc'), '介绍必须是 modelInfo 的直接子元素').toBeGreaterThan(-1)
    expect(order.indexOf('dim-jh-modelName')).toBeLessThan(order.indexOf('dim-jh-modelDesc'))
    expect(order.indexOf('dim-jh-modelId')).toBeLessThan(order.indexOf('dim-jh-modelDesc'))
    // 「角标在 id 之前」的既有守卫依赖这条顺序没有被包一层容器（回归口径）。
    expect(order.indexOf('dim-jh-modelDesc')).toBe(order.length - 1)
  })

  it('★★ 没有介绍 ⇒ 不渲染第二行，行 title 回落到 id（旧布局逐字节不变）', async () => {
    for (const model of [
      { ...BASE },
      { ...BASE, description: '' },
      { ...BASE, description: '   ' },
      { ...BASE, description: 42 },
    ]) {
      const row = await renderRow(model)
      expect(byClass(row, 'dim-jh-modelDesc'), `description=${JSON.stringify(model.description)} 不许画第二行`)
        .toHaveLength(0)
      expect(row.props.title, '没有介绍时 title 必须仍是 id').toBe(BASE.id)
    }
  })

  it('★★ 已下架 + 有介绍 ⇒ title 仍是「已下架」提示（自救路径不能被顶掉）', async () => {
    // 已下架模型只能靠「重新显示」自救，那条提示比介绍重要得多：
    // 用户看到「【限时体验】…」却不知道这个模型其实已经不可用，会一直点。
    const row = await renderRow({ ...BASE, dead: true, description: '【限时体验】许愿式编程一键成真' })
    expect(String(row.props.title)).toContain('上游已下架')
  })
})

describe('模型行 · 第二行的布局判据（CSS 是这套布局的全部机制）', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../plugin-src/client/jet-hub-styles.js', import.meta.url)),
    'utf8',
  )

  /** 取一条**行首锚定**的规则（避免匹配到注释里的同名字符串）。 */
  function ruleOf(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
    expect(match, `缺少规则 ${selector}`).not.toBeNull()
    return match![1]!
  }

  it('★★ `.dim-jh-modelInfo` 必须允许换行（否则第二行落不下来）', () => {
    expect(ruleOf('.dim-jh-modelInfo')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('★★ `.dim-jh-modelDesc` 必须独占一行且能省略（`flex: 0 0 100%` 是承重判据）', () => {
    const rule = ruleOf('.dim-jh-modelDesc')
    expect(rule, '不在 flex-basis:100% 上就根本不会换行，只会挤在同一行').toMatch(/flex:\s*0\s+0\s+100%/)
    // 长介绍窄面板下必须 ellipsis 而不是横向撑破布局。
    expect(rule).toMatch(/text-overflow:\s*ellipsis/)
    expect(rule).toMatch(/white-space:\s*nowrap/)
  })
})
