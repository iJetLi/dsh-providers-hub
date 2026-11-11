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

  /** 单次预览请求（不处理默认勾选）。 */
  const fetchPreview = React.useCallback(
    async providers => rpcCall('sync.preview', providers === undefined ? {} : { providers }),
    [rpcCall],
  )

  /**
   * 拉预览。
   * @param providers 渠道白名单；`undefined` 表示「首次加载，先拿清单」
   */
  const load = React.useCallback(async providers => {
    setPhase('loading')
    setError(null)
    try {
      let value = await fetchPreview(providers)
      if (!mounted.current || !value) return
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
          const narrowed = await fetchPreview(defaults)
          if (!mounted.current || !narrowed) return
          value = narrowed
        }
      }
      setPreview(value)
      setPhase('ready')
    } catch (caught) {
      if (!mounted.current) return
      setError(caught?.message || '无法读取同步预览')
      setPhase('error')
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
    setPhase('applying')
    setError(null)
    setResult(null)
    try {
      const value = await rpcCall('sync.apply', { providers: selected ?? [], targets: targetList })
      if (!mounted.current) return
      setResult(value)
      setPhase('ready')
      await load(selected ?? [])
    } catch (caught) {
      if (!mounted.current) return
      setError(caught?.message || '同步失败')
      setPhase('error')
    }
  }, [rpcCall, selected, load])

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
        onClick: () => void load(selectedList),
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
