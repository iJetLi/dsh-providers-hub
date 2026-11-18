/**
 * TRAE LLM 适配器单元测试。
 *
 * 覆盖 `src/trae-adapter.ts` 的模型目录与流式转换：
 * - `listModels` 的远端/兜底切换与黑名单过滤；
 * - `resolveModel` 的上下文窗口、输出上限、输入模态；
 * - `stream()` 的请求构造（OpenAI 到 SOLO 转换、请求头、URL）；
 * - **SOLO SSE 到 OpenAI StreamChunk 的转换**（本 provider 最核心的差异）；
 * - 凭据缺失 / 图片不支持的明确报错；
 * - 限流换号链路。
 *
 * 全部使用注入的 fetch 桩，不发真实网络请求。
 */

import { describe, expect, it, vi } from 'vitest'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { TRAE } from '../../src/trae-product.js'
import { OPENAI_DONE } from '../../src/trae.js'
import type { TraeCredential } from '../../src/trae.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

function makeCredential(overrides: Partial<TraeCredential> = {}): TraeCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    uid: 'uid-1',
    nickname: '测试账号',
    machine_id: 'a'.repeat(32),
    device_id: 'c'.repeat(32),
    ...overrides,
  }
}

/** 构造 SOLO SSE 响应体。 */
function soloSse(...events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event:${name}\ndata:${JSON.stringify(data)}\n\n`).join('')
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

interface AdapterHarness {
  adapter: TraeAdapter
  fetcher: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}

function makeAdapter(options: {
  /** 传 `null` 表示「解析不到凭据」；省略则用一个可用的默认凭据。 */
  credential?: TraeCredential | null
  responses?: Array<Response | (() => Response | Promise<Response>)>
  remoteModels?: Array<{
    id: string
    name: string
    contextWindow?: number
    maxOutputTokens?: number
    isCustomModel?: boolean
    isHidden?: boolean
    isEnabled?: boolean
    function?: string
    reasoningConfig?: { defaultLevel?: string; options: readonly string[]; supportThinking?: boolean }
    maxMode?: boolean
    maxContextWindow?: number
    maxModeOutputTokens?: number
    /** `display_config.multimodal` —— 该模型是否接受用户图片。 */
    multimodal?: boolean
    /** `display_config.tool_response_multimodal` —— 工具结果内嵌图能否回传。 */
    toolResponseMultimodal?: boolean
    /** 闲时折扣（`activity_discount.data.off_peak` 的已解析形状）。 */
    offPeakDiscount?: Record<string, unknown>
  }>
  /** 注入时钟（徽标必须在**装配时刻**吃它）。 */
  now?: () => number
  /** 桥接图片字节（`readImage`）；省略时适配器收到图片会报「需要附件服务」。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  accountPool?: unknown
  /** 覆盖产品配置（用于验证 hideInternalModels 等开关）。 */
  product?: typeof TRAE
} = {}): AdapterHarness {
  // 用 `null` 而非 `undefined` 作「无凭据」哨兵：省略该字段与显式传 undefined
  // 在可选参数里无法区分，测试会静默用上默认凭据而失去覆盖。
  const credential = options.credential === undefined ? makeCredential() : options.credential ?? undefined
  const responses = [...(options.responses ?? [])]
  const fetcher = vi.fn(async () => {
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected fetch call')
    return typeof next === 'function' ? await next() : next
  })
  const refresh = vi.fn(async () => {})
  const adapter = new TraeAdapter({
    credentialRef: 'TRAE_ACCESS_TOKEN' as never,
    resolveCredential: async () => credential,
    refresh,
    fetchImpl: fetcher as unknown as typeof fetch,
    ...options.remoteModels === undefined
      ? {}
      : { fetchRemoteModels: async () => options.remoteModels! },
    ...options.now === undefined ? {} : { now: options.now },
    ...options.accountPool === undefined ? {} : { accountPool: options.accountPool as never },
    ...options.readImage === undefined ? {} : { readImage: options.readImage },
    product: options.product ?? TRAE,
  })
  return { adapter, fetcher, refresh }
}

/** 收集 stream() 产出的全部 chunk。 */
async function collect(adapter: TraeAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

const BASIC_OPTIONS: GenerateOptions = {
  model: 'glm-5.2',
  messages: [{ role: 'user', content: '你好' }],
} as GenerateOptions

describe('TRAE 适配器 · providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    const { adapter } = makeAdapter()
    expect(adapter.providerInfo('trae')).toEqual({ id: 'trae', name: TRAE.displayName })
  })

  it('provider 非字符串时回退到产品 id（防御 undefined.toUpperCase 崩溃）', () => {
    // 模型设置页会用该 id 计算 deriveKeyRef(provider)（内部调 toUpperCase）。
    const { adapter } = makeAdapter()
    expect((adapter.providerInfo(undefined as never) as { id: string }).id).toBe('trae')
  })
})

describe('TRAE 适配器 · listModels', () => {
  it('远端可用时采信远端目录', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'remote-1', name: 'Remote One' }],
    })
    const models = await adapter.listModels('trae')
    expect(models).toEqual([
      { provider: 'trae', id: 'remote-1', name: 'Remote One', inputModalities: ['text'] },
    ])
  })

  it('远端不可用时回退产品兜底目录（28 个可见条目）', async () => {
    const { adapter } = makeAdapter()
    const models = await adapter.listModels('trae')
    const visible = TRAE.fallbackModels.filter((m) => m.isHidden !== true)
    expect(models).toHaveLength(visible.length)
    expect(models[0]!.id).toBe(visible[0]!.id)
  })

  it('inputModalities 按远端 multimodal 判定；未声明时保守为 text', async () => {
    // 兜底表没有 multimodal 字段 → 一律 text（「远端没说」不等于「远端支持」）。
    const { adapter } = makeAdapter()
    const models = await adapter.listModels('trae')
    for (const model of models) {
      expect(model.inputModalities).toEqual(['text'])
    }
  })

  it('⚠️ multimodal=true 的模型声明 image（Issue #IKHDKC 回归）', async () => {
    // 真实缺陷：早期这里恒为 ['text']，DSH 于是在**附件准入阶段**就拒掉图片
    // （用户看到「当前模型不支持图片」），而实测上游真的支持 —— 直发图片后
    // 模型能读出颜色。故必须逐模型判定，不能按 provider 一刀切。
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', multimodal: true },
        { id: 'glm-5.2', name: 'GLM-5.2', multimodal: false },
        { id: 'unknown', name: 'Unknown' },
      ],
    })
    const models = await adapter.listModels('trae')
    const byId = new Map(models.map((m) => [m.id, m.inputModalities]))
    expect(byId.get('deepseek-v4.1-flash')).toEqual(['text', 'image'])
    expect(byId.get('glm-5.2')).toEqual(['text'])
    // 字段缺失同样保守为 text。
    expect(byId.get('unknown')).toEqual(['text'])
  })

  it('应用账号池的模型黑名单（关闭的模型不出现在目录里）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      accountPool: {
        disabledModelsFor: () => new Set(['a']),
      },
    })
    const models = await adapter.listModels('trae')
    expect(models.map((m) => m.id)).toEqual(['b'])
  })

  it('黑名单为空集时不过滤', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'a', name: 'A' }],
      accountPool: { disabledModelsFor: () => new Set<string>() },
    })
    expect((await adapter.listModels('trae')).length).toBe(1)
  })

  /**
   * 模型目录门控：**没有已登录账号就不显示该 provider 的所有模型**。
   *
   * DSH 的 `buildModelCatalog` 显式 `.filter(group => group.models.length > 0)`，
   * 故 adapter 返回 `[]` 即可让整个 provider 分组从模型选择器消失。
   */
  describe('无已登录账号时隐藏整个 provider 目录', () => {
    /** 复刻真实账号池的替身（带 hasLoggedInAccount）。 */
    function poolWithLogin(loggedIn: boolean) {
      return {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => loggedIn,
      }
    }

    it('没有已登录账号 → listModels 返回空数组（分组被隐藏）', async () => {
      const { adapter } = makeAdapter({
        remoteModels: [{ id: 'a', name: 'A' }],
        accountPool: poolWithLogin(false),
      })
      expect(await adapter.listModels('trae')).toEqual([])
    })

    it('有已登录账号 → 正常返回目录', async () => {
      const { adapter } = makeAdapter({
        remoteModels: [{ id: 'a', name: 'A' }],
        accountPool: poolWithLogin(true),
      })
      expect((await adapter.listModels('trae')).map((m) => m.id)).toEqual(['a'])
    })

    it('⚠️ 无账号时**不发远端目录请求**（门控在 ensureRemoteModels 之前）', async () => {
      // 省掉无谓 HTTP；同时避免冷缓存路径下的额外延迟。
      const fetcher = vi.fn(async () => {
        throw new Error('本用例不应发起任何请求')
      })
      const adapter = new TraeAdapter({
        credentialRef: 'TRAE_ACCESS_TOKEN' as never,
        resolveCredential: async () => makeCredential(),
        refresh: vi.fn(async () => {}),
        fetchImpl: fetcher as unknown as typeof fetch,
        fetchRemoteModels: fetcher as never,
        accountPool: poolWithLogin(false) as never,
        product: TRAE,
      })
      expect(await adapter.listModels('trae')).toEqual([])
      expect(fetcher).not.toHaveBeenCalled()
    })

    it('⚠️ 返回空数组而**不是抛错**（抛错会变成 catalog 的 failure）', async () => {
      const { adapter } = makeAdapter({
        remoteModels: [{ id: 'a', name: 'A' }],
        accountPool: poolWithLogin(false),
      })
      await expect(adapter.listModels('trae')).resolves.toEqual([])
    })

    it('⚠️ 门控只影响 listModels；listAllModels（设置页）不受影响', async () => {
      // 设置页必须仍能列出全部模型 —— 否则用户关掉模型后连开关都看不到，
      // 更无法重新打开（这是此前修过的真实缺陷）。
      //
      // ⚠️ `listAllModels` 是**同步**的、不自己拉远端目录（由 `listModels` 或
      // `resolveModel` 触发 `ensureRemoteModels`），故这里先用 `resolveModel`
      // 把远端目录加载进来，再断言它不受门控影响。
      const { adapter } = makeAdapter({
        remoteModels: [{ id: 'a', name: 'A' }],
        accountPool: poolWithLogin(false),
      })
      // 门控生效：对话框目录为空
      expect(await adapter.listModels('trae')).toEqual([])
      // 但设置页仍能看到它（模拟真实调用顺序：先 resolveModel 加载目录）
      await adapter.resolveModel('trae', 'a')
      expect(adapter.listAllModels().map((m) => m.id)).toEqual(['a'])
    })

    it('⚠️ 替身未实现 hasLoggedInAccount 时保守放行（门控非安全边界）', async () => {
      // 能力检测：判定不可用时宁多勿少，否则整个 provider 的模型会凭空消失。
      const { adapter } = makeAdapter({
        remoteModels: [{ id: 'a', name: 'A' }],
        accountPool: { disabledModelsFor: () => new Set<string>() },
      })
      expect((await adapter.listModels('trae')).map((m) => m.id)).toEqual(['a'])
    })

    it('未提供 accountPool 时保守放行（headless / CLI 场景）', async () => {
      const { adapter } = makeAdapter({ remoteModels: [{ id: 'a', name: 'A' }] })
      expect((await adapter.listModels('trae')).map((m) => m.id)).toEqual(['a'])
    })
  })

  /**
   * 消耗倍率（`display_contact_config.consumption_rate.data.rate`）。
   *
   * 项目约定：倍率**必须拼进 `name`** —— composer 的模型切换菜单只渲染 `name`，
   * `description` 完全不读（用户报障「消耗倍率没有显示在切换模型列表的后面」）。
   */
  describe('消耗倍率进展示名', () => {
    it('常态倍率拼成 `名字 · x倍率`', async () => {
      const { adapter } = makeAdapter({
        remoteModels: [{ id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', creditsRate: 0.08 }],
      })
      const models = await adapter.listModels('trae')
      expect(models[0]!.name).toBe('Qwen3.8-Flash · x0.08')
    })

    it('活动期内显示 `原价→折后价`', async () => {
      const { adapter } = makeAdapter({
        remoteModels: [{
          id: 'doubao', name: 'Doubao Seed 2.1 Pro',
          creditsRate: 0.08, originalCreditsRate: 0.8, discountEndsAtSec: 1790265540,
        }],
      })
      const models = await adapter.listModels('trae')
      expect(models[0]!.name).toBe('Doubao Seed 2.1 Pro · x0.8→x0.08')
    })

    it('倍率为 0 是「免费」（合法值，不能当成无倍率）', async () => {
      const { adapter } = makeAdapter({
        remoteModels: [{ id: 'free', name: 'Free Model', creditsRate: 0 }],
      })
      const models = await adapter.listModels('trae')
      expect(models[0]!.name).toBe('Free Model · 免费')
    })

    it('无倍率信息时只显示模型名（不编造 x1）', async () => {
      const { adapter } = makeAdapter({
        remoteModels: [{ id: 'unknown', name: 'Unknown Model' }],
      })
      const models = await adapter.listModels('trae')
      expect(models[0]!.name).toBe('Unknown Model')
    })

    it('原价不高于折后价时不显示箭头（避免 x0.5→x0.5 这类无意义展示）', async () => {
      const { adapter } = makeAdapter({
        remoteModels: [{ id: 'x', name: 'X', creditsRate: 0.5, originalCreditsRate: 0.5 }],
      })
      const models = await adapter.listModels('trae')
      expect(models[0]!.name).toBe('X · x0.5')
    })

    /**
     * ⚠️ 免费模型要跳过「锁定永久积分」那道门（PR !68 审计补齐）。
     *
     * 不跳过的话：用户锁定永久积分 + 账号只剩永久积分 + 选中 `rate: 0` 的免费模型
     * ⇒ 落 `none` 档 ⇒ 抛「积分都已用尽」，而免费模型**根本不扣积分**，报错误导。
     * 这正是 buddy 系踩过的真实报障（见 `index.ts` 的 `isFreeModel` 参数注释）。
     */
    it('★ isFreeModel：creditsRate 恰为 0（免费）时返回 true', async () => {
      const { adapter } = makeAdapter({
        remoteModels: [
          { id: 'free', name: 'Free Model', creditsRate: 0 },
          { id: 'paid', name: 'Paid Model', creditsRate: 0.08 },
        ],
      })
      expect(await adapter.isFreeModel('free')).toBe(true)
    })

    it('isFreeModel：付费模型返回 false', async () => {
      const { adapter } = makeAdapter({
        remoteModels: [
          { id: 'free', name: 'Free Model', creditsRate: 0 },
          { id: 'paid', name: 'Paid Model', creditsRate: 0.08 },
        ],
      })
      expect(await adapter.isFreeModel('paid')).toBe(false)
    })

    it('★ isFreeModel：查不到目录 / 无倍率 / 空 modelId 一律 false（保守方向）', async () => {
      // 误判成免费会绕开锁定、真烧掉永久积分且不可撤回 —— 故只在确定时才 true。
      const unknown = makeAdapter({ remoteModels: [{ id: 'x', name: 'X' }] })
      expect(await unknown.adapter.isFreeModel('x')).toBe(false)
      expect(await unknown.adapter.isFreeModel('nope')).toBe(false)
      expect(await unknown.adapter.isFreeModel(undefined)).toBe(false)
      expect(await unknown.adapter.isFreeModel('')).toBe(false)
    })

    it('兜底表路径不带倍率（兜底表无该字段，不猜价格）', async () => {
      const { adapter } = makeAdapter()
      const models = await adapter.listModels('trae')
      // 兜底表条目名里不应出现 ` · x`。
      for (const model of models) {
        expect(model.name, model.id).not.toMatch(/ · x\d/)
      }
    })
  })

  /**
   * 「仅可见但不可调用」的自定义模型必须被挡在目录外。
   *
   * 实测（2026-09-19）：`display_config.is_custom_model === true` 的模型
   * 被上游以流内 `event:error code=4001 param is invalid` 拒绝。若照旧列出，
   * 用户在模型选择器里选中即得到一个指向「参数格式有问题」的上游报错。
   */
  it('剔除 is_custom_model 的模型（4001 真实缺陷回归）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'deepseek-v4-flash', name: 'DS Flash', isCustomModel: true },
        { id: 'DeepSeek-V4-Flash-Official', name: 'DS Flash Official', isCustomModel: false },
        { id: 'glm-5.2', name: 'GLM-5.2' },
      ],
    })
    expect((await adapter.listModels('trae')).map((m) => m.id)).toEqual([
      'DeepSeek-V4-Flash-Official',
      'glm-5.2',
    ])
  })

  it('只剔除明确标为自定义的模型，未声明该字段的一律保留', async () => {
    // 未声明 ≠ 自定义：保守方向是保留（宁可让用户看到一个可用模型，
    // 也不要因为缺字段而误删整批模型）。
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'no-flag', name: 'No Flag' },
        { id: 'explicit-false', name: 'Explicit False', isCustomModel: false },
      ],
    })
    expect((await adapter.listModels('trae')).map((m) => m.id)).toEqual(['no-flag', 'explicit-false'])
  })

  it('兜底目录始终剔除 isHidden 条目（28 个可见）', async () => {
    const { adapter } = makeAdapter()
    const ids = (await adapter.listModels('trae')).map((m) => m.id)
    const visibleCount = TRAE.fallbackModels.filter((m) => m.isHidden !== true).length
    expect(ids).toHaveLength(visibleCount)
    for (const hidden of ['browser_use_subagent', 'explore_sub_agent_v2', 'summary']) {
      expect(ids, hidden).not.toContain(hidden)
    }
  })

  /**
   * `isHidden`（对应 `is_invisible_to_user`）现在是**硬性过滤**条件：
   * 新设计要求目录与官方 Auto Mode 选择器一致，隐藏模型不出现在对话目录中。
   *
   * 与 `isCustomModel` 不同：`isHidden` 不表示「调不通」，只是 UI 上不展示。
   * 但新需求要求对齐官方选择器，故默认即剔除。
   */
  it('isHidden 条目始终被剔除（不再由开关控制）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'visible', name: 'V' },
        { id: 'glm-5.1', name: 'GLM-5.1', isHidden: true, function: 'solo_agent_remote' },
      ],
    })
    expect((await adapter.listModels('trae')).map((m) => m.id)).toEqual(['visible'])
  })

  it('剔除 config_switch=false 的停用条目', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'live', name: 'L' },
        { id: 'retired', name: 'R', isEnabled: false },
      ],
    })
    expect((await adapter.listModels('trae')).map((m) => m.id)).toEqual(['live'])
  })

  it('未声明的标志一律保留（只有明确命中才剔除）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B', isHidden: false, isEnabled: true, isCustomModel: false },
      ],
    })
    expect((await adapter.listModels('trae')).map((m) => m.id)).toEqual(['a', 'b'])
  })
})

/**
 * 通道路由：**模型只在列出它的通道里可调用**。
 *
 * 实测（2026-09-19，逐模型 × 逐通道）：
 * - `glm-5.1`：`solo_agent_remote` 有 output；`solo_work_lite` 回流内 `4001`
 * - `glm-5-turbo` / `sagitta` / `seed-code-pro-0430`：恰好相反
 * - `glm-5.2` / `kimi-k3`：两个通道都可用
 *
 * 因此发送时必须用**该模型所属的通道**，不能用全局固定的 `solo_work_lite` ——
 * 否则 agent 专有模型（`glm-5.1` 等）一用就报 `4001 param is invalid`。
 */
describe('TRAE 适配器 · 通道路由', () => {
  /** 取最近一次 chat 请求体。 */
  function lastBody(fetcher: { mock: { calls: unknown[] } }): Record<string, unknown> {
    const call = fetcher.mock.calls.at(-1) as [string, { body: string }]
    return JSON.parse(call[1].body) as Record<string, unknown>
  }

  it('按模型所属通道发送 function', async () => {
    const { adapter, fetcher } = makeAdapter({
      remoteModels: [{ id: 'glm-5.1', name: 'GLM-5.1', function: 'solo_agent_remote' }],
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, { ...BASIC_OPTIONS, model: 'glm-5.1' } as GenerateOptions)
    const body = lastBody(fetcher as never)
    expect(body.function).toBe('solo_agent_remote')
    expect(body.config_name).toBe('glm-5.1')
  })

  it('work 通道的模型仍发 solo_work_lite（既有行为不变）', async () => {
    const { adapter, fetcher } = makeAdapter({
      remoteModels: [{ id: 'glm-5-turbo', name: 'GLM-5 Turbo', function: 'solo_work_lite' }],
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, { ...BASIC_OPTIONS, model: 'glm-5-turbo' } as GenerateOptions)
    expect(lastBody(fetcher as never).function).toBe('solo_work_lite')
  })

  it('查不到所属通道时回退产品默认通道', async () => {
    const { adapter, fetcher } = makeAdapter({
      remoteModels: [{ id: 'unknown-chan', name: 'X' }],
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, { ...BASIC_OPTIONS, model: 'unknown-chan' } as GenerateOptions)
    expect(lastBody(fetcher as never).function).toBe(TRAE.function)
  })
})

describe('TRAE 适配器 · resolveModel', () => {
  it('上下文窗口取远端权威值', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000 }],
    })
    const resolved = await adapter.resolveModel('trae', 'glm-5.2')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('远端未声明时回退兜底表的 200000（实测值）', async () => {
    const { adapter } = makeAdapter()
    const resolved = await adapter.resolveModel('trae', 'glm-5.2')
    expect(resolved.context).toEqual({ contextWindow: 200_000 })
  })

  it('输出上限只取远端下发值（不编造）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'glm-5.2', name: 'GLM-5.2', maxOutputTokens: 64_000 }],
    })
    expect((await adapter.resolveModel('trae', 'glm-5.2')).defaultMaxTokens).toBe(64_000)
  })

  it('远端未声明输出上限时回退产品级兜底值（实测主流 32000）', async () => {
    // 实测远端主流模型声明的就是 32000；旧实现「无值就不发」会让 DSH 用
    // 自己的默认值（远大于 32000）去请求，反而更容易被上游拒。
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'no-limit', name: 'No Limit' }],
    })
    expect((await adapter.resolveModel('trae', 'no-limit')).defaultMaxTokens)
      .toBe(TRAE.fallbackMaxOutputTokens)
  })

  it('未声明 reasoning_effort_config 时不声明 reasoning（不臆造档位）', async () => {
    const { adapter } = makeAdapter()
    expect((await adapter.resolveModel('trae', 'glm-5.2')).reasoning).toBeUndefined()
  })

  // ── 推理强度（reasoning_effort_config）──

  it('默认档采信远端 default_level（不再一律取最强档）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{
        id: 'glm-5.3', name: 'GLM-5.3',
        reasoningConfig: { defaultLevel: 'high', options: ['light', 'high', 'extra_high'], supportThinking: true },
      }],
    })
    const reasoning = (await adapter.resolveModel('trae', 'glm-5.3')).reasoning
    expect(reasoning?.efforts.map((e) => e.id)).toEqual(['light', 'high', 'extra_high'])
    // 展示名做了美化（extra_high → Extra High），但 id 仍是 wire 值
    expect(reasoning?.efforts.find((e) => e.id === 'extra_high')?.name).toBe('Extra High')
    // ⚠️ 采信远端 default_level（'high'），不再一律取最强档 'extra_high'
    expect(reasoning?.defaultEffort).toBe('high')
  })

  it('远端 default_level 就是最高档时照用（glm-5.3 / kimi-k3 的真实形态）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{
        id: 'kimi-k3', name: 'Kimi-K3',
        reasoningConfig: { defaultLevel: 'extra_high', options: ['light', 'high', 'extra_high'] },
      }],
    })
    // 上游自己选了最高档 → 不能被「固定取次高档」的规则降下来。
    expect((await adapter.resolveModel('trae', 'kimi-k3')).reasoning?.defaultEffort).toBe('extra_high')
  })

  it('无 default_level 时退到最强档', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{
        id: 'x', name: 'X',
        reasoningConfig: { options: ['light', 'high', 'extra_high'] },
      }],
    })
    expect((await adapter.resolveModel('trae', 'x')).reasoning?.defaultEffort).toBe('extra_high')
  })

  it('default_level 不在 options 内时退到最强可用档（不照抄非法值）', async () => {
    // ⚠️ 实测上游确实会下发 default_level='max' 而 options 里没有 max。
    // 照抄会让 DSH 抛 UNSUPPORTED_REASONING_EFFORT，整轮对话起不来。
    const { adapter } = makeAdapter({
      remoteModels: [{
        id: 'x', name: 'X',
        reasoningConfig: { defaultLevel: 'max', options: ['low', 'high'] },
      }],
    })
    const reasoning = (await adapter.resolveModel('trae', 'x')).reasoning
    expect(reasoning?.defaultEffort).toBe('high')
    expect(reasoning?.efforts.some((e) => e.id === reasoning?.defaultEffort)).toBe(true)
  })

  it('options 含 max 时默认档取 max（即便它在数组中间，且上游未声明 default_level）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{
        id: 'x', name: 'X',
        reasoningConfig: { options: ['low', 'max', 'high'] },
      }],
    })
    expect((await adapter.resolveModel('trae', 'x')).reasoning?.defaultEffort).toBe('max')
  })

  it('options 全部未登记强度时默认档取末项（上游新增档位的退化路径）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{
        id: 'x', name: 'X',
        reasoningConfig: { options: ['alpha', 'beta'] },
      }],
    })
    const reasoning = (await adapter.resolveModel('trae', 'x')).reasoning
    expect(reasoning?.efforts.map((e) => e.id)).toEqual(['alpha', 'beta'])
    expect(reasoning?.defaultEffort).toBe('beta')
  })

  it('defaultEffort 恒落在 efforts 内（否则 DSH 会拿不存在的档位去请求）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{
        id: 'x', name: 'X',
        reasoningConfig: { defaultLevel: 'max', options: ['low', 'high'] },
      }],
    })
    const reasoning = (await adapter.resolveModel('trae', 'x')).reasoning
    expect(reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'high'])
    expect(reasoning?.defaultEffort).toBe('high')
    expect(reasoning?.efforts.some((e) => e.id === reasoning?.defaultEffort)).toBe(true)
  })

  it('support_thinking=false 时不声明 reasoning（远端明确说不支持思考）', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{
        id: 'x', name: 'X',
        reasoningConfig: { options: ['high'], supportThinking: false },
      }],
    })
    expect((await adapter.resolveModel('trae', 'x')).reasoning).toBeUndefined()
  })

  // ── Max 模式（1M 上下文）──

  it('显式关闭 Max 模式时用 dev 窗口（不采信 max 的 1M）', async () => {
    const { adapter } = makeAdapter({
      product: { ...TRAE, maxMode: false },
      remoteModels: [{
        id: 'glm-5.3', name: 'GLM-5.3',
        contextWindow: 200_000, maxMode: true, maxContextWindow: 1_000_000,
      }],
    })
    expect((await adapter.resolveModel('trae', 'glm-5.3')).context).toEqual({ contextWindow: 200_000 })
  })

  it('开启 Max 模式后对 max_mode 模型声明 1M 窗口', async () => {
    const { adapter } = makeAdapter({
      product: { ...TRAE, maxMode: true },
      remoteModels: [{
        id: 'glm-5.3', name: 'GLM-5.3',
        contextWindow: 200_000, maxMode: true, maxContextWindow: 1_000_000,
        maxOutputTokens: 32_000, maxModeOutputTokens: 64_000,
      }],
    })
    const resolved = await adapter.resolveModel('trae', 'glm-5.3')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
    // Max 模式下输出上限取 __max 明细那条
    expect(resolved.defaultMaxTokens).toBe(64_000)
  })

  it('开启 Max 模式也不给未标 max_mode 的模型套 1M（上游会拒）', async () => {
    const { adapter } = makeAdapter({
      product: { ...TRAE, maxMode: true },
      remoteModels: [{
        id: 'plain', name: 'Plain',
        contextWindow: 200_000, maxContextWindow: 1_000_000,
      }],
    })
    expect((await adapter.resolveModel('trae', 'plain')).context).toEqual({ contextWindow: 200_000 })
  })

  it('Max 模式白名单不含该模型时退回 dev 窗口', async () => {
    const { adapter } = makeAdapter({
      product: { ...TRAE, maxMode: true, maxModeModels: ['other-model'] },
      remoteModels: [{
        id: 'glm-5.3', name: 'GLM-5.3',
        contextWindow: 200_000, maxMode: true, maxContextWindow: 1_000_000,
      }],
    })
    expect((await adapter.resolveModel('trae', 'glm-5.3')).context).toEqual({ contextWindow: 200_000 })
  })

  it('模型名优先远端，其次兜底表，最后回退 id', async () => {
    const { adapter } = makeAdapter({
      remoteModels: [{ id: 'glm-5.2', name: '远端名' }],
    })
    expect((await adapter.resolveModel('trae', 'glm-5.2')).name).toBe('远端名')
    expect((await adapter.resolveModel('trae', 'unknown-x')).name).toBe('unknown-x')
  })
})

describe('TRAE 适配器 · stream 请求构造', () => {
  it('打到 SOLO chat 端点，且请求头用 Cloud-IDE-JWT', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, BASIC_OPTIONS)

    const [url, init] = fetcher.mock.calls[0] as [string, { headers: Headers; method: string }]
    expect(url).toBe(`${TRAE.agentHost}/api/agent/v3/llm_utils_chat`)
    expect(init.method).toBe('POST')
    expect(init.headers.get('Authorization')).toBe('Cloud-IDE-JWT AT')
    expect(init.headers.get('X-Cloudide-Token')).toBe('AT')
    expect(init.headers.get('X-Machine-Id')).toBe('a'.repeat(32))
    expect(init.headers.get('X-Device-Id')).toBe('c'.repeat(32))
  })

  it('请求体经过 OpenAI 到 SOLO 转换（stream 强制 true、注入 function/config_name）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, BASIC_OPTIONS)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body.stream).toBe(true)
    expect(body.function).toBe('solo_work_lite')
    expect(body.config_name).toBe('glm-5.2')
    expect(body.model).toBe('glm-5.2')
    // messages 的 content 必须转成数组形态。
    expect(body.messages[0].content).toEqual([{ type: 'text', text: '你好' }])
  })

  it('system 提示被插入为 messages 的第一条', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, { ...BASIC_OPTIONS, system: '你是助手' } as GenerateOptions)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body.messages[0]).toEqual({
      role: 'system', content: [{ type: 'text', text: '你是助手' }],
    })
  })

  it('tools 的 parameters 被序列化为字符串后发出', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, {
      ...BASIC_OPTIONS,
      tools: [{ name: 'read', description: 'd', parameters: { type: 'object' } }],
    } as unknown as GenerateOptions)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(typeof body.tools[0].function.parameters).toBe('string')
  })

  it('temperature / maxTokens / stop 透传', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, {
      ...BASIC_OPTIONS, temperature: 0.3, maxTokens: 100, stop: ['END'],
    } as GenerateOptions)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(100)
    expect(body.stop).toEqual(['END'])
  })

  // ── 推理强度下发 ──

  it('reasoningEffort 透传为上游的 reasoning_effort', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, { ...BASIC_OPTIONS, reasoningEffort: 'extra_high' } as GenerateOptions)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body.reasoning_effort).toBe('extra_high')
  })

  it('未指定 reasoningEffort 时不发该字段（不编造默认档）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, BASIC_OPTIONS)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body.reasoning_effort).toBeUndefined()
  })

  // ── Max 模式下发 ──

  it('显式关闭 Max 模式时不注入 strategy/mode_type（常规会话）', async () => {
    const { adapter, fetcher } = makeAdapter({
      product: { ...TRAE, maxMode: false },
      remoteModels: [{ id: 'glm-5.2', name: 'GLM-5.2', maxMode: true, maxContextWindow: 1_000_000 }],
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, BASIC_OPTIONS)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body.model_selection_strategy).toBeUndefined()
    expect(body.mode_type).toBeUndefined()
    expect(body.context_window_size).toBeUndefined()
  })

  it('⚠️ Max 模式**默认开启**（无需显式配置即注入三件套）', async () => {
    const { adapter, fetcher } = makeAdapter({
      remoteModels: [{
        id: 'glm-5.2', name: 'GLM-5.2',
        maxMode: true, maxContextWindow: 1_000_000, maxModeOutputTokens: 384_000,
      }],
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, BASIC_OPTIONS)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body.model_selection_strategy).toBe('max')
    expect(body.context_window_size).toBe(1_000_000)
  })

  it('开启 Max 模式时成套注入 strategy / mode_type / 1M 窗口三件套', async () => {
    const { adapter, fetcher } = makeAdapter({
      product: { ...TRAE, maxMode: true },
      remoteModels: [{
        id: 'glm-5.2', name: 'GLM-5.2',
        maxMode: true, maxContextWindow: 1_000_000, maxModeOutputTokens: 384_000,
      }],
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, BASIC_OPTIONS)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body.model_selection_strategy).toBe('max')
    expect(body.model_auto_selection).toEqual({
      strategy: 'max', fallback_to_advance_model: null, entitlement_id: null,
    })
    expect(body.mode_type).toBe(1)
    expect(body.context_window_size).toBe(1_000_000)
    expect(body.prompt_max_tokens).toBe(936_000)
    // Max 会话的输出上限由 __max 明细声明，**不被 64K clamp 覆盖**
    expect(body.max_tokens).toBe(384_000)
  })

  it('Max 模式对未标 max_mode 的模型不生效（上游会拒绝臆造的 max 限制）', async () => {
    const { adapter, fetcher } = makeAdapter({
      product: { ...TRAE, maxMode: true },
      remoteModels: [{ id: 'glm-5.2', name: 'GLM-5.2', maxContextWindow: 1_000_000 }],
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, BASIC_OPTIONS)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body.model_selection_strategy).toBeUndefined()
    expect(body.context_window_size).toBeUndefined()
  })

  it('不发 prompt_cache_key（那是腾讯后端的前缀缓存机制）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, BASIC_OPTIONS)
    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body).not.toHaveProperty('prompt_cache_key')
  })
})

describe('TRAE 适配器 · SOLO SSE 到 OpenAI chunk 转换', () => {
  it('output 的 response 产出 text-delta 与 block-end', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(
        ['output', { response: '你' }],
        ['output', { response: '好' }],
        ['done', { finish_reason: 'stop' }],
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)

    const textDeltas = chunks.filter((c) => c.type === 'text-delta')
    expect(textDeltas.map((c) => (c as { text: string }).text)).toEqual(['你', '好'])
    expect(chunks.some((c) => c.type === 'block-start' && c.blockType === 'text')).toBe(true)

    const blockEnd = chunks.find((c) => c.type === 'block-end')!
    expect(blockEnd).toMatchObject({ block: { type: 'text', text: '你好' } })
  })

  it('output 的 reasoning_content 产出 reasoning-delta 与 reasoning block', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(
        ['output', { response: '答案', reasoning_content: '思考' }],
        ['done', { finish_reason: 'stop' }],
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)

    expect(chunks.some((c) => c.type === 'reasoning-delta' && (c as { text: string }).text === '思考')).toBe(true)
    const blocks = chunks.filter((c) => c.type === 'block-end')
    expect(blocks.some((c) => (c as { block: { type: string } }).block.type === 'reasoning')).toBe(true)
  })

  it('finish_reason=stop 产出 finish(stop)', async () => {
    // ⚠️ 必须带**内容**：本用例验的是 `done` 事件的 `finish_reason` 映射，
    // 而零内容块的 `stop` 已按 DSH `EMPTY_RESPONSE` 契约改写为 error
    // （见 `resolveEmptyResponseReason` / `empty-response.spec.ts`）。
    // 带一个 output 事件后，块数 > 0，本用例才锁定的是**映射**而非退化形态。
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(
        ['output', { response: '答案' }],
        ['done', { finish_reason: 'stop' }],
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('token_usage 产出 usage chunk', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(
        ['output', { response: 'x' }],
        ['token_usage', { prompt_tokens: 21, completion_tokens: 142, reasoning_tokens: 135 }],
        ['done', { finish_reason: 'stop' }],
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const usage = chunks.find((c) => c.type === 'usage') as { usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number } } | undefined
    expect(usage?.usage.inputTokens).toBe(21)
    expect(usage?.usage.outputTokens).toBe(142)
    expect(usage?.usage.reasoningTokens).toBe(135)
  })

  /**
   * ★ 真实缺陷回归（用户报障「trae 的缓存命中率一直是 0」）：
   * 适配器的 `token_usage` 分支早期只读三个字段，把上游**确实下发**的
   * `cache_read_input_tokens` 整对丢弃 ⇒ 界面恒显 0%。
   *
   * 报文取自 2026-10-12 实机直发 dump（`deepseek-v4.1-flash`，同前缀两次）。
   */
  it('★ token_usage 上报缓存命中，且未命中量已扣除命中部分', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(
        ['output', { response: 'OK' }],
        ['token_usage', {
          prompt_tokens: 5144, completion_tokens: 32, total_tokens: 5176,
          cache_creation_input_tokens: 0, cache_read_input_tokens: 5120,
          reasoning_tokens: 30, cluster: 'normal_context',
        }],
        ['done', { finish_reason: 'stop' }],
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const usage = chunks.find((c) => c.type === 'usage') as {
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; reasoningTokens?: number }
    } | undefined
    expect(usage?.usage.cacheReadTokens).toBe(5120)
    // 5144 是**含缓存**的总输入，未命中量必须是减完的 24。
    expect(usage?.usage.inputTokens).toBe(24)
    expect(usage?.usage.outputTokens).toBe(32)
    expect(usage?.usage.reasoningTokens).toBe(30)
  })

  it('上游明确报 0 时透出 cacheReadTokens', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(
        ['output', { response: 'x' }],
        ['token_usage', { prompt_tokens: 4894, completion_tokens: 118, cache_read_input_tokens: 0 }],
        ['done', { finish_reason: 'stop' }],
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    const usage = chunks.find((c) => c.type === 'usage') as { usage: Record<string, unknown> } | undefined
    expect(usage?.usage).toHaveProperty('cacheReadTokens', 0)
    expect(usage?.usage.inputTokens).toBe(4894)
  })

  it('tool_calls 产出 tool-call-delta 与 block-end(tool-call)', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(
        ['output', { tool_calls: [{ index: 0, id: 'c1', function_call: { name: 'read', arguments: '{"a":1}' } }] }],
        ['done', { finish_reason: 'tool_calls' }],
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)

    const delta = chunks.find((c) => c.type === 'tool-call-delta') as { name?: string; argumentsDelta: string } | undefined
    expect(delta?.name).toBe('read')
    expect(delta?.argumentsDelta).toBe('{"a":1}')

    const blockEnd = chunks.find((c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call')
    expect(blockEnd).toMatchObject({ block: { type: 'tool-call', name: 'read', arguments: '{"a":1}' } })
  })

  it('finish_reason=tool_calls 且无 done 时按有工具调用判定', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(
        ['output', { tool_calls: [{ index: 0, id: 'c1', function_call: { name: 'read', arguments: '{}' } }] }],
        ['done', { finish_reason: 'tool_calls' }],
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('finish_reason=length 产出 finish(max-tokens)', async () => {
    // 必须报 max-tokens 而非 tool-calls，否则 harness 会执行残缺调用。
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'length' }]))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('残缺的 tool 参数判为 max-tokens（触发重试而非执行坏调用）', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(
        // 半截 JSON：分片丢失的真实表现。
        ['output', { tool_calls: [{ index: 0, id: 'c1', function_call: { name: 'read', arguments: '{"file_pa' } }] }],
        ['done', { finish_reason: 'tool_calls' }],
      ))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('上游 event:error 抛 QUOTA_EXCEEDED（4008）', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(['error', { code: 4008, message: '配额超限' }]))],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
  })

  it('上游 event:error 的 1005 也归为 QUOTA_EXCEEDED', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(['error', { code: 1005, message: 'plan 权益不足' }]))],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
  })

  /**
   * `4001` 的上游原文是 *"We're sorry, the param is invalid. Please try with a
   * valid param."*，实测它**只**由「不可调用的模型」触发（5 个
   * `is_custom_model` 条目全中，其余模型全好），与提示词/参数格式无关。
   * 原文会把排查方向带偏，故必须补一句指向真实成因的提示，同时**保留**
   * 上游原文与错误码（便于与上游日志对照）。
   */
  it('上游 4001 的文案点明「模型不被接受」而非让人去查参数格式', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(['error', {
        code: 4001,
        message: "We're sorry, the param is invalid. Please try with a valid param.",
      }]))],
    })
    const error = await collect(adapter, { ...BASIC_OPTIONS, model: 'deepseek-v4-flash' } as GenerateOptions)
      .catch((e: unknown) => e as Error)
    // 原文与错误码保留（可与上游日志对照）
    expect(error.message).toContain("We're sorry, the param is invalid")
    expect(error.message).toContain('code=4001')
    // 且带出模型名与真正的原因
    expect(error.message).toContain('deepseek-v4-flash')
    expect(error.message).toContain('不被上游接受')
    expect(error.message).toContain('自定义模型')
    // 不再让人误以为是消息/参数格式问题：文案不等于上游原文的裸拼接
    expect(error.message).not.toBe(
      "trae: We're sorry, the param is invalid. Please try with a valid param. (code=4001)",
    )
  })

  it('非 4001 的流内错误保持上游原文，不附加无依据的解释', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(['error', { code: 5000, message: 'boom' }]))],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e as Error)
    expect(error.message).toBe('trae: boom (code=5000)')
  })

  /**
   * 流内 `code=4006`（体积超限）**不得**归成 `SERVER`（Gitee issue IKKX0T）。
   *
   * ## 为什么这条的代价是不对称的
   *
   * `SERVER` **在** harness 的 `DEFAULT_RETRYABLE_CODES`
   * （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`，已在 `dsh-llm`
   * 实测确认）里 ⇒ 同一个巨型请求体会被**原样重发 5 次**（退避
   * 500/1000/2000/4000/8000ms，约 15.5 秒），而体积超限是**确定性**失败，
   * 每次都必然同样失败。
   *
   * ⚠️ **这里刻意断言「不在可重试集合里」而不是只断言等于某个字面量**：
   * 字面量断言只能锁住「当前写的是什么」，锁不住「它为什么不能是 SERVER」。
   * 后者才是这条缺陷的本质 —— 后人若把它改成 `INVALID_REQUEST` 之类，
   * 前半条仍会过，但本用例会指出它与 harness 集合的关系。
   */
  it('★ 流内 4006（体积超限）不归可重试码，且能触发溢出压缩（Issue IKKX0T）', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(['error', {
        code: 4006,
        message: "We're sorry, the content is too large for AI to understand.",
      }]))],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e as Error)
    const code = (error as { code?: string }).code

    // ① 必须是溢出码：这是 `dsh-compaction-basic` 唯一认的那个
    //    （其 request-error listener 第一行 `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()`）。
    expect(code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // ② 绝不能落在 harness 会白重试的集合里。
    expect(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']).not.toContain(code)
    // ③ 原文与错误码保留（可与上游日志对照），并补一句可操作提示。
    expect(error.message).toContain('code=4006')
    expect(error.message).toContain('too large')
    expect(error.message).toContain('图片')
  })

  it('4006 与 4001 的归类不可合并（一个是载荷、一个是模型）', async () => {
    // 4001 = 模型不可调用（换号/压缩都无益）；4006 = 这一次的载荷太大
    //（压缩/少发图能救）。两者若合并，必有一方的处置方向被牺牲。
    const tooLarge = await collect(
      makeAdapter({
        responses: [sseResponse(soloSse(['error', { code: 4006, message: 'too large' }]))],
      }).adapter,
      BASIC_OPTIONS,
    ).catch((e: unknown) => e as Error)
    const notCallable = await collect(
      makeAdapter({
        responses: [sseResponse(soloSse(['error', { code: 4001, message: 'param is invalid' }]))],
      }).adapter,
      BASIC_OPTIONS,
    ).catch((e: unknown) => e as Error)
    expect((tooLarge as { code?: string }).code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect((notCallable as { code?: string }).code).not.toBe('CONTEXT_WINDOW_EXCEEDED')
    expect((tooLarge as { code?: string }).code).not.toBe((notCallable as { code?: string }).code)
  })

  it('未知流内码仍归 SERVER（本修复只挑确定性失败，不放宽其余）', async () => {
    // ⚠️ 反向守卫：把 4006 挑出来**不能**顺手把整张表改窄 ——
    // 未知码多属上游真 5xx/瞬时故障，那类**必须**保留重试机会。
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(['error', { code: 5000, message: 'upstream exploded' }]))],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e as Error)
    expect((error as { code?: string }).code).toBe('SERVER')
  })

  it('无 done 事件且无内容时仍产出 finish（零块 ⇒ EMPTY_RESPONSE，可重试）', async () => {
    // `metadata` 是可解析事件 ⇒ 不算「上游一个事件都没发」（那条走 TRANSPORT
    // 抛错），且流**正常读到结尾**。但它一个内容块都没产出，故不能报 `stop`
    // ——那是 DSH `EMPTY_RESPONSE` 契约明令禁止的「零输出却宣告正常结束」，
    // 会让本轮静默结束。分类为可重试的 error 后，harness 会重跑该步。
    //
    // 本用例锁定的仍是**不挂起、必然给出终态 finish**（原意），只是终态从
    // 泛化的 `stop` 收紧成了更准确的 `error`/`EMPTY_RESPONSE`。
    const { adapter } = makeAdapter({
      responses: [sseResponse(soloSse(['metadata', { session_id: 's' }]))],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(chunks.filter((c) => c.type === 'block-end')).toEqual([])
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'model returned a completed response with no content',
          code: 'EMPTY_RESPONSE',
        },
      },
    })
  })

  it('容忍 data: 后无空格（SOLO 上游实测形态）', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse('event:output\ndata:{"response":"tight"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n')],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(chunks.some((c) => c.type === 'text-delta' && (c as { text: string }).text === 'tight')).toBe(true)
  })

  it('comment 行（":"）被忽略', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse(':keepalive\nevent:output\ndata:{"response":"x"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n')],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('非 JSON 的 data 行被跳过而不中断流', async () => {
    const { adapter } = makeAdapter({
      responses: [sseResponse('event:output\ndata:not-json\n\nevent:output\ndata:{"response":"x"}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n')],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('空响应体抛 EMPTY_RESPONSE', async () => {
    const { adapter } = makeAdapter({
      responses: [new Response(null, { status: 200 })],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('EMPTY_RESPONSE')
  })
})

describe('TRAE 适配器 · 凭据', () => {
  it('无凭据时抛 MISSING_CREDENTIAL 并提示先登录', async () => {
    const { adapter } = makeAdapter({ credential: null })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('MISSING_CREDENTIAL')
  })

  it('凭据过期时先 refresh 再重试解析', async () => {
    const { adapter, refresh } = makeAdapter({
      credential: makeCredential({ expires_at: String(Date.now() - 1000) }),
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, BASIC_OPTIONS)
    expect(refresh).toHaveBeenCalled()
  })

  it('401 时 refresh 一次后重试请求', async () => {
    const { adapter, fetcher, refresh } = makeAdapter({
      responses: [
        new Response('{"code":1001}', { status: 401 }),
        sseResponse(soloSse(['output', { response: 'ok' }], ['done', { finish_reason: 'stop' }])),
      ],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(refresh).toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

/**
 * 图片能力**按模型**判定（Issue #IKHDKC）。
 *
 * 实测（2026-09-21，真实凭据）：
 * - 远端 `display_config.multimodal` 一直在目录里声明该能力（52 个可调用条目中
 *   27 个为 true，本插件可见集 19 个中 15 个为 true）；
 * - 直发图片后模型真的读到了像素（纯红图答「红色」、纯蓝图答「蓝色」、
 *   无图答「无法确定」）；
 * - 反向对照：`multimodal: false` 的模型收到图后答「无法确定」，思考链明说
 *   「但没有图片」—— 与不带图的回答一致，证明该标志是**权威准入判据**。
 *
 * 下方用例把「拒绝」的语义锚定在**模型是否声明 multimodal**，而不是 provider。
 */
describe('TRAE 适配器 · 图片按模型判定', () => {
  it('multimodal 未声明（兜底/未知模型）时收到图片抛 UNSUPPORTED_CONTENT', async () => {
    // 只声明 inputModalities=['text'] 就必须真的拒绝；静默丢图会让用户
    // 以为模型看到了图片。错误文案与 Buddy / LobsterAI 适配器保持一致。
    const { adapter, fetcher } = makeAdapter()
    const options = {
      model: 'glm-5.2',
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }],
      }],
    } as unknown as GenerateOptions
    const error = await collect(adapter, options).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
    expect(String((error as Error).message)).toContain('does not accept image input')
    // 关键：不得发出任何请求（否则上游只会回一个费解的 400）。
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('工具结果内嵌的图片在未声明 multimodal 时同样被拒绝', async () => {
    const { adapter, fetcher } = makeAdapter()
    const options = {
      model: 'glm-5.2',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'c1',
          content: [{ type: 'image', attachment: { attachmentId: 'att-2' } }],
        }],
      }],
    } as unknown as GenerateOptions
    const error = await collect(adapter, options).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('⚠️ multimodal=true 的模型：图片被转成 image_url data URL 并发往上游', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
      remoteModels: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', multimodal: true }],
      readImage: async () => ({ data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' }),
    })
    await collect(adapter, {
      model: 'deepseek-v4.1-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', attachment: { attachmentId: 'att-1' } },
          { type: 'text', text: '什么颜色' },
        ],
      }],
    } as unknown as GenerateOptions)

    expect(fetcher, '必须真的发出请求').toHaveBeenCalled()
    const body = JSON.parse(String(fetcher.mock.calls[0]![1].body))
    const parts = body.messages[0].content
    // 图片必须是 image_url + data URL（实测上游唯一接受的形态）。
    const image = parts.find((p: { type: string }) => p.type === 'image_url')
    expect(image.image_url.url).toBe('data:image/png;base64,iVBORw==')
    // 文本块必须保留。
    expect(parts.some((p: { type: string }) => p.type === 'text' && p.text === '什么颜色')).toBe(true)
  })

  it('⚠️ 读取图片字节失败时留 [image unavailable] 占位符（不静默丢图）', async () => {
    // 空 Map 不能降级为 undefined —— 那会让占位符也被跳过。
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
      remoteModels: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', multimodal: true }],
      // readImage 回 undefined（附件已被清理等）。
      readImage: async () => undefined,
    })
    await collect(adapter, {
      model: 'deepseek-v4.1-flash',
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }],
      }],
    } as unknown as GenerateOptions)

    const body = JSON.parse(String(fetcher.mock.calls[0]![1].body))
    const json = JSON.stringify(body)
    expect(json, '不得静默丢弃').toContain('image unavailable')
  })

  it('声明 multimodal=true 但未提供 readImage 时明确报错（不静默丢图）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', {}]))],
      remoteModels: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', multimodal: true }],
      // 故意不传 readImage
    })
    const error = await collect(adapter, {
      model: 'deepseek-v4.1-flash',
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }],
      }],
    } as unknown as GenerateOptions).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
    expect(String((error as Error).message)).toContain('attachment service')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('TRAE 适配器 · 限流换号', () => {
  it('429 时记录限流标记并尝试下一个账号', async () => {
    const rateLimit = '{"code":429,"msg":"too many requests"}'
    const pool = {
      findAccountIdByCredential: async () => 'trae-1',
      updateModelRateLimit: vi.fn(async () => {}),
      getAvailableAccount: vi.fn(async () => ({
        entry: { id: 'trae-2', credentialRef: 'TRAE_ACCOUNT_2' },
        credential: makeCredential({ access_token: 'AT2' }),
      })),
    }
    const { adapter, fetcher } = makeAdapter({
      accountPool: pool,
      responses: [
        new Response(rateLimit, { status: 429 }),
        sseResponse(soloSse(['output', { response: '从第二个账号返回' }], ['done', { finish_reason: 'stop' }])),
      ],
    })

    const chunks = await collect(adapter, BASIC_OPTIONS)

    expect(pool.updateModelRateLimit).toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('全部账号受限时报 QUOTA_EXCEEDED', async () => {
    const pool = {
      findAccountIdByCredential: async () => 'trae-1',
      updateModelRateLimit: vi.fn(async () => {}),
      // 没有其它可用账号。
      getAvailableAccount: vi.fn(async () => null),
    }
    const { adapter } = makeAdapter({
      accountPool: pool,
      responses: [new Response('{"code":4008}', { status: 400 })],
    })

    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    // 4008 判为 quota-exceeded，归为 QUOTA_EXCEEDED。
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
  })

  it('无账号池时 4008 也报 QUOTA_EXCEEDED（带可读文案）', async () => {
    const { adapter } = makeAdapter({
      responses: [new Response('{"code":4008,"msg":"quota exceeded"}', { status: 400 })],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
    expect(String((error as Error).message)).toContain('积分不足')
  })

  it('401 且无账号池时归为 AUTH', async () => {
    const { adapter } = makeAdapter({
      responses: [
        new Response('{"code":1001}', { status: 401 }),
        new Response('{"code":1001}', { status: 401 }),
      ],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('AUTH')
  })
})

/**
 * 流内错误的换号（真实缺陷回归）。
 *
 * ## 为什么需要这一组（用户报障「没有切换」）
 *
 * 换号逻辑**整体位于 `if (!response.ok)` 分支内**，只在 HTTP 非 2xx 时执行。
 * 而上游确实会用 **HTTP 200 + SSE `event:error`** 下发错误（实测依据：
 * `tests/unit/trae-adapter.spec.ts` 里 4001「param is invalid」的记录，
 * 见「剔除 is_custom_model 的模型」用例的注释）—— 此时换号代码**一行都不执行**，
 * 直接抛 `QUOTA_EXCEEDED`，而它**不在 DSH 的可重试集合**里，用户看到的就是
 * 「不会切换」。
 *
 * 实测（2026-09-28，真实 TraeAdapter + 桩池）：
 * | 错误通道 | 发送次数 | 换号次数 |
 * |---|---|---|
 * | 流内 `event:error code=4008` | 1 | **0** |
 * | HTTP 429 | 2 | 1 |
 */
describe('TRAE 适配器 · 流内错误换号（真实缺陷回归）', () => {
  it('流内 event:error 4008 且未产出内容时换号重发', async () => {
    const pool = {
      findAccountIdByCredential: async () => 'trae-1',
      updateModelRateLimit: vi.fn(async () => {}),
      getAvailableAccount: vi.fn(async () => ({
        entry: { id: 'trae-2', credentialRef: 'TRAE_ACCOUNT_2' },
        credential: makeCredential({ access_token: 'AT2' }),
      })),
    }
    const { adapter, fetcher } = makeAdapter({
      accountPool: pool,
      responses: [
        // 第一次：HTTP 200 + 流内额度错误（不是 HTTP 4xx）
        sseResponse(soloSse(['error', { code: 4008, message: 'ide_credits 耗尽' }])),
        // 第二次：第二个账号正常返回
        sseResponse(soloSse(
          ['output', { response: '从第二个账号返回' }],
          ['done', { finish_reason: 'stop' }],
        )),
      ],
    })

    const chunks = await collect(adapter, BASIC_OPTIONS)

    // 枢轴断言：必须真的重发到第二个账号
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(pool.getAvailableAccount).toHaveBeenCalled()
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    // ★ 冷却按类别（2026-10-05 修）：流内 4008 = quota-exceeded ⇒ **24h**，
    //   不是旧的 1h 兜底。坏号 1 小时后被选回又 4008，正是「轮换好像不行」的
    //   流内变体——此断言就是该缺陷的回归锁（反向验证：把实现改回 FALLBACK
    //   常量时此断言变红）。
    const markCall = vi.mocked(pool.updateModelRateLimit).mock.calls[0]
    expect(markCall[0]).toBe('trae-1')
    const cooldown = markCall[2] - Date.now()
    expect(cooldown).toBeGreaterThan(23 * 3_600_000)
    expect(cooldown).toBeLessThanOrEqual(24 * 3_600_000)
  })

  it('流内 event:error 1005 同样换号（plan 权益不足）', async () => {
    const pool = {
      findAccountIdByCredential: async () => 'trae-1',
      updateModelRateLimit: vi.fn(async () => {}),
      getAvailableAccount: vi.fn(async () => ({
        entry: { id: 'trae-2', credentialRef: 'TRAE_ACCOUNT_2' },
        credential: makeCredential({ access_token: 'AT2' }),
      })),
    }
    const { adapter, fetcher } = makeAdapter({
      accountPool: pool,
      responses: [
        sseResponse(soloSse(['error', { code: 1005, message: 'plan 权益不足' }])),
        sseResponse(soloSse(
          ['output', { response: 'ok' }],
          ['done', { finish_reason: 'stop' }],
        )),
      ],
    })

    await collect(adapter, BASIC_OPTIONS)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  /**
   * ★★ 2026-10-24 真实报障的**逐字复刻**。
   *
   * 现场：上游用 HTTP 200 + SSE `event:error` 下发 `code=1005` 而 **`message`
   * 为空**（用户看到的是 `trae:  (code=1005)`，冒号后**两个空格**）。
   *
   * ⚠️ 上面那条 1005 用例的 `message` 里**恰好含 `plan` 字样**，于是文案表的
   * 第二腿被满足、判成 `hard-plan(12h)` —— **0ms 冷却那条路径从未被走到**，
   * 这正是该缺陷能长期潜伏的原因。本用例把 `message` 置空。
   */
  it('★★ 流内 event:error 1005 且 message 为空 ⇒ 冷却 12h（旧实现是 0ms）', async () => {
    const pool = {
      findAccountIdByCredential: async () => 'trae-1',
      updateModelRateLimit: vi.fn(async () => {}),
      getAvailableAccount: vi.fn(async () => ({
        entry: { id: 'trae-2', credentialRef: 'TRAE_ACCOUNT_2' },
        credential: makeCredential({ access_token: 'AT2' }),
      })),
    }
    const { adapter, fetcher } = makeAdapter({
      accountPool: pool,
      responses: [
        // 逐字复刻报障现场：message 为空字符串（不是省略字段）
        sseResponse(soloSse(['error', { code: 1005, message: '' }])),
        sseResponse(soloSse(
          ['output', { response: '从第二个账号返回' }],
          ['done', { finish_reason: 'stop' }],
        )),
      ],
    })

    const chunks = await collect(adapter, BASIC_OPTIONS)

    // 枢轴断言：仍要真的换号重发（换号本身没坏，坏的是退避时长）
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    const markCall = vi.mocked(pool.updateModelRateLimit).mock.calls[0]
    expect(markCall[0]).toBe('trae-1')
    const cooldown = markCall[2] - Date.now()
    // ⚠️ 0ms 会让坏号在下一次选号时**立刻又被选回**（换号形同虚设，用户看到
    //    的正是「轮换好像不行」）。反向验证：把实现改回 classifyTraeError
    //    喂 JSON 时，这里的差值退化成 ~0 ⇒ 本断言变红。
    expect(cooldown).toBeGreaterThan(11 * 3_600_000)
    expect(cooldown).toBeLessThanOrEqual(12 * 3_600_000)
  })

  /**
   * ★ 用户**实际看到的那行字**（截图与宿主日志都是这一行）。
   *
   * 全部账号被同一模型拒时，外层如实抛流内错误、带硬编码的 `QUOTA_EXCEEDED`
   * —— 用户据此以为「额度用完了」，而真实成因是**该模型不被这个账号的套餐
   * 接受**（1005 = Plan 权益不足）。文案与码都锁住，避免以后悄悄改成别的说法。
   */
  /**
   * ★ 用户**实际看到的那行字**（截图与宿主日志都是它）。
   *
   * ## 为什么码保留 `QUOTA_EXCEEDED`（2026-10-25 审计 B2 的 REFUTED）
   *
   * 1005 的真实含义是「该模型不被这个账号的套餐接受」，不是「额度耗尽」，
   * 所以码本身**语义不准**。但审计实测证明**不能改码**：
   * `account-probe.ts` 的 `isRateLimitFailure` 认 `QUOTA_EXCEEDED`/`QUOTA`，
   * **不认** `PERMISSION_DENIED` ⇒ 改码会让面板「重测」从**「仍受限」退化为
   * 「无法确认」**，用户会误以为凭据坏了去删号。两个码都不触发重试/压缩、
   * 都不被客户端替换文案 ⇒ 改码**换不来任何用户可见改善**。
   *
   * ⇒ 修的是**文案**：裸 `trae:  (code=1005)` 对用户毫无指引力（他唯一能做
   * 的动作是「换一个模型」，而原文一个字都没提）。码保持不动。
   */
  it('★ 全部账号被同一模型拒时：码保留 QUOTA_EXCEEDED，但文案必须给出「换模型」这条出路', async () => {
    const pool = {
      findAccountIdByCredential: async () => 'trae-1',
      updateModelRateLimit: vi.fn(async () => {}),
      // 池里没有其它可用账号
      getAvailableAccount: vi.fn(async () => null),
    }
    const { adapter, fetcher } = makeAdapter({
      accountPool: pool,
      responses: [sseResponse(soloSse(['error', { code: 1005, message: '' }]))],
    })

    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    const text = (error as Error).message
    // 保留了上游原文与码（排查时要能对上游报文）
    expect(text).toContain('(code=1005)')
    // ⚠️ 枢轴：必须给出**可操作**的出路。1005 = 套餐不接受该模型 ⇒
    // 用户能做的是换模型（不是签到、不是换号 —— 换号也是同一个模型被拒）。
    expect(text).toContain('换一个模型')
    // ⚠️ 不得把用户引向错误动作：签到/买额度对本错误无效
    expect(text).not.toContain('签到')
    expect(text).not.toContain('充值')
    // 码不动（见上面注释里的 REFUTED 理由）
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  /**
   * ★★★ P0（2026-10-25 审计 B2）：已发出工具调用后**绝不允许整轮重发**。
   *
   * ## 为什么这是 P0 而不是「换号失效」
   *
   * 审计实测的后果链（三环都已独立复核）：
   * 1. 重试循环在 `stream()` **内部** ⇒ harness 只看到**一条连续流**，
   *    两次 attempt 的 chunk 会拼进**同一条 assistant 消息**；
   * 2. `BlockAssembler.assembled()` **只在 `max-tokens` 时**丢弃 tool-call，
   *    **不过滤**没有 `block-end` 的 partial
   *    （`dsh-llm/lib/index.js` 的 `assembled()`）；
   * 3. `dsh-agent-loop` 直接 `content.filter(b => b.type === 'tool-call')`
   *    后 `executeToolCalls`，**零去重**。
   *
   * ⇒ attempt 1 已发出的 `tool-call-delta` 会变成**幽灵调用**：模型可能在
   * 第二次 answer 里说「直接回答、不用跑命令」，而 harness 仍会执行第一轮
   * 那个工具。分片中断时参数还可能是**截断的非法 JSON**。
   *
   * ⚠️ 修复前本用例**必须变红**（`fetcher` 会被调用 2 次）。这条路径此前
   * **零守卫** —— 把缺陷真修掉，146 条既有 trae 用例仍然全绿。
   */
  it('★★★ P0：已发出 tool-call 后收到 1005 ⇒ 绝不重发（防幽灵工具调用）', async () => {
    const pool = {
      findAccountIdByCredential: async () => 'trae-1',
      updateModelRateLimit: vi.fn(async () => {}),
      getAvailableAccount: vi.fn(async () => ({
        entry: { id: 'trae-2', credentialRef: 'TRAE_ACCOUNT_2' },
        credential: makeCredential({ access_token: 'AT2' }),
      })),
    }
    const { adapter, fetcher } = makeAdapter({
      accountPool: pool,
      responses: [
        // 第一个账号：先吐一个**名字可用**的工具调用（block-start + delta 已发），
        // 然后同一轮里上游报 1005。
        sseResponse(soloSse(
          ['output', { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'bash', arguments: '{"command":"rm -rf /tmp/victim"}' } }] }],
          ['error', { code: 1005, message: '' }],
        )),
        // 若实现仍重发，就会吃掉这个响应 ⇒ 幽灵调用成立
        sseResponse(soloSse(
          ['output', { response: '我直接回答，不用跑命令。' }],
          ['done', { finish_reason: 'stop' }],
        )),
      ],
    })

    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)

    // 枢轴断言 1：**绝不重发**。修复前这里是 2。
    expect(fetcher).toHaveBeenCalledTimes(1)
    // 枢轴断言 2：如实抛错（而不是静默把两轮拼起来）
    expect(error).toBeInstanceOf(Error)
    // 枢轴断言 3：不得写冷却标记（本轮没有换号，标记无意义）
    expect(vi.mocked(pool.updateModelRateLimit)).not.toHaveBeenCalled()
  })

  /**
   * ★★★ 同上，但用 `reasoning_content`（思考分片）触发。
   *
   * 与工具调用分开测：两者走**不同**的 delta 字段，若实现只修了
   * `tool_calls` 一处，这条会独立变红。
   */
  it('★★★ P0：已发出 reasoning 后收到 1005 ⇒ 同样绝不重发', async () => {
    const pool = {
      findAccountIdByCredential: async () => 'trae-1',
      updateModelRateLimit: vi.fn(async () => {}),
      getAvailableAccount: vi.fn(async () => ({
        entry: { id: 'trae-2', credentialRef: 'TRAE_ACCOUNT_2' },
        credential: makeCredential({ access_token: 'AT2' }),
      })),
    }
    const { adapter, fetcher } = makeAdapter({
      accountPool: pool,
      responses: [
        sseResponse(soloSse(
          ['output', { reasoning_content: '先想一下这个问题的要点……' }],
          ['error', { code: 1005, message: '' }],
        )),
        sseResponse(soloSse(
          ['output', { response: '不该出现的第二轮' }],
          ['done', { finish_reason: 'stop' }],
        )),
      ],
    })

    await collect(adapter, BASIC_OPTIONS).catch(() => undefined)

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.mocked(pool.updateModelRateLimit)).not.toHaveBeenCalled()
  })

  /**
   * ★★ P1（2026-10-25 审计 B2-5）：**撞到的最后一个账号也必须写冷却**。
   *
   * ## 缺陷
   *
   * 旧实现的 `rotateBudget <= 0 → throw` 排在 `updateModelRateLimit(...)`
   * **之前** ⇒ 预算刚好用尽的那一次，当前账号**一个标记都不写**就抛出了。
   * 用 3 个账号的池实测：第一轮只标了 2 个，要第二轮请求才补齐第 3 个 ⇒
   * 那个账号下一次选号时没有任何标记可过滤，**立刻又被选回**。
   *
   * ## 判据
   *
   * 3 个账号全部被同一模型拒（每个都回 1005）⇒ 池里 3 个账号
   * **全部**必须被 `updateModelRateLimit` 标记，一个不漏。
   */
  it('★★ P1：全池账号逐个撞限流 ⇒ 每一个都必须写冷却（含最后被抛出的那个）', async () => {
    const marked: string[] = []
    // ⚠️ 队列必须建在**回调外**：写在回调里会让每次调用都拿到同一个「第二个账号」，
    //    于是第三发仍然打 trae-2，测不出「最后那个账号漏标」。
    const remaining = [
      { entry: { id: 'trae-2', credentialRef: 'TRAE_ACCOUNT_2' }, credential: makeCredential({ access_token: 'AT2' }) },
      { entry: { id: 'trae-3', credentialRef: 'TRAE_ACCOUNT_3' }, credential: makeCredential({ access_token: 'AT3' }) },
    ]
    const pool = {
      findAccountIdByCredential: async () => 'trae-1',
      updateModelRateLimit: vi.fn(async (id: string) => { marked.push(id) }),
      getAvailableAccount: async () => remaining.shift() ?? null,
    }
    const rejected = soloSse(['error', { code: 1005, message: '' }])
    const { adapter, fetcher } = makeAdapter({
      accountPool: pool,
      responses: [sseResponse(rejected), sseResponse(rejected), sseResponse(rejected)],
    })

    await collect(adapter, BASIC_OPTIONS).catch(() => undefined)

    // 三个账号都被真实打到过（1 + 2 次换号）
    expect(fetcher).toHaveBeenCalledTimes(3)
    // 枢轴断言：3 个账号**全部**被标记。修复前只有 2 个（`trae-3` 漏标）。
    expect(marked).toEqual(['trae-1', 'trae-2', 'trae-3'])
  })

  /**
   * ⚠️ **安全边界**：已经产出正文后**绝不重发**。
   *
   * 重放会让上游**重复计费**，并且若已发出工具调用还会**重复执行工具**。
   * 与既有「空响应只在首个模型事件之前重试」同一条约束。
   */
  it('已产出正文后流内报错不重发（防重复计费）', async () => {
    const pool = {
      findAccountIdByCredential: async () => 'trae-1',
      updateModelRateLimit: vi.fn(async () => {}),
      getAvailableAccount: vi.fn(async () => ({
        entry: { id: 'trae-2', credentialRef: 'TRAE_ACCOUNT_2' },
        credential: makeCredential({ access_token: 'AT2' }),
      })),
    }
    const { adapter, fetcher } = makeAdapter({
      accountPool: pool,
      responses: [
        // 先吐正文，再报错 —— 此时重发会重复计费
        sseResponse(soloSse(
          ['output', { response: '已经发出的一半内容' }],
          ['error', { code: 4008, message: 'ide_credits 耗尽' }],
        )),
        sseResponse(soloSse(['output', { response: '不该出现' }], ['done', { finish_reason: 'stop' }])),
      ],
    })

    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    // 只发了一次：绝不重放已有输出的请求
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(pool.getAvailableAccount).not.toHaveBeenCalled()
  })

  it('全部账号流内失败时如实抛错，不无限循环', async () => {
    // 池里没有其它账号了
    const pool = {
      findAccountIdByCredential: async () => 'trae-1',
      updateModelRateLimit: vi.fn(async () => {}),
      getAvailableAccount: vi.fn(async () => null),
    }
    const { adapter, fetcher } = makeAdapter({
      accountPool: pool,
      responses: [
        sseResponse(soloSse(['error', { code: 4008, message: '耗尽' }])),
        sseResponse(soloSse(['error', { code: 4008, message: '耗尽' }])),
        sseResponse(soloSse(['error', { code: 4008, message: '耗尽' }])),
      ],
    })

    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    // 有上限，不会无限重试（TRAE_MAX_ROTATE = 3）
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3)
  })
})

describe('TRAE 适配器 · prepareCall', () => {
  it('返回模型信息与绑定的 stream 函数', async () => {
    const { adapter } = makeAdapter()
    const prepared = await adapter.prepareCall('trae', 'glm-5.2')
    expect(prepared.model.id).toBe('glm-5.2')
    expect(typeof prepared.stream).toBe('function')
  })
})

/**
 * DSH 原生消息块 → OpenAI wire 格式的序列化。
 *
 * ⚠️ 这是一个**真实缺陷**的回归：适配器早期把 DSH 原生 content 块
 * （`tool-call` / `tool-result` / `reasoning`）原样透传给 `transformToSOLOBody`，
 * 而该函数只认识 `type:'text'`。后果是模型**看不到工具调用与工具结果**，
 * 会反复请求同一个工具或凭空编造结果 —— 且没有任何报错。
 */
describe('TRAE 适配器 · 消息序列化（真实缺陷回归）', () => {
  /** 从 fetch 桩取出实际发出的 SOLO body。 */
  function sentBody(fetcher: ReturnType<typeof vi.fn>, call = 0): Record<string, any> {
    return JSON.parse((fetcher.mock.calls[call] as [string, { body: string }])[1].body)
  }

  it('assistant 的 tool-call 块转为 tool_calls（且 function→function_call）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, {
      model: 'glm-5.2',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '读 README' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '需要读文件' },
            { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"README.md"}' },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容' }] }],
        },
      ],
    } as unknown as GenerateOptions)

    const body = sentBody(fetcher)
    const assistant = body.messages.find((m: any) => m.role === 'assistant')
    // DSH 的 tool-call 块必须变成 OpenAI tool_calls，且已被 SOLO 转换。
    expect(assistant.tool_calls).toHaveLength(1)
    expect(assistant.tool_calls[0].function_call.name).toBe('read')
    expect(assistant.tool_calls[0].function_call.arguments).toBe('{"path":"README.md"}')
    // 旧的错误形态（原生块直接把 type 透传）绝不能出现。
    expect(JSON.stringify(assistant)).not.toContain('"type":"tool-call"')
    // reasoning 块不应作为正文混进 content。
    expect(JSON.stringify(assistant.content)).not.toContain('需要读文件')
  })

  it('tool-result 块展开为独立的 role:tool 消息（模型能看到结果）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, {
      model: 'glm-5.2',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' }],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '内容' }] }],
        },
      ],
    } as unknown as GenerateOptions)

    const body = sentBody(fetcher)
    const toolMsg = body.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg.tool_call_id).toBe('call_1')
    expect(JSON.stringify(toolMsg.content)).toContain('内容')
  })

  /**
   * ⚠️ **真实缺陷**（2026-10-04，用户报障）：`read_image` 之后，整个会话在 trae 下
   * **永久无法对话** —— 上游恒定回
   * `code=4027 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`，
   * 5 次重试与「继续」全都无效（坏报文被持久化，每次请求原样重放）。
   *
   * 根因：工具结果内嵌图片被 `userContentParts` **递归**收进一条多模态 user 消息，
   * 而这条 user 消息被排在 `role:'tool'` **之前** —— assistant(tool_calls) 与它的
   * tool 结果之间插了一条 user 消息，违反上游配对约束。
   * 图片必须照 `pendingToolImages` 的设计挂到 tool 消息**之后**。
   */
  it('⚠️ 工具结果内嵌图片不得插在 role:tool 之前（4027 真实缺陷回归）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
      remoteModels: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', multimodal: true }],
      readImage: async () => ({ data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' }),
    })
    await collect(adapter, {
      model: 'deepseek-v4.1-flash',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_img', name: 'read_image', arguments: '{}' }],
        },
        {
          // DSH 0.1.7 的一等工具结果消息（真实会话里的形态）。
          role: 'tool',
          toolCallId: 'call_img',
          content: [
            { type: 'text', text: '<path>x.png</path>' },
            { type: 'image', attachment: { attachmentId: 'att-1' } },
          ],
        },
      ],
    } as unknown as GenerateOptions)

    const messages = sentBody(fetcher).messages as Array<Record<string, any>>
    const assistantIndex = messages.findIndex((m) => m.role === 'assistant')
    const toolIndex = messages.findIndex((m) => m.role === 'tool')
    expect(toolIndex, '工具结果必须下发').toBeGreaterThan(-1)
    // 紧邻：中间插任何消息（尤其带图的 user 消息）都会被上游 4027 拒收。
    expect(toolIndex, 'role:tool 必须紧跟其 assistant tool_calls').toBe(assistantIndex + 1)
    // 图片不能被这次重排弄丢，且必须排在 tool 之后。
    const imageIndex = messages.findIndex((m) => JSON.stringify(m.content ?? '').includes('image_url'))
    expect(imageIndex, '图片不得静默丢失').toBeGreaterThan(-1)
    expect(imageIndex, '图片应挂在 tool 消息之后').toBeGreaterThan(toolIndex)
  })

  it('⚠️ 同一条 user 消息既带图片又带工具结果时，图片仍发出且排在 tool 之后', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
      remoteModels: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', multimodal: true }],
      readImage: async () => ({ data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' }),
    })
    await collect(adapter, {
      model: 'deepseek-v4.1-flash',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' }],
        },
        {
          // ≤0.1.6 的旧形态：工具结果与图片搭载在同一条 user 消息里。
          role: 'user',
          content: [
            { type: 'image', attachment: { attachmentId: 'att-1' } },
            { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容' }] },
          ],
        },
      ],
    } as unknown as GenerateOptions)

    const messages = sentBody(fetcher).messages as Array<Record<string, any>>
    const assistantIndex = messages.findIndex((m) => m.role === 'assistant')
    const toolIndex = messages.findIndex((m) => m.role === 'tool')
    expect(toolIndex).toBe(assistantIndex + 1)
    const imageIndex = messages.findIndex((m) => JSON.stringify(m.content ?? '').includes('image_url'))
    expect(imageIndex, '外侧图片不得被静默丢弃').toBeGreaterThan(toolIndex)
  })

  it('⚠️ 一个 assistant 发多个 tool_call、「非最后一个」结果内嵌图片时，全部 tool 必须紧密相邻（4027 真实缺陷 · 多调用漏网场景）', async () => {
    // 真实复现（2026-10-19）：模型一次并发调了 read_image + read，
    // 图片在**第一个**结果里。旧实现在每条 user 消息末尾无条件 flushToolImages()，
    // 而 DSH 0.1.7 把每条 tool 结果转成**独立的** role:'user' 消息 ⇒ 图片被 flush 成
    // user 消息插在第 2 条 role:'tool' 之前 ⇒ 上游恒定 4027，且坏报文落库后会话永久卡死。
    //
    // 旧回归用例只覆盖 1 个 tool_call，故这条路径从未被测到。
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
      remoteModels: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', multimodal: true }],
      readImage: async () => ({ data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' }),
    })
    await collect(adapter, {
      model: 'deepseek-v4.1-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'call_img', name: 'read_image', arguments: '{}' },
            { type: 'tool-call', id: 'call_txt', name: 'read', arguments: '{}' },
          ],
        },
        // DSH 0.1.7：每个工具结果是**独立**的 role:'tool' 消息。
        {
          role: 'tool',
          toolCallId: 'call_img',
          content: [
            { type: 'text', text: '<path>x.png</path>' },
            { type: 'image', attachment: { attachmentId: 'att-1' } },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call_txt',
          content: [{ type: 'text', text: '文件内容' }],
        },
      ],
    } as unknown as GenerateOptions)

    const messages = sentBody(fetcher).messages as Array<Record<string, any>>
    const assistantIndex = messages.findIndex((m) => m.role === 'assistant')
    const toolIndexes = messages
      .map((m, i) => (m.role === 'tool' ? i : -1))
      .filter((i) => i >= 0)

    expect(toolIndexes.length, '两条 tool 结果都必须下发').toBe(2)
    // 🔴 核心断言：**两条 tool 必须紧挨着**，中间不得插入任何消息（尤其带图 user 消息）。
    expect(toolIndexes[0], '第一条 tool 必须紧跟 assistant tool_calls').toBe(assistantIndex + 1)
    expect(toolIndexes[1], '第二条 tool 必须紧邻第一条，中间不得插入 user 消息').toBe(toolIndexes[0] + 1)

    // 图片不得静默丢失，且必须排在**所有** tool 消息之后。
    const imageIndex = messages.findIndex((m) => JSON.stringify(m.content ?? '').includes('image_url'))
    expect(imageIndex, '图片不得静默丢失').toBeGreaterThan(-1)
    expect(imageIndex, '图片应挂在全部 tool 消息之后').toBeGreaterThan(toolIndexes[1])
  })

  it('孤儿 tool-call 被剔除（会话自愈，避免上游 400）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, {
      model: 'glm-5.2',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'orphan', name: 'read', arguments: '{}' }],
        },
      ],
    } as unknown as GenerateOptions)

    const body = sentBody(fetcher)
    const assistant = body.messages.find((m: any) => m.role === 'assistant')
    expect(assistant.tool_calls).toBeUndefined()
  })

  it('纯 tool_calls 的 assistant 且无正文时 content 为 null', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, {
      model: 'glm-5.2',
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
      ],
    } as unknown as GenerateOptions)

    const assistant = sentBody(fetcher).messages.find((m: any) => m.role === 'assistant')
    expect(assistant.content).toBeNull()
  })
})

describe('TRAE 适配器 · max_tokens 收敛（上游 64K 安全线）', () => {
  it('客户端索要 131072 时被收敛到 64000', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, { ...BASIC_OPTIONS, maxTokens: 131_072 } as GenerateOptions)
    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body.max_tokens).toBe(64_000)
  })

  it('小于上限的值原样透传', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, { ...BASIC_OPTIONS, maxTokens: 1024 } as GenerateOptions)
    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body.max_tokens).toBe(1024)
  })

  it('未指定 maxTokens 时不发该字段（不编造数值）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, BASIC_OPTIONS)
    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    expect(body).not.toHaveProperty('max_tokens')
  })
})

describe('TRAE 适配器 · 空响应重试（静默 EOF）', () => {
  it('首个事件都没收到时重试一次并成功', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [
        // 第一次：HTTP 200 但一个事件都没发（上游静默结束）。
        sseResponse(''),
        // 第二次：正常回复。
        sseResponse(soloSse(['output', { response: '恢复了' }], ['done', { finish_reason: 'stop' }])),
      ],
    })
    const chunks = await collect(adapter, BASIC_OPTIONS)
    expect(fetcher.mock.calls).toHaveLength(2)
    const text = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => (c as { text: string }).text)
      .join('')
    expect(text).toBe('恢复了')
  })

  it('重试一次仍为空则报 TRANSPORT（不静默返回空答复）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(''), sseResponse('')],
    })
    const error = await collect(adapter, BASIC_OPTIONS).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('TRANSPORT')
    // 只重试一次，不做无限循环。
    expect(fetcher.mock.calls).toHaveLength(2)
  })

  it('已有事件后不再重放（避免重复计费/重复执行工具）', async () => {
    const { adapter, fetcher } = makeAdapter({
      responses: [
        // 有 output 事件，但流中断且没有 done。
        sseResponse(soloSse(['output', { response: '部分内容' }])),
      ],
    })
    await collect(adapter, BASIC_OPTIONS).catch(() => {})
    // 关键：已有上游事件 → 绝不重发请求。
    expect(fetcher.mock.calls).toHaveLength(1)
  })
})

describe('TRAE 适配器 · 机器指纹轮换默认关闭', () => {
  it('默认（未设环境变量）X-Machine-Id 恒为凭据原值', async () => {
    delete process.env.DSH_TRAE_ROTATE_MACHINE_ID
    const { adapter, fetcher } = makeAdapter({
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, BASIC_OPTIONS)
    const headers = (fetcher.mock.calls[0] as [string, { headers: Headers }])[1].headers
    expect(headers.get('X-Machine-Id')).toBe('a'.repeat(32))
  })
})

/**
 * ⚠️ **真实缺陷回归 + 设计锁定**（用户报障 2026-10-04：「trae 显示的上下文长度不对」）。
 *
 * 这里原先有一道**本地历史字符闸门**（写死 480,000 字符，中间版本改成「声明窗口 × 系数」），
 * 超预算就从最早的非系统消息开始整轮丢弃。它已被**整体删除**（来历与理由见
 * `src/trae-adapter.ts` 的「TRAE 没有本地历史闸门」那段注释）——
 * **唯一的限制是 DSH 自己的压缩点（`声明的窗口 × 0.8`）**，与其余 13 个 provider 同形。
 *
 * 下面几条锁的是「**什么都不许裁**」。它们对旧实现是**红的**：
 * - 60 万字符那条：旧写死预算 480,000 ⇒ 最早那条被丢（**正是用户报障的形态**）；
 * - 20K 窗口 30 万字符那条：中间版本「窗口 × 系数」的预算是 100,000 ⇒ 会被裁；
 * - 1M 窗口 600 万字符那条：中间版本的预算是 5,000,000 ⇒ 会被裁。
 *
 * 即：**任何形式的本地闸门重新出现，这几条里至少一条会变红**。
 */
describe('TRAE 适配器 · 无本地历史闸门（本地裁剪已删除）', () => {
  it('⚠️ Max 档 60 万字符的历史必须原样上 wire（旧写死 480K 会静默丢）', async () => {
    const { adapter, fetcher } = makeAdapter({
      product: { ...TRAE, maxMode: true },
      remoteModels: [{
        id: 'max-1m', name: 'Max 1M',
        contextWindow: 200_000, maxMode: true, maxContextWindow: 1_000_000,
        maxOutputTokens: 32_000, maxModeOutputTokens: 64_000,
      }],
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, {
      model: 'max-1m',
      messages: [
        { role: 'user', content: [{ type: 'text', text: `最早的旧消息${'X'.repeat(300_000)}` }] },
        { role: 'user', content: [{ type: 'text', text: `中间消息${'X'.repeat(300_000)}` }] },
        { role: 'user', content: [{ type: 'text', text: '最新的消息' }] },
      ],
    } as unknown as GenerateOptions)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    const joined = JSON.stringify(body.messages)
    expect(joined, '1M 档不该在 60 万字符就丢历史').toContain('最早的旧消息')
    expect(joined).toContain('中间消息')
    expect(joined).toContain('最新的消息')
  })

  it('⚠️ 窗口 20K 档 30 万字符也不裁（不存在「按窗口折算」的预算）', async () => {
    const { adapter, fetcher } = makeAdapter({
      remoteModels: [{ id: 'small-20k', name: '小窗口 20K', contextWindow: 20_000 }],
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, {
      model: 'small-20k',
      messages: [
        { role: 'user', content: [{ type: 'text', text: `最早的旧消息${'X'.repeat(150_000)}` }] },
        { role: 'user', content: [{ type: 'text', text: `中间消息${'X'.repeat(150_000)}` }] },
        { role: 'user', content: [{ type: 'text', text: '最新的消息' }] },
      ],
    } as unknown as GenerateOptions)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    const joined = JSON.stringify(body.messages)
    // 30 万字符对 20K 窗口意味着「系数 15」才留得住 —— 旧实现的 100,000 会把它裁掉。
    expect(joined, '本地不得按窗口折算字符预算').toContain('最早的旧消息')
    expect(joined).toContain('最新的消息')
  })

  it('⚠️ 1M 档 600 万字符也不裁（连「病态体积刹车」也已删除）', async () => {
    const { adapter, fetcher } = makeAdapter({
      product: { ...TRAE, maxMode: true },
      remoteModels: [{
        id: 'max-1m', name: 'Max 1M',
        contextWindow: 200_000, maxMode: true, maxContextWindow: 1_000_000,
      }],
      responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
    })
    await collect(adapter, {
      model: 'max-1m',
      messages: [
        { role: 'user', content: [{ type: 'text', text: `最早的旧消息${'X'.repeat(3_000_000)}` }] },
        { role: 'user', content: [{ type: 'text', text: `中间消息${'X'.repeat(3_000_000)}` }] },
        { role: 'user', content: [{ type: 'text', text: '最新的消息' }] },
      ],
    } as unknown as GenerateOptions)

    const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
    const joined = JSON.stringify(body.messages)
    // 旧「窗口 × 5」= 5,000,000 字符，这条会红：删掉的是**闸门本身**，不是把系数调大。
    expect(joined, '删掉的是闸门本身，不是把系数调大').toContain('最早的旧消息')
    expect(joined).toContain('最新的消息')
  })

  it('⚠️ DSH_TRAE_MAX_HISTORY_CHARS 不再是逃生舱（该环境变量已随闸门删除）', async () => {
    const prev = process.env.DSH_TRAE_MAX_HISTORY_CHARS
    process.env.DSH_TRAE_MAX_HISTORY_CHARS = '200'
    try {
      const { adapter, fetcher } = makeAdapter({
        responses: [sseResponse(soloSse(['done', { finish_reason: 'stop' }]))],
      })
      await collect(adapter, {
        model: 'glm-5.2',
        messages: [
          { role: 'user', content: [{ type: 'text', text: `最早的旧消息${'X'.repeat(300)}` }] },
          { role: 'user', content: [{ type: 'text', text: '最新的消息' }] },
        ],
      } as unknown as GenerateOptions)

      const body = JSON.parse((fetcher.mock.calls[0] as [string, { body: string }])[1].body)
      const joined = JSON.stringify(body.messages)
      // 若这个环境变量还被认，最早那条就会被丢掉（防止有人把闸门偷偷加回来）。
      expect(joined, '该环境变量已失效，不得再裁剪').toContain('最早的旧消息')
    } finally {
      if (prev === undefined) delete process.env.DSH_TRAE_MAX_HISTORY_CHARS
      else process.env.DSH_TRAE_MAX_HISTORY_CHARS = prev
    }
  })
})
describe('TRAE 适配器 · OpenAI chunk 常量导出', () => {
  it('OPENAI_DONE 用于非流式聚合场景', () => {
    expect(OPENAI_DONE).toBe('data: [DONE]\n\n')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 闲时折扣徽标（issue #101 的 TRAE 腿）
//
// 真机 2026-11-17（scripts/probe-trae-promo.mjs）DeepSeek-V4-Flash：
//   current = { type: 'none', 0.2 → 0.2 }   ← 既有价格腿在这里就短路了
//   off_peak = { 0.2 → 0.1, discount 50, windows [0–480, 1320–1440] 每天 }
// ─────────────────────────────────────────────────────────────────────────────
describe('TRAE 适配器 · 闲时折扣徽标（装配时刻求值）', () => {
  const OFF_PEAK = {
    beforeRate: 0.2,
    rate: 0.1,
    discountPercent: 50,
    subKey: 'off_peak_discount',
    windows: [
      { weekdays: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 480 },
      { weekdays: [1, 2, 3, 4, 5, 6, 7], startMinute: 1320, endMinute: 1440 },
    ],
  }
  /** 周二 23:30 Asia/Shanghai —— 落在 22:00–24:00 那段里。 */
  const INSIDE = Date.parse('2026-11-17T15:30:00Z')
  /** 周二 10:00 Asia/Shanghai —— 两段都不在。 */
  const OUTSIDE = Date.parse('2026-11-17T02:00:00Z')

  function withBadge(now: () => number) {
    return makeAdapter({
      now,
      remoteModels: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', creditsRate: 0.2, offPeakDiscount: OFF_PEAK }],
    })
  }

  it('窗口内画一枚；窗口外**整个键缺席**', async () => {
    const inside = withBadge(() => INSIDE)
    await inside.adapter.listModels('trae')
    const shown = (await inside.adapter.listModels('trae'))[0] as Record<string, unknown>
    expect(shown.badge).toEqual({ text: { en: 'Off-peak 50% off', zh: '闲时 5 折' }, tone: 'neutral' })

    const outside = withBadge(() => OUTSIDE)
    await outside.adapter.listModels('trae')
    const hidden = (await outside.adapter.listModels('trae'))[0] as Record<string, unknown>
    // ⚠️ 宿主 LlmRuntime.listModels 判的是 badge === void 0，写显式 undefined 会
    // 让「未知」与「明确没有」在 resolveModel 那条更严的白名单里混成同一个键。
    expect(hidden).not.toHaveProperty('badge')
  })

  it('★ 同一个实例推进时钟就换答案 ⇒ 结论没有被冻进目录（issue #101 的原始事故形态）', async () => {
    let clock = OUTSIDE
    const { adapter } = withBadge(() => clock)
    const first = await adapter.listModels('trae')
    expect(first[0]).not.toHaveProperty('badge')
    clock = INSIDE
    const second = await adapter.listModels('trae')
    expect((second[0] as Record<string, unknown>).badge).toBeDefined()
    // 目录本身没重拉（两次 listModels 都落在 20 分钟新鲜度里）⇒ 变的只有时钟。
    clock = OUTSIDE
    const third = await adapter.listModels('trae')
    expect(third[0]).not.toHaveProperty('badge')
  })

  it('兜底表路径不写 badge（离线上游没活动可画，如实与「上游没有活动」同形）', async () => {
    const { adapter } = makeAdapter({ now: () => INSIDE, credential: null, remoteModels: [] })
    // 无凭据 ⇒ 拿不到远端目录 ⇒ 走编译期兜底表；那些条目根本没有 offPeakDiscount。
    const models = await adapter.listModels('trae')
    for (const model of models) expect(model as Record<string, unknown>).not.toHaveProperty('badge')
  })

  it('nextPromotionEdgeAt 给出下一次边界，且**零网络**', async () => {
    const { adapter, fetcher } = withBadge(() => INSIDE)
    await adapter.listModels('trae')
    const callsBefore = fetcher.mock.calls.length
    // 23:30 之后最近的边界是当天 24:00 = 2026-11-17T16:00Z（Asia/Shanghai）。
    expect(adapter.nextPromotionEdgeAt()).toBe(Date.parse('2026-11-17T16:00:00Z'))
    expect(fetcher.mock.calls.length, '边界求解不许打上游').toBe(callsBefore)
  })

  it('没有闲时活动时 nextPromotionEdgeAt 返回 undefined（不许退化成轮询）', async () => {
    const { adapter } = makeAdapter({
      now: () => INSIDE,
      remoteModels: [{ id: 'plain', name: 'Plain', creditsRate: 0.2 }],
    })
    await adapter.listModels('trae')
    expect(adapter.nextPromotionEdgeAt()).toBeUndefined()
  })

  it('⚠️ 上游把 current 判成无活动**不影响**闲时徽标（两条腿读的是同一份文档的不同分支）', async () => {
    // 反向对照：既有价格腿在这份报文上拿不到 originalCreditsRate（current.type=none
    // 且 before === rate），而徽标必须照画 —— 否则本功能的入口就被老判据挡死了。
    const { adapter } = withBadge(() => INSIDE)
    const models = await adapter.listModels('trae')
    expect(models[0]!.name).toBe('DeepSeek-V4-Flash · x0.2')
    expect((models[0] as Record<string, unknown>).badge).toBeDefined()
  })
})
