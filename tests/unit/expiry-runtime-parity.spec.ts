/**
 * ★★ **临期折算的分派真的走能力注册表**（Task 5 的核心验收）。
 *
 * ## 本文件锁的**两条**不变式
 *
 * ### 一、清单 == runtime 里挂了 `expiry` 域的渠道集合
 *
 * ⚠️ 这条**不是同义反复**，也**不能**被消除 —— 两个概念**不是同一件事**：
 *
 * | 东西 | 回答的问题 | 何时确定 |
 * |---|---|---|
 * | `WIRED_EXPIRY_PROVIDERS` | 「这个渠道**接入了**临期折算吗」 | **编译期**（本文件有没有为它写折算原语） |
 * | `ProviderRuntime.expiry` | 「运行时该调**哪个**原语」 | **`apply()` 时**（注册） |
 *
 * 前者被 `aggregate-adapter.ts` 的**四处**过滤（加 `aggregate-expiry.ts`
 * 的「未接入」短路，共 5 个消费点）与**大量不调 `apply()` 的既有测试**消费
 *（实测：在 `tests/unit` 里 grep「临期探针工厂名 + 左括号」共 36 处，减去本文件
 * 自己的 7 处 ⇒ **既有 29 处**；grep「`new` + `AggregateAdapter` + 左括号」共
 * **86 处**。⚠️ 注释刻意不写出左括号，否则注释自己会被下一次 grep 计进去）
 * ⇒ 它**必须**是编译期常量（若改为从 runtime 派生，那些场景下
 * 恒为空数组，`refreshCatalog` 会把**所有虚拟模型过滤掉**、聚合目录整个变空）。
 * 而后者必须等 `apply()`。⇒ 两者的一致性**只能**靠断言锁住。
 *
 * 它锁的真实漂移是：「**有人加了 runtime 注册却忘了加清单**」（或反之）——
 * 症状是「某渠道静默退出聚合候选」或「某渠道被广告却恒不可用」，**都没有日志**。
 *
 * ### 二、折算真的**分派给** runtime 的实现
 *
 * ⚠️ 判据是**注入哨兵**，不是「把旧逻辑抄一遍再自比」：本仓库已两次踩过
 * 同义反复用例（就地复刻旧逻辑、断言它自己的返回值 —— 删掉整个分支照样全绿）。
 * 哨兵值**不可能**由硬编码的 `switch` 产生 ⇒ 恢复旧实现必红。
 * ⚠️ 哨兵**逐个渠道互不相同**：这样「A 渠道拿到了 B 渠道的实现」
 *（本仓库自陈复发 6 次的位置参数错位形态）也会红，而不只是「有没有查表」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { NEVER, UNUSABLE } from '../../src/aggregate-core.js'
import { WIRED_EXPIRY_PROVIDERS, createExpiryProbe } from '../../src/aggregate-expiry.js'
import { createProviderExpiry } from '../../src/provider-expiry.js'
import { apply } from '../../src/index.js'
import { clearProviderRuntimes, registerProviderRuntime, registeredRuntimeIds, runtimeOf } from '../../src/provider-runtime.js'
import { descriptorOf } from '../../src/provider-registry.js'
import { readFileSync } from 'node:fs'

/** 已接入临期折算的渠道（**期望值** —— 真相源是下面两个不变式）。 */
// ⚠️ 2026-10-13 合并审计加入 accio：用户要求「聚合的 qwen3.8-flash 轮换列表里要有
//    accio」，而**决定候选表可见性的是这张表**（不是 AGGREGATE_CHANNELS）⇒
//    只把它加进 AGGREGATE_CHANNELS 是无效接线（模型层归并了，候选层被剔除）。
// ⚠️ 2026-10-13 加入 officeace：用户要求「officeace 加入聚合轮换」。它与 buddy 系
//    **同形**（订阅的每个积分桶都带 `expiresAt`），折算原语见 `officeaceExpiry`。
// ⚠️ 2026-10-17 **本 fork** 加入 modelscope：用户要求「魔塔加入无临期积分的那类轮换」。
//    它属「有余额但不下发到期时间」那一类（有余额即 `NEVER`、烧光即 `UNUSABLE`）。
//    ⚠️ 已知代价：魔粒烧光时不会被提前剔出轮换（平台既不下发重置时刻、也没有别的
//    额度端点）⇒ 耗尽后仍会被选中、失败一次。**这是用户知情接受的取舍**，
//    不许用「猜一个每日 UTC+8 零点」消除它（凭空造上游从未承诺的时刻）。
// ⚠️ 2026-10-17 审计 P0 修复加入 autoclaw：它与 modelscope **同格**
//    （钱包余额报文里没有任何时间字段 ⇒ 有余额即 `NEVER`、烧光即 `UNUSABLE`），
//    折算原语见 `autoclawExpiry`，代价与魔搭**同型**。
//    ⚠️ 这是「三处必须同改」陷阱的**第 4 次复发**（cline → accio → officeace
//    → autoclaw）：PR 只加了 `AGGREGATE_CHANNELS` 而漏了本清单与
//    `createProviderExpiry()`，症状恒定**静默**。
//    ⚠️ 而**本不变式结构上抓不到那种漏法**（两处同步缺失 ⇒ 差集皆空 ⇒ 绿）——
//    真正的防线是「`AGGREGATE_CHANNELS` 的 channel 成员必须在清单里」那条，
//    见本文件末尾的 ★★ 显式豁免表守卫。
const EXPECTED_WIRED = [
  // ⚠️ qoder / qodercn 2026-10-20 加入（**第 7 次复发**，同上成因）：
  //    `usage.expiresAt` 是永久哨兵 `253402214400000`（`9999-12-31`）时
  //    `qoder-credits.ts` **不写** `deductionEndTime` ⇒ 落永久桶 ⇒ 可分档。
  //    ⚠️ 两站域名不同（`openapi.qoder.sh` / `openapi.qoder.com.cn`），
  //    共用一个 `QoderAuth` 但**是两个渠道 id**，故必须各占一项。
  // ⚠️ astudio 2026-10-20 加入：`/points/balance` 三池各带 `*NextExpireTime`，
  //    由 `astudio-credits.ts` 的 `astudioLocalTimeMs` 归一化到 `deductionEndTime`。
  //    这是「只加 AGGREGATE_CHANNELS 而漏本清单」的第 5 次复发。
  // ⚠️ minimax / minimaxintl 2026-10-20 加入（**第 6 次复发**，同上成因）：
  //    `/minimax-cloud/api/v1/credit/details` 的每条 `details[]` 带
  //    `expire_at_ms`（毫秒时间戳），由 `minimax-credits.ts` 直接写进
  //    `deductionEndTime`。⚠️ 国际站另有**地理分流**（307 到中国站且不认
  //    国际站 token）⇒ 折算原语必须透传 `xff`，否则「面板能刷新、聚合候选
  //    却恒折算失败」。两家共用一个 `MinimaxAuth`，但**是两个渠道 id**，
  //    故必须各占一项。
  // ⚠️ magicrew 2026-10-29 加入（**第 8 次复发**，同上成因）：
  //    `/api/v1/quota/points/total` 的 `expiring_quota_details[].expires_at`
  //    （无时区，按 UTC+8 解释）由 `magicrew-credits.ts` 写进 `deductionEndTime`，
  //    折算原语 `magicrewExpiry`；无到期批次 ⇒ `NEVER`、余额为 0 / 取数失败 ⇒ `UNUSABLE`。
  //    ⚠️ 本清单必须与本 PR 的 `WIRED_EXPIRY_PROVIDERS` / `createProviderExpiry()`
  //    三处同步 —— 且本文件末尾另有**逐 id 点名**用例（`★ magicrew 三处同时接线`），
  //    漏加时报告里能直接看到「magicrew」而不是一条集合差。
  // ⚠️ **MagiCrew 国际版**（`magicrewintl`，2026-11-01）：与 `magicrew` 逐字同构
  //    （同一个折算原语 `magicrewExpiry`，只差 product 常量 ⇒ 打的是国际站 host）。
  //    ⚠️ 三处必须同改：本清单 + `WIRED_EXPIRY_PROVIDERS` + `createProviderExpiry()`。
  // ⚠️ monkeycode / monkeycodeintl / baizhi 2026-11-02 加入（**第 9 次复发**，
  //    同一成因：只加 `AGGREGATE_CHANNELS` 不加清单 ⇒ 候选层被闸门剔掉）。
  //    它们属「**有余额但不下发到期时间**」那一类（与 modelscope / autoclaw 同格）：
  //    monkeycode 走 `/api/v1/users/wallet`、baizhi 走控制台
  //    `/api/v1/user/wallet/balance`，都是 cookie 认证 ⇒ 折算原语
  //    `monkeycodeExpiry` / `baizhiExpiry` 里**缺会话直接 `NEVER`**（读不到 ≠
  //    不可用，否则手填 Key 的账号会被静默踢出轮换），有会话则按
  //    「有 `active && remaining > 0` 的包 ⇒ NEVER、一个都没有 ⇒ UNUSABLE」。
  //    ⚠️ 两站账号池不互通 ⇒ 折算原语必须各传各的 product（国际站 cookie 打
  //    国内站回 401，传错则恒 UNUSABLE）。
  'accio', 'astudio', 'autoclaw', 'autoclawintl', 'baizhi', 'buddy', 'codearts',
  'lobsterai', 'loomy', 'magicrew', 'magicrewintl', 'minimax', 'minimaxintl',
  'modelscope', 'monkeycode', 'monkeycodeintl', 'officeace', 'qoder', 'qodercn',
  'trae', 'workbuddy', 'zcode',
]

class FakeCredentials {
  async resolve(): Promise<undefined> { return undefined }
  async describe() { return { configured: false, writable: true } }
  async set(): Promise<void> {}
  async unset(): Promise<void> {}
}
class FakeCommands {
  register() { return () => {} }
}
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
 * 跑一次**真实 `apply()`**。
 *
 * ⚠️ 必须先清空注册表：它是**模块级** Map，而 `registerProviderRuntime` 对重复 id
 * 采取「保留先注册者」⇒ 不清空的话第二次 `apply()` 的注册会被整体跳过，
 * `runtimeOf()` 指向上一轮的实例（与 `provider-runtime-wiring.spec.ts` 同因）。
 */
function applyOnce(): void {
  clearProviderRuntimes()
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', new FakeCommands() as never)
  ctx.provide('llm', new FakeLlm() as never)
  ctx.provide('settings', new FakeSettings() as never)
  apply(ctx)
}

/** runtime 里**真的挂了 `expiry` 域**的渠道集合（真跑 `apply()` 后读）。 */
function runtimeExpiryProviders(): string[] {
  return registeredRuntimeIds()
    .filter((id) => runtimeOf(id)?.expiry !== undefined)
    .sort()
}

/** 造一个「有可用账号」的池桩（折算会真的走到 runtime 的实现）。 */
function poolWithAccount(): never {
  return {
    disabledModelsFor: () => new Set<string>(),
    listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: {} }],
  } as never
}

afterEach(() => { clearProviderRuntimes() })

describe('★ 不变式一：清单 == runtime 里挂了 expiry 域的渠道（真跑 apply()）', () => {
  it('★★ 逐项相等（漏注册一家即红，且点名是哪个）', () => {
    applyOnce()
    const runtimeIds = runtimeExpiryProviders()
    const listed = [...WIRED_EXPIRY_PROVIDERS].sort()
    // ⚠️ 双向点名：`toEqual` 的 diff 在 7 项时不易读，故显式列出缺/多。
    const missingInList = runtimeIds.filter((id) => !listed.includes(id))
    const missingInRuntime = listed.filter((id) => !runtimeIds.includes(id))
    expect(
      missingInList,
      `以下渠道挂了 runtime 的 expiry 域，却**不在** WIRED_EXPIRY_PROVIDERS 里 ⇒ `
      + `它们的模型会被目录过滤掉（用户看不到）：${missingInList.join(', ')}`,
    ).toEqual([])
    expect(
      missingInRuntime,
      `以下渠道在清单里，但 runtime **没有** expiry 域 ⇒ 折算恒 UNUSABLE，`
      + `清单在广告一个不可用的渠道：${missingInRuntime.join(', ')}`,
    ).toEqual([])
    expect(listed).toEqual(EXPECTED_WIRED)
  })

  it('★ 清单里的每个渠道都**真的有**可调用的 credentialExpiry', () => {
    applyOnce()
    for (const id of WIRED_EXPIRY_PROVIDERS) {
      expect(typeof runtimeOf(id)?.expiry?.credentialExpiry, `${id} 的 expiry 域不可调用`).toBe('function')
    }
  })

  it('⚠️ 未接入的渠道（清单外）在 runtime 里也**没有** expiry 域', () => {
    applyOnce()
    // raccoon / cline / gemini 是真实渠道但未接入折算；aggregate / auto 是虚拟 provider。
    // ⚠️ qoder / qodercn **已于 2026-10-20 移出本名单**（它们接入后必须有
    //    expiry 域）—— 留着会与不变式一互相矛盾。本名单只列**当前确实未接入**的。
    for (const id of ['raccoon', 'cline', 'gemini']) {
      expect(runtimeOf(id)?.expiry, `${id} 不该有 expiry 域`).toBeUndefined()
    }
    // 清单本身不得含未接入渠道（否则 aggregate-adapter 会广告恒不可用的候选）。
    expect(WIRED_EXPIRY_PROVIDERS).not.toContain('raccoon')
    expect(WIRED_EXPIRY_PROVIDERS).not.toContain('cline')
  })

  it('★ 未接入的渠道折算为 UNUSABLE（**不是 NEVER**）', async () => {
    // ⚠️ 若返回 NEVER，一个我们对其一无所知的渠道会被排在候选**最前**
    //（NEVER = 长期有效、可当选），而 UNUSABLE = 本次剔除。
    const probe = createExpiryProbe({} as never, async () => undefined)
    expect(await probe('cline')).toBe(UNUSABLE)
    expect(await probe('raccoon')).toBe(UNUSABLE)
    expect(await probe('not-a-channel')).toBe(UNUSABLE)
    expect(UNUSABLE).not.toBe(NEVER)
  })
})

/**
 * ★★ **不变式三（本 PR 新增，补上一个结构性的守卫盲区）**
 *
 * ## 它补的是什么洞
 *
 * 不变式一锁的是「`WIRED_EXPIRY_PROVIDERS` == runtime 里挂了 expiry 域的集合」。
 * 它**双向**都抓，但**抓不到**「某渠道的折算压根没做」这种漏法 ——
 * 因为那种漏法的形态是**清单里没有 + runtime 里也没有** ⇒ **差集为空 ⇒ 全绿**。
 *
 * ⚠️ 这不是假想：本 PR（autoclaw）就踩了 —— 只把 `'autoclaw'` 加进
 * `aggregate-adapter.ts` 的 `AGGREGATE_CHANNELS`（模型层归并会发生、
 * **看起来**接好了），而清单与 `createProviderExpiry()` 两处都漏了。
 * 实测症状：折算恒 `UNUSABLE` ⇒ 用户在聚合轮换列表里**永远看不到 autoclaw**，
 * 且**无报错、无日志**。这是该陷阱的**第 4 次复发**
 * （cline → accio → officeace → autoclaw）。
 *
 * ## 判据
 *
 * 凡进了 `AGGREGATE_CHANNELS` 的**真渠道**（`channel: true`），就**必须**在
 * `WIRED_EXPIRY_PROVIDERS` 里 —— 否则它在候选层被那道闸门剔掉，
 * 「模型层配得再对也没用」。
 *
 * ⚠️ 豁免走**显式、带理由**的表（本仓库红线：不许用静默缺席当豁免）。
 *   真正该豁免的是「余额形态套不进折算骨架」那类（如 opencode 的本地派生余额），
 *   它们**不该**同时出现在 `AGGREGATE_CHANNELS` 里；一旦出现，必须在这里写明理由。
 */
describe('★★ 不变式三：AGGREGATE_CHANNELS 的真渠道都已接入临期折算', () => {
  /**
 * **显式豁免**（key = 渠道 id，value = **可核对的**理由）。
 *
 * ⚠️ 这些**不是**「忘了接线」，而是 `aggregate-expiry.ts` 模块头的逐渠道判据表
 * （`:76-82`）里**明文登记为「本插件未接入 → `UNUSABLE`」**的那一批。
 *   核对方式：读 `src/aggregate-expiry.ts` 的「逐渠道判据」表，或跑
 *   `pnpm vitest run tests/unit/expiry-runtime-parity.spec.ts` 看
 *   「未接入的渠道（清单外）在 runtime 里也**没有** expiry 域」那条用例 ——
 *   它逐个点名断言这些渠道的 `runtime.expiry` 恒 `undefined`。
 *
 * ⚠️⚠️ **为什么必须显式列出，而不能靠「不在清单里就算豁免」**
 *   正是因为那样会让本守卫**恒真**：清单外的渠道天然全部「不在清单里」，
 *   守卫就抓不到任何新增漏接。本表把「已知的、未接入的」固定下来，
 *   任何**新增**的 AGGREGATE_CHANNELS 成员若没同步接线，仍会红。
 *
 * ⚠️ 若将来真接入了某一家，**从本表删掉它**并补上清单 + 原语 + runtime 三处。
 */
const NOT_EXPIRY_WIRED = new Map<string, string>([
  // ⚠️ qoder / qodercn **已于 2026-10-20 从本表移除**（用户要求补齐三档分档 +
  //    永久锁）：它们已接上 `WIRED_EXPIRY_PROVIDERS` + `createProviderExpiry()`
  //    的 `qoderFamilyExpiry`（走 `cachedBalance`）。留在本表会与「豁免表本身
  //    不得与清单重叠」那条用例直接冲突（重叠 = 豁免是假的）。
  //    移除本表才是这条红线的正确走法 —— 不许用「改断言」绕过。
  ['cline', '余额报文无跨账号到期口径；aggregate-expiry.ts:82 登记为未接入'],
  ['raccoon', '同上（aggregate-expiry.ts:82）'],
  // ⚠️ minimax / minimaxintl **已于 2026-10-20 从本表移除**（用户报障：「MiniMax
  //    Code 积分也有到期时间，也应当有相同功能」）。它们已接上
  //    `WIRED_EXPIRY_PROVIDERS` + `createProviderExpiry()` 的 `minimaxExpiry`
  //    原语 ⇒ 留在本表会与「豁免表不得与清单重叠」那条用例直接冲突（重叠 =
  //    豁免是假的）。移除本表才是这条红线的正确走法 —— 不许用「改断言」绕过。
  ['gemini', '同上（aggregate-expiry.ts:82）'],
  ['opencode', '「余额」是本地派生的通道可用性、零网络，套折算骨架会发不存在的请求'],
  // ⚠️⚠️ **Codely**（Unity，2026-10-22 A6）：豁免理由与上面各家**都不同** ——
  //    它的余额端点「能读、且能归一到一个数」，**但上游根本不下发到期时间**。
  //    可核对：`src/codely-credits.ts` 的 `fetchCodelyBalanceDetailed` 把
  //    `/api/user/usage/summary` 抽象成 `CreditPackage` 时，`expiredTime` /
  //    `cycleEndTime` 都写死为**空串**（上游报文只有 `remaining_points` /
  //    `is_exhausted`）。⇒ 缺的是**数据源**，不是接线：强行加进清单只能编一个
  //    假临期档。⚠️ 上游一旦开始下发到期时间，从本表删掉它并补
  //    三处（清单 + `createProviderExpiry()` + 折算原语）。
  ['codely', '上游余额报文**不下发任何到期时间**（codely-credits.ts 的 expiredTime/cycleEndTime 写死空串）⇒ 无临期档可折算'],
  // ⚠️ **本 fork 独有**（qiniu，2026-10-29）：七牛云 AI **没有余额/额度查询
  //    端点**（用量与计费只在控制台可见）⇒ `credits.balance: false` ⇒ 折算层
  //    连「剩多少」都读不到，更谈不上临期档。缺的是**数据源**，不是接线：
  //    强行加进清单只能编一个假数字（本仓库红线「绝不编造数字」）。
  //    ⚠️ 上游一旦开放额度端点，从本表删掉它并补三处（清单 +
  //    `createProviderExpiry()` + 折算原语）—— 走法与 codely 那条相同。
  ['qiniu', '无余额端点（七牛云用量只在控制台可见）⇒ credits.balance: false，折算层读不到任何额度 ⇒ 无临期档可折算'],
  // ── 2026-11-02 审查 B🟡-9：下面三家**已从本表移除**并真的接进清单 ──
  // ⚠️ 留这段是因为原豁免理由**本身是错的**，删掉会让后人重复同一个推理错误。
  //
  // 原理由：「上游不下发到期时间 ⇒ 强行加进清单只能编一个假数字」。
  // 反例就在同一个文件的 `modelscope` / `autoclaw` 条目里：**折算不一定要时刻**。
  // `sharedPackageExpiry` 判的是「有没有 `active === true && remaining > 0` 的包」
  // —— 有 ⇒ `NEVER`（可用、无临期额度），一个都没有 ⇒ `UNUSABLE`（现在烧不了）。
  // 这条判据只依赖**余额本身**，不依赖任何时刻字段 ⇒ 对
  // `monkeycode` / `monkeycodeintl` / `baizhi` 同样成立（三家都实测能读到余额：
  // monkeycode 走 `/api/v1/users/wallet`、baizhi 走控制台的
  // `/api/v1/user/wallet/balance`，都是 cookie 认证）。
  //
  // 取舍（已在折算原语的注释里写明）：**额度烧光不会被提前剔出轮换**
  // （平台不下发重置时刻）⇒ 耗尽后仍会被选中并失败一次。与 modelscope 同型，
  // 且**不许**用「猜一个 UTC+8 零点」消除它。
  //
  // 另注：三家「读余额」要会话 cookie、「发消息」只要主凭据 ⇒ 缺会话时折算原语
  // 直接返回 `NEVER`（读不到 ≠ 不可用），否则手填 Key 的账号会被静默踢出轮换。
])

  it('每个进了 AGGREGATE_CHANNELS 的真渠道都在 WIRED_EXPIRY_PROVIDERS 里（或已显式豁免）', () => {
    // ⚠️ 必须先真跑 `apply()`：下面的 `registeredRuntimeIds()` 读的是
    //   **运行时**注册表，没跑 apply 时它恒为空 ⇒ 交集恒空 ⇒ 本用例恒绿
    //   （这正是「断言前置条件不成立时退化成恒真」的形态）。
    applyOnce()
    // ⚠️ `AGGREGATE_CHANNELS` 是 `AggregateAdapter` 的**私有静态**成员
    // （`aggregate-adapter.ts:909`），对外只有走存活路由交集的那个访问器
    // （`:997`，它会 `listProviders()` 过滤掉宿主没装载的渠道）。
    // ⇒ 这里**读源码字面量**：本守卫要判的是「**编译期事实**（作者有没有把它
    // 写进那张表）」，用运行时会退化成「宿主当前恰好装载了谁」。
    //   判据抽不到字面量时**必须报红**（fail-closed），不能静默放行 ——
    //   否则改名/重构会让本守卫恒真而无人察觉。
    const source = readFileSync(
      new URL('../../src/aggregate-adapter.ts', import.meta.url),
      'utf8',
    )
    const start = source.indexOf('private static readonly AGGREGATE_CHANNELS')
    expect(start, '抽不到 AGGREGATE_CHANNELS 定义（改名/重构会让本守卫恒真）').toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf('])', start))
    const candidates = [...block.matchAll(/'([a-z][a-z0-9]*)'/gi)].map((m) => m[1]!)
      // 排除虚拟 provider 自身与 auto（它们没有自己的账号与余额）。
      .filter((id) => id !== 'aggregate' && id !== 'auto')

    const registered = new Set(registeredRuntimeIds())
    // ⚠️ 反向自检防恒真：若这一步取不到真渠道，用例会退化成「空集合全部通过」。
    const live = candidates.filter((id) => registered.has(id))
    expect(live.length, '前置条件：AGGREGATE_CHANNELS 与 runtime 的交集应非空').toBeGreaterThan(0)

    const missing = live.filter(
      (id) => !WIRED_EXPIRY_PROVIDERS.includes(id) && !NOT_EXPIRY_WIRED.has(id),
    )
    expect(
      missing,
      '以下渠道进了 AGGREGATE_CHANNELS 却**不在** WIRED_EXPIRY_PROVIDERS ⇒ '
      + '模型层归并会发生，但候选层被那道闸门剔掉 ⇒ 用户在聚合轮换列表里'
      + '永远看不到它们，且无报错无日志。修法是三处同改：'
      + '① WIRED_EXPIRY_PROVIDERS ② createProviderExpiry() ③ 折算原语。'
      + `缺的是：${missing.join(', ')}`,
    ).toEqual([])
  })

  it('⚠️ 豁免表本身不得与清单重叠（重叠 = 豁免是假的，清单才是真的）', () => {
    for (const id of NOT_EXPIRY_WIRED.keys()) {
      expect(WIRED_EXPIRY_PROVIDERS, `${id} 同时在清单与豁免表里，语义矛盾`).not.toContain(id)
    }
  })

  /**
   * ★ **逐 id 点名**（2026-10-29，Magicrew）。
   *
   * ## 为什么在「不变式三」之外还要这一条
   *
   * 上面那条是**结构性**判据（`AGGREGATE_CHANNELS ∩ runtime` 派生），它**抓得到**
   * 漏接线，但报错形态是「一条集合差」—— 读报告的人看不到具体渠道名，
   * 而本陷阱已复发 8 次、每次的教训都是「红得不够显眼 ⇒ 被当成 flaky 放过」。
   * ⇒ 把三处**逐名字**钉死：漏任一处都在这个 id 上报红。
   *
   * ## ⚠️ `AGGREGATE_CHANNELS` 的可见性实情（本次核实，未改动）
   *
   * 它是 `AggregateAdapter` 的 `private static readonly`
   * （`src/aggregate-adapter.ts`），**没有**导出。本用例**不**为测试把它改成
   * public —— 生产可见性是设计约束（对外只有经存活路由过滤的那个访问器）。
   * 改用本文件不变式三**已有**的取法：读源码字面量。理由同那里 ——
   * 本守卫要判的是「作者有没有把它写进那张表」（编译期事实），
   * 用运行时会退化成「宿主当前恰好装载了谁」。
   *
   * ⚠️ 抽不到字面量时**必须报红**（fail-closed）：改名/重构会让本守卫恒真。
   */
  it('★ magicrew 三处同时接线（漏任一处 ⇒ 聚合里静默看不到它）', () => {
    // ⚠️ 2026-11-01：本用例改成**两家一起走**（`magicrew` + `magicrewintl`）——
    //    它们逐字同构，只差 product 常量。原先只守国内站，加国际站时
    //    「三处各漏一处」的组合会静默通过（第 8 次复发的同型）。
    const source = readFileSync(
      new URL('../../src/aggregate-adapter.ts', import.meta.url),
      'utf8',
    )
    const start = source.indexOf('private static readonly AGGREGATE_CHANNELS')
    expect(start, '抽不到 AGGREGATE_CHANNELS 定义（改名/重构会让本守卫恒真）').toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf('])', start))
    const channels = [...block.matchAll(/'([a-z][a-z0-9]*)'/gi)].map((m) => m[1]!)
    for (const id of ['magicrew', 'magicrewintl']) {
      expect(channels, `① aggregate-adapter.ts 的 AGGREGATE_CHANNELS 缺 ${id}`).toContain(id)
      // ② 决定**候选表可见性**的那张表（只加 ① 而漏它就是本陷阱的形态）
      expect(WIRED_EXPIRY_PROVIDERS, `② aggregate-expiry.ts 的 WIRED_EXPIRY_PROVIDERS 缺 ${id}`)
        .toContain(id)
      // ③ 折算原语真的挂进了表（`createProviderExpiry()` 是纯表，拿不到 service 实例）
      expect(
        Object.hasOwn(createProviderExpiry(), id),
        `③ provider-expiry.ts 的 createProviderExpiry() 缺 ${id}`,
      ).toBe(true)
    }
  })

  /**
   * ★★ **`magicrewintl` 的折算必须打到国际站 host**（2026-11-01 测试有效性审查的
   * **重要项**，变异 M2）。
   *
   * 上面那条只断「表里有这个 id」，而**不断** `credentialExpiry` 里
   * `product: MAGICREW_INTL` 传没传 —— 实测把那一行删掉后，452 条折算用例**全绿**。
   *
   * 生产症状正是 `src/provider-expiry.ts` 那段注释自己写的：漏传 ⇒ 用国内基址
   * （`i-magic-service.letsmagic.cn`）查国际账号余额 ⇒ 恒失败 ⇒ 折算恒 `UNUSABLE`
   * ⇒ 国际站候选从轮换表里**静默消失**（与 `autoclawintl` 那条同型）。
   *
   * ⚠️ 判据必须是**行为**（真发一次请求、断完整 URL），不能是源码文本匹配
   *   —— 后者对「product 改成 MAGICREW 而常量名仍出现」无牙。
   */
  it('★★ magicrewintl 的折算打国际站 host（漏传 product ⇒ 折算恒 UNUSABLE）', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      // 回一个「有余额」的最小信封，避免走 UNUSABLE 分支掩盖请求本身。
      return new Response(
        JSON.stringify({ code: 1000, data: { total_points: 100, expiring_quota_details: [] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    try {
      const entry = createProviderExpiry().magicrewintl
      expect(entry?.credentialExpiry, 'magicrewintl 的 credentialExpiry 没挂上').toBeDefined()
      await entry!.credentialExpiry!(
        { jwt: 'JWT-SPEC', organizationCode: 'org-spec' } as never,
        undefined as never,
      )
      expect(seen.length, '折算一个请求都没发（被 cachedBalance 短路了？）').toBeGreaterThan(0)
      expect(seen[0], 'magicrewintl 的折算打到了国内站 host ⇒ 恒失败 ⇒ 候选静默消失')
        .toBe('https://magic-service.magicrew.ai/api/v1/quota/points/total')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('★★ 不变式二：折算真的分派给 runtime（哨兵注入，硬编码 switch 不可能通过）', () => {
  it('★ 7 家各注册一个**互不相同**的哨兵 ⇒ 探针逐个返回自己的哨兵', async () => {
    clearProviderRuntimes()
    const sentinelOf = new Map<string, number>()
    for (const [index, id] of EXPECTED_WIRED.entries()) {
      const sentinel = 1_700_000_000_000 + index * 1000
      sentinelOf.set(id, sentinel)
      registerProviderRuntime({
        descriptor: descriptorOf(id)!,
        expiry: { credentialExpiry: async () => sentinel },
      })
    }

    for (const [id, sentinel] of sentinelOf) {
      // ⚠️ 每个渠道一个**新探针**：缓存是探针实例级的，复用会让后一个渠道命中
      //    前一个的缓存 —— 那样本用例就测不到分派，只测到缓存。
      const probe = createExpiryProbe(poolWithAccount(), async () => 'm1')
      expect(await probe(id), `${id} 没有走 runtime 的 expiry 域（或拿到了别家的实现）`)
        .toBe(sentinel)
    }
  })

  it('★ 探针原样透传 runtime 的结论（NEVER / UNUSABLE 两个语义相反的哨兵都不改写）', async () => {
    // ⚠️ 分派层**不得**改写原语的结论：`NEVER`（长期、可当选）与 `UNUSABLE`
    //（查不到、剔除）语义相反，压成一个就是本模块头警告的「把未知当可用」。
    clearProviderRuntimes()
    registerProviderRuntime({
      descriptor: descriptorOf('buddy')!,
      expiry: { credentialExpiry: async () => NEVER },
    })
    registerProviderRuntime({
      descriptor: descriptorOf('zcode')!,
      expiry: { credentialExpiry: async () => UNUSABLE },
    })
    expect(await createExpiryProbe(poolWithAccount(), async () => 'm1')('buddy')).toBe(NEVER)
    // zcode 的实现回 UNUSABLE ⇒ 该账号被跳过 ⇒ 一个都没成功 ⇒ 渠道级 UNUSABLE。
    expect(await createExpiryProbe(poolWithAccount(), async () => 'm1')('zcode')).toBe(UNUSABLE)
  })

  it('★★ 清单内的渠道若 runtime **没有** expiry 域 ⇒ 兜底 `UNUSABLE`（**不是 `NEVER`**）', async () => {
    // ⚠️⚠️ 本用例守的是 `credentialExpiry` 的**兜底分支**
    //   （`runtime?.expiry === undefined` ⇒ `UNUSABLE`）。
    //
    // 它此前**零覆盖**（独立复审实测证伪）：要走到那一行，两个前置条件必须**同时**成立 ——
    //   ① 渠道**在** `WIRED_EXPIRY_PROVIDERS` 里 —— 否则更早的「未接入」短路
    //     （`if (!WIRED_EXPIRY_PROVIDERS.includes(provider)) return UNUSABLE`）就返回了；
    //   ② 它的 runtime **没有** `expiry` 域 —— 而生产装配下 ①⇒② 由本文件的不变式一
    //     挡住（清单 == runtime 里挂了 expiry 域的集合）。
    // ⇒ 既有的「未接入」用例全部**只**命中①之外的短路分支，没有一条能到这一行：
    //   把这里的 `UNUSABLE` 改成 `NEVER` 曾**不会让任何用例变红**。
    //
    // 而 `NEVER` 正是本模块的**第一红线**：它的语义是「可用、只是无临期额度」，
    // **参与排序且可当选**。返回它 = 把一个我们对其余额一无所知的渠道排到候选
    // **最前**并选中它 —— 而该渠道可能压根没有可用账号。
    clearProviderRuntimes()
    // ⚠️ 只注册 descriptor，**刻意不挂** `expiry` 域（这就是②）。
    registerProviderRuntime({ descriptor: descriptorOf('buddy')! })
    // 前置条件必须显式断言：否则「渠道不在清单里」时本用例会退化成
    // 「又测了一遍短路分支」—— 绿得毫无意义（本仓库记录过的同义反复形态）。
    expect(WIRED_EXPIRY_PROVIDERS, '前置条件①：buddy 必须在清单里').toContain('buddy')
    expect(runtimeOf('buddy')?.expiry, '前置条件②：buddy 的 runtime 必须**没有** expiry 域')
      .toBeUndefined()

    // 池里有可用账号 ⇒ 探测不会在「无可用账号」处提前返回，真的走到分派那一行。
    const probe = createExpiryProbe(poolWithAccount(), async () => 'm1')
    expect(
      await probe('buddy'),
      'buddy 在清单里、runtime 却没有 expiry 域 ⇒ 必须 `UNUSABLE`（剔除该候选）。'
      + '返回 `NEVER` 会让这个「我们一无所知」的渠道被排在候选最前并当选',
    ).toBe(UNUSABLE)
  })

  it('★ 分派是**按 id** 的：把某家的实现换掉，只有它受影响（错位即红）', async () => {
    // ⚠️ 这条独立于上一条：上一条证明「查了表」，本条证明「查对了键」。
    //    若分派写成「按注册顺序取第一个」或键写错，上一条可能仍绿（哨兵恰好对），
    //    但本条会红 —— 因为只有 trae 被换成了哨兵，其余必须仍是原语的真实结论。
    clearProviderRuntimes()
    const sentinel = 987_654_321
    registerProviderRuntime({
      descriptor: descriptorOf('trae')!,
      expiry: { credentialExpiry: async () => sentinel },
    })
    registerProviderRuntime({
      descriptor: descriptorOf('loomy')!,
      expiry: { credentialExpiry: async () => NEVER },
    })
    expect(await createExpiryProbe(poolWithAccount(), async () => 'm1')('trae')).toBe(sentinel)
    expect(await createExpiryProbe(poolWithAccount(), async () => 'm1')('loomy')).toBe(NEVER)
  })
})
