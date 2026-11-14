/**
 * Qoder 账号的「网页会话」弹窗：粘贴官网登录 Cookie，用来读「资源包」逐笔到期。
 *
 * 背景：`/sash/api/v2/me/usage` 只给资源包的聚合数，逐笔到期只在官网「用量明细」
 * 页的接口里，而那个接口只认浏览器登录 Cookie（OAuth 令牌一律 401）。
 * 没配会话时，面板退回用本地领取记录推算；两者都没有才显示「到期未知」。
 *
 * ⚠️ Cookie 能登录官网：输入框用 password 类型，保存后宿主只回「已保存」，
 *    绝不回显原文；宿主在保存前会先用它真查一次，粘错或过期当场报错。
 */
import * as React from 'react'

export function QoderWebSessionModal({ ctx, accountId, provider, hasSession, onClose }) {
  const isCn = provider === 'qodercn'
  const site = isCn ? 'qoder.com.cn' : 'qoder.com'
  const [cookie, setCookie] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  const close = (changed) => { if (onClose) onClose(Boolean(changed)) }

  const save = async (value) => {
    setBusy(true)
    setError('')
    try {
      await ctx.rpc({ method: 'qoder.setWebSession', payload: { accountId, cookie: value } })
      close(true)
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget) close(false) },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      style: { maxWidth: '560px' },
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' },
          isCn ? 'Qoder（中国版）网页会话' : 'Qoder 网页会话'),
        React.createElement('span', { className: 'dim-jh-modalSubtitle' },
          hasSession ? '当前：已保存' : '当前：未设置'),
      ),
      React.createElement('p', { className: 'dim-jh-modalHint' },
        '用于读取「资源包」每一笔的到期日（官网「用量明细」页的数据）。'
          + '登录接口拿到的令牌读不到这份明细，只能用网页登录 Cookie。'
          + '不设置时按本面板的领取记录推算到期日。'),
      React.createElement('ol', { className: 'dim-jh-hint', style: { paddingLeft: '1.2em', margin: '0 0 8px' } },
        React.createElement('li', null, `用浏览器登录 https://${site}/account/usage（必须是这张卡片对应的账号）`),
        React.createElement('li', null, '按 F12 打开开发者工具 →「网络」，刷新页面，点开 big_model_credits 这条请求'),
        React.createElement('li', null, '在「请求标头」里复制 Cookie 的值（或右键该请求「复制为 cURL」），粘贴到下面'),
      ),
      React.createElement('div', { className: 'dim-jh-modalBody' },
        React.createElement('textarea', {
          className: 'dim-jh-input',
          rows: 4,
          placeholder: '粘贴 Cookie，或整段 cURL',
          value: cookie,
          spellCheck: false,
          autoComplete: 'off',
          style: { width: '100%', fontFamily: 'monospace', WebkitTextSecurity: 'disc' },
          onChange: (e) => { setCookie(e.target.value); setError('') },
        }),
        React.createElement('p', { className: 'dim-jh-hint' },
          'Cookie 只保存在本面板的凭据库里、不会显示出来；它等同于官网登录状态，失效后需要重新粘贴。'),
        error && React.createElement('p', { className: 'dim-jh-error' }, error),
      ),
      React.createElement('div', { className: 'dim-jh-modalActions' },
        hasSession ? React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: busy,
          onClick: () => save(''),
        }, '清除会话') : null,
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn dim-jh-btnPrimary',
          disabled: busy || cookie.trim().length === 0,
          onClick: () => save(cookie),
        }, busy ? '校验中…' : '校验并保存'),
        React.createElement('button', { type: 'button', className: 'dim-jh-btn', onClick: () => close(false) }, '取消'),
      ),
    ),
  )
}
