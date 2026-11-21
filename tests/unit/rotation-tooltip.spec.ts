/**
 * 「轮换起点」tooltip 的**内容守卫**（用户 2026-11-11 要求）。
 *
 * ## 为什么需要它
 *
 * 这个控件的语义很容易被误解，而误解的代价是「功能看起来没生效」——
 * 本轮排查前前后后花了十几轮，其中多数困惑正是因为**说明没写清**。
 *
 * ## 只锁「必须说清的四件事」，不锁措辞
 *
 * ⚠️ 本仓有过「文案断言过度导致维护成本高」的教训 ⇒ 这里**不**断言完整句子，
 * 只断言关键概念**存在**。改文案措辞不该让本文件变红。
 *
 * ## 四条（每条都对应一个真实误解）
 *
 * | 断言 | 对应的误解 |
 * |---|---|
 * | 含「会话」 | 以为改的是全局设置，换会话发现「没了」 |
 * | 含「永久积分」 | 以为它遵守「临期优先」，实际会先烧永久积分 |
 * | 含「默认」 | 不知道怎么恢复 |
 * | 含「不改」/「不影响」 | 以为它改变了选号策略（v1 废弃命名「优先账号」的坑） |
 */
import { CREDIT_ORDER_TIER, rotationTierShiftHint } from '../../plugin-src/client/badge-model.js'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'plugin-src', 'client', 'usage-badge.js')
const source = readFileSync(SRC, 'utf8')

/** 从源码里取出 tooltip 常量的字符串字面量内容。 */
function tipText() {
  const start = source.indexOf('const ROTATION_TIP_LABEL')
  if (start < 0) throw new Error('未找到 ROTATION_TIP_LABEL')
  /**
   * ⚠️ **不能按「某句话」找结束位置**（第一版就这么写，结果截断了最后一行）：
   * 那句「换会话回到「默认」」本身就是**最后一段**，`indexOf` 找到的是它自己的
   * 起点，于是 `slice` 在最后一段之前就结束了 ⇒ 断言「含会话」假红。
   * ⇒ 改为**从 `=` 之后找到第一个裸分号**（字符串内的 `；` 是全角，不会误判）。
   */
  const from = source.indexOf('=', start) + 1
  const end = source.indexOf(';', from)
  const region = source.slice(from, end < 0 ? from + 2000 : end)
  const parts = region.match(/'[^']*'/g) ?? []
  return parts.map((s) => s.slice(1, -1)).join('')
}

describe('轮换起点 tooltip 的存在性', () => {
  it('★ 定义了 ROTATION_TIP_LABEL 与 ROTATION_TIP_SELECT', () => {
    expect(source).toMatch(/const ROTATION_TIP_LABEL\s*=/)
    expect(source).toMatch(/const ROTATION_TIP_SELECT\s*=/)
  })

  it('★ 标签上挂了 title（下拉展开时 select 的 title 不显示）', () => {
    // 标签 span 必须带 title: ROTATION_TIP_LABEL
    expect(source).toMatch(/className:\s*'dim-jh-badgeRotationLabel',[\s\S]{0,200}title:\s*ROTATION_TIP_LABEL/)
  })

  it('★ 有 ⓘ 图标且挂在 ROTATION_TIP_LABEL 上', () => {
    expect(source).toMatch(/dim-jh-badgeRotationInfo/)
    // 图标节点里必须有 title 或 aria-label 指向同一文案
    expect(source).toMatch(/dim-jh-badgeRotationInfo[\s\S]{0,400}title:\s*ROTATION_TIP_LABEL/)
  })

  it('★ select 用精简版（避免长文案遮住弹窗）', () => {
    expect(source).toMatch(/title:\s*ROTATION_TIP_SELECT/)
  })
})

describe('轮换起点 tooltip 必须说清的四件事', () => {
  const text = tipText()

  it('① 含「会话」—— 作用域是当前会话', () => {
    expect(text).toContain('会话')
  })

  it('② 含「永久积分」—— 方案 A 的核心取舍（起点优先于档位）', () => {
    expect(text).toContain('永久积分')
  })

  /**
   * ⚠️ **必须单独断言「先消耗永久积分」这个后果**，且要**匹配完整短语**。
   *
   * 两版都失败过（变异实测）：
   * 1. 第一版只断言含「永久积分」字样 —— 把整句删掉后，前一句
   *    「若指定一个『只有永久积分』的账号」**仍含**该字样 ⇒ 照样绿；
   * 2. 第二版断言 `/先消耗|先用|优先消耗/` —— 而文案里「余额分档的渠道会
   *    **优先用**在临期积分更多的账号」这句**也含「优先用」** ⇒ 仍被误命中。
   *
   * ⇒ 必须锁「先消耗永久积分」这个**完整短语**（它只出现在讲后果的那一句里）。
   */
  it('②b 必须说明「会先消耗永久积分」这个后果', () => {
    expect(text).toContain('先消耗永久积分')
  })

  it('③ 含「默认」—— 恢复默认的入口', () => {
    expect(text).toContain('默认')
  })

  it('④ 含「不改」或「不影响」—— 它不改变选号策略', () => {
    expect(/不改|不影响/.test(text)).toBe(true)
  })

  it('⑤ 给出环形轮换的例子（否则「选 4」会被读成「只用 4」）', () => {
    expect(text).toMatch(/→/) // 有箭头 ⇒ 有顺序示意
  })

  it('★ 不出现 v1 的废弃命名「优先账号」', () => {
    // 该命名会让人以为它改变优先级顺序（v1 已废弃）
    const region = source.slice(source.indexOf('const ROTATION_TIP_LABEL'), source.indexOf('const ROTATION_TIP_SELECT'))
    expect(region).not.toContain('优先账号')
  })
})

describe('不可用原因的说明', () => {
  it('★ 不写死「15 天」（窗口由 DSH_BUDDY_EXPIRING_WINDOW_DAYS 可覆盖）', () => {
    const i = source.indexOf('const ROTATION_REASON_TEXT')
    const region = source.slice(i, i + 800)
    expect(region).not.toMatch(/15\s*天/)
  })

  /**
   * ⚠️ **只剩三类**（用户 2026-11-10 要求）：`account.getRotation` 不再返回停用账号
   * ⇒ 停用账号在 UI 上根本不出现 ⇒ `disabled` 这个 reason 已成死代码，已删。
   */
  it('三类原因都有文案（`disabled` 已随「下拉框不显示停用账号」删除）', () => {
    for (const key of ['policy-blocked', 'rate-limited', 'no-expiring']) {
      expect(source).toMatch(new RegExp(`'${key}':\\s*'`))
    }
    // ⚠️ 反向断言：`disabled` **不应再存在**（否则是死代码）
    expect(source).not.toMatch(/'disabled':\s*'该账号已停用/)
  })
})

/**
 * ★★★ **两条起点提示必须互斥，且降档只占一行**（2026-11-21 真实缺陷）。
 *
 * ## 用户报障（截图实证）
 *
 * > 「怎么有两行提示呢？」
 *
 * 两条提示**同时渲染**，而且**互相矛盾**：
 *
 * | 行 | 文案 | 含义 |
 * |---|---|---|
 * | 1 | 「起点是「短期」档：**先烧它的**短期积分」 | 先烧起点自己的 |
 * | 2 | 「已交回轮换队列：**先按档位轮流消耗其他账号**」 | 先烧别人的 |
 *
 * ⇒ 一句让先烧它、另一句让先烧别人，**直接冲突**。
 *
 * ## 根因
 *
 * 渲染处注释早就写着「与下面的降档提示**互斥渲染**（同时出现会自相矛盾）」
 * —— **注释写对了，代码没实现**：两处是**独立的 `=== null` 判断**。
 *
 * 触发条件（用户截图）：起点选定时的档位是「临期」，现在只剩「短期」
 * ⇒ `rotationStartHint(expiring)` 与 `rotationTierShiftHint('imminent', expiring)`
 * **都返回非 null**。
 *
 * ## 为什么此前没被发现
 *
 * `badge-model.spec.ts` 只**分别**测两个函数的返回值，
 * **没有一条测「两者同时非 null」**——而那正是渲染层的真实场景。
 *
 * ## 用户对「一行」的明确要求
 *
 * > 「降档的提示信息也只需要一行就行，不要两行，太占用空间，
 * >   你可以使用 tooltip 增加更详细说明」
 */
describe('起点两条提示：互斥 + 降档只占一行', () => {
  const CLIENT = join(process.cwd(), 'plugin-src', 'client')
  const usageBadgeSource = readFileSync(join(CLIENT, 'usage-badge.js'), 'utf8')
  const badgeModelSource = readFileSync(join(CLIENT, 'badge-model.js'), 'utf8')

  it('★★★ 渲染处必须用 `tierShiftHint !== null` 压制 `startHint`', () => {
    /**
     * ⚠️ 判据必须落在**压制条件**上，而不只是「两个变量都存在」。
     *
     * 修复前是两处独立的 `=== null`：
     * ```js
     * startHint === null ? null : <div>{startHint}</div>
     * tierShiftHint === null ? null : <div>{tierShiftHint}</div>
     * ```
     * ⇒ 那个写法**也能通过**「两个变量都存在」这类宽松断言。
     */
    expect(usageBadgeSource, '必须有 `startHint === null || tierShiftHint !== null` 压制条件')
      .toMatch(/startHint\s*===\s*null\s*\|\|\s*tierShiftHint\s*!==\s*null/)
  })

  it('★★★ 压制条件必须在 `startHint` 的渲染之前（不是写在别处）', () => {
    // 取「startHint 的渲染块」：从压制条件到 key: 'tierHint'
    const guardIdx = usageBadgeSource.indexOf('startHint === null || tierShiftHint !== null')
    const tierHintIdx = usageBadgeSource.indexOf("key: 'tierHint'", guardIdx)
    expect(guardIdx, '找不到压制条件').toBeGreaterThan(-1)
    expect(tierHintIdx, '压制条件必须紧邻 tierHint 渲染').toBeGreaterThan(guardIdx)
    // 两者之间不得出现别的渲染分支（否则条件可能挂错了块）
    const between = usageBadgeSource.slice(guardIdx, tierHintIdx)
    expect(between.length, '压制条件与渲染点之间不该隔着大段代码').toBeLessThan(800)
  })

  it('★★★ 降档文案必须是**单行**（不得再拼第二段）', () => {
    /**
     * 修复前是两段字符串拼接：
     * ```js
     * return `ℹ️ 起点的「${from}」积分已用完（现剩「${to}」）⇒ 已交回轮换队列：`
     *   + `先按档位轮流消耗其他账号，绕一圈后才轮到它`;
     * ```
     * ⇒ 面板里折成 2 行。
     *
     * ⚠️ **必须定位到 `return` 那一行**（不是注释）：
     * `badge-model.js` 的注释里也写着「已交回队列」，直接 `indexOf` 会命中注释。
     */
    const returnIdx = badgeModelSource.indexOf('已交回队列`;')
    expect(returnIdx, '找不到降档文案的 return 行').toBeGreaterThan(-1)
    const lineStart = badgeModelSource.lastIndexOf('\n', returnIdx) + 1
    const line = badgeModelSource.slice(lineStart, returnIdx + '已交回队列`;'.length)

    // 该行必须是完整的一行（含三个关键事实）
    expect(line, '必须含「已用完」').toContain('已用完')
    expect(line, '必须含「现剩」').toContain('现剩')
    expect(line, '必须含「已交回队列」（否则会被当成 bug）').toContain('已交回队列')
    // ⚠️ 反向：不得出现「绕一圈后才轮到它」这类长解释（已移进 tooltip）
    expect(line, '长解释必须移进 tooltip，不得留在行内')
      .not.toContain('绕一圈后才轮到它')
  })

  it('★★ 完整规则仍必须在 tooltip 里（不能因为精简文案就丢掉说明）', () => {
    const shiftIdx = usageBadgeSource.indexOf("key: 'tierShiftHint'")
    expect(shiftIdx).toBeGreaterThan(-1)
    const block = usageBadgeSource.slice(shiftIdx, shiftIdx + 900)
    expect(block, 'tooltip 必须说明「按档位优先」').toContain('按档位优先')
    expect(block, 'tooltip 必须说明「绕一圈后才再轮到它」').toContain('绕一圈后才再轮到它')
  })
})

/**
 * ★★★ **行为级守卫**（PR #136 合并前审计 P1，本仓红线）。
 *
 * ## 为什么这组必须存在
 *
 * 上面那 17 条**全是源码文本断言**（`readFileSync` + `toMatch`/`indexOf`），
 * 审计实测 **6 种「保留字面量但让代码失效」的形态全部 17/17 绿**：
 * `&& false`、`|| true`、`renderRotation` 顶部 `return null`、条件只留注释、
 * 删 `title` 留注释关键词、`rotationTierShiftHint` 恒 null。
 * 这正是 `docs/agent-notes/client-ui.md` 记的那条红线
 *（「源码文本断言的共同弱点：`if (false)` 短路禁用」）。
 *
 * ## 这组为什么能做到行为级
 *
 * `rotationTierShiftHint(selectionTier, currentTier)` 本身就是**导出的纯函数**
 * ⇒ 直接**真调用**它，不经源码文本、不依赖渲染。
 *（渲染层「互斥」那条仍无行为级守卫 —— 需要真渲染组件，如实登记。）
 */
describe('rotationTierShiftHint：真调用（行为级）', () => {
  it('★★★ 降档（临期→短期）⇒ 只说「已交回队列」', () => {
    const hint = rotationTierShiftHint('imminent', CREDIT_ORDER_TIER.expiring)
    expect(hint).not.toBeNull()
    expect(hint, '降档必须告知「已交回队列」——那是用户最需要知道的事实').toContain('已交回队列')
    expect(hint, '起点档位已用完的事实也要在').toContain('已用完')
  })

  it('★★★ **升档（短期→永久）也必须说「已交回队列」**（P2 文案说谎的守卫）', () => {
    /**
     * 判据是 `tierStillHeld` 的**精确等值**（`tierNow === tierAtSelection`）：
     * 档位只要变了（升档也算）就交出首位。
     * 旧文案写「重新优先消耗它」⇒ 与降档那条互相矛盾（正是本 PR 要消灭的形态）。
     */
    /**
     * ⚠️ **方向别搞反**（我第一版就写错了）：rank 是
     * `imminent:0 → expiring:1 → permanent:2 → none:3`，
     * **rank 变小 = 档位变好 = 升档**。
     * 所以升档是 `permanent → expiring`（用户又充了短期积分），
     * 而 `expiring → permanent` 的 rank 是**变大**、那是**降档**（第一版因此没测到升档分支）。
     */
    const hint = rotationTierShiftHint('permanent', CREDIT_ORDER_TIER.expiring)
    expect(hint).not.toBeNull()
    expect(hint, '升档同样交出首位 —— 说「重新优先消耗它」是假话').toContain('已交回队列')
    expect(hint, '不得再出现「重新优先」').not.toContain('重新优先')
  })

  it('★★★ 档位没变 ⇒ null（不得凭空冒出一条提示）', () => {
    expect(rotationTierShiftHint('expiring', CREDIT_ORDER_TIER.expiring)).toBeNull()
    expect(rotationTierShiftHint('permanent', CREDIT_ORDER_TIER.permanent)).toBeNull()
  })

  it('★★ 输入非法 ⇒ null（不猜）', () => {
    expect(rotationTierShiftHint('', CREDIT_ORDER_TIER.expiring)).toBeNull()
    expect(rotationTierShiftHint('expiring', Number.NaN)).toBeNull()
    expect(rotationTierShiftHint(undefined, CREDIT_ORDER_TIER.expiring)).toBeNull()
  })
})
