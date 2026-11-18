/**
 * `src/auto-adapter.ts` 的缺陷回归（PR !69 审计实测，2026-10-06）。
 *
 * ## 为什么要单独守这个
 *
 * PR !69 新增 669 行「单一 auto 模型 + 按积分到期时间跨 provider 选型」，**零单测**。
 * 本仓库对「静默降级 / 误导性报错 / 关掉却仍在用」零容忍（见 AGENTS.md），而本文件
 * 恰好集中了这三类缺陷。以下 5 条**均由审计阶段实际跑通生产代码复现**，不是推断。
 *
 * ## 五条约定
 *
 * 1. **目录全空/全被关闭 ⇒ 该 provider 退出候选**，绝不发出 `'auto'` 这种
 *    「别的 provider 的模型名」（必然 404，且绕过用户的模型开关）。
 * 2. **账号都在、只是积分全是永久/长期 ⇒ 不得报「请先登录」**。
 * 3. **abort 必须以 AbortError 结束**，不得被降级成 `MISSING_CREDENTIAL`。
 * 4. **倍率解析必须有分隔符**：`Spark X2.5` 是模型名，不是「x2.5 倍」。
 * 5. **代表账号必须跳过限流标记的账号**：空 modelId 会让
 *    `getAvailableAccount` 的限流过滤整体短路（`account-pool.ts:1051`），
 *    于是「手动序第一个号正限流」会被误当成该 provider 的真实余额。
 *
 * ⚠️ 用例必须驱动**真实调用链**（`prepareCall` → 返回的 `call.stream`），
 * 直接调内部私有方法会绕过真实路径 —— 那正是 PR !66 的教训。
 * ⚠️ 替身的 `listModels` **必须复刻真实适配器的过滤行为**（`filter(!disabled)`，
 * 见 `zcode-adapter.ts:445-448`），否则第 1 条会是同义反复。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  AUTO_CHOICE_TTL_MS,
  AUTO_MODEL,
  AUTO_PROVIDER,
  AutoAdapter,
  pickSoonestProvider,
  priceFactorFromName,
} from '../../src/auto-adapter.js'

const here = dirname(fileURLToPath(import.meta.url))
const adapterSource = readFileSync(resolve(here, '../../src/auto-adapter.ts'), 'utf8').replace(/\r\n/g, '\n')

/** 一条纯文本用户消息（content 必须是块数组，否则 `contentHasImage` 抛错）。 */
function userMessage(text = 'hi'): { role: 'user'; content: Array<{ type: 'text'; text: string }> } {
  return { role: 'user', content: [{ type: 'text', text }] }
}

interface HarnessOptions {
  /** provider → 目录（**已按关闭名单过滤**，复刻真实适配器行为）。 */
  catalogs?: Record<string, Array<{ id: string; name: string }>>
  /** provider → 关闭的模型 id 集合。 */
  disabled?: Record<string, ReadonlySet<string>>
  /** provider → 该 provider 的代表账号到期时刻（毫秒）；`null` = 无可用账号。 */
  expiries?: Record<string, number | null>
  /** 目录读取时实际返回的原始账号（用于第 5 条断言取号参数）。 */
  pool?: { getAvailableAccount: (provider: string, model: string) => Promise<unknown> }
}

/**
 * 驱动真实 `prepareCall` → `call.stream` 链路，返回实际发往的 `provider/model`。
 *
 * ⚠️ `error` 用 `Partial<Error> & { code?: string }` 而不是 `{ code?: string }`：本文件的用例要
 * 断言 `error.name`（`AbortError` 形态）与 `error.message`（上游 499 报文），只声明
 * `code` 会让那两条报 `TS2339`（`Property 'name' does not exist`）。用 `Partial<Error>`
 * 而非 `Error` 是因为抛出来的未必是真 `Error` 实例（本仓库大量抛带 `code` 的普通对象）。
 */
async function dispatchThrough(
  options: HarnessOptions,
): Promise<{ sent: string[]; error?: Partial<Error> & { code?: string } }> {
  const sent: string[] = []
  const catalogs = options.catalogs ?? {}
  const disabled = options.disabled ?? {}
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    llm: {
      listModels: async (provider: string) => catalogs[provider] ?? [],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: (o: { provider: string; model: string }) => {
        sent.push(`${o.provider}/${o.model}`)
        return (async function* () { /* 无输出即可 */ })()
      },
    },
  }
  const pool = options.pool ?? {
    getAvailableAccount: async (provider: string) => (
      (options.expiries ?? {})[provider] === null ? null : { entry: { id: `${provider}-a1` }, credential: { token: 't' } }
    ),
    // ⚠️ 必须提供：firstModelOf 会调它过滤已关闭模型。
    disabledModelsFor: (provider: string) => (options.disabled ?? {})[provider] ?? new Set<string>(),
  }
  const adapter = new AutoAdapter(ctx as never, {
    accountPool: pool as never,
    now: () => 1_000,
    ttlMs: 0,
  })
  // 余额探测隔离：到期时刻由用例给定，避免真实网络。
  // ⚠️ 只桩 `expiryOf` 的**余额折算**部分对 selectProvider 不可见 ——
  //   故此处改为让 expiryOf 直接返回用例给定的时刻（selectProvider 仍会
  //   自行调用 firstModelOf 判定「目录是否有可调用模型」）。
  adapter.expiryOf = async (provider: string) => {
    const table = options.expiries ?? {}
    return table[provider] === null || table[provider] === undefined ? -1 : (table[provider] as number)
  }
  try {
    const call = await adapter.prepareCall('jet-hub-auto', 'auto')
    const iterable = call.stream({ messages: [userMessage()] } as never)
    // ⚠️ 必须**真正消费**这个 AsyncIterable：`ctx.llm.stream` 是在迭代时才被调用的，
    // 不 drain 就断言 `sent` 会得到空数组（这是本文件初版写法的坑）。
    for await (const _chunk of iterable) { /* noop */ }
    return { sent }
  } catch (error) {
    return { sent, error: error as { code?: string; name?: string; message?: string } }
  }
}

describe('auto：模型目录全空 / 全被关闭时不得发出别的 provider 的模型名', () => {
  it('用户关闭全部模型后，auto 不发出 `zcode/auto` 这种必然 404 的请求', async () => {
    const disabled = new Set(['GLM-5.3-Flash', 'GLM-5.3'])
    const { sent, error } = await dispatchThrough({
      // 真实 `listModels` 内部已 filter(!disabled) ⇒ 全关时返回空目录
      catalogs: { zcode: [], buddy: [{ id: 'deepseek-v4-flash', name: 'DS v4 Flash' }] },
      disabled: { zcode: disabled },
      expiries: { zcode: 5, buddy: 9 },
    })

    // ⛔ 回归前：sent = ['zcode/auto']（把字符串 'auto' 当成 zcode 的模型发出去）。
    expect(sent.some((s) => s === 'zcode/auto')).toBe(false)
    expect(sent.some((s) => s.endsWith('/auto'))).toBe(false)
    // 目录为空即「该 provider 没有可调用的模型」⇒ 要么退出候选，要么如实报错，
    // 绝不能把请求发往一个用户已明确禁用的模型。
    for (const target of sent) {
      expect(disabled.has(target.split('/')[1] ?? '')).toBe(false)
    }
    // 若报错，必须是清晰的本地错误，而不是让请求打上去再 404。
    if (sent.length === 0) {
      expect(error?.code).toBe('INVALID_MODEL' as never)
    }
  })

  it('源码级：兜底不得回落到 `AUTO_MODEL`（那会把模型名当 provider 的模型发出）', () => {
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // ❌ 回归前的两处：兜底取 AUTO_MODEL、以及把 AUTO_MODEL 当返回值。
    expect(code).not.toMatch(/AUTO_FALLBACK_MODELS\[provider\]\s*\?\?\s*AUTO_MODEL/)
    expect(code).not.toMatch(/disabled\.has\(fallback\)\s*\?\s*AUTO_MODEL\s*:\s*fallback/)
  })
})

describe('auto：账号都正常只是没有临期额度时，不得报「请先登录」', () => {
  it('全部 provider 都是永久/长期积分（NEVER）时，报错文案不误导为未登录', async () => {
    const { sent, error } = await dispatchThrough({
      catalogs: { buddy: [{ id: 'deepseek-v4-flash', name: 'DS v4 Flash' }] },
      expiries: { buddy: Number.POSITIVE_INFINITY },
    })
    // 账号正常 ⇒ 必须能发出请求（而不是 MISSING_CREDENTIAL）。
    expect(error?.code).not.toBe('MISSING_CREDENTIAL')
    expect(sent).toContain('buddy/deepseek-v4-flash')
  })

  it('排序：全部 NEVER 时仍应选出一个（只有 UNUSABLE 才剔除）', () => {
    // ❌ 回归前：全 NEVER ⇒ best 恒为 undefined ⇒ 整个 auto 不可用。
    expect(pickSoonestProvider([['buddy', Number.POSITIVE_INFINITY]])).toBe('buddy')
    expect(pickSoonestProvider([['buddy', Number.POSITIVE_INFINITY], ['loomy', Number.POSITIVE_INFINITY]]))
      .toBe('buddy')
    // UNUSABLE(-1) 仍然必须被剔除 —— 这是与上一条配套的另一半约定。
    expect(pickSoonestProvider([['buddy', -1], ['loomy', -1]])).toBeUndefined()
    // 临期优先的主约定不能被破坏。
    expect(pickSoonestProvider([['buddy', 900], ['loomy', 100]])).toBe('loomy')
  })
})

describe('auto：取消请求必须以 AbortError 结束，而不是降级成「请先登录」', () => {
  it('已 abort 的 signal 不得产出 MISSING_CREDENTIAL', async () => {
    const controller = new AbortController()
    controller.abort()
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async () => [],
        resolveModelInfo: async () => ({ provider: 'x', id: 'y' }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () { /* noop */ })()
        },
      },
    }
    const pool = {
      getAvailableAccount: async () => { throw new Error('探测失败') },
      disabledModelsFor: () => new Set<string>(),
    }
    const adapter = new AutoAdapter(ctx as never, { accountPool: pool as never, now: () => 1_000, ttlMs: 0 })
    // 余额探测在 abort 下也应立即中止，而不是折算成「该 provider 不可用」。
    adapter.expiryOf = async () => Number.POSITIVE_INFINITY

    let caught: { code?: string; name?: string } | undefined
    try {
      const call = await adapter.prepareCall('jet-hub-auto', 'auto', controller.signal)
      call.stream({ messages: [userMessage()] } as never)
    } catch (error) {
      caught = error as { code?: string; name?: string }
    }
    // ⛔ 回归前：code = 'MISSING_CREDENTIAL'、name = 'LlmError'、文案是「请先登录」。
    expect(caught?.code).not.toBe('MISSING_CREDENTIAL')
    expect(caught?.name === 'AbortError' || caught?.code === 'ABORTED').toBe(true)
    expect(sent).toHaveLength(0)
  })

  it('源码级：`expiryOf` 不得把已中止折算成 UNUSABLE', () => {
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // ❌ 回归前这一行让 abort 被吞成「该 provider 不可用」。
    expect(code).not.toMatch(/signal\?\.aborted\s*===\s*true\s*\)\s*return\s+UNUSABLE/)
  })
})

describe('auto：倍率解析必须有分隔符，不得把模型名里的 x 当倍率', () => {
  // ⚠️ 直接调用**生产函数**（已 export），不在测试里复刻正则 ——
  // 复刻会变成「测我的副本」，正是 AGENTS.md 第 8 条点名的同义反复。
  it('`Spark X2.5`（无倍率标注）解析为无标注，而不是 2.5 倍', () => {
    // ❌ 回归前：`/[×x]\s*(\d+(?:\.\d+)?)\s*$/i` ⇒ 返回 2.5。
    expect(priceFactorFromName('Spark X2.5')).toBe(Number.POSITIVE_INFINITY)
  })

  it('真实倍率标注仍能正确解析（含促销箭头形态）', () => {
    expect(priceFactorFromName('DeepSeek V4 Flash 0731 · x3.0')).toBeCloseTo(3.0)
    expect(priceFactorFromName('GLM 5.3 Flash · x0.8')).toBeCloseTo(0.8)
    expect(priceFactorFromName('Kimi k2.6 · x6.5')).toBeCloseTo(6.5)
    expect(priceFactorFromName('GLM 5.3 Flash · ×0.8')).toBeCloseTo(0.8)
    expect(priceFactorFromName('Hy4 preview · 免费')).toBe(0)
    // 无标注的模型名（不该被误判）
    expect(priceFactorFromName('GLM-5.3-Flash')).toBe(Number.POSITIVE_INFINITY)
    expect(priceFactorFromName('Hy4 preview')).toBe(Number.POSITIVE_INFINITY)
    // 促销形态（`formatCreditsRate`，buddy.ts:701）：取**促销后**的实际计费倍率。
    expect(priceFactorFromName('Deepseek-V4.1-Flash · x0.17→x0.03')).toBeCloseTo(0.03)
  })

  it('行为级：同池里「有倍率标注的便宜模型」必须胜过「名字里带 x 的贵模型」', async () => {
    // 这是用户可见的失效形态：初版会把 Spark X2.5 当 2.5 倍，于是 0.8 的模型
    // 排在它后面 —— auto「挑最便宜」反而挑了最贵的。
    const { sent, error } = await dispatchThrough({
      catalogs: {
        loomy: [
          { id: 'spark-x', name: 'Spark X2.5' },
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash · x0.8' },
        ],
      },
      expiries: { loomy: 100 },
    })
    expect(error?.code).not.toBe('MISSING_CREDENTIAL')
    expect(sent).toEqual(['loomy/glm-5.3-flash'])
  })
})

describe('auto：代表账号必须跳过正在限流的账号', () => {
  it('取代表账号时不得用空 modelId（会让限流过滤整体短路）', async () => {
    const modelIds: string[] = []
    const pool = {
      getAvailableAccount: async (_provider: string, model: string) => {
        modelIds.push(model)
        return { entry: { id: 'a1' }, credential: { token: 't' } }
      },
      disabledModelsFor: () => new Set<string>(),
    }
    const adapter = new AutoAdapter(
      {
        logger: { warn: () => {}, error: () => {} },
        llm: {
          listModels: async () => [{ id: 'm1', name: 'M1' }],
          resolveModelInfo: async () => ({ provider: 'p', id: 'm1' }),
          stream: () => (async function* () { /* noop */ })(),
        },
      } as never,
      { accountPool: pool as never, now: () => 1_000, ttlMs: 0 },
    )
    // ⚠️ 不打桩 expiryOf：本条就是要验「探测阶段」的取号参数。
    await adapter.expiryOf('buddy')
    expect(modelIds).toHaveLength(1)
    // ⛔ 回归前：modelIds = [''] ⇒ `if (modelId.length === 0) return true`
    //           ⇒ modelRateLimits 里所有限流标记被跳过（account-pool.ts:1049-1055）。
    expect(modelIds[0]).not.toBe('')
  })

  it('源码级：不得出现空 model 的 getAvailableAccount 取号', () => {
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/getAvailableAccount\(\s*provider\s*,\s*''\s*\)/)
  })
})

/**
 * ★★ 胜者必须在**将要派发的那个模型**上还有可用账号（真实缺陷，2026-10-07）。
 *
 * ## 缺陷机制
 *
 * 「额度耗尽」在账号池里**按 modelId 记账**（`entry.modelRateLimits[modelId]`；
 * codearts 的 benefit 免费额度耗尽就写在那里，`llm-adapter.ts:1290`）。而
 * **生产装配**注入的 `sharedExpiryProbe` 取号用的是「目录第一个模型」
 *（`index.ts` 的 `firstModelIdOf`：`models[0]?.id`），**不是** `firstModelOf`
 * 挑出来的那个（按倍率最便宜）⇒ 两者不同时，按 modelId 的过滤**整体失效**。
 *
 * ⚠️ 这**推翻**了 `index.ts` 那段「共享带来的语义松弛**已核实无害**」的注释：
 * 它假设 `probeModel` 不参与折算结果、故与派发无关 —— 但它**参与账号池的
 * 限流过滤**，而那正是「这个模型还能不能用」的判据。
 */
describe('★★ auto：胜者必须在将要派发的模型上仍有可用账号', () => {
  /** 目录：第一个 `glm-5.3-flash`（无倍率），第二个更便宜（x0.1）⇒ firstModelOf 选后者。 */
  const CATALOG = [
    { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.1' },
  ]

  /** 池：账号在 `blocked` 这个模型上额度已尽（= 真实 `modelRateLimits` 判据）。 */
  const gatedPool = (blocked: string) => ({
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async (_p: string, modelId: string) => (
      modelId === blocked ? null : { entry: { id: 'A' }, credential: { token: 't' } }
    ),
  })

  const makeAuto = (pool: unknown) => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async () => CATALOG,
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () { /* noop */ })()
        },
      },
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: pool as never,
      now: () => 1_000,
      ttlMs: 0,
    })
    // 余额折算隔离：只桩「最早失效时刻」，取号/可用性判据仍走真实逻辑。
    adapter.expiryOf = async (provider: string) => (provider === 'codearts' ? 100 : -1)
    return { adapter, sent }
  }

  /**
   * 驱动真实链路，只回报**逃出来的错误**。
   *
   * ⚠️ 返回类型必须带 `name` / `message`（不能只有 `code`）：本组有两条用例分别断言
   * `error.name === 'AbortError'` 与 `error.message` 含上游 499 报文，只声明 `code`
   * 会让那两条报 `TS2339`（本文件不在 `tsconfig.tests.json` 的 include 里，长期未发现）。
   */
  const run = async (adapter: AutoAdapter): Promise<Partial<Error> & { code?: string } | undefined> => {
    try {
      const call = await adapter.prepareCall('jet-hub-auto', 'auto')
      for await (const _ of call.stream({ messages: [userMessage()] } as never)) { /* drain */ }
      return undefined
    } catch (error) {
      return error as Partial<Error> & { code?: string }
    }
  }

  it('★★ 最便宜的模型上额度已尽 ⇒ 不得选中该 provider（退出候选，不静默成功）', async () => {
    // ⛔ 回归前：`expiryOf` 只报临期值（100）⇒ codearts 当选 ⇒ 请求发往
    //    `deepseek-v4.1-flash`，而该模型上账号额度已尽 ⇒ 上游必然失败。
    //    修后：该 provider 退出候选 ⇒ 无候选 ⇒ 如实报错（而不是发一个必然失败的请求）。
    const { adapter, sent } = makeAuto(gatedPool('deepseek-v4.1-flash'))
    const error = await run(adapter)
    expect(sent, '该模型上无可用账号 ⇒ 不得发请求').toEqual([])
    // ⚠️ 报错码沿用「无可用候选」的既有语义（与 zcode 余额 0 被剔除时同一条路径）。
    expect(error?.code).toBe('MISSING_CREDENTIAL')
  })

  it('★ 对照：不设额度标记 ⇒ 正常选中（证明差异来自可用性，不是别的）', async () => {
    const { adapter, sent } = makeAuto(gatedPool('__none__'))
    await run(adapter)
    expect(sent).toEqual(['codearts/deepseek-v4.1-flash'])
  })

  it('★ 只标记**别的**模型 ⇒ 不影响（判据按将要派发的模型精确匹配）', async () => {
    const { adapter, sent } = makeAuto(gatedPool('glm-5.3-flash'))
    await run(adapter)
    // 被标记的是 `glm-5.3-flash`，而实际要派发 `deepseek-v4.1-flash` ⇒ 仍可选中。
    expect(sent).toEqual(['codearts/deepseek-v4.1-flash'])
  })

  it('★ 池未实现 `getAvailableAccount` ⇒ 跳过过滤（不可把整池误剔除）', async () => {
    const { adapter, sent } = makeAuto({ disabledModelsFor: () => new Set<string>() })
    await run(adapter)
    expect(sent).toEqual(['codearts/deepseek-v4.1-flash'])
  })

  it('★ 池查询抛错 ⇒ 视为可用（一次异常不得让渠道整体消失）', async () => {
    const { adapter, sent } = makeAuto({
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => { throw new Error('池异常') },
    })
    await run(adapter)
    expect(sent).toEqual(['codearts/deepseek-v4.1-flash'])
  })

  it('★★ 中止必须逃逸：池抛 `{ code: "ABORTED" }`（**无 `name`**）也要中止', async () => {
    // ⚠️⚠️ 真实缺陷（对抗审计实测证伪，2026-10-07）：我上一版只判 `name === 'AbortError'`，
    //    注释还声称「与 `filterByModelAvailability` 同口径」—— 而后者用共享
    //    `isAbortLike`，判**三条**（`signal.aborted` / `name` / **`code === 'ABORTED'`**）。
    //    只判 `name` 时，`code` 形态的中止会被**吞成「视为可用」并继续发请求** ——
    //    正是本仓库反复记录的那类缺陷（「同族判据必须逐格同构」）。
    const { adapter, sent } = makeAuto({
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => { throw Object.assign(new Error('cancelled'), { code: 'ABORTED' }) },
    })
    const error = await run(adapter)
    expect(sent, '中止不得继续发请求').toEqual([])
    expect(error?.code, '应原样上抛该错误（而不是吞掉）').toBe('ABORTED')
  })

  it('★ 中止必须逃逸：池抛 `AbortError`（`name` 形态）', async () => {
    const { adapter, sent } = makeAuto({
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      },
    })
    const error = await run(adapter)
    expect(sent, '中止不得继续发请求').toEqual([])
    expect(error?.name).toBe('AbortError')
  })

  it('★★ 中止必须逃逸：池抛上游网关 499 报文（`aborted request HTTP_499`）', async () => {
    // ⚠️ 同族判据逐格同构（本仓硬要求）：`aggregate-adapter.ts` 的 `isAbortLike`
    //    已扩到**四条**，本处（`hasUsableAccountFor`）必须同步 —— 否则同一份报文
    //    在两个 provider 上被判成不同类别。
    // ⚠️ 关键约束：错误**不带** `name: 'AbortError'` / `code: 'ABORTED'`，
    //    否则命中的是旧判据，第四条的覆盖是**假的**（假覆盖教训）。
    const { adapter, sent } = makeAuto({
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => {
        throw new Error('provider: client has aborted request HTTP_499')
      },
    })
    const error = await run(adapter)
    expect(sent, '499 中止不得继续发请求').toEqual([])
    expect(error?.message).toContain('aborted request')
  })

  it('★ 反例：池抛普通异常 ⇒ 视为可用（第四条的判据不得恒真）', async () => {
    const { adapter, sent } = makeAuto({
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => { throw new Error('pool exploded') },
    })
    await run(adapter)
    expect(sent, '普通异常应被吞成「视为可用」并继续').toHaveLength(1)
  })
})

describe('★★ auto：`dispatchTargetOf` 的 catch 也必须让 499 中止逃逸', () => {
  /**
   * ⚠️⚠️ 这是 auto 侧**第二处**内联中止判据（第一处是 `hasUsableAccountFor`）。
   *
   * PR #87 的 `c3d9e9c` **只补了第一处** —— 审计实测（2026-10-12）：本处
   * 仍是 `name`/`code` 两条，499 报文会被吞成「倒计时缺席」后**照常发请求**。
   * 本分支按「同族判据必须逐格同构」补齐，并**单独锁死**。
   *
   * ⚠️ 落点定位（实测确认，别搞错）：`selectProvider` 的候选循环会调**多次**
   *    `expiryOf`（本用例目录下实测 5 次）且那处**没有** try/catch（异常直接冒泡）；
   *    带 catch 的是 `dispatchTargetOf`。故用**调用栈**定位那一次。
   *    ⚠️ 不用「第 N 次调用」定位：按次数定位在候选数变化时会**假绿**
   *    （我在另一分支上实测踩过：selectProvider 那处没有 catch，
   *      早抛会让 prepareCall 直接 reject，测到的就不是这个 catch）。
   */
  const makeExpiryCtx = () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.1' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () { /* noop */ })()
        },
      },
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'A' }, credential: { token: 't' } }),
      } as never,
      now: () => 1_000,
      ttlMs: 0,
    })
    return { adapter, sent }
  }

  /** 只在 `dispatchTargetOf` 那次 `expiryOf` 抛错（用调用栈定位，与次数解耦）。 */
  const armDispatchExpiryCall = (adapter: AutoAdapter, error: Error): void => {
    adapter.expiryOf = async () => {
      const stack = new Error().stack ?? ''
      if (stack.includes('dispatchTargetOf')) throw error
      return 100
    }
  }

  const drain = async (adapter: AutoAdapter): Promise<{ message?: string } | undefined> => {
    try {
      const call = await adapter.prepareCall('jet-hub-auto', 'auto')
      for await (const _ of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* drain */ void _ }
      return undefined
    } catch (error) {
      return error as { message?: string }
    }
  }

  it('★ `dispatchTargetOf` 的 `expiryOf` 抛 499 ⇒ 必须逃逸，不得吞成「倒计时缺席」', async () => {
    const { adapter, sent } = makeExpiryCtx()
    armDispatchExpiryCall(adapter, new Error('provider: client has aborted request HTTP_499'))
    const caught = await drain(adapter)
    expect(caught?.message, '499 必须原样上抛（不得吞成倒计时缺席）').toContain('aborted request')
    expect(sent, '中止后不得继续发请求').toEqual([])
  })

  it('★ 反例：同一处抛普通异常 ⇒ 只让倒计时缺席、**照常发请求**（判据不得恒真）', async () => {
    const { adapter, sent } = makeExpiryCtx()
    armDispatchExpiryCall(adapter, new Error('余额接口抖动'))
    const caught = await drain(adapter)
    expect(caught, '普通异常不该上抛').toBeUndefined()
    expect(sent, '普通异常不该阻断请求').toHaveLength(1)
  })
})

/**
 * ★★ 带图**改道**路径也必须按将要派发的模型复核可用性（真实缺陷，2026-10-07）。
 *
 * ⚠️ 这是同一缺陷的**第三处实例**（独立审计实测证伪）：主选型路径
 *（`selectProvider`）与聚合建池路径（`filterByModelAvailability`）都已补复核，
 * 但 `prepareCall` 里选 `imageTarget` 的那个循环**漏了** ⇒ 一个「支持图片但额度
 * 已尽」的渠道仍会被选成改道目标，带图请求发出去必然失败。
 *
 * 可达性真实：buddy 既声明 `['text','image']`（`buddy-adapter.ts:1272`）
 * **又**会写 `modelRateLimits`（`:1922`）。
 */
describe('★★ auto：带图改道路径也必须按派发模型复核可用性', () => {
  /** buddy 不支持图片（当胜者）、codearts 支持图片但额度已尽。 */
  const makeImageWorld = (codeartsBlocked: boolean) => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        // ⚠️ `providerSupportsImages` 读的是 **`listModels` 返回的 `inputModalities`**
        //（`auto-adapter.ts:429-433`），**不是** `resolveModelInfo` —— 我第一版桩错了位置，
        // 导致「全池都不支持图片」而对照组也失败。
        listModels: async (p: string) => (p === 'codearts'
          ? [{ id: 'vision-model', name: 'Vision', inputModalities: ['text', 'image'] }]
          : [{ id: 'text-model', name: 'Text', inputModalities: ['text'] }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () { /* noop */ })()
        },
      },
    }
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async (p: string, modelId: string) => (
        codeartsBlocked && p === 'codearts' && modelId === 'vision-model'
          ? null
          : { entry: { id: 'a1' }, credential: { token: 't' } }
      ),
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: pool as never,
      now: () => 1_000,
      ttlMs: 0,
    })
    // buddy 临期更早 ⇒ 它当选（但它不支持图片）；codearts 是唯一能收图的候选。
    adapter.expiryOf = async (provider: string) => (provider === 'buddy' ? 100 : 900)
    return { adapter, sent }
  }

  /** ⚠️ 必须用 `makeImageWorld` 闭包里的 `sent`（我第一版在这里新建了一个，导致断言恒空）。 */
  const runWithImage = async (adapter: AutoAdapter): Promise<void> => {
    const call = await adapter.prepareCall('jet-hub-auto', 'auto')
    // 带图消息 ⇒ 触发 stream 闭包里的改道逻辑。
    for await (const _ of call.stream({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA==' } },
        ],
      }],
    } as never)) { /* drain */ }
  }

  it('★★ 唯一能收图的渠道额度已尽 ⇒ 不得改道过去（不得发必然失败的请求）', async () => {
    const { adapter, sent } = makeImageWorld(true)
    // ⚠️ 额度已尽的 codearts 被剔除 ⇒ 无改道目标 ⇒ 如实报错（而不是发一个必然失败的请求）。
    await expect(runWithImage(adapter)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(sent, 'codearts 在 vision-model 上无可用账号 ⇒ 不得改道过去').toEqual([])
  })

  it('★ 对照：不设额度标记 ⇒ 正常改道到支持图片的 codearts', async () => {
    const { adapter, sent } = makeImageWorld(false)
    await runWithImage(adapter)
    expect(sent).toEqual(['codearts/vision-model'])
  })
})

/**
 * ★★ B 方案：目标「收下请求却零输出」时顺位改道下一个 provider（issue IKJW31）。
 *
 * ## 缺陷机制
 *
 * 上游声明的窗口比真实墙大（loomy 的 `spark-x` 虚报 1M、真实 256K）⇒ 宿主按
 * 虚高窗口打包 ⇒ 越墙后上游**收下请求但 0 输出** + `finish_reason=length` ⇒
 * 插件报 `max-tokens`，而 DSH 对它**不自动重试** ⇒ 整轮静默失败。
 *
 * A 方案修了已知的那一处虚报；**本组守住与「哪一家虚报」无关的运行时兜底**。
 *
 * ## ⚠️ 两条方向相反的边界（本组必须同时守住）
 *
 * 1. `max-tokens` + **零输出** ⇒ 改道（否则静默失败，即本 issue）；
 * 2. `max-tokens` + **有输出** ⇒ **绝不改道**（否则丢掉已产出的正文 —— 而那才是
 *    `max-tokens` 更常见的含义：「正常答到半截撞了输出上限」）。
 *
 * 第 2 条是本次改动的最大风险点，故它与第 1 条同等重要。两处都用**真实调用链**
 * （`prepareCall` → `call.stream`）驱动，不打桩内部私有方法。
 */
describe('★★ auto：零输出撞墙时改道下一个 provider（B 方案）', () => {
  /** 让 `loomy` 最先当选（临期最早），`zcode` 次之。 */
  const CATALOGS = {
    loomy: [{ id: 'spark-x', name: 'Spark X2.5 · x0.1' }],
    zcode: [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash · x0.8' }],
  }

  /**
   * 造一个世界：`loomy` 的流按 `loomyChunks` 产出，`zcode` 正常出正文。
   *
   * ⚠️ `now` 是**可变**的（返回对象上的 `setNow`），用来验证冷却「到期自动恢复」
   * 与「冷却期内跳过」两种状态 —— 用固定时钟无法区分它们。
   */
  function makeWorld(loomyChunks: TestChunk[]) {
    const sent: string[] = []
    let now = 1_000_000
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => CATALOGS[provider as keyof typeof CATALOGS] ?? [],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          const chunks: TestChunk[] = o.provider === 'loomy'
            ? loomyChunks
            : [
                { type: 'block-start', index: 0, blockType: 'text' },
                { type: 'text-delta', index: 0, text: 'ok' },
                { type: 'finish', reason: { kind: 'stop' } },
              ]
          return (async function* () { for (const c of chunks) yield c })()
        },
      },
    }
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { token: 't' } }),
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: pool as never,
      now: () => now,
      ttlMs: 0,
    })
    // loomy 临期更早 ⇒ 它当选；其余 provider 无候选（-1 = UNUSABLE）。
    adapter.expiryOf = async (provider: string) => (provider === 'loomy' ? 100 : provider === 'zcode' ? 200 : -1)
    return { adapter, sent, setNow: (v: number) => { now = v } }
  }

  /**
   * 一个 chunk 的**最小形状**（本文件的判据只读 `type` 与 `reason.kind`）。
   *
   * ⚠️ 但真实的 block 帧还带 `index` / `blockType` / `text` 等字段，用例必须能把它们
   * 传进来 —— 否则「正文 vs 零输出」这一组用例根本表达不出「有输出」。故这里用
   * 索引签名兜住额外字段（旧写法 `{ type; reason? }` 会让这两条字面量报 `TS2353`；
   * 本文件不在 `tsconfig.tests.json` 的 include 里，所以一直没被发现）。
   */
  interface TestChunk {
    type: string
    reason?: { kind?: string }
    [extra: string]: unknown
  }

  /** 驱动真实链路并收集**最终看到的** chunk 序列。 */
  async function run(adapter: AutoAdapter): Promise<TestChunk[]> {
    const seen: TestChunk[] = []
    const call = await adapter.prepareCall('jet-hub-auto', 'auto')
    for await (const chunk of call.stream({ messages: [userMessage()] } as never)) {
      seen.push(chunk as TestChunk)
    }
    return seen
  }

  /** 上游越墙的真实 chunk 形态：一个 usage + `max-tokens` 终止帧，**零内容**。 */
  const WALL_HIT = [
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 90 } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]

  it('★★ 零输出撞墙 ⇒ 改道下一个 provider 重发（不再静默失败）', async () => {
    const { adapter, sent } = makeWorld(WALL_HIT)
    const seen = await run(adapter)
    // 先打 loomy 撞墙，再改道 zcode 成功。
    expect(sent).toEqual(['loomy/spark-x', 'zcode/glm-5.3-flash'])
    // ⚠️ 关键：**不得**把 loomy 那个 max-tokens 终止帧透给 harness ——
    //    透出去 harness 就认为本轮结束了（它不重试 max-tokens），改道白做。
    expect(seen.filter((c) => c.type === 'finish').map((c) => c.reason?.kind)).toEqual(['stop'])
    expect(seen.some((c) => c.type === 'usage')).toBe(false)
    // 用户看到的是 zcode 的正文。
    expect(seen.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('★★ 反向：`max-tokens` 但**有输出** ⇒ 绝不改道（否则丢正文）', async () => {
    // 这是 `max-tokens` 更常见的含义：模型答到半截撞了**输出上限**，应当原地续写。
    const { adapter, sent } = makeWorld([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '半截回答' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    const seen = await run(adapter)
    // ⛔ 若判据漏了「零输出」这一条，sent 会变成两个（正文被丢弃后重发）。
    expect(sent, '有输出时不得改道').toEqual(['loomy/spark-x'])
    expect(seen.some((c) => c.type === 'text-delta')).toBe(true)
    expect(seen.filter((c) => c.type === 'finish').map((c) => c.reason?.kind)).toEqual(['max-tokens'])
  })

  it('★ 正常 stop ⇒ 不改道（不得为「没有撞墙」的情形多发请求）', async () => {
    const { adapter, sent } = makeWorld([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const seen = await run(adapter)
    expect(sent).toEqual(['loomy/spark-x'])
    expect(seen.filter((c) => c.type === 'finish').map((c) => c.reason?.kind)).toEqual(['stop'])
  })

  it('★ 改道后**下一个请求**跳过该目标（跨请求冷却，防 60 秒选型缓存三连撞）', async () => {
    const { adapter, sent } = makeWorld(WALL_HIT)
    await run(adapter)
    expect(sent).toEqual(['loomy/spark-x', 'zcode/glm-5.3-flash'])

    // ⚠️ 第 2 个请求：`ttlMs: 0` ⇒ 每次都重新选型。loomy 已进冷却 ⇒ 不得再撞。
    //    （报障实测 t14/t15/t16 在 46 秒内三连撞同一堵墙，正是缺了这一层。）
    sent.length = 0
    await run(adapter)
    expect(sent, 'loomy 在冷却期内不得再被选中').toEqual(['zcode/glm-5.3-flash'])
  })

  it('★ 冷却到期后自动恢复（不得把一次误判永久固化）', async () => {
    const { adapter, sent, setNow } = makeWorld(WALL_HIT)
    await run(adapter)
    sent.length = 0
    // 越过 10 分钟冷却窗口 ⇒ loomy 重新参与候选（临期更早，故它又当选）。
    setNow(1_000_000 + 10 * 60 * 1000 + 1)
    await run(adapter)
    expect(sent, '冷却到期后应重新尝试 loomy').toEqual(['loomy/spark-x', 'zcode/glm-5.3-flash'])
  })

  it('★ 池内无其他候选 ⇒ 如实透出 max-tokens，不吞掉失败', async () => {
    // 只有 loomy 可用 ⇒ 无从改道 ⇒ 必须如实上报（不得静默成功、不得伪装 stop）。
    const { adapter, sent } = makeWorld(WALL_HIT)
    adapter.expiryOf = async (provider: string) => (provider === 'loomy' ? 100 : -1)
    const seen = await run(adapter)
    expect(sent).toEqual(['loomy/spark-x'])
    expect(seen.filter((c) => c.type === 'finish').map((c) => c.reason?.kind)).toEqual(['max-tokens'])
  })

  it('★ 不会改道回自己（否则会立刻再撞一次同一堵墙）', async () => {
    const { adapter, sent } = makeWorld(WALL_HIT)
    // zcode 也判 UNUSABLE ⇒ 唯一候选就是 loomy，而它已被排除 ⇒ 不得重发。
    adapter.expiryOf = async (provider: string) => (provider === 'loomy' ? 100 : -1)
    await run(adapter)
    // ⛔ 若 `replaceAfterZeroOutput` 没排除当前目标，sent 会是两个 loomy。
    expect(sent.filter((s) => s === 'loomy/spark-x')).toHaveLength(1)
  })

  /**
   * ★★ 冷却必须**穿透 60 秒选型缓存**（否则本方案形同虚设）。
   *
   * ⚠️ 上面那组用例都用 `ttlMs: 0`（每次真选型），**测不出这个缺陷**——
   * 而生产用的是 `AUTO_CHOICE_TTL_MS`（60 秒）。缺了这一层时，每个请求都会先按
   * 缓存**撞一次同一堵墙**（撞完才改道），「别再撞同一堵墙」的价值全部落空。
   * 报障实测 t14/t15/t16 在 46 秒内三连撞，正是这个形态。
   *
   * ⚠️ 故本条刻意**不传 `ttlMs`**（用生产默认值），这是它与上面几条的关键区别。
   */
  it('★★ 冷却必须穿透 60 秒选型缓存（生产 TTL 下不得再撞一次）', async () => {
    const sent: string[] = []
    let now = 1_000_000
    const catalogs: Record<string, Array<{ id: string; name: string }>> = {
      loomy: [{ id: 'spark-x', name: 'Spark X2.5 · x0.1' }],
      zcode: [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash · x0.8' }],
    }
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async (provider: string) => catalogs[provider] ?? [],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          const chunks = o.provider === 'loomy'
            ? WALL_HIT
            : [
                { type: 'block-start', index: 0, blockType: 'text' },
                { type: 'text-delta', index: 0, text: 'ok' },
                { type: 'finish', reason: { kind: 'stop' } },
              ]
          return (async function* () { for (const c of chunks) yield c })()
        },
      },
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { token: 't' } }),
      } as never,
      now: () => now,
      // ⚠️ **刻意不传 ttlMs** ⇒ 用生产默认 60 秒缓存（本条的考点）。
    })
    adapter.expiryOf = async (p: string) => (p === 'loomy' ? 100 : p === 'zcode' ? 200 : -1)

    const run = async () => {
      const call = await adapter.prepareCall('jet-hub-auto', 'auto')
      for await (const _ of call.stream({ messages: [userMessage()] } as never)) { /* drain */ }
    }

    await run()
    expect(sent).toEqual(['loomy/spark-x', 'zcode/glm-5.3-flash'])

    // 第 2 个请求：仍在 60 秒缓存窗口内（now 未动）。
    // ⛔ 若 `ensureChoice` 不查冷却，这里会**又撞一次 loomy**（缓存命中）。
    sent.length = 0
    await run()
    expect(sent, '缓存窗口内也不得再撞冷却中的目标').toEqual(['zcode/glm-5.3-flash'])
  })
})

/**
 * ★★ 徽标的临期倒计时必须属于**实际发往的渠道**（真实缺陷，PR !84 复审实测）。
 *
 * ## 缺陷机制
 *
 * 徽标的三要素是「实际用了谁（渠道+模型）+ 倍率 + 临期倒计时」。其中渠道/模型与倍率
 * 都取自**本次真正发出去的目标**，但倒计时原实现取的是 `selectProvider` 顺带记下的
 * `lastExpiryAt` —— 那是**主胜者**的失效时刻。
 *
 * 带图请求会让二者**分叉**：主胜者不支持图片时改道到「支持图片且临期最早」的另一个
 * 渠道（`prepareCall` 里的 `imageTarget`）。此时徽标显示 provider = 改道后的渠道，
 * 而倒计时显示主胜者的到期时间 ⇒ **张冠李戴**：用户看到「CodeArts 的额度 12:00 过期」，
 * 而 12:00 其实是 CodeBuddy 的额度作废时间，据此做的「先烧哪个」判断是错的。
 *
 * 实测（修前）：改道到 codearts（真实临期 `900`）后，徽标拿到的 `expiryAt` 是主胜者
 * buddy 的 `100`。
 *
 * ## 为什么必须驱动真实调用链
 *
 * 倒计时在 `dispatchTargetOf` → `dispatch` 之间传递，直接调私有方法会绕过真实路径
 * （PR !66 的教训）。故这里用 `prepareCall` + 带图消息触发改道。
 */
describe('★★ auto：徽标倒计时必须属于实际发往的渠道（带图改道不张冠李戴）', () => {
  /** buddy 不支持图片（当主胜者）；codearts 支持图片（当改道目标）。 */
  const makeImageWorld = () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async (p: string) => (p === 'codearts'
          ? [{ id: 'vision-model', name: 'Vision · x0.03', inputModalities: ['text', 'image'] }]
          : [{ id: 'text-model', name: 'Text · x0.29', inputModalities: ['text'] }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () { /* noop */ })()
        },
      },
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { token: 't' } }),
      } as never,
      now: () => 1_000,
      ttlMs: 0,
    })
    // ⚠️ 两个渠道的临期**刻意不同**：buddy(主胜者)=100、codearts(改道目标)=900。
    //    只有它们不同，才能区分「倒计时取自谁」。
    adapter.expiryOf = async (provider: string) => (provider === 'buddy' ? 100 : 900)
    return { adapter, sent }
  }

  const runWithImage = async (adapter: AutoAdapter): Promise<void> => {
    const call = await adapter.prepareCall('jet-hub-auto', 'auto')
    for await (const _ of call.stream({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA==' } },
        ],
      }],
    } as never)) { /* drain */ }
  }

  it('★★ 改道后 expiryAt 是**改道目标**的临期时刻，不是主胜者的', async () => {
    const { adapter, sent } = makeImageWorld()
    await runWithImage(adapter)

    // 前置断言：确实走了改道路径（否则本用例会因「没改道」而变成同义反复）。
    expect(sent, '应当改道到支持图片的 codearts').toEqual(['codearts/vision-model'])

    const state = adapter.autoState()
    expect(state.lastDecision?.provider).toBe('codearts')
    expect(state.lastDecision?.viaImageFallback).toBe(true)
    // ⛔ 修前这里拿到 100（主胜者 buddy 的），徽标会显示 buddy 的到期时间。
    expect(state.lastDecision?.expiryAt, '倒计时必须属于实际发往的 codearts').toBe(900)
    // ⚠️ 同时确认主胜者的时刻**没有被污染**（两个字段语义不同，不能混用）。
    expect(state.lastWinnerExpiryAt, '主胜者时刻仍是 buddy 的').toBe(100)
  })

  it('★ 对照：不带图 ⇒ 正常路径，倒计时就是主胜者的', async () => {
    const { adapter, sent } = makeImageWorld()
    const call = await adapter.prepareCall('jet-hub-auto', 'auto')
    for await (const _ of call.stream({ messages: [userMessage()] } as never)) { /* drain */ }

    expect(sent, '不带图 ⇒ 主胜者 buddy 当选').toEqual(['buddy/text-model'])
    const state = adapter.autoState()
    expect(state.lastDecision?.provider).toBe('buddy')
    expect(state.lastDecision?.expiryAt, '正常路径两者同源（都是 buddy）').toBe(100)
  })
})

/**
 * ★★ 徽标的**倍率表**（`priceByModel` / `rememberPrice` / `priceOf` / `autoState`）接线。
 *
 * ## 为什么单独守（PR !84 复审的系统性变异扫描，2026-10-11）
 *
 * 用「短路成空实现」逐格扫描本 PR 的新增分支时，发现 `auto-adapter.ts` 里这四处
 * **全部零守卫**（改坏后相关 41 条用例全绿）：
 *
 * | 变异 | 后果 |
 * |---|---|
 * | `rememberPrice` 的键丢掉 provider 前缀 | **同名模型跨渠道串价**（buddy 的 x0.29 被当成 codearts 的价） |
 * | `priceOf` 的读侧丢掉 provider 前缀 | 同上（读写两侧**必须**同构） |
 * | `autoState()` 里 `priceOf` 不转发 | 徽标**永远没有倍率** —— 正是用户报障「没倍率显示？」的形态 |
 *
 * ⚠️ 「同名模型跨渠道串价」是真实可达的：buddy / codearts / loomy / zcode 的目录里
 * 都有 `deepseek-v4.1-flash`、`glm-5.3-flash` 这类**同名**模型，而它们的倍率不同
 *（例如 buddy x0.29 / codearts x0.03）。表键不含渠道时，先写入的那家会把另一家的
 * 价覆盖掉 —— 徽标于是显示一个**不属于实际渠道**的倍率（与「编造倍率」同类的误导）。
 */
describe('★★ auto：徽标倍率表必须按「渠道 + 模型」键控（不得跨渠道串价）', () => {
  /** 两个渠道各有同名模型，倍率刻意不同。 */
  const CATALOG = {
    buddy: [{ id: 'shared-model', name: 'Shared · x0.29', inputModalities: ['text'] }],
    codearts: [{ id: 'shared-model', name: 'Shared · x0.03', inputModalities: ['text'] }],
  }

  const makeAdapter = () => {
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async (p: string) => (CATALOG as Record<string, unknown[]>)[p] ?? [],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { token: 't' } }),
      } as never,
      now: () => 1_000,
      ttlMs: 0,
    })
    // 让 codearts 临期更早 ⇒ 它当选，从而 `firstModelOf` 会为它记下 0.03。
    adapter.expiryOf = async (provider: string) => (provider === 'codearts' ? 100 : 900)
    return adapter
  }

  it('★★ 同名模型在不同渠道上价不同 ⇒ 查询必须区分渠道（不得串价）', async () => {
    const adapter = makeAdapter()
    // 走真实选型路径，让 `firstModelOf` 真的把倍率记进表里。
    await adapter.prepareCall('jet-hub-auto', 'auto')

    // ⚠️ 选型会为**每个候选渠道**探测（`selectProvider` 遍历 `AUTO_PROVIDERS`），
    //    故两家都会被记下 —— 关键是**各自的价互不覆盖**。
    expect(adapter.priceOf('codearts', 'shared-model'), 'codearts 的倍率').toBeCloseTo(0.03)
    // ⛔ 键不含渠道时，这一格会**串成 codearts 的 0.03**（buddy 明明是 x0.29）。
    expect(adapter.priceOf('buddy', 'shared-model'), 'buddy 必须仍是自己的 x0.29').toBeCloseTo(0.29)
  })

  it('★★ autoState() 必须转发 priceOf（否则徽标永远没有倍率）', async () => {
    const adapter = makeAdapter()
    await adapter.prepareCall('jet-hub-auto', 'auto')

    const state = adapter.autoState()
    // ⛔ 这一格是用户报障「没倍率显示？」的直接根因形态。
    expect(state.priceOf('codearts', 'shared-model'), 'autoState 必须转发倍率查询').toBeCloseTo(0.03)
    // 且**逐渠道区分**：同一个 modelId 在另一家上是另一个价（串价就会两者相等）。
    expect(state.priceOf('buddy', 'shared-model'), '同名模型不得跨渠道串价').toBeCloseTo(0.29)
  })

  it('★ 未记过的「渠道 + 模型」组合回 undefined（不猜、不回落）', () => {
    const adapter = makeAdapter()
    // 表是空的：刚重启、还没走过选型 —— 属**正常**情形，调用方据此不显示倍率。
    expect(adapter.priceOf('buddy', 'never-seen')).toBeUndefined()
    expect(adapter.autoState().priceOf('codearts', 'never-seen')).toBeUndefined()
  })
})

/**
 * ★★ `auto` 的目录契约与**实际发出目标**的最小形状（复审变异扫描出的另 2 处零守卫）。
 *
 * ## 为什么守这两条（系统扫描：全量 7204 条里改动后**零新增失败**）
 *
 * | 变异 | 修前结果 | 后果 |
 * |---|---|---|
 * | `listAllModels()` 返回 `[]` | GREEN | `fullCatalogIds` 拿不到 id ⇒ 「全部已关闭」判据失效（见 `provider.status`） |
 * | `lastDispatch.model` 恒空串 | GREEN | 胶囊显示「自动 → CodeArts」**但没有模型名** —— 三要素缺一 |
 *
 * ⚠️ 第二条尤其要紧：**模型名**是用户判断「这次到底在用哪个模型」的唯一依据
 *（provider 名只到渠道粒度，同一渠道下有多个模型）。而它是三要素里唯一
 * 没有任何用例断言过的一个（provider / 倍率 / 倒计时都有守卫）。
 */
describe('★★ auto：目录契约与 lastDispatch 的 model 字段', () => {
  const makeAdapter = () => {
    const ctx = {
      logger: { warn: () => {}, error: () => {} },
      llm: {
        listModels: async (p: string) => (p === 'buddy'
          ? [{ id: 'real-model-id', name: 'Real Model · x0.1', inputModalities: ['text'] }]
          : []),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    }
    const adapter = new AutoAdapter(ctx as never, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { token: 't' } }),
      } as never,
      now: () => 1_000,
      ttlMs: 0,
    })
    adapter.expiryOf = async (provider: string) => (provider === 'buddy' ? 100 : -1)
    return adapter
  }

  it('★★ listAllModels 必须给出 auto 那一个模型（否则「全部已关闭」判据失效）', () => {
    const adapter = makeAdapter()
    const all = adapter.listAllModels()
    expect(all.length, 'auto 必须播报自己的那一个模型').toBe(1)
    expect(all[0]?.id).toBe('auto')
    expect(all[0]?.name, '展示名不得为空（DSH 校验要求）').toBeTruthy()
    // 与 `listModels` 同形（auto 不参与用户黑名单，故两者返回相同）。
    expect(all[0]?.id).toBe('auto')
  })

  it('★★ lastDispatch 必须记下**真实模型名**（胶囊的「在用哪个模型」全靠它）', async () => {
    const adapter = makeAdapter()
    const call = await adapter.prepareCall('jet-hub-auto', 'auto')
    for await (const _ of call.stream({ messages: [userMessage()] } as never)) { /* drain */ }

    const decided = adapter.autoState().lastDecision
    expect(decided?.provider).toBe('buddy')
    // ⛔ 恒空串时这里是 `''` —— 胶囊会显示「自动 → buddy」而没有模型名。
    expect(decided?.model, '必须记下真实 modelId（不是空串）').toBe('real-model-id')
  })
})

/**
 * ★★ `resolveModel` 不得阻塞模型目录加载（用户报障 2026-10-18：
 * 「模型选择列表加载了 1 分多钟」）。
 *
 * ## 决定性实测证据
 *
 * ```
 * [buildModelCatalog] provider=jet-hub-auto 全部完成：listModels=1ms，总耗时=70770ms，模型数=1
 * ```
 *
 * `listModels` 只花 1ms，**70 秒全在 `resolveModelInfo`**：原实现
 * `resolveModel()` → `await this.ensureChoice()` → `selectProvider()` → 遍历全池调
 * `expiryOf` → **每渠道一次余额查询**。而目录加载时选型缓存**必空** ⇒ 每轮全池重算。
 *
 * ## 判据的三条纪律（本文件反复踩过）
 *
 * 1. **`inputModalities` 断言是恒真的**（降级与真实两条 return 都声明 text+image）
 *    ⇒ 它只能守「怎么又不支持图片了」，**不能**用来判「走了哪条路径」。判路径必须
 *    看真实路径独有的指纹：`contextWindow = REAL_INFO_CONTEXT_WINDOW` 与
 *    `reasoning.efforts`（降级那份是写死的保守窗口且不带档位）。
 *    两个指纹**必须同时断言**（单指纹会在将来给降级路径补上档位时静默变恒绿）。
 * 2. **「永不 resolve 的 `expiryOf`」是唯一能证明「没 await 选型」的夹具**
 *    —— 让余额探测挂住，若实现仍 await 全池选型，`resolveModel` 会一直挂着。
 * 3. **`now` 注入时钟是本组「把时间推过 TTL」的唯一手段** —— 第 5 条必须在
 *    不重新选型（`expiryOf` 仍永不 resolve）的前提下让缓存过期。
 *
 * ## ⚠️ 本组所有调用都是**零参**
 *
 * `AutoAdapter.resolveModel()` 是零参方法（`src/auto-adapter.ts:359`）—— 宿主实际按
 * 三参调用，但本类刻意全忽略（只有 `auto` 一个对外模型，真实目标由内部选型决定）。
 * 写成 `resolveModel(AUTO_PROVIDER, AUTO_MODEL, undefined)` 会报
 * `TS2554: Expected 0 arguments, but got 3`。⚠️ 这个文件**不在**
 * `tsconfig.tests.json` 的 `include` 里（只有 src + 两个 spec + dsh-host-client），
 * 所以 `pnpm typecheck` 对本文件**零覆盖力** —— 改动后请单独跑一次：
 * `npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext
 * --skipLibCheck tests/unit/auto-adapter.spec.ts`。
 */

/**
 * 本组夹具的固定时钟。
 *
 * ⚠️ 数字**随常量变化**：选型缓存默认 `AUTO_CHOICE_TTL_MS` = 60 秒 ⇒ 同一时刻两次
 * 调用必在「新鲜」窗口内。改常量时同改本注释。
 */
const AUTO_NOW = 1_000

/**
 * 目标模型的**真实**窗口 —— 降级路径给不出这个值（它恒是保守字面量 `200_000`，
 * 见 `src/auto-adapter.ts` 降级 return 处的注释）。
 *
 * ⚠️ 本文件的判别力全部依赖这一个不等式：**夹具值 ≠ 生产常量**。若有人把保守窗口
 * 改成这个数，本组会同时失去判别力 ⇒ 故第 2/3 条只断言这一个不等式（第 2 条断言
 * `not.toBe(REAL_INFO_CONTEXT_WINDOW)`、第 3 条断言等值），**不要**再把生产常量
 * 另钉成字面量。
 *
 * ⚠️ 数字随常量变化：改 `src/auto-adapter.ts` 的保守窗口时必须检查本组是否仍可分。
 */
const REAL_INFO_CONTEXT_WINDOW = 123_456

interface AutoCatalogWorld {
  /**
   * provider → 目录。默认只有 `buddy` 有一个模型（其余渠道空目录 ⇒ 不可调用）。
   *
   * ⚠️ 渠道必须取自 `AUTO_PROVIDERS`（codearts / loomy / zcode / buddy / workbuddy）
   * —— 别的 provider（trae / cline / …）**不在候选表里**，选型永远不会走到它们
   * （本组第一版用 trae，`prepareCall` 直接报「没有已登录的 provider」）。
   */
  catalogs?: Record<string, Array<{ id: string; name: string }>>
  /**
   * 覆盖临期折算（其余 provider 走默认 `-1` = UNUSABLE）。
   *
   * ⚠️ 返回**永不 resolve** 的 promise 是「证明 `resolveModel` 没 await 选型」的关键
   * 夹具 —— 见上面第 2 条纪律。
   */
  expiryOf?: (provider: string, signal?: AbortSignal) => Promise<number>
  /** 注入的当前时刻（默认 {@link AUTO_NOW}）。第 5 条用它把时钟推过 TTL。 */
  now?: () => number
  /**
   * 选型缓存 TTL。
   *
   * ⚠️ **默认不传** ⇒ 用生产默认（`AUTO_CHOICE_TTL_MS`，**数字随常量变化**）：
   * 「缓存新鲜」与「冷启动」才成为两个不同的世界。
   * 传 `0` 会让本组第 3、4 条失去意义（缓存永不过期/永不命中都不是要测的形态）。
   */
  ttlMs?: number
  /** 覆写 `ctx.llm.stream` 的 chunk 序列（缺省零输出，够用）。 */
  streamChunks?: (provider: string) => Array<{ type: string; reason?: { kind?: string } }>
}

/**
 * 造一个「目录加载」场景的 auto 夹具。
 *
 * ⚠️ 沿用本文件既有夹具的形态（`new AutoAdapter(ctx, { accountPool, now, ttlMs })` +
 * 覆盖 `expiryOf`），**不新造第二套世界**；只是把「目录 / 临期 / 时钟 / 流」收成选项。
 *
 * 默认世界的 `ctx.llm.resolveModelInfo` 返回**带真实能力**的元数据
 * （`contextWindow = REAL_INFO_CONTEXT_WINDOW` + 两档 reasoning），于是「走了真实
 * 路径」与「走了降级路径」在**返回值上可区分** —— 这是本组全部判别力的来源。
 */
function makeAutoAdapter(world: AutoCatalogWorld = {}): { adapter: AutoAdapter; sent: string[] } {
  const sent: string[] = []
  const catalogs = world.catalogs ?? { buddy: [{ id: 'm1', name: 'M1 · x0.5' }] }
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    llm: {
      listModels: async (provider: string) => catalogs[provider] ?? [],
      resolveModelInfo: async (provider: string, id: string) => ({
        provider,
        id,
        name: `real-${id}`,
        // ⚠️ 真实路径的两个指纹（降级路径恒 `200_000` 且**不带** reasoning）。
        context: { contextWindow: REAL_INFO_CONTEXT_WINDOW },
        reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }] },
      }),
      stream: (o: { provider: string; model: string }) => {
        sent.push(`${o.provider}/${o.model}`)
        const chunks = world.streamChunks?.(o.provider) ?? []
        return (async function* () { for (const c of chunks) yield c })()
      },
    },
  }
  const pool = {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { token: 't' } }),
  }
  const adapter = new AutoAdapter(ctx as never, {
    accountPool: pool as never,
    now: world.now ?? (() => AUTO_NOW),
    // ⚠️ 只在用例显式给了 TTL 时才传（见 `AutoCatalogWorld.ttlMs` 的注释）。
    ...(world.ttlMs === undefined ? {} : { ttlMs: world.ttlMs }),
  })
  adapter.expiryOf = world.expiryOf
    ?? (async (provider: string) => (provider === 'buddy' ? 100 : -1))
  return { adapter, sent }
}

describe('auto：目录加载不得被选型阻塞', () => {
  it('★★ resolveModel 不 await 全池选型（fetch 永不 resolve 也必须返回）', async () => {
    const never = new Promise<number>(() => {})
    const { adapter } = makeAutoAdapter({ expiryOf: () => never })
    // ⚠️ 零参调用：`AutoAdapter.resolveModel()` 刻意不接受宿主的 3 个参数（见 `src/auto-adapter.ts`
    //    的「为什么是零参签名」）。传 3 参是 `TS2554`，而本文件不在 `tsconfig.tests.json`
    //    的 include 里 ⇒ `pnpm typecheck` 抓不到，别写回去。
    const info = await Promise.race([
      adapter.resolveModel(),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 50)),
    ])
    expect(info, '★★ resolveModel 必须不等选型就返回').not.toBe('TIMEOUT')
    // 返回的必须是 auto 的身份：DSH 的 normalizeModelInfo 校验 provider/id 与路由相符。
    expect((info as { provider?: string }).provider).toBe(AUTO_PROVIDER)
    expect((info as { id?: string }).id).toBe(AUTO_MODEL)
  })

  it('★★ 降级返回的元数据仍声明 image 模态（否则图片能力回退）', async () => {
    const never = new Promise<number>(() => {})
    const { adapter } = makeAutoAdapter({ expiryOf: () => never })
    const info = await adapter.resolveModel()
    expect(
      info.inputModalities,
      '★★ 降级路径也必须恒为 text+image',
    ).toEqual(expect.arrayContaining(['text', 'image']))
    // 反向确认本世界**真的走了降级路径**（否则上一条断言的含义就变了）：
    // 真实路径的指纹不在，只有保守窗口。
    // ⚠️ 只断言**这一个不等式**（夹具值 ≠ 生产常量），不把生产常量另钉成字面量 ——
    //    否则「有人把保守窗口改成夹具值」时本条与第 3 条会**同时**变恒绿。
    expect(
      info.context?.contextWindow,
      '冷启动应返回保守元数据（≠ 目标模型的真实窗口）',
    ).not.toBe(REAL_INFO_CONTEXT_WINDOW)
  })

  it('★ 有新鲜选型缓存时仍返回真实元数据（降级只作用于冷启动）', async () => {
    // ⚠️ 反向对照：没有这条，「永远返回降级元数据」也会全绿。
    const { adapter } = makeAutoAdapter()
    // ⚠️ 预置选型缓存走**真实链路**：`prepareCall` 内部 `await ensureChoice()` 会把
    //    `{ choice, info }` 写进缓存 —— 比直接改私有字段更能证明「缓存命中走真路」。
    await adapter.prepareCall(AUTO_PROVIDER, AUTO_MODEL)
    const info = await adapter.resolveModel()
    expect(info.inputModalities, '★ 有缓存时走真实路径').toBeDefined()
    // ⚠️⚠️ 上面那条**恒真**（两条路径都声明 text+image）⇒ 必须补判别力断言：
    expect(
      info.context?.contextWindow,
      '★ 有缓存时必须是目标模型的真实窗口（降级给不出这个值）',
    ).toBe(REAL_INFO_CONTEXT_WINDOW)
    expect(
      info.reasoning?.efforts?.map((effort) => String(effort.id)),
      '★ 档位也必须来自目标模型（降级路径不带 reasoning）',
    ).toEqual(['high', 'low'])
  })

  /**
   * ★★ 冷却必须**穿透**「新鲜缓存」（姊妹判据，与 `ensureChoice` 那条同源）。
   *
   * 选型缓存时长（`AUTO_CHOICE_TTL_MS`，**数字随常量变化**）而零输出冷却 10 分钟
   * —— 同步读缓存时若不复核冷却，冷却就被架空：`resolveModel` 会把一个**已确认
   * 撞墙**的目标当成正常目标向宿主播报。
   *
   * ⚠️ 冷却必须由**真实链路**写入（`dispatch` 撞墙后 `noteZeroOutputHit`），
   *    不直接改私有表：判据要落在「复用 `isTargetCoolingDown` 这唯一权威」上。
   */
  it('★★ 缓存项进入零输出冷却后不得再算「新鲜」（否则冷却被选型缓存架空）', async () => {
    const { adapter, sent } = makeAutoAdapter({
      catalogs: {
        buddy: [{ id: 'm1', name: 'M1 · x0.5' }],
        zcode: [{ id: 'g1', name: 'G1 · x0.8' }],
      },
      expiryOf: async (provider: string) => (provider === 'buddy' ? 100 : provider === 'zcode' ? 200 : -1),
      // `buddy` 收下请求却零输出（issue IKJW31 的失败形态）⇒ 它会被记 10 分钟冷却。
      streamChunks: (provider: string) => (provider === 'buddy'
        ? [{ type: 'usage' }, { type: 'finish', reason: { kind: 'max-tokens' } }]
        : [{ type: 'finish', reason: { kind: 'stop' } }]),
    })

    // 先走一次真实请求：既把 `buddy/m1` 写进选型缓存，又把它推进冷却。
    const call = await adapter.prepareCall(AUTO_PROVIDER, AUTO_MODEL)
    for await (const _ of call.stream({ messages: [userMessage()] } as never)) { /* drain */ }
    expect(sent, '前置：撞墙后应改道到 zcode').toEqual(['buddy/m1', 'zcode/g1'])

    // 时钟未动 ⇒ 缓存**仍在 TTL 窗口内**，唯一能让它失效的理由就是冷却。
    const info = await adapter.resolveModel()
    // ⛔ 不复核冷却时会返回缓存里那份真实元数据（带 reasoning）⇒ 本条变红。
    expect(info.reasoning, '冷却中的缓存项必须视为过期（降级元数据不带档位）').toBeUndefined()
    // ⚠️ 双指纹（Minor 1）：只挂 `reasoning` 一个指纹时，将来若给降级路径补上通用档位，
    //    本条会**静默变恒绿** ⇒ 同时断言保守窗口。
    expect(
      info.context?.contextWindow,
      '冷却中的缓存项必须视为过期（降级元数据的保守窗口指纹）',
    ).not.toBe(REAL_INFO_CONTEXT_WINDOW)
    // 但模态声明不受影响（恒为 text+image，见第 2 条）。
    expect(info.inputModalities).toEqual(expect.arrayContaining(['text', 'image']))
  })

  /**
   * ★★ TTL 半零守卫：**第 5 条**（本轮复审补，必修 2）。
   *
   * ## 它守的是「两处新鲜度判据必须同源」
   *
   * 「缓存是否新鲜」有**两份实现**：`cachedChoiceFresh`（`resolveModel` 用的同步版）
   * 与 `ensureChoice` 的缓存分支（`prepareCall` 用的异步版）。既有 4 条用例只覆盖了
   * **冷却**那一条腿（第 4 条），**TTL 那条腿零覆盖** —— 实测：把 `cachedChoiceFresh`
   * 的 TTL 那行删掉，43 条**全绿**。本条把那条腿钉住。
   *
   * ## 判据形态（为什么这样写才有牙）
   *
   * 1. 用 `now` 注入时钟（夹具接口里 `now?: () => number` 此前**零调用者**）；
   * 2. 先经 `prepareCall` 走**真实链路**把缓存写好（不直接改私有字段）；
   * 3. 把时钟推过 TTL —— ⚠️ 此时**只动时钟、不动缓存**，`expiryOf` 仍永不 resolve：
   *    缓存过期后 `resolveModel` **绝不能**重新选型（那会挂住 70 秒、本条超时），
   *    它必须直接回落到降级元数据。这正是「TTL 那一行在 `cachedChoiceFresh` 里」
   *    的承重证明 —— 删掉它，时钟推进也不再让缓存失效 ⇒ 返回真实元数据 ⇒ 本条红。
   *
   * ⚠️ 双指纹（`contextWindow` + `reasoning`）：「真实元数据」两个指纹都在，
   *    降级那份两个都不在。
   */
  it('★★ 缓存过了 TTL 后必须回落降级元数据（否则 cachedChoiceFresh 的 TTL 腿无覆盖）', async () => {
    let now = AUTO_NOW
    const { adapter } = makeAutoAdapter({ now: () => now })
    // 真实链路写缓存（`ensureChoice` 会把 `{ at: now, choice, info }` 写进去）。
    await adapter.prepareCall(AUTO_PROVIDER, AUTO_MODEL)
    // 前置：TTL 窗口内先确认「确实是真实元数据」，否则下面的回退断言会因别的原因绿。
    const fresh = await adapter.resolveModel()
    expect(fresh.context?.contextWindow, '前置：窗口内应是真实窗口').toBe(REAL_INFO_CONTEXT_WINDOW)
    expect(
      fresh.reasoning?.efforts?.map((effort) => String(effort.id)),
      '前置：窗口内应带目标档位',
    ).toEqual(['high', 'low'])

    // 把时钟推过 TTL（多推 1ms 保证严格超过边界）。
    now = AUTO_NOW + AUTO_CHOICE_TTL_MS + 1
    const stale = await adapter.resolveModel()
    // ⛔ 删掉 `cachedChoiceFresh` 的 TTL 那一行 ⇒ 仍返回缓存里的真实元数据 ⇒ 本条红。
    expect(
      stale.context?.contextWindow,
      '★★ 缓存过期后必须回落保守窗口（TTL 腿的判别指纹）',
    ).not.toBe(REAL_INFO_CONTEXT_WINDOW)
    expect(stale.reasoning, '★★ 缓存过期后必须回落降级元数据（不带档位）').toBeUndefined()
    // 身份与模态不受影响（降级路径照常声明，见第 2 条）。
    expect(stale.provider).toBe(AUTO_PROVIDER)
    expect(stale.id).toBe(AUTO_MODEL)
    expect(stale.inputModalities).toEqual(expect.arrayContaining(['text', 'image']))
  })
})