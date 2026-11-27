/**
 * ★★★ **徽标 / 下拉框的两处档位计算**（2026-11-27 从 `usage-badge.js` 抽出）
 *
 * ## 为什么抽出来（唯一动机：**能写行为级用例**）
 *
 * `usage-badge.js` 顶部 `import * as React from 'react'`，而 react 是 esbuild 的
 * external（本仓 `node_modules` 里没有）⇒ **任何 import 它的测试都跑不起来**
 * ⇒ 那个文件里的纯计算只能做**源码正则断言**，挡不住 `if (false)` 这类失效形态。
 *
 * ⚠️ 本仓**已有同一先例**：`sumAvailableCredits` 就是从 `usage-badge.js` 搬到
 * `badge-model.js` 的，理由逐字相同 ——
 * 「`usage-badge.js` 的每个纯计算都是『改坏了全绿』（对抗审计 B02 实测：
 *   把 `return seen ? total : null` 改成 `return null` —— **三个 spec 全绿**）」。
 *
 * ## 本模块的两个函数
 *
 * | 函数 | 用途 | 判错的后果 |
 * |---|---|---|
 * | `expiringUsableOf` | 锁定态「该号还有没有可用于排队的短临积分」| **下拉框把选号层会跳过的号显示成可选** |
 * | `startTierOf` | 「用户选的起点是哪个档」的提示 | **提示说错档位**（说错比不说更糟）|
 *
 * ## ⚠️ 抽取原则：**只搬纯计算，不动任何调用方的控制流**
 *
 * 两个函数原来都是 `renderCredits` 内的闭包（捕获 `value` / `rotationState`）。
 * 这里改为**显式入参**，调用方仍负责「找 row / 取 packages / 判 unit」。
 * ⇒ 渲染路径的分支一个都没变（这两处历史上崩过一次真机：
 *   `Cannot read properties of null (reading 'expiring')`）。
 */

import { backendOrderTier, CREDIT_ORDER_TIER } from './badge-model.js'
/**
 * ⚠️ **`QUOTA_UNIT` 在 `credits-format.js`，不在 `badge-model.js`**
 *（我第一版 import 错了 ⇒ 整个模块加载失败 ⇒ 所有测试拿到异常结果）。
 * 值实测是 `'%'`（配额类渠道的单位）。
 */
import { QUOTA_UNIT } from './credits-format.js'
import { splitCreditsByExpiry } from './credit-expiry.js'

/**
 * ⚠️ **本目录是 `.js`（不是 `.ts`）**：`plugin-src/client` 走 esbuild 打包到客户端，
 *    **不能写 TS 语法**（`interface` / 类型注解都会让 rollup 解析失败 —— 实测
 *    `Parse failure: Expected '{', got 'interface'`）。
 * ⇒ 参数形状只写在 JSDoc 里。
 *
 * `params` 期望形状（= 徽标读数 `value` 的窗口相关字段）：
 * ```
 * { windowDays?, imminentDays?, imminentFloor?, expiringFloor? }
 * ```
 */

/**
 * ★ **把任意值归一成「积分下限」**（非法 / 缺省 ⇒ 0 = 关闭）。
 *
 * ⚠️ 与后端 `positiveOrZero(options.imminentFloor)` **同判**：
 * 负数 / `NaN` / 非数字一律归 0 ⇒ 方向保守（最坏只是阈值不生效，不会误降级）。
 */
function floorOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 把任意值归一成安全非负数字（与 `credit-expiry.js` 的既有口径一致）。 */
function numOf(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * ★★★ **锁定永久积分时，这个号的「短临积分」还能不能用**。
 *
 * ## 语义
 *
 * 返回的是 **`split.expiring`（可排队的量）**，但**按积分阈值过滤过**：
 * 低于阈值的档视为「已降级」⇒ 不计入可用。
 *
 * | 号 | 阈值 20 时后端 `buddyBalanceTier` | 本函数返回 | 调用方判 |
 * |---|---|---|---|
 * | 临期 5 / 短期 0 | 降档到 `permanent` ⇒ 锁定态 **`none`** | **0** | **不可用** ✅ |
 * | 临期 500 / 短期 0 | `imminent` ⇒ 可用 | 500 | 可用 ✅ |
 * | 全 0 | `none` | 0 | 不可用 ✅ |
 *
 * ## ⚠️ 为什么「只过滤、不消灭」
 *
 * 这里算的是**可用于排队的量**（影响下拉框灰不灰）。
 * 而**金额展示**走 `expirySplitParts`（那里**不能**过滤 —— 用户第 6 条定案：
 * 降级只改排队顺序，不改「烧包顺序」，剩余积分照样要显示）。
 *
 * @param packages - 该账号的原始资源包数组
 * @param params - 窗口天数 + 两个积分阈值
 * @param now - 当前时刻（省略 = 不按时间分档，与调用方原行为一致）
 * @returns `undefined` = 读不到（**不倒向不可用**，见下）；`number` = 可用于排队的短临积分
 */
export function expiringUsableOf(
  packages,
  params,
  now,
) {
  /**
   * ⚠️ **读不到就返回 `undefined`，绝不返回 0**（真实缺陷的教训，见调用方注释）：
   * 无余额概念的渠道（codearts / cline / token 计费）本来就恒可用，
   * 把它们判成「不可用」会让用户一个起点都选不了。
   */
  if (!Array.isArray(packages)) return undefined
  const split = splitCreditsByExpiry(packages, params.windowDays, now, params.imminentDays)
  /** ⚠️ 必须用 `== null`：`splitCreditsByExpiry` 返回 `null` 而不是 `undefined`。 */
  if (split == null) return undefined

  const imminent = numOf(split.imminent)
  const expiring = numOf(split.expiring)
  /**
   * ⚠️⚠️ **判据必须与 `backendOrderTier` / 后端 `buddyBalanceTier` 逐字同源**。
   *
   * ## 用户需求（原话）
   *
   * > 「临期低于 20 就不再算临期了，归入短期；**短期低于 30 就不算短期了，
   * >   自动归入长期**」
   *
   * ## 我在这里踩过的坑（都记下来）
   *
   * ### 坑一：用母量 `expiring` 判短期档（**真缺陷**）
   *
   * `expiring = imminent + shortTerm`（临期 ⊂ 短期）⇒ 只要还有临期，
   * 母量就被抬高 ⇒ **短期阈值失效**：
   *
   * | 号 | 母量 | 纯短期 | 阈值 30 时正确结果 |
   * |---|---|---|---|
   * | 临期 5 / 纯短期 28 | 33 | 28 | 28 < 30 ⇒ **归入长期** |
   * | 用母量判 | `33 > 30` ✅ | — | 仍算短期 🚨 **与用户要求相反** |
   *
   * ### 坑二：以为「改成 shortTerm 就与后端分叉」
   *
   * 后端 `BuddyCreditSplit` **没有** `shortTerm` 字段，但它的
   * `shortTerm = expiring - imminent` —— 与前端 `split.shortTerm` **等价**。
   * ⇒ 两边都写 `expiring - imminent`，数值与语义**完全一致**。
   *
   * ### 坑三：以为「`expiringFloor` 不该影响含临期的号」
   *
   * 用户明确要的就是**链式降级**：临期不足 → 归短期；短期不足 → 归长期。
   * 一个「临期 5 + 纯短期 28」的号**应该**被降进长期档。
   *
   * ## 最终判据（与后端逐字相同）
   *
   * - 临期档成立 = `imminent > imminentFloor`
   * - 短期档成立 = `(expiring - imminent) > expiringFloor`（**纯短期**）
   * - 任一成立 ⇒ 返回 `expiring`（可用于排队的量）
   */
  const pureShortTerm = Math.max(0, expiring - imminent)
  const countsImminent = imminent > floorOf(params.imminentFloor)
  const countsShortTerm = pureShortTerm > floorOf(params.expiringFloor)
  return countsImminent || countsShortTerm ? expiring : 0
}

/**
 * ★★★ **某账号此刻的档位**（供「起点档位提示」使用）。
 *
 * ## 为什么要复用 `backendOrderTier`
 *
 * 调用方注释逐字写着：
 *
 * > 「必须复用 `splitCreditsByExpiry` + `backendOrderTier`，不能自己写一套：
 * >   『起点提示说的档位』与『列表排序用的档位』若分叉，用户会看到
 * >   『提示说是短期，但列表把它排在永久里』这种无法解释的矛盾。」
 *
 * @param packages - 该账号的原始资源包数组
 * @param params - 窗口天数 + 两个积分阈值
 * @param allowPermanent - 是否允许消耗永久积分（= `locked !== true`）
 * @param now - 当前时刻
 * @returns 档位编号；`null` = 不适用（配额单位 / 读不到）
 */
export function startTierOf(
  packages,
  params,
  allowPermanent,
  now,
) {
  if (!Array.isArray(packages)) return null
  /** ⚠️ 配额单位（Gemini 的并行百分比）没有「积分档位」概念 ⇒ 返回 `null`（调用方跳过渲染）。 */
  const unit = packages.find((pkg) => pkg && pkg.unit)?.unit
  if (unit === QUOTA_UNIT) return null
  const split = splitCreditsByExpiry(packages, params.windowDays, now, params.imminentDays)
  if (split == null) return CREDIT_ORDER_TIER.none
  return backendOrderTier(
    split,
    allowPermanent,
    floorOf(params.imminentFloor),
    floorOf(params.expiringFloor),
  )
}
