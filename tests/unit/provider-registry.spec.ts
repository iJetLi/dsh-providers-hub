import { describe, expect, it } from 'vitest'
import {
  PROVIDER_REGISTRY,
  creditCapabilitiesOf,
  descriptorOf,
} from '../../src/provider-registry.js'

describe('ProviderDescriptor：与既有产物的逐条一致性', () => {
  it('id 一律纯小写字母（带连字符会让四处正则断言静默漏算）', () => {
    for (const d of PROVIDER_REGISTRY) {
      expect(d.id, `${d.id} 必须纯小写字母`).toMatch(/^[a-z]+$/)
    }
  })

  it('id 不重复', () => {
    const ids = PROVIDER_REGISTRY.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个 provider 都有非空 label / logoClass', () => {
    // ⚠️ 不断言 icon：registry **刻意不持有图标**（那会让宿主产物白白背上
    //    几十 KB 的 data URI 字面量，而宿主从不使用图标）。图标在客户端的
    //    PROVIDER_ICONS 里，由 Step 8 那条「两边 id 集合相等」的守卫覆盖。
    for (const d of PROVIDER_REGISTRY) {
      expect(d.label.length, `${d.id} 缺 label`).toBeGreaterThan(0)
      expect(d.logoClass.length, `${d.id} 缺 logoClass`).toBeGreaterThan(0)
    }
  })

it('共 24 条（23 个真渠道 + aggregate；codely 2026-10-22 已翻 channel:true）', () => {
    // ⚠️ 2026-10-13 合并：officeace（第 15）与 accio（第 16）**同一次**并入，
    //    故从 15/14 直接跳到 17/16 —— 不是漏了一格。
    // ⚠️ 2026-10-15 加 minimaxintl（MiniMax Code 国际版，第 17 个真渠道）：
    //    它与 `minimax` 账号不互通、API 主机不同 ⇒ 是两个 provider。
    // ⚠️ 2026-10-16 并入 astudio（第 18 个真渠道）。
    // ⚠️ 2026-10-17 加 autoclaw（AutoClaw/智谱，第 19 个真渠道）。
    // ⚠️ 2026-10-16 **本 fork** 并入 modelscope（魔搭，第 20 个真渠道）：上游没有它。
    // ⚠️ 2026-10-20 加 autoclawintl（AutoClaw 国际版，第 21 个真渠道）：
    //    与 autoclaw 账号不互通（手机号 / 邮箱）、API 主机不同、**登录方式也不同**
    //    ⇒ 与 minimaxintl 同款判据（实测国内 token 打国际基址 → `401 Invalid token`）。
    //    ⚠️ 合并上游时**不要**把这里改回上游数字 —— 那会让两个声明都失去守卫
    //    （条数断言是「注册表没被误删」的唯一防线）。
    // ⚠️ 2026-10-20 合并 remote master 时 astudio 随上游并入（21 → 22 条），而本条
    //    期望值当时仍是上游的 21 ⇒ 变红。按**注册表事实**更正为 22（这条断言是
    //    「注册表没被误删」的唯一防线，数字必须跟着注册表走，不能反向改注册表凑数）。
    // ⚠️ 2026-10-29：并入 **qiniu（七牛云）** ⇒ 23 → 24（同批 channel 22 → 23）。
    //    数字必须跟着注册表走，不能反向改注册表凑数。
    // ⚠️ 2026-10-29 加 magicrew（超级麦吉国内站，第 23 个真渠道）：位置有硬要求
    //    （**紧邻 aggregate 之前 = 倒数第二**），由下面「声明序在 aggregate 之前」那条守着。
    // ⚠️ 2026-11-02 并入 **monkeycode（MonkeyCode）** ⇒ 26 → 27（同批 channel 25 → 26）。
    //    ⚠️ 它的**声明位置刻意放在 magicrewintl 之前**（不是 aggregate 之前）：
    //    上面那条「MagiCrew 国际版必须紧邻 aggregate 之前（= 倒数第二）」是硬断言，
    //    把新 provider 插在两者之间会把它挤成倒数第三 ⇒ 直接变红。
    //    新增 provider 一律插在**最后一个「紧邻 aggregate」的条目之前**。
    // ⚠️ 2026-11-02 并入 **monkeycodeintl（MonkeyCode 国际站）** ⇒ 27 → 28
    //    （同批 channel 26 → 27）。它是**独立部署**（国内 cookie 打国际站回 401）
    //    ⇒ 必须是独立 provider id，不能靠凭据字段区分。
    // ⚠️ 2026-11-02 并入 **baizhi（百智云）** ⇒ 28 → 29（channel 27 → 28）。
    //    ⚠️ 它**不是** MonkeyCode 的第三站：认证是 `x-api-key: sk-…`、计费是
    //    按量付费（没有每日 token 额度、没有签到）。
    //    `credits` 是 `{ balance: true, dailyCheckin: false }` —— 余额能读
    //    （控制台 `GET /api/v1/user/wallet/balance`，**cookie 认证**），
    //    签到不能做（每日临时积分领取要过验证码，实测 400
    //    `captcha binding mismatch`）⇒ 与两站的 `{balance:true,dailyCheckin:true}`
    //    只差签到一项（2026-11-02 同日二版更正：一版曾写 `balance: false`）。
    expect(PROVIDER_REGISTRY).toHaveLength(29)
    // ⚠️ 2026-10-22（A6）：codely **已翻 `channel: true`** —— 它的推理 / 目录 / 余额 / 签到 / 续期全部已接线，
    //    而 `channel` 在生产代码里**零个读取点** ⇒ 原来那个 `false` 只是为了让守卫不变红而选的，它同时把 codely 挡在聚合目录之外。现在真实接线已完成，翻正。
    expect(PROVIDER_REGISTRY.filter((d) => d.channel).length).toBe(28)
    expect(
      PROVIDER_REGISTRY.find((d) => d.id === 'codely')?.channel,
      'codely 已接线完成，必须是 channel: true（否则它的模型永不进聚合目录）',
    ).toBe(true)
  })

  /**
   * ⚠️⚠️ **声明序 = 设置页左栏的默认渲染序**（2026-10-17，用户报障）。
   *
   * 未自定义 `providerOrder` 时，左栏完全按 `PROVIDER_REGISTRY` 的**声明序**
   * 渲染（`sortOpenProvidersByOrder` 对空序是恒等函数）；而已关闭组**恒按声明序
   * 沉底**、永不被自定义序覆盖。
   *
   * ⚠️ 本条守的是**相对位置**而非绝对下标：新增 provider 时下标必然漂移，
   * 钉死数字会变成「必然过期」的快照（仓库对这类魔数断言有明确教训）。
   *
   * 需求：ModelScope 的设置标签应排在**聚合之上**。
   */
  it('★ modelscope 的声明序在 aggregate 之前（设置页左栏的默认渲染序）', () => {
    const ids = PROVIDER_REGISTRY.map((d) => d.id)
    const im = ids.indexOf('modelscope')
    const ia = ids.indexOf('aggregate')
    expect(im, 'registry 里找不到 modelscope').toBeGreaterThan(-1)
    expect(ia, 'registry 里找不到 aggregate').toBeGreaterThan(-1)
    expect(im, 'ModelScope 必须排在聚合之上，否则它在左栏会被排到聚合下面')
      .toBeLessThan(ia)
  })

  /**
   * ⚠️ 需求：magicrew 的设置标签应排在**聚合之上**（= 倒数第二）。
   *
   * 与 modelscope 那条同因同形（未自定义 `providerOrder` 时，左栏完全按
   * `PROVIDER_REGISTRY` 的**声明序**渲染）。守相对位置而非绝对下标。
   */
  it('★ magicrew / magicrewintl 的声明序在 aggregate 之前（= 倒数第二、倒数第三）', () => {
    const ids = PROVIDER_REGISTRY.map((d) => d.id)
    const im = ids.indexOf('magicrew')
    const ii = ids.indexOf('magicrewintl')
    const ia = ids.indexOf('aggregate')
    expect(im, 'registry 里找不到 magicrew').toBeGreaterThan(-1)
    expect(ii, 'registry 里找不到 magicrewintl').toBeGreaterThan(-1)
    expect(ia, 'registry 里找不到 aggregate').toBeGreaterThan(-1)
    expect(im, 'Magicrew 必须排在聚合之上，否则它在左栏会被排到聚合下面').toBeLessThan(ia)
    // ⚠️ 2026-11-01 加国际版后，两站都必须排在聚合之上（左栏按声明序渲染）。
    expect(ii, 'MagiCrew 国际版必须排在聚合之上').toBeLessThan(ia)
    // 反面：两站必须**紧邻**地贴在 aggregate 之前（不是「排在前面某处」）——
    // 国际版紧邻 aggregate（倒数第二），国内版紧邻国际版（两站成组）。
    // ⚠️ 守的是**相对位置**而非绝对下标：新增 provider 时下标必然漂移。
    expect(ia - ii, 'MagiCrew 国际版必须紧邻 aggregate 之前').toBe(1)
    expect(ii - im, '国际版必须紧邻国内版之后（两站成组）').toBe(1)
  })

  it('★ 真实排出的左栏顺序与声明序一致（复刻客户端排序口径，非源码断言）', async () => {
    // ⚠️ 真跑客户端的排序纯函数：只测 registry 的相对位置不足以覆盖
    //    「用户已自定义过 providerOrder」这条路径（未出现在序里的项按声明序补后）。
    const { sortOpenProvidersByOrder } = await import('../../plugin-src/client/provider-toggle.js')
    const ids = PROVIDER_REGISTRY.map((d) => ({ id: d.id }))
    // 复刻本机实测的 providerOrder：自定义但**不含** aggregate / modelscope
    const order = ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'trae', 'cline',
      'loomy', 'raccoon', 'minimax', 'zcode', 'opencode', 'gemini', 'qoder', 'qodercn']
    const sorted = sortOpenProvidersByOrder(ids, order).map((p) => p.id)
    expect(sorted.indexOf('modelscope'),
      `实际左栏顺序：${sorted.join(' → ')}`).toBeLessThan(sorted.indexOf('aggregate'))
  })

  it('descriptorOf 按 id 取；未知返回 undefined', () => {
    expect(descriptorOf('buddy')?.label).toBe('CodeBuddy (腾讯)')
    expect(descriptorOf('nope')).toBeUndefined()
  })
})

describe('★★ 同族两站必须成对同构（国内站 / 国际站）', () => {
  /**
   * ## 为什么有这条（2026-11-01 三审实测发现）
   *
   * `magicrew` 的 JSDoc **从 2026-10-29 起就写着**「已登记 `creditPackages: true`」，
   * 但那个**字段本身根本不存在** —— 于是国内站账号卡片 hover 看不到资源包明细，
   * 而新接入的国际站因为登记了所以看得到。**两站不同构 + 注释与实现分家**，
   * 两个问题叠在一起，读注释的人以为一切正常。
   *
   * 这一类缺陷（「同族两站只改一边」）在本仓已复发多次
   *（`minimaxintl` / `autoclawintl` / `magicrewintl` 都记过），故这里**成对派生出判据**，
   * 而不是给每家手写一份快照（手写快照会把「漏项」固化成期望值 —— 见 autoclaw 那次）。
   */
  const PAIRS: readonly (readonly [string, string])[] = [
    ['magicrew', 'magicrewintl'],
    ['minimax', 'minimaxintl'],
    ['autoclaw', 'autoclawintl'],
    ['qoder', 'qodercn'],
  ]

  /**
   * 这些字段**必须两站一致**：它们描述的是「同一份实现、同一个上游」的能力，
   * 与站点（host）无关 ⇒ 不一致就是漏登记。
   */
  const SAME_FIELDS = ['creditPackages', 'usesExpiryWindow', 'permanentLock', 'rateLimit', 'channel'] as const

  it.each(PAIRS)('★★ %s 与 %s 的能力位逐项一致', (cn, intl) => {
    const a = descriptorOf(cn)
    const b = descriptorOf(intl)
    expect(a, `${cn} 不在 registry 里`).toBeDefined()
    expect(b, `${intl} 不在 registry 里`).toBeDefined()
    if (a === undefined || b === undefined) return
    for (const field of SAME_FIELDS) {
      expect(
        b[field],
        `${intl}.${field} 与 ${cn}.${field} 不一致（同族两站只登记了一边 ⇒ 有一站的 UI 会缺能力）`,
      ).toBe(a[field])
    }
    // `credits` 三格也必须一致（签到 / 余额 / 新人奖励是同一份协议）。
    expect(b.credits, `${intl} 的 credits 与 ${cn} 不一致`).toEqual(a.credits)
  })

  it('★ 反向自检：PAIRS 里每个 id 都真的在 registry 里（改名即红）', () => {
    for (const [, id] of PAIRS) {
      expect(descriptorOf(id), `${id} 不在 registry 里 —— 改名了要同步改本用例`).toBeDefined()
    }
  })
})

describe('从 registry 派生的能力表与既有断言逐条相等', () => {
  it('CREDITS 派生结果与既有 7 条 toEqual 断言一致（astudio 2026-10-16 加入）', () => {
    const caps = creditCapabilitiesOf()
    expect(caps.codearts).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.buddy).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.workbuddy).toEqual({ balance: true, dailyCheckin: false })
    expect(caps.qoder).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.qodercn).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.loomy).toEqual({ balance: true, dailyCheckin: true, onboardingTasks: true })
    // ⚠️ 2026-10-16 并入 astudio：逐家 toEqual，漏写这一条则「registry 加了
    //    而客户端能力表没派生出来」这种漂移不会被本用例发现。
    expect(caps.astudio).toEqual({ balance: true, dailyCheckin: true })
  })

  it('只有 cline 有 subscriptionQuota（既有断言 toEqual([\'cline\'])）', () => {
    const withQuota = Object.entries(creditCapabilitiesOf())
      .filter(([, c]) => c.subscriptionQuota === true)
      .map(([id]) => id)
      .sort()
    expect(withQuota).toEqual(['cline'])
  })

  /**
   * ⚠️ **三张派生表必须同款：外层与内层各自 `Object.freeze`**（2026-10-08 复审修复）。
   *
   * 重构前 `credits-capabilities.js` 是**逐条手写的字面量**、每条各自带
   * `Object.freeze({…})`；改成派生时只保住了外层的 `Object.freeze(creditCapabilitiesOf())` —— 那只冻结
   * **外层容器**，**内层条目仍可被改写**。同文件另外两张表
   *（`RATE_LIMIT_CAPABILITIES` / `ACCOUNT_TEST_CAPABILITIES`）各自都留着
   * `Object.freeze({…})`，故这是**只在其中一张表上静默失效的保险**。
   *
   * ⚠️ 这条用例本身就是「保险的保险」：本仓库的约定是「保险失效比变红更糟」——
   * 静默失效的守卫比没有守卫更危险（它会让人以为已经守住了），故冻结本身
   * 也必须由一条会变红的断言守着。
   */
  it('⚠️ 派生表的每个条目自身也是冻结的（外层冻结挡不住内层改写）', async () => {
    const caps = creditCapabilitiesOf()
    // `creditCapabilitiesOf()` 返回的是**未冻结的外层**（冻结由调用方做：
    // 客户端 `Object.freeze(creditCapabilitiesOf())`）—— 但**每条必须已冻结**，
    // 否则调用方的外层冻结只是一道挡不住内层改写的空保险。
    for (const [id, entry] of Object.entries(caps)) {
      expect(Object.isFrozen(entry), `${id} 的能力条目应逐条冻结`).toBe(true)
    }
    // ⚠️ 三张表**同款**才算修好：另两张（限流 / 测试）各自都留着逐条冻结，
    //    若只有积分表缺，那是「只在其中一张表上静默失效的保险」。
    const client = await import('../../plugin-src/client/credits-capabilities.js')
    for (const [name, table] of [
      ['CREDITS_CAPABILITIES', client.CREDITS_CAPABILITIES],
      ['RATE_LIMIT_CAPABILITIES', client.RATE_LIMIT_CAPABILITIES],
      ['ACCOUNT_TEST_CAPABILITIES', client.ACCOUNT_TEST_CAPABILITIES],
    ] as const) {
      expect(Object.isFrozen(table), `${name} 外层应冻结`).toBe(true)
      for (const [id, entry] of Object.entries(table)) {
        expect(Object.isFrozen(entry), `${name}.${id} 应逐条冻结`).toBe(true)
      }
    }
    expect(Object.isFrozen(PROVIDER_REGISTRY), 'registry 数组应冻结').toBe(true)
  })

  it('permanentLock 恰好是 13 家（officeace 2026-10-12、astudio/minimax/minimaxintl/qoder/qodercn/autoclaw/autoclawintl 2026-10-2x 加入）', () => {
    const locked = PROVIDER_REGISTRY.filter((d) => d.permanentLock === true)
      .map((d) => d.id).sort()
    // ⚠️ qoder / qodercn 2026-10-20 加入（用户要求补齐三档分档 + 永久锁）。判据见
    //    `qoder-credits.ts` 的 `QODER_PERMANENT_EXPIRY_MS`：个人版下发的
    //    `usage.expiresAt` 恒是**永久哨兵** `253402214400000`（`9999-12-31`）——
    //    不写 `deductionEndTime` ⇒ 落永久桶 ⇒ 「锁住就不作废」的语义**成立**
    //    （不是拿哨兵当真实到期时刻）。同日接上同一个 `kind: 'buddy'` 选号。
    //    ⚠️ **两站必须各占一项**（共用一个 `QoderAuth` 不等于共用一个 id）。
    // ⚠️ astudio 2026-10-20 加入：三池（会员/购买/赠送）各下发 `*NextExpireTime`
    //    ⇒ 与 buddy 系同形，可分三档；且已接上 `createCredentialResolver`
    //    的 `kind: 'buddy'` 选号（锁定才真能拦），故两处同时登记。
    // ⚠️ minimax / minimaxintl 2026-10-20 加入（用户报障：「MiniMax Code 积分也有
    //    到期时间，也应当有相同功能」）：`/minimax-cloud/api/v1/credit/details` 的
    //    每条 `details[]` 都带 `expire_at_ms`（毫秒时间戳）⇒ 可分三档；同日接上
    //    `createCredentialResolver` 的 `kind: 'buddy'` 选号，锁定才真能拦。
    // ⚠️ autoclaw / autoclawintl 2026-10-21 加入（用户要求「补锁定开关」）：
    //    `autoclaw-credits.ts` 的批次映射明确「**无到期字段的发放**（活动赠送的
    //    永久分）⇒ 不带 `deductionEndTime`（= 永久桶）」⇒ 本家**确实有**永久桶。
    //    ⚠️ 与 buddy 系**不同源**：本家 `rateLimit: false`、刻意不做请求级换号，
    //    锁定只作用于「按余额分档选号」这一层。**两站各占一项**。
    expect(locked).toEqual([
      'astudio', 'autoclaw', 'autoclawintl', 'buddy', 'lobsterai', 'loomy',
      'minimax', 'minimaxintl', 'officeace', 'qoder', 'qodercn', 'trae', 'workbuddy',
    ])
  })

  it('usesExpiryWindow 恰好是 13 家（loomy 不在内，它没有窗口概念；autoclaw 2026-10-17、qoder/qodercn/astudio/minimax/minimaxintl/codearts 2026-10-20 加入）', () => {
    const win = PROVIDER_REGISTRY.filter((d) => d.usesExpiryWindow === true)
      .map((d) => d.id).sort()
    // ⚠️ autoclaw 2026-10-17 加入：流水每笔发放带 `wallet_expires_at`，未过期批次
    //    之和 == total_balance（守恒实测）⇒ 批次包带 `deductionEndTime` 可分三档。
    // ⚠️ 2026-10-20 加 autoclawintl：与 autoclaw **同源**（同一份 credits 实现），
    //    实测国际站批次同样带 `deductionEndTime`（3000→10/21、10000→10/27）。
    // ⚠️ qoder / qodercn 2026-10-20 加入（**本项的第 7 次复发**，成因同上）：
    //    `usage.expiresAt` 是永久哨兵时**不写** `deductionEndTime` ⇒ 该包落永久
    //    桶 ⇒ 面板能分「长期 / 临期」、锁定能真拦住。⚠️ 与 codearts 不同（那家
    //    不开 `permanentLock`），**本家同时开**（它有「永不作废」的套餐池）。
    // ⚠️ astudio 2026-10-20 加入：`/points/balance` 的 `{member,buy,activity}
    //    NextExpireTime` 是**不带时区的本地时间串**，由
    //    `astudio-credits.ts` 的 `astudioLocalTimeMs` 归一化到 `deductionEndTime`。
    // ⚠️ minimax / minimaxintl 2026-10-20 加入：`expire_at_ms` 是**毫秒时间戳**，
    //    无需换算，直接写进 `deductionEndTime`（与 astudio 那条的形态差异见
    //    `aggregate-expiry.ts` 的 `minimaxExpiry` 注释）。
    // ⚠️ codearts 2026-10-20 加入：**只有基础积分包**能分档（随套餐周期 `end_date`
    //    到期）；赠送/按需包没有逐包到期字段，走 `expiringTotal` 单独提示。
    //    ⚠️ 与其余 6 家**不同**：它不开 `permanentLock` —— CodeArts 没有任何
    //    「永不作废」的池，开锁会与「锁住就不作废」的语义错位。
    expect(win).toEqual([
      'astudio', 'autoclaw', 'autoclawintl', 'buddy', 'codearts', 'lobsterai',
      'minimax', 'minimaxintl', 'officeace', 'qoder', 'qodercn', 'trae',
      'workbuddy',
    ])
  })

  it('rateLimit === false 恰好是 9 家（magicrewintl 2026-11-01 加入；codely 2026-10-20 接线后退出）', () => {
    const off = PROVIDER_REGISTRY.filter((d) => d.rateLimit === false)
      .map((d) => d.id).sort()
    // ⚠️ **理由各不相同**（见 registry 里各自的字段注释）：
    // - loomy：根本不返回限流错误（静默降级扣永久积分）；
    // - gemini / officeace：限流是服务端配额窗口制，本地标记与重测都不改变配额；
    // - astudio（**本 fork**）：**不写 `modelRateLimits` 且不在 `probeById` 里**
    //   （`astudio-adapter.ts` 同款）⇒ 两个按钮恒为惰性（零请求、零清除）。
    // - autoclaw：**与 astudio 同族**（刻意不做请求级换号 + 冷却，不进 `probeById`）。
    // - autoclawintl（2026-10-20）：与 autoclaw **同一个适配器类、同一份 registry
    //   字段语义** ⇒ 必然一起为 false。
    // - modelscope（**本 fork**，2026-10-17 用户要求）：**能力齐全但刻意关入口** ——
    //   它确实会写 `modelRateLimits`、也确实注入了 `markLimited`。
    //   ⚠️ 与前几家**不同源**：代价是「冷却标记仍写进池，但用户没法用按钮清除」
    //   （只能等自然过期或删号重加），而不是「按钮点了没用」。
    //   ⚠️ 它在 `credits-capabilities.spec.ts` 的 `RATE_LIMIT_OFF_BY_CHOICE`
    //   里有独立登记（那张表专门区分「产品取舍」与「语义管辖不到」两类）。
    //
    // ⚠️⚠️ **accio 曾在这张表里，2026-10-18 因 issue IKM3ZV 退出**（7 家 → 6 家）：
    //   当时它的理由是「不写 `modelRateLimits` 且不在 `probeById` 里 ⇒ 按钮恒惰性」。
    //   接上请求级换号 + 冷却（`accio-adapter.ts` 的 `markCurrentAccount`，
    //   额度至 UTC+8 当日 24:00 / 限流 1h）后，① 真的写标记了、② `probeById`
    //   也登记了 ⇒ 那个理由**已不成立**，`rateLimit: true` 是**实打实可用**的入口
    //   （与 modelscope 的「能力齐全但刻意关」相反）。
    //   ⚠️ **三处必须同改**（registry 本行 / `src/index.ts` 的 `probeById` /
    //   `tests/helpers/provider-sets.ts` 的 `WRITES_RATE_LIMIT_PROVIDERS`），
    //   由 `provider-runtime-wiring.spec.ts` 双向比对锁死 —— 本表是**第四道**闸。
    // ⚠️ **codely 曾在这里，2026-10-20 退出**（7 家 → 6 家）：当初的理由是
    //   「UI 先行阶段探测适配器还没有 ⇒ 按钮点了必报『没有探测适配器』」。
    //   同日接上请求级换号 + 冷却（`codely-adapter.ts` 的 `updateModelRateLimit`
    //   写点）+ `probeById.codely` 探测适配器后，理由已不成立 ⇒ 与 accio 同因退出。
    //   ⚠️ 同样**三处同改**（registry 本行 / `probeById` / `WRITES_RATE_LIMIT_PROVIDERS`）。
    //
    // 新增一家时**不要**只改这里：判据是 registry 的落地问法
    //「这个按钮点下去，能不能让用户少受限一次？」——
    // ⚠️ 而 modelscope 打破的正是这条问法的前提（它**能**，只是不要）。
    //    ⇒ 所以「能」不再是必要条件，「用户是否要这个按钮」才是。
    // - magicrew（2026-10-29）：**与 astudio 同族** —— 零 `updateModelRateLimit` 写点、
  //   也不在 `probeById` 里 ⇒「重测 / 重置」两个按钮点下去是**零请求、零清除**
  //   （`account.retest` 走 `adapterForProbe` 会抛「magicrew 没有探测适配器」）。
  expect(off).toEqual(['astudio', 'autoclaw', 'autoclawintl', 'gemini', 'loomy', 'magicrew', 'magicrewintl', 'modelscope', 'officeace'])
  })

  it('accountTest === true 恰好是 gemini', () => {
    const t = PROVIDER_REGISTRY.filter((d) => d.accountTest === true).map((d) => d.id)
    expect(t).toEqual(['gemini'])
  })

  it('creditPackages 必须覆盖所有 usesExpiryWindow 的家（判据从能力事实派生，不是手写名单）', () => {
    // ⚠️⚠️ **本用例原先是一份手写 9 家名单，把「漏项」固化成了期望值**
    //    （2026-10-20 审计实测）：`autoclawintl` 漏了 `creditPackages`，
    //    补上它反而**变红**（`expected [...(10)] to deeply equal [ Array(9) ]`）。
    //    那正是本仓库反复记载的「守卫把 bug 写成期望值」形态 —— 它保护的是
    //    当时的快照，不是正确性。
    //
    // ⇒ 判据改为两条**从能力事实派生**的不变式：
    //   ① `usesExpiryWindow: true` 的家必须**也有** `creditPackages`
    //      —— 「按到期分档」与「逐包列明细」消费的是同一份数据
    //      （`packages[].deductionEndTime`）；声明了前者却不声明后者，
    //      用户就只看得到分档、看不到是哪几包。
    //   ② `creditPackages` 的家必须真的能读余额（否则无包可列）。
    //
    // ⚠️ 反向不成立（有 `creditPackages` 但无 `usesExpiryWindow`）：astudio /
    //    qoder / qodercn 三家**有逐包到期时间**但未接入「按到期分档」的窗口
    //    回传 ⇒ 只列明细、不分档，是合法组合，**不得**被这条判据误伤。
    const usesExpiryWindow = PROVIDER_REGISTRY.filter((d) => d.usesExpiryWindow === true)
    const missing = usesExpiryWindow.filter((d) => d.creditPackages !== true).map((d) => d.id)
    expect(missing, 'usesExpiryWindow 的家必须有 creditPackages（同一份数据）').toEqual([])

    const noBalance = PROVIDER_REGISTRY
      .filter((d) => d.creditPackages === true && d.credits?.balance !== true)
      .map((d) => d.id)
    expect(noBalance, 'creditPackages 的家必须真的能读余额').toEqual([])

    // 至少要有若干家，防止「全表被清空」这种退化仍绿（同义反复的反面）。
    expect(PROVIDER_REGISTRY.filter((d) => d.creditPackages === true).length).toBeGreaterThan(5)
  })

  it('autoCheckinExcluded 恰好是 zcode', () => {
    const x = PROVIDER_REGISTRY.filter((d) => d.autoCheckinExcluded === true).map((d) => d.id)
    expect(x).toEqual(['zcode'])
  })

  it('channel === true 的 19 家都有 settingsNamespace 除了 opencode', () => {
    const withNs = PROVIDER_REGISTRY.filter((d) => d.settingsNamespace !== undefined)
      .map((d) => d.id).sort()
    expect(withNs).toEqual([
      'accio', 'astudio', 'autoclaw', 'autoclawintl', 'buddy', 'cline', 'codearts', 'gemini', 'lobsterai', 'loomy',
      'minimax', 'minimaxintl', 'officeace', 'qoder', 'qodercn', 'raccoon', 'trae', 'workbuddy', 'zcode',
    ])
  })
})

describe('客户端图标表与 registry 同步（行为断言）', () => {
  it('PROVIDER_ICONS 的键集合与 registry 的 id 集合完全相等', async () => {
    // ⚠️ 直接 import 客户端的导出，**不读源码文本**。
    //    失败时 toEqual 的 diff 会明确指出缺哪个 id。
    //
    // ⚠️ 2026-10-08：初稿 import 的是 `plugin-src/client/jet-hub.js`，
    //    但**实测失败** —— 本仓库 `node_modules` 里**没有 react**
    //    （`react` 只在 `build.mjs` 的 `external` 里、由宿主注入），
    //    报 `Cannot find package 'react' imported from .../jet-hub.js`。
    //    故按 brief 的 fallback：图标与 `PROVIDER_ICONS` 抽到**纯数据模块**
    //    `plugin-src/client/provider-icons.js`（无 react 依赖），测试指向它。
    //    这与本仓库既有的 `aggregate-panel-logic.js` / `badge-model.js` /
    //    `new-account.js` 同款 —— 都是「为可单测而从 jet-hub.js 拆出」。
    const { PROVIDER_ICONS } = await import('../../plugin-src/client/provider-icons.js')
    expect(Object.keys(PROVIDER_ICONS).sort())
      .toEqual(PROVIDER_REGISTRY.map((d) => d.id).sort())
  })

  it('每个图标都是非空 data URI（防止键存在但值是 undefined）', async () => {
    const { PROVIDER_ICONS } = await import('../../plugin-src/client/provider-icons.js')
    for (const [id, icon] of Object.entries(PROVIDER_ICONS)) {
      expect(typeof icon, `${id} 的图标类型`).toBe('string')
      expect((icon as string).startsWith('data:image/'), `${id} 的图标必须是 data URI`).toBe(true)
    }
  })

  /**
   * ★ 对象字面量里**不得有重复键**（`pnpm build:all` 的 `duplicate-object-key` 警告）。
   *
   * ## 为什么上面那两条守卫抓不到它（真实缺陷，2026-10-22）
   *
   * PR #1 的 `b69e6736 feat(codely)` 往 `PROVIDER_ICONS` 末尾追加 `codely` 时，
   * 把 `autoclaw` / `modelscope` / `aggregate` 三个键**又抄了一遍**。而 JS 的对象
   * 字面量语义是「后者胜」⇒
   *
   * - `Object.keys()` 集合**完全不变** ⇒ 上面那条「键集合相等」**照样全绿**；
   * - 三个重复键的值恰好相同 ⇒ 上面那条「非空 data URI」也**照样全绿**。
   *
   * 唯一暴露它的是 `pnpm build:all` 的 esbuild 警告：
   * ```
   * ▲ [WARNING] Duplicate key "autoclaw" in object literal [duplicate-object-key]
   * ```
   * 而 `build.mjs` **没有把警告升级成失败**，`pnpm test` 也不跑 esbuild ⇒
   * 这是一个**只有人手看构建日志才会发现**的缺口。
   *
   * ⚠️ 当时的三个值相同所以没有功能后果，但「守卫全绿 + 构建有警告」正是本仓库
   * 记过的假绿形态：哪天两处值不同，就会静默用错图标而**没有任何**报警。
   *
   * ## 判据为什么读源码文本（本文件唯一一处）
   *
   * 重复键在**求值后**就消失了（后者覆盖前者），import 出来的对象里**无法**观测
   * —— 没有行为等价物。故只能读文本，且必须**剥掉注释**（注释里出现
   * `autoclaw: AUTOCLAW_ICON` 这类示例不算重复键），并**限定在对象字面量范围内**
   * （文件里还有别的对象）。
   */
  it('★ PROVIDER_ICONS 字面量里没有重复键（esbuild duplicate-object-key 的文本判据）', async () => {
    const { readFileSync } = await import('node:fs')
    const raw = readFileSync(
      new URL('../../plugin-src/client/provider-icons.js', import.meta.url),
      'utf8',
    )
    // ① 剥注释（行注释 + 块注释）—— 否则注释里的示例会被当成真键。
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    // ② 只取 `PROVIDER_ICONS = { … }` 这一段（文件里还有 `PROVIDER_ICON_*` 常量）。
    const start = stripped.indexOf('export const PROVIDER_ICONS')
    expect(start, '找不到 PROVIDER_ICONS 字面量 —— 本判据的锚点失效了，先修判据').toBeGreaterThan(-1)
    const open = stripped.indexOf('{', start)
    // 用括号配对找结尾（值里是 data URI 字符串，不含花括号）。
    let depth = 0
    let end = -1
    for (let i = open; i < stripped.length; i += 1) {
      if (stripped[i] === '{') depth += 1
      else if (stripped[i] === '}') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    expect(end, 'PROVIDER_ICONS 的花括号没有配对 —— 本判据的锚点失效了').toBeGreaterThan(open)
    const body = stripped.slice(open + 1, end)
    // ③ 提顶层键（行首可选空白 + `标识符:`；值里的对象字面量本文件不存在）。
    const keys = [...body.matchAll(/^[ \t]*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]!)
    expect(keys.length, '一个键都没提到 ⇒ 判据失效（不是「没有重复」）').toBeGreaterThan(15)
    const seen = new Set<string>()
    const dup: string[] = []
    for (const key of keys) {
      if (seen.has(key)) dup.push(key)
      seen.add(key)
    }
    expect(
      dup,
      'PROVIDER_ICONS 里有重复键 ⇒ esbuild 会报 duplicate-object-key 警告，'
      + '而 `Object.keys()` 守卫**看不见**它（后者胜，键集合不变）。请删掉重复行。',
    ).toEqual([])
  })
})
