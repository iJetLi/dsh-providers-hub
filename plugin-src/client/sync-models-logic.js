/**
 * 「模型同步」区块的**纯展示逻辑**（不引 React，故可单测）。
 *
 * ## 为什么单独成文件
 *
 * `plugin-src/client/*` 里的 React 组件**不能**在单测里 import：`react` 由宿主
 * 注入（不在本包 dependencies 里），测试进程解析不到。仓库惯例是把可测的判断
 * （文案、可用性、降级规则）放在独立的纯函数文件里，组件只负责挂载。
 *
 * 这里承担两条会直接误导用户的判定：
 * 1. `ok:false` 的目标必须带**具体原因**；
 * 2. 空 diff 时「执行同步」必须禁用 —— 否则点一下会生成一份什么都没改的备份目录。
 *
 * @module plugin-src/client/sync-models-logic.js
 */

/** 目标展示名。 */
const TARGET_LABEL = { pi: 'pi', zcode: 'ZCode' }

/** diff 是否为空（没有新增/移除/更新）。 */
export function isEmptySyncDiff(diff) {
  if (!diff) return true
  return diff.added.length === 0 && diff.removed.length === 0 && diff.updated.length === 0
}

/**
 * 单个目标的摘要（纯函数，便于单测）。
 *
 * @returns `{ tone, text, details }` —— `tone` 供渲染选颜色：ok / warn / error
 */
export function syncTargetSummary(target, selected = true) {
  const label = TARGET_LABEL[target?.target] ?? String(target?.target ?? '')
  if (!target?.ok) {
    return { tone: 'error', text: label + '：' + (target?.error || '不可用'), details: [] }
  }
  const diff = target.diff
  const details = []
  if (diff?.added?.length) details.push('新增：' + diff.added.join('、'))
  if (diff?.removed?.length) details.push('移除：' + diff.removed.join('、'))
  if (diff?.updated?.length) details.push('能力值变化：' + diff.updated.join('、'))
  // 被跳过的模型必须显式说出来：它们**没有**被同步，用户可能在目标里找不到
  if (diff?.skipped?.length) details.push('跳过（网关未给能力值）：' + diff.skipped.join('、'))

  const parts = []
  if (diff?.added?.length) parts.push('新增 ' + diff.added.length)
  if (diff?.removed?.length) parts.push('移除 ' + diff.removed.length)
  if (diff?.updated?.length) parts.push('更新 ' + diff.updated.length)
  // 未选中的目标：**仍显示 diff**（用户可能只是临时取消勾选，还想看差异），
  // 但文案与色调都要说清「不会写入」，否则容易以为已经同步过了
  const prefix = selected ? '' : '（未选中）'
  if (parts.length === 0) {
    return { tone: selected ? 'ok' : 'muted', text: prefix + label + '：已是目标状态', details }
  }
  const tone = !selected ? 'muted' : diff?.skipped?.length ? 'warn' : 'ok'
  return { tone, text: prefix + label + '：' + parts.join('、') + '（共 ' + String(diff.added.length + diff.removed.length + diff.updated.length) + ' 项）', details }
}

/** 是否存在可执行变更（决定「执行同步」按钮是否可用）。 */
/**
 * 默认选中全部目标 agent（首次加载时用）。
 *
 * ⚠️ 默认不选任何目标会让「执行同步」一点就报错，也违背「一键配置」的初衷。
 */
export function defaultSelectedTargets(preview) {
  const targets = Array.isArray(preview?.targets) ? preview.targets : []
  return targets.map(target => target.target)
}

/** 是否存在可执行变更（决定「执行同步」按钮是否可用）。 */
export function canApplySync(preview, selectedTargets) {
  if (!preview || !Array.isArray(preview.targets)) return false
  if (!(preview.modelCount > 0)) return false
  // 目标白名单：`undefined` = 全部；空集 = 一个都没选 ⇒ 禁用
  const selected = Array.isArray(selectedTargets) ? new Set(selectedTargets) : null
  if (selected && selected.size === 0) return false
  return preview.targets.some(target => {
    if (!target.ok) return false
    if (selected && !selected.has(target.target)) return false
    return !isEmptySyncDiff(target.diff)
  })
}

/** 执行结果的一句话总结（含备份目录与**实际**增删数量）。 */
export function applyResultSummary(result) {
  const applied = Array.isArray(result?.applied) ? result.applied : []
  const skipped = Array.isArray(result?.skipped) ? result.skipped : []
  const lines = applied.map(entry => {
    // ⚠️ 必须把 added/removed 报出来：之前只写「X 已写入，备份：dir」，
    //    而 apply 结束后组件立刻重拉预览 ⇒ 被删掉的模型在预览与结果里都看不见。
    const diff = entry?.diff ?? {}
    const parts = [
      Array.isArray(diff.added) && diff.added.length > 0 ? `新增 ${diff.added.length}` : '',
      Array.isArray(diff.removed) && diff.removed.length > 0 ? `移除 ${diff.removed.length}` : '',
      Array.isArray(diff.updated) && diff.updated.length > 0 ? `更新 ${diff.updated.length}` : '',
    ].filter(Boolean)
    const detail = parts.length > 0 ? parts.join(' / ') + '；' : ''
    return TARGET_LABEL[entry.target] + ' 已写入（' + detail + '备份：' + entry.backupDir + '）'
  })
  for (const entry of skipped) lines.push(TARGET_LABEL[entry.target] + ' 未写入：' + entry.reason)
  if (lines.length === 0) return ['没有任何目标被写入']
  return lines
}

/**
 * 默认勾选哪些渠道：**全部**。
 *
 * ## 为什么是全选而不是「只勾目标里已有的」
 *
 * 本功能存在的理由就是「网关增减了渠道/模型，别让我手工去改另外两个工具」。
 * 若默认只勾目标里已有的渠道，那**新增渠道的模型默认不会进来**，
 * 「新增渠道」这个最核心的场景仍然要用户手工介入 —— 功能就白做了。
 *
 * ⚠️ 早期实现曾按「目标里已有」来默认勾选，理由是「用户只配了 6 个模型，
 * 全量会把选择器塞满」。这个理由站不住：那 6 个是没有同步功能时的**成本妥协**，
 * 不是意愿上限。用户要什么由勾选决定，不由默认值替他决定。
 *
 * 想收窄范围时取消勾选即可（列表里每个渠道都带模型数与「已在 pi/ZCode 中」标记）。
 */
export function defaultSelectedProviders(preview) {
  const providers = Array.isArray(preview?.providers) ? preview.providers : []
  return providers.map(provider => provider.id)
}

/**
 * 渠道勾选区的一行文案。
 *
 * `inTargets` 决定给不给「已在目标中」的标记 —— 用户据此判断「这个渠道是我用过的」。
 */
export function providerOptionLabel(provider) {
  const where = []
  if (provider?.inTargets?.pi) where.push('pi')
  if (provider?.inTargets?.zcode) where.push('ZCode')
  const suffix = where.length ? '（已在 ' + where.join('、') + ' 中）' : ''
  return String(provider?.id ?? '') + ' · ' + String(provider?.modelCount ?? 0) + ' 个模型' + suffix
}

/**
 * 采集失败渠道的提示（无失败时返回 null）。
 *
 * ⚠️ 必须显示：这些渠道的模型是被「保留」而不是被确认「仍然可用」，
 * 用户需要知道当前看到的目录并不完整。
 */
export function failedProvidersNotice(preview) {
  const failed = Array.isArray(preview?.failedProviders) ? preview.failedProviders : []
  if (failed.length === 0) return null
  return '以下渠道本次读取失败，它们的模型已原样保留（未删除）：' + failed.join('、')
}

/** 勾选状态的切换（纯函数，便于测）。 */
export function toggleProvider(selected, providerId) {
  const list = Array.isArray(selected) ? selected : []
  return list.includes(providerId) ? list.filter(id => id !== providerId) : [...list, providerId]
}
