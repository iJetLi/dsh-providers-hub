/**
 * 左侧供应商导航的分组与「一键开关」状态判定（纯逻辑）。
 *
 * ## 为什么单独成文件
 *
 * 与 `model-bulk.js` / `model-filter.js` / `account-model-link.js` 同理：本仓库
 * 的单测环境里 react 不在依赖内，组件无法渲染。把判定抽成纯函数才能用真实断言
 * 覆盖，而不是靠源码级字符串匹配间接验证。
 *
 * ## 「已关闭」的判据不在前端重算
 *
 * 判据是「该供应商的**全部模型都已关闭**」，由宿主侧 `provider.status` 端点的
 * `closed` 字段直接给出，本模块**只读不判**。
 *
 * 这是刻意的：宿主侧要按 id 逐个比对全量目录与黑名单才能算准，前端若再实现一遍
 * （比如拿 `disabled` 计数自行比较），两处判据迟早会漂移 —— 典型症状是
 * 「左侧说已关闭、账号联动却说模型没全关」这种自相矛盾。
 *
 * ⚠️ 宿主侧 `closed` 与 `account-model-link.js` 的 `allModelsDisabled(models)`
 * 是**语义同源、形态不同**的一对（一个看计数、一个看条目数组），它们的边界条件
 * 必须一起改：都要求「至少有一个模型」才算全部关闭 —— 没有任何模型时不算已关闭
 * （没有模型可关，就不该说它被关闭了）。
 */

import { orderAfterDrop } from './account-order.js';

export const PINNED_PROVIDER_IDS = Object.freeze(['aggregate']);

export function isPinnedProvider(id) {
  return PINNED_PROVIDER_IDS.includes(id);
}

export function splitPinnedProviders(providers) {
  const list = Array.isArray(providers) ? providers : [];
  const pinned = [];
  const channels = [];
  for (const provider of list) {
    if (isPinnedProvider(provider?.id)) pinned.push(provider);
    else channels.push(provider);
  }
  return { pinned, channels };
}

/**
 * 左侧导航的「分区」：置顶块 + 已打开/已关闭两组。
 *
 * ⚠️ 为什么单独抽出来：`renderRail` 里剩下的只有 `React.createElement` 的拼装，
 * 而「聚合必须从渠道里被拆走」这件事**只能靠源码正则**验证（`renderRail` 是闭包、
 * 没有导出）。实测过两个能绕过的变异：
 *   - `const { pinned } = splitPinnedProviders(PROVIDERS); const channels = PROVIDERS;`
 *     ⇒ 源码断言仍命中（`splitPinnedProviders(PROVIDERS)` 还在），9 条全绿；
 *   - `groupProviders(PROVIDERS, …)` 换成 `groupProviders(channels, …)`（`channels`
 *     是别名）⇒ 同上，`not.toContain('groupProviders(PROVIDERS, …)')` 也命中。
 * ⇒ 把「拆分 + 分组」抽成这个**纯函数**，由 `tests/unit/rail-pinned-aggregate.spec.ts`
 * 行为级断言（传真的 `PROVIDERS` 进来，看 `open`/`closed` 里到底有没有聚合）。
 *
 * @param {readonly {id?: string}[]} providers 全量供应商（`PROVIDERS`）
 * @param {Record<string, {closed?: boolean}> | null} statuses 供应商状态；`null` = 还没读到
 * @returns {{ pinned: {id?: string}[], channels: {id?: string}[], open: {id?: string}[], closed: {id?: string}[] }}
 *   `pinned` 是置顶渠道（不进任何一组）、`channels` 是拆掉置顶后的普通渠道、
 *   `open`/`closed` 只在 `statuses !== null` 时有内容（`null` 时都是 `[]`）。
 */
export function buildRailSections(providers, statuses) {
  const { pinned, channels } = splitPinnedProviders(providers);
  if (statuses === null) return { pinned, channels, open: [], closed: [] };
  const { open, closed } = groupProviders(channels, statuses);
  return { pinned, channels, open, closed };
}

/**
 * 按「已打开 / 已关闭」把供应商分成两组。
 *
 * - 组内**保持传入顺序**（即 `PROVIDERS` 的声明顺序），不做任何重排：用户对
 *   供应商的认知顺序是稳定的，每次刷新都按别的方式排序会让人找不到它。
 * - 状态缺失（`provider.status` 尚未返回、或该 provider 不在响应里）一律归入
 *   **已打开**：宁多勿少。若归入已关闭，一次请求失败就会让整列供应商看起来
 *   被关掉了，用户会以为数据丢了。
 * - `closed` 只认**显式 `true`**：与适配器黑名单「只有显式 true 才算关闭」
 *   的判据保持一致。
 *
 * @param {Array<{ id: string }>} providers 供应商定义列表（顺序即展示顺序）
 * @param {Record<string, { closed?: boolean }> | null} statuses provider id → 状态
 * @returns {{ open: Array<object>, closed: Array<object> }}
 */
export function groupProviders(providers, statuses) {
  const list = Array.isArray(providers) ? providers : [];
  const map = statuses && typeof statuses === 'object' ? statuses : {};
  const open = [];
  const closed = [];
  for (const provider of list) {
    // ⚠️ 局部变量**不能**叫 `closed`：那会遮蔽上面要收集结果的 `closed` 数组，
    // 于是 `closed.push` 变成在布尔值上调用方法、抛 `closed.push is not a function`
    // （真实缺陷，已由单测捕获）。命名为 `isClosed` 以明确它是判定而非容器。
    const isClosed = map[provider?.id]?.closed === true;
    if (isClosed) closed.push(provider);
    else open.push(provider);
  }
  return { open, closed };
}

/**
 * 计算某个供应商开关的呈现状态。
 *
 * 三种形态（对应原型的「已打开 / 已关闭 / 禁用」）：
 * - **已打开**：`checked = true`，可点击 → 点击即关闭它；
 * - **已关闭**：`checked = false`，可点击 → 点击即打开它；
 * - **禁用**：`disabled = true` 且附 `reason`，不可点击。
 *
 * 禁用的判据是 `models.total === 0`（没有任何可用模型）。这直接落实
 * 「不关闭模型就不关闭供应商」：没有模型可关时，关闭动作在服务端会被拒绝
 * （见 `provider.setEnabled`），故开关**不该让用户点得动** —— 否则点击后
 * 只得到一句错误提示，属于把服务端的约束暴露成用户的操作挫折。
 *
 * 状态未知（undefined / 字段缺失）同样禁用：此时既不知道它开没开，也不知道
 * 有几个模型，让用户点一个状态不明的开关更糟。分组那边则仍把它显示在「已打开」
 * 组（宁多勿少），两处取舍不同是有意的 —— 显示可以保守，操作必须明确。
 *
 * @param {{ models?: { total?: number }, accounts?: { total?: number }, closed?: boolean, verifyFailed?: string } | undefined} status
 * @returns {{ checked: boolean, disabled: boolean, reason: string | null }}
 */
export function providerSwitchState(status) {
  if (status === undefined || status === null || typeof status !== 'object') {
    return { checked: true, disabled: true, reason: '状态尚未读取' };
  }
  const total = typeof status.models?.total === 'number' ? status.models.total : 0;
  // ⚠️⚠️ **「已关闭」优先于「没有模型可关」**（Gitee issue IKP8OF，真实死锁）。
  //
  // 顺序不能反。`closed === true` 的供应商**必须永远可点开**，即使 `total === 0`：
  // 那种形态真实可达 —— 用户关闭了某供应商，随后它的账号被全部删除 / 目录被清空
  // ⇒ `total` 变成 0。若这里先判 `total <= 0` 而返回 `disabled: true`，
  // 开关就变成**点不动的「已关闭」**：用户既关不掉也打不开，且没有任何出路
  //（只能手工编辑 `state.json`）。
  //
  // 「`total <= 0` ⇒ 禁用」这条判据的**本意**是「没有模型可关 ⇒ 关闭动作会被
  // 服务端拒绝，别让用户白点」（见上面的方法头），它约束的是**关闭**方向；
  // 已关闭时用户要做的恰恰是**打开**，那个方向永远合法（`provider.setEnabled(true)`
  // 不读目录、纯本地清黑名单 + 清意图）。
  if (status.closed === true) return { checked: false, disabled: false, reason: null };
  // ⚠️⚠️ **核实失败时不得让用户点**（2026-11-05 三审 P1-2）。
  //
  // 走到这里说明 `closed === false`（派生判据说没关），但**这次核实没成功**
  // （`provider.status` 的 `verifyFailed` 有值）⇒ 我们其实**不知道**它到底关没关。
  // 此时让用户点「关闭」，服务端会再核实一次、大概率还是失败，用户只得到一句
  // 与现场无关的错误。
  //
  // 而这个缺陷的**症状**正是「界面、开关、报错三者互相矛盾」：
  // - 分组标题说「已关闭」（意图为真，`closedByIntent`）；
  // - 开关显示「已打开」（`closed: false`）；
  // - 点一下弹「核实不了」。
  //
  // ⇒ 把这次失败的原因**直接展示**出来（禁用 + 附注），三者终于自洽。
  //
  // ⚠️ 顺序必须在 `closed === true` **之后**：已关闭时用户要做的恰恰是**打开**，
  //    那个方向永远合法、且不依赖目录（见上一条注释）。
  if (typeof status.verifyFailed === 'string' && status.verifyFailed.length > 0) {
    return {
      checked: true,
      disabled: true,
      reason: `暂时无法核实：${status.verifyFailed}`,
    };
  }
  if (total <= 0) {
    return {
      checked: true,
      disabled: true,
      reason: '该供应商没有可关闭的模型',
    };
  }
  return { checked: true, disabled: false, reason: null };
}

/**
 * 把一次供应商开关操作的结果汇总成一行可读文案。
 *
 * 要点：**实际变更数可能与预期不同**。例如两个账号本就已停用，关闭供应商时
 * `accounts` 会返回 0 —— 提示必须照实说「无需变更」，而不是恒定报「已停用 2 个」，
 * 后者会让用户以为自己没看到的改动发生了。
 *
 * @param {boolean} enabled 目标状态
 * @param {{ models?: number, accounts?: number } | null} res 端点返回的变更数
 * @returns {string}
 */
export function summarizeProviderToggle(enabled, res) {
  const models = typeof res?.models === 'number' ? res.models : 0;
  const accounts = typeof res?.accounts === 'number' ? res.accounts : 0;
  if (enabled) {
    const parts = [];
    parts.push(models > 0 ? `已打开 ${models} 个模型` : '模型本就全部打开');
    parts.push(accounts > 0 ? `已启用 ${accounts} 个账号` : '账号本就全部启用');
    return parts.join('，');
  }
  const parts = [];
  parts.push(models > 0 ? `已关闭 ${models} 个模型` : '没有模型需要关闭');
  parts.push(accounts > 0 ? `已停用 ${accounts} 个账号` : '没有账号需要停用');
  return parts.join('，');
}

/**
 * 把「已打开」组按用户拖拽得到的自定义顺序排（纯函数）。
 *
 * ## 口径（2026-10-06，用户需求「供应商开关支持拖动排序」）
 *
 * - `order` = 宿主持久化的最近一次拖拽提交顺序（数组含全部供应商 id）；
 *   `null` / 空数组 / 缺失 = 未自定义 → **完全保持传入顺序**，与不传一致；
 * - 已打开组：`order` 中出现且已打开的排前（按数组序），未出现的按传入
 *   （声明）顺序稳定补后 —— 数组里残留的已关闭 id 与未知 id 天然被跳过；
 * - 已关闭组**不经过本函数**：它恒按声明顺序沉底（见 {@link providerSwitchRows}），
 *   自定义排序不覆盖关闭组。
 *
 * ⚠️ 排序必须**稳定**：`Array.prototype.sort` 自 ES2019 起规范保证稳定，
 * 两个都未定位的条目保持声明相对顺序 —— 依赖该保证，勿换成非稳定排序。
 *
 * @param {Array<{ id: string }>} openProviders 已打开组的供应商（传入顺序即声明顺序）
 * @param {string[] | null | undefined} order 宿主持久化的自定义顺序
 * @returns {Array<object>} 排序后的新数组（不修改入参）
 */
export function sortOpenProvidersByOrder(openProviders, order, declaredOrder) {
  const list = Array.isArray(openProviders) ? openProviders : [];
  const seq = Array.isArray(order) ? order : [];
  if (seq.length === 0) return list;
  const rank = new Map();
  for (let index = 0; index < seq.length; index++) {
    const id = seq[index];
    if (typeof id === 'string' && id.length > 0 && !rank.has(id)) rank.set(id, index);
  }
  if (rank.size === 0) return list;

  /**
   * ⚠️⚠️ **顺序表里缺失的 provider 要按「声明位置」补位，不能一律缀尾**
   * （真实缺陷，2026-10-17 用户报障「minimax 国际版的顺序应该在中国版下面」）。
   *
   * ## 症状
   *
   * `providerOrder` 是**用户拖拽时快照下来的全量 id 数组**。插件后来新增
   * provider 时，老用户的数组里**没有新 id** —— 于是新 provider 一直排在
   * **所有已自定义项之后**（末位），而它在注册表里的声明位置可能紧挨着某个
   * 相关项（`minimaxintl` 声明在 `minimax` 之后，却显示在最后）。
   * 老用户**不重新拖一次就永远好不了**，而且他根本不知道要拖。
   *
   * 实测本机 `state.json`：那份顺序表缺 **6 个**新增 provider
   * （`minimaxintl` / `officeace` / `accio` / `autoclaw` / `modelscope` /
   * `aggregate`），它们全部被缀到末尾。
   *
   * ## 修法
   *
   * 用 `declaredOrder`（注册表声明顺序）给**缺失的 id** 计算「应该排在哪」：
   * 取它在声明序里**前面最近的一个已定位 id** 作锚点，排到锚点之后；
   * 若前面没有任何已定位 id（声明在最前），排到最前。
   *
   * ⇒ `[… minimax, zcode …]` + 声明序里 `minimaxintl` 紧跟 `minimax`
   *   ⇒ `minimaxintl` 落回 `minimax` 后面，正是用户期望的位置。
   *
   * ⚠️ **`declaredOrder` 缺省时退化为旧行为**（缺失项缀尾）：不是所有调用点
   * 都拿得到声明序，旧行为本身不算错（只是不够好）⇒ 保持向后兼容。
   *
   * ⚠️ 排序必须**稳定**：同一锚点后插入多个缺失项时，按它们在声明序里的
   * 下标做次级键，保持声明相对顺序。
   *
   * @param {Array<{ id: string }>} openProviders 已打开组的供应商（传入顺序即声明顺序）
   * @param {string[] | null | undefined} order 宿主持久化的自定义顺序
   * @param {string[] | null | undefined} [declaredOrder] 注册表的**声明顺序**
   *   （即全部 provider id，按声明排列）。传入才能把缺失项补到正确位置。
   */
  const declared = Array.isArray(declaredOrder) ? declaredOrder : [];
  if (declared.length > 0) {
    /** 缺失 id → 它的锚点（声明序里前面最近的已定位 id；null = 排最前）。 */
    const anchorOf = new Map();
    for (let index = 0; index < declared.length; index++) {
      const id = declared[index];
      if (typeof id !== 'string' || id.length === 0) continue;
      if (rank.has(id)) continue;  // 已定位的不动
      let anchor = null;
      for (let back = index - 1; back >= 0; back--) {
        const prev = declared[back];
        // ⚠️ 锚点可以是另一个**缺失**项 —— 这时要看它自己有没有锚点（链式）。
        if (rank.has(prev) || anchorOf.has(prev)) { anchor = prev; break; }
      }
      anchorOf.set(id, anchor);
    }
    if (anchorOf.size > 0) {
      /**
       * 把「锚点链」折算成可比较的键。
       *
       * ⚠️ 用「锚点的键 + 声明下标的小数偏移」而不是「真的插进数组」：
       * 后者会让后续 rank 全部重排，容易与既有 `orderAfterDrop` 的语义打架；
       * 这里只需要一个**单调可比较的键**。
       * ⚠️ 按声明序**先后**处理，保证链式锚点（A 缺、B 也缺且锚点=A）能算对。
       */
      const effective = new Map(rank);
      for (const [id, anchor] of anchorOf) {
        const declaredIndex = declared.indexOf(id);
        const anchorKey = anchor === null ? -1 : (effective.get(anchor) ?? -1);
        effective.set(id, anchorKey + declaredIndex / (declared.length + 1));
      }
      return [...list].sort((a, b) => {
        const ra = effective.get(a?.id);
        const rb = effective.get(b?.id);
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return 0;
      });
    }
  }

  return [...list].sort((a, b) => {
    const ra = rank.get(a?.id);
    const rb = rank.get(b?.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
}

/**
 * 拖拽落点之后的**完整**顺序（纯函数）。
 *
 * ## 数组语义
 *
 * 结果数组 = 「已打开组的目标顺序 + 已关闭组的**位置占位**」。展示侧只读
 * 它的**已打开**部分（关闭组恒按声明顺序渲染），尾段内容不影响渲染，
 * 但**必须**把已关闭的 id 写回去 —— 它们是「重开时回到哪一位」的唯一依据。
 *
 * ## ⚠️ 已关闭 id 的位置由「它在旧顺序里的直接前驱」决定
 *
 * 真实缺陷（PR #63 初版）：已关闭 id 被**无条件缀尾**，于是只要在它关闭
 * 期间又拖了一次，它在旧数组里的位置就永久丢失 —— 重开后掉到未定位段，
 * 与「重新打开曾排序过的供应商 → 回到它原来的位置」这条承诺直接矛盾。
 *
 * ```
 * order = [a, b, d, c]   （用户把 d 拖到了 b 之后）
 * 关闭 d，再拖一次 c → 若按缀尾写回 = [a, c, b, d]
 * 重开 d → 落在末尾 ❌（承诺是回到 b 旁边）
 * ```
 *
 * 位置本身不必精确记录一个下标 —— 记住它在旧顺序里的**直接前驱**（这里是
 * `b`）即可，重开时插到 `b` 之后；open 段被整体重排也不影响这个相对位置。
 * ⚠️ 刻意**不用**「前面有几个已打开项」：那种计数会随他人被拖动而漂移，
 * 而用户的心智是「我把它排在那行**旁边**」。
 *
 * ## 为什么保留旧相对位置、而不是每次都按声明序缀尾
 *
 * 声明序兜底只在「从未自定义过顺序」（无 `oldOrder`）时成立；一旦用户拖过，
 * 声明序就不再是他心里的位置。反过来，**无已关闭 id** 时结果与旧实现逐字
 * 相同（只有 open 段），既有行为完全不受影响。
 *
 * @param {string[]} openIds 当前展示中已打开的供应商 id（展示顺序）
 * @param {string[]} closedIds 已关闭的供应商 id（展示顺序，恒为声明序）
 * @param {string} sourceId 被拖动的 id
 * @param {string} targetId 落点 id
 * @param {'before' | 'after'} position 插到落点之前还是之后
 * @param {string[] | null | undefined} [oldOrder] 上一次提交的完整顺序（用于
 *   还原已关闭 id 的位置）；缺省时退化为按展示顺序缀尾
 * @returns {string[] | null} 新顺序；无需变更时返回 null（同 {@link orderAfterDrop}）
 */
export function nextProviderOrderAfterDrop(openIds, closedIds, sourceId, targetId, position, oldOrder) {
  const moved = orderAfterDrop(openIds, sourceId, targetId, position);
  if (moved === null) return null;
  if (!Array.isArray(closedIds) || closedIds.length === 0) return moved;
  // 无旧顺序可依据（从未自定义过）→ 退化为按展示顺序缀尾。
  if (!Array.isArray(oldOrder) || oldOrder.length === 0) return [...moved, ...closedIds];

  // 记录每个已关闭 id 在旧顺序里的**直接前驱**（前一个已打开项）。
  // ⚠️ 必须用 **openIds**（当前已打开集合）判断「哪些算已打开」——旧顺序里
  // 可能混有已删除的 provider id（跨版本增删），它们既不是 open 也不是 closed。
  // 用「前驱」而非「前面有几个 open」：用户的心智是「我把它排在那行旁边」，
  // 贴着前驱才能在别人被拖动后仍然跟住（按计数则会跟着下标漂移）。
  const openSet = new Set(openIds);
  const closedSet = new Set(closedIds);
  /** @type {Map<string, string | null>} closedId → 旧顺序里的直接 open 前驱（null = 排最前） */
  const predecessor = new Map();
  let lastOpen = null;
  for (const id of oldOrder) {
    if (openSet.has(id)) { lastOpen = id; continue; }
    if (closedSet.has(id) && !predecessor.has(id)) predecessor.set(id, lastOpen);
  }

  // 逐个插回：前驱已在新 open 序列里 → 紧跟其后；跟不住的（孤儿）最后统一沉尾。
  const result = [...moved];
  // ⚠️ 孤儿（`oldOrder` 里查不到、或其前驱不在新 open 段内）只能沉尾：
  // 查不到前驱 ⇒ 无从判断它「排在哪一行旁边」，沉尾是最保守且可预期的选择
  // （实测：前驱缺失 / 前驱是已删除 id，两种都落到末位）。
  const orphans = [];
  // ⚠️ 必须**按旧顺序分组整块插入**，不能逐个 splice 到前驱之后：
  // 多个已关闭 id 可能共享同一前驱（old=[a,b,d,e,c]，d 与 e 的前驱都是 b），
  // 逐个插会让后一个挤到前一个**前面**（实测得到 b,e,d，与旧序相反）。
  /** @type {Map<string, string[]>} 前驱 → 挂在它后面的已关闭 id（保持旧序） */
  const groups = new Map();
  for (const id of oldOrder) {
    if (!closedSet.has(id) || !predecessor.has(id)) continue;
    const pred = predecessor.get(id);
    // `pred === null` 表示它在旧顺序里排最前（前面没有任何已打开项）→ 跟不住，沉尾。
    if (pred === null) { orphans.push(id); continue; }
    if (!groups.has(pred)) groups.set(pred, []);
    // ⚠️ 不要写 `groups.get(pred)!.push(id)`：本文件是 .js（非 TS），
    // 非空断言 `!` 会被构建链的解析器拒收（实测 build/test 直接报 Parse failure）。
    groups.get(pred).push(id);
  }
  for (const [pred, ids] of groups) {
    const at = result.indexOf(pred);
    if (at === -1) { orphans.push(...ids); continue; }   // 前驱不在新 open 段里
    result.splice(at + 1, 0, ...ids);
  }
  // `closedIds` 里连旧顺序都没出现过的（跨版本新增）→ 同样沉尾，保证不丢 id。
  for (const id of closedIds) if (!result.includes(id)) orphans.push(id);
  for (const id of orphans) result.push(id);
  return result;
}

/**
 * 拖拽落点之后的完整顺序 —— **两组都能拖**（2026-10-26 用户需求）。
 *
 * ## 为什么要分成「组内」与「跨组」
 *
 * 组间顺序是**固定**的：已打开恒在前、已关闭恒在后（{@link providerSwitchRows}
 * 保证）。用户把已关闭行拖到已打开行上面时，渲染结果会立刻弹回原位 ——
 * 那种「拖得动但落不下」比拖不动更让人困惑。故跨组拖拽一律返回 `null`
 * （= 无需变更，调用方不提交）。
 *
 * ## 两个分支
 *
 * - **两组都在已打开里** → 走 {@link nextProviderOrderAfterDrop}（既有逻辑：
 *   已关闭 id 按「旧顺序里的直接前驱」插回，重开时回到用户排过的位置）。
 * - **两组都在已关闭里** → 只在 closed 段内做 {@link orderAfterDrop}，open 段
 *   原样保持。⚠️ 这里**不能**走 `nextProviderOrderAfterDrop`：它假设 source 在
 *   open 段里，已关闭的 source 在 open 段查不到 ⇒ 直接返回 `null`。
 *
 * ## 结果数组的形状
 *
 * 返回 `[...openIds, ...新 closed 顺序]`。已打开段用**展示顺序**而非原 order
 * 片段 —— 两者等价：展示顺序本身就是 `order` 经
 * {@link sortOpenProvidersByOrder} 稳定排序得到的，且排序只看组内相对次序。
 *
 * @param {string[]} openIds 当前展示中已打开的供应商 id（展示顺序）
 * @param {string[]} closedIds 已关闭的供应商 id（展示顺序）
 * @param {string} sourceId 被拖动的 id
 * @param {string} targetId 落点 id
 * @param {'before' | 'after'} position 插到落点之前还是之后
 * @param {string[] | null | undefined} [oldOrder] 上一次提交的完整顺序
 * @returns {string[] | null} 新顺序；跨组或无需变更时返回 null
 */
export function nextProviderOrderAfterGroupDrop(
  openIds, closedIds, sourceId, targetId, position, oldOrder,
) {
  const open = Array.isArray(openIds) ? openIds : [];
  const closed = Array.isArray(closedIds) ? closedIds : [];
  const sourceInOpen = open.includes(sourceId);
  const targetInOpen = open.includes(targetId);
  const sourceInClosed = closed.includes(sourceId);
  const targetInClosed = closed.includes(targetId);

  if (sourceInOpen && targetInOpen) {
    return nextProviderOrderAfterDrop(open, closed, sourceId, targetId, position, oldOrder);
  }
  if (sourceInClosed && targetInClosed) {
    const moved = orderAfterDrop(closed, sourceId, targetId, position);
    if (moved === null) return null;
    return [...open, ...moved];
  }
  // 跨组（或 id 不在任一组里）：组间顺序不可改，视为无变更。
  return null;
}

/**
 * 「供应商开关」弹窗的行数据：已打开在前、已关闭在后，每行自带开关呈现状态。
 *
 * ## 为什么单独抽出来
 *
 * 弹窗要渲染的既不是「供应商定义」也不是「状态表」，而是两者的**拼接结果**：
 * 顺序（分组）、勾选态、禁用态与原因、影响面计数。留在组件里就等于把判定
 * 写回 UI —— 本模块的存在前提正是「判定不落在渲染层」（见文件头）。
 *
 * ## 三条必须保住的口径
 *
 * - **分组直接复用 {@link groupProviders}**：与左侧 rail 用的是同一份
 *   判据，两处不可能出现「左侧说它关了、弹窗里它还是开的」。
 *   ⚠️ 组内顺序有例外：传入 `order`（宿主持久化的自定义顺序）时，**已打开**
 *   组按 {@link sortOpenProvidersByOrder} 重排，**已关闭**组仍按声明顺序
 *   沉底 —— 这是 2026-10-06 用户明确的需求口径：「关闭的供应商仍按默认排序
 *   显示在最下面，这个逻辑不变」。
 * - **勾选态与禁用态直接复用 {@link providerSwitchState}**：包括那条容易漏的
 *   「`models.total === 0` ⇒ 禁用并给出原因」—— 没有模型可关时服务端会拒绝
 *   关闭动作，让用户点得动只会得到一句错误提示。
 * - **计数原样带出，不在这里格式化**：文案属于渲染层，判据属于本模块。
 *   拿不到状态时给 `null` 而不是 `{total:0}` —— 二者含义不同：
 *   「不知道」与「确实是 0 个」在界面上必须区别对待（前者显示 `—`）。
 *
 * @param {Array<{ id: string, label?: string }>} providers 供应商定义（顺序即默认顺序）
 * @param {Record<string, object> | null} statuses provider id → `provider.status` 条目
 * @param {string[] | null | undefined} [order] 宿主持久化的自定义顺序（未自定义传空/不传）
 * @returns {Array<{ id: string, label: string, checked: boolean, disabled: boolean,
 *   reason: string | null, models: {total?: number, disabled?: number} | null,
 *   accounts: {total?: number, enabled?: number} | null }>}
 */
export function providerSwitchRows(providers, statuses, order) {
  const { open, closed } = groupProviders(providers, statuses);
  // 两组都支持自定义排序（2026-10-26 用户需求「已关闭的供应商也应该支持调整顺序」）。
  // ⚠️ 在此之前只有已打开组走 `order`，已关闭组恒按声明顺序沉底 —— 那条口径
  //    来自 2026-10-06 的「关闭的仍按默认排序显示在最下面」，现已被新需求覆盖。
  //    组间顺序不变：已打开恒在前、已关闭恒在后，`order` 只影响**组内**排列。
  const orderedOpen = sortOpenProvidersByOrder(open, order);
  const orderedClosed = sortOpenProvidersByOrder(closed, order);
  /** @param {{ id: string, label?: string }} provider */
  const toRow = (provider) => {
    const id = provider?.id;
    const status = statuses && typeof statuses === 'object' ? statuses[id] : undefined;
    const sw = providerSwitchState(status);
    return {
      id,
      label: provider?.label || id,
      checked: sw.checked,
      disabled: sw.disabled,
      reason: sw.reason,
      models: status?.models ?? null,
      accounts: status?.accounts ?? null,
    };
  };
  // 已打开在前：与 rail 的分组顺序一致，用户在两处看到的是同一个排列。
  // 两组各自按 `order` 重排，组间顺序恒为「已打开 → 已关闭」。
  return [...orderedOpen.map(toRow), ...orderedClosed.map(toRow)];
}

/**
 * 供应商开关的计数摘要（页头按钮的 tooltip 与弹窗副标题共用）。
 *
 * `statuses` 为 null（尚未读到 / 读取失败）时三个计数都是 0 —— 调用方据此
 * **不显示计数**，而不是显示「0 / 0」让用户以为一个供应商都没有。
 *
 * @param {Array<{ id: string }>} providers
 * @param {Record<string, object> | null} statuses
 * @returns {{ open: number, closed: number, total: number, known: boolean }}
 */
export function providerToggleSummary(providers, statuses) {
  const list = Array.isArray(providers) ? providers : [];
  const { open, closed } = groupProviders(list, statuses);
  return {
    open: open.length,
    closed: closed.length,
    total: list.length,
    known: statuses !== null && statuses !== undefined && typeof statuses === 'object',
  };
}
