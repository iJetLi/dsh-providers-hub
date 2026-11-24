/**
 * ★★★ **上游第二轮审计 P1-5：模型 id 零校验**（2026-11-24）。
 *
 * ## 上游原话
 *
 * > 「**模型 id 零校验**即落盘并 `select()`。」
 *
 * ## 缺陷链
 *
 * 上一版 `credits.window.set` 对 `subagent.model` 只判「非空字符串」：
 * 传一个**不存在的模型 id** ⇒ 设置照常落盘 ⇒ `agent.model.select()` 被宿主拒
 * ⇒ 那个 `catch` 吞成**静默** ⇒ 子代理一直用主代理模型，
 * 而界面显示「已保存」。
 *
 * ## ⚠️ 本文件的判据演进（上游直接点名的）
 *
 * > 「`subagent/model-validation` 的用例是**纯源码文本**，`if (false)` 注入仍 6/6 绿。」
 *
 * 第一版确实如此 —— 我在源码里找 `enabledIds.includes(rawSub.model)` 字符串，
 * 而把它包成 `if (false && …)` 后**字面量仍在** ⇒ 断言照样绿（**我实测过**）。
 *
 * ⇒ 现在校验逻辑抽成**导出的纯函数** `validateSubagentModelChoice()`，
 *    本文件**直接调用**它并断言返回值 —— **行为级**，短路禁用立刻变红。
 */
import { describe, expect, it } from 'vitest'

import { validateSubagentModelChoice } from '../../src/jet-hub-rpc.js'

/** 造一个校验输入：`enabled` = 已启用模型，`efforts` = 各模型档位。 */
function makeInput(options: {
  model: string
  reasoningEffort?: string
  /** `undefined` 模拟「目录读不到」。 */
  enabled?: readonly string[]
  /** 按模型 id 给档位；缺省模型 → `undefined`（模拟解析失败）。 */
  efforts?: Record<string, readonly string[]>
}) {
  return {
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    listEnabledModelIds: async () => options.enabled,
    listEffortsOf: async (modelId: string) => options.efforts?.[modelId],
  }
}

describe('P1-5：模型必须存在且已启用', () => {
  it('★★★ 模型在已启用列表里 ⇒ 通过', async () => {
    const got = await validateSubagentModelChoice(
      makeInput({ model: 'hy4flash-free', enabled: ['hy4flash-free', 'glm-5.3'] }),
    )
    expect(got, '合法模型必须通过（返回 undefined）').toBeUndefined()
  })

  it('★★★ 模型**不在**已启用列表 ⇒ 必须拒绝', async () => {
    /**
     * ⚠️ 这是上游说的「零校验」那一格。
     *
     * 行为级断言：直接调函数看返回的**拒绝原因**。
     * 把内部改成 `if (false && …)` ⇒ 这里立刻拿到 `undefined` ⇒ 变红。
     */
    const got = await validateSubagentModelChoice(
      makeInput({ model: '不存在的模型', enabled: ['hy4flash-free', 'glm-5.3'] }),
    )
    expect(got, '★★★ 不存在的模型必须返回拒绝原因').toBeDefined()
    expect(got).toContain('不在该渠道已启用的模型中')
    expect(got, '★ 文案必须告诉用户可选数量').toContain('可选 2 个')
  })

  it('★★ 目录读不到（`undefined`）⇒ 跳过校验，不拦保存', async () => {
    /**
     * ⚠️ **反向对照**：离线 / 适配器未就绪时必须放行 ——
     * 否则用户在任何离线环境下都**无法保存任何设置**。
     */
    const got = await validateSubagentModelChoice(
      makeInput({ model: '任意模型', enabled: undefined }),
    )
    expect(got, '★★ 目录读不到必须放行（不是「一律拒绝」）').toBeUndefined()
  })

  it('★★ 空数组 ≠ undefined（离线时不得退化成「全拒」）', async () => {
    /**
     * ⚠️⚠️ 这一格是我第一版写错的地方：
     * 「跳过」必须用 `undefined` 表示，**不是** `[]` ——
     * `[]` 会让 `includes()` 恒 false ⇒ **离线时所有保存都被拒**。
     *
     * ⇒ 本用例把两种形态**并排断言**，锁死语义差异。
     */
    const blocked = await validateSubagentModelChoice(
      makeInput({ model: '任意模型', enabled: [] }),
    )
    expect(blocked, '★★★ 空数组 = 「一个都没启用」⇒ 必须拒绝').toBeDefined()

    const skipped = await validateSubagentModelChoice(
      makeInput({ model: '任意模型', enabled: undefined }),
    )
    expect(skipped, '★★★ undefined = 「读不到」⇒ 必须放行').toBeUndefined()
  })
})

describe('P1-5：思考档位必须属于该模型', () => {
  const enabled = ['m-with-efforts', 'm-no-efforts']

  it('★★★ 档位在该模型的 efforts 里 ⇒ 通过', async () => {
    const got = await validateSubagentModelChoice(
      makeInput({
        model: 'm-with-efforts',
        reasoningEffort: 'high',
        enabled,
        efforts: { 'm-with-efforts': ['low', 'high', 'xhigh'] },
      }),
    )
    expect(got).toBeUndefined()
  })

  it('★★★ 档位不在该模型的 efforts 里 ⇒ 必须拒绝', async () => {
    const got = await validateSubagentModelChoice(
      makeInput({
        model: 'm-with-efforts',
        reasoningEffort: 'ultra',
        enabled,
        efforts: { 'm-with-efforts': ['low', 'high'] },
      }),
    )
    expect(got, '★★★ 非法档位必须返回拒绝原因').toBeDefined()
    expect(got).toContain('不是模型「m-with-efforts」的合法档位')
    expect(got, '★ 文案必须列出可选档位').toContain('low / high')
  })

  it('★★ 模型**没声明档位**（空 efforts）⇒ 不校验档位', async () => {
    /**
     * ⚠️ 那种模型配 `reasoningEffort` 本来就不会被用（`select()` 忽略）
     * ⇒ 拒绝它只会让用户困惑。
     */
    const got = await validateSubagentModelChoice(
      makeInput({
        model: 'm-no-efforts',
        reasoningEffort: 'high',
        enabled,
        efforts: { 'm-no-efforts': [] },
      }),
    )
    expect(got, '★★ 无档位的模型不该因 reasoningEffort 被拒').toBeUndefined()
  })

  it('★★ 档位解析失败（`undefined`）⇒ 跳过档位校验', async () => {
    const got = await validateSubagentModelChoice(
      makeInput({
        model: 'm-with-efforts',
        reasoningEffort: 'high',
        enabled,
        /** 故意不给 `efforts` ⇒ `listEffortsOf` 返回 `undefined`。 */
      }),
    )
    expect(got, '★★ 解析失败必须放行（不拦保存）').toBeUndefined()
  })

  it('★★ 没配档位 ⇒ 不查 efforts（省一次调用）', async () => {
    let called = false
    const got = await validateSubagentModelChoice({
      model: 'm-with-efforts',
      listEnabledModelIds: async () => enabled,
      listEffortsOf: async () => { called = true; return ['low'] },
    })
    expect(got).toBeUndefined()
    expect(called, '★★ 没配 reasoningEffort 就不该查档位').toBe(false)
  })
})
