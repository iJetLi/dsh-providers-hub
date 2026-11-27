/**
 * 「添加 / 更新 Today (国内版 / 国际版) 账号」弹窗。
 *
 * 两站共用同一个组件，由 `provider` 区分站点与能力：
 * - `today`（国内版 `https://todayai.cn`）：粘贴浏览器 Cookie（上游已停用邮箱 OTP）
 * - `todayintl`（国际版 `https://today.ai`）：支持粘贴浏览器 Cookie 或邮箱 OTP 登录
 */

import * as React from 'react'

/**
 * Today 账号登录 / 更新 Cookie 弹窗组件。
 *
 * @param {{
 *   provider: string,
 *   editing?: boolean,
 *   busy?: boolean,
 *   error?: string,
 *   onSubmitCookie?: (cookieText: string) => void,
 *   onSendOtp?: (email: string) => Promise<void>,
 *   onVerifyOtp?: (email: string, otp: string) => void,
 *   onClose?: () => void,
 *   onDismissError?: () => void,
 * }} props
 */
export function TodayCookieModal({
  provider,
  editing,
  busy,
  error,
  onSubmitCookie,
  onSendOtp,
  onVerifyOtp,
  onClose,
  onDismissError,
}) {
  const isIntl = provider === 'todayintl'
  const siteUrl = isIntl ? 'https://today.ai' : 'https://todayai.cn'
  const siteLabel = isIntl ? 'Today (国际版)' : 'Today (国内版)'

  const [mode, setMode] = React.useState('cookie')
  const [cookieText, setCookieText] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [otp, setOtp] = React.useState('')
  const [otpSent, setOtpSent] = React.useState(false)
  const [sendingOtp, setSendingOtp] = React.useState(false)

  const showOtpTab = isIntl && !editing

  const submitCookie = () => {
    const trimmed = cookieText.trim()
    if (trimmed.length === 0 || busy) return
    if (onSubmitCookie) onSubmitCookie(trimmed)
  }

  const handleSendOtp = async () => {
    if (!onSendOtp || sendingOtp || busy) return
    const trimmedEmail = email.trim()
    if (trimmedEmail.length === 0) return
    setSendingOtp(true)
    try {
      await onSendOtp(trimmedEmail)
      setOtpSent(true)
    } finally {
      setSendingOtp(false)
    }
  }

  const submitOtp = () => {
    if (!onVerifyOtp || busy) return
    const trimmedEmail = email.trim()
    const trimmedOtp = otp.trim()
    if (trimmedEmail.length === 0 || trimmedOtp.length === 0) return
    onVerifyOtp(trimmedEmail, trimmedOtp)
  }

  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget && !busy && !sendingOtp && onClose) onClose() },
  },
  React.createElement('div', {
    className: 'dim-jh-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': (editing ? '更新 ' : '添加 ') + siteLabel + ' 账号',
    style: { maxWidth: '500px' },
  },
  React.createElement('div', { className: 'dim-jh-modalHead' },
    React.createElement('div', { className: 'dim-jh-modalTitle' },
      (editing ? '更新 Cookie · ' : '登录 ') + siteLabel),
  ),
  React.createElement('div', { className: 'dim-jh-modalBody', style: { textAlign: 'left' } },
    showOtpTab ? React.createElement('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } },
      React.createElement('button', {
        type: 'button',
        className: 'dim-jh-btn' + (mode === 'cookie' ? ' dim-jh-btnPrimary' : ''),
        disabled: busy || sendingOtp,
        onClick: () => {
          setMode('cookie')
          if (error && onDismissError) onDismissError()
        },
      }, '粘贴 Cookie（推荐）'),
      React.createElement('button', {
        type: 'button',
        className: 'dim-jh-btn' + (mode === 'otp' ? ' dim-jh-btnPrimary' : ''),
        disabled: busy || sendingOtp,
        onClick: () => {
          setMode('otp')
          if (error && onDismissError) onDismissError()
        },
      }, '邮箱验证码'),
    ) : null,
    mode === 'cookie' || !showOtpTab
      ? React.createElement(React.Fragment, null,
        React.createElement('p', { className: 'dim-jh-modalHint' },
          editing
            ? '请重新在浏览器登录 ' + siteUrl + '，将最新的 __Secure-better-auth.session_token 或 Cookie 头粘贴到下方：'
            : '请先在浏览器登录 ' + siteUrl + '，按 F12 → Application → Cookies，复制 __Secure-better-auth.session_token 的值（也支持整段 Cookie: 头或 Copy as cURL / fetch）：'),
        !isIntl && !editing
          ? React.createElement('p', { className: 'dim-jh-hint', style: { marginTop: '4px' } },
            '提示：国内版 todayai.cn 已停用邮箱验证码登录，请使用粘贴 Cookie；且国内版与国际版 Cookie 互不通用。')
          : null,
        React.createElement('textarea', {
          value: cookieText,
          rows: 5,
          autoFocus: true,
          placeholder: '__Secure-better-auth.session_token=…（或直接粘贴值 / Cookie: … / Copy as cURL）',
          onChange: (e) => {
            setCookieText(e.target.value)
            if (error && onDismissError) onDismissError()
          },
          style: {
            width: '100%',
            boxSizing: 'border-box',
            marginTop: '8px',
            fontFamily: 'monospace',
            fontSize: '12px',
            resize: 'vertical',
          },
        }),
      )
      : React.createElement('div', { className: 'dim-jh-formRows' },
        React.createElement('p', { className: 'dim-jh-modalHint' },
          '输入 ' + siteUrl + ' 注册邮箱，点击发送验证码后填入收到的 OTP 验证码：'),
        React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          React.createElement('input', {
            type: 'email',
            className: 'dim-jh-input',
            value: email,
            // ⚠️ 不要写成 `<local>@<domain>` 形态 —— `repo-pii-guard` 会把任何邮箱形态
            //    判成真实账号（本仓没有「纯示例邮箱」这一说，2026-11-27 实测被拦）。
            placeholder: '请输入邮箱地址',
            autoFocus: true,
            style: { flex: 1 },
            onChange: (e) => {
              setEmail(e.target.value)
              if (error && onDismissError) onDismissError()
            },
          }),
          React.createElement('button', {
            type: 'button',
            className: 'dim-jh-btn',
            disabled: sendingOtp || busy || email.trim().length === 0,
            onClick: () => void handleSendOtp(),
          }, sendingOtp ? '发送中…' : (otpSent ? '重新发送' : '发送验证码')),
        ),
        otpSent
          ? React.createElement('p', { className: 'dim-jh-hint' }, '验证码已发送，请查收邮件。')
          : null,
        React.createElement('input', {
          type: 'text',
          className: 'dim-jh-input',
          value: otp,
          placeholder: '邮箱验证码（OTP）',
          onChange: (e) => {
            setOtp(e.target.value)
            if (error && onDismissError) onDismissError()
          },
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitOtp()
            }
          },
        }),
      ),
    error
      ? React.createElement('p', { className: 'dim-jh-error', role: 'alert' }, error)
      : null,
  ),
  React.createElement('div', { className: 'dim-jh-modalActions' },
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn dim-jh-btnPrimary',
      disabled: busy || sendingOtp || (mode === 'otp' && showOtpTab
        ? (email.trim().length === 0 || otp.trim().length === 0)
        : cookieText.trim().length === 0),
      onClick: () => {
        if (mode === 'otp' && showOtpTab) submitOtp()
        else submitCookie()
      },
    }, busy ? (editing ? '更新中…' : '验证中…') : (editing ? '更新' : '确定')),
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn',
      disabled: !!busy || !!sendingOtp,
      onClick: () => { if (onClose) onClose() },
    }, '取消'),
  )))
}

export default TodayCookieModal
