/**
 * 「严格手动顺序」的**行为级接线**：`credential-resolver.ts` 必须把
 * `pool.strictManualOrder(provider)` 现读出来传给选号器。
 *
 * ## 为什么需要它（2026-11-09 对抗审计实测：resolver 层**完全无牙**）
 *
 * 把 `src/credential-resolver.ts` 的 buddy 分支改成
 * `strictManualOrder: false`、并删掉 loomy 分支的展开式之后，
 * `strict-manual-order` / `buddy-balance-selector` / `loomy-balance-selector` /
 * `session-balance-wiring` 四个文件共 **95 条用例全绿**。
 *
 * 根因：`strict-manual-order.spec.ts` 只测「纯函数 + 两个 Selector（直接传
 * options）」，从不经过 `createCredentialResolver` ⇒ 那条「池开关 → 选号器
 * 选项」的接线是**零覆盖**的。而它正是整条链路的承重件：接线断了，
 * 开关打开后选号仍按余额分档，用户看到的就是「拖了没反应」。
 *
 * ## 判据为什么必须看 `options` 而不只是返回值
 *
 * 两个分支的**归一化位置不同**（这是刻意的，见两份源码的注释）：
 *
 * - buddy：resolver 传**必填布尔** `strictManualOrder: deps.pool… === true`，
 *   再由 `pickBuddyAccount` 用 `...(options.strictManualOrder === true ? { … } : {})`
 *   归一 ⇒ 关闭时最终 `select()` 收到的**键不存在**；
 * - loomy：resolver 自己就写展开式 ⇒ 同样「关闭时键不存在」。
 *
 * ⚠️ 故断言必须写成 `'strictManualOrder' in options` + `=== true`，
 * 混写成 `toBeFalsy()` 会让「键不存在」与「显式 false」不可区分 ——
 * 而这两种形态在下游是**不同语义**（`=== true` 判据 vs 缺省）。
 */
import { describe, expect, it } from 'vitest'
import {
  createCredentialResolver,
  type CredentialResolverConfig,
  type ResolverPool,
} from '../../src/credential-resolver.js'
import type { BuddySelectorLike, BuddySelectionResult } from '../../src/buddy-balance-selector.js'
import type { LoomySelectorLike, LoomySelectionResult } from '../../src/loomy-balance-selector.js'

type Credential = { token: string }
type Options = { strictManualOrder?: boolean }

/** 记录**每次** `select()` 收到的选项（「现读」判据靠它）。 */
interface Recorder<T> {
  readonly calls: T[]
}

function buddySelector(recorder: Recorder<Options>): BuddySelectorLike {
  return {
    select: async (candidates, options) => {
      recorder.calls.push(options ?? {})
      return {
        ok: true,
        account: candidates[0]!,
        balance: { expiring: 1, permanent: 0 } as never,
      } as unknown as BuddySelectionResult
    },
  }
}

function loomySelector(recorder: Recorder<Options>): LoomySelectorLike {
  return {
    select: async (candidates, options) => {
      recorder.calls.push(options ?? {})
      return {
        ok: true,
        account: candidates[0]!,
        balance: { dailyBalance: 1 } as never,
      } as unknown as LoomySelectionResult
    },
  }
}

/**
 * 池替身。
 *
 * ⚠️ `strictManualOrder` 的三种形态必须都能表达：`true` / `false` / **未实现**
 * —— 未实现是结构化 stub 与旧测试替身的常态，而生产里它是真实方法。
 */
function poolWithStrictManualOrder(
  value: boolean | undefined,
): ResolverPool<Credential> {
  const pool: ResolverPool<Credential> = {
    listAccountsByProvider: () => [{ id: 'a1', credentialRef: 'R', enabled: true }],
    permanentLocked: () => false,
    getAvailableAccount: async () => null,
  }
  if (value !== undefined) pool.strictManualOrder = () => value
  return pool
}

function buddyConfig(recorder: Recorder<Options>): CredentialResolverConfig<Credential> {
  return {
    product: { id: 'buddy', displayName: 'CodeBuddy' },
    readCredential: async (refName) => ({ token: refName }),
    fallback: { kind: 'ref', refName: 'FALLBACK' },
    balance: {
      kind: 'buddy',
      selector: buddySelector(recorder),
      lockedError: (reason) => new Error(`locked:${reason.kind}`),
      isFreeModel: () => false,
    },
  }
}

function loomyConfig(recorder: Recorder<Options>): CredentialResolverConfig<Credential> {
  return {
    product: { id: 'loomy', displayName: 'Loomy (讯飞)' },
    readCredential: async (refName) => ({ token: refName }),
    fallback: { kind: 'ref', refName: 'FALLBACK' },
    balance: {
      kind: 'loomy',
      selector: loomySelector(recorder),
      lockedError: (reason) => new Error(`locked:${reason.kind}`),
    },
  }
}

describe('createCredentialResolver · 严格手动顺序接线（buddy 协议）', () => {
  it('池返回 true ⇒ 选号器收到 `strictManualOrder: true`', async () => {
    const recorder: Recorder<Options> = { calls: [] }
    const resolve = createCredentialResolver(
      { pool: poolWithStrictManualOrder(true) },
      buddyConfig(recorder),
    )
    await expect(resolve('GLM-5.2')).resolves.toEqual({ token: 'R' })
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]!.strictManualOrder).toBe(true)
  })

  it('池返回 false ⇒ 选号器收到的选项里**没有**该键', async () => {
    const recorder: Recorder<Options> = { calls: [] }
    const resolve = createCredentialResolver(
      { pool: poolWithStrictManualOrder(false) },
      buddyConfig(recorder),
    )
    await resolve('GLM-5.2')
    expect('strictManualOrder' in recorder.calls[0]!).toBe(false)
  })

  it('池**未实现**该方法 ⇒ 选项里没有该键（旧替身行为逐字不变）', async () => {
    const recorder: Recorder<Options> = { calls: [] }
    const resolve = createCredentialResolver(
      { pool: poolWithStrictManualOrder(undefined) },
      buddyConfig(recorder),
    )
    await resolve('GLM-5.2')
    expect('strictManualOrder' in recorder.calls[0]!).toBe(false)
  })

  it('★ 每次请求**现读**（面板随时可切换，不能缓存到闭包）', async () => {
    const recorder: Recorder<Options> = { calls: [] }
    let enabled = false
    const pool = poolWithStrictManualOrder(false)
    pool.strictManualOrder = () => enabled
    const resolve = createCredentialResolver({ pool }, buddyConfig(recorder))

    await resolve('GLM-5.2')
    enabled = true
    await resolve('GLM-5.2')

    expect(recorder.calls.map((options) => 'strictManualOrder' in options)).toEqual([false, true])
  })
})

describe('createCredentialResolver · 严格手动顺序接线（loomy 协议）', () => {
  it('池返回 true ⇒ 选项里带 `strictManualOrder: true`', async () => {
    const recorder: Recorder<Options> = { calls: [] }
    const resolve = createCredentialResolver(
      { pool: poolWithStrictManualOrder(true) },
      loomyConfig(recorder),
    )
    await expect(resolve('qwen-3.8-max')).resolves.toEqual({ token: 'R' })
    expect(recorder.calls[0]!.strictManualOrder).toBe(true)
  })

  it('池返回 false ⇒ 选项里**没有**该键（展开式的语义，不是 `false`）', async () => {
    const recorder: Recorder<Options> = { calls: [] }
    const resolve = createCredentialResolver(
      { pool: poolWithStrictManualOrder(false) },
      loomyConfig(recorder),
    )
    await resolve('qwen-3.8-max')
    expect('strictManualOrder' in recorder.calls[0]!).toBe(false)
  })

  it('池**未实现**该方法 ⇒ 选项里没有该键（旧替身行为逐字不变）', async () => {
    const recorder: Recorder<Options> = { calls: [] }
    const resolve = createCredentialResolver(
      { pool: poolWithStrictManualOrder(undefined) },
      loomyConfig(recorder),
    )
    await resolve('qwen-3.8-max')
    expect('strictManualOrder' in recorder.calls[0]!).toBe(false)
  })
})
