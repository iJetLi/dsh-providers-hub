/**
 * **undici 安装不完整 → 可操作文案**（2026-11-26，GitHub issue #169）。
 *
 * ## 报障（用户截图）
 *
 * 「设置代理 → 测试连接」直接报：
 * ```
 * 测试失败：Cannot find module './llhttp/llhttp-wasm.js'
 * Require stack: - …\.pnpm\undici@8.11.2\node_modules\undici\lib\dispatcher.js
 * (MODULE_NOT_FOUND)
 * ```
 *
 * ## 为什么那不是「代理配错」
 *
 * `undici@8.x` 的 `Dispatcher` 在**模块加载期**就 `require('./llhttp/llhttp-wasm.js')`
 * （8.x 把 llhttp 从 C++ 换成 wasm）。该文件随包发布（`undici` 的 `package.json`
 * 没有 `files` 白名单）⇒ 缺它只可能是**装坏了**。
 *
 * 原实现把这个错误**原样抛出** ⇒ 用户以为是 Clash 配错、反复改代理地址也修不好。
 */
import { describe, expect, it } from 'vitest'
import { undiciInstallBroken } from '../../src/opencode-proxy.js'

/** 造一个形状与真实 `MODULE_NOT_FOUND` 一致的错误。 */
function brokenInstallError(): Error {
  const error = new Error("Cannot find module './llhttp/llhttp-wasm.js'")
  error.stack = [
    "Error: Cannot find module './llhttp/llhttp-wasm.js'",
    'Require stack:',
    '- C:\\Users\\x\\Desktop\\dsh-providers-hub\\node_modules\\.pnpm\\undici@8.11.2\\node_modules\\undici\\lib\\dispatcher.js',
    '- C:\\Users\\x\\Desktop\\dsh-providers-hub\\node_modules\\.pnpm\\undici@8.11.2\\node_modules\\undici\\index.js',
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1234:15)',
  ].join('\n')
  return error
}

describe('undici 安装不完整（issue #169）', () => {
  it('★★★ 认得出「缺 llhttp-wasm」并把它与网络错误区分开', () => {
    expect(undiciInstallBroken(brokenInstallError()), '用户截图里那条错误必须被认出').toBe(true)
  })

  it('★★★ 不把普通网络错误误判成「装坏了」', () => {
    // 这几条都必须落回「普通失败」—— 否则用户会被引去重装插件，而问题在网络
    expect(undiciInstallBroken(new Error('connect ECONNREFUSED 127.0.0.1:7890'))).toBe(false)
    expect(undiciInstallBroken(new Error('fetch failed'))).toBe(false)
    expect(undiciInstallBroken(new TypeError('fetch failed'))).toBe(false)
  })

  it('★★ 其他缺失模块不被误判（只认 undici 自己的 llhttp 底座）', () => {
    expect(undiciInstallBroken(new Error("Cannot find module './some-other.js'"))).toBe(false)
    // 缺模块、但与 undici 无关 ⇒ 不归这条文案管
    expect(undiciInstallBroken(new Error("Cannot find module 'lodash'"))).toBe(false)
  })

  it('★ 非 Error 输入不抛错（探测路径不该因为它崩）', () => {
    expect(undiciInstallBroken('Cannot find module ./llhttp/llhttp-wasm.js undici')).toBe(true)
    expect(undiciInstallBroken(undefined)).toBe(false)
    expect(undiciInstallBroken(null)).toBe(false)
  })
})
