import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `SyncModelsSection` 的**组件级行为级**守卫（2026-11-12，PR #184 对抗性审计）。
 *
 * ## 为什么这个文件必须存在
 *
 * 提交的 `sync-models-section.spec.ts`（27 例）**没有**任何 React 替身 ——
 * 它只 import `sync-models-logic.js` 的纯函数，`SyncModelsSection` 全仓**零测试引用**。
 * 结果是组件层的两条真实缺陷都测不到：
 *
 * 1. `run` 的 `useCallback` deps 缺 `targetList`（渲染期变量）⇒ 用户取消勾选
 *    ZCode 后点「同步」，`sync.apply` 收到 `targets: ['pi','zcode']` ——
 *    界面上 ZCode 的 checkbox 明明是 `false`，写盘却包含它；
 * 2. `load` 只有 `mounted` 没有请求序号 ⇒ 连点渠道时旧响应覆盖新响应，
 *    界面出现「摘要说已选 1 个渠道、折叠标题说已选 2/2」的自相矛盾状态。
 *
 * 实测：向 `run` 注入「deps 去掉 targetList」这一处变异，提交的 130 条用例**全绿**。
 *
 * ## 替身为什么必须「忠实」
 *
 * 仓库既有的替身（`tests/unit/jet-hub-panel-wiring.spec.ts`）里
 * `useCallback(fn) { callbacks.push(fn); return fn }` —— **忽略 deps、每次新建**。
 * 在它下面「回调漏 deps」**恒绿**（每次都拿最新的，永远不会陈旧）。
 * 本文件按真实 React 语义实现：deps 相同 ⇒ **返回上一次的回调实例**。
 *
 * 同理 `useRef` 必须写 `current`（不是 `.v`）—— `client-ui.md` 记过事故：
 * 替身只写 `cur` ⇒ `++ref.current` = NaN ⇒ `NaN !== NaN` 恒真 ⇒ 序号闸门
 * 永远丢弃结果 ⇒ 同样是假绿。
 */

const rt = vi.hoisted(() => {
  const state = {
    /** hook 槽位：**跨渲染**持久（这才是 React 的状态语义）。 */
    hooks: [] as Array<{ kind: string; deps?: unknown; fn?: unknown; value?: unknown; current?: unknown }>,
    /** 每次渲染重置：hook 调用序号。 */
    cursor: 0,
    /** 本次渲染产出的元素（先序扁平）。 */
    elements: [] as Array<{ type: unknown; props: any; children: unknown[] }>,
    /** 本次渲染期间是否发生过 setState（用来判断要不要再渲染一轮）。 */
    dirty: false,
    /** 本次渲染新登记的 effect。 */
    pending: [] as Array<() => void>,
  }

  const sameDeps = (left: unknown, right: unknown): boolean => {
    if (!Array.isArray(left) || !Array.isArray(right)) return left === right
    if (left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }

  const stub = {
    useState(initial: unknown) {
      const key = state.cursor++
      if (!(key in state.hooks)) {
        state.hooks[key] = {
          kind: 'state',
          value: typeof initial === 'function' ? (initial as () => unknown)() : initial,
        }
      }
      const slot = state.hooks[key]
      return [
        slot.value,
        (next: unknown) => {
          slot.value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot.value) : next
          state.dirty = true
        },
      ]
    },
    useRef(initial: unknown) {
      const key = state.cursor++
      if (!(key in state.hooks)) state.hooks[key] = { kind: 'ref', current: initial }
      return state.hooks[key]
    },
    useEffect(fn: () => void, deps?: unknown) {
      const key = state.cursor++
      const previous = state.hooks[key]
      if (previous && sameDeps(previous.deps, deps)) return
      state.hooks[key] = { kind: 'effect', deps, fn }
      state.pending.push(fn)
    },
    useCallback(fn: unknown, deps?: unknown) {
      const key = state.cursor++
      const previous = state.hooks[key]
      // ★ 忠实语义：deps 相同必须返回**同一个**回调实例 —— 否则「陈旧闭包」测不出来。
      if (previous && sameDeps(previous.deps, deps)) return previous.fn
      state.hooks[key] = { kind: 'callback', deps, fn }
      return fn
    },
    createElement(type: unknown, props: any, ...children: unknown[]) {
      const node = { type, props: props ?? {}, children }
      state.elements.push(node)
      return node
    },
    Fragment: 'Fragment',
    StrictMode: 'StrictMode',
  }

  return { state, stub, sameDeps }
})

vi.mock('react', () => rt.stub)

function resetComponent(): void {
  rt.state.hooks = []
  rt.state.cursor = 0
  rt.state.elements = []
  rt.state.dirty = false
  rt.state.pending = []
}

type SyncModule = typeof import('../../plugin-src/client/sync-models-section.js')

/**
 * 渲染到稳定：反复「渲染 → 跑 effect → 让微任务落地」，直到没有 setState。
 */
async function settle(mod: SyncModule, props: { rpcCall: (method: string, payload?: unknown) => Promise<unknown> }) {
  for (let round = 0; round < 40; round += 1) {
    rt.state.dirty = false
    rt.state.cursor = 0
    rt.state.elements = []
    rt.state.pending = []
    mod.SyncModelsSection(props)
    const pending = rt.state.pending
    rt.state.pending = []
    for (const fn of pending) fn()
    await new Promise(resolve => setTimeout(resolve, 0))
    if (!rt.state.dirty) return rt.state.elements
  }
  throw new Error('组件渲染未收敛（可能是 effect 死循环）')
}

function checkboxes(elements: Array<{ type: unknown; props: any; children: unknown[] }>) {
  return elements.filter(node => node.type === 'input' && node.props?.type === 'checkbox')
}

function button(elements: Array<{ type: unknown; props: any; children: unknown[] }>, text: string) {
  return elements.find(node => node.type === 'button' && node.children.includes(text))
}

function previewValue(overrides: Record<string, unknown> = {}) {
  return {
    gatewayBaseUrl: 'http://127.0.0.1:8326/v1',
    totalModelCount: 3,
    modelCount: 3,
    usableModelCount: 3,
    providers: [
      { id: 'codearts', modelCount: 2, inTargets: { pi: true, zcode: true } },
      { id: 'minimax', modelCount: 1, inTargets: { pi: false, zcode: false } },
    ],
    requestedProviders: ['codearts', 'minimax'],
    failedProviders: [],
    targets: [
      {
        target: 'pi',
        ok: true,
        path: '/home/u/.pi/agent/models.json',
        diff: { added: ['minimax/m'], removed: [], updated: [], skipped: [] },
      },
      {
        target: 'zcode',
        ok: true,
        path: '/home/u/.zcode/v2/provider_config.json',
        diff: { added: ['minimax/m'], removed: [], updated: [], skipped: [] },
      },
    ],
    ...overrides,
  }
}

describe('SyncModelsSection 组件行为（PR #184 审计回归）', () => {
  beforeEach(() => {
    resetComponent()
  })

  it('★ 取消勾选 ZCode 后点「同步」，payload.targets 必须不含 zcode', async () => {
    const calls: Array<{ method: string; payload: any }> = []
    const rpcCall = async (method: string, payload?: unknown) => {
      calls.push({ method, payload })
      if (method === 'sync.apply') {
        return { applied: [{ target: 'pi', backupDir: '/home/u/.pi/agent/backups/b', diff: { added: ['minimax/m'], removed: [], updated: [] } }], skipped: [] }
      }
      return previewValue()
    }
    const mod = await import('../../plugin-src/client/sync-models-section.js')

    const first = await settle(mod, { rpcCall })
    // 2 个渠道 + 2 个目标
    const firstBoxes = checkboxes(first)
    expect(firstBoxes.length).toBe(4)
    // 目标 checkbox 在渠道之后：index 2 = pi，3 = zcode
    expect(firstBoxes[2].props.checked).toBe(true)
    expect(firstBoxes[3].props.checked).toBe(true)

    // 用户取消勾选 ZCode（只动目标、不动渠道 —— 这正是缺陷复现路径）
    firstBoxes[3].props.onChange()

    const second = await settle(mod, { rpcCall })
    const secondBoxes = checkboxes(second)
    expect(secondBoxes[3].props.checked).toBe(false)
    // 按钮必须仍然可用（pi 还有可写入的变更）
    const syncButton = button(second, '同步')
    expect(syncButton, '「同步」按钮必须渲染出来').toBeTruthy()
    expect(syncButton!.props.disabled).toBe(false)

    syncButton!.props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))

    const applyCall = calls.find(call => call.method === 'sync.apply')
    expect(applyCall, '必须真的调用了 sync.apply').toBeTruthy()
    // ⚠️ 核心判据：界面上 ZCode 已经是未勾选，写盘就绝不能包含它
    expect(applyCall!.payload.targets).toEqual(['pi'])
    // 渠道白名单不受影响
    expect(applyCall!.payload.providers).toEqual(['codearts', 'minimax'])
  })

  it('★ 预览失败时必须清掉上一次的「已写入」结果（红字与绿字不能同屏）', async () => {
    let previewFails = false
    const rpcCall = async (method: string) => {
      if (method === 'sync.apply') {
        return { applied: [{ target: 'pi', backupDir: '/home/u/.pi/agent/backups/b', diff: { added: ['minimax/m'], removed: [], updated: [] } }], skipped: [] }
      }
      if (previewFails) throw new Error('预览读取失败')
      return previewValue()
    }
    const mod = await import('../../plugin-src/client/sync-models-section.js')

    const first = await settle(mod, { rpcCall })
    const syncButton = button(first, '同步')
    expect(syncButton).toBeTruthy()
    syncButton!.props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))

    // apply 成功后结果行里有「已写入」
    const afterApply = await settle(mod, { rpcCall })
    expect(afterApply.some(node => node.children.some(child => typeof child === 'string' && child.includes('已写入')))).toBe(true)

    // 现在让预览失败，点「刷新」
    previewFails = true
    const refreshButton = button(afterApply, '刷新')
    expect(refreshButton).toBeTruthy()
    refreshButton!.props.onClick()

    const afterFailure = await settle(mod, { rpcCall })
    // 错误文案必须出现
    expect(afterFailure.some(node => node.children.some(child => typeof child === 'string' && child.includes('预览读取失败')))).toBe(true)
    // ⚠️ 上一次的成功结果必须被清掉 —— 否则用户照着已失效的绿字去确认写入
    expect(
      afterFailure.some(node => node.children.some(child => typeof child === 'string' && child.includes('已写入'))),
      '预览失败后不许再显示上一次的「已写入」',
    ).toBe(false)
  })
})
