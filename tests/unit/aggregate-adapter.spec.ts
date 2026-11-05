import { describe, expect, it } from 'vitest'
import {
  AggregateAdapter,
  AGGREGATE_CAPABILITY_FAILURE_TTL_MS,
  AGGREGATE_CAPABILITY_TIMEOUT_MS,
  AGGREGATE_CATALOG_TTL_MS,
  AGGREGATE_COLD_CONTEXT_WINDOW,
  AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS,
  AGGREGATE_FALLBACK_CONTEXT_WINDOW,
  AGGREGATE_PROVIDER,
  maxAttemptsFor,
  registerAggregateLlm,
} from '../../src/aggregate-adapter.js'

/**
 * 把一次异步调用**限定在预算内**跑完：超时返回 `'TIMEOUT'`（而不是 reject）。
 *
 * ⚠️ 返回哨兵字符串而不是抛错，是为了让断言能写出「期望**不是** TIMEOUT」这句
 * 可读的话（如果直接 reject，Vitest 会先打印超时错误、判别信息被淹没）。
 * ⚠️ 定时器必须清掉：不清会让测试进程多挂几百毫秒（本文件有 20+ 处这种用法）。
 */
async function raceIn<T>(ms: number, work: () => Promise<T>): Promise<T | 'TIMEOUT'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<'TIMEOUT'>((resolve) => {
        timer = setTimeout(() => { resolve('TIMEOUT') }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 造一个最小 ctx：llm.listModels 播报给定目录。 */
function makeCtx(catalogs: Record<string, Array<{ id: string; name?: string }>>) {
  return {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      // ⚠️ `refreshCatalog` 先问 `listProviders()` 拿渠道全集，再逐个 listModels
      //    ⇒ 这个桩**必须**存在，且要返回目录里出现过的渠道（否则推导结果为空）。
      listProviders: () => Object.keys(catalogs).map((id) => ({ id, name: id })),
      listModels: async (provider: string) => catalogs[provider] ?? [],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: () => { throw new Error('本用例不应调用 stream') },
    },
  } as never
}

/** 造一个最小账号池：所有渠道都有账号、永久积分（NEVER）。 */
function makePool() {
  return {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never
}
/**
 * ★★ 聚合渠道的**显式豁免集**：registry 里 `channel: true` 但**有意不进**
 *    `AGGREGATE_CHANNELS` 的 provider。
 *
 * 「有意不接入」与「漏接」是两回事 —— 前者必须登记**可核实的理由**，并由下面的
 * 豁免用例逐条**验证**（范式对齐 `tests/helpers/provider-sets.ts` 的 `AUTH_EXEMPT`：
 * 豁免只能显式列出，不能靠「没登记就算豁免」推定）。
 *
 * ## 可测量判据（三条都被下面的豁免验证用例钉住，不是一条口头承诺）
 *
 * ① 豁免项必须是 `PROVIDER_REGISTRY` 里真实存在的 id（防拼写错误造成的僵尸豁免）；
 * ② 它必须确实 `channel: true` —— `channel: false` 的家本来就不进聚合，豁免它
 *    对这条守卫毫无贡献（那是 `aggregate` 自己的排除方式，不是豁免）；
 * ③ 行为验证：把 registry 的**全部** channel 都摆成存活路由时，聚合实际拉取的
 *    那圈里**不得**出现任何豁免项。
 *
 * ⚠️ ③ 就是「僵尸豁免」探测器：**将来把某家加进 `AGGREGATE_CHANNELS` 而忘了清空
 *    本集合 ⇒ 该豁免项变成僵尸 ⇒ 豁免用例立刻变红并点名**，迫使改动者做显式决定，
 *    而不是让豁免名单越堆越长（那正是本文件要消灭的静默失效形态）。
 *
 * ## 当前豁免项
 *
 * **（空集）** —— 2026-10-20 起没有任何豁免项。
 *
 * ### 历史：`astudio` 曾在此登记，现已接入
 *
 * 2026-10-16 曾定案「`astudio` 有意不进聚合」，理由两条：①模型目录来自上游动态
 * catalog、额度/失效语义（HTTP 200 + 业务 `code=80000` 归「需人工重新登录」终态）
 * 与聚合渠道不同；②生产侧已实证「只进 `AGGREGATE_CHANNELS` 而不补
 * `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`」是**无效接线**（候选表那道
 * 闸门会把它剔掉，症状静默、无报错无日志）。
 *
 * **2026-10-20 改判**（用户报障 AStudio 积分有到期时间却不区分永久/长期/临期）：
 * - 理由 ① 被实测推翻 —— `/points/balance` 的 member / buy / activity 三池各带
 *   `*NextExpireTime`（不带时区的本地时间串），与 buddy 系**同形**，已由
 *   `src/astudio-credits.ts` 的 `astudioLocalTimeMs` 归一化到 `deductionEndTime`；
 *   `code=80000` 只影响**额度读数失败文案的分流**，与临期折算无关。
 * - 理由 ② 描述的是**当时的实现状态**（两处都没补），不是设计约束。
 * - 用户报障正是这条「有意不接入」的直接后果：面板不显示三档，
 *   聚合候选里也永远看不到它。
 * ⇒ 三处**同时**补齐：`AGGREGATE_CHANNELS` + `WIRED_EXPIRY_PROVIDERS` +
 *   `createProviderExpiry()`，并把本豁免集清空。
 */
const AGGREGATE_EXEMPT_PROVIDER_IDS: ReadonlySet<string> = new Set()

/**
 * 把目录预热到「已折算」状态，**之后**再断言 `listModels` 的过滤/命名行为。
 *
 * ## ⚠️ 为什么本文件里多数 `listModels` 用例都必须先调它（2026-10-18）
 *
 * Task 7 改了 `listModels` 的口径：**缓存不新鲜时不再同步等上游**，而是先返回
 * **已知**目录（冷启动时可能就是空的）、把折算转后台（见 `catalogForListModels`
 * 的长注释，实测 `provider=aggregate` 因逐渠道读远端目录而花了 7028ms）。
 *
 * ⇒ 「首次冷调 `listModels` 只该看到 `auto`」现在是**正确**行为（有专门用例钉住），
 *    因此本文件的其余用例（它们测的是**过滤 / 命名 / 白名单**，不是加载时机）
 *    必须先让目录落地，否则测的就是「空目录上的过滤」—— 那种用例会**恒绿**，
 *    属本仓库明令禁止的假用例形态。
 *
 * ⚠️ 用公开的 `refreshCatalog()`（它正是「折算 + 落目录」的既有唯一入口），
 *    不要改私有字段。
 */
async function warmCatalog(adapter: AggregateAdapter): Promise<void> {
  await adapter.refreshCatalog()
}

/**
 * ★★ 聚合层的渠道白名单必须覆盖 registry 里 `channel: true` 的**全部**渠道，
 *    除 {@link AGGREGATE_EXEMPT_PROVIDER_IDS} 里**显式登记、且理由被逐条验证**
 *    的家（「有意不接入」必须留下可核实的理由，不许靠假设）。
 *
 * ## ⚠️ 为什么要有这一条（真实缺口，2026-10-12 对抗性审计实测）
 *
 * `src/aggregate-adapter.ts` 的 `AGGREGATE_CHANNELS` 是**手写字面量**，而它自己的
 * 注释声称「新增 provider 时**两处都要加**（与 `modelAdapters` 同一约定）」——
 * **该声称当时不成立**：`modelAdapters` 有两条守卫（源码文本抓多余键 + 行为抓漏键），
 * 这里**一条都没有**。实测：从数组里删掉 `'gemini'` 后全量测试**依然全绿**。
 *
 * 线上后果（静默）：该渠道的模型**永不进聚合目录** ⇒ 用户看不到它的虚拟模型、
 * `auto` 也不会用到它，**无报错、无日志** —— 与「手抄 13 行续期清单、漏一家
 * 日志零字」是同一形态。
 *
 * ## 判据为什么是**行为**而不是读那个私有常量
 *
 * `AGGREGATE_CHANNELS` 是 `private static readonly`，测试拿不到。但它经
 * `providerIds()` 决定「向哪些渠道拉目录」⇒ 用 `listModels` 的**调用记录**反推，
 * 比文本断言强：文本只能证明字面量在，行为能证明它**真的被用上**。
 *
 * ⚠️ 判据是**集合**（无序）而不是有序相等：实测 registry 的尾部顺序是
 * `… zcode, opencode, gemini`，而白名单是 `… gemini, zcode, opencode` —— 两者
 * **本来就不同序**，故「有序相等」会恒假失败。白名单那边的顺序另有语义
 *（见该常量注释），本用例**只管集合**。
 */
describe('★★ 聚合渠道白名单与 registry 对齐（漏一家即红并点名）', () => {
  it('每个 channel 渠道都参与聚合（除显式豁免集；走真实 listModels 调用记录）', async () => {
    const { PROVIDER_REGISTRY } = await import('../../src/provider-registry.js')
    // ⚠️ 期望集 = registry 的全部 channel **减去**显式豁免集（判据仍是 registry 权威，
    //    豁免项本身由下面的「豁免理由被验证」用例逐条钉住，不是假设）。
    const expected = PROVIDER_REGISTRY
      .filter((d) => d.channel && !AGGREGATE_EXEMPT_PROVIDER_IDS.has(d.id))
      .map((d) => d.id)
      .sort()

    const seen: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        // 让「存活路由」= 期望集（全部 channel 减豁免）⇒ providerIds() 的交集
        // 就等于 AGGREGATE_CHANNELS 自身（豁免项本来就不在其中），于是调用记录
        // 直接暴露该白名单。
        listProviders: () => expected.map((id) => ({ id, name: id })),
        listModels: async (provider: string) => {
          seen.push(provider)
          return [{ id: 'm1', name: 'M1' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never

    const adapter = new AggregateAdapter(ctx, { accountPool: makePool() })
    // ⚠️ Task 7 之后 `listModels` 冷调**不再同步扇出**（见 `catalogForListModels`）⇒
    //    这条用例要看「哪些渠道真的被读过」，必须先让那一轮读取落地。
    await warmCatalog(adapter)
    await adapter.listModels(AGGREGATE_PROVIDER)

    expect(
      [...new Set(seen)].sort(),
      'AGGREGATE_CHANNELS 与 registry 漂移：左侧多出 = 白名单里有僵尸项；'
      + '右侧多出 = registry 里有渠道没进聚合（它的模型永不可见，且**静默**）',
    ).toEqual(expected)
  })
  it('★ 豁免项的豁免**理由**被验证（不是被假设）：channel:true 但确实不在聚合里', async () => {
    const { PROVIDER_REGISTRY, descriptorOf } = await import('../../src/provider-registry.js')
    const allChannels = PROVIDER_REGISTRY.filter((d) => d.channel).map((d) => d.id)
    // 判据 ① + ②：豁免项必须真实存在，且确实是 channel:true。
    for (const id of AGGREGATE_EXEMPT_PROVIDER_IDS) {
      const descriptor = descriptorOf(id)
      expect(descriptor, `豁免集里的 ${id} 不在 PROVIDER_REGISTRY 里（僵尸豁免项）`).toBeDefined()
      expect(
        descriptor?.channel,
        `豁免集里的 ${id} 并不是 channel:true ⇒ 「不接入聚合」不需要豁免，本条登记无理由`,
      ).toBe(true)
    }
    // 判据 ③：**行为**验证（和上面那条同一手法，但路由集摆成**全部** channel，
    //    于是「白名单里悄悄多了豁免项」这一侧会被看见 —— 上面那条把它从期望集
    //    里减掉了，看不见这个方向）。
    const seen: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => allChannels.map((id) => ({ id, name: id })),
        listModels: async (provider: string) => {
          seen.push(provider)
          return [{ id: 'm1', name: 'M1' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool() })
    // ⚠️⚠️ **必须先热身**（2026-10-18 对抗审计实测的恒真缺陷）：
    //    Task 7（`a80ab4a`「目录加载不同步等上游」）之后 `listModels` 冷调
    //    **不再同步扇出**（只返回已知目录、把折算转后台）⇒ 不热身时 `seen` 只有
    //    极少几家（实测 `["codearts","buddy","workbuddy"]`），下面的
    //    `seenSet.has(id)` 于是**恒为 false**、与白名单内容无关。
    //    实测证据：把 `'astudio'` 塞进 `AGGREGATE_CHANNELS` 后，本文件
    //    **132 passed / 0 failed**（本用例自称的「僵尸豁免探测器」完全无牙）。
    //    ⚠️ 同文件其余用例都已调 `warmCatalog`，本段是唯一漏掉的一处。
    await warmCatalog(adapter)
    await adapter.listModels(AGGREGATE_PROVIDER)
    const seenSet = new Set(seen)
    for (const id of AGGREGATE_EXEMPT_PROVIDER_IDS) {
      expect(
        seenSet.has(id),
        `${id} 登记为「有意不进聚合」的豁免项，却出现在聚合拉取的渠道里 ⇒ 白名单已` +
        `接入它、豁免集忘了清空（僵尸豁免项）。接入聚合时请同步补 ` +
        `src/aggregate-expiry.ts 的 WIRED_EXPIRY_PROVIDERS 并清空本豁免集`,
      ).toBe(false)
    }
    // 反向防恒真：豁免集必须是 channel 全集的**真子集**。
    //
    // ⚠️ 2026-10-20 起**空集是合法状态**（astudio 接入后全部 channel 都在聚合里），
    //    故不再要求 `size > 0` —— 那条断言在「所有渠道都接入」时是**错误约束**，
    //    会逼着人往豁免集里塞一个不该豁免的项来凑数。
    //    真正防恒真的是下面这条：豁免集不得等于 channel 全集。
    //    （若它等于全集，上面 ③ 的循环会遍历全部 channel 并对每家都断言
    //     「不在聚合拉取列表里」，而聚合实际上拉了全部 ⇒ 必然红。故哪怕空集时
    //     ③ 退化为「不遍历」，`AGC ∪ 豁免 == channel 全集` 这条等式守卫仍在守。）
    expect(
      AGGREGATE_EXEMPT_PROVIDER_IDS.size,
      '豁免集不应等于 channel 全集 —— 那会让上面两条一起变成恒真断言',
    ).toBeLessThan(allChannels.length)
  })
})

describe('AggregateAdapter：目录播报', () => {
  it('providerInfo 的 id 必须等于注册路由（DSH 校验）', () => {
    const adapter = new AggregateAdapter(makeCtx({}), { accountPool: makePool() })
    expect(adapter.providerInfo(AGGREGATE_PROVIDER).id).toBe(AGGREGATE_PROVIDER)
  })

  /**
   * ⚠️⚠️ **`refreshCatalog` 的补写黑名单必须 `await`**（2026-11-05 合规审计：
   * 代码对、零守卫 —— 退回 `void` 后 489 条全绿）。
   *
   * 「读黑名单 → 算 missing → 写黑名单」这三步若**不 await**，就与用户操作
   * **交错**：用户在补写落地前打开某个聚合模型，会被这次补写**重新关掉**
   * （窗口秒级，且无任何提示）。用户报障的正是「开关状态自己变」。
   *
   * ⇒ 判据必须是**行为级**：让写方法**挂起**，断言 `refreshCatalog()` 在补写
   * 落地**之前**不得返回；释放闸门后它才返回。
   *
   * - 不 await（fire-and-forget）：`refreshCatalog` **立刻返回**（补写还在挂起）
   *   ⇒ 用户在这段时间里的操作会与补写**交错**；
   * - await（正确）：`refreshCatalog` **等补写完成**才返回 ⇒ 用户拿到的目录状态
   *   已经包含补写结果。
   *
   * ⚠️ 判据落在「**返回时机**」而不是「有没有调过 write」——后者两条路径都调用
   * 了它；也不是「最终黑名单状态」——那条要构造「用户恰好在窗口里打开某个
   * 模型」的场景，而写方法只**新增**黑名单项、不会覆盖用户的打开动作 ⇒
   * 那条判据在两条路径下都绿（**恒真**）。
   */
  it('★★ ★★ 补写黑名单必须 await（否则会把用户刚打开的模型重新关掉）', async () => {
    /**
     * 黑名单状态（可被用户操作改写）。
     *
     * ⚠️ `auto` 与 `deepseek-v4-1-flash` 是**上一轮**全量目录的两条 ⇒ 判据
     * 「上一次全量目录是否全被标记为关闭」成立 ⇒ 第二轮新增的 `glm-5.3` 触发补写。
     */
    let disabled: Record<string, boolean> = {}
    /** 渠道目录（第二轮会长出一条新模型 ⇒ 触发补写）。 */
    const catalogs: Record<string, Array<{ id: string, name?: string }>> = {
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }
    /** 写方法的调用计数与「挂起闸门」。 */
    let writeCalls = 0
    let releaseWrite: (() => void) | undefined
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })

    const adapter = new AggregateAdapter(makeCtx(catalogs), {
      accountPool: {
        disabledModelsFor: () => new Set(Object.keys(disabled).filter((k) => disabled[k] === true)),
        listDisabledModels: () => ({ ...disabled }),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
        setModelsDisabled: async (_provider: string, ids: readonly string[]) => {
          writeCalls += 1
          // ⚠️ 第一次写挂起，模拟「补写与用户操作交错」的窗口。
          if (writeCalls === 1) await writeGate
          for (const id of ids) disabled[id] = true
        },
      } as never,
    })

    // ⚠️ 第 0 轮：把目录跑热（此刻黑名单为空 ⇒ 不触发补写）。
    await adapter.refreshCatalog(true)
    // ⇒ 用户关掉整个聚合供应商：黑名单覆盖**上一轮**的全量目录。
    disabled = { auto: true, 'deepseek-v4-1-flash': true }
    // ⇒ 目录长出一条新模型（`glm-5.3`）⇒ 第二轮触发补写。
    catalogs.buddy = [
      { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
    ]

    // 第二轮：目录变长 ⇒ 补写「整个 provider 已关闭」的黑名单。
    const first = adapter.refreshCatalog(true)
    // ⚠️ 让出微任务队列，确保补写已经开始（挂起在 writeGate 上）。
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(writeCalls, '前提失败：补写根本没发生').toBeGreaterThan(0)
    // ⚠️ **核心判据**：补写还挂着 ⇒ `refreshCatalog()` **不得**已经返回。
    let settled = false
    void first.then(() => { settled = true })
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(
      settled,
      '★ refreshCatalog 在补写黑名单落地之前就返回了（await 被退回成 fire-and-forget）'
      + ' ⇒ 用户在这段时间里的操作会与补写交错',
    ).toBe(false)
    // 释放写闸门，让补写落地；此后 refreshCatalog 才可返回。
    releaseWrite?.()
    await first
    expect(settled, '前提失败：补写完成后 refreshCatalog 仍未返回').toBe(true)
  })

  it('listModels 播报虚拟模型（含 auto），每条 provider 都是 aggregate', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.map((m) => m.id)).toEqual(['auto', 'deepseek-v4-1-flash'])
    for (const model of models) expect(model.provider).toBe(AGGREGATE_PROVIDER)
  })

  it('每条 id 不重复（DSH 会因重复抛 INVALID_CATALOG）', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'glm-5.3', name: 'GLM-5.3' }, { id: 'kimi-k3-1', name: 'Kimi-K3-1' }],
    }), { accountPool: makePool() })
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length)
  })

  /**
   * ★ 模型选择器里的虚拟模型名**必须带倍率**（用户报障 2026-10-08：「没倍率显示？」）。
   *
   * 根因：`nameOf` 只回规范名，而倍率其实早就算好了（`CandidateEntry.price`），
   * 只是从没被展示层用过 ⇒ 用户在聚合下看不到价格，无法判断「挑的是不是便宜的」。
   */
  it('★ 选择器名带倍率后缀（取最便宜的候选）', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.15' }],
    }), { accountPool: makePool() })
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    const entry = models.find((m) => m.id === 'deepseek-v4-1-flash')
    expect(entry!.name).toBe('DeepSeek V4.1 Flash · 最低 x0.15')
  })

  it('★ 多个候选时取**最便宜**的那个倍率（轮换的第二判据就是倍率升序）', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.29' }],
      codearts: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.03' }],
    }), { accountPool: makePool() })
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    const entry = models.find((m) => m.id === 'deepseek-v4-1-flash')
    // 最便宜的是 codearts 的 x0.03 —— 那才是最可能被路由到的那个价。
    expect(entry!.name).toBe('DeepSeek V4.1 Flash · 最低 x0.03')
  })

  it('★ 全部候选都无倍率标注 ⇒ 不加后缀（不得渲染出 xInfinity）', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    const entry = models.find((m) => m.id === 'deepseek-v4-1-flash')
    expect(entry!.name).toBe('DeepSeek V4.1 Flash')
    expect(entry!.name).not.toContain('Infinity')
  })

  it('★ 倍率为 0 显示「免费」（本仓库既有口径）', async () => {
    // ⚠️ 必须用一个**已接入临期折算**的渠道（buddy）：未接入的候选会被
    //    `pickerNameOf` 的价格过滤剔掉（见下一条用例），拿不到「免费」。
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · 免费' }],
    }), { accountPool: makePool() })
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    const entry = models.find((m) => m.id === 'deepseek-v4-1-flash')
    expect(entry!.name).toBe('DeepSeek V4.1 Flash · 最低 免费')
  })

  it('★★ 跨临期档：显示的倍率不得声称「本次就用这个价」（真实缺陷，复审实测）', async () => {
    // ⚠️ 这条是本组唯一覆盖**跨临期档**的用例，而缺陷恰恰只在跨档时出现
    //    （其余用例的候选都在同一档，故取全局最小 === 取该档最小，二者无差别
    //    ⇒ 对缺陷免疫，属覆盖缺口而非假用例）。
    //
    // 缺陷机制：`rankCandidates` 的第一判据是**临期升序**，倍率只在**同档内**才
    // 起作用。初版 `pickerNameOf` 取全局最小 price 并直接拼 `· x0.03`，于是：
    //   候选 buddy x0.29（临期最早）/ codearts x0.03（临期晚）
    //   ⇒ 选择器显示 x0.03，实际发往 buddy（x0.29）。
    // 用户据此以为「聚合会挑便宜的」，而实际挑的是最贵的 —— 与原报障的诉求相反。
    //
    // 修法是**如实表达下界**：`最低 x…` 只声称「该虚拟模型下最便宜的可路由候选」，
    // 不声称本次会用它。（无法按「临期最早那档」取真实价：`CandidateEntry` 不含
    // `expiry`，而本方法契约要求**同步**、不能在选择器渲染路径上打网络。）
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.29' }],
      codearts: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.03' }],
    }), { accountPool: makePool() })
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    const entry = models.find((m) => m.id === 'deepseek-v4-1-flash')
    expect(entry, '虚拟模型必须存在').toBeDefined()
    // ⛔ 修前这里是 `· x0.03`（读起来像「本次就用 0.03」，而实际可能发往 x0.29）。
    expect(entry!.name, '必须标明这是下界，不能声称本次就用它').toBe('DeepSeek V4.1 Flash · 最低 x0.03')
    expect(entry!.name, '「最低」二字不可省').toContain('最低')
  })

  it('★ 倍率只加在选择器路径上：resolveModel 仍是规范名（三处既有断言钉住）', async () => {    // ⚠️ `resolveModel` / `describeCatalog` 的名字被逐字钉住（本文件 :88、
    //    aggregate-rejections.spec.ts:251、aggregate-catalog.spec.ts:21），
    //    且 `describeCatalog` 的候选子列表**逐条**显示倍率 —— 模型名上再叠一次
    //    会出现「两个倍率」的重复展示。
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.15' }],
    }), { accountPool: makePool() })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(info.name).toBe('DeepSeek V4.1 Flash')
  })

  it('★ 未接入临期折算的候选不参与报价（它永远不会被路由到）', async () => {
    // ⚠️ `cline` 在 `AGGREGATE_CHANNELS` 里，但**不在** `WIRED_EXPIRY_PROVIDERS` 里
    //   （`expiryProbe` 对它返回 UNUSABLE ⇒ 永不路由）。把它的价格显示出来等于
    //    替一个用不上的候选报价（规格 §9.2.1：只广告可路由的东西）。
    //
    // ⚠️ 必须同时给一个**已接入**的候选（buddy），否则整条虚拟模型会被
    //    `refreshCatalog` 的模型层过滤掉（「至少有一个已接入候选」），
    //    用例就变成在测「模型不存在」而不是在测价格过滤 —— 那是一条**恒真**的假用例
    //   （第一版就是这么写错的：只用 cline，`entry` 直接是 undefined）。
    //
    // cline 报 x0.01（最便宜）：若过滤失效就会显示它。
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.15' }],
      cline: [{ id: 'cline-free/deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.01' }],
    }), { accountPool: makePool() })
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    const entry = models.find((m) => m.id === 'deepseek-v4-1-flash')
    // 前置断言：模型确实在（否则下面那条断言会因 undefined 而**假通过**的变体）。
    expect(entry, '虚拟模型必须存在（buddy 是已接入候选）').toBeDefined()
    expect(entry!.name).toBe('DeepSeek V4.1 Flash · 最低 x0.15')
  })

  it('被用户关闭的虚拟模型不播报（套 disabledModelsFor 黑名单）', async () => {
    const pool = {
      disabledModelsFor: () => new Set(['deepseek-v4-1-flash']),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: pool })
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.map((m) => m.id)).toEqual(['auto'])
  })

  it('listAllModels 不套黑名单（设置页要能看到被关的模型）', async () => {
    const disabled = new Set(['deepseek-v4-1-flash'])
    const pool = { disabledModelsFor: () => disabled, getAvailableAccount: async () => null } as never
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: pool })
    // ⚠️ 必须先热缓存：`listAllModels` 是**同步**方法，契约上只读上一次推导结果
    //（`ModelCatalogSource`；`model.list` 的真实调用序也是先 listModels 再 listAllModels）。
    // ⚠️ Task 7 之后 `listModels` 冷调不再同步扇出 ⇒ 用 `warmCatalog` 显式落地目录。
    await warmCatalog(adapter)
    const all = adapter.listAllModels()
    // 对照：同一个模型在 listModels 里被黑名单挡掉…
    const listed = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(listed.map((m) => m.id)).not.toContain('deepseek-v4-1-flash')
    // …但在全量目录里必须仍在（否则用户在设置页连开关都摸不着）。
    expect(all.map((m) => m.id)).toContain('deepseek-v4-1-flash')
  })
})

describe('AggregateAdapter：resolveModel 必须按入参回填', () => {
  it('返回的 provider/id 与请求逐字相符（否则 DSH 抛 INVALID_MODEL_INFO）', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(info.provider).toBe(AGGREGATE_PROVIDER)
    expect(info.id).toBe('deepseek-v4-1-flash')
    expect(info.name).toBe('DeepSeek V4.1 Flash')
  })

  it('auto 也能解析（不因多模型改造而丢失）', async () => {
    const adapter = new AggregateAdapter(makeCtx({}), { accountPool: makePool() })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'auto')
    expect(info.id).toBe('auto')
    expect(info.name.length).toBeGreaterThan(0)
  })

  it('未知规范 id 抛 INVALID_REQUEST 且文案里带可用 id 提示', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    // ⚠️ 必须先让目录落地：2026-10-18 起目录为空时 `resolveModel` **不等待**
    //    （立刻回保守元数据，见 `coldModelInfo`）⇒ 冷帧下**任何** id 都不会抛
    //    INVALID_REQUEST，本用例会因测的是「冷帧」而失去判别力。
    await warmCatalog(adapter)
    await expect(adapter.resolveModel(AGGREGATE_PROVIDER, 'no-such-model'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('inputModalities 恒含 image（整池诚实声明；真正能不能收图由分发保证）', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(info.inputModalities).toContain('image')
  })

  it('必须声明 reasoning 档位（否则客户端的档位选择器永不出现）', async () => {
    // ⚠️ 本仓库有同型真实缺陷记录（`opencode-adapter.ts:323`：「思考档位（issue
    // IKJJ0V 修复，此前完全没声明 ⇒ 选择器永不出现）」）。DSH 的判定是
    // `resolved.reasoning === undefined ? undefined : {…}` ⇒ **不声明**等于
    // 「这个模型没有档位可选」，选择器根本不渲染。
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    // ⚠️ 目录必须先落地：冷帧（`this.catalog` 为空）时刻意**不声明**档位
    //    （见 `coldModelInfo`：编一份档位等于替用户承诺可能不存在的档位）。
    await warmCatalog(adapter)
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(info.reasoning).toBeDefined()
    expect(info.reasoning!.efforts.length).toBeGreaterThan(0)
    // ⚠️ 锁**具体值**（不是只 `toBeDefined()`）：默认档定为 `high`，与各渠道自己的
    // `defaultReasoningEffort` 一致（buddy / trae / lobsterai 实测清一色是 `high`）。
    // 只断言「有默认值」的话，把它改成 `medium` / `max` 都不会变红 —— 而那两种改法
    // 各有真实后果（前者「聚合比直连想得少」，后者最费 token/积分，与本功能
    // 「省钱烧临期」的目标相反）。
    expect(String(info.reasoning!.defaultEffort)).toBe('high')
  })

  it('档位是**并集**（规范化名）而非候选集交集，且不含渠道私有档', async () => {
    // ⚠️ 各渠道档位命名空间几乎不相交（codearts 只有 on/off、buddy 是 low/high/max、
    // trae 是 light/extra_high）⇒ 取交集必为空 ⇒ 空选择器。故必须声明并集。
    const adapter = new AggregateAdapter(makeCtx({
      // 只给一个 codearts 候选（它的档位只有 on/off）—— 若实现成「交集」，
      // 这里就会得到 on/off 两个渠道私有档，而不是规范化并集。
      codearts: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }],
    }), { accountPool: makePool() })
    await warmCatalog(adapter)
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const ids = info.reasoning!.efforts.map((effort) => String(effort.id))
    // 规范化并集应含 medium / high 这类规范名，且**不含** on/off 这类渠道私有档。
    expect(ids).toContain('medium')
    expect(ids).toContain('high')
    expect(ids).not.toContain('on')
    expect(ids).not.toContain('off')
  })

  it('档位展示名必须是官方中文（客户端直接渲染 name、不本地化）', async () => {
    // ⚠️ 权威来源是 Qoder IDE 的 i18n 词条（`qoder-product.ts` 有逐字记录）。
    const adapter = new AggregateAdapter(makeCtx({
      codearts: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }],
    }), { accountPool: makePool() })
    await warmCatalog(adapter)
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const efforts = info.reasoning!.efforts
    const nameOf = (id: string): string | undefined =>
      efforts.find((effort) => String(effort.id) === id)?.name
    expect(nameOf('none')).toBe('关闭思考')
    expect(nameOf('minimal')).toBe('最小')
    expect(nameOf('low')).toBe('低')
    expect(nameOf('medium')).toBe('中')
    expect(nameOf('high')).toBe('高')
    expect(nameOf('xhigh')).toBe('极高')
    expect(nameOf('max')).toBe('最大')
  })

  it('`auto` 也声明档位（不能因走了特殊分支而漏掉）', async () => {
    // ⚠️ 必须给**至少一个渠道**：2026-10-18 起「目录为空 ⇒ `resolveModel` 立刻回
    //    保守元数据」（`coldModelInfo`，**刻意不声明档位** —— 编一份等于替用户承诺
    //    可能不存在的档位）。用空目录的 `makeCtx({})` 会让本用例测到冷帧那条分支，
    //    从而**测不到**它真正要守的「`auto` 走热路径时也声明档位」。
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }), { accountPool: makePool() })
    await warmCatalog(adapter)
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'auto')
    expect(info.reasoning).toBeDefined()
    expect(info.reasoning!.efforts.length).toBeGreaterThan(0)
  })
})

describe('registerAggregateLlm：注册后预热目录', () => {
  /**
   * ⚠️ 为什么这条必须存在（真实缺陷）：`listAllModels()` 被契约要求是**同步**的，
   * 只能读上一次推导结果；而 `provider.status`（`jet-hub-rpc.ts:3883`）会在
   * **冷缓存**下直接调它并据条数算 `models.total`，判据是
   * `closed = total > 0 && disabled === total`（同文件 `:3903`）。
   * 冷缓存时 `total` 只有 1（`auto`）⇒ 用户一关掉 `auto`，`disabled === total`
   * 成立 ⇒ `aggregate` 被**误显示为「已关闭」**。
   */
  it('注册即预热目录：不必先调 listModels，listAllModels 也已含虚拟模型', async () => {
    const ctx = makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }) as { llm: { registerAdapter?: unknown } }
    // `registerAdapterIdempotent` 需要它（本用例只关心预热，不做路由断言）。
    const registered: string[][] = []
    ctx.llm.registerAdapter = (providers: string[]) => { registered.push([...providers]) }

    const adapter = registerAggregateLlm(ctx as never, { accountPool: makePool() })
    expect(registered).toEqual([[AGGREGATE_PROVIDER]])

    // 预热是 fire-and-forget：刷一轮宏任务让它落地。
    await new Promise(resolve => setTimeout(resolve, 0))

    // 关键断言：**没有**手动调过 listModels，全量目录也必须已经非空。
    expect(adapter.listAllModels().map((m) => m.id)).toContain('deepseek-v4-1-flash')
  })
})

describe('maxAttemptsFor：不得写死，必须 ≥ 最长候选表', () => {
  it('取所有虚拟模型里最长的候选数', () => {
    const models = [
      { key: 'a', name: 'A', candidates: [{ provider: 'p1', realId: 'm', realName: 'm', price: 0, via: 'id' as const }] },
      {
        key: 'b',
        name: 'B',
        candidates: ['p1', 'p2', 'p3'].map((provider) => ({
          provider, realId: 'm', realName: 'm', price: 0, via: 'id' as const,
        })),
      },
    ]
    expect(maxAttemptsFor(models)).toBe(3)
  })

  it('auto 的候选池是所有渠道的所有模型，故至少为 1', () => {
    expect(maxAttemptsFor([])).toBeGreaterThanOrEqual(1)
  })

  it('★ 上限真的生效：`auto` 的巨池必须被截断（不许写成 Math.max(ranked.length, …)）', async () => {
    // ⚠️ 这条锁的是 Task 6 复审实测到的真实缺陷：初版写
    // `Math.max(ranked.length, maxAttemptsFor(...))` ⇒ `limit ≥ ranked.length`
    // 恒成立 ⇒ `slice` 永不截断 ⇒ 上限形同虚设（把 maxAttemptsFor 改成 `return 1`
    // 都不影响行为）。后果：auto 全候选失败时会依次尝试 100+ 次。
    //
    // 构造：一个虚拟模型的候选表长度 = 2（⇒ limit = 2），而 auto 池远大于 2。
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          // buddy 有 2 个模型 ⇒ 最长候选表 = 2 ⇒ limit 应为 2
          ? [
              { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
              { id: 'glm-5.3', name: 'GLM-5.3' },
            ]
          // codearts 有 4 个模型 ⇒ auto 池 = 2 + 4 = 6 条
          : [
              { id: 'glm-5.3', name: 'glm-5.3' },
              { id: 'kimi-k2.6', name: 'kimi-k2.6' },
              { id: 'minimax-m3', name: 'minimax-m3' },
              { id: 'hy3', name: 'hy3' },
            ]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        // 全部候选都失败 ⇒ 会走遍所有入选候选，sent 的长度就是实际尝试次数。
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            throw new Error('全挂')
          })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async () => 100,
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'auto')
    await expect((async () => {
      for await (const _ of call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) {
        // drain
      }
    })()).rejects.toThrow()

    // auto 池有 6 条候选，但 limit = 最长候选表 = 2 ⇒ **只应尝试 2 次**。
    // ⚠️ 若实现写成 `Math.max(ranked.length, …)`，这里会变成 6（缺陷复现）。
    expect(sent).toHaveLength(2)
  })
})

describe('prepareCall：真实链路 prepareCall → call.stream', () => {
  it('按临期升序把请求发给第一个候选，成功即返回', async () => {
    // 造两个渠道：buddy 临期更早（100ms 后），codearts 更晚（900ms 后）。
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    // 临期折算在本任务里先用「注入的探针」代替真实余额查询（见 Step 3 的实现）。
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _chunk of call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) {
      // 必须真正 drain，否则 stream 从未被调用、sent 会是空的
    }
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash'])
  })

  it('第一个候选抛错时自动换下一个候选，并把实际发往的序列记下来', async () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            if (options.provider === 'buddy') throw new Error('上游挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const chunks: unknown[] = []
    for await (const chunk of call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) {
      chunks.push(chunk)
    }
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash', 'codearts/deepseek-v4.1-flash'])
    expect(chunks).toHaveLength(1)
  })

  it('全部候选失败时如实抛最后一个错误（不静默成功）', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () {
          throw new Error('全挂了')
        })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async () => 100,
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) { /* drain */ }
    })()).rejects.toThrow('全挂了')
  })

  it('候选已产出 chunk 后失败：不再切换（否则两段回答会被拼接）', async () => {
    // ⚠️ 这是本任务**最关键**的那条约束（见 `dispatch` 的长注释）：已 `yield` 出去的
    // 内容收不回来，切换会让用户看到「A 的半截 + B 的完整答案」这种畸形拼接。
    // 断言必须能区分两条路径：若实现真的切换了，`sent` 会有第二条、用户也会看到
    // 两段文字；这里锁的是「sent 只有一条」+「异常如实抛出」+「半截内容仍在」。
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            if (options.provider === 'buddy') {
              yield { type: 'text', text: '半截' }
              throw new Error('吐了半截之后挂了')
            }
            yield { type: 'text', text: '完整答案' }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const chunks: Array<{ type: string; text?: string }> = []
    await expect((async () => {
      for await (const chunk of call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) {
        chunks.push(chunk as { type: string; text?: string })
      }
    })()).rejects.toThrow('吐了半截之后挂了')

    // ① 半截内容已交给调用方（收不回来，故不能假装没发生）；
    expect(chunks.map((chunk) => chunk.text)).toEqual(['半截'])
    // ② 没有尝试第二个候选 —— 这是「不拼接」的判据。
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash'])
  })

  it('档位逐候选翻译：exact 原样、mapped 就近、不可表达时不下发该字段', async () => {
    // ⚠️ 请求里的 `reasoningEffort` 来自**上一次对话**，可能带着别的模型族的档位名
    // ⇒ 原样转发会被 DSH 按 id 严格校验拦下 `UNSUPPORTED_REASONING_EFFORT`。
    // 这条用例锁的是**三种翻译结果各自对应哪条下发路径**（断言能区分路径）。
    const seen: Array<{ provider: string; effort: string | undefined }> = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          // buddy 用私有档位名 `low`（请求值 `medium` 应就近落到它）
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          // codearts 只有 on/off 开关，没有强度阶梯（`medium` 不可表达）
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        resolveModelInfo: async (provider: string) => (provider === 'buddy'
          ? { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
          : { reasoning: { efforts: [{ id: 'off' }, { id: 'on' }] } }),
        stream: (options: { provider: string; reasoningEffort?: string }) => {
          seen.push({ provider: options.provider, effort: options.reasoningEffort })
          return (async function* () { yield { type: 'text', text: 'ok' } })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })

    // ① mapped：`minimal`(rank 1) 不在 buddy 的 [low(3), high(5)] 里 → 就近落到 `low`。
    const mapped = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of mapped.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'minimal',
    } as never)) { /* drain */ }
    expect(seen).toEqual([{ provider: 'buddy', effort: 'low' }])

    // ①b 同距取更强（仓库既有的 `translateReasoningEffort` 口径）：`medium`(4) 距
    //     low(3) 与 high(5) **都是 1** ⇒ 必须落到**更强**的 `high`。这条断言锁的是
    //     那个方向 —— 反过来（取弱）会把用户主动选的强度悄悄降一档。
    seen.length = 0
    for await (const _ of mapped.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'medium',
    } as never)) { /* drain */ }
    expect(seen).toEqual([{ provider: 'buddy', effort: 'high' }])

    // ② exact：`high` 就在 buddy 声明里 → 原样下发（**不**被翻译动到）。
    seen.length = 0
    for await (const _ of mapped.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'high',
    } as never)) { /* drain */ }
    expect(seen).toEqual([{ provider: 'buddy', effort: 'high' }])

    // ③ unexpressible：请求 `none`（关闭思考，自成「族」，见 REASONING_EFFORT_RANK
    //    的注释），而 buddy 只声明 [low, high]（**没有关闭档**）⇒ 同族一个候选都没有
    //    ⇒ **不下发该字段**，让上游走自己的默认；紧接着 buddy 挂掉换到 codearts，
    //    它的 `off` 正是关闭族 ⇒ 这一条**能表达**（mapped）。
    //    ⚠️ 两条路径的下发值必须不同（undefined vs 'off'），否则断言分不清是哪条生效。
    const failing = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        resolveModelInfo: async (provider: string) => (provider === 'buddy'
          ? { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
          : { reasoning: { efforts: [{ id: 'off' }, { id: 'on' }] } }),
        stream: (options: { provider: string; reasoningEffort?: string }) => {
          seen.push({ provider: options.provider, effort: options.reasoningEffort })
          return (async function* () {
            if (options.provider === 'buddy') throw new Error('buddy 挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const fallback = new AggregateAdapter(failing, {
      accountPool: makePool(),
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })
    seen.length = 0
    const call = await fallback.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of call.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'none',
    } as never)) { /* drain */ }
    expect(seen).toEqual([
      // buddy 无关闭族 ⇒ 字段被摘掉（说明「不可表达时不下发」这条路径真的生效）。
      { provider: 'buddy', effort: undefined },
      // codearts 的 `off` 是关闭族 ⇒ 就近落到它（说明翻译是**逐候选**做的）。
      { provider: 'codearts', effort: 'off' },
    ])
  })

  it('带图请求只用声明支持图片的候选（不支持的那个被改道掉）', async () => {
    // ⚠️ 第一交付物：带图时**不能**把图发给没声明 image 的渠道 —— 失败现象会是
    // 上游报错（用户看不出真因）。判据是「发往序列里没有 codearts」。
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        // buddy（临期最早）**不支持图片**，codearts（更晚）支持。
        resolveModelInfo: async (provider: string) => ({
          inputModalities: provider === 'codearts' ? ['text', 'image'] : ['text'],
        }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () { yield { type: 'text', text: 'ok' } })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')

    // ① 带图：改道到 codearts（尽管 buddy 临期更早）。
    for await (const _ of call.stream({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] }],
    } as never)) { /* drain */ }
    expect(sent).toEqual(['codearts/deepseek-v4.1-flash'])

    // ② 对照：**不带图**时仍按临期胜者发给 buddy —— 这条对照证明改道只由图片触发，
    //    而不是「候选序被永久改掉了」。
    sent.length = 0
    for await (const _ of call.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash'])
  })

  it('全池都不支持图片时如实报错（不把图降级成文字占位）', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id, inputModalities: ['text'] }),
        stream: () => { throw new Error('带图请求不该被发出去') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(() => call.stream({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] }],
    } as never)).toThrow(/不支持图片/)
  })
})

describe('★ 失败切换在真实归一化路径上必须生效（Task 6 复审缺陷）', () => {
  /**
   * ⚠️ 关键：真实 `ctx.llm.stream` **不抛错**，而是把适配器失败归一化成
   * `{ type: 'finish', reason: { kind: 'error', failure } }` 的终止 chunk
   * （`dsh-llm/lib/index.js` 两处 `catch (error) { yield adapterFailureChunk(...); return }`）。
   * 故只靠 `catch` 的实现在生产路径上**永远不会切换候选**。
   *
   * 本用例的桩**如实复刻这个形状** —— 现有 24 条用例全部 stub 成「直接 throw」，
   * 因此结构性地看不见该缺陷（这正是它需要单独一条的原因）。
   */
  it('第一个候选返回 finish/error 帧时必须切换下一个候选，且不透出该失败帧', async () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            if (options.provider === 'buddy') {
              // ⚠️ 失败被归一化成终止 chunk，而**不是**抛出。
              yield { type: 'finish', reason: { kind: 'error', failure: { message: '上游挂了', code: 'SERVER' } } }
              return
            }
            yield { type: 'text', text: 'ok' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const chunks: Array<{ type: string }> = []
    for await (const chunk of call.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) {
      chunks.push(chunk as { type: string })
    }

    // ① 必须真的换到了第二个候选（缺陷实现下 sent 只有 buddy 一条）
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash', 'codearts/deepseek-v4.1-flash'])
    // ② 第一个候选的失败帧**不得透出**（否则消费者以为整轮已结束）
    expect(chunks.some((c) => c.type === 'finish' && (c as { reason?: { kind?: string } }).reason?.kind === 'error'))
      .toBe(false)
    // ③ 第二个候选的正文照常透出
    expect(chunks.some((c) => c.type === 'text')).toBe(true)
  })

  it('`aborted` 帧不切换候选（中止是调用方意愿，不是候选坏了）', async () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } } }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) {
        // drain
      }
    })()).rejects.toMatchObject({ name: 'AbortError' })
    // ⚠️ 只试了第一个候选 —— 中止绝不换候选。
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash'])
  })

  it('★ 中止错误必须**同时**带 name 与 code:ABORTED（外层靠 code 归类）', async () => {
    // ⚠️ 对抗审计实测订正：我们抛的错误会被**外层** DSH 的 adapterStream 捕获，
    //    再经 `adapterFailureChunk(error, signal)` 归类，判据是
    //    `signal?.aborted || failure.code === 'ABORTED' ? {kind:'aborted'} : {kind:'error'}`。
    //    若只设 name（初版就是如此），当 **signal 未被标记**时（上游适配器自行判定取消、
    //    抛了 code='ABORTED' 的错误 → 归一化成 finish/aborted 帧 → 我们重抛），
    //    外层会把它归成 `kind:'error'` ⇒ 消费者看到「错误」而非「已中止」，
    //    与「中止是调用方意愿」的语义相反。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () {
          // signal **未标记**，但上游自行判定取消（这是可达路径）
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } } }
        })(),
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    // 不传 signal ⇒ signal 未标记
    const error = await (async () => {
      try {
        for await (const _ of call.stream({
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        } as never)) { /* drain */ }
        return undefined
      } catch (caught) { return caught as { name?: string, code?: string } }
    })()

    expect(error?.name).toBe('AbortError')
    // ⚠️ 关键断言：外层 adapterFailureChunk 靠这个 code 才能归成 `aborted`
    expect(error?.code).toBe('ABORTED')
  })

  it('已产出正文后再收到 finish/error 帧：不再切换（否则两段回答被拼接）', async () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            yield { type: 'text', text: '半截回答…' }
            yield { type: 'finish', reason: { kind: 'error', failure: { message: '中途挂了', code: 'SERVER' } } }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) {
        // drain
      }
    })()).rejects.toThrow()
    // ⚠️ 已产出正文 ⇒ 不许再试第二个候选（拼接比报错更糟）。
    expect(sent).toEqual(['buddy/deepseek-v4.1-flash'])
  })
})

describe('★ 探针抛 AbortError 时不得被吞成「没有可用候选」（Task 7 复审 M4）', () => {
  it('探测途中被取消：抛 AbortError，而不是把每个渠道都折算成 UNUSABLE 后报无候选', async () => {
    // ⚠️ 真实缺陷（Task 7 复审 M4）：`candidatesFor` 的逐渠道探针 catch 原先是
    //    `catch { expiry = UNUSABLE }` ⇒ 探针刻意重抛的 AbortError 被吞 ⇒ **每个**
    //    渠道都变 UNUSABLE ⇒ 整池候选被剔除 ⇒ 用户取消请求后看到的是
    //    「没有任何可用候选」（与「真的没登录」无法区分），而不是中止。
    //    `aggregate-expiry.ts` 修了同一缺陷，这里是它的**第二实例**。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* 不应走到这里 */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      // 探针模拟「探测途中被取消」：抛 AbortError（signal **未**标记）
      expiryProbe: async () => {
        const error = new Error('aborted upstream')
        error.name = 'AbortError'
        throw error
      },
    })

    await expect(adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash'))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('★ 同族同构：探针抛 **499 报文**（signal 未标记）也必须逃逸，不得折算成 UNUSABLE', async () => {
    // ⚠️⚠️ 真实缺陷（2026-10-12 审计实测）：本处原先**只认** `name === 'AbortError'`，
    //    是「同族判据分叉」的实例 —— 同一份 499 报文在 `dispatch` 里归中止、
    //    在这里却被折算成 `UNUSABLE` ⇒ 整池候选被剔除 ⇒ 用户看到
    //    「当前没有任何可用候选」而不是中止（M4 那个形态的新实例）。
    //    修法：本处改为复用共享判据 `isAbortLike`。
    // ⚠️ 关键约束：错误**不带** `name: 'AbortError'` / `code: 'ABORTED'`，
    //    否则命中的是旧判据，第四条的覆盖是**假的**（假覆盖教训）。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* 不应走到这里 */ })(),
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
      } as never,
      expiryProbe: async () => {
        throw new Error('provider: client has aborted request HTTP_499')
      },
    })

    const error = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      .then(() => undefined, (caught: { message?: string }) => caught)
    expect(
      error?.message,
      '499 必须原样逃逸（不得折算成 UNUSABLE 后报「没有可用候选」）',
    ).toContain('aborted request')
  })
})

describe('★ 能力解析（capabilityOf）里的中止判据也必须与 isAbortLike 同构', () => {
  /**
   * ⚠️⚠️ 真实缺陷（2026-10-12 审计实测）：这是同族分叉的**第三处** ——
   * 本处原先只认 `name === 'AbortError'`，499 报文会被折算成
   * `{ efforts: [], imageCapable: false }` ⇒ 用户看到「候选渠道都不支持
   * 图片输入」这类**与中止无关**的误导性报错，且整轮不会中止。
   *
   * ⚠️ 触发路径：`resolveModelInfo` **接收 signal**，中止时它会抛 —— 而它
   *    的 throw 落在本方法的 `try` 内。故用 `resolveModelInfo` 抛 499 来打。
   */
  it('★ resolveModelInfo 抛 499 报文 ⇒ 必须逃逸，不得折算成「不支持图片」', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async () => {
          // ⚠️ 不带 name / code，只带 499 报文 —— 专门验第四条。
          throw new Error('provider: client has aborted request HTTP_499')
        },
        stream: () => (async function* () { /* 不应走到这里 */ })(),
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
      } as never,
      expiryProbe: async () => 100,
    })

    const error = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      .then(() => undefined, (caught: { message?: string }) => caught)
    expect(
      error?.message,
      '499 必须原样逃逸（不得折算成「不支持图片」）',
    ).toContain('aborted request')
  })
})

describe('★ 终审修正：错误码保真 / 渠道白名单 / 第三处 abort（C1 + I1 + I3）', () => {
  it('C1：上游 finish/error 的 code 必须保真，不得拍平成 SERVER（否则确定性错误被重试）', async () => {
    // ⚠️ `SERVER` 在 DSH 的 DEFAULT_RETRYABLE_CODES 里，而 QUOTA_EXCEEDED / AUTH
    //    不在。拍平会让「今日额度已用尽」被白重试 5 次（每次还重跑整个候选循环），
    //    并绕过 dead-model-store 的 IGNORED_CODES 豁免。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: '额度用尽', code: 'QUOTA_EXCEEDED' } } }
        })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })

  it('C1 兜底：上游没给 code 时才退回 SERVER', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: '说不清' } } }
        })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('I1：别的插件的 provider 不得进入聚合目录（否则广告出永远不可路由的模型）', async () => {
    // ⚠️ `listProviders()` 返回**宿主全部**存活路由。初版据此推导目录，会把
    //    `deepseek-account` / `pi-ai` 等别的插件的渠道也算成候选，而那些渠道的临期
    //    折算没接入 ⇒ 它们的虚拟模型永远没有可用候选 ⇒ 用户选中后被告知
    //    「没有任何可用候选」（把「未接入」谎报成「你没登录」）。
    const adapter = new AggregateAdapter({
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        // 宿主同时装载了本插件渠道与**外部** provider
        listProviders: () => [
          { id: 'buddy', name: 'b' },
          { id: 'deepseek-account', name: 'DeepSeek 官方' },
          { id: 'pi-ai-something', name: '外部' },
        ],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          // 外部 provider 播报一个**同源**模型：若白名单失效，它会与 buddy 合并
          : [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never, { accountPool: makePool() })

    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    // 虚拟模型的候选里**不得**出现外部 provider
    for (const model of models) {
      const real = await adapter.resolveModel(AGGREGATE_PROVIDER, model.id)
      expect(real.id).toBe(model.id)
    }
    const catalog = adapter.listAllModels()
    expect(catalog.length).toBeGreaterThan(0)
    // 直接查目录里那个虚拟模型的候选渠道（通过内部 catalog）
    const virtual = (adapter as unknown as { catalog: Array<{ key: string, candidates: Array<{ provider: string }> }> }).catalog
    const providers = new Set(virtual.flatMap((v) => v.candidates.map((c) => c.provider)))
    expect(providers.has('deepseek-account')).toBe(false)
    expect(providers.has('pi-ai-something')).toBe(false)
    expect(providers.has('buddy')).toBe(true)
  })

  it('I3：capabilityOf 期间中止必须抛 AbortError，不得折算成「无档位/不支持图片」', async () => {
    // ⚠️ 这是同一 abort 缺陷的**第三处**：`resolveModelInfo` 接收 signal，
    //    中止时它会抛 AbortError，而裸 catch 会把它折算成 imageCapable:false
    //    ⇒ 用户看到的是「候选渠道都不支持图片输入」而不是中止。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        },
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    await expect(adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash'))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('★ I2：选型缓存（规格 §9 要求，初版漏实现 ⇒ AGGREGATE_TTL_MS 是死配置）', () => {
  it('TTL 内的第二次 prepareCall 不得重跑上游余额探测', async () => {
    // ⚠️ 没有缓存时，每次 prepareCall 都会对每个候选渠道 await probe(...) ——
    //    那是一次上游余额 GET，而 prepareCall 是每请求一次 ⇒ auto 最坏每轮十几次
    //    余额查询，**比旧的 auto（有 60 秒缓存）还差**。
    let probeCalls = 0
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async () => { probeCalls += 1; return 100 },
    })

    // 第一次：会探测
    const first = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of first.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const afterFirst = probeCalls
    expect(afterFirst).toBeGreaterThan(0)

    // 第二次（TTL 内）：不得再探测
    const second = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of second.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    expect(probeCalls).toBe(afterFirst)
  })

  it('TTL 过期后必须重新探测（缓存不能永久钉住旧候选序）', async () => {
    let probeCalls = 0
    let fakeNow = 1_000
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      now: () => fakeNow,
      expiryProbe: async () => { probeCalls += 1; return 100 },
    })

    const first = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of first.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const afterFirst = probeCalls

    // 把时钟推过 TTL（60 秒）
    fakeNow += 61_000
    const second = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of second.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    expect(probeCalls).toBeGreaterThan(afterFirst)
  })

  it('缓存按虚拟模型分别存（A 的候选序不得覆盖 B 的）', async () => {
    const probes: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
          { id: 'glm-5.3', name: 'GLM-5.3' },
        ],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (provider) => { probes.push(provider); return 100 },
    })

    // 先请求 A，再请求 B，再回到 A —— 回到 A 时应命中 A 自己的缓存
    for (const model of ['deepseek-v4-1-flash', 'glm-5-3', 'deepseek-v4-1-flash']) {
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, model)
      for await (const _ of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ }
    }
    // 三次请求、同一渠道 ⇒ 只探测两次（A 一次、B 一次；第二次 A 命中缓存）
    expect(probes).toHaveLength(2)
  })
})

describe('★ M23：只产出元数据帧（block-start / usage）时仍可切换', () => {
  /** 造一个 ctx：`stream` 按 provider 分派到给定生成器。 */
  function makeCtx(sent: string[], buddyGen: () => AsyncGenerator<unknown>) {
    return {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string }) => {
          sent.push(options.provider)
          return (options.provider === 'buddy'
            ? buddyGen()
            : (async function* () {
                yield { type: 'text', text: 'ok' }
                yield { type: 'finish', reason: { kind: 'stop' } }
              })()) as AsyncGenerator<unknown>
        },
      },
    } as never
  }
  const makePool = () => ({
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never)
  const drain = async (call: { stream: (o: unknown) => AsyncIterable<unknown> }) => {
    const chunks: Array<{ type: string }> = []
    for await (const chunk of call.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk as { type: string })
    return chunks
  }

  it('第一个候选只吐了 usage 就失败 ⇒ **应切换**到第二个候选', async () => {
    // ⚠️ 初版判据是「产出过任何 chunk」，于是这种情形会放弃切换 —— 过度保守，
    //    白白丢掉一次本可成功的切换。实测 `BlockAssembler` 的语义：`usage`
    //    是**覆盖**（`this._usage = …`）且**不建块**（`ensure()` 只在 delta 时建）
    //    ⇒ 它可安全重放，故不算「可见内容」。
    //
    // ⚠️⚠️ **本条原先还带一个 `block-start`（并断言它会切换）—— 那已被实测推翻**：
    //    `block-start` 的幂等判据**只看 `index`、不更新 `blockType`** ⇒
    //    若 A 开 `text`、B 开 `tool-call`，B 的类型被忽略、**工具调用丢失**
    //   （探针实测：`blocks = [{"type":"text","text":""}]`）。
    //    适配器**无法预知**下一个候选会开什么类型 ⇒ 按类型豁免必然有缺口
    //    ⇒ 现在的判据是「**开过任何块就不切换**」。故本条去掉 `block-start`，
    //      只保留 `usage`（那才是真正可安全重放的那一种）。
    const sent: string[] = []
    const ctx = makeCtx(sent, () => (async function* () {
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '挂了', code: 'SERVER' } } }
    })())
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const chunks = await drain(call as never)

    // ① 真的切换了
    expect(sent).toEqual(['buddy', 'codearts'])
    // ② 拿到了第二个候选的正文
    expect(chunks.some((c) => c.type === 'text')).toBe(true)
    // ③ 第一个候选的失败帧**不透出**
    expect(chunks.some((c) => c.type === 'finish' && (c as { reason?: { kind?: string } }).reason?.kind === 'error')).toBe(false)
  })

  it('★ 对照：只吐 block-start（未吐 delta）后失败 ⇒ **不切换**（类型不可预知）', async () => {
    // ⚠️ 见上一条的注释：`block-start` 不能按类型豁免。
    const sent: string[] = []
    const ctx = makeCtx(sent, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '挂了', code: 'SERVER' } } }
    })())
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect(drain(call as never)).rejects.toThrow()
    expect(sent, '开过块 ⇒ 不切换').toEqual(['buddy'])
  })

  it('对照：第一个候选吐了**正文增量**后失败 ⇒ **不切换**（否则拼接两段回答）', async () => {
    const sent: string[] = []
    const ctx = makeCtx(sent, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '半截回答' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '挂了', code: 'SERVER' } } }
    })())
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect(drain(call as never)).rejects.toThrow()
    // ⚠️ 只试了第一个 —— 产出过正文后绝不切换。
    expect(sent).toEqual(['buddy'])
  })

  it('对照：block-end（含完整块）算可见内容 ⇒ 不切换', async () => {
    const sent: string[] = []
    const ctx = makeCtx(sent, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '完整块' } }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '挂了', code: 'SERVER' } } }
    })())
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })

    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect(drain(call as never)).rejects.toThrow()
    expect(sent).toEqual(['buddy'])
  })
})

describe('★ 未接入临期折算的渠道：模型**仍然可见**（用户 2026-10-15 的诉求 IKL7F9）', () => {
  /** 造一个 ctx：listProviders 与 listModels 都按给定渠道表。 */
  const makeCtx = (catalogByProvider: Record<string, Array<{ id: string, name: string }>>) => ({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => Object.keys(catalogByProvider).map((id) => ({ id, name: id })),
      listModels: async (provider: string) => catalogByProvider[provider] ?? [],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: () => (async function* () { /* noop */ })(),
    },
  } as never)
  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  it('★★ 候选**全部**是「无临期且未打开」⇒ 模型**从选择器消失，但仍在聚合面板里**（2026-10-16）', async () => {
    // ⚠️⚠️ **本用例的方向在 2026-10-16 第二次反转**（用户验收反馈）：
    //    用户原话：「默认不参与轮换的无临期模型（**没有一个打开轮换**）则**不显示在
    //    选择模型的列表中的聚合模型下属的列表中**」。
    //
    //    演进留档（三次）：
    //     ① 2026-10-07：未接入渠道的独有模型**整条不播报**（当时理由是报错会谎报）；
    //     ② 2026-10-15：改为**必须播报**（否则「手工打开」之后选择器里仍看不到它）；
    //     ③ 2026-10-16（现行）：**一个都没打开时**不播报；**打开任意一条后**才播报。
    //    ⇒ ③ 兼顾了 ① 的意图（不广告一个必然失败的模型）与 ② 的意图（打开后必须可见）。
    //
    // ⚠️⚠️ **恢复路径没有丢**（这正是与「候选全被拒」的区别）：
    //    它**仍在聚合面板**里（`describeCatalog` 不受本过滤影响），
    //    用户在那里展开、逐条打开后它就回到选择器。
    const adapter = new AggregateAdapter(
      makeCtx({ cline: [{ id: 'cline-free/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] }),
      { accountPool: pool, expiryProbe: async () => 100 },
    )
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.map((m) => m.id), '★ 一个都没打开 ⇒ 不进选择器')
      .toEqual(['auto'])
    // ★ 但设置页的开关清单（`listAllModels`）**必须仍能看到它** —— 目录身份不随门控漂移
    //   （`provider.status` 的 `total` 取自它，藏起来会让「整个 provider 已关闭」的
    //   判据 `disabled === total` 抖动）。
    expect(adapter.listAllModels().map((m) => m.id), '★ 目录身份必须稳定')
      .toEqual(['auto', 'deepseek-v4-1-flash'])
    // ★ 且聚合面板必须仍列出它（那是唯一的打开入口）。
    const catalog = await adapter.describeCatalog()
    expect(catalog.models.map((m) => m.canonicalId), '★ 面板必须仍能看到（打开入口）')
      .toContain('deepseek-v4-1-flash')
  })

  it('★★ 打开任意一条未接入候选 ⇒ 该模型**回到**选择器（恢复路径可用）', async () => {
    // ⚠️ 这条与上一条构成**一对**：只测「没打开时不显示」会让「打开后也不显示」
    //    的缺陷全绿（那是本仓库反复出现的「只测一个方向」形态）。
    const adapter = new AggregateAdapter(
      makeCtx({ cline: [{ id: 'cline-free/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] }),
      {
        accountPool: pool,
        expiryProbe: async () => 100,
        allowed: () => ({ 'deepseek-v4-1-flash': { cline: { 'cline-free/deepseek-v4.1-flash': true } } }),
      },
    )
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.map((m) => m.id), '★ 打开后必须回到选择器')
      .toEqual(['auto', 'deepseek-v4-1-flash'])
  })

  it('★★ 对照：**用户主动全部拒绝**的模型仍留在选择器里（成文不变式，不得被上一条误伤）', async () => {
    // ⚠️⚠️ 这是本对改动**最重要的反向守卫**：判据必须是「所有候选都 `default-rejected`」，
    //    **不是**「没有候选在轮换」。后者会把「用户主动全拒」的模型也藏掉 ——
    //    而那条有成文不变式保护（`jet-hub-store.ts` 的「候选全被拒 ≠ 关闭模型」）：
    //    模型留在选择器里 ⇒ 用户选中它拿到**如实**报错 ⇒ 回面板重新打开即恢复。
    //    若藏起来，用户连「我拒过这个模型」都看不到了。
    const adapter = new AggregateAdapter(
      makeCtx({ buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }] }),
      {
        accountPool: pool,
        expiryProbe: async () => 100,
        rejections: () => ({ 'deepseek-v4-1-flash': { buddy: { 'deepseek-v4.1-flash': true } } }),
      },
    )
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.map((m) => m.id), '★ 主动全拒 ≠ 无临期全未打开：必须仍播报')
      .toContain('deepseek-v4-1-flash')
  })

  it('★★ 把某模型的候选**全部**拒绝 ⇒ 模型**仍在**目录里（锁住「全拒 ≠ 关闭模型」的成文不变式）', async () => {
    // ⚠️⚠️ 这条是**防后人加回过滤**的守卫：若有人把 `:636` 改回「至少一个候选当前参与」
    //   （或按三态过滤），用户把某模型候选全拒后会**再也看不到它**，
    //    连「在面板里重新打开」的机会都没有。
    //
    // 仓库里有**两处成文不变式**明文禁止该语义：
    //  ① `jet-hub-store.ts` 的 `AggregateRejectionMap` 上方：「把某虚拟模型的候选
    //     **全部**拒绝 ≠ 关闭该虚拟模型：前者它仍在目录里（只是无候选可用，请求时
    //     如实报错），后者从目录消失」；
    //  ② `aggregate-panel-logic.js` 的 `isAllCandidatesRejected`：「面板需对『候选全部
    //     被拒』给出显式提示，避免用户以为模型坏了」。
    const adapter = new AggregateAdapter(
      makeCtx({ buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }] }),
      {
        accountPool: pool,
        expiryProbe: async () => 100,
        rejections: () => ({ 'deepseek-v4-1-flash': { buddy: { 'deepseek-v4.1-flash': true } } }),
      },
    )
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.map((m) => m.id), '全部被拒**不得**让模型从目录消失').toContain('deepseek-v4-1-flash')
    // ⚠️ 同时确认三态判据真的把它判成「不参与」—— 否则上面那条断言会掩盖过滤失效。
    const catalog = await adapter.describeCatalog()
    const entry = catalog.models.find((m) => m.canonicalId === 'deepseek-v4-1-flash')
    expect(entry!.candidates[0]!.state, '显式拒绝 ⇒ rejected 态').toBe('rejected')
    expect(entry!.candidates[0]!.rejected).toBe(true)
  })

  it('候选里有任一已接入渠道 ⇒ 该虚拟模型仍被播报，且两渠道都在候选表里', async () => {
    const adapter = new AggregateAdapter(
      makeCtx({
        buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        cline: [{ id: 'cline-free/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
      }),
      { accountPool: pool, expiryProbe: async () => 100 },
    )
    await warmCatalog(adapter)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.some((m) => m.id === 'deepseek-v4-1-flash')).toBe(true)
    const virtual = (adapter as unknown as { catalog: Array<{ key: string, candidates: Array<{ provider: string }> }> })
      .catalog.find((v) => v.key === 'deepseek-v4-1-flash')
    expect(virtual?.candidates.map((c) => c.provider).sort()).toEqual(['buddy', 'cline'])
    // ⚠️ 候选表里有 cline **不等于**它会参与轮换：默认态下它是 `default-rejected`。
    const catalog = await adapter.describeCatalog()
    const entry = catalog.models.find((m) => m.canonicalId === 'deepseek-v4-1-flash')
    const byProvider = Object.fromEntries(entry!.candidates.map((c) => [c.provider, c.state]))
    expect(byProvider.buddy, '已接入 ⇒ 默认参与').toBe('allowed')
    expect(byProvider.cline, '未接入 ⇒ 默认不参与').toBe('default-rejected')
  })

  it('★ 手工打开未接入候选 ⇒ 它变成 allowed 且价格进入「最低」报价', async () => {
    // ⚠️ 两个方向都要测：只测「默认不参与」时，把白名单接线整段删掉用例仍然全绿。
    const adapter = new AggregateAdapter(
      makeCtx({
        buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.15' }],
        cline: [{ id: 'cline-free/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash · x0.01' }],
      }),
      {
        accountPool: pool,
        expiryProbe: async () => 100,
        allowed: () => ({ 'deepseek-v4-1-flash': { cline: { 'cline-free/deepseek-v4.1-flash': true } } }),
      },
    )
    const catalog = await adapter.describeCatalog()
    const entry = catalog.models.find((m) => m.canonicalId === 'deepseek-v4-1-flash')
    const cline = entry!.candidates.find((c) => c.provider === 'cline')
    expect(cline!.state).toBe('allowed')
    expect(cline!.expiryWired, '客户端据此决定「关掉时写哪张表」').toBe(false)
    // 手工打开后它的价格该算进「最低」—— 否则选择器会说谎（更便宜的候选被用上却没报）。
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.find((m) => m.id === 'deepseek-v4-1-flash')!.name)
      .toBe('DeepSeek V4.1 Flash · 最低 x0.01')
  })

  it('`auto` 始终在目录里（它不参与任何过滤，池跨全部渠道）', async () => {
    const adapter = new AggregateAdapter(
      makeCtx({ raccoon: [{ id: 'sn-glm-5-3', name: 'GLM-5-3 · x0.75' }] }),
      { accountPool: pool, expiryProbe: async () => 100 },
    )
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.some((m) => m.id === 'auto')).toBe(true)
    expect(adapter.listAllModels().some((m) => m.id === 'auto')).toBe(true)
  })

  it('★ 手工顺序按当前候选过滤后下发（漂移的脏键不得变成幽灵条目）', async () => {
    const adapter = new AggregateAdapter(
      makeCtx({ buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }] }),
      {
        accountPool: pool,
        expiryProbe: async () => 100,
        order: () => ({ 'deepseek-v4-1-flash': ['buddy\u0000drifted-away', 'buddy\u0000deepseek-v4.1-flash'] }),
        orderMode: () => 'manual',
      },
    )
    const catalog = await adapter.describeCatalog()
    expect(catalog.orderMode).toBe('manual')
    expect(catalog.models[0]!.order, '只留仍然是候选的那个键').toEqual(['buddy\u0000deepseek-v4.1-flash'])
  })
})

describe('★ 报错文案：面板现在**真的存在**了，必须指向它并列出第 4 种原因', () => {
  const makeCtx = (models: Array<{ id: string, name: string }>) => ({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'buddy' }],
      listModels: async () => models,
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: () => (async function* () { /* noop */ })(),
    },
  } as never)
  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  /**
   * ⚠️ 本节的方向在 2026-10-15 **反转**（原用例名：「报错文案不得把用户指向**不存在**的 UI」）。
   *
   * 原判据当时是对的：客户端 `PROVIDERS` 里没有 `aggregate` ⇒ 设置页**没有**聚合面板，
   * 而初版文案却让用户去那里看 —— 误导性指引。
   * 现在那个面板**已经存在**（`plugin-src/client/jet-hub.js` 的 `AggregatePanel`，
   * `<h2>` 逐字是「聚合」）⇒ **指向它是正确的**，而**不**指向它才是缺陷
   *（用户拿着「没有任何可用候选」却不知道去哪打开候选）。
   *
   * ⚠️ 但原用例的**内核**仍然要守：文案必须给出**真实可操作**的指引（不是空话），
   *    且必须列出**全部**原因 —— 尤其新增的第 4 种「候选在聚合面板里未参与轮换」。
   */
  it('未知模型的报错给出可操作指引（模型选择器 / 直连）', async () => {
    const adapter = new AggregateAdapter(makeCtx([{ id: 'glm-5.3', name: 'GLM-5.3' }]), {
      accountPool: pool, expiryProbe: async () => 100,
    })
    // ⚠️ 目录必须先落地（冷帧下 `resolveModel` 不等待、不抛未知模型错，见其方法头）。
    await adapter.refreshCatalog()
    await expect(adapter.resolveModel(AGGREGATE_PROVIDER, 'nope'))
      .rejects.toThrow(/模型选择器/)
  })

  it('★★ 零候选的报错必须提到第 4 种原因「未参与轮换」，并指向真实存在的「聚合」面板', async () => {
    const adapter = new AggregateAdapter(makeCtx([{ id: 'glm-5.3', name: 'GLM-5.3' }]), {
      accountPool: pool,
      // 全部候选都 UNUSABLE ⇒ 零候选
      expiryProbe: async () => -1,
    })
    const err = await adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    // 第 4 种原因必须写明：未接入渠道的候选**默认不参与**是本功能新引入的零候选来源。
    expect(message, '★ 必须提到「未参与轮换」这第 4 种原因').toMatch(/未参与轮换/)
    // 面板真实存在（`AggregatePanel`，标题逐字「聚合」）⇒ 可以也应该指向它。
    expect(message, '必须指向真实存在的设置页面板').toMatch(/设置页的「聚合」面板/)
    // 且保留原有那两条可操作出路。
    expect(message).toMatch(/模型选择器|直连/)
  })

  it('源码级：零候选的文案必须列出四种原因（防「漏掉第 4 种」回归）', async () => {
    // ⚠️ 必须**剥离注释**再断言（与 `auto-adapter.spec.ts` 的源码守卫同一手法）：
    //    本文件与源码的注释里**故意**引用了旧文案来说明它是错的，不剥离会误报。
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../src/aggregate-adapter.ts', import.meta.url), 'utf8',
    ))
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // 四种原因**逐个点名**（计数式断言：只断言「含其中一个」会让漏掉其余三个仍然绿）。
    for (const cause of ['渠道被关闭', '模型被关', '无可用账号', '未参与轮换']) {
      expect(code, `零候选文案必须列出原因「${cause}」`).toContain(cause)
    }
  })
})

describe('★ 第 5 轮审计：目录刷新后不得服务已下架的模型（choiceCache 的 TTL 内也不例外）', () => {
  it('上游下架模型后，TTL 内请求它必须抛 INVALID_REQUEST（不得发到已下架的 realId）', async () => {
    // ⚠️ 本用例锁的是**行为**（下架后即使 choiceCache 仍在 TTL 内也必须拒绝），
    //    **不是**「`resolveModel` 必须先于 `candidatesFor`」—— 那条假设是**错的**：
    //    `candidatesFor` 自己也调 `ensureCatalog()`，故交换两者顺序**行为不变**
    //    （实测：交换后本用例仍通过）。我最初据此写了「顺序保证」的注释，
    //    反向验证没变红才发现是同义反复 —— 注释与标题已订正，用例保留（断言有价值）。
    // 真正的保证：`ensureCatalog` 刷新后 `this.catalog` 即当前目录 ⇒ 已下架的模型
    // 既过不了 `resolveModel`、也进不了候选序。
    let phase = 1
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }],
        listModels: async () => (phase === 1
          ? [{ id: 'glm-5.3', name: 'GLM-5.3' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })

    // 阶段 1：填 choiceCache
    const first = await adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3')
    for await (const _ of first.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }

    // 阶段 2：上游下架 glm-5.3 并强制刷新目录（choiceCache 仍在 TTL 内）
    phase = 2
    await adapter.refreshCatalog(true)

    await expect(adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

describe('★ P3：activeProvider —— 「上次实际转发成功的渠道」', () => {
  /** 造一个「首个候选失败、其余成功」的 ctx，并记录实际发往的序列。 */
  function makeFailoverCtx(sent: string[], failing: string) {
    return {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () {
            if (options.provider === failing) throw new Error('上游挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
  }

  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  it('★ 无历史时返回 null（尚未发过任何请求 / 插件重启后内存清空）', () => {
    // ⚠️ 规格 §6.3 的 P4：无历史 ⇒ 徽标**不渲染**。**不做预测** ——
    //    预测胜者可能因失败切换而实际未被使用，显示错的渠道比不显示更误导。
    const adapter = new AggregateAdapter(makeCtx({ buddy: [{ id: 'glm-5.3', name: 'GLM-5.3' }] }), {
      accountPool: makePool(),
    })
    expect(adapter.activeProvider()).toBe(null)
    expect(adapter.activeProvider('glm-5-3')).toBe(null)
  })

  it('★ 转发成功后记录**实际发往**的渠道（不是候选序第一个）', async () => {
    // ⚠️ 这是本机制的核心：候选序按「临期优先」排，但失败会切换 ——
    //    记录的必须是**真的用了**的那个渠道，否则徽标会指向一个已失败的渠道。
    const sent: string[] = []
    const adapter = new AggregateAdapter(makeFailoverCtx(sent, 'buddy'), {
      accountPool: pool,
      // buddy 更临期（100 < 900）⇒ 它排第一，但会失败 ⇒ 实际发往 codearts
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _chunk of call.stream({ messages: [] } as never)) { /* drain */ }

    expect(sent).toEqual(['buddy/deepseek-v4.1-flash', 'codearts/deepseek-v4.1-flash'])
    // ★ 记录的是**成功**的 codearts，不是排第一但失败的 buddy
    expect(adapter.activeProvider()).toBe('codearts')
    expect(adapter.activeProvider('deepseek-v4-1-flash')).toBe('codearts')
  })

  it('★ 首个候选就成功 ⇒ 记录它（不因「后面还有候选」而变）', async () => {
    const sent: string[] = []
    const adapter = new AggregateAdapter(makeFailoverCtx(sent, 'codearts'), {
      accountPool: pool,
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _chunk of call.stream({ messages: [] } as never)) { /* drain */ }
    expect(adapter.activeProvider()).toBe('buddy')
  })

  it('★ 只在**成功**时写：全部候选都失败 ⇒ 不记录任何渠道', async () => {
    // ⚠️ 规格 §6.3 的 P3 原文：「只在成功时写 —— 写失败候选会让徽标指向一个
    //    刚刚失败、甚至已无额度的渠道」。
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(`${options.provider}/${options.model}`)
          return (async function* () { throw new Error('上游挂了') })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _chunk of call.stream({ messages: [] } as never)) { /* drain */ }
    })()).rejects.toThrow()

    expect(sent.length).toBeGreaterThan(0)          // 确实尝试过
    expect(adapter.activeProvider()).toBe(null)     // 但一次都没成功 ⇒ 不记录
  })

  it('★ 按虚拟模型分别记录；省略参数时取「最近一次」', async () => {
    // ⚠️ `makeCtx` 的 `stream` 是**抛错的桩**（它用于不需要真实转发的用例）
    //    ⇒ 本用例必须用能产出 chunk 的 ctx，否则会看到「本用例不应调用 stream」。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
          { id: 'glm-5.3', name: 'GLM-5.3' },
        ],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    for (const model of ['deepseek-v4-1-flash', 'glm-5-3']) {
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, model)
      for await (const _chunk of call.stream({ messages: [] } as never)) { /* drain */ }
    }
    expect(adapter.activeProvider('deepseek-v4-1-flash')).toBe('buddy')
    expect(adapter.activeProvider('glm-5-3')).toBe('buddy')
    expect(adapter.activeProvider()).toBe('buddy')
  })

  it('★ 「最近一次」不靠 Map 迭代顺序（覆盖已存在的键不改变其位置）', async () => {
    // ⚠️ `Map` 的迭代顺序是**插入顺序**，覆盖已存在的键**不改变**其位置
    //    ⇒ 若靠 `[...map.values()].at(-1)` 取「最近」，在「切回一个**先前用过**的
    //    模型/渠道」时会取到**旧**值（徽标显示错的）。
    //    ⚠️ 必须用**两个模型**才能暴露这个陷阱：只有一个键时 `.at(-1)` 恰好也正确
    //    （我第一版就是单模型，那条用例区分不出实现，等于同义反复）。
    //
    // 序列：模型 A 成功→buddy（Map: [A]）→ 模型 B 成功→codearts（Map: [A,B]）
    //       → 模型 A 再次成功→buddy（**覆盖** A 的值，Map 位置仍是第一）
    //    ⇒ 「最近」= buddy；而 `[...values()].at(-1)` = codearts（错）。
    let phase = 1
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => [
          { id: 'm-alpha', name: 'M-Alpha' },
          { id: 'm-beta', name: 'M-Beta' },
        ].map((m) => (provider === 'buddy' ? m : { ...m, name: m.name.toLowerCase() })),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          // 让指定渠道失败，从而把成功的渠道逼到另一边。
          const failThis = phase === 1 ? 'codearts' : (phase === 2 ? 'buddy' : 'codearts')
          return (async function* () {
            if (options.provider === failThis) throw new Error('上游挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (provider) => (provider === 'buddy' ? 100 : 900),
    })
    const run = async (model: string) => {
      adapter.clearChoiceCache()
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, model)
      for await (const _chunk of call.stream({ messages: [] } as never)) { /* drain */ }
    }

    // ① 模型 A 成功 → buddy（buddy 更临期且不失败）
    await run('m-alpha')
    expect(adapter.activeProvider('m-alpha')).toBe('buddy')
    expect(adapter.activeProvider()).toBe('buddy')

    // ② 模型 B 成功 → codearts（这一轮 buddy 失败）
    phase = 2
    await run('m-beta')
    expect(adapter.activeProvider('m-beta')).toBe('codearts')
    expect(adapter.activeProvider()).toBe('codearts')

    // ③ 模型 A **再次**成功 → buddy（覆盖已存在的键，Map 位置不变）
    phase = 3
    await run('m-alpha')
    expect(adapter.activeProvider('m-alpha')).toBe('buddy')
    // ★ 关键断言：最近一次是 buddy；靠 Map 迭代顺序会得到 codearts（错）
    expect(adapter.activeProvider()).toBe('buddy')
  })
})

/**
 * ★★ 已开过块 ⇒ **绝不能切换**（真实缺陷，对抗审计用真实 `BlockAssembler` 实测证伪）。
 *
 * ## 机制（用真实 `BlockAssembler` 实证）
 *
 * `BlockAssembler.push` 对 `block-start` 的判据是**按 `index` 幂等**：
 *
 * ```js
 * case 'block-start': {
 *   if (!this.partials.has(chunk.index)) {   // ← 已存在就**直接 return**
 *     this.order.push(chunk.index)
 *     this.partials.set(chunk.index, { blockType: chunk.blockType, … })
 *   }
 *   return
 * }
 * ```
 * ⇒ 第二个候选重发**同 index** 的 `block-start` 会被**忽略**，`blockType` **不更新**。
 *
 * 而本适配器把 `block-start` 判为「不算可见内容」(`isVisibleContent`) ⇒ **允许切换**
 * ⇒ 候选 A 开了 `block-start(0, 'tool-call')` 后失败、候选 B 重发
 * `block-start(0, 'text')` + 正文时，**B 的正文被灌进 A 的 tool-call 块**。
 *
 * 探针（真实 `BlockAssembler`）逐字输出：
 * ```
 * blocks = [{"type":"tool-call","id":"call-0","name":"","arguments":""}]
 * partials = [[0,{"blockType":"tool-call","text":"B 的正文","toolCallArguments":""}]]
 * finish = {"kind":"stop"}
 * ```
 * ⇒ 下游只看到一个**空的 tool-call**、**用户可见答案丢失**，且 `finish=stop`
 * 看起来是干净结束（无任何报错）。
 *
 * ⚠️ 原注释断言「仅 `block-start` / `usage` 这类元数据帧是**可安全重放**的」——
 * **它可重放，但不更新 blockType**。那个前提是错的。
 *
 * ⚠️ 既有用例为什么没抓到：它们让 A 吐 `{type:'text'}`（**不带 block-start**），
 * 于是从未走过「先开块、后失败」这条路径。
 */
describe('★★ 已开过块就不能切换（block-start 不可跨候选重放）', () => {
  const makeTwoChannelCtx = (
    firstChunks: unknown[],
    secondChunks: unknown[],
  ) => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string; model: string }) => {
          sent.push(options.provider)
          const chunks = options.provider === 'buddy' ? firstChunks : secondChunks
          return (async function* () {
            for (const c of chunks) yield c
            if (options.provider === 'buddy') throw new Error('A 挂了')
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider: string) => (provider === 'buddy' ? 100 : 900),
    })
    return { adapter, sent }
  }

  it('★ 候选 A 开了 tool-call 块后失败 ⇒ **不得切换**（否则 B 的正文灌进 tool-call）', async () => {
    const { adapter, sent } = makeTwoChannelCtx(
      // A：开一个 tool-call 块，然后失败（不吐任何 delta）
      [{ type: 'block-start', index: 0, blockType: 'tool-call', id: 'call-0', name: '' }],
      // B：开 text 块 + 正文（若切换，正文会被灌进 A 的 tool-call 块）
      [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'B 的正文' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const yielded: unknown[] = []
    await expect((async () => {
      for await (const chunk of call.stream({ messages: [] } as never)) yielded.push(chunk)
    })()).rejects.toThrow()
    // ★ 不能切换：B 从未被调用
    expect(sent, '已开过块 ⇒ 不得切换').toEqual(['buddy'])
    // 且 A 的 block-start 必须如实透出（不能吞掉）
    expect(yielded.some((c) => c.type === 'block-start')).toBe(true)
  })

  it('★ 对照：A 只吐 usage（元数据，不产生块）后失败 ⇒ **允许切换**', async () => {
    // ⚠️ `usage` 不建块（`BlockAssembler` 只覆盖同名字段）⇒ 重放是安全的。
    const { adapter, sent } = makeTwoChannelCtx(
      [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } }],
      [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'B 的正文' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const yielded: unknown[] = []
    for await (const chunk of call.stream({ messages: [] } as never)) yielded.push(chunk)
    expect(sent, 'usage 未建块 ⇒ 可以安全切换').toEqual(['buddy', 'codearts'])
    expect(yielded.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('★ 对照：A 什么都没吐就失败 ⇒ 允许切换（既有行为不能破）', async () => {
    const { adapter, sent } = makeTwoChannelCtx(
      [],
      [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'ok' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    expect(sent).toEqual(['buddy', 'codearts'])
  })
})

/**
 * ★ `refreshCatalog` 不得吞掉 `AbortError`（真实缺陷，对抗审计实测证伪）。
 *
 * ## 为什么这是**同型缺陷的第四处**
 *
 * 模块头与提交信息都声称「中止必须抛 `AbortError`，绝不折算成 `UNUSABLE`
 *（**三处**独立修复）」。而 `refreshCatalog` 是**第四处**：
 *
 * - 它**没有 `signal` 形参**；
 * - 逐渠道 `catch` 吞掉**一切**错误（含 `AbortError`），只记 warn；
 * - 随后**仍然** `this.catalogAt = now` ⇒ **截断的目录被缓存 60 秒**。
 *
 * ⇒ 用户取消一次请求后，被取消的那个渠道会**从聚合目录里消失 60 秒**
 *（`listModels` 返回空 ⇒ 该渠道的候选全没了），而用户看到的理由是
 *「读取 xxx 目录失败」——与「用户主动取消」完全无关，且与「该渠道真的没登录」
 * 无法区分。这正是本仓库反复修的形态。
 */
describe('★ refreshCatalog 必须让 AbortError 逃逸（第四处同型点）', () => {
  const makeCtxWithAbort = () => {
    let catalogReads = 0
    const controller = new AbortController()
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => {
          catalogReads += 1
          if (provider === 'codearts') {
            // 模拟「读目录途中被取消」：抛 AbortError
            const error = new Error('The operation was aborted')
            error.name = 'AbortError'
            throw error
          }
          return [{ id: 'glm-5.3', name: 'GLM-5.3' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    return { ctx, pool, controller, reads: () => catalogReads }
  }

  it('★ 中止已标记时 refreshCatalog 必须抛 AbortError（不得吞成 warn）', async () => {
    const { ctx, pool, controller } = makeCtxWithAbort()
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    controller.abort()
    // ⚠️ 传入已中止的 signal ⇒ 必须抛，而不是「跳过 codearts 后正常返回」
    await expect(adapter.refreshCatalog(true, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('★ 中止时**不得**缓存截断的目录（否则被取消的渠道消失 60 秒）', async () => {
    // ⚠️ `LlmRuntime.listModels(provider)` **只接受一个参数、没有 signal 通道**
    //   （`dsh-llm/lib/index.js:1471` 的 `async listModels(provider)`）⇒ 无法把
    //    signal 透传给目录读取。故判据只能是：
    //    ① 收到已标记的 signal ⇒ 立刻抛 `AbortError`（不开始读）；
    //    ② 读取途中若拿到 `AbortError` ⇒ 逃逸，**且不写 `catalogAt`**。
    const { ctx, pool, controller } = makeCtxWithAbort()
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    controller.abort()
    await expect(adapter.refreshCatalog(true, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    // ② 中止后不得留下「已缓存」的时间戳 ⇒ 下次调用必须重新读目录
    const catalogAt = (adapter as unknown as { catalogAt: number }).catalogAt
    expect(catalogAt, '中止后不得写 catalogAt（否则截断目录被缓存 60 秒）').toBe(0)
  })

  it('★ 暂停：非中止错误仍只 warn 并跳过（既有行为不能破）', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => {
          if (provider === 'codearts') throw new Error('网络抖动')
          return [{ id: 'glm-5.3', name: 'GLM-5.3' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const models = await adapter.refreshCatalog(true)
    expect(models.some((m) => m.key === 'glm-5-3'), 'buddy 的目录仍要读进来').toBe(true)
  })
})

/**
 * ★ 覆盖缺口补全：**signal 未标记、但 `listModels` 抛 `AbortError`** ⇒ 必须逃逸。
 *
 * ⚠️ 上面那条用例走的是「signal **已被标记**」⇒ 循环开头的 `throwIfAborted()` 就抛了，
 * `catch` 里的逃逸分支**根本没被执行**。故它是**假覆盖**（我的第一版就是这样，
 * 反向验证时「吞掉中止」竟仍全绿，才发现）。
 *
 * ⚠️ 真实场景：取消可能发生在**读取某个渠道目录的过程中**（而非循环开始前）——
 * 此时 `listModels` 会抛 `AbortError`，而 signal 未必已被标记
 *（与 `aggregate-expiry.ts` 的 M2 情形同源：`LlmRuntime.listModels` 无 signal 通道，
 *  中止只能靠抛出的错误类型识别）。
 */
describe('★ refreshCatalog：signal 未标记但抛 AbortError ⇒ 仍必须逃逸', () => {
  it('★ 逐渠道读取途中抛 AbortError ⇒ 逃逸且不缓存', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => {
          if (provider === 'codearts') {
            const error = new Error('The operation was aborted')
            error.name = 'AbortError'
            throw error
          }
          return [{ id: 'glm-5.3', name: 'GLM-5.3' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    // ⚠️ signal **未标记**，但读取抛 AbortError
    const controller = new AbortController()
    await expect(adapter.refreshCatalog(true, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect((adapter as unknown as { catalogAt: number }).catalogAt).toBe(0)
  })
})

/**
 * ★ 徽标只记**整轮成功**的渠道（真实缺陷，对抗审计实测证伪）。
 *
 * 规格 §6.3 P3 原文：「由适配器在**转发成功时**记录……⚠️ **只在成功时写** ——
 * 写失败候选会让徽标指向一个刚刚失败、甚至已无额度的渠道」。
 *
 * 旧实现写在「**首个可见 chunk**」时：若该候选吐了一个 `text-delta` 之后
 * **整轮失败**（如上游 `socket hang up`），用户**什么也没拿到**，徽标却记下了
 * 这个**失败**的渠道。
 */
describe('★ activeProvider 只记整轮成功的渠道', () => {
  const makeCtx = (buddyGen: () => AsyncGenerator<unknown>) => ({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
      listModels: async (provider: string) => (provider === 'buddy'
        ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
        : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: (options: { provider: string }) => (options.provider === 'buddy'
        ? buddyGen()
        : (async function* () { yield { type: 'text', text: 'ok' } })()) as AsyncGenerator<unknown>,
    },
  }) as never

  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  it('★ 吐了内容但整轮失败 ⇒ **不得**记录该渠道（用户什么也没拿到）', async () => {
    const ctx = makeCtx(() => (async function* () {
      yield { type: 'text-delta', index: 0, text: '半截' }
      throw new Error('socket hang up')
    })() as AsyncGenerator<unknown>)
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    })()).rejects.toThrow()
    // ★ 整轮失败 ⇒ 徽标不得指向这个失败的渠道
    expect(adapter.activeProvider()).toBe(null)
  })

  it('★ 对照：整轮成功 ⇒ 记录该渠道', async () => {
    const ctx = makeCtx(() => (async function* () {
      yield { type: 'text-delta', index: 0, text: '完整答案' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() as AsyncGenerator<unknown>)
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    expect(adapter.activeProvider()).toBe('buddy')
  })
})

/**
 * ★ 上游 failure 的**其余事实**必须一并带上（真实缺陷，对抗审计实测证伪）。
 *
 * `LlmError` 的第三参接受并校验 `status` / `providerRetryAfterMs` / `requestId`
 *（`dsh-llm/lib/index.js:1026-1048`），而旧实现只传 message + code ⇒ 三者全丢。
 *
 * ⚠️ `providerRetryAfterMs` 是**服务端指定延迟**的机器通道 —— 丢了它退避只能靠
 * 固定策略（AGENTS.md 第 8 条记录的 qoder 排队问题同源：服务端要等 30 秒，
 * 而固定退避最多 8 秒 ⇒ 永远等不到）。
 */
describe('★ 上游 failure 的 status / providerRetryAfterMs / requestId 必须保真', () => {
  const makeCtx = () => ({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'buddy', name: 'b' }],
      listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: () => (async function* () {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: '上游限流',
              code: 'RATE_LIMIT',
              status: 429,
              providerRetryAfterMs: 30_000,
              requestId: 'req-abc',
            },
          },
        }
      })(),
    },
  }) as never
  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  it('★ 三个字段都要保真（尤其 providerRetryAfterMs）', async () => {
    const adapter = new AggregateAdapter(makeCtx(), { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    let caught: { code?: string; failure?: Record<string, unknown> } | undefined
    try {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    } catch (error) {
      caught = error as { code?: string; failure?: Record<string, unknown> }
    }
    expect(caught, '必须抛出').toBeDefined()
    expect(caught!.code).toBe('RATE_LIMIT')
    const failure = caught!.failure ?? {}
    expect(failure.status, 'status 必须保真（排障线索）').toBe(429)
    expect(failure.providerRetryAfterMs, '★ 服务端指定延迟的机器通道必须保真').toBe(30_000)
    expect(failure.requestId, 'requestId 必须保真（定位上游故障）').toBe('req-abc')
  })

  it('★ 畸形字段不得让 LlmError 抛校验错（按需传）', async () => {
    // ⚠️ `LlmError` 校验 status 是 ≥100 的整数、providerRetryAfterMs 有限、
    //    requestId 非空 ⇒ 传 `undefined` 会让它抛「must be …」。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              // status 畸形（<100）、requestId 空串 ⇒ 应被省略而不是传给 LlmError
              failure: { message: 'x', code: 'SERVER', status: 5, requestId: '' },
            },
          }
        })(),
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: pool, expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    let caught: { code?: string; failure?: Record<string, unknown> } | undefined
    try {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    } catch (error) {
      caught = error as { code?: string; failure?: Record<string, unknown> }
    }
    expect(caught!.code, '仍要如实抛，且不得因畸形字段变成校验错').toBe('SERVER')
    expect(caught!.failure?.status, '畸形 status 应被省略').toBeUndefined()
    expect(caught!.failure?.requestId, '空 requestId 应被省略').toBeUndefined()
  })
})

/**
 * ★★ 守卫的**盲区**：A 开 `text`、B 开 `tool-call`（真实缺陷，我自己用真实
 * `BlockAssembler` 实测发现）。
 *
 * ## 我的第一版修法只挡了一个方向
 *
 * 我按「已开的块类型」判断：开过**非 `text`** 块 ⇒ 拒绝切换；开过 `text` ⇒ 允许。
 * 但适配器**无法预知**下一个候选会开什么类型 ⇒ 若 A 开 `text`（守卫允许切换）
 * 而 B 开 `tool-call`，则 B 的 `blockType` 被 `BlockAssembler` 忽略
 *（它按 `index` 幂等、**不更新 `blockType`**）⇒ **工具调用丢失**。
 *
 * 探针（真实 `BlockAssembler`）逐字输出：
 * ```
 * A 开 text → B 开 tool-call
 * blocks = [{"type":"text","text":""}]      ← tool-call 消失，只剩空 text 块
 * ```
 *
 * ## ⇒ 正确判据：**只要开过任何块就不切换**
 *
 * 因为「下一个候选会开什么」不可预知，按类型豁免**必然有缺口**。
 * 代价是 `text→text`（实测安全）这种情形也会放弃切换 —— 但那只是**少一次重试**，
 * 而盲区的代价是**工具调用/答案丢失**。方向取安全。
 *
 * ⚠️ 这条用例锁的就是那个盲区：A 开 `text`（安全类型！）而 B 开 `tool-call`。
 */
describe('★★ 已开过任何块都不切换（含 text，因为下一个候选的类型不可预知）', () => {
  const makeTwoChannelCtx = (firstChunks: unknown[], secondChunks: unknown[]) => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string }) => {
          sent.push(options.provider)
          const chunks = options.provider === 'buddy' ? firstChunks : secondChunks
          return (async function* () {
            for (const c of chunks) yield c
            if (options.provider === 'buddy') throw new Error('A 挂了')
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider: string) => (provider === 'buddy' ? 100 : 900),
    })
    return { adapter, sent }
  }

  it('★★ A 开 text 块后失败、B 开 tool-call ⇒ **不得切换**（否则工具调用丢失）', async () => {
    const { adapter, sent } = makeTwoChannelCtx(
      // A：开一个 **text** 块（守卫的「安全类型」！）后失败
      [{ type: 'block-start', index: 0, blockType: 'text' }],
      // B：开 tool-call 块（若切换，B 的 blockType 被忽略 ⇒ 工具调用丢失）
      [{ type: 'block-start', index: 0, blockType: 'tool-call', id: 'c1', name: 'read_file' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    })()).rejects.toThrow()
    expect(sent, 'A 开过 text 块 ⇒ 不得切换（B 的类型不可预知）').toEqual(['buddy'])
  })

  it('★ 对照：A 只吐 usage（不建块）后失败 ⇒ 允许切换', async () => {
    const { adapter, sent } = makeTwoChannelCtx(
      [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } }],
      [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'ok' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    expect(sent, 'usage 不建块 ⇒ 可安全切换').toEqual(['buddy', 'codearts'])
  })
})

/**
 * ★★ 边界值不得让 `LlmError` 抛校验错（**我自己修复引入的 Critical**，独立审计实测证伪）。
 *
 * ## 讽刺之处
 * `53817bc` 这个修复的本意是「**保真**上游 failure 的 `status` / `providerRetryAfterMs` /
 * `requestId`」，但我在**按需传**的判据里重写了一遍校验，而它与 `LlmError` 的**真实**
 * 校验不一致（`dsh-llm/lib/index.js:1037-1039`，逐字）：
 *
 * | 字段 | `LlmError` 的真实校验 | 我写的判据 | 缺口 |
 * |---|---|---|---|
 * | `status` | `Number.isInteger(n) && 100 ≤ n ≤ 599` | `Number.isInteger(n) && n ≥ 100` | **缺上界 599** |
 * | `providerRetryAfterMs` | `Number.isFinite(n) && n > 0` | `Number.isFinite(n)` | **缺 `> 0`** |
 * | `requestId` | 非空字符串 | 非空字符串 | 无 |
 *
 * ⇒ `status=700` / `providerRetryAfterMs=0` 这类边界值时，`LlmError` **抛校验错**，
 * 于是**原始上游 message/code 全丢** —— 一个「保真」修复反而**在边界上丢弃**了失败。
 * 这正是本仓库首条红线（「同一语义两套判据，必有一处是错的」）的形态。
 *
 * ## 修法（判据只留一份）
 * **不再重写校验**，而是「先试带全部字段，被拒绝就退回最小集合」——
 * 判据**只有 `LlmError` 一份**，我方永不与之分叉。
 */
describe('★★ 边界值 failure 不得让 LlmError 抛校验错（否则原始失败全丢）', () => {
  const failureCtx = (failure: Record<string, unknown>) => ({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'buddy', name: 'b' }],
      listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: () => (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure } }
      })(),
    },
  }) as never
  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never

  const catchError = async (failure: Record<string, unknown>) => {
    const adapter = new AggregateAdapter(failureCtx(failure), {
      accountPool: pool,
      expiryProbe: async () => 100,
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    try {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
      return undefined
    } catch (error) {
      return error as { message?: string; code?: string; failure?: Record<string, unknown> }
    }
  }

  // ⚠️ 逐条覆盖 `LlmError` 的三个字段的**两个边界方向**。
  const cases: Array<[string, Record<string, unknown>]> = [
    ['status 超上界（700）', { message: '上游', code: 'RATE_LIMIT', status: 700 }],
    ['status 低于下界（5）', { message: '上游', code: 'RATE_LIMIT', status: 5 }],
    ['status 非整数（200.5）', { message: '上游', code: 'RATE_LIMIT', status: 200.5 }],
    ['providerRetryAfterMs 为 0', { message: '上游', code: 'RATE_LIMIT', providerRetryAfterMs: 0 }],
    ['providerRetryAfterMs 为负（-1）', { message: '上游', code: 'RATE_LIMIT', providerRetryAfterMs: -1 }],
    ['providerRetryAfterMs 为 NaN', { message: '上游', code: 'RATE_LIMIT', providerRetryAfterMs: Number.NaN }],
    ['requestId 空串', { message: '上游', code: 'RATE_LIMIT', requestId: '' }],
    ['三个字段同时畸形', {
      message: '上游', code: 'RATE_LIMIT', status: 700, providerRetryAfterMs: 0, requestId: '',
    }],
  ]

  for (const [label, failure] of cases) {
    it(`★ ${label} ⇒ 仍须如实抛「原始失败」，不得变成 LlmError 校验错`, async () => {
      const caught = await catchError(failure)
      expect(caught, '必须抛出').toBeDefined()
      // ★ 关键：错误码保真（校验错会把 code 变成 undefined / 或 message 变成校验文案）
      expect(caught!.code, 'code 必须保真').toBe('RATE_LIMIT')
      // ★ 关键：message 里必须含上游给的原因，而不是 LlmError 的校验文案
      expect(caught!.message, 'message 不得是 LlmError 的校验文案')
        .not.toMatch(/must be an integer from 100 through 599|must be a positive/)
      expect(caught!.message, 'message 必须含上游原因').toContain('上游')
    })
  }

  it('★ 合法字段仍要保真（修复不能因怕越界就把它们全丢）', async () => {
    const caught = await catchError({
      message: '上游限流', code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 30_000, requestId: 'r1',
    })
    expect(caught!.code).toBe('RATE_LIMIT')
    expect(caught!.failure?.status, '合法 status 必须保真').toBe(429)
    expect(caught!.failure?.providerRetryAfterMs, '合法延迟必须保真').toBe(30_000)
    expect(caught!.failure?.requestId, '合法 requestId 必须保真').toBe('r1')
  })

  it('★★ 一个字段畸形**不得**连累合法字段（逐字段独立回退）', async () => {
    // ⚠️ 对抗审计实测证伪的**第二版**缺陷：我曾用「试全字段、失败就退回最小集合」
    //    ⇒ **整袋回退**让合法字段陪葬。实测 `status:429 + providerRetryAfterMs:30000
    //    + requestId:''` 时，**合法的 429 与 30000ms 退避一并被丢** ——
    //    而 30000ms 正是**服务端指定退避**的机器通道（AGENTS.md 第 8 条：
    //    丢了它退避只能靠固定策略，服务端要等 30 秒而固定退避最多 8 秒 ⇒ 永远等不到）。
    const caught = await catchError({
      message: '上游限流', code: 'RATE_LIMIT',
      status: 429, providerRetryAfterMs: 30_000, requestId: '',
    })
    expect(caught!.code).toBe('RATE_LIMIT')
    expect(caught!.failure?.status, '合法 status 必须留下（不得被畸形兄弟连累）').toBe(429)
    expect(caught!.failure?.providerRetryAfterMs, '★ 合法退避必须留下').toBe(30_000)
    expect(caught!.failure?.requestId, '只有空 requestId 被丢').toBeUndefined()
  })
})

describe('★★ ensureCatalog / refreshCatalog 必须接收 signal（真实请求路径的中止）', () => {
  const makeCtx = (listModelsDelayMs = 0) => {
    const reads: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async (provider: string) => {
          reads.push(provider)
          if (listModelsDelayMs > 0) {
            await new Promise((resolve) => { setTimeout(resolve, listModelsDelayMs) })
          }
          return [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: {} }],
    } as never
    return { ctx, pool, reads }
  }

  it('★★ prepareCall 的 signal 必须串到目录读取（多渠道：第一个渠道读完后立刻中止，不读第二个）', async () => {
    // ⚠️⚠️ **真实缺陷**（独立审计实测证伪）：`ensureCatalog()` 调
    //    `this.refreshCatalog()` **不传 signal** ⇒ **真实请求路径**（`prepareCall`）
    //    的中止**完全不生效**（只有 `describeCatalog` 那条面板路径串了 signal）。
    //
    // ⚠️ **为什么判据是「第二个渠道有没有被读」而不是「耗时」**：
    //    `LlmRuntime.listModels(provider)` **只接受一个参数、没有 signal 通道**
    //   （`dsh-llm/lib/index.js:1471`），故**正在进行的**那次读取**无法中断** ——
    //    `throwIfAborted` 只能在它**返回之后**生效。
    //    我第一版断言「耗时 < 110ms（小于单次读取的 120ms）」⇒ **那个预期不可实现**，
    //    实测 132ms（读取跑完了）。改为验**循环之间的中止**：取消发生在第一个渠道
    //    读取期间 ⇒ 第二个渠道**不应被读**（这才是 signal 串下去后真正带来的收益）。
    const reads: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => {
          reads.push(provider)
          // ⚠️ 第一个被读的渠道是 `codearts`（`AGGREGATE_CHANNELS` 的**固定顺序**里
          //    它在 `buddy` 之前）—— 我第一版写死「先读 buddy」是错的（隐含假设了
          //    `listProviders()` 的顺序）。这里改成「**第一个被读的**慢、其余的立即返回」，
          //    不依赖具体是哪个渠道。
          await new Promise((resolve) => {
            setTimeout(resolve, reads.length === 1 ? 120 : 1)
          })
          return [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: {} }],
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool, expiryProbe: async () => 100,
    })
    const controller = new AbortController()
    const pending = adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash', controller.signal)
    // 在第一个渠道读取期间取消
    setTimeout(() => { controller.abort() }, 20)
    let threw = false
    try {
      await pending
    } catch (error) {
      threw = true
      expect((error as { name?: string }).name, '必须是 AbortError').toBe('AbortError')
    }
    expect(threw, '必须中止（不得静默成功）').toBe(true)
    // ★ 关键：只读了**第一个**渠道 —— 说明 signal 串到了目录循环，
    //   取消在循环之间生效（修复前**所有**渠道都会被读完）。
    //   ⚠️ 不写死渠道名（顺序由 `AGGREGATE_CHANNELS` 决定，不该在用例里复制）。
    expect(reads.length, '取消后不得继续读后续渠道').toBe(1)
  })

  it('★ 中止不得把截断目录写进缓存（下次调用必须重新读）', async () => {
    const { ctx, pool, reads } = makeCtx(120)
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool, expiryProbe: async () => 100,
    })
    const controller = new AbortController()
    const pending = adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash', controller.signal)
    // ⚠️ 在读取**进行中**取消 ⇒ 读取跑完后 `throwIfAborted` 生效、中止逃逸，
    //    且**不得**把截断目录写进缓存。
    setTimeout(() => { controller.abort() }, 20)
    await pending.catch(() => undefined)
    const before = reads.length
    // 再调一次（不取消）⇒ 必须重新读目录（而非用被中止的截断结果）
    await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(reads.length, '中止后必须重新读目录（catalogAt 不得被写）').toBeGreaterThan(before)
  })
})

describe('★★ 收到 block-end 后失败 ⇒ 不得切换（由 `emitted` 拦住，不是 `openedBlocks`）', () => {
  const makeTwoChannelCtx = (firstChunks: unknown[], secondChunks: unknown[]) => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (options: { provider: string }) => {
          sent.push(options.provider)
          const chunks = options.provider === 'buddy' ? firstChunks : secondChunks
          return (async function* () {
            for (const c of chunks) yield c
            if (options.provider === 'buddy') throw new Error('A 挂了')
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (provider: string) => (provider === 'buddy' ? 100 : 900),
    })
    return { adapter, sent }
  }

  it('★ A 开块并**闭合**后失败 ⇒ 不得切换（但拦它的是 `emitted`，不是 `openedBlocks`）', async () => {
    // ⚠️⚠️ **本条我写错过两次，如实记录**：
    //
    // ① 我原以为「闭合后 index 不再被占用 ⇒ 守卫可以放行」，探针（真实
    //    `BlockAssembler`）证伪了这个**前提**：
    //    ```
    //    A 开 text(0) → A 闭合 text(0) → B 开 tool-call(0)
    //    blocks   = [{"type":"text","text":""}]          ← 工具调用丢失
    //    partials = [[0,{blockType:'text',…,block:{…}}]] ← index 0 **仍在**
    //    ```
    //    `block-end` 只往 partial 上挂 `block` 字段、**不删** `partials` 条目。
    //
    // ② 但**本用例实际拦它的是 `emitted`，不是 `openedBlocks`**：
    //    `isVisibleContent` 只排除 `block-start` / `usage`
    //    ⇒ `block-end` **算可见内容** ⇒ 收到它时 `emitted` 已置真
    //    ⇒ 由「已吐内容不切换」那条守卫拦住。
    //    这是**反向验证发现的**：我故意让 `block-end` 清掉 `openedBlocks`，
    //    79 条**仍全绿** ⇒ 证明 `openedBlocks` 在本场景**不参与判定**。
    //    ⇒ 标题与结论都订正为真实机制（我第三次犯「断言测的不是它声称的那条路径」）。
    //
    // ⚠️ `block-end` 的形状是 `{ index, block: {...} }`（不是只有 index）——
    //    我第一版写 `{type:'block-end', index:0}` 时，真实 `BlockAssembler`
    //    在读 `chunk.block.type` 时**抛 TypeError**（探针实测）。
    const { adapter, sent } = makeTwoChannelCtx(
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
      ],
      [{ type: 'block-start', index: 0, blockType: 'tool-call', id: 'c1', name: 'read_file' }],
    )
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect((async () => {
      for await (const _ of call.stream({ messages: [] } as never)) { /* drain */ }
    })()).rejects.toThrow()
    expect(sent, 'block-end 算可见内容 ⇒ emitted 拦住切换').toEqual(['buddy'])
  })
})

describe('★★ 上下文窗口：候选集的**最大值**（真实缺陷：曾写死 200_000）', () => {
  /**
   * 造一个可控的 ctx：每个 (provider, realId) 声明自己的窗口。
   *
   * ⚠️ 计数 `infoCalls` 是**必需的**（不是顺手加的）：本组有一条用例锁
   * 「`buildModelCatalog` 式的逐模型调用不得扇出重复解析」—— 那是这次改动
   * 引入的真实风险（`resolveModel` 从纯同步变成要读候选能力）。
   */
  function makeWindowCtx(
    catalogs: Record<string, Array<{ id: string; name?: string }>>,
    windows: Record<string, number | undefined>,
    infoCalls: { count: number },
  ) {
    return {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => Object.keys(catalogs).map((id) => ({ id, name: id })),
        listModels: async (provider: string) => catalogs[provider] ?? [],
        resolveModelInfo: async (provider: string, id: string) => {
          infoCalls.count += 1
          const window = windows[`${provider}/${id}`]
          return {
            provider,
            id,
            ...window === undefined ? {} : { context: { contextWindow: window } },
          }
        },
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
  }

  it('★ 取候选里**最大**的窗口（不是最小值、不是写死的 200K）', async () => {
    // ⚠️ 真实缺陷（用户报障 2026-10-07）：「聚合 provider 中的 deepseek v4.1 flash
    //    模型只有 200k 上下文」。根因是 `resolveModel` 把 `contextWindow: 200_000`
    //    **硬编码**给所有虚拟模型，而同一个模型直连 buddy / codearts 声明的都是 1M
    //    （`product.ts` 的兜底表、`llm-adapter.ts` 的 `CONTEXT_WINDOWS`）。
    //
    // 候选故意放三条、窗口**彼此不同**（含一条未声明窗口的），这样「取大」「取小」
    // 「取交集」「取第一条」四种实现会给出**四种不同结果**：
    //   取大 = 1_000_000 ｜ 取小 = 131_072 ｜ 取第一条 = 262_144 ｜ 写死 = 200_000
    const infoCalls = { count: 0 }
    const adapter = new AggregateAdapter(makeWindowCtx(
      {
        buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        codearts: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }],
        lobsterai: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
      },
      {
        'buddy/deepseek-v4.1-flash': 1_000_000,
        'codearts/deepseek-v4.1-flash': 262_144,
        'lobsterai/deepseek-flash': undefined,
      },
      infoCalls,
    ), { accountPool: makePool() })

    // ⚠️ 目录必须先落地：2026-10-18 起「目录为空 ⇒ `resolveModel` 立刻回保守元数据」
    //    （`coldModelInfo`，窗口是 `AGGREGATE_COLD_CONTEXT_WINDOW`）⇒ 冷帧下本组
    //    用例测的会是「兜底常量」而不是「候选集取大」，全部失去判别力。
    await warmCatalog(adapter)
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(info.context?.contextWindow).toBe(1_000_000)
    // 对照：候选确实有三条（否则上面那条断言可能只是「只有一个候选」的巧合）。
    const candidates = (adapter as unknown as {
      catalog: Array<{ key: string; candidates: unknown[] }>
    }).catalog.find((m) => m.key === 'deepseek-v4-1-flash')!.candidates
    expect(candidates).toHaveLength(3)
  })

  it('★ 一个候选的窗口都取不到 ⇒ 用兜底值（不得返回 undefined，否则 DSH 抛 TargetPressureConfigError）', async () => {
    // ⚠️ `dsh-compaction-basic/lib/index.js` 在 `info.context === undefined` 时**抛**
    //    `TargetPressureConfigError: no context capacity for …; configure contextWindow
    //    on that adapter model`。即兜底值不是可选的美化，是**契约**。
    const infoCalls = { count: 0 }
    const adapter = new AggregateAdapter(makeWindowCtx(
      { buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }] },
      { 'buddy/deepseek-v4.1-flash': undefined },
      infoCalls,
    ), { accountPool: makePool() })

    await warmCatalog(adapter)
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(info.context?.contextWindow).toBe(200_000)
    // 必须是**正整数**（DSH 的 `normalizeModelInfo` 逐字校验，非法即 INVALID_MODEL_CONTEXT）。
    expect(Number.isInteger(info.context!.contextWindow)).toBe(true)
    expect(info.context!.contextWindow).toBeGreaterThan(0)
  })

  it('★ `auto` 也按整池取大（不得因走特殊分支而漏掉/写死）', async () => {
    const infoCalls = { count: 0 }
    const adapter = new AggregateAdapter(makeWindowCtx(
      {
        buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        codearts: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
      },
      {
        'buddy/deepseek-v4.1-flash': 1_000_000,
        'codearts/glm-5.3': 202_752,
      },
      infoCalls,
    ), { accountPool: makePool() })

    await warmCatalog(adapter)
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'auto')
    expect(info.context?.contextWindow).toBe(1_000_000)
  })

  it('★ 能力解析不重复扇出：逐模型调 resolveModel 时每个候选只解析一次', async () => {
    // ⚠️ 这是本次改动**引入的**风险，不是既有行为：`resolveModel` 从纯同步变成
    //    要读候选能力，而 DSH 的 `buildModelCatalog` 会对目录里**每个模型**各调一次
    //    （`dsh-api-session-controller/lib/index.js:506`）⇒ 没有缓存时「打开一次模型
    //    选择器」会对同一批候选反复解析。
    const infoCalls = { count: 0 }
    const adapter = new AggregateAdapter(makeWindowCtx(
      {
        buddy: [
          { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
          { id: 'glm-5.3', name: 'GLM-5.3' },
        ],
        codearts: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }],
      },
      {
        'buddy/deepseek-v4.1-flash': 1_000_000,
        'buddy/glm-5.3': 202_752,
        'codearts/deepseek-v4.1-flash': 262_144,
      },
      infoCalls,
    ), { accountPool: makePool() })

    // 模拟 `buildModelCatalog`：先 listModels，再对每个模型 resolveModel。
    // ⚠️ Task 7 之后 `listModels` 冷调**不再同步扇出** ⇒ 必须先让目录落地，
    //    否则下面逐模型 `resolveModel` 全走冷帧、`infoCalls` 恒为 0（用例恒绿/恒红）。
    await warmCatalog(adapter)
    const listed = await adapter.listModels(AGGREGATE_PROVIDER)
    for (const model of listed) await adapter.resolveModel(AGGREGATE_PROVIDER, model.id)

    // 3 个唯一候选（buddy×2 + codearts×1）⇒ 恰好 3 次解析。
    // ⚠️ 断言上界而非等号会漏掉「重复解析」这类缺陷的方向，但用等号又太脆
    //    （将来加候选会假失败）⇒ 用**唯一候选数**这个稳定上界，并同时断言
    //    「第二次全量遍历不再新增调用」（那才是缓存是否生效的判据）。
    expect(infoCalls.count).toBe(3)
    for (const model of listed) await adapter.resolveModel(AGGREGATE_PROVIDER, model.id)
    expect(infoCalls.count, '第二次遍历必须全部命中缓存').toBe(3)
  })

  it('★ 目录重建后窗口缓存必须失效（候选集变了 ⇒ 最大值可能变）', async () => {
    // ⚠️ 若缓存不随目录失效，用户登录一个窗口更大的渠道后，聚合仍会按**旧候选集**
    //    声明的窗口运行 —— 界面与压缩阈值长期错误（正是本次修的缺陷形态）。
    const infoCalls = { count: 0 }
    const catalogs: Record<string, Array<{ id: string; name?: string }>> = {
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
    }
    const windows: Record<string, number | undefined> = { 'buddy/deepseek-v4.1-flash': 200_000 }
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => Object.keys(catalogs).map((id) => ({ id, name: id })),
        listModels: async (provider: string) => catalogs[provider] ?? [],
        resolveModelInfo: async (provider: string, id: string) => {
          infoCalls.count += 1
          const window = windows[`${provider}/${id}`]
          return {
            provider,
            id,
            ...window === undefined ? {} : { context: { contextWindow: window } },
          }
        },
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool() })

    await warmCatalog(adapter)
    // ① 只有 buddy（200K）⇒ 声明 200K。
    expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
      .toBe(200_000)

    // ② 用户新登录 codearts（1M）⇒ 强制重推目录（`force = true`，与面板刷新同路径）。
    catalogs.codearts = [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]
    windows['codearts/deepseek-v4.1-flash'] = 1_000_000
    await adapter.refreshCatalog(true)

    // ③ 窗口必须跟着变成 1M（缓存失效的判据）。
    expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
      .toBe(1_000_000)
  })

  it('★ 退化判决只活 30 秒：到期后上游恢复必须能拿到真值（不得固化成 60 秒）', async () => {
    // ⚠️ 与 `AGENTS.md` 的「`refreshable` 单向门」同一形态：把**这一次**没问出来的
    //    结果缓存住太久，会让瞬时故障变成持续错误。
    //    ⚠️⚠️ 但**完全不缓存**同样是缺陷（用户 2026-10-20 报障）：候选池里只要有一个
    //    渠道持续故障，每一轮请求都要重试它并等满超时（实测 8–16 秒/轮）。
    //    ⇒ 现行契约：退化判决**也**记忆化，但只活
    //    `AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS`（30 秒），远短于目录 TTL。
    let fail = true
    let calls = 0
    let fakeNow = 1_000
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => {
          calls += 1
          if (fail) throw new Error('目录服务抖动')
          return { provider, id, context: { contextWindow: 1_000_000 } }
        },
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), now: () => fakeNow })

    await warmCatalog(adapter)
    // ① 抖动期间 ⇒ 兜底值。
    expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
      .toBe(200_000)

    // ② 上游恢复，但**还没到**退化 TTL ⇒ 仍复用退化判决（这一条正是修复的收益：
    //    不必每一轮都去重试那个坏候选）。
    fail = false
    const before = calls
    expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
      .toBe(200_000)
    expect(calls, '退化判决有效期内不得重新解析候选').toBe(before)

    // ③ 推过退化 TTL ⇒ 必须重新解析并采信真值。
    //    ⚠️ 这里**不能**靠 `refreshCatalog` 清缓存（那会掩盖缺陷）——
    //    必须证明「同一份目录下，TTL 一过就能拿到真值」。
    fakeNow += 30_001
    expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
      .toBe(1_000_000)
  })

  it('★ 候选窗口能取到时，不因**另一个**候选解析失败而记忆化兜底值', async () => {
    // ⚠️ 与上一条同型但更隐蔽的第二面：窗口缓存的键是**虚拟模型**，与「哪个候选
    //    失败了」无关 ⇒ 若失败时把**兜底值**写进缓存，**一个**候选的瞬时故障会污染
    //    整个虚拟模型的声明值。这里让 codearts 一直失败、buddy 正常（1M）：
    //    第一次就该给出 1M（可用候选的窗口），而不是 200K 兜底值。
    let codeartsFails = true
    let fakeNow = 1_000
    const windows: Record<string, number | undefined> = {
      'buddy/deepseek-v4.1-flash': 1_000_000,
      'codearts/deepseek-v4.1-flash': 2_000_000,
    }
    let calls = 0
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'codearts', name: 'c' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => {
          calls += 1
          if (provider === 'codearts' && codeartsFails) throw new Error('目录服务抖动')
          const window = windows[`${provider}/${id}`]
          return {
            provider,
            id,
            ...window === undefined ? {} : { context: { contextWindow: window } },
          }
        },
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), now: () => fakeNow })

    await warmCatalog(adapter)
    // ① codearts 抖动 ⇒ 用可用候选里的最大值（buddy 的 1M），不是兜底的 200K。
    expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
      .toBe(1_000_000)

    // ② codearts 恢复，但退化 TTL 未到 ⇒ 仍是 1M（退化判决有效期内不重试）。
    codeartsFails = false
    expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
      .toBe(1_000_000)

    // ③ 推过退化 TTL ⇒ 必须重试并采信 codearts 更大的窗口。
    fakeNow += 30_001
    const before = calls
    expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
      .toBe(2_000_000)
    expect(calls, '必须重新解析候选，而不是复用「失败时算出的」结果').toBeGreaterThan(before)
  })

  it('★★ 候选能力必须**并发**解析（串行时总耗时是全部候选之和）', async () => {
    // ⚠️ 用户报障 2026-10-20：`aggregate/deepseek-v4-1-flash` 的候选池有 13 家，
    //    串行解析时总耗时 = 各候选之和；其中一家（实测 autoclaw）在 DNS/TCP 层挂住
    //    就把整轮拖满。本用例用「8 家各 60ms」把串行与并发区分开：
    //    串行 ⇒ ≥480ms；并发 ⇒ ≈60ms。峰值在飞数是最稳的判据（不受机器快慢影响）。
    const PROVIDERS = ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline']
    const DELAY = 60
    let inFlight = 0
    let peak = 0
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => PROVIDERS.map((id) => ({ id, name: id })),
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, DELAY))
          inFlight -= 1
          return { provider, id, context: { contextWindow: 1_000_000 } }
        },
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool() })

    await warmCatalog(adapter)
    const startedAt = Date.now()
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const elapsed = Date.now() - startedAt

    expect(info.context?.contextWindow).toBe(1_000_000)
    expect(peak, '候选之间必须并发（峰值在飞数应等于候选数）').toBe(PROVIDERS.length)
    expect(elapsed, '并发时总耗时约等于单个候选的耗时，而不是它们的和').toBeLessThan(DELAY * 4)
  })

  it('★★ `candidatesFor`（发消息那条路径）也必须并发解析候选能力', async () => {
    // ⚠️⚠️ 上一條只守 `resolveModel → contextWindowFor`。PR 的**根因分析点名了
    //    `candidatesFor` 也在串行**，但首版只改了 `contextWindowFor` ⇒
    //    **修了一半**：`prepareCall`（真实发消息路径）仍按「候选数 × 预算」累加。
    //
    // 实测（`capabilityTimeoutMs: 100`、13 个候选全挂）：
    //   串行 `prepareCall` = **761 ms** / 并发 = **101 ms**（7.5 倍差）。
    //
    // 本用例用「8 家各 60ms」把两者分开，判据用**峰值在飞数**（不受机器快慢影响）
    // 而不是耗时 —— 耗时断言在 CI 上会 flaky。
    const PROVIDERS = ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline']
    const DELAY = 60
    let inFlight = 0
    let peak = 0
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => PROVIDERS.map((id) => ({ id, name: id })),
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, DELAY))
          inFlight -= 1
          return { provider, id, context: { contextWindow: 1_000_000 } }
        },
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      // ⚠️ 不注入 `expiryProbe` 时全部候选折算成 `UNUSABLE` ⇒ `candidatesFor`
      //    返回空表、循环一次都不跑 ⇒ 本用例会**恒真**。必须给 `NEVER`（可用）。
      expiryProbe: async () => Number.POSITIVE_INFINITY,
    })

    await adapter.refreshCatalog()
    // ⚠️ 直接测 `candidatesFor`（绕开 `contextWindowFor` 先把 `capabilityCache`
    //    填满的遮蔽 —— 那会让本用例的峰值恒为 1、无论 `candidatesFor` 是否并发）。
    const internal = adapter as unknown as {
      capabilityCache: Map<string, unknown>
      candidatesFor: (model: string) => Promise<unknown[]>
    }
    internal.capabilityCache.clear()
    peak = 0
    const startedAt = Date.now()
    const targets = await internal.candidatesFor('deepseek-v4-1-flash')
    const elapsed = Date.now() - startedAt

    expect(targets.length, '必须有候选，否则本用例是同义反复').toBeGreaterThan(1)
    // ⚠️ 判据写成「峰值 == 候选数」而不是「峰值 == PROVIDERS.length」：
    //    实际候选数受 `gateOf`（未接入临期折算的渠道默认不参与）+ `maxAttemptsFor`
    //    封顶影响，实测这里是 5 而不是 8。写死 8 会变成一条**与并发无关**的红。
    //    而「峰值 == 候选数」正好把串行/并发分开：串行时峰值**恒为 1**。
    expect(peak, '`candidatesFor` 的候选解析必须并发（串行时峰值恒为 1）').toBe(targets.length)
    expect(elapsed, '并发时总耗时约等于单个候选的耗时').toBeLessThan(DELAY * 4)
  })

  it('★★ 单个候选的解析有独立预算：一家挂住不得拖满整轮', async () => {
    // ⚠️ 用户报障 2026-10-20：autoclaw 的目录端点 ETIMEDOUT 21.6 秒，而它自己的
    //    8 秒 `AbortController` 管不到 DNS/TCP 层 ⇒ 每轮请求都白等。
    //    ⇒ `capabilityOf` 必须有**自己的**预算（默认 3 秒），不能等渠道自己的超时。
    //    这里注入 40ms 预算 + 一个永不 resolve 的候选，断言整轮在预算量级内结束。
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'autoclaw', name: 'a' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => {
          // ⚠️ autoclaw 永不 resolve（模拟 DNS/TCP 层挂死，AbortController 管不到）。
          if (provider === 'autoclaw') return new Promise(() => {})
          return { provider, id, context: { contextWindow: 1_000_000 } }
        },
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const BUDGET = 40
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      capabilityTimeoutMs: BUDGET,
    })

    await warmCatalog(adapter)
    const startedAt = Date.now()
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    const elapsed = Date.now() - startedAt

    // ① 预算内结束（不是无限等待）。
    //
    // ⚠️⚠️ **阈值必须贴着注入的预算写，不能写成 `toBeLessThan(2_000)`**
    //    （2026-10-20 变异实测：本用例第一版就是这么写的，把生产默认
    //    `AGGREGATE_CAPABILITY_TIMEOUT_MS` 从 3_000 改成 **60_000** 之后
    //    **全部 138 条用例仍绿** —— 因为 stub 的 `new Promise(() => {})` 在
    //    `controller.abort()` 之后…… 其实**根本不响应 abort**，所以真正让它
    //    在 2 秒内结束的是**注入的 40ms 预算**；那条断言只是「40ms < 2000ms」
    //    的同义反复，对**生产默认值**零判别力）。
    //    ⇒ 判据锚在注入值上（`BUDGET * 4`，留足调度抖动），这条用例才真的
    //    在「预算被调大」时变红。
    expect(elapsed, '挂住的候选必须在**注入的预算**量级内被放弃').toBeLessThan(BUDGET * 4)
    // ② 结论仍取**已解析成功**那部分的最大值，不退化成兜底值。
    expect(info.context?.contextWindow).toBe(1_000_000)
  })

  it('★★ 生产默认预算的值本身必须有守卫（3 秒量级，不是 60 秒）', async () => {
    // ⚠️ 上一条注入 `capabilityTimeoutMs` ⇒ 它守的是**机制**，不是**取值**。
    //    而 PR 的变异表写着「单候选预算改 60 秒 ⇒ 1 条红」，实测（138 条 + 142 条）
    //    **全绿** —— 那句声明当时不成立（阈值是同义反复）。本用例补上**取值**守卫：
    //    默认预算必须与「一次健康解析的量级」（100–800ms）同数量级，
    //    且必须远小于目录 TTL（否则一个坏候选就能吃掉整轮）。
    expect(AGGREGATE_CAPABILITY_TIMEOUT_MS,
      '单个候选的解析预算必须是 3 秒量级；改成 60 秒会让一个坏候选吃掉整轮请求').toBe(3_000)
    expect(AGGREGATE_CAPABILITY_TIMEOUT_MS,
      '预算必须显著小于目录 TTL').toBeLessThan(AGGREGATE_CATALOG_TTL_MS)
    expect(AGGREGATE_CAPABILITY_FAILURE_TTL_MS,
      '失败短缓存必须短于目录 TTL（否则瞬时故障被固化成持续状态）')
      .toBeLessThan(AGGREGATE_CATALOG_TTL_MS)
    expect(AGGREGATE_CONTEXT_WINDOW_DEGRADED_TTL_MS)
      .toBeLessThan(AGGREGATE_CATALOG_TTL_MS)
  })

  it('★★ 窗口推导必须**去重 + 封顶**（否则 `auto` 全池扇出、同一候选被重复解析）', async () => {
    // ⚠️⚠️ 两条独立的放大面（2026-10-20 独立审计实测）：
    //
    // ① **无封顶**：`autoCandidates()` 是全池（实测 1–2 百条），而 `candidatesFor`
    //    有 `ranked.slice(0, limit)`（`maxAttemptsFor`）。窗口路径原先一条都没有
    //    ⇒ 一次 `auto` 就把全池同时打给 `resolveModelInfo`；
    // ② **无在飞合并**：`capabilityCache` 在 `await` **之后**才写 ⇒ 同一拍的重复询问
    //    全部穿透。实测「41 个虚拟模型并行」时单候选被解析 **2** 次。
    //
    // 本用例同时钉住两条：
    // - `peak <= maxAttemptsFor(catalog)`（封顶生效）
    // - 每个 `provider\0realId` 只被调用一次（去重生效）
    const PROVIDERS = ['codearts', 'buddy', 'workbuddy', 'qoder', 'trae']
    const PER_PROVIDER = 30
    let inFlight = 0
    let peak = 0
    const perKey = new Map<string, number>()
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => PROVIDERS.map((id) => ({ id, name: id })),
        listModels: async () => Array.from({ length: PER_PROVIDER }, (_v, i) => ({ id: `m${i}`, name: `M${i}` })),
        resolveModelInfo: async (provider: string, id: string) => {
          const key = `${provider}\u0000${id}`
          perKey.set(key, (perKey.get(key) ?? 0) + 1)
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 2))
          inFlight -= 1
          return { provider, id, context: { contextWindow: 1_000_000 } }
        },
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool() })
    await adapter.refreshCatalog(true)
    const catalog = await adapter.refreshCatalog()
    const cap = maxAttemptsFor(catalog)
    const poolSize = PROVIDERS.length * PER_PROVIDER

    perKey.clear()
    peak = 0
    // ⚠️ 先清能力缓存，否则第一次 `listModels` 可能已把候选解析过（本用例就恒真了）。
    ;(adapter as unknown as { capabilityCache: Map<string, unknown> }).capabilityCache.clear()
    await adapter.resolveModel(AGGREGATE_PROVIDER, 'auto')

    expect(poolSize, '前提：全池必须远大于封顶（否则本用例测不到截断）').toBeGreaterThan(cap * 2)
    expect(peak, `窗口推导必须封顶到 maxAttemptsFor(${cap})，实测 ${peak}`).toBeLessThanOrEqual(cap)
    const duplicates = [...perKey.values()].filter((count) => count > 1)
    expect(duplicates, '同一候选在一次窗口推导里不得被重复解析').toHaveLength(0)
  })

  it('★★ **跨虚拟模型并行**时同一候选也不得被重复解析（在飞合并）', async () => {
    // ⚠️⚠️ 上一条只能测到「单个虚拟模型内部」的去重（`Map` 已按 key 收敛）。
    //    而真实放大面在**跨模型**：宿主 `buildModelCatalog` 对每个虚拟模型并行
    //    `resolveModelInfo`，同一个 realId 常常同时挂在多个虚拟模型下
    //    ⇒ `capabilityCache` 在 `await` 之后才写、挡不住同一拍。
    //
    // 实测：修前「4 个虚拟模型并行 ⇒ 4 个候选重复、最大重复 2」；修后在飞合并
    //（`capabilityInFlight`）后 ⇒ 重复 0、最大重复 1。
    // ⚠️ 变异：删掉 `capabilityInFlight` 的「查表复用」两行 ⇒ 本用例必红（上一条仍绿）。
    const PROVIDERS = ['codearts', 'buddy', 'workbuddy', 'qoder', 'trae']
    const perKey = new Map<string, number>()
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => PROVIDERS.map((id) => ({ id, name: id })),
        listModels: async () => [
          { id: 'shared-a', name: 'A' },
          { id: 'shared-b', name: 'B' },
          { id: 'shared-c', name: 'C' },
        ],
        resolveModelInfo: async (provider: string, id: string) => {
          const key = `${provider}\u0000${id}`
          perKey.set(key, (perKey.get(key) ?? 0) + 1)
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { provider, id, context: { contextWindow: 1_000_000 } }
        },
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool() })
    await adapter.refreshCatalog(true)
    const models = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(models.length, '必须有多个虚拟模型，否则测不到跨模型并行').toBeGreaterThan(2)

    perKey.clear()
    ;(adapter as unknown as { capabilityCache: Map<string, unknown> }).capabilityCache.clear()
    // 宿主真实形态：并行
    await Promise.all(models.map((model) =>
      adapter.resolveModel(AGGREGATE_PROVIDER, model.id).catch(() => undefined)))

    const duplicates = [...perKey.entries()].filter(([, count]) => count > 1)
    expect(duplicates, `同一候选不得被并发重复解析：${JSON.stringify(duplicates)}`).toHaveLength(0)
  })

  it('★★ 坏候选进 30 秒失败短缓存：TTL 内不再重复等它超时', async () => {
    // ⚠️ 与上一条配对：只加预算不记失败 ⇒ 每轮仍白等一次预算（实测 8 秒/轮）。
    //    本用例断言「同一 TTL 内第二次**不再调用**那个坏候选」。
    let badCalls = 0
    let fakeNow = 1_000
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'autoclaw', name: 'a' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => {
          if (provider === 'autoclaw') {
            badCalls += 1
            throw new Error('目录服务抖动')
          }
          return { provider, id, context: { contextWindow: 1_000_000 } }
        },
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      now: () => fakeNow,
      // ⚠️ 窗口缓存的退化判决也是 30 秒 —— 两条路径都验证「不再重复解析」。
      contextWindowDegradedTtlMs: 30_000,
    })

    await warmCatalog(adapter)
    expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
      .toBe(1_000_000)
    const afterFirst = badCalls
    expect(afterFirst, '第一次必须真的问过那个坏候选').toBeGreaterThan(0)

    // ② 直接问那个坏候选（绕开窗口缓存，只测失败短缓存本身）。
    expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
      .toBe(1_000_000)
    expect(badCalls, 'TTL 内的重复询问不得再打那个坏候选').toBe(afterFirst)

    // ③ 推过失败 TTL ⇒ 必须重新尝试（上游恢复后要能纠正）。
    fakeNow += 30_001
    await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    expect(badCalls, '失败 TTL 到期后必须重新解析').toBeGreaterThan(afterFirst)
  })

  it('★ 源码守卫：聚合适配器里不得再出现写死的 200_000 窗口', async () => {
    // ⚠️ 这条防的是「把兜底常量直接塞回 resolveModel」这类回退。允许的形式只有
    //    `AGGREGATE_FALLBACK_CONTEXT_WINDOW` 这一个**具名常量**。
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../src/aggregate-adapter.ts', import.meta.url), 'utf8',
    ))
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // 常量定义那一处是合法的；其余任何 `contextWindow: 200_000` / `200_000` 都不许。
    expect(code).not.toMatch(/contextWindow:\s*200_000/)
    expect(code).not.toMatch(/contextWindow:\s*AGGREGATE_FALLBACK_CONTEXT_WINDOW/)
  })

  /**
   * ★★★ 失败短缓存的**独立**判别力（2026-10-20 变异测试补的缺口）。
   *
   * 上面那条「坏候选进 30 秒失败短缓存」走的是 `resolveModel` → `contextWindowFor`，
   * 而 `contextWindowFor` 自己也会把退化判决记忆化 ⇒ **两个缓存互相遮蔽**：
   * 只删 `capabilityFailureCache.set(...)` 时它仍绿（变异 1 曾实测「仍绿」）。
   *
   * 本组用例把两条路径**分别**钉死，任一条单独失效都会红：
   * - `candidatesFor` 里逐候选 `capabilityOf`（不走 `contextWindowFor`）
   * - `contextWindowFor` 的退化记忆化（把失败短缓存关掉也能独立工作）
   */
  describe('★★★ 失败短缓存的独立判别力（两个缓存不得互相遮蔽）', () => {
    /** 造一个双渠道世界：`autoclaw` 恒定失败，`buddy` 正常。 */
    const makeBadWorld = () => {
      const state = { badCalls: 0, fakeNow: 1_000 }
      const ctx = {
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        llm: {
          listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'autoclaw', name: 'a' }],
          listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
          resolveModelInfo: async (provider: string, id: string) => {
            if (provider === 'autoclaw') {
              state.badCalls += 1
              throw new Error('目录服务抖动')
            }
            return { provider, id, context: { contextWindow: 1_000_000 } }
          },
          stream: () => { throw new Error('本用例不应调用 stream') },
        },
      } as never
      return { state, ctx }
    }

    it('★★ `candidatesFor` 路径：失败短缓存 TTL 内不得重复解析坏候选', async () => {
      // ⚠️ 这条**不经过** `contextWindowFor`，故只可能由 `capabilityFailureCache` 兜住。
      //    删掉 `capabilityFailureCache.set(key, now)` ⇒ 本用例必红。
      //
      // ⚠️⚠️ **不能靠推进时间让选型缓存失效**：`AGGREGATE_TTL_MS`（60 秒）本来就比
      //    失败短缓存（30 秒）长，推过 60 秒时失败记录必然也过期 —— 那样测不到东西。
      //    正确手法是 `clearChoiceCache()`（RPC 清缓存的真实路径），只让选型缓存失效。
      const { state, ctx } = makeBadWorld()
      const adapter = new AggregateAdapter(ctx, {
        accountPool: makePool(),
        expiryProbe: async () => Number.POSITIVE_INFINITY,
        now: () => state.fakeNow,
      })
      await warmCatalog(adapter)

      await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      const afterFirst = state.badCalls
      expect(afterFirst, '第一次必须真的问过那个坏候选').toBeGreaterThan(0)

      // 只清选型缓存（失败记录仍在 30 秒窗口内）⇒ 必须重建候选序，
      // 但重建时**不得**再打那个坏候选。
      adapter.clearChoiceCache()
      state.fakeNow += 5_000
      await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      expect(state.badCalls, '失败短缓存 TTL 内不得再打那个坏候选').toBe(afterFirst)

      // 推过失败短缓存 ⇒ 必须重试（上游恢复后要能纠正）。
      adapter.clearChoiceCache()
      state.fakeNow += 30_001
      await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      expect(state.badCalls, '失败短缓存到期后必须重新解析').toBeGreaterThan(afterFirst)
    })

    it('★★ `contextWindowFor` 路径：关掉失败短缓存也能靠退化记忆化兜住', async () => {
      // ⚠️ 这条把 `capabilityFailureTtlMs` 设成 0（等价于禁用失败短缓存），
      //    验证「退化判决也记忆化」这条独立防线确实在工作。
      //    把 `contextWindowCache.set(...)` 改回「全成功才写」⇒ 本用例必红。
      const { state, ctx } = makeBadWorld()
      const adapter = new AggregateAdapter(ctx, {
        accountPool: makePool(),
        expiryProbe: async () => Number.POSITIVE_INFINITY,
        now: () => state.fakeNow,
        capabilityFailureTtlMs: 0,
        contextWindowDegradedTtlMs: 30_000,
      })
      await warmCatalog(adapter)

      expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
        .toBe(1_000_000)
      const afterFirst = state.badCalls

      // 失败短缓存已禁用 ⇒ 唯一能拦住重复解析的就是退化记忆化。
      state.fakeNow += 10_000
      await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      expect(state.badCalls, '退化记忆化必须拦住重复解析（失败短缓存已关）').toBe(afterFirst)

      // 推过退化 TTL ⇒ 必须重试并采信真值（上游恢复后要能纠正）。
      state.fakeNow += 30_001
      await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      expect(state.badCalls, '退化 TTL 到期后必须重新解析').toBeGreaterThan(afterFirst)
    })

    it('★★ 上游恢复后能拿到真值（成功写入后失败记录不再生效）', async () => {
      // ⚠️ 本条**不**声称在测「成功即清失败记录」——变异测试实测：
      //    删掉 `capabilityFailureCache.delete(key)` 本用例仍绿，因为
      //    `capabilityCache` 在 `capabilityOf` 开头就先查，成功写入后失败记录
      //    再也不会被读到。那条 `delete` 是防御性的（见源码注释），没有独立判别力。
      //
      // 本条真正钉的是**用户可见的契约**：上游恢复后，推过失败短缓存就能拿到真值。
      let broken = true
      let badCalls = 0
      let fakeNow = 1_000
      const ctx = {
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        llm: {
          listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'autoclaw', name: 'a' }],
          listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
          resolveModelInfo: async (provider: string, id: string) => {
            if (provider === 'autoclaw') {
              badCalls += 1
              if (broken) throw new Error('目录服务抖动')
              return { provider, id, context: { contextWindow: 2_000_000 } }
            }
            return { provider, id, context: { contextWindow: 1_000_000 } }
          },
          stream: () => { throw new Error('本用例不应调用 stream') },
        },
      } as never
      const adapter = new AggregateAdapter(ctx, {
        accountPool: makePool(),
        expiryProbe: async () => Number.POSITIVE_INFINITY,
        now: () => fakeNow,
        // 退化 TTL 设 0 ⇒ 每次 `contextWindowFor` 都重算，逼它去问 `capabilityOf`。
        contextWindowDegradedTtlMs: 0,
      })
      await warmCatalog(adapter)

      // ① 坏着问一次 ⇒ 失败记录落盘。
      await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      const afterBroken = badCalls
      expect(afterBroken).toBeGreaterThan(0)

      // ② 上游恢复。**不推进时间** ⇒ 仍在失败短缓存 TTL 内，不得重复打。
      broken = false
      await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      expect(badCalls, 'TTL 内不该再问（失败记录生效）').toBe(afterBroken)

      // ③ 推过失败 TTL ⇒ 恢复后必须拿到 autoclaw 更大的窗口（2M）。
      fakeNow += 30_001
      expect((await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')).context?.contextWindow)
        .toBe(2_000_000)
    })
  })

  /**
   * ★★★ 「**预算到期**」不得被读成「**调用方取消**」（真实缺陷，两轮独立审计实测）。
   *
   * ## 缺陷本体
   *
   * `resolveWithBudget` 初版在预算到期时**先 `controller.abort()`、再 `reject(哨兵)`**。
   * 而真实适配器（以及 `fetch` / `undici`）在 `signal` 的 `abort` 事件里会**同步**以
   * `AbortError` 结算那次 `resolveModelInfo` ⇒ 该 Promise 的 race 反应**先于**哨兵入队
   * ⇒ `Promise.race` 以 `AbortError` 结算 ⇒ `capabilityOf` 的
   * `if (isAbortLike(error, signal)) throw error` 把它当成「用户取消」**原样抛出**
   * ⇒ **整轮请求失败**。
   *
   * 症状极具误导性：用户没取消，但每轮都失败；而 PR 的注释还写着「超时不等于取消」。
   *
   * ## 为什么必须**两条**用例（时序各一半）
   *
   * 胜负取决于微任务入队次序，而各适配器结算形态不同：
   * - `async` 包装（多一拍）⇒ 底下的 `catch { if (timedOut) }` 兜住就够；
   * - **裸 `new Promise` 在 abort 里同步 reject**（少一拍）⇒ 只有「哨兵先入队」
   *   或那条 catch 兜底才能救。
   *
   * ⚠️ **第一版审计用例用的是 `async` stub ⇒ 打不中**（同步性被 `async` 吞掉、
   *    多了一拍微任务，哨兵侥幸赢）。必须有一条**不带 `async` 包装**的同步 stub。
   */
  describe('★★★ 预算到期 ≠ 调用方取消（哨兵不得被 AbortError 抢赢）', () => {
    /** 造一个「buddy 正常 + autoclaw 在 abort 事件里按指定时序拒绝」的世界。 */
    const makeRaceWorld = (style: 'sync' | 'microtask') => {
      const state = { badAborted: false }
      const ctx = {
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        llm: {
          listProviders: () => [{ id: 'buddy', name: 'b' }, { id: 'autoclaw', name: 'a' }],
          listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
          // ⚠️ **刻意不是 `async` 函数**：`async` 会给拒绝多加一拍微任务，
          //    正好把本缺陷掩盖掉（第一版审计用例就这么漏了）。
          resolveModelInfo: (provider: string, id: string, signal?: AbortSignal) => {
            if (provider !== 'autoclaw') {
              return Promise.resolve({ provider, id, context: { contextWindow: 1_000_000 } })
            }
            return new Promise((_resolve, reject) => {
              const fail = (): void => {
                const error = new Error('The operation was aborted')
                error.name = 'AbortError'
                reject(error)
              }
              signal?.addEventListener('abort', () => {
                state.badAborted = true
                // `sync` = fetch/undici 的真实形态（在 abort 里同步结算）；
                // `microtask` = 下一拍才结算。
                if (style === 'sync') fail()
                else setTimeout(fail, 0)
              }, { once: true })
            })
          },
          stream: () => { throw new Error('本用例不应调用 stream') },
        },
      } as never
      return { state, ctx }
    }

    it('★★ 底层在 abort 里**同步**以 AbortError 拒绝 ⇒ 整轮仍须成功（不得抛 AbortError）', async () => {
      const { state, ctx } = makeRaceWorld('sync')
      const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), capabilityTimeoutMs: 30 })
      await adapter.refreshCatalog()
      // ⚠️ 断言「整轮成功 + 窗口取健康候选的 1M」：若抛错，vitest 会把
      //    `AbortError` 的原话打出来，红因一眼可辨。
      const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      expect(info.context?.contextWindow, '坏候选必须被放弃等待，而不是把整轮带崩').toBe(1_000_000)
      // ⚠️ 反证预算真的到期了（否则本用例可能只是「buddy 先返回」的巧合绿）。
      expect(state.badAborted, '预算必须真的 abort 了那个坏候选').toBe(true)
    })

    it('★★ 底层在 abort 后**下一拍**拒绝 ⇒ 同样不得把整轮带崩（时序对照）', async () => {
      const { state, ctx } = makeRaceWorld('microtask')
      const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), capabilityTimeoutMs: 30 })
      await adapter.refreshCatalog()
      const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      expect(info.context?.contextWindow).toBe(1_000_000)
      expect(state.badAborted).toBe(true)
    })

    it('★★ 反向对照：**调用方**真取消时仍必须原样抛 AbortError（别把两条语义合并）', async () => {
      // ⚠️ 没有这一条，把 `capabilityOf` 改成「凡错都回落」也能让上面两条绿 ——
      //    那是把「用户取消」换算成「候选坏了」，会静默烧完整池。
      const ctx = {
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        llm: {
          listProviders: () => [{ id: 'buddy', name: 'b' }],
          listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
          resolveModelInfo: async () => { throw new Error('本用例不应走到这里') },
          stream: () => { throw new Error('本用例不应调用 stream') },
        },
      } as never
      const adapter = new AggregateAdapter(ctx, { accountPool: makePool() })
      await adapter.refreshCatalog()
      const controller = new AbortController()
      controller.abort()
      await expect(adapter.resolveModel(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash', controller.signal))
        .rejects.toThrow(/abort/i)
    })
  })
})

/**
 * ★★ 门控建池 + `NEVER` 兜底 + 手工位次（用户 2026-10-15）。
 *
 * 规格 §5.4。这三件事都在 `candidatesFor` 里，且**顺序**是关键：
 * 门控（早于余额探测）→ `NEVER` 兜底（未接入渠道不探针）→ 排序（手工位次）。
 */
describe('★★ 门控建池、NEVER 兜底与手工位次', () => {
  /** 造一个双渠道世界：`buddy` 已接入折算，`raccoon` 未接入（`WIRED_EXPIRY_PROVIDERS` 里没有）。 */
  const makeWorld = (options: {
    allowed?: () => Record<string, Record<string, Record<string, boolean>>>
    rejections?: () => Record<string, Record<string, Record<string, boolean>>>
    order?: () => Record<string, string[]>
    orderMode?: () => 'expiry' | 'manual'
  } = {}) => {
    const probed: string[] = []
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'raccoon' }],
        listModels: async (provider: string) => [
          { id: 'deepseek-v4.1-flash', name: `Deepseek-V4.1-Flash · ${provider}` },
        ],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () { yield { type: 'text', text: 'ok' } })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      // ⚠️ 探针**记录调用**：门控必须在探针之前生效（被排除的候选不该打上游）。
      //    ⚠️ 未接入渠道的探针若被调用会返回 UNUSABLE（模拟 `credentialExpiry` 的短路）
      //    —— 这正是「NEVER 兜底」用例要抓的形态。
      expiryProbe: async (provider: string) => {
        probed.push(provider)
        return provider === 'raccoon' ? -1 : 100
      },
      ...options,
    })
    return { adapter, probed, sent }
  }

  const drain = async (call: { stream: (o: unknown) => AsyncIterable<unknown> }) => {
    for await (const _chunk of call.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
      // 必须真正 drain，否则 stream 从未被调用（既有用例的注释已记过这个坑）
    }
  }

  it('★ 未接入渠道的候选**未放行** ⇒ 不在池里，且**一次探针都不该被调**（它不该打上游）', async () => {
    // ⚠️⚠️ 本用例的世界**只有 raccoon 一个渠道**（全未接入）—— 这一点是刻意的。
    //    第一版用「buddy + raccoon」的世界，且断言 `probed === ['buddy']`：
    //    **变异验证实测它无牙** —— 把门控整段换成旧的「只过滤显式拒绝」后，
    //    `raccoon` 会进池并被探针折算成 `UNUSABLE` ⇒ 它照样不进候选序、
    //    `sent` 照样只有 buddy ⇒ **用例仍绿**（差异只在 `probed` 里多了个 raccoon，
    //    而那正是它该抓的 —— 但我第一版把它写成了「buddy 先成功所以探针只到 buddy」）。
    //    ⇒ 现在世界只有未接入渠道：门控缺失 ⇒ 它在池里、**甚至可能被发往**
    //    （探针返回 UNUSABLE 才会拦它，而那是另一道闸门、不是门控）。
    const probed: string[] = []
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'raccoon' }],
        listModels: async () => [{ id: 'sn-glm-5-3', name: 'GLM-5-3 · x0.75' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string }) => {
          sent.push(o.provider)
          return (async function* () { yield { type: 'text', text: 'ok' } })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (provider: string) => { probed.push(provider); return 100 },
    })
    // ⚠️ 零候选 ⇒ `prepareCall` **直接抛**（它在建池后、返回 call 之前就查了候选数）
    //    —— 这就是未放行的**如实**结果：不静默成功，也不发往任何渠道。
    await expect(adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3'))
      .rejects.toThrow(/没有任何可用候选/)
    expect(probed, '★ 未放行的未接入候选不得触发探针（门控在建池阶段）').toEqual([])
    expect(sent, '★ 更不得被发往').toEqual([])
  })

  it('★★ 未接入渠道的候选**已放行** ⇒ 在池里且参与路由（不探针，直接 NEVER）', async () => {
    // ⚠️⚠️ **两个方向都要测**：只测「未放行不在池里」时，把门控整段删掉用例仍然全绿
    //   （因为 `raccoon` 的探针恰好返回 UNUSABLE，会被折算掉）⇒ 那条用例**没有牙**。
    //    本用例才是抓「门控 + NEVER 兜底」的那一条：放行后 `raccoon` 的探针
    //    **返回 UNUSABLE**，若没有 NEVER 兜底它就会被剔除、请求永不发往它。
    const { adapter, probed, sent } = makeWorld({
      allowed: () => ({ 'deepseek-v4-1-flash': { raccoon: { 'deepseek-v4.1-flash': true } } }),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await drain(call as never)
    // ⚠️ 关键断言：探针**没有被 raccoon 调用**（未接入渠道不探测）—— 它的 `expiry` 直接是 NEVER。
    expect(probed, '★ 未接入渠道不得被探针折算（否则会被 UNUSABLE 剔除）').toEqual(['buddy'])
    // 且它真的在候选序里（buddy 临期 100 先发；raccoon 是 NEVER 排最后，但**在池里**）。
    const catalog = await adapter.describeCatalog()
    expect(catalog.models[0]!.candidates.find((c) => c.provider === 'raccoon')!.state).toBe('allowed')
  })

  it('★★ 已放行的未接入候选在 buddy 失败时**真的被回落到**（不是只留在候选表里）', async () => {
    // ⚠️ 这条才是「用户手工打开**真的有用**」的端到端判据：上一条只证明它在 `state` 上
    //    是 allowed，而 `state` 由**目录**路径算出来；**建池**路径是另一条代码路径
    //    （`candidatesFor`）—— 两者分叉正是本仓库反复出现的缺陷形态。
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'raccoon' }],
        listModels: async (provider: string) => [
          { id: 'deepseek-v4.1-flash', name: `Deepseek-V4.1-Flash · ${provider}` },
        ],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string }) => {
          sent.push(o.provider)
          return (async function* () {
            if (o.provider === 'buddy') throw new Error('上游挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (provider: string) => (provider === 'raccoon' ? -1 : 100),
      allowed: () => ({ 'deepseek-v4-1-flash': { raccoon: { 'deepseek-v4.1-flash': true } } }),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await drain(call as never)
    expect(sent, '★ buddy 失败后必须回落到手工打开的 raccoon').toEqual(['buddy', 'raccoon'])
  })

  it('★ 对照：**未放行**时 buddy 失败 ⇒ 不回落（raccoon 不在池里）', async () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'raccoon' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'M' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string }) => {
          sent.push(o.provider)
          return (async function* () {
            if (o.provider === 'buddy') throw new Error('上游挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async (provider: string) => (provider === 'raccoon' ? -1 : 100),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await expect(drain(call as never)).rejects.toThrow()
    expect(sent, '未放行 ⇒ 只尝试 buddy，失败即失败（不得静默发往未放行的渠道）').toEqual(['buddy'])
  })

  it('★ 已接入渠道照旧走探针（NEVER 兜底不得顺手把它们也跳过）', async () => {
    const { adapter, probed } = makeWorld({
      allowed: () => ({ 'deepseek-v4-1-flash': { raccoon: { 'deepseek-v4.1-flash': true } } }),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
    await drain(call as never)
    expect(probed, 'buddy（已接入）必须仍被探针折算').toContain('buddy')
  })

  it('★ abort 仍原样逃逸（探针抛 AbortError ⇒ 抛 AbortError，不是空池）', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'M' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => { throw new Error('不该走到 stream') },
      },
    } as never
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
    } as never
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const adapter = new AggregateAdapter(ctx, {
      accountPool: pool,
      expiryProbe: async () => { throw abort },
    })
    await expect(adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash'))
      .rejects.toThrow(/aborted/)
  })

  describe('手工位次接线', () => {
    it('★ mode=manual + 有顺序 ⇒ 严格按手工位次（即使临期更晚）', async () => {
      const { adapter, sent } = makeWorld({
        orderMode: () => 'manual',
        // buddy 临期 100（更早），raccoon 未接入 ⇒ NEVER。手工序把 raccoon 排第一
        // ⇒ **必须先发 raccoon**，否则「拖动排序」被临期值静默覆盖。
        order: () => ({ 'deepseek-v4-1-flash': ['raccoon\u0000deepseek-v4.1-flash', 'buddy\u0000deepseek-v4.1-flash'] }),
        allowed: () => ({ 'deepseek-v4-1-flash': { raccoon: { 'deepseek-v4.1-flash': true } } }),
      })
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      await drain(call as never)
      expect(sent, '★ 手工位次必须严格优先（不被临期覆盖）').toEqual(['raccoon/deepseek-v4.1-flash'])
    })

    it('★ mode=manual 但该模型**没有**顺序 ⇒ 回落临期序（缺键 = 未自定义）', async () => {
      const { adapter, sent } = makeWorld({
        orderMode: () => 'manual',
        order: () => ({}),
        allowed: () => ({ 'deepseek-v4-1-flash': { raccoon: { 'deepseek-v4.1-flash': true } } }),
      })
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      await drain(call as never)
      expect(sent, '没有顺序 ⇒ 按临期（buddy 100 先）').toEqual(['buddy/deepseek-v4.1-flash'])
    })

    it('★ mode=expiry ⇒ 忽略顺序表（即便有内容）', async () => {
      const { adapter, sent } = makeWorld({
        orderMode: () => 'expiry',
        order: () => ({ 'deepseek-v4-1-flash': ['raccoon\u0000deepseek-v4.1-flash', 'buddy\u0000deepseek-v4.1-flash'] }),
        allowed: () => ({ 'deepseek-v4-1-flash': { raccoon: { 'deepseek-v4.1-flash': true } } }),
      })
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      await drain(call as never)
      expect(sent, '临期模式下顺序表被忽略').toEqual(['buddy/deepseek-v4.1-flash'])
    })

    it('★ `auto` 在 manual 模式下**仍按临期**（用户 Q6=C 的取舍）', async () => {
      const { adapter, sent } = makeWorld({
        orderMode: () => 'manual',
        order: () => ({ auto: ['raccoon\u0000deepseek-v4.1-flash'] }),
        allowed: () => ({ 'deepseek-v4-1-flash': { raccoon: { 'deepseek-v4.1-flash': true } } }),
      })
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'auto')
      await drain(call as never)
      expect(sent, 'auto 恒按临期（手工序只作用于具体虚拟模型）').toEqual(['buddy/deepseek-v4.1-flash'])
    })

    it('★ 顺序表里全是**畸形/过期**元素 ⇒ 不报错，且等于「全都未排过」⇒ 落临期序', async () => {
      // ⚠️ 顺序表的元素是 `provider\0realId`，而渠道侧的模型 id 会漂移
      //   （上游改名/换兜底表）⇒ 表里可能留着**匹配不到任何候选**的旧键。
      //    它**不得**让整次路由报错，也不得改变其它候选的位次：
      //    匹配不到 ⇒ `manualRankOf` 返回 `undefined` ⇒ 视为「未排过」。
      const { adapter, sent } = makeWorld({
        orderMode: () => 'manual',
        order: () => ({ 'deepseek-v4-1-flash': ['raccoon\u0000drifted-away'] }),
        allowed: () => ({ 'deepseek-v4-1-flash': { raccoon: { 'deepseek-v4.1-flash': true } } }),
      })
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      await drain(call as never)
      // 两条候选**都未排过**（漂移键匹配不到）⇒ 按临期：buddy 100 先于 raccoon 的 NEVER。
      expect(sent, '漂移键不得报错；全都未排过 ⇒ 落临期序').toEqual(['buddy/deepseek-v4.1-flash'])
    })

    it('★ 对照：把漂移键换成**正确键** ⇒ 手工位次立刻生效（证明上一条不是恒真）', async () => {
      // ⚠️ 没有这一条时，「漂移键 ⇒ 落临期序」与「手工序根本没接线」**无法区分**
      //   （两者都给 buddy 先发）。
      const { adapter, sent } = makeWorld({
        orderMode: () => 'manual',
        order: () => ({ 'deepseek-v4-1-flash': ['raccoon\u0000deepseek-v4.1-flash'] }),
        allowed: () => ({ 'deepseek-v4-1-flash': { raccoon: { 'deepseek-v4.1-flash': true } } }),
      })
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      await drain(call as never)
      expect(sent, '★ 正确键 ⇒ 手工序把 raccoon 提到 buddy 之前').toEqual(['raccoon/deepseek-v4.1-flash'])
    })

    it('★ 未排过的候选按临期**追加在已排过的之后**（新增候补不得因没有位次而消失）', async () => {
      // 手工序只排了 raccoon（NEVER，临期最晚）⇒ buddy（临期 100，更早）**未排过**，
      // 但按 Q3=A 的语义它必须**排在被排过的之后**，而不是按临期插到前面。
      const { adapter, sent } = makeWorld({
        orderMode: () => 'manual',
        order: () => ({ 'deepseek-v4-1-flash': ['raccoon\u0000deepseek-v4.1-flash'] }),
        allowed: () => ({ 'deepseek-v4-1-flash': { raccoon: { 'deepseek-v4.1-flash': true } } }),
      })
      const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
      await drain(call as never)
      expect(sent, '已排过的严格优先（即便它临期最晚）').toEqual(['raccoon/deepseek-v4.1-flash'])
    })
  })

  describe('routingFingerprint：四项各自变化都必须让 choiceCache 失效', () => {
    /** 造一个「探测次数可数」的世界 —— 命中缓存时第二轮不该再探测。 */
    const probeCounter = async (
      mutate: (state: {
        allowed: Record<string, Record<string, Record<string, boolean>>>
        rejections: Record<string, Record<string, Record<string, boolean>>>
        order: Record<string, string[]>
        mode: 'expiry' | 'manual'
      }) => void,
      /** ⚠️ 可选的**首轮初值**（2026-10-16 加）：用于构造「两轮长度相同、内容不同」的场景。 */
      initial?: Partial<{
        allowed: Record<string, Record<string, Record<string, boolean>>>
        rejections: Record<string, Record<string, Record<string, boolean>>>
        order: Record<string, string[]>
        mode: 'expiry' | 'manual'
      }>,
    ) => {
      const state = {
        allowed: initial?.allowed ?? {},
        rejections: initial?.rejections ?? {},
        order: initial?.order ?? {},
        mode: initial?.mode ?? ('expiry' as 'expiry' | 'manual'),
      }
      let probes = 0
      const ctx = {
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        llm: {
          listProviders: () => [{ id: 'buddy' }],
          listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'M' }],
          resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
          stream: () => (async function* () { yield { type: 'text', text: 'ok' } })(),
        },
      } as never
      const pool = {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
      } as never
      const adapter = new AggregateAdapter(ctx, {
        accountPool: pool,
        expiryProbe: async () => { probes += 1; return 100 },
        allowed: () => state.allowed,
        rejections: () => state.rejections,
        order: () => state.order,
        orderMode: () => state.mode,
      })
      const run = async () => {
        const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-v4-1-flash')
        await drain(call as never)
      }
      await run()
      const afterFirst = probes
      mutate(state)
      await run()
      // ⚠️ 挂钟 TTL 是 60 秒，用例不可能等它 ⇒ 第二轮若再探测，只可能是因为**指纹变了**。
      //    （若指纹没变，第二轮会命中缓存、`probes` 不变。）
      return { probes, afterFirst }
    }

    it('基线：什么都不改 ⇒ 第二轮命中缓存（不重复探测）', async () => {
      const { probes, afterFirst } = await probeCounter(() => {})
      expect(probes, '第二次必须命中缓存').toBe(afterFirst)
    })

    it('拒绝表变化 ⇒ 指纹变 ⇒ 重新探测', async () => {
      const { probes, afterFirst } = await probeCounter((s) => {
        s.rejections = { 'other-model': { buddy: { 'x-1': true } } }
      })
      expect(probes, '拒绝表变了就必须重算候选序').toBeGreaterThan(afterFirst)
    })

    it('★ 白名单变化 ⇒ 指纹变 ⇒ 重新探测（漏这一项 = 手工打开 60 秒内不生效）', async () => {
      const { probes, afterFirst } = await probeCounter((s) => {
        s.allowed = { 'other-model': { raccoon: { 'y-1': true } } }
      })
      expect(probes, '★ 白名单是第 2 项，漏了它「手工打开」会静默延迟').toBeGreaterThan(afterFirst)
    })

    it('★ 顺序表变化 ⇒ 指纹变 ⇒ 重新探测（否则拖了排序 60 秒内不生效）', async () => {
      const { probes, afterFirst } = await probeCounter((s) => {
        s.order = { 'deepseek-v4-1-flash': ['buddy\u0000deepseek-v4.1-flash'] }
      })
      expect(probes, '★ 顺序表是第 3 项').toBeGreaterThan(afterFirst)
    })

    it('★★ 顺序表**内容**变化（长度相同）⇒ 指纹必须变（防退化成「只数条数」）', async () => {
      // ⚠️⚠️ **真实守卫缺口**（2026-10-16 对抗审计实测）：
      //    上一条用例是「空表 → 一条」，**长度变了** ⇒ 把
      //    `order[key].join(',')` 退化成 `String(order[key].length)`（**正是本文件
      //    注释里明令禁止的「条目数摘要」**）时，上一条**照样绿**。
      //    后果：`{m:[a,b]}` 与 `{m:[c,d]}` 摘要同为 `2` ⇒ 语义不同的两张顺序表
      //    **指纹碰撞** ⇒ 改了顺序却命中旧 `choiceCache` ⇒ 拖了排序 60 秒内不生效
      //    —— 而这里登记过的教训（「缓存失效判据按数组长度」被实测证伪）**没有守卫**。
      // ⇒ 判据必须用**长度相同、内容不同**的两张表。
      const { probes, afterFirst } = await probeCounter((s) => {
        // 先给一份「两个候选」的顺序表…
        s.order = { 'deepseek-v4-1-flash': ['buddy\u0000a', 'zcode\u0000b'] }
      }, {
        // …但第一轮用的也是**两个**（只是内容不同）⇒ 长度相同、内容不同。
        order: { 'deepseek-v4-1-flash': ['zcode\u0000b', 'buddy\u0000a'] },
      })
      expect(probes, '★ 长度相同但内容/次序不同的顺序表必须让指纹变化').toBeGreaterThan(afterFirst)
    })

    it('★ 排序模式变化 ⇒ 指纹变 ⇒ 重新探测（否则切到手工序 60 秒内不生效）', async () => {
      const { probes, afterFirst } = await probeCounter((s) => {
        s.mode = 'manual'
      })
      expect(probes, '★ 模式是第 4 项').toBeGreaterThan(afterFirst)
    })
  })
})

/**
 * ★★ 目录加载**不得**同步等上游（2026-10-18，实测 `provider=aggregate 总耗时=7028ms`）。
 *
 * ## 实测证据与它真正的机制（实施时核对代码后订正过一次）
 *
 * 排障日志里 `aggregate` 的 7028ms 与 `loomy` 的 6852ms **同步出现且数值相近**，
 * 说明二者卡在**同一个下游**。核对代码后的真实机制是：
 *
 * `listModels` → `refreshCatalog` → 逐渠道 `ctx.llm.listModels(provider)`（每个渠道
 * 一次**远端目录读取**）。`loomy` 的 `listModels` → `catalog.listModels` →
 * `loadModels()` → `fetchRemoteModels()`（真发网络请求）。⇒ 聚合的总耗时里装的就是
 * 各渠道目录读取之和（loomy 那 6852ms 是其中最大的一项，聚合 7028ms 差额是本机开销）。
 *
 * ⚠️ 因此**判据必须打在上游目录读取上**（让 `ctx.llm.listModels` 永不返回），
 *    而不是 `expiryProbe`：`refreshCatalog` 的代码里**完全没有** `expiryProbe`
 *    （临期折算发生在 `candidatesFor`，即**发消息**路径）。若把 `expiryProbe` 做成
 *    永不返回，这两条用例会**恒绿**（改回 `await` 也照样绿）—— 那正是本仓库
 *    反复踩过的「无判别力判据」。
 */
describe('aggregate：目录加载不得同步折算余额（实测 7 秒）', () => {
  /** 造一个「上游目录永不返回」的 ctx —— 判据的杠杆就在这里。 */
  const makeStuckCtx = () => ({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'buddy', name: 'buddy' }],
      // ⚠️ **永不 resolve**：任何 `await` 它的调用方都会永远挂住。
      listModels: () => new Promise<Array<{ id: string; name?: string }>>(() => {}),
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: () => { throw new Error('本用例不应调用 stream') },
    },
  }) as never

  it('★★ listModels 不等待上游目录（上游永不返回也照样出目录）', async () => {
    const adapter = new AggregateAdapter(makeStuckCtx(), {
      accountPool: makePool(),
      // 临期探针也做成永不返回：即便有人误把它拉进目录路径，这条也会红。
      expiryProbe: () => new Promise<number>(() => {}),
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const models = await Promise.race([
      adapter.listModels(AGGREGATE_PROVIDER),
      new Promise((resolve) => { timer = setTimeout(() => { resolve('TIMEOUT') }, 50) }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
    expect(models, '★★ listModels 必须不等上游目录就返回（否则选择器要等满上游超时）')
      .not.toBe('TIMEOUT')
    // 反向对照的下界：目录**至少要播报 `auto`**（「什么都不返回」不算通过）。
    expect((models as Array<{ id: string }>).map((m) => m.id)).toContain('auto')
  })

  it('★ 后台折算落地后，再调能看到它（异步补算真的会落地，不是永远空目录）', async () => {
    // ⚠️ **反向对照**：没有这条，「listModels 永远只返回 auto」也会全绿。
    // 判据落在**可观测的落地点**上 —— 本适配器**没有**事件/广播回调，
    // 「广播」的实体就是目录本身：后台补算完成后，目录在三个宿主可读面上同时可见
    // （`listModels` 再次播报 / `listAllModels` 同步视图 / `describeCatalog` 的候选表）。
    const adapter = new AggregateAdapter(makeCtx({
      buddy: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.15' }],
    }), { accountPool: makePool() })

    // 冷缓存首调：**先返回已知目录**（此刻为空 ⇒ 只有 auto），不等上游。
    const first = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(
      first.map((m) => m.id),
      '★ 首调必须立刻返回（已知目录此时是空的 ⇒ 只有 auto）',
    ).toEqual(['auto'])

    // 让后台补算落地：排空微任务 + 一轮宏任务（不依赖挂钟，避免 flaky）。
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    // 落地点 ①：再次 listModels 能看到折算出来的虚拟模型（含倍率后缀）。
    const second = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(second.map((m) => m.id), '★ 后台补算完成后必须能被再次播报').toContain('deepseek-v4-1-flash')
    expect(
      second.find((m) => m.id === 'deepseek-v4-1-flash')?.name,
      '★ 且是**折算过**的那一份（倍率来自真实目录）',
    ).toBe('DeepSeek V4.1 Flash · 最低 x0.15')

    // 落地点 ②：同步视图（设置页开关清单的来源）也立刻可见。
    expect(adapter.listAllModels().map((m) => m.id)).toContain('deepseek-v4-1-flash')

    // 落地点 ③：面板路径的候选表也已建好（证明补算产出的是**完整目录**）。
    const described = await adapter.describeCatalog()
    expect(described.models.map((m) => m.canonicalId)).toContain('deepseek-v4-1-flash')
  })

  /**
   * ★★ **DSH 的真实形状**：`listModels()` 之后**逐模型** `resolveModel()`。
   *
   * ## 为什么单测 `listModels` 非阻塞是**不够**的（控制方实测，Task 7 没达成目标）
   *
   * `dsh-api-session-controller/lib/index.js` 的 `buildModelCatalog` 是：
   *
   * ```js
   * const models = await ctx.llm.listModels(provider.id)     // 1ms —— Task 7 修的就是这里
   * const entries = await Promise.all(models.map(async (model) =>
   *   ctx.llm.resolveModelInfo(provider.id, model.id)))      // ← 7 秒全在这里
   * ```
   *
   * Task 7 之后排障日志的 `listModels=` 那格确实降到 1ms，但**总耗时仍在 7 秒级** ——
   * 因为 `resolveModel` 的首行还是 `await this.ensureCatalog(signal)`。⇒ 耗时只是从
   * 一格**搬到了另一格**，用户感知零改善。
   *
   * ## ⚠️⚠️ 判据为什么必须是「**两段都**在预算内」
   *
   * 只断言 `listModels` 快 → 改前也绿（Task 7 已经做到了），**恒绿**。
   * 只断言 `resolveModel` 快 → 会漏掉 `listModels` 的回归。
   * ⇒ 两段都要，且**必须按 DSH 的真实顺序串起来**（先 listModels，再对它播报的
   *   每个 id 调 resolveModel）—— 否则测的不是生产路径。
   */
  it('★★ DSH 真实形状：listModels 之后逐模型 resolveModel，上游永挂时两段都在预算内', async () => {
    const adapter = new AggregateAdapter(makeStuckCtx(), {
      accountPool: makePool(),
      expiryProbe: () => new Promise<number>(() => {}),
    })
    const models = await raceIn(500, async () => await adapter.listModels(AGGREGATE_PROVIDER))
    expect(models, '★ 前置：listModels 必须立刻返回（Task 7 已修，用作对照）').not.toBe('TIMEOUT')
    const ids = (models as Array<{ id: string }>).map((model) => model.id)
    expect(ids, '★ 冷帧至少播报 auto').toContain('auto')

    // ★ 核心判据：**逐模型** resolveModel 也必须立刻返回（不是 TIMEOUT）。
    const resolved = await raceIn(500, async () => {
      const out: unknown[] = []
      for (const id of ids) out.push(await adapter.resolveModel(AGGREGATE_PROVIDER, id))
      return out
    })
    expect(
      resolved,
      '★★ resolveModel 不得等待目录（否则 DSH 的 buildModelCatalog 仍要等满上游超时 —— '
      + 'Task 7 只是把耗时从 listModels 那格搬到了总耗时那格）',
    ).not.toBe('TIMEOUT')
    // 反向对照的下界：不能「什么都不返回」——每一条都必须是可用的元数据。
    expect((resolved as Array<{ provider: string; id: string; name: string }>).length).toBe(ids.length)
  })

  it('★★ 冷帧的保守元数据必须**可辨识且不撒谎**（明确常量 / 不声明档位）', async () => {
    // ⚠️ 这条防的是「为了让守卫绿而编一份看起来正常的元数据」：
    //    编造 reasoning 等于替用户承诺一个可能不存在的档位，
    //    而「声称目标是 xxx 的描述」正是本仓库明文禁止的编造。
    const adapter = new AggregateAdapter(makeStuckCtx(), {
      accountPool: makePool(),
      expiryProbe: () => new Promise<number>(() => {}),
    })
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'auto')
    // ① 身份按入参回填（DSH 的 `normalizeModelInfo` 逐字校验，不符即 INVALID_MODEL_INFO）。
    expect(info.provider).toBe(AGGREGATE_PROVIDER)
    expect(info.id).toBe('auto')
    expect(info.name.length).toBeGreaterThan(0)
    // ② 窗口是**具名保守常量**（不是候选集的最大值，也不是编造的 1M）。
    expect(info.context?.contextWindow).toBe(AGGREGATE_COLD_CONTEXT_WINDOW)
    // ③ **不声明档位**（冷帧不知道候选集，编一份就是撒谎）。
    expect(info.reasoning, '★ 冷帧不得声明 reasoning（那是编造）').toBeUndefined()
    // ④ **不编造描述**（不得出现「已选好目标」这类冷帧不可能知道的信息）。
    expect(info.description, '★ 冷帧不得编造 description').toBeUndefined()
    // ⑤ 可辨识：它必须**不等于**热路径会给的值（否则排障者分不清冷帧与热帧）。
    expect(AGGREGATE_COLD_CONTEXT_WINDOW).not.toBe(AGGREGATE_FALLBACK_CONTEXT_WINDOW)
  })

  it('★★ 冷帧**必须**触发后台读取（否则目录永远补不回来，是一扇单向门）', async () => {
    // ⚠️ **反向对照**：没有这条，「resolveModel 立刻返回一份元数据」也可以靠
    //    「压根不读目录」实现 —— 那会让聚合目录**永远**只有 auto。
    let reads = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => {
          reads += 1
          await gate
          return [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      // ⚠️ 预算给足：本条只验「真的起了一轮读取」，不验超时（那条另有专门用例）。
      backgroundRefreshTimeoutMs: 60_000,
    })
    // 冷帧解析（此刻目录为空）。
    await adapter.resolveModel(AGGREGATE_PROVIDER, 'auto')
    release!()
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(reads, '★ 冷帧必须真的起了一轮后台目录读取').toBeGreaterThan(0)
    // 且那一轮真的落地了（否则「起了」也可以是空转）。
    expect(adapter.listAllModels().map((m) => m.id)).toContain('deepseek-v4-1-flash')
  })

  it('★★ 目录为空时 resolveModel **不得** await 目录（反向验证的靶点）', async () => {
    // ⚠️ 这条与上面那条 DSH 形状用例**互补**：那条走「逐模型」的真实顺序，
    //    这条直接把「有没有 await」钉在**单次调用**上 —— 把
    //    `resolveModel` 改回 `await this.ensureCatalog(signal)` 时，
    //    上面那条与这条都必须在预算内**变红**（实测见报告）。
    //
    // 杠杆：`ctx.llm.listModels` **永不 resolve** ⇒ 任何 await 它的调用方都永远挂住。
    const adapter = new AggregateAdapter(makeStuckCtx(), {
      accountPool: makePool(),
      // ⚠️ 预算给很小：真起了后台读取也会「放弃等待」，不会让本用例挂住。
      backgroundRefreshTimeoutMs: 20,
    })
    const info = await raceIn(500, async () => await adapter.resolveModel(AGGREGATE_PROVIDER, 'auto'))
    expect(info, '★★ resolveModel 不得等待目录（上游永挂时也必须立刻返回）').not.toBe('TIMEOUT')
    // ⚠️ 且它必须是**冷帧那份**（可辨识），不是「等到了目录之后的那份」。
    expect((info as { context?: { contextWindow?: number } }).context?.contextWindow)
      .toBe(AGGREGATE_COLD_CONTEXT_WINDOW)
  })

  /**
   * ★★ **上游永挂时「在飞」标记必须能过期**（Important 2：单向门）。
   *
   * `startBackgroundCatalogRefresh` 初版只在 `.finally` 里清 `catalogRefreshInFlight`，
   * 而 `.finally` 只在「那一轮**结束**」时执行。上游**永不 resolve** ⇒ 永不结束 ⇒
   * 标记永不清 ⇒ 此后**所有** `listModels` 都因单飞闸门直接返回、不再起后台刷新
   * ⇒ 目录**永久冻在冷帧**，且**零报错**。
   *
   * ⚠️ 注释当时自称「防住了一次瞬时失败把目录永久冻在空目录」——它防住了
   * `reject`，**没防住 `hang`**。本条就是那个缺口的守卫。
   */
  it('★★ 上游永挂 ⇒ 预算到期后必须清在飞标记（否则目录永久冻在冷帧）', async () => {
    let reads = 0
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        // ⚠️ 永挂：既不 resolve 也不 reject —— 这正是实测到的形态。
        listModels: () => {
          reads += 1
          return new Promise<Array<{ id: string; name?: string }>>(() => {})
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      // ⚠️ 必须可注入：真的等 60 秒会让这条用例变成 flaky 的超时测试。
      backgroundRefreshTimeoutMs: 20,
    })
    // 第一轮：冷帧解析 ⇒ 起一轮后台读取（会永挂）。
    await adapter.resolveModel(AGGREGATE_PROVIDER, 'auto')
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    const afterFirst = reads
    expect(afterFirst, '前置：第一轮读取必须真的起了').toBeGreaterThan(0)

    // ★ 关键：预算到期后，再触发一次冷帧解析 —— 必须能**再起一轮**读取。
    //   若标记没有过期，单飞闸门会直接 return ⇒ `reads` 不再增长（单向门）。
    await adapter.resolveModel(AGGREGATE_PROVIDER, 'auto')
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    expect(
      reads,
      '★★ 上游永挂时「在飞」标记必须由预算到期清掉（否则后续永不重启读取 = 单向门）',
    ).toBeGreaterThan(afterFirst)
  })

  it('★ 预算到期必须**保留旧目录**（不得清空）', async () => {
    // ⚠️ 失败/放弃时**保留旧值**是本适配器的既有口径（见 `startBackgroundCatalogRefresh`）。
    //    清空会让「上游抖一下」变成「用户的所有模型突然消失」。
    let hang = false
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => {
          if (hang) return await new Promise<Array<{ id: string; name?: string }>>(() => {})
          return [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
        },
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => { throw new Error('本用例不应调用 stream') },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      // ⚠️ 目录 TTL 设 0 ⇒ 每次 listModels 都判「不新鲜」⇒ 都会起后台刷新，
      //    这样才测得到「挂在半路时旧目录还在不在」。
      catalogTtlMs: 0,
      backgroundRefreshTimeoutMs: 20,
    })
    // 先落地一份真实目录。
    await adapter.refreshCatalog()
    const before = adapter.listAllModels().map((m) => m.id)
    expect(before).toContain('deepseek-v4-1-flash')

    // 上游开始永挂 ⇒ 后台那一轮到期被放弃。
    hang = true
    await adapter.listModels(AGGREGATE_PROVIDER)
    await new Promise((resolve) => { setTimeout(resolve, 60) })

    expect(
      adapter.listAllModels().map((m) => m.id),
      '★ 放弃等待不得清空旧目录（否则上游抖一下 = 用户所有模型消失）',
    ).toContain('deepseek-v4-1-flash')
  })

  /**
   * ★★ **后台那一轮落地后必须广播**（Important 1）。
   *
   * 其余 12 家适配器的 `onCatalogLoaded` 全都注入了 `broadcastCatalogChanged(ctx)`，
   * 只有聚合没有 ⇒ 后台这一轮无论多久落地，客户端**不会**自动重读（它在
   * `status === 'ready'` 时短路，只认四个宿主事件）⇒ 用户必须自己再开一次选择器。
   *
   * ⚠️ 判据打在**行为**上（`ctx.emit` 真的收到事件），不是读源码找那行注入 ——
   *    本仓库实测过 5 条源码文本判据在 `if (false)` 死分支里恒绿。
   */
  it('★★ 后台目录落地必须广播 llm/adapters-updated（否则客户端永不重读）', async () => {
    const emitted: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      emit: (event: string) => { emitted.push(event) },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        // `registerAdapterIdempotent` 需要它（本用例只关心广播，不做路由断言）。
        registerAdapter: () => {},
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    // ⚠️ 走**真实装配**（`registerAggregateLlm` 才会注入广播），不手工传回调。
    const adapter = registerAggregateLlm(ctx, { accountPool: makePool() })
    // 让注册时那次预热跑完（fire-and-forget）。
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(adapter.listAllModels().map((m) => m.id)).toContain('deepseek-v4-1-flash')
    expect(
      emitted,
      '★★ 目录落地后必须广播（与其余 12 家适配器的 onCatalogLoaded 同一口径）',
    ).toContain('llm/adapters-updated')
  })

  it('★ 目录**没变**时不得重复广播（否则每次 listModels 都让客户端重读一次）', async () => {
    // ⚠️ **反向对照**：没有这条，「无条件广播」也能让上一条全绿 —— 而它会形成
    //    广播风暴（`refreshCatalog` 在 TTL 过期时也会重推同一份目录）。
    const emitted: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      emit: (event: string) => { emitted.push(event) },
      llm: {
        listProviders: () => [{ id: 'buddy', name: 'b' }],
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        registerAdapter: () => {},
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const adapter = registerAggregateLlm(ctx, { accountPool: makePool() })
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const afterPrewarm = emitted.filter((e) => e === 'llm/adapters-updated').length
    expect(afterPrewarm, '前置：预热落地时应广播一次').toBeGreaterThan(0)

    // 强制重推**同一份**目录（`force = true` 会真的再读一遍上游，但结果相同）。
    await adapter.refreshCatalog(true)
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(
      emitted.filter((e) => e === 'llm/adapters-updated').length,
      '★ 目录内容未变 ⇒ 不得再广播（否则是广播风暴）',
    ).toBe(afterPrewarm)
  })
})
