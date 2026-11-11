import { describe, expect, it } from 'vitest'
import {
  applyResultSummary,
  canApplySync,
  defaultSelectedTargets,
  defaultSelectedProviders,
  failedProvidersNotice,
  isEmptySyncDiff,
  providerOptionLabel,
  syncTargetSummary,
  toggleProvider,
} from '../../plugin-src/client/sync-models-logic.js'

/**
 * 「模型同步」区块的纯展示逻辑测试。
 *
 * 只测文案与可用性判定（渲染部分由组件层承担，本仓库不给 React 组件做快照）。
 * 重点守住两条会直接误导用户的行为：
 * 1. `ok:false` 的目标必须显示**具体原因**（否则用户只看到「不可用」无从下手）；
 * 2. `canApplySync` 不能因为「有 diff 字段」就放行 —— 空 diff 时按钮必须禁用
 *    （否则点一下会生成一份什么都没改的备份目录）。
 */

const emptyDiff = { added: [], removed: [], updated: [], skipped: [] }

describe('isEmptySyncDiff', () => {
  it('四项全空算空', () => {
    expect(isEmptySyncDiff(emptyDiff)).toBe(true)
  })

  it('⚠️ 只有 skipped 也算空（跳过不是变更：没有东西会被写进目标）', () => {
    expect(isEmptySyncDiff({ added: [], removed: [], updated: [], skipped: ['x/y'] })).toBe(true)
  })

  it('缺 diff 时算空（不抛）', () => {
    expect(isEmptySyncDiff(undefined)).toBe(true)
  })

  it('有任一项就非空', () => {
    expect(isEmptySyncDiff({ ...emptyDiff, added: ['a/b'] })).toBe(false)
    expect(isEmptySyncDiff({ ...emptyDiff, removed: ['a/b'] })).toBe(false)
    expect(isEmptySyncDiff({ ...emptyDiff, updated: ['a/b'] })).toBe(false)
  })
})

describe('syncTargetSummary — 目标摘要', () => {
  it('⚠️ ok:false 时把具体原因显示出来（不是笼统的「不可用」）', () => {
    const summary = syncTargetSummary({ target: 'pi', ok: false, error: '找不到配置文件：C:/x/models.json' })
    expect(summary.tone).toBe('error')
    expect(summary.text).toContain('pi')
    expect(summary.text).toContain('找不到配置文件')
  })

  it('无变更时显示「已是目标状态」', () => {
    const summary = syncTargetSummary({ target: 'zcode', ok: true, diff: emptyDiff })
    expect(summary.tone).toBe('ok')
    expect(summary.text).toContain('已是目标状态')
    expect(summary.details).toEqual([])
  })

  it('列出新增/移除/更新的数量与明细', () => {
    const summary = syncTargetSummary({
      target: 'pi',
      ok: true,
      diff: { added: ['codearts/a', 'codearts/b'], removed: ['codearts/old'], updated: [], skipped: [] },
    })
    expect(summary.text).toContain('新增 2')
    expect(summary.text).toContain('移除 1')
    expect(summary.details.some(line => line.includes('codearts/a'))).toBe(true)
    expect(summary.details.some(line => line.includes('codearts/old'))).toBe(true)
  })

  it('⚠️ 被跳过的模型必须显式说出来，且 tone 降级为 warn', () => {
    const summary = syncTargetSummary({
      target: 'zcode',
      ok: true,
      diff: { added: ['codearts/a'], removed: [], updated: [], skipped: ['codearts/bad'] },
    })
    expect(summary.tone).toBe('warn')
    expect(summary.details.some(line => line.includes('跳过') && line.includes('codearts/bad'))).toBe(true)
  })
})

describe('canApplySync — 按钮可用性', () => {
  it('⚠️ 空 diff 时禁用（避免生成一份没改动的备份目录）', () => {
    expect(
      canApplySync({
        modelCount: 3,
        targets: [{ target: 'pi', ok: true, diff: emptyDiff }, { target: 'zcode', ok: true, diff: emptyDiff }],
      }),
    ).toBe(false)
  })

  it('有变更且至少一个目标可用时启用', () => {
    expect(
      canApplySync({
        modelCount: 3,
        targets: [{ target: 'pi', ok: true, diff: { ...emptyDiff, added: ['a/b'] } }],
      }),
    ).toBe(true)
  })

  it('⚠️ 目录为空时即使目标里有旧 diff 也禁用（后端会拒绝，UI 不该给假希望）', () => {
    expect(
      canApplySync({
        modelCount: 0,
        targets: [{ target: 'pi', ok: false, error: '目录为空' }],
      }),
    ).toBe(false)
  })

  it('目标全部 ok:false 时禁用', () => {
    expect(canApplySync({ modelCount: 3, targets: [{ target: 'pi', ok: false }, { target: 'zcode', ok: false }] })).toBe(false)
  })

  it('preview 为 null 时禁用（首次加载还没回来）', () => {
    expect(canApplySync(null)).toBe(false)
  })
})

describe('applyResultSummary — 落盘结果', () => {
  it('每个写入的目标都给出备份目录', () => {
    const lines = applyResultSummary({
      applied: [{ target: 'pi', path: 'p', backupDir: 'D:/bk/pi', diff: emptyDiff }],
      skipped: [],
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('备份')
    expect(lines[0]).toContain('D:/bk/pi')
  })

  it('⚠️ 跳过原因要写清楚（「未写入」不等于失败，但用户要知道为什么）', () => {
    const lines = applyResultSummary({
      applied: [],
      skipped: [{ target: 'zcode', path: 'z', reason: '已是目标状态，无需写入' }],
    })
    expect(lines[0]).toContain('未写入')
    expect(lines[0]).toContain('无需写入')
  })

  it('空结果给一句兜底文案', () => {
    expect(applyResultSummary({ applied: [], skipped: [] })).toEqual(['没有任何目标被写入'])
    expect(applyResultSummary(undefined)).toEqual(['没有任何目标被写入'])
  })
})

describe('渠道勾选 — 默认值与交互', () => {
  it('⚠️⚠️ 默认全选：新增渠道必须默认包含（否则「网关新增渠道」这个核心场景仍要手工）', () => {
    const preview = {
      providers: [
        { id: 'codearts', modelCount: 11, inTargets: { pi: true, zcode: true } },
        { id: 'minimax', modelCount: 3, inTargets: { pi: false, zcode: true } },
        { id: 'aggregate', modelCount: 122, inTargets: { pi: false, zcode: false } },
        { id: 'modelscope', modelCount: 38, inTargets: { pi: false, zcode: false } },
      ],
    }
    // 一个都不漏，包括目标里完全没有的 aggregate / modelscope
    expect(defaultSelectedProviders(preview)).toEqual(['codearts', 'minimax', 'aggregate', 'modelscope'])
  })

  it('目标里一个渠道都没有时仍然默认全选（第一次就能把网关目录整体接进来）', () => {
    const preview = { providers: [{ id: 'codearts', modelCount: 11, inTargets: { pi: false, zcode: false } }] }
    expect(defaultSelectedProviders(preview)).toEqual(['codearts'])
  })

  it('缺 providers 时默认空集（不抛）', () => {
    expect(defaultSelectedProviders(undefined)).toEqual([])
    expect(defaultSelectedProviders({})).toEqual([])
  })

  it('选项文案带上模型数与「已在目标中」标记', () => {
    expect(providerOptionLabel({ id: 'codearts', modelCount: 11, inTargets: { pi: true, zcode: false } }))
      .toContain('codearts · 11 个模型（已在 pi 中）')
    expect(providerOptionLabel({ id: 'aggregate', modelCount: 122, inTargets: { pi: false, zcode: false } }))
      .toContain('aggregate · 122 个模型')
    expect(providerOptionLabel({ id: 'aggregate', modelCount: 122, inTargets: {} })).not.toContain('已在')
  })

  it('⚠️ 采集失败必须有提示（那些模型是「保留」不是「确认可用」）', () => {
    expect(failedProvidersNotice({ failedProviders: ['buddy'] })).toContain('buddy')
    expect(failedProvidersNotice({ failedProviders: [] })).toBeNull()
    expect(failedProvidersNotice({})).toBeNull()
  })

  it('toggleProvider 增删且不改原数组', () => {
    const original = ['a']
    expect(toggleProvider(original, 'b')).toEqual(['a', 'b'])
    expect(toggleProvider(original, 'a')).toEqual([])
    expect(original).toEqual(['a'])
  })
})

describe('目标 agent 勾选', () => {
  const withDiff = { modelCount: 3, targets: [
    { target: 'pi', ok: true, diff: { added: ['a/b'], removed: [], updated: [], skipped: [] } },
    { target: 'zcode', ok: true, diff: { added: ['a/b'], removed: [], updated: [], skipped: [] } },
  ] }

  it('默认选中全部目标', () => {
    expect(defaultSelectedTargets(withDiff)).toEqual(['pi', 'zcode'])
    expect(defaultSelectedTargets(undefined)).toEqual([])
  })

  it('⚠️⚠️ 只勾 pi 时，即使 ZCode 有变更也不影响按钮可用性判定', () => {
    expect(canApplySync(withDiff, ['pi'])).toBe(true)
    const onlyZcode = { modelCount: 3, targets: [
      { target: 'pi', ok: true, diff: { added: [], removed: [], updated: [], skipped: [] } },
      { target: 'zcode', ok: true, diff: { added: ['a/b'], removed: [], updated: [], skipped: [] } },
    ] }
    // 只勾 pi 而 pi 无变更 ⇒ 禁用（选中的没东西可写）
    expect(canApplySync(onlyZcode, ['pi'])).toBe(false)
    expect(canApplySync(onlyZcode, ['zcode'])).toBe(true)
  })

  it('⚠️ 一个目标都没勾时禁用（避免「成功但什么都没写」）', () => {
    expect(canApplySync(withDiff, [])).toBe(false)
  })

  it('未传 targets 时按全选判定（向后兼容）', () => {
    expect(canApplySync(withDiff)).toBe(true)
  })

  it('⚠️ 未选中的目标仍显示 diff，但标注「未选中」且 tone 降级', () => {
    const summary = syncTargetSummary(withDiff.targets[0], false)
    expect(summary.text).toContain('未选中')
    expect(summary.text).toContain('新增 1')
    expect(summary.tone).toBe('muted')
    // 已选中的不受影响
    expect(syncTargetSummary(withDiff.targets[0], true).text).not.toContain('未选中')
  })
})
