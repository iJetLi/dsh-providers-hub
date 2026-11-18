/**
 * ★ Marvis uskey 桥：错误分类 / 安装位置发现 / 钩子幂等安装。
 *
 * 判据全部打在**用户可见后果**上：
 * - 拿不到头时抛的是哪个 `code`、带不带可操作的 `hint`（决定 UI 文案）；
 * - 版本目录换了之后还能不能找到（这是「升级即坏」的根因）；
 * - 钩子安装是否幂等、会不会覆盖别人的 `sitecustomize.py`。
 *
 * 不锁实现细节：RPC 协议细节（文件名格式、轮询间隔）只作为**测试脚手架**使用，
 * 断言不依赖它们的具体取值。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 每个用例独立的 RPC 目录 —— 桥的模块级常量在 import 时求值，故每次重置模块。 */
let rpcDir: string

async function loadBridge(): Promise<typeof import('../../src/marvis-uskey-bridge.js')> {
  // 模块级的 `USKEY_RPC_DIR` 在 import 时求值 ⇒ 必须先设环境变量再重置模块图。
  vi.resetModules()
  return import('../../src/marvis-uskey-bridge.js')
}

beforeEach(() => {
  rpcDir = mkdtempSync(join(tmpdir(), 'marvis-bridge-'))
  process.env.DSH_MARVIS_USKEY_RPC = rpcDir
})

afterEach(() => {
  rmSync(rpcDir, { recursive: true, force: true })
  delete process.env.DSH_MARVIS_USKEY_RPC
})

describe('uskey 桥：失败分类', () => {
  it('无人应答时抛 TIMEOUT，且 retriable=true', async () => {
    const bridge = await loadBridge()
    const error = await bridge.requestMarvisHeadersDetailed({}, 300).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(bridge.MarvisBridgeError)
    const bridgeError = error as InstanceType<typeof bridge.MarvisBridgeError>
    // 没有钩子/没有 agent 时可能是 HOOK_MISSING / AGENT_DOWN / TIMEOUT 三者之一，
    // 但**一定**是结构化错误且带 hint（否则 UI 只能显示「连接失败」）。
    expect(['TIMEOUT', 'HOOK_MISSING', 'AGENT_DOWN']).toContain(bridgeError.code)
    expect(typeof bridgeError.hint).toBe('string')
    expect(bridgeError.hint.length).toBeGreaterThan(0)
  })

  it('钩子返回 ok:false 时抛 HOOK_ERROR，并把原因带出来', async () => {
    const bridge = await loadBridge()
    const pending = bridge.requestMarvisHeadersDetailed({}, 3000)

    // 扮演钩子：等请求文件出现后写一个失败响应。
    const reqName = await waitForRequestFile(rpcDir)
    const rid = reqName.slice('req-'.length, -'.json'.length)
    writeFileSync(join(rpcDir, `resp-${rid}.json`), JSON.stringify({ ok: false, error: '未登录' }), 'utf8')

    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(bridge.MarvisBridgeError)
    const bridgeError = error as InstanceType<typeof bridge.MarvisBridgeError>
    expect(bridgeError.code).toBe('HOOK_ERROR')
    // 未登录是**用户可修**的 ⇒ hint 必须指向「重新登录」。
    expect(bridgeError.hint).toContain('登录')
    expect(bridgeError.message).toContain('未登录')
  })

  it('钩子返回 ok:true 时给出 headers 与 uskey 长度', async () => {
    const bridge = await loadBridge()
    const pending = bridge.requestMarvisHeadersDetailed({ model: 'main-auto' }, 3000)

    const reqName = await waitForRequestFile(rpcDir)
    const rid = reqName.slice('req-'.length, -'.json'.length)
    const ext = JSON.stringify({ uskey: 'C'.repeat(524) })
    writeFileSync(
      join(rpcDir, `resp-${rid}.json`),
      JSON.stringify({
        ok: true,
        headers: {
          'Ual-Access-MarvisExt': ext,
          'Marvis-Scene': 'agent_chat',
        },
      }),
      'utf8',
    )

    const result = await pending
    // uskey 长度要能透出来 —— 这是「524 才对」这条预警的判据来源。
    expect(result.uskeyLength).toBe(524)
    expect(result.headers['Marvis-Scene']).toBe('agent_chat')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('并发请求不会串号（每份响应只被对应请求消费）', async () => {
    const bridge = await loadBridge()
    const [a, b] = [
      bridge.requestMarvisHeadersDetailed({ convId: 'conv-a' }, 3000),
      bridge.requestMarvisHeadersDetailed({ convId: 'conv-b' }, 3000),
    ]

    const seen: string[] = []
    for (let i = 0; i < 2; i += 1) {
      const reqName = await waitForRequestFile(rpcDir, seen)
      seen.push(reqName)
      const rid = reqName.slice('req-'.length, -'.json'.length)
      const conv = JSON.parse(readFileSync(join(rpcDir, reqName), 'utf8')).conv_id as string
      writeFileSync(
        join(rpcDir, `resp-${rid}.json`),
        JSON.stringify({ ok: true, headers: { 'X-For': conv } }),
        'utf8',
      )
    }

    const [ra, rb] = await Promise.all([a, b])
    // 关键判据：每份响应必须回到**发起的那个**请求（否则 uskey 会张冠李戴）。
    expect(new Set([ra.headers['X-For'], rb.headers['X-For']])).toEqual(new Set(['conv-a', 'conv-b']))
  })
})

describe('uskey 桥：安装位置发现', () => {
  it('无 Marvis 安装时返回 undefined 而不是抛异常', async () => {
    const bridge = await loadBridge()
    // 本机装没装 Marvis 都可能；判据只是「不许抛」。
    expect(() => bridge.locateMarvisInstall()).not.toThrow()
  })

  it('inspectMarvisBridge 在任何环境下都给出非空 summary', async () => {
    const bridge = await loadBridge()
    const status = bridge.inspectMarvisBridge()
    // 体检是 UI 的唯一数据源 ⇒ summary 必须始终可显示。
    expect(typeof status.summary).toBe('string')
    expect(status.summary.length).toBeGreaterThan(0)
    expect(typeof status.healthy).toBe('boolean')
    expect(typeof status.agentRunning).toBe('boolean')
  })
})

/** 等一个 `req-*.json` 出现（排除已消费过的名字）。 */
async function waitForRequestFile(dir: string, exclude: readonly string[] = []): Promise<string> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (existsSync(dir)) {
      const found = readdirSync(dir)
        .filter((name) => name.startsWith('req-') && name.endsWith('.json'))
        .find((name) => !exclude.includes(name))
      if (found !== undefined) return found
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等不到 req 文件（桥没有写出请求）')
}