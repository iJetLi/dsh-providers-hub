/**
 * ★★★ **按模型的思考档位 + 出站 `reasoning_effort`**（issue #145，2026-11-23）。
 *
 * ## 缺陷
 *
 * CodeArts 适配器对所有模型**恒声明 `off`/`on` 两档**，而 `reasoning_effort`
 * 这个字符串**全文件只出现过 1 次、而且是在注释里** ⇒ 用户选什么上游都收不到强度。
 *
 * 更糟：旧代码发的 `enable_thinking: true` 是**削弱开关**而不是开启开关 ——
 * 作者实测 `glm-5.3` 用它是 **37** reasoning_tokens，而**不发该字段是 239**。
 *
 * ## 上游的真实枚举（作者真机 A/B：发非法值让上游回显合法枚举）
 *
 * | 模型 | 枚举 |
 * |---|---|
 * | `glm-5.3` / `glm-5.3-flash` | `low` / `high` / `max` |
 * | `deepseek-v4.1-flash` / `-1017` | `none` / `low` / `medium` / `high` / `xhigh` / `max` |
 * | `GLM-5.2` | `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
 * | `kimi-*` / `openpangu-*` | **不校验** ⇒ 保持两档、不编枚举 |
 */
import { describe, expect, it } from 'vitest'
import { codeartsEffortsFor, codeartsThinkingFields } from '../../src/llm-adapter.js'

const idsOf = (model: string): string[] => codeartsEffortsFor(model).map((e) => String(e.id))

describe('codeartsEffortsFor：按模型声明真实档位', () => {
  it('★★★ 三个模型的枚举逐个对上游（含大小写差异 GLM-5.2 vs glm-5.3）', () => {
    expect(idsOf('glm-5.3')).toEqual(['off', 'low', 'high', 'max', 'on'])
    expect(idsOf('glm-5.3-flash')).toEqual(['off', 'low', 'high', 'max', 'on'])
    expect(idsOf('deepseek-v4.1-flash'))
      .toEqual(['off', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'on'])
    // ⚠️ 上游这条是**大写 `GLM-5.2`**，`glm-5.3` 是小写 ⇒ 查找必须大小写不敏感。
    expect(idsOf('GLM-5.2')).toEqual(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on'])
    expect(idsOf('glm-5.2'), '大小写不敏感').toEqual(idsOf('GLM-5.2'))
  })

  it('★★★ `off`/`on` 两个旧 id 必须仍在（否则存过它们的用户整轮失败）', () => {
    // `dsh-llm` 的 `resolveCallWithInfo()` 对显式请求档位**严格校验**，
    // 不在声明里就抛 `UNSUPPORTED_REASONING_EFFORT` ⇒ **整轮对话失败**，不是降级。
    for (const model of ['glm-5.3', 'GLM-5.2', 'deepseek-v4.1-flash', '手填-id']) {
      const ids = idsOf(model)
      expect(ids[0], `${model} 的 off 必须在（旧存档里存过）`).toBe('off')
      expect(ids.at(-1), `${model} 的 on 必须在（旧存档里存过）`).toBe('on')
    }
  })

  it('★★★ 未登记模型（kimi/openpangu/手填）保持两档 —— 不编枚举', () => {
    for (const model of ['kimi-k3', 'kimi-k3.1-pro', 'openpangu-2.1-pro', '手填-id']) {
      expect(idsOf(model), `${model} 上游不校验 reasoning_effort ⇒ 任何枚举都是推测`).toEqual(['off', 'on'])
    }
  })
})

describe('codeartsThinkingFields：出站字段（两个只发一个，绝不并）', () => {
  it('★★★ `off` 按该模型真正能停思考的写法表达', () => {
    // deepseek：`reasoning_effort:'none'` 到不了 0（131~157），只有布尔能到 0。
    expect(codeartsThinkingFields('deepseek-v4.1-flash', 'off')).toEqual({ enable_thinking: false })
    // GLM-5.2：两种都能到 0 ⇒ 走更精确的枚举。
    expect(codeartsThinkingFields('GLM-5.2', 'off')).toEqual({ reasoning_effort: 'none' })
    // glm-5.3 / glm-5.3-flash：上游**拒绝关闭** ⇒ 退到最弱档，不假装关掉了。
    expect(codeartsThinkingFields('glm-5.3', 'off')).toEqual({ reasoning_effort: 'low' })
    expect(codeartsThinkingFields('glm-5.3-flash', 'off')).toEqual({ reasoning_effort: 'low' })
  })

  it('★★★ `on` 与未指定档位都映射到**最强档**（不再发 enable_thinking:true）', () => {
    expect(codeartsThinkingFields('glm-5.3', 'on')).toEqual({ reasoning_effort: 'max' })
    expect(codeartsThinkingFields('glm-5.3', undefined)).toEqual({ reasoning_effort: 'max' })
    expect(codeartsThinkingFields('GLM-5.2', 'on')).toEqual({ reasoning_effort: 'max' })
  })

  it('★★★ 显式档位原样透传；两个字段绝不并发', () => {
    expect(codeartsThinkingFields('deepseek-v4.1-flash', 'xhigh')).toEqual({ reasoning_effort: 'xhigh' })
    // ⚠️ `reasoning_effort:'max'` + `enable_thinking:true` 谁赢**上游没定义**，
    //    并发会让「档位不生效」变成更难查的问题。
    const body = codeartsThinkingFields('glm-5.3', 'max')
    expect(body).not.toHaveProperty('enable_thinking')
  })

  it('★★ 未登记模型保持旧的布尔行为（我们对它的枚举一无所知）', () => {
    expect(codeartsThinkingFields('kimi-k3', 'off')).toEqual({ enable_thinking: false })
    expect(codeartsThinkingFields('kimi-k3', 'on')).toEqual({ enable_thinking: true })
  })
})
