/**
 * ★★★ **腾讯系 `parameters` 的递归 sanitize**（issue #138，2026-11-23）。
 *
 * ## 为什么必须有这组用例
 *
 * 腾讯（`copilot.tencent.com` / `www.workbuddy.ai`）对工具 `parameters` 做**严格
 * JSON Schema 校验**：工具表里**任意一个**工具不合规 ⇒ **整个请求** 400 `11129`，
 * 且响应**不带工具名** ⇒ 只能二分法排查。而校验严格度**随模型变化**
 * （`hy4flash-free` 不校验、`deepseek-v4.1-flash` 严格）⇒ 用户会以为「换个模型就好」。
 *
 * ⚠️ 更麻烦的是**违规可能藏在任意一层**（`properties.*` / `items` / `anyOf`）——
 * 本项目历史上三次分别踩在根级缺 `properties`、嵌套残缺、`pattern` 含 `\0`。
 * ⇒ 只用例守根级等于没修。
 */
import { describe, expect, it } from 'vitest'
import { sanitizeToolSchema } from '../../src/buddy-adapter.js'

describe('sanitizeToolSchema：issue #138 的四类违规', () => {
  it('★★★ `pattern` 里的 `\\0` 必须改写成 `\\^@`（本次真凶）', () => {
    // 真机 A/B：`^[^\r\n\0]*$` ⇒ 400；`^[^\r\n\^@]*$` ⇒ 200（语义相同）。
    const out = sanitizeToolSchema({ type: 'string', pattern: '^[^\\r\\n\\0]*$' })
    expect(out.pattern, '`\\0` 不是合法正则空字符转义，腾讯直接拒收').toBe('^[^\\r\\n\\^@]*$')
    expect(out.pattern, '不得留下裸露的 \\0').not.toContain('\\0')
  })

  it('★★★ 根级 `$schema` / `$id` 必须剥掉（function calling 子集不含）', () => {
    const out = sanitizeToolSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'https://example.com/x',
      type: 'object',
      properties: {},
    })
    expect(out).not.toHaveProperty('$schema')
    expect(out).not.toHaveProperty('$id')
    expect(out.type, '其余字段原样保留').toBe('object')
  })

  it('★★★ `type:"object"` 缺 `properties` ⇒ 补空对象（不是删掉）', () => {
    expect(sanitizeToolSchema({ type: 'object' }).properties).toEqual({})
  })

  it('★★★ 裸对象（无 type 也无组合键）⇒ 补成全自由 object', () => {
    const out = sanitizeToolSchema({ description: '一个裸 schema' })
    expect(out.type).toBe('object')
    expect(out.properties).toEqual({})
    expect(out.description, '有语义的字段不得丢').toBe('一个裸 schema')
  })

  it('★★★ `type:"array"` 缺 `items` ⇒ 补；有则递归下去', () => {
    expect((sanitizeToolSchema({ type: 'array' }).items as { type?: string }).type).toBe('object')
    const nested = sanitizeToolSchema({
      type: 'array',
      items: { type: 'object' },   // 缺 properties
    })
    expect((nested.items as { properties?: unknown }).properties, '必须递归').toEqual({})
  })

  it('★★★ `properties.*` 与 `anyOf` 分支都要递归（历史三次踩在不同层）', () => {
    const out = sanitizeToolSchema({
      type: 'object',
      properties: {
        subject: { type: 'string', pattern: '^[^\\0]*$' },
        nested: { type: 'object' },                       // 缺 properties
      },
      anyOf: [{ type: 'object' }, { $schema: 'x', type: 'string' }],
    })
    const props = out.properties as Record<string, Record<string, unknown>>
    expect(props.subject!.pattern, 'properties 层要递归到 pattern').toBe('^[^\\^@]*$')
    expect(props.nested!.properties, 'properties 层要递归补 properties').toEqual({})
    expect(out.anyOf as unknown[], 'anyOf 分支也要递归').toHaveLength(2)
    expect((out.anyOf as Record<string, unknown>[])[0]!.properties, 'anyOf 分支缺 properties 要补').toEqual({})
    expect((out.anyOf as Record<string, unknown>[])[1], 'anyOf 分支的 $schema 要剥').not.toHaveProperty('$schema')
  })

  it('★★ 合规 schema **原对象返回**（`===`）—— 不做无谓深拷贝', () => {
    const ok = { type: 'object', properties: { a: { type: 'string' } } }
    expect(sanitizeToolSchema(ok), '没变就别复制').toBe(ok)
  })

  it('★★ 不碰无关字段（`description` / `enum` / `$ref` / `const` / `prefixItems`）', () => {
    const withEnum = { type: 'string', enum: ['a', 'b'] }
    expect(sanitizeToolSchema(withEnum)).toBe(withEnum)
    const withRef = { $ref: '#/definitions/x' }
    expect(sanitizeToolSchema(withRef), '$ref 是组合键，不得被补成 object').toBe(withRef)
    const withPrefix = { type: 'array', prefixItems: [{ type: 'string' }] }
    expect(sanitizeToolSchema(withPrefix), 'prefixItems 也是组合键').toBe(withPrefix)
  })

  it('★★ 边界输入不炸（null / 数组 / 原始值）', () => {
    expect(sanitizeToolSchema(null)).toBeNull()
    expect(sanitizeToolSchema(undefined)).toBeUndefined()
    expect(sanitizeToolSchema('x')).toBe('x')
    const arr = [1, 2]
    expect(sanitizeToolSchema(arr)).toBe(arr)
  })
})
