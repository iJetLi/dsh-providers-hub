/**
 * 用量徽标的**纯逻辑**：显示偏好 → 模式 → 折叠态那一行文案。
 *
 * ## 为什么单独成模块（而不是写在组件里）
 *
 * `usage-badge.js` 是 React 组件，而本仓库的 node_modules 里**没有 react**
 * （它是 esbuild 的 external，由宿主注入）—— 任何 import 组件的测试都跑不起来。
 * 把「该显示什么」全部搬到本模块后，三态偏好 × 三种数据形态的**每一种组合**
 * 都能被单测逐条锁死（见 `tests/unit/badge-model.spec.ts`）。
 *
 * ## 显示优先级（用户 2026-10-03 改：**余额优先**）
 *
 * | 偏好 | 行为 |
 * |---|---|
 * | `auto`（默认） | **余额优先**；没有余额读数才依次回落到窗口、套餐 |
 * | `subscription` | 窗口优先，其次套餐，最后余额（想盯百分比的人用这个档） |
 * | `credits` | 只看余额（也是套餐判定误判时的兜底开关） |
 *
 * ## ⚠️ 为什么 `auto` 从「订阅优先」改成「余额优先」（真实报障，2026-10-03）
 *
 * 用户报障：CodeBuddy 胶囊显示「个人体验版 500 / 500积分」，而设置页里明明写着
 * **可用积分 2434.96**。两者都是真的，但**回答的不是同一个问题**：
 *
 * - 套餐读数是「某一份套餐包还剩多少 / 共有多少」——它只是余额里的一份，
 *   服务端还会下发「体验版」这类样板包；拿它当读数会**少报**可用额度；
 * - 余额读数是「这个渠道**一共**还能用多少」——这才是用户看胶囊要的答案。
 *
 * 旧口径（窗口 > 套餐 > 积分）在这种「既有套餐包又有余额」的渠道上必然少报，
 * 且**看起来像数据错误**（用户原话：「图3里显示我能用的积分足足 2436.96 呢」）。
 *
 * ⚠️ 窗口与套餐读数**没有删掉**：它们仍在浮层里（逐账号明细 / 订阅额度区），
 * 且 `subscription` 档位可以随时切回去。改的只是**折叠态默认显示哪一个**。
 *
 * ⚠️ 「订阅读数存在但内容为空」（例如账号 `ok:true` 却 `windows: []`）必须
 * **回落**到下一个候选：否则徽标会显示成 `Cline · `（只有渠道名、没有数字），
 * 比显示余额更没用。
 *
 * ⚠️ 多单位**绝不跨量纲求和**：ZCode 的额度是 token，其余是积分，两者不可折算，
 * 故按单位分组并列显示。
 *
 * ⚠️ 但**分组键必须先归一**（`normalizeUnit`）：同一个单位服务端会有多种拼法
 * （实测 `credit` / `credits` / 空串），按原值分组会把同一渠道拆成两组、
 * 渲染出 `341.78积分 · 100积分` 这种「两个一样的标签并排」的文案
 * （真实报障，2026-10-03）。详见 `credits-format.js` 文件头。
 */

import { formatUnits, formatQuota, formatQuotaLine, normalizeUnit, unitLabel, QUOTA_UNIT } from './credits-format.js';
import { quotaWindowsOf, quotaPercentValue, quotaTone } from './quota-format.js';

/**
 * 三态偏好的取值。
 *
 * ⚠️ 必须与宿主侧 `src/badge-preferences.ts` 的 `BADGE_PREFERENCES` 逐字一致
 * （`usage.badgePreference` 对非法值回 `bad-request`）。这条一致性由
 * `tests/unit/usage-badge-client.spec.ts` 直接 import 两边比对锁死。
 */
export const BADGE_PREFERENCES = Object.freeze(['auto', 'subscription', 'credits']);

/** 默认偏好（宿主侧的默认值必须与它相同）。 */
export const DEFAULT_BADGE_PREFERENCE = 'auto';

/**
 * 聚合 provider 的路由 id（必须与宿主 `src/aggregate-adapter.ts` 的
 * `AGGREGATE_PROVIDER` 逐字一致）。
 */
export const AGGREGATE_PROVIDER_ID = 'aggregate';

/**
 * 旧 auto（`jet-hub-auto`）的路由 id —— 必须与宿主 `src/auto-adapter.ts` 的
 * `AUTO_PROVIDER` 逐字一致。
 *
 * ## ⚠️ 它与 `AGGREGATE_PROVIDER_ID` 是**两个不同的 provider**，不要合并
 *
 * 两者都能「用一个模型名跨渠道选型」，但机制不同：
 * - `aggregate`：**客户端**重定向（宿主记下「上次实际转发成功的渠道」，
 *   客户端在门控前把 `aggregate` 换成那个真实渠道，见 {@link resolveBadgeProvider}）；
 * - `jet-hub-auto`：**宿主端**改写（客户端拿不到「临期胜者」，那要打全池余额接口；
 *   宿主在 `usage.badge` 里把请求改写后再查，见 `jet-hub-rpc.ts`）。
 *
 * ⇒ 前者靠**重定向**过门控，后者靠**专用分支**过门控（`usage-badge.js` 里
 * `provider === AUTO_PROVIDER_ID` 那一条）。**两条路径都不能删**：用户
 * 2026-10-08 明确要求「两个 auto 都要能用」。
 *
 * ⚠️ 上游 `ba10f4f` 重写 aggregate 时把旧 auto 的徽标支持整块删掉了
 *（宿主端 `autoActual` / 客户端那个裸字面量分支）⇒ 用户看到「也没胶囊了？」。
 */
export const AUTO_PROVIDER_ID = 'jet-hub-auto';

/**
 * 把徽标的 `provider` 解析成**实际要读哪个渠道的余额**。
 *
 * ## 为什么需要它（P3）
 *
 * `aggregate` 是**跨渠道**路由：它自己不持有账号与余额（能力表里如实登记为
 * `balance:false`）。若直接把 `aggregate` 交给徽标，门控会因它无余额能力而
 * **永不渲染**。用户要求「显示当前正在使用的 provider，和正常使用一个 provider
 * 模型一样，但是会随着聚合选中的 provider 切换」。
 *
 * ⇒ 把 `aggregate` **重定向到它上一次实际转发到的真实渠道**，再以那个渠道走
 * **原样的**读数链路（`readBadge('buddy')`）⇒ 显示的余额 / 百分比 / 倒计时 / 签到
 * 与单渠道完全一致。
 *
 * ## ⚠️ 语义是**真实历史**，不是预测
 *
 * 取宿主记录的「上次**实际**转发成功的渠道」。**不做预测**（用户明确选择）：
 * 预测的胜者可能因失败切换而实际未被使用，显示一个错的渠道比不显示更误导。
 * 故也**不用** `src/auto-adapter.ts` 的 `pickCurrentAutoProvider`
 *（它是预测语义，且要预检余额、有网络成本）。
 *
 * ## ⚠️ 无历史 ⇒ 返回 `null`（不渲染）
 *
 * 尚未发过任何请求 / 插件重启后内存清空 ⇒ 返回 `null`。调用方把它当作
 * 「没有选中模型」处理（`typeof provider !== 'string'`），**复用既有的空 provider
 * 门控形态**，不另造判据（规格 §6.6）。
 *
 * ## ⚠️ 必须在门控**之前**调用
 *
 * `usage-badge.js` 的门控逐字是 `if (!supportsCreditBalance(provider)) return null;`
 *（既有断言钉住，不得修改）。重定向必须在它**之前**完成 —— 这样门控看到的
 * `provider` 已是真实渠道，`aggregate` 就可以**诚实**登记 `balance:false`
 * 而不需要为它谎报能力。
 *
 * @param {string} provider - 徽标当前的 provider（可能来自 `state.current.provider`）
 * @param {{ provider?: string | null } | null | undefined} active
 *   宿主 `aggregate.activeProvider` 的返回值（`{ provider }` 或 null）
 * @returns {string | null} 真实渠道 id；无法解析时 `null`（= 不渲染）
 */
export function resolveBadgeProvider(provider, active) {
  if (typeof provider !== 'string' || provider.length === 0) return null;
  // 非聚合：原样返回（其余 15 家的行为**逐字不变**）。
  if (provider !== AGGREGATE_PROVIDER_ID) return provider;
  // 聚合：取上次实际转发到的渠道。
  const resolved = (typeof active === 'object' && active !== null) ? active.provider : null;
  if (typeof resolved !== 'string' || resolved.length === 0) return null;
  // ⚠️ 拒绝自指：若宿主误把 aggregate 记成真实渠道，重定向会得到它自己
  //    ⇒ 又走一遍重定向、或直接进门控被判无余额能力而消失。显式拒绝更可诊断。
  if (resolved === AGGREGATE_PROVIDER_ID) return null;
  return resolved;
}

/**
 * 折叠态里**渠道名与读数之间**的分隔符（用户 2026-10-03 定：''供应商 • 剩余积分''）。
 *
 * ⚠️ 它是一个常量而不是各处手写的字符串：完整文案（{@link badgeView} 的 `text`，
 * 供 title / aria-label 用）由 `名字 + BADGE_SEP + 读数` 拼出，而胶囊里那三段是
 * **三个独立的 span**（名字可收缩、读数不可）。两边若各写一份字形，改一处就会
 * 出现「悬浮提示写着 • 而胶囊里是 ·」这种不一致。
 */
export const BADGE_SEP = ' • ';

/**
 * 「宿主进程跑的是旧代码」的用户提示（真实故障，2026-10-02 用户报障）。
 *
 * ## 故障长什么样
 *
 * 用户在模型选择器旁看到「LobsterAI · 用量不可用」，点开弹窗里赫然写着
 * `unknown method: usage.badgePreference`。
 *
 * ## 根因不是代码，是**两侧加载时机不同**
 *
 * 宿主（Node）在**启动时**把 `lib/` 加载进内存；客户端 bundle 却是**每次请求
 * 从磁盘读**的。于是「改了代码 → 重新构建 → 刷新页面」之后，浏览器拿到了**新**
 * bundle（徽标 UI 出现了），而宿主仍在跑**旧**代码 —— `handleMethod` 落到
 * `default` 分支，回 `unknown method`。
 *
 * ⚠️ 这类失败**静默且有指向性**：用户会以为是功能坏了，实际上只需要重启一次
 * DSH。所以裸错误必须翻译成可行动的一句话（见 {@link describeBadgeError}）。
 */
export const HOST_STALE_HINT = '插件宿主未加载最新版本，请重启 DSH 后重试';

/**
 * 把 RPC 错误翻译成**用户能行动**的一句话。
 *
 * ## 两种「宿主跑旧代码」的形态（都必须翻译）
 *
 * | 形态 | 宿主的原始文案 | 触发条件 |
 * |---|---|---|
 * | 宿主**没有这个方法** | `unknown method: usage.badgePreference` | 新客户端 + 更旧的宿主 |
 * | 宿主**不认这个 provider** | `unsupported provider: jet-hub-auto` | 客户端已支持 auto 徽标、宿主还没加载该 PR |
 *
 * ⚠️ 第二种形态是 2026-10-11 复审**实测**出来的（在 master 上真跑 `usage.badge`
 * 端点取证）：新增的 `jet-hub-auto` 徽标分支让客户端会去请求一个**旧宿主不认识**
 * 的 provider，而旧宿主对它的回包正是 `unsupported provider: jet-hub-auto`。
 * 原先只认 `unknown method` ⇒ 用户看到的是这句裸技术文案，完全不知道该做什么
 * （而实际动作只有「重启 DSH」）—— 正是本常量要消灭的那类静默失败。
 *
 * ## ⚠️ 判据仍然要**窄**
 *
 * - `unknown method`：宿主 `handleMethod` 的 `default` 分支写死的文案
 *   （`src/jet-hub-rpc.ts`），改动它时本函数要同步。
 * - `unsupported provider`：`credits.balances` 查表失败时的写死文案（同上文件）。
 *   必须**带上冒号与 provider 名**才算命中吗？不需要 —— 这个短语在宿主侧只出现在
 *   「provider 未登记」这一处，不会与参数错误混淆。
 * - **不要**泛化成「含 unknown / 不支持」之类：那会把真实的参数错误也吞掉，
 *   让用户去重启一个本来就正常的宿主。
 *
 * - 其它错误**原样透出**（凭据过期、网络失败等，它们的文案本身就有指向性）；
 * - 拿不到消息时回落到调用方给的 `fallback`。
 */
export function describeBadgeError(error, fallback = '') {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message.includes('unknown method')) return HOST_STALE_HINT;
  if (message.includes('unsupported provider')) return HOST_STALE_HINT;
  return message.length > 0 ? message : fallback;
}

/**
 * 偏好的展示名（弹窗里的三态开关）。
 *
 * ⚠️ 2026-10-03 语义反转后，`auto` 与 `credits` 的含义**不再对等**：
 * - `auto` = **余额优先**（没有余额读数才回落到窗口/套餐）；
 * - `subscription` = 只看订阅（窗口 > 套餐 > 余额）；
 * - `credits` = **只看余额**（不回落到订阅 —— 它是套餐误判时的兜底开关）。
 *
 * 故 `auto` 的展示名保留「自动」（不写「优先积分」），否则三档里两档同义、
 * 用户无法从名字看出差别。真正的区别写在 title 里（见 usage-badge.js）。
 */
export const BADGE_PREFERENCE_LABELS = Object.freeze({
  auto: '自动',
  subscription: '优先订阅',
  credits: '只看积分',
});

/** 归一化偏好：未知值一律回落到默认（宿主若返回脏值，UI 不该崩）。 */
export function normalizeBadgePreference(value) {
  return BADGE_PREFERENCES.includes(value) ? value : DEFAULT_BADGE_PREFERENCE;
}

/**
 * 折叠态窗口预览：**最多两条**（优先 5 小时与本周，再多会把胶囊撑宽）。
 *
 * 排序复用设置页的「已知窗口固定顺序 + 未知窗口追加」，故两处显示顺序一致。
 * @returns `[{ type, label, percent }]`，百分比已夹取到 0–100。
 */
export function windowPreview(windows, limit = 2) {
  const list = Array.isArray(windows) ? windows : [];
  return quotaWindowsOf(list)
    .slice(0, limit)
    .map(([type, label, win]) => ({ type, label, percent: quotaPercentValue(win?.percentUsed) }));
}

/**
 * 把逐账号余额按**单位**分组求和。
 *
 * - 只有**读到数**的账号进合计（`error` 有值 → 该账号不进）；
 * - `failedCount` 单独给出，供 UI 说明「另有 N 个账号读取失败」——
 *   **不要把失败画成 0**（0 会被读成「额度用光了」）。
 *
 * ⚠️ 分组键是 {@link normalizeUnit} 的结果，**不是**包上的原始 `unit` 字符串。
 * 真实缺陷（2026-10-03）：WorkBuddy 国际版两个账号的包分别是 `unit: 'credit'` 与
 * `unit: 'credits'`（服务端同义异拼），按原值分组会把它们拆成两组，胶囊于是渲染
 * `341.78积分 · 100积分` —— 两个一模一样的「积分」标签并排，账号一多就成一长串。
 * 归一到展示口径后，**任意账号数都只产生一个数字**（`441.78积分`）。
 * 详见 `credits-format.js` 文件头。
 *
 * ⚠️ **配额单位（{@link QUOTA_UNIT}）不求和、也不显示均值**：窗口是并行的
 * 百分比，`balance.total` 只是宿主侧把两个窗口剩余比例取的平均（94.5）——
 * 上游根本没有这个数，累加更是无意义（两个账号各 50% 加起来是 100%？）。
 * 这类单位改为**逐账号列出各自的窗口行**（`quotaLines`），由
 * {@link readingOf} 原样展示。
 *
 * ⚠️ `quotaLines` / `quotaRemainings` 两个键**只在配额单位下存在**：其它单位
 * 的分组形状与改动前逐字相同（有测试直接 `toEqual` 整个分组对象）。
 *
 * @returns `{ groups: [{ unit, label, total, accountCount, quotaLines?, quotaRemainings? }], failedCount, okCount }`
 */
export function creditGroupsOf(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const byUnit = new Map();
  let failedCount = 0;
  let okCount = 0;
  for (const row of rows) {
    const balance = row?.balance;
    if (!balance || typeof balance.total !== 'number' || !Number.isFinite(balance.total)) {
      failedCount += 1;
      continue;
    }
    okCount += 1;
    // 单位从**包**上取（ZCode 是 token，其余是积分）；一个包都没有时按空串走
    // `normalizeUnit` 的默认（积分）——与账号卡片的口径一致。
    // ⚠️ 取到原值后**必须**归一：同义异拼（credit / credits / ''）不能各成一组。
    // ⚠️ 但**配额单位（{@link QUOTA_UNIT}）不参与归一**：`normalizeUnit` 只认
    // `token` 一个特例，把 `'%'` 也塞进去会得到 `'credit'`，于是
    // `unit === QUOTA_UNIT` 永远为假 —— `quotaLines` / `quotaRemainings` 两个键
    // 再也挂不上，色调也退回「均值 > 0 即绿」的老缺陷（真实回归，2026-10-03 合并时踩到）。
    const rawUnit = firstUnitOf(balance.packages) ?? '';
    const unit = rawUnit === QUOTA_UNIT ? QUOTA_UNIT : normalizeUnit(rawUnit);
    const group = byUnit.get(unit) ?? { unit, label: unitLabel(unit), total: 0, accountCount: 0 };
    group.total += balance.total;
    group.accountCount += 1;
    /**
     * 同一账号的**其他量纲**也要单独成组。
     *
     * MonkeyCode 的 `每日额度` 是 `token`，主积分是 `credit`；旧实现只取第一个
     * 包的单位（credit）并把 `balance.total` 加进 credit 组，于是每日额度在
     * 徽标/折叠态**完全看不到**（用户 2026-11-05 要求「猴子云要区分好积分余额」）。
     * 这里把非主单位的有效包按**剩余量**另开一组；不同量纲不相加。
     */
    for (const pkg of Array.isArray(balance.packages) ? balance.packages : []) {
      if (!pkg || pkg.active === false) continue
      const pkgRawUnit = typeof pkg.unit === 'string' ? pkg.unit : ''
      if (pkgRawUnit === '') continue
      const pkgUnit = pkgRawUnit === QUOTA_UNIT ? QUOTA_UNIT : normalizeUnit(pkgRawUnit)
      if (pkgUnit === unit) continue
      const remaining = Number(pkg.remaining);
      if (!Number.isFinite(remaining)) continue
      const extraGroup = byUnit.get(pkgUnit) ?? {
        unit: pkgUnit,
        label: unitLabel(pkgUnit),
        total: 0,
        accountCount: 0,
      };
      extraGroup.total += remaining;
      extraGroup.accountCount += 1;
      byUnit.set(pkgUnit, extraGroup);
    }
    if (unit === QUOTA_UNIT) {
      const line = formatQuotaLine(balance.packages, unit);
      group.quotaLines = group.quotaLines ?? [];
      group.quotaRemainings = group.quotaRemainings ?? [];
      // ⚠️ `quotaWindows` 按**窗口名**聚合（键 = 包名，值 = 该窗口跨账号的**最小**
      // 剩余百分比）。多账号时 `quotaLines` 会退化成「每个账号一行、全部拼起来」，
      // 实测两个 Gemini 账号得到 4 段：
      //   `5 小时窗口 82% · 周窗口 79% · 5 小时窗口 98% · 周窗口 98%`
      // —— 胶囊里必然被省略号截断，且同一个窗口名重复出现、读者无法比对。
      //
      // 取 **min**（最紧张的那个账号）而不是均值：与 {@link toneOf} 的判据同源
      //（它也用 `Math.min(...quotaRemainings)`）。若这里取均值，会出现
      //「圆点已报警、数字看着还挺多」的自相矛盾。
      group.quotaWindows = group.quotaWindows ?? new Map();
      if (line !== null) group.quotaLines.push(line);
      for (const pkg of Array.isArray(balance.packages) ? balance.packages : []) {
        if (!pkg) continue;
        const remaining = pkg.remaining;
        if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue;
        group.quotaRemainings.push(remaining);
        const name = pkg.name || '未命名';
        const prev = group.quotaWindows.get(name);
        if (prev === undefined || remaining < prev) group.quotaWindows.set(name, remaining);
      }
    }
    byUnit.set(unit, group);
  }
  // 顺序固定：单位名排序（通常只有一个分组；多单位时顺序稳定，避免每次渲染抖动）
  const groups = [...byUnit.values()].sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  return { groups, failedCount, okCount };
}

/**
 * 把逐账号**套餐**读数按（包名 + 单位）归组求和。
 *
 * 为什么归组而不是只取一个账号：折叠态要显示的是**这个渠道还剩多少**，
 * 多账号下「按包名汇总」才回答得了那个问题（弹窗里再逐账号列出）。
 * 排序按剩余额度降序 ⇒ 折叠态取第一条即「最大的那份套餐」。
 *
 * ⚠️ 分组键里的单位同样走 {@link normalizeUnit}：同一份套餐在不同账号上可能被
 * 服务端拼成 `credit` / `credits`，用原值当键会把**同一个包**拆成两组，
 * 于是「N 个账号合计」变成「每个账号一组」（与 `creditGroupsOf` 同款缺陷）。
 *
 * @returns `[{ name, unit, label, remaining, total, accountCount, deductionEndTime }]`
 */
export function planGroupsOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byKey = new Map();
  for (const row of list) {
    const plan = row?.plan;
    if (!plan) continue;
    const unit = normalizeUnit(typeof plan.unit === 'string' ? plan.unit : '');
    const key = `${String(plan.name)}\u0000${unit}`;
    const group = byKey.get(key) ?? {
      name: String(plan.name),
      unit,
      label: unitLabel(unit),
      remaining: 0,
      total: 0,
      totalKnown: true,
      accountCount: 0,
      deductionEndTime: undefined,
    };
    group.remaining += Number(plan.remaining) || 0;
    group.total += Number(plan.total) || 0;
    if (plan.totalKnown === false) group.totalKnown = false;
    group.accountCount += 1;
    // 取**最早**的到期时刻：多个账号同一套餐时，最该被注意的是最先作废的那份。
    const end = typeof plan.deductionEndTime === 'number' && Number.isFinite(plan.deductionEndTime)
      ? plan.deductionEndTime
      : undefined;
    if (end !== undefined && (group.deductionEndTime === undefined || end < group.deductionEndTime)) {
      group.deductionEndTime = end;
    }
    byKey.set(key, group);
  }
  return [...byKey.values()].sort((a, b) => b.remaining - a.remaining);
}

/**
 * 折叠态的完整读数：模式 + 文案 + 色调。
 *
 * @param input.providerLabel - 渠道展示名（`jet-hub.js` 的 `providerLabel()`）。
 * @param input.preference - 显示偏好（脏值会被归一化）。
 * @param input.subscription - 宿主给的订阅读数（可能缺席）。
 * @param input.accounts - 宿主给的逐账号余额（**仅启用账号**）。
 * @param input.loading - **首次读数还没回来**（`true` 时显示「读取中…」）。
 *   ⚠️ 这个入参是必需的，不是装饰：缺了它，首屏会拿空数组算出 `empty` 模式，
 *   于是徽标在读数到达前显示「未配置启用账号」——把「还没读到」说成「没有账号」，
 *   用户会以为账号丢了（真实报障，2026-10-02）。
 * @param input.failed - **首次读数失败且无任何数据**（显示「用量不可用」而不是
 *   「未配置启用账号」）：两种情况用户要做的下一步完全不同。
 * @returns `{ mode, name, detail, reading, text, tone, groups, planGroups, windows, failedCount, okCount, failureReason, incompleteNote }`
 *   - `mode`：`'loading' | 'windows' | 'plan' | 'credits' | 'empty'`（**回落之后**的实际模式）；
 *   - `name` / `detail` / `reading`：三段内容，**分开**给渲染层（见 {@link readingOf} 的说明）；
 *     恒有 `text === composeText(name, detail, reading)`；
 *   - `text`：完整一行，用于 `title` / `aria-label`；
 *   - `tone`：`'ok' | 'warn' | 'error' | 'muted'`（徽标圆点用）；
 *   - `incompleteNote`：读数**不完整**时的说明（目前只有积分合计会缺账号），
 *     空串表示完整 —— 渲染层据此决定要不要在胶囊上挂一个警示标记。
 */
export function badgeView(input) {
  const providerLabel = String(input?.providerLabel ?? 'Jet Hub');
  const preference = normalizeBadgePreference(input?.preference);
  const accounts = Array.isArray(input?.accounts) ? input.accounts : [];
  const subscription = input?.subscription;
  const loading = input?.loading === true;
  const failed = input?.failed === true;

  /**
   * 空/加载状态的统一返回（保持与成功路径同一组键，调用方不必做形状判断）。
   *
   * ⚠️ 入参是**读数**而不是整句文案：渠道名在这里补上，于是 `name` / `reading` /
   * `text` 三者**不可能**自洽不了（否则会出现「文案里有名字、`name` 是空的」
   * 这种半改状态，而胶囊只渲染 `name` + `reading`）。
   */
  const placeholder = (mode, reading, tone) => ({
    mode,
    preference,
    name: providerLabel,
    detail: '',
    reading,
    text: composeText(providerLabel, '', reading),
    tone,
    groups: [],
    planGroups: [],
    windows: [],
    failedCount: 0,
    okCount: 0,
    failureReason: '',
    incompleteNote: '',
  });

  // 首屏：读数还没到 → 明确的「读取中…」，**不要**说成「未配置启用账号」。
  if (loading) return placeholder('loading', '读取中…', 'muted');
  // 首次读数就失败（且没有任何有效数据）→ 「用量不可用」，与「没有账号」区分开。
  if (failed && accounts.length === 0) return placeholder('empty', '用量不可用', 'error');

  const { groups, failedCount, okCount } = creditGroupsOf(accounts);
  /**
   * 窗口读数取**第一个读到数的账号**（`find(ok) ?? 第一个`）。
   *
   * 为什么不做多账号汇总：窗口是「百分比 + 重置时刻」，不同账号的重置时刻不同，
   * 汇总成一个百分比没有意义（45% 和 30% 加起来是 75%？）。弹窗里逐账号列出，
   * 折叠态只给「当前会发请求的那个账号」的读数。
   */
  const windowRows = subscription?.kind === 'windows' && Array.isArray(subscription.accounts)
    ? subscription.accounts
    : [];
  const windowAccount = windowRows.find((row) => row?.ok === true) ?? windowRows[0];
  const windows = windowAccount === undefined ? [] : windowPreview(windowAccount.windows);
  const planGroups = subscription?.kind === 'plan' ? planGroupsOf(subscription.accounts) : [];

  const failureReason = firstFailureReason(accounts);

  /**
   * 模式 = 按**偏好排出的候选顺序**里第一个有内容的（见文件头的优先级表）。
   *
   * ⚠️ 用「有序候选表 + find」而不是嵌套三元：旧写法把「偏好」与「形态」两个维度
   * 揉进一个条件表达式，加一档就要重排整棵嵌套，极易把某个组合写漏
   * （旧代码里 `wantsSubscription` 一个布尔同时承担「是否看订阅」与
   * 「是否允许回落」两义）。候选表让每种偏好**一眼可读**。
   *
   * ⚠️ 每个候选都必须判「**有内容**」而不是「存在」：账号 `ok:true` 但
   * `windows: []` / 包全失效时，订阅对象是在的、内容却是空的 ——
   * 直接选中它会显示成 `Cline · `（只有渠道名，没有数字）。
   */
  const candidates = preference === 'subscription'
    ? ['windows', 'plan', 'credits']
    : preference === 'credits'
      ? ['credits']
      : ['credits', 'windows', 'plan'];
  const hasContent = {
    credits: groups.length > 0,
    windows: windows.length > 0,
    plan: planGroups.length > 0,
  };
  const mode = candidates.find((candidate) => hasContent[candidate]) ?? 'empty';

  const { detail, reading } = readingOf({ mode, windows, planGroups, groups, accounts, failedCount });

  /**
   * 「这个数字不完整」的提示（2026-10-03，用户要求：多账号时合计会**静默少报**）。
   *
   * ## 为什么只在 `credits` 模式给
   *
   * 只有积分模式读数是**跨账号的合计** —— 少读一个账号，合计就少一截，而胶囊上
   * 完全看不出来（`tone` 仍是 `ok`，弹窗脚注又在弹窗里）。账号越多越容易撞上：
   * 六个号里坏一个，用户会把「少了一截的合计」当成真实余额。
   *
   * 窗口模式按设计只显示**某一个账号**的窗口，套餐模式显示的是「最大的那份套餐」，
   * 两者都不是合计，套用「未计入合计」这句话是不准确的 —— 宁可不标，也不说错。
   *
   * ⚠️ `okCount > 0` 是必要的：一个都没读到（`okCount === 0`）时模式会回落到
   * `empty`，读数本身就是「用量不可用」，再加一句「未计入合计」纯属噪音。
   *
   * ⚠️ 文案必须说清**是什么没读到**（「余额读取失败」）而不是笼统的「有账号异常」：
   * 用户据此判断的是「这个数能不能信」，指向不明就没法判断。
   */
  const incompleteNote = mode === 'credits' && okCount > 0 && failedCount > 0
    ? `另有 ${failedCount} 个账号的余额读取失败，未计入合计`
    : '';

  return {
    mode,
    preference,
    name: providerLabel,
    detail,
    reading,
    text: composeText(providerLabel, detail, reading),
    tone: toneOf({ mode, windows, planGroups, groups, accounts }),
    groups,
    planGroups,
    windows,
    failedCount,
    okCount,
    failureReason,
    incompleteNote,
  };
}

/**
 * 把折叠态拆成**三段**：渠道名 → 可选的中段说明 → 读数。
 *
 * 名字与读数由 {@link badgeView} 直接给出，本函数只负责拼出**整句文案**（`text`），
 * 供 `title` / `aria-label` 与读屏使用。三者恒满足：
 *
 * ```
 * text === name + BADGE_SEP + (detail === '' ? '' : detail + ' ') + reading
 * ```
 *
 * ⚠️ 渲染层**不**用这个字符串，而是按同一组字段渲染成多个 span（见
 * {@link readingOf} 的说明）—— 两条路径共用同一份字段，故不可能显示成两样。
 */
function composeText(name, detail, reading) {
  const middle = detail === '' ? '' : `${detail} `;
  return `${name}${BADGE_SEP}${middle}${reading}`;
}

/**
 * 折叠态的**三段内容**（渠道名与两段读数）。
 *
 * ## 为什么把「名字」与「读数」拆开返回（真实报障，2026-10-03）
 *
 * 用户报障：胶囊显示成 `LobsterAI (有道) · 合计 …`，**后面的数字被截掉了**。
 *
 * 根因不在宽度，而在结构：原先整句是**一个** `overflow: hidden` 的 span，省略号
 * 从右往左吃 —— 而被吃掉的那一段恰恰是用户唯一想看的东西（还剩多少）。渠道名
 * 反而完整保留。故这里拆成独立字段，渲染层再给**不同的收缩权重**。
 *
 * ## 口径（用户 2026-10-03 定）
 *
 * ```
 * WorkBuddy (国际版) • 200积分
 * LobsterAI (有道) • 842.06积分
 * ```
 *
 * - 分隔符是 {@link BADGE_SEP}（` • `），不是原来的 ` · `（那个仍用于**读数内部**
 *   的多段分隔，如 `5 小时 6% · 本周 2%`）；
 * - 积分模式下**去掉「合计」**：胶囊只有一行，那个词占位却不提供信息，多账号明细
 *   与合计都在弹窗里逐条列出（节标题右侧的 `合计 ${sum}` 仍在）；
 * - 数值与单位**之间不留空格**（`200积分` 而不是 `200 积分`）—— 与用户给的
 *   样例逐字一致，也省下每个单位约 3px（胶囊按 px 计费）。
 *
 * @returns `{ detail, reading }`
 *   - `detail`：中段说明（**只有套餐模式**有值 —— 包名如 `Free Plan Subscription`；
 *     它在渲染层是**最先**被省略的那个，因为数字比包名重要）。其余模式为空串；
 *   - `reading`：真正的读数，渲染层**最后**才动它。
 */
function readingOf({ mode, windows, planGroups, groups, accounts, failedCount }) {
  if (mode === 'windows') {
    // 窗口读数分不出「说明」与「数值」：`5 小时 6%` 是一个整体，拆开会出现
    // 「5 小时」被单独留下而百分号被截的荒唐结果。故整段进 reading。
    const parts = windows.map((win) => `${win.label} ${win.percent}%`);
    return { detail: '', reading: parts.join(' · ') };
  }
  if (mode === 'plan') {
    const best = planGroups[0];
    const range = best.totalKnown === false
      ? `${formatUnits(best.remaining, best.unit) ?? '?'}`
      : `${formatUnits(best.remaining, best.unit) ?? '?'} / ${formatUnits(best.total, best.unit) ?? '?'}`;
    // ⚠️ 包名进 detail、`剩余 / 总量 + 单位` 进 reading：包名（多为
    // `Free Plan Subscription` 这类样板字）比数字长得多且信息量低。
    return { detail: best.name, reading: `${range}${best.label}` };
  }
  if (mode === 'credits') {
    /**
     * ⚠️ 配额单位（Gemini）**不显示「合计 94.50 额度」**：那 94.50 是宿主把
     * 两个窗口剩余比例取的平均值，上游根本没有这个数，而「合计」这个词又暗示
     * 可累加——配额窗口是并行百分比，没有「一共」的语义。
     * 改为逐账号列出各自的窗口行（与设置页账号卡片同一个 `formatQuotaLine`）。
     */
    const quotaGroup = groups.find((group) => group.unit === QUOTA_UNIT);
    if (quotaGroup !== undefined) {
      /**
       * ⚠️ 折叠态读数用**按窗口名聚合**的结果，不是逐账号行。
       *
       * 逐账号行（`quotaLines`）在多账号下会拼成一长串 —— 实测两个 Gemini 账号：
       *   `5 小时窗口 82% · 周窗口 79% · 5 小时窗口 98% · 周窗口 98%`
       * 胶囊里必然截断，而且同一个窗口名出现两次、读者反而没法判断「到底还剩多少」。
       *
       * 聚合后每个窗口只出现一次，取**跨账号最紧张**的那个值 —— 与圆点色调
       *（{@link toneOf} 用 `Math.min(...quotaRemainings)`）同源，不会出现
       *「点报警了但数字看着还挺多」。
       *
       * ⚠️ 单账号时结果与逐账号行**逐字相同**（聚合只有一个来源），故既有行为不变。
       * 逐账号明细仍走弹窗（`quotaLines`），那里空间足够、也不该丢账号粒度。
       */
      const windows = quotaGroup.quotaWindows;
      if (windows !== undefined && windows.size > 0) {
        const parts = [...windows.entries()]
          .map(([name, remaining]) => `${name} ${formatQuota(remaining) ?? '?'}`);
        if (parts.length > 0) return { detail: '', reading: parts.join(' · ') };
      }
      const lines = quotaGroup.quotaLines ?? [];
      if (lines.length === 0) return { detail: '', reading: '额度不可用' };
      return { detail: '', reading: lines.join(' · ') };
    }
    // `group.label` 就是 unitLabel(unit)（'积分' / 'Token'），故直接贴紧数值。
    const parts = groups.map((group) => `${formatUnits(group.total, group.unit) ?? '?'}${group.label}`);
    return { detail: '', reading: parts.join(' · ') };
  }
  // empty：区分「没有启用账号」与「全部读取失败」——两者给用户的下一步完全不同。
  return { detail: '', reading: accounts.length > 0 && failedCount > 0 ? '用量不可用' : '未配置启用账号' };
}

/** 徽标色调（圆点）。 */
function toneOf({ mode, windows, planGroups, groups, accounts }) {
  if (mode === 'windows') {
    // 取最紧张的那个窗口：任一窗口快满就该提示（与额度条同一套三档）。
    return quotaTone(Math.max(...windows.map((win) => win.percent)));
  }
  if (mode === 'plan') return planGroups[0].remaining > 0 ? 'ok' : 'warn';
  if (mode === 'credits') {
    // ⚠️ 配额单位用**最紧张的那个窗口**判色调（与 windows 模式同一套三档）：
    // 用 `group.total > 0`（均值）会把「5 小时窗口已耗尽、周窗口还剩 90%」
    // 的账号画成绿点 —— 那个 45% 的均值正好绕过告警线。
    const quotaGroup = groups.find((group) => group.unit === QUOTA_UNIT);
    if (quotaGroup !== undefined) {
      const remainings = quotaGroup.quotaRemainings ?? [];
      return remainings.length === 0 ? 'warn' : quotaTone(100 - Math.min(...remainings));
    }
    return groups.some((group) => group.total > 0) ? 'ok' : 'warn';
  }
  return accounts.length > 0 ? 'error' : 'muted';
}

/** 第一个失败原因（徽标 title / 弹窗副标题用），没有失败时返回空串。 */
function firstFailureReason(accounts) {
  for (const row of accounts) {
    if (typeof row?.error === 'string' && row.error.length > 0) return row.error;
  }
  return '';
}

/** 首个声明了单位的包的单位（与 `credits-format.js` 的口径一致）。 */
function firstUnitOf(packages) {
  if (!Array.isArray(packages)) return undefined;
  const hit = packages.find((pkg) => pkg && typeof pkg.unit === 'string' && pkg.unit.length > 0);
  return hit === undefined ? undefined : hit.unit;
}

/**
 * 积分列表的排序键：**余额大的在前，读不到数的排最后**。
 *
 * ⚠️ 读不到数的行必须排最后，不能用 0 代替：`0` 会把它们插进「余额很小」的位置，
 * 而它们那一格显示的是**错误文案** —— 夹在数字中间会被误读成一个很小的余额。
 */
function balanceOrder(row) {
  const total = row?.balance?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : Number.NEGATIVE_INFINITY;
}

/**
 * 弹窗里积分列表的**排序 + 折叠**（纯函数，2026-10-03 用户要求）。
 *
 * ## 两条规则
 *
 * 1. **按余额降序**：账号是「用完一个换下一个」的资源，用户要先看到的正是
 *    「还有哪个号能用」。原来的顺序是账号池的插入顺序，与余额无关。
 *    ⚠️ 读不到数的行排最后（见 {@link balanceOrder}）。
 * 2. **超过 `limit` 个就折叠**：6 个号本来是**十二行**（每号两行：数值 + 分桶
 *    说明），足够把弹窗撑得比窗口还高。折叠后固定 limit 行 + 一行「展开其余 N 个」。
 *
 * ⚠️ 折叠**不隐藏任何结论**：合计在节标题、读取失败数在脚注，两者都在折叠之外。
 * 收起来的只是逐账号明细 —— 那本来就是「要核对时才看」的东西。
 *
 * ⚠️ 排序必须**稳定**（`Array.prototype.sort` 在现代 JS 里已保证）：两个余额相同的
 * 账号每次渲染互换位置会让 DOM 抖动，用户会以为数字在变。
 *
 * @param rows - 逐账号余额行（`RpcCreditsBalanceAccount[]`，可能含 `balance: null`）。
 * @param options.limit - 折叠前显示的条数（`CREDITS_COLLAPSED_LIMIT`）。
 * @param options.expanded - 用户是否点了「展开」。
 * @returns `{ shown, hidden }` —— `shown` 是要渲染的那些行，`hidden` 是被收起的条数
 *   （0 表示没有可折叠的，渲染层据此决定要不要那个按钮）。
 */
export function orderCreditRows(rows, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 0;
  const copy = Array.isArray(rows) ? rows : [];
  /**
   * ## ⚠️ 双模式（用户 2026-11-10 要求）
   *
   * | 模式 | 顺序 |
   * |---|---|
   * | 未设起点（`rotationStartId` 缺席） | **积分降序**（既有行为，不变） |
   * | 设了起点 | **起点 → 其余保持传入顺序**（= 账号池顺序，体现轮换循环） |
   *
   * ### 为什么「设了起点」要改顺序
   *
   * 积分窗口与「轮换起点」下拉框在**同一个弹窗**里，用户要能对照着看。
   * 设了起点时按轮换顺序排（起点最前），用户一眼看出「下一发先用谁」。
   *
   * ### ⚠️ 默认模式**语义不变**
   *
   * 未设起点时仍是积分降序 ⇒ 既有 14 处测试**不需要改**。
   */
  const startId = options.rotationStartId;
  const ordered = typeof startId === 'string' && startId.length > 0
    ? rotateRows(copy, startId)
    : [...copy].sort((a, b) => balanceOrder(b) - balanceOrder(a));
  const hidden = Math.max(0, ordered.length - limit);
  return { shown: options.expanded === true ? ordered : ordered.slice(0, limit), hidden };
}

/**
 * 把 `startId` 对应的行**提到最前**，其余保持原相对顺序（环形）。
 *
 * ⚠️ 与选号层的 `rotateFromPreferred` **不是同义判据**：
 * - 那个排的是 `{id, expiringBalance, permanentBalance}`（服务端，要判档位可用性）；
 * - 这个排的是 `{accountId, balance}`（客户端展示行，无档位概念）。
 * 两者类型与判据都不同，且**跨进程边界**（服务端 vs 浏览器）⇒ 无法共用。
 *
 * ⚠️ 起点不在列表（账号刚被删）⇒ **原样返回**（不报错、不乱序）。
 */
function rotateRows(rows, startId) {
  const index = rows.findIndex((row) => row?.accountId === startId);
  if (index <= 0) return [...rows];
  return [...rows.slice(index), ...rows.slice(0, index)];
}

/**
 * auto 的**折叠胶囊名**：`自动 → CodeBuddy GLM-5.3-Flash x0.06 · 今日 24:00过期`。
 *
 * ## 为什么抽成纯函数
 *
 * 原先这段逻辑内联在 `usage-badge.js` 的渲染函数里，而那个文件**不能被单测 import**
 *（它 import `react`，单测环境没有）。于是既有测试只能对它做**字符串断言**
 *（`expect(BADGE).toContain('value?.autoActual')`）—— 我实测发现那类断言是
 ***恒真的假用例**：把它改成 `if (false && …)` 或 `undefined && …` 之后，
 * 正则/子串**照样命中**，用例依然全绿，而功能已经完全失效。
 *
 * ⇒ 把判定逻辑搬到这里，测试可以直接 `import` 并**行为断言**（见
 *   `auto-badge-restore.spec.ts`）。这符合本仓库既有做法：`badge-model.js`
 *   里全是纯函数，正是为了「单测环境没有 react」。
 *
 * ## 三要素（用户 2026-10-06 定，上游 ba10f4f 删掉后按原实现补回）
 *
 * 1. **在用谁**：实际渠道（短名）+ 模型名 —— 徽标是止损工具，用户原话
 *    「以为在用 A，实际在烧 B，等发现时积分已经没了」；
 * 2. **倍率**：auto 自己**没有**倍率（它是跨渠道的单一模型名，倍率取决于这次
 *    选中谁）⇒ 只能显示在这里，**不能**写进模型选择器的静态名（那个名字对所有
 *    请求都一样，写死就是编造）；
 * 3. **临期倒计时**：胜者额度何时作废。
 *
 * ## 各字段缺失时的降级（都必须能发生）
 *
 * | 情形 | 结果 |
 * |---|---|
 * | `autoActual` 缺席（非 auto 渠道 / 读数未到） | 返回 `fallback`（普通渠道名） |
 * | 倍率缺席或非有限（`Infinity` = 无标注哨兵） | 不显示倍率（**不编造**） |
 * | 倍率 `0` | 显示「免费」（本仓库既有口径） |
 * | 倒计时缺席或非有限（`Infinity` 被 JSON 序列化成 `null`） | 不显示倒计时 |
 * | 带图改道 | 追加「（图）」 |
 *
 * @param options.fallback - `autoActual` 缺席时的名字（即普通渠道展示名）。
 * @param options.autoActual - 宿主回传的 `{ provider, model, viaImageFallback }`。
 * @param options.price - 宿主回传的 `autoPrice`。
 * @param options.expiryAt - 宿主回传的 `autoExpiryAt`。
 * @param options.providerLabel - 渠道 id → 展示名（`jet-hub.js` 的 `providerLabel`）。
 * @param options.now - 当前时刻（注入以便单测；省略用 `Date.now()`）。
 * @returns 折叠胶囊的渠道名部分。
 */
export function autoBadgeName(options = {}) {
  const fallback = typeof options.fallback === 'string' ? options.fallback : '';
  const target = options.autoActual;
  // ⚠️ 必须判 `typeof === 'object'` 而不只是 truthy：宿主是**另一个进程**，
  //    字段形状不受 TS 保护（畸形值不该让整条渲染路径抛错）。
  if (typeof target !== 'object' || target === null || typeof target.provider !== 'string' || target.provider.length === 0) {
    return fallback;
  }
  const labelOf = typeof options.providerLabel === 'function' ? options.providerLabel : (id) => id;
  const shortName = shortProviderName(labelOf(target.provider)) || target.provider;
  let name = `自动 → ${shortName}${typeof target.model === 'string' && target.model.length > 0 ? ` ${target.model}` : ''}`;
  // 倍率：只有**有限**值才显示 —— `Infinity` 是「无标注」哨兵，拼出来是 `xInfinity`。
  const price = options.price;
  if (typeof price === 'number' && Number.isFinite(price)) {
    name += ` ${price === 0 ? '免费' : `x${price}`}`;
  }
  // 带图改道是**另一条路径**的决策，必须标出来，否则用户无法解释「为什么这次是这家」。
  if (target.viaImageFallback === true) name += '（图）';
  // 临期倒计时：非有限值不显示（`Infinity` 被 JSON 序列化成 `null`，
  // `new Date(null)` 是 1970 —— 一个看起来像 bug 的日期）。
  const expiryAt = options.expiryAt;
  if (typeof expiryAt === 'number' && Number.isFinite(expiryAt)) {
    const text = expiryCountdownText(expiryAt, options.now);
    if (text.length > 0) name += ` · ${text}`;
  }
  return name;
}

/**
 * 临期失效时刻 → 倒计时文案（`今日 24:00过期` / `10/9 08:30过期`）。
 *
 * ⚠️ 「今日」按**本地日历**判定，不是「24 小时内」：用户看到的是「今天几点作废」，
 * 那才是他要的决策信息（「今日」和「明天」是完全不同的紧迫度）。
 *
 * @param at - 毫秒时间戳。
 * @param now - 当前时刻（注入以便单测；省略用 `Date.now()`）。
 * @returns 文案；非有限值返回空串（调用方据此不显示）。
 */
export function expiryCountdownText(at, now = Date.now()) {
  // ⚠️⚠️ **必须显式判 `typeof at === 'number'`**，不能只靠 `Number.isFinite(d.getTime())`。
  //    真实缺陷（本用例实测抓到）：`new Date(null)` 是**合法的** 1970-01-01，
  //    `getTime()` 有限 ⇒ 只判它会让 `null` 渲染成 `1/1 08:00过期`（一个看起来
  //    像 bug 的日期）。而 `null` 正是宿主端 `Infinity` 经 JSON 序列化后的形态
  //    （`usage.badge` 只回传有限时刻，见那里的注释）⇒ 这条路径**真实可达**。
  if (typeof at !== 'number') return '';
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return `${sameDay ? '今日' : `${d.getMonth() + 1}/${d.getDate()} `}${hm}过期`;
}

/**
 * 短渠道名：去掉「Loomy (讯飞)」这类括号后缀 —— 折叠胶囊宽度有限。
 *
 * @param name - 渠道展示名。
 * @returns 去掉括号部分并 `trim` 后的名字。
 */
export function shortProviderName(name) {
  return String(name ?? '').replace(/\s*[（(][^)）]*[)）]\s*/g, '').trim();
}

/**
 * 「积分区」**节标题**的单位标签（纯函数，便于单测锁死）。
 *
 * ## ⚠️ 为什么必须有它（真实缺陷，2026-10-05 复审 PR !56 时发现）
 *
 * 弹窗的「积分区」节标题原写作 `quotaGroup === undefined ? '积分' : unitLabel(...)`
 * —— 硬编码 `'积分'` 的兜底分支**假定所有非配额渠道都是积分**，但 **ZCode 的
 * 额度单位是 token**（`src/jet-hub-rpc.ts` 的 zcode 分支如实标 `unit: 'token'`）。
 * 于是 ZCode 的浮层渲染成：
 *
 * ```
 * 积分                  ← 节标题（写死）
 *   ZCode 旅行者6665   94.54MToken   ← 同一屏里的数值（按单位走）
 * ```
 *
 * **同一屏里标题说「积分」、数值说「Token」** —— 这正是本次要修的那类
 * 「展示路径写死「积分」」缺陷的**第三个实例**（前两个：逐账号明细行、
 * 领取汇总行），也是它至今没被发现的原因：**它只在「该渠道只发 token」时显形**，
 * 而 12 个渠道里只有 ZCode 是这种形状。
 *
 * ⚠️ 判据与 `creditGroupsOf` 的**分组口径同源**（都用 `normalizeUnit` 归一后的
 * `group.unit` / `group.label`），**不要**另立一套判断：
 *  - 有配额组 → 用配额组的标签（`'额度'`，不是积分，见 §3.3）；
 *  - 否则取**第一个**单位的标签（ZCode 全是 token ⇒ `'Token'`；其余 ⇒ `'积分'`）。
 *
 * ⚠️ **取第一个而不是「所有单位都必须相同」**：混合单位的渠道在现实里不存在
 * （同一渠道的包单位语义一致，见 `badge-subscription.ts` 的注释），
 * 而 `groups` 已按 `unit` 排序（`creditGroupsOf` 末尾的 sort），
 * 故「第一个」是**确定**的，不依赖对象键序。
 *
 * @param groups - `creditGroupsOf()` 的 `groups`（已按单位归一 + 排序）。
 * @returns 节标题文字：`'额度'` / `'Token'` / `'积分'`。
 */
export function creditSectionLabel(groups) {
  const list = Array.isArray(groups) ? groups.filter((g) => g && typeof g.unit === 'string') : [];
  const quotaGroup = list.find((g) => g.unit === QUOTA_UNIT);
  if (quotaGroup !== undefined) return unitLabel(quotaGroup.unit);
  // ⚠️ 没有配额组时也**不能**硬编码「积分」—— 见上面的 ZCode 反例。
  if (list.length === 0) return unitLabel(undefined);
  return unitLabel(list[0].unit);
}

/**
 * 「更新于 2026/10/1 16:39:32」的时间戳。
 *
 * 时间戳**含日期**：宿主是长生命周期进程，只给时钟会让「昨天读的」
 * 看起来像刚刚读的。⚠️ 与设置页请求记录列用的 `formatStamp` **不同**（那个是
 * 「今天只给时钟」的表格列口径），两者用途不同故不合并。
 */
export function formatUpdatedAt(ms) {
  // ⚠️ 判据是「正数」而不是 `Number.isFinite(date.getTime())`：后者对 `undefined`
  // 会得到 `new Date(0)`（1970/1/1）并照样判为有效 —— 徽标就会显示
  // 「更新于 1970/1/1 08:00:00」。缺失时刻必须回空串，由调用方决定显示什么。
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  const at = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}
