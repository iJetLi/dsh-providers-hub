/**
 * 「手动填写 MonkeyCode 账号凭据」弹窗（国内站 / 国际站共用，按 `provider` 分派）。
 *
 * ## ⚠️ 2026-11-02 审查 🔴：本弹窗曾残留「拆分前」的双通道 UI
 *
 * 原来它写着「以 `sk-` 开头走白泽直连，以 `oma_` 开头走网关」，还按前缀推
 * `channel`、按通道切换 `signing_secret` 提示，并把 `CONSOLE_URL` 写死
 * `https://monkeycode-ai.com`。**这些全部过时了**：
 *
 * - 拆站（m02506）后白泽是**独立 provider `baizhi`**（自己的弹窗、自己的 host）
 *   ⇒ MonkeyCode 这里**只有一条通道**：`oma_…` + `signing_secret` + 会话 cookie。
 * - 宿主侧 `src/monkeycode-rpc.ts` 的 `buildCredential` 早已不写 `channel`，
 *   `src/types.ts` 的 `monkeycodeChannel` 也已删除。
 * - 写死国内站域名对**国际站**是错的：两站凭据不通用（国际站的 cookie 打国内站
 *   回 401）⇒ 国际站用户会被指去 `.com` 生 Key，建出每次 401 的账号。
 *
 * ⇒ 现在：`provider` 是必填 prop，站点名与域名都从它派生。
 *
 * ## ⚠️ 本弹窗是**备用入口**（用户 2026-11-02 纠正）
 *
 * 「新建账号」的主路径是**浏览器登录**（`MonkeycodeLoginModal` →
 * `account.create { mode: 'browser' }`）：插件自己开窗、用户在里面登一次，
 * 插件用浏览器级 CDP 读 `monkeycode_ai_session`（HttpOnly，`document.cookie`
 * 根本读不到）并自动换 `oma_…` + `signing_secret`。
 *
 * 本弹窗只用于「用户手里已经有 Key」。**不要**把它改回主入口 —— 让用户手抄
 * HttpOnly cookie 正是被判为「跟插件根本不搭」的做法。
 *
 * ## ⚠️⚠️ 必须是组件、不能当普通函数直接调用
 *
 * 本组件内部有 `useRef`。若在 ProviderPanel 的渲染过程中**直接函数调用**，它的
 * hook 会被算进 ProviderPanel —— 「弹窗开」与「弹窗关」两次渲染的 hook 数量不同，
 * React 抛 #310（"Rendered more hooks than during the previous render"），
 * **整个设置页白屏**。与 `OpencodeProxyModal` / `QiniuKeyModal` 上方记录的事故同型。
 *
 * ## 为什么输入框内容不进 React state
 *
 * 三个字段都是凭据 / 会话令牌。放进 `useState` 会让它们随每次父组件重渲染经过
 * 整棵组件树，也可能被 devtools 的组件树检查器读到。故用 `ref` + DOM 读值。
 * 只有**错误信息**由父组件放进 state 传下来。
 *
 * ⚠️ **不要把这个 JSDoc 的 `@param` 留在模块头里**：客户端有一道
 * `tsc --checkJs` 的未声明变量闸，模块头没有宿主函数时 tsc 会把 `@param props {…}`
 * 里的名字当成类型名去解析并报 `TS2552`，而那道闸的失败文案是「会崩掉整个设置页」，
 * 排障方向会被完全带偏。`@param` 一律贴在**函数自己的** JSDoc 上。
 */

// ⚠️ 必须用**命名空间导入**（与 jet-hub.js 逐字一致）：`react` 在 esbuild
// 配置里是 external，默认导入 `import React from 'react'` 在 CJS 产物里
// 会变成 `undefined`，渲染时炸「React.createElement is not a function」。
import * as React from 'react'

/**
 * 站点信息：**按 provider 派生**，不写死任何一站。
 *
 * ⚠️ 两站是**独立部署**（各有自己的账号池与模型网关，凭据互不通用）⇒
 * 域名与显示名必须跟着 `provider` 走，不能用国内站的一套通用。
 */
function siteOf(provider) {
  return provider === 'monkeycodeintl'
    ? { name: 'MonkeyCode 国际站', base: 'https://monkeycode-ai.net' }
    : { name: 'MonkeyCode', base: 'https://monkeycode-ai.com' }
}

/**
 * 手动填写 MonkeyCode 凭据的弹窗（**组件**，用 `React.createElement(MonkeycodeKeyModal, props)` 渲染）。
 *
 * @param props `{ provider, error, busy, inputRef, onSubmit(value), onClose, editing?, currentMasked? }`，
 *   其中 `onSubmit` 收到的对象是 `{ apiKey, signingSecret, sessionCookie }`；
 *   `provider` 是 `'monkeycode' | 'monkeycodeintl'`（决定文案里的站点与域名）。
 *   `editing` = 编辑已有账号（由父组件的 `accountId` 派生）；`currentMasked` 仅用于显示。
 */
export function MonkeycodeKeyModal({
  provider, error, busy, inputRef, onSubmit, onClose, currentMasked, editing: editingProp,
  onDismissError,
}) {
  /**
   * 编辑态判据（2026-11-02 二审 D🟡-2）。
   *
   * ⚠️ **优先用 `editing` prop**，不要拿 `currentMasked` 反推：宿主对空 mask 是
   * **省略字段**下发（`maskMonkeycodeKey` 在小于 12 位时返回空串），于是
   * 「accountId 有值但 mask 为空」是合法状态 —— 用 mask 判态会让弹窗显示
   * 「添加 / 确定」而提交却按 accountId 走 `setApiKey`（文案与动作分叉）。
   * `editingProp` 缺省时才回落到 mask（保持单独渲染本组件时的兼容性）。
   */
  const editing = typeof editingProp === 'boolean'
    ? editingProp
    : (typeof currentMasked === 'string' && currentMasked !== '')
  // 后两个字段的 ref 由组件自己持有：它们的值只在「点确定」这一瞬间被读一次，
  // 父组件没有别的用途（不需要 focus、不需要跨渲染读取）。
  const secretRef = React.useRef(null)
  const cookieRef = React.useRef(null)
  const site = siteOf(provider)
  // 本地校验错误（`signing_secret` 缺失）。与宿主返回的 `error` 分开：
  // 本地错误不该被下一次 `onSubmit` 的 loading 态吞掉。
  const [inlineError, setInlineError] = React.useState('')
  /**
   * 本地错误要**跟着输入消失**：用户看到「signing_secret 必填」之后去填那一格，
   * 红字若一直挂到下次点确定，会让人以为还没填对（本组件用 ref 读值、没有 onChange
   * 绑 state，所以这是唯一能清错的时机）。
   */
  const clearInlineError = () => {
    if (inlineError !== '') setInlineError('')
    /**
     * ⚠️ 宿主的 `error`（提交失败那条红字）也要跟着消失（三审 E🟢-15）：
     * 它是**上一次提交**的结论，用户一改输入就已经过时了。只清本地内联错误的话，
     * 用户会看到「我明明改了，红字还挂着」，以为改动没被接受。
     */
    if (error && onDismissError) onDismissError()
  }

  const submit = () => {
    const read = (ref) => {
      if (!ref || !ref.current) return ''
      return String(ref.current.value == null ? '' : ref.current.value).trim()
    }
    const apiKey = inputRef && inputRef.current ? String(inputRef.current.value == null ? '' : inputRef.current.value).trim() : ''
    const signingSecret = read(secretRef)
    const sessionCookie = read(cookieRef)
    /**
     * 空 API Key 的两个分支都被允许，但语义不同：
     * - **新建**：什么都没填 ⇒ 静默关窗（与 qiniu 一致，不吓人）；
     * - **编辑**：只填会话 cookie ⇒ 仍然提交，父组件会走 `setSession` 补登录态
     *   （2026-11-02 二审 D🟡-3：卡片提示让用户「补一次登录态」，而这里若直接
     *   return，那条路在 UI 上就根本走不通，用户只能删卡重建）。
     */
    if (apiKey === '') {
      if (!editing || sessionCookie === '') {
        if (onClose) onClose()
        return
      }
      onSubmit({ apiKey: '', signingSecret, sessionCookie })
      return
    }
    /**
     * ⚠️ 新建模式**必须**有 signing_secret（2026-11-02 二审 D🟡-4）：
     * placeholder 与提示语都写着「必填」，但此前两端都不校验 ⇒ 用户能建出一个
     * 每次推理都 403 `invalid ohmyagent request` 的账号。编辑模式允许留空
     * （宿主会 `signingSecret ?? previous?.signing_secret` 沿用旧值）。
     */
    if (!editing && signingSecret === '') {
      setInlineError('signing_secret 必填：它与 API Key 在同一页面生成，缺了它网关会拒绝每一次请求。')
      return
    }
    setInlineError('')
    onSubmit({ apiKey, signingSecret, sessionCookie })
  }

  /**
   * Enter 直接提交（三审 E🟢-13）：百智 / opencode / modelscope 的弹窗都有，本弹窗
   * 三个 input 却都没有 ⇒ 用户粘完 Key 下意识的回车**没反应**（表单里回车默认就是提交，
   * 没有这个 handler 会让人以为弹窗卡住了）。
   *
   * ⚠️ 只在**文本 type 才拦**：`textarea` 之类需要回车换行；
   *    这里三颗都是 `type: 'password'`，但仍然统一走 `e.key === 'Enter'` 判定。
   */
  const onInputKeyDown = (e) => {
    if (e && e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget && !busy && onClose) onClose() },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': (editing ? '更新 ' : '添加 ') + site.name + ' 账号',
      style: { maxWidth: '560px' },
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' },
          (editing ? '更新 ' : '添加 ') + site.name + ' 账号'),
      ),
      // ⚠️ 内容必须放进 modalBody（flex:1; min-height:0; overflow-y:auto），
      // 否则弹窗较高时内容会被裁掉。
      React.createElement('div', { className: 'dim-jh-modalBody' },
        React.createElement('p', { className: 'dim-jh-modalHint' },
          editing
            ? '当前 Key：' + (currentMasked === '' ? '（未记录打码值）' : currentMasked)
              + '。只需重填要换的字段，留空的字段保持原值'
              + '（包括 signing_secret 与已攒下的会话 cookie）；只想补网页登录态时，'
              + '可以把 API Key 留空、只填 session cookie。'
            : 'API Key 与 signing_secret 在 ' + site.base + ' 站内「OhMyAgent」页面生成（Key 形如 oma_…）。'
              + '推荐直接用「浏览器登录」自动获取；只有手里已经有 Key 时才需要填这里。'),
        React.createElement('div', { className: 'dim-jh-formRows' },
          React.createElement('input', {
            ref: inputRef,
            className: 'dim-jh-input',
            type: 'password',
            autoFocus: true,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: 'API Key（oma_…）',
            onChange: clearInlineError,
            disabled: busy || undefined,
            onKeyDown: onInputKeyDown,
          }),
          React.createElement('p', { className: 'dim-jh-hint' },
            'signing_secret 与 API Key 同时生成（48 位随机串）。缺了它，网关会以 '
            + '403 invalid ohmyagent request 拒绝每一次请求。'),
          React.createElement('input', {
            ref: secretRef,
            className: 'dim-jh-input',
            type: 'password',
            spellCheck: false,
            autoComplete: 'off',
            // 编辑模式下它**可以留空**（宿主 `signingSecret ?? previous?.signing_secret`
            // 会沿用旧值），写「必填」会让人以为必须重填。
            placeholder: editing ? 'signing_secret（留空保持原值）' : 'signing_secret（必填）',
            onChange: clearInlineError,
            disabled: busy || undefined,
            onKeyDown: onInputKeyDown,
          }),
          React.createElement('input', {
            ref: cookieRef,
            className: 'dim-jh-input',
            type: 'password',
            spellCheck: false,
            autoComplete: 'off',
            placeholder: 'session cookie（选填，用于积分与签到）',
            onChange: clearInlineError,
            disabled: busy || undefined,
            onKeyDown: onInputKeyDown,
          }),
        ),
        React.createElement('p', { className: 'dim-jh-hint' },
          'session cookie 只影响积分 / 每日额度 / 签到，不影响推理。留空时余额面板显示「未配置会话」——'
          // ⚠️ 2026-11-02 三审 F🟡-5：MonkeyCode 卡片**没有**「登录」按钮
          //    （`jet-hub.js` 只传 `onEditMonkeycodeKey`），原文案把用户指向一个不存在的按钮。
          + '事后可以点账号卡片上的「改 Key」补填这一栏，不必删除重建。'),
        // ⚠️ `role="alert"`：屏幕阅读器要能读到这条（百智那个弹窗一直有，本弹窗漏了）。
        error || inlineError
          ? React.createElement('div', { className: 'dim-jh-error', role: 'alert' },
              error || inlineError)
          : null,
      ),
      React.createElement('div', { className: 'dim-jh-modalFoot' },
        React.createElement('button', {
          className: 'dim-jh-btn',
          type: 'button',
          disabled: busy ? 'disabled' : undefined,
          onClick: () => { if (onClose) onClose() },
        }, '取消'),
        React.createElement('button', {
          className: 'dim-jh-btn dim-jh-btnPrimary',
          type: 'button',
          disabled: busy ? 'disabled' : undefined,
          onClick: submit,
        }, busy ? (editing ? '更新中…' : '提交中…') : (editing ? '更新' : '确定')),
      ),
    ),
  )
}
