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

describe('视觉：强度比模型名更暗，且没有下拉（用户逐字要求）', () => {
  it('★★★ 模型名用 label-primary（亮）', () => {
    const idx = styles.indexOf('.dim-jh-badgeModelName {')
    expect(idx, '找不到模型名样式').toBeGreaterThan(-1)
    const block = styles.slice(idx, idx + 200)
    expect(block).toContain('--dsw-alias-label-primary')
  })

  it('★★★ 强度用 label-tertiary（**更暗**）', () => {
    /**
     * ⚠️ 用户原话：「思考强度字体是比模型名要暗一点的」。
     * `tertiary` 比 `secondary` 更暗 —— 用 secondary 会和胶囊内文字同色、
     * 与模型名拉不开差距（实测只差一档对比度）。
     */
    const idx = styles.indexOf('.dim-jh-badgeModelEffort {')
    expect(idx, '找不到强度样式').toBeGreaterThan(-1)
    const block = styles.slice(idx, idx + 200)
    /**
     * ⚠️ 2026-11-24 用户反馈「强度字体小了点 / 看不清」⇒ 从 tertiary 提到 secondary。
     * 仍比模型名（primary）**暗一档**，满足「强度比模型名暗」的原要求，但可读。
     */
    expect(block, '★★★ 强度必须比模型名暗一档（secondary）').toContain('--dsw-alias-label-secondary')
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
     * ⚠️ 用户 2026-11-24：「子代理的模型名及强度字体小了点，你再调大点」。
     *
     * 胶囊是「补语」（11px，用户 2026-11-20 明确要求小一号）；
     * 模型标签是**主信息** ⇒ 取 12px，与宿主主代理页面观感一致。
     */
    const idx = styles.indexOf('.dim-jh-badgeModelPill {')
    expect(idx).toBeGreaterThan(-1)
    const block = styles.slice(idx, idx + 900)
    expect(block, '★★★ 必须是 12px（不能跟胶囊同为 11px）').toContain('font-size: 12px')
    expect(block, '★★★ 不能是 11px').not.toContain('font-size: 11px')
  })

  it('★★ 与胶囊之间留 10px（宿主同间距感）', () => {
    const idx = styles.indexOf('.dim-jh-badgeModelPill {')
    const block = styles.slice(idx, idx + 300)
    expect(block).toContain('margin-left: 10px')
  })
})
