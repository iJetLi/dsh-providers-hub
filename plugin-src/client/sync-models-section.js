/**
 * 「模型同步」设置区块（2026-11-11）。
 *
 * ## 它解决什么
 *
 * 网关的模型目录是**动态**的（新增渠道、渠道下架、模型增减），而外部 agent
 * （pi 的 `models.json`、ZCode 的 `provider_config.json`）里是**静态**列表。
 * 于是每次目录变化都要手工改两个别人的配置文件 —— 本区块把这件事变成
 * 「看一眼 diff → 点一下」。
 *
 * ## 为什么落在「设置」弹窗而不是侧边栏底部操作行
 *
 * 底部 `.dim-jh-railActions` 的按钮是 `flex: 1 1 0; min-width: 0; overflow: hidden`，
 * 228px 栏宽下 4 个按钮各约 42px 可用宽（「签到」两个字刚好放下）。加第 5 个会
 * 等分挤压**全部**按钮 ⇒ 连现有的「签到 / 网关 / 用量 / 设置」都会开始显示省略号。
 * 那是为加一个低频动作而回归四个高频动作，不划算。设置弹窗本就是低频配置区
 * （供应商开关 / 定时签到 / 备份恢复 / 渠道原生搜索），语义也对得上。
 *
 * ## 交互约定
 *
 * - **挂载即预览**（只读，不写任何文件）；弹窗关掉即卸载、下次重开重新预览，
 *   所以不存在「看到的 diff 是半小时前算的」这种风险。
 * - **执行前必须已经在预览里看到 diff**：按钮在有可执行变更时才可用。
 * - 执行结果里**必须显示备份目录** —— 用户要能自己回滚。
 *
 * @module plugin-src/client/sync-models-section.js
 */

import * as React from 'react'
import {
  applyResultSummary,
  canApplySync,
  defaultSelectedProviders,
  defaultSelectedTargets,
  failedProvidersNotice,
  providerOptionLabel,
  syncTargetSummary,
  toggleProvider,
} from './sync-models-logic.js'

/**
 * 「模型同步」设置区块。
 *
 * ## 两次预览的原因
 *
 * 打开面板时先**不带**渠道白名单拉一次，只为拿到网关的渠道清单（`providers`）；
 * 再用「目标里已有的渠道」重拉一次，让展示的 diff 恰好等于用户将要执行的范围。
 * 只拉一次的话，用户看到的会是「全渠道 363 项新增」，与实际执行（只动 5 个渠道）
 * 不符 —— 那种预览比没有更糟。
 *
 * @param props.rpcCall 宿主注入的 RPC 调用（已解包 `{ok,value}`，失败即抛错）
 */
export function SyncModelsSection({ rpcCall }) {
  const [phase, setPhase] = React.useState('loading')
  const [preview, setPreview] = React.useState(null)
  const [selected, setSelected] = React.useState(null)
  /** 要同步的目标 agent；null = 尚未初始化（按全选处理）。 */
  const [selectedTargets, setSelectedTargets] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [result, setResult] = React.useState(null)
  const mounted = React.useRef(true)
  /**
   * 预览请求序号：只接受**最后一次发起**的请求结果。
   *
   * ⚠️ 连点渠道会并发多个 `load`，没有闸门时旧的响应可能后到并覆盖新的，
   *    界面就会出现「摘要写已勾选 1 个渠道、折叠标题写已选 2/2、同步按钮却是亮的」
   *    这种自相矛盾状态（实测）。
   */
  const requestSeq = React.useRef(0)

  /**
   * 单次预览请求（不处理默认勾选）。
   *
   * `force: true` 让服务端跳过 30 秒目录缓存 —— 「刷新」按钮必须能真的重读网关，
   * 否则点下去只会拿到缓存、界面纹丝不动（看起来像按钮坏了）。
   * ⚠️ 只有「刷新」用它：`sync.apply` 刻意不接受 force，见 `sync-rpc.ts` 的 `readForce`。
   */
  const fetchPreview = React.useCallback(
    async (providers, force) => rpcCall('sync.preview', {
      ...providers === undefined ? {} : { providers },
      ...force === true ? { force: true } : {},
    }),
    [rpcCall],
  )

  /**
   * 拉预览。
   * @param providers 渠道白名单；`undefined` 表示「首次加载，先拿清单」
   * @param options `keepResult: true` = 保留上一次的 apply 结果
   *   （`run` 成功之后的重拉用：那份结果记录的是**刚刚写进磁盘**的事实，
   *   清掉它用户就永远看不到「新增了几项、备份在哪」，而这正是回滚的唯一线索）。
   * @param options `force: true` = 跳过服务端 30 秒目录缓存（「刷新」按钮用）
   */
  const load = React.useCallback(async (providers, options) => {
    const keepResult = options?.keepResult === true
    const force = options?.force === true
    const seq = ++requestSeq.current
    setPhase('loading')
    setError(null)
    try {
      let value = await fetchPreview(providers, force)
      if (!mounted.current || seq !== requestSeq.current || !value) return
      if (providers === undefined) {
        // 首次：先拿到渠道清单，再用默认勾选集重拉。
        //
        // ⚠️ 那管默认集已覆盖全部渠道也**必须**重拉：首次那次请求没带白名单，
        //    它的结果虽然与全选等价，但一旦「selected 显示的个数」与「diff 实际
        //    基于的白名单」不一致，用户看到的就是自相矛盾的界面（实测：界面写
        //    「已选 19/19」而同屏报「没勾选任何渠道」）。宁可多一次只读请求，
        //    也要保证展示的 diff 恰好对应 selected。
        const defaults = defaultSelectedProviders(value)
        setSelected(defaults)
        if (defaults.length > 0) {
          // ⚠️ 复用同一次请求的 force 语义：首次加载的第二次请求若不带 force，
          //    在「第一次已强制刷新」之后仍会命中缓存 —— 无害但没必要，
          //    更重要的是两次请求必须看到**同一份**目录，否则显示的 diff 会自相矛盾。
          const narrowed = await fetchPreview(defaults, force)
          if (!mounted.current || seq !== requestSeq.current || !narrowed) return
          value = narrowed
        }
      }
      setPreview(value)
      setPhase('ready')
      // 新一轮预览成功 ⇒ 上一轮的 apply 结果已过时（它的 diff 基于旧目录）。
      // 但 `run` 成功后的重拉必须保留（否则「已写入 / 备份目录」一帧都看不到）。
      if (!keepResult) setResult(null)
    } catch (caught) {
      if (!mounted.current || seq !== requestSeq.current) return
      setError(caught?.message || '无法读取同步预览')
      setPhase('error')
      // ⚠️ 失败时必须清掉上一次的成功结果：否则红字错误与绿字「已写入」同屏，
      //    旧 diff 还留在屏幕上、按钮仍可点，用户会照着已失效的预览去确认写入。
      setResult(null)
    }
  }, [fetchPreview])

  React.useEffect(() => {
    mounted.current = true
    void load(undefined)
    return () => { mounted.current = false }
  }, [load])

  /** 勾选/取消一个渠道：立刻按新选择重拉预览（不写文件）。 */
  const onToggle = React.useCallback(providerId => {
    const next = toggleProvider(selected ?? [], providerId)
    setSelected(next)
    void load(next)
  }, [selected, load])

  /** 执行同步：成功后重拉预览，让 diff 反映落盘后的真实状态。 */
  const run = React.useCallback(async () => {
    // ⚠️ 目标列表必须在**调用时**算。曾经直接用渲染期变量 `targetList`
    //    而它又不在依赖数组里 ⇒ 闭包永久捕获上一次渲染的白名单：用户取消勾选
    //    ZCode 后点「同步」，payload.targets 仍是 ['pi','zcode']（实测 UI 上
    //    ZCode 的 checkbox 已经是 false）。只在「只改目标、不动渠道」这条路径复现。
    const targets = selectedTargets ?? defaultSelectedTargets(preview)
    setPhase('applying')
    setError(null)
    setResult(null)
    try {
      const value = await rpcCall('sync.apply', { providers: selected ?? [], targets })
      if (!mounted.current) return
      setResult(value)
      setPhase('ready')
      // ⚠️ 必须保留刚写下的结果：`setResult(value)` 之后如果这里把 result 清掉，
      //    「新增 N 项 / 备份在 dir」会在同一批渲染里被抹掉，用户永远看不见
      //    —— 而备份目录是出问题时唯一的回滚线索。
      await load(selected ?? [], { keepResult: true })
    } catch (caught) {
      if (!mounted.current) return
      // 失败时不能留着上一次的成功结果（会让红字错误与绿字「已写入」同屏）
      setResult(null)
      setError(caught?.message || '同步失败')
      setPhase('error')
    }
  }, [rpcCall, selected, selectedTargets, preview, load])

  const busy = phase === 'loading' || phase === 'applying'
  const rows = preview?.targets ?? []
  const selectedList = selected ?? []
  const targetList = selectedTargets ?? defaultSelectedTargets(preview)
  const notice = failedProvidersNotice(preview)

  /** 勾选/取消一个目标 agent（只影响写入范围，不必重拉预览）。 */
  const onToggleTarget = target => {
    setSelectedTargets(toggleProvider(targetList, target))
  }

  return React.createElement('div', { className: 'dim-jh-gatewaySection' },
    React.createElement('p', { className: 'dim-jh-gatewaySectionTitle' }, '自动配置 agent'),
    // ⚠️ 标题与这条 hint 必须紧邻：`.dim-jh-gatewaySectionTitle + .dim-jh-modalHint`
    //    靠相邻选择器给 3px 上边距（见 jet-hub-styles.js）。
    React.createElement('p', { className: 'dim-jh-modalHint' },
      '把上面这份模型目录写进 pi 与 ZCode 的配置。只刷新模型列表与能力值，'
      + '不改动两边的 API Key；写入前自动备份。'),
    React.createElement('div', { className: 'dim-jh-settingsSection' },
    preview
      ? React.createElement('p', { className: 'dim-jh-modalHint' },
          '网关目录共 ' + String(preview.totalModelCount) + ' 个模型 / '
          + String((preview.providers ?? []).length) + ' 个渠道；已勾选 '
          + String((preview.requestedProviders ?? preview.providers ?? []).length) + ' 个渠道，'
          + '本次参与 ' + String(preview.modelCount) + ' 个（可写 ' + String(preview.usableModelCount ?? 0) + ' 个）'
          + '（' + String(preview.gatewayBaseUrl) + '）')
      : null,
    // 渠道勾选：默认**全选**（新增渠道必须默认包含，否则「网关新增渠道」这个
    // 核心场景仍要用户手工）；想收窄就取消勾选。
    (preview?.providers ?? []).length > 0
      ? React.createElement('details', { style: { margin: '4px 0' } },
          React.createElement('summary', { style: { cursor: 'pointer', fontSize: '12px' } },
            '选择要同步的渠道（已选 ' + String(selectedList.length) + ' / ' + String(preview.providers.length) + '）'),
          preview.providers.map(provider => React.createElement('label', {
            key: provider.id,
            style: { display: 'block', fontSize: '12px', lineHeight: '20px', cursor: 'pointer' },
          },
          React.createElement('input', {
            type: 'checkbox',
            checked: selectedList.includes(provider.id),
            disabled: busy,
            onChange: () => onToggle(provider.id),
          }),
          ' ' + providerOptionLabel(provider))))
      : null,
    notice
      ? React.createElement('p', { className: 'dim-jh-modalHint', style: { color: '#d48806' } }, notice)
      : null,
    rows.map(row => {
      const checked = targetList.includes(row.target)
      const summary = syncTargetSummary(row, checked)
      const borderColor = summary.tone === 'error'
        ? '#d4380d'
        : summary.tone === 'warn'
          ? '#d48806'
          : summary.tone === 'muted'
            ? '#bfbfbf'
            : '#389e0d'
      return React.createElement('div', {
        key: row.target,
        // 用现有区块内的普通段落 + 左侧色条表达 tone，不新增 CSS 类（零样式回归面）
        style: {
          fontSize: '12px',
          lineHeight: '18px',
          padding: '2px 0 2px 8px',
          borderLeft: '2px solid ' + borderColor,
          opacity: checked ? 1 : 0.6,
        },
      },
      // 目标级开关：只同步勾选的 agent（未勾选的**不会写入**，但仍显示它的 diff）
      React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' } },
        React.createElement('input', {
          type: 'checkbox',
          checked,
          disabled: busy,
          onChange: () => onToggleTarget(row.target),
        }),
        React.createElement('span', null, summary.text)),
      // 显示**实际使用**的文件路径：路径可能来自 PI_CODING_AGENT_DIR /
      // ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 覆盖，不显示出来用户就没法核对写到了哪里
      React.createElement('div', { style: { fontSize: '11px', opacity: 0.65, wordBreak: 'break-all', paddingLeft: '20px' } }, row.path),
      summary.details.length
        ? React.createElement('details', { style: { marginTop: '2px', paddingLeft: '20px' } },
            React.createElement('summary', { style: { cursor: 'pointer' } }, '明细'),
            summary.details.map((line, index) => React.createElement('div', { key: index, style: { opacity: 0.85 } }, line)))
        : null)
    }),
    error ? React.createElement('p', { className: 'dim-jh-modalHint', style: { color: '#d4380d' } }, error) : null,
    result
      ? React.createElement('div', { style: { fontSize: '12px', lineHeight: '18px' } },
          applyResultSummary(result).map((line, index) => React.createElement('div', { key: index }, line)))
      : null,
    React.createElement('div', { className: 'dim-jh-settingsSectionActions' },
      React.createElement('button', {
        className: 'dim-jh-btn',
        title: '重新读取网关模型目录并计算差异（不会写文件）。',
        disabled: busy,
        // force：跳过服务端 30 秒缓存，否则点刷新会命中缓存、界面看起来「没反应」
        onClick: () => void load(selectedList, { force: true }),
      }, '刷新'),
      React.createElement('button', {
        className: 'dim-jh-btn',
        title: canApplySync(preview, targetList)
          ? '把上面列出的变更写入两个目标的配置文件（写入前自动备份）。'
          : '当前没有可写入的变更。',
        disabled: busy || !canApplySync(preview, targetList),
        onClick: () => void run(),
      }, phase === 'applying' ? '同步中…' : '同步'))))
}
