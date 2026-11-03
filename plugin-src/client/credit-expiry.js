/**
 * 积分到期相关的**纯展示函数**（面板用）：
 *
 * - 把资源包按「距扣费截止还剩多久」分成临时 / 长期两桶；
 * - 按**池名**把当日刷新池单独显示（Loomy / Raccoon）；
 * - 生成账号名 hover 的**资源包列表**（按到期时间升序）。
 *
 * ## 为什么不缓存算出来的结果
 *
 * 分类是**当前时刻的函数**：宿主长期开着、时间只向前流，一笔距到期 15 天 30 秒
 * 的余额，用户什么都不做，半分钟后就成了临时积分。所以这里刻意做成纯函数，
 * 由渲染方在**每次渲染时**传当下的 `now` 现算 —— 不存 state、不设常驻定时器
 * （面板重新挂载 / 切 provider / 点「刷新积分」时数字本身也会重拉）。
 *
 * ## 与后端的关系
 *
 * 分桶判据的权威实现是后端 `src/buddy-balance-rank.ts` 的
 * `splitBuddyCreditsByExpiry()`（选号用它）。本文件是它的**展示侧同规则复刻**
 * —— 两者必须逐条一致，否则用户会看到「面板说还有 250 临时积分，选号却说没号可用」。
 *
 * ⚠️ 一致性由 `tests/unit/credit-expiry.spec.ts` 的**对账用例**锁死（同一组
 * fixture 喂两边、断言结果相同），不是靠"看起来一样"。
 *
 * ## 窗口天数从哪来
 *
 * 只能由**后端回传**（`credits.balances` 的 `windowDays`）：它可被
 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖。前端不得写死 15 —— 那会出现
 * 「提示说只烧 15 天内的、实际按 31 天筛号」。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 归一化窗口天数：不可用时返回 **null**（调用方据此不显示分类行）。
 *
 * ⚠️ 必须显式挡住 `null` / `undefined`，不能直接 `Number(...)`：
 * `Number(null) === 0`，而**不带 windowDays 的 provider**（它们的积分没有
 * "会不会作废"这个维度）会被当成"窗口 0 天"、在卡片上凭空渲染出一行
 * 假的「临时 0 · 长期 N」。
 *
 * 窗口实际由后端写死为 15 天（或经 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 放宽），
 * 这里只做防御性归一，不假设任何特定取值。
 */
function normalizeWindowDays(windowDays) {
  if (windowDays === undefined || windowDays === null || windowDays === '') return null;
  const parsed = Number(windowDays);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 该包距扣费截止还剩多少天；`null` = 服务端没给到期时间。
 *
 * ⚠️ 优先 `deductionEndTime`；**缺失时才回落到 `expiredTime`**（见 {@link packageExpiryMs}）。
 * 不要读 `cycleEndTime`（套餐是月度值，会把长期积分误判成快到期）。
 * 理由与实测对照见 `src/buddy-balance-rank.ts` 的文件头。
 *
 * ⚠️ **「`expiredTime` 在有效包里恒为空串」这个前提不成立**（2026-11-01 四审更正，
 * 本节初稿如此写）：`src/provider-credits.ts` 的 `buildZcodeBalance` **恒写 ISO**、
 * `src/lobsterai-credits.ts` 与 `src/astudio-credits.ts` 也写真实值 ⇒ 别因为
 * 「那个字段是空的」就去清理这条兜底。逐渠道核对结论：15 家锁定渠道里，
 * `expiredTime` 与 `deductionEndTime` 要么同源、要么恒空 ⇒ 兜底**不改变任何一家的
 * 分桶**；唯一结构性命中的是 ZCode，而 ZCode 不在 `PERMANENT_LOCK_PROVIDERS`
 * 里、也不回传 `windowDays` ⇒ 锁定语义零影响。
 *
 * ⚠️⚠️ **判据必须与 {@link packageExpiryMs} 同一份**（2026-11-01 三审：此前本函数
 * 自带一份更严格的判据，于是**同一个包**在三个出口给出三种结论）：
 *
 * | 出口 | 判据 | `deductionEndTime: "1791072000000"`（数字字符串）|
 * |---|---|---|
 * | 分桶（`splitCreditsByExpiry`）| `packageExpiryMs` | **临期** |
 * | 日期列（`formatPackageExpiry`）| `packageExpiryMs` | 正常显示日期 |
 * | 标签（本函数）| 旧的 `typeof === 'number'` | **「到期时间未知」** |
 *
 * 用户看到的是「分到临期桶、日期列也对、标签却说不知道」——三处自相矛盾。
 * 改用 `packageExpiryMs` 后三个出口同判，且顺带让 `expiredTime` 兜底的包
 * （`deductionEndTime` 缺失、`expiredTime` 有值）的标签与分桶一致。
 */
export function daysUntilExpiry(pkg, now) {
  const end = packageExpiryMs(pkg);
  if (end === null) return null;
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  return (end - at) / DAY_MS;
}

/**
 * 分成 `{ expiring, longTerm, permanent, earliestExpiringAt, earliestExpiringAmount }`
 * **三桶**（本计费周期口径）。
 *
 * ## 三档语义（用户 2026-10-12 明确要求）
 *
 * | 桶 | 判据 | 颜色 |
 * |---|---|---|
 * | `permanent` | **服务端没给到期时间**（真·永久，如订阅套餐包） | 绿（`ok`） |
 * | `longTerm` | 有到期时间，但**超出**窗口（还早，不急） | 黄（`warn`） |
 * | `expiring` | 有到期时间且在**窗口内**（再不用就作废） | 红（`error`）+ 倒计时 |
 *
 * ⚠️ **`permanent` 与 `longTerm` 必须分开**：首版把「到期时间未知」与「到期还远」
 * 合成一个 `permanent` 桶 —— 那会让「真永久」的积分和「30 天后到期」的积分
 * 显示成同一个颜色，用户无法分辨哪些是永远不会作废的。两桶的**选号行为相同**
 *（都不算临时），但**展示语义不同**。
 *
 * ⚠️ **返回里 `expiring` 与 `earliestExpiringAmount` 是两个不同的量**（2026-10-20）：
 *   - `expiring` = 窗口内**所有**临期批次之和（「共多少会作废」）；
 *   - `earliestExpiringAmount` = **最早那批**的量（与倒计时 `earliestExpiringAt` 配对）。
 *
 *   并排显示时必须用后者，否则「临期 20856（4 天 20 小时）」会被读成
 *   「这 20856 会在 4 天 20 小时后一起掉」，而实际只有最早那批 19656 会掉
 *   （用户 2026-10-20 原话：「怎么可能全都同一天到期」）。
 *
 * @param packages - `credits.balances` 带回来的 `balance.packages`。
 * @param windowDays - 后端回传的窗口天数。
 * @param now - **当前时刻**（渲染时传 `Date.now()`，不要传缓存值）。
 * @returns 窗口不可用时返回 `null`（调用方退化成不显示分类）。
 */
export function splitCreditsByExpiry(packages, windowDays, now) {
  const days = normalizeWindowDays(windowDays);
  if (days === null || !Array.isArray(packages)) return null;
  const windowMs = days * DAY_MS;
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  let expiring = 0;
  /**
   * **已经作废**的额度（`deductionEndTime <= now` 但 `active` 仍为 true）。
   *
   * ⚠️⚠️ **独立一桶，不再计入 `expiring`**（2026-11-02，对抗审计 B1 后修正）。
   *
   * 第一版（同一天的 `7a567d4`）把它留在 `expiring` 里、只让**展示层**减掉，
   * 理由是「三档合计 === total 的守恒」与「与聚合/后端同判」。审计打穿了这个理由：
   * 后端 `splitBuddyCreditsByExpiry` 与聚合 `sharedPackageExpiry` 当时同样把它算
   * 可用 ⇒ 面板说「已过期 7」而**选号判它可用、聚合把它排第一先烧** ⇒
   * 从「说法含糊」升级成「面板与行为相反」。⇒ 现在**三处同时修**，判据一致：
   *
   * | 层 | 判据 |
   * |---|---|
   * | 前端（本函数） | `end <= now` ⇒ `expired` 桶，不进 `expiring` |
   * | 后端 `splitBuddyCreditsByExpiry` | 同上（`expired` 可选键 + 不计 `expiring`）|
   * | 聚合 `sharedPackageExpiry` / `magicrewExpiry` | `end <= now` 不参与 `earliest`、且不算「有可用额度」|
   *
   * 守恒随之变成**四段**：`permanent + longTerm + expiring + expired === total`
   * （用户照样能加平，只是第 4 段的名字叫「已过期」）。
   *
   * 可达性：TRAE / Qoder 的 `active` 是**硬编码 true**（`trae-credits.ts`），
   * 从不反映是否过期 —— 所以这类包**一定会**出现，不是理论值。
   */
  let expired = 0;
  let longTerm = 0;
  let permanent = 0;
  /** 临期桶里**最早**的作废时刻（倒计时用）；无临期包时 `null`。 */
  let earliestExpiringAt = null;
  /**
   * **最早那批到期时刻对应的量**。
   *
   * ⚠️ 为什么需要它（2026-10-20 用户报障「怎么可能全都同一天到期」）：
   *    原实现把**窗口内所有批次**累加成 `expiring`，而倒计时
   *    `earliestExpiringAt` 只指向**最早**那一批 ⇒ 显示成
   *    「临期 20856（4 天 20 小时）」会让用户以为**这 20856 会在 4 天 20 小时后
   *    一起掉**，实际最早那批只有 19656，其余 1200 分别在 6 天 / 7 天后。
   *
   *    ⇒ 临期段的数字必须与倒计时**指向同一批**才自洽：
   *      「临期 19656（4 天 20 小时）」= 这笔会在 4 天 20 小时后作废。
   *      其余更晚的临期批次仍计入 `expiring`（总量，供 tooltip 用），
   *      但**不**与倒计时并排显示 —— 那正是误导的来源。
   */
  let earliestExpiringAmount = 0;
  /**
   * **独立池**的剩余量（`> 0` 时才填）。
   *
   * ⚠️ 为什么单独摘出来（2026-10-21 用户报障「没标注星火专属」）：
   *    本家（AStudio）服务端给**两个互不相通**的池 —— 主池（会员/购买/赠送）
   *    与星火池。星火那 25000 混进 `permanent` 桶后，主行只显示「永久 25000」，
   *    用户会以为那是**能随便用的通用积分**，而它其实只能用于特定场景。
   *    「能不能通用」这个信息只存在于**池名**里（`buildAstudioBalance` 起的名字
   *    就叫「星火积分（独立池，不参与主池合计）」），而分桶按金额聚合、天然丢池名。
   *
   * ⚠️ 判据是**池名含「独立池」**，不是 provider 白名单：那个名字由
   *    `src/astudio-credits.ts` 单一持有（上游自己写明了「不参与主池合计」），
   *    认名字就不必为本仓每一种多池渠道各加一个分支。
   */
  let exclusivePoolRemaining = 0;
  for (const pkg of packages) {
    // 失效包跳过：服务端仍会返回它的余额，但那部分扣不到。
    if (!pkg || pkg.active !== true) continue;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    // ⚠️⚠️ 必须走 {@link packageExpiryMs}（`deductionEndTime` > `expiredTime` 兜底），
    //    不能直接读 `pkg.deductionEndTime` —— 本仓红线「同一语义不得两套判据」：
    //    AStudio 的包**只给 `expiredTime`**（字符串，未归一化），直读会让全部包
    //    落进 `permanent` 桶 ⇒ astudio 的分桶行整条不渲染（用户报障：
    //    「25000 星火积分不显示」）。而 `formatPackageExpiry` / 包列表**排序**
    //    早就走 packageExpiryMs，两边不一致会出现「显示说 11/01 到期、分桶说永久」。
    // ⚠️ 独立池**先摘出再分桶**：它不参与三档中的任何一档（否则「永久 25000」
    //    会被读成通用积分）。顺序必须在分桶之前 —— 摘出来后仍要 `continue`。
    if (isExclusivePool(pkg)) {
      exclusivePoolRemaining += remaining;
      continue;
    }
    const end = packageExpiryMs(pkg);
    const known = end !== null;
    if (!known) {
      /**
       * 服务端没给到期时间 ⇒ 默认是**真·永久**（保守方向：宁可少用，
       * 不可误烧长期积分）。
       *
       * ⚠️ **但 CodeArts 的赠送包是例外**（2026-10-20）：它没有逐笔到期
       * 时刻，上游只在该分类 metric 上给一个「其中 N 即将到期」的标量。
       * 那个标量被解析到 `pkg.expiringRemaining` ⇒ 拆开算：
       *
       * ```
       * 临期桶 += expiringRemaining
       * 永久桶 += remaining - expiringRemaining
       * ```
       *
       * 不拆的话，那 25000 分（含 2000 快作废的）会整包进永久桶，卡片上
       * 「永久 25000」与「另有 2000 即将到期」同时出现、互相矛盾
       * （用户 2026-10-20 报障：「2000+500临期不应该是2500嘛」）。
       *
       * ⚠️ 这类包**没有倒计时**（上游不给日期，绝不编一个）⇒ 不参与
       * `earliestExpiringAt` 的选取。
       */
      const expiringPart = Number(pkg.expiringRemaining);
      const hasExpiring = Number.isFinite(expiringPart) && expiringPart > 0;
      if (hasExpiring) {
        const capped = Math.min(expiringPart, remaining);
        expiring += capped;
        permanent += remaining - capped;
      } else {
        permanent += remaining;
      }
      continue;
    }
    if (end <= at) {
      // 已作废（但 active 仍 true）⇒ 单独一桶：这些额度**扣不到**。
      expired += remaining;
      continue;
    }
    if (end - at < windowMs) {
      expiring += remaining;
      // ⚠️⚠️ **必须排除已过期的包**（2026-10-13 审计修正）：这里取的是临期桶里
      //    **最早**的作废时刻用于倒计时，而 `end` 若不约束 `> at`，那么
      //    「一个已过期但 `active` 仍为 true 的包」会**恒定当选**（它比任何
      //    未来时刻都早）⇒ `expiryCountdown` 拿到过去时刻、返回空串 ⇒
      //    **整段倒计时消失**，尽管桶里还有一笔钱几天后作废。
      //    ⚠️ 可达性不是假设：TRAE 的 `active` 是**硬编码 true**
      //    （`trae-credits.ts`），压根不反映是否过期。
      //    方向：宁可少显示倒计时，不可显示一个错的。
      if (end > at && (earliestExpiringAt === null || end < earliestExpiringAt)) {
        // ⚠️ 出现**更早**的批次 ⇒ 该量取代之前的（两批不是同一批，不能相加）。
        earliestExpiringAt = end;
        earliestExpiringAmount = remaining;
      } else if (end > at && end === earliestExpiringAt) {
        // 同一批次（同刻并列）⇒ 累加。
        earliestExpiringAmount += remaining;
      }
    } else {
      longTerm += remaining;
    }
  }
  // ⚠️ `expired` 只在**有已作废额度时**才出现（与 `modelRateLimits` 那类「无值即不写键」
  //    同款式）：否则每个调用方都要为「多一个恒 0 的键」改断言，而它对 0 值毫无信息量。
  return { expiring, ...(expired > 0 ? { expired } : {}), longTerm, permanent, earliestExpiringAt, earliestExpiringAmount, exclusivePoolRemaining };
}

/** 这个包属于哪一桶的中文标签（tooltip 前缀用）。 */
export function expiryBucketLabel(pkg, windowDays, now) {
  const days = normalizeWindowDays(windowDays);
  const left = daysUntilExpiry(pkg, now);
  if (left === null) return '到期时间未知';
  /**
   * ⚠️ **已过期要先判**（2026-11-01 三审实测）：`active: true` 但到期时刻已过的包
   * 会走到这里（`jet-hub.js` 的 `all = balance?.packages || []` **不过滤**），
   * 而旧实现直接 `${Math.ceil(left)} 天内到期` ⇒ 渲染出 **「-3 天内到期」**，
   * `-0.5 天` 更会因 `Math.ceil` 变成「0 天内到期」。
   * 顺序不能反：先判「未知」，再判「已过期」，最后才按窗口分档（否则已过期的包
   * 在窗口为 null 时仍返回 null、整行不渲染，把已过期的包藏起来）。
   */
  if (left <= 0) return '已过期';
  if (days === null) return null;
  return left < days ? `${Math.ceil(left)} 天内到期` : `还有 ${Math.ceil(left)} 天`;
}

/**
 * tooltip 里每个包那一行的到期提示后缀。
 *
 * ⚠️ 拿不到窗口天数时也要给出「距到期 N 天」—— 它本身就解释了分类依据，
 * 比只显示一个 `CycleEndTime` 更可读（套餐的周期结束时间与积分有效期不是一回事）。
 */
export function formatExpiryHint(pkg, windowDays, now) {
  const left = daysUntilExpiry(pkg, now);
  if (left === null) return '';
  /**
   * ⚠️⚠️ **已过期必须在这里就截住**（2026-11-01 四审）：`expiryBucketLabel` 修好
   * 「已过期」之后，本函数仍会拼出 **「距到期 -3 天（已过期）」** —— 同一个字符串里
   * 一半修好一半没修，比全错更难看；`Math.ceil(-0.5) = -0` 还会变成
   * 「距到期 0 天（已过期）」。
   * ⇒ 「还有几天到期」这个语义只在**未过期**时成立，已过期就直接回「已过期」。
   */
  if (left <= 0) return '已过期';
  const days = Math.ceil(left);
  const label = expiryBucketLabel(pkg, windowDays, now);
  return label ? `距到期 ${days} 天（${label}）` : `距到期 ${days} 天`;
}

/**
 * 账号卡片上那行「永久 Y · 长期 Z · 临期 X」的文案；无有效分类时返回 null。
 *
 * ⚠️ **三档顺序固定：永久 → 长期 → 临期**（用户 2026-10-12 定）：
 * 与「余额由远及近」的直觉一致，且临期放最后便于一眼扫到。
 *
 * ⚠️ 用词「长期」不是「永久」（用户 2026-09-29 定）：有到期日的积分即使很远
 * 也不能叫永久 —— 说「永久」是错的（用户明确纠正过）。只有**服务端没给
 * 到期时间**的才是真·永久。
 *
 * @param split - `splitCreditsByExpiry` 的返回值。
 * @param format - 数值格式化函数（按单位）。
 * @returns 单行文本；全为 0 或不可分类时返回 `null`。
 */
export function formatExpirySplitLine(split, format) {
  if (!split) return null;
  const parts = [];
  // 只显示**非零**桶：0 值进文案只会让一行变长而无信息（用户看不到「永久 0」的价值）。
  const permanent = split.permanent > 0 ? format(split.permanent) : null;
  const longTerm = split.longTerm > 0 ? format(split.longTerm) : null;
  // ⚠️ `expiring` 已由 `splitCreditsByExpiry` 排除掉已作废部分（2026-11-02），
  //    这里直接用；「已过期」是独立的第 4 段。
  const expiredAmount = Number.isFinite(split.expired) && split.expired > 0 ? split.expired : 0;
  const expiring = split.expiring > 0 ? format(split.expiring) : null;
  const expired = expiredAmount > 0 ? format(expiredAmount) : null;
  if (permanent !== null) parts.push(`永久 ${permanent}`);
  if (longTerm !== null) parts.push(`长期 ${longTerm}`);
  if (expiring !== null) parts.push(`临期 ${expiring}`);
  if (expired !== null) parts.push(`已过期 ${expired}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * 三档分桶的**带色分段**（供胶囊/卡片逐段渲染，各带各的 tone）。
 *
 * ## 为什么需要它（而不是复用 `formatExpirySplitLine` 的字符串）
 *
 * 字符串版本把三档拼成一句、只能整体一个颜色 —— 而用户要的正是
 * 「永久绿 / 长期黄 / 临期红」（2026-10-12 明确要求）。React 侧要逐段渲染
 * 才能各带 `data-tone`，故这里返回**结构化分段**。
 *
 * 临期段额外带**倒计时**（`倒计时` 字段），因为「临期 100」只说了有多少会作废，
 * 没说**还有多久** —— 而那正是要补的决策信息。
 *
 * @returns `[{ key, text, tone, countdown? }]`；无内容时 `[]`。
 *   `tone` 取值限定在 CSS 里已有的 `ok` / `warn` / `error`。
 */
export function expirySplitParts(split, format, now) {
  if (!split) return [];
  const parts = [];
  const permanent = split.permanent > 0 ? format(split.permanent) : null;
  const longTerm = split.longTerm > 0 ? format(split.longTerm) : null;
  // ⚠️ 数值与格式化文本分成两个变量：临期段要用**数值**做比较
  //    （`earliestAmount < expiringAmount`）。拿格式化后的字符串做 `<`
  //    依赖隐式转换 —— 一旦 `format` 带上千分位（`"3,500"` → `NaN`）就静默出错。
  // 已作废额度单独成段（`splitCreditsByExpiry` 已把它从 `expiring` 里摘出）。
  const expiredAmount = Number.isFinite(split.expired) && split.expired > 0 ? split.expired : 0;
  const expiringAmount = split.expiring > 0 ? split.expiring : 0;
  const expiring = expiringAmount > 0 ? format(expiringAmount) : null;
  const expiredText = expiredAmount > 0 ? format(expiredAmount) : null;
  if (permanent !== null) parts.push({ key: 'permanent', text: `永久 ${permanent}`, tone: 'ok' });
  if (longTerm !== null) parts.push({ key: 'longTerm', text: `长期 ${longTerm}`, tone: 'warn' });
  if (expiring !== null) {
    const at = split.earliestExpiringAt;
    const countdown = typeof at === 'number' && Number.isFinite(at) && at > 0
      ? expiryCountdown(at, now)
      : '';
    /**
     * ★ **临期段的数字必须是 `expiring` 总额，不能只取「最早那批」**
     *   （2026-10-21 用户报障：CodeArts 卡片显示
     *   `积分 25500 / 永久 22000 · 临期 500（5 天 20 小时）`，
     *   22000 + 500 = 22500 ≠ 25500，**差的 3000 在任何地方都没出现**）。
     *
     * ## 那个 3000 是什么
     *
     * 真实数据（`CODEARTS_ACCOUNT_A3294816`，`GET /snap-manager/v1/statistics/plugin`）：
     *
     * | 包 | remaining | `deductionEndTime` | `expiringRemaining` |
     * |---|---|---|---|
     * | 基础积分包 | 500 | 1793059200000（10-27） | — |
     * | 赠送积分包 | 25000 | **无** | **3000** |
     *
     * ⇒ `expiring` = 500 + 3000 = **3500**，`permanent` = 25000 - 3000 = 22000，
     *   合计 25500 = `total`（这是 `0dd86f8` 立的硬不变量）。
     *
     * 但 `earliestExpiringAmount` 只统计**带 `deductionEndTime`** 的那批
     * （设计使然：它要与倒计时 `earliestExpiringAt` 配对），而赠送包那 3000
     * **没有日期**、不参与倒计时 ⇒ 它没被算进去。
     *
     * ## 修复方向：数字用总额，倒计时降级成「其中」限定语
     *
     * 上一版为了修「临期 20856（4 天 20 小时）让用户以为全部同时到期」
     * （2026-10-20 报障），直接把数字换成「最早那批」—— 这修了误读，
     * 却**引入了数字丢失**：三档不再等于 `total`，用户一算就发现少了。
     *
     * ⇒ 两个约束同时满足的唯一形态：数字 = 总额（合计守恒），
     *   倒计时明确限定它只覆盖其中一部分：
     *
     * ```
     * 临期 3500（其中 500 于 5 天 20 小时后到期）   ← 混合批次
     * 临期 3500（5 天 20 小时）                    ← 倒计时覆盖全部临期时
     * 临期 3000                                    ← 全无日期（不编造倒计时）
     * ```
     *
     * ⚠️ 「其中」只在**倒计时那批量 < 临期总额**时出现 —— 否则
     *    「其中 3500 于…」里的「其中」是废话（它本来就是全部）。
     */
    const earliestAmount = Number.isFinite(split.earliestExpiringAmount) && split.earliestExpiringAmount > 0
      ? split.earliestExpiringAmount
      : 0;
    // 倒计时那批没覆盖全部临期（含「完全无日期的批次」）⇒ 必须限定。
    const partial = earliestAmount > 0 && earliestAmount < expiringAmount;
    const countdownText = countdown.length === 0
      ? ''
      : partial ? `其中 ${format(earliestAmount)} 于 ${countdown}后到期` : countdown;
    parts.push({
      key: 'expiring',
      text: `临期 ${expiring}`,
      tone: 'error',
      ...(countdownText.length > 0 ? { countdown: countdownText } : {}),
    });
  }
  /**
   * ★ 「已过期」单列一段（2026-11-02）。
   *
   * 这些额度**已经扣不到了**，但 `active` 仍是 true（TRAE / Qoder 硬编码），
   * 所以它们会一直出现在 `packages` 里。旧实现把它们混进「临期」⇒ 面板写
   * 「临期 7」却没有倒计时（`earliestExpiringAt` 只取未来时刻），
   * 而同一个包的标签写「已过期」—— 一条数据两个说法。
   *
   * tone 用 `warn` 而不是 `error`：它已经作废，不需要抢「马上要作废」的红色注意力。
   */
  if (expiredText !== null) {
    parts.push({ key: 'expired', text: `已过期 ${expiredText}`, tone: 'warn' });
  }
  return parts;
}

/**
 * 临期积分的**粗粒度**倒计时（「3 天 4 小时」/「5 小时 20 分钟」/「9 分钟」）。
 *
 * ⚠️ 粗粒度是刻意的：这是一眼扫过的信息，秒级精度只会让面板无谓重渲染。
 * ⚠️ 已过期 / 不可解析返回**空串**（调用方不渲染倒计时，而不是显示「已过期」）。
 */
export function expiryCountdown(expiresAtMs, now) {
  const at = Number(expiresAtMs);
  if (!Number.isFinite(at) || at <= 0) return '';
  const ref = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  // ⚠️ 已过期与「还没过期」必须分道：前者返回空串（调用方不渲染）。
  if (at <= ref) return '';
  // ⚠️⚠️ **用向上取整而不是 `Math.round`**（2026-10-13 审计修正）：
  //    round 会把「剩余 0~30 秒」也归到 0，于是用户看到倒计时一路数到
  //    「1 分钟」后**整段突然消失** —— 而「马上就作废」恰恰是最该看到的信号。
  //    向上取整让「还没过期」恒定至少显示 1 分钟。
  const minutes = Math.ceil((at - ref) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${mins} 分钟`;
  return `${mins} 分钟`;
}

/**
 * **当日刷新池**的已知池名（服务端下发或我们合成的）。
 *
 * ## 为什么需要这份名单
 *
 * Loomy 与 Raccoon 的积分都由**多个语义不同的池**构成，其中有一个是
 * **当日刷新**的（今天不用就没了）：
 *
 * | provider | 当日池 | 其余池 |
 * |---|---|---|
 * | Loomy | `每日赠送`（每天 5000，消耗后不回补） | `永久积分`（注册奖励 + 新手任务） |
 * | Raccoon | `每日积分`（`daily_points`） | `奖励积分` / `会员积分` / `充值积分` |
 *
 * 只显示合计会丢掉最关键的信息：**今天有多少会作废**。用户明确要求
 * 「有当日积分，那应该按照 loomy 那样显示」（2026-09-29）。
 *
 * ⚠️ 用**名字**识别而不是下标：Raccoon 的池是按「服务端给了哪个字段」动态
 * push 的（`daily_points` 缺失时就没有这一项），下标会错位。
 */
export const DAILY_POOL_NAMES = ['每日赠送', '每日积分'];

/**
 * 找出当日刷新池；没有则返回 null（调用方据此不渲染分池行）。
 *
 * @param packages - `balance.packages`。
 */
export function findDailyPool(packages) {
  if (!Array.isArray(packages)) return null;
  return packages.find(pkg => pkg && DAILY_POOL_NAMES.includes(pkg.name)) ?? null;
}

/**
 * 「长期 Y · 每日 X」—— 当日池单独显示，其余池求和。
 *
 * 与 {@link formatExpirySplitLine} 的区别：那个按**到期时间**分桶（buddy / TRAE
 * 的包带 `deductionEndTime`），这个按**池名**分（Loomy / Raccoon 的池没有到期
 * 字段，是服务端按语义分开下发的）。两者互斥：一个 provider 只走其中一条。
 *
 * ⚠️ 当日池用**自己的** remaining，不用求和 —— 它就是单独一池。
 * ⚠️ 其余池求和时跳过失效包（那部分扣不到），与 `splitCreditsByExpiry` 同口径。
 *
 * @param packages - `balance.packages`。
 * @param format - 数字格式化（与卡片总额同一个 `formatCredits`）。
 * @param longTermLabel - 非当日池的标签。Loomy 用「永久」（它的池就叫永久积分），
 *   Raccoon 用「长期」（奖励/会员/充值三种池的到期规则各不相同，不能统称永久）。
 * @returns 文案；没有当日池时返回 null。
 */
export function formatPoolSplitLine(packages, format, longTermLabel = '长期') {
  const daily = findDailyPool(packages);
  if (daily === null) return null;
  const restSum = packages.reduce((sum, pkg) => {
    if (!pkg || pkg === daily) return sum;
    if (pkg.active !== true) return sum;
    const remaining = Number(pkg.remaining);
    return Number.isFinite(remaining) && remaining > 0 ? sum + remaining : sum;
  }, 0);
  const dailyValue = format(Number(daily.remaining) || 0);
  const restValue = format(restSum);
  if (dailyValue === null || restValue === null) return null;
  return `${longTermLabel} ${restValue} · 每日 ${dailyValue}`;
}

/**
 * **逐命名池全列** —— 供 Accio 的三类桶使用（用户 2026-10-13 要求与 Loomy 同形）。
 *
 * ## 与 {@link formatPoolSplitLine} 的区别（为什么不能复用它）
 *
 * `formatPoolSplitLine` 是**两桶**形状：它把「当日池之外的**全部**池」求和成一个
 * `longTermLabel`（`'长期 2100 · 每日 500'`）。那对两家的形态成立：
 *
 * | provider | 池 |
 * |---|---|
 * | Loomy | `永久积分` + `每日赠送` |
 * | Raccoon | `奖励积分` / `会员积分` / `充值积分` + `每日积分` |
 *
 * 而 Accio 的桶是**三类语义并列**（`每日积分` / `每月积分` / `推荐积分`）：
 * 「每月」与「推荐」**都不该被笼统求和成「长期」** —— 它们的到期规则不同
 * （每月有 `nextBillingDate`、推荐是活动赠送），求和会让用户以为是一份东西。
 *
 * ## 为什么按**服务端下发的顺序**列出，不排序
 *
 * 池的顺序由宿主 `flattenAccioCredits` 决定（`daily` → `monthly` → `referral`，
 * 即「最先作废的在前」）。前端再排一次就是「同一语义两处判据」——排序规则
 * 一变就会与宿主的意图分叉。
 *
 * ⚠️ **不改 `formatPoolSplitLine`**：它的输出是既有契约（见 `credit-expiry.spec.ts`
 * 那组逐字断言），而 loomy / raccoon 走的正是它。
 *
 * @param packages - `balance.packages`。⚠️ 按**池名**识别，不用下标
 *   （Raccoon / Accio 的池都可能缺项）。
 * @param format - 数字格式化（与卡片总额同一个）。
 * @returns 形如 `'每日 199 · 每月 0 · 推荐 0'` 的文案；无可列池或格式化失败时
 *   返回 `null`（调用方据此不渲染该行，退回别的分桶）。
 */
export function formatNamedPoolLine(packages, format) {
  if (!Array.isArray(packages)) return null;
  const parts = [];
  for (const pkg of packages) {
    // 失效包不列出：扣不到的额度显示出来会让用户以为还有。
    if (!pkg || pkg.active !== true) continue;
    const name = typeof pkg.name === 'string' ? pkg.name.trim() : '';
    if (name === '') continue;
    const value = format(Number(pkg.remaining) || 0);
    // ⚠️ 任一格式化失败 ⇒ 整个函数返回 null（不产出半截文案）。
    if (value === null) return null;
    // 「每日积分 199」在版面上重复且长 ⇒ 去掉「积分」后缀做短标签。
    // ⚠️ 只在**后缀**时去掉（`'积分商城'` 这类名字不受影响）。
    const short = name.endsWith('积分') ? name.slice(0, -2) : name;
    parts.push(`${short} ${value}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * 这个包是不是**独立池**（不参与主池合计）。
 *
 * ⚠️ 判据是池名含「独立池」—— 该名字由 `src/astudio-credits.ts` 的
 * `buildAstudioBalance` 单一持有（上游原话「独立池，不参与主池合计」）。
 * 认名字而不是 provider 白名单：将来别家也有独立池时，只要后端照这个口径
 * 命名就自动生效，不必为每家加分支。
 *
 * @param pkg - 资源包。
 * @returns 是独立池则为 `true`。
 */
export function isExclusivePool(pkg) {
  const name = pkg && typeof pkg.name === 'string' ? pkg.name : '';
  return name.includes('独立池');
}

/**
 * 独立池的剩余量（`> 0` 时才值。
 *
 * ## ⚠⚠⚠ 为什么要单独抽出一个函数（2026-10-21 合并审计发现）
 *
 * * 三处同义（前端 `splitCreditsByExpiry`、设置页 `CreditBalanceRow`、
 * *   徽标弹窗 `splitParts`）各写了一份独立池的汇总，而判据很接近但**不完全相同**：
 * *   `split` 用 `pkg.active === true` 且跳过 `remaining <= 0`；
 * *   两处渲染用 `pkg.active !== false`（一个 `undefined` 就算有效）且**不过滤负余额**
 * *   （autoclaw 的冲正 / 退款会下发负数）。
 * * 
 * * ⚠ 实测：`packages: [{active:undefined, remaining:-5}, {active:true, remaining:100}]`
 * *   → `split.exclusivePoolRemaining` = 100，而两处渲染的 reduce = 95 → **同一屏上两个数**。
 * *
 * * ⇒ 本函数是**唯一一份判据**；三处都调它 ⇒ 不可能再分开。
 * *
 * * ## 为什么不直接用 `split.exclusivePoolRemaining`
 * *
 * * `split` **可能为 `null`**（无 `windowDays` 时整体返回 `null`）⇒ 独立池段会整段不渲染。
 * * ⇒ 独立池的显示**不应该被窗口天数带走** ⇒ 本函数独立计算。
 * *
 * * @param packages - `balance.packages`
 * * @returns 独立池的剩余量（非正数归 0）。
 * */
export function exclusivePoolRemainingOf(packages) {
  if (!Array.isArray(packages)) return 0;
  let sum = 0;
  for (const pkg of packages) {
    // ⚠ 判据与 `splitCreditsByExpiry` 的循环**逐格同款**：
    // `active === true`（不是 `!== false`）且 `remaining > 0`。
    if (!pkg || pkg.active !== true) continue;
    if (!isExclusivePool(pkg)) continue;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    sum += remaining;
  }
  return sum;
}

/**
 * 取出包的到期时刻（毫秒）；**拿不到返回 null**（= 没有到期概念）。
 *
 * ⚠️ 这是 `formatPackageExpiry` 与包列表**排序**共用的唯一判据来源 ——
 * 两处必须用同一个值，否则会出现「显示说 9/30 到期、排序却按别的字段排」。
 *
 * 来源优先序：`deductionEndTime`（毫秒，各 provider 后端已归一化）>
 * `expiredTime`（字符串，如 "2026-11-01 00:00:00"，给未归一化的包兜底）。
 *
 * ## ⚠️⚠️ **架构性缺口（2026-10-21 第二轮审计登记，未修）**：`expiredTime` 兜底**不认哨兵**
 *
 * `deductionEndTime` 那条由**各个后端**在写入前过滤永久哨兵（Qoder 的
 * `isPermanentSentinelMs`、codearts 的「有 `deductionEndTime` 就不写 `expiredTime`」），
 * 但**本函数自己的 `expiredTime` 兜底路径没有任何哨兵判据**。实测后果：
 * ```
 * { expiredTime: '9999-12-31T00:00:00.000Z' }
 *   → packageExpiryMs    = 253402214400000
 *   → formatPackageExpiry = "9999-12-31（2912150 天后）"
 * ```
 * 而**目前仍有多个渠道会把上游字符串原样透传到 `expiredTime`**（2026-10-21 全仓清点，
 * `grep 'expiredTime:'` 后逐格判断「是否来自已归一的 `deductionEndTime`」）：
 *
 * | 来源 | 是否可能带哨兵 |
 * |---|---|
 * | `astudio-credits.ts` **星火池**（`readAstudioLocalTime(...)`） | ✅ 上游原样串 |
 * | `lobsterai-credits.ts`（`expiredTime: expiresAt`） | ✅ 上游原样串 |
 * | `jet-hub-rpc.ts`（officeace 的 `group.expiresAt`） | ✅ 上游原样串 |
 * | `provider-credits.ts` 两处（`bucket.expiresAt` / `result.expiresAt`） | ✅ 上游原样串 |
 * | `codearts-credits.ts`（`new Date(deductionEndTime).toISOString()`） | ❌ 从已过滤的 `deductionEndTime` 反推 |
 * | `minimax-credits.ts`（`new Date(expires).toISOString()`） | ❌ 同理（`expire_at_ms` 非哨兵形态） |
 * | `qoder-credits.ts`（`expIsPermanent ? '' : raw`） | ❌ 已在本轮修复时过滤 |
 *
 * ⚠️ **初版这段注释只写了「两个渠道」**（astudio / lobsterai），那是**漏数** ——
 * 只看了 `src/*-credits.ts`，漏掉了 `jet-hub-rpc.ts` 与 `provider-credits.ts`。
 * 「数一遍」必须覆盖**全仓**，不能只看命名符合直觉的那些文件。
 *
 * **当前是否可达**：**不可达** —— 上述上游实测都**不发** 9999 哨兵
 *（astudio 的 `*NextExpireTime` 实测形如 `"2026-11-20T01:50:14"`；
 * lobsterai / officeace 的 `expiresAt` 实测是当年的 ISO 串）。
 * 所以这是**前向防御缺口**，不是现存缺陷（如实标注，不夸大）。
 *
 * **为什么现在不改本函数**：它是**所有 provider 共用**的显示判据（不只是
 * `usesExpiryWindow` 那 13 家 —— 任何带 `expiredTime` 的包都会走到这里），
 * 在这里加「年份 >= 9999 就当没有到期」会**改变全部渠道**的展示语义，
 * 且那种「遥远处到期」在别的渠道可能是**真实**的。正确修法是**在写
 * `expiredTime` 的那几个调用点各自过滤**（与 Qoder 的 `isPermanentSentinelMs`
 * 同型 —— 一份判据、多个入口）。已登记，待上游取证后处理。
 *
 * @param pkg - 资源包。
 * @returns 毫秒时间戳；`null` = 没有到期时间（显示「长期」）。
 */
export function packageExpiryMs(pkg) {
  /**
   * ⚠️⚠️ **只认 `number` 与数字字符串，不许裸 `Number()`**（2026-11-01 三审实测）：
   * 后端 `src/buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry` 早已收窄成
   * `number | string`（那处的注释逐字记载了同一条教训），而这里仍是裸 `Number(…)`
   * ⇒ 强转有洞：`Number(true) === 1`、`Number([ms]) === ms`、
   * `Number({ valueOf: () => ms }) === ms` ⇒ **同一条数据前后端落不同桶**：
   * 前端判「临期 100」、后端判「永久 100」。用户看到的档位与真正选号用的档位不一致。
   * 三格都已实测复现（见 `tests/unit/credit-expiry.spec.ts` 的「与后端逐格同判」段）。
   */
  const raw = pkg && pkg.deductionEndTime;
  const dedEnd = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (Number.isFinite(dedEnd) && dedEnd > 0) return dedEnd;
  const exp = pkg && pkg.expiredTime ? String(pkg.expiredTime) : '';
  if (exp.length > 0) {
    const ms = Date.parse(exp.replace(' ', 'T'));
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

/**
 * 单个包的到期时间展示：**绝对日期 + 相对天数**，拿不到到期时间显示「长期」。
 *
 * ⚠️ 到期时间取自 {@link packageExpiryMs}（与排序同一判据）。
 *
 * ⚠️ 「长期」的判据是**服务端没给任何到期字段**。Qoder 的套餐额度/资源包
 * 就是这种情形 —— 显示"长期"比编造一个错误日期好。
 *
 * ⚠️ **`qoderUsage.expiresAt` 不算「给了到期字段」**（2026-10-20 真机取证订正）：
 * 那个字段确实在 `userQuota` 那一层存在，但个人版实测恒为永久哨兵
 * `253402214400000`（= `9999-12-31`）。若把它透出成 `deductionEndTime`，
 * 本函数会渲染成「9999-12-31（约 2900000 天后）」—— 也就是说**闸门在
 * `null` 这一侧**：哨兵必须被后端挡掉、不写进 `deductionEndTime`，
 * 才轮到这里正确地显示「长期」。两条判据缺一不可。
 */
export function formatPackageExpiry(pkg, now) {
  const end = packageExpiryMs(pkg);
  if (end === null) return '长期';
  const at = Number.isFinite(now) ? now : Date.now();
  /**
   * ⚠️⚠️ **日期按本地时区取，不能用 `toISOString()`**（2026-11-01 三审实测）：
   * `toISOString()` 给的是 UTC ⇒ 东八区用户看到**早一天**的到期日。
   * 实测：上游给「北京 `2026-10-04 00:00:00` 到期」⇒ 旧实现显示 `2026-10-03（3 天后）`；
   * 北京 `07:59:59` 与 `08:00:00`（只差 1 秒）会被显示成**两个不同日期**。
   *
   * 为什么不写死「+8 小时」：本函数被**所有**渠道共用，到期时刻是绝对毫秒 ⇒
   * 「到期日」对用户就是他**本地**的那一天；写死东八区会把 UTC-8 用户的日期又推错。
   * 用 `getFullYear/getMonth/getDate`（本地分量）两种时区都对。
   *
   * ⚠️ 连带约束：同一时刻在不同时区的机器上显示不同日期是**正确**行为 ⇒
   * 相关断言必须按「本地分量」算期望值，**不能硬编码日期字符串**（否则 UTC 机器上红）。
   */
  const local = new Date(end);
  /**
   * ⚠️ **有限但超出 `Date` 表示范围的值要挡掉**（2026-11-01 四审）：`packageExpiryMs`
   * 只保证「有限且 > 0」，而 `new Date(1e16)` 是 **Invalid Date** ⇒ 下面的
   * `getFullYear()` 全给 `NaN`，拼出 **「NaN-NaN-NaN（115720014 天后）」**。
   * （旧的 `toISOString()` 会直接抛 `RangeError` —— 更糟。）
   * 降级成「长期」与「到期时间未知」同档；可达性 0（生产者都写真实毫秒），
   * 属于「别让一条坏数据把整列渲染成 NaN」的兜底。
   */
  if (Number.isNaN(local.getTime())) return '长期';
  const date = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  const days = Math.ceil((end - at) / DAY_MS);
  if (days <= 0) return `${date}（已过期）`;
  return `${date}（${days} 天后）`;
}

/**
 * 资源包列表的多行文本（账号名 hover 用）。
 *
 * ## 只列**还能用**的包（用户 2026-09-29 要求）
 *
 * > 已经消耗为0的过滤掉，已经过期的过滤掉
 *
 * 三条过滤规则（命中任一即不显示）：
 *
 * | 规则 | 判据 | 为什么 |
 * |---|---|---|
 * | **已消耗完** | `remaining <= 0` | 剩余 0 的包扣不到，列出来只是噪音 |
 * | **已过期** | `packageExpiryMs(pkg) <= now` | 到期时刻已过 —— 同样扣不到 |
 * | **已失效** | `active === false` | 服务端标记失效（如退款/撤销） |
 *
 * ⚠️ **过滤必须在 `now` 上现算**，不能依赖 `active` 一个字段：
 * 实测各 provider 的 `active` 口径不一致 —— buddy 系按服务端 `Status` 字段，
 * LobsterAI 只在 `expiresAt` 已过时才算失效，而 TRAE / Qoder 的
 * `active` **恒为 true**（压根没有这个维度）。只判 `active` 会让已过期的包
 * 继续显示成"（已过期）"。
 *
 * ⚠️ **全部被过滤掉时返回 null**（调用方据此不挂 title）。若返回空串，
 * 用户 hover 会看到一个空的浮层；返回 null 则与"这个 provider 没有包列表"
 * 同一表现，干净。
 *
 * ## 排序：**最快到期的排最上面**（用户 2026-09-29 要求）
 *
 * > hover积分显示列表应该按照到期时间排序，最快到期的排到最上面，
 * > 最晚到期的排到最下面
 *
 * 这是**主排序键**。本函数是所有挂了包列表的 provider（buddy / workbuddy /
 * lobsterai / qoder / qodercn / trae）共用的，故一处改动全部生效。
 *
 * 两条配套规则：
 * - **到期时间未知的沉底**（`null` 视为 `Infinity`）。它们是「长期」那一档，
 *   语义上就是"最晚到期"；若按 0 处理会跑到最上面，恰好说反。
 * - **同一到期时刻内按剩余量降序**（次级键）。既保留"先看还有钱的包"这个
 *   原有价值，又让结果确定（不依赖引擎的稳定排序）。
 *
 * ## 截断
 *
 * 实测 CodeBuddy 中国版一个账号有 **105 个资源包**（多数是 30 天的运营裂变包），
 * 全列出来 tooltip 会长到无法阅读 ⇒ 取前 `maxRows` 个，其余汇总成一行给出
 * **合计剩余**（不丢总量信息）。
 * ⚠️ 截断发生在**过滤 + 排序之后**，故被截掉的是"最晚到期"的那批 ——
 * 用户最该关心的"快过期了"永远在最上面。
 *
 * @param packages - `balance.packages`。
 * @param options.format - 数字格式化（按包单位取 `formatUnits`）。
 * @param options.now - **渲染时**的当前时刻（过滤与排序都是时间的函数）。
 * @param options.maxRows - 最多列几个包。默认 12。
 * @returns 多行文本；无可用包时返回 null（调用方据此不挂 title）。
 */
export function formatPackageTooltip(packages, options = {}) {
  const { format, now = Date.now(), maxRows = 12 } = options;
  if (!Array.isArray(packages) || packages.length === 0) return null;
  const at = Number.isFinite(now) ? now : Date.now();

  // 只留还能用的包：剩余 > 0、未过期、未被标记失效。
  const usable = packages.filter(pkg => {
    if (!pkg || pkg.active === false) return false;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) return false;
    const end = packageExpiryMs(pkg);
    // 到期时刻已过 → 扣不到，不显示（`end === null` = 长期，保留）。
    if (end !== null && end <= at) return false;
    return true;
  });
  if (usable.length === 0) return null;

  // 主键：到期时刻升序（最快到期在上）；未知到期 = Infinity（沉底）。
  // 次键：剩余量降序（同一到期时刻内先看还有钱的包）。
  const sorted = [...usable].sort((a, b) => {
    const endA = packageExpiryMs(a);
    const endB = packageExpiryMs(b);
    const keyA = endA === null ? Infinity : endA;
    const keyB = endB === null ? Infinity : endB;
    if (keyA !== keyB) return keyA - keyB;
    return (Number(b && b.remaining) || 0) - (Number(a && a.remaining) || 0);
  });
  const lines = sorted.slice(0, maxRows).map(pkg => {
    const name = (pkg && pkg.name) || '未命名';
    const remaining = format ? format(Number(pkg && pkg.remaining) || 0) : String(pkg && pkg.remaining);
    const total = format ? format(Number(pkg && pkg.total) || 0) : String(pkg && pkg.total);
    // 走到这里必然 active !== false 且未过期，故不再需要 [已失效] 标记 ——
    // 那种包已被过滤掉。保留 formatPackageExpiry 的日期与天数展示。
    return `${name}  ${remaining} / ${total}  ${formatPackageExpiry(pkg, at)}`;
  });

  const rest = sorted.slice(maxRows);
  if (rest.length > 0) {
    // 汇总行只统计能用的包（此时它们全部可用，无需再判 active）。
    const sum = rest.reduce((acc, p) => acc + (Number(p && p.remaining) || 0), 0);
    lines.push(`…另有 ${rest.length} 个包${sum > 0 ? `，合计剩余 ${format ? format(sum) : sum}` : ''}`);
  }
  return lines.join('\n');
}
