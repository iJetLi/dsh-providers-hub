/**
 * 豆包（Doubao）登录弹窗 —— **粘贴浏览器 Cookie 导入账号**（2026-11-26）。
 *
 * ## 为什么只剩这一条路
 *
 * 原来的「面板内扫码」（宿主调 passport 取码 + 轮询）已于 2026-11-26 整条删除：
 * 豆包 passport 在**扫码之后**强制要求账号 SDK 现场算的 `sign` / `qs` / `a_bogus`
 * （三者强绑定当次请求的 query），纯 HTTP 造不出来，必然卡在
 * `error_code=2156 服务繁忙`；把浏览器抓到的原始签名抄过来也不认。
 *
 * ⇒ 登录态改为「用户在自己浏览器里登录一次，把 Cookie 头贴进来」。这条路径
 * **不经过扫码换取环节**，因此不受那套签名强校验影响，也不需要机器上装浏览器。
 *
 * ## 三条纪律
 *
 * 1. **纯展示组件**：不调 RPC。副作用（导入 / 关闭）全在 `jet-hub.js`
 *    （与 `marvis-login-modal.js` 同因：单测能用最小 React 替身真渲染它）；
 * 2. **粘贴格式全交给宿主归一**（裸串 / `Cookie:` 前缀 / 整段 cURL 都认，
 *    见 `src/doubao-cookie.ts`）⇒ 这里**不做**任何格式校验，只判空；
 * 3. **必须写清 sessionid 从哪来**：`document.cookie` 读不到它（HttpOnly），
 *    只有 Network 面板的 Cookie 请求头 / Copy as cURL 才有 —— 不写清用户会
 *    复制一段不含 sessionid 的串，导入后账号立刻失效，还以为是插件坏了。
 *
 * @module plugin-src/client/doubao-cookie-modal.js
 */

import React from 'react'

/**
 * @param {object} props
 * @param {() => void} [props.onClose] 取消（只关弹窗，不产生账号）
 * @param {(cookieText: string) => void} [props.onImportCookie] 粘贴 cookie 导入
 * @param {boolean} [props.importing] 正在导入（禁用按钮）
 * @param {string} [props.importError] 导入失败文案
 */
export function DoubaoCookieModal({ onClose, onImportCookie, importing, importError }) {
  const [cookieText, setCookieText] = React.useState('')
  const ready = cookieText.trim().length > 0 && !importing

  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget && !importing && onClose) onClose() },
  },
  React.createElement('div', {
    className: 'dim-jh-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '粘贴 Cookie 登录豆包',
    style: { maxWidth: '440px' },
  },
  React.createElement('div', { className: 'dim-jh-modalHead' },
    React.createElement('div', { className: 'dim-jh-modalTitle' }, '粘贴 Cookie 登录豆包'),
  ),
  React.createElement('div', { className: 'dim-jh-modalBody', style: { textAlign: 'left' } },
    React.createElement('p', { className: 'dim-jh-modalHint' },
      '豆包扫码登录已移除（扫码后上游强制要求现场签名，纯 HTTP 无法完成）。请改用 Cookie 导入：'),
    React.createElement('ol', { className: 'dim-jh-modalHint', style: { paddingLeft: '18px', margin: '6px 0 0' } },
      React.createElement('li', null, '在电脑浏览器打开 www.doubao.com 并完成登录（手机 App 扫码也行，只要在电脑上登录成功）。'),
      React.createElement('li', null, '按 F12 打开开发者工具 → 切到「网络 / Network」→ 刷新页面 → 点任意一条 doubao.com 请求，在「请求标头」里找到 Cookie，整段复制。'),
      React.createElement('li', null, '（更省事：右键该请求 → Copy as cURL，把整段 cURL 直接贴进来也可以。）'),
      React.createElement('li', null, '把复制内容粘贴到下面，点「导入账号」。'),
    ),
    React.createElement('p', { className: 'dim-jh-modalHint', style: { marginTop: '8px' } },
      '⚠️ 注意：在控制台执行 document.cookie 读不到 sessionid（它是 HttpOnly），必须从 Network 的 Cookie 请求头复制。'),
    React.createElement('textarea', {
      value: cookieText,
      onChange: (e) => setCookieText(e.target.value),
      rows: 6,
      placeholder: 'sessionid=…; ttwid=…  （也可直接粘贴 Cookie: 开头的整段，或整段 cURL）',
      style: {
        width: '100%',
        boxSizing: 'border-box',
        marginTop: '8px',
        fontFamily: 'monospace',
        fontSize: '12px',
        resize: 'vertical',
      },
    }),
    importError
      ? React.createElement('p', { className: 'dim-jh-error', role: 'alert' }, importError)
      : null,
  ),
  React.createElement('div', { className: 'dim-jh-modalActions' },
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn dim-jh-btnPrimary',
      disabled: !ready,
      onClick: () => { if (ready && onImportCookie) onImportCookie(cookieText.trim()) },
    }, importing ? '导入中…' : '导入账号'),
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn',
      disabled: !!importing,
      onClick: () => { if (onClose) onClose() },
    }, '取消'),
  )))
}

export default DoubaoCookieModal
