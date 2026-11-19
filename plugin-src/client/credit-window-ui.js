/**
 * 「分档窗口」弹窗的**纯逻辑**（不 import react，故可被 vitest 直接测）。
 *
 * ## 为什么单独成文件
 *
 * 本仓库反复记录过的教训：把判定逻辑内联在 `jet-hub.js` 里 ⇒ 那个文件 import
 * 不进单测（react 是 esbuild external）⇒ 测试只能做**源码文本断言**，
 * 而文本断言有大量已知假绿形态（`if (false)` 短路、字符串换行、注释诱饵）。
 *
 * ⇒ 弹窗的三件核心逻辑全部搬到这里，测试直接行为断言：
 * 1. `parseWindowInput` —— 输入框文本 → 合法天数（含空白/非法/小数）
 * 2. `computeCoverage` —— 按新窗口重算「各档覆盖多少个账号」
 * 3. `describeWindowSource` —— 来源标注文案
 */

import { splitCreditsByExpiry } from './credit-expiry.js'

/**
 * 解析输入框文本为天数。
 *
 * ## 判据
 *
 * | 输入 | 返回 | 理由 |
 * |---|---|---|
 * | `''` / 纯空白 | `undefined` | **空 ≠ 0**：空表示「用默认」，0 是「关掉该档」|
 * | `'5'` | `5` | |
 * | `'0'` | `0` | **合法**（关掉该档）|
 * | `'-1'` | `null` | 非法（负数无意义）|
 * | `'abc'` / `'5x'` | `null` | 非法 |
 * | `'5.5'` | `null` | 非法（窗口以「天」为粒度，小数会让边界无可解释）|
 * | `'Infinity'` / `'1e309'` | `null` | 非法（会让「永久」档永远空）|
 *
 * @returns 天数 / `undefined`（空，回落默认）/ `null`（非法，应拒绝保存）
 */
export function parseWindowInput(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text.length === 0) return undefined
  // ⚠️ 只接受**纯十进制整数**：`Number('')` 是 0、`Number('  ')` 是 0，
  //    所以上面必须先挡空串；`Number('0x10')` 是 16 也要挡掉。
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  // 上界：100 年。超过它一定是手误（且会让「永久」档失去意义）。
  if (value > 36_500) return null
  return value
}

/**
 * 钳制「临期窗口 ≤ 短期窗口」。
 *
 * ⚠️ 与后端 `resolveCreditWindow` 的钳制**同一方向**（`Math.min`），
 * 这里是**前端预览与即时反馈**用的第二道防线 ——
 * 后端仍会独立钳制一次（拿到的可能不是本版本前端）。
 *
 * @returns `{ imminent, clamped }`；`clamped = true` 表示用户填的值被压小了
 */
export function clampImminent(imminent, windowDays) {
  if (typeof imminent !== 'number' || typeof windowDays !== 'number') {
    return { imminent, clamped: false }
  }
  if (imminent <= windowDays) return { imminent, clamped: false }
  return { imminent: windowDays, clamped: true }
}

/**
 * 按给定窗口，统计**每个档位覆盖多少个账号** + 各档金额。
 *
 * ## 口径（关键）
 *
 * 「覆盖」= 该账号**在这一档有积分**（不是「该账号被归到这一档」）。
 *
 * ⇒ 一个账号如果既有临期又有短期积分，会**同时**计入两个档。
 * 这正是用户要的语义：回答「这个窗口会涉及哪些账号」，
 * 而不是「每个账号归哪一档」。
 *
 * ⚠️ 因此 `imminent + shortTerm` 的账号数**可能大于**总账号数 ——
 * 这是正确的，不要「修正」成互斥分类。
 *
 * ## 与面板分档必须同源
 *
 * 内部用 `splitCreditsByExpiry`（与面板渲染、后端 `splitBuddyCreditsByExpiry`
 * 逐格同判的同一个函数），**不自己写一套求和/分档**。
 *
 * @param accounts - `[{ id, packages }]`（`packages` 为原始资源包数组）
 * @param windowDays - 短期窗口
 * @param imminentDays - 临期窗口
 * @param now - 当前时刻（测试注入）
 */
export function computeCoverage(accounts, windowDays, imminentDays, now) {
  const empty = {
    imminentAccounts: 0,
    shortTermAccounts: 0,
    permanentAccounts: 0,
    noCreditAccounts: 0,
    totalAccounts: 0,
    imminentAmount: 0,
    shortTermAmount: 0,
    permanentAmount: 0,
  }
  if (!Array.isArray(accounts)) return empty
  const out = { ...empty, totalAccounts: accounts.length }
  for (const account of accounts) {
    const packages = account?.packages
    if (!Array.isArray(packages)) {
      out.noCreditAccounts += 1
      continue
    }
    const split = splitCreditsByExpiry(packages, windowDays, now, imminentDays)
    if (split === null) {
      out.noCreditAccounts += 1
      continue
    }
    const imminent = Number(split.imminent) || 0
    const shortTerm = Number(split.shortTerm) || 0
    /**
     * ⚠️⚠️ **「永久」档必须把 `longTerm` 也算进来**（真实缺陷，2026-11-19 实测抓到）。
     *
     * `splitCreditsByExpiry` 的桶名与**后端的「永久」口径不同**：
     *
     * | 距过期 | 客户端 `splitCreditsByExpiry` | 后端 `splitBuddyCreditsByExpiry` |
     * |---|---|---|
     * | 2 天  | `imminent` | `imminent`（⊂ expiring）|
     * | 12 天 | `shortTerm` | `expiring` |
     * | **30 天** | **`longTerm`** | **`permanent`** |
     * | 无日期 | `permanent` | `permanent` |
     *
     * ⇒ 后端把「≥ 窗口」一律算永久，客户端却把「超过窗口但仍有到期日」单列成
     * `longTerm`。**本函数的「永久」对应的是「不会在窗口内到期」**，
     * 所以必须 `permanent + longTerm` 一起算。
     *
     * 漏这一格的症状：预览里「永久」档恒显示 0（而面板上明明有大量长期积分），
     * 且**不会报任何错** —— 用户会以为窗口设置坏了。
     */
    const permanent = (Number(split.permanent) || 0) + (Number(split.longTerm) || 0)
    // ⚠️ `expired` 是已作废的包，不参与任何档（它在 split 里是独立字段）
    const expired = Number(split.expired) || 0
    // ⚠️ 金额按档累加（同一账号的两档互不重叠，故金额可以直接相加）
    out.imminentAmount += imminent
    out.shortTermAmount += shortTerm
    out.permanentAmount += permanent
    // ⚠️ 账号数按「该档有积分」计（可重叠，见函数头注释）
    if (imminent > 0) out.imminentAccounts += 1
    if (shortTerm > 0) out.shortTermAccounts += 1
    if (permanent > 0) out.permanentAccounts += 1
    // ⚠️ 「无可用积分」判据要含 `expired`：只有作废包的账号确实没有可用积分
    if (imminent <= 0 && shortTerm <= 0 && permanent <= 0 && expired <= 0) {
      out.noCreditAccounts += 1
    }
  }
  return out
}

/**
 * 预览进度条的**最小可见宽度**（百分比）。
 *
 * ⚠️ 为什么不直接用裸比例（实测决定，2026-11-20）：
 * 真实数据临期 393 / 短期 607 / 永久 27263 ⇒ 占比 **1.4% / 2.1% / 96.5%**。
 * 条可用宽度约 228px ⇒ 前两条只有 **3.2px / 4.8px**，肉眼读成一个点。
 * 用户会以为「进度条没渲染」—— 这正是本功能被报障两次的形态。
 *
 * ⇒ 金额 > 0 的档位强制至少 3%（约 7px）。
 *    代价是三条之和可能略超 100%，但那是刻意的：
 *    「看得出来有个条」比「比例绝对精确」重要，且差额 < 3% 肉眼无感。
 */
export const MIN_VISIBLE_PERCENT = 3

/**
 * 计算某档在进度条上的宽度百分比。
 *
 * @param amount - 该档金额
 * @param total - 三档总额
 * @returns 0 ~ 100 的百分比
 *
 * ## 边界（每条都有测试）
 *
 * | 输入 | 返回 | 理由 |
 * |---|---|---|
 * | `amount = 0` | `0` | 空档不能画假条 |
 * | `total = 0` | `0` | 不除零（`NaN` 会让 `width: NaN%` 整条不渲染）|
 * | 金额 > 0 但占比 < 3% | `3` | 最小可见宽度（见 {@link MIN_VISIBLE_PERCENT}）|
 * | 金额 > 0 且占比 > 3% | 真实占比 | |
 * | 占比 > 100%（数据异常）| `100` | 夹住，不允许条溢出容器 |
 */
export function barPercent(amount, total) {
  const a = Number(amount)
  const t = Number(total)
  if (!Number.isFinite(a) || !Number.isFinite(t)) return 0
  if (!(a > 0) || !(t > 0)) return 0
  const pct = (a / t) * 100
  if (!Number.isFinite(pct)) return 0
  return Math.max(MIN_VISIBLE_PERCENT, Math.min(100, pct))
}

/**
 * 三档总额（进度条的分母）。
 *
 * ⚠️ 必须用**同一份** `coverage` 的三个金额求和，不要另算一次 ——
 * 两处各算会因「永久是否并入 longTerm」这类口径差异而漂移。
 */
export function coverageTotal(coverage) {
  if (coverage === null || typeof coverage !== 'object') return 0
  const sum = Number(coverage.imminentAmount || 0)
    + Number(coverage.shortTermAmount || 0)
    + Number(coverage.permanentAmount || 0)
  return Number.isFinite(sum) && sum > 0 ? sum : 0
}

/** 单个字段行（含覆盖账号数徽标）。 */
export function describeWindowSource(source, windowDays, imminentDays) {
  if (source === 'setting') return '本渠道设置'
  if (source === 'env') return '环境变量'
  return '默认值'
}

/**
 * 预览里三档的**区间文案**（与三档顺序一致：临期 → 短期 → 永久）。
 *
 * ⚠️ 顺序必须与输入字段、面板分档行**完全一致**（用户 2026-11-19 要求），
 * 否则用户改数字时视线要在两个不同顺序的列表间来回跳。
 */
export function windowRangeLabels(windowDays, imminentDays) {
  return {
    imminent: `临期  < ${imminentDays} 天`,
    shortTerm: `短期  ${imminentDays} ~ ${windowDays} 天`,
    permanent: `永久  ≥ ${windowDays} 天`,
  }
}

/**
 * 弹窗右侧/徽标要显示的「覆盖 N 个账号」文本。
 *
 * ⚠️ 总数用 `totalAccounts`（含「无可用积分」的账号）——
 * 用户看到「3 / 7」时，分母必须是**全部账号**，而不是「有积分的那些」。
 */
export function coverageLabel(count, totalAccounts) {
  return `覆盖 ${count} 个账号`
}
