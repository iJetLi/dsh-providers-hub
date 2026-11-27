/**
 * ★★★ **凭据 JSON 的裸控制字符**（issue #182 第六节，2026-11-27 实测）。
 *
 * ## 真实症状
 *
 * 报障者的 accio 账号昵称是 `"Maxi\nPan"` —— **凭据文件里存的是一个裸换行**。
 * `JSON.parse` 抛 `Bad control character in string literal`，而解析点在 `try` 里
 * ⇒ **整个账号被跳过** ⇒ 表面看就是「那个账号不见了」。
 *
 * ⚠️ 他实测：**团队账号恰好是这一条** ⇒ 一度读不到任何团队数据。
 */
import { describe, expect, it } from 'vitest'
import { parseCredentialJson } from '../../src/credential-json.js'

describe('★★★ 凭据 JSON：裸控制字符', () => {
  it('★★★ 字符串里含**裸换行**（未转义）⇒ 必须能解析，且值保留换行', () => {
    // ⚠️ 这里的 \n 是「源码里的真实换行」，不是转义 —— 正是报障者的形态
    const raw = '{"nickname":"Maxi\nPan","access_token":"t"}'
    const parsed = parseCredentialJson<{ nickname: string, access_token: string }>(raw)
    expect(parsed.access_token, '账号不能因为一个换行就被跳过').toBe('t')
    expect(parsed.nickname, '★ 换行必须保留（两个字符），不能被静默吃掉').toBe('Maxi\nPan')
  })

  it('★★★ 含裸制表符 / U+0001 也要能解析', () => {
    expect(parseCredentialJson<{ a: string }>('{"a":"x\ty"}').a).toBe('x\ty')
    expect(parseCredentialJson<{ a: string }>('{"a":"x\u0001y"}').a).toBe('x\u0001y')
  })

  it('★★ 合法 JSON 必须**逐字节不变**（转义只在失败时触发）', () => {
    const raw = '{"a":"已转义的\\n没问题","b":1}'
    expect(parseCredentialJson(raw)).toEqual(JSON.parse(raw))
  })

  it('★★ 其它语法错仍抛原始错误（不得用重试掩盖真错误）', () => {
    expect(() => parseCredentialJson('{"a":}')).toThrow()
    expect(() => parseCredentialJson('not json')).toThrow()
  })
})
