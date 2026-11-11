/**
 * 「Token 用量」**右侧栏标签页**的接线（宿主 `@deepseek-ai/dsh-client-ui-sidebar-right`）。
 *
 * ## 它是什么
 *
 * 把 Jet Hub 已有的 Token 账本（`TokenLedgerPanel`）接成右侧边栏里的一个**页面型
 * 标签页**：右侧栏「开始」页（宿主称 guide）多一张胶囊卡，点它就在该面板**新建
 * 一个标签页**显示同一份账本 —— 而不是像现在这样只能从 Jet Hub 页头开一个
 * 覆盖整屏的弹窗。
 *
 * ## 为什么是这条路，而不是 iframe / 自建浮层
 *
 * 右侧栏的引导页与标签页是宿主**一等公民的扩展位**，官方三个包走的就是它：
 *
 * | 官方包 | 用法 |
 * |---|---|
 * | `@deepseek-ai/dsh-client-ui-sidebar-browser` | `ctx.sidebarRightTabs.register({ id, kind, guide: [...] })` |
 * | `@deepseek-ai/dsh-experimental-session-inspector` | 同上 + `ctx.slots.inject('sidebar.right.pane.tab', …)` |
 * | `dsh-context`（第三方） | 同上，两处槽位成对注册 |
 *
 * 引导卡被点击时宿主自己执行 `tab.actions.openTab(kind, { replaceTab: true })`
 * 再关掉引导页 —— 也就是「就地换成新标签页」，正是我们要的交互。
 *
 * ## 三个必须成对的东西（缺一个就静默失效）
 *
 * 1. `sidebarRightTabs.register({ id, kind, guide })` —— 类型 + 那一张引导卡；
 * 2. `slots.inject('sidebar.right.pane.tab', …)` 且 **`key` 必须是 `definition.id`**
 *    （宿主按 `entryKey = definition.id` 精确查表；写 `kind` 会落空、标签页正文空白）；
 * 3. `package.json` 的 `dsh.client.inject` 里声明
 *    `@deepseek-ai/dsh-client-ui-sidebar-right` —— 只影响客户端模块**到达顺序**，
 *    老宿主找不到该行会静默跳过（不是硬依赖）。
 *
 * ⚠️ **`export const inject` 里不得加 `sidebarRightTabs`**：那是 cordis 的**硬**
 * 服务依赖，缺它的宿主上整条插件会**不激活**（连账号面板都没有）。故本项目用
 * `ctx.inject([...])` 做**软**注入：服务不在就整段跳过。
 *
 * ## 为什么 `order: 40`
 *
 * 宿主引导卡按 `order` 升序排。现有占用（实测本机 profile）：
 * 工作区文件 10 / 代码审查和变更 20 / 新建终端 20 / 上下文 20 / 浏览器 30 /
 * **（空档）** / 会话数据诊断 60。取 40 落在「浏览器」与「会话数据诊断」之间。
 *
 * @module plugin-src/client/ledger-tab.js
 */

import * as React from 'react';

/**
 * ⚠️ 用 `__tokenLedgerPanelForTest` 这个名字**不是笔误**：`jet-hub.js` 里的
 * `TokenLedgerPanel` 是模块内私有函数，唯一对外的符号就是那个「供测试渲染」的
 * 别名（与上游既有的 `__providersPanelForTest` / `__creditBalanceRowForTest`
 * 同一惯例）。本文件是它的**第二个生产调用方**。
 *
 * 为什么不新增一个正式导出名：那会多一条「同一个组件两个 export」的分叉面，
 * 而本仓库对这类分叉的判据是「删掉任一处会绿」（`__tokenLedgerPanelForTest`
 * 已被两份 spec 引用，`token-ledger-account-wiring.spec.ts` 直接 require 它）。
 * 复用同一个符号，比新增一个更难被静默改坏。
 */
import { __tokenLedgerPanelForTest as TokenLedgerPanel } from './jet-hub.js';
import { withErrorBoundary } from './error-boundary.js';

/**
 * 标签页类型 id —— **同时是** `sidebar.right.pane.tab` 槽位的 `key`。
 *
 * ⚠️ 与 `kind` 分开是两个值：`id` 是「哪个实现」（宿主按它查 keyed 槽），
 * `kind` 是「哪一类页面」（同一个 `kind` 可以有多个 id，比如编辑器的多种渲染器）。
 * 本功能只有一个实现，但**不能**因此把两者合并 —— 宿主两处 API 语义不同。
 */
export const LEDGER_TAB_ID = 'dsh-providers-hub/ledger';

/** 标签页类型 kind（页面种类；引导卡不靠它派发，但宿主必须能登记）。 */
export const LEDGER_TAB_KIND = 'jet-hub-ledger';

/** 引导卡在右侧栏「开始」页里的排序位（理由见文件头）。 */
export const LEDGER_TAB_ORDER = 40;

/**
 * 引导卡与标签页 chip 的文案。
 *
 * ⚠️ 两处**刻意不同**：引导卡是列表里的一整行（宽、可带描述），标签页 chip 是
 * 一条 14px + `nowrap` + `ellipsis` 的窄条（宿主 `.entryTitle` 的样式）。
 * 卡片写全名「JetHub 插件 Token 用量」，chip 写短名「Token 用量」才不会被截成
 * 「JetHub 插件 To…」。
 */
const GUIDE_TITLE = 'JetHub 插件 Token 用量';
const GUIDE_DESCRIPTION = '按渠道 / 供应商 / 账号 / 模型统计本机 token 消耗';
const TAB_TITLE = 'Token 用量';

/**
 * 标签页正文。
 *
 * ⚠️⚠️ **模块级常量，不要在注册回调里新建**：`withErrorBoundary` 每次都返回
 * **新的类**，写在回调里会让宿主每次渲染都拿到新组件类型 ⇒ React 把整棵子树
 * 卸载重挂 ⇒ 账本每次切换标签都重新拉一遍（本仓库 `panel-entry.js` 已记录过
 * 同款事故，并有一条行为级守卫盯着「两次渲染拿到同一个组件类型」）。
 */
const LedgerTabBody = withErrorBoundary(
  function LedgerTabBody({ rpcCall }) {
    // `rpcCall` 由下面 `slots.register` 的 `inject` 注入；拿不到就什么都不画
    // （老宿主 / 测试替身），绝不抛错 —— 抛错会被边界拦成一块报错文案，而
    // 「没有 rpcCall」不是用户能处理的事。
    if (typeof rpcCall !== 'function') return null;
    return React.createElement(TokenLedgerPanel, { rpcCall, chrome: 'pane' });
  },
  { label: 'Token 用量侧栏页' },
);

/**
 * 注册「Token 用量」右侧栏标签页。
 *
 * 注册与注销都交给 `ctx.inject` 的**返回函数**（服务消失 / 插件卸载时宿主调它），
 * 与本仓库 `panel-entry.js` 的 `ctx.inject(['layout'], …)` 同一条写法。
 *
 * ⚠️ **不**再在外面套一层 `ctx.effect`：那会让同一个 disposer 有两个持有者，
 * 关掉时被调两次（`SlotCore.register` 的 disposer 不保证幂等）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 客户端根上下文。
 * @param {(endpoint: string, payload?: unknown, signal?: AbortSignal) => Promise<unknown>} rpcCall
 *   Jet Hub 的管理 RPC 调用器（与面板入口共用同一份，绝不另建一条连接）。
 * @returns {(() => void) | undefined} 服务存活期的清理函数（交给 cordis / 宿主），
 *   环境不支持（无 `ctx.inject`）时为 `undefined`。
 */
export function registerJetHubLedgerTab(ctx, rpcCall) {
  /**
   * ⚠️ 替身 / 老宿主的**优雅跳过**：`ctx.inject` 在单测的最小替身里可能不存在
   * （`tests/unit/index-entry-wiring.spec.ts` 的 `makeCtx` 上游版本就只给了
   * `ctx.slots.inject`）。没有它时直接返回，而不是抛 `TypeError` —— 后者会被
   * 「接线断了」那条用例的 `apply()` 调用**掩盖成一条通用异常**，判据就失去意义。
   *
   * ⚠️ 但**不能**因此放弃在真宿主上的注册：`ctx.inject` 在真 cordis 上恒存在
   * （`ctx.slots.inject` 也是它的兄弟方法），故这条早退在真机上永不触发。
   */
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') return undefined;

  return ctx.inject(['sidebarRightTabs'], (scoped) => {
    const registry = scoped?.sidebarRightTabs;
    if (registry === undefined || registry === null || typeof registry.register !== 'function') return;

    /** 已取得的注销函数（逆序回收）。 */
    const stops = [];

    stops.push(registry.register({
      id: LEDGER_TAB_ID,
      kind: LEDGER_TAB_KIND,
      /**
       * `extension` 而非 `builtin`：本插件是第三方，`builtin` 是宿主自带类型的带宽。
       * 同带宽的两个类型撞 `kind` 时会直接抛错，`extension` 才是正常入口。
       */
      priority: 'extension',
      /**
       * 切走再切回**不重新挂载** —— 账本读取是异步的（`usage.tokenLedger` +
       * `usage.tokenLedgerHistory` 两发），不保活会让每次切标签都白拉一遍，
       * 用户还会看到一瞬「正在读取 Token 用量…」。
       */
      keepMounted: true,
      title: () => TAB_TITLE,
      guide: [{
        id: 'open',
        order: LEDGER_TAB_ORDER,
        title: () => GUIDE_TITLE,
        description: () => GUIDE_DESCRIPTION,
      }],
    }));

    stops.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      // ⚠️ 必须是 `definition.id`（`LEDGER_TAB_ID`），不是 `kind` —— 见文件头第 2 条。
      key: LEDGER_TAB_ID,
      inject: () => ({ rpcCall }),
    }, LedgerTabBody)));

    return () => {
      for (const stop of stops.reverse()) {
        if (typeof stop === 'function') stop();
      }
    };
  });
}
