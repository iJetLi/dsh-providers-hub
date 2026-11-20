/**
 * ★★★ **「打开分档窗口显示读取失败」的回归守卫**（真实报障 2026-11-20）。
 *
 * ## 缺陷本体
 *
 * 客户端 `rpcCall` = `unwrapRpcResult(callManagementRpc(...))`，
 * 而 `unwrapRpcResult`（`plugin-src/management-rpc.mjs:37`）的契约是：
 *
 * | 宿主返回 | `rpcCall` 的结果 |
 * |---|---|
 * | `{ ok: true, value }` | **直接返回 `value`** |
 * | `{ ok: false, error }` | **抛 `Error`**（带 `.code`） |
 *
 * ⇒ 弹窗里写 `if (res?.ok !== true)` 是错的：`res` 已经是 value 对象
 *（`{ windowDays, imminentDays, source, clamped }`）、**没有 `ok` 字段**
 * ⇒ 判据恒真 ⇒ **每次打开都显示「读取失败」**。
 *
 * ## 本文件守什么
 *
 * 1. **契约级**：`unwrapRpcResult` 的行为（成功解包 / 失败抛错）；
 * 2. **端点级**：`credits.window.get/set` 经真实 `unwrapRpcResult` 后能拿到正确字段；
 * 3. **源码级（必要的补充）**：弹窗模块里不得再出现 `res?.ok` / `res.ok`
 *    这类判据 —— 这是纯文本断言，但**只作为兜底**，主判据是上面两条行为级。
 *
 * ⚠️ 为什么第 3 条也要有：行为级用例只能证明「端点 + unwrap 正确」，
 *    证明不了「弹窗自己没写错判据」（弹窗 import react、跑不进单测）。
 *    两者互补，缺一不可。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { unwrapRpcResult } from '../../plugin-src/management-rpc.mjs'

/** 起一套真实的 RPC 端点（真实 AccountPool + 临时 state 目录）。 */
function makeRpc() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-guard-'))
  const prev = process.env.DSH_JET_HUB_STATE_DIR
  process.env.DSH_JET_HUB_STATE_DIR = dir

  let handler
  const ctx = {
    get: (key) => key === 'connection'
      ? { fetch: { register: (config) => { if (config.path === '/api/jet-hub') handler = config.fetch } } }
      : undefined,
    inject: (_deps, callback) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {} },
    credentials: { resolve: async () => undefined },
    emit: () => {},
  }
  const pool = new AccountPool(ctx)
  registerJetHubRpc(ctx, pool, {})
  if (handler === undefined) throw new Error('端点未注册')

  return {
    pool,
    restore: () => {
      if (prev === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = prev
    },
    /** 复刻真实客户端的 rpcCall：成功返 value、失败抛错。 */
    rpcCall: async (method, payload) => {
      const res = await handler(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await res.json()
      return unwrapRpcResult(body.result)
    },
  }
}

describe('unwrapRpcResult 契约（缺陷的根因）', () => {
  it('★★★ 成功 ⇒ 返回 value（不是 {ok, value}）', () => {
    const value = { windowDays: 7, imminentDays: 3, source: 'setting', clamped: false }
    const result = unwrapRpcResult({ ok: true, value })
    expect(result, '必须直接返回 value').toEqual(value)
    // ⚠️ 反向：它**不带** `ok` 字段 —— 这正是 `res?.ok !== true` 恒真的原因
    expect(result).not.toHaveProperty('ok')
  })

  it('★★★ 失败 ⇒ 抛 Error（不是返回 {ok:false}）', () => {
    expect(() => unwrapRpcResult({ ok: false, error: { code: 'bad-request', message: 'provider 必填' } }))
      .toThrow('provider 必填')
  })
})

describe('credits.window 端点经真实 unwrap 后的形状', () => {
  it('★★★ get ⇒ 能直接拿到 windowDays / imminentDays（弹窗按此判据）', async () => {
    const rpc = makeRpc()
    try {
      const res = await rpc.rpcCall('credits.window.get', { provider: 'trae' })
      // ★ 弹窗的正确判据：看字段是否存在，而不是 res.ok
      expect(typeof res?.windowDays, 'windowDays 必须是数字').toBe('number')
      expect(typeof res?.imminentDays, 'imminentDays 必须是数字').toBe('number')
      expect(res.windowDays).toBe(15)
      expect(res.imminentDays).toBe(5)
      expect(res.source).toBe('default')
    } finally {
      rpc.restore()
    }
  })

  it('★★★ set ⇒ 返回落盘后的生效值，再读一致', async () => {
    const rpc = makeRpc()
    try {
      const setRes = await rpc.rpcCall('credits.window.set', { provider: 'trae', windowDays: 7, imminentDays: 3 })
      expect(setRes.windowDays).toBe(7)
      expect(setRes.imminentDays).toBe(3)
      expect(setRes.source).toBe('setting')

      const getRes = await rpc.rpcCall('credits.window.get', { provider: 'trae' })
      expect(getRes).toEqual(setRes)
    } finally {
      rpc.restore()
    }
  })

  it('★ 钳制：填 10/20 ⇒ 返回 imminentDays=10 + clamped=true', async () => {
    const rpc = makeRpc()
    try {
      const res = await rpc.rpcCall('credits.window.set', { provider: 'trae', windowDays: 10, imminentDays: 20 })
      expect(res.windowDays).toBe(10)
      expect(res.imminentDays, '临期必须被钳到 ≤ 短期').toBe(10)
      expect(res.clamped, '必须标记钳制过').toBe(true)
    } finally {
      rpc.restore()
    }
  })

  it('★ 恢复默认：不传字段 ⇒ 回落 default', async () => {
    const rpc = makeRpc()
    try {
      await rpc.rpcCall('credits.window.set', { provider: 'trae', windowDays: 7 })
      const reset = await rpc.rpcCall('credits.window.set', { provider: 'trae' })
      expect(reset.source).toBe('default')
      expect(reset.windowDays).toBe(15)
    } finally {
      rpc.restore()
    }
  })

  it('★ 非法 provider ⇒ 抛错（不是静默 ok:false）', async () => {
    const rpc = makeRpc()
    try {
      await expect(rpc.rpcCall('credits.window.get', { provider: '' })).rejects.toThrow('provider 必填')
    } finally {
      rpc.restore()
    }
  })
})

/**
 * 源码级**兜底**：弹窗模块里不得误解 rpcCall 的契约。
 *
 * ⚠️ 为什么行为级用例不够：它们只能证明「端点 + unwrap 正确」，
 *    证明不了「弹窗自己没写错判据」（弹窗 import react、跑不进单测）。
 *    两者互补。
 */
describe('源码级兜底：弹窗不得误解 rpcCall 契约', () => {
  /** 取 `credits.window.*` 调用点之后 800 字符，并**剥掉注释行**。 */
  function callSiteCode() {
    const source = readFileSync(
      join(process.cwd(), 'plugin-src', 'client', 'jet-hub.js'),
      'utf8',
    )
    const re = /credits\.window\.(get|set)/g
    const chunks = []
    let m = re.exec(source)
    while (m !== null) {
      const slice = source.slice(m.index, m.index + 800)
      const codeLines = slice.split('\n').filter((line) => {
        const t = line.trim()
        return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
      })
      chunks.push(codeLines.join('\n'))
      m = re.exec(source)
    }
    return chunks
  }

  it('★★★ 不得用 res.ok 判据（rpcCall 已解包，成功直接返 value）', () => {
    const offenders = callSiteCode().filter((code) => /res\??\.ok\s*(!==|===)/.test(code))
    expect(offenders, '弹窗不得用 res.ok —— rpcCall 成功返 value、失败抛错').toEqual([])
  })

  it('★★★ 不得读 res.value（rpcCall 已解包，value 就是 res 本身）', () => {
    const offenders = callSiteCode().filter((code) => /res\??\.value/.test(code))
    expect(offenders, '不得读 res.value —— rpcCall 已把 value 解包成 res 本身').toEqual([])
  })
})


/**
 * ★★ **两个窗口必须成对回传**（2026-11-21 对抗审计：这条不变式**零守卫**）。
 *
 * 变体实测：把 `credits.permanentLock` 回传里的 `imminentDays` 撤掉 ⇒
 * **没有任何 credit-window / RPC 用例变红**。而 `src/jet-hub-rpc.ts:9149`
 * 的注释逐字写着「两个窗口必须成对回传：只给 `windowDays` 会让前端
 * `normalizeImminentDays(undefined)` 退化成『临期窗口 = 总窗口』
 * ⇒ 面板『临期』段恒为 0、临时积分全落『短期』段」。
 *
 * ⇒ 用**计数式**源码断言：4 处回传点全部成对，且不存在「只给 windowDays」的形态。
 *   ⚠️ 局限如实登记：源码文本断言挡不住 `if (false)` 包住（本仓已知弱点）。
 *   真正的行为级守卫需要构造 4 条 RPC 通道的 pool 替身，成本高于本条不变式的价值。
 */
describe('成对回传守卫（源码级，局限已登记）', () => {
  it('★★ 4 处窗口回传点全部 `windowDays` + `imminentDays` 成对', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/jet-hub-rpc.ts', import.meta.url), 'utf8'))
    const paired = source.match(/return \{ windowDays: w\.windowDays, imminentDays: w\.imminentDays \}/g) ?? []
    expect(paired.length, '成对回传点数量变了：要么新增了回传（请一并改成成对），要么有处被改成了单字段').toBe(4)
    // 反向：不得出现「只给 windowDays」的回传形态
    expect(source).not.toMatch(/return \{ windowDays: w\.windowDays \}/)
  })
})
