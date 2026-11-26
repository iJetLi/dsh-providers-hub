/**
 * 豆包 cookie 导入的**文本归一化**（2026-11-26）。
 *
 * 这个文件钉住的是「用户粘什么都得能认」——三种真实形态（裸 cookie 串、
 * 带 `Cookie:` 前缀、整段 cURL）缺任何一种，用户都会遇到「导入失败但不知道
 * 为什么」。判据只看 `sessionid` 在不在，故这里同时保证 `sessionid` 被保留。
 *
 * @module tests/unit/doubao-cookie
 */

import { describe, expect, it } from 'vitest'
import { normalizePastedCookie } from '../../src/doubao-cookie.js'

const HAS_SESSION = (s: string) => /sessionid=[^; ]+/.test(s)

describe('★ 豆包 cookie 粘贴归一化', () => {
  it('裸 cookie 串原样保留（分号空格归一）', () => {
    const out = normalizePastedCookie('sessionid=s1;ttwid=t1;  sid_tt=x  ')
    expect(HAS_SESSION(out)).toBe(true)
    expect(out).toContain('ttwid=t1')
    expect(out.includes('  ')).toBe(false)
  })

  it('带 `Cookie:` 前缀（大小写、换行）也能认', () => {
    const out = normalizePastedCookie('Cookie: sessionid=s2;\n  ttwid=t2')
    expect(HAS_SESSION(out)).toBe(true)
    expect(out).not.toMatch(/cookie:/i)
  })

  it('整段 cURL（Copy as cURL）能从 -H cookie 里取出', () => {
    const curl = `curl 'https://www.doubao.com/chat/' \\
  -H 'cookie: sessionid=s3; ttwid=t3; msToken=m' \\
  -H 'user-agent: Mozilla/5.0'`
    const out = normalizePastedCookie(curl)
    expect(HAS_SESSION(out)).toBe(true)
    expect(out).toContain('ttwid=t3')
    // 不能把 cURL 的其它残渣当成 cookie 对
    expect(out).not.toContain('user-agent')
    expect(out).not.toContain('curl')
  })

  it('`-b` 形态（curl -b "a=1; b=2"）也认', () => {
    const out = normalizePastedCookie(`curl -b 'sessionid=s4; ttwid=t4' https://www.doubao.com/`)
    expect(HAS_SESSION(out)).toBe(true)
  })

  it('没有 sessionid 时也照样归一（由调用方判缺失）', () => {
    expect(normalizePastedCookie('ttwid=t5')).toBe('ttwid=t5')
  })

  /**
   * ★★★ **超长必须拒绝，不能截断**（2026-11-26 双审 P2）。
   *
   * 旧断言是 `length <= 8192` —— 那是**把缺陷当契约**：截断会静默切出半截
   * `sessionid`，而调用方只看「返回非空 ⇒ 成功」，于是：
   *
   * - RPC 回 `ok:true`、面板弹「已用 cookie 导入豆包账号」；
   * - 库里存的是被切断的 sessionid（对抗审计探针实测 182/300 字符）；
   * - 用户重粘完整 cookie 因为 sessionid 不同 ⇒ **不判重** ⇒ **变两张卡**；
   * - 那半截 cookie 请求必然失败，但界面显示「已登录」。
   *
   * ⇒ 超长 = 误贴了整页 HTML/日志，要的是「让用户重新贴」，不是「悄悄用一半」。
   *   返回空串 ⇒ 调用方走 `ok:false` + 可操作文案 ⇒ **不建号**。
   */
  it('★★★ 空串 / 非字符串 ⇒ 空串；误贴大块文本 ⇒ **拒绝**（不得静默截断）', () => {
    expect(normalizePastedCookie('')).toBe('')
    expect(normalizePastedCookie(null)).toBe('')
    expect(normalizePastedCookie(undefined)).toBe('')
    const huge = `sessionid=s6; ${'a=1; '.repeat(2000)}`
    expect(
      normalizePastedCookie(huge),
      '超长必须整体拒绝：截断会静默切出半截 sessionid ⇒ 界面报成功但实际不可用、且重粘会多出一张卡',
    ).toBe('')
    // 反向对照：刚好在边界内的**正常长度** cookie 必须照常返回（别为了拒绝超长把正常路径也打死）。
    const normal = 'sessionid=abc123; ttwid=t5; msToken=m9'
    expect(normalizePastedCookie(normal)).toBe(normal)
  })
})
