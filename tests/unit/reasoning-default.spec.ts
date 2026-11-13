/**
 * 「选择模型后默认取最强思考档」的行为守卫（2026-11-11 用户功能）。
 *
 * ## 被锁死的两个缺陷方向
 *
 * ① **只包 `resolveModel`、漏掉 `prepareCall`** —— 选择器显示 Max、请求仍按 high
 *    发。生产路径是 `adapter.prepareCall(...)` → `normalizeModelInfo(call.model)`，
 *    **从不**调用顶层 `resolveModel`（见 `reasoning-default.ts` 模块头）。这条
 *    与 `token-ledger-wiring.spec.ts` 的「两层包装」是同一条踩坑史。
 * ② **强档算错** —— 把「取最大」写成 `efforts[0]`、或忘了排除 `off`/`none`、
 *    或选了未登记的私有名。这类错误在界面上表现为「档位没变强」，而**零报错**。
 *
 * ## 为什么既有 156 处 `defaultEffort` 断言一条都不用改
 *
 * 它们全都直接 `new XxxAdapter(...)`（`model-catalog-parity.spec.ts` 的整份对拍
 * 也是），**绕过注册漏斗** ⇒ 测的是「模型默认」语义，而本层改的是「注册后
 * 宿主看到的那份元数据」。两条口径必须分开，否则「模型默认」会被偏好污染、
 * 将来审查「这家该给什么默认」时无从对照。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { registerAdapterIdempotent } from '../../src/llm-register-compat.js'
import {
  PROVIDERS_WITHOUT_REASONING,
  configureStrongestReasoningEnabled,
  providerWithoutReasoning,
  registeredChannelIds,
  resetReasoningDefaultAnnouncements,
  strongestDeclaredEffort,
  strongestReasoningEnabled,
  titleEffortWhenStrongest,
  weakestThinkingEffort,
  withStrongestDefaultEffort,
  withStrongestReasoningDefault,
  type DeclaredReasoning,
} from '../../src/reasoning-default.js'
import { reasoningRankOf, CANONICAL_REASONING_EFFORTS } from '../../src/reasoning-ladder.js'
import { CLINE_REASONING_EFFORTS } from '../../src/cline-product.js'
import { LOOMY_EFFORTS } from '../../src/loomy-product.js'

// ⚠️ 日志去重态是**进程级**的（见 `reasoning-default.ts` 的 `announced`）：
//    用例之间必须复位，否则「只在首次打日志」那几条会随执行顺序变化。
beforeEach(() => { resetReasoningDefaultAnnouncements() })

// ⚠️ 开关也是**进程级**的模块状态：每条用例结束后复位成「未接线」（= 恒开），
//    否则一条关掉开关的用例会污染它后面所有用例（真实污染形态，且报错看起来
//    毫无关联）。
afterEach(() => { configureStrongestReasoningEnabled(undefined) })

// ───────────────────── ① 纯函数：最强档的选择 ─────────────────────

describe('strongestDeclaredEffort：档位选择表', () => {
  /**
   * ⚠️ 每行都对应**真实渠道的声明**（注释里点名），不是编的形态。
   * `efforts` 用真实顺序（远端下发的顺序，故意不排序 —— 本函数必须顺序无关）。
   */
  const TABLE: ReadonlyArray<{ name: string; efforts: readonly string[]; want: string | undefined }> = [
    // trae 远端 `reasoning_effort_config.options` 实测形态。
    { name: 'trae（无 max，最高 extra_high）', efforts: ['light', 'high', 'extra_high'], want: 'extra_high' },
    // buddy / workbuddy / zcode / autoclaw 的产品级三档。
    { name: 'buddy/zcode（low/high/max）', efforts: ['low', 'high', 'max'], want: 'max' },
    // loomy 五档。
    { name: 'loomy（none 在列）', efforts: ['none', 'low', 'medium', 'high', 'xhigh'], want: 'xhigh' },
    // cline 五档，`max` 的 UI 名是 Extra。
    { name: 'cline（含 none）', efforts: ['none', 'low', 'medium', 'high', 'max'], want: 'max' },
    // codearts / raccoon 的两档：on 与 high 同 rank，规范名更靠后的 high 胜。
    { name: 'codearts/raccoon（off/on）', efforts: ['off', 'on'], want: 'on' },
    // magicrew 只有两档，最强就是 high。
    { name: 'magicrew（none/high）', efforts: ['none', 'high'], want: 'high' },
    // gemini：`tiered` 未登记强度 ⇒ 不参与，`high` 才是最高。
    { name: 'gemini（tiered 不参与）', efforts: ['low', 'medium', 'high', 'tiered'], want: 'high' },
    // minimax M3.1：`default` 未登记 ⇒ 不参与；`max` 胜。
    { name: 'minimax（default 不参与）', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], want: 'max' },
    // 聚合：8 个规范档全在，**封顶 max**（ultra 不选）。
    {
      name: 'aggregate（封顶 max，不选 ultra）',
      efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      want: 'max',
    },
    // 只声明了 ultra 的极端形态 ⇒ 退回它（总比不动强）。
    { name: '只有 ultra（超出封顶）', efforts: ['ultra'], want: 'ultra' },
    // 只有关闭档 ⇒ 没有可提的档。
    { name: '只有 none（modelscope）', efforts: ['none'], want: undefined },
    { name: '只有 off', efforts: ['off'], want: undefined },
    // 全是未登记的私有名 ⇒ 不猜。
    { name: '全未登记', efforts: ['adaptive', 'turbo'], want: undefined },
    { name: '空数组', efforts: [], want: undefined },
  ]

  for (const row of TABLE) {
    it(`⚠️ ${row.name} → ${String(row.want)}`, () => {
      expect(strongestDeclaredEffort(row.efforts)).toBe(row.want)
    })
  }

  it('⚠️ 顺序无关：同一组档位打乱后结果不变', () => {
    const base = ['light', 'high', 'extra_high']
    expect(strongestDeclaredEffort([...base].reverse())).toBe('extra_high')
    expect(strongestDeclaredEffort([base[1]!, base[0]!, base[2]!])).toBe('extra_high')
  })

  it('⚠️ 同 rank 取规范名更靠后的（high 胜 on），且与输入顺序无关', () => {
    // 两者 rank 都是 5（`REASONING_EFFORT_RANK`），必须稳定落到 `high`。
    expect(reasoningRankOf('on')).toBe(reasoningRankOf('high'))
    expect(strongestDeclaredEffort(['on', 'high'])).toBe('high')
    expect(strongestDeclaredEffort(['high', 'on'])).toBe('high')
  })
})

describe('weakestThinkingEffort：标题请求用的最弱档', () => {
  it('⚠️ 跳过关闭档，取最弱的「开思考」档', () => {
    expect(weakestThinkingEffort(['none', 'low', 'high', 'max'])).toBe('low')
    expect(weakestThinkingEffort(['off', 'light', 'high', 'extra_high'])).toBe('light')
    // gemini 的 `medium` 是已登记的最弱一跳（`low` 也在，故取 low）。
    expect(weakestThinkingEffort(['low', 'medium', 'high', 'tiered'])).toBe('low')
    // 只有 medium 时就是它（不能被 tiered 这种未登记名顶替）。
    expect(weakestThinkingEffort(['medium', 'tiered'])).toBe('medium')
  })

  it('⚠️ 没有可用的「开思考」档 ⇒ undefined（调用方保留原档位）', () => {
    expect(weakestThinkingEffort(['none'])).toBeUndefined()
    expect(weakestThinkingEffort(['off', 'none'])).toBeUndefined()
    expect(weakestThinkingEffort([])).toBeUndefined()
    expect(weakestThinkingEffort(['adaptive'])).toBeUndefined()
  })
})

// ───────────────────── ② 纯函数：元数据改写 ─────────────────────

/** 造一份最小元数据（形状与 `LlmResolvedModelInfo` 一致）。 */
function info(defaultEffort: string | undefined, efforts: readonly string[]): {
  provider: string
  id: string
  name: string
  reasoning: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
} {
  return {
    provider: 'p',
    id: 'm',
    name: 'M',
    reasoning: {
      efforts: efforts.map((id) => ({ id, name: id })),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    },
  }
}

describe('withStrongestDefaultEffort：改写规则', () => {
  it('⚠️ 把 high 提到 max', () => {
    const out = withStrongestDefaultEffort(info('high', ['low', 'high', 'max']))
    expect(out.reasoning.defaultEffort).toBe('max')
    // 档位列表本身**不得**被改动（顺序是展示顺序，Issue IKLIDV）。
    expect(out.reasoning.efforts.map((e) => e.id)).toEqual(['low', 'high', 'max'])
  })

  it('⚠️ 原本没声明 defaultEffort 的模型也被补上最强档', () => {
    // opencode 等渠道正是这种形态（刻意不下发默认档）。
    const out = withStrongestDefaultEffort(info(undefined, ['low', 'high']))
    expect(out.reasoning.defaultEffort).toBe('high')
  })

  it('⚠️ 已经是最高档 ⇒ **返回同一对象**（下游按身份比较）', () => {
    const input = info('max', ['low', 'high', 'max'])
    expect(withStrongestDefaultEffort(input)).toBe(input)
  })

  it('⚠️ 没有可提的档 ⇒ 返回同一对象', () => {
    const onlyOff = info('none', ['none'])
    expect(withStrongestDefaultEffort(onlyOff)).toBe(onlyOff)
    const noReasoning = { provider: 'p', id: 'm', name: 'M' }
    expect(withStrongestDefaultEffort(noReasoning)).toBe(noReasoning)
    const emptyEfforts = { provider: 'p', id: 'm', name: 'M', reasoning: { efforts: [] } }
    expect(withStrongestDefaultEffort(emptyEfforts)).toBe(emptyEfforts)
  })

  it('⚠️ 改写后的档位**必定**来自已声明集合（否则 DSH 抛 INVALID_MODEL_REASONING）', () => {
    for (const efforts of [
      ['low', 'high', 'max'],
      ['light', 'high', 'extra_high'],
      ['xhigh', 'high', 'low', 'max', 'medium'],
      ['off', 'on'],
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    ]) {
      const out = withStrongestDefaultEffort(info(undefined, efforts))
      expect(efforts).toContain(String(out.reasoning.defaultEffort))
    }
  })
})

// ───────────────────── ③ 漏斗行为级（两腿都要） ─────────────────────

/**
 * 忠实模拟真实适配器的形状（14 家同款）：
 * - `resolveModel` 在**原型**上（对象展开会丢，Proxy 才不会）；
 * - `prepareCall` 返回 `{ model, stream }`，且 `model` 是**另一份**元数据。
 */
class FakeAdapter {
  constructor(private readonly efforts: readonly string[], private readonly declared?: string) {}

  async resolveModel(provider: string, model: string): Promise<Record<string, unknown>> {
    return {
      provider,
      id: model,
      name: 'M',
      reasoning: {
        efforts: this.efforts.map((id) => ({ id, name: id })),
        ...(this.declared === undefined ? {} : { defaultEffort: this.declared }),
      },
    }
  }

  async prepareCall(provider: string, model: string): Promise<{
    model: Record<string, unknown>
    stream: (options: unknown) => AsyncIterable<unknown>
  }> {
    return {
      model: await this.resolveModel(provider, model),
      stream: () => (async function* () { /* 本用例不跑流 */ })(),
    }
  }

  async listModels(): Promise<readonly { id: string; name: string }[]> {
    return [{ id: 'm', name: 'M' }]
  }
}

/** 假 llm：记下注册进去的那个对象（`registerAdapterIdempotent` 的返回值是 dsh 的 handle）。 */
function fakeLlm(): { llm: { registerAdapter(providers: readonly string[], adapter: unknown): unknown }, registered(): unknown } {
  let captured: unknown
  return {
    llm: { registerAdapter: (_providers, adapter) => { captured = adapter; return adapter } },
    registered: () => captured,
  }
}

describe('★★ 注册漏斗：resolveModel 与 prepareCall 两条腿都必须生效', () => {
  it('★★ 经真实 registerAdapterIdempotent：两条腿的 defaultEffort 都是最强档', async () => {
    const { llm, registered } = fakeLlm()
    registerAdapterIdempotent(llm, ['p'], new FakeAdapter(['low', 'high', 'max'], 'high'), () => {})
    const adapter = registered() as {
      resolveModel(p: string, m: string): Promise<{ reasoning?: { defaultEffort?: unknown } }>
      prepareCall(p: string, m: string): Promise<{ model: { reasoning?: { defaultEffort?: unknown } } }>
    }
    expect(adapter, 'registerAdapterIdempotent 必须真的注册了对象').toBeDefined()

    const resolved = await adapter.resolveModel('p', 'm')
    expect(String(resolved.reasoning?.defaultEffort), '选择器读的是这一条').toBe('max')

    const call = await adapter.prepareCall('p', 'm')
    expect(String(call.model.reasoning?.defaultEffort), '⚠️ 生产请求读的是这一条 —— 漏了就是「显示 Max、实发 high」')
      .toBe('max')
  })

  it('⚠️ 该渠道声明无档位时，两条腿都原样透传（不编造 reasoning）', async () => {
    /** officeace / marvis 那类：`resolveModel` 从不返回 `reasoning`。 */
    class NoReasoningAdapter {
      async resolveModel(provider: string, model: string): Promise<Record<string, unknown>> {
        return { provider, id: model, name: 'M' }
      }
      async prepareCall(provider: string, model: string): Promise<Record<string, unknown>> {
        return { model: await this.resolveModel(provider, model), stream: () => (async function* () {})() }
      }
    }
    const { llm, registered } = fakeLlm()
    registerAdapterIdempotent(llm, ['officeace'], new NoReasoningAdapter(), () => {})
    const adapter = registered() as {
      resolveModel(p: string, m: string): Promise<Record<string, unknown>>
      prepareCall(p: string, m: string): Promise<{ model: Record<string, unknown> }>
    }
    expect(await adapter.resolveModel('officeace', 'm')).not.toHaveProperty('reasoning')
    const call = await adapter.prepareCall('officeace', 'm')
    expect(call.model).not.toHaveProperty('reasoning')
  })

  it('⚠️ 包装保留原型方法与 `this`（私有字段可见）', async () => {
    // ⚠️⚠️ 这条用例 2026-11-13 审计 D2 前是**假绿**：`listModels` 返回字面量（不读
    // `#secret`）、`resolveModel` 走的是**被拦截腿**（`.apply(target)`，`this` 本来就对）
    // ⇒ 把 Proxy 的透传分支改回 `Reflect.get(obj, prop, receiver)`（`this` = Proxy）
    // 依然全绿。现在 `listModels` 与 getter 都**真的读** `#secret`，变异才会变红。
    class PrivateAdapter {
      readonly #secret = 's3cr3t'
      async resolveModel(provider: string, model: string): Promise<Record<string, unknown>> {
        return { provider, id: model, name: this.#secret }
      }
      /** 透传分支（非拦截方法）：必须能读到 `#secret`，否则 `this` 被绑到了 Proxy。 */
      async listModels(): Promise<readonly { id: string; name: string }[]> {
        return [{ id: 'm', name: this.#secret }]
      }
      /** 透传分支（访问器）：`Reflect.get(obj, prop, proxy)` 会把 getter 的 `this` 变成 Proxy。 */
      get peek(): string {
        return this.#secret
      }
    }
    const wrapped = withStrongestReasoningDefault(['p'], new PrivateAdapter()) as unknown as {
      resolveModel(p: string, m: string): Promise<Record<string, unknown>>
      listModels(): Promise<readonly { id: string; name: string }[]>
      peek: string
    }
    // 展开成普通对象会让原型方法全部消失（`listModels is not a function`）。
    expect(await wrapped.listModels(), '非拦截方法必须能以原适配器为 this 调用').toEqual([
      { id: 'm', name: 's3cr3t' },
    ])
    expect(wrapped.peek, 'getter 必须能以原适配器为 this 求值').toBe('s3cr3t')
    expect((await wrapped.resolveModel('p', 'm')).name).toBe('s3cr3t')
    // 身份稳定：同一个 prop 反复取到同一个绑定后的函数（下游会按函数身份缓存）。
    expect(wrapped.listModels).toBe(wrapped.listModels)
  })
})

// ───────────────────── ⑤ 日志：只在首次提升时打一条 ─────────────────────

describe('日志去重：每步 prepareCall 不得刷屏', () => {
  it('⚠️ 同一模型第二次起不再打日志（否则每轮每一步一条）', async () => {
    const calls: string[] = []
    const original = console.info
    console.info = (...args: unknown[]) => { calls.push(args.join(' ')) }
    try {
      const wrapped = withStrongestReasoningDefault(['p'], new FakeAdapter(['low', 'high', 'max'], 'high')) as unknown as {
        prepareCall(p: string, m: string): Promise<unknown>
      }
      // 模拟同一模型的三个连续步骤（真实对话就是这样）。
      await wrapped.prepareCall('p', 'm')
      await wrapped.prepareCall('p', 'm')
      await wrapped.prepareCall('p', 'm')
    } finally {
      console.info = original
    }
    expect(calls.filter((line) => line.includes('思考档位默认取最强')).length, '应只有首次一条').toBe(1)
  })

  it('★ 档位跃迁变化后必须**再打一条**（去重键带 before → next，P3-①）', async () => {
    // ⚠️ 远端驱动渠道（trae / lobsterai / accio / qiniu）的 `efforts` 会随目录变化：
    //    冷缓存为空 → 目录回来 → 远端把 max 撤成 high。若去重键只到 `provider/model`，
    //    首次提升后**永久静默**，排障时看起来「一直没变」。
    const calls: string[] = []
    const original = console.info
    console.info = (...args: unknown[]) => { calls.push(args.join(' ')) }
    try {
      let efforts = ['low', 'high', 'max']
      // 上游声明的默认档（= 改动前的行为），本层把它抬到该模型的最强档。
      const adapter = {
        async resolveModel(): Promise<unknown> {
          return {
            id: 'm',
            reasoning: { efforts: efforts.map((id) => ({ id, name: id })), defaultEffort: 'high' },
          }
        },
      }
      const wrapped = withStrongestReasoningDefault(['p'], adapter) as unknown as {
        resolveModel(p: string, m: string): Promise<unknown>
      }
      await wrapped.resolveModel('p', 'm') // high → max（第一条）
      await wrapped.resolveModel('p', 'm') // 同一次跃迁 ⇒ 去重
      efforts = ['low', 'high', 'xhigh'] // 远端把 max 撤成 xhigh
      await wrapped.resolveModel('p', 'm') // high → xhigh（第二条，**必须**出现）
      await wrapped.resolveModel('p', 'm') // 去重
    } finally {
      console.info = original
    }
    const lines = calls.filter((line) => line.includes('思考档位默认取最强'))
    expect(lines.length, '两次不同的档位跃迁必须各打一条').toBe(2)
    expect(lines[0]).toContain('high → max')
    expect(lines[1]).toContain('high → xhigh')
  })
})

// ───────────────────── ⑥ 开关：关掉 = 逐字节回到改动前 ─────────────────────

/**
 * 这一组守的是用户的**回退承诺**：「关掉后就是原来的默认效果」。
 *
 * ⚠️ 判据必须是 `toBe`（同一引用）而不是 `toEqual`：仓库下游有按**引用**比较
 * 的路径（`deepFreeze` / `catalog` 缓存按数组身份失效），浅拷贝虽然内容相同，
 * 但会让「关掉后什么都没发生」这条承诺不再逐字节成立。
 */
describe('★ 开关：关掉后必须完全回到改动前的行为', () => {
  it('★★ 关掉后 resolveModel 的元数据**原样返回**（同一引用）', () => {
    configureStrongestReasoningEnabled(() => false)
    const input = info('high', ['low', 'high', 'max'])
    expect(withStrongestDefaultEffort(input)).toBe(input)
    expect(input.reasoning.defaultEffort).toBe('high')
  })

  it('★★ 关掉后两条腿经真实注册漏斗都不改写', async () => {
    configureStrongestReasoningEnabled(() => false)
    const { llm, registered } = fakeLlm()
    registerAdapterIdempotent(llm, ['p'], new FakeAdapter(['low', 'high', 'max'], 'high'), () => {})
    const adapter = registered() as {
      resolveModel(p: string, m: string): Promise<{ reasoning?: { defaultEffort?: unknown } }>
      prepareCall(p: string, m: string): Promise<{ model: { reasoning?: { defaultEffort?: unknown } } }>
    }
    expect(String((await adapter.resolveModel('p', 'm')).reasoning?.defaultEffort), '关掉后选择器应显示 high')
      .toBe('high')
    const call = await adapter.prepareCall('p', 'm')
    expect(String(call.model.reasoning?.defaultEffort), '关掉后实发也应是 high').toBe('high')
  })

  it('★ 关掉后标题请求**不降档**（调用方给什么就是什么）', () => {
    configureStrongestReasoningEnabled(() => false)
    expect(titleEffortWhenStrongest(['light', 'high', 'extra_high'])).toBeUndefined()
  })

  it('⚠️ 打开时标题请求才降档（两者同开同关）', () => {
    configureStrongestReasoningEnabled(() => true)
    expect(titleEffortWhenStrongest(['light', 'high', 'extra_high'])).toBe('light')
  })

  it('⚠️ 开关回调是**每次现调**的：中途切换立刻生效（不需要重启）', async () => {
    // 「现调」指的是 `configureStrongestReasoningEnabled` 传进来的**回调**每次调用都重新
    // 求值（本用例用一个闭包变量模拟）。文件层另有一份进程内缓存（`parsedCache`），
    // 但 `save()` 落盘成功后会同 tick 刷新它 ⇒ 用户在设置里拨开关仍然立刻生效。
    let on = true
    configureStrongestReasoningEnabled(() => on)
    const { llm, registered } = fakeLlm()
    registerAdapterIdempotent(llm, ['p'], new FakeAdapter(['low', 'high', 'max'], 'high'), () => {})
    const adapter = registered() as {
      resolveModel(p: string, m: string): Promise<{ reasoning?: { defaultEffort?: unknown } }>
    }
    expect(String((await adapter.resolveModel('p', 'm')).reasoning?.defaultEffort)).toBe('max')
    on = false
    expect(String((await adapter.resolveModel('p', 'm')).reasoning?.defaultEffort), '关掉后立刻回到 high')
      .toBe('high')
    on = true
    expect(String((await adapter.resolveModel('p', 'm')).reasoning?.defaultEffort), '再打开立刻回到 max')
      .toBe('max')
  })

  it('⚠️ 开关回调**抛错**时按开启处理（不让功能无声消失）', () => {
    configureStrongestReasoningEnabled(() => { throw new Error('读盘失败') })
    expect(strongestReasoningEnabled()).toBe(true)
    const out = withStrongestDefaultEffort(info('high', ['low', 'high', 'max']))
    expect(String(out.reasoning.defaultEffort)).toBe('max')
  })

  it('⚠️ 未接线（缺省）时为开启', () => {
    configureStrongestReasoningEnabled(undefined)
    expect(strongestReasoningEnabled()).toBe(true)
  })
})

// ───────────────────── ④ 「哪些渠道没有档位」的行为守卫 ─────────────────────

/**
 * ⚠️ **双向**守卫（缺任一个方向都会让面板灰字变成假话）：
 * - 名单内的渠道必须真的一个档位都没有；
 * - 名单外的每个已注册渠道必须**至少一家有档位**。
 *
 * 这里走的是**真实适配器**（不经漏斗），故断言的是「模型默认」语义 ——
 * 灰字讲的是「这个渠道提不提供档位选择器」，与默认值多强无关。
 */
describe('⚠️ PROVIDERS_WITHOUT_REASONING 与实际声明对拍', () => {
  it('名单与已注册渠道全集自洽（不重复、不含虚拟 provider）', () => {
    const channels = registeredChannelIds()
    for (const id of PROVIDERS_WITHOUT_REASONING) {
      expect(channels, `${id} 不在 PROVIDER_REGISTRY 里（名单写错或渠道已改名）`).toContain(id)
    }
    expect(new Set(PROVIDERS_WITHOUT_REASONING).size, '名单有重复项').toBe(PROVIDERS_WITHOUT_REASONING.length)
    for (const virtual of ['aggregate', 'jet-hub-auto', 'auto']) {
      expect(PROVIDERS_WITHOUT_REASONING, `${virtual} 是虚拟 provider，不该进名单`).not.toContain(virtual)
    }
  })

  it('providerWithoutReasoning 只认名单（其余一律 false）', () => {
    for (const id of PROVIDERS_WITHOUT_REASONING) expect(providerWithoutReasoning(id)).toBe(true)
    for (const id of ['trae', 'buddy', 'zcode', 'aggregate', '', 'unknown-provider']) {
      expect(providerWithoutReasoning(id)).toBe(false)
    }
  })
})

/**
 * ★ 真实声明对拍（2026-11-13 正向审计 D4）。
 *
 * 本功能「推翻四处既有决策」—— 但那四家的 `defaultEffort` 常量**逐字节未动**
 * （`git diff --name-only` 里没有它们），只是注册后被本层覆盖。既有的 156 处
 * `defaultEffort` 断言全部直接 `new XxxAdapter(...)`、**绕过注册漏斗**，所以
 * 一条都不会红 —— 也就是说「覆盖后的实际生效值」此前**零测试**。
 *
 * 这四条用**真实的产品常量**（都不带副作用，纯数据）把实际生效值锁死：
 * 以后谁改了某家的档位清单、或把 `EFFORT_CAP` 挪走，这里会立刻红。
 */
describe('★ 真实适配器声明对拍：覆盖后的实际生效档位', () => {
  it('cline：声明到 max（UI 名 Extra）⇒ 落 max，且不是 high', () => {
    const declared = CLINE_REASONING_EFFORTS.map((effort) => effort.id)
    // 前提自证：Cline 的档位清单里确实有 max、且 high 不是最强
    expect(declared).toContain('max')
    expect(declared).toContain('none')
    expect(strongestDeclaredEffort(declared)).toBe('max')
    // 覆盖的是「默认档」这一格，档位清单本身不动
    const info = { reasoning: { efforts: CLINE_REASONING_EFFORTS.map((effort) => ({ ...effort })) } }
    expect(withStrongestDefaultEffort(info).reasoning?.defaultEffort).toBe('max')
    // 反向钉子：清单本身逐条未动（本层只加 defaultEffort）
    expect(withStrongestDefaultEffort(info).reasoning?.efforts).toEqual(CLINE_REASONING_EFFORTS)
  })

  it('aggregate：8 个规范档里有 ultra，但**封顶 max**（本仓没有任何渠道真发 ultra）', () => {
    // 前提自证：规范档里 ultra 的 rank 确实高于 max
    expect(reasoningRankOf('ultra')).toBeGreaterThan(reasoningRankOf('max') as number)
    expect(CANONICAL_REASONING_EFFORTS).toContain('ultra')
    expect(strongestDeclaredEffort([...CANONICAL_REASONING_EFFORTS])).toBe('max')
  })

  it('aggregate 的兜底：只声明了 ultra 时退回 ultra（不能返回 undefined 把档位丢掉）', () => {
    expect(strongestDeclaredEffort(['ultra'])).toBe('ultra')
  })

  it('loomy：远端只有 xhigh 上限 ⇒ 落 xhigh，不编造 max', () => {
    expect(LOOMY_EFFORTS).not.toContain('max')
    expect(strongestDeclaredEffort([...LOOMY_EFFORTS])).toBe('xhigh')
  })

  it('trae：上游 default_level 采信的是 high / extra_high ⇒ 覆盖成声明里最强的那档', () => {
    // 取 trae 真实远端形状的代表：有 extra_high 没有 max
    const declared = ['minimal', 'low', 'medium', 'high', 'extra_high']
    expect(reasoningRankOf('extra_high')).toBeGreaterThan(reasoningRankOf('high') as number)
    expect(strongestDeclaredEffort(declared)).toBe('extra_high')
  })

  it('⚠️ 封顶只有一处在守太脆：显式钉住「max 与 ultra 同时声明 ⇒ 取 max」', () => {
    // 不依赖任何 adapter 的档位表（aggregate 那条靠它的 8 档里同时含 max 与 ultra；
    // 一旦那张表去掉 ultra，那条守卫会**无声失效**）。
    expect(CANONICAL_REASONING_EFFORTS).toContain('max')
    expect(strongestDeclaredEffort(['max', 'ultra'])).toBe('max')
    // 反向对照：只有 ultra 时才必须退到 ultra（否则「档位被丢掉」）
    expect(strongestDeclaredEffort(['ultra'])).toBe('ultra')
  })
})

/**
 * ★ 形状防御（2026-11-13 对抗审计 P1-②）。
 *
 * 本层对**全部 20 家适配器**无差别施加，而它在调用链上的位置**没有任何
 * try/catch**（`llm-register-compat.ts` 那处只包「包装」、不包「每请求调用」）
 * ⇒ 一旦某家（或被远端目录驱动后）产出违约形状，该渠道**每个请求**都抛
 * `TypeError`，整条渠道不可用（不是降级）。
 *
 * 五个形状是审计探针实测会抛的：`reasoning: null` / `[]` / `'max'` /
 * `{defaultEffort:'max'}` / `{efforts:'max'}` / `efforts:[null]`。
 * 判据：**一律原样返回入参（同一引用）、绝不抛**。
 */
describe('⚠️ 形状防御：违约元数据必须原样透传，绝不抛', () => {
  const hostile: readonly [string, unknown][] = [
    ['reasoning: null', { reasoning: null }],
    ['reasoning: []（数组）', { reasoning: [] }],
    ["reasoning: 'max'（字符串）", { reasoning: 'max' }],
    ['reasoning: {}（无 efforts）', { reasoning: {} }],
    ["reasoning: { efforts: 'max' }（不是数组）", { reasoning: { efforts: 'max' } }],
    ['reasoning: { efforts: [] }（空数组）', { reasoning: { efforts: [] } }],
    ['reasoning: { efforts: [null] }（元素不是对象）', { reasoning: { efforts: [null] } }],
  ]

  it.each(hostile)('★ %s ⇒ 原样返回同一对象', (_label, info) => {
    // 断言用 toBe（同一引用），既能抓「抛错」也能抓「偷偷换了新对象」
    expect(withStrongestDefaultEffort(info as { reasoning?: DeclaredReasoning })).toBe(info)
  })

  it('★ 两个档位选择器对 undefined / null / 非数组都返回 undefined（不抛）', () => {
    for (const bad of [undefined, null, 100, 'max', {}]) {
      expect(strongestDeclaredEffort(bad as unknown as readonly string[])).toBeUndefined()
      expect(weakestThinkingEffort(bad as unknown as readonly string[])).toBeUndefined()
    }
    // 反向对照：合法输入必须照常工作（否则上面的守卫会把功能整体关掉）
    expect(strongestDeclaredEffort(['low', 'max'])).toBe('max')
    expect(weakestThinkingEffort(['low', 'max'])).toBe('low')
  })

  it('⚠️ 半合法输入（含 null 元素但有真档位）⇒ 过滤脏元素后**照常**提起档位', () => {
    // 这条不是「原样透传」：`efforts` 里有真档位 ⇒ 功能必须生效，
    // 只是不能让 `null` 元素把它打崩（实测未守卫时抛 `reading 'id'`）。
    const info = { reasoning: { efforts: [null as unknown as { id: string }, { id: 'max' }] } }
    expect(withStrongestDefaultEffort(info).reasoning?.defaultEffort).toBe('max')
  })
})
