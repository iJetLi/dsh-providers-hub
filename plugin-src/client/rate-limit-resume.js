/**
 * 「限流中断 → 解禁后自动继续」的**客户端半边**（宿主侧见 `src/rate-limit-resume.ts`）。
 *
 * ## 它做两件事
 *
 * 1. **报错行行尾的图标按钮**（两态互切：黄色延时 = 解禁后自动继续 /
 *    红色叉 = 不自动继续）。宿主 `@deepseek-ai/dsh-client-ui-chat` 把终态失败
 *    渲染成 `.…_turnErrorRow`；类名哈希每次构建都变，故按后缀 `_turnErrorRow` 找。
 *    这一行**没有**任何插槽可挂 —— 但它本身就是 DOM，一个 MutationObserver
 *    足够，比替换整个 `conversation.chat.node` 的 `turn-error` 渲染器便宜得多，
 *    也不会跟宿主的文案 / 配色 / 无障碍语义打架。
 * 2. **Jet Hub 设置页的「限流续跑」段**：总开关 + 当前待续跑列表 + 「立即继续」
 *    ＋ 「移除」。
 *
 * ## ⚠️⚠️ 行尾按钮必须用**原生 DOM**，不能用 React 元素
 *
 * 那个位置是**宿主自己的 DOM**（不在任何 React 树里），React 元素塞进原生
 * DOM 只会渲染成 `[object Object]`。这条链路没有 `react-dom`（客户端 bundle 只能
 * `require('react')`），所以这里老老实实 `document.createElement` —— 与
 * `dsh-gitbar-lite` 等插件的 DOM 增强同一手法。
 *
 * ## 状态全部在宿主侧
 *
 * 五条 RPC（`resume.getState` / `setArmed` / `setEnabled` / `fireNow` / `forget`）
 * 由 `src/rate-limit-resume.ts` 的模块级单例回答。本地**不留任何状态机**：
 * 按钮显示什么完全由宿主回答「这个会话还有没有待续跑的限流中断、它 armed 没有」。
 * 关掉标签页再回来按钮还是对的 —— 这也正是它必须放宿主侧的理由（解禁要等一小时，
 * 必然跨标签页与宿主重启）。
 *
 * ## 图标规范
 *
 * 照 `@deepseek-ai/dsh-client-ui-primitives` 的规范自己画：16px 盒子、
 * `viewBox="0 0 16 16"`、`fill="none"`、`stroke="currentColor"` 写在**每条 path**
 * 上、`stroke-width` 写在 `<svg>` 上而不是 path 上。**不用 emoji / 文本字符** ——
 * emoji 是平台字体的彩色字形，不跟随 `currentColor` 和主题。
 *
 * 颜色只用宿主 token：`var(--dsw-alias-state-warn-primary)`（黄）与
 * `var(--dsw-alias-state-error-primary)`（红），不写死色值，跟随主题。
 */
import * as React from 'react'

/** 报错行上「本行已增强过」的标记（幂等判据）。 */
const ROW_ATTR = 'data-phc-rate-limit-resume'
/** 行尾插入的按钮格子。 */
const SLOT_ATTR = 'data-phc-resume-slot'
const SLOT_CLASS = 'dim-jh-resumeSlot'
const SVG_NS = 'http://www.w3.org/2000/svg'

/** 黄色延时（就绪）图标：闹钟 + 一条「到点自己走」的箭头。 */
const ICON_DEFER = ['M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z', 'M8 5.9v2.5l1.7 1', 'M12.4 3.1h2.1v2.1', 'M14.4 3.2 11.9 5.4']
/** 红色叉：两条对角笔画（与宿主 `IconCloseOutline` 同形的 45 度交叉）。 */
const ICON_CANCEL = ['M4.4 4.4 11.6 11.6', 'M11.6 4.4 4.4 11.6']

/**
 * 造一个 16px、1px 描边的图标（原生 SVG 节点）。
 *
 * @param {readonly string[]} strokes - 每条描边的 path `d`。
 * @param {string} className - 额外类名。
 * @returns {Element}
 */
function icon(strokes, className) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  // ⚠️ `stroke-width` 写在 `<svg>` 上而不是每条 path 上（宿主规范）。
  svg.setAttribute('stroke-width', '1')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const d of strokes) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(path)
  }
  return svg
}

/**
 * 画/更新一行的切换按钮（幂等：同一行重复调用只重建内容，不叠格子）。
 *
 * @param {Element} row - 宿主的 `.…_turnErrorRow`。
 * @param {{armed: boolean, busy: boolean, resetAtMs?: number}} state - 当前显示状态。
 * @param {(next: boolean) => void} onToggle - 收到**目标** armed（不是被点击的当前态）。
 */
function renderToggle(row, state, onToggle) {
  const armed = state.armed === true
  const busy = state.busy === true
  let holder = row.querySelector(`[${SLOT_ATTR}]`)
  if (holder === null) {
    holder = document.createElement('span')
    holder.setAttribute(SLOT_ATTR, '')
    holder.className = SLOT_CLASS
    // 插到**最后**：`.turnErrorRow` 是 `grid-template-columns: 10px minmax(0,1fr) auto`，
    // 前两格是状态点与文案、第三格是错误码。新格子落进 `auto` 轨道 ⇒ 紧跟错误码。
    row.appendChild(holder)
  }
  const button = document.createElement('button')
  button.type = 'button'
  button.className = armed ? 'dim-jh-resumeToggle' : 'dim-jh-resumeToggle dim-jh-resumeToggleOff'
  button.setAttribute('data-armed', armed ? '1' : '0')
  // 语义：这是**开关**（两态互切），故 `aria-pressed` 而不是 `aria-checked`；
  // `title` 说清「点一下会变成什么」—— 图标按钮没有文字，提示必须自带下一步。
  button.setAttribute('aria-pressed', armed ? 'true' : 'false')
  button.setAttribute('aria-label', armed ? '解禁后自动继续' : '不自动继续')
  const at = typeof state.resetAtMs === 'number' ? new Date(state.resetAtMs) : undefined
  const when = at === undefined ? '' : `（${at.toLocaleString()} 解禁）`
  button.title = armed
    ? `解禁后自动继续：当前为开${when}。限流解禁后会自动把这一轮续上。点击切换为「不自动继续」。`
    : `不自动继续：当前为关${when}。限流解禁后不会自动续跑，需要你手动重发。点击切换为「解禁后自动继续」。`
  button.disabled = busy
  button.appendChild(icon(armed ? ICON_DEFER : ICON_CANCEL, 'dim-jh-resumeIcon'))
  const text = document.createElement('span')
  text.className = 'dim-jh-resumeText'
  text.textContent = armed ? '解禁后自动继续' : '不自动继续'
  button.appendChild(text)
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onToggle(!armed)
  })
  holder.replaceChildren(button)
}

/**
 * 当前会话 id：宿主把 `data-conversation-session=session-…` 放在会话内容根上。
 *
 * ⚠️ 这是**唯一**稳定的会话身份通道：侧边栏行的 `data-row-key` 也带 id，但它属于
 * 另一棵树（用户可能正看着 A 会话而侧边栏选中 B）。只认内容根那一个。
 *
 * @returns {string | undefined}
 */
function currentSessionId() {
  const holder = document.querySelector('[data-conversation-session]')
  const value = holder === null ? '' : holder.getAttribute('data-conversation-session') ?? ''
  return value === '' ? undefined : value
}

/**
 * 这一行是不是「限流类」的中断 —— 判据是它自己的文案 / 错误码节点。
 *
 * ⚠️ 两种判据都要认：`RATE_LIMIT` 这种错误码只出现在 `.turnErrorCode` 里，而
 * 部分渠道的限流只把话写进正文（providers-hub 十来个适配器各有各的形态）。
 *
 * @param {Element} row
 * @returns {boolean}
 */
function isRateLimitRow(row) {
  const copy = row.querySelector('[class*="_turnErrorMessage"]')
  const code = row.querySelector('[class*="_turnErrorCode"]')
  const text = `${copy === null ? '' : copy.textContent ?? ''} ${code === null ? '' : code.textContent ?? ''}`
  if (text.trim() === '') return false
  return /429|RATE_LIMIT|rate.?limit|限流|频率|额度|积分不足|余额不足|quota|too many requests|耗尽/i.test(text)
}

/**
 * 装上「解禁后自动继续」的客户端半边。
 *
 * @param {{rpcCall: (endpoint: string, payload?: unknown) => Promise<any>}} options
 * @returns {() => void} 卸载函数（幂等）。
 */
export function installRateLimitResumeUi(options) {
  const { rpcCall } = options
  /**
   * 每个会话的显示状态。
   *
   * ⚠️⚠️ 必须能区分**三种**情况，否则会踩到真机坑：
   * - **没有条目** = 还没问过宿主（读取进行中）；
   * - `NO_HOOK` = 问过了，宿主说「这个会话没有待续跑记录」⇒ 把按钮收掉；
   * - `{ armed, busy, resetAtMs }` = 有记录，按它渲染。
   *
   * 早期把后两种都写成 `undefined`，于是「先被 MutationObserver 挂上标记、读取
   * 尚未返回时又有人调 render」这一步会把**刚拿到的状态**当成「没有记录」，
   * 连带把 renderers 里的行删掉 ⇒ 按钮永远不出现。
   */
  const NO_HOOK = Symbol('no-hook')
  const states = new Map()
  const renderers = new Map()
  let disposed = false
  let pollTimer

  function scheduleRender(sessionId) {
    if (disposed) return
    const row = renderers.get(sessionId)
    if (row === undefined || row === null) return
    if (!row.isConnected) {
      renderers.delete(sessionId)
      return
    }
    // 还没问过宿主：什么都别做（等 sync 的续体来调这一次）。
    if (!states.has(sessionId)) return
    const state = states.get(sessionId)
    if (state === NO_HOOK) {
      // 宿主明确说「没有待续跑记录」：把按钮收掉（留着它点了也不会有事发生）。
      row.removeAttribute(ROW_ATTR)
      const slot = row.querySelector(`[${SLOT_ATTR}]`)
      if (slot !== null) slot.remove()
      renderers.delete(sessionId)
      states.delete(sessionId)
      return
    }
    renderToggle(row, state, (next) => { void toggle(sessionId, next) })
  }

  /**
   * 问宿主这个会话的待续跑状态。
   *
   * @returns 有记录时 `{ armed, busy, resetAtMs }`；宿主说没有时 `NO_HOOK`；
   *   **读取失败**时 `undefined` —— 那与「没有记录」是两件事，不该收掉按钮。
   */
  async function readState(sessionId) {
    if (sessionId === undefined) return undefined
    try {
      const res = await rpcCall('resume.getState', { sessionId })
      const hooks = res !== null && typeof res === 'object' && Array.isArray(res.hooks) ? res.hooks : []
      const hook = hooks.find((candidate) => candidate !== null && typeof candidate === 'object'
        && candidate.sessionId === sessionId)
      if (hook === undefined) return NO_HOOK
      // ⚠️ 显示**解禁时刻**（`unlockAtMs`），不是「下一次重试时刻」
      //    （`resetAtMs` 在投递失败后会被推成「现在 + 2 分钟」，与解禁无关）。
      const shownAt = typeof hook.unlockAtMs === 'number' ? hook.unlockAtMs : hook.resetAtMs
      return { armed: hook.armed !== false, busy: false, resetAtMs: shownAt }
    } catch (caught) {
      // 读取失败**不要**把按钮收掉：那会让「宿主一时抖了」变成「功能消失」。
      console.warn('[jet-hub] 读取限流续跑状态失败:', caught)
      return undefined
    }
  }

  async function sync(sessionId, row) {
    if (sessionId === undefined) return
    if (!row.isConnected) return
    renderers.set(sessionId, row)
    const next = await readState(sessionId)
    if (disposed) return
    // ⚠️ 读取失败（`undefined`）时**保持原状**：可能按钮已经画好了，收掉它等于
    // 「宿主抖了一下就看不到功能了」。
    if (next !== undefined) states.set(sessionId, next)
    scheduleRender(sessionId)
  }

  async function toggle(sessionId, next) {
    const current = states.get(sessionId)
    if (current !== undefined && current !== NO_HOOK) {
      // 乐观切换：一次 RPC 往返在弱网下能到几百毫秒，按钮不动会像卡住了。
      states.set(sessionId, { armed: next, busy: true, resetAtMs: current.resetAtMs })
      scheduleRender(sessionId)
    }
    try {
      const res = await rpcCall('resume.setArmed', { sessionId, armed: next })
      if (disposed) return
      const hook = res !== null && typeof res === 'object' ? res.hook : undefined
      if (hook === undefined || hook === null) {
        // 宿主说这个会话已经没有待续跑记录了（例如用户在别处重发了消息）。
        states.set(sessionId, NO_HOOK)
      } else {
        states.set(sessionId, { armed: hook.armed !== false, busy: false, resetAtMs: hook.resetAtMs })
      }
    } catch (caught) {
      console.warn('[jet-hub] 切换限流续跑失败:', caught)
      // 回滚到点击前的状态：不能让界面显示一个宿主没接受的值。
      const before = states.get(sessionId)
      if (before !== undefined && before !== NO_HOOK) {
        states.set(sessionId, { armed: !next, busy: false, resetAtMs: before.resetAtMs })
      }
    }
    scheduleRender(sessionId)
  }

  /** 单行增强（幂等）。 */
  function decorateRow(row) {
    const sessionId = currentSessionId()
    if (sessionId === undefined) return
    if (row.getAttribute(ROW_ATTR) === '1') {
      // 已经增强过：只按最新状态刷一遍（文案/图标可能变了）。
      if (renderers.get(sessionId) === row) scheduleRender(sessionId)
      return
    }
    if (!isRateLimitRow(row)) return
    row.setAttribute(ROW_ATTR, '1')
    void sync(sessionId, row)
  }

  function decorateSubtree(node) {
    if (!(node instanceof Element)) return
    if (node.matches('[class*="_turnErrorRow"]')) decorateRow(node)
    for (const row of node.querySelectorAll('[class*="_turnErrorRow"]')) decorateRow(row)
  }

  let observer
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== 'childList') continue
        for (const node of record.addedNodes) decorateSubtree(node)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    // 首屏可能已经有报错行：立刻扫一遍（MutationObserver 只报**之后**的变化）。
    decorateSubtree(document.body)
    // 兜底轮询：解禁时刻过了以后按钮文案不变，但「宿主已经自动续跑、该把按钮
    // 收掉」这件事只有宿主知道。30 秒一次，且只在页面上确实有增强过的行时才发请求。
    pollTimer = setInterval(() => {
      if (disposed || renderers.size === 0) return
      for (const sessionId of Array.from(renderers.keys())) {
        const row = renderers.get(sessionId)
        if (row === undefined || !row.isConnected) {
          renderers.delete(sessionId)
          continue
        }
        void sync(sessionId, row)
      }
    }, 30000)
  }

  return function dispose() {
    if (disposed) return
    disposed = true
    if (observer !== undefined) observer.disconnect()
    if (pollTimer !== undefined) clearInterval(pollTimer)
    for (const slot of document.querySelectorAll(`[${SLOT_ATTR}]`)) slot.remove()
    renderers.clear()
    states.clear()
  }
}

/**
 * Jet Hub 设置页的「限流续跑」段（React 元素 —— 它长在 React 树里）。
 *
 * ⚠️ 它是**默认值**开关，不是全局暂停：语义正是「设置默认是否自动继续」。
 * 已有待续跑记录保持各自的 armed（用户可能逐个关过），改这里不追溯。
 *
 * 下面还列出当前挂着的待续跑记录，每条给「立即继续 / 移除」——解禁时刻过了
 * 但用户不想等（或宿主刚重启、会话还没打开）时，这是唯一的手动出路。
 *
 * @param {{rpcCall: (endpoint: string, payload?: unknown) => Promise<any>}} props
 * @returns {object} React 元素。
 */
export function RateLimitResumeSection({ rpcCall }) {
  const [enabled, setEnabled] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [hooks, setHooks] = React.useState([])
  const [notice, setNotice] = React.useState('')
  const [available, setAvailable] = React.useState(true)
  const mounted = React.useRef(true)

  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = React.useCallback(async () => {
    try {
      const res = await rpcCall('resume.getState', {})
      if (!mounted.current) return
      setEnabled(res !== null && typeof res === 'object' ? res.enabled !== false : true)
      setHooks(res !== null && typeof res === 'object' && Array.isArray(res.hooks) ? res.hooks : [])
      setAvailable(res === null || typeof res !== 'object' || res.available !== false)
      setFailed(false)
    } catch (caught) {
      console.warn('[jet-hub] 读取「解禁后自动继续」状态失败:', caught)
      if (!mounted.current) return
      // 读取失败时**不**禁用开关：那是唯一一条自救路径。
      setFailed(true)
    }
  }, [rpcCall])

  React.useEffect(() => {
    void load()
    // 有挂着的记录时每 30 秒刷新一次，让「解禁时刻」与列表保持新鲜。
    const timer = setInterval(() => { void load() }, 30000)
    return () => { clearInterval(timer) }
  }, [load])

  const commit = React.useCallback(async (next) => {
    setBusy(true)
    try {
      const res = await rpcCall('resume.setEnabled', { enabled: next })
      if (!mounted.current) return
      setEnabled(res !== null && typeof res === 'object' ? res.enabled !== false : next)
      setFailed(false)
      setNotice('')
      await load()
    } catch (caught) {
      console.warn('[jet-hub] 保存「解禁后自动继续」默认值失败:', caught)
      if (!mounted.current) return
      setNotice('保存失败：宿主可能还在运行旧代码，完全退出并重新打开 DSH 后再试。')
      await load()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [rpcCall, load])

  const fireNow = React.useCallback(async (sessionId) => {
    setBusy(true)
    try {
      const res = await rpcCall('resume.fireNow', { sessionId })
      if (!mounted.current) return
      const fired = res !== null && typeof res === 'object' && res.fired === true
      setNotice(fired ? '已投递续跑消息。' : `还没能继续：${res !== null && typeof res === 'object' ? String(res.reason ?? '未知原因') : '未知原因'}`)
      await load()
    } catch (caught) {
      console.warn('[jet-hub] 立即继续失败:', caught)
      if (mounted.current) setNotice('立即继续失败：宿主可能还在运行旧代码。')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [rpcCall, load])

  const forget = React.useCallback(async (sessionId) => {
    setBusy(true)
    try {
      await rpcCall('resume.forget', { sessionId })
      if (!mounted.current) return
      setNotice('')
      await load()
    } catch (caught) {
      console.warn('[jet-hub] 移除待续跑失败:', caught)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [rpcCall, load])

  const rows = hooks.map((hook) => {
    const shownAt = typeof hook.unlockAtMs === 'number' ? hook.unlockAtMs : hook.resetAtMs
    const at = typeof shownAt === 'number' ? new Date(shownAt) : undefined
    const due = at !== undefined && at.getTime() <= Date.now()
    return React.createElement('div', {
      key: hook.sessionId,
      className: 'dim-jh-resumeRow',
      title: `${hook.sessionId}（${hook.provider || '?'} / ${hook.model || '?'}）`,
    },
      React.createElement('span', { className: 'dim-jh-resumeRowText' },
        `${hook.sessionId.slice(0, 16)}… ${hook.armed ? '自动继续' : '已暂停'} · `
        + (at === undefined ? '解禁时刻未知' : due ? '已到解禁时刻' : `${at.toLocaleString()} 解禁`)),
      React.createElement('button', {
        className: 'dim-jh-btn',
        disabled: busy,
        onClick: () => { void fireNow(hook.sessionId) },
      }, '立即继续'),
      React.createElement('button', {
        className: 'dim-jh-btn',
        disabled: busy,
        onClick: () => { void forget(hook.sessionId) },
      }, '移除'))
  })

  return React.createElement('div', { className: 'dim-jh-settingsSection' },
    React.createElement('div', { className: 'dim-jh-settingsSectionTitle' }, '限流续跑'),
    React.createElement('label', {
      className: failed
        ? 'dim-jh-settingsToggleLine dim-jh-settingsToggleLineFailed'
        : 'dim-jh-settingsToggleLine',
      title: failed
        ? '⚠️ 开关状态读取失败，当前显示的是默认值（开启）。点击即可重新提交一次。'
        : '解禁后自动继续：会话因限流（429 / 号池全限流 / 额度耗尽）中断时，'
          + '等到**解禁时刻**自动把这一轮续上。这里改的是**默认值** —— 只影响新的中断；'
          + '报错行行尾那个按钮可以逐个覆盖。',
    },
      React.createElement('input', {
        type: 'checkbox',
        className: 'dim-jh-switch',
        checked: enabled,
        disabled: busy,
        onChange: (event) => { void commit(event.target.checked) },
      }),
      React.createElement('span', { className: 'dim-jh-settingsToggleText' },
        '解禁后自动继续（限流 / 额度中断，等到解禁时刻自动续跑）')),
    available
      ? null
      : React.createElement('p', { className: 'dim-jh-modalHint' },
        '⚠️ 宿主侧没有装上这个功能（插件版本旧？）。完全退出并重新打开 DSH 后再看。'),
    notice === ''
      ? null
      : React.createElement('p', { className: 'dim-jh-modalHint' }, notice),
    rows.length === 0
      ? React.createElement('p', { className: 'dim-jh-modalHint' }, '当前没有待续跑的限流中断。')
      : React.createElement('div', { className: 'dim-jh-resumeList' }, rows))
}
