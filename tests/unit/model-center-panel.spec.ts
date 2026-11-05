import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 「供应商 → 模型列表」统一管理屏的**源码级**回归。
 *
 * ## 为什么是源码级
 * 单测环境里没有 react（见 `provider-toggle.spec.ts` 文件头），组件无法渲染。
 * 判定逻辑已经抽到 `plugin-src/client/model-center.js` 由 `model-center.spec.ts`
 * 用真实用例覆盖；这里只钉**接线**与**不能破的结构约束**：
 * - 入口必须真的能打开这一屏（不是写了个组件却没挂上）；
 * - 这一屏必须走 `ModelToggle` 复用它，**不能自己再写一个 checkbox**
 *   （行是 `<label>`，第二个 checkbox 会让「点行内文字」激活错的那个控件）；
 * - 服务端 `model.list` 只有单 provider 端点 ⇒ 必须逐家调，且「加载全部」必须限并发。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')

/** 剥掉注释再断言：注释里提到某个类名/端点不算接线。 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * 取 `function <name>(` 起、到**下一个顶层函数声明**止的源码。
 *
 * ⚠️ 与 `provider-toggle.spec.ts` 的 `panelBody()` 同一手法，不用硬编码锚点：
 * 组件之间插入新函数时，硬编码的 slice 会把别人的源码一起吞进来（2026-10-02 实测）。
 */
function bodyOf(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `找不到 ${name} 组件`).toBeGreaterThan(-1)
  const rest = source.slice(start)
  const offset = rest.slice(1).search(/^(?:export )?function /m)
  return offset === -1 ? rest : rest.slice(0, offset + 1)
}

const panel = codeOnly(bodyOf('ModelCenterPanel'))
const switchPanel = codeOnly(bodyOf('ProviderSwitchPanel'))

describe('入口接线：从「供应商」弹窗切到模型列表屏', () => {
  it('ProviderSwitchPanel 持有视图状态，且只在两屏之间切换', () => {
    expect(switchPanel).toContain("const [view, setView] = React.useState('switches')")
    expect(switchPanel).toContain("view === 'models'")
    expect(switchPanel).toContain('setView(value)')
  })

  it('模型屏由 ProviderSwitchPanel 挂载，并把 rpcCall 与状态补丁回调传下去', () => {
    // ⚠️ 必须用 `createElement` 而不是直接调用函数：直接调用会让 hook 数量随
    // 父组件的状态变化而变化，触发 React #310（2026-10-02 事故）。
    //
    // ⚠️⚠️ **`onProviderStatusPatched` 也必须透传**（2026-11-05 四审测试判别力 P0）：
    // 模型列表屏点「全部打开/全部关闭」后要就地补这一家的状态，而
    // `setProviderStatuses` 是 `JetHubPage` 的 state —— `ModelCenterPanel` 是它的
    // **孙辈**，作用域里根本没有那个标识符。`f51b3ef` 曾直接写它 ⇒ 一点按钮就
    // `ReferenceError` ⇒ 宿主 `SlotErrorBoundary` 捕获 ⇒ 整个设置页清空。
    //
    // ⚠️ 本条只是**接线**判据。「未声明变量」的**真守卫**在
    // `credits-capabilities.spec.ts` 里跑 `tsc -p tsconfig.client-check.json` 的
    // TS2304/TS2552 检查（已做红→绿反向验证）。单测环境没有 react（见文件头），
    // 做不了行为级渲染 —— 不要为它编源码文本断言来假装有守卫。
    expect(switchPanel).toContain(
      'React.createElement(ModelCenterPanel, { providers, rpcCall, statuses, onProviderStatusPatched })',
    )
  })

  it('页面层把 rpcCall 传进 ProviderSwitchPanel（否则模型屏调不了任何端点）', () => {
    const mountAt = source.indexOf('? React.createElement(ProviderSwitchPanel')
    expect(mountAt).toBeGreaterThan(-1)
    const mount = source.slice(mountAt, mountAt + 900)
    expect(mount).toContain('providers: PROVIDERS')
    expect(mount).toContain('rpcCall')
  })

  it('两个视图共用同一个弹窗，不新开全屏覆盖层', () => {
    // 全屏覆盖层互斥是本文件已有的纪律（供应商 / 网关 / Token 用量）。
    expect(panel).not.toContain('dim-jh-modalOverlay')
    expect(panel).toContain('className: \'dim-jh-modelList\'')
  })

  it('模型屏自己的说明覆盖「关掉供应商」的旧说明（两条文案不能同时出现）', () => {
    expect(switchPanel).toContain("view === 'models'")
    // 旧的那段 hint 现在挂在 `: React.createElement('p'` 分支上
    expect(switchPanel).toMatch(/view === 'models'[\s\S]{0,200}: React\.createElement\('p'/)
  })
})

describe('ModelCenterPanel 的数据通路', () => {
  it('逐家读目录（服务端 model.list 只有单 provider 端点，没有批量端点）', () => {
    expect(panel).toContain("rpcCall('model.list', { provider: providerId })")
    // 不允许偷偷传数组 —— 服务端只认单个 provider
    expect(panel).not.toMatch(/rpcCall\('model\.list',\s*\{\s*providers:/)
  })

  it('三个写端点都接了，且各自用途不混', () => {
    expect(panel).toContain("rpcCall('model.setDisabled', { provider: providerId, modelId, disabled })")
    expect(panel).toContain("rpcCall('model.clearDead', { provider: providerId, modelId })")
    // ⚠️ 批量端点的调用形态变了（多了 `closeProvider: false`）⇒ 不能用整行字面量断言，
    // 拆成「端点名」+「参数」两段（见下面那条用例）。
    expect(panel).toContain("rpcCall('model.setAllDisabled'")
  })

  /**
   * ★★ **模型级的「全关」必须显式传 `closeProvider: false`**（2026-10-21 合并审计发现，阻断级）。
   *
   * 服务端 `model.setAllDisabled(true)` 的**缺省**语义是「关闭该供应商」
   * （落「供应商整体关闭意图」，与 `provider.setEnabled(false)` 同一条路径）。
   * 本屏是**模型级**管理，用户的意图是「关这家模型」——
   *
   * ⇒ 缺省会把**整个供应商**也关掉：`provider.status` 报 closed、选择器里一个
   * 模型都没有；再打开**任意一个**模型，供应商被顺带打开。两头都与用户意图相反，
   * 且**零提示**。
   */
  it('★★ 整家全关必须显式传 closeProvider: false（不得落供应商关闭意图）', () => {
    expect(panel).toContain('closeProvider: false')
    // ⚠️ 反向断言：不得出现 `closeProvider: true`（那会显式落意图）。
    expect(panel).not.toContain('closeProvider: true')
  })

  it('★ 整家全开/全关用 setAllDisabled，不用 setDisabledMany', () => {
    // setDisabledMany 只能清「当前在列」的模型；「全开」要连历史关闭记录一起清，
    // 只有 setAllDisabled(false) 会清空整张黑名单。
    expect(panel).not.toContain('model.setDisabledMany')
  })

  it('★ 「加载全部」限并发（一次全发会同时打二十多个上游目录请求）', () => {
    expect(panel).toContain('centerPendingProviderIds(providers, states)')
    expect(panel).toMatch(/const concurrency = \d+/)
    const limit = Number(panel.match(/const concurrency = (\d+)/)?.[1] ?? '99')
    expect(limit, '并发上限必须 >=2（否则「加载全部」就是个慢速串行循环）').toBeGreaterThanOrEqual(2)
    expect(limit, '并发上限必须 <=5（再高就不是限流了）').toBeLessThanOrEqual(5)
  })

  it('只补没就绪的家，重复点「加载全部」不会重复打已就绪的供应商', () => {
    // pending 由 centerPendingProviderIds 决定（ready 的跳过）；按钮 disabled 也用它。
    expect(panel).toContain('pending.length === 0')
  })

  it('失败态给「重新读取」，不是把整屏换成错误页', () => {
    expect(panel).toContain("'重新读取'")
    expect(panel).toContain("section.phase === 'error'")
  })

  it('批量动作期间锁住该家的所有行（避免并发写同一张黑名单）', () => {
    expect(panel).toContain('providerBusy.has(section.id)')
    expect(panel).toMatch(/busy:\s*sectionBusy \|\| busyIds\.has\(busyKey\(section\.id, model\.id\)\)/)
  })

  /**
   * ★★ **`mounted` ref 必须在挂载时复位**（2026-10-21 合并审计发现）。
   *
   * React 18 StrictMode 的双挂载序列是「mount → effect → cleanup → effect」：
   * cleanup 把 `mounted.current` 置 `false`，**第二次 effect 若不复位** ⇒
   * 之后所有 `if (!mounted.current) return` 恒成立 ⇒ RPC 结果全被丢弃
   * ⇒ 界面永远停在「正在读取该供应商的模型列表…」，且懒加载会因 state 不更新
   * 而**再发一次** `model.list`。
   *
   * ⚠️ 本文件既有的 `ModelListPanel`（`jet-hub.js:1110`）**有**这一行
   * ⇒ 同一个文件里两套写法，本屏原先是漏掉的那套。
   * ⚠️ 可达性：宿主 web bundle 里 `StrictMode` 无实际使用点 ⇒ **当前不可达**
   * （属「差一行复位」的脆弱绿，不是现行缺陷）。
   */
  it('★★ mounted ref 在挂载时复位（StrictMode 双挂载形态）', () => {
    // ⚠️ 判据是「effect 体里有 `mounted.current = true`」—— 不能只断言
    // `mounted.current` 出现过（cleanup 里那行也满足）。
    expect(panel).toMatch(/React\.useEffect\(\(\) => \{[^}]*mounted\.current = true;/)
  })
})

describe('★ 不能破的结构约束', () => {
  it('模型屏必须复用 ModelToggle，自己不许造 checkbox', () => {
    // 行是 <label>：第二个 checkbox 会让「点行内文字」激活错的那个控件
    // （与 ModelToggle / ProviderSwitchPanel 同一条铁律）。
    expect(panel).toContain('React.createElement(ModelToggle, {')
    expect(panel).not.toContain("type: 'checkbox'")
    // 连 label 都不许自己造：开关行一律由 ModelToggle 渲染。
    expect(panel).not.toContain("React.createElement('label'")
  })

  it('不用 createPortal（客户端模块表由宿主注入，react-dom 可能不在其中）', () => {
    expect(panel).not.toContain('createPortal')
  })

  it('成功但无效果的提示与错误提示分开渲染（IKJW33）', () => {
    const warnAt = panel.indexOf("'data-tone': 'warn'")
    const errorAt = panel.indexOf("'data-tone': 'error'")
    expect(errorAt).toBeGreaterThan(-1)
    expect(warnAt).toBeGreaterThan(-1)
    // 两个 tone 各自对应 role：warn ⇒ status、error ⇒ alert
    expect(panel).toMatch(/'data-tone': 'error',\s*\n\s*role: 'alert'/)
    expect(panel).toMatch(/'data-tone': 'warn',\s*\n\s*role: 'status'/)
  })

  it('「全关」前必须确认，且文案给出影响面', () => {
    expect(panel).toMatch(/if \(disabled && !confirm\(/)
    expect(panel).toContain('会从对话框的模型选择里消失')
    expect(panel).toContain('取消则不做任何变更')
  })

  it('搜索框与状态筛选复用 model-filter 那套（不另写一份匹配逻辑）', () => {
    expect(panel).toContain('isFilterActive({ query, status: statusFilter })')
    expect(panel).toContain('visibleCenterSections(providers, states')
    expect(panel).toContain("type: 'search'")
    // 四种 status 值由 model-filter 定，这里只摆按钮
    expect(panel).toContain("['all', '全部']")
    expect(panel).toContain("['enabled', '已打开']")
    expect(panel).toContain("['disabled', '已关闭']")
  })

  it('计数口径写明「已读取 N / M 家」—— 未加载的不能算成 0 个模型', () => {
    expect(panel).toContain('已读取 ')
    // ⚠️ ⚠️ **必须传 `providers` + `states`，不能传 `sections`**
    // （2026-10-21 合并审计发现）：`sections` 是**筛选后**的集合 ⇒
    // 用户输入任意不匹配的搜索词 ⇒ 顶部立刻变成「已读取 0 / N 家」。
    expect(panel).toContain('centerTotals(providers, states)')
    expect(panel).not.toContain('centerTotals(sections)')
  })
})

describe('与既有模型列表屏不冲突', () => {
  it('单家内部的计费分组折叠仍归 ModelListPanel（这一屏不再套一层）', () => {
    expect(panel).not.toContain('groupModelsForDisplay')
    expect(source).toContain('groupModelsForDisplay(all, { query, status: statusFilter })')
  })

  it('ModelListPanel 仍然独立可挂载（「显示列表」按钮没被删）', () => {
    expect(source).toContain('React.createElement(ModelListPanel, {')
  })
})
