/**
 * `permanent-lock-execution.spec.ts` —— **「锁定永久积分」的执行路径普查**。
 *
 * ## 为什么需要这个文件（Gitee issue IKLTHB 第 ① 条）
 *
 * 这个开关的失效形态**不是**「算错了」，而是「**根本没算**」：
 * `provider-registry.ts` 里登记 `permanentLock: true` 会让面板渲染出开关、
 * 并逐字承诺「这类积分用尽后将没有可用账号」，但**谁去执行这张锁定表**
 * 是每一家各自接线的事 —— 注册表**管不到**它。
 *
 * officeace 就是这么漏的：它登记了 `permanentLock: true`，而全仓
 * `permanentLocked()` 只有 `credential-resolver.ts` 的 buddy / loomy 两个分支读过，
 * officeace 走的是适配器自己的 `credentialProvider` ⇒ 开关写进
 * `permanent-locks.json` 后**行为与关闭完全一致**（用户照旧烧永久套餐包），
 * 而**没有任何用例会红**（issue 报障的原始症状）。
 *
 * 所以本文件守两件事：
 *
 * | # | 不变式 | 违反的后果 |
 * |---|--------|-----------|
 * | A | 每家 `permanentLock: true` 的渠道都必须登记一条**执行路径**（模块 + 守卫用例） | 登记了开关却没有实现（原始缺陷）|
 * | B | officeace 的执行路径**真的会拒**（驱动真实 `apply()`，真读锁定表）| 只有一条「看起来对」的指针 |
 *
 * ⚠️ A 是**普查**（期望值写在本文件里，与 `PERMANENT_LOCK_PROVIDERS` 对拍）——
 *    与 `expiry-runtime-parity.spec.ts` 的 `EXPECTED_WIRED` 同款：
 *    加一家新渠道时**必须**在这里登记执行路径，否则红。这不是同义反复：
 *    一处是「声明有能力」，一处是「指向一个真的会拒绝的实现」。
 *
 * ⚠️ B 用**真实 `apply()`**：它证明的是「`index.ts` 装出来的那条闭包真的读了
 *    锁定表」，而不是「源码里出现过某个符号」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { PERMANENT_LOCK_PROVIDERS } from '../../src/jet-hub-rpc.js'
import { descriptorOf } from '../../src/provider-registry.js'
import { buddyExpiringWindowDays } from '../../src/buddy-balance-rank.js'
import { permanentLockCopy } from '../../plugin-src/client/credits-capabilities.js'

// ⚠️ 必须 mock 掉余额入口：它内部会打云侧 V11 签名请求（真网络）。
vi.mock('../../src/officeace-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/officeace-auth.js')>()
  return { ...actual, fetchSubscriptionSummary: vi.fn() }
})

const { fetchSubscriptionSummary } = await import('../../src/officeace-auth.js')
const { apply } = await import('../../src/index.js')

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const mocked = vi.mocked(fetchSubscriptionSummary)

const DAY = 24 * 60 * 60 * 1000

/**
 * 每家的执行路径登记表。
 *
 * ⚠️ `module` 是**实现这条锁定**的模块，`spec` 是**真的会驱动那条路径**的守卫文件
 *    （不是随便指一个提到它的文件），`drives` 是那条路径上**具有判别力**的符号。
 *    指针腐坏的成本很低，所以本文件逐项核对三件事（见 ②）：
 *    模块与用例都**存在**、用例**点名了该渠道**、用例**真的引用了那个判别符号**。
 *
 * ⚠️ 为什么要 `drives`：只做 `includes(provider)` 时，**本文件自己**包含全部六家
 *    渠道名 ⇒ 把任意一条登记指向本文件也照样绿，而注释却自称「真的会驱动」。
 *    判别符号不可从渠道名推导出来，故「指向本文件」这条偷懒路径会被当场挡住。
 *    （⚠️ 它仍不是「路径被执行过」的证明 —— 那由 B 段用真实 `apply()` 承担。）
 */
const LOCK_EXECUTION_PATHS: Record<
  string,
  {
    module: string
    spec: string
    drives: string
    /**
     * ⚠️ **带上下文的接线锚点**（2026-10-21 合并审计补）。
     *
     * `drives` 是**裸符号**，对 `src/index.ts` 那五项**无牙** ——
     * 符号的定义还在文件里，删掉使用点照样 `includes` 为真。
     * 本字段存「调用形态」的片段（如 `lockedError: astudioLockedError('AStudio'),`），
     * 只有真的接在被测渠道上才会命中。
     *
     * ⚠️ **`module === 'src/index.ts'` 的登记项必须填本字段**（本文件末尾有一条
     *    普查断言强制这件事），否则该渠道的「执行路径」判据退化成恒真。
     */
    anchor?: string
  }
> = {
  // buddy 系四家（含 trae / lobsterai）：`createCredentialResolver` 的 buddy 分支
  // 读 `pool.permanentLocked(providerId)` ⇒ `pickBuddyAccount({ allowPermanent })`
  // ⇒ 锁定且只剩永久桶时报 `plan.lockedError(...)`。行为守卫见那张 spec 的
  // 「锁定的真实行为（驱动 apply()）」一节（四家各有自己的 selector 与文案）。
  buddy: {
    module: 'src/buddy-balance-selector.ts',
    spec: 'tests/unit/buddy-permanent-lock.spec.ts',
    drives: 'pickBuddyAccount',
  },
  workbuddy: {
    module: 'src/buddy-balance-selector.ts',
    spec: 'tests/unit/buddy-permanent-lock.spec.ts',
    drives: 'pickBuddyAccount',
  },
  trae: {
    module: 'src/buddy-balance-selector.ts',
    spec: 'tests/unit/buddy-permanent-lock.spec.ts',
    drives: 'pickBuddyAccount',
  },
  lobsterai: {
    module: 'src/buddy-balance-selector.ts',
    spec: 'tests/unit/buddy-permanent-lock.spec.ts',
    drives: 'pickBuddyAccount',
  },
  // Loomy：`credential-resolver.ts` 的 loomy 分支（`loomyBalanceTier` 的
  // `allowPermanent:false` ⇒ `none`）。文案与接线由这两张 spec 守。
  loomy: {
    module: 'src/loomy-balance-selector.ts',
    spec: 'tests/unit/loomy-balance-rank.spec.ts',
    drives: 'loomyBalanceTier',
  },
  // ⚠️ officeace **不走** credential-resolver（它有自己的 `credentialProvider`），
  //    执行路径是本 PR 新增的 `src/officeace-lock.ts`。
  officeace: {
    module: 'src/officeace-lock.ts',
    spec: 'tests/unit/officeace-lock.spec.ts',
    drives: 'createOfficeAceCredentialProvider',
  },
  // ⚠️ qoder / qodercn（2026-10-20）：与 buddy 系四家**同一条**执行路径
  //    （`createCredentialResolver` 的 `kind: 'buddy'` 分支 ⇒
  //    `pool.permanentLocked(providerId)` ⇒ `pickBuddyAccount({ allowPermanent })`
  //    ⇒ 落 `plan.lockedError(...)`）。判别符号取 `qoderLockedError` ——
  //    它本家独有（共用 `buddyLockedError` 等于没点名）。
  //    ⚠️ 两家**共用**这个构造器（只差 `displayName`），故两行写同一个符号是
  //    正确的：本表只查「该渠道的接线在、且指向一个本家可点名的实现」，
  //    两站的 `displayName` 差异由 `qoder-lock-wiring.spec.ts` 的源码级断言锁。
  qoder: {
    module: 'src/index.ts',
    spec: 'tests/unit/qoder-lock-wiring.spec.ts',
    drives: 'qoderLockedError',
    anchor: "lockedError: qoderLockedError('Qoder'),",
  },
  qodercn: {
    module: 'src/index.ts',
    spec: 'tests/unit/qoder-lock-wiring.spec.ts',
    drives: 'qoderLockedError',
    // ⚠️ 两站**共用** `qoderLockedError` 构造器，只差 `displayName` ⇒ 锚点必须
    //    带各自的 `displayName` 才能区分「中国版接了」与「国际版接了」。
    anchor: "lockedError: qoderLockedError('Qoder (中国版)'),",
  },
  // ⚠️ astudio（2026-10-20）：与 buddy 系四家**同一条**执行路径 ——
  //    `src/index.ts` 的 astudio 注册段接了 `createCredentialResolver` 的
  //    `kind: 'buddy'` 分支（`credential-resolver.ts` 读
  //    `pool.permanentLocked(providerId)` ⇒ `pickBuddyAccount({ allowPermanent })`）。
  //    判别符号取 `astudioLockedError` —— 它**本家独有**（buddy 系四家共用
  //    `buddyLockedError`，写那个等于没点名），且只在本 PR 新增的这段里出现。
  astudio: {
    module: 'src/index.ts',
    spec: 'tests/unit/astudio-lock-wiring.spec.ts',
    drives: 'astudioLockedError',
    anchor: "lockedError: astudioLockedError('AStudio'),",
  },
  // ⚠️ minimax / minimaxintl（2026-10-20）：与 astudio **同一条**执行路径
  //    （`createCredentialResolver` 的 `kind: 'buddy'` 分支），但判别符号必须
  //    取 `minimaxLockedError` —— 两家共用它，写在 `src/index.ts` 里可出现两次，
  //    但至少证明本家的接线在（`buddyLockedError` 那种共用符号等于没点名）。
  //    ⚠️ 两家的 `lockedError` 参数不同（`'MiniMax Code (中国版)'` /
  //    `'MiniMax Code (国际版)'`）—— 但本表只查符号存在，参数差异由
  //    `tests/unit/minimax-lock-wiring.spec.ts` 的源码级断言锁。
  minimax: {
    module: 'src/index.ts',
    spec: 'tests/unit/minimax-lock-wiring.spec.ts',
    drives: 'minimaxLockedError',
    anchor: "lockedError: minimaxLockedError('MiniMax Code (中国版)'),",
  },
  minimaxintl: {
    module: 'src/index.ts',
    spec: 'tests/unit/minimax-lock-wiring.spec.ts',
    drives: 'minimaxLockedError',
    anchor: "lockedError: minimaxLockedError('MiniMax Code (国际版)'),",
  },
  // ⚠️ autoclaw / autoclawintl（2026-10-21，用户要求「补锁定开关」）：
  //    与 astudio / minimax 同一条执行路径（`createCredentialResolver` 的
  //    `kind: 'buddy'` 分支 ⇒ `pickBuddyAccount({ allowPermanent })`）。
  //    判别符号取 `autoclawLockedError` —— 它本家独有（共用 `buddyLockedError`
  //    等于没点名）。
  //    ⚠️ **两站的锚点必须带各自的 `displayName`**：两站共用同一个构造器，
  //    只查裸符号会让「一站的接线在」使另一站也绿。
  autoclaw: {
    module: 'src/index.ts',
    spec: 'tests/unit/autoclaw-lock-wiring.spec.ts',
    drives: 'autoclawLockedError',
    anchor: "lockedError: autoclawLockedError('AutoClaw'),",
  },
  autoclawintl: {
    module: 'src/index.ts',
    spec: 'tests/unit/autoclaw-lock-wiring.spec.ts',
    drives: 'autoclawLockedError',
    anchor: "lockedError: autoclawLockedError('AutoClaw (国际版)'),",
  },
  // ⚠️ magicrew / magicrewintl（2026-11-01，用户要求「加永久/长期/临期和锁定永久积分」）：
  //    与 astudio / minimax / autoclaw 同一条执行路径（`createCredentialResolver`
  //    的 `kind: 'buddy'` 分支 ⇒ `pickBuddyAccount({ allowPermanent })`）。
  //    判别符号取 `magicrewLockedError` —— 它本家独有（共用 `buddyLockedError`
  //    等于没点名）。
  //    ⚠️ **两站的锚点必须带各自的 `displayName`**：两站共用同一个构造器，
  //    只查裸符号会让「一站的接线在」使另一站也绿。
  //    ⚠️ 国际站的 label 是 `MagiCrew (国际版)`（**不是** `超级麦吉 (国际版)`），
  //    锚点必须逐字对应 `src/index.ts` 里那行。
  magicrew: {
    module: 'src/index.ts',
    spec: 'tests/unit/magicrew-lock-wiring.spec.ts',
    drives: 'magicrewLockedError',
    anchor: "lockedError: magicrewLockedError('超级麦吉'),",
  },
  magicrewintl: {
    module: 'src/index.ts',
    spec: 'tests/unit/magicrew-lock-wiring.spec.ts',
    drives: 'magicrewLockedError',
    anchor: "lockedError: magicrewLockedError('MagiCrew (国际版)'),",
  },
}

describe('★ 普查：凡登记 permanentLock 的渠道，都必须有一条执行路径', () => {
  it('① 登记表与 `permanentLock: true` 的渠道集合**逐向对账**', () => {
    const declared = [...PERMANENT_LOCK_PROVIDERS].sort()
    const registered = Object.keys(LOCK_EXECUTION_PATHS).sort()
    // ⚠️ 这里原先写的是两条**对称**断言：`expect(registered).toEqual(declared)`
    //    紧跟 `expect(declared).toEqual(registered)`。`toEqual` 对数组是**对称**的
    //    ⇒ 第二条在第一条通过时**不可能单独失败**，所谓「双向一致」是**错觉**
    //    （第二轮对抗性审计实测：三个方向的变异 v1/v2/v3 都只让第一条红）。
    //    改成两个**差集**：判别力相同，但每条只负责一个方向，且**差集内容会被
    //    打进失败信息**（「谁多了、谁少了」一眼可见，不用自己 diff 两个数组）。
    expect(
      declared.filter(p => !registered.includes(p)),
      '声明了 `permanentLock: true` 却没有任何执行路径（锁了但不会真拦）',
    ).toEqual([])
    expect(
      registered.filter(p => !declared.includes(p)),
      '执行路径登记表里的渠道已不再声明 `permanentLock`（登记项陈旧）',
    ).toEqual([])
    expect(declared.length, '（数量随白名单走，刻意不写死在断言里）').toBeGreaterThan(0)
  })

  it('② 每条执行路径都指向真实存在的模块与守卫用例，且用例真引用了判别符号', () => {
    const censusSpec = resolve(repoRoot, 'tests/unit/permanent-lock-execution.spec.ts')
    for (const [provider, path] of Object.entries(LOCK_EXECUTION_PATHS)) {
      const module = resolve(repoRoot, path.module)
      const spec = resolve(repoRoot, path.spec)
      expect(existsSync(module), `${provider} 的执行路径模块不存在：${path.module}`).toBe(true)
      expect(existsSync(spec), `${provider} 的守卫用例不存在：${path.spec}`).toBe(true)

      // ⚠️ 判别符号必须**真的由那个模块导出**（否则 `drives` 写错名也照样绿）。
      expect(
        readFileSync(module, 'utf8').includes(path.drives),
        `${path.drives} 不在 ${path.module} 里 —— 登记表的「判别符号」写错了`,
      ).toBe(true)
      /**
       * ⚠️⚠️ **`anchor` 是这个判据的「带牙」版本**（2026-10-21 合并审计补）。
       *
       * ## 为什么光有 `drives` 不够
       *
       * 五个登记项（qoder / qodercn / astudio / minimax / minimaxintl）的
       * `module` 都是 `src/index.ts`，而 `drives` 是**裸符号**
       *（`qoderLockedError` / `astudioLockedError` / `minimaxLockedError`）。
       * 这些符号在 `index.ts` 里**各有定义 + 使用**两处 ⇒ 只做 `includes` 时，
       * **删掉使用点、定义仍在 ⇒ 恒真**。
       *
       * 实测三重变异（审计员独立复现，`permanent-lock-execution` 全部 10 passed = 无牙）：
       *
       * | 变异 | 只查 `drives` | 查 `anchor` |
       * |---|---|---|
       * | 删 `lockedError: astudioLockedError('AStudio')` 行 | **绿** | 红 |
       * | 整段删掉 astudio 的 `balance:{…}` 计划 | **绿** | 红 |
       * | 把 `selector` 换成不读锁定表的假实现 | **绿** | 红 |
       *
       * ⇒ `anchor` 必须是**带上下文的片段**（含调用形态），使「符号提到过」
       *   升级为「**该渠道的接线上真的用了它**」。
       *   缺 `anchor` 的旧登记退化成只看 `drives`（向后兼容），
       *   但 **`src/index.ts` 那五项必须填** —— 否则它们的判据是恒真的。
       */
      if (path.anchor !== undefined) {
        expect(
          readFileSync(module, 'utf8').includes(path.anchor),
          `${provider} 的接线锚点缺失：${path.module} 里找不到 \`${path.anchor}\`\n`
          + '  ⇒ 该渠道的 lockedError 或 balance 计划被删/被改成别的实现'
          + '（锁定仍会「显示已锁」，但没有任何执行路径可拦 —— 假开关）。\n'
          + '  ⚠️ 只查裸符号（`drives`）抓不到这种删除：符号的**定义**还在文件里。',
        ).toBe(true)
      }

      const specSource = readFileSync(spec, 'utf8')
      expect(
        specSource.includes(provider),
        `${provider} 的执行路径指向 ${path.spec}，但那里一个字都没提它（指针已腐坏）`,
      ).toBe(true)
      // ⚠️ 这两条是「注释自称比判据强」那类问题的解药：只查渠道名时，
      //    **指向本普查文件**就能全绿（它含全部六家名字）；判别符号挡住了它。
      expect(spec, `${provider} 的守卫用例不能指向普查文件自己`).not.toBe(censusSpec)
      expect(
        specSource.includes(path.drives),
        `${provider} 的守卫用例 ${path.spec} 没有引用判别符号 ${path.drives}`
        + '（它可能只是「提到了这个渠道」，并没有驱动那条路径）',
      ).toBe(true)
    }
  })

  /**
   * ★★ **`module === 'src/index.ts'` 的登记项必须填 `anchor`**
   * （2026-10-21 合并审计补，防「判据悄悄退化成恒真」）。
   *
   * 五家（qoder / qodercn / astudio / minimax / minimaxintl）的执行路径都在
   * `src/index.ts`，而它们的 `drives` 是裸符号 —— 符号在那里**既有定义又有使用**，
   * 只查 `includes` 时**删掉使用点仍然为真**（实测三重变异全绿）。
   *
   * 修复不会靠「记得填」：本用例强制要求。将来再加一个 `index.ts` 类登记项却
   * 忘了 `anchor` ⇒ 当场红，而不是静默变回无牙。
   */
  it('★★ `index.ts` 类登记项必须填 `anchor`（否则判据退化成「符号在文件里」）', () => {
    const missing = Object.entries(LOCK_EXECUTION_PATHS)
      .filter(([, path]) => path.module === 'src/index.ts' && path.anchor === undefined)
      .map(([provider]) => provider)
    expect(
      missing,
      '这些渠道的执行路径在 src/index.ts，但登记表没填 `anchor` ⇒ '
      + '删除接线后本普查仍会绿（裸符号的定义还在文件里）',
    ).toEqual([])
    // 自检：确实存在 index.ts 类登记项（否则本用例是同义反复）。
    const indexEntries = Object.values(LOCK_EXECUTION_PATHS).filter((p) => p.module === 'src/index.ts')
    expect(indexEntries.length, '列表为空 ⇒ 上面那条恒真').toBeGreaterThan(0)
  })

  it('③ 窗口文案的判据与注册表**同出一个字段**（`usesExpiryWindow`）', () => {
    // ⚠️ 这条锁的是一个**具体的历史缺陷**：officeace 登记了 `permanentLock`
    //    却在客户端拿到 Loomy 那套「今日额度用尽即无可用账号」的文案 ——
    //    因为文案的判据当时是一份**手抄名单**（buddy/workbuddy/trae/lobsterai）。
    //    现在两侧同出 `usesExpiryWindow`，本条钉住「同源」这件事不再退化。
    for (const provider of PERMANENT_LOCK_PROVIDERS) {
      const usesWindow = descriptorOf(provider)?.usesExpiryWindow === true
      const copy = permanentLockCopy(provider, 7)
      // 走窗口文案 ⇒ `days` 是数字且文案里出现窗口天数；否则走 Loomy 那套（`days: null`）。
      expect(copy.days === 7, `${provider} 的文案分派与 usesExpiryWindow 不一致`).toBe(usesWindow)
      expect(copy.lockedTitle.includes('7 天内到期'), provider).toBe(usesWindow)
    }
    // 两侧的**具体归属**也要钉住（否则「大家都走窗口文案」也能全绿）。
    expect(descriptorOf('officeace')?.usesExpiryWindow, 'officeace 是按到期时间分桶的').toBe(true)
    expect(descriptorOf('trae')?.usesExpiryWindow).toBe(true)
    expect(descriptorOf('lobsterai')?.usesExpiryWindow).toBe(true)
    expect(descriptorOf('loomy')?.usesExpiryWindow ?? false, 'loomy 没有「N 天窗口」概念').toBe(false)
    expect(permanentLockCopy('loomy', 7).days, 'loomy 必须留在「每日赠送额度」那套文案').toBeNull()
  })
})

/**
 * ## B：officeace 的执行路径**真的会拒**（驱动真实 `apply()`）
 *
 * ⚠️ `ctx.llm.registerAdapter` 拿到的那个对象是**若干层 Proxy**，但
 *    `options` 是直通的（`buddy-permanent-lock.spec.ts` 同款取法已在跑）⇒
 *    这里取到的是 `apply()` 里**真的**交给适配器的那个 `credentialProvider`。
 */
describe('★ officeace：锁定真的被执行（驱动 apply()，真读 permanent-locks.json）', () => {
  const dirs: string[] = []

  beforeEach(() => {
    // ⚠️ 双保险：单测绝不发真实网络（余额入口已在模块级 mock 掉，
    //    这里再兜住续期链/目录拉取）。
    vi.stubGlobal('fetch', async () => { throw new Error('单测不发网络') })
    mocked.mockReset()
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
    async set(ref: unknown, value: string): Promise<void> { this.store.set(this.key(ref), value) }
    async unset(ref: unknown): Promise<void> { this.store.delete(this.key(ref)) }
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-officeace-lock-'))
    dirs.push(dir)
    process.env.DSH_JET_HUB_STATE_DIR = dir
    const ctx = new Context() as TestCtx
    ctx.provide('credentials', new FakeCredentials() as never)
    ctx.provide('commands', new FakeCommands() as never)
    ctx.provide('llm', new FakeLlm() as never)
    apply(ctx as never)
    return ctx
  }

  /** `apply()` 真的交给 officeace 适配器的那个 `credentialProvider`。 */
  function credentialProviderOf(ctx: TestCtx): () => Promise<unknown> {
    const adapter = ctx.llm.adapterByProvider.get('officeace') as
      | { options?: { credentialProvider?: () => Promise<unknown> } }
      | undefined
    expect(adapter, 'officeace 未注册').toBeDefined()
    const fn = adapter?.options?.credentialProvider
    expect(typeof fn, 'officeace 适配器没拿到 credentialProvider').toBe('function')
    return fn as () => Promise<unknown>
  }

  /** 加一个 officeace 账号（凭据形状过 `readCredential` 的校验）。 */
  async function addAccount(ctx: TestCtx, tag: string): Promise<string> {
    const id = `acct_officeace_${tag}`
    const ref = `OFFICEACE_ACCOUNT_${tag.toUpperCase()}`
    await ctx.accountPool.addAccount({
      id, provider: 'officeace', nickname: id, enabled: true, credentialRef: ref,
      createdAt: 0, refreshable: true,
    })
    await ctx.credentials.set(credentialRef(ref), JSON.stringify({
      modelAppKey: `key-${tag}`, modelAppSecret: `secret-${tag}`,
      maasBaseUrl: 'https://modelgw-0004.example.invalid',
      access: 'ak', secret: 'sk', securityToken: 'tok', projectId: 'p',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshToken: 'rt', dpopPrivateJwk: {},
    }))
    return ref
  }

  /** 造一份订阅摘要（`groups` 是积分桶）。 */
  function summary(groups: Array<{ remaining: number; expiresAt?: string }>) {
    return {
      totalCredits: groups.reduce((sum, g) => sum + g.remaining, 0),
      usedCredits: 0,
      creditGroups: groups.map((g, i) => ({
        key: `g${i}`, name: `桶${i}`, remaining: g.remaining, total: g.remaining,
        ...g.expiresAt === undefined ? {} : { expiresAt: g.expiresAt },
      })),
    }
  }

  const SOON = new Date(Date.now() + 3 * DAY).toISOString()
  const FAR = new Date(Date.now() + 300 * DAY).toISOString()

  it('★★ ① 锁定 + 只剩永久桶 ⇒ 抛错，**绝不**交出池里的凭据（缺陷 ① 的验收）', async () => {
    const ctx = boot()
    await ctx.accountPool.setPermanentLocked('officeace', true)
    const ref = await addAccount(ctx, 'a')
    mocked.mockResolvedValue(summary([{ remaining: 6500, expiresAt: FAR }]) as never)
    const error = await credentialProviderOf(ctx)().then(() => undefined, (e: Error) => e)
    expect(error, '锁定时必须抛错 —— 改前这里会静默返回池里的凭据并烧掉永久积分').toBeDefined()
    expect(error?.message, '理由必须是「确实只剩永久桶」，不是「查不到」')
      .toContain('没有可用账号')
    // ⚠️ 文案不得把「服务端扣减顺序」说成我们能控制的事。
    expect(error?.message).toContain('扣减顺序由服务端决定')
    void ref
  })

  it('★ ② 锁定 + 有临期桶 ⇒ 正常返回该账号凭据（阳性对照：不是「恒抛错」）', async () => {
    const ctx = boot()
    await ctx.accountPool.setPermanentLocked('officeace', true)
    await addAccount(ctx, 'a')
    mocked.mockResolvedValue(summary([{ remaining: 1000, expiresAt: SOON }]) as never)
    const credential = await credentialProviderOf(ctx)() as { modelAppKey?: string }
    expect(credential?.modelAppKey, '有 15 天内到期的额度时必须照常可用').toBe('key-a')
  })

  it('★ ③ 锁定 + 两个账号 ⇒ 换到有临期额度的那个（而不是直接报「没有可用账号」）', async () => {
    const ctx = boot()
    await ctx.accountPool.setPermanentLocked('officeace', true)
    await addAccount(ctx, 'a')
    await addAccount(ctx, 'b')
    mocked.mockImplementation((async (_stale: number, ref?: string) =>
      ref === 'OFFICEACE_ACCOUNT_A'
        ? summary([{ remaining: 6500, expiresAt: FAR }])
        : summary([{ remaining: 800, expiresAt: SOON }])) as never)
    const credential = await credentialProviderOf(ctx)() as { modelAppKey?: string }
    expect(credential?.modelAppKey, 'a 只剩永久桶，b 有临期额度 ⇒ 必须换到 b').toBe('key-b')
  })

  it('④ 解锁 + 只剩永久桶 ⇒ 正常返回（解锁真的生效，且是阳性对照）', async () => {
    const ctx = boot()
    await ctx.accountPool.setPermanentLocked('officeace', false)
    await addAccount(ctx, 'a')
    mocked.mockResolvedValue(summary([{ remaining: 6500, expiresAt: FAR }]) as never)
    const credential = await credentialProviderOf(ctx)() as { modelAppKey?: string }
    expect(credential?.modelAppKey).toBe('key-a')
  })

  it('⑤ 锁定状态只按 provider 读：锁 officeace 不影响 buddy 的行为', async () => {
    // ⚠️ 判据是「读的是不是本 provider 的那一格」。若有人把它写成全局开关，
    //    officeace 与 buddy 会一起被锁 —— 本用例只钉 officeace 这一侧
    //    （buddy 侧由 `buddy-permanent-lock.spec.ts` 钉）。
    const ctx = boot()
    await ctx.accountPool.setPermanentLocked('buddy', true)
    await addAccount(ctx, 'a')
    mocked.mockResolvedValue(summary([{ remaining: 6500, expiresAt: FAR }]) as never)
    const credential = await credentialProviderOf(ctx)() as { modelAppKey?: string }
    expect(credential?.modelAppKey, '锁的是 buddy ⇒ officeace 不得受影响').toBe('key-a')
  })

  it('⑥ 窗口天数与面板文案同源（同一个环境变量，且非默认值也跟随）', () => {
    // 面板的 `windowDays` 与实际筛号必须同一个数，否则文案会承诺一个筛不出来
    // 的窗口（`credits.permanentLock` RPC 也回传同一个函数）。
    expect(buddyExpiringWindowDays()).toBeGreaterThan(0)
    // ⚠️ 只断言「> 0」是**无牙**的（第一轮审计「中等 1」）：那样即使把窗口写死成
    //    15 天也全绿。这里钉住「env 真的被读到、非默认值真的生效」；
    //    「筛号与文案同时跟随」由 `officeace-lock.spec.ts` 的 ⑨ 驱动真实 provider 钉。
    const before = process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
    try {
      process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = '31'
      expect(buddyExpiringWindowDays(), '面板回传的窗口必须读 env，不能写死').toBe(31)
      expect(permanentLockCopy('officeace', buddyExpiringWindowDays()).lockedTitle)
        .toContain('31 天内到期')
    } finally {
      if (before === undefined) delete process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS
      else process.env.DSH_BUDDY_EXPIRING_WINDOW_DAYS = before
    }
  })

  /** `apply()` 真的交给 officeace 适配器的那个 `probeCredential`（只读目录探测）。 */
  function probeCredentialOf(ctx: TestCtx): () => Promise<unknown> {
    const adapter = ctx.llm.adapterByProvider.get('officeace') as
      | { options?: { probeCredential?: () => Promise<unknown> } }
      | undefined
    const fn = adapter?.options?.probeCredential
    expect(typeof fn, 'officeace 适配器没拿到 probeCredential').toBe('function')
    return fn as () => Promise<unknown>
  }

  it('★★ ⑦ 锁定只约束「推理取号」，**不得**把只读目录一起关掉', async () => {
    // ⚠️ 这条是缺陷 ① 修好之后**自查发现的连带回归**（2026-10-15）：
    //    第一版把 `credentialProvider`（锁定态会抛错）留在 `listModels` 里，
    //    而 `listModels` 的调用方**全都不接这个错**（`dsh-llm` 直接 `await`）
    //    ⇒ 锁定后 `listModels` 抛错，症状是面板「读取模型列表失败：…锁定…」、
    //    「关闭供应商」被 `remoteError` 拒、聚合静默少一个候选、模型选择器分组消失。
    //    判据：**锁定 + 只剩永久桶** 时，目录探测凭据照常给出（`/v2/models` 与
    //    倍率都是只读、不扣积分的端点），而推理那条路仍然抛错。
    const ctx = boot()
    await ctx.accountPool.setPermanentLocked('officeace', true)
    await addAccount(ctx, 'a')
    mocked.mockResolvedValue(summary([{ remaining: 6500, expiresAt: FAR }]) as never)

    // ① 只读探测：必须真的交出凭据（否则 `listModels` 连探测都发不出去）。
    const probe = await probeCredentialOf(ctx)() as { modelAppKey?: string }
    expect(probe?.modelAppKey, '锁定不得牵连只读目录探测').toBe('key-a')
    // ② 同一时刻的推理取号：仍必须抛错（不能因为共用一份实现而放松锁定）。
    const error = await credentialProviderOf(ctx)().then(() => undefined, (e: Error) => e)
    expect(error?.message, '只读探测放行后，推理侧仍必须拒绝').toContain('没有可用账号')

    // ③ 端到端：真调 `listModels()` 不得 reject（fetch 被 stub 成必然失败 ⇒
    //    探测不通过、诚实地返回空目录，但**绝不能抛错**）。
    const adapter = ctx.llm.adapterByProvider.get('officeace') as
      { listModels(provider: string): Promise<unknown[]> }
    await expect(adapter.listModels('officeace'), '锁定后 listModels 抛错 = 分组消失 + 面板报错')
      .resolves.toEqual([])
  })
})
