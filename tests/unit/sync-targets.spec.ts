import { describe, it, expect } from 'vitest'
import {
  SyncPlanError,
  findPiProvider,
  findZcodeProvider,
  planPiSync,
  planZcodeSync,
  type SyncModel,
} from '../../src/sync-targets.js'

/**
 * 纯逻辑层用例：**不碰磁盘**。
 *
 * 这一层的职责边界（后续接线 RPC 时不许越界）：
 * - 只接收「当前文件内容」+「网关模型目录」，返回「新文件内容 + diff」；
 * - 不读写任何路径，不做备份（那是 `sync-apply.ts` 的事）。
 * 这样 90% 的行为都能用内存对象断言，不需要临时目录。
 */

/** 网关地址（与 openai-gateway/config.ts 的默认端口一致）。 */
const GATEWAY_BASE = 'http://127.0.0.1:8326/v1'

/** 构造一条网关模型目录条目。 */
function model(id: string, contextWindow = 1000000, maxTokens = 128000): SyncModel {
  return { id, name: id, contextWindow, maxTokens, input: ['text'] }
}

/** 构造一份最小 pi models.json（含一条已存在的网关 provider）。 */
function piConfig(models: readonly Record<string, unknown>[]): Record<string, any> {
  return {
    providers: {
      // 8625 那条是「不该被动到」的旁证：同文件里有别的 provider
      local: {
        name: 'local',
        baseUrl: 'http://localhost:8325/v1',
        apiKey: 'fake-key-local-not-touched',
        api: 'openai-completions',
        models: [{ id: 'innno/deepseek-v4-pro', name: 'innno/deepseek-v4-pro', contextWindow: 1000000, maxTokens: 384000, input: ['text'] }],
      },
      'dsh-gateway': {
        name: 'dsh-gateway',
        baseUrl: GATEWAY_BASE,
        apiKey: 'gateway-key-must-survive',
        api: 'openai-completions',
        models: [...models],
      },
    },
  }
}

describe('findPiProvider — 按 baseUrl 定位目标 provider', () => {
  it('命中端口相同的 provider', () => {
    const config = piConfig([])
    expect(findPiProvider(config, GATEWAY_BASE)).toBe('dsh-gateway')
  })

  it('忽略路径差异与末尾斜杠（用户可能写 /v1 或不写）', () => {
    const config = piConfig([])
    expect(findPiProvider(config, 'http://127.0.0.1:8326')).toBe('dsh-gateway')
    expect(findPiProvider(config, 'http://127.0.0.1:8326/v1/')).toBe('dsh-gateway')
  })

  it('找不到时抛 SyncPlanError，且错误里点名要找的地址', () => {
    const config = { providers: { local: { name: 'local', baseUrl: 'http://localhost:8325/v1', models: [], api: 'openai-completions', apiKey: 'k' } } }
    expect(() => findPiProvider(config, GATEWAY_BASE)).toThrow(SyncPlanError)
    expect(() => findPiProvider(config, GATEWAY_BASE)).toThrow(/8326/)
  })
})

describe('planPiSync — pi 侧模型表刷新', () => {
  it('新增模型补进来，已删除模型移除', () => {
    const config = piConfig([
      { id: 'old/removed-model', name: 'old/removed-model', contextWindow: 1, maxTokens: 1, input: ['text'] },
      { id: 'codearts/keep-me', name: 'codearts/keep-me', contextWindow: 1000000, maxTokens: 128000, input: ['text'] },
    ])
    const plan = planPiSync(config, [model('codearts/keep-me'), model('codearts/brand-new')], GATEWAY_BASE)
    const ids = plan.config.providers['dsh-gateway'].models.map((m: any) => m.id)
    expect(ids).toEqual(['codearts/keep-me', 'codearts/brand-new'])
    expect(plan.diff.added).toEqual(['codearts/brand-new'])
    expect(plan.diff.removed).toEqual(['old/removed-model'])
  })

  it('⚠️ 按模型 id 保留 pi 本地字段（reasoning / thinkingLevelMap / compat）—— 丢掉会让用户手调档位归零', () => {
    const config = piConfig([
      {
        id: 'codearts/keep-me',
        name: 'codearts/keep-me',
        contextWindow: 1,
        maxTokens: 1,
        input: ['text'],
        reasoning: true,
        thinkingLevelMap: { low: 'low', high: 'high' },
        compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
      },
    ])
    const plan = planPiSync(config, [model('codearts/keep-me')], GATEWAY_BASE)
    const kept = plan.config.providers['dsh-gateway'].models[0]
    expect(kept.reasoning).toBe(true)
    expect(kept.thinkingLevelMap).toEqual({ low: 'low', high: 'high' })
    expect(kept.compat).toEqual({ supportsDeveloperRole: false, maxTokensField: 'max_tokens' })
  })

  it('⚠️ 不搬运密钥：apiKey / baseUrl / api 原样保留', () => {
    const config = piConfig([])
    const plan = planPiSync(config, [model('codearts/a')], GATEWAY_BASE)
    const provider = plan.config.providers['dsh-gateway']
    expect(provider.apiKey).toBe('gateway-key-must-survive')
    expect(provider.baseUrl).toBe(GATEWAY_BASE)
    expect(provider.api).toBe('openai-completions')
  })

  it('外科手术：同文件里其它 provider 一个字节都不动', () => {
    const config = piConfig([])
    const before = JSON.parse(JSON.stringify(config.providers.local))
    const plan = planPiSync(config, [model('codearts/a')], GATEWAY_BASE)
    expect(plan.config.providers.local).toEqual(before)
  })

  it('能力值变化记为 updated，并写入新值', () => {
    const config = piConfig([{ id: 'codearts/a', name: 'codearts/a', contextWindow: 111, maxTokens: 222, input: ['text'] }])
    const plan = planPiSync(config, [model('codearts/a', 999, 888)], GATEWAY_BASE)
    expect(plan.diff.updated).toEqual(['codearts/a'])
    const m = plan.config.providers['dsh-gateway'].models[0]
    expect([m.contextWindow, m.maxTokens]).toEqual([999, 888])
  })

  it('⚠️ contextWindow 非法（0 / 负数 / NaN）必须跳过而不是写坏配置', () => {
    const config = piConfig([])
    const plan = planPiSync(
      config,
      [
        model('codearts/ok'),
        { id: 'codearts/zero', name: 'codearts/zero', contextWindow: 0, maxTokens: 100, input: ['text'] },
        { id: 'codearts/neg', name: 'codearts/neg', contextWindow: -1, maxTokens: 100, input: ['text'] },
        { id: 'codearts/nan', name: 'codearts/nan', contextWindow: Number.NaN, maxTokens: 100, input: ['text'] },
      ],
      GATEWAY_BASE,
    )
    const ids = plan.config.providers['dsh-gateway'].models.map((m: any) => m.id)
    expect(ids).toEqual(['codearts/ok'])
    expect(plan.diff.skipped).toEqual(['codearts/zero', 'codearts/neg', 'codearts/nan'])
  })

  it('⚠️ maxTokens 缺失不算非法：省略该字段而不是跳过模型（网关实测 369 个模型无一带 max_tokens）', () => {
    const config = piConfig([])
    const noMax = { id: 'codearts/nomax', name: 'codearts/nomax', contextWindow: 202752, input: ['text'] }
    const plan = planPiSync(config, [noMax as any], GATEWAY_BASE)
    const entry = plan.config.providers['dsh-gateway'].models[0]
    expect(entry.id).toBe('codearts/nomax')
    expect(entry.contextWindow).toBe(202752)
    expect(entry).not.toHaveProperty('maxTokens')
    expect(plan.diff.skipped).toEqual([])
  })

  it('⚠️ maxTokens 缺失时必须保留目标里已有的值（不因目录不说就把它删掉）', () => {
    const config = piConfig([{ id: 'codearts/keep', name: 'codearts/keep', contextWindow: 202752, maxTokens: 65536, input: ['text'] }])
    const noMax = { id: 'codearts/keep', name: 'codearts/keep', contextWindow: 202752, input: ['text'] }
    const plan = planPiSync(config, [noMax as any], GATEWAY_BASE)
    expect(plan.config.providers['dsh-gateway'].models[0].maxTokens).toBe(65536)
    // 无变化，不应算 updated
    expect(plan.diff.updated).toEqual([])
  })

  it('幂等：同一目录再算一次，diff 三项全空', () => {
    const config = piConfig([{ id: 'codearts/a', name: 'codearts/a', contextWindow: 1000000, maxTokens: 128000, input: ['text'] }])
    const plan = planPiSync(config, [model('codearts/a')], GATEWAY_BASE)
    expect(plan.diff.added).toEqual([])
    expect(plan.diff.removed).toEqual([])
    expect(plan.diff.updated).toEqual([])
  })
})

/** 构造一份最小 ZCode provider_config.json。 */
function zcodeConfig(personalModelIds: readonly string[], extraRules: readonly Record<string, unknown>[] = []): Record<string, any> {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: ['bigmodel-api', 'dsh-openai-gateway'],
      providerConfigRules: {
        providerRules: [
          { providerId: 'bigmodel-api', templateId: 'bigmodel-api', config: { access: { type: 'api-key', apiKey: 'bigmodel-key-untouched' } } },
          {
            providerId: 'dsh-openai-gateway',
            providerName: 'dsh',
            enabled: true,
            config: {
              group: 'standard-personal',
              access: { type: 'api-key', apiKey: 'zcode-gateway-key-must-survive' },
              api: { type: 'openai-chat-completions', baseUrl: GATEWAY_BASE },
              // 手工顺序：同步必须尊重它，不能按字母重排
              personalModelIds: [...personalModelIds],
              modelOrder: [...personalModelIds],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [...extraRules],
        manualProviderModelRules: [],
      },
    },
  }
}

describe('findZcodeProvider — 按 baseUrl 定位 ZCode 里的网关 provider', () => {
  it('命中并按 providerId 返回', () => {
    expect(findZcodeProvider(zcodeConfig([]), GATEWAY_BASE)).toBe('dsh-openai-gateway')
  })

  it('找不到时抛 SyncPlanError', () => {
    const config = zcodeConfig([])
    config.config.providerConfigRules.providerRules[1].config.api.baseUrl = 'http://127.0.0.1:9999/v1'
    expect(() => findZcodeProvider(config, GATEWAY_BASE)).toThrow(SyncPlanError)
  })
})

/** 取某个渠道在 plan 结果里对应的 provider 条目（providerId = dsh-<渠道>）。 */
function zcodeProviderOf(plan: any, channel: string): any {
  const rules = plan.config.config.providerConfigRules.providerRules
  return rules.find((r: any) => String(r.providerId) === 'dsh-' + channel)
}

describe('planZcodeSync — 每渠道一个 provider', () => {
  it('⚠️⚠️ 模型按渠道拆成多个 provider（而不是全塞进一个 dsh 条目）', () => {
    const config = zcodeConfig([])
    const plan = planZcodeSync(config, [model('codearts/a'), model('codearts/b'), model('buddy/x')], GATEWAY_BASE)
    expect(zcodeProviderOf(plan, 'codearts').config.personalModelIds).toEqual(['codearts/a', 'codearts/b'])
    expect(zcodeProviderOf(plan, 'buddy').config.personalModelIds).toEqual(['buddy/x'])
  })

  it('⚠️ 升级前的单一条目（dsh-openai-gateway）必须被移除，否则同一模型会出现两次', () => {
    const config = zcodeConfig(['codearts/a'])
    const plan = planZcodeSync(config, [model('codearts/a')], GATEWAY_BASE)
    const ids = plan.config.config.providerConfigRules.providerRules.map((r: any) => String(r.providerId))
    expect(ids).not.toContain('dsh-openai-gateway')
    expect(ids).toContain('dsh-codearts')
  })

  it('新 provider 继承模板的连接参数（group / access 含 apiKey / api 含 baseUrl / 启用态）', () => {
    const config = zcodeConfig([])
    const plan = planZcodeSync(config, [model('codearts/a')], GATEWAY_BASE)
    const provider = zcodeProviderOf(plan, 'codearts')
    expect(provider.config.access.apiKey).toBe('zcode-gateway-key-must-survive')
    expect(provider.config.api.baseUrl).toBe(GATEWAY_BASE)
    expect(provider.config.api.type).toBe('openai-chat-completions')
    expect(provider.config.group).toBe('standard-personal')
    expect(provider.enabled).toBe(true)
  })

  it('保留已有手工顺序、新增追加到末尾（不按字母重排）', () => {
    const config = zcodeConfig(['codearts/b', 'codearts/a'])
    const plan = planZcodeSync(config, [model('codearts/a'), model('codearts/b'), model('codearts/c')], GATEWAY_BASE)
    expect(zcodeProviderOf(plan, 'codearts').config.modelOrder).toEqual(['codearts/b', 'codearts/a', 'codearts/c'])
  })

  it('⚠️ 每个模型的能力规则必须指向**它所属渠道**的 provider（缺 contextWindow 会让模型在 ZCode 里不可用）', () => {
    const config = zcodeConfig([])
    const plan = planZcodeSync(config, [model('codearts/a', 202752), model('buddy/x', 111)], GATEWAY_BASE)
    const rules = plan.config.config.modelConfigRules.providerModelRules
    expect(rules).toHaveLength(2)
    const a = rules.find((r: any) => r.modelId === 'codearts/a')
    const x = rules.find((r: any) => r.modelId === 'buddy/x')
    expect(a.providerId).toBe('dsh-codearts')
    expect(a.config.properties.contextWindow).toBe(202752)
    expect(x.providerId).toBe('dsh-buddy')
  })

  it('已有规则的 contextWindow 变化会被更新，不产生重复条目', () => {
    const config = zcodeConfig(['codearts/a'], [
      { providerId: 'dsh-openai-gateway', modelId: 'codearts/a', config: { properties: { contextWindow: 111 } } },
    ])
    const plan = planZcodeSync(config, [model('codearts/a', 999)], GATEWAY_BASE)
    const rules = plan.config.config.modelConfigRules.providerModelRules.filter((r: any) => r.modelId === 'codearts/a')
    expect(rules).toHaveLength(1)
    expect(rules[0].config.properties.contextWindow).toBe(999)
    expect(plan.diff.updated).toEqual(['codearts/a'])
  })

  it('渠道在目录里彻底消失 ⇒ 它的 provider 与能力规则一并移除', () => {
    const config = zcodeConfig(['codearts/a', 'buddy/gone'], [
      { providerId: 'dsh-openai-gateway', modelId: 'buddy/gone', config: { properties: { contextWindow: 1 } } },
    ])
    const plan = planZcodeSync(config, [model('codearts/a')], GATEWAY_BASE)
    const ids = plan.config.config.providerConfigRules.providerRules.map((r: any) => String(r.providerId))
    expect(ids).not.toContain('dsh-buddy')
    const ruleIds = plan.config.config.modelConfigRules.providerModelRules.map((r: any) => r.modelId)
    expect(ruleIds).not.toContain('buddy/gone')
    expect(plan.diff.removed).toEqual(['buddy/gone'])
  })

  it('外科手术：非网关 provider 的配置与能力规则一个字节都不动', () => {
    const config = zcodeConfig(['codearts/a'], [
      { providerId: 'bigmodel-api', modelId: 'GLM-5.3', config: { properties: { contextWindow: 77 } } },
    ])
    const beforeBigmodel = JSON.parse(JSON.stringify(config.config.providerConfigRules.providerRules[0]))
    const plan = planZcodeSync(config, [model('codearts/a')], GATEWAY_BASE)
    expect(plan.config.config.providerConfigRules.providerRules[0]).toEqual(beforeBigmodel)
    const bigmodelRule = plan.config.config.modelConfigRules.providerModelRules.find((r: any) => r.providerId === 'bigmodel-api')
    expect(bigmodelRule.config.properties.contextWindow).toBe(77)
  })

  it('providerOrder 保留原顺序、新 provider 追加在末尾、失效 id 被清掉', () => {
    const config = zcodeConfig(['codearts/a'])
    const plan = planZcodeSync(config, [model('codearts/a'), model('buddy/x')], GATEWAY_BASE)
    const order: string[] = plan.config.config.providerOrder
    expect(order).not.toContain('dsh-openai-gateway')
    expect(order).toContain('bigmodel-api')
    expect(order.indexOf('bigmodel-api')).toBeLessThan(order.indexOf('dsh-codearts'))
  })

  it('幂等：同一目录再算一次，diff 三项全空且 provider 数不增', () => {
    const config = zcodeConfig([])
    const first = planZcodeSync(config, [model('codearts/a'), model('buddy/x')], GATEWAY_BASE)
    const second = planZcodeSync(first.config, [model('codearts/a'), model('buddy/x')], GATEWAY_BASE)
    expect(second.diff.added).toEqual([])
    expect(second.diff.removed).toEqual([])
    expect(second.diff.updated).toEqual([])
    const ids = second.config.config.providerConfigRules.providerRules.map((r: any) => String(r.providerId))
    expect(ids.filter((id: string) => id.startsWith('dsh-'))).toHaveLength(2)
  })
})

describe('失败渠道保护 —— 临时故障不得误删', () => {
  /**
   * 背景：`collectGatewayModels` 对单个渠道失败是「静默跳过」。若某渠道
   * token 突然过期，它的模型会从目录消失；若照常判 removed，
   * **一次登录失效就会把用户两个工具的该渠道模型全删掉**。
   * 这里的用例锁死「保留」行为。
   */

  it('⚠️⚠️ pi：采集失败的渠道，其模型必须原文保留（不是「不删」而是「留回去」）', () => {
    const config = piConfig([
      { id: 'codearts/a', name: 'codearts/a', contextWindow: 100, maxTokens: 10, input: ['text'] },
      { id: 'codearts/b', name: 'codearts/b', contextWindow: 200, maxTokens: 20, input: ['text'], reasoning: true },
    ])
    // 目录里完全没有 codearts（模拟该渠道 listModels 抛错被跳过）
    const plan = planPiSync(config, [model('minimax/x')], GATEWAY_BASE, { failedProviders: ['codearts'] })
    const ids = plan.config.providers['dsh-gateway'].models.map((m: any) => m.id)
    expect(ids).toContain('codearts/a')
    expect(ids).toContain('codearts/b')
    expect(plan.diff.removed).toEqual([])
    expect(plan.diff.protectedModels.sort()).toEqual(['codearts/a', 'codearts/b'])
    // 本地字段也必须原样保留
    expect(plan.config.providers['dsh-gateway'].models.find((m: any) => m.id === 'codearts/b').reasoning).toBe(true)
  })

  it('⚠️ 没有标记为失败的渠道，其消失的模型**照常删除**（真下架要能清掉）', () => {
    const config = piConfig([{ id: 'codearts/gone', name: 'codearts/gone', contextWindow: 100, maxTokens: 10, input: ['text'] }])
    const plan = planPiSync(config, [model('minimax/x')], GATEWAY_BASE, { failedProviders: ['buddy'] })
    expect(plan.diff.removed).toEqual(['codearts/gone'])
    expect(plan.config.providers['dsh-gateway'].models.map((m: any) => m.id)).not.toContain('codearts/gone')
  })

  it('⚠️⚠️ ZCode：受保护渠道的 provider / 模型 / 能力规则全部原样保留（不重建、不改写 providerId）', () => {
    const config = zcodeConfig(['codearts/a'], [
      { providerId: 'dsh-openai-gateway', modelId: 'codearts/a', config: { properties: { contextWindow: 100 } } },
    ])
    const plan = planZcodeSync(config, [model('minimax/x')], GATEWAY_BASE, { failedProviders: ['codearts'] })
    // 受保护渠道不重建：仍挂在原来的 provider 上，字段一个不改
    const legacy = plan.config.config.providerConfigRules.providerRules
      .find((p: any) => p.providerId === 'dsh-openai-gateway')
    expect(legacy).toBeTruthy()
    expect(legacy.config.personalModelIds).toEqual(['codearts/a'])
    expect(legacy.enabled).toBe(true)
    // 也没有凭空多出一条 dsh-codearts
    expect(zcodeProviderOf(plan, 'codearts')).toBeFalsy()
    const rules = plan.config.config.modelConfigRules.providerModelRules
    const kept = rules.find((r: any) => r.modelId === 'codearts/a')
    expect(kept).toBeTruthy()
    // ⚠️ provider 没重建 ⇒ providerId 绝不能改写成 dsh-codearts（否则规则指向不存在的 provider）
    expect(kept.providerId).toBe('dsh-openai-gateway')
    expect(kept.config.properties.contextWindow).toBe(100)
    expect(plan.diff.removed).toEqual([])
    expect(plan.diff.protectedModels).toEqual(['codearts/a'])
  })

  it('未提供 failedProviders 时行为与从前逐字一致（不误保留）', () => {
    const config = piConfig([{ id: 'codearts/gone', name: 'codearts/gone', contextWindow: 100, maxTokens: 10, input: ['text'] }])
    const plan = planPiSync(config, [model('minimax/x')], GATEWAY_BASE)
    expect(plan.diff.removed).toEqual(['codearts/gone'])
    expect(plan.diff.protectedModels).toEqual([])
  })

  it('模型名里含 `/` 时按首个斜杠切 provider（不能把 model 段当渠道）', () => {
    const config = piConfig([{ id: 'zcode-cpa/innno/deepseek-v4-pro', name: 'x', contextWindow: 100, maxTokens: 10, input: ['text'] }])
    // 只有 zcode-cpa 失败 ⇒ 这个模型应被保留（其 provider 段是 zcode-cpa）
    const plan = planPiSync(config, [model('minimax/x')], GATEWAY_BASE, { failedProviders: ['zcode-cpa'] })
    expect(plan.diff.removed).toEqual([])
    expect(plan.diff.protectedModels).toEqual(['zcode-cpa/innno/deepseek-v4-pro'])
  })
})

/**
 * 审计回归（2026-11-12，PR #184 对抗性审计）。
 *
 * 每一条都对应一个**实测过的**数据销毁路径 —— 不是「理论上可能」。
 * 修法见 `src/sync-targets.ts` 里对应的 ⚠️ 注释。
 */
describe('审计回归 —— 不得静默删除用户配置', () => {
  it('⚠️⚠️ pi：目录侧能力值缺失（skipped）不得删掉目标里已有的模型', () => {
    const config = piConfig([
      { id: 'codearts/a', name: 'codearts/a', contextWindow: 1000000, maxTokens: 128000, input: ['text'] },
      { id: 'codearts/b', name: 'codearts/b', contextWindow: 1000000, maxTokens: 128000, input: ['text'] },
    ])
    // b 这次没拿到窗口（上游抖动 / resolveModelInfo 失败）
    const plan = planPiSync(config, [model('codearts/a'), { ...model('codearts/b'), contextWindow: 0 }], GATEWAY_BASE)
    expect(plan.diff.skipped).toEqual(['codearts/b'])
    // 关键：skipped 与 removed 不能同时出现（旧实现两者都报）
    expect(plan.diff.removed).toEqual([])
    expect(plan.config.providers['dsh-gateway'].models.map((m: any) => m.id))
      .toEqual(['codearts/a', 'codearts/b'])
  })

  it('⚠️⚠️ ZCode：skipped 的模型必须留在 personalModelIds 与能力规则里', () => {
    const config = zcodeConfig(['codearts/a', 'codearts/b'], [
      { providerId: 'dsh-openai-gateway', modelId: 'codearts/b', config: { properties: { contextWindow: 100 } } },
    ])
    const plan = planZcodeSync(config, [model('codearts/a'), { ...model('codearts/b'), contextWindow: NaN }], GATEWAY_BASE)
    expect(plan.diff.skipped).toContain('codearts/b')
    expect(plan.diff.removed).not.toContain('codearts/b')
    expect(zcodeProviderOf(plan, 'codearts').config.personalModelIds).toContain('codearts/b')
    const rules = plan.config.config.modelConfigRules.providerModelRules
    const kept = rules.find((r: any) => r.modelId === 'codearts/b')
    expect(kept).toBeTruthy()
    // 旧 provider 被删了，规则必须跟着迁到新 provider，否则悬空
    expect(kept.providerId).toBe('dsh-codearts')
  })

  it('⚠️⚠️ 手工创建、id 以 dsh- 开头但端点指向别家的 provider，其能力规则不得被删', () => {
    const config = zcodeConfig(['codearts/a'])
    config.config.providerConfigRules.providerRules.push({
      providerId: 'dsh-custom',
      providerName: 'dsh-custom',
      enabled: true,
      config: {
        access: { type: 'api-key', apiKey: 'custom-own-key' },
        api: { type: 'openai-chat-completions', baseUrl: 'https://api.my-own-vendor.example/v1' },
        personalModelIds: ['custom/foo'],
        modelOrder: ['custom/foo'],
      },
    })
    config.config.modelConfigRules.providerModelRules.push({
      providerId: 'dsh-custom', modelId: 'custom/foo', config: { properties: { contextWindow: 200000 } },
    })
    const plan = planZcodeSync(config, [model('codearts/a')], GATEWAY_BASE)
    const rules = plan.config.config.modelConfigRules.providerModelRules
    const custom = rules.find((r: any) => r.modelId === 'custom/foo')
    expect(custom).toBeTruthy()
    expect(custom.providerId).toBe('dsh-custom')
    expect(custom.config.properties.contextWindow).toBe(200000)
    // provider 本身也必须原样在（含它自己的 key）
    const provider = plan.config.config.providerConfigRules.providerRules
      .find((p: any) => p.providerId === 'dsh-custom')
    expect(provider.config.access.apiKey).toBe('custom-own-key')
    expect(provider.config.personalModelIds).toEqual(['custom/foo'])
  })

  it('⚠️ 受保护渠道的 provider 字段不得被模板覆盖（enabled / providerName / apiKey）', () => {
    const config = zcodeConfig(['codearts/a'])
    // 用户手工停用了 dsh-minimax（端点仍指向网关 ⇒ 属于管理范围）
    config.config.providerConfigRules.providerRules.push({
      providerId: 'dsh-minimax',
      providerName: '我自己的 MiniMax',
      enabled: false,
      config: {
        access: { type: 'api-key', apiKey: 'my-own-minimax-key' },
        api: { type: 'openai-chat-completions', baseUrl: GATEWAY_BASE },
        personalModelIds: ['minimax/x'],
        modelOrder: ['minimax/x'],
      },
    })
    const plan = planZcodeSync(config, [model('codearts/a')], GATEWAY_BASE, { failedProviders: ['minimax'] })
    const kept = plan.config.config.providerConfigRules.providerRules
      .find((p: any) => p.providerId === 'dsh-minimax')
    expect(kept.enabled).toBe(false)
    expect(kept.providerName).toBe('我自己的 MiniMax')
    expect(kept.config.access.apiKey).toBe('my-own-minimax-key')
    expect(kept.config.personalModelIds).toEqual(['minimax/x'])
  })

  it('⚠️ 无渠道前缀的旧模型必须如实报 removed（不能静默消失）', () => {
    const config = zcodeConfig(['bare-model', 'codearts/a'])
    const plan = planZcodeSync(config, [model('codearts/a')], GATEWAY_BASE)
    expect(plan.diff.removed).toContain('bare-model')
    expect(zcodeProviderOf(plan, 'codearts').config.personalModelIds).toEqual(['codearts/a'])
  })

  it('⚠️ 网关改了模型名或新增视觉能力时必须落盘（不能报「已是目标状态」）', () => {
    const config = piConfig([
      { id: 'codearts/a', name: 'old-name', contextWindow: 1000000, maxTokens: 128000, input: ['text'] },
    ])
    const next = { ...model('codearts/a'), name: 'new-name', input: ['text', 'image'] }
    const plan = planPiSync(config, [next], GATEWAY_BASE)
    expect(plan.diff.updated).toEqual(['codearts/a'])
    const written = plan.config.providers['dsh-gateway'].models.find((m: any) => m.id === 'codearts/a')
    expect(written.name).toBe('new-name')
    expect(written.input).toEqual(['text', 'image'])
  })

  it('⚠️ 升级残留（旧 provider 与新 provider 同装一条模型）不得写出重复 id', () => {
    const config = zcodeConfig(['codearts/a'])
    // 模拟「上一轮已建 dsh-codearts、旧 dsh-openai-gateway 还没清掉」的中间态
    config.config.providerConfigRules.providerRules.push({
      providerId: 'dsh-codearts',
      providerName: 'dsh-codearts',
      enabled: true,
      config: {
        access: { type: 'api-key', apiKey: 'k' },
        api: { type: 'openai-chat-completions', baseUrl: GATEWAY_BASE },
        personalModelIds: ['codearts/a'],
        modelOrder: ['codearts/a'],
      },
    })
    const plan = planZcodeSync(config, [model('codearts/a')], GATEWAY_BASE)
    const provider = zcodeProviderOf(plan, 'codearts')
    expect(provider.config.personalModelIds).toEqual(['codearts/a'])
    expect(provider.config.modelOrder).toEqual(['codearts/a'])
  })

  it('⚠️ 裸 host:port 的 baseUrl 必须按端口区分（旧实现不同端口归一成同一个端点）', () => {
    const config = piConfig([])
    // 两个裸地址，端口不同；8326 在前会被旧实现误命中
    const rules: Record<string, any> = config.providers
    rules['other-port'] = {
      ...rules['dsh-gateway'],
      name: 'other-port',
      baseUrl: 'localhost:9999',
      models: [],
    }
    rules['dsh-gateway'].baseUrl = 'localhost:8326'
    // 裸查询 8326 必须命中 8326 那条，而不是「第一个裸条目」
    expect(findPiProvider(config, 'localhost:8326')).toBe('dsh-gateway')
    expect(() => findPiProvider(config, 'localhost:8327')).toThrow(SyncPlanError)
  })
})
