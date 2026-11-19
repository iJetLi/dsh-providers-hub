/**
 * CodeBuddy / WorkBuddy 的「锁定永久积分」**接线**回归。
 *
 * ## 为什么单独守这个
 *
 * 判据与选号都是纯函数（已由 `buddy-balance-rank.spec.ts` /
 * `buddy-balance-selector.spec.ts` 锁死）。但历史上反复出问题的从来不是
 * 算法，而是**没接上**：
 *
 * - WorkBuddy 的「刷新」按钮一直坏着，因为新增分支时漏接了一处 case；
 * - Qoder 的 `modelId` 曾传空串，于是模型级限流过滤整体短路；
 * - Loomy 的锁定制过「绕过」的坑：锁定后绝不可落到单凭据兜底。
 *
 * ## ⚠️ Task 6 的改写（2026-10-08）
 *
 * 原先这一组是**源码文本断言**：两个已删除的 helper（声明体切片 / 调用块切片）
 * 分别锚定 `src/index.ts` 里**已被删除**的那个编排闭包的声明与调用形，再对切出来的
 * 源码串做 `toContain`。Task 6 把 12 个 `resolveCredential` 闭包收敛成
 * `createCredentialResolver(...)`、并删除了那个闭包之后，那些锚点全部消失 ⇒ ~10 条红。
 *
 * 现在改为**驱动真实 `apply()`**：不关心源码长什么样，只看**行为**。
 * 强度更高 —— 旧断言只证明「某行文本在某个函数体里」，新断言证明
 * 「锁定时真实闭包真的抛错、真的不回落」。
 *
 * ⚠️ 保留的少量源码断言只用于守**纯文本形态**的约定（如「必须用
 * `<PROVIDER>.id` 而非字面量」）—— 那类约定无法用行为区分。
 *
 * ⚠️ **注释里不复写被删掉的那两个锚点原文**：它们是「锚点已消失」这类核对会 grep
 * 的字符串，写进注释会让核对**假命中**（同文件下方 `raccoon-wiring.spec.ts` 的约定）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuddyBalanceSelector, pickBuddyAccount } from '../../src/buddy-balance-selector.js'
import { BUDDY_BALANCE_TIER } from '../../src/buddy-balance-rank.js'
import { BUDDY_EXPIRING_WINDOW_DAYS } from '../../src/buddy-balance-rank.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'
import { apply } from '../../src/index.js'
import type { BuddyCredential } from '../../src/buddy.js'
import type { CreditBalance } from '../../src/credits.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 接线断言**不能**因为「注释里提到了某个符号」就通过或失败：
 * 本仓库的注释大量解释「为什么绝不能走某条兜底路径」，于是对兜底的
 * **否定**断言必须只看代码（与 `refresh-bootstrap-wiring.spec.ts` 同一约定）。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const indexCode = codeOnly(indexSource)

/** 造一份「`days` 天后到期、余额 `remaining`」的余额。 */
function balance(remaining: number, days: number): CreditBalance {
  return {
    total: remaining,
    expiredTotal: 0,
    packages: [{
      name: 'Bonus Pack', unit: 'credits', remaining, total: remaining, used: 0, active: true,
      cycleStartTime: '', cycleEndTime: '', expiredTime: '',
      deductionEndTime: Date.now() + days * 24 * 60 * 60 * 1000,
    }],
  }
}

describe('index.ts 的接线（源码级，仅守纯文本形态的约定）', () => {
  it('导入选号器（漏 import 就等于没接）', () => {
    expect(indexCode).toContain("from './buddy-balance-selector.js'")
    expect(indexCode).toContain('BuddyBalanceSelector')
    // 报错文案里的窗口天数必须**运行时解析**（可用环境变量覆盖），
    // 不能在文案里写死字面量 —— 否则用户改了窗口，报错还在说 15 天。
    expect(indexCode).toContain("from './buddy-balance-rank.js'")
    // ★ 2026-11-19：per-provider 窗口后，窗口值改由 resolveCreditWindow 现读
    //（它内部按「本渠道设置 > 环境变量 > 默认」解析，仍满足「不能写死字面量」）
    expect(indexCode).toContain('resolveCreditWindow(')
  })

  /**
   * ⚠️ 每个 provider 必须各有**自己的** selector 实例。
   * 共用一份缓存会让 CodeBuddy 的余额结果被 WorkBuddy 读到（键是账号 id，
   * 两站账号 id 不同，看似不会撞 —— 但凭据解析与 endpoint 都跟着 product 走，
   * 共用实例等于把「两站同构」这一前提写死进运行时）。
   *
   * ⚠️ 2026-10-06 起 TRAE / LobsterAI 也接了同一套编排，故实例数由 2 变 4。
   * ⚠️ 2026-10-20 加 astudio（讯飞 AstronStudio），实例数 4 → 5。
   * 本用例改为「**每个支持锁定的 provider 各一个**」—— 数量随白名单走，
   * 而不是写死 2（写死会让下次加 provider 时这条无关断言先红）。
   *
   * ⚠️⚠️ 数量断言**改成从 `PERMANENT_LOCK_PROVIDERS` 派生**（不再写死数字）：
   * 本文件守的是 buddy 系「走 `BuddyBalanceSelector` 的那几家」，
   * 而 officeace 走的是自己的 `credentialProvider`（不建选号器）、
   * loomy 走 `loomy-balance-selector`（另一个类）⇒ 二者的数量不是 1:1。
   * 故这里仍显式列出 `new BuddyBalanceSelector(` 的那几家，并让**计数**
   * 与列表长度联动 —— 加一家时只需在这张列表里加一行，两处不会漂移。
   */
  /** 直接 new `BuddyBalanceSelector` 的渠道（= 走 `kind: 'buddy'` 分档的）。 */
  // ⚠️ minimax / minimaxintl 2026-10-20 加入：与 AStudio 同一条路径
  //    （`MinimaxAdapter` 只是 `MinimaxProductType` 不同的同一个类，但
  //    **是两个渠道 id** ⇒ 必须各建一个选号器，否则国际站的到期分档不生效）。
  const BUDDY_SELECTOR_PROVIDERS = [
    'CODEBUDDY', 'WORKBUDDY', 'TRAE', 'LOBSTERAI', 'ASTUDIO',
    'MINIMAX', 'MINIMAX_INTL',
    // ⚠️ QODER / QODER_CN（PR131，2026-10-20）：两站各一个选号器。
    'QODER', 'QODER_CN',
    // ⚠️ AUTOCLAW / AUTOCLAW_INTL（2026-10-21，用户要求「补锁定开关」）：
    //    两站各一个（选择器内含按账号 id 的缓存，跨站共用会让一站读数污染另一站）。
    'AUTOCLAW', 'AUTOCLAW_INTL',
  ] as const
  it('每个支持锁定的 provider 各建一个选号器', () => {
    const expected = [
      ['buddyBalanceSelector', 'CODEBUDDY'],
      ['workbuddyBalanceSelector', 'WORKBUDDY'],
      ['traeBalanceSelector', 'TRAE'],
      ['lobsteraiBalanceSelector', 'LOBSTERAI'],
      ['astudioBalanceSelector', 'ASTUDIO'],
      ['minimaxBalanceSelector', 'MINIMAX'],
      ['minimaxIntlBalanceSelector', 'MINIMAX_INTL'],
      // ⚠️ QODER / QODER_CN 2026-10-20 加入（PR131）：`fetchQoderCreditBalance(credential,
      //    product, fetcher?)` 的 `product` 是**第二**参（minimax 那份是第三参），
      //    且两站域名不同（`openapi.qoder.sh` / `openapi.qoder.com.cn`）⇒
      //    同样必须各建一个选号器（传错会让选号读到对方站点）。
      ['qoderBalanceSelector', 'QODER'],
      ['qoderCnBalanceSelector', 'QODER_CN'],
      // ⚠️ AUTOCLAW / AUTOCLAW_INTL 2026-10-21 加入（用户要求「补锁定开关」）：
      //    本家**确实有永久桶**（活动赠送的永久分不带 `deductionEndTime`）⇒ 需要
      //    锁定能力。两站必须各建一个（传错 product 会让选号读到对方站点，余额恒 null）。
      ['autoclawBalanceSelector', 'AUTOCLAW'],
      ['autoclawIntlBalanceSelector', 'AUTOCLAW_INTL'],
    ] as const
    for (const [name, product] of expected) {
      // ⚠️ `new ` 前面要留出空格边界：`astudioBalanceSelector` 与
      //    `buddyBalanceSelector` 的 `\b` 都能匹配到 `Selector`，
      //    但 `const ` 前缀已足够区分（这里保留 `\s*\n\s*` 是为了容忍缩进变化）。
      expect(indexCode, `${name} 未建（product: ${product}）`).toMatch(
        new RegExp(`const ${name} = new BuddyBalanceSelector\\(\\{\\s*\\n\\s*product: ${product},`),
      )
    }
    expect(indexCode.match(/new BuddyBalanceSelector\(/g)).toHaveLength(expected.length)
    // 自检：列表与实现数一一对应，且列表本身非空（防正则失效时恒绿）。
    expect(expected.length, '列表为空 ⇒ 上面两条是同义反复').toBe(BUDDY_SELECTOR_PROVIDERS.length)
  })

  it('凭据解析函数两站共用一份（同协议，差别只在 endpoint）', () => {
    expect(indexCode).toContain('const resolveBuddyCredentialByRef =')
    // ⚠️ **不能用「标识符出现次数」来断言**（PR !68 初版就是这么写的，已实测是
    // 同义反复）：把两个 selector 里的 `resolveCredential: resolveBuddyCredentialByRef`
    // 改成 `(r) => resolveBuddyCredentialByRef(r)` 后，标识符**仍然是 4 次**，
    // 计数断言照样绿 —— 而「两个 selector 确实用了 buddy 那份解析器」已不存在。
    // 改成**逐个选择器定义块**内做精确匹配。
    for (const name of ['buddyBalanceSelector', 'workbuddyBalanceSelector']) {
      const start = indexCode.indexOf(`const ${name} = new BuddyBalanceSelector(`)
      expect(start, `index.ts 里找不到 ${name}`).toBeGreaterThan(-1)
      const block = indexCode.slice(start, indexCode.indexOf('})', start))
      expect(block, `${name} 必须直接用 resolveBuddyCredentialByRef`).toMatch(
        /resolveCredential:\s*resolveBuddyCredentialByRef\b/,
      )
    }
  })

  /**
   * ⚠️ 两家的凭据解析器必须**做形状校验**，且与各自 auth 的 `parseCredential` 对齐。
   *
   * 裸 `JSON.parse` 会把 `{"foo":1}` 这种损坏凭据当成有效凭据返回，随后适配器的
   * `credential.access_token.length` 抛 **TypeError**（不是可诊断的
   * `MISSING_CREDENTIAL`），且发生在选号之后、不在余额查询的 try/catch 覆盖内。
   *
   * 判据取 `typeof parsed.access_token === 'string'`，与 `trae-auth.ts` /
   * `lobsterai-auth.ts` 的 `parseCredential` 逐字一致。
   *
   * ⚠️ Task 6 保留本条为源码断言：它守的是**解析器函数体内部**的判据强度，
   * 而那是一个无法从「返回值」区分的实现细节（`{"broken":1}` 在两条实现下
   * 的返回值相同 —— 都是被拒，但**原因**不同：形状校验 vs 后续 TypeError）。
   * 该行为等价性由 `credential-resolver-parity.spec.ts` 的「回退凭据形状校验
   * 失败 ⇒ 两者都 undefined」对拍。
   */
  it('★ 两家凭据解析器做形状校验（与各自 auth 的 parseCredential 对齐）', () => {
    for (const fn of ['resolveTraeCredentialByRef', 'resolveLobsteraiCredentialByRef']) {
      const start = indexCode.indexOf(`const ${fn} = async`)
      expect(start, `index.ts 里找不到 ${fn}`).toBeGreaterThan(-1)
      const body = indexCode.slice(start, indexCode.indexOf('\n  }', start))
      expect(body, `${fn} 必须校验 access_token 是字符串`).toContain("typeof parsed.access_token === 'string'")
    }
  })

  /**
   * ⚠️ 两家的**选号器**必须注入自己的 `fetchBalance`。
   *
   * 漏传时不会用 buddy 的缺省实现去发请求（那样只是查不到），而是把
   * `TraeProduct` 喂给 `fetchCreditBalance` —— 它读 `product.endpoint`，而
   * `TraeProduct` **根本没有这个字段** ⇒ 拼出 `undefined/v2/billing/...` 的
   * 畸形 URL。后果：余额恒查不到 ⇒ 未锁定时换号优化静默失效、锁定时永远报
   * 「无法确认是否有可用账号」，而积分一分没花。
   *
   * ⚠️ 该漏洞**已由 `BuddySelectionDeps` 的条件类型在编译期关闭**
   * （非 buddy provider 的 `fetchBalance` 必填，实测漏传报 TS2345）；
   * 这里再钉一道源码级断言作双保险 —— 万日后退化成可选类型，本用例仍能红。
   */
  it('★ 两家选号器注入自己的 fetchBalance（不用 buddy 缺省实现）', () => {
    for (const [name, product, fn] of [
      ['TRAE', 'TRAE', 'fetchTraeCreditBalance'],
      ['LobsterAI', 'LOBSTERAI', 'fetchLobsteraiCreditBalance'],
    ] as const) {
      const re = new RegExp(
        `const ${name.toLowerCase()}BalanceSelector = new BuddyBalanceSelector\\(\\{\\s*\\n\\s*product: ${product},[\\s\\S]*?fetchBalance:`,
      )
      expect(indexCode, `${name} 的选择器必须注入 fetchBalance`).toMatch(re)
      expect(indexCode, `${name} 应调用 ${fn}`).toContain(fn)
    }
  })

  it('两个 provider 各自的报错文案用其产品名', () => {
    expect(indexCode).toContain("buddyLockedError('CodeBuddy', 'buddy')")
    expect(indexCode).toContain("buddyLockedError('WorkBuddy', 'workbuddy')")
  })
})

/**
 * **行为级**：驱动真实 `apply()`，逐个断言「锁定永久积分」在四家上的接线。
 *
 * ⚠️ 这一组替代了原先 ~10 条源码文本断言（见文件头）。它比文本断言强：
 * 后者只证明「某段文本在某个函数体里」，前者证明**真实闭包真的这么做了**。
 */
describe('★ 锁定的真实行为（驱动 apply()，替代源码文本断言）', () => {
  /** 锁定后只剩永久积分的那四家（各有自己的 selector 与文案）。 */
  const LOCKED_PROVIDERS = [
    { provider: 'buddy', name: 'CodeBuddy' },
    { provider: 'workbuddy', name: 'WorkBuddy' },
    { provider: 'lobsterai', name: 'LobsterAI' },
    { provider: 'trae', name: 'TRAE' },
  ] as const

  const dirs: string[] = []

  beforeEach(() => {
    // ⚠️ 必须桩掉 fetch：`isFreeModel()` 会拉远端目录，余额查询会打上游端点。
    // 桩成失败后目录拿不到（`isFreeModel` 保守返回 false = 付费），
    // 余额查询失败 ⇒ 条目 `ok:false` ⇒ 锁定时报「无法确认」而非「已用尽」。
    // 两种原因都由本组断言区分（见下）。
    vi.stubGlobal('fetch', async () => { throw new Error('单测不发网络') })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
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
    accountPool: {
      addAccount(entry: Record<string, unknown>): Promise<void>
      setPermanentLocked(provider: string, locked: boolean): Promise<void>
    }
    credentials: FakeCredentials
    llm: FakeLlm
  }

  function boot(): TestCtx {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
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

  /** 放一个凭据可用的账号。 */
  async function addAccount(ctx: TestCtx, provider: string): Promise<string> {
    const id = `acct_${provider}_${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
    const ref = `${provider.toUpperCase()}_ACCOUNT_${id.toUpperCase()}`
    await ctx.accountPool.addAccount({
      id, provider, nickname: id, enabled: true, credentialRef: ref, createdAt: 0, refreshable: true,
    })
    await ctx.credentials.set(
      credentialRef(ref),
      JSON.stringify({ access_token: `tok-${id}`, refresh_token: 'rt', expires_at: Date.now() + 3_600_000 }),
    )
    return id
  }

  /**
   * ⚠️ **锁定 + 余额查询失败 ⇒ 必须报「无法确认是否有可用账号」**。
   *
   * 这是「两种原因分开报」那条真实缺陷（用户报障 2026-09-29）：把一次网络抖动
   * 报成「额度已用尽」，用户会去解锁或白等，而号其实有钱。
   * 变异：把 `lockedError` 的两条分支合并成一条 ⇒ 本条红。
   */
  it.each(LOCKED_PROVIDERS)(
    '$provider：锁定 + 余额查不到 ⇒ 抛「无法确认」而不是「额度已用尽」',
    async ({ provider, name }) => {
      const ctx = boot()
      await ctx.accountPool.setPermanentLocked(provider, true)
      await addAccount(ctx, provider)
      const error = await resolveOf(ctx, provider)('glm-5.2').then(() => undefined, (e: Error) => e)
      expect(error, `${provider} 锁定时必须抛错（绝不回落单凭据）`).toBeDefined()
      expect(error?.message, `${name} 的文案应点名产品`).toContain(name)
      expect(error?.message, '应报「无法确认」——余额查询失败不等于额度用尽').toContain('无法确认是否有可用账号')
      expect(error?.message, '不得把它报成「额度已用尽」').not.toContain('没有可用账号。')
    },
    30_000,
  )

  /**
   * ⚠️ **锁定时绝不回落单凭据 ref**。
   *
   * 旧闭包在「锁定 + 无可用账号」时直接抛错；若有人改成 `return undefined`
   * 或让它落到 `readCredential(<PROVIDER>_ACCESS_TOKEN)`，锁定就形同虚设
   *（Jet Hub 登录只写 `*_ACCOUNT_XXX`，那个 ref 本就不存在，于是症状是
   * 「明明锁着却报未登录」而不是报锁定）。
   *
   * 判据：写一份**内容合法**的单凭据（形状能过校验），锁定时**不得**返回它。
   * 变异：把 `throw plan.lockedError(...)` 改成 `return await fallback()` ⇒ 本条红。
   */
  it.each(LOCKED_PROVIDERS)(
    '$provider：锁定 + 单凭据 ref 有合法凭据 ⇒ 仍必须抛错（不得回落）',
    async ({ provider }) => {
      const ctx = boot()
      await ctx.accountPool.setPermanentLocked(provider, true)
      await addAccount(ctx, provider)
      // 写一份形状合法、内容正确的单凭据 —— 回落到它就会「看起来正常」。
      await ctx.credentials.set(
        credentialRef(`${provider.toUpperCase()}_ACCESS_TOKEN`),
        JSON.stringify({ access_token: 'fallback-token', refresh_token: 'rt', expires_at: Date.now() + 3_600_000 }),
      )
      const outcome = await resolveOf(ctx, provider)('glm-5.2')
        .then((value) => ({ kind: 'returned' as const, value }), (e: Error) => ({ kind: 'threw' as const, e }))
      expect(outcome.kind, '锁定时必须抛错，绝不能返回单凭据').toBe('threw')
    },
    30_000,
  )

  /**
   * ⚠️ **解锁时不得改变既有行为**：账号可用就正常返回凭据。
   *
   * 这是上一组（锁定时抛错）的**阳性对照** —— 没有它，一个「永远抛错」的
   * 坏实现能让上一组全绿。
   */
  it.each(LOCKED_PROVIDERS)(
    '$provider：解锁 + 账号可用 ⇒ 正常返回凭据（阳性对照）',
    async ({ provider }) => {
      const ctx = boot()
      const id = await addAccount(ctx, provider)
      const credential = await resolveOf(ctx, provider)('glm-5.2') as { access_token?: string } | undefined
      expect(credential, `${provider} 解锁且账号可用时必须交出凭据`).toBeDefined()
      expect(credential?.access_token, '取到的必须是池内那个账号的凭据').toBe(`tok-${id}`)
    },
    30_000,
  )

  /**
   * ⚠️ **锁定状态按 provider 读**（不是全局一个开关）。
   *
   * 旧断言是源码文本 `!pool.permanentLocked(options.product.id)`。行为等价物：
   * 只锁 A，B 必须照常可用 —— 若实现写成全局开关或读错 provider，
   * B 会跟着被锁。
   */
  it('锁定是**按 provider** 的：只锁 buddy 时 workbuddy 照常可用', async () => {
    const ctx = boot()
    await ctx.accountPool.setPermanentLocked('buddy', true)
    const buddyId = await addAccount(ctx, 'buddy')
    const workbuddyId = await addAccount(ctx, 'workbuddy')

    const buddyOutcome = await resolveOf(ctx, 'buddy')('glm-5.2')
      .then((v) => ({ kind: 'returned' as const, v }), () => ({ kind: 'threw' as const }))
    expect(buddyOutcome.kind, 'buddy 已锁定 ⇒ 必须抛错').toBe('threw')

    const workbuddyCredential = await resolveOf(ctx, 'workbuddy')('glm-5.2') as { access_token?: string } | undefined
    expect(workbuddyCredential?.access_token, 'workbuddy 未锁定 ⇒ 不得受 buddy 的锁定影响')
      .toBe(`tok-${workbuddyId}`)
    expect(buddyId, '（buddy 的账号确实建过）').toBeTruthy()
  }, 30_000)
})

/**
 * 行为级：**endpoint 必须随产品切换**。
 *
 * `product` 是选号器唯一的路由信息来源 —— 若两站共用一份 product，
 * 中国版账号会拿着国际版的余额（或反之），锁定判据就建立在错的数据上。
 * 这是本插件反复踩过的坑（endpoint 不可当全局常量）。
 */
describe('选号器按产品取 endpoint（两站不串味）', () => {
  const DAY = 24 * 60 * 60 * 1000
  const balanceFixture: CreditBalance = {
    total: 250,
    packages: [{
      name: 'Bonus Pack',
      unit: 'credits',
      remaining: 250,
      total: 250,
      used: 0,
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
      deductionEndTime: Date.now() + 9 * DAY,
    }],
    expiredTotal: 0,
  }

  function selectorFor(product: typeof CODEBUDDY, seen: string[]) {
    return new BuddyBalanceSelector({
      product,
      resolveCredential: async ref => ({ access_token: 'AT', domain: product.apiDomain } as BuddyCredential & { domain: string }) as unknown as BuddyCredential,
      fetchBalance: async (_credential, p) => {
        seen.push(`${p.endpoint}/v2/billing/meter/get-user-resource`)
        return balanceFixture
      },
    })
  }

  it('CodeBuddy 用 copilot.tencent.com，WorkBuddy 用 www.workbuddy.ai', async () => {
    const seen: string[] = []
    const buddy = selectorFor(CODEBUDDY, seen)
    const workbuddy = selectorFor(WORKBUDDY, seen)

    const pickedBuddy = await buddy.select([{ id: 'b1', credentialRef: 'BUDDY_ACCOUNT_B1' }], {})
    const pickedWorkbuddy = await workbuddy.select([{ id: 'w1', credentialRef: 'WORKBUDDY_ACCOUNT_W1' }], {})

    expect(seen).toEqual([
      `${CODEBUDDY.endpoint}/v2/billing/meter/get-user-resource`,
      `${WORKBUDDY.endpoint}/v2/billing/meter/get-user-resource`,
    ])
    // 两站都有「15 天内到期」的包 ⇒ 都落在「会作废」的档、都被选中
    expect(pickedBuddy?.account.id).toBe('b1')
    expect(pickedWorkbuddy?.account.id).toBe('w1')
    // ⚠️ 用**符号**断言，不写裸数字：2026-11-17 引入「临期」档后序号整体后移过，
    //    裸数字会让每次调整档位顺序都假红，且看不出断言的真实意图。
    //    本夹具的包距到期 9 天 ⇒ 5~15 天 ⇒ 短期（expiring）。
    expect(pickedBuddy?.balance.tier).toBe(BUDDY_BALANCE_TIER.expiring)
  })

  it('编排层拿到的凭据来自实际选中的那个账号', async () => {
    const seen: string[] = []
    const selector = selectorFor(CODEBUDDY, seen)
    const result = await pickBuddyAccount(selector, [
      { id: 'b1', credentialRef: 'BUDDY_ACCOUNT_B1' },
    ], {
      allowPermanent: false,
      resolveCredential: async ref => ({ access_token: `token-${ref}` }) as unknown as BuddyCredential,
    })
    expect(result.kind).toBe('account')
    if (result.kind !== 'account') return
    expect(result.credential.access_token).toBe('token-BUDDY_ACCOUNT_B1')
  })

  it('窗口边界在编排里同样生效（17 天的包在锁定时不可用）', async () => {
    const seen: string[] = []
    const selector = new BuddyBalanceSelector({
      product: CODEBUDDY,
      resolveCredential: async ref => ({ access_token: ref }) as unknown as BuddyCredential,
      fetchBalance: async () => ({
        total: 100,
        expiredTotal: 0,
        packages: [{
          name: 'CodeBuddy个人版国内运营裂变包',
          unit: 'credits',
          remaining: 100,
          total: 100,
          used: 0,
          active: true,
          cycleStartTime: '',
          cycleEndTime: '',
          expiredTime: '',
          // 实测中国版裂变包的到期分布密集落在 17～30 天
          deductionEndTime: Date.now() + 17 * DAY,
        }],
      }),
    })
    const result = await pickBuddyAccount(selector, [{ id: 'b1', credentialRef: 'R1' }], {
      allowPermanent: false,
      resolveCredential: async () => ({ access_token: 'x' }) as unknown as BuddyCredential,
    })
    // ⇒ 该账号在锁定期间「等同于不可用」：这正是用户要的语义，不是缺陷
    expect(result.kind).toBe('locked')
    expect(BUDDY_EXPIRING_WINDOW_DAYS).toBe(15)
    expect(seen).toEqual([])
  })
})
