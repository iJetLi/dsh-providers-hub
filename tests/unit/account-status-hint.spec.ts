/**
 * 面板红条的**自救入口文案**（Gitee issue IKS2MV）。
 *
 * ## 为什么这条值得单独立文件
 *
 * 对抗审计 E9 实测打穿过：红条写着「点『测试』确认已恢复」，而
 * `supportsAccountTest` **只在 gemini 登记** ⇒ buddy / workbuddy **没有那个按钮**。
 * 用户照着文案找，会发现面板上根本没有「测试」⇒ 文案把用户指到一个不存在的入口，
 * 比不写更糟（他只会以为面板坏了）。
 *
 * 判据必须与**真实渲染出来的按钮**同源：`onTest` 存在 ⇒ 有「测试」按钮；
 * 不存在 ⇒ 文案必须改口（指向「重置」，并说明重置不做验证）。
 */
import { describe, expect, it } from 'vitest'
import { policyBlockedHint } from '../../plugin-src/client/account-status.js'

describe('封禁红条的自救入口文案（issue IKS2MV）', () => {
  it('★ 有「测试」按钮（onTest 存在）⇒ 文案指向「测试」', () => {
    const hint = policyBlockedHint(true)
    expect(hint).toContain('「测试」')
    expect(hint).toContain('「重置」')
  })

  it('★★ 没有「测试」按钮 ⇒ **不得**让用户去点「测试」', () => {
    const hint = policyBlockedHint(false)
    expect(hint, 'buddy/workbuddy 没有探活按钮，文案却指向它 ⇒ 用户找不到入口').not.toContain('点「测试」')
    // 必须改口成「重置」，并说明它不做验证（否则用户以为重置=验证过）
    expect(hint).toContain('「重置」')
    expect(hint).toContain('不会验证')
  })

  it('★ 文案必须说明「全部模型都不可用」（封禁是账号级，不是某个模型）', () => {
    expect(policyBlockedHint(true)).toContain('全部模型')
    expect(policyBlockedHint(false)).toContain('全部模型')
  })
})
