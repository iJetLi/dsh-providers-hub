/**
 * 各 provider 的**临期折算能力实现表** —— `ProviderRuntime.expiry` 域的唯一真源。
 *
 * ## 它解决什么
 *
 * 重构前，`src/aggregate-expiry.ts` 的 `credentialExpiry(provider, credential)`
 * 是一个 7-case `switch`，而**每个分支体都只是「调一个原语」**
 *（`buddyExpiry` / `loomyExpiry` / `codeArtsExpiry` / `zcodeExpiry` /
 * `lobsteraiExpiry` / `traeExpiry`）—— 与 `account.refresh` 的 13 个同构 case
 * 完全同型。那 7 个分支体里**没有一行协议逻辑**，只有「选哪个原语」。
 *
 * ## ⚠️ 为什么单独一个文件（而不是把表内联在 `index.ts`）
 *
 * 内联在 `index.ts` 里时，**单测无法复用**那张表：`createExpiryProbe` /
 * `AggregateAdapter` 有几十处用例直接构造（**不调 `apply()`**），它们要验证
 * 折算**值**（TTL 缓存、取全部账号、`clear()` 等）就必须让 runtime 里有真实实现。
 * 若那些用例各写一份自己的表，就出现**同一语义两套判据** —— 本仓库首条红线
 *（`buddy-growth.ts` 因两处对同一字段给出相反判据而静默失效）。
 * ⇒ 表放在这里，`src/index.ts` 与单测**共用同一份**。
 *
 * ⚠️ 与 `createProviderCredits` / `createProviderOnboarding` 同款理由
 *（那两张表也是「工厂在 src、生产与单测共用」）。
 *
 * ## ⚠️ 边界：本表只做「选哪个原语」，**不**抽象原语本身
 *
 * 各家 `*Expiry` 函数（判据不同、量纲不同）原样保留在 `aggregate-expiry.ts`，
 * 本表只是把它们挂到一张可查的表上（设计文档 §3.5.3 / §3.6）。
 * `buddy` 与 `workbuddy` **共用** `buddyExpiry`、只换 product 配置 ——
 * 与 `BuddyProduct` 驱动其余差异同款，避免同族分叉。
 *
 * ## ⚠️ 只覆盖**已接入临期折算**的渠道（刻意不在此写数字：权威是
 * `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`，抄一份必然漂移）
 *
 * 未接入的渠道（`qoder` / `qodercn` / `cline` / `raccoon` / `minimax` /
 * `gemini` / `opencode`）**刻意缺席**：它们的余额响应没有跨账号的到期口径
 *（见 `aggregate-expiry.ts` 的逐渠道判据表）。缺席的**运行时后果**是
 * `credentialExpiry` 返回 `UNUSABLE`（该候选本轮被剔除）。
 *
 * ## ⚠️⚠️ **但「哪些虚拟模型可以播报」不由本表派生**（2026-10-08 设计复审更正）
 *
 * 那由 `aggregate-expiry.ts` 的**编译期常量** `WIRED_EXPIRY_PROVIDERS` 决定。
 * 两者回答的是**两个不同的问题**：本表答「**运行时**该调哪个原语」（要到
 * `apply()` 注册时才填充），那个常量答「这个渠道**接入了**折算吗」（编译期事实：
 * 源码里有没有为它写折算原语）—— 不是同一件事，故不能互为派生源。
 *
 * ⇒ **别把那个常量改成本表的派生值**（它看起来像一份冗余的手抄清单，其实不是）。
 * 它在源码里有 **5 个**消费点：`aggregate-adapter.ts` 的**四处**过滤
 *（探测排序 / 面板候选 / 虚拟模型播报 / 选择器价格后缀）加 `aggregate-expiry.ts`
 * 的「未接入」短路（⚠️ **轮换候选**的闸门正是这处短路，不是那四处过滤）；
 * 更要紧的是它被**大量不调 `apply()`** 的既有测试消费（实测：在 `tests/unit` 里
 * grep「临期探针工厂名 + 左括号」共 36 处，减去 `expiry-runtime-parity.spec.ts`
 * 自己的 7 处 ⇒ **既有 29 处**；grep「`new` + `AggregateAdapter` + 左括号」共
 * **86 处**。⚠️ 注释刻意不写出左括号，否则注释自己会被下一次 grep 计进去）——
 * 派生版本在那些场景下**恒为空数组**，`refreshCatalog` 会把**所有虚拟模型过滤掉**、
 * 聚合 provider 的模型列表**整个变空**。
 * 两者的一致性由 `tests/unit/expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死。
 */

import {
  accioExpiry,
  buddyExpiry,
  codeArtsExpiry,
  lobsteraiExpiry,
  loomyExpiry,
  officeaceExpiry,
  traeExpiry,
  // ⚠️ **本 fork 独有**（魔搭，2026-10-17）
  modelscopeExpiry,
  // ⚠️ AutoClaw（智谱，2026-10-17 审计 P0 修复新增）
  autoclawExpiry,
  // ⚠️ Qoder（国际版 / 中国版共用，2026-10-20 新增）
  qoderExpiry,
  // ⚠️ AStudio（讯飞 AstronStudio，2026-10-20 新增）
  astudioExpiry,
  // ⚠️ MiniMax Code（中国版 / 国际版共用，2026-10-20 新增）
  minimaxExpiry,
  zcodeExpiry,
  // ⚠️ MonkeyCode 国内站 / 国际站 + 百智云（本 fork 独有，2026-11-02 新增）
  monkeycodeExpiry,
  baizhiExpiry,
} from './aggregate-expiry.js'
// ⚠️ Qoder（国际版 / 中国版，2026-10-20 新增）：与 minimax 同款 —— 两站共用
//    同一套 `src/qoder*.ts` 实现，差异全在 `src/qoder-product.ts` 的
//    `QODER` / `QODER_CN` 常量（域名 / client_id / 模型表）。
import { QODER, QODER_CN, type QoderProduct } from './qoder-product.js'
import type { QoderCredential } from './qoder.js'
// ⚠️ **本 fork 独有**（魔搭，2026-10-17）
import { MODELSCOPE } from './modelscope-product.js'
// ⚠️ MonkeyCode 两站 + 百智云（本 fork 独有，2026-11-02）：折算原语吃 product，
//    两站必须各传各的（账号池不互通、域名不同：国际站 cookie 打国内站回 401）。
import { MONKEYCODE, MONKEYCODE_INTL } from './monkeycode-product.js'
import type { MonkeycodeCredential } from './monkeycode.js'
import { BAIZHI } from './baizhi-product.js'
import type { BaizhiCredential } from './baizhi.js'
import type { ModelscopeCredential } from './modelscope.js'
// ⚠️ AutoClaw（智谱，2026-10-17 审计 P0 修复新增）
import { AUTOCLAW, AUTOCLAW_INTL } from './autoclaw-product.js'
import type { AutoclawCredential } from './autoclaw.js'
// ⚠️ AStudio（讯飞 AstronStudio，2026-10-20 新增）
import { ASTUDIO } from './astudio-product.js'
import type { AstudioCredential } from './astudio.js'
// ⚠️ MiniMax Code（中国版 / 国际版，2026-10-20 新增）
import { MINIMAX, MINIMAX_INTL, type MinimaxProduct } from './minimax-product.js'
import type { MinimaxCredential } from './minimax.js'
import type { AccioCredential } from './accio.js'
import type { OfficeAceCredential } from './officeace-auth.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from './product.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { TRAE } from './trae-product.js'
import type { BuddyCredential } from './buddy.js'
import type { CodeArtsCredential } from './types.js'
import type { LoomyCredential } from './loomy.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { TraeCredential } from './trae.js'
import type { ZcodeCredential } from './zcode.js'
// ⚠️ Magicrew（超级麦吉，2026-10-29 新增）：折算原语**就在取数模块里**
//    （`magicrew-credits.ts` 的 `magicrewExpiry`）—— 本表只做「凭据 → 它要的入参」
//    这一层映射，**绝不重算折算**（本仓库红线：折算映射只许有一份）。
import { magicrewExpiry } from './magicrew-credits.js'
import { MAGICREW, MAGICREW_INTL } from './magicrew-product.js'
import { parseMagicrewCredential } from './magicrew-auth.js'
import type { ProviderRuntime } from './provider-runtime.js'
// ⚠️ 只导入**类型**（`CreditBalance` 是取数原语的返回形状）：本表只是「选哪个原语」，
//    不解释余额内容（那个判据在 `aggregate-expiry.ts` 的各家原语里）。
import type { CreditBalance } from './credits.js'

/** 一个渠道的临期折算实现（`ProviderRuntime.expiry` 的非空形态）。 */
export type ProviderExpiry = NonNullable<ProviderRuntime['expiry']>

/**
 * 建表所需的**装配层依赖**（可选 —— 省略时行为与升级前一致）。
 *
 * ⚠️ 为什么不像 `createProviderCredits` 那样必填：本表有**几十处既有单测**
 *    直接 `createProviderExpiry()` 建表验折算值（`aggregate-expiry.spec.ts` /
 *    `officeace-expiry.spec.ts` / `zcode-expiry-exhausted.spec.ts` / …），
 *    给它们全部补参数是无收益的机械改动。省略时不传该 deps 的那几家
 *    （目前只有 minimax 系需要它）走各自「无 xff」的回落路径 ——
 *    那与中国版的实际行为**完全一致**，只对国际站少一层绕行。
 */
export interface ProviderExpiryDeps {
  /**
   * MiniMax 国际站的 `X-Forwarded-For` 绕行头（**惰性**读，用户随时可改）。
   *
   * ⚠️ **必须惰性**：与 `createProviderCredits` 的同名字段同因 —— 注册时固化
   *    成一个字符串会让「改设置后不生效」。
   * ⚠️ 省略 ⇒ `minimaxExpiry` 收 `undefined` ⇒ **中国版行为不变**，
   *    国际站在被地理分流到中国站时折算失败（那正是 IKMEVG 的形态）。
   */
  readonly minimaxXff?: () => string | undefined
  /**
   * MiniMax **国际站**的按账号 fetcher（PR !145 审计 P0 修法）。
   *
   * ## ⚠️⚠️ 为什么必须有它
   *
   * `agent.minimax.io` 按出口 IP 国别分流：大陆出口直连恒 307 到中国站，中国站
   * 不认国际站 token ⇒ 401。而**聚合轮换的候选可见性由折算决定**
   *（`aggregate-expiry.ts` 的 `credentialExpiry` 拿不到读数 ⇒ `UNUSABLE`
   * ⇒ 该候选被 `rankCandidates` 剔除）⇒ 没接这条腿时，用户配好代理、
   * 对话能用了，但**该渠道仍从聚合轮换里静默消失**，且零报错。
   *
   * PR !145 的注释自己点了这个症状，却只把 fetcher 接进了选号器
   *（`BuddyBalanceSelector`）与适配器 —— **折算路径一行没改**。
   *
   * ⚠️ 与 {@link minimaxXff} 的关系：**两者互补**。XFF 只是「声明」一个海外 IP
   *（上游不认该头即失效），本字段是**真正**换出口。
   *
   * ⚠️ 必须**惰性**调用（按 `accountId` 现取）：账号可能随时在面板里改代理。
   */
  readonly minimaxIntlFetchFor?: (accountId: string) => typeof fetch
  /**
   * Qoder（**两站共用**）的按账号 fetcher（2026-10-25 审计 A2-17，B2 判「合入前必须补」）。
   *
   * ## ⚠️⚠️ 为什么必须有它（与 {@link minimaxIntlFetchFor} 同因，但**本 PR 漏接了**）
   *
   * Qoder **国际版**全部端点在墙外被 SNI 阻断，唯一出路是 per-账号出口代理。
   * 那套代理在 `618a090` 里接了**四条腿**：推理、原生搜索、余额选号、登录/续期/目录。
   * 但**折算路径一行没改** —— `qoderExpiry` 内部调
   * `fetchQoderCreditBalance(credential, product)`（**不带 fetcher**）⇒ 走全局 `fetch`
   * ⇒ 墙外环境下折算**恒失败** ⇒ `aggregate-expiry` 拿到 `undefined`
   * ⇒ 该渠道折算成 `UNUSABLE` ⇒ 被 `rankCandidates` 剔除
   * ⇒ **用户在聚合轮换列表里永远看不到 qoder / qodercn**，且**零报错、零日志**；
   * 而面板（走选号器那条腿）看起来完全正常。
   *
   * ⚠️ 这不是「与本 PR 无关的既有缺口」：`index.ts` 明写
   * 「`credits` 与 `expiry` 是两个独立消费域……**两条腿缺一不可**，
   * 这正是本仓库记过 6 次的那类静默陷阱」，而本 PR 恰好只接了 credits 一侧。
   * {@link minimaxIntlFetchFor} 的注释也逐字点了同一个症状
   * （「只把 fetcher 接进了选号器与适配器 —— 折算路径一行没改」）。
   *
   * ⚠️ 与 {@link minimaxIntlFetchFor} **分开两个键**而不是共用一个：两家的解析器
   *    是不同实例（`minimaxIntlFetchForAccount` / `qoderFetchForAccount`），
   *    合成一个会让「只接了一家」静默通过。
   * ⚠️ 必须**惰性**调用（按 `accountId` 现取）：账号可能随时在面板里改代理。
   */
  readonly qoderFetchFor?: (accountId: string) => typeof fetch
}

/**
 * buddy 系的折算（**两个产品共用同一个原语**，只换 product 配置）。
 *
 * ⚠️ 单独抽出来是为了让下面两条一眼看出「它们只差一个 product」——
 * 若将来有人给其中一家写一份自己的判据，那正是「同族分叉」的开始。
 *
 * ⚠️ `context.cachedBalance` 原样透给原语（2026-10-15，规格 §5.7）：
 * 那样「吃共享读数」这条能力**只在这一处**声明，四家自动一致
 *（各写一遍必然有一家漏掉 ⇒ 静默多发一次上游请求）。
 */
function buddyFamilyExpiry(product: BuddyProduct): ProviderExpiry {
  return {
    credentialExpiry: (c, context) => buddyExpiry(
      product,
      c as BuddyCredential,
      context?.cachedBalance === undefined
        ? undefined
        : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
    ),
  }
}

/**
 * 构造「id → 临期折算」的表。
 *
 * ⚠️ 返回**新对象**（不是模块级单例）：调用方（`index.ts` 与单测）各自持有一份，
 * 互不影响；表本身是**无状态**的（每个值只是一层转发闭包），故无共享状态风险。
 */
export function createProviderExpiry(deps: ProviderExpiryDeps = {}): Readonly<Record<string, ProviderExpiry>> {
  return {
    // ⚠️ 两个 buddy 系产品：原语相同、product 不同（`CODEBUDDY` / `WORKBUDDY`）。
    buddy: buddyFamilyExpiry(CODEBUDDY),
    workbuddy: buddyFamilyExpiry(WORKBUDDY),
    loomy: { credentialExpiry: (c) => loomyExpiry(c as LoomyCredential) },
    codearts: { credentialExpiry: (c) => codeArtsExpiry(c as CodeArtsCredential) },
    zcode: { credentialExpiry: (c, context) => zcodeExpiry(c as ZcodeCredential, context) },
    lobsterai: {
      credentialExpiry: (c, context) => lobsteraiExpiry(
        c as LobsteraiCredential,
        LOBSTERAI,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    trae: {
      credentialExpiry: (c, context) => traeExpiry(
        c as TraeCredential,
        TRAE,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    // ⚠️ accio：与 loomy **同形**（命名池、无逐包时间戳）⇒ 单独一条原语。
    //    加它时必须**同时**进 `WIRED_EXPIRY_PROVIDERS`（`expiry-runtime-parity.spec.ts`
    //    真跑 `apply()` 锁这两者一致；只改一处会红）。
    accio: { credentialExpiry: (c) => accioExpiry(c as AccioCredential) },
    // ⚠️ officeace：与 **buddy 系同形**（订阅的每个积分桶都带 `expiresAt`）。
    //    ⚠️ **必须传 `context.credentialRef`**：它的余额入口只有拿到 ref 才走
    //    云侧直读，否则回落到果办客户端的全局单 cookie ⇒ 多账号折算成同一份
    //    余额（串号），而聚合候选排序是每账号粒度 ⇒ 会选错人。
    //    同 accio：两处（本表 + `WIRED_EXPIRY_PROVIDERS`）必须同改。
    officeace: {
      credentialExpiry: (c, context) =>
        officeaceExpiry(c as OfficeAceCredential, context?.credentialRef),
    },
    // ⚠️ **本 fork 独有**（魔搭，2026-10-17，用户明确要求加入聚合轮换）：
    //    属「有余额但不下发到期时间」那一类 ⇒ 有余额即 `NEVER`、烧光即 `UNUSABLE`。
    //    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae 同款 —— 聚合每轮折算会对
    //    同一账号反复提问，没有共享读数就会白发大量重复请求。
    //    同 accio / officeace：两处（本表 + `WIRED_EXPIRY_PROVIDERS`）必须同改，
    //    由 `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁一致。
    modelscope: {
      credentialExpiry: (c, context) => modelscopeExpiry(
        c as ModelscopeCredential,
        MODELSCOPE,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    // ⚠️ **AutoClaw**（智谱，2026-10-17 审计 P0 修复）：与 modelscope **同格**
    //    （钱包余额不下发到期时间 ⇒ 有余额即 `NEVER`、烧光即 `UNUSABLE`）。
    //    ⚠️ 三处必须同改（本表 + `WIRED_EXPIRY_PROVIDERS` + 折算原语）——
    //    这是该陷阱的第 4 次复发，漏任何一处的症状都是**静默**的
    //    （用户在聚合轮换列表里看不到该渠道，零报错零日志）。
    //    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae / modelscope 同款 ——
    //    聚合每轮折算会对同一账号反复提问，没有共享读数就白发大量重复请求。
    autoclaw: {
      credentialExpiry: (c, context) => autoclawExpiry(
        c as AutoclawCredential,
        AUTOCLAW,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    /**
     * **AutoClaw 国际版**（`autoclawintl`，2026-10-20）。
     *
     * ⚠️⚠️ **product 必须传 `AUTOCLAW_INTL`**：`autoclawExpiry` 内部拿它调
     *    `fetchAutoclawBalanceDetailed(cred, { product })` ⇒ 传国内版会用
     *    **国内基址**查国际账号的余额 ⇒ `410000 未登录` ⇒ 折算恒 `UNUSABLE`
     *    ⇒ 国际账号在聚合轮换列表里**静默不可见**。
     *    这是「同一实现两个实例」最容易踩的一处（与 `provider-credits.ts` 同型）。
     *
     * ⚠️ 批次**实测带** `deductionEndTime`（国际站 3000 → 10/21、10000 → 10/27），
     *    与 buddy 系同形 ⇒ 走 `sharedPackageExpiry` 正确的按到期折算，不是恒 NEVER。
     */
    autoclawintl: {
      credentialExpiry: (c, context) => autoclawExpiry(
        c as AutoclawCredential,
        AUTOCLAW_INTL,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    // ⚠️ **MonkeyCode 国内站 / 国际站 / 百智云**（本 fork 独有，2026-11-02 审查
    //    B🟡-9 补齐）：三家的余额接口都**要会话 cookie**，而推理只要主凭据
    //    （monkeycode 是 `oma_` + `signing_secret`、baizhi 是 `sk-`）⇒ 折算原语
    //    `monkeycodeExpiry` / `baizhiExpiry` 在入口先判 `session_cookie`：
    //    **缺会话直接 `NEVER`**（读不到 ≠ 不可用，否则手填 Key 的账号会被静默
    //    踢出轮换）。有会话时走 `sharedPackageExpiry` 的如实判据。
    //    ⚠️ 三处必须同改（本表 + `WIRED_EXPIRY_PROVIDERS` + 折算原语）——
    //    本仓库该陷阱已复发 5 次，漏任何一处症状都是**静默**的。
    //    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae / modelscope 同款 ——
    //    聚合每轮折算会对同一账号反复提问，没有共享读数就白发大量重复请求。
    //    ⚠️⚠️ `monkeycodeintl` **必须传 `MONKEYCODE_INTL`**：传国内站会让国际账号
    //    折算恒 `UNUSABLE`（它的 cookie 打国内站回 401）⇒ 静默不可见。
    monkeycode: {
      credentialExpiry: (c, context) => monkeycodeExpiry(
        c as MonkeycodeCredential,
        MONKEYCODE,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    monkeycodeintl: {
      credentialExpiry: (c, context) => monkeycodeExpiry(
        c as MonkeycodeCredential,
        MONKEYCODE_INTL,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    baizhi: {
      credentialExpiry: (c, context) => baizhiExpiry(
        c as BaizhiCredential,
        BAIZHI,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    // ⚠️ **AStudio**（讯飞 AstronStudio，2026-10-20）：与 **buddy 系同形**
    //    （三池各带 `*NextExpireTime` ⇒ 逐包真实到期时刻，`astudioExpiry` 走
    //    `sharedPackageExpiry` 取最早那包）。
    //    ⚠️ 三处必须同改（本表 + `WIRED_EXPIRY_PROVIDERS` + 折算原语）——
    //    这是该陷阱的第 **5** 次复发（cline → accio → officeace → autoclaw → astudio），
    //    漏任何一处的症状都是**静默**的（用户在聚合轮换列表里看不到该渠道，
    //    零报错零日志）。
    //    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae / modelscope 同款 ——
    //    聚合每轮折算会对同一账号反复提问，没有共享读数就白发大量重复请求。
    astudio: {
      credentialExpiry: (c, context) => astudioExpiry(
        c as AstudioCredential,
        ASTUDIO,
        context?.cachedBalance === undefined
          ? undefined
          : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      ),
    },
    // ⚠️ Magicrew（2026-10-29）：折算原语是 `magicrew-credits.ts` 的 `magicrewExpiry`。
    //    ⚠️ 它是 **async + 自带取数腿**（缓存缺席 / null / undefined 时自己发请求）——
    //    这正是 `src/provider-runtime.ts:218-231` 要求的契约，别在这里只传值。
    //    ⚠️ 与 ① ② 必须三处同改（`expiry-runtime-parity.spec.ts` 真跑 apply() 锁一致性）。
    magicrew: {
      credentialExpiry: async (c, context) => {
        /**
         * ⚠️ **共用 `parseMagicrewCredential`**，不要在这里手写 `c?.jwt ?? ''`
         *（2026-10-29 最终审查 I4）：`MagicrewService.expiry` 走的是共享解析器，
         *  两处各写一套「什么算有效凭据」就是同义判据（本仓红线）。
         *  统一后两者的差别只剩「service 侧可注入 `now`」，那是有意的。
         */
        const credential = parseMagicrewCredential(c)
        return await magicrewExpiry({
          jwt: credential?.jwt ?? '',
          organizationCode: credential?.organizationCode ?? '',
          /**
           * ⚠️ **显式传 `product`**（2026-11-01 二审补）：原先靠 `magicrewExpiry` 的
           * `?? MAGICREW` 缺省，而国际站条目显式传 `MAGICREW_INTL` ⇒ 两条腿**不对称**。
           * 行为上正确（默认值恰好就是本国站），但形态上极易被后人误读成
           * 「本国站也漏传了 product，照抄一份到新站就会静默打错 host」
           * —— 而那个症状正是国际站那条注释里写的「折算恒 UNUSABLE ⇒ 候选静默消失」。
           * ⇒ 两站都显式传，判据同形。
           */
          product: MAGICREW,
          ...context?.cachedBalance === undefined
            ? {}
            : {
                cachedBalance: () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
              },
        })
      },
    },
    /**
     * **MagiCrew 国际版**（`magicrewintl`，2026-11-01）。
     *
     * ⚠️ 与 `magicrew` 逐字同构，但**必须显式传 `product: MAGICREW_INTL`** ——
     *    漏传会用国内基址（`i-magic-service.letsmagic.cn`）去查国际账号余额，
     *    恒失败 ⇒ 折算恒 `UNUSABLE` ⇒ 国际站候选从轮换表里**静默消失**
     *    （与 `autoclawintl` 那条注释记录的同类缺陷完全同型）。
     */
    magicrewintl: {
      credentialExpiry: async (c, context) => {
        const credential = parseMagicrewCredential(c)
        return await magicrewExpiry({
          jwt: credential?.jwt ?? '',
          organizationCode: credential?.organizationCode ?? '',
          product: MAGICREW_INTL,
          ...context?.cachedBalance === undefined
            ? {}
            : {
                cachedBalance: () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
              },
        })
      },
    },
    /**
     * ⚠️ **Qoder**（国际版 / 中国版，2026-10-20）：与 **buddy 系同形**
     *    （`CreditPackage` 都带 `deductionEndTime`）⇒ 原语直接复用
     *    `sharedPackageExpiry`；两站共用同一个原语（只换 product），
     *    单独抽 `qoderFamilyExpiry` 是为了让「它们只差一个 product」一眼可见。
     *
     *    ⚠️⚠️ **与上面所有条目的关键差别：本家是「接入了，但上游不给逐包时刻」。**
     *    实测（2026-10-20，两个真实 qodercn 账号）：`userQuota` 的顶层
     *    `expiresAt = 253402214400000` 是**永久哨兵**（`9999-12-31T00:00:00Z`），
     *    `addOnQuota` **只给聚合标量、零日期字段**，
     *    `dedicatedResourcePackages`（唯一带真实逐包到期的字段）本机为 `undefined`
     *    ⇒ `qoder-credits.ts` 对哨兵**不写** `deductionEndTime`
     *    ⇒ 折算得 `NEVER`（长期）= 三档里「永久（未知到期）」那一桶。
     *    ⚠️ **无 `dedicatedResourcePackages` 时临期桶恒为 0**，这是如实限制
     *    （绝不为了凑出一档而编造日期）。
     *    ⚠️ 国际版 `openapi.qoder.sh` 本机**网络不可达** ⇒ 取不到时
     *    `fetchQoderCreditBalance` 返回 `null` ⇒ `UNUSABLE`（剔除），保守。
     *
     *    ⚠️ 三处必须同改（本表 + `WIRED_EXPIRY_PROVIDERS` + 折算原语）——
     *    这是该陷阱的第 **7** 次复发（cline → accio → officeace → autoclaw
     *    → astudio → minimax → qoder），漏任何一处的症状都是**静默**的
     *    （用户在聚合轮换列表里看不到该渠道，零报错零日志）。
     *    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae / modelscope / astudio /
     *    minimax 同款 —— 聚合每轮折算会对同一账号反复提问，没有共享读数就会
     *    白发大量重复请求。
     *    ⚠️ **两站各占一项**：`credentialExpiry` 的分派按 provider id，漏
     *    `qodercn` 会让中国版单独恒 `UNUSABLE`（与 minimaxintl 同因）。
     */
    qoder: qoderFamilyExpiry(QODER, deps),
    qodercn: qoderFamilyExpiry(QODER_CN, deps),
    // ⚠️ **MiniMax Code**（中国版 / 国际版，2026-10-20）：两家共用同一个原语
    //    （只换 product），与 buddy / workbuddy 同款 —— 单独抽 `minimaxFamilyExpiry`
    //    是为了让「它们只差一个 product」一眼可见（同族各写一份判据 = 分叉的开始）。
    //    ⚠️ 三处必须同改（本表 + `WIRED_EXPIRY_PROVIDERS` + 折算原语）——
    //    这是该陷阱的第 **6** 次复发（cline → accio → officeace → autoclaw
    //    → astudio → minimax），漏任何一处的症状都是**静默**的
    //    （用户在聚合轮换列表里看不到该渠道，零报错零日志）。
    //    ⚠️ **必须走 `cachedBalance`**：与 buddy / trae / modelscope / astudio 同款
    //    —— 聚合每轮折算会对同一账号反复提问，没有共享读数就白发大量重复请求。
    minimax: minimaxFamilyExpiry(MINIMAX, deps),
    minimaxintl: minimaxFamilyExpiry(MINIMAX_INTL, deps),
  }
}

/**
 * Qoder 系的折算（**两个产品共用同一个原语**，只换 product 配置）。
 *
 * ⚠️ 与 {@link buddyFamilyExpiry} 逐字同形：本家没有 XFF / 地理分流需求
 *    （两站各自有独立域名且互不 307），故**不**像 minimax 那样多一个透传参数。
 *
 * ⚠️ `context.cachedBalance` **在每次折算时现读**（不是建表时固化）：
 *    与 `createProviderCredits` 的同名字段同一纪律。
 */
function qoderFamilyExpiry(product: QoderProduct, deps: ProviderExpiryDeps): ProviderExpiry {
  return {
    credentialExpiry: (c, context) => qoderExpiry(
      c as QoderCredential,
      product,
      context?.cachedBalance === undefined
        ? undefined
        : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      // ⚠️ **按 `accountId` 现取**（与 `minimaxIntl` 同款）：账号可能随时改代理。
      //    `context.accountId` 缺失时传空串 —— 与解析器的契约一致
      //    （空 id 会去查「登录预置」那条，查不到则直连）。
      deps.qoderFetchFor === undefined
        ? undefined
        : deps.qoderFetchFor(context?.accountId ?? ''),
    ),
  }
}

/**
 * MiniMax 系的折算（**两个产品共用同一个原语**，只换 product 配置）。
 *
 * ⚠️ 与 {@link buddyFamilyExpiry} 的关键差别：本家还要透传 `deps.minimaxXff`。
 *    国际站按出口 IP 做地理分流（`agent.minimax.io` 307 到中国站，而中国站
 *    不认国际站 token ⇒ `401 invalid access token`，与「凭据真失效」逐字同形，
 *    issue IKMEVG）⇒ 不带 xff 时国际站账号的折算**恒失败**，该渠道在聚合轮换里
 *    被静默剔除（面板却还能正常刷新 —— 两条链路各走各的 xff 取值）。
 *
 * ⚠️ `deps.minimaxXff` **在每次折算时现读**（不是建表时固化成一个字符串）：
 *    用户随时可能在设置里改 XFF，固化会让改动不生效（与 `createProviderCredits`
 *    的同名字段同一纪律）。
 */
function minimaxFamilyExpiry(product: MinimaxProduct, deps: ProviderExpiryDeps): ProviderExpiry {
  return {
    credentialExpiry: (c, context) => minimaxExpiry(
      c as MinimaxCredential,
      product,
      context?.cachedBalance === undefined
        ? undefined
        : () => context.cachedBalance!(context.accountId) as Promise<CreditBalance | null | undefined>,
      deps.minimaxXff?.(),
      /**
       * ⚠️ **按账号取出口**（PR !145 审计 P0 修法）。
       *
       * 判据：只有国际站需要（中国站直连才是最优 —— 给它挂代理反而让流量绕境外
       * 一圈，且可能被引到国际站）；且必须拿到账号 id 才取，否则退回全局 `fetch`
       *（不知道是谁就不该猜一个账号去用它的出口）。
       *
       * ⚠️ 这与 `createProviderCredits` 的 `minimaxIntlFetcher` 是**同一份判据的
       * 两处消费**（两条链路各自有 deps 类型，无法共享函数体）——
       * 一致性由 `expiry-runtime-parity.spec.ts` 的真跑 `apply()` 锁住。
       */
      product.id === 'minimaxintl'
        && deps.minimaxIntlFetchFor !== undefined
        && context?.accountId !== undefined
        && context.accountId !== ''
        ? deps.minimaxIntlFetchFor(context.accountId)
        : undefined,
    ),
  }
}
