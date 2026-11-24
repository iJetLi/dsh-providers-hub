/**
 * ★★★ **子代理页面的「模型 + 思考强度」pill**（2026-11-24 用户需求）。
 *
 * ## 背景
 *
 * 宿主**只在主对话页**渲染模型选择器（`conversation.input.model.label` 槽位）；
 * 子代理对话页**宿主不渲染**（用户截图实证）⇒ 用户看不出子代理在用哪个模型、
 * 哪档思考强度。而该页的胶囊正是**本插件**占的槽位 ⇒ 由本插件补上。
 *
 * ## 用户三次明确的要求
 *
 * 1. > 「子代理的胶囊需要在最后增加显示当前在用的模型及思考强度」
 * 2. > 「你的方案里面都太乱了，能不能依照主代理页面一样，这样做一个？」
 *    （⇒ 放在胶囊**右侧**，与宿主主代理页面同布局，不塞进胶囊里）
 * 3. > 「要注意到思考强度字体是比模型名要暗一点的，要模仿到位，然后是没有下拉的」
 *
 * ## 为什么用源码断言
 *
 * `usage-badge.js` import react，单测里无法真渲染（本仓一直如此）。
 * 但**纯逻辑判据**（哪些字段、什么条件下渲染什么）可以用源码锚点 + 行为级
 * 小函数固定。本文件的重点是**三条视觉要求**必须逐条落实。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const badge = readFileSync(join(here, '../../plugin-src/client/usage-badge.js'), 'utf8')
const styles = readFileSync(join(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

describe('数据来源：从会话快照读，无需新 RPC', () => {
  it('★★★ 必须读 reasoningEffort（强度）', () => {
    expect(
      badge,
      '★★★ 只读 model 不读 reasoningEffort ⇒ 强度永远显示不出来',
    ).toContain('current?.reasoningEffort')
  })

  it('★★★ 强度是可选的（模型不支持思考时为 null）', () => {
    /**
     * ⚠️ `ModelSelection.reasoningEffort` 是 `?`（可选）。
     * 不支持思考的模型（如 DeepSeek-V4.1-Flash）宿主不声明 ⇒ 必须用 `null`
     * 表示「没有强度」，渲染时隐藏那一段。
     */
    expect(badge).toMatch(/effort: typeof current\?\.reasoningEffort === 'string'[\s\S]{0,120}: null/)
  })

  it('★★ 空模型名 ⇒ 不产出 modelInfo（不显示空 pill）', () => {
    expect(badge).toContain('current.model.length > 0')
  })
})

describe('渲染位置：胶囊右侧（模仿宿主主代理页面）', () => {
  it('★★★ pill 必须是胶囊容器的**兄弟**，不能塞进胶囊按钮里', () => {
    /**
     * ⚠️ 实际结构（逐行）：
     *
     * ```
     * 1710  const modelPill = isSubagentBadge && modelInfo !== null   ← 定义
     * 1711    ? React.createElement('span', { ... }, [ ... ])
     * 1724    : null
     * 1726  return React.createElement('div', { className: 'dim-jh-badge', ref: root }, [
     * 1727    React.createElement('button', { ... 胶囊 ... }),
     * 1739    open ? renderPopover() : null,
     * 1740    modelPill,                                            ← 兄弟元素
     * 1741  ]);
     * ```
     *
     * ⇒ 定义在容器**之前**（我第一版断言「定义在容器之后」，测试假红）。
     */
    const defIdx = badge.indexOf('const modelPill = ')
    expect(defIdx, '★★★ 找不到 modelPill 定义').toBeGreaterThan(-1)

    /** ① className 存在。 */
    expect(badge).toContain("className: 'dim-jh-badgeModelPill'")

    /** ② 容器数组里必须有 `modelPill,`（作为兄弟元素）。 */
    const containerIdx = badge.indexOf("className: 'dim-jh-badge', ref: root")
    expect(containerIdx).toBeGreaterThan(defIdx)

    /** ③ 用**精确切片**取容器块：从容器起、到 `]);` 止。 */
    const containerEnd = badge.indexOf(']);', containerIdx)
    expect(containerEnd, '找不到容器收尾').toBeGreaterThan(containerIdx)
    const containerBlock = badge.slice(containerIdx, containerEnd)
    expect(
      containerBlock,
      '★★★ modelPill 必须作为容器的兄弟元素插入',
    ).toContain('modelPill,')

    /**
     * ④ ⚠️ 不能出现在**胶囊按钮**的 children 里（用户明确否掉了「塞进胶囊」）。
     *
     * 实际结构：
     * ```
     * 1727    React.createElement('button', {
     * 1728      key: 'btn',
     * ...
     * 1735    }, [
     * 1736      ... dot
     * 1737      collapsed,
     * 1738    ]),
     * 1739    open ? renderPopover() : null,
     * 1740    modelPill,                       ← 在按钮**外面**
     * 1741  ]);
     * ```
     *
     * ⇒ 精确切片：从 `key: 'btn'` 到第一个 `]),`。
     */
    const btnIdx = badge.indexOf("key: 'btn'", containerIdx)
    expect(btnIdx, '找不到胶囊按钮').toBeGreaterThan(-1)
    const btnEnd = badge.indexOf(`]),`, btnIdx)
    expect(btnEnd, '找不到胶囊按钮收尾').toBeGreaterThan(btnIdx)
    const btnBlock = badge.slice(btnIdx, btnEnd + 3)
    expect(
      btnBlock,
      '★★★ 不能塞进胶囊按钮（用户明确否掉了这个方案）',
    ).not.toContain('modelPill')
  })

  it('★★★ 只在子代理页面渲染（主代理由宿主渲染，不能重复两个）', () => {
    /**
     * ⚠️ 判据复用 `selectedAccountName !== null` —— 那个字段**只在子代理会话下发**
     *（见 `account.getRotation` 的 `isSubagentSessionForBadge`）。
     * 不另写一套判据（本仓红线：同一语义不得两套）。
     */
    expect(
      badge,
      '★★★ 必须用子代理判据（否则主代理页面会出现两个模型标签）',
    ).toMatch(/const isSubagentBadge = rotationState !== null && rotationState\.selectedAccountName !== null/)
  })

  it('★★ 快照未就绪 ⇒ 整块不渲染（不留空尾巴）', () => {
    expect(badge).toContain('isSubagentBadge && modelInfo !== null')
  })
})

describe('模型名必须与档次窗口下拉框**一模一样**', () => {
  const rpc = readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8')

  it('★★★ 服务端必须下发 modelName（与 m.name 同源）', () => {
    /**
     * 用户原话：「模型名字要跟主代理的模型列表一模一样，
     * 也就是跟档次窗口模型下拉框的一模一样呀」
     *
     * ⚠️ 档次窗口下拉框显示的是 `m.name`（如 `Hy4 flash · x0.00→免费 FREE`），
     * 而会话快照只有 id ⇒ 必须由服务端翻译。
     */
    expect(rpc, '★★★ getRotation 必须下发 modelName').toContain('modelName')
  })

  it('★★★ 名字必须取自 ctx.llm.listModels（与下拉框同一条取数路径）', () => {
    const idx = rpc.indexOf('let modelDisplayName')
    expect(idx, '找不到 modelDisplayName 计算').toBeGreaterThan(-1)
    /**
     * ⚠️ 块边界必须精确到函数结尾 —— `idx + 900` 会越界到后面的
     * `credits.window.models`（那里也有 `ctx.llm.listModels`），
     * 于是删掉 getRotation 里的赋值照样绿（我第一版就这么漏的）。
     */
    const blockEnd = rpc.indexOf('return {', idx)
    expect(blockEnd, '找不到计算块结尾').toBeGreaterThan(idx)
    const block = rpc.slice(idx, blockEnd)

    expect(block, '★★★ 必须用 listModels（与 credits.window.models 同源）').toContain('ctx.llm.listModels')
    expect(block, '★★★ 必须取 m.name').toContain('.name')
    /** ⚠️ **必须真的赋值**给 modelDisplayName（只写不赋 = 不下发）。 */
    expect(block, '★★★ 必须真的赋值（否则客户端拿不到）').toContain('modelDisplayName = name')
    /**
     * ⚠️ 不得自己拼（id + 倍率）—— 那会与宿主 m.name 漂移。
     */
    expect(block, '★★★ 不能自己拼名字').not.toMatch(/\$\{modelId\}.*x\d/)
  })

  it('★★★ 客户端优先用 modelName，取不到才回落 id', () => {
    expect(
      badge,
      '★★★ 必须优先用服务端下发的 modelName',
    ).toContain('rotationState?.modelName ?? modelInfo.model')
  })

  it('★★ 服务端取不到名字时必须省略该键（客户端才能回落）', () => {
    const idx = rpc.indexOf('let modelDisplayName')
    const block = rpc.slice(idx, idx + 900)
    expect(block, '★★ 必须用 undefined 表示「没有」，而不是空串').toContain('let modelDisplayName: string | undefined')
  })
})

describe('视觉：强度比模型名更暗，且没有下拉（用户逐字要求）', () => {
  it('★★★ 模型名用 label-primary（亮）', () => {
    const idx = styles.indexOf('.dim-jh-badgeModelName {')
    expect(idx, '找不到模型名样式').toBeGreaterThan(-1)
    const block = styles.slice(idx, idx + 200)
    expect(block).toContain('--dsw-alias-label-primary')
  })

  it('★★★ 强度用 label-tertiary（**更暗**，用户要求回退）', () => {
    /**
     * ⚠️ 判据必须限定在 **`.dim-jh-badgeModelEffort` 块内** ——
     * 全文搜 `tertiary` 会被别处（胶囊的 `.dim-jh-badgeCount` 等）满足
     *（我第一版就这么漏的：把 CSS 改成 secondary 后测试照样绿）。
     */
    const start = styles.indexOf('.dim-jh-badgeModelEffort {')
    expect(start, '找不到强度样式块').toBeGreaterThan(-1)
    const end = styles.indexOf('}', start)
    const block = styles.slice(start, end)

    expect(block, '★★★ 强度必须是 tertiary（用户要求更暗）').toContain('--dsw-alias-label-tertiary')
    expect(block, '★★★ 不能是 secondary（那是被用户否掉的版本）').not.toContain('--dsw-alias-label-secondary')
    expect(block, '★★★ 不能用 primary（那就和模型名一样亮了）').not.toContain('--dsw-alias-label-primary')
  })

  it('★★★ **没有下拉箭头**（用户明确要求）', () => {
    /**
     * 它是纯展示，不可点。画了箭头会误导用户以为能改。
     *
     * ⚠️ 窗口必须**精确到 modelPill 自身**（`const modelPill` → `    : null`）——
     * 「从 className 往后 900 字符」会越界到后面的胶囊按钮
     *（那里有 `createElement('button'`）⇒ 假红。我第一版就这么错的。
     */
    const defIdx = badge.indexOf('const modelPill = ')
    expect(defIdx, '找不到 modelPill 定义').toBeGreaterThan(-1)
    /** 定义块的结束：下一个空行后的 `  return React.createElement` 之前。 */
    const nextReturn = badge.indexOf('  return React.createElement', defIdx)
    expect(nextReturn, '找不到定义块结尾').toBeGreaterThan(defIdx)
    const block = badge.slice(defIdx, nextReturn)

    expect(block, '★★★ 不得出现下拉箭头').not.toMatch(/[⌄⌃▾▿▼]/)
    expect(block, '★★★ 不得是 button（会暗示可点）').not.toContain("createElement('button'")
  })

  it('★★★ 字号必须比胶囊大一号（用户反馈「小了点」）', () => {
    /**
     * ⚠️ 用户 2026-11-24 三次调整后定案：**14px**。
     *
     * 第一次 11px（跟胶囊同字号）⇒ 用户「小了点」；
     * 第二次 12px ⇒ 用户仍觉得小；
     * 第三次 **14px**（本次）。
     *
     * 胶囊是「补语」（11px，用户 2026-11-20 明确要求小一号）；
     * 模型标签是**主信息** ⇒ 本就该明显大于胶囊。
     */
    const idx = styles.indexOf('.dim-jh-badgeModelPill {')
    expect(idx).toBeGreaterThan(-1)
    const block = styles.slice(idx, idx + 900)
    expect(block, '★★★ 必须是 14px').toContain('font-size: 14px')
    expect(block, '★★★ 不能回到 11/12px（用户已两次说小）').not.toMatch(/font-size: 1[12]px/)
  })

  it('★★ 与胶囊之间留 10px（宿主同间距感）', () => {
    const idx = styles.indexOf('.dim-jh-badgeModelPill {')
    const block = styles.slice(idx, idx + 300)
    expect(block).toContain('margin-left: 10px')
  })
})
