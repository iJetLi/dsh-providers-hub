import { describe, expect, it, vi } from 'vitest'
import {
  PROVIDER,
  LobsteraiAdapter,
  buildLobsteraiModelsQuery,
  buildLobsteraiModelsUrl,
  parseLobsteraiModels,
  registerLobsteraiLlm,
} from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

const CLIENT_VERSION = '2026.9.4'

function makeCredential(overrides: Partial<LobsteraiCredential> = {}): LobsteraiCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    uid: 'uid-1',
    user_id: 'yid-1',
    nickname: '测试账号',
    uuid: 'uuid-1',
    first_keyfrom: '1700000000000',
    latest_keyfrom: '1700000000000',
    ...overrides,
  }
}

/** 构造一个 SSE 响应体。 */
function sseResponse(chunks: string[]): Response {
  const body = chunks.map((chunk) => `data: ${chunk}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 一次普通的文本回复。 */
function textSse(text: string): Response {
  return sseResponse([
    JSON.stringify({ id: 'c1', model: 'glm-5.2', choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ])
}

/** 构造适配器 + 捕获请求的 fetch stub。 */
function makeAdapter(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
  options: Partial<ConstructorParameters<typeof LobsteraiAdapter>[0]> = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init)
  }) as unknown as typeof fetch
  const adapter = new LobsteraiAdapter({
    credentialRef: credentialRef('LOBSTERAI_ACCOUNT_TEST'),
    resolveCredential: async () => makeCredential(),
    refresh: async () => {},
    fetchImpl: fetcher,
    resolveClientVersion: async () => CLIENT_VERSION,
    product: LOBSTERAI,
    ...options,
  })
  return { adapter, calls, fetcher }
}

function generateOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'lobsterai',
    model: 'glm-5.2',
    messages: [createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

/** 收集 stream() 的全部 chunk。 */
async function collect(options: GenerateOptions, adapter: LobsteraiAdapter) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

describe('LobsterAI 模型列表解析', () => {
  /**
   * **真实线上形态**（2026-09-17 实测，`{code:0, message:'success', data:[...]}`）。
   *
   * 这是本模块历史上最严重的一处缺陷：早先的实现复用 `parseLobsteraiEnvelope`，
   * 而该信封要求 `data` 必须是**对象**（用于判定「凭据失效返回 data:null」），
   * 于是本端点恒被判成失败、模型列表恒为空数组、适配器静默回退静态兜底表。
   * 症状是「远端已上线的新模型（deepseek-flash / glm-5.3-flash 等）在面板里
   * 看不到」，且不报任何错。这条断言锁死单层形状必须被解析。
   */
  it('解析**单层** data 数组（真实线上形态）', () => {
    expect(parseLobsteraiModels({
      code: 0, message: 'success',
      data: [
        { modelId: 'deepseek-flash', modelName: 'DeepSeek-V4.1-Flash', provider: 'LobsterAI', apiFormat: 'openai' },
        { modelId: 'glm-5.3-flash', modelName: 'GLM-5.3-Flash', provider: 'LobsterAI', apiFormat: 'openai' },
      ],
    })).toEqual([
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
    ])
  })

  it('解析 data.data 数组（双层形态，兼容 Go 桥接层记录）', () => {
    // 双层：外层是统一信封 {code,msg,data}，内层 data 才是模型数组。
    // 两种形状都要认 —— 不能为修单层而砍掉双层。
    expect(parseLobsteraiModels({
      code: 0, msg: 'OK',
      data: { data: [{ modelId: 'glm-5.2', modelName: 'GLM-5.2', provider: 'p', apiFormat: 'openai' }] },
    })).toEqual([{ id: 'glm-5.2', name: 'GLM-5.2' }])
  })

  it('缺 modelName 时以 id 兜底', () => {
    expect(parseLobsteraiModels({ code: 0, data: [{ modelId: 'm1' }] }))
      .toEqual([{ id: 'm1', name: 'm1' }])
  })

  it('跳过缺 modelId 的条目', () => {
    expect(parseLobsteraiModels({
      code: 0, data: [{ modelName: 'x' }, { modelId: 'm1' }],
    })).toEqual([{ id: 'm1', name: 'm1' }])
  })

  it('业务码非 0、data 为 null、结构不符时返回空数组（调用方回退兜底目录）', () => {
    for (const bad of [
      { code: 500, msg: 'boom' },
      { code: 0, data: null },
      { code: 0, data: {} },
      { code: 0, data: { data: 'nope' } },
      null, 'x', 42,
    ]) {
      expect(parseLobsteraiModels(bad)).toEqual([])
    }
  })
})

/**
 * 远端下发的模型**参数**解析。
 *
 * 远端每个模型除 id/name 外还带 `contextWindow` / `supportsImage` /
 * `supportsThinking` / `thinkingConfig` / `requestCapabilities` / `maxTokens`
 * / `description`（2026-09-17 实测）。这些是模型选择器与请求构造的权威依据，
 * 早先实现把它们全部丢弃，导致上下文窗口用的是兜底表估值、模态恒为 text。
 */
describe('LobsterAI 远端模型参数解析', () => {
  /** 一个贴近真实响应的模型条目。 */
  const rawModel = {
    modelId: 'deepseek-flash',
    modelName: 'DeepSeek-V4.1-Flash',
    provider: 'LobsterAI',
    apiFormat: 'openai',
    runtimeProfile: null,
    supportsImage: true,
    supportsThinking: true,
    thinkingConfig: {
      options: [
        { level: 'off', openclawLevel: 'off' },
        { level: 'high', openclawLevel: 'high' },
        { level: 'max', openclawLevel: 'xhigh' },
      ],
      defaultLevel: 'high',
    },
    requestCapabilities: ['lobsterai-options-v1'],
    contextWindow: 1_000_000,
    maxTokens: null,
    description: 'DeepSeek V4.1 Flash 原生多模态。',
  }

  it('解析 contextWindow / supportsImage / supportsThinking / description', () => {
    const [model] = parseLobsteraiModels({ code: 0, message: 'success', data: [rawModel] })
    expect(model).toMatchObject({
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      contextWindow: 1_000_000,
      supportsImage: true,
      supportsThinking: true,
      description: 'DeepSeek V4.1 Flash 原生多模态。',
    })
  })

  it('解析 thinkingConfig 的 options 与 defaultLevel', () => {
    const [model] = parseLobsteraiModels({ code: 0, data: [rawModel] })
    expect(model!.thinkingConfig).toEqual({
      options: [
        { level: 'off', openclawLevel: 'off' },
        { level: 'high', openclawLevel: 'high' },
        { level: 'max', openclawLevel: 'xhigh' },
      ],
      defaultLevel: 'high',
    })
  })

  it('解析 requestCapabilities', () => {
    const [model] = parseLobsteraiModels({ code: 0, data: [rawModel] })
    expect(model!.requestCapabilities).toEqual(['lobsterai-options-v1'])
  })

  it('字段缺失时**不**编造值（留 undefined，而非填 0/false）', () => {
    // 区分「远端说没有」与「远端没说」：填 false 会让支持图片的模型被误判为
    // 纯文本，填 0 会让上下文窗口变成 0。
    const [model] = parseLobsteraiModels({
      code: 0, data: [{ modelId: 'bare', modelName: 'Bare' }],
    })
    expect(model).toEqual({ id: 'bare', name: 'Bare' })
    expect(model).not.toHaveProperty('contextWindow')
    expect(model).not.toHaveProperty('supportsImage')
    expect(model).not.toHaveProperty('thinkingConfig')
  })

  it('畸形 thinkingConfig 被丢弃而非解析出半截数据', () => {
    for (const bad of [
      { options: [] },
      { options: 'nope', defaultLevel: 'high' },
      { options: [{ level: 'high' }], defaultLevel: 'high' },
      { options: [{ level: 'high', openclawLevel: 'high' }] }, // 缺 defaultLevel
    ]) {
      const [model] = parseLobsteraiModels({
        code: 0, data: [{ modelId: 'm', modelName: 'M', thinkingConfig: bad }],
      })
      expect(model!.thinkingConfig, JSON.stringify(bad)).toBeUndefined()
    }
  })

  // 计费倍率：远端 `costMultiplier` 是**裸数字**（实测 0.05 / 1.08 / 20），
  // 与 buddy 系的字符串 `"x0.05"` 形态完全不同，故各自解析。
  it('costMultiplier 解析为数字（裸数字，非 buddy 的 x 前缀串）', () => {
    const [model] = parseLobsteraiModels({
      code: 0, data: [{ modelId: 'deepseek-flash', modelName: 'DS', costMultiplier: 0.05 }],
    })
    expect(model!.costMultiplier).toBe(0.05)
  })

  it('costMultiplier 缺失或非正数时不带该字段', () => {
    const [missing] = parseLobsteraiModels({ code: 0, data: [{ modelId: 'm1' }] })
    expect(missing).not.toHaveProperty('costMultiplier')
    const [zero] = parseLobsteraiModels({ code: 0, data: [{ modelId: 'm2', costMultiplier: 0 }] })
    expect(zero).not.toHaveProperty('costMultiplier')
  })

  // 订阅闸门三件套：`accessible` / `subscriptionPriority` / `restrictionHint`。
  // ⚠️ 这三个键远端**恒定下发**（2026-11-17 实测 21/21 条目都有），
  // 但本仓此前一个都没读 —— 于是「订阅专享」的模型在选择器里看起来完全可用。
  it('解析 accessible / subscriptionPriority / restrictionHint', () => {
    const [model] = parseLobsteraiModels({
      code: 0,
      data: [{
        modelId: 'qwen4-max',
        modelName: 'Qwen4-Max',
        accessible: false,
        subscriptionPriority: true,
        restrictionHint: '该模型仅限有效订阅用户使用',
      }],
    })
    expect(model).toMatchObject({
      accessible: false,
      subscriptionPriority: true,
      restrictionHint: '该模型仅限有效订阅用户使用',
    })
  })

  it('订阅三件套缺失时留 undefined（不填 false —— 「没声明」≠「不可用」）', () => {
    const [model] = parseLobsteraiModels({ code: 0, data: [{ modelId: 'bare' }] })
    expect(model).not.toHaveProperty('accessible')
    expect(model).not.toHaveProperty('subscriptionPriority')
    expect(model).not.toHaveProperty('restrictionHint')
  })

  it('装饰性脏值（字符串 "false"）按「未声明」处理，不读成可用', () => {
    // `!!'false'` 会把不可用读成可用 —— 布尔一律按 `typeof === 'boolean'` 读。
    const [model] = parseLobsteraiModels({
      code: 0, data: [{ modelId: 'm', accessible: 'false', subscriptionPriority: 'false' }],
    })
    expect(model).not.toHaveProperty('accessible')
    expect(model).not.toHaveProperty('subscriptionPriority')
  })
})

describe('LobsterAI 模型列表 query', () => {
  it('带 keyfrom 身份字段但**不含** refreshToken', () => {
    // client.go:229-241 只用 KeyfromBody 的字段；refreshToken 进 query
    // 既是信息泄露（会落在服务端访问日志），也不是该端点的预期输入。
    const query = buildLobsteraiModelsQuery(makeCredential(), CLIENT_VERSION)
    expect(query).toContain('firstKeyfrom=1700000000000')
    expect(query).toContain('version=2026.9.4')
    expect(query).toContain('uuid=uuid-1')
    expect(query).toContain('userId=yid-1')
    expect(query).not.toContain('refreshToken')
    expect(query).not.toContain('RT')
  })

  it('构造完整 URL', () => {
    expect(buildLobsteraiModelsUrl(LOBSTERAI, makeCredential(), CLIENT_VERSION))
      .toContain('https://lobsterai-server.youdao.com/api/models/available?')
  })
})

describe('LobsteraiAdapter providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    expect(adapter.providerInfo('lobsterai')).toEqual({
      id: 'lobsterai', name: 'LobsterAI (有道)',
    })
  })

  it('provider 入参非法时回退到产品 id（避免 toUpperCase 崩溃）', () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    expect(adapter.providerInfo(undefined as unknown as string).id).toBe('lobsterai')
    expect(adapter.providerInfo('').id).toBe('lobsterai')
  })

  it('PROVIDER 常量为 lobsterai', () => {
    expect(PROVIDER).toBe('lobsterai')
  })
})

describe('LobsteraiAdapter 模型目录', () => {
  it('无远端时用产品兜底目录（19 个）', async () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    const models = await adapter.listModels('lobsterai')
    expect(models).toHaveLength(19)
    expect(models[0]).toMatchObject({ provider: 'lobsterai', id: 'deepseek-v4-flash' })
  })

  it('inputModalities 恒为 text（图片未实测支持）', async () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    for (const model of await adapter.listModels('lobsterai')) {
      expect(model.inputModalities).toEqual(['text'])
    }
  })

  /**
   * 远端声明 `supportsImage` 时必须以它为准。
   *
   * 历史实现硬编码 `['text']`（当时以为远端不下发该字段），实测远端 26 个
   * 模型里有 19 个 `supportsImage: true` —— 硬编码会让这些模型的图片能力
   * 在 UI 上被标成不支持，用户无法粘贴图片。
   */
  it('远端 supportsImage=true 时报 text+image', async () => {
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => [
        { id: 'vision', name: 'Vision', supportsImage: true },
        { id: 'plain', name: 'Plain', supportsImage: false },
        { id: 'unknown', name: 'Unknown' },
      ],
    })
    const models = await adapter.listModels('lobsterai')
    expect(models.find((m) => m.id === 'vision')!.inputModalities).toEqual(['text', 'image'])
    expect(models.find((m) => m.id === 'plain')!.inputModalities).toEqual(['text'])
    // 远端未声明时保守报 text（不猜测能力）。
    expect(models.find((m) => m.id === 'unknown')!.inputModalities).toEqual(['text'])
  })

  it('远端可用时以远端为准（不做「以兜底表为准」的裁剪）', async () => {
    // LobsterAI 的远端接口是权威的（兜底表本身就抄自它），
    // 与 buddy 的 reconcileWithFallback 语义相反。
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => [{ id: 'remote-only', name: 'Remote Only' }],
    })
    const models = await adapter.listModels('lobsterai')
    expect(models).toEqual([{ provider: 'lobsterai', id: 'remote-only', name: 'Remote Only', inputModalities: ['text'] }])
  })

  /**
   * 订阅闸门：`accessible:false` / `subscriptionPriority:true` / `restrictionHint`。
   *
   * 2026-11-17 实测（未订阅账号）：`qwen4-max` 与 `kimi-k3.1-pro-highspeed`
   * 是 `accessible:false` + `subscriptionPriority:true` +
   * 「该模型仅限有效订阅用户使用」，而本仓此前三个字段一个都没读 ⇒
   * 选择器里它们看起来和别的模型一模一样，选了才知道不能用。
   *
   * 三条判据（每条都对应一个已经踩得到的分叉）：
   * 1. **不得隐藏**（`accessible` 是账号级事实，官方客户端对订阅账号照常显示它）；
   * 2. 选择器名必须带短标签（menu 只渲染 `name`，`description` 进不了 menu）；
   * 3. 原因整句进 `description`（**追加**，不改写上游原文）。
   */
  describe('订阅闸门（accessible / subscriptionPriority / restrictionHint）', () => {
    const remote = [
      {
        id: 'qwen4-max', name: 'Qwen4-Max', costMultiplier: 0.71,
        accessible: false, subscriptionPriority: true,
        restrictionHint: '该模型仅限有效订阅用户使用',
        description: '新一代旗舰多模态模型。',
      },
      {
        id: 'region-locked', name: 'Region', accessible: false,
        restrictionHint: '该模型暂未在本地区开放',
      },
      // 已订阅账号：同一条目录也可能给 `accessible:true` + `subscriptionPriority:true`
      { id: 'subscriber-ok', name: 'Sub OK', costMultiplier: 1, accessible: true, subscriptionPriority: true },
      { id: 'plain', name: 'Plain', costMultiplier: 0.06, accessible: true },
    ]
    const adapterOf = () => makeAdapter(() => textSse('x'), { fetchRemoteModels: async () => remote }).adapter

    it('不可用条目**仍在目录里**（隐藏会让「订阅后能多用什么」不可见）', async () => {
      const models = await adapterOf().listModels('lobsterai')
      expect(models.map((m) => m.id)).toEqual(['qwen4-max', 'region-locked', 'subscriber-ok', 'plain'])
    })

    it('选择器名带短标签：订阅专享 =「需订阅」，其它不可用 =「不可用」', async () => {
      const models = await adapterOf().listModels('lobsterai')
      const byId = new Map(models.map((m) => [m.id, m]))
      expect(byId.get('qwen4-max')?.name).toBe('Qwen4-Max · x0.71 · 需订阅')
      expect(byId.get('region-locked')?.name).toBe('Region · 不可用')
    })

    it('已订阅账号不画标签（`accessible:true` 时 `subscriptionPriority` 不参与判定）', async () => {
      const models = await adapterOf().listModels('lobsterai')
      const byId = new Map(models.map((m) => [m.id, m]))
      expect(byId.get('subscriber-ok')?.name).toBe('Sub OK · x1')
      expect(byId.get('plain')?.name).toBe('Plain · x0.06')
    })

    it('restrictionHint 追加到 description（原文逐字保留，只多一行）', async () => {
      const models = await adapterOf().listModels('lobsterai')
      const byId = new Map(models.map((m) => [m.id, m]))
      expect(byId.get('qwen4-max')?.description)
        .toBe('新一代旗舰多模态模型。\n该模型仅限有效订阅用户使用')
      // 没有 description 的条目：hint 就是全部描述
      expect(byId.get('region-locked')?.description).toBe('该模型暂未在本地区开放')
      // 没有 hint 的条目：描述原样（不得被追加空行）
      expect(byId.get('plain')?.description).toBeUndefined()
    })
  })

  // ── 目录门控：没有已登录账号就不显示该 provider 的模型 ──
  //
  // DSH 的 `buildModelCatalog` 显式 `.filter(group => group.models.length > 0)`，
  // 故返回空数组即让整个 provider 分组消失（减少模型选择列表臃肿）。
  describe('目录门控（无已登录账号时隐藏）', () => {
    it('没有已登录账号 → 返回空数组', async () => {
      const { adapter } = makeAdapter(() => textSse('x'), {
        fetchRemoteModels: async () => [{ id: 'm', name: 'M' }],
        accountPool: {
          disabledModelsFor: () => new Set<string>(),
          hasLoggedInAccount: async () => false,
        } as never,
      })
      expect(await adapter.listModels('lobsterai')).toEqual([])
    })

    it('有已登录账号 → 正常返回目录', async () => {
      const { adapter } = makeAdapter(() => textSse('x'), {
        fetchRemoteModels: async () => [{ id: 'm', name: 'M' }],
        accountPool: {
          disabledModelsFor: () => new Set<string>(),
          hasLoggedInAccount: async () => true,
        } as never,
      })
      expect((await adapter.listModels('lobsterai')).map((m) => m.id)).toEqual(['m'])
    })
  })

  // 计费倍率展示。⚠️ **必须写进 `name`，不是 `description`**：composer 的模型
  // 切换菜单只渲染 `name`（ModelSelect 的 `children: model.name`），
  // `description` 仅用于 `/model` 弹窗。用户报障「消耗倍率没有显示在切换模型
  // 列表的后面」正是因为放在了 `description`。
  describe('listModels 的计费倍率', () => {
    it('裸数字 costMultiplier 补 x 前缀并追加到 name', async () => {
      const { adapter } = makeAdapter(() => textSse('x'), {
        fetchRemoteModels: async () => [{ id: 'm', name: 'M', costMultiplier: 0.05 }],
      })
      const models = await adapter.listModels('lobsterai')
      expect(models[0]?.name).toBe('M · x0.05')
    })

    it('远端原始 description 原样透传，不被倍率污染', async () => {
      const { adapter } = makeAdapter(() => textSse('x'), {
        fetchRemoteModels: async () => [{ id: 'm', name: 'M', costMultiplier: 1.08, description: '很强大的模型' }],
      })
      const models = await adapter.listModels('lobsterai')
      // 倍率只在 name 里出现一次，description 保持远端原文。
      expect(models[0]?.name).toBe('M · x1.08')
      expect(models[0]?.description).toBe('很强大的模型')
    })

    it('无倍率信息时 name 保持原样', async () => {
      const { adapter } = makeAdapter(() => textSse('x'), {
        fetchRemoteModels: async () => [{ id: 'm', name: 'M' }],
      })
      const models = await adapter.listModels('lobsterai')
      expect(models[0]?.name).toBe('M')
    })

    // 远端整体失败时回退兜底表，而兜底表**不含倍率**（编译期快照，价格会变）
    // —— 此时不显示倍率，而不是猜一个。
    it('兜底表路径不显示倍率（兜底表无该字段）', async () => {
      const { adapter } = makeAdapter(() => textSse('x'), { fetchRemoteModels: async () => [] })
      for (const model of await adapter.listModels('lobsterai')) {
        expect(model.name).not.toContain('· x')
      }
    })
  })

  it('远端返回空数组时回退兜底目录', async () => {
    const { adapter } = makeAdapter(() => textSse('x'), { fetchRemoteModels: async () => [] })
    expect(await adapter.listModels('lobsterai')).toHaveLength(19)
  })

  it('远端抛错时回退兜底目录', async () => {
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => { throw new Error('boom') },
    })
    expect(await adapter.listModels('lobsterai')).toHaveLength(19)
  })

  it('应用账号池的模型黑名单', async () => {
    const disabledModelsFor = vi.fn(() => new Set(['glm-5.2']))
    const { adapter } = makeAdapter(() => textSse('x'), {
      accountPool: { disabledModelsFor } as never,
    })
    const ids = (await adapter.listModels('lobsterai')).map((m) => m.id)
    expect(ids).not.toContain('glm-5.2')
    expect(disabledModelsFor).toHaveBeenCalledWith('lobsterai')
  })
})

describe('LobsteraiAdapter resolveModel', () => {
  it('用兜底表给出上下文窗口', async () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    const resolved = await adapter.resolveModel('lobsterai', 'glm-5.2')
    expect(resolved.context).toEqual({ contextWindow: 131_072 })
  })

  /**
   * 远端 `contextWindow` 优先于兜底表估值。
   *
   * 实测远端多数模型返回 1000000，而兜底表是 131072 的统一估值 ——
   * 用估值会让 DSH 过早触发上下文压缩，浪费 1M 窗口。
   */
  it('远端 contextWindow 优先于兜底表估值', async () => {
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => [
        { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000 },
      ],
    })
    const resolved = await adapter.resolveModel('lobsterai', 'glm-5.2')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('远端未给 contextWindow 时回退兜底表', async () => {
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2' }],
    })
    expect((await adapter.resolveModel('lobsterai', 'glm-5.2')).context)
      .toEqual({ contextWindow: 131_072 })
  })

  it('远端 maxTokens 映射为 defaultMaxTokens', async () => {
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => [{ id: 'm1', name: 'M1', maxTokens: 8_192 }],
    })
    expect((await adapter.resolveModel('lobsterai', 'm1')).defaultMaxTokens).toBe(8_192)
  })

  /**
   * 思考档位：远端 `thinkingConfig.options` 是权威来源。
   *
   * ## `id` 与 `name` 来源不同（务必分清）
   *
   * - **`id` 用 `openclawLevel`（wire 值）**：DSH 把选中的 id 原样写进请求体的
   *   `reasoning_effort`，故必须是服务端认的取值。真实凭据实测（2026-09-17）：
   *   `reasoning_effort=max` 与不带参数**无差异**（走服务端默认），
   *   `xhigh` 才真正触发最高档。
   * - **`name` 用 `level`（产品侧档位名）**：纯展示。远端把 `level: 'max'`
   *   映射到 `openclawLevel: 'xhigh'`，产品侧（IDE）显示的正是 **Max**。
   *
   * ⚠️ **真实缺陷回归**（Issue #IKHCZF，用户报障）：早期用 `openclawLevel`
   * 同时查展示名表，最强档显示成 **XHigh**，与产品侧命名 **Max** 不一致 ——
   * 用户按 IDE 里的「Max」找，界面上却只有「XHigh」。根因是把「wire 值」与
   * 「展示名」当成同一个概念。
   */
  it('远端 thinkingConfig 映射为 reasoning 档位（id 用 wire 值、name 用产品侧名）', async () => {
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => [{
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        thinkingConfig: {
          options: [
            { level: 'off', openclawLevel: 'off' },
            { level: 'high', openclawLevel: 'high' },
            { level: 'max', openclawLevel: 'xhigh' },
          ],
          defaultLevel: 'high',
        },
      }],
    })
    const resolved = await adapter.resolveModel('lobsterai', 'deepseek-flash')
    // id 必须是 wire 值（发请求用）。
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['off', 'high', 'xhigh'])
    // ⚠️ name 必须是产品侧命名：最强档是 **Max**，不是 XHigh。
    expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['Off', 'High', 'Max'])
    // defaultEffort 必须是 openclawLevel（'high' 恰好同名），
    // 且必须落在 efforts 内 —— 否则 DSH 会拿一个不存在的档位去请求。
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('⚠️ 最强档展示名为 Max（不是 XHigh）—— Issue #IKHCZF 回归', async () => {
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => [{
        id: 'glm-5.3-flashx',
        name: 'GLM-5.3-FlashX',
        thinkingConfig: {
          options: [
            { level: 'off', openclawLevel: 'off' },
            { level: 'high', openclawLevel: 'high' },
            { level: 'max', openclawLevel: 'xhigh' },
          ],
          defaultLevel: 'max',
        },
      }],
    })
    const resolved = await adapter.resolveModel('lobsterai', 'glm-5.3-flashx')
    const efforts = resolved.reasoning?.efforts ?? []
    const strongest = efforts.find((e) => e.id === 'xhigh')
    expect(strongest?.name, '产品侧命名为 Max').toBe('Max')
    // 展示名里不应出现 XHigh（那是 wire 值的直译）。
    expect(efforts.map((e) => e.name)).not.toContain('XHigh')
    // 但 id 仍必须是 wire 值 xhigh —— 否则请求会走服务端默认档。
    expect(efforts.map((e) => e.id)).toContain('xhigh')
  })

  it('defaultLevel 为 max 时 defaultEffort 映射成 xhigh', async () => {
    // glm-5.3-flash 实测 defaultLevel=max，而 max 的 wire 值是 xhigh。
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => [{
        id: 'glm-5.3-flash',
        name: 'GLM-5.3-Flash',
        thinkingConfig: {
          options: [
            { level: 'off', openclawLevel: 'off' },
            { level: 'high', openclawLevel: 'high' },
            { level: 'max', openclawLevel: 'xhigh' },
          ],
          defaultLevel: 'max',
        },
      }],
    })
    const resolved = await adapter.resolveModel('lobsterai', 'glm-5.3-flash')
    expect(resolved.reasoning?.defaultEffort).toBe('xhigh')
  })

  it('无 thinkingConfig 的模型不声明 reasoning（如 MiniMax-M3）', async () => {
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => [{ id: 'MiniMax-M3', name: 'MiniMax-M3', supportsThinking: true }],
    })
    // supportsThinking=true 但无 thinkingConfig ⇒ 无可选档位，不声明 reasoning。
    expect((await adapter.resolveModel('lobsterai', 'MiniMax-M3')).reasoning).toBeUndefined()
  })

  it('未知模型回退为 id 作展示名且不报错', async () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    const resolved = await adapter.resolveModel('lobsterai', 'unknown-model')
    expect(resolved.name).toBe('unknown-model')
    expect(resolved.context).toBeUndefined()
  })
})

describe('LobsteraiAdapter 请求构造', () => {
  it('POST 到 {apiBase}/api/proxy/v1/chat/completions', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions(), adapter)
    expect(calls[0]!.url).toBe('https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions')
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('**stream 恒为 true**（上游只支持 SSE，false 会 500）', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions(), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.stream).toBe(true)
  })

  it('请求头含 LobsterAI 专属头，且**不含**腾讯系归属头', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions(), adapter)
    const headers = calls[0]!.init?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer AT')
    expect(headers.get('X-LobsterAI-Client-Capabilities')).toBe(LOBSTERAI.clientCapabilities)
    expect(headers.get('X-LobsterAI-Client-Version')).toBe(CLIENT_VERSION)
    expect(headers.get('User-Agent')).toBe('LobsterAI/0.1.0')
    for (const banned of ['X-Domain', 'X-Product', 'X-Product-Code', 'X-IDE-Name']) {
      expect(headers.get(banned), banned).toBeNull()
    }
  })

  it('**不发** prompt_cache_key（那是腾讯后端的前缀缓存机制）', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions(), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('prompt_cache_key')
  })

  it('**不发** thinking（未实测支持，照搬 buddy 会造成非法参数 400）', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({ model: 'deepseek-v4-flash' }), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('调用方显式传 reasoningEffort 时透传', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({ reasoningEffort: 'high' as never }), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.reasoning_effort).toBe('high')
  })

  it('透传 temperature / maxTokens / stop', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({ temperature: 0.3, maxTokens: 1024, stop: ['END'] }), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(1024)
    expect(body.stop).toEqual(['END'])
  })

  it('system 提示折叠进 messages 首位', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({ system: '你是助手' }), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是助手' })
  })

  it('工具 schema 映射为 OpenAI function 形态', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({
      tools: [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } }],
    } as never), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { tools: unknown[] }
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } },
    }])
  })

  it('无工具时不发 tools 字段', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions(), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('tools')
  })
})

describe('LobsteraiAdapter 凭据处理', () => {
  it('凭据缺失时抛 MISSING_CREDENTIAL', async () => {
    const { adapter } = makeAdapter(() => textSse('hi'), { resolveCredential: async () => undefined })
    await expect(collect(generateOptions(), adapter)).rejects.toThrow(/no usable credential/)
  })

  it('凭据过期时先续期再发请求', async () => {
    let refreshed = false
    const expired = makeCredential({ expires_at: String(Date.now() - 1000) })
    const { adapter, calls } = makeAdapter(() => textSse('hi'), {
      resolveCredential: async () => (refreshed ? makeCredential() : expired),
      refresh: async () => { refreshed = true },
    })
    await collect(generateOptions(), adapter)
    expect(refreshed).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('401 时续期一次并重试', async () => {
    let attempt = 0
    const { adapter, calls } = makeAdapter(() => {
      attempt += 1
      return attempt === 1
        ? new Response('{"code":401}', { status: 401 })
        : textSse('ok')
    }, { refresh: async () => {} })
    const chunks = await collect(generateOptions(), adapter)
    expect(calls).toHaveLength(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('LobsteraiAdapter 错误处理', () => {
  it('积分不足时抛 QUOTA_EXCEEDED 且带可读文案', async () => {
    const { adapter } = makeAdapter(() => new Response(
      JSON.stringify({ code: 402, msg: '积分不足' }), { status: 402 },
    ))
    await expect(collect(generateOptions(), adapter)).rejects.toThrow(/积分不足/)
  })

  it('HTTP 400 映射为 INVALID_REQUEST', async () => {
    const { adapter } = makeAdapter(() => new Response('bad request', { status: 400 }))
    const error = await collect(generateOptions(), adapter).catch((e: unknown) => e as { code?: string })
    expect(error.code).toBe('INVALID_REQUEST')
  })

  it('5xx 映射为 SERVER', async () => {
    const { adapter } = makeAdapter(() => new Response('boom', { status: 503 }))
    const error = await collect(generateOptions(), adapter).catch((e: unknown) => e as { code?: string })
    expect(error.code).toBe('SERVER')
  })

  it('传输层失败映射为可重试的 TRANSPORT', async () => {
    const { adapter } = makeAdapter(() => { throw new Error('socket hang up') })
    const error = await collect(generateOptions(), adapter).catch((e: unknown) => e as { code?: string })
    expect(error.code).toBe('TRANSPORT')
  })

  it('模型不支持图片时报 UNSUPPORTED_CONTENT（而不是静默丢弃）', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    const options = generateOptions({
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: { attachmentId: 'a1' } }],
        source: { kind: 'user' },
      })],
    } as never)
    await expect(collect(options, adapter)).rejects.toThrow(/不支持图片输入/)
    // 应在取凭据/发请求之前就拒绝。
    expect(calls).toHaveLength(0)
  })

  /**
   * 远端声明 `supportsImage` 的模型必须**真的**接受图片。
   *
   * 只声明 `inputModalities` 而不实现是比不声明更糟的状态：DSH 在
   * `LlmRuntime`（dsh-llm `lib/index.js`）里按 `inputModalities` 决定要不要把
   * 图片投影成文本占位符 —— 声明含 image 时图片会原样透传给适配器，
   * 适配器若拒绝，请求就直接失败（用户看到「粘贴图片后必报错」）。
   *
   * 实测（2026-09-17）服务端接受 `image_url` 形态的 data URL 并正确识别内容，
   * 故这里要求发出该形态。
   */
  it('远端 supportsImage 的模型发出 image_url data URL', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'), {
      fetchRemoteModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2', supportsImage: true }],
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
    })
    const options = generateOptions({
      messages: [createUserMessage({
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', attachment: { attachmentId: 'a1' } },
        ],
        source: { kind: 'user' },
      })],
    } as never)
    await collect(options, adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    const user = body.messages.find((m) => m.role === 'user')!
    // ⚠️ **不按 parts 顺序断言**（issue IKLIFH 的 `0dd27ca` 起顺序为「图在前」）：
    // 两种顺序上游都能看到，而按顺序写死会让实现一改顺序就假失败。
    // 这里分别断言「两种块都在」与「文本内容正确」，顺序无关。
    const parts = user.content as Array<Record<string, unknown>>
    expect(parts).toHaveLength(2)
    expect(parts).toContainEqual({ type: 'text', text: '看图' })
    expect(parts).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } })
  })

  it('模型支持图片但附件服务不可用时报错（而非静默丢图）', async () => {
    const { adapter } = makeAdapter(() => textSse('hi'), {
      fetchRemoteModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2', supportsImage: true }],
      // 不提供 readImage
    })
    const options = generateOptions({
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: { attachmentId: 'a1' } }],
        source: { kind: 'user' },
      })],
    } as never)
    await expect(collect(options, adapter)).rejects.toThrow(/附件服务/)
  })

  it('图片字节读取失败时留占位文本（不静默丢图）', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'), {
      fetchRemoteModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2', supportsImage: true }],
      readImage: async () => undefined,
    })
    const options = generateOptions({
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: { attachmentId: 'a1' } }],
        source: { kind: 'user' },
      })],
    } as never)
    await collect(options, adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    const user = body.messages.find((m) => m.role === 'user')!
    expect(user.content).toEqual([{ type: 'text', text: '[image unavailable]' }])
  })

  /**
   * 工具结果内嵌的图片（`read_image` 等）必须被提升到独立的 user 消息。
   *
   * OpenAI 兼容协议要求每条 `role:'tool'` 消息紧跟其 assistant tool_call，
   * 中间插入任何消息都会 400；而 `role:'tool'` 的 content 只能是字符串。
   * 故图片只能挂到其后的 user 消息 —— 直接丢在 tool 结果里会被
   * `contentToText` 静默吞掉（连占位符都没有）。
   */
  it('工具结果内嵌图片被提升为独立 user 消息', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'), {
      fetchRemoteModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2', supportsImage: true }],
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
    })
    const options = generateOptions({
      messages: [
        // tool 结果必须与其 assistant tool_call 配对，否则会被孤儿清理剔除
        // （那是防后端 400 的既有逻辑，与本用例无关）。
        {
          role: 'assistant',
          content: [{
            type: 'tool-call', id: 't1', name: 'read_image', arguments: '{}',
          }],
        },
        createUserMessage({
          content: [{
            type: 'tool-result',
            toolCallId: 't1',
            content: [
              { type: 'text', text: '截图完成' },
              { type: 'image', attachment: { attachmentId: 'a1' } },
            ],
          }],
          source: { kind: 'user' },
        }),
      ],
    } as never)
    await collect(options, adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    const tool = body.messages.find((m) => m.role === 'tool')!
    // 文本留在 tool 消息里。
    expect(tool.content).toBe('截图完成')
    // 图片被提升到其后的 user 消息，而不是被吞掉。
    const imageUser = body.messages.filter((m) => m.role === 'user')
      .find((m) => Array.isArray(m.content))
    expect(imageUser!.content).toContainEqual({
      type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' },
    })
  })

  /**
   * ⚠️ Issue IKLIFH：工具结果里的图片必须与**提问同在一条 user 消息**。
   *
   * 真实报障「codebuddy hy4 不支持识别图片」。实测（直连上游，同一张图）：
   * 图与问**同条** ✅ 模型答出颜色；图**单独成一条**（无论带不带提示句）
   * ❌ 模型答「图像已被过滤」。且 wire 上确实有图、上游也**不报错**
   * （HTTP 200 + 正常流），只是模型看不见 —— 症状极具误导性。
   *
   * 旧实现把图片单独发成一条 `TOOL_RESULT_IMAGE_TEXT` + 图片的 user 消息，
   * 提问在**再下一条**，恰好命中该形态。
   */
  it('工具结果内嵌图片与后续提问合并为同一条 user 消息', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'), {
      fetchRemoteModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2', supportsImage: true }],
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
    })
    const options = generateOptions({
      messages: [
        {
          role: 'assistant',
          content: [{
            type: 'tool-call', id: 't1', name: 'read_image', arguments: '{}',
          }],
        },
        createUserMessage({
          content: [{
            type: 'tool-result',
            toolCallId: 't1',
            content: [
              { type: 'text', text: '截图完成' },
              { type: 'image', attachment: { attachmentId: 'a1' } },
            ],
          }],
          source: { kind: 'user' },
        }),
        createUserMessage({
          content: [{ type: 'text', text: '这页写了什么？' }],
          source: { kind: 'user' },
        }),
      ],
    } as never)
    await collect(options, adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }

    const toolIndex = body.messages.findIndex((m) => m.role === 'tool')
    expect(toolIndex, '工具结果必须下发').toBeGreaterThan(-1)
    // 协议约束：tool 必须紧跟其 assistant tool_calls（否则上游 400）。
    const assistantIndex = body.messages.findIndex((m) => m.role === 'assistant')
    expect(toolIndex).toBe(assistantIndex + 1)

    // 核心断言：图片与提问**同在一条** user 消息里。
    const imageIndex = body.messages.findIndex((m) => Array.isArray(m.content)
      && (m.content as Array<{ type: string }>).some((p) => p.type === 'image_url'))
    const askIndex = body.messages.findIndex((m) => Array.isArray(m.content)
      && (m.content as Array<{ type: string; text?: string }>).some((p) => p.text?.includes('这页写了什么')))
    expect(imageIndex, '图片不得静默丢弃').toBeGreaterThan(-1)
    expect(askIndex, '提问不得静默丢弃').toBeGreaterThan(-1)
    expect(imageIndex, '图片必须与提问同条（Issue IKLIFH）').toBe(askIndex)
    // 且必须排在 tool 之后（否则违反 tool 配对约束）。
    expect(imageIndex).toBeGreaterThan(toolIndex)
  })

  /**
   * ⚠️⚠️ Issue IKLSB8：**纯图片型工具结果不得被压成字面量 `(no output)`**。
   *
   * 这是 `role:'tool'` 的 content 兜底那一格。工具结果里**只有图片**时
   * `contentToText` 返回空串 ⇒ 落到 `|| '(no output)'` ⇒ 模型被告知
   * 「工具没有任何输出」，于是答「Read 没有返回内容 / gave no output」，
   * 用户据此以为模型没有视觉能力 —— 而真实原因是「有输出，输出是图」。
   *
   * 判据必须是「内容说清了『输出在这里、只是它是图』」，而不是「不是
   * `(no output)`」这种弱断言：断言写弱了，把文本换成任意占位串都会绿。
   */
  it('⚠️⚠️ 纯图片工具结果不得写成 `(no output)`（Issue IKLSB8）', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'), {
      fetchRemoteModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2', supportsImage: true }],
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
    })
    const options = generateOptions({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 't1', name: 'read_image', arguments: '{}' }],
        },
        createUserMessage({
          content: [{
            type: 'tool-result',
            toolCallId: 't1',
            // ⚠️ 刻意**只有图片、没有任何文本** —— 这正是 Claude Code 的
            // `tool_result.content=[{type:'image'}]` 形状，也是本 issue 的现场。
            content: [{ type: 'image', attachment: { attachmentId: 'a1' } }],
          }],
          source: { kind: 'user' },
        }),
        createUserMessage({
          content: [{ type: 'text', text: '这页写了什么？' }],
          source: { kind: 'user' },
        }),
      ],
    } as never)
    await collect(options, adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    const tool = body.messages.find((m) => m.role === 'tool')!
    expect(tool, '工具结果必须下发').toBeDefined()
    expect(
      String(tool.content),
      '纯图片工具结果退化成 `(no output)` ⇒ 模型会说「没有返回内容」，用户误判成模型没有视觉能力',
    ).not.toBe('(no output)')
    expect(
      String(tool.content),
      '至少要说明「输出在这里、只是它是图片」（否则模型无法解释为何没有文本）',
    ).toMatch(/image/i)
    // 图片本体照旧必须真的上 wire（不得因为改了正文兜底而丢掉图）。
    expect(JSON.stringify(body.messages)).toContain('image_url')
  })

  /**
   * ⚠️ 反向验证的另一半：无图时**不得**凭空多出一条 user 消息。
   * 修法把纯文本路径也交给了 `flushToolImages`，若它对「无挂图」也发消息，
   * 每轮纯文本对话都会多一条空 parts 消息（实测上游报 `model_param_invalid`）。
   */
  it('无挂图时不凭空多发 user 消息（纯文本形态不变）', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'), {
      fetchRemoteModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2', supportsImage: true }],
    })
    const options = generateOptions({
      messages: [createUserMessage({
        content: [{ type: 'text', text: '你好' }],
        source: { kind: 'user' },
      })],
    } as never)
    await collect(options, adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    const users = body.messages.filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    // 纯文本必须是**字符串**形态（不是 parts 数组），否则上游会拒收。
    expect(typeof users[0]!.content).toBe('string')
    expect(users[0]!.content).toBe('你好')
  })
})

describe('LobsteraiAdapter SSE 消费', () => {
  it('文本增量产出 block-start / text-delta / block-end / finish', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: '你' } }] }),
      JSON.stringify({ choices: [{ delta: { content: '好' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]))
    const chunks = await collect(generateOptions(), adapter)
    expect(chunks.filter((c) => c.type === 'text-delta')).toEqual([
      { type: 'text-delta', index: 0, text: '你' },
      { type: 'text-delta', index: 0, text: '好' },
    ])
    const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
    expect(end).toMatchObject({ block: { type: 'text', text: '你好' } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('兼容 `data:` 后**无空格**（上游实测形态）', async () => {
    const body = 'data:{"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n'
    const { adapter } = makeAdapter(() => new Response(body, { status: 200 }))
    const chunks = await collect(generateOptions(), adapter)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'x' })
  })

  /**
   * `delta.content` / `delta.reasoning_content` 显式返回 **`null`** 时必须容忍。
   *
   * 真实线上形态（2026-09-17 实测 335 帧）：一个模型要么走 content、要么走
   * reasoning_content，另一侧恒为 `null`（227 帧 content=null / 107 帧
   * reasoning_content=null）。早先实现只判 `!== undefined` 就取 `.length`，
   * 于是**每一轮对话都在第一帧崩溃**，报
   * `Cannot read properties of null (reading 'length')`。
   */
  it('delta.content 为 null 时不崩溃（真实线上形态）', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '想' } }] }),
      JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: null } }] }),
      JSON.stringify({ choices: [{ delta: { content: '答' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]))
    const chunks = await collect(generateOptions(), adapter)
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: '想' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 1, text: '答' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reasoning_content 单独成块', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] }),
      JSON.stringify({ choices: [{ delta: { content: '答' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]))
    const chunks = await collect(generateOptions(), adapter)
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: '想' })
    expect(chunks.find((c) => c.type === 'block-end' && c.block.type === 'reasoning'))
      .toMatchObject({ block: { type: 'reasoning', text: '想' } })
  })

  it('兼容把完整消息放在 message 而非 delta（对齐 sse.go:97-102）', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ message: { content: '完整' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]))
    const chunks = await collect(generateOptions(), adapter)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: '完整' })
  })

  it('tool_calls 分片按 index 合并，name 只允许非空覆盖', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"a"' } }] } }] }),
      // 后续分片带空 name（直接覆盖会清空工具名 → unknown tool ""）
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: ':1}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]))
    const chunks = await collect(generateOptions(), adapter)
    const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toMatchObject({ block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"a":1}' } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('无参数工具的空分片补成 {}', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'ls', arguments: '' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]))
    const chunks = await collect(generateOptions(), adapter)
    const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toMatchObject({ block: { arguments: '{}' } })
  })

  it('finish_reason=length 归为 max-tokens（不让 harness 执行残缺参数）', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: '截断' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    ]))
    expect((await collect(generateOptions(), adapter)).at(-1))
      .toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('工具参数残缺但未收 finish_reason 时归为 max-tokens', async () => {
    // 连接被中途掐断 → 参数必然是半截 JSON。报 tool-calls 会让 harness
    // 执行缺参调用并报 schema 错误，模型陷入重试循环。
    const { adapter } = makeAdapter(() => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read', arguments: '{"file_path"' } }] } }] })}\n\n`,
      { status: 200 },
    ))
    expect((await collect(generateOptions(), adapter)).at(-1))
      .toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('usage 只把未命中缓存部分计入 inputTokens', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({
        choices: [{ delta: { content: 'x' } }],
        usage: {
          prompt_tokens: 1000, completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]))
    const usage = (await collect(generateOptions(), adapter)).find((c) => c.type === 'usage')
    expect(usage).toMatchObject({ usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 800 } })
  })

  it('上游把错误放进 SSE 帧时抛出 SERVER 错误', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ error: { message: '模型不可用' } }),
    ]))
    await expect(collect(generateOptions(), adapter)).rejects.toThrow(/模型不可用/)
  })

  it('畸形 JSON 帧被跳过而不中断流', async () => {
    const { adapter } = makeAdapter(() => new Response(
      `data: {bad json}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    ))
    const chunks = await collect(generateOptions(), adapter)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
  })
})

describe('LobsteraiAdapter 孤儿工具调用清理', () => {
  it('剔除没有结果的 tool_call 批次（避免后端 400 让会话报废）', async () => {
    // assistant 带 tool_calls 但历史里没有对应 tool 结果 —— 这条坏历史
    // 若原样重放，后端会对之后每条消息都 400。
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({
      messages: [
        createUserMessage({ content: [{ type: 'text', text: '起点' }], source: { kind: 'user' } }),
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'orphan', name: 'read', arguments: '{}' }],
        },
      ],
    } as never), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    const assistant = body.messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant).not.toHaveProperty('tool_calls')
  })

  it('配对的 tool_call 与 tool 结果都保留', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({
      messages: [
        createUserMessage({ content: [{ type: 'text', text: '起点' }], source: { kind: 'user' } }),
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'ok-1', name: 'read', arguments: '{"p":"a"}' }],
        },
        createUserMessage({
          content: [{ type: 'tool-result', toolCallId: 'ok-1', content: [{ type: 'text', text: 'file' }] }],
          source: { kind: 'user' },
        }),
      ],
    } as never), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    const assistant = body.messages.find((m) => m.role === 'assistant') as { tool_calls: unknown[] }
    expect(assistant.tool_calls).toHaveLength(1)
    expect(body.messages.find((m) => m.role === 'tool')).toMatchObject({ tool_call_id: 'ok-1' })
  })

  it('assistant 正文为空且有 tool_calls 时 content 为 null', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
        },
        createUserMessage({
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] }],
          source: { kind: 'user' },
        }),
      ],
    } as never), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    const assistant = body.messages.find((m) => m.role === 'assistant') as { content: unknown }
    expect(assistant.content).toBeNull()
  })
})

describe('LobsteraiAdapter 限流切换', () => {
  it('限流时记录重置时间并切到下一个账号', async () => {
    const updateModelRateLimit = vi.fn(async () => {})
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'lobsterai' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    let attempt = 0
    const { adapter, calls } = makeAdapter(() => {
      attempt += 1
      if (attempt === 1) {
        return new Response('您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置', { status: 429 })
      }
      return textSse('ok')
    }, {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit,
        getAvailableAccount,
      } as never,
    })
    const chunks = await collect(generateOptions(), adapter)
    expect(updateModelRateLimit).toHaveBeenCalledWith('acc-1', 'glm-5.2', expect.any(Number))
    // 第三个实参是 `tried` 集合：必须把已试账号传给池，否则池按「重置时间
    // 最早」排序时会再次返回刚失败的账号，换号立即因 tried 命中而中断。
    expect(getAvailableAccount).toHaveBeenCalledWith('lobsterai', 'glm-5.2', expect.any(Set))
    expect(calls).toHaveLength(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('全部账号耗尽时抛可读错误（带真实原因）', async () => {
    const { adapter } = makeAdapter(
      () => new Response('您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置', { status: 429 }),
      {
        accountPool: {
          findAccountIdByCredential: async () => 'acc-1',
          updateModelRateLimit: async () => {},
          getAvailableAccount: async () => null,
        } as never,
      },
    )
    const error = await collect(generateOptions(), adapter).catch((e: unknown) => e as { code?: string; message?: string })
    // 试遍候选后报「所有账号均不可用」，并带上最后一次的真实原因
    // （不吞诊断信息；Go 也把 lastErr 拼进最终错误）。
    expect(error.message).toMatch(/所有账号均不可用/)
    expect(error.message).toMatch(/频率限制/)
  })

  it('404 也会换号（对齐 Go：每个分类分支都 continue）', async () => {
    // 曾经的实现不把 404 计入换号条件，导致偶发 404 直接暴露给用户。
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'lobsterai' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    let attempt = 0
    const { adapter, calls } = makeAdapter(() => {
      attempt += 1
      return attempt === 1 ? new Response('not found', { status: 404 }) : textSse('ok')
    }, {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const chunks = await collect(generateOptions(), adapter)
    expect(getAvailableAccount).toHaveBeenCalled()
    expect(calls).toHaveLength(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('server/client 类失败**不留**限流徽章（避免把「出错」显示成「限流」）', async () => {
    const updateModelRateLimit = vi.fn(async () => {})
    const { adapter } = makeAdapter(() => new Response('bad request', { status: 400 }), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit,
        getAvailableAccount: async () => null,
      } as never,
    })
    await collect(generateOptions(), adapter).catch(() => {})
    // Go 对 default 分支只 NoteError，不写冷却时间 —— 本插件照做。
    expect(updateModelRateLimit).not.toHaveBeenCalled()
  })

  it('无账号池时积分不足直接报错（不尝试换号）', async () => {
    const { adapter, calls } = makeAdapter(() => new Response(
      JSON.stringify({ code: 402, msg: '积分不足' }), { status: 402 },
    ))
    await expect(collect(generateOptions(), adapter)).rejects.toThrow(/积分不足/)
    expect(calls).toHaveLength(1)
  })
})

describe('registerLobsteraiLlm', () => {
  it('只注册适配器，不声明可配置 provider（设置页不留行）', () => {
    // ⚠️ 2026-10-01（用户要求）：账号与模型开关都在 Jet Hub 设置页管理，
    // 声明只会在「设置 → 模型 → 提供商」留下无人使用的行。
    // 机制与代价评估见 src/llm-register-compat.ts 模块头。
    const configurable: Array<Record<string, unknown>> = []
    const adapters: string[] = []
    const ctx = {
      llm: {
        registerConfigurableProviders: (entries: Array<Record<string, unknown>>) => { configurable.push(...entries) },
        registerAdapter: (providers: string[]) => { adapters.push(...providers) },
      },
    }
    registerLobsteraiLlm(ctx as never, {
      credentialRef: credentialRef('LOBSTERAI_ACCESS_TOKEN'),
      resolveCredential: async () => undefined,
      refresh: async () => {},
    })
    expect(configurable).toEqual([])
    expect(adapters).toEqual(['lobsterai'])
  })
})
