import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * ★★ 「轮换起点」的**行为级**守卫（PR #59 对抗审计 P0-①）。
 *
 * 审计事实（2026-11-13，`reports/pr59-adv-audit.md`）：
 *   `src/account-pool.ts` 里「位次 → accountId」那一段改成 `const entry = undefined`
 *   ⇒ `preferredRotationFor` 恒 `undefined`、整条选号链路形同虚设，
 *   而 **core 798 用例 + full 13,118 用例全绿**。
 *
 * 根因：PR 自带的 23 条接线用例全是**源码文本断言**（查 `sessionId` 字样在不在），
 * 从来没有人真调 `preferredRotationFor`。本文件补的就是这一层：
 * 真构造 `AccountPool`、真写文档、真读回，三形态各一条。
 */

function entry(id: string, overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id,
    provider: 'buddy',
    nickname: id,
    enabled: true,
    credentialRef: `BUDDY_ACCOUNT_${id.toUpperCase()}` as never,
    createdAt: 1,
    expiresAt: Date.now() + 3_600_000,
    refreshable: true,
    ...overrides,
  }
}

/** 极简 ctx：只提供 `AccountPool` 真正会碰的三样东西。 */
function makeCtx(doc: Record<string, unknown>): Record<string, unknown> {
  const settings = {
    register: () => ({
      get: () => doc,
      replace: async (next: Record<string, unknown>) => {
        for (const key of Object.keys(doc)) delete doc[key]
        Object.assign(doc, next)
      },
    }),
    describe: () => [{ ns: 'jet-hub', value: doc }],
  }
  return {
    settings,
    get: (key: string) => (key === 'settings' ? settings : undefined),
    logger: { warn: () => {}, info: () => {} },
    credentials: {
      describe: async () => ({ configured: true, source: 'test' as const, writable: true }),
      resolve: async () => ({ value: '{}', source: 'test' as const }),
      set: async () => {},
      unset: async () => {},
    },
  }
}

/** 4 个账号：a / b / c 启用，d **停用**（位次只数启用账号）。 */
function baseDoc(): Record<string, unknown> {
  return {
    accounts: [entry('a'), entry('b'), entry('c'), entry('d', { enabled: false })],
    preferredRotation: {},
  }
}

let isolatedHome: string | undefined
let previousStateDir: string | undefined

beforeAll(() => {
  previousStateDir = process.env.DSH_JET_HUB_STATE_DIR
  isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-rotation-pool-'))
  process.env.DSH_JET_HUB_STATE_DIR = isolatedHome
})

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = previousStateDir
  if (isolatedHome !== undefined) rmSync(isolatedHome, { recursive: true, force: true })
})

describe('★★ AccountPool 的「轮换起点」（行为级）', () => {
  let doc: Record<string, unknown>
  let pool: AccountPool

  beforeEach(() => {
    doc = baseDoc()
    pool = new AccountPool(makeCtx(doc) as never)
  })

  it('{position, at} ⇒ 位次换算成「启用账号」里那一个的 id（停用不计入位次）', () => {
    doc.preferredRotation = { buddy: { s1: { position: 2, at: 1 } } }
    pool = new AccountPool(makeCtx(doc) as never)
    expect(pool.preferredRotationFor('buddy', 's1')).toBe('b')
  })

  it('{position, at} 的位次 3 ⇒ c（停用的 d 不占位次）', () => {
    doc.preferredRotation = { buddy: { s1: { position: 3, at: 1 } } }
    pool = new AccountPool(makeCtx(doc) as never)
    expect(pool.preferredRotationFor('buddy', 's1')).toBe('c')
  })

  it('裸字符串形态（最老格式）⇒ 原样返回该 id，不抛 TypeError', () => {
    doc.preferredRotation = { buddy: { s1: 'c' } }
    pool = new AccountPool(makeCtx(doc) as never)
    expect(pool.preferredRotationFor('buddy', 's1')).toBe('c')
  })

  it('{accountId, at} 形态 ⇒ 跟随该账号', () => {
    doc.preferredRotation = { buddy: { s1: { accountId: 'a', at: 1 } } }
    pool = new AccountPool(makeCtx(doc) as never)
    expect(pool.preferredRotationFor('buddy', 's1')).toBe('a')
  })

  it('位次越界（账号变少）⇒ undefined（回落默认，绝不 clamp）', () => {
    doc.preferredRotation = { buddy: { s1: { position: 9, at: 1 } } }
    pool = new AccountPool(makeCtx(doc) as never)
    expect(pool.preferredRotationFor('buddy', 's1')).toBeUndefined()
  })

  it('空 sessionId / 空 provider ⇒ undefined（默认起点）', () => {
    doc.preferredRotation = { buddy: { s1: { position: 1, at: 1 } } }
    pool = new AccountPool(makeCtx(doc) as never)
    expect(pool.preferredRotationFor('buddy', '')).toBeUndefined()
    expect(pool.preferredRotationFor('', 's1')).toBeUndefined()
  })

  it('=== 写路径：setPreferredRotation 落盘后能被读回（写→读闭环）', async () => {
    await pool.setPreferredRotation('buddy', 's1', 2)
    expect(pool.preferredRotationFor('buddy', 's1')).toBe('b')
    const stored = (doc.preferredRotation as Record<string, Record<string, { position: number }>>).buddy
    expect(stored?.s1?.position).toBe(2)
  })

  it('=== 写路径：位次非法（0 / 非整数）⇒ 不落盘', async () => {
    await pool.setPreferredRotation('buddy', 's1', 0)
    await pool.setPreferredRotation('buddy', 's1', 1.5)
    expect(pool.preferredRotationFor('buddy', 's1')).toBeUndefined()
  })

  it('=== 写路径：null ⇒ 删键、恢复默认', async () => {
    await pool.setPreferredRotation('buddy', 's1', 2)
    expect(pool.preferredRotationFor('buddy', 's1')).toBe('b')
    await pool.setPreferredRotation('buddy', 's1', null)
    expect(pool.preferredRotationFor('buddy', 's1')).toBeUndefined()
    // 整层空了连 provider 层一起删
    expect(doc.preferredRotation).toEqual({})
  })
})
