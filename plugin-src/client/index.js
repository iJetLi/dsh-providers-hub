/**
 * Jet Hub 管理页面客户端插件。
 *
 * 注册两处：
 * 1. `settings.section` —— Jet Hub 设置页面；
 * 2. `conversation.input.right`（list 槽，会话作用域）—— 模型选择器旁的
 *    **用量徽标**（订阅优先 / 积分兜底，点击展开明细）。
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
import { JET_HUB_RPC_CHANNEL, JetHubPage, providerLabel } from './jet-hub.js'
import { startCarrierContribution } from './zcode-carrier.js'
import { UsageBadge } from './usage-badge.js'
// ⚠️ 2026-10-22 整页白屏事故的结构性补强：任何渲染期异常只坏掉本面板，
//    不再让整个设置页（连同侧栏）被 React 卸载。见该文件头。
import { withErrorBoundary } from './error-boundary.js'
import { registerJetHubSidebarEntry } from './sidebar-entry.js'

/**
 * 注册到 `settings.section` 的组件。
 *
 * ⚠️ 必须是**包了错误边界**的那个，不能直接注册 `JetHubPage`：直接注册时，
 * 任何渲染期 TypeError 都会卸载整棵设置页子树，用户除了重启 DSH 没有出路
 * （2026-10-22 真实事故的症状：「页面直接清空，切换页面无效，只能重启 dsh」）。
 */
const JetHubPageGuarded = withErrorBoundary(JetHubPage, { label: 'Jet Hub 设置页' })

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

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'jet-hub',
    order: 50,
    label: () => 'Jet Hub',
    inject: () => ({ rpcCall }),
  }, JetHubPageGuarded))

  /**
   * 主导航里的「Jet Hub」入口 + 中央主面板（`main` 槽的 `jet-hub` key）。
   *
   * 与上面那条 `settings.section` 是**同一页的两条入口**：同组件、同 `rpcCall`，
   * 差别只在宿主给的留白（设置页有 `SettingsRoot` 的左右内边距，主面板没有）。
   * 显不显示由页头的「侧栏」开关控制，偏好落盘在宿主侧
   * （`sidebarEntry.getEnabled` / `sidebarEntry.setEnabled`），细节见
   * `plugin-src/client/sidebar-entry.js` 的文件头。
   *
   * ⚠️ 别把它包进 `ctx.effect`：槽注册自己就是可撤销的，`slots.inject` 的返回值
   * 交给调用方的 effect 即可，多包一层只会在热替换时留下双份注册。
   */
  registerJetHubSidebarEntry(ctx, rpcCall)

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
  }, UsageBadge))
}
