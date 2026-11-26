/**
 * ★★★ **接线级行为守卫：真跑 `apply()`，观察 codearts 传给选号的 `rotationStartId`**
 *
 * ## 这是上游登记的最后一条缺口（PR #168 两轮审计都点名）
 *
 * > 「把 `subagentMainStartIdOf` 改成 `if (false) return 纯函数(...); return undefined`
 * >  ⇒ **全量 15124 条全绿**（`codearts-subagent-wiring.spec.ts:146` 的源码正则
 * >  仍匹配死分支里的文本）。」
 * >
 * > 「⇒ **判据本体有真守卫了，但「调用点」没有。** 这是 P0-A 缺口的**最后一层**。」
 * >
 * > 「要挡住它需要**接线级行为用例**（真跑 `apply()` → 观察选号），
 * >  成本明显高于纯函数守卫 —— 我这轮**没有做**，如实说，不假装它被解决了。」
 *
 * ## 本文件怎么做（真链路 + spy 观测）
 *
 * 1. **真跑 `apply()`** —— 真实装配、真 `AccountPool`、真 adapter、真闭包
 * 2. 从 ctx 取回**真池**（服务名 `accountPool`），用它**公开方法**写数据：
 *    `addAccount`（3 个号）+ `recordSubagentStart`（slot）+ `setSubagentRotation`（策略）
 * 3. **给真池的 `getAvailableAccount` 装 spy**（包裹原方法，只观测不改行为）
 * 4. 调 adapter 上**真实的 `resolveCredential`**
 * 5. 断言 spy 收到的 **第 4 个实参**（`rotationStartId`）是策略算出的号
 *
 * ## 为什么用 spy 而不是断言「返回了哪份凭据」
 *
 * 真池的 `resolveFirstCredential` 走 `ctx.credentials.resolve` + 各家形状校验，
 * 让它在单测里「成功返回一份可识别凭据」需要复刻过多内部细节。
 * 而**接线**的定义就是「起点有没有传到选号」—— 第 4 个实参正好是它。
 *
 * ⚠️ 这个判据**仍然对 `if (false)` 免疫**：
 *    调用点被包死 ⇒ `rotationStartId` 变 `undefined` ⇒ spy 收到 `undefined`
 *    ⇒ 断言（必须等于策略算出的号）**必红**。源码正则看不出这一点。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { apply } from '../../src/index.js'
import { clearProviderRuntimes } from '../../src/provider-runtime.js'

class FakeCredentials {
  async resolve(ref: string): Promise<{ value: string } | undefined> {
    return {
      value: JSON.stringify({
        marker: ref,
        access_token: `token-${ref}`,
        refresh_token: `refresh-${ref}`,
      }),
    }
  }
  async describe() { return { configured: false, writable: true } }
  async set(): Promise<void> {}
  async unset(): Promise<void> {}
}
class FakeCommands { register() { return () => {} } }
class FakeLlm {
  /** ⚠️ 第一个参数是 `readonly string[]`（见 `registerAdapterIdempotent`）。 */
  registered: Array<{ ids: readonly string[], adapter: Record<string, unknown> }> = []
  registerConfigurableProviders() { return { replace: () => {} } }
  registerAdapter(ids: readonly string[], adapter: Record<string, unknown>) {
    this.registered.push({ ids, adapter })
    return { replace: () => {} }
  }
  async listModels(): Promise<never[]> { return [] }
}
/**
 * `settings` 服务替身。
 *
 * ⚠️⚠️ **scope 的三个方法都必须实现**（我踩了三轮）：
 * `createJetHubStore(ctx)` 在无 file store 时退化为 **`SettingsStore`**，
 * 它的 `load()` 是 `scope.get()`、`save()` 是 `scope.replace(v)`。
 * 缺 `get` ⇒ `Cannot read properties of undefined (reading 'get')`；
 * 缺 `replace` ⇒ `this.scope.replace is not a function`。
 */
class FakeSettings {
  private value: unknown = undefined
  register() {
    return {
      get: () => this.value,
      set: async (v: unknown) => { this.value = v },
      replace: async (v: unknown) => { this.value = v },
    }
  }
  describe(): Array<{ ns: string }> { return [] }
}

afterEach(() => { clearProviderRuntimes() })

function applyOnce(): { ctx: Context, llm: FakeLlm } {
  clearProviderRuntimes()
  const ctx = new Context()
  const llm = new FakeLlm()
  ;(ctx as unknown as Record<string, unknown>).logger = {
    info: () => {}, debug: () => {}, warn: () => {}, error: () => {},
  }
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', new FakeCommands() as never)
  ctx.provide('llm', llm as never)
  ctx.provide('settings', new FakeSettings() as never)
  /** ⚠️ `registerJetHubRpc` 走 `ctx.inject(['connection'], …)` ⇒ 必须装桩。 */
  ;(ctx as unknown as Record<string, unknown>).inject = (
    _deps: string[],
    cb: (c: unknown) => void,
  ) => { cb(ctx) }
  apply(ctx)
  return { ctx, llm }
}

/** 真池上本用例用到的那些方法（结构化，避免 import 整个类）。 */
interface PoolLike {
  addAccount(entry: Record<string, unknown>): Promise<void>
  recordSubagentStart(p: string, s: string, parent: string, now: number): Promise<number>
  setSubagentRotation(p: string, s: Record<string, unknown> | undefined): Promise<void>
  setActiveAccount(p: string, s: string | undefined, a: string | undefined): void
  getAvailableAccount: (...args: unknown[]) => Promise<unknown>
}

/** 从 ctx 取回**真实** `AccountPool`（服务名 `accountPool`）。 */
function realPoolOf(ctx: Context): PoolLike {
  const get = (ctx as unknown as { get?: (n: string) => unknown }).get
  expect(typeof get, 'ctx.get 必须可用').toBe('function')
  const pool = get!.call(ctx, 'accountPool')
  expect(pool, '必须能从 ctx 取回真实 AccountPool（服务名 accountPool）').toBeDefined()
  return pool as PoolLike
}

/** 取出 codearts 真实 `resolveCredential`。 */
function codeartsResolveOf(llm: FakeLlm): (model?: string, sessionId?: string) => Promise<unknown> {
  const hit = llm.registered.find((r) => r.ids.includes('codearts'))
  expect(hit, '真跑 apply() 后必须注册了 codearts adapter').toBeDefined()
  const options = hit!.adapter.options as Record<string, unknown> | undefined
  expect(options, 'codearts adapter 必须带 options').toBeDefined()
  const resolve = options!.resolveCredential
  expect(typeof resolve, 'options.resolveCredential 必须是函数').toBe('function')
  return resolve as (model?: string, sessionId?: string) => Promise<unknown>
}

/** 往真池塞 3 个 codearts 账号。 */
async function seedAccounts(pool: PoolLike): Promise<void> {
  for (const ref of ['R-oa1', 'R-oa2', 'R-oa3']) {
    await pool.addAccount({ id: ref, provider: 'codearts', credentialRef: ref, enabled: true })
  }
}

/**
 * 给 `getAvailableAccount` 装 spy：只记录第 4 个实参，**不改行为**。
 *
 * @returns 一个数组，每次调用 push 进 `rotationStartId`。
 */
function spyRotationStart(pool: PoolLike): unknown[] {
  const seen: unknown[] = []
  const original = pool.getAvailableAccount
  pool.getAvailableAccount = async (...args: unknown[]) => {
    /** ⚠️ 第 4 个实参是 `rotationStartId`（见 `getAvailableAccount` 签名）。 */
    seen.push(args[3])
    return await original.apply(pool, args)
  }
  return seen
}

describe('接线级：真跑 apply() + 真池，观察 codearts 传给选号的起点', () => {
  it('★★★ 前提：能取到 codearts resolveCredential 与真实 AccountPool', () => {
    const { ctx, llm } = applyOnce()
    codeartsResolveOf(llm)
    realPoolOf(ctx)
    console.log('  [接线] adapter 数:', llm.registered.length, ' 真池可取: ✅')
  })

  it('★★★ 起点 = 「实际在用」的号 ⇒ 必须传给 `getAvailableAccount`（**接线级**）', async () => {
    /**
     * ## 构造（对齐上游给的对照数字）
     *
     * 池 `[R-oa1, R-oa2, R-oa3]`、子代理 `sequence` slot=0：
     *
     * | 主代理「实际在用」| `(idx+1)%3` | 应传给选号的起点 |
     * |---|---|---|
     * | R-oa1 | `1` | R-oa2 |
     * | **R-oa2** | `2` | **R-oa3** |
     * | R-oa3 | `0` | R-oa1 |
     *
     * ⇒ 若接线断了（`mainSessionStartId` 没传/被包死），`decideSubagentStart`
     *   拿不到主代理起点 ⇒ `sequence` 从**池首 R-oa1** 出发 ⇒ 传 `R-oa2`
     *   ⇒ **断言 `R-oa3` 必红**。
     */
    const { ctx, llm } = applyOnce()
    const pool = realPoolOf(ctx)
    const resolve = codeartsResolveOf(llm)

    await seedAccounts(pool)
    const slot = await pool.recordSubagentStart('codearts', 'child-1', 'main-1', Date.now())
    await pool.setSubagentRotation('codearts', { startMode: 'sequence' })
    /** ★ 主代理 main-1 **实际在用** R-oa2。 */
    pool.setActiveAccount('codearts', 'main-1', 'R-oa2')

    const seen = spyRotationStart(pool)
    await resolve('m', 'child-1')
    console.log('  [接线] slot =', slot, ' 传给选号的起点 =', seen[0])

    expect(
      seen[0],
      '★★★ 起点必须是 R-oa3（实际在用 R-oa2 往后错开一位）'
      + `；拿到 ${String(seen[0])} 说明接线断了（很可能退化成池首 R-oa1 ⇒ R-oa2）`,
    ).toBe('R-oa3')
  })

  it('★★★ 反向对照：无「实际在用」⇒ 退化池首 ⇒ 传 R-oa2', async () => {
    /**
     * ⚠️ **没有这条，上一条的 `R-oa3` 可能只是别的原因碰巧**。
     * 这条证明「实际在用」这一格**真的影响传下去的值**。
     */
    const { ctx, llm } = applyOnce()
    const pool = realPoolOf(ctx)
    const resolve = codeartsResolveOf(llm)

    await seedAccounts(pool)
    await pool.recordSubagentStart('codearts', 'child-1', 'main-1', Date.now())
    await pool.setSubagentRotation('codearts', { startMode: 'sequence' })
    /** ⚠️ **不设** activeAccount ⇒ 退化池首 R-oa1。 */

    const seen = spyRotationStart(pool)
    await resolve('m', 'child-1')
    console.log('  [接线-对照] 传给选号的起点 =', seen[0])

    expect(seen[0], '★★ 无「实际在用」⇒ 退化池首 R-oa1 ⇒ 传 R-oa2').toBe('R-oa2')
  })
})
