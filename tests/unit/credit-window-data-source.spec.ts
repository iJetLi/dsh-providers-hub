/**
 * ★★★ **「分档窗口三项失效」的回归守卫**（用户 2026-11-20 报障）。
 *
 * ## 三个报障
 *
 * 1. 没有实时覆盖账号数量显示（恒 0）
 * 2. 没有实时预览积分和色柱条（恒 0）
 * 3. 弹窗与背景颜色没有区分
 *
 * ## 前两个是**同一个根因**
 *
 * 弹窗的 `accounts` prop 传的是 `accounts`（= 账号池列表 `providerRow.accounts`），
 * 而它的每条是 `{ id, credentialRef, enabled }` —— **没有 `balance`**。
 * ⇒ `account.balance?.packages` 恒 `undefined` ⇒ `computeCoverage` 把每个账号
 * 都算成「无可用积分」⇒ **覆盖数恒 0、三档金额恒 0，且无任何报错**。
 *
 * 正确来源是 `credits` state：`{ [accountId]: { balance, error, extra } }`。
 *
 * ## 为什么用源码文本断言（并解释它够用的理由）
 *
 * 这段是 `ProviderPanel` 的 JSX props 求值，**只能**在 React 渲染里验证
 *（该文件 import react，单测跑不进去）。但这里要守的是一个**极窄的事实**：
 * 「弹窗取 packages 时必须走 `credits[...]` 而不是 `accounts[...]`」。
 * 配合 `credit-window-ui.spec.ts` 的行为级覆盖统计用例，两者互补：
 * 前者保证「算法对」，后者保证「喂进去的数据源对」。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const JET_HUB = join(process.cwd(), 'plugin-src', 'client', 'jet-hub.js')

/** 剥掉注释行（避免注释里解释这个坑时误判）。 */
function codeOf(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    })
    .join('\n')
}

describe('分档窗口的数据源（覆盖数/预览恒 0 的根因）', () => {
  /** 截取 `CreditWindowModal` 的 props 块。 */
  function modalPropsCode() {
    const source = readFileSync(JET_HUB, 'utf8')
    const start = source.indexOf('React.createElement(CreditWindowModal, {')
    expect(start, '应能找到 CreditWindowModal 的创建点').toBeGreaterThan(-1)
    return codeOf(source.slice(start, start + 2000))
  }

  it('★★★ 逐包数据必须从 `credits` state 取，不得从 `accounts` 取', () => {
    const props = modalPropsCode()
    /**
     * ⚠️ 核心判据：出现 `credits[` 索引访问（正确），
     *    且**不得**出现 `account.balance`（错误 —— 池列表没有 balance 字段）。
     */
    expect(props, '必须从 credits state 取逐包数据').toContain('credits[')
    expect(props, '不得直接读 account.balance（账号池列表没有这个字段）').not.toContain('account.balance')
  })

  it('★★ 必须读 `balance.packages`（逐包数据在 balance 里，不是顶层）', () => {
    const props = modalPropsCode()
    expect(props, '逐包数据在 balance.packages').toContain('balance?.packages')
  })

  it('★★ 传函数而非快照（每次输入变化都要读最新 state）', () => {
    const props = modalPropsCode()
    // `accounts: () =>` 是函数形态；若写成 `accounts: accounts.map(...)` 就是快照
    expect(props, 'accounts 必须是函数（惰性读取最新 state）').toMatch(/accounts:\s*\(\s*\)\s*=>/)
  })
})

describe('分档窗口的视觉区分（与背景同色的根因）', () => {
  const CSS = join(process.cwd(), 'plugin-src', 'client', 'jet-hub-styles.js')

  it('★★★ 弹窗必须有**实边框**（暗色主题下阴影看不见）', () => {
    const css = readFileSync(CSS, 'utf8')
    const rule = /\.dim-jh-windowModal \{([^}]*)\}/.exec(css)
    expect(rule, '应有 .dim-jh-windowModal 规则').not.toBeNull()
    const body = rule[1].replace(/\/\*[\s\S]*?\*\//g, '')
    expect(body, '必须有 border（窗口边界）').toMatch(/border:\s*1px solid/)
  })

  it('★★ 遮罩要比通用的更暗（弹窗浮起的视觉信号）', () => {
    const css = readFileSync(CSS, 'utf8')
    // 找到针对 windowModal 的 overlay 规则
    const rule = /\.dim-jh-modalOverlay:has\(> \.dim-jh-windowModal\) \{([^}]*)\}/.exec(css)
    expect(rule, '应有针对分档窗口的遮罩规则').not.toBeNull()
    const body = rule[1].replace(/\/\*[\s\S]*?\*\//g, '')
    // 通用遮罩是 0.32；这里必须 >= 0.5
    const m = /rgba\(0,\s*0,\s*0,\s*([\d.]+)\)/.exec(body)
    expect(m, '遮罩必须是 rgba 形式').not.toBeNull()
    expect(Number(m[1]), '遮罩不透明度必须 >= 0.5（通用是 0.32）').toBeGreaterThanOrEqual(0.5)
  })

  it('⚠️ 只改分档窗口，不动通用弹窗（避免扩大回归面）', () => {
    const css = readFileSync(CSS, 'utf8')
    const base = /\.dim-jh-modal \{[^}]*\}/.exec(css)
    expect(base, '通用 .dim-jh-modal 必须存在').not.toBeNull()
    // 通用弹窗不应有实边框（我们只给 windowModal 加）
    expect(base[0], '通用弹窗不得加实边框（只改分档窗口）').not.toMatch(/border:\s*1px solid/)
  })
})
