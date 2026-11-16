/**
 * Qiniu 请求体构造的守卫 —— 工具必须被 type:'function' 包装。
 *
 * ## 真实事故（2026-10-07）
 *
 * 旧反代把 DSH 的扁平工具 schema 原样透传，上游回：
 *
 *     status: 400
 *     {"error":{"code":"invalid_parameter_error","message":"'type' is a required property - 'tools.0'"}}
 *
 * 而 DSH 每一次真实对话都带工具 ⇒ 症状是「七牛云的额度一次都没消耗」，
 * 请求根本没被受理。故这里逐字节锁死包装形状。
 */

import { describe, expect, it } from 'vitest'
import { buildQiniuPayload, buildQiniuTools } from '../../src/qiniu-messages.js'

describe('buildQiniuTools：包装形状', () => {
  it('每个工具都必须包成 type:function + function 包装', () => {
    const tools = buildQiniuTools([{ name: 'read_file', description: '读文件' }])
    expect(tools).toHaveLength(1)
    expect(tools[0]!.type).toBe('function')
    expect(tools[0]!.function.name).toBe('read_file')
    expect(tools[0]!.function.description).toBe('读文件')
  })

  it('空描述整个省略（不是发空串）+ parameters 有才带', () => {
    const [tool] = buildQiniuTools([{ name: 't', description: '' }])
    expect('description' in tool!.function, '发空串 description 会被部分上游判为非法').toBe(false)
    expect('parameters' in tool!.function).toBe(false)
    const [withParams] = buildQiniuTools([{
      name: 't2',
      description: 'd',
      parameters: { type: 'object', properties: { a: { type: 'string' } } },
    }])
    expect(withParams!.function.parameters).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })

  it('undefined / 空数组 ⇒ 空数组（不抛）', () => {
    expect(buildQiniuTools(undefined)).toEqual([])
    expect(buildQiniuTools([])).toEqual([])
  })
})

describe('buildQiniuPayload：字段门禁', () => {
  const base = { model: 'deepseek-v3', messages: [{ role: 'user', content: 'hi' }] }

  it('stream 恒 true、tools 恒带（哪怕空数组）', () => {
    const payload = buildQiniuPayload(base)
    expect(payload.stream).toBe(true)
    expect(payload.tools, '缺 tools 字段是 invalid_parameter_error 事故的另一半').toEqual([])
  })

  it('★ system 折进 messages[]（不放顶层，GitHub #97）；reasoning_effort 只在非空时下发', () => {
    // 顶层 `system` 被上游静默忽略 ⇒ 必须作为第一条 `messages[]` 成员下发。
    // ⚠️ 下面**空串那条单独是恒真的**（修前 `input.system.length > 0` 同样不带顶层键），
    //    所以必须再钉「`messages` 原样」—— 那才是「空串不折」的判据。
    expect('system' in buildQiniuPayload({ ...base, system: '' })).toBe(false)
    expect(buildQiniuPayload({ ...base, system: '' }).messages).toEqual(base.messages)
    const folded = buildQiniuPayload({ ...base, system: '你是助手' })
    expect('system' in folded, '顶层不许再有 system').toBe(false)
    expect(folded.messages).toEqual([{ role: 'system', content: '你是助手' }, ...base.messages])
    expect('reasoning_effort' in buildQiniuPayload({ ...base, reasoningEffort: '' })).toBe(false)
    // 声明了档位就必须真的发出去，否则选择器只是 UI 装饰。
    expect(buildQiniuPayload({ ...base, reasoningEffort: 'high' }).reasoning_effort).toBe('high')
  })

  it('max_tokens 只放行安全正整数（0/负数/NaN 会让整轮对话崩）', () => {
    for (const bad of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect('max_tokens' in buildQiniuPayload({ ...base, maxTokens: bad }),
        String(bad) + ' 不该下发（INVALID_MODEL_MAX_TOKENS 会把整轮对话搞崩）').toBe(false)
    }
    expect(buildQiniuPayload({ ...base, maxTokens: 4096 }).max_tokens).toBe(4096)
  })

  it('temperature 只在有限数时下发', () => {
    expect('temperature' in buildQiniuPayload({ ...base, temperature: Number.NaN })).toBe(false)
    expect(buildQiniuPayload({ ...base, temperature: 0 }).temperature).toBe(0)
  })
})
