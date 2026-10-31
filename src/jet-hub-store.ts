/**
 * Jet Hub 状态持久化（账号索引 + 模型黑名单）。
 *
 * ## 为什么不能再用 settings namespace
 *
 * DSH ≤0.1.6：`ctx.settings` 是 SettingsProvider，插件用
 * `settings.register(ns, schema)` 拿到 owner scope（`get()` / `replace()`），
 * 数据落在 `$DSH_HOME/settings.yaml` 的 `jet-hub:` 段。
 *
 * DSH 0.1.7-rc.1：`ctx.settings` 换成 **SettingsForms** —— **没有 `register`**。
 * 表单命名空间只能是 **profile 条目 id**，且只投影该条目 Config 中标了
 * `.volatile()` 的字段（见 `@deepseek-ai/dsh-settings` 的 `SettingsForms`）。
 * 于是早期写法 `settings.register(...)` 在 0.1.7 上恒走
 * `typeof settings.register !== 'function'` 分支，账号列表与模型黑名单
 * **退化为纯内存**（真实缺陷：Gitee issue IKI7WT ——「DSH 0.1.7 移除
 * `settings.register()` 后，账号列表与模型黑名单无法持久化」；启动日志实证
 * `[jet-hub] settings 服务不可用，账号列表仅存在于内存中`）。
 *
 * ## 现在的策略：按能力探测两条后端
 *
 * 1. `settings.register` 可用（老 DSH）→ **沿用旧契约**，行为与数据位置完全不变；
 * 2. 否则（0.1.7+）→ 插件自有 JSON 文档 `$DSH_HOME/jet-hub/state.json`，
 *    同步读 + 原子写（tmp + rename）。
 * 3. 两者都不可用（headless / 单测替身缺服务）→ 仅内存，并**显式告警**。
 *
 * ## 为什么不把状态塞进插件 Config
 *
 * 0.1.7 的 settings 表单确实能持久化「本条目 Config 的 volatile 字段」，但
 * 账号索引与**限流重置时间戳**是运行时状态：限流每命中一次就要写一次，
 * 而写 Config 会改写 profile 的 `cordis.patch.yml` 并触发 Loader 协调 ——
 * 把易变的运行时数据混进用户手写的配置层，代价与风险都不划算。
 * 这里与 `src/models.ts` 的 `~/.cache/deveco/*.json` 是同一思路（本插件既有的
 * 文件持久化惯例）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { ProviderAccountEntry } from './types.js'
import { hasLegacyNamespaceRegistration, readService, settingsOf } from './settings-compat.js'

/** Jet Hub schema namespace（老契约的 settings 命名空间名）。 */
export const JET_HUB_NS = 'jet-hub'

/**
 * 模型黑名单：provider id → **被关闭**的模型 id → true。
 *
 * **黑名单制**：只有键存在且为 `true` 的模型被隐藏，未记录的模型默认打开。
 */
export type ModelDisableMap = Record<string, Record<string, boolean>>

/**
 * 聚合 provider 的「拒绝轮换」表：虚拟模型 id → provider → 被拒绝的 realId → true。
 *
 * ## 与相邻两张表的关系（三者语义互不相同，不要合并）
 *
 * | 表 | 语义 | 粒度 |
 * |---|---|---|
 * | `disabledModels[provider][modelId]` | **关闭这个模型**（它从模型选择器里消失） | provider + 模型 |
 * | `provider.setEnabled` | **关闭整个 provider**（等于关掉它全部模型） | provider |
 * | `aggregateRejections[虚拟模型][provider][realId]` | **这一条候选不参与该模型的轮换** | 候选 |
 *
 * ⚠️ 把某虚拟模型的候选**全部**拒绝 ≠ 关闭该虚拟模型：前者它仍在目录里
 *（只是无候选可用，请求时如实报错），后者从目录消失。
 */
export type AggregateRejectionMap = Record<string, Record<string, Record<string, boolean>>>

/**
 * 聚合 provider 的「**显式允许**参与轮换」白名单：虚拟模型 id → provider → 被允许的 realId → true。
 *
 * 形状与 {@link AggregateRejectionMap} **逐格相同**，但语义相反：本表只记录「用户**手工打开**」的候选。
 *
 * ⚠️⚠️ **为什么需要白名单，而不是「拒绝表里没有就是允许」**：
 *    未接入临期折算的渠道（7 家）的默认态是**不参与**（见 `aggregate-core.ts` 的
 *    `CandidateGate`）。若用「拒绝表里没有 = 允许」表达这个例外，老用户升级后这 7 家的
 *    全部候选会**立刻参与轮换** —— 配额未知的渠道被静默放行，请求打到用户没打算用的渠道。
 *    ⇒ 默认态必须由「该渠道是否接入折算」（渠道级编译期事实）**推导**，而**例外**（手工打开）
 *    需要本表才能表达。
 *
 * ⚠️ **两张表各有各的域、不做互斥归一**（用户 2026-10-15 的修正，规格 §5.1）：
 *    已接入折算的候选只归**拒绝表**（黑名单语义：默认参与），未接入的只归**白名单** ——
 *    两表的键域由「渠道是否接入折算」划分，**天然不相交** ⇒ 写一侧**不得**改另一侧
 *    （顺手清另一侧会静默改掉另一张表里**属于别的操作**的用户状态：拒绝一条候选不该顺手
 *    关掉同渠道其它手工打开的候选）。
 *
 * ⚠️ 只记录 `true`（缺键 = 未显式允许），与拒绝表同口径。
 */
export type AggregateAllowedMap = Record<string, Record<string, Record<string, boolean>>>

/**
 * 聚合 provider 的**手工排序**表：虚拟模型 id → 有序候选键数组。
 *
 * 元素 = `` `${provider}\u0000${realId}` ``（与本文件外的候选键约定**逐字相同**：分隔符是
 * **NUL**，不是 `:` 或 `|` —— 本仓库有过「两套同义分隔符」的缺陷史）。
 *
 * ⚠️ **缺键 / 空数组 = 未自定义**（与 `providerOrder` 同语义）：展示与轮换都回落到临期序。
 * ⚠️ **未出现在数组里的候选不是被排除**，而是「排在已排过的之后，按 临期↑ → 倍率↑」——
 *    这样新增候补（渠道新登录、目录新增模型）不会因为没有位次而消失。
 */
export type AggregateOrderMap = Record<string, string[]>

/**
 * 聚合候选的排序模式：`'expiry'`（默认，按临期）或 `'manual'`（按手工顺序）。
 *
 * ⚠️ 缺键 / 任何非法值的语义都是 `'expiry'` = **升级前行为**（老用户读到旧文档时
 * 不会突然变成手工序 —— 那时手工序表是空的，切过去等于「全都未排过」，行为其实一样，
 * 但显式回落能让面板文案不说谎）。
 */
export type AggregateOrderMode = 'expiry' | 'manual'

/** 各 provider 的「锁定永久积分」开关：provider id → 已锁定。 */
export type PermanentLockMap = Record<string, boolean>

/**
 * Jet Hub 的**唯一**入口位置。
 *
 * 两个取值严格互斥，任一时刻只有一个入口存在（见 {@link JetHubState.panelEntry}）。
 * 用字符串枚举而不是布尔，是为了将来加第三个位置时只需在 {@link PANEL_ENTRY_VALUES}
 * 里多一项 + 一条渲染分支，不动文档形状、不写迁移。
 */
export type PanelEntry = 'sidebar' | 'settings'

/** {@link PanelEntry} 的合法取值，也是 RPC 写入侧的校验表（唯一真源）。 */
export const PANEL_ENTRY_VALUES: readonly PanelEntry[] = ['sidebar', 'settings']

/** 缺键 / 脏值 / 老文档迁移时的默认入口。 */
export const DEFAULT_PANEL_ENTRY: PanelEntry = 'sidebar'

/** 持久化文档结构（两种后端共用）。 */
export interface JetHubState {
  accounts: ProviderAccountEntry[]
  disabledModels: ModelDisableMap
  /**
   * 聚合 provider 的「拒绝轮换」表（见 {@link AggregateRejectionMap}）。
   *
   * ⚠️ 住 `state.json` 是**有意**的：本文件是**整体替换**语义，旧版本代码重写时
   * 会抹掉它不认识的键。判定标准是**丢失后果是否可逆**：
   * 拒绝表丢了 = 某个候选重新参与轮换 = **回到默认行为**，用户再关一次即可
   *（对比 `loomyPermanentLocked`：丢了会真烧掉永久积分，故它住独立文档）。
   *
   * 老文档没有这个键 → 空表（没有任何拒绝），与升级前行为一致。
   */
  aggregateRejections?: AggregateRejectionMap
  /**
   * 聚合 provider 的「**显式允许**参与轮换」白名单（见 {@link AggregateAllowedMap}）。
   *
   * ⚠️ 住 `state.json` 的理由与拒绝表完全同级：丢失后果**可逆且方向安全** ——
   * 白名单丢了 ⇒ 那些未接入折算的渠道回到「默认不参与」，用户再逐条打开即可
   *（对比 `loomyPermanentLocked`：丢了会真烧掉永久积分，故它住独立文档）。
   *
   * 老文档没有这个键 → 空表（没有任何手工打开），与升级前行为一致。
   */
  aggregateAllowed?: AggregateAllowedMap
  /**
   * 聚合候选的**手工排序**表（见 {@link AggregateOrderMap}）。
   *
   * ⚠️ 丢失后果**可逆**：顺序回到临期序，用户重拖一次即恢复。缺键 / 空数组 = 未自定义。
   */
  aggregateOrder?: AggregateOrderMap
  /**
   * 聚合候选的**排序模式**（见 {@link AggregateOrderMode}）。缺键 = `'expiry'`（升级前行为）。
   */
  aggregateOrderMode?: AggregateOrderMode
  /**
   * Loomy「锁定永久积分」开关 —— **镜像字段，不是权威**。
   *
   * 权威值在 `$DSH_HOME/jet-hub/permanent-locks.json`（见
   * `src/permanent-lock-store.ts`）。本字段仍**继续同源写出**，理由有两条：
   *
   * 1. **同机多 profile**：`state.json` 是 dsh home 级共享文档，另一条工作区里
   *    的**旧版本代码**只认这一个字段（它读它、也原样写回它）。镜像保持一致，
   *    web / tui / headless 侧的 Loomy 锁定才不会与 desktop 侧脱节；
   * 2. **升级前的磁盘状态只有本字段**：新文档不存在时要靠它把老用户的锁定
   *    迁移进来（迁移判据见 `permanent-lock-store.ts` —— 只在**新文档不存在**时
   *    生效，避免把已解除的锁定重新打开）。
   *
   * ⚠️ 反过来，**新字段绝不能只住在这里**：本文档是整体替换语义，旧代码全量
   * 重写时不会携带它不认识的任何键 —— 把锁定表放这儿会被静默抹掉，而解锁的
   * 后果是真把永久积分烧掉（不可撤回）。这正是把表拆到独立文档的原因。
   */
  loomyPermanentLocked?: boolean
  /**
   * 本机 OpenAI 网关开关（`false` = 不启动网关）。
   *
   * ⚠️ 与 `loomyPermanentLocked` 不同，这个字段**可以**住在这里、不需要独立
   * 文档：老版本代码整体重写 `state.json` 时会丢掉本键，后果仅仅是**网关回到
   * 默认启用**，用户再关一次即可 —— 没有任何不可逆后果（对照 `loomyPermanentLocked`
   * 丢失会把「永久积分已锁定」静默变成「已解锁」，那才是灾难）。
   *
   * 缺键语义为**启用**：老用户升级后行为与升级前完全一致。
   */
  gatewayEnabled?: boolean
  /**
   * 「允许局域网访问」开关（2026-10-20）：`true` = 网关绑 `0.0.0.0`（全部网卡，
   * 局域网可达）；`false`/缺键 = 只绑回环或 env 配置的本机地址。
   *
   * ⚠️ 缺键语义为**关闭**（与 `gatewayEnabled` 的「缺键即启用」**刻意相反**）：
   * 暴露面变大必须是用户的显式选择——老文档没有这个键、被手工改坏、或旧版本
   * 代码整体重写时丢了本键，都必须回到「只绑回环」的安全默认。丢键的后果仅是
   * 用户重新打开一次开关（可逆），而反方向的丢键（静默回到全网卡监听）是
   * 未授权暴露。
   *
   * ⚠️ 与 `gatewayEnabled` 同级、可以住在这里：丢键后果可逆且用户可见。
   */
  gatewayAllowLan?: boolean
  /**
   * 渠道原生搜索总开关（`false` = 全部搜索回官方 provider）。
   *
   * 「原生搜索」指支持它的渠道（CodeBuddy / WorkBuddy）用**自己后端的搜索接口**
   * （`/agenttool/v1/search` 与 `/agenttool/v1/webfetch`）；关掉后这些渠道也回落到
   * DeepSeek 官方搜索（需要 `DEEPSEEK_API_KEY`）。
   *
   * ⚠️ 与 `gatewayEnabled` 同级、**可以**住在这里：老版本代码整体重写 `state.json`
   * 时会丢掉本键，后果仅仅是**回到原生搜索**，用户再关一次即可 —— 没有任何
   * 不可逆后果（对照 `loomyPermanentLocked` 的不可逆性，那才需要独立文档）。
   *
   * 缺键语义为**启用**：老用户升级后行为与升级前一致（原生搜索本就是新功能，
   * 默认开启才符合「装上就能用」）。
   */
  nativeWebSearchEnabled?: boolean
  /**
   * 「ZCode 会话负载均衡」开关（{@link sanitizeSessionBalanceEnabled}）。
   *
   * 语义：**开** = ZCode 多账号按 DSH sessionId 做会话亲和（同一会话**优先**
   * 落同一账号；账号今日负载达阈值后会被沉底、正在跑的会话会迁移一次），没有
   * sessionId 的请求随机分摊；**关** = 回到「手动顺序首个可用账号」的既有语义。
   *
   * ⚠️ 与 `nativeWebSearchEnabled` 同级、**可以**住在这里：老版本代码整体
   * 重写 `state.json` 时丢掉本键，后果仅是**回到手动顺序**，用户再开一次即可
   * —— 没有任何不可逆后果。缺键语义为**启用**（2026-10-30 用户要求的默认）。
   */
  sessionBalanceEnabled?: boolean
  /**
   * 「面板入口」：Jet Hub 的**唯一**入口位置（{@link PanelEntry}）。
   *
   * 两个取值**严格互斥**，任一时刻只有一个入口存在：
   * - `'sidebar'`（默认）= 主导航里多一行，点它把 Jet Hub 渲染进中央主面板；
   *   `settings.section` 那一节随之注销。
   * - `'settings'` = 只剩「设置 → 插件 → Jet Hub」；主导航那一行随之注销。
   *
   * ⚠️ **必须住宿主**，不能放浏览器 `localStorage`：Web 侧的 origin 是
   * `127.0.0.1:<随机端口>`，每次启动端口都变 ⇒ `localStorage` 会随旧 origin
   * 一起被抛弃，表现为「改掉的入口下次启动又变回来了」。而它又与
   * `gatewayEnabled` 同级：老版本代码整体重写 `state.json` 时会丢掉本键，
   * 后果仅仅是**入口回到默认「仅侧栏」**（可逆，用户再改一次即可），没有不可逆后果。
   *
   * 缺键语义为 `'sidebar'`：老用户升级后行为与升级前一致（升级前默认就显示那一行）。
   *
   * ⚠️ **本键取代了旧的布尔 `sidebarEntryEnabled`**：老文档里只有旧键时按
   * {@link sanitizePanelEntry} 迁移（只有明确 `false` 才映射成 `'settings'`）。
   */
  panelEntry?: PanelEntry
  /**
   * 供应商自定义显示顺序（「供应商开关」弹窗的拖拽排序，2026-10-06）。
   *
   * ⚠️ 与 `gatewayEnabled` 同级、**可以**住在这里：老版本代码整体重写
   * `state.json` 时丢掉本键的后果仅仅是**顺序回到声明顺序**——纯展示偏好，
   * 可逆、重拖一次即恢复（对照 `loomyPermanentLocked` 的不可逆性，那才需要
   * 独立文档）。缺键 / 空数组语义为「未自定义」。
   *
   * 数组含**全部**供应商 id：拖拽提交时 = 拖后的「已打开」序列 + 已关闭的
   * 按声明序缀尾。展示侧（`plugin-src/client/provider-toggle.js` 的
   * `sortOpenProvidersByOrder`）对数组中不认识 / 缺失的 id 都有稳定兜底，
   * 故插件跨版本增删 provider 时不需要任何迁移。
   */
  providerOrder?: string[]
  /**
   * MiniMax **国际站**请求要附带的 `X-Forwarded-For` 值（Gitee issue IKMEVG，2026-10-17）。
   *
   * ## 它解决什么
   *
   * `agent.minimax.io` 对所有路径恒返 `307 → agent.minimaxi.com`，而**是否 307
   * 由 Akamai 按请求来源 IP 的国别决定**（本机实测：美国 `8.8.8.8`、日本
   * `133.130.0.1`、新加坡、香港的 IP ⇒ 留在国际站；中国 `114.114.114.114`、
   * `223.5.5.5`、`180.76.76.76` ⇒ 307；内网/非法/空值 ⇒ 视为无此头，同样 307）。
   *
   * ⇒ 中国大陆出口的用户**永远**拿不到国际站数据面，无论 token 多有效。
   * 设置本字段后，国际站请求会附带 `X-Forwarded-For: <该值>`，从而被判定为
   * 海外来源、留在国际站。
   *
   * ## ⚠️ 为什么是「用户显式开启」而不是默认行为
   *
   * 附 `X-Forwarded-For` 本质是**声明一个并非本机的来源 IP**。Akamai 这条规则
   * 是上游的区域路由策略（账单、内容合规都基于它），默认伪造来源**不该是产品的
   * 默认行为**。故：缺键 / 空串 = **不附任何头**，行为与修复前逐字节一致。
   *
   * ⚠️ 它还可能**随时失效**：很多 CDN 已默认不信任客户端提供的 `X-Forwarded-For`。
   * 上游一旦改策略，本设置会**静默无效** —— 所以「设置后仍然 307」必须如实报错，
   * 不能假装成功（`minimax.ts` 的 `describeMinimaxGeoRoute` 守这一条）。
   *
   * ⚠️ 取值校验在 {@link sanitizeMinimaxXff}：**只接受 IP 字面量**（IPv4/IPv6），
   * 不接受主机名、不接受任意头注入字符（`,` / 换行 / 冒号在 IPv6 之外一律拒绝）。
   *
   * ⚠️ **只对 `minimaxintl` 生效**，中国站不受影响（它不需要绕过）。
   */
  minimaxXff?: string
  /**
   * **供应商关闭意图**：provider id → `true`（Gitee issue IKP8OF）。
   *
   * ## 它解决什么
   *
   * 「关闭供应商」（`provider.setEnabled(false)`）原先**只**把**当时目录里的 id**
   * 写进模型黑名单，而 `provider.status` 的 `closed` 判据是
   * `total > 0 && disabled === total`（`total` 取自**当前**全量目录）。
   * 于是目录**在关闭之后继续变长**（cline 三源异步 + models.dev 可恢复、
   * 其余家后台刷新器补进上游新模型）⇒ `disabled < total` ⇒ `closed` 从
   * `true` 翻回 `false` ⇒ 供应商**静默回到「已打开」**，且新模型**仍可选**。
   * 实测（真实 `ClineAdapter` + 真实 `AccountPool` 走完整 RPC 链路；
   * 关闭那一刻 models.dev 未就绪 ⇒ 目录 3 条，恢复后补齐到 7 条）：
   * `{total:3,disabled:3,closed:true}` → `{total:7,disabled:3,closed:false}`。
   *
   * ## ⚠️⚠️ 为什么是「意图」而不是「状态」——**不要把它当 `closed` 的权威**
   *
   * 本表记的是「用户**要求**它关着」，**不是**「它现在真的全关」。二者必须靠
   * **双腿取或**才等价（见 `AccountPool.closedProviders` 与 `provider.status`）：
   *
   * - 若**只**读本表（issue 原文的第一个建议）⇒ 用户在模型列表里**逐条打开**
   *   该供应商的模型后，本表仍是 `true` ⇒ 界面显示「已关闭」而模型**全部可选**
   *   —— 正是 IKJW33 修过的「显示已关闭而模型仍可选」矛盾态；
   * - 若**只**读派生判据（修复前的形态）⇒ 目录一长就翻回「已打开」（本 issue）。
   *
   * ⇒ 判据 = `本表有该 provider` **或** `目录非空且全部已关闭`。
   * 前者管「目录增长」，后者管「逐条关光也算关闭」（既有语义，有既有用例锁定）。
   *
   * ## ⚠️ 为什么它能**同时**修好「新模型仍可选」（这才是真正的危害）
   *
   * 本表在 `AccountPool.disabledModelsFor()` 里被读 —— 那是**全部 22 家适配器**
   * 过滤黑名单的**唯一收口点**（`model-catalog.ts` 的共享骨架、
   * `autoclaw` / `modelscope` / `officeace` / `opencode` 四个手写实现、
   * 聚合与 auto 的路由都读它）。故这里**一处实现**就让新增模型在选择器里消失，
   * 无需在目录落地时异步补写黑名单（那种写法要在 22 家各接一次钩子，
   * 且读路径写盘、失败还要重试）。
   *
   * ⚠️ 但 `listAllModels()`（设置页开关清单）与 `provider.status` 的 `total`
   * **不套** `disabledModelsFor`（契约要求它们是不套黑名单的全量目录）——
   * 这正是我们想要的：用户仍能在设置页看到并**逐条打开**这些模型。
   *
   * ## ⚠️ 丢失后果**可逆**，故可以住 `state.json`
   *
   * 老版本代码整体重写 `state.json` 时会丢掉本键 ⇒ 后果是回到修复前的行为
   *（目录增长后自动「已打开」），用户再关一次即可 —— 无任何不可逆后果。
   * 对照 `loomyPermanentLocked`（丢了会真烧永久积分）才需要独立文档。
   *
   * 缺键语义 = **没有任何供应商被关闭**，与升级前行为一致。
   */
  providerClosed?: ProviderClosedMap
}

/**
 * 「供应商关闭意图」表：provider id → `true`。
 *
 * ⚠️ 只记 `true`（缺键 = 未关闭），与 {@link ModelDisableMap} 同口径 ——
 * 不留 `false` 噪音，文档不随开关操作膨胀。
 */
export type ProviderClosedMap = Record<string, boolean>

/** 持久化后端的能力标识，供调用方决定要不要告警。 */
export type JetHubStoreKind = 'settings' | 'file' | 'memory'

/** Jet Hub 状态存取接口（同步读、异步写）。 */
export interface JetHubStore {
  readonly kind: JetHubStoreKind
  /** 同步载入；文档不存在时返回 `undefined`（等价于"空"）。 */
  load(): JetHubState | undefined
  /** 整体写入（账号与黑名单必须同时携带，见 AccountPool 的说明）。 */
  save(state: JetHubState): Promise<void>
}

/** settings scope 的最小接口（只用到 get/replace）。 */
interface SettingsScopeLike {
  get(): unknown
  replace(section: object): Promise<void>
}

/**
 * 持久化文档的 schema（两种后端共用）。
 *
 * ⚠️ 必须是 schemastery（`plainSchema` 会调它的 `toJSON()`）。
 *
 * ⚠️ **导出仅供测试**：老契约后端（SettingsStore，**≤0.1.6 的
 * `settings.register` 契约**）的 `scope.get()` 按「schema defaults →
 * registrant 的 base → 用户文档」三层解析，也就是**会过一遍本 schema**；
 * 而单测里那些 `scope.get()` 替身默认不过。`tests/unit/jet-hub-store.spec.ts`
 * 的「老契约后端」组用本导出复刻真实行为 —— 否则「schema 的 `.default()` 把
 * 迁移短路」这类缺陷会整组躲过去（2026-10-24 复核 C1 实测如此）。
 *
 * ⚠️ 上面的版本限定是必要的：0.1.7 起 `settings` 换成 `SettingsForms`（没有
 * `register`），本插件在那里走 FileStore，**不经过**本 schema。
 *
 * 生产代码不要直接用它做校验，走 sanitize 函数。
 */
export const jetHubSchema = Schema.object({
  accounts: Schema.array(Schema.any()).default([]),
  disabledModels: Schema.dict(Schema.any()).default({}),
  loomyPermanentLocked: Schema.boolean().default(false),
  gatewayEnabled: Schema.boolean().default(true),
  // 「允许局域网访问」：默认关闭（暴露面变大必须是显式选择）。
  gatewayAllowLan: Schema.boolean().default(false),
  nativeWebSearchEnabled: Schema.boolean().default(true),
  // 「ZCode 会话负载均衡」：默认开启（2026-10-30 用户要求）。关闭 = ZCode
  // 回到「手动顺序首个可用账号」的既有语义。判据在 sanitizeSessionBalanceEnabled。
  sessionBalanceEnabled: Schema.boolean().default(true),
  // 缺键 = 「仅侧栏」（升级前的默认就是显示那一行；改掉是显式动作）。
  // ⚠️ 用 `Schema.string()` 而不是 `Schema.union([...])`：schema 只负责类型，
  // 取值合法性由 `sanitizePanelEntry` 在**读写两侧**统一判（老契约后端不经过
  // schema，只靠那个函数；两处用同一份判据才不会漂移）。与下面 `minimaxXff` 同款。
  //
  // ⚠️⚠️ **绝不能加 `.default()`**（真实缺陷，2026-10-24 复核实测）：
  //    schemastery 的 `.default()` 会在 `scope.get()` 返回的文档里**填入**默认值，
  //    于是 `sanitizePanelEntry(value.panelEntry, …)` 第一层（新键合法即返回）
  //    直接命中，第二层的**老布尔迁移永远不执行** ⇒ 老用户明确关掉的侧栏入口
  //    在升级后静默变回「仅侧栏」，且此后每次 save() 都把 `'sidebar'` 写进文档，
  //    原设置**永久丢失**。
  //    实测（schemastery 3.18.4）：`{ sidebarEntryEnabled: false }` 经 `.default()`
  //    后 `panelEntry === 'sidebar'`（错误），去掉后经 sanitize 得 `'settings'`（正确）。
  //    缺键时由 `sanitizePanelEntry` 自己兜底成 `DEFAULT_PANEL_ENTRY`，不需要这里再给。
  panelEntry: Schema.string(),
  providerOrder: Schema.array(Schema.string()).default([]),
  // ⚠️ 用 `Schema.string()` 而不是自定义 IP 校验：schema 只负责类型，
  // 取值合法性由 `sanitizeMinimaxXff` 在**读写两侧**统一判（老契约后端不经过
  // schema，只靠那个函数；两处用同一份判据才不会漂移）。
  // 缺键 = 不附 XFF（行为与修复前逐字节一致）。
  minimaxXff: Schema.string().default(''),
  // ⚠️ 同 `disabledModels`：用 `Schema.dict(Schema.any())`，取值合法性由
  // `sanitizeProviderClosed` 在**读写两侧**统一判（老契约后端不经过 schema）。
  // 缺键 = 没有任何供应商被关闭（与升级前行为一致）。
  providerClosed: Schema.dict(Schema.any()).default({}),
})

/**
 * 归一化「本机 OpenAI 网关」开关。
 *
 * 判据与 `sanitizePermanentLocks` 相反：**只有显式 `false` 才算停用**，
 * 其余（缺键 / `true` / 字符串 / 对象 / 数组）一律按启用处理。
 *
 * ⚠️ 方向不能反。文档缺失、被手工编辑成脏值、或老版本代码整体重写时丢了本键，
 * 都必须**回到默认启用** —— 那正是升级前的行为；反过来（只认 `true`）会让
 * 任何一次读取失败都变成「网关被静默关闭」，而用户根本不知道自己关过它。
 */
export function sanitizeGatewayEnabled(raw: unknown): boolean {
  return raw !== false
}

/**
 * 归一化「允许局域网访问」开关。
 *
 * ⚠️ 方向与 {@link sanitizeGatewayEnabled} **刻意相反**：只有显式 `true` 才算
 * 打开，其余（缺键 / `false` / 字符串 / 对象 / 数组）一律按**关闭**处理。
 * 理由：它把网关暴露给整个网络，丢失/脏值必须回到「只绑回环」的安全默认——
 * 反过来（缺键即开启）会让任何一次读取失败都变成**未授权暴露**，而用户对此
 * 毫无知觉。
 */
export function sanitizeGatewayAllowLan(raw: unknown): boolean {
  return raw === true
}

/**
 * 归一化「渠道原生搜索」总开关。
 *
 * 判据与 {@link sanitizeGatewayEnabled} **逐字同构**，理由也同向：
 * **只有显式 `false` 才算关闭**，其余（缺键 / `true` / 字符串 / 对象 / 数组）
 * 一律按启用处理。
 *
 * ⚠️ 方向不能反。文档缺失、被手工编辑成脏值、或老版本代码整体重写时丢了本键，
 * 都必须**回到默认启用** —— 反过来（只认 `true`）会让任何一次读取失败都变成
 * 「原生搜索被静默关闭」，用户根本不知道自己关过它，只会看到搜索突然开始
 * 要 API Key。
 */
export function sanitizeNativeWebSearchEnabled(raw: unknown): boolean {
  return raw !== false
}

/**
 * 归一化「ZCode 会话负载均衡」开关（{@link JetHubState.sessionBalanceEnabled}）。
 *
 * 缺键语义为**启用**（2026-10-30 用户要求的默认方向）：老文档没有本键、或被
 * 老版本代码整体重写时丢键，都回到「会话亲和 + 随机分摊」开启态 —— 与
 * {@link sanitizeNativeWebSearchEnabled} 的判据同构（`raw !== false`）。
 *
 * ⚠️ 字符串 `'false'` **不算** `false`（与 panelEntry 那条同款）：那是脏数据，
 * 不是用户意图。
 */
export function sanitizeSessionBalanceEnabled(raw: unknown): boolean {
  return raw !== false
}

/**
 * 归一化「面板入口」（{@link JetHubState.panelEntry}）。
 *
 * 判据两层，顺序不能反：
 * 1. `raw` 命中 {@link PANEL_ENTRY_VALUES} 就原样返回（新文档 / 合法值优先）；
 * 2. 否则看老布尔 `legacySidebarEnabled` —— **只有显式 `false`** 才算
 *    `'settings'`，其余（`undefined` / `true` / 字符串 / 对象 / 数组）一律
 *    回 {@link DEFAULT_PANEL_ENTRY}。
 *
 * ⚠️ 方向不能反。文档缺失、被手工编辑成脏值、或老版本代码整体重写时丢了本键，
 * 都必须**回到默认「仅侧栏」** —— 反过来会让任何一次读取失败都变成「侧栏入口
 * 被静默藏起来」，而用户从来没改过它。
 *
 * ⚠️ 字符串 `'false'` **不算** `false`：它是脏数据，不是用户意图。这一条与
 * {@link sanitizeNativeWebSearchEnabled} 的判据同构（那边也是 `raw !== false`）。
 */
export function sanitizePanelEntry(raw: unknown, legacySidebarEnabled?: unknown): PanelEntry {
  if (typeof raw === 'string' && (PANEL_ENTRY_VALUES as readonly string[]).includes(raw)) {
    return raw as PanelEntry
  }
  return legacySidebarEnabled === false ? 'settings' : DEFAULT_PANEL_ENTRY
}

/**
 * 归一化供应商自定义显示顺序（{@link JetHubState.providerOrder}）。
 *
 * 只保留非空字符串 id 并**去重**（保留首次出现位置）；非数组一律视为
 * 「无自定义顺序」（空数组）。⚠️ 这里**不做** provider 合法性校验：
 * 合法集合随插件版本变化，在此过滤会让「新版本加入 provider → 被旧版本
 * 代码重写文档」场景下的顺序无法保留 —— 展示层对数组中不认识 / 缺失的
 * id 自带稳定兜底，脏条目天然无害。
 */
/**
 * 归一化 MiniMax 国际站绕过分流用的 `X-Forwarded-For` 值。
 *
 * ## ⚠️ 为什么必须校验，而不是「用户填什么就发什么」
 *
 * 这个值会被**原样拼进 HTTP 请求头**。不校验的话，用户（或一份被篡改的
 * `state.json`）填入 `1.2.3.4\r\nX-Evil: 1` 就能向**上游**注入任意请求头
 * —— 那是典型的头注入（CRLF injection）。故判据必须**白名单字符集**，
 * 而不是「挡掉已知坏字符」。
 *
 * ## 取值口径
 *
 * - **只接受 IP 字面量**：IPv4（`a.b.c.d`，四段 0-255）与 IPv6
 *  （含 `::` 压缩、`%zone` 允许但**原样保留**——本机链路本地地址确实带它）；
 * - 主机名、`1.2.3.4, 5.6.7.8`（XFF 链）、前后空白以外的任何字符 ⇒ `undefined`；
 * - **空串 / 仅空白 ⇒ `undefined`**（语义 = 不附头，与缺键一致）；
 * - 超长（>128）⇒ `undefined`（最长合法 IPv6 也只有 45 字符）。
 *
 * ⚠️ 归一化只做 `trim()`，**不改大小写、不改缩写**：这个值是用户从自己的
 * 代理/VPN 那里抄来的，改写它只会让「为什么我填对了却不生效」更难查。
 *
 * ⚠️ 返回 `undefined` 表示「不附头」。**绝不能**把它变成空串头
 * （`X-Forwarded-For: `）—— 空值在 Akamai 侧会被当成非法并回退真实 IP，
 * 行为与不附头相同，但会污染上游日志。
 */
export function sanitizeMinimaxXff(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // ⚠️⚠️ **必须在 `trim()` 之前查 CR/LF**（本函数初版就栽在这里）：
  //    `'1.2.3.4\r'` 被 `trim()` 去掉 `\r` 后变成合法 IPv4 并**通过**校验 ——
  //    于是「以换行结尾的值」在 store 层被洗干净、看不出问题，而一旦有别的
  //    写入路径没走本函数，那个 `\r` 就会被拼进请求头（头注入）。
  //    ⇒ 判据必须是「**原始串里不含控制字符**」，而不是「trim 后形状合法」。
  if (/[\r\n]/.test(raw)) return undefined
  const value = raw.trim()
  if (value.length === 0 || value.length > 128) return undefined
  // 白名单字符集：十六进制数字、点、冒号、百分号（IPv6 zone）、连字符。
  // ⚠️ zone 名（`fe80::1%eth0`）是**字母**组成的，故还要放行 a-z/A-Z；
  //    但仅当存在 `%` 时才允许字母（纯字母串如 `localhost` 必须被拒）。
  const hasZone = value.includes('%')
  const allowed = hasZone ? /^[0-9A-Za-z.:%-]+$/ : /^[0-9A-Fa-f.:]+$/
  if (!allowed.test(value)) return undefined
  // IPv4：四段十进制，每段 0-255。
  const isIpv4 = (() => {
    const parts = value.split('.')
    if (parts.length !== 4) return false
    return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  })()
  if (isIpv4) return value
  /**
   * IPv6：要求**段数合法**（≤ 8 段，且 `::` 压缩最多一次）。
   *
   * ⚠️ **初版只做形状校验、不数段数**（2026-10-17 审计指出的真实缺口）：
   * `1:2:3:4:5:6:7:8:9:10`（10 段）当时被**放行**，而 IPv6 最多 8 段。
   * 后果不是安全漏洞（它只是个非法字符串），但「只接受 IP 字面量」这条
   * 契约就名不副实 —— 用户填错也得不到纠正，请求带上一个必然无效的头。
   *
   * ⚠️ 判据按「**冒号切分后的组数**」，并显式处理 `::` 压缩：
   * - 无 `::` ⇒ 必须**恰好 8 组**；
   * - 有 `::` ⇒ 两侧合计**少于 8 组**（`::` 至少要顶替 1 组）。
   * 组内允许 1~4 位十六进制。
   *
   * ⚠️ 仍**刻意不支持** IPv4-mapped（`::ffff:1.2.3.4`）：本设置用不到，
   * 少一个分支就少一处判定误差（这一点写进契约，见下）。
   */
  if (value.includes(':')) {
    if (/:::/.test(value)) return undefined
    if (value.startsWith(':') && !value.startsWith('::')) return undefined
    if (value.endsWith(':') && !value.endsWith('::')) return undefined
    // zone id 不参与段数计算（`fe80::1%eth0` 的 `%eth0` 是链路作用域，不是一组）。
    const addressPart = value.split('%')[0] ?? ''
    if (addressPart.length === 0) return undefined
    const hasCompression = addressPart.includes('::')
    if (hasCompression && addressPart.split('::').length > 2) return undefined
    const groups = addressPart.split(':').filter((g) => g.length > 0)
    // 组内必须是 1~4 位十六进制。
    if (!groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return undefined
    if (hasCompression) {
      // `::` 至少顶替一组 ⇒ 显式组数必须 < 8。
      if (groups.length >= 8) return undefined
    } else if (groups.length !== 8) {
      return undefined
    }
    return value
  }
  return undefined
}

export function sanitizeProviderOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * 归一化「锁定永久积分」开关表。
 *
 * 与 `sanitizeDisabledModels` 同款口径：**只保留显式 `true`**，其余值（`false` /
 * 字符串 / 对象）一律丢弃 —— 于是「缺键」与「值为 false」在语义上完全一致
 * （未锁定），文档也不会随开关操作累积噪音。
 * ⚠️ 单测专门覆盖「`{ loomy: 'yes' }` 不得判成已锁定」这一类脏数据。
 */
export function sanitizePermanentLocks(raw: unknown): PermanentLockMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: PermanentLockMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === true && provider.length > 0) result[provider] = true
  }
  return result
}

/**
 * 把**老的单字段**并进锁定表 —— 仅用于「独立文档尚不存在」的那一次迁移。
 *
 * 背景：锁定开关早于 `permanent-locks.json` 存在，住在 state.json 的
 * `loomyPermanentLocked` 里，老用户磁盘上只有它。不并进来的话，升级后 Loomy 的
 * 锁定会**静默消失**（用户看到的是「永久积分被烧掉了」且毫无提示）——
 * 那是最坏的一类回归。
 *
 * ⚠️ 调用方**只能在新文档不存在时**用它（`PermanentLockStore.load()` 的
 * `exists: false`）。新文档一旦存在就以它为准：否则用户在 desktop 里解锁 Loomy
 * 之后（表里没有 `loomy` 键 = 未锁定），只要镜像字段因为任何原因还留着
 * `true`，锁定就会被重新打开 —— 那种"解不掉"的开关比丢状态更难排查。
 */
export function mergeLegacyLoomyLock(
  locks: PermanentLockMap,
  legacyLoomyLocked: unknown,
): PermanentLockMap {
  if (locks.loomy === undefined && legacyLoomyLocked === true) return { ...locks, loomy: true }
  return locks
}

/**
 * 把读到的原始值归一化为 {@link ModelDisableMap}。
 *
 * 文档可能被手工编辑过、或残留老版本格式（如数组），因此逐层校验：任何一层
 * 不是对象就丢弃那一层，只保留「provider → 模型 → true」。**只把显式 `true`
 * 视为关闭**，其余值一律忽略，避免与 `disabledModelsFor` 的判定产生分歧。
 */
export function sanitizeDisabledModels(raw: unknown): ModelDisableMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: ModelDisableMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const perProvider: Record<string, boolean> = {}
    for (const [modelId, flag] of Object.entries(value as Record<string, unknown>)) {
      if (flag === true) perProvider[modelId] = true
    }
    // 空表不保留：不让文档里留下 `{ provider: {} }` 这类无意义噪音。
    if (Object.keys(perProvider).length > 0) result[provider] = perProvider
  }
  return result
}

/**
 * 把读到的原始值归一化为 {@link ProviderClosedMap}（Gitee issue IKP8OF）。
 *
 * 判据照 {@link sanitizeDisabledModels} 的形态：**只把显式 `true` 视为关闭意图**，
 * 其余（`false` / `1` / `'true'` / `null` / 对象 / 数组）一律忽略。
 *
 * ⚠️ 宽松接受 truthy 是**危险方向**：`'false'` 是非空字符串（truthy），
 * 被当成关闭意图会让该供应商的**全部模型**静默从选择器消失，用户只看到
 * 「模型全没了」而无从归因。故必须严格 `=== true`。
 */
export function sanitizeProviderClosed(raw: unknown): ProviderClosedMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: ProviderClosedMap = {}
  for (const [provider, flag] of Object.entries(raw as Record<string, unknown>)) {
    if (flag === true) result[provider] = true
  }
  return result
}

/**
 * 归一化聚合 provider 的「拒绝轮换」表（见 {@link AggregateRejectionMap}）。
 *
 * 判据（照 {@link sanitizeDisabledModels} 的形态）：
 *
 * - 只有**显式 `true`** 算拒绝（`false` / `1` / `'true'` / `null` 都不算）——
 *   宽松接受 truthy 会让 `'false'`（非空字符串）被当成拒绝，用户莫名其妙丢一个渠道；
 * - **空层不保留**：不留 `{ m: {} }` / `{ m: { buddy: {} } }` 这类无意义噪音；
 * - 任何畸形输入（含**数组** —— `typeof [] === 'object'`，只判 object 会让它通过）
 *   退化为空表。
 *
 * ⚠️ 用 `Object.entries` 遍历**自有**键 ⇒ 原型链键（`constructor` 等）天然不会被
 * 误当条目（与 `canonical-models.ts` 的 M9 是同一类风险；那里需要显式 `Object.hasOwn`，
 * 这里由 `entries` 天然保证 —— 故**不要**改成 `for (const k in raw)`）。
 */
export function sanitizeAggregateRejections(raw: unknown): AggregateRejectionMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: AggregateRejectionMap = {}
  for (const [canonicalId, byProvider] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof byProvider !== 'object' || byProvider === null || Array.isArray(byProvider)) continue
    const perProvider: Record<string, Record<string, boolean>> = {}
    for (const [provider, byRealId] of Object.entries(byProvider as Record<string, unknown>)) {
      if (typeof byRealId !== 'object' || byRealId === null || Array.isArray(byRealId)) continue
      const perRealId: Record<string, boolean> = {}
      for (const [realId, flag] of Object.entries(byRealId as Record<string, unknown>)) {
        if (flag === true) perRealId[realId] = true
      }
      // 空层不保留（与上面同因）。
      if (Object.keys(perRealId).length > 0) perProvider[provider] = perRealId
    }
    if (Object.keys(perProvider).length > 0) result[canonicalId] = perProvider
  }
  return result
}

/**
 * 归一化聚合「显式允许」白名单。
 *
 * 判据与 {@link sanitizeAggregateRejections} **逐格同构**（只认显式 `true`、空层不保留、
 * 畸形退化空表、`Object.entries` 遍历自有键）—— 两张表口径一致才能让上层用同一套读法。
 *
 * ⚠️ 判据**不能宽松接受 truthy**：表里一旦被 `1` / `'true'` 污染，下次读取就有人按 truthy
 * 判成「允许」= 静默放行一个我们没有余额信息的渠道。
 */
export function sanitizeAggregateAllowed(raw: unknown): AggregateAllowedMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: AggregateAllowedMap = {}
  for (const [canonicalId, byProvider] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof byProvider !== 'object' || byProvider === null || Array.isArray(byProvider)) continue
    const perProvider: Record<string, Record<string, boolean>> = {}
    for (const [provider, byRealId] of Object.entries(byProvider as Record<string, unknown>)) {
      if (typeof byRealId !== 'object' || byRealId === null || Array.isArray(byRealId)) continue
      const perRealId: Record<string, boolean> = {}
      for (const [realId, flag] of Object.entries(byRealId as Record<string, unknown>)) {
        if (flag === true) perRealId[realId] = true
      }
      if (Object.keys(perRealId).length > 0) perProvider[provider] = perRealId
    }
    if (Object.keys(perProvider).length > 0) result[canonicalId] = perProvider
  }
  return result
}

/**
 * 归一化聚合**手工顺序**表。
 *
 * 判据（三条都必须，缺一条就是静默失效）：
 *
 * - 元素必须是**字符串且含 NUL 分隔符** —— 否则它在适配器里解析不出 `(provider, realId)`，
 *   会被静默忽略 ⇒「顺序表看着有内容、实际全不生效」；
 * - **去重**（保留首次出现）—— 重复元素会让比较器**非确定**（同一候选有两个位次）；
 * - 空数组 **丢键**（= 未自定义，与 `providerOrder` 同语义）。
 */
export function sanitizeAggregateOrder(raw: unknown): AggregateOrderMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: AggregateOrderMap = {}
  for (const [canonicalId, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    const seen = new Set<string>()
    const kept: string[] = []
    for (const entry of entries) {
      if (typeof entry !== 'string' || !entry.includes('\u0000')) continue
      if (seen.has(entry)) continue
      seen.add(entry)
      kept.push(entry)
    }
    if (kept.length > 0) result[canonicalId] = kept
  }
  return result
}

/**
 * 归一化排序模式：**只有字面量 `'manual'`** 认作手工序，其余（含缺键 / 畸形 / 大小写不同）
 * 一律回落到 `'expiry'` = 升级前行为。
 */
export function sanitizeAggregateOrderMode(raw: unknown): AggregateOrderMode {
  return raw === 'manual' ? 'manual' : 'expiry'
}

/**
 * 从拒绝表里移除「该渠道在该虚拟模型下」的**整层**。
 *
 * ⚠️⚠️ 这是 **D4 降级语义**的恢复路径，**只留这一份实现**：`AccountPool.setAggregateRejected`
 * 的 `false` 分支调它（`setAggregateAllowed` **不调** —— 两表各有各的域，见
 * {@link AggregateAllowedMap} 的说明）。
 *
 * ## 为什么是「整渠道层」而不是「只删这一个 realId」
 *
 * D4 规定：`(虚拟模型, 渠道)` 下有 `true` 记录、但那些 `realId` **都不在**当前候选中
 *（id 漂移）⇒ **降级为渠道级拒绝**。而漂移的**旧键会一直留在表里** ⇒ 用户按降级告警的
 * 指引来面板「重新打开」**当前**候选时，若只删**当前**键，**旧键仍在** ⇒ 降级判据依然成立：
 *
 * - 面板用「该 realId 在不在表里」判断显示 ⇒ 显示「参与轮换」；
 * - 宿主实际**仍拒绝** ⇒ **显示与行为分叉**，告警指引的那条恢复路径**走不通**。
 *
 * 用户「重新打开」的意图是「让这个渠道在这个模型下重新参与」，而 D4 本就是**渠道级**语义
 * ⇒ 唯一自洽的结果就是**整渠道恢复**。
 *
 * ⚠️ 调用方**不得**在清层后再把 `perProvider[provider] = perRealId` 挂回去
 *（初版正是如此：删除被自己覆盖，降级不解除；独立审计用真实池实测证伪）。
 */
export function clearRejectionLayer(
  rejections: AggregateRejectionMap,
  canonicalId: string,
  provider: string,
): AggregateRejectionMap {
  const next: AggregateRejectionMap = { ...rejections }
  const perProvider = { ...(next[canonicalId] ?? {}) }
  delete perProvider[provider]
  if (Object.keys(perProvider).length === 0) delete next[canonicalId]
  else next[canonicalId] = perProvider
  return next
}

/**
 * 白名单侧写入（不可变；空层不保留）。
 *
 * 唯一调用方是 `AccountPool.setAggregateAllowed(..., true)`。
 */
export function withAllowed(
  allowed: AggregateAllowedMap,
  canonicalId: string,
  provider: string,
  realId: string,
): AggregateAllowedMap {
  const next: AggregateAllowedMap = { ...allowed }
  const perProvider = { ...(next[canonicalId] ?? {}) }
  perProvider[provider] = { ...(perProvider[provider] ?? {}), [realId]: true }
  next[canonicalId] = perProvider
  return next
}

/**
 * 白名单侧**单键**删除（不可变；空层逐级清理）。
 *
 * ⚠️ 唯一调用方是 `AccountPool.setAggregateAllowed(..., false)` —— **只删同键**：
 * 同渠道其它被手工打开的候选必须保留（用户逐条打开的是**候选**，不是渠道）。
 */
export function withoutAllowed(
  allowed: AggregateAllowedMap,
  canonicalId: string,
  provider: string,
  realId: string,
): AggregateAllowedMap {
  const perProvider = { ...(allowed[canonicalId] ?? {}) }
  const perRealId = { ...(perProvider[provider] ?? {}) }
  delete perRealId[realId]
  if (Object.keys(perRealId).length === 0) delete perProvider[provider]
  else perProvider[provider] = perRealId
  const next: AggregateAllowedMap = { ...allowed }
  if (Object.keys(perProvider).length === 0) delete next[canonicalId]
  else next[canonicalId] = perProvider
  return next
}

/**
 * 归一化账号条目数组。
 *
 * 判据刻意保守：只保留同时具备 `id` / `provider` / `credentialRef` 三个非空
 * 字符串的条目 —— 缺任何一个都无法解析凭据，留着只会在选号时反复失败。
 * 其余字段按原样透传（`enabled` / `modelRateLimits` 等由下游各自判空）。
 *
 * ## ⚠️⚠️ 必须按 `id` 去重（真实缺陷，对抗审计实测证伪）
 *
 * `id` 是账号的**唯一键**：`updateAccount` / `removeAccount` / `reorderAccounts`
 * 全都 `findIndex(a => a.id === id)`，只命中**第一条**。池里出现两条同 id 时，
 * 第二条**永远改不动、删不掉**（幽灵账号）。
 *
 * 原先只有 `mergeAccounts` 内部去重，而 `replaceAll`（备份导入的**默认模式**）
 * 不去重 ⇒ 一份手工编辑过的备份即可把两条同 id 写进池里。后果实测**远不止**
 * 幽灵账号：沉底函数按 id 匹配会写出 `undefined` 空洞，使该 provider 的
 * `getAvailableAccount` / `listAccounts` 全部抛错（整条推理链崩），且空洞经
 * `JSON.stringify` 变 `null`、重启后被本函数丢弃 ⇒ **账号永久丢失**。
 *
 * ⚠️⚠️ **去重有「两层」，缺一不可**（第二层是独立审计实测证伪后补的）：
 *
 * 1. **本函数（归一化层）**：清洗**入口**数据 —— 后端载入、`replaceAll`、
 *    `mergeAccounts` 都经它。
 * 2. **`AccountPool.writeAccounts`（唯一写入收口点）**：`addAccount` 等路径
 *    **不经过本函数**（它直接 `writeAccounts([...readAccounts(), entry])`），
 *    而 `addAccount` 有 20+ 个调用点（各 `*-auth.ts` 登录落库、`account.create`、
 *    `opencode-rpc`、`ensureDefaultAnonymousSlot`）⇒ 只靠本层，「池里两条同 id」
 *    **仍可达**。
 *
 * ⚠️ 本层**不能**声称「写盘时自愈」：`updateAccount` / `setAccountsEnabled` /
 * `clearModelRateLimits` / `updateModelRateLimit` / `setOpencodeProxy` 等
 * 8 条写路径都**不调本函数**。真正让「历史遗留重复条目」自愈的是**载入路径**
 * （两种后端的 `load()` 都经本函数），以及 `writeAccounts` 的收口去重。
 *
 * 保留**首次出现**的条目（与「先到先得」的直觉一致；重复条目的字段差异
 * 不合并 —— 无法判断哪份更新，合并反而会造出谁都没写过的混合体）。
 */
export function sanitizeAccounts(raw: unknown): ProviderAccountEntry[] {
  if (!Array.isArray(raw)) return []
  const accounts: ProviderAccountEntry[] = []
  // 已见过的 id：重复条目直接丢弃（见上方注释）。
  const seenIds = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const candidate = entry as Partial<ProviderAccountEntry>
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) continue
    if (typeof candidate.provider !== 'string' || candidate.provider.length === 0) continue
    if (typeof candidate.credentialRef !== 'string' || candidate.credentialRef.length === 0) continue
    if (seenIds.has(candidate.id)) continue
    seenIds.add(candidate.id)
    /**
     * ⚠️ **限流标记必须先过滤再落定，且必须放在 `...candidate` 之后**
     * （真实缺陷，对抗审计实测证伪）。
     *
     * 备份文件是用户可编辑的输入，而 `modelRateLimits` 原先**原样透传**。
     * 非数字脏值（`'not-a-number'` / `null` / 负数）会让 UI 与宿主**判据分叉**：
     *   - UI（`jet-hub.js`）：`v > Date.now()` ⇒ 对 `'not-a-number'` 为 `false`
     *     ⇒ **不显示**「限额中」；
     *   - 宿主（`getAvailableAccount`）：`now >= resetAt` 亦为 `false`
     *     ⇒ 判为**受限**、选号时**排除**该账号。
     * ⇒ 用户看到「这个号完全正常」，而宿主永远不用它 —— 正是本项目反复出现的
     * 「显示与行为分叉」缺陷形态。
     *
     * 判据与 `updateModelRateLimit` 的写入守卫一致（只接受有限正数毫秒时间戳）。
     *
     * ⚠️ **展开顺序是这条修复的关键**：`{ ...candidate, modelRateLimits: <过滤后> }`
     * —— 若写成 `{ ...candidate, ...sanitizeModelRateLimits(...) }` 且**放在
     * `...candidate` 之前**，`candidate` 里的原始（脏的）`modelRateLimits` 会把
     * 过滤结果**整个覆盖回去**，修复静默失效（本文件第一版正是如此，被新写的
     * 用例当场抓红）。故这里显式写键名并置于展开之后。
     */
    const limits = sanitizeModelRateLimits(candidate.modelRateLimits)
    accounts.push({
      ...candidate,
      enabled: candidate.enabled !== false,
      refreshable: candidate.refreshable !== false,
      nickname: typeof candidate.nickname === 'string' ? candidate.nickname : candidate.id,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
      // 无有效项时写 `undefined`：`JSON.stringify` 会整个丢弃该键，
      // 故落盘/传输形态与「从未有过标记」完全一致（不留 `{}` 噪音）。
      modelRateLimits: limits,
      // ⚠️ 四个代理字段统一过闸（2026-10-25 审计 B2-1，见 `PROXY_FIELDS` 的注释）。
      // 与 `modelRateLimits` 同款：**显式写键名并置于展开之后**，否则
      // `candidate` 里的脏值会把清理结果整个覆盖回去（本文件第一版正是如此）。
      ...sanitizeProxyFields(candidate),
    } as ProviderAccountEntry)
  }
  return accounts
}

/**
 * 四个出口代理字段 —— 备份/状态文件里**唯一**需要「取值校验而非形状校验」的一类。
 *
 * ## ⚠️⚠️ 为什么必须在 `sanitizeAccounts` 这一处挡（2026-10-25 审计 B2-1）
 *
 * `sanitizeAccounts` 是「外部数据 → 池」的**唯一闸门**（`state.json` 读取与
 * `backup.import` 都过它），而它原先用 `{ ...candidate }` **原样透传**代理字段 ——
 * 只限「是不是字符串」、不限「是不是合法代理」。后果链（真跑端点实测）：
 *
 * ```
 * backup.import（载荷 qoderProxy = "ftp://host:21"）→ ok:true、账号落池
 *   → 此后该账号每次取 fetcher 都抛「代理地址无效 — 不支持的协议 ftp」
 *   → 该账号【永久不可用】
 * ```
 *
 * ⚠️ 而客户端**有**导入按钮（`jet-hub.js` 的 `backup.import`）⇒ 这条路径
 * **UI 可达**。池自己的注释也早把备份文件当不可信输入（`qoderProxyFor` 明写
 * 「池里可能存在 `"qoderProxy": 12345`」），却只防了非字符串。
 *
 * ## 为什么修在这里，而不是各 provider 的读取侧
 *
 * 四个 provider 的解析器**同形**地在读取侧 `throw`
 * （`opencode.ts` / `gemini-proxy.ts` / `minimax-proxy.ts` / `qoder-proxy.ts`）。
 * 改读取侧要四处同改、且很容易只改一家而让三家分叉；修在这个唯一闸门上，
 * 四个字段同时受益，**四个 provider 的读取侧永远遇不到脏值**。
 *
 * ## 处置：清掉该字段（降级直连），不是丢弃整条账号
 *
 * 丢账号会让用户「导入后少了几个号」且不知道为什么；清字段只让该账号回到
 * 「直连」，面板上「当前：直连」一眼可见、可重填。**删一个字段比删一条账号可逆得多。**
 *
 * ## ⚠️ 判据为什么只查 scheme（而不是搬 `normalizeProxy` 进来）
 *
 * `normalizeProxy` 住在 `opencode.ts`（provider 实现层），而本文件是**底层**
 * store —— 反向依赖会成环。故这里只做**最小形状闸**：scheme 必须是三家
 * 支持的之一（`http` / `https` / `socks5`）。它足以挡住「导出/导入往返里混进
 * 的 `ftp://` / 少 scheme / 垃圾串」这类会**让账号永久不可用**的值，
 * 而更细的校验（端口范围、authority 形态）留给真正建连接时的 `normalizeProxy`
 * —— 那时即使失败也只是**一次请求**失败，不再是「账号永久不可用」。
 */
const PROXY_FIELDS = ['opencodeProxy', 'geminiProxy', 'minimaxIntlProxy', 'qoderProxy'] as const

/** 三家解析器共同支持的 scheme。 */
const PROXY_SCHEME_RE = /^(?:https?|socks5):\/\/\S+$/i

/**
 * 清掉四个代理字段里的**非法值**（返回的键值对会覆盖 `...candidate` 的脏值）。
 *
 * ⚠️ 用 `undefined` 而不是 `delete`：本函数返回的是**展开进新对象**的键值对，
 * `undefined` 让 `JSON.stringify` 整个丢弃该键（与 `modelRateLimits` 同款口径）。
 */
function sanitizeProxyFields(candidate: Partial<ProviderAccountEntry>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const field of PROXY_FIELDS) {
    const raw = (candidate as Record<string, unknown>)[field]
    if (raw === undefined) continue
    const text = typeof raw === 'string' ? raw.trim() : ''
    out[field] = PROXY_SCHEME_RE.test(text) ? text : undefined
  }
  return out
}

/**
 * 判定一个「限流解禁时刻」是否为**可用的毫秒时间戳**。
 *
 * ## ⚠️⚠️ 这是读写两侧**共用的唯一谓词**（真实缺陷，独立审计实测证伪）
 *
 * 原先读取侧（{@link sanitizeAccounts} 的 `sanitizeModelRateLimits`）判据是
 * 「有限正数」，而写入侧（`AccountPool.updateModelRateLimit`）只拒 `!Number.isFinite`
 * —— 两处**并不同源**，且读取侧的上界**不够严**：
 *
 * `1e308` 是「有限正数」，能穿过过滤落进池；而它**超出 `Date` 的合法范围**
 * （上界 ±8.64e15）。后果是下次该 (账号, 模型) 真撞限流时，
 * `updateModelRateLimit` 里 `new Date(current).toISOString()` 抛
 * **`RangeError: Invalid time value`** —— 而 17 个 `updateModelRateLimit` 调用点里
 * **16 个没有 try**（llm-adapter ×3、各 adapter、account-probe ×3），异常直接冒到
 * 推理路径与「重测」路径。
 *
 * 可达输入是**手工编辑过的备份文件**（正是本模块要防的那类输入）：
 * `modelRateLimits: {"glm-5.2": 1e308}`。
 *
 * ⇒ 判据收敛到本函数一处，读写两侧都调它。**不要再各写一份**。
 *
 * 上界取 `8.64e15`（`Date` 的最大毫秒值，`8640000000000000`）：
 * 超过它的值 `new Date(v).getTime()` 为 `NaN`，任何 `toISOString()` 都会抛。
 *
 * @param value 待判定的值（任意类型，非数字一律 false）。
 * @returns 是否是「可安全交给 `new Date()` 的毫秒时间戳」。
 */
export function isValidResetAtMs(value: unknown): value is number {
  // 只认有限数字：`NaN` / `Infinity` / 字符串 / `null` 一律 false。
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  // ⚠️ 必须 > 0：`0` 与负数在选号判据里等价于「不受限」（见 sanitizeModelRateLimits
  // 的注释），且 UI 的 `hasAnyLimit` 只看键是否存在 —— 详见 D2 的取舍说明。
  if (value <= 0) return false
  // ⚠️ 上界：超出 Date 范围的有限数会让 `new Date(v).toISOString()` 抛 RangeError。
  return value <= MAX_DATE_MS
}

/** `Date` 可表示的最大毫秒值（±8.64e15）。 */
export const MAX_DATE_MS = 8_640_000_000_000_000

/**
 * 过滤 `modelRateLimits` 的脏值；无有效项时返回 `undefined`。
 *
 * 只保留 {@link isValidResetAtMs} 认可的条目（有限、正、且在 `Date` 范围内）。
 *
 * ⚠️ **不过滤已过期的时间戳**：过期标记由 `sweepExpiredRateLimits` 清理，
 * 且 UI 需要看到它们（`hasAnyLimit` 靠它渲染「重置」按钮）。
 *
 * ## ⚠️ 为什么 `0` 也被丢弃（以及这条取舍的代价）
 *
 * **选号侧**：`getAvailableAccount` / `allAccountsRateLimitedForModel` /
 * `listAvailableCredentials` 的判据都是
 * `resetAt === undefined || resetAt === 0 || now >= resetAt` ⇒ `0` 与负数都等价于
 * 「不受限」，故丢弃它们**不改变选号行为**。
 *
 * ⚠️ **但 UI 侧还有第二套判据**（`plugin-src/client/jet-hub.js` 的 `hasAnyLimit`
 * = `Object.keys(modelRateLimits).length > 0`）—— 它**只看键是否存在**，用来决定
 * 「重置 / 重测」按钮是否可点。若池里原本只有 `{m: 0}`，本函数把整个键写 `undefined`
 * ⇒ `hasAnyLimit` 从 `true` 翻成 `false` ⇒ **用户无法再手动解禁**。
 *
 * 可达性：`0` 只可能来自**手工编辑的备份**（正常运行写入的都是
 * `Date.now() + cooldown` 或 `nextUtc8DayStartMs()`，恒为正）。
 * 取舍：保留 `0` 会让选号侧多一个「等价于不受限」的噪音键，但能保住 UI 的自救入口；
 * 丢弃它则相反。**当前选择丢弃**（与「只留真实有效的标记」一致），
 * 若将来收到「重置按钮变灰」的报障，改这里（`value >= 0`）**并同时**改 UI 判据，
 * 不要只改一侧 —— 那是本项目「一文件两套同义判据」的事故形态。
 */
function sanitizeModelRateLimits(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const limits: Record<string, number> = {}
  for (const [modelId, value] of Object.entries(raw as Record<string, unknown>)) {
    // 模型 id 必须非空字符串（与选号侧 `modelId.length === 0` 跳过限流的约定一致）。
    if (modelId.length === 0) continue
    // ⚠️ 判据走共享谓词（读写同源），不要再内联 `isFinite && > 0`。
    if (!isValidResetAtMs(value)) continue
    limits[modelId] = value
  }
  return Object.keys(limits).length > 0 ? limits : undefined
}

/** 老契约后端：数据仍在 settings 文档里（与 ≤0.1.6 完全一致）。 */
class SettingsStore implements JetHubStore {
  readonly kind = 'settings' as const

  constructor(private readonly scope: SettingsScopeLike) {}

  load(): JetHubState | undefined {
    const value = this.scope.get() as
      | {
        accounts?: unknown
        disabledModels?: unknown
        aggregateRejections?: unknown
        aggregateAllowed?: unknown
        aggregateOrder?: unknown
        aggregateOrderMode?: unknown
        loomyPermanentLocked?: unknown
        gatewayEnabled?: unknown
        gatewayAllowLan?: unknown
        nativeWebSearchEnabled?: unknown
        sessionBalanceEnabled?: unknown
        // ⚠️ 老键，只为迁移而读（新文档不再写它）：见 sanitizePanelEntry 的第二参。
        sidebarEntryEnabled?: unknown
        panelEntry?: unknown
        providerOrder?: unknown
        minimaxXff?: unknown
        providerClosed?: unknown
      }
      | undefined
    if (value === undefined || value === null) return undefined
    return {
      accounts: sanitizeAccounts(value.accounts),
      disabledModels: sanitizeDisabledModels(value.disabledModels),
      // 老文档没这个键 → 空表（没有任何拒绝），与升级前行为一致。
      aggregateRejections: sanitizeAggregateRejections(value.aggregateRejections),
      // 老文档没这三个键 → 空白名单 / 空顺序表 / 临期序，与升级前行为一致（未接入渠道仍不参与）。
      aggregateAllowed: sanitizeAggregateAllowed(value.aggregateAllowed),
      aggregateOrder: sanitizeAggregateOrder(value.aggregateOrder),
      aggregateOrderMode: sanitizeAggregateOrderMode(value.aggregateOrderMode),
      // 只是**镜像**（权威表在 permanent-locks.json）；老文档没这个键 → false。
      loomyPermanentLocked: value.loomyPermanentLocked === true,
      // 老文档没这个键 → 启用，与升级前行为一致。
      gatewayEnabled: sanitizeGatewayEnabled(value.gatewayEnabled),
      // 老文档没这个键 → 关闭（安全默认：暴露面变大必须是显式选择）。
      gatewayAllowLan: sanitizeGatewayAllowLan(value.gatewayAllowLan),
      // 老文档没这个键 → 启用（原生搜索本就是新功能，默认开启才符合「装上就能用」）。
      nativeWebSearchEnabled: sanitizeNativeWebSearchEnabled(value.nativeWebSearchEnabled),
      // 老文档没这个键 → 启用（2026-10-30 用户要求的默认方向）。
      sessionBalanceEnabled: sanitizeSessionBalanceEnabled(value.sessionBalanceEnabled),
      // 老文档没新键 → 按老布尔迁移（只有明确 false 才是「仅设置页」）；两者都没有 → 仅侧栏。
      panelEntry: sanitizePanelEntry(value.panelEntry, value.sidebarEntryEnabled),
      // 老文档没这个键 → 空数组（未自定义），展示侧按声明顺序渲染。
      providerOrder: sanitizeProviderOrder(value.providerOrder),
      // 老文档没这个键 ⇒ `undefined` ⇒ 不附 XFF（与修复前行为逐字节一致）。
      minimaxXff: sanitizeMinimaxXff(value.minimaxXff),
      // 老文档没这个键 → 空表（没有任何供应商被关闭），与升级前行为一致。
      providerClosed: sanitizeProviderClosed(value.providerClosed),
    }
  }

  async save(state: JetHubState): Promise<void> {
    await this.scope.replace({
      accounts: state.accounts,
      disabledModels: state.disabledModels,
      // ⚠️⚠️ **必须带上拒绝表**（真实缺陷，对抗审计实测证伪）：
      //    `replace` 是**整体替换**语义 —— 漏掉本键会让拒绝表**永不落盘**，
      //    且**任何**账号/黑名单/网关/顺序写入都会顺带把它抹掉。
      //    后果：用户明确拒绝的渠道在重启后**静默重新参与轮换**（用户无从察觉）。
      //    探针实测（老契约后端）：落盘 section 键只有
      //    `accounts,disabledModels,gatewayEnabled,loomyPermanentLocked,providerOrder`，
      //    `aggregateRejections` 为 undefined，重启后读回 `{}`。
      //    ⚠️ 与下面三个「接受丢失」的键**不同**：那三个丢失后果**可逆且用户可见**
      //    （网关回默认、顺序回声明序），而拒绝表丢失是**静默误路由**。
      aggregateRejections: state.aggregateRejections ?? {},
      // ⚠️⚠️ **三个新键同样必须带上**（与拒绝表逐条同因）：
      //    `replace` 是**整体替换**语义 ⇒ 漏键 = 永不落盘 + 被任何写入抹掉。
      //    其中白名单丢失的后果**不是**「可逆即可接受」那一档：它会让用户手工打开的
      //    无临期渠道**静默回到不参与**（用户下次发消息时发现请求不走那个渠道，
      //    却看不到任何提示 —— 与拒绝表丢失同属「静默改路由」）。
      //    ⚠️ 探针实测的既有形态：漏键时 section 里根本没有该键，新实例读回缺省值。
      aggregateAllowed: state.aggregateAllowed ?? {},
      aggregateOrder: state.aggregateOrder ?? {},
      aggregateOrderMode: state.aggregateOrderMode === 'manual' ? 'manual' : 'expiry',
      // 镜像字段由 AccountPool 与独立文档**同源写出**：同机上只认这个字段的
      // 旧版本代码（其它 profile）读它、也会原样写回它，故两边不会脱节。
      loomyPermanentLocked: state.loomyPermanentLocked === true,
      // 开关丢失只会让网关回到默认启用（可逆），故接受老版本重写时丢掉本键。
      gatewayEnabled: state.gatewayEnabled !== false,
      // ⚠️ **必须带上本键**（与上一行同因）：`replace` 是整体替换语义 —— 漏键会让
      // 用户打开的「允许局域网访问」在任何一次其它写入时被抹掉，重启后**静默
      // 回到只绑回环**（可逆但用户会以为坏了）。缺键语义为关闭（安全默认）。
      gatewayAllowLan: state.gatewayAllowLan === true,
      // ⚠️ **必须带上本键**（真实缺陷，PR95 审计实测证伪）：
      //    `replace` 是**整体替换**语义 —— 漏掉本键会让用户明确关闭的「渠道原生
      //    搜索」在**任何**一次账号/黑名单/网关/顺序写入时被抹掉，
      //    重启后**静默回到原生搜索**（用户无从察觉，正是本键加进来时那条
      //    「只有显式 false 才算关闭」要守的东西）。
      //    探针实测（老契约后端）：`setNativeWebSearchEnabled(false)` 的
      //    replace 载荷里根本没有本键，新实例读回 `true`。
      nativeWebSearchEnabled: state.nativeWebSearchEnabled !== false,
      // ⚠️ **必须带上本键**（与 `nativeWebSearchEnabled` 同因，是同一个
      //    `replace` 整体替换陷阱）：漏键会让用户明确关闭的「ZCode 会话负载
      //    均衡」在任何一次其它写入时被抹掉，重启后**静默回到开启**。
      sessionBalanceEnabled: state.sessionBalanceEnabled !== false,
      // ⚠️ **必须带上本键**（与 `nativeWebSearchEnabled` 同因，是同一个
      //    `replace` 整体替换陷阱的第二个受害者）：漏键会让用户改过的
      //    「面板入口」在**任何**一次账号/黑名单/网关/顺序写入时被抹掉，
      //    重启后**静默回到默认「仅侧栏」**（用户本以为改过了它）。
      //    过一遍 sanitize：入参可能来自任何调用方，脏值不该被写进文档。
      panelEntry: sanitizePanelEntry(state.panelEntry),
      // 顺序丢失只会回到声明顺序（可逆，重拖一次即恢复），同理接受丢失。
      providerOrder: state.providerOrder ?? [],
      // ⚠️ **必须带上本键**：`replace` 是整体替换语义 ⇒ 漏键会让用户设置的
      //    XFF 在**任何**一次账号/黑名单/网关/顺序写入时被抹掉，
      //    进而「国际站明明能用却突然又开始 307」—— 症状极难对应到本键。
      //    缺键/空串一律写 `''`（= 不附头），不会写出 `undefined` 空洞。
      minimaxXff: sanitizeMinimaxXff(state.minimaxXff) ?? '',
      // ⚠️⚠️ **必须带上本键**（与上面几个新键逐条同因）：`replace` 是**整体替换**
      //    语义 ⇒ 漏键会让「供应商关闭意图」**永不落盘**，且**任何**账号 / 黑名单 /
      //    网关 / 顺序写入都会顺带把它抹掉 ⇒ 重启后该供应商**静默回到「已打开」**
      //    （Gitee issue IKP8OF 原样复发，且用户无从察觉自己「又打开过」它）。
      //    缺键 / 脏值一律写 `{}`，不会写出 `undefined` 空洞。
      providerClosed: sanitizeProviderClosed(state.providerClosed),
    })
  }
}

/** 仅内存后端：两个持久化后端都不可用时的显式降级。 */
class MemoryStore implements JetHubStore {
  readonly kind = 'memory' as const
  private state: JetHubState | undefined

  load(): JetHubState | undefined {
    return this.state
  }

  async save(state: JetHubState): Promise<void> {
    this.state = state
  }
}

/**
 * provider id ↔ 凭据 ref 前缀的**单一真相源**。
 *
 * 账号凭据一律存 `{PREFIX}_ACCOUNT_{UUID_SHORT}`（本插件的既有约定），故可据
 * ref 名反推 provider。**表与正则都由本表派生** —— 这是刻意的：
 *
 * ⚠️ 表与正则分家会漂移出「加了 provider 却漏改正则」这类缺陷。真实缺陷（**同型两次**）：
 *
 * ① 本表原先只有 **6 项**（注释也写着「六个 provider」），而插件实际有 **11 个**
 * —— `qodercn` / `cline` / `loomy` / `raccoon` / `zcode` 五个 provider 的账号在
 * `state.json`（Jet Hub 状态文档）缺失时（重装 / 迁移 / profile 重建）
 * **无法从 `.credentials.yaml` 的 `refs:` 恢复**，用户侧表现为「重装 / 迁移后
 * 这几个面板的账号凭空消失，只能重新登录」。凭据本体一直完好，只是索引建不出来。
 *
 * ② **2026-10-02 同型复发**：上游合并第 12 个 provider `minimax` 时**又漏加了本表**
 * —— `tests/unit/jet-hub-store.spec.ts` 的派生用例当场变红（期望 12 项、实得 11 项），
 * 但那条用例没在合并前跑到。⇒ 教训：**合并任何「新增 provider」的分支前先跑它**；
 * 靠人眼维护本表已经漏过两次。
 *
 * ⚠️ **必须与 `src/jet-hub-rpc.ts` 的 `account.create` 生成的 ref 前缀一致**
 * （那里是 `${provider.toUpperCase()}_ACCOUNT_${suffix}`）。**新增 provider 时
 * 漏加本表 = 该 provider 的账号在状态文档丢失后静默消失**。
 *
 * ⚠️ 单凭据回退 ref（如 `CODEARTS_ACCESS_TOKEN` / `ZCODE_CREDENTIAL`）不含
 * `_ACCOUNT_`，故不会被本表误吞 —— 这里只需登记账号 ref 前缀。
 *
 * ⚠️ 本表的顺序与客户端 `plugin-src/client/jet-hub.js` 的 `PROVIDERS` **保持一致** ——
 * 派生用例不校验顺序（恢复顺序由 refs 文件决定），但两者对齐后便于逐项核对。
 *
 * 依据 `src/product.ts` 与各 `*-product.ts` 的 `id` 字段：
 * `codearts` / `buddy` / `workbuddy` / `lobsterai` / `qoder` / `qodercn`
 * / `trae` / `cline` / `loomy` / `raccoon` / `minimax` / `minimaxintl`
 * / `zcode` / `opencode` / `gemini` / `officeace` / `accio` / `astudio`。
 * ⚠️ 这行清单必须与**下面那张表的实际项数**一致（2026-10-13 合并审计：
 *    此前它漏了 `officeace` —— 表里有、清单里没有，属注释失实）。
 */
const REF_PREFIX_TO_PROVIDER: ReadonlyArray<readonly [string, string]> = [
  ['CODEARTS', 'codearts'],
  ['BUDDY', 'buddy'],
  ['WORKBUDDY', 'workbuddy'],
  ['LOBSTERAI', 'lobsterai'],
  ['QODER', 'qoder'],
  ['QODERCN', 'qodercn'],
  ['TRAE', 'trae'],
  ['CLINE', 'cline'],
  ['LOOMY', 'loomy'],
  ['RACCOON', 'raccoon'],
  // ⚠️ 第 12 个 provider（上游 2026-10-02 合并）—— 曾漏加，见上方注释 ②。
  ['MINIMAX', 'minimax'],
  // ⚠️ 第 17 个 provider（minimaxintl，2026-10-15）—— 同款坑第 **六** 次。
  // MiniMax Code 国际版与本表里的 `minimax` **是两个 provider**（账号不互通、
  // 凭据 ref 前缀不同），故必须各占一行。
  // 漏加 = `MINIMAXINTL_ACCOUNT_*` 的账号在 `state.json` 缺失时静默消失
  //（凭据还在 `.credentials.yaml` 里，只是索引建不出来，用户只能重新登录）。
  // ⚠️ 它与 `MINIMAX` 是**超串关系**（`MINIMAXINTL` 以 `MINIMAX` 开头）——
  //    顺序由 `ACCOUNT_REF_RE` 内部的**长度降序排序**保证，与本数组的书写顺序无关。
  ['MINIMAXINTL', 'minimaxintl'],
  ['ZCODE', 'zcode'],
  // ⚠️ 第 13 个 provider（opencode，2026-10-01）—— 与上面 minimax 同款坑：
  // 漏加会让「恢复备份」认不出 opencode 账号（见上方注释 ②）。
  ['OPENCODE', 'opencode'],
  // ⚠️ **本 fork 独有**的 provider（modelscope，2026-10-16）—— 同款坑第 **五** 次。
  // 漏加 = `MODELSCOPE_ACCOUNT_*` 的账号在 `state.json` 缺失时**静默消失**
  //（凭据还在 `.credentials.yaml` 里，只是索引建不出来，用户只能重新授权）。
  //
  // ⚠️ 前缀取 `MODELSCOPE`（不是旧 fork 反代的 `PROXY_UPSTREAM_MODELSCOPE`）：
  //    上游整套反代命名空间都不存在，且 `account.create` 生成的账号 ref 恒为
  //    `${provider.toUpperCase()}_ACCOUNT_${suffix}` —— 两者必须对上，否则本表认不出它。
  ['MODELSCOPE', 'modelscope'],
  // ⚠️ **本 fork 独有**的 provider（qiniu，2026-10-29）—— 同款坑第 **六** 次。
  // 漏加 = `QINIU_ACCOUNT_*` 的账号在 `state.json` 缺失时**静默消失**
  //（凭据还在 `.credentials.yaml` 里，只是索引建不出来，用户只能重新粘贴 Key）。
  //
  // ⚠️ 前缀取 `QINIU`：`account.create` 生成的账号 ref 恒为
  //    `${provider.toUpperCase()}_ACCOUNT_${suffix}`（见 `qiniu-rpc.ts` 的
  //    `qiniuSlotNamesOf`），两者必须对上，否则本表认不出它。
  ['QINIU', 'qiniu'],
  // ⚠️ 第 14 个 provider（gemini，2026-10-03）—— 同款坑第 **三** 次。
  // 漏加 = `GEMINI_ACCOUNT_*` 的账号在 `state.json` 缺失时静默消失
  //（凭据还在 `.credentials.yaml` 里，只是索引建不出来，用户只能重新授权）。
  // 本表与客户端 `PROVIDERS` 的一致性由
  // `tests/unit/jet-hub-store.spec.ts` 的「恢复表覆盖客户端 PROVIDERS 的全部
  // provider（从真实清单派生）」用例锁死 —— 合并新增 provider 前**先跑它**。
  ['GEMINI', 'gemini'],
  // ⚠️ 第 15 个 provider（officeace，2026-10-12）—— 同款坑第 **四** 次。
  // 漏加 = `OFFICEACE_ACCOUNT_*` 的账号在 `state.json` 缺失时静默消失
  //（凭据还在 `.credentials.yaml` 里，只是索引建不出来，用户只能重新登录）。
  ['OFFICEACE', 'officeace'],
  // ⚠️ 第 16 个 provider（accio，2026-10-13）—— 同款坑第 **五** 次
  //（⚠️ 与 officeace **同一次合并**并入，两者各算一次复发）。
  // 漏加 = `ACCIO_ACCOUNT_*` 的账号在 `state.json` 缺失时静默消失
  //（凭据还在 `.credentials.yaml` 里，只是索引建不出来，用户只能重新登录）。
  ['ACCIO', 'accio'],
  ['AUTOCLAW', 'autoclaw'],
  // ⚠️ 第 18 个 provider（astudio，2026-10-16）—— 同款坑第 **六** 次。
  // 漏加 = `ASTUDIO_ACCOUNT_*` 的账号在 `state.json` 缺失时静默消失
  //（凭据还在 `.credentials.yaml` 里，只是索引建不出来，用户只能重新导入）。
  ['ASTUDIO', 'astudio'],
  // ⚠️ Codely（Unity，2026-10-19）：**UI 先行阶段**就提前登记（registry 里该条
  //    `channel: false`，但恢复表守卫按**全量** registry 派生、只豁免 aggregate
  //    —— 漏加会让 `jet-hub-store.spec.ts` 的派生用例变红）。账号 ref 形态沿用
  //    统一规则 `CODELY_ACCOUNT_${suffix}`（`account.create` 的前缀规则）。
  ['CODELY', 'codely'],
  // ⚠️ 超级麦吉（Magicrew，2026-10-29）—— 同款坑第 **八** 次。
  // 漏加 = `MAGICREW_ACCOUNT_*` 的账号在 `state.json` 缺失时**静默消失**
  //（凭据还在 `.credentials.yaml` 里，只是索引建不出来，用户只能重新导入）。
  ['MAGICREW', 'magicrew'],
  // ⚠️ 第 19 个 provider（autoclawintl，2026-10-20）—— 同款坑第 **七** 次。
  // 漏加 = `AUTOCLAWINTL_ACCOUNT_*` 的账号在 `state.json` 缺失时**静默消失**
  //（凭据还在 `.credentials.yaml` 里，只是索引建不出来，用户只能重新导入）。
  // ⚠️ 与 `AUTOCLAW` 是**超串关系**（`AUTOCLAWINTL` 以 `AUTOCLAW` 开头）——
  //    顺序由 `ACCOUNT_REF_RE` 内部的**长度降序排序**保证，与本数组书写顺序无关
  //    （与 `MINIMAX` / `MINIMAXINTL` 同型）。
  ['AUTOCLAWINTL', 'autoclawintl'],
]

/**
 * 账号凭据 ref 形态：`{PREFIX}_ACCOUNT_{SUFFIX}`（前缀由单一真相源派生）。
 *
 * ## 尾段判据为什么不能只是 `[0-9A-Fa-f]{6,}`（2026-10-25 审计 A1-F4 / B1）
 *
 * 大多数 provider 的尾段确实是纯 hex（`${provider}_ACCOUNT_${randomHex}`）。
 * 但 **opencode 的尾段不是**：它在 key 尾 8 位含 `-`/`.` 时会生成
 * `OPENCODE_ACCOUNT_<剥完非法字符>_<8 位 hex>`
 * （`opencode-rpc.ts` 的 `slotNamesOf`）—— 尾段含 `_`，**永远不是纯 hex**。
 *
 * 旧判据下 `providerOfAccountRef` 对这类 ref 返回 `undefined`，后果**两条**：
 *
 * 1. `state.json` 缺失时该账号**静默消失**（凭据还在、索引建不出来）；
 * 2. ⚠️ 更严重：`backup.ts` 的跨 provider 校验把 `undefined` 当「不是账号 ref」
 *    **放行**（fail-open）⇒ 一份 `provider:'buddy'` 却引用 `OPENCODE_ACCOUNT_*`
 *    的备份会被**采纳**（实测 `imported=1`），而同一误用在合法 hex 尾 ref 下
 *    会被拒（`imported=0`）。同一份校验对两种 ref 形态给出**相反**结论，
 *    正是「一文件两套同义判据」的变体。
 *
 * ⇒ 尾段放宽为「字母数字/下划线 + 可选的 `_<8 位 hex>` 后缀」：
 * `([0-9A-Za-z]{6,}(?:_[0-9A-Fa-f]{8})?|[0-9A-Za-z]*_[0-9A-Fa-f]{8})`。
 *
 * ⚠️ 三条并列分支，缺一不可（都是 `slotNamesOf` **真实会产出**的形态）：
 *
 * | 形态 | 例 | 为什么需要单独一条 |
 * |---|---|---|
 * | `[0-9A-Za-z]{6,}` | `OPENCODE_ACCOUNT_AAAAAA` | 存量纯 hex / 合法字母尾段 |
 * | `[0-9A-Za-z]{6,}_[0-9A-F]{8}` | `OPENCODE_ACCOUNT_AAAABCD_6480DB97` | 归一化 + hash |
 * | `[0-9A-Za-z]*_[0-9A-F]{8}` | `OPENCODE_ACCOUNT__9ABB433E` | 尾段**全是非法字符**时剥完为空，长度不足 6 |
 *
 * 另外「合法尾段本身可含 `_`」也是一种真实形态（`OPENCODE_ACCOUNT_AAAAB_CD`
 * —— 尾 8 位 `aaaab_cd` 全合法、走合法分支且不带 hash）⇒ 纯 hex 判据
 * **从一开始就漏掉它**，与本次归一化无关。故第一条分支也接受 `_`。
 *
 * ⚠️ **识别面只增不减**：纯 hex 仍匹配（存量 ref 逐字节不受影响），新形态也匹配。
 * ⚠️ 两个捕获组的语义保持不变（`[1]` = 前缀、`[2]` = 尾段），
 * `accountFromCredentialRef` 用尾段合成 id —— 它会把尾段小写后拼进 id，
 * 对 `AAAABCD_6480DB97` 得到 `opencode-aaaabcd_6480db97`（与 `slotNamesOf`
 * 的 id 前缀一致性**不要求逐字相同**：那条 id 是首次添加时算的，恢复路径
 * 只在 `state.json` 缺失时兜底，且两端都以「尾段」为身份锚点）。
 */
const ACCOUNT_REF_RE = new RegExp(
  // ⚠️ 按前缀长度**降序**排列：`QODERCN` 必须排在 `QODER` 之前。虽然正则的
  // 回溯最终仍能让 `QODERCN_*` 匹配成功（所以顺序错了也**暂时**看不出问题），
  // 但那时匹配结果就取决于引擎的尝试顺序而非规则 —— 一旦将来加入更多同前缀的
  // provider（如 `QODERX`），就会变成静默错归属：账号挂到 `qoder` 面板，而它的
  // 凭据是 CN 的，请求必然失败。故这里显式定序，而非依赖回溯。
  `^(${REF_PREFIX_TO_PROVIDER
    .map(([prefix]) => prefix)
    .sort((a, b) => b.length - a.length)
    .join('|')})_ACCOUNT_([0-9A-Za-z_]{6,}|[0-9A-Za-z]*_[0-9A-Fa-f]{8})$`,
)

/**
 * 由账号凭据 ref 反推 provider；不是账号 ref 形态时返回 `undefined`。
 *
 * 用途是**合并导入的「ref 占用」检查**（`src/backup.ts`）：备份里被采纳账号引用的
 * ref 若已被本机**另一个**账号占用，回写它会静默覆盖本机凭据。调用方需要知道
 * 该 ref 归属哪个 provider 才能判断「占用它的那条账号是不是同一个号」。
 *
 * ⚠️ 判据与 {@link accountFromCredentialRef} **同源**（同一个正则、同一张表）——
 * 不要再写第二份「前缀 → provider」映射，本项目已有「一文件两套同义判据」的事故史。
 * ⚠️ 单凭据回退 ref（`CODEARTS_ACCESS_TOKEN` / `BUDDY_ACCESS_TOKEN` 等）不含
 * `_ACCOUNT_`，故返回 `undefined` —— 它们不是账号 ref，调用方应自行决定如何处理。
 */
export function providerOfAccountRef(ref: string): string | undefined {
  const match = ACCOUNT_REF_RE.exec(ref)
  if (match === null) return undefined
  const prefix = match[1]
  if (prefix === undefined) return undefined
  return REF_PREFIX_TO_PROVIDER.find(([candidate]) => candidate === prefix)?.[1]
}

/**
 * 从 `.credentials.yaml` 的 `refs:` 段提取 ref 名（**只取键名，不读值**）。
 *
 * 判据用「缩进 ≥2 且以大写标识符开头」，并在回到顶格键时结束 —— 凭据文件是
 * 本插件**只能读不能依赖**的外部文档，故这里只做最小、保守的文本扫描，
 * 不引入 YAML 依赖（运行时不保证可解析，实证：`yaml`/`js-yaml` 从本包
 * 均不可解析）。
 */
function extractCredentialRefNames(text: string): string[] {
  const names: string[] = []
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(line)) break
    const match = /^\s{2,}([A-Z][A-Z0-9_]*):/.exec(line)
    if (match?.[1] !== undefined) names.push(match[1])
  }
  return names
}

/** 由一个账号凭据 ref 合成账号条目（昵称缺失时退回账号 id）。 */
function accountFromCredentialRef(ref: string): ProviderAccountEntry | undefined {
  const match = ACCOUNT_REF_RE.exec(ref)
  if (match === null) return undefined
  const prefix = match[1]
  const suffix = match[2]
  if (prefix === undefined || suffix === undefined) return undefined
  // 查表也走同一份真相源：正则捕获组只证明「前缀被登记过」，provider 仍由表给出，
  // 避免这里再写一份「前缀 → provider」的映射。
  const provider = REF_PREFIX_TO_PROVIDER.find(([candidate]) => candidate === prefix)?.[1]
  if (provider === undefined) return undefined
  const id = `${provider}-${suffix.toLowerCase()}`
  return {
    id,
    provider,
    nickname: id,
    enabled: true,
    credentialRef: ref,
    createdAt: Date.now(),
    refreshable: true,
  }
}

/** 文件后端：`$DSH_HOME/jet-hub/state.json`（原子写）。 */
class FileStore implements JetHubStore {
  readonly kind = 'file' as const

  constructor(
    /** DSH home（状态目录与旧凭据文件都相对它定位）。 */
    private readonly home: string,
    /** 状态文档绝对路径。 */
    private readonly path: string,
    private readonly logger: { warn(message: string): void; info(message: string): void } | undefined,
  ) {}

  load(): JetHubState | undefined {
    try {
      if (!existsSync(this.path)) return this.bootstrapFromCredentialRefs()
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const value = parsed as {
        accounts?: unknown
        disabledModels?: unknown
        aggregateRejections?: unknown
        aggregateAllowed?: unknown
        aggregateOrder?: unknown
        aggregateOrderMode?: unknown
        loomyPermanentLocked?: unknown
        gatewayEnabled?: unknown
        gatewayAllowLan?: unknown
        nativeWebSearchEnabled?: unknown
        sessionBalanceEnabled?: unknown
        // ⚠️ 老键，只为迁移而读（新文档不再写它）：见 sanitizePanelEntry 的第二参。
        sidebarEntryEnabled?: unknown
        panelEntry?: unknown
        providerOrder?: unknown
        minimaxXff?: unknown
        providerClosed?: unknown
      }
      return {
        accounts: sanitizeAccounts(value.accounts),
        disabledModels: sanitizeDisabledModels(value.disabledModels),
        // 老文档没这个键 → 空表（没有任何拒绝），与升级前行为一致。
        aggregateRejections: sanitizeAggregateRejections(value.aggregateRejections),
        // 老文档没这三个键 → 空白名单 / 空顺序表 / 临期序，与升级前行为一致。
        aggregateAllowed: sanitizeAggregateAllowed(value.aggregateAllowed),
        aggregateOrder: sanitizeAggregateOrder(value.aggregateOrder),
        aggregateOrderMode: sanitizeAggregateOrderMode(value.aggregateOrderMode),
        // 只是镜像（权威表在 permanent-locks.json）；老文档没这个键 → false。
        loomyPermanentLocked: value.loomyPermanentLocked === true,
        // 老文档没这个键 → 启用，与升级前行为一致。
        gatewayEnabled: sanitizeGatewayEnabled(value.gatewayEnabled),
        // 老文档没这个键 → 关闭（安全默认，与读站点 A 同判据）。
        gatewayAllowLan: sanitizeGatewayAllowLan(value.gatewayAllowLan),
        // 老文档没这个键 → 启用，与升级前行为一致。
        nativeWebSearchEnabled: sanitizeNativeWebSearchEnabled(value.nativeWebSearchEnabled),
        // 老文档没这个键 → 启用，与升级前行为一致。
        sessionBalanceEnabled: sanitizeSessionBalanceEnabled(value.sessionBalanceEnabled),
        // 老文档没新键 → 按老布尔迁移（与 `SettingsStore` 同一判据）；两者都没有 → 仅侧栏。
        panelEntry: sanitizePanelEntry(value.panelEntry, value.sidebarEntryEnabled),
        // 老文档没这个键 → 空数组（未自定义），展示侧按声明顺序渲染。
        providerOrder: sanitizeProviderOrder(value.providerOrder),
        // 老文档没这个键 ⇒ `undefined` ⇒ 不附 XFF（与修复前行为逐字节一致）。
        minimaxXff: sanitizeMinimaxXff(value.minimaxXff),
        // 老文档没这个键 → 空表（没有任何供应商被关闭），与升级前行为一致。
        providerClosed: sanitizeProviderClosed(value.providerClosed),
      }
    } catch (error) {
      this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，本次以空列表启动: ${String(error)}`)
      return undefined
    }
  }

  async save(state: JetHubState): Promise<void> {
    // ⚠️ **过一遍 sanitize，与 `SettingsStore.save` 对齐**（2026-10-24 审计 M7）。
    //
    // 两个后端写的是同一份文档形状，但此前只有 `SettingsStore.save` 归一化入参，
    // 本方法原样落盘 ⇒ 同一语义两套判据（本仓库红线 PR !62 的幼苗形态）。
    // 生产影响低（`AccountPool.queueStoreSave` 传入的都是已归一的缓存），
    // 但「脏值只可能从读路径进来」这个假设不该靠约定维持 —— 读侧有
    // `sanitizePanelEntry`，写侧也必须有。
    //
    // ⚠️ 只归一**本键**：其余键的归一化各有自己的守卫与事故史（见
    // `SettingsStore.save` 的逐键注释），在这里顺手全做会越过那些判据。
    this.write({ ...state, panelEntry: sanitizePanelEntry(state.panelEntry) })
  }

  private write(state: JetHubState): void {
    mkdirSync(join(this.home, 'jet-hub'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }

  /**
   * 首次启动的数据恢复（**仅在状态文档不存在时**执行一次）。
   *
   * 背景：0.1.7 启动时 `SettingsForms.importLegacyDocument()` 把
   * `$DSH_HOME/settings.yaml` 改名为 `settings.yaml.imported`，并按「section id
   * = profile 条目 id」逐段导入 —— `jet-hub` 不对应任何条目，该段导入失败、
   * 只留在改名后的文件里。于是老用户的账号索引成了孤儿（凭据本体仍在
   * `.credentials.yaml` 中，完好无损）。
   *
   * 这里据凭据 ref 名重建索引：能恢复「有哪些账号、属于哪个 provider、用哪个
   * credentialRef」，**恢复不了**昵称/顺序/限流时间戳（那三项只在旧 settings
   * 文档里，而本项目没有 YAML 解析依赖）。重建结果立即落盘，故只做一次。
   */
  private bootstrapFromCredentialRefs(): JetHubState | undefined {
    const credentialsPath = join(this.home, '.credentials.yaml')
    try {
      if (!existsSync(credentialsPath)) return undefined
      const accounts = extractCredentialRefNames(readFileSync(credentialsPath, 'utf-8'))
        .flatMap(ref => accountFromCredentialRef(ref) ?? [])
      if (accounts.length === 0) return undefined
      const state: JetHubState = {
        accounts,
        disabledModels: {},
        // 凭据文件里没有任何拒绝信息 → 空表（与全新安装一致）。
        aggregateRejections: {},
        // 凭据文件里也没有白名单/顺序/模式信息 → 全部缺省（与全新安装一致）。
        aggregateAllowed: {},
        aggregateOrder: {},
        aggregateOrderMode: 'expiry',
        // 凭据文件里没有任何锁定信息 → 镜像写 false（权威表另有其文档）。
        loomyPermanentLocked: false,
        // 恢复出的文档本来就不含任何开关信息 → 启用（与全新安装一致）。
        gatewayEnabled: true,
        // 同上：恢复出的文档不含局域网开关信息 → 关闭（安全默认，与全新安装一致）。
        gatewayAllowLan: false,
        // 同上：恢复出的文档不含原生搜索开关信息 → 启用（与全新安装一致）。
        nativeWebSearchEnabled: true,
        // 同上：恢复出的文档不含会话负载均衡开关信息 → 启用（与全新安装一致）。
        sessionBalanceEnabled: true,
        // 同上：恢复出的文档不含面板入口信息 → 默认「仅侧栏」（与全新安装一致）。
        panelEntry: DEFAULT_PANEL_ENTRY,
        // 凭据文件里也没有顺序信息 → 空数组（未自定义，与全新安装一致）。
        providerOrder: [],
        // 凭据文件里没有 XFF 设置 → 不附头（与全新安装一致）。
        minimaxXff: undefined,
        // 凭据文件里也没有关闭意图 → 空表（与全新安装一致）。
        providerClosed: {},
      }
      try {
        this.write(state)
      } catch (error) {
        this.logger?.warn(`[jet-hub] 恢复出的账号未能落盘（仅本次有效）: ${String(error)}`)
      }
      this.logger?.info(
        `[jet-hub] 已从 .credentials.yaml 恢复 ${accounts.length} 个账号`
        + '（昵称/顺序/限流标记无法恢复；旧数据仍在 settings.yaml.imported 的 jet-hub 段）',
      )
      return state
    } catch (error) {
      this.logger?.warn(`[jet-hub] 账号恢复失败（忽略）: ${String(error)}`)
      return undefined
    }
  }
}

/**
 * 解析状态文档所在目录。
 *
 * 优先级：`DSH_JET_HUB_STATE_DIR`（单测隔离用）→ `profileContext.home`
 * → `$DSH_HOME` → `~/.dsh`。与 `dsh-home-paths` 的 `resolveDshHome` 同序。
 *
 * ⚠️ `ctx` **必传**（2026-10-06 复审 !66 收紧）：本函数是**所有**插件状态文档
 * （`state.json` / `permanent-locks.json` / `badge-preferences` / `auto-checkin` /
 * `gemini-sigstore` / `dead-models`）的**唯一** home 解析入口，必须保证它们落在
 * 同一目录。PR !66 曾把它放宽成可选、并在 `dead-model-store` 里传 `undefined` ——
 * 那会**跳过优先级更高的 `profileContext.home`**，在 profile home 与 `$DSH_HOME`
 * 不相等时把失效表写到另一个目录，造成「账号池在 A、失效表在 B」的分裂，
 * 正是 `permanent-lock-store.ts` 明确警告过必须避免的情况。
 */
export function resolveJetHubHome(ctx: Context): string | undefined {
  const override = process.env.DSH_JET_HUB_STATE_DIR
  if (override !== undefined && override.trim().length > 0) return override.trim()
  const profileHome = (readService(ctx, 'profileContext') as { home?: unknown } | undefined)?.home
  if (typeof profileHome === 'string' && profileHome.length > 0) return profileHome
  const envHome = process.env.DSH_HOME
  if (envHome !== undefined && envHome.trim().length > 0) return envHome.trim()
  return join(homedir(), '.dsh')
}

/**
 * 按能力探测创建持久化后端（见文件头）。
 *
 * 顺序刻意是「老契约优先」：在 ≤0.1.6 上必须继续把数据写在 settings 文档里，
 * 否则升级/回退版本会看到两套互不相识的数据。
 */
export function createJetHubStore(ctx: Context): JetHubStore {
  const settings = settingsOf(ctx)
  if (hasLegacyNamespaceRegistration(settings) && settings !== undefined) {
    try {
      const scope = (settings.register as NonNullable<typeof settings.register>)(JET_HUB_NS, jetHubSchema)
      return new SettingsStore(scope as SettingsScopeLike)
    } catch (error) {
      // 重复注册（插件热重载）等：退回文件后端，而不是降级为内存。
      ctx.logger?.warn?.(`[jet-hub] settings namespace 注册失败，改用本地状态文档: ${String(error)}`)
    }
  }
  const home = resolveJetHubHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，账号列表与模型黑名单仅存在于内存中')
    return new MemoryStore()
  }
  return new FileStore(home, join(home, 'jet-hub', 'state.json'), ctx.logger)
}
