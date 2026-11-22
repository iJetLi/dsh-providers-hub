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
  it('★★★ `pattern` 里的 `\\0` 必须改写成 `\\x00`（本次真凶）', () => {
    // 真机 A/B：`^[^\r\n\0]*$` ⇒ 400；`^[^\r\n\x00]*$` ⇒ 200（语义相同）。
    const out = sanitizeToolSchema({ type: 'string', pattern: '^[^\\r\\n\\0]*$' })
    expect(out.pattern, '`\\0` 不是合法正则空字符转义，腾讯直接拒收').toBe('^[^\\r\\n\\x00]*$')
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
    expect(props.subject!.pattern, 'properties 层要递归到 pattern').toBe('^[^\\x00]*$')
    expect(props.nested!.properties, 'properties 层要递归补 properties').toEqual({})
    expect(out.anyOf as unknown[], 'anyOf 分支也要递归').toHaveLength(2)
    expect((out.anyOf as Record<string, unknown>[])[0]!.properties, 'anyOf 分支缺 properties 要补').toEqual({})
    /**
     * ⚠️ **2026-11-23 改判据**（对抗审计 P1④）：`$schema` / `$id` **只在根级剥**。
     *
     * 原因：`$id` 会**改变相对 `$ref` 的解析基准** —— 嵌套层剥掉它会让 `$ref`
     * 指向别处，那是**改语义**，比不修更糟。`$schema` 虽然影响小，但同属 draft 声明，
     * 保持「只在根级处理」这一条一致规则更好维护。
     */
    expect((out.anyOf as Record<string, unknown>[])[1], '嵌套层刻意**不**剥 $schema（防改 $ref 基准）')
      .toHaveProperty('$schema')
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

/**
 * ★★★ **改写后的 pattern 必须与原来「语义等价」**（不只是「上游接受」）。
 *
 * ## 这是我第一版踩的坑，值得单独钉住
 *
 * 我最初照 issue 作者的 A/B 结论把 `\0` 改成 `\^@`（他真机测过「上游返回 200」），
 * 而正向审计实测发现**语义变了**：
 *
 * | 输入 | 原 `\0` | `\^@` |
 * |---|---|---|
 * | `a@b.com` | true | **false**（误拒 `@`）|
 * | `a^b` | true | **false**（误拒 `^`）|
 * | 真 NUL | false | **true**（放行 NUL）|
 *
 * `\^` 是「转义 caret」、`^@` 是**终端** caret notation，两者都不是正则里的 NUL
 * ⇒ `\^@` 实际表示「非 `^` 且非 `@`」。而元凶工具正是 `apple-mail` 的
 * subject/to/cc/bcc —— **含 `@` 的邮箱地址会被自己写的 pattern 拒掉**。
 *
 * ⇒ 判据应该是「**改写前后对同一组输入给出同样的匹配结果**」，而不是
 *   「上游接不接受」（后者只说明语法合法，不说明语义没变）。
 *
 * `\x00` 与 `\0` 在 ECMAScript 正则里完全等价（下方用例逐输入验证）。
 */
describe('sanitizeToolSchema：pattern 改写必须语义等价', () => {
  const compile = (pattern: string): RegExp => new RegExp(pattern)
  const inputs = [
    'a@b.com',          // ← `\^@` 会把它误拒
    'hello world',
    'a^b',              // ← `\^@` 也会误拒
    '中文 subject',
    '',                 // 空串
    '\r', '\n',         // 原 pattern 就排除的
    String.fromCharCode(0),   // 真 NUL：原 pattern 排除、`\^@` 反而放行
  ]

  it('★★★ 改写前后对 8 种输入给出**完全一致**的匹配结果', () => {
    const original = '^[^\\r\\n\\0]*$'
    const sanitized = sanitizeToolSchema({ type: 'string', pattern: original }).pattern!
    expect(sanitized, '不得保留 `\\0`（上游拒收）').not.toContain('\\0')
    expect(sanitized, '必须是 ECMAScript 的 `\\x00`，不是终端 caret notation').toBe('^[^\\r\\n\\x00]*$')

    const before = compile(original)
    const after = compile(sanitized)
    for (const input of inputs) {
      expect(
        after.test(input),
        `输入 ${JSON.stringify(input)} 的匹配结果必须不变（否则工具参数会被误拒/误放行）`,
      ).toBe(before.test(input))
    }
  })

  it('★★★ 反向：如果照 issue 作者的 `\\^@` 写，本用例会红（证明判据有牙）', () => {
    // 直接对照：`\^@` 对 `a@b.com` 给出 false，而原 pattern 给 true ⇒ 语义不同。
    const original = compile('^[^\\r\\n\\0]*$')
    const caret = compile('^[^\\r\\n\\^@]*$')
    expect(caret.test('a@b.com'), '这正是我第一版的错误：含 @ 的邮箱被误拒').toBe(false)
    expect(original.test('a@b.com'), '原 pattern 接受它').toBe(true)
  })
})

/**
 * ★★★ **递归必须覆盖全部容器 + 不得误伤合规 schema**（2026-11-23 对抗审计 P1②/P1④）。
 *
 * 对抗审计实测原实现**能被打穿 12 处**（sanitize 后仍含 `\0`）：
 * `$defs` / `definitions` / `additionalProperties` / `patternProperties` / `not` /
 * `if` / `then` / `else` / `dependentSchemas` / `contains` / `propertyNames` /
 * 数组形态 `items` / `prefixItems` / `unevaluated*`。
 *
 * **最现实的形态**：zod 生成的 schema 常是「根级 `$ref` + `$defs`」——
 * 原实现剥了 `$schema` 却**完全不碰 `$defs`** ⇒ `\0` 原样发给上游 ⇒ 仍旧 400。
 */
describe('sanitizeToolSchema：递归完备性（12 处容器）', () => {
  /** 一个含 `\0` 的叶子 schema。 */
  const dirty = { type: 'string', pattern: '^a\\0b$' }
  const clean = (s: unknown): string => JSON.stringify(s)

  const cases: Array<[string, Record<string, unknown>]> = [
    ['$defs', { $ref: '#/$defs/x', $defs: { x: dirty } }],
    ['definitions', { $ref: '#/definitions/x', definitions: { x: dirty } }],
    ['additionalProperties', { type: 'object', properties: {}, additionalProperties: dirty }],
    ['patternProperties', { type: 'object', properties: {}, patternProperties: { '^a': dirty } }],
    ['not', { type: 'object', properties: {}, not: dirty }],
    ['if', { type: 'object', properties: {}, if: dirty }],
    ['then', { type: 'object', properties: {}, then: dirty }],
    ['else', { type: 'object', properties: {}, else: dirty }],
    ['dependentSchemas', { type: 'object', properties: {}, dependentSchemas: { a: dirty } }],
    ['contains', { type: 'array', items: {}, contains: dirty }],
    ['propertyNames', { type: 'object', properties: {}, propertyNames: dirty }],
    ['unevaluatedProperties', { type: 'object', properties: {}, unevaluatedProperties: dirty }],
    ['数组形态 items', { type: 'array', items: [dirty] }],
    ['prefixItems', { type: 'array', prefixItems: [dirty] }],
  ]

  for (const [label, schema] of cases) {
    it(`★★★ ${label} 里的 \`\\0\` 必须被递归处理`, () => {
      const out = sanitizeToolSchema(schema)
      expect(clean(out), `\`${label}\` 容器没被递归 ⇒ 上游仍会 400`).not.toContain('\\\\0')
    })
  }
})

describe('sanitizeToolSchema：不得误伤合规 schema（审计 P1④）', () => {
  it('★★★ 带校验关键字但无 `type` 的 schema 不得被强加 `type:"object"`', () => {
    // `minimum` 只对数字生效、`format` 只对字符串生效 —— JSON Schema 里都合法。
    for (const schema of [{ minimum: 0 }, { format: 'email' }, { not: { type: 'string' } }]) {
      const out = sanitizeToolSchema(schema) as Record<string, unknown>
      expect(out.type, `${JSON.stringify(schema)} 被强加 type 会按 object 校验 ⇒ 合法参数被拒`).toBeUndefined()
    }
  })

  it('★★★ 嵌套层不得剥 `$id`（会改相对 `$ref` 的解析基准）', () => {
    const schema = {
      type: 'object',
      properties: { a: { $id: 'sub', type: 'string' } },
    }
    const out = sanitizeToolSchema(schema) as { properties: { a: Record<string, unknown> } }
    expect(out.properties.a.$id, '嵌套 $id 影响 $ref 基准 —— 剥了会改语义').toBe('sub')
  })

  it('★★★ `type` 是数组（`["object","null"]`）时也要补 `properties`', () => {
    const out = sanitizeToolSchema({ type: ['object', 'null'] }) as Record<string, unknown>
    expect(out.properties, '`out.type === "object"` 判据走不到数组形态').toEqual({})
  })

  it('★★★ 八进制转义 `\\012` 不得被当成 `\\0`+`12` 改写', () => {
    const out = sanitizeToolSchema({ type: 'string', pattern: '^\\012$' }) as { pattern: string }
    expect(out.pattern, '`\\012` 是换行的八进制转义 —— 改成 `\\x0012` 语义就变了').toBe('^\\012$')
  })

  it('★★★ 多处 `\\0` 必须**全部**替换（不止第一个）', () => {
    const out = sanitizeToolSchema({ type: 'string', pattern: '^\\0a\\0b\\0$' }) as { pattern: string }
    expect(out.pattern).not.toContain('\\0')
    expect(out.pattern).toBe('^\\x00a\\x00b\\x00$')
  })
})
