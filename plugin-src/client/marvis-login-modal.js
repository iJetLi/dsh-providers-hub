/**
 * 腾讯 Marvis 的登录弹窗（**纯展示组件**，判定与副作用都在 `jet-hub.js`）。
 *
 * ## 为什么需要独立弹窗
 *
 * Marvis 的凭据**只能**由两条 OAuth 授权链之一产出（QQ / 微信），且 `login_type`
 * 的码值（`'1'` / `'2'`）**事后无法从凭据反推** —— 两条链的授权页域名、AppID
 * 与设备绑定都不同。⇒ 必须在登录前让用户选一条，正是 `new-account.js` 里
 * 「需要预选的 provider」的判据（该文件第 5 条）。
 *
 * 另有一条**无门槛**的旁路：「从 magpie 导入」—— 用户本机已经装了 magpie
 * 且登录过 Marvis 时，宿主会**自己**去读 `~/.config/magpie/plugin-auth.json`
 * 里的 `marvis` 那一条，省掉一次 OAuth。它与两条 OAuth 链并列，不是替代。
 *
 * ⚠️ 2026-11-09 用户报障：这一格原先是「textarea + 手动粘贴」。可那个文件就在
 * **本机**、而且是**插件自己**能读的位置 —— 让用户去找文件、精确复制一段 JSON
 * （漏一个括号就被判成「凭据不完整」）没有任何理由。现改为一个按钮，文件读取
 * 交给宿主的 `MarvisAuth.readMagpieCredential()`（它负责给「文件不存在 / 没有
 * marvis 条目 / 条目缺字段」三种情况各一句可读文案）。
 *
 * ## ⚠️ 为什么本组件不自己调 RPC
 *
 * 与 `MagicrewImportModal` / `BaizhiLoginModal` 同款：组件只接回调，
 * 副作用（`account.create` + `startLoginPoll` + in-flight 闸门）全在 `jet-hub.js`
 * 的 `submitMarvisLogin` / `submitMarvisMagpieImport` 里。这样
 * `marvis-client-panel.spec.ts` 能用最小 React 替身**真渲染**本组件并断言
 * 「三个按钮各自只调自己那个回调」—— 若把 RPC 写进来，单测就得连宿主一起起。
 */

import React from 'react'

/**
 * @param {object} props
 * @param {string} [props.error] 失败文案（留在弹窗内，不把整个账号列表切成错误态）
 * @param {boolean} [props.busy] 是否有登录在跑（三个入口共用，防止并发建号）
 * @param {() => void} [props.onQq] 用 QQ 登录
 * @param {() => void} [props.onWechat] 用微信登录
 * @param {() => void} [props.onImport] 从本机 magpie 的凭据文件导入（读取在宿主侧）
 * @param {() => void} [props.onClose] 关闭
 */
export function MarvisLoginModal({ error, busy, onQq, onWechat, onImport, onClose }) {
  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget && !busy && onClose) onClose() },
  },
  React.createElement('div', {
    className: 'dim-jh-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '登录腾讯 Marvis',
    style: { maxWidth: '520px' },
  },
  React.createElement('div', { className: 'dim-jh-modalHead' },
    React.createElement('div', { className: 'dim-jh-modalTitle' }, '登录腾讯 Marvis'),
  ),
  React.createElement('div', { className: 'dim-jh-modalBody' },
    React.createElement('p', { className: 'dim-jh-modalHint' },
      // ⚠️ 纯文本（不走 markdown 渲染），不要写 `**强调**`。
      '点「QQ 登录」或「微信登录」后，插件会另开一个干净的浏览器窗口；'
      + '你在里面完成授权即可，不需要复制任何 token。'),
    React.createElement('p', { className: 'dim-jh-modalHint' },
      '本机已安装 magpie 且登录过 Marvis 时，点「从 magpie 导入」即可 —— '
      + '插件会自己读取 ~/.config/magpie/plugin-auth.json，不需要你找文件或复制内容。'),
    error
      ? React.createElement('p', { className: 'dim-jh-error', role: 'alert' }, error)
      : null,
  ),
  React.createElement('div', { className: 'dim-jh-modalActions' },
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn dim-jh-btnPrimary',
      disabled: !!busy,
      onClick: () => { if (onQq) onQq() },
    }, busy ? '处理中…' : 'QQ 登录'),
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn',
      // ⚠️ 三个入口共用 `busy`：每条腿都会建账号，同时跑会让池里多出两个
      //    指向同一个上游号的条目（与 MagicrewImportModal 同因）。
      disabled: !!busy,
      onClick: () => { if (onWechat) onWechat() },
    }, '微信登录'),
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn',
      disabled: !!busy,
      onClick: () => { if (onImport) onImport() },
    }, '从 magpie 导入'),
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn',
      disabled: !!busy,
      onClick: () => { if (onClose) onClose() },
    }, '取消'),
  )))
}

export default MarvisLoginModal
