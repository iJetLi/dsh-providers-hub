/**
 * 账号卡片上「这个号还能不能用」的**纯逻辑**（无 React、无 DOM）。
 *
 * ## 为什么单独成文件
 *
 * 这里要区分两种**语义完全不同**的坏状态（Gitee issue IKS2MV）：
 *
 * | | 限流 | 封禁 |
 * |---|---|---|
 * | 判据字段 | `modelRateLimits`（逐模型、带到达时刻） | `policyBlockedAtMs`（账号级、不自动过期） |
 * | 上游形态 | 429 / code 6004 / **有重置时刻** | 403（或 400）/ code 11140 / **不给时刻** |
 * | 恢复方式 | 等时间到 | 只能重新登录 / 人工解封 |
 * | 影响范围 | **单个模型**（换模型仍可用） | **整个账号** |
 *
 * 用户报障的两条都源于把它们混在一起：
 * ① 封禁只写了 30 分钟冷却 ⇒ 过期后面板恢复「已就绪」，8 个废号显示全绿；
 * ② 限流笼统写「限流」⇒ 用户以为整个号废了，而实测同秒换模型立刻 200。
 *
 * 把判据抽成纯函数是为了**能被单测直接钉住** —— 内联在 `AccountCard` 里的
 * 三元表达式只能靠人眼看界面，而它恰恰是「看起来正常」的那一类。
 */

/**
 * `Date` 可表示的最大毫秒值（与宿主 `src/jet-hub-store.ts` 的 `MAX_DATE_MS` 同值）。
 *
 * ⚠️ 客户端**必须**用同一条上界：封禁标记会进 `new Date()`（格式化 / 倒计时），
 * 超出范围会抛 `RangeError`；而「宿主判它无效、界面判它有效」会让两边**分叉** ——
 * 那正是本仓库反复记过的「显示与行为分叉」缺陷形态。
 */
const MAX_DATE_MS = 8_640_000_000_000_000

/**
 * 账号级封禁信息。
 *
 * @param account - 宿主下发的账号条目（可能缺字段）。
 * @returns `blocked` 为真时 `message` 是上游原文（可能为 `''`）。
 */
export function policyBlockedInfo(account) {
  const at = account?.policyBlockedAtMs
  const blocked = typeof at === 'number' && Number.isFinite(at) && at > 0 && at <= MAX_DATE_MS
  const message = typeof account?.policyBlockedMessage === 'string' ? account.policyBlockedMessage : ''
  return { blocked, message }
}

/**
 * 仍未到期的**逐模型**限流标记。
 *
 * ⚠️ 只保留 `resetAt > now` 的那些：已过期的标记是「历史」，用户仍能通过
 * 「重置」清掉（`accountHasLimitMarkers` 判据不同），但**不该**在卡片上继续
 * 显示成「正在限流」。
 *
 * @returns `[{ modelId, resetAt }]`（按原顺序）。
 */
export function activeRateLimits(account, nowMs = Date.now()) {
  const limits = account?.modelRateLimits
  if (limits === null || typeof limits !== 'object') return []
  return Object.entries(limits)
    .filter(([, resetAt]) => typeof resetAt === 'number' && resetAt > nowMs)
    .map(([modelId, resetAt]) => ({ modelId, resetAt }))
}

/**
 * 卡片上「重测 / 重置」两个按钮该不该可用。
 *
 * ⚠️ 两条判据**刻意不同**：
 * - `reset`（重置）只要**有任何一笔账**（含已过期的限流标记、封禁）就该可用 ——
 *   它是用户唯一的清除入口，而封禁**不自动过期**；
 * - `retest`（重测）只对**逐模型限流标记**有意义：`retestAccount` 在零模型标记时
 *   一次请求都不发，纯封禁账号上按它毫无反应（会让人以为按钮坏了）。
 *   纯封禁账号的正确入口是「测试」（无条件探活）。
 */
export function accountLimitActionState(account, nowMs = Date.now()) {
  const { blocked } = policyBlockedInfo(account)
  const hasModelMarkers = account?.modelRateLimits !== null
    && typeof account?.modelRateLimits === 'object'
    && Object.keys(account.modelRateLimits).length > 0
  return {
    /** 「重置」可用（有任一标记，含已过期的）。 */
    canReset: blocked || hasModelMarkers,
    /** 「重测」可用（有逐模型标记 —— 它只测这些模型）。 */
    canRetest: hasModelMarkers,
    /** 卡片上是否要显示「限流」那一行（只显示未到期的）。 */
    activeRateLimits: activeRateLimits(account, nowMs),
    policyBlocked: blocked,
  }
}

/**
 * 封禁红条的自救提示文案。
 *
 * ## ⚠️⚠️ 入口必须与**真实存在的按钮**同源（对抗审计 E9 实测打穿）
 *
 * 第一版文案恒写「点『测试』确认已恢复」，而「测试」按钮由 `onTest` 门控
 * —— `supportsAccountTest` **只在 gemini 登记** ⇒ buddy / workbuddy（也就是
 * 本 issue 的 provider）**根本没有那个按钮**。用户照着文案找会以为面板坏了。
 *
 * @param canTest - 面板上**是否真的渲染了「测试」按钮**（= `onTest` 是否存在）。
 * @returns 该行提示文案。
 */
export function policyBlockedHint(canTest) {
  const base = '上游以「账号存在异常行为」拒绝了该账号（code 11140，全部模型都不可用）。'
  return base + (canTest
    ? '点「测试」确认已恢复（会用掉一点额度），或「重置」直接清除这条标记。'
    : '点「重置」清除这条标记（本渠道没有探活按钮，重置不会验证账号是否真的恢复）。')
}
