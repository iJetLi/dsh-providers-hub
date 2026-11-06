import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LoomyAdapter, classifyLoomyFailure, loomyCooldownResetAtMs, parseLoomyRemoteModels,
  reasoningFromEfforts, recordsLoomyRateLimit,
} from '../../src/loomy-adapter.js'
import { classifyRaccoonFailure } from '../../src/raccoon-adapter.js'
import { LOOMY, LOOMY_EFFORTS, loomyContextWindow } from '../../src/loomy-product.js'
import { allAccountsRateLimitedForModel } from '../../src/account-pool.js'
import { isLoomyAuthBusinessCode, LOOMY_PROBE_BACKOFF_MS } from '../../src/loomy-adapter.js'
import { nextUtc8DayStartMs } from '../../src/model-queue.js'
import type { LoomyCredential } from '../../src/loomy.js'

const CRED: LoomyCredential = {
  access_token: 'S'.repeat(32), userid: 'u1', phone: '13011112222',
}

/** 实测的远端模型条目（2026-09-26 GET /api/v1/models 的真实形状）。 */
function remoteEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'MiniMax-M3',
    name: 'MiniMax M3 （x4.0）',
    object: 'model',
    type: 'chat',
    protocol: 'openai_chat',
    context_length: 1_048_576,
    max_output_tokens: 512_000,
    capabilities: {
      reasoning: true, vision: true, function_calling: true,
      input_modalities: ['text', 'image', 'video'], output_modalities: ['text'],
    },
    ...over,
  }
}

function makeAdapter(over: Partial<ConstructorParameters<typeof LoomyAdapter>[0]> = {}) {
  return new LoomyAdapter({
    credentialRef: credentialRef('LOOMY_ACCOUNT_TEST'),
    resolveCredential: async () => CRED,
    refresh: async () => {},
    ...over,
  })
}

describe('parseLoomyRemoteModels', () => {
  it('只保留 type=chat，并把倍率规范化进 name', () => {
    const models = parseLoomyRemoteModels({
      object: 'list',
      data: [
        remoteEntry(),
        remoteEntry({ id: 'Hy-Image-3.5-preview', name: 'Hy image 3.5 preview', type: 'image' }),
      ],
    })
    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe('MiniMax-M3')
    expect(models[0]!.name).toBe('MiniMax M3 · x4.0')
    expect(models[0]!.contextWindow).toBe(1_048_576)
    expect(models[0]!.supportsImage).toBe(true)
    expect(models[0]!.supportsThinking).toBe(true)
  })

  it('接受裸数组与 {data:[]} 两种形态', () => {
    expect(parseLoomyRemoteModels([remoteEntry()])).toHaveLength(1)
    expect(parseLoomyRemoteModels({ data: [remoteEntry()] })).toHaveLength(1)
  })

  it('畸形输入返回空数组（不抛）', () => {
    expect(parseLoomyRemoteModels(null)).toEqual([])
    expect(parseLoomyRemoteModels('x')).toEqual([])
    expect(parseLoomyRemoteModels({ data: 'x' })).toEqual([])
  })

  it('input_modalities 不含 image 时 supportsImage 为 false', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({
        id: 'deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash 0731（x3.0）',
        capabilities: { reasoning: true, input_modalities: ['text'] },
      })],
    })
    expect(models[0]!.supportsImage).toBe(false)
  })

  /**
   * ★ 2026-10-14 用户报障「loomy 的 qwen3.8max 输入不能上图」：远端对
   * `qwen-3.8-max` 漏报（`input_modalities: ['text']`、`vision: false`）而实测能读图
   * ⇒ **不能照抄声明值**。判据与同批 10 个模型的对照表见 `src/loomy-product.ts`。
   */
  it('★ 远端漏报时 qwen-3.8-max 仍判定支持图片（声明值与覆盖表分叉）', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({
        id: 'qwen-3.8-max',
        name: 'Qwen 3.8 Max（x12.0）',
        capabilities: { reasoning: true, vision: false, input_modalities: ['text'] },
      })],
    })
    expect(models[0]!.id).toBe('qwen-3.8-max')
    expect(models[0]!.supportsImage).toBe(true)
  })
})

describe('LoomyAdapter.listModels', () => {
  it('远端可用时用远端（带倍率）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry(), remoteEntry({ id: 'spark-x', name: 'Spark X2.5（x0.1）' })],
      }),
    })
    const models = await adapter.listModels('loomy')
    expect(models).toHaveLength(2)
    expect(models[0]!.provider).toBe('loomy')
    expect(models[0]!.name).toBe('MiniMax M3 · x4.0')
  })

  it('远端失败时回退兜底表（9 个，兜底表名已含倍率）', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    const models = await adapter.listModels('loomy')
    expect(models).toHaveLength(9)
    expect(models.map((m) => m.id)).toContain('qwen3.8-flash')
  })

  /**
   * ⚠ **兜底表不得被当成缓存**（真实缺陷，2026-08 起长期存在）。
   *
   * 原实现是 `this.remoteModels = fallback; return fallback`：一次瞬时失败会把
   * 兜底表写进 `remoteModels`，此后 `if (this.remoteModels !== undefined)` 永远短路
   * ⇒ 该 provider **整个进程生命周期**都只剩兜底模型，用户看不到自己的模型，
   * 也无从触发重试，只能重启 DSH。
   *
   * 修好之后：兜底表每次现算，`remoteModels` 只装**真实远端目录**。
   * 恢复时机由 `RemoteCatalogGate` 的冷却窗口决定（30s，见
   * `tests/unit/remote-catalog-gate.spec.ts`），这里只锁「缓存没被污染」。
   */
  it('★ 远端失败后**不**把兜底表写进 remoteModels', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    expect(await adapter.listModels('loomy')).toHaveLength(9)
    const cache = (adapter as unknown as { remoteModels: unknown }).remoteModels
    expect(cache, '兜底表不得进缓存 —— 否则远端恢复后也永远看不到真实目录').toBeUndefined()
  })

  it('★ 远端返回空目录同样不落缓存（空结果也会被冷却挡住，不会每模型重试一次）', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { calls += 1; return [] },
    })
    expect(await adapter.listModels('loomy')).toHaveLength(9)
    // ⚠ 只应拉一次：`buildModelCatalog` 会为每个模型各调一次 resolveModel，
    // 不去重/不冷却的话这里会变成 N 次串行请求。
    expect(await adapter.listModels('loomy')).toHaveLength(9)
    expect(await adapter.resolveModel('loomy', 'qwen3.8-flash')).toBeDefined()
    expect(calls).toBe(1)
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeUndefined()
  })

  it('★ 远端成功时缓存生效：后续调用不再打网络', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { calls += 1; return parseLoomyRemoteModels({ data: [remoteEntry()] }) },
    })
    await adapter.listModels('loomy')
    await adapter.listModels('loomy')
    await adapter.listModels('loomy')
    expect(calls).toBe(1)
  })

  it('无账号池时目录可见（headless/单测保守放行）', async () => {
    const adapter = makeAdapter()
    expect((await adapter.listModels('loomy')).length).toBeGreaterThan(0)
  })

  it('有账号池但未登录时返回空数组（不抛错）', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => false,
      } as never,
    })
    expect(await adapter.listModels('loomy')).toEqual([])
  })

  it('黑名单里的模型被过滤', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set(['spark-x']),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const ids = (await adapter.listModels('loomy')).map((m) => m.id)
    expect(ids).not.toContain('spark-x')
    // 9 条兜底里关掉 1 条 ⇒ 剩 8 条
    expect(ids.length).toBe(8)
  })
})

describe('LoomyAdapter.listAllModels', () => {
  it('不套黑名单，且带最终展示名', () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set(['spark-x']),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const all = adapter.listAllModels()
    // 被关闭的 spark-x 也必须出现（否则用户无法重新打开）
    expect(all.map((m) => m.id)).toContain('spark-x')
    expect(all.find((m) => m.id === 'spark-x')!.name).toBe('Spark X2.5 · x0.1')
  })
})

/**
 * ★★ 兜底表漂移 ⇒ 整轮失败（2026-11-06 真实报障）。
 *
 * ## 缺陷
 *
 * 远端 `GET /models` 已上架 `DeepSeek-V4.1-Flash`（2026-11-06 实测 6 个 chat 模型
 * 之一），而 `LOOMY_FALLBACK_MODELS` 仍只有 2026-09-26 那批 ⇒ 远端抓取失败
 * （冷启动 / 断网 / 网关抖动）时该 id 落在「目录外」分支 ⇒ **既不声明
 * `reasoning` 也不声明 `context`** ⇒
 *
 * 1. 用户在该模型上持久化过 `reasoningEffort: 'xhigh'` ⇒ `dsh-llm` 的
 *    `resolveCallWithInfo` **硬抛** `UNSUPPORTED_REASONING_EFFORT`
 *    （源码明文 `Unsupported explicit efforts reject before provider I/O;
 *    no clamping or aliasing is performed`）⇒ **整轮失败，一个 token 都没发出去**；
 * 2. 同一份缺失的 `context` 让 `dsh-compaction-basic` 抛
 *    `no context capacity for loomy/DeepSeek-V4.1-Flash`，被 agent/pre-step
 *    吞成一条 warn ⇒ 该模型的**自动压缩永久静默失效**。
 *
 * 实测证据（2026-11-06 本机）：3 次 `agent.failed` + 1 条压缩 warn，
 * 会话档 `model/selection` 写着 xhigh、`request/header` 带着 xhigh 发出去。
 *
 * ## 为什么这一组必须分**两层**测
 *
 * 只补兜底表 = **治标**：下一次上游再上架一个模型，同样的失败原样复现。
 * 只加 `unknownModelReasoning` = **把兜底表留一个洞**：该模型在离线时
 * 仍不显示窗口、也不会出现在兜底列表里。
 * 两条都锁，任何一条退化都会立刻变红。
 */
describe('Loomy 兜底表漂移（2026-11-06 整轮失败）', () => {
  it('★ 兜底表已含 DeepSeek-V4.1-Flash（远端 2026-11-06 实测值）', () => {
    const entry = LOOMY.fallbackModels.find((m) => m.id === 'DeepSeek-V4.1-Flash')
    expect(entry, '兜底表缺该模型 ⇒ 远端失败时它落「目录外」分支').toBeDefined()
    expect(entry!.contextWindow).toBe(1_048_576)
    expect(entry!.efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(entry!.name).toBe('DeepSeek V4.1 Flash · x2.0')
  })

  it('★ 兜底表条目数与远端 chat 集合一致（远端新增时必须同步）', () => {
    // 2026-11-06 生产端点实测：9 条里 type==='chat' 的 6 条；兜底表保留 2026-09-26
    // 那批中仍可见的、并补上新增的 ⇒ 现为 9 条（多出的是已下架但保留的兜底项）。
    // ⚠️ 这条断言**故意写成下界 + 必须含新模型**，而不是钉死数字：
    // 钉死数字会让每次上游增减都要改测试（本仓库明确反对「改文档就要改测试」）。
    expect(LOOMY.fallbackModels.length).toBeGreaterThanOrEqual(9)
  })

  it('★ 远端抓取失败时 resolveModel 仍声明 reasoning 与该模型窗口', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    const resolved = await adapter.resolveModel('loomy', 'DeepSeek-V4.1-Flash')
    expect(resolved.reasoning?.efforts.map((e) => e.id))
      .toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(resolved.context?.contextWindow).toBe(1_048_576)
  })

  it('★★ 目录外 id 仍声明档位（兜底表也没覆盖的新模型不再整轮失败）', async () => {
    // 场景：上游又上架了一个兜底表**还没跟上**的模型，且远端此刻抓不到。
    // 修复前：reasoning === undefined ⇒ 用户持久化的档位被 dsh-llm 硬抛。
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    const resolved = await adapter.resolveModel('loomy', 'Some-Future-Model')
    expect(resolved.reasoning, '目录外 id 必须仍声明档位，否则整轮失败').toBeDefined()
    expect(resolved.reasoning!.efforts.map((e) => e.id))
      .toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    // ⚠️ 默认档必须落在 efforts 内（DSH 会拿它直接发请求）。
    expect(resolved.reasoning!.defaultEffort).toBe('high')
  })

  it('⚠️ 目录外 id **不**编造上下文窗口（窗口是该模型的事实）', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    const resolved = await adapter.resolveModel('loomy', 'Some-Future-Model')
    expect(resolved.context, '编一个假窗口会让占用比与压缩阈值一起错').toBeUndefined()
  })

  it('⚠️ 档位与目录内条目走**同一份**实现（不得两套同义判据）', () => {
    // `reasoningFromEfforts` 是唯一实现：两个消费者必须拿到逐字相同的结构。
    const inside = reasoningFromEfforts([...LOOMY_EFFORTS])
    const outside = reasoningFromEfforts([...LOOMY_EFFORTS])
    expect(outside).toEqual(inside)
    // 空档位 ⇒ 不声明（不是空数组）
    expect(reasoningFromEfforts(undefined)).toBeUndefined()
    expect(reasoningFromEfforts([])).toBeUndefined()
  })
})

describe('LoomyAdapter.resolveModel', () => {
  it('name 不带倍率（价格只属于选择列表语境）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('loomy', 'spark-x')
    expect(resolved.name).toBe('Spark X2.5')
    // ⚠️ 兜底表路径的 `spark-x` 也必须是 262144（真实墙），不是远端的 1048576。
    // ❌ 修复前这里写死 1_048_576 —— 那是把缺陷当契约（issue IKJW31）。
    expect(resolved.context?.contextWindow).toBe(262_144)
  })

  it('未知模型不编造 context', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('loomy', 'nope')
    expect(resolved.context).toBeUndefined()
  })
})

/**
 * ★★ 上下文窗口的逐模型覆盖（Gitee issue IKJW31）。
 *
 * ## 缺陷
 *
 * 远端 `GET /models` 对 `spark-x` 声明 `context_length: 1048576`，**真实墙在
 * 262144**。宿主按 1M 打包 ⇒ 输入越过 256K 后上游收下请求但 **0 输出** +
 * `finish_reason=length` ⇒ 插件报 `max-tokens`，而 DSH 对它**不自动重试**
 * ⇒ 长会话「有时候 token 截断」（4 次失败的 prompt 总量逐 token 相同：
 * `262,138 = 262,144 − 6`）。
 *
 * ## 为什么这一组必须分**两条路径**测
 *
 * 远端可用时走远端值、远端失败时走兜底表。**只改兜底表等于没改** ——
 * 这是本 issue 最容易踩空的点（作者第一版就漏了远端路径）。
 * 两条路径各一条用例，任何一条退化都会立刻变红。
 */
describe('LoomyAdapter 上下文窗口覆盖（issue IKJW31）', () => {
  it('覆盖表把 spark-x 降到真实的 262144，且判据不依赖调用方的值', () => {
    expect(loomyContextWindow('spark-x', 1_048_576)).toBe(262_144)
    // 无覆盖的模型原样透传（**防误伤**：不能把整表一刀切成某个值）
    expect(loomyContextWindow('MiniMax-M3', 1_048_576)).toBe(1_048_576)
    expect(loomyContextWindow('Kimi-k2.6', 262_144)).toBe(262_144)
  })

  it('★ 远端路径：远端声明 1M，解析结果必须是 262144', () => {
    // 判据直接打在 `parseLoomyRemoteModels` 上（真实远端形状：context_length=1048576）
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({ id: 'spark-x', name: 'Spark X2.5（x0.1）' })],
    })
    // ⛔ 回归前：这里是 1_048_576 —— 宿主于是按 1M 打包。
    expect(models[0]!.contextWindow).toBe(262_144)
  })

  it('★ 远端路径：resolveModel 同样拿到 262144（这是宿主真正读的那个值）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ id: 'spark-x', name: 'Spark X2.5（x0.1）' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'spark-x')
    expect(resolved.context?.contextWindow).toBe(262_144)
  })

  it('★ 兜底表路径：条目本身已写真实值（不是靠覆盖表兜的）', () => {
    const entry = LOOMY.fallbackModels.find((m) => m.id === 'spark-x')
    // 兜底表是「未联网时的真相源」，它自己就该是真实的 —— 若只靠覆盖表，
    // 将来有人抄这张表去别处就会把 1M 一起抄走。
    expect(entry?.contextWindow).toBe(262_144)
  })

  it('⚠️ 其余模型不受影响（远端与兜底两条路径都不许被误改）', () => {
    const models = parseLoomyRemoteModels({
      data: [
        remoteEntry({ id: 'MiniMax-M3' }),
        remoteEntry({ id: 'Kimi-k2.6', context_length: 262_144 }),
      ],
    })
    expect(models.find((m) => m.id === 'MiniMax-M3')?.contextWindow).toBe(1_048_576)
    expect(models.find((m) => m.id === 'Kimi-k2.6')?.contextWindow).toBe(262_144)
  })

  it('⚠️ 远端未给窗口（0）时不得被覆盖表凭空变成 262144', () => {
    // 判据顺序是「先判有效再覆盖」：`spark-x` 若某天远端不再下发 context_length，
    // 结果应是 0（不声明）而不是覆盖值 —— 否则会谎报一个我们并未验证的窗口。
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({ id: 'spark-x', context_length: undefined })],
    })
    expect(models[0]!.contextWindow).toBe(0)
  })
})

/**
 * ⚠️ **思考档位**（用户报障：「loomy ide 中可以设置思考档位，我们现在没法设置」）。
 *
 * 根因与 Qoder 那次**完全同型**（见 AGENTS.md 2.2 节）：`resolveModel`
 * **只声明 `context`，从不声明 `reasoning`** —— 而 DSH 的思考强度选择器
 * **只会**从 `resolveModel().reasoning` 渲染，故档位选择器从来没出现过，
 * 尽管远端早就下发了 `reasoning_efforts`。
 *
 * 用户要求「如果能从远端得到配置中直接生成是最好的」—— 正是本实现的做法。
 */
describe('LoomyAdapter 思考档位', () => {
  /** 实测的档位（8 个 chat 模型完全一致）。 */
  const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh']

  it('parseLoomyRemoteModels 读出 reasoning_efforts 与默认档', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
    })
    expect(models[0]!.efforts).toEqual(EFFORTS)
    expect(models[0]!.defaultEffort).toBe('low')
  })

  it('远端未下发档位时不写这两个键（而非写空数组）', () => {
    const models = parseLoomyRemoteModels({ data: [remoteEntry()] })
    expect(models[0]!.efforts).toBeUndefined()
    expect(models[0]!.defaultEffort).toBeUndefined()
  })

  it('非法档位项被丢弃，且去重', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({ reasoning_efforts: ['low', 42, null, 'low', 'high', ''] })],
    })
    expect(models[0]!.efforts).toEqual(['low', 'high'])
  })

  it('resolveModel 声明 reasoning（远端档位直接生成，含官方中文名）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(EFFORTS)
    // 中文名与官方 IDE 一致（DSH 直接渲染 name，不本地化）
    expect(resolved.reasoning?.efforts.map((e) => e.name))
      .toEqual(['关闭思考', '低', '中', '高', '极高'])
  })

  /**
   * ⚠️ **默认档用本插件自己的 `high`，不采信远端的 `low`**（用户要求）。
   *
   * 依据：DSH 的 `effectiveEffort = state.current?.reasoningEffort
   * ?? reasoning?.defaultEffort` —— 「用户没选时发哪个档」完全由适配器声明的
   * `defaultEffort` 决定，沿用远端的 `low` 会让默认思考偏浅。
   *
   * ⚠️ 反向断言：**绝不能**等于远端声明的 `low`（否则等于没改）。
   */
  it('默认档是 high，不是远端声明的 low（用户要求）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.defaultEffort).toBe('high')
    expect(resolved.reasoning?.defaultEffort).not.toBe('low')
  })

  /**
   * ⚠️ `defaultEffort` **必须落在 `efforts` 内** —— DSH 会拿它直接发请求，
   * 给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，比不给更糟。
   *
   * 这里造一个**不含 `high`** 的模型（远端目录变化时真会发生），
   * 期望**不下发默认档**（退回 DSH 的「服务商默认」），而不是硬发 `high`。
   */
  it('模型不提供 high 档时不下发默认档（但档位照常给出）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: ['low', 'medium'], default_reasoning_effort: 'low' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'medium'])
    expect(resolved.reasoning?.defaultEffort).toBeUndefined()
  })

  /**
   * ⚠️ 远端某模型**未下发**档位、但它在兜底表里有档位时，**仍给出档位**。
   *
   * 这是**有意为之**：`loadModels()` 在远端返回非空时采信远端，但
   * `reasoningFor` 会回退到兜底表 —— 因为「远端这一条没带档位」不等于
   * 「该模型不支持档位」（可能是上游某次下发的字段缺失）。
   * 而兜底表的档位是**实测值**，给出它比让选择器凭空消失更好。
   */
  it('远端该模型未带档位时回退兜底表档位（不凭空消失）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({ data: [remoteEntry()] }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(EFFORTS)
  })

  /** 真正「不提供档位」的是**兜底表也没有**的模型（如远端新上线的模型）。 */
  it('远端与兜底表都没有档位时不声明 reasoning', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        // 一个兜底表里没有的新模型，且未下发档位
        data: [remoteEntry({ id: 'brand-new-model', name: 'Brand New' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'brand-new-model')
    expect(resolved.reasoning).toBeUndefined()
  })

  it('远端整体失败时用兜底表的档位', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    const resolved = await adapter.resolveModel('loomy', 'qwen3.8-flash')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(EFFORTS)
    // ⚠️ 兜底路径的默认档也必须与远端路径一致（都是 high），
    // 否则「远端可用/不可用」会让默认档悄悄变化。
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('未登记的中文名回退到 id 本身（新档位上线时不至于空白）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: ['low', 'ultra'] })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['低', 'ultra'])
  })
})

describe('LoomyAdapter 请求体里的 reasoning_effort', () => {
  const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh']

  /** 造一个 SSE 响应并捕获请求体。 */
  function makeFetch(captured: { body?: Record<string, unknown> }) {
    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const frames = [
        'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ]
      return new Response(frames.join(''), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
  }

  async function drain(adapter: LoomyAdapter, effort?: string) {
    for await (const _chunk of adapter.stream({
      provider: 'loomy',
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
      ...effort !== undefined ? { reasoningEffort: effort as never } : {},
    })) {
      // 只为把请求发出去
    }
  }

  it('用户选了档位时下发 reasoning_effort', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
      }),
    })
    await drain(adapter, 'high')
    expect(captured.body?.reasoning_effort).toBe('high')
  })

  it('未选档位时不下发该字段（让服务端用默认档）', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS })],
      }),
    })
    await drain(adapter)
    expect(captured.body).not.toHaveProperty('reasoning_effort')
  })

  /**
   * ⚠️ **安全约束**：档位不在该模型声明的 `efforts` 内时**静默不下发**。
   *
   * 给一个远端不认的值比不给更糟（可能被拒，或行为未定义）。DSH 会把用户选的
   * 档位直接透传，故这里必须自己校验。
   */
  it('档位不在该模型的 efforts 内时不下发', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: ['low', 'high'] })],
      }),
    })
    await drain(adapter, 'xhigh')
    expect(captured.body).not.toHaveProperty('reasoning_effort')
  })

  it('远端整体失败时用兜底表档位校验（xhigh 在表内 → 下发）', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    await drain(adapter, 'xhigh')
    expect(captured.body?.reasoning_effort).toBe('xhigh')
  })
})

describe('LoomyAdapter.providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    expect(makeAdapter().providerInfo('loomy')).toEqual({ id: 'loomy', name: 'Loomy (讯飞)' })
  })

  it('provider 非法时回退到产品 id（避免 undefined.toUpperCase 崩）', () => {
    expect(makeAdapter().providerInfo(undefined as never).id).toBe('loomy')
  })
})

/**
 * `classifyLoomyFailure` 判据（loomy ↔ raccoon **同型复发**，2026-10-06）。
 *
 * ## 缺陷形态
 *
 * loomy 的分类器初版与 raccoon 的**修复前**版本逐字同形（文案先判 +
 * `insufficient` 单独出现即算额度）。raccoon 已在 `7b524ff` 收窄，loomy 未同步
 * ⇒ 同一报文在两个 provider 上被判成**不同类别**，且危险方向恒定朝 loomy：
 * `quota` 会走 `recordsLoomyRateLimit` ⇒ **给账号写模型冷却**（时长见
 * `loomyCooldownResetAtMs`：quota = UTC+8 当日 24:00，rate = +1h）。
 *
 * 实测（临时探针，已删）三例 —— 403 + `insufficient permissions`、
 * 403 + 积分不足、401 + 余额不足：loomy 判 quota 并写冷却，raccoon 判 auth 不写。
 * 前两例与 2026-10-06「全池被封」事故同型（那次触发词是
 * `authorization_verify_error`），只是触发词换成了文案判据。
 */
describe('classifyLoomyFailure 判据（与 raccoon 逐格同构）', () => {
  it('★ 真实额度形态仍归 quota（含 PR 报障的 400 + insufficient_points）', () => {
    expect(classifyLoomyFailure('{"code":"insufficient_points"}', 400)).toBe('quota')
    expect(classifyLoomyFailure('insufficient_points', 402)).toBe('quota')
    expect(classifyLoomyFailure('14018 Credits exhausted', 400)).toBe('quota')
    expect(classifyLoomyFailure('积分不足', 400)).toBe('quota')
    expect(classifyLoomyFailure('余额不足', 400)).toBe('quota')
  })

  /**
   * ★★ `insufficient` 单独出现**不得**判成 quota（raccoon 侧 PR !71 审计实测
   * 误伤 5 类）。误判后果同样是**封一个只是上下文超长的账号 24h**。
   */
  it('★★ 上下文/数据类 insufficient 不判 quota（不写 24h 冷却）', () => {
    expect(classifyLoomyFailure('the context window is insufficient for this model', 400)).toBe('other')
    expect(classifyLoomyFailure('input length is insufficient', 400)).toBe('other')
    expect(classifyLoomyFailure('insufficient data to complete the request', 400)).toBe('other')
  })

  /**
   * ★★★ 401/403 必须归 **auth**（不是 quota）—— 即使报文里带额度文案。
   *
   * 认证类是 2026-10-06 事故换来的不变式：**只换号、绝不写冷却标记**。
   * 上游网关对全池回 401 时常在报文里捎带余额提示，若按文案判 quota，
   * 一个请求内每个号各被封 24h ⇒ 整个 provider 死一天。
   */
  it('★★★ 401/403 恒归 auth（含 insufficient permissions / 积分不足 / 余额不足）', () => {
    expect(classifyLoomyFailure('insufficient permissions to access this resource', 403)).toBe('auth')
    expect(classifyLoomyFailure('积分不足，请充值', 403)).toBe('auth')
    expect(classifyLoomyFailure('余额不足', 401)).toBe('auth')
    expect(classifyLoomyFailure('{"code":200003,"message":"authorization_verify_error"}', 401)).toBe('auth')
    // 状态码与额度文案并存时，仍以状态码为准。
    expect(classifyLoomyFailure('14018 Credits exhausted', 401)).toBe('auth')
    // 且必须**不写冷却**（这才是事故的真正触发点）。
    expect(recordsLoomyRateLimit(classifyLoomyFailure('余额不足', 401))).toBe(false)
  })

  it('429 与 402 按状态码归类', () => {
    expect(classifyLoomyFailure('', 429)).toBe('rate')
    expect(classifyLoomyFailure('', 402)).toBe('quota')
    expect(classifyLoomyFailure('param is invalid', 400)).toBe('other')
  })

  /**
   * ★★★ **对拍**：同一批真实报文喂 loomy 与 raccoon 两个分类器，逐条必须同结论。
   *
   * 这是本缺陷的**同型复发**防线 —— 单看 loomy 自己的用例，未来任何一次
   * 单方面改动（哪怕方向是"更严"）都会让两侧再次分叉，而两侧各自的用例
   * 都能过。对拍用例把「必须逐格一致」这件事本身锁进测试。
   *
   * ⚠️ 报文集刻意混合「两家共有的额度形态」与「只在一边被误判的文案」，
   * 且**含状态码维度**（403/401 的优先级只有靠状态码才能验证）。
   */
  it('★★★ 与 raccoon 对拍：同一报文集逐条同结论（同型复发防线）', () => {
    const corpus: Array<[string, number]> = [
      ['insufficient permissions to access this resource', 403],
      ['积分不足，请充值', 403],
      ['余额不足', 401],
      ['额度已耗尽', 402],
      ['14018 Credits exhausted', 401],
      ['the context window is insufficient for this model', 400],
      ['insufficient data to complete the request', 400],
      ['{"code":"insufficient_points"}', 400],
      ['14018 Credits exhausted', 402],
      ['积分不足', 400],
      ['quota exceeded', 400],
      ['', 429],
      ['param is invalid', 400],
    ]
    const diverged = corpus
      .map(([text, status]) => ({
        text,
        status,
        loomy: classifyLoomyFailure(text, status),
        raccoon: classifyRaccoonFailure(text, status),
      }))
      .filter((row) => row.loomy !== row.raccoon)
    expect(
      diverged,
      `loomy 与 raccoon 的分类结论出现分叉（同型复发）：${JSON.stringify(diverged)}`,
    ).toEqual([])
  })
})

/**
 * 请求级账号轮换（★ 2026-10-05，用户报障「余额用完一个号就卡死」）。
 *
 * ## 为什么余额选号器救不了
 *
 * `loomy-balance-selector` 只在**取号时**按余额分档；余额查询与实际扣费是
 * 两个时刻——查询时有钱、推理时上游报 `14018`，错误直接抛 harness，
 * 下次取号还是同一个号 ⇒ 「卡死在一个号上」。
 *
 * 本 describe 锁定：HTTP 层额度耗尽 → 标记坏号该模型（终点 = UTC+8 当日 24:00，
 * 见下方 IKL80H 一组）→ `tried` 换下一个 → 重发成功；全部耗尽才报错且带最后一次
 * 真实原因；非额度类 4xx 不换号。
 * 语义与 raccoon / buddy 三处对齐（同一张判据形状，各家用各家的词表）。
 */
describe('LoomyAdapter 请求级账号轮换（余额耗尽无感切号）', () => {
  const CRED_A: LoomyCredential = { access_token: 'tok-A', userid: 'ua', phone: '13800000001' }
  const CRED_B: LoomyCredential = { access_token: 'tok-B', userid: 'ub', phone: '13800000002' }

  function makePoolStub() {
    const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const picks: Array<ReadonlySet<string> | undefined> = []
    const accounts = [
      { id: 'loomy-A', cred: CRED_A },
      { id: 'loomy-B', cred: CRED_B },
    ]
    const pool = {
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        marks.push({ accountId, modelId, resetAtMs })
      },
      getAvailableAccount: async (_provider: string, _model: string, exclude?: ReadonlySet<string>) => {
        picks.push(exclude)
        for (const a of accounts) {
          if (exclude?.has(a.id)) continue
          return { entry: { id: a.id }, credential: a.cred }
        }
        return null
      },
      findAccountIdByCredential: async (_provider: string, identity: string) =>
        accounts.find((a) => a.cred.access_token === identity)?.id ?? '',
    }
    return { pool, marks, picks }
  }

  const sseOk = () => new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"从二号账号返回"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

  it('★ 一号额度耗尽（14018）→ 标记该模型 + 切二号重发成功', async () => {
    const { pool, marks, picks } = makePoolStub()
    const seenAuth: string[] = []
    let call = 0
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1
      seenAuth.push(String(new Headers(init?.headers).get('Authorization') ?? ''))
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 })
      }
      return sseOk()
    }) as unknown as typeof fetch

    const adapter = makeAdapter({
      // 首发凭据 = 池的第一号（对齐生产：resolveCredential 从池选号）。
      resolveCredential: async () => CRED_A,
      accountPool: pool as never,
      fetchImpl: fetcher,
    })
    const chunks: unknown[] = []
    for await (const c of adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    })) chunks.push(c)

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(seenAuth[0]).toContain('tok-A')
    expect(seenAuth[1]).toContain('tok-B')
    expect(chunks.some((c) => (c as { type?: string }).type === 'text-delta')).toBe(true)
    expect(marks.some((m) => m.accountId === 'loomy-A' && m.modelId === 'MiniMax-M3')).toBe(true)
    expect(picks[0]?.has('loomy-A') ?? false).toBe(true)
  })

  it('★ 两号都耗尽 → 报「所有账号均不可用」并带最后一次的真实原因', async () => {
    const { pool } = makePoolStub()
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = String(new Headers(init?.headers).get('Authorization') ?? '')
      return new Response(
        JSON.stringify({ error: { message: `14018 exhausted (${auth.includes('tok-B') ? 'B' : 'A'})` } }),
        { status: 402 },
      )
    }) as unknown as typeof fetch

    const adapter = makeAdapter({ resolveCredential: async () => CRED_A, accountPool: pool as never, fetchImpl: fetcher })
    const error = await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('所有账号')
    expect((error as Error).message).toContain('B')
  })

  it('非额度类 4xx（400 参数错）不换号', async () => {
    const { pool, picks } = makePoolStub()
    const fetcher = (async () =>
      new Response('{"error":{"message":"param is invalid"}}', { status: 400 })) as unknown as typeof fetch
    const adapter = makeAdapter({ resolveCredential: async () => CRED_A, accountPool: pool as never, fetchImpl: fetcher })
    const error = await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch((e: unknown) => e)

    expect((error as Error).message).toContain('param is invalid')
    // 不换号：pool 的取号一次都没被调用（stream 里轮换块整体跳过；
    // findAccountIdByCredential 会被调一次——那是记账键反查，不是换号）。
    expect(picks.length).toBe(0)
  })

  /**
   * ★ 认证类（401/403）**换号但不写冷却标记** —— 真实事故回归（2026-10-06）。
   *
   * 上游网关对全池回 `401 + authorization_verify_error`（网关侧授权故障）。
   * 旧实现把 401 也写 24h 冷却 ⇒ 一个请求连试 6 个号、每个封 24h ⇒
   * **整个 provider 被封一天**，下一次请求报 `no usable credential; log in first`。
   * 语义对齐 buddy：只有限流类写标记，认证类只换号。
   */
  it('★ 401 授权失败：换号但绝不写冷却标记（全池失败也不写）', async () => {
    const { pool, marks } = makePoolStub()
    let call = 0
    const fetcher = vi.fn(async () => {
      call += 1
      // 一号 401；二号正常
      if (call === 1) {
        return new Response(JSON.stringify({ code: 200003, message: 'authorization_verify_error' }), { status: 401 })
      }
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"二号正常"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch

    const adapter = makeAdapter({ resolveCredential: async () => CRED_A, accountPool: pool as never, fetchImpl: fetcher })
    const chunks: unknown[] = []
    for await (const c of adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    })) chunks.push(c)

    expect(fetcher.mock.calls.length).toBeGreaterThan(1)
    expect(chunks.some((c) => (c as { type?: string }).type === 'text-delta')).toBe(true)
    expect(marks).toEqual([])
  })

  it('★ 401 打遍全池：不留任何标记（池保持可用）', async () => {
    const { pool, marks } = makePoolStub()
    const fetcher = (async () =>
      new Response(JSON.stringify({ code: 200003, message: 'authorization_verify_error' }), { status: 401 })) as unknown as typeof fetch
    const adapter = makeAdapter({ resolveCredential: async () => CRED_A, accountPool: pool as never, fetchImpl: fetcher })
    const error = await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect(marks).toEqual([])
  })

  /**
   * ★★ 「**最后一个**失败账号必须被标记」（PR !71 审计发现的真实缺陷）。
   *
   * ## 缺陷与为什么两条账号的用例测不到
   *
   * 旧实现把写标记放在 `for` 循环**开头**。于是**迭代次数 = 标记次数**，
   * 而最后一次失败发生在循环体的**末尾**、不会再有下一次迭代 ⇒ **末号漏记**。
   *
   * ⚠️ 这正是同族 PR !71 在 raccoon 上修的同一个缺陷（loomy 未同步修）。
   * ⚠️ **两条账号的用例是同义反复、测不到它**：循环跑 2 次、写 2 个标记，
   * 修复前后输出完全一样。缺陷只在**轮换预算恰好用尽**（池里账号数 ≥
   * `LOOMY_MAX_ROTATE`）或**末号之后 `getAvailableAccount` 返回 null** 时暴露。
   */
  it('★★ 8 账号全耗尽（轮换预算恰好用尽）→ 8 个号全部被标记，末号不漏', async () => {
    const marks: Array<{ accountId: string }> = []
    const ids = Array.from({ length: 8 }, (_, i) => `loomy-${i + 1}`)
    const pool = {
      updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
      getAvailableAccount: async (_p: string, _m: string, exclude?: ReadonlySet<string>) => {
        for (const id of ids) {
          if (exclude?.has(id)) continue
          return { entry: { id }, credential: { ...CRED_A, access_token: `tok-${id}` } }
        }
        return null
      },
      findAccountIdByCredential: async (_p: string, identity: string) =>
        ids.find((id) => `tok-${id}` === identity) ?? '',
    }
    const fetcher = (async () => new Response(
      JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 },
    )) as unknown as typeof fetch

    const adapter = makeAdapter({
      resolveCredential: async () => ({ ...CRED_A, access_token: 'tok-loomy-1' }),
      accountPool: pool as never,
      fetchImpl: fetcher,
    })
    await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch(() => null)

    // 8 个号每个都必须留下冷却标记（修复前只有 7 个，末号漏记 ⇒ 下次又被选中）。
    expect(marks.map((m) => m.accountId)).toEqual(ids)
  })

  /** ★ 末号之后池已空（`getAvailableAccount` 返回 null）→ 末号同样必须被标记。 */
  it('★★ 末号失败后池已空 → 末号仍被标记（不因「没有下一个号」而漏记）', async () => {
    const marks: Array<{ accountId: string }> = []
    const pool = {
      updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
      // 单账号池：首号失败后没有下一个候选
      getAvailableAccount: async () => null,
      findAccountIdByCredential: async () => 'loomy-A',
    }
    const fetcher = (async () => new Response(
      JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 },
    )) as unknown as typeof fetch

    const adapter = makeAdapter({
      resolveCredential: async () => CRED_A,
      accountPool: pool as never,
      fetchImpl: fetcher,
    })
    await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch(() => null)

    expect(marks.map((m) => m.accountId)).toEqual(['loomy-A'])
  })

  /**
   * ★★ 401 续期后**必须重新反查账号 id**（与 raccoon 的 `51ded6a` 同款缺陷，
   * loomy 当时未同步修）。
   *
   * `options.resolveCredential` 是**池优先 + 余额分档**的（`src/index.ts` 的
   * loomy 分支先 `loomyBalanceSelector.select()` 再解析该号的 ref），而
   * `refresh()` 续期/探测的是**池当前默认账号**。⇒ 续期后取回的凭据
   * **可能属于另一个账号**，而 `activeAccountId` 仍停在刷新前的那个号上。
   *
   * 旧实现不更新它 ⇒ 冷却标记**记在没发这次请求的号头上**：没耗尽的号被封 24h，
   * 而真该封的号下次仍被选中（本段要修的「卡死在一个号上」照旧）。
   * 与 AGENTS.md 记的 Qoder「标记用了会变的回调导致标错账号」同型。
   */
  it('★★ 401 续期后凭据换成了别的账号 → 标记记在**真正耗尽的那个号**上', async () => {
    const marks: Array<{ accountId: string }> = []
    // ⚠️ 桩必须自洽：id ↔ token 一一对应，否则 `findAccountIdByCredential`
    // 与 `getAvailableAccount` 会互相认错号（raccoon 侧写这条时踩过：
    // 取号发的是 `tok-raccoon-B`、而续期后是 `tok-B`，反查得到另一个 id）。
    const byToken: Record<string, string> = { 'tok-A': 'loomy-A', 'tok-B': 'loomy-B' }
    const pool = {
      updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
      getAvailableAccount: async (_p: string, _m: string, exclude?: ReadonlySet<string>) => {
        for (const token of ['tok-A', 'tok-B']) {
          const id = byToken[token]!
          if (exclude?.has(id)) continue
          return { entry: { id }, credential: { access_token: token, userid: id, phone: '13800000000' } }
        }
        return null
      },
      findAccountIdByCredential: async (_p: string, identity: string) => byToken[identity] ?? '',
    }
    // 第 1 次解析 = A 的凭据；续期后 = B 的凭据（生产语义：refresh 探测的是
    // 池当前默认账号，随后 resolveCredential 又按余额分档取号）。
    let resolves = 0
    const adapter = makeAdapter({
      resolveCredential: async () => (++resolves === 1
        ? { access_token: 'tok-A', userid: 'loomy-A', phone: '13800000001' }
        : { access_token: 'tok-B', userid: 'loomy-B', phone: '13800000002' }),
      accountPool: pool as never,
      // A 返回 401（触发续期）；此后无论哪个号都额度耗尽。
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const auth = String(new Headers(init.headers).get('Authorization') ?? '')
        if (auth.includes('tok-A')) {
          return new Response('{"code":200003}', { status: 401 })
        }
        return new Response(
          JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 },
        )
      }) as unknown as typeof fetch,
    })
    await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => null).catch(() => null)

    // 真正耗尽的是 B —— A 只返回了 401（认证类，本就不该写标记）。
    expect(marks.map((m) => m.accountId)).toEqual(['loomy-B'])
  })
})

/**
 * ★★ 额度冷却的**终点**：UTC+8 当日 24:00，不是「撞墙时刻 + 24h」。
 *
 * ## 缺陷形态（Gitee IKL80H，2026-10-13 用户真机报障）
 *
 * 用户原话：「0 点后 loomy 能用，我自己的账号实测。但该插件的 loomy 会说模型未到
 * 重置时间，不给用，目测是以积分耗尽的 24 小时做判定。」
 *
 * 根因：Loomy 的每日赠送额度（每日 5000）按 **UTC+8 自然日**重置，而旧实现记的是
 * `Date.now() + 24h` 的**滑动窗口**。23:50 烧光 ⇒ 标记落到**次日 23:50** ⇒ 跨过 0 点
 * 后上游已放行，插件仍判受限。
 *
 * ## 为什么必须有「反向」那一格
 *
 * 只断言「修复后 0 点后不再受限」是**可能恒真**的：判据整体失效（例如
 * `allAccountsRateLimitedForModel` 恒返回 `undefined`）同样会让它通过。故最后一格
 * 拿**变异体**（退回 +24h）跑同一时刻，要求它**必须判受限**——两侧一起才锁定方向。
 *
 * 证据出处：`src/loomy-adapter.ts` 的 `loomyCooldownResetAtMs` 逐格记录。
 */
describe('LoomyAdapter 额度冷却的终点（IKL80H：自然日 vs +24h）', () => {
  /** 2026-10-13 23:50 UTC+8 —— 当天额度烧光的时刻。 */
  const T_EXHAUST = Date.parse('2026-10-13T15:50:00.000Z')
  /** 2026-10-14 00:10 UTC+8 —— 跨过 0 点，上游已重置放行。 */
  const T_AFTER_MIDNIGHT = Date.parse('2026-10-13T16:10:00.000Z')

  it('quota 的终点 = UTC+8 次日 0 点（只差 10 分钟），不是 +24h', () => {
    expect(loomyCooldownResetAtMs('quota', T_EXHAUST)).toBe(nextUtc8DayStartMs(T_EXHAUST))
    expect(loomyCooldownResetAtMs('quota', T_EXHAUST) - T_EXHAUST).toBe(10 * 60_000)
    expect(loomyCooldownResetAtMs('quota', T_EXHAUST)).not.toBe(T_EXHAUST + 24 * 3_600_000)
  })

  /**
   * ⚠️ **本格对本次修复「无牙」——如实登记**：在恰好 0 点这个输入上，
   * `now + 24h` 与 `nextUtc8DayStartMs` 给出**同一个值**，故把实现退回旧写法
   * 本用例**仍然通过**（实测：变异 1 只杀掉 3 条，不含本条）。
   *
   * 留它的理由不是「守修复」，而是守**边界语义**：0 点撞墙时终点必须是
   * **再下一个** 0 点，不能返回「此刻」（那会让标记立即失效 ⇒ 同一请求内反复重试）。
   * 不为它编一条恒真断言来假装有牙。
   */
  it('恰好 UTC+8 0 点撞墙 → 终点是**再下一个** 0 点（当天刚开始，不是立即解禁）', () => {
    const midnight = Date.parse('2026-10-13T16:00:00.000Z')
    expect(loomyCooldownResetAtMs('quota', midnight) - midnight).toBe(24 * 3_600_000)
  })

  it('rate 仍是撞墙时刻 + 1 小时（本次改动不影响频率类）', () => {
    expect(loomyCooldownResetAtMs('rate', T_EXHAUST) - T_EXHAUST).toBe(3_600_000)
  })

  it('★★ 适配器写下的标记 = 自然日终点（注入时钟跑真实失败路径，端到端）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T_EXHAUST)
    try {
      const marks: number[] = []
      const pool = {
        updateModelRateLimit: async (_a: string, _m: string, resetAtMs: number) => {
          marks.push(resetAtMs)
        },
        getAvailableAccount: async () => null,
        findAccountIdByCredential: async () => 'loomy-A',
      }
      const adapter = makeAdapter({
        resolveCredential: async () => CRED,
        accountPool: pool as never,
        fetchImpl: (async () => new Response(
          JSON.stringify({ error: { message: '14018 Credits exhausted' } }), { status: 402 },
        )) as unknown as typeof fetch,
      })
      await adapter.stream({
        provider: 'loomy', model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }],
      } as never).next().then(() => null).catch(() => null)

      expect(marks).toHaveLength(1)
      expect(marks[0]).toBe(nextUtc8DayStartMs(T_EXHAUST))
      expect(marks[0]).not.toBe(T_EXHAUST + 24 * 3_600_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('★★ 用户症状回归：0 点后 10 分钟不再判「全部账号限流」（含反向对照）', () => {
    const marked = (resetAtMs: number) => [
      { id: 'loomy-A', provider: 'loomy', enabled: true, modelRateLimits: { 'MiniMax-M3': resetAtMs } },
    ] as never

    // 修复后的值：0 点已过 ⇒ 不再受限（用户要的行为）。
    expect(
      allAccountsRateLimitedForModel(marked(loomyCooldownResetAtMs('quota', T_EXHAUST)), 'MiniMax-M3', T_AFTER_MIDNIGHT),
    ).toBeUndefined()

    // 反向对照（变异体 = 旧实现）：同一时刻**必须**判受限，且距解禁 > 23h
    // —— 这正是用户看到「没到重置时间」的那一幕，证明上面那一格不是恒真。
    const regressed = allAccountsRateLimitedForModel(
      marked(T_EXHAUST + 24 * 3_600_000), 'MiniMax-M3', T_AFTER_MIDNIGHT,
    )
    expect(regressed).toBeDefined()
    expect((regressed!.resetAtMs - T_AFTER_MIDNIGHT) / 3_600_000).toBeGreaterThan(23)
  })
})

/**
 * ★ 图片能力覆盖（2026-10-14 用户报障：loomy 的 qwen3.8max 输入不能上图）。
 *
 * DSH 的图片准入闸门读的是**模型目录里的 `inputModalities`**
 *（`dsh-api-session-controller` 的 `MODEL_DOES_NOT_SUPPORT_IMAGES`），不是适配器
 * 内部的 `supportsImage`。所以这里断言的必须是宿主真正读到的那个字段，且**远端与
 * 兜底两条路径都要过** —— 只改一侧，远端可用时那一侧就白改了（`contextWindow`
 * 曾有同型隐患，见上方 issue IKJW31 一组）。
 */
describe('LoomyAdapter 图片能力覆盖（2026-10-14 远端漏报）', () => {
  /** 远端对 qwen-3.8-max 的真实声明：`input_modalities: ['text']`、`vision: false`。 */
  const textOnlyQwen = () => parseLoomyRemoteModels({
    data: [remoteEntry({
      id: 'qwen-3.8-max',
      name: 'Qwen 3.8 Max（x12.0）',
      capabilities: { reasoning: true, vision: false, input_modalities: ['text'] },
    })],
  })

  it('★ 远端路径：qwen-3.8-max 的目录条目含 image（图不再被准入闸门拦下）', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => textOnlyQwen() })
    const models = await adapter.listModels('loomy')
    const entry = models.find((m) => m.id === 'qwen-3.8-max')
    expect(entry?.inputModalities).toContain('image')
  })

  it('★ 兜底表路径：远端整体失败时同样含 image（两条路径同一判据）', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    const models = await adapter.listModels('loomy')
    const entry = models.find((m) => m.id === 'qwen-3.8-max')
    expect(entry?.inputModalities).toContain('image')
  })

  it('⚠️ 该家其余模型不受影响：纯文本模型仍只报 text', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    const models = await adapter.listModels('loomy')
    const byId = new Map(models.map((m) => [m.id, m.inputModalities]))
    expect(byId.get('spark-x')).toEqual(['text'])
    expect(byId.get('deepseek-v4-flash-0731')).toEqual(['text'])
  })

  it('⚠️ 远端声明纯文本的**其它**模型不得被覆盖表误放行（不恒真）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({
          id: 'spark-x',
          name: 'Spark X2.5（x0.1）',
          capabilities: { reasoning: true, input_modalities: ['text'] },
        })],
      }),
    })
    const models = await adapter.listModels('loomy')
    expect(models[0]!.inputModalities).toEqual(['text'])
  })

  /**
   * ★ 上游把 id 改成**大写**时不得静默失效（2026-10-14 审计发现）。
   *
   * 断言打在 `inputModalities`（宿主准入闸门真正读的字段）上，而不是内部
   * `supportsImage` —— 否则「适配器算对了但目录播报错了」这类分叉抓不到。
   * 远端原值逐字节大小写变体都要能过，同时**对外 id 必须原样保留**
   *（它是 `fallbackIndex` / `effortsForModel` 的索引键，改了会连带静默失效）。
   */
  it('★ 远端把 id 下成大写时，qwen-3.8-max 仍判定支持图片且对外 id 不变', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({
          id: 'Qwen-3.8-Max',
          name: 'Qwen 3.8 Max（x12.0）',
          capabilities: { reasoning: true, vision: false, input_modalities: ['text'] },
        })],
      }),
    })
    const models = await adapter.listModels('loomy')
    const entry = models.find((m) => m.id === 'Qwen-3.8-Max')
    expect(entry, '对外 id 必须原样保留（不得被归一化改掉）').toBeDefined()
    expect(entry?.inputModalities, '闸门读的字段').toContain('image')
  })
})

/**
 * ★★ 凭据探测失败**不得**打断本轮（Gitee 报障，会话 `session-bfb9b616`，2026-10-20）
 *
 * ## 缺陷形态
 *
 * 只读探测端点 `GET /points/records` 与「凭据是否有效」是两件事，但适配器把
 * 探测抛出的**任何**异常都当终态：
 *
 * ```
 * if (credential === undefined || isLoomyExpired(credential)) {
 *   await this.options.refresh()   // ← 抛出即整轮失败
 * }
 * ```
 *
 * 真实伤情：同一渠道第 4、5 轮相隔 27 分钟两次整轮失败，文案分别是
 * `Loomy 凭据探测失败：系统内部错误`（业务错误）与
 * `Loomy 凭据探测网络失败：The operation was aborted due to timeout`（60s 超时），
 * 而**同一时刻面板三个账号余额全部读得到** —— 渠道是活的，死的只是探测。
 *
 * ## 修法边界
 *
 * 只放过**非终态**；`RefreshTokenExpiredError` 仍必须抛（否则「请重新登录」
 * 这条唯一出路会被吞掉）。最后一条用例是**反向对照** —— 没有它，
 * 「凡错就放过」也能让前两条全绿。
 */
describe('★★ 凭据探测失败不得打断本轮（2026-10-20 报障）', () => {
  const EXPIRED: LoomyCredential = { ...CRED, expires_at: '1' }
  const SSE = [
    'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  function fetchSpy(captured: { auth: string[] }) {
    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.auth.push(String(new Headers(init?.headers).get('Authorization') ?? ''))
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
  }

  async function run(adapter: LoomyAdapter) {
    for await (const _chunk of adapter.stream({
      provider: 'loomy',
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) {
      // 只为把请求发出去
    }
  }

  it('探测抛业务错误（系统内部错误）→ 继续用现有凭据发请求，并留告警', async () => {
    const captured = { auth: [] as string[] }
    const warns: string[] = []
    const adapter = makeAdapter({
      resolveCredential: async () => EXPIRED,
      refresh: async () => { throw new Error('Loomy 凭据探测失败：系统内部错误') },
      warn: (message) => warns.push(message),
      fetchImpl: fetchSpy(captured),
    })

    await expect(run(adapter)).resolves.toBeUndefined()
    expect(captured.auth, '请求必须真的发出一次').toHaveLength(1)
    expect(captured.auth[0], '用的仍是那份（本地判过期的）凭据').toContain(EXPIRED.access_token)
    expect(warns, '非终态失败必须留痕，不能静默').toHaveLength(1)
    expect(warns[0]).toContain('系统内部错误')
  })

  it('探测超时（aborted due to timeout）→ 同样放行', async () => {
    const captured = { auth: [] as string[] }
    const warns: string[] = []
    const adapter = makeAdapter({
      resolveCredential: async () => EXPIRED,
      refresh: async () => {
        throw new Error('Loomy 凭据探测网络失败：The operation was aborted due to timeout')
      },
      warn: (message) => warns.push(message),
      fetchImpl: fetchSpy(captured),
    })

    await expect(run(adapter)).resolves.toBeUndefined()
    expect(captured.auth).toHaveLength(1)
    expect(warns[0]).toContain('timeout')
  })

  it('反向对照：凭据确实失效（RefreshTokenExpiredError）→ 仍然抛错', async () => {
    const captured = { auth: [] as string[] }
    const adapter = makeAdapter({
      resolveCredential: async () => EXPIRED,
      refresh: async () => {
        const error = new Error('Loomy 凭证已失效，请重新登录（缺少 token）')
        error.name = 'RefreshTokenExpiredError'
        throw error
      },
      fetchImpl: fetchSpy(captured),
    })

    await expect(run(adapter)).rejects.toThrow('凭证已失效')
    expect(captured.auth, '终态失败不该再发业务请求').toHaveLength(0)
  })
})

/**
 * ★★★ **401/403 分支**的探测失败同样不得打断整轮（2026-10-20 审计补修）。
 *
 * ## 为什么必须单独一组（上一组测不到它）
 *
 * 上面那组走的是**前置门禁**（`credential === undefined || isLoomyExpired`）。
 * 而 `await this.options.refresh()` 在适配器里有**两处**调用点，第二处是
 * 「业务请求回来 401/403 再探测一次」。PR !124 只修了前置门禁那一处。
 *
 * ⚠️ **实测证据**：把 401 分支改坏（降级成静默放过 / 换回裸调用）后，
 * 上一组那 64 条**全部通过** —— 缺陷就藏在没有用例的路径里。
 * 本组的作用正是把这条路径钉住。
 *
 * ## 401 分支的修法与前置门禁**不同**（别照抄）
 *
 * 前置门禁：探测失败 → warn → **继续用现有凭据发请求**（本来就没发出过请求）。
 * 401 分支：探测失败 → warn → **不重取、不重发**，直接落换号循环。
 * 理由（对抗审计 D1–D4 实测）：探测失败后重取往往拿到**同一份坏凭据**，
 * 重发就是白烧一次（无池恒 401 发 2 次、A 坏 B 好发 3 次、8 号全 401 发 9 次）。
 */
describe('★★★ 401/403 分支的探测失败也不得打断整轮（审计补修）', () => {
  const FRESH: LoomyCredential = { ...CRED }
  const EXPIRED: LoomyCredential = { ...CRED, expires_at: '1' }
  const SSE = [
    'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  /** 按调用序列返回状态码；记录每次用的 token。 */
  function seqFetch(statuses: readonly number[], auths: string[]) {
    let n = 0
    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
      auths.push(String(new Headers(init?.headers).get('Authorization') ?? ''))
      const status = statuses[Math.min(n, statuses.length - 1)]!
      n += 1
      if (status === 200) {
        return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify({ code: status }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  async function drain(adapter: LoomyAdapter) {
    for await (const _chunk of adapter.stream({
      provider: 'loomy',
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) {
      // 只为把请求发出去
    }
  }

  it('★★ 业务端点 401 + 探测抛非终态错误 ⇒ 不得整轮失败（必须留 warn）', async () => {
    // ⚠️ 用 **未过期** 的凭据 ⇒ 不进前置门禁，只走 401 分支（这是本组的关键）。
    const auths: string[] = []
    const warns: string[] = []
    const adapter = makeAdapter({
      resolveCredential: async () => FRESH,
      refresh: async () => { throw new Error('Loomy 凭据探测失败：系统内部错误') },
      warn: (message) => warns.push(message),
      fetchImpl: seqFetch([401], auths),
    })

    // 无池 ⇒ 换号无从谈起，最终仍会以「所有账号均不可用」失败；
    // 但那必须是 **LlmError（AUTH）**，而不是探测那层的裸 Error。
    await expect(drain(adapter)).rejects.toThrow(/所有账号均不可用|4?01/)
    expect(warns, '非终态探测失败必须留痕（与前置门禁同口径）').toHaveLength(1)
    expect(warns[0], '文案必须点名是 401/403 之后那一处').toContain('401/403')
  })

  it('★★★ 决定性判据：A 的 token 401、池里 B 正常 ⇒ 必须换到 B 成功', async () => {
    // ⚠️⚠️ 这条是本次审计的核心回归 —— 修前实测 `getAvailableAccount` 调用 **0** 次、
    //    B **从未被尝试**、整轮失败。PR 声称「真失效由换号接住」正是在此处被证伪。
    const auths: string[] = []
    const B: LoomyCredential = { ...CRED, access_token: 'tok-B' }
    let resolveCount = 0
    const adapter = makeAdapter({
      // 第一次给 A（401），之后仍给 A（模拟「重取拿到同一份坏凭据」——
      // 修法要求探测失败时**不重取**，故这条只是让「照抄前置分支」的写法暴露）
      resolveCredential: async () => { resolveCount += 1; return FRESH },
      refresh: async () => { throw new Error('Loomy 凭据探测失败：系统内部错误') },
      warn: () => {},
      fetchImpl: seqFetch([401, 200], auths),
      accountPool: {
        findAccountIdByCredential: async () => 'acc-A',
        getAvailableAccount: async () => ({
          entry: { id: 'acc-B', credentialRef: 'r' },
          credential: B,
        }),
        updateModelRateLimit: async () => {},
      } as never,
    })

    await expect(drain(adapter)).resolves.toBeUndefined()
    // ① 换号真的发生了：第二个不同的 token 被发出去。
    expect(auths.length, '必须有第二次请求（换号）').toBeGreaterThanOrEqual(2)
    expect(auths.some((a) => a.includes('tok-B')), '必须真的换到 B').toBe(true)
    // ② **不得重发同一个坏 token**（对抗审计 D3 的「白烧一次」）。
    const aTimes = auths.filter((a) => a.includes(FRESH.access_token)).length
    expect(aTimes, 'A 的坏 token 只该发一次（探测失败后不重取不重发）').toBe(1)
  })

  it('★★ 反向对照：401 后探测报**终态** ⇒ 仍必须抛（「请重新登录」是唯一出路）', async () => {
    const auths: string[] = []
    const adapter = makeAdapter({
      resolveCredential: async () => FRESH,
      refresh: async () => {
        const error = new Error('Loomy 凭证已失效，请重新登录（缺少 token）')
        error.name = 'RefreshTokenExpiredError'
        throw error
      },
      warn: () => {},
      fetchImpl: seqFetch([401], auths),
    })

    await expect(drain(adapter)).rejects.toThrow('凭证已失效')
  })

  /**
   * ★★ 「凭据未配置 / 凭据解析失败」必须是**终态**（否则「请重新登录」被吞）。
   *
   * ⚠️ 这两格原先在 `refreshAccountCredential()` 里抛的是**普通 `Error`**，
   * 而终态判据只认 `name === 'RefreshTokenExpiredError'` ⇒ 被判成非终态。
   * 生产热路径在**池里有账号时**走的正是那个入口 ⇒ 终态被降级。
   */
  it('★★ 按 ref 入口的「凭据未配置 / 解析失败」必须是终态（不得被降级吞掉）', async () => {
    const { LoomyAuth } = await import('../../src/loomy-auth.js')
    const { Context } = await import('@deepseek-ai/cordis')
    const ctx = new Context()
    // 最小 credentials 替身：resolve 恒返回 undefined ⇒ 走「凭据未配置」那一格
    ctx.provide('credentials' as never, {
      resolve: async () => undefined,
      get: async () => undefined,
      set: async () => {},
      unset: async () => {},
    } as never)
    const auth = new LoomyAuth(ctx, { ...LOOMY, id: 'loomy' } as never)
    const error = await auth.refreshAccountCredential('LOOMY_ACCOUNT_TEST').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error, '凭据未配置必须抛错').toBeInstanceOf(Error)
    expect(
      (error as Error).name,
      '必须是终态名 RefreshTokenExpiredError，否则适配器会降级成「继续用现有凭据」',
    ).toBe('RefreshTokenExpiredError')
  })
})

/**
 * ★★ 探测非终态失败后的**退避**：不得每轮都白等 60 秒（2026-10-20 审计 E-3）。
 *
 * ## 缺陷形态
 *
 * `isLoomyExpired` 读本地 `expires_at`（登录时刻 +14 天推算**写下**，服务端不下发，
 * 本插件**永不改写**）⇒ 本地判过期后，前置探测分支**每一轮**都会进。而探测的
 * 超时上限是 `LOOMY_REQUEST_TIMEOUT_MS` = 60 秒，且 `probeCredential` 用的是
 * **独立**的 `AbortSignal.timeout`、不联动调用方 `signal` ⇒ 最坏情况是
 * 「每轮首 token 前白等 60 秒」，用户点停止也打断不了。
 *
 * 审计实测：`refresh` 永挂 ⇒ 8 秒后仍未返回；缩短到 250ms 后
 * `perTurnMs=[316,315,310]`（**每轮各等一次**）。
 *
 * ## 判据
 *
 * 退避窗口（{@link LOOMY_PROBE_BACKOFF_MS}，5 分钟）内**不再调用** `refresh`，
 * 但仍然**照常发业务请求**；探测成功时立刻清掉退避。
 * ⚠️ 变异：删掉 `if (!this.probeBackedOff(...))` 那一层 ⇒ 本组必红。
 */
describe('★★ 探测失败后的退避：不得每轮都白等探测超时（审计 E-3）', () => {
  const EXPIRED: LoomyCredential = { ...CRED, expires_at: '1' }
  const SSE = [
    'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  function okFetch() {
    let calls = 0
    const fn = (async () => {
      calls += 1
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    return { fn, calls: () => calls }
  }

  async function drain(adapter: LoomyAdapter) {
    for await (const _chunk of adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }],
    } as never)) { /* drain */ }
  }

  it('★★ 第 1 轮探测失败 ⇒ 第 2 轮**不再探测**，但业务请求照发', async () => {
    const f = okFetch()
    let refreshCalls = 0
    let now = 1_000
    const adapter = makeAdapter({
      resolveCredential: async () => EXPIRED,
      refresh: async () => { refreshCalls += 1; throw new Error('Loomy 凭据探测失败：系统内部错误') },
      warn: () => {},
      fetchImpl: f.fn,
      now: () => now,
    })

    await drain(adapter)
    expect(refreshCalls, '第 1 轮必须真的探测过').toBe(1)
    expect(f.calls(), '业务请求必须照发（探测失败不阻断）').toBe(1)

    // 第 2 轮：仍在退避窗口内（未推进时间）
    await drain(adapter)
    expect(refreshCalls, '退避窗口内不得再探测（否则每轮白等 60 秒）').toBe(1)
    expect(f.calls(), '业务请求仍要照发').toBe(2)
  })

  it('★★ 退避窗口过期后必须重新探测（上游恢复要能纠正）', async () => {
    const f = okFetch()
    let refreshCalls = 0
    let fail = true
    let now = 1_000
    const adapter = makeAdapter({
      resolveCredential: async () => EXPIRED,
      refresh: async () => {
        refreshCalls += 1
        if (fail) throw new Error('Loomy 凭据探测失败：系统内部错误')
      },
      warn: () => {},
      fetchImpl: f.fn,
      now: () => now,
    })

    await drain(adapter)
    expect(refreshCalls).toBe(1)

    fail = false
    now += LOOMY_PROBE_BACKOFF_MS + 1
    await drain(adapter)
    expect(refreshCalls, '窗口过期后必须重探').toBe(2)
  })

  it('★★ 探测**成功**时立刻清退避（没理由继续跳过）', async () => {
    const f = okFetch()
    let refreshCalls = 0
    let fail = true
    let now = 1_000
    const adapter = makeAdapter({
      resolveCredential: async () => EXPIRED,
      refresh: async () => {
        refreshCalls += 1
        if (fail) throw new Error('Loomy 凭据探测失败：系统内部错误')
      },
      warn: () => {},
      fetchImpl: f.fn,
      now: () => now,
    })

    await drain(adapter)
    expect(refreshCalls).toBe(1) // 失败 ⇒ 进退避

    // 未推进时间，但这次探测成功 ⇒ 必须**清掉**退避
    fail = false
    // 先手动把退避窗口推过一点，让「清掉」这件事可观测：
    // ⚠️ 若不推进时间，窗口内根本不会再探测，测不到「清掉」。
    now += LOOMY_PROBE_BACKOFF_MS + 1
    await drain(adapter)
    expect(refreshCalls, '窗口过期后重探且成功').toBe(2)

    // 成功之后**不需要**再等一个完整窗口：下一次（哪怕时间没动）仍会探测。
    await drain(adapter)
    expect(refreshCalls, '成功后必须清退避 ⇒ 下一轮照常探测').toBe(3)
  })

  it('★★ 反向对照：终态仍必须抛，且不产生退避（终态是「请重新登录」）', async () => {
    const f = okFetch()
    let refreshCalls = 0
    const adapter = makeAdapter({
      resolveCredential: async () => EXPIRED,
      refresh: async () => {
        refreshCalls += 1
        const error = new Error('Loomy 凭证已失效，请重新登录（缺少 token）')
        error.name = 'RefreshTokenExpiredError'
        throw error
      },
      warn: () => {},
      fetchImpl: f.fn,
    })

    await expect(drain(adapter)).rejects.toThrow('凭证已失效')
    // ⚠️ 终态不进退避（它每一轮都该抛，用户据此去重新登录）；
    //    故第二次仍会探测 —— 这里只断言「不会静默放行」。
    await expect(drain(adapter)).rejects.toThrow('凭证已失效')
    expect(refreshCalls).toBe(2)
    expect(f.calls(), '终态不得发出业务请求').toBe(0)
  })
})
/**
 * ★★ `HTTP 200 + 业务码 100002` 也必须能换号（2026-10-20 审计 E-1，**既有缺陷**）。
 *
 * ## 缺陷形态
 *
 * Loomy 的业务失败**恒 HTTP 200**（`src/loomy.ts` 的协议说明：
 * 「带错的那个 → HTTP 200 + `{"code":"100002","desc":"缺少 token"}`」），
 * 而请求级换号循环写在 `if (!response.ok)` 里 ⇒ 200 的认证失败**一次都不换号**。
 * 多账号场景下**从未尝试过好号**，终错是 `SERVER`（「响应不是 SSE」）而非 `AUTH`。
 *
 * 实测（基线 `b5dab83` 同样）：
 * ```
 * classifyLoomyFailure('100002', 200)  ⇒ 'other'  rotate=false
 * classifyLoomyFailure('100002', 401)  ⇒ 'auth'   rotate=true
 * ```
 *
 * ## ⚠️ 为什么判据**不进** `classifyLoomyFailure`
 *
 * 那个分类器与 `classifyRaccoonFailure` 明文规定「必须逐格同构」，并由本文件的
 * 「与 raccoon 对拍」用例逐条守着；而 `100002` 是 Loomy 独有码。
 * 塞进去会当场把对拍用例变红，或逼着给 raccoon 编一个它没有的码。
 * ⇒ 业务码这一腿留在本家自己的 {@link isLoomyAuthBusinessCode} 里。
 */
describe('★★ 200 + 业务码 100002 也要能换号（审计 E-1）', () => {
  const CRED_A: LoomyCredential = { access_token: 'tok-A', userid: 'ua', phone: '13800000001' }
  const CRED_B: LoomyCredential = { access_token: 'tok-B', userid: 'ub', phone: '13800000002' }
  const SSE = 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'

  async function drain(adapter: LoomyAdapter) {
    for await (const _chunk of adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }],
    } as never)) { /* drain */ }
  }

  it('★★ 判据本身：只有 100002 是认证业务码，别的业务码不是', () => {
    expect(isLoomyAuthBusinessCode({ ok: false, code: '100002' })).toBe(true)
    expect(isLoomyAuthBusinessCode({ ok: false, code: '100001' })).toBe(false) // 参数错误
    expect(isLoomyAuthBusinessCode({ ok: false, code: '200003' })).toBe(false)
    expect(isLoomyAuthBusinessCode({ ok: true, code: '0' })).toBe(false)
  })

  it('★★★ A 回「200 + 100002」、池里 B 正常 ⇒ 必须换到 B 成功', async () => {
    const auths: string[] = []
    const warmed: string[] = []
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const auth = String(new Headers(init?.headers).get('Authorization') ?? '')
      auths.push(auth)
      if (auth.includes('tok-A')) {
        // ⚠️ **HTTP 200** + JSON 认证信封 —— 这正是 Loomy 表达「token 缺失」的主通道
        return new Response(
          JSON.stringify({ code: '100002', desc: '缺少 token' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const adapter = makeAdapter({
      resolveCredential: async () => CRED_A,
      refresh: async () => {},
      warn: (m) => warmed.push(m),
      fetchImpl,
      accountPool: {
        findAccountIdByCredential: async (_p: string, tok: string) => (tok === 'tok-A' ? 'acc-A' : 'acc-B'),
        getAvailableAccount: async () => ({ entry: { id: 'acc-B' }, credential: CRED_B }),
        updateModelRateLimit: async () => { /* 认证类不该写冷却 */ },
      } as never,
    })

    await expect(drain(adapter)).resolves.toBeUndefined()
    expect(auths.some((a) => a.includes('tok-B')), '必须换到 B').toBe(true)
    expect(warmed.some((m) => m.includes('100002')), '必须留痕（否则静默换号）').toBe(true)
  })

  it('★★ 反向对照：非认证业务码（100001 参数错误）**不得**被当成认证失败换号', async () => {
    const auths: string[] = []
    let picks = 0
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      auths.push(String(new Headers(init?.headers).get('Authorization') ?? ''))
      // ⚠️ 100001 = 参数错误，换号无益 ⇒ 必须原样报错、**不换号**
      return new Response(
        JSON.stringify({ code: '100001', desc: 'params error' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const adapter = makeAdapter({
      resolveCredential: async () => CRED_A,
      refresh: async () => {},
      warn: () => {},
      fetchImpl,
      accountPool: {
        findAccountIdByCredential: async () => 'acc-A',
        getAvailableAccount: async () => { picks += 1; return { entry: { id: 'acc-B' }, credential: CRED_B } },
        updateModelRateLimit: async () => {},
      } as never,
    })

    // 非 SSE ⇒ 报「响应不是 SSE」；关键是**不得换号**
    await expect(drain(adapter)).rejects.toThrow()
    expect(picks, '非认证业务码不得换号（换谁都会失败，白烧候选）').toBe(0)
    expect(auths, '只该发一次').toHaveLength(1)
  })

  it('★★ 声明 JSON 但**不是**认证码 ⇒ 响应体必须原样交回下游（不得读干）', async () => {
    // ⚠️⚠️ 这条守的是「`text()` 读完 body 之后**必须**重建响应」。
    //    否则下游拿到一个已消耗的流：`consumeOpenAiSse` 会报
    //    「响应不是 SSE（没有任何 data: 帧）」并**丢掉上游原话**。
    //    实测（我第一版实现就是这个形态）：变异「读完不重建」⇒
    //    错误文案从上游业务码退化成空流，用户看不到真实原因。
    const adapter = makeAdapter({
      resolveCredential: async () => CRED_A,
      refresh: async () => {},
      fetchImpl: (async () => new Response(
        JSON.stringify({ code: '200003', desc: '上游原话必须可见' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
    })
    // 非认证码 ⇒ 不换号、不转 401；但 body 必须还能被下游读到。
    const message = await adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }],
    } as never).next().then(() => '').catch((e: Error) => String(e.message))
    // ⚠️ 断言「上游原话仍在文案里」——这是「没读干」的可观测判据。
    expect(message, '上游业务码原话必须保留（body 未被读干）').toContain('200003')
  })

  it('★★ 反向对照：SSE 正文不得被这条腿吃掉（content-type 不是 JSON 就零成本跳过）', async () => {
    const adapter = makeAdapter({
      resolveCredential: async () => CRED_A,
      refresh: async () => {},
      fetchImpl: (async () => new Response(SSE, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch,
    })
    // 能正常读出正文内容 ⇒ 说明没有在中间被 text() 读干
    const chunks: string[] = []
    for await (const chunk of adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }],
    } as never)) {
      // ⚠️ 正文走的是 `text-delta`（实测 chunk 形状：
      //    block-start → text-delta{text:"ok"} → block-end → finish）。
      const c = chunk as { type?: string; text?: string }
      if (c.type === 'text-delta') chunks.push(String(c.text))
    }
    expect(chunks.join(''), 'SSE 正文必须完整到达（不能被 100002 那条腿读干）').toContain('ok')
  })
})
/**
 * ★★ 探测必须针对「**本轮要用的**那份凭据」，而不是「池默认号」
 * （2026-10-20 审计 E-2，**既有缺陷**）。
 *
 * ## 缺陷形态
 *
 * 热路径把 `refresh()` 的结果当作「**本轮**凭据能不能用」的裁决，而接线层原先
 * 恒探测 `pool.getAvailableAccount(LOOMY.id, '')` = **池默认号** ⇒ 二者可能
 * 不是同一个号。后果：本轮要用的号**完全可用**，仅因**另一个号**报终态，
 * 整轮就被打死（实测：业务请求 0 次）。
 *
 * 这与 `401` 分支注释里自己写过的「二者可能不是同一个号」是同一个坑：
 * 那处讨论的是**冷却标记记错号**，这处是**裁决打死错的人**。
 *
 * ## 修法
 *
 * `refresh(forCredential?)` 多一个可选参数；适配器把**本轮凭据**传下去，
 * 接线层按 access_token 反查它自己的 ref 再探测。
 * ⚠️ 反查失败要**退回原行为**（探测默认号），不许凭空跳过探测。
 */
describe('★★ 探测针对本轮凭据，而非池默认号（审计 E-2）', () => {
  const FRESH: LoomyCredential = { access_token: 'tok-mine', userid: 'um', phone: '13800000009' }
  const OTHER: LoomyCredential = { access_token: 'tok-other', userid: 'uo', phone: '13800000008' }
  const SSE = 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'

  async function drain(adapter: LoomyAdapter) {
    for await (const _chunk of adapter.stream({
      provider: 'loomy', model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }],
    } as never)) { /* drain */ }
  }

  it('★★ 适配器必须把**本轮凭据**传给 refresh（否则接线层只能猜）', async () => {
    let received: LoomyCredential | undefined
    const adapter = makeAdapter({
      // 本地判过期 ⇒ 走前置探测分支（这样才会调 refresh）
      resolveCredential: async () => ({ ...FRESH, expires_at: '1' }),
      refresh: async (forCredential) => { received = forCredential },
      fetchImpl: (async () => new Response(SSE, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch,
    })

    await drain(adapter)
    expect(received, '必须把本轮凭据传下去（否则接线层只能探测池默认号）').toBeDefined()
    expect(received?.access_token, '传的必须是**本轮**那一份').toBe('tok-mine')
  })

  it('★★ 反向对照：探测报终态且**针对的是本轮凭据** ⇒ 仍然抛（该重登的是我）', async () => {
    const adapter = makeAdapter({
      resolveCredential: async () => ({ ...FRESH, expires_at: '1' }),
      refresh: async (forCredential) => {
        // ⚠️ 只有「探测对象就是本轮这份」时才该把终态算到本轮头上
        expect(forCredential?.access_token).toBe('tok-mine')
        const error = new Error('Loomy 凭证已失效，请重新登录（缺少 token）')
        error.name = 'RefreshTokenExpiredError'
        throw error
      },
      fetchImpl: (async () => new Response(SSE, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch,
    })

    await expect(drain(adapter)).rejects.toThrow('凭证已失效')
  })

  it('★★ OTHER 号的存在不改变行为：本轮凭据决定一切', async () => {
    // 这条锁的是「参数传递的语义」：无论池里还有谁，传给 refresh 的都必须是本轮这份。
    const seen: string[] = []
    const adapter = makeAdapter({
      resolveCredential: async () => ({ ...FRESH, expires_at: '1' }),
      refresh: async (forCredential) => { seen.push(forCredential?.access_token ?? '(none)') },
      fetchImpl: (async () => new Response(SSE, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch,
      accountPool: {
        // 池里有另一个号（OTHER），且它是「默认号」—— 旧实现会探测它
        findAccountIdByCredential: async () => '',
        getAvailableAccount: async () => ({ entry: { id: 'acc-other' }, credential: OTHER }),
        updateModelRateLimit: async () => {},
      } as never,
    })

    await drain(adapter)
    expect(seen, '传下去的必须是本轮凭据，而不是池默认号').toEqual(['tok-mine'])
  })
})
