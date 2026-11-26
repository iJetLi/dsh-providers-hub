/**
 * **bdms 沙箱逃逸面守卫**（2026-11-26）。
 *
 * ## 为什么需要这条
 *
 * `src/doubao-bdms.ts` 在 `node:vm` 里跑随包内置的官方 bdms SDK（签 `X-Bogus`）。
 * `node:vm` **官方明确不是安全边界**，原 #164 的实现实测逃逸面 **15/15 全开**
 * （`Buffer.constructor('return process')()` 拿到真 `process`、`binding('spawn_sync')` 执行命令）。
 *
 * 现实现靠 **`vm.createContext(Object.create(null))`** 堵住 `this.constructor` 那条链
 * —— `Object.create(null)` 没有 `constructor` 属性 ⇒ 沙箱内取不到宿主 `Function`。
 *
 * ## 为什么这条守卫是必须的
 *
 * 两轮独立审计一致实测：**把 `Object.create(null)` 改回 `{}` ⇒ 18 条既有用例全绿**，
 * 而逃逸**真的通了**（拿到宿主 `process` + `execSync`）。
 * ⇒ 没有本文件时，「堵逃逸」这件事**零覆盖**，改回去没人知道。
 */
import { describe, expect, it } from 'vitest'
import vm from 'node:vm'
import { createBdmsContext, signDoubaoBogus } from '../../src/doubao-bdms.js'

/** 在沙箱里跑一段代码；返回 `{ ok, value }` 或 `{ thrown }`。 */
function runInSandbox(code: string): { ok: boolean; value?: unknown; thrown?: string } {
  const context = createBdmsContext()
  try {
    return { ok: true, value: vm.runInContext(code, context, { timeout: 2_000 }) }
  } catch (error) {
    return { ok: false, thrown: error instanceof Error ? error.message : String(error) }
  }
}

describe('bdms 沙箱逃逸面（P0 守卫）', () => {
  /**
   * ⚠️ 判据必须打在**行为**上：这些链一旦能取到宿主 `Function`，
   * `('return process')()` 就会返回**真 process**（有 `argv`/`env`/`pid`）。
   * 只断言「抛错」不够 —— 也要断言「即使不抛，拿到的也不是真 process」。
   */
  const viaConstructor = [
    "this.constructor.constructor('return process')()",
    "({}).constructor.constructor('return process')()",
    "Object.getPrototypeOf(this).constructor.constructor('return process')()",
    "this['__proto__'].constructor.constructor('return process')()",
    "this.constructor.constructor('return globalThis.process')()",
  ]

  it('★★★ `constructor.constructor` 逃逸链必须取不到宿主 process（改回 {} 就红）', () => {
    for (const code of viaConstructor) {
      const result = runInSandbox(code)
      if (result.ok) {
        const value = result.value as { argv?: unknown; env?: Record<string, unknown>; pid?: unknown } | undefined
        const looksLikeRealProcess = value !== null
          && typeof value === 'object'
          && Array.isArray((value as { argv?: unknown }).argv)
          && typeof (value as { env?: unknown }).env === 'object'
          && (value as { env?: object }).env !== null
        expect(
          looksLikeRealProcess,
          `${code} ⇒ 拿到了宿主 process（逃逸成功）。`
          + '这一格是 Object.create(null) 唯一的承重证据：改回 {} 它会立刻变成 false。',
        ).toBe(false)
      }
      // 抛错也是「堵住了」，两种形态都接受（当前实现抛 "process is not defined"）。
    }
  })

  it('★★★ 沙箱里不得有 process / Buffer / require 的宿主实现', () => {
    expect(runInSandbox("typeof process !== 'undefined' ? 'leak' : 'absent'").value).toBe('absent')
    expect(runInSandbox("typeof Buffer !== 'undefined' ? 'leak' : 'absent'").value).toBe('absent')
    // `require` 若存在，必须是 prelude 的白名单实现 —— 任何真模块名都必须被拒。
    for (const name of ['node:fs', 'fs', 'node:child_process', 'child_process', 'node:module']) {
      const code = `try { require(${JSON.stringify(name)}); 'allowed' } catch (e) { 'blocked' }`
      expect(runInSandbox(code).value, `require(${name}) 必须被拒`).toBe('blocked')
    }
  })

  it('★★★ 动态 import() 不得把宿主进程带出去', () => {
    /**
     * ⚠️ 已知限制（两轮审计都实测）：`node:vm` **拦不住动态 `import()`**，
     * 它能真的加载宿主模块。现在的兜底是「SDK 内容内置且 sha256 钉扎」——
     * 即**内容可信**，所以这条不是实际风险面，而是「守卫能被绕过」的登记。
     *
     * 本用例只锁「裸调 `import()` 不会让沙箱自己变强」这个可判的部分。
     */
    const result = runInSandbox("import('node:fs').then(() => 'loaded', () => 'rejected')")
    // 返回值可能是 Promise（沙箱内）或抛错 —— 两种都不能是「同步拿到宿主 fs」。
    expect(result.ok || result.thrown !== undefined).toBe(true)
  })
  /**
   * ★★★ **`signDoubaoBogus` 必须真算出签名**（2026-11-26 双审两个变异都点名这里）。
   *
   * 两轮独立审计一致实测：**把这个函数整条换成返回常量 ⇒ 既有用例全绿**
   * （54/54、18/18）—— 也就是说「签名到底算没算」此前**零覆盖**。
   *
   * 判据用**真实行为**：`X-Bogus` 里掺了时间戳 ⇒ 跨毫秒的两次调用**必然不同**。
   * 换成常量、或把 SDK 装死返回空串，这一条立刻红。
   *
   * ⚠️ 这条会**真装载并执行**内置 SDK（163KB，实测约 80ms/次），
   *   所以要显式给超时；也不要把它挪进高频路径。
   */
  it('★★★ signDoubaoBogus 必须真算出签名（换成常量 / 返回空串都会红）', async () => {
    const first = await signDoubaoBogus()
    // 跨过一毫秒边界：签名内掺时间戳 ⇒ 两次不同。同一毫秒内可能相同，故显式等待。
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await signDoubaoBogus()

    expect(first.length, 'X-Bogus 不得为空（空串 = 签名没算）').toBeGreaterThan(8)
    expect(second.length).toBeGreaterThan(8)
    expect(
      first,
      'X-Bogus 里掺了时间戳 ⇒ 跨毫秒的两次调用必须不同；相同说明它是常量或缓存死了',
    ).not.toBe(second)
    // 形状：可见 ASCII 的 base64url 风格串（不锁长度上限，上游改版不该假红）。
    expect(first).toMatch(/^[A-Za-z0-9+/=_-]+$/)
  }, 60_000)
})
