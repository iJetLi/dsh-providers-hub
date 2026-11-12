/**
 * Jet Hub 管理页面客户端插件。
 *
 * 注册**五处**槽位：
 * 1. `main`（keyed，key = `jet-hub`）—— 中央主面板的 Jet Hub 页渲染体。
 *    **无条件**注册：它只提供渲染体，不是入口。
 * 2. `sidebar.panellist`（list）—— 主导航里「Jet Hub」那一行。按「面板入口」
 *    偏好增删（`'sidebar'` 时有、`'settings'` 时无）。
 * 3. `settings.section` —— 设置弹层里的 Jet Hub 整页。**条件注册**：
 *    `'settings'` 时有、`'sidebar'` 时整条注销。⚠️ 与第 2 条互斥。
 * 4. `plugins.bundle.config`（keyed，key = 本包名）—— **插件详情页**上的自有
 *    设置卡片（「面板入口」下拉）。⚠️ **始终常驻**，是改回来的唯一路径。
 * 5. `conversation.input.right`（list 槽，会话作用域）—— 模型选择器旁的
 *    **用量徽标**（订阅优先 / 积分兜底，点击展开明细）。
 *
 * 第 1/2/3 条都由 `panel-entry.js` 的 `registerJetHubPanelEntries` 一次管完
 * （它们读的是同一份「面板入口」偏好，拆开写必然出现两份判据）。
 *
 * ## ⚠⚠️ 刻意**不**注册 `settings.models.provider-card`（Gitee issue IKJLHQ）
 *
 * 那个 keyed 槽的 `key` 语义**不是**自由命名空间，而是「这张卡片的
 * `settingsNs`」：官方渲染时按 `entryKey = row.entry.settingsNs` 精确查表
 * （`dsh-client-ui-settings-models/lib/client.js`）：
 *
 * ```js
 * renderSlot('settings.models.provider-card', { provider: row.entry, ... }, { entryKey: row.entry.settingsNs })
 * // 渲染侧：entriesOfSlot(slot).find(e => e.options.key === entryKey) —— 每 key 只渲染一个 winner
 * ```
 *
 * 后果是**同一个 `settingsNs` 上的第三方扩展互斥**：
 * - `SlotCore.register` 对「同 key + 同 priority」的第二个注册者**直接抛错**
 *   （`keyed slot "…" already has an entry for key "…"`）；
 * - `entriesOfSlot` 按 **ledger（注册）顺序**取每个 cell 的首个 live 条目，
 *   **`priority` 不参与排序** —— 换 priority 只能免掉那次抛错，仍然只有一个 winner；
 * - 谁 bundle 先到谁赢，后到的那方要么抛错（未捕获时 `slots.inject` 会 `stop()`
 *   并 `queueMicrotask(throw)`）、要么被 try/catch 静默吞掉而**无声消失**。
 *
 * 本插件曾以 `key: 'llm-pi-ai'` 注册 ZCode 卡片，于是与同样扩展 pi-ai 家族的
 * `@linxin666/dsh-client-ui-model-capabilities`（它的 `PI_AI_SETTINGS_NAMESPACE`
 * 注释就写着「the card slot's key」）**互斥**：两插件共存时，谁先到谁渲染，
 * 另一方的模型能力编辑面板**静默消失**（用户报障 IKJLHQ）。
 *
 * ⚠️ **换独立 key（`llm-pi-ai-zcode` 之类）并不能共存，只会让 ZCode 卡片自己消失** ——
 * 官方是按 `entryKey` 精确 `find`，换个 key 直接落空。而 zcode 本来就没有自己的
 * 适配器家族：`dsh-llm-pi-ai` 把**所有** route 目录行的 `settingsNs` 统一设成
 * `llm-pi-ai`，用户手工加的 `zcode` route 也一样。
 *
 * ⇒ 结论：ZCode 账号管理**只在 Jet Hub 设置页**（本页功能完整）。别为了「就近操作」
 * 把这个槽抢回来 —— 那等于让所有装了第三方 pi-ai 扩展的用户失去他们的面板。
 */

export const name = 'jet-hub-client'
/**
 * ⚠️ `modelDirectories` 是徽标**唯一**的信息来源（当前选中的渠道）。
 *
 * 它由 `@deepseek-ai/dsh-client-ui-model-selection` 提供，故 `package.json` 的
 * `dsh.client.inject` 必须声明该包 —— 声明的作用是让那个包的 bundle **先于**
 * 本插件的 bundle 到达（见 `dsh-client-modules` 的 `arriveGraphRow`）。
 * 未声明时本插件可能先被物化，`inject` 便会一直等服务，徽标不出现（不影响
 * 设置页与其余功能）。
 *
 * ## ⚠️⚠️ `remote.session` **必须**在这里（真机事故 2026-10-02，desktop 永久失效）
 *
 * `dsh-client-ui-model-selection` 自己的声明是
 * `inject = ["sessions", "remote", "remote.session"]`，而它的
 * `directoryFor(sessionId)` 内部会读 `this.ctx.sessions` 与
 * `this.ctx.remote.session`。
 *
 * cordis 的 inject 是**逐插件**校验的：我们自己的 ctx 没声明 `remote.session`，
 * 那句 `ctx.remote.session` 就直接抛
 * `cannot get property "remote.session" without inject`。
 * 症状是**桌面版徽标永久不显示、且无任何报错**（我曾用 try/catch 吞掉异常，
 * 结果把崩溃换成了静默失败，比原问题更难发现）。
 *
 * ⇒ 这里必须与该包**对齐**地声明 `sessions` / `remote` / `remote.session`。
 * 少一个都会让 `directoryFor` 在 desktop 上失败。
 */
export const inject = ['slots', 'connection', 'modelDirectories', 'sessions', 'remote', 'remote.session']

import { callManagementRpc, unwrapRpcResult } from '../management-rpc.mjs'
import { installJetHubStyles } from './jet-hub-styles.js'
// ⚠️ `JetHubPage` 已不在本文件使用：两处入口（含 `settings.section`）都由
//    `panel-entry.js` 注册。本文件只留它真正用到的两个符号。
import { JET_HUB_RPC_CHANNEL, providerLabel } from './jet-hub.js'
import { startCarrierContribution } from './zcode-carrier.js'
import { UsageBadge } from './usage-badge.js'
import { registerJetHubPanelEntries } from './panel-entry.js'
import { registerJetHubLedgerTab } from './ledger-tab.js'
import { JetHubPanelEntryCard } from './settings-card.js'
// ⚠️ 本文件注册的另外两处槽位也要包边界（2026-10-25 审计 A3-3）：
// 2026-10-22 之前只有 `panel-entry.js` 那两处（main / settings.section）包了，
// 而 `plugins.bundle.config` 与 `conversation.input.right` 注册的是**裸组件**
// —— 任一处渲染期异常仍会整块消失（插件详情卡片 / 用量徽标）。
import { withErrorBoundary } from './error-boundary.js'

/**
 * ⚠️ **模块级常量，不要在 `apply()` 或 `inject` 回调里新建**（2026-10-25 审计 A3-3）。
 *
 * `withErrorBoundary` 每次调用都产生一个**新的类**。若写在 `inject` 回调里，
 * 宿主每次渲染都拿到新的组件类型 ⇒ React 把整棵子树卸载重挂 ⇒ 徽标/卡片内
 * 所有本地状态（含「刚刚展开的详情」）每次都丢。`panel-entry.js` 那两处
 * 已有同款注释与守卫（`panel-entry-wiring.spec.ts` 的 M21）。
 */
const JetHubPanelEntryCardGuarded = withErrorBoundary(JetHubPanelEntryCard, { label: '插件详情页卡片' })
const UsageBadgeGuarded = withErrorBoundary(UsageBadge, { label: '用量徽标' })

export function apply(ctx) {
  ctx.effect(() => installJetHubStyles(), 'jet-hub: install styles')

  const rpcCall = async (endpoint, payload, signal) => {
    const raw = await callManagementRpc(ctx.connection, JET_HUB_RPC_CHANNEL, endpoint, payload, signal)
    return unwrapRpcResult(raw)
  }

  /**
   * zcode 内部 captcha 载体的贡献循环（二期 Task 4）。
   *
   * ⚠ **web 版零动作**：`plugin-src/client/zcode-carrier.js` 第一件事就是判
   * `globalThis.dshDesktop`（协议版本 1 才有 `browser` 租约桥）—— 拿不到就整体 return，
   * 不查 demand、不建 `<webview>`、连日志都不打。所以这条 effect 在 web 版里是个空壳，
   * 「桌面版才有内部载体」这条不变式靠它自己守住，改判据前请先看那个文件的规则 1。
   *
   * 返回值是**停止函数**，交给 `ctx.effect` 的清理路径：插件卸载/热替换时必须停掉心跳
   * 并归还 webview 租约，否则留下一个没人收的离屏 guest（`release` 没调 ⇒ 主进程侧泄漏）。
   */
  ctx.effect(() => startCarrierContribution({ rpcCall }), 'jet-hub: zcode 内部载体贡献循环')

  /**
   * Jet Hub 的**两处入口**（主导航那一行 + 设置弹层那一节）与中央主面板。
   *
   * 三者都由 `registerJetHubPanelEntries` 一次管完：`main` key **无条件**注册
   * （它只提供渲染体，不是入口），两处入口则按「面板入口」偏好**互斥**增删 ——
   * 同一组件、同一份 `rpcCall`，任一时刻只保留一个。细节见
   * `plugin-src/client/panel-entry.js` 的文件头。
   *
   * ⚠️ 这里**没有**无条件的 `settings.section` 注册：它已移进上面那个注册器，
   * 因为「仅侧栏」时要把它整条注销。
   *
   * ⚠️ 别把注册器包进 `ctx.effect`：槽注册自己就是可撤销的，`slots.inject`
   * 的返回值交给调用方即可，多包一层只会在热替换时留下双份注册。
   *
   * ⚠️⚠️ **错误边界已移进 `panel-entry.js`**（2026-10-22 整页白屏事故补强，PR #10）：
   * 那两处槽位现在注册的都是**包了 `withErrorBoundary` 的**组件。本文件不再持有
   * 任何 `JetHubPage` 引用 —— 入口与渲染体的注册都归注册器了，在这里复制一份
   * 就会变成「同一个组件两条注册路径」，正是该文件头警告的那种分叉。
   */
  registerJetHubPanelEntries(ctx, rpcCall)

  /**
   * 「Token 用量」**右侧栏标签页**（`sidebarRightTabs` + `sidebar.right.pane.tab`）。
   *
   * ⚠️ 与上面那个注册器**刻意分开**：
   *
   * - 面板入口（仅侧栏 / 仅设置页）是**互斥二选一**，归 `panel-entry.js` 管；
   *   右侧栏标签页是**始终存在**的第三个入口，不受那个下拉影响。
   * - `panel-entry.js` 的守卫按 `ctx.slots.inject('main'` / `'settings.section'`
   *   精确切片，把无关注册塞进去会让那些判据切错窗口。
   *
   * ⚠️ 它对 `sidebarRightTabs` 是**软依赖**（`ctx.inject` 里判存在再注册）：
   * 老宿主没有这个服务时整段跳过，插件其余部分照常工作。
   */
  registerJetHubLedgerTab(ctx, rpcCall)

  /**
   * **插件详情页**上的自有设置卡片（`plugins.bundle.config`）。
   *
   * ## 槽位契约
   *
   * keyed 槽，按 bundle 的**包名**分派，渲染在插件页的「描述」与「包含的组件」
   * 之间（`ui-plugin-manager` 的 `PluginManagerPage.tsx`，节点带 `data-plugin-config`）。
   *
   * ## ⚠️ key 必须是包名
   *
   * `config-ledger.ts` 把这个槽的 key 投影成「已配置」标志，页面按
   * `entryKey = pkg.name` 精确查表。**key 不匹配则整段不渲染且无任何报错** ——
   * 本插件一旦改名，这里必须同步（`build.mjs` 的安装期闸门只管
   * `__ModuleLoader__.load` 那处注册，不管这个槽）。
   *
   * ## ⚠️ 这张卡**始终常驻**，不随下拉取值注销
   *
   * 它是宿主页面，不是我们的入口；而且它是用户在「仅侧栏 / 仅设置页」之间
   * 改回来的**唯一**路径。
   *
   * ## 与 `package.json` 的关系
   *
   * `@deepseek-ai/dsh-client-ui-primitives`（卡片的 `Menu` 来源）在宿主的
   * `PLATFORM_MODULES` 里，`dsh.client.inject` 还必须声明
   * `@deepseek-ai/dsh-client-ui-plugin-manager`，否则本 bundle 可能先于它到达、
   * 下面的 `inject` 一直等服务 ⇒ 卡片永不出现（且不报错）。
   */
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'dsh-providers-hub',
    inject: () => ({ rpcCall }),
  }, JetHubPanelEntryCardGuarded))

  /**
   * 模型选择器旁的**用量徽标**（`conversation.input.right`）。
   *
   * ## 槽位契约
   *
   * 该槽是 **list + 会话作用域**（`dsh-client-ui-conversation` 声明），渲染位置
   * 是 composer 的 `standardControls` 里、`conversation.input.model` **之前**，
   * 故徽标天然落在模型选择器左侧。
   * `inject` 回调收到 `sessionId`，用它取**该会话**的模型目录。
   *
   * ## ⚠️ 为什么是 `inject`（惰性）而不是在 `apply` 里直接注册
   *
   * `ctx.modelDirectories.directoryFor(sessionId)` 需要会话 id，而它只在槽位
   * 渲染时才知道；`inject` 回调正是"每个会话渲染时求值一次"的钩子。
   * 目录按会话惰性解析、随会话 dispose，故这里**不缓存** directory 对象。
   *
   * ## ⚠️ 只在选中本插件渠道时才可能渲染
   *
   * 组件内部第一件事就是判 `supportsCreditBalance(provider)`（能力表，12 个
   * 渠道），非本插件渠道直接 `return null` —— 既不渲染也不发请求。门控放在
   * 组件里而不是这里：这里拿不到"当前选中的 provider"（它在目录快照里，
   * 会随时间变化，必须由组件订阅）。
   */
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'jet-hub-usage',
    order: 100,
    inject: (sessionId) => ({
      // ⚠️⚠️ **必须惰性取目录，不能在 inject 里取**（真机事故 2026-10-02）。
      //
      // 原写法 `directory: ctx.modelDirectories.directoryFor(sessionId).store`
      // 有两个问题：
      // 1. `directoryFor` 是**惰性 getter** —— 写 `directoryFor(sessionId).store`
      //    里的 `.store` 才触发求值，而求值发生在**槽位 inject 期**（即会话
      //    输入区渲染的同步路径上）。桌面版此时它内部要访问未注入的
      //    `remote.session`，直接抛 `cannot get property "remote.session"
      //    without inject`（Web 版不走那条分支，故只在 desktop 复现）。
      // 2. 该异常发生在渲染关键路径上，**会让整个会话输入区渲染中断** ——
      //    表现为模型选择器点不动（用户报障），远不止「徽标不显示」。
      //
      // ⇒ 改为交出一个**取值函数** `resolveDirectory()`，由组件在自己的
      // effect 里调用：失败被组件自身的 try/catch 兜住，影响面收敛到
      // 「徽标不显示」，绝不影响模型选择器。
      //
      // ⚠️⚠️ **必须同时交出 `store` 与 `load`（真机事故 2026-10-02 的真正根因）
      //
      // 读 `dsh-client-ui-model-selection` 的 `ModelDirectory` 源码得到两个事实：
      //   ① 它的**公开方法是 `load()` / `syncInputs()`，没有 `getSnapshot()` /
      //      `subscribe()`** —— 那两个在 `this.store` 上。我第一版只交出实例，
      //      组件调 `directory.getSnapshot()` 得到 `undefined` → TypeError →
      //      被 safe() 吞掉 → `provider` 恒为空 → **徽标永不显示**。
      //   ② `store` 的初值是 `{ current: null, status: 'idle' }`，**只有
      //      `await load()` 之后** `syncInputs()` 才把真实 `current` 填进去。
      //      徽标自己不发模型目录请求（`usage.badge` 按 provider 查），
      //      所以必须由它调 `load()`，否则 `current` 永远是 null。
      //
      // 两者缺一不可：只给 store 不 load → current 为 null；
      // 只给实例不 load 也不 store → getSnapshot 不存在。
      resolveDirectory: () => {
        const directory = ctx.modelDirectories.directoryFor(sessionId);
        return {
          store: directory.store,
          load: () => directory.load(),
        };
      },
      providerLabel,
      /**
       * 当前**会话** id —— 「轮换起点」的作用域键。
       *
       * ⚠️⚠️ **必须用宿主在 `inject(sessionId)` 里给的这个**：宿主 dispatch 时
       * 会把同一个 id 作为 `GenerateOptions.sessionId` 传给适配器，而选号层正是
       * 按它查偏好。插件自己编一个 ⇒ 键对不上 ⇒ **选了永远不生效且零报错**。
       */
      sessionId,
      /** 「轮换起点」读取（打开面板时调一次）。`modelId` 用于判「逐模型限流」。 */
      readRotation: (provider, sid, modelId) =>
        rpcCall('account.getRotation', { provider, sessionId: sid, modelId }),
      /**
       * 「轮换起点」写入；`position === null` = 恢复默认起点。
       *
       * ⚠️ 传**位次**（1-based），不是 accountId —— 用户 2026-11-10 要求「跟随位次」：
       *    选「位次 1」后去管理界面拖拽，回来仍是「位次 1」= 新的第 1 个号。
       */
      writeRotation: (provider, sid, position) =>
        rpcCall('account.setRotation', { provider, sessionId: sid, position }),
      readBadge: (provider, options) => rpcCall('usage.badge', { provider, ...options }),
      /**
       * 聚合 provider「上次**实际**转发成功的渠道」（P3）。
       *
       * ⚠️ 宿主侧该端点是**纯内存读**（零网络零余额查询）—— 徽标在**门控阶段**
       * 就要用它把 `aggregate` 重定向成真实渠道，而门控是同步渲染路径。
       * ⚠️ 返回 `{ provider: null }` 表示无历史 ⇒ 徽标**不渲染**。
       */
      readActiveProvider: (canonicalId) =>
        rpcCall('aggregate.activeProvider', canonicalId === undefined ? {} : { canonicalId }),
      // ⚠️ **这里曾有一个 `readExpiryOrder` prop，已删除**（真实死代码，审计实测指出）：
      //    它在 `c12b3ab` 上就已**零消费者** —— `AggregatePanel` 自己直接
      //    `rpcCall('aggregate.expiryOrder', {})`（`jet-hub.js`），从不经过本 prop。
      //    本仓库把死代码视为缺陷（会让人以为「面板是通过 prop 取数的」而找错地方）。
      //    ⚠️ 端点本身仍在（`aggregate.expiryOrder`）—— 删的只是这个没人用的转发 prop。
      writePreference: (preference) => rpcCall('usage.badgePreference', { preference }),
      // 自动签到开关（全局一个，不分渠道）：宿主在「打开」时会立刻跑一轮。
      setAutoCheckin: (enabled) => rpcCall('usage.autoCheckin', { enabled }),
      // 关闭那行**常驻**的自动签到状态文字（只关当前这一轮，下一轮会重新出现）。
      dismissAutoCheckin: () => rpcCall('usage.autoCheckin', { dismiss: true }),
      // 一键领取：每日签到 + （buddy / workbuddy 的）成长中心任务。
      //
      // ⚠️ runTasks 缺省**必须为 false** —— 同一个方法也是「每日首次启动自动签到」
      // 的执行体（宿主 auto-checkin 的 claim 回调）。成长一轮单账号 90～270s、
      // 全串行，默认开启等于每次开机自动打几十个上游请求。
      // budgetMs 缺省由宿主取 10 分钟；传 0 或负数表示不限时。
      claimCredits: (provider, runTasks, budgetMs) =>
        rpcCall('credits.claimAll', { provider, runTasks, budgetMs }),
    }),
  }, UsageBadgeGuarded))
}
