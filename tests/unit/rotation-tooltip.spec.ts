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
