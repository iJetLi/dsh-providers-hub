/**
 * 接线层守卫：`options.system` 必须一路走到 `messages[]`（GitHub #97）。
 *
 * ## 守的失效形态
 *
 * `src/system-prompt-fold.ts` 的 `foldSystemIntoMessages` 与三个 builder 的折叠行为
 * 有自己的用例，但那些用例**直接调 builder**，绕过了 adapter。对抗审计实测：
 * 把 `src/modelscope-adapter.ts` / `src/qiniu-adapter.ts` 里那行
 * `...options.system !== undefined && options.system.length > 0 ? { system: options.system } : {}`
 * **整行删掉**，全量 0 files / 0 tests failed —— 也就是 #97 会静默复发而测试全绿
 * （症状：请求 200、正文正常、模型完全不知道 system 存在）。
 *
 * marvis 有 `marvis-adapter.spec.ts` / `marvis-identity.spec.ts` 把 adapter→wire 锁住，
 * 这两家原本没有。本文件补上：**判据打在真实请求体上**，不是打在「builder 被怎么调用」。
 *
 * ## 为什么判据是 `JSON.parse(init.body)` 而不是 spy builder
 *
 * spy 只能证明「有人传了参数」，证明不了「wire 上是第一条 system 消息」。
 * 这里让 adapter 真跑一遍 `stream()`（fetch 被替换），再从请求体里读。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelscopeAdapter } from '../../src/modelscope-adapter.js'
import { MODELSCOPE } from '../../src/modelscope-product.js'
import { QiniuAdapter } from '../../src/qiniu-adapter.js'
import { QINIU } from '../../src/qiniu-product.js'

const SYSTEM = 'SYS-97-你是本次请求专用的评审策略'

/** 一条能正常收尾的 OpenAI 兼容 SSE。 */
function okSse(): Response {
  const enc = new TextEncoder()
  const rows = [
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
    'data: [DONE]\n',
  ]
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const row of rows) controller.enqueue(enc.encode(row))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 跑一次 `stream()` 并返回它真正发出去的请求体。 */
async function bodyOf(
  run: (options: Record<string, unknown>) => AsyncIterable<unknown>,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    calls.push(String(init?.body ?? ''))
    return okSse()
  }))
  try {
    for await (const _chunk of run(options)) { /* drain */ }
  } finally {
    vi.unstubAllGlobals()
  }
  expect(calls, 'adapter 必须真的发了一次请求').toHaveLength(1)
  return JSON.parse(calls[0] ?? '{}') as Record<string, unknown>
}

afterEach(() => { vi.unstubAllGlobals() })

const MESSAGES = [{ role: 'user', content: 'hi' }]

describe('modelscope：options.system 必须折进 messages[]（GitHub #97 接线层）', () => {
  const make = (): ModelscopeAdapter => new ModelscopeAdapter({
    slots: async () => [{ id: 'a1', apiKey: 'ms-0123456789abcdefghij' }],
    product: MODELSCOPE,
    warn: () => {},
  } as never)

  it('★★ 带 system ⇒ 顶层没有 system 键，且 messages[0] 就是它', async () => {
    const body = await bodyOf(
      (options) => make().stream(options as never),
      { model: 'deepseek-ai/DeepSeek-V4-Flash-0731', messages: MESSAGES, system: SYSTEM },
    )
    expect(
      Object.hasOwn(body, 'system'),
      '顶层 system 会被这类网关静默忽略 —— 消息发出去了但模型收不到',
    ).toBe(false)
    const messages = body.messages as { role: string; content: unknown }[]
    expect(messages[0], 'system 必须是第一条').toEqual({ role: 'system', content: SYSTEM })
    expect(messages).toHaveLength(2)
  })

  it('★ 不带 system ⇒ 不多折一条空 system 消息', async () => {
    const body = await bodyOf(
      (options) => make().stream(options as never),
      { model: 'deepseek-ai/DeepSeek-V4-Flash-0731', messages: MESSAGES },
    )
    expect(Object.hasOwn(body, 'system')).toBe(false)
    expect((body.messages as unknown[])[0]).toEqual({ role: 'user', content: 'hi' })
  })
})

describe('qiniu：options.system 必须折进 messages[]（GitHub #97 接线层）', () => {
  const make = (): QiniuAdapter => new QiniuAdapter({
    slots: async () => [{ id: 'a1', apiKey: 'qiniu-testkey-0123456789abcdef' }],
    product: QINIU,
    warn: () => {},
  } as never)

  it('★★ 带 system ⇒ 顶层没有 system 键，且 messages[0] 就是它', async () => {
    const body = await bodyOf(
      (options) => make().stream(options as never),
      { model: 'deepseek-v3', messages: MESSAGES, system: SYSTEM },
    )
    expect(
      Object.hasOwn(body, 'system'),
      '顶层 system 会被这类网关静默忽略 —— 消息发出去了但模型收不到',
    ).toBe(false)
    const messages = body.messages as { role: string; content: unknown }[]
    expect(messages[0], 'system 必须是第一条').toEqual({ role: 'system', content: SYSTEM })
    expect(messages).toHaveLength(2)
  })

  it('★ 不带 system ⇒ 不多折一条空 system 消息', async () => {
    const body = await bodyOf(
      (options) => make().stream(options as never),
      { model: 'deepseek-v3', messages: MESSAGES },
    )
    expect(Object.hasOwn(body, 'system')).toBe(false)
    expect((body.messages as unknown[])[0]).toEqual({ role: 'user', content: 'hi' })
  })
})
