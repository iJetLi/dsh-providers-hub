import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  filterModels,
  isFilterActive,
  matchesModelQuery,
  normalizeStatusFilter,
} from '../../plugin-src/client/model-filter.js'

/**
 * 模型列表的搜索与状态筛选。
 *
 * 与 `model-bulk.spec.ts` / `account-order.spec.ts` 同理：组件无法在本仓库单测里
 * 渲染（react 不在依赖内），故把最容易写错的判定抽成纯函数。
 *
 * 这组用例锁的核心是**「筛选不能悄悄吞掉模型」**：
 * - 未知筛选值必须退化为「不筛」（宁多勿少），否则一次前端笔误会让列表凭空
 *   少掉大半，而用户完全无从判断原因；
 * - 空搜索词必须命中全部（那是"未搜索"而不是"搜索空串"）；
 * - 搜索要同时匹配展示名与 id（Cline 的 id 形如 `cline-free/deepseek-v4.1-flash`，
 *   用户可能只记得 id 片段）。
 */
describe('matchesModelQuery（单条搜索匹配）', () => {
  const model = { id: 'cline-free/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }

  it('空搜索词命中全部（未搜索 ≠ 搜索空串）', () => {
    expect(matchesModelQuery(model, '')).toBe(true)
    expect(matchesModelQuery(model, '   ')).toBe(true)
    expect(matchesModelQuery(model, undefined)).toBe(true)
  })

  it('按展示名匹配，且不区分大小写', () => {
    expect(matchesModelQuery(model, 'deepseek')).toBe(true)
    expect(matchesModelQuery(model, 'DEEPSEEK')).toBe(true)
    expect(matchesModelQuery(model, 'V4.1')).toBe(true)
  })

  /** id 片段也必须能搜到：用户常常只记得 id 而不是展示名。 */
  it('按 id 匹配（含命名空间与点号）', () => {
    expect(matchesModelQuery(model, 'cline-free/')).toBe(true)
    expect(matchesModelQuery(model, 'v4.1-flash')).toBe(true)
  })

  it('不匹配时返回 false', () => {
    expect(matchesModelQuery(model, 'gemini')).toBe(false)
  })

  /** 缺字段的条目不能抛错（远端目录里可能有只有 id 的裸条目）。 */
  it('缺 name / id 字段时不抛错', () => {
    expect(matchesModelQuery({ id: 'x' }, 'x')).toBe(true)
    expect(matchesModelQuery({ name: 'X' }, 'x')).toBe(true)
    expect(matchesModelQuery({}, 'x')).toBe(false)
    expect(matchesModelQuery(null, 'x')).toBe(false)
  })
})

describe('normalizeStatusFilter（筛选值归一化）', () => {
  it('三个合法值原样返回', () => {
    expect(normalizeStatusFilter('all')).toBe('all')
    expect(normalizeStatusFilter('enabled')).toBe('enabled')
    expect(normalizeStatusFilter('disabled')).toBe('disabled')
  })

  /**
   * 未知取值必须退化为 `all`。
   *
   * 这是本模块最重要的一条防御：若实现成「非 all 即按 enabled 筛」，一次拼错的
   * 取值（如 `'Disabled'`）会让列表只剩已打开的模型，用户看到的是「模型少了一大半」
   * 而没有任何错误提示。
   */
  it('未知取值退化为 all（宁多勿少，不静默少给模型）', () => {
    expect(normalizeStatusFilter('Disabled')).toBe('all')
    expect(normalizeStatusFilter('')).toBe('all')
    expect(normalizeStatusFilter(undefined)).toBe('all')
    expect(normalizeStatusFilter(null)).toBe('all')
    expect(normalizeStatusFilter(42)).toBe('all')
  })
})

describe('filterModels（搜索 + 状态筛选）', () => {
  const model = (id, disabled, name) => ({ id, name: name ?? id, disabled })

  const MODELS = [
    model('glm-5.3', false, 'GLM-5.3'),
    model('glm-5.3-flash', true, 'GLM-5.3-Flash'),
    model('deepseek-v4.1-flash', false, 'DeepSeek V4.1 Flash'),
    model('kimi-k3', true, 'Kimi-K3'),
  ]

  it('无筛选时返回全量且保持原顺序', () => {
    expect(filterModels(MODELS, {})).toEqual(MODELS)
    expect(filterModels(MODELS).map(m => m.id)).toEqual([
      'glm-5.3', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'kimi-k3',
    ])
  })

  it('按状态筛选：enabled 只留已打开', () => {
    expect(filterModels(MODELS, { status: 'enabled' }).map(m => m.id))
      .toEqual(['glm-5.3', 'deepseek-v4.1-flash'])
  })

  it('按状态筛选：disabled 只留已关闭', () => {
    expect(filterModels(MODELS, { status: 'disabled' }).map(m => m.id))
      .toEqual(['glm-5.3-flash', 'kimi-k3'])
  })

  it('搜索与状态筛选是**与**关系', () => {
    // glm 命中两条，其中只有 glm-5.3-flash 是已关闭的。
    expect(filterModels(MODELS, { query: 'glm', status: 'disabled' }).map(m => m.id))
      .toEqual(['glm-5.3-flash'])
    expect(filterModels(MODELS, { query: 'glm', status: 'enabled' }).map(m => m.id))
      .toEqual(['glm-5.3'])
  })

  /**
   * 未设置 `disabled` 字段的条目视为**已打开**（与适配器黑名单的
   * 「只有显式 true 才算关闭」同一语义）。
   */
  it('未声明 disabled 的条目算已打开', () => {
    const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', disabled: true }]
    expect(filterModels(list, { status: 'enabled' }).map(m => m.id)).toEqual(['a'])
    expect(filterModels(list, { status: 'disabled' }).map(m => m.id)).toEqual(['b'])
  })

  /** 列表在载入完成前是 null，不能抛错。 */
  it('null / 非数组输入返回空数组', () => {
    expect(filterModels(null, {})).toEqual([])
    expect(filterModels(undefined, {})).toEqual([])
    expect(filterModels('nope', {})).toEqual([])
  })

  it('筛选结果为空时返回空数组（调用方据此渲染"无匹配"而不是"没有模型"）', () => {
    expect(filterModels(MODELS, { query: 'zzz-not-exist' })).toEqual([])
  })
})

describe('isFilterActive（是否存在生效的筛选）', () => {
  it('无搜索、状态为 all 时为 false', () => {
    expect(isFilterActive({})).toBe(false)
    expect(isFilterActive({ query: '', status: 'all' })).toBe(false)
    expect(isFilterActive({ query: '   ', status: 'all' })).toBe(false)
  })

  it('有搜索词或非 all 状态时为 true', () => {
    expect(isFilterActive({ query: 'glm' })).toBe(true)
    expect(isFilterActive({ status: 'disabled' })).toBe(true)
    expect(isFilterActive({ status: 'enabled' })).toBe(true)
  })

  /**
   * 未知状态值不算「有筛选」—— 必须与 `normalizeStatusFilter` 的退化保持一致，
   * 否则会出现「判定说有筛选、实际一条都没筛」的错位，勾选工具条会莫名出现。
   */
  it('未知状态值不算有筛选（与归一化保持一致）', () => {
    expect(isFilterActive({ status: 'Disabled' })).toBe(false)
    expect(isFilterActive({ status: 42 })).toBe(false)
  })
})

/**
 * 客户端接线守卫（源码级）。
 *
 * 组件无法渲染，故与 `model-bulk.spec.ts` 同法用源码断言锁住「面板确实提供了
 * 搜索框与筛选按钮、且批量开关走的是批量端点」这几件不能退化的事。
 *
 * 每条断言都对应一个真实会犯的错：
 * - 面板只渲染 `all` 而不是筛选结果 → 搜索框形同虚设（输入了但列表不变）；
 * - 批量开关循环调用单条端点 → 勾选 100 个模型就发 100 次请求 + 100 次目录广播；
 * - 无筛选时也渲染勾选工具条 → 与「打开全部 / 关闭全部」重复，用户不知点哪个；
 * - 筛选后无结果不给出路 → 用户以为模型全丢了（实际只是搜索词没命中）。
 */
describe('ModelListPanel 搜索/筛选/多选接线（源码级回归）', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/jet-hub.js'),
    'utf8',
  )
  const normalized = source.replace(/\r\n/g, '\n')

  it('引用了纯逻辑模块，而不是在本文件里另写一份判定', () => {
    expect(source).toContain("from './model-filter.js'")
    expect(source).toContain('filterModels')
    expect(source).toContain('isFilterActive')
  })

  it('提供搜索框与三个状态筛选按钮', () => {
    expect(normalized).toContain("type: 'search'")
    expect(normalized).toContain('搜索模型名或 id')
    expect(normalized).toContain("['all', '全部']")
    expect(normalized).toContain("['enabled', '已打开']")
    expect(normalized).toContain("['disabled', '已关闭']")
  })

  /**
   * 列表必须渲染**筛选结果**，否则搜索框输入后列表不变，等于没实现。
   *
   * ⚠️ 同时锁住**没有渲染上限**：改动前 478 条就是一次性全渲染、工作正常，
   * 加「显示更多」只会凭空多一次点击（属于功能收缩），已被回退。
   */
  it('渲染的是筛选结果，且不做渲染上限（不引入「显示更多」）', () => {
    // ⚠️ 2026-10-01 起改为**按分组渲染**（订阅/免费/Cloud/按量计费，
    // 见 `model-groups.js`）：这里因此由 `filtered.map(...)` 的平铺断言
    // 改为「组内渲染筛选结果」——判据不变，仍是**筛选后**的集合
    //（`groupModelsForDisplay` 内部对每组调用 `filterModels`），不是全量。
    expect(normalized).toContain('group.models.map(model => React.createElement(ModelToggle')
    expect(normalized).toContain('groupModelsForDisplay(all, { query, status: statusFilter })')
    expect(normalized).not.toContain('all.map(model => React.createElement(ModelToggle')
    expect(normalized).not.toContain('MODEL_RENDER_LIMIT')
    // ⚠️ 只断言**代码**里没有「显示更多」按钮，注释里提到它是有意的说明
    //（记录"为什么不做渲染上限"），不该因此判失败。
    expect(normalized).not.toContain('setRenderLimit')
    expect(normalized).not.toContain('dim-jh-modelMore')
  })

  /**
   * ⚠️ **不得再引入多选勾选框**（曾造成真实的行为倒退，已回退）。
   *
   * `ModelToggle` 的根元素是 `<label>`，内部原先只有 1 个 checkbox，点行内
   * 任意位置（如模型名）都会切换**可见性开关**。一旦插入第二个 checkbox，
   * 浏览器把点击激活到**第一个**可标记控件 —— 「点模型名」变成切换勾选、
   * 可见性开关纹丝不动（已用无头 Edge 实测确认）。
   *
   * 若将来确需多选，必须先把行容器从 `<label>` 改成 `<div>`；那时本用例需要
   * 一并修改，且必须补一条「点模型名仍能切换可见性」的实测。
   */
  it('ModelToggle 内只有 1 个 checkbox（多选会破坏「点模型名切换开关」）', () => {
    const start = normalized.indexOf('function ModelToggle')
    expect(start, '未找到 ModelToggle').toBeGreaterThan(-1)
    // ⚠️⚠️ 窗口必须是**整个组件**，不能是固定字符数。
    // 2026-11-13 给 `ModelToggle` 加「需福利包」角标（Gitee IKJOF7）时，
    // 原先固定 1600 字符的窗口被新增的注释挤满 —— 那个**唯一**的 checkbox
    // 落到了窗口之外，断言直接变成 `0 === 1` 假红。
    // 反方向同样危险：固定窗口还会**假绿**，真有第二个 checkbox 落在 1600
    // 之外就数不到。所以按「到下一个顶层 function 声明为止」来切。
    const rest = normalized.slice(start)
    const nextFn = rest.indexOf('\nfunction ', 1)
    const body = nextFn === -1 ? rest : rest.slice(0, nextFn)
    const boxes = body.match(/type: 'checkbox'/g) ?? []
    expect(boxes.length, 'ModelToggle 内出现了多个 checkbox，会破坏既有点击交互').toBe(1)
    // 也不得残留多选相关的类名与状态
    expect(normalized).not.toContain('dim-jh-modelPick')
    expect(normalized).not.toContain('selectedIds')
  })

  /** 筛选后无结果必须给出路，且与「该 Provider 没有模型」区分开。 */
  it('筛选无结果时提示与「没有模型」不同，并提供清空入口', () => {
    expect(normalized).toContain('没有符合当前搜索与筛选条件的模型。')
    expect(normalized).toContain('该 Provider 当前没有可用的模型。')
    expect(normalized).toContain('const resetFilters')
  })
})

/**
 * 模型行的**布局**守卫（源码级）。
 *
 * ## 这组用例的由来（真实缺陷，用户报障）
 *
 * 「cline 功能是具备的，不过针对某一个模型的开关在最后，需要横向滑动，我没有看到」
 *
 * 根因不是功能缺失，而是 **CSS 让行横向溢出**：`.dim-jh-modelId` 用的是
 * `flex: none`（**拒绝收缩**），长 id 把行撑宽；`.dim-jh-modelList` 的单列 grid
 * 列宽默认又是 `auto`（grid 项 `min-width` 默认 `auto`，同样拒绝收缩），
 * 于是整行溢出弹窗，**排在 id 之后的开关被推出可视区**。
 *
 * Cline 有 300 个 id 超过 20 字符（最长 56），所以几乎每行都中招 —— 用户看到的是
 * 「列表里根本没有开关」，自然一个模型都关不掉（这正是该 provider 在 `state.json`
 * 的 `disabledModels` 里长期为空的原因）。
 *
 * ⚠️ 这类缺陷**单测抓不到**（react 不在依赖内，无法渲染），故用源码级断言锁住
 * 三处**缺一不可**的收缩约束。少任何一处，长 id 都会再次把开关顶出可视区。
 */
describe('模型行布局：长 id 不得把开关挤出可视区（源码级回归）', () => {
  const styles = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/jet-hub-styles.js'),
    'utf8',
  )

  /** 取出某个选择器的规则体，便于逐条断言（避免跨规则误匹配）。 */
  const ruleOf = (selector) => {
    const re = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`)
    const m = re.exec(styles)
    expect(m, `未找到样式规则 ${selector}`).not.toBeNull()
    return m[1]
  }

  /**
   * 关键修复 1：单列 grid 必须显式 `minmax(0, 1fr)`。
   *
   * 默认的 `auto` 列会让列宽按最宽内容撑开 —— 这是溢出的**第一层**原因。
   */
  it('.dim-jh-modelList 的列宽为 minmax(0, 1fr)（否则列按最宽内容撑开）', () => {
    expect(ruleOf('.dim-jh-modelList')).toContain('grid-template-columns: minmax(0, 1fr)')
  })

  /** 关键修复 2：行自身要 `min-width: 0`，否则作为 grid 项仍拒绝收缩。 */
  it('.dim-jh-modelRow 有 min-width: 0（grid 项默认 min-width:auto 会拒绝收缩）', () => {
    expect(ruleOf('.dim-jh-modelRow')).toMatch(/min-width:\s*0/)
  })

  /**
   * 关键修复 3：id 必须**可收缩**。
   *
   * `flex: none` 会让它保持内容宽度，长 id 直接把开关顶出去 —— 这是**最直接**
   * 的成因，也是本次修复的核心。
   */
  it('.dim-jh-modelId 可收缩（不得是 flex: none）', () => {
    const rule = ruleOf('.dim-jh-modelId')
    expect(rule, 'id 必须能收缩，否则长 id 会把开关顶出可视区').not.toMatch(/flex:\s*none/)
    expect(rule).toMatch(/min-width:\s*0/)
  })

  /** 展示名同样必须可收缩（否则长名也会顶宽整行）。 */
  it('.dim-jh-modelName 可收缩', () => {
    expect(ruleOf('.dim-jh-modelName')).toMatch(/min-width:\s*0/)
  })

  /**
   * 兜底：列表区不得出现横向滚动。
   *
   * 主修复是上面三条收缩约束；`overflow-x: hidden` 是**兜底** ——
   * 没有它时，任何一行偶然溢出都会让整个弹窗横向滚动，而横向滚动条会把
   * 每一行的开关一起推出可视区。
   */
  it('.dim-jh-modalBody 禁止横向滚动（兜底，防止开关被整体推出）', () => {
    expect(ruleOf('.dim-jh-modalBody')).toContain('overflow-x: hidden')
  })

  /** 开关自身必须 `flex: none`（它是目标控件，绝不能被压缩到看不见）。 */
  it('.dim-jh-switch 不参与收缩（它是目标控件，必须保持可见尺寸）', () => {
    expect(ruleOf('.dim-jh-switch')).toMatch(/flex:\s*none/)
  })
})

/**
 * 搜索框的两处**真实缺陷**守卫（源码级）。
 *
 * ## 由来（用户报障，两条）
 *
 * > 「搜索框在深色模式下输入的文字是白色的和底色一样看不见文字」
 * > 「输入文字后整个弹框的位置会发生改变，有点突兀」
 *
 * 两条都是**我的改动引入**的（搜索框是新增功能），且都已在本地复现确认：
 *
 * 1. **深色模式看不见文字** —— `.dim-jh-input` 的背景写的是
 *    `var(--dsw-alias-bg-input, #fff)`，而主题里**根本没有** `bg-input` 这个 token
 *    （真实的是 `bg-base` / `bg-layer-1/2/3`）。`var()` 遇不存在的 token **不报错**，
 *    静默取 fallback `#fff` → 深色模式下浅色文字配白底。
 * 2. **弹窗位置跳动** —— 弹窗高度随列表长度变化，而遮罩用 `align-items: center`，
 *    于是高度变化直接变成整体位移。实测输入搜索词后 top 从 4px 跳到 187px。
 *
 * ⚠️ 单测抓不到（CSS 变量解析与布局都不在测试环境里），故用源码级断言 +
 * 独立的 `verify-layout.mjs`（无头 Edge 实测）双重锁住。
 */
describe('搜索框缺陷守卫：主题 token 与弹窗位置（源码级回归）', () => {
  const styles = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/jet-hub-styles.js'),
    'utf8',
  )

  const ruleOf = (selector) => {
    const re = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`)
    const m = re.exec(styles)
    expect(m, `未找到样式规则 ${selector}`).not.toBeNull()
    return m[1]
  }

  /**
   * ⚠️ 输入框背景**不得**引用不存在的 token。
   *
   * `--dsw-alias-bg-input` 在主题里不存在（真实 token 是 bg-base / bg-layer-1/2/3）。
   * 这个断言是「白字白底」缺陷的直接防线。
   */
  it('.dim-jh-input 不引用不存在的 --dsw-alias-bg-input', () => {
    const rule = ruleOf('.dim-jh-input')
    expect(rule, '引用了不存在的 token，深色模式下会静默 fallback 成白底').not.toContain('--dsw-alias-bg-input')
    // 必须用真实存在的 token
    expect(rule).toMatch(/background:\s*var\(--dsw-alias-bg-(layer-1|layer-2|base)\)/)
  })

  /**
   * ⚠️ 输入框背景**不得留浅色 fallback**。
   *
   * 留着 `#fff` 会让 token 再次拼错时**静默**退化成白底 —— 那正是本次缺陷
   * 长期没被发现的原因。宁可取不到值时背景透明（能一眼看出问题），也不要
   * 一个看起来正常、却在深色模式下毁掉可读性的 fallback。
   */
  it('.dim-jh-input 的背景不保留浅色 fallback（避免掩盖 token 拼错）', () => {
    const rule = ruleOf('.dim-jh-input')
    expect(rule).not.toMatch(/background:\s*var\(--dsw-alias-bg-[a-z0-9-]+,\s*#fff\)/)
  })

  /** placeholder 用官方 dimmed 色：默认色在深色模式下对比度不足。 */
  it('.dim-jh-input::placeholder 使用 dimmed 色', () => {
    expect(styles).toMatch(/\.dim-jh-input::placeholder\s*\{[^}]*--dsw-alias-label-dimmed/)
  })

  /**
   * ⚠️ 所有弹窗一律**垂直居中**（2026-10-26 用户需求「检查所有弹窗，都调整为居中显示」）。
   *
   * 历史：2026-10-07 曾为「弹窗上下跳」把模型列表弹窗改成顶部锚定
   * （`.dim-jh-modalOverlay--top` + `align-items: flex-start`）。那个修饰类
   * 已整体删除，跳动问题改由 `.dim-jh-modal` 的 `min-height` 兜底。
   * 本表钉住「居中」这个口径，防止有人为修跳动又把它改回顶锚。
   */
  it('弹窗遮罩必须垂直居中（不得退回顶部锚定）', () => {
    expect(styles).toMatch(/\.dim-jh-modalOverlay\s*\{[^}]*align-items:\s*center/)
    expect(styles, '顶部锚定修饰类已被删除，不要再加回来')
      .not.toMatch(/\.dim-jh-modalOverlay--top\s*\{/)
  })

  /** 居中后高度变化仍会让弹窗位移，靠 min-height 把区间压窄。 */
  it('弹窗有 min-height 兜底（居中的代价：高度变化会变成整体位移）', () => {
    expect(styles).toMatch(/\.dim-jh-modal\s*\{[^}]*min-height:\s*min\(300px/)
  })

  /** 客户端不得再用顶锚修饰类（用了就说明 CSS 已删而 JS 没跟）。 */
  it('全仓客户端代码不再出现 --top 修饰类', () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client')
    const files = ['jet-hub.js', 'opencode-proxy-modal.js', 'modelscope-key-modal.js']
    for (const file of files) {
      const js = readFileSync(resolve(dir, file), 'utf8')
      expect(js, `${file} 仍在用已删除的顶锚修饰类`).not.toContain('dim-jh-modalOverlay--top')
    }
  })
})
