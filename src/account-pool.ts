import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { BuddyCredential } from './buddy.js'
import type { BuddyProduct } from './product.js'
import { createJetHubStore, clearRejectionLayer, DEFAULT_PANEL_ENTRY, isValidResetAtMs, MAX_DATE_MS, mergeLegacyLoomyLock, sanitizeAccounts, sanitizeAggregateAllowed, sanitizeAggregateOrder, sanitizeAggregateOrderMode, sanitizeAggregateRejections, sanitizeDisabledModels, sanitizeMinimaxXff, sanitizePanelEntry, sanitizePermanentLocks, sanitizeProviderClosed, withAllowed, withoutAllowed } from './jet-hub-store.js'
import type { AggregateAllowedMap, AggregateOrderMap, AggregateOrderMode, AggregateRejectionMap, JetHubStore, JetHubState, ModelDisableMap, PanelEntry, PermanentLockMap, ProviderClosedMap } from './jet-hub-store.js'
import { createPermanentLockStore } from './permanent-lock-store.js'
import type { PermanentLockStore } from './permanent-lock-store.js'
import { normalizeOpencodeGeneration } from './opencode-auth.js'
import { maskProxyPassword } from './proxy-mask.js'
// ⚠️ `model-queue.ts` **零 import**（纯函数模块，见其模块头）⇒ 不引入环。
import { nextUtc8DayStartMs } from './model-queue.js'
import { readTokenLedgerDayMap, utc8DayKey } from './token-ledger.js'
import { accountLoadIndex, overflowRequestsThreshold, rankAccountsBySession, rankAccountsBySessionWithOverflow, shuffleAccounts } from './session-balance.js'
import type {
  CodeArtsCredential,
  ProviderAccountEntry,
  ProviderAccountStatus,
} from './types.js'

// 兼容既有的导入路径：命名空间名与黑名单类型原本定义在本模块。
export { JET_HUB_NS } from './jet-hub-store.js'
export type { ModelDisableMap, ProviderClosedMap } from './jet-hub-store.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    accountPool: AccountPool
  }
}

/**
 * 空黑名单的共享只读实例。
 *
 * 适配器的 `listModels` 每次都会被模型目录调用，绝大多数 provider/时刻都
 * 没有黑名单；共享同一个冻结集合可以避免每次调用都分配一个新 Set。
 */
const EMPTY_MODEL_SET: ReadonlySet<string> = new Set<string>()

/**
 * 判定「某 provider 的启用账号是否**全部**因目标模型处于限流期」。
 *
 * ## 为什么需要它
 *
 *
 * 选号按 `modelRateLimits[modelId]` 过滤候选（见本类的 `getAvailableAccount`
 * 与 `src/credential-resolver.ts` 的候选筛）。当一个 provider 只有**一个**
 * 启用账号、而它恰好被标记了该模型的限流时，候选集变成空集，调用链一路
 * 返回 `undefined`，最终由适配器抛出「no usable credential; log in from the
 * Jet Hub panel first」—— 而**凭据其实是好的、账号也是启用的**，用户被指去
 * 重新登录，方向完全错。
 *
 * 本函数把这种情形**证明**出来：返回非 `undefined` 即表示「这批账号全都因
 * 该模型受限」，调用方据此报带解禁时刻的明确错误。
 *
 * ⚠️ **判据必须窄**，两条边界都不能松：
 * - 空 `modelId`（未知目标模型）直接返回 `undefined` —— 与选号侧约定一致
 *   （空 modelId 不做限流过滤），否则会把「未登录」误报成「限流」。
 *   这条**不是**冗余守卫：`updateModelRateLimit` 不校验 modelId，理论上可能
 *   落下一个 `modelRateLimits['']` 脏键，没有它就会被当成真实限流上报；
 * - 只要**任一**账号没有该模型的未过期标记，整体即不成立 —— 那种情况下
 *   候选本就非空，轮不到本函数说话。
 *
 * ℹ️ 空 `accounts` 无需单独早退：循环不执行 → `earliest` 保持 `undefined`
 * → 末尾守卫返回 `undefined`。（曾写过一条 `accounts.length === 0` 早退，
 * 反向验证证明它**不可区分**、纯冗余，故删除。）
 *
 * @param accounts - 该 provider 的**启用**账号（调用方负责按 `enabled` 过滤）。
 * @param modelId - 目标模型 id；空串表示不判定。
 * @param now - 当前时刻（毫秒），供测试注入。
 * @returns 最早的解禁时刻与账号数；不满足条件时为 `undefined`。
 */
export function allAccountsRateLimitedForModel(
  accounts: readonly ProviderAccountEntry[],
  modelId: string,
  now: number = Date.now(),
): { resetAtMs: number; accountCount: number } | undefined {
  if (modelId.length === 0) return undefined
  let earliest: number | undefined
  for (const account of accounts) {
    const resetAt = account.modelRateLimits?.[modelId]
    // 与选号侧同一判据：缺标记 / 0 / 已过期都算「不受限」→ 整体不成立。
    if (resetAt === undefined || resetAt === 0 || now >= resetAt) return undefined
    earliest = earliest === undefined ? resetAt : Math.min(earliest, resetAt)
  }
  return earliest === undefined ? undefined : { resetAtMs: earliest, accountCount: accounts.length }
}

/**
 * 「限额账号自动沉底」的开关环境变量。
 *
 * 默认**开启**（用户 2026-10 的明确要求）。留这道逃生门是因为它改变了
 * 账号顺序的语义：用户手拖出来的顺序会被系统改写。若有人依赖「首位账号
 * 永远优先」的旧行为（例如想让某个额度充足的号一直扛），把它设为 `0` 即可
 * 退回纯手动顺序。
 */
export const DSH_RATE_LIMIT_SINK = 'DSH_RATE_LIMIT_SINK'

/**
 * 当前是否启用「限额沉底」。
 *
 * ⚠️ **不能写成 `Boolean(env[...])` 之类的 falsy 判据**：本开关的**默认值是
 * 开启**，而「未设置」与「显式关闭」必须区分开 —— `Boolean(undefined)` 与
 * `Boolean('0')` 都为 false，会把默认开启变成默认关闭（与 Qoder 排队超时、
 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 那几个坑同型）。
 *
 * 判据取「显式写了 `0` / `false` / `off` / `no` 才算关」，其余（含未设置、
 * 空串、无法识别的值）一律按默认开启。
 */
export function rateLimitSinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DSH_RATE_LIMIT_SINK]
  if (typeof raw !== 'string') return true
  const value = raw.trim().toLowerCase()
  if (value.length === 0) return true
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no')
}

/**
 * `expiryMarkedKeys` 的复合键。
 *
 * ⚠️ 用 `\u0000` 作分隔符（与仓库既有约定的另外半句由 `targetKey` 之类承担）：
 * accountId 形如 `zcode-a1b2c3d4`，**不含** NUL；模型 id 也不会。
 * 用 `:` 之类的可见分隔符在「模型 id 含同名分隔符」时会串键
 *（`aggregate-adapter.ts` 的拒绝表已经因这个原因选了 `\u0000`）。
 */
function exhaustedKey(accountId: string, modelId: string): string {
  return `${accountId}\u0000${modelId}`
}

/**
 * 把「目标账号」移动到本 provider 的**最末尾**（限额沉底）。
 *
 * ## 为什么需要它（用户报障的根因）
 *
 * 取号永远是「服务端顺序里**第一个**可用账号」（见 `getAvailableAccount`）。
 * 于是只要 1 号账号没撞限额，**全部流量都压在它身上**；等它撞了限额，2 号才
 * 顶上；而等 1 号解禁，它又**排在最前面被立刻捡回去**，2 号重新闲置。
 *
 * 后果正是用户报障的原话：*「每次都轮不完，等限额号好了因为排在前面又开始
 * 用刚好的限额号了，后面的号的额度就白白过期了」* —— 每个账号的额度都有
 * 使用期限（资源包的 `DeductionEndTime`），轮不到就真的作废。
 *
 * 故「限额即沉底」的真正价值**不在受限期间**（受限账号本来就被选号过滤掉），
 * 而在**解禁之后**：它留在末尾，不会再抢回首位，后面的号因此轮到使用。
 *
 * ## 为什么必须持久化（不能只在内存里排）
 *
 * 沉底若不写盘，重启/刷新后顺序回到原位，解禁账号又会插回最前 —— 等于没做。
 * 因此它写在**权威的服务端顺序**里（与用户拖拽的 `reorderAccounts` 同一份）。
 *
 * ## 槽位约定（与 `reorderAccounts` 完全一致）
 *
 * 账号存在**一个全局数组**里（各 provider 混排，靠 `provider` 字段区分）。
 * 这里取「该 provider 原本占用的那些下标」，把新顺序（其余账号保持原相对
 * 顺序、目标账号排到最后）填回这些下标 —— **其它 provider 的账号绝对位置
 * 完全不变**。不这么做（例如整体挪到数组尾部）会让拖拽 buddy 顺带改变
 * CodeArts 账号的位置，属于跨面板的意外副作用。
 *
 * @param accounts - 当前账号列表（服务端顺序）。
 * @param accountId - 要沉底的账号 id。
 * @returns 新数组；无需变更（账号不存在 / 已在本 provider 末位）时返回 `null`。
 */
export function sinkAccountToProviderEnd(
  accounts: readonly ProviderAccountEntry[],
  accountId: string,
): ProviderAccountEntry[] | null {
  const index = accounts.findIndex(a => a.id === accountId)
  if (index === -1) return null
  const entry = accounts[index]!

  // 该 provider 占用的下标（原序）与该 provider 内的当前顺序。
  const slots: number[] = []
  const group: ProviderAccountEntry[] = []
  accounts.forEach((a, i) => {
    if (a.provider === entry.provider) { slots.push(i); group.push(a) }
  })
  // ⚠️⚠️ **必须按「对象引用」定位，不能按 `id`**（真实缺陷，对抗审计实测证伪）：
  //
  // 池里**允许**存在两条同 id 的账号（`replaceAll` 导入一份手工编辑过的备份即可
  // 造出，见其注释；`sanitizeAccounts` 只校验字段、不去重）。此时按 id 匹配的
  // **`filter`** 会把**两条同 id 一起**滤掉：
  //   - `group.findIndex(a => a.id === accountId)` 恒取**第一条**同 id（见下 ⚠️）；
  //   - `group.filter(a => a.id !== accountId)` 会滤掉**两条**。
  // ⇒ `nextGroup.length === group.length - 1` 而 `slots.length === group.length`，
  // 下面的回填在最后一个槽位写入 `undefined`（`nextGroup[i]!` 的非空断言把它
  // 静默放过）⇒ 池里出现空洞 ⇒ **该 provider 全部推理请求崩**
  // （`getAvailableAccount` / `listAccounts` 抛 `Cannot read properties of undefined`），
  // 且 `undefined` 经 `JSON.stringify` 变 `null`、重启后被 `sanitizeAccounts` 丢弃
  // ⇒ **账号永久丢失**。
  //
  // 目标账号就是上面按 id 找到的 `entry` 这个对象本身，故按引用判等即可。
  //
  // ⚠️ **判别力说明（最终审计实测，别误读）**：**承重的是下面那个 `filter`** ——
  // 单独把 `indexOf` 改回 `findIndex(a => a.id === ...)` **不可区分**（0 条测试变红），
  // 因为同 id 时两者都命中**第一条**、而 `entry` 也是第一条。只有与 `filter` 一起
  // 改回按 id 才会产生空洞。⇒ 回归用例真正锁的是 `filter` 那一侧；
  // 本行按引用写是为**语义清晰**（「定位这一个对象」），不是独立的判别点。
  const positionInGroup = group.indexOf(entry)
  // 已在末位 → 无需变更，调用方据此省掉一次写盘。
  if (positionInGroup === group.length - 1) return null

  // 组内新顺序：其余账号保持相对顺序，目标账号排到最后。
  // ⚠️ **这是 Critical 缺陷的承重点**：用引用判等；按 id 会连带移除另一条同 id
  // 的账号（长度不变量被破坏 ⇒ 空洞 ⇒ provider 崩 + 重启丢账号）。
  const nextGroup = group.filter(a => a !== entry)
  nextGroup.push(entry)

  const next = [...accounts]
  // 长度不变式：组内账号数不变，故 slots 与 nextGroup 必然等长。
  // 保留运行时兜底 —— 万一将来有人改动上面的筛选逻辑，宁可返回 null（不改顺序）
  // 也不要写出空洞把整个 provider 弄崩。
  if (nextGroup.length !== slots.length) return null
  slots.forEach((slot, i) => { next[slot] = nextGroup[i]! })
  return next
}

/**
 * AccountPool —— 多账号管理核心
 *
 * 职责：
 * - 账号列表 CRUD（索引走 {@link JetHubStore}，凭据存于 ctx.credentials，
 *   两者各自独立）
 * - 获取指定 provider + 模型的下一个可用账号
 *   算法：enabled=true 且模型不在重置期内 → 取第一个
 * - 更新模型重置时间（收到限流错误后调用）
 *
 * 持久化后端按 DSH 版本能力探测（见 `src/jet-hub-store.ts`）：0.1.7 起
 * `ctx.settings` 不再允许插件注册 namespace，故改用插件自有状态文档；
 * 两者都不可用时退化为内存态，保证不抛错。
 */
/**
 * 把池里的代理字段读成**字符串**（**读取侧的唯一收口**）。
 *
 * ## ⚠️ 为什么必须有它（实测的真缺陷，独立于 IKLTZ2 审计发现）
 *
 * `opencodeProxy` / `geminiProxy` 都来自**用户可编辑的备份文件**，而
 * `sanitizeAccounts`（`src/jet-hub-store.ts`）用 `{ ...candidate }` 原样透传、
 * **不校验这两个字段的形状**（对照 `modelRateLimits`：那个已由 `isValidResetAtMs`
 * 加固）。于是池里可能存在 `"geminiProxy": 12345`。
 *
 * 下游 `normalizeProxy`（`src/opencode.ts`）第一句就是 `input.trim()` ⇒
 * 非字符串会在那里抛 `TypeError: raw.trim is not a function`：
 *
 * - 该账号**永久不可用**（每次请求都抛，且没有自愈路径）；
 * - 症状与「代理配错了」同形，排障者会去看代理配置，而真因是备份里的脏数据。
 *
 * 实测（本机，IKLTZ2 修复期间）：`sanitizeAccounts` 原样透传 `12345`，
 * 解析器随即抛 `raw.trim is not a function`。
 *
 * ## ⚠️ 为什么「读侧兜底」而不是「写侧过滤」
 *
 * 写侧过滤（`sanitizeAccounts` 里丢弃非法值）更彻底，但它是**全仓共享**的清洗
 * 函数，改动会影响十家 provider 的条目落库形态。本函数是**代理专属**的收口，
 * 影响面精确到两个读方法。
 *
 * ⚠️ **刻意不删键、不改盘**：读侧只保证「不崩、行为确定」—— 脏值视为「未配置」
 * （= 直连）是最保守的降级，用户仍可在面板里重新配一次把它覆盖掉。
 *
 * @param value 池字段原始值（可能是任意 JSON 值）。
 * @returns 字符串原值；非字符串（含 `undefined` / 数字 / 对象 / 数组）一律回退空串。
 */
export function asProxyText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 写「代理已更新」日志时的**展示文本**（2026-10-25 审计 A2-02）。
 *
 * ## 为什么必须有它
 *
 * 四家 `set*Proxy` 原先都把**原始 URL** 拼进日志：
 * `` `[jet-hub] 账号 ${id} Qoder 代理 → ${proxy}` `` —— 而代理 URL 常含
 * `user:pass@host` ⇒ **口令明文进日志**，而日志是用户排障时会随手打包、
 * 粘贴进 issue、上传给别人的东西。
 *
 * 对抗审计逐家实测：opencode / gemini / minimaxintl **早已同形**，
 * qoder 只是第 4 个实例（不是本 PR 新增的机制）⇒ 四家一并修。
 *
 * ## ⚠️ 判据复用 `proxy-mask.ts`，不在这里再写一份
 *
 * 池**不能** import provider 实现（`opencode.ts` 在依赖图上层，会成环），
 * 而复制一份正则到这里就正是本仓库的红线——**同一语义两套判据**。
 * ⇒ 脱敏实现住在双方都能依赖的中立文件里。
 *
 * @param value 池字段原始值（可能是脏值 —— 备份文件原样透传）。
 * @returns 空串 → `直连`；否则脱敏后的 label（保留 scheme/user/host/port）。
 */
export function proxyLogText(value: unknown): string {
  const raw = asProxyText(value).trim()
  if (raw.length === 0) return '直连'
  return maskProxyPassword(raw)
}

export class AccountPool {
  /** 持久化后端；两个后端都不可用时是仅内存实现。 */
  private readonly store: JetHubStore
  /**
   * 账号列表的**权威进程内副本**。
   *
   * 不直接把后端的读取结果当读源：后端的落盘快照在写入后未必立即反映到
   * 下一次读取，而本类的每次写入都是「读 → 改 → 整体写回」。
   * 若以滞后快照为读源，并发/连续的 updateModelRateLimit 会互相覆盖
   * （典型表现：多个账号触发限流后，落盘文档里一条 modelRateLimits
   * 都没有）。因此首次载入后，这份副本即为唯一读源。
   */
  private cache: ProviderAccountEntry[] = []
  /**
   * 模型黑名单的**权威进程内副本**（与 {@link cache} 同理：载入一次后即以
   * 本副本为准）。
   */
  private modelCache: ModelDisableMap = {}
  /**
   * **供应商关闭意图**的权威进程内副本（Gitee issue IKP8OF）。
   *
   * ⚠️ 与 {@link modelCache} **语义不同、不可合并**：黑名单是「这个模型被关着」，
   * 本表是「用户要求这个**供应商**整体关着」。二者由 {@link disabledModelsFor}
   * 双腿取或后对消费者**同形**（都表现为「这些 id 不可调用」），但判据与生命周期
   * 完全不同：黑名单会被逐条打开，而本表只在「打开整个供应商」时才清除。
   *
   * 详见 `jet-hub-store.ts` 的 `ProviderClosedMap` 注释（含为什么它**不能**
   * 单独充当 `provider.status.closed` 的权威）。
   */
  private providerClosedCache: ProviderClosedMap = {}
  /**
   * 聚合「拒绝轮换」表的**权威进程内副本**（与 {@link cache} / {@link modelCache} 同理）。
   *
   * ⚠️ 与 {@link modelCache} **语义不同、不可合并**：黑名单是「关闭这个模型」（它从
   * 模型选择器消失），本表是「这一条候选不参与该虚拟模型的轮换」（模型仍在目录里）。
   * 详见 `AggregateRejectionMap` 的注释。
   */
  private aggregateRejectionCache: AggregateRejectionMap = {}
  /**
   * 聚合「**显式允许**参与轮换」白名单的权威进程内副本。
   *
   * ⚠️ 与 {@link aggregateRejectionCache} **各有各的域、不做归一**（用户 2026-10-15 的修正）：
   * 已接入临期折算的候选只归**拒绝表**（黑名单语义：默认参与），未接入的只归**白名单**
   *（默认不参与，「参与」才需显式记录）。两表的键域由渠道级的「是否接入折算」划分 ⇒
   * **天然不相交** ⇒ 写一侧**不得**改另一侧。
   * 详见 `jet-hub-store.ts` 的 `AggregateAllowedMap` 注释。
   */
  private aggregateAllowedCache: AggregateAllowedMap = {}
  /**
   * 聚合「手工排序」表的权威进程内副本。
   *
   * ⚠️ 缺键 / 空数组 = 未自定义（与 {@link providerOrderCache} 同语义）：
   * 展示与轮换都回落临期序。
   */
  private aggregateOrderCache: AggregateOrderMap = {}
  /**
   * 聚合候选的排序模式（缺省 `'expiry'` = 升级前行为）。
   *
   * ⚠️ 它不是「有没有手工顺序表」的派生量：用户可能切到手工模式但一条都没拖过
   *（此时行为与临期模式相同，但面板要显示「按手工」）。
   */
  private aggregateOrderModeCache: AggregateOrderMode = 'expiry'
  /**
   * 「锁定永久积分」开关表的**权威进程内副本**（与 {@link cache} 同理）。
   *
   * ⚠️ 每个 provider 一项（Loomy / CodeBuddy / WorkBuddy 各自独立），
   * **只记录已锁定的**（缺键 = 未锁定）。
   *
   * ⚠️ 它的落盘位置与账号池**不是同一份文档**：住在
   * `$DSH_HOME/jet-hub/permanent-locks.json`，因为 state.json 是同机多 profile
   * 共享的文档，而另一条工作区里的旧版本代码全量重写它时**不会携带自己不认识
   * 的键** —— 放那儿会被静默抹掉，解锁的后果是真把永久积分烧掉。
   * 详见 `src/permanent-lock-store.ts` 的文件头。
   */
  private permanentLockCache: PermanentLockMap = {}
  /**
   * 「本机 OpenAI 网关」开关的进程内副本。
   *
   * 缺键语义是**启用**（与 `jet-hub-store.ts` 的 `sanitizeGatewayEnabled`
   * 同一方向）：老用户升级后网关行为与升级前完全一致，不会被静默关掉。
   *
   * ⚠️ 与 {@link permanentLockCache} 不同，它**不需要**独立文档：丢失本键
   * 的唯一后果是回到默认启用，用户再关一次即可。
   */
  private gatewayEnabledCache = true
  /**
   * 「允许局域网访问」开关的进程内副本（2026-10-20）。
   *
   * 缺键语义为**关闭**（与 {@link gatewayEnabledCache} 的「缺键即启用」刻意
   * 相反）：暴露面变大必须是用户的显式选择，任何读取失败/丢键都回到只绑回环。
   * 丢失后果可逆（重开一次开关），不需要独立文档。
   */
  private gatewayAllowLanCache = false
  /**
   * 「渠道原生搜索」总开关的进程内副本（`false` = 全部搜索回官方 provider）。
   *
   * 缺键语义是**启用**（与 {@link gatewayEnabledCache} 同一方向）：老文档没有
   * 本键时保持原生搜索，不会因读取失败而静默改走官方（那会让搜索突然开始
   * 要 API Key，用户看不出是自己关过还是坏了）。
   *
   * ⚠️ 与 {@link gatewayEnabledCache} 同级、**不需要**独立文档：丢失本键的
   * 唯一后果是回到原生搜索，用户再关一次即可。
   */
  private nativeWebSearchCache = true
  /**
   * 「ZCode 会话负载均衡」开关的进程内副本。
   *
   * 缺键语义是**启用**（与 {@link nativeWebSearchCache} 同一方向）：老文档没有
   * 本键时保持会话亲和，不会因读取失败而静默改回「手动顺序压一个号」
   *（那正是 2026-10-30 用户要求修掉的形态）。
   *
   * ⚠️ 与 {@link nativeWebSearchCache} 同级、**不需要**独立文档：丢失本键的
   * 唯一后果是回到手动顺序，用户再开一次即可。
   */
  private sessionBalanceCache = true
  /**
   * 「面板入口」的进程内副本：Jet Hub 的唯一入口位置（两个取值互斥）。
   *
   * 缺键语义是 `'sidebar'`「仅侧栏」（与 {@link nativeWebSearchCache} 同一方向）：
   * 老文档没有本键时保持主导航那一行可见，不会因一次读取失败而让用户以为
   * 这是某个被删掉的功能。
   *
   * ⚠️ 与 {@link gatewayEnabledCache} 同级、**不需要**独立文档：丢失本键的
   * 唯一后果是入口回到默认「仅侧栏」，用户再改一次即可（可逆）。
   */
  private panelEntryCache: PanelEntry = DEFAULT_PANEL_ENTRY
  /**
   * 供应商自定义显示顺序（「供应商开关」弹窗拖拽排序）的进程内副本。
   *
   * ⚠️ 与 {@link gatewayEnabledCache} 同级、**不需要**独立文档：丢失本键的
   * 唯一后果是顺序回到声明顺序，用户重新拖一次即可（纯展示偏好，可逆）。
   * 数组语义见 `jet-hub-store.ts` 的 `JetHubState.providerOrder`。
   */
  private providerOrderCache: string[] = []
  /**
   * MiniMax **国际站**绕过分流用的 `X-Forwarded-For` 值（进程内副本）。
   *
   * 语义与校验见 `jet-hub-store.ts` 的 `JetHubState.minimaxXff` 与
   * `sanitizeMinimaxXff`（**同一份判据**，本文件不另写一份）。
   *
   * ⚠️ `undefined` / 空串 = **不附头**（行为与修复前逐字节一致）。这是刻意的
   * 缺省：附 `X-Forwarded-For` 等于声明一个并非本机的来源 IP，不能是默认行为。
   *
   * ⚠️ 与 {@link providerOrderCache} 同级、**可以**住在这里：丢失本键的唯一后果
   * 是国际站用户重新遇到 307（可逆，重填一次即可）。但它**必须**被带进
   * `queueStoreSave` 的整体写入（否则「任何一次改账号都会静默清掉它」）。
   */
  private minimaxXffCache: string | undefined
  /**
   * ★ **由折算观测写下的** `modelRateLimits` 标记集合（键 = `accountId\u0000modelId`）。
   *
   * ## ⚠️⚠️ 为什么必须有它（真实缺陷，两个独立审计共同命中 2026-10-12）
   *
   * `modelRateLimits` 这一张表承载了**两种语义**、且两者写的**值与键完全相同**
   *（都是「该账号 + 该模型」+ UTC+8 次日 0 点）：
   *
   * | 来源 | 语义 | 依据 |
   * |---|---|---|
   * | `updateModelRateLimit`（各适配器） | **撞墙**：上游真的拒绝了 | **线上事实**（一次真实失败的请求） |
   * | `markModelsExhaustedForExpiry` | **观测**：余额接口说这个模型没额度了 | 可能**滞后 / 口径不同**的计数器 |
   *
   * 而折算**每轮选型都跑**：只要余额接口报该模型 `> 0`，`clearModelsExhaustedForExpiry`
   * 就会把适配器刚写的标记**无条件删掉** ⇒
   *
   * ```
   * round0: pick=zcode-A 适配器写标记=true 折算后仍在=false   ← 被擦了
   * round1: pick=zcode-A 适配器写标记=true 折算后仍在=false   ← 又被擦
   * round2: pick=zcode-A ...                                  ← 死循环
   * ```
   *
   * ⇒ 同一个号被**反复选中、反复撞墙**，每次**真烧一发请求**。
   * 实测（关掉折算缓存后 `3/3` 轮全中）：`scripts/verify-zcode-fight-single.mjs`。
   *
   * ## 判据：**谁的证据更强**
   *
   * 「上游真的拒绝了一次请求」强于「余额接口说还有额度」（后者可能滞后）。
   * ⇒ 清除只允许作用于**本机制写下的**标记：
   * - `markModelsExhaustedForExpiry` 写成功后**登记**来源；
   * - `updateModelRateLimit`（适配器）一旦为该键写过，就**认领**它
   *  （从本集合移除）⇒ 观测路径再也擦不掉它；
   * - `clearModelsExhaustedForExpiry` **只删登记过的**键。
   *
   * ⚠️ **纯内存、不落盘**：丢失它的后果是「既有标记变成来源不明 ⇒ 清不掉」
   * —— 那是**保守方向**（与「只写不清」的单向门同向，但危害小得多：
   * 标记本来就会在次日 0 点自然过期）。刻意不落盘，避免给
   * `JetHubState` 加一份需要迁移与对账的新结构。
   */
  private readonly expiryMarkedKeys = new Set<string>()
  /** 是否已完成首次载入。 */
  private loaded = false
  /**
   * 状态文档落盘的**串行链**（见 {@link queueStoreSave}）。
   *
   * ⚠ 它必须存在：内层重新读一次快照只能保证「读→改」这半原子，而
   * `store.save()` 本身是异步的，两个写者的 `save` 可以乱序完成。
   */
  private storeChain: Promise<void> = Promise.resolve()
  /** 锁定表的独立后端（权威落盘点）。 */
  private readonly lockStore: PermanentLockStore
  /**
   * 「账号入库」订阅者（Gitee issue IKJOZB）。
   *
   * ⚠️ 刻意**不落盘、不跨实例**：它的消费者是插件会话内的续期调度器，
   * 而调度器按会话创建 —— 持久化订阅者既无意义，还会让「谁来订阅」变成
   * 需要在启动时恢复的状态。
   */
  private readonly accountAddedListeners = new Set<(entry: ProviderAccountEntry) => void>()

  constructor(private readonly ctx: Context) {
    this.store = createJetHubStore(ctx)
    this.lockStore = createPermanentLockStore(ctx)
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无可用持久化后端，账号列表与模型黑名单仅存在于内存中')
    }
  }

  /** 首次访问时从后端载入账号列表、黑名单与锁定表。 */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const state = this.store.load()
    if (state !== undefined) {
      // ⚠️ 这里的 `state.accounts` **已经过去重**：两种后端（SettingsStore /
      // FileStore）的 `load()` 都经 `sanitizeAccounts`，而它按 id 去重。
      // 故历史遗留的重复条目会在**下次载入时自愈**（只留第一条）。
      this.cache = state.accounts
      // 黑名单是后来才加入的字段：老文档里没有它，缺失时保持空表
      // （等价于"全部模型默认打开"），而不是报错或让整次载入失败。
      this.modelCache = state.disabledModels
      // 聚合拒绝表同理：老文档没有该键 → 保持空表（没有任何拒绝）。
      this.aggregateRejectionCache = state.aggregateRejections ?? {}
      // 门控白名单 / 手工顺序表 / 排序模式同理：老文档没有这些键 → 缺省值
      //（空白名单 = 未接入渠道仍不参与、空顺序表 = 未自定义、临期序 = 升级前行为）。
      this.aggregateAllowedCache = state.aggregateAllowed ?? {}
      this.aggregateOrderCache = state.aggregateOrder ?? {}
      this.aggregateOrderModeCache = state.aggregateOrderMode === 'manual' ? 'manual' : 'expiry'
      // 网关开关同理：老文档没有该键 → 保持默认启用。
      this.gatewayEnabledCache = state.gatewayEnabled !== false
      // 局域网开关同理：老文档没有该键 → 保持默认关闭（安全默认，暴露面变大
      // 必须是显式选择）。与 store 侧 `sanitizeGatewayAllowLan` 同一判据。
      this.gatewayAllowLanCache = state.gatewayAllowLan === true
      // 原生搜索总开关同理：老文档没有该键 → 保持默认启用。
      this.nativeWebSearchCache = state.nativeWebSearchEnabled !== false
      // 会话负载均衡开关同理：老文档没有该键 → 保持默认启用。
      this.sessionBalanceCache = state.sessionBalanceEnabled !== false
      // 面板入口同理：老文档没有该键（或值是脏值）→ 回到默认「仅侧栏」。
      // 过一遍 sanitize：store 层的 load 已归一，这里再判一次是因为老契约
      // 后端可能绕过 schema 直接给出原始文档。
      this.panelEntryCache = sanitizePanelEntry(state.panelEntry)
      // 供应商顺序同理：老文档没有该键 → 空数组（未自定义）。
      this.providerOrderCache = state.providerOrder ?? []
      // MiniMax 国际站 XFF 同理：老文档没有该键 → `undefined`（不附头，
      // 与修复前行为逐字节一致）。**过一遍 sanitize**：老文档里可能有脏值。
      this.minimaxXffCache = sanitizeMinimaxXff(state.minimaxXff)
      // 供应商关闭意图同理：老文档没有该键 → 空表（没有任何供应商被关闭，
      // 与升级前行为一致）。**过一遍 sanitize**：老文档里可能有脏值。
      this.providerClosedCache = sanitizeProviderClosed(state.providerClosed)
    }
    this.loadLocks(state)
  }

  /**
   * 载入锁定表：独立文档是权威；它**不存在**时才从 state.json 的镜像字段迁移。
   *
   * ⚠️ 迁移判据必须是「文档不存在」而不是「表里没有某键」：表里的缺键语义是
   * 「用户明确解锁了」，此时若还回看镜像字段那个陈旧的 `true`，就会出现
   * **解不掉的开关** —— 比丢状态更难排查。
   *
   * ⚠️ 迁移出的内容立即固化到独立文档：否则每次冷启动都要重新读镜像，
   * 而镜像随时可能被另一条工作区的旧代码改回旧值。
   */
  private loadLocks(state: JetHubState | undefined): void {
    const read = this.lockStore.load()
    if (read.exists) {
      this.permanentLockCache = read.locks
      return
    }
    this.permanentLockCache = mergeLegacyLoomyLock({}, state?.loomyPermanentLocked)
    if (Object.keys(this.permanentLockCache).length > 0) {
      // 冷启动路径上的尽力而为：失败只意味着本次进程内生效，下一次仍会重新迁移。
      void this.persistLocks().catch(error => {
        this.ctx.logger?.warn?.(`[jet-hub] 锁定状态迁移未能落盘: ${String(error)}`)
      })
    }
  }

  /** 读取账号列表（进程内权威副本）。 */
  private readAccounts(): ProviderAccountEntry[] {
    this.ensureLoaded()
    return this.cache
  }

  /**
   * 串行化状态文档的落盘，并在**轮到本次时**重新取一次快照。
   *
   * ## 为什么 `removeAccount` 里的重读不够（真实缺陷，审查发现）
   *
   * `await this.writeAccounts(this.readAccounts().filter(...))` 只保证了
   * 「读 → 改」之间没有 `await`（内存那半确实原子），但
   * {@link writeAccounts} 内部的 `await this.store.save(...)` 是**异步**的
   * （`SettingsStore.save` → `await this.scope.replace(...)`）。两个写者各自的
   * `save` 可以**乱序完成**：后完成者带着它更早的快照覆盖磁盘 ⇒ 磁盘与
   * `this.cache` 分叉。实测形态（探针复现真实 IO 交错）：
   *
   * - 并发 `removeAccount('a')` / `removeAccount('b')`（先发起的后完成）：
   *   `cache=["keep"]` 而 `disk=["b","keep"]` ⇒ **已删除的账号在磁盘上复活**，
   *   下次进程启动它又回来；
   * - `removeAccount('victim')` 与 `addAccount(added)` 交错：
   *   `cache=["added","keep"]` 而 `disk=["keep"]` ⇒ **新增账号被静默丢失**。
   *
   * ⚠ 仅 `SettingsStore` 这类**异步** `replace` 后端中招；`FileStore.save` 是
   * 同步的 `writeFileSync` + `renameSync`（见 `src/jet-hub-store.ts`），整段
   * RMW 本来就原子、免疫此竞态。故不能靠「换个后端」绕过，只能在
   * `AccountPool` 这一层把写排队。
   *
   * ## 做法
   *
   * 把本次写挂到 {@link storeChain} 尾部，**在轮到它执行时**才从进程内权威副本
   * 取快照，于是「取快照」与「写磁盘」之间隔着前面所有已排队的写。磁盘上因此
   * 永远是「最后一次排队的写」的内容，与 `this.cache` / `this.modelCache` 收敛。
   *
   * ⚠ 三条数据**必须取自同一时刻**：账号、黑名单、锁定镜像字段共用一次快照，
   * 否则会出现「同一份文档里两个字段自相矛盾」（与 {@link lockFields} 的约定一致）。
   *
   * ⚠ 失败**照常向调用方抛出**（与改造前的 `writeAccounts` 一致：登录成功后落盘
   * 失败必须让 `account.create` 报错，不能静默假装成功）。同时用一条
   * `.catch()` 派生量更新 {@link storeChain}，让**链本身不被一次失败打断**
   * ——否则后续所有写都会跟着拒绝，账号池进入永不落盘状态。
   */
  private queueStoreSave(): Promise<void> {
    if (this.store.kind === 'memory') return Promise.resolve()
    const next = this.storeChain.then(async () => {
      await this.store.save({
        accounts: this.cache,
        disabledModels: this.modelCache,
        // 与上面两份同源快照（见本方法注释：分两次快照会让同一份文档里的字段互相矛盾）。
        aggregateRejections: this.aggregateRejectionCache,
        // ⚠️⚠️ 三个新键**必须**与上面取自**同一时刻**的快照（`replace` 是整体替换语义）：
        //    漏一个 ⇒ 该键永不落盘，且**任何**账号/黑名单写入都会顺带把它抹掉。
        //    其中白名单丢失属「静默改路由」（用户手工打开的无临期渠道悄悄回到不参与）。
        aggregateAllowed: this.aggregateAllowedCache,
        aggregateOrder: this.aggregateOrderCache,
        aggregateOrderMode: this.aggregateOrderModeCache,
        ...this.lockFields(),
        // ⚠️ 必须与账号、黑名单取自**同一时刻**的快照（见本方法的注释）：
        // 分两次快照会让同一份文档里的字段互相矛盾。
        gatewayEnabled: this.gatewayEnabledCache,
        // ⚠️ 必须与上面取自同一时刻的快照（replace 是整体替换语义）：
        //    漏键 ⇒ 用户打开的「允许局域网访问」在任何一次其它写入时被抹掉，
        //    重启后静默回到只绑回环（用户会以为开关坏了）。
        gatewayAllowLan: this.gatewayAllowLanCache,
        nativeWebSearchEnabled: this.nativeWebSearchCache,
        // ⚠️ **必须带上本键**（与 `nativeWebSearchEnabled` 同一个整体替换陷阱）：
        //    漏键会让用户明确关闭的「会话负载均衡」在任何一次其它写入时被抹掉，
        //    重启后静默回到开启。
        sessionBalanceEnabled: this.sessionBalanceCache,
        // ⚠️ **必须带上本键**（与 `nativeWebSearchEnabled` 同一个整体替换陷阱）：
        //    漏键会让用户改过的面板入口在**任何**一次账号/黑名单/网关/顺序写入时
        //    被静默清掉，重启后入口又变回默认「仅侧栏」。
        panelEntry: this.panelEntryCache,
        providerOrder: this.providerOrderCache,
        // ⚠️ **必须带上本键**（同 `nativeWebSearchEnabled` 的坑）：
        //    `write` 是整体替换语义 ⇒ 漏键会让用户设的 XFF 在**任何**一次
        //    改账号 / 改黑名单 / 改网关 / 拖顺序时被静默清掉，
        //    症状是「国际站明明设好了 XFF，过一阵又开始 307」。
        minimaxXff: this.minimaxXffCache,
        // ⚠️⚠️ **必须与上面几份取自同一时刻的快照**（`replace` 是整体替换语义）：
        //    漏键 ⇒ 关闭意图**永不落盘**，且任何账号/黑名单写入都会把它抹掉
        //    ⇒ 重启后供应商静默回到「已打开」（Gitee issue IKP8OF 原样复发）。
        providerClosed: this.providerClosedCache,
      })
    })
    this.storeChain = next.catch(() => {})
    return next
  }

  /**
   * 持久化账号列表（同时更新进程内权威副本）。
   *
   * **必须连同黑名单一起写回**：两种后端都是整体写入，
   * 只写 `{ accounts }` 会把同一文档里的 `disabledModels` 抹掉。
   *
   * ## ⚠️⚠️ 这里是「同 id 去重」的**唯一收口点**（真实缺陷，独立审计实测证伪）
   *
   * 原先只把去重放在 `sanitizeAccounts`（归一化层）。但**并非所有写入路径都经过
   * 归一化** —— 最典型的是 {@link addAccount}：它直接
   * `writeAccounts([...readAccounts(), entry])`，**不调 `sanitizeAccounts`**。
   * 而 `addAccount` 有 20+ 个调用点（各 `*-auth.ts` 的登录落库、`jet-hub-rpc.ts`
   * 的 `account.create`、`opencode-rpc.ts`、`ensureDefaultAnonymousSlot`），
   * 于是「池里两条同 id」仍可达。
   *
   * 后果**不是崩溃**（`sinkAccountToProviderEnd` 的长度不变式兜底会拦下空洞），
   * 而是**沉底静默失效**：兜底返回 `null` ⇒ 顺序不变 ⇒ 限额号解禁后仍抢占首位 ⇒
   * 用户报障的那个「额度轮不完、白白过期」**原样复现**。用静默失效换掉崩溃
   * 只是把问题藏得更深。
   *
   * ⇒ 去重必须放在**唯一的写入收口点**（本方法）：无论调用方是否做过归一化，
   * 落盘与进程内副本都不会含两条同 id。这是「按 id 唯一」这一不变式的
   * **结构性保证**，而不是依赖每个调用方自觉。
   *
   * ⚠️ 保留**首次**出现的条目（与 `sanitizeAccounts` 同口径）。
   * ⚠️ `sanitizeAccounts` 里的去重**仍然保留**：它是**入口**的清洗（坏条目、
   * 脏限流标记），两者职责不同、互相不替代 —— 少了本层则 `addAccount` 漏网，
   * 少了那层则脏数据进池。
   */
  private async writeAccounts(accounts: ProviderAccountEntry[]): Promise<void> {
    // 按 id 去重（保留首次出现）。池里两条同 id 会让 `updateAccount` /
    // `removeAccount` / 沉底全部只命中第一条，是幽灵账号与静默失效的根源。
    const seen = new Set<string>()
    const deduped: ProviderAccountEntry[] = []
    let dropped = 0
    for (const entry of accounts) {
      if (seen.has(entry.id)) { dropped++; continue }
      seen.add(entry.id)
      deduped.push(entry)
    }
    if (dropped > 0) {
      // 留痕：这条日志是排查「账号莫名少了一条」的唯一线索。
      this.ctx.logger?.warn?.(
        `[jet-hub] 写入账号池时丢弃了 ${dropped} 条同 id 的重复条目（id 必须唯一）`,
      )
    }
    this.cache = deduped
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，账号变更未落盘')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 读取某 provider 的模型黑名单（被关闭的模型 id 集合）。
   *
   * 适配器只调用这一个方法，因此进程内副本就是它们的读源：设置页改开关
   * 后，下一次 `listModels` 立即生效，无需重启或重新注册适配器。
   */
  disabledModelsFor(provider: string): ReadonlySet<string> {
    this.ensureLoaded()
    const perProvider = this.modelCache[provider]
    if (perProvider === undefined) return EMPTY_MODEL_SET
    const disabled = Object.keys(perProvider).filter((id) => perProvider[id] === true)
    return disabled.length > 0 ? new Set(disabled) : EMPTY_MODEL_SET
  }

  /**
   * 列出某 provider 的模型黑名单，供设置页渲染开关。
   *
   * 返回**全部键**（含显式设为 false 的），以便 UI 区分"从未设置过"与
   * "曾被关闭又打开"——两者对用户都是"开"，但保留记录便于排查。
   */
  listDisabledModels(provider: string): Record<string, boolean> {
    this.ensureLoaded()
    return { ...(this.modelCache[provider] ?? {}) }
  }

  /**
   * 该 provider 是否处于「**用户要求整体关闭**」态（Gitee issue IKP8OF）。
   *
   * ## ⚠️⚠️ 这是「关闭**意图**」，不是「当前是否真的全关」——两个判据必须分开
   *
   * | 判据 | 含义 | 谁用 |
   * |---|---|---|
   * | 本方法 | 用户点过「关闭供应商」，且此后没再打开过它 | 过滤（选择器 / 路由）、`provider.status` |
   * | `disabled === total` | 目录里**每一个**模型都在黑名单里 | 兜底（用户逐条关光也算关闭） |
   *
   * 二者取**或**才是 `closed`（见 `provider.status`）。只读本方法会漏掉
   * 「用户逐条关光」（既有语义，有既有用例锁定）；只读派生判据会漏掉
   * 「关闭后目录继续变长」（本 issue）。
   *
   * ## 为什么它是修「新模型仍可选」的关键
   *
   * 关闭供应商时只写入了**当时目录**的黑名单；目录随后变长，新 id 不在黑名单里
   * ⇒ 它们**可被选中**。本意图表让「该 provider 整体关闭」这件事不再依赖
   * 目录快照 ⇒ 各适配器的 `listModels` 见它即返回 `[]`，选择器里**一条都不出现**。
   *
   * ⚠️ **纯内存同步读、零 IO**：本方法在 `provider.status`（设置页挂载时对
   * 每个供应商各调一次）与每次 `listModels` 的路径上，不能有 await 或磁盘读。
   */
  providerClosedFor(provider: string): boolean {
    this.ensureLoaded()
    return this.providerClosedCache[provider] === true
  }

  /**
   * 设置/清除某 provider 的「整体关闭」意图（Gitee issue IKP8OF）。
   *
   * ⚠️ **只动意图，不动黑名单**：黑名单由 `provider.setEnabled` 按固定顺序
   * 显式处理（先关模型、再停账号）。本方法只回答「用户要求这个供应商关着吗」。
   *
   * ⚠️ 幂等且无变更不落盘（与 `setModelsDisabled` 的「空列表不落盘」同精神）：
   * 重复点同一个开关不该产生一次文档重写。
   */
  async setProviderClosed(provider: string, closed: boolean): Promise<void> {
    this.ensureLoaded()
    // ⚠️ 显式括号：`===` 左结合，`a === true === closed` 虽等价于
    //    `(a === true) === closed`，但读的人要多想一步（易被误读成
    //    `a === (true === closed)` —— 那在 `closed=false` 时**恒真**，
    //    会让「打开」变成静默空操作）。
    if ((this.providerClosedCache[provider] === true) === closed) return
    const next: ProviderClosedMap = { ...this.providerClosedCache }
    if (closed) next[provider] = true
    else delete next[provider]
    this.providerClosedCache = next
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，供应商关闭状态未落盘')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 清除「整体关闭」意图 —— **任何**打开方向的操作都必须走这里。
   *
   * ## ⚠️⚠️ 为什么必须在「打开」时清除，否则用户点不动
   *
   * 意图为 `true` 时，全部模型都被过滤掉（`listModels` 返回 `[]`）、设置页里
   * 每条模型开关也显示为「已关闭」。此时用户在模型列表里打开**某一个**模型，
   * 若意图不清除 ⇒ 该模型仍被整体关闭拦掉 ⇒ **点击看起来毫无效果**，
   * 而界面也不报错。这与本仓库反复修的「开关点了没反应」同型。
   *
   * ⇒ 语义定为：**「打开任意一个模型」= 用户想让这个供应商可用** ⇒ 清除意图，
   * 之后由派生判据（黑名单是否覆盖全目录）如实反映「还剩几个关着」。
   *
   * ⚠️ 三个打开入口（`setModelDisabled(false)` / `clearModelsDisabled` /
   * `clearDisabledModels`）都在**本类内部**调用它 —— 调用方（RPC 层）不需要
   * 记得清，这正是「收口到一个实现」的目的。
   */
  private async clearProviderClosed(provider: string): Promise<void> {
    if (this.providerClosedCache[provider] !== true) return
    await this.setProviderClosed(provider, false)
  }

  /**
   * 聚合「拒绝轮换」表的**只读快照**（供适配器与设置面板读取）。
   *
   * ⚠️ 返回**浅拷贝的顶层**（避免调用方改到内部缓存），但内层仍共享引用 ——
   * 调用方**只读**即可；写入一律走 {@link setAggregateRejected}。
   */
  listAggregateRejections(): AggregateRejectionMap {
    this.ensureLoaded()
    return this.aggregateRejectionCache
  }

  /**
   * 设置某条候选是否被拒绝参与该虚拟模型的轮换。
   *
   * 语义（与 {@link setModelDisabled} 对称）：
   * - `rejected === true` → 写入；
   * - `rejected === false` → **删除**该键（不留 `false` 噪音，与 sanitize 同口径）；
   * - 空层逐级清理（realId 层空 → 删 provider 层；provider 层空 → 删虚拟模型层）。
   */
  async setAggregateRejected(
    canonicalId: string,
    provider: string,
    realId: string,
    rejected: boolean,
  ): Promise<void> {
    this.ensureLoaded()
    if (!rejected) {
      // ⚠️⚠️ **「重新打开」必须一并清掉该渠道的「漂移兄弟键」**（真实缺陷，
      //    独立审计实测证伪 —— D4 的降级会让拒绝**不可恢复**）。
      //
      // ## 为什么
      // D4 规定：`(虚拟模型, 渠道)` 下有 `true` 记录、但那些 `realId` **都不在**
      // 当前候选中（id 漂移）⇒ **降级为渠道级拒绝**（该渠道全部候选都被拒）。
      // 而漂移的**旧键会一直留在表里** ⇒ 用户按降级 warn 的指引来面板
      // 「重新打开」**当前**候选时，只删**当前**键 ⇒ **旧键仍在** ⇒ 降级判据依然
      // 成立 ⇒ **降级继续生效**：
      //   - 面板用 `isRejected(表, 当前 realId)` 判断显示 ⇒ 显示「参与轮换」；
      //   - 宿主实际**仍拒绝** ⇒ **显示与行为分叉**；
      //   - 于是 warn 指引的那条恢复路径**走不通**（用户怎么点都没用）。
      //
      // ## 修法与判据
      // 用户在面板上「重新打开」某条候选，其**意图**是「让这个渠道在这个模型下
      // 重新参与轮换」。而 D4 的降级语义本就是**渠道级**的 ⇒ 故唯一自洽的结果
      // 就是**整渠道恢复**。
      //
      // ⚠️⚠️ 语义与理由**只留一份实现**：搬到 `jet-hub-store.ts` 的
      //    `clearRejectionLayer()`（纯函数），本方法与 `setAggregateAllowed` 之外的
      //    写入路径共用 —— 别在这里再手写一遍（初版曾把 `delete perProvider[provider]`
      //    与写回的顺序写反 ⇒ 删除被自己覆盖，降级不解除）。
      //
      // ⚠️ 与 `clearAggregateRejected(canonicalId, provider)` 的区别：本分支只在
      //    用户**显式打开某一条**时触发（且只清本渠道，不碰其它渠道）；
      //    那个方法支持按虚拟模型/按渠道批量清（含从未拒绝过的）。语义不同故并存。
      this.aggregateRejectionCache = clearRejectionLayer(this.aggregateRejectionCache, canonicalId, provider)
      await this.writeAggregateRouting('聚合拒绝表')
      return
    }
    const next: AggregateRejectionMap = { ...this.aggregateRejectionCache }
    const perProvider = { ...(next[canonicalId] ?? {}) }
    const perRealId = { ...(perProvider[provider] ?? {}) }
    perRealId[realId] = true
    // ⚠️ **不动白名单**（用户 2026-10-15 的修正）：写拒绝是**已接入渠道**这条域上的操作，
    //    白名单是另一条域。初版曾在此「顺手清同键白名单」，那是把「归一」当成了目的 ——
    //    它会静默改掉另一张表里属于别的操作的用户状态。跨域残留（同键双命中）由
    //    `resolveCandidateGate` 的优先级兜住（拒绝优先），属纵深防御。
    perProvider[provider] = perRealId
    next[canonicalId] = perProvider
    this.aggregateRejectionCache = next
    await this.writeAggregateRouting('聚合拒绝表')
  }

  /**
   * 聚合「显式允许」白名单的只读快照（与 {@link listAggregateRejections} 同口径：
   * 顶层浅拷贝、内层仍共享引用，调用方**只读**）。
   */
  listAggregateAllowed(): AggregateAllowedMap {
    this.ensureLoaded()
    return this.aggregateAllowedCache
  }

  /**
   * 设置某条候选是否**显式允许**参与轮换（用户手工打开 / 关闭）。
   *
   * ⚠️ **只动白名单、不碰拒绝表**（见 {@link aggregateAllowedCache} 的说明）：
   * 白名单服务的是未接入折算的候选（默认不参与），拒绝表服务的是已接入的候选
   *（默认参与）—— 两表的键域天然不相交。
   *
   * ⚠️ `allowed === false` 走**删键**（不留 `false` 噪音，与 `setAggregateRejected` 同口径）：
   * 表里一旦被 `false` 污染，下次读取就有人按 truthy 判成「允许」= 静默放行一个
   * 我们没有余额信息的渠道。
   */
  async setAggregateAllowed(
    canonicalId: string,
    provider: string,
    realId: string,
    allowed: boolean,
  ): Promise<void> {
    this.ensureLoaded()
    this.aggregateAllowedCache = allowed
      ? withAllowed(this.aggregateAllowedCache, canonicalId, provider, realId)
      : withoutAllowed(this.aggregateAllowedCache, canonicalId, provider, realId)
    await this.writeAggregateRouting('聚合允许表')
  }

  /**
   * 一键「拒绝非临期」：把 `keepProviders`（= **已接入**临期折算的渠道）**之外**的白名单
   * 条目全部清掉，让那些渠道回到「默认不参与」的初始态（用户后续仍可逐条手工打开）。
   *
   * ⚠️ 池**不知道**「接入临期折算」是什么语义：它只收到一份「要保留哪些 provider」的清单，
   *    该清单由调用方（RPC 层）从权威常量 `WIRED_EXPIRY_PROVIDERS` 取。这样「谁是未接入渠道」
   *    的权威仍然只有那一个常量（本仓库「同一事实两处判据」的红线）。
   *
   * @returns `cleared` = 清掉的**候选条数**（面板提示要用它）；`aggregateAllowed` = 清后的白名单。
   * ⚠️ `cleared === 0` 时**不写盘**（幂等；也避免把一次空点击变成一次整体替换）。
   */
  async clearAggregateAllowedExcept(
    keepProviders: readonly string[],
  ): Promise<{ cleared: number; aggregateAllowed: AggregateAllowedMap }> {
    this.ensureLoaded()
    const keep = new Set(keepProviders)
    const next: AggregateAllowedMap = {}
    let cleared = 0
    for (const [canonicalId, byProvider] of Object.entries(this.aggregateAllowedCache)) {
      const keptProviders: Record<string, Record<string, boolean>> = {}
      for (const [provider, byRealId] of Object.entries(byProvider)) {
        if (keep.has(provider)) keptProviders[provider] = byRealId
        else cleared += Object.keys(byRealId).length
      }
      if (Object.keys(keptProviders).length > 0) next[canonicalId] = keptProviders
    }
    if (cleared > 0) {
      this.aggregateAllowedCache = next
      await this.writeAggregateRouting('聚合允许表')
    }
    return { cleared, aggregateAllowed: this.aggregateAllowedCache }
  }

  /** 聚合手工顺序表的只读快照（缺键 = 未自定义）。 */
  listAggregateOrder(): AggregateOrderMap {
    this.ensureLoaded()
    return this.aggregateOrderCache
  }

  /**
   * 写入某虚拟模型的**手工顺序**。
   *
   * ⚠️ **过滤与去重必须在这里做**（服务端是权威）：入参是客户端拖动后拼出来的数组，
   *    可能含「不含 NUL 分隔符的畸形元素」与「重复元素」。重复会让比较器**非确定**
   *   （同一候选有两个位次）；畸形元素在适配器里解析不出 `(provider, realId)`
   *    ⇒ 静默失效（顺序表看着有内容却全不生效）。
   *
   * ⚠️ 返回**落盘后的权威数组**（不是入参回声）—— 客户端据此校正本地状态，
   *    否则「客户端以为排好了、服务端丢了一半」会长期分叉。
   * ⚠️ 空数组 = 未自定义（删键，回落临期序）。
   */
  async setAggregateOrder(canonicalId: string, entries: readonly string[]): Promise<string[]> {
    this.ensureLoaded()
    const seen = new Set<string>()
    const kept: string[] = []
    for (const entry of entries) {
      if (typeof entry !== 'string' || !entry.includes('\u0000')) continue
      if (seen.has(entry)) continue
      seen.add(entry)
      kept.push(entry)
    }
    const next: AggregateOrderMap = { ...this.aggregateOrderCache }
    if (kept.length === 0) delete next[canonicalId]
    else next[canonicalId] = kept
    // ⚠️ 必须在写盘**之前**更新缓存：`queueStoreSave` 读的是缓存字段（不是入参），
    //    顺序反了会让返回值与落盘内容都是旧值（本仓库「写回被自己覆盖」的同型缺陷）。
    this.aggregateOrderCache = next
    await this.writeAggregateRouting('聚合手工顺序')
    return this.aggregateOrderCache[canonicalId] ?? []
  }

  /** 排序模式（`'expiry'` = 升级前行为）。 */
  listAggregateOrderMode(): AggregateOrderMode {
    this.ensureLoaded()
    return this.aggregateOrderModeCache
  }

  /**
   * 切换排序模式并落盘。
   *
   * ⚠️ 幂等：写同一个值**不落盘**（一次空点击不该触发一次整体替换）。
   */
  async setAggregateOrderMode(mode: AggregateOrderMode): Promise<void> {
    this.ensureLoaded()
    if (this.aggregateOrderModeCache === mode) return
    this.aggregateOrderModeCache = mode === 'manual' ? 'manual' : 'expiry'
    await this.writeAggregateRouting('聚合排序模式')
  }

  /**
   * 清空拒绝表（支持按虚拟模型或按渠道清）。
   *
   * - 都不传 ⇒ 清空**全部**；
   * - 只传 `canonicalId` ⇒ 清空该虚拟模型的全部候选拒绝；
   * - 只传 `provider` ⇒ 清空**所有**虚拟模型里该渠道的拒绝；
   * - 两个都传 ⇒ 清空该虚拟模型里该渠道的拒绝。
   *
   * ⚠️ 与 {@link setAggregateRejected} 的 `false` 方向**不等价**：后者是「打开某一条」，
   * 本方法是「清空一批」（即便某条从未被拒绝也无所谓）。
   */
  async clearAggregateRejected(canonicalId?: string, provider?: string): Promise<void> {
    this.ensureLoaded()
    if (canonicalId === undefined && provider === undefined) {
      this.aggregateRejectionCache = {}
      await this.writeAggregateRouting('聚合拒绝表')
      return
    }
    const next: AggregateRejectionMap = {}
    for (const [key, byProvider] of Object.entries(this.aggregateRejectionCache)) {
      if (canonicalId !== undefined && key !== canonicalId) {
        next[key] = byProvider
        continue
      }
      const kept: Record<string, Record<string, boolean>> = {}
      for (const [p, byRealId] of Object.entries(byProvider)) {
        if (provider !== undefined && p !== provider) kept[p] = byRealId
      }
      if (Object.keys(kept).length > 0) next[key] = kept
    }
    this.aggregateRejectionCache = next
    await this.writeAggregateRouting('聚合拒绝表')
  }

  /**
   * 落盘**聚合路由族**的全部状态（拒绝表 / 白名单 / 手工顺序表 / 排序模式）。
   *
   * ⚠️ 四份状态**共用一个写方法**：它们是同一份文档里的同一族状态，分开写会让
   *    「一次用户操作」产生两次整体替换，中间那一刻的快照自相矛盾
   *   （本仓库已有「分两次快照让同一份文档里的字段互相矛盾」的缺陷史）。
   * ⚠️ 调用方**必须先把 `this.xxxCache` 换成新值**再调本方法 ——
   *    `queueStoreSave` 读的是缓存字段，不是入参。
   * ⚠️ `label` 只用于日志，便于排障时区分是哪张表触发的落盘。
   */
  private async writeAggregateRouting(label: string): Promise<void> {
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.(`[jet-hub] 无持久化后端，${label}变更未落盘`)
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 「本机 OpenAI 网关」当前是否启用。
   *
   * 缺键语义为**启用**（老用户升级后行为不变），见
   * {@link gatewayEnabledCache}。
   */
  gatewayEnabled(): boolean {
    this.ensureLoaded()
    return this.gatewayEnabledCache
  }

  /**
   * 打开/关闭本机 OpenAI 网关并落盘。
   *
   * ⚠️ 这里**只改状态**，不负责启停 HTTP server —— 真正的启停由
   * `src/openai-gateway/runtime.ts` 在调用方做完持久化后接手。两者分开是为了
   * 让「存开关」与「跑进程」各自可单测，且启停失败不会把已写入的开关回滚成
   * 看似没生效的样子。
   */
  async setGatewayEnabled(enabled: boolean): Promise<void> {
    this.ensureLoaded()
    if (this.gatewayEnabledCache === enabled) return
    this.gatewayEnabledCache = enabled
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，网关开关仅本次会话有效')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 「允许局域网访问」开关当前是否打开。
   *
   * 缺键语义为**关闭**（安全默认：暴露面变大必须是显式选择），见
   * {@link gatewayAllowLanCache}。
   */
  gatewayAllowLan(): boolean {
    this.ensureLoaded()
    return this.gatewayAllowLanCache
  }

  /**
   * 打开/关闭「允许局域网访问」并落盘。
   *
   * ⚠️ 与 {@link setGatewayEnabled} 同约定：只改状态，不重建 HTTP server ——
   * 换绑（关旧实例 → 建新实例）由 `src/openai-gateway/runtime.ts` 在调用方
   * 做完持久化后接手。
   */
  async setGatewayAllowLan(allowLan: boolean): Promise<void> {
    this.ensureLoaded()
    if (this.gatewayAllowLanCache === allowLan) return
    this.gatewayAllowLanCache = allowLan
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，局域网开关仅本次会话有效')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 「渠道原生搜索」总开关当前是否启用。
   *
   * 缺键语义为**启用**（见 {@link nativeWebSearchCache}）。
   *
   * ⚠️ 调用方（`web-native.ts` 的监听器）**必须每次现读**，不能缓存返回值：
   * 用户随时可能在 Jet Hub 面板里切换。
   */
  nativeWebSearchEnabled(): boolean {
    this.ensureLoaded()
    return this.nativeWebSearchCache
  }

  /**
   * 打开/关闭「渠道原生搜索」并落盘。
   *
   * 关闭后，即使 CodeBuddy / WorkBuddy 渠道也改为走 DeepSeek 官方搜索
   *（需要 `DEEPSEEK_API_KEY`）—— 即所有渠道的搜索行为统一。
   */
  async setNativeWebSearchEnabled(enabled: boolean): Promise<void> {
    this.ensureLoaded()
    if (this.nativeWebSearchCache === enabled) return
    this.nativeWebSearchCache = enabled
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，原生搜索开关仅本次会话有效')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 「ZCode 会话负载均衡」开关当前是否启用。
   *
   * 缺键语义为**启用**（见 {@link sessionBalanceCache}）。
   *
   * ⚠️ 调用方（`credential-resolver.ts` 与 `zcode-adapter.ts` 的选号路径）
   * **必须每次现读**，不能缓存返回值：用户随时可能在 Jet Hub 页头切换。
   */
  sessionBalanceEnabled(): boolean {
    this.ensureLoaded()
    return this.sessionBalanceCache
  }

  /**
   * 打开/关闭「ZCode 会话负载均衡」并落盘。
   *
   * 关闭后 ZCode 回到「手动顺序首个可用账号」的既有语义 —— 与开关加入前
   * 逐字节同路径（`getAvailableAccount`），不经过 session 排序。
   */
  async setSessionBalanceEnabled(enabled: boolean): Promise<void> {
    this.ensureLoaded()
    if (this.sessionBalanceCache === enabled) return
    this.sessionBalanceCache = enabled
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，会话负载均衡开关仅本次会话有效')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 「面板入口」的当前取值：Jet Hub 的唯一入口位置。
   *
   * 缺键语义为 `'sidebar'`「仅侧栏」（见 {@link panelEntryCache}）。
   *
   * ⚠️ 调用方（客户端在 `apply` 里注册两处入口前）**必须每次现读**，不能缓存
   * 返回值：用户随时可能在插件详情页的卡片里改它，而客户端只在启动时读一次。
   */
  panelEntry(): PanelEntry {
    this.ensureLoaded()
    return this.panelEntryCache
  }

  /**
   * 改「面板入口」并落盘。
   *
   * 两个取值**严格互斥**，任一时刻只有一个入口存在：
   * - `'sidebar'`：主导航里多一行，`settings.section` 那一节注销；
   * - `'settings'`：只剩「设置 → 插件 → Jet Hub」，主导航那一行注销。
   * 两种情况下 Jet Hub 页面本身的功能完全不受影响（同一组件、同一份 rpcCall）。
   */
  async setPanelEntry(entry: PanelEntry): Promise<void> {
    this.ensureLoaded()
    if (this.panelEntryCache === entry) return
    this.panelEntryCache = entry
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，面板入口仅本次会话有效')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 读取供应商自定义显示顺序（进程内权威副本）。
   *
   * 空数组 = 用户尚未自定义（或老文档没有该键），展示侧按声明顺序渲染。
   */
  providerOrder(): string[] {
    this.ensureLoaded()
    return this.providerOrderCache
  }

  /**
   * 写入供应商自定义显示顺序并落盘。
   *
   * ⚠️ 入参**原样保存**、不在池里做 provider 合法性过滤：合法集合随插件版本
   * 变化，在此过滤会让「新版本加入 provider → 被旧版本代码重写文档」场景下
   * 的顺序无法保留。脏值防护由两层承担：RPC 层校验 `string[]`，
   * store 层 `sanitizeProviderOrder` 去重/剔除非字符串。
   */
  async setProviderOrder(order: string[]): Promise<void> {
    this.ensureLoaded()
    const next = Array.isArray(order) ? [...order] : []
    if (this.providerOrderCache.length === next.length
      && this.providerOrderCache.every((id, index) => id === next[index])) return
    this.providerOrderCache = next
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，供应商顺序仅本次会话有效')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 当前设置的 MiniMax 国际站 `X-Forwarded-For` 值；`undefined` = 不附头。
   *
   * ⚠️ 请求侧（`minimax.ts` 的 `minimaxHeadersFor`）**必须每次现读**，不能缓存：
   * 用户随时可能在面板里改这个设置。
   */
  minimaxXff(): string | undefined {
    this.ensureLoaded()
    return this.minimaxXffCache
  }

  /**
   * 设置（或清除）MiniMax 国际站的 `X-Forwarded-For` 并落盘。
   *
   * 传空串 / `undefined` = **清除**（不附头）。校验由 `sanitizeMinimaxXff` 统一做：
   * 非法值（主机名、XFF 链、含换行等）**不会**被写进缓存 —— 于是「填了个坏值」
   * 与「没填」等价，不会让请求带上一个可能触发头注入的串。
   *
   * ⚠️ 非法值**静默归一为 `undefined`** 而不是抛错：本设置是可选逃生口，
   * 用户输错一个字符就报错阻断保存只会更糟。但 RPC 层会把**归一后的实际值**
   * 回给客户端，UI 照它渲染，用户能立刻看出「没生效」。
   */
  async setMinimaxXff(value: string | undefined): Promise<void> {
    this.ensureLoaded()
    const next = sanitizeMinimaxXff(value)
    if (this.minimaxXffCache === next) return
    this.minimaxXffCache = next
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，MiniMax XFF 设置仅本次会话有效')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 打开/关闭某个模型。
   *
   * 关闭时写入 `true`；打开时**删除该键**而不是写 `false` —— 保持黑名单
   * 里只留真正被关闭的模型，`disabledModelsFor` 的语义因此始终是
   * "键存在且为 true 即隐藏"，配置文件也不会随开关操作无限膨胀。
   */
  async setModelDisabled(provider: string, modelId: string, disabled: boolean): Promise<void> {
    const next: ModelDisableMap = { ...this.modelCache }
    const perProvider = { ...(next[provider] ?? {}) }
    if (disabled) perProvider[modelId] = true
    else delete perProvider[modelId]
    if (Object.keys(perProvider).length === 0) delete next[provider]
    else next[provider] = perProvider
    await this.writeModels(next)
    // ⚠️ **打开任意一个模型 ⇒ 清除「整体关闭」意图**（Gitee issue IKP8OF）。
    // 理由见 {@link clearProviderClosed}：意图为真时全部模型都被过滤掉，
    // 用户此时打开某一个模型若不清意图，会「点了没反应」且零报错。
    if (!disabled) await this.clearProviderClosed(provider)
  }

  /**
   * 批量关闭一批模型（Jet Hub 模型列表的「关闭全部」）。
   *
   * 语义是**按当前列表逐项加入黑名单**，与 {@link setModelDisabled} 的关闭方向
   * 一致，只是**一次落盘**：逐条调用会写 N 次完整文档（30 个模型就是 30 次
   * 整体重写 + 30 次目录广播），且中途失败会留下「关了一半」的黑名单。
   *
   * 空列表直接返回、不落盘：没有变更就不该产生一次无意义的写入与广播。
   * 注意这与 {@link clearDisabledModels} **不对称** —— 后者的语义是「清空」，
   * 即使传入空列表也仍有事可做（详见该方法注释）。
   */
  async setModelsDisabled(provider: string, modelIds: readonly string[]): Promise<void> {
    if (modelIds.length === 0) return
    // ⚠️ 必须先确保已载入：本类只在**读**方法里调 `ensureLoaded()`，若首次访问
    // 就是写操作，`this.modelCache` 还是初始空表 —— 一次「关闭全部」会把
    // 磁盘上已有的黑名单整体覆盖掉。
    this.ensureLoaded()
    const next: ModelDisableMap = { ...this.modelCache }
    // 与已有条目合并：先前单独关闭的模型不能因为一次「关闭全部」而丢失。
    const perProvider = { ...(next[provider] ?? {}) }
    for (const id of modelIds) perProvider[id] = true
    next[provider] = perProvider
    await this.writeModels(next)
  }

  /**
   * 批量**打开**一批模型（Jet Hub 模型列表里**按分组**的「本组全开」）。
   *
   * ## 与 {@link clearDisabledModels} 的区别是**范围**（勿混）
   *
   * 后者清空该 provider 的**全部**键，并刻意顺带清掉「已下线模型」的历史死键；
   * 本方法**只删传入的 id**。分组开关必须用本方法 —— 用「清空」会把用户特意
   * 关着的其它组一起打开（那正是分组开关要避免的事）。
   *
   * ⚠️ **无实际变更不落盘**：传进来的 id 若本来就不在黑名单里（例如该组已经
   * 全开），删不掉任何键，此时不该产生一次文档重写与目录广播 ——
   * 与 {@link setModelsDisabled} 的「空列表不落盘」是同一条精神。
   */
  async clearModelsDisabled(provider: string, modelIds: readonly string[]): Promise<void> {
    if (modelIds.length === 0) return
    // 同 setModelsDisabled：写路径必须自己保证已载入，否则会拿未载入的空表
    // 去判「有没有变更」，进而漏掉磁盘上真实存在的关闭项。
    this.ensureLoaded()
    const perProvider = this.modelCache[provider]
    if (perProvider === undefined) {
      // ⚠️⚠️ **黑名单里没有该 provider 时也必须清意图**（Gitee issue IKP8OF，
      // 真实缺陷：独立审计实测本入口是**唯一**漏清的一条）。
      //
      // 真实形态：用户关闭了供应商 ⇒ 黑名单 = **当时目录**的 id；目录随后变长
      // ⇒ 新模型**不在黑名单里**。用户在设置页对「只含这些新模型的分组」点
      // 「本组全开」⇒ 走到本方法 ⇒ 一个键都删不掉 ⇒ 早期这里直接 `return`
      // ⇒ 意图永远为真 ⇒ `listModels` 恒返回 `[]`。
      // 用户看到的是：**点了、没报错、模型列表纹丝不动**。
      await this.clearProviderClosed(provider)
      return
    }
    const nextPerProvider = { ...perProvider }
    let changed = false
    for (const id of modelIds) {
      if (nextPerProvider[id] === true) {
        delete nextPerProvider[id]
        changed = true
      }
    }
    if (!changed) {
      // ⚠️⚠️ 同上：`!changed` 是**意图关闭态的必然形态**（要打开的那些 id 恰好
      // 都不在黑名单里），早期这里直接 `return` ⇒ 意图不清 ⇒ 点击变成死操作。
      // 与 `clearDisabledModels` 的同名分支**逐字同构**。
      await this.clearProviderClosed(provider)
      return
    }
    const next: ModelDisableMap = { ...this.modelCache }
    // 与 setModelDisabled 同约定：该 provider 一个关闭项都不剩时删掉整个键，
    // 配置文件不随开关操作膨胀。
    if (Object.keys(nextPerProvider).length === 0) delete next[provider]
    else next[provider] = nextPerProvider
    await this.writeModels(next)
    // ⚠️ 打开方向 ⇒ 清除「整体关闭」意图（同 {@link setModelDisabled}）。
    await this.clearProviderClosed(provider)
  }

  /**
   * 批量启用/停用某 provider 的**全部**账号（Jet Hub 左侧供应商一键开关）。
   *
   * ## 为什么需要批量方法
   *
   * 供应商级开关的语义是「关闭该供应商」= 关掉它的全部模型（黑名单）+
   * 停用它的全部账号。前者复用 {@link setModelsDisabled}，后者没有现成路径 ——
   * 逐账号调 {@link updateAccount} 会写 N 次完整文档（且每次都可能与其它
   * provider 的改动互相覆盖），故这里一次落盘。
   *
   * ## 与「账号级开关」的区别（勿混）
   *
   * 账号级开关（账号卡片上的「停用/启用」）只动**单个**账号，且带
   * 「是否连带关闭该 provider 模型」的询问（见前端 `toggleAccount`）。
   * 本方法只动 `enabled`，**不碰模型黑名单**、不做任何询问 ——
   * 模型那侧由调用方（`provider.setEnabled` 端点）按固定顺序显式处理。
   *
   * ## 语义要点
   *
   * - **只改本 provider 的账号**：账号存在一个全局数组里（各 provider 混排），
   *   与 {@link reorderAccounts} 的隔离约定一致，绝不波及其它 provider。
   * - **幂等且无变更不落盘**：全部已是目标状态时直接返回 0，不产生无意义的
   *   文档重写（与 {@link setModelsDisabled} 的「空列表不落盘」同精神）。
   * - ⚠️ **返回「实际变更数」而非「命中数」**：调用方用它给用户提示
   *   （如「已停用 2 个账号」）。若返回命中数，全部本就停用时也会报「已停用 2 个」，
   *   用户会以为发生了他没预料到的改动。
   *
   * @param provider - provider id（`this.product.id`，不要写死字面量）
   * @param enabled - 目标状态：true 启用 / false 停用
   * @returns 实际被改变的账号数
   */
  async setAccountsEnabled(provider: string, enabled: boolean): Promise<number> {
    // ⚠️ 必须先确保已载入：本类只在**读**方法里调 `ensureLoaded()`，若首次访问
    // 就是写操作，`this.cache` 还是初始空数组 —— 这里虽然会按 provider 过滤后
    // 才写，但 `writeAccounts` 是**整体替换**，未载入时写回等于把磁盘上其它
    // provider 的账号全部抹掉（与 setModelsDisabled 的教训同型，后果更严重）。
    this.ensureLoaded()
    const accounts = this.cache
    let changed = 0
    const next = accounts.map((entry) => {
      if (entry.provider !== provider) return entry
      // 只把「显式 boolean」与目标比较：老文档里 enabled 可能缺失，
      // 缺失语义等同启用（与适配器 `enabled !== false` 的判定保持一致）。
      const current = entry.enabled !== false
      if (current === enabled) return entry
      changed++
      return { ...entry, enabled }
    })
    // 无实际变更不落盘：避免一次「没有任何改动」的开关操作产生文档重写。
    if (changed === 0) return 0
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[jet-hub] 已${enabled ? '启用' : '停用'} ${provider} 的 ${changed} 个账号`,
    )
    return changed
  }

  /**
   * 清空某 provider 的全部关闭项（Jet Hub 模型列表的「打开全部」）。
   *
   * ⚠️ **刻意不看模型目录**：直接删掉该 provider 在黑名单里的**全部**键，
   * 而不是按当前目录逐个删。理由是「曾被关闭、后来从服务端目录里下线」的
   * 历史遗留键 —— 按目录删的话它们永远清不掉，黑名单会积累死键，残留键
   * 将来若被同名模型复用还会莫名隐藏它。
   *
   * 该 provider 本就无关闭项时直接返回、不落盘。
   */
  async clearDisabledModels(provider: string): Promise<void> {
    // 同 setModelsDisabled：写路径必须自己保证已载入，否则「本就为空」的判据
    // 会建立在未载入的空表上（磁盘上有黑名单却被判成无事可做）。
    this.ensureLoaded()
    if (this.modelCache[provider] === undefined) {
      // ⚠️⚠️ **黑名单本就为空时也必须清意图**（Gitee issue IKP8OF）。
      // 早期这里直接 `return`，而「关闭供应商」在**目录读失败但并集非空**的
      // 形态下会写下意图却不写黑名单吗？不会 —— 但反过来成立：
      // 用户先关（意图 + 黑名单），随后**逐条打开**全部模型（黑名单被逐键删光），
      // 意图由 `clearModelsDisabled` 清掉；若那条路径没清，这里就是**最后一道**
      // 能救回来的地方。若本分支直接返回 ⇒ 意图永远为真 ⇒ 模型选择器恒空。
      await this.clearProviderClosed(provider)
      return
    }
    const next: ModelDisableMap = { ...this.modelCache }
    delete next[provider]
    await this.writeModels(next)
    // ⚠️ 打开方向 ⇒ 清除「整体关闭」意图（同 {@link setModelDisabled}）。
    await this.clearProviderClosed(provider)
  }

  /**
   * 一次性写入「模型黑名单 + 供应商关闭意图」并落盘**一次**（Gitee issue IKP8OF）。
   *
   * ## ⚠️⚠️ 为什么必须合并成一次落盘（真实窗口，已实测）
   *
   * `provider.setEnabled(false)` 的语义是「关掉全部模型 + 记下关闭意图」。
   * 若分两次落盘（先 `setModelsDisabled`、再 `setProviderClosed`），第二次失败时：
   *
   * ```
   * 磁盘: disabledModels = {buddy:{a:true,b:true}}   ← 已写
   * 磁盘: providerClosed  = {}                        ← 未写（失败）
   * 内存: providerClosedFor = true                    ← 内存已是 true，本次会话看起来正常
   * ```
   *
   * 后果是**重启后静默复发**：意图丢了 ⇒ 只剩派生判据 ⇒ 目录一变长就翻回
   * 「已打开」（正是本 issue 的症状），而用户完全不知道「上次关闭其实只成了一半」。
   *
   * ⇒ 两者必须**同一份快照、同一次 `save`**：要么都落盘、要么都不落盘。
   * 这与 `queueStoreSave` 的既有约定（账号 / 黑名单 / 各开关**取自同一时刻**）
   * 完全同源 —— 那份注释里已写明「分两次快照会让同一份文档里的字段互相矛盾」。
   *
   * ## 参数语义：**合并**（与 `setModelsDisabled` 同口径）
   *
   * 传「要追加关闭的 id 列表」而不是整张表 —— 这样调用方不必先读全表再拼，
   * 少一次「读 → 拼 → 写」的往返，也就少一个读到的快照过期的时间窗。
   *
   * @param provider - provider id
   * @param modelIds - 要**追加**进黑名单的 id（已有的关闭项不受影响）
   * @param closed - 目标关闭意图（`true` 写入 / `false` 删除该键）
   */
  async writeModelsWithProviderClosed(
    provider: string,
    modelIds: readonly string[],
    closed: boolean,
  ): Promise<void> {
    this.ensureLoaded()
    const next: ModelDisableMap = { ...this.modelCache }
    if (modelIds.length > 0) {
      const perProvider = { ...(next[provider] ?? {}) }
      for (const id of modelIds) perProvider[id] = true
      next[provider] = perProvider
    }
    this.modelCache = next
    const nextClosed: ProviderClosedMap = { ...this.providerClosedCache }
    if (closed) nextClosed[provider] = true
    else delete nextClosed[provider]
    this.providerClosedCache = nextClosed
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，模型黑名单与关闭状态变更未落盘')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 一次性**清空**某 provider 的黑名单**并**清除「关闭意图」并落盘**一次**
   *（Gitee issue IKP8OF，「打开供应商」专用）。
   *
   * ## ⚠️⚠️ 为什么必须合并（对抗审计打穿的真实窗口）
   *
   * 「打开供应商」原先走两步：`clearDisabledModels`（save #1）→
   * `setProviderClosed(false)`（save #2）。实测 `saves=2`，两次 `replace` 之间
   * 磁盘上是「**黑名单空 + 意图真**」。若第二次失败或进程被杀：
   *
   * ```
   * 磁盘: disabledModels = {}            ← 已清
   * 磁盘: providerClosed  = {buddy:true} ← 仍是「已关闭」
   * 内存: providerClosedFor = false      ← 本次会话看起来正常
   * ```
   *
   * ⇒ **重启后该供应商的模型选择器恒空**（意图真 + 黑名单空 ⇒ `listModels` 返回
   * `[]`、`provider.status` 报 `closed:true`），而设置页黑名单里一条关闭项都没有
   * ⇒ 用户无从归因，只能手工编辑 `state.json`。
   *
   * ⚠️ 危险的那条路径恰好是**最常见**的一条：只有「黑名单本来就空」时
   * `clearDisabledModels` 才会一次写完（它的早退分支）；黑名单非空（= 用户真的
   * 关过东西、现在要打开）时必然两次。
   *
   * ⚠️ 语义与 {@link clearDisabledModels} **逐字相同**（清空该 provider 的全部键，
   * 含历史死键），只是把「清意图」并进同一次落盘。
   */
  async clearModelsWithProviderClosed(provider: string): Promise<void> {
    this.ensureLoaded()
    const next: ModelDisableMap = { ...this.modelCache }
    const hadModels = next[provider] !== undefined
    delete next[provider]
    const nextClosed: ProviderClosedMap = { ...this.providerClosedCache }
    delete nextClosed[provider]
    const hadIntent = this.providerClosedCache[provider] === true
    // 无实际变更不落盘（与 `clearDisabledModels` / `setProviderClosed` 同精神）。
    if (!hadModels && !hadIntent) return
    this.modelCache = next
    this.providerClosedCache = nextClosed
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，模型黑名单与关闭状态变更未落盘')
      return
    }
    await this.queueStoreSave()
  }

  /** 持久化模型黑名单（同时更新进程内权威副本）。 */
  private async writeModels(disabledModels: ModelDisableMap): Promise<void> {
    this.modelCache = disabledModels
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无持久化后端，模型黑名单变更未落盘')
      return
    }
    // 与 writeAccounts 对称：整体写入必须携带账号列表，否则会被清空 ——
    // 快照由 queueStoreSave 在轮到本次时统一取（三份数据同源）。
    await this.queueStoreSave()
  }

  /**
   * 状态文档里那份**镜像字段**（`loomyPermanentLocked`）。
   *
   * ⚠️ 它只是镜像，权威表在独立文档（见 {@link persistLocks}）。仍继续同源写出
   * 有两个理由：① 同机其它 profile 里的**旧版本代码**只认这个字段（它读它、
   * 也原样写回它），保持一致才能让那一侧的 Loomy 面板显示正确的锁定态；
   * ② 回退到老版本时用户不会看到「锁定悄悄失效」。
   * 二者**取自同一次快照**，于是「同一份状态里两个字段自相矛盾」这种隐性分歧
   * 从结构上就不可能出现。
   */
  private lockFields(): Pick<JetHubState, 'loomyPermanentLocked'> {
    return { loomyPermanentLocked: this.permanentLockCache.loomy === true }
  }

  /**
   * 某 provider 的「锁定永久积分」是否开启。
   *
   * 锁定后选号**只允许消耗会近期作废的积分**，永久积分不参与 ——
   * 只剩永久积分的账号在锁定期间等同于不可用（用户语义：「没有临时积分后
   * 找可用账号就是没有可用账号」）。
   *
   * ⚠️ 「什么算永久积分」各 provider 不同（Loomy 看服务端给的每日池；两个 buddy
   * 看资源包的扣费截止距今是否满 15 天），但**开关本身是同一件事**，故共用本表。
   */
  permanentLocked(provider: string): boolean {
    this.ensureLoaded()
    return this.permanentLockCache[provider] === true
  }

  /**
   * 设置某 provider 的「锁定永久积分」开关（持久化）。
   *
   * ⚠️ 解锁时**删除该键**而不是写 `false`（与模型黑名单同款约定）：表里只留
   * 真正处于锁定态的 provider，`permanentLocked` 的判据因此始终是
   * 「键存在且为 true 即锁定」。
   */
  async setPermanentLocked(provider: string, locked: boolean): Promise<void> {
    if (provider.length === 0) return
    this.ensureLoaded()
    const next: PermanentLockMap = { ...this.permanentLockCache }
    if (locked) next[provider] = true
    else delete next[provider]
    this.permanentLockCache = next
    await this.persistLocks()
  }

  /**
   * 落盘锁定表：先写**权威**（独立文档），再同步**镜像**（state.json）。
   *
   * ⚠️ 顺序与容错都是有意的：
   * - 权威先落 —— 独立文档才是本 profile 选号的依据；镜像写失败只让另一条
   *   工作区的面板显示旧值，不会让我们**误烧用户的永久积分**；
   * - 镜像失败只 warn，不向上抛 —— 否则一次 settings 后端抖动会让面板上的
   *   「锁定」按钮报错，而实际开关已经生效。
   *
   * 写镜像沿用「读 → 改 → 整体写回」的既有约定：必须连同账号与黑名单一起带，
   * 否则那份文档里的另外两份数据会被抹掉。
   */
  private async persistLocks(): Promise<void> {
    if (this.lockStore.kind === 'memory') {
      this.ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，永久积分锁定仅存在于内存中')
    } else {
      await this.lockStore.save({ ...this.permanentLockCache })
    }
    if (this.store.kind === 'memory') return
    // 走同一条写队列，避免与账号/黑名单的写乱序覆盖（见 {@link queueStoreSave}）。
    // ⚠ 这里**必须吞掉**异常（与改造前一致）：镜像写失败只让另一条工作区的面板
    // 显示旧值，不该让面板上的「锁定」按钮报错 —— 权威文档已经落好了。
    await this.queueStoreSave().catch(error => {
      this.ctx.logger?.warn?.(
        `[jet-hub] 锁定镜像字段写入失败（独立文档已保存，不影响本侧选号）: ${String(error)}`,
      )
    })
  }

  /** 锁定表的当前快照（备份导出用；权威来自独立文档）。 */
  permanentLocksSnapshot(): PermanentLockMap {
    this.ensureLoaded()
    return { ...this.permanentLockCache }
  }

  /** 全部处于锁定态的 provider（供设置页一次性读取）。 */
  listPermanentLocked(): string[] {
    this.ensureLoaded()
    return Object.keys(this.permanentLockCache).filter(p => this.permanentLockCache[p] === true)
  }

  /** 列出某个 provider 的所有账号（含状态信息）。
   *
   * 🔴 **视图排序（工单 08，2026-10-02）**：「任一模型限流中」的账号**沉到最后**
   * （稳定序：未限流者保持手动拖拽序不变）。**只排序这个返回视图，不改磁盘顺序** ——
   * 面板列表即时反映真实命中序（限流者沉底、解除后自动回原位），而"手动顺序=用户
   * 拖拽意图"的成文契约不受影响。写时挪位（首版方案）因破坏该契约被废弃——
   * 曾被上游行为契约测试抓出 4 条红，教训：改"展示顺序"别动"存储顺序"。
   */
  async listAccounts(provider: string): Promise<ProviderAccountStatus[]> {
    const filtered = this.readAccounts().filter(a => a.provider === provider)
    const results: ProviderAccountStatus[] = []
    for (const entry of filtered) {
      const status: ProviderAccountStatus = { ...entry }
      try {
        const info = await this.ctx.credentials.describe(credentialRef(entry.credentialRef))
        status.source = info.source
      } catch {
        // 凭据可能已被外部删除
      }
      results.push(status)
    }
    // 稳定视图排序：可用在前、限流中沉底（Array.prototype.sort 在现代引擎是稳定的）。
    const now = Date.now()
    const isLimited = (a: ProviderAccountStatus) =>
      Object.values(a.modelRateLimits ?? {}).some(resetAtMs => resetAtMs > now)
    return results.sort((a, b) => Number(isLimited(a)) - Number(isLimited(b)))
  }

  /** 列出所有 provider 的账号 */
  async listAllAccounts(): Promise<ProviderAccountEntry[]> {
    return this.readAccounts()
  }

  /**
   * 清理「凭据域名确证属于**其它**产品」的账号。
   *
   * 用途：WorkBuddy provider 从中国版（copilot.tencent.com）改造为国际版
   * （www.workbuddy.ai）后，旧账号存的仍是中国版凭据 —— 它们的 `token.domain`
   * 指向旧端点，用新 endpoint 发请求必然失败（且会一直续期失败）。
   * 这类条目已无修复价值，直接删除，让用户在 Jet Hub 重新登录。
   *
   * ## ⚠️⚠️ 判据必须是「命中别的产品的域集合」，不是「不等于本产品的 apiDomain」
   * （真实缺陷，独立审计实测证伪）
   *
   * 原判据 `domain !== product.apiDomain` **语义不成立**：
   *
   * - 凭据里 `domain` 的语义是「**登录站点**」（token 的 `iss` 主机），不是请求
   *   端点域名（`src/buddy-adapter.ts` 明文写着这一点，且 `X-Domain` 实际以
   *   `this.product.apiDomain || credential.domain` 取值 —— 凭据的 `domain`
   *   只是**兜底**）。故 `domain ≠ apiDomain` **不蕴含**「凭据发不到当前端点」。
   * - 本机实测（20 个真实腾讯系账号）证明**同一 provider 的 `domain` 合法地存在
   *   多种值**：buddy 的 `www.codebuddy.cn`（12 条）与 `copilot.tencent.com`（8 条）
   *   —— 那 12 条一直是正常可用的。该判据在 buddy 上没出事，**只是因为上游恰好
   *   没对 `CODEBUDDY` 调用本函数**；一旦推广会一次性删光它们。
   * - 更严重的是它把「**未知**」当成「失配」：跨机导入、上游新增 realm 主机、
   *   登录站改版，都会让一个**完全可用**的账号在下次启动时被静默删除
   *   （本函数原先只留一行 `logger.info`）。
   *
   * ⇒ 现判据：`domain` **属于本产品的 `knownDomains`** ⇒ 保留；
   * **命中其它产品的 `knownDomains`** ⇒ 确证失配，删除；
   * **两边都不命中（未知域）** ⇒ **保守保留**（无法判定 ≠ 失配）。
   *
   * ⚠️ 产品未声明 `knownDomains` 时**一律保留**：没有域信息就无法判定失配，
   * 删除的代价（用户重新登录 / 账号永久丢失）远大于保留一个可能失效的条目
   * （它至多续期失败并在日志里可见）。
   *
   * @param product - 目标产品配置。
   * @param foreignDomains - **其它**产品的已知域集合（用于确证失配）。
   *   缺省为空集合 ⇒ 只保留、不删除（安全默认值）。
   * @returns 被删除的账号 id 列表（供调用方记日志）。
   */
  async pruneAccountsWithForeignDomain(
    product: BuddyProduct,
    foreignDomains: readonly string[] = [],
  ): Promise<string[]> {
    const removed: string[] = []
    const own = new Set((product.knownDomains ?? []).map(d => d.toLowerCase()))
    /**
     * ⚠️ **产品未声明 `knownDomains` 时一律不删**（安全默认值）。
     *
     * 没有本产品的域信息就无法区分「本产品合法的其它 realm 主机」与「别的产品的域」
     * —— 此时把 foreign 命中的账号删掉，等于回到旧判据那种「把未知当失配」的错误，
     * 只是换了个方向。删除用户数据的代价（重新登录 / 账号永久丢失）远大于保留一个
     * 可能失效的条目（它至多续期失败并在日志里可见）。
     */
    if (own.size === 0) {
      // ⚠️ 留日志（不是静默 return）：忘了声明 `knownDomains` 会让本函数**完全不工作**，
      // 而调用方只在 `removed.length > 0` 时记日志 ⇒ 那种情况下**一个字都没有**，
      // 排障时会以为「清理跑过了、没问题」。
      this.ctx.logger?.warn?.(
        `[jet-hub] pruneAccountsWithForeignDomain: 产品 ${product.id} 未声明 knownDomains，`
        + '本次不做任何清理（无法判定失配）',
      )
      return removed
    }
    const foreign = new Set(
      foreignDomains
        // 本产品自己的域永远不算「别的产品的域」（同源产品共享登录站时避免自删）。
        .filter(d => !own.has(d.toLowerCase()))
        .map(d => d.toLowerCase()),
    )
    // ⚠️ 同上：`foreignDomains` 为空时本函数退化成「只保留、不删除」。调用方必须
    // 传「其它产品的域集合」才能清理 —— 空集合是**合法但几乎无用**的调用，
    // 留日志以免「以为清过了」。
    if (foreign.size === 0) {
      this.ctx.logger?.warn?.(
        `[jet-hub] pruneAccountsWithForeignDomain: 未提供其它产品的域集合，`
        + `产品 ${product.id} 的失配账号不会被清理`,
      )
    }
    for (const entry of this.readAccounts()) {
      if (entry.provider !== product.id) continue
      let domain = ''
      try {
        const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
        if (resolved === undefined) continue
        const parsed = JSON.parse(resolved.value) as { domain?: unknown }
        domain = typeof parsed.domain === 'string' ? parsed.domain : ''
      } catch {
        // 凭据缺失或损坏：留给「凭据未配置」的正常报错路径处理，这里不删
        continue
      }
      // domain 为空表示历史凭据未记录域名，无法判定，保守保留。
      if (domain.length === 0) continue
      const host = domain.toLowerCase()
      // 本产品的合法域（含 API 域与登录站）⇒ 保留。
      if (own.has(host)) continue
      // 确证属于别的产品 ⇒ 删除（这才是本函数真正要清的目标）。
      if (foreign.has(host)) {
        await this.removeAccount(entry.id)
        removed.push(entry.id)
      }
      // 未知域 ⇒ 保守保留（见方法注释：无法判定 ≠ 失配）。
    }
    return removed
  }

  /** 添加新账号（登录成功后调用） */
  async addAccount(entry: ProviderAccountEntry): Promise<void> {
    const accounts = [...this.readAccounts(), entry]
    try {
      await this.writeAccounts(accounts)
    } finally {
      // ⚠️ **必须放在 `finally` 里**（不是落盘之后一行）：`writeAccounts` 会先
      // 更新进程内权威副本 `this.cache`、再 `await` 落盘，故落盘抛错时账号
      // **已经是可用状态**（何况各 auth 的登录流程在调用本方法前就
      // `credentials.set` 了凭据）。通知的用途是让续期调度器认识这个账号 ——
      // 因一次磁盘失败就吞掉它，会得到「账号能用、但本会话不续期」，
      // 正是 issue IKJOZB 的同一形态。
      this.notifyAccountAdded(entry)
    }
  }

  /**
   * 注册「账号入库」回调（Gitee issue IKJOZB）。
   *
   * ## 为什么需要这个出口
   *
   * 续期调度器原先只在**插件启动那一刻**按「池是否非空」决定是否武装，而
   * 冷启动时池为空是正常态（新用户、刚清过存储）—— 此后登录的账号在本会话内
   * **永远不会被主动续期**。修法之一是「账号入库时补武装」，于是需要有人告诉
   * 调度器「池刚变了」。
   *
   * ⚠️ **收口点必须是这里**，不能逐个登录流程接线：`pool.addAccount` 在全仓库
   * 有十几处调用点（12 个 provider 的 auth、opencode 的账号槽与匿名槽、RPC 的
   * 导入/恢复分支）。逐处接线必然漏掉某一处，而漏掉的那一处会**静默**地不续期。
   *
   * @param listener 回调；**抛错会被吞掉并记 warn**（订阅者不得让登录失败）。
   * @returns 取消订阅函数。
   */
  onAccountAdded(listener: (entry: ProviderAccountEntry) => void): () => void {
    this.accountAddedListeners.add(listener)
    return () => { this.accountAddedListeners.delete(listener) }
  }

  /**
   * 逐个调用入库订阅者；**任何异常都只记日志**。
   *
   * ⚠️ 不能让订阅者的异常冒到 `addAccount` 的调用者：那条路径是「登录成功」，
   * 一个写坏的订阅者不该让用户看到「登录失败」（凭据其实已经存好了）。
   */
  private notifyAccountAdded(entry: ProviderAccountEntry): void {
    for (const listener of [...this.accountAddedListeners]) {
      try {
        listener(entry)
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[jet-hub] 账号入库通知的订阅者抛错（已忽略）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * **只追加**账号（合并导入用）：已有的 id 一律跳过，返回**实际新增**的 id。
   *
   * ⚠️ 与 {@link replaceAll} 的差别是本质的，不要互相替换：
   * - 只调用 `writeAccounts`（账号 + 黑名单整体写回，但黑名单取**当前**值），
   *   因此**不改**模型黑名单，也**不触碰**锁定表（它住在独立文档里）；
   * - 绝不删除或覆盖任何现有账号 —— 判重按 `id`，这是账号的唯一键；
   * - 入参同样经 `sanitizeAccounts` 归一化：数据来自用户提供的文件，
   *   坏条目丢弃而不是写进池里反复触发选号失败。
   *
   * ⚠️ **文件内部重复的 id 去重已下沉到 `sanitizeAccounts`**（该函数按 id 去重，
   * 全部入口共用）。本方法只需再比一次「与**池里已有**的 id 是否冲突」。
   * 备份文件可能被手工编辑过，重复条目会在池里留下两条同 id 的账号 ——
   * 那不只是「删不掉、改不动」的幽灵账号：沉底函数按 id 匹配会写出
   * `undefined` 空洞，使整个 provider 崩溃并在重启后永久丢账号
   * （详见 `sanitizeAccounts` 与 `sinkAccountToProviderEnd` 的注释）。
   */
  async mergeAccounts(accounts: readonly ProviderAccountEntry[]): Promise<string[]> {
    const current = this.readAccounts()
    const existing = new Set(current.map(entry => entry.id))
    const added: ProviderAccountEntry[] = []
    for (const entry of sanitizeAccounts(accounts)) {
      if (existing.has(entry.id)) continue
      existing.add(entry.id)
      added.push(entry)
    }
    if (added.length === 0) return []
    try {
      await this.writeAccounts([...current, ...added])
    } finally {
      // ⚠️ **必须逐个通知「账号入库」订阅者**（Gitee issue IKJOZB 的收口点）：
      // 订阅方（`src/index.ts`）据此补武装续期调度器、并清掉 aggregate 的临期折算
      // 与候选序缓存。少了这一步，合并导入的新账号在**最长 60 秒**内对 aggregate
      // 路由不可见（缓存过期前一直用旧候选序），而文档把 `addAccount` 称作唯一
      // 收口点 —— 新增一条绕过它的写入路径就等于制造第二套判据。
      // ⚠️ 与 `addAccount` 同款放在 `finally` 里：`writeAccounts` 先更新进程内
      // 权威副本、再 `await` 落盘，故落盘抛错时账号**已经是可用状态**（凭据在
      // `importBackup` 里更早就 `credentials.set` 了）。因一次磁盘失败就吞掉通知，
      // 会得到「账号能用、但本会话不续期」，正是 issue IKJOZB 的同一形态。
      // （`notifyAccountAdded` 内部已逐订阅者吞异常。）
      for (const entry of added) this.notifyAccountAdded(entry)
    }
    return added.map(entry => entry.id)
  }

  /** 更新账号部分字段 */
  async updateAccount(
    id: string,
    patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled' | 'expiresAt' | 'refreshable'>>,
  ): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === id)
    if (idx === -1) throw new Error(`Account ${id} not found`)
    const next = [...accounts]
    next[idx] = { ...next[idx], ...patch }
    await this.writeAccounts(next)
  }

  /** 删除账号（同时清理凭据） */
  async removeAccount(id: string): Promise<void> {
    const entry = this.readAccounts().find(a => a.id === id)
    if (!entry) return
    try {
      await this.ctx.credentials.unset(credentialRef(entry.credentialRef))
    } catch { /* 凭据可能已被删除 */ }
    // ⚠ **必须重新读一次**（真实缺陷，审查发现）：`credentials.unset` 会挂起若干
    // 微任务/IO，期间并发的 `addAccount` 已经把新条目写进 `this.cache` 与磁盘。
    // 若此时拿 `await` **之前**的快照做 filter 再整体写回，那个新账号会被静默丢失
    // —— 而 `account.create`（登录成功即 addAccount）与 `account.delete` 天然可并发。
    // 重新读之后到 `writeAccounts` 之间没有 `await`，因而这一段是原子的。
    await this.writeAccounts(this.readAccounts().filter(a => a.id !== id))
  }

  /**
   * **启动自愈**：按「身份字段」清理同一账号的重复条目（只留一条）。
   *
   * ## 为什么需要它（2026-10-19 真机报障）
   *
   * AutoClaw 的 `access_token` 是 JWT、**每次登录/续期都轮换**，而早期实现
   * 拿它当身份判据 ⇒ 同一账号每续一次就被当成新账号。用户面板里同一个手机号
   * 出现了 **3 次**，积分被**重复累加**：
   *
   * ```
   * 合计 62416 积分
   *   187****9406  20838
   *   187****9406  20789
   *   187****9406  20789
   * ```
   *
   * 判据侧已修（改用稳定的 `user_id`，见 `autoclawIdentityOf`），但**池里已有的
   * 重复条目不会自己消失** ⇒ 用户仍看到 62416。本方法负责一次性清掉存量。
   *
   * ## 保留哪一条
   *
   * 保留**凭据最新**的那一条（`expiresAt` 最大者）；`expiresAt` 相同则保留
   * **先出现**的（与 `writeAccounts` 的「保留首次」同口径，保证确定性）。
   * ⚠️ 不按 `id` 字典序 —— 那与「哪个账号能续期」无关。
   *
   * ## 边界
   *
   * - 身份字段缺失的条目**跳过**（无法判断，不误删）；
   * - 只处理传入的 `provider`，绝不跨渠道合并；
   * - 每次只删「确认同身份且非保留项」的条目，删除走 {@link removeAccount}
   *   （它会一并 `credentials.unset`，不留孤儿凭据）；
   * - 失败不抛：自愈是**尽力而为**，不能因此让插件启动失败。
   *
   * @param provider - provider id（如 `autoclaw`）。
   * @param field - 凭据里作身份判据的字段名（如 `user_id`）。
   * @returns 实际删除的条目数。
   */
  async dedupeByCredentialField(provider: string, field: string): Promise<number> {
    try {
      const entries = this.readAccounts().filter((a) => a.provider === provider)
      if (entries.length < 2) return 0

      // identity → 该身份下所有条目（按池顺序）
      const byIdentity = new Map<string, ProviderAccountEntry[]>()
      for (const entry of entries) {
        const resolved = await this.resolveCredentialByRef(entry.credentialRef)
        if (resolved === undefined) continue
        const raw = resolved[field]
        // ⚠️ 缺失/空值 ⇒ 无法判断，**跳过**（不是「不匹配」）。
        const identity = typeof raw === 'string'
          ? raw.trim()
          : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : ''
        if (identity === '') continue
        const list = byIdentity.get(identity)
        if (list === undefined) byIdentity.set(identity, [entry])
        else list.push(entry)
      }

      const toRemove: string[] = []
      for (const [identity, list] of byIdentity) {
        if (list.length < 2) continue
        // 保留 expiresAt 最大者；相同则保留先出现的。
        let keep = list[0]!
        for (const candidate of list.slice(1)) {
          const keepAt = keep.expiresAt ?? 0
          const candAt = candidate.expiresAt ?? 0
          if (candAt > keepAt) keep = candidate
        }
        for (const entry of list) {
          if (entry.id !== keep.id) toRemove.push(entry.id)
        }
        this.ctx.logger?.warn?.(
          `[jet-hub] ${provider} 账号去重：${field}=${identity} 有 ${list.length} 条，`
          + `保留 ${keep.id}，删除 ${list.length - 1} 条`,
        )
      }

      // ⚠️⚠️ **逐条 try**（2026-10-20 审计 P1，实测真缺陷）。
      //
      // 原写法 `for (const id of toRemove) await this.removeAccount(id)` 没有内层
      // 捕获，外层 `catch` 直接 `return 0` ⇒ 中途某条删失败会：
      //   ① 让**后面所有条都不再删**（自愈半途而废，且下次启动仍会重试，看似无害）；
      //   ② **谎报**返回值 0 —— 而实际前面已经删掉若干条，调用方的日志
      //      「已清理 N 条重复账号」会变成「什么都没删」，排查者据此以为自愈没跑。
      // 实测：3 条同身份、第 2 次 `unset` 抛错 ⇒ 池里剩 3 条、返回 0。
      //
      // ⇒ 每条独立兜底，并**如实累计**真正删掉的条数。
      let removed = 0
      for (const id of toRemove) {
        try {
          await this.removeAccount(id)
          removed += 1
        } catch (error) {
          this.ctx.logger?.warn?.(
            `[jet-hub] ${provider} 账号去重：删除 ${id} 失败（继续处理其余条目）：`
            + (error instanceof Error ? error.message : String(error)),
          )
        }
      }
      return removed
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[jet-hub] ${provider} 账号自愈失败（不影响启动）：`
        + (error instanceof Error ? error.message : String(error)),
      )
      return 0
    }
  }

  /**
   * 重排某 provider 下账号的顺序（Jet Hub 拖拽排序）。
   *
   * ## 为什么顺序有实际意义
   *
   * 账号列表的数组顺序就是 {@link getAvailableAccount} 的**候选优先级**：
   * 自动选号、限流后的换号重试都按这个顺序取「第一个可用账号」。
   * 因此拖拽不是 UI 装饰，它直接决定实际用哪个账号发请求。
   *
   * ## 只动本 provider 的槽位
   *
   * 账号存在**一个全局数组**里（各 provider 混排，靠 `provider` 字段区分），
   * 而设置页是按 provider 分组渲染的。因此这里取「该 provider 账号原本占用的
   * 那些下标」，把新顺序填回这些下标 —— 其他 provider 的账号**位置不变**。
   *
   * 不这么做（例如把该 provider 的账号整体挪到数组头部）会让拖拽 CodeArts
   * 的顺序顺带改变 Buddy 账号的相对位置，属于跨面板的意外副作用。
   *
   * ## 校验：必须是同一集合的一个排列
   *
   * `orderedIds` 必须恰好包含该 provider 的**全部**账号 id（顺序可变、集合不可变）。
   * 不满足就抛错而不是「尽力而为」：
   * - 少了某个 id（前端列表过期，期间账号被别处新增）→ 若静默忽略，那个账号
   *   会莫名其妙掉到末尾，用户看到的是"顺序自己变了"；
   * - 多了未知 id → 说明前端状态与服务端不一致。
   * 两种情况都让用户刷新重试，比悄悄改数据安全。
   *
   * @param provider - provider id
   * @param orderedIds - 该 provider 全部账号 id 的目标顺序
   */
  async reorderAccounts(provider: string, orderedIds: readonly string[]): Promise<void> {
    const accounts = this.readAccounts()
    const indices: number[] = []
    const currentIds: string[] = []
    accounts.forEach((entry, index) => {
      if (entry.provider === provider) {
        indices.push(index)
        currentIds.push(entry.id)
      }
    })

    // 集合一致性校验（顺序无关）。
    const expected = new Set(currentIds)
    const got = new Set(orderedIds)
    const sameSet = orderedIds.length === currentIds.length
      && got.size === orderedIds.length
      && orderedIds.every(id => expected.has(id))
    if (!sameSet) {
      throw new Error(
        `账号列表已变化，请刷新后重试（期望 ${currentIds.length} 个账号，收到 ${orderedIds.length} 个）`,
      )
    }

    const next = [...accounts]
    // 按新顺序回填到该 provider 原本占用的下标上。
    indices.forEach((accountIndex, position) => {
      const id = orderedIds[position]
      const source = accounts.find(a => a.id === id)
      // 上面的集合校验已保证 source 必定存在；这里的判断只为类型收窄。
      if (source !== undefined) next[accountIndex] = source
    })
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(`[jet-hub] 已重排 ${provider} 账号顺序: ${orderedIds.join(', ')}`)
  }

  /**
   * 按凭据内容反查账号 id（供适配器记录"当前用的是哪个账号"）。
   *
   * 适配器不持有 ctx，也不该直接访问本类的私有凭据存储，
   * 因此这里集中做「遍历已启用账号 → 解析凭据 → 比对标识字段」。
   * @param provider - provider 名称（'buddy' | 'workbuddy' | 'codearts'）。
   * @param identity - 比对用的标识值：CodeBuddy 系传 access_token，CodeArts 传 access_key_id。
   * @returns 匹配到的账号 id；无匹配返回空串。
   */
  async findAccountIdByCredential(provider: string, identity: string): Promise<string> {
    if (identity.length === 0) return ''
    // 凭据中的唯一标识字段：CodeBuddy 系（buddy / workbuddy）用 access_token，
    // CodeArts 用 access_key_id。选错字段会导致匹配恒失败，限流记录无法归属账号。
    const identifierKey = provider === 'codearts' ? 'access_key_id' : 'access_token'
    for (const entry of this.readAccounts()) {
      if (entry.provider !== provider || !entry.enabled) continue
      const resolved = await this.resolveCredentialByRef(entry.credentialRef)
      if (resolved === undefined) continue
      if (resolved[identifierKey] === identity) return entry.id
    }
    return ''
  }

  /** 解析某个 credentialRef 下的凭据 JSON；不可用时返回 undefined。 */
  private async resolveCredentialByRef(refName: string): Promise<Record<string, unknown> | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
      if (!resolved) return undefined
      const parsed = JSON.parse(resolved.value) as unknown
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 按凭据里的**任意身份字段**查找同 provider 的已有账号。
   *
   * ## 与 {@link findAccountIdByCredential} 的区别
   *
   * 那个是**限流记录归属**专用，写死了「codearts 用 access_key_id、
   * 其余用 access_token」两套字段名，且**只看已启用账号**。
   * 本方法是**通用去重**用：调用方给字段名与值，且**不看 `enabled`** ——
   * 停用的账号同样占着一个条目的位置，重复添加它仍是重复。
   *
   * ## 为什么必须容忍「字段缺失」
   *
   * 早期登录的凭据里可能**没有**该字段（例如 zcode 的 `user_id` 是
   * 2026-10-02 才补上的）。此时**跳过该条目**（视为「无法判断」），
   * 而不是把它当成「不匹配」或直接报错 —— 前者会漏判，
   * 后者会让老用户根本添加不了账号。
   *
   * @param provider - provider id（如 `zcode`）。
   * @param field - 凭据里用作身份判据的字段名（如 `user_id`）。
   * @param identity - 要比对的值（空串直接返回 `''`，调用方据空串放弃去重）。
   * @returns 匹配到的账号 id；无匹配返回空串。
   */
  async findAccountIdByIdentityField(
    provider: string,
    field: string,
    identity: string,
  ): Promise<string> {
    if (identity.length === 0) return ''
    for (const entry of this.readAccounts()) {
      if (entry.provider !== provider) continue
      const resolved = await this.resolveCredentialByRef(entry.credentialRef)
      if (resolved === undefined) continue
      const value = resolved[field]
      // ⚠ 缺失该字段 ⇒ 无法判断，**跳过**（不是「不匹配」）。
      if (typeof value !== 'string' || value.length === 0) continue
      if (value === identity) return entry.id
    }
    return ''
  }

  /** 按 id 查找账号条目（含已停用账号）。 */
  findAccount(id: string): ProviderAccountEntry | undefined {
    return this.readAccounts().find(a => a.id === id)
  }

  /** 列出某 provider 的全部账号（含已停用），供「重测所有 / 重置所有」使用。 */
  listAccountsByProvider(provider: string): ProviderAccountEntry[] {
    return this.readAccounts().filter(a => a.provider === provider)
  }

  /**
   * 该 provider 是否**至少有一个已登录（凭据可用）的账号**。
   *
   * 供适配器的 `listModels` 做门控：没有已登录账号时返回空目录，让 DSH 的
   * `buildModelCatalog` 把整个 provider 分组隐藏（它显式
   * `.filter(group => group.models.length > 0)`），从而显著减少模型选择
   * 列表里用不上的条目（用户需求：「没有已登录账号就不显示该供应商的所有
   * 模型」）。
   *
   * ## 为什么判据是「凭据可解析」而不是「有条目」
   *
   * 1. **`logout()` 只清凭据、保留账号条目**（删除条目是另一条路径
   *    `removeAccount`）。若只看「有没有条目」，用户登出后模型仍会显示，
   *    门控形同虚设。
   * 2. **不看 `enabled`**：停用只应影响「自动选号」，与「是否已登录」无关。
   *    这与续期调度器「只按 `refreshable` 过滤、不看 `enabled`」是同一条
   *    既有约定（停用账号同样参与积分领取），故这里保持一致。
   *
   * ⚠️ **这是异步的**：需要逐个解析凭据。但只解析到**第一个可用账号**即返回
   * （短路），多账号场景下通常第一次就命中。
   *
   * ⚠️ **本方法只用于「目录展示」的门控**，绝不能用于路由判定 ——
   * DSH 约定 `listModels` 结果仅供参考，隐藏目录不等于拒绝请求
   * （被隐藏的模型仍可 `resolveModel` / 正常收发）。
   */
  async hasLoggedInAccount(provider: string): Promise<boolean> {
    for (const entry of this.listAccountsByProvider(provider)) {
      const credential = await this.resolveCredentialByRef(entry.credentialRef)
      if (credential !== undefined) return true
    }
    return false
  }

  /**
   * 按账号 id 解析凭据（**不检查 enabled**）。
   *
   * 限流重测必须能对已停用账号发请求（用户明确要求"停用的账号也能发送"），
   * 因此这里刻意与 {@link getAvailableAccount} 的过滤条件区分开：自动选择
   * 只认启用账号，而按 id 的显式探测认全部账号。
   * @returns 凭据对象；账号不存在或凭据不可用时返回 undefined。
   */
  async resolveCredentialForAccount(
    id: string,
  ): Promise<CodeArtsCredential | BuddyCredential | undefined> {
    const entry = this.findAccount(id)
    if (entry === undefined) return undefined
    const parsed = await this.resolveCredentialByRef(entry.credentialRef)
    if (parsed === undefined) return undefined
    return parsed as unknown as CodeArtsCredential | BuddyCredential
  }

  /**
   * 清除限流标记。
   *
   * @param accountId - 目标账号。
   * @param modelIds - 要清除的模型；省略时清除该账号的**全部**标记。
   * @returns 实际清除的标记数。
   */
  async clearModelRateLimits(accountId: string, modelIds?: readonly string[]): Promise<number> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) return 0
    const entry = accounts[idx]
    const current = entry.modelRateLimits
    if (!current || Object.keys(current).length === 0) return 0

    const limits = { ...current }
    let removed = 0
    const targets = modelIds ?? Object.keys(limits)
    for (const modelId of targets) {
      if (Object.prototype.hasOwnProperty.call(limits, modelId)) {
        delete limits[modelId]
        removed++
      }
    }
    if (removed === 0) return 0

    const next = [...accounts]
    const updated = { ...entry }
    // 清空后删除字段本身，避免 settings 里留下空对象噪音。
    if (Object.keys(limits).length === 0) delete updated.modelRateLimits
    else updated.modelRateLimits = limits
    next[idx] = updated
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[jet-hub] 已清除限流标记: 账号 ${accountId} 模型 ${targets.join(', ')}（共 ${removed} 条）`,
    )
    return removed
  }

  /**
   * 获取指定 provider + 模型的下一个可用账号。
   *
   * `modelId` 为空串时**不做限流过滤**——调用方（provider 的
   * resolveCredential 入口）此时还不知道要发哪个模型，只能退化为
   * "任取一个启用账号"。但 `enabled` 过滤在任何情况下都生效：
   * 停用账号绝不参与自动选择，空 modelId 也不例外。
   *
   * @param provider - provider id（`this.product.id`，不要写死字面量）
   * @param modelId - 目标模型；空串表示不按模型过滤
   * @param excludeAccountIds - 需要跳过的账号 id。
   *
   * **为什么需要 `excludeAccountIds`**：调用方在「请求级轮换」时会逐个换号
   * 重试，必须能拿到**下一个**账号而不是每次都拿回同一个。
   * 本池默认按「重置时间最早到期」排序，当失败类别**不写限流标记**时
   * （如 5xx / 请求错误 —— 它们不是限流，不该留徽章），
   * 刚失败的账号仍是排序第一，调用方若不排除它就会原地打转、
   * 换号形同虚设。Go 侧对应的是 `PickExcluding(tried)`（`pool.go:131`）。
   *
   * 在池这一层排除（而非让调用方自己跳过）是必要的：调用方只能拿到
   * 「池认为最优的一个」，无法枚举候选自己去重。
   *
   * ## ⚠️ 为什么带类型参数 `TCredential`（2026-10-08，Task 11）
   *
   * 返回类型原先写死成 `CodeArtsCredential | BuddyCredential` 这个**两家的联合**，
   * 而本池服务 **13 家**，各家凭据形状互不相同 ⇒ 每个调用方都得在结果处
   * 写一个向具体凭据类型的断言才能用。
   *
   * ⚠️ **处数实测为 21（2026-10-08 独立复审按 `90cc881` 的 diff 逐行复核）** ——
   * 本节原先写「**20 处**」、而那次 commit 的标题与正文写「**19 处**」，**两个数都不对**。
   * 复核方式（可复现，不要靠记忆）：
   *
   *     git show 90cc881 --unified=0 -- '*.ts' |
   *       grep -E '^-[^-].*\bas [A-Z][A-Za-z]*Credential\b'
   *
   * 命中 **22** 行，其中 **21** 行形如 `<x>.credential as <X>Credential`
   *（唯一的例外是池内 `JSON.parse(...) as CodeArtsCredential | BuddyCredential`，
   * 它是**被改成** `as TCredential`、不是被删）。逐处核对过上游 API：
   * **21 处的上游全部是 `getAvailableAccount`**（`lobsterai-adapter.ts` 那处
   * 因上下文窗口较窄未被正则识别，人工核对确认同源）。
   * ⚠️ 所以「这样的收窄」= **21**，不是 19/20 —— 引数时请引这个实测值。
   *
   * ⚠️ **那个断言不是「必要的坏味道」，而是纯粹的噪音**：调用方**自己**知道
   * 它在查哪一家（`this.product.id` 或字面量 id），池却把类型信息擦掉了。
   * 断言写错方向时 TS 也不会拦（`as` 双向放行），于是「中国版账号拿到国际版
   * 凭据类型」这类错位在类型层是**静默**的。
   *
   * ⇒ 改为泛型：`getAvailableAccount<ClineCredential>(CLINE.id, model)`，
   * 类型由**调用点**给出、池原样回传。**纯类型层改动，零运行时行为变化**
   * （函数体一行未改，`JSON.parse` 的结果照旧不做形状校验 —— 校验是各家
   * `parseCredential` 的职责，见 `credential-resolver.ts` 的头注）。
   *
   * ⚠️ 默认值 `CodeArtsCredential | BuddyCredential` **刻意保留**：13 家之外
   * 还有测试桩与 `ResolverPool` 这类结构化替身，去掉默认值会让它们全部编译失败，
   * 而它们本就不关心具体形状。
   */
  async getAvailableAccount<TCredential = CodeArtsCredential | BuddyCredential>(
    provider: string,
    modelId: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<{ entry: ProviderAccountEntry; credential: TCredential } | null> {
    const candidates = this.candidateAccounts(provider, modelId, excludeAccountIds)
    if (candidates.length === 0) return null
    // 候选顺序即**用户在 Jet Hub 拖拽设定的手动顺序**（`reorderAccounts` 写入）。
    //
    // 为什么不再按「限流重置时间最早到期」重排（早期实现如此）：
    // 那个排序会让手动顺序形同虚设 —— 用户把某账号拖到首位，只要另一个
    // 账号的限流重置时间更早，实际选中的仍是后者，拖拽变成纯 UI 装饰。
    // 现在的语义是「手动顺序优先，限流豁免」：顺序完全由用户决定，
    // 而当前正处于限流期的账号已被候选筛排除，不会选到。
    //
    // 注意 candidates 来自 readAccounts() 的 filter，而 filter 保持原数组
    // 顺序，故这里天然就是手动顺序，无需任何排序。
    return await this.resolveFirstCredential<TCredential>(provider, candidates)
  }

  /**
   * 按 **sessionId** 选号（ZCode 专用，2026-10-30 用户要求）。
   *
   * - `sessionId` 非空：用 rendezvous 哈希把同一会话**稳定映射**到同一个候选
   *   账号（会话亲和），不同会话自动分散到不同账号；账号集合变化时只迁移
   *   原本落在该账号上的会话。
   * - `sessionId` 为空/未传：随机洗牌后取第一个可用账号（本地 OpenAI 网关等
   *   不带 DSH 会话标识的请求，随机均衡）。
   *
   * ⚠️ 本方法**刻意覆盖手动顺序** —— 这是 ZCode 用户明确要求的负载均衡语义。
   * 其余 provider 继续走 {@link getAvailableAccount}（手动顺序优先），不受影响。
   *
   * `excludeAccountIds` 与 {@link getAvailableAccount} 同义：请求级换号时
   * 排除刚失败的账号，避免拿回同一个。
   */
  async getAvailableAccountForSession<TCredential = CodeArtsCredential | BuddyCredential>(
    provider: string,
    modelId: string,
    sessionId?: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<{ entry: ProviderAccountEntry; credential: TCredential } | null> {
    const candidates = this.candidateAccounts(provider, modelId, excludeAccountIds)
    if (candidates.length === 0) return null
    const ordered = sessionId !== undefined && sessionId.length > 0
      ? // ⚠️ 溢出均衡（2026-10-31 用户报障「每个账号的负载并不太均衡」）：
        // 会话亲和下账号负载 = 会话长度 × 重试，一个超长会话能把一个号独自
        // 吃满。超阈值账号对**新会话**沉底；阈值取 env
        // DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS（缺省 600，0=关闭）。
        // 负载数据源 = token-ledger 日聚合（纯内存读，零网络请求）。
        rankAccountsBySessionWithOverflow(
          candidates,
          sessionId,
          provider,
          accountLoadIndex(readTokenLedgerDayMap(), provider, utc8DayKey(Date.now())),
          overflowRequestsThreshold(),
        )
      : shuffleAccounts(candidates)
    return await this.resolveFirstCredential<TCredential>(provider, ordered)
  }

  /**
   * 选号候选：`provider` + `enabled` + 不在 `excludeAccountIds` + 目标模型未限流。
   *
   * 与 {@link getAvailableAccount} / {@link getAvailableAccountForSession} 共用，
   * 避免同一判据出现两份实现（两份必然漂移）。
   */
  private candidateAccounts(
    provider: string,
    modelId: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): ProviderAccountEntry[] {
    return this.readAccounts()
      .filter(a => a.provider === provider && a.enabled)
      .filter(a => excludeAccountIds === undefined || !excludeAccountIds.has(a.id))
      .filter(a => {
        // 空 modelId（未知目标模型）：无可比对的键，保持候选不变。
        if (modelId.length === 0) return true
        if (!a.modelRateLimits) return true
        const resetAt = a.modelRateLimits[modelId]
        return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
      })
  }

  /**
   * 按给定顺序逐个解析凭据，返回第一个可用账号；坏的跳过并记录原因。
   *
   * 抽成私有方法是为了让「手动顺序」与「sessionId / 随机顺序」共用**同一份**
   * 凭据解析与日志语义 —— 否则两条选号路径对「凭据损坏」的处理会分叉。
   */
  private async resolveFirstCredential<TCredential>(
    provider: string,
    candidates: readonly ProviderAccountEntry[],
  ): Promise<{ entry: ProviderAccountEntry; credential: TCredential } | null> {
    const failures: string[] = []
    for (const entry of candidates) {
      let resolved
      try {
        resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
      } catch (error) {
        failures.push(`${entry.id}: 读取凭据失败 (${String(error)})`)
        continue
      }
      if (!resolved) {
        failures.push(`${entry.id}: 凭据未配置`)
        continue
      }
      try {
        const credential = JSON.parse(resolved.value) as TCredential
        if (failures.length > 0) {
          this.ctx.logger?.warn?.(
            `[jet-hub] ${failures.length} 个 ${provider} 账号不可用，已跳过：${failures.join('; ')}`,
          )
        }
        return { entry, credential }
      } catch (error) {
        failures.push(`${entry.id}: 凭据 JSON 损坏 (${String(error)})`)
        continue
      }
    }
    if (failures.length > 0) {
      this.ctx.logger?.warn?.(
        `[jet-hub] 没有可用的 ${provider} 账号：${failures.join('; ')}`,
      )
    }
    return null
  }

  /**
   * 取某 provider **全部启用账号**的凭据（按手动顺序）。
   *
   * ## ⚠️ 为什么需要它（真实缺陷，用户报障 2026-10-07）
   *
   * 用户质疑：「workbuddy 中一个号是 1 天到期，为什么我们统计是 2000 多天，
   * **只用了第一个账号吗**？」—— **他猜对了**。
   *
   * 聚合的临期折算原先走 {@link getAvailableAccount}，那个方法只返回**一个**
   * 账号（手动序第一个可用的）。于是「渠道最早什么时候作废」只反映了那**一个**
   * 账号 —— 而用户把「1 天到期」的号拖到后面时，它的临期额度在**排序**里被完全忽略，
   * 结果是「按临期排序」把这个渠道排到后面，尽管它有一个快作废的号。
   *
   * ⚠️ 与 {@link getAvailableAccount} 的**分工**：那个方法服务于「实际发请求用哪个
   * 账号」（手动顺序优先，渠道内部换号由适配器负责）；本方法只服务于**观测**
   *（「这个渠道整体的临期额度大概什么时候作废」），**不改变选号行为**。
   *
   * ⚠️ 与 `getAvailableAccount` 一致：**跳过凭据损坏的账号**（记日志、继续），
   * 而不是整批失败 —— 一个坏账号不该让整个渠道被判成不可用。
   *
   * @param provider - 渠道 id
   * @param modelId - 真实模型 id（用于限流过滤；空串则跳过限流维度）
   * @returns 凭据数组（可能为空 = 没有可用账号）
   */
  async listAvailableCredentials(
    provider: string,
    modelId: string,
  ): Promise<Array<{ entry: ProviderAccountEntry; credential: unknown }>> {
    const candidates = this.readAccounts()
      .filter(a => a.provider === provider && a.enabled)
      .filter(a => {
        // 与 `getAvailableAccount` 同一判据：空 modelId 跳过限流过滤。
        if (modelId.length === 0) return true
        if (!a.modelRateLimits) return true
        const resetAt = a.modelRateLimits[modelId]
        return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
      })
    const out: Array<{ entry: ProviderAccountEntry; credential: unknown }> = []
    for (const entry of candidates) {
      try {
        const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
        // ⚠️ 与 `getAvailableAccount` 同判据：`resolve` 可能返回 undefined（凭据未配置）。
        if (!resolved) {
          this.ctx.logger?.warn?.(`[jet-hub] ${provider} 账号 ${entry.id} 凭据未配置（跳过）`)
          continue
        }
        out.push({ entry, credential: JSON.parse(resolved.value) as unknown })
      } catch (error) {
        // ⚠️ 单个账号的凭据坏掉只跳过它（与 `getAvailableAccount` 同取向）——
        //    否则一个坏账号会让整个渠道的临期折算失败、被判成「查不到」。
        this.ctx.logger?.warn?.(
          `[jet-hub] ${provider} 账号 ${entry.id} 的凭据不可用（临期折算跳过它）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return out
  }

  /**
   * 更新某账号某模型的重置时间。
   *
   * 关键：基于**读取到的最新账号列表**做局部合并，再把整个列表写回。
   * settings scope 的 get() 返回的是服务内部快照，可能滞后于磁盘；
   * 但 replace() 是整体替换，因此这里每次都在最新快照上合并，
   * 避免"写 A 的限流 → 读旧快照 → 写 B 的限流"把 A 的记录抹掉。
   *
   * ⚠️ **只接受比现值更大的解禁时刻**（与
   * {@link updateTraeCheckinDeviceGeneration} 同一约定）：
   *
   * 各 provider 的限流解析都有「解析不出时长 → 退回一个兜底值」的末端，而那个兜底
   * 通常是**短**的（cline 是 1 小时，而真实等待可能是 19 小时 39 分）。于是同一个
   * (账号, 模型) 上先写入的**真值**会被后写入的**兜底**覆盖 ——
   * cline「倒计时结束了还是失败，显示又 60 分钟」正是这样无限循环的。
   *
   * 并发场景最容易踩：同一 provider 的两个请求，一个拿到可解析的报文（写 19h39m），
   * 另一个拿到被 CDN 包成 HTML 的 429（写 1h），**后写的赢**。
   *
   * ⇒ 这里取「更长者」。真值被丢掉的风险不用担心：所有调用方写入的都是**未来**
   * 时刻，而过期的标记由 {@link sweepExpiredRateLimits} 清理。
   */
  async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] updateModelRateLimit: 账号 ${accountId} 不在账号列表中（已知: ${accounts.map(a => a.id).join(', ') || '空'}）`,
      )
      return
    }
    // ⚠️⚠️ **判据走共享谓词 `isValidResetAtMs`**（真实缺陷，独立审计实测证伪）：
    //
    // 原先这里只拒 `!Number.isFinite(resetAtMs)` —— 它**放过超出 `Date` 范围的
    // 有限数**（如 `1e308`）。那种值写进池后，下次同一个 (账号, 模型) 再撞限流时
    // 会走到下面的 `new Date(current).toISOString()` 并抛
    // **`RangeError: Invalid time value`**，而 17 个 `updateModelRateLimit` 调用点里
    // 有 16 个没有 try ⇒ 异常直接冒到推理路径与「重测」路径。
    //
    // 可达输入是**手工编辑过的备份文件**（`modelRateLimits: {"glm-5.2": 1e308}`）：
    // 读取侧（`sanitizeModelRateLimits`）原先也只判「有限正数」，两处**都漏了这一格**。
    // 现两侧共用同一个谓词，从结构上不可能再分叉。
    //
    // 无效时刻必须**直接拒绝**，不能当「很短的解禁时刻」处理：写进去之后所有比较
    // 都恒为 false（该模型被永久限流、sweep 也清不掉）。
    if (!isValidResetAtMs(resetAtMs)) {
      this.ctx.logger?.warn?.(
        `[jet-hub] updateModelRateLimit: 账号 ${accountId} 模型 ${modelId} 收到无效的解禁时刻 `
        + `${String(resetAtMs)}（须为 0 < v ≤ ${MAX_DATE_MS} 的有限毫秒时间戳），已忽略`,
      )
      return
    }
    const current = accounts[idx]!.modelRateLimits?.[modelId]
    /**
     * ★ **认领该键**（见 {@link expiryMarkedKeys} 的长注释）：适配器为某
     * (账号, 模型) 写过标记 ⇒ 这份证据来自**一次真实失败的请求**，
     * 强于可能滞后的余额计数器 ⇒ 观测路径（`clearModelsExhaustedForExpiry`）
     * **不得**再把它擦掉。
     *
     * ⚠️ 放在有效性校验**之后**：无效时刻会被上面拒绝（不写盘），
     * 那种情况下不该认领任何东西。
     */
    this.expiryMarkedKeys.delete(exhaustedKey(accountId, modelId))
    // ⚠️ 判据用 `>=`：相等时无需写盘（省一次 IO），语义上也无差别。
    // ⚠️ 现值也走同一谓词：**池里可能存在历史遗留的坏值**（本次修复前导入的
    //    `1e308` 已经躺在磁盘上）—— 此时 `isValidResetAtMs(current)` 为 false，
    //    于是 `markerUnchanged` 为 false、新值覆盖它（**自愈**），
    //    且下面那条日志不会对坏值调 `new Date()`（否则照样抛 RangeError）。
    const currentValid = isValidResetAtMs(current)
    const markerUnchanged = currentValid && current >= resetAtMs
    if (markerUnchanged) {
      this.ctx.logger?.info?.(
        `[jet-hub] updateModelRateLimit: 账号 ${accountId} 模型 ${modelId} 已有更长的限流标记 `
        + `(${new Date(current).toISOString()} ≥ ${new Date(resetAtMs).toISOString()})，本次不覆盖`,
      )
    }

    // 限流标记与「沉底」在同一次写盘里完成（两者都是「这个号撞限额了」的后果）。
    let next = [...accounts]
    if (!markerUnchanged) {
      const entry = { ...next[idx]! }
      entry.modelRateLimits = { ...entry.modelRateLimits, [modelId]: resetAtMs }
      next[idx] = entry
    }

    /**
     * ⚠️ **沉底必须与「本次是否覆盖标记」无关**：走到这一段就说明该账号此刻
     * 确实在限额中（否则调用方不会来报限流）。已有更长标记时标记不用改，但
     * 账号仍然受限、仍然该沉底 —— 若只在覆盖分支里沉底，同一账号第二次撞限流
     * 就不会沉底，行为变得难以解释。
     *
     * ⚠️⚠️ **但必须确认「写完之后它真的处于受限态」**：调用方可能传来一个
     * **已经过去**的解禁时刻（实测存在：`trae-model-id-selection.spec.ts` 就用
     * `Date.now() - 1000` 构造「标记已过期」的场景，另有 provider 的兜底值可能
     * 落在过去）。那种情况下账号此刻是**可用**的，把它沉底就是错的 ——
     * 用户会看到一个完全正常的号莫名掉到末尾，且 `getAvailableAccount`
     * （已判它可用）与顺序（判它受限）互相矛盾。
     *
     * 判据取**生效后的标记**（现值与新值中的较长者）是否仍在未来。取较长者是因为
     * 上面刚决定「保留更长的现值」—— 生效的就是那个值。
     * ⚠️ 现值同样必须经 `isValidResetAtMs` 过滤：池里可能有历史遗留的坏值
     * （如 `1e308`），拿它参与比较会得到无意义的结果。
     */
    const effectiveResetAt = currentValid && current > resetAtMs ? current : resetAtMs
    const stillLimited = effectiveResetAt > Date.now()

    let sank = false
    if (rateLimitSinkEnabled() && stillLimited) {
      const reordered = sinkAccountToProviderEnd(next, accountId)
      if (reordered !== null) {
        next = reordered
        sank = true
      }
    }

    // 两件事都没变化时不写盘（避免每次限流都产生一次无意义的整体重写）。
    if (markerUnchanged && !sank) return

    await this.writeAccounts(next)

    this.ctx.logger?.info?.(
      `[jet-hub] 已记录限流: 账号 ${accountId} 模型 ${modelId} 重置于 ${new Date(resetAtMs).toISOString()}`
      + (sank ? '（已沉到本 provider 末尾，解禁后不再抢占首位）' : ''),
    )
  }

  /**
   * ★ **批量**写入「该账号在这些模型上已无额度」的标记（zcode 专用，2026-10-12）。
   *
   * ## 与 {@link updateModelRateLimit} 的分工（⚠️ 别把它实现成循环调用它）
   *
   * | | `updateModelRateLimit` | 本方法 |
   * |---|---|---|
   * | 语义 | 「**撞到**限额了」（事后，来自上游错误） | 「**查到**该模型已无额度」（事前，来自余额接口） |
   * | 副作用 | 标记 **+ 账号沉底** | **只写标记**，**不沉底** |
   * | 调用方 | 各适配器（收到 429/额度错误） | `zcodeExpiry` 的折算（每次选型） |
   *
   * ## ⚠️⚠️ 为什么必须**不沉底**（这是本方法存在的唯一理由）
   *
   * 沉底（`sinkAccountToProviderEnd`）的语义是「这个号撞限额了，挪到最后，
   * 让后面的号有机会用」（见那个函数的注释）。
   *
   * 而本方法的调用场景是**每次选型折算**：它只是个**观测**动作。若它也沉底，
   * 那么「GLM-5.3 专属桶烧光、但 Flash 桶还有 5M」的账号会在**每一次**
   * auto 选型时被挪到末尾 —— 用户会发现自己的账号顺序**莫名反复变化**，
   * 而那个账号在 Flash 上明明完全可用。这属于跨面板的意外副作用。
   *
   * ## ⚠️ 为什么是「批量」
   *
   * zcode 一次余额查询就能算出**所有**已尽的模型（见 `zcode-entitlements.ts`
   * 的 `exhaustedModelsOf`）。逐个调 `updateModelRateLimit` 会**每次整体重写
   * 账号列表**（那个方法末尾是 `writeAccounts(next)`）—— N 个模型就是 N 次全量落盘。
   * 批量写只落一次盘。
   *
   * ## 标记的时长与语义
   *
   * 取 `nextUtc8DayStartMs()`（UTC+8 次日 0 点），与 zcode 的免费额度
   * **按自然日结算**一致（`zcode-adapter.ts` 的 `switchAccountOnQuota` 同口径）。
   * ⚠️ 到点后由 {@link sweepExpiredRateLimits} 清掉 ⇒ 自愈，不会永久固化。
   *
   * ⚠️ 单个模型写失败**不中断其余**？——不，本实现是**整体一次写**：
   * 要么全写、要么全不写（`writeAccounts` 是整体替换）。这是刻意的：
   * 部分成功会让「哪些模型被标了」变得不可预测，而重试的代价只是一次余额查询。
   *
   * @param accountId - 目标账号。
   * @param modelIds - 要标记的模型 id（**必须是目录形态** —— 两侧大小写不同，
   *   写错形态会让池的 `modelRateLimits[modelId]` 精确匹配**静默不命中**；
   *   形态由 `zcode-entitlements.ts` 的 `exhaustedModelsOf` 保证）。
   *   空数组时**直接返回**（不写盘）。
   */
  async markModelsExhaustedForExpiry(
    accountId: string,
    modelIds: readonly string[],
  ): Promise<void> {
    // ⚠️ 空数组直接返回：调用方可能在「没有模型已尽」时也调进来
    //    （那是最常见的一格），别让每次选型都白落一次盘。
    if (modelIds.length === 0) return
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] markModelsExhaustedForExpiry: 账号 ${accountId} 不在账号列表中（已知: ${accounts.map(a => a.id).join(', ') || '空'}）`,
      )
      return
    }
    const resetAtMs = nextUtc8DayStartMs()
    // ⚠️ 与 `updateModelRateLimit` 同一约定：**只接受比现值更大**的解禁时刻
    //    （那里的注释解释了原因：各家的兜底值可能比真值短，后写的会覆盖真值）。
    //    这里同因：一次余额查询的结论不该把一个更晚的既有标记**提前**。
    const current = accounts[idx]!.modelRateLimits ?? {}
    const toWrite: Record<string, number> = {}
    for (const modelId of modelIds) {
      if (modelId.length === 0) continue
      const existing = current[modelId]
      if (isValidResetAtMs(existing) && existing >= resetAtMs) continue
      toWrite[modelId] = resetAtMs
    }
    if (Object.keys(toWrite).length === 0) return

    const entry = { ...accounts[idx]!, modelRateLimits: { ...current, ...toWrite } }
    const next = [...accounts]
    next[idx] = entry
    await this.writeAccounts(next)
    /**
     * ★ **登记来源**（见 {@link expiryMarkedKeys} 的长注释）：
     * 只有登记过的键才允许被 `clearModelsExhaustedForExpiry` 清除 ——
     * 否则观测路径会擦掉适配器用「真实失败」写下的标记（死循环）。
     */
    for (const modelId of Object.keys(toWrite)) this.expiryMarkedKeys.add(exhaustedKey(accountId, modelId))
    this.ctx.logger?.info?.(
      `[jet-hub] 已按余额接口标记额度用尽（**不沉底**）: 账号 ${accountId} 模型 `
      + `${Object.keys(toWrite).join(', ')} 重置于 ${new Date(resetAtMs).toISOString()}`,
    )
  }

  /**
   * ★ **批量**清除「该账号在这些模型上已无额度」的标记（zcode 专用，2026-10-12）。
   *
   * ## ⚠️⚠️ 为什么必须与 {@link markModelsExhaustedForExpiry} 成对（单向门）
   *
   * 只写不清会让标记变成**单向门**：zcode 的免费额度按自然日结算，用户**当天**
   * 烧光后去面板签到、又领到额度时，标记仍挂在池里到 UTC+8 次日 0 点 ⇒
   * 「签到成功了，但这个模型当天还是用不了」。本仓库对此有明确事故史
   * （`refreshable` 被当过滤条件用，一次瞬时失败把账号永久标死）。
   *
   * ⚠️ **光靠签到路径救不回来**（实测 `scripts/verify-zcode-mark-after-claim.mjs`）：
   * `credits.claimAll` 成功只清**折算缓存**（`clearExpiryCache`），
   * **不清 `modelRateLimits`** ⇒ 自愈必须发生在**下一次折算**
   * （那时已经拿到新的余额报文，判据是 `recoveredModelsOf`）。
   *
   * ## 与 {@link clearModelRateLimits} 的分工（别合并）
   *
   * | | `clearModelRateLimits` | 本方法 |
   * |---|---|---|
   * | 语义 | 用户主动「重测 / 重置」 | 折算时**发现额度已恢复** |
   * | 传 `undefined` | 清**全部**标记 | —— 不接受省略（必须给具体模型） |
   * | 调用频率 | 低（用户点击） | 高（每次折算），故**空数组直接返回** |
   *
   * ⚠️ 之所以不直接复用 `clearModelRateLimits`：那个方法没有「只清这些、别动
   * 其余」的判据保证（传 `undefined` 会清全部），而本方法的调用方**只**知道
   * 「这些模型有额度」，对别的模型一无所知 —— 误清会让一个真已尽的模型被反复选中。
   *
   * ## ⚠️⚠️ **只清「本机制写下的」标记**（真实缺陷，两个独立审计共同命中 2026-10-12）
   *
   * `modelRateLimits` 是**两种语义共用**的一张表，且两者写的键与值完全相同：
   * ① 本机制（余额接口的观测）；② 各适配器的 `updateModelRateLimit`（**真的撞墙了**）。
   *
   * 而折算**每轮选型都跑** ⇒ 若本方法无条件删键，就会把适配器刚写下的事后证据擦掉：
   *
   * ```
   * round0: pick=zcode-A 适配器写标记=true 折算后仍在=false   ← 被擦了
   * round1: pick=zcode-A 适配器写标记=true 折算后仍在=false
   * round2: pick=zcode-A ...                                  ← 死循环，每次真烧一发请求
   * ```
   *
   * 实测（关掉折算缓存后 `3/3` 轮全中）：`scripts/verify-zcode-fight-single.mjs`。
   * ⇒ 判据取「**谁的证据更强**」：一次**真实失败**的请求强于可能滞后的余额计数器。
   * 故只删 {@link expiryMarkedKeys} 登记过的键（适配器为该键写过就会被「认领」）。
   *
   * @param accountId - 目标账号。
   * @param modelIds - 要清除的模型 id（**目录形态**）；空数组时**直接返回**。
   */
  async clearModelsExhaustedForExpiry(
    accountId: string,
    modelIds: readonly string[],
  ): Promise<void> {
    if (modelIds.length === 0) return
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] clearModelsExhaustedForExpiry: 账号 ${accountId} 不在账号列表中`,
      )
      return
    }
    const current = accounts[idx]!.modelRateLimits
    if (current === undefined) return
    /**
     * 只删**本机制写下、且确实还在**的那些
     *（见上方长注释：适配器写的标记**不许**被观测路径擦掉）。
     */
    const removed: string[] = []
    for (const modelId of modelIds) {
      if (!Object.prototype.hasOwnProperty.call(current, modelId)) continue
      if (!this.expiryMarkedKeys.has(exhaustedKey(accountId, modelId))) continue
      removed.push(modelId)
    }
    if (removed.length === 0) return

    const limits = { ...current }
    for (const modelId of removed) {
      delete limits[modelId]
      this.expiryMarkedKeys.delete(exhaustedKey(accountId, modelId))
    }
    const entry = { ...accounts[idx]!, modelRateLimits: limits }
    const next = [...accounts]
    next[idx] = entry
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[jet-hub] 额度已恢复，已清除标记: 账号 ${accountId} 模型 ${removed.join(', ')}`,
    )
  }

  /** 清理已过期的重置时间记录 */
  async sweepExpiredRateLimits(): Promise<void> {
    const accounts = this.readAccounts()
    let changed = false
    const next = accounts.map((entry) => {
      if (!entry.modelRateLimits) return entry
      const limits = { ...entry.modelRateLimits }
      for (const [modelId, resetAtMs] of Object.entries(limits)) {
        if (resetAtMs > 0 && Date.now() >= resetAtMs) {
          delete limits[modelId]
          changed = true
        }
      }
      return { ...entry, modelRateLimits: limits }
    })
    if (changed) await this.writeAccounts(next)
  }

  /**
   * 记录 TRAE 签到设备轮换代次（命中 9074 后由积分领取流程调用）。
   *
   * 与 {@link updateModelRateLimit} 同款：在**最新快照**上做局部合并后整体
   * 写回，避免与并发的账号操作互相覆盖。
   *
   * 只接受比现值**更大**的代次，防止乱序/重复回调把代次写回小值而让同一个
   * 被限流的设备号复活。
   */
  async updateTraeCheckinDeviceGeneration(accountId: string, generation: number): Promise<void> {
    if (!Number.isFinite(generation) || generation <= 0) return
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] updateTraeCheckinDeviceGeneration: 账号 ${accountId} 不在账号列表中`,
      )
      return
    }
    const current = accounts[idx]!.traeCheckinDeviceGeneration ?? 0
    if (generation <= current) return
    const next = [...accounts]
    next[idx] = { ...next[idx]!, traeCheckinDeviceGeneration: generation }
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(`[jet-hub] 账号 ${accountId} 签到设备代次 → ${generation}`)
  }

  /** 读取 TRAE 签到设备轮换代次（未设置时为 0）。 */
  traeCheckinDeviceGenerationFor(accountId: string): number {
    const entry = this.readAccounts().find(a => a.id === accountId)
    const value = entry?.traeCheckinDeviceGeneration
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }

  /**
   * 设置/清除某 opencode 账号的出口代理。
   *
   * ⚠️ **空串是合法输入**（用户显式清除代理 → 回到「与其它无代理账号共享
   * 本机出口」），故这里**不能**用 `if (!proxy) return` 早退，否则「清除」
   * 按钮点了会静默无效。清除时**删键**而不是写空串，避免下游把空串误当成
   * 「配了一个空地址」。
   *
   * 与 `updateModelRateLimit` 同款：在**最新快照**上做局部合并后整体写回，
   * 避免与并发的账号操作互相覆盖。
   */  async setOpencodeProxy(accountId: string, proxy: string): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] setOpencodeProxy: 账号 ${accountId} 不在账号列表中`,
      )
      return
    }
    const next = [...accounts]
    const entry = { ...next[idx]! }
    if (proxy.trim().length === 0) delete entry.opencodeProxy
    else entry.opencodeProxy = proxy
    next[idx] = entry
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[jet-hub] 账号 ${accountId} 代理 → ${proxyLogText(proxy)}`,
    )
  }

  /** 读取某 opencode 账号的代理（未设置时为空串）。 */
  opencodeProxyFor(accountId: string): string {
    const entry = this.readAccounts().find(a => a.id === accountId)
    return asProxyText(entry?.opencodeProxy)
  }

  /**
   * 设置/清除某 **gemini** 账号的出口代理（Gitee issue IKLTZ2）。
   *
   * ⚠️ **刻意与 `setOpencodeProxy` 分开成两份实现**，理由与字段同款：两者的
   * **语义不同**（opencode = 分份额度 / Gemini = 能不能连通）。共用一份会让
   * 「清掉 Gemini 的代理」连带清掉 opencode 的出口配置，且日志/判据也会漂移。
   *
   * ⚠️ 空串是合法输入（用户显式清除 → 直连），故**不能**用 `if (!proxy) return`
   * 早退（与 `setOpencodeProxy` 同款，见其注释）。清除时删键而非写空串。
   */
  async setGeminiProxy(accountId: string, proxy: string): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] setGeminiProxy: 账号 ${accountId} 不在账号列表中`,
      )
      return
    }
    const next = [...accounts]
    const entry = { ...next[idx]! }
    if (proxy.trim().length === 0) delete entry.geminiProxy
    else entry.geminiProxy = proxy
    next[idx] = entry
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[jet-hub] 账号 ${accountId} Gemini 代理 → ${proxyLogText(proxy)}`,
    )
  }

  /**
   * 读取某 gemini 账号的代理（未设置时为空串 = 直连）。
   *
   * ⚠️ **必须过 `asProxyText`**（实测的同族缺陷，独立于 IKLTZ2 审计发现）：
   * 该字段来自**用户可编辑的备份文件**，而 `sanitizeAccounts` 用 `{...candidate}`
   * 原样透传、不校验形状 ⇒ 池里可能存在 `"geminiProxy": 12345`。下游
   * `normalizeProxy` 第一句就是 `input.trim()` ⇒ 非字符串会在那里抛
   * `TypeError: raw.trim is not a function`，该账号**永久不可用且无自愈**
   * （症状与「代理配置坏了」同形，日志只有一句 TypeError）。
   */
  geminiProxyFor(accountId: string): string {
    const entry = this.readAccounts().find(a => a.id === accountId)
    return asProxyText(entry?.geminiProxy)
  }

  /**
   * 设置/清除某 **qoder** 账号的出口代理（真实报障 2026-10-21）。
   *
   * ⚠️ **刻意与另外两份分开成三份实现**，理由与字段同款：三者语义不同。
   * Qoder 这里补的是「国际版整站被 SNI 阻断」—— 在本字段之前，用户唯一出路
   * 是启动 DSH 前导出环境变量，而那会让中国版（本来直连 160ms）也一起去挤代理。
   *
   * ⚠️ 空串是合法输入（用户显式清除 → 直连），故**不能**用 `if (!proxy) return`
   * 早退（与另两份同款，见 `setOpencodeProxy` 的注释）。清除时删键而非写空串。
   */
  async setQoderProxy(accountId: string, proxy: string): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] setQoderProxy: 账号 ${accountId} 不在账号列表中`,
      )
      return
    }
    const next = [...accounts]
    const entry = { ...next[idx]! }
    if (proxy.trim().length === 0) delete entry.qoderProxy
    else entry.qoderProxy = proxy
    next[idx] = entry
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      // ⚠️ **只打脱敏后的 `label`，绝不打原始 `proxy`**（2026-10-25 审计 A2-02）：
      //    代理 URL 常含 `user:pass@host`，明文进日志等于把口令写进用户
      //    会随手粘贴/上报的文件；而 `label` 保留 host:port 与用户名、口令打码，
      //    排查时完全够用。
      `[jet-hub] 账号 ${accountId} Qoder 代理 → ${proxyLogText(proxy)}`,
    )
  }

  /**
   * 设置/清除某 **minimaxintl**（MiniMax 国际站）账号的出口代理。
   *
   * ## 为什么它与 `setGeminiProxy` 形状逐字同构却不共用
   *
   * 三家的**存在理由各不相同**：
   * - opencode = 多账号要**分份额度**（不设代理 = 共用一份配额）；
   * - Gemini = 墙外**能不能连通**（不设代理 = 根本连不上）；
   * - minimaxintl = 绕开**按出口 IP 国别的分流**（不设代理 = 被 307 到中国站）。
   *
   * 合成一份会让「清掉其中一家的代理」连带清掉别家的出口配置 —— 本仓库
   * 已反复记录这类「同义判据两份实现」的漂移，故**字段与实现都分开**。
   *
   * ⚠️ 空串是合法输入（用户显式清除 → 直连），故**不能**用 `if (!proxy) return`
   * 早退。清除时**删键**而非写空串（空串与「未设置」在 UI 上是两种状态）。
   */
  async setMinimaxIntlProxy(accountId: string, proxy: string): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] setMinimaxIntlProxy: 账号 ${accountId} 不在账号列表中`,
      )
      return
    }
    const next = [...accounts]
    const entry = { ...next[idx]! }
    if (proxy.trim().length === 0) delete entry.minimaxIntlProxy
    else entry.minimaxIntlProxy = proxy
    next[idx] = entry
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[jet-hub] 账号 ${accountId} MiniMax 国际站代理 → ${proxyLogText(proxy)}`,
    )
  }

  /**
   * 读取某 qoder 账号的代理（未设置时为空串 = 直连）。
   *
   * ⚠️ **必须过 `asProxyText`**（与 `geminiProxyFor` 同因）：该字段来自
   * **用户可编辑的备份文件**，而 `sanitizeAccounts` 用 `{...candidate}`
   * 原样透传、不校验形状 ⇒ 池里可能存在 `"qoderProxy": 12345`。下游
   * `normalizeProxy` 第一句就是 `input.trim()` ⇒ 非字符串会在那里抛
   * `TypeError: raw.trim is not a function`，该账号**永久不可用且无自愈**。
   */
  qoderProxyFor(accountId: string): string {
    const entry = this.readAccounts().find(a => a.id === accountId)
    return asProxyText(entry?.qoderProxy)
  }

  /**
   * 读取某 minimaxintl 账号的代理（未设置时为空串 = 直连）。
   *
   * ⚠️ **必须过 `asProxyText`**（与 `geminiProxyFor` 同款实测缺陷）：该字段来自
   * **用户可编辑的备份文件**，而 `sanitizeAccounts` 用 `{...candidate}` 原样透传、
   * 不校验形状 ⇒ 池里可能存在 `"minimaxIntlProxy": 12345`。下游 `normalizeProxy`
   * 第一句就是 `input.trim()` ⇒ 非字符串会在那里抛 `TypeError`，该账号
   * **永久不可用且无自愈**（症状与「代理配置坏了」同形，日志只有一句 TypeError）。
   */
  minimaxIntlProxyFor(accountId: string): string {
    const entry = this.readAccounts().find(a => a.id === accountId)
    return asProxyText(entry?.minimaxIntlProxy)
  }

  /**
   * 记录 opencode 指纹轮换代次。
   *
   * ⚠️ 只接受**比现值更大**的代次：乱序/重复回调把代次写回小值会让用户
   * 以为已轮换、实际指纹没换（TRAE 同款判据，见 `updateTraeCheckinDeviceGeneration`）。
   */
  async updateOpencodeFingerprintGeneration(accountId: string, generation: number): Promise<void> {
    if (!Number.isFinite(generation) || generation <= 0) return
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] updateOpencodeFingerprintGeneration: 账号 ${accountId} 不在账号列表中`,
      )
      return
    }
    const current = accounts[idx]!.opencodeFingerprintGeneration ?? 0
    if (generation <= current) return
    const next = [...accounts]
    next[idx] = { ...next[idx]!, opencodeFingerprintGeneration: generation }
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(`[jet-hub] 账号 ${accountId} 指纹代次 → ${generation}`)
  }

  /** 读取 opencode 指纹代次（未设置时为 0）。 */
  opencodeFingerprintGenerationFor(accountId: string): number {
    const value = this.readAccounts().find(a => a.id === accountId)?.opencodeFingerprintGeneration
    // ⚠️ 归一化收敛在 `normalizeOpencodeGeneration`（唯一实现）：
    //    槽组装那边读的是**池条目字段**，两边必须是同一判据。
    return normalizeOpencodeGeneration(value)
  }

  /**
   * 读取当前完整状态快照（账号列表 + 模型黑名单 + Loomy 镜像字段）。
   *
   * 供备份导出使用：返回的副本与进程内权威副本解耦，调用方修改返回值
   * 不会污染池的运行时状态。`disabledModels` 是嵌套结构，必须深拷贝
   * （浅拷贝会让内层 provider 表仍共享引用）。
   *
   * ⚠️ 这里**不含**锁定表本体（它住在独立文档里），备份导出要走
   * {@link permanentLocksSnapshot}。
   */
  getStateSnapshot(): JetHubState {
    this.ensureLoaded()
    const disabledModels: ModelDisableMap = {}
    for (const [provider, models] of Object.entries(this.modelCache)) {
      disabledModels[provider] = { ...models }
    }
    return {
      accounts: [...this.cache],
      disabledModels,
      ...this.lockFields(),
    }
  }

  /**
   * 整体替换账号列表与模型黑名单（备份导入用）。
   *
   * 与 {@link writeAccounts} / {@link writeModels} 的约定一致：整体写入时
   * 必须同时携带账号与黑名单，否则会把另一份数据抹掉。这里一次落盘完成
   * 两件事，避免中间态。
   *
   * ⚠️ 导入数据来自用户提供的备份文件（可能被手工编辑），因此先经
   * `sanitizeAccounts` / `sanitizeDisabledModels` 归一化：只保留可用的
   * 账号条目与显式 `true` 的黑名单项，坏条目直接丢弃而不是写进池里
   * 反复触发选号失败。
   *
   * ⚠️ **同 id 去重由 `sanitizeAccounts` 承担**（不要在这里再补一套 ——
   * 那会形成「一文件两套同义判据」，本项目已有该形态的事故史）。去重缺失的
   * 后果是沉底写出 `undefined` 空洞、整个 provider 崩 + 重启丢账号，
   * 详见 `sanitizeAccounts` 的注释。另：`writeAccounts` 也有一层收口去重
   * （覆盖不经归一化的写入路径）。
   *
   * ⚠️⚠️ **必须逐个通知「账号入库」订阅者**（同族未修缺陷，独立审计实测证伪）：
   * `mergeAccounts` 已补上这一步（见其注释），而本方法是**备份导入的默认模式**
   * （`replace`）—— 它整体换掉整个账号池，影响面**比 merge 更大**，却同样绕过了
   * `notifyAccountAdded` 收口点。后果与 merge 那条完全同型：导入后的账号在
   * **最长 60 秒**内对 aggregate 路由不可见（临期折算与候选序缓存未清），
   * 报 `MISSING_CREDENTIAL | …没有任何可用候选`。
   *
   * 通知时机：放在 `persistLocks()` **之后**，且只在它成功时通知 —— 与
   * `mergeAccounts` 的 `finally` 语义略有不同（那里 `writeAccounts` 先更新
   * 进程内副本再落盘，故落盘失败账号也已可用）；这里 `this.cache` 在上面就已赋值，
   * 故落盘失败时账号同样可用，**也应当通知**。故同样用 `try/finally`。
   */
  async replaceAll(
    accounts: readonly ProviderAccountEntry[],
    disabledModels: ModelDisableMap,
    permanentLocks?: PermanentLockMap,
  ): Promise<void> {
    const next = sanitizeAccounts(accounts)
    /**
     * ⚠️ **去重留痕**（真实缺口，最终审计实测证伪）：本方法**不调 `writeAccounts`**
     * （它直接赋值 `this.cache` + `persistLocks()`），故 `writeAccounts` 里那条
     * 「丢弃了 N 条同 id 重复条目」的告警在**备份导入的默认模式（`replace`）下不会触发**
     * —— 而 `replace` 恰恰是最可能遇到手工编辑备份（含重复 id）的路径。
     *
     * 后果：`accountsImported` 报的是**载荷条目数**（如 2），池里只有 1 个，
     * 且**零 warning** 解释差额 —— 与「账号自己没了、日志里什么都没有」的
     * 报障形态同型。故这里按同样的口径补一条。
     */
    const dedupedCount = new Set(next.map(entry => entry.id)).size
    const dropped = accounts.length - dedupedCount
    if (dropped > 0) {
      this.ctx.logger?.warn?.(
        `[jet-hub] replaceAll 丢弃了 ${dropped} 条同 id / 坏条目（入参 ${accounts.length} 条，落地 ${dedupedCount} 条）`,
      )
    }
    this.cache = next
    this.modelCache = sanitizeDisabledModels(disabledModels)
    /**
     * ⚠️⚠️ **导入备份 ⇒ 清空「供应商关闭意图」**（Gitee issue IKP8OF）。
     *
     * ## 为什么不能保留
     *
     * 备份载荷（`backup.ts` 的 `BackupPayload`）是「账号 + 黑名单 + 锁定表」的
     * 完整快照，**不含**意图表 —— 它是在备份格式定型之后才出现的字段，
     * `getStateSnapshot()` 也不导出它（两处一致，不是漏键）。
     * 于是「保留旧意图」会让导入结果与载荷**自相矛盾**：
     * - 导入一份**已打开**该 provider 的备份 ⇒ 旧意图仍为 `true`
     *   ⇒ 模型选择器恒空，而设置页黑名单里一条关闭项都没有（用户无法归因）；
     * - 导入一份**全关**的备份 ⇒ 意图缺失，靠派生判据仍然成立（可接受）。
     *
     * ## 为什么是「清空」而不是「从黑名单推断」
     *
     * 推断需要回答「这份黑名单是整家关闭、还是只关了几个模型」，而备份里
     * **没有目录**，无从判断。两个方向的误判代价不对称：
     * - 误判成「整家关闭」⇒ 其余模型**静默消失**（危险方向，用户会以为模型丢了）；
     * - 误判成「未关闭」⇒ 回到升级前的行为，用户再点一次开关即可（可逆）。
     * ⇒ 一律取后者：**清空意图，回落派生判据**。
     *
     * ## 如实登记的代价
     *
     * 导入备份会让「整家关闭」态**静默退化为「逐条关闭」**：目录**不再变长**时
     * 两者表现相同（派生判据仍报 `closed:true`）；只有目录**继续变长**时，
     * 新增模型会重新出现（即本 issue 的症状）。用户重新点一次供应商开关即恢复，
     * 且这是**导入备份**这一显式操作的可预期后果，不是日常路径。
     */
    this.providerClosedCache = {}
    // 备份文件可能来自不含该字段的旧版本：`undefined` 时**保持当前值**，
    // 而不是重置为空表 —— 否则导入一份老备份会静默解锁用户的永久积分。
    // 给出表时**整体替换**（备份就是完整状态快照），并同样过滤脏值。
    if (permanentLocks !== undefined) {
      this.permanentLockCache = sanitizePermanentLocks(permanentLocks)
    }
    this.loaded = true
    try {
      // 一次落盘三件事：锁定表进**独立文档**，账号与黑名单进 state.json，
      // 同时把 Loomy 的镜像字段同步过去（persistLocks 内部就是这套顺序）。
      await this.persistLocks()
    } finally {
      // ⚠️ 与 `mergeAccounts` 同款：`this.cache` 已更新（账号已可用），
      // 故落盘失败也要通知 —— 否则「账号能用、但本会话不续期 / 对聚合不可见」。
      for (const entry of next) this.notifyAccountAdded(entry)
    }
  }
}

/**
 * `listModels` 的门控：**该 provider 是否应在模型目录中展示**。
 *
 * ## 需求来源
 *
 * 「如果某供应商没有已登录的账号，就不显示该供应商的所有模型 —— 这样对大多数
 * 用户来说模型选择选项卡臃肿的问题能改善很多。」
 *
 * ## 为什么可行：DSH 原生支持「空目录即隐藏」
 *
 * `dsh-api-session-controller` 的 `buildModelCatalog` 显式做了
 * `.filter(group => group.models.length > 0)`（注释：*"successful non-empty
 * provider groups"*）。因此适配器返回 `[]` 就能让整个 provider 分组从模型
 * 选择器中消失 —— **无需任何前端改动**。
 *
 * ⚠️ **必须返回空数组，不能抛错**：`buildModelCatalog` 的 `catch` 会把抛错
 * 归入 `failures`，界面上会多出一条 provider 报错，比「不显示」更糟。
 *
 * ⚠️ **不影响路由**：`catalog.routableProviders` 由 `listProviders()` 单独
 * 生成（不经过该 filter），且 DSH 明确约定 *"Catalog membership is advisory
 * and never changes routing"* —— 隐藏目录不等于拒绝请求，已持久化的模型
 * 仍能 `resolveModel` / 正常收发。
 *
 * ## 判定语义
 *
 * - **默认开启**（`DSH_HIDE_MODELS_WITHOUT_ACCOUNT=0` 可关）：与
 *   `DSH_TRAE_MAX_MODE` 同为「默认开、显式假值才关」的语义，故单列解析函数。
 * - `accountPool` 缺失（headless / CLI / 单测）或替身未实现
 *   `hasLoggedInAccount` 时**视为可见** —— 门控是**展示优化而非安全边界**，
 *   判定不可用时宁多勿少（否则会让整个 provider 的模型凭空消失）。
 * - **六个 provider 判据完全一致**：都只看账号池。早期 CodeArts 有一个「单凭据
 *   例外」（额外认固定 ref `CODEARTS_ACCESS_TOKEN`），该模式已移除，故
 *   `extraCredentialRefs` 参数也一并删除，避免留下无人使用的分支。
 *
 * @param accountPool - 适配器的账号池（可能为 undefined）。
 * @param provider - provider id。
 */
export async function providerCatalogVisible(
  accountPool: AccountPool | undefined,
  provider: string,
): Promise<boolean> {
  if (!resolveHideWithoutAccountFlag(process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT)) return true
  if (accountPool === undefined) return true
  // 能力检测：单测替身通常只 mock 了 disabledModelsFor 等少量方法。
  if (typeof accountPool.hasLoggedInAccount !== 'function') return true
  try {
    return await accountPool.hasLoggedInAccount(provider)
  } catch {
    // 读凭据异常（存储损坏等）时保守展示：宁可多显示，也不要让用户
    // 因为一次读取抖动而「所有模型都不见了」且无从排查。
    return true
  }
}

/**
 * 解析 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT`；**默认开启**。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭。与 `isTruthyFlag`
 * 的「默认关」语义相反，故单列一个函数，**不要混用**。
 */
function resolveHideWithoutAccountFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}
