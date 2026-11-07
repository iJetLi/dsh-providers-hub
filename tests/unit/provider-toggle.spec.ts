import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  groupProviders,
  nextProviderOrderAfterDrop,
  nextProviderOrderAfterGroupDrop,
  providerSwitchRows,
  providerSwitchState,
  providerToggleSummary,
  sortOpenProvidersByOrder,
  summarizeProviderToggle,
} from '../../plugin-src/client/provider-toggle.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')
const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

/** 最小供应商定义（只用到 id，与真实 PROVIDERS 的结构一致）。 */
const P = (id) => ({ id, label: id })

/**
 * 取 `ProviderSwitchPanel` 组件的整段源码（到 `JetHubPage` 之前）。
 *
 * 本仓库的单测环境里没有 react，组件无法渲染 —— 结构与类名只能做源码级断言，
 * 而**判定**（谁该禁用、为什么禁用、顺序怎么排）全部在 `provider-toggle.js` 里，
 * 由下面的真实用例覆盖。两者分工不同，不是拿字符串匹配凑数。
 */
function panelBody(): string {
  const start = source.indexOf('function ProviderSwitchPanel(')
  expect(start, '找不到 ProviderSwitchPanel 组件').toBeGreaterThan(-1)
  // ⚠️ 结束锚点取「下一个顶层组件声明」，**不能**硬编码 `JetHubPage`：
  // 在两者之间插入任何组件（如 GatewayPanel），硬编码的 slice 都会把别人的
  // 源码一并吞进来，于是「本弹窗恰好一个 label / checkbox」这类计数断言会
  // 假性失败（2026-10-02 加网关弹窗时实测）。
  const rest = source.slice(start)
  const offset = rest.slice(1).search(/^(?:export )?function /m)
  return offset === -1 ? rest : rest.slice(0, offset + 1)
}

/**
 * 取**窄屏（手机适配）那一段** media 查询的规则体。
 *
 * ⚠️ 为什么要切片而不是对全文断言：这片样式里 `flex-direction: column` 另有
 * 17 处（各面板与弹窗自身就是列方向），`width` 更到处都是 —— 对全文匹配
 * 「有没有 flex-direction: column」是**恒真**的，那种用例没有牙。
 *
 * ⚠️ 锚点用**注释标题**（`── 窄屏（手机`），不是 `.dim-jh-layout` 规则本身：
 * 后者在宽屏区出现一次、窄屏区又一次，按它切会把宽屏那份也吞进来，
 * 于是「窄屏里不得出现 228px」的反向断言会**恒假红**。
 *
 * ## ⚠️⚠️ 2026-10-20 审计整改：本 helper 原版有 3 处假绿
 *
 * 变异测试实测（变异后 154 条用例**全绿**）暴露的问题与修法：
 *
 * 1. **整段被 `/* *\/` 注释掉 ⇒ 全绿**；**media 条件改成 `max-width: 1px`
 *    （永不命中）或 `min-width: 720px`（笔误）⇒ 全绿**。
 *    ⇒ 修法：返回**已剥注释**的文本，并由调用方显式断言 media 条件。
 * 2. **空块时反向断言恒绿**。⇒ 锚点守卫保留，且正向断言先跑。
 *
 * ⚠️ 还有一条**不在本 helper 里**、但同源的假绿：原用例的
 * `toMatch(/\.dim-jh-rail \{[\s\S]*?width: auto/)` 的 `[\s\S]*?` 会**越过
 * 选择器的闭合花括号**，命中的是块内后面 `.dim-jh-provider { width: auto }`
 * 的字面量 ⇒ 删掉 rail 的 `width: auto` 全绿。⇒ 修法见调用方：改用
 * `[^}]*`（不跨花括号）做块内匹配。
 *
 * @returns 从窄屏注释标题起、到下一段注释标题前的**已剥注释**规则文本。
 */
function narrowScreenBlock(styles: string): string {
  const start = styles.indexOf('── 窄屏（手机')
  expect(start, '找不到窄屏主布局的注释标题（可能被改名或删除）').toBeGreaterThan(-1)
  // 结束锚点取「用量浮层那一段的注释标题」——它紧随其后，是**下一个**独立段落。
  const end = styles.indexOf('── 窄屏：用量浮层', start)
  expect(end, '找不到浮层窄屏段的注释标题（用于界定上一段的结束）').toBeGreaterThan(start)
  return stripCssComments(styles.slice(start, end))
}

/** 剥掉 CSS 注释：注释掉的规则不生效，文本断言不得把它当证据。 */
function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 取**某条 CSS 规则**在给定文本里的声明体（**不跨选择器**）。
 *
 * ⚠️⚠️ 这是审计实测的假绿根因：`/\.dim-jh-rail \{[\s\S]*?width: auto/` 的
 * `[\s\S]*?` 会一路吃到块内**后面**的 `.dim-jh-provider { width: auto }`，
 * 于是「rail 有没有 width: auto」这个判据**实际在测另一个选择器**。
 * 实测后果：删掉 rail 的 `width: auto` 后 154 条用例全绿，而 rail 真的退回
 * 228px、右面板可用宽度从 444px 掉到 216px（正是本 PR 要修的症状）。
 *
 * 判据用 `[^}]*`：CSS 声明体内部不会出现裸 `}`，故不会跨规则边界。
 *
 * @returns 该规则的声明体（不含选择器与花括号）；规则不存在时返回 null。
 */
function cssRuleBody(block: string, selector: string): string | null {
  // 选择器按字面量转义（本文件只用 `.dim-jh-*` 这类简单选择器）。
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(block)
  return match === null ? null : match[1]
}

describe('groupProviders（左侧分组）', () => {
  it('按 closed 分成两组，且保持传入顺序', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    const statuses = {
      a: { closed: false },
      b: { closed: true },
      c: { closed: false },
      d: { closed: true },
    }
    const { open, closed } = groupProviders(providers, statuses)
    expect(open.map(p => p.id)).toEqual(['a', 'c'])
    expect(closed.map(p => p.id)).toEqual(['b', 'd'])
  })

  it('组内顺序就是传入顺序，不重排（用户认知顺序必须稳定）', () => {
    const providers = [P('z'), P('a'), P('m')]
    const { open } = groupProviders(providers, {})
    expect(open.map(p => p.id)).toEqual(['z', 'a', 'm'])
  })

  it('状态缺失的供应商归入「已打开」（宁多勿少，避免一次失败看成全被关）', () => {
    const providers = [P('a'), P('b')]
    const { open, closed } = groupProviders(providers, { a: { closed: true } })
    expect(open.map(p => p.id)).toEqual(['b'])
    expect(closed.map(p => p.id)).toEqual(['a'])
  })

  it('closed 只认显式 true（与黑名单「非 true 即打开」的判据一致）', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: 1 }, b: { closed: 'true' }, c: { closed: undefined } }
    expect(groupProviders(providers, statuses).open.map(p => p.id)).toEqual(['a', 'b', 'c'])
    expect(groupProviders(providers, statuses).closed).toEqual([])
  })

  it('statuses 为 null / 非对象时不抛错，全部归入已打开', () => {
    const providers = [P('a'), P('b')]
    expect(groupProviders(providers, null).open).toHaveLength(2)
    expect(groupProviders(providers, null).closed).toHaveLength(0)
    expect(groupProviders(providers, 'bogus').open).toHaveLength(2)
  })

  it('providers 非数组时返回两个空组（不抛错）', () => {
    const { open, closed } = groupProviders(null, {})
    expect(open).toEqual([])
    expect(closed).toEqual([])
  })
})

describe('providerSwitchState（开关三形态）', () => {
  it('有模型且未全关 → 已打开（checked=true），可点击', () => {
    const s = providerSwitchState({ models: { total: 30, disabled: 13 }, closed: false })
    expect(s).toEqual({ checked: true, disabled: false, reason: null })
  })

  it('全部模型已关闭 → checked=false（开关呈关闭态），仍可点击以重新打开', () => {
    const s = providerSwitchState({ models: { total: 17, disabled: 17 }, closed: true })
    expect(s.checked).toBe(false)
    expect(s.disabled).toBe(false)
  })

  it('① 没有任何模型 → 禁用并给出原因（「不关闭模型就不关闭供应商」）', () => {
    const s = providerSwitchState({ models: { total: 0, disabled: 0 }, closed: false })
    expect(s.disabled).toBe(true)
    expect(s.checked).toBe(true)
    expect(s.reason).toContain('没有可关闭的模型')
  })

  /**
   * ★★ **「已关闭」必须永远可点开，即使 `total === 0`**（Gitee issue IKP8OF，真死锁）。
   *
   * ## 缺陷形态（真实可达）
   *
   * 用户关闭了某供应商，随后它的账号被全部删除 / 目录被清空 ⇒ `total` 变成 0，
   * 而 `closed` 仍为 `true`（关闭**意图**与目录快照无关，这正是 IKP8OF 的修复点）。
   * 若判据顺序是「先判 `total <= 0` ⇒ 禁用」，开关就变成**点不动的「已关闭」**：
   * 用户既关不掉也打不开，**没有任何出路**（只能手工编辑 `state.json`）。
   *
   * ## 为什么顺序必须反
   *
   * 「`total <= 0` ⇒ 禁用」的本意是「没有模型可关 ⇒ **关闭**动作会被服务端拒绝，
   * 别让用户白点」（见 `providerSwitchState` 的方法头）。它约束的是**关闭**方向；
   * 而已关闭时用户要做的恰恰是**打开**，那个方向永远合法
   *（`provider.setEnabled(true)` 不读目录、纯本地清黑名单 + 清意图）。
   */
  it('★★ 已关闭 + total 为 0 → 仍必须可点开（不得变成点不动的死开关）', () => {
    const s = providerSwitchState({ models: { total: 0, disabled: 0 }, closed: true })
    expect(s.disabled, '★★ 已关闭却禁用 ⇒ 用户永远打不开它（IKP8OF 的死锁）').toBe(false)
    expect(s.checked, '已关闭 ⇒ 勾选态必须是 false（点击即打开）').toBe(false)
    expect(s.reason).toBeNull()
  })

  it('② 状态未知（undefined）→ 禁用并说明原因', () => {
    const s = providerSwitchState(undefined)
    expect(s.disabled).toBe(true)
    expect(s.reason).toBeTruthy()
  })

  /**
   * ⚠️⚠️ 2026-11-05 三审 P1-2：**核实失败时不得让用户点**。
   *
   * `provider.status` 的 `closed` 在「目录没读完」与「远端读失败」两种情况下
   * **不是**从真实目录算的，都保守报 `false`。而前端只看到 `closed: false`
   * 与「用户确实打开着」**同形** ⇒ 设置页那行渲染成可点的普通状态，
   * 点下去才得到一句与现场无关的错误。
   *
   * 更糟的是**界面、开关、报错三者互相矛盾**：分组标题说「已关闭」
   *（意图为真）、开关显示「已打开」（`closed: false`）、点一下弹「核实不了」。
   * 加 `verifyFailed` 后三者终于自洽。
   */
  it('★★ 核实失败（verifyFailed 有值）→ 必须禁用并把原因展示出来', () => {
    const s = providerSwitchState({
      models: { total: 3, disabled: 1 },
      closed: false,
      verifyFailed: '令牌已过期',
    })
    expect(s.disabled, '★★ 核实不了却让用户点 ⇒ 服务端再核实一次、大概率还是失败').toBe(true)
    expect(s.reason, '必须把这次失败的原因展示出来，否则用户不知道为什么点不动').toContain('令牌已过期')
    expect(s.reason).toContain('暂时无法核实')
  })

  it('★ 反向对照：核实成功（verifyFailed 缺席）时仍必须可点', () => {
    const s = providerSwitchState({ models: { total: 3, disabled: 1 }, closed: false })
    expect(s.disabled, '没有 verifyFailed 就说明核实成功了，不得因此禁用').toBe(false)
    expect(s.reason).toBeNull()
  })

  /**
   * ⚠️ 顺序判据：`closed === true` **必须优先于** `verifyFailed`。
   *
   * 已关闭时用户要做的恰恰是**打开**，那个方向永远合法 ——
   * `provider.setEnabled(true)` 不读目录、纯本地清黑名单 + 清意图。
   * 若让 `verifyFailed` 抢先，就会出现「已关闭 + 核实失败 ⇒ 点不动的死开关」，
   * 正是 IKP8OF 那条死锁换了个入口复发。
   */
  it('★★ 已关闭 + 核实失败 → 仍必须可点开（打开方向不依赖目录）', () => {
    const s = providerSwitchState({
      models: { total: 3, disabled: 3 },
      closed: true,
      verifyFailed: '令牌已过期',
    })
    expect(s.disabled, '★★ 已关闭 + 核实失败却禁用 ⇒ 用户永远打不开它（IKP8OF 死锁复发）').toBe(false)
    expect(s.checked).toBe(false)
    expect(s.reason).toBeNull()
  })

  it('★ verifyFailed 是空串时视同缺席（不得渲染出空的「暂时无法核实：」）', () => {
    const s = providerSwitchState({ models: { total: 3, disabled: 1 }, closed: false, verifyFailed: '' })
    expect(s.disabled).toBe(false)
    expect(s.reason).toBeNull()
  })

  it('③ 状态非对象（异常输入）→ 禁用而不是抛错', () => {
    expect(providerSwitchState(null).disabled).toBe(true)
    expect(providerSwitchState('bogus').disabled).toBe(true)
  })

  it('models 字段缺失时视为 0 → 禁用（不误判为可操作）', () => {
    expect(providerSwitchState({ accounts: { total: 1 } }).disabled).toBe(true)
  })

  it('total 为负数等非法值 → 禁用（不给用户一个无效的操作入口）', () => {
    expect(providerSwitchState({ models: { total: -5 } }).disabled).toBe(true)
  })
})

describe('summarizeProviderToggle（结果文案）', () => {
  it('关闭：报告实际关闭的模型与停用的账号数', () => {
    expect(summarizeProviderToggle(false, { models: 17, accounts: 1 }))
      .toBe('已关闭 17 个模型，已停用 1 个账号')
  })

  it('打开：报告实际打开的模型与启用的账号数', () => {
    expect(summarizeProviderToggle(true, { models: 17, accounts: 2 }))
      .toBe('已打开 17 个模型，已启用 2 个账号')
  })

  it('⚠️ 变更数为 0 时不得谎报「已停用 N 个」（幂等操作要照实说）', () => {
    expect(summarizeProviderToggle(false, { models: 5, accounts: 0 }))
      .toBe('已关闭 5 个模型，没有账号需要停用')
  })

  it('两侧都为 0 时如实说明无事可做', () => {
    expect(summarizeProviderToggle(true, { models: 0, accounts: 0 }))
      .toBe('模型本就全部打开，账号本就全部启用')
  })

  it('res 缺失 / 字段非数字时不抛错，按 0 处理', () => {
    expect(summarizeProviderToggle(false, null)).toBe('没有模型需要关闭，没有账号需要停用')
    expect(summarizeProviderToggle(false, { models: 'x', accounts: null }))
      .toBe('没有模型需要关闭，没有账号需要停用')
  })
})

/**
 * 「供应商开关」弹窗的行数据。
 *
 * 弹窗要渲染的是「供应商定义 × 状态表」的拼接结果（顺序、勾选态、禁用态与原因、
 * 影响面计数），这些判定必须在纯逻辑层，不能留在渲染层 —— 否则左侧分组与弹窗
 * 两处各写一遍，迟早出现「左侧说它关了、弹窗里它还是开的」。
 */
describe('providerSwitchRows（弹窗行数据）', () => {
  it('⚠️ 已打开在前、已关闭在后，与左侧分组同一判据', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    const statuses = {
      a: { closed: false, models: { total: 3, disabled: 0 } },
      b: { closed: true, models: { total: 2, disabled: 2 } },
      c: { closed: false, models: { total: 1, disabled: 0 } },
      d: { closed: true, models: { total: 4, disabled: 4 } },
    }
    const rows = providerSwitchRows(providers, statuses)
    expect(rows.map(r => r.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(rows.map(r => r.checked)).toEqual([true, true, false, false])
  })

  it('每行带出影响面计数，供界面显示「模型 N（已关 M）· 账号 X（启用 Y）」', () => {
    const rows = providerSwitchRows([P('a')], {
      a: { closed: false, models: { total: 12, disabled: 3 }, accounts: { total: 5, enabled: 2 } },
    })
    expect(rows[0].models).toEqual({ total: 12, disabled: 3 })
    expect(rows[0].accounts).toEqual({ total: 5, enabled: 2 })
  })

  it('⚠️ 状态缺失时计数是 null 而不是 0（「不知道」与「确实是 0」必须能区分）', () => {
    const rows = providerSwitchRows([P('a')], {})
    expect(rows[0].models).toBeNull()
    expect(rows[0].accounts).toBeNull()
    expect(rows[0].disabled).toBe(true)
    expect(rows[0].reason).toBe('状态尚未读取')
  })

  it('没有可关闭模型的供应商被禁用并给出原因（服务端也会拒绝这个动作）', () => {
    const rows = providerSwitchRows([P('a')], { a: { models: { total: 0, disabled: 0 } } })
    expect(rows[0].disabled).toBe(true)
    expect(rows[0].reason).toBe('该供应商没有可关闭的模型')
    // 仍然显示为「打开」：未知/无事可做的东西不该被画成被关闭。
    expect(rows[0].checked).toBe(true)
  })

  it('label 缺失时回退到 id（界面上不会出现空行）', () => {
    const rows = providerSwitchRows([{ id: 'codearts' }], { codearts: { models: { total: 1 } } })
    expect(rows[0].label).toBe('codearts')
  })

  it('statuses 为 null / 非对象、providers 非数组时都不抛错', () => {
    expect(providerSwitchRows([P('a')], null).map(r => r.disabled)).toEqual([true])
    expect(providerSwitchRows([P('a')], 'bogus')[0].reason).toBe('状态尚未读取')
    expect(providerSwitchRows(null, {})).toEqual([])
  })

  it('⚠️ 与 groupProviders 的结论必须一致（两处判据不能漂移）', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: true, models: { total: 2 } }, b: { models: { total: 2 } } }
    const { open, closed } = groupProviders(providers, statuses)
    const rows = providerSwitchRows(providers, statuses)
    expect(rows.filter(r => r.checked).map(r => r.id)).toEqual(open.map(p => p.id))
    expect(rows.filter(r => !r.checked).map(r => r.id)).toEqual(closed.map(p => p.id))
  })
})

describe('providerToggleSummary（页头与弹窗的计数）', () => {
  it('给出 open / closed / total 与 known', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: true }, b: { closed: false }, c: { closed: true } }
    expect(providerToggleSummary(providers, statuses))
      .toEqual({ open: 1, closed: 2, total: 3, known: true })
  })

  it('⚠️ 状态没读回来时 known=false 且计数为 0 —— 界面据此**不显示**计数', () => {
    // 「已打开 0、已关闭 0」会被读成「一个供应商都没有」，而真实原因只是
    // provider.status 还没回来（或失败了）。
    expect(providerToggleSummary([P('a'), P('b')], null)).toEqual({
      open: 2, closed: 0, total: 2, known: false,
    })
    expect(providerToggleSummary([P('a')], undefined).known).toBe(false)
  })

  it('closed 只认显式 true（与分组、行数据三处同一口径）', () => {
    const providers = [P('a'), P('b')]
    const statuses = { a: { closed: 'true' }, b: { closed: 1 } }
    expect(providerToggleSummary(providers, statuses)).toMatchObject({ open: 2, closed: 0 })
  })

  it('providers 非数组时 total 为 0 且不抛错', () => {
    expect(providerToggleSummary(null, {})).toEqual({ open: 0, closed: 0, total: 0, known: true })
  })
})

describe('供应商开关的接线（源码级回归）', () => {
  it('引用了纯逻辑模块，而不是在本文件里另写一份判定', () => {
    expect(source).toContain("from './provider-toggle.js'")
    expect(source).toContain('groupProviders(')
    expect(source).toContain('providerSwitchRows(')
    expect(source).toContain('providerToggleSummary(')
  })

  it('rail 渲染出两个分组标题并带计数', () => {
    expect(source).toContain('dim-jh-railGroup')
    expect(source).toContain('dim-jh-railGroupTitle')
    expect(source).toContain('`已打开 (${open.length})`')
    expect(source).toContain('`已关闭 (${closed.length})`')
  })

  /**
   * ⚠️ **按钮顺序：新建账号必须排在「国际站分流」之前**
   * （2026-10-17 用户要求「minimax国际版的新建账号放在国际站分流之前」）。
   *
   * 理由：新建账号是**主操作**，分流设置是**排障用的次要入口**。
   * 次要项排在主操作前面，会让用户先看到「分流设置」而不是「怎么加账号」。
   *
   * ⚠️ 判据用**位置先后**而不是「字符串包含」——后者对顺序完全不敏感，
   * 把两个按钮调换位置它照样绿（本仓库记过「源码级断言必须锚定片段」）。
   *
   * ⚠️ 2026-10-26 起「新建账号」是**纯图标按钮**（文字收进 title/aria-label），
   *    源码里不再有 `+ 新建账号` 这个字面量 ⇒ 锚点换成它唯一的接线特征
   *    `newAccountAsksChannel(provider)` 的 onClick 判据。
   *    这里断言的是**两个片段在同一段 headerActions 里的先后**，不是整份源码
   *    里字符串谁先出现（`国际站分流设置` 在 title 文案里也出现过一次，
   *    用裸 indexOf 会取到错误的那个位置）。
   */
  it('★★ minimaxintl 面板里「+ 新建账号」排在「国际站分流设置」之前', () => {
    const newAccountAt = source.indexOf('if (newAccountAsksChannel(provider)) setPendingLogin(false)')
    const xffAt = source.indexOf("'国际站分流设置'")
    expect(newAccountAt, '找不到「+ 新建账号」的渲染点').toBeGreaterThan(-1)
    expect(xffAt, '找不到「国际站分流设置」的渲染点').toBeGreaterThan(-1)
    expect(
      newAccountAt,
      '「+ 新建账号」必须排在「国际站分流设置」之前（主操作在前、排障入口在后）',
    ).toBeLessThan(xffAt)
  })

  /**
   * ⚠️ 用户 2026-10-26 的两条要求合并成一条守卫：
   *   「新建账号按钮改为图标」+「模型按钮移动到新建账号左边改为图标+模型」。
   *
   * 顺序契约：**模型列表 → 新建账号 → 刷新积分**。
   * 三条都跟「本页有什么 / 怎么让本页变新」有关，挨在一起；而 minimaxintl 的
   * 「国际站分流设置」是排障入口，必须排在它们之后。
   *
   * ⚠️ 锚点必须选**唯一**的接线特征：
   *    - 模型列表：`aria-label': '模型列表'`（弹窗标题里也有「模型列表」三字，
   *      用裸文本会命中错的那个）；
   *    - 新建账号：`newAccountAsksChannel(provider)` 的 onClick 判据；
   *    - 刷新积分：`loadCredits(true)` 的 onClick。
   *    三者在 headerActions 里各只出现一次，位置比较才有意义。
   */
  it('★★ 模型列表（图标+文字）排在新建账号（图标）左边，两者都在刷新积分左边', () => {
    const modelAt = source.indexOf("'aria-label': '模型列表'")
    const newAt = source.indexOf('if (newAccountAsksChannel(provider)) setPendingLogin(false)')
    const refreshAt = source.indexOf('onClick: () => void loadCredits(true)')
    expect(modelAt, '找不到「模型列表」按钮').toBeGreaterThan(-1)
    expect(newAt, '找不到「新建账号」按钮').toBeGreaterThan(-1)
    expect(refreshAt, '找不到「刷新积分」按钮').toBeGreaterThan(-1)
    expect(modelAt, '「模型列表」必须排在「新建账号」左边').toBeLessThan(newAt)
    expect(newAt, '「新建账号」必须排在「刷新积分」左边').toBeLessThan(refreshAt)
  })

  /**
   * 两枚按钮的**形态**：模型列表 = 图标 + 文字（`dim-jh-iconTextBtn` 且子节点有
   * `'模型'` 文本）；新建账号 = 纯图标（`dim-jh-iconBtn` 且没有文字子节点）。
   *
   * ⚠️ 纯图标按钮必须自带 `aria-label` —— svg 是 aria-hidden，没有它读屏只会
   *    念「按钮」（与「删除」「刷新积分」两枚图标按钮同源教训）。
   * ⚠️ 必须**在切片里**断言，不能在整份源码里找：整份源码里 `dim-jh-iconBtn`
   *    有三处（删除 / 刷新积分 / 新建账号），改错地方不会变红。
   */
  it('★★ 模型列表是图标+文字、新建账号是纯图标，两者都有 aria-label', () => {
    const modelAt = source.indexOf("'aria-label': '模型列表'")
    const modelStart = source.lastIndexOf("React.createElement('button'", modelAt)
    // ⚠️ 切片必须**包住整个按钮表达式**（含 svg 子节点与文字子节点）——
    //    `aria-label` 在属性区，svg 在子节点区，只切到 aria-label 附近
    //    就取不到图标（第一版栽在这，报「必须带 svg 图标」假红）。
    const modelEnd = source.indexOf("'模型'),", modelAt)
    expect(modelEnd, '找不到「模型列表」按钮的文字子节点').toBeGreaterThan(modelAt)
    const modelBlock = source.slice(modelStart, modelEnd + 10)
    expect(modelBlock, '模型列表必须是图标+文字（dim-jh-iconTextBtn）')
      .toContain('dim-jh-iconTextBtn')
    expect(modelBlock, '模型列表必须带 svg 图标').toContain("createElement('svg'")
    expect(modelBlock, '模型列表的按钮文字必须还在（只有「模型」二字）').toContain("'模型'")

    const newAt = source.indexOf("'aria-label': creating ? '正在登录新账号' : '新建账号'")
    expect(newAt, '新建账号必须是纯图标按钮（aria-label 收动作）').toBeGreaterThan(-1)
    const newStart = source.lastIndexOf("React.createElement('button'", newAt)
    const newBlock = source.slice(newStart, newAt + 200)
    expect(newBlock, '新建账号必须带 dim-jh-iconBtn（纯图标，正方形）')
      .toContain('dim-jh-iconBtn')
    expect(newBlock, '新建账号不得再留文字子节点')
      .not.toMatch(/\}\s*,\s*'(?:\+ 新建账号|正在登录…)'\)/)
  })

  /**
   * 「永久积分」按钮：图标 + 固定文字，锁定/解锁只差图标形态与 `data-kind`。
   *
   * ⚠️ 2026-10-26 用户要求「解锁/锁定永久积分改为图标+永久积分」。
   *    这条守的是**四件缺一不可的事**（任何一件漏掉都是净损失）：
   *    ① 文字固定「永久积分」—— 不能再随状态切换（宽度会跳、且与图标重复）；
   *    ② `aria-label` 必须说动作 —— svg 是 aria-hidden，读屏只念「永久积分」等于
   *       没告诉用户点下去是锁还是解；
   *    ③ 两种状态必须画出**不同的**锁梁路径 —— 共用一条 path 时按钮长得一模一样，
   *       用户无从判断当前锁没锁；
   *    ④ 加载态要挂 `data-loading` —— 文字变成「处理中…」的同时图标也转圈，
   *       否则眼神在图标上的用户以为没点上。
   */
  it('★★ 「永久积分」是图标+固定文字，锁定/解锁靠图标与 aria-label 区分', () => {
    const at = source.indexOf("'aria-label': permanentLocked ? '解锁永久积分' : '锁定永久积分'")
    expect(at, '找不到「永久积分」按钮的 aria-label（动作必须可读）').toBeGreaterThan(-1)
    const start = source.lastIndexOf("React.createElement('button'", at)
    const end = source.indexOf("'永久积分')", at)
    expect(end, '找不到「永久积分」按钮的文字子节点').toBeGreaterThan(at)
    const block = source.slice(start, end + 10)

    expect(block, '必须是图标+文字形态（dim-jh-iconTextBtn）').toContain('dim-jh-iconTextBtn')
    expect(block, '必须带 svg 图标').toContain("createElement('svg'")
    expect(block, '锁体矩形必须画出来（两种状态共用）').toContain("createElement('rect'")
    expect(block, '按钮文字必须固定为「永久积分」').toContain("'永久积分')")
    expect(block, '加载态必须挂 data-loading（图标要转圈）').toContain("'data-loading': lockBusy ? 'true' : undefined")
    // 两种状态的锁梁必须是两条**不同**的 path
    expect(block, '锁定态锁梁（闭合挂锁）不见了')
      .toContain("createElement('path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' })")
    expect(block, '解锁态锁梁（开口挂锁）不见了')
      .toContain("createElement('path', { d: 'M7 11V7a5 5 0 0 1 9.9-1' })")
    // 反向钉子：文字不得再随状态切换。
    // ⚠️ 不能直接 not.toContain("permanentLocked ? '解锁永久积分' : '锁定永久积分'")
    //    —— aria-label 用的正是这个三元，那样写会打到它自己（第一版就栽在这）。
    //    正确的判据是**次数**：「解锁永久积分」在整个按钮里只允许出现一次
    //    （= aria-label 那一处）；文字子节点再长出一个三元就会变成两次。
    expect((block.match(/'解锁永久积分'/g) ?? []).length, '「解锁永久积分」只允许出现在 aria-label 里一次')
      .toBe(1)
    expect((block.match(/'锁定永久积分'/g) ?? []).length, '「锁定永久积分」只允许出现在 aria-label 里一次')
      .toBe(1)
    expect(block, '文字子节点必须是固定字面量，不得再包一层三元')
      .toMatch(/: '永久积分'\)/)
  })

  it('★★ 图标+文字按钮的加载态也必须转圈（iconTextBtn 那条选择器不能漏）', () => {
    // ⚠️ 断言必须带上 animation: dim-jh-spin —— 降级块里也有一条
    //    .dim-jh-iconTextBtn[data-loading="true"] svg，只断选择器名时
    //    删掉真正那条动画仍会命中降级块（变异验证里报过 NO-TEETH）。
    expect(styles, '只给 iconBtn 写动画时「永久积分」在加载态不会转')
      .toMatch(/\.dim-jh-iconTextBtn\[data-loading="true"\] svg\s*\{[^}]*animation:\s*dim-jh-spin/)
    // prefers-reduced-motion 的降级分支同样要覆盖两类按钮
    const reduced = styles.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0]
    expect(reduced, '找不到 prefers-reduced-motion 降级块').toBeDefined()
    expect(reduced, '降级块必须同时管住 iconTextBtn')
      .toMatch(/\.dim-jh-iconTextBtn\[data-loading="true"\] svg\s*\{[^}]*animation:\s*none/)
  })

  /**
   * ⚠️ 这条锁的是本次改动的**核心要求**：开关不得再挂在左侧供应商行尾。
   * 它曾与「选择要看哪个供应商」这个高频无害动作挤在同一行 —— 一个破坏性批量
   * 操作挂在导航栏上，既容易误点，也让窄栏长出了控件。
   */
  it('⚠️ 左侧供应商行里不再有开关（只剩一个 tab 按钮）', () => {
    const start = source.indexOf('const renderProviderRow = (p) => {')
    expect(start).toBeGreaterThan(-1)
    // ⚠️ 结束锚点必须是**紧接着的**下一个声明（renderRailIcon）：2026-11-05
    //    设置弹窗（renderSettingsPanel）也插在 renderRail 之前，而它里面有
    //    渠道原生搜索的 checkbox —— 用 renderRail 当锚点会把那一整段切进来，
    //    于是「不得有 input」这条恒红（切到别人的控件了）。
    const body = source.slice(start, source.indexOf('function renderRailIcon(kind)'))
    expect(body).not.toContain("React.createElement('input'")
    expect(body).not.toContain("type: 'checkbox'")
    expect(body).toContain("role: 'tab'")
    // 行容器仍不挂 onClick：点击只属于 tab 按钮。
    // ⚠️ 2026-11-06 起行容器是**三元表达式**（已关闭的供应商多一个
    //    `dim-jh-providerRowClosed` 类用于置灰），所以锚点不能带
    //    `className: ` 前缀 —— 但两态都必须落在同一个 `className` 上，
    //    否则「置灰」会变成给别的元素加类。
    expect(body).toContain("className: closed ? 'dim-jh-providerRow dim-jh-providerRowClosed' : 'dim-jh-providerRow'")
    expect(body).not.toMatch(/dim-jh-providerRow[^}]*onClick/)
    // 置灰必须由 `providerStatuses` 的 closed 驱动，不得自己算一套
    expect(body).toContain('const closed = providerStatuses?.[p.id]?.closed === true;')
  })

  it('开关搬进弹窗：页头按钮点开，关闭即不挂载', () => {
    // ⚠️ 按钮文字是「供应商」而不是「供应商开关」：页头要排成一排，
    // 5 个字会把「关闭」挤到第二行。完整语义由 tooltip 与弹窗标题承担。
    expect(source).toContain("}, '供应商')")
    expect(source).toContain('title: (providerSummary.known')
    expect(source).toContain('setShowProviderSwitches(true)')
    // ⚠️ 不跨行断言：源文件是 CRLF，含 `\n` 的字面量匹配不上。
    expect(source).toContain('? React.createElement(ProviderSwitchPanel')
    expect(source).toContain('onClose: () => setShowProviderSwitches(false)')
  })

  it('四个全屏弹窗互斥：打开自己之前必须先关掉其它', () => {
    // 四个都是 position:fixed 的全屏覆盖层，同时打开会叠在一起，
    // 而 ESC / 遮罩只关掉**后挂载**的那个 —— 剩下关不掉的弹窗挡住整个设置页。
    //
    // ⚠️ 2026-11-05 侧边栏重构后承重的互斥点在 `openSettings` 里：设置弹窗在
    //    组件树里**最后**挂载（见 return 末尾的注释），所以凡是从别处进设置，
    //    都必须先把另外三个关掉 —— 否则设置弹窗被它自己盖住。
    const openBody = source.slice(
      source.indexOf('const openSettings = () => {'),
      source.indexOf('/** 开关自动签到'),
    )
    expect(openBody, '找不到 openSettings 的函数体').not.toBe('')
    expect(openBody, '打开设置时必须关掉「供应商开关」弹窗').toContain('setShowProviderSwitches(false)')
    expect(openBody, '打开设置时必须关掉「网关」弹窗').toContain('setShowGateway(false)')
    expect(openBody, '打开设置时必须关掉「用量」弹窗').toContain('setShowTokenLedger(false)')

    // 设置弹窗内的「供应商」入口是**唯一**能从设置里跳到另一个全屏弹窗的路径
    // （网关/用量两个按钮在侧边栏，被设置弹窗的遮罩挡着），所以它要关掉剩下两个。
    const supplierStart = source.indexOf("}, '打开供应商开关')")
    expect(supplierStart).toBeGreaterThan(-1)
    const supplierBody = source.slice(source.lastIndexOf('onClick: () => {', supplierStart), supplierStart)
    expect(supplierBody, '「供应商」入口必须先关掉「网关」').toContain('setShowGateway(false)')
    expect(supplierBody, '「供应商」入口必须先关掉「用量」').toContain('setShowTokenLedger(false)')
    expect(supplierBody, '「供应商」入口必须走 closeSettings（关设置即保存定时签到）')
      .toContain('closeSettings(')
  })

  it('弹窗行是 <label> + **恰好一个** checkbox（第二个会让「点行名」激活错控件）', () => {
    const body = panelBody()
    expect(body.match(/React\.createElement\('label'/g) ?? []).toHaveLength(1)
    expect(body.match(/type: 'checkbox'/g) ?? []).toHaveLength(1)
    expect(body).toContain("role: 'switch'")
    expect(body).toContain('checked: row.checked')
    expect(body).toContain('disabled: row.disabled || busy')
  })

  it('弹窗复用模型列表那套结构与类名，不另起一套', () => {
    const body = panelBody()
    for (const cls of [
      'dim-jh-modalOverlay', 'dim-jh-modalHead', 'dim-jh-modalHint',
      'dim-jh-modalBody', 'dim-jh-modelList', 'dim-jh-modelRow',
      'dim-jh-modelInfo', 'dim-jh-modelName', 'dim-jh-modelId', 'dim-jh-switch',
    ]) {
      expect(body, `弹窗缺少与模型列表共用的类名 ${cls}`).toContain(cls)
    }
    // ESC 关闭挂在 document 上：焦点可能落在任意一个开关上。
    expect(body).toContain("document.addEventListener('keydown', onKeyDown)")
  })

  it('已关闭的行整行淡出（data-disabled 表达「已关闭」，点不动才用 input disabled）', () => {
    expect(panelBody()).toContain("'data-disabled': row.checked ? 'false' : 'true'")
  })

  it('状态没读回来时不显示计数，也不谎报「已打开 0」', () => {
    expect(source).toContain('providerSummary.known')
    const body = panelBody()
    expect(body).toContain('summary.known')
    expect(body).toContain('statusFailed ?')
  })

  it('状态未就绪时退化为不分组平铺（不阻断账号管理）', () => {
    expect(source).toContain('if (providerStatuses === null)')
  })

  it('关闭前必须确认，且文案给出影响面', () => {
    expect(source).toContain('确认关闭「${label}」？')
    expect(source).toContain('取消则不做任何变更')
  })

  /**
   * ⚠️⚠️ **切换模型后必须重拉汇总状态**（2026-11-07 十一审 P3）。
   *
   * `setStates` 只更新**本屏的模型列表**，而「已关闭」的分组标题与开关读的是
   * `providerStatuses`（服务端的派生判据 `disabled === total`）⇒ 不重拉的话，
   * 用户逐条关光全部模型后开关仍显示「已打开」、左侧分组也不动，
   * **要重挂载面板才看到变化**（没有任何报错，属静默失效）。
   *
   * ⚠️ 这两条是**接线判据**（漏一行就失效的那种），行为判据见挂载点那条。
   */
  it('★★ toggleModel 成功后必须重拉汇总状态', () => {
    // ⚠️ 本文件里有两个 `toggleModel`：`ModelListPanel`（账号管理里的模型列表弹窗）
    // 与 `ModelCenterPanel`（供应商开关弹窗里的模型列表屏）。**只有后者需要**重拉
    // —— 前者关掉弹窗后会重挂载、挂载时本来就会拉一次；后者是常驻的整屏视图。
    // ⇒ 锚点必须带 `(providerId, ` 前缀，否则切到第一个（第一版就这么翻了）。
    const start = source.indexOf('const toggleModel = async (providerId, modelId, disabled) =>')
    expect(start, '找不到 ModelCenterPanel 的 toggleModel（可能被改名或改签名）').toBeGreaterThan(-1)
    const end = source.indexOf('const restoreModel = async', start)
    expect(end, '找不到 restoreModel（用于界定 toggleModel 的结束）').toBeGreaterThan(start)
    const body = source.slice(start, end)
    expect(body, 'toggleModel 里必须调 onStatusReload').toContain('void onStatusReload?.()')
  })

  it('★★ setProviderAll 成功后必须重拉汇总状态', () => {
    const start = source.indexOf('const setProviderAll = async')
    expect(start, '找不到 setProviderAll（可能被改名）').toBeGreaterThan(-1)
    const end = source.indexOf('const loadAll = async', start)
    expect(end, '找不到 loadAll（用于界定 setProviderAll 的结束）').toBeGreaterThan(start)
    const body = source.slice(start, end)
    expect(body, 'setProviderAll 里必须调 onStatusReload').toContain('void onStatusReload?.()')
  })

  /**
   * ⚠️ 上一批「未声明变量」事故（四审 P0）的教训：**prop 少传一层就静默失效**，
   * 而 TypeScript 对 JSX/CreateElement 的 props 不做检查。这里把整条链路
   * 三层（JetHubPage → ProviderSwitchPanel → ModelCenterPanel）都钉住。
   */
  it('★★ onStatusReload 必须三层逐层透传（少一层就静默失效）', () => {
    // ① 页面层把回调交给 ProviderSwitchPanel
    expect(source).toContain('onStatusReload: loadProviderStatuses')
    // ② ProviderSwitchPanel 把它交给 ModelCenterPanel
    expect(source).toContain(
      'React.createElement(ModelCenterPanel, { providers, rpcCall, statuses, onStatusReload })',
    )
    // ③ 两个组件都解构出了这个 prop
    expect(source).toContain('function ProviderSwitchPanel({ providers, statuses, statusFailed, busyIds, onToggle, onReload, onClose, order, onCommitOrder, reordering, notice, rpcCall, onStatusReload })')
    expect(source).toContain('function ModelCenterPanel({ providers, rpcCall, statuses, onStatusReload })')
  })
})

describe('供应商开关的样式约束（源码级回归）', () => {
  /**
   * ⚠️ 这条锁的是用户报障「去掉开关后右边有片空白」。
   *
   * !25 时代这里是 `minmax(0, 1fr) auto` 两列（第二列放行尾开关）。开关搬到弹窗后，
   * 那列虽然 0 宽，**8px 的列间距却照样计入** —— 卡片右侧就多出一条看着像
   * 「rail 没铺满」的空白。所以这里断言「只有一列」，而不是「首列是 1fr」。
   * 首列仍必须是 `minmax(0, 1fr)`（不能是裸 `1fr`）：grid 项 min-width 默认 auto，
   * 长供应商名会把行撑宽、撑出 rail。
   */
  it('⚠️ .dim-jh-providerRow 只有**一列**（开关搬走后不得留下空列与列间距）', () => {
    expect(styles).toMatch(/\.dim-jh-providerRow \{[^}]*grid-template-columns: minmax\(0, 1fr\);/)
    expect(styles).not.toMatch(/\.dim-jh-providerRow \{[^}]*grid-template-columns:[^;]*auto/)
  })

  it('.dim-jh-providerRow 内的 .dim-jh-provider 允许收缩（min-width: 0）', () => {
    expect(styles).toMatch(/\.dim-jh-providerRow \.dim-jh-provider \{[^}]*min-width: 0/)
  })

  /**
   * 228px 是「给右侧让位」与「最长行不出省略号」的交点（用户先要收窄、
   * 随后报障「workbuddy国际版有省略号」—— 两个诉求在这条宽度上才同时成立）：
   * 可用文字宽 = 228 − 12(rail padding) − 2(边框) − 20(按钮 padding) − 30(图标)
   *                  − 8(图标间距) − 15(滚动条) = **143px**
   * 最长行 WorkBuddy (国际版) 实测要 141px（!25 实测表：200px + 开关时标签剩 77px、
   * 该行超宽 64px ⇒ 77 + 64 = 141）。
   * ⚠️ 再往回收就会截断；要更窄只能改短 label，而那会与 RaccoonProduct 等
   * displayName 的跨文件一致性断言冲突（见 raccoon-client-panel.spec.ts）。
   */
  it('rail 228px：省出开关那 8px 空列后，仍刚好不截断最长行', () => {
    expect(styles).toMatch(/\.dim-jh-rail \{ width: 228px;/)
    // 图标间距与按钮 padding 各收窄 2px 是「用开销换文字宽度」的一部分，别改回去。
    expect(styles).toMatch(/\.dim-jh-provider \{[^}]*gap: 8px; padding: 8px 10px/)
  })

  /**
   * ⚠️⚠️ 窄屏（手机 / 远程访问）主布局必须有适配（报障 2026-10-17，附窄屏截图）。
   *
   * ## 缺陷形态
   *
   * 主布局 `.dim-jh-layout` 是**写死的左右两栏**、`.dim-jh-rail` 固定 228px，
   * 而文件里原有的 3 处 media 查询**只覆盖弹窗内部**（Token 用量表格、用量徽标），
   * 一条都没管主布局。窄屏宽度约 400px 时右面板只剩约 76px：
   *
   * ```
   * 400 − 228(rail) − 24×2(宿主 SettingsRoot) − 24×2(面板 padding) ≈ 76px
   * ```
   *
   * 症状是右面板被压成一条窄缝、操作按钮被裁断、中文提示逐字竖排
   * （截图里「一键领取积分 / 重测所有 / 重置所有」只剩右端露出来）。
   *
   * ## 修法与其边界
   *
   * 窄屏改为**上下两段**：左栏降级为顶部**横向可滑动**的标签条，右面板获整宽。
   * 三条判据缺一不可，故逐条点名：
   * - `flex-direction: column` —— 两栏改两段（只改方向，不动 rail 的 228px 基准，
   *   故上面那条 228px 断言在宽屏下仍然成立）；
   * - `overflow-x: auto` —— 标签条必须能横向滑动，否则供应商多了会撑破屏幕；
   * - `display: contents` —— 分组外壳（railGroup）在横排下必须展平，
   *   否则每个分组各占一整行（竖排退回）。
   *
   * ⚠️ 断言必须锚在**窄屏块内部**，不能对全文匹配：`flex-direction: column`
   * 在文件里另有 17 处（各面板/弹窗自身），对全文断言会**恒真**（假绿）。
   */
  it('⚠️ 窄屏主布局：rail 降级为顶部横滑标签条 + 分组展平（用户报障 2026-10-17）', () => {
    const block = narrowScreenBlock(styles)

    // ⓪ 媒体条件必须真的生效 —— 审计实测的假绿之一：把条件改成
    //    `max-width: 1px`（永不命中）或 `min-width: 720px`（笔误）时原用例全绿。
    expect(block, '窄屏主布局块必须用 max-width 断点').toMatch(/@media \(max-width: 720px\)/)
    // ⚠️ 只拒绝「带 px 的 min-width」：那才是把断点写反（min-width: 720px
    //    意思是「宽于 720 才生效」，窄屏反而永远不命中）。而
    //    `min-width: 0` 是合法的 flex 收缩写法（.dim-jh-railScroll 用它
    //    防止横向条被内容撑开），2026-11-05 侧边栏重构后新增。
    expect(block, '断点不得被写成 min-width（那会让「窄屏」变成「宽屏」）')
      .not.toMatch(/min-width:\s*\d+px/)

    // ① 两栏改两段。
    const layout = cssRuleBody(block, '.dim-jh-layout')
    expect(layout, '窄屏块里必须有 .dim-jh-layout 规则').not.toBeNull()
    expect(layout, '.dim-jh-layout 必须切到列方向（两栏改两段）').toMatch(/flex-direction: column/)

    // ② rail 降级为横向标签条 —— 每条腿都用**块内匹配**（[^}]*），
    //    不能用 [\s\S]*?（那会跨到后面的 .dim-jh-provider 去，见 helper 注释）。
    const rail = cssRuleBody(block, '.dim-jh-rail')
    expect(rail, '窄屏块里必须有 .dim-jh-rail 规则').not.toBeNull()
    expect(rail, '标签条必须是横向 flex（否则退回基础规则的 grid 竖排）').toMatch(/display: flex/)
    expect(rail, '标签条必须显式 flex-direction: row').toMatch(/flex-direction: row/)
    // ⚠️ 2026-11-05 侧边栏重构：滚动**从外层挪到了内层**。
    //    外层（.dim-jh-rail）必须 overflow: hidden —— 它同时装着底部操作行，
    //    给它加 overflow-x: auto 会让操作行跟着开关列表一起滚走，用户必须
    //    滚到最右才看得到「设置」。
    expect(rail, '外层不得滚动（否则底部操作行跟着滚走）').toMatch(/overflow: hidden/)
    const scroll = cssRuleBody(block, '.dim-jh-railScroll')
    expect(scroll, '窄屏块里必须有 .dim-jh-railScroll 规则').not.toBeNull()
    expect(scroll, '标签条必须可横向滑动，否则供应商一多就撑破屏幕').toMatch(/overflow-x: auto/)
    // ③ 分组外壳展平。
    const group = cssRuleBody(block, '.dim-jh-railGroup')
    expect(group, '窄屏块里必须有 .dim-jh-railGroup 规则').not.toBeNull()
    expect(group, 'railGroup 必须 display: contents，否则分组各占一整行').toMatch(/display: contents/)
    // 竖排退回的反向断言：分组标题在横排标签条里必须隐藏。
    const title = cssRuleBody(block, '.dim-jh-railGroupTitle')
    expect(title, '窄屏块里必须有 .dim-jh-railGroupTitle 规则').not.toBeNull()
    expect(title).toMatch(/display: none/)
  })

  /**
   * ⚠️ 窄屏块**不得复活**那条 rail 固定宽度：它只该在宽屏生效。
   *
   * 反向断言的理由：228px 在窄屏是缺陷的**组成部分**（正是它把右面板压到 76px）。
   * 若有人「为省事」把 `width: auto` 删掉，窄屏会重新退回固定 228px 的窄缝，
   * 而宽屏的 228px 断言依然全绿 —— 那种回归只有本用例看得见。
   *
   * ⚠️ 判据用「窄屏块内不得出现 width: 228px」而不是「全文不得出现」：
   * 宽屏那条规则**必须**保留（上面已逐个锁住）。
   *
   * ## ⚠️⚠️ 2026-10-20 审计整改
   *
   * 原用例的**两条断言都是假绿**，实测（变异后 154 条全绿）：
   * - `toMatch(/\.dim-jh-rail \{[\s\S]*?width: auto/)` 的 `[\s\S]*?` 会跨到块内
   *   后面的 `.dim-jh-provider { width: auto }` ⇒ **删掉 rail 的 `width: auto`
   *   全绿**（而 rail 真的退回 228px、右面板从 444px 掉到 216px）。
   * - `not.toMatch(/width: 228px/)` 只认「带空格的 `width: 228px`」这一种字面
   *   ⇒ 写成 `width:228px`（无空格）或 `flex: 0 0 228px` 都能绕过。
   * ⇒ 修法：正向用 {@link cssRuleBody} 做块内取值；反向**同时**排掉
   *   固定宽度的三种常见写法。
   */
  it('⚠️ 窄屏块内不得把 rail 写回固定宽度（228px 只属于宽屏）', () => {
    const block = narrowScreenBlock(styles)
    const rail = cssRuleBody(block, '.dim-jh-rail')
    expect(rail, '窄屏块里必须有 .dim-jh-rail 规则').not.toBeNull()

    // 正向：必须显式 width: auto（才能盖掉基础规则的 228px）。
    expect(rail, '窄屏 rail 必须 width: auto 覆盖基础规则的 228px').toMatch(/width:\s*auto/)

    // 反向：三种把宽度写死的形态都要排掉（空格、无空格、flex 简写）。
    expect(rail, '不得写 width: 228px（含无空格写法）').not.toMatch(/width:\s*228px/)
    expect(rail, '不得用 flex 简写写死宽度（flex: 0 0 228px）').not.toMatch(/flex:\s*0\s+0\s+\d+px/)
    expect(rail, '不得用 flex-basis 写死宽度').not.toMatch(/flex-basis:\s*\d+px/)
  })

  /**
   * ⚠️⚠️ **「靠源顺序覆盖」这个前提本身必须有守卫**（2026-10-20 审计新增）。
   *
   * 窄屏块能盖掉基础规则，靠的是**同特异性 + 源顺序在后**（CSS 层没有别的机制）。
   * 审计实测：把基础 `.dim-jh-rail { width: 228px; … }` 规则挪到窄屏 media
   * **之后** ⇒ 窄屏覆盖完全失效（rail 退回 228px + `display: grid` 竖排），
   * 而当时 4 条用例**全绿** —— 这个前提写进了注释却没有任何断言守着。
   *
   * ⚠️ 判据只对 `.dim-jh-rail` 成立，**不要**对 `.dim-jh-layout` 照搬：
   * 基础 `.dim-jh-layout { display:flex; flex:1; overflow:hidden }` 里**没有**
   * `flex-direction`，与窄屏声明**属性不重叠** ⇒ 把它挪后不影响几何
   * （审计初稿曾把它也算作缺陷，实测几何不变，已订正）。
   */
  it('⚠️ 窄屏 media 块必须排在基础 .dim-jh-rail 规则之后（源顺序是覆盖的唯一依据）', () => {
    const baseRailIndex = styles.indexOf('.dim-jh-rail { width: 228px;')
    expect(baseRailIndex, '找不到基础 .dim-jh-rail 规则（228px）').toBeGreaterThan(-1)
    const narrowIndex = styles.indexOf('── 窄屏（手机')
    expect(narrowIndex, '找不到窄屏块注释标题').toBeGreaterThan(-1)
    const narrowMediaIndex = styles.indexOf('@media (max-width: 720px)', narrowIndex)
    expect(narrowMediaIndex, '找不到窄屏 media 块').toBeGreaterThan(-1)
    expect(
      narrowMediaIndex,
      '窄屏 media 块必须排在基础 .dim-jh-rail 规则**之后**：两者特异性相同，'
      + '靠源顺序后者胜出。挪到前面会让窄屏的 width:auto 完全失效（rail 退回 228px）',
    ).toBeGreaterThan(baseRailIndex)
  })

  it('弹窗里的开关保持 flex: none（目标控件不参与收缩）', () => {
    expect(styles).toMatch(/\.dim-jh-switch \{[^}]*flex: none/)
  })

  /**
   * ⚠️ 页头按钮必须排成一排（用户报障：加了开关入口之后「关闭」掉到第二行）。
   * 两处配合缺一不可：brand 让出宽度、按钮组不参与收缩。
   */
  it('页头按钮排成一排：按钮组独占整行 + 极窄窗口仍换行', () => {
    // ⚠️ 左侧标题块（.dim-jh-brand）已于 2026-10-07 删除，按钮组改为 flex: 1
    // 独占整行（原先靠 brand 让出宽度 + flex: none 不收缩）。
    expect(styles).toMatch(/\.dim-jh-headerActions \{[^}]*flex: 1 1 auto/)
    // 极窄窗口的兜底仍在：换行好过溢出到窗口外点不到。
    expect(styles).toMatch(/\.dim-jh-headerActions \{[^}]*flex-wrap: wrap/)
  })

  /**
   * ⚠️ 2026-10-26 用户要求「将按钮行合并到文案行最右侧」。
   * 这是**结构**改动（排序提示从 accountList 挪进 panelHead），不是纯样式：
   * 两者不同父级时 CSS 无论如何排不到同一行。
   */
  describe('★ 页头：排序提示与按钮组合并成一行', () => {
    const panelHead = (() => {
      const start = source.indexOf("React.createElement('div', { className: 'dim-jh-panelHead' }")
      expect(start, '找不到 panelHead 容器').toBeGreaterThan(-1)
      // panelHead 内只有标题/提示/按钮组三个子项，到按钮组开标签之后即可
      const actions = source.indexOf("className: 'dim-jh-headerActions'", start)
      expect(actions, 'panelHead 内找不到 headerActions').toBeGreaterThan(start)
      return source.slice(start, actions)
    })()

    it('★★ 排序提示必须在 panelHead 内（不是 accountList 内）', () => {
      // ⚠️ 必须断言**带引号的完整 className**：只断言裸类名 'dim-jh-orderHint'
      //    时，把它改成 'dim-jh-orderHint-moved' 仍然命中（子串），变异验证会
      //    判成 NO-TEETH。加引号后改名立刻变红。
      expect(panelHead, '排序提示搬出 panelHead 会立刻变回三行')
        .toContain("className: 'dim-jh-orderHint'")
      // 反向钉子：accountList 那一侧不得再有它
      const listStart = source.indexOf("className: 'dim-jh-accountList'")
      expect(listStart, '找不到 accountList').toBeGreaterThan(-1)
      const listEnd = source.indexOf("className: 'dim-jh-orderHint'", listStart)
      expect(listEnd, '排序提示又跑回 accountList 了').toBe(-1)
    })

    it('★★ 提示必须排在按钮组**之前**（否则按钮组会被顶到左边）', () => {
      // ⚠️ 用绝对位置比较，不要在 panelHead 切片里找按钮组：
      //    切片**止于**按钮组开标签，它本身不在切片内（第一版就栽在这）。
      const headStart = source.indexOf("React.createElement('div', { className: 'dim-jh-panelHead' }")
      const hint = source.indexOf('dim-jh-orderHint', headStart)
      const actions = source.indexOf("className: 'dim-jh-headerActions'", headStart)
      expect(hint, '排序提示不见了').toBeGreaterThan(headStart)
      expect(actions, '按钮组不见了').toBeGreaterThan(headStart)
      expect(hint, '排序提示必须在前，按钮组才贴右').toBeLessThan(actions)
    })

    it('★ 提示的渲染条件仍是「两个以上账号」', () => {
      // ⚠️ 必须在 panelHead 切片里断言，不能用整份源码 —— 该条件在文件里
      //    另有一处（:2518 的 Token 用量分支），整份匹配时改这处不会变红。
      expect(panelHead, '提示的显示条件被放宽了').toContain('accounts.length > 1')
      expect(panelHead, '提示不能再加 >= 1 的口子').not.toContain('accounts.length >= 1')
    })

    it('★★ 样式侧：panelHead 必须换行 + 标题行独占整行', () => {
      expect(styles, 'panelHead 不换行时四项会挤在一行').toMatch(/\.dim-jh-panelHead \{[^}]*flex-wrap: wrap/)
      // 2026-11-06：「供应商开关」图标进标题行后，标题 + 图标包了一层
      //   `.dim-jh-panelTitleRow`（**它**才是 panelHead 的 `flex: 1 0 100%` 子项）。
      //   ⚠️ 不能直接给标题 `flex: 1 1 auto` —— 那样标题 + 图标 + 按钮组
      //   会在宽屏下挤成一行（1400px 有约 930px 富余，wrap 不触发），
      //   2026-10-26 的「标题独占一整行」需求当场破掉。
      expect(styles, '标题行不占整行会与提示挤在同一行')
        .toMatch(/\.dim-jh-panelHead > \.dim-jh-panelTitleRow \{[^}]*flex: 1 0 100%/)
      expect(styles, '标题行必须是 flex 行容器（否则图标掉到标题下面）')
        .toMatch(/\.dim-jh-panelHead > \.dim-jh-panelTitleRow \{[^}]*display: flex/)
      // ⚠️ 标题自己必须是 `flex: 1 1 auto` + `min-width: 0`：
      //   前者把剩余空间吃掉（把图标顶到最右），后者防长 provider 名
      //   （如「MagiCrew (国际版) 账号管理」）把图标挤出可视区。
      expect(styles, '标题必须吃满剩余空间并把图标顶到最右')
        .toMatch(/\.dim-jh-panelTitleRow > \.dim-jh-panelTitle \{[^}]*flex: 1 1 auto/)
      expect(styles, '标题必须允许收缩（否则长名字把图标挤出可视区）')
        .toMatch(/\.dim-jh-panelTitleRow > \.dim-jh-panelTitle \{[^}]*min-width: 0/)
      // ⚠️ 账号列表已于 2026-10-26 挪出 panelHead（它现在是 .dim-jh-accountSection
      //    的子项、并且是滚动容器），所以「列表占整行」不再由 flex-basis: 100% 表达，
      //    改由 accountSection 那条规则守（见下面「只滚账号列表」那组用例）。
      //    这里只钉住它**不许**再回到 flex-basis: 100% —— 纵向主轴下那等于
      //    「高度取满且不许收缩」，内容一多就把滚动条推回 .dim-jh-panel。
      expect(styles, '账号列表不许回 flex-basis: 100%（纵向主轴下会让页头跟着滚）')
        .not.toMatch(/\.dim-jh-accountList \{[^}]*flex: 1 0 100%/)
    })

    it('★★ 账号管理页头的按钮组贴右：父级选择器里 margin-left: auto 与 flex-end 两条都在', () => {
      // 提示为 null 时（账号 ≤ 1）本组独占一行，此时只有 flex-end 能把它推到右边；
      // 提示存在时只有 margin-left: auto 能把它顶到最右。缺一条就有一种状态贴左。
      // ⚠️ 必须断言**带父级前缀**的选择器：基础 .dim-jh-headerActions 是
      //    全局页头与账号页头共用的，贴右只能写在 .dim-jh-panelHead > 下。
      expect(styles).toMatch(/\.dim-jh-panelHead > \.dim-jh-headerActions \{[^}]*margin-left: auto/)
      expect(styles).toMatch(/\.dim-jh-panelHead > \.dim-jh-headerActions \{[^}]*justify-content: flex-end/)
    })

    it('★★ 基础 .dim-jh-headerActions 必须保持居中（全局页头用它）', () => {
      // 用户 2026-10-26 报障：把基础规则改成 flex-end 后，全局页头那排
      // （供应商 / 一键签到 / 备份 / 恢复 / 网关 / Token 用量 / 渠道原生搜索）
      // 也一起贴到了最右。共用类名改默认值会波及另一处。
      const base = styles.match(/\.dim-jh-headerActions \{[^}]*\}/)?.[0]
      expect(base, '找不到基础 .dim-jh-headerActions 规则').toBeDefined()
      expect(base, '基础规则必须居中').toMatch(/justify-content: center/)
      expect(base, '基础规则不得带 margin-left: auto（那会把它顶到最右）')
        .not.toMatch(/margin-left: auto/)
      // 反向钉子：全局页头那一组必须是基础规则直接命中，不能被 panelHead 那条误伤。
      // ⚠️ 2026-11-05 侧边栏重构后**全局页头整个删掉了**（四个按钮搬进侧边栏
      //    底部操作行），所以这里改成「不得再有页头」—— 若哪天有人把页头加
      //    回来，这条会红，提醒他同时检查「共用类名改默认值会波及另一处」。
      expect(source, '全局页头已删除（按钮搬进侧边栏底部操作行）')
        .not.toContain("className: 'dim-jh-header'")
    })

    it('★ 提示自身必须能收缩（否则长文案把按钮组挤出容器）', () => {
      // ⚠️ 2026-10-26「文案改为一行显示」后基准宽从 1 1 0 改成 0 1 auto：
      //    1 1 0 的基准是 0，nowrap 下浏览器仍按 min-content 撑开，结果是
      //    「要么整行、要么溢出」；0 1 auto 才真正可收缩。
      expect(styles).toMatch(/\.dim-jh-orderHint \{[^}]*flex: 0 1 auto/)
      expect(styles).toMatch(/\.dim-jh-orderHint \{[^}]*min-width: 0/)
      // 独占一行时代的 10px 下边距必须清掉，否则按钮组下方多一截空隙
      expect(styles, '提示的下边距必须归零').toMatch(/\.dim-jh-orderHint \{[^}]*margin: 0;/)
    })

    it('★★ 提示必须单行显示（nowrap + 截断 + 完整文案挂在 title 上）', () => {
      // 用户 2026-10-26「文案改为一行显示」：折行会让第二行变两行高、
      // 把按钮组挤到垂直居中的怪位置。
      expect(styles, '提示必须禁止折行').toMatch(/\.dim-jh-orderHint \{[^}]*white-space: nowrap/)
      // nowrap 的必要配套：没有它们，窄窗口下文本会溢出到按钮组底下压字。
      expect(styles, '溢出必须裁掉').toMatch(/\.dim-jh-orderHint \{[^}]*overflow: hidden/)
      expect(styles, '被裁掉的部分要给省略号').toMatch(/\.dim-jh-orderHint \{[^}]*text-overflow: ellipsis/)
      // 截断后完整文案只能从 title 读到 ⇒ title 与正文必须同源常量。
      expect(panelHead, '提示元素必须挂 title（截断后靠它读全）')
        .toContain('title: ORDER_HINT_TEXT')
      // 常量只定义一次，正文与 title 都引用它 —— 不可能写出两份不同文案。
      const defs = source.match(/^const ORDER_HINT_TEXT = /gm) ?? []
      expect(defs, 'ORDER_HINT_TEXT 必须唯一').toHaveLength(1)
      expect(panelHead, '正文必须用常量而不是再抄一遍字面量').toContain('}, ORDER_HINT_TEXT)')
      // 文案本体（用户定稿原文），防止改样式时顺手改字
      expect(source, '提示文案被改动了').toContain('拖动卡片调整排序，按顺序选号。限额账号会沉到末尾、恢复后不复位')
    })
  })

  /**
   * ★ 用户 2026-10-26「页头滚动时应该只滚动账号列表」。
   *
   * 事故形态：滚动发生在 `.dim-jh-panel` 上 ⇒ 标题 / 排序提示 / 按钮组 /
   * 六条状态提示全都跟着滚走。修法是给账号管理页 section 加类名
   * （`dim-jh-accountSection`）当**滚动边界**，页头 `flex: none` 固定，
   * 只有 `.dim-jh-accountList` 自己 `overflow-y: auto`。
   *
   * ⚠️ 只断言「accountList 有 overflow-y: auto」是不够的 —— 没有
   *    `min-height: 0` 时 flex 子项默认 `min-height: auto`，会被内容撑到
   *    内容高而不是收缩，滚动条**照旧**落回 `.dim-jh-panel`。三件套缺一不可：
   *    ① 边界容器 flex-direction: column + min-height: 0
   *    ② 页头 flex: none
   *    ③ 列表 flex: 1 1 auto + min-height: 0 + overflow-y: auto
   */
  describe('★ 滚动：只有账号列表滚，页头固定', () => {
    it('★★ section 必须挂 dim-jh-accountSection 类名（滚动边界的挂载点）', () => {
      // 缺类名时下面那些规则无处可挂 —— 它曾经只靠 aria-label 定位、没有类名
      expect(source, '账号管理页 section 丢了 className，滚动边界规则会全部失效')
        .toContain("className: 'dim-jh-accountSection'")
      expect(source, 'section 的 aria-label 不能丢（面板语义）')
        .toMatch(/className: 'dim-jh-accountSection',\s*\n\s*'aria-label': `\$\{provider\} 账号管理`/)
    })

    it('★★ 边界容器必须是纵向 flex 且能收缩', () => {
      const rule = styles.match(/\.dim-jh-accountSection \{[^}]*\}/)?.[0]
      expect(rule, '缺少 .dim-jh-accountSection 规则').toBeDefined()
      expect(rule, '必须是纵向 flex，页头才能与列表上下分区').toMatch(/display: flex/)
      expect(rule, '必须是纵向，否则页头与列表并排').toMatch(/flex-direction: column/)
      expect(rule, '必须能撑满剩余高度').toMatch(/flex: 1 1 auto/)
      expect(rule, 'min-height: 0 缺了会把滚动条推回 .dim-jh-panel').toMatch(/min-height: 0/)
    })

    it('★★ 页头必须 flex: none（不参与收缩、不参与滚动）', () => {
      expect(styles, '页头被压成可收缩 ⇒ 账号多时它会被挤扁')
        .toMatch(/\.dim-jh-accountSection > \.dim-jh-panelHead \{[^}]*flex: none/)
    })

    it('★★ 账号列表自己滚：flex 1 1 auto + min-height 0 + overflow-y auto', () => {
      const rule = styles.match(/\.dim-jh-accountList \{[^}]*\}/)?.[0]
      expect(rule, '缺少 .dim-jh-accountList 规则').toBeDefined()
      expect(rule, '必须能长能缩').toMatch(/flex: 1 1 auto/)
      expect(rule, 'min-height: 0 缺了会被内容撑开，滚动条回退到外层').toMatch(/min-height: 0/)
      expect(rule, '滚动必须落在列表自己身上').toMatch(/overflow-y: auto/)
      // 反向钉子：flex-basis: 100% 是「页头跟着滚」那版的写法
      expect(rule, '不许回 flex-basis: 100%（纵向主轴下等于高度取满且不许收缩）')
        .not.toMatch(/flex: 1 0 100%/)
    })

    it('★★ 外层 .dim-jh-panel 必须是纵向 flex（否则子项撑不开、滚动无从发生）', () => {
      const rule = styles.match(/\.dim-jh-panel \{[^}]*\}/)?.[0]
      expect(rule, '缺少 .dim-jh-panel 规则').toBeDefined()
      expect(rule, '必须是纵向 flex，账号 section 才能占满剩余高度').toMatch(/flex-direction: column/)
      // overflow-y: auto 保留为兜底（子项没撑开时仍能滚），但正常路径不该出现滚动条
      expect(rule, 'overflow-y: auto 是兜底，别删').toMatch(/overflow-y: auto/)
    })

    it('★ 聚合面板也要能自己滚（它不走 accountSection 那条路）', () => {
      const rule = styles.match(/\.dim-jh-aggPanel \{[^}]*\}/)?.[0]
      expect(rule, '缺少 .dim-jh-aggPanel 规则').toBeDefined()
      expect(rule).toMatch(/overflow-y: auto/)
      expect(rule, 'min-height: 0 缺了会被内容撑开，滚动条回退到 .dim-jh-panel').toMatch(/min-height: 0/)
    })

    /**
     * ⚠️⚠️ 真实缺陷（用户 2026-10-27 报障「聚合页模型列表显示异常」）：
     * 22 个聚合模型的每一行都被压成几像素高的细线，右侧只剩一片横线。
     *
     * 根因链：本容器同时是「高度受限」（flex: 1 1 auto + min-height: 0）
     * 与「纵向 flex」（display: flex / flex-direction: column）⇒ 内容超高时
     * 子项按 flex-shrink: 1 **被压缩**，而不是溢出滚动。.dim-jh-aggModel
     * 又带 overflow: hidden ⇒ 它的 min-height: auto 下限失效，可被压到 0 高。
     *
     * ⇒ 必须给每个直接内容子项 flex: none。**这条用例就是防线**：
     * 少了它，任何人只要再给本容器加一次高度约束，列表就会静默塌成横线
     * （单测不渲染，肉眼之外没人会发现）。
     */
    it('★★★ 聚合面板的直接内容子项必须 flex: none（否则模型行被压扁）', () => {
      // 断言「选择器里确实把这几类子项都列了」
      const rule = styles.match(/\.dim-jh-aggPanel > \.dim-jh-aggIntro[\s\S]*?\{[^}]*flex: none[^}]*\}/)?.[0]
      expect(rule, '缺少「聚合面板子项 flex: none」规则 —— 模型行会被压扁').toBeDefined()
      // 逐个子项点名：漏掉任何一个，它就会成为新的塌陷点
      for (const cls of [
        'dim-jh-aggIntro',
        'dim-jh-aggToolbar',
        'dim-jh-aggNotice',
        'dim-jh-aggEmpty',
        'dim-jh-aggModel',
        'dim-jh-aggFooter',
      ]) {
        expect(rule, `子项 .${cls} 未列入 flex: none`).toContain(`.dim-jh-aggPanel > .${cls}`)
      }
      // 反向钉子：不许用通配符 —— 它会连 aggCount 一起钉死，破坏 flex-basis: 100% 换行
      expect(rule, '不得用通配符：会把 .dim-jh-aggCount 的 flex-basis: 100% 换行一起干掉')
        .not.toContain('.dim-jh-aggPanel > *')
      // 反向钉子：不许省成 flex: 0 1 auto（收缩因子仍是 1，白改）
      expect(rule).toMatch(/flex: none/)
    })

    /**
     * ⚠️⚠️ 用户 2026-10-27 报障「美化聚合页模型列表」的落地判据。
     *
     * 改造前：候选行里只有一个 `.dim-jh-aggCandidateLabel`，内容是
     * `渠道名 · 模型 id · 倍率` 一整串 —— 三者同色同字号同权重。
     * 而这一页的**唯一用途**就是逐条比较渠道（同一模型在 12 家渠道各有一条候选），
     * 最该被一眼分辨的恰恰是「哪家渠道」「哪个模型」，倍率只是附注。
     * ⇒ 必须拆成四格、四种视觉层级。
     *
     * ⚠️ 本用例守的是**拆分本身**（少一格就退回同权渲染）；
     * 颜色与字号的具体值不在断言范围（那是设计细节，会随主题调）。
     */
    it('★★★ 聚合候选行必须拆成四格（渠道 / 模型 id / 倍率 / 补丁），不得退回单串渲染', () => {
      // ── 分母：四格的样式必须各自存在 ──
      for (const cls of [
        'dim-jh-aggCandidateProvider',
        'dim-jh-aggCandidateId',
        'dim-jh-aggCandidatePrice',
        'dim-jh-aggCandidatePatch',
      ]) {
        expect(styles, `缺少 .${cls} 的样式 —— 该格会退回继承父级的同一种字色`).toMatch(
          new RegExp(`\\.${cls} \\{[^}]*\\}`),
        )
      }
      // ── 层级：渠道名必须比模型 id 弱（否则「哪家渠道」和「哪个模型」又同权了）──
      const providerRule = styles.match(/\.dim-jh-aggCandidateProvider \{[^}]*\}/)?.[0] ?? ''
      const idRule = styles.match(/\.dim-jh-aggCandidateId \{[^}]*\}/)?.[0] ?? ''
      expect(providerRule, '渠道名必须用 tertiary 色（三档里最弱的一档）')
        .toContain('--dsw-alias-label-tertiary')
      expect(idRule, '模型 id 必须用 primary 色（本行唯一的强调格）')
        .toContain('--dsw-alias-label-primary')
      // ── 弹性：只有模型 id 吃剩余宽度 ──
      // ⚠️ 若渠道名也参与压缩，同一页里每行的「模型 id 起始位置」会错落，
      //    对比渠道时眼睛要来回找起点 —— 这正是用户说的「不好看」的机制之一。
      expect(providerRule, '渠道名必须 flex: none（否则各行的模型 id 起始位置错落）')
        .toMatch(/flex: none/)
      expect(idRule, '模型 id 必须吃掉剩余宽度').toMatch(/flex: 1/)
      // ── 倍率为 0 必须另走一套配色（「免费」与「x0.15」不是同一类信息）──
      expect(styles, '「免费」必须用 data-free 单独上色，否则会被当成折扣读')
        .toMatch(/\.dim-jh-aggCandidatePrice\[data-free='true'\]/)
    })

    it('★ 展开箭头必须是 svg 且随 data-open 旋转（字符版没有过渡）', () => {
      // ⚠️ 字符「▸ / ▾」在 React 里是**换字符**，浏览器没有中间态 ——
      //    22 行的高频列表里每次都「跳」一下，观感廉价。
      //    svg + transform: rotate 才有过渡（全站图标化口径也一致）。
      expect(styles, '箭头容器必须有 transform 过渡').toMatch(
        /\.dim-jh-aggChevron \{[^}]*transition: transform/,
      )
      expect(styles, '展开态必须把箭头转 90 度').toMatch(
        /\.dim-jh-aggModel\[data-open='true'\][^{]*\.dim-jh-aggChevron \{[^}]*transform: rotate\(90deg\)/,
      )
      // ── 源码侧：模型块必须把 open 状态暴露给样式 ──
      // ⚠️ 这是「样式能拿到 React 状态」的唯一出口。少了它，上面两条样式
      //    规则永远不会命中 —— 而纯样式断言照样全绿（假绿陷阱）。
      expect(source, '模型块必须落 data-open，否则展开态样式永不命中').toMatch(
        /className: 'dim-jh-aggModel',\s*\n\s*'data-open': open \? 'true' : undefined,/,
      )

      // ── 渲染侧：箭头必须**真的是** svg + path ──
      // ⚠️ 上面的样式断言只证明「有 rotate 规则」。把 svg 退回字符 `▸`、或把 path
      //    删空，样式规则照样在、本文件照样全绿（2026-10-28 审计实测：path → null
      //    仍是 **115 passed**）⇒ 必须再从渲染侧钉一遍。
      const modelAt = source.indexOf('const renderModel = (model)')
      expect(modelAt, 'renderModel 不见了').toBeGreaterThan(-1)
      const modelBody = source.slice(modelAt, source.indexOf('const renderCandidate = (model', modelAt))
      expect(modelBody.length, 'renderModel 切片为空 —— 本用例的判据失效').toBeGreaterThan(200)
      expect(modelBody, '箭头容器不见了').toContain("className: 'dim-jh-aggChevron'")
      expect(modelBody, '箭头必须 aria-hidden（可访问名不该被装饰图形污染）')
        .toMatch(/className: 'dim-jh-aggChevron', 'aria-hidden': 'true'/)
      expect(modelBody, '箭头必须真的是 svg（退回字符 ▸ 会丢掉过渡）')
        .toMatch(/className: 'dim-jh-aggChevron'[\s\S]{0,600}React\.createElement\('svg'/)
      // 方向也要钉：朝右的折线，靠 CSS rotate(90deg) 转成朝下 ——
      // 把 d 换成朝左/朝下的折线，「展开时转 90°」就变成侧向或倒过来了。
      expect(modelBody, '箭头路径必须是朝右的折线（d 换向会让 rotate 90° 的方向错）')
        .toContain("d: 'M9 6l6 6-6 6'")
    })

    /**
     * ⚠️ 反向钉子：**不得**把展开态的 `data-open` 写成布尔值。
     * React 对自定义属性的布尔 `false` 会渲染成字符串 "false"（不是移除属性），
     * 于是未展开的块也带 `data-open="false"` —— 而样式是按 `[data-open='true']`
     * 写的，一旦有人改成 `=== 'true'` 之外的判据（或写成 `[data-open]`），
     * 22 个块会**全部**呈现展开态。用 `undefined` 让属性彻底缺席才是稳的。
     */
    it('★ data-open 必须是「真时给 true、假时省略」，不得写成布尔值', () => {
      expect(source).toMatch(/'data-open': open \? 'true' : undefined,/)
      expect(source, '不得写 data-open: open（布尔 false 会渲染成 "false" 属性）')
        .not.toMatch(/'data-open': open,/)
    })

    /**
     * ★★ 四格必须**在 renderCandidate 里真的被渲染**，且各自喂对应字段。
     *
     * ⚠️ 前一条用例只断言「样式存在」。样式在、但 JSX 里没渲染那一格 ——
     * 是完全可能的回退形态（改样式时手滑删掉一个 createElement，或者
     * 有人嫌多格麻烦把四格又合并回 `candidateRowLabel` 一串）。
     * 那时样式断言**全绿**，界面上却退回同权渲染。⇒ 必须再从**渲染侧**钉一遍。
     */
    it('★★★ renderCandidate 必须真的渲染这四格，且各喂对应字段', () => {
      const at = source.indexOf('const renderCandidate = (model, candidate')
      expect(at, 'renderCandidate 不见了').toBeGreaterThan(-1)
      const body = source.slice(at, source.indexOf('const renderModel = (model)', at))
      expect(body.length, 'renderCandidate 切片为空 —— 本用例的判据失效').toBeGreaterThan(200)

      // 渠道格喂 parts.provider
      expect(body, '渠道格必须渲染 parts.provider')
        .toMatch(/className: 'dim-jh-aggCandidateProvider' \}, parts\.provider\)/)
      // 模型 id 格喂 parts.realId
      expect(body, '模型 id 格必须渲染 parts.realId')
        .toMatch(/className: 'dim-jh-aggCandidateId' \}, parts\.realId\)/)
      // 倍率格：必须存在，且**按 price 判空**（不是无条件渲染）
      expect(body, '倍率格不见了 —— 倍率信息丢失').toContain("className: 'dim-jh-aggCandidatePrice'")
      expect(body, '倍率格必须由 parts.price 判空后才渲染')
        .toMatch(/parts\.price === null/)
      // 补丁角标：必须由 parts.patched 控制
      expect(body, '补丁角标不见了 —— 规格 §7.1 的人工核查标记丢失')
        .toContain("className: 'dim-jh-aggCandidatePatch'")
      expect(body, '补丁角标必须由 parts.patched 控制').toMatch(/parts\.patched/)

      // ── 「免费」必须由 price === 0 触发 data-free（不是无条件、也不是恒 undefined）──
      // ⚠️ 只断言「样式里有 [data-free='true'] 规则」是**假绿**：把这里的接线删掉，
      //    样式规则依然在，而界面上的「免费」会悄悄退回普通灰（2026-10-28 审计实测：
      //    把接线改成 `undefined` 后，本文件 **115 条全绿**）。
      expect(body, '「免费」必须由 parts.price === 0 触发 data-free')
        .toMatch(/'data-free':\s*parts\.price === 0 \? 'true' : undefined/)

      // ── 反向钉子：不得退回「整串直接塞进 span」──
      // ⚠️ 这正是改造前的形态：`React.createElement('span', { className: '...CandidateLabel' }, candidateRowLabel(candidate))`
      //    三等号后面紧跟 `candidateRowLabel(` 说明那一整串又被当成**文本子节点**了。
      expect(body, '不得把 candidateRowLabel 整串当文本渲染（那就是改造前的同权形态）')
        .not.toMatch(/CandidateLabel'[^)]*?\},\s*\n?\s*candidateRowLabel\(/)
      // 但**允许**它出现在 title 上（悬停读全文）：那是刻意保留的
      expect(body, '整串文案必须保留在 title 上（长 id 被省略号截断后要能悬停读全文）')
        .toMatch(/title: candidateRowLabel\(candidate\)/)
    })
  })

  /**
   * ⚠️ 页头左侧标题必须**保持删除**（两次删除，都不要加回来）：
   *
   * ① 副标题「提供商凭据与多账号管理」（.dim-jh-brandDesc）—— 2026-10-06：
   *    页头按钮太多，副标题既显示不全又挤占页头高度。
   * ② 标题本体「Jet Hub」（.dim-jh-brand / .dim-jh-brandName）—— 2026-10-07：
   *    页头一排已有 7 个按钮，标题只占宽度、不带任何操作。用户报障截图里
   *    「Jet Hub」还被折成两行（缺 white-space: nowrap），纯占地方。
   *
   * 这条是**反向断言**：初版删掉了 DOM 节点但没删 CSS、也没改这条用例，
   * 于是「样式已无引用」这种残留不会被任何测试发现 —— 加回来就重新占位。
   *
   * ⚠️ 语义不丢：`aria-label="Jet Hub Provider 设置"` 仍在 .dim-jh-page 上，
   * 宿主左侧导航也有「Jet Hub」项 —— 刻意用 `not.toMatch` 禁死 DOM 用法。
   */
  it('页头左侧标题块已整块移除：DOM 与样式表都不得再有', () => {
    // ⚠️ 只匹配**代码用法**（className 字面量 / CSS 规则），不匹配注释 ——
    // 上面注释故意保留「曾有标题」这段历史，读到就红会逼后人删掉它。
    expect(source).not.toMatch(/className: 'dim-jh-brandDesc'/)
    expect(styles).not.toMatch(/\.dim-jh-brandDesc\s*\{/)
    // 标题本体同样已删除：DOM 用法与 CSS 规则都要一并清掉。
    expect(source).not.toMatch(/className: 'dim-jh-brand'/)
    expect(source).not.toMatch(/className: 'dim-jh-brandName'/)
    expect(styles).not.toMatch(/\.dim-jh-brand\s*\{/)
    expect(styles).not.toMatch(/\.dim-jh-brandName\s*\{/)
    // 语义兜底必须还在：删了标题不能把可访问名一起删掉。
    expect(source).toContain("'aria-label': 'Jet Hub Provider 设置'")
  })
})

describe('供应商弹窗的自定义排序（2026-10-06 拖拽需求）', () => {
  describe('sortOpenProvidersByOrder（已打开组重排）', () => {
    it('order 内的按数组序排前，未列出的按声明顺序稳定补后', () => {
      const open = [P('a'), P('b'), P('c'), P('d')]
      expect(sortOpenProvidersByOrder(open, ['c', 'a']).map(p => p.id))
        .toEqual(['c', 'a', 'b', 'd'])
      expect(sortOpenProvidersByOrder(open, ['d', 'c', 'b', 'a']).map(p => p.id))
        .toEqual(['d', 'c', 'b', 'a'])
    })

    it('order 为 null / 空 / 未定义 → 完全保持声明顺序（未自定义的语义）', () => {
      const open = [P('z'), P('a'), P('m')]
      expect(sortOpenProvidersByOrder(open, null).map(p => p.id)).toEqual(['z', 'a', 'm'])
      expect(sortOpenProvidersByOrder(open, []).map(p => p.id)).toEqual(['z', 'a', 'm'])
      expect(sortOpenProvidersByOrder(open, undefined).map(p => p.id)).toEqual(['z', 'a', 'm'])
    })

    it('order 里的已关闭 / 未知 id 被跳过（不产生空洞，也不抛错）', () => {
      // 'x' 不在已打开组里（可能已关闭或来自旧版本），跳过即可。
      expect(sortOpenProvidersByOrder([P('a'), P('b'), P('c')], ['x', 'b', 'a']).map(p => p.id))
        .toEqual(['b', 'a', 'c'])
      expect(sortOpenProvidersByOrder([P('a'), P('b')], ['x', 'y']).map(p => p.id))
        .toEqual(['a', 'b'])
    })

    it('不修改入参数组（组件层依赖纯函数语义）', () => {
      const open = [P('a'), P('b'), P('c')]
      sortOpenProvidersByOrder(open, ['c', 'a'])
      expect(open.map(p => p.id)).toEqual(['a', 'b', 'c'])
    })

    /**
     * ⚠️⚠️ **新增 provider 不能被缀到末尾**（真实缺陷，2026-10-17 用户报障
     * 「minimax 国际版的顺序应该在中国版下面」）。
     *
     * `providerOrder` 是用户拖拽时快照的**全量 id 数组**；插件后来新增 provider
     * 时老用户的数组里没有新 id ⇒ 新 provider 一直排在末位，而它在注册表里的
     * 声明位置可能紧挨着某个相关项。老用户**不重新拖一次就永远好不了**。
     *
     * 实测本机 `state.json`：那份顺序缺 6 个新增 provider
     *（`minimaxintl` / `officeace` / `accio` / `autoclaw` / `modelscope` / `aggregate`）。
     */
    it('★★ 传声明序时，缺失的新增 provider 落回「声明位置」而不是缀尾', () => {
      // 声明序：… a, b, NEW, c, d …
      const declared = ['a', 'b', 'new', 'c', 'd']
      const open = declared.map(P)
      // 老用户的顺序表里**没有** 'new'
      const order = ['a', 'b', 'c', 'd']
      expect(sortOpenProvidersByOrder(open, order, declared).map(p => p.id))
        .toEqual(['a', 'b', 'new', 'c', 'd'])
    })

    it('★★ minimaxintl 必须紧跟 minimax（用户报障的具体形态）', () => {
      const declared = ['codearts', 'minimax', 'minimaxintl', 'zcode', 'gemini']
      const open = declared.map(P)
      // 真实形态：老顺序表里有 minimax，但**没有** minimaxintl
      const order = ['codearts', 'minimax', 'zcode', 'gemini']
      const got = sortOpenProvidersByOrder(open, order, declared).map(p => p.id)
      expect(got, 'minimaxintl 被缀到末尾了').toEqual([
        'codearts', 'minimax', 'minimaxintl', 'zcode', 'gemini',
      ])
      expect(got.indexOf('minimaxintl')).toBe(got.indexOf('minimax') + 1)
    })

    it('★ 声明在最前的缺失项排到最前（锚点为 null 的分支）', () => {
      const declared = ['new', 'a', 'b']
      const open = declared.map(P)
      expect(sortOpenProvidersByOrder(open, ['a', 'b'], declared).map(p => p.id))
        .toEqual(['new', 'a', 'b'])
    })

    it('★ 连续多个缺失项保持声明相对顺序', () => {
      const declared = ['a', 'x', 'y', 'z', 'b']
      const open = declared.map(P)
      expect(sortOpenProvidersByOrder(open, ['a', 'b'], declared).map(p => p.id))
        .toEqual(['a', 'x', 'y', 'z', 'b'])
    })

    it('★ 未传声明序时退化为旧行为（缺失项缀尾，保持向后兼容）', () => {
      const open = [P('a'), P('b'), P('c'), P('d')]
      // 与第一条例同口径：不传第三参 ⇒ 未列出的按传入顺序补后
      expect(sortOpenProvidersByOrder(open, ['a', 'b']).map(p => p.id))
        .toEqual(['a', 'b', 'c', 'd'])
    })

    it('★★ 用户已自定义的相对顺序**不允许**被声明序覆盖', () => {
      // 用户把 d 拖到了 a 前面 —— 声明序里 d 在后，但必须尊重用户。
      const declared = ['a', 'b', 'c', 'd']
      const open = declared.map(P)
      expect(sortOpenProvidersByOrder(open, ['d', 'a', 'b', 'c'], declared).map(p => p.id))
        .toEqual(['d', 'a', 'b', 'c'])
    })
  })

  describe('nextProviderOrderAfterDrop（拖拽落点 → 完整顺序）', () => {
    it('before / after 两个方向都生效（由指针落点决定，与账号拖拽一致）', () => {
      // 把 a 拖到 b 之后：b 的位置放 a
      expect(nextProviderOrderAfterDrop(['a', 'b', 'c'], ['d'], 'a', 'b', 'after'))
        .toEqual(['b', 'a', 'c', 'd'])
      // 把 c 拖到 a 之前
      expect(nextProviderOrderAfterDrop(['a', 'b', 'c'], ['d'], 'c', 'a', 'before'))
        .toEqual(['c', 'a', 'b', 'd'])
    })

    it('无已关闭 id 时只返回 open 段（与 orderAfterDrop 逐字相同）', () => {
      expect(nextProviderOrderAfterDrop(['a', 'b', 'c'], [], 'a', 'c', 'after'))
        .toEqual(['b', 'c', 'a'])
    })

    it('已关闭组按声明顺序缀尾（未自定义顺序时的既有口径）', () => {
      expect(nextProviderOrderAfterDrop(['a', 'c'], ['b', 'e', 'd'], 'c', 'a', 'after'))
        .toEqual(['a', 'c', 'b', 'e', 'd'])
    })

    it('源与目标相同 → null（无需变更，调用方不提交）', () => {
      expect(nextProviderOrderAfterDrop(['a', 'b'], ['c'], 'a', 'a', 'before')).toBeNull()
    })
  })

  // ⚠️ 回归：PR #63 初版把已关闭 id 无条件缀尾，导致「关闭期间又拖一次」
  // 后旧位置永久丢失，重开时回不到用户排过的地方（PR 描述承诺「回到原位」）。
  describe('已关闭 id 在拖拽后保留原位（回归：关闭期间再拖一次）', () => {
    const IDS = ['a', 'b', 'c', 'd', 'e']

    /** 按面板真实路径走一遍：渲染 → 取 open/closed 段 → 拖拽 → 提交。 */
    const dropThrough = (order: string[] | null, closed: string[], s: string, t: string, p: 'before' | 'after') => {
      const providers = IDS.map(id => ({ id, label: id }))
      const statuses = Object.fromEntries(IDS.map(id => [
        id, { closed: closed.includes(id), models: { total: 3 } },
      ]))
      const rows = providerSwitchRows(providers, statuses, order)
      return nextProviderOrderAfterDrop(
        rows.filter(r => r.checked).map(r => r.id),
        rows.filter(r => !r.checked).map(r => r.id),
        s, t, p,
        // ⚠️ 必须把当前 order 传进去：已关闭 id 的位置由「它在**旧** order 里
        // 前面有几个已打开项」确定，漏传就退化成「按展示序缀尾」= 修复前行为。
        order,
      )
    }
    const renderIds = (order: string[] | null, closed: string[]) => {
      const providers = IDS.map(id => ({ id, label: id }))
      const statuses = Object.fromEntries(IDS.map(id => [
        id, { closed: closed.includes(id), models: { total: 3 } },
      ]))
      return providerSwitchRows(providers, statuses, order).map(r => r.id)
    }

    it('关闭某供应商后再次拖拽，该供应商重开时仍回到用户排过的位置', () => {
      // ① 用户把 d 拖到 b 之后 → a b d c e
      const first = dropThrough(null, [], 'd', 'b', 'after')
      expect(first).toEqual(['a', 'b', 'd', 'c', 'e'])
      // ② 关闭 d，在剩下 4 个里再拖一次（e 拖到 a 之后）→ a e b d c
      const second = dropThrough(first, ['d'], 'e', 'a', 'after')
      // ③ 重开 d：d 的锚点仍是「前面有 2 个已打开项」→ 跟在 b 之后，
      //    即它相对 a/e/b 的位置没变。❌ 修复前 d 会被甩到数组末尾。
      expect(renderIds(second, [])).toEqual(['a', 'e', 'b', 'd', 'c'])
      expect(second!.indexOf('d')).toBeLessThan(second!.indexOf('c'))
    })

    it('多个已关闭 id 各自保留原位，且不丢失、不重复', () => {
      let order = dropThrough(null, [], 'd', 'b', 'after')      // → a b d c e
      order = dropThrough(order, ['d', 'e'], 'c', 'a', 'after')  // 关闭 d/e，c 拖到 a 之后
      const all = renderIds(order, [])
      expect(all).toHaveLength(IDS.length)
      expect(new Set(all).size).toBe(IDS.length)
      // 语义是「贴着**旧顺序里的直接前驱**」：d 的前驱是 b → d 紧跟 b；
      // e 的前驱是 c（它在旧顺序里排最末）→ e 紧跟 c。
      // ⚠️ 断言必须落在前驱 id 上（不是「第 N 个 open」）—— 计数会漂移，前驱不会。
      expect(all.indexOf('d')).toBe(all.indexOf('b') + 1)
      expect(all.indexOf('e')).toBe(all.indexOf('c') + 1)
    })

    it('关闭组也按自定义顺序排（2026-10-26 起，组间先后仍不变）', () => {
      let order = dropThrough(null, [], 'd', 'b', 'after')
      order = dropThrough(order, ['d', 'e'], 'c', 'a', 'after')
      // 展示：已打开段（a c b）+ 已关闭段（e d，按 order 里的相对次序）。
      // ⚠️ 2026-10-06 的口径是「关闭组恒按声明顺序沉底」⇒ 那时期望 d 在 e 之前；
      //    2026-10-26 用户要求「已关闭的供应商也应该支持调整顺序」后，关闭组
      //    同样吃 `order`，故 e 在前。组间先后（open 全在 closed 之前）不变。
      expect(renderIds(order, ['d', 'e'])).toEqual(['a', 'c', 'b', 'e', 'd'])
    })

    it('旧顺序缺失（未自定义）时退化为缀尾，不抛错', () => {
      // 无 oldOrder 可依据：已关闭 id 只能按展示顺序缀尾。
      expect(nextProviderOrderAfterDrop(['a', 'b'], ['c'], 'a', 'b', 'after'))
        .toEqual(['b', 'a', 'c'])
    })

    it('旧顺序里的未知/已删除 id 不产生空洞（跨版本增删 provider）', () => {
      // open=['a','b','c']；closed=['z']；旧顺序 x a b c 里混有已删除的 'x'。
      // 期望：'x' 既非 open 也非 closed → 被忽略；z 的前驱是 b → 插到 b 之后。
      const next = nextProviderOrderAfterDrop(
        ['a', 'b', 'c'], ['z'], 'c', 'a', 'after', ['x', 'a', 'b', 'c'],
      )
      expect(next).toEqual(['a', 'c', 'b', 'z'])
      // 关键不变量：没有重复、没有把已删除的 'x' 带回来
      expect(new Set(next).size).toBe(next!.length)
      expect(next).not.toContain('x')
    })

    it('前驱被拖到别处后，已关闭 id 仍跟住它（而非按计数漂移）', () => {
      // 旧顺序 a b d c e：d 的前驱是 b。
      // 这次把 b 拖到最前 → open 段 b a c，d 必须紧跟 b。
      const next = nextProviderOrderAfterDrop(
        ['a', 'b', 'c'], ['d'], 'b', 'a', 'before', ['a', 'b', 'd', 'c', 'e'],
      )
      expect(next).toEqual(['b', 'd', 'a', 'c'])
    })

    it('连续多个已关闭 id 共享同一前驱时，保持它们在旧顺序里的相对次序', () => {
      // ⚠️ 回归：逐个 splice 到前驱之后会让后一个挤到前一个**前面**
      // （b,d,e 变成 b,e,d，与旧序相反）—— 必须按前驱分组整块插入。
      const next = nextProviderOrderAfterDrop(
        ['a', 'b', 'c'], ['d', 'e'], 'c', 'a', 'after', ['a', 'b', 'd', 'e', 'c'],
      )
      // d 与 e 的前驱都是 b → 整块插在 b 之后，且保持 d 在 e 之前
      expect(next).toEqual(['a', 'c', 'b', 'd', 'e'])
    })

    it('跟不住的已关闭 id 沉尾（前驱缺失或为已删除的 id）', () => {
      // 前驱在旧顺序里不存在（跨版本新增的 provider）
      expect(nextProviderOrderAfterDrop(['a', 'b'], ['x'], 'a', 'b', 'after', ['a', 'b']))
        .toEqual(['b', 'a', 'x'])
      // 前驱是个已被删除的 id
      expect(nextProviderOrderAfterDrop(['a', 'b'], ['x'], 'a', 'b', 'after', ['zz', 'a', 'b']))
        .toEqual(['b', 'a', 'x'])
    })
  })

  describe('providerSwitchRows 的 order 参数（弹窗行数据）', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    // ⚠️ closed 供应商必须带 models.total：providerSwitchState 先判
    // 「没有可关闭的模型 → 禁用且 checked=true」，走不到 closed 判定
    // （真实 provider.status 恒带模型计数，测试数据必须同形）。
    const statuses = { c: { closed: true, models: { total: 3 }, accounts: { total: 1 } } }

    it('两组各自按 order 重排，组间先后不变（2026-10-26：已关闭也能拖）', () => {
      // 已打开 a/b/d 与已关闭 c/e/f 各给一份自定义顺序。
      const many = [P('a'), P('b'), P('c'), P('d'), P('e'), P('f')]
      const st = {
        c: { closed: true, models: { total: 3 } },
        e: { closed: true, models: { total: 3 } },
        f: { closed: true, models: { total: 3 } },
      }
      const rows = providerSwitchRows(many, st, ['f', 'c', 'e', 'd', 'a'])
      // 已打开段：d、a 在前，b 未定位按声明序补后 ⇒ d a b
      // 已关闭段：f、c、e 按 order 的相对次序 ⇒ f c e
      expect(rows.map(r => r.id)).toEqual(['d', 'a', 'b', 'f', 'c', 'e'])
      // 组间不混：前 3 行 checked=true，后 3 行 false
      expect(rows.map(r => r.checked)).toEqual([true, true, true, false, false, false])
    })

    it('order 未指定时与既有行为完全一致（向后兼容，rail 同源）', () => {
      expect(providerSwitchRows(providers, statuses).map(r => r.id))
        .toEqual(['a', 'b', 'd', 'c'])
      expect(providerSwitchRows(providers, statuses, null).map(r => r.id))
        .toEqual(providerSwitchRows(providers, statuses).map(r => r.id))
    })
  })

  describe('nextProviderOrderAfterGroupDrop（两组都能拖，跨组不生效）', () => {
    it('已关闭组内拖动 → 只重排 closed 段，open 段原样保持', () => {
      // open=[a,b]，closed=[c,d,e]；把 e 拖到 c 之前 ⇒ closed 变 e,c,d
      expect(nextProviderOrderAfterGroupDrop(['a', 'b'], ['c', 'd', 'e'], 'e', 'c', 'before', null))
        .toEqual(['a', 'b', 'e', 'c', 'd'])
      // after 方向同样生效
      expect(nextProviderOrderAfterGroupDrop(['a', 'b'], ['c', 'd', 'e'], 'c', 'e', 'after', null))
        .toEqual(['a', 'b', 'd', 'e', 'c'])
    })

    it('已打开组内拖动 → 委托给 nextProviderOrderAfterDrop（关闭 id 按新 open 段重排）', () => {
      const viaGroup = nextProviderOrderAfterGroupDrop(
        ['a', 'b', 'c'], ['d'], 'c', 'a', 'before', ['a', 'b', 'c', 'd'],
      )
      const direct = nextProviderOrderAfterDrop(['a', 'b', 'c'], ['d'], 'c', 'a', 'before', ['a', 'b', 'c', 'd'])
      expect(viaGroup).toEqual(direct)
      // 与函数文档一致：结果 = 新 open 段 + 按「旧顺序里的直接前驱」插回的 closed。
      // d 的前驱是 c ⇒ 紧跟 c 之后 ⇒ ['c','d','a','b']。
      // ⚠️ 这里的形状**与展示无关**（展示侧会按 sortOpenProvidersByOrder 重排
      // open 段、closed 段单独排序），它只决定「重开 d 时它回到哪一位」。
      expect(viaGroup).toEqual(['c', 'd', 'a', 'b'])
    })

    it('⚠️ 跨组拖拽返回 null（组间顺序固定：已打开恒在前）', () => {
      // 已打开行拖到已关闭行上
      expect(nextProviderOrderAfterGroupDrop(['a', 'b'], ['c', 'd'], 'a', 'c', 'before', null)).toBeNull()
      // 已关闭行拖到已打开行上
      expect(nextProviderOrderAfterGroupDrop(['a', 'b'], ['c', 'd'], 'c', 'a', 'after', null)).toBeNull()
    })

    it('源与目标相同、或 id 不在任一组里 → null', () => {
      expect(nextProviderOrderAfterGroupDrop(['a', 'b'], ['c'], 'c', 'c', 'before', null)).toBeNull()
      expect(nextProviderOrderAfterGroupDrop(['a'], ['c'], 'zz', 'c', 'before', null)).toBeNull()
    })

    it('空组不抛错', () => {
      expect(nextProviderOrderAfterGroupDrop([], ['a', 'b'], 'b', 'a', 'before', null))
        .toEqual(['b', 'a'])
      expect(nextProviderOrderAfterGroupDrop(['a', 'b'], [], 'b', 'a', 'before', null))
        .toEqual(['b', 'a'])
      expect(nextProviderOrderAfterGroupDrop(null, null, 'a', 'b', 'before', null)).toBeNull()
    })
  })

  describe('弹窗拖拽的接线（源码级回归）', () => {
    it('面板消费 order / onCommitOrder，并经 nextProviderOrderAfterDrop 提交', () => {
      const body = panelBody()
      expect(body).toContain('providerSwitchRows(providers, statuses, order)')
      expect(body).toContain('nextProviderOrderAfterGroupDrop(')
      expect(body).toContain('onCommitOrder(next)')
      // ⚠️ 2026-10-26 起已关闭的行**也能拖**（用户需求「已关闭的供应商也应该
      // 支持调整顺序」）。反向钉子：别把 `!row.checked` 那个早退写回来 ——
      // 它会让已关闭组永远拖不动，且界面上没有任何提示。
      expect(body, '已关闭的行被重新禁止拖拽了')
        .not.toContain('if (!row.checked || !dragEnabled) return { enabled: false };')
      expect(body).toContain('if (!dragEnabled) return { enabled: false };')
    })

    it('页面层走 provider.getOrder / provider.setOrder（宿主持久化）', () => {
      expect(source).toContain("rpcCall('provider.getOrder', {})")
      expect(source).toContain("rpcCall('provider.setOrder', { order: next })")
      // 顺序状态必须住宿主侧：客户端没有也不该有 localStorage（与既有架构一致）。
      expect(source).not.toContain('localStorage')
    })

    it('★★ 拖拽提交失败时不做乐观更新（setProviderOrder 必须排在 RPC 成功之后）', () => {
      // ⚠️⚠️ 六审 P1-6 实测：原来这里只有一句
      //     `expect(source).toContain('await loadProviderOrder();')`
      //   —— 它只证明「失败分支里会回读」，**锁不住「不做乐观更新」**。
      //
      //   具体能漏掉的回归：把 `setProviderOrder(next)` 从 `try` 里挪到
      //   `await rpcCall(...)` **之前**（即经典的乐观更新）。此时：
      //   ① `catch` 里的 `await loadProviderOrder()` 仍在（那条断言照样绿）；
      //   ② 但保存失败时界面会**先**显示新顺序、再被回读覆盖 ——
      //      用户看到一次「顺序跳了一下又跳回去」。
      //
      //   真判据是**顺序**：`await rpcCall('provider.setOrder'` 必须出现在
      //   `setProviderOrder(next)` 之前。切片取到 `catch` 之前即可，避免
      //   把 `finally` 里可能的其他调用算进来。
      const commit = source.slice(
        source.indexOf('const commitProviderOrder = React.useCallback('),
        source.indexOf('const selectProvider = (id) =>'),
      )
      expect(commit, '找不到 commitProviderOrder 的完整实现 ⇒ 本条会静默失明').not.toBe('')
      const rpcAt = commit.indexOf("await rpcCall('provider.setOrder'")
      const setAt = commit.indexOf('setProviderOrder(next)')
      expect(rpcAt, '找不到 provider.setOrder 的 RPC 调用').toBeGreaterThan(-1)
      expect(setAt, '找不到 setProviderOrder(next) 的落状态调用').toBeGreaterThan(-1)
      expect(
        rpcAt,
        'setProviderOrder 必须排在 RPC 之后（否则是乐观更新，保存失败时界面会闪一下新顺序）',
      ).toBeLessThan(setAt)
      // 失败分支仍必须回读（服务端才是权威）。
      expect(commit).toContain('await loadProviderOrder();')
    })

    it('行拖拽的视觉状态与账号卡片同款（淡出 + 插入线）', () => {
      // ⚠️ 必须带 `.dim-jh-modal` 作用域：`.dim-jh-modelRow` 是共享类名
      // （ModelToggle / GatewayPanel 也在用），挂 position:relative 作用域过宽。
      expect(styles).toContain('.dim-jh-modal .dim-jh-modelRow[data-dragging="true"]')
      expect(styles).toContain('.dim-jh-modal .dim-jh-modelRow[data-dropBefore="true"]::before')
      expect(styles).toContain('.dim-jh-modal .dim-jh-modelRow[data-dropAfter="true"]::after')
      // 插入线是 absolute 定位，行必须有 relative 锚点。
      expect(styles).toMatch(/\.dim-jh-modal \.dim-jh-modelRow \{ position: relative; \}/)
      // 反向断言：不得留下无作用域的全局规则
      expect(styles).not.toMatch(/^\.dim-jh-modelRow \[data-dragging/m)
    })

    // ⚠️ 回归（PR #63 复审发现）：初版 onDrop 漏传 oldOrder，已关闭 id 的位置
    // 在「关闭期间又拖一次」后永久丢失 —— 这条断言锁住调用点的实参个数。
    it('⚠️ onDrop 必须把当前 order 作为 oldOrder 传给 nextProviderOrderAfterGroupDrop', () => {
      const body = panelBody()
      expect(body).toMatch(
        /nextProviderOrderAfterGroupDrop\(\s*openIds, closedIds, sourceId, row\.id, dropPosition, order,?\s*\)/,
      )
    })
  })

  // ⚠️ 回归（PR #63 复审发现）：初版没有排序提交锁。不做乐观更新 ⇒ RPC 返回前
  // 界面顺序未变，再拖一次会基于旧顺序计算并把上一次的移动静默覆盖。
  describe('账号管理行标题行右侧的「供应商开关」（2026-11-06 用户两轮需求）', () => {
    /**
     * `ProviderPanel` 的源码切片（到下一个 `function` 之前）。
     *
     * ⚠️ 不能用整份 `source` —— `ProviderSwitchPanel` 里也有同名常量，
     *    不限定组件会把两边混起来。
     */
    const providerPanelSource = (): string => {
      const start = source.indexOf('function ProviderPanel(')
      expect(start, '找不到 ProviderPanel 组件').toBeGreaterThan(-1)
      const rest = source.slice(start)
      const offset = rest.slice(1).search(/^(?:export )?function /m)
      return offset === -1 ? rest : rest.slice(0, offset + 1)
    }

    // ⚠️ 需求演进：第一版做成「打开供应商开关弹窗」的入口（文字按钮），
    //    用户否掉：「我说的是加单独供应商开启/关闭的功能，你把整个移过来干嘛」
    //    ⇒ 现在是**当前供应商自己的开关**，点它直接 provider.setEnabled。

    it('★★ 标题行里必须有 role="switch" 的开关', () => {
      const body = providerPanelSource()
      const rowStart = body.indexOf("className: 'dim-jh-panelTitleRow'")
      expect(rowStart, '找不到标题行容器 ⇒ 本条会静默失明').toBeGreaterThan(-1)
      const titleRow = body.slice(rowStart)
      expect(titleRow, '开关的 className 必须是 dim-jh-providerSwitch').toContain("className: 'dim-jh-providerSwitch'")
      expect(titleRow, '开关必须是 role="switch"（否则屏幕阅读器读成一个普通按钮）')
        .toContain("role: 'switch'")
      expect(titleRow, '开关必须用 aria-checked 表达两态').toContain("'aria-checked':")
      // ⚠️ 光有 aria-checked 这个名字不够 —— 写死 'true' 会让**关闭态也显示成开**，
      //    而所有存在性断言全绿（变异实测 M1）。
      expect(
        titleRow,
        'aria-checked 必须跟随 switchState.checked（写死 true 会让关闭态也显示成开）',
      ).toContain("'aria-checked': switchState.checked ? 'true' : 'false',")
      // 「最右侧」：必须排在标题 <h2> 之后（用户明确要求「标题行最右侧」）。
      const switchAt = titleRow.indexOf("className: 'dim-jh-providerSwitch'")
      const titleAt = titleRow.indexOf("'dim-jh-panelTitle'")
      expect(titleAt, '找不到标题的 className 锚点').toBeGreaterThan(-1)
      expect(switchAt, '开关必须排在标题之后（用户要求在最右侧）').toBeGreaterThan(titleAt)
    })

    it('★★ 三件套判据必须走 providerSwitchState（不得自己重写）', () => {
      // ⚠️ 「已关闭优先于没有模型可关」那条顺序是 IKP8OF 死锁的修复，
      //    在面板里重写一遍必然漂移。
      expect(providerPanelSource()).toContain(
        'const switchState = providerSwitchState(providerStatuses?.[provider]);',
      )
    })

    it('★★ 点击必须走 onToggleProvider(provider, !checked)', () => {
      // ⚠️ 只断言「有 aria-label + 顺序」抓不到「没接线」—— 变异实测：
      //    把 onClick 整行删掉，所有存在性断言全绿，而开关点了没反应。
      const body = providerPanelSource()
      const at = body.indexOf("className: 'dim-jh-providerSwitch'")
      expect(at, '找不到开关 ⇒ 本条会静默失明').toBeGreaterThan(-1)
      const end = body.indexOf('},', at)
      expect(body.slice(at, end), '开关必须接上 onToggleProvider（否则点了没反应）')
        .toContain('onToggleProvider?.(provider, !switchState.checked)')
    })

    it('★★ 忙碌/禁用时不得可点（disabled 必须吃进两个来源）', () => {
      expect(providerPanelSource()).toContain(
        'disabled: switchState.disabled === true || switchBusy,',
      )
    })

    it('★ 反向对照：ProviderPanel 的签名必须解构出三个新 prop', () => {
      const sig = providerPanelSource()
      for (const prop of ['providerStatuses', 'providerBusy', 'onToggleProvider']) {
        expect(sig, `签名里必须解构出 ${prop}`).toContain(prop)
      }
      // 反向：旧的「弹窗入口」prop 必须删干净（用户明确否掉了那个做法）。
      expect(sig, '旧的 onOpenProviderSwitches 必须已删除').not.toContain('onOpenProviderSwitches')
    })

    it('★★ 挂载点必须把状态与回调都传下去', () => {
      const at = source.indexOf('createElement(ProviderPanel, {')
      expect(at, '找不到 ProviderPanel 的挂载点 ⇒ 本条会静默失明').toBeGreaterThan(-1)
      const mounting = source.slice(at, at + 600)
      expect(mounting, '必须传 providerStatuses（否则开关读不到状态）').toContain('providerStatuses,')
      expect(mounting, '必须传 providerBusy（否则切换期间可以连点）').toContain('providerBusy,')
      expect(mounting, '必须传 onToggleProvider（否则点了没反应）').toContain('onToggleProvider: toggleProvider,')
    })

    it('★★ CSS 两态必须都在（开=蓝色，关=灰色，滑块位移）', () => {
      expect(styles, '开关本体').toContain('.dim-jh-providerSwitch {')
      expect(styles, '打开态必须是蓝色').toMatch(/\.dim-jh-providerSwitch\[aria-checked='true'\] \{ background: #1677ff/)
      expect(styles, '滑块必须位移到右侧').toContain(
        '.dim-jh-providerSwitch[aria-checked=\'true\'] .dim-jh-providerSwitchThumb { transform: translateX(16px); }',
      )
      expect(styles, '禁用态必须降低不透明度').toContain('.dim-jh-providerSwitch:disabled { opacity: .5;')
      // ⚠️⚠️ 2026-11-06 十一审（审查员 e4e74842 报的 P1-3）。
      //
      // 上面四条只断言「规则**名**存在」。而「两个白圆」那个真机 bug 的**直接
      // 可见属性**是「胶囊底色」与「滑块底色」—— 这两条删掉都不红：
      // - `.dim-jh-providerSwitch` 的 `background: #c9cdd4`（关态灰底）
      //   ⇒ 删掉后胶囊透明，白滑块看起来像悬空的；
      // - `.dim-jh-providerSwitchThumb` 的 `background: #fff`（滑块白底）
      //   ⇒ 删掉后滑块消失，只剩一个灰胶囊。
      //
      // 而它们恰好是「两个圆」那个 bug 的**受害者属性**：class 名一撞，
      // `::after` 的白圆与本体的白滑块同时出现。**属性级判据是唯一能抓到
      // 「样式被删但类名还在」的守卫。**
      expect(styles, '关态底色必须是灰色（否则白滑块看起来是悬空的）')
        .toMatch(/\.dim-jh-providerSwitch \{[^}]*background: #c9cdd4/)
      expect(styles, '滑块底色必须是白色（否则滑块消失，只剩灰胶囊）')
        .toMatch(/\.dim-jh-providerSwitchThumb \{[^}]*background: #fff/)
    })

    it('★★ 已关闭的供应商整行置灰（2026-11-06 用户要求）', () => {
      // 置灰必须作用在 `.dim-jh-provider`（按钮）上，且**排除选中态** ——
      // 用户正在看的那一家必须保持清晰，否则「已关闭」会看起来像「不可用」。
      expect(styles, '已关闭行必须降不透明度').toMatch(
        /\.dim-jh-providerRowClosed \.dim-jh-provider:not\(\[aria-selected='true'\]\) \{ opacity: \.55; \}/,
      )
      // ⚠️ **不能灰开关**：开关在关闭态本来就是灰色的，再叠一层不透明度会让
      //    用户以为它不可点 —— 而它恰恰是唯一能把供应商打开的东西。
      expect(styles, '置灰规则不得命中开关').not.toMatch(
        /\.dim-jh-providerRowClosed[^{]*(?:Switch|switchThumb)[^{]*\{[^}]*opacity/,
      )
      // ⚠️ 只能是 opacity —— 改行高/宽度会让「已打开」组与「已关闭」组的分界
      //    随状态变化而跳动。
      expect(styles, '置灰不得改布局').not.toMatch(
        /\.dim-jh-providerRowClosed \.dim-jh-provider:not\(\[aria-selected='true'\]\) \{[^}]*(?:padding|margin|height|width|grid-template)[^}]*\}/,
      )
    })
  })

  describe('排序提交的互斥（防止连续拖拽互相覆盖）', () => {
    it('提交期间整体冻结拖拽（reordering 并入 dragEnabled）', () => {
      const body = panelBody()
      expect(body).toMatch(/busyIds\.size === 0[\s\S]{0,80}!reordering;/)
    })

    it('互斥用 ref 而非 state（两次 drop 可落在同一渲染周期内）', () => {
      // ⚠️ 局限（已知）：这是**存在性**断言，锁住「ref 声明 + 早退 + finally 释放」
      // 三处关键代码都在。它防不住「把锁挪进永不调用的死函数」这类伪装 ——
      // 单测环境没有 react，无法渲染组件做行为验证，这是架构性缺口。
      // 真正的行为保障是「拖拽提交期间整体冻结」那条（本组第 1 条）。
      expect(source).toContain('const reorderLockRef = React.useRef(false);')
      expect(source).toContain('if (reorderLockRef.current) return;')
      // 释放路径必须在 finally：失败时也要解锁，否则一次失败后拖拽永久失效。
      expect(source).toMatch(/finally \{[\s\S]{0,200}reorderLockRef\.current = false;/)
    })
  })

  // ⚠️ 回归（PR #63 复审发现）：失败提示原本只渲染在页面层，而弹窗遮罩是
  // fixed + z-index 3000，拖拽时完全看不到 —— 等于静默失败。
  describe('排序保存失败的提示必须可见', () => {
    it('弹窗内渲染 notice（复用既有样式，不新增 CSS）', () => {
      const body = panelBody()
      // ⚠️ 断言「无条件渲染」而非 `notice && notice.inModal`：弹窗开着时
      // toggleProvider 的结果提示在页面层同样被遮罩盖住，按 inModal 过滤会
      // 让「切换供应商」也变成静默无反馈。
      expect(body).toMatch(/^\s*notice\s*$/m)
      expect(body).not.toMatch(/notice\s*&&\s*notice\.inModal/)
      expect(body).toContain("className: 'dim-jh-probeNotice'")
    })

    it('页面层在弹窗打开时跳过渲染（避免遮罩内外重复出现两条）', () => {
      // 弹窗是 fixed + z-index 3000 的覆盖层，页面层那条必然被盖住 ⇒ 只在
      // 弹窗关闭时（不挂载）才由页面层渲染。
      expect(source).toMatch(/showProviderSwitches\s*\?[\s\S]{0,600}notice: providerNotice/)
      // 弹窗关闭时页面层仍要能显示（非 inModal 的那些，如切换结果）
      expect(source).toContain('providerNotice && !providerNotice.inModal')
    })

    it('失败分支标记 inModal（供页面层在弹窗关闭后决定是否延后展示）', () => {
      // ⚠️ 必须**剥掉注释**再匹配：这段代码附近有一整段说明「为什么要 inModal」
      // 的注释，直接对原文做宽窗口匹配可能被注释里的字面量喂饱。
      const codeOnly = source
        .split(/\r?\n/)
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
      expect(codeOnly).toMatch(/保存排序失败[\s\S]{0,240}inModal:\s*true/)
    })
  })

  // ⚠️ 2026-10-06 续作：主页 rail 跟随自定义排序 + 打开 Jet Hub 默认选中
  // 自定义序第一位的供应商（用户需求，本机已验收）。
  describe('自定义顺序的贯穿展示（主页 rail + 默认选中）', () => {
    it('主页 rail 的已打开组按 providerOrder 排序（closed 组恒声明序沉底）', () => {
      // ⚠️ renderRail 在 JetHubPage 里（ProviderSwitchPanel 之后），panelBody()
      // 的结束锚切不到它 —— 用整份 source 断言。
      //
      // ⚠️ 2026-10-17：调用点**多传了第三个实参**（声明顺序），用于把
      // `providerOrder` 里缺失的新增 provider 补回声明位置
      //（否则 `minimaxintl` 会被缀到末尾）。故判据不能写死旧的两参形态 ——
      // 用正则在「已打开组」那段里找调用，允许任意实参列表。
      expect(source).toMatch(/sortOpenProvidersByOrder\(\s*open,\s*providerOrder\b/)
      // 关闭组不参与自定义排序（用户口径：「这个逻辑不变」）。
      expect(source).toContain("group(`已关闭 (${closed.length})`, closed, 'closed')")
      /**
       * ⚠️ **第三个实参必须真的传**（否则修复静默失效）：
       * `sortOpenProvidersByOrder` 在缺省第三参时会退化为「缺失项缀尾」的旧行为 ——
       * 那正是用户报障的形态。这条断言是本修复的**唯一源码级闸门**。
       */
      expect(source).toMatch(
        /sortOpenProvidersByOrder\(\s*open,\s*providerOrder,\s*PROVIDERS\.map\(p => p\.id\)/,
      )
    })

    it('默认选中卡片 = 自定义序第一位（providerTouchedRef 一次性纠偏）', () => {
      // 三处关键代码齐全：ref 声明 + 纠偏 effect + selectProvider 置 touched。
      expect(source).toContain('const providerTouchedRef = React.useRef(false);')
      expect(source).toContain('providerTouchedRef.current = true;')
      // 纠偏 effect 必须先查 touched，用户点过就不再接管。
      expect(source).toMatch(/if \(providerTouchedRef\.current\) return;/)
      // 「已打开」过滤：首位已关闭时跳到下一个 open（否则渲染出空面板）。
      expect(source).toMatch(
        /providerOrder\.find\(id => providerStatuses === null \|\| providerStatuses\?\.\[id\]\?\.closed !== true\)/,
      )
    })
  })
})
