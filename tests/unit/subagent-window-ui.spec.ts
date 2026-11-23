/**
 * 子代理设置 UI 的**纯逻辑**守卫（不 import react，可被 vitest 直接测）。
 *
 * ## 为什么这些判据必须单独测
 *
 * 它们决定「界面显示什么」「提交什么给服务端」。错了的后果：
 *
 * | 错法 | 后果 |
 * |---|---|
 * | 提示文字超长 | 折成两行（用户明确要求一行）|
 * | `defaultEffortOf` 取错档 | 用户以为「最强档」，实际发的是弱档 |
 * | `subagentPayloadOf` 保留 `fixedPosition` | 切回 fixed 时「自己选了一个号」|
 * | 校验漏掉 | 用户看到 RPC 报错而不是「哪个字段错了」|
 */
import { describe, expect, it } from 'vitest'

import {
  SUBAGENT_MODE_LABELS,
  SUBAGENT_MODE_HINTS,
  defaultEffortOf,
  subagentHintOf,
  subagentPayloadOf,
  validateSubagentDraft,
} from '../../plugin-src/client/credit-window-ui.js'

describe('SUBAGENT_MODE_LABELS：五个选项的名称', () => {
  it('★★★ 顺序与用户确认的一致', () => {
    expect(SUBAGENT_MODE_LABELS.map(([id]) => id)).toEqual([
      'follow', 'sequence', 'reverse', 'hash', 'fixed',
    ])
    expect(SUBAGENT_MODE_LABELS.map(([, label]) => label)).toEqual([
      '跟随主代理', '顺序分布', '倒序分布', '哈希分布', '固定帐号',
    ])
  })
})

describe('SUBAGENT_MODE_HINTS：提示文字', () => {
  it('★★★ 每个模式都有提示（不能有空串）', () => {
    for (const [id] of SUBAGENT_MODE_LABELS) {
      const hint = SUBAGENT_MODE_HINTS[id]
      expect(typeof hint, `${id} 缺提示`).toBe('string')
      expect(hint.length, `${id} 提示为空`).toBeGreaterThan(0)
    }
  })

  it('★★★ 每条提示 ≤ 30 字符（实测 510px 下不折行）', () => {
    for (const [id, hint] of Object.entries(SUBAGENT_MODE_HINTS)) {
      expect(hint.length, `${id}: "${hint}" 共 ${hint.length} 字符`).toBeLessThanOrEqual(30)
    }
  })

  it('★★★ 每条提示都强调「档位规则不变」（用户核心诉求）', () => {
    /**
     * 用户 2026-11-23 纠正过我：「子代理也要遵守档次优先的原则」。
     * `fixed` 那条是例外（它明确说「无视档位」），其余四条必须提「临期」。
     */
    for (const id of ['sequence', 'reverse', 'hash', 'follow']) {
      expect(SUBAGENT_MODE_HINTS[id], `${id} 必须提到临期`).toContain('临期')
    }
    expect(SUBAGENT_MODE_HINTS.fixed, 'fixed 必须说明它无视档位').toContain('无视档位')
  })

  it('★★ 未知模式回落 follow 的提示（不返回空串）', () => {
    expect(subagentHintOf('nonsense')).toBe(SUBAGENT_MODE_HINTS.follow)
    expect(subagentHintOf(undefined)).toBe(SUBAGENT_MODE_HINTS.follow)
  })
})

describe('defaultEffortOf：思考强度默认值', () => {
  const mk = (efforts: string[], defaultEffort?: string) => ({
    id: 'm',
    name: 'M',
    efforts: efforts.map((id) => ({ id, name: id })),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
  })

  it('★★★ 不支持思考（efforts 空）⇒ undefined（UI 不渲染下拉）', () => {
    expect(defaultEffortOf(mk([]))).toBeUndefined()
  })

  it('★★★ 无 defaultEffort ⇒ 取**最后一档**（最强）', () => {
    expect(defaultEffortOf(mk(['low', 'medium', 'high', 'xhigh', 'max']))).toBe('max')
  })

  it('★★★ 有合法 defaultEffort ⇒ 用它（不硬取最强）', () => {
    expect(defaultEffortOf(mk(['low', 'high', 'max'], 'high'))).toBe('high')
  })

  it('★★★ defaultEffort **不在档位内** ⇒ 回落最后一档（防 UNSUPPORTED_REASONING_EFFORT）', () => {
    /**
     * ⚠️ 上游可能给不一致的值。若原样发出去，DSH 会抛
     * `UNSUPPORTED_REASONING_EFFORT` ⇒ 子代理**整轮失败**。
     */
    expect(defaultEffortOf(mk(['low', 'high'], 'ultra'))).toBe('high')
  })

  it('★★ 非对象 / 脏数据 ⇒ undefined', () => {
    expect(defaultEffortOf(null)).toBeUndefined()
    expect(defaultEffortOf(undefined)).toBeUndefined()
    expect(defaultEffortOf({})).toBeUndefined()
    expect(defaultEffortOf({ efforts: 'nope' })).toBeUndefined()
  })

  it('★ efforts 里的脏条目不会崩（跳过取最后一个合法 id）', () => {
    expect(defaultEffortOf({
      id: 'm', name: 'M',
      efforts: [{ id: 'low', name: 'low' }, null, { id: 'high', name: 'high' }],
    })).toBe('high')
  })
})

describe('validateSubagentDraft：保存前校验', () => {
  it('★★★ 合法草稿通过', () => {
    expect(validateSubagentDraft({ startMode: 'sequence' }).ok).toBe(true)
    expect(validateSubagentDraft({ startMode: 'follow' }).ok).toBe(true)
  })

  it('★★★ 未知模式被拒', () => {
    const r = validateSubagentDraft({ startMode: 'nope' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('策略')
  })

  it('★★★ fixed 缺位次被拒（服务端也会拒）', () => {
    const r = validateSubagentDraft({ startMode: 'fixed' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('账号')
  })

  it('★★ fixed + 非法位次被拒', () => {
    for (const bad of [0, -1, 1.5, '2', null]) {
      expect(validateSubagentDraft({ startMode: 'fixed', fixedPosition: bad }).ok, String(bad)).toBe(false)
    }
  })

  it('★★ fixed + 合法位次通过', () => {
    expect(validateSubagentDraft({ startMode: 'fixed', fixedPosition: 2 }).ok).toBe(true)
  })

  it('★ 非对象被拒', () => {
    expect(validateSubagentDraft(null).ok).toBe(false)
  })
})

describe('subagentPayloadOf：提交载荷', () => {
  it('★★★ fixed 保留位次', () => {
    expect(subagentPayloadOf({ startMode: 'fixed', fixedPosition: 3 })).toEqual({
      startMode: 'fixed',
      fixedPosition: 3,
    })
  })

  it('★★★ **非 fixed 必须丢掉 fixedPosition**（否则切回时会「自己选了」）', () => {
    const out = subagentPayloadOf({ startMode: 'sequence', fixedPosition: 3 })
    expect(out).toEqual({ startMode: 'sequence' })
    expect(out.fixedPosition, '不能带上').toBeUndefined()
  })

  it('★★ 模型与强度随行', () => {
    expect(subagentPayloadOf({
      startMode: 'follow', model: 'glm-5.3', reasoningEffort: 'max',
    })).toEqual({ startMode: 'follow', model: 'glm-5.3', reasoningEffort: 'max' })
  })

  it('★★ 空字符串的模型/强度被省略（不污染合并语义）', () => {
    expect(subagentPayloadOf({
      startMode: 'follow', model: '', reasoningEffort: '',
    })).toEqual({ startMode: 'follow' })
  })

  it('★ 无 startMode ⇒ undefined', () => {
    expect(subagentPayloadOf({})).toBeUndefined()
    expect(subagentPayloadOf(null)).toBeUndefined()
  })
})
