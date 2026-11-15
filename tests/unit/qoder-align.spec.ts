/**
 * 形态对齐（`src/qoder-align.ts`）的行为断言。
 *
 * 守四件事：
 * 1. **默认开、可一键关** —— 关掉时必须**一个头都不补**；
 * 2. **只补缺失** —— 已有值（尤其 WASM 生成的那套）一个字节都不动；
 * 3. **只补实测缺的那一个** —— WASM 头表已自带 `Login-Version` / `Cosy-ClientIp` /
 *    `Cosy-MachineId/Token/Type`，本模块**不得**重复生成（那是死代码）；
 * 4. **hostname 默认不发** —— 那是把本机标识透给上游的信息披露面。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostname } from 'node:os'

/**
 * `hostname` 必须可被替身覆盖 —— 它是 ESM 命名导入，`vi.spyOn(os, 'hostname')`
 * 对已解构的绑定**无效**（会静默改不到被调用的那个引用）。这里用 `vi.mock`
 * 包一层：默认透传真实实现，用例里 `vi.mocked(hostname).mockReturnValue(...)`
 * 才真的生效。
 */
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, hostname: vi.fn(actual.hostname) }
})
import {
  applyQoderAlignmentHeaders,
  qoderAlignHeadersEnabled,
  qoderAlignHostnameEnabled,
  qoderMachineOs,
  resetQoderAlignCache,
  withQoderAlignmentHeaders,
} from '../../src/qoder-align.js'

/**
 * 每个用例都清缓存 + 还原环境变量。
 *
 * ⚠️ `qoderMachineOs()` 有进程内缓存：不清的话，用例 A 设的
 * `DSH_QODER_MACHINE_OS` 会**串味**到用例 B（表现为 B 拿到 A 的值而假绿/假红）。
 */
beforeEach(() => {
  resetQoderAlignCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetQoderAlignCache()
})

describe('形态对齐：普通对象头表', () => {
  it('默认只补 `Cosy-MachineOS`，且**不**补 hostname', () => {
    const headers = withQoderAlignmentHeaders({ Accept: 'application/json' })
    expect(headers['Cosy-MachineOS']).toBe(qoderMachineOs())
    // hostname 默认不发（信息披露面，见模块头第 2 条）
    expect(headers['Cosy-MachineHostname']).toBeUndefined()
    expect(headers.Accept).toBe('application/json')
  })

  it('⚠️ 不重复生成 WASM 已自带的头（`Login-Version` / `Cosy-ClientIp` …）', () => {
    // 依据：模块头的实测 dump —— 两条通道的头表里这些头都已存在。
    // 若本模块也去补，补的那一行**永远命中不了**「缺失」分支 ⇒ 死代码。
    const headers = withQoderAlignmentHeaders({})
    expect(Object.keys(headers)).toEqual(['Cosy-MachineOS'])
  })

  it('不改入参（返回新对象）', () => {
    const original: Record<string, string> = { Accept: 'application/json' }
    const aligned = withQoderAlignmentHeaders(original)
    expect(original).toEqual({ Accept: 'application/json' })
    expect(aligned).not.toBe(original)
  })

  it('⚠️ 只补缺失：已有值（含小写键）一律不动', () => {
    // WASM 头表的键名形态由 Rust 侧决定，`cosy-machineos` / `Cosy-MachineOS` 都可能 ——
    // 大小写敏感比较会重复补一个头，而 `Headers` 会把它们合并成逗号串。
    const headers = withQoderAlignmentHeaders({ 'cosy-machineos': 'x86_64_darwin' })
    expect(headers['cosy-machineos']).toBe('x86_64_darwin')
    expect(headers['Cosy-MachineOS']).toBeUndefined()
  })

  it('⚠️ 大小写**混合**也算已存在（归一化只在一处做，删掉它必红）', () => {
    // `existing` 存原样键、比较时 `toLowerCase()` —— 这是**唯一**的归一化点。
    // 若把它放宽成大小写敏感比较，下面每一种写法都会**重复补**一个头
    // （`Headers` 会把两个同名头合并成逗号串，值是脏的）。
    for (const key of ['Cosy-MachineOS', 'cosy-machineos', 'COSY-MACHINEOS', 'CoSy-MaChInEoS']) {
      const headers = withQoderAlignmentHeaders({ [key]: 'x86_64_darwin' })
      expect(Object.keys(headers), `键 ${key} 已被占用时不得再补一个`).toEqual([key])
    }
  })

  it('`DSH_QODER_ALIGN_HEADERS=0` ⇒ 原样返回（一个头都不补）', () => {
    vi.stubEnv('DSH_QODER_ALIGN_HEADERS', '0')
    expect(qoderAlignHeadersEnabled()).toBe(false)
    const headers = withQoderAlignmentHeaders({ Accept: 'application/json' })
    expect(headers).toEqual({ Accept: 'application/json' })
  })

  it('拼错的开关值不改变行为（只认明确的否定词）', () => {
    vi.stubEnv('DSH_QODER_ALIGN_HEADERS', 'maybe')
    expect(qoderAlignHeadersEnabled()).toBe(true)
  })

  it('`DSH_QODER_ALIGN_HOSTNAME=1` ⇒ 补 `Cosy-MachineHostname`（取本机主机名）', () => {
    vi.stubEnv('DSH_QODER_ALIGN_HOSTNAME', '1')
    expect(qoderAlignHostnameEnabled()).toBe(true)
    const headers = withQoderAlignmentHeaders({})
    // 主机名为空的环境（极端容器）下允许不补 —— 那与「默认不发」同一取向。
    if (hostname().length > 0) expect(headers['Cosy-MachineHostname']).toBe(hostname())
  })

  it('hostname 开关默认关', () => {
    expect(qoderAlignHostnameEnabled()).toBe(false)
  })
})

describe('形态对齐：`Headers` 形态（推理通道）', () => {
  it('补头、返回同一实例、签名头原样', () => {
    const headers = new Headers({
      authorization: 'Bearer COSY.cGF5bG9hZA.sig',
      'cosy-version': '1.1.79',
      'cosy-date': '1700000000',
      accept: 'text/event-stream',
    })
    const returned = applyQoderAlignmentHeaders(headers)
    expect(returned).toBe(headers)
    expect(headers.get('cosy-machineos')).toBe(qoderMachineOs())
    // 签名相关头一个字节都不动
    expect(headers.get('authorization')).toBe('Bearer COSY.cGF5bG9hZA.sig')
    expect(headers.get('cosy-version')).toBe('1.1.79')
    expect(headers.get('cosy-date')).toBe('1700000000')
  })

  it('⚠️ 补的清单里**不含**任何签名相关头（单一真相源，防手滑）', () => {
    const headers = new Headers()
    applyQoderAlignmentHeaders(headers)
    expect([...headers.keys()]).toEqual(['cosy-machineos'])
    for (const forbidden of ['authorization', 'cosy-version', 'cosy-date', 'cosy-key', 'cosy-user']) {
      expect(headers.has(forbidden)).toBe(false)
    }
  })

  it('已存在的同名头不覆盖', () => {
    const headers = new Headers({ 'Cosy-MachineOS': 'x86_64_win32' })
    applyQoderAlignmentHeaders(headers)
    expect(headers.get('cosy-machineos')).toBe('x86_64_win32')
  })
})

describe('`Cosy-MachineOS` 取值', () => {
  it('默认跟随当前系统与架构（形如 `{arch}_{platform}`）', () => {
    expect(qoderMachineOs()).toMatch(/^(x86_64|aarch64)_(win32|darwin|linux)$/)
  })

  it('`DSH_QODER_MACHINE_OS` 可覆盖（排查 / 迁移用）', () => {
    vi.stubEnv('DSH_QODER_MACHINE_OS', 'x86_64_win32')
    resetQoderAlignCache()
    expect(qoderMachineOs()).toBe('x86_64_win32')
  })

  it('⚠️⚠️ 非法覆盖值必须回落（否则 `Headers.set` 每请求抛裸 `TypeError`）', () => {
    // 对抗审计 PR #91 P2-1 实测：这两个值原样进 `Headers.set()` 会抛
    // `TypeError: Headers.set: "a\nb" is an invalid header value.` /
    // `Cannot convert argument to a ByteString ... greater than 255`。
    // 抛出点在 `sendEncrypted` 的 `try` 之外 ⇒ 不是 `LlmError`、不落 `TRANSPORT`
    // ⇒ 每一条推理都直接炸给调用方。
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const fallback = (() => {
      vi.stubEnv('DSH_QODER_MACHINE_OS', '')
      resetQoderAlignCache()
      return qoderMachineOs()
    })()
    for (const bad of ['a\nb', 'Ｂ', '0', 'x86_64', 'win32', 'x86_64_win32 ', '']) {
      vi.stubEnv('DSH_QODER_MACHINE_OS', bad)
      resetQoderAlignCache()
      // 空白串（含纯空格 trim 成 ''）应当「没有覆盖」⇒ 走计算值
      expect(qoderMachineOs(), `非法覆盖值 ${JSON.stringify(bad)} 必须回落`).toBe(fallback)
    }
    // 回落必须**留痕**（本仓纪律：诊断信息显式留痕，否则用户以为覆盖生效了）
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('DSH_QODER_MACHINE_OS')
    warn.mockRestore()
  })

  it('⚠️ 合法覆盖值原样生效（校验不能把合法值也挡掉）', () => {
    for (const good of ['x86_64_win32', 'x86_64_darwin', 'x86_64_linux', 'aarch64_win32', 'aarch64_darwin', 'aarch64_linux']) {
      vi.stubEnv('DSH_QODER_MACHINE_OS', good)
      resetQoderAlignCache()
      expect(qoderMachineOs()).toBe(good)
    }
  })

  it('⚠️ hostname 是空白时不发（纯空格对上游毫无信息量，只是白多一条特征）', () => {
    vi.stubEnv('DSH_QODER_ALIGN_HOSTNAME', '1')
    // 空白（含纯空格）必须**不补**：`length > 0` 对单空格为真 ⇒ 会把一个空头发出去。
    for (const blank of ['   ', '\t', '']) {
      vi.mocked(hostname).mockReturnValue(blank)
      expect(withQoderAlignmentHeaders({})['Cosy-MachineHostname'], `空白 ${JSON.stringify(blank)} 不得发出`)
        .toBeUndefined()
    }
    // 合法主机名照常发（校验不能把正常值也挡掉）
    vi.mocked(hostname).mockReturnValue('  DESKTOP-ABC  ')
    expect(withQoderAlignmentHeaders({})['Cosy-MachineHostname']).toBe('DESKTOP-ABC')
    vi.mocked(hostname).mockReset()
  })

  it('缓存：同一进程内只算一次（平台不会中途变）', () => {
    const first = qoderMachineOs()
    vi.stubEnv('DSH_QODER_MACHINE_OS', 'aarch64_darwin')
    // 未清缓存 ⇒ 仍是首次的值（这正是「进程内稳定」的语义）
    expect(qoderMachineOs()).toBe(first)
    resetQoderAlignCache()
    expect(qoderMachineOs()).toBe('aarch64_darwin')
  })
})
