import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_API_BASE, BuddyAdapter, DEFAULT_MODEL, policyBlockResetAtMs, registerBuddyLlm,
} from '../../src/buddy-adapter.js'
import type { BuddyCredential, BuddyRemoteModel } from '../../src/buddy.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from '../../src/product.js'

const CREDENTIAL_REF = credentialRef('BUDDY_ACCESS_TOKEN')

/** 构造一个未过期的凭据。 */
function makeCredential(overrides: Partial<BuddyCredential> = {}): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
    ...overrides,
  }
}

/** adapter.stream() 的最小 GenerateOptions 形参。 */
const streamOptions = {
  model: DEFAULT_MODEL,
  messages: [],
  signal: new AbortController().signal,
} as never

/** 将 SSE 文本包装为流式 Response。 */
function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/**
 * 上下文超限的 400 响应体（用户报障原文，国际版 WorkBuddy + deepseek-v4.1-flash）。
 *
 * 关键字段：`msg` 用「prompt is too long」措辞、`extError.code` 为
 * `context_length_exceeded`。两者都是 DSH `isContextWindowExceededError` 的
 * 识别依据，适配器必须据此把它归为 CONTEXT_WINDOW_EXCEEDED 而非 INVALID_REQUEST。
 */
const CONTEXT_OVERFLOW_BODY = JSON.stringify({
  code: 11115,
  msg: 'prompt is too long: 1061554 tokens > 1048576 maximum',
  requestId: '9dc0e856-3dae-431c-a8bd-87a2ab63e8d9',
  extError: {
    code: 'context_length_exceeded',
    message: 'prompt is too long: 1061554 tokens > 1048576 maximum',
    param: '',
    type: 'invalid_request_error',
    StatusCode: 400,
    Request: null,
    Response: null,
  },
  displayMsg: {
    en: 'The request exceeds the model context limit. Please shorten the conversation or remove attachments.',
    zh: '对话内容超出模型长度上限，请精简对话或减少附件后重试。',
  },
})

function makeAdapter(overrides: {
  credential?: BuddyCredential | undefined
  refresh?: () => Promise<void>
  /** refresh() 之后 resolveCredential 应返回的值；默认刷新成功（恢复为有效凭据）。 */
  postRefreshCredential?: BuddyCredential | undefined
  fetchImpl?: typeof fetch
  fetchRemoteModels?: () => Promise<BuddyRemoteModel[]>
  /**
   * 刻意比生产类型宽松（允许多返回 `undefined`）：用于模拟「旧版桥接」
   * 或版本错配时传入的 readImage——适配器的运行时守卫必须能挡住它，
   * 而不是依赖类型系统保证。生产侧 `BuddyAdapterOptions.readImage`
   * 已不含 undefined。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；不传时由 BuddyAdapter 回退到 CodeBuddy。 */
  product?: BuddyProduct
  /** 目录闸门时钟（验证「距上次拉取 ≥10 秒」这条基于时间的契约）。 */
  now?: () => number
  /** 多账号池替身；本文件只用到模型黑名单（listModels 的过滤输入）。 */
  accountPool?: unknown
  /** 各来源成败回调（issue IKJVTF，审计 I3）；接线层桥接数据源的上报。 */
  catalogComplete?: () => boolean | undefined
} = {}) {
  let credential = 'credential' in overrides ? overrides.credential : makeCredential()
  const refresh = overrides.refresh ?? (async () => {})
  const fetchImpl = overrides.fetchImpl ?? (async () => new Response('not found', { status: 404 }))
  return new BuddyAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => credential,
    refresh: async () => {
      await refresh()
      credential = 'postRefreshCredential' in overrides ? overrides.postRefreshCredential : makeCredential()
    },
    fetchImpl,
    ...overrides.fetchRemoteModels !== undefined ? { fetchRemoteModels: overrides.fetchRemoteModels } : {},
    ...overrides.readImage !== undefined ? { readImage: overrides.readImage } : {},
    ...overrides.product !== undefined ? { product: overrides.product } : {},
    ...overrides.now !== undefined ? { now: overrides.now } : {},
    ...overrides.catalogComplete !== undefined ? { catalogComplete: overrides.catalogComplete } : {},
    ...overrides.accountPool !== undefined ? { accountPool: overrides.accountPool as never } : {},
  })
}

describe('BuddyAdapter', () => {
  it('providerInfo identifies the buddy route', () => {
    // 展示名改由产品配置驱动（this.product.displayName）。CodeBuddy 的
    // displayName 在 Task 1 定稿为 'CodeBuddy (腾讯)'（与 Jet Hub 前端
    // PROVIDERS 的 label 一致），故不再断言旧字面量 'CodeBuddy (Tencent)'。
    expect(makeAdapter().providerInfo('buddy')).toMatchObject({ id: 'buddy', name: CODEBUDDY.displayName })
  })

  it('listModels falls back to the product catalog when no remote source is configured', async () => {
    // CodeBuddy 现在自带 fallbackModels（实测可用的 14 个），故兜底不再是通用 DEFAULT_MODELS。
    const models = await makeAdapter().listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
    expect(models.map((m) => m.id)).toContain('glm-5.3')
    expect(models.every((m) => m.provider === 'buddy')).toBe(true)
  })

  it('listModels prefers the remote catalog and caches it', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls++
        return [{ id: 'remote-model', name: 'Remote Model' }]
      },
    })
    const first = await adapter.listModels('buddy')
    const second = await adapter.listModels('buddy')
    // 产品兜底表是权威白名单：远端多出的 remote-model 被丢弃，
    // 兜底表声明的模型被补齐。重复调用不应再触发远端拉取。
    expect(first.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
    expect(second.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
    expect(calls).toBe(1, '远端列表只应拉取一次')
  })

  it('listModels falls back to the product catalog when the remote fetch fails', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    const models = await adapter.listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
  })

  it('兜底表白名单保留「被 agent 引用」的模型（真实缺陷回归：hy4-preview-f）', async () => {
    // ⚠️ 真实缺陷（用户报障「hy4 preview 现在 ide 是免费我们还是 0.29」）：
    // 两个端点下发的 id 集合不同，而「限时免费」促销只挂在
    // `/v3/config` 独有的 `hy4-preview-f` 上，它**不在产品兜底表**里。
    // 白名单式重建会把它丢弃 → 用户看不到那个免费变体，而 IDE 里能看到。
    //
    // 判据用 `agentReferenced`（服务端自己的「可选」信号），
    // 而不是猜 id 后缀（`-f`/`-x`/`-sg` 含义各异，猜错会放进不可用的模型）。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        // 不在兜底表、但服务端说可选 → 必须保留
        { id: 'hy4-preview-f', name: 'Hy4 preview', creditsRate: 'x0.29', discountedCreditsRate: '免费', agentReferenced: true },
        // 不在兜底表、服务端也没说可选（内部别名）→ 仍应丢弃
        { id: 'internal-alias', name: 'Internal' },
      ],
    })
    const ids = (await adapter.listModels('buddy')).map((m) => m.id)
    expect(ids).toContain('hy4-preview-f')
    expect(ids).not.toContain('internal-alias')
    // 追加在末尾，不打乱兜底表原有顺序
    expect(ids.slice(0, CODEBUDDY.fallbackModels!.length))
      .toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
    expect(ids.at(-1)).toBe('hy4-preview-f')
    // 展示名带促销价与变体标记（与既有 hy3/hy3-x 同款消歧）
    const name = (await adapter.listModels('buddy')).find((m) => m.id === 'hy4-preview-f')?.name
    expect(name).toContain('免费')
    expect(name).toContain('F')
  })

  // ── 计费倍率与同名区分（写进 name）──
  //
  // ⚠️ **必须写进 `name`，不是 `description`**：composer 的模型切换菜单只渲染
  // `name`（见 dsh-client-ui-model-selection 的 ModelSelect：`children: model.name`），
  // `description` 仅用于 `/model` 弹窗。用户报障「消耗倍率没有显示在切换模型
  // 列表的后面」正是因为早期版本放在了 `description`。
  //
  // 安全性：`name` 纯属展示 —— DSH 的选择与持久化只用 `id`
  // （`selectionOf` 返回 `model: model.id`）。
  describe('listModels 的计费倍率与同名区分', () => {
    it('把 credits 追加到 name 后面', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'glm-5.3', name: 'GLM-5.3', creditsRate: 'x0.79' },
        ],
      })
      const models = await adapter.listModels('buddy')
      expect(models[0]?.name).toBe('GLM-5.3 · x0.79')
    })

    it('有促销时显示 原价→促销价', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4-flash', name: 'DS', creditsRate: 'x0.17', discountedCreditsRate: 'x0.50' },
        ],
      })
      const models = await adapter.listModels('buddy')
      expect(models[0]?.name).toBe('DS · x0.17→x0.50')
    })

    it('无倍率信息时 name 保持原样', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'mystery', name: 'M' }],
      })
      const models = await adapter.listModels('buddy')
      expect(models[0]?.name).toBe('M')
    })

    // 真实问题（用户报障）：国际版 `deepseek-v4.1-flash` 与
    // `deepseek-v4.1-flash-sg` 的远端 name **完全相同**，而 IDE 只显示一个。
    // 两者是不同区域/计费的实体（credits x0.00 vs x0.03），不能简单丢弃其一，
    // 故对撞车的 name 追加变体标记。
    it('同名模型追加变体标记以区分', async () => {
      const adapter = makeAdapter({
        product: { ...WORKBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', creditsRate: 'x0.00' },
          { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', creditsRate: 'x0.03' },
        ],
      })
      const models = await adapter.listModels('workbuddy')
      expect(models.map((m) => m.name)).toEqual([
        'Deepseek-V4.1-Flash · x0.00',
        'Deepseek-V4.1-Flash · x0.03 SG',
      ])
      // 唯一性：选择器里不会再出现两个无法区分的条目。
      expect(new Set(models.map((m) => m.name)).size).toBe(2)
    })

    // 实测另有 hy3/hy3-x 与 hy4-preview-f/hy4-preview 两组撞车，
    // 硬编码 `-sg` 会漏掉它们，故用公共前缀的通用算法。
    it('非 -sg 的同名组同样被区分（公共前缀算法）', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'hy3', name: 'Hy3' },
          { id: 'hy3-x', name: 'Hy3' },
        ],
      })
      const models = await adapter.listModels('buddy')
      expect(models.map((m) => m.name)).toEqual(['Hy3', 'Hy3 · X'])
    })

    it('三个以上同名 id 仍能全部区分', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'gpt-5.6', name: 'GPT-5.6' },
          { id: 'gpt-5.6-sol', name: 'GPT-5.6' },
          { id: 'gpt-5.6-luna', name: 'GPT-5.6' },
        ],
      })
      const models = await adapter.listModels('buddy')
      expect(new Set(models.map((m) => m.name)).size).toBe(3)
    })

    it('不同名的模型不追加变体标记', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
          { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
        ],
      })
      const models = await adapter.listModels('buddy')
      expect(models.map((m) => m.name)).toEqual(['GPT-5.6-Sol', 'GPT-5.6-Luna'])
    })

    // 真实回归：初版把倍率与变体标记写进 description，导致
    // 「计费 x0.00 · 」（孤立分隔符）与重复的「SG」，而且**在切换模型列表里
    // 根本看不到**（用户报障）。
    it('倍率不进 description（否则切换菜单看不到）', async () => {
      const adapter = makeAdapter({
        product: { ...WORKBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'a', name: 'Same', creditsRate: 'x0.10' },
          { id: 'a-sg', name: 'Same', creditsRate: 'x0.20' },
        ],
      })
      const models = await adapter.listModels('workbuddy')
      for (const model of models) expect(model).not.toHaveProperty('description')
      expect(models[0]?.name).toBe('Same · x0.10')
      expect(models[1]?.name).toBe('Same · x0.20 SG')
    })
  })

  it('resolveModel reports the known context window', async () => {
    const resolved = await makeAdapter().resolveModel('buddy', 'deepseek-v4-flash')
    expect(resolved).toMatchObject({ provider: 'buddy', id: 'deepseek-v4-flash', context: { contextWindow: 1_000_000 } })
  })

  it('resolveModel matches the Rust fallback table for glm and hy models', async () => {
    // 对齐 deveco-code-rust BuddyProvider::context_limit 静态 fallback：
    // glm-5.3-flash 1M（此前误配 200k，导致 web 上下文表显示 ~200K）。
    const adapter = makeAdapter()
    expect((await adapter.resolveModel('buddy', 'glm-5.3-flash')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy', 'glm-5.3')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy', 'glm-5.2')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy', 'glm-5.1')).context).toEqual({ contextWindow: 200_000 })
    expect((await adapter.resolveModel('buddy', 'minimax-m3')).context).toEqual({ contextWindow: 512_000 })
    expect((await adapter.resolveModel('buddy', 'kimi-k2.6')).context).toEqual({ contextWindow: 256_000 })
  })

  // ── 单次输出上限（maxOutputTokens）──
  //
  // 用户报障：deepseek-v4.1-flash 在 32000 token 处被截断，turn/end 为
  // `{kind:'max-tokens'}`。根因是适配器**从未下发 max_tokens**，上限完全由
  // 网关默认值决定（实测网关对 auto 等模型正是 32000）；而远端早已下发权威的
  // maxOutputTokens（实测 deepseek-v4.1-flash = 128000）。
  describe('单次输出上限', () => {
    it('远端 maxOutputTokens 映射为 defaultMaxTokens', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'DS', maxOutputTokens: 128_000 },
        ],
      })
      expect((await adapter.resolveModel('buddy', 'deepseek-v4.1-flash')).defaultMaxTokens).toBe(128_000)
    })

    it('远端与兜底表都没有该值时保持 undefined（不编造）', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'mystery', name: 'M' }],
      })
      expect((await adapter.resolveModel('buddy', 'mystery')).defaultMaxTokens).toBeUndefined()
    })

    it('远端缺失时用产品兜底表的实测值补位', async () => {
      // deepseek-v4.1-flash 在 CodeBuddy 兜底表中已按实测填 128000。
      const resolved = await makeAdapter().resolveModel('buddy', 'deepseek-v4.1-flash')
      expect(resolved.defaultMaxTokens).toBe(128_000)
    })

    it('stream 把上限写进请求体的 max_tokens', async () => {
      let body: Record<string, unknown> = {}
      const adapter = makeAdapter({
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      } as never)
      expect(body.max_tokens).toBe(128_000)
    })

    it('调用方显式给出的 maxTokens 优先于远端与兜底表', async () => {
      let body: Record<string, unknown> = {}
      const adapter = makeAdapter({
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4_096,
        signal: new AbortController().signal,
      } as never)
      expect(body.max_tokens).toBe(4_096)
    })

    it('远端下发的值优先于兜底表', async () => {
      let body: Record<string, unknown> = {}
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'DS', maxOutputTokens: 7_000 },
        ],
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      } as never)
      expect(body.max_tokens).toBe(7_000)
    })

    it('workbuddy 的 deepseek-v4.1-flash 同样默认 128000', async () => {
      // 国际版实测 /v3/config 下发 128000，兜底表与之对齐。
      const adapter = makeAdapter({ product: WORKBUDDY })
      expect((await adapter.resolveModel('workbuddy', 'deepseek-v4.1-flash')).defaultMaxTokens).toBe(128_000)
    })

    it('非法/非正的远端值被忽略', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'zero', name: 'Z', maxOutputTokens: 0 },
          { id: 'neg', name: 'N', maxOutputTokens: -5 },
        ],
      })
      expect((await adapter.resolveModel('buddy', 'zero')).defaultMaxTokens).toBeUndefined()
      expect((await adapter.resolveModel('buddy', 'neg')).defaultMaxTokens).toBeUndefined()
    })
  })

  it('resolveModel prefers the remote maxInputTokens over the static table', async () => {
    // /v3/config data.models[].maxInputTokens 是权威来源（对齐 Rust
    // context_limit_for_model 两级查找）：远端下发值覆盖静态 fallback。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_048_576 }],
    })
    const resolved = await adapter.resolveModel('buddy', 'glm-5.3-flash')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
  })

  it('resolveModel falls back to the static table when the remote value is absent', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' }],
    })
    const resolved = await adapter.resolveModel('buddy', 'glm-5.3-flash')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('resolveModel omits context for unknown models', async () => {
    const resolved = await makeAdapter().resolveModel('buddy', 'unknown-model')
    expect(resolved.context).toBeUndefined()
  })

  // ── 图片能力声明 ──
  // 权威来源是 /v3/config 的 supportsImages。此前硬编码 ['text']，会话控制器
  // 直接在附件准入处拒绝图片（MODEL_DOES_NOT_SUPPORT_IMAGES），用户表现为
  // "设置里需要声明才能用图片"。
  describe('图片能力声明', () => {
    it('远端 supportsImages=true 时声明 image 模态', async () => {
      // 用无兜底表的产品：本节测「远端字段如何生效」，而兜底表会充当
      // 白名单把这类临时 id 滤掉（另见「产品兜底模型目录校正」一节）。
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'vision', name: 'V', supportsImages: true }],
      })
      expect((await adapter.resolveModel('buddy', 'vision')).inputModalities).toEqual(['text', 'image'])
    })

    it('远端显式 supportsImages=false 时保持 text-only', async () => {
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'plain', name: 'P', supportsImages: false }],
      })
      expect((await adapter.resolveModel('buddy', 'plain')).inputModalities).toEqual(['text'])
    })

    it('远端未下发该字段时回退静态表', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'DS' }],
      })
      expect((await adapter.resolveModel('buddy', 'deepseek-v4.1-flash')).inputModalities).toEqual(['text', 'image'])
    })

    /**
     * ⚠️⚠️ **本家唯一真正使用「未知」语义的地方 —— 必须从 `toCatalogEntry`
     * 这一端测到，不能只测骨架。**
     *
     * ## 为什么这条用例曾经缺失（2026-10-08 第二轮反向验证实测）
     *
     * `model-catalog-parity.spec.ts` 里有一条「未知模态」用例，但它喂给骨架的是
     * **手搓的 `CatalogEntry`**（刻意省略 `inputModalities`）—— 那测的是
     * `createModelCatalog` **拿到**省略态之后的行为，**绕过了 buddy 自己的
     * `toCatalogEntry`**。而 `buddy-adapter.spec.ts` 里本节的三条用例分别覆盖
     * 「远端 true / 远端 false / 远端缺字段但有静态表」，**恰好没有一条**让
     * `inputModalitiesFor` 返回 `undefined`。
     *
     * 后果：把 `toCatalogEntry` 里
     * `...modalities !== undefined ? { inputModalities: modalities } : {}`
     * 改成 `inputModalities: modalities ?? ['text']`（= 把「不知道」谎报成
     * 「不支持图片」），**全部 153 条 buddy 用例加上整个 parity 套件零红**
     * —— 实测确认过。也就是说 Task 7 Step 7 第 1 条要求的反向验证当时**做不出来**，
     * 而计划原文已经预见到这个风险：
     * 「⚠️ 若没有这条用例，本步骤必须先补一条，否则这个缺陷会静默流出去」。
     *
     * ## 可达性（不是理论分支）
     *
     * 兜底表**不可**作为载体：实测 `CODEBUDDY.fallbackModels` 16 条、
     * `WORKBUDDY.fallbackModels` 23 条，`supportsImages` **全部显式声明**
     * （未声明者 0 条）⇒ 兜底表这条路永远走不到省略分支。
     * 真正可达的是 `reconcileWithFallback` 末尾追加的
     * 「被 agent 引用但不在兜底表」的模型：它只带 `{ id, name, agentReferenced }`，
     * 三个图片能力来源全落空 ⇒ `imageCapabilityKnown` 为 false
     * ⇒ 返回 `undefined` ⇒ **必须省略该字段**。
     * 本用例正是走这条路。
     */
    it('⚠️⚠️ 能力全无来源（agentReferenced 追加的模型）⇒ 省略字段，不得谎报 [text]', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [
          // 未被兜底表覆盖、且**没有** supportsImages —— 三个来源全落空。
          { id: 'anon-vision', name: 'Anon', agentReferenced: true },
        ],
      })

      const hit = (await adapter.listModels('buddy')).find((m) => m.id === 'anon-vision')
      expect(hit, 'agentReferenced 的模型应被追加进目录').toBeDefined()
      // ⚠️ 核心：字段**不存在**（`in` 为 false），而不是值为 ['text']。
      //    后者会让宿主 DSH 把图片**静默投影成占位文本**（见 inputModalitiesFor
      //    的说明与 jpg 实拍报障）。
      expect('inputModalities' in hit!).toBe(false)

      // 两个入口必须同判据（`resolveModel` 走的是同一份 CatalogEntry）。
      expect('inputModalities' in await adapter.resolveModel('buddy', 'anon-vision')).toBe(false)
    })

    // ── issue IKJQ3M ──
    //
    // 「远端下发了完整能力元数据、但模型不在编译期兜底表里」这一档，
    // 修复前会被 reconcileWithFallback 的白名单式重建整个丢弃（连同它
    // 自带的 supportsImages: true），于是 inputModalitiesFor 三级 ?? 全落空
    // ⇒ 贴图报 `does not accept image input`，而真实网关完全支持图片。
    //
    // ⚠️ 这**不是**瞬时状态：远端目录即使拉取成功也照样误判（issue 里
    // 「重启即自愈」的结论只在模型恰好被 agent 引用时成立）。
    it('远端下发能力元数据、模型不在兜底表时仍保留该模型并声明 image', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{
          id: 'space-bunny', name: 'Space-Bunny', supportsImages: true, contextWindow: 1_000_000,
        }],
      })
      const models = await adapter.listModels('buddy')
      const spaceBunny = models.find((m) => m.id === 'space-bunny')
      expect(spaceBunny, '远端声明了能力的模型不该被白名单丢弃').toBeDefined()
      expect(spaceBunny?.inputModalities).toEqual(['text', 'image'])
      expect((await adapter.resolveModel('buddy', 'space-bunny')).inputModalities).toEqual(['text', 'image'])
    })

    // ⚠️ 放宽白名单**不得**放宽到「什么都能进」：远端既没下发能力元数据、
    // 也没说它可选（无 agentReferenced）的内部别名仍必须被丢弃
    // （既有 `hy4-preview-f` 回归用例守住 agentReferenced 这一条，这里守另一半）。
    it('远端未声明能力也未被 agent 引用的模型仍被白名单丢弃', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'internal-alias-probe', name: 'Internal' }],
      })
      expect((await adapter.listModels('buddy')).map((m) => m.id))
        .not.toContain('internal-alias-probe')
    })

    // ⚠️⚠️ **反向护栏：放宽不得把「实测不可调用」的模型放回选择器**。
    //
    // 上一版把追加判据写成「有任一能力元数据就保留」，其中包含
    // `maxOutputTokens` / `contextWindow` —— 而实测「11102 service info not
    // found」的模型（glm-4.6/4.7/5.0、minimax-m2.5、kimi-k2.5、hunyuan-* …）
    // **恰好也带这两个字段**（src/product.ts 的 CODEBUDDY_FALLBACK_MODELS
    // 注释明确记录了它们被排除的理由）。⇒ 放宽会把它们放回模型选择器，
    // 用户选中后才报错 —— **这是修复引入的新缺陷，比原缺陷更糟**。
    //
    // ✅ 判据必须是「**图片能力**这一项」，即该模型正是本 issue 要解决的那类。
    it('实测不可调用的模型（带窗口/输出上限但无图片能力）不得被放回选择器', async () => {
      const unusable = ['glm-4.6', 'glm-4.7', 'glm-5.0', 'minimax-m2.5', 'kimi-k2.5', 'hunyuan-chat']
      const adapter = makeAdapter({
        fetchRemoteModels: async () => unusable.map((id) => ({
          id, name: id, contextWindow: 256_000, maxOutputTokens: 24_000,
        })),
      })
      const ids = (await adapter.listModels('buddy')).map((m) => m.id)
      for (const id of unusable) {
        expect(ids, `${id} 实测 11102 不可调用，不该进模型选择器`).not.toContain(id)
      }
    })

    // ⚠️ 反向验证的另一半：**带图片能力的模型仍然要被保留**（别把上面的
    // 收窄做过头 —— 那会把 issue 的正题重新修坏）。
    it('带图片能力的模型被保留（确认上一条不是「一律丢弃」）', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [
          { id: 'usable-vision', name: 'Vision', supportsImages: true, maxOutputTokens: 24_000 },
        ],
      })
      expect((await adapter.listModels('buddy')).map((m) => m.id)).toContain('usable-vision')
    })

    // ⚠️ **两站都要覆盖**（复审 M4）：`BuddyAdapter` 一个类同时服务
    // `buddy`（CodeBuddy 中国版）与 `workbuddy`（国际版），两站的兜底表
    // 差异很大（19 条、含 GPT 系 vs 16 条、含 hy4-preview-f），
    // 「白名单放宽」在任一站失效都不会被上面的 CODEBUDDY 用例发现。
    it('workbuddy 国际版同样适用（白名单放宽 + 不可调用模型仍被挡）', async () => {
      const adapter = makeAdapter({
        product: WORKBUDDY,
        fetchRemoteModels: async () => [
          { id: 'space-bunny', name: 'Space-Bunny', supportsImages: true, maxOutputTokens: 128_000 },
          // 国际版同样实测有 11102 不可调用条目（见 product.ts 的注释）
          { id: 'glm-4.6', name: 'GLM-4.6', contextWindow: 256_000, maxOutputTokens: 24_000 },
        ],
      })
      const listed = await adapter.listModels('workbuddy')
      const ids = listed.map((m) => m.id)
      expect(ids).toContain('space-bunny')
      expect(ids).not.toContain('glm-4.6')
      expect(listed.find((m) => m.id === 'space-bunny')?.inputModalities).toEqual(['text', 'image'])
    })
  })

  // ── 「能力未知」不等于「不支持」：贴图门禁的三态语义（issue IKJQ3M）──
  //
  // 修复前 `inputModalitiesFor` 把「远端没拉到」与「远端说不支持」压成同一个
  // 结果（都是 ['text']），于是：远端拉取失败 ⇒ 实际支持图片的模型被误杀，
  // 且错误文案误导（说「模型不支持图片」，实际是「暂时不知道」）。
  //
  // 三态契约（本次修复的权威定义）：
  //   - 明确支持 → ['text','image']
  //   - 明确不支持（远端显式 supportsImages=false）→ ['text']
  //   - **未知**（远端没拉到 / 目录未就绪）→ **不声明** inputModalities
  //
  // ⚠️ 未知必须**省略字段**而不是报 ['text']：宿主 DSH 见到 ['text'] 会按
  // 「确认是纯文本模型」把图片静默投影成占位文本（dsh-llm `lib/index.js`
  // 的 projectImagesForTextModel），用户既看不到图也拿不到原因。
  describe('贴图门禁：能力未知时的行为（issue IKJQ3M）', () => {
    /**
     * harness 的默认可重试错误码集合，**从 dsh-llm 源码原文里读出来**。
     *
     * ⚠️ 该常量在 `lib/types/*.d.ts` 里**未导出**，只能读源码。
     *
     * ⚠️⚠️ **为什么读源码而不是写死字面量**（初版的推理是反的，复审指出）：
     * 两条路的保护方向**相反**，各有各的失效模式：
     * - **写死字面量**：宿主若把某个码加进可重试集合，这条用例**不会变红**
     *   —— 我们对「哪个码可重试」的认知已与宿主脱钩，而错误码的选取正是
     *   为了利用宿主的重试语义，认知脱钩＝修复静默失效。
     * - **读源码**：宿主改集合时断言自动跟随，看起来「不会报警」，但那正是
     *   它要表达的**事实**（此码此刻确实可重试 ⇒ 我们选它就是错的）。
     *
     * ✅ 真正需要防的「同义反复」是**另一种**：把判据原样抄进断言
     * （断言复述实现，而不是独立事实）。本例断言的是**宿主的事实**，
     * 与被测代码无引用关系 —— 不是同义反复。
     *
     * ⚠️ 初版（09fe2eb）选 `TRANSPORT` 时，本条**实测变红**
     * （`expected [...] to not include 'TRANSPORT'`）—— 保护机制已实证有效。
     */
    const DEFAULT_RETRYABLE_CODES: readonly string[] = (() => {
      const src = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/@deepseek-ai/dsh-llm/lib/index.js'),
        'utf8',
      )
      const body = /const DEFAULT_RETRYABLE_CODES = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src)?.[1]
      if (body === undefined) throw new Error('dsh-llm 未声明 DEFAULT_RETRYABLE_CODES，断言口径失效')
      // 去掉 `EMPTY_RESPONSE_CODE` 这类引用名，统一取字符串字面量。
      const codes = [...body.matchAll(/["']([A-Z_]+)["']/g)].map((m) => m[1]!)
      // `EMPTY_RESPONSE` 由同文件里另一个常量名给出，补上它以免漏判。
      if (!codes.includes('EMPTY_RESPONSE')) codes.push('EMPTY_RESPONSE')
      return codes
    })()

    /** 构造一个「远端目录永远拿不到」的适配器，并统计拉取次数。 */
    function makeUnreadyAdapter(options: {
      fetchRemoteModels?: () => Promise<BuddyRemoteModel[]>
      now?: () => number
    } = {}): { adapter: BuddyAdapter; calls: () => number } {
      let calls = 0
      const adapter = makeAdapter({
        readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
        fetchRemoteModels: options.fetchRemoteModels ?? (async () => {
          calls++
          throw new Error('catalog endpoint is down')
        }),
        fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
      })
      return { adapter, calls: () => calls }
    }

    const UNKNOWN_MODEL = 'space-bunny'

    it('远端目录未就绪时贴图不再谎报「模型不支持图片」', async () => {
      // 修复前抛 `UNSUPPORTED_CONTENT: model "..." does not accept image input`，
      // 把「暂时不知道」说成「确认不支持」。
      const { adapter } = makeUnreadyAdapter()
      const error = await collectChunks(adapter, {
        model: UNKNOWN_MODEL,
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(LlmError)
      // 仍拒绝（不能把未知当成支持），但**错误码与文案必须可区分**。
      expect((error as LlmError).code).not.toBe('UNSUPPORTED_CONTENT')
      expect(String((error as LlmError).message)).not.toContain('does not accept image input')
      expect(String((error as LlmError).message)).toContain(UNKNOWN_MODEL)

      // ⚠️⚠️ **错误码绝不能是 `TRANSPORT`**（反向验证时踩过）：
      // harness 的 `DEFAULT_RETRYABLE_CODES` 是
      // `['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`
      // —— `TRANSPORT` **在里面**（dsh-llm `lib/index.js` 实测），
      // 于是这条「请稍后重试」会被 harness 白重试 5 次
      // （500/1000/2000/4000/8000 ms），而每次重试都重走一遍
      // `stream()` → `refreshCatalog()`，把一次用户报错放大成 6 次目录拉取
      // ＋6 次凭据解析。方向取反：用**明确不可重试**的码，让用户自己决定
      // 何时重试（那时目录通常已恢复）。
      expect(DEFAULT_RETRYABLE_CODES).not.toContain((error as LlmError).code)
    })

    it('远端目录未就绪时 resolveModel 不声明 inputModalities（宿主因此不投影图片）', async () => {
      const { adapter } = makeUnreadyAdapter()
      const resolved = await adapter.resolveModel('buddy', UNKNOWN_MODEL)
      // ⚠️ 关键：必须是 undefined（宿主才不把图片投影成占位文本），
      // 报 ['text'] 等于告诉宿主「这是纯文本模型」。
      expect(resolved.inputModalities).toBeUndefined()
    })

    it('远端目录未就绪时 listModels 里该模型也不声明 inputModalities', async () => {
      const { adapter } = makeUnreadyAdapter()
      const models = await adapter.listModels('buddy')
      // 兜底表里的模型已知支持图片，仍应正常声明。
      expect(models.find((m) => m.id === 'deepseek-v4.1-flash')?.inputModalities).toEqual(['text', 'image'])
      // 未被任何表覆盖的模型：能力未知 ⇒ 不声明。
      expect((await adapter.resolveModel('buddy', UNKNOWN_MODEL)).inputModalities).toBeUndefined()
    })

    it('远端目录恢复后能力判定随之恢复（重新拉取并声明 image）', async () => {
      // ⚠️ 刻意**不用** `vi.useFakeTimers()`/`vi.setSystemTime`：它们会污染
      // 同文件其余用例（真实计时器用例被挂起，实测 `fails fast with a retryable
      // TIMEOUT` 变成时序敏感、单独跑却绿）。这里改为**注入一个可控时钟**
      // —— 闸门的 `now` 本就是构造参数（`RemoteCatalogGateOptions.now`），
      // 用它既无全局副作用，又让「10 秒」这条契约直接可观测。
      let clock = 1_000_000
      let calls = 0
      const adapter = makeAdapter({
        readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
        // 让适配器的闸门与测试共用同一个时钟。
        now: () => clock,
        fetchRemoteModels: async () => {
          calls++
          if (calls === 1) throw new Error('catalog endpoint is down')
          return [{ id: UNKNOWN_MODEL, name: 'Space-Bunny', supportsImages: true }]
        },
        fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
      })
      // 第一次：未知
      expect((await adapter.resolveModel('buddy', UNKNOWN_MODEL)).inputModalities).toBeUndefined()

      // ⚠️ 用户定的重试规则（issue IKJQ3M）：**距上次失败不足 10 秒不重拉**。
      // 目录端点超时上限 60s（src/buddy.ts 的 REQUEST_TIMEOUT_MS），无节流的
      // 「贴图就重拉」会把每个模型的每次请求都放大成一次远端拉取
      // —— 那正是 RemoteCatalogGate 当初要挡的放大。
      await adapter.refreshCatalog()
      expect(calls, '10 秒内不得重复拉取').toBe(1)
      expect((await adapter.resolveModel('buddy', UNKNOWN_MODEL)).inputModalities).toBeUndefined()

      // ⚠️ 反向验证的另一半：过够时间后**必须真的重拉并重新判能力**，
      // 否则用户永远停留在「未知」，问题只是被推迟而不是被修复。
      clock += 11_000
      await adapter.refreshCatalog()
      expect(calls, '超过 10 秒后应重新拉取目录').toBe(2)
      expect((await adapter.resolveModel('buddy', UNKNOWN_MODEL)).inputModalities).toEqual(['text', 'image'])
    })

    it('远端显式声明 supportsImages=false 时仍照旧拒绝（不得放宽真失败）', async () => {
      // 白名单放宽 + 「未知不谎报」都不能把「远端说不支持」也放行。
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
        fetchRemoteModels: async () => [{ id: 'text-only-probe', name: 'P', supportsImages: false }],
        fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
      })
      const error = await collectChunks(adapter, {
        model: 'text-only-probe',
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)
      expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
      expect(String((error as LlmError).message)).toContain('does not accept image input')
    })

    // ⚠️⚠️ **本修复的核心承诺：贴图时先重看一次目录，恢复了就当没事发生**
    // （对抗审计 MUT5 实测：把 `stream()` 里那段 `refreshCatalog()` 整块删掉，
    //  当时 144 条用例**全绿** ⇒ 核心行为零覆盖。这条把它锁住。）
    //
    // 场景：能力未知的**那一刻**目录没拉到，但只要「距上次拉取 ≥10 秒」，
    // 用户贴的**这一轮**就应重新拉一次；目录此时已恢复 ⇒ 图片正常发出，
    // 用户根本看不到那句「请稍后重试」。
    it('贴图这一轮会自动重看目录；目录已恢复则图片正常发出（不报错）', async () => {
      let clock = 1_000_000
      let catalogCalls = 0
      let sentBody: Record<string, unknown> | undefined
      const adapter = makeAdapter({
        now: () => clock,
        readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
        fetchRemoteModels: async () => {
          catalogCalls++
          // 第一次失败（此刻能力未知）；此后成功并声明支持图片。
          if (catalogCalls === 1) throw new Error('catalog endpoint is down')
          return [{ id: UNKNOWN_MODEL, name: 'Space-Bunny', supportsImages: true }]
        },
        fetchImpl: async (_url, init) => {
          sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: [DONE]\n\n')
        },
      })
      // 先让能力进入「未知」态。
      expect((await adapter.resolveModel('buddy', UNKNOWN_MODEL)).inputModalities).toBeUndefined()

      // 越过 10 秒节流窗口（用户定的规则）。
      clock += 11_000

      // ⚠️ 关键：这一次 stream() 内部必须自己重看目录，而不是报错。
      await collectChunks(adapter, {
        model: UNKNOWN_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这是什么颜色？' },
            { type: 'image', attachment: { attachmentId: 'a' } },
          ],
        }],
        signal: new AbortController().signal,
      } as never)

      // 不抛错（这就是与「报错让用户重试」的本质差别）。
      expect(catalogCalls, '贴图这一轮必须自动重看目录').toBe(2)
      // ⚠️ 且图片**真的进了请求体** —— 只断言「不抛错」是同义反复：
      // 一条把图片静默丢掉的实现同样不抛错（TRAE/lobsterai 都踩过这个坑）。
      //
      // ⚠️ **不按 parts 顺序断言**：issue IKLIFH 的 `0dd27ca` 起顺序为「图在前」，
      // 而两种顺序上游都能看到。按下标/顺序写死会让实现一调顺序就假失败 ——
      // 那正是本次合并前 master 上 3 条红灯的成因。
      const user = (sentBody?.messages as Array<Record<string, unknown>> | undefined)
        ?.find((m) => m.role === 'user')
      const parts = user?.content as Array<Record<string, unknown>> | undefined
      expect(parts, '请求体里必须有那条带图的 user 消息').toHaveLength(2)
      expect(parts).toContainEqual({ type: 'text', text: '这是什么颜色？' })
      expect(parts).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } })
    })
  })

  // ── Issue IKLIFH：工具结果里的图片必须与提问同条 ──
  //
  // 真实报障「codebuddy hy4 不支持识别图片」。实测（2026-10-14，直连
  // copilot.tencent.com，hy4-preview + 同一张 1024x768 双色图，问左右颜色）：
  //
  //   图与提问**同一条** user                     ✅ 答「左白右蓝」
  //   图单独一条 user（带/不带提示句），问在下一条 ❌ 答「图像已被过滤」
  //   图并入 role:'tool' 消息本身                 ❌ 答「不支持读取图片」
  //
  // ⚠️ wire 上**确实有图**、上游也**不报错**（HTTP 200 + 正常流），只是模型
  // 看不见并自称「当前模型不支持图片」⇒ 用户会误判成模型能力问题去换模型。
  // ⚠️ 与 hy4 无关：同一张图换 `deepseek-v4-flash` 同样答「已被过滤」，
  // 而两者远端都是 `supportsImages: true`。
  describe('Issue IKLIFH：工具结果图片与提问同条', () => {
    const IMAGE_ID = 'att-1'

    /** 构造：assistant tool_call → 工具结果内嵌图片 → 后续提问（截图 #1 的形状）。 */
    function messagesWithAsk(askText: string, extraUserText?: string) {
      return [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'tc1', name: 'read_image', arguments: '{}' }],
        },
        {
          role: 'tool',
          toolCallId: 'tc1',
          content: [
            { type: 'text', text: 'preview 1024x768px.' },
            { type: 'image', attachment: { attachmentId: IMAGE_ID } },
          ],
        },
        ...extraUserText === undefined ? [] : [{ role: 'user', content: extraUserText }],
        { role: 'user', content: askText },
      ]
    }

    function adapterCapturing() {
      let sentBody: Record<string, unknown> | undefined
      const adapter = makeAdapter({
        readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
        fetchImpl: async (_url, init) => {
          sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: [DONE]\n\n')
        },
      })
      return { adapter, body: () => sentBody }
    }

    it('图片与提问合并为同一条 user 消息（真实报障形态）', async () => {
      const { adapter, body } = adapterCapturing()
      await collectChunks(adapter, {
        model: 'hy4-preview',
        messages: messagesWithAsk('这页写了什么？'),
        signal: new AbortController().signal,
      } as never)

      const messages = (body().messages as Array<Record<string, unknown>>)
      const toolIndex = messages.findIndex((m) => m.role === 'tool')
      expect(toolIndex, '工具结果必须下发').toBeGreaterThan(-1)
      // 协议约束：tool 必须紧跟其 assistant tool_calls，否则上游 400。
      const assistantIndex = messages.findIndex((m) => m.role === 'assistant')
      expect(toolIndex).toBe(assistantIndex + 1)

      // ⚠️ 核心断言：图与问**同一条**。
      const imageIndex = messages.findIndex((m) => Array.isArray(m.content)
        && (m.content as Array<{ type: string }>).some((p) => p.type === 'image_url'))
      const askIndex = messages.findIndex((m) => Array.isArray(m.content)
        && (m.content as Array<{ type: string; text?: string }>).some((p) => p.text?.includes('这页写了什么')))
      expect(imageIndex, '图片不得静默丢弃').toBeGreaterThan(-1)
      expect(askIndex, '提问不得静默丢弃').toBeGreaterThan(-1)
      expect(imageIndex, '图片必须与提问同条（Issue IKLIFH 的正题）').toBe(askIndex)
      expect(imageIndex, '且必须排在 tool 之后').toBeGreaterThan(toolIndex)
    })

    /**
     * 工具结果后跟**多于一条** user 消息时，图与**全部**正文必须合并成一条。
     *
     * ⚠️ 这条 2026-10-14 之前是**红的**，且红的不是断言而是**真缺陷**：
     * `const deferred = toolResults.length > 0` 在「tool 结果 → 无工具结果的
     * user（『好的』）→ 真正的提问」这一序列上判错 —— 中间那条把挂图与延后正文
     * **一起 flush 掉并单独发出**，真正的提问随后成了纯字符串 user 消息，
     * 图与问重新分处两条，**恰好复现 IKLIFH 本次要消灭的形态**。
     *
     * ⚠️ 旧版这条断言的是**缺陷形态本身**（`askIndex > imageIndex`，即允许
     * 分处两条），等于把 bug 锁成了契约。现在按正确行为锁定：三者同条。
     */
    it('工具结果后跟多条 user 消息时，图与全部正文合并为同一条（修 IKLIFH 的漏网序列）', async () => {
      const { adapter, body } = adapterCapturing()
      await collectChunks(adapter, {
        model: 'hy4-preview',
        messages: messagesWithAsk('这页写了什么？', '好的'),
        signal: new AbortController().signal,
      } as never)

      const messages = (body().messages as Array<Record<string, unknown>>)
      const users = messages.filter((m) => m.role === 'user')
      // 不得因为多一条 user 就多发一条消息。
      expect(users, '图与提问必须合并成同一条 user 消息').toHaveLength(1)
      const parts = users[0]!.content as Array<{ type: string; text?: string }>
      expect(parts.some((p) => p.type === 'image_url'), '图片不得静默丢弃').toBe(true)
      // 中间那条「好的」与真正的提问都要在这同一条里。
      expect(parts.some((p) => p.text?.includes('好的')), '中间那条正文不得被丢弃').toBe(true)
      expect(parts.some((p) => p.text?.includes('这页写了什么')), '提问不得与图分处两条').toBe(true)
    })

    /**
     * ⚠️⚠️ Issue IKLSB8：**纯图片型工具结果不得被压成字面量 `(no output)`**。
     *
     * 工具结果里**只有图片、没有任何文本**时，`contentToText` 返回空串 ⇒ 落到
     * `|| '(no output)'` 兜底 ⇒ 模型收到的是「工具没有任何输出」，于是答
     * 「Read 没有返回内容 / gave no output」——用户据此以为模型没有视觉能力，
     * 而真实原因是「有输出，输出是图」。Claude Code 的
     * `tool_result.content=[{type:'image'}]` 恰是这一形状。
     *
     * ⚠️ 判据必须是「内容说清了『输出在这里、只是它是图』」：只断言
     * 「不是 `(no output)`」是弱断言 —— 换成任意占位串都会绿。
     */
    it('⚠️⚠️ 纯图片工具结果不得写成 `(no output)`（Issue IKLSB8）', async () => {
      const { adapter, body } = adapterCapturing()
      await collectChunks(adapter, {
        model: 'hy4-preview',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'tc1', name: 'read_image', arguments: '{}' }],
          },
          {
            role: 'tool',
            toolCallId: 'tc1',
            // 刻意**只有图片**（Claude Code 的真实形状，也是本 issue 的现场）。
            content: [{ type: 'image', attachment: { attachmentId: IMAGE_ID } }],
          },
          { role: 'user', content: '这页写了什么？' },
        ] as never,
        signal: new AbortController().signal,
      } as never)

      const messages = (body().messages as Array<Record<string, unknown>>)
      const tool = messages.find((m) => m.role === 'tool')!
      expect(tool, '工具结果必须下发').toBeDefined()
      expect(
        String(tool.content),
        '纯图片工具结果退化成 `(no output)` ⇒ 模型答「没有返回内容」，用户误判成模型没有视觉能力',
      ).not.toBe('(no output)')
      expect(
        String(tool.content),
        '至少要说明「输出在这里、只是它是图片」，否则模型无法解释为何没有文本',
      ).toMatch(/image/i)
      // 图片本体照旧必须真的上 wire（不得因为改了正文兜底而丢图）。
      expect(JSON.stringify(messages)).toContain('image_url')
    })

    it('无挂图时不凭空多发 user 消息（纯文本形态逐字节不变）', async () => {
      const { adapter, body } = adapterCapturing()
      await collectChunks(adapter, {
        model: 'hy4-preview',
        messages: [{ role: 'user', content: '你好' }],
        signal: new AbortController().signal,
      } as never)

      const messages = (body().messages as Array<Record<string, unknown>>)
      const users = messages.filter((m) => m.role === 'user')
      expect(users).toHaveLength(1)
      // 纯文本必须是**字符串**（不是 parts 数组），否则上游报 model_param_invalid。
      expect(typeof users[0]!.content).toBe('string')
      expect(users[0]!.content).toBe('你好')
    })
  })

  // ── 思考强度声明 ──
  // composer 的模型选择器读取 resolveModel().reasoning.efforts；不声明该字段
  // 就显示"当前模型未提供推理等级"。
  describe('思考强度声明', () => {
    it('按远端 supportedEfforts 暴露等级与默认值', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{
          id: 'deepseek-v4.1-flash',
          name: 'DS',
          reasoningEfforts: ['low', 'high', 'max'],
          defaultReasoningEffort: 'high',
        }],
      })
      const resolved = await adapter.resolveModel('buddy', 'deepseek-v4.1-flash')
      expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'high', 'max'])
      expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['Low', 'High', 'Max'])
      expect(resolved.reasoning?.defaultEffort).toBe('high')
    })

    it('远端未下发等级时回退静态表', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'deepseek-v4-pro', name: 'DS' }],
      })
      expect((await adapter.resolveModel('buddy', 'deepseek-v4-pro')).reasoning?.efforts.map((e) => e.id))
        .toEqual(['low', 'high', 'xhigh'])
    })

    it('无可选等级的模型不暴露选择器', async () => {
      // 远端与产品兜底表都未声明 reasoningEfforts 时不暴露选择器。
      // （兜底表会给部分模型补上等级，故这里用无兜底表的产品测本行为）
      const adapter = makeAdapter({
        product: { ...CODEBUDDY, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'glm-5.1', name: 'GLM' }],
      })
      expect((await adapter.resolveModel('buddy', 'glm-5.1')).reasoning).toBeUndefined()
    })

    it('产品兜底表声明的等级在远端缺失时生效', async () => {
      // glm-5.1 在 CodeBuddy 兜底表里声明了 medium 等级。
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'glm-5.1', name: 'GLM' }],
      })
      const resolved = await adapter.resolveModel('buddy', 'glm-5.1')
      expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['medium'])
    })

    // ── issue IKJQSH 回归 ──
    //
    // 实测（2026-10-06）：国际版 `/v3/config` 对 deepseek-v4.1-flash / -sg
    // **不下发 supportedEfforts**，只给单值 `reasoning: {effort:"high"}`，
    // 而 `parseModelMeta` 不认 `effort` ⇒ 远端表态被静默忽略。
    //
    // ⚠️ 这意味着兜底表**不是**「远端不可用时的备胎」，而是这两个模型的
    // **唯一**档位来源 —— 远端正常时也一样。所以这条用例必须锁死「远端下发
    // 不带档位的条目」这个**正常**形态，而不是只测远端失败（那测不到真实现状）。
    it('远端下发条目但不带 supportedEfforts 时，兜底表是对外唯一声明（workbuddy）', async () => {
      const adapter = makeAdapter({
        product: WORKBUDDY,
        // ⚠️ 复刻实测的远端形态：有 id/name/maxOutputTokens，**无** reasoningEfforts。
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', maxOutputTokens: 128_000 },
          { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', maxOutputTokens: 128_000 },
        ],
      })
      for (const id of ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg']) {
        const resolved = await adapter.resolveModel('workbuddy', id)
        // 用户界面上能选到的档位 = 兜底表声明的那一组。
        expect(resolved.reasoning?.efforts.map((e) => e.id), id)
          .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
        // max 必须真的进得来，否则 UI 选 max 会被 dsh-llm 抛 UNSUPPORTED_REASONING_EFFORT。
        expect(resolved.reasoning?.efforts.some((e) => e.id === 'max'), `${id} 缺 max`).toBe(true)
        expect(resolved.reasoning?.defaultEffort, id).toBe('high')
      }
    })

    it('⚠️ 兜底表缩水会直接削掉用户的可选档位（反向验证：改回 ["high"] 用例必红）', async () => {
      // 锁住「兜底表即唯一来源」这个因果：把产品配置换成单档后，max 必须消失。
      // 只断言「声明了什么」是同义反复 —— 任何实现都能过。
      const adapter = makeAdapter({
        product: {
          ...WORKBUDDY,
          fallbackModels: WORKBUDDY.fallbackModels!.map((m) =>
            m.id === 'deepseek-v4.1-flash'
              ? { ...m, reasoningEfforts: ['high'] as const, defaultReasoningEffort: 'high' }
              : m),
        } as never,
        fetchRemoteModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'DS' }],
      })
      const resolved = await adapter.resolveModel('workbuddy', 'deepseek-v4.1-flash')
      expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['high'])
      expect(resolved.reasoning?.efforts.some((e) => e.id === 'max')).toBe(false)
    })
  })

  // 回归：dsh-llm 0.1.1-rc.2 的 LlmRuntime.prepareCall() 会直接调用
  // registration.adapter.prepareCall()，而本仓库链接的副本（0.1.0-rc.6）
  // 的 LlmAdapter 基类没有该方法——缺少时每轮请求都以
  // `registration.adapter.prepareCall is not a function` 失败。
  it('exposes prepareCall for the runtime adapter contract', async () => {
    const adapter = makeAdapter()
    expect(typeof adapter.prepareCall).toBe('function')
    const call = await adapter.prepareCall('buddy', 'hy4-preview')
    expect(call.model).toMatchObject({
      provider: 'buddy',
      id: 'hy4-preview',
      context: { contextWindow: 1_000_000 },
      inputModalities: ['text', 'image'],
    })
    expect(typeof call.stream).toBe('function')
  })

  it('prepareCall binds its stream to the same adapter instance', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'),
    })
    const call = await adapter.prepareCall('buddy', DEFAULT_MODEL)
    const chunks: Array<Record<string, any>> = []
    for await (const chunk of call.stream(streamOptions as never)) {
      chunks.push(chunk as unknown as Record<string, any>)
    }
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
  })
})

describe('BuddyAdapter credential handling', () => {
  it('stream throws MISSING_CREDENTIAL when no credential is configured', async () => {
    // credential 缺失且刷新也拿不到凭据（postRefreshCredential: undefined）。
    const adapter = makeAdapter({ credential: undefined, postRefreshCredential: undefined })
    await expect(collectChunks(adapter, streamOptions)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('stream refreshes first when the credential is expired', async () => {
    let refreshed = false
    const adapter = makeAdapter({
      credential: makeCredential({ expires_at: String(Date.now() - 60_000) }),
      refresh: async () => { refreshed = true },
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
    })
    await collectChunks(adapter, streamOptions)
    expect(refreshed).toBe(true)
  })

  it('stream refreshes once and retries on HTTP 401', async () => {
    let refreshed = 0
    let calls = 0
    const adapter = makeAdapter({
      refresh: async () => { refreshed++ },
      fetchImpl: async () => {
        calls++
        return calls === 1
          ? new Response('unauthorized', { status: 401 })
          : sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      },
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(refreshed).toBe(1, '401 只应触发一次刷新')
    expect(calls).toBe(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  /**
   * 账号池替身：只实现 401/403 换号路径用到的方法。
   *
   * `findAccountIdByCredential` 必须真实工作 —— 适配器靠它把当前凭据归属到
   * 账号条目，归属不到（返回 `''`）时换号会先拿回刚失败的那个账号。
   */
  function makePool(accounts: Array<{ id: string; credential: BuddyCredential }>) {
    /** 记录 `updateModelRateLimit` 的调用，供「安全策略拦截冷却标记」用例断言。 */
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    return {
      recorded,
      findAccountIdByCredential: async (_provider: string, token: string) =>
        accounts.find(a => a.credential.access_token === token)?.id ?? '',
      getAvailableAccount: async (
        _provider: string,
        _modelId: string,
        exclude?: ReadonlySet<string>,
      ) => {
        const entry = accounts.find(a => exclude === undefined || !exclude.has(a.id))
        return entry === undefined ? null : { entry, credential: entry.credential }
      },
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      disabledModelsFor: () => new Set<string>(),
    }
  }

  it('401 时刷新失败也会换号重试（账号池完好时不得整轮失败）', async () => {
    // 真实缺陷场景（2026-09-26，用户报障）：refresh 抛「未配置凭据，请先登录」
    // （接线刷错了单凭据 ref），而账号池里第 2 个账号完全可用。
    // 修复前：异常直接冒泡 → 整轮失败，且下一轮复现（自锁）。
    const second = makeCredential({ access_token: 'AT2' })
    const usedTokens: string[] = []
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      // 刷新「失败」：模拟刷错 ref 的旧接线（此时适配器必须仍能靠换号完成请求）。
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: second },
      ]),
      fetchImpl: async (_url: unknown, init: { headers: Headers }) => {
        const token = init.headers.get('Authorization') ?? ''
        usedTokens.push(token)
        return token.includes('AT1')
          ? new Response('unauthorized', { status: 401 })
          : sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      },
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(usedTokens.some(t => t.includes('AT2'))).toBe(true, '应换到池内第二个账号重试')
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('401 且池内所有账号都认证失败时报 AUTH（不再谎称未配置凭据）', async () => {
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async () => new Response('forbidden', { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('AUTH')
    // 文案必须指向真实原因（全部账号被拒绝），而不是「请先登录」。
    expect((error as LlmError).message).not.toContain('未配置凭据')
  })

  it('换号耗尽时错误必须带上服务端响应体（403 在腾讯侧不等于认证失败）', async () => {
    // 真实回归（修复自身引入的，2026-09-27）：换号耗尽后只报「所有账号均认证失败」，
    // 把服务端真正说的原因丢掉了 —— 而 403 也可能是额度耗尽 / 模型无权限 /
    // 安全策略。实测那批 403 之后逐账号复验，5 个 token 全部有效。
    const body = JSON.stringify({ code: 8003, msg: 'insufficient balance' })
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async () => new Response(body, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    const message = (error as LlmError).message
    expect(message).toContain('403')
    expect(message).toContain('insufficient balance')
    // 403 不得断言成「请重新登录」——那会把额度问题引向错误的修复动作。
    expect(message).not.toContain('重新登录')
  })

  it('安全策略拦截（11140）会逐个换号，全部试完才报错', async () => {
    // ⚠️ **结论修正（2026-09-27 实测）**：早期实现断言「安全审核是内容问题，
    // 换号毫无意义 → 一次都不多发」。逐账号对照实测推翻了它：
    // **同一份请求体**（system + 两个字）发往池里 7 个账号，得到
    // 「2 个 200 / 4 个 403·11140 / 1 个 429」——拦截**按账号生效**，与内容无关。
    //
    // 用户侧现象吻合：连「你好」都被拦，且换新会话照样被拦（排除上下文累积）。
    // 因此正确行为是**换号**（与 401/403 认证失败同一条路径）：坏账号可能排在
    // 池里任何位置，不换号就等于让池中可用账号永远闲置。
    const body = JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      requestId: '5b2240b4-efdf-40e0-94e4-cfee1aa80585',
      displayMsg: { zh: '内容未通过安全审核，请调整后重试。' },
    })
    let calls = 0
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async () => { calls++; return new Response(body, { status: 403 }) },
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    // 错误码取 PERMISSION_DENIED（**不是** AUTH）：DSH 的聊天 UI 是
    // `code === "AUTH" ? "API 密钥无效" : message`
    // （取证：`@deepseek-ai/dsh-client-ui-chat/lib/client.js:1229-1234`），
    // 取 AUTH 会把整条 message 换成「API 密钥无效」——下面那些为「指向账号」
    // 而写的文案一个字都到不了用户眼前，且把用户引向检查密钥（实测 token 全有效）。
    // PERMISSION_DENIED 也不在 harness 的 DEFAULT_RETRYABLE_CODES 里 → 不白重试。
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    // 文案必须指向**账号**，不再断言「请调整内容后重试」把用户引向错误方向。
    expect((error as LlmError).message).toContain('安全策略')
    expect((error as LlmError).message).toContain('账号')
    expect((error as LlmError).message).not.toContain('请调整内容')
    // 关键：**必须换号**——两个账号各试一次（首发 acc-1 + 换号 acc-2）。
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('安全策略拦截（11140）回 HTTP 400 时同样换号（2026-10-16 后端行为变更）', async () => {
    // 之前 11140 回 403，在 401/403 分支处理。2026-10-16 实测后端改成回 400，
    // 400 不进入 401/403 分支 → 修复前直接抛 INVALID_REQUEST 不换号。
    const body = JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      displayMsg: { zh: '请求被拦截，请重新发送' },
    })
    let calls = 0
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async () => { calls++; return new Response(body, { status: 400 }) },
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    expect((error as LlmError).message).toContain('安全策略')
    expect((error as LlmError).message).toContain('HTTP 400')
    // 必须换号：两个账号各试一次。
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('11140 回 400 时换到可用账号即成功', async () => {
    const safety = JSON.stringify({ code: 11140, msg: 'request illegal' })
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async (_url: unknown, init: { headers: Headers }) =>
        (init.headers.get('Authorization') ?? '').includes('AT1')
          ? new Response(safety, { status: 400 })
          : new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.length).toBeGreaterThan(0)
  })

  /**
   * 与真实 `AccountPool` 同形的账号池替身（用于 400 换号块的回归用例）。
   *
   * ⚠️⚠️ 为什么**不能**复用上面的 `makePool`：那个替身只实现了
   * 401/403 换号路径用到的方法，**不实现 `modelRateLimits` 的过滤腿**。而真实池
   * （`src/account-pool.ts:1758`）在取号时会「过滤掉仍处于冷却期的账号 + 按
   * `Date.now() >= resetAt` 比较」。
   *
   * ⇒ 缺了这一腿的替身会**高估**「刚被 11140 拦下的账号会不会被拿回来」，
   * 从而把「拿回刚失败的账号」这类缺陷误判成生产里不可达（2026-10-17 审计实测：
   * 前两轮探针正是被这一点误导，结论要靠换成同形替身才定得下来）。
   */
  function makeCooldownAwarePool(accounts: Array<{ id: string; credential: BuddyCredential }>) {
    /** `账号 id → (模型 id → 冷却到期时刻)`，与真实池的 `modelRateLimits` 同形。 */
    const limits = new Map<string, Record<string, number>>()
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    return {
      recorded,
      findAccountIdByCredential: async (_provider: string, token: string) =>
        accounts.find(a => a.credential.access_token === token)?.id ?? '',
      getAvailableAccount: async (
        _provider: string,
        modelId: string,
        exclude?: ReadonlySet<string>,
      ) => {
        // 逐条对齐真实池的三个 filter：provider / 排除集 / 冷却期。
        const entry = accounts.find(a => {
          if (exclude !== undefined && exclude.has(a.id)) return false
          const resetAt = limits.get(a.id)?.[modelId]
          return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
        })
        return entry === undefined ? null : { entry, credential: entry.credential }
      },
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        recorded.push({ accountId, modelId, resetAtMs })
        limits.set(accountId, { ...limits.get(accountId), [modelId]: resetAtMs })
      },
      disabledModelsFor: () => new Set<string>(),
    }
  }

  const POLICY_BODY = JSON.stringify({ code: 11140, msg: 'request illegal' })
  const OK_SSE_400 = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'

  it('400 换号途中撞到 403 形态的 11140 仍继续换号（判据不得绑状态码，2026-10-17 审计）', async () => {
    // ⚠️⚠️ 真实缺陷（2026-10-17 审计实测）。上游这一族拒绝**同时用 400 与 403**，
    // 而 PR 109 的换号循环把「继续换号」判据写死成 `status === 400` ⇒
    // 「400 起 → 403 形态拦截」会在此 break，后面**完全可用**的账号一个都试不到。
    //
    // 池：AT1 = 400/11140、AT2 = 403/11140、AT3 = 可用。
    // 修复前：只发 2 次即报 `AUTH` 失败，AT3 从未被试（症状 = 池里有可用账号却用不上）。
    const used: string[] = []
    const pool = makeCooldownAwarePool([
      { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
      { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      { id: 'acc-3', credential: makeCredential({ access_token: 'AT3' }) },
    ])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: pool,
      fetchImpl: async (_url: unknown, init: { headers: Headers }) => {
        const token = init.headers.get('Authorization') ?? ''
        used.push(token.replace(/[^A-Z0-9]/g, ''))
        if (token.includes('AT1')) return new Response(POLICY_BODY, { status: 400 })
        if (token.includes('AT2')) return new Response(POLICY_BODY, { status: 403 })
        return new Response(OK_SSE_400, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(used).toEqual(['BAT1', 'BAT2', 'BAT3'])
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    // ⚠️⚠️ **冷却标记是这条断言真正有牙的地方**（2026-10-17 变异验证实测）。
    //
    // 只断言「AT3 被用上」是**不够的**：即使把循环内判据重新绑死成
    // `status === 400`，AT2 的 403 仍会被下面的「401/403 → 继续换号」腿接住、
    // AT3 照样被用上 ⇒ 那条断言全绿、**对原缺陷零牙**。
    //
    // 两种写法真正分叉的地方是**冷却标记**：判据不绑状态码时，403 形态的
    // 11140 走「拦截」腿 ⇒ AT2 被写 30 分钟策略冷却；绑死 400 时它只走
    // 「认证失败」腿 ⇒ AT2 **没有**冷却标记 ⇒ 下一轮它仍是第一候选，
    // 重新被试一遍再撞同一堵墙（`markPolicyBlockedAccount` 的存在理由）。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acc-1', 'acc-2'])
  })

  it('400 换号途中撞到 401 仍继续换号（认证失败按账号生效，2026-10-17 审计）', async () => {
    // 同款缺陷的另一格：换号途中撞到凭据失效（账号级问题）时也必须继续换号。
    // 修复前：AT1 400/11140 → AT2 401 即 break，只发 2 次报 `AUTH`，AT3 从未被试。
    const used: string[] = []
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: makeCooldownAwarePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
        { id: 'acc-3', credential: makeCredential({ access_token: 'AT3' }) },
      ]),
      fetchImpl: async (_url: unknown, init: { headers: Headers }) => {
        const token = init.headers.get('Authorization') ?? ''
        used.push(token.replace(/[^A-Z0-9]/g, ''))
        if (token.includes('AT1')) return new Response(POLICY_BODY, { status: 400 })
        if (token.includes('AT2')) return new Response('unauthorized', { status: 401 })
        return new Response(OK_SSE_400, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(used).toEqual(['BAT1', 'BAT2', 'BAT3'])
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('400/403 混合形态全部被拦时报出**最后一次**拦截的 HTTP 状态（2026-10-17 审计）', async () => {
    // 首发恒为 400，最后一次拦截可能是 403 ⇒ 报「HTTP 400」与实际对不上。
    // 与 401/403 路径的 `rejectionStatus` 纪律一致：报错取**最后一次**拦截。
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: makeCooldownAwarePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async (_url: unknown, init: { headers: Headers }) =>
        (init.headers.get('Authorization') ?? '').includes('AT1')
          ? new Response(POLICY_BODY, { status: 400 })
          : new Response(POLICY_BODY, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    // 最后一次拦截是 403 ⇒ 必须报 403（报 400 即为「与实际对不上」）。
    expect((error as LlmError).message).toContain('HTTP 403')
    expect((error as LlmError).message).not.toContain('HTTP 400')
    expect((error as LlmError).message).toContain('已逐个换号重试')
  })

  it('单凭据（无账号池）+ 400/11140 报「当前账号」而非谎称「全部账号已换号」', async () => {
    // 没有池就**没有换号发生过**：文案必须走单凭据出口，否则会对用户谎报
    // 「已逐个换号重试」—— 用户去 Jet Hub 检查池状态会被误导。
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      fetchImpl: async () => new Response(POLICY_BODY, { status: 400 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    expect((error as LlmError).message).toContain('当前账号')
    expect((error as LlmError).message).not.toContain('已逐个换号重试')
    // ⚠️⚠️ 也不能自称「流内错误帧下发」（2026-10-17 第一轮审计实测的真缺陷）：
    // 这一格是 **HTTP 响应体**（状态 400），不是流内帧。那句措辞原本只为流内路径
    // 设计，被 HTTP 单凭据路径复用 `rotated:false` 时一并带了出来 ⇒ 对用户谎报了
    // 错误的失败通道，会把人引向「流式解析有问题」这个完全错误的方向。
    expect((error as LlmError).message).not.toContain('流内错误帧下发')
    expect((error as LlmError).message).toContain('没有其他账号可换')
  })

  it('400 换号途中撞到 14003 模型饱和也继续换号（2026-10-17 第一轮审计 P1）',
    // ⚠️ 必须放宽超时：该格会真的走一次饱和退避（`buddySaturationDelayMs` 的 sleep），
    // 默认 5s 超时会在**断言之前**把用例判红 —— 那与被测行为无关，是测试自身的问题。
    { timeout: 60000 }, async () => {
    // ⚠️⚠️ 真缺陷（第一轮独立审计实测，我已独立复现）。
    //
    // 饱和分支的既定处置是「留在本账号退避重试、绝不换号」，其前提是
    // 「饱和是模型级，池里其它账号会撞同一堵墙」。但上游若按账号做过负载均衡，
    // 该前提不成立 —— 而 11140 本身已被证明是**按账号**生效的。
    //
    // 实测（AT1 `400/11140` → AT2 `429/14003` → AT3 完全可用）：
    //   修复前发过的凭据 = `AT1, AT2, AT2, AT2` —— **AT3 从未被试**，
    //   且报出「换账号无效，请改用其它模型」这条**与事实相反**的指引。
    const used: string[] = []
    const pool = makeCooldownAwarePool([
      { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
      { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      { id: 'acc-3', credential: makeCredential({ access_token: 'AT3' }) },
    ])
    const saturation = JSON.stringify({ code: 14003, msg: 'model busy, please switch model' })
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: pool,
      fetchImpl: async (_url: unknown, init: { headers: Headers }) => {
        const token = init.headers.get('Authorization') ?? ''
        used.push(token.replace(/[^A-Z0-9]/g, ''))
        if (token.includes('AT1')) return new Response(POLICY_BODY, { status: 400 })
        if (token.includes('AT2')) return new Response(saturation, { status: 429 })
        return new Response(OK_SSE_400, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const chunks = await collectChunks(adapter, streamOptions)
    // 关键：AT3 那个**完全可用**的账号必须被用上。
    expect(used).toContain('BAT3')
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    // ⚠️ **刻意不写冷却**：饱和是模型级的，写 30 分钟账号级冷却会封死好账号
    // （饱和分支的注释正是为此反对复用限流标记）。只 acc-1（11140）该被标记。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acc-1'])
  })

  it('400 换号途中末位撞 401/403 也不丢 11140 根因（2026-10-17 对抗审计阻断项）', async () => {
    // ⚠️⚠️ 阻断级真缺陷。出口判据原先只读循环结束后**最后一次**的 `errorText`，
    // 而 401/403 腿会把它刷成认证失败的报文 ⇒ 已记账的 11140 变成死变量。
    //
    // 实测（AT1 `400/11140` → AT2 `403 forbidden quota`，池耗尽）：
    //   修复前 code=`AUTH`、message「buddy: forbidden quota」—— **11140 完全消失**。
    // 而 AUTH 是 IKLBSH 红线：DSH 客户端把 message 整个换成「API 密钥无效」，
    // 用户看不到「该去 Jet Hub 停用被拦账号」这句唯一出路（实测 token 全部有效）。
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: makeCooldownAwarePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async (_url: unknown, init: { headers: Headers }) =>
        (init.headers.get('Authorization') ?? '').includes('AT1')
          ? new Response(POLICY_BODY, { status: 400 })
          : new Response('forbidden quota', { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    // ⚠️ 绝不能是 AUTH（那会被客户端吞成「API 密钥无效」）。
    expect((error as LlmError).failure.code).not.toBe('AUTH')
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    expect((error as LlmError).message).toContain('安全策略')
  })

  it('额度限流（6004）不因文案含「请求量饱和」被误判为模型饱和（2026-10-17 对抗审计）', async () => {
    // ⚠️ `isModelSaturationError` 带文案兜底（模型繁忙|请求量饱和|model busy），
    // 而上游额度限流 `6004` 的 msg 完全可能用同样的措辞 ⇒ 被判成**模型级**饱和。
    // 危害是行为分叉：饱和路径「不换号、不写标记」，额度限流必须「换号 + 写标记」。
    //
    // 实测修复前（AT1 400/11140 → AT2 429/6004「请求量饱和」→ AT3 可用）：
    //   发过的凭据 = AT1,AT2,AT2,AT2（AT3 从未被试），最终报「换账号无效」，
    //   且 AT2 的额度限流标记**丢失**。
    const used: string[] = []
    const pool = makeCooldownAwarePool([
      { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
      { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      { id: 'acc-3', credential: makeCredential({ access_token: 'AT3' }) },
    ])
    const quota = JSON.stringify({ code: 6004, msg: '请求量饱和，请稍后再试' })
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: pool,
      fetchImpl: async (_url: unknown, init: { headers: Headers }) => {
        const token = init.headers.get('Authorization') ?? ''
        used.push(token.replace(/[^A-Z0-9]/g, ''))
        if (token.includes('AT1')) return new Response(POLICY_BODY, { status: 400 })
        if (token.includes('AT2')) return new Response(quota, { status: 429 })
        return new Response(OK_SSE_400, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(used).toContain('BAT3')
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    // ⚠️ 额度限流**必须**留下标记（UI「限额重置」徽章与「重测/重置」的唯一依据）。
    // 断言含 acc-2 才锁得住这条 —— 只断言成功的话，误判成饱和同样能成功。
    expect(pool.recorded.map((r) => r.accountId)).toContain('acc-2')
  })

  it('限流换号途中撞 14003 饱和不给该账号写 1 小时限流标记（2026-10-17 对抗审计）', async () => {
    // ⚠️ 与 400 路径那处**同型**的对偶缺陷：限流分支的循环**每轮开头**都给当前
    // 账号记限流标记，而 `isRateLimited` 对 429 无条件返回 true ⇒ 换号途中新撞到
    // 的 14003 饱和会被写成整 1 小时「限额重置」。
    //
    // 本文件下方那条「饱和必须先于限流判定，否则整池锁死」的守卫只在**循环外**生效，
    // 换号途中的饱和会从记账腿漏过去 —— 同一缺陷的限流路径版本。
    const pool = makeCooldownAwarePool([
      { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
      { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      { id: 'acc-3', credential: makeCredential({ access_token: 'AT3' }) },
    ])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: pool,
      fetchImpl: async (_url: unknown, init: { headers: Headers }) => {
        const token = init.headers.get('Authorization') ?? ''
        if (token.includes('AT1')) return new Response(JSON.stringify({ code: 14002, msg: 'rate limited' }), { status: 429 })
        if (token.includes('AT2')) return new Response(JSON.stringify({ code: 14003, msg: 'model busy' }), { status: 429 })
        return new Response(OK_SSE_400, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    await collectChunks(adapter, streamOptions).catch(() => undefined)
    // acc-1 是真额度限流（该有标记）；acc-2 是模型饱和（**绝不该有**）。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acc-1'])
  })

  it('安全策略拦截在换号途中被剔除：换到可用账号即成功', async () => {
    // 本用例对应真实故障场景：池首账号被安全策略拦下，池尾账号可用。
    // 修复前「不换号」会让这次请求必然失败（正是用户连续多轮失败的原因）。
    const safety = JSON.stringify({ code: 11140, msg: 'request illegal' })
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      // AT1 → 安全策略拦截；AT2 → 正常 SSE。
      fetchImpl: async (_url: unknown, init: { headers: Headers }) =>
        (init.headers.get('Authorization') ?? '').includes('AT1')
          ? new Response(safety, { status: 403 })
          : new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    // 换到 acc-2 后成功产出内容，而不是抛错。
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('换号途中撞上的安全策略同样报专门的提示（不混入其他 403 文案）', async () => {
    const safety = JSON.stringify({ code: 11140, msg: 'request illegal' })
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      // 首发 401（真认证失败）→ 换号后拿到 403 安全策略拦截。
      fetchImpl: async (_url: unknown, init: { headers: Headers }) =>
        (init.headers.get('Authorization') ?? '').includes('AT1')
          ? new Response('unauthorized', { status: 401 })
          : new Response(safety, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    // 走的是安全策略专用文案（指向账号），而不是泛化的「所有账号均被拒绝」。
    expect((error as LlmError).message).toContain('安全策略')
    // ⚠️ 文案里的 HTTP 状态必须是**拦截那一次**的 403，而不是首发的 401 ——
    // 早先这里传的是首发的 authStatus，「HTTP 401」会把排查引向「token 过期」，
    // 而实际被拦的是换号后的那个账号（它回的是 403）。
    expect((error as LlmError).message).toContain('HTTP 403')
    expect((error as LlmError).message).not.toContain('HTTP 401')
  })

  it('错误提示只取服务端 displayMsg.zh，不倾倒整段 JSON 原文', async () => {
    // 真实缺陷（2026-09-27 用户报障）：腾讯系用 `msg` + `displayMsg.{zh,en}`
    // 报错，**没有**标准 `message` 字段。早期 errorDetail 只读 `data.message`，
    // 于是全部落空、退化成返回整段 JSON —— 实测把 291 字符的原始报文糊进提示，
    // 而服务端早已备好中文说明，被白白埋掉。
    const raw = JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      requestId: 'b1fd90ae-0c5f-45b6-9209-002f3ab3c4a3',
      displayMsg: {
        en: 'The content did not pass the safety review. Please adjust and retry.',
        zh: '内容未通过安全审核，请调整后重试。',
        'zh-hant': '內容未通過安全審核，請調整後重試。',
      },
      actions: ['SUBMIT_FEEDBACK', 'COPY_ERROR', 'EDIT_INPUT'],
    })
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      // 两个账号都被拦 → 走到「全部账号均被安全策略拦截」这条报错路径。
      fetchImpl: async () => new Response(raw, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    const message = (error as LlmError).message
    // 服务端的中文说明必须**出现**（此前被丢弃）。
    expect(message).toContain('内容未通过安全审核')
    // 原始 JSON 的噪声字段不应被倾倒进来。
    expect(message).not.toContain('SUBMIT_FEEDBACK')
    expect(message).not.toContain('zh-hant')
    expect(message).not.toContain('requestId')
  })

  it('401 换号不会无限循环：每个账号最多试一次', async () => {
    let calls = 0
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async () => { calls++; return new Response('unauthorized', { status: 401 }) },
    })
    await expect(collectChunks(adapter, streamOptions)).rejects.toBeInstanceOf(LlmError)
    // AT1（首发）+ 刷新后重试（无新凭据则不发）+ AT1/AT2 各一次换号尝试
    expect(calls).toBeLessThanOrEqual(4)
  })

  it('换号途中遇到非认证类错误时交给既有分类逻辑，而不是报 AUTH', async () => {
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('未配置凭据，请先登录') },
      accountPool: makePool([
        { id: 'acc-1', credential: makeCredential({ access_token: 'AT1' }) },
        { id: 'acc-2', credential: makeCredential({ access_token: 'AT2' }) },
      ]),
      fetchImpl: async (_url: unknown, init: { headers: Headers }) =>
        (init.headers.get('Authorization') ?? '').includes('AT1')
          ? new Response('unauthorized', { status: 401 })
          : new Response('{"error":{"message":"boom"}}', { status: 500 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('SERVER')
  })

  it('stream maps HTTP 429 to RATE_LIMIT and 5xx to SERVER', async () => {    for (const [status, code] of [[429, 'RATE_LIMIT'], [500, 'SERVER'], [400, 'INVALID_REQUEST']] as const) {
      const adapter = makeAdapter({ fetchImpl: async () => new Response(`{"error":{"message":"boom"}}`, { status }) })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).failure.code).toBe(code)
    }
  })

  /**
   * 上下文超限必须归为 CONTEXT_WINDOW_EXCEEDED，而不是笼统的 INVALID_REQUEST。
   *
   * 为什么这条错误码至关重要：DSH 的自动压缩恢复（dsh-compaction-basic）监听
   * `agent/request-error`，**只对 `failure.code === CONTEXT_WINDOW_EXCEEDED`**
   * 的失败压缩上下文并重试。若标成 INVALID_REQUEST，长会话一旦越过窗口就会把
   * 裸错误直接抛给用户，用户看到的是：
   *
   *   buddy: {"code":11115,"msg":"prompt is too long: 1061554 tokens > 1048576 maximum", ...}
   *
   * 这正是用户报障的现象（国际版 WorkBuddy，deepseek-v4.1-flash）。CodeArts
   * 适配器早已做此归类（llm-adapter.ts 的 httpErrorCode），buddy 此前遗漏。
   *
   * 报文取自真实报障原文：`msg` 为「prompt is too long」措辞、
   * `extError.code` 为 `context_length_exceeded`，两者都应被识别。
   */
  it('stream 把上下文超限的 400 归为 CONTEXT_WINDOW_EXCEEDED（触发自动压缩）', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => new Response(CONTEXT_OVERFLOW_BODY, { status: 400 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // 错误消息仍须保留可读原因（用户/日志据此定位），不能被错误码改写掉
    expect((error as LlmError).message).toContain('prompt is too long')
  })

  it('上下文超限的 400 不被误判为限流（不触发账号切换）', async () => {
    // 区分「窗口超限」与「用量限流」很重要：前者换账号也没用（同样的上下文
    // 会再次超限），必须走压缩；后者才该切换账号。若误判为限流，适配器会白试
    // 一遍所有账号，最后仍以 QUOTA_EXCEEDED 掩盖真实原因。
    //
    // 这里用自包含的 pool 替身（该 describe 内的 makePool 定义在另一块中）。
    const recorded: Array<{ accountId: string }> = []
    const sentTokens: string[] = []
    const pool = {
      async findAccountIdByCredential() { return 'acct-1' },
      async updateModelRateLimit(accountId: string) { recorded.push({ accountId }) },
      async getAvailableAccount() {
        return { entry: { id: 'acct-2' }, credential: makeCredential({ access_token: 'AT2' }) }
      },
    }
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        sentTokens.push(auth.replace('Bearer ', ''))
        return new Response(CONTEXT_OVERFLOW_BODY, { status: 400 })
      },
    })

    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)

    expect((error as LlmError).failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // 只发了当前账号：没有因误判限流而去轮询其余账号
    expect(sentTokens).toEqual(['AT1'])
    // 也不应写入任何限流标记
    expect(recorded).toEqual([])
  })

  /**
   * 对照：同为中国版/国际版常见的 400 错误，只要不含超限措辞，仍须是
   * INVALID_REQUEST —— 避免为了修上下文超限而把所有 400 都当成可压缩错误
   * （那会让真正的请求错误被反复压缩重试，浪费额度且掩盖原因）。
   */
  it('普通 400（模型不存在 / 参数非法）仍归为 INVALID_REQUEST', async () => {
    const cases = [
      '{"error":{"message":"model not found"}}',
      '{"code":11102,"msg":"service info not found"}',
      '{"error":{"type":"invalid_request_error","message":"unsupported parameter"}}',
    ]
    for (const body of cases) {
      const adapter = makeAdapter({ fetchImpl: async () => new Response(body, { status: 400 }) })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      expect((error as LlmError).failure.code, body).toBe('INVALID_REQUEST')
    }
  })

  /**
   * 判定必须看**完整 body**，不能只看 errorDetail 归一化后的短文本。
   *
   * `errorDetail` 在能提取到 `error.*` / `data.message` 时会返回拼接文本，
   * 从而丢掉 `extError` / `displayMsg`。若把判定建立在它之上，服务端一旦
   * 把 `msg` 改名成 `message`（或补上 `error.code`），`extError.code =
   * context_length_exceeded` 这个最强信号就会被丢弃，超限随即漏判成
   * INVALID_REQUEST、自动压缩再次失效。
   *
   * 这里构造「error.code 为字符串 + msg 为超限措辞」的变体：errorDetail 会
   * 返回 `"some_error prompt is too long: ..."`（丢失 extError），但完整 body
   * 仍含 `context_length_exceeded`，故必须仍判为超限。
   */
  it('判定基于完整 body：extError 在 errorDetail 中被丢弃时仍能识别超限', async () => {
    const variant = JSON.stringify({
      error: { code: 'some_error', message: 'prompt is too long: 1061554 tokens > 1048576 maximum' },
      extError: { code: 'context_length_exceeded' },
    })
    const adapter = makeAdapter({ fetchImpl: async () => new Response(variant, { status: 400 }) })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('stream sends the required CodeBuddy headers', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    expect(seen!.get('Authorization')).toBe('Bearer AT')
    expect(seen!.get('X-Domain')).toBe('copilot.tencent.com')
    expect(seen!.get('X-Product-Code')).toBe('codebuddy')
    expect(seen!.get('User-Agent')).toBe('CodeBuddyIDE/1.106.1')
  })

  /**
   * ⚠️ `X-Conversation-*` 三头**三枚都发**（issue IKM73W 2026-10-16）。
   *
   * ## 背景
   * workbuddy 渠道曾整条报 `conversation id missing`（上游 HTTP 400 /
   * code 11128），当时据此认为「缺三头即被渠道校验拒绝」。
   *
   * ## 🔴⚠️ 那条外部事实**已被同账号真机复测推翻**（2026-10-16，约 90 次请求）
   * - 逐枚消融适配器构造的 **14 枚头，全部仍 200**（含这三枚）；
   * - 逐级剥到「连 UA / 鉴权头 / 身份头都不发」仍 200；
   * - 6 模型 × 4 请求形状 = 48 格，三头与响应状态**零关联**；
   * - `conversation id missing` **零次复现**（同批复现了另两句 11128）。
   * 上游对三头的真实用法是**回显**成 completion id 的种子（回包 `"id"` 前缀
   * 3/3 命中所发值），**不作准入判据**。
   *
   * ## 本组用例能锁什么、不能锁什么
   * ✅ 锁：我们确实发出三枚头、都非空、形态正确、逐请求唯一。
   * ❌ **锁不住**：三头是否**功能必需**（那是外部事实，已被证伪）。
   * ⇒ 本组用例是**防误删 / 防形态退化**的护栏，**不是**功能回归防线。
   * 变异验证的判据即「删掉任一条 `headers.set` ⇒ 三条用例变红」。
   *
   * ⚠️ 逐头 `it.each` 而不是只断言「某串里含某名」：后者删掉另两个头仍可能绿。
   */
  it.each([
    'X-Conversation-ID',
    'X-Conversation-Request-ID',
    'X-Conversation-Message-ID',
  ])('stream 必发 %s（三枚都发，防误删）', async (headerName) => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    const value = seen!.get(headerName)
    // 必须存在且非空：与本文件 `X-Domain` 那条空串缺陷同型（空值等于没发）。
    expect(value, `${headerName} 未发出或为空`).toBeTruthy()
    expect(value!.length).toBeGreaterThan(0)
  })

  /**
   * workbuddy 路径同样发齐三头 —— 且**不需要**按产品分支。
   *
   * 实测（2026-10-16 复核）：buddy 中国站带上这三头仍 200（无害），故实现里
   * 刻意**无条件**发送。本用例确认 workbuddy 这条产品路径上三头齐备；与上一条
   * 合起来锁住「两条产品路径都不缺头」（若有人日后加 `product.id` 分支，两条
   * 里必有一条变红）。
   */
  it('workbuddy 路径同样发齐 X-Conversation-* 三头', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      product: WORKBUDDY,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    expect(seen!.get('X-Conversation-ID')).toBeTruthy()
    expect(seen!.get('X-Conversation-Request-ID')).toBeTruthy()
    expect(seen!.get('X-Conversation-Message-ID')).toBeTruthy()
  })

  /**
   * 三头**同值**，且**不得**复用 `prompt_cache_key` 的 `sessionId`。
   *
   * 理由（防「顺手复用」型改动）：`sessionId` 是前缀缓存的分桶键，其真实生命周期
   * 是**插件进程 / fiber 级**（`registerBuddyLlm` 每次 `apply()` 造一个 adapter，
   * 它服务所有会话、所有账号）—— 与三头这种**逐请求一次性 id** 是两件事。
   * 本仓库登记过多次「两处语义不同的东西共用一个值」导致的漂移缺陷。
   *
   * ⚠️ 本用例**锁不住「三头是准入必需」那条外部事实** —— 该结论已被 2026-10-16
   * 真机复测推翻（逐枚消融 14 枚头全部仍 200）。本组用例锁的是「我们确实发出
   * 三头且形态正确」，目的是**防误删**与**防形态退化**，不是防功能回退。
   */
  it('X-Conversation-* 三头同值，且不复用 prompt_cache_key 的 sessionId', async () => {
    let seen: Headers | undefined
    let body: Record<string, unknown> | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    const id = seen!.get('X-Conversation-ID')
    expect(seen!.get('X-Conversation-Request-ID')).toBe(id)
    expect(seen!.get('X-Conversation-Message-ID')).toBe(id)
    // ⚠️ 先断言 `prompt_cache_key` **确实是个非空字符串**，否则 `not.toBe` 会
    // 退化成「随机串 vs undefined」那种概率性恒真（对抗审计实测：删掉 body 的
    // prompt_cache_key 后本用例仍全绿）。
    // ⚠️ 刻意**不**断言它的格式：`sessionId` 与官方 `X-Conversation-*` 形态
    // 毫无关系（它是本地前缀缓存的分桶键），将来有人把它改成带横线 UUID
    // 完全合理 —— 在这里锁 32 位会**假红**。格式归三头那条形态守卫管。
    expect(typeof body!.prompt_cache_key).toBe('string')
    expect(String(body!.prompt_cache_key).length).toBeGreaterThan(0)
    expect(id).not.toBe(body!.prompt_cache_key)
  })

  /**
   * 三头取值的**形态**：32 位无横线小写十六进制。
   *
   * 为什么锁形态（实测里上游并不校验值）：上游把三头**回显**成 completion id 的
   * 种子（实测回包 `"id"` 前缀 3/3 命中，填 `abc-123` 则直接回 `"id":"abc-123"`）
   * ⇒ 形态脏值会**直接流进上游的 id 字段与后台归因**，故按官方客户端形态
   * （`docs/workbuddy-native-search-research.md` §4.4 的「32 位无横线 uuid」）取。
   *
   * ⚠️ 变异验证：把值改成常量 `'fixed-conversation-id-0000'` 或 `String(undefined)`
   * ⇒ 本用例变红（这两条在补本用例前是**无牙**的，177 全绿）。
   */
  it('三头取值为 32 位无横线十六进制（脏值会流进上游回显的 id）', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    expect(seen!.get('X-Conversation-ID')).toMatch(/^[0-9a-f]{32}$/)
  })

  /**
   * 三头是**逐请求**一次性 id —— **同一个 adapter** 连调两次 `stream()` 必须拿到**不同**值。
   *
   * ## ⚠️ 为什么必须是同一个 adapter（第二轮对抗审计打穿过我上一版）
   * 上一版这条用例**每轮新建一个 adapter**（`for` 里 `makeAdapter(...)`），
   * 于是它实际锁的是「**每 adapter** 一个值」而不是「逐请求」：
   * 实测把实现改成「构造器里生成一次、存成实例字段」⇒ 上一版**179 全绿（无牙）**。
   * 它只能区分「全局单例 vs 非全局」，分不出「逐 adapter」与「逐请求」。
   * ⇒ 现在固定成**一个 adapter**，两次调用共用它。
   *
   * ⚠️ 它锁的是**现状**（逐请求），而**上游当前的真实语义是会话稳定**
   * （官方 `X-Conversation-ID = context.id`），本实现与之**相反**。实测上游
   * **不做**跨轮状态机（同一 `prompt_cache_key` 连发三轮、每轮换三头值，3/3 接受），
   * 故当前无害。若将来要按官方对齐改成会话级常量，**这条用例会被迫改**（它会红）
   * —— 那正是本仓库期望的「改语义必须显式面对守卫」。
   *
   * 变异验证：① 改成模块级固定常量 ⇒ 红；② 改成 adapter 实例字段 ⇒ 红（上一版漏的）。
   */
  it('三头是逐请求一次性 id：同一 adapter 两次调用取到不同值', async () => {
    const seenIds: (string | null)[] = []
    // ⚠️ **只建一个** adapter —— 见上方注释（两个 adapter 会让这条守卫无牙）。
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        seenIds.push(new Headers(init?.headers as HeadersInit).get('X-Conversation-ID'))
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    await collectChunks(adapter, streamOptions)
    expect(seenIds).toHaveLength(2)
    expect(seenIds[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(seenIds[1]).toMatch(/^[0-9a-f]{32}$/)
    expect(seenIds[0]).not.toBe(seenIds[1])
  })

  /**
   * 回归：凭据 domain 为**空串**时 X-Domain 必须回退到产品域名。
   *
   * `parseTokenData` → `readStringField` 在字段缺失时返回空串，故这是真实可达
   * 的凭据形态。修复前 `??` 对空串不生效，这里发出的头是空值（已实测复现）。
   *
   * ⚠️ 上一条用例的凭据 domain 是 `'copilot.tencent.com'`（等于产品域名），
   * 对「取谁的值」不敏感，故必须另写两条才能分别锁住空串与优先级两个子问题。
   */
  it('凭据 domain 为空串时 X-Domain 回退到产品域名', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      credential: makeCredential({ domain: '' }),
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    expect(seen!.get('X-Domain')).toBe('copilot.tencent.com')
  })

  /**
   * 回归：X-Domain 以**产品**为准，不跟随凭据里的历史域名。
   *
   * 真实场景——早期 workbuddy 指向中国版 `copilot.tencent.com`，改造为国际版后
   * 旧凭据的 domain 仍是老域名。若 X-Domain 取凭据值，请求会打到
   * `www.workbuddy.ai` 却声明自己属于 `copilot.tencent.com`，身份标识与 baseURL
   * 自相矛盾；且同一账号的**聊天**（本处）与**积分**（`src/credits.ts` 的
   * `checkinHeaders`，早已是「以产品为准」）会声明不同的 X-Domain。
   * 本用例与 `tests/unit/credits.spec.ts` 的「凭据 domain 与产品不符时，以产品
   * 配置为准」成对，锁死两条链路判定一致。
   */
  it('凭据 domain 与产品不符时，X-Domain 以产品配置为准', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      product: WORKBUDDY,
      credential: makeCredential({ domain: 'copilot.tencent.com' }),
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    expect(seen!.get('X-Domain')).toBe('www.workbuddy.ai')
  })

  /** 抓取一次 stream() 实际发出的请求体；overrides 同时用于 adapter 与请求。 */
  async function captureBody(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {}
    const adapter = makeAdapter({
      ...overrides,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      ...overrides,
    } as never)
    return body
  }

  // 实测：reasoning_effort=low/high/max 会显著改变返回的 reasoning_content
  // 长度，是服务端真实生效的参数。
  it('stream forwards a supported reasoning effort as reasoning_effort', async () => {
    expect(await captureBody({ reasoningEffort: 'max' })).toMatchObject({ reasoning_effort: 'max' })
  })

  // 实测（2026-09，直连 workbuddy 国际/中国 UA 与 codebuddy 三站点对照）：
  //   - 裸请求（无 reasoning_effort、无 thinking）→ reasoning_content 恒为 0；
  //   - 仅 reasoning_effort:high → 返回思考；仅 thinking:{type:'enabled'} → 仍为 0；
  //   - 两者都带 → 返回思考。
  // 即 reasoning_effort 才是真正开关，thinking 单独不生效（保留以对齐官方形态）。
  it('stream enables thinking for deepseek models', async () => {
    expect(await captureBody()).toMatchObject({ thinking: { type: 'enabled' } })
  })

  // 真实缺陷回归（会话 session-03b4d1f2 "测试思考过程显示"）：workbuddy 的
  // deepseek-v4.1-flash 未声明 defaultReasoningEffort，composer 因而未预选档位，
  // 请求体里只剩 thinking 而没有 reasoning_effort → 上游按不思考应答 → UI 看不到
  // 思考块。适配器必须在此情形补档，保证任何 deepseek 请求都带 reasoning_effort。
  it('stream backfills reasoning_effort for deepseek when none is selected or unsupported', async () => {
    // composer 未选等级（options.reasoningEffort === undefined）时补默认档。
    expect(await captureBody()).toMatchObject({ reasoning_effort: 'high' })
    // 会话历史里可能残留切换模型前的旧等级（如 glm-5.2 的 xhigh），
    // 不被该模型支持时也要补成合法档位，而非丢弃导致静默不思考。
    const body = await captureBody({ reasoningEffort: 'xhigh' })
    expect(body).toHaveProperty('reasoning_effort')
    expect(['low', 'high', 'max']).toContain(body.reasoning_effort)
  })

  it('stream does not enable thinking or backfill effort for non-deepseek models', async () => {
    // glm 等其他模型走各自 thinkingFormat（默认开或 enable_thinking），
    // 不注入 thinking 开关、不补默认档。
    const body = await captureBody({ model: 'glm-5.2' })
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  // CodeBuddy 只接受 OpenAI 多模态 parts 形态的图片；
  // {type:'image'} 会被服务端以 `unsupported content type ... image` 400。
  it('stream sends user images as inline image_url parts', async () => {
    const body = await captureBody({
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', attachment: { attachmentId: 'att-1' } },
        ],
      }],
    })
    const user = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === 'user')!
    // ⚠️ **不按 parts 顺序断言**（issue IKLIFH 的 `0dd27ca` 起顺序为「图在前」）：
    // 两种顺序上游都能看到，顺序不是契约。
    const parts = user.content as Array<Record<string, unknown>>
    expect(parts).toHaveLength(2)
    expect(parts).toContainEqual({ type: 'text', text: 'what is this?' })
    expect(parts).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } })
  })

  it('stream rejects images for a model that declares text-only', async () => {
    // 用无兜底表的产品，使远端声明的 supportsImages=false 直接生效
    // （兜底表会充当白名单）。模型 id 用兜底表之外的临时值。
    const textOnly = 'text-only-probe'
    const adapter = makeAdapter({
      product: { ...CODEBUDDY, fallbackModels: undefined } as never,
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      fetchRemoteModels: async () => [{ id: textOnly, name: 'M', supportsImages: false }],
      fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
    })
    const error = await collectChunks(adapter, {
      model: textOnly,
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
  })

  it('stream keeps image-free requests on the plain string content path', async () => {
    // 无图请求的线上格式必须不变，否则整体破坏前缀缓存命中。
    const body = await captureBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
    const user = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === 'user')!
    expect(user.content).toBe('hello')
  })

  // 「静默丢图」回归护栏：readImage 表示读不到时，必须抛错。
  // 旧实现会 `continue` 丢掉整张图，线上请求退化成纯文本，
  // 模型只能答「我看不到图片」，用户拿不到任何错误原因。
  it('stream fails loudly when readImage reports it cannot read the bytes', async () => {
    let body: Record<string, unknown> | undefined
    const adapter = makeAdapter({
      readImage: async () => undefined,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse('data: [DONE]\n\n')
      },
    })
    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', attachment: { attachmentId: 'att-missing' } },
        ],
      }],
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
    // 关键：请求根本没有发出，图片不可能被静默丢弃。
    expect(body).toBeUndefined()
  })

  it('stream preserves the cause when readImage throws', async () => {
    const cause = new Error('attachment object is gone')
    const adapter = makeAdapter({
      readImage: async () => { throw cause },
      fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
    })
    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }] }],
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
    expect((error as LlmError).message).toContain('attachment object is gone')
  })
})

describe('BuddyAdapter stream parsing', () => {
  it('emits text and reasoning on separate blocks', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.find((c) => c.type === 'block-start' && c.blockType === 'reasoning')).toBeDefined()
    expect(chunks.find((c) => c.type === 'block-start' && c.blockType === 'text')).toBeDefined()
    const text = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'text')
    expect(text[0]).toMatchObject({ block: { type: 'text', text: 'hello world' } })
    const reasoning = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'reasoning')
    expect(reasoning[0]).toMatchObject({ block: { type: 'reasoning', text: 'thinking...' } })
  })

  it('reports stop when no tool calls occur', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  // 回归：CodeBuddy 流式响应仅首个分片携带真实 id（chatcmpl-tool-xxx），
  // 后续参数分片只有 index。若按 index 生成 call_{index} 而非沿用真实 id，
  // 跨轮（每轮都从 call_0 重新编号）会导致 tool/result 配对到错误的历史条目。
  it('keeps one stable id across argument fragments of the same tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-abc","type":"function","function":{"name":"shell","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\": \\"ls\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
    expect(deltas).not.toHaveLength(0)
    // 所有分片（含首个空参数分片）都必须使用后端签发的真实 id。
    for (const delta of deltas) {
      expect((delta as { id: string }).id).toBe('chatcmpl-tool-abc')
    }
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({
      block: { type: 'tool-call', id: 'chatcmpl-tool-abc', name: 'shell', arguments: '{"command": "ls"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  // 回归：并行工具调用各自拥有独立 id，参数分片不得混淆到同一个工具上。
  it('distinguishes parallel tool calls by id', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"shell","arguments":""}},{"index":1,"id":"chatcmpl-tool-2","function":{"name":"file_read","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}},{"index":1,"function":{"arguments":"{\\"b\\":2}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(ends).toHaveLength(2)
    const byId = new Map(ends.map((c) => [(c as { block: { id: string } }).block.id, c]))
    expect(byId.get('chatcmpl-tool-1')).toMatchObject({ block: { name: 'shell', arguments: '{"a":1}' } })
    expect(byId.get('chatcmpl-tool-2')).toMatchObject({ block: { name: 'file_read', arguments: '{"b":2}' } })
  })

  // 回归：CodeBuddy 的参数续分片会带回 `"function":{"name":""}`。空串不是
  // undefined，原先的 `!== undefined` 判断会用它覆盖首个分片解析出的真实
  // 工具名，最终 block-end 输出 name:""，harness 报 `unknown tool ""`。
  it('ignores an empty function name on argument continuation fragments', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","type":"function","function":{"name":"shell","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"{\\"command\\":\\"ls -"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"la\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({
      block: { type: 'tool-call', id: 'chatcmpl-tool-1', name: 'shell', arguments: '{"command":"ls -la"}' },
    })
    // 续分片的空名不得传播到 delta 上。
    for (const delta of chunks.filter((c) => c.type === 'tool-call-delta')) {
      expect((delta as { name?: string }).name).toBe('shell')
    }
  })

  it('falls back to call_{index} when the backend sends no id', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"shell","arguments":"{}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end[0]).toMatchObject({ block: { type: 'tool-call', id: 'call_0', name: 'shell' } })
  })

  // 'length'（输出被 max_tokens 截断）必须优先于 tool_calls：否则 harness 会执行
  // 被截断的非法 JSON 参数，并把脏参数持久化进会话历史。
  it('reports max-tokens over tool-calls when the stream is truncated', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"write","arguments":"{\\"content\\": \\"trunca"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('surfaces SSE-embedded errors as SERVER failures', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"error":{"message":"internal error"}}\n\ndata: [DONE]\n\n'),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(String((error as LlmError).message)).toContain('internal error')
  })

  // 回归：无参数工具（如 list_dir / get_cwd）只下发一个空的 arguments
  // 分片，拼接结果为空串。harness 解析时报
  // `invalid arguments: "arguments" must be an object`，会话卡在错误态，
  // web 端发送按钮置灰、后续指令无响应。空参数必须归一化为 {}。
  it('normalizes empty arguments of a zero-parameter tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"list_dir","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ block: { name: 'list_dir', arguments: '{}' } })
  })

  // 回归：SSE 流被网关掐断（无 finish_reason、无 [DONE]）时，工具参数是
  // 半截 JSON。原实现把它报告为 tool-calls，harness 执行不完整参数报
  // INVALID_ARGS 并把脏参数持久化进历史。此时应报告 max-tokens，让 dsh
  // 丢弃残缺调用并触发续写。
  it('reports max-tokens instead of executing a half-streamed tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"write","arguments":"{\\"content\\": \\"trunca"}}]}}]}',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
    // 残缺参数必须原样保留，交由 max-tokens 触发重试。绝不能补成 {}——
    // 那会让 harness 报 `missing required property` 而非重试。
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end[0]!.block.arguments).not.toBe('{}')
  })

  // 回归（核心）：hy4-preview 并行下发多个工具调用时会丢参数分片，两个调用
  // 都只剩残缺片段（实测 session-23851745 turn1 step4）。此前适配器把残缺
  // JSON 补成 {}，伪造出合法外观，harness 执行时报
  // `missing required property "file_path"`，模型收到莫名其妙的参数错误并
  // 陷入重试循环。现在必须判定为截断、报告 max-tokens 触发 dsh 重试。
  it('reports max-tokens when parallel tool calls lose argument fragments', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        // 两个并行 read：参数开头的 `{"file_path": "D:\\...` 前缀丢失。
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool-a","function":{"name":"read","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"\\\\deveco-code-rust\\\\cr"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"ates\\\\deveco"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"tool-b","function":{"name":"read","arguments":"o-llm\\\\src\\\\provider\\\\buddy.rs\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    // 后端声明 finish_reason=tool_calls，但参数残缺——必须覆盖为 max-tokens，
    // 否则 harness 会执行这两个缺参调用。
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  // 回归：后端掐断连接但既不发数据也不关连接（半开连接）时，裸
  // reader.read() 永久挂起——generator 不返回，harness 步骤既不出结果
  // 也不报错，会话永远停在"运行中"，web 端发送按钮置灰、"继续"无响应。
  // 必须主动超时并抛可重试的 TIMEOUT，把控制权交还给用户。
  it('fails fast with a retryable TIMEOUT when the stream stalls', async () => {
    // 默认 firstTokenTimeout 为 120s，测试里缩短到 20ms 触发超时路径。
    // 环境变量在每次 stream() 调用时读取，因此这里设置即时生效。
    process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS = '20'
    try {
      const adapter = makeAdapter({
        fetchImpl: async () => new Response(
          new ReadableStream<Uint8Array>({ start() { /* 永不产出数据 */ } }),
          { status: 200 },
        ),
      })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).failure.code).toBe('TIMEOUT')
    } finally {
      delete process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS
    }
  })

  it('skips malformed SSE lines', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: not-json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('BuddyAdapter message serialization', () => {
  it('sends assistant reasoning_content and null content for tool-only turns', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'reasoning', text: 'let me check' },
          { type: 'tool-call', id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
        ] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>> }
    // ⚠️ 首条**不再是** assistant：以 assistant 开头的 wire 会被 `space-bunny`
    // 判 400/11148「工具记录不完整」（实测；见下面「wire 首条不得是 assistant」段），
    // 适配器因此在首位补了一条最小 system。这里按**角色**取而不是按位置 ——
    // 位置断言恰恰是把「首条是 assistant」误当成契约的地方。
    expect(payload.messages[0]?.role).toBe('system')
    const assistant = payload.messages.find((m) => m.role === 'assistant') as Record<string, unknown>
    expect(assistant).toBeDefined()
    // 正文为空且带 tool_calls 时 content 必须为 null（对齐 openai_chat.rs）。
    expect(assistant.content).toBeNull()
    // 推理模型要求 assistant 消息始终携带 reasoning_content 字段。
    expect(assistant.reasoning_content).toBe('let me check')
    expect(assistant.tool_calls).toMatchObject([{ id: 'call_1', type: 'function', function: { name: 'shell' } }])

    // 工具结果展开为独立的 role:'tool' 消息，且**紧跟**在 assistant 之后
    // （按角色取而非按下标 —— 首位现在可能是适配器补的 system）。
    const assistantIndex = payload.messages.findIndex((m) => m.role === 'assistant')
    const tool = payload.messages[assistantIndex + 1]
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'file.txt' })
  })

  // 回归（严重）：工具执行失败时，assistant 的 tool_calls 会留在会话历史里，
  // 但对应的 tool 结果消息从未写入——形成孤儿 tool_calls。OpenAI 兼容后端
  // 要求带 tool_calls 的 assistant 消息必须紧跟对应 tool 消息，否则每次
  // 请求都 400。由于坏历史被持久化并随每次请求重放，**后续所有消息都会
  // 石沉大海**，整个会话永久报废。适配器是最后一道防线，必须清理。
  it('drops orphan tool_calls that have no tool result', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'user', content: 'list the files' },
        // 助手发起了 Grep 调用，但参数非法导致执行失败，结果从未写回历史。
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'Grep', arguments: '' },
        ] },
        // 用户随后发的消息中没有对应的 tool-result。
        { role: 'user', content: 'continue' },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    // 孤儿 tool_calls 必须被剥离，否则后端永久 400、会话报废。
    expect(assistant!.tool_calls).toBeUndefined()
  })

  // 回归：只有部分工具调用拿到结果时同样不合法——后端要求 tool_calls 中
  // 的每一个 id 都有对应 tool 消息，缺一个就整体拒绝。
  it('drops a whole tool_calls batch when only part of it has results', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: 'call_2', name: 'read', arguments: '{"path":"b"}' },
        ] },
        // 只有 call_1 拿到结果；call_2 是孤儿。
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant!.tool_calls).toBeUndefined()
  })

  // 回归：孤儿的 role:'tool' 消息（没有对应的前置 tool_call）同样会被后端
  // 拒绝。assistant 消息被丢弃时可能出现，必须一并清理。
  it('drops orphan tool result messages', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'user', content: 'hi' },
        // 没有任何 assistant tool_call 与之对应。
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'x' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>> }
    expect(payload.messages.some((m) => m.role === 'tool')).toBe(false)
  })

  // 保序回归：正常的工具往返（每个 tool_call 都有结果）必须原样保留，
  // 清理逻辑不得误伤健康会话。
  it('keeps well-formed tool round-trips intact', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: 'call_2', name: 'read', arguments: '{"path":"b"}' },
        ] },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'A' }] },
          { type: 'tool-result', toolCallId: 'call_2', content: [{ type: 'text', text: 'B' }] },
        ] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant!.tool_calls).toHaveLength(2)
    expect(payload.messages.filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  it('sends tools and the system prompt', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }] as never,
      tools: [{ name: 'shell', description: 'run a command', parameters: { type: 'object' } }],
      signal: new AbortController().signal,
    } as never)
    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>>; tools?: unknown[] }
    expect(payload.messages[0]).toMatchObject({ role: 'system', content: 'You are helpful' })
    expect(payload.tools).toMatchObject([{ type: 'function', function: { name: 'shell' } }])
  })
})

/** 收集流中所有 chunk；流抛错时 reject。 */
async function collectChunks(adapter: BuddyAdapter, options: never): Promise<Array<Record<string, any>>> {
  const chunks: Array<Record<string, any>> = []
  for await (const chunk of adapter.stream(options as never)) {
    chunks.push(chunk as unknown as Record<string, any>)
  }
  return chunks
}

/**
 * 账号池限流切换。
 *
 * 覆盖的关键行为：一个账号触发用量限制后，应逐个尝试其余可用账号，
 * **每个失败账号都要记录其限流重置时间**（UI 据此展示限流标记），
 * 只有真正试完全部候选才报"所有账号均受限"。此前实现只试一个账号
 * 就下结论，导致"UI 上还有未限流账号，对话却报全部受限"。
 */
describe('BuddyAdapter 账号池限流切换', () => {
  /** 构造 6004 频率限制响应体。resetAt 用远未来时间，避免测试随时钟漂移。 */
  function rateLimitBody(): string {
    return JSON.stringify({
      code: 6004,
      msg: '您的使用量已超出频率限制，将在 2099-12-31 23:59:59 UTC+8 重置，您也可以切换其他模型继续使用。',
    })
  }

  /**
   * 国际版（WorkBuddy）英文 6004 响应体 —— 用户报障原文。
   *
   * 与 {@link rateLimitBody} 的唯一差别是语言（以及句式）。两者都必须能
   * 触发账号切换：服务端对同一业务码返回哪种语言，取决于请求落在哪个区域。
   */
  function intlRateLimitBody(): string {
    return JSON.stringify({
      code: 6004,
      msg: "usage exceeds frequency limit, but don't worry, your usage will reset at "
        + '2099-12-31 23:59:59 UTC+8, alternatively, you can switch to the other models to continue using it.',
      requestId: 'ffb5bd97-2036-48a0-baba-a56c6ab13c9c',
    })
  }

  /**
   * 记录 updateModelRateLimit / getAvailableAccount 调用的轻量 AccountPool 替身。
   * @param current - 会话开始时就已启用的当前账号（token 与 resolveCredential 一致）
   * @param candidates - 切换时按顺序返回的候选账号
   */
  function makePool(
    current: { id: string; token: string },
    candidates: Array<{ id: string; token: string }>,
  ) {
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const known = [current, ...candidates]
    const queue = [...candidates]
    return {
      recorded,
      /** 适配器用凭据内容反查账号 id。 */
      async findAccountIdByCredential(_provider: string, identity: string) {
        return known.find((a) => a.token === identity)?.id ?? ''
      },
      async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      async getAvailableAccount() {
        const next = queue.shift()
        if (next === undefined) return null
        return { entry: { id: next.id }, credential: makeCredential({ access_token: next.token }) }
      },
    }
  }

  it('逐个尝试所有账号，每个失败账号都被记录限流', async () => {
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        // AT1 与 AT2 都限流，AT3 成功 —— 三个账号各试一次
        if (token === 'AT3') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        return new Response(rateLimitBody(), { status: 400 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 三个账号都被尝试过，最终由 AT3 成功返回内容
    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 关键断言：失败的两个账号都被记录了限流时间（UI 才能显示标记）
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    expect(pool.recorded.every((r) => r.modelId === DEFAULT_MODEL)).toBe(true)
    expect(pool.recorded.every((r) => r.resetAtMs > Date.now())).toBe(true)
  })

  /**
   * 回归：**空体 429** 必须同样触发换号，并写入限流标记。
   *
   * ## 真实缺陷（用户报障）
   *
   * 「账号池里明明还有可用账号，插件却直接报错、也不换号」——本可自愈的限流变成
   * 硬失败。
   *
   * 根因：`isRateLimited` 原先只接收响应体（判据是业务码 6004 或中英文限流文案），
   * 而服务端（网关 / CDN / 限流中间件）完全可能返回**空体**的 429 —— 两个判据双双
   * 不命中 → 返回 false → `if (accountPool && isRateLimited(errorText))` 这整块被
   * 跳过，既不切账号、也不写 `modelRateLimits`。
   *
   * ⚠️ 本用例的响应体刻意是**空串**：换任何含限流措辞的正文，缺陷就不会暴露
   * （那正是上面那些 6004 用例覆盖不到它的原因）。
   *
   * ⚠️ 空体 429 的另一个必然后果是「没有重置时间可解析」（`parseRateLimitError`
   * 拿不到 `msg`），所以标记必须走**兜底时长**而不是静默跳过 —— 否则 UI 上不会
   * 出现任何限流标记，「重测 / 重置」两条人工解禁路径也就无从操作
   * （与 `lobsterai-adapter` 对纯文本 429 的兜底同一口径）。
   */
  it('空体 429 也触发换号，并写入限流标记（状态码兜底，不只认正文）', async () => {
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [{ id: 'acct-2', token: 'AT2' }],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        // AT1 返回**空体 429**（无线索可判），AT2 成功 —— 必须换到 AT2。
        if (token === 'AT2') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        return new Response('', { status: 429 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 关键断言 1：换号确实发生了。修复前这里只有 ['AT1']，随后直接抛原始 429。
    expect(sentTokens).toEqual(['AT1', 'AT2'])
    // 关键断言 2：最终拿到内容，而不是把 429 抛给用户。
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 关键断言 3：失败账号被写入限流标记（空体无时间可解析 → 用兜底时长），
    // 否则 UI 既不显示限流、用户也无法用「重测 / 重置」人工解禁。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1'])
    expect(pool.recorded[0]!.modelId).toBe(DEFAULT_MODEL)
    expect(pool.recorded[0]!.resetAtMs).toBeGreaterThan(Date.now())
  })

  it('全部账号限流后才报错，且错误码为不可重试的 QUOTA_EXCEEDED', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async () => new Response(rateLimitBody(), { status: 400 }),
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    // 两个账号都被记录了限流
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
  })

  it('切换到的新账号以非限流错误失败时，抛出原始错误而非"全部受限"', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        if (token === 'AT2') {
          return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })
        }
        return new Response(rateLimitBody(), { status: 400 })
      },
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    // 不应被吞成 QUOTA_EXCEEDED —— 这是模型/请求错误，需要如实上报
    expect((error as LlmError).code).not.toBe('QUOTA_EXCEEDED')
    expect((error as LlmError).message).toContain('model not found')
  })

  /**
   * 国际版（WorkBuddy）英文 6004 必须同样触发账号切换。
   *
   * 历史缺陷（用户报障）：限流判定与重置时间解析都只认中文文案，而国际版
   * 返回的是英文 `usage exceeds frequency limit ... reset at <时间> UTC+8`。
   * 于是 `isRateLimited` 恒为 false，适配器**只试了当前账号就抛原始 JSON**
   * （用户看到的正是 `buddy: {"code":6004,...}`），既没切换账号，也没记录
   * 限流标记。国内版返回中文，故该缺陷只在国际版复现。
   *
   * 本用例锁死「英文 6004 → 逐个尝试其余账号 → 成功账号产出内容」的完整链路。
   */
  it('国际版英文 6004 同样触发账号切换，并记录限流标记', async () => {
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      product: WORKBUDDY,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        // AT1 与 AT2 都被英文 6004 拒绝，AT3 成功
        if (token === 'AT3') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        return new Response(intlRateLimitBody(), { status: 400 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 关键断言 1：确实换了账号（旧实现只会发 AT1 一次）
    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    // 关键断言 2：最终拿到内容，而不是把 6004 抛给用户
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 关键断言 3：失败账号都被记录限流（UI 才能显示标记），且用的是真实重置时间
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    expect(pool.recorded.every((r) => r.modelId === DEFAULT_MODEL)).toBe(true)
    // 英文报文里的重置时间是 2099 年（远未来），不能是 fallback 的「1 小时后」
    expect(pool.recorded.every((r) => r.resetAtMs > Date.parse('2090-01-01'))).toBe(true)
  })

  it('国际版英文 6004 全部账号受限时报 QUOTA_EXCEEDED（而非原始 400）', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      product: WORKBUDDY,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        sentTokens.push(auth.replace('Bearer ', ''))
        return new Response(intlRateLimitBody(), { status: 400 })
      },
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    // 关键：错误码必须是不可重试的 QUOTA_EXCEEDED。
    // 旧实现因 HTTP 400 退化成 INVALID_REQUEST，且两个账号都被试过（证明切换生效）
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    expect(sentTokens).toEqual(['AT1', 'AT2'])
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
  })

  /**
   * 限流换号途中撞上安全策略拦截（11140）。
   *
   * ## 真实缺陷（用户报障 2026-09-28「本轮运行失败 · API 密钥无效」）
   *
   * 适配器有**两条**换号路径，早期实现只在认证路径（首发 401/403）里识别
   * 11140；限流路径（首发 429/6004）遇到非限流错误就**直接抛**，于是：
   *
   * - 池里前几个账号恰是被 11140 拦截的坏账号 → 换号在第 1 个坏账号处**中断**，
   *   后面的可用账号永远试不到（实测复刻：中断于 #1，不中断则 #4 即成功）；
   * - 错误码取 `httpErrorCode(403)` = `AUTH` → UI 渲染成「API 密钥无效」，
   *   把用户引向检查密钥，而 7 个 token 实测**全部有效**（2027-09 才过期）。
   *
   * 修复后两条路径语义一致：11140 与 401/403 一样只是「这个账号不可用」，
   * 继续换号；全部试完才报专门的「安全策略」提示。
   */
  function safetyBody(): string {
    return JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      requestId: '5b2240b4-efdf-40e0-94e4-cfee1aa80585',
      displayMsg: { zh: '内容未通过安全审核，请调整后重试。' },
    })
  }

  it('限流换号途中撞上安全策略（11140）时继续换号，换到可用账号即成功', async () => {
    // 复刻真实池顺序：AT1 限流 → AT2 被 11140 拦 → AT3 可用。
    // 修复前换号在 AT2 处中断并抛 AUTH（UI 显示「API 密钥无效」）。
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        if (token === 'AT3') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        // AT1 限流（触发限流换号路径）；AT2 安全策略拦截（HTTP 403）。
        if (token === 'AT1') return new Response(rateLimitBody(), { status: 400 })
        return new Response(safetyBody(), { status: 403 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 关键：三个账号都被试过 —— AT2 的 11140 没有中断换号。
    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // AT1 的限流被记录；AT2 的安全拦截**另记一条冷却**（ !16 之前这里完全不记，
    // 于是那个坏账号下一轮仍排第一、每轮重撞 —— 见 `markPolicyBlockedAccount`）。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    // 两条记录必须能区分开：acct-1 是**服务端给的**重置时刻（2099-12-31），
    // acct-2 是**我们自己定的** 30 分钟冷却。绝不能把 11140 冒充成服务端限流，
    // 也不能复用 `parseRateLimitError` 解析不到时那个 1 小时兜底。
    const rl = pool.recorded.find((r) => r.accountId === 'acct-1')
    const blocked = pool.recorded.find((r) => r.accountId === 'acct-2')
    expect(rl?.resetAtMs).toBeGreaterThan(Date.parse('2090-01-01'))
    expect(Math.abs((blocked?.resetAtMs ?? 0) - policyBlockResetAtMs(Date.now()))).toBeLessThanOrEqual(5_000)
    // 只标该模型（同 qoder 额度那条口径）：11140 是否跨模型无实测依据，
    // 标全部模型会误伤该账号本可用的组合。
    expect(pool.recorded.every((r) => r.modelId === DEFAULT_MODEL)).toBe(true)
  })

  it('限流换号途中撞上安全策略且全部试完：报「安全策略」而非 QUOTA_EXCEEDED', async () => {
    // AT1 限流 → AT2 被 11140 拦 → 候选耗尽。此时真实原因是安全策略拦截
    // （账号不可用），不是「所有账号都限流」，文案必须指向账号。
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        return auth.includes('AT1')
          ? new Response(rateLimitBody(), { status: 400 })
          : new Response(safetyBody(), { status: 403 })
      },
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    // 不得吞成「所有账号均受限」——那会把账号拦截误报成限流。
    expect((error as LlmError).code).not.toBe('QUOTA_EXCEEDED')
    expect((error as LlmError).message).toContain('安全策略')
    expect((error as LlmError).message).toContain('账号')
    // 不再断言「请调整内容后重试」把用户引向错误方向。
    expect((error as LlmError).message).not.toContain('请调整内容')
  })

  it('限流换号途中遇到真正的认证失败（401）同样继续换号', async () => {
    // 与上一条同源：限流路径此前只认「限流」，401/403 都会中断换号。
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        if (token === 'AT3') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        if (token === 'AT1') return new Response(rateLimitBody(), { status: 400 })
        return new Response(JSON.stringify({ error: { message: 'token expired' } }), { status: 401 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
  })

  /**
   * 模型饱和（14003）—— **不换号、不标记、留在本账号退避重试**
   * （真实缺陷，用户报障 2026-10-05）
   *
   * ## 为什么这一组是「行为级」而非「纯函数级」
   *
   * `isModelSaturationError` 的纯函数用例（`buddy-model-saturation.spec.ts`）
   * 只证明判据本身对。但**缺陷的成因是判据顺序**：
   * `14003` **也是 HTTP 429**，而 `isRateLimited` 对 429 无条件为 true ——
   * 只要饱和判定晚于限流分支一步，整池就会被写上 1 小时标记。
   * 所以必须在**真实 `stream()` 调用流**里断言
   * 「`updateModelRateLimit` 一次都没被调用」+「`getAvailableAccount` 没被调用」。
   *
   * 用户症状：第一次用 `buddy/space-bunny` 就报「所有账号均受限」，
   * 而 4 个账号凭据全部有效、服务端实测完全可用。
   */
  describe('模型饱和（14003）不换号、不标记', () => {
    /** 实测原文（4 MB 输入逼出，`scripts/probe-buddy-error-catalog.mjs`）。 */
    function saturationBody(): string {
      return JSON.stringify({
        code: 14003,
        msg: 'too many requests',
        requestId: 'ac2ff1af-6d6b-49b4-8614-14981aed34d8',
        displayMsg: { en: 'Model busy. Please switch models or retry later', zh: '模型繁忙，请换模型或稍后重试' },
        displayTips: {
          en: 'This model is currently saturated. It is not a network issue.',
          zh: '这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。',
        },
        actions: ['SWITCH_MODEL', 'SUBMIT_FEEDBACK', 'RETRY'],
      })
    }

    /**
     * 记录「换号 / 标记」两类副作用的轻量池替身。
     *
     * ⚠️ 与上面 `makePool` 的差别：这里两个副作用各自计数，因为本组用例的
     * **核心断言就是「两者都必须为 0」** —— 只记录标记会漏掉「白换号」
     * （那也是缺陷的一面：换号会让 4 个可用账号被逐个浪费）。
     */
    function makeCountingPool(current: { id: string; token: string }, candidates: Array<{ id: string; token: string }>) {
      const known = [current, ...candidates]
      const queue = [...candidates]
      return {
        marked: [] as Array<{ accountId: string; modelId: string; resetAtMs: number }>,
        rotations: 0,
        async findAccountIdByCredential(_provider: string, identity: string) {
          return known.find((a) => a.token === identity)?.id ?? ''
        },
        async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
          this.marked.push({ accountId, modelId, resetAtMs })
        },
        async getAvailableAccount() {
          this.rotations += 1
          const next = queue.shift()
          if (next === undefined) return null
          return { entry: { id: next.id }, credential: makeCredential({ access_token: next.token }) }
        },
      }
    }

    it('⚠️ 饱和重试用尽后：**不写限流标记**，且**不切换账号**（缺陷本体）', async () => {
      // 退避压到 0 毫秒，让用例毫秒级完成（0 是合法值，见 buddySaturationDelayMs）。
      process.env.DSH_BUDDY_SATURATION_DELAY_MS = '0'
      try {
        const pool = makeCountingPool(
          { id: 'acct-1', token: 'AT1' },
          [{ id: 'acct-2', token: 'AT2' }, { id: 'acct-3', token: 'AT3' }],
        )
        const sentTokens: string[] = []
        const adapter = new BuddyAdapter({
          credentialRef: CREDENTIAL_REF,
          resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
          refresh: async () => {},
          accountPool: pool as never,
          fetchImpl: async (_url, init) => {
            const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
            sentTokens.push(auth.replace('Bearer ', ''))
            // 始终饱和 —— 复刻「所有账号撞同一堵墙」的真实形态。
            return new Response(saturationBody(), { status: 429 })
          },
        })

        let thrown: unknown
        try {
          await collectChunks(adapter, {
            model: 'space-bunny',
            messages: [{ role: 'user', content: 'hi' }] as never,
            signal: new AbortController().signal,
          } as never)
        } catch (error) { thrown = error }

        // ① 关键断言：**一次标记都没写**（写一条就锁 1 小时，写 N 条就锁整池）
        expect(pool.marked, '饱和绝不能写限流标记 —— 那会把整池锁 1 小时').toEqual([])
        // ② 关键断言：**没有换号**（饱和是模型级，换号无益，只会白烧可用账号）
        expect(pool.rotations, '饱和绝不能换号 —— 池里账号会撞同一堵墙').toBe(0)
        // ③ 只在本账号重试：1 次首发 + 2 次退避重试，token 始终是 AT1
        expect(sentTokens).toEqual(['AT1', 'AT1', 'AT1'])
        // ④ 报错必须指向「换模型」这个唯一有效动作，且**不许**说成账号额度受限
        const message = String((thrown as Error | undefined)?.message ?? '')
        expect(message).toContain('请求量饱和')
        expect(message).toContain('换')          // 「请改用其它模型」
        expect(message).toContain('无需重新登录')
        expect(message).not.toContain('所有账号均受限')
        // ⑤ 错误码用 RATE_LIMIT（可重试），不是 QUOTA_EXCEEDED（= 账号额度用尽，确定性）
        expect((thrown as { code?: string } | undefined)?.code).toBe('RATE_LIMIT')
      } finally {
        delete process.env.DSH_BUDDY_SATURATION_DELAY_MS
      }
    })

    it('饱和后**恢复**：重试期间转好则正常产出内容（不换号、不标记）', async () => {
      process.env.DSH_BUDDY_SATURATION_DELAY_MS = '0'
      try {
        const pool = makeCountingPool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
        let attempt = 0
        const adapter = new BuddyAdapter({
          credentialRef: CREDENTIAL_REF,
          resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
          refresh: async () => {},
          accountPool: pool as never,
          fetchImpl: async () => {
            attempt += 1
            // 第 1 发饱和，第 2 发（退避后）已恢复 —— 与真实「瞬时背压」一致。
            if (attempt === 1) return new Response(saturationBody(), { status: 429 })
            return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
          },
        })

        const chunks = await collectChunks(adapter, {
          model: 'space-bunny',
          messages: [{ role: 'user', content: 'hi' }] as never,
          signal: new AbortController().signal,
        } as never)

        expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
        expect(pool.marked).toEqual([])
        expect(pool.rotations).toBe(0)
        expect(attempt).toBe(2)
      } finally {
        delete process.env.DSH_BUDDY_SATURATION_DELAY_MS
      }
    })

    it('⚠️ 额度限流 6004 的既有行为**不许**被本修复改回退（换号 + 标记仍然生效）', async () => {
      // 反向保护：饱和判定若写得太宽，会把这个用例吃掉 —— 那意味着
      // 「账号额度用完」不再换号，用户永远等不到其它可用账号。
      const pool = makeCountingPool(
        { id: 'acct-1', token: 'AT1' },
        [{ id: 'acct-2', token: 'AT2' }],
      )
      const sentTokens: string[] = []
      const adapter = new BuddyAdapter({
        credentialRef: CREDENTIAL_REF,
        resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool as never,
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          const token = auth.replace('Bearer ', '')
          sentTokens.push(token)
          if (token === 'AT2') {
            return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
          }
          return new Response(rateLimitBody(), { status: 429 })
        },
      })

      const chunks = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never)

      // 6004 必须仍然换号，并为失败账号留下标记
      expect(sentTokens).toEqual(['AT1', 'AT2'])
      expect(pool.marked.length).toBeGreaterThan(0)
      expect(pool.marked[0]?.accountId).toBe('acct-1')
      expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    })
  })
})

/** 端点常量供测试断言引用（避免硬编码字符串漂移）。 */
export { CHAT_API_BASE }

describe('产品参数化', () => {
  it('默认构造时 providerInfo 返回 buddy', () => {
    expect(makeAdapter().providerInfo('buddy')).toMatchObject({
      id: 'buddy', name: 'CodeBuddy (腾讯)',
    })
  })

  it('传入 WorkBuddy 配置时 providerInfo 返回 workbuddy', () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
    })
    const info = adapter.providerInfo('workbuddy')
    // DSH 强制校验 info.id === 传入的 provider
    expect(info.id).toBe('workbuddy')
    expect(typeof info.name).toBe('string')
    expect(info.name.length).toBeGreaterThan(0)
  })

  it('WorkBuddy 适配器的 listModels 使用 workbuddy 作为 provider 字段', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
    })
    const models = await adapter.listModels('workbuddy')
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.provider === 'workbuddy')).toBe(true)
  })

  it('WorkBuddy 适配器请求带 X-Product-Code: workbuddy', async () => {
    let productCode: string | null = null
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
      fetchImpl: async (_url, init) => {
        productCode = (init?.headers as Headers).get('X-Product-Code')
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    expect(productCode).toBe('workbuddy')
  })

  /**
   * ⚠️ **真实缺陷**（本轮 e2e 实测发现）：同一个类的错误文案里前缀**混用** ——
   * 12 处硬编码 `buddy:`、7 处用 `${this.product.id}`。于是 WorkBuddy 用户
   * 看到的报错自称「buddy: …」，日志与 UI 都指错产品，排查时容易找错面板
   *（实测原话：`buddy: 对话内容超出模型长度上限，请精简对话或减少附件后重试。`）。
   *
   * 这里对**两个产品**都断言，因为只测写死的那一个就发现不了这种混用 ——
   * 只有对比才看得出前缀没跟着产品走。
   *
   * ⚠️ 边界：本用例只走得到**「非换号路径」的那一处**（无账号池时 `stream()`
   * 在首次请求失败后直接抛）。其余 11 处散在换号重试 / SSE / transport /
   * 附件读取等分支上，逐个造场景代价很高且脆弱 —— 那部分交给下面那条
   * 源码级不变量兜底（已反向验证：本用例对换号路径的变异**抓不到**）。
   */
  it('错误文案的前缀跟随产品（workbuddy 不得自称 buddy）', async () => {
    for (const [product, expected] of [
      [CODEBUDDY, 'buddy'],
      [WORKBUDDY, 'workbuddy'],
    ] as const) {
      const adapter = new BuddyAdapter({
        credentialRef: credentialRef(product.defaultCredentialRef),
        resolveCredential: async () => makeCredential(),
        refresh: async () => {},
        product,
        fetchImpl: async () => new Response(JSON.stringify({ code: 1, msg: 'boom' }), { status: 400 }),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(LlmError)
      expect(
        (error as LlmError).message.startsWith(`${expected}: `),
        `${expected} 的报错前缀错了，实际是：${(error as LlmError).message}`,
      ).toBe(true)
    }
  })

  /**
   * ⚠️ **源码级不变量**：`buddy-adapter.ts` 里**不允许**再出现硬编码的
   * `buddy:` 错误前缀 —— 它必须写成 `${this.product.id}: `。
   *
   * 为什么不能只用行为用例：那 12 处散在「首次请求 / 换号重试 / 限流耗尽 /
   * SSE / transport / 附件读取」六条互不相同的路径上，行为用例一次只能覆盖
   * 一条。**已反向验证过这个缺陷**：把第 1539 行（换号路径）改回 `buddy: `
   * 后，上面那条行为用例仍然全绿 —— 所以它挡不住其余 11 处。
   *
   * 这也是本仓库既有的取舍（见 `tests/unit/image-budget.spec.ts` 的
   * 「五处同形代码」注释）：为这种重复形状搭多套适配器桩的成本，远高于
   * 一条源码断言的维护成本，而共享实现本身已有行为用例。
   */
  it('源码里没有硬编码的 buddy: 错误前缀（必须跟随 product.id）', () => {
    const file = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../src/buddy-adapter.ts')
    const source = readFileSync(file, 'utf8')
    // 注释里会引用这句错误文案作证据（如实测原文），必须排除掉，
    // 否则用例会因为「注释提到了 buddy:」而假失败。
    //
    // ⚠️ 块注释**替换成等量空白**而不是整体删除：直接删会把行数压掉，
    // 于是下面报出的行号指向源文件里另一个位置（实测偏了 600+ 行，
    // 排障时会被引到完全无关的代码上）。保留 `\n`、其余字符换成空格，
    // 行号就与源文件一致了。`//` 行注释不含换行，直接删是安全的。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/\/\/.*$/gm, '')

    const offenders = [...code.matchAll(/(`|')buddy: /g)].map((m) => {
      const line = code.slice(0, m.index).split('\n').length
      return `第 ${line} 行：${source.split('\n')[line - 1]?.trim().slice(0, 80)}`
    })
    expect(
      offenders,
      '这些位置的错误前缀写死了 buddy:，WorkBuddy 用户会看到错的产品名；'
      + '改成 ${this.product.id}: ',
    ).toEqual([])
  })

  // ── 以下为补充用例：brief 的 4 条未能覆盖 UA、注册路由与默认回退 ──

  it('默认构造的适配器使用 CodeBuddy 的产品码与 User-Agent', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    expect(seen!.get('X-Product-Code')).toBe(CODEBUDDY.productCode)
    expect(seen!.get('User-Agent')).toBe(CODEBUDDY.userAgent)
    // X-Product 是**归属名**（产品名），不是部署类型。
    expect(seen!.get('X-Product')).toBe('CodeBuddy')
    // 归属头族：后台「使用端」列按这组头归因。
    expect(seen!.get('X-Agent-Purpose')).toBe('conversation')
    expect(seen!.get('X-IDE-Name')).toBe('CodeBuddy')
    expect(seen!.get('X-IDE-Type')).toBe('CodeBuddy')
    expect(seen!.get('X-IDE-Version')).toBe(CODEBUDDY.clientVersion)
  })

  it('WorkBuddy 适配器使用自身 product 的 productCode、User-Agent 与 providerInfo 展示名', async () => {
    // deepseek-v4-flash 不命中任何模型族规则 → 回落到 product.userAgent，
    // 故注入自定义 UA 的 product 仍能被观测到。
    const custom: BuddyProduct = { ...WORKBUDDY, userAgent: 'WorkBuddy/7.7.7' }
    let seen: Headers | undefined
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: custom,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    expect(seen!.get('X-Product-Code')).toBe('workbuddy')
    expect(seen!.get('User-Agent')).toBe('WorkBuddy/7.7.7')
    expect(seen!.get('X-Product')).toBe('WorkBuddy')
    expect(seen!.get('X-IDE-Name')).toBe('WorkBuddy')
    expect(adapter.providerInfo('workbuddy').name).toBe(WORKBUDDY.displayName)
  })

  it('send() 的 User-Agent 取自 product 而非固定常量', async () => {
    // 反向验证：默认 CodeBuddy 的 UA 与注入值必须不同，否则该断言无意义。
    const custom: BuddyProduct = { ...CODEBUDDY, userAgent: 'CustomAgent/9.9.9' }
    expect(custom.userAgent).not.toBe(CODEBUDDY.userAgent)
    let seen: Headers | undefined
    const adapter = makeAdapter({
      product: custom,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    expect(seen!.get('User-Agent')).toBe('CustomAgent/9.9.9')
  })

  // ── 按模型族分档的 User-Agent ──

  it('WorkBuddy 的 UA 按模型族分档：GPT 系走国际版形态，GLM 系走国内形态', async () => {
    const uaFor = async (model: string): Promise<string | null> => {
      let seen: Headers | undefined
      const adapter = new BuddyAdapter({
        credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
        resolveCredential: async () => makeCredential(),
        refresh: async () => {},
        product: WORKBUDDY,
        fetchImpl: async (_url, init) => {
          seen = new Headers(init?.headers as HeadersInit)
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never)
      return seen!.get('User-Agent')
    }

    // 国际版独有模型线 → 国际版形态（平台段为 `WorkBuddy AI`）。
    expect(await uaFor('gpt-5.6-sol')).toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
    expect(await uaFor('gemini-3.5-flash')).toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
    // 国内系模型 → 国内客户端形态（平台段为 `WorkBuddy`）。
    expect(await uaFor('glm-5.2')).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
    expect(await uaFor('hy3')).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
    expect(await uaFor('kimi-k3')).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
    // 未命中任何模型族规则 → 回落到 product.userAgent（默认国际版形态）。
    expect(await uaFor('deepseek-v4.1-flash')).toBe(WORKBUDDY.userAgent)
  })

  it('分档后的 UA 仍含产品品牌字样，不会退化成框架的 harness UA', async () => {
    // 归因前提：腾讯后台按出站 UA 归因「使用端」，UA 必须含 WorkBuddy/CodeBuddy 字样。
    const custom: BuddyProduct = { ...WORKBUDDY, userAgent: 'WorkBuddy/9.9.9' }
    let seen: Headers | undefined
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: custom,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    const ua = seen!.get('User-Agent')!
    expect(ua).toContain('WorkBuddy')
    expect(ua).not.toContain('deepseek-harness')
  })

  it('providerInfo 对非字符串入参回退到本产品的 id', () => {    // 上游传入 undefined 时不得让 deriveKeyRef 的 toUpperCase 崩在客户端。
    const workbuddy = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
    })
    expect(workbuddy.providerInfo(undefined as never).id).toBe('workbuddy')
    expect(makeAdapter().providerInfo('' as never).id).toBe(CODEBUDDY.id)
  })

  /** 记录注册入参的假 llm 服务。 */
  function makeLlm() {
    const providers: Array<{ provider: string; displayName: string; settingsNs: string }> = []
    const adapters: string[][] = []
    const instances: unknown[] = []
    return {
      providers,
      adapters,
      instances,
      llm: {
        registerConfigurableProviders(entries: Array<{ provider: string; displayName: string; settingsNs: string }>) {
          providers.push(...entries)
          return { replace: () => {} }
        },
        registerAdapter(names: string[], adapter: unknown) {
          adapters.push(names)
          instances.push(adapter)
          return { replace: () => {} }
        },
      },
    }
  }

  it('registerBuddyLlm 默认只注册 buddy 路由（不声明可配置 provider）', () => {
    const fake = makeLlm()
    registerBuddyLlm({ llm: fake.llm } as never, {
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
    })
    // ⚠️ 2026-10-01（用户要求）：不再向「设置 → 模型 → 提供商」声明配置行 ——
    // 账号与模型开关都在 Jet Hub 设置页管理（见 src/llm-register-compat.ts 模块头）。
    expect(fake.providers).toEqual([])
    expect(fake.adapters).toEqual([['buddy']])
  })

  it('registerBuddyLlm 传入 WorkBuddy 时只注册 workbuddy 路由（不声明可配置 provider）', () => {
    const fake = makeLlm()
    registerBuddyLlm({ llm: fake.llm } as never, {
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
    })
    expect(fake.providers).toEqual([])
    expect(fake.adapters).toEqual([['workbuddy']])
  })

  it('registerBuddyLlm 注册的适配器与其路由使用同一产品', async () => {
    const fake = makeLlm()
    registerBuddyLlm({ llm: fake.llm } as never, {
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
    })
    // 注册进 llm 的适配器实例必须自己就是 WorkBuddy 产品（而非 CodeBuddy），
    // 否则路由名为 workbuddy 却发 codebuddy 的身份标识。
    const adapter = fake.instances[0] as BuddyAdapter
    expect(adapter.providerInfo('workbuddy')).toMatchObject({ id: 'workbuddy', name: WORKBUDDY.displayName })
    expect((await adapter.listModels('workbuddy')).every((m) => m.provider === 'workbuddy')).toBe(true)
  })
})

/**
 * 账号池 provider 实参。
 *
 * 适配器调用账号池时必须传「本适配器所属产品的 id」，而不是写死的 'buddy'。
 * AccountPool 内部先按 `entry.provider !== provider` 过滤账号，WorkBuddy 账号的
 * provider 是 'workbuddy'，传 'buddy' 会永远匹配不到：
 *   - findAccountIdByCredential 恒返回 '' → 限流重置时间无法归属账号 → UI 永不显示限流标记；
 *   - getAvailableAccount 恒返回 null → 限流后无法自动切换账号。
 * 即 WorkBuddy 的账号池功能（限流归属 + 自动切换）会完全失效。
 */
describe('BuddyAdapter 向账号池传递的 provider', () => {
  /** 6004 频率限制响应体（resetAt 取远未来，避免测试随时钟漂移）。 */
  function rateLimitBody(): string {
    return JSON.stringify({
      code: 6004,
      msg: '您的使用量已超出频率限制，将在 2099-12-31 23:59:59 UTC+8 重置',
    })
  }

  /**
   * 记录被查询 provider 的账号池替身。
   * @returns queried - 按调用顺序记录 findAccountIdByCredential / getAvailableAccount 收到的 provider
   */
  function makeRecordingPool() {
    const queried: string[] = []
    return {
      queried,
      async listAccounts() {
        return []
      },
      async findAccountIdByCredential(provider: string) {
        queried.push(provider)
        return 'acct-current'
      },
      async updateModelRateLimit() {},
      async getAvailableAccount(provider: string) {
        queried.push(provider)
        return null
      },
    }
  }

  it('WorkBuddy 适配器以 workbuddy 作为 provider 查询账号池', async () => {
    const pool = makeRecordingPool()
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: WORKBUDDY,
      accountPool: pool as never,
      fetchImpl: async () => new Response(rateLimitBody(), { status: 400 }),
    })

    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch(() => {})

    // 两条路径都被走到；且都必须是 'workbuddy'，出现 'buddy' 即为回归。
    expect(pool.queried.length).toBeGreaterThanOrEqual(2)
    expect(pool.queried.filter((p) => p === 'workbuddy').length).toBeGreaterThanOrEqual(2)
    expect(pool.queried.every((p) => p === 'workbuddy')).toBe(true)
  })

  it('CodeBuddy 适配器仍以 buddy 作为 provider 查询账号池', async () => {
    const pool = makeRecordingPool()
    // 不传 product：适配器回退到 CodeBuddy，provider 应为 'buddy'。
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async () => new Response(rateLimitBody(), { status: 400 }),
    })
    expect(adapter.providerInfo('buddy').id).toBe(CODEBUDDY.id)

    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch(() => {})

    // 对称性防守：修 WorkBuddy 时不得把 CodeBuddy 也改成 workbuddy。
    expect(pool.queried.length).toBeGreaterThanOrEqual(2)
    expect(pool.queried.every((p) => p === 'buddy')).toBe(true)
  })
})

describe('产品兜底模型目录校正', () => {
  /** 造一个只有 2 个模型的假产品，便于精确断言校正行为。 */
  const fakeProduct = {
    ...WORKBUDDY,
    fallbackModels: [
      { id: 'wanted-a', name: 'Wanted A', contextWindow: 111_000 },
      { id: 'wanted-b', name: 'Wanted B', contextWindow: 222_000 },
    ],
  }

  it('远端多出来的条目被丢弃（只保留兜底表声明的）', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      // 远端返回的是残缺/错误的集合（多出的 junk 与缺失的 wanted-b）
      fetchRemoteModels: async () => [{ id: 'junk', name: 'Junk' }, { id: 'wanted-a', name: 'Wanted A' }],
    })
    const models = await adapter.listModels('workbuddy')
    expect(models.map((m) => m.id)).toEqual(['wanted-a', 'wanted-b'])
  })

  it('兜底表声明但远端缺失的条目被补进来', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      fetchRemoteModels: async () => [{ id: 'wanted-a', name: 'Wanted A' }],
    })
    const models = await adapter.listModels('workbuddy')
    expect(models.map((m) => m.id)).toEqual(['wanted-a', 'wanted-b'])
    // 补齐的条目用兜底表的名称
    expect(models[1]!.name).toBe('Wanted B')
  })

  it('远端元数据优先于兜底表（远端更权威）', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      fetchRemoteModels: async () => [
        { id: 'wanted-a', name: 'Remote A', contextWindow: 999_000 },
      ],
    })
    const models = await adapter.listModels('workbuddy')
    expect(models[0]!.name).toBe('Remote A')
    const resolved = await adapter.resolveModel('workbuddy', 'wanted-a')
    expect(resolved.name).toBe('Remote A')
    expect(resolved.context?.contextWindow).toBe(999_000)
  })

  it('远端不可用时用兜底表的名称与上下文窗口', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      fetchRemoteModels: async () => [],
    })
    const models = await adapter.listModels('workbuddy')
    expect(models.map((m) => m.id)).toEqual(['wanted-a', 'wanted-b'])
    const resolved = await adapter.resolveModel('workbuddy', 'wanted-b')
    expect(resolved.name).toBe('Wanted B')
    expect(resolved.context?.contextWindow).toBe(222_000)
  })

  it('没有兜底表的产品不受影响（保持既有远端行为）', async () => {
    const noFallback = { ...WORKBUDDY, fallbackModels: undefined }
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('WORKBUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: noFallback as never,
      fetchRemoteModels: async () => [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }],
    })
    const models = await adapter.listModels('workbuddy')
    expect(models.map((m) => m.id)).toEqual(['x', 'y'])
  })
})

/**
 * 模型黑名单对 listModels 的过滤。
 *
 * 这是「关闭开关 → 对话框不再显示该模型」这条链路的关键一环：
 * /api/session 的模型目录正是通过 ctx.llm.listModels() → 适配器 listModels()
 * 构建的。此处断言适配器确实把黑名单里的模型摘掉了。
 */
describe('BuddyAdapter 模型黑名单', () => {
  /** 只实现 listModels 所需方法的账号池替身。 */
  function poolWithDisabled(provider: string, ids: string[]) {
    const disabled = new Set(ids)
    return {
      disabledModelsFor: (value: string) => (value === provider ? disabled : new Set<string>()),
    } as never
  }

  /**
   * ★★ **G3-6 的真行为守卫**（2026-10-12 对抗性审计查出该语义**当时零守卫**后补上）。
   *
   * 守的是「拉黑一个同名模型后，**另一个的变体标记不得跳变**」——
   * 消歧必须基于**未过滤**的全量集合（`displayNameFor(model, all)`）。
   *
   * ## ⚠️ 为什么原先的守卫是空的
   *
   * 唯一「覆盖」过该语义的两条用例是 `model-catalog.spec.ts` 的 ⑮ 与
   * `model-catalog-parity.spec.ts` 的 ④，而它们都构造**合成 config / 替身池**
   *（`makeCatalog`）—— 验证的是 `createModelCatalog` **骨架自身**，
   * **看不见 `buddy` 传进去的实参**。而本文件的四条黑名单用例**只断言 `ids`**，
   * 「同名模型追加变体标记」那三条又**都不带 `accountPool`**
   *（⇒ 无黑名单 ⇒ `all` 与过滤后恒等，结构上不可能区分两种实现）。
   *
   * **实测**：把消歧集合换成黑名单过滤后的集合（产出仍保持全量，精确复现修复前
   * 行为），`buddy-adapter.spec.ts` + `model-catalog-parity.spec.ts` +
   * `model-catalog.spec.ts` 共 **212 条全绿** ⇒ 该语义当时没有任何断言在守。
   */
  it('★★ 拉黑一个同名模型后，另一个的名字**不得跳变**（消歧基于未过滤集合）', async () => {
    // 两个远端模型的 name **完全相同** ⇒ 只能靠变体标记区分
    //（真实报障形态：国际版 deepseek-v4.1-flash 与 -sg 的 name 撞车而计费不同）。
    const adapter = makeAdapter({
      product: { ...WORKBUDDY, fallbackModels: undefined } as never,
      fetchRemoteModels: async () => [
        { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', creditsRate: 'x0.00' },
        { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', creditsRate: 'x0.03' },
      ],
      accountPool: poolWithDisabled('workbuddy', ['deepseek-v4.1-flash']),
    })
    const models = await adapter.listModels('workbuddy')

    // 黑名单确实生效：被拉黑的那个不在列表里。
    expect(models.map((m) => m.id)).toEqual(['deepseek-v4.1-flash-sg'])

    // ★ 关键断言：剩下的那个**仍带变体标记**。
    //   若消歧改用「已过滤的集合」⇒ 过滤后只剩一个同名 ⇒ 不再需要标记 ⇒
    //   名字退化成 'Deepseek-V4.1-Flash'（**跳变**）⇒ 本断言变红。
    expect(
      models[0]?.name,
      '拉黑同名模型之一后，另一个的名字跳变了 —— 消歧必须基于**未过滤**的全量集合',
    ).toBe('Deepseek-V4.1-Flash · x0.03 SG')
  })

  it('被关闭的模型从列表中消失，其余保持原有顺序', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy', ['glm-5.2', 'hy3']) })
    const models = await adapter.listModels('buddy')
    const ids = models.map((m) => m.id)

    expect(ids).not.toContain('glm-5.2')
    expect(ids).not.toContain('hy3')
    // 未关闭的模型一个都不能少，且顺序不变（顺序即选择器的展示顺序）
    expect(ids).toEqual(
      CODEBUDDY.fallbackModels!.map((m) => m.id).filter((id) => id !== 'glm-5.2' && id !== 'hy3'),
    )
  })

  it('空黑名单不改变列表（默认全开）', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy', []) })
    const models = await adapter.listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
  })

  it('没有账号池时不过滤（适配器可脱离账号池使用）', async () => {
    const models = await makeAdapter().listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(CODEBUDDY.fallbackModels!.map((m) => m.id))
  })

  it('黑名单按产品 id 隔离：workbuddy 的关闭项不影响 buddy', async () => {
    const adapter = makeAdapter({
      accountPool: {
        // 只对 workbuddy 报告黑名单
        disabledModelsFor: (value: string) => (value === 'workbuddy' ? new Set(['glm-5.2']) : new Set<string>()),
      } as never,
    })
    const ids = (await adapter.listModels('buddy')).map((m) => m.id)
    expect(ids).toContain('glm-5.2')
  })

  it('关闭不影响 resolveModel/stream 的路由能力（目录只是建议性的）', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy', ['glm-5.2']) })
    // listModels 里已消失……
    expect((await adapter.listModels('buddy')).map((m) => m.id)).not.toContain('glm-5.2')
    // ……但仍可解析元数据（DSH 契约要求目录缺省不构成请求拒绝）
    const resolved = await adapter.resolveModel('buddy', 'glm-5.2')
    expect(resolved.id).toBe('glm-5.2')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
  })
})

// ── 目录门控：没有已登录账号就不显示该 provider 的模型 ──
//
// DSH 的 `buildModelCatalog` 显式 `.filter(group => group.models.length > 0)`，
// 故返回空数组即让整个 provider 分组消失（用户需求：减少模型选择列表臃肿）。
describe('BuddyAdapter 目录门控（无已登录账号时隐藏）', () => {
  /** 账号池替身：报告是否有已登录账号。 */
  function poolWithLogin(loggedIn: boolean) {
    return {
      disabledModelsFor: () => new Set<string>(),
      hasLoggedInAccount: async () => loggedIn,
    } as never
  }

  it('没有已登录账号 → 返回空数组', async () => {
    const adapter = makeAdapter({ accountPool: poolWithLogin(false) })
    expect(await adapter.listModels('buddy')).toEqual([])
  })

  it('有已登录账号 → 正常返回目录', async () => {
    const adapter = makeAdapter({ accountPool: poolWithLogin(true) })
    expect((await adapter.listModels('buddy')).length).toBeGreaterThan(0)
  })

  it('accountPool 缺失时保守放行（判定不可用 ≠ 无账号）', async () => {
    const adapter = makeAdapter()
    expect((await adapter.listModels('buddy')).length).toBeGreaterThan(0)
  })

  it('未实现 hasLoggedInAccount 的替身同样保守放行', async () => {
    // 门控是展示优化而非安全边界：判定不可用时宁多勿少。
    const adapter = makeAdapter({
      accountPool: { disabledModelsFor: () => new Set<string>() } as never,
    })
    expect((await adapter.listModels('buddy')).length).toBeGreaterThan(0)
  })
})

/**
 * 安全策略拦截（11140）的两项补修。
 *
 * ## ① 被拦账号的冷却标记
 *
 * !15 / !16 让「有可用账号就一定能用上」成立，但**每轮都要重撞坏账号**：
 * 候选顺序是用户在 Jet Hub 拖拽定的（`getAvailableAccount` 不再按重置时间重排），
 * 实测那个池是「前 4 个被 11140 拦、后 3 个可用」——每次请求都固定先发 4 次失败，
 * 白烧额度、白等往返，且下一轮一模一样。
 *
 * ## ② HTTP 200 + SSE 流内的 11140
 *
 * 这形态**实测存在**（同一报文在 CodeArts 侧就以流内错误帧下发），而 buddy 的
 * 帧类型原先没有 `code` / `msg` 字段：既没内容也没报错，UI 表现成「干净地停止」。
 */
describe('安全策略拦截（11140）：账号冷却 + 流内错误帧', () => {
  /**
   * 记录 `updateModelRateLimit` 调用的账号池替身。
   *
   * ⚠️ `getAvailableAccount` **必须按 `exclude` 取号**（与 `AccountPool` 同语义）：
   * 直接返回第一个账号会让它等于「刚失败的那个」，命中适配器的 `tried.has` 而
   * 判成「没换到号」，于是走到 `credential expired and refresh failed` 那条早退 ——
   * 测出来的是桩的行为，不是被测代码的。
   */
  function recordingPool(accounts: Array<{ id: string; token: string }>) {
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    return {
      recorded,
      async findAccountIdByCredential(_provider: string, identity: string) {
        return accounts.find((a) => a.token === identity)?.id ?? ''
      },
      async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      async getAvailableAccount(
        _provider: string,
        _modelId: string,
        exclude?: ReadonlySet<string>,
      ) {
        const next = accounts.find((a) => exclude === undefined || !exclude.has(a.id))
        if (next === undefined) return null
        return {
          entry: { id: next.id },
          credential: makeCredential({ access_token: next.token }),
        }
      },
      disabledModelsFor: () => new Set<string>(),
    }
  }

  const safetyBodyText = JSON.stringify({
    code: 11140,
    msg: 'request illegal',
    requestId: '5b2240b4-efdf-40e0-94e4-cfee1aa80585',
    displayMsg: { zh: '内容未通过安全审核，请调整后重试。' },
  })

  it('冷却时长是 30 分钟，且**不等于**限流解析兜底的那 1 小时', () => {
    // 防回归：有人会把两者合并成一个常量（它们数值相近、都写进 modelRateLimits），
    // 但语义不同 —— 一个是「服务端不给时间」的策略拦截，一个是「解析不到限流时间」的兜底。
    // 合并之后调其中一个会静默改掉另一个。
    expect(policyBlockResetAtMs(0)).toBe(30 * 60_000)
    expect(policyBlockResetAtMs(0)).not.toBe(3_600_000)
  })

  it('认证路径：每个被拦账号都被标冷却，且只标本次要用的那个模型', async () => {
    const pool = recordingPool([
      { id: 'acct-1', token: 'AT1' },
      { id: 'acct-2', token: 'AT2' },
    ])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: pool,
      fetchImpl: async () => new Response(safetyBodyText, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')

    // 两个账号都撞到拦截 → 都被标记（修复前一条都不记，下轮照样从 acct-1 开始重撞）。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    expect(pool.recorded.every((r) => r.modelId === DEFAULT_MODEL)).toBe(true)
    expect(pool.recorded.every(
      (r) => Math.abs(r.resetAtMs - policyBlockResetAtMs(Date.now())) <= 5_000,
    )).toBe(true)
  })

  it('单账号池 + 续期失败：不得把拦截报成 AUTH（早退分支也必须先看 11140）', async () => {
    // 写这批用例时**实测到**的缺陷（补修）：`refreshedCredential === undefined
    // && !rotated` 那条早退只看「续期失败 + 没换到号」——而单账号池必然满足它，
    // 于是真实原因是 11140 时，报出来的却是「credential expired and refresh failed」
    // + `AUTH` → UI 只显示「API 密钥无效」，把用户引向重新登录（token 实测有效）。
    const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: pool,
      fetchImpl: async () => new Response(safetyBodyText, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    expect((error as LlmError).message).not.toContain('credential expired')
    expect((error as LlmError).message).toContain('安全策略')
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1'])
  })

  it('认证路径：换到可用账号后只标坏账号，可用账号不被牵连', async () => {
    const pool = recordingPool([
      { id: 'acct-1', token: 'AT1' },
      { id: 'acct-2', token: 'AT2' },
    ])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: pool,
      fetchImpl: async (_url: unknown, init: { headers: Headers }) =>
        (init.headers.get('Authorization') ?? '').includes('AT1')
          ? new Response(safetyBodyText, { status: 403 })
          : sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 只有 acct-1 被标；acct-2 成功产出内容，绝不能被记成不可用。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1'])
  })

  it('冷却标记写不进索引时不反噬：仍报准确的拦截错误', async () => {
    // 与 `src/expiry-sync.ts` 的回写惯例同口径：标记是**附带收益**，
    // 它失败不该把「安全策略拦截」顶替成一个无关的写入错误。
    const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('refresh failed') },
      accountPool: {
        ...pool,
        updateModelRateLimit: async () => { throw new Error('settings 写入失败') },
      },
      fetchImpl: async () => new Response(safetyBodyText, { status: 403 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    expect((error as LlmError).message).toContain('安全策略')
    expect((error as LlmError).message).not.toContain('settings 写入失败')
  })

  it('流内 11140（HTTP 200 + 错误帧）：不再静默结束，报错并标冷却', async () => {
    const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: pool,
      // HTTP 200，但流里第一帧就是 11140 —— 修复前它没有 error / choices 字段，
      // 被一路当成「正常结束、无内容」，UI 表现为「干净地停止、无任何报错」。
      fetchImpl: async () => sseResponse(`data: ${safetyBodyText}\n\n`),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    expect((error as LlmError).message).toContain('安全策略')
    // 流内这条通道**不重发**（本轮不产出内容才允许重放是 trae 那套结构改造的
    // 前提，本次没做），所以文案如实说「当前账号」，不谎称「已逐个换号重试」。
    expect((error as LlmError).message).toContain('当前账号')
    expect((error as LlmError).message).not.toContain('已逐个换号重试')
    expect((error as LlmError).message).toContain('HTTP 200')
    // 标了冷却 → 下一轮选号就绕开它。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1'])
  })

  it('流内判据必须窄：正文里出现 11140 / 安全审核字样不算拦截', async () => {
    // 模型在讨论审核策略时正常就会说这些词。判据若只看 payload 里的字样，
    // 一个合法回答会被判成「账号被拦」并连带标冷却 —— 那是把功能做没。
    const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
    const text = '关于 code":11140、「request illegal」与安全审核 的说明'
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: pool,
      fetchImpl: async () => sseResponse(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === text)).toBe(true)
    expect(pool.recorded).toEqual([])
  })

  it('没有账号池时流内 11140 仍准确报错（标记跳过、不得崩）', async () => {
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      fetchImpl: async () => sseResponse(`data: ${safetyBodyText}\n\n`),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
  })
})

/**
 * 内容级风控（`code 11128`）**不是账号级拦截** —— Gitee issue IKJNA1。
 *
 * ## 实测报文（本机 2026-10-05，workbuddy / CodeBuddy 双端点一致）
 *
 * ```json
 * {"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 *  "requestId":"…","displayMsg":{"en":"The request was blocked by security policy…"}}
 * ```
 *
 * 触发条件是 **system 里的某个模板句**（ZCode 的 gitStatus 注入
 * `Main branch (you will usually use this for PRs)`），与账号无关：同一账号
 * 换掉那一句就通（HTTP 200）。
 *
 * ## 因此这批用例锁的是「**不要**把它认成账号拦截」
 *
 * 认成账号级会走 `isContentRejection` → 换号 + 标 30 分钟冷却
 * （`policyBlockResetAtMs`）。而换号对内容级拦截**完全无效**：池里每个账号
 * 都会在同一句上被拦，等于把整个账号池白锁 30 分钟，用户的整轮 agent 对话
 * 在这半小时内全废 —— 故障从「一句话被拦」放大成「半小时不可用」。
 *
 * 真正的修法在网关出站方向把那一句改写掉，见
 * `tests/unit/openai-gateway-tencent-fingerprint.spec.ts`。
 */
describe('内容级风控（11128）：不得当成账号级拦截换号/冷却', () => {
  const unapprovedChannelBody = JSON.stringify({
    code: 11128,
    msg: 'Illegal API invocation from an unapproved channel',
    requestId: 'c888aa59-d5e0-4047-a74c-6b6999f3004f',
    displayMsg: {
      en: 'The request was blocked by security policy. Please retry later or contact support.',
      zh: '请求被安全策略拦截，请稍后重试或联系支持。',
    },
  })

  /** 与上面 11140 那组同构的账号池替身（记录冷却标记）。 */
  function recordingPool(accounts: Array<{ id: string; token: string }>) {
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    return {
      recorded,
      async findAccountIdByCredential(_provider: string, identity: string) {
        return accounts.find((a) => a.token === identity)?.id ?? ''
      },
      async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      async getAvailableAccount(
        _provider: string,
        _modelId: string,
        exclude?: ReadonlySet<string>,
      ) {
        const next = accounts.find((a) => exclude === undefined || !exclude.has(a.id))
        if (next === undefined) return null
        return { entry: { id: next.id }, credential: makeCredential({ access_token: next.token }) }
      },
      disabledModelsFor: () => new Set<string>(),
    }
  }

  it('★ HTTP 400 + 11128：只发一次、不换号、不标 30 分钟冷却', async () => {
    // 这条是**行为锁**：400 在适配器里走的是「非法请求」早退分支，本来就
    // 不会进入换号/冷却那几条 —— 即便有人日后把 11128 加进
    // `isContentRejection`，这一条也不会红（真正会红的是下面那条流内用例，
    // 因为只有流内那条通道会真的调用该判据）。
    const pool = recordingPool([
      { id: 'acct-1', token: 'AT1' },
      { id: 'acct-2', token: 'AT2' },
    ])
    let calls = 0
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => { throw new Error('不该走到续期') },
      accountPool: pool,
      fetchImpl: async () => {
        calls += 1
        return new Response(unapprovedChannelBody, { status: 400 })
      },
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    // 错误必须**抛出来**：静默吞掉会让客户端只显示 reason=unknown（issue 报障原句）。
    expect(error).toBeInstanceOf(LlmError)
    // 只发一次：换号对内容级拦截毫无意义，多发只是白烧往返。
    expect(calls).toBe(1)
    // 关键判据：一个账号都不许被标冷却。
    expect(pool.recorded).toEqual([])
  })

  it('★ 出口文案：不透传「请重新发送」，改说「内容级、换号/重发无效」并带 requestId', async () => {
    // 2026-10-21：上游 `displayMsg` 是「请求被拦截，请重新发送」，而实测重发恒败、
    // 换号也无效（4 个 buddy 账号全拦；把 system 首句改写掉后同一账号立即 200）。
    // 原样透传 = 诱导用户做无效动作 —— 与本文件 `redactUpstreamActionHints` 同一立场。
    const pool = recordingPool([
      { id: 'acct-1', token: 'AT1' },
      { id: 'acct-2', token: 'AT2' },
    ])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: pool,
      fetchImpl: async () => new Response(unapprovedChannelBody, { status: 400 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    const message = (error as LlmError).message
    // ① 说清是内容级、且换号/重发都无效（文案本身就是出路）。
    expect(message).toContain('内容级')
    expect(message).toContain('换账号无效')
    // ② 上游那句误导文案必须消失（这正是本条存在的理由）。
    expect(message).not.toContain('请重新发送')
    // ③ 唯一定位手段必须在文案里，否则「去取 requestId」这条纪律不可执行。
    expect(message).toContain('c888aa59-d5e0-4047-a74c-6b6999f3004f')
    // ④ 码不能取 AUTH（会被客户端换成「API 密钥无效」）、也不能取可重试集合里的码。
    expect((error as LlmError).failure.code).toBe('PERMISSION_DENIED')
    // ⑤ 行为不变：仍不换号、不写冷却。
    expect(pool.recorded).toEqual([])
  })

  it('★ HTTP 200 + 流内 11128 帧：同样不得标账号冷却（这条才是判据真会被用到的地方）', async () => {
    // 判据 `isContentRejection` 在**流内**那条通道（HTTP 200 + 无 choices 的
    // 错误帧）会被直接调用。若把 11128 加进去，命中后走的是
    // `markPolicyBlockedAccount` —— 也就是「30 分钟账号冷却」。
    // 而 11128 是**内容级**拦截（同一账号换掉那一句就 200），冷却纯属误伤：
    // 池里每个账号都会在同一句上被拦，用户半小时内整池不可用。
    //
    // 期望：这一帧**不**被当成 11140 那样的账号级拦截，因此不标冷却。
    const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      accountPool: pool,
      fetchImpl: async () => sseResponse(`data: ${unapprovedChannelBody}\n\n`),
    })
    await collectChunks(adapter, streamOptions).catch(() => undefined)
    expect(pool.recorded).toEqual([])
  })

  it('★ 11128 报文里出现「安全审核 / safety review」字样也**不**触发账号冷却', () => {
    // 11128 的 displayMsg 措辞（「blocked by security policy」）与 11140 极近。
    // 判据若被顺手放宽成「看到安全字样就算」，后果同上：整个池被锁 30 分钟。
    expect(unapprovedChannelBody).toContain('11128')
    expect(unapprovedChannelBody).not.toContain('11140')
    expect(unapprovedChannelBody).not.toContain('request illegal')
    // 措辞确实与 11140 高度相似 —— 这正是判据必须按 code 而非按文案收窄的原因。
    expect(unapprovedChannelBody).toMatch(/security policy/i)
  })

  /**
   * ⚠️⚠️ IKLYCT 引入的**真实缺陷**（2026-10-18 对抗审计打穿，已修）。
   *
   * ## 上面那条用例是**空断言** —— 本条审计的起因
   *
   * 它只对**夹具字面量**做 `toMatch`/`not.toContain`，**根本没有调用判据**
   * ⇒ `displayMsg` 一漂它照样绿。而下面是**真跑**的格子。
   *
   * ## 缺陷形态（实测，从 `lib/` 编译产物抠出判据实跑）
   *
   * `isContentRejection` 的腿③ `/安全审核|safety review/i` **扫整份报文**
   * （含 `displayMsg` / `displayTips`），而本文件自己就记着
   * 「`11128` 各子原因**共用/漂移 `displayMsg`**」⇒ 当上游把**内容级**那条
   * 11128 的 `displayMsg` 漂成安全审核措辞时：
   *
   * | 腿 | 命中？ |
   * |---|---|
   * | 腿① `"code":11140` | ❌ code 是 11128 |
   * | 腿② `/request illegal/i` | ❌ msg 是 `Illegal API invocation…` |
   * | 早退 `isChannelVerificationIllegalBody` | ❌ 它要 `request illegal` |
   * | ⚠️ **腿③**（扫全文案） | ✅ **命中** |
   *
   * ⇒ 这份「**换句即通**」的报文落进账号级档 ⇒ **烧完整池 + 每个账号锁 30 分钟**，
   * 出口文案还建议用户去停用账号 —— 把 `tencent-fingerprint.ts` 的修复完全抵消。
   *
   * ⚠️ IKLYCT 那条反馈句**每轮必带**（客户端默认 system 的固定段落）⇒ 一定命中
   * ⇒ 上游一漂 `displayMsg`，用户侧就是「整池被锁 30 分钟」，而不是「一次白撞」。
   */
  describe('★ IKLYCT：内容级 11128 × displayMsg 漂移 ⇒ 绝不得落进账号级档', () => {
    /** 内容级 11128 的真实报文（2026-10-18 两端点实测，buddy + workbuddy 一致）。 */
    const contentBlocked = (extra: Record<string, unknown>): string => JSON.stringify({
      code: 11128,
      msg: 'Illegal API invocation from an unapproved channel',
      requestId: 'r-iklyct',
      ...extra,
    })

    /** 真发一次 HTTP 400，回报「送出了几次」与「冷却标记」。 */
    async function runHttp400(body: string, accountCount = 2): Promise<{
      recorded: Array<{ accountId: string }>
      calls: number
      error: unknown
    }> {
      const pool = recordingPool(Array.from({ length: accountCount }, (_, i) => ({
        id: `acct-${i + 1}`, token: `AT${i + 1}`,
      })))
      let calls = 0
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => { throw new Error('不该走到续期') },
        accountPool: pool,
        fetchImpl: async () => {
          calls += 1
          return new Response(body, { status: 400 })
        },
      })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      return { recorded: pool.recorded, calls, error }
    }

    /** 真发一次流内错误帧（HTTP 200 + SSE），回报冷却标记。 */
    async function runInline(body: string, accountCount = 2): Promise<{
      recorded: Array<{ accountId: string }>
      calls: number
    }> {
      const pool = recordingPool(Array.from({ length: accountCount }, (_, i) => ({
        id: `acct-${i + 1}`, token: `AT${i + 1}`,
      })))
      let calls = 0
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        accountPool: pool,
        fetchImpl: async () => {
          calls += 1
          return sseResponse(`data: ${body}\n\n`)
        },
      })
      await collectChunks(adapter, streamOptions).catch(() => undefined)
      return { recorded: pool.recorded, calls }
    }

    const DRIFT_CASES = [
      ['displayMsg.en 漂成 safety review', { displayMsg: { en: 'The content did not pass the safety review. Please retry.' } }],
      ['displayMsg.zh 含「安全审核」', { displayMsg: { en: 'blocked by security policy', zh: '内容未通过安全审核' } }],
      ['displayTips 含 safety review', {
        displayMsg: { en: 'blocked by security policy' },
        displayTips: { en: 'This call failed the safety review.' },
      }],
    ] as const

    it.each(DRIFT_CASES)('★ 流内通道（判据真会被用到的地方）：%s ⇒ 零冷却、不换号', async (_label, extra) => {
      const { recorded, calls } = await runInline(contentBlocked(extra))
      expect(recorded, '内容级 11128 不得写账号冷却（换句即通，冷却纯属误伤）').toEqual([])
      // 换号对内容级拦截完全无效 ⇒ 整个池只试一次
      expect(calls, '不应换号重试（只会白烧往返）').toBe(1)
    }, 60_000)

    it.each(DRIFT_CASES)('★ HTTP 400 通道：%s ⇒ 零冷却', async (_label, extra) => {
      const { recorded } = await runHttp400(contentBlocked(extra))
      expect(recorded).toEqual([])
    }, 60_000)

    it('★ 对照组：真实 11140 仍**必须**被认成账号级拦截（本次修复不得削弱的档）', async () => {
      // ⚠️ 这一格是**反向护栏**：若把内容级排除写得太宽（例如只按 `code:11128` 排除），
      // 就会把真 11140 一起放跑 ⇒ 账号该冷却时没冷却，是**另一个**方向的误伤。
      // ⚠️⚠️ 但**只锁「有冷却」是锁不住的**（实测变异验证）：
      //   把 `isContentBlockedIllegalBody` 改成「只按 code 11128」时，本条**仍然绿** ——
      //   因为 11140 的 `code` 是 11140（不匹配），排除压根不触发 ⇒ 腿① 照常命中。
      //   ⇒ 真正的分界是「**排除判据认不认一个 msg 不是内容级、但同码 11128 的报文**」：
      //   那份报文若被误排除，就会从「落 11140 档（有冷却）」变成「零冷却」。
      const { recorded } = await runHttp400(JSON.stringify({
        code: 11140,
        msg: 'request illegal',
        displayMsg: { en: 'The content did not pass the safety review. Please retry.', zh: '内容未通过安全审核' },
      }))
      expect(recorded.length, '真实 11140 必须写 30 分钟冷却').toBeGreaterThan(0)
    }, 60_000)

    /**
     * ⚠️⚠️ **这才是能区分「判据写窄 / 写宽」的那一格**（变异验证实测发现）。
     *
     * 报文：`code:11128` + `msg` **既不是**内容级、**也不是**渠道校验（第三种子原因）。
     * - 排除判据**写得太宽**（只按 code 11128）⇒ 它被误排除 ⇒ 零冷却 ⇒ 本条红；
     * - 排除判据**恰好写窄**（code + 内容级 msg）⇒ 不排除 ⇒ 落 11140 档 ⇒ 有冷却 ⇒ 本条绿。
     *
     * ⇒ 上面那条 11140 对照组测的是「11140 不被削弱」，本条测的是
     * 「排除**没有**顺手把同码的其它子原因一起放跑」——**两个方向都要守**。
     */
    it('★ 反向护栏：同码 11128 但 msg 是**第三种子原因** ⇒ 排除不得顺手放跑它', async () => {
      const { recorded } = await runHttp400(JSON.stringify({
        code: 11128,
        msg: 'first message is not system prompt',
        requestId: 'r-other',
        displayMsg: { en: 'The content did not pass the safety review. Please retry.', zh: '内容未通过安全审核' },
      }))
      expect(recorded.length, '非内容级、非渠道校验的 11128 仍须落 11140 档（既有行为）').toBeGreaterThan(0)
    }, 60_000)
  })

  /**
   * ★★★ **IKM7SG 复验（2026-10-17 真机）：上游实际用的 `msg` 是 `request illegal`**。
   *
   * ## 为什么这组不可省（PR #104/#105 漏掉的真实边界）
   *
   * IKM7SG 记录的报文是 `{"code":11128,"msg":"conversation id missing"}`，
   * 本机**独立复现**到的却是 `msg:"request illegal"` —— 且这句在本机
   * **从未**以 `conversation id missing` 的形态出现过（5 账号 × 数十次，零命中）。
   * ⇒ 渠道校验那一档（腿①/腿②）对真实报文**恒不命中**。
   *
   * ## 实测到的生产后果（本组逐条锁住）
   *
   * | 环节 | 修复前 |
   * |---|---|
   * | 归属 | 落进 `isContentRejection`（其 `/request illegal/i` 腿命中） |
   * | 处置 | 当 11140 账号级拦截 → 换号 + **写 30 分钟冷却** |
   * | 出口 | 「全部账号均被服务端安全策略拦截…请停用或更换被拦账号」 |
   *
   * 而该账号**带上三枚 Conv 头立刻 200** ⇒ 正是「不可写冷却」那一档。
   * 用户照提示停用它 → 账号更少 → 渠道更不可用。
   *
   * ⚠️⚠️ `request illegal` **不是** 11140 独占的措辞（11128 渠道校验在用同一句），
   * 所以两条判据**都必须**以 `code` 精确值收窄 —— 缺任何一侧都会误判：
   * 只放宽渠道校验档 ⇒ 被 11140 档先吃掉；只收窄 11140 档 ⇒ 没人认领、直接抛。
   */
  describe('IKM7SG 复验：`msg:"request illegal"` 的 11128 渠道校验（真机实测报文）', () => {
    /** 真实上游报文，2026-10-17 本机逐字取自响应体（两个账号、多次稳定）。 */
    function illegalChannelBody(): string {
      return JSON.stringify({
        code: 11128,
        msg: 'request illegal',
        requestId: '82a03481-ec74-4752-bae5-5ab5697b4285',
        displayMsg: {
          en: 'Request blocked. Please send it again',
          zh: '请求被拦截，请重新发送',
          'zh-hant': '請求已被攔截，請重新傳送',
        },
        displayTips: {
          en: 'This call failed channel verification, possibly because it was not sent from an official client. Please resend from the official client.',
          zh: '这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。',
          'zh-hant': '本次呼叫未通過通路驗證，可能不是官方用戶端發出。請使用官方版本重新傳送。',
        },
        actions: ['EDIT_INPUT', 'SUBMIT_FEEDBACK'],
      })
    }

    /** 同上：记录冷却标记的账号池替身。 */
    function pool2(accounts: Array<{ id: string; token: string }>) {
      const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
      return {
        recorded,
        async findAccountIdByCredential(_provider: string, identity: string) {
          return accounts.find((a) => a.token === identity)?.id ?? ''
        },
        async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
          recorded.push({ accountId, modelId, resetAtMs })
        },
        async getAvailableAccount(
          _provider: string,
          _modelId: string,
          exclude?: ReadonlySet<string>,
        ) {
          const next = accounts.find((a) => exclude === undefined || !exclude.has(a.id))
          if (next === undefined) return null
          return { entry: { id: next.id }, credential: makeCredential({ access_token: next.token }) }
        },
        disabledModelsFor: () => new Set<string>(),
      }
    }

    /** 起一个 adapter，返回「实际发出的 token 序列」。 */
    async function sentTokensFor(body: string, accounts = ['AT1', 'AT2']): Promise<string[]> {
      const sentTokens: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: accounts[0] }),
        refresh: async () => {},
        accountPool: pool2(accounts.map((token, i) => ({ id: `acct-${i + 1}`, token }))),
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          sentTokens.push(auth.replace('Bearer ', ''))
          return new Response(body, { status: 400 })
        },
      })
      await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch(() => undefined)
      return sentTokens
    }

    it('★★ 必须换号（修复前只发一次就抛，池里其余可用账号永远试不到）', async () => {
      expect(await sentTokensFor(illegalChannelBody())).toEqual(['AT1', 'AT2'])
    })

    it('★★ 绝不可写 30 分钟冷却：它带上三头就是 200，写冷却等于凭空封禁好账号', async () => {
      // ⚠️ 池必须让「换号取回的那个账号」也失败，否则循环内那一档一次都没执行、
      //    `recorded` 为空是**平凡成立**（2026-10-16 审计踩过，正是零牙的由来）。
      const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
      const sentTokens: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          sentTokens.push(auth.replace('Bearer ', ''))
          return new Response(illegalChannelBody(), { status: 400 })
        },
      })
      await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch(() => undefined)

      // 前置条件：循环内那一档（③）确实被执行过 —— 否则本条又退化成零牙。
      expect(sentTokens).toEqual(['AT1', 'AT2'])
      // 核心判据：一个冷却标记都不许写。
      expect(pool.recorded).toEqual([])
    })

    it('★★ 全部账号被拒时不得谎称「所有账号均受限」（那是额度/限流语义）', async () => {
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool2([{ id: 'acct-1', token: 'AT1' }]),
        fetchImpl: async () => new Response(illegalChannelBody(), { status: 400 }),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).code).toBe('PERMISSION_DENIED')
      expect((error as LlmError).code).not.toBe('QUOTA_EXCEEDED')
    })

    it('★ 出口文案必须与 11140 档可区分：不得断言「安全策略拦截」', async () => {
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool2([{ id: 'acct-1', token: 'AT1' }]),
        fetchImpl: async () => new Response(illegalChannelBody(), { status: 400 }),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      // 11140 那档的文案是「全部账号均被服务端安全策略拦截」；渠道校验档必须说
      // 「未通过渠道校验」⇒ 否则用户会去停用一个其实可用的账号。
      expect((error as LlmError).message).toContain('渠道校验')
      expect((error as LlmError).message).not.toContain('安全策略拦截')
    })

    it('★ 流内（HTTP 200 + SSE 错误帧）同一形态：走本档出口', async () => {
      // 同一报文在 CodeArts 侧会以 HTTP 200 + 内嵌错误帧出现；workbuddy 侧实测为 400。
      // ⚠️ 流内那条通道**不换号**（它没有换号循环），因此这里断言的是「归到本档出口
      //    且不写冷却」，而不是请求序列 —— 换号语义由上面那几条 HTTP 400 的用例锁。
      const pool = pool2([{ id: 'acct-1', token: 'AT1' }])
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        fetchImpl: async () => sseResponse(`data: ${illegalChannelBody()}\n\n`),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      // ⚠️⚠️ 关键差异：走本档 ⇒ **不写** 30 分钟冷却。
      // 若它被 11140 档抢走，`recorded` 会有一项 —— 那正是本 PR 要修的缺陷。
      expect(pool.recorded).toEqual([])
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).message).not.toContain('安全策略拦截')
    })

    /**
     * ★★★ **「code 精确等于 11128」这一半的唯一可观测分界**（补 M4 的零牙）。
     *
     * ## 为什么上面那几条收窄用例抓不住「判据被放宽成只按 msg」
     *
     * 变异实测（M4：把腿③ 换成 `/request…illegal/`、丢掉 `"code":…11128` 那一半）：
     * **全量 256 条依然全绿**。原因是能区分两档的报文（都含 `request illegal`）
     * **同时**被 `isContentRejection` 的裸腿 `/request illegal/i` 认领 ——
     * 两条判据都命中时，落哪一档由**调用顺序**决定，而两档的外部观测量
     * （都换号、都写冷却）在这些格子上**完全相同** ⇒ 差异不可观测。
     *
     * ⇒ 要让差异可观测，必须构造一份**只有渠道校验会认领**的报文：
     * **裸文本**（既没有 `"code":11128` 也没有结构化 `msg` 键）⇒
     * - 严格判据（要求 `code` + `msg` 都在结构化字段里）⇒ **不认领** ⇒ 直接抛；
     * - 放宽判据（只扫正文里的 `request illegal`）⇒ 认领 ⇒ 走本档出口。
     *
     * 两条路的**错误文案与错误码都不同**（`PERMISSION_DENIED`/「渠道校验」vs
     * 兜底分类），所以判据一旦放宽本条立刻红。
     */
    it('★★ 裸文本报文（无 code/msg 键）⇒ 严格判据不认领，放宽成只按 msg 就会红', async () => {
      const pool = pool2([{ id: 'acct-1', token: 'AT1' }])
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        // HTML 形态的网关页：正文含该措辞，但**没有任何结构化字段**。
        // 这正是腿② 那类「非结构化兜底」的存在理由 —— 而腿③ **刻意不做**这个兜底，
        // 因为 `request illegal` 与 11140 共用，单看正文无法区分两族。
        fetchImpl: async () => new Response(
          '<html><body>400 Bad Request<br>upstream log: request illegal</body></html>',
          { status: 400 },
        ),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      // 严格判据下：既不认领渠道校验、也不认领 11140（`/request illegal/i` 会命中裸腿
      // ⇒ 实际落 11140 档）⇒ 出口必须是 11140 那句「安全策略拦截」。
      expect((error as LlmError).message).toContain('安全策略拦截')
      expect((error as LlmError).message).not.toContain('渠道校验')
      // 11140 档写冷却（这正是「两档观测量不同」的可观测锚点）。
      expect(pool.recorded.length).toBeGreaterThan(0)
    })

    it('★ 判据必须收窄到 code 精确等于 11128：11140 走它自己的档（要写冷却）', async () => {
      // ⚠️ 这是本组**最关键**的一格：`request illegal` 两族共用，若不按 code 收窄，
      //   会出现两种反向故障 ——（a）渠道校验被 11140 档抢走（写冷却）；
      //   （b）11140 被渠道校验档抢走（**不**写冷却，每轮重撞，好账号被反复试）。
      // (b) 同样致命：11140 是账号级拦截，不写冷却 ⇒ 每轮都白撞一次。
      const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
      const sentTokens: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          sentTokens.push(auth.replace('Bearer ', ''))
          return new Response(
            JSON.stringify({ code: 11140, msg: 'request illegal', requestId: 'r-1' }),
            { status: 400 },
          )
        },
      })
      await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch(() => undefined)

      // 11140 仍换号（这档的既有语义不得被本次改动破坏）。
      expect(sentTokens).toEqual(['AT1', 'AT2'])
      // ⚠️ 核心差异：11140 **要**写 30 分钟冷却 —— **两个账号各写一次**
      // （换号途中撞到的那次也写，见 `markPolicyBlockedAccount` 在 ① 档的调用）。
      // 与渠道校验档的零标记形成对照，这就是两档不可混同的可观测证据。
      expect(pool.recorded).toHaveLength(2)
      expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    })

    /**
     * ⚠️ 下面这组锁的是「**渠道校验判据**的收窄」，而不是「整个请求只发一次」。
     *
     * `request illegal` 也是 11140 族在用的措辞，所以带这句的报文大多会落进
     * `isContentRejection`（账号级拦截 → 换号 + 写冷却）—— 那是**既有行为**，
     * 本 PR 不改它（11140 族确实要换号）。
     *
     * ⇒ 断言必须区分「谁认领了它」：判据对了但 11140 档照样会换号，
     * 因此这里只锁**不写冷却**（渠道校验档的标志性处置），换号与否由上面
     * 那几条真实报文用例覆盖。
     */
    it.each([
      ['code 是 111280（子串误命中）', { code: 111280, msg: 'request illegal' }],
      ['code 是 11128.5（小数，右边界必须一并挡住）', { code: 11128.5, msg: 'request illegal' }],
      ['code 是 11128 但 msg 在别的字段（无 msg 键）', { code: 11128, tips: 'request illegal' }],
      ['request illegal 出现在 displayTips 而 msg 是内容级子原因', {
        code: 11128,
        msg: 'Illegal API invocation from an unapproved channel',
        displayTips: { en: 'rejected because request illegal' },
        __expect: 'content',
      }],
      ['request illegal 出现在 displayTips 而 msg 是其它 11128 子原因', {
        code: 11128,
        msg: 'first message is not system prompt',
        displayTips: { en: 'rejected because request illegal' },
      }],
    ])('%s ⇒ 不走渠道校验档', async (_label, body) => {
      const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
      // ⚠️⚠️ 2026-10-18（IKLYCT）：标注 `content` 的那一格**原先断言「有冷却」**，
      // 现已**随行为修正而改写** —— 它锁的恰恰是缺陷本身：
      // `msg` 是内容级子原因（换句即通）却落 11140 档写 30 分钟冷却，纯属误伤；
      // 而 IKLYCT 的反馈句**每轮必带** ⇒ 一定命中 ⇒ 整池被锁 30 分钟。
      // ⇒ 现在它归**内容级**档（零冷却）。仍留在本组：它验的是**同一件事**
      // —— 渠道校验判据不得靠 `displayTips` 认领。
      const isContentLevel = (body as { __expect?: string }).__expect === 'content'
      const payload = { ...(body as Record<string, unknown>) }
      delete payload.__expect
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        fetchImpl: async () => new Response(JSON.stringify(payload), { status: 400 }),
      })
      await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch(() => undefined)

      if (isContentLevel) {
        expect(pool.recorded, '内容级 11128 不得写账号冷却').toEqual([])
        return
      }
      // ⚠️ 这些格子都带 `request illegal` ⇒ 落 **11140** 档（既有行为，本 PR 不动）
      //⇒ **有**冷却标记。判据若被误写成「只按 msg 判」，它们会改走渠道校验档
      //   ⇒ 标记归零 ⇒ 本条立刻红。这就是「谁认领了它」的可观测分界。
      expect(pool.recorded.length).toBeGreaterThan(0)
    })

    /**
     * ★★★ **P0：排除必须覆盖 `isContentRejection` 的**全部**腿**（对抗审计证伪）
     *
     * 初版只给 `/request illegal/i` 那条加了排除，于是本组这条仍然认领 B 族报文：
     * ```json
     * {"code":11128,"msg":"request illegal","requestId":"r",
     *  "displayMsg":{"en":"The content did not pass the safety review. Please retry."}}
     * ```
     * ⚠️ `displayMsg.en` 那句正是**本仓库 `buddy-adapter.ts` 上方记录的 11140 真报文措辞**
     * （zh=「内容未通过安全审核」），而 11128 各子原因**共用/漂移 `displayMsg`** 本仓已有
     * 先例 ⇒ 不是假想形态。实测：它命中的是**第三条**腿 ⇒ 落 11140 档 ⇒ 写 30 分钟冷却
     * ⇒ **本次要修的缺陷原样复现**。
     */
    describe('P0：`displayMsg` 漂到安全审核措辞时也不得落 11140 档', () => {
      it.each([
        ['英文 safety review（与 11140 真报文逐字同句）', {
          en: 'The content did not pass the safety review. Please retry.',
        }],
        ['中文「安全审核」（11140 真报文的 zh）', {
          zh: '内容未通过安全审核，请调整后重试。',
        }],
        ['中英混排', {
          en: 'Failed the safety review.', zh: '安全审核未通过',
        }],
      ])('%s ⇒ 归渠道校验档、零冷却标记', async (_label, displayMsg) => {
        const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
        const adapter = makeAdapter({
          credential: makeCredential({ access_token: 'AT1' }),
          refresh: async () => {},
          accountPool: pool,
          fetchImpl: async () => new Response(JSON.stringify({
            code: 11128,
            msg: 'request illegal',
            requestId: 'r-1',
            displayMsg,
          }), { status: 400 }),
        })
        const error = await collectChunks(adapter, {
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'hi' }] as never,
          signal: new AbortController().signal,
        } as never).catch((e: unknown) => e)

        // 核心判据：一个冷却标记都不许写。
        expect(pool.recorded).toEqual([])
        // 且必须归到本档出口（否则「零标记」可能来自别的路径）。
        expect((error as LlmError).message).toContain('渠道校验')
        expect((error as LlmError).message).not.toContain('安全策略拦截')
      })

      it('★ 对照：真实 11140 报文**仍被全部三条腿命中**（排除不得削弱它）', async () => {
        // ⚠️ 这是本组的**反向守卫**：排除若写得太宽（例如改成「有 code 键就排除」），
        //   11140 会掉进渠道校验档 ⇒ 不写冷却 ⇒ 每轮都重撞该账号。
        const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
        const adapter = makeAdapter({
          credential: makeCredential({ access_token: 'AT1' }),
          refresh: async () => {},
          accountPool: pool,
          fetchImpl: async () => new Response(JSON.stringify({
            code: 11140,
            msg: 'request illegal',
            displayMsg: {
              en: 'The content did not pass the safety review. Please retry later.',
              zh: '内容未通过安全审核，请调整后重试。',
            },
          }), { status: 400 }),
        })
        const error = await collectChunks(adapter, {
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'hi' }] as never,
          signal: new AbortController().signal,
        } as never).catch((e: unknown) => e)

        // ⚠️ 11140 **要**写冷却，且必须落在 11140 档出口。
        expect(pool.recorded.length).toBeGreaterThan(0)
        expect((error as LlmError).message).toContain('安全策略拦截')
      })

      /**
       * ★★★ **第三条腿（`安全审核|safety review`）自己的守卫**（对抗审计指出此处零牙）
       *
       * 上面那条 P0 用例**抓不到**「删掉第三条腿」这个变异：因为
       * `isContentRejection` 开头已**早退排除** B 族报文 ⇒ 删掉第三条腿后，
       * 那条报文**根本走不到**第三条腿，结论不变 ⇒ 全绿。
       *
       * ⇒ 要让这条腿有牙，必须构造**只有它能认领**的报文：`code` 不是 11140、
       * 且 `msg` **不含** `request illegal`（否则被第二条腿认领）。
       * 下面三格正是那三种形态（`code` 是别的码 / 没有 `code` 键 / `code` 是字符串）。
       */
      describe('第三条腿自身的守卫：只有「安全审核」措辞能认领的报文', () => {
        it.each([
          ['code 是别的码（11100）', { code: 11100, msg: 'blocked', displayMsg: { zh: '内容未通过安全审核，请调整后重试。' } }],
          ['没有 code 键', { msg: 'blocked', displayMsg: { zh: '内容未通过安全审核' } }],
          ['code 是字符串 11140', { code: '11140', msg: 'blocked', displayMsg: { zh: '内容未通过安全审核' } }],
          ['英文 safety review 且无 code', { msg: 'nope', displayMsg: { en: 'The content did not pass the safety review.' } }],
        ])('%s ⇒ 仍须落 11140 档（写冷却）', async (_label, body) => {
          // ⚠️ 反证方向：删掉第三条腿 ⇒ 这些格子全部不再被认领 ⇒ 零冷却标记 ⇒ 红。
          const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
          const adapter = makeAdapter({
            credential: makeCredential({ access_token: 'AT1' }),
            refresh: async () => {},
            accountPool: pool,
            fetchImpl: async () => new Response(JSON.stringify(body), { status: 400 }),
          })
          const error = await collectChunks(adapter, {
            model: DEFAULT_MODEL,
            messages: [{ role: 'user', content: 'hi' }] as never,
            signal: new AbortController().signal,
          } as never).catch((e: unknown) => e)

          expect(pool.recorded.length).toBeGreaterThan(0)
          expect((error as LlmError).message).toContain('安全策略拦截')
        })

        /**
         * ★★ **第一条腿（`"code":11140`）自身的守卫**（对抗审计指出此处零牙）。
         *
         * 同样地，上面那些格子都被第二/第三条腿兜着 ⇒ 删掉第一条腿不会让它们变。
         * 要让第一条腿有牙，必须构造**只有它能认领**的报文：`code` 是 11140、
         * 而 `msg` 既不含 `request illegal`、报文里也没有任何安全审核措辞。
         *
         * ⚠️ 这条腿**不是本次改动引入的**（master 就有），但本次既然在同一个函数里
         * 动过（加了早退排除），就该顺手把它锁上 —— 否则将来有人删它会静默绿。
         */
        it.each([
          ['code=11140 + msg 是中性措辞', '{"code":11140,"msg":"upstream refused"}'],
          ['code=11140 + 空 msg', '{"code":11140,"msg":""}'],
          ['code=11140 + 换行/制表等空白变体', '{"code" : 11140 , "msg" : "blocked"}'],
        ])('%s ⇒ 仍须落 11140 档（写冷却）', async (_label, rawBody) => {
          // ⚠️ 反证方向：删掉 `"code":11140` 那条腿 ⇒ 这些格子不再被认领 ⇒ 零标记 ⇒ 红。
          const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
          const adapter = makeAdapter({
            credential: makeCredential({ access_token: 'AT1' }),
            refresh: async () => {},
            accountPool: pool,
            fetchImpl: async () => new Response(rawBody, { status: 400 }),
          })
          const error = await collectChunks(adapter, {
            model: DEFAULT_MODEL,
            messages: [{ role: 'user', content: 'hi' }] as never,
            signal: new AbortController().signal,
          } as never).catch(() => undefined)

          expect(pool.recorded.length).toBeGreaterThan(0)
          void error
        })
      })

      /**
       * ★★★★ **P0 复发：腿①/腿②（`conversation id missing` 形态）的排除从未被修**（2026-10-18 审计）
       *
       * ## 这是 2026-10-17 那个 P0 的**同型未修**，不是同一处
       *
       * 那次 P0 的结论是「排除必须覆盖 `isContentRejection` 的**全部**腿」，修法是
       * 在函数开头做**一次早退排除**。⚠️ 但那次排除用的判据是
       * `isChannelVerificationIllegalBody` —— 它只认**腿③**（`code==11128` 且
       * `msg` 含 `request illegal`）。而渠道校验档有**三条腿**：腿①/腿② 认的是
       * **`conversation id missing`** 形态（IKM7SG 原文措辞），**完全没被排除**。
       *
       * ## 触发形态（真实可达，仓库自己就是证据）
       *
       * ```json
       * {"code":11128,"msg":"conversation id missing",
       *  "displayMsg":{"zh":"内容未通过安全审核，请调整后重试。"}}
       * ```
       *
       * `displayMsg.zh` 那句正是**本文件上方记录的 11140 真报文**（L623-625），
       * 而「11128 各子原因共用/漂移 `displayMsg`」本仓**已有先例**（同文件注释
       * 与 `buddy-adapter.ts` 腿③ 的注释都把它列为可达形态）⇒ 不是假想报文。
       *
       * ## 后果（与本档注释明确写「不可」的那件事逐字相同）
       *
       * `isContentRejection` 认领 ⇒ 走 11140 档 ⇒ **换号 + 写 30 分钟账号冷却**
       * + 出口文案「全部账号均被服务端安全策略拦截…请停用或更换被拦账号」。
       * 而该账号**带上三头立刻 200**（IKM7SG 实测）⇒ 正是「逐请求判定、
       * 不该写账号级冷却」那一档。症状：可用账号被凭空封 30 分钟、UI 显示
       * 「限额重置」、并建议用户停用它。
       *
       * ## 为什么第一版的守卫抓不到
       *
       * 上面那条 P0 用例构造的全是 `msg:"request illegal"`（腿③形态）⇒ 早退排除
       * 生效 ⇒ 本缺陷**完全不在它们的观测范围内**。必须另造腿①形态的夹具。
       */
      describe('P0 复发：腿①/腿②（`conversation id missing` 形态）的排除', () => {
        it.each([
          ['displayMsg.zh 漂成 11140 真报文的 zh 安全审核措辞', {
            zh: '内容未通过安全审核，请调整后重试。',
          }],
          ['displayMsg.en 漂成 11140 真报文的 en safety review 措辞', {
            en: 'The content did not pass the safety review. Please retry.',
          }],
          ['displayTips 里提到安全审核（腿② 的排除同样缺失）', undefined, {
            zh: '安全审核未通过',
          }],
        ])('%s ⇒ 归渠道校验档、零冷却标记', async (_label, displayMsg, displayTips) => {
          const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
          const adapter = makeAdapter({
            credential: makeCredential({ access_token: 'AT1' }),
            refresh: async () => {},
            accountPool: pool,
            fetchImpl: async () => new Response(JSON.stringify({
              code: 11128,
              // ⚠️ IKM7SG **原文**措辞（腿①），不是本机实测的 `request illegal`。
              msg: 'conversation id missing',
              requestId: 'r-leg1',
              ...(displayMsg !== undefined ? { displayMsg } : {}),
              ...(displayTips !== undefined ? { displayTips } : {}),
            }), { status: 400 }),
          })
          const error = await collectChunks(adapter, {
            model: DEFAULT_MODEL,
            messages: [{ role: 'user', content: 'hi' }] as never,
            signal: new AbortController().signal,
          } as never).catch((e: unknown) => e)

          // 核心判据：腿①形态**同样不许**写 30 分钟账号冷却。
          expect(pool.recorded).toEqual([])
          // 且必须归到本档出口（否则「零标记」可能来自别的路径）。
          expect((error as LlmError).message).toContain('渠道校验')
          expect((error as LlmError).message).not.toContain('安全策略拦截')
        })

        it('★ 反向守卫：真实 11140 报文**仍被三条腿全部命中**（不得被这次排除削弱）', async () => {
          // ⚠️ 与腿③ 那组的反向守卫同款：排除若写得太宽（例如「有 code 键就排除」），
          //   11140 会掉进渠道校验档 ⇒ 不写冷却 ⇒ 每轮都重撞该账号。
          const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
          const adapter = makeAdapter({
            credential: makeCredential({ access_token: 'AT1' }),
            refresh: async () => {},
            accountPool: pool,
            fetchImpl: async () => new Response(JSON.stringify({
              code: 11140,
              msg: 'conversation id missing',
              displayMsg: { zh: '内容未通过安全审核，请调整后重试。' },
            }), { status: 400 }),
          })
          const error = await collectChunks(adapter, {
            model: DEFAULT_MODEL,
            messages: [{ role: 'user', content: 'hi' }] as never,
            signal: new AbortController().signal,
          } as never).catch((e: unknown) => e)

          // ⚠️ `code` 是 **11140** ⇒ 必须是 11140 档（写冷却），哪怕 `msg` 里
          //   恰好含渠道校验档的措辞 —— 这正是 code 闸门的意义。
          expect(pool.recorded.length).toBeGreaterThan(0)
          expect((error as LlmError).message).toContain('安全策略拦截')
        })

        it('★ 流内通道（HTTP 200 + SSE 错误帧）腿①形态同样归本档、零冷却', async () => {
          // ⚠️⚠️ **必须有这一格**：`consumeSse` 那条通道（L3610）也调
          // `isContentRejection`，所以同一个缺陷在流内**同样成立** ——
          // 而本文件脚注明确记录「真实的流内 11128 错误帧就是
          // `{"code":11128,"msg":"conversation id missing"}`」，**正是腿①形态**。
          //
          // ⇒ 上一组只覆盖 HTTP 400 路径时会漏掉这一半。流内的后果比 400 更重：
          // 若落进 11140 档，除了写冷却，还会把「未通过渠道校验」这条唯一出路
          // 换成「请停用该账号」。
          const pool = pool2([{ id: 'acct-1', token: 'AT1' }])
          const adapter = makeAdapter({
            credential: makeCredential({ access_token: 'AT1' }),
            refresh: async () => {},
            accountPool: pool,
            fetchImpl: async () => sseResponse(`data: ${JSON.stringify({
              code: 11128,
              msg: 'conversation id missing',
              displayMsg: { zh: '内容未通过安全审核，请调整后重试。' },
            })}\n\n`),
          })
          const error = await collectChunks(adapter, {
            model: DEFAULT_MODEL,
            messages: [{ role: 'user', content: 'hi' }] as never,
            signal: new AbortController().signal,
          } as never).catch((e: unknown) => e)

          expect(pool.recorded).toEqual([])
          expect(error).toBeInstanceOf(LlmError)
          // ⚠️ 流内 `rotated: false` ⇒ 文案是「当前账号…」，不得说「已逐个换号重试」。
          expect((error as LlmError).message).toContain('渠道校验')
          expect((error as LlmError).message).not.toContain('安全策略拦截')
        })
      })
    })

    /**
     * ★★★ **P1：`code` 与 `msg` 两个条件必须彼此独立**（对抗审计证伪）
     *
     * 初版用 `[^{}]*` 把两个条件串起来 ⇒ 引入了**JSON 字段顺序依赖**，四格漏判：
     * `msg` 排在 `code` 之前 / 中间夹嵌套对象 / `code` 是字符串 / `msg` 前有对象。
     * ⚠️ 现网报文的键序恰好是 `code` → `msg` → `displayMsg`（`msg` 紧跟 `code`），
     * 所以**当前碰不到**；但 **JSON 对象键序无任何保证**，网关重排字段就会静默漏判，
     * 漏判方向 = 回落 11140 档 = **本次要修的缺陷原样复现**。
     */
    describe('P1：字段顺序 / 嵌套 / code 类型变体同样须认', () => {
      it.each([
        ['msg 排在 code 之前', '{"msg":"request illegal","code":11128}'],
        ['code 与 msg 之间夹嵌套对象（displayMsg 前置）',
          '{"code":11128,"displayMsg":{"zh":"请求被拦截，请重新发送"},"msg":"request illegal"}'],
        ['code 是字符串', '{"code":"11128","msg":"request illegal"}'],
        ['msg 前有嵌套对象', '{"code":11128,"displayMsg":{"zh":"x"},"actions":["A"],"msg":"request illegal"}'],
      ])('%s ⇒ 仍归渠道校验档、零冷却标记', async (_label, rawBody) => {
        const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
        const adapter = makeAdapter({
          credential: makeCredential({ access_token: 'AT1' }),
          refresh: async () => {},
          accountPool: pool,
          fetchImpl: async () => new Response(rawBody, { status: 400 }),
        })
        const error = await collectChunks(adapter, {
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'hi' }] as never,
          signal: new AbortController().signal,
        } as never).catch((e: unknown) => e)

        expect(pool.recorded).toEqual([])
        expect((error as LlmError).message).toContain('渠道校验')
      })

      it('★ 反向守卫：窗口有界，跨族报文**不得**被误判进本档', async () => {
        // ⚠️ 若把「code」与「msg」两个条件的距离改成无界，`{"code":11140,…}` 里
        //   任意位置出现 `request illegal` 都会被误判成渠道校验档 ⇒ 11140 不写冷却
        //   ⇒ 每轮都重撞该账号（另一方向的回归）。
        const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
        const adapter = makeAdapter({
          credential: makeCredential({ access_token: 'AT1' }),
          refresh: async () => {},
          accountPool: pool,
          fetchImpl: async () => new Response(
            `{"code":11140,"msg":"blocked","echo":"${'x'.repeat(300)} request illegal"}`,
            { status: 400 },
          ),
        })
        await collectChunks(adapter, {
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'hi' }] as never,
          signal: new AbortController().signal,
        } as never).catch(() => undefined)

        // 必须落 11140 档 ⇒ 有冷却标记（渠道校验档是零标记）。
        expect(pool.recorded.length).toBeGreaterThan(0)
      })
    })

    /**
     * ★★★★ **P1-1：排除的值位窗口必须与归属判据腿① 同宽**（2026-10-18 对抗审计实测，本轮修）
     *
     * ## 缺陷（**我自己引入的**，方向与修复目的相反）
     *
     * 排除判据 `CHANNEL_VERIFICATION_PHRASE` 初版用 `[^"]{0,200}?`（有界，对齐腿③），
     * 而归属判据**腿①** `CHANNEL_VERIFICATION_MSG_FIELD` 用 `[^"]*`（**无界**）⇒
     * 「属不属于渠道校验」判得比「要不要写冷却」**更宽** ⇒ 两者**不再互斥**。
     *
     * 实测（措辞距 `msg` 值开头的距离）：
     * | 距离 | 排除 | 归属 | |
     * |---|---|---|---|
     * | 0 / 180 / 195 / 199 | ✅ | ✅ | 互斥，正确 |
     * | **205 / 260 / 500** | ❌ | ✅ | 🔴 落 **11140 档 ⇒ 写 30 分钟冷却** |
     *
     * ⚠️ 即：修复 A 是为消灭「可用账号被凭空封 30 分钟」，这个不对称**制造了一条
     * 同类的新触发面**（端到端实测：403 与流内 200 两条通道都写冷却）。
     *
     * ## 为什么这一组同时是「M2 零牙」的补全
     *
     * 上面记录的 M2（`{0,200}` → `*`）之所以**零牙**，正是因为既有夹具的 `msg`
     * **全是短句**。⚠️ **零牙源于夹具没覆盖边界，不是该变异无害** ——
     * 补上这组长 `msg` 夹具后，该变异即刻有牙。
     */
    describe('P1-1：排除窗口与腿① 同宽（长 msg 不得被 11140 档抢走）', () => {
      it.each([199, 205, 260, 500])('msg 前缀 %i 字符 ⇒ 归渠道校验档、零冷却标记', async (pad) => {
        const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
        const adapter = makeAdapter({
          credential: makeCredential({ access_token: 'AT1' }),
          refresh: async () => {},
          accountPool: pool,
          fetchImpl: async () => new Response(JSON.stringify({
            code: 11128,
            // ⚠️ 措辞距值开头 `pad` 个字符；腿① 是无界的，故它在**任何** pad 下都认领。
            msg: `${'x'.repeat(pad)} conversation id missing`,
            displayMsg: { zh: '内容未通过安全审核，请调整后重试。' },
          }), { status: 400 }),
        })
        const error = await collectChunks(adapter, {
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'hi' }] as never,
          signal: new AbortController().signal,
        } as never).catch((e: unknown) => e)

        // 腿① 认领 ⇒ 排除**必须**也认领，否则这份报文会落 11140 档写冷却。
        expect(pool.recorded).toEqual([])
        expect((error as LlmError).message).toContain('渠道校验')
        expect((error as LlmError).message).not.toContain('安全策略拦截')
      })
    })

    it('★★ 无 code 键、只有 msg 字段：HTML/纯文本腿不认它（code 存在性是硬要求）', async () => {
      // ⚠️ 这一格是**「按 code 收窄」的唯一可观测分界**：判据若被写成只按 msg 判
      //（丢掉 `"code":…11128` 那一半），本请求会走渠道校验档 ⇒ 换号 + **零冷却**；
      // 而现状（`isContentRejection` 认裸 `request illegal`）⇒ 落 11140 档 ⇒ **有**冷却。
      // ⚠️⚠️ **本条在「M4」变异下是零牙的**，如实登记（2026-10-17 常规审计纠正）：
      // M4 = **只**把腿③ 放宽成只按 `msg` 判，而 `isContentRejection` 的排除**保持严格**。
      // 此时这份报文在严格/放宽两种判据下**都不被渠道校验认领** ⇒ 都落11140 档 ⇒
      // 都写冷却 ⇒ 观测量相同 ⇒ 本条仍绿（见 `docs/agent-notes/providers-buddy.md` 的 M4 行）。
      // **只有腿③ 与该处排除「同时」放宽**时本条才会红 —— 那不是 M4 的定义。
      // ⇒ 保留本条的价值在于：它是「code 存在性是硬要求」这条规则的**行为锚点**
      // （将来有人把 `ILLEGAL_CODE` 整个删掉时它会红），而不是 M4 的守卫。
      const pool = pool2([{ id: 'acct-1', token: 'AT1' }, { id: 'acct-2', token: 'AT2' }])
      const sentTokens: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          sentTokens.push(auth.replace('Bearer ', ''))
          return new Response(JSON.stringify({ msg: 'request illegal' }), { status: 400 })
        },
      })
      await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch(() => undefined)

      // 落 11140 档 ⇒ 有冷却标记（渠道校验档是零标记）。
      expect(pool.recorded.length).toBeGreaterThan(0)
      // 顺带锁「确实换号了」（既有 11140 语义，本 PR 不改它）。
      expect(sentTokens).toEqual(['AT1', 'AT2'])
    })

    it('★ 粘连写法（零分隔符 requestillegal）⇒ 完全不认领，只发一次', async () => {
      // 分隔符语义与 `conversation id missing` 那组一致：形式可变但**必须存在**。
      // `requestillegal` 是 camelCase 标识符，与上游那句错**不是同一件事**。
      expect(await sentTokensFor(JSON.stringify({ code: 11128, msg: 'requestillegal' })))
        .toEqual(['AT1'])
    })

    it('★ 11128 的内容级子原因换号对它无效 ⇒ 不得被渠道校验档认领', async () => {
      // `Illegal API invocation…` 由腾讯指纹改写链路处理，每个账号都会在同一句上被拦
      // ⇒ 换号只是白烧整池（这正是隔壁 describe 锁死的那条边界）。
      const sentTokens = await sentTokensFor(JSON.stringify({
        code: 11128,
        msg: 'Illegal API invocation from an unapproved channel',
        displayMsg: { zh: '请求被安全策略拦截，请稍后重试或联系支持。' },
      }))
      expect(sentTokens).toEqual(['AT1'])
    })

    it('★ 书写变体容错：`message` 键、多空格、连字符、大写同样须换号', async () => {
      // 与 `conversation id missing` 那组同款要求：上游改一个分隔符不该让判据静默漏认。
      await expect(sentTokensFor(JSON.stringify({
        code: 11128, message: 'request  illegal',
      }))).resolves.toEqual(['AT1', 'AT2'])
      await expect(sentTokensFor(JSON.stringify({
        code: 11128, msg: 'Request-Illegal',
      }))).resolves.toEqual(['AT1', 'AT2'])
    })

    /**
     * ★★★★ **P1：限流换号循环里「②认证类 continue」排在「③渠道校验」之前**（2026-10-18 独立审计实测）
     *
     * ## 触发条件（我第一版复现**搞错了**，这里记准）
     *
     * 必须**从限流进来**：只有入口 `isRateLimited || channelRejected` 为真才进这个
     * 换号循环。若入口就是渠道校验（400/403），`channelRejected` 入口值为 `true` ⇒
     * `sawChannelVerification` **已由入口值初始化** ⇒ `③` 一次不跑也照样出口正确。
     * ⚠️ 我第一版按「混合 400/403 池」复现**全部通过**，就是这个原因。
     *
     * 真实触发：**入口 429 限流**（`channelRejected=false`）→ 循环内某账号返回
     * **403 形态**的渠道校验 → 被 ② 短路 → ③ 零次执行 → 出口判据为 false。
     *
     * | 入口 429，循环内 | 实测出口 |
     * |---|---|
     * | AT2/AT3 = **403** 渠道校验 | ❌ **`QUOTA_EXCEEDED`**「所有账号均受限，请稍后再试」 |
     * | AT2/AT3 = **400** 渠道校验 | ✅ `PERMISSION_DENIED`「未通过渠道校验」 |
     *
     * ## 后果（正是本组注释写「必须消灭」的那个形态）
     *
     * 用户看到「模型 X 所有账号均受限，请稍后再试」⇒ 以为在限额、**白等一个
     * 根本不存在的重置时刻**；而真实出路是「换号 / 停用该账号 / 换 provider」。
     *
     * ## 顺序纪律：**400 路径的换号循环已经落实**，限流路径是唯一漏的
     *
     * 400 路径那处把 `isContentRejection` 放在 401/403 腿**之前**（可观察的
     * 顺序纪律），本循环却把 ② 排在 ③ 之前 ⇒ 两条路径**判据同型、顺序相反**。
     */
    it('★ 入口限流 + 循环内 403 形态渠道校验：不得误报「所有账号均受限」', async () => {
      const convBody = illegalChannelBody()
      // ⚠️ 状态码**按 token** 返回：入口 429 触发进入限流循环，后续账号回 403 渠道校验。
      const byToken: Record<string, number> = { AT1: 429, AT2: 403, AT3: 403 }
      const pool = recordingPool([
        { id: 'acct-1', token: 'AT1' },
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ])
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        fetchImpl: async (_url: unknown, init: RequestInit) => {
          const token = (new Headers((init as RequestInit).headers as HeadersInit)
            .get('Authorization') ?? '').replace('Bearer ', '')
          const status = byToken[token] ?? 403
          // ⚠️ 入口那一发必须是**限流**（429），否则进不了这个换号循环。
          return new Response(status === 429 ? '{"code":6004,"msg":"rate limited"}' : convBody, { status })
        },
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(LlmError)
      // 核心判据：不得谎报成额度/限流语义（那会让用户白等一个重置时刻）。
      expect((error as LlmError).code).toBe('PERMISSION_DENIED')
      expect((error as LlmError).code).not.toBe('QUOTA_EXCEEDED')
      expect((error as LlmError).message).toContain('渠道校验')
    })

    it('★★ 对照：同一场景但循环内是 400 形态（③ 能执行）—— 证明变量是状态码', async () => {
      const convBody = illegalChannelBody()
      const byToken: Record<string, number> = { AT1: 429, AT2: 400, AT3: 400 }
      const pool = recordingPool([
        { id: 'acct-1', token: 'AT1' },
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ])
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        fetchImpl: async (_url: unknown, init: RequestInit) => {
          const token = (new Headers((init as RequestInit).headers as HeadersInit)
            .get('Authorization') ?? '').replace('Bearer ', '')
          const status = byToken[token] ?? 400
          return new Response(status === 429 ? '{"code":6004,"msg":"rate limited"}' : convBody, { status })
        },
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect((error as LlmError).code).toBe('PERMISSION_DENIED')
    })
  })
})

/**
 * ★★ `11128 conversation id missing` 是**按账号**生效的渠道校验，
 * 必须像 11140 一样**继续换号**（2026-10-16 真实报障）。
 *
 * ## 真实缺陷
 * workbuddy 用户看到「整条渠道全灭」。根因链：
 *
 * 1. 网关对**特定账号**在 `/v2/chat/completions` 上做渠道校验，回
 *    `HTTP 400 {"code":11128,"msg":"conversation id missing"}`；
 * 2. 该报文**不满足** `isRateLimited`（实测：对真实报文返回 `false`，与 429 对照）；
 * 3. 于是走到「其余非限流错误 ⇒ 换号无益 ⇒ 直接抛」那一支，
 *    池里其余**完全可用**的账号一个都试不到；
 * 4. 被拒账号恰是池里 workbuddy **首位** ⇒ 每轮都撞它 ⇒ 表现为「整条渠道不可用」。
 *
 * ## 实测依据（同账号 / 同网络 / 同模型，唯一变量是账号）
 * | 账号 | 不带会话头 |
 * |---|---|
 * | `66E05E7C` | ❌ 0/3（且跨约 19 分钟共 10 次全 400，`isRateLimited=false`） |
 * | `D87606B1` | ✅ 3/3 |
 * | `D3238B4E` | ✅ 3/3 |
 *
 * 三项补充实测，每一项都对应下面一条判据：
 * - 失败**只限聊天端点**（同刻 search 200 / v3-config 200）⇒ 只按码+msg 收窄，不扩大；
 * - 同一账号**带三头立刻 200** ⇒ 该账号**不是坏账号**，故**不得**写 30 分钟冷却；
 * - 拒绝持续 ≥19 分钟 ⇒ 换号是必要出路（不是「重发一次就好」）。
 *
 * ## 与 11140 的**关键差异**（决定了两个判据不同）
 * 11140 是账号级「策略拦截」，无解除时间，故写 30 分钟冷却避免每轮重撞；
 * 而本档的账号**换个请求形态就能用**（实测），写冷却会把可用账号凭空封禁 30 分钟。
 * ⇒ 换号 + **不写冷却**。
 */
describe('渠道校验（11128 conversation id missing）：按账号生效，必须换号', () => {
  /**
   * 真实上游报文（2026-10-16 本机实测，逐字取自响应体）。
   * ⚠️ 与上面 `unapprovedChannelBody`（`Illegal API invocation from an
   * unapproved channel`）是**同一 code 的不同子原因** —— 判据必须看 `msg`。
   */
  function conversationIdMissingBody(): string {
    return JSON.stringify({
      code: 11128,
      msg: 'conversation id missing',
      requestId: '72937bd4-3557-429e-9d71-220927f823dd',
      displayMsg: {
        en: 'Request blocked. Please send it again',
        zh: '请求被拦截，请重新发送',
        'zh-hant': '請求已被攔截，請重新傳送',
      },
      displayTips: {
        en: 'This call failed channel verification, possibly because it was not sent from an official client. Please resend from the official client.',
        zh: '这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。',
      },
    })
  }

  /** 同 11140 那组：记录冷却标记的账号池替身。 */
  function recordingPool(accounts: Array<{ id: string; token: string }>) {
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    return {
      recorded,
      async findAccountIdByCredential(_provider: string, identity: string) {
        return accounts.find((a) => a.token === identity)?.id ?? ''
      },
      async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      // ⚠️ **必须尊重 `exclude`**：适配器的换号循环靠它排除已试过的账号。
      // 替身若忽略它，会立刻把刚失败的那个账号再返回一次，命中
      // `tried.has(next.entry.id)` 后**立即 break**，于是「换号」根本没发生 ——
      // 用例会以「只发一次」的形式假红（误判成实现没修）。
      async getAvailableAccount(
        _provider: string,
        _modelId: string,
        exclude?: ReadonlySet<string>,
      ) {
        const next = accounts.find((a) => exclude === undefined || !exclude.has(a.id))
        if (next === undefined) return null
        return { entry: { id: next.id }, credential: makeCredential({ access_token: next.token }) }
      },
      disabledModelsFor: () => new Set<string>(),
    }
  }

  it('★★ 首个账号被拒时继续换号，换到可用账号即成功（修复前只发一次就抛）', async () => {
    // 复刻真实池顺序：acct-1 被渠道校验拒（该账号在池里排第一）、acct-2 完全可用。
    const pool = recordingPool([
      { id: 'acct-1', token: 'AT1' },
      { id: 'acct-2', token: 'AT2' },
    ])
    const sentTokens: string[] = []
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        if (token === 'AT1') return new Response(conversationIdMissingBody(), { status: 400 })
        return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 核心判据：两个账号都被试过 —— 第 1 个被拒**没有**中断换号。
    // 修复前这里是 `['AT1']`（只发一次就抛 INVALID_REQUEST）。
    expect(sentTokens).toEqual(['AT1', 'AT2'])
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
  })

  it('★ 不得为该账号写 30 分钟冷却（它不是坏账号，写冷却等于凭空封禁）', async () => {
    // 实测：该账号**带上三头立刻 200** ⇒ 它可用，只是请求形态没过校验。
    // 若照抄 11140 的 `markPolicyBlockedAccount`，会把一个可用账号封 30 分钟，
    // 且 UI 会把它显示成「限额重置」—— 完全误导。
    //
    // ⚠️⚠️ **本用例的池必须让「换号取回的那个账号」也失败**（2026-10-16 审计整改）。
    // 初版写的是 `[acct-1 被拒, acct-2 可用]` ⇒ 循环第一跳 `send(AT2)` 就 **200
    // → return**，循环内那一档（③）**一次都没执行**，`recorded` 为空是**平凡成立**。
    // 实测：把 `markPolicyBlockedAccount` 加回 ③ 档后，初版用例**仍然全绿**
    //（零牙）。现在两个账号都回同一份拒报文 ⇒ ③ 档真的被执行，判据才有牙。
    const pool = recordingPool([
      { id: 'acct-1', token: 'AT1' },
      { id: 'acct-2', token: 'AT2' },
    ])
    const sentTokens: string[] = []
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        sentTokens.push(auth.replace('Bearer ', ''))
        // **两个账号都被拒**：第二个走的是循环内那一档（③）。
        return new Response(conversationIdMissingBody(), { status: 400 })
      },
    })

    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch(() => undefined)

    // 前置条件：③ 档确实被执行过（否则本用例又退化成零牙）。
    // 判据：acct-1 走入口、acct-2 走循环内那一档 ⇒ 两个都被发过。
    expect(sentTokens).toEqual(['AT1', 'AT2'])
    // 一个冷却标记都不许写。
    expect(pool.recorded).toEqual([])
  })

  it('★ 全部账号都被拒时：报「按账号」的提示，而非「所有账号均受限」', async () => {
    // 换号试完全部候选仍失败 ⇒ 报错必须指向账号（与 11140 同口径），
    // 不得吞成 QUOTA_EXCEEDED（那会让用户以为在限额、白等）。
    const pool = recordingPool([
      { id: 'acct-1', token: 'AT1' },
      { id: 'acct-2', token: 'AT2' },
    ])
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool,
      fetchImpl: async () => new Response(conversationIdMissingBody(), { status: 400 }),
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    const code = (error as LlmError).code
    // 不得冒充额度/限流类（那两类 UI 会弹全局 Toast 并引导用户等待）。
    expect(code).not.toBe('QUOTA_EXCEEDED')
    expect(code).not.toBe('RATE_LIMIT')
    // 文案必须给出**可行动**的出路。上游 displayMsg 那句「请重新发送」是误导的：
    // 实测重发必然继续失败（跨 19 分钟 10 次全 400）。
    const message = (error as LlmError).message
    expect(message).toContain('账号')
    expect(message).not.toBe('')
  })

  it('★ 判据必须收窄到该 msg：别的 11128 子原因**不**参与换号', async () => {
    // 本 describe 的修复只新增一档，**不得**把 11128 整体放宽成「可换号」——
    // `Illegal API invocation from an unapproved channel` 由腾讯指纹改写链路处理，
    // 与账号轮换无关。
    //
    // ⚠️⚠️ **判据必须打在行为上**（2026-10-16 审计整改）。初版这条只对两个本地
    // `JSON.stringify` 字符串做 `toContain` —— 它**不 import 任何被测函数**
    //（`isChannelVerificationRejection` 也未导出，物理上无法调用），无论把判据
    // 改成恒真、恒假还是按 `code`，它**都不会红**，属恒真断言。实测：把判据放宽成
    // `/"code"\s*:\s*11128/` 时，红的是**隔壁**那条 400 用例，本条**仍绿**。
    // 现在改为真起 adapter，断言**请求序列**（唯一无法伪装的观测量）。
    async function sentTokensFor(body: string): Promise<string[]> {
      const sentTokens: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([
          { id: 'acct-1', token: 'AT1' },
          { id: 'acct-2', token: 'AT2' },
        ]),
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          sentTokens.push(auth.replace('Bearer ', ''))
          return new Response(body, { status: 400 })
        },
      })
      await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch(() => undefined)
      return sentTokens
    }

    // 本档（渠道校验）⇒ **换号**：两个账号都被试。
    expect(await sentTokensFor(conversationIdMissingBody())).toEqual(['AT1', 'AT2'])
    // 同 code 的另一子原因 ⇒ **只发一次**（不换号，也不写冷却）。
    expect(await sentTokensFor(JSON.stringify({
      code: 11128,
      msg: 'Illegal API invocation from an unapproved channel',
      displayMsg: { zh: '请求被安全策略拦截，请稍后重试或联系支持。' },
    }))).toEqual(['AT1'])
  })

  /**
   * ★★ **单账号池 / 候选全被排除**：首发即被拒时也必须走本档出口。
   *
   * ## 真实缺陷（2026-10-16 审计实测）
   *
   * `sawChannelVerification` 初版从 `false` 起算，只在「**换到下一个账号**后又被拒」
   * 时置位 ⇒ **首发**那一次失败从未被记账。池里没有第二个候选时循环第一跳就
   * `break`，两个专用出口都不命中，直接落到「所有账号均受限，请稍后再试」
   * + `QUOTA_EXCEEDED` —— 把渠道校验**误报成额度受限**，正是本档存在的理由
   * 被自己的实现推翻（作者在同文件的出口注释里亲手写下「必须先于 QUOTA_EXCEEDED」）。
   *
   * ## 为什么必须单独立组
   *
   * 上面那条「全部账号都被拒」用的是 **N=2** 池，第二个账号的被拒会走循环内那一档
   * ⇒ 恰好绕开了本缺陷。实测：把 `sawChannelVerification` 改回 `false` 初始化后，
   * 全量 183 条**依然全绿** ⇒ 本形态此前**零守卫**。
   *
   * ⚠️ 用户侧这不是罕见配置：Jet Hub 里只登录了一个 workbuddy 账号时池就是 N=1；
   * 用户按本档文案「停用该账号」操作到只剩一个时也会落到这里。
   */
  describe('单账号池 / 候选全被排除：首发被拒也必须报本档', () => {
    it('★★ N=1 池被拒 ⇒ 报本档，不得是 QUOTA_EXCEEDED', async () => {
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([{ id: 'acct-1', token: 'AT1' }]),
        fetchImpl: async () => new Response(conversationIdMissingBody(), { status: 400 }),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(LlmError)
      // 核心判据：不得吞成「所有账号均受限」（那会让用户白等一个重置时刻）。
      expect((error as LlmError).code).not.toBe('QUOTA_EXCEEDED')
      expect((error as LlmError).code).toBe('PERMISSION_DENIED')
      expect((error as LlmError).message).toContain('渠道校验')
    })

    it('★ 池里候选全被排除（getAvailableAccount 恒 null）⇒ 同样报本档', async () => {
      // 等价形态：池里有账号但都被 `enabled=false` / 限流标记挡掉。
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: {
          async findAccountIdByCredential() { return 'acct-1' },
          async updateModelRateLimit() {},
          async getAvailableAccount() { return null },
          disabledModelsFor: () => new Set<string>(),
        },
        fetchImpl: async () => new Response(conversationIdMissingBody(), { status: 400 }),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).code).toBe('PERMISSION_DENIED')
    })
  })

  /**
   * ★★ **判据的书写变体容错**（2026-10-16 审计整改）。
   *
   * 初版判据是 `/"msg"\s*:\s*"conversation id missing"/i` —— 只认**完整 JSON 片段**。
   * 下面任一上游改字都会让它**静默漏认**，退回「只试一个账号就抛」
   *（症状与本 PR 声称修好的完全同形，只是更难查：没有任何日志）。
   *
   * ⚠️ 放宽的**只是同一句 msg 的书写变体**，不是放宽成按 `code`：
   * 隔壁那条 `Illegal API invocation from an unapproved channel` 仍必须**不**命中
   *（由上面「判据必须收窄到该 msg」那条锁住）。
   */
  describe('判据容错：同一句 msg 的书写变体仍须换号', () => {
    it.each([
      ['键名写成 message', { code: 11128, message: 'conversation id missing' }],
      ['值尾部带句点', { code: 11128, msg: 'conversation id missing.' }],
      ['值前缀带空格', { code: 11128, msg: ' conversation id missing' }],
      ['内部多空格', { code: 11128, msg: 'conversation  id  missing' }],
      ['内部连字符', { code: 11128, msg: 'conversation-id missing' }],
      ['内部冒号', { code: 11128, msg: 'conversation id: missing' }],
      ['内部换行（JSON 转义 \\n）', { code: 11128, msg: 'conversation\nid missing' }],
      ['内部下划线', { code: 11128, msg: 'conversation_id missing' }],
      // ⚠️ 不可见字符按 **Unicode 类别 `\p{Cf}`** 覆盖，不枚举码点
      //（本仓在网关通配判据上已有一课：枚举码点必漏）。下面四枚是**代表性**取样。
      ['零宽空格 U+200B', { code: 11128, msg: 'conversation\u200bid missing' }],
      ['零宽非连接 U+200C', { code: 11128, msg: 'conversation\u200cid missing' }],
      ['word joiner U+2060', { code: 11128, msg: 'conversation\u2060id missing' }],
      ['BOM U+FEFF', { code: 11128, msg: 'conversation\ufeffid missing' }],
      ['软连字符 U+00AD', { code: 11128, msg: 'conversation\u00adid missing' }],
      ['全大写', { code: 11128, msg: 'Conversation ID Missing' }],
      ['error 包装形态', { error: { code: 11128, msg: 'conversation id missing' } }],
    ])('%s ⇒ 仍须换号', async (_label, body) => {
      const sentTokens: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([
          { id: 'acct-1', token: 'AT1' },
          { id: 'acct-2', token: 'AT2' },
        ]),
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          const token = auth.replace('Bearer ', '')
          sentTokens.push(token)
          return token === 'AT1'
            ? new Response(JSON.stringify(body), { status: 400 })
            : sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      const chunks = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never)

      // 换号真的发生了（不是「只发一次就抛」）。
      expect(sentTokens).toEqual(['AT1', 'AT2'])
      expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    })
  })

  /**
   * ★★ **假阳性防护**：别的 11128 子原因**引用**了这句话时，不得被当成本档。
   *
   * ## 真实回归（2026-10-16 自查实测，我**自己引入**的）
   *
   * 第一版整改把判据换成「**整份报文**裸子串」。于是只要**别的**子原因在
   * `displayTips` 里**引用**了这句话（英文提示写成
   * `If you see "conversation id missing", please resend…`），就会被判成
   * 「按账号生效」⇒ 危害是**双向**的：
   * ① 本该只发一次，变成**白烧整池往返**；
   * ② 报「全部账号均未通过渠道校验」，**误导用户去停用一个好账号**
   *   （真实原因是渠道级/消息形状级，换号毫无用处）。
   * 报文 echo 了请求体（用户消息里正好写了这句话）同型。
   *
   * ⇒ 修法：判据**优先**要求该句出现在 `msg` / `message` 的**值**里；
   * 只有当整份报文**没有**这两个键时（HTML / 纯文本网关页）才退回裸子串。
   * 对照：PR 原始判据（`/"msg"\s*:\s*"conversation id missing"/i`）在本组
   * 三格里同样是「只发一次」⇒ 本组锁的是**不得因放宽而退化**。
   */
  describe('假阳性防护：别的子原因「引用」该句时不得换号', () => {
    it.each([
      ['displayTips 引用该句', {
        code: 11128,
        msg: 'Illegal API invocation from an unapproved channel',
        displayMsg: { zh: '请求被安全策略拦截，请稍后重试或联系支持。' },
        displayTips: { en: 'If you see "conversation id missing", please resend from the official client.' },
      }],
      ['displayMsg 里带该句而 msg 是别族', {
        code: 11128,
        msg: 'first message is not system prompt',
        displayMsg: { zh: 'conversation id missing 相关的提示请忽略' },
      }],
      ['报文 echo 了请求体（用户消息里正好写了这句）', {
        code: 11128,
        msg: 'Illegal API invocation from an unapproved channel',
        echo: { user: 'what does conversation id missing mean?' },
      }],
      // ⚠️ **粘连词（零分隔符）**：分隔符语义是「形式可变但**必须存在**」。
      // 初版用 `\s*` ⇒ 允许零个 ⇒ `conversationidmissing` 这类**粘连标识符**
      // 也命中（2026-10-16 对抗性审计实测，`conversationIdMissing` 这种
      // camelCase 同样命中）⇒ 白烧整池。它们与上游那句错**不是同一件事**。
      ['粘连写法 conversationidmissing（零分隔符）', {
        code: 11128,
        msg: 'conversationidmissing',
      }],
      ['camelCase conversationIdMissing（零分隔符）', {
        code: 11128,
        msg: 'conversationIdMissing',
      }],
      // ⚠️⚠️ **结构化的非 `msg` 字段 / 请求体回声**（2026-10-16 第三轮自查实测
      // 三处**已实测可达**的误命中）。它们的共同点：报文**是结构化 JSON**（有
      // `code`），却因为「没有 `msg` 键」而被当成 HTML 兜底腿 ⇒ 误命中烧整池。
      // ⚠️ 这三格**必须走「无 `msg` 键」形态**：上面那些带 `msg` 键的格子会被
      // 腿①先接住，**根本打不到腿②**（实测：把腿②的 `+` 改成 `*`，上面两格
      // 不红 = 零牙；本组补齐后才覆盖到腿②）。
      ['该句只在 `tips` 字段（结构化 JSON、无 msg 键）', {
        code: 11128,
        tips: 'conversation id missing',
      }],
      ['`error` 是字符串且含该句（结构化 JSON、无 msg 键）', {
        code: 11128,
        error: 'conversation id missing',
      }],
      ['echo 了请求体且正文含该句（结构化 JSON、无 msg 键）', {
        code: 400,
        request: { content: 'what is conversation id missing?' },
      }],
    ])('%s ⇒ 只发一次、不换号', async (_label, body) => {
      const sentTokens: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([
          { id: 'acct-1', token: 'AT1' },
          { id: 'acct-2', token: 'AT2' },
        ]),
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          sentTokens.push(auth.replace('Bearer ', ''))
          return new Response(JSON.stringify(body), { status: 400 })
        },
      })
      await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch(() => undefined)

      // 核心判据：**没有**换号（否则就是白烧整池 + 误导用户停用好账号）。
      expect(sentTokens).toEqual(['AT1'])
    })
  })

  /**
   * ★★ **状态码闸门**：腿② 只在「该错误实际可能出现的码域」启用
   *（2026-10-16 第三轮审计 P1，本轮修）。
   *
   * ## 真实缺陷（已实测可达）
   *
   * 前三轮只治「报文体长什么样」，**没治「哪个状态码才可能出这个错」**。
   * 于是**网关 5xx 故障页**只要日志文字里恰好含该句（例：
   * `<html>502 Bad Gateway<br>upstream log: conversation id missing header</html>`
   * —— 它没有 `msg`/`code` 键，故走腿②），就会：
   *
   * | 观测 | 修复前 | 修复后 |
   * |---|---|---|
   * | 请求序列 | **烧满整池** | 只发一次 |
   * | 错误码 | `PERMISSION_DENIED`「未通过渠道校验」 | `SERVER`（5xx 既有分类） |
   * | 用户被指引 | **「在 Jet Hub 停用或调整该账号的顺序」** | — |
   *
   * ⇒ 让用户为一次网关抖动**去停用一批好账号**，且 `PERMISSION_DENIED` 不在
   * harness 可重试集合里 ⇒ 瞬时故障被报成确定性结论。
   *
   * ⚠️ 腿①（`msg`/`message` 值位）**不受**此闸门约束：它要求精确命中值位，是
   * 强证据，出现在任何状态码上都应认。
   */
  describe('状态码闸门：5xx / 429 的故障页不得被劫持成渠道校验', () => {
    it.each([
      ['502 HTML（日志含该句、无 msg 键）', '<html><body>502 Bad Gateway<br>upstream log: conversation id missing header</body></html>', 502],
      ['500 纯文本（含该句）', 'upstream error: conversation id missing header', 500],
      ['504 HTML（含该句）', '<html>504 Gateway Timeout: conversation id missing</html>', 504],
    ] as Array<[string, string, number]>)('%s ⇒ 只发一次，且码为 SERVER', async (_label, raw, status) => {
      const sentTokens: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([
          { id: 'acct-1', token: 'AT1' },
          { id: 'acct-2', token: 'AT2' },
        ]),
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          sentTokens.push(auth.replace('Bearer ', ''))
          return new Response(raw, { status })
        },
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      // 核心判据①：不得白烧整池（网关抖动与账号无关）。
      expect(sentTokens).toEqual(['AT1'])
      // 核心判据②：不得报「渠道校验 / 按账号」而误导用户停用好账号。
      expect((error as LlmError).code).not.toBe('PERMISSION_DENIED')
      expect((error as LlmError).message).not.toContain('渠道校验')
    })

    it('★ 对照：同一句出现在 `msg` 值位（腿①）时，任何状态码都仍须认', async () => {
      // 腿① 是强证据（上游确实用它报这个错）⇒ 不受状态码闸门约束。
      const sentTokens: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([
          { id: 'acct-1', token: 'AT1' },
          { id: 'acct-2', token: 'AT2' },
        ]),
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          const token = auth.replace('Bearer ', '')
          sentTokens.push(token)
          return token === 'AT1'
            ? new Response(conversationIdMissingBody(), { status: 400 })
            : sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      const chunks = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never)
      expect(sentTokens).toEqual(['AT1', 'AT2'])
      expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    })
  })

  it('★ 键名 `message` 形态：判据命中后，出口也必须提出该 msg（可诊断性不降级）', async () => {
    // ⚠️ 判据认 `m(?:sg|essage)`，出口提取器若只读 `msg`，就会出现
    // 「判据认了、出口提不出」⇒ 用户只看到 `code 11128`，那句唯一的定位文本丢失。
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: recordingPool([{ id: 'acct-1', token: 'AT1' }]),
      fetchImpl: async () => new Response(
        JSON.stringify({ code: 11128, message: 'conversation id missing' }),
        { status: 400 },
      ),
    })
    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect((error as LlmError).code).toBe('PERMISSION_DENIED')
    // 判据命中的那句 msg 必须能在文案里看到（否则排查时无从下手）。
    expect((error as LlmError).message).toContain('conversation id missing')
  })

  /**
   * ★★ **腿②（非结构化兜底腿）的两个方向都要锁**（2026-10-16 第三轮自查）。
   *
   * ## 为什么必须单独立组
   *
   * 腿①（锚定 `msg`/`message` 值位）与结构化守卫会**先**接住绝大多数形态
   * ⇒ 上面那些带 `msg` 键的用例**根本走不到腿②**。实测代价：把腿②的 `+` 改成
   * `*`（允许零分隔）后，**全量 221 条仍绿** ⇒ 腿②**零牙**。
   * 本组喂「**既没有 `msg`/`message` 键、也不是结构化 JSON 对象**」的报文体
   * ⇒ 只有腿②能接住，两个方向才测得动。
   */
  describe('腿②（非结构化兜底腿）：零分隔必须不命中、含该句必须命中', () => {
    /** 喂一份裸文本报文体，返回请求序列。 */
    async function sentTokensFor(raw: string): Promise<string[]> {
      const sentTokens: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([
          { id: 'acct-1', token: 'AT1' },
          { id: 'acct-2', token: 'AT2' },
        ]),
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          const token = auth.replace('Bearer ', '')
          sentTokens.push(token)
          return token === 'AT1'
            ? new Response(raw, { status: 400 })
            : sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch(() => undefined)
      return sentTokens
    }

    it.each([
      // ⚠️ 收紧方向：分隔符必须**存在**（粘连词不得命中）。
      ['裸文本粘连写法 conversationidmissing', 'conversationidmissing', false],
      ['裸文本 camelCase conversationIdMissing', 'conversationIdMissing', false],
      // ⚠️ 放宽方向：真实 HTML / 纯文本网关页必须**仍被接住**（否则整族漏认）。
      ['HTML 页含该句', '<html><body>gateway: conversation id missing</body></html>', true],
      ['纯文本含该句', 'error: conversation id missing', true],
      ['HTML 页含连字符变体', '<html>conversation-id missing</html>', true],
    ])('%s ⇒ %s', async (_label, raw, shouldRotate) => {
      const sent = await sentTokensFor(raw)
      expect(sent).toEqual(shouldRotate ? ['AT1', 'AT2'] : ['AT1'])
    })
  })

  /** 非 JSON 报文体：判据仍须命中（无结构化字段可锚 ⇒ 走裸子串兜底腿）。 */
  it('★ 非 JSON（HTML）报文里含该句 ⇒ 仍须换号；且文案须标注「非 JSON 报文」', async () => {    const sentTokens: string[] = []
    const html = '<html><body>gateway error: conversation id missing</body></html>'
    const adapter = makeAdapter({
      credential: makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: recordingPool([
        { id: 'acct-1', token: 'AT1' },
        { id: 'acct-2', token: 'AT2' },
      ]),
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        sentTokens.push(auth.replace('Bearer ', ''))
        return new Response(html, { status: 400 })
      },
    })
    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    // 两个账号都被试过 ⇒ 兜底腿生效。
    expect(sentTokens).toEqual(['AT1', 'AT2'])
    // ⚠️ 非 JSON 报文**无法**定位 `displayMsg` ⇒ 只能原样引用，但必须
    // ① **标注**它是网关原样输出（而不是上游的结构化错误说明）、
    // ② **抹掉**上游那句会诱导无效动作的行动指引（见下一条用例）。
    expect((error as LlmError).message).toContain('非 JSON 报文')
  })

  /**
   * ★★ **兜底腿不得把上游「请重新发送」带出来**（2026-10-16 对抗性审计实测）。
   *
   * 初版兜底腿是 `body.slice(0, 200)` **原样引用** ⇒ 审计在 5 种非 JSON / 边缘
   * 形态（仅 `message` 键 / `error` 是字符串 / JSON 数组 / HTML / 纯文本）实测
   * 都把「请重新发送」拼回了 message，**推翻了本档「文案必须自己写、不透传
   * displayMsg」这条立论**（该立论正是 `channelVerificationUpstreamId` 存在的理由）。
   *
   * ⚠️ 取舍：保留报错**标识**（code / msg / requestId —— 那是「报文是唯一定位
   * 手段」这条纪律的载体），只抹**行动指引**。故判据是「含该句 + 仍能看到标识」。
   */
  describe('兜底腿：抹掉行动指引但保留报错标识', () => {
    // ⚠️⚠️ **必须喂真实上游原句**（2026-10-16 第三轮审计实测，本轮修）：前一轮这
    // 5 格全用**合成串**（都含字面「请重新发送」）⇒ 真实报文的两句**全都漏网**：
    // | 来源 | 真实原句 | 前一轮 | 现版 |
    // |---|---|---|---|
    // | `displayMsg.zh` | `请求被拦截，请重新发送` | ✅ | ✅ |
    // | `displayTips.zh` | `…请用官方版本重新发送。` | ❌（`请` 后紧跟 `用`） | ✅ |
    // | `displayTips.en` | `…Please resend from the official client.` | ❌（**无 `again`**） | ✅ |
    // ⇒ **用例喂合成串锁不住真实文案**，这是本仓「判据必须打在行为上」的又一形态。
    const displayMsgZh = '请求被拦截，请重新发送'
    const displayTipsZh = '这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。'
    const displayTipsEn = 'This call failed channel verification, possibly because it was not sent from an official client. Please resend from the official client.'

    it.each([
      ['HTML + 真实 displayMsg.zh', `<html>conversation id missing ${displayMsgZh}</html>`, '请重新发送'],
      ['HTML + 真实 displayTips.zh', `<html>conversation id missing ${displayTipsZh}</html>`, '重新发送'],
      // ⚠️ 真实 displayTips.en 里「official client」出现**两次**：前一处
      //（`not sent from an official client`）是**描述性**的（说明为什么被拒），
      // 后一处（`Please resend from the official client`）才是**行动指引**。
      // ⇒ 断言必须锚**行动指引**那一句，而不是「文件里有没有这个词」。
      ['HTML + 真实 displayTips.en', `<html>conversation id missing. ${displayTipsEn}</html>`, 'Please resend from the official client'],
      // 下面两格保留：它们覆盖的是**非 JSON 结构**（数组 / 非字符串 JSON），
      // 与上面的「真实原句」是**两个正交维度**，都要锁。
      ['JSON 数组形态（合成串）', '[{"code":11128,"conversation id missing":"请重新发送"}]', '请重新发送'],
      ['非字符串 JSON 体（合成串）', '{code:11128,message:conversation id missing,请重新发送}', '请重新发送'],
    ])('%s ⇒ 不得带出上游的行动指引，且仍保留定位信息', async (_label, raw, forbidden) => {
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([{ id: 'acct-1', token: 'AT1' }]),
        fetchImpl: async () => new Response(raw, { status: 400 }),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      const message = (error as LlmError).message
      // ① 不得原样带出上游那句行动指引（实测重发必然继续失败）。
      expect(message).not.toContain(forbidden)
      // ② 仍必须保留**定位信息**：报文原文里那句标识必须还在
      //   （否则「先取失败会话的完整报文」这条既有排障纪律就失效了）。
      expect(message).toContain('conversation id missing')
      expect(message).toContain('非 JSON 报文')
    })

    it('★ 收紧方向：`请稍后重试` **不得**被抹（那是有效指引，服务端可能真会恢复）', async () => {
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([{ id: 'acct-1', token: 'AT1' }]),
        fetchImpl: async () => new Response(
          '<html>conversation id missing 请稍后重试</html>', { status: 400 },
        ),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)
      expect((error as LlmError).message).toContain('请稍后重试')
    })

    it('★★ JSON 路径必须带出 `requestId`（文档四处把它称为唯一定位手段）', async () => {
      // ⚠️ 实测缺陷：此前实现只取 `code`/`msg`，**一个字都没取 `requestId`** ——
      // 而本文件与 `docs/agent-notes/providers-buddy.md` 共**四处**告诉用户
      // 「先取 `requestId` 去取证」⇒ 那句纪律对用户**不可执行**。
      const requestId = '72937bd4-3557-429e-9d71-220927f823dd'
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([{ id: 'acct-1', token: 'AT1' }]),
        fetchImpl: async () => new Response(
          JSON.stringify({ code: 11128, msg: 'conversation id missing', requestId }),
          { status: 400 },
        ),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect((error as LlmError).message).toContain(requestId)
    })
  })

  /**
   * ★★ **HTTP 403 形态**：同一个渠道校验拒绝也会以 403 出现（2026-10-16 审计实测）。
   *
   * ## 为什么必须单独立组
   *
   * 上游同一族拒绝**同时用 400 与 403 两种状态码**（本文件 `isContentRejection`
   * 的注释就有成文记录：11140「也回 HTTP 403」）。整改第一版只接了 400 与流内
   * 200 ⇒ 403 落到 `所有账号均被拒绝（HTTP 403）` 分支，码为
   * `httpErrorCode(403)` = **`AUTH`**。
   *
   * ⚠️ `AUTH` 是本仓库的**红线码**（`docs/agent-notes/client-ui.md` 的 IKLBSH）：
   * DSH 客户端会把 message **整个换成「API 密钥无效」** ⇒ 本档精心写的
   * 「重发无效 / 停用该账号」一个字都到不了用户眼前，而实测 token 全部有效。
   * 故断言**必须**同时锁「码不是 AUTH」与「文案是渠道校验文案」。
   */
  describe('HTTP 403 形态：同样不得报成 AUTH', () => {
    it('★★ 403 + 渠道校验拒绝 ⇒ 报本档文案（码不得是 AUTH）', async () => {
      const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        fetchImpl: async () => new Response(conversationIdMissingBody(), { status: 403 }),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(LlmError)
      // 核心判据①：`AUTH` 会吞掉整条 message（客户端换成「API 密钥无效」）。
      expect((error as LlmError).code).not.toBe('AUTH')
      expect((error as LlmError).code).toBe('PERMISSION_DENIED')
      // 核心判据②：文案必须真的到得了用户眼前，且不得带上游那句误导。
      expect((error as LlmError).message).toContain('渠道校验')
      expect((error as LlmError).message).not.toContain('请重新发送')
      // 该账号并非坏账号 ⇒ 不得写冷却。
      expect(pool.recorded).toEqual([])
    })

    it('★ 403 + 400 混池：两次都被拒仍报本档，且不写冷却', async () => {
      const pool = recordingPool([
        { id: 'acct-1', token: 'AT1' },
        { id: 'acct-2', token: 'AT2' },
      ])
      const sent: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        // ⚠️ 401/403 路径的**既有语义**：先刷新当前账号并重发一次，才进入换号。
        // 故固定刷新后的凭据仍是 AT1，序列才是可预期的（否则 `makeAdapter` 默认
        // 返回 token `AT`，序列里会多出一个与池无关的值 —— 那是**测试替身**造成的，
        // 不是被测行为；别把它误读成「多发一次」的缺陷）。
        postRefreshCredential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          const token = auth.replace('Bearer ', '')
          sent.push(token)
          // 首发 403、换号后 400 —— 两种状态码都要被同一档接住。
          return new Response(conversationIdMissingBody(), { status: token === 'AT1' ? 403 : 400 })
        },
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      // ⚠️ 不锁精确请求序列（如实登记一处**既有**结构边界）：401/403 段与 400 段
      // 各有自己的 `triedAuth` / `tried` 局部集合，**两者不共享** ⇒ 「首发 403、
      // 换号后 400」会跨段重复试一次已试过的账号（实测序列
      // `["AT1","AT1","AT2","AT1"]`，末位即跨段重复）。该重复是**两段式结构的
      // 既有代价**，非本次改动引入；本次改动只是让 403 形态也走到这里
      //（此前它直接抛 `AUTH`，代价是**码错误**——远比一次多余往返严重）。
      // 登记在案，不在本 PR 范围内重构。
      expect(sent).toContain('AT2')          // 换号真的发生了
      expect((error as LlmError).code).toBe('PERMISSION_DENIED')
      expect(pool.recorded).toEqual([])
    })
  })

  /**
   * ★★ **流内通道**（HTTP 200 + SSE 内嵌 11128 `conversation id missing` 帧）。
   *
   * ## 真实缺陷（2026-10-16 审计实测）
   *
   * 本文件 `isContentRejection` 的注释早就记着「同一报文在 CodeArts 侧就以
   * HTTP 200 + 内嵌错误帧的形式出现」，而本档第一版**只改了 HTTP 通道**
   * ⇒ 该形态下：① 不换号；② 帧无 `choices` 也无 `error` ⇒ 零内容块 ⇒
   * 被改写成 `EMPTY_RESPONSE`；③ 而 `EMPTY_RESPONSE` **在** harness 的
   * `DEFAULT_RETRYABLE_CODES` 里（`retry-policy.js`，`DEFAULT_MAX_RETRIES = 5`）
   * ⇒ **白退避重试至多 5 次**，每次重撞同一个被拒账号，用户看到的还是
   * 「模型没返回内容」—— 原因完全错位。
   *
   * 实测（修复前）：`sent=["AT1"]`、下发 `finish(error)` 帧、code `EMPTY_RESPONSE`。
   */
  describe('流内 200 + 内嵌错误帧：同样不得静默/误报', () => {
    it('★★ 内嵌 conversation id missing 帧 ⇒ 报本档，不得是 EMPTY_RESPONSE', async () => {
      const sentTokens: string[] = []
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([
          { id: 'acct-1', token: 'AT1' },
          { id: 'acct-2', token: 'AT2' },
        ]),
        fetchImpl: async (_url, init) => {
          const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
          sentTokens.push(auth.replace('Bearer ', ''))
          // 两站均下发 200 + 内嵌错误帧（无 choices、无 error）。
          return sseResponse(`data: ${conversationIdMissingBody()}\n\n`)
        },
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(LlmError)
      // 核心判据：不得落进**可重试**的 `EMPTY_RESPONSE`（那会白退避至多 5 次）。
      expect((error as LlmError).code).not.toBe('EMPTY_RESPONSE')
      expect((error as LlmError).code).toBe('PERMISSION_DENIED')
      // 流内档**刻意不重发**（重发需要「尚未产出内容」的判据 + 外层循环）：
      // 请求序列必须仍是只发一次，文案也必须如实说「当前账号」而不是「全部账号」。
      expect(sentTokens).toEqual(['AT1'])
      expect((error as LlmError).message).toContain('流内')
    })

    it('★★ 门禁：正文里出现该措辞的正常回答**不得**被判成拒绝', async () => {
      // ⚠️⚠️ **本条锁的是 `data.choices === undefined &&` 这道门禁**
      //（2026-10-16 对抗性审计实测：删掉该门禁后**全量用例仍绿** ⇒ 零守卫）。
      //
      // 门禁的必要性：模型完全可以**在正常回答里复述这个措辞**
      //（用户问「conversation id missing 是什么意思」时必然如此——本仓库自己的
      // 测试夹具里就装满这句话）。没有门禁 ⇒ 整轮回答被判成渠道校验拒绝：
      // 实测变异态 `chunks=[]` + `PERMISSION_DENIED`，用户看到的是
      // 「当前账号未通过渠道校验」而**答案整段丢失**。
      //
      // 与 11140 侧同款保护（那条有守卫），本档此前**没有** ⇒ 本组补齐。
      const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        // 有效内容帧：**带 choices**，正文里含该措辞。
        fetchImpl: async () => sseResponse(
          'data: {"choices":[{"delta":{"content":"conversation id missing 是腾讯网关的错误码"},"finish_reason":null}]}\n\n'
          + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
          + 'data: [DONE]\n\n',
        ),
      })
      const chunks = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never)

      // 核心判据：正文必须**完整产出**，不得被当成拒绝（那会丢掉整轮回答）。
      expect(chunks.some((c) => c.type === 'text-delta'
        && String((c as { text?: string }).text).includes('conversation id missing'))).toBe(true)
      // 也不得写账号冷却（这个账号没问题）。
      expect(pool.recorded).toEqual([])
    })

    it('★ 流内报文的「安全审核」子原因仍走 11140 档（不得被本档抢走）', async () => {
      // 顺序锁：`isContentRejection` 与 `isChannelVerificationRejection` 在流内是
      // 两个并列分支，11140 必须**先**判（它要写账号冷却，语义更强）。
      const pool = recordingPool([{ id: 'acct-1', token: 'AT1' }])
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: pool,
        fetchImpl: async () => sseResponse(`data: ${JSON.stringify({
          code: 11140,
          msg: 'request illegal',
          displayMsg: { zh: '内容未通过安全审核，请调整后重试。' },
        })}\n\n`),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      expect((error as LlmError).code).toBe('PERMISSION_DENIED')
      expect((error as LlmError).message).toContain('安全策略拦截')
      // 11140 档必须**写冷却**（与上面 11128 档刻意不写形成对照）。
      expect(pool.recorded).toHaveLength(1)
    })
  })

  /**
   * ★★ **文案不得诱导用户做无效动作**（2026-10-16 审计整改）。
   *
   * 作者在 `channelVerificationError` 的注释里花整段论证「文案必须自己写，
   * 不能透传上游 `displayMsg`」—— 因为上游那句是「请求被拦截，**请重新发送**」，
   * 而实测重发必然继续失败。
   *
   * ⚠️ 但初版实现末尾用 `errorDetail(body)` 拼「上游原文」，而 `errorDetail` 的
   * **第一优先级正是 `displayMsg.zh`** ⇒ 同一条 message 里前半说「重发无效」、
   * 后半说「请重新发送」，自相矛盾（审计实测到该产物）。
   */
  describe('出口文案：不得把上游「请重新发送」拼回来', () => {
    it('★★ 文案不得含上游 displayMsg 的「请重新发送」，也不得含字面 Markdown 星号', async () => {
      const adapter = makeAdapter({
        credential: makeCredential({ access_token: 'AT1' }),
        refresh: async () => {},
        accountPool: recordingPool([{ id: 'acct-1', token: 'AT1' }]),
        fetchImpl: async () => new Response(conversationIdMissingBody(), { status: 400 }),
      })
      const error = await collectChunks(adapter, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never).catch((e: unknown) => e)

      const message = (error as LlmError).message
      // 上游 displayMsg.zh 逐字为「请求被拦截，请重新发送」——不得出现。
      expect(message).not.toContain('请重新发送')
      expect(message).not.toContain('请求被拦截')
      // 仍必须**保留可诊断性**：上游 code / msg 要能看到（报文是唯一排查手段）。
      expect(message).toContain('11128')
      expect(message).toContain('conversation id missing')
      // 错误 message 是**纯文本**渲染：字面 `**` 会原样显示成星号。
      expect(message).not.toContain('**')
    })
  })
})

/**
 * ★★ **残缺目录必须能补齐**（issue IKJVTF 复审，审计 I3）。
 *
 * buddy 是**双端点** provider：`/console/enterprises/{scope}/models`（scoped）
 * 与 `/v3/config`，两者 id 集合**不同**、必须取并集（`hy4-preview-f` 只在后者，
 * 而「限时免费」促销挂在那一个 id 上）。故「一个成功、一个失败」是**常态**。
 *
 * 失败路径静默返回空 ⇒ 旧判据 `models.length > 0` 把它当完整 ⇒ 永久缓存
 * ⇒ 只在另一个端点下发的变体及其促销倍率（`creditsRate`）再也回不来
 *（用户报障原话：「hy4 preview 现在 ide 是免费我们还是 0.29」）。
 *
 * ⚠️ 断言必须是**行为**（清冷却后真的重拉并补齐），不能只断言 `gate.cooling()`
 * —— 后者在生产路径上读不到，是**假绿**。
 */
describe('BuddyAdapter 残缺目录自愈（★ IKJVTF I3）', () => {
  it('★ 残缺（complete=false）⇒ 展示但**不**永久缓存，冷却后重拉补齐', async () => {
    let calls = 0
    let complete = false
    // ⚠️ 观测点必须是**只由远端下发**的字段（`creditsRate` = 促销倍率）：
    // `reconcileWithFallback` 是白名单重建，兜底表里的 id 残缺时**仍在**列表里，
    // 故「id 是否出现」判不出补齐。而 `creditsRate` 只在远端下发
    //（兜底表是编译期快照，价格会变，不写死）—— 这正是 issue 里用户看到的
    // 「hy4 preview 现在 ide 是免费我们还是 0.29」。
    //
    // ⚠️ `hy4-preview-f` **不在** CODEBUDDY 兜底表里（实测兜底表 16 个 id 不含它），
    // 它靠 `reconcileWithFallback` 的**例外**保留：`agentReferenced === true`
    // （服务端声明「对话里可选」，正是真实形态）或远端声明 `supportsImages`。
    // 不给这两个信号时它会被白名单重建丢掉 —— 那是既有设计，与本用例无关。
    const firstBatch = [
      { id: 'hy4-preview', name: 'Hy4 Preview' },
    ] as never
    const fullBatch = [
      { id: 'hy4-preview', name: 'Hy4 Preview' },
      { id: 'hy4-preview-f', name: 'Hy4 Preview F', creditsRate: '0', agentReferenced: true },
    ] as never
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls += 1
        return complete ? fullBatch : firstBatch
      },
      catalogComplete: () => complete,
    })

    const first = await adapter.listModels('buddy')
    // ① 残缺目录照常展示
    expect(first.map((m) => m.id)).toContain('hy4-preview')
    // ② 落进了缓存
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeDefined()
    // ③ 但没被标成完整 —— 这是短路的判据
    expect((adapter as unknown as { remoteComplete: boolean }).remoteComplete).toBe(false)

    // ④ 冷却窗口内不重复打请求
    const afterFirst = calls
    await adapter.listModels('buddy')
    expect(calls).toBe(afterFirst)

    // ⑤ ★ 核心：清冷却（等价「冷却到期」）+ 上游已完整 ⇒ **真的重拉补齐**
    complete = true
    ;(adapter as unknown as { catalogGate: { reset(): void } }).catalogGate.reset()
    await adapter.listModels('buddy')
    expect(calls).toBeGreaterThan(afterFirst)
    // 补齐的判据是**远端独有的促销倍率**回来了
    expect((adapter as unknown as { remoteMeta: Map<string, { creditsRate?: string }> }).remoteMeta
      .get('hy4-preview-f')?.creditsRate).toBe('0')
    // ⑥ 补齐后转为完整 ⇒ 不再重拉
    expect((adapter as unknown as { remoteComplete: boolean }).remoteComplete).toBe(true)
    const afterSecond = calls
    await adapter.listModels('buddy')
    expect(calls).toBe(afterSecond)
  })

  it('★ 完整（complete=true）⇒ 清冷却，后续零请求', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls += 1
        return [{ id: 'hy4-preview', name: 'Hy4 Preview' }] as never
      },
      catalogComplete: () => true,
    })

    await adapter.listModels('buddy')
    expect((adapter as unknown as { remoteComplete: boolean }).remoteComplete).toBe(true)
    const afterFirst = calls
    await adapter.listModels('buddy')
    expect(calls).toBe(afterFirst)
  })

  it('★ 未注入 catalogComplete（旧替身）⇒ 退回旧行为（complete = got）', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls += 1
        return [{ id: 'hy4-preview', name: 'Hy4 Preview' }] as never
      },
    })

    await adapter.listModels('buddy')
    expect((adapter as unknown as { remoteComplete: boolean }).remoteComplete).toBe(true)
    const afterFirst = calls
    await adapter.listModels('buddy')
    expect(calls).toBe(afterFirst)
  })
})

/**
 * 腾讯系内容级风控指纹改写的**直连**落点（2026-10-12 真实报障）。
 *
 * ## 这组用例守的是什么
 * 网关那侧早有改写（IKJNA1），但**直连路径**没有 —— 而触发面在
 * `assistant` **正文**（实测 400/11128；`user` / `tool` 结果 /
 * `reasoning_content` / `tool_calls[].arguments` 都不拦）。
 * 于是「排查这个风控 bug 的会话」几乎必然中招：模型先 `read` 记录该指纹
 * 的文档（tool 结果，不拦），再把它**逐字复述进自己的正文**（拦）；那句一旦
 * 进了历史就每轮原样重放，会话从此报废，且**换任何腾讯系模型都一样**
 * ——用户当时报的就是 `step-5-preview` 与 `space-bunny` 同一个错。
 *
 * ## 断言为什么必须成对
 * 「该改的改了」与「不该改的一字没动」必须同时锁：
 * 只测前者，实现会一路扩写成「把整份历史都洗一遍」，那会破坏用户原话、
 * 工具输出（要回读给模型看的证据）与模型自己的思考，并且白吃腾讯侧的
 * 前缀缓存。每条「扩大范围」的冲动都该在这里变红。
 */
describe('BuddyAdapter 直连路径的腾讯风控指纹改写', () => {
  const TRIGGER = 'Main branch (you will usually use this for PRs)'
  const REWRITE = 'Main branch (PRs usually go here)'

  /** 走真实适配器发一次，返回**请求体里**的 messages（即 wire 形状）。 */
  async function wireOf(
    messages: readonly unknown[],
    extra: Record<string, unknown> = {},
    product?: BuddyProduct,
  ): Promise<Array<Record<string, any>>> {
    let body: Record<string, unknown> = {}
    const adapter = makeAdapter({
      ...(product === undefined ? {} : { product }),
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: 'glm-5.3',
      messages,
      signal: new AbortController().signal,
      ...extra,
    } as never)
    return (body.messages ?? []) as Array<Record<string, any>>
  }

  /** 收集 wire 上的全部文本（content 为字符串或 parts 数组两种形态都要覆盖）。 */
  function textsOfWire(messages: ReadonlyArray<Record<string, any>>): string[] {
    const out: string[] = []
    for (const message of messages) {
      const c = message.content
      if (typeof c === 'string') out.push(c)
      else if (Array.isArray(c)) {
        for (const block of c) {
          if (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
            out.push(String((block as { text: unknown }).text))
          }
        }
      }
    }
    return out
  }

  const text = (value: string) => [{ type: 'text', text: value }]

  it('★ system 与 assistant 正文里的指纹都被改写', async () => {
    const wire = await wireOf([
      { role: 'system', content: text(`S: ${TRIGGER}`) },
      { role: 'user', content: text('继续') },
      { role: 'assistant', content: text(`A: ${TRIGGER}`) },
      { role: 'user', content: text('再说一次') },
    ])
    const texts = textsOfWire(wire)
    expect(texts).toContain(`S: ${REWRITE}`)
    expect(texts).toContain(`A: ${REWRITE}`)
    expect(texts.some((value) => value.includes(TRIGGER))).toBe(false)
  })

  it('★ options.system（绕过 serializeMessages 的第四个产出点）同样被改写', async () => {
    // `stream()` 里 `messages.unshift({role:'system', content: options.system})`
    // 排在 `serializeMessages` **之外**，只改那个函数救不到这条路。
    const wire = await wireOf([{ role: 'user', content: text('hi') }], {
      system: `O: ${TRIGGER}`,
    })
    expect(wire[0]?.role).toBe('system')
    expect(String(wire[0]?.content)).toBe(`O: ${REWRITE}`)
  })

  it('★ 不该改的一字不动：user / tool 结果 / reasoning_content / tool_calls.arguments', async () => {
    // 这四个位置实测都**不拦**（依据见 openai-gateway/tencent-fingerprint.ts 的表）。
    // 改它们换不来放行，只会篡改用户原话与证据，并白吃上游前缀缓存。
    const wire = await wireOf([
      { role: 'system', content: text('You are helpful.') },
      { role: 'user', content: text(`U: ${TRIGGER}`) },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: `R: ${TRIGGER}` },
          { type: 'text', text: '干净正文' },
          { type: 'tool-call', id: 'call-1', name: 'read', arguments: `{"q":"${TRIGGER}"}` },
        ],
      },
      { role: 'tool', toolCallId: 'call-1', content: text(`T: ${TRIGGER}`) },
      { role: 'user', content: text('结果如何') },
    ])
    const texts = textsOfWire(wire)
    // 没有任何一处被改写
    expect(texts.some((value) => value.includes(REWRITE))).toBe(false)
    // user 与 tool 结果原样
    expect(texts).toContain(`U: ${TRIGGER}`)
    expect(texts).toContain(`T: ${TRIGGER}`)
    // assistant 正文原样（它本来就不含指纹）
    expect(texts).toContain('干净正文')
    const assistant = wire.find((message) => message.role === 'assistant') as Record<string, any>
    // reasoning_content 与工具参数都保持原文
    expect(String(assistant.reasoning_content)).toBe(`R: ${TRIGGER}`)
    expect(String(assistant.tool_calls[0].function.arguments)).toContain(TRIGGER)
  })

  it('★ 不含指纹的历史：wire 逐字节不变（不得破坏腾讯侧前缀缓存）', async () => {
    const original = 'On branch master\nYour branch is up to date.\nNothing to commit.'
    const wire = await wireOf([
      { role: 'system', content: text('You are helpful.') },
      { role: 'assistant', content: text(original) },
      { role: 'user', content: text('继续') },
    ])
    const assistant = wire.find((message) => message.role === 'assistant') as Record<string, any>
    expect(assistant.content).toBe(original)
  })

  it('★ WorkBuddy（国际版）同样生效：两个产品共用这一层', async () => {
    const wire = await wireOf(
      [
        { role: 'system', content: text('You are helpful.') },
        { role: 'assistant', content: text(`A: ${TRIGGER}`) },
        { role: 'user', content: text('继续') },
      ],
      {},
      WORKBUDDY,
    )
    expect(textsOfWire(wire)).toContain(`A: ${REWRITE}`)
  })

  it('★ IKLS2L：Claude Code 身份句在**直连**路径也被改写（system 与 assistant 两处）', async () => {
    // Claude Code 的 `[model-check]` 探测路径漏传 `skipSystemPromptPrefix`，
    // 于是身份句每次都被注入 system ⇒ 每次 400/11128（Gitee IKLS2L）。
    // 这条守的是「DSH 直连方向也过这一层」—— 只在网关补 = 换一个入口又被拦。
    const C_TRIGGER = "You are Claude Code, Anthropic's official CLI for Claude"
    const C_REWRITE = "You are Claude Code, Anthropic's CLI for Claude"
    // ① options.system（第四个产出点）
    const viaSystem = await wireOf([{ role: 'user', content: text('hi') }], { system: `${C_TRIGGER}.` })
    expect(viaSystem[0]?.role).toBe('system')
    expect(String(viaSystem[0]?.content)).toBe(`${C_REWRITE}.`)
    // ② serializeMessages 的 system 与 assistant 正文两处
    const wire = await wireOf([
      { role: 'system', content: text(`S: ${C_TRIGGER}`) },
      { role: 'user', content: text('继续') },
      { role: 'assistant', content: text(`A: ${C_TRIGGER}`) },
      { role: 'user', content: text('再说一次') },
    ])
    const texts = textsOfWire(wire)
    expect(texts).toContain(`S: ${C_REWRITE}`)
    expect(texts).toContain(`A: ${C_REWRITE}`)
    // user 不碰（实测该角色放行）。
    expect(texts).toContain('继续')
    expect(texts.some((value) => value.includes(C_TRIGGER))).toBe(false)
  })

  it('★ IKLYCT：Claude Code 反馈句在**直连**路径也被改写（system 与 assistant 两处）', async () => {
    // 这一条比 IKLS2L 那条更严重：反馈句属于 Claude Code system 的**固定段落**，
    // 客户端把默认 system 整份发过来就必然带上 ⇒ 漏改写 = 每轮 400/11128。
    // 直连方向同样必须过这一层：只在网关补 = 换一个入口又被拦（IKJNA1 的教训）。
    const F_TRIGGER = 'To give feedback, users should report the issue at '
      + 'https://github.com/anthropics/claude-code/issues'
    const F_REWRITE = 'To give feedback, users should report the issue at the project issue tracker'
    // ① options.system（第四个产出点）
    const viaSystem = await wireOf([{ role: 'user', content: text('hi') }], { system: `  - ${F_TRIGGER}` })
    expect(viaSystem[0]?.role).toBe('system')
    expect(String(viaSystem[0]?.content)).toBe(`  - ${F_REWRITE}`)
    // ② serializeMessages 的 system 与 assistant 正文两处
    const wire = await wireOf([
      { role: 'system', content: text(`S: ${F_TRIGGER}`) },
      { role: 'user', content: text(`U: ${F_TRIGGER}`) },
      { role: 'assistant', content: text(`A: ${F_TRIGGER}`) },
      { role: 'user', content: text('再说一次') },
    ])
    const texts = textsOfWire(wire)
    expect(texts).toContain(`S: ${F_REWRITE}`)
    expect(texts).toContain(`A: ${F_REWRITE}`)
    // ⚠️ **user 必须逐字保留**：实测该角色放行 ⇒ 改它换不来放行，只是篡改用户原话。
    // 这条不是「顺便断言」—— 若把 user 也过一遍改写，下面 `some(...)` 会红。
    expect(texts).toContain(`U: ${F_TRIGGER}`)
    expect(texts.filter((value) => value.includes(F_TRIGGER))).toHaveLength(1)
  })

  /**
   * 首条角色（2026-10-12 实测，与上面的指纹问题是**两件事**）。
   *
   * 同一份请求体，仅让首条变成「带 tool_calls 的 assistant」：
   *   `space-bunny` → 400/11148 `tool calls and tool results do not match`
   *                   （`displayMsg.zh`=「工具记录不完整，请新建任务」）
   *   `step-5-preview` → 200（宽容）
   * 而在前面补一条 system，两个模型都 200。
   *
   * ⚠️ 这条的价值在于**反直觉**：报错文案说的是「工具记录不匹配」，但逐格核对
   * 真实 wire 后配对是干净的（无孤儿、无重复、覆盖完整）—— 真正的判据是**首条
   * 角色**。按文案去改配对逻辑会修一个不存在的原因。
   */
  /**
   * 非腾讯系产品经 BuddyAdapter 时**逐字节不变**（2026-10-12 审计补的 F1/F2 防线）。
   *
   * ## 为什么这条不可省
   * `buddy` 与 `workbuddy` **都在** `TENCENT_PROVIDERS` 那张表里，所以
   * 「喂 WORKBUDDY 也能改写」那条用例**无法区分**「读 `this.product.id`」与
   * 「写死 `'buddy'`」。审计实测把 `serializeMessages(…, this.product.id)` 改成
   * `serializeMessages(…, 'buddy')`（完全忽略产品配置）后，163 条用例**全绿** ——
   * 那条 WorkBuddy 用例是**改坏也不红**的同义反复。
   *
   * 只有「**非**腾讯系 provider 必须原样返回」这条能把它区分开：产品 id 换成
   * 集合外的值时，写死 `'buddy'` 会去改写、而本实现必须不动 ⇒ 立刻分岔。
   *
   * ⚠️ `as never` 是**刻意**的：`BuddyProduct.id` 是 `'buddy' | 'workbuddy'`
   * 联合类型，构造「非腾讯系」产品本就该被类型系统拦住。这里要测的是**运行时**
   * 判据（`isTencentContentFingerprintProvider` 遇到未知 id 的行为），故必须
   * 绕过类型；真实产品里没有第三个 buddy 系成员，只能这么造。
   */
  it('★ 非腾讯系产品：wire 逐字节不变（provider 被写死 buddy 时这条会红）', async () => {
    const nonTencent = { ...CODEBUDDY, id: 'not-tencent', displayName: 'Not Tencent' } as never as BuddyProduct
    const wire = await wireOf(
      [
        { role: 'system', content: text(`S: ${TRIGGER}`) },
        { role: 'user', content: text('hi') },
        { role: 'assistant', content: text(`A: ${TRIGGER}`) },
        { role: 'user', content: text('继续') },
      ],
      {},
      nonTencent,
    )
    const texts = textsOfWire(wire)
    expect(texts).toContain(`S: ${TRIGGER}`)
    expect(texts).toContain(`A: ${TRIGGER}`)
    expect(texts.some((value) => value.includes(REWRITE))).toBe(false)
  })

  describe('wire 首条必须是 system', () => {
    const assistantWithCall = {
      role: 'assistant',
      content: [
        { type: 'text', text: '我读一下。' },
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"q":"x"}' },
      ],
    }
    const toolResult = { role: 'tool', toolCallId: 'call-1', content: text('result body') }

    it('★ 历史被削头到以 assistant 开头时，补一条最小 system 在首位', async () => {
      const wire = await wireOf([assistantWithCall, toolResult, { role: 'user', content: text('然后呢') }])
      expect(wire[0]?.role).toBe('system')
      expect(String(wire[0]?.content)).toBe('You are a helpful assistant.')
      // 补位不得破坏原有的工具配对：调用仍在、结果仍在，且紧随其后
      expect(wire[1]?.role).toBe('assistant')
      expect((wire[1]?.tool_calls as Array<Record<string, any>>)[0].id).toBe('call-1')
      expect(wire[2]?.role).toBe('tool')
    })

    /**
     * ⚠️ 这条覆盖 2026-10-12 审计抓出的**真缺陷**：原判据是 `=== 'assistant'`，
     * 漏掉 **user-first / tool-first** 的历史 —— 而本仓库 `account-probe.ts` 的
     * `PROBE_SYSTEM` 注释里有 2026-09-25 的双端点对照实测：**WorkBuddy 网关
     * 强制 `messages[0]` 是 system**，否则 400 + 11128。
     * 那类历史真实存在（历史被压缩削头；DSH 一次性调用只带 user 不带 system）。
     */
    it.each([
      ['user 开头', [{ role: 'user', content: text('hi') }]],
      ['tool 开头', [assistantWithCall, toolResult]],
      ['assistant 开头', [assistantWithCall, toolResult]],
    ])('★ 历史以 %s 时补 system（WorkBuddy 网关强制首条是 system）', async (_label, messages) => {
      const wire = await wireOf(messages as readonly unknown[])
      expect(wire[0]?.role).toBe('system')
      expect(wire.filter((m) => m.role === 'system')).toHaveLength(1)
    })

    it('★ 首条已有 system 时不多塞一条', async () => {
      const withSystem = await wireOf([
        { role: 'system', content: text('You are helpful.') },
        { role: 'user', content: text('hi') },
      ])
      // 只有用户自己那一条，且内容不被换掉
      expect(withSystem.filter((m) => m.role === 'system')).toHaveLength(1)
      expect(String(withSystem[0]?.content)).toBe('You are helpful.')
    })

    it('★ options.system 已在首位时不重复补位', async () => {
      const wire = await wireOf([assistantWithCall, toolResult], { system: 'Real system prompt.' })
      const systems = wire.filter((m) => m.role === 'system')
      expect(systems).toHaveLength(1)
      expect(String(systems[0]?.content)).toBe('Real system prompt.')
    })
  })
})
