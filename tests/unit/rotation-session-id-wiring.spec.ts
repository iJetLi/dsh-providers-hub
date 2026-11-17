/**
 * 「轮换起点」的**端到端接线**守卫（真实缺陷，2026-11-11）。
 *
 * ## 事故
 *
 * 用户选了「账号 2 · M移0959」，实际仍用「账号 1 · M电4016」。
 *
 * ## 根因：`sessionId` 在适配器层就丢了
 *
 * `createCredentialResolver` 返回的函数签名是
 * `(modelId?, sessionId?, selection?) => Promise<Credential | undefined>`，
 * 而全仓**每个适配器**的 `options.resolveCredential` 类型都写成
 * `(modelId?: string) => …` ⇒ 调用点只传 `modelId`
 * ⇒ `sessionId` 恒为 `undefined`
 * ⇒ `pool.preferredRotationFor(provider, undefined)` 恒返回 `undefined`
 * ⇒ **下拉框选了永远不生效，且零报错**。
 *
 * ⚠️ 这是「类型签名窄于实现」造成的静默失效：`tsc` 完全不报错
 *（`(a) => f(a)` 对 `(a, b) => f(a, b)` 是合法赋值），运行时也不抛。
 *
 * ## 本文件守什么
 *
 * 逐个适配器核对：`resolveCredential` 的类型签名**必须**有第二参
 * `sessionId`，且 `stream(options)` 里的调用点**必须**传 `options.sessionId`。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src')

/** 有 `stream(options: GenerateOptions)` 且走选号层的适配器。 */
const ADAPTERS = [
  'qoder-adapter.ts',
  'buddy-adapter.ts',
  'trae-adapter.ts',
  'cline-adapter.ts',
  'minimax-adapter.ts',
  'accio-adapter.ts',
  'gemini-adapter.ts',
  'lobsterai-adapter.ts',
  'raccoon-adapter.ts',
  'loomy-adapter.ts',
  // ⚠️ PR #59 正向审计 P1-b 补进来的三个：原先**完全没有**透传 sessionId 的渠道。
  // 它们不在本表里 ⇒ 「结构性看不见」：面板渲染下拉框、落盘成功、选号层不生效且零报错。
  'llm-adapter.ts',
  'astudio-adapter.ts',
  'magicrew-adapter.ts',
]

const read = (f: string) => readFileSync(join(SRC, f), 'utf8')

describe('适配器必须把 sessionId 透传给 resolveCredential', () => {
  for (const file of ADAPTERS) {
    describe(file, () => {
      /**
       * ⚠️ 这条守的是「类型签名窄于实现」这个静默失效：
       * 签名少一个参数时 `tsc` **不报错**（函数参数逆变），只能靠源码断言。
       */
      it('★ 类型签名含第二参 `sessionId`', () => {
        const source = read(file)
        expect(source).toMatch(
          /resolveCredential\??:\s*\(\s*modelId\?\s*:\s*string\s*,\s*sessionId\?\s*:\s*string\s*\)/,
        )
      })

      /**
       * ⚠️ 这条守的是「签名对了但调用点没传」——
       * 两者缺一都是零效果，且都不报错。
       */
      it('★ 调用点传了 `options.sessionId`', () => {
        const source = read(file)
        // 该文件里所有 `resolveCredential(options.model)` 都必须带上第二参
        const bare = source.match(/resolveCredential\(\s*options\.model\s*\)/g) ?? []
        expect(bare).toEqual([])
      })
    })
  }
})

describe('autoclaw（内部私有转发，形态不同）', () => {
  const source = read('autoclaw-adapter.ts')

  it('★ 选项类型含 sessionId', () => {
    expect(source).toMatch(/resolveCredential\?:\s*\(\s*modelId\?[^)]*sessionId\?\s*:\s*string/)
  })

  it('★ 内部转发时带上 sessionId', () => {
    expect(source).toMatch(/this\.options\.resolveCredential\(modelId,\s*sessionId\)/)
  })

  it('★ stream 调用处传 options.sessionId', () => {
    expect(source).toMatch(/this\.resolveCredential\(model,\s*options\.sessionId\)/)
  })
})

/**
 * 槽制适配器（`options.slots()` 返回**完整有序序列**，不是单凭据）的同一类守卫。
 *
 * 为什么单列一段：上面那张 `ADAPTERS` 表守的是 `resolveCredential`，槽制渠道
 * 压根没有那个选项 ⇒ **结构性看不见**。而槽制同样会踩「签名窄于实现」：
 * `slots: (modelId?) => …` 时 `tsc` 不报错，接线层拿不到 sessionId，
 * 「同一会话优先同一个号」**静默失效且零报错**。
 *
 * ⚠️ 只登记**真正消费 sessionId**的槽制渠道。modelscope 也是槽制但目前不做
 * 会话亲和（`slots(modelId)` 一参），不在此表；它若要接均衡，必须连同签名一起进来。
 */
const SLOT_ADAPTERS = ['marvis-adapter.ts']

describe('槽制适配器必须把 sessionId 透传给 slots()', () => {
  for (const file of SLOT_ADAPTERS) {
    describe(file, () => {
      it('★ `slots` 的类型签名含第二参 `sessionId`', () => {
        const source = read(file)
        expect(source).toMatch(
          /slots:\s*\(\s*modelId\?\s*:\s*string\s*,\s*sessionId\?\s*:\s*string\s*\)/,
        )
      })

      it('★ 推理路径的调用点传了 `options.sessionId`', () => {
        const source = read(file)
        // 裸的 `slots(options.model)` 一律不许出现（少传第二参 = 亲和失效）。
        expect(source.match(/slots\(\s*options\.model\s*\)/g) ?? []).toEqual([])
        expect(source).toMatch(/slots\(options\.model,\s*options\.sessionId\)/)
      })

      it('★ 目录路径仍然不传（`this.options.slots()` 裸调用必须恰好一处）', () => {
        const source = read(file)
        // 只数真实调用（`this.options.slots()`），不数注释里的 `slots()` 写法。
        expect(source.match(/this\.options\.slots\(\s*\)/g) ?? []).toHaveLength(1)
      })
    })
  }
})
