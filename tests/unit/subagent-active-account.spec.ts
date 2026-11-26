/**
 * ★★★ **「实际在用账号」与「全部 provider 生效」的行为守卫**
 *（2026-11-25，用户定案 B 方案）。
 *
 * ## 用户的两条要求
 *
 * > 「子代理轮换起点策略的参考对象，是主代理**实际在使用的帐号**，
 * >   而不是下拉框选择的」
 *
 * > 「这个子代理设置是要对**全部 providers** 生效的，记得要做好兼容」
 *
 * ## 本文件守什么
 *
 * | # | 断言 | 改坏就红 |
 * |---|---|---|
 * | A1 | 选号成功后 `setActiveAccount` 被调用（**统一出口**，不靠各处配）| 删那行 ⇒ 红 |
 * | A2 | `sessionId === undefined` 时**不记**（目录/网关流量不占 key）| 去掉判断 ⇒ 红 |
 * | A3 | 子代理参照 `activeAccountOf` **优先于** `preferredRotationFor` | 换顺序 ⇒ 红 |
 * | A4 | `activeAccountOf` 缺失时**回落** `preferredRotationFor` | 去掉回落 ⇒ 红 |
 * | A5 | 无档位 provider 写 `setSubagentStartPosition`（不用 `setPreferredRotation`）| 换 API ⇒ 红 |
 * | A6 | `AccountPool.setActiveAccount` 按**会话**分组（不串味）| 改扁平 ⇒ 红 |
 * | A7 | `AccountPool.setActiveAccount(undefined)` ⇒ 清空该会话 | 不删 ⇒ 红 |
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { createCredentialResolver } from '../../src/credential-resolver.js'

/** ⚠️ `runFirstStart` 里的池序（与 `listAccountsByProvider` 一致）。 */
const POOL_IDS = ['acc-1', 'acc-2']

/** 造一个最小的 `AccountPool`（只喂内存 store）。 */
function makePool() {
  /**
   * ⚠️ 只注入本文件用到的字段，不构造完整池
   * （避免拉起 store / credentials 等真实依赖）。
   */
  const pool = Object.create(AccountPool.prototype) as AccountPool
  Object.assign(pool as unknown as Record<string, unknown>, {
    ctx: { logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } },
    activeAccountCache: {},
    subagentStartPositionCache: {},
    /** ⚠️ A5 那条用例要断言「**没有**写进 preferredRotation」。 */
    preferredRotationCache: {},
  })
  return pool
}

/** ⚠️ **有档位**的替身（A3/A4 用）：`cachedTierOf` 恒返回 0 = imminent。 */
const tieredSelector = () => ({
  select: async (
    candidates: Array<{ id: string, credentialRef: string }>,
    opts?: { rotationStartId?: string },
  ) => {
    const want = opts?.rotationStartId
    const hit = want === undefined
      ? candidates[0]
      : (candidates.find((x) => x.id === want) ?? candidates[0])
    return { ok: true as const, account: hit, balance: {} }
  },
  /**
   * ★ **有它** ⇒ `credential-resolver` 认定「这个 provider 有档位」
   * ⇒ 走 `setPreferredRotation(位次, 档位)` 那条腿。
   */
  cachedTierOf: () => 0,
})

/** ⚠️ **无档位**的替身（A5 用）：**刻意不给** `cachedTierOf`。 */
const plainSelector = () => ({
  select: async (
    candidates: Array<{ id: string, credentialRef: string }>,
    opts?: { rotationStartId?: string },
  ) => {
    const want = opts?.rotationStartId
    const hit = want === undefined
      ? candidates[0]
      : (candidates.find((x) => x.id === want) ?? candidates[0])
    return { ok: true as const, account: hit, balance: {} }
  },
})

describe('A6/A7：AccountPool 的「实际在用账号」按会话记录', () => {
  it('★★★ 同一 provider 的两个会话**互不串味**', () => {
    /**
     * ## 这是 B 方案的核心
     *
     * 用户有 6 个主代理会话，各自用的号不同。若只按 provider 记
     * （Qoder 的 `activeQoderAccountId` 就是那种形态），
     * 子代理会参照「最后一个发过请求的会话」的号 ⇒ 串味。
     */
    const pool = makePool()
    pool.setActiveAccount('buddy', 'session-A', 'acc-1')
    pool.setActiveAccount('buddy', 'session-B', 'acc-2')
    expect(pool.activeAccountOf('buddy', 'session-A'), '★ A 会话必须还是 acc-1').toBe('acc-1')
    expect(pool.activeAccountOf('buddy', 'session-B'), '★ B 会话必须是 acc-2').toBe('acc-2')
  })

  it('★★★ 不同 provider 互不串味', () => {
    const pool = makePool()
    pool.setActiveAccount('buddy', 's1', 'acc-1')
    pool.setActiveAccount('codearts', 's1', 'acc-9')
    expect(pool.activeAccountOf('buddy', 's1')).toBe('acc-1')
    expect(pool.activeAccountOf('codearts', 's1')).toBe('acc-9')
  })

  it('★★★ 传 `undefined` ⇒ 清空该会话（不留下过期 id）', () => {
    /** ⚠️ 不清空会让子代理参照一个**早已不用的号**。 */
    const pool = makePool()
    pool.setActiveAccount('buddy', 's1', 'acc-1')
    expect(pool.activeAccountOf('buddy', 's1')).toBe('acc-1')
    pool.setActiveAccount('buddy', 's1', undefined)
    expect(pool.activeAccountOf('buddy', 's1'), '★★★ 必须清空').toBeUndefined()
  })

  it('★★ 空 sessionId ⇒ 不记也不读（空串会与「默认」撞键）', () => {
    const pool = makePool()
    pool.setActiveAccount('buddy', '', 'acc-1')
    expect(pool.activeAccountOf('buddy', '')).toBeUndefined()
    expect(pool.activeAccountOf('buddy', undefined)).toBeUndefined()
  })

  it('★★ 没记过 ⇒ undefined（消费方据回落）', () => {
    const pool = makePool()
    expect(pool.activeAccountOf('buddy', 'never-seen')).toBeUndefined()
  })
})

describe('A5：无档位 provider 的独立位置表', () => {
  it('★★★ 写位次后能读回（1-based）', () => {
    const pool = makePool()
    pool.setSubagentStartPosition('accio', 'child-1', 3)
    expect(pool.subagentStartPositionOf('accio', 'child-1')).toBe(3)
  })

  it('★★ 非法位次被拒（0 / 负数 / 非整数）', () => {
    const pool = makePool()
    pool.setSubagentStartPosition('accio', 'child-1', 0)
    expect(pool.subagentStartPositionOf('accio', 'child-1')).toBeUndefined()
    pool.setSubagentStartPosition('accio', 'child-1', -1)
    expect(pool.subagentStartPositionOf('accio', 'child-1')).toBeUndefined()
    pool.setSubagentStartPosition('accio', 'child-1', 1.5)
    expect(pool.subagentStartPositionOf('accio', 'child-1')).toBeUndefined()
  })

  it('★★★ **不与 preferredRotation 混用**（后者要求档位）', () => {
    /**
     * ⚠️ 这张表存在的唯一理由：`setPreferredRotation` 要求档位，
     * 而无档位 provider 给不出档位。
     */
    const pool = makePool()
    pool.setSubagentStartPosition('accio', 'child-1', 2)
    expect(pool.subagentStartPositionOf('accio', 'child-1')).toBe(2)
    const raw = pool as unknown as Record<string, unknown>
    expect(raw.preferredRotationCache, '★ 不得写进 preferredRotation').toEqual({})
  })
})

describe('A1/A2：选号出口**自动**记实际在用账号', () => {
  /** 造一个最小 resolver（走「池兜底」那条腿）。 */
  function makeResolver(options: { pickedId: string, selector: unknown }) {
    const setActiveAccount = vi.fn()
    const pool = {
      listAccountsByProvider: () => [{ id: options.pickedId, credentialRef: 'R1', enabled: true }],
      permanentLocked: () => false,
      strictManualOrder: () => false,
      getAvailableAccount: async () => ({
        entry: { id: options.pickedId },
        credential: 'creds',
      }),
      preferredRotationFor: () => undefined,
      setActiveAccount,
    }
    const resolver = createCredentialResolver(
      { pool } as never,
      {
        product: { id: 'probe', displayName: 'Probe' },
        readCredential: async (ref: string) => ref,
        fallback: { kind: 'ref', refName: 'R_FALLBACK' },
        /** ⚠️ `loomy` = 有余额读数但无档位（ACCIO/ASTUDIO 那种形态）。 */
        balance: {
          kind: 'loomy',
          selector: options.selector as never,
          isFreeModel: () => false,
          lockedError: () => new Error('locked'),
        } as never,
      },
    )
    return { resolver, setActiveAccount }
  }

  it('★★★ 选号成功后**自动**调 `setActiveAccount`（不靠各处配 reportAccount）', async () => {
    /**
     * ## 这条守的是「对全部 provider 生效」的基础设施
     *
     * 实测：24 处 `createCredentialResolver` 调用点里 **7 处没有 `reportAccount`**
     * （ACCIO / MAGICREW / ASTUDIO 等）。若「记实际在用账号」也靠各处自己配，
     * 必然继续漏 —— 所以记在**统一出口**。
     */
    const { resolver, setActiveAccount } = makeResolver({
      pickedId: 'acc-1',
      selector: plainSelector(),
    })
    await resolver('m', 'sess-1')
    expect(setActiveAccount, '★★★ 必须自动记录').toHaveBeenCalled()
    const [provider, sid, acct] = setActiveAccount.mock.calls[0]!
    expect(provider).toBe('probe')
    expect(sid, '★ 必须带 sessionId（按会话记）').toBe('sess-1')
    expect(acct, '★ 必须记实际选中的账号').toBe('acc-1')
  })

  it('★★★ `sessionId === undefined` ⇒ **不记**（目录/网关流量不占 key）', async () => {
    const { resolver, setActiveAccount } = makeResolver({
      pickedId: 'acc-1',
      selector: plainSelector(),
    })
    await resolver('m', undefined)
    expect(setActiveAccount, '★★★ 无会话流量不得记录').not.toHaveBeenCalled()
  })
})

describe('A0（审计 P0-1）：主代理**零回归**', () => {
  /**
   * ## 上游审计原话（2026-11-26）
   *
   * > 「`decideSubagentStart()` 丢了原实现的 **`assignment !== undefined` 闸门**
   * >   ⇒ **主代理会话只要配了任何子代理策略，自己就被改号**」
   * >
   * > 「**没有『主代理零回归』用例**（这正是 P0-1 一路通过的原因）」
   *
   * ## 本组守什么
   *
   * | # | 断言 |
   * |---|---|
   * | A0-1 | 配了任意 `startMode` 后，主代理**仍用它自己的起点** |
   * | A0-2 | 主代理**不得**被写 `preferredRotation` / 起点位次 |
   */
  const POOL = ['acct1', 'acct2', 'acct3']
  const MAIN = 'main-session'

  /** 跑一发**主代理**请求（无分配记录 ⇒ 不是子代理）。 */
  async function runMain(subagentMode?: string) {
    const writes: Array<{ api: string, args: unknown[] }> = []
    const selector = {
      select: async (
        cands: Array<{ id: string, credentialRef: string }>,
        opts?: { rotationStartId?: string },
      ) => {
        const want = opts?.rotationStartId
        const hit = want === undefined ? cands[0] : (cands.find((x) => x.id === want) ?? cands[0])
        return { ok: true as const, account: hit, balance: {} }
      },
      cachedTierOf: () => 0,
    }
    const pool = {
      listAccountsByProvider: () => POOL.map((id) => ({ id, credentialRef: `R-${id}`, enabled: true })),
      permanentLocked: () => false,
      strictManualOrder: () => false,
      getAvailableAccount: async () => ({ entry: { id: 'acct1' }, credential: 'c' }),
      /** ⚠️ **主代理没有分配记录** —— P0-1 的关键。 */
      subagentAssignmentOf: () => undefined,
      /** ⚠️ 但配了子代理策略。 */
      subagentRotationFor: () => (subagentMode === undefined ? undefined : { startMode: subagentMode }),
      /** ⚠️ 主代理自己的轮换起点 = acct1。 */
      preferredRotationFor: (_p: string, sid: string) => (sid === MAIN ? 'acct1' : undefined),
      activeAccountOf: () => undefined,
      setActiveAccount: () => {},
      setPreferredRotation: async (...args: unknown[]) => { writes.push({ api: 'setPreferredRotation', args }) },
      setSubagentStartPosition: (...args: unknown[]) => { writes.push({ api: 'setSubagentStartPosition', args }) },
      subagentParentForSession: () => undefined,
    }
    const resolver = createCredentialResolver(
      { pool, subagentParentForSession: () => undefined } as never,
      {
        product: { id: 'probe', displayName: 'Probe' },
        readCredential: async (ref: string) => ref,
        fallback: { kind: 'ref', refName: 'R-FB' },
        balance: {
          kind: 'buddy',
          selector: selector as never,
          lockedError: () => new Error('locked'),
          isFreeModel: () => false,
          reportPickedAccount: true,
        } as never,
      },
    )
    const picked = await resolver('m', MAIN)
    return { picked, writes }
  }

  it('★★★ 配了任意 startMode ⇒ 主代理**仍用它自己的起点**（不被子代理策略改号）', async () => {
    /**
     * ## 审计的原始症状
     *
     * | provider | 实测（修前）|
     * |---|---|
     * | codearts | `acct1 → acct2` |
     * | officeace（锁定态）| `R1 → R2` |
     *
     * ⇒ 主代理「一配子代理策略就改号」是**修 bug 引入更坏的 bug**。
     */
    const baseline = await runMain(undefined)
    expect(baseline.picked, '基线：主代理用自己的起点 acct1').toBe('R-acct1')

    for (const mode of ['sequence', 'reverse', 'hash', 'follow', 'fixed']) {
      const r = await runMain(mode)
      expect(
        r.picked,
        `★★★ 配了 ${mode} 后主代理**必须仍用 acct1**（实际 ${String(r.picked)}）`,
      ).toBe(baseline.picked)
    }
  })

  it('★★★ 主代理**不得**被写起点（preferredRotation / 位次）', async () => {
    /**
     * ## 审计原话
     *
     * > 「新函数用 `assignment?.slot ?? 0` ⇒ **主代理按 slot 0 现算**」
     *
     * ⇒ 主代理既不该被算起点，也不该被写。
     */
    for (const mode of ['sequence', 'reverse', 'hash', 'fixed']) {
      const r = await runMain(mode)
      expect(r.writes, `★★★ 配了 ${mode} 后主代理不得被写任何起点`).toEqual([])
    }
  })
})

describe('A9（审计第 5 条）：三条选号腿都必须写「实际在用账号」', () => {
  /**
   * ## 上游原话（2026-11-26 第二轮）
   *
   * > 「`setActiveAccount` 调用点 **全仓只有 `resolver:728` 一处**；
   * >   codearts / officeace **自建选号 ⇒ 从不写 `activeAccount`**（实测 `undefined`）
   * >   ⇒ 对原报障两家**零作用**（仍参照下拉框）。」
   *
   * ⇒ **用户实际报障的两家恰恰吃不到这个新方向。**
   *
   * ## 本组守什么
   *
   * 源码级计数：`setActiveAccount` 的**调用**点必须 ≥ 4 处
   * （resolver / codearts / officeace 未锁定 / officeace 锁定）。
   *
   * ⚠️ 为什么用源码计数而不是行为级：那三条腿分属三个模块
   *    （`credential-resolver` / `index` / `officeace-lock`），
   *    行为级要各自搭一套完整依赖；而这里要守的是「**有没有接上**」
   *    这个**结构性事实** —— 少一处就是一个 provider 静默失效。
   *    ⚠️ 但计数会被「留着调用但 `void` 掉结果」绕过 ⇒ 下面配 A9-2 行为级对照。
   */
  /**
   * ⚠️ **路径必须按「本测试文件」的相对位置拼**，不能用 `new URL(name, SRC_DIR)`。
   *
   * 我第一版写成 `new URL(name, new URL('../../src/', import.meta.url))`，
   * 实测**读到的是别处**（`index.ts` 匹配 0 处，而文件里明明有 3 处）
   * ⇒ 计数恒为 1 ⇒ 守卫假红。
   *
   * ⇒ 用 `fileURLToPath` 显式拼绝对路径，与仓库其它 spec 同款。
   */
  const HERE = dirname(fileURLToPath(import.meta.url))

  function readSrc(name: string): string {
    return readFileSync(join(HERE, '../../src', name), 'utf8')
  }

  it('★★★ `setActiveAccount` 调用点 ≥ 4 处（三条腿都接上）', () => {
    const files = ['credential-resolver.ts', 'index.ts', 'officeace-lock.ts']
    let calls = 0
    for (const f of files) {
      const src = readSrc(f)
      for (const line of src.split('\n')) {
        /**
         * ⚠️ 只数**调用**，排除定义与接口声明。
         *
         * 调用形态：
         * - `deps.pool.setActiveAccount?.(…)`（可选链，有 `?.`）
         * - `pool.setActiveAccount(…)`（直接调用，**没有** `?.`）
         *
         * ⇒ 判据只能是 `setActiveAccount` 后面跟 `(` **或** `?.(`，
         *   **不能**写成 `\??\.` —— 那要求后面必有一个 `.`，
         *   会让「直接调用」那三处全数漏掉（我第一版就这么错了）。
         *
         * 排除：`setActiveAccount(provider: string, …)`（定义），
         * 它前面不是 `.`，故用 `\.` 前缀即可区分。
         */
        if (/\.setActiveAccount\s*(?:\?\.)?\(/.test(line)) calls += 1
      }
    }
    expect(
      calls,
      '★★★ 修前只有 1 处（resolver）；codearts 与 officeace 两条腿必须各补一处 '
        + '（officeace 还要分锁定 / 未锁定）⇒ 至少 4 处',
    ).toBeGreaterThanOrEqual(4)
  })

  it('★★★ codearts 腿：写入的是**真正返回凭据的那个号**（不是循环第一个）', () => {
    /**
     * ⚠️ 判据：`available?.entry?.id` —— `available` 是 `getAvailableAccount` 的返回值，
     *    它已经是「池筛选 + 旋转起点」之后**唯一**的选中项。
     * ⇒ 若写成 `rotationStartId`（起点）或 `enabled[0]`（池首），就是错的。
     */
    const src = readSrc('index.ts')
    expect(
      src,
      '★★★ codearts 必须写 `available?.entry?.id`（本次真正选中的号）',
    ).toMatch(/setActiveAccount\('codearts',\s*sessionId,\s*available\?\.entry\?\.id\)/)
  })

  it('★★★ officeace 锁定腿：通过 `reportActiveAccount` 上报（不绕过注入）', () => {
    /**
     * ⚠️ 锁定态那条腿逐个 `classify` 后返回，**不经过** `getAvailableAccount`
     * ⇒ 必须由 `reportActiveAccount` 回调上报，不能指望池自己知道。
     */
    const src = readSrc('officeace-lock.ts')
    expect(
      src,
      '★★★ 锁定腿必须在「真正返回凭据」那一支上报',
    ).toMatch(/verdict\.kind === 'credential'[\s\S]{0,400}deps\.reportActiveAccount\?\.\(/)
  })

  it('★★ officeace 未锁定腿：`resolveOfficeAceCredential` 也要写', () => {
    /** ⚠️ 未锁定是**默认配置**（用户根本没开锁定）⇒ 这条才是主路径。 */
    const src = readSrc('index.ts')
    expect(
      src,
      '★★ 未锁定腿必须写 activeAccount（否则默认配置下零作用）',
    ).toMatch(/setActiveAccount\(OFFICEACE\.id,\s*sessionId,\s*available\?\.entry\?\.id\)/)
  })
})

describe('A8（审计 P3）：付费腿与免费腿必须收敛到同一份判据', () => {
  /**
   * ## 上游原话（2026-11-26 第二轮）
   *
   * > 「免费腿：第二份内联实现仍在 …… **同一设置下付费给 `acc-1`、
   * >   免费给 `acc-2`**（**已分叉**）」
   *
   * ## 修法
   *
   * 免费腿原来有一份**独立的内联实现**（`startIndexOfSlot` 自己拼），
   * 与 `decideSubagentStart` 不是同一份判据。现在两边共用一个函数，
   * 唯一差异是 `selector: undefined`（免费不查档位）。
   *
   * ## 本组守什么
   *
   * 同一份子代理设置，付费腿与免费腿必须给出**同一个号**。
   * ⚠️ 若谁把免费腿改回内联实现，这里必红。
   */
  const POOL4 = ['acc1', 'acc2', 'acc3', 'acc4']

  /** 跑一发（`free` 决定走哪条腿）。
   * ⚠️ **替身必须真的回写** —— 否则首次块写完读不到，会造出假分叉
   *    （我第一版探针就这么错了一次）。
   */
  async function runLeg(free: boolean, mode: string) {
    const prefRotation: Record<string, { position: number }> = {}
    const startPositions: Record<string, number> = {}
    const selector = {
      select: async (c: Array<{ id: string, credentialRef: string }>, o?: { rotationStartId?: string }) => {
        const w = o?.rotationStartId
        return { ok: true as const, account: w ? (c.find((x) => x.id === w) ?? c[0]) : c[0], balance: {} }
      },
      cachedTierOf: () => 0,
    }
    const pool = {
      listAccountsByProvider: () => POOL4.map((id) => ({ id, credentialRef: 'R-' + id, enabled: true })),
      permanentLocked: () => false,
      strictManualOrder: () => false,
      getAvailableAccount: async () => ({ entry: { id: 'acc1' }, credential: 'c' }),
      subagentAssignmentOf: (_p: string, sid: string) => (sid === 'child-1'
        ? { sessionId: 'child-1', parentSessionId: 'parent-1', at: 0, slot: 1 }
        : undefined),
      subagentRotationFor: () => ({ startMode: mode }),
      preferredRotationFor: (_p: string, sid: string) => {
        const own = prefRotation[sid]
        if (own !== undefined) return POOL4[own.position - 1]
        return sid === 'parent-1' ? 'acc2' : undefined
      },
      subagentStartPositionOf: (_p: string, sid: string) => startPositions[sid],
      activeAccountOf: () => undefined,
      setActiveAccount: () => {},
      setPreferredRotation: async (_p: string, sid: string, position: number) => {
        /** ⚠️ **真的回写**。 */
        prefRotation[sid] = { position }
      },
      setSubagentStartPosition: (_p: string, sid: string, position: number) => {
        startPositions[sid] = position
      },
      recordSubagentStart: async () => 0,
      subagentParentForSession: (sid: string) => (sid === 'child-1' ? 'parent-1' : undefined),
    }
    const resolver = createCredentialResolver(
      { pool, subagentParentForSession: (sid: string) => (sid === 'child-1' ? 'parent-1' : undefined) } as never,
      {
        product: { id: 'probe', displayName: 'P' },
        readCredential: async (ref: string) => ref,
        fallback: { kind: 'ref', refName: 'RF' },
        balance: {
          kind: 'buddy',
          selector: selector as never,
          lockedError: () => new Error('x'),
          isFreeModel: () => free,
          reportPickedAccount: true,
        } as never,
      },
    )
    return await resolver('m', 'child-1')
  }

  it('★★★ 五个策略下，付费腿与免费腿给出**同一个号**', async () => {
    for (const mode of ['sequence', 'reverse', 'hash', 'follow', 'fixed']) {
      const paid = await runLeg(false, mode)
      const free = await runLeg(true, mode)
      expect(
        free,
        '★★★ ' + mode + '：免费腿(' + String(free) + ') 必须与付费腿(' + String(paid) + ') 一致',
      ).toBe(paid)
    }
  })

  it('★★★ sequence 的结果必须与手算一致（证明两条腿都不是「恒第一个」）', async () => {
    /**
     * 池 `acc1..acc4`，主代理起点 `acc2`（index 1），slot=1：
     * `sequence` = `(1+1+1)%4 = 3` ⇒ **acc4**（credentialRef `R-acc4`）。
     * ⚠️ 这个断言的价值：若两条腿都退化成「总是第一个号」，它们**也**会一致，
     *    但那不是收敛，是**一起失效**。所以必须另有一条锁住「算得对」。
     */
    expect(await runLeg(false, 'sequence'), '★ 付费腿 sequence 必须是 acc4').toBe('R-acc4')
    expect(await runLeg(true, 'sequence'), '★ 免费腿 sequence 必须是 acc4').toBe('R-acc4')
  })
})

describe('A3/A4：子代理参照的三级回落', () => {
  /**
   * 跑「子代理首次」那一发。
   *
   * ⚠️ **替身必须真的回写**：第一版只把写入记进 `calls`，
   * 导致本次请求读不到刚算出的起点 ⇒ 变异无牙（诊断已证实）。
   */
  function runFirstStart(options: {
    activeAccount?: string
    preferredRotation?: string
    /** ⚠️ 有档位 / 无档位二选一（决定走哪条写入通道）。 */
    withTier: boolean
    /** ⚠️ 免费模型 ⇒ 应**跳过**算起点（2026-11-26 补的守卫）。 */
    isFreeModel?: boolean
    /** ⚠️ `buddy`（有档位 + 可判免费）/ `loomy`（无档位）。默认 `loomy`。 */
    balanceKind?: 'buddy' | 'loomy'
  }) {
    const calls: Array<Record<string, unknown>> = []
    /** ⚠️ **可变表**：模拟真实的 `preferredRotation`（写入即生效）。 */
    const prefRotation: Record<string, { position: number }> = {}
    /** ⚠️ 无档位 provider 的独立表。 */
    const startPosition: Record<string, number> = {}
    const pool = {
      listAccountsByProvider: () => [
        { id: 'acc-1', credentialRef: 'R1', enabled: true },
        { id: 'acc-2', credentialRef: 'R2', enabled: true },
      ],
      permanentLocked: () => false,
      strictManualOrder: () => false,
      getAvailableAccount: async () => ({ entry: { id: 'acc-1' }, credential: 'c' }),
      /** ⚠️ 让首次块进入：有分配记录 + 配了策略 + 本会话无 preferredRotation。 */
      subagentAssignmentOf: () => ({
        sessionId: 'child-1',
        parentSessionId: 'parent-1',
        at: 0,
        slot: 0,
      }),
      subagentRotationFor: () => ({ startMode: 'sequence' }),
      preferredRotationFor: (_p: string, sid: string) => {
        /** ⚠️ 先读**本会话**的可变表（刚写进去的）；父会话读测试参数。 */
        const own = prefRotation[sid]
        if (own !== undefined) return POOL_IDS[own.position - 1]
        return sid === 'parent-1' ? options.preferredRotation : undefined
      },
      subagentStartPositionOf: (_p: string, sid: string) => startPosition[sid],
      activeAccountOf: (_p: string, sid: string) =>
        (sid === 'parent-1' ? options.activeAccount : undefined),
      setActiveAccount: () => {},
      setPreferredRotation: async (_p: string, sid: string, position: number, tier: string) => {
        calls.push({ api: 'setPreferredRotation', args: [_p, sid, position, tier] })
        /** ⚠️ **真的回写**（否则本次请求读不到刚算出的起点）。 */
        prefRotation[sid] = { position }
      },
      setSubagentStartPosition: (_p: string, sid: string, position: number) => {
        calls.push({ api: 'setSubagentStartPosition', args: [_p, sid, position] })
        startPosition[sid] = position
      },
      subagentParentForSession: () => 'parent-1',
    }
    const resolver = createCredentialResolver(
      { pool, subagentParentForSession: () => 'parent-1' } as never,
      {
        product: { id: 'probe', displayName: 'Probe' },
        readCredential: async (ref: string) => ref,
        fallback: { kind: 'ref', refName: 'R_FALLBACK' },
        balance: {
          /**
           * ⚠️ `buddy` 才有 `isFreeModel`（免费模型判据）；
           * `loomy` 无档位、无免费概念。
           */
          kind: options.balanceKind ?? 'loomy',
          selector: options.withTier ? tieredSelector() : plainSelector(),
          isFreeModel: () => options.isFreeModel === true,
          lockedError: () => new Error('locked'),
        } as never,
      },
    )
    return { resolver, calls }
  }

  /**
   * ## 手算基准（`sequence` slot0，池 = acc-1 / acc-2）
   *
   * | 起点 | 公式 | 结果 |
   * |---|---|---|
   * | acc-1（位次1）| `(0+1+0)%2` | **acc-2** |
   * | acc-2（位次2）| `(1+1+0)%2` | **acc-1** |
   *
   * ⇒ 两条参照路径给出**不同**结果，故能区分。
   */

  it('★★★ 有「实际在用」时，**优先用它**（不是下拉框位次）', async () => {
    /**
     * ## 用户原话
     *
     * > 「主代理下拉是位次5时，用完了，实际排到位次6了……
     * >   我希望是B，……参考对象是主代理**实际在使用的帐号**」
     *
     * ## ⚠️ 断言的是**写入的位次**，不是最终返回的凭据
     *
     * 为什么：`setPreferredRotation` 会回写 `preferredRotation['child-1']`，
     * 而 `baseRotationStartId` 读的正是它 ⇒ 两条参照路径**最终返回相同凭据**
     * （回写值覆盖了参照差异）。第一版断言 `picked` 因此**变异无牙**（已实测）。
     *
     * ⇒ 只有「首次块**参照谁**」能区分：
     *
     * | 参照 | `sequence` slot0 算出 | 写入 position |
     * |---|---|---|
     * | **acc-2（实际在用）** | acc-1 | **1** |
     * | acc-1（下拉框）| acc-2 | 2 |
     */
    const { resolver, calls } = runFirstStart({
      activeAccount: 'acc-2',
      preferredRotation: 'acc-1',
      withTier: true,
    })
    await resolver('m', 'child-1')
    const write = calls.find((x) => x.api === 'setPreferredRotation')
    expect(write, '必须有一次 setPreferredRotation 写入').toBeDefined()
    expect(
      (write!.args as unknown[])[2],
      '★★★ 必须按「实际在用 acc-2」错开 ⇒ 写入位次 1（若按下拉框 acc-1 则写 2）',
    ).toBe(1)
  })

  it('★★★ 没有「实际在用」时，**回落**到下拉框位次', async () => {
    /** ⚠️ 插件刚重启 / 父会话没发过请求 ⇒ 必须回落，否则子代理失去参照。 */
    const { resolver } = runFirstStart({ preferredRotation: 'acc-2', withTier: true })
    expect(await resolver('m', 'child-1'), '★★★ 回落：按 acc-2 错开 ⇒ acc-1').toBe('R1')
  })

  it('★★★ **免费模型 ⇒ 跳过**（不写起点）', async () => {
    /**
     * ## 这条守的是 2026-11-26 实测发现的缺陷
     *
     * 重构把首次块提到 `plan.kind` 分支之前时，**丢掉了 `free !== true` 条件**
     * ⇒ 探针实测免费模型也写了起点（`position=3`）。
     *
     * ## 为什么必须跳过
     *
     * | 问题 | 说明 |
     * |---|---|
     * | 违反设计 | 免费模型不消耗积分，插起点改变不了任何行为 |
     * | 占用条目 | `PREFERRED_ROTATION_MAX_SESSIONS` 有上限，白占 |
     * | 副作用 | 免费→付费切换时，起点已被「免费期」定下，与用户预期不符 |
     */
    const { resolver, calls } = runFirstStart({
      activeAccount: 'acc-2',
      withTier: true,
      isFreeModel: true,
      /**
       * ⚠️ **必须用 `buddy` 形态**：`free` 只有该形态才有意义
       * （无档位 provider 没有「免费模型」概念，`firstFree` 恒 false）。
       */
      balanceKind: 'buddy',
    })
    await resolver('m', 'child-1')
    expect(calls, '★★★ 免费模型不得写任何起点').toEqual([])
  })

  it('★★★ 无档位 provider ⇒ 写 `setSubagentStartPosition`（不写 `setPreferredRotation`）', async () => {
    /** 纯 key 池没有档位 ⇒ `setPreferredRotation` 会拒绝 ⇒ 起点永远不稳定。 */
    const { resolver, calls } = runFirstStart({ activeAccount: 'acc-2', withTier: false })
    await resolver('m', 'child-1')
    const apis = calls.map((c) => c.api)
    expect(apis, '★★★ 无档位必须走独立通道').toContain('setSubagentStartPosition')
    expect(apis, '★★★ 不得走带档位的通道').not.toContain('setPreferredRotation')
  })
})
