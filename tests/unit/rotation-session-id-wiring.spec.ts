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
