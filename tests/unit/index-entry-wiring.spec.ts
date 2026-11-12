/**
 * `plugin-src/client/index.js` 的**接线**行为守卫。
 *
 * ## 为什么需要它（原守卫零覆盖）
 *
 * 2026-10-24 对抗审计实测：把 `registerJetHubPanelEntries(ctx, rpcCall)` 改成
 * `void registerJetHubPanelEntries`（**删掉调用**）后——
 *
 * ```
 * [M9_index_drops_registration_call] 结果: passed=56 failed=0
 * $ npx vitest run  →  Tests  10600 passed | 7 skipped
 * ```
 *
 * **全量测试一条都不红**，而后果是：插件根本不注册任何面板 —— `main` 槽与
 * `settings.section` 都没有，界面里**没有 Jet Hub**（用户以为插件坏了）。
 *
 * 原因：`error-boundary.spec.ts` 只覆盖 `error-boundary.js`；
 * `panel-entry-wiring.spec.ts` 覆盖 `panel-entry.js` 的**内部**行为；
 * 而「上一层到底有没有调用注册器」**没有任何守卫** ——
 * 「接线层零守卫」这个本仓库已记录过的复发形态。
 *
 * ## 判据为什么是行为级
 *
 * `tests/unit/panel-entry.spec.ts` 里只有
 * `expect(source).toContain('export function registerJetHubPanelEntries')`
 * —— 它断言的是「**导出存在**」，与「**被调用**」是两件事。
 * ⇒ 本文件真 import `index.js`、用 mock 的注册器真跑一遍 `apply()`，
 * 直接断言「注册器被调用了、且拿到的是本插件自己的 `ctx` 与一份 rpcCall」。
 *
 * ## 替身的诚实边界
 *
 * 这里 mock 掉 `panel-entry.js`，所以**不**验证面板内部的注册逻辑
 * （那由 `panel-entry-wiring.spec.ts` 负责）。本文件只回答一个问题：
 * **`apply()` 有没有把注册器接上**。
 */
import { describe, expect, it, vi } from 'vitest'

/**
 * ⚠️ **必须 mock `react`**（2026-10-25 审计 A3-3 后新增的依赖链）。
 *
 * `index.js` 现在 import `error-boundary.js`（因为它给
 * `plugins.bundle.config` 与 `conversation.input.right` 两处槽位套了边界），
 * 而那个文件 `import * as React from 'react'`。本仓库 devDependencies **没有
 * react**（它是宿主注入的 external）⇒ 不 mock 就整份 spec 加载失败
 * （`Cannot find package 'react'`），一条用例都跑不了。
 *
 * 替身只需最小面：本文件不渲染任何组件，只关心 `apply()` 有没有接线。
 */
vi.mock('react', () => ({
  createElement: () => null,
  Component: class {},
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useRef: (v) => ({ current: v }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}))

// ── 注册器：本文件的被测对象是「有没有被调用」，故做成 spy ──
const registerSpy = vi.hoisted(() => vi.fn())

vi.mock('../../plugin-src/client/panel-entry.js', () => ({
  registerJetHubPanelEntries: registerSpy,
}))

vi.mock('../../plugin-src/client/settings-card.js', () => ({
  JetHubPanelEntryCard: function JetHubPanelEntryCard() { return null },
}))

vi.mock('../../plugin-src/client/usage-badge.js', () => ({
  UsageBadge: function UsageBadge() { return null },
}))

vi.mock('../../plugin-src/client/jet-hub-styles.js', () => ({
  installJetHubStyles: () => () => {},
}))

vi.mock('../../plugin-src/client/jet-hub.js', () => ({
  JET_HUB_RPC_CHANNEL: 'jet-hub',
  providerLabel: () => 'x',
  JetHubPage: function JetHubPage() { return null },
}))

vi.mock('../../plugin-src/client/zcode-carrier.js', () => ({
  // `ctx.effect` 会把返回值当清理函数，故返回一个函数。
  startCarrierContribution: () => () => {},
}))

vi.mock('../../plugin-src/management-rpc.mjs', () => ({
  callManagementRpc: async () => ({ ok: true }),
  unwrapRpcResult: (raw) => raw,
}))

const { apply } = await import('../../plugin-src/client/index.js')

/** 最小 `ctx`：只提供 `apply()` 真正会碰到的成员。 */
function makeCtx() {
  const effects = []
  const slotInjections = []
  /**
   * ⚠️ `inject` 的**回调**必须被记住（不能就地调用）：宿主只在**渲染该槽位时**
   * 才求值它，而 `register` 只会在那之后被调用。故这里存 `{slot, callback}`，
   * 由用例显式驱动 —— 与 `panel-entry-wiring.spec.ts` 同款。
   */
  const injections = []
  /** `slots.register(spec, Component)` 的登记记录（用来断言注册的是哪个组件）。 */
  const registrations = []
  /**
   * ⚠️ `ctx.inject([...], cb)` 的登记（服务级**软**注入，与上面的槽位注入不是一回事）。
   *
   * `registerJetHubLedgerTab`（右侧栏 Token 用量标签页）走的就是这条：它对
   * `sidebarRightTabs` 是**软依赖**（服务不在就整段跳过），故必须经由 `ctx.inject`
   * 而不是 `export const inject`（后者是硬依赖，缺服务的宿主上整条插件不激活）。
   *
   * ⚠️ 替身**默认不提供** `sidebarRightTabs` 服务（`services` 留空）：这样
   * 「服务缺席时优雅跳过」这条腿是被真实执行的，而不是靠注释声明。
   */
  const serviceInjections = []
  const services = {}
  return {
    effects,
    slotInjections,
    injections,
    registrations,
    serviceInjections,
    services,
    ctx: {
      connection: { send: async () => ({}) },
      effect(callback, name) {
        effects.push(name)
        // `ctx.effect` 会执行回调并把返回值当清理函数；这里如实执行。
        const stop = callback()
        return typeof stop === 'function' ? stop : () => {}
      },
      /**
       * 服务级软注入：把 `services` 里**有**的那几个交给回调，返回值当清理函数。
       * 缺的服务不会出现在 `scoped` 上 —— 与真 cordis 的 `ctx.inject` 语义一致。
       */
      inject(deps, callback) {
        serviceInjections.push({ deps, callback })
        const scoped = {}
        for (const dep of deps) {
          if (services[dep] !== undefined) scoped[dep] = services[dep]
        }
        const stop = callback(scoped)
        return typeof stop === 'function' ? stop : () => {}
      },
      slots: {
        inject(slot, callback) {
          slotInjections.push(slot)
          injections.push({ slot, callback })
          return () => {}
        },
        register(spec, component) {
          registrations.push({ slot: spec?.name, component })
          return () => {}
        },
      },
    },
  }
}

/** 取某几个槽位**真正被 register 的组件**（本文件断言边界包装的入口）。 */
function slotsRegisteredFor(harness, slots) {
  return harness.registrations.filter((r) => slots.includes(r.slot))
}

describe('index.js 接线（行为级）', () => {
  it('⚠️⚠️ apply() 必须真的调用 registerJetHubPanelEntries（挡住「接线断开」）', () => {
    registerSpy.mockClear()
    const { ctx } = makeCtx()
    apply(ctx)

    expect(
      registerSpy,
      'apply() 没有调用注册器 —— 插件不会注册任何面板（main / settings.section 都不存在，'
      + '界面里没有 Jet Hub），而**全量测试会全绿**（2026-10-24 对抗审计实测 10600 条零红）',
    ).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 传给注册器的是本插件自己的 ctx 与一份可用的 rpcCall', () => {
    registerSpy.mockClear()
    const { ctx } = makeCtx()
    apply(ctx)

    const call = registerSpy.mock.calls[0]
    expect(call, '注册器没被调用').toBeTruthy()
    const [passedCtx, passedRpcCall] = call
    expect(passedCtx, '注册器拿到的不是本插件的 ctx').toBe(ctx)
    expect(typeof passedRpcCall, '注册器没有拿到 rpcCall 函数').toBe('function')
  })

  /**
   * ★★ P2（2026-10-25 审计 A3-3）：**四处槽位都必须注册「包了边界」的组件**。
   *
   * 2026-10-22 之前只有 `panel-entry.js` 的两处（`main` / `settings.section`）
   * 包了边界，而本文件这两处（`plugins.bundle.config` 插件详情卡片、
   * `conversation.input.right` 用量徽标）注册的是**裸组件** ⇒ 任一处渲染期
   * 异常仍会整块消失。
   *
   * ## 判据为什么打在 `displayName` 上
   *
   * `withErrorBoundary` 会给边界类设 `displayName = withErrorBoundary(...)`
   * （见 `error-boundary.js`）。而 `slots.register(…, Component)` 的**第二个
   * 参数**就是被注册的组件 ⇒ 直接断言它的 `displayName` 含 `withErrorBoundary`。
   *
   * ⚠️ 这比「源码里有 `withErrorBoundary(`」强：后者在
   * `if (false) { … }` 死分支里照样命中（本仓库已复发多次）。
   * 这里断言的是**真正传给 `register` 的那个对象**。
   */
  it('★★ 两处裸组件槽位（插件详情卡片 / 用量徽标）也必须包错误边界', () => {
    const harness = makeCtx()
    apply(harness.ctx)
    // 驱动这两个槽位的 inject 回调（宿主渲染时才这么做）
    for (const { slot, callback } of harness.injections) {
      if (slot === 'plugins.bundle.config' || slot === 'conversation.input.right') callback()
    }

    const guarded = slotsRegisteredFor(harness, ['plugins.bundle.config', 'conversation.input.right'])
    expect(guarded, '这两个槽位没有被注册').toHaveLength(2)
    for (const { slot, component } of guarded) {
      expect(
        String(component?.displayName ?? component?.name ?? ''),
        `${slot} 注册的是裸组件 ⇒ 该槽位渲染期异常会让整块消失（应包 withErrorBoundary）`,
      ).toContain('withErrorBoundary')
    }
  })

  it('⚠️ 样式安装与载体贡献循环都已挂上（防止 effect 被整体删除）', () => {
    registerSpy.mockClear()
    const { ctx, effects } = makeCtx()
    apply(ctx)

    const joined = effects.join(' | ')
    expect(joined, '样式安装的 effect 不见了').toContain('install styles')
    expect(joined, '载体贡献循环的 effect 不见了').toContain('zcode')
  })
})
