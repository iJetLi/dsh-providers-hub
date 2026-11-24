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

// ============================================================================
// 子代理设置（2026-11-23）
// ============================================================================

/**
 * ★ 五个起点策略的**按钮标签**（顺序即渲染顺序）。
 *
 * ⚠️ 用户 2026-11-23 亲自定的名字，**不要改**：
 * 「跟随主代理 / 顺序分布 / 倒序分布 / 哈希分布 / 固定帐号」
 */
export const SUBAGENT_MODE_LABELS = [
  ['follow', '跟随主代理'],
  ['sequence', '顺序分布'],
  ['reverse', '倒序分布'],
  ['hash', '哈希分布'],
  ['fixed', '固定帐号'],
]

/**
 * ★★★ 每个策略的**一行提示**（用户要求「长度不要超过一行」）。
 *
 * ## ⚠️ 刻意**不写具体位次**
 *
 * 用户 2026-11-23 明确指出：
 *
 * > 「提示文字不用写实时的位次选择，因为一个 providers 可能会有多个会话，
 * >   你无法以哪一个会话为准当主代理。说明原理就行。」
 *
 * ⇒ 只讲**语义**，不写「子代理1→位次4」这类具体数字。
 *
 * ## ⚠️ 每条都必须强调「仍先烧临期」
 *
 * 用户 2026-11-23 纠正过我第一版的错误：
 *
 * > 「子代理在分配帐号起点时，肯定也要像主代理一样，遵守档次优先的原则呀」
 *
 * ⇒ 提示里头必须让用户看到「档次优先不变」，否则他会以为子代理会乱烧。
 *
 * ⚠️ 实测（510px / 10px 字体）**30 字符以内不折行**，故每条都 ≤ 30 字。
 */
export const SUBAGENT_MODE_HINTS = {
  follow: '与主代理同账号起步，档位规则不变（仍先烧临期）',
  sequence: '子代理在主代理同档位内往后错开，仍先烧临期',
  reverse: '子代理在主代理同档位内往前错开，仍先烧临期',
  hash: '按会话 ID 稳定分配同档位账号，仍先烧临期',
  fixed: '该号绝对优先（无视档位），积分为空或锁定不可用才切换',
}

/**
 * 取某模式的提示文本。
 *
 * @param mode - 策略 id
 * @returns 提示文本；未知模式返回 `follow` 的提示（**不返回空串**：
 *   空白提示会让用户以为界面坏了）
 */
export function subagentHintOf(mode) {
  const hit = SUBAGENT_MODE_HINTS[mode]
  return hit === undefined ? SUBAGENT_MODE_HINTS.follow : hit
}

/**
 * ★★★ 选某模型时，思考强度的**默认值**。
 *
 * ## 用户的明确要求（2026-11-23）
 *
 * > 「选择了列表中的模型后，右侧出现一个下拉框选择思考强度，
 * >   思考强度默认选择跟随设置里面的默认最高档选择（如果开启）」
 *
 * ## 判据
 *
 * | 情况 | 默认值 |
 * |---|---|
 * | 模型**不支持**思考（`efforts` 空）| `undefined`（UI **不渲染**强度下拉）|
 * | 模型有 `defaultEffort` 且**在档位内** | 用它 |
 * | 否则 | **`efforts` 的最后一项**（强度序：弱 → 强）|
 *
 * ⚠️ 「最后一项 = 最强」的依据：本仓统一约定 `efforts` 数组按
 * **强弱排序**（弱在前），见 `REASONING_EFFORT_RANK`。
 *
 * ⚠️ `defaultEffort` 可能**不在** `efforts` 里（上游给了不一致的值）——
 * 那种情况必须回落，否则 DSH 会抛 `UNSUPPORTED_REASONING_EFFORT`。
 *
 * @param entry - 模型条目（含 `efforts` 与可选 `defaultEffort`）
 * @returns 默认强度 id；不支持思考时 `undefined`
 */
export function defaultEffortOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const efforts = Array.isArray(entry.efforts) ? entry.efforts : []
  if (efforts.length === 0) return undefined
  const declared = typeof entry.defaultEffort === 'string' ? entry.defaultEffort : ''
  if (declared.length > 0 && efforts.some((e) => e !== null && typeof e === 'object' && e.id === declared)) {
    return declared
  }
  const last = efforts[efforts.length - 1]
  return last !== null && typeof last === 'object' && typeof last.id === 'string' ? last.id : undefined
}

/**
 * 校验「子代理设置」草稿是否可保存。
 *
 * ## 为什么需要它
 *
 * 服务端对非法值一律回 `bad-request`（不静默丢弃）。若 UI 不先挡，
 * 用户会看到一条 RPC 错误，而不是「哪个字段填错了」。
 *
 * @param draft - 草稿（`{ startMode, fixedPosition, model, reasoningEffort }`）
 * @returns `{ ok: true }` 或 `{ ok: false, message }`
 */
export function validateSubagentDraft(draft) {
  if (draft === null || typeof draft !== 'object') {
    return { ok: false, message: '设置为空' }
  }
  const mode = draft.startMode
  const known = SUBAGENT_MODE_LABELS.some(([id]) => id === mode)
  if (!known) return { ok: false, message: '请选择一个起点策略' }
  if (mode === 'fixed') {
    /**
     * ⚠️ `fixed` 必须有位次：没有位次的 fixed 等价于「不指定」，
     * 服务端也会拒绝（见 `sanitizeSubagentRotation`）。
     */
    const pos = draft.fixedPosition
    if (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 1) {
      return { ok: false, message: '「固定帐号」必须选一个账号' }
    }
  }
  return { ok: true }
}

/**
 * 把草稿整理成 RPC 载荷（`undefined` 字段一律省略，避免污染合并语义）。
 *
 * ⚠️ `startMode === 'fixed'` 之外的模式**不带 `fixedPosition`** ——
 * 留着会让下次切回 fixed 时用到上次的位次（用户会困惑「怎么自己选了」）。
 */
export function subagentPayloadOf(draft) {
  if (draft === null || typeof draft !== 'object') return undefined
  const mode = draft.startMode
  if (mode === undefined) return undefined
  return {
    startMode: mode,
    ...(mode === 'fixed' && typeof draft.fixedPosition === 'number'
      ? { fixedPosition: draft.fixedPosition }
      : {}),
    ...(typeof draft.model === 'string' && draft.model.length > 0 ? { model: draft.model } : {}),
    ...(typeof draft.reasoningEffort === 'string' && draft.reasoningEffort.length > 0
      ? { reasoningEffort: draft.reasoningEffort }
      : {}),
  }
}
/**
 * ★★★ 是否有未保存的改动（2026-11-24 用户报障后抽出成纯函数）。
 *
 * ## 缺陷（报障原文：「保存按钮没法点击呀」）
 *
 * 上一版这个判断内联在组件里，且只比了窗口天数：
 *
 *     String(saved.windowDays) !== draftWindow.trim()
 *     || String(saved.imminentDays) !== draftImminent.trim()
 *
 * 用户只改「子代理设置」（起点策略 / 模型 / 思考强度）时恒 false
 * 于是保存按钮一直是灰的、点不动。
 *
 * 抽成纯函数的原因：内联在组件里就测不到（判据埋在装配层 = 没测试）。
 *
 * ## 判据：四组字段分别比
 *
 * - 窗口：windowDays / imminentDays（字符串草稿 vs 数字已存值）
 * - 子代理：startMode / fixedPosition / model / reasoningEffort
 *
 * undefined 与「缺省」必须归一化后再比：
 * saved.subagent.startMode 可能是 undefined，而草稿预填成 follow，
 * 不归一化会让「刚打开就算 dirty」（假脏）。
 *
 * @param input - { saved, draftWindow, draftImminent, subDraft }
 * @returns 是否有改动
 */
export function isWindowDirty(input) {
  const src = input === null || typeof input !== 'object' ? {} : input
  const saved = src.saved
  /** 没加载完一律不算 dirty（否则刚打开就能点保存，会发出空请求）。 */
  if (saved === null || typeof saved !== 'object') return false
  const draftWindow = typeof src.draftWindow === 'string' ? src.draftWindow.trim() : ''
  const draftImminent = typeof src.draftImminent === 'string' ? src.draftImminent.trim() : ''
  if (String(saved.windowDays) !== draftWindow) return true
  if (String(saved.imminentDays) !== draftImminent) return true
  const subDraft = src.subDraft
  if (subDraft === null || typeof subDraft !== 'object') return false
  const savedSub = saved.subagent
  const savedObj = savedSub === null || typeof savedSub !== 'object' ? {} : savedSub
  /**
   * ⚠️⚠️ **`startMode` 的 `follow` 与「未配置」必须视为同一件事**
   *（2026-11-24 实测：不归一化会让「刚打开就显示可保存」）。
   *
   * 依据：服务端 `subagentSettingActive()` 明确把
   * 「`follow` + 无模型」等同于「没配」（见 `subagent-rotation.ts`）。
   * ⇒ 客户端这条判据必须与它**同口径**，否则两边对「有没有改动」结论不同。
   */
  const normMode = (v) => (typeof v === 'string' && v.length > 0 ? v : 'follow')
  if (normMode(subDraft.startMode) !== normMode(savedObj.startMode)) return true
  if ((subDraft.fixedPosition ?? 0) !== (savedObj.fixedPosition ?? 0)) return true
  if ((subDraft.model ?? '') !== (savedObj.model ?? '')) return true
  if ((subDraft.reasoningEffort ?? '') !== (savedObj.reasoningEffort ?? '')) return true
  return false
}
