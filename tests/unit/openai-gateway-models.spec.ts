import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { applyGatewayContextWindows, collectGatewayEffortViews, collectGatewayModelDetails, collectGatewayModelIds, collectGatewayModels, toGatewayModelIds, toOpenAiModels } from '../../src/openai-gateway/models.js'
// ⚠️ 用**真实适配器**的声明驱动投影，而不是手写字面量 —— 见
// 「CodeArts 的两档经真实适配器投影后是升序」用例的注释。
import { CodeArtsAdapter } from '../../src/llm-adapter.js'

/** 目录采集替身：`broken` provider 的 listModels 一律抛错。 */
function makeSource() {
  return {
    listProviders: () => [{ id: 'qoder' }, { id: 'broken' }],
    listModels: async (provider: string) => {
      if (provider === 'broken') throw new Error('no credentials')
      return [{ id: 'qfmodel', name: 'Qwen Flash' }]
    },
  }
}

describe('OpenAI gateway model catalog', () => {
  it('namespaces models by provider without merging duplicates', () => {
    const models = toOpenAiModels([
      { provider: 'qoder', models: [{ id: 'qfmodel', name: 'Qwen Flash', contextWindow: 128000 }] },
      { provider: 'qodercn', models: [{ id: 'qfmodel', name: 'Qwen Flash CN' }] },
    ])
    expect(models.map(model => model.id)).toEqual(['qoder/qfmodel', 'qodercn/qfmodel'])
    expect(models[0]).toMatchObject({ owned_by: 'qoder', context_window: 128000 })
  })
})

describe('collectGatewayModels（目录采集的容错口径）', () => {
  it('单个 provider 失败只跳过它，不让整份目录失败', async () => {
    // 「一家失败整体 502」是初版缺陷：用户看到的是「网关坏了」，
    // 真实原因只是某一个 provider 没登录。
    const skipped: string[] = []
    const groups = await collectGatewayModels(makeSource(), (provider) => skipped.push(provider))
    expect(groups.map(g => g.provider)).toEqual(['qoder'])
    expect(skipped).toEqual(['broken'])
  })

  it('不给 onError 也照常跳过（不把错误抛给调用方）', async () => {
    await expect(collectGatewayModels(makeSource())).resolves.toHaveLength(1)
  })

  it('collectGatewayModelIds 与 /v1/models 返回同一批 ID（两处必须同源）', async () => {
    // 漂移的症状是「照着设置页填的模型号却不被网关接受」，极难自查。
    const groups = await collectGatewayModels(makeSource())
    const fromEndpoint = toOpenAiModels(groups).map(m => m.id)
    const fromRpc = (await collectGatewayModelIds(makeSource())).map(m => m.id)
    expect(fromRpc).toEqual(fromEndpoint)
    expect(fromRpc).toEqual(['qoder/qfmodel'])
  })

  it('ID 保留原始大小写（大小写敏感，规范化会掩盖真实 ID）', async () => {
    const source = {
      listProviders: () => [{ id: 'codearts' }],
      // 同一 provider 内大小写就是混的：glm-5.3-flash 与 GLM-5.2 并存。
      listModels: async () => [{ id: 'glm-5.3-flash', name: 'A' }, { id: 'GLM-5.2', name: 'B' }],
    }
    const ids = (await collectGatewayModelIds(source)).map(m => m.id)
    expect(ids).toEqual(['codearts/glm-5.3-flash', 'codearts/GLM-5.2'])
  })

  it('模型名里带斜杠时只按第一个斜杠切分', async () => {
    const source = {
      listProviders: () => [{ id: 'cline' }],
      listModels: async () => [{ id: 'anthropic/claude-sonnet-5.5', name: 'Claude' }],
    }
    expect((await collectGatewayModelIds(source))[0].id).toBe('cline/anthropic/claude-sonnet-5.5')
  })

  /**
   * ⚠️ 设置页按「一家供应商一张卡片」分组，靠的就是这两个字段。
   *
   * 前端**不能**自己按首个 `/` 反推：模型名里允许带斜杠（上一条），
   * 反推出来的 `provider` 会变成 `cline` 而名字是 `anthropic/claude-sonnet-5.5` ——
   * 在斜杠模型上恰好也对，但那是巧合；真正的契约是采集侧给的拆分。
   * 这里锁的是「字段就是采集时的 provider/模型名，一个字符都没加工」。
   */
  it('★ 回传权威的 provider / model 拆分（前端据此分组，不靠切 id 反推）', async () => {
    const source = {
      listProviders: () => [{ id: 'cline' }],
      listModels: async () => [{ id: 'anthropic/claude-sonnet-5.5', name: 'Claude' }],
    }
    const [entry] = await collectGatewayModelIds(source)
    expect(entry.provider).toBe('cline')
    // ⚠️ `model` 是**带斜杠的完整模型名**（`anthropic/...`），不是 `claude-sonnet-5.5`：
    // 它就是 `listModels` 给的那个 id，网关路由也按它拼回完整 ID。
    expect(entry.model).toBe('anthropic/claude-sonnet-5.5')
    expect(`${entry.provider}/${entry.model}`).toBe(entry.id)
  })

  it('★ provider 与 model 拼回去必须逐字等于 id（分组与路由不会错位）', async () => {
    // 覆盖三种形态：普通、模型名带斜杠、provider 名里带连字符。
    const source = {
      listProviders: () => [{ id: 'deepseek-account' }, { id: 'cline' }],
      listModels: async (provider: string) => (provider === 'cline'
        ? [{ id: 'anthropic/claude-sonnet-5.5', name: 'C' }]
        : [{ id: 'deepseek-flash', name: 'D' }, { id: 'deepseek-v4-pro', name: 'P' }]),
    }
    for (const entry of await collectGatewayModelIds(source)) {
      expect(`${entry.provider}/${entry.model}`, entry.id).toBe(entry.id)
    }
  })

  // 以下三条是**实机报障**后复现出来的畸形输入（真实 DSH service 的形态与类型
  // 声明可能不一致）。它们曾让目录采集直接抛错，进而把设置页**整个状态读取**
  // 一起拖垮 —— 用户连开关、地址、密钥都看不到。
  it('⚠️ 承诺永不抛出：listProviders 返回非数组', async () => {
    await expect(collectGatewayModels({ listProviders: () => undefined, listModels: async () => [] }))
      .resolves.toEqual([])
  })

  it('⚠️ 承诺永不抛出：listModels 返回非数组', async () => {
    const skipped: string[] = []
    const groups = await collectGatewayModels(
      { listProviders: () => [{ id: 'a' }], listModels: async () => undefined },
      (provider) => skipped.push(provider),
    )
    expect(groups).toEqual([])
    expect(skipped).toEqual(['a'])
  })

  it('⚠️ 承诺永不抛出：provider 条目缺 id / listProviders 自身抛错', async () => {
    // 缺 id 的条目被丢弃，合法的 `ok` 照常保留 —— 而不是整份目录一起崩掉。
    await expect(collectGatewayModels({
      listProviders: () => [{}, { id: 'ok' }],
      listModels: async () => [],
    })).resolves.toEqual([{ provider: 'ok', models: [] }])
    await expect(collectGatewayModels({
      listProviders: () => { throw new Error('boom') },
      listModels: async () => [],
    })).resolves.toEqual([])
  })

  it('一个 provider 目录畸形不影响其它 provider 的模型出现在清单里', async () => {
    const groups = await collectGatewayModels({
      listProviders: () => [{ id: 'broken' }, { id: 'good' }],
      listModels: async (provider) => {
        if (provider === 'broken') throw new Error('no credentials')
        return [{ id: 'm', name: 'M' }]
      },
    })
    expect(groups.map(g => g.provider)).toEqual(['good'])
  })

  it('透传 inputModalities（决定用户能否给该模型发图）', async () => {
    const source = {
      listProviders: () => [{ id: 'lobsterai' }],
      listModels: async () => [
        { id: 'vision', name: 'V', inputModalities: ['text', 'image'] as const },
        { id: 'text-only', name: 'T', inputModalities: ['text'] as const },
      ],
    }
    const models = await collectGatewayModelIds(source)
    expect(models.find(m => m.id.endsWith('vision'))?.input).toEqual(['text', 'image'])
    expect(models.find(m => m.id.endsWith('text-only'))?.input).toEqual(['text'])
  })

  it('⚠️ 缺 inputModalities 时归一化为 [text]（少报能力好过让用户发一张必被拒的图）', async () => {
    const source = {
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'm', name: 'M' }],
    }
    expect((await collectGatewayModelIds(source))[0].input).toEqual(['text'])
  })

  it('input 必须是副本：调用方改返回值不得污染上游对象', async () => {
    const shared = { id: 'm', name: 'M', inputModalities: ['text', 'image'] as const }
    const source = { listProviders: () => [{ id: 'p' }], listModels: async () => [shared] }
    const model = (await collectGatewayModelIds(source))[0]
    expect(model.input).not.toBe(shared.inputModalities)
  })

  it('与 /v1/models 返回的 input 同源（两处漂移会让用户选错模型）', async () => {
    const source = {
      listProviders: () => [{ id: 'codearts' }],
      listModels: async () => [{ id: 'GLM-5.2', name: 'G', inputModalities: ['text'] as const }],
    }
    const groups = await collectGatewayModels(source)
    expect(toOpenAiModels(groups)[0].input).toEqual((await collectGatewayModelIds(source))[0].input)
  })
})

/**
 * 思考档位视图（`/v1/models` 的 `reasoning` 字段、`/v1/reasoning-efforts`
 * 与设置页 RPC 共用同一份）。
 *
 * 背景（真实缺陷）：各 provider 的档位 id 是上游私有值（TRAE 的
 * `light`/`extra_high`、LobsterAI 的 `xhigh`（界面上叫 Max）、Cline 的 `max`
 * （界面上叫 Extra）、Raccoon 的 `on`/`off`），而走 OpenAI 协议的客户端只有
 * 固定 8 档词汇 —— 用户只能照 DSH 界面上的名字猜着填，猜错就是 400。
 */
describe('collectGatewayEffortViews（思考档位视图）', () => {
  const FLASH = { id: 'deepseek-v4.1-flash', name: 'Flash' }
  const TRAE_REASONING = {
    reasoning: {
      efforts: [
        { id: 'light', name: 'Light' },
        { id: 'high', name: 'High' },
        { id: 'extra_high', name: 'Extra High' },
      ],
      defaultEffort: 'high',
    },
  }
  /** `resolveModelInfo` 传 undefined 模拟「宿主不提供该能力」。 */
  const traeSource = (resolveModelInfo?: (provider: string, model: string) => Promise<unknown>) => ({
    listProviders: () => [{ id: 'trae' }],
    listModels: async () => [FLASH],
    ...resolveModelInfo === undefined ? {} : { resolveModelInfo },
  })

  it('★ 把模型声明的私有档位翻译成「客户端该填」的规范名', async () => {
    const source = traeSource(async () => ({ provider: 'trae', ...FLASH, ...TRAE_REASONING }))
    const groups = await collectGatewayModels(source)
    const view = (await collectGatewayEffortViews(source, groups)).get('trae/deepseek-v4.1-flash')
    expect(view?.openai_efforts).toEqual(['low', 'high', 'xhigh'])
    expect(view?.efforts).toEqual([
      { id: 'light', name: 'Light', canonical: 'low' },
      { id: 'high', name: 'High', canonical: 'high' },
      { id: 'extra_high', name: 'Extra High', canonical: 'xhigh' },
    ])
    expect(view?.default).toBe('high')
  })

  it('Raccoon 的二元开关也如实投影（off → none、on → high）', async () => {
    // ⚠️ **顺序跟着声明走**（Issue IKLIDV）：`openai_efforts` 是声明顺序的
    // 机械投影（`effort-view.ts` 逐个 push `canonical`），声明已按强度序
    // 规整成 `off → on`，故这里也必须是 `none → high`（由弱到强）。
    const source = traeSource(async () => ({
      reasoning: { efforts: [{ id: 'off', name: '关闭' }, { id: 'on', name: '开启' }], defaultEffort: 'on' },
    }))
    const groups = await collectGatewayModels(source)
    const view = (await collectGatewayEffortViews(source, groups)).get('trae/deepseek-v4.1-flash')
    expect(view?.openai_efforts).toEqual(['none', 'high'])
  })

  /**
   * ⚠️ **CodeArts 的真实声明必须投影成升序的 `openai_efforts`**（Issue IKLIDV）。
   *
   * 这是本 issue 在**本仓库可离线观测**的那一半：档位顺序会一路透传到网关的
   * `/v1/models`（`openai_efforts` 是声明顺序的机械投影）。故用**适配器真实声明**
   *（而不是手写字面量）驱动一遍，确认端到端方向正确 —— 手写字面量的用例
   * 只能证明「投影函数不改序」，证明不了「声明本身是升序」。
   */
  it('★ CodeArts 的两档经真实适配器投影后是升序（none → high）', async () => {
    const adapter = new CodeArtsAdapter({
      credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
      resolveCredential: async () => ({
        access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
        expires_at: '2099-01-01T00:00:00Z',
      }),
      refresh: async () => {},
      fetchImpl: async () => new Response('not found', { status: 404 }),
    })
    const info = await adapter.resolveModel('codearts', 'GLM-5.2')
    const source = traeSource(async () => ({ provider: 'codearts', ...FLASH, reasoning: info.reasoning }))
    const groups = await collectGatewayModels(source)
    const view = (await collectGatewayEffortViews(source, groups)).get('trae/deepseek-v4.1-flash')
    expect(view?.openai_efforts).toEqual(['none', 'high'])
  })

  it('/v1/models 与设置页 RPC 的档位必须同源（各算一遍必然漂移）', async () => {
    const source = traeSource(async () => ({ ...TRAE_REASONING }))
    const groups = await collectGatewayModels(source)
    const views = await collectGatewayEffortViews(source, groups)
    expect(toOpenAiModels(groups, views)[0].reasoning).toEqual(toGatewayModelIds(groups, views)[0].reasoning)
  })

  it('⚠️ 模型未声明档位时整个字段缺省（不是空数组：「不知道」≠「一个都没有」）', async () => {
    const source = traeSource(async () => ({ provider: 'trae', ...FLASH }))
    const groups = await collectGatewayModels(source)
    const views = await collectGatewayEffortViews(source, groups)
    expect(views.size).toBe(0)
    expect('reasoning' in toOpenAiModels(groups, views)[0]).toBe(false)
  })

  it('⚠️ 宿主没有 resolveModelInfo 时静默返回空表（附加能力，不能让目录失败）', async () => {
    const source = traeSource()
    const groups = await collectGatewayModels(source)
    await expect(collectGatewayEffortViews(source, groups)).resolves.toEqual(new Map())
    expect((await collectGatewayModelIds(source)).map(m => m.id)).toEqual(['trae/deepseek-v4.1-flash'])
  })

  it('⚠️ 单个模型的档位解析失败只影响它自己，目录照常返回', async () => {
    const source = {
      listProviders: () => [{ id: 'trae' }],
      listModels: async () => [FLASH, { id: 'ok', name: 'OK' }],
      resolveModelInfo: async (_provider: string, model: string) => {
        if (model === 'deepseek-v4.1-flash') throw new Error('boom')
        return { reasoning: { efforts: [{ id: 'high', name: 'High' }] } }
      },
    }
    const failures: string[] = []
    const groups = await collectGatewayModels(source)
    const views = await collectGatewayEffortViews(source, groups, (_provider, error) => failures.push(String(error)))
    expect([...views.keys()]).toEqual(['trae/ok'])
    expect(failures).toHaveLength(1)
    // 报错里必须能看出是**哪一个模型**解析失败（否则日志里只有一句 boom）。
    expect(failures[0]).toContain('deepseek-v4.1-flash')
    expect(await collectGatewayModelIds(source)).toHaveLength(2)
  })

  it('default 必须是模型真声明过的 id（否则客户端照它填就会 400）', async () => {
    const source = traeSource(async () => ({
      reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'max' },
    }))
    const groups = await collectGatewayModels(source)
    expect((await collectGatewayEffortViews(source, groups)).get('trae/deepseek-v4.1-flash')?.default)
      .toBeUndefined()
  })

  it('声明里混入脏数据时跳过它，而不是让整个视图崩掉', async () => {
    const source = traeSource(async () => ({
      reasoning: { efforts: [{ name: '无 id' }, { id: 'high', name: 'High' }, { id: 42 }] },
    }))
    const groups = await collectGatewayModels(source)
    const view = (await collectGatewayEffortViews(source, groups)).get('trae/deepseek-v4.1-flash')
    expect(view?.efforts).toEqual([{ id: 'high', name: 'High', canonical: 'high' }])
  })
})

/**
 * issue #36：/v1/models 必须有 context_window。
 *
 * ⚠️ 不能只靠适配器在 listModels 里多带字段：宿主 LlmRuntime.listModels 会
 * 按白名单重建对象（只留 provider/id/name/description/inputModalities）。
 * 唯一还带窗口的是 resolveModelInfo().context.contextWindow，而网关本来就会
 * 为档位逐个调用它 ⇒ 同一次调用里把窗口也读出来。
 */
describe('context_window（issue #36）', () => {
  const source = {
    listProviders: () => [{ id: 'qoder' }],
    listModels: async () => [{ id: 'qfmodel', name: 'Qwen Flash' }],
    resolveModelInfo: async (provider: string, id: string) => ({
      provider,
      id,
      context: { contextWindow: 128_000 },
    }),
  }

  it('★★ 逐模型解析窗口，合并后 /v1/models 输出 context_window', async () => {
    const groups = await collectGatewayModels(source)
    const details = await collectGatewayModelDetails(source, groups)
    expect(details.contextWindows.get('qoder/qfmodel')).toBe(128_000)
    const models = toOpenAiModels(applyGatewayContextWindows(groups, details.contextWindows), details.effortViews)
    expect(models[0]?.context_window).toBe(128_000)
  })

  it('resolveModelInfo 缺失/失败时不发字段，也不让目录失败', async () => {
    const noResolve = { listProviders: () => [{ id: 'qoder' }], listModels: async () => [{ id: 'm', name: 'M' }] }
    const groups = await collectGatewayModels(noResolve)
    const details = await collectGatewayModelDetails(noResolve, groups)
    expect(details.contextWindows.size).toBe(0)
    expect(toOpenAiModels(applyGatewayContextWindows(groups, details.contextWindows))[0]?.context_window)
      .toBeUndefined()
  })
})
