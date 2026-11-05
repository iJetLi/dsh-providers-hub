/**
 * 「添加 百智云 (BaiZhiCloud) 账号」弹窗。
 *
 * ## 为什么单独成文件（而不是复用 `OpencodeKeyModal` / `QiniuKeyModal`）
 *
 * 本仓库已有三家「手工粘贴 API Key」的 provider，但**契约不同**，混用会出错：
 *
 * | | opencode | qiniu | baizhi |
 * |---|---|---|---|
 * | RPC 方法 | `opencode.addAccount` | `qiniu.addAccount` | `baizhi.addAccount` |
 * | Key 形状 | `sk-…` / `oc_sk_…`（不绑前缀） | 无固定前缀 | 实测 `sk-` + 64 位（闸门不绑前缀） |
 * | 申请页 | opencode 站点 | 七牛控制台 | ai-models 大模型商店 `/console/keys` |
 * | 额度/签到 | 有 | 有 | 积分有（进度条）/ **无签到**（按量计费） |
 *
 * 复用同一个组件就要在内部按 provider 分三处支 —— 而这正是
 * `new-account.js` 那套「判据方向相反的两个人容易只改一处」的老问题。
 * 独立组件把差异摊在文件边界上，代价只是约 90 行重复的脚手架。
 *
 * ## ⚠️⚠️ 必须是组件、不能当普通函数直接调用
 *
 * 本组件内部有 `useState`。若在 ProviderPanel 的渲染过程中**直接函数调用**，它的
 * hook 会被算进 ProviderPanel —— 于是「弹窗开」与「弹窗关」两次渲染的 hook 数量
 * 不同，React 抛 #310（"Rendered more hooks than during the previous render"），
 * **整个设置页白屏**。与 `OpencodeProxyModal` 上方记录的真实事故（2026-10-02）
 * 完全同型。
 *
 * ## ⚠️ 为什么不用 `window.prompt`
 *
 * DSH 客户端跑在**沙箱**环境里，`prompt()` 直接抛 `prompt() is not supported`
 * （真机报障 2026-10-01）。本仓库其余交互一律自绘 modal。
 *
 * ## 为什么输入框内容不进 React state
 *
 * API Key 是凭据。放进 `useState` 会让它随每次父组件重渲染经过整棵组件树，
 * 也可能被 devtools 的组件树检查器读到 —— 与「Key 存 credentials、不进明文」
 * 的口径不符。故用 `inputRef` + DOM 读值。只有**错误信息**进 state。
 *
 * ⚠️ **不要把这个 JSDoc 的 `@param` 留在模块头里**：客户端有一道
 * `tsc --checkJs` 的**未声明变量闸**（`tests/unit/credits-capabilities.spec.ts`
 * 的「plugin-src/client 下没有未声明变量」）。模块头没有宿主函数，tsc 会把
 * `@param props { error, busy, … }` 里的 `error` 当成**类型名**去解析，
 * 报 `TS2552: Cannot find name 'error'` —— 而那道闸的失败文案是
 * 「会崩掉整个设置页」，排障方向被完全带偏（modelscope 同款踩过）。
 * `@param` 一律贴在**函数自己的** JSDoc 上（见下方 `BaizhiKeyModal`）。
 */

// ⚠️ 必须用**命名空间导入**（与 jet-hub.js 逐字一致）：`react` 在 esbuild
// 配置里是 external，默认导入 `import React from 'react'` 在 CJS 产物里
// 会变成 `undefined`，渲染时炸「React.createElement is not a function」。
import * as React from 'react'

/**
 * 百智云的 API Key 申请页。
 *
 * ⚠️ 必须与宿主侧 `src/baizhi-rpc.ts` 的报错文案指向**同一处** —— 两处不一致
 * 会让用户在「弹窗说去 A、报错说去 B」之间来回，而两边都不算错，只是无法照做
 * （modelscope / qiniu 同款要求）。
 */
const TOKEN_URL = 'https://ai-models.app.baizhi.cloud/console/keys'

/**
 * 弹窗组件本体（**组件**，用 `React.createElement(BaizhiKeyModal, props)` 渲染）。
 *
 * @param props `{ error, busy, inputRef, onSubmit(value), onClose, editing?, currentMasked? }`
 *   —— `editing` = 编辑已有账号（由父组件的 `accountId` 派生），此时标题/按钮/提示
 *   都换成「更新」语；`currentMasked` 只用于显示「当前 Key：…」。
 *
 * ⚠️ **不要**拿 `currentMasked` 反推编辑态（2026-11-02 二审 D🟡-2）：宿主对空 mask
 * 是省略字段下发（`maskBaizhiKey` 正则不过即空串），「accountId 有值但 mask 空」
 * 是合法状态；用 mask 判态会让弹窗显示「添加/确定」而提交走 `setApiKey`。
 */
export function BaizhiKeyModal({
  error, busy, inputRef, onSubmit, onClose, currentMasked, editing: editingProp, onDismissError,
}) {
  const editing = typeof editingProp === 'boolean'
    ? editingProp
    : (typeof currentMasked === 'string' && currentMasked !== '')
  const submit = () => {
    const value = inputRef && inputRef.current ? inputRef.current.value : ''
    // 空串 = 没填就点确认：静默关弹窗，不报错。
    // ⚠️ 与 opencode 的语义**不同**：那边空串意味着「用免费通道」，
    // 这边空串只是「什么都没做」—— 百智云必须持 Key 才能调用，没有匿名通道，
    // 硬报错反而吓人。
    if (String(value).trim() === '') {
      if (onClose) onClose()
      return
    }
    onSubmit(value)
  }
  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget && !busy && onClose) onClose() },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      // 与 monkeycode 弹窗对齐（三审 E🟢-12）：`role="dialog"` 只有可访问名
      // 被屏幕阅读器念出来才有意义，缺 aria-label 等于没标。
      'aria-label': (editing ? '更新 ' : '添加 ') + '百智云 账号',
      style: { maxWidth: '520px' },
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' },
          editing ? '更新 百智云 账号的 API Key' : '添加 百智云 账号'),
      ),
      // ⚠️ 内容必须放进 modalBody（flex:1; min-height:0; overflow-y:auto），
      // 否则弹窗较高时内容会被裁掉（见 jet-hub.js 既有 modal 的注释）。
      React.createElement('div', { className: 'dim-jh-modalBody' },
        React.createElement('p', { className: 'dim-jh-modalHint' },
          editing
            // ⚠️ 空 mask 要兜底（三审 E🟡-8）：`maskBaizhiKey` 在正则不过时返回空串，
            //    而宿主对空值**省略字段**下发 ⇒ 直接拼会得到「当前 Key：。」这种断句。
            //    monkeycode 那边早有「（未记录打码值）」，这里此前漏了同步。
            ? '当前 Key：' + (currentMasked === '' ? '（未记录打码值）' : currentMasked)
              + '。粘贴新 Key 后点「更新」——'
              + '控制台登录态（积分/用量）会保留，不需要重新登录。'
            : '在 ' + TOKEN_URL + ' 控制台的「API Key」页创建 Key 后粘贴到下方。'),
        React.createElement('p', { className: 'dim-jh-hint' },
          '百智云按量计费：积分与用量在控制台可见（用「浏览器登录」接入后本卡片会显示），没有每日签到。'
          + '调用直接结算到该 Key 所属账户。'),
        React.createElement('div', { className: 'dim-jh-formRows' },
          React.createElement('input', {
            ref: inputRef,
            className: 'dim-jh-input',
            // ⚠️ password 类型：API Key 是凭据，不该在屏幕上裸显。
            type: 'password',
            placeholder: 'API Key（sk-…）',
            autoFocus: true,
            /**
             * ⚠️ 输入即清掉宿主那条「更新失败」红字（三审 E🟢-15）：它是**上一次**
             * 提交的结论，用户一改就已经过时；不清的话会一直挂到下次提交。
             */
            onChange: () => { if (error && onDismissError) onDismissError() },
            // Enter 直接提交：粘贴 Key 后最自然的动作就是回车。
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            },
          }),
        ),
        // ⚠️ 错误留在弹窗内：把整个账号列表切成错误态会让用户刚填的 Key
        // 与错误信息一起消失，只能刷新重试。
        error
          ? React.createElement('p', { className: 'dim-jh-error', role: 'alert' },
            (editing ? '更新失败：' : '添加失败：') + error)
          : null,
      ),
      React.createElement('div', { className: 'dim-jh-modalActions' },
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn dim-jh-btnPrimary',
          disabled: busy,
          onClick: submit,
        }, busy ? (editing ? '更新中…' : '添加中…') : (editing ? '更新' : '添加')),
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: busy,
          onClick: () => { if (onClose) onClose() },
        }, '取消'),
      ),
    ),
  )
}
