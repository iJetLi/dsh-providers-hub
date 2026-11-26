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

/**
 * 记录每一次 `resolve(ref)` 的调用顺序（= 凭据读取顺序 = 遍历顺序）。
 *
 * ⚠️ **这是观测「遍历顺序首位」的唯一可靠手段**：
 * officeace 锁定态逐个 `readCredential`，第一个读成功的就返回。
 * ⇒ 把 `marker` 塞进凭据里，再配合「全部读成功」，就能从返回值的
 * `marker` 反推**首位是哪个号**。
 */
const credentialReads: string[] = []

class FakeCredentials {
  async resolve(ref: string): Promise<{ value: string } | undefined> {
    /**
     * ⚠️ **必须同时满足两家的形状校验**（缺字段就都读不出来）：
     *
     * | 家 | 要求的字段 | 校验位置 |
     * |---|---|---|
     * | codearts | `access_token` / `refresh_token` | `CODEARTS_ACCOUNT_XXX` 解析 |
     * | officeace | **`modelAppKey` 非空** | `officeace-auth.ts:725` |
     *
     * ⚠️ officeace 那条我漏了两轮：`readCredential` 只在
     * `typeof parsed.modelAppKey === 'string' && length > 0` 时才返回凭据，
     * 否则**回落 `readStoredCredential(ref)`**（本机文件）⇒ 单测里恒 `undefined`
     * ⇒ 锁定态判「凭据读不出来」。**这就是上游说的「跑出来起点是 undefined」的真因之一。**
     */
    const payload = {
      marker: ref,
      // codearts 用
      access_token: `token-${ref}`,
      refresh_token: `refresh-${ref}`,
      // officeace 用（`modelAppKey` 是硬要求，见上方注释）
      modelAppKey: `appkey-${ref}`,
      modelAppSecret: `secret-${ref}`,
      maasBaseUrl: 'https://maas.example.invalid',
      access: `ak-${ref}`,
      secret: `sk-${ref}`,
      securityToken: `sts-${ref}`,
      projectId: 'proj-1',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      refreshToken: `rt-${ref}`,
      dpopPrivateJwk: {},
      basicAuthorization: `Basic ${ref}`,
      sessionCookie: `cookie-${ref}`,
    }
    credentialReads.push(ref)
    return { value: JSON.stringify(payload) }
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
  setPermanentLocked(p: string, locked: boolean): Promise<void>
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

/**
 * 注入 `agents` 注册表，让 `resolveSubagentParent` 能返回给定的父会话。
 *
 * ⚠️ `apply()` 内部通过 `ctx.get('agents')` 读它（见 `src/index.ts` 的
 * `resolveSubagentParent`）⇒ 必须在 **`apply()` 之前或之后**装好
 * （`get` 是每次现调，故之后装也生效）。
 */
/**
 * 注入 `agents` 注册表，让 `resolveSubagentParent` 能返回给定的父会话。
 *
 * ⚠️⚠️ **必须用 `ctx.provide('agents', …)`，绝不能覆盖 `ctx.get`**。
 *
 * ## 为什么（我踩了这个坑，症状极具误导性）
 *
 * `ctx` 是 **cordis 的 Proxy**。直接 `anyCtx.get = (name) => …` 会让它之后
 * 解析 `ctx.credentials` 时抛：
 *
 * ```
 * TypeError: (intermediate value)(intermediate value)(intermediate value) is not a function
 *   at Object.readCredential (src/index.ts:6343)   ← ctx.credentials
 *   at resolveCredential (src/officeace-lock.ts:444)
 * ```
 *
 * ⇒ 凭据**一次都没读** ⇒ 看起来像「起点算不出来」，实际是**脚手架把 ctx 弄坏了**。
 *
 * ⚠️ 这正是上游说「我试过、没补成」可能的另一个成因 —— 他停在「起点 undefined」，
 *   而真因可能是**观测者自己破坏了被测环境**。
 */
function injectAgents(ctx: Context, childId: string, parentId: string): void {
  ctx.provide('agents', {
    get: (id: string) => (id === childId
      ? { session: { header: { parentSession: parentId } } }
      : undefined),
  } as never)
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

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * ★★★ **装配层守卫**（上游 PR #171 审计第 ① 条，最要紧的那条）
   * ═══════════════════════════════════════════════════════════════════════
   *
   * ## 上游原话
   *
   * > 「**生产装配层仍然零守卫**（与 P0-A 当初同型）
   * >   删掉 `index.ts:6311-6312` 那两行注入 ⇒ **全量 15463 只剩已知的环境/flaky 红**。
   * >
   * > ⇒ 也就是说：**守卫罩住了「函数本身」，但「`apply()` 里有没有把它接上」还是没人管。**
   * >   这正是我从 #164 那轮开始一直在说的那个形态——**它又出现了一次，只是往上挪了一层。**」
   *
   * ## 为什么之前的守卫挡不住
   *
   * | 层 | 守卫 | 删掉注入后会怎样 |
   * |---|---|---|
   * | 判据本体 | `subagent-readpath-guard.spec.ts` | **仍全绿**（函数没变）|
   * | 源码正则 | `officeace-subagent-wiring.spec.ts` O7 | **仍全绿**（`subagentPool:` 那行还在）|
   * | 行为级 | `officeace-lock-readpath.spec.ts` | **仍全绿**（它自己注入 deps）|
   * | **装配层** | **本组** | **必红** |
   *
   * ⇒ 缺的就是「`apply()` 到底有没有把这两个回调传进去」。
   *
   * ## 判据
   *
   * 真跑 `apply()` 后，从 officeace adapter 上取回**生产装配出来的**
   * `credentialProvider`，然后**观察它的行为**：
   *
   * 1. 造一个「分配表为空 + 只有会话头能给出父会话」的场景（P0-C 的鸡生蛋形态）；
   * 2. 若 `resolveSubagentParent` **被接上** ⇒ 能算出起点 ⇒ 首位 ≠ 池首；
   * 3. 若**没接上** ⇒ 登记失败 ⇒ 原样返回 ⇒ 首位 = 池首。
   *
   * ⚠️ 这条**同时覆盖 P0-C 与 P0-D 的装配**：两者任一没接上都会让首位退回池首。
   */
  it('★★★ 装配层：officeace 的 resolveSubagentParent / mainStartIdOf 必须真的被 apply() 接上', async () => {
    const { ctx, llm } = applyOnce()
    const pool = realPoolOf(ctx)

    /** 取 officeace adapter 的 `credentialProvider`（生产装配出来的那个闭包）。 */
    const hit = llm.registered.find((r) => r.ids.includes('officeace'))
    expect(hit, '真跑 apply() 后必须注册了 officeace adapter').toBeDefined()
    const options = hit.adapter.options as Record<string, unknown> | undefined
    expect(options, 'officeace adapter 必须带 options').toBeDefined()
    const provider = options.credentialProvider
    expect(typeof provider, 'options.credentialProvider 必须是函数').toBe('function')

    /** ① 塞 3 个 officeace 账号（真池的公开方法）。 */
    for (const ref of ['R-oa1', 'R-oa2', 'R-oa3']) {
      await pool.addAccount({ id: ref, provider: 'officeace', credentialRef: ref, enabled: true })
    }
    /** ② 配 sequence 策略。 */
    await pool.setSubagentRotation('officeace', { startMode: 'sequence' })
    /**
     * ⚠️⚠️ **必须设成「锁定永久积分」态** —— 这是本用例的关键前置。
     *
     * ## 为什么（我踩了一轮才想明白）
     *
     * `officeace` 有**两条腿**，它们取父会话的方式**不同**：
     *
     * | 腿 | 触发条件 | 父会话来源 |
     * |---|---|---|
     * | 未锁定（默认）| `permanentLocked === false` | `index.ts:6212` **直接调局部** `resolveSubagentParent(sessionId)` |
     * | **锁定** | `permanentLocked === true` | `deps.resolveSubagentParent?.(…)`（**注入的那个**）|
     *
     * ⇒ 上游点名的 `index.ts:6298` 那行注入**只对锁定态生效**。
     *   不设锁定态的话，删掉注入**不会有任何变化**（未锁定腿自己直接调局部函数）
     *   ⇒ 守卫看起来"通过"但**永远抓不到那个变异**（我第一版就是这样，M34 无牙）。
     */
    await pool.setPermanentLocked('officeace', true)
    /**
     * ③ 主代理「实际在用」第 1 个号（= 池首）。
     *
     * ⚠️ 刻意用池首：这样 `sequence` 从它出发 ⇒ 首位应是**第 2 个号**，
     *    而「完全没接上」时首位 = 池首 ⇒ **两者可分辨**。
     */
    pool.setActiveAccount('officeace', 'main-1', 'R-oa1')

    /**
     * ④ **关键**：注入 `agents` 注册表，让 `resolveSubagentParent('child-1')`
     *    能返回 `'main-1'`。
     *
     * ⚠️⚠️ 这是本用例的核心 —— 上游点名的「装配层」就是这个回调**有没有被接上**：
     *
     * - `apply()` 里 `resolveSubagentParent: (sid) => resolveSubagentParent(sid)` 那行在
     *   ⇒ 本用例能通过（登记成功、分配表写入）；
     * - 那行被删 / 包 `if(false)` ⇒ `resolveSubagentParent` 恒 `undefined`
     *   ⇒ 登记失败 ⇒ **分配表仍空 ⇒ 本用例必红**。
     *
     * ⚠️ `ctx.get('agents')` 是 `apply()` 内部读的入口，必须在 `apply()` **之前**装好。
     */
    const anyCtx = ctx as unknown as Record<string, unknown>
    const prevGet = anyCtx.get as ((n: string) => unknown) | undefined
    anyCtx.get = (name: string) => {
      if (name === 'agents') {
        return {
          get: (id: string) => (id === 'child-1'
            ? { session: { header: { parentSession: 'main-1' } } }
            : undefined),
        }
      }
      return prevGet === undefined ? undefined : prevGet.call(ctx, name)
    }

    /**
     * ⑤ 调生产装配的 `credentialProvider`。
     *
     * ⚠️ 分配表**是空的**（没调 recordSubagentStart）⇒ 只能靠
     *    `resolveSubagentParent` 从会话头拿到父会话 ⇒ 这正是 P0-C 的形态。
     *
     * ⚠️⚠️ **必须 `catch`**：锁定态在 `readCredential` 全失败时会**抛**
     *    「无法确认是否有可用账号」—— 那是**下游**的事，与我们关心的
     *    「登记有没有发生」无关。`orderAccountsForSubagent` 在 `readCredential`
     *    **之前**执行（`officeace-lock.ts:441` vs `:444`）⇒ 登记该发生的已经发生了。
     */
    try {
      const out = await (provider as (sid?: string) => Promise<unknown>)
        .call(options, 'child-1')
      console.log('  [装配层] credentialProvider 返回:', out === undefined ? 'undefined' : typeof out)
    } catch (error) {
      /** ⚠️ 预期内：锁定态 + 凭据读不出来 ⇒ 抛它是**正常**行为。 */
      console.log('  [装配层] credentialProvider 抛（预期内）:',
        error instanceof Error ? error.message.slice(0, 40) : String(error))
    }

    /**
     * ⚠️⚠️ **`registerSubagentStartIfNeeded` 是 fire-and-forget**
     * （`void pool.recordSubagentStart(…).catch(…)`，见 `subagent-start.ts:210`）
     * ⇒ 立即读分配表会拿到 `undefined`。
     *
     * ⇒ 必须**让出一拍**再断言。我第一版没等，导致变异 `M34` **无牙**
     *   （删掉注入后仍读到 `undefined` ⇒ 两次都"失败"？不：两次都读到空
     *    ⇒ 断言 `toBeDefined` 在**基线**上就该红 —— 实际基线却绿，
     *    说明我第一版读到的是**上一轮残留**，判据不可靠）。
     */
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })

    /**
     * ⑥ 关键断言：**登记表必须已经被写入**。
     *
     * 这是最直接的「接没接上」证据：
     * - `resolveSubagentParent` 接上 ⇒ 登记成功 ⇒ 分配表有 `child-1`
     * - 没接上 ⇒ 登记失败 ⇒ 分配表仍空
     */
    const assignment = pool.subagentAssignmentOf?.('officeace', 'child-1')
    console.log('  [装配层] 分配表 child-1 =', assignment === undefined ? 'undefined' : JSON.stringify(assignment))
    expect(
      assignment,
      '★★★ apply() 必须把 resolveSubagentParent 接进 officeace 的 credentialProvider。'
        + '分配表为空 = 没接上 ⇒ P0-C 的鸡生蛋在生产里复发',
    ).toBeDefined()
  })

  /**
   * ## 装配层（codearts 腿）：`subagentMainStartIdOf` 必须真的接进 adapter
   *
   * ⚠️ 与上一条同型，但走 codearts 腿 —— 上游点名的是 `index.ts:6311-6312`（officeace），
   *    而 codearts 那条腿（`index.ts:1569`）有**同样**的装配风险。
   *
   * ⇒ 判据：真跑 `apply()`，给真池装 spy，看传给 `getAvailableAccount` 的起点
   *   是否随「主代理实际在用」变化。若装配断了 ⇒ 起点恒 `undefined`。
   */
  it('★★★ 装配层：codearts 的 subagentMainStartIdOf 必须真的被接上（起点非 undefined）', async () => {
    const { ctx, llm } = applyOnce()
    const pool = realPoolOf(ctx)
    const resolve = codeartsResolveOf(llm)

    await seedAccounts(pool)
    await pool.recordSubagentStart('codearts', 'child-1', 'main-1', Date.now())
    await pool.setSubagentRotation('codearts', { startMode: 'sequence' })
    pool.setActiveAccount('codearts', 'main-1', 'R-oa2')

    const seen = spyRotationStart(pool)
    await resolve('m', 'child-1')
    console.log('  [装配层-codearts] 传给选号的起点 =', seen[0])
    /**
     * ⚠️ **判据是「非 undefined」**：装配断了（`subagentMainStartIdOf` 恒 undefined）
     *    ⇒ 起点 `undefined` ⇒ 选号退化成池首。
     */
    expect(
      seen[0],
      '★★★ apply() 必须把 subagentMainStartIdOf 接进 codearts 腿。'
        + '起点为 undefined = 没接上（退化成池首）',
    ).toBeDefined()
  })

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * ★★★ **P0-B 本体：`registerSubagentStartIfNeeded` 的两处调用**
   * ═══════════════════════════════════════════════════════════════════════
   *
   * ## 上游原话（PR #171 审计第 ② 条）
   *
   * > 「**P0-B 没补**：`index.ts:1590`（codearts 腿）与 `:6218`（officeace 未锁定腿
   * >   = **P0-B 的本体**）把 `registerSubagentStartIfNeeded` 的调用包 `if (false)`
   * >   ⇒ **68 文件 / 777 条全绿**。
   * >
   * > ⇒ 仍只有 `toContain` 源码文本守卫。这是我登记的四条里**唯一还剩的**。」
   *
   * ## 为什么我上一轮的 O4b/O5b 没补上它
   *
   * 我做的是 `officeace-lock.ts` 里「`subagentPool` 缺失」与「try/catch」——
   * 那是**另一个位置**。P0-B 说的是 `index.ts` 里这两处**登记调用**。
   *
   * ⚠️ 这正是我反复犯的错：**补了「点」，没扫「面」**。
   */
  it('★★★ P0-B 本体：codearts 腿的 registerSubagentStartIfNeeded 必须真的执行', async () => {
    const { ctx, llm } = applyOnce()
    const pool = realPoolOf(ctx)
    const resolve = codeartsResolveOf(llm)

    await seedAccounts(pool)
    await pool.setSubagentRotation('codearts', { startMode: 'sequence' })

    /** 注入 agents 注册表 ⇒ `resolveSubagentParent` 能给出父会话。 */
    injectAgents(ctx, 'child-c', 'main-c')

    /** ⚠️ 前置校验：调之前分配表必须为空，否则下面的断言没有意义。 */
    expect(
      pool.subagentAssignmentOf?.('codearts', 'child-c'),
      '前置：调之前分配表里不该有该会话',
    ).toBeUndefined()

    await resolve('m', 'child-c')
    /** ⚠️ 登记是 fire-and-forget ⇒ 让出一拍。 */
    await new Promise<void>((r) => { setTimeout(r, 20) })

    const assignment = pool.subagentAssignmentOf?.('codearts', 'child-c')
    console.log('  [P0-B codearts] 分配表 child-c =',
      assignment === undefined ? 'undefined' : JSON.stringify(assignment))
    expect(
      assignment,
      '★★★ codearts 腿的 registerSubagentStartIfNeeded 必须真的执行。'
        + '分配表为空 = 该调用被删 / 被 if(false) 包住 ⇒ P0-B 本体没接上',
    ).toBeDefined()
  })

  it('★★★ P0-B 本体：officeace 未锁定腿的 registerSubagentStartIfNeeded 必须真的执行', async () => {
    const { ctx, llm } = applyOnce()
    const pool = realPoolOf(ctx)

    const hit = llm.registered.find((r) => r.ids.includes('officeace'))
    expect(hit, '必须有 officeace adapter').toBeDefined()
    const options = hit!.adapter.options as Record<string, unknown>
    const provider = options.credentialProvider as (sid?: string) => Promise<unknown>

    for (const ref of ['R-oa1', 'R-oa2', 'R-oa3']) {
      await pool.addAccount({ id: ref, provider: 'officeace', credentialRef: ref, enabled: true })
    }
    await pool.setSubagentRotation('officeace', { startMode: 'sequence' })
    /** ⚠️ **不设锁定** ⇒ 走未锁定腿（= P0-B 的本体）。 */
    await pool.setPermanentLocked('officeace', false)

    injectAgents(ctx, 'child-u', 'main-u')

    expect(
      pool.subagentAssignmentOf?.('officeace', 'child-u'),
      '前置：调之前分配表里不该有该会话',
    ).toBeUndefined()

    try {
      await provider.call(options, 'child-u')
    } catch {
      /** ⚠️ 预期内：真实装配下凭据读不出来会抛，那不影响「登记有没有发生」。 */
    }
    await new Promise<void>((r) => { setTimeout(r, 20) })

    const assignment = pool.subagentAssignmentOf?.('officeace', 'child-u')
    console.log('  [P0-B officeace] 分配表 child-u =',
      assignment === undefined ? 'undefined' : JSON.stringify(assignment))
    expect(
      assignment,
      '★★★ officeace 未锁定腿的 registerSubagentStartIfNeeded 必须真的执行',
    ).toBeDefined()
  })

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * ★★★ **装配层②：`mainStartIdOf` 也必须真的被接上**
   * ═══════════════════════════════════════════════════════════════════════
   *
   * ## 上游原话（PR #173 合并时）
   *
   * > 「只删 `mainStartIdOf` 那一行注入 ⇒ **全绿**。」
   * >
   * > 「⚠️ **PR 标题里的『装配层变异 3/3 有牙』是虚高的，实为 1/3 无牙。**
   * >   这不怪你写错代码，是**判据选错了观察点**。」
   * >
   * > 「原因：新用例的判据**只靠 `resolveSubagentParent` 就能触发登记**，
   * >   `registerSubagentStartIfNeeded` **结构上够不到** `mainStartIdOf`，
   * >   所以「查分配表」这个判据**看不见它**。」
   *
   * ## 为什么我上一版看不见它（如实记录）
   *
   * 我的判据是「分配表有没有被写入」—— 而写入只证明 `resolveSubagentParent` 接上了，
   * **完全不经过 `mainStartIdOf`**（它的消费点在 `decideSubagentStart` 里，见
   * `officeace-lock.ts:573`）。⇒ 判据与观测点**没对上**。
   *
   * ## 正确观测点：**凭据读取顺序的首位**
   *
   * officeace 锁定态逐个 `readCredential`，第一个成功的就返回：
   *
   * ```
   * const accounts = orderAccountsForSubagent(deps.accounts(), sessionId)  // ← 顺序在这被改
   * for (const account of accounts) { const c = await deps.readCredential(...) ; if (c) return c }
   * ```
   *
   * ⇒ 「第一个被读的 ref」= **遍历顺序首位** = `decideSubagentStart` 算出的起点。
   *
   * ## 上游试过、没补成的原因（我这次能成，靠修掉它）
   *
   * > 「我写了一条……用例，跑出来起点是 `undefined`。
   * >   追下去发现：`if (!isSubagentHere) return accounts` —— 分配表空 ⇒ 整段跳过。
   * >   **登记是 fire-and-forget，第一次调用时表还空** ⇒ 这是时序问题。」
   *
   * ⚠️ 我这次发现「起点 undefined」**还有第二个成因**（上游那轮没走到这步）：
   *
   * `officeace-auth.ts:725` 的 `readCredential` 只在
   * `typeof parsed.modelAppKey === 'string' && length > 0` 时返回凭据，
   * 否则**回落本机文件** ⇒ 单测里恒 `undefined` ⇒ 判「凭据读不出来」。
   *
   * ⇒ **两个成因叠加**才让上游以为「测不出来」。修掉 `modelAppKey` 后，
   *   **第一拍就能观测到起点**（实测 `R-oa3`），不必等第二拍。
   */
  it('★★★ 装配层②：officeace 的 mainStartIdOf 必须真的被接上（观测遍历顺序首位）', async () => {
    const { ctx, llm } = applyOnce()
    const pool = realPoolOf(ctx)

    const hit = llm.registered.find((r) => r.ids.includes('officeace'))
    expect(hit, '必须有 officeace adapter').toBeDefined()
    const options = hit!.adapter.options as Record<string, unknown>
    const provider = options.credentialProvider as (sid?: string) => Promise<unknown>

    for (const ref of ['R-oa1', 'R-oa2', 'R-oa3']) {
      await pool.addAccount({ id: ref, provider: 'officeace', credentialRef: ref, enabled: true })
    }
    await pool.setSubagentRotation('officeace', { startMode: 'sequence' })
    /** ⚠️ **必须锁定态** —— `mainStartIdOf` 只在这条腿被读（`officeace-lock.ts:573`）。 */
    await pool.setPermanentLocked('officeace', true)

    /**
     * ★ **主代理「实际在用」= 第 2 个号（`R-oa2`）**。
     *
     * 池 `[R-oa1, R-oa2, R-oa3]`、`sequence` slot=0：
     *
     * | 实现 | 起点 | 首位 |
     * |---|---|---|
     * | `mainStartIdOf` **接上**（读实际在用 `R-oa2`）| `(1+1)%3=2` | **`R-oa3`** |
     * | 没接上（退化池首 `R-oa1`）| `(0+1)%3=1` | `R-oa2` |
     *
     * ⇒ **两者不同，可分辨。**
     */
    pool.setActiveAccount('officeace', 'main-1', 'R-oa2')

    injectAgents(ctx, 'child-m', 'main-1')

    /**
     * ⚠️ **观测点 = 错误文案里的账号顺序**。
     *
     * 锁定态在「所有号凭据都读不出来」时抛的文案里，括号内是**逐号 append**：
     *
     * ```
     * OfficeAce：无法确认是否有可用账号。……（R-oa3: 凭据读不出来；R-oa2: …；R-oa1: …）
     * ```
     *
     * ⇒ **括号里的顺序 = `orderAccountsForSubagent` 的输出 = `decideSubagentStart` 算的起点序。**
     *
     * ⚠️ 为什么不 spy `readCredential`（我试过两条路，都不通，如实记录）：
     * 1. `FakeCredentials.resolve` 恒不被调用 —— 真装配下凭据走 `ctx.credentials` 服务链；
     * 2. 给 `options.readCredential` 装 spy 也没用 —— **工厂闭包捕获的是原值**，
     *    `apply()` 之后改 `options` 影响不到已建好的闭包。
     */
    let message = ''
    try {
      await provider('child-m')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    /**
     * ⚠️ officeace 的登记是 **fire-and-forget** ⇒ 让出一拍再断言。
     *    （本判据不依赖登记落表，但让一拍更稳。）
     */
    await new Promise<void>((r) => { setTimeout(r, 30) })

    console.log('  [装配层②] 错误文案:', message.slice(0, 110))

    /** ⚠️ **必须抛** —— 不抛说明路径没走到锁定态（前置失效，判据不可信）。 */
    expect(message, '★★ 锁定态 + 凭据全读不出 ⇒ 必须抛（否则前置没生效）').not.toBe('')

    /** 抽出文案里账号出现的顺序。 */
    const order = Array.from(message.matchAll(/R-oa[0-9]/g)).map((m) => m[0])
    console.log('  [装配层②] 遍历顺序:', order.join(' → '))

    expect(
      order[0],
      '★★★ mainStartIdOf 接上 ⇒ 遍历首位应是 R-oa3（主代理实际在用 R-oa2 往后错开）。'
        + '若得 R-oa2 = 没接上（退化成池首 R-oa1）',
    ).toBe('R-oa3')
  })
})
