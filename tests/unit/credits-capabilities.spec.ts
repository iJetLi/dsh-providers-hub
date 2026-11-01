import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  ACCOUNT_TEST_CAPABILITIES,
  CREDITS_CAPABILITIES,
  PERMANENT_LOCK_EXPIRING_WINDOW_DAYS,
  RATE_LIMIT_CAPABILITIES,
  checkinProviders,
  permanentLockCopy,
  supportsAccountTest,
  supportsCreditBalance,
  supportsDailyCheckin,
  supportsOnboardingTasks,
  supportsPermanentLock,
  supportsRateLimit,
  supportsSubscriptionQuota,
} from '../../plugin-src/client/credits-capabilities.js'
import { PERMANENT_LOCK_PROVIDERS } from '../../src/jet-hub-rpc.js'
import { createProviderCredits } from '../../src/provider-credits.js'
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'
import { BUDDY_EXPIRING_WINDOW_DAYS } from '../../src/buddy-balance-rank.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'
import { LOOMY } from '../../src/loomy-product.js'
import { TRAE } from '../../src/trae-product.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { OFFICEACE } from '../../src/officeace-product.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import { ASTUDIO } from '../../src/astudio-product.js'
import { MINIMAX, MINIMAX_INTL } from '../../src/minimax-product.js'
// ⚠️ AutoClaw 两站（2026-10-21，用户要求「补锁定开关」）：本家**确实有**永久桶
//    （活动赠送的永久分不带 `deductionEndTime`）⇒ 两站各占一项。
import { AUTOCLAW, AUTOCLAW_INTL } from '../../src/autoclaw-product.js'
// ⚠️ Magicrew 两站（2026-11-01，用户要求「加永久/长期/临期和锁定永久积分」）：
//    本家**确实有**永久桶（`total_points` 减 `expiring_quota_details` 之和的
//    残差 = 上游不下发到期时间的积分）⇒ 两站各占一项（账号不互通）。
import { MAGICREW, MAGICREW_INTL } from '../../src/magicrew-product.js'

/**
 * 积分能力矩阵的回归测试。
 *
 * 真实缺陷（用户报障）：打开 Jet Hub 的 **CodeArts** 面板时控制台必现
 * ```
 * [jet-hub] load credits failed: Error: unsupported provider: codearts
 * ```
 * 根因是客户端 `loadCredits()` 在面板挂载时**对所有 provider 无条件**调用
 * `credits.balances`，而当时该端点以 `productById()` 判能力，CodeArts 根本
 * 不是 BuddyProduct，必定返回 bad-request。
 *
 * 修法是「请求前按能力门控」。因此这里守两件事：
 * 1. 能力矩阵本身正确（尤其 WorkBuddy 余额真/签到假、未登记项默认关闭）；
 * 2. 客户端源码里**不存在绕过门控的调用点** —— UI 组件无法在单测里渲染
 *    （react 不在本仓库依赖内），故用源码级断言锁死守卫存在。
 *
 * 注：CodeArts 后来已接入真实实现（`src/codearts-credits.ts`，华为云签名），
 * 故其能力由全假变为全真；**门控机制本身不变**，仍是防止「对不支持的
 * provider 发必然失败的请求」的那道闸。
 */
describe('积分能力矩阵', () => {
  it('CodeArts 余额与签到都支持（华为云 SDK-HMAC-SHA256 签名协议）', () => {
    // 华为云走 `snap-access` 的签名端点，与腾讯系协议完全不同源，
    // 但**能力上两项都具备**（见 src/codearts-credits.ts）。
    expect(CREDITS_CAPABILITIES.codearts).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('codearts')).toBe(true)
    expect(supportsDailyCheckin('codearts')).toBe(true)
  })

  it('CodeBuddy 余额与签到都支持', () => {
    expect(supportsCreditBalance('buddy')).toBe(true)
    expect(supportsDailyCheckin('buddy')).toBe(true)
  })

  it('AStudio 余额与签到都支持（微信扫码登录与每日奖励弹窗签到）', () => {
    expect(CREDITS_CAPABILITIES.astudio).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('astudio')).toBe(true)
    expect(supportsDailyCheckin('astudio')).toBe(true)
  })

  it('WorkBuddy 国际版支持余额但不支持签到（余额与签到是彼此独立的能力）', () => {
    // 这条断言专治「因为国际版没有签到，就推断也查不到余额」的错误推断。
    expect(supportsCreditBalance('workbuddy')).toBe(true)
    expect(supportsDailyCheckin('workbuddy')).toBe(false)
  })

  /**
   * ⚠️ **能力表与宿主端守卫必须成对**（真实缺陷，2026-10-02 补）。
   *
   * 客户端因为能力表写着 `dailyCheckin: false` 而从不调用 `credits.claimAll
   * ({ provider: 'workbuddy' })`，所以宿主那条分支**一直没有守卫也没人发现**：
   * 它原本会落到 `productById('workbuddy')` 拿到的 buddy 产品上，用**国际版**
   * 凭据去发国内版的签到请求 —— 必然失败，而且是一次**真实的上游请求**。
   *
   * 触发它的是新增的「每日首次启动自动签到」（`src/auto-checkin.ts`）：那个执行体
   * **刻意不维护第二份能力名单**，只按 `claimAll` 返回的信封判「跳过」，所以
   * 宿主漏一个守卫，它就会真去发一轮必然失败的请求。⇒ 两处必须成对存在。
   *
   * ⚠️ 为什么用源码扫描：`registerJetHubRpc` 的 auths 是**命名对象**（13 个键，
   * 键是 provider id），在测试里要逐个填替身既脆弱又与 `jet-hub-rpc.spec.ts`
   * 的桩重复 —— 与本仓库 `raccoon-rpc-dispatch.spec.ts` 对同类守卫的做法一致。
   * （2026-10-08 改措辞：此处原写「是 12 个**位置参数**」，那是 Task 9 之前的形态。）
   */
  it('宿主端 credits.claimAll 对 workbuddy 有显式守卫（与能力表成对）', () => {
    // ⚠️ 2026-10-08 改（Task 4）：原先这条扫 `src/jet-hub-rpc.ts` 的源码文本，
    //    断言里面含 `if (req.provider === 'workbuddy') {` 与那句文案，并检查
    //    守卫**早于** `productById` 兜底。Task 4 把守卫搬进
    //    `src/provider-credits.ts` 的 `claimUnavailableReason` ⇒ 那两串文本
    //    **搬了家**，而它守的意图（workbuddy 调 claimAll **不发上游请求**、
    //    拿到的是**指明能力**的拒绝）**与文本位置无关**。
    //
    //    ⇒ 改为**行为**断言：直接断言表里的声明值 + 真跑端点核对响应。
    //    这比原文本断言强 —— 文本断言只能证明源码里有那串字符，它能证明
    //    端到端真的返回了那条原因（且 `ok:false`，即**没有**发上游请求）。
    const workbuddy = createProviderCredits().workbuddy
    expect(workbuddy?.claim, 'workbuddy 不该有 claim（国际版后端没有签到接口）').toBeUndefined()
    expect(
      workbuddy?.claimUnavailableReason,
      'workbuddy 缺少「不支持每日签到」的可读原因 —— 它会落到通用分支，'
      + '用国际版凭据去发国内版的签到请求（必然失败的真实上游请求）',
    ).toContain('WorkBuddy 国际版不支持每日签到')
    // 反向：确认这条**不是**泛化的 `unsupported provider`（那会让排查者以为
    // 「provider 没注册」，而真相是「该产品没有这个接口」）。
    expect(workbuddy?.claimUnavailableReason).not.toContain('unsupported provider')
    // ⚠️ 「端点真的读了这条声明、且**零上游请求**」由**行为**用例守，
    //    且**只在唯一一处**（避免同一套 RPC 夹具在两个文件里各写一份）：
    //    `tests/unit/claim-runtime-parity.spec.ts` 的
    //    「cline / workbuddy / raccoon 各回**逐字保留**的可读原因」——
    //    它真跑 `credits.claimAll` 并逐字核对文案。
    //    ⚠️ **2026-10-08 更正（Task 4 复审 Finding Minor 1）**：本注释原先写
    //    「把 `fetch` 桩成会抛错（任何真实请求都会让那条用例失败）」，那是**错的**
    //    —— 那条用例用 `makeRpc()`（无 `fetch` 桩），**没有**任何会抛错的桩。
    //    它的「零上游请求」由**代码位置**保证，不是由桩保证：端点在**任何上游
    //    调用之前**读该声明并直接返回（见 `src/jet-hub-rpc.ts` 的
    //    `impl?.claimUnavailableReason !== undefined` 分支，位于
    //    `collectClaimResults` 之前）。故断言依然成立，只是理由换了。
  })

  it('Qoder 两项能力都有（余额 + 每日领取）', () => {
    // ⚠️ 早期把 qoder 误判为「两项皆无」，随后又误判为「有余额、无签到」，
    // 两次都值得记录：
    //
    // ① 余额：只按 `/api/` 前缀搜端点，而它挂在 `/sash/api/v2/me/usage`，
    //    且**只需 Bearer + Cosy-ClientType**（不需要模型列表那样的 WASM 签名）。
    // ② 签到：曾依据 `/sash/api/v1/me/campaigns` 返回 `claimable:false,
    //    campaigns:[]` 判定「没有签到端点」。真相是**那天已领** ——
    //    活动每日 10:00（UTC+8）刷新。2026-09-21 用 keylog 解密抓包拿到了
    //    领取端点（`POST …/{campaignId}/claim`）与幂等证据（`replayed:true`）。
    //
    // 教训：「某次实测没看到」不能推广成「不存在」。
    expect(CREDITS_CAPABILITIES.qoder).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('qoder')).toBe(true)
    expect(supportsDailyCheckin('qoder')).toBe(true)
  })

  it('Qoder 中国版：余额与签到都支持，与国际版同形', () => {
    // 依据（设计文档 E7/E10）：CN 的 `/sash/api/v2/me/usage` 与
    // `/sash/api/v1/me/campaigns` 零凭据实测返回 `401 {"code":"TOKEN_INVALID",
    // "message":"missing authorization token"}`，与国际版**逐字节同形**；
    // CN asar 里同样是 `Fh = Object.freeze({ clientType: 10, … })`。
    //
    // ⚠️ 「端点存在」不等于「活动一定下发」—— 真实领取由
    // `pnpm test:e2e:qodercn-credits` 验证。若将来确认 CN 无签到，改这里时
    // 必须换成强证据（扫 CN asar 无 claim 端点），**不要**写「某次没看到」
    // —— 上面那条 qoder 用例的教训正是这样来的。
    expect(CREDITS_CAPABILITIES.qodercn).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('qodercn')).toBe(true)
    expect(supportsDailyCheckin('qodercn')).toBe(true)
  })

  it('中国版出现在一键签到的遍历渠道里（由能力表推导，非硬编码）', () => {
    // 页头「一键签到」遍历 `checkinProviders()`；漏登记的表现是
    // 「新渠道永远不被签到」，而不是报错 —— 故必须显式断言在里面。
    expect(checkinProviders()).toContain('qodercn')
    // 顺序紧跟国际版（本表声明顺序即请求顺序）。
    expect(checkinProviders().indexOf('qodercn')).toBe(checkinProviders().indexOf('qoder') + 1)
  })

  it('Loomy 三项能力：余额 + 每日签到 + 新手任务', () => {
    expect(CREDITS_CAPABILITIES.loomy)
      .toEqual({ balance: true, dailyCheckin: true, onboardingTasks: true })
    expect(supportsCreditBalance('loomy')).toBe(true)
    expect(supportsDailyCheckin('loomy')).toBe(true)
    expect(supportsOnboardingTasks('loomy')).toBe(true)
  })

  /**
   * ⚠️ `onboardingTasks` 与 `dailyCheckin` **语义独立**，不能互相推断：
   * - `dailyCheckin` = 每日额度刷新（每天有收益）
   * - `onboardingTasks` = 新手任务 10000 分（**一次性**，每号只能领一次）
   * 故只有 Loomy 同时具备两者，其余 provider 的 onboardingTasks 必须为 false。
   */
  it('onboardingTasks 只对 Loomy 为 true（新手任务是一次性的）', () => {
    for (const id of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'trae', 'cline']) {
      expect(supportsOnboardingTasks(id), `${id} 不应支持新手任务`).toBe(false)
    }
  })

  it('未登记的 provider 的 onboardingTasks 默认关闭', () => {
    for (const unknown of ['', 'newprovider', '__proto__']) {
      expect(supportsOnboardingTasks(unknown), unknown).toBe(false)
    }
  })

  it('未登记的 provider 默认不支持任何积分能力（默认关闭）', () => {
    // 新增 provider 时若忘记登记，最坏结果是暂时看不到积分，
    // 而不是每次打开面板都发一个必然失败的请求。
    for (const unknown of ['', 'newprovider', 'CODEARTS', '__proto__']) {
      expect(supportsCreditBalance(unknown), unknown).toBe(false)
      expect(supportsDailyCheckin(unknown), unknown).toBe(false)
      expect(supportsSubscriptionQuota(unknown), unknown).toBe(false)
    }
  })

  /**
   * ⚠️ **订阅额度目前只登记给 Cline**，这是与后端的硬约定：
   * `src/jet-hub-rpc.ts` 的 `cline.quota` / `cline.requestLog` 对非 Cline
   * 一律回 `bad-request`。前端若多登记一家，用户就会看到一个点了必然报错的
   * 按钮（与 CodeArts 早期 `credits.balances` 那次是同一类缺陷）。
   *
   * 「只给 cline」用**全表推导**而不是逐个列举：将来新增渠道时，
   * 若有人顺手也登记了 `subscriptionQuota`，这条会立刻变红，
   * 迫使他同时改后端分派（否则就是死按钮）。
   */
  it('订阅额度只登记给 cline（其余渠道不得渲染该按钮）', () => {
    const withQuota = Object.keys(CREDITS_CAPABILITIES).filter(supportsSubscriptionQuota)
    expect(withQuota).toEqual(['cline'])
    for (const id of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'loomy', 'raccoon']) {
      expect(supportsSubscriptionQuota(id), `${id} 不应支持订阅额度`).toBe(false)
    }
  })

  /**
   * ⚠️ 三个能力**语义独立，不能互相推断**：
   * Cline 是「有余额、有订阅额度、**无**签到」；Loomy 是「有余额、有签到、
   * 无订阅额度」。任一为 true 都不蕴含另一个 —— 把它们合并成一个标志
   * 会让「Cline 面板冒出签到按钮」或「Loomy 面板冒出额度按钮」。
   */
  it('订阅额度与余额/签到彼此独立（不能互相推断）', () => {
    expect(supportsCreditBalance('cline')).toBe(true)
    expect(supportsSubscriptionQuota('cline')).toBe(true)
    expect(supportsDailyCheckin('cline')).toBe(false)
    // 反向：Loomy 有签到、无订阅额度。
    expect(supportsDailyCheckin('loomy')).toBe(true)
    expect(supportsSubscriptionQuota('loomy')).toBe(false)
  })

  it('能力矩阵覆盖 PROVIDER_REGISTRY 中的每一个 provider', () => {
    // ⚠️ 2026-10-08 改：原先从**客户端源码文本**用正则
    // `/\{\s*id:\s*'([a-z]+)',\s*label:/g` 派生 id —— 那个字符类
    // **不匹配连字符**，新 provider id 带 `-` 时会**静默漏算一个 id
    // 而守卫照样全绿**（本仓库原注释：「保险失效比变红更糟」）。
    // 现在两侧同出一源：客户端 PROVIDERS 由 registry 派生，这里直接读 registry。
    const providerIds = PROVIDER_REGISTRY.map((d) => d.id)
    expect(providerIds.length).toBeGreaterThan(0)
    for (const id of providerIds) {
      expect(CREDITS_CAPABILITIES, `缺少 ${id} 的能力登记`).toHaveProperty(id)
    }
    expect(Object.keys(CREDITS_CAPABILITIES).sort()).toEqual([...providerIds].sort())
  })
})

/**
 * ⚠️ **模型限流按钮门控**（Gemini 报障，2026-10-03）。
 *
 * 用户原话：「重测按钮你确认过会发请求吗，为什么响应这么快？可以移除吗」。
 * 取证结论：当时该账号条目**没有 `modelRateLimits` 标记**，
 * `retestAccount` 在 `modelIds.length === 0` 处提前返回 ⇒ 一次请求都没发，
 * 所以「响应快」。但这不代表按钮无害：Gemini 的限流是**服务端配额窗口制**
 * （5 小时窗口 + 周窗口），本地标记清掉、重测通过，配额一点没恢复 ——
 * 「重测」只会白烧本就紧张的窗口配额，「重置」只会把受限账号放回池里再撞 429。
 * 故与 Loomy 同处登记 `false`（**理由不同**，见
 * {@link RATE_LIMIT_CAPABILITIES} 的注释）。
 *
 * ⚠️ 2026-10-12 追加 **Accio**（第三种理由：**根本没有作用对象** ——
 * 不写 `modelRateLimits`、也不在 `probeById` 里 ⇒ 两个按钮恒为惰性）。
 */
describe('模型限流按钮门控（重测 / 重置）', () => {
  /**
   * ⚠️⚠️ **「产品取舍」型 `rateLimit: false` 的名单**（2026-10-17 新增）。
   *
   * `rateLimit: false` 实际有**两种**不同源，混在一起会让「为什么关」的**理由**失真：
   *
   * | 类型 | 含义 | 后果 |
   * |---|---|---|
   * | **① 语义管辖不到** | 按钮点了也没用（无探测材料 / 配额在服务端 / 根本不返回限流） | 恒惰性 |
   * | **② 产品取舍（本表）** | 能力齐全，**用户要求关掉入口** | 标记仍写进池，但**无法用按钮清除** |
   *
   * ⚠️ 两者**代价完全不同** ⇒ 排障方向也不同（① 是「按钮坏了」的报障、
   *    ② 是「我明明加了限流却不给按钮」的产品反馈），故必须分开记。
   *
   * ⚠️ 下方两条用例会**双向**校验本表：既不许有家「登记了 false 却没登记理由」
   *（会被算成①），也不许有家「在本表里却没登记 false」（僵尸条目）。
   */
  const RATE_LIMIT_OFF_BY_CHOICE: ReadonlyMap<string, string> = new Map([
    [
      'modelscope',
      '会写 modelRateLimits 且注入了 markLimited（能力齐全）；用户 2026-10-17 要求关掉入口 '
      + '⇒ 冷却标记仍写进池但无法用按钮清除，只能等自然过期或删号重加',
    ],
  ])
  it('gemini 显式登记为「限流不由这组按钮管辖」', () => {
    expect(RATE_LIMIT_CAPABILITIES.gemini?.rateLimit).toBe(false)
    expect(supportsRateLimit('gemini')).toBe(false)
  })

  it('未登记的 provider 仍默认视为有限流（不得因新增登记而收紧默认值）', () => {
    // 反例：任何未登记的 id 都必须保持 true，否则将来新增 provider 漏登记时
    // 老用户会凭空失去「重测 / 重置」按钮 —— 那是可见的功能回退。
    expect(supportsRateLimit('codearts')).toBe(true)
    expect(supportsRateLimit('zcode')).toBe(true)
    expect(supportsRateLimit('不存在的 provider')).toBe(true)
  })

  it('登记 false 的都是「按钮语义管辖不到」的渠道（accio 2026-10-18 退出、astudio 加入、codely 2026-10-20 退出）', () => {
    const disabled = Object.entries(RATE_LIMIT_CAPABILITIES)
      .filter(([, caps]) => caps.rateLimit === false)
      // ⚠️⚠️ **必须减去「产品取舍」那一类**（2026-10-17）：`rateLimit: false` 有
      //    **两种**不同源，混在一起数会把不变式变成「五个」这个必然腐坏的快照：
      //      ① 「按钮语义管辖不到」（本条断言的对象）—— 点了也没用；
      //      ② 「用户刻意不要这个按钮」（能力齐全、入口关闭，见下）。
    //    ⚠️ 魔搭属第 ② 类：它**确实会写** `modelRateLimits`、也**确实**注入了
    //    `markLimited`，但用户要求关掉入口。把它算进① 会让本条的**理由**失真。
      .filter(([id]) => !RATE_LIMIT_OFF_BY_CHOICE.has(id))
      .map(([id]) => id)
      .sort()
    // rationale 各不相同（registry 里各有字段注释）：
    // - astudio（**本 fork**）：**不写 modelRateLimits 且不在 probeById 里**
    //   ⇒ 两个按钮恒为惰性（点了零请求、零清除，用户会以为按钮坏了）；
    // - autoclaw：与 astudio 同族（刻意不做请求级换号 + 冷却，不进 probeById）；
    // - autoclawintl（2026-10-20）：与 autoclaw **同一个适配器类、同一份 registry
    //   字段语义** ⇒ 必然一起为 false（漏登记会让本条理由失真）。
    // - gemini / officeace：限流由服务端配额管理，本地标记清掉 / 重测通过
    //   都恢复不了配额；
    // - loomy：根本不返回限流错误。
    //
    // ⚠️ 2026-10-20：本条期望值曾在合并 remote master 时被写成
    //    `['accio', …]`（上游口径），与本 fork 的注册表不一致：accio 已于
    //    2026-10-18 因 issue IKM3ZV **退出**这张表（它接上了换号 + 冷却），
    //    而 **astudio** 是本 fork 独有、且确实登记了 `rateLimit: false`。
    //    ⇒ 按**注册表事实**更正（不是改注册表去凑这条断言）。
    //    ⚠️ codely 同日退出：它的换号 + 探测已接线（见 provider-registry.spec 同源注释）。
    // - magicrew（2026-10-29）：**与 astudio 同族** —— 零 `updateModelRateLimit`
    //   写点、不在 `probeById` 里 ⇒ 两个按钮恒为惰性（点了零请求、零清除）。
    // - magicrewintl（2026-11-01）：与 magicrew **同一份实现、同一份 registry 字段语义**
    //   ⇒ 必然一起为 false（漏登记会让本条理由失真，与 autoclawintl 同型）。
    expect(disabled).toEqual(['astudio', 'autoclaw', 'autoclawintl', 'gemini', 'loomy', 'magicrew', 'magicrewintl', 'officeace'])
  })

  it('★ 「产品取舍」那一类也必须被点名（不得悄悄混进「管辖不到」里）', () => {
    // ⚠️ 这条断言的是**取舍表本身**存在且内容正确：若有人给某家登记
    //    `rateLimit: false` 却没登记它的取舍理由，上一条会把它算成「管辖不到」
    //    ⇒ 理由失真（而两者的**代价完全不同**，排查方向也不同）。
    //
    //    ⚠️ 代价必须逐个写清：取舍类的「按钮没了，但限流标记**仍会写进池**」，
    //    用户只能等它自然过期或删号重加。
    expect([...RATE_LIMIT_OFF_BY_CHOICE.entries()].sort()).toEqual([
      ['modelscope', '会写 modelRateLimits 且注入了 markLimited（能力齐全）；用户 2026-10-17 要求关掉入口 ⇒ 冷却标记仍写进池但无法用按钮清除，只能等自然过期或删号重加'],
    ])
    // 反向：取舍表里的家**必须真的**登记了 false，否则这条表会变成僵尸条目。
    for (const [id] of RATE_LIMIT_OFF_BY_CHOICE) {
      expect(RATE_LIMIT_CAPABILITIES[id]?.rateLimit,
        `${id} 在「产品取舍」表里，但 registry 没有 rateLimit:false ⇒ 两者表漂移`)
        .toBe(false)
    }
  })

  it('客户端源码里按钮仍走 supportsRateLimit 门控（不是在本文件另写白名单）', () => {
    // 与 loomy-client.spec.ts 同源断言，这里补上「不得复辟硬编码 provider 判断」。
    const codeLines = readClientSource()
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).toContain('showRateLimitActions: supportsRateLimit(provider)')
    expect(codeLines).not.toMatch(/showRateLimitActions:\s*provider\s*!==/)
  })
})

/**
 * ⚠️ **「测试」按钮的能力门控**（用户 m03338：「增加测试按钮，真实的发一次请求」）。
 *
 * 与「重测」的硬性区别是**触发条件**：重测只测已有 `modelRateLimits` 标记的
 * 模型，没有标记时零请求；测试不看标记、无条件真发一次。因此两者必须用
 * **独立**的能力位与 props 开关 —— 当前 Gemini 恰好只登记测试、没登记重测，
 * 若绑在同一个开关上就会二选一地消失一个按钮。
 */
describe('账号「测试」按钮门控', () => {
  it('gemini 登记为支持测试', () => {
    expect(ACCOUNT_TEST_CAPABILITIES.gemini?.test).toBe(true)
    expect(supportsAccountTest('gemini')).toBe(true)
  })

  it('未登记的 provider 一律不渲染（默认关闭，与限流表相反）', () => {
    // ⚠️ 默认必须是 false：这是**全新**按钮，没有存量用户，未验证的渠道不该出现。
    expect(supportsAccountTest('codearts')).toBe(false)
    expect(supportsAccountTest('zcode')).toBe(false)
    expect(supportsAccountTest('loomy')).toBe(false)
    expect(supportsAccountTest('不存在的 provider')).toBe(false)
  })

  it('客户端源码里「测试」走独立开关，不挂在 showRateLimitActions 上', () => {
    const codeLines = readClientSource()
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).toContain('onTest: supportsAccountTest(provider)')
    // 反例：把测试绑到限流开关上会让 Gemini 拿不到按钮（它登记的是 false）。
    expect(codeLines).not.toMatch(/onTest:\s*showRateLimitActions/)
    expect(codeLines).not.toMatch(/onTest:\s*supportsRateLimit/)
  })

  it('「测试」的结果汇总与「重测」分开写（响应结构不同）', () => {
    // account.test 返回扁平 { modelId, ok, message }，没有 accounts/clearedCount。
    // 若拿它去喂 summarizeProbe，会得到「没有可重测的限流标记」——
    // 把「测试失败」误报成「没什么可测的」。
    const codeLines = readClientSource()
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).toContain('function summarizeTest(res)')
    expect(codeLines).toContain('summarizeTest(res)')
  })
})

/** 读取客户端 bundle 的源码（未打包的 plugin-src 版本）。 */
function readClientSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
}

describe('客户端积分请求门控（源码级回归）', () => {
  const source = readClientSource()

  it('引用了能力矩阵，而不是在本文件里另写一份 provider 字面量判断', () => {
    expect(source).toContain("from './credits-capabilities.js'")
    expect(source).toContain('supportsCreditBalance')
    expect(source).toContain('supportsDailyCheckin')
    // 历史实现里的 CREDITS_PROVIDERS 白名单已删除，不得复辟。
    // 只查「非注释行」：文件里保留了叙述该缺陷的注释，注释提及名字是合理的。
    const codeLines = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toContain('CREDITS_PROVIDERS')
  })

  it('loadCredits 在发起 credits.balances 之前先判能力', () => {
    const start = source.indexOf('const loadCredits = React.useCallback')
    expect(start).toBeGreaterThan(-1)
    // ⚠️⚠️ **窗口跟随函数体，不写死字符数**（2026-10-16 审计暴露）：
    //   原为 `slice(start, start + 1200)`；`loadCredits` 补了 `force` 的说明后
    //   `rpcCall('credits.balances'` 被挤出窗口 ⇒ `callIndex` 变 -1 ⇒ **假红**。
    //   固定长度窗口 = 注释一变就假失败，正是本仓库记录的「源码文本断言」弱点。
    const next = source.indexOf('\n  const ', start + 10)
    const body = source.slice(start, next === -1 ? start + 20000 : next)
    const guardIndex = body.indexOf('if (!canLoadCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.balances'")
    expect(guardIndex, 'loadCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    // 守卫必须出现在请求之前，否则等于没守
    expect(guardIndex).toBeLessThan(callIndex)
  })

  it('挂载副作用只在支持余额时才拉积分（CodeArts 连 loading 状态都不翻）', () => {
    const start = source.indexOf("void loadAccounts();")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 400)
    const guardIndex = body.indexOf('if (canLoadCredits) void loadCredits();')
    expect(guardIndex, '挂载副作用缺少能力门控').toBeGreaterThan(-1)
    // 不能存在无条件的 void loadCredits() 调用
    expect(body).not.toMatch(/^\s*void loadCredits\(\);/m)
  })

  it('claimCredits 在发起 credits.claimAll 之前先判能力', () => {
    const start = source.indexOf('const claimCredits')
    expect(start).toBeGreaterThan(-1)
    // ⚠️ 窗口不能太窄：函数头部现在依次有「能力守卫 → 重入闸门（claimInFlightRef）
    // → 提示文案」三段（复审 !62 加的重入闸门），把 claimAll 调用推到了 700 字符
    // 之外。原窗口 600 因此假失败 —— 判据本身（守卫在调用之前）仍成立，
    // 只是插入的守卫把距离撑大了（与下方 AccountCard 那条「窗口不能只取 4000」
    // 是同款维护问题）。
    const body = source.slice(start, start + 1200)
    const guardIndex = body.indexOf('if (!supportsCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.claimAll'")
    expect(guardIndex, 'claimCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(callIndex)
  })

  /**
   * ★ **自愈后的账号重读**（issue IKKHL5 的客户端残留，报告者复验时实测到）。
   *
   * ## 缺陷
   *
   * 宿主侧的 `credits.balances` 会**对已过期账号先续期再查余额**，续期成功后把
   * 新的 `expiresAt` 回写账号池。但**卡片红字读的是 `account.list` 的快照**
   *（`AccountCard` 里 `account.expiresAt <= Date.now()`），而 `loadCredits`
   * 不重读账号列表 ⇒ 「积分已经能读了，卡片却还红着『已过期 · 自动续期』」，
   * 点别的卡片再切回来才恢复正常。
   *
   * ## 为什么必须有这条用例
   *
   * 这是**跨端点**的时序契约（`credits.balances` 的副作用要反映到
   * `account.list` 的消费者上），两个端点各自的单测都覆盖不到它 ——
   * 服务端 22 条 + 客户端能力门控若干条，全都测不出这个残留。
   */
  /**
   * ★ **自愈后的账号重读**（issue IKKHL5 的客户端残留，报告者复验时实测到）。
   *
   * ## 缺陷
   *
   * 宿主侧的 `credits.balances` 会**对已过期账号先续期再查余额**，续期成功后把
   * 新的 `expiresAt` 回写账号池。但**卡片红字读的是 `account.list` 的快照**
   *（`AccountCard` 里 `account.expiresAt <= Date.now()`），而 `loadCredits`
   * 不重读账号列表 ⇒ 「积分已经能读了，卡片却还红着『已过期 · 自动续期』」。
   *
   * ## ⚠️⚠️ 初版修复对**主场景无效**（对抗审计实测证伪，本组用例因而重写）
   *
   * 初版用「调用前快照里有没有已过期账号」（`hadExpired`）作条件。但挂载
   * effect 里 `void loadAccounts(); … void loadCredits();` 是**同步先后**
   * 发起的，而 `loadAccounts` 要到它的首个 `await rpcCall('account.list')`
   * **之后**才写 `accountsRef.current` ⇒ 挂载 / 切 provider 时读到的必然是
   * **初始空数组**（`useRef([])`），`hadExpired` 恒 false、**永不补读**。
   * 而「睡眠恢复后打开面板」**正是本 issue 的主场景** ⇒ 初版只对「点刷新积分」
   * 等列表已加载的路径有效，主路径完全没修。
   *
   * ## 现行修法：成功后**无条件**静默补读
   *
   * 不再依赖任何「调用前快照」（那个判据在主场景下不可能为真）。代价是每次
   * 余额查询多一次 `account.list` —— 这是**刻意的取舍**：它读的是账号池的
   * 内存副本（不是上游请求），而卡片状态错误的代价更高。
   * 且必须走 `quiet` 变体，否则普通 `loadAccounts` 的 `setPhase('loading')`
   * 会让列表在自愈成功那一刻闪一下。
   */
  it('★ loadCredits 成功后**无条件**补读账号列表（不得再用「调用前快照」作条件）', () => {
    const start = source.indexOf('const loadCredits = React.useCallback')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 3000)
    const rpcIndex = body.indexOf("rpcCall('credits.balances'")
    expect(rpcIndex).toBeGreaterThan(-1)

    // ① 必须调静默补读，且在余额请求**之后**（拿到新余额后才同步有效期）。
    const reReadIndex = body.indexOf('await reloadAccountsQuietly()')
    expect(reReadIndex, 'loadCredits 成功后必须补读账号列表').toBeGreaterThan(-1)
    expect(reReadIndex, '补读必须在余额请求之后').toBeGreaterThan(rpcIndex)

    // ② ⚠️ **不得**再用「调用前快照」作条件 —— 那正是初版对主场景失效的原因
    //    （挂载时 accountsRef.current 必为初始空数组）。这条是**防复辟**断言。
    // ⚠️ 只在**代码行**上查（剔除注释）：本函数的注释里保留了叙述该缺陷的
    //    文字（含那个旧标识符），那是刻意的历史记录，不该让断言自伤
    //    —— 与本仓库「不要在注释里写出会被验收 grep 的字符串」是同一条教训。
    const codeOnly = body
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeOnly, '挂载首轮 accountsRef 为空 ⇒ 该判据恒假，不得复辟')
      .not.toContain('hadExpired')
    expect(codeOnly).not.toContain('snapshotBefore')
  })

  it('★ 补读走 quiet 变体（不得让列表在自愈成功那一刻闪「正在读取」）', () => {
    // 普通 `loadAccounts` 首行是 `setPhase('loading')`，用它会让整块列表
    // 在余额回来那一刻闪一下 —— 本函数只是顺带同步有效期，不该改变加载态。
    const start = source.indexOf('const reloadAccountsQuietly = React.useCallback')
    expect(start, '未找到 reloadAccountsQuietly（补读的静默变体）').toBeGreaterThan(-1)
    const body = source.slice(start, start + 1200)
    expect(body).toContain("rpcCall('account.list'")
    expect(body, 'quiet 变体不得 setPhase').not.toContain("setPhase('loading')")
    // 失败必须静默（余额已经拿到了，不该把面板推进错误态）
    expect(body, 'quiet 变体不得 setError').not.toContain('setError(')
  })

  it('★ 挂载 effect 仍是「并行发起」也不影响正确性（现行修法不依赖时序）', () => {
    // 这条锁住「新修法对挂载路径有效」这个**关键性质**：既然补读是无条件的，
    // 就与 loadAccounts/loadCredits 的先后无关 —— 初版正是因为依赖了时序
    // （快照必须在账号加载完之后）才对主场景失效。
    //
    // ⚠️ 锚点用**该调用本身**（`void loadAccounts();`）而不是
    // `React.useEffect(() => {`：后者会命中文件里**更早**的其它 effect
    //（本组件有多个），取到的片段里当然没有这两个调用 —— 初版就是这么假失败的。
    const mountCall = source.indexOf('void loadAccounts();')
    expect(mountCall, '未找到挂载 effect 里的 void loadAccounts()').toBeGreaterThan(-1)
    const effectBody = source.slice(mountCall, mountCall + 300)
    expect(effectBody).toContain('if (canLoadCredits) void loadCredits();')
    // 无需把挂载改成串行：补读是无条件的（见上一条）
    expect(source).toMatch(/await reloadAccountsQuietly\(\)/)
  })

  it('★★ 「刷新积分」按钮必须传 force（2026-10-16 审计 P1-1）', () => {
    // ⚠️⚠️ 这条是**客户端侧**的端到端接线守卫。宿主侧后端已修（P1-1 的
    //   行为级用例在 `balance-cache-wiring.spec.ts`），但若客户端仍恒不传
    //   `force`，按钮照样失效 —— 而两处都绿（各自只测自己那半）。
    //   ⚠️ **三个调用点语义不同**，不能一刀切：
    //   - 「刷新积分」按钮、签到后补读、新手任务补读 ⇒ **必须 force**；
    //   - 面板挂载时那一次 ⇒ **必须不 force**（否则每次打开都强刷，缓存白做）。
    const start = source.indexOf('const loadCredits = React.useCallback')
    const next = source.indexOf('\n  const ', start + 10)
    const body = source.slice(start, next === -1 ? start + 20000 : next)

    // ① loadCredits 必须按参数决定传不传，而不是恒传或恒不传
    expect(
      body,
      '★★ loadCredits 必须把 force 透传给 credits.balances（否则「刷新」是假的）',
    ).toMatch(/rpcCall\('credits\.balances',\s*force\s*\?[^)]*:\s*\{[^}]*\}\)/)

    // ② 「刷新积分」按钮（2026-10-26 起是**图标按钮**，文案在 title / aria-label 里）
    const button = /onClick: \(\) => void loadCredits\(([^)]*)\)/.exec(source)
    expect(button, '★ 找不到「刷新积分」按钮的 onClick').not.toBeNull()
    expect(button![1], '★★ 「刷新积分」必须传 force=true').toContain('true')

    // ②b 换图标后**必须**补的两处（否则是净损失，与「删除」那枚图标按钮同源教训）：
    //     - `title`：原按钮文案「刷新积分」自带动作语义，图标不自解释
    //     - `aria-label`：svg 标了 aria-hidden，没有它读屏只会念「按钮」
    const refreshAt = source.indexOf('刷新积分：重新查询本页全部账号的剩余积分')
    expect(refreshAt, '★ 「刷新积分」按钮的 title 丢了（图标不自解释）').toBeGreaterThan(-1)
    const refreshBlock = source.slice(Math.max(0, refreshAt - 900), refreshAt + 400)
    expect(refreshBlock, '★★ 图标按钮必须带 dim-jh-iconBtn（否则 svg 会被当文字挤成一行）')
      .toMatch(/className: 'dim-jh-btn dim-jh-iconBtn'/)
    expect(refreshBlock, '★★ 图标按钮必须给 aria-label（svg 是 aria-hidden）')
      .toMatch(/'aria-label':\s*creditsLoading\s*\?/)
    // 加载态不再换文案（没有文字可换）⇒ 必须走 data-loading + disabled 双保险
    expect(refreshBlock, '★ 加载态必须有 data-loading（图标自转的唯一入口）')
      .toMatch(/'data-loading':\s*creditsLoading\s*\?/)
    expect(refreshBlock, '★ 加载态必须 disabled（否则能连点）').toMatch(/disabled:\s*creditsLoading/)

    // ③ 签到 / 新手任务领取后补读（余额刚变，必须绕过缓存）
    expect(source, '★★ 领取积分后补读必须 force').toContain('await loadCredits(true);')

    // ④ 挂载那一次**不得** force（否则每次打开面板都强刷，缓存形同虚设）
    const effect = /if \(canLoadCredits\) void loadCredits\(([^)]*)\);/.exec(source)
    expect(effect, '★ 找不到挂载时的 loadCredits 调用').not.toBeNull()
    expect(effect![1], '★ 挂载时不得 force（要吃缓存）').toBe('')
  })

  it('loadCredits 的 useCallback deps 含补读函数（避免陈旧闭包）', () => {
    // 补读是**本函数新增的调用**：deps 不带它会让 React 持有旧闭包
    //（陈旧 provider / rpcCall），补读打到错误的面板上。
    //
    // ⚠️ **不写死整串 deps**（本仓 AGENTS.md 明令「接线断言一律容忍重构与
    // 签名扩展」；初版写死了 `[provider, rpcCall, canLoadCredits, loadAccounts]`
    // 整串，加一个依赖就假失败）。这里只断言「补读函数出现在 deps 数组里」。
    // ⚠️⚠️ **窗口必须跟随函数体，不能写死字符数**（2026-10-16 审计暴露）：
    //   原为 `source.slice(start, start + 3200)`。`loadCredits` 的注释一加长
    //   （本次给它补了 `force` 的说明，约 +300 字符），deps 数组就被挤出窗口
    //   ⇒ `depsMatch` 变 `null` ⇒ 本条**假红**。
    //   ⇒ 改为「切到下一个 `\n  const ` 顶层声明为止」，与注释长度无关。
    const start = source.indexOf('const loadCredits = React.useCallback')
    const next = source.indexOf('\n  const ', start + 10)
    const body = source.slice(start, next === -1 ? start + 20000 : next)
    const depsMatch = /\}, \[([^\]]*)\]\)/.exec(body)
    expect(depsMatch, '未解析到 loadCredits 的 deps 数组').not.toBeNull()
    expect(depsMatch![1], 'deps 必须含 reloadAccountsQuietly').toContain('reloadAccountsQuietly')
    expect(depsMatch![1], 'deps 必须含 provider').toContain('provider')
  })

  it('「刷新积分」按钮与账号卡片的「积分」行都按能力渲染', () => {
    // 归一化 CRLF：本仓库源码在 Windows 上是 CRLF，直接比对多行字面量会假失败。
    const normalized = source.replace(/\r\n/g, '\n')
    // ⚠️ 2026-10-26 起「刷新积分」是**图标按钮**，`? React.createElement('button'`
    //    与它之间隔了 8 行注释 ⇒ 原正则（注释夹在 `?` 与 createElement 之间就匹配不上）
    //    会假红。改为「canLoadCredits 后面紧跟一个 button 元素」，容忍中间任意注释。
    expect(normalized).toMatch(/canLoadCredits\s*\n(?:\s*\/\/[^\n]*\n|\s*\n)*\s*\? React\.createElement\('button'/)
    expect(normalized).toContain('showCredits: canLoadCredits')
    // AccountCard 必须真的消费 showCredits，否则传了也没用
    // ⚠️ 窗口**必须跟随函数体**，不能写死字符数 —— 2026-10-25 又来一次：
    //    把卡片底部的按钮行提成 `actionsNode` 变量后（它插在 `return` 之前，
    //    约 150 行），函数头到 `CreditBalanceRow` 的间距再次被撑大，
    //    原 `cardStart + 8000` 窗口够不到 ⇒ 本条假红。
    //    ⚠️⚠️ `AccountCard` 是**顶层**函数，函数体内部的大括号都缩进过，
    //    故「顶格 `}` + 换行」就是它的闭合，与内部长度无关。
    const cardStart = normalized.indexOf('function AccountCard(')
    const cardEnd = normalized.indexOf('\n}\n', cardStart)
    const cardBody = normalized.slice(cardStart, cardEnd === -1 ? undefined : cardEnd)
    expect(cardBody).toContain('showCredits')
    expect(cardBody).toMatch(/showCredits\s*\n?\s*\?[\s\S]*CreditBalanceRow/)
  })

  /**
   * 领取结果必须逐账号显示**原因**，不能只给计数。
   *
   * 真实教训：CodeArts 的领取曾因「数字 campaignId 被当成字符串解析」而
   * 全部失败，但 UI 只显示「1 个失败」，用户与排查者都无从判断是凭据问题、
   * 活动未开、还是解析 bug —— 只能靠翻代码 + 抓包定位。
   * 后端一直返回 `results[].outcome.message`，前端不该把它丢掉。
   */
  it('claimCredits 汇总逐账号原因并在面板渲染', () => {
    const normalized = source.replace(/\r\n/g, '\n')
    const start = normalized.indexOf('const claimCredits = async () => {')
    expect(start).toBeGreaterThan(-1)
    const body = normalized.slice(start, start + 3000)
    // 必须读取 results（而不只是 summary）
    expect(body, 'claimCredits 未消费 results').toContain('results')
    // 必须为失败条目带上 outcome.message
    expect(body).toContain('outcome.message')
    // 必须把 details 交给 notice
    expect(body).toContain('details')
    // 渲染层必须真的消费 claimNotice.details
    const renderStart = normalized.indexOf('claimNotice\n')
    expect(renderStart).toBeGreaterThan(-1)
    const renderBody = normalized.slice(renderStart, renderStart + 900)
    expect(renderBody, 'claimNotice 的 details 未被渲染').toContain('claimNotice.details')
    expect(renderBody).toContain('dim-jh-probeDetails')
  })
})

/**
 * ⚠️ **「锁定永久积分」能力面**。
 *
 * 这里最重要的是**前后端一致**：前端决定按钮是否出现、请求是否发出，
 * 后端决定写入是否被接受。两边不一致就是「按钮出现了但点了报 bad-request」
 * 或「功能存在却点不出来」—— 两种都比"没这个功能"更难解释。
 */
describe('永久积分锁定能力', () => {
  /**
   * 支持锁定永久积分的 provider（与后端白名单同一份事实）。
   *
   * ⚠️ 2026-10-06 新增 TRAE（字节）与 LobsterAI（有道）：它们的余额响应带逐包
   * 到期时间（TRAE 的条目级 `expire_time`、LobsterAI 的 `expiresAt`），
   * 归一化到 `deductionEndTime` 后即可用同一个 `splitBuddyCreditsByExpiry` 分桶。
   * ⚠️ 2026-10-12 新增 OfficeAce（华为 MaaS）：creditGroups 自带 expiresAt
   *（订阅套餐包无固定到期 = 永久桶，签到 / 活动包有明确到期），同款判据可分桶。
   *
   * ⚠️ 2026-10-20 新增 Qoder 国际版 / 中国版（用户要求补齐三档分档 + 永久锁）：
   *   `/sash/api/v2/me/usage` 的 `usage.expiresAt` 在个人版下发的恒是**永久哨兵**
   *   `253402214400000`（`9999-12-31`）—— `qoder-credits.ts` 判定为哨兵时
   *   **不写** `deductionEndTime`（未知到期 ⇒ 落永久桶），真实时间戳才写。
   *   ⚠️ 判据是「不写」而非「写一个远期时刻」：后者会让面板渲染出
   *   `9999-12-31（约 2900000 天后）` 这种荒谬文案（见
   *   `tests/unit/qoder-lock-wiring.spec.ts` 的 `packageExpiryMs` 断言）。
   *   ⚠️ **同样必须各占一项**（共用一个 `QoderAuth` 不等于共用一个 id）。
   *
   * ⚠️ 2026-10-20 新增 AStudio（讯飞 AstronStudio）：`/points/balance` 三池各带
   *   `*NextExpireTime`（不带时区的本地时间串），已由 `astudio-credits.ts` 的
   *   `astudioLocalTimeMs` 归一化到 `deductionEndTime`；且已接上
   *   `createCredentialResolver` 的 `kind: 'buddy'` 选号（锁定才真能拦）。
   *
   * ⚠️ 2026-10-20 新增 MiniMax Code 中国版 / 国际版（用户报障：「MiniMax Code
   *   积分也有到期时间，也应当有相同功能」）：`/minimax-cloud/api/v1/credit/details`
   *   的每条 `details[]` 带 `expire_at_ms`（毫秒时间戳，无需换算），已直接写进
   *   `deductionEndTime`；同日接上同一个 `kind: 'buddy'` 选号。
   *   ⚠️ **是两个渠道 id，必须各占一项**（共用一个 `MinimaxAuth` 不等于共用一个 id）。
   */
  const SUPPORTED = [
    LOOMY.id, CODEBUDDY.id, WORKBUDDY.id, TRAE.id, LOBSTERAI.id, OFFICEACE.id,
    QODER.id, QODER_CN.id,
    ASTUDIO.id, MINIMAX.id, MINIMAX_INTL.id,
    // ⚠️ autoclaw / autoclawintl（2026-10-21 用户要求「补锁定开关」）：
    //    本家批次映射里「无到期字段的发放（活动赠送的永久分）」⇒ 永久桶存在
    //    ⇒ 需要锁定能力。两站**各占一项**（账号不互通）。
    AUTOCLAW.id, AUTOCLAW_INTL.id,
    // ⚠️ magicrew / magicrewintl（2026-11-01）：`/api/v1/quota/points/total` 的
    //    `expiring_quota_details[]` 带 `expires_at`（无时区串），残差是永久积分
    //    ⇒ 三档齐；且已接上 `createCredentialResolver` 的 `kind: 'buddy'` 选号
    //    （锁定才真能拦）。两站**各占一项**（账号不互通）。
    MAGICREW.id, MAGICREW_INTL.id,
  ]
  const UNSUPPORTED = [
    'codearts', 'cline', 'raccoon',
  ]

  it('前后端的支持面完全一致（逐个 provider 对账）', () => {
    for (const id of SUPPORTED) {
      expect(supportsPermanentLock(id), `${id} 应支持`).toBe(true)
      expect(PERMANENT_LOCK_PROVIDERS.has(id), `${id} 后端应放行`).toBe(true)
    }
    for (const id of UNSUPPORTED) {
      expect(supportsPermanentLock(id), `${id} 不应支持`).toBe(false)
      expect(PERMANENT_LOCK_PROVIDERS.has(id), `${id} 后端应拒绝`).toBe(false)
    }
    // 白名单不得有多余项：前端不渲染却后端放行 = 死接口
    expect([...PERMANENT_LOCK_PROVIDERS].sort()).toEqual([...SUPPORTED].sort())
  })

  /**
   * ⚠️ 窗口天数必须**前后端同一个值**。前端只做展示，判据在后端；
   * 数字写岔会让用户看到「提示说只烧 8 天内的，实际按 15 天筛号」。
   */
  it('前端窗口常量与后端 BUDDY_EXPIRING_WINDOW_DAYS 相同', () => {
    expect(PERMANENT_LOCK_EXPIRING_WINDOW_DAYS).toBe(BUDDY_EXPIRING_WINDOW_DAYS)
    expect(BUDDY_EXPIRING_WINDOW_DAYS).toBe(15)
  })

  /**
   * ⚠️ 文案必须用**后端回传的窗口天数**渲染，而不是前端那个常量。
   *
   * 窗口可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖（实测 CodeBuddy 中国版的
   * 积分包剩余密集落在 17～30 天，默认 15 天会让整池判成永久）。前端写死数字
   * 就会出现「提示说只烧 15 天内的，实际按 31 天筛号」这种无法解释的偏差。
   */
  it('permanentLockCopy 采纳后端回传的窗口天数', () => {
    expect(permanentLockCopy(CODEBUDDY.id, 31).lockTitle).toContain('31 天内到期')
    expect(permanentLockCopy(WORKBUDDY.id, 31).unlockedNotice).toContain('31 天内到期')
    expect(permanentLockCopy(CODEBUDDY.id, 31).days).toBe(31)
    // 缺省时回落到默认常量（面板初次渲染、后端未回传时不能说谎说没窗口）
    expect(permanentLockCopy(CODEBUDDY.id).days).toBe(PERMANENT_LOCK_EXPIRING_WINDOW_DAYS)
    expect(permanentLockCopy(CODEBUDDY.id, undefined).days).toBe(15)
    expect(permanentLockCopy(CODEBUDDY.id, null).days).toBe(15)
    // ⚠️ 0 是合法值（「没有临时积分」），不能被 `||` 吞成默认值
    expect(permanentLockCopy(CODEBUDDY.id, 0).days).toBe(0)
    expect(permanentLockCopy(CODEBUDDY.id, 0).lockedNotice).toContain('0 天内到期')
    // 非法值回落默认，不渲染出 NaN
    expect(permanentLockCopy(CODEBUDDY.id, -1).days).toBe(15)
    expect(permanentLockCopy(CODEBUDDY.id, 'abc').days).toBe(15)
    expect(permanentLockCopy(CODEBUDDY.id, 15.6).days).toBe(16)
    // Loomy 没有窗口概念：不受该参数影响
    expect(permanentLockCopy(LOOMY.id, 31).days).toBeNull()
    expect(permanentLockCopy(LOOMY.id, 31).lockedNotice).toContain('每日赠送额度')
  })

  it('未登记的 provider 一律不支持（默认关闭）', () => {
    expect(supportsPermanentLock(undefined)).toBe(false)
    expect(supportsPermanentLock('')).toBe(false)
    expect(supportsPermanentLock('loomy-old')).toBe(false)
  })

  describe('permanentLockCopy 的按 provider 文案', () => {
    /**
     * 把 Loomy 的「每日赠送额度」套到两个 buddy 上是**实质性误导**：
     * 它们没有每天刷新的额度池，签到得来的也是 14/30 天后到期的包。
     */
    it('buddy / workbuddy 说「N 天内到期」，不说「每日赠送」', () => {
      for (const id of [CODEBUDDY.id, WORKBUDDY.id]) {
        const copy = permanentLockCopy(id)
        expect(copy.lockTitle).toContain('15 天内到期')
        expect(copy.lockedTitle).toContain('15 天内到期')
        expect(copy.lockedNotice).toContain('15 天内到期')
        expect(copy.unlockedNotice).toContain('15 天内到期')
        expect(copy.lockTitle).not.toContain('每日赠送')
        expect(copy.lockedNotice).not.toContain('今日额度')
      }
    })

    it('loomy 仍说「每日赠送额度」（它是当日到期的池，与 buddy 不同）', () => {
      const copy = permanentLockCopy(LOOMY.id)
      expect(copy.lockedNotice).toContain('每日赠送额度')
      expect(copy.unlockedNotice).toContain('永久积分')
      expect(copy.lockTitle).not.toContain('天内到期')
    })

    /**
     * ⚠️⚠️ `lockTitle` 与 `lockedTitle` **必须可区分**，且只有**前者**带条件标记。
     *
     * 2026-10-28 审计实测：把两者改成**逐字相同**之后，`credits-capabilities` 47 条 +
     * 两条 permanent-lock 的 31 条**全绿** —— 没有任何判据守这一点。
     *
     * 为什么这是缺陷而不是措辞洁癖：`lockTitle` 渲染在**未锁定**状态的按钮上，
     * 那一刻「永久积分留着不动」是**假的**（永久积分正被消耗）；只有 `lockedTitle`
     * 才能直陈现状。两者同文 ⇒ 说明与实际计费口径相反。
     * 另一侧同样要钉住：同面板「刚解锁」的 `unlockedNotice` 说「会继续使用永久积分」，
     * 若未锁定的 `lockTitle` 也说「留着不动」，两句话在同一屏上自相矛盾。
     */
    it('★★ 未锁定的 lockTitle 必须带「锁定后」条件标记，且不得与 lockedTitle 同文', () => {
      for (const id of [...SUPPORTED, 'codearts']) {
        const copy = permanentLockCopy(id)
        expect(copy.lockTitle, `${id}：未锁定的按钮文案丢了「锁定后」⇒ 直陈现状，与体感相反`)
          .toContain('锁定后')
        expect(copy.lockTitle, `${id}：lockTitle 与 lockedTitle 同文 ⇒ 锁定/未锁定两种状态分不清`)
          .not.toBe(copy.lockedTitle)
        expect(copy.lockedTitle, `${id}：已锁定的文案不该带「锁定后」（那句本来就是现状）`)
          .not.toContain('锁定后')
      }
    })

    it('四个文案位都齐（面板直接取用，缺一个就渲染出 undefined）', () => {
      for (const id of [...SUPPORTED, 'codearts']) {
        const copy = permanentLockCopy(id)
        for (const key of ['lockTitle', 'lockedTitle', 'lockedNotice', 'unlockedNotice']) {
          expect(typeof copy[key], `${id}.${key}`).toBe('string')
          expect(copy[key].length, `${id}.${key} 不能为空`).toBeGreaterThan(0)
        }
      }
    })

    /**
     * ★ 句式结构守卫（用户 2026-10-27：「改成直白句式，说明『锁住永久积分 →
     *   只烧 15 天内会作废的 → 这类烧完就没有可用账号了』」，随后「折中一下」）。
     *
     * ⚠️ 为什么要单独钉**顺序**：这三件事的因果链是「留着什么 → 烧什么 → 烧完怎样」，
     *    顺序一乱读者就要自己重新拼接。而旧文案的毛病正是**句式绕** ——
     *    「只消耗「15 天内到期」的积分包」一句里套三层引号，读起来要拆括号。
     * ⚠️ 只断言「包含某关键词」是不够的：把三句话倒过来排、或把「无可用账号」
     *    提到最前面，关键词照样都在、语义却散了。故用 `indexOf` 比较先后。
     *
     * ⚠️ 「没有可用账号」的判据必须写成**正则**，不能是固定字面量：
     *    折中版把措辞收紧成「用完即无可用账号」（书面语），字面量与口语版的
     *    「用完就没有可用账号了」不同。钉死某一种写法会让**改文案时假红**
     *    —— 而本用例真正要守的是「说了这件事」+「顺序对」，不是措辞本身。
     */
    it('★★ 锁定文案必须按「留着永久 → 只烧临期 → 烧完没号」的顺序说清三件事', () => {
      for (const id of [...SUPPORTED]) {
        const copy = permanentLockCopy(id)
        for (const key of ['lockTitle', 'lockedTitle', 'lockedNotice']) {
          const text: string = copy[key]
          const keepIdx = text.indexOf('永久积分留着不动')
          const burnIdx = text.search(/只消耗 \d+ 天内到期的积分|只消耗每日赠送额度/)
          // 「没有可用账号」/「无可用账号」两种措辞都认（见上方注释）。
          const emptyIdx = text.search(/没有可用账号|无可用账号/)
          expect(keepIdx, `${id}.${key} 没说「永久积分留着不动」`).toBeGreaterThan(-1)
          expect(burnIdx, `${id}.${key} 没说「只消耗什么」`).toBeGreaterThan(-1)
          expect(emptyIdx, `${id}.${key} 没说「用完就没有可用账号」`).toBeGreaterThan(-1)
          // 顺序：留着什么 → 烧什么 → 烧完怎样
          expect(keepIdx, `${id}.${key} 顺序错了（「留着不动」应在「只消耗」之前）`)
            .toBeLessThan(burnIdx)
          expect(burnIdx, `${id}.${key} 顺序错了（「只消耗」应在「无可用账号」之前）`)
            .toBeLessThan(emptyIdx)
        }
      }
    })

    it('★★ 不再出现嵌套引号的绕口句式（旧文案的形态）', () => {
      for (const id of [...SUPPORTED]) {
        const copy = permanentLockCopy(id)
        for (const key of ['lockTitle', 'lockedTitle', 'lockedNotice']) {
          // 旧文案：只消耗「15 天内到期」的积分包 —— 引号套在数字外面。
          expect(copy[key], `${id}.${key} 又变回嵌套引号的绕口句式`)
            .not.toMatch(/只消耗「/)
          // 「这类积分用尽后将没有可用账号」——「将」字句比直陈句绕。
          expect(copy[key], `${id}.${key} 又用回了「用尽后将」句式`)
            .not.toContain('用尽后将')
        }
      }
    })

    it('未登记的 provider 回落到 Loomy 口径而不是崩（面板共用同一段代码）', () => {
      // ⚠️ 2026-10-20：原来这里用 `codearts` 当「未登记」的样本，但 codearts
      // 现在已有 `usesExpiryWindow: true`（三档分档 + 永久锁）⇒ 它走的是带天数
      // 那套文案，不再回落。改用一个**确实未登记**的 id，测的才是回落本身。
      expect(permanentLockCopy('modelscope').lockedNotice).toContain('每日赠送额度')
      expect(permanentLockCopy('__not_registered__').lockedNotice).toContain('每日赠送额度')
    })

    it('codearts 现在走带天数的文案，不再回落（三档分档生效后必须如此）', () => {
      const copy = permanentLockCopy('codearts', 15)
      expect(copy.lockedNotice).toContain('15 天内到期')
      expect(copy.lockedNotice).not.toContain('每日赠送额度')
    })
  })
})

/**
 * ⚠️ **客户端源码不得有未声明变量**（真实事故，2026-09-29）。
 *
 * ## 事故经过
 *
 * 给积分行加「当日池分桶」时在 `AccountCard` 里写了
 * `provider === 'loomy' ? '永久' : '长期'`，但**忘了把 `provider` 加进该组件的
 * props 解构**。后果不是显示错，而是**整个 Jet Hub 设置页崩成白屏**：
 *
 * ```
 * ReferenceError: provider is not defined
 *     at AccountCard (client.js:926:1)
 * slot entry crashed in 'settings.section'
 * ```
 *
 * ## 为什么既有测试全绿却漏掉了
 *
 * 本仓库对 `plugin-src/client/*.js` 的测试几乎都是**源码字符串匹配**
 * （`expect(hubSource).toContain('…')`）—— 它们只能证明"某段文字存在"，
 * 证明不了"这段代码能跑"。而 `plugin-src/client/` 是**纯 JS**，`tsc -p
 * tsconfig.json` 只编译 `src/`（TS），**根本不看它**；esbuild 打包也不做
 * 未声明变量检查（它只做语法解析，`provider` 是合法标识符）。
 *
 * 于是这类错误唯一的发现时机就是**用户打开桌面版**。
 *
 * ## 这道闸的做法
 *
 * 用 `tsc --checkJs` 扫客户端源码，**只筛未声明变量两类诊断**
 * （`TS2304` 找不到名称 / `TS2552` 找不到名称但给出相似建议）。
 * 不筛其它诊断 —— 客户端 JS 没有类型标注，全量 `checkJs` 会产出大量
 * JSDoc 风格与第三方类型噪音（实测 `react` 类型缺失、`@param {object}` 写法等），
 * 那些不是我们要防的东西，混进来只会让人把这道闸关掉。
 *
 * ⚠️ 配置在仓库根的 `tsconfig.client-check.json`。
 * ⚠️ 已做**反向验证**：把 `provider` 从 `AccountCard` 的参数里去掉，
 * 本条会以 `TS2552: Cannot find name 'provider'` 变红。
 */
describe('客户端源码静态检查（防未声明变量崩页面）', () => {
  it('plugin-src/client 下没有未声明变量（TS2304 / TS2552）', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const root = resolve(here, '../..')
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.client-check.json')],
      { cwd: root, encoding: 'utf8' },
    )
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    // 只保留「找不到名称」两类：其余诊断（JSDoc 风格、第三方类型）不是本闸的目标。
    const undeclared = output
      .split('\n')
      .filter((line) => /error TS(2304|2552):/.test(line))
    expect(
      undeclared,
      `客户端源码有未声明变量，会在桌面版运行时抛 ReferenceError 并崩掉整个设置页：\n${undeclared.join('\n')}`,
    ).toEqual([])
  }, 120_000)
})
