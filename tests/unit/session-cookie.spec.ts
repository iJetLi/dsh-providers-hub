import { describe, expect, it } from 'vitest'

import { looksLikeCookieHeader, normalizeSessionCookie } from '../../src/session-cookie.js'

/**
 * 会话 cookie 归一化（MonkeyCode 两站 + 百智云共用一份实现）。
 *
 * ## 为什么这几条必须存在
 *
 * 2026-11-03 红队实测：把 `looksLikeCookieHeader` 的 base64 判据
 * （`!rest.startsWith('=')`）改成 `rest.length > 0` ⇒ **39 条用例全绿**。
 * 而那条判据守的是一个真实形态：用户从 DevTools 复制出来的裸值可能本身就是
 * base64（`YWJj==`），丢掉名字会发出 `Cookie: YWJj==` ⇒ 服务端解析不出
 * name/value ⇒ **恒 401**，上层会误判成「还没登录」并空转到超时。
 */
const MC = { names: ['monkeycode_ai_session'], fallback: 'monkeycode_ai_session' }
const BZ = { names: ['baizhi_session', 'sl-session'], fallback: 'baizhi_session' }

describe('normalizeSessionCookie', () => {
  it('裸值 ⇒ 补兜底名字（三种 provider 名都试）', () => {
    expect(normalizeSessionCookie('abc123', MC.names, MC.fallback)).toBe('monkeycode_ai_session=abc123')
    expect(normalizeSessionCookie('abc123', BZ.names, BZ.fallback)).toBe('baizhi_session=abc123')
  })

  it('★★ base64 裸值（`YWJj==`）不得被当成完整 cookie 串（红队打穿过的那条判据）', () => {
    // `YWJj==` 里有一个 `=`，名字段 `YWJj` 也合法；若判据只看「有等号」就会
    // 原样发出 `Cookie: YWJj==` ⇒ 无名 cookie ⇒ 恒 401。
    expect(normalizeSessionCookie('YWJj==', MC.names, MC.fallback)).toBe('monkeycode_ai_session=YWJj==')
    // 双等号尾巴的 base64 也一样。
    expect(normalizeSessionCookie('c2Vzc2lvbg==', MC.names, MC.fallback)).toBe('monkeycode_ai_session=c2Vzc2lvbg==')
  })

  it('完整串（多段 / 已知名 / 未知名带值）原样保留', () => {
    expect(normalizeSessionCookie('a=1; b=2', MC.names, MC.fallback)).toBe('a=1; b=2')
    expect(normalizeSessionCookie('monkeycode_ai_session=x', MC.names, MC.fallback)).toBe('monkeycode_ai_session=x')
    expect(normalizeSessionCookie('baizhi_session=x; sl-session=y', BZ.names, BZ.fallback))
      .toBe('baizhi_session=x; sl-session=y')
    // 未知名字但不是 base64（值不以 `=` 开头）⇒ 视为完整串，不改写。
    expect(normalizeSessionCookie('other=value', MC.names, MC.fallback)).toBe('other=value')
  })

  it('剥掉 `cookie:` 前缀（DevTools 整行复制）', () => {
    expect(normalizeSessionCookie('Cookie: a=1; b=2', MC.names, MC.fallback)).toBe('a=1; b=2')
    expect(normalizeSessionCookie('cookie:abc123', MC.names, MC.fallback)).toBe('monkeycode_ai_session=abc123')
  })

  it('空 / 纯空白 / 非字符串 ⇒ undefined', () => {
    expect(normalizeSessionCookie('', MC.names, MC.fallback)).toBeUndefined()
    expect(normalizeSessionCookie('   ', MC.names, MC.fallback)).toBeUndefined()
    expect(normalizeSessionCookie(undefined, MC.names, MC.fallback)).toBeUndefined()
  })

  it('补名字必须是**一个**等号（历史事故：模板多写一个 `=` 拼出 `name==value`）', () => {
    const normalized = normalizeSessionCookie('abc123', MC.names, MC.fallback)
    expect(normalized).toBe('monkeycode_ai_session=abc123')
    expect(normalized).not.toContain('==abc123')
  })
})

describe('looksLikeCookieHeader', () => {
  it('与 normalizeSessionCookie 的口径一致（避免两处判据分叉）', () => {
    // 裸 base64 ⇒ false（需要补名字）
    expect(looksLikeCookieHeader('YWJj==', MC.names)).toBe(false)
    // 已知名 ⇒ true
    expect(looksLikeCookieHeader('monkeycode_ai_session=x', MC.names)).toBe(true)
    // 多段 ⇒ true（整串）
    expect(looksLikeCookieHeader('a=1; b=2', MC.names)).toBe(true)
  })
})
