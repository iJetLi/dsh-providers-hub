/**
 * 「严格手动顺序」的**持久化 round-trip**：`AccountPool.setStrictManualOrder()`
 * 必须真的落盘，且能在**下一个进程**里读回来。
 *
 * ## 为什么需要它（2026-11-09 审计：`jet-hub-store.spec.ts` 的 +6 行是假绿）
 *
 * 那条改动只在既有断言里补了 `strictManualOrder: {}` 这个**期望值**。
 * 因为默认值就是 `{}`，所以即使 `queueStoreSave` 的载荷**漏掉该键**，
 * `save` → `load` 之后仍然得到 `{}` ⇒ 用例照样绿。
 *
 * 而漏键的后果是本仓库反复踩过的 `replace` 整体替换陷阱：
 * **任何**一次账号 / 黑名单 / 网关 / 顺序写入都会把用户打开的开关抹掉，
 * 重启后面板静默回到「余额分档优先」—— 用户只看到「拖拽又不灵了」。
 *
 * ⇒ 判据必须同时钉住三件事：
 * 1. 落盘载荷**带着**这个键（漏键直接红）；
 * 2. 新进程能读回 `true`（round-trip）；
 * 3. **无关写入不抹键**（这是「整体替换」缺陷的实际形态）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/account-pool.js'

/**
 * 隔离 DSH home：`AccountPool` 的「永久积分锁定表」走独立文件
 *（`$DSH_HOME/jet-hub/permanent-locks.json`），不隔离就会读写用户真实目录。
 */
let isolatedHome: string | undefined
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env.DSH_JET_HUB_STATE_DIR
  isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-strict-manual-order-'))
  process.env.DSH_JET_HUB_STATE_DIR = isolatedHome
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
  else process.env.DSH_JET_HUB_STATE_DIR = previousHome
  if (isolatedHome !== undefined) rmSync(isolatedHome, { recursive: true, force: true })
})

interface Backend {
  /** 模拟磁盘上的文档（`undefined` = 还没有任何文档）。 */
  document: Record<string, unknown> | undefined
}

interface PoolFixture {
  readonly pool: AccountPool
  /** 每一次 `replace` 的载荷（按落盘顺序）。 */
  readonly payloads: Record<string, unknown>[]
  /** 新建一个共用同一份「磁盘」的池（模拟重启）。 */
  restart(): PoolFixture
}

function createFixture(backend: Backend = { document: undefined }): PoolFixture {
  const payloads: Record<string, unknown>[] = []
  const settings = {
    register: () => ({
      get: () => backend.document,
      replace: async (value: Record<string, unknown>) => {
        payloads.push(value)
        backend.document = value
      },
    }),
    describe: () => [{ ns: 'jet-hub', value: backend.document }],
  }
  const ctx = {
    get: (key: string) => (key === 'settings' ? settings : undefined),
    logger: { warn: () => {}, info: () => {} },
  }
  return {
    pool: new AccountPool(ctx as never),
    payloads,
    restart: () => createFixture(backend),
  }
}

beforeEach(() => {
  // 每个用例从「没有文档」开始：残留会让「首次载入」路径被跳过。
  rmSync(join(isolatedHome!, 'jet-hub'), { recursive: true, force: true })
})

describe('AccountPool · 严格手动顺序持久化', () => {
  it('默认关闭（老文档没有该键）', () => {
    const { pool } = createFixture()
    expect(pool.strictManualOrder('buddy')).toBe(false)
  })

  it('★ 打开后落盘载荷**必须带**该键，且新进程读回 true', async () => {
    const fixture = createFixture()
    await fixture.pool.setStrictManualOrder('buddy', true)

    // ① 载荷带着这个键（漏键 ⇒ 这里直接红，不用等 round-trip）
    const payload = fixture.payloads.at(-1)!
    expect(payload.strictManualOrder).toEqual({ buddy: true })

    // ② 同实例可见
    expect(fixture.pool.strictManualOrder('buddy')).toBe(true)

    // ③ 新进程（同一份磁盘）可见 —— 这才是「重启后开关还在」
    const restarted = fixture.restart()
    expect(restarted.pool.strictManualOrder('buddy')).toBe(true)
  })

  it('★ 无关写入不得抹掉该键（`replace` 整体替换陷阱的实际形态）', async () => {
    const fixture = createFixture()
    await fixture.pool.setStrictManualOrder('buddy', true)
    // 任何一次其它状态的写入 —— 这里取「关闭供应商」当代表。
    await fixture.pool.setProviderClosed('trae', true)

    expect(fixture.payloads.at(-1)!.strictManualOrder).toEqual({ buddy: true })
    expect(fixture.restart().pool.strictManualOrder('buddy')).toBe(true)
  })

  it('关闭时**删键**而不是写 false（稀疏表语义）', async () => {
    const fixture = createFixture()
    await fixture.pool.setStrictManualOrder('buddy', true)
    await fixture.pool.setStrictManualOrder('buddy', false)

    expect(fixture.payloads.at(-1)!.strictManualOrder).toEqual({})
    expect(fixture.restart().pool.strictManualOrder('buddy')).toBe(false)
  })

  it('按渠道分开：打开 buddy 不影响 trae', async () => {
    const fixture = createFixture()
    await fixture.pool.setStrictManualOrder('buddy', true)

    expect(fixture.pool.strictManualOrder('buddy')).toBe(true)
    expect(fixture.pool.strictManualOrder('trae')).toBe(false)
    expect(fixture.pool.strictManualOrder('loomy')).toBe(false)
  })

  it('值没变时不写盘（幂等，避免每次点开关都产生一次整体重写）', async () => {
    const fixture = createFixture()
    await fixture.pool.setStrictManualOrder('buddy', true)
    const writes = fixture.payloads.length
    await fixture.pool.setStrictManualOrder('buddy', true)
    expect(fixture.payloads.length).toBe(writes)
  })

  it('provider 为空串时直接早退（不写盘、也不留下空键）', async () => {
    const fixture = createFixture()
    await fixture.pool.setStrictManualOrder('', true)
    expect(fixture.payloads).toHaveLength(0)
    expect(fixture.pool.strictManualOrder('')).toBe(false)
  })

  it('老文档里的脏值在载入时被净化（只认显式 true）', () => {
    const fixture = createFixture({
      document: {
        accounts: [],
        strictManualOrder: { buddy: 'true', trae: 1, qoder: true, loomy: null },
      },
    })
    expect(fixture.pool.strictManualOrder('buddy')).toBe(false)
    expect(fixture.pool.strictManualOrder('trae')).toBe(false)
    expect(fixture.pool.strictManualOrder('qoder')).toBe(true)
    expect(fixture.pool.strictManualOrder('loomy')).toBe(false)
  })
})
