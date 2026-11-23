import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { BlockAssembler, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { doubaoAmount, doubaoQuotaWindows, doubaoSubscriptionName, doubaoRemoteModels, doubaoTagList, doubaoTagSuffix, parseDoubaoEnvelope, doubaoErrorText } from '../../src/doubao-upstream.js'
import { DoubaoAdapter, parseDoubaoFrames, doubaoTextDeltaOf, doubaoStreamErrorOf, buildDoubaoChatBody, DOUBAO_FALLBACK_MODELS } from '../../src/doubao-adapter.js'
import { DOUBAO_BRIEF_LIST_PATH, DOUBAO_CHAT_PATH } from '../../src/doubao-upstream.js'
import { readCatalogCache, setCatalogCacheEnabledForTest, writeCatalogCache } from '../../src/model-catalog-cache.js'

const options: GenerateOptions = {
  provider: 'doubao',
  model: 'person-deepseek-v4-1-flash-261017',
  messages: [{ role: 'user', content: [{ type: 'text', text: '测试' }] }],
}

function adapterWithResponse(raw: string): DoubaoAdapter {
  return new DoubaoAdapter({
    credentialRef: credentialRef('DOUBAO_TEST'),
    slots: async () => [{ accountId: 'test', credential: { cookie: 'sessionid=test' } }],
    fetchImpl: async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }),
  })
}

describe('doubao quota parsing', () => {
  it('parses thousand-separated amounts and <1', () => {
    expect(doubaoAmount('1,600')).toBe(1600)
    expect(doubaoAmount('9,000')).toBe(9000)
    expect(doubaoAmount('<1')).toBe(1)
    expect(doubaoAmount('0.65x')).toBeUndefined()
    expect(doubaoAmount(1600)).toBe(1600)
  })

  it('reads windows from both sections', () => {
    const env = { code: 0, data: { current_subscription: { display: { short_name: '免费体验' } }, incentive_quota_section: { window_limit_groups: [{ feature_group: 'doubao_activity_reward_quota', feature_group_name: '活动赠送额度', window_limits: [{ total_amount: '1,600', used_amount: '<1', end_time: 1795413494808 }] }] }, window_limit_section: {} } }
    const wins = doubaoQuotaWindows(env)
    expect(wins).toHaveLength(1)
    expect(wins[0].total).toBe(1600)
    expect(wins[0].featureGroupName).toBe('活动赠送额度')
    expect(doubaoSubscriptionName(env)).toBe('免费体验')
  })

  it('reads quota from real captured response', () => {
    const raw = '{"data":{"current_subscription":{"display":{"product_name":"个人订阅","short_name":"免费体验"}},"incentive_quota_section":{"window_limit_groups":[{"feature_group":"doubao_activity_reward_quota","feature_group_name":"活动赠送额度","window_limits":[{"end_time":1795413494808,"total_amount":"1,600","used_amount":"<1","used_percent":0}]}]},"window_limit_section":{}},"code":0}'
    const env = parseDoubaoEnvelope(raw)!
    expect(env.code).toBe(0)
    expect(doubaoQuotaWindows(env)[0].total).toBe(1600)
  })

  it('surfaces upstream error text', () => {
    const env = parseDoubaoEnvelope('{"data":null,"code":710010202,"msg":"系统错误","message":"common invalid param"}')!
    expect(doubaoErrorText(env)).toBe('common invalid param')
  })
})

describe('doubao model catalog parsing', () => {
  it('extracts models from nested tree, de-dups by key', () => {
    const payload = { data: { entry_list: [
      { model_item_key: 'seed-lite-7b', name: '豆包 2.1 Lite', default_mode: 3, tag_list: ['限时优惠 0.01x'] },
      { model_item_key: 'seed-lite-7b', name: '' },
      { nested: [ { model_item_key: '5', name: '豆包 2.1 Pro', default_mode: 3, tag_list: [{ text: '0.65x' }] } ] },
    ] } }
    const models = doubaoRemoteModels(payload)
    expect(models).toHaveLength(2)
    expect(models[0].name).toBe('豆包 2.1 Lite')
    expect(models[0].modeId).toBe('3')
    expect(models[1].tags).toEqual(['0.65x'])
  })

  it('uses reasoning levels only from a model-menu mode that enables them', () => {
    const item = {
      model_item_key: 'flash', name: 'Flash', default_mode: 3,
      reasoning_effort_config: { option_list: [{ level: 3, name: '低' }, { level: 7, name: '最高' }] },
    }
    const models = doubaoRemoteModels({ data: { entry_list: [{ active_switch_conf: { menu_conf_v2: { mode_list: { item_list: [
      { mode_id: '1', show_reasoning_effort: false, model_list: { item_list: [item] } },
      { mode_id: '3', show_reasoning_effort: true, model_list: { item_list: [item] } },
    ] } } } }] } })
    expect(models).toHaveLength(1)
    expect(models[0].reasoning?.efforts).toEqual([{ id: '3', name: '低' }, { id: '7', name: '最高' }])
    const disabled = doubaoRemoteModels({ data: { entry_list: [{ active_switch_conf: {
      menu_conf_v2: { mode_list: { item_list: [{
        mode_id: '1', show_reasoning_effort: false, model_list: { item_list: [item] },
      }] } },
    } }] } })
    expect(disabled[0].reasoning).toBeUndefined()
  })

  it('does not transfer task efforts to a default chat route, regardless of menu order', () => {
    const model = { model_item_key: 'shared', name: 'Shared', default_mode: 1 }
    const chat = { mode_id: '1', show_reasoning_effort: false, model_list: { item_list: [model] } }
    const task = { mode_id: '3', show_reasoning_effort: true, model_list: { item_list: [{
      ...model, reasoning_effort_config: { option_list: [{ level: 7, name: '最高' }] },
    }] } }
    for (const modes of [[chat, task], [task, chat]]) {
      expect(doubaoRemoteModels({ mode_list: { item_list: modes } })).toEqual([
        { key: 'shared', name: 'Shared', modeId: '1', tags: [] },
      ])
    }
  })

  it('parses tag list (string + {text} shapes)', () => {
    expect(doubaoTagList(['小额免费', { text: '0.65x' }, 42])).toEqual(['小额免费', '0.65x'])
    expect(doubaoTagSuffix(['限时优惠 0.01x'])).toBe('限时优惠 0.01x')
  })

  it('has a 14+ model fallback snapshot', () => {
    expect(DOUBAO_FALLBACK_MODELS.length).toBeGreaterThanOrEqual(14)
    expect(DOUBAO_FALLBACK_MODELS.some((m) => m.key === 'person-qwen4-max')).toBe(true)
  })
})

describe('doubao stream frame parsing', () => {
  const sample = [
    'id: 0', 'event: SSE_HEARTBEAT', 'data: {}', '',
    'id: 1', 'event: STREAM_CHUNK', 'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"你好"}}}]}}]}', '',
    'id: 2', 'event: STREAM_CHUNK', 'data: {"patch_op":[{"patch_value":{"block_type":10000,"content":{"text_block":{"text":"，世界"}}}}]}', '',
    'id: 3', 'event: SSE_REPLY_END', 'data: {"end_type":3}', '',
  ].join('\n')

  it('parses three-line frames', () => {
    const frames = parseDoubaoFrames(sample)
    expect(frames).toHaveLength(4)
    expect(frames[1].event).toBe('STREAM_CHUNK')
  })

  it('extracts text deltas from block_type 10000', () => {
    const frames = parseDoubaoFrames(sample)
    const deltas = frames.map((f) => doubaoTextDeltaOf(f.data)).filter((t) => t.length > 0)
    expect(deltas).toEqual(['你好', '，世界'])
  })

  it('detects in-stream business errors', () => {
    expect(doubaoStreamErrorOf('{"code":710022004,"msg":"rate limited"}')).toEqual({ code: 710022004, message: 'rate limited' })
    expect(doubaoStreamErrorOf('{"code":0}')).toBeUndefined()
  })

  it('preserves every text delta in the final DSH assistant block', async () => {
    const assembler = new BlockAssembler()
    const chunks: StreamChunk[] = []
    for await (const chunk of adapterWithResponse(sample).stream(options)) {
      chunks.push(chunk)
      assembler.push(chunk)
    }

    const deltas = chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : [])
    expect(deltas).toEqual(['你好', '，世界'])
    const block = { type: 'text', text: deltas.join('') }
    expect(assembler.blocks()).toEqual([block])
    expect(chunks.slice(-2)).toEqual([
      { type: 'block-end', index: 0, block },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('reports EMPTY_RESPONSE instead of success when there is no text', async () => {
    const raw = 'id: 0\nevent: SSE_REPLY_END\ndata: {"end_type":3}\n\n'
    await expect(async () => {
      for await (const _chunk of adapterWithResponse(raw).stream(options)) void _chunk
    }).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })
})

describe('doubao chat body', () => {
  it('routes chat models to agent_mode 2 / mode_id 1', () => {
    const body = JSON.parse(buildDoubaoChatBody({ provider: 'doubao', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], model: '0' }, DOUBAO_FALLBACK_MODELS[0]!))
    expect(body.option.agent_mode).toBe(2)
    expect(body.option.conversation_init_ext.mode_id).toBe('1')
    expect(body.option.conversation_init_ext.model_item_key).toBe('0')
  })

  it('routes task models to agent_mode 1 / mode_id 3', () => {
    const model = DOUBAO_FALLBACK_MODELS.find((m) => m.modeId === '3')!
    const body = JSON.parse(buildDoubaoChatBody({ provider: 'doubao', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], model: model.key }, model))
    expect(body.option.agent_mode).toBe(1)
    expect(body.option.conversation_init_ext.mode_id).toBe('3')
  })

  it('uses the independent task-mode deep-think switch with an explicit effort', () => {
    const base = DOUBAO_FALLBACK_MODELS.find((m) => m.key === 'person-deepseek-v4-1-flash-261017')!
    const task = { ...base, modeId: '3' }
    const selected: GenerateOptions = { ...options, reasoningEffort: '6' as GenerateOptions['reasoningEffort'] }
    const body = JSON.parse(buildDoubaoChatBody(selected, task))
    expect(body.option.need_deep_think).toBe(10001)
    expect(body.ext.use_deep_think).toBe('10001')
    expect(body.option.conversation_init_ext.reasoning_effort).toBe('6')
  })

  it('keeps the existing deep-think-off request when no effort is selected', () => {
    const model = DOUBAO_FALLBACK_MODELS.find((m) => m.key === 'person-deepseek-v4-1-flash-261017')!
    const body = JSON.parse(buildDoubaoChatBody({ ...options }, model))
    expect(body.option.need_deep_think).toBe(0)
    expect(body.ext.use_deep_think).toBe('0')
    expect(body.option.conversation_init_ext.reasoning_effort).toBe('4')
  })

  it('rejects an effort not advertised for the selected model', () => {
    const chat = DOUBAO_FALLBACK_MODELS.find((m) => m.key === '0')!
    const selected: GenerateOptions = { ...options, reasoningEffort: '4' as GenerateOptions['reasoningEffort'] }
    expect(() => buildDoubaoChatBody(selected, chat)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })

  it('uses only a selected, model-advertised reasoning effort', () => {
    const model = DOUBAO_FALLBACK_MODELS.find((m) => m.key === 'person-deepseek-v4-1-flash-261017')!
    const selected: GenerateOptions = { ...options, reasoningEffort: '7' as GenerateOptions['reasoningEffort'] }
    const body = JSON.parse(buildDoubaoChatBody(selected, model))
    expect(body.option.need_deep_think).toBe(10001)
    expect(body.ext.use_deep_think).toBe('10001')
    expect(body.option.conversation_init_ext.reasoning_effort).toBe('7')
    expect(body.option.model_config.reasoning_effort).toBe('7')
    expect(body.option.aggregate_params.reasoning_effort).toBe('7')
  })
})

describe('doubao reasoning catalog and stream blocks', () => {
  const flash = 'person-deepseek-v4-1-flash-261017'

  const thinkingSample = [
    ['FULL_MSG_NOTIFY', { message: { user_type: 1, content: { content_block: [
      { block_type: 10000, block_id: 'user-echo', content: { text_block: { text: '不要回显用户消息' } } },
    ] } } }],
    ['STREAM_MSG_NOTIFY', { message: { content: { content_block: [
      { block_type: 10040, block_id: 'think-header', content: {} },
      { block_type: 10000, block_id: 'think-body', parent_id: 'think-header', content: { text_block: { text: '先分析' } } },
    ] } } }],
    ['STREAM_CHUNK', { patch_op: [
      { patch_object: 1, patch_value: { content_block: [
        { block_type: 10000, block_id: 'think-body', parent_id: 'think-header', content: { text_block: { text: '继续' } } },
      ] } },
      { patch_object: 111, patch_value: { content_block: [
        { block_type: 10000, block_id: 'tts-copy', content: { text_block: { text: '不能展示的TTS副本' } } },
      ] } },
    ] }],
    ['STREAM_CHUNK', { patch_op: [{ patch_value: { content_block: [
      { block_type: 10000, block_id: 'answer', content: { text_block: { text: '回答' } } },
    ] } }] }],
    // A late thinking completion and replay must not steal the answer's following deltas.
    ['STREAM_CHUNK', { patch_op: [{ patch_value: { content_block: [
      { block_type: 10000, block_id: 'think-body', content: { text_block: { text: '' } } },
    ] } }] }],
    ['CHUNK_DELTA', { text: '完' }],
    ['STREAM_MSG_NOTIFY', { message: { content: { content_block: [
      { block_type: 10000, block_id: 'think-body', content: { text_block: { text: '先分析' } } },
    ] } } }],
    ['CHUNK_DELTA', { text: '成' }],
    ['SSE_REPLY_END', { end_type: 3 }],
  ].map(([event, payload], index) => [
    'id: ' + index,
    'event: ' + event,
    'data: ' + JSON.stringify(payload),
    '',
  ].join('\n')).join('\n')

  it('loads model-advertised efforts from a mocked menu response and notifies DSH once', async () => {
    let fetchCount = 0
    let loadedCount = 0
    const model = {
      model_item_key: flash, name: 'Flash', default_mode: 3,
      reasoning_effort_config: { option_list: [{ level: 3, name: '低' }, { level: 7, name: '最高' }] },
    }
    const envelope = {
      code: 0,
      data: { entry_list: [{ active_switch_conf: { menu_conf_v2: { mode_list: { item_list: [
        { mode_id: '3', show_reasoning_effort: true, model_list: { item_list: [model] } },
      ] } } } }] },
    }
    const adapter = new DoubaoAdapter({
      credentialRef: credentialRef('DOUBAO_TEST'),
      slots: async () => [{ accountId: 'test', credential: { cookie: 'sessionid=test' } }],
      fetchImpl: async () => { fetchCount++; return new Response(JSON.stringify(envelope)) },
      onCatalogLoaded: () => { loadedCount++ },
    })
    const resolved = await adapter.resolveModel('doubao', flash)
    await adapter.resolveModel('doubao', flash)
    expect(resolved.reasoning?.efforts.map((effort) => String(effort.id))).toEqual(['3', '7'])
    expect(fetchCount).toBe(1)
    expect(loadedCount).toBe(1)
  })

  it('uses the remote-only route and efforts even with a fresh display-only disk cache', async () => {
    const id = 'remote-task-only'
    const home = mkdtempSync(join(tmpdir(), 'doubao-pr-catalog-'))
    const savedHome = process.env.DSH_HOME
    const bodies: Array<ReturnType<typeof JSON.parse>> = []
    const taskMenu = (level: number) => ({ code: 0, data: { mode_list: { item_list: [
      { mode_id: '3', show_reasoning_effort: true, model_list: { item_list: [{
        model_item_key: id, name: 'Fresh', default_mode: 3,
        reasoning_effort_config: { option_list: [{ level, name: '任务档位' }] },
      }] } },
    ] } } })
    try {
      process.env.DSH_HOME = home
      setCatalogCacheEnabledForTest(true)
      expect(writeCatalogCache('doubao', [{ id, name: 'Stale' }], true)).toBe(true)
      let level = 7
      const adapter = new DoubaoAdapter({
        credentialRef: credentialRef('DOUBAO_TEST'),
        slots: async () => [{ accountId: 'test', credential: { cookie: 'sessionid=test' } }],
        fetchImpl: async (input, init) => {
          const path = new URL(String(input)).pathname
          if (path === DOUBAO_BRIEF_LIST_PATH) return Response.json(taskMenu(level))
          expect(path).toBe(DOUBAO_CHAT_PATH)
          bodies.push(JSON.parse(String(init?.body)))
          const text = { patch_op: [{ patch_value: { block_type: 10000, content: { text_block: { text: '只有回答' } } } }] }
          return new Response('event: STREAM_CHUNK\ndata: ' + JSON.stringify(text) + '\n\nevent: SSE_REPLY_END\ndata: {}\n\n')
        },
      })
      expect(await adapter.listModels('doubao')).toEqual([expect.objectContaining({ id, name: 'Fresh' })])
      expect(readCatalogCache('doubao')?.[0]?.name).toBe('Stale')
      const prepared = await adapter.prepareCall('doubao', id)
      expect(prepared.model.reasoning).toEqual({ efforts: [{ id: '7', name: '任务档位' }] })
      // Refresh may change the menu, but cannot change the route/efforts of a prepared call.
      level = 5
      await adapter.refresh()
      expect((await adapter.resolveModel('doubao', id)).reasoning?.efforts.map((e) => e.id)).toEqual(['5'])
      const assembler = new BlockAssembler()
      const selected = { ...options, model: id, reasoningEffort: '7' as GenerateOptions['reasoningEffort'] }
      for await (const chunk of prepared.stream(selected)) assembler.push(chunk)
      expect(bodies).toHaveLength(1)
      expect(bodies[0].option).toMatchObject({
        agent_mode: 1, need_deep_think: 10001,
        conversation_init_ext: { model_item_key: id, mode_id: '3', reasoning_effort: '7' },
        model_config: { reasoning_effort: '7' }, aggregate_params: { reasoning_effort: '7' },
      })
      expect(assembler.blocks()).toEqual([{ type: 'text', text: '只有回答' }])
    } finally {
      setCatalogCacheEnabledForTest(false)
      if (savedHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not expose transport exception messages in warnings or chat errors', async () => {
    const cookie = 'sessionid=synthetic-secret-for-test'
    const warnings: string[] = []
    const adapter = new DoubaoAdapter({
      credentialRef: credentialRef('DOUBAO_TEST'),
      slots: async () => [{ accountId: 'test', credential: { cookie } }],
      fetchImpl: async () => { throw new Error('request included ' + cookie) },
      warn: (message) => { warnings.push(message) },
    })
    await expect(async () => {
      for await (const chunk of adapter.stream(options)) void chunk
    }).rejects.toMatchObject({ code: 'SERVER', message: '豆包：读取上游对话响应失败' })
    expect(warnings).toEqual(['[doubao] 模型目录读取失败，使用快照'])
  })

  it('exposes only efforts enabled by the model menu and flags no implicit default', async () => {
    const model = await adapterWithResponse('').resolveModel('doubao', flash)
    expect(model.reasoning?.efforts.map((effort) => [String(effort.id), effort.name])).toEqual([
      ['3', '低'], ['4', '中'], ['5', '高'], ['6', '极高'], ['7', '最高'],
    ])
    expect(model.reasoning?.defaultEffort).toBeUndefined()
    expect((await adapterWithResponse('').resolveModel('doubao', '0')).reasoning).toBeUndefined()
  })

  it('flushes pending marker prefixes in both reasoning and answer blocks', async () => {
    const sample = [
      ['STREAM_MSG_NOTIFY', { message: { content: { content_block: [
        { block_type: 10040, block_id: 'thought' },
        { block_type: 10000, block_id: 'thought-text', parent_id: 'thought', content: { text_block: { text: '先分析<' } } },
      ] } } }],
      ['STREAM_CHUNK', { patch_op: [{ patch_value: { content_block: [
        { block_type: 10000, block_id: 'answer-text', content: { text_block: { text: '回答<' } } },
      ] } }] }],
      ['SSE_REPLY_END', { end_type: 3 }],
    ].map(([event, payload], index) => [
      'id: ' + index,
      'event: ' + event,
      'data: ' + JSON.stringify(payload),
      '',
    ].join('\n')).join('\n')
    const assembler = new BlockAssembler()
    for await (const chunk of adapterWithResponse(sample).stream(options)) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: '先分析<' },
      { type: 'text', text: '回答<' },
    ])
  })

  it('deduplicates replayed snapshots and emits only the cumulative block suffix', async () => {
    const fixture = [
      ['STREAM_MSG_NOTIFY', { message: { content: { content_block: [
        { block_type: 10000, block_id: 'answer-1', content: { text_block: { text: 'ab' } } },
      ] } } }],
      ['STREAM_CHUNK', { patch_op: [{ patch_object: 1, patch_value: { content_block: [
        { block_type: 10000, block_id: 'answer-1', content: { text_block: { text: 'ab' } } },
      ] } }] }],
      ['STREAM_CHUNK', { patch_op: [{ patch_object: 1, patch_value: { content_block: [
        { block_type: 10000, block_id: 'answer-1', content: { text_block: { text: 'abc' } } },
      ] } }] }],
      ['STREAM_CHUNK', { patch_op: [{ patch_object: 1, patch_value: { content_block: [
        { block_type: 10000, block_id: 'answer-1', content: { text_block: { text: '' } } },
      ] } }] }],
      ['SSE_REPLY_END', { end_type: 3 }],
    ].map(([event, payload], index) => [
      'id: ' + index,
      'event: ' + event,
      'data: ' + JSON.stringify(payload),
      '',
    ].join('\n')).join('\n')
    const assembler = new BlockAssembler()
    const chunks: StreamChunk[] = []
    for await (const chunk of adapterWithResponse(fixture).stream(options)) {
      chunks.push(chunk)
      assembler.push(chunk)
    }
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text)).toEqual(['ab', 'c'])
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'abc' }])
  })

  function emptyDeclarations(last: 'reasoning-only' | 'with-answer'): string {
    const frames: [string, unknown][] = [
      ['STREAM_MSG_NOTIFY', { message: { content: { content_block: [
        { block_type: 10040, block_id: 'thought' },
        { block_type: 10000, block_id: 'thought-text', parent_id: 'thought', content: { text_block: { text: '' } } },
      ] } } }],
      ['CHUNK_DELTA', { text: '思考内容' }],
    ]
    if (last === 'with-answer') frames.push(
      ['STREAM_CHUNK', { patch_op: [{ patch_value: { content_block: [
        { block_type: 10000, block_id: 'answer-text', content: { text_block: { text: '' } } },
      ] } }] }],
      ['CHUNK_DELTA', { text: '最终正文' }],
    )
    frames.push(['SSE_REPLY_END', { end_type: 3 }])
    return frames.map(([event, data]) => 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n').join('')
  }

  it('lets new empty declarations own the subsequent id-less text', async () => {
    const assembler = new BlockAssembler()
    for await (const chunk of adapterWithResponse(emptyDeclarations('with-answer')).stream(options)) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: '思考内容' },
      { type: 'text', text: '最终正文' },
    ])
  })

  /**
   * ★★★ **2026-11-23 改（issue #150 第 4 条）：这条用例原本锁的是缺陷本身。**
   *
   * 旧断言：`reasoning-only ⇒ rejects EMPTY_RESPONSE`。
   *
   * 但「只返回思考、没有正文」是**上游返回的成功响应**，不是失败。把它判空的实际后果是：
   * `stream()` 认为这个账号不可用 ⇒ **换下一个账号重发同一份请求**（实测 2 账号 ⇒ 2 次
   * 完整请求，每次都带着满满的思考正文）⇒ 白烧两倍额度，还可能把账号状态搞脏。
   *
   * ⇒ 判据从「有没有正文」改成「**有没有任何可交付内容**」（思考也算内容），
   *   所以现在应当是**成功收尾**：有 reasoning 增量、并以 `finish/stop` 结束。
   */
  it('counts a reasoning-only response as a successful answer (issue #150)', async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapterWithResponse(emptyDeclarations('reasoning-only')).stream(options)) {
      chunks.push(chunk)
    }
    // 思考帧必须真的交付出去（旧路径这里一段都不会吐，因为整条被判空）。
    expect(chunks.some((chunk) => chunk.type === 'reasoning-delta')).toBe(true)
    // 且必须以正常收尾结束 —— 不是 EMPTY_RESPONSE、也不是任何失败。
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  /**
   * ⚠️⚠️ **已知限制：匿名块（无 `block_id`）的重复快照会让正文翻倍**（issue #150 第 3 条）。
   *
   * 本用例**不断言「已修好」**，而是把**当前真实行为**钉住，免得将来有人以为它已经修了。
   *
   * ## 为什么没修
   *
   * 第一版给匿名块合成过 key（`anon:${kind}`）试图修掉翻倍。**正向审计实测那是倒退**：
   * 合成 key 每个 kind 只有一个槽 ⇒ 同一次快照里出现**多个匿名块**时，第二个块起会把
   * 上一块的内容当成自己「历史前缀」⇒ **整段丢弃**；最坏形态（匿名「思考 + 正文」同快照）
   * ⇒ **只留思考、正文静默消失**。
   *
   * ⇔ 翻倍是**可见且可恢复**的；丢内容是**静默**的。⇒ 回退到旧语义。
   *
   * 真要修，需要给匿名块一个**跨快照稳定**的身份 —— 而它天生没有
   *（区分「同一块重发」与「另一个匿名块」需要上游给 id，它不给）。
   */
  it('⚠️ 已知限制：匿名块重复快照仍会翻倍（未修，见 issue #150）', async () => {
    const snapshot = (text: string) => 'event: STREAM_MSG_NOTIFY\ndata: ' + JSON.stringify({
      message: { content: { content_block: [
        { block_type: 10000, content: { text_block: { text } } },
      ] } },
    }) + '\n\n'
    const raw = snapshot('你好') + snapshot('你好') + 'event: SSE_REPLY_END\ndata: {"end_type":3}\n\n'
    const chunks: StreamChunk[] = []
    for await (const chunk of adapterWithResponse(raw).stream(options)) chunks.push(chunk)
    const body = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    // ⚠️ 这就是**当前**（也是 master 的）行为：翻倍。改成 `toBe('你好')` 的那天，
    //    请同时把那条长注释删掉，并在 #150 里标记该条已修。
    expect(body, '⚠️ 已知限制：匿名块无身份 ⇒ 重复快照会翻倍').toBe('你好你好')
  })

  /**
   * ★★★ **多个匿名块不得互相吞掉**（这是回退那条修复的**理由**，必须钉住）。
   *
   * 第一版合成 key（每 kind 一槽）会让**第二个匿名块**把第一块的内容当成自己的前缀
   * ⇒ 整段丢弃。本用例保证：即使处理方式是「不去重」，**两块的内容都必须完整交付**。
   */
  it('keeps every anonymous block when several appear in one snapshot (issue #150)', async () => {
    const raw = 'event: STREAM_MSG_NOTIFY\ndata: ' + JSON.stringify({
      message: { content: { content_block: [
        { block_type: 10000, content: { text_block: { text: '第一块' } } },
        { block_type: 10000, content: { text_block: { text: '第二块' } } },
      ] } },
    }) + '\n\nevent: SSE_REPLY_END\ndata: {"end_type":3}\n\n'
    const chunks: StreamChunk[] = []
    for await (const chunk of adapterWithResponse(raw).stream(options)) chunks.push(chunk)
    const body = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    expect(body, '第二个匿名块不得被当成第一块的重发而丢弃').toContain('第二块')
    expect(body, '第一块也不得丢').toContain('第一块')
  })

  it('keeps the upstream message on an in-stream business error (issue #150)', async () => {
    const raw = 'event: STREAM_ERROR\ndata: '
      + JSON.stringify({ code: 710022004, msg: '当前对话人数过多，请稍后再试' })
      + '\n\n'
    await expect(async () => {
      for await (const chunk of adapterWithResponse(raw).stream(options)) void chunk
    }).rejects.toThrow(/当前对话人数过多/)
  })

  it('keeps provider reasoning and answer in distinct finalized DSH blocks', async () => {
    const assembler = new BlockAssembler()
    const chunks: StreamChunk[] = []
    for await (const chunk of adapterWithResponse(thinkingSample).stream({ ...options, model: flash })) {
      chunks.push(chunk)
      assembler.push(chunk)
    }
    expect(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text)).toEqual(['先分析', '继续'])
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text)).toEqual(['回答', '完', '成'])
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: '先分析继续' },
      { type: 'text', text: '回答完成' },
    ])
    expect(chunks.slice(-3)).toEqual([
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先分析继续' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: '回答完成' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
})
