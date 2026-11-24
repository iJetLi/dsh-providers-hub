/**
 * ★★★ **生产链路端到端：子代理起点 / pin / userPicked**（2026-11-24）。
 *
 * ## 为什么必须有这一条（上游审计 ⑥ 的核心批评）
 *
 * 上一版 **10 个 spec / 150 条全是纯函数或源码文本断言**，于是上游实测：
 *
 * | 变异 | 结果 |
 * |---|---|
 * | **删掉整个 pin 读取块** | **7 spec / 92 条全绿** |
 * | 删掉 resolver 里整段子代理逻辑 | **83 条仍全绿** |
 *
 * ⇒ 用例测的是「纯函数算得对」，**没测「这条纯函数真的被接线调用了」**。
 *
 * 本文件照 PR #148 的 `rotation-start-tier-e2e.spec.ts` 做法：
 * **真实 `createCredentialResolver` + 真实 `BuddyBalanceSelector`**，
 * 只替换账号池与 `fetchBalance`（余额原料）。
 *
 * ## 三条必须钉住的不变量
 *
 * | # | 场景 | 期望 |
 * |---|---|---|
 * | ① | 子代理有 `pinnedAccountId` | **用它**（不被 slot 现算覆盖）|
 * | ② | 子代理有 `userPickedAccountId` | **优先于 pin** |
 * | ③ | 子代理无 pin | 按 slot 现算（错开）|
 */
import { describe, expect, it } from 'vitest'

import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import { createCredentialResolver } from '../../src/credential-resolver.js'

const PROVIDER = 'probe'
const DAY = 86_400_000

/** 三个账号：位次 1/2/3（池序）。 */
const ENTRIES = [
  { id: 'acc-1', credentialRef: 'R1', enabled: true },
  { id: 'acc-2', credentialRef: 'R2', enabled: true },
  { id: 'acc-3', credentialRef: 'R3', enabled: true },
]

const PARENT_SESSION = 'session-parent'
const CHILD_SESSION = 'child-session'

/**
 * 造一个「真实 resolver + 真实 selector」的环境。
 *
 * @param options.pin - 子代理的 `pinnedAccountId`
 * @param options.userPicked - 子代理的 `userPickedAccountId`
 * @param options.startMode - 子代理策略
 */
function makeEnv(options: {
  pin?: string
  userPicked?: string
  startMode?: 'follow' | 'sequence' | 'reverse' | 'hash' | 'fixed'
}) {
  const now = Date.now()

  /**
   * 余额原料：让**所有账号都处在同一档位（临期）**。
   *
   * ⚠️ 这样「档位」不是变量，唯一决定起点的是 pin / userPicked / slot。
   */
  const balances: Record<string, unknown> = {
    R1: { packages: [{ name: 'a', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
    R2: { packages: [{ name: 'b', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
    R3: { packages: [{ name: 'c', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
  }
  const refOf: Record<string, string> = { 'acc-1': 'R1', 'acc-2': 'R2', 'acc-3': 'R3' }

  const selector = new BuddyBalanceSelector({
    product: { id: PROVIDER, displayName: 'Probe' },
    resolveCredential: async () => ({}) as never,
    fetchBalance: async (_cred, _p, ctx?: { accountId?: string }) =>
      (balances[refOf[ctx?.accountId ?? ''] ?? ''] ?? null) as never,
    now: () => now,
    ttlMs: 0,
  } as never)

  const assignment =
    options.pin === undefined && options.userPicked === undefined
      ? undefined
      : {
        sessionId: CHILD_SESSION,
        parentSessionId: PARENT_SESSION,
        at: now,
        slot: 0,
        ...(options.pin === undefined ? {} : { pinnedAccountId: options.pin }),
        ...(options.userPicked === undefined ? {} : { userPickedAccountId: options.userPicked }),
      }

  /**
   * 按 sessionId 区分：**只有子代理**才有分配记录（主代理查不到）。
   *
   * 上一版替身无条件返回 `assignment` ⇒ 主代理会话也拿到子代理的 pin
   * ⇒ 端到端用例立刻抓出「主代理用了子代理的号」（纯回归）。
   *
   * 真实实现里分配表只登记子代理 ⇒ 替身必须复现这一点。
   */
  const assignmentOf = (sessionId) => (sessionId === CHILD_SESSION ? assignment : undefined)

  const pool = {
    listAccountsByProvider: () => ENTRIES,
    permanentLocked: () => false,
    strictManualOrder: () => false,
    getAvailableAccount: async () => null,
    /** 主代理（父会话）的起点：acc-1。 */
    preferredRotationFor: () => 'acc-1',
    /** 子代理设置。 */
    subagentRotationFor: () =>
      options.startMode === undefined ? undefined : { startMode: options.startMode },
    /** 子代理分配记录（**这是本文件的被测对象**，按 sessionId 区分）。 */
    subagentAssignmentOf: (_p, sid) => assignmentOf(sid),
    /** 无此调用（避免误发请求）。 */
    recordSubagentStart: async () => 0,
    pinSubagentAccount: async () => false,
  }

  const resolver = createCredentialResolver<string>(
    { pool: pool as never },
    {
      product: { id: PROVIDER, displayName: 'Probe' },
      readCredential: async (ref: string) => ref,
      fallback: { kind: 'ref', refName: 'R_FALLBACK' },
      balance: {
        kind: 'buddy',
        selector: selector as never,
        lockedError: () => new Error('locked'),
        isFreeModel: async () => false,
        reportPickedAccount: true,
      },
    } as never,
  )

  return resolver
}

describe('端到端：pin / userPicked 必须真的决定起点', () => {
  it('★★★ pin=a3 ⇒ 实际用 a3（不被 slot 现算覆盖）', async () => {
    /**
     * ⚠️ 这条正是上游实测失败的那一格：「`pin=a3` 实际用 a2」。
     *
     * `startMode: 'sequence'` + `slot=0` 单靠策略会落到 a2
     *（主代理起点 a1 往后一位）—— 若 pin 被覆盖，就会返回 R2。
     */
    const env = makeEnv({ pin: 'acc-3', startMode: 'sequence' })
    expect(await env('m', CHILD_SESSION)).toBe('R3')
  })

  it('★★★ userPicked 优先于 pin', async () => {
    const env = makeEnv({ pin: 'acc-3', userPicked: 'acc-2', startMode: 'sequence' })
    expect(await env('m', CHILD_SESSION)).toBe('R2')
  })

  it('★★ 无 pin ⇒ 未登记 ⇒ 策略不生效（首轮用主代理起点 a1）', async () => {
    /**
     * ⚠️ **这是真实语义，不是缺陷**（我第一版断言「应错开到 R2」，错了）。
     *
     * 分配表只登记子代理，且登记发生在 resolveCredential 里
     * （首次请求时 fire-and-forget 写入）⇒ **子代理的第一发请求**
     * 分配记录还不存在 ⇒ assignment === undefined ⇒ 策略不生效
     * ⇒ 用主代理起点（a1）。从第二发起才有 pin ⇒ 才错开。
     *
     * ⚠️ 这个「首轮用主代理号」的代价是**已知且已登记**的
     * （见 credential-resolver.ts 里「首次请求因此会用主代理起点（一次）」）。
     */
    const env = makeEnv({ startMode: 'sequence' })
    expect(await env('m', CHILD_SESSION)).toBe('R1')
  })

  it('★★★ pin 的号不可用（不在候选）⇒ 回落到策略现算', async () => {
    /**
     * 「只有该号不可用才换」的语义 —— 用一个**不在账号池里**的 id
     * 模拟「该号已被删除/停用」。
     */
    const env = makeEnv({ pin: 'acc-gone', startMode: 'sequence' })
    expect(await env('m', CHILD_SESSION)).toBe('R2')
  })

  it('★★★ 主代理会话（无分配记录）⇒ 用它自己的起点 a1，不受子代理逻辑影响', async () => {
    /**
     * ⚠️ **纯回归面**：主代理必须与加本功能之前逐字节相同。
     */
    const env = makeEnv({ pin: 'acc-3', startMode: 'sequence' })
    expect(await env('m', PARENT_SESSION)).toBe('R1')
  })
})

/**
 * ★★★ **同档位内错开**必须真的生效（上游审计 ④ 的另一半）。
 *
 * ## 缺陷
 *
 * `sameTierAsMainStart()` 依赖 `selector.cachedTierOf()`，而那个方法**上一版全仓零实现**
 * ⇒ 恒走降级 ⇒ 退化为「全量账号」⇒ 子代理可以**先烧永久积分**
 *（直接违背用户要求的「档次优先不变」）。
 *
 * ## 本组用例怎么钉住它（⚠️ 关键设计）
 *
 * 三个账号：
 *
 * | 账号 | 档位 | 用途 |
 * |---|---|---|
 * | `acc-imm1` | 临期（主代理起点）| 档内错开的**基准** |
 * | `acc-imm2` | 临期 | 档内错开应该落到这里 |
 * | `acc-perm` | 只剩永久 | **不应该被落到** |
 *
 * ⚠️ 必须让临期档有 **2 个**账号 —— 我第一版只放了 1 个，
 * 于是 `reverse` 绕回自己，**分不出「档内错开」与「退化到全量」**
 *（实测那条用例对「resolver 不传 selector」的变异**无牙**）。
 */
describe('端到端：同档位内错开（cachedTierOf 必须真的被调用）', () => {
  const DAY2 = 86_400_000

  function makeTierEnv() {
    const now = Date.now()
    const entries = [
      { id: 'acc-imm1', credentialRef: 'RI1', enabled: true },
      { id: 'acc-imm2', credentialRef: 'RI2', enabled: true },
      { id: 'acc-perm', credentialRef: 'RP', enabled: true },
    ]
    const balances = {
      RI1: { packages: [{ name: 'i1', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY2 }] },
      RI2: { packages: [{ name: 'i2', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY2 }] },
      RP: { packages: [{ name: 'p', unit: 'credits', remaining: 500, total: 500, used: 0, active: true }] },
    }
    const refOf = { 'acc-imm1': 'RI1', 'acc-imm2': 'RI2', 'acc-perm': 'RP' }

    const selector = new BuddyBalanceSelector({
      product: { id: PROVIDER, displayName: 'Probe' },
      resolveCredential: async () => ({}),
      fetchBalance: async (_c, _p, ctx) => balances[refOf[ctx?.accountId] ?? ''] ?? null,
      now: () => now,
      ttlMs: 0,
    })

    /** ⚠️ 先预热缓存（`cachedTierOf` 只读缓存，不查网络）。 */
    const warm = async () => {
      await selector.select(
        entries.map((e) => ({ id: e.id, expiringBalance: 0, imminentBalance: 0, permanentBalance: 0 })),
        { allowPermanent: true },
      )
    }

    const assignment = {
      sessionId: CHILD_SESSION, parentSessionId: PARENT_SESSION, at: now, slot: 0,
    }
    const pool = {
      listAccountsByProvider: () => entries,
      permanentLocked: () => false,
      strictManualOrder: () => false,
      getAvailableAccount: async () => null,
      /** 主代理起点 = acc-imm1（临期档第一位）。 */
      preferredRotationFor: () => 'acc-imm1',
      subagentRotationFor: () => ({ startMode: 'reverse' }),
      subagentAssignmentOf: (_p, sid) => (sid === CHILD_SESSION ? assignment : undefined),
      recordSubagentStart: async () => 0,
      pinSubagentAccount: async () => false,
    }
    const resolver = createCredentialResolver(
      { pool },
      {
        product: { id: PROVIDER, displayName: 'Probe' },
        readCredential: async (ref) => ref,
        fallback: { kind: 'ref', refName: 'R_FALLBACK' },
        balance: {
          kind: 'buddy', selector,
          lockedError: () => new Error('locked'),
          isFreeModel: async () => false,
          reportPickedAccount: true,
        },
      },
    )
    return { resolver, warm, selector }
  }

  it('★★★ selector.cachedTierOf 必须能读出各账号档位（不再是零实现）', async () => {
    const { warm, selector } = makeTierEnv()
    await warm()
    expect(selector.cachedTierOf({ id: 'acc-imm1' }, true), '临期号必须是 0 档').toBe(0)
    expect(selector.cachedTierOf({ id: 'acc-imm2' }, true), '临期号必须是 0 档').toBe(0)
    expect(selector.cachedTierOf({ id: 'acc-perm' }, true), '只剩永久的号必须是 2 档').toBe(2)
  })

  it('★★★ cachedTierOf 必须尊重 allowPermanent（锁定永久时「只剩永久」= 不可用）', async () => {
    /**
     * ⚠️ **这是让「忽略 allowPermanent」变异变红的唯一一格**。
     *
     * buddyBalanceTier(entry, { allowPermanent }) 的行为：
     *
     * | 账号 | allowPermanent: true | allowPermanent: false（锁定）|
     * |---|---|---|
     * | 只剩永久 500 | **2**（永久档，可用）| **3**（不可用）|
     *
     * ⇒ 传错 allowPermanent 时，锁定状态下会把「只剩永久」的号
     * 误判成「可用」，子代理就可能**破坏用户的锁定设置**。
     */
    const { warm, selector } = makeTierEnv()
    await warm()

    /** 未锁定 ⇒ 永久档（2）。 */
    expect(
      selector.cachedTierOf({ id: 'acc-perm' }, true),
      '未锁定时「只剩永久」是永久档（2）',
    ).toBe(2)

    /** 锁定 ⇒ 不可用（3）。 */
    expect(
      selector.cachedTierOf({ id: 'acc-perm' }, false),
      '★★★ 锁定时「只剩永久」必须判为不可用（3）—— 否则会破坏用户的锁定设置',
    ).toBe(3)

    /** 临期号不受锁定影响（两种都该是 0）。 */
    expect(selector.cachedTierOf({ id: 'acc-imm1' }, false), '临期号锁定下仍是 0 档').toBe(0)
  })

  it('★★★ reverse 在**临期档内**往前错开 ⇒ acc-imm2，绝不跨到永久号', async () => {
    /**
     * 临期档 = [acc-imm1, acc-imm2]，主起点 acc-imm1（index 0）
     * ⇒ reverse slot=0 = index -1 ⇒ 绕回 ⇒ **acc-imm2**。
     *
     * ⚠️ 若 `cachedTierOf` 失效（退化为全量 [imm1, imm2, perm]），
     * reverse 会落到 **acc-perm**（RP）—— 那正是本用例要抓的。
     */
    const { resolver, warm } = makeTierEnv()
    await warm()
    expect(await resolver('m', CHILD_SESSION), '★★★ 必须档内错开，不能跨到永久号').toBe('RI2')
  })
})

/**
 * ★★★ **档位快照必须与起点账号配套**（2026-11-24，上游审计 P0 补充项）。
 *
 * ## 缺陷（上游原话）
 *
 * > 起点被本 PR 改写之后，**档位快照仍按主会话 id 读**
 * > ⇒ 主代理会出现「**账号 B + A 的档位**」。
 *
 * ⚠️ S6 的全部逻辑建立在「起点账号 + 它的档位」必须配套 ——
 * 配错会让「起点烧完临期自动换人」在**错误的账号上**判断，
 * 症状是「换人时机不对」，很难回溯。
 *
 * ## 本组用例怎么钉住它
 *
 * 给 resolver 一个**会返回 non-undefined 的** `rotationStartTierFor`（模拟旧数据），
 * 然后对比：
 *
 * | 场景 | 期望 |
 * |---|---|
 * | 主代理 | **传了** tier（走 S6 语义）|
 * | 子代理 | **不传** tier（走 S5：起点绝对第一）|
 *
 * ⚠️ 判据是**行为级**：让 `tierAtSelection` 与实际档位**故意不一致**，
 * 看它是否影响选号结果 —— 若子代理传了 tier，S6 会「交出首位」；
 * 不传则 S5「起点绝对第一」。两种结果不同 ⇒ 可分辨。
 */
describe('端到端：档位快照不能与子代理起点账号错配', () => {
  function makeSnapshotEnv(options: { isChild: boolean }) {
    const now = Date.now()
    const entries = [
      { id: 'acc-a', credentialRef: 'RA', enabled: true },
      { id: 'acc-b', credentialRef: 'RB', enabled: true },
    ]
    /**
     * acc-a 有临期、acc-b 只剩永久。
     *
     * ⚠️ **关键设计**：`preferredRotationFor` 对**两个会话**都返回 `acc-a`
     *（模拟「主代理起点 = acc-a」），而子代理的 **pin = acc-b**。
     *
     * 于是：
     * - `baseRotationStartId = acc-a`（进函数时算出的）
     * - 子代理 pin 把它改写成 `acc-b`
     * - 若档位快照**传了**（错配）⇒ S6 拿 `imminent` 快照配 `acc-b`（永久档）
     *   ⇒ 判「已降档」⇒ **交出首位** ⇒ 选 acc-a（RA）
     * - 若**不传**（正确）⇒ S5 ⇒ **pin 的号绝对第一** ⇒ 选 acc-b（RB）
     */
    const balances = {
      RA: { packages: [{ name: 'a', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
      RB: { packages: [{ name: 'b', unit: 'credits', remaining: 500, total: 500, used: 0, active: true }] },
    }
    const refOf = { 'acc-a': 'RA', 'acc-b': 'RB' }

    const selector = new BuddyBalanceSelector({
      product: { id: PROVIDER, displayName: 'Probe' },
      resolveCredential: async () => ({}),
      fetchBalance: async (_c, _p, ctx) => balances[refOf[ctx?.accountId] ?? ''] ?? null,
      now: () => now,
      ttlMs: 0,
    })

    const assignment = {
      sessionId: CHILD_SESSION, parentSessionId: PARENT_SESSION, at: now, slot: 0,
      pinnedAccountId: 'acc-b',
    }
    const pool = {
      listAccountsByProvider: () => entries,
      permanentLocked: () => false,
      strictManualOrder: () => false,
      getAvailableAccount: async () => null,
      /** 两个会话都返回 acc-a ⇒ 主代理起点 = acc-a。 */
      preferredRotationFor: () => 'acc-a',
      /** ⚠️ 故意给一个**与实际档位不符**的快照（模拟旧数据 / 上游指出的错配）。 */
      rotationStartTierFor: () => 'imminent',
      subagentRotationFor: () => ({ startMode: 'sequence' }),
      subagentAssignmentOf: (_p, sid) => (options.isChild && sid === CHILD_SESSION ? assignment : undefined),
      recordSubagentStart: async () => 0,
      pinSubagentAccount: async () => false,
    }
    return createCredentialResolver(
      { pool },
      {
        product: { id: PROVIDER, displayName: 'Probe' },
        readCredential: async (ref) => ref,
        fallback: { kind: 'ref', refName: 'R_FALLBACK' },
        balance: {
          kind: 'buddy', selector,
          lockedError: () => new Error('locked'),
          isFreeModel: async () => false,
          reportPickedAccount: true,
        },
      },
    )
  }

  it('★★★ 主代理：档位快照生效 ⇒ 起点 acc-a「已降档」⇒ 交出首位（S6 既有语义）', async () => {
    /**
     * 主代理起点 = acc-a（临期档），而快照说 `imminent` ⇒ **档位仍持有** ⇒
     * 走 S6「起点绝对第一」⇒ 选 acc-a 自己（RA）。
     */
    const resolver = makeSnapshotEnv({ isChild: false })
    expect(await resolver('m', PARENT_SESSION), '主代理走 S6，起点第一').toBe('RA')
  })

  it('★★★ 子代理：**不传**档位快照 ⇒ 走 S5 ⇒ pin 的 acc-b 绝对第一', async () => {
    /**
     * ⚠️ 若子代理传了 `imminent` 快照（= 上游指出的错配）：
     * pin 的 acc-b 是**永久档**，快照说 immight ⇒ 判「已降档」⇒ 交出首位
     * ⇒ 选 acc-a（RA）—— **错**。
     *
     * 正确：不传快照 ⇒ S5 ⇒ pin 的号绝对第一 ⇒ acc-b（RB）。
     */
    const resolver = makeSnapshotEnv({ isChild: true })
    expect(await resolver('m', CHILD_SESSION), '★★★ 子代理必须走 S5（pin 的号第一）').toBe('RB')
  })
})

/**
 * ★★★ **子代理的错开基准必须是「主代理当前用的账号」**（上游审计 ④）。
 *
 * ## 缺陷（上游原话）
 *
 * > 基准读的是**子代理自己**的 `preferredRotation` —— **主代理起点从未被读**
 * >（主代理起点设 a3 与不配起点，结果**逐字节相同**）。
 *
 * ## 本组用例怎么钉住它
 *
 * `preferredRotationFor` 按 sessionId 返回**不同**的值：
 *
 * | 会话 | 返回值 |
 * |---|---|
 * | 子代理自己的 sessionId | `acc-1` |
 * | **主代理的 sessionId** | **`acc-3`** ← 只有读它才会错开到这里 |
 *
 * 策略 `sequence`（从基准往后一位）：
 *
 * | 基准来自 | 结果 |
 * |---|---|
 * | 子代理自己（acc-1）| acc-2 |
 * | **主代理（acc-3）** | **acc-3 往后一位 ⇒ 绕回 acc-1** |
 *
 * ⇒ 两种结果不同 ⇒ 可分辨。
 */
describe('端到端：子代理以**主代理起点**为错开基准', () => {
  function makeBaseEnv() {
    const now = Date.now()
    const entries = [
      { id: 'acc-1', credentialRef: 'R1', enabled: true },
      { id: 'acc-2', credentialRef: 'R2', enabled: true },
      { id: 'acc-3', credentialRef: 'R3', enabled: true },
    ]
    const balances = {
      R1: { packages: [{ name: 'a', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
      R2: { packages: [{ name: 'b', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
      R3: { packages: [{ name: 'c', unit: 'credits', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: now + DAY }] },
    }
    const refOf = { 'acc-1': 'R1', 'acc-2': 'R2', 'acc-3': 'R3' }

    const selector = new BuddyBalanceSelector({
      product: { id: PROVIDER, displayName: 'Probe' },
      resolveCredential: async () => ({}),
      fetchBalance: async (_c, _p, ctx) => balances[refOf[ctx?.accountId] ?? ''] ?? null,
      now: () => now,
      ttlMs: 0,
    })

    const assignment = {
      sessionId: CHILD_SESSION, parentSessionId: PARENT_SESSION, at: now, slot: 0,
    }
    const pool = {
      listAccountsByProvider: () => entries,
      permanentLocked: () => false,
      strictManualOrder: () => false,
      getAvailableAccount: async () => null,
      /**
       * ⚠️ **按 sessionId 返回不同值**：
       * - 子代理自己 → `acc-1`（若实现读它，结果会是 acc-2）
       * - **主代理 → `acc-3`**（正确实现应读它，结果绕回 acc-1）
       */
      preferredRotationFor: (_p, sid) => (sid === PARENT_SESSION ? 'acc-3' : 'acc-1'),
      subagentRotationFor: () => ({ startMode: 'sequence' }),
      subagentAssignmentOf: (_p, sid) => (sid === CHILD_SESSION ? assignment : undefined),
      recordSubagentStart: async () => 0,
      pinSubagentAccount: async () => false,
    }
    return createCredentialResolver(
      { pool },
      {
        product: { id: PROVIDER, displayName: 'Probe' },
        readCredential: async (ref) => ref,
        fallback: { kind: 'ref', refName: 'R_FALLBACK' },
        balance: {
          kind: 'buddy', selector,
          lockedError: () => new Error('locked'),
          isFreeModel: async () => false,
          reportPickedAccount: true,
        },
      },
    )
  }

  it('★★★ 基准取**主代理**起点 acc-3 ⇒ sequence 往后一位绕回 acc-1', async () => {
    /**
     * ⚠️ 若实现读的是**子代理自己**的 acc-1（上游指出的缺陷），
     * 结果会是 **acc-2** —— 与本断言不同 ⇒ 可分辨。
     */
    const resolver = makeBaseEnv()
    const got = await resolver('m', CHILD_SESSION)
    expect(got, '★★★ 必须从主代理起点 acc-3 往后错开（绕回 R1），不是从子代理自己的 acc-1 出发（R2）').toBe('R1')
  })
})
