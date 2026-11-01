/**
 * 定时签到面板的**纯逻辑**（无 React、无 DOM）。
 *
 * 为什么单独成文件：`jet-hub.js` 依赖 `react`，在 vitest 里 import 它需要宿主真身；
 * 而本仓库的惯例是「纯逻辑抽成独立模块，`jet-hub.js` 只做源码级断言」
 * （见 `aggregate-panel-logic.js` / `badge-model.js` / `account-order.js`）。
 * 不抽出来，下面那个真实缺陷就只能靠**人眼看界面**发现 —— 而它恰恰是「看起来正常」的。
 */

/**
 * 把宿主的 `nextRunAt`（毫秒）渲染成「下次执行」文案。
 *
 * ## 为什么要有这个函数（真实缺陷，用户报障 2026-10-18）
 *
 * 报障原文：「为什么我按钮打开还是显示下次执行：不会执行（开关已关闭）」。
 * 根因**不是算错时间**，而是把**两种完全不同的状态**混成了一个文案：
 * 插件已更新（客户端是新的），但宿主进程仍在跑**旧代码**（进程启动早于构建）
 * ⇒ 响应里根本没有 `nextRunAt` 字段 ⇒ 旧实现把 `undefined` 与 `0` 一律说成
 * 「开关已关闭」，而同一面板上方的开关明明勾着 —— 自相矛盾，把人引向错方向。
 *
 * | 入参 | 含义 | 文案 |
 * |---|---|---|
 * | 非数字（`undefined`/`null`/`NaN`） | **宿主不返回该字段**（旧宿主 / 版本不匹配） | 提示重启 DSH |
 * | `<= 0` | 宿主明确算出「不会执行」（开关关闭） | 不会执行（开关已关闭） |
 * | `> 0` | 正常时刻 | 今天/明天 HH:MM（N 小时后） |
 *
 * ⚠️ 用 `<= 0` 而不是 `=== 0`：负值（时钟异常 / 脏数据）同样是「不会有下次」的
 * 语义，不该被渲染成 1970 年。
 *
 * @param at - 宿主下发的 `nextRunAt`（毫秒）；0 = 不执行。
 * @param nowMs - 当前时刻（注入以便单测固定）。
 * @returns 可直接展示的中文文案。
 */
export function formatNextRunAt(at, nowMs = Date.now()) {
  if (typeof at !== 'number' || Number.isNaN(at)) {
    return '未知（宿主版本较旧，重启 DSH 后才会显示）';
  }
  if (at <= 0) return '不会执行（开关已关闭）';
  const diff = at - nowMs;
  // 已到点 / 仅毫秒级抖动：宿主算出的时刻可能略早于本地时钟，
  // 一律说成「马上执行」，而不是显示「0 分后」这种读不出意思的文案。
  if (diff <= 1000) return '马上执行（有时段待补）';
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const today = new Date(nowMs);
  const sameDay = d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth()
    && d.getDate() === today.getDate();
  const hours = Math.floor(diff / 3_600_000);
  const mins = Math.round((diff % 3_600_000) / 60_000);
  const away = hours > 0 ? `${hours} 小时 ${mins} 分后` : `${mins} 分后`;
  return `${sameDay ? '今天' : '明天'} ${hh}:${mm}（${away}）`;
}

/**
 * 面板要不要显示「宿主是旧代码」的告警。
 *
 * 判据是 **`times` 不是数组** —— 那是本特性引入的第一个字段，旧宿主一定没有它。
 * ⚠️ 不要用 `nextRunAt === undefined` 判：旧宿主两个字段都没有，但将来若又加字段，
 * 「以哪个字段为准」会含糊。用 `times` 是因为它同时是**面板渲染时刻输入框的数据源**：
 * 没有它，面板上那两个输入框显示的只能是本地的默认值（用户改了也写不进去）。
 */
export function needsHostRestartNotice(state) {
  return state !== null && state !== undefined && !Array.isArray(state.times);
}

/**
 * 点击是否落在「面板 + 触发按钮」构成的下拉容器之内。
 *
 * 命中判据必须用 **DOM 层级**（`contains`），不能用坐标：面板位置会随窗口尺寸、
 * 滚动、缩放进阶变化，坐标判据必然漂移。
 *
 * ⚠️ **容器范围必须同时包含触发按钮**（不是只有面板）。只判面板会让「点 ▾」
 * 先被 document 监听判成「外部」而关闭、紧接着按钮 onClick 又打开
 * ⇒ 表现为「点一次闪一下、关不掉」——这是下拉菜单最常见的陷阱。
 *
 * 抽成纯函数是为了能测：真实 DOM 的 `contains` 行为在 jsdom 之外难以复现，
 * 而「target 是否落在容器内」这一条判据本身是纯逻辑（`contains` 只作为入参能力）。
 *
 * @param contains - 容器是否包含该节点（通常传 `wrap.contains`）。
 * @param target - 事件目标（任意值；非节点按「外部」处理）。
 * @param isNode - 该 target 是否为 DOM 节点。
 * @returns true = 应视为「内部点击」，不关闭面板。
 */
export function isInsideCheckinDock({ contains, target, isNode }) {
  // ⚠️ 非节点（例如 React 传进来的 null、或 jsdom 之外的对象）一律按**外部**处理：
  //   「认不出来就当作内部」会让面板永远关不掉，比误关更难排障。
  if (!isNode) return false;
  if (target === null || target === undefined) return false;
  return contains(target);
}

/**
 * 面板关闭时「该提交什么」的纯判据。
 *
 * ## 为什么单独抽出来（真实缺陷，2026-11-01 实测）
 *
 * 上一版在关闭面板时直接读 React state（`timeDraft` / `jitterOn`），但关闭动作
 * 可能由**早于最后一次 setState 注册的监听**触发（`document` 上的 mousedown
 * 捕获监听在 effect 里注册，其闭包捕获的是注册那一刻的 state）⇒ 读到的是
 * **上一次渲染的旧草稿** ⇒ 用户改完时刻点外部关闭，改动**静默丢失**，
 * 而界面看不出任何异常。
 *
 * 修法是关闭时读 `ref`（始终最新）。本函数给出**纯的**判定与载荷，
 * 让「该不该提交、提交什么」可被单测直接覆盖 —— 否则只能靠人眼看界面，
 * 而它恰恰是「看起来正常」的一类缺陷。
 *
 * @param hostTimes - 宿主当前的时刻（来自 `autoCheckin.times`）。
 * @param hostJitter - 宿主当前的浮动分钟数（0 = 关闭）。
 * @param draftTimes - 用户草稿时刻（**必须是最新值**，不能是陈旧闭包）。
 * @param draftJitterOn - 草稿的浮动开关。
 * @param draftJitterMinutes - 草稿的浮动分钟数。
 * @returns null = 无改动（不必提交）；否则返回要提交的载荷。
 */
export function checkinCommitPlan({ hostTimes, hostJitter, draftTimes, draftJitterOn, draftJitterMinutes }) {
  // 宿主时刻读不到 ⇒ **不提交**：此时草稿只是本地默认值，拿它写盘会把用户的
  // 真实设置覆盖成 09:00/21:00。
  if (!Array.isArray(hostTimes) || hostTimes.length !== 2) return null
  if (!Array.isArray(draftTimes) || draftTimes.length !== 2) return null
  const timesDirty = draftTimes.some((value, index) => value !== hostTimes[index])
  const wantJitter = draftJitterOn ? Math.max(0, Number(draftJitterMinutes) || 0) : 0
  const hostJitterValue = typeof hostJitter === 'number' ? hostJitter : 0
  // 改完又改回去 ⇒ 不写盘（白跑一次 RPC，还可能触发无谓的定时器重排）。
  if (!timesDirty && hostJitterValue === wantJitter) return null
  return { times: [...draftTimes], jitterMinutes: wantJitter }
}