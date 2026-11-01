/**
 * Magicrew 上游数值字段的**统一解析**（签到侧与积分侧共用一份）。
 *
 * ## 为什么单独一个文件
 *
 * 2026-11-01 三审发现：`src/magicrew-checkin.ts` 与 `src/magicrew-credits.ts`
 * 各自有一份**同名**的 `magicrewPointsOf`，前者加了「只认十进制字面量」的
 * 正则、后者没加 ⇒ 同一个上游字段在两处解释不同：
 *
 * | 输入 | checkin 侧 | credits 侧（修前） |
 * |---|---|---|
 * | `'0x10'` | 0 | **16**（`Number('0x10')`） |
 * | `'1e3'` | 0 | **1000** |
 *
 * 于是同一个畸形响应会让「签到读到的积分」与「倍率表算出的倍率」分家。
 * ⇒ 判据抽到这里，**只有一份**。
 *
 * ## 为什么不用参考实现的宽容解析
 *
 * 参考实现是 `api.mjs:364-387` 的 `parsePointsValue`：去千分位、统一 Unicode 负号、
 * 读会计括号负数、剥 `¥$￥` ⇒ `"1,234 积分"` 得 1234。
 *
 * ⚠️ 本仓**刻意保守**：正常的积分/价格字段是 number，出现带千分位或单位的字符串
 * 本身就说明**响应形态已经变了**；把它「猜」成一个数字会让一次上游改版变成
 * 「数字看起来对、其实错」的静默错误。宁可返回 `undefined`（读不到）。
 *
 * ⚠️ 但 `Number()` 本身也有陷阱：`Number(null) === 0`、`Number([]) === 0`、
 * `Number(true) === 1`、`Number('0x10') === 16`、`Number('1e3') === 1000`
 * ⇒ **只放行 number 与十进制字面量字符串**。
 *
 * ## 本文件不引 `node:*`
 *
 * 与 `magicrew-product.ts` 同因。
 */

/** 十进制数字字面量（可带小数与正负号）。 */
export const DECIMAL_LITERAL_RE = /^[+-]?\d+(?:\.\d+)?$/

/**
 * 把上游下发的「数字」解释成 number（**允许负数**，余额专用）。
 *
 * ⚠️ **与 `magicrewDecimalOf` 的分工，别混用**（2026-11-01 二审）：下面那个拒绝负数，
 * 是因为「任务积分 / 模型单价」为负会让展示与倍率算错；而**账户余额**可以是负的 ——
 * 上游实测过 `total_points: -31`（欠费），把它当非法会让整条余额变成 `undefined`
 * （面板报「查询失败」、锁定态选号判 `none`，与「凭据失效」同形）。
 * ⇒ 余额口径用本函数，其余一律用 `magicrewDecimalOf`。
 */
export function magicrewSignedDecimalOf(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || !DECIMAL_LITERAL_RE.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 把上游数值字段读成数字；**读不到返回 `undefined`**（不是 0 —— 0 是合法值，
 * 例如「免费模型」的价格就是 0）。
 *
 * 调用方按自己的契约决定 `undefined` 映射成什么：
 * - 签到侧（`magicrew-checkin.ts`）映射成 `0`（= 「读不到」，宁可少算）；
 * - 积分侧（`magicrew-credits.ts`）保留 `undefined`（= 「未知」，与「0 = 免费」区分）。
 *
 * ## ⚠️ **负数一律读不到**（2026-11-01 三审）
 *
 * 本函数只服务两个字段：**任务积分**（`tasks[].points`）与**模型单价**
 * （`input_points`）。两者都**不可能为负**：
 * - 任务积分给负 ⇒ `earned` 会算出比实际更小的值（用户以为少领了）；
 * - 模型单价给负 ⇒ 倍率变成**负倍率**（实测 `'-5'` ⇒ `-0.0025`），
 *   而这个值会直接显示在模型列表的「倍率」列上。
 *
 * ⚠️ 注意与**余额**的区别：`total_points` **可以**是负数（欠费，上游实测
 * `total_points: -31`），但它走的是 `fetchMagicrewBalance` 的直接读取，
 * **不经本函数** ⇒ 拒绝负数不会误伤余额。
 */
export function magicrewDecimalOf(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : undefined
  }
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || !DECIMAL_LITERAL_RE.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
