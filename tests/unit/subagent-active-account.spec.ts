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
