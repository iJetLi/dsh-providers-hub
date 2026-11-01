import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createProviderCredits } from '../../src/provider-credits.js'
import { createProviderOnboarding, onboardingOf } from '../../src/provider-onboarding.js'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSource = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')

/**
 * Raccoon 的 RPC 分派（源码级回归）。
 *
 * ⚠️ 为什么用源码扫描而不是实例化端点：`registerJetHubRpc` 的 auths 是**命名对象**
 * （13 个键，键是 provider id），在测试里逐个填替身既脆弱又与既有
 * `jet-hub-rpc.spec.ts` 的桩重复。
 * （2026-10-08 改措辞：此处原写「参数是**位置参数**（12 个）」，那是 Task 9 之前的形态。）
 * 本文件锁的是**语义约定**（哪个分支返回什么形状），那些约定一旦写错，
 * 表现为「UI 显示矛盾的数字」这类**单测容易漏掉**的问题。
 *
 * 更深的行为验证在 `tests/unit/jet-hub-rpc.spec.ts`（复用它的端点桩）。
 */
describe('Raccoon 的 RPC 分派', () => {
  it('六条路径都已接上', () => {
    // ⚠️ 用「先定位分支起点，再在切片里查找」而不是大跨度正则 ——
    // 后者对字符数敏感（注释一变就误报），也难看出断裂处。
    const branchOf = (anchor: string, size = 3000): string => {
      const start = rpcSource.indexOf(anchor)
      expect(start, `未找到锚点：${anchor}`).toBeGreaterThan(-1)
      return rpcSource.slice(start, start + size)
    }

    // account.create
    expect(branchOf('} else if (provider === RACCOON.id)')).toMatch(/raccoon\.startLogin\(\)/)
    // account.refresh
    //
    // ⚠️ 2026-10-08 改（Task 2）：原先这里是 `branchOf('case RACCOON.id:')`
    //    + `/raccoon\.refreshAccountCredential/` —— 一个**源码文本**断言。
    //    Task 2 把 13 个同构 `case` 换成一处查表（`authOf(auths, entry.provider)`）
    //    ⇒ `case RACCOON.id:` 这个形态**不存在了**，而它守的意图
    //    （raccoon 账号的续期落到 raccoon 实例上）**与文本无关**。
    //    ⇒ 改为**行为断言**（真驱动端点、看哪个桩被调用），见
    //    `lobsterai-rpc-dispatch.spec.ts` 的「七个 provider 各自分派到对应服务」
    //    与「13 个 provider 逐个覆盖」两组用例 —— 它们用**派生**的
    //    `REFRESH_PROVIDERS` 清单，新增 provider 时自动跟上。
    //    此处保留一条**结构性**断言（而不是删掉整段）：确认 `account.refresh`
    //    真的走查表分派，而不是退回成某个 provider 专属的硬编码分支。
    expect(branchOf("case 'account.refresh':")).toMatch(/authOf\(auths, entry\.provider\)/)
    // credits.balances
    //
    // ⚠️ 2026-10-08 改（Task 3）：原先这里用注释锚点
    //    （`余额来自 \`GET /points/v1/balance\``）切出 credits.balances 的 raccoon
    //    分支，再断言里面含 `raccoon.fetchCreditBalance`。Task 3 把余额调用搬进了
    //    `src/provider-credits.ts` 的积分表 ⇒ 那段注释与调用在 `jet-hub-rpc.ts` 里
    //    **都不存在了**，而它守的意图（raccoon 的余额走它自己的协议原语、
    //    且端到端打到自己的上游路径）**与文本无关**。
    //    ⇒ 行为断言搬到了唯一一处（避免同一套 RPC 夹具在多文件重复）：
    //    `credits-runtime-parity.spec.ts` 的
    //    「★★ 逐家余额都走自己的上游端点」（真跑端点、核对请求 URL 含 `/balance`）
    //    + 「余额查询优先走传入的 auth 实例」（哨兵证明走的是实例方法）。
    //    本文件保留**结构性**断言：确认 credits.balances 真的走查表分派，
    //    而不是退回成某个 provider 专属的硬编码分支。
    // ⚠️ 窗口要**足够大**：查表分派排在 opencode 与 qoder 两个特例**之后**
    //    （它们必须短路），那两个块合计约 3.5 KB ⇒ 用默认的 3000 会切不到查表行，
    //    变成一条恒假的断言。用**下一个 case**（`cline.quota`）作右边界最稳。
    const balanceStart = rpcSource.indexOf("case 'credits.balances':")
    expect(balanceStart, '找不到 credits.balances 分支').toBeGreaterThan(-1)
    const balanceEnd = rpcSource.indexOf("case 'cline.quota':", balanceStart)
    expect(balanceEnd, '找不到 cline.quota 分支（右边界）').toBeGreaterThan(balanceStart)
    expect(rpcSource.slice(balanceStart, balanceEnd))
      .toMatch(/creditsOf\(credits, req\.provider\)/)
    // credits.claimAll（显式拒绝）
    //
    // ⚠️ 2026-10-08 改（Task 4）：原先这里断言 `rpcSource` 里含
    //    「Raccoon Work 不支持每日签到」那串**源码文本**。Task 4 把文案搬到
    //    `src/provider-credits.ts` 的 `claimUnavailableReason`（那是它该在的地方
    //    —— 知道该产品形态的那一层），字面量于是**搬了家**，而它守的意图
    //    （raccoon 调 claimAll 会拿到**指明原因**的拒绝、不退化成
    //    `unsupported provider`）**与文本位置无关**。
    //    ⇒ 改为**行为**断言，搬到唯一一处（避免同一套 RPC 夹具在多文件重复）：
    //    `tests/unit/claim-runtime-parity.spec.ts` 的
    //    「cline / workbuddy / raccoon 各回**逐字保留**的可读原因」——
    //    它真跑端点、逐字核对文案，**比原断言更强**（文本断言只能证明源码里有
    //    那串字符，它能证明端到端响应里就是那句话）。
    //    本文件保留**声明值**断言（廉价的语义锚点，且能发现文案被整段删掉）。
    expect(createProviderCredits().raccoon?.claimUnavailableReason)
      .toContain('每日积分由服务端自动发放')
    // onboarding.status / onboarding.claim
    //
    // ⚠️ 同上（Task 4）：原先断言源码里含 `raccoon.fetchOnboardingStatus` /
    //    `raccoon.claimLoginReward`。Task 4 把两家的实现搬进
    //    `src/provider-onboarding.ts` 的表 ⇒ 那两串**在 `jet-hub-rpc.ts` 里不存在了**，
    //    而意图（raccoon 的这两条路径接上了、且走它自己的原语）与文本无关。
    //    ⇒ 行为断言在 `claim-runtime-parity.spec.ts` 的
    //    「raccoon 已领时 earned 报**满分**」+「onboarding.status 走注入的表」。
    //    本文件保留**表内容**断言：raccoon 在表里且两条方法都在。
    const onboarding = createProviderOnboarding({
      raccoon: {
        fetchOnboardingStatus: async () => ({ claimed: false, points: 3000 }),
        claimLoginReward: async () => ({ kind: 'already-claimed', message: '' }),
      },
    })
    expect(onboarding.raccoon?.status, 'raccoon 缺少 onboarding.status').toBeTypeOf('function')
    expect(onboarding.raccoon?.claim, 'raccoon 缺少 onboarding.claim').toBeTypeOf('function')
  })

  /**
   * ⚠️ 2026-10-08 改（Task 4）：原先数源码里
   * `req.provider !== LOOMY.id && req.provider !== RACCOON.id` 出现 ≥2 次
   * （两个端点各一处）。Task 4 把判据从「属于 {loomy, raccoon}」改成
   * 「**该家是否提供该能力**」（查 `provider-onboarding.ts` 的表）——
   * 那是**更强的**判据：新增一家只需在表里加一条，不会再出现
   * 「两个端点各写一份名单、漏改一处就静默失效」的形态。
   * ⇒ 断言改为**表内容 + 行为**：两家都在表里，且未登记的 id 被拒。
   */
  it('onboarding 的能力表含 loomy 与 raccoon（共用端点，判据由表给出）', async () => {
    const onboarding = createProviderOnboarding()
    // ⚠️ 2026-11-01 加 magicrew / magicrewintl（超级麦吉 + MagiCrew 国际版）：
    //    两家共用 `src/magicrew-checkin.ts` 的 onboarding 实现，只差 product 常量。
    //    ⚠️ 国际站 `onboarding/tasks` **恒返回空数组**（账号没被登记进引导计划），
    //    但代码照样登记 —— 能领就领，领不到如实报 0 项。
    expect(Object.keys(onboarding).sort(), '能力表漏了某一家的新手任务')
      .toEqual(['loomy', 'magicrew', 'magicrewintl', 'raccoon'])
    for (const id of ['loomy', 'raccoon', 'magicrew', 'magicrewintl']) {
      expect(onboarding[id]?.status, `${id} 缺少 status`).toBeTypeOf('function')
      expect(onboarding[id]?.claim, `${id} 缺少 claim`).toBeTypeOf('function')
    }
    // 反向：未登记的 provider 必须查不到（否则会走到别人的实现上）。
    expect(onboardingOf(onboarding, 'buddy')).toBeUndefined()
    // ⚠️ 原型链键不得命中（与 creditsOf / authOf 同因）。
    expect(onboardingOf(onboarding, 'constructor')).toBeUndefined()
  })

  /**
   * ⚠️ **真实缺陷回归**（用户报障）：
   *
   * 账号已领过登录奖励时，UI 显示
   * 「✅ 1 个此前已完成 / 累计已领 **0** / 3000」—— **自相矛盾**：
   * 既然「此前已完成」，那 3000 分显然已经拿到手了。
   *
   * 根因：`onboarding.claim` 的 `already-claimed` 分支把 `earned` 写成 0，
   * 而客户端直接显示 `累计已领 ${res.earned} / ${res.total}`。
   *
   * 正确语义：`earned` 回答「该项目**累计**领到多少」，与「本次是否新增」无关。
   * 故已领时必须报满分。
   *
   * ⚠️ 2026-10-08 改（Task 4）：原先是**源码文本**断言（抓 `onboarding.claim`
   *    分支的 return 块正则）。Task 4 把 raccoon 的这条逻辑搬进
   *    `src/provider-onboarding.ts` 的表 ⇒ 那段文本**不在 `jet-hub-rpc.ts` 里了**，
   *    而它守的意图（已领时 `earned` 报满分）**与文本位置无关**。
   *    ⇒ 改为**真调表里的实现**并断言返回值 —— 这比文本断言强：文本断言只能
   *    证明源码里有 `earned: points` 这串字符，它能证明**返回值真的是满分**。
   *    ⚠️ 这是**替换**而不是「两处都留」：同一语义不许有两套判据。
   */
  it('⚠️ onboarding.claim 已领时 earned 报满分（不是 0）', async () => {
    const onboarding = createProviderOnboarding({
      raccoon: {
        // 账单反查回 3000（与 status 同一数据源）。
        fetchOnboardingStatus: async () => ({ claimed: true, points: 3000 }),
        // 已领：服务端幂等返回 granted:false。
        claimLoginReward: async () => ({
          kind: 'already-claimed', message: '该账号已领取过桌面端登录奖励（每号一次）',
        }),
      },
    })
    const result = await onboarding.raccoon!.claim!({ access_token: 'AT' }, {} as never)
    expect(result.skipped, '已领时必须把该项列进 skipped').toEqual(['desktop_login_reward'])
    expect(result.claimed, '已领时本次没有新增项').toEqual([])
    expect(
      result.earned,
      'earned 在已领分支归零了 —— UI 会显示「已完成 / 累计已领 0」这种自相矛盾的数字',
    ).toBe(3000)
    expect(result.total).toBe(3000)
  })

  it('已领时的金额从账单反查（与 onboarding.status 同一数据源）', async () => {
    // ⚠️ 2026-08 改（Task 4）：原先扫源码文本找 `fetchOnboardingStatus`。
    //    改为**行为**：把账单反查的返回值设成与领取响应**不同**的哨兵，
    //    断言已领路径真的用了**账单**那个数（而不是编一个 0 / 领取响应里的值）。
    let statusQueries = 0
    const onboarding = createProviderOnboarding({
      raccoon: {
        fetchOnboardingStatus: async () => { statusQueries++; return { claimed: true, points: 4242 } },
        claimLoginReward: async () => ({ kind: 'already-claimed', message: '' }),
      },
    })
    const result = await onboarding.raccoon!.claim!({ access_token: 'AT' }, {} as never)
    expect(statusQueries, '已领路径没有查账单 —— 金额可能与 status 显示的不一致').toBe(1)
    expect(result.earned, '已领时的金额必须取自账单（哨兵 4242）').toBe(4242)
  })

  it('credits.claimAll 的拒绝文案含「每日积分由服务端自动发放」', () => {
    // 该文案是可操作提示的来源；写成泛化的 unsupported provider
    // 会让排查者误以为「provider 没注册」。
    //
    // ⚠️ 2026-10-08 改（Task 4）：原先扫 `jet-hub-rpc.ts` 的源码文本。Task 4
    //    把文案搬到 `src/provider-credits.ts` 的 `claimUnavailableReason`
    //    （那是它该在的地方 —— 知道该产品形态的那一层），字面量**搬了家**。
    //    ⇒ 改为读**表里的声明值**；「端到端响应里就是这句话」由
    //    `claim-runtime-parity.spec.ts` 的「cline / workbuddy / raccoon 各回
    //    逐字保留的可读原因」守（真跑端点、逐字核对）。
    expect(createProviderCredits().raccoon?.claimUnavailableReason)
      .toContain('每日积分由服务端自动发放')
    // 反向：确认它**不是**泛化文案（否则上面那条可能被一句套话满足）。
    expect(createProviderCredits().raccoon?.claimUnavailableReason)
      .not.toContain('unsupported provider')
  })

  it('account.create 的失败路径都删除占位条目（不留幽灵账号）', () => {
    const createStart = rpcSource.indexOf('provider === RACCOON.id')
    const branch = rpcSource.slice(createStart, createStart + 3000)
    /**
     * ⚠️ 2026-10-14 改（Gitee issue IKLI7J）：后台 catch 原先自己写
     * `pool.removeAccount(id)`，现统一走 `failLogin(id, error)` —— 它**同时**
     * 做两件事：记登录终态失败（供 `login.poll` 报给前端）+ 删占位条目。
     * ⇒ 两条腿必须分开断言：只数 `pool.removeAccount(id)` 会把后台那条判成
     * 「漏删」而假红；反过来只看 `failLogin` 又会漏掉同步抛错那条。
     */
    // ① 同步路径：`startLogin` 抛错 → 删条目后 throw（客户端立刻看到错误）
    expect(branch, 'startLogin 抛错路径必须删占位条目').toContain('pool.removeAccount(id)')
    // ② 异步路径：后台 catch → 共享收尾（删条目 + 记终态原因）
    expect(branch, '后台失败路径必须走 failLogin（删条目 + 记终态原因）')
      .toMatch(/failLogin\(id,\s*error\)/)
  })

  it('account.create 回填 refreshable（raccoon 有 refresh 端点）', () => {
    const createStart = rpcSource.indexOf('provider === RACCOON.id')
    const branch = rpcSource.slice(createStart, createStart + 3000)
    // ⚠️ 不能像 Loomy 那样写死 false
    expect(branch).toMatch(/refreshable:\s*result\.refreshable/)
  })
})
