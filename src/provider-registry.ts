/**
 * 各 provider 的**元数据与能力声明** —— 本插件里「有哪些 provider、各自有什么能力」
 * 的**唯一真相源**。
 *
 * ## ⚠️ 本文件必须零 import
 *
 * 它同时被两侧消费：
 * - **Node 宿主**（`tsc` → `lib/`）：`src/jet-hub-rpc.ts` 等读它；
 * - **浏览器客户端**（`esbuild` → `lib/client/jet-hub.js`）：
 *   `plugin-src/client/*.js` 经 `import { … } from '../../src/provider-registry.js'`
 *   直接复用它。
 *
 * 后者**已实测可行**（设计文档 §1.4）：esbuild 会把 `./x.js` 解析到同名 `x.ts`。
 * 但浏览器里没有 `node:fs` / `node:path` 等，故本文件**不得** import 任何 `node:*`。
 *
 * ## 为什么要把元数据集中到这里
 *
 * 重构前，加一个 provider 要手改 **13 处**，其中两处会**静默失效**：
 *
 * 1. **四处单测的正则断言**用 `/\{\s*id:\s*'([a-z]+)',\s*label:/g` 从客户端
 *    `PROVIDERS` 派生 id —— `[a-z]+` **不匹配连字符**。若新 provider id 写成
 *    `kuku-ai`，守卫会**静默漏掉一个 id 而照样全绿**（本仓库原注释：
 *    「保险失效比变红更糟」）。
 * 2. **`registerJetHubRpc` 的位置参数**（当时 16 个）—— 注释自陈
 *    「历史上已因少传/插队错位复发 **6 次**」。
 *
 * 本文件消除第 1 处：四处断言改为读 `PROVIDER_REGISTRY`，不再解析源码文本。
 *
 * ## 与各 product 的 `displayName` 的关系
 *
 * 本文件的 `displayName` 当前与对应 product 的 `displayName`（如
 * `src/product.ts` 的 `CodeBuddy (腾讯)`）**取值相同**，但
 * ⚠️ **没有任何断言守着这条一致性** —— 2026-10-08 之前有，那些断言在
 * 客户端 `PROVIDERS` 改为派生后**改锁 `label`** 了（见
 * `raccoon-client-panel.spec.ts` / `zcode-wiring.spec.ts`）。
 *
 * ⚠️ 且它**当前零生产消费者**：真正被读的是各 product 自己的 `displayName`。
 * ⇒ 结构与去留由 Task 11 的收尾审计定夺（选项：删掉本字段只留 `label`，
 * 或保留并补一条「与 product 逐字一致」的断言把它变成可测量的）。
 * **在那之前，不要把本字段当作契约来依赖。**
 */

/** 积分能力（原客户端 `CREDITS_CAPABILITIES` 的每一项）。 */
export interface CreditsCapability {
  /** 能否查积分余额（决定是否渲染「刷新积分」与徽章读数）。 */
  readonly balance: boolean
  /**
   * 能否每日签到领取（决定是否渲染「一键领取积分」）。
   *
   * ⚠️ **省略 = false**，且「省略」是有语义的、不是偷懒 —— 它表示
   * 「该渠道**没有可调用的签到端点**」。目前只有 `raccoon` 这样登记：
   * 实测「每日 300 积分」是**服务端按日自动发放**的（账单
   * `biz_type: 'daily_grant'`），根本没有签到接口可调；
   * 若强行写成 `dailyCheckin: false` 也能跑，但那样就**看不出作者是否想过**
   *（「忘了登记」与「确认没有端点」会长得一模一样）。故这里**刻意允许省略**，
   * 让 raccoon 那条的 `credits` 保持「缺失即缺失」。
   *
   * ⚠️ 判据一律是 `=== true`（见客户端 `supportsDailyCheckin`），
   * 故 `undefined` 与 `false` 行为**完全一致**，省略不会引入任何功能差异。
   */
  readonly dailyCheckin?: boolean
  /** 是否有**一次性**新手/登录奖励（Loomy 新手任务 / raccoon 登录奖励）。 */
  readonly onboardingTasks?: boolean
  /** 是否有**订阅额度窗口**（目前只有 Cline 有「5 小时 / 周 / 月」这一层）。 */
  readonly subscriptionQuota?: boolean
}

/**
 * 一个 provider 的元数据与能力声明。
 *
 * ⚠️ **可选项的默认语义不统一，这是刻意的**（照搬既有各表的约定，见各字段注释）：
 * - `credits.balance` **必填**（无默认，强制想清楚）；
 * - `credits.dailyCheckin` **可省略，省略 = false** —— 但省略承载语义
 *   「该渠道没有可调用的签到端点」（目前只有 raccoon 如此，见该字段注释）；
 * - `rateLimit` 省略 = **true**（限流按钮是既有 UI，默认关闭会让新 provider
 *   凭空少按钮 —— 可见的功能回退）；
 * - `accountTest` / `permanentLock` / `creditPackages` / `autoCheckinExcluded`
 *   省略 = **false**（默认关闭，避免发必然失败的请求 / 渲染无效按钮）。
 */
export interface ProviderDescriptor {
  /** provider id。⚠️ **必须纯小写字母**（`^[a-z]+$`，见文件头第 1 条）。 */
  readonly id: string
  /** Jet Hub 左栏（rail）上的显示名。⚠️ 长度受 `.dim-jh-rail` 宽度算式约束。 */
  readonly label: string
  /**
   * 产品显示名。⚠️ 当前**零生产消费者、零断言**（见文件头的如实说明）——
   * 真正被读的是各 product 自己的 `displayName`。**不要**把它当契约依赖。
   */
  readonly displayName: string
  /** 图标容器的 CSS 类名（`jet-hub-styles.js` 里按它上样式）。 */
  readonly logoClass: string
  // ⚠️ **刻意没有 `icon` 字段**：图标是几百到几万字符的 base64 / SVG data URI
  //    （合计约 44 KB，条数随 provider 增删而变、不在此写死），而**宿主侧从不
  //    使用它们**。放进 registry 会让
  //    `lib/index.js` 白白背上这份体积。图标改由客户端 `PROVIDER_ICONS` 持有
  //    （见 `plugin-src/client/provider-icons.js`），并由一条单测锁「两边 id 集合相等」——
  //    「新增 provider 忘记加图标」仍会**变红**，只是大字符串不进宿主产物。

  /** 积分能力。 */
  readonly credits: CreditsCapability

  /**
   * 该渠道是否具备「模型限流」机制（服务端会因限流拒请求）。
   *
   * ⚠️ **省略 = true**（与 `credits` 的默认关闭**相反**）。理由：限流按钮
   *（重测 / 重置）是**既有 UI**，若默认关闭，将来新增 provider 时忘记登记
   * 会让老用户**凭空失去**按钮 —— 那是可见的功能回退。
   */
  readonly rateLimit?: boolean

  /** 是否支持账号卡片上的「测试」按钮（无条件真发一次请求探活）。省略 = false。 */
  readonly accountTest?: boolean

  /**
   * 余额是否**真的由多个资源包构成且有到期信息**（决定账号名 hover 是否列包）。
   *
   * ⚠️ 这不是「避免冗余」，而是**防止显示错误信息**：loomy 的 `packages` 是我们
   * 自己合成的两个条目、**没有** `deductionEndTime`，若不加门控，卡片上会出现
   *「每日赠送 4992 / 4992 永久」—— 而那笔恰恰**当天就作废**，说反了。
   */
  readonly creditPackages?: boolean

  /** 是否支持「锁定永久积分」。省略 = false。 */
  readonly permanentLock?: boolean

  /**
   * 是否按**到期时间分桶**（决定「锁定永久积分」是否回传 `windowDays`）。
   *
   * ⚠️ 判据是「是否走 `splitBuddyCreditsByExpiry`」，**不是「是不是 buddy」**：
   * TRAE 与 LobsterAI 走同一套、同样受 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 影响；
   * 而 loomy 是**服务端直接给两个命名池**、没有窗口概念，故不在内。
   */
  readonly usesExpiryWindow?: boolean

  /**
   * 每日自动签到是否**排除**该渠道。
   *
   * ⚠️ 它记的不是「谁有签到接口」，而是「谁有签到**代价**」—— 目前只有 zcode：
   * 每次领取都要现场产阿里云 captcha（web 版下会拉起 headful Chromium，
   * 且阿里云按**设备**限流 150 次/小时）。用户仍可**手动**签到。
   */
  readonly autoCheckinExcluded?: boolean

  /** 老契约（DSH ≤0.1.6）的 settings namespace；省略则不注册。 */
  readonly settingsNamespace?: string

  /**
   * 是否是一个普通「渠道」（有账号、有凭据、有积分）。
   *
   * `false` 只有 `aggregate`（聚合层不持有账号与积分，它复用各渠道的）。
   * ⚠️ 用布尔而不是「有没有 `accountExtras`」来推断：那是**巧合**而非语义。
   */
  readonly channel: boolean
}

/**
 * ⚠️ 图标字面量**不写在这里**，而在 `plugin-src/client/provider-icons.js`
 *（它们是几百到几万字符的 base64 / SVG data URI）。原设计想让 registry 持有图标，
 * 但那会让**宿主侧**的 `lib/index.js` 白白背上约 40 KB 的字面量 ——
 * 而宿主从不使用图标。
 *
 * ⇒ 折中：registry 只持有 `logoClass`（两侧都要用），图标由客户端自己的
 * `PROVIDER_ICONS` 表按 id 提供，并由一条单测锁「两边 id 集合相等」。
 * 这样「新增 provider 忘记加图标」仍会**变红**，但不会把大字符串搬进宿主产物。
 */
export const PROVIDER_REGISTRY: readonly ProviderDescriptor[] = Object.freeze([
  {
    id: 'codearts',
    label: 'CodeArts (华为云)',
    displayName: 'CodeArts (华为云)',
    logoClass: 'codearts',
    credits: { balance: true, dailyCheckin: true },
    /**
     * 三档分档覆盖**两个来源**（2026-10-20）：
     *
     * - **基础积分包**（`usageBasicPackageCredit`）随套餐周期到期，响应顶层
     *   给了 `end_date`（纯日期，如 `2026-10-27`）⇒ 有确切时刻，已写进
     *   `packages[].deductionEndTime`，可正常分档。
     * - **赠送积分包**（签到/活动，逐笔「发放日 +30 天」）与**按需包**没有
     *   逐包到期字段，但上游在该分类 metric 上给了
     *   `package_credit_expiring_amount`（「其中 N 分即将到期」的标量）
     *   ⇒ 已解析到 `packages[].expiringRemaining`，**拆开**进两个桶：
     *   临期 += `expiringRemaining`，永久 += 余下部分。
     *
     * 于是三档合计恒等于 `credits.total`，不再出现「永久 25000」旁边
     * 又写「另有 2000 即将到期」这种对不上的数字（用户 2026-10-20 报障）。
     *
     * ⚠️ 拆出来的那部分**没有倒计时** —— 上游不给逐笔日期，绝不编造。
     * ⚠️ 赠送包整体仍是**会到期**的性质，只是其中一段时间窗口内的部分被
     *   标成「即将到期」；余下部分归入永久桶是**保守方向**（宁可少用）。
     */
    usesExpiryWindow: true,
    /**
     * ⚠️ 不开 `permanentLock`：CodeArts 的积分**没有「永久」这一档**。
     *
     * 依据（官方计费文档 + 实测）：
     * - 基础积分包随套餐周期作废（体验版虽自动免费续期，但基础包额度按周期重置）；
     * - 赠送积分包逐笔「发放日 +30 天」；
     * - 按需包按消费实时结算。
     *
     * 三类的共同点是**都会到期**，没有「永不作废」的池。开永久锁会让用户
     * 误以为「锁住就不会作废」，而实际只是把这批号从选号里摘出去 ——
     * 语义错位，故不登记。
     */
    /**
     * ⚠️ **必须与 `usesExpiryWindow` 同时登记**（2026-10-20 合并审计发现，
     * 与 minimax 两站同因）：`provider-registry.spec.ts` 有一条从**能力事实
     * 派生**的守卫「`usesExpiryWindow` 的家必须有 `creditPackages`（同一份数据）」
     * —— 两者读的是同一批 `packages[]`。只开前者会让账号卡片**不展示逐包列表**，
     * 用户看得到「永久 / 长期 / 临期」三档合计，却看不到是**哪几笔**构成的。
     *
     * ⚠️ 本家补上是有实据的：`codearts-credits.ts` 已把上游的
     * `package_credit_expiring_amount` 聚合标量**拆到逐包**
     * （`packages[].expiringRemaining`），基础包还带 `deductionEndTime`
     * （取自套餐周期 `end_date`）—— 「N/M 个资源包有效」这句因此有真实内容。
     */
    creditPackages: true,
    settingsNamespace: 'llm-codearts',
    channel: true,
  },
  {
    id: 'buddy',
    label: 'CodeBuddy (腾讯)',
    displayName: 'CodeBuddy (腾讯)',
    logoClass: 'buddy',
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: 'llm-buddy',
    channel: true,
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy (国际版)',
    displayName: 'WorkBuddy (国际版)',
    logoClass: 'workbuddy',
    // ⚠️ 国际版后端**没有**签到接口（内核里只有 `get-dosage-notify` 用量通知）。
    credits: { balance: true, dailyCheckin: false },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: 'llm-workbuddy',
    channel: true,
  },
  {
    id: 'lobsterai',
    label: 'LobsterAI (有道)',
    displayName: 'LobsterAI (有道)',
    logoClass: 'lobsterai',
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: 'llm-lobsterai',
    channel: true,
  },
  {
    id: 'qoder',
    label: 'Qoder',
    displayName: 'Qoder',
    logoClass: 'qoder',
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    /**
     * ⚠️ **2026-10-20 补登记：三档分档（永久 / 长期 / 临期）与永久锁此前完全没生效。**
     *
     * 这两项此前缺失导致**两个静默故障**（与 minimax / astudio 那两次逐字同因）：
     * - 缺 `usesExpiryWindow` ⇒ `jet-hub-rpc.ts` 的判据
     *   `descriptorOf(req.provider)?.usesExpiryWindow === true` 为 false ⇒
     *   响应里没有 `windowDays` ⇒ 客户端 `splitCreditsByExpiry` 收 `undefined`
     *   ⇒ 面板上「永久 X · 长期 Y · 临期 Z」那整行**不渲染**；
     * - 缺 `permanentLock` ⇒ 客户端 `supportsPermanentLock()` 为 false ⇒
     *   「锁定永久积分」开关**整个不渲染**（不是灰掉，是不存在）。
     *
     * ⚠️⚠️ **但这两项对本家是「能力开关」，不是数据保证 —— 逐包到期拿不到。**
     *
     * 实测（2026-10-20，两个真实 qodercn 账号）
     * `GET /sash/api/v2/me/usage` 只下发三个额度块：
     * - `userQuota`（套餐额度，实测 `{total:0,used:0,remaining:0}`）；
     * - `addOnQuota`（用户截图里的「个人资源包 1,900」）—— **只给聚合标量**
     *   （`total` / `used` / `remaining`）加一个 `detailUrl` 网页链接，
     *   **没有任何日期字段**；
     * - `dedicatedResourcePackages` —— **唯一**带真实逐包到期（`expiresAt`
     *   字符串）的那一项，而本机账号实测为 `undefined`。
     *
     * ⇒ 当前账号形态下 `packages[]` 里**没有任何真实的逐包到期时刻**，
     *   `qoder-credits.ts` 的 `toPackage()` 因此**不写** `deductionEndTime`
     *   ⇒ `splitBuddyCreditsByExpiry` 只得到一个「永久（未知到期）」桶 ⇒
     *   **临期桶恒为 0**。这**不是缺陷**，是「上游不下发 ⇒ 我们不编造」的如实结果
     *   （本仓库红线）。只有上游真的给了 `dedicatedResourcePackages` 的账号
     *   才会出现临期档。
     *
     * ⚠️ 顺带澄清一个**反例**：顶层 `qoderUsage.expiresAt` 实测
     *   `253402214400000`（= `9999-12-31T00:00:00.000Z`）**不是**到期时刻 ——
     *   它是 Qoder 对 `userQuota`（套餐额度）下发的**永久哨兵**：官方客户端
     *   asar 的用量面板里只有 `userQuota.expiresAt` 走 `renewson`
     *   （文案「将于 {{date}} 刷新」，语义是**订阅刷新日**），而
     *   `addOnQuota` 那一格**只渲染 used/total/remaining、不给任何日期**。
     *   把它当真实到期写进 `deductionEndTime` 会把整个套餐额度伪造成
     *   「9999 年到期」的临期档，故 `qoder-credits.ts` 用
     *   `QODER_PERMANENT_EXPIRY_MS` 显式识别并**不写**。
     *   （活动的 `validity = {mode:'RELATIVE_DAYS', days:30}` 只描述
     *   「领取后 30 天有效」的**语义**，同样不是任何一笔已知时刻。）
     *
     * ⚠️ **`permanentLock` 因此锁的正是「未知到期」那一桶**：
     *   `credential-resolver.ts` 的 `allowPermanent` 拦掉永久桶的可消耗性。
     *   对「上游只给聚合标量」的账号，锁定后确实把该桶保了下来 ——
     *   语义如实，**不是假开关**（Qoder 的 `dedicatedResourcePackages` 一旦下发，
     *   其真实临期包与永久桶的分档同样成立）。
     *
     * ⚠️ 三处必须同改（本文件 + `provider-expiry.ts` 的 `createProviderExpiry()`
     * + `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`），由
     * `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁一致 ——
     * 这是该陷阱的**第 7 次复发**（cline → accio → officeace → autoclaw
     * → astudio → minimax → qoder），漏任何一处的症状都是**静默**的。
     */
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: 'llm-qoder',
    channel: true,
  },
  {
    id: 'qodercn',
    label: 'Qoder (中国版)',
    displayName: 'Qoder (中国版)',
    logoClass: 'qodercn',
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    // ⚠️ 与上面的国际版**同因同日**补登记（2026-10-20）：两站共用全部
    //    `src/qoder*.ts` 实现（适配器 / 认证 / 积分），余额响应形状逐字段同形，
    //    差异只在 `src/qoder-product.ts` 的 `QODER_CN` 常量（域名 / client_id /
    //    模型表）。⇒ 分档与永久锁的理由、以及「逐包到期拿不到」那条限制，
    //    与国际版**逐字相同**（见上一条的长注释，不重复）。
    //    ⚠️ 唯一需要单独记一笔的差异：**本次真机取证用的正是中国版账号**
    //    （`openapi.qoder.com.cn`），而国际版 `openapi.qoder.sh` 在本机
    //    **网络不可达**（`fetch failed` ~10.7s）⇒ 国际版的实际响应形状
    //    **未在本次实测覆盖**。实现必须对「取不到」保守：
    //    `fetchQoderCreditBalance` 网络失败/非 2xx/形状非法一律返回 `null`
    //    ⇒ 聚合折算得 `UNUSABLE`（剔除该候选），**绝不**退化成「有余额」。
    //    ⚠️ 两家必须各占一项：`WIRED_EXPIRY_PROVIDERS` 是按 **provider id**
    //    的清单，漏掉 `qodercn` 会让中国版在聚合候选层被静默剔掉
    //    （与 minimax / minimaxintl 同因）。
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: 'llm-qodercn',
    channel: true,
  },
  {
    id: 'trae',
    label: 'TRAE (字节)',
    displayName: 'TRAE (字节)',
    logoClass: 'trae',
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: 'llm-trae',
    channel: true,
  },
  {
    id: 'cline',
    label: 'Cline',
    displayName: 'Cline',
    logoClass: 'cline',
    // ⚠️ 无签到：对整个 sidecar 二进制做字符串扫描，`checkin` / `campaign` 等
    //    均无 Cline 业务端点命中。
    // `subscriptionQuota` 是**本表唯一**具备该项的渠道（5 小时 / 周 / 月窗口）。
    credits: { balance: true, dailyCheckin: false, subscriptionQuota: true },
    settingsNamespace: 'llm-cline',
    channel: true,
  },
  {
    id: 'loomy',
    label: 'Loomy (讯飞)',
    displayName: 'Loomy (讯飞)',
    logoClass: 'loomy',
    credits: { balance: true, dailyCheckin: true, onboardingTasks: true },
    // ⚠️ Loomy **不返回限流错误**：今日赠送额度用完后，服务端继续扣永久积分且
    //    照常返回（静默降级）⇒「重测 / 重置」对它毫无意义（重测还会白烧积分）。
    rateLimit: false,
    permanentLock: true,
    // ⚠️ 不在 usesExpiryWindow：它**没有窗口概念**，服务端直接给两个命名池。
    settingsNamespace: 'llm-loomy',
    channel: true,
  },
  {
    id: 'raccoon',
    label: 'Raccoon (商汤)',
    displayName: 'Raccoon (商汤)',
    logoClass: 'raccoon',
    // ⚠️ 不登记 `dailyCheckin`，且**这不是遗漏**：实测「每日 300 积分」是服务端
    //    按日自动发放的（账单 `biz_type: 'daily_grant'`），**没有可调用的签到端点**。
    //    登记它会让用户每次点击都必然失败。
    //    `onboardingTasks` 是 3000 分的**幂等一次性**桌面端登录奖励。
    credits: { balance: true, onboardingTasks: true },
    settingsNamespace: 'llm-raccoon',
    channel: true,
  },
  {
    id: 'minimax',
    // ⚠️ 2026-10-15 加国际版（`minimaxintl`）后必须带括注，否则左栏会出现
    //    「MiniMax Code」+「MiniMax Code (国际版)」两条，用户看不出前者是国内站
    //    （与 `Qoder (中国版)` / `WorkBuddy (国际版)` 的既有命名风格一致）。
    label: 'MiniMax Code (中国版)',
    displayName: 'MiniMax Code (中国版)',
    logoClass: 'minimax',
    credits: { balance: true, dailyCheckin: true },
    /**
     * ⚠️ **2026-10-20 补登记**（用户报障：「MiniMax Code 积分也有到期时间，
     * 也应当有相同功能」，并附 AStudio 面板截图作参照）。
     *
     * 这两项此前**空缺导致两个静默故障**：
     * - 缺 `usesExpiryWindow` ⇒ `jet-hub-rpc.ts` 的 `usesWindow` 为 false ⇒
     *   响应里没有 `windowDays` ⇒ 客户端 `splitCreditsByExpiry` 收 `null` ⇒
     *   面板上「永久 X · 长期 Y · 临期 Z」那整行**不渲染**。
     * - 缺 `permanentLock` ⇒ 客户端 `supportsPermanentLock()` 为 false ⇒
     *   「锁定永久积分」按钮**整个不渲染**（不是灰掉，是不存在）。
     *
     * ⚠️ 补登记的前提是**上游确实下发到期时间**：`/minimax-cloud/api/v1/credit/details`
     * 的每条 `details[]` 都带 `expire_at_ms`（毫秒时间戳，无需换算）。
     * 此前 `fetchMinimaxCreditBalance` 把 `packages` 硬编码成 `[]`，聚合侧据此
     * 把本家归为「查不到到期时间」—— **那是「我们没解析」，不是「上游不下发」**。
     * 该函数已于同日补齐解析。
     *
     * ⚠️ 三处必须同改（本文件 + `provider-expiry.ts` + `aggregate-expiry.ts` 的
     * `WIRED_EXPIRY_PROVIDERS`），由 `expiry-runtime-parity.spec.ts` 真跑
     * `apply()` 锁一致。
     */
    usesExpiryWindow: true,
    permanentLock: true,
    /**
     * ⚠️ **必须与 `usesExpiryWindow` 同时登记**（2026-10-20 合并审计发现）。
     *
     * `provider-registry.spec.ts` 有一条从**能力事实派生**的守卫：
     * 「`usesExpiryWindow` 的家必须有 `creditPackages`（同一份数据）」——
     * 两者读的是同一批 `packages[]`，只开前者会让账号卡片**不展示逐包列表**，
     * 用户看得到「永久 / 长期 / 临期」三档合计，却看不到是**哪几笔**构成的。
     *
     * ⚠️ 本次补上是有实据的：`minimax-credits.ts` 已把 `packages[]` 从硬编码
     * `[]` 改为**逐条 `details[]` 各成一包**（带 `deductionEndTime`），
     * 卡片上「2/2 个资源包有效」这句因此有了真实内容。
     */
    creditPackages: true,
    settingsNamespace: 'llm-minimax',
    channel: true,
  },
  {
    /**
     * MiniMax Code **国际版**（`minimaxintl`）。
     *
     * ⚠️ 与上面的国内站**共用全部** `src/minimax*.ts` 实现（适配器 / 认证服务 /
     *    OAuth / 积分 / 消息序列化），差异只在 `src/minimax-product.ts` 的
     *    `MINIMAX_INTL` 常量里（主机 / region / ref 前缀）。
     *
     * ⚠️ **`rateLimit` 刻意不写 false**：两站共用同一个 `MinimaxAdapter`，而它
     *    自 issue IKJW32 起会写 `modelRateLimits`（额度 24h / 限流 1h）⇒ 缺省
     *    `true` 是**正确**的，且必须同时进 `probeById` 与
     *    `WRITES_RATE_LIMIT_PROVIDERS`（否则标记写进去却永远清不掉）。
     *
     * ⚠️ **验证状态如实标注**（2026-10-16 合并审计修正 —— 原文写「三项未真机验证」
     *    并指向一个**并不存在**的「未实测清单」，与 `src/minimax-product.ts`
     *    文件头的「✅ 已真机验证」互相否定）：推理路径与签到/积分端点形状
     *    **已真机验证通过**（2026-10-15，真实国际站账号；见该文件头的实测表与
     *    `tests/e2e/minimaxintl-probe.e2e.spec.ts`）。**只有兜底模型表**未按国际站
     *    远端采集（与国内站共用同一份，仅远端失败时兜底）。
     */
    id: 'minimaxintl',
    label: 'MiniMax Code (国际版)',
    displayName: 'MiniMax Code (国际版)',
    logoClass: 'minimaxintl',
    credits: { balance: true, dailyCheckin: true },
    // ⚠️ 与中国版**同因同日**补登记（2026-10-20）：两站共用同一个
    //    `fetchMinimaxCreditBalanceDetailed`，后端解析补齐后两边都该亮分档与锁定。
    //    ⚠️ 国际站另有**地理分流**风险：`agent.minimax.io` 会 307 到中国站，
    //    而中国站不认国际站 token ⇒ 余额查询恒失败。故折算原语 `minimaxExpiry`
    //    必须透传 `xff`（见 `aggregate-expiry.ts` 该函数的注释与
    //    `src/index.ts` 的 `minimaxXff: () => pool.minimaxXff()`）——
    //    漏传的后果正是「面板能刷新、聚合候选却恒折算失败」。
    usesExpiryWindow: true,
    permanentLock: true,
    // ⚠️ 同国内站：`usesExpiryWindow` 必须与 `creditPackages` 同时登记
    //    （`provider-registry.spec.ts` 有从能力事实派生的守卫，只开前者会让
    //    账号卡片不展示逐包列表）。两站共用同一个 `MinimaxAdapter` 与同一份
    //    `fetchMinimaxCreditBalance`，`packages[]` 已由逐条 `details[]` 产出。
    creditPackages: true,
    settingsNamespace: 'llm-minimaxintl',
    channel: true,
  },
  {
    id: 'zcode',
    label: 'ZCode (智谱)',
    displayName: 'ZCode (智谱)',
    logoClass: 'zcode',
    // ⚠️ 量纲是 **token 而非积分** —— 能力矩阵回答的是「有没有这项能力」，
    //    不是「量纲是否一致」；量纲差异在面板与 RPC 层如实标注。
    credits: { balance: true, dailyCheckin: true },
    autoCheckinExcluded: true,
    settingsNamespace: 'llm-zcode',
    channel: true,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    displayName: 'OpenCode',
    logoClass: 'opencode',
    // ⚠️ `balance: true` 但语义**不是余额**而是「**通道可用性**」：Zen 没有公开的
    //    余额 API（15 个候选路径全 404），故徽标展示我们真正测得到的东西
    //    （每个通道当前是否可用、是否处于限额冷却），数据全来自本地、零网络请求。
    //    早期登记为 false 曾把**整个徽标挡死**（组件第一件事就是判这个布尔）。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 无 settingsNamespace：它不在老契约的 namespace 清单里。
    channel: true,
  },
  {
    id: 'gemini',
    label: 'Gemini Code Assist',
    displayName: 'Gemini Code Assist',
    logoClass: 'gemini',
    // ⚠️ 不登记 dailyCheckin：Cloud Code 免费线是**纯配额制**，
    //    没有可调用的签到/领取端点（签到是服务端按日自动发放的）。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 与 loomy 同值但**理由不同**：它确实会回 429、适配器也确实写
    //    `modelRateLimits`，但限流是**服务端配额窗口制** —— 本地标记清掉、
    //    重测通过，配额本身一点没恢复，下一次请求立刻又是 429。
    //    于是这组按钮只剩「白烧配额」与「把受限账号放回池里再撞一次」两种副作用。
    rateLimit: false,
    accountTest: true,
    settingsNamespace: 'llm-gemini',
    channel: true,
  },
  {
    id: 'officeace',
    label: 'OfficeAce',
    displayName: 'OfficeAce',
    logoClass: 'officeace',
    // ⚠️ **有**积分余额：数据来自云侧 `GET /v1/subscription`（V11 签名直读，
    //    与果办界面右上角同源同口径，2026-10-12 扣减实锤），**不依赖 OfficeAce 客户端**。
    //
    // ⚠️ `dailyCheckin: false` 但**该渠道确实有签到** —— 这里是**故意**不登记 true：
    //    签到走的是云侧 `POST /v1/subscription/bonus/claim`，且果办客户端的实现是
    //    「订阅页一挂载就自动领、**UI 上没有按钮**」（源码 `SubscriptionStateProvider`
    //    用「年+月+日+时」去重，每小时最多一次）。
    //    故本渠道的签到在**拉余额时自动完成**（见 `officeace-auth.ts` 的
    //    `maybeClaimBonus`）—— 登记成 true 会让面板渲染一个手动签到按钮，
    //    而它背后的 `credits.claim` RPC 对本渠道没有意义（真正的领取是自动的）。
    //    ⚠️ 语义：该字段表达「是否存在**手动**签到入口」，不是「有没有签到收益」。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 余额响应里每个积分包都带到期时间（订阅套餐包无固定到期 = 永久桶，
    //    签到 / 活动包有明确到期）⇒ 可按 `deductionEndTime` 分「永久 / 长期 / 临期」三档。
    creditPackages: true,
    // ⚠️⚠️ **2026-10-15 之前这是一个哑锁**（Gitee issue IKLTHB 第 ① 条）：
    //    登记成 true 让面板渲染出开关、并逐字承诺「这类积分用尽后将没有可用账号」，
    //    而全仓**只有** `credential-resolver.ts` 的 buddy / loomy 两个分支读过
    //    `permanentLocked()` ⇒ 开关写进 `permanent-locks.json` 后行为与关闭**完全一致**
    //    （用户照旧烧永久套餐包）。现已由 `officeace-lock.ts` 补齐执行路径
    //    （锁定 + 只剩不会近期作废的桶 ⇒ 抛错，**绝不回落池**），
    //    并由 `permanent-lock-execution.spec.ts` 守住「凡 permanentLock: true 的渠道
    //    都必须有一条真的会读锁定表的执行路径」。
    permanentLock: true,
    // ⚠️ 判据是「逐包到期时间是否距今天数 < 窗口」，与 buddy 系**同口径**
    //    （`splitOfficeAceCreditsByExpiry` 与 `splitBuddyCreditsByExpiry` 逐格同构）；
    //    窗口复用 `DSH_BUDDY_EXPIRING_WINDOW_DAYS`（默认 15 天），
    //    与 `credits.permanentLock` RPC 回传给面板的 `windowDays` **同源**
    //    （面板文案与实际筛号必须是同一个数）。
    usesExpiryWindow: true,
    // ⚠️ `rateLimit: false` 的**真实理由**（2026-10-13 合并审计实测订正）：
    //    本适配器**根本不写** `modelRateLimits`（`officeace-adapter.ts` 里
    //    `modelRateLimits` / `updateModelRateLimit` / `markLimited` **零命中**，
    //    `provider-runtime-wiring.spec.ts` 也把它登记为空数组）⇒
    //    账号永远没有标记可清 ⇒ 两个按钮点下去**零请求、零清除**（恒惰性）。
    //    ⚠️ 此前这里写的是「它确实会回 429、适配器也写 `modelRateLimits`，
    //    但限流由华为云 MaaS 侧按账号配额管理」——**那句失实**（前半个分句是错的），
    //    真实判据与 accio 同因（「根本没有这组按钮的作用对象」），
    //    与 loomy / gemini 的「会写但清不掉」**不是同一回事**。
    rateLimit: false,
    settingsNamespace: 'llm-officeace',
    channel: true,
  },
  {
    id: 'accio',
    label: 'Accio (阿里)',
    displayName: 'Accio (阿里)',
    logoClass: 'accio',
    // ⚠️ 如实登记：Accio **没有签到端点** —— 每日 200 积分由**登录**触发服务端
    //    发放（`DAILY_REWARD`，24h 有效、不累积），没有可调用的签到 API。
    //    故 `dailyCheckin` 显式写 false（省略与 false 行为一致，但显式写让
    //    「想过这件事」在代码里可见）。
    //    ⚠️ **面板里也没有「刷新每日额度」入口**（2026-10-13 修订）：早先这里写过
    //    「面板另有一个 accio 专属入口，本质是重新登录」，那条承诺**未兑现**。
    //    重新登录**既有**账号需要宿主侧新增 RPC —— 现有的 `account.create` 每次都用
    //    `${provider}-${shortId()}` 现造账号 id 与凭据 ref（`src/jet-hub-rpc.ts`），
    //    拿它当重登录用会多出一条幽灵账号、而原账号额度一点没刷新；账号的 `region`
    //    也没下发给客户端；`login.poll` 对已登录账号第一秒就返回 `done: true`。
    //    ⇒ **该入口尚未实现**，客户端只做诚实展示（三类积分桶 + 重置倒计时 +
    //    「删除该账号后重新登录」这条手动路径），不渲染任何点不动的控件。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️⚠️ **`rateLimit` 已于 2026-10-18 由 `false` 改回 `true`**（issue IKM3ZV 修复）。
    //    判据是 registry 自己的落地问法：「这个按钮点下去，能不能让用户**少**受限
    //    一次？」—— 而**当时**答否，两条都不满足：
    //    ① 适配器不写 `modelRateLimits` ⇒ 账号永远没有标记可清；
    //    ② `src/index.ts` 的 `probeById` 没有它的条目 ⇒ 「重测」零请求、零清除。
    //    接上请求级换号 + 冷却（`accio-adapter.ts` 的 `markCurrentAccount`，
    //    额度至 UTC+8 当日 24:00 / 限流 1h）后 ① 已不成立，② 同步登记 ⇒ 本行翻转。
    //
    // ⚠️⚠️ **这三处必须同改**（本陷阱在本仓库已复发过多次）：
    //    本行 + `src/index.ts` 的 `probeById` + `tests/helpers/provider-sets.ts`
    //    的 `WRITES_RATE_LIMIT_PROVIDERS`。漏任一处 ⇒ 标记写进去却永远清不掉
    //    （用户点「重测」报「没有探测适配器」）。三者由 `provider-runtime-wiring.spec.ts`
    //    的 probe 域守卫**双向**比对锁死（漏一家 / 多一家都点名变红）。
    //
    // ⚠️ 与 loomy / gemini / officeace 各自的 `rateLimit: false` **理由不同**：
    //    那三家是「真会限流、但按钮管辖不到 / 根本没有作用对象」；accio 现在是
    //    「真的会写标记，且探测适配器已登记」⇒ 是**实打实可用**的入口。
    rateLimit: true,
    settingsNamespace: 'llm-accio',
    channel: true,
  },
  {
    id: 'astudio',
    label: 'AStudio (讯飞)',
    displayName: 'AStudio',
    logoClass: 'astudio',
    // AStudio 每日奖励签到对接 client-popups/pending（DAILY_REWARD_DIALOG）与
    // client-popups/complete 领取流程 ⇒ dailyCheckin 启用为 true。
    credits: { balance: true, dailyCheckin: true },
    // ⚠️ rateLimit: false —— 判据同 accio（registry 落地问法「点下去能不能让用户少受限一次？」）：
    //    astudio-adapter 不写 modelRateLimits，且刻意不进 src/index.ts 的 probeById
    //    （probeById 被守卫锁成「恰好是会写标记的家」）⇒ 两个按钮恒为惰性。
    //    将来接上请求级换号+冷却时必须同时改回 true 并进 probeById + WRITES_RATE_LIMIT_PROVIDERS。
    rateLimit: false,
    // ⚠️ **`creditPackages: true`**（2026-10-20 用户报障补）：本字段决定**账号名 hover
    //    是否列出资源包**（`plugin-src/client/credits-capabilities.js` 的
    //    `supportsCreditPackageList` 直接读它）。缺它 ⇒ 积分行只显示
    //    「1/4 个资源包有效」而 **hover 看不到每个包与到期时间**，与其它 provider 不一致
    //    （用户报障原文：「hover 应该能看到没过期的资源包」）。
    //    依据：`buildAstudioBalance`（`astudio-credits.ts`）**已经**把四个池逐包解析出了
    //    到期时间（`member` / `buy` / `activity` / `spark` 各自的 `*NextExpireTime`）
    //    ⇒ 数据本来就齐，此前只是没声明。
    creditPackages: true,
    // ⚠️ **2026-10-20 补登记：三档分档（永久/长期/临期）此前完全没生效**。
    //
    // `/points/balance` 实测**确实下发**到期时间：`activityNextExpireTime`
    // = `"2026-11-20T01:50:14"`（会员/购买两池同形，字段名 `*NextExpireTime`）。
    // 但漏登记本字段会让 `jet-hub-rpc.ts` 不回传 `windowDays`
    // （判据 `descriptorOf(req.provider)?.usesExpiryWindow === true`），
    // 客户端 `splitCreditsByExpiry` 拿到 `windowDays === undefined` ⇒
    // `normalizeWindowDays2` 返回 `null` ⇒ **整个分档返回 `null`**
    // ⇒ 胶囊只剩「合计」，永久绿/长期黄/临期红三行一个都不渲染。
    // ⚠️ 漏登记的症状是**静默的**（无报错、无日志），与 officeace / autoclaw
    //    当初同一根因；新增带到期时间的渠道时必须一并登记本字段。
    // ⚠️ PR !134 独立补登了同一字段（2026-10-21 用户报障「星火 25000 不显示」，
    //    注释称「四个池都带 `*NextExpireTime`」—— member / buy / activity / spark）。
    //    合并时保留 master 这份（依据 `/points/balance` 实测原文），并保留
    //    PR !134 带来的**客户端侧**修法（`packageExpiryMs` 归一 + 独立池摘出）——
    //    那两处才是「25000 不显示」的另一半根因，registry 登记只是另一半。
    usesExpiryWindow: true,
    // ⚠️ **2026-10-20 补登记：永久积分锁定**。
    //
    // 判据同 buddy 系（`permanentLock` ⇒ Jet Hub 账号卡片出现「锁定永久积分」开关，
    // 锁后 `credential-resolver.ts` 的 `allowPermanent` 变 false ⇒ 只有「窗口内到期」
    // 的积分包可消耗，长期/永久积分被保住）。astudio 的三个池**各自带到期时间**
    // ⇒ 与 buddy 系同形，该语义可如实成立（不是假开关）。
    // ⚠️ 与 `usesExpiryWindow` / `WIRED_EXPIRY_PROVIDERS` / `createProviderExpiry()`
    //    的 `astudioExpiry` 是**四件不同的事**，不能互相替代：
    //    · `usesExpiryWindow` ⇒ 面板三行分档
    //    · `permanentLock`     ⇒ 锁定开关 + 选号时的 `allowPermanent`
    //    · `WIRED_EXPIRY_PROVIDERS` ⇒ 聚合候选可见性
    //    · `astudioExpiry`     ⇒ 聚合时如何折算到期时刻
    permanentLock: true,
    settingsNamespace: 'llm-astudio',
    channel: true,
  },
  {
    id: 'autoclaw',
    label: 'AutoClaw (智谱)',
    displayName: 'AutoClaw (智谱)',
    logoClass: 'autoclaw',
    credits: { balance: true, dailyCheckin: true },
    // ⚠️⚠️ **2026-10-17 审计修正：本渠道「按批次分档」是尽力而为，不是保证**。
    //
    // 事实链（三条缺一，结论就反了）：
    // ① `autoclaw-credits.ts` 用**流水批次包**替换钱包包，逐包带 `deductionEndTime`
    //    （毫秒，与 officeace / buddy 同单位）—— 钱包接口本身没有任何到期字段；
    // ② ⚠️ **流水的 `amount` 是「历史发放额」，不是「该批次当前剩余额」** ——
    //    上游**没有**「该批次已消耗多少」这一腿（对照 `trae-credits.ts` 的
    //    `remaining = creditsLimit - used`：两腿都在才算得出剩余；本渠道只有发放那一腿）。
    //    ⇒ 用户**消耗过积分后**，未过期批次之和 ≠ `total_balance`；
    // ③ 因此下游以「批次和 == `total_balance`」为**守恒安全网**，不守恒即回退钱包包
    //    （总额与长期数仍正确，只是**没有**临期档）⇒ 临期档只在恰好守恒的那次轮询出现。
    //
    // ⇒ 本行是「把 `windowDays` 回传给客户端，使分档行在有批次包时能渲染」的
    //    **能力开关**，不是数据保证。
    // ⚠️ 与 `src/aggregate-expiry.ts` 的 `autoclawExpiry` 注释口径一致：
    //    聚合折算恒为 `NEVER`（钱包包无 `deductionEndTime`），两处不冲突。
    creditPackages: true,
    // ⚠️ 与 buddy / officeace 同口径（按到期时间分桶，窗口复用
    //    `DSH_BUDDY_EXPIRING_WINDOW_DAYS`）。**必须登记**：查表分派只认这个
    //    标记回传 `windowDays`，漏登记的症状是「胶囊只有合计、没有三档带色行」
    //    —— 与 officeace 当初（`officeace 必须回传 windowDays`）同一根因。
    // ⚠️ 「每日红 + 刷新倒计时」**不适用于本渠道**：那套语义
    //    （`DAILY_POOL_NAMES = ['每日赠送','每日积分']`，**精确相等**匹配，见
    //    `plugin-src/client/credit-expiry.js`）是 Loomy / Raccoon 那种
    //    **当日重置池**（未用完随重置作废）；AutoClaw 的每日签到积分是发放进余额、
    //    按批次各自到期 —— 隐藏池（服务端 `display:false`）已在解析器滤掉，
    //    流水批次的包名取服务端描述（实测「每日签到」**不等于**「每日积分」）
    //    ⇒ 两条路径都不再命中那份名单，「每日 0」红字消失。
    usesExpiryWindow: true,
    /**
     * ⚠️ **2026-10-21 补齐**（用户明确要求「补锁定开关」）。
     *
     * ## 为什么本家需要它
     *
     * `autoclaw-credits.ts` 的批次映射里有一条**代码分支**：`wallet_expires_at`
     * 缺失 / `<= 0` 的发放 ⇒ 进 `permanentByLabel` ⇒ **不带 `deductionEndTime`**
     * （= 永久桶）。⇒ 只要上游下发那种条目，就有永不作废的积分需要保护。
     * 补登记前：`supportsPermanentLock()` 为 false ⇒ 按钮**不渲染**、
     * `credits.permanentLock` RPC 直接 `bad-request` ⇒ 用户无从保护。
     *
     * ⚠️⚠️ **前提强度如实标注（2026-10-21 二轮审计）**：该分支**结构上可达、
     * 但零实测**。仓库内唯一一次流水字段完整性实测（`5fbe7ab`）结论是
     * 「**28/28 全带 `wallet_expires_at`**」，方向上**否定**该形态存在。
     * ⇒ 若上游恒带到期字段，本家的永久桶**恒为空**，这个开关**永不产生实际效果**
     *（但也不会出错 —— 它只是把已存在的分档能力接上，与仓库 11 家同构）。
     * **不得**据此声称「本家确实有永久桶」。
     *
     * ## ⚠️⚠️ 与 buddy 系的取舍**不同源**，别照抄那两行
     *
     * | | buddy 系 | AutoClaw |
     * |---|---|---|
     * | `rateLimit` | 省缺（true） | **false**（不写 `modelRateLimits`、不在 `probeById`） |
     * | 请求级换号 | 有 | **刻意没有** |
     * | 账户「每日红」语义 | 有 | **不适用**（每日签到积分是发放进余额、按批次到期） |
     *
     * ⇒ 本家的锁定只作用于「**按余额分档选号**」这一层，不涉及换号冷却
     *   （它本来就没有）。这正是 `balance: { kind: 'buddy' }` 能直接套用的原因：
     *   分档判据（`splitBuddyCreditsByExpiry`）只读通用的
     *   `packages[].{active, remaining, deductionEndTime}`，**与 provider 无关**。
     *
     * ## 四处同改（缺一即静默失效或假开关）
     *
     * 1. **本行**（`permanentLock`）——决定按钮是否渲染、RPC 是否放行；
     * 2. `src/index.ts` 的 `balance: { kind: 'buddy', selector, lockedError }` 接线
     *    ——**缺它按钮在、点了不拦**（假开关，比没有按钮更糟：`credential-resolver`
     *    的 `allowPermanent` 读不到，锁定对选号完全无影响）；
     * 3. `autoclawLockedError` 文案（本家池名与 buddy 的「服务端资源包」不同）；
     * 4. `tests/unit/autoclaw-lock-wiring.spec.ts` 的三层守卫。
     *
     * ⚠️ `autoclawintl` **同因同状态**（两站共用全部实现，只差 product 常量），
     *    两处必须同时登记 —— 漏国际站的症状是「只登国际站的用户没有锁定按钮」。
     */
    permanentLock: true,
    rateLimit: false,
    settingsNamespace: 'llm-autoclaw',
    channel: true,
  },
  {
    /**
     * **AutoClaw 国际版**（`autoglm-api.autoglm.ai`）。
     *
     * ⚠️⚠️ **为什么是独立 provider 而不是 autoclaw 的站点参数**
     *    （判据与 `minimaxintl` 完全同款，见 `src/minimax-product.ts` 文件头）：
     *
     * | 判据 | 国内 | 国际 |
     * |---|---|---|
     * | 账号体系 | 手机号 / `7c54a9ac…`（UUID） | 邮箱 / `2c99dc99…` |
     * | API 主机 | `autoglm-acceleration-api.zhipuai.cn` | `autoglm-api.autoglm.ai` |
     * | 登录方式 | 短信验证码 | **Z.ai OAuth** |
     *
     *    实测佐证（2026-10-20）：拿国内 token 打国际基址，
     *    `wallets` / `user-profile` 一律 `410000 用户未登录`、
     *    推理 `401 Invalid token` ⇒ 用户体系**物理隔离**。
     *
     * ⚠️ **实现零复制**：`AutoclawAuth` / `registerAutoclawLlm` / 积分与批次逻辑
     *    全部复用国内版那一套，只有 `AUTOCLAW_INTL` 配置不同
     *    （与 `minimaxintl` 同纪律：复制会让同类缺陷修两遍）。
     *
     * ⚠️ **登录**：Z.ai OAuth，**已于 2026-11-02 接入**（此前写的是「尚未接入、只能手工注入 token」）。
     *    `state.nh` 仍未解，实现改为不生成 state、只透传（见 `AUTOCLAW_INTL` 的注释）。
     */
    id: 'autoclawintl',
    label: 'AutoClaw (国际版)',
    displayName: 'AutoClaw (国际版)',
    logoClass: 'autoclaw',
    credits: { balance: true, dailyCheckin: true },
    /**
     * ⚠️ **必须与国内版同格**（2026-10-20 审计 P1 补）。
     *
     * 漏它的后果是**用户可见**的：国际版账号卡片 hover 看不到资源包明细
     * （与 astudio 2026-10-20 那次用户报障同型）。两家共用同一份
     * `autoclaw-credits.ts`，批次包同样带 `deductionEndTime` ⇒ 能力应当一致。
     *
     * ⚠️⚠️ 这个字段曾经**漏了却全绿**：`provider-registry.spec.ts` 把它写成
     *    **手写名单快照**，于是「漏项」被固化成了期望值 —— 补上它反而变红
     *    （审计实测：`expected [...(10)] to deeply equal [ Array(9) ]`）。
     *    ⇒ 同一次整改把那条断言改成**从能力事实派生**（见该 spec 的注释）。
     */
    creditPackages: true,
    // 分档 / 临期逻辑与国内同源（同一份 `autoclaw-credits.ts`）。
    usesExpiryWindow: true,
    // ⚠️ **与国内站同因同日补齐**（2026-10-21，用户要求「补锁定开关」）。
    //    两站共用全部实现，只差 product 常量 ⇒ 有没有永久桶、要不要锁**逐字相同**
    //    （见国内站那一段的长注释，不重复）。
    //    ⚠️ **两站必须各占一项**：`PERMANENT_LOCK_PROVIDERS` 按 provider id，
    //    漏 `autoclawintl` 会让**只登国际站**的用户没有锁定按钮（与 minimaxintl 同因）。
    permanentLock: true,
    rateLimit: false,
    settingsNamespace: 'llm-autoclawintl',
    channel: true,
  },
  {
    id: 'modelscope',
    label: 'ModelScope (魔搭)',
    displayName: 'ModelScope (魔搭)',
    logoClass: 'modelscope',
    // ⚠️⚠️ **2026-10-17 更正：本条已从 `false` 改为 `true`**（带真实 Key 实测）。
    //
    // 上面那段「12 条候选路径全 404 ⇒ 没有额度查询 API」的结论**是错的**，
    // 错在**前缀**：那批探测只试过 `/api/v1/*` 与 `/v1/*`，而真端点在
    // **`/openapi/v1/`** ——
    //
    //     GET https://www.modelscope.cn/openapi/v1/magicubes/balance
    //     Authorization: Bearer <ms-…>
    //     → {"success":true,"data":{"total_balance":281,"available_balance":281,
    //        "frozen_amount":0}}
    //
    // ⚠️ 用错前缀时它落在 SPA catch-all 上（SPA 对**任何**路径都回 200 HTML ——
    //    本仓库在 accio 记过同款「假 200」），两种表现都会让人误判成「不存在」。
    //
    // ⚠️⚠️ **「它是真余额」的判据是实测会随消耗下降**，不是字段名像余额：
    //    实测 281 → 发 2 次推理（旗舰档每次扣 2 魔粒）→ 277，**恰好 -4**。
    //    对照组 `/api/v1/quota/status`（API Key 也能读）实测发 3 次推理后
    //    **逐字节不变** ⇒ 那是**任务奖励**（点赞/分享/绑定云账号），不是余额。
    //
    // ⇒ 不需要网页登录态、不需要采集 cookie、不需要起浏览器（三种认证实测：
    //    API Key 200 / 网页 cookie 200 / 无凭据 401 `InvalidAuthentication`，
    //    即它**确实在校验凭据**，符合仓库「目录能读 ≠ 凭据有效」的纪律）。
    //
    // ⚠️ **与 opencode 的关键差异**（别把两者当同一格）：opencode 的「余额」是
    // 本地派生的**通道可用性**（零网络）；魔搭是**云侧真读数**，走 `credits` 域的
    // `fetchBalanceDetailed`（三种失败的用户动作不同，故不用笼统的 `fetchBalance`）。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 无签到：额度是**每日自动刷新**（每账号 250 魔粒、UTC+8 零点重置，
    //    旗舰档每次扣 2），**没有「领取」动作、也没有签到 API**。
    //    宿主侧 credits.claimAll 仍要显式回一句可读错误（见 jet-hub-rpc.ts），
    //    否则自动签到会把它记成 **failed** 而不是 **inactive**。
    //
    // ⚠️⚠️ **登记 `rateLimit: false`（用户要求，2026-10-17）** —— 这**不是**能力缺失，
    //    是**产品取舍**，两者的区别必须留在注释里：
    //
    //    - 能力上：魔搭确实会回 429，本适配器**确实会写** `modelRateLimits`
    //      （`modelscope-adapter.ts` 的 `modelscopeRetryAfterMs`），接线层也注入了
    //      `markLimited`（`index.ts`）；
    //    - 取舍上：用户不要「重测 / 重置」两个按钮，故关掉入口。
    //
    //    ⚠️⚠️ **代价（必须如实记录）**：冷却标记**仍会写进池**，只是用户**没法用按钮
    //    清除它** ⇒ 遇到 429 后只能等它自然过期，或删掉该账号重加。
    //    ⚠️ 与 loomy / gemini / officeace / accio 的 `rateLimit: false` **不同源**：
    //    那几家是「拿不到探测材料」（点了必然报「没有探测适配器」），魔搭是
    //    「探测材料齐全但入口刻意关闭」。**别把它当成漏登记**。
    //    ⚠️ 前两行那条「不登记 rateLimit：魔搭确实会回 429…」的旧注释已被本条取代。
    rateLimit: false,
    // ⚠️ 不登记 accountTest / creditPackages / permanentLock / usesExpiryWindow
    //    —— 全部省略 = false，与能力实情一致。
    // ⚠️ 不登记 settingsNamespace：它不在老契约（≤0.1.6）的 namespace 清单里。
    channel: true,
  },
  {
    id: 'qiniu',
    label: 'Qiniu (七牛云)',
    displayName: 'Qiniu (七牛云)',
    logoClass: 'qiniu',
    // ⚠️⚠️ **balance: false 是实测结论，不是「还没接线」**（2026-10-29）。
    //
    // 七牛云 AI（Token Plan MaaS）的用量与计费**只在控制台可见**：官方文档与
    // 全站 REST 端点实测均**无余额/额度查询接口**，也没有签到端点（订阅额度按周
    // 刷新、周期内清零不结转；免费活动额度才是按日）。
    // ⇒ src/qiniu-credits.ts **刻意不存在**，provider-credits.ts 的 creditsTable
    //   也不登记它。「查不到」与「没接线」的区别必须留在注释里，否则后人会把
    //   本条当成漏登记，去补一个编造的余额读数。
    //
    // ⚠️ 连带影响（三处都已按此判据处理，别只改这里）：
    //   - 不进 aggregate-expiry.ts 的 WIRED_EXPIRY_PROVIDERS（无余额 ⇒ 无临期档
    //     可折算），并在 expiry-runtime-parity.spec.ts 的 NOT_EXPIRY_WIRED 登记；
    //   - 不进 credits-balance-self-heal.spec.ts 的正向派生判据（那条按
    //     credits.balance === true 过滤），但仍须在 SELF_HEAL_EXEMPT 显式豁免。
    credits: { balance: false, dailyCheckin: false },
    // ⚠️ **rateLimit 省略（= true）**：本适配器**确实会写** modelRateLimits
    //   （src/qiniu-adapter.ts 的 qiniuRetryAfterMs：429 走指数退避、额度类对齐
    //   UTC+8 次日零点），接线层也注入了 markLimited ⇒ 「重测 / 重置」两个按钮
    //   都该保留。与 modelscope 的 rateLimit: false（用户取舍关闭入口）**不同源**，
    //   不要照抄成 false。
    // ⚠️ 不登记 accountTest / creditPackages / permanentLock / usesExpiryWindow
    //    —— 全部省略 = false，与能力实情一致。
    // ⚠️ 不登记 settingsNamespace：它不在老契约（≤0.1.6）的 namespace 清单里。
    channel: true,
  },
  {
    id: 'codely',
    label: 'Codely (Unity)',
    displayName: 'Codely (Unity)',
    logoClass: 'codely',
    // ⚠️⚠️ **登录已接线、推理链路未接的过渡态（2026-10-19）**：「新建账号」走
    //    设备码轮询（`src/codely-auth.ts`，与 Qoder / Cline 同款两步式，凭据落
    //    `CODELY_ACCOUNT_*`），**聊天 / 模型目录 / 续期尚未接线**。协议已从官方
    //    VS Code 插件 4.3.0 逆向 + 无凭据实探：
    //    - 设备码登录三步（已实测 200）：
    //      `POST /auth/device/initiate` `{provider:'unity', client_name:'codely-vscode',
    //      auth_from:'vscode-codely'}` → `{auth_request_token, user_code,
    //      verification_uri(_complete), interval:2, expires_in:900}`；
    //      `GET /auth/device/poll?auth_request_token=…` → pending 形状
    //      `{status:'pending', error:'authorization_pending', interval:2}`，
    //      状态机 `pending|slow_down|authorized(+authorization_code)|completed|denied|expired`
    //      （官方插件源码逐分支）；`POST /auth/device/exchange` `{authorization_code}`
    //      → `{access_token, refresh_token}`（插件源码）。
    //    - 刷新：`POST /auth/refresh` `{refresh_token}`（插件源码；**刻意未实现**，
    //      理由见 codely-auth.ts 模块头「为什么暂不实现 refresh」）。
    //    - 鉴权头：`Authorization: Bearer` + `X-User-Agent: codely-vscode/<ver>`（插件源码）。
    //    - 聊天：`POST /v1/chat/completions`（存在性已由 401/405 实测确认，报文未验证）。
    //    - 余额/积分：`/api/user/usage/summary`、`/api/points/check-in`（端点存在，未验证）。
    //
    //    ## 剩余接线清单（缺一处即静默失效，AGENTS.md 有先例）
    //    ① 本条 `channel` 改 `true`；② 删掉 `rateLimit: false`（恢复默认 true）并按实测
    //    决定 `credits.balance`；③ `src/index.ts`：import + `new CodelyAuth` +
    //    `registerCodelyLlm` + auth 注册表数组 + `JetHubAuths`（jet-hub-rpc.ts）加 `codely`
    //    键 + `refreshAccountCredential`（用 `/auth/refresh`）+ 适配器（chat/catalog）；
    //    ④ `AGGREGATE_CHANNELS`（aggregate-adapter.ts）；⑤ `SELF_HEAL_REFRESHABLE_PROVIDERS`
    //    （jet-hub-rpc.ts）；⑥ 测试侧：jet-hub-rpc-auth-wiring.spec.ts 的 `AUTH_SERVICE`
    //    表与计数、zcode-wiring.spec.ts 的豁免数组、tests/helpers/rpc-refresh.ts 的
    //    `REFRESH_PROVIDERS`、provider-registry.spec.ts 的 channel 计数与 rateLimit 清单、
    //    credits-capabilities.spec.ts 的限流清单。
    //    ⚠️ `REF_PREFIX_TO_PROVIDER`（jet-hub-store.ts）的 `CODELY` 前缀**本条已提前登记**
    //    （恢复表守卫按全量 registry 派生，channel:false 也逃不掉）。
    //
    //    ## 接线进度（2026-10-20）
    //    ⓪ 推理 ✅：**驱动官方 CLI 子进程**（签名密钥未取得，让官方客户端自己
    //       签名 —— 详见 `codely-adapter.ts` / `codely-cli.ts` 模块头）；端到端
    //       实测 4.0s 拿到非空 chunk（`codely-basic` 回复 "hello there"）。
    //    ① `channel: true` ⏸ **暂缓**（本行，2026-10-20）；✅ `rateLimit` 已于同日
    //       恢复缺省 true（换号 + 探测接线完成，见 `channel: false` 下方的说明）。
    //    ② `/auth/refresh` **端点已实测**（200、`refresh_token` 不轮换），实现待补。
    //    ③④⑤⑥ 见上方清单。
    //
    /**
     * ✅ `channel: true`（2026-10-22 A6 翻正）。
     *
     * ## 为什么原来是 `false`，现在为什么能翻
     *
     * 原注释写的是「推理已通但 `channel: true` 会点燃 9 个 spec / 11 条派生登记，先补齐再翻」。
     * ⚠️⚠️ 但那是**流程理由，不是产品理由** —— 2026-10-22 对抗审计指出：
     * `channel` 在**生产代码里零个读取点**（全仓普查，唯一消费者是 tests/），
     * 而 `false` 造成两个**用户可见**缺口：
     * - 它的模型**永不进聚合目录与轮换候选**（`AGGREGATE_CHANNELS` 缺它）；
     * - `credits-balance-self-heal.spec.ts` 用 `d.channel && d.credits.balance` 派生期望集合
     *   ⇒ codely 被**自动豁免**，那条专为「漏登记」而建的守卫对它**永不会红**。
     *
     * ⇒ 本次同步补齐全部派生登记（接线已完成：推理 / 目录 / 余额 / 签到 / 续期）：
     * `SELF_HEAL_REFRESHABLE_PROVIDERS`、`JetHubAuths.codely`、`AGGREGATE_CHANNELS`、
     * `WIRED_EXPIRY_PROVIDERS` + `createProviderExpiry()`、`modelAdapters`、以及四张 spec 的计数。
     *
     * ⚠️ **聚合轮换还差一块真实的东西**：Codely 的余额端点**不下发任何到期时间**
     * （`/api/user/usage/summary` 只有 `remaining_points` / `is_exhausted`；抽象成
     * `CreditPackage` 时 `expiredTime` 是**空串**—— 见 `codely-credits.ts`）。
     * 而聚合候选表的第一判据就是「临期档」。⇒ 本次**不把它加进**
     * `WIRED_EXPIRY_PROVIDERS`，理由是**上游没有这个数据**（不是「没接」），
     * 并在 `expiry-runtime-parity.spec.ts` 的豁免表逐字登记。
     * ⚠️ 上游一旦开始下发到期时间，只需补一个折算原语 + 两处登记。
     */
    channel: true,
    // ✅ `rateLimit` 缺省 true：请求级换号 + 冷却已接（`codely-adapter.ts` 的
    //    `updateModelRateLimit` 写点：402/预算耗尽 → UTC+8 次日 0 点、429 → 1h），
    //    `probeById.codely` 探测适配器同步挂上 ⇒「重测 / 重置」有真实作用对象。
    // ✅ `credits.balance: true`（2026-10-19 真凭据实测）：余额端点
    //    `GET /api/user/usage/summary` → `{remaining_points:"2400", is_exhausted:false, details:[…]}`
    //    —— ⚠️ 数字是**字符串**。原语在 `src/codely-credits.ts`。
    // ✅ `dailyCheckin: true`（2026-10-20 真凭据实测接通）：两步端点
    //    `POST /api/points/check-in/init`（查状态）→ `POST /api/points/check-in`（执行）；
    //    幂等判据是 `init` 的 `can_check_in`。原语 `claimCodelyDailyCheckIn`。
    credits: { balance: true, dailyCheckin: true },
  },
  {
    /**
     * **MonkeyCode 国内站**（`monkeycode`，`monkeycode-ai.com`，2026-11-02）。
     *
     * ⚠️⚠️ **这里只有一条通道**：`proxy.monkeycode-ai.com` + `oma_…`（36 位）
     *    + `signing_secret`（48 位）+ `X-OhMyAgent-Signature`（HMAC-SHA256）。
     *    本 provider **不认识** `sk-` 开头的白泽 Key —— 白泽已独立成
     *    `baizhi` provider（见本文件末尾那条）。2026-11-02 拆站前这里曾是
     *    「双通道 + `channel` 字段」，那套设计连同 `channel` 一起删除了。
     *
     * ⚠️ 只提供 Anthropic Messages（`POST /v1/messages`）：网关的
     *    `/v1/chat/completions` 与 `/v1/responses` 实测 404、`GET /v1/models`
     *    返回 405（SPEC §2）。故协议层直接复用 `src/minimax-messages.ts` 的
     *    SSE 解析与消息序列化（本仓唯一一份 Anthropic Messages 实现）。
     *
     * ⚠️ `credits.balance: true` 的依据：平台有 `GET /api/v1/users/wallet`
     *    （余额、当日额度、额度上限）与 `GET /api/v1/users/subscription`
     *    （`basic` / `pro` / `ultra` 档位）。
     * ⚠️ **但这两个接口只认 web 会话 cookie，不认 API Key**（带 Key 请求
     *    恒 401）⇒ 凭据里的 `session_cookie` **可缺省**：缺省时推理照常、
     *    余额读取如实返回「未配置会话」。**别把「没 cookie」写成「没有余额
     *    接口」** —— 那是两件事，前者用户能自己补。
     *
     * ⚠️ `credits.dailyCheckin: true` 的依据：`POST /api/v1/users/wallet/checkin`
     *    带 `captcha_token`（PoW 验证凭证）。PoW 是**纯本地计算**
     *    （`challenge` → 解 50 个子谜题 → `redeem`），实测约 0.12s，
     *    不拉起浏览器、也不吃第三方 captcha 配额 ⇒ **不登记**
     *    `autoCheckinExcluded`（与 zcode 的阿里云 captcha 不同源）。
     */
    id: 'monkeycode',
    label: 'MonkeyCode',
    displayName: 'MonkeyCode',
    logoClass: 'monkeycode',
    credits: { balance: true, dailyCheckin: true },
    /**
     * ⚠️ **rateLimit 省略（= true）**：适配器**确实会写** `modelRateLimits`
     *    （`src/monkeycode-adapter.ts` 的 `markLimited`：429 冷却 1 小时、
     *    额度耗尽对齐**次 UTC+8 零点**，`nextUtc8DayStartMs`）⇒ 账号卡片上的
     *    「重测 / 重置」两个按钮都该保留。与 modelscope 的 `rateLimit: false`
     *    （用户取舍关闭入口）**不同源**，不要照抄成 false。
     *
     * ⚠️ 2026-11-02 三审 F🟡-3 更正：此处原写「接线层注入了 `markLimited`」，
     *    **不准确** —— `MonkeycodeAdapterOptions` 根本没有这个字段，适配器只认
     *    `accountPool` 并直接调 `pool.updateModelRateLimit`（`src/index.ts:4458`）。
     *    baizhi 那个 `markLimited?` 只是**单测注入通道**，生产同样走 `accountPool`
     *    回退。⇒ 不要照 baizhi 的样子给 monkeycode 加一个 `markLimited` 再注入，
     *    那会变成「同一语义两套判据」。
     *
     * ⚠️ 不登记 `accountTest`：探活要真发一次补全请求（会消耗额度）。
     * ⚠️ 不登记 `creditPackages` / `permanentLock` / `usesExpiryWindow`：
     *    平台只下发一个总余额读数，**没有**资源包/到期分桶信息 —— 登记了
     *    会让卡片 hover 显示我们编造的明细。
     * ⚠️ 不登记 `subscriptionQuota`：它的语义是 Cline 那种「5 小时 / 周 / 月」
     *    多窗口配额；MonkeyCode 的档位（basic/pro/ultra）是**每日总额度**，
     *    形状不同，硬套会渲染成错误的窗口数。档位改由余额读数的副标题体现。
     * ⚠️ 不登记 `settingsNamespace`：它不在老契约（≤0.1.6）的 namespace 清单里。
     */
    channel: true,
  },

  {
    /**
     * MonkeyCode 国际站（`monkeycode-ai.net`，2026-11-02）。
     *
     * ⚠️ 与国内站是**独立部署**（2026-11-02 实测）：国内 cookie 打国际站回 401、
     *    两站的账号池与网关凭据互不通用 ⇒ **必须两个 provider id**。实现完全
     *    共用（`MonkeycodeAuth` / `MonkeycodeAdapter` / `monkeycode-credits`），
     *    只在 `product` 上分叉 —— `MONKEYCODE_PRODUCTS` 是唯一真相源。
     *
     * ⚠️ 除 id / label / displayName 外，**所有能力标记与国内站逐项一致**：
     *    积分端点（wallet / checkin）、签到（PoW 50 题）、推理（Anthropic
     *    Messages + `X-OhMyAgent-Signature`）是同一套代码。
     * ⚠️ 两站必须**各自一行**：`provider-runtime-wiring.spec.ts` 与续期 /
     *    积分 / 探测三条链路都按 provider id 取实例（与 minimaxintl 同型）。
     */
    id: 'monkeycodeintl',
    label: 'MonkeyCode 国际站',
    displayName: 'MonkeyCode 国际站',
    logoClass: 'monkeycode',
    credits: { balance: true, dailyCheckin: true },
    channel: true,
  },

  {
    /**
     * 百智云（`ai-models.app.baizhi.cloud`，2026-11-02）。
     *
     * ⚠️ 与 MonkeyCode 两站是**不同产品线**，只是共用 Anthropic Messages 协议：
     *    · 认证是 `x-api-key: sk-…`（**不**用 web cookie、**不**签 HMAC）；
     *    · 模型网关按量付费（`/v1/messages` 的 usage 直接结算），网关本身没有积分接口；
     *    · **但主站控制台** `baizhi.cloud` 有完整积分体系（钱包 / 每日临时积分），见下。
     *
     * ⚠️ **刻意不登记**下面这些格（登记了都是「点了必然失败」的假入口）：
     *    · `creditPackages` / `permanentLock` / `usesExpiryWindow` —— 无分桶余额；
     *    · `subscriptionQuota` —— 无配额窗口概念。
     *
     * 📌 2026-11-02 三审 F🟡-2 更正（原文自相矛盾）：本段原写
     *    「`credits` 刻意不登记 —— 三家格全无接口」，与下面 `credits:` 字段
     *    （`balance: true`）以及「二版更正」整段**正面冲突**。真相是
     *    **balance 已接**（主站控制台 × 钱包接口）；`dailyCheckin` 于
     *    2026-11-03 补全 Cap 验证码后也已接（见下）；`onboardingTasks` 确实不登记。
     *    原文还说「聚合**不进** `AGGREGATE_CHANNELS`」—— 也已过期：
     *    `AGGREGATE_CHANNELS`（`aggregate-adapter.ts`）与本表
     *    `WIRED_EXPIRY_PROVIDERS` 均已含 `'baizhi'`。
     *
     * ⚠️ **rateLimit 省略（= true）**：`src/baizhi-adapter.ts` **确实会写**
     *    `modelRateLimits`（429 冷却 / 402 额度耗尽对齐 UTC+8 次日零点），
     *    ⇒ 账号卡片的「重测 / 重置」两个按钮都该保留。
     *    ⚠️ 四审自查：本处原写「接线层注入了 `markLimited`」—— **生产不注入**，
     *    适配器自己回退到 `accountPool.updateModelRateLimit`（注入只是单测通道）。
     *    不要照抄 modelscope / magicrew 的 `rateLimit: false`。
     *
     * ⚠️ 不登记 `accountTest`：探活要真发一次补全请求（会消耗真实额度）。
     */
    id: 'baizhi',
    label: '百智云',
    displayName: '百智云',
    logoClass: 'baizhi',
    // ⚠️ `credits` 是 `ProviderDescriptor` 的必填字段（省略会直接类型错）。
    //    2026-11-02 **二版更正**：百智云确实有积分，但不在模型网关 ——
    //    `ai-models.app.baizhi.cloud` 除了 `/v1/models` / `/v1/messages` 全 404
    //    （那条实测没错），积分在**主站控制台** `baizhi.cloud`：
    //    `GET /api/v1/user/wallet/balance` →
    //    `{available_credit_cents:23505, temporary_credit_cents:9821,
    //      permanent_credit_cents:13684, frozen_credit_cents:0}`（单位 1/100 积分，
    //    与用户控制台截图 235.05 / 98.21 / 136.84 逐位吻合）。
    //    ⚠️ 控制台接口只认**网页登录态 cookie**；`x-api-key` 打过去 401
    //    ⇒ 只填了 `sk-` 的账号能发消息但查不到积分（降级成可行动提示，不报错）。
    //    ⚠️ `dailyCheckin: true`（2026-11-03 真机取证）：签到入口就是控制台
    //    顶栏「每日领积分 +100」按钮；领取要过 Cap 验证码，但那是**纯本地
    //    PoW**（`challenge → 解 50 题 → redeem`，与 MonkeyCode 同一套协议），
    //    实测完整跑通、到账 100 积分 ⇒ 不再是「做不成一键签到」。
    credits: { balance: true, dailyCheckin: true },
    // ⚠️ `channel: true`（**不是** false）：它真的持有账号与凭据、是一个普通渠道
    //    —— `false` 只留给 `aggregate`（聚合层不持有账号）。`AGGREGATE_CHANNELS`
    //    是按 id 显式列出的另一张表，两者不是一回事。
    channel: true,
  },

  {
    // 豆包（Doubao，字节跳动，2026-10-29 接入签到结构）。
    // ⚠️ 位置要求：排在 magicrew **之前** —— magicrew 有「倒数第二」的显式守卫
    //   （用户明确指定它紧邻 aggregate），新渠道插在它前面才不破那条断言。
    id: 'doubao',
    label: '豆包 (字节)',
    displayName: '豆包 (字节)',
    logoClass: 'doubao',
    // ⚠️ `dailyCheckin: true`（2026-11-03 **真机实测接通**）：`POST /alice/ug/campaign/landing/checkin`
    //    返回 `checked_in:true, reward_amount:200, continuous_days:2, idempotent:true`。
    //    签到带 `a_bogus` 签名（页面 `bdms.frontierSign` 生成）⇒ 走 CDP 页面会话，
    //    实现在 `src/doubao-signin.ts` 的 `claimDoubaoDailyViaPage`。
    credits: { balance: true, dailyCheckin: true },
    // ⚠️ **签到有代价 ⇒ 不进每日自动链**（2026-11-03，与 zcode captcha 同型）：
    //    签到要带 `a_bogus` 签名，它由豆包页面上下文的 `bdms.frontierSign` 生成 ⇒
    //    每次领取都要现场起一棵浏览器进程树（挂豆包 User Data）。默认开启的自动签到
    //    等于「用户什么都没点、开 DSH 就起浏览器」—— 白耗资源。用户仍可**手动**签到
    //   （面板点「一键领取积分」，那是有意行为）。
    autoCheckinExcluded: true,
    // ⚠️ `rateLimit: false` 必须显式写：本渠道当前没有适配器、不写
    //    `modelRateLimits`、也不在 `probeById` 里 ⇒ 「重测 / 重置」点下去恒惰性
    //   （与 magicrew / accio 旧格同因）。将来接推理链路时再翻正。
    rateLimit: false,
    // ⚠️ 不登记 accountTest / creditPackages / permanentLock / usesExpiryWindow
    //    —— 全部省略 = false，与「上游未实测、不编造数据」的口径一致。
    //
    // ⚠️⚠️ **`channel: false`（与 codely 当年「UI 先行阶段」同型）**：签到已接通，
    //    但本渠道**没有模型目录 / 适配器 / auth 服务**（纯签到渠道，无推理链路）。
    //    `channel: true` 会点燃 `refresh-targets-derived.spec.ts` 的「channel ⇒ 必须有
    //    modelAdapters 目录」守卫（报错「关闭 provider 后模型仍可选」），而 doubao 根本
    //    没有目录可关。`credits.balance: true` 的判据独立于 `channel`（见 provider-sets.ts
    //    的 `expectedProviderIdsInCreditsTable`），故积分表照常读它 —— 签到入口不受影响。
    //    将来接推理链路（目录/适配器/auth）时把本行翻 `true` 并补齐派生登记。
    channel: false,
  },

  {
    // 腾讯 Marvis（2026-11-09 接入）。
    //
    // ## 为什么只有一条模型
    // 上游**没有模型目录端点**（累计试过 9 条候选路径，全 404 / 400），模型列表
    // 只能静态兜底。槽位里只有 `main-auto` 是用户要的（服务端自动路由），实测
    // 落到 `deepseek-v4-1-flash-261017`；`deepseek-v4-pro-external` / `hy3-*` /
    // `claude-*` / `gpt-5.4` / `hunyuan-*` 本账号无授权（400 无效模型 id）或
    // 不在用户选择范围内 ⇒ **目录只列一条**。
    // ⚠️ 真实模型 id（`deepseek-v4-1-flash-261017`）**不能直传**：上游回
    //    `400 {"code":4130001,"msg":"客户端AI业务错误: 无效模型id"}`，
    //    只有槽位名可作 `model` 上行 —— 归一逻辑见 `normalizeMarvisModelId`。
    //
    // ## 能力登记的依据
    // · `balance: true`：`POST /v3/marvis_get_wallet` 实测 200，
    //   `{total_tokens:"10000000", used_tokens:"0", frozen_tokens:"0", …}`
    //   （**字符串数字**，且**没有任何日期字段** ⇒ 包里只能标 `expiryUnknown`）。
    // · 省略 `dailyCheckin`：**没有**签到端点。省略的语义就是「后端无可调用
    //   端点」，与「忘了写」不同 —— 一键签到会把它记成 inactive 而不是 failed。
    // · 省略 `creditPackages`：余额是单一口袋 + 可选「冻结中」子量，没有任何
    //   到期批次 ⇒ 名单型展示只会凭空造日期。
    // · 省略 `rateLimit`（= true）：请求级换号**真的**会写 `modelRateLimits`
    //   （429 / 额度耗尽 / 风控三条都调 `markLimited`）⇒ 限流按钮必须有。
    // · 省略 `accountTest`：探活要真发一次推理（消耗真实 token 配额）。
    // · 省略 `permanentLock` / `usesExpiryWindow`：上游不给任何到期时间，
    //   两者都以「包带到期时间」为前提。
    id: 'marvis',
    label: '腾讯 Marvis',
    displayName: '腾讯 Marvis',
    logoClass: 'marvis',
    credits: { balance: true },
    // ⚠️ 必须 `llm-<id>`（老契约 DSH ≤0.1.6 的 namespace）。
    settingsNamespace: 'llm-marvis',
    // ⚠️ `channel: true`：它持有账号与凭据，是普通渠道；`false` 只留给 `aggregate`。
    channel: true,
  },
  {
    // Magicrew（超级麦吉国内站，2026-10-29 接入）。
    // ⚠️ 位置要求（用户明确）：**排在 aggregate 之前 = 倒数第二**。
    //    守因为未自定义 `providerOrder` 时，左栏完全按本表的**声明序**渲染
    //    （`sortOpenProvidersByOrder` 对空序是恒等函数），排在 aggregate 之后
    //    会让它在左栏落到聚合下面。守卫见 `provider-registry.spec.ts` 的
    //    「★ magicrew 的声明序在 aggregate 之前（= 倒数第二）」那条（还锁了 `ia - im === 1`）。
    id: 'magicrew',
    label: '超级麦吉',
    displayName: '超级麦吉',
    logoClass: 'magicrew',
    // 余额来自 `quota/points/total`。
    // ⚠️ 2026-11-01 用户要求：补上**签到**（`POST /api/v1/login-gift`）与
    //    **新人奖励**（`onboarding/tasks`）。原先这里写「刻意不接，会消耗真实积分」
    //    是**误判** —— `login-gift` 是发放登录积分，不消耗东西。
    credits: { balance: true, dailyCheckin: true, onboardingTasks: true },
    /**
     * ⚠️ `creditPackages: true`（2026-10-29，I3）：本家余额**确实**由多个包构成、
     * 且批次带 `deductionEndTime` ⇒ 账号卡片 hover 该列包。
     * `fetchMagicrewBalance` 会**合成一个「永久积分」包**让 `sum(remaining) === total`
     *（上游的 `expiring_quota_details` 只覆盖**带到期时间的批次**：国内实测
     *  total 2661 / 批次和 1661 / 残差 1000，国际 347 / 247 / 100 ——
     *  残差就是上游不给到期时间的永久积分，取证见 `magicrew-credits.ts`）。
     * 否则 hover 会显示「只列 1661、合计 2661」让用户以为丢了积分。
     *
     * ⚠️⚠️ **字段本身原先漏了**（2026-11-01 三审实测发现）：上面这段注释从
     * 2026-10-29 起就写着「已登记 `creditPackages: true`」，但**字段根本不存在**
     * ⇒ `supportsCreditPackageList('magicrew')` 恒 false ⇒ 国内站账号卡片 hover
     * **看不到**资源包明细（国际站因为登记了所以看得到 —— 两站此前不同构）。
     * 「注释说已登记、实现里没有」比单纯漏登记更难查：读注释的人以为已经有了。
     */
    creditPackages: true,
    /**
     * ✅ `usesExpiryWindow: true` + `permanentLock: true`（2026-11-01 用户要求）。
     *
     * ## 为什么现在**能**登记（原先两条拒绝理由都已被取证推翻）
     *
     * · 旧理由「本家不走 `splitBuddyCreditsByExpiry`，登记了会让锁定路径读到
     *   错误的 `windowDays`」—— 现在是**真的走**：两站都接 `BuddyBalanceSelector`
     *  （泛型化，非 buddy product **必填** `fetchBalance`），而
     *   `fetchMagicrewBalance` 返回的正是它要的 `CreditBalance`，判据
     *  （`packages[].deductionEndTime` 距今天数）与 buddy 系**逐格一致**
     *   ⇒ 窗口天数对它同样成立。原先「用自己的 `packages`」只是**没接线**，不是不适用。
     * · 旧理由「本家没有锁定永久积分这个能力」—— 已实测**证伪**：上游确实存在
     *   「没有到期时间」的积分（见 `creditPackages` 那段的两站残差 1000 / 100），
     *   而锁定要保护的正是它。
     *
     * ## 三档在两站怎么落地
     *
     * | 桶 | 判据 | 前端 |
     * |---|---|---|
     * | 永久 | **没有** `deductionEndTime`（合成的「永久积分」包） | 绿（`permanent`） |
     * | 长期 | 有到期时间，且距扣费截止 **≥ 窗口**（默认 15 天） | 黄（`longTerm`） |
     * | 临期 | 有到期时间，且距扣费截止 **< 窗口** | 红 + 倒计时（`expiring`） |
     *
     * ⚠️ 后端只分**两桶**（`splitBuddyCreditsByExpiry` 的 expiring / permanent，
     *    longTerm 被并进 permanent），三档是**前端**用同一份 `packages` 再拆的
     *    —— 与 buddy 系完全同构。故 `windowDays` 必须由 `credits.balances` 与
     *    `credits.permanentLock` **两个 RPC 都回传**（缺一个 ⇒ 该行静默不渲染）。
     * ⚠️ 两个 id **各自登记**：白名单 `PERMANENT_LOCK_PROVIDERS` 由本表派生，
     *    漏一个的症状是「那一站的按钮不渲染、`credits.permanentLock` 直接 bad-request」。
     */
    usesExpiryWindow: true,
    permanentLock: true,
    // ⚠️⚠️ **`rateLimit: false` 必须显式写**（2026-10-29 最终审查 I1）：本家
    //    **零 `updateModelRateLimit` 写点**、也不在 `probeById` 里 ⇒「重测 / 重置」
    //    两个按钮点下去是**零请求、零清除**（`account.retest` 走 `adapterForProbe`
    //    会抛「magicrew 没有探测适配器」）。与 `accio` 那一格逐字同因。
    //    ⚠️ 原先省略它的理由是「默认关闭会让老用户失去按钮」—— 那条**对全新
    //    provider 不成立**（无存量用户、无功能回退可言，见 providers-accio 笔记）。
    rateLimit: false,
    // ⚠️ 2026-11-01 用户要求补上签到与新人奖励 ⇒ 现在**两个能力都登记**
    //   （原先这两格都缺，注释写的是「刻意不接 / 本轮不做」）：
    //   · `dailyCheckin` —— `POST /api/v1/login-gift`（**请求体存在且为空串**、幂等、
    //     国内 +200/天）。原先记的理由「会消耗真实积分」是**误判**：该端点是**发放**
    //     登录积分，不消耗任何东西（见 `provider-credits.ts` 的 magicrew 段注释）。
    //   · `onboardingTasks` —— 8 项新手引导任务，每号一辈子一次；
    //     第 8 项 `first_ai_work` 不支持手动完成（服务端 9303），原语归 `manualRequired`
    //     （**不是** `skipped` —— 那个语义是「此前已完成」）。
    //     ⚠️⚠️ **刻意不写总分**：参考实现 `magpie-magicrew-auth/README.md:179` 的标题
    //     写「8 项，合计 500 积分」，而**同一页的逐项表相加只有 450**（100 + 7×50）
    //     —— 两个数字自相矛盾，无法判定哪个对。
    //     ⇒ 本仓一律以**上游 `tasks[].points` 现场累加**为准（见
    //     `magicrew-checkin.ts` 的 `fetchMagicrewOnboardingStatus`），
    //     任何注释与用户文案都不得写死金额。
    //   上面 `credits` 字段的 `balance: true` 保持不变。
    channel: true,
  },

  {
    /**
     * **MagiCrew 国际站**（`magicrewintl`，2026-11-01 用户要求）。
     *
     * ⚠️⚠️ **为什么是独立 provider 而不是 magicrew 的站点参数**
     *    （判据与 `minimaxintl` / `autoclawintl` 完全同款）：
     *
     * | 判据 | 国内（超级麦吉） | 国际（MagiCrew） |
     * |---|---|---|
     * | 网页 | `www.letsmagic.cn` | `www.magicrew.ai` |
     * | API host | `i-magic-service.letsmagic.cn` | `magic-service.magicrew.ai` |
     * | 登录体系 | 手机号 / 短信验证码 | 邮箱 / OAuth |
     * | 每日签到 | +200 / 天 | **+50 / 天** |
     * | 强制 org | 否 | **是**（业务 API 缺了回 `code 2182`） |
     *
     *    两站是同一个 Go 服务的两个**数据面**，账号体系物理隔离（凭据前缀
     *    `MAGICREW_*` / `MAGICREWINTL_*` 也不同）⇒ 合并成一个 provider 会让
     *    选号器与余额按错误的 host 取数。
     *
     * ⚠️ **实现零复制**：`MagicrewAuth` / `MagicrewService` / 目录 / 积分 / 签到 /
     *    新人奖励全部复用国内版那一套，只有 `MAGICREW_INTL` 常量不同
     *    （与 `autoclawintl` 同纪律：复制会让同类缺陷修两遍）。
     *
     * ⚠️⚠️ **国际站新人奖励预期拿不到**：该站 `GET /onboarding/tasks` 恒返回
     *    `{participant_type: null, tasks: []}` —— 是「账号没被登记进引导计划」，
     *    **不是**「已领完」⇒ UI 会显示「无新人任务」（如实，不是失败）。
     *    代码照样登记，因为「万一登记了就能领」。
     */
    id: 'magicrewintl',
    label: 'MagiCrew (国际版)',
    displayName: 'MagiCrew (国际版)',
    // ⚠️ 与国内版共用同一份图标资产（同一个 Go 服务、同一个品牌的两个站点）。
    logoClass: 'magicrew',
    credits: { balance: true, dailyCheckin: true, onboardingTasks: true },
    /**
     * ⚠️ `creditPackages: true` 必须与国内版同格：两站共用同一份
     *    `magicrew-credits.ts`，`fetchMagicrewBalance` 同样会合成「永久积分」包
     *    （国际站实测 total 347 / 批次和 247 / 残差 100）。
     *    漏了它 ⇒ 国际站账号卡片 hover 看不到资源包明细（与 `autoclawintl`
     *    2026-10-20 那次用户报障同型）。
     * ⚠️ `usesExpiryWindow` / `permanentLock` **与国内版同格登记**（2026-11-01
     *    用户要求）：两站共用同一个余额原语与同一个选号器类，判据逐格一致；
     *    「为什么原先两条拒绝理由已被推翻」见国内版那一段的长注释，不重复。
     *    ⚠️ 两站**必须各写一行**（不能靠国内版继承）：`PERMANENT_LOCK_PROVIDERS`
     *    是 `PROVIDER_REGISTRY.filter(permanentLock === true)` 派生的 ⇒
     *    漏一站的症状是「那一站按钮不渲染 + `credits.permanentLock` bad-request」。
     */
    creditPackages: true,
    usesExpiryWindow: true,
    permanentLock: true,
    // ⚠️ 同国内版：本家零 `updateModelRateLimit` 写点、不在 `probeById` 里。
    rateLimit: false,
    channel: true,
  },
  {
    id: 'aggregate',
    label: '聚合 (跨渠道)',
    displayName: '聚合 (跨渠道)',
    logoClass: 'aggregate',
    // ⚠️ 如实登记为 false：它**没有自己的账号与余额** —— 复用各渠道的账号，
    //    积分与限流由各渠道自己管理。
    // ⚠️ 这不影响用量徽标：徽标对聚合的处理是「重定向到实际选中的渠道」，
    //    重定向发生在 `supportsCreditBalance` 门控**之前**。
    credits: { balance: false, dailyCheckin: false },
    channel: false,
  },
])

/** 按 id 取声明；未知返回 `undefined`（调用方决定报错措辞）。 */
export function descriptorOf(id: string): ProviderDescriptor | undefined {
  return PROVIDER_REGISTRY.find((d) => d.id === id)
}

/**
 * 派生出客户端 `CREDITS_CAPABILITIES` 的同形结构。
 *
 * ⚠️ 只拷贝**已声明**的可选字段（不用 `undefined` 占位）：既有断言用的是
 * `toEqual`，而 `toEqual` 会忽略 `undefined` 属性 —— 但显式写 `undefined`
 * 在快照/序列化场景下仍可能产生差异，保持"缺失即缺失"最安全。
 */
export function creditCapabilitiesOf(): Record<string, CreditsCapability> {
  const out: Record<string, CreditsCapability> = {}
  for (const d of PROVIDER_REGISTRY) {
    // ⚠️ **每一条都要 `Object.freeze`**（2026-10-08 复审修复）：重构前
    // `credits-capabilities.js` 是**逐条手写的字面量**、每条各自带
    // `Object.freeze({…})`，改成派生时只保住了外层的 `Object.freeze(creditCapabilitiesOf())` ——
    // 那只冻结**外层容器**（键不可增删），**内层条目仍可被改写**。
    // 同一文件另外两张派生表（`RATE_LIMIT_CAPABILITIES` /
    // `ACCOUNT_TEST_CAPABILITIES`）各自都留着 `Object.freeze({…})`，
    // 三张表必须同款 —— 本仓库的约定是「保险失效比变红更糟」：
    // 静默失效的守卫比没有守卫更危险（它会让人以为已经守住了）。
    out[d.id] = Object.freeze({
      balance: d.credits.balance,
      // ⚠️ `dailyCheckin` 也是**可省略**字段（见 `CreditsCapability` 的注释：
      //    raccoon 刻意不登记它），故按本函数「缺失即缺失」的规则一并条件拷贝
      //    —— 这样「raccoon 没有签到端点」这件事在派生表里也是**可见的缺失**，
      //    而不是一个与 `false` 无法区分的 `undefined`。
      //    判据侧一律 `=== true`（`supportsDailyCheckin`），故行为不变。
      ...d.credits.dailyCheckin === undefined ? {} : { dailyCheckin: d.credits.dailyCheckin },
      ...d.credits.onboardingTasks === undefined ? {} : { onboardingTasks: d.credits.onboardingTasks },
      ...d.credits.subscriptionQuota === undefined ? {} : { subscriptionQuota: d.credits.subscriptionQuota },
    })
  }
  return out
}

/**
 * **会做「余额到期分档」的渠道**（`id` 全集的唯一真源）。
 *
 * ## 为什么需要这张表
 *
 * 这些渠道的选号器走 `pickBuddyAccount` / `rankBuddyAccountsByBalance`
 *（或 Loomy 那份同构实现）：**先按积分到期档位排序，档内才看用户拖拽的顺序**。
 * 其余渠道（codearts / raccoon / cline / gemini …）是纯池内手动序 ——
 * 拖拽对它们是**绝对**的优先级。
 *
 * 这个差别对用户是**不可见**的，而它正是「拖拽时灵时不灵」这条报障的根源：
 * 面板文案「按顺序选号」在分档渠道上只是一半真话。
 * ⇒ 面板据此决定要不要渲染「严格手动顺序」开关，以及要不要补一句说明。
 *
 * ## ⚠️ 它必须与真实装配一致
 *
 * 来源是 `src/index.ts` 里**每一处** `balance: { kind: 'buddy' | 'loomy' }`
 * 的 `product`（2026-11-09 逐处清点）。加渠道时**必须同步**，
 * `tests/unit/strict-manual-order-wiring.spec.ts` 会扫描 `src/index.ts`
 * 的真实装配做**双向差集**（表多一条 / 少一条都变红），并逐条核对
 * `isBalanceTieredProvider` —— 漏一家**不会**静默少一个开关。
 *
 * ⚠️ **`officeace` 刻意不在表里**：它的分档只发生在**锁定永久积分**时
 *（`officeace-lock.ts` 的 `permanentLocked() === false` 分支直接走
 * `resolveUnlocked()`，与手动顺序逐字节同路径）。给它渲染开关会承诺一个
 * 解锁态下不存在的排序语义。
 */
export const BALANCE_TIERED_PROVIDERS: readonly string[] = Object.freeze([
  'buddy',
  'workbuddy',
  'lobsterai',
  'qoder',
  'qodercn',
  'trae',
  'loomy',
  'minimax',
  'minimaxintl',
  'autoclaw',
  'autoclawintl',
  'magicrew',
  'magicrewintl',
  'astudio',
])

/** 该渠道的选号是否会先按余额到期档位排序（见 {@link BALANCE_TIERED_PROVIDERS}）。 */
export function isBalanceTieredProvider(provider: string): boolean {
  return BALANCE_TIERED_PROVIDERS.includes(provider)
}
