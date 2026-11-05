/**
 * 百智云（BaiZhiCloud）纯函数层守卫。
 *
 * 这一层没有网络、没有 cordis，全是「上游事实 + 本仓契约」的映射，
 * 所以每条判据都打一种**实测过的上游事实**或**无守卫时会静默退化**的缺陷：
 *
 * ① `expires_at` 只归一化一次（秒级旧数据 ×1000），无 `expires_at` ⇒ 恒未过期；
 * ② 静态 Key 无 refresh 端点 ⇒ `isBaizhiRefreshable()` 恒 `false`（诚实标记）；
 * ③ 鉴权头是 `x-api-key` **不是** `Authorization: Bearer`（后者是另一条 OpenAI 路由）；
 * ④ 远端目录只给 `id`/`display_name` ⇒ 能力只从本地已知表补，未知就不写；
 * ⑤ 失败分类决定「换号 / 写冷却 / 直接抛」，错一条就会白封账号或白重试；
 * ⑥ 思考预算必须**严格小于** `max_tokens`（Anthropic 硬约束，写成 ≥ 直接被 400）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BAIZHI_MAX_COOLDOWN_MS,
  baizhiCredentialExpiresAtMs,
  baizhiHeaders,
  baizhiIdentityOf,
  baizhiMessagesUrl,
  baizhiModelsUrl,
  baizhiRetryAfterMs,
  classifyBaizhiError,
  classifyBaizhiFailure,
  fetchBaizhiModels,
  isBaizhiContextOverflow,
  isBaizhiExpired,
  isBaizhiRefreshable,
  maskBaizhiKey,
  normalizeBaizhiModelId,
  parseBaizhiModelList,
  recordsBaizhiRateLimit,
  shouldRotateBaizhiAccount,
} from '../../src/baizhi.js'
import {
  BAIZHI,
  BAIZHI_FALLBACK_MODELS,
  BAIZHI_MAX_CONTEXT,
  BAIZHI_MAX_OUTPUT_TOKENS,
  baizhiCapabilityOf,
  baizhiFallbackModels,
  findBaizhiFallback,
  isKnownBaizhiModel,
} from '../../src/baizhi-product.js'
import {
  BAIZHI_DEFAULT_MAX_TOKENS,
  BAIZHI_MIN_THINKING_BUDGET,
  baizhiMaxTokensFor,
  baizhiThinkingFor,
  buildBaizhiMessagesPayload,
} from '../../src/baizhi-messages.js'

/** 实测形状：`sk-` + 64 位，共 67 字符。 */
const KEY = `sk-${'a'.repeat(64)}`

const messages = [{ role: 'user' as const, content: '你好' }]

afterEach(() => { vi.unstubAllGlobals() })

describe('产品配置：id / 名字 / 端点常量', () => {
  it('★ id 必须是纯小写字母（同时是 cordis 服务名与路由名）', () => {
    expect(BAIZHI.id).toBe('baizhi')
    expect(BAIZHI.id).toMatch(/^[a-z]+$/)
  })

  it('展示名是「百智云」', () => {
    expect(BAIZHI.displayName).toBe('百智云')
  })

  it('★ Anthropic 端点逐字正确（手滑改 baseUrl 会让所有请求 404）', () => {
    expect(baizhiMessagesUrl()).toBe('https://ai-models.app.baizhi.cloud/api/anthropic/v1/messages')
    expect(baizhiModelsUrl()).toBe('https://ai-models.app.baizhi.cloud/api/anthropic/v1/models')
    expect(BAIZHI.anthropicVersion).toBe('2023-06-01')
    expect(BAIZHI.catalogTimeoutMs).toBe(10_000)
  })

  it('★ 默认凭据 ref / 上下文上限 / 输出上限', () => {
    expect(BAIZHI.defaultCredentialRef).toBe('BAIZHI_ACCESS_TOKEN')
    // 实测 400 原文：This model's maximum context length is 1048576 tokens
    expect(BAIZHI_MAX_CONTEXT).toBe(1_048_576)
    expect(BAIZHI_MAX_OUTPUT_TOKENS).toBe(100_000)
  })
})

describe('凭据：归一化 / 过期 / 续期标记', () => {
  it('★ 无 expires_at ⇒ 恒未过期（静态 Key 没有过期时间，谎报会让上游摘掉它）', () => {
    expect(baizhiCredentialExpiresAtMs({ access_token: KEY })).toBeUndefined()
    expect(isBaizhiExpired({ access_token: KEY })).toBe(false)
  })

  it('★ 毫秒字符串原样、秒级旧数据 ×1000（防御 >1e12）', () => {
    expect(baizhiCredentialExpiresAtMs({ access_token: KEY, expires_at: '1767225600000' }))
      .toBe(1_767_225_600_000)
    expect(baizhiCredentialExpiresAtMs({ access_token: KEY, expires_at: '1767225600' }))
      .toBe(1_767_225_600_000)
  })

  it('空串 / 0 / 负数 / 非数字 ⇒ undefined（不做「假装有效」的兜底）', () => {
    for (const expires_at of ['', '0', '-1', 'abc', 'Infinity']) {
      expect(baizhiCredentialExpiresAtMs({ access_token: KEY, expires_at })).toBeUndefined()
    }
  })

  it('过期判定：过去 ⇒ true，未来 ⇒ false', () => {
    expect(isBaizhiExpired({ access_token: KEY, expires_at: String(Date.now() - 1000) })).toBe(true)
    expect(isBaizhiExpired({ access_token: KEY, expires_at: String(Date.now() + 60_000) })).toBe(false)
  })

  it('★ 恒不可续期（百智云没有 refresh 端点）', () => {
    expect(isBaizhiRefreshable()).toBe(false)
    expect(isBaizhiRefreshable({ access_token: KEY })).toBe(false)
  })

  it('身份取 access_token，非字符串 ⇒ 空串（不能返回 undefined，syncAccountExpiry 要 string）', () => {
    expect(baizhiIdentityOf({ access_token: KEY })).toBe(KEY)
    expect(baizhiIdentityOf(undefined)).toBe('')
    expect(baizhiIdentityOf({ access_token: 123 as never })).toBe('')
  })

  it('掩码：合法 Key ⇒ 前 4 + 后 4，其余 ⇒ 空串', () => {
    expect(maskBaizhiKey(KEY)).toBe(`sk-a…${'a'.repeat(4)}`)
    expect(maskBaizhiKey('short')).toBe('')
    expect(maskBaizhiKey(`sk-${'a b'.repeat(10)}`)).toBe('')
  })
})

describe('请求头：x-api-key + anthropic-version', () => {
  it('★ 用 x-api-key，**不带** authorization（Bearer 是它另一条 OpenAI 路由的）', () => {
    const headers = baizhiHeaders({ access_token: KEY })
    expect(headers['x-api-key']).toBe(KEY)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers.accept).toBe('text/event-stream')
    expect(headers['content-type']).toBe('application/json')
    expect(headers.authorization).toBeUndefined()
  })

  it('accept 可覆盖（拉目录时用 application/json）', () => {
    expect(baizhiHeaders({ access_token: KEY }, { accept: 'application/json' }).accept)
      .toBe('application/json')
  })
})

describe('模型目录解析：远端字段 + 本地能力表', () => {
  it('★ display_name 作展示名；deepseek 四条带实测窗口', () => {
    const models = parseBaizhiModelList({
      data: [
        { id: 'deepseek-v4-pro', type: 'model', display_name: 'DeepSeek V4 Pro', created_at: 'x' },
        { id: 'deepseek-v4-flash-vision-exp', type: 'model', display_name: 'V4 Flash Vision' },
      ],
    })
    expect(models[0]).toEqual({
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      contextWindow: 1_048_576,
    })
    expect(models[1].supportsImage).toBe(true)
  })

  it('★ display_name 缺失 ⇒ 用 id（不编展示名）', () => {
    const [model] = parseBaizhiModelList({ data: [{ id: 'glm-5' }] })
    expect(model.name).toBe('glm-5')
  })

  it('★ 未知模型：不写 contextWindow、不写 supportsImage（「未知」≠「不支持」）', () => {
    const [model] = parseBaizhiModelList({ data: [{ id: 'brand-new-model-9' }] })
    expect(Object.hasOwn(model, 'contextWindow')).toBe(false)
    expect(Object.hasOwn(model, 'supportsImage')).toBe(false)
  })

  it('★ 已知但窗口未知的模型也不补窗口（glm-5 只知识别，没有窗口证据）', () => {
    const [model] = parseBaizhiModelList({ data: [{ id: 'glm-5' }] })
    expect(Object.hasOwn(model, 'contextWindow')).toBe(false)
    expect(findBaizhiFallback('glm-5')?.contextWindow).toBeUndefined()
  })

  it('容错：非对象 / data 非数组 ⇒ []；id 非字符串或空 ⇒ 跳过；重复 id 去重', () => {
    for (const raw of [null, undefined, 1, 'x', {}, { data: 'x' }, []]) {
      expect(parseBaizhiModelList(raw)).toEqual([])
    }
    const models = parseBaizhiModelList({
      data: [
        { id: 42 },
        { id: '   ' },
        { id: 'glm-5' },
        { id: 'glm-5', display_name: '重复' },
        null,
      ],
    })
    expect(models.map((model) => model.id)).toEqual(['glm-5'])
  })

  it('id 只去首尾空白，不改大小写/不剥前缀（上游 404 model not found 的根因）', () => {
    expect(normalizeBaizhiModelId('  Qwen3.5-Plus  ')).toBe('Qwen3.5-Plus')
  })
})

describe('兜底模型表：至少覆盖实测过的 12 条 id', () => {
  const expected = [
    'minimax-m2.7', 'minimax-m2.5', 'glm-5.1', 'glm-5', 'glm-4.7', 'kimi-k2.5', 'kimi-k2.6',
    'qwen3.6-plus', 'qwen3.5-plus', 'qwen3.5-flash', 'qwen-flash', 'deepseek-v4-pro',
    'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-flash',
  ]

  it('★ 每条实测 id 都在兜底表里（远端目录拉不到时面板不能空）', () => {
    const ids = new Set(BAIZHI_FALLBACK_MODELS.map((model) => model.id))
    for (const id of expected) expect(ids.has(id), `${id} 不在兜底表`).toBe(true)
  })

  it('★ 兜底表 name 一律等于 id（远端拿不到 display_name 时不编）', () => {
    for (const model of BAIZHI_FALLBACK_MODELS) expect(model.name).toBe(model.id)
  })

  it('★ 兜底表快照是拷贝：调用方排序/污染不串到全局', () => {
    const snapshot = baizhiFallbackModels()
    expect(snapshot).not.toBe(BAIZHI_FALLBACK_MODELS)
    expect(snapshot.map((model) => model.id)).toEqual(BAIZHI_FALLBACK_MODELS.map((model) => model.id))
  })

  it('能力查询：已知返回能力、未知返回 undefined', () => {
    expect(baizhiCapabilityOf('deepseek-v4-pro')).toEqual({ contextWindow: BAIZHI_MAX_CONTEXT })
    expect(baizhiCapabilityOf('nope')).toBeUndefined()
    expect(isKnownBaizhiModel('kimi-k2.6')).toBe(true)
    expect(isKnownBaizhiModel('nope')).toBe(false)
  })
})

describe('失败分类矩阵：换号 / 写冷却 / 直接抛', () => {
  it('★ 401/403 ⇒ auth', () => {
    expect(classifyBaizhiError(401, '').kind).toBe('auth')
    expect(classifyBaizhiError(403, '').kind).toBe('auth')
  })

  it('★ 402 ⇒ quota、429 ⇒ rate_limit、400/422 ⇒ invalid_request、5xx ⇒ server', () => {
    expect(classifyBaizhiError(402, '').kind).toBe('quota')
    expect(classifyBaizhiError(429, '').kind).toBe('rate_limit')
    expect(classifyBaizhiError(400, '').kind).toBe('invalid_request')
    expect(classifyBaizhiError(422, '').kind).toBe('invalid_request')
    expect(classifyBaizhiError(500, '').kind).toBe('server')
    expect(classifyBaizhiError(503, '').kind).toBe('server')
  })

  it('★ 状态 0（fetch 抛错）⇒ transport', () => {
    expect(classifyBaizhiError(0, 'fetch failed').kind).toBe('transport')
  })

  it('★ 200 带回 JSON 错误体：按文案兜底分类（Anthropic 协议偶尔这样）', () => {
    expect(classifyBaizhiError(200, '{"error":{"message":"quota exceeded"}}').kind).toBe('quota')
    expect(classifyBaizhiError(200, '{"error":{"message":"Too Many Requests"}}').kind).toBe('rate_limit')
    expect(classifyBaizhiError(200, '{"error":{"message":"invalid api key"}}').kind).toBe('auth')
    // 认不出的 200 JSON ⇒ 不可重试的坏请求（不能报 SERVER，否则被自动重试 5 次）
    expect(classifyBaizhiError(200, '{"unexpected":true}').kind).toBe('invalid_request')
  })

  it('Retry-After 原样带出（供换号后写冷却）', () => {
    expect(classifyBaizhiError(429, '', 12_345).retryAfterMs).toBe(12_345)
    expect(classifyBaizhiError(429, '').retryAfterMs).toBeUndefined()
  })

  it('★ 换号判据：只有 invalid_request 不换号', () => {
    expect(shouldRotateBaizhiAccount('invalid_request')).toBe(false)
    for (const kind of ['auth', 'rate_limit', 'quota', 'server', 'transport'] as const) {
      expect(shouldRotateBaizhiAccount(kind), kind).toBe(true)
    }
  })

  it('★ 写冷却判据：只有 quota/rate_limit 写（auth 写冷却 ⇒ 用户改好 Key 仍要等）', () => {
    expect(recordsBaizhiRateLimit('quota')).toBe(true)
    expect(recordsBaizhiRateLimit('rate_limit')).toBe(true)
    for (const kind of ['auth', 'invalid_request', 'server', 'transport'] as const) {
      expect(recordsBaizhiRateLimit(kind), kind).toBe(false)
    }
  })

  it('classifyBaizhiFailure：读 LlmError 的 failure.status / providerRetryAfterMs', () => {
    const error = Object.assign(new Error('百智云：HTTP 429'), {
      failure: { status: 429, providerRetryAfterMs: 5000 },
    })
    const info = classifyBaizhiFailure(error)
    expect(info.kind).toBe('rate_limit')
    expect(info.retryAfterMs).toBe(5000)
    expect(classifyBaizhiFailure(Object.assign(new Error('x'), { failure: { status: 502 } })).kind)
      .toBe('server')
  })

  it('★ classifyBaizhiFailure：无状态码时按文案（流内 event: error 帧就这条路径）', () => {
    expect(classifyBaizhiFailure(new Error('baizhi: 流内错误：quota exceeded')).kind).toBe('quota')
    expect(classifyBaizhiFailure(new Error('baizhi: 流内错误：rate limit reached')).kind)
      .toBe('rate_limit')
    // 网络层错误（`socket hang up` / `fetch failed`）⇒ transport：可换号，但不写冷却。
    expect(classifyBaizhiFailure(new TypeError('fetch failed')).kind).toBe('transport')
    expect(classifyBaizhiFailure(new Error('socket hang up')).kind).toBe('transport')
    // 认不出的普通错误 ⇒ server（可换号），绝不能猜成 invalid_request（那会直接抛）。
    expect(classifyBaizhiFailure(new Error('boom')).kind).toBe('server')
  })
})

describe('冷却时长：Retry-After 夹紧 / 额度到次日 / 指数退避', () => {
  // 2026-01-01T00:00:00Z = 北京 08:00 ⇒ 次日零点还有 16h
  const now = Date.UTC(2026, 0, 1, 0, 0, 0)

  it('★ 上游 Retry-After 优先，但夹在 [0, 30min]', () => {
    expect(baizhiRetryAfterMs('rate_limit', 5_000, 1, now)).toBe(5_000)
    expect(baizhiRetryAfterMs('rate_limit', 10 * 3_600_000, 1, now)).toBe(BAIZHI_MAX_COOLDOWN_MS)
    expect(BAIZHI_MAX_COOLDOWN_MS).toBe(30 * 60_000)
  })

  it('★ 额度耗尽 ⇒ 到 UTC+8 次日 0 点（与 modelscope/account-pool 同口径）', () => {
    expect(baizhiRetryAfterMs('quota', undefined, 1, now)).toBe(16 * 3_600_000)
  })

  it('★ 限流 ⇒ 1min × 2^(attempt-1)，上限 30min', () => {
    expect(baizhiRetryAfterMs('rate_limit', undefined, 1, now)).toBe(60_000)
    expect(baizhiRetryAfterMs('rate_limit', undefined, 3, now)).toBe(240_000)
    expect(baizhiRetryAfterMs('rate_limit', undefined, 99, now)).toBe(BAIZHI_MAX_COOLDOWN_MS)
  })
})

describe('上下文超限识别', () => {
  it('★ 实测原文必须命中（升级成 CONTEXT_WINDOW_EXCEEDED，换号没用）', () => {
    expect(isBaizhiContextOverflow("This model's maximum context length is 1048576 tokens"))
      .toBe(true)
    expect(isBaizhiContextOverflow('上下文长度超出限制')).toBe(true)
    expect(isBaizhiContextOverflow('invalid api key')).toBe(false)
  })
})

describe('思考预算：必须严格小于 max_tokens', () => {
  it('★ 默认档位换算（none 关闭 / low 2048 / medium 4096 / high 8192）', () => {
    expect(baizhiThinkingFor('none', 100_000)).toEqual({ type: 'disabled' })
    expect(baizhiThinkingFor('low', 100_000)).toEqual({ type: 'enabled', budgetTokens: 2048 })
    expect(baizhiThinkingFor('medium', 100_000)).toEqual({ type: 'enabled', budgetTokens: 4096 })
    expect(baizhiThinkingFor('high', 100_000)).toEqual({ type: 'enabled', budgetTokens: 8192 })
  })

  it('★ 默认 max_tokens=4096 时 high 被夹到 3072（< 4096）', () => {
    const thinking = baizhiThinkingFor('high', BAIZHI_DEFAULT_MAX_TOKENS)
    expect(thinking).toEqual({ type: 'enabled', budgetTokens: 3072 })
    expect(3072).toBeLessThan(BAIZHI_DEFAULT_MAX_TOKENS)
  })

  it('★ 预算放不下最小额度时直接关掉思考（而不是发非法请求）', () => {
    expect(baizhiThinkingFor('low', 2000)).toEqual({ type: 'disabled' })
    expect(baizhiThinkingFor('high', BAIZHI_MIN_THINKING_BUDGET)).toEqual({ type: 'disabled' })
  })

  it('★ 未知 effort 不发字段（百智云顶层 effort 无作用 ⇒ 不暴露档位）', () => {
    expect(baizhiThinkingFor(undefined, 4096)).toBeUndefined()
    expect(baizhiThinkingFor('xhigh', 4096)).toBeUndefined()
    expect(baizhiThinkingFor('on', 4096)).toBeUndefined()
  })

  it('max_tokens 归一化：默认 4096、正数取整、封顶 100,000、非法值回默认', () => {
    expect(baizhiMaxTokensFor(undefined)).toBe(BAIZHI_DEFAULT_MAX_TOKENS)
    expect(baizhiMaxTokensFor(12_345.9)).toBe(12_345)
    expect(baizhiMaxTokensFor(Number.MAX_SAFE_INTEGER)).toBe(BAIZHI_MAX_OUTPUT_TOKENS)
    expect(baizhiMaxTokensFor(0)).toBe(BAIZHI_DEFAULT_MAX_TOKENS)
    expect(baizhiMaxTokensFor(-5)).toBe(BAIZHI_DEFAULT_MAX_TOKENS)
  })
})

describe('请求体构造', () => {
  it('★ 必带 max_tokens / stream / messages', () => {
    const payload = buildBaizhiMessagesPayload({ model: 'deepseek-v4-pro', messages })
    expect(payload.model).toBe('deepseek-v4-pro')
    expect(payload.max_tokens).toBe(BAIZHI_DEFAULT_MAX_TOKENS)
    expect(payload.stream).toBe(true)
    expect(Array.isArray(payload.messages)).toBe(true)
    expect(payload.thinking).toBeUndefined()
  })

  it('★ 全量组合断言：任何 max_tokens × effort 下 budget 都严格小于 max_tokens', () => {
    for (const maxTokens of [undefined, 1024, 1500, 2000, 4096, 8192, 100_000, 200_000]) {
      for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', undefined]) {
        const normalized = baizhiMaxTokensFor(maxTokens)
        const thinking = baizhiThinkingFor(effort, normalized)
        const payload = buildBaizhiMessagesPayload({
          model: 'deepseek-v4-pro',
          messages,
          ...maxTokens === undefined ? {} : { maxTokens },
          ...thinking === undefined ? {} : { thinking },
        })
        const body = payload.thinking as { type?: string; budget_tokens?: number } | undefined
        if (body?.type === 'enabled') {
          const budget = body.budget_tokens ?? 0
          expect(budget, `maxTokens=${maxTokens} effort=${String(effort)}`).toBeLessThan(payload.max_tokens as number)
          expect(budget).toBeGreaterThanOrEqual(BAIZHI_MIN_THINKING_BUDGET)
        }
      }
    }
  })

  it('★ 调用方硬塞超大 budget 也在构造处被夹到 max_tokens - 1', () => {
    const payload = buildBaizhiMessagesPayload({
      model: 'deepseek-v4-pro',
      messages,
      maxTokens: 4096,
      thinking: { type: 'enabled', budgetTokens: 999_999 },
    })
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 4095 })
  })

  it('禁用思考 ⇒ {type:disabled}', () => {
    const payload = buildBaizhiMessagesPayload({
      model: 'deepseek-v4-pro',
      messages,
      thinking: { type: 'disabled' },
    })
    expect(payload.thinking).toEqual({ type: 'disabled' })
  })

  it('空 system / 空 stop 不发字段；tools 映射成 input_schema', () => {
    const payload = buildBaizhiMessagesPayload({
      model: 'deepseek-v4-pro',
      messages,
      system: '',
      stop: [],
      tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }] as never,
    })
    expect(Object.hasOwn(payload, 'system')).toBe(false)
    expect(Object.hasOwn(payload, 'stop_sequences')).toBe(false)
    expect(payload.tools).toEqual([{ name: 'f', description: 'd', input_schema: { type: 'object' } }])
  })
})

describe('fetchBaizhiModels：远端目录', () => {
  it('★ GET /api/anthropic/v1/models，带 x-api-key，解析 data', async () => {
    let seenUrl: string | undefined
    let seenHeaders: Record<string, string> | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url)
      seenHeaders = init?.headers as Record<string, string>
      return new Response(
        JSON.stringify({ data: [{ id: 'deepseek-v4-pro', display_name: 'DeepSeek V4 Pro' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }))
    const models = await fetchBaizhiModels(KEY)
    expect(seenUrl).toBe('https://ai-models.app.baizhi.cloud/api/anthropic/v1/models')
    expect(seenHeaders?.['x-api-key']).toBe(KEY)
    expect(seenHeaders?.authorization).toBeUndefined()
    expect(models.map((model) => model.name)).toEqual(['DeepSeek V4 Pro'])
  })

  it('★ 非 2xx / 空目录一律抛错（让调用方回退兜底表，不吞成空数组）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await expect(fetchBaizhiModels(KEY)).rejects.toThrow(/模型目录请求失败/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { status: 200 })))
    await expect(fetchBaizhiModels(KEY)).rejects.toThrow(/模型目录为空/)
  })
})
