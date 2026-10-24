/**
 * 侧栏入口的**渲染与注册**（React 组件 + 槽注册）。
 *
 * 偏好状态与读写在同目录的 `sidebar-entry-store.js`（无 React 依赖，避免循环
 * import —— 页头开关在 `jet-hub.js` 里也要用同一份状态）。
 *
 * ## 为什么不放在设置里就够了
 *
 * Jet Hub 的主体是一整页（左边供应商列表，右边账号管理，外加备份/网关/用量
 * 这些页签）。塞在设置弹层里会被挤窄，而且每次都要「打开设置 → 找到插件页」。
 * 挂成主导航的一行之后：
 *
 * - 点侧栏那一行，宿主 `layout.selectPanel('jet-hub')` 命中本模块注册的
 *   `main` key，Jet Hub 页**原样**渲染进中央面板（React 组件，不是 iframe，
 *   主题 token 与语言都能继承）；
 * - 设置里的入口（`settings.section#jet-hub`）**保持不动** —— 两条路径渲染的是
 *   同一个 `JetHubPage` 组件、同一份 `rpcCall`，不存在两套实现。
 *
 * ## 启动顺序
 *
 * 宿主偏好是异步读的，所以侧栏行**等这一读回来再注册**（读失败按「显示」
 * 兜底）—— 反过来先注册再撤销，会让关闭了入口的用户每次启动都闪一下那一行。
 *
 * ## 关掉入口时的收尾
 *
 * 如果面板正停在 Jet Hub 上，要主动 `selectPanel(null)`，否则布局里会留着
 * 一个再也没有入口的 `activePanelId`（宿主的「返回会话」按钮会指向它）。
 */

import * as React from 'react';

import { JetHubPage } from './jet-hub.js';
// ⚠️ 与设置页同因（2026-10-22 整页白屏）：中央面板的渲染期异常同样会卸载
//    整棵树。入口不同、组件同一个，故用同一个边界工厂、只换 label。
import { withErrorBoundary } from './error-boundary.js';

/**
 * `main` 槽里渲染的 `JetHubPage`。
 *
 * ⚠️ 模块级常量而不是每次 render 新建：组件身份必须稳定，否则槽位每次重渲染
 * 都会换一个组件类型，React 会把整棵子树卸载重挂（状态全丢）。
 */
const JetHubPageGuarded = withErrorBoundary(JetHubPage, { label: 'Jet Hub 面板' });
import {
  JET_HUB_PANEL_KEY,
  JET_HUB_SIDEBAR_ORDER,
  loadSidebarEntry,
  sidebarEntryVisible,
  subscribeSidebarEntry,
} from './sidebar-entry-store.js';

/**
 * 侧栏行的图标：六边形环 + 中心点。
 *
 * ⚠️ 只用纯 SVG 与 `currentColor`：宿主那一行是原生按钮，图标必须跟着主题色走，
 * 也不能依赖任何 UI 包（客户端模块不允许 require 宿主组件包）。
 *
 * ⚠️ 第一版画的是「五个圆点 + 辐条」，被用户当成「新建会话」的加号 —— 换成
 * 这个闭合六边形之后辨识度才够。
 *
 * @param {{ size?: number }} props 宿主传入的行高（缺省 16）
 */
export function JetHubSidebarIcon({ size }) {
  const px = typeof size === 'number' && size > 0 ? size : 16;
  return React.createElement(
    'svg',
    {
      width: px,
      height: px,
      viewBox: '0 0 16 16',
      fill: 'none',
      xmlns: 'http://www.w3.org/2000/svg',
      'aria-hidden': 'true',
    },
    React.createElement('path', {
      d: 'M8 1.7 13.5 4.85v6.3L8 14.3 2.5 11.15v-6.3z',
      stroke: 'currentColor',
      strokeWidth: 1.35,
      strokeLinejoin: 'round',
    }),
    React.createElement('circle', { cx: 8, cy: 8, r: 1.7, fill: 'currentColor' }),
  );
}

/**
 * 「侧栏」面板本体：Jet Hub 页 + 一圈内边距。
 *
 * 设置页的宿主自己给了 `padding: 0 24px 24px`（`SettingsRoot`），而 `main` 槽的
 * 宿主（中央面板）只负责顶部那条 28px 的标题带、左右下**不留白** —— 所以这里
 * 补左右下三边，并叠上宿主的顶部清障变量（`--dsh-frame-top-clearance`）。
 * 与插件市场页同款做法，只是市场页里各自的大块另有内边距。
 *
 * @param {{ rpcCall?: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> }} props
 */
export function JetHubMainPanel({ rpcCall }) {
  if (typeof rpcCall !== 'function') return null;
  return React.createElement(
    'div',
    { className: 'dim-jh-panelHost', 'data-plugin': 'dsh-providers-hub' },
    React.createElement(JetHubPageGuarded, { rpcCall }),
  );
}

/**
 * 注册 Jet Hub 的「侧栏行 + 主面板」，并让页头开关与宿主偏好保持同步。
 *
 * 调用点：`plugin-src/client/index.js` 的 `apply()`，与 `settings.section` 的注册
 * 并列（**不要**再包一层 `ctx.effect` —— 槽注册本身就是可撤销的，多包一层
 * 只会在热替换时留下双份注册）。
 *
 * @param {any} ctx 客户端插件上下文（需要 `slots` 与可选的 `layout`）
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} rpcCall
 */
export function registerJetHubSidebarEntry(ctx, rpcCall) {
  // `main` key 无条件注册：入口关掉之后用户仍可能从设置页开过面板，少了这个 key
  // 宿主 `layout.selectPanel('jet-hub')` 会抛「未注册的 panel」。
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: JET_HUB_PANEL_KEY,
    inject: () => ({ rpcCall }),
  }, JetHubMainPanel));

  // 布局服务只用于「入口被关掉时撤销选中」。它不在本插件的 inject 声明里（那是
  // 硬依赖，缺了整条插件都不激活），所以用 ctx.inject 拿作用域副本；拿不到就跳过。
  let layout;
  ctx.inject(['layout'], (scoped) => {
    layout = scoped.layout;
    return () => {
      layout = undefined;
    };
  });

  /** 当前面板若是 Jet Hub，就撤销选中。 */
  const deselectIfActive = () => {
    try {
      if (layout?.panelInfo?.getSnapshot?.()?.activePanelId !== JET_HUB_PANEL_KEY) return;
      layout.selectPanel(null);
    } catch (caught) {
      console.warn('[jet-hub] 撤销侧栏入口时取消选中失败', caught);
    }
  };

  ctx.slots.inject('sidebar.panellist', () => {
    /** 当前侧栏行的 disposer；`undefined` = 还没注册（或已撤销）。 */
    let stopRow;

    /**
     * 按目标状态增删侧栏行。**幂等**：订阅回调与首次读值可能各来一次，
     * 重复调用不会重复注册。
     *
     * @param {boolean} visible
     */
    const sync = (visible) => {
      if (visible && stopRow === undefined) {
        stopRow = ctx.slots.register({
          name: 'sidebar.panellist',
          id: JET_HUB_PANEL_KEY,
          order: JET_HUB_SIDEBAR_ORDER,
          label: () => 'Jet Hub',
        }, JetHubSidebarIcon);
        return;
      }
      if (!visible && stopRow !== undefined) {
        const stop = stopRow;
        stopRow = undefined;
        stop();
        deselectIfActive();
      }
    };

    const unsubscribe = subscribeSidebarEntry(() => sync(sidebarEntryVisible()));
    // 启动时先等一次宿主读值：`enabled === null` 期间**不注册**（见文件头「启动顺序」）。
    void loadSidebarEntry(rpcCall).then(sync);
    return () => {
      unsubscribe();
      if (stopRow !== undefined) {
        const stop = stopRow;
        stopRow = undefined;
        stop();
      }
    };
  });
}
