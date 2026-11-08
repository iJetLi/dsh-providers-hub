/**
 * 各 provider 的积分能力矩阵 —— Jet Hub 面板判断「要不要碰积分」的唯一真相源。
 *
 * 为什么必须单独成表、且必须在**发起请求之前**判断：
 *
 * Host 侧积分端点对**三套互不相同的协议**分派（见 `src/jet-hub-rpc.ts`）：
 * CodeBuddy 系经 `productById(provider)` 取产品配置，LobsterAI 与 CodeArts
 * 各自提前分支。未登记的 provider 仍会落到 `bad-request`，因此客户端必须
 * 在发请求之前按本表门控 —— 历史缺陷正是「对不支持的 provider 无条件发请求」：
 * 早期 CodeArts 两项能力皆无，客户端却在面板挂载时对所有 provider 调用
 * `credits.balances`，于是每打开一次 CodeArts 面板都会：
 *   1. 在控制台留下一条必然失败的报错（`[jet-hub] load credits failed`）；
 *   2. 把该页面每个账号卡片的「积分」渲染成「查询失败」。
 * 修法不是在 UI 上吞掉错误，而是**不发起这个请求**。
 *
 * 之所以用一张表而不是散落的 `provider === 'buddy' || provider === 'workbuddy'`
 * 判断：能力集合将来会随产品变化（新增 provider、某产品开放/下线接口），集中
 * 一处才可能与 `src/product.ts` 对齐，并由单测守住不漂移。
 *
 * 两个能力**彼此独立，不能互相推断**：
 *
 * | provider    | balance（积分余额） | dailyCheckin（每日签到领取） |
 * |-------------|---------------------|------------------------------|
 * | `codearts`  | ✓ 华为签名          | ✓ 华为签名                   |
 * | `buddy`     | ✓                   | ✓                            |
 * | `workbuddy` | ✓                   | ✗ 国际版后端无签到接口        |
 * | `lobsterai` | ✓                   | ✓ `client-activities` 三步流程 |
 * | `qoder`     | ✓ `sash/api/v2/me/usage` | ✗ 未见签到接口            |
 * | `trae`      | ✓                   | ✓ `checkin_credits/*`        |
 * | `cline`     | ✓ `/api/v1/users/{id}/balance` | ✗ 后端无签到接口  |
 *
 * - `balance`：CodeBuddy 系用 `POST /v2/billing/meter/get-user-resource`
 *   （CodeBuddy 与 WorkBuddy 国际版**通用**，仅 baseURL 随 `product.endpoint`
 *   切换）；LobsterAI 用 `GET /api/user/profile-summary`；CodeArts 用
 *   `GET /snap-manager/v1/statistics/plugin`（与账户类型检测同一响应）；
 *   Qoder 用 `GET /sash/api/v2/me/usage`（见 `src/qoder-credits.ts`）。
 *   见 README「积分余额」。
 * - `dailyCheckin`：CodeBuddy 系用 `checkin-activity-status` + `daily-checkin`
 *   （**仅 CodeBuddy 中国版**有；WorkBuddy 国际版内核里只有
 *   `get-dosage-notify` 用量通知）；LobsterAI 用 `client-activities` 的
 *   slot → context → check_in 三步（见 `src/lobsterai-credits.ts`）；
 *   CodeArts 用 `/v1/ops/delivery` + `/v1/ops/claim`(+`confirm`)
 *   （见 `src/codearts-credits.ts`）；Qoder 用
 *   `/sash/api/v1/me/campaigns` 列出活动再逐个
 *   `POST …/{campaignId}/claim`（见 `src/qoder-credits.ts`）。
 * - `qoder` **两项都有**。⚠️ 早期误判为「两项皆无」，原因有二：
 *   ① 只按 `/api/` 前缀搜索端点，而它挂在 **`/sash/`** 下、且只需
 *   Bearer + `Cosy-ClientType`（不需要 WASM 签名，实测返回
 *   `addOnQuota.remaining: 100`）；
 *   ② 随后又误判「无签到」—— 依据是 `/sash/api/v1/me/campaigns` 返回
 *   `claimable:false, campaigns:[]`，但那是**当天已领**的正常表现
 *   （活动每日 10:00（UTC+8）刷新）。2026-09-21 用 keylog 解密抓包
 *   拿到了领取端点与幂等证据（`replayed:true`）。
 *   **教训**：「某次实测没看到」不能推广成「不存在」。
 *
 * 判定一律**默认关闭**：未登记的 provider 视为不支持任何积分能力。这样将来
 * 新增 provider 时，若忘记在此登记，最坏结果是「暂时看不到积分」，而不是
 * 「每次打开面板都发一个必然失败的请求」。
 *
 * ⚠️ **本文件里的逐条历史依据已随值迁移到 `src/provider-registry.ts` 的
 * 字段注释**（2026-10-08 收敛），例如「为什么 workbuddy 无签到」「为什么
 * raccoon 只有 onboardingTasks」「为什么 opencode 的 balance 是 true」。
 * 上表里保留的是**判定方法本身**的由来。
 */

import {
  PROVIDER_REGISTRY,
  creditCapabilitiesOf,
  descriptorOf,
  isBalanceTieredProvider,
} from '../../src/provider-registry.js';

/**
 * 积分能力矩阵。
 *
 * ⚠️ 2026-10-08 起**从 `src/provider-registry.ts` 派生**，不再手写在这里
 * —— 原先「加 provider 要同时改 5 处（3 张表 + PROVIDERS + 后端清单）」
 * 是静默失效的来源。各条的历史依据（为什么 workbuddy 无签到、为什么
 * raccoon 只有 onboardingTasks）已随值迁移到 registry 的字段注释里。
 */
export const CREDITS_CAPABILITIES = Object.freeze(creditCapabilitiesOf());

/**
 * 各 provider 是否具备「**模型限流**」这一机制（即服务端会因限流而拒绝请求）。
 *
 * ## 为什么需要它（真实发现）
 *
 * Loomy **不会返回限流错误**：实测今日赠送额度（每天 5000）用完后，服务端
 * 继续扣永久积分且照常返回（静默降级）。因此「重测 / 重置」这组按钮对它
 * **毫无意义** —— 重测永远测不出限流，重置也没有标记可清。
 * 用户报障：「这个 provider 好像没发现模型限流，把重置所有按钮删掉」。
 *
 * ## 为什么「未登记 = 视为有限流」（与上面的积分能力约定**相反**）
 *
 * 积分能力的约定是「默认关闭」（未登记就不发请求，避免必然失败的请求）。
 * 但限流按钮**是既有 UI**：若这里也默认关闭，将来新增 provider 时忘记登记，
 * 会让老用户**凭空失去**「重测 / 重置」按钮 —— 那是可见的功能回退。
 * 故这里默认**开启**。
 *
 * ## 登记 `false` 的判据（2026-10-03 纳入 Gemini 后重写）
 *
 * 不是「该渠道不会限流」，而是「**该渠道的限流不由这组按钮的语义管辖**」。
 * 当前登记 `false` 的家**理由各不相同**（逐条见 registry 里各自的字段注释）：
 * - Loomy：**根本不返回限流错误** —— 重测永远测不出东西，重置没有标记可清；
 * - Gemini / OfficeAce：**限流是服务端配额制** —— 本地标记与重测都不改变配额本身，
 *   按钮只剩「白烧配额」与「把受限账号放回池里再撞一次」两种副作用；
 * - Accio：**根本不写 `modelRateLimits`、也不在 `probeById` 里** ——
 *   两个按钮点下去零请求、零清除（恒为惰性）。
 * ⚠️ 2026-10-13 合并审计补 OfficeAce：此前这里只列三家（漏了它），
 *    而实测 `rateLimit === false` 是**四家**。判据以 registry 为准，本段只是说明。
 *
 * 落地问法：「这个按钮点下去，能不能让用户**少**受限一次？」答否即 `false`。
 *
 * ⚠️ 2026-10-08 起**从 `src/provider-registry.ts` 的 `rateLimit` 字段派生**。
 * 上面那段「登记 `false` 的判据」与各家理由**已随值迁移**到 registry
 * 里各自的 `rateLimit` 字段注释。
 */
export const RATE_LIMIT_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    PROVIDER_REGISTRY
      .filter((d) => d.rateLimit === false)
      .map((d) => [d.id, Object.freeze({ rateLimit: false })]),
  ),
);

/**
 * 该 provider 的请求是否会因**模型限流**被拒（决定是否渲染「重测 / 重置」）。
 *
 * ⚠️ 默认 `true`（未登记即视为有限流），理由与登记判据见
 * {@link RATE_LIMIT_CAPABILITIES}。
 */
export function supportsRateLimit(provider) {
  return RATE_LIMIT_CAPABILITIES[provider]?.rateLimit !== false;
}

/**
 * 该渠道的选号是否**先按余额到期档位排序**（决定面板渲不渲染「严格手动顺序」）。
 *
 * 判据在宿主的 `BALANCE_TIERED_PROVIDERS`（`src/provider-registry.ts`）——
 * 那里是「哪些渠道走 `pickBuddyAccount`」的唯一真源，有单测扫描 `src/index.ts`
 * 的真实装配做过账。本函数只是把它暴露给客户端，**不另写一份名单**。
 */
export function supportsBalanceTier(provider) {
  return isBalanceTieredProvider(provider);
}

/**
 * 各 provider 是否支持账号卡片上的「**测试**」按钮（无条件真发一次请求探活）。
 *
 * ## 与「重测」的区别（这是它存在的全部理由）
 *
 * 「重测」的触发条件是**该账号已有 `modelRateLimits` 标记**：没有标记时
 * `retestAccount` 在 `modelIds.length === 0` 处提前返回、**一次请求都不发**。
 * 于是「这个账号到底还能不能用」在**没有历史 429** 时没有任何手动探活入口 ——
 * 用户点「重测」看到瞬间返回，会以为按钮失灵（真实报障：
 * 「重测按钮你确认过会发请求吗，为什么响应这么快？」）。
 * 「测试」不看标记，直接挑一个模型真发出去，且**不写任何存储**。
 *
 * ## 为什么默认**关闭**（与上面的限流表相反）
 *
 * 限流按钮是**既有 UI**，默认关闭会让老用户凭空失去按钮（可见的功能回退）。
 * 「测试」是**全新按钮**，没有存量用户，故遵循积分能力表的约定：默认关闭，
 * 只在明确验证过「这个渠道真的能探活」时才登记。未登记 ⇒ 不渲染。
 *
 * 目前只登记 Gemini —— 本窗口只验证过它（`src/account-probe.ts` 的
 * `testAccount` 走的就是 gemini 的分派支），其余 provider 未验证前不铺开。
 *
 * ⚠️ 2026-10-08 起**从 `src/provider-registry.ts` 的 `accountTest` 字段派生**。
 */
export const ACCOUNT_TEST_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    PROVIDER_REGISTRY
      .filter((d) => d.accountTest === true)
      .map((d) => [d.id, Object.freeze({ test: true })]),
  ),
);

/**
 * 该 provider 的账号卡片是否渲染「测试」按钮。
 *
 * ⚠️ 默认 `false`（未登记即不渲染），理由与登记判据见
 * {@link ACCOUNT_TEST_CAPABILITIES}。
 */
export function supportsAccountTest(provider) {
  return ACCOUNT_TEST_CAPABILITIES[provider]?.test === true;
}

/**
 * 「锁定永久积分」窗口：距**扣费截止**不足 15 天的积分算临时（会很快作废，优先烧掉），
 * 其余算永久。
 *
 * ⚠️ 必须与后端 `src/buddy-balance-rank.ts` 的 `BUDDY_EXPIRING_WINDOW_DAYS` 一致 ——
 * 前端只做展示，判据在后端；这里写的数字若与后端不同，用户会看到「提示说只烧
 * 8 天内的，实际按 15 天筛号」这种无法解释的偏差。
 */
export const PERMANENT_LOCK_EXPIRING_WINDOW_DAYS = 15;

/**
 * 该 provider 是否支持「锁定永久积分」（只消耗会近期作废的积分）。
 *
 * ⚠️ 目前六家具备，**依据分两类**：
 *
 * **服务端直接给两个命名池**：
 * - `loomy`：`dailyBalance`（**当日**到期，次日重发）与 `balance`（注册奖励 + 新手任务，不过期）。
 *
 * **按逐包到期时间现算**（同一个 `splitBuddyCreditsByExpiry` / `splitOfficeAceCreditsByExpiry`，
 * 判据与 provider 无关）：
 * - `buddy` / `workbuddy`：一个账号常同时有多个资源包，按包的 `DeductionEndTime`
 *   距今是否满 {@link PERMANENT_LOCK_EXPIRING_WINDOW_DAYS} 天现算（实测国际版是
 *   「Bonus Pack 14 天 + Free Plan 扣费截止 8 年后」，中国版是「体验版套餐 +
 *   30/365 天的拉新与裂变包」）。
 * - `trae`：条目级 `expire_time`（秒级 Unix 时间戳，见 `src/trae-credits.ts` 的取证注释）。
 * - `lobsterai`：`expiresAt`（ISO 8601，已归一化到 `deductionEndTime`）。
 * - `officeace`（2026-10-15 接入）：订阅响应的每个积分桶都带到期时间
 *   （套餐包**没有**到期字段 = 永久桶，签到/活动包有）⇒ 判据同 buddy 系。
 *   ⚠️ **它此前是个哑锁**：登记了 `permanentLock` 却没有任何执行代码，
 *   且文案落到 Loomy 那一套（Gitee issue IKLTHB）—— 现已由 `src/officeace-lock.ts`
 *   执行，见 `tests/unit/permanent-lock-execution.spec.ts` 的普查。
 *
 * ⚠️ 后三家**没有「每日额度 / 永久积分」两个命名池**，但同样能按到期时间分桶 ——
 * 对锁定功能而言，判据只需「会不会马上作废」，与池的名字无关。它们的余额面板
 * 也早已用同一个窗口分「长期 / 临时」（见 `src/jet-hub-rpc.ts` 的 `credits.balances`）。
 *
 * 其余渠道的积分模型里没有逐包到期时间（或根本没有资源包列表），
 * 分不出两桶，登记进来只会多一个无效按钮。
 *
 * ⚠️ 必须与后端 `src/jet-hub-rpc.ts` 的 `PERMANENT_LOCK_PROVIDERS` 一致：
 * 不一致会出现「按钮渲染出来了，点了却报 bad-request」。
 *
 * 为 false 时面板**不得**渲染该按钮，也不得发起 `credits.permanentLock`。
 *
 * ⚠️ 2026-10-08 起与后端 `PERMANENT_LOCK_PROVIDERS` **同出一个字段**
 *（registry 的 `permanentLock`），不再是一份手抄副本 —— 原先两处不一致会出现
 *「按钮渲染出来了，点了却报 bad-request」。上面那两类依据**已随值迁移**到
 * registry 里各条的 `permanentLock` / `usesExpiryWindow` 注释。
 */
export function supportsPermanentLock(provider) {
  return descriptorOf(provider)?.permanentLock === true;
}

/**
 * 该 provider 的余额是否**真的由多个资源包构成且有到期信息**（决定账号名 hover 要不要列包）。
 *
 * ⚠️ 只有 `buddy` / `workbuddy` / `lobsterai` 具备。这不是"避免冗余"，而是**防止显示错误信息**：
 * - `loomy` 的 `packages` 是我们自己合成的两个条目（`makePackage('永久积分'…)` /
 *   `makePackage('每日赠送'…)`），它们**没有** `deductionEndTime` → 按降级规则会被标成「永久」。
 *   若不加这道门控，loomy 卡片上会出现「每日赠送 4992 / 4992 永久」——而那笔恰恰**当天就作废**，说反了。
 * - `trae` 的有效期为 **31 天**（从起始日期算起）。服务端不返回独立的到期字段，
 *   但规则明确 ⇒ 可以挂（后端已按"起始日期 + 31 天"计算 deductionEndTime）。
 * - `qoder` / `qodercn`：**须分两层看**（2026-10-20 真机取证后订正，见下）。
 *   `qoderUsage.expiresAt` 这个字段**确实存在**（在 `userQuota` 那一层），但个人版
 *   实测下发的恒是 **永久哨兵** `253402214400000`（= `9999-12-31`）⇒ 它不携带信息，
 *   后端已刻意不据此写 `deductionEndTime`（否则卡片会渲染成
 *   「9999-12-31（约 2900000 天后）」）。`addOnQuota` 只给聚合标量（`total/used/remaining`
 *   + 一个指网页端的 `detailUrl`），上游不逐包下发日期。只有 `dedicatedResourcePackages[]`
 *   带真实的 `expiresAt` ⇒ 可挂（有到期信息的包显示日期，没有的显示"长期"）。
 *
 *   ⚠️ 因此**不要**把这条读成"Qoder 没有任何到期字段" —— 早先的注释就是这么写的，
 *   已失实（它漏掉了 `userQuota` 那层的 `expiresAt`，也漏掉了"有字段但是哨兵"这个
 *   第三种形态）。逐包到期明细端点只对**浏览器登录态**开放（`qoder.cn/api/v1/me/...`
 *   返回 401），插件的 OAuth token 取不到 ⇒ 三档分档里 Qoder 的临期桶在
 *   无 `dedicatedResourcePackages` 时恒为 0。
 * - LobsterAI：有 `expiresAt` 字段（ISO 日期字符串），已明确过期判据。
 *
 * ⚠️ 2026-10-08 起**从 `src/provider-registry.ts` 的 `creditPackages` 字段派生**，
 * 上面逐条的依据已随值迁移到 registry 里各条的注释。
 */
export function supportsCreditPackageList(provider) {
  return descriptorOf(provider)?.creditPackages === true;
}

/**
 * 「锁定 / 解锁永久积分」按钮与提示的**按 provider 文案**。
 *
 * ## 为什么不能让三个 provider 共用一句
 *
 * 「临时积分」在三家的含义不同：Loomy 是**当天**发放的赠送额度，两个 buddy 是
 * **N 天内会作废**的资源包。共用「只消耗每日赠送额度」这句话，buddy 用户会以为
 * 锁上后每天刷新的额度还在优先消耗 —— 而它每天根本拿不到新额度（签到得来的也是
 * 14/30 天后到期的包）。文案必须说清「保住的是什么、先烧的是什么、什么时候会
 * 没有可用账号」。
 *
 * @param provider - provider id。
 * @param windowDays - 后端回传的**当前生效窗口**（`credits.permanentLock` 的
 *   `windowDays`）。⚠️ 必须用它渲染，不能用本文件的默认常量：窗口可被
 *   `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，写死会出现「提示说 15 天、实际按
 *   31 天筛号」。缺省（未读到 / Loomy）时回落到默认常量。
 * @returns 四个文案位：未锁定态的按钮标题 / 已锁定态的按钮标题 /
 *          锁定成功提示 / 解锁成功提示。
 */
export function permanentLockCopy(provider, windowDays) {
  // ⚠️ 判据是「**是否按到期时间分桶**」（= registry 的 `usesExpiryWindow`），
  // 不是「是不是 buddy」：trae / lobsterai / officeace 与 buddy 系走的是同一套
  // 「按 `expiresAt` 距今天数分桶」的判据，窗口天数对它们同样有意义，
  // 故必须共用这套带天数的文案（否则会错误地落到下面 Loomy 那套「每日赠送额度」文案，
  // 而它们根本没有「每日额度」这个概念 —— officeace 的每日签到额度只是**其中一个
  // 当日作废的积分桶**，锁定的判据是「桶的到期时间」，不是「哪个桶」）。
  //
  // ⚠️ 2026-10-15：原先这里是一份**硬编码名单**（`buddy`/`workbuddy`/`trae`/
  // `lobsterai`），officeace 加进 `permanentLock` 时被漏掉 ⇒ 它拿到了 Loomy 的文案
  // （「今日额度用尽后将没有可用账号」），而它真实的判据是 N 天窗口。
  // 已改为**与后端同出一个字段**（与 `supportsPermanentLock` 同款），
  // 新增渠道时不再需要改这里。
  if (descriptorOf(provider)?.usesExpiryWindow === true) {
    const days = normalizeWindowDays(windowDays);
    /**
     * ⚠️ 文案纪律（2026-10-27 用户两轮要求：先「改成直白句式」，再「折中一下」）：
     *
     * 三件事必须说清、顺序不许打乱 —— **留什么 → 烧什么 → 烧完怎样**：
     *   ① 永久积分留着不动；
     *   ② 只烧 N 天内到期的；
     *   ③ 这类烧完就没有可用账号。
     *
     * ⚠️ 这一版是**折中**：既不回到旧文案的嵌套引号（「只消耗「15 天内到期」
     *    的积分包」—— 要拆括号才读得懂），也不沿用上一版的全口语化
     *    （「点此锁定永久积分：永久积分留着不动，锁定后只消耗…」—— 一句话里
     *    「锁定」出现三次、「永久积分」出现两次，且「点此」放在句首显得啰嗦）。
     *    ⇒ 取书面语的中性句式：短句、无嵌套引号、无重复字眼，
     *      操作提示（点此锁定 / 点此解锁）统一收到**句尾**。
     *
     * ⚠️ 必须保留字面 `N 天内到期` 与 `每日赠送额度`：它们是
     *    `tests/unit/credits-capabilities.spec.ts`、`permanent-lock-execution.spec.ts`、
     *    `permanent-lock-trae-lobsterai.spec.ts` 的锚点，换说法会假红。
     *
     * ⚠️⚠️ `lockTitle` 必须保留「**锁定后**」这个条件标记（2026-10-28 审计修回）：
     *    它只在**未锁定**时渲染（`jet-hub.js` 的按钮 `title` 三元），删掉「锁定后」就变成
     *    直陈现状 —— 而未锁定时永久积分**正被消耗**，于是 tooltip 宣称「永久积分留着不动」，
     *    与同面板「刚解锁」的提示（`unlockedNotice`：会继续使用永久积分）**同屏互相打脸**。
     *    `lockedTitle` 相反：它只在**已锁定**时渲染，那句话正是现状 ⇒ **不要**给它加「锁定后」。
     *    （`lockedNotice` 用「已锁定：」而不是「已锁定永久积分：」，否则与紧随其后的
     *    「永久积分留着不动」连读成「永久积分：永久积分」的叠词。）
     */
    return Object.freeze({
      days,
      lockTitle: `锁定后永久积分留着不动，只消耗 ${days} 天内到期的积分。这类积分用完即无可用账号。点此锁定。`,
      lockedTitle: `永久积分留着不动，只消耗 ${days} 天内到期的积分。这类积分用完即无可用账号。点此解锁。`,
      lockedNotice: `已锁定：永久积分留着不动，只消耗 ${days} 天内到期的积分。这类积分用完即无可用账号。`,
      unlockedNotice: `已解锁永久积分：${days} 天内到期的积分用完后，会继续使用更晚到期的积分。`,
    });
  }
  return Object.freeze({
    days: null,
    lockTitle: '锁定后永久积分留着不动，只消耗每日赠送额度。今日额度用完即无可用账号。点此锁定。',
    lockedTitle: '永久积分留着不动，只消耗每日赠送额度。今日额度用完即无可用账号。点此解锁。',
    lockedNotice: '已锁定：永久积分留着不动，只消耗每日赠送额度。今日额度用完即无可用账号。',
    unlockedNotice: '已解锁永久积分：今日额度用完后，会继续使用永久积分。',
  });
}

/**
 * 归一化后端回传的窗口天数：非法值（缺省 / null / 空串 / 非数字 / 负数）
 * 回落到默认常量。
 *
 * ⚠️ 三条边界都要顾：
 * 1. **`undefined` / `null` 必须回落默认**，不能走 `Number(null) === 0` 这条路 ——
 *    面板挂载初期或 Loomy（没有窗口概念）都会给到 null，若当成 0 就渲染出
 *    「只消耗 0 天内到期的积分」这种荒谬提示。
 * 2. ⚠️ 但**数字 `0` 是合法值**（表示「没有临时积分」），不能被 `||` 静默换成
 *    默认 —— 与本仓库 `DSH_QODER_QUEUE_TIMEOUT_MS` 那条同一个坑。
 * 3. 小数按四舍五入显示（`15.6 → 16`），避免出现「15.6 天内到期」这种读不顺的文案。
 */
function normalizeWindowDays(value) {
  if (value === undefined || value === null || value === '') {
    return PERMANENT_LOCK_EXPIRING_WINDOW_DAYS;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : PERMANENT_LOCK_EXPIRING_WINDOW_DAYS;
}

/**
 * 该 provider 是否能查询积分余额。
 *
 * 为 false 时调用方**不得**发起 `credits.balances`，也不应渲染账号卡片的
 * 「积分」行与面板的「刷新积分」按钮 —— 否则卡片会永远停在「查询失败」。
 */
export function supportsCreditBalance(provider) {
  return CREDITS_CAPABILITIES[provider]?.balance === true;
}

/**
 * 该 provider 是否能执行每日签到领取（一键领取积分）。
 *
 * 为 false 时面板不渲染该按钮（WorkBuddy 国际版后端无接口）。
 */
export function supportsDailyCheckin(provider) {
  return CREDITS_CAPABILITIES[provider]?.dailyCheckin === true;
}

/**
 * 全部**支持每日签到**的渠道 id 列表，顺序固定（= 本表声明顺序）。
 *
 * 供 Jet Hub 页头的「一键签到」遍历使用。
 *
 * ⚠️ **必须从本表推导，不要另写一份渠道字面量**：
 * 本表已是能力判定的唯一真相源，且 `credits-capabilities.spec.ts` 守着它与
 * `PROVIDERS` 同步。硬编码 `['codearts','buddy',…]` 会在将来某渠道开放或
 * 下线签到时**静默漂移** —— 表现为「新渠道永远不被签到」或
 * 「对已下线渠道发必然失败的请求」（后者正是 CodeArts 历史缺陷的形态）。
 *
 * 顺序即执行顺序（调用方串行执行），故它同时决定了请求的先后；
 * 保持本表声明顺序即可，不额外排序。
 */
export function checkinProviders() {
  return Object.keys(CREDITS_CAPABILITIES).filter(supportsDailyCheckin);
}

/**
 * 该 provider 是否支持「新手任务」一次性领取。
 *
 * ⚠️ 与 {@link supportsDailyCheckin} **语义独立，不能互相推断**：
 * - `dailyCheckin`：**每天**有收益（每日额度刷新）
 * - `onboardingTasks`：**一次性**（每号只能领一次固定总额）
 *
 * 目前只有 Loomy 具备后者。为 false 时面板**不得**渲染「领取新手任务」按钮，
 * 也不得发起 `onboarding.status` / `onboarding.claim`。
 */
export function supportsOnboardingTasks(provider) {
  return CREDITS_CAPABILITIES[provider]?.onboardingTasks === true;
}

/**
 * 全部**支持新手任务**的渠道 id 列表。
 *
 * 供「一键领取全部渠道新手任务」之类的批量入口使用（当前未实现，
 * 保留以便扩展）。**必须从能力表推导**，理由同 {@link checkinProviders}。
 */
export function onboardingTaskProviders() {
  return Object.keys(CREDITS_CAPABILITIES).filter(supportsOnboardingTasks);
}

/**
 * 该 provider 是否支持「订阅额度」（官方额度窗口 + 请求记录）。
 *
 * 目前**只有 Cline**：它的网关提供按时间窗（5 小时 / 周 / 月）的订阅计量
 * 与逐笔请求流水（见 `src/cline-quota.ts`）。其余渠道是积分余额制，
 * 没有这一层窗口。
 *
 * 为 false 时面板**不得**渲染「订阅额度」按钮，也不得发起
 * `cline.quota` / `cline.requestLog` —— 服务端对非 Cline 一律 `bad-request`，
 * 无条件发请求就会在控制台留下必然失败的报错（与 CodeArts 早期
 * 「对不支持的 provider 无条件调 credits.balances」是同一类缺陷）。
 */
export function supportsSubscriptionQuota(provider) {
  return CREDITS_CAPABILITIES[provider]?.subscriptionQuota === true;
}
