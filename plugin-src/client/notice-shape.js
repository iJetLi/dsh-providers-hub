/**
 * `notice` 类提示的形状归一化（纯逻辑，不碰 React）。
 *
 * ## 为什么这个文件存在（2026-10-22 整页白屏事故）
 *
 * `ProviderPanel` 里 `probeNotice` 的渲染端按**对象**读三个字段：
 *
 *     'data-tone': probeNotice.tone,
 *     React.createElement('div', null, probeNotice.text),
 *     probeNotice.details.length > 0 ? ...
 *
 * 但历史上**两处调用直接传了裸字符串**：
 *
 *     setProbeNotice('该 key 已存在，已为你定位到原有账号。');          // 添加路径
 *     setProbeNotice(res?.renamed ? '…' : '已更新访问令牌。');           // 编辑路径
 *
 * 字符串没有 `.details` ⇒ `.length` 抛
 * `TypeError: Cannot read properties of undefined (reading 'length')`。
 * **插件内没有任何 ErrorBoundary** ⇒ React 卸载整棵设置页子树 ⇒
 * 用户看到的就是「一保存，页面直接清空；切到别的页面也无效，只能重启 DSH」。
 *
 * 用户当时的操作恰好命中 `existed` 分支（魔搭账号早于该次保存就已存在，
 * `state.json` 里 `createdAt` 是 10-19，而报障发生在 10-22）。
 *
 * ## 修复的三层（**真正的修复在源头，这一层只是兜底**）
 *
 * 1. 源头：那两处调用改成 `{ tone, text, details: [] }` 对象形状；
 * 2. 渲染端：`details` 用 `Array.isArray(...)` 保护，缺明细时降级成「没有明细」；
 * 3. 写入端：`setProbeNotice` 包装成经本函数归一化 —— 将来再写错形状，
 *    后果退化成「少一行明细」，而不是整页消失。
 *
 * ⚠️ 第 3 层**不能**用来解释「所以源头可以写错」：它防的是回归，不是免责。
 *
 * @module plugin-src/client/notice-shape.js
 */

/**
 * @typedef {{ tone: string, text: string, details: string[] }} NormalizedNotice
 */

/**
 * 把任意形状的 notice 归一化成渲染端要求的 `{ tone, text, details }`。
 *
 * - `null` / `undefined` ⇒ `null`（不渲染该区块）
 * - 裸字符串 ⇒ `{ tone: 'ok', text: <原串>, details: [] }`（历史写法，保文案）
 * - 对象 ⇒ 逐字段校验；`text` 为空则视为「没有可说的」，返回 `null`
 * - 其它标量（数字 / 布尔）⇒ `null`（无法解释成提示）
 *
 * @param {unknown} next 待写入的 notice
 * @returns {NormalizedNotice | null}
 */
export function normalizeProbeNotice(next) {
  if (next === null || next === undefined) return null;
  // 裸字符串：历史上就是这么写的，按成功提示处理，不丢文案。
  if (typeof next === 'string') {
    return { tone: 'ok', text: next, details: [] };
  }
  if (typeof next !== 'object' || Array.isArray(next)) return null;
  const record = /** @type {Record<string, unknown>} */ (next);
  const text = typeof record.text === 'string' ? record.text : '';
  // 空文案 = 没有任何可说的，当作「不显示」，避免渲染一个空的白条。
  if (text.length === 0) return null;
  const details = Array.isArray(record.details)
    ? record.details.filter(line => typeof line === 'string' && line.length > 0)
    : [];
  return {
    tone: typeof record.tone === 'string' && record.tone.length > 0 ? record.tone : 'ok',
    text,
    details,
  };
}

/**
 * 渲染端的安全明细读取：非数组一律当空数组。
 *
 * 与 `normalizeProbeNotice` 分开导出，是因为渲染端读的是**已存进 state 的旧值**
 * （本次修复之前写进去的裸字符串仍可能存在于内存里，例如热重载后未重挂载）。
 *
 * @param {unknown} details
 * @returns {string[]}
 */
export function safeNoticeDetails(details) {
  return Array.isArray(details) ? details : [];
}
