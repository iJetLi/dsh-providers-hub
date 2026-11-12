/**
 * `plugin-src/client/ledger-tab.js` 的**注册接线**行为守卫。
 *
 * ## 为什么必须有它（本仓库反复记录过的形态）
 *
 * 本功能的三个组成部分各自都能被**静默改坏**，而且坏了都**不会报错**：
 *
 * | # | 接线点 | 改坏后的症状 | 零守卫时会不会红 |
 * |---|---|---|---|
 * | 1 | `registry.register({ id, kind, guide })` | 右侧栏「开始」页没有那张卡 | 不会 |
 * | 2 | `key: LEDGER_TAB_ID`（**不是** `kind`） | 卡片点了，标签页正文**空白** | 不会 |
 * | 3 | 正文组件包了 `withErrorBoundary` | 渲染期异常卸载整棵树 | 不会 |
 *
 * 第 2 条尤其阴险：宿主按 `entryKey = definition.id` 精确查 keyed 槽
 * （`dsh-client-ui-sidebar-right` 的 `renderSlot(…, { entryKey: definition?.id })`），
 * 写成 `kind` 时槽位**照常注册成功**、只是永远不被派发 —— 与「没写」同形。
 *
 * ## 判据为什么是行为级
 *
 * 源码文本断言打不过「局部别名 / 死分支诱饵 / 常量下沉」这几种改法（本仓库
 * 2026-10-24 对抗审计实测过 3 种手法全绿）。这里真 import 本模块、用替身 React
 * 与替身 `ctx` 跑一遍注册，然后直接问**注册进去的那个对象**长什么样。
 *
 * ## 替身的诚实边界
 *
 * 替身不实现 React 的协调与 cordis 的服务解析：它只能证明「注册时传了什么」，
 * 不能证明「宿主会怎么渲染」。后者由 `ledger-pane-chrome.spec.ts`（真渲染
 * `TokenLedgerPanel`）与本机真机验收负责。
 *
 * @module tests/unit/ledger-tab-wiring.spec.ts
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// ── 替身 React：`withErrorBoundary` 需要 `Component` 与 `createElement` ──
vi.mock('react', () => {
  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(partial) {
      this.state = { ...this.state, ...(typeof partial === 'function' ? partial(this.state) : partial) }
    }

    render() {
      return null
    }
  }
  return {
    Component,
    default: { Component },
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    StrictMode: 'StrictMode',
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
})

// ── 替身 `jet-hub.js`：本文件不渲染面板，只需要那个符号能被 import 到 ──
vi.mock('../../plugin-src/client/jet-hub.js', () => ({
  TokenLedgerPanel: function TokenLedgerPanel() {
    return null
  },
  JET_HUB_RPC_CHANNEL: '/jet-hub',
  providerLabel: () => 'x',
  JetHubPage: function JetHubPage() {
    return null
  },
}))

const { registerJetHubLedgerTab, LEDGER_TAB_ID, LEDGER_TAB_KIND, LEDGER_TAB_ORDER } =
  await import('../../plugin-src/client/ledger-tab.js')

/**
 * 最小 `ctx`：`inject` / `slots.inject` / `slots.register` 三个面。
 *
 * @param {{ withService?: boolean, withInject?: boolean }} options
 *   `withService` 控制 `sidebarRightTabs` 是否存在；`withInject` 控制
 *   `ctx.inject` 本身是否存在（老宿主 / 更小的替身）。
 */
function makeCtx({ withService = true, withInject = true } = {}) {
  /** `registry.register` 收到的定义。 */
  const types = []
  /** `slots.register` 收到的 (spec, component)。 */
  const registrations = []
  /** 槽位注入记录，供用例手动驱动。 */
  const slotInjections = []
  /** `registry.register` 返回的注销函数是否被调用过。 */
  const disposed = { type: 0, slot: 0 }

  const registry = {
    register(definition) {
      types.push(definition)
      return () => {
        disposed.type += 1
      }
    },
  }

  const ctx = {
    slots: {
      inject(slot, callback) {
        slotInjections.push({ slot, callback })
        return () => {
          disposed.slot += 1
        }
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
  }

  if (withInject) {
    ctx.inject = (deps, callback) => {
      const scoped = {}
      if (withService && deps.includes('sidebarRightTabs')) scoped.sidebarRightTabs = registry
      const stop = callback(scoped)
      return typeof stop === 'function' ? stop : () => {}
    }
  }

  return { ctx, types, registrations, slotInjections, disposed }
}

/** 跑一遍注册器，并**手动驱动**槽位注入（宿主在渲染该槽位时才这么做）。 */
function register(options = {}) {
  const harness = makeCtx(options)
  registerJetHubLedgerTab(harness.ctx, () => Promise.resolve())
  for (const { slot, callback } of harness.slotInjections) {
    if (slot === 'sidebar.right.pane.tab') callback()
  }
  return harness
}

describe('ledger-tab 注册：类型与引导卡', () => {
  it('★ 注册了 1 个标签页类型，id / kind / priority 都对', () => {
    const { types } = register()
    expect(types, '没有注册任何标签页类型 —— 右侧栏不会出现那张卡').toHaveLength(1)
    const [definition] = types
    expect(definition.id).toBe(LEDGER_TAB_ID)
    // ⚠️ id 与 kind 是两个值：id 是「哪个实现」，kind 是「哪类页面」。
    expect(definition.id).not.toBe(definition.kind)
    expect(definition.kind).toBe(LEDGER_TAB_KIND)
    // 第三方插件必须是 extension 带宽（builtin 是宿主自带的带宽）
    expect(definition.priority).toBe('extension')
    // 切走再切回不重挂（账本读取是异步的，重挂会白拉一遍）
    expect(definition.keepMounted).toBe(true)
  })

  it('★ 引导卡：order 落在「浏览器(30)」与「会话数据诊断(60)」之间', () => {
    const { types } = register()
    const entries = types[0].guide ?? []
    expect(entries, '没有引导卡 —— 卡片不会出现在右侧栏「开始」页').toHaveLength(1)
    const [card] = entries
    expect(card.order).toBe(LEDGER_TAB_ORDER)
    // ⚠️ 这两个数字是**本机实测**的邻居位置（见 ledger-tab.js 文件头）。
    //    上游/其它插件改了排序时这里会红 —— 那是提醒重新看一眼位置，不是回归。
    expect(card.order).toBeGreaterThan(30)
    expect(card.order).toBeLessThan(60)
    expect(card.title()).toContain('Token 用量')
    expect(card.description()).toBeTruthy()
  })

  it('标题与描述都是**函数**（跟随语言/主题现读，不是快照字符串）', () => {
    const { types } = register()
    const [definition] = types
    expect(typeof definition.title, 'title 必须是函数').toBe('function')
    expect(typeof definition.guide[0].title, 'guide.title 必须是函数').toBe('function')
    expect(typeof definition.guide[0].description, 'guide.description 必须是函数').toBe('function')
  })
})

describe('ledger-tab 注册：正文槽位', () => {
  it('★★ key 必须是 definition.id（写成 kind 时宿主查不到，正文永远空白）', () => {
    const { registrations } = register()
    const body = registrations.find((row) => row.spec?.name === 'sidebar.right.pane.tab')
    expect(body, '没有注册 sidebar.right.pane.tab —— 卡片点了没有正文').toBeTruthy()
    expect(
      body.spec.key,
      'key 不是 definition.id —— 宿主按 entryKey = definition.id 精确查表，写成 kind 会落空',
    ).toBe(LEDGER_TAB_ID)
    expect(body.spec.key).not.toBe(LEDGER_TAB_KIND)
  })

  it('★★ 注册的正文组件**真的是**错误边界（不是裸组件）', () => {
    const { registrations } = register()
    const body = registrations.find((row) => row.spec?.name === 'sidebar.right.pane.tab')
    const component = body?.component
    expect(typeof component).toBe('function')
    // `withErrorBoundary` 会给边界类设 `displayName = withErrorBoundary(...)`。
    expect(
      String(component.displayName ?? component.name ?? ''),
      '注册的是裸组件 —— 渲染期异常会卸载整棵树（应包 withErrorBoundary）',
    ).toContain('withErrorBoundary')
    // 光有名字不算：它必须真的实现边界协议。
    expect(typeof component.getDerivedStateFromError).toBe('function')
  })

  it('正文通过 inject 拿到 rpcCall（与面板入口共用同一份，不另建连接）', () => {
    const { registrations } = register()
    const body = registrations.find((row) => row.spec?.name === 'sidebar.right.pane.tab')
    const injected = body.spec.inject('session-1')
    expect(typeof injected.rpcCall, 'inject 没有下发 rpcCall').toBe('function')
  })

  it('正文组件是**模块级常量**（两次注册拿到同一个类 ⇒ 切标签不卸载重挂）', () => {
    const first = register()
    const second = register()
    const pick = (harness) => harness.registrations.find((row) => row.spec?.name === 'sidebar.right.pane.tab')
    expect(pick(first).component).toBe(pick(second).component)
  })
})

describe('ledger-tab 注册：环境缺失时优雅跳过', () => {
  it('★ 宿主没有 sidebarRightTabs 服务时：什么都不注册，且不抛', () => {
    const harness = makeCtx({ withService: false })
    expect(() => registerJetHubLedgerTab(harness.ctx, () => Promise.resolve())).not.toThrow()
    expect(harness.types, '服务缺席时不该注册类型').toHaveLength(0)
    expect(harness.slotInjections, '服务缺席时不该注入槽位').toHaveLength(0)
  })

  it('★ 老宿主连 ctx.inject 都没有时：不抛 TypeError', () => {
    const harness = makeCtx({ withInject: false })
    expect(
      () => registerJetHubLedgerTab(harness.ctx, () => Promise.resolve()),
      'ctx.inject 缺失时必须静默返回 —— 抛错会掩盖「接线断了」那条判据',
    ).not.toThrow()
    expect(harness.types).toHaveLength(0)
  })

  it('ctx 是 undefined / 非对象时也不抛（插件被提前卸载的边角）', () => {
    expect(() => registerJetHubLedgerTab(undefined, () => Promise.resolve())).not.toThrow()
    expect(() => registerJetHubLedgerTab(null, () => Promise.resolve())).not.toThrow()
    expect(() => registerJetHubLedgerTab(42, () => Promise.resolve())).not.toThrow()
  })
})

describe('ledger-tab 注册：注销', () => {
  it('★ 服务消失时 disposer 同时注销类型与槽位（不留指向已消失组件的标签页）', () => {
    /** 记录两类注册各自的注销次数。 */
    const disposed = { type: 0, slot: 0 }
    /** 槽位注册返回的注销函数（宿主调它时计数）。 */
    const ctx = {
      inject(deps, callback) {
        return callback({
          sidebarRightTabs: {
            register() {
              return () => {
                disposed.type += 1
              }
            },
          },
        })
      },
      slots: {
        inject() {
          return () => {
            disposed.slot += 1
          }
        },
        register() {
          return () => {}
        },
      },
    }

    // `registerJetHubLedgerTab` 把 `ctx.inject` 的返回函数原样交回给调用方，
    // 由 cordis 在服务消失 / 插件卸载时调用。
    const stop = registerJetHubLedgerTab(ctx, () => Promise.resolve())
    expect(typeof stop, 'ctx.inject 的清理函数没有被返回 —— 宿主无法注销').toBe('function')
    expect(disposed, '注销前不该有任何清理').toEqual({ type: 0, slot: 0 })

    stop()
    expect(disposed.type, '类型没有注销 —— 右侧栏会留着一张指向已消失组件的卡').toBe(1)
    expect(disposed.slot, '槽位没有注销').toBe(1)
  })
})

describe('ledger-tab：package.json 的客户端到达顺序', () => {
  it('★ dsh.client.inject 声明了 sidebar-right（只影响到达顺序，不是硬依赖）', () => {
    const pkg = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8'))
    const list = pkg?.dsh?.client?.inject ?? []
    expect(
      list,
      'dsh.client.inject 缺 @deepseek-ai/dsh-client-ui-sidebar-right —— 客户端模块到达顺序无保证',
    ).toContain('@deepseek-ai/dsh-client-ui-sidebar-right')
    // ⚠️ 但它**不得**出现在 `export const inject` 里：那是 cordis 的硬服务依赖。
    const indexSource = readFileSync(resolve(here, '../../plugin-src/client/index.js'), 'utf8')
    const match = /export const inject = \[([^\]]*)\]/.exec(indexSource)
    expect(match, '找不到 export const inject').not.toBeNull()
    expect(
      match[1],
      'sidebarRightTabs 不得写进 export const inject —— 缺该服务的宿主上整条插件会不激活',
    ).not.toContain('sidebarRightTabs')
  })
})
