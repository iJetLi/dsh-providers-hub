/**
 * Gemini 消息翻译与 SSE 消费器单测。
 *
 * fixture 按**上游真实形状**写（信封 `{"response":{…}}`、thought part、
 * functionCall 带 thoughtSignature、收尾纯 usageMetadata 帧）。
 *
 * 守的三件静默失败：历史 reasoning 回传会被拒、工具结果 name 回填错会
 * 让上游认不出函数、块序号不连续会让 harness 拼错消息。
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalArgs,
  consumeGeminiSse,
  mapGeminiFinish,
  readGeminiUsage,
  translateGeminiRequest,
  translateGeminiResponse,
  type GeminiEnvelope,
} from '../../src/gemini-messages.js'
import { geminiModelSpec, GEMINI_SESSION_ID_INFER } from '../../src/gemini.js'
import type { Message } from '@deepseek-ai/dsh-llm'

const msg = (role: 'user' | 'assistant', content: unknown[]): Message =>
  ({ role, content } as Message)

function translate(messages: readonly Message[], extra: Record<string, unknown> = {}): GeminiEnvelope {
  return translateGeminiRequest({
    modelId: 'gemini-3.8-flash',
    spec: geminiModelSpec('gemini-3.8-flash', 'high'),
    messages,
    sessionId: GEMINI_SESSION_ID_INFER,
    requestId: 'agent/1/aaaaaaaa',
    ...extra,
  })
}

/** 把 SSE 文本包成 `ReadableStream`（分片喂入验证跨 chunk 行缓冲）。 */
function sseStream(text: string | readonly string[]): ReadableStream<Uint8Array> {
  const pieces = typeof text === 'string' ? [text] : text
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of consumeGeminiSse({ body })) out.push(chunk as Record<string, unknown>)
  return out
}

/** 上游信封帧。 */
function frame(inner: unknown): string {
  return `data: ${JSON.stringify({ response: inner })}\n\n`
}

const READ_TOOL = [
  msg('user', [{ type: 'text', text: '读文件' }]),
  msg('assistant', [{ type: 'tool-call', id: 't1', name: 'read_file', arguments: '{"path":"a.go"}' }]),
  msg('user', [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'text', text: '内容' }] }]),
]

describe('canonicalArgs', () => {
  it('按键名升序递归排序，空表为 {}，数组保序', () => {
    expect(canonicalArgs(undefined)).toBe('{}')
    expect(canonicalArgs({ z: { b: 1, a: 2 }, list: [3, 1] })).toBe('{"list":[3,1],"z":{"a":2,"b":1}}')
  })
})

describe('translateGeminiRequest', () => {
  it('system 走 systemInstruction；assistant → model 角色', () => {
    const envelope = translate([
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [{ type: 'text', text: 'ok' }]),
    ], { system: '你是助手' })
    expect(envelope.request.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: '你是助手' }],
    })
    expect(envelope.request.contents.map((content) => content.role)).toEqual(['user', 'model'])
  })

  it('历史 reasoning 不回传（DSH 的思考块不带签名，回传必被拒）', () => {
    const envelope = translate([
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [
        { type: 'reasoning', text: '先看看目录' },
        { type: 'text', text: 'ok' },
      ]),
    ])
    expect(envelope.request.contents[1]?.parts).toEqual([{ text: 'ok' }])
  })

  it('tool-call 查得到签名才带 thoughtSignature；tool-result → functionResponse 且 name 从历史回填', () => {
    const withSig = translate(READ_TOOL, {
      lookupSignature: (name: string, argsJson: string) =>
        name === 'read_file' && argsJson === '{"path":"a.go"}' ? 'SIG_FC' : undefined,
    })
    expect(withSig.request.contents[1]?.parts?.[0]).toEqual({
      functionCall: { name: 'read_file', args: { path: 'a.go' } },
      thoughtSignature: 'SIG_FC',
    })
    expect(withSig.request.contents[2]?.parts?.[0]).toEqual({
      functionResponse: { name: 'read_file', response: { content: '内容' } },
    })

    expect(translate(READ_TOOL).request.contents[1]?.parts?.[0]).toEqual({
      functionCall: { name: 'read_file', args: { path: 'a.go' } },
    })
  })

  it('工具结果标记错误时带 error:true；孤儿 tool-result 不下发', () => {    const errored = translate([
      msg('user', [{ type: 'text', text: '读文件' }]),
      msg('assistant', [{ type: 'tool-call', id: 't1', name: 'read_file', arguments: '{}' }]),
      msg('user', [{
        type: 'tool-result',
        toolCallId: 't1',
        isError: true,
        content: [{ type: 'text', text: '打不开' }],
      }]),
    ])
    expect(errored.request.contents[2]?.parts?.[0]).toEqual({
      functionResponse: { name: 'read_file', response: { content: '打不开', error: true } },
    })

    const orphan = translate([
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('user', [{ type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'x' }] }]),
    ])
    expect(orphan.request.contents).toHaveLength(1)
  })

  it('空内容 / 图片未内联都抛错（不静默丢内容）', () => {
    expect(() => translate([msg('user', [{ type: 'reasoning', text: '只有思考' }])]))
      .toThrowError(/messages 里没有可用内容/)

    const withImage = [msg('user', [
      { type: 'text', text: '看图' },
      { type: 'image', attachment: { attachmentId: 'img-1' } },
    ])]
    expect(() => translate(withImage)).toThrowError(/图片未能内联/)
    expect(translate(withImage, {
      images: new Map([['img-1', { mediaType: 'image/png', data: 'AAAA' }]]),
    }).request.contents[0]?.parts?.[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'AAAA' },
    })
  })

  /**
   * ⚠️⚠️ Issue IKLSB8（同族落点，2026-10-14 受控实测）：**工具结果内层的图片被
   * 静默丢弃**。
   *
   * `functionResponse.response.content` 只吃字符串（Gemini 协议在工具结果里没有
   * 承载图的位置），而 `toolResultText()` 只收 text/reasoning 块 ⇒ 原实现下内层图
   * 连 `inlineData` 都不出现。而 `gemini-adapter.ts` 收集侧用的是**递归**的
   * `collectImages` ⇒ 字节被读出、却在翻译阶段丢掉。
   *
   * 实测对照（同一张图、同一请求）：顶层图 ✅ `inlineData` 出现；
   * `tool-result` **内层**图 ❌ **完全不出现**。
   *
   * 守的形态（与 `0dd27ca` / IKLIFH 同一口径）：
   * ① 内层图必须提升成 `inlineData` 并**与后续提问同在一条 user content**；
   * ② 纯图工具结果的正文**不得是空串**（否则模型以为「工具什么都没返回」）；
   * ③ 无图时逐字节不变（不凭空引入 `inlineData`）。
   */
  describe('Issue IKLSB8：工具结果内层图片（同族落点）', () => {
    const IMG = new Map([['att-1', { mediaType: 'image/png', data: 'AQID' }]])

    /** 构造：assistant tool_call → 工具结果（内容由调用方给）→ 后续提问。 */
    function withToolResult(innerBlocks: unknown[], ask: string | undefined) {
      return [
        msg('user', [{ type: 'text', text: '看图' }]),
        msg('assistant', [{ type: 'tool-call', id: 't1', name: 'Read', arguments: '{}' }]),
        msg('user', [{ type: 'tool-result', toolCallId: 't1', isError: false, content: innerBlocks }]),
        ...ask === undefined ? [] : [msg('user', [{ type: 'text', text: ask }])],
      ]
    }

    it('①（判别）内层图片必须提升为 inlineData，且与提问**同在一条** user content', () => {
      const envelope = translate(
        withToolResult([{ type: 'image', attachment: { attachmentId: 'att-1' } }], '图里是什么？'),
        { images: IMG },
      )
      const contents = envelope.request.contents
      // 找到带 inlineData 的那条 user content。
      const imageIndex = contents.findIndex((c) => c.parts.some((p) => p.inlineData !== undefined))
      expect(imageIndex, '内层图片没有上 wire ⇒ 静默丢图（原始缺陷复现）').toBeGreaterThan(-1)
      // ⚠️ 核心：图与提问**同一条**（分开会让模型看不见图，见 IKLIFH）。
      const askIndex = contents.findIndex((c) => c.parts.some((p) => p.text === '图里是什么？'))
      expect(askIndex, '提问不得被丢弃').toBeGreaterThan(-1)
      expect(imageIndex, '图与提问分处两条 content ⇒ 上游/模型会忽略图片（IKLIFH 同型）').toBe(askIndex)
      // 图必须排在正文之前（与 buddy / openai-compat 的顺序一致）。
      const parts = contents[imageIndex]!.parts
      expect(parts[0], '图片应排在正文之前').toHaveProperty('inlineData')
    })

    it('②（判别）纯图片工具结果的正文不得是空串（否则模型以为「工具没有输出」）', () => {
      const envelope = translate(
        withToolResult([{ type: 'image', attachment: { attachmentId: 'att-1' } }], '图里是什么？'),
        { images: IMG },
      )
      const fnResponse = envelope.request.contents
        .flatMap((c) => c.parts)
        .find((p) => p.functionResponse !== undefined)?.functionResponse
      expect(fnResponse, '工具结果必须下发').toBeDefined()
      const content = String((fnResponse!.response as { content?: unknown }).content ?? '')
      expect(
        content,
        '正文为空 ⇒ 模型会说「Read 没有返回内容」，用户误判成模型没有视觉能力',
      ).not.toBe('')
      expect(content, '至少要说明「输出在这里、只是它是图片」').toMatch(/image/i)
    })

    it('③（对照）文字+图时正文照旧保留（有图不得吞掉同一结果里的文字）', () => {
      const envelope = translate(
        withToolResult([
          { type: 'text', text: '截图如下' },
          { type: 'image', attachment: { attachmentId: 'att-1' } },
        ], '图里是什么？'),
        { images: IMG },
      )
      const fnResponse = envelope.request.contents
        .flatMap((c) => c.parts)
        .find((p) => p.functionResponse !== undefined)?.functionResponse
      expect((fnResponse!.response as { content?: unknown }).content).toBe('截图如下')
      expect(JSON.stringify(envelope), '图不得因为改了正文兜底而丢失').toContain('inlineData')
    })

    it('④（对照）无图工具结果逐字节不变（不凭空引入 inlineData）', () => {
      const envelope = translate(READ_TOOL)
      expect(JSON.stringify(envelope)).not.toContain('inlineData')
      expect(envelope.request.contents[2]?.parts?.[0]).toEqual({
        functionResponse: { name: 'read_file', response: { content: '内容' } },
      })
    })

    it('⑤（判别）工具结果内层图读不到字节时**抛错**，不静默丢图', () => {
      expect(() => translate(
        withToolResult([{ type: 'image', attachment: { attachmentId: 'att-missing' } }], '看图'),
        { images: new Map() },
      )).toThrowError(/工具结果里的图片未能内联/)
    })

    /**
     * ⑥ 历史**以工具结果结尾**（后面没有提问可搭车）时，挂起的图仍必须发出去。
     *
     * 这是挂图队列的**尾部兜底**分支：写漏了它，图会在队列里被静默丢掉 ——
     * 而这条路径在真实会话里是常见的（工具跑完、用户还没发下一句）。
     */
    it('⑥（判别）历史以工具结果结尾时，挂起的图仍必须发出（不得留在队列里丢掉）', () => {
      const envelope = translate(
        withToolResult([{ type: 'image', attachment: { attachmentId: 'att-1' } }], undefined),
        { images: IMG },
      )
      expect(
        JSON.stringify(envelope),
        '尾部兜底缺失 ⇒ 工具结果是最后一条时图片被静默丢弃',
      ).toContain('inlineData')
    })
  })

  it('工具声明走 functionDeclarations 且 schema 已清洗；tool_choice 映射 none/tool 名', () => {
    const messages = [msg('user', [{ type: 'text', text: 'hi' }])]
    const tools = [{
      name: 'read_file',
      description: '读文件',
      parameters: { type: 'object', $schema: 'x', properties: { path: { type: 'string' } } },
    }]
    const auto = translate(messages, { tools })
    expect(auto.request.tools).toEqual([{
      functionDeclarations: [{
        name: 'read_file',
        description: '读文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    }])
    expect(auto.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } })
    expect(translate(messages, { tools, toolChoice: 'none' }).request.toolConfig)
      .toEqual({ functionCallingConfig: { mode: 'NONE' } })
    expect(translate(messages, { tools, toolChoice: { type: 'tool', name: 'read_file' } }).request.toolConfig)
      .toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] } })
  })
})

describe('响应翻译', () => {
  it('functionCall → tool-call 块并回调签名；thought text → reasoning 块；usage 扣掉缓存', () => {
    const signatures: Array<[string, string, string]> = []
    const translated = translateGeminiResponse({
      response: {
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { text: '先看看目录', thought: true, thoughtSignature: 'SIG_A' },
              { functionCall: { name: 'read_file', args: { path: 'a.go' } }, thoughtSignature: 'SIG_FC' },
            ],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: {
          promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 30,
          totalTokenCount: 180, cachedContentTokenCount: 20,
        },
      },
      onSignature: (name, argsJson, signature) => signatures.push([name, argsJson, signature]),
    })
    expect(translated.blocks[0]).toEqual({ type: 'reasoning', text: '先看看目录' })
    expect(translated.blocks[1]).toMatchObject({
      type: 'tool-call', name: 'read_file', arguments: '{"path":"a.go"}',
    })
    // ⚠️ 只存 functionCall 上的签名（纯文本 part 的签名不回传，存了是噪音）。
    expect(signatures).toEqual([['read_file', '{"path":"a.go"}', 'SIG_FC']])
    expect(translated.reason).toEqual({ kind: 'tool-calls' })
    expect(translated.usage).toEqual({
      inputTokens: 80,
      cacheReadTokens: 20,
      outputTokens: 50,
      totalTokens: 180,
      reasoningTokens: 30,
    })
  })

  it('finishReason 映射；usage 缺字段时不产出 undefined 键', () => {
    expect(mapGeminiFinish('MAX_TOKENS', 0)).toEqual({ kind: 'max-tokens' })
    expect(mapGeminiFinish('STOP', 0)).toEqual({ kind: 'stop' })
    expect(mapGeminiFinish('SOMETHING_NEW', 0)).toEqual({ kind: 'stop' })
    expect(mapGeminiFinish('STOP', 2)).toEqual({ kind: 'tool-calls' })

    // promptTokenCount 含缓存，不减会双重计费。
    expect(readGeminiUsage({ promptTokenCount: 10, cachedContentTokenCount: 25 })).toEqual({
      inputTokens: 0,
      cacheReadTokens: 25,
    })
    // ★ PR #122：明确上报的 0 与「未上报」必须分开 ——
    // 0 = 这次确实没命中（面板该显示 0%），undefined = 上游不给这个数（该不显示）。
    // 旧实现 `cached > 0 ? … : {}` 会把两者折成同一个。
    expect(readGeminiUsage({ promptTokenCount: 10, cachedContentTokenCount: 0 })).toEqual({
      inputTokens: 10,
      cacheReadTokens: 0,
    })
    expect(readGeminiUsage(undefined)).toEqual({})
  })
})

describe('SSE 消费器', () => {
  it('思考 → 文本 → 工具调用，块序号连续；签名回调只对 functionCall 触发', async () => {
    const signatures: Array<[string, string, string]> = []
    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of consumeGeminiSse({
      body: sseStream(
        frame({ candidates: [{ content: { parts: [{ text: '先看看目录', thought: true, thoughtSignature: 'SIG_A' }] } }] }) +
        frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.go' } }, thoughtSignature: 'SIG_FC' }] } }] }) +
        frame({ candidates: [{ content: { parts: [{ text: '完成' }] }, finishReason: 'STOP' }] }) +
        'data: [DONE]\n\n',
      ),
      onSignature: (name, argsJson, signature) => signatures.push([name, argsJson, signature]),
    })) {
      chunks.push(chunk as Record<string, unknown>)
    }

    const starts = chunks.filter((chunk) => chunk.type === 'block-start')
    expect(starts.map((chunk) => chunk.index)).toEqual([0, 1, 2])
    expect(starts.map((chunk) => chunk.blockType)).toEqual(['reasoning', 'tool-call', 'text'])
    expect((chunks.at(-1) as { reason: unknown }).reason).toEqual({ kind: 'tool-calls' })
    // 纯文本 part 上的 SIG_A 不回传（回传了也无效，反而污染缓存）。
    expect(signatures).toEqual([['read_file', '{"path":"a.go"}', 'SIG_FC']])
  })

  it('用量取 totalTokenCount 最大的那一份；跨 chunk 切分与心跳注释行都能解析', async () => {
    const chunks = await collect(sseStream([
      ': keep-alive\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},',
      '"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":5,"promptTokenCount":3,"candidatesTokenCount":2}}}\n\n',
      frame({ usageMetadata: { totalTokenCount: 13, promptTokenCount: 7, candidatesTokenCount: 4, thoughtsTokenCount: 2 } }),
      'data: [DONE]\n\n',
    ]))
    const usage = chunks.find((chunk) => chunk.type === 'usage') as { usage: Record<string, number> }
    expect(usage.usage.totalTokens).toBe(13)
    expect(usage.usage.outputTokens).toBe(4)
    expect(usage.usage.reasoningTokens).toBe(2)
    expect((chunks.at(-1) as { reason: unknown }).reason).toEqual({ kind: 'stop' })
  })

  it('空响应抛错（静默结束会让 harness 不重试）', async () => {
    await expect(collect(sseStream('data: [DONE]\n\n'))).rejects.toThrowError(/未返回任何内容块/)
  })
})
