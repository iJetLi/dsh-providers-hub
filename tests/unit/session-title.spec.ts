/**
 * `purpose: 'session-title'` 的思考关闭与预算兜底（issue IKKVDH）。
 *
 * ## 被锁死的缺陷
 *
 * DSH 的 `@deepseek-ai/dsh-session-title-llm` 用 **64 token** 发会话标题请求、
 * **不传 `reasoningEffort`**、带 `purpose: 'session-title'`。宿主会把模型声明的
 * 默认档注入进来（`effective = requested ?? reasoning.defaultEffort`），
 * 而本插件各适配器**从不读 `options.purpose`** ⇒ 标题请求带着思考发出 ⇒
 * 思考把 64 个 token 全部吃满、正文 0 字符、`finish_reason: 'length'` ⇒
 * DSH 的 `finishError()` 直接拒绝 ⇒ 标题永远停在 fallback。
 *
 * 实测（2026-10-11，本机真实凭据，CodeBuddy `deepseek-v4.1-flash`）：
 *
 * | 请求的思考控制 | `reasoning_tokens` | 正文 | `finish_reason` |
 * |---|---|---|---|
 * | `thinking:enabled` + `effort:high`，64 | **64（吃满）** | **0 字符** | `length` |
 * | `thinking:enabled` + `effort:low`，64 | **64（吃满）** | **0 字符** | `length` |
 * | 都不发，64 | 0 | 10 字符 | `stop` |
 * | 开思考但抬到 512 | 153 | 10 字符 | `stop` |
 *
 * ## 测试策略
 *
 * ① **纯函数层**（`session-title.ts`）逐格锁死决策表；
 * ② **接线层**：用**真实适配器 + stub fetch** 抓真正发往上游的请求体 ——
 *    这是唯一能证明「修复真的生效」的方式（纯读源码文本会被重构绕过）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  SESSION_TITLE_MIN_MAX_TOKENS,
  isSessionTitleCall,
  planSessionTitleThinking,
  thinkingOffEffortOf,
} from '../../src/session-title.js'

// ───────────────────────── ① 纯函数层 ─────────────────────────

describe('isSessionTitleCall：用途判据', () => {
  it('purpose 为 session-title 时命中', () => {
    expect(isSessionTitleCall({ purpose: 'session-title' })).toBe(true)
  })

  it('⚠️ compaction 不命中（压缩需要真的理解上下文，关思考有害）', () => {
    expect(isSessionTitleCall({ purpose: 'compaction' })).toBe(false)
  })

  it('⚠️ 普通对话（purpose 缺席）不命中 —— 保证主路径零行为变化', () => {
    expect(isSessionTitleCall({})).toBe(false)
    expect(isSessionTitleCall(undefined)).toBe(false)
  })
})

describe('thinkingOffEffortOf：从声明档里挑「关闭思考」', () => {
  it('认得各族写法：off / none 都算关闭档', () => {
    expect(thinkingOffEffortOf(['low', 'high'])).toBeUndefined()
    expect(thinkingOffEffortOf(['off', 'high'])).toBe('off')
    expect(thinkingOffEffortOf(['none', 'low'])).toBe('none')
    // Raccoon / CodeArts 的两档形态：**两种顺序都要验**（Issue IKLIDV）。
    // ⚠️ 本函数按 **rank** 找（`isThinkingOffEffort`）、**不看位置** —— 这正是
    // 顺序可以自由规整的前提。⚠️ 第一版只留了强度序那一条，于是把顺序规整的
    // 「顺带」变成了唯一一条「逆序输入仍取 off」判别性用例的**删除**（审计发现）：
    // 规格化后的真实声明是 `['off','on']`，但**逆序输入必须同样正确**才是那条前提本身。
    expect(thinkingOffEffortOf(['off', 'on'])).toBe('off')
    expect(thinkingOffEffortOf(['on', 'off'])).toBe('off')   // ← 顺序无关性（别删）
  })

  it('⚠️ 声明档为空时返回 undefined（不可视为「已关闭」）', () => {
    // 空档位有两种截然不同的含义：「不支持思考」与「默认思考且关不掉」。
    // 本函数**无权**区分，必须交给调用方决定 —— 一律当「关得掉」会让
    // 抬预算兜底永不触发，缺陷原样复发。
    expect(thinkingOffEffortOf([])).toBeUndefined()
  })
})

describe('planSessionTitleThinking：决策表', () => {
  it('⚠️ 普通请求逐字段原样返回（主路径零行为变化）', () => {
    const plan = planSessionTitleThinking({
      purpose: undefined,
      requestedEffort: 'high',
      declaredEfforts: ['low', 'high'],
      maxTokens: 8192,
    })
    expect(plan).toEqual({
      isTitle: false,
      effort: 'high',
      thinkingOff: false,
      maxTokens: 8192,
    })
  })

  it('⚠️ 标题请求 + 声明了关闭档 → 用关闭档，且**预算不动**', () => {
    const plan = planSessionTitleThinking({
      purpose: 'session-title',
      requestedEffort: 'high',
      declaredEfforts: ['low', 'high', 'off'],
      maxTokens: 64,
    })
    expect(plan.effort).toBe('off')
    expect(plan.thinkingOff).toBe(true)
    // 关得掉就不该抬预算 —— 抬预算是「花钱买通」，思考本身要计费。
    expect(plan.maxTokens).toBe(64)
  })

  it('⚠️ 标题请求 + 关不掉 → 档位**降到最弱**，且预算抬到下限', () => {
    const plan = planSessionTitleThinking({
      purpose: 'session-title',
      requestedEffort: 'extra_high',
      declaredEfforts: ['light', 'high', 'extra_high'],
      maxTokens: 64,
    })
    // ⚠️ 2026-11-11 起**降档**（此前是「保留原档位」）：本插件的默认档已被抬到
    //    最强档，若这里保留 extra_high/max，64 token 会被思考吃满、正文 0 字符
    //    —— 正是 issue IKKVDH 的原始形态。
    expect(plan.effort).toBe('light')
    expect(plan.thinkingOff).toBe(false)
    // ⚠️ 降档**不能**代替抬预算：实测 `effort:low` + 64 同样是「吃满、正文 0 字符」
    //    （见模块头那张表）⇒ 两条腿缺一不可。
    expect(plan.maxTokens).toBe(SESSION_TITLE_MIN_MAX_TOKENS)
  })

  it('⚠️ 关不掉且模型没有更弱的档 ⇒ 保留调用方的档位（不编造）', () => {
    const plan = planSessionTitleThinking({
      purpose: 'session-title',
      requestedEffort: 'high',
      // 只剩一个「开思考」档：没有可降的，只能抬预算。
      declaredEfforts: ['high'],
      maxTokens: 64,
    })
    expect(plan.effort).toBe('high')
    expect(plan.maxTokens).toBe(SESSION_TITLE_MIN_MAX_TOKENS)
  })

  it('⚠️ 抬预算只向上：原预算已大于下限时不动（绝不调小）', () => {
    const plan = planSessionTitleThinking({
      purpose: 'session-title',
      requestedEffort: 'high',
      declaredEfforts: ['high'],
      maxTokens: 4096,
    })
    expect(plan.maxTokens).toBe(4096)
  })

  it('⚠️ 原预算为 undefined 时保持 undefined（不凭空编造预算）', () => {
    const plan = planSessionTitleThinking({
      purpose: 'session-title',
      requestedEffort: 'high',
      declaredEfforts: ['high'],
      maxTokens: undefined,
    })
    expect(plan.maxTokens).toBeUndefined()
  })

  it('⚠️ disableByOmission：标题请求下清空档位（该家靠不发字段关闭）', () => {
    const plan = planSessionTitleThinking({
      purpose: 'session-title',
      requestedEffort: 'high',
      declaredEfforts: ['low', 'high', 'max'],
      maxTokens: 64,
      disableByOmission: true,
    })
    // 必须是 undefined —— 留任何值都会让调用方「补默认档」把思考又打开。
    expect(plan.effort).toBeUndefined()
    expect(plan.thinkingOff).toBe(true)
    expect(plan.maxTokens).toBe(64)
  })

  it('⚠️ disableByOmission 只影响标题请求，普通请求照旧带档位', () => {
    const plan = planSessionTitleThinking({
      purpose: undefined,
      requestedEffort: 'high',
      declaredEfforts: ['low', 'high', 'max'],
      maxTokens: 8192,
      disableByOmission: true,
    })
    expect(plan.effort).toBe('high')
    expect(plan.maxTokens).toBe(8192)
  })

  it('⚠️ 声明了关闭档时优先于 disableByOmission（两者不冲突）', () => {
    const plan = planSessionTitleThinking({
      purpose: 'session-title',
      requestedEffort: 'high',
      declaredEfforts: ['off', 'high'],
      maxTokens: 64,
      disableByOmission: true,
    })
    expect(plan.thinkingOff).toBe(true)
    expect(plan.maxTokens).toBe(64)
  })
})

// ───────────────────────── ② 接线层（真实适配器 + stub fetch） ─────────────────────────

/** 造一个 SSE 结束响应。 */
function sseResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '标题' } }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
    + 'data: [DONE]\n\n',
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

/** 收集 stream 到结束（吞掉终止错误，只关心请求体）。 */
async function drain(iter: AsyncIterable<StreamChunk>): Promise<void> {
  try { for await (const _ of iter) { /* 丢弃 */ } } catch { /* 无关 */ }
}

/**
 * 标题请求的 options —— 逐字复刻 `dsh-session-title-llm` 的
 * `deepFreeze({ provider, model, messages, system, maxTokens, sessionId,
 * purpose, signal })`：**没有 reasoningEffort**。
 */
const TITLE_BASE = {
  messages: [{
    role: 'user' as const,
    content: [{
      type: 'text' as const,
      text: 'Generate the session title from this JSON array of human messages:\n'
        + '[{"seq":8,"text":"给我找一下历史上的今天发生了什么大事"}]',
    }],
  }],
  system: 'Create a concise title for an AI coding-assistant session from the supplied human messages.',
  maxTokens: 64,
  purpose: 'session-title' as const,
}

/**
 * 用真实适配器发一次请求并抓请求体。
 *
 * ⚠️ **必须复刻宿主的默认档注入**：标题请求自己不带 `reasoningEffort`，
 * 是宿主按 `effective = requested ?? reasoning.defaultEffort` 补上的
 * （`dsh-llm` 的 `resolveCallWithInfo`）。少了这一步就测不出真实形态 ——
 * 本缺陷的成因正是「宿主补进来的默认档」。
 */
async function captureVia(
  makeAdapter: (fetchImpl: typeof fetch) => {
    prepareCall: (p: string, m: string, s?: AbortSignal) => Promise<{ model: { reasoning?: { defaultEffort?: unknown } } }>
    stream: (o: GenerateOptions) => AsyncIterable<StreamChunk>
  },
  provider: string,
  model: string,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const captured: { body?: Record<string, unknown> } = {}
  const adapter = makeAdapter(async (_url, init) => {
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return sseResponse()
  })
  const signal = new AbortController().signal
  const prepared = await adapter.prepareCall(provider, model, signal)
  const defaultEffort = prepared.model?.reasoning?.defaultEffort
  const options = { provider, model, signal, ...TITLE_BASE, ...extra }
  // 宿主注入默认档（仅当调用方未显式给）。
  if (options.reasoningEffort === undefined && defaultEffort !== undefined) {
    options.reasoningEffort = defaultEffort
  }
  await drain(adapter.stream(options as never))
  return captured.body ?? {}
}

const buddyCredential = () => ({
  access_token: 'AT', refresh_token: 'RT',
  expires_at: String(Date.now() + 7_200_000), token_type: 'Bearer', scope: '',
  domain: 'copilot.tencent.com',
})

describe('buddy / workbuddy：标题请求发裸请求（deepseek 系）', () => {
  it('⚠️ 真实适配器：标题请求**不发** thinking 也不发 reasoning_effort', async () => {
    const { BuddyAdapter } = await import('../../src/buddy-adapter.js')
    const { CODEBUDDY } = await import('../../src/product.js')
    const body = await captureVia(
      (fetchImpl) => new BuddyAdapter({
        credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
        resolveCredential: async () => buddyCredential(),
        refresh: async () => {},
        fetchImpl,
        product: CODEBUDDY,
      }) as never,
      'buddy',
      'deepseek-v4.1-flash',
      {},
    )
    // 实测：裸请求 → reasoning_content 恒为 0；这是本家唯一的关闭手段。
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
    // 预算是调用方给的 64，**不抬**（关得掉就不抬）。
    expect(body.max_tokens).toBe(64)
  })

  it('⚠️ 真实适配器：普通请求仍照常开思考（主路径零回归）', async () => {
    const { BuddyAdapter } = await import('../../src/buddy-adapter.js')
    const { CODEBUDDY } = await import('../../src/product.js')
    const body = await captureVia(
      (fetchImpl) => new BuddyAdapter({
        credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
        resolveCredential: async () => buddyCredential(),
        refresh: async () => {},
        fetchImpl,
        product: CODEBUDDY,
      }) as never,
      'buddy',
      'deepseek-v4.1-flash',
      { purpose: undefined, maxTokens: 8192 },
    )
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
  })
})

describe('codearts：标题请求发 enable_thinking=false', () => {
  /**
   * ⚠️ 2026-10-30 与 IDE 抓包对齐后改：关闭手段从顶层 `thinking:{type:'disabled'}`
   * 换成 IDE 的 `enable_thinking:false`。两者真机实测**等价**（都让
   * `reasoning_tokens` 归零），但只留 IDE 那一份方言（同一语义不发两个字段）。
   */
  it('⚠️ 真实适配器：标题请求带 enable_thinking=false（关闭思考）', async () => {
    const { CodeArtsAdapter } = await import('../../src/llm-adapter.js')
    const body = await captureVia(
      (fetchImpl) => new CodeArtsAdapter({
        credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
        resolveCredential: async () => ({
          access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
          expires_at: '2099-01-01T00:00:00Z',
        }),
        refresh: async () => {},
        fetchImpl,
      }) as never,
      'codearts',
      'deepseek-v4.1-flash',
      {},
    )
    expect(body.enable_thinking).toBe(false)
    // ⚠️ 旧方言不得再发（同一语义两个字段 = 迟早分叉）。
    expect(body).not.toHaveProperty('thinking')
    expect(body.max_tokens).toBe(64)
  })

  it('⚠️ 真实适配器：普通请求发 enable_thinking=true（IDE 的开启形态）', async () => {
    const { CodeArtsAdapter } = await import('../../src/llm-adapter.js')
    const body = await captureVia(
      (fetchImpl) => new CodeArtsAdapter({
        credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
        resolveCredential: async () => ({
          access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
          expires_at: '2099-01-01T00:00:00Z',
        }),
        refresh: async () => {},
        fetchImpl,
      }) as never,
      'codearts',
      'deepseek-v4.1-flash',
      { purpose: undefined, maxTokens: 8192 },
    )
    // IDE 4/4 请求都是 enable_thinking:true（显式开）——不再「开启即不发」。
    expect(body.enable_thinking).toBe(true)
    expect(body).not.toHaveProperty('thinking')
  })
})

describe('raccoon：标题请求发 extra_body.thinking=disabled', () => {
  it('⚠️ 真实适配器：标题请求带 disabled（本家方言在 extra_body 内）', async () => {
    const { RaccoonAdapter } = await import('../../src/raccoon-adapter.js')
    const body = await captureVia(
      (fetchImpl) => new RaccoonAdapter({
        credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
        resolveCredential: async () => ({ access_token: 'tok', refresh_token: 'r' }),
        refresh: async () => {},
        fetchImpl,
        fetchRemoteModels: async () => ([{
          id: 'sn-deepseek-v4-1-flash', name: 'DeepSeek V4.1 Flash',
          contextWindow: 1_000_000, maxTokens: 100_000, supportsImage: false,
        }]),
      }) as never,
      'raccoon',
      'sn-deepseek-v4-1-flash',
      {},
    )
    // ⚠️ 必须在 `extra_body` 内 —— 放顶层实测被忽略（连非法值都不报错）。
    expect(body.extra_body).toEqual({ thinking: { type: 'disabled' } })
    expect(body.max_tokens).toBe(64)
  })
})

describe('trae：关不掉时抬预算（远端档位无 off）', () => {
  it('⚠️ 真实适配器：标题请求保留档位并把预算抬到下限', async () => {
    const { TraeAdapter } = await import('../../src/trae-adapter.js')
    const { TRAE } = await import('../../src/trae-product.js')
    const body = await captureVia(
      (fetchImpl) => new TraeAdapter({
        credentialRef: 'TRAE_ACCESS_TOKEN' as never,
        resolveCredential: async () => ({
          access_token: 'AT', refresh_token: 'RT',
          expires_at: String(Date.now() + 7_200_000),
          machine_id: 'm', device_id: 'd', uid: 'u',
        }),
        refresh: async () => {},
        fetchImpl,
        product: TRAE,
        // ⚠️ 档位来自**远端** `reasoning_effort_config`（本家没有产品级兜底档位），
        // 故必须喂一份目录，否则 declaredEfforts 恒为空、测不到「关不掉」分支。
        fetchRemoteModels: async () => ([{
          id: 'glm-5.1',
          name: 'GLM-5.1',
          // 远端真实形态实测为 ['light','high','extra_high']（**无 off**）⇒
          // 本家在标题请求上**关不掉**思考，只能靠抬预算兜底。
          reasoningConfig: { options: ['light', 'high', 'extra_high'], defaultLevel: 'high', supportThinking: true },
        }] as never),
      } as never) as never,
      'trae',
      'glm-5.1',
      {},
    )
    // 判据：档位仍在（没有被偷偷删掉 —— 那会把「关不掉」变成「静默降档」），
    // 且预算被抬到兜底下限。
    expect(body).toHaveProperty('reasoning_effort')
    expect(body.max_tokens).toBe(SESSION_TITLE_MIN_MAX_TOKENS)
  })

  it('⚠️ Max 模式：抬预算不得被远端 `__max` 明细**压到下限以下**', async () => {
    const { TraeAdapter } = await import('../../src/trae-adapter.js')
    const { TRAE } = await import('../../src/trae-product.js')
    // 对抗审计实测的缺口：`traeMaxModeFields` 无条件写 `max_tokens` 且排在
    // `clampTraeMaxTokens` 之后，而远端明细只校验 `> 0`（不设下限）⇒
    // 一个异常小的远端值会把预算压到 512 以下，思考又被腰斩、本 issue 复发。
    const body = await captureVia(
      (fetchImpl) => new TraeAdapter({
        credentialRef: 'TRAE_ACCESS_TOKEN' as never,
        resolveCredential: async () => ({
          access_token: 'AT', refresh_token: 'RT',
          expires_at: String(Date.now() + 7_200_000),
          machine_id: 'm', device_id: 'd', uid: 'u',
        }),
        refresh: async () => {},
        fetchImpl,
        product: TRAE,
        fetchRemoteModels: async () => ([{
          id: 'glm-5.1', name: 'GLM-5.1',
          reasoningConfig: { options: ['light', 'high', 'extra_high'], defaultLevel: 'high', supportThinking: true },
          // ⚠️ 刻意给一个**小于兜底下限**的 Max 明细，模拟异常远端数据。
          maxMode: true, maxContextWindow: 1_000_000, maxModeOutputTokens: 100,
        }] as never),
      } as never) as never,
      'trae',
      'glm-5.1',
      {},
    )
    // 抬预算必须**赢**：取两者较大，绝不让已抬高的值变小。
    expect(body.max_tokens).toBe(SESSION_TITLE_MIN_MAX_TOKENS)
  })
})

// ───────────────── 其余 provider 的接线守卫（审计发现的缺口）─────────────────
//
// ⚠️ 这几条是为**审计发现的缺口**补的：此前只有 buddy/codearts/raccoon/trae
// 四家有接线断言，其余 6 家把 `titlePlan.maxTokens` 改回 `options.maxTokens`
// （= 兜底完全失效）时全仓 7000+ 用例**仍全绿**。每条都断言「关不掉的模型
// ⇒ 预算被抬到下限」，这是最能捕获接线丢失的判据。

describe('lobsterai：标题请求在关不掉时抬预算', () => {
  it('⚠️ 远端档位无 off ⇒ 抬到下限', async () => {
    const { LobsteraiAdapter } = await import('../../src/lobsterai-adapter.js')
    const { LOBSTERAI } = await import('../../src/lobsterai-product.js')
    const body = await captureVia(
      (fetchImpl) => new LobsteraiAdapter({
        credentialRef: credentialRef('LOBSTERAI_ACCOUNT_TEST'),
        resolveCredential: async () => ({ access_token: 'AT', refresh_token: 'RT' }),
        refresh: async () => {},
        fetchImpl,
        resolveClientVersion: async () => '1.0.0',
        product: LOBSTERAI,
        // 档位只有 high/xhigh（**无 off**）⇒ 关不掉。
        fetchRemoteModels: async () => ([{
          id: 'glm-5.2', name: 'GLM-5.2',
          supportsThinking: true,
          thinkingConfig: {
            options: [{ level: 'high', openclawLevel: 'high' }, { level: 'max', openclawLevel: 'xhigh' }],
            defaultLevel: 'high',
          },
        }] as never),
      } as never) as never,
      'lobsterai',
      'glm-5.2',
      {},
    )
    expect(body.max_tokens).toBe(SESSION_TITLE_MIN_MAX_TOKENS)
  })
})

describe('cline：标题请求用 none 档关闭思考', () => {
  it('⚠️ 本家档位恒含 none ⇒ 发 none 且**不抬**预算', async () => {
    const { ClineAdapter } = await import('../../src/cline-adapter.js')
    const body = await captureVia(
      (fetchImpl) => new ClineAdapter({
        credentialRef: credentialRef('CLINE_ACCOUNT_TEST'),
        resolveCredential: async () => ({ access_token: 'workos:tok', refresh_token: 'RT' }),
        refresh: async () => {},
        fetchImpl,
      } as never) as never,
      'cline',
      'cline-free/mimo-v2.6-flash',
      {},
    )
    // 关得掉 ⇒ 用 none，且预算**保持 64**（抬预算是花钱买通，能关就不花）。
    expect(body.reasoning_effort).toBe('none')
    expect(body.max_tokens).toBe(64)
  })
})

describe('loomy：标题请求在关不掉时抬预算', () => {
  it('⚠️ 远端档位无 none ⇒ 抬到下限', async () => {
    const { LoomyAdapter } = await import('../../src/loomy-adapter.js')
    const { LOOMY } = await import('../../src/loomy-product.js')
    const body = await captureVia(
      (fetchImpl) => new LoomyAdapter({
        credentialRef: credentialRef('LOOMY_ACCOUNT_TEST'),
        resolveCredential: async () => ({ access_token: 'AT', refresh_token: 'RT' }),
        refresh: async () => {},
        fetchImpl,
        product: LOOMY,
        // 档位无 none ⇒ 关不掉。
        fetchRemoteModels: async () => ([{
          id: 'glm-5.3-flash', name: 'GLM-5.3-Flash',
          efforts: ['low', 'high'],
        }] as never),
      } as never) as never,
      'loomy',
      'glm-5.3-flash',
      {},
    )
    expect(body.max_tokens).toBe(SESSION_TITLE_MIN_MAX_TOKENS)
  })
})

describe('qoder：标题请求在关不掉时抬预算', () => {
  it('⚠️ 模型无 supportsDisable ⇒ 抬到下限（加密体，故断言决策层而非 wire）', async () => {
    const { QoderAdapter } = await import('../../src/qoder-adapter.js')
    const { QODER } = await import('../../src/qoder-product.js')
    const { qoderEffortsFor } = await import('../../src/qoder-adapter.js')
    // ⚠️ qoder 的请求体是 **WASM 加密的密文**（`sendEncrypted`），无法像其余
    // provider 那样 `JSON.parse(init.body)` 断言 wire 字段。故这里：
    //   ① 断言「该模型的关闭档判定」—— 它与适配器传给 `titlePlan` 的是同一个
    //      函数与同一个 entry，是接线正确性的**充分**判据；
    //   ② 断言 `titlePlan` 对该 declaredEfforts 的决策确实是「关不掉 ⇒ 抬预算」。
    const entry = (QODER.fallbackModels ?? []).find((m) => m.id === 'smodel')
    expect(entry, 'smodel 应存在于 qoder 兜底表').toBeDefined()
    const declared = qoderEffortsFor(entry as never)
    // 实测 `smodel` 的档位是 ['xhigh','high','low','max','medium'] —— **无 off/none**。
    expect(declared).not.toContain('none')
    expect(declared).not.toContain('off')

    const plan = planSessionTitleThinking({
      purpose: 'session-title',
      // 宿主会把声明的默认档注入进来。
      requestedEffort: String(entry?.defaultEffort ?? ''),
      declaredEfforts: declared,
      maxTokens: 64,
    })
    expect(plan.thinkingOff).toBe(false)
    expect(plan.maxTokens).toBe(SESSION_TITLE_MIN_MAX_TOKENS)
    // 适配器确实接上了共享层（源码级接线判据，容忍重构）。
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../src/qoder-adapter.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/planSessionTitleThinking\(/)
    expect(src).toMatch(/titlePlan\.maxTokens/)
  })
})

describe('minimax：标题请求按 thinkingMode 分派', () => {
  it('⚠️ forced_on 且无档位（M2.7）⇒ 抬预算、**不发 disabled**（避免硬 400）', async () => {
    const { MinimaxAdapter } = await import('../../src/minimax-adapter.js')
    const { MINIMAX } = await import('../../src/minimax-product.js')
    // ⚠️ minimax 适配器**不吃 `fetchImpl`**（它直接调全局 `fetch`），
    // 必须像它自己的 spec 那样替换 `globalThis.fetch`。
    const original = globalThis.fetch
    const captured: { body?: Record<string, unknown> } = {}
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }) as never
    try {
      const adapter = new MinimaxAdapter({
        credentialRef: credentialRef('MINIMAX_ACCOUNT_TEST'),
        resolveCredential: async () => ({ access_token: 'AT', refresh_token: 'RT' }),
        refresh: async () => {},
        product: MINIMAX,
        // M2.7 是 `forced_on` 且**无 effortOptions** ⇒ 关不掉；
        // 传 `disabled` 会被服务端**静默忽略**，故只能抬预算。
        fetchRemoteModels: async () => ([{ id: 'MiniMax-M2.7', name: 'M2.7', thinkingMode: 'forced_on' }] as never),
      })
      const signal = new AbortController().signal
      const prepared = await adapter.prepareCall('minimax', 'MiniMax-M2.7', signal)
      const options: Record<string, unknown> = { provider: 'minimax', model: 'MiniMax-M2.7', signal, ...TITLE_BASE }
      const de = prepared.model?.reasoning?.defaultEffort
      if (de !== undefined) options.reasoningEffort = de
      await drain(adapter.stream(options as never))
    } finally {
      globalThis.fetch = original
    }
    expect(captured.body?.max_tokens).toBe(SESSION_TITLE_MIN_MAX_TOKENS)
    // **绝不发 disabled**：M2.7 会静默忽略、M3.1 会硬 400（`2013`）。
    expect(captured.body?.thinking).not.toEqual({ type: 'disabled' })
  })

  it('⚠️ switchable（M3）⇒ 发 disabled 且**不抬**预算', async () => {
    const { MinimaxAdapter } = await import('../../src/minimax-adapter.js')
    const { MINIMAX } = await import('../../src/minimax-product.js')
    const original = globalThis.fetch
    const captured: { body?: Record<string, unknown> } = {}
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }) as never
    try {
      const adapter = new MinimaxAdapter({
        credentialRef: credentialRef('MINIMAX_ACCOUNT_TEST'),
        resolveCredential: async () => ({ access_token: 'AT', refresh_token: 'RT' }),
        refresh: async () => {},
        product: MINIMAX,
        fetchRemoteModels: async () => ([{ id: 'MiniMax-M3', name: 'M3', thinkingMode: 'switchable' }] as never),
      })
      const signal = new AbortController().signal
      const prepared = await adapter.prepareCall('minimax', 'MiniMax-M3', signal)
      const options: Record<string, unknown> = { provider: 'minimax', model: 'MiniMax-M3', signal, ...TITLE_BASE }
      const de = prepared.model?.reasoning?.defaultEffort
      if (de !== undefined) options.reasoningEffort = de
      await drain(adapter.stream(options as never))
    } finally {
      globalThis.fetch = original
    }
    // M3 的档位表含我们追加的 `none` ⇒ 关得掉 ⇒ 发 disabled、保持 64。
    expect(captured.body?.thinking).toEqual({ type: 'disabled' })
    expect(captured.body?.max_tokens).toBe(64)
  })
})

describe('zcode：标题请求在关不掉时抬预算', () => {
  it('⚠️ 远端档位无 off ⇒ 抬到下限（本机实测成功率仅 20%）', async () => {
    const { ZcodeAdapter } = await import('../../src/zcode-adapter.js')
    const { ZCODE } = await import('../../src/zcode-product.js')
    const body = await captureVia(
      (fetchImpl) => new ZcodeAdapter({
        credentialRef: credentialRef('ZCODE_ACCESS_TOKEN'),
        resolveCredential: async () => ({
          access_token: 'AT', refresh_token: 'RT',
          expires_at: String(Date.now() + 7_200_000),
        }),
        refresh: async () => {},
        fetchImpl,
        product: ZCODE,
        // 上游 `client/configs` 实测形如 ['low','high','max']（**无 off**）⇒ 关不掉。
        fetchRemoteModels: async () => ([{
          id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash',
          reasoningLevels: ['low', 'high', 'max'], defaultReasoningLevel: 'high',
        }] as never),
      } as never) as never,
      'zcode',
      'GLM-5.3-Flash',
      {},
    )
    expect(body.max_tokens).toBe(SESSION_TITLE_MIN_MAX_TOKENS)
  })
})

describe('gemini：标题请求在关不掉时抬预算', () => {
  it('⚠️ 真实适配器：`generationConfig.maxOutputTokens` 被抬到下限', async () => {
    const { GeminiAdapter } = await import('../../src/gemini-adapter.js')
    const { GEMINI_DEFAULT_PROJECT, GEMINI_EFFORT_IDS, GEMINI_FALLBACK_MODELS } = await import('../../src/gemini.js')
    // ① 本家档位表**没有**关闭档（`gemini.ts` 头注释：关掉 `includeThoughts`
    //    照样思考照样计费 —— 「假关」）⇒ 永远走「关不掉 ⇒ 抬预算」。
    expect(GEMINI_EFFORT_IDS).not.toContain('none')
    expect(GEMINI_EFFORT_IDS).not.toContain('off')
    expect(GEMINI_FALLBACK_MODELS.length).toBeGreaterThan(0)

    // ② **行为级**断言（不靠源码正则）：gemini 用**全局 `fetch`**，且请求体是
    //    `wire` 字符串（不是对象）—— 故像它自己的 spec 那样替换 `globalThis.fetch`，
    //    并显式钉 `cloudaicompanionProject` 跳过项目号探测（否则第一次请求是
    //    `loadCodeAssist`，测不到推理体）。
    const original = globalThis.fetch
    const captured: { body?: string } = {}
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.body = typeof init?.body === 'string' ? init.body : undefined
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"标题"}]},"finishReason":"STOP"}]}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }) as never
    try {
      const adapter = new GeminiAdapter({
        credentialRef: credentialRef('GEMINI_ACCOUNT_TEST'),
        resolveCredential: async () => ({
          access_token: 'AT', refresh_token: 'RT',
          expires_at: String(Date.now() + 7_200_000),
          cloudaicompanionProject: GEMINI_DEFAULT_PROJECT,
        }),
        refresh: async () => {},
        fetchRemoteModels: async () => ([]),
      } as never)
      const signal = new AbortController().signal
      const prepared = await adapter.prepareCall('gemini', 'gemini-3.8-flash', signal)
      const options: Record<string, unknown> = {
        provider: 'gemini', model: 'gemini-3.8-flash', signal, ...TITLE_BASE,
      }
      const de = prepared.model?.reasoning?.defaultEffort
      if (de !== undefined) options.reasoningEffort = de
      await drain(adapter.stream(options as never))
    } finally {
      globalThis.fetch = original
    }
    // 体是 JSON 字符串；`maxOutputTokens` 就在 `generationConfig` 里。
    const raw = captured.body ?? ''
    const maxOutput = /"maxOutputTokens":(\d+)/.exec(raw)?.[1]
    expect(Number(maxOutput)).toBe(SESSION_TITLE_MIN_MAX_TOKENS)
    // 同时佐证「思考没关掉」：`thinkingBudget` 是输出上限的数倍（实测 4000）。
    expect(raw).toMatch(/"includeThoughts":true/)
  })
})

