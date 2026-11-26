/**
 * `officeace-refresh-all.spec.ts` —— IKLPTZ 的守卫：批量续期对**同步**账号池。
 *
 * ## 被守的缺陷（Gitee issue IKLPTZ，2026-10-14 报障）
 *
 * `refreshAll` 把 `AccountPool.listAccountsByProvider`（**同步**返回数组，
 * 见 `src/account-pool.ts`）当成 Promise 用：
 *
 * ```ts
 * const accounts = await p.listAccountsByProvider('officeace').catch(() => [])
 * ```
 *
 * 数组没有 `.catch` ⇒ 恒抛 `TypeError: ... .catch is not a function`。
 * 该异常被 `src/index.ts` 的 `refreshAllCredentials` 逐 provider `try` 吞成
 * 一条 warn，于是：
 * - **OfficeAce 的批量续期整条失效**（启动首轮 + 每 30 分钟一轮，全灭）；
 * - 症状只有宿主日志里一行「批量续期失败」，**界面零提示**。
 *
 * ⚠️ 同一个误判被**复制了两遍**（`officeace-auth.ts` 的模块导出与
 * `src/index.ts` 的 `officeaceAuthService` 包装，连注释都逐字相同）——
 * 而定时器实际走的是**后者**。故本文件两条路径都要打。
 *
 * ## 为什么既有 49 条守卫全绿却漏掉了它（本文件存在的理由）
 *
 * | 文件 | 为什么没拦住 |
 * |---|---|
 * | `officeace-refresh-guards.spec.ts` | 只驱动 `refreshAccountCredential`，从不调 `refreshAll` |
 * | `refresh-targets-derived.spec.ts` | 用**自己的桩** `authWith()`，不是真实 officeace |
 * | `provider-runtime-wiring.spec.ts` | 只对拍 `refreshAll` 的**键集合**，注释明写「不再逐个驱动」 |
 *
 * ⇒ **真实的 officeace `refreshAll` 从未被执行过一次**，该行在测试里结构上
 * 不可达。本文件的用例①**真跑 `apply()` + 真实注册表**并驱动它。
 *
 * ## ⚠️⚠️ 安全：本文件绝不触碰用户真实凭据
 *
 * `~/.dsh-officeace/session.json` 是**用户真实的华为云凭据**，且其
 * `refresh_token` **一次性** —— 读进来续一次就烧掉，用户被迫重新登录。
 *
 * 两道防线（**都必须保留**）：
 *
 * 1. **进程级目录隔离**：`tests/setup-isolation.ts` 把 `DSH_OFFICEACE_HOME`
 *    指向临时目录。这一条是**主防线**，因为它对 `apply()` 的
 *    fire-and-forget 后台链同样生效（那条链可能在 `afterEach` 之后才跑，
 *    用例自己改 `USERPROFILE` **抢不过**它 —— 实测踩到真实报文
 *    `STS5.1806 has been used`）。
 * 2. **本文件不依赖兜底分支读盘**：所有「空池 / 缺池」用例都**显式注入**
 *    `fallbackRefresh` 替身（见 `refreshAccountList` 的第三参），
 *    故它们既不读文件也不发网络。
 *
 * ## ⚠️ 类型系统为何没拦（防线强度如实标注）
 *
 * 两处都把形参声明为 `unknown` 再**内联断言**收窄，其中返回值写成了
 * `Promise<…>`；断言直接覆盖 `unknown` 的推导结果 ⇒ `tsc` 全程不报错。
 *
 * ⚠️ **本文件不声称「类型系统现在能拦住它」**：`unknown as X` 恒被允许，
 * 重新断言一份 Promise 版本仍可编译通过。真正锁住它的是：
 * ① 用例①/②（行为：真实同步池下不许抛错）；
 * ② 用例⑦（结构：只留**一份**遍历实现，消灭「复制粘贴第二份」这个成因）；
 * ③ 用例⑧（源码：全 `src` 不得出现 Promise 式调用）；
 * ④ 用例⑨（事实：数组**没有** `.catch`，即该误判必然抛）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index.js'
import { clearProviderRuntimes, runtimeOf } from '../../src/provider-runtime.js'
import * as officeaceAuth from '../../src/officeace-auth.js'
import type { OfficeAceRefreshPool } from '../../src/officeace-auth.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * ⚠️ **普查判据**：列出源码里**所有**对 `listAccountsByProvider` 的**引用点**
 * （属性访问 / 元素访问 / 解构），附带调用实参。
 *
 * 与 {@link promiseMisuseLines} 的分工：
 * - 那个问「**怎么写错了**」（模式匹配，对有变体失明）；
 * - 这个问「**有几处在碰它**」（覆盖所有「拿到这个方法」的语法形态）。
 *
 * ## ⚠️ 三种形态都必须覆盖（每一版都漏过一种，都是实测出来的）
 *
 * | 形态 | 只认 `CallExpression` | 只认 `PropertyAccessExpression` | 本条（三种都认） |
 * |---|---|---|---|
 * | `p.listAccountsByProvider(…)` | ✅ | ✅ | ✅ |
 * | `const s = p.listAccountsByProvider`（取引用） | **漏** | ✅ | ✅ |
 * | `p['listAccountsByProvider'](…)`（元素访问） | **漏** | **漏** | ✅ |
 * | `const { listAccountsByProvider } = p`（解构） | **漏** | **漏** | ✅ |
 *
 * ⚠️⚠️ 后两种是**我在本文件里又一次自己打穿自己**的记录：第二版改成
 * 「认 `PropertyAccessExpression`」后，`p['listAccountsByProvider']()` 与
 * 解构**仍然漏**（元素访问的节点是 `ElementAccessExpression`，名字在
 * **字符串字面量**里）。⇒ 现在三种节点一起收，并补 ⑦c 的自检用例覆盖它们。
 *
 * ⚠️ 用 AST 而不是正则：正则要处理 `?.` / `!` / 跨行 / 注释，实测会漏。
 */
function listAccountsByProviderSites(
  text: string,
  fileName = 'source.ts',
): Array<{ line: number; arg: string }> {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true)
  const sites: Array<{ line: number; arg: string }> = []
  const NAME = 'listAccountsByProvider'

  /** 节点是否位于某个 `CallExpression` 的 callee 位置（用来取实参 / 标「取引用」）。 */
  const argOfCallee = (node: ts.Node): string | undefined => {
    const parent = node.parent
    if (ts.isCallExpression(parent) && parent.expression === node) {
      return parent.arguments[0]?.getText(sf) ?? '(无参数)'
    }
    return undefined
  }

  const push = (node: ts.Node): void => {
    const arg = argOfCallee(node) ?? '(取方法引用/解构)'
    sites.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, arg })
  }

  /** 取元素访问的**静态**字符串键：`p['x']` / `p["x"]` / ``p[`x`]``（无插值）。 */
  const staticKeyOf = (node: ts.Expression): string | undefined => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    return undefined
  }

  const visit = (node: ts.Node): void => {
    // ① 属性访问：`p.listAccountsByProvider`
    if (ts.isPropertyAccessExpression(node) && node.name.text === NAME) push(node)
    // ② 元素访问：`p['listAccountsByProvider']`
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression === undefined ? undefined : staticKeyOf(node.argumentExpression)
      if (key === NAME) push(node)
    }
    // ③ 解构：`const { listAccountsByProvider } = p`（含改名写法）
    if (ts.isBindingElement(node)) {
      const prop = node.propertyName ?? node.name
      if (ts.isIdentifier(prop) && prop.text === NAME) push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}

/**
 * ⚠️ **判据本体**：用 TypeScript 解析器找出「把 `listAccountsByProvider`
 * 当 Promise 用」的节点，返回**行号**（1 基）。
 *
 * 判定的节点形状（依次剥掉 `!` 与外层括号后）：
 *
 * ```
 * CallExpression( callee = PropertyAccess( name = catch|then,
 *     expression = CallExpression( callee = PropertyAccess( name = listAccountsByProvider ) ) ) )
 * ```
 *
 * ⚠️ **必须走 AST，不能走正则**：正则版本被实测证伪三次（`!` / `?.` / 跨行
 * 全漏，详见用例⑧的注释）。AST 天然不受换行、修饰符、注释影响 ——
 * 与 `tests/helpers/source-scope.ts` 放弃字符串切片是同一个理由。
 *
 * ⚠️ **不要**改成「先在文本里 indexOf」的混合写法：那会把注释里的诱饵
 * （本仓库多处注释在解释这个缺陷）重新算进来。
 */
function promiseMisuseLines(text: string, fileName = 'source.ts'): number[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true)
  const hits: number[] = []

  /** 剥掉 `!`（NonNullExpression）与外层括号，露出真正的表达式。 */
  const unwrap = (node: ts.Node): ts.Node => {
    let current = node
    for (;;) {
      if (ts.isNonNullExpression(current)) { current = current.expression; continue }
      if (ts.isParenthesizedExpression(current)) { current = current.expression; continue }
      return current
    }
  }

  /** 该表达式是否为 `… .catch` / `… .then` 的属性访问，且目标是 `listAccountsByProvider(...)`。 */
  const isPromiseStyle = (node: ts.Node): boolean => {
    if (!ts.isCallExpression(node)) return false
    const callee = unwrap(node.expression)
    if (!ts.isPropertyAccessExpression(callee)) return false
    const method = callee.name.text
    if (method !== 'catch' && method !== 'then') return false
    const inner = unwrap(callee.expression)
    if (!ts.isCallExpression(inner)) return false
    const innerCallee = unwrap(inner.expression)
    return ts.isPropertyAccessExpression(innerCallee)
      && innerCallee.name.text === 'listAccountsByProvider'
  }

  const visit = (node: ts.Node): void => {
    if (isPromiseStyle(node)) {
      hits.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

// ────────────────── 宿主服务替身（与 provider-runtime-wiring 同款） ──────────────────

class FakeCredentials {
  async resolve(): Promise<undefined> { return undefined }
  async describe() { return { configured: false, writable: true } }
  async set(): Promise<void> {}
  async unset(): Promise<void> {}
}
class FakeCommands { register() { return () => {} } }
class FakeLlm {
  registerConfigurableProviders() { return { replace: () => {} } }
  registerAdapter() { return { replace: () => {} } }
  async listModels(): Promise<never[]> { return [] }
}
class FakeSettings {
  register(): void {}
  describe(): Array<{ ns: string }> { return [] }
}

/**
 * 跑一次**真实 `apply()`**（含注册表注册），返回 ctx。
 *
 * ⚠️ **必须先清空注册表**：`provider-runtime.ts` 的 Map 是模块级的，
 * 而 `apply()` 每次建一批新 auth 实例 —— 不清空则第二次注册被跳过，
 * `runtimeOf()` 指向**上一个 ctx** 的实例，断言会以莫名其妙的方式失败。
 */
function applyOnce(): Context {
  clearProviderRuntimes()
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', new FakeCommands() as never)
  ctx.provide('llm', new FakeLlm() as never)
  ctx.provide('settings', new FakeSettings() as never)
  apply(ctx)
  return ctx
}

/**
 * 造一个**与 `AccountPool` 真实签名一致**的池：`listAccountsByProvider`
 * **同步**返回数组。
 *
 * ⚠️ 这正是缺陷的触发条件。写成 `async` 会让旧实现「看起来正常」⇒
 * 用例变成**测不到目标**的假绿（旧代码 `await` + `.catch` 都能过）。
 * ⇒ 本函数**绝不能**标 `async`，这条有注释守着，别改。
 */
function syncPool(accounts: Array<{ id: string; credentialRef: string; enabled?: boolean }>) {
  const listAccountsByProvider = vi.fn((_provider: string) => accounts)
  return { listAccountsByProvider, pool: { listAccountsByProvider } }
}

/** 取回真实注册表里 officeace 的 `refreshAll`（生产定时器走的就是它）。 */
function officeaceRefreshAll(): (pool: unknown) => Promise<void> {
  const runtime = runtimeOf('officeace')
  expect(runtime?.auth?.refreshAll, 'officeace 没挂 auth.refreshAll ⇒ 该家永不自动续期').toBeTypeOf('function')
  return runtime!.auth!.refreshAll as (pool: unknown) => Promise<void>
}

/**
 * ⚠️ **兜底分支的替身**：`refreshAccountList` 的第三参。
 *
 * 生产默认值是 `refreshStoredCredential`（会读 `~/.dsh-officeace/session.json`）。
 * 用例里一律注入本替身 ⇒ 「空池」这些分支**既不读盘也不发网络**。
 */
function fallbackSpy(): () => Promise<unknown> {
  return vi.fn(async () => undefined)
}

/**
 * ⚠️ **真实用户 home 的快照**（在 `beforeEach` 改写 `USERPROFILE` **之前**取）。
 *
 * 用例⑩c 需要它来**主动撤掉第二道防线**：把 `USERPROFILE` 指回真实 home，
 * 从而把「env 覆盖是否真的生效」单独隔离出来测。
 *
 * ⚠️ 必须在本文件**顶层**求值 —— 那时 `setup-isolation.ts` 只设了
 * `DSH_OFFICEACE_HOME`，尚未碰 `USERPROFILE`。
 */
const realUserHome = homedir()

/**
 * ⚠️⚠️ **消费掉 fire-and-forget 的后台链**（本文件的安全前提）。
 *
 * `apply()` 内部会 `void refreshAllCredentials()`，那是一条**不 await** 的
 * 首轮续期。它可能在用例结束、`afterEach` 恢复环境**之后**才跑到
 * OfficeAce 的兜底分支。故本文件：
 * ① 依赖 `setup-isolation.ts` 的 `DSH_OFFICEACE_HOME` 进程级隔离（主防线）；
 * ② 每个用例结束前先让出两拍，把可能挂起的后台链**跑完再退出**，
 *    避免它跨用例泄漏（也让失败发生在**本用例**里而不是随机别处）。
 */
async function drainBackground(): Promise<void> {
  // 两拍：apply() 的首轮链有若干 `await`（读池 → 逐账号续期 → 兜底）。
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

let savedProfile: string | undefined
let savedHome: string | undefined

beforeEach(() => {
  savedProfile = process.env.USERPROFILE
  savedHome = process.env.HOME
  // ⚠️ 第二道防线（对 `os.homedir()` 生效）。主防线是
  //    `setup-isolation.ts` 的 `DSH_OFFICEACE_HOME` —— 那条对后台链也有效。
  process.env.USERPROFILE = process.env.DSH_OFFICEACE_HOME ?? savedProfile
  process.env.HOME = process.env.DSH_OFFICEACE_HOME ?? savedHome
})

afterEach(async () => {
  await drainBackground()
  clearProviderRuntimes()
  vi.restoreAllMocks()
  if (savedProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedProfile
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
})

// ────────────────────────── 行为用例 ──────────────────────────

describe('★ IKLPTZ 回归：批量续期对**同步**账号池（真实 apply() + 真实注册表）', () => {
  it('① 定时器那份 refreshAll：同步池 ⇒ 不抛错，且**每个**账号各续一次（打到自己的 ref）', async () => {
    const ctx = applyOnce()
    const service = ctx.officeaceAuth as unknown as { refreshAccountCredential: unknown }
    // ⚠️ 布桩在 ctx 上的实例：index.ts 的包装必须走**本对象的**方法。
    //    若有人改成直接调模块函数，这里收不到 ⇒ 用例变红。
    const spy = vi.spyOn(service as never, 'refreshAccountCredential' as never)
      .mockResolvedValue(undefined as never)

    const { pool } = syncPool([
      { id: 'officeace-a', credentialRef: 'OFFICEACE_ACCOUNT_A' },
      { id: 'officeace-b', credentialRef: 'OFFICEACE_ACCOUNT_B' },
    ])

    // ⚠️ 缺陷版在这里抛 `TypeError: ... .catch is not a function`。
    //    `.resolves` 让「抛错」变成一条**点名**的失败，而不是未捕获异常。
    await expect(officeaceRefreshAll()(pool), '同步池下不得抛错（数组没有 .catch）')
      .resolves.toBeUndefined()

    expect(
      spy.mock.calls.map((call) => [call[0], call[2]]),
      '必须逐个账号续期，且每个都用自己的 ref/id（少一个 ⇒ 那个账号永不自愈）',
    ).toEqual([
      ['OFFICEACE_ACCOUNT_A', 'officeace-a'],
      ['OFFICEACE_ACCOUNT_B', 'officeace-b'],
    ])
    // ⚠️ 池必须原样透传下去：漏传 ⇒ 续期成功后 `expiresAt` 回写不了，
    //    卡片有效期永远停在旧值（AGENTS.md「续期三件事」第 3 条）。
    expect(spy.mock.calls[0]?.[1], '池必须透传给 refreshAccountCredential').toBe(pool)
  })

  /**
   * ⚠️ 本条**不能**用 `vi.spyOn(officeaceAuth, 'refreshAccountCredential')`：
   * ESM 命名空间对象的导出是 **getter-only**，spy 会抛
   * `Cannot redefine property`（本仓库已有记载：`officeace-service-shape.spec.ts`
   * 的 ④ 就是为这个形状写的 —— 故生产才用 `{ ...officeaceAuth }` 复制一份）。
   *
   * ## ⚠️⚠️ 判据必须包含「**真的有账号被续期**」（2026-10-14 复审实测的缺口）
   *
   * 第一版只断言「不抛错」+「读过池」。复审用一个变异打穿了它：把模块
   * `refreshAll` 改成「读了池但**一个账号都不续**」⇒ **整个文件当时 11 条全绿**。
   * 也就是说那份实现静默失效时无人报警 —— 与它想守的「两处曾逐字复制」
   * 恰好错位（要守的正是「模块导出那份也能干活」）。
   *
   * ## 观测点怎么选（为什么不用 credentials 桩）
   *
   * ⚠️ 模块导出的 `refreshAll` 给 `refreshAccountCredential` 只传 3 个实参
   * （**没有 `credentials`**）⇒ 内部 `readCredential(ref, undefined)` 走的是
   * 「兼容文件」腿：读 `storeDir()` 下**该 ref 自己的** `session-<ref>.json`
   * （这正是它与 `index.ts` 那份的语义差异，也是必须保留它的理由）。
   * ⇒ 传 `credentials` 桩**观测不到任何东西**（第一版就是这么写的）。
   *
   * 故本条改为在**隔离后的** `DSH_OFFICEACE_HOME` 下，给**每个账号各放一份**
   * 「距过期还远」的 `session-<ref>.json`：
   * - lead-time 判据命中「无需续期」⇒ **一个网络请求都不发**；
   * - 但「本轮不刷」分支**仍必须对账池值**（AGENTS.md 铁律）⇒ 每个账号各调一次
   *   `pool.updateAccount(accountId, …)`。
   *
   * 「每账号一次 updateAccount」因此是**无网络、可观测**的续期证据。
   *
   * ## ⚠️⚠️ 桩数据必须**逐账号一份**（Gitee issue IKM741 连带修正，2026-10-16）
   *
   * 本条原先只在目录里放**一份全局** `session.json`，两个账号（C/D）都靠它兜底
   * —— 那正是 issue IKM741 的缺陷形态本身：`readCredential` 的兜底**漏传 `ref`**
   * ⇒ 所有「库里没有凭据」的账号都读到**同一份**别人的凭据（读数串号；
   * 遇到 `refresh_token` 还会跨账号烧掉一次性 token）。
   * 修好兜底后本条立刻变红 —— **红因是桩依赖了缺陷**，不是判据变弱。
   * ⇒ 改为逐账号写 `session-<ref>.json`，判据一字未改。
   */
  it('② 模块导出的 refreshAll 不得抛错，**且逐个账号都走到续期**（比对账池值观测）', async () => {
    const dir = process.env.DSH_OFFICEACE_HOME
    expect(dir, 'DSH_OFFICEACE_HOME 未隔离，本条会去碰用户真实凭据，拒绝执行').toBeDefined()

    // 距过期 2 小时 ⇒ 落在 lead-time 窗口外 ⇒ 不续期、但仍对账（零网络）。
    // ⚠️ **逐账号一份**（见上方 IKM741 说明）：共用一份会让两个账号读到同一个
    //    凭据 —— 那既是串号形态，也会让本条的观测点变成「全局兜底在工作」。
    const credentialOf = (ref: string) => ({
      modelAppKey: `probe-key-${ref}`,
      modelAppSecret: `probe-secret-${ref}`,
      maasBaseUrl: 'https://example.invalid',
      access: 'a', secret: 's', securityToken: 't', projectId: 'p',
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      refreshToken: `probe-refresh-${ref}`,
      dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
    })
    writeFileSync(
      join(dir, 'session-OFFICEACE_ACCOUNT_C.json'),
      JSON.stringify(credentialOf('OFFICEACE_ACCOUNT_C')), 'utf8',
    )
    writeFileSync(
      join(dir, 'session-OFFICEACE_ACCOUNT_D.json'),
      JSON.stringify(credentialOf('OFFICEACE_ACCOUNT_D')), 'utf8',
    )

    const updated: Array<string | undefined> = []
    const listAccountsByProvider = vi.fn(() => [
      { id: 'officeace-c', credentialRef: 'OFFICEACE_ACCOUNT_C' },
      { id: 'officeace-d', credentialRef: 'OFFICEACE_ACCOUNT_D' },
    ])
    const pool = {
      listAccountsByProvider,
      updateAccount: async (id: string) => { updated.push(id) },
    }

    // 单测绝不发网络：任何 fetch 都是缺陷。
    const fetchSpy = vi.fn(() => { throw new Error('本用例不得发网络请求') })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(
      officeaceAuth.refreshAll(pool as never),
      '模块级 refreshAll 也曾把同步池当 Promise',
    ).resolves.toBeUndefined()

    expect(listAccountsByProvider, '必须真的按 provider 取账号列表').toHaveBeenCalledWith('officeace')
    // ⚠️ **核心**：两个账号都必须被**逐个**处理（「只读池不干活」的版本在此红）。
    expect(updated, '模块级 refreshAll 必须逐个账号走到续期/对账（只读池的版本会在此红）')
      .toEqual(['officeace-c', 'officeace-d'])
    expect(fetchSpy, '有效期内不得发任何请求（lead-time 判据）').not.toHaveBeenCalled()
  })

  it('③ 池里没有账号 ⇒ 退化为续期本机凭据（注入替身，不碰盘/不联网），且不抛错', async () => {
    const { pool } = syncPool([])
    const refreshOne = vi.fn(async () => {})
    const fallback = fallbackSpy()

    await expect(
      officeaceAuth.refreshAccountList(pool as never, refreshOne, fallback),
      '空池是正常态（尚未登录），不得抛错',
    ).resolves.toBeUndefined()

    expect(refreshOne, '没有账号时不该凭空续期').not.toHaveBeenCalled()
    expect(fallback, '空池必须走兜底续期（老用户兼容路径）').toHaveBeenCalledTimes(1)
  })

  it('④ `listAccountsByProvider` 缺失（单测桩不完整）⇒ 走同一条兜底，不抛错', async () => {
    const refreshOne = vi.fn(async () => {})
    const fallback = fallbackSpy()

    await expect(officeaceAuth.refreshAccountList({}, refreshOne, fallback)).resolves.toBeUndefined()

    expect(refreshOne).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('⑤ 同步读池**抛错**（存储抖动）⇒ 不阻断整轮续期，按空池兜底', async () => {
    const refreshOne = vi.fn(async () => {})
    const fallback = fallbackSpy()
    const pool = {
      listAccountsByProvider: () => { throw new Error('storage blip') },
    }

    // ⚠️ 语义选择：读池失败**不得**让整条 provider 从续期表里消失
    //    （那正是 IKLPTZ 的可观测症状）。按空池兜底 = 至少不抛。
    //
    // ⚠️ **必须断言真的走了兜底**（2026-10-14 复审实测的缺口）：第一版只有
    //    `.resolves` + 「refreshOne 未被调用」，于是把 catch 分支改成静默
    //    `return`（**不走兜底**）用例**仍绿** —— 那正好把本条声称的语义测丢了。
    await expect(officeaceAuth.refreshAccountList(pool, refreshOne, fallback)).resolves.toBeUndefined()
    expect(refreshOne).not.toHaveBeenCalled()
    expect(fallback, '读池抛错必须归入「空池兜底」，而不是静默返回').toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️⚠️ **⑤b：`Promise` 形态的池必须与数组池等效**（对抗性审计打穿后新增）。
   *
   * 第一版实现按「**只接受同步**」写（直接 `for…of accounts`）。审计实测那引入了
   * 一个**新的行为回归**：
   *
   * | 池返回 | 修复前 `await ….catch(…)` | 第一版新代码 |
   * |---|---|---|
   * | Promise（resolved 数组） | 逐个续期（`await` 到了数组） | **抛 `TypeError: accounts is not iterable`** |
   * | Promise（rejected） | 吞成 `[]` ⇒ 兜底 | **同上抛错，且兜底也不走** |
   *
   * ⇒ 本条把「两种形态等效」钉住：**生产池是同步的**，但兼容 Promise 形态不是
   * 可有可无 —— 收紧它等于把「能用」变成「抛错」。
   */
  it('⑤b `Promise` 形态的池必须与数组池**等效**（不得抛 accounts is not iterable）', async () => {
    // resolved Promise ⇒ 与数组池一样：逐个续期。
    const refreshOne = vi.fn(async () => {})
    const fallback = fallbackSpy()
    const asyncPool = {
      listAccountsByProvider: async () => [
        { id: 'officeace-p1', credentialRef: 'OFFICEACE_ACCOUNT_P1' },
        { id: 'officeace-p2', credentialRef: 'OFFICEACE_ACCOUNT_P2' },
      ],
    }

    await expect(
      officeaceAuth.refreshAccountList(asyncPool, refreshOne, fallback),
      'Promise 池在修复前是能工作的 —— 收紧成「只接受同步」会造出新的回归',
    ).resolves.toBeUndefined()

    expect(refreshOne.mock.calls.map((c) => c[0].id)).toEqual(['officeace-p1', 'officeace-p2'])
    expect(fallback, 'resolved Promise 有账号时不该走兜底').not.toHaveBeenCalled()

    // rejected Promise ⇒ 与「同步抛错」同处理：归入兜底、不抛。
    const rejectedPool = {
      listAccountsByProvider: async () => { throw new Error('async blip') },
    }
    const fallback2 = fallbackSpy()
    await expect(
      officeaceAuth.refreshAccountList(rejectedPool, vi.fn(async () => {}), fallback2),
      'rejected Promise 不得逃逸（修复前是被 .catch 吞掉的）',
    ).resolves.toBeUndefined()
    expect(fallback2, 'rejected Promise 必须归入空池兜底').toHaveBeenCalledTimes(1)

    // 空数组 Promise ⇒ 兜底。
    const emptyAsyncPool = { listAccountsByProvider: async () => [] }
    const fallback3 = fallbackSpy()
    await officeaceAuth.refreshAccountList(emptyAsyncPool, vi.fn(async () => {}), fallback3)
    expect(fallback3).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️ **⑤c：非数组形状归入兜底、不抛 `TypeError`**（刻意的行为变更，已登记）。
   */
  it('⑤c 池返回**非数组**（形状不符）⇒ 归入空池兜底，不抛 TypeError', async () => {
    const refreshOne = vi.fn(async () => {})
    const fallback = fallbackSpy()
    const weirdPool = { listAccountsByProvider: () => ({ not: 'an array' }) }

    await expect(
      officeaceAuth.refreshAccountList(weirdPool as never, refreshOne, fallback),
      '形状不符不该让整条 provider 从续期表里消失（那与 IKLPTZ 的症状同形）',
    ).resolves.toBeUndefined()

    expect(refreshOne).not.toHaveBeenCalled()
    expect(fallback, '非数组必须归入兜底').toHaveBeenCalledTimes(1)
  })

  it('⑥ 不得按 `enabled` 过滤：停用账号照旧续期（AGENTS.md 铁律）', async () => {
    const { pool } = syncPool([
      { id: 'on', credentialRef: 'OFFICEACE_ACCOUNT_ON', enabled: true },
      { id: 'off', credentialRef: 'OFFICEACE_ACCOUNT_OFF', enabled: false },
    ])
    const refreshOne = vi.fn(async () => {})

    await officeaceAuth.refreshAccountList(pool as never, refreshOne, fallbackSpy())

    // 停用只影响「自动选号」，与「凭据是否需要保持新鲜」无关 ——
    // 按 enabled 过滤会让停用期间的 refresh_token 一路放到失效。
    expect(refreshOne.mock.calls.map((c) => c[0].id)).toEqual(['on', 'off'])
  })

  it('⑥b 兜底续期**抛错**也不上抛（批量续期绝不因单个兜底失败而中断整轮）', async () => {
    const { pool } = syncPool([])
    const fallback = vi.fn(async () => { throw new Error('STS down') })

    await expect(
      officeaceAuth.refreshAccountList(pool as never, vi.fn(async () => {}), fallback),
      '兜底失败必须被吞掉 —— 否则整轮续期会中断其余 provider',
    ).resolves.toBeUndefined()
  })
})

// ────────────────────────── 防复发（结构 / 类型 / 源码） ──────────────────────────

describe('IKLPTZ 防复发：结构与类型的判据', () => {
  /**
   * ⚠️⚠️ **本条是「消灭成因」而不是「再测一遍现象」**。
   *
   * IKLPTZ 之所以要修两处，是因为 `src/index.ts` 把模块里的遍历逻辑
   * **逐字抄了一份**（连注释都一样）。只修一处 ⇒ 另一处继续静默失效。
   * ⇒ 结构上断言：index.ts 的 `refreshAll` **委托** `refreshAccountList`，
   * 且 index.ts 自己不再直接读 officeace 的账号列表。
   */
  it('⑦ index.ts 的 refreshAll 委托 refreshAccountList，不再自带第二份遍历', () => {
    const source = readFileSync(join(import.meta.dirname, '../../src/index.ts'), 'utf8')

    expect(
      source,
      'index.ts 的 refreshAll 必须委托 officeaceAuth.refreshAccountList'
      + '（复制第二份遍历正是 IKLPTZ 的成因：一个 bug 要修两处）',
    ).toMatch(/refreshAll:\s*\(pool[^)]*\)\s*=>\s*officeaceAuth\.refreshAccountList\(/)

    // 反面：index.ts 里不得再直接读池取 officeace 账号。
    // ⚠️ 但 `credentialProvider` / `refresh` 那两处**合法**使用
    //    `listAccountsByProvider(OFFICEACE.id)`（取第一个启用账号）——
    //    故判据限定为**字面量 'officeace'**，不误伤那两处。
    expect(
      source,
      'index.ts 不该自己遍历 officeace 账号 —— 只允许存在于 officeace-auth.ts 的 refreshAccountList',
    ).not.toMatch(/listAccountsByProvider\(\s*['"]officeace['"]\s*\)/)
  })

  /**
   * ⚠️⚠️ **本文件最强的结构防线：`src/` 里取 officeace 账号的调用点**普查**。**
   *
   * ## 为什么它比 ⑧（模式匹配）强（2026-10-14 对抗性审计打穿 ⑧ 后补）
   *
   * 审计实测 ⑧ 的 AST 判据只认「`.catch` 的 receiver **直接**是
   * `listAccountsByProvider(...)`」，于是**四种间接写法全失明**（都真的写进
   * `src/` 跑过、⑧ 全绿）：
   *
   * ```ts
   * (await p.listAccountsByProvider('x')).catch(…)      // 运行时 TypeError
   * const r = p.listAccountsByProvider('x'); r.catch(…) // 运行时 TypeError
   * const s = p.listAccountsByProvider; s('x').catch(…) // 运行时 TypeError
   * const list = q => q.listAccountsByProvider('x'); list(p).catch(…)  // ← 最像重构
   * ```
   *
   * ⚠️ 第四种「抽个本地 helper 再挂 `.catch`」正是**重构时最自然的写法**，
   * 而 IKLPTZ 的成因**本来就是复制粘贴/抽取** ⇒ 模式匹配对它的**变体**天然失明。
   * 想穷举所有间接写法是**不可判定**的（要数据流分析）。
   *
   * ⇒ 换一条**可判定**且更本质的判据：**数调用点**。
   * IKLPTZ 的成因是「有人**再写一份**遍历」—— 而任何一份新遍历都**必然**
   * 要调一次 `listAccountsByProvider`。故把「`src/` 里取 officeace 账号的调用点
   * 集合」钉成一个**显式清单**，新增即红，**与写法无关**。
   *
   * ⚠️ 顺手覆盖 ⑦ 的字面量判据（改用 `OFFICEACE.id` 常量绕过它的写法，
   * 在本条下**照样红** —— 参数文本会被打印出来对拍）。
   *
   * ## ⚠️ 期望值是**实测出来的**，不是推出来的
   *
   * 现在恰好 3 处，且**性质不同**（别把它们合并成一个数字，否则「新增一处、
   * 删掉一处」会互相抵消而恒绿）：
   *
   * | 位置 | 参数 | 性质 |
   * |---|---|---|
   * | `officeace-auth.ts`（`refreshAccountList` 内） | `'officeace'` | **唯一**的批量遍历 ✔ |
   * | `index.ts` `credentialProvider` | `OFFICEACE.id` | 合法：取**单个**账号的 ref |
   * | `index.ts` `refresh` 兜底 | `OFFICEACE.id` | 合法：取**第一个启用**账号 |
   *
   * ⇒ 判据 = 「**恰好一处**参数是字面量 `'officeace'`（批量遍历），
   * 且它必须在 `officeace-auth.ts` 里」+ 「字面量 `OFFICEACE.id` 的恰好两处、
   * 都在 index.ts」。新增第三处 ⇒ 红。
   */
  it('⑦b ★普查：src/ 里取 officeace 账号的调用点与**性质**都必须匹配清单（新增即红）', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) files.push(full)
      }
    }
    walk(join(import.meta.dirname, '../../src'))
    expect(files.length, '没扫到 src 源码 ⇒ 下面的普查恒空，是空洞断言').toBeGreaterThan(30)

    const sites: string[] = []
    for (const file of files) {
      const rel = file.replace(/\\/g, '/').split('/src/')[1] ?? file
      for (const site of listAccountsByProviderSites(readFileSync(file, 'utf8'), file)) {
        if (!/^['"]officeace['"]$|^OFFICEACE\.id$/.test(site.arg)) continue
        sites.push(`${rel}:${site.line}  arg=${site.arg}`)
      }
    }

    // ⚠️ 防空洞：普查函数本身要能工作（否则恒空 ⇒ 用例恒绿）。
    expect(
      listAccountsByProviderSites(
        "const a = pool.listAccountsByProvider('officeace')",
        'probe.ts',
      ),
      '普查函数失效（连最普通的调用都数不到）—— 这条用例就成了空洞断言',
    ).toHaveLength(1)

    // ① 批量遍历：**恰好一处**，参数是字面量 'officeace'，且在 officeace-auth.ts 里。
    const traversals = sites.filter((s) => s.includes("arg='officeace'"))
    expect(
      traversals,
      '★ 批量遍历（参数为字面量 \'officeace\'）必须**恰好 1 处**，位于 officeace-auth.ts 的 refreshAccountList 内。'
      + '多出来的那处 = 有人**又写了一份遍历**，而 IKLPTZ 的成因正是这个。'
      + `（officeace 相关调用点全集：${JSON.stringify(sites)}）`,
    ).toHaveLength(1)
    expect(traversals[0], '唯一那处批量遍历必须在 officeace-auth.ts 里').toMatch(/^officeace-auth\.ts:/)

    /**
     * ② officeace 账号调用点：**恰好 3 处**，都在 `index.ts`。
     *
     * | # | 位置 | 性质 |
     * |---|---|---|
     * | 1 | `credentialProvider` | 取凭据 |
     * | 2 | `refresh` 兜底 | 取凭据 |
     * | 3 | `resolveOfficeAceCredential` 的子代理接线（2026-11-26 第四轮审计 P0-B）| **枚举候选 id** 给 `decideSubagentStart` |
     *
     * ⚠️ 第 3 处**不是**「又一份遍历账号取凭据」—— 它是 `decideSubagentStart` 必需的
     * `candidateIds`，与 codearts 腿（`index.ts:1555` 同一形态）一致。
     * 那个函数只读 `a.enabled` / `a.id`，**不取凭据、不发请求**。
     *
     * ⇒ 本守卫的语义应表述为「**取凭据**的调用点 2 处 + **枚举候选**的 1 处」，
     *   而不是「总共 2 处」。再新增仍须停下来确认。
     */
    const singleLookups = sites.filter((s) => s.includes('arg=OFFICEACE.id'))
    expect(
      singleLookups,
      '★ officeace 账号调用点必须恰好 3 处（2 处取凭据 + 1 处枚举候选给 decideSubagentStart）。'
      + '再新增 ⇒ 停下来确认它是不是又一份遍历；减少 ⇒ 确认没把按需续期/子代理接线打挂。'
      + `（全集：${JSON.stringify(sites)}）`,
    ).toHaveLength(3)
    for (const site of singleLookups) {
      expect(site, '单账号取用应当都在 index.ts').toMatch(/^index\.ts:/)
    }
  })

  /**
   * ⚠️ **全 `src` 范围的源码判据**：任何把 `listAccountsByProvider` 当 Promise 的
   * **直接**用法（`.catch` / `.then`）都不允许。
   *
   * ## ⚠️⚠️ 这是**辅助**防线，不是主力（2026-10-14 对抗性审计打穿后如实降级）
   *
   * | 版本 | 判据 | 实测结果 |
   * |---|---|---|
   * | 第一版 | **逐行正则** | `!` / `?.` / 跨行 **全漏**（三种写法都实测过） |
   * | 放宽正则 `[!?]?` | 只修好两种，`?.` 仍漏 | 我实测过 |
   * | 第二版（本条） | **AST 直接形状** | 上述三种**已修**；但**四种间接写法仍漏** |
   *
   * ⚠️ 审计实测的四种**间接**写法（都真写进 `src/` 跑过，本条**全绿**）：
   *
   * ```ts
   * (await p.listAccountsByProvider('x')).catch(…)          // 运行时 TypeError
   * const r = p.listAccountsByProvider('x'); r.catch(…)     // 运行时 TypeError
   * const s = p.listAccountsByProvider; s('x').catch(…)     // 运行时 TypeError
   * const list = q => q.listAccountsByProvider('x'); list(p).catch(…)  // ← 最像重构的写法
   * ```
   *
   * 穷举所有间接写法需要**数据流分析**，用模式匹配做**不可判定**。
   * 故**主力防线换成 ⑦b 的调用点普查**（可判定：「再写一份遍历」必然新增一个
   * `listAccountsByProvider` 调用点）。本条保留为**廉价的即时反馈**：
   * 它能在**直接**写错时就地报出文件与行号，覆盖普查抓不到的那类（在**已有**
   * 调用点上追加 `.catch`，调用点数量不变）。
   *
   * ⚠️ **别再把它当主力、也别删**：两条互补 —— ⑦b 管「新增一份遍历」，
   * 本条管「给已有调用点挂错方法」。
   */
  it('⑧ src 下不得把 listAccountsByProvider **直接**当 Promise 用（AST；间接写法见 ⑦b）', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) files.push(full)
      }
    }
    walk(join(import.meta.dirname, '../../src'))
    // ⚠️ 防空洞断言：扫不到文件时下面的循环恒空、用例恒绿。
    expect(files.length, '没扫到 src 源码 ⇒ 循环恒空，是空洞断言').toBeGreaterThan(30)

    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const line of promiseMisuseLines(text, file)) {
        offenders.push(`${file.replace(/\\/g, '/')}:${line}`)
      }
    }
    expect(
      offenders,
      'listAccountsByProvider 是**同步**方法（返回数组），数组没有 .catch/.then —— '
      + 'IKLPTZ 就是这么炸的（TypeError 被上层吞成一条 warn，界面零提示）',
    ).toEqual([])
  })

  /**
   * ⚠️ **上面那条用例的判据本体**，同时被本文件的自检用例驱动。
   *
   * 抽出来是为了**能对判据本身做变异验证**（见下一条用例）：
   * 一条「永远返回空数组」的判据会让 ⑧ 恒绿 —— 那是典型的空洞守卫。
   */
  it('⑧b 判据自检：四种绕过写法都必须命中（防「判据恒空」的空洞守卫）', () => {
    const mustCatch = {
      '同行原始写法': "const a = await p.listAccountsByProvider('officeace').catch(() => [])",
      '非空断言 !': "const a = await p.listAccountsByProvider!('officeace').catch(() => [])",
      '可选链 ?.': "const a = await p?.listAccountsByProvider?.('officeace').catch(() => [])",
      '跨行 .catch': "const a = await p.listAccountsByProvider('officeace')\n  .catch(() => [])",
      '跨行 .then': "const a = await p.listAccountsByProvider('officeace')\n  .then((x) => x)",
      '非空断言 + 跨行': "const a = await p.listAccountsByProvider!('officeace')\n  .catch(() => [])",
      '可选链 + 跨行': "const a = await p?.listAccountsByProvider?.('officeace')\n  .catch(() => [])",
    }
    for (const [label, snippet] of Object.entries(mustCatch)) {
      expect(
        promiseMisuseLines(snippet, 'probe.ts'),
        `判据漏检了「${label}」—— 这正是 IKLPTZ 的形状，漏检等于没守`,
      ).toHaveLength(1)
    }

    // 反面：合法用法与注释里的诱饵**不得**误报（否则守卫会因假阳性被删掉）。
    const mustNotCatch = {
      '合法：取单个账号（不挂 catch）': "const all = pool.listAccountsByProvider(OFFICEACE.id).find((e) => e.enabled)",
      '合法：同步 for-of': 'for (const a of pool.listAccountsByProvider(id)) use(a)',
      '注释里的诱饵': "// 别写 p.listAccountsByProvider('x').catch(() => [])",
      '块注释里的诱饵': "/* p.listAccountsByProvider('x').catch(() => []) */",
    }
    for (const [label, snippet] of Object.entries(mustNotCatch)) {
      expect(
        promiseMisuseLines(snippet, 'probe.ts'),
        `判据误报了「${label}」—— 假阳性会让守卫被当成噪声删掉`,
      ).toEqual([])
    }
  })

  /**
   * ⚠️ **普查判据的自检**：`listAccountsByProviderSites` 必须能数到**间接**写法
   * （那正是 ⑧ 的 AST 模式匹配**做不到**的）—— 否则 ⑦b 会说「只有 1 处」而
   * 实际上漏数了新增的第二处，用例变成**空洞断言**。
   *
   * ⚠️ 这一条是 ⑦b 的**证明力来源**：它证明普查函数对「写法」不敏感
   * （只要**调了**这个函数就会被数到，不管怎么包、怎么挂 `.catch`）。
   */
  it('⑦c 普查函数自检：**所有**「拿到该方法」的语法形态都必须被数到', () => {
    const cases = {
      '最普通': "const a = pool.listAccountsByProvider('officeace')",
      '非空断言 + 直接挂 catch': "const a = p.listAccountsByProvider!('officeace').catch(() => [])",
      '可选链 + 跨行': "const a = await p?.listAccountsByProvider?.('officeace')\n  .catch(() => [])",
      '外层括号': "const a = (p.listAccountsByProvider('officeace')).catch(() => [])",
      '赋给变量再挂 catch': "const r = p.listAccountsByProvider('officeace')\nawait r.catch(() => [])",
      '抽进局部 helper': "const list = (q) => q.listAccountsByProvider('officeace')\nawait list(p).catch(() => [])",
      '取到方法再调': "const s = p.listAccountsByProvider\nawait s('officeace').catch(() => [])",
      '常量参数（OFFICEACE.id）': "const a = pool.listAccountsByProvider(OFFICEACE.id)",
      // ⚠️⚠️ 以下三种是**第二版判据的盲区**（我把 ⑦c 补上后才发现的）：
      '★元素访问（字符串键）': "const a = p['listAccountsByProvider']('officeace')",
      '★元素访问 + 挂 catch': "await p['listAccountsByProvider']('officeace').catch(() => [])",
      '★元素访问（模板字面量键）': "const a = p[`listAccountsByProvider`]('officeace')",
      '★解构取方法': 'const { listAccountsByProvider } = p\nawait listAccountsByProvider(\'officeace\')',
      '★解构改名': 'const { listAccountsByProvider: list } = p\nawait list(\'officeace\')',
    }
    for (const [label, snippet] of Object.entries(cases)) {
      const sites = listAccountsByProviderSites(snippet, 'probe.ts')
      expect(
        sites,
        `普查漏数了「${label}」—— 那 ⑦b「恰好 N 处」就成了空洞断言`
        + '（漏数 ⇒ 新增的遍历看不见 ⇒ 守卫形同虚设）',
      ).toHaveLength(1)
    }

    // 反面：注释/字符串里的诱饵不得被数到（否则计数会假红）。
    const decoys = {
      '行注释': "// pool.listAccountsByProvider('officeace')",
      '块注释': "/* pool.listAccountsByProvider('officeace') */",
      '字符串': "const s = \"pool.listAccountsByProvider('officeace')\"",
      // ⚠️ 同名字段但**不是**那个方法（避免误伤无关对象）。
      '无关对象上的同名属性调用': "const a = cache.get('listAccountsByProvider')",
    }
    for (const [label, snippet] of Object.entries(decoys)) {
      expect(listAccountsByProviderSites(snippet, 'probe.ts'), `误数了「${label}」`).toEqual([])
    }
  })

  /**
   * ⚠️ **机制级判据**：把「数组没有 `.catch`」这个**事实**钉住。
   *
   * 不是「某一行写错了」，而是「数组没有那个方法 ⇒ 任何 Promise 式用法必然抛」。
   */
  it('⑨ 同步池返回的是数组（数组没有 .catch ⇒ 这正是 IKLPTZ 抛错的机制）', () => {
    const entry: ProviderAccountEntry = {
      id: 'x', provider: 'officeace', nickname: 'x', enabled: true,
      credentialRef: 'R', createdAt: 0, refreshable: true,
    }
    // ⚠️ 形参类型**允许** Promise（兼容形态，见 ⑤b 与接口注释）——
    //    本条取的是**生产那种同步**实现，故这里 narrowing 到数组。
    const pool: OfficeAceRefreshPool = { listAccountsByProvider: () => [entry] }
    const listed = pool.listAccountsByProvider!('officeace')

    expect(Array.isArray(listed), '生产实现返回数组（同步）').toBe(true)
    expect(listed, '生产实现不得返回 Promise').not.toBeInstanceOf(Promise)
    expect(
      (listed as unknown as { catch?: unknown }).catch,
      '数组没有 .catch —— 这正是 IKLPTZ 抛 TypeError 的机制',
    ).toBeUndefined()
  })

  /**
   * ⚠️⚠️ **安全守卫**：单测环境必须把 OfficeAce 凭据目录隔离到临时目录。
   *
   * 守的是一条**真实事故路径**：`apply()` 的 fire-and-forget 首轮续期会在
   * `afterEach` 之后跑到兜底分支，用真实 home 读用户凭据并真发 STS 请求
   * （其 `refresh_token` 一次性 ⇒ 用户被迫重新登录）。
   *
   * ## ⚠️ 两半都要守（2026-10-14 复审实测的缺口）
   *
   * 第一版**只断言进程环境变量被设置**。复审用一个变异打穿了它：把
   * `storeDir()` 改成**不读** `DSH_OFFICEACE_HOME`（仍走 `os.homedir()`）
   * ⇒ 用例⑩**仍绿** —— 因为「setup 设了变量」这半仍然成立。
   * 即「隔离真的生效」当时只有间接保障。
   *
   * ⇒ 拆成两半，各自独立可红：
   * - **⑩a setup 那半**：环境变量已设且指向临时目录；
   * - **⑩b `storeDir()` 那半**：它**真的读**这个变量（用 `storeFileFor` 的
   *   落点间接观测 —— 那是本模块所有凭据路径的唯一入口）。
   */
  it('⑩a DSH_OFFICEACE_HOME 已设置且**确实在系统临时目录下**', () => {
    const home = process.env.DSH_OFFICEACE_HOME
    expect(
      home,
      'DSH_OFFICEACE_HOME 未设置 ⇒ officeace 的 officeaceHome() 会落到 ~/.dsh-officeace，'
      + '读走用户真实凭据并消费其一次性 refresh_token',
    ).toBeDefined()
    expect(home!.length, 'DSH_OFFICEACE_HOME 不能是空串（officeaceHome 会忽略它）').toBeGreaterThan(0)

    // ⚠️ 判据从 `/temp|tmp/i` **收紧**（2026-10-14 对抗性审计）：那个正则太弱 ——
    //    审计预置了一个**仓库内**的 `.audit-tmpdir`（含 "tmp"、非临时目录），
    //    13 条全绿。⇒ 改为与 `os.tmpdir()` 做**路径前缀**比较（真实语义：
    //    「它在系统临时目录里」），而不是「名字里有个 tmp」。
    const tmp = tmpdir()
    const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    expect(
      normalize(home!),
      `DSH_OFFICEACE_HOME 必须位于系统临时目录 ${tmp} 之下，实际是 ${String(home)}`
      + '（只判 /temp|tmp/i 会被「名字里带 tmp 的普通目录」骗过 —— 审计实测过）',
    ).toContain(normalize(tmp))
  })

  /**
   * ⚠️ **⑩b：`officeaceHome()` 真的读那个变量**（行为判据，不读源码文本）。
   *
   * 观测手段：`clearStoredCredential(ref)` 会 `rmSync(storeFileFor(ref))` ——
   * 路径由 `officeaceHome()` 算出；`refreshStoredCredential` /
   * `readStoredCredential` 也都经它。故「在隔离目录放一份凭据 →
   * `readStoredCredential()` 能读到」就直接证明落点是隔离目录。
   *
   * ⚠️ 这正是变异 M5（`officeaceHome` 不读 env）会打红的那条。
   */
  it('⑩b `officeaceHome()` 真的落在隔离目录（写进去能读回来 ⇒ 没走 os.homedir()）', () => {
    const dir = process.env.DSH_OFFICEACE_HOME
    expect(dir, '前置：DSH_OFFICEACE_HOME 必须已隔离').toBeDefined()

    const marker = {
      modelAppKey: 'isolation-probe-key',
      modelAppSecret: 's',
      maasBaseUrl: 'https://example.invalid',
      access: 'a', secret: 's', securityToken: 't', projectId: 'p',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshToken: 'r',
      dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
    }

    // ① 通过**模块自己的**落点写入（`clearStoredCredential` 走同一个 storeFileFor）。
    officeaceAuth.clearStoredCredential()
    writeFileSync(join(dir!, 'session.json'), JSON.stringify(marker), 'utf8')

    // ② 模块读得回来 ⇒ 它找的就是这个目录。
    expect(
      officeaceAuth.readStoredCredential()?.modelAppKey,
      'officeaceHome() 没落在 DSH_OFFICEACE_HOME ⇒ 隔离形同虚设，'
      + '单测会去读用户真实凭据（一次性 refresh_token 会被消费）',
    ).toBe('isolation-probe-key')

    // ③ 反向：模块**清得掉**它（证明不是碰巧读到了别处的同名文件）。
    officeaceAuth.clearStoredCredential()
    expect(officeaceAuth.readStoredCredential(), '清不掉 ⇒ 落点不是这里').toBeUndefined()
  })

  /**
   * ⚠️⚠️ **⑩c：`.office-claw` 那条腿也必须在隔离内**（2026-10-14 对抗性审计打穿后补）。
   *
   * 审计实测：`readSessionCookie()` 原先直接 `os.homedir()` 拼
   * `~/.office-claw/session.cookie`，**不受** `DSH_OFFICEACE_HOME` 覆盖 ——
   * 用户真实文件确实存在，且能**成功 DPAPI 解密**（我在本机实测：返回
   * `7b6049c21e0b…`、耗时约 1.05s、真跑 powershell）。
   *
   * ## ⚠️ 判据必须**只留 env 覆盖这一条防线**，否则是空的
   *
   * 第一版只写「隔离目录里没有 cookie ⇒ 返回 undefined」。那**测不出**
   * `officeAceClientHome()` 是否真的读了 env —— 因为本文件的 `beforeEach`
   * 又把 `USERPROFILE` 指向了 `DSH_OFFICEACE_HOME`（第二道防线），
   * `os.homedir()` 于是也落在临时目录 ⇒ **即使 env 覆盖完全失效，本条仍绿**。
   *
   * ⚠️ 这不是推测：我把 `officeAceClientHome()` 改成忽略 env 后实测，
   * 本条**依然 18 passed** ⇒ 原判据是**空的**。
   *
   * ⇒ 改为**先把 `USERPROFILE` 恢复成真实 home**（主动撤掉第二道防线），再读。
   * 此时唯一还在起作用的保护就是 `DSH_OFFICEACE_HOME` 覆盖：
   * - 覆盖生效 ⇒ 落临时目录 ⇒ 无 cookie ⇒ `undefined`（绿）；
   * - 覆盖失效 ⇒ 落**真实** home ⇒ DPAPI 解出真值 ⇒ **红**。
   */
  it('⑩c `.office-claw` 走 env 覆盖（撤掉 USERPROFILE 防线后仍读不到真实 cookie）', () => {
    const dir = process.env.DSH_OFFICEACE_HOME
    expect(dir, '前置：DSH_OFFICEACE_HOME 必须已隔离').toBeDefined()

    // ⚠️ 撤掉第二道防线：把 USERPROFILE/HOME 指回**真实** home，
    //    于是本条**只能**靠 env 覆盖通过（这正是要测的那条腿）。
    const savedProfile = process.env.USERPROFILE
    const savedHome = process.env.HOME
    process.env.USERPROFILE = realUserHome
    process.env.HOME = realUserHome
    try {
      const value = officeaceAuth.readSessionCookie()
      expect(
        value,
        'readSessionCookie() 在「USERPROFILE 已指向真实 home」时读到了值 ⇒ '
        + '`officeAceClientHome()` 没走 DSH_OFFICEACE_HOME 覆盖，'
        + '正在读用户真实的 ~/.office-claw/session.cookie（单测里绝不该发生）',
      ).toBeUndefined()
    } finally {
      if (savedProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedProfile
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
    }
  })
})

/**
 * ★★ **officeace 锁定态必须成对注入两个窗口**（2026-11-21 对抗审计 P2-4）。
 *
 * `src/officeace-lock.ts:138` 声明了 `imminentWindowMs?: () => number`、
 * `:274` 用 `deps.imminentWindowMs?.()`，但 `src/index.ts` 原先**只注入了 `windowMs`**
 * ⇒ 锁定态的「临期」子窗口恒取全局默认 5 天，与用户在面板里设的 `imminentDays` 分叉。
 *
 * 这正是本 PR 在 `buddy-balance-selector.ts` 里刚修过的**同型缺陷**
 *（可选参数造成静默旁路：`windowMs` 接了、`imminentWindowMs` 没接）。
 *
 * ⚠️ 为什么需要这条源码级守卫：撤掉注入后**跑遍现有 officeace 用例全绿**
 *    （实测 M6 无牙）—— 因为 `split.imminent` 今天还没有消费方，
 *    「零可观测后果」正是它无法被行为级用例发现的原因。
 */
describe('officeace 窗口注入（源码级，局限已登记）', () => {
  it('★★ `windowMs` 与 `imminentWindowMs` 必须成对注入', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8'))
    expect(source).toContain('windowMs: () => resolveCreditWindow(OFFICEACE.id')
    expect(source).toContain('imminentWindowMs: () => resolveCreditWindow(OFFICEACE.id')
  })
})
