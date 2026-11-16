/**
 * `system` 必须折进 `messages[]`，不能放请求体顶层 —— GitHub #97 的守卫。
 *
 * ## 真实缺陷（2026-11-17，报告 @BIBIOscar）
 *
 * 这批渠道的网关**只从 `messages[]` 读系统提示词**，请求体顶层的 `system` 字段被
 * **静默忽略**：HTTP 200、正文正常、上游零报错，只是模型完全不知道 system 存在。
 *
 * 我用「system 里写 `Reply with exactly SYS-MARK-4192`，再看回复里有没有这个字面量」
 * 的真机探针逐家测过（判据必须是**模型有没有收到**，不是 HTTP 码）：
 *
 * | 渠道 | 顶层 `system` | `messages[]`-system |
 * |---|---|---|
 * | marvis | 200 但**没收到指令** | 200 且收到 |
 * | modelscope | 200 但**没收到指令** | 200 且收到 |
 * | baizhi | 200 **且收到** | 200 且收到 |
 *
 * 故本缺陷影响 2 家（qiniu 本机无凭据、未实测，按同源协议风险一并处理），
 * **baizhi 是误报**：它构造的是 Anthropic Messages（`max_tokens` 必填、
 * `stop_sequences`、`tools[].input_schema`），Anthropic 协议里 `system`
 * **本来就是顶层参数** —— 挪进 `messages[]` 反而造非法角色。
 *
 * ## 影响面
 *
 * 需要 system 的**辅助请求**（auto-review 风险评审、session-title）拿不到策略 ⇒
 * 模型收不到「按要求输出 JSON」⇒ 输出散文 ⇒ 上层 `JSON.parse` 失败 ⇒ 评审
 * fail-closed 拒绝 ⇒ Auto 预设下所有工具调用无法执行，且想关掉 auto-review
 * 也要过同一条评审（死锁）。
 */

import { describe, expect, it } from 'vitest'
import { foldSystemIntoMessages } from '../../src/system-prompt-fold.js'
import { buildMarvisPayload } from '../../src/marvis-messages.js'
import { buildModelscopePayload } from '../../src/modelscope-messages.js'
import { buildQiniuPayload } from '../../src/qiniu-messages.js'
import { buildBaizhiMessagesPayload } from '../../src/baizhi-messages.js'

describe('foldSystemIntoMessages：纯函数', () => {
  it('system 为 undefined 时逐字节原样返回（同一引用，不做无谓复制）', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    expect(foldSystemIntoMessages(messages, undefined)).toBe(messages)
  })

  it('system 为空串时同样原样返回（空 system 消息是非法形状）', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    expect(foldSystemIntoMessages(messages, '')).toBe(messages)
  })

  it('非空 system 折成第一条 messages[] 成员，原对话顺序不变', () => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]
    expect(foldSystemIntoMessages(messages, '你是助手')).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ])
  })

  it('★ 不改动入参数组（纯函数；调用方可能复用同一个 messages）', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    foldSystemIntoMessages(messages, '你是助手')
    expect(messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('★ 多条 system 不去重、不合并：options.system 与历史里的 system 是两件事', () => {
    const messages = [{ role: 'system', content: '历史里的策略' }]
    const out = foldSystemIntoMessages(messages, '本次请求的策略')
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ role: 'system', content: '本次请求的策略' })
    expect(out[1]).toEqual({ role: 'system', content: '历史里的策略' })
  })
})

/**
 * wire 层判据：**看最终要发出去的 body**，而不是中间对象。
 *
 * 三个 builder 的返回值就是 `JSON.stringify` 前的最后一步（adapter 直接
 * `body: JSON.stringify(payload)`），所以断言 `payload` 等于断言 wire。
 */
describe('三个 OpenAI 兼容 builder 的 system 形状（GitHub #97）', () => {
  const messages = [{ role: 'user', content: 'hi' }]

  const builders = [
    { name: 'marvis', build: (system: string) => buildMarvisPayload({ model: 'm', messages, system }) },
    {
      name: 'modelscope',
      build: (system: string) => buildModelscopePayload({ model: 'm', messages, system }),
    },
    { name: 'qiniu', build: (system: string) => buildQiniuPayload({ model: 'm', messages, system }) },
  ] as const

  for (const { name, build } of builders) {
    it(`★ ${name}：顶层不许有 system 键（那个位置被上游静默忽略）`, () => {
      const payload = build('你是助手')
      expect(Object.hasOwn(payload, 'system'), '顶层 system 会被上游静默忽略').toBe(false)
    })

    it(`★★ ${name}：system 必须作为第一条 messages[] 成员下发`, () => {
      const payload = build('你是助手')
      expect(payload.messages).toEqual([{ role: 'system', content: '你是助手' }, ...messages])
    })

    it(`${name}：system 缺失时 messages 原样不动（不塞空 system 消息）`, () => {
      const payload = build('')
      expect(payload.messages).toEqual(messages)
      expect(Object.hasOwn(payload, 'system')).toBe(false)
    })
  }
})

describe('刻意不改的渠道：Anthropic Messages 的 system 本来就是顶层参数', () => {
  it('★ baizhi 顶层 system 必须保留（把误报当缺陷修会造非法请求）', () => {
    // baizhi 构造的是 Anthropic Messages（`max_tokens` 必填、`stop_sequences`、
    // `tools[].input_schema`）。Anthropic 协议里 `system` 是顶层参数，
    // `messages[]` 里的 system 反而是**非法角色**。
    // 真机实测过 baizhi 顶层 system 模型**确实收到了** ⇒ #97 对它是误报。
    const payload = buildBaizhiMessagesPayload({
      model: 'minimax-m2.7',
      // ⚠️ `RequestMessage.content` 是 `readonly ContentBlock[]`，不是字符串
      //    （`tests/unit/baizhi.spec.ts` 能写字符串是因为它**不在** typecheck 白名单里）。
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: '你好' }] }],
      system: '你是助手',
    })
    expect(payload.system, 'baizhi 是 Anthropic 协议，system 必须留在顶层').toBe('你是助手')
    // 反向：不许被「统一」成 messages[] 里的 system 角色。
    expect(JSON.stringify(payload.messages)).not.toContain('"role":"system"')
  })
})
