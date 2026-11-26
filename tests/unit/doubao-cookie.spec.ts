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

  it('空串 / 非字符串 / 误贴大块文本 ⇒ 空串或截断，绝不抛', () => {
    expect(normalizePastedCookie('')).toBe('')
    expect(normalizePastedCookie(null)).toBe('')
    expect(normalizePastedCookie(undefined)).toBe('')
    const huge = `sessionid=s6; ${'a=1; '.repeat(2000)}`
    expect(normalizePastedCookie(huge).length).toBeLessThanOrEqual(8_192)
  })
})
