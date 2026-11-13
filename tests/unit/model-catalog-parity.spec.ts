/**
 * `createModelCatalog`：**逐 provider 对拍**（Task 7 的必交产物）。
 *
 * ## ⚠️ 为什么必须有这个文件（plan §Task 7 的原文）
 *
 * 14 家的 `toCatalogEntry()` 是**新写的转换**（不是搬移）。逐家的
 * `*-adapter.spec.ts` 只保证「改造后与改造前的**那一家的既有断言**仍然成立」；
 * 它们**保证不了**「转换没漏字段」—— 因为漏掉的那个字段，通常此前也没人断言
 * （否则当初就不会漏）。
 *
 * ## 两部分（驱动层次不同，缺一不可）
 *
 * | 部分 | 驱动方式 | 能抓到的缺陷 |
 * |---|---|---|
 * | **一、骨架对拍** | 手写 `CatalogEntry` 直接喂骨架 | 骨架自己**多写 / 漏写 / 改写**字段 |
 * | **二、端到端对拍** | **真实适配器**（`new XxxAdapter(...)`）经 `listModels` / `resolveModel` | 各家的 `toCatalogEntry` **漏字段 / 判据写错** |
 *
 * 第一部分的对称性：骨架**多写**（把「未知模态」写成 `['text']`）⇒ 红；
 * **漏写**（丢掉 `description` / `contextWindow`）⇒ 红；**改写**（把倍率名当裸名）⇒ 红。
 *
 * 第二部分的必要性：只有真适配器才能证明「远端报文 → `toCatalogEntry` → 骨架 →
 * 公开输出」这条**全链路**无损 —— 手写 entry 测不到解析层
 * （实测踩过：把 `context_length` 写成 `contextWindow` 会让第一部分的用例
 * **假绿**，因为手写 entry 根本不经过解析层）。
 *
 * ## ⚠️ 与 `model-catalog.spec.ts` 的分工（不是同义反复）
 *
 * | 文件 | 问的问题 |
 * |---|---|
 * | `model-catalog.spec.ts` | 骨架自身的六条不变式**是否成立**（构造式用例） |
 * | **本文件** | 各家 `toCatalogEntry` 的**真实产物**经骨架后**是否字段无损** |
 *
 * ## ⚠️ 反向验证（plan §Task 7 Step 7 的三条，全部实测有效）
 *
 * | 变异 | 变红的用例 |
 * |---|---|
 * | `toModelInfo` 把「未知模态」写成 `['text']` | 本文件 ② + `model-catalog.spec.ts` ④ |
 * | `resolveModel` 给未知模型写死 `contextWindow: 200_000` | 本文件 ③⑤ + `model-catalog.spec.ts` + `minimax-adapter.spec.ts` ×2 |
 * | `listAllModels` 也套黑名单 | 本文件 ④ + `model-catalog.spec.ts` ⑥⑮ |
 *
 * 三处变异均已在验证后还原。
 * ⚠️ 本行原先写「还原后 43/43 绿」—— 那是在本文件**只有** Task 7 那批用例时记的，
 * 此后本文件增删过用例，那个数字早已对不上（2026-10-08 复审开始前实测是 **27** 条）。
 * ⇒ **不要在这个头注里写具体条数**（它必然会腐）；当前条数以 `pnpm test` 的输出为准。
 *
 * ## ⚠️ 2026-10-08 复审补做的两组反向验证（针对**全 provider 表驱动段**）
 *
 * 上面那张表是 Task 7 当时的记录，**它没有覆盖后来补的表驱动段**。补做如下，
 * 结论与复现方式都记在这里（别只留在会话里）：
 *
 * | 变异 | 实测结果 |
 * |---|---|
 * | `model-catalog.ts` 的 `resolveModel` 分支给**未知 id** 写死 `contextWindow: 200_000` | **15 条红**，逐家点名 buddy / workbuddy / cline / zcode / trae / gemini / loomy / raccoon / minimax / qoder / qodercn / lobsterai / codearts（即不变式 g 对每家都有牙） |
 * | 只把 `trae-adapter.ts` 的 `listAllModels` 委托改成 `return []`（**单家**变异） | **1 条红**，且**只**点名 trae ⇒ 证明 `it.each` 的逐家隔离有效（不是「一家坏全段红」） |
 *
 * 两处变异均已在验证后还原（还原后 **42/42** 绿，逐字节还原已校验）。
 * ⚠️ 第二次的条数（15）**小于** 14+1 是因为 `opencode` 不走骨架 —— 它自己实现
 * `resolveModel`，故骨架变异**不**影响它，这正是「opencode 独立」的又一处体现。
 */

import { describe, expect, it, vi } from 'vitest'

import { createModelCatalog, type CatalogEntry } from '../../src/model-catalog.js'
import { toOpenAiModels } from '../../src/openai-gateway/models.js'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { AccioAdapter } from '../../src/accio-adapter.js'
import { AutoclawAdapter } from '../../src/autoclaw-adapter.js'
// ⚠️ AutoClaw 国际版（2026-10-20）：与国内同一适配器类，只差 product。
import { AUTOCLAW_INTL } from '../../src/autoclaw-product.js'
// ⚠️ **本 fork 独有**（modelscope，2026-10-16）。
import { MagicrewAdapter } from '../../src/magicrew-adapter.js'
import { MarvisAdapter } from '../../src/marvis-adapter.js'
import { MAGICREW_FALLBACK_CONTEXT_WINDOW, MAGICREW_INTL } from '../../src/magicrew-product.js'
import { ModelscopeAdapter } from '../../src/modelscope-adapter.js'
// ⚠️ **本 fork 独有**（MonkeyCode，2026-11-02）。
import { MonkeycodeAdapter } from '../../src/monkeycode-adapter.js'
import { MONKEYCODE_INTL } from '../../src/monkeycode-product.js'
import { BaizhiAdapter } from '../../src/baizhi-adapter.js'
import { BAIZHI } from '../../src/baizhi-product.js'
// ⚠️ **本 fork 独有**（qiniu/七牛云，2026-10-29）。
import { QiniuAdapter } from '../../src/qiniu-adapter.js'
import { CodelyAdapter } from '../../src/codely-adapter.js'
import { ClineAdapter } from '../../src/cline-adapter.js'
import { CodeArtsAdapter, CODEARTS_FALLBACK_CONTEXT_WINDOW } from '../../src/llm-adapter.js'
import { GeminiAdapter } from '../../src/gemini-adapter.js'
import { OfficeAceAdapter } from '../../src/officeace-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LoomyAdapter, parseLoomyRemoteModels } from '../../src/loomy-adapter.js'
import { MinimaxAdapter } from '../../src/minimax-adapter.js'
import { OpencodeAdapter } from '../../src/opencode-adapter.js'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import { RaccoonAdapter } from '../../src/raccoon-adapter.js'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { AstudioAdapter } from '../../src/astudio-adapter.js'
import { fallbackToEntry } from '../../src/minimax.js'
import { MINIMAX, MINIMAX_INTL } from '../../src/minimax-product.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'

/**
 * 表驱动段共用的构造底座：**不发网络、不读磁盘凭据**。
 *
 * ⚠️ `resolveCredential` 返回 `undefined` 是**刻意的**：
 * 各家目录都应能从**内置兜底表 / 静态目录**读出内容（除 zcode 有自己的
 * 就绪门控，已单独注入 `isReady`）。若某家因此列不出目录，本段会红并点名 ——
 * 那说明该家的目录**依赖真实凭据**，是应该知道的事实。
 */
const NO_CRED = {
  credentialRef: 'PARITY_ACCOUNT_TEST' as never,
  resolveCredential: async () => undefined,
  refresh: async () => {},
}

/** 造一个 provider 的骨架（替身池 + 可控目录 + 可控黑名单）。 */
function makeCatalog(
  entries: readonly CatalogEntry[],
  options: { disabled?: readonly string[]; visible?: boolean } = {},
) {
  const pool = {
    hasLoggedInAccount: vi.fn(async () => options.visible ?? true),
    disabledModelsFor: vi.fn(() => new Set(options.disabled ?? [])),
  }
  return createModelCatalog(
    { accountPool: pool as never },
    { product: { id: 'demo' }, loadCatalog: () => entries, syncCatalog: () => entries },
  )
}

/**
 * ⚠️ 各家的 `toCatalogEntry` 产物形状**取自真实实现**（不是想象）。
 *
 * 逐条来源：
 * - `loomy` / `minimax` / `raccoon`：倍率拼进 `name`，`bareName` 是去倍率的裸名；
 *   远端条目**总是**带 `supportsImage` ⇒ `inputModalities` 恒为数组（无「未知」态）；
 * - `buddy`：`inputModalitiesFor` 可能返回 `undefined` ⇒ **省略**该字段（未知态）；
 *   同名消歧把变体标记拼进 `name`；
 * - `cline` / `lobsterai`：`description` 可选透传；
 * - `codearts`：VL 多模态条目被过滤，不在目录里。
 *
 * ⚠️ `efforts` 是**对象数组**（`{ id, name }`），不是字符串数组 ——
 * `defaultEffort` 与 `effort.id` 比对（骨架的判据，见 `createModelCatalog`）。
 */
const REASONING_EFFORTS = [
  { id: 'low' as never, name: 'Low' },
  { id: 'high' as never, name: 'High' },
]

const LOOMY_ENTRY: CatalogEntry = {
  id: 'MiniMax-M3',
  name: 'MiniMax M3 · x4.0',
  bareName: 'MiniMax M3',
  inputModalities: ['text', 'image'],
  contextWindow: 1_048_576,
  reasoning: { efforts: REASONING_EFFORTS, defaultEffort: 'low' as never },
}

/** buddy 的「未知模态」条目（远端能力表拿不到时就是它）。 */
const BUDDY_UNKNOWN_MODALITY: CatalogEntry = {
  id: 'claude-sonnet-4',
  name: 'Claude Sonnet 4',
  bareName: 'Claude Sonnet 4',
  // ⚠️ `inputModalities` **刻意省略** —— 这是「未知」，不是「不支持图片」。
}

/** cline 的带 description 条目。 */
const CLINE_WITH_DESC: CatalogEntry = {
  id: 'gpt-5',
  name: 'GPT-5',
  description: '来自 Cline 目录的模型',
  inputModalities: ['text'],
}

/** 免费模型：标记**必须**在 `name` 里（不是 `description`）。 */
const FREE_ENTRY: CatalogEntry = {
  id: 'free-model',
  name: 'Free Model · 免费',
  bareName: 'Free Model',
  isFree: true,
  inputModalities: ['text'],
}

describe('createModelCatalog 对拍：① 枚举字段在 listModels 上逐项无损', () => {
  it('loomy 形态：name 带倍率 / bareName 去倍率 / 模态数组 / context / reasoning 全部到位', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY])
    const listed = await catalog.listModels('demo')

    expect(listed).toHaveLength(1)
    const info = listed[0]!
    // ⚠️ `listModels` 用**带倍率**的 name（价格只属于选择列表语境）。
    expect(info.name).toBe('MiniMax M3 · x4.0')
    expect(info.id).toBe('MiniMax-M3')
    expect(info.provider).toBe('demo')
    expect(info.inputModalities).toEqual(['text', 'image'])
    // ⚠️ `bareName` / `reasoning` 仍**不得**出现在 `listModels` 的输出里
    //（它们属于 resolveModel）；但 `contextWindow` 自 issue #36 起**必须**带出
    //（网关 `/v1/models` 的 `context_window` 唯一来源）。
    expect(Object.keys(info).sort()).toEqual(['contextWindow', 'id', 'inputModalities', 'name', 'provider'])
    expect((info as { contextWindow?: number }).contextWindow).toBe(1_048_576)
  })

  it('★★ 条目没有窗口时不得凭空造一个（`contextWindow` 字段必须缺席）', async () => {
    const catalog = makeCatalog([BUDDY_UNKNOWN_MODALITY])
    const listed = await catalog.listModels('demo')
    expect('contextWindow' in listed[0]!).toBe(false)
  })

  it('★★ 带窗口的目录经网关投影后 `/v1/models` 有 context_window（issue #36 全链路）', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY])
    const listed = await catalog.listModels('demo')
    const models = toOpenAiModels([{ provider: 'demo', models: listed as never }])
    expect(models[0]?.context_window).toBe(1_048_576)
  })

  it('⚠️ 倍率名绝不能被当成裸名下发（` · x4.0` 必须留在 name 里）', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY])
    const listed = await catalog.listModels('demo')

    expect(listed[0]!.name).toContain('· x4.0')
  })

  it('⚠️ 免费标记必须在 name 里（写进 description 会让 composer 菜单看不到）', async () => {
    const catalog = makeCatalog([FREE_ENTRY])
    const listed = await catalog.listModels('demo')

    expect(listed[0]!.name).toContain('免费')
  })

  it('description 逐字透传', async () => {
    const catalog = makeCatalog([CLINE_WITH_DESC])
    const listed = await catalog.listModels('demo')

    expect(listed[0]!.description).toBe('来自 Cline 目录的模型')
  })
})

describe('createModelCatalog 对拍：② 模态三态在真实形状上仍然可分', () => {
  it('⚠️⚠️「未知」（省略）与「明确不支持」（[text]）在**同一批目录**里各保其形', async () => {
    // 这一条是本 Task 最大风险的正面防线：两种条目**同时**存在时，
    // 骨架不得把二者归一成同一种输出。
    const catalog = makeCatalog([BUDDY_UNKNOWN_MODALITY, CLINE_WITH_DESC])
    const listed = await catalog.listModels('demo')

    const unknown = listed.find(m => m.id === 'claude-sonnet-4')!
    const textOnly = listed.find(m => m.id === 'gpt-5')!

    // 未知 ⇒ 字段**不存在**（`'inputModalities' in obj` 为 false）。
    expect('inputModalities' in unknown).toBe(false)
    // 明确不支持图片 ⇒ 字段存在且恰为 ['text']。
    expect(textOnly.inputModalities).toEqual(['text'])
    // ⚠️ 两者必须**可区分**（这正是三态的存在意义）。
    expect('inputModalities' in unknown).not.toBe('inputModalities' in textOnly)
  })

  it('未知模态经 resolveModel 后**仍不写**该字段（两个入口同判据）', async () => {
    const catalog = makeCatalog([BUDDY_UNKNOWN_MODALITY])
    const resolved = await catalog.resolveModel('demo', 'claude-sonnet-4')

    expect('inputModalities' in resolved).toBe(false)
  })
})

describe('createModelCatalog 对拍：③ resolveModel 的字段比 listModels 多，且各自到位', () => {
  it('contextWindow / reasoning / bareName 派生的 name 全部下发', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY])
    const resolved = await catalog.resolveModel('demo', 'MiniMax-M3')

    // ⚠️ `resolveModel` 的 name 用**裸名**（bareName 优先）——价格不属于这里。
    expect(resolved.name).toBe('MiniMax M3')
    expect(resolved.name).not.toContain('· x4.0')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
    expect(resolved.reasoning).toEqual({ efforts: REASONING_EFFORTS, defaultEffort: 'low' })
  })

  it('⚠️ reasoning 的两种非法形态都不下发（空 efforts / defaultEffort 不在 efforts 内）', async () => {
    const catalog = makeCatalog([
      { id: 'a', name: 'A', reasoning: { efforts: [], defaultEffort: 'low' as never } },
      { id: 'b', name: 'B', reasoning: { efforts: ['low'], defaultEffort: 'high' as never } },
    ])

    expect((await catalog.resolveModel('demo', 'a')).reasoning).toBeUndefined()
    expect((await catalog.resolveModel('demo', 'b')).reasoning).toBeUndefined()
  })

  it('⚠️ 非法 contextWindow（0 / 负数 / NaN）不下发，也不编造', async () => {
    const catalog = makeCatalog([
      { id: 'z', name: 'Z', contextWindow: 0 },
      { id: 'n', name: 'N', contextWindow: -1 },
      { id: 'nan', name: 'NaN', contextWindow: Number.NaN },
    ])

    expect((await catalog.resolveModel('demo', 'z')).context).toBeUndefined()
    expect((await catalog.resolveModel('demo', 'n')).context).toBeUndefined()
    expect((await catalog.resolveModel('demo', 'nan')).context).toBeUndefined()
  })
})

describe('createModelCatalog 对拍：④ 黑名单只影响 listModels，且不改 name', () => {
  it('被拉黑的条目从 listModels 消失，但 name 不被改写（消歧基于未过滤集合）', async () => {
    const entries: CatalogEntry[] = [
      { id: 'sonnet', name: 'Claude Sonnet 4 · 1x', bareName: 'Claude Sonnet 4' },
      { id: 'sonnet-thinking', name: 'Claude Sonnet 4 · 思考', bareName: 'Claude Sonnet 4' },
    ]

    const withBlacklist = makeCatalog(entries, { disabled: ['sonnet-thinking'] })
    const listed = await withBlacklist.listModels('demo')

    expect(listed.map(m => m.id)).toEqual(['sonnet'])
    // ⚠️ 留下那条的 name **不得**因另一条被拉黑而改变（否则名字随开关跳变）。
    expect(listed[0]!.name).toBe('Claude Sonnet 4 · 1x')

    // 全量视图**不套**黑名单（设置页要能看到已关闭模型的倍率）。
    const all = withBlacklist.listAllModels()
    expect(all.map(m => m.id).sort()).toEqual(['sonnet', 'sonnet-thinking'])
  })

  it('resolveModel 对**被拉黑**的模型仍能解析（黑名单不是「删除」）', async () => {
    const catalog = makeCatalog([CLINE_WITH_DESC], { disabled: ['gpt-5'] })
    const resolved = await catalog.resolveModel('demo', 'gpt-5')

    expect(resolved.id).toBe('gpt-5')
    expect(resolved.name).toBe('GPT-5')
  })
})

describe('createModelCatalog 对拍：⑤ 未知模型与空目录的边界', () => {
  it('未知 id：name 回退到裸 model，且不编造 context / reasoning', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY])
    const resolved = await catalog.resolveModel('demo', 'never-heard-of-it')

    expect(resolved.name).toBe('never-heard-of-it')
    expect(resolved.context).toBeUndefined()
    expect(resolved.reasoning).toBeUndefined()
  })

  it('空目录：listModels / listAllModels 都是空数组，**不抛错**', async () => {
    const catalog = makeCatalog([])

    await expect(catalog.listModels('demo')).resolves.toEqual([])
    expect(catalog.listAllModels()).toEqual([])
  })

  it('无已登录账号：两个入口都不吐条目（门控先于目录加载）', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY], { visible: false })

    await expect(catalog.listModels('demo')).resolves.toEqual([])
  })
})

describe('createModelCatalog 对拍：⑥ listAllModels 的同步契约', () => {
  it('⚠️ 返回**非 Promise**（11 家委托 + opencode 自己实现，全部同步）', () => {
    // ⚠️ **家数实测（2026-10-08 独立复审修正）**：本文件原先两处说法**互相矛盾** ——
    //    这里写「11 处既有实现」，另一节写「13 家实际实现全同步」。**两个都不准确**：
    //
    //    - 用 `createModelCatalog` 的家 = **11**（buddy / lobsterai / qoder / cline /
    //      zcode / trae / codearts / gemini / loomy / raccoon / minimax）；
    //      `qodercn` 复用 QoderAdapter、`workbuddy` 复用 BuddyAdapter ⇒ 不另计。
    //    - **`opencode` 不用** `createModelCatalog`（5 处协议级差异，见
    //      `provider-registry` 侧的说明），它的 `listAllModels` 是**自己实现**的
    //      一行 map（读静态兜底表），**同样同步**。
    //    - ⇒ 「同步契约」的覆盖是 **12 家**（11 委托 + 1 自实现）。
    //    ⚠️ 本条用例测的是**骨架本身**（`makeCatalog`），与实现家数无关 ——
    //    那个数字只是注释，写准是为了别让人以为「只有 11 家同步」。
    const catalog = makeCatalog([LOOMY_ENTRY])
    const result = catalog.listAllModels()

    expect(result).not.toBeInstanceOf(Promise)
    expect(Array.isArray(result)).toBe(true)
  })

  it('只吐 id / name / isFree 三键（不透出 description / 模态 / context）', async () => {
    const catalog = makeCatalog([LOOMY_ENTRY, FREE_ENTRY])
    // 先热缓存，避免冷缓存回退路径
    await catalog.listModels('demo')

    const all = catalog.listAllModels()
    const free = all.find(m => m.id === 'free-model')!
    expect(Object.keys(free).sort()).toEqual(['id', 'isFree', 'name'])
    expect(free.isFree).toBe(true)
    // 未声明 isFree 的条目**不得**出现该键（`false` 与「未声明」不同）。
    const loomy = all.find(m => m.id === 'MiniMax-M3')!
    expect('isFree' in loomy).toBe(false)
  })
})

describe('端到端对拍：minimax（同构组代表）', () => {
  function makeMinimax() {
    const entries = MINIMAX.fallbackModels.map(fallbackToEntry)
    return new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => entries,
      product: MINIMAX,
    })
  }

  it('listModels 的每一条都有 provider/id/name 三键，且 provider 是 minimax', async () => {
    const listed = await makeMinimax().listModels(MINIMAX.id)

    expect(listed.length).toBeGreaterThan(0)
    for (const m of listed) {
      expect(m.provider).toBe(MINIMAX.id)
      expect(typeof m.id).toBe('string')
      expect(m.id.length).toBeGreaterThan(0)
      // ⚠️ name **绝不空**（空名会让选择器出现空白项）。
      expect(m.name.length).toBeGreaterThan(0)
    }
  })

  it('⚠️ resolveModel 对目录里**每一个** id 都不抛错、name 非空（逐个遍历）', async () => {
    const adapter = makeMinimax()
    const listed = await adapter.listModels(MINIMAX.id)

    for (const m of listed) {
      const resolved = await adapter.resolveModel(MINIMAX.id, m.id)
      expect(resolved.id).toBe(m.id)
      expect(resolved.provider).toBe(MINIMAX.id)
      expect(resolved.name.length).toBeGreaterThan(0)
      // ⚠️ `resolveModel` 的 name 用**裸名**（不含倍率 ` · xN`）。
      expect(resolved.name).not.toMatch(/·\s*x[\d.]+/u)
    }
  })

  it('⚠️ 有 reasoning 的模型：defaultEffort **必须**落在 efforts 内（否则选择器空白）', async () => {
    const adapter = makeMinimax()
    const listed = await adapter.listModels(MINIMAX.id)

    let withReasoning = 0
    for (const m of listed) {
      const resolved = await adapter.resolveModel(MINIMAX.id, m.id)
      const r = resolved.reasoning
      if (r === undefined) continue
      withReasoning++
      expect(r.efforts.length).toBeGreaterThan(0)
      if (r.defaultEffort !== undefined) {
        expect(r.efforts.map(e => e.id)).toContain(r.defaultEffort)
      }
    }
    // ⚠️ 反向自检：本家**确实**有带 reasoning 的模型。若这条为 0，
    //    上面的循环体从未执行 ⇒ 用例退化成恒真（FALSE COVERAGE）。
    expect(withReasoning).toBeGreaterThan(0)
  })

  it('⚠️ contextWindow 非 0 时才声明（不编造假窗口）', async () => {
    const adapter = makeMinimax()
    const listed = await adapter.listModels(MINIMAX.id)

    let declared = 0
    for (const m of listed) {
      const resolved = await adapter.resolveModel(MINIMAX.id, m.id)
      if (resolved.context === undefined) continue
      declared++
      // ⚠️ 声明的窗口**必须**是正数（0 / 负数会被 DSH 拒）。
      expect(resolved.context.contextWindow).toBeGreaterThan(0)
    }
    expect(declared).toBeGreaterThan(0)
  })
})

describe('端到端对拍：loomy（同构组，模态恒为数组）', () => {
  /**
   * ⚠️ loomy 的远端条目**总是**带 `supportsImage` 布尔 ⇒ 它的模态
   * **恒为数组**，永远不会有「未知」态 —— 这与 buddy 恰好相反。
   */
  function makeLoomy(models: readonly Record<string, unknown>[]) {
    return new LoomyAdapter({
      credentialRef: 'LOOMY_ACCOUNT_TEST' as never,
      resolveCredential: async () => ({
        access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3_600_000,
      }) as never,
      refresh: async () => {},
      // ⚠️ 契约是「**已解析**的 LoomyRemoteModel[]」（不是原始报文）——
      //    故这里必须过一遍 `parseLoomyRemoteModels`，与既有
      //    `loomy-adapter.spec.ts` 同一做法。直接喂原始报文会让
      //    `context_length` / `input_modalities` 全被读成缺省值，
      //    用例于是**假绿**（断言到一个生产不会出现的形状）。
      fetchRemoteModels: async () => parseLoomyRemoteModels({ data: [...models] }),
    })
  }

  /** 远端报文的真实字段名：`context_length`（不是 `contextWindow`）。 */
  const remote = (over: Record<string, unknown> = {}) => ({
    id: 'MiniMax-M3',
    name: 'MiniMax M3 · x4.0',
    type: 'chat',
    context_length: 1_048_576,
    capabilities: { reasoning: true, input_modalities: ['text', 'image'] },
    ...over,
  })

  it('⚠️ 支持图片 ⇒ [text, image]；不支持 ⇒ [text]（**两者都写字段**，无未知态）', async () => {
    const adapter = makeLoomy([
      remote({ id: 'vision', name: 'Vision · x1.0' }),
      remote({
        id: 'text-only',
        name: 'Text Only · x2.0',
        capabilities: { reasoning: false, input_modalities: ['text'] },
      }),
    ])
    const listed = await adapter.listModels('loomy')

    const vision = listed.find(m => m.id === 'vision')!
    const textOnly = listed.find(m => m.id === 'text-only')!
    expect(vision.inputModalities).toEqual(['text', 'image'])
    expect(textOnly.inputModalities).toEqual(['text'])
    // ⚠️ 与 buddy 的对照点：两家**都**写该字段（loomy 从不省略）。
    expect('inputModalities' in vision).toBe(true)
    expect('inputModalities' in textOnly).toBe(true)
  })

  it('⚠️ resolveModel 用裸名（倍率不进 name），而 listModels 带倍率', async () => {
    const adapter = makeLoomy([remote()])

    const listed = await adapter.listModels('loomy')
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')

    expect(listed[0]!.name).toContain('· x4.0')
    expect(resolved.name).not.toContain('· x4.0')
    expect(resolved.name).toBe('MiniMax M3')
  })

  it('⚠️ 未知 id：不编造 context，name 回退到裸 id', async () => {
    const adapter = makeLoomy([remote()])
    const resolved = await adapter.resolveModel('loomy', 'no-such-model')

    expect(resolved.name).toBe('no-such-model')
    expect(resolved.context).toBeUndefined()
  })
})

describe('端到端对拍：**全 provider 表驱动**（15 家，2026-10-08 复审补齐 I-1；2026-10-16 本 fork 并入 modelscope）', () => {
  /**
   * ## ⚠️ 为什么补这一段（补之前这里的覆盖是 3/14）
   *
   * 上面三节（minimax / loomy / raccoon）是**同构组代表**，用真实适配器跑了
   * 完整链路。但实测：**其余 11 家**在「端到端对拍」这个交付物里**零覆盖** ——
   * 而它们的 `toCatalogEntry` 同样是新写的转换，恰恰是「漏字段」风险所在
   * （见本文件头注：漏掉的字段通常此前也没人断言）。
   *
   * ⇒ 本段把 14 家**全部**接上真实适配器，只断言**跨家不变式**
   * （不针对某一家写死期望值）：
   *
   * | # | 不变式 | 为什么它就是缺陷判据 |
   * |---|---|---|
   * | a | `listModels()` 每条 `provider` 回填 == 入参 | 回填错 ⇒ DSH 校验 `info.id === provider` 失败、整个分组消失 |
   * | b | 每条 `id` / `name` **非空** | 空名 ⇒ 选择器出现空白项（用户无法选） |
   * | c | `listAllModels()` 同步非 Promise 且条数 ≥ `listModels()` | 设置页靠它渲染**被关闭的**模型；少于则那些模型永久无法重新打开 |
   * | d | `resolveModel()` 上 **目录里每一个 id** 都不抛错，且逐字段与 `listModels` 同源 | 逐条遍历而不是抽样 —— 抽样会漏掉个别畸形条目 |
   * | e | `resolveModel()` 的 `defaultEffort` 必须落在 `efforts` 内 | 否则选择器空白（真实报障过） |
   * | f | `resolveModel()` 声明的 `contextWindow` 必须 > 0 | 0/负数会让 DSH 抛 `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来** |
   * | g | **未知 id** 不抛错 | 用户手填模型 id 是正常操作 |
   * | h | **未知 id 的模态形态**符合 `OMIT_UNKNOWN_MODALITIES`（默认 `['text']`） | 报错方向两个都是真缺陷：该省却报 ⇒ 静默关掉图片；该报却省 ⇒ 图片发到不支持的服务端 |
   * | i | **未知 id 是否声明 `reasoning`** 符合 `DECLARE_UNKNOWN_REASONING`（默认不声明） | 该声明却省 ⇒ 手填模型 id 时失去档位选择器；不该声明却声明 ⇒ 向服务端臆造档位 |
   * | j | **冷缓存**下 `listAllModels()` **非空**（用全新适配器） | 空 ⇒ 设置页把整个 provider 误显示为「已关闭」（真实缺陷史：`aggregate` 冷缓存 `total=1`） |
   *
   * ⚠️ **每家都实测跑通**（无网络、无真实凭据）：`n` 列见下面的 `CASES` 注释。
   * 若某家将来改成必须有网络才能列目录，本段会红并点名 —— 那是有用的信号。
   *
   * ⚠️ **`opencode` 也进来了**（它不用 `createModelCatalog`）：本段的价值正是
   * 「**所有**对外注册为 LLM provider 的家，其目录行为的跨家契约一致」——
   * 把 opencode 排除在外就等于承认它可以是例外，而它同样有
   * 「名字不能空、未知 id 不能抛、context 不能为 0」的契约。
   * 它的构造形状不同（需要 `identitySlots`），已在下表单列。
   */
  const CASES: ReadonlyArray<{ id: string; make: () => unknown }> = [
    { id: 'buddy', make: () => new BuddyAdapter({ ...NO_CRED, product: CODEBUDDY } as never) },
    { id: 'workbuddy', make: () => new BuddyAdapter({ ...NO_CRED, product: WORKBUDDY } as never) },
    {
      id: 'cline',
      make: () => new ClineAdapter({
        ...NO_CRED,
        // ⚠️ **两个加载器都必须注入**：默认实现会拉真实网络（实测：不注入时
        //    本用例超时 5s，因为 `ensureRemoteModels()` 在 `listModels` 里被 await）。
        loadModels: async () => ({ models: [], warnings: [] }),
        loadModelsDev: async () => new Map(),
      } as never),
    },
    {
      id: 'zcode',
      make: () => new ZcodeAdapter({
        ...NO_CRED,
        // zcode 独有的**门控**：未就绪直接返回 `[]`（它不抛错，是为了让 DSH
        // 隐藏整个分组）。不注入时凭据解析为 undefined ⇒ 恒 0 条 ⇒ 本段对它
        // 退化成恒真（FALSE COVERAGE），故必须显式就绪。
        isReady: async () => true,
      } as never),
    },
    { id: 'trae', make: () => new TraeAdapter({ ...NO_CRED } as never) },
    { id: 'gemini', make: () => new GeminiAdapter({ ...NO_CRED } as never) },
    {
      id: 'officeace',
      // ⚠️ officeace 的目录是**静态**的（`OFFICEACE_MODELS` 常量），不依赖凭据 ——
      //    但 `listModels` 有「凭据可读 + 探测通过」门控，未就绪返回 `[]`。
      //    这里注入一个**恒有凭据**的 provider 让它真正列出目录（否则本段对它
      //    退化成恒真 = FALSE COVERAGE）。
      make: () => new OfficeAceAdapter({
        credentialProvider: async () => ({
          modelAppKey: 'k', modelAppSecret: 's', maasBaseUrl: 'https://example.invalid',
          access: 'ak', secret: 'sk', securityToken: 'st', projectId: '',
          expiresAt: '2099-01-01T00:00:00.000Z', refreshToken: 'rt',
          dpopPrivateJwk: {},
        }),
        // ⚠️ 探测必须注入为**恒真**：默认实现会真发一次网络请求。
        fetchImpl: (async () => new Response('{}', {
          status: 200, headers: { 'content-type': 'application/json' },
        })) as never,
      } as never),
    },
    { id: 'loomy', make: () => new LoomyAdapter({ ...NO_CRED } as never) },
    { id: 'raccoon', make: () => new RaccoonAdapter({ ...NO_CRED } as never) },
    { id: 'minimax', make: () => new MinimaxAdapter({ ...NO_CRED } as never) },
    // ⚠️ minimaxintl（2026-10-15）：与 `minimax` **共用同一个适配器类**，只换
    //    product 配置（主机 / region / ref 前缀）。本段守的是「所有对外注册为
    //    LLM provider 的家，其目录行为的跨家契约一致」⇒ 它必须在列。
    {
      id: 'minimaxintl',
      make: () => new MinimaxAdapter({ ...NO_CRED, product: MINIMAX_INTL } as never),
    },
    { id: 'qoder', make: () => new QoderAdapter({ ...NO_CRED, product: QODER } as never) },
    { id: 'qodercn', make: () => new QoderAdapter({ ...NO_CRED, product: QODER_CN } as never) },
    { id: 'lobsterai', make: () => new LobsteraiAdapter({ ...NO_CRED } as never) },
    { id: 'codearts', make: () => new CodeArtsAdapter({ ...NO_CRED } as never) },
    {
      id: 'accio',
      make: () => new AccioAdapter({
        ...NO_CRED,
        // ⚠️ **不注入 `fetchRemoteModels`**：那会走远端拉取（真发网络）。
        //    不注入时 `ensureRemoteModels` 提前返回 ⇒ 目录回退
        //    `ACCIO.fallbackModels`（15 条），本段因此是零网络的。
        // ⚠️ **刻意不传 `accountPool`**：与其余各家同款，且它同时保证
        //    `providerCatalogVisible` 不因「没有已登录账号」把目录挡空。
      } as never),
    },
    {
id: 'autoclaw',
      // ⚠️ autoclaw 的目录来自编译期兜底表（`AUTOCLAW.fallbackModels`），不发网络；
      //    但 `listModels` 有「凭据可读」门控，未就绪返回 `[]`。
      //    这里注入一个**恒有凭据**的 provider 让它真正列出目录（否则本段对它
      //    退化成恒真 = FALSE COVERAGE）。探测失败被适配器内部 try/catch 吞掉，
      //    不阻断兜底目录 ⇒ 无需注入 `fetchImpl`。
      make: () => new AutoclawAdapter({
        credentialProvider: async () => ({
          access_token: 'at', refresh_token: 'rt', expires_at: 4102444800000,
        }),
      } as never),
    },
    {
      // ⚠️ AutoClaw **国际版**（2026-10-20）：与国内版**共用同一个适配器类**，
      //    只有 `product` 不同 ⇒ 目录同样来自编译期兜底表
      //    （`AUTOCLAW_INTL.fallbackModels`，与国内同一份）。
      //    同样注入恒有凭据，避免本段对它退化成恒真。
      id: 'autoclawintl',
      make: () => new AutoclawAdapter({
        product: AUTOCLAW_INTL,
        credentialProvider: async () => ({
          access_token: 'at', refresh_token: 'rt', expires_at: 4102444800000,
        }),
      } as never),
    },
    {
      // ⚠️ **本 fork 独有**（modelscope，2026-10-16）。
      // ⚠️ **不注入 `fetchRemoteCatalog`**：那会走远端拉取（真发网络）。
      //    不注入时 `loadModelscopeCatalog` 回退 `MODELSCOPE_FALLBACK_MODELS`，
      //    本段因此是零网络的。
      // ⚠️ **不注入 `accountPool`**：同上，且它同时保证 `providerCatalogVisible`
      //    不因「没有已登录账号」把目录挡空。
      // ⚠️ `slots` 必须返回**至少一个**条目：`listModels` 的门控是
      //    「`slots.length === 0` ⇒ 返回 `[]`」（空槽与「无账号」同形）。
      //    这里给一个**假 key**：本段不对拍鉴权，只对拍跨家目录契约。
      id: 'modelscope',
      make: () => new ModelscopeAdapter({
        ...NO_CRED,
        slots: async () => [{ id: 'modelscope', apiKey: 'ms-wire-test-key' }],
      } as never),
    },
    {
      // ⚠️ **本 fork 独有**（qiniu/七牛云，2026-10-29）。
      // ⚠️ 同样**不注入 `fetchRemoteCatalog`**（注入了就真发网络）：不注入时
      //    `loadQiniuCatalog` 回退 `QINIU_FALLBACK_MODELS`（那张表是 2026-10-29
      //    直连 `/v1/models` 的实测快照，77 条带真实 `context_length`），本段因此零网络。
      // ⚠️ `slots` 必须返回至少一个条目：`listModels` 的门控是「无槽位 ⇒ `[]`」。
      id: 'qiniu',
      make: () => new QiniuAdapter({
        ...NO_CRED,
        // ⚠️ 这里**不得**用 `sk-` 开头的字面量：`tests/unit/repo-pii-guard.spec.ts`
        //    会把入库文件里的 sk- 风格串判成泄漏密钥（实测命中本行即红）。
        //    qiniu 的 KEY_PATTERN 是 `[A-Za-z0-9_.-]{16,}`（刻意不绑死前缀），故此串合法。
        slots: async () => [{ id: 'qiniu', apiKey: 'qiniu-wire-test-key-0123456' }],
      } as never),
    },
    // ⚠️ 超级麦吉（Magicrew，2026-10-29）：`channel: true` ⇒ 必须进本表，
    //    否则它不过本段任何对拍（目录 / 模态 / 窗口 / 档位全部零覆盖）。
    //    ⚠️ `fetchRemoteModels` 不给 ⇒ 走静态兜底表（27 条），那是**可预期**的目录；
    //    本段只对拍跨家契约，不打远端。
    {
      id: 'magicrew',
      make: () => new MagicrewAdapter({
        ...NO_CRED,
        resolveCredential: async () => ({ jwt: 'J', organizationCode: 'org1' } as never),
      } as never),
    },
    // ⚠️ **MagiCrew 国际版**（`magicrewintl`，2026-11-01）：`channel: true` ⇒ 必须进本表，
    //    否则它不过本段任何对拍（目录 / 模态 / 窗口 / 档位全部零覆盖）。
    //    ⚠️ 必须显式传 `product: MAGICREW_INTL` —— 用默认值会拿国内站的
    //    `fallbackModels` 与 host 去构造一个「看起来对、实际是另一站」的适配器
    //    （本段只对拍跨家契约，但 product 传错会让档位/窗口的判据失去意义）。
    {
      id: 'magicrewintl',
      make: () => new MagicrewAdapter({
        ...NO_CRED,
        product: MAGICREW_INTL,
        resolveCredential: async () => ({ jwt: 'J', organizationCode: 'org1' } as never),
      } as never),
    },
    // ⚠️ 腾讯 Marvis（2026-11-09）：`channel: true` ⇒ 必须进本表，否则它不过
    //    本段任何对拍（目录 / 模态 / 窗口 / 档位全部零覆盖）。
    //    ⚠️ 上游**没有目录端点**（9 条候选全 404/400）⇒ 目录恒为单条
    //    `main-auto`；本段只对拍跨家契约，所以「只有一条」正是可预期的形状。
    {
      id: 'marvis',
      make: () => new MarvisAdapter({
        ...NO_CRED,
        slots: async () => [{
          id: 'marvis',
          credential: {
            access_token: 'mv-test-access-token',
            refresh_token: 'test-refresh-token-0001',
            openid: 'oid-parity',
            guid: '0123456789abcdef0123456789abcdef',
            login_type: '1',
          } as never,
        }],
      } as never),
    },
    // ⚠️ Codely（Unity，2026-10-22 A6）：`channel` 已翻 true ⇒ 必须进本表，
    //    否则它不过本段任何对拍（目录 / 模态 / 窗口 / 档位全部零覆盖）。
    {
      id: 'codely',
      make: () => new CodelyAdapter({
        ...NO_CRED,
        credentialProvider: async () => ({ access_token: 'COD', refresh_token: 'R' } as never),
      } as never),
    },
    {
      id: 'opencode',
      make: () => new OpencodeAdapter({
        ...NO_CRED,
        // ⚠️⚠️ 2026-10-23 迁移后 opencode **也走 `createModelCatalog`** 了
        //    （用户要求「实体 provider 一律走共享骨架」）⇒ 它的 `accountPool`
        //    必须实现骨架消费的 `disabledModelsFor` / `providerClosedFor`，
        //    只给 `opencodeProxyFor` 会抛
        //    `deps.accountPool?.disabledModelsFor is not a function`（实测）。
        identitySlots: async () => [{ refName: 'OPENCODE_A', slotId: 's1' }],
        accountPool: {
          opencodeProxyFor: () => undefined,
          disabledModelsFor: () => new Set<string>(),
          providerClosedFor: () => false,
        } as never,
      } as never),
    },
    {
      id: 'astudio',
      make: () => new AstudioAdapter({
        ...NO_CRED,
        // ⚠️ **不注入 fetchRemoteModels、也不注入 auth**：astudio-adapter.ts 的
        //    loadModels 在 fetcher 为 undefined 时 warn 后**直接**回退
        //    product.fallbackModels（ASTUDIO 兜底表 6 条），一个请求都不发 ⇒ 本条目
        //    与上面的 accio 同款是零网络的。
      } as never),
    },
    {
      // ⚠️ **MonkeyCode**（`monkeycode`，2026-11-02）：`channel: true` ⇒ 必须进本表，
      //    否则它不过本段任何对拍（目录 / 模态 / 窗口 / 档位全部零覆盖）。
      // ⚠️ **不注入 `fetchRemoteModels`**：注入了就会真发网络（白泽目录端点）。
      //    不注入时 `loadCatalogEntries` 直接回退 `MONKEYCODE_MODELS`（白泽 4 条 +
      //    网关 9 条的合并去重表），本段因此是零网络的。
      // ⚠️ `slots` 必须返回**至少一个**条目：`listModels` 的门控是
      //    「`slots.length === 0` ⇒ 返回 `[]`」（空槽与「无账号」同形）。
      //    ⚠️ 这里不得用 `sk-` 开头的字面量：`tests/unit/repo-pii-guard.spec.ts`
      //    会把入库的 sk- 风格串判成泄漏密钥（qiniu 那条注释记过同一个坑）。
      //    ⚠️ 也**不要**用高熵的假 key（`mc_spec_key_000000` 这类 18 位随机串
      //    会被同一条守卫按「凭据字段名 + 高熵字面量」拦下）—— `spec-token`
      //    这种低熵串才是这个仓库存测试夹具的惯用形态。
      //    ⚠️ 2026-11-02 三审 F🟡-10：本处原写「凭据形状用白泽通道
      //    （`channel: 'baizhi'`）」—— 那个字段在拆站时**已删**，留着它只能靠
      //    外层 `as never` 掩盖（关键字法检查也就彻底发现不了真正的凭据形状漂移）。
      //    现在只留**真实字段**。
      id: 'monkeycode',
      make: () => new MonkeycodeAdapter({
        ...NO_CRED,
        slots: async () => [{
          accountId: 'monkeycode',
          credential: { access_token: 'spec-token' },
        }],
      } as never),
    },
    {
      // ⚠️ MonkeyCode 国际站（`monkeycodeintl`，2026-11-02 拆站）：与 `monkeycode`
      //    **逐字同构** —— 同一套代码的另一部署（`proxy.monkeycode-ai.net` 对
      //    `GET /v1/models` 同样回 405），目录同样是那 9 条内置清单。
      //    ⚠️ 两站的模型清单**刻意各自内置一份**：镜像关系可能会漂（国际站先上/
      //    后撤模型是运营动作），共用一份会让漂移以「另一边多了个不存在的模型」
      //    的形式静默出现。
      id: 'monkeycodeintl',
      make: () => new MonkeycodeAdapter({
        ...NO_CRED,
        // ⚠️ 必须显式传 `product: MONKEYCODE_INTL`：适配器回填 `provider` 时读的是
        //    `this.product.id`，漏传会默认 `MONKEYCODE` ⇒ 目录里每个模型都标成
        //    国内站（本段「跨家目录契约」正是靠这条判据点名的）。
        product: MONKEYCODE_INTL,
        slots: async () => [{
          accountId: 'monkeycodeintl',
          credential: { access_token: 'spec-token-intl' },
        }],
      } as never),
    },
    {
      // 百智云（`baizhi`，2026-11-02）：静态 `sk-…` 凭据、`x-api-key` 头、
      // Anthropic Messages 协议。**不注入 `fetchRemoteModels`** ⇒ 零网络，
      // 目录回退内置兜底表（15 条）。
      // ⚠️ 槽形状与 MonkeyCode 不同：`{ id, apiKey }`（不是 accountId/credential）。
      id: 'baizhi',
      make: () => new BaizhiAdapter({
        ...NO_CRED,
        product: BAIZHI,
        slots: async () => [{ id: BAIZHI.id, apiKey: 'spec-token-baizhi' }],
      } as never),
    },
  ]

  /**
   * ⚠️ **对未知 id 省略 `inputModalities` 的家**：`buddy` 系与 `cline`
   * （`cline` 为 issue IKKZUG 2026-10-12 新增）。
   *
   * | 家 | 为什么「未知」是真实状态 |
   * |---|---|
   * | `buddy`（含 `workbuddy`） | `imageCapabilityKnown` 区分「明确 false」与「全都没查到」，后者只报未知 |
   * | `cline` | **能力只来自目录条目，而 `cline-pass/*` 的条目只由 models.dev 提供** —— 那是 5.39 MB 的外部站点，用户实测直连三次（超时/超时/1.9s 成功）⇒ 「未知」是高频状态而非理论边界 |
   *
   * ⚠️ **`accio` 曾在此集合里，2026-10-14 已移出**（issue IKLR7V）：它的图片通路
   * 真机实测打通（上游原生收图、`multimodal:true` 四色全对），且远端条目的
   * `multimodal` 字段**从不缺失** ⇒ 已知模型**不再有「未知」态**，改为按逐模型的
   * `supportsImage` 声明（`false` 写 `['text']`）。⚠️ 它的**未知 id** 仍保守报 `['text']`
   * （不是省略）—— 未知 id 的能力是真的无从得知，而放行图片会让上游**静默忽略**它。
   *
   * 其余一律**保守报 `['text']`**。
   *
   * ⚠️ 这里只列「省略」的家，**默认要求 `['text']`**：将来新增一家若想省略，
   * 必须**显式**加进本集合，否则下面 (h) 变红并点名它 —— 这是刻意的，
   * 目的是**迫使新人做显式决定**，而不是默默沿用某一家的行为。
   *
   * ⚠️ cline 是**第二个**省略家，不是「buddy 的特例推广」：加它之前先确认了
   * 它确实存在「未知态」（能力来源会在进程运行中拿不到），而有些家的目录是
   * 编译期表恒可用、根本不存在未知态 —— 那些**不**该加进来。
   */
  const OMIT_UNKNOWN_MODALITIES: ReadonlySet<string> = new Set([
    'buddy', 'workbuddy', 'cline',
    // 百智云（2026-11-02）：`baizhi-messages.ts` / `baizhi-adapter.ts` 对**未知**
    // 模型 id 刻意不声明 `unknownModelInputModalities` —— 宁可把图片当
    // `UNSUPPORTED_CONTENT` 拒掉（真收到图时判模型在前、读字节在后），也不要
    // 先报一个服务端可能不认的模态、让请求打到上游才 400。
    // ⚠️ 与 buddy 系同型：这是**保守侧**的省略，不是漏配。
    'baizhi',
  ])

  /**
   * ⚠️ **对未知 id 仍声明 `reasoning` 的家见下方集合**（当前 5 家）：
   * `cline` / `codearts`（档位来自**产品配置 / 网关协议**，与具体模型无关）、
   * `magicrew` / `magicrewintl`、`loomy` —— 各家理由**不同**，逐家说明在集合
   * 上方的注释块里。其余家的档位来自**该模型的**远端配置，未知模型无从得知
   * ⇒ **不声明**。
   *
   * ⚠️ 与 `OMIT_UNKNOWN_MODALITIES` 同为「默认 + 显式例外」：将来新增一家若想
   * 对未知 id 声明档位，必须**显式**加进本集合，否则下面 (i) 变红并点名它。
   * ⚠️ 逐家行为核对由本段的 (i) 承担（跑真实适配器）；`model-catalog.spec.ts`
   * ⑯ 的判据是**自造 config**、只演示两种形态的骨架语义，不逐家核对 ——
   * 两份测试各管一层，别把 (i) 的逐家职责误记到那边。
   */
  /**
   * 未知 id 也声明 `reasoning` 的家。
   *
   * ⚠️ 超级麦吉（Magicrew，2026-10-29）在此，理由与 codearts / cline 不同：
   * 本家**默认开启思考**，而关闭它只有 `reasoning_effort: 'none'` 一个真开关
   *（实测：不发该字段 ⇒ `reasoning_tokens` 恒 54；发 `none` ⇒ 恒 0）。
   * 不声明 ⇒ 用户手填模型 id 时**没有档位选择器** ⇒ 永远关不掉思考
   *（比「臆造档位」更实际的损失），而本家只两档、且上行前按
   * `MAGICREW_REASONING_EFFORTS` 过滤（非法值本就不会发出）。
   *
   * ⚠️⚠️ **Loomy（2026-11-06）在此，理由是「不声明会整轮失败」**（真报障）：
   * 本家的档位是**产品级**事实 —— 全部 chat 模型（含 2026-11-06 新上架的
   * `DeepSeek-V4.1-Flash`）下发的 `reasoning_efforts` **逐字相同**
   * `['none','low','medium','high','xhigh']`。而远端 `GET /models` 抓取失败时
   * 会退回兜底表，兜底表跟不上的新 id 就落「目录外」⇒ 不声明档位 ⇒
   * 用户在该模型上持久化过 `xhigh` 时，`dsh-llm` 的 `resolveCallWithInfo`
   * **硬抛** `UNSUPPORTED_REASONING_EFFORT`（不 clamp、不 alias）⇒
   * **整轮失败、一个 token 都没发出去**，用户侧表现为「切个模型就整轮挂」。
   * 实测损失比「臆造档位」重一个量级（臆造最多是上游回一个参数错）。
   * 另附证据：3 次 `agent.failed` + 1 条 `no context capacity` 压缩 warn，
   * 会话档 `model/selection` 与 `request/header` 双向对得上。
   */
  const DECLARE_UNKNOWN_REASONING: ReadonlySet<string> = new Set([
    'cline', 'codearts', 'magicrew', 'magicrewintl', 'loomy',
  ])

  it('⚠️ 表的家数 == 全部对外注册的 LLM provider（漏一家 ⇒ 它不过本段任何断言）', async () => {
    // ⚠️ 判据来自 **PROVIDER_REGISTRY**（唯一的 provider 真源），不手抄。
    //    实测：`channel: true` 的 18 家正好是上面 18 家（`aggregate` 是
    //    `channel: false` 的聚合器，不在此列）。
    //    ⚠️ 2026-10-13 合并：officeace 与 accio **同一次**并入，故 14 → 16。
    //    ⚠️ 2026-10-15 加 minimaxintl（MiniMax Code 国际版）：16 → 17。
    //    ⚠️ 2026-10-16 astudio 并入（goal 302 接线）：17 → 18。
    //    ⚠️ 2026-10-17 加 autoclaw（AutoClaw/智谱）：18 → 19；
    //    同日 **本 fork** 并入 modelscope（魔搭）：19 → 20。
    // ⚠️ 2026-10-20 加 autoclawintl（AutoClaw 国际版）：20 → 21。
    //    ⚠️ 合并上游时**不要**改回 17（那会让 modelscope 失去本段全部对拍）。
    const { PROVIDER_REGISTRY } = await import('../../src/provider-registry.js')
    const channels = PROVIDER_REGISTRY.filter(d => d.channel).map(d => d.id).sort()
    expect(CASES.map(c => c.id).sort()).toEqual(channels)
    // ⚠️ 2026-10-22（A6）：codely 翻 `channel: true` ⇒ 进本表：21 → 22。
    // ⚠️ 2026-10-29 **本 fork** 并入 qiniu（七牛云）+ master 并入 magicrew：22 → 23 → 24。
    // ⚠️ 2026-11-01 加 magicrewintl（MagiCrew 国际版）：24 → 25。
    // ⚠️ 2026-11-02 加 monkeycode（MonkeyCode）：25 → 26。
    // ⚠️ 2026-11-02 **拆站**：monkeycodeintl（MonkeyCode 国际站）是独立部署，
    //    `channel: true` ⇒ 26 → 27。
    // ⚠️ 2026-11-02 并入 baizhi（百智云，`channel: true`）⇒ 27 → 28。
    // ⚠️ 2026-11-09 加 marvis（腾讯 Marvis，`channel: true`）⇒ 28 → 29。
    expect(CASES).toHaveLength(29)
  })

  it('★★ `catalog` 具备 `refresh` 的家，适配器上必须**存在** `refresh` 成员（转发接线）', () => {
    // ⚠️⚠️ 2026-10-20 修正的实测缺陷形态：`be42b25`（「装配 20 分钟模型目录刷新器」）
    //    给 `createModelCatalog` 的 **config** 加了 `refresh` 回调，但**各家适配器
    //    都没有**把它转发成自己的 `refresh` 成员；而 `index.ts` 的刷新器调的是
    //    `adapter.refresh?.()` —— `pruned()` 的 Proxy 只透传适配器**自己的**成员，
    //    catalog 实例上的成员不会自动出现 ⇒ 每一轮都是「0 家参与」，
    //    而 `start()` 的「模型目录刷新器已武装」照打、**零日志**、整整一天无感。
    //
    // ⚠️ 判据是**实例成员**（构造真实适配器、看 `typeof`），**不是**源码文本断言 ——
    //    后者会被 `if (false)` 短路骗过（本仓库已实测 5 条这类判据恒绿）。
    // ⚠️ 从 `CASES` 遍历 ⇒ 新增 provider 自动纳入（漏一家即被点名）。
    // ⚠️ `catalog` 无 `refresh` 的家自动跳过：那表示它的目录不走共享骨架
    //    （opencode / autoclaw / officeace / modelscope / aggregate），
    //    或它的 `createModelCatalog` 没给 config 回调（cline / gemini）
    //    —— 后者是**已知的、已如实登记的**独立缺口，不在本条判据的范围内。
    //    ⚠️ 2026-10-20：**qoder / qodercn 已补齐**（接入远端目录的同时补了
    //    `refresh` 转发与 `onCatalogLoaded` 广播）⇒ 从「已知缺口」名单移出、
    //    进下面的正向点名表。12 → 14。
    //
    // ⚠️⚠️ **本条只覆盖「成员存在」，抓不到「成员在但空转」**（2026-10-20 对抗审计
    //    实测：把 `refresh()` 方法体清空成 no-op 后，本文件 **49 passed 全绿**）——
    //    而它引用的 `be42b25` 历史缺陷恰恰是「空转 + 零日志」。
    //    ⇒ **不要**把这条当成「转发语义成立」的证明：行为面（`refresh()` 真的会
    //    驱动一次目录读取）由**各家自己的** `refresh` 用例承担，例如
    //    `qoder-adapter.spec.ts` 的「refresh() 强制重拉（无视 TTL）」。
    //    该行为断言无法在本文件通用化：`CASES` 的多数构造**不注入**
    //    `fetchRemoteModels`（注入了就会真发网络，见 accio 那行的注释），
    //    因此没有可观测的取数入口。⇒ 本条**如实收窄为存在性判据**。
    const missing: string[] = []
    const forwarding: string[] = []
    for (const c of CASES) {
      const adapter = c.make() as {
        catalog?: { refresh?: unknown }
        refresh?: unknown
      }
      if (typeof adapter.catalog?.refresh !== 'function') continue
      if (typeof adapter.refresh === 'function') forwarding.push(c.id)
      else missing.push(c.id)
    }
    expect(
      missing,
      '这些家的 catalog 有 refresh 却没转发成适配器成员 ⇒ 后台目录刷新器对它们空转且零日志',
    ).toEqual([])
    // ⚠️⚠️ **反向护栏必须「逐家点名」，不能只写 `length >= N`**（2026-10-20）：
    //    上面那条 `missing` 判据有个**盲区** —— 若某人把某家的 `config.refresh`
    //    也删掉，该家的 `catalog.refresh` 就不存在 ⇒ 被 `continue` 跳过 ⇒
    //    **静默放过**。逐家点名把「漏转发」与「连 config 都没给」两个方向一起堵住。
    //    ⚠️ 用精确集合而不是下界：下界会漏掉「删一家、加一家」的配平。
    //    ⚠️ `minimaxintl` 与 `workbuddy` 也在列：它们分别与 `minimax` / `buddy`
    //       **共用适配器类**，因此同样继承了 config 回调与转发（实测由本断言自己找出）。
    expect(
      forwarding.sort(),
      '这 19 家必须都接入后台刷新（改这条名单前请先读 be42b25 与本轮修正的注释）',
    ).toEqual([
      'accio', 'astudio', 'baizhi', 'buddy', 'codearts', 'lobsterai', 'loomy',
      'magicrew', 'magicrewintl', 'minimax', 'minimaxintl', 'monkeycode',
      'monkeycodeintl', 'qoder', 'qodercn', 'raccoon', 'trae', 'workbuddy', 'zcode',
    ])
  })

  /**
   * ⚠️ 每家一个 `it`（`it.each` 而非循环）：失败时**点名是哪一家**。
   * 用 `for` 循环包全部家会让第一个失败就中断，后面的家**根本没跑**
   * （FALSE COVERAGE 的另一种形态）。
   */
  it.each(CASES)('$id：跨家目录契约', async ({ id, make }) => {
    const adapter = make() as {
      listModels(p: string): Promise<readonly { provider: string; id: string; name: string }[]>
      resolveModel(p: string, m: string): Promise<{
        provider: string
        id: string
        name: string
        context?: { contextWindow: number }
        reasoning?: { efforts: readonly { id: string }[]; defaultEffort?: string }
      }>
      listAllModels(): readonly { id: string; name: string }[]
    }

    // (j) **冷缓存**下 `listAllModels()` 不得为空。
    //     ⚠️ 必须用**全新适配器**：下面 (c) 调 `listAllModels` 之前已经
    //     `await listModels(...)` 过，那是**热**缓存 —— 测不出本条。
    //     ⚠️ 这是**真实缺陷史**的判据（`src/model-catalog.ts` 的 `syncCatalog`
    //     注释）：`aggregate` 冷缓存时 `total` 只有 1 ⇒ 用户一关掉 `auto`，
    //     它就被**误显示为「已关闭」**（`closed = total > 0 && disabled === total`）。
    //     ⇒ 冷缓存返回空数组 = 该 provider 在设置页被误判为「已关闭」。
    const cold = make() as { listAllModels(): readonly { id: string; name: string }[] }
    const coldAll = cold.listAllModels()
    expect(
      coldAll.length,
      `${id} **冷缓存**下 listAllModels 为空 —— 设置页会把整个 provider 误显示为`
      + '「已关闭」（`closed = total > 0 && disabled === total` 的 total 来自本方法）',
    ).toBeGreaterThan(0)

    // ⚠️ 先断言「列得出来」：若某家恒返回空数组，下面所有 `for` 循环体
    //    都**从未执行** ⇒ 本用例退化成恒真。这条是防 FALSE COVERAGE 的自检。
    const listed = await adapter.listModels(id)
    expect(listed.length, `${id} 的目录为空 —— 下面的逐条断言全部不会执行`).toBeGreaterThan(0)

    // (a)(b) provider 回填 + id/name 非空
    for (const m of listed) {
      expect(m.provider, `${id} 的 ${m.id} 回填了错的 provider`).toBe(id)
      expect(typeof m.id).toBe('string')
      expect(m.id.length, `${id} 有条目 id 为空`).toBeGreaterThan(0)
      expect(m.name.length, `${id} 的 ${m.id} 名为空（选择器会出现空白项）`).toBeGreaterThan(0)
    }

    // (c) listAllModels：同步、非 Promise、条数不少于 listModels
    const all = adapter.listAllModels()
    expect(all, `${id} 的 listAllModels 返回了 Promise（契约是同步）`).not.toBeInstanceOf(Promise)
    expect(Array.isArray(all)).toBe(true)
    expect(
      all.length,
      `${id} 的 listAllModels 比 listModels 少 —— 被关闭的模型会永久无法重新打开`,
    ).toBeGreaterThanOrEqual(listed.length)

    // (d)~(f) 逐条 resolveModel（**遍历全部**，不抽样）
    /** 该家是否**至少有一个**模型声明了思考档位（(j) 用它做双向判据）。 */
    let anyReasoning = false
    for (const m of listed) {
      const r = await adapter.resolveModel(id, m.id)
      expect(r.id, `${id} resolveModel(${m.id}) 回填了错的 id`).toBe(m.id)
      expect(r.provider, `${id} resolveModel(${m.id}) 回填了错的 provider`).toBe(id)
      expect(r.name.length, `${id} resolveModel(${m.id}) 名为空`).toBeGreaterThan(0)

      const reasoning = r.reasoning
      if (reasoning !== undefined) {
        anyReasoning = true
        expect(reasoning.efforts.length, `${id} 的 ${m.id} 声明了空 efforts`).toBeGreaterThan(0)
        if (reasoning.defaultEffort !== undefined) {
          expect(
            reasoning.efforts.map(e => e.id),
            `${id} 的 ${m.id} defaultEffort 不在 efforts 内（选择器会空白）`,
          ).toContain(reasoning.defaultEffort)
        }
      }

      if (r.context !== undefined) {
        expect(
          r.context.contextWindow,
          `${id} 的 ${m.id} 声明了非正数 contextWindow（DSH 会抛 INVALID_MODEL_MAX_TOKENS）`,
        ).toBeGreaterThan(0)
      }
    }

    /**
     * (j) **「该家结构上有没有思考档位」必须与 `PROVIDERS_WITHOUT_REASONING` 一致**。
     *
     * ⚠️ 这一格守的是 2026-11-11 的用户功能：Jet Hub 面板会给名单里的渠道显示
     *    「该渠道不提供思考档位」的灰字，而对名单外的渠道承诺「选模型后默认最强档」。
     *    两个方向都是**对用户说假话**（把可调的档位说成没有 / 承诺一个不会发生的事）。
     *
     * ⚠️⚠️ **只有「结构上不声明」的家才归名单**：`DISTANT_EFFORTS` 那四家的档位
     *    来自**远端目录**，本用例没有喂远端数据 ⇒ 冷缓存下恒为空 —— 那不是
     *    「该家不提供档位」，是**这一格测不到**（热缓存下有）。把它们混进来会
     *    让面板对它们撒谎，故显式豁免并在此登记理由。
     */
    const { providerWithoutReasoning } = await import('../../src/reasoning-default.js')
    const DISTANT_EFFORTS: ReadonlySet<string> = new Set([
      // 档位来自上游目录（`reasoning_effort_config` / `thinkingConfig` / …），
      // 本用例的夹具不注入远端模型表 ⇒ 只能测到冷缓存形态。
      'trae', 'lobsterai', 'accio', 'qiniu',
      // ⚠️ opencode 的档位来自 models.dev 的共享**磁盘**缓存（`opencode-capability`
      // 的 `getOpencodeCapabilitiesSync`）：干净工作区/CI 上没有那份缓存 ⇒ 恒空。
      // 它**不是**「该家不提供档位」—— 缓存落地后就有档位选择器。
      'opencode',
    ])
    if (providerWithoutReasoning(id)) {
      expect(
        anyReasoning,
        `${id} 在 PROVIDERS_WITHOUT_REASONING 里，但它的模型声明了思考档位 —— `
        + '面板灰字会对用户说假话（把可调的档位说成没有）。请从名单里删掉它',
      ).toBe(false)
    } else if (!DISTANT_EFFORTS.has(id)) {
      expect(
        anyReasoning,
        `${id} 不在 PROVIDERS_WITHOUT_REASONING 里，但它的模型**一个档位都没声明** —— `
        + '「选模型后默认最强档」对它静默无效，面板那句承诺是假的。请把它加进名单',
      ).toBe(true)
    }

    // (g) 未知 id 不抛错（用户手填模型 id 是正常操作）
    const unknown = await adapter.resolveModel(id, 'no-such-model-xyz-2026')
    expect(unknown.name.length, `${id} 对未知 id 给了空名`).toBeGreaterThan(0)
    // ⚠️ 未知模型**默认不得**声明 context（不编造窗口）。
    //
    // ⚠️⚠️ **`codearts` 是刻意的具名例外**（2026-10-21 真实报障，见下）——
    //    这是本不变式**唯一**的放行名单，`it.each` 逐家隔离保证其余各家仍然有牙
    //    （历史上本条对 15 家全部有牙，见文件头注的反向验证表）。
    //
    //    为什么 codearts 例外：它的窗口**全部来自本地静态表**（上游两个目录端点
    //    实测都不下发窗口），且「缺窗口」在本家的后果是**用户可见功能消失** ——
    //    DSH 的 `contextOccupancy()` 只要 `contextWindow === undefined` 就返回
    //    `null`，`ContextMeter` 随之 `return null` ⇒ 上下文占用条**整条不渲染**
    //    （不是显示 0%）。用户手填模型 id 时同样会中招。
    //    ⇒ 本家改用具名兜底 `CODEARTS_FALLBACK_CONTEXT_WINDOW`，理由与取证见
    //    `src/llm-adapter.ts` 该常量的长注释。
    //
    //    ⚠️ **不得**把这条例外推广到别家：多数家的窗口来自**远端该模型的**配置，
    //    对未知 id 编一个就是**假窗口**（分母错 ⇒ 占用比与自动压缩阈值一起错，
    //    比「不显示」更难发现）。
    //    ⚠️ 例外不是「跳过断言」，而是**改判据**：必须等于那个具名常量，
    //    写成 `if (id !== 'codearts') expect(...)` 会让 codearts 这条完全无牙。
    if (id === 'codearts') {
      expect(
        unknown.context,
        `${id} 对未知 id 必须给具名兜底窗口（否则手填模型永远没有上下文占用条）`,
      ).toEqual({ contextWindow: CODEARTS_FALLBACK_CONTEXT_WINDOW })
    } else if (id === 'magicrew' || id === 'magicrewintl') {
      // ⚠️ 超级麦吉（Magicrew，2026-10-29）与 codearts **同因**：两个目录端点都
      //    **不下发** ctx ⇒ 手填/新上的模型若不给兜底窗口，上下文占用条会**整条不渲染**
      //   （`ContextMeter` 在 `contextWindow === undefined` 时 `return null`）。
      //    ⇒ 这里是**改判据**（必须等于那个具名常量），不是跳过断言。
      expect(
        unknown.context,
        `${id} 对未知 id 必须给具名兜底窗口（否则手填模型永远没有上下文占用条）`,
      ).toEqual({ contextWindow: MAGICREW_FALLBACK_CONTEXT_WINDOW })
    } else {
      expect(unknown.context, `${id} 给未知 id 编造了 contextWindow`).toBeUndefined()
    }

    // (h) **未知 id 的模态形态**必须与 `OMIT_UNKNOWN_MODALITIES` 一致。
    //     ⚠️ 这一条补的是一个**已登记的覆盖缺口**：`model-catalog.spec.ts` ⑬
    //     自认「不逐家核对谁属于哪一形态」，而 `src/model-catalog.ts` 里那份
    //     名单**已经腐坏过一次**（写 5 家、实测 10 家）。这里把判据挂到
    //     **真实适配器**上，名单再腐坏就会点名到具体哪一家。
    //     ⚠️ 两个方向都是真缺陷，故双向断言（不是「只查省略的那两家」）：
    //     该省却报 `['text']` ⇒ **图片能力被静默关掉**；
    //     该报 `['text']` 却省略 ⇒ 图片**被放行**、发到不支持的服务端。
    const hasModalities = 'inputModalities' in unknown
    if (OMIT_UNKNOWN_MODALITIES.has(id)) {
      expect(
        hasModalities,
        `${id} 的未知 id 应**省略** inputModalities（它的能力探测能区分「未知」与「明确不支持」），`
        + `实际报了 ${JSON.stringify(unknown.inputModalities)} —— 会静默关掉图片能力`,
      ).toBe(false)
    } else {
      expect(
        hasModalities,
        `${id} 的未知 id 应**保守报 ['text']**（宁可少报能力，也不要报服务端可能不认的模态）；`
        + '若确要省略，请显式加进 OMIT_UNKNOWN_MODALITIES 并说明理由',
      ).toBe(true)
      expect(
        unknown.inputModalities,
        `${id} 对未知 id 报的模态不是 ['text']`,
      ).toEqual(['text'])
    }

    // (i) **未知 id 是否声明 reasoning** 必须与 `DECLARE_UNKNOWN_REASONING` 一致。
    //     ⚠️ 与 (h) 同一个形态、同一个理由：`model-catalog.spec.ts` ⑯ 用自造 config
    //     演示两种形态，但**不逐家核对**谁属于哪一形态。这里挂到真实适配器上。
    //     ⚠️ 两个方向都是真缺陷：
    //     该声明却省略 ⇒ 用户手填模型 id 时**失去档位选择器**（cline/codearts 的
    //       档位本就与模型无关）；
    //     不该声明却声明 ⇒ 向服务端**臆造**一个它可能不认的档位。
    const hasReasoning = unknown.reasoning !== undefined
    if (DECLARE_UNKNOWN_REASONING.has(id)) {
      expect(
        hasReasoning,
        `${id} 对未知 id 应**仍声明 reasoning**（它的档位来自产品配置/网关协议，与模型无关）；`
        + '省略会让用户手填模型 id 时失去档位选择器',
      ).toBe(true)
      expect(
        unknown.reasoning?.efforts.length,
        `${id} 对未知 id 声明了空 efforts`,
      ).toBeGreaterThan(0)
      const de = unknown.reasoning?.defaultEffort
      if (de !== undefined) {
        expect(
          unknown.reasoning?.efforts.map(e => e.id),
          `${id} 对未知 id 的 defaultEffort 不在 efforts 内（选择器会空白）`,
        ).toContain(de)
      }
    } else {
      expect(
        hasReasoning,
        `${id} 对未知 id 应**不声明 reasoning**（档位是该模型的能力，未知模型无从得知）；`
        + '若确要声明，请显式加进 DECLARE_UNKNOWN_REASONING 并说明理由',
      ).toBe(false)
    }
  })
})

describe('端到端对拍：raccoon（同构组）', () => {
  function makeRaccoon(models: readonly Record<string, unknown>[]) {
    return new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => models,
    } as never)
  }

  it('⚠️ 每个已列出模型都能被 resolveModel 解析（两个入口的 id 集合一致）', async () => {
    const adapter = makeRaccoon([
      { id: 'raccoon-a', name: 'Raccoon A · x1.0' },
      { id: 'raccoon-b', name: 'Raccoon B · x2.0' },
    ])
    const listed = await adapter.listModels('raccoon')

    // ⚠️ 至少要有一条 —— 否则下面的循环空转、用例恒真。
    expect(listed.length).toBeGreaterThan(0)
    for (const m of listed) {
      const resolved = await adapter.resolveModel('raccoon', m.id)
      expect(resolved.id).toBe(m.id)
      expect(resolved.name.length).toBeGreaterThan(0)
    }
  })
})

describe('端到端对拍：跨家不变式（不针对某一家）', () => {
  it('⚠️ listAllModels 是**同步**的（11 家委托 + opencode 自实现，全部同步）', () => {
    const adapter = new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => MINIMAX.fallbackModels.map(fallbackToEntry),
      product: MINIMAX,
    })

    const all = adapter.listAllModels()
    expect(all).not.toBeInstanceOf(Promise)
    expect(Array.isArray(all)).toBe(true)
    // ⚠️ 冷缓存下也**不得**为空（真实缺陷：从未调过 listModels 时设置页空白）。
    expect(all.length).toBeGreaterThan(0)
  })

  it('⚠️ 冷缓存的 listAllModels 与热缓存的条目集合一致（同步视图不丢条目）', async () => {
    const make = () => new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => MINIMAX.fallbackModels.map(fallbackToEntry),
      product: MINIMAX,
    })

    const cold = make().listAllModels().map(m => m.id).sort()
    const warmAdapter = make()
    await warmAdapter.listModels(MINIMAX.id) // 热缓存
    const warm = warmAdapter.listAllModels().map(m => m.id).sort()

    expect(warm).toEqual(cold)
  })

  it('⚠️ 目录门控：无已登录账号时 listModels 返回空（不抛错）', async () => {
    const adapter = new MinimaxAdapter({
      credentialRef: 'MINIMAX_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => MINIMAX.fallbackModels.map(fallbackToEntry),
      product: MINIMAX,
      // 池替身：没有任何已登录账号
      accountPool: {
        hasLoggedInAccount: async () => false,
        disabledModelsFor: () => new Set<string>(),
      } as never,
    })

    await expect(adapter.listModels(MINIMAX.id)).resolves.toEqual([])
  })
})
