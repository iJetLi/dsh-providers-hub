import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { orderMarvisSlots, type SlotOrderingPool } from '../../src/marvis-slots.js'

/**
 * `orderMarvisSlots` 的**行为级**守卫（PR #190 双审计返工）。
 *
 * 为什么必须行为级：抽出来之前，这段判定是 `src/index.ts` 里的内联 `if`，而它的
 * 守卫全是 `readFileSync` + `toMatch` 的源码文本断言。两份审计各自实测：
 *
 * - **M8** `if (false && sessionId !== undefined && …)` ⇒ 全绿（子串仍在）
 * - **M9** `pool.orderAccountsForSession(…); return slots`（丢弃结果）⇒ 全绿（调用仍在）
 * - **M21** `!pool.sessionBalanceEnabled()`（反向读）⇒ 全绿（名字仍在）
 *
 * 本仓红线原文：「源码文本断言挡不住『留着但失效』」。下面每条用例都用**真调用**
 * 的返回序列作判据，三条失效各自会红在某一条上。
 */

interface Slot {
  readonly id: string
}

const SLOTS: readonly Slot[] = [{ id: 'marvis-a' }, { id: 'marvis-b' }, { id: 'marvis-c' }]

function makePool(options: { enabled: boolean }): {
  pool: SlotOrderingPool
  calls: Array<{ provider: string; accounts: readonly Slot[]; sessionId?: string }>
} {
  const calls: Array<{ provider: string; accounts: readonly Slot[]; sessionId?: string }> = []
  const pool: SlotOrderingPool = {
    sessionBalanceEnabled: () => options.enabled,
    orderAccountsForSession: <T extends { readonly id: string }>(
      provider: string,
      accounts: readonly T[],
      sessionId?: string,
    ): T[] => {
      calls.push({ provider, accounts, sessionId })
      // 故意**反向**返回：只要接线真的用了池的返回值，用例就能与池序区分开。
      return [...accounts].reverse()
    },
  }
  return { pool, calls }
}

describe('★ orderMarvisSlots（会话分散门控的纯函数）', () => {
  it('★★★ 会话 + 开关开 ⇒ 必须用池的返回值（不是池序）：反向序即证', () => {
    const { pool, calls } = makePool({ enabled: true })
    const ordered = orderMarvisSlots(pool, SLOTS, 'session-abc')
    expect(ordered.map((slot) => slot.id)).toEqual(['marvis-c', 'marvis-b', 'marvis-a'])
    expect(calls).toHaveLength(1)
  })

  it('★★★ 开关关 ⇒ 原样返回池序，且**一次都不许**调池（删掉/反向读开关都会红）', () => {
    const { pool, calls } = makePool({ enabled: false })
    const ordered = orderMarvisSlots(pool, SLOTS, 'session-abc')
    expect(ordered.map((slot) => slot.id)).toEqual(['marvis-a', 'marvis-b', 'marvis-c'])
    expect(calls).toHaveLength(0)
  })

  it('★★★ 无 sessionId（网关请求的形态）⇒ 原样返回池序，且不调池', () => {
    const { pool, calls } = makePool({ enabled: true })
    const ordered = orderMarvisSlots(pool, SLOTS, undefined)
    expect(ordered.map((slot) => slot.id)).toEqual(['marvis-a', 'marvis-b', 'marvis-c'])
    expect(calls).toHaveLength(0)
  })

  it('★★ 空串 sessionId 与未传等价（`length === 0` 那一腿不能被删）', () => {
    const { pool, calls } = makePool({ enabled: true })
    expect(orderMarvisSlots(pool, SLOTS, '').map((slot) => slot.id)).toEqual([
      'marvis-a', 'marvis-b', 'marvis-c',
    ])
    expect(calls).toHaveLength(0)
  })

  it('★ 传给池的 provider 必须是 marvis、sessionId 必须原样透传', () => {
    const { pool, calls } = makePool({ enabled: true })
    orderMarvisSlots(pool, SLOTS, 'session-xyz')
    expect(calls).toEqual([
      { provider: 'marvis', accounts: SLOTS, sessionId: 'session-xyz' },
    ])
  })

  it('★ 单槽位也要走池（「一个号也要排序」不是提前退出的理由）', () => {
    const { pool, calls } = makePool({ enabled: true })
    const one: readonly Slot[] = [{ id: 'only' }]
    expect(orderMarvisSlots(pool, one, 'session-abc').map((slot) => slot.id)).toEqual(['only'])
    expect(calls).toHaveLength(1)
  })
})

describe('★ src/index.ts 的接线（只挡「调用 + 返回结果」，门控语义由上面覆盖）', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
  const block = (() => {
    const start = source.indexOf('const marvisAdapter = registerMarvisLlm(ctx')
    expect(start, 'src/index.ts 里找不到 marvis 装配块').toBeGreaterThan(-1)
    const end = source.indexOf('magicrewAuth', start)
    return source.slice(start, end > start ? end : start + 4000)
  })()

  it('★★ 必须**返回**纯函数的结果（`return\s+orderMarvisSlots(` —— 丢弃返回值会红）', () => {
    expect(block).toMatch(/return\s+orderMarvisSlots\(/)
  })

  it('★★ 不许再有第二套内联判据（`pool.orderAccountsForSession(` 在装配块里只许出现在注释）', () => {
    const stripped = block.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
    expect(stripped).not.toMatch(/pool\.orderAccountsForSession\(/)
  })

  it('★ 排序发生在凭据解析之后（它排的是已解析的槽，不是账号条目）', () => {
    const parseAt = block.indexOf('parseMarvisCredential(')
    const orderAt = block.indexOf('orderMarvisSlots(')
    expect(parseAt).toBeGreaterThan(-1)
    expect(orderAt).toBeGreaterThan(parseAt)
  })
})
