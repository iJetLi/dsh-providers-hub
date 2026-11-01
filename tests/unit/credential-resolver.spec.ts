/**
 * `createCredentialResolver` 的**逐分支**单元测试（与对拍文件互补）。
 *
 * ## 两份文件的分工（别把它们当重复）
 *
 * | 文件 | 守什么 |
 * |---|---|
 * | `credential-resolver-parity.spec.ts` | **等价性**：与旧闭包逐字段对拍（返回值 / 回报序列 / 池调用序列） |
 * | 本文件 | **可达性与接线**：每个分支都被真的走到、且**接线层**（`index.ts`）把该传的都传了 |
 *
 * ⚠️ 两份都需要：对拍证明「新实现 = 旧实现」，但它**不覆盖**「接线层有没有把
 * 参数传对」（对拍用的是自己构造的 config）。本文件的 `apply()` 组补这一格 ——
 * 它守的是**真实注册项**里的 `reportAccount` / `product` / `readCredential`。
 *
 * ## ⚠️ 每条断言都要能说出「哪个变异会让它红」
 *
 * 本仓库的头号缺陷类是**同义反复**（约 11 处）。故每条用例的注释里都写了
 * 对应的变异；没有变异的断言不要留。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCredentialResolver, NO_FREE_MODEL, type ResolverPool } from '../../src/credential-resolver.js'
import { apply } from '../../src/index.js'
import {
  peekLedgerAccount,
  resetLedgerAccountsForTests,
} from '../../src/token-ledger.js'

const here = dirname(fileURLToPath(import.meta.url))
/**
 * `src/index.ts` 全文 —— 只给「账本名单自检」用。
 *
 * ⚠️ 那两条断言查的是**注册项是否存在**（接线事实），不是行为：行为由
 * 下面的 `it.each` 驱动真实 `apply()` 守。名单里被排除的两家正因**不可达**，
 * 才只能这样钉住它们「注册项还在、只是走不到」。
 */
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8')

/** 记录调用的池替身（判据与真实池一致：enabled + 模型限流 + 逐个解析）。 */
function poolOf(entries: Array<{
  id: string
  provider: string
  credentialRef: string
  enabled?: boolean
  modelRateLimits?: Record<string, number>
  /** 账号级封禁标记（issue IKS2MV）：与真实池一致 —— 整个账号出局。 */
  policyBlockedAtMs?: number
}>, raw: Record<string, string>, locked = false): ResolverPool & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    listAccountsByProvider: (provider: string) =>
      entries.filter(e => e.provider === provider).map(e => ({
        id: e.id, credentialRef: e.credentialRef, enabled: e.enabled !== false,
        ...e.modelRateLimits === undefined ? {} : { modelRateLimits: e.modelRateLimits },
        ...e.policyBlockedAtMs === undefined ? {} : { policyBlockedAtMs: e.policyBlockedAtMs },
      })),
    permanentLocked: () => locked,
    getAvailableAccount: async (provider, modelId, exclude) => {
      calls.push(`${provider}|${modelId}|${[...(exclude ?? [])].join(',')}`)
      for (const e of entries) {
        if (e.provider !== provider || e.enabled === false) continue
        // 账号级封禁：整号出局（与真实池同判据，issue IKS2MV）
        if (e.policyBlockedAtMs !== undefined) continue
        if (exclude?.has(e.id) === true) continue
        if (modelId.length > 0 && e.modelRateLimits !== undefined) {
          const resetAt = e.modelRateLimits[modelId]
          if (resetAt !== undefined && resetAt !== 0 && Date.now() < resetAt) continue
        }
        const value = raw[e.credentialRef]
        if (value === undefined) continue
        try {
          return { entry: { id: e.id, credentialRef: e.credentialRef }, credential: JSON.parse(value) }
        } catch { continue }
      }
      return null
    },
  }
}

const PRODUCT = { id: 'raccoon', displayName: 'Raccoon (商汤)' }

describe('createCredentialResolver · 骨架 A（纯池选号）', () => {
  it('★ 账号级封禁的账号**不得**进候选（`candidatesOf` 是主请求路径的第二份选号判据，issue IKS2MV）', async () => {
    // ⚠️ 对抗审计 E8 实测打穿过：`getAvailableAccount`（池）与 `candidatesOf`（本文件）
    //    是**两份**选号判据，只改池那一份的话带余额档的渠道（buddy 系就是这么走的）
    //    照样把封禁账号选出来 —— 每一发都先撞一次 403 再换号，并顺带写两次盘。
    const pool = poolOf([
      { id: 'blocked', provider: 'raccoon', credentialRef: 'R1', policyBlockedAtMs: 1_700_000_000_000 },
    ], { R1: '{"t":1}' })
    const resolve = createCredentialResolver(
      { pool },
      {
        product: PRODUCT,
        readCredential: async (ref) => ref === 'R1' ? { t: 1 } : undefined,
        fallback: { kind: 'ref', refName: 'FALLBACK' },
        // 走 buddy 余额档：只有这条路径读 `candidatesOf`（骨架 A 直接问池）。
        // `isFreeModel` 恒真 ⇒ 先试免费分支（它按候选逐个解析凭据）。
        balance: {
          kind: 'buddy',
          selector: { select: async () => ({ ok: false, reason: { kind: 'no-candidates' } }) } as never,
          lockedError: () => new Error('locked'),
          reportPickedAccount: false,
          isFreeModel: async () => true,
        },
      },
    )
    expect(await resolve('m')).toBeUndefined()
  })

  it('池命中 ⇒ 返回该凭据，且回报该账号 id', async () => {
    // 变异：把 `deps.reportAccount?.(available?.entry.id ?? undefined)` 删掉 ⇒ 红。
    const pool = poolOf([{ id: 'a1', provider: 'raccoon', credentialRef: 'R1' }], { R1: '{"t":1}' })
    const seen: Array<string | undefined> = []
    const resolve = createCredentialResolver(
      { pool, reportAccount: (id) => seen.push(id) },
      {
        product: PRODUCT,
        readCredential: async (ref) => ref === 'R1' ? { t: 1 } : undefined,
        fallback: { kind: 'ref', refName: 'FALLBACK' },
      },
    )
    expect(await resolve('m')).toEqual({ t: 1 })
    expect(seen).toEqual(['a1'])
  })

  it('⚠️ 池未命中 ⇒ **仍以 `undefined` 回报一次**（清空「当前账号」标记）', async () => {
    // 变异：改成 `if (available !== null) deps.reportAccount?.(…)` ⇒ 红。
    const pool = poolOf([], {})
    const seen: Array<string | undefined> = []
    const resolve = createCredentialResolver(
      { pool, reportAccount: (id) => seen.push(id) },
      {
        product: PRODUCT,
        readCredential: async () => undefined,
        fallback: { kind: 'ref', refName: 'FALLBACK' },
      },
    )
    expect(await resolve('m')).toBeUndefined()
    expect(seen).toEqual([undefined])
  })

  it('池未命中 ⇒ 退固定 ref，且 `readCredential` 收到的是那个 ref', async () => {
    const pool = poolOf([], {})
    const refs: string[] = []
    const resolve = createCredentialResolver(
      { pool },
      {
        product: PRODUCT,
        readCredential: async (ref) => { refs.push(ref); return { from: ref } },
        fallback: { kind: 'ref', refName: 'MY_FALLBACK' },
      },
    )
    expect(await resolve('m')).toEqual({ from: 'MY_FALLBACK' })
    expect(refs).toEqual(['MY_FALLBACK'])
  })

  it('⚠️ 池未命中 + 限流判定抛错 ⇒ 抛出去（不静默退兜底）', async () => {
    // 变异：把 `config.throwIfAllRateLimited?.(…)` 删掉 ⇒ 红（会返回兜底值）。
    const pool = poolOf([], {})
    const boom = new Error('全部限流')
    const resolve = createCredentialResolver(
      { pool },
      {
        product: PRODUCT,
        readCredential: async () => ({ from: 'fallback' }),
        fallback: { kind: 'ref', refName: 'FALLBACK' },
        throwIfAllRateLimited: () => { throw boom },
      },
    )
    await expect(resolve('m')).rejects.toBe(boom)
  })

  it('⚠️ 池**命中**时不得触发限流判定（否则会把正常取号报成限流）', async () => {
    // ⚠️ 池命中时返回的是**池内那份凭据**（`getAvailableAccount` 的
    // `credential`），不是 `readCredential` 的结果 —— 这是骨架 A 的既有语义。
    const pool = poolOf([{ id: 'a1', provider: 'raccoon', credentialRef: 'R1' }], { R1: '{"pool":1}' })
    let called = 0
    const resolve = createCredentialResolver(
      { pool },
      {
        product: PRODUCT,
        readCredential: async () => ({ viaRead: true }),
        fallback: { kind: 'ref', refName: 'FALLBACK' },
        throwIfAllRateLimited: () => { called++; throw new Error('不该抛') },
      },
    )
    await expect(resolve('m')).resolves.toEqual({ pool: 1 })
    expect(called, '池命中时不该判限流').toBe(0)
  })

  it('⚠️ `modelId` 透传（空串会让池的模型级限流过滤整体短路）', async () => {
    // 变异：把 `modelId ?? ''` 改成 `''` ⇒ 红。
    const pool = poolOf([], {})
    const resolve = createCredentialResolver(
      { pool },
      { product: PRODUCT, readCredential: async () => undefined, fallback: { kind: 'ref', refName: 'F' } },
    )
    await resolve('deepseek-v4.1-flash')
    expect(pool.calls).toEqual(['raccoon|deepseek-v4.1-flash|'])
  })

  it('⚠️ 不传 `modelId` 时传空串（不是 `undefined` —— 池的签名要求 string）', async () => {
    const pool = poolOf([], {})
    const resolve = createCredentialResolver(
      { pool },
      { product: PRODUCT, readCredential: async () => undefined, fallback: { kind: 'ref', refName: 'F' } },
    )
    await resolve()
    expect(pool.calls).toEqual(['raccoon||'])
  })

  it('自定义兜底（zcode 形态）：池未命中时调它，且**不**走固定 ref', async () => {
    // 变异：把 `fallback.kind === 'ref'` 的分支写成恒真 ⇒ 红（会去读 refName）。
    const pool = poolOf([], {})
    const readRefs: string[] = []
    let custom = 0
    const resolve = createCredentialResolver(
      { pool },
      {
        product: PRODUCT,
        readCredential: async (ref) => { readRefs.push(ref); return { from: ref } },
        fallback: { kind: 'custom', resolve: async () => { custom++; return { from: 'custom' } } },
      },
    )
    expect(await resolve('m')).toEqual({ from: 'custom' })
    expect(custom).toBe(1)
    expect(readRefs, '自定义兜底时不得再读任何 ref').toEqual([])
  })
})

describe('createCredentialResolver · 骨架 C（buddy 协议分档）', () => {
  /**
   * 余额分档的假选择器 —— 形状必须与**真实** `BuddySelectionResult` 一致
   *（`{ ok: true, account, balance }` / `{ ok: false, reason }`），因为
   * `pickBuddyAccount` 判的是 `picked.ok`。
   *
   * ⚠️ 写成 `{ kind: 'exhausted' }` 会让 `pickBuddyAccount` 认为「没选中」，
   * 于是 `tried` 恒空 —— 那会**静默**把好几条用例变成同义反复
   *（写本文件时实测到：`exhausted` 那条断言 `exclude` 恒为 `''`）。
   */
  function fakeSelector(options: {
    /** 选中哪个候选（`undefined` = 一律报 exhausted）。 */
    pick?: { id: string; credentialRef: string }
    reason?: { kind: string; errors?: string[] }
    /** 记录每次 `select` 的入参。 */
    calls?: Array<{ ids: string[]; allowPermanent: boolean | undefined }>
  }) {
    return {
      select: async (
        candidates: readonly { id: string; credentialRef: string }[],
        tierOptions?: { allowPermanent?: boolean },
      ) => {
        options.calls?.push({
          ids: candidates.map(c => c.id),
          allowPermanent: tierOptions?.allowPermanent,
        })
        const target = options.pick === undefined
          ? undefined
          : candidates.find(c => c.id === options.pick!.id) ?? options.pick
        if (target === undefined) {
          return { ok: false as const, reason: options.reason ?? { kind: 'exhausted' } }
        }
        return {
          ok: true as const,
          account: target,
          balance: { id: target.id, ok: true },
        }
      },
    }
  }

  const LOCKED_ERROR = (reason: { kind: string }) =>
    new Error(reason.kind === 'unknown' ? '无法确认' : '额度已用尽')

  function make(overrides: {
    pool: ResolverPool
    selector: unknown
    readCredential: (ref: string) => Promise<unknown>
    isFreeModel?: (modelId?: string) => Promise<boolean> | boolean
    reportPickedAccount?: boolean
    reports?: Array<string | undefined>
    /** 限流判定（真实实现见 `src/index.ts` 的 `throwIfAllAccountsRateLimited`）。 */
    throwIfAllRateLimited?: (product: { id: string; displayName: string }, modelId?: string) => void
  }) {
    return createCredentialResolver(
      {
        pool: overrides.pool,
        ...overrides.reports === undefined ? {} : { reportAccount: (id) => overrides.reports!.push(id) },
      },
      {
        product: { id: 'buddy', displayName: 'CodeBuddy' },
        readCredential: overrides.readCredential as never,
        balance: {
          kind: 'buddy',
          selector: overrides.selector as never,
          lockedError: LOCKED_ERROR as never,
          // ⚠️ `isFreeModel` 是**必填**字段（原为可选，见 `NO_FREE_MODEL` 的事故
          //    说明）：本 helper 的默认值即「本家没有免费模型」，要测免费短路再显式传。
          isFreeModel: overrides.isFreeModel ?? NO_FREE_MODEL,
          ...overrides.reportPickedAccount === undefined
            ? {}
            : { reportPickedAccount: overrides.reportPickedAccount },
        },
        fallback: { kind: 'ref', refName: 'FALLBACK' },
        ...overrides.throwIfAllRateLimited === undefined
          ? {}
          : { throwIfAllRateLimited: overrides.throwIfAllRateLimited },
      },
    )
  }

  const ENTRIES = [{ id: 'a1', provider: 'buddy', credentialRef: 'R1' }]
  /** 一个能选中 a1 的假选择器。 */
  const PICK_A1 = { id: 'a1', credentialRef: 'R1' }

  it('⚠️ `isFreeModel` 为真 ⇒ **短路**：不调选择器、不查余额，直接按候选顺序取凭据', async () => {
    // 变异：把 `if (free) { … }` 整段删掉 ⇒ 红（会去调 selector）。
    const calls: Array<{ ids: string[]; allowPermanent: boolean | undefined }> = []
    const reports: Array<string | undefined> = []
    const resolve = make({
      pool: poolOf(ENTRIES, { R1: '{}' }),
      selector: fakeSelector({ pick: PICK_A1, calls }),
      readCredential: async (ref) => ref === 'R1' ? { free: true } : undefined,
      isFreeModel: () => true,
      reports,
    })
    expect(await resolve('m')).toEqual({ free: true })
    expect(calls, '免费模型不得做余额分档').toEqual([])
    expect(reports).toEqual(['a1'])
  })

  it('⚠️ 免费路径凭据全坏 ⇒ **落回常规路径**（复用既有的错误语义）', async () => {
    // 变异：把 `if (free)` 块里的 `return credential` 改成无条件返回 ⇒ 红。
    const calls: Array<{ ids: string[]; allowPermanent: boolean | undefined }> = []
    const resolve = make({
      pool: poolOf(ENTRIES, {}),
      selector: fakeSelector({ pick: PICK_A1, calls }),
      // 免费分支读不到 ⇒ 落到分档；分档也读不到 ⇒ 池兜底也读不到 ⇒ undefined。
      readCredential: async () => undefined,
      isFreeModel: () => true,
    })
    expect(await resolve('m')).toBeUndefined()
    expect(calls, '免费路径全坏时必须落到分档').toHaveLength(1)
  })

  it('⚠️ 免费路径候选为空 ⇒ 直接落常规路径（不抛错）', async () => {
    const resolve = make({
      pool: poolOf([], {}),
      selector: fakeSelector({ pick: PICK_A1 }),
      // 只有固定 ref 有凭据 ⇒ 结果证明它确实退到了那里。
      readCredential: async (ref) => ref === 'FALLBACK' ? { from: 'fallback' } : undefined,
      isFreeModel: () => true,
    })
    expect(await resolve('m')).toEqual({ from: 'fallback' })
  })

  it('⚠️ `reportPickedAccount: false` ⇒ 分档选中时不回报（buddy / workbuddy 的既有不对称）', async () => {
    // 变异：把 `plan.reportPickedAccount !== false` 改成恒真 ⇒ 红。
    const reports: Array<string | undefined> = []
    const resolve = make({
      pool: poolOf(ENTRIES, { R1: '{}' }),
      selector: fakeSelector({ pick: PICK_A1 }),
      readCredential: async (ref) => ref === 'R1' ? { c: 1 } : undefined,
      reportPickedAccount: false,
      reports,
    })
    expect(await resolve('m')).toEqual({ c: 1 })
    expect(reports).toEqual([])
  })

  it('`reportPickedAccount` 缺省为真 ⇒ 分档选中时回报（lobsterai / trae 的形态）', async () => {
    const reports: Array<string | undefined> = []
    const resolve = make({
      pool: poolOf(ENTRIES, { R1: '{}' }),
      selector: fakeSelector({ pick: PICK_A1 }),
      readCredential: async (ref) => ref === 'R1' ? { c: 1 } : undefined,
      reports,
    })
    expect(await resolve('m')).toEqual({ c: 1 })
    expect(reports).toEqual(['a1'])
  })

  it('⚠️ 分档选中的账号凭据坏 ⇒ `tried` 被并进池兜底的排除集（否则原地打转）', async () => {
    // 变异：删掉 `for (const accountId of picked.tried) tried.add(accountId)` ⇒ 红。
    const pool = poolOf(ENTRIES, { R1: '{}' })
    const resolve = make({
      pool,
      selector: fakeSelector({ pick: PICK_A1 }),
      // 分档选中的 a1 凭据坏 ⇒ `pickBuddyAccount` 把它记进 `tried` 并耗尽候选；
      // 但池兜底读的是**同一个** ref ⇒ 这里也让它坏，才测得到 exclude。
      readCredential: async () => undefined,
    })
    await resolve('m')
    expect(pool.calls[0], '兜底必须排除分档试过的账号').toBe('buddy|m|a1')
  })

  it('⚠️ 分档 `locked` ⇒ **抛错且绝不问池**（回落会绕过锁定）', async () => {
    // 变异：把 `throw plan.lockedError(…)` 改成 `return undefined` ⇒ 红（池会被调用）。
    const pool = poolOf(ENTRIES, { R1: '{}' }, true)
    const resolve = make({
      pool,
      selector: fakeSelector({ reason: { kind: 'exhausted' } }),
      readCredential: async () => ({ c: 1 }),
    })
    await expect(resolve('m')).rejects.toThrow('额度已用尽')
    expect(pool.calls, '锁定时不得问池').toEqual([])
  })

  it('⚠️ 分档 `locked` 且 reason 为 `unknown` ⇒ 报「无法确认」而不是「已用尽」', async () => {
    // 变异：把 `plan.lockedError(picked.reason ?? …)` 改成恒传 `{kind:'exhausted'}` ⇒ 红。
    const resolve = make({
      pool: poolOf(ENTRIES, { R1: '{}' }, true),
      selector: fakeSelector({ reason: { kind: 'unknown', errors: ['抖动'] } }),
      readCredential: async () => ({ c: 1 }),
    })
    await expect(resolve('m')).rejects.toThrow('无法确认')
  })

  /**
   * ★ 真实报障 2026-10-13（CodeBuddy：`明明有积分却显示不可用`）。
   *
   * 全部启用账号被**目标模型**限流 ⇒ `candidatesOf` 把它们全滤掉 ⇒ 候选空集
   * ⇒ 余额分档一次都没跑 ⇒ `pickBuddyAccount` 返回 `locked`（reason 缺席）。
   * 修复前这里直接 `throw plan.lockedError({kind:'exhausted'})`，把**限流**
   * 谎报成「积分都已用尽」，用户据此去解锁永久积分 —— 方向完全错，
   * 而解禁时刻就在池里。
   *
   * ⚠️ 判据是「**候选为空**才先问限流」，故本条必须让池里真的有一个被限流的
   * 账号（`poolOf` 的 `modelRateLimits` 让 `candidatesOf` 筛空它）。
   *
   * 变异：把 `if (candidates.length === 0) config.throwIfAllRateLimited?.(…)`
   * 删掉 ⇒ 红（会抛 `额度已用尽` 而不是限流错）。
   */
  it('★ 锁定 + 候选被模型限流筛空 ⇒ 报**限流**（带解禁时刻），不谎报「积分已用尽」', async () => {
    const resetAt = Date.now() + 3_600_000
    const resolve = make({
      pool: poolOf([
        { id: 'a1', provider: 'buddy', credentialRef: 'R1', modelRateLimits: { m: resetAt } },
      ], { R1: '{}' }, true),
      // 候选空集 ⇒ 假选择器**永远不会被调用**（这正是本缺陷的形态）。
      selector: fakeSelector({ pick: PICK_A1 }),
      readCredential: async () => ({ c: 1 }),
      throwIfAllRateLimited: (_product, modelId) => {
        if (modelId !== 'm') return
        throw new Error('模型 m 的可用账号均在限流中')
      },
    })
    await expect(resolve('m')).rejects.toThrow('均在限流中')
  })

  /**
   * ⚠️ **阳性对照**：候选非空时不得触发限流判定。
   *
   * 候选非空 ⇒ 至少一个启用账号未被限流 ⇒ 此时报「限流」本身就是错的。
   * 且余额分档**真的跑过**，那句「积分已用尽」有事实依据。
   *
   * 变异：把 `if (candidates.length === 0)` 的守卫去掉（无条件调）⇒ 红。
   */
  it('⚠️ 锁定 + 候选非空（凭据全坏）⇒ **不**触发限流判定，仍报原锁定文案', async () => {
    let called = 0
    const resolve = make({
      pool: poolOf(ENTRIES, { R1: '{}' }, true),
      // 候选非空，但凭据读不出来 ⇒ `pickBuddyAccount` 耗尽候选后返回 locked。
      selector: fakeSelector({ pick: PICK_A1 }),
      readCredential: async () => undefined,
      throwIfAllRateLimited: () => { called++; throw new Error('不该判限流') },
    })
    await expect(resolve('m')).rejects.toThrow('额度已用尽')
    expect(called, '候选非空时不该判限流').toBe(0)
  })

  /**
   * ⚠️ 候选被限流筛空，但**限流判定静默返回**（未接线 / 不是全限流）⇒ 仍须
   * 抛出**不谎报**的文案。
   *
   * 走到这里的 `no-candidates` 已排除「全被模型限流」（上一条），剩下的是
   * 「该 provider 下没有启用中的账号」等情形 —— 文案不得说「积分都已用尽」。
   *
   * 变异：把 `buddyLockedError` 的 `no-candidates` 分支删掉（落回 exhausted 文案）⇒ 红。
   */
  it('⚠️ 锁定 + 候选空集 + 限流判定静默 ⇒ 报「没有任何候选账号」而不是「积分已用尽」', async () => {
    const resolve = createCredentialResolver(
      { pool: poolOf([], {}, true) },
      {
        product: { id: 'buddy', displayName: 'CodeBuddy' },
        readCredential: async () => ({ c: 1 }),
        balance: {
          kind: 'buddy',
          selector: fakeSelector({ pick: PICK_A1 }) as never,
          isFreeModel: NO_FREE_MODEL,
          // 与 `src/index.ts` 的 `buddyLockedError` 同口径（只取关键判据）。
          lockedError: (reason) => new Error(
            reason.kind === 'no-candidates' ? '没有任何候选账号' : '额度已用尽',
          ) as never,
        },
        fallback: { kind: 'ref', refName: 'FALLBACK' },
        throwIfAllRateLimited: () => { /* 静默：不是全限流 */ },
      },
    )
    await expect(resolve('m')).rejects.toThrow('没有任何候选账号')
  })

  it('⚠️ 未锁定 + 分档没选出 ⇒ 退兜底（不抛错）', async () => {
    const resolve = make({
      pool: poolOf([], {}),
      selector: fakeSelector({ reason: { kind: 'exhausted' } }),
      readCredential: async (ref) => ref === 'FALLBACK' ? { from: 'fallback' } : undefined,
    })
    expect(await resolve('m')).toEqual({ from: 'fallback' })
  })

  it('⚠️ 候选筛：停用账号不进候选，别的模型限流也不进候选', async () => {
    // 变异：去掉 `filter(a => a.enabled)` 或去掉 `modelRateLimits` 判据 ⇒ 红。
    const calls: Array<{ ids: string[]; allowPermanent: boolean | undefined }> = []
    const resolve = make({
      pool: poolOf([
        { id: 'on', provider: 'buddy', credentialRef: 'R1' },
        { id: 'off', provider: 'buddy', credentialRef: 'R2', enabled: false },
        { id: 'other', provider: 'buddy', credentialRef: 'R3', modelRateLimits: { '别的模型': Date.now() + 3_600_000 } },
        { id: 'limited', provider: 'buddy', credentialRef: 'R4', modelRateLimits: { m: Date.now() + 3_600_000 } },
      ], {}),
      selector: fakeSelector({ calls }),
      readCredential: async () => undefined,
    })
    await resolve('m')
    expect(calls[0]?.ids).toEqual(['on', 'other'])
  })

  it('⚠️ `allowPermanent` 取反自 `permanentLocked`（true ⇒ false）', async () => {
    // 变异：把 `!deps.pool.permanentLocked(providerId)` 的 `!` 去掉 ⇒ 红。
    for (const [locked, expected] of [[false, true], [true, false]] as const) {
      const calls: Array<{ ids: string[]; allowPermanent: boolean | undefined }> = []
      const resolve = make({
        pool: poolOf(ENTRIES, { R1: '{}' }, locked),
        selector: fakeSelector({ pick: PICK_A1, calls }),
        // 凭据可用 ⇒ 分档选中即返回，不会走到 locked 分支（本用例只看 allowPermanent）。
        readCredential: async (ref) => ref === 'R1' ? { c: 1 } : undefined,
      })
      await resolve('m')
      expect(calls[0]?.allowPermanent).toBe(expected)
    }
  })
})

describe('createCredentialResolver · 骨架 D（loomy 协议分档）', () => {
  function make(overrides: {
    pool: ResolverPool
    selector: unknown
    readCredential: (ref: string) => Promise<unknown>
    reports?: Array<string | undefined>
  }) {
    return createCredentialResolver(
      {
        pool: overrides.pool,
        ...overrides.reports === undefined ? {} : { reportAccount: (id) => overrides.reports!.push(id) },
      },
      {
        product: { id: 'loomy', displayName: 'Loomy (讯飞)' },
        readCredential: overrides.readCredential as never,
        balance: {
          kind: 'loomy',
          selector: overrides.selector as never,
          lockedError: (reason) => new Error(reason.kind === 'unknown' ? '无法确认' : '今日额度用尽'),
        },
        fallback: { kind: 'ref', refName: 'LOOMY_FALLBACK' },
      },
    )
  }

  const ENTRIES = [{ id: 'a1', provider: 'loomy', credentialRef: 'R1' }]

  it('分档选中 + 凭据可用 ⇒ 返回它并回报账号', async () => {
    const reports: Array<string | undefined> = []
    const resolve = make({
      pool: poolOf(ENTRIES, { R1: '{}' }),
      selector: { select: async () => ({ ok: true, account: { id: 'a1', credentialRef: 'R1' }, balance: {} }) },
      readCredential: async (ref) => ref === 'R1' ? { ok: 1 } : undefined,
      reports,
    })
    expect(await resolve('m')).toEqual({ ok: 1 })
    expect(reports).toEqual(['a1'])
  })

  it('⚠️ 选中账号凭据坏 ⇒ **不换号、不问池**，直接退固定 ref', async () => {
    // 变异：把 loomy 分支改成调 `pickBuddyAccount` ⇒ 红（会多调一次 select）。
    const pool = poolOf([...ENTRIES, { id: 'a2', provider: 'loomy', credentialRef: 'R2' }], { R2: '{}' })
    let selectCalls = 0
    const resolve = make({
      pool,
      selector: {
        select: async () => {
          selectCalls++
          return { ok: true, account: { id: 'a1', credentialRef: 'R1' }, balance: {} }
        },
      },
      readCredential: async (ref) => ref === 'LOOMY_FALLBACK' ? { from: 'fallback' } : undefined,
    })
    expect(await resolve('m')).toEqual({ from: 'fallback' })
    expect(selectCalls, '不得换号重试').toBe(1)
    expect(pool.calls, 'loomy 不走池兜底').toEqual([])
  })

  it('⚠️ 锁定 + 分档失败 ⇒ 抛错（不静默退固定 ref）', async () => {
    const resolve = make({
      pool: poolOf(ENTRIES, { R1: '{}' }, true),
      selector: { select: async () => ({ ok: false, reason: { kind: 'exhausted' } }) },
      readCredential: async () => ({ from: 'fallback' }),
    })
    await expect(resolve('m')).rejects.toThrow('今日额度用尽')
  })

  it('未锁定 + 分档失败 ⇒ 静默退固定 ref', async () => {
    const resolve = make({
      pool: poolOf(ENTRIES, { R1: '{}' }),
      selector: { select: async () => ({ ok: false, reason: { kind: 'exhausted' } }) },
      readCredential: async (ref) => ref === 'LOOMY_FALLBACK' ? { from: 'fallback' } : undefined,
    })
    expect(await resolve('m')).toEqual({ from: 'fallback' })
  })

  it('⚠️ 候选空集 ⇒ **连 select 都不调**，直接退兜底', async () => {
    // 变异：去掉 `if (candidates.length > 0)` 守卫 ⇒ 红（会调 select）。
    let selectCalls = 0
    const resolve = make({
      pool: poolOf([], {}),
      selector: { select: async () => { selectCalls++; return { ok: false, reason: { kind: 'exhausted' } } } },
      readCredential: async (ref) => ref === 'LOOMY_FALLBACK' ? { from: 'fallback' } : undefined,
    })
    expect(await resolve('m')).toEqual({ from: 'fallback' })
    expect(selectCalls, '候选空集时不该调 select').toBe(0)
  })
})

/**
 * **接线层**（真实 `apply()`）：注册项有没有把该传的都传对。
 *
 * ⚠️ 这一组替代了原先散在 5 个 spec 里的**源码文本**断言。它比文本断言强：
 * 文本只能证明「某行写在那儿」，这里证明**真实闭包的行为**。
 *
 * 覆盖三条**只有接线层才会错**的语义：
 * 1. 账本回报（`reportLedgerAccount`）有没有真的被调到；
 * 2. qoder 的「当前账号」标记在**池未命中时被清空**；
 * 3. 每个 provider 的 `product.id` 是不是它自己（写死字面量会静默查不到账号）。
 */
describe('★ 接线层：apply() 出来的真实闭包（替代源码文本断言）', () => {
  const dirs: string[] = []

  /**
   * ⚠️ **本组必须桩掉 `fetch`**（2026-10-08 复审修复 —— 此前**漏了**）。
   *
   * `apply()` 出来的真实闭包里有两条会走到网络的路径，而本组**并不需要**它们
   * 成功（断言的是「池命中时回报了哪个账号」与「候选怎么筛」，两者都在网络之前
   * 或与网络无关）：
   *
   * 1. 带余额分档的四家（buddy 协议：buddy / workbuddy / lobsterai / trae）会先问
   *    `isFreeModel()` —— buddy / trae 的适配器内部要 `ensureRemoteModels()`
   *    拉远端目录；
   * 2. 同四家的 `BuddyBalanceSelector.balanceOf` 会查上游余额端点。
   *
   * ⚠️ **实测代价**（复审用临时 `NODE_OPTIONS` 探针量到，未改仓库）：不桩时本组
   * 真的出网 —— `lobsterai` 打 `…/api/user/profile-summary` ×1、`loomy` 打
   * `…/api/v1/points/records` ×1、其余各家打 `models.dev/api.json` ×10。
   * 那是**新增**的（本组的账本名单从 4 家扩到 10 家时带进来的），且与
   * `AGENTS.md` 的「`pnpm test` 快速、无网络、全部 mock」直接冲突：CI 无网/
   * 慢网时表现为延迟与抖动，而当前「4.3 秒通过」只是因为**失败被容忍**
   *（查不到余额 ⇒ 走「无法确认」那条路），不是因为不依赖网络。
   *
   * ⚠️ **桩成失败而不是桩成成功**：成功桩要复刻两套远端报文的完整形状，
   * 一旦上游格式变动就假红，且**测不出**本组要测的东西。失败桩下
   * `isFreeModel` 保守返回 false（= 付费）、余额查不到 ⇒ 落回池选号 ——
   * 正是本组要观察的那条路径。与 `buddy-permanent-lock.spec.ts` /
   * `trae-model-id-selection.spec.ts` 的宿主层同一手法。
   *
   * ⚠️ 本组**没有任何用例注入自己的 `fetchImpl`**，故全局桩不会掩盖真实行为；
   * 将来若有人加一条需要真出网的用例，请**按用例**桩而不是把这里删掉。
   */
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => { throw new Error('单测不发网络') })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
    resetLedgerAccountsForTests()
  })

  class FakeCredentials {
    private store = new Map<string, string>()
    private key(ref: unknown): string { return typeof ref === 'string' ? ref : String(ref) }
    async resolve(ref: unknown) {
      const value = this.store.get(this.key(ref))
      return value === undefined ? undefined : { value, source: 'fake' }
    }
    async describe(ref: unknown) {
      const configured = this.store.has(this.key(ref))
      return { configured, source: configured ? 'fake' : undefined, writable: true }
    }
    async set(ref: unknown, value: string) { this.store.set(this.key(ref), value) }
    async unset(ref: unknown) { this.store.delete(this.key(ref)) }
  }
  class FakeCommands {
    register(): () => void { return () => {} }
  }
  class FakeLlm {
    readonly adapterByProvider = new Map<string, unknown>()
    registerConfigurableProviders(): { replace: () => void } { return { replace: () => {} } }
    registerAdapter(providers: string[], adapter: unknown): { replace: () => void } {
      for (const provider of providers) this.adapterByProvider.set(provider, adapter)
      return { replace: () => {} }
    }
  }

  interface TestCtx extends Context {
    accountPool: { addAccount(entry: Record<string, unknown>): Promise<void> }
    credentials: FakeCredentials
    llm: FakeLlm
  }

  function boot(): TestCtx {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-resolver-'))
    dirs.push(dir)
    process.env.DSH_JET_HUB_STATE_DIR = dir
    const ctx = new Context() as TestCtx
    ctx.provide('credentials', new FakeCredentials() as never)
    ctx.provide('commands', new FakeCommands() as never)
    ctx.provide('llm', new FakeLlm() as never)
    apply(ctx as never)
    return ctx
  }

  function resolveOf(ctx: TestCtx, provider: string): (modelId?: string) => Promise<unknown> {
    const adapter = ctx.llm.adapterByProvider.get(provider) as {
      options?: { resolveCredential?: (modelId?: string) => Promise<unknown> }
      resolveCredential?: (modelId?: string) => Promise<unknown>
    } | undefined
    if (adapter === undefined) throw new Error(`provider ${provider} 未注册`)
    const fn = adapter.options?.resolveCredential ?? adapter.resolveCredential
    if (typeof fn !== 'function') throw new Error(`provider ${provider} 没有 resolveCredential`)
    return fn.bind(adapter.options ?? adapter) as (modelId?: string) => Promise<unknown>
  }

  /** 取某个 provider 的适配器实例（用于读它自己的状态）。 */
  function adapterOf(ctx: TestCtx, provider: string): unknown {
    return ctx.llm.adapterByProvider.get(provider)
  }

  async function addAccount(ctx: TestCtx, provider: string): Promise<string> {
    const id = `acct_${provider}_${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
    const ref = `${provider.toUpperCase()}_ACCOUNT_${id.toUpperCase()}`
    await ctx.accountPool.addAccount({
      id, provider, nickname: id, enabled: true, credentialRef: ref, createdAt: 0, refreshable: true,
    })
    await ctx.credentials.set(
      credentialRef(ref),
      JSON.stringify({ access_token: `tok-${id}`, expires_at: Date.now() + 3_600_000 }),
    )
    return id
  }

  /**
   * ⚠️ **账本回报必须真的接上**。
   *
   * 变异：把注册项里的 `reportAccount` 整个删掉 ⇒ 本条红（`peekLedgerAccount` 恒空）。
   *
   * ⚠️ 这条**不可省**：账本归属是「重构时保持不丢」的显式要求，而它**没有**
   * 任何其他行为断言守着 —— 删掉回报，全量单测仍会全绿（本仓库已实测过
   * 同型「删掉两行、全绿」的形态）。
   *
   * ## ⚠️ 名单必须覆盖**全部可驱动的** provider（2026-10-08 复审补齐）
   *
   * 初版只列了 4 家（raccoon / gemini / minimax / cline）—— 而它替代掉的旧断言
   * 覆盖的是 **TRAE / LOBSTERAI**。于是「删掉 trae 或 zcode 的 `reportAccount`
   * 注册」**不会让任何用例变红**：守卫面比它取代的东西**更窄**了。
   *
   * ⇒ 现在按**实测**列全（判据 = `src/index.ts` 里带 `reportAccount:` 的工厂
   * 注册项，共 12 家），并逐个驱动真实 `apply()` 验证可达性。
   *
   * ## ⚠️ 为什么名单是 10 而不是 12（**实测**结论，不是遗漏）
   *
   * `buddy` 与 `workbuddy` **也有** `reportAccount` 注册项，但它们的账本分支
   * **结构上不可达**，故不能进本名单（加进来就是「绿而无判别力」的空用例）：
   *
   * - 这两家传了 `reportPickedAccount: false`（见 §8.2 登记的既有不对称）⇒
   *   **余额分档选中**那一支不回报；
   * - 唯一会回报的是**池兜底**那一支，而它的候选集恒为**空** ——
   *   池的候选（`enabled` + 该模型未受限）与分档候选**同一判据**，
   *   分档把解析不出凭据的号全部塞进 `tried` 后，池再排除 `tried` 必然取不到号
   *   （`available === null` ⇒ 只回报 `undefined`，而账本忽略 `undefined`）。
   *
   * 实测（本文件编写时穷举过 6 种场景：单号健康 / 坏在前 / 坏在后 / 全坏 /
   * 被限流 / 别的模型被限流）—— **`peekLedgerAccount('buddy')` 恒为空串**，
   * 而同样的场景喂给 `lobsterai` 立刻能拿到账号。该不可达是**基线就有的**
   *（旧闭包同一形态），本 Task 逐字保留，故这里如实排除而不是伪造一个绿用例。
   *
   * 下面那条「名单自检」会把这两家的**存在**钉住：若哪天有人让它们可达，
   * 该自检会提示把名单补到 12 —— 排除因此不会**静默**腐烂。
   */
  const LEDGER_PROVIDERS = [
    'lobsterai', 'qoder', 'qodercn', 'trae', 'cline',
    'loomy', 'raccoon', 'minimax', 'gemini', 'zcode',
    // ⚠️ accio（2026-10-13）：它与上面几家**同形**（走 `createCredentialResolver`
    // 的**纯池选号**分支、无余额分档），故账本分支**可达**，必须进名单 ——
    // 漏了它，「删掉 accio 注册项里的 `reportAccount`」不会让任何用例变红。
    'accio',
    // ⚠️ minimaxintl（2026-10-15）：与 `minimax` 同形（同一工厂、同一分支），
    // 故账本分支**可达**，必须进名单 —— 漏了它，删掉它注册项里的
    // `reportAccount` 不会让任何用例变红。
    'minimaxintl',
  ] as const

  /** 有 `reportAccount` 注册项、但账本分支结构上不可达的两家（见上）。 */
  const LEDGER_UNREACHABLE = ['buddy', 'workbuddy'] as const

  /**
   * ⚠️ provider id → 它在 `src/index.ts` 里用的**产品常量名**。
   *
   * 不能靠 `p.toUpperCase()` 推：`buddy` 的常量是 **`CODEBUDDY`**（产品名），
   * `qodercn` 的是 **`QODER_CN`**（下划线）。写死字面量推导会得到
   * `BUDDY` / `QODERCN` 两个**不存在**的标识符 ⇒ 自检静默失效（实测踩到）。
   */
  const PRODUCT_CONST: Readonly<Record<string, string>> = {
    buddy: 'CODEBUDDY',
    workbuddy: 'WORKBUDDY',
    lobsterai: 'LOBSTERAI',
    qoder: 'QODER',
    qodercn: 'QODER_CN',
    trae: 'TRAE',
    cline: 'CLINE',
    loomy: 'LOOMY',
    raccoon: 'RACCOON',
    minimax: 'MINIMAX',
    // ⚠️ 国际站的常量名带下划线（`MINIMAX_INTL`），与 id `minimaxintl` 不同形 ——
    //    与本表其余项同因，不能靠 `p.toUpperCase()` 推。
    minimaxintl: 'MINIMAX_INTL',
    gemini: 'GEMINI',
    officeace: {} as never,
    zcode: 'ZCODE',
    accio: 'ACCIO',
  }

  it('⚠️ 账本名单自检：覆盖全部可驱动的 provider，且不可达的那两家被显式登记', () => {
    // 名单为空时 `it.each` 一条都不跑 ⇒ 整组恒绿。这条把该形态钉死。
    // ⚠️ 2026-10-15 加 minimaxintl：11 → 12。
    expect(LEDGER_PROVIDERS.length).toBe(12)
    for (const p of LEDGER_UNREACHABLE) {
      expect(LEDGER_PROVIDERS, `${p} 已可达 ⇒ 应把它补进账本名单`).not.toContain(p as never)
    }
    // 不可达的那两家**确实**有注册项 —— 否则「排除」就变成了「忘了接」。
    // ⚠️ 判据只锚 `reportLedgerAccount(<常量>.id,` 这个**前缀**，不锚第二实参：
    // 各家的第二实参形态不同（多数是 `id`，cline 是 `activeClineAccountId`），
    // 写死整串会让「换个局部变量名」这种无害改动假失败。
    for (const p of LEDGER_UNREACHABLE) {
      expect(indexSource, `${p} 的 reportAccount 注册项不见了（那是接线漏了，不是不可达）`)
        .toContain(`reportLedgerAccount(${PRODUCT_CONST[p]}.id,`)
    }
    // 名单里的每一家都必须真的在源码里有自己的账本回报注册项。
    for (const p of LEDGER_PROVIDERS) {
      expect(indexSource, `${p} 没有自己的账本回报注册项`)
        .toContain(`reportLedgerAccount(${PRODUCT_CONST[p]}.id,`)
    }
  })

  it.each(LEDGER_PROVIDERS)(
    '%s：池命中时回报 token 账本（用自己选中的账号）',
    async (provider) => {
      resetLedgerAccountsForTests()
      const ctx = boot()
      const id = await addAccount(ctx, provider)
      await resolveOf(ctx, provider)('glm-5.2')
      expect(peekLedgerAccount(provider), `${provider} 必须回报账本账号`).toBe(id)
    },
    30_000,
  )

  it('⚠️ 账本回报用**自己那个 provider id**（写错会把这笔消耗记到别的渠道）', async () => {
    // 变异：把 raccoon 注册项里的 `RACCOON.id` 改成 `'gemini'` ⇒ 本条红。
    resetLedgerAccountsForTests()
    const ctx = boot()
    const id = await addAccount(ctx, 'raccoon')
    await resolveOf(ctx, 'raccoon')('glm-5.2')
    expect(peekLedgerAccount('raccoon')).toBe(id)
    expect(peekLedgerAccount('gemini'), '不得记到别的 provider 上').toBe('')
  }, 30_000)

  /**
   * ⚠️ **qoder 的「当前账号」标记**：池命中时写入，池未命中时**清空**。
   *
   * 这条是 `reportAccount` 契约里「`undefined` 是有意义事件」的唯一行为守卫。
   * 变异：把 qoder 注册项的回调改成 `if (id !== undefined) activeQoderAccountId.set(…)`
   * ⇒ 本条红（标记会留着旧 id，误伤无辜账号）。
   */
  it('⚠️ qoder：池命中写「当前账号」，池未命中**清空**它', async () => {
    const ctx = boot()
    const adapter = adapterOf(ctx, 'qoder') as { options: { currentAccountId: () => string | undefined } }
    const id = await addAccount(ctx, 'qoder')

    await resolveOf(ctx, 'qoder')('glm-5.2')
    expect(adapter.options.currentAccountId(), '池命中时应记下该账号').toBe(id)

    // 让池再也取不到号（把账号停用）⇒ 标记必须被清空，而不是留着旧 id。
    await (ctx.accountPool as unknown as {
      updateAccount(id: string, patch: Record<string, unknown>): Promise<void>
    }).updateAccount(id, { enabled: false })
    await resolveOf(ctx, 'qoder')('glm-5.2')
    expect(adapter.options.currentAccountId(), '取不到号时必须清空标记').toBeUndefined()
  }, 30_000)

  /**
   * ⚠️ **LobsterAI 必须传自己的凭据解析器**（2026-10-08 二次复审补的接线守卫）。
   *
   * ## 它补的是哪一格
   *
   * Task 6 删掉的那条旧断言是**逐 provider** 点名「`readCredential:` 接的是
   * **本家**那份解析器」。复审时发现它只被**半边**恢复：
   *
   * - **TRAE** 有行为覆盖 —— `buddy-free-model-lock.spec.ts` 的 C4 用例驱动
   *   `'trae'` 的真实闭包，断言 `{"broken":1}` 不得被当成有效凭据交出；
   * - **LobsterAI 一格都没有**。当时唯一看着像命中的是
   *   `buddy-permanent-lock.spec.ts` 里那条「两家凭据解析器做形状校验」——
   *   但它断言的是**解析器函数体内部**的判据（`typeof parsed.access_token === 'string'`），
   *   而不是**工厂配置项把哪个解析器交给了工厂**。
   *
   * ⇒ 后果（复审实测确认）：把 LobsterAI 工厂配置项里的 `readCredential:` 换成
   * buddy 那份（**裸 `JSON.parse`、无形状校验**），**全量单测一条都不会红**。
   * 这正是本 Task 要消灭的那类「接线悄悄接错」。
   *
   * ## 为什么选**行为**形式而不是源码文本
   *
   * LobsterAI 的真实 `apply()` 完全可以驱动（与 TRAE 的 C4 同一手法），故没有理由
   * 退回文本断言 —— 文本只能证明「某行写在那儿」，行为证明**真实闭包真的做了**。
   *
   * ## 判据与两条路径
   *
   * 写一份**合法 JSON、错误形状**（`{"broken":1}`）的账号凭据：
   *
   * - 走**形状校验**（LobsterAI 自己的解析器）⇒ 被拒 ⇒ 该账号进 `tried` ⇒
   *   池兜底排除它 ⇒ 单凭据 ref 不存在 ⇒ `undefined`；
   * - 走**裸 parse**（buddy 那份）⇒ 被接受 ⇒ 直接交出 `{broken:1}`。
   *
   * ⚠️ LobsterAI **没有** `isFreeModel`（它的模型表不带倍率字段），故这里走的是
   * **余额分档**那一支 —— 但那一支同样经 `config.readCredential`（`pickBuddyAccount`
   * 的 `resolveCredential`），所以它守的正是「工厂拿到的是哪一份解析器」。
   * 余额查询被本组的 `fetch` 桩打死 ⇒ 分档把该账号判为「查不到余额」，
   * 未锁定 ⇒ 仍然会去解析它的凭据，判据因此可达。
   *
   * ## 变异（反向验证已实跑）
   *
   * 把工厂配置项里的 `readCredential:` 改成 buddy 那份（或整行删掉）⇒ 本条红。
   */
  it('⚠️ LobsterAI 用**自己的**凭据解析器：形状损坏的凭据不得被交出', async () => {
    const ctx = boot()
    const id = `acct_lobsterai_${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
    const ref = `LOBSTERAI_ACCOUNT_${id.toUpperCase()}`
    await ctx.accountPool.addAccount({
      id, provider: 'lobsterai', nickname: id, enabled: true,
      credentialRef: ref, createdAt: 0, refreshable: true,
    })
    // 合法 JSON、错误形状：形状校验会拒它，裸 parse 会接受它。
    await ctx.credentials.set(credentialRef(ref), '{"broken":1}')

    const outcome = await resolveOf(ctx, 'lobsterai')('glm-5.2')
      .then((v) => ({ kind: 'returned' as const, v }), (e: unknown) => ({ kind: 'threw' as const, e }))

    // ⚠️ **无条件断言**：无论走哪一支，那份损坏凭据都不得被交出去
    //（写成 `if (kind === 'returned') { … }` 会让 `threw` 分支零断言 = 记通过，
    //  与 C4 那条踩过的坑同型）。
    expect(
      outcome.kind === 'returned' ? outcome.v : undefined,
      '损坏凭据不得被交出（LobsterAI 的 readCredential 必须带形状校验）',
    ).toBeUndefined()
    if (outcome.kind === 'threw') {
      expect(outcome.e, '抛错也必须是可诊断的 Error').toBeInstanceOf(Error)
    }
  }, 30_000)

  /**
   * 上一条的**阳性对照**（不可省）：没有它，一个「恒返回 `undefined`」的坏实现
   * 也能让上一条全绿 —— 而那正是「守卫不守」的形态。
   *
   * 判据：同一路径下放一份**形状合法**的凭据 ⇒ 必须原样交出它。
   */
  it('LobsterAI 形状合法的凭据照常交出（上一条的阳性对照）', async () => {
    const ctx = boot()
    const id = `acct_lobsterai_${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
    const ref = `LOBSTERAI_ACCOUNT_${id.toUpperCase()}`
    await ctx.accountPool.addAccount({
      id, provider: 'lobsterai', nickname: id, enabled: true,
      credentialRef: ref, createdAt: 0, refreshable: true,
    })
    await ctx.credentials.set(credentialRef(ref), JSON.stringify({ access_token: `tok-${id}` }))

    const credential = await resolveOf(ctx, 'lobsterai')('glm-5.2') as { access_token?: string } | undefined
    expect(credential?.access_token, '形状合法的凭据必须被交出（否则上一条是同义反复）').toBe(`tok-${id}`)
  }, 30_000)

  /**
   * ⚠️ **每个 provider 的 `product.id` 必须是它自己**。
   *
   * 写死字面量（或复制粘贴时漏改）会让它去查**别的** provider 的账号池 ——
   * 症状是「该渠道永远查不到自己的账号」（本插件在 workbuddy 上踩过同类坑）。
   *
   * 判据：只往 X 的池里放账号，调 X 的闭包必须取到；调**别的**闭包取不到。
   * 变异：把某个注册项的 `product: X` 改成 `product: Y` ⇒ 本条红。
   */
  it('每个 provider 只从**自己**的账号池取号（product.id 不串味）', async () => {
    const ctx = boot()
    const id = await addAccount(ctx, 'raccoon')
    // raccoon 的闭包必须取到它自己那个账号。
    const mine = await resolveOf(ctx, 'raccoon')('glm-5.2') as { access_token?: string } | undefined
    expect(mine?.access_token).toBe(`tok-${id}`)
    // 别的 provider 的池是空的 ⇒ 它们的闭包不该取到这个账号。
    for (const other of ['gemini', 'minimax', 'raccoon'] as const) {
      if (other === 'raccoon') continue
      const theirs = await resolveOf(ctx, other)('glm-5.2').catch(() => undefined)
      expect(theirs, `${other} 不该取到 raccoon 的账号`).toBeUndefined()
    }
  }, 30_000)
})
