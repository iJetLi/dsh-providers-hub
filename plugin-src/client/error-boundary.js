/**
 * 面板级错误边界（2026-10-22 整页白屏事故的结构性补强）。
 *
 * ## 为什么必须有这一层
 *
 * 那次事故的**直接**原因是 `probeNotice` 被写成裸字符串，渲染端读
 * `.details.length` 抛 `TypeError`（源头已修，见 `notice-shape.js`）。
 *
 * 但用户的**症状描述**比「提示文案不对」严重得多：
 *
 * > 「魔塔社区的令牌我一保存，页面直接清空，切换页面无效，只能重启 dsh」
 *
 * 「页面清空 + 切页无效 + 只能重启」不是那个 TypeError 造成的 —— 是**没有错误
 * 边界**造成的：React 18 的默认行为是「渲染期抛错 ⇒ 卸载整棵树」。本插件的
 * `settings.section` 直接注册 `JetHubPage`，于是任何一个渲染期异常都会让
 * **整个设置页（连同侧栏）**消失，用户除了重启没有别的出路。
 *
 * ⇒ 两件事必须分开修：
 * 1. **那个 TypeError 的源头**（`notice-shape.js` + 两处调用点）—— 让它不再发生；
 * 2. **错误的影响半径**（本文件）—— 让将来任何一次同类失误只坏掉这一个面板。
 *
 * ⚠️ 第 2 条**不能**被用来解释「所以第 1 条可以不做」：边界只是止损，
 * 它会让 bug **更难发现**（用户看到一块报错而不是崩溃），不是修复。
 *
 * ## 为什么是 class 而不是 hook
 *
 * React 至今没有函数组件版的错误捕获 API（`componentDidCatch` /
 * `getDerivedStateFromError` 只在 class 上）。这不是风格选择。
 *
 * ## 为什么 fallback 里要显示错误原文
 *
 * 只显示「出错了」等于把这次事故的可诊断性再降一级 —— 用户当时连一句报错都
 * 没看到。这里把 `error.message` 原样露出（它是**渲染期异常消息**，不是凭据：
 * 本插件的凭据从不下发到客户端，见 `jet-hub-rpc.ts` 的 `enrichAccountIdentity`），
 * 用户截个图就能定位。
 *
 * @module plugin-src/client/error-boundary.js
 */
import * as React from 'react';

/**
 * 包一层错误边界，返回可注册到槽位的组件。
 *
 * @template {object} P
 * @param {React.ComponentType<P>} Inner 被保护的组件。
 * @param {{ label?: string }} [options] `label` 用于 fallback 文案（标明是哪块坏了）。
 * @returns {React.ComponentType<P>}
 */
export function withErrorBoundary(Inner, options = {}) {
  const label = typeof options.label === 'string' && options.label.length > 0
    ? options.label
    : '这个面板';

  class PanelErrorBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
      return { error };
    }

    componentDidCatch(error, info) {
      // ⚠️ 只打日志，不向上抛：向上抛会让宿主再卸一次树，边界就白加了。
      //    `componentStack` 是定位「哪个组件」的唯一线索。
      console.error(`[jet-hub] ${label}渲染失败，已拦住（页面其余部分继续可用）：`, error, info?.componentStack);
    }

    render() {
      const error = this.state.error;
      if (error === null) return React.createElement(Inner, this.props);
      const message = error && typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : String(error);
      return React.createElement('div', {
        className: 'dim-jh-probeNotice',
        'data-tone': 'error',
        role: 'alert',
        style: { margin: '16px' },
      },
        React.createElement('div', null, `${label}渲染失败，已拦住 —— 其余页面仍可正常使用，不必重启。`),
        React.createElement('div', { style: { marginTop: '6px', fontFamily: 'monospace', fontSize: '12px' } }, message),
        React.createElement('div', { style: { marginTop: '6px' } },
          '这是插件的缺陷，不是你操作错了。把上面这行报错连同「当时点了什么」一起反馈即可。'));
    }
  }

  PanelErrorBoundary.displayName = `withErrorBoundary(${Inner.displayName || Inner.name || 'Component'})`;
  return PanelErrorBoundary;
}
