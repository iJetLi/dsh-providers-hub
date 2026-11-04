import { LlmError } from '@deepseek-ai/dsh-llm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  CHAT_API_BASE,
  CodeArtsAdapter,
  codeartsOutboundUserAgent,
  codeartsQuotaExhaustedMessage,
  errorDetail,
  errorDetailForClassify,
  formatResetIn,
  isBenefitNotFoundBody,
  isSseQueueErrorCode,
  isSseQuotaExhaustedErrorCode,
  QUEUE_STATUS_BASE,
  RATE_LIMIT_FALLBACK_MS,
} from '../../src/llm-adapter.js'
import { nextUtc8DayStartMs } from '../../src/model-queue.js'
import { setBenefitMemoryCache } from '../../src/models.js'
import {
  resetCodeArtsBenefitClaimFlight,
  resetCodeArtsBenefitLearned,
} from '../../src/llm-adapter.js'
import { CODEARTS_BENEFIT_CLAIM_URL } from '../../src/codearts-credits.js'
import type { CodeArtsCredential } from '../../src/types.js'

const CREDENTIAL_REF = credentialRef('CODEARTS_ACCESS_TOKEN')

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** adapter.stream() 的最小 GenerateOptions 形参。 */
const streamOptions = {
  model: 'GLM-5.2',
  messages: [],
  signal: new AbortController().signal,
} as never

describe('codeartsOutboundUserAgent', () => {
  it('给以 deepseek-harness/ 开头的 UA 加前缀，其余原样', () => {
    const original = 'deepseek-harness/0.1.7-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)'
    expect(codeartsOutboundUserAgent(original)).toBe(`CodeArts ${original}`)
    expect(codeartsOutboundUserAgent('DeepSeek-Harness/1.0')).toBe('CodeArts DeepSeek-Harness/1.0')
    expect(codeartsOutboundUserAgent('CodeArtsAgent/1.0')).toBe('CodeArtsAgent/1.0')
    expect(codeartsOutboundUserAgent('app deepseek-harness/1.0')).toBe('app deepseek-harness/1.0')
    expect(codeartsOutboundUserAgent(null)).toBeUndefined()
    expect(codeartsOutboundUserAgent('')).toBeUndefined()
  })
})

function makeAdapter(overrides: {
  credential?: CodeArtsCredential | undefined
  refresh?: () => Promise<void>
  fetchImpl?: typeof fetch
  fetchRemoteModels?: () => Promise<Array<{ id: string; name: string }>>
  /** 多账号池替身；本文件只用到模型黑名单（listModels 的过滤输入）。 */
  accountPool?: unknown
  /** 各来源成败回调（issue IKJVTF，审计 I3）；接线层桥接数据源的上报。 */
  catalogComplete?: () => boolean | undefined
} = {}) {
  let credential = 'credential' in overrides ? overrides.credential : validCredential
  const refresh = overrides.refresh ?? (async () => {})
  const fetchImpl = overrides.fetchImpl ?? (async () => new Response('not found', { status: 404 }))
  const adapter = new CodeArtsAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => credential,
    refresh: async () => { await refresh(); credential = validCredential },
    fetchImpl,
    fetchRemoteModels: overrides.fetchRemoteModels,
    ...overrides.catalogComplete !== undefined ? { catalogComplete: overrides.catalogComplete } : {},
    ...overrides.accountPool !== undefined ? { accountPool: overrides.accountPool as never } : {},
  })
  return adapter
}

/** 只实现 listModels 所需方法的账号池替身：对指定 provider 报告黑名单。 */
function poolWithDisabled(provider: string, ids: string[]) {
  const disabled = new Set(ids)
  return {
    disabledModelsFor: (value: string) => (value === provider ? disabled : new Set<string>()),
  }
}

/**
 * 目录门控替身。
 *
 * `loggedInRefs` = 账号池里**凭据可解析**的 ref（空数组表示没有已登录账号）。
 * 替身只关心「账号池里有没有可用凭据」这一件事 —— 单凭据例外已移除，
 * 故不再需要额外 ref 参数。
 */
function poolWithCredentials(loggedInRefs: readonly string[]) {
  const pool = new Set(loggedInRefs)
  return {
    disabledModelsFor: () => new Set<string>(),
    hasLoggedInAccount: async (_provider: string) => pool.size > 0,
  }
}

/**
 * 字符级剥注释：丢掉注释内容，**保留字符串字面量与其内容**。
 *
 * 供「档位三处出口必须同源」那条**源码级**守卫使用（见其长注释）。
 *
 * 为什么不能用正则（两条都是实测踩出来的）：
 * 1. 非贪婪的块注释配对，遇到注释里孤立的块注释起始符，会与**后面的**
 *    结束符配对 ⇒ 把中间的真实代码整段吃掉 ⇒ 反向断言**恒绿**（假绿）；
 * 2. 只剥「整行是块注释」的行也不行 —— 本文件的 JSDoc 是**多行**的，
 *    只剥首尾行会剩下若干以 `*` 开头的正文行，里面的示例字面量被当真码 ⇒ **假红**。
 *
 * 状态机四态：代码 / 行注释 / 块注释 / 字符串。注释整段丢弃；字符串原样保留。
 *
 * @param source - 待处理的 TypeScript 源码文本。
 * @returns 去掉注释后的文本（行数与原文一致，注释位置留空行以外内容被删）。
 */
function stripCommentsAndKeepStrings(source: string): string {
  let out = ''
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    const next = source[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i++; continue }
      if (c === '/' && next === '*') { state = 'block'; i++; continue }
      if (c === "'") { state = 'single'; out += c; continue }
      if (c === '"') { state = 'double'; out += c; continue }
      if (c === '`') { state = 'template'; out += c; continue }
      out += c
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c }
      continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i++ }
      // 换行保留，避免把两行粘成一行后产生假匹配。
      else if (c === '\n') out += c
      continue
    }
    // 字符串态：处理转义，遇到对应闭合引号回到 code。
    const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`'
    if (c === '\\') { out += c + (next ?? ''); i++; continue }
    if (c === quote && state !== 'template') { state = 'code'; out += c; continue }
    out += c
  }
  return out
}

/**
 * ⚠️⚠️ **必须逐用例隔离两个模块级缓存**（2026-10-27）。
 *
 * `claimCodeArtsBenefitShared` 的跨请求去重表与 `codeArtsBenefitLearned` 都是
 * **模块级**的 —— 那是生产想要的行为（同一凭据 60s 内只领一次、补头成功过就记住），
 * 但单测里会**跨用例污染**：前一条用例领过 ⇒ 后一条在 60s 窗口内复用旧 Promise
 * ⇒ `claimCalls` 变 0，报出「领了一次却没发请求」这种无从归因的假红（实测踩过）。
 *
 * ⚠️ 也可能反向污染：前一条用例「补头成功」把模型记进 learned ⇒ 后一条
 * 「未确认」用例变成直接带头 ⇒ 序号序列整体错位。
 */
beforeEach(() => {
  resetCodeArtsBenefitClaimFlight()
  resetCodeArtsBenefitLearned()
  setBenefitMemoryCache(undefined)
})

describe('CodeArtsAdapter', () => {
  it('providerInfo identifies the codearts route', () => {
    expect(makeAdapter().providerInfo('codearts')).toMatchObject({ id: 'codearts', name: 'CodeArts Agent' })
  })

  it('listModels advertises the openpangu-2.0 and deepseek-v4 models alongside the GLM family', async () => {    // 对齐 deveco-code-rust 参考实现 codearts.rs：新增盘古模型
    // openpangu-2.0-flash (92B) / openpangu-2.0-pro (505B)，
    // 后端 /v1/default/models 下发的 model_id 为全小写。
    //
    // ⚠️⚠️ 2026-10-27 兜底表全表真机实测校准（本用例跟着改）：
    // - `deepseek-v4-pro` **已下架**：不带 maas_type 回 `ModelArts.81009 Invalid model`
    // - `deepseek-v4-flash` **仍然可用**（200）：虽不在 builtin 目录里，但真机能调通
    //   ⇒ 保留（判据是「能不能调通」，不是「在不在目录里」）
    // - 新增 `deepseek-v4.1-flash-1017`（issue IKQY27）：与老版是两个独立注册的模型
    //
    // ⚠️ benefit 头的判定**不属本用例范围**：由 PR #156 统一处理（静态兜底表将被
    //    删除，唯一权威改为远端 gateway/config 的 result.models）。
    const models = await makeAdapter().listModels('codearts')
    const ids = models.map(model => model.id)
    expect(ids).toContain('openpangu-2.0-flash')
    expect(ids).toContain('openpangu-2.0-pro')
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).toContain('deepseek-v4.1-flash')
    expect(ids).toContain('deepseek-v4.1-flash-1017')
    // 已下架（实测 404）的不得再出现，否则用户选中后必然失败。
    expect(ids).not.toContain('deepseek-v4-pro')
    const flash = models.find(model => model.id === 'openpangu-2.0-flash')
    const pro = models.find(model => model.id === 'openpangu-2.0-pro')
    const dsFlash = models.find(model => model.id === 'deepseek-v4-flash')
    expect(flash).toMatchObject({ provider: 'codearts', name: 'openpangu-2.0-flash' })
    expect(pro).toMatchObject({ provider: 'codearts', name: 'openpangu-2.0-pro' })
    expect(dsFlash).toMatchObject({ provider: 'codearts', name: 'deepseek-v4-flash' })
    // 默认模型仍是 GLM-5.2（新增模型不应改变默认模型）。
    expect(ids[0]).toBe('GLM-5.2')
  })

  /**
   * ★★ `catalogConfirmedRemote()` 三态 —— 供 `model.list` 的「已下架」判据用。
   *
   * ## 为什么需要它（PR159 首版的缺口，2026-10-28 修）
   *
   * `model.list` 会据「模型不在全量目录里」判断它已被上游下架、从而**不补回**
   * 设置页。但 `listAllModels()` 在**冷缓存 / 远端降级**下返回的是**编译期兜底
   * 表**（远端目录的**子集** —— Issue IKJW33 实测 `cline` 冷缓存 3 条 vs 远端
   * 460 条）。拿子集当在售集合 ⇒ 用户关掉的**在售**模型（例如 codearts 只存在于
   * 远端的新模型 `glm-5.3`）会被判成已下架 ⇒ 从设置页彻底消失、再也打不开。
   *
   * ⇒ 只有本方法返回 `true`（**证明**这份目录来自远端完整读取）时才允许隐藏。
   *
   * ⚠️ 判据两条腿都必须成立，缺一即 `false`（保守）：
   * - 从未拉到远端（`remoteModels === undefined`）⇒ 目录是兜底子集；
   * - 拉到了但**残缺**（两个目录端点只有一个成功）⇒ 同样是子集。
   */
  it('★★ catalogConfirmedRemote：冷启动 / 远端完整 / 远端残缺 三态', async () => {
    // ① 冷启动：从未成功拉到远端（默认 `fetchRemoteModels` 未注入）⇒ false
    const cold = makeAdapter()
    expect(cold.catalogConfirmedRemote(), '冷启动时目录只是兜底子集，不得据此判已下架').toBe(false)

    // ② 远端成功且两个端点都取全 ⇒ true
    const warm = makeAdapter({
      fetchRemoteModels: async () => [{ id: 'GLM-5.2', name: 'GLM-5.2' }],
      catalogComplete: () => true,
    })
    await warm.listModels('codearts')
    expect(warm.catalogConfirmedRemote()).toBe(true)

    // ③ 远端读到了、但残缺（只有一个端点成功）⇒ false（残缺目录同样不能反推「已下架」）
    const partial = makeAdapter({
      fetchRemoteModels: async () => [{ id: 'GLM-5.2', name: 'GLM-5.2' }],
      catalogComplete: () => false,
    })
    await partial.listModels('codearts')
    expect(partial.catalogConfirmedRemote()).toBe(false)
  })

  it('resolveModel discloses contextWindow for every model in the catalog', async () => {
    // ⚠️ 2026-10-29 重取证（IDE 0.2.6 抓包 record 38 + AgentCenter 双源一致）：
    //    权威来源是 IDE 自己下发的 `provider["inferhub-provider"].models[*].limit.context`。
    //    - GLM-5.2：**202_752**（09-11~10-20 是 202_752；10-21 改 1M；
    //      **10-29 又改回 202_752** —— 三次漂移史见 CONTEXT_WINDOWS 注释，
    //      运行时权威已由 AgentCenter 动态下发，本表只是冷缓存兜底）
    //    - glm-5.3：1_048_576（2026-10-21 报障模型，原先**完全没有**条目）
    //    - openpangu-2.0-flash / -pro：524_288（原先没有条目 ⇒ 用户没有占用条）
    //    - deepseek-v4.1-flash：1_048_576（本表原先写 1_000_000，按 IDE 权威值改正）
    // ⚠️ **本家不再有「context 为 undefined」的目录条目** —— 表里查不到时走
    //    具名兜底 `CODEARTS_FALLBACK_CONTEXT_WINDOW`（真实报障：缺窗口 ⇒
    //    DSH 的上下文占用条整条不渲染）。逐项守卫见
    //    `codearts-context-window.spec.ts`。
    const adapter = makeAdapter()
    const glm52 = await adapter.resolveModel('codearts', 'GLM-5.2')
    expect(glm52.context).toEqual({ contextWindow: 202_752 })
    const glm53flash = await adapter.resolveModel('codearts', 'glm-5.3-flash')
    expect(glm53flash.context).toEqual({ contextWindow: 1_048_576 })
    const glm53 = await adapter.resolveModel('codearts', 'glm-5.3')
    expect(glm53.context).toEqual({ contextWindow: 1_048_576 })
    const dsFlash = await adapter.resolveModel('codearts', 'deepseek-v4-flash')
    expect(dsFlash.context).toEqual({ contextWindow: 1048576 })
    const dsPro = await adapter.resolveModel('codearts', 'deepseek-v4-pro')
    expect(dsPro.context).toEqual({ contextWindow: 1048576 })
    const dsV41Flash = await adapter.resolveModel('codearts', 'deepseek-v4.1-flash')
    expect(dsV41Flash.context).toEqual({ contextWindow: 1_048_576 })
    // 表里**没有**条目的模型也必须给出窗口（否则用户看不到占用比）。
    const glm51 = await adapter.resolveModel('codearts', 'GLM-5.1')
    expect(glm51.context).toEqual({ contextWindow: 524_288 })
    const pangu = await adapter.resolveModel('codearts', 'openpangu-2.0-pro')
    expect(pangu.context).toEqual({ contextWindow: 524_288 })
  })

  // 回归：dsh-llm 0.1.1-rc.2 的 LlmRuntime.prepareCall() 会直接调用
  // registration.adapter.prepareCall()，而本仓库链接的副本（0.1.0-rc.6）
  // 的 LlmAdapter 基类没有该方法——缺少时每轮请求都以
  // `registration.adapter.prepareCall is not a function` 失败。
  it('prepareCall resolves the model and binds its stream', async () => {
    const adapter = makeAdapter()
    expect(typeof adapter.prepareCall).toBe('function')
    const call = await adapter.prepareCall('codearts', 'GLM-5.2')
    expect(call.model).toMatchObject({
      provider: 'codearts',
      id: 'GLM-5.2',
      // 2026-10-29 双源取证：GLM-5.2 = 202_752（漂移史见 CONTEXT_WINDOWS）。
      context: { contextWindow: 202_752 },
      inputModalities: ['text'],
    })
    expect(typeof call.stream).toBe('function')
  })

  // 回归（2026-09-29）：CodeArts 此前**从不声明** `reasoning`，故模型选择器里
  // 没有思考档位可选。实测该网关唯一真正生效的思考控制是顶层 `thinking.type`：
  //   - `{type:'disabled'}` → `reasoning_tokens` 3/3 全为 0、正文仍正确；
  //   - `{type:'enabled'}` 与不传等价（服务端默认就开着）。
  // 而 `reasoning_effort`（low/high/none/minimal）与嵌套 `reasoning.effort`
  // **都被接受但完全无效果**（落在基线噪声内，`none` 也照常思考）。
  // 故只声明「关闭 / 开启」两档（**强度序**，Issue IKLIDV），**不得**臆造 low/high/max 强度阶梯。
  it('resolveModel declares the thinking on/off switch for every model', async () => {
    const adapter = makeAdapter()
    for (const model of ['GLM-5.2', 'glm-5.3-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'openpangu-2.0-pro']) {
      const resolved = await adapter.resolveModel('codearts', model)
      // ⚠️ **顺序 = 强度序（弱 → 强）**（Issue IKLIDV）：`off`(rank 0) 必须在
      // `on`(rank 5) 之前。DSH 把该数组当**展示顺序**（`dsh-llm` 类型注释
      // `adapter-preferred display order`），客户端直接 `map` 不排序
      //（`dsh-client-ui-model-selection/lib/client.js` 的 `effortChoices`）
      // ⇒ 写成 `['on','off']` 会让「开启」落在横向档位轴的最左。
      expect({ model, efforts: resolved.reasoning?.efforts.map(e => e.id) }).toEqual({
        model, efforts: ['off', 'on'],
      })
      // 展示名必须是中文（DSH 直接渲染 name，不本地化）。
      expect(resolved.reasoning?.efforts.map(e => e.name)).toEqual(['关闭', '开启'])
      // ⚠️ defaultEffort 必须落在 efforts 内，否则 DSH 会抛
      // INVALID_MODEL_REASONING（dsh-llm 的 normalizeModelInfo 校验；
      // ⚠️ 不是 UNSUPPORTED_REASONING_EFFORT —— 那个码指「请求档位不在声明内」，实测确认）。
      expect(resolved.reasoning?.defaultEffort).toBe('on')
      // ⚠️ 默认档**与数组位置解耦**：靠 `defaultEffort` 表达，不靠「排首位」。
      expect(resolved.reasoning!.efforts.some(e => e.id === resolved.reasoning!.defaultEffort)).toBe(true)
      // 默认档**不是**首项 —— 顺序规整后这条才有判别力（旧顺序下首项恰是 'on'）。
      expect(resolved.reasoning!.efforts[0]!.id).not.toBe(resolved.reasoning!.defaultEffort)
    }
  })

  /**
   * ⚠️ **未知模型与已知模型必须同一份档位顺序**（Issue IKLIDV）。
   *
   * 同一文件里原先写了**两份**逐字相同的 `['on','off']` 字面量
   *（`toCatalogEntry` 与 `unknownModelReasoning`）—— 那正是「一文件两套同义判据」
   * 的形态：只改一处，用户**手填模型 id** 时看到的档位轴方向会与已知模型相反，
   * 而两条路径各自都能通过「只断言自己那份」的用例。
   *
   * 本用例把两者**放在一起比较**，故任何一处漏改都会红。
   */
  it('⚠️ 未知模型的档位顺序必须与已知模型一致（同一事实不许写两份）', async () => {
    const known = await makeAdapter().resolveModel('codearts', 'GLM-5.2')
    const unknown = await makeAdapter().resolveModel('codearts', '手填-不存在的模型-id')
    expect(unknown.reasoning?.efforts.map(e => e.id))
      .toEqual(known.reasoning?.efforts.map(e => e.id))
    expect(unknown.reasoning?.efforts.map(e => e.name))
      .toEqual(known.reasoning?.efforts.map(e => e.name))
    expect(unknown.reasoning?.defaultEffort).toBe(known.reasoning?.defaultEffort)
  })

  /**
   * ⚠️ **同一事实的三处出口必须同源**（Issue IKLIDV，源码级守卫）。
   *
   * 这两档在本文件里被消费三次：`toCatalogEntry`（已知模型）、
   * `unknownModelReasoning`（未知/手填模型）、以及 `stream()` 里给
   * `planSessionTitleThinking` 的 `declaredEfforts`。
   *
   * ⚠️ 为什么必须是**源码级**断言：三处的**行为断言抓不到漂移**。
   * - 前两处我已用「放在一起对比」的行为用例锁住；
   * - 但第三处（`declaredEfforts`）是**语义等价**的 —— `thinkingOffEffortOf`
   *   按 rank 找关闭档、不看顺序，所以把它退回硬编码 `['on','off']`
   *   后**行为完全不变**、所有行为用例照绿（反向验证实测确认）。
   *   而它一旦漂移，症状是「标题请求挑的关闭档不在声明里」这种静默失效。
   *
   * ⚠️⚠️ **本用例第一版有三个实测到的漏洞（审计发现，已逐一补堵）**：
   * 1. **假红**：①②锚在**含注释**的原文上，而本文件的注释里恰恰大量出现这些片段
   *   ⇒ 一句「应写作 `efforts: [...CODEARTS_REASONING_EFFORTS]`」的注释就能把
   *   计数从 2 顶到 3 而**误报**。现在**先剥注释再数**。
   * 2. **假红**：①写死「恰好 2 处」⇒ 将来合法地新增第三处出口（或把两处收敛成
   *   一个局部常量）都会变红。现在改用**「≥2 且与已知/未知两条路径各自绑定」**
   *   的判据，并把「不得有内联字面量」交给 ③ 反向守。
   * 3. **假绿（最严重）**：③原先只认**单引号、单行、裸字符串**形态
   *   ⇒ 把 HEAD 的**真实历史写法**（跨行对象字面量
   *   `{ id: ReasoningEffortId('on'), name: '开启' }`）写回内联**照样全绿**。
   *   现在 ③ 覆盖：单/双引号、跨行、以及 `ReasoningEffortId('on')` 对象字面量，
   *   并先用**字符级状态机**剥注释（正则做不到，见下方 helper 的注释）。
   *
   * ⚠️ 本用例**天生是文本匹配**，做不到语言级准确；它的定位是「防手改漏改」的
   * 粗网，不是编译器。**已实测的取舍**：把两处 `[...CODEARTS_REASONING_EFFORTS]`
   * 提前收敛成一个局部 `const` 再引用，本用例会**变红**（判据要求「直接引用该常量」）。
   * 那是**有意的**：那种重写要么同步改这里、要么说明「同源」这个性质已经换了表达
   * —— 无论哪种都该有人**看一眼**，而不是让守卫静默失效。故遇到假红请**改这里**，
   * **不要**删掉它了事（它守的是「三处同源」这个行为断言结构上抓不到的性质）。
   */
  it('⚠️ 档位的三处出口必须同源（同一常量），不得各写一份字面量', () => {
    const raw = readFileSync(new URL('../../src/llm-adapter.ts', import.meta.url), 'utf8')
    /**
     * ⚠️ **必须用字符级状态机剥注释**，不能用正则：
     * - 非贪婪的「块注释到块注释结束」配对，遇到注释里孤立的块注释起始符
     *   会与**后面的**结束符配对，把中间真码整段吃掉 ⇒ 反向断言恒绿（位置相关的假绿，实测）；
     * - 只剥「整行是块注释」的行也不行：本文件的 JSDoc 是**多行**的，
     *   只剥首尾行会留下一堆以 `*` 开头的正文行，其中的示例字面量会被当真码（实测假红）。
     *
     * 状态机：区分「代码 / 行注释 / 块注释 / 字符串」，注释内容整体丢弃、
     * 其余原样保留。字符串**保留内容**（本用例要匹配的正是字符串字面量里的 `'on'`），
     * 但把引号内的转义处理好，避免 `'\''` 之类误判状态。
     */
    const code = stripCommentsAndKeepStrings(raw)

    // ① 两条「按目录条目产出档位」的路径都必须从同一常量派生（≥2 处）。
    expect(
      (code.match(/efforts:\s*\[\.\.\.CODEARTS_REASONING_EFFORTS\]/g) ?? []).length,
      '已知模型与未知模型两条路径都必须引用 CODEARTS_REASONING_EFFORTS',
    ).toBeGreaterThanOrEqual(2)
    // ② 标题请求的 declaredEfforts 也必须从该常量派生（允许折行）。
    expect(code).toMatch(/declaredEfforts:\s*CODEARTS_REASONING_EFFORTS\s*\n?\s*\.map\(/)

    // ③ 反向：剥掉注释后的**代码**里不得再出现这两档的内联字面量。
    //    覆盖历史/可能的写法：裸串（单/双引号、单行/跨行）、ReasoningEffortId 对象字面量。
    //
    //    ⚠️ **必须先挖掉常量自身的定义块** —— 那份定义**本来就该**是字面量
    //    （它是唯一权威），不排除它会把自己判成违规（实测：整条断言恒红）。
    //    挖掉的范围以 `CODEARTS_REASONING_EFFORTS ... ])` 为界（到 Object.freeze 收尾）。
    const definitionOfConstant =
      /export const CODEARTS_REASONING_EFFORTS[\s\S]*?Object\.freeze\(\[[\s\S]*?\]\)/
    expect(definitionOfConstant.test(code), '常量定义块应存在（否则本用例的排除范围失效）').toBe(true)
    const codeOutsideConstant = code.replace(definitionOfConstant, '')

    const inlineEffortArray =
      /\[\s*(?:['"](?:on|off)['"]\s*,\s*){2}\]|\[\s*(?:\{\s*id:\s*ReasoningEffortId\(\s*['"](?:on|off)['"]\s*\)[\s\S]{0,80}?\}\s*,?\s*){2}\]/
    expect(codeOutsideConstant, '档位数组不得再内联字面量（应引用 CODEARTS_REASONING_EFFORTS）')
      .not.toMatch(inlineEffortArray)
    // ④ 反向：`declaredEfforts` 不得退回内联字面量。
    expect(code, 'declaredEfforts 不得退回内联字面量')
      .not.toMatch(/declaredEfforts:\s*\[\s*['"](?:on|off)['"]/)
  })

  /**
   * 思考开关：**按 IDE 的 `enable_thinking` 方言**（2026-10-30 与 IDE 抓包对齐后改）。
   *
   * ⚠️ 旧实现发顶层 `thinking:{type:'disabled'}`（2026-09-29 测出来的「唯一生效控制」）。
   * 本次真机判别推翻了「唯一」：`enable_thinking` 的 `true`/`false` **双向都生效**
   * （判据 `reasoning_tokens`：true=34、false=n/a 且 reasoning 字符 0、不发=45）。
   * 既然 IDE 用的是 `enable_thinking`，就只留这一份方言，不再发 `thinking`。
   */
  it('maps the "off" effort onto enable_thinking=false, and sends enable_thinking=true for "on"', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const run = async (reasoningEffort?: string) => {
      const opts = {
        provider: 'codearts',
        model: 'deepseek-v4-flash',
        messages: [],
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
        signal: new AbortController().signal,
      } as never
      for await (const _ of adapter.stream(opts)) { /* drain */ }
      return seen.at(-1)!
    }

    const off = await run('off')
    expect(off.enable_thinking).toBe(false)
    // ⚠️ 旧方言**不得**再发（同一语义两个字段 = 迟早分叉）。
    expect(off.thinking).toBeUndefined()
    expect(off.extra_body).toBeUndefined()

    const on = await run('on')
    expect(on.enable_thinking).toBe(true)
    expect(on.thinking).toBeUndefined()

    // 未指定档位 ⇒ 宿主注入默认档（本家 'on'）⇒ 同样是 true
    const unset = await run(undefined)
    expect(unset.enable_thinking).toBe(true)
  })

  /**
   * ⚠️ 输出上限必须在**出站 body** 上锁死，不能只测网关层的归一化函数。
   *
   * 真实缺陷（PR !70 审计发现）：钳制原先只做在
   * `openai-gateway/messages.ts` 的 `normalizeMaxTokens`，而
   * `maxTokens` 是 agent 的一等构造参数（`dsh-agent-loop` 只校验
   * 「正安全整数」、**无上限校验**）⇒ **不经过网关的直连路径完全绕过那道判据**，
   * 128000 会原样发往华为云（上游回 `The request param is invalid`）。
   * 这与 TRAE 的 `clampTraeMaxTokens`、Cline 的 `clampClineMaxTokens` 同因。
   *
   * ⇒ 回归用例必须经 `stream()` 的真实链路、断言**实际发出去的** `max_tokens`；
   * 直接调纯函数会像本仓库既往教训（AGENTS.md「包装适配器」）那样全绿而测不到生产路径。
   */
  describe('输出上限钳制（最后一道防线）', () => {
    /** 跑一次真实 stream()，返回出站请求体。 */
    const sentBody = async (maxTokens: unknown, model = 'deepseek-v4-flash') => {
      const seen: Array<Record<string, unknown>> = []
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      })
      const adapter = makeAdapter({ fetchImpl })
      const opts = {
        provider: 'codearts', model, messages: [], maxTokens,
        signal: new AbortController().signal,
      } as never
      for await (const _ of adapter.stream(opts)) { /* drain */ }
      return seen.at(-1)!
    }

    it('显式传入超大 maxTokens 时收敛到 65536（修复前是原样透传 128000）', async () => {
      expect((await sentBody(128_000)).max_tokens).toBe(65_536)
      expect((await sentBody(131_072)).max_tokens).toBe(65_536)
      expect((await sentBody(999_999)).max_tokens).toBe(65_536)
    })

    it('较小的请求值原样保留（钳制只往下压，不往上抬）', async () => {
      expect((await sentBody(32_000)).max_tokens).toBe(32_000)
      expect((await sentBody(64)).max_tokens).toBe(64)
      expect((await sentBody(65_536)).max_tokens).toBe(65_536)
    })

    /**
     * ⚠️ 2026-10-30 与 IDE 对齐后：**缺省值 65536 → 32000**。
     *
     * 取证：Reqable 4 条真实 IDE 请求的 `max_tokens` **恒 32000**（4/4），
     * 而 AgentCenter 给该模型的**上限**是 65536 ⇒ 32000 是 IDE 的**默认预算**，
     * 不是能力边界。⇒ 缺省时对齐 IDE 的 32000；**钳制上界仍是 65536**
     * （调用方明确要长输出时不许被静默削掉，见下方那条用例）。
     */
    it('未传 / 非法值回落到 IDE 默认预算 32000（不编造别的数值）', async () => {
      for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect((await sentBody(bad)).max_tokens, String(bad)).toBe(32_000)
      }
    })

    it('对**每一个** CodeArts 模型都生效 —— 适配器层是统一边界，不逐模型开洞', async () => {
      for (const model of ['GLM-5.2', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'openpangu-2.0-pro']) {
        expect((await sentBody(128_000, model)).max_tokens, model).toBe(65_536)
      }
    })
  })

  /**
   * ⚠️⚠️ 守卫：**出站字段集必须与 IDE 抓包对齐**（2026-10-30）。
   *
   * 判据来自 Reqable 4 条真实 IDE 聊天请求（键集 4/4 完全一致）：
   * `enable_thinking, max_tokens, messages, model, stream, stream_options,
   *  temperature, tool_choice, tool_stream, tools, user_prompt`
   *
   * 本用例只钉**插件曾经缺的 5 个**与**必须删掉的 2 个**：
   * - 缺过：`enable_thinking` / `stream_options` / `temperature` / `tool_choice` / `user_prompt`；
   * - 多发：`include` / `reasoning_summary`（IDE 从不下发，本仓也无消费者）。
   *
   * ⚠️ `prompt_cache_key` **刻意保留**（唯一有意偏离 IDE 的字段，理由见
   * llm-adapter.ts 的长注释）⇒ 本用例**不断言它缺席**，否则会把那处有意设计判红。
   */
  it('出站字段集与 IDE 抓包对齐：补齐 5 个、移除 IDE 不发的 2 个', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    // ⚠️ 必须用**非 DSML** 模型（`deepseek-v4-flash` 走 DSML，会刻意不发 tools
    // ⇒ `tool_choice` 随之省略，用它测这一条会假红）。`deepseek-v4.1-flash-1017`
    // 实测 `needsDsmlToolMode === false`，正是 GUI 的真实路径。
    const adapter = makeAdapter({ fetchImpl })
    for await (const _ of adapter.stream({
      provider: 'codearts',
      model: 'deepseek-v4.1-flash-1017',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '第一句' }] },
        { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
        { role: 'user', content: [{ type: 'text', text: '这一句应成为 user_prompt' }] },
      ],
      tools: [{
        name: 'bash',
        description: 'Run shell',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      }],
      reasoningEffort: 'on',
      signal: new AbortController().signal,
    } as never)) { /* drain */ }
    const body = seen.at(-1)!

    // ① IDE 有、插件曾缺的 5 个
    expect(body.enable_thinking).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.temperature).toBe(0)
    expect(body.tool_choice).toBe('auto')
    expect(body.user_prompt).toBe('这一句应成为 user_prompt')

    // ② IDE 从不发、插件曾多发的 2 个
    expect(body.include).toBeUndefined()
    expect(body.reasoning_summary).toBeUndefined()

    // ③ 既有的共同字段仍在
    expect(body.stream).toBe(true)
    expect(body.tool_stream).toBe(true)
    expect(body.model).toBe('deepseek-v4.1-flash-1017')
  })

  /**
   * ⚠️ DSML 分支的**有意差异**：该分支刻意不发 `tools`（工具 schema 改注入 system 提示），
   * ⇒ `tool_choice` 也随之省略（没有 `tools` 时它无意义）。本用例把这条差异
   * **钉死**，防止有人为了「对齐 IDE」在 DSML 分支上强行补发 `tools`。
   */
  it('DSML 模型不发 tools、因而也不发 tool_choice（有意差异，勿强行对齐）', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    for await (const _ of adapter.stream({
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{
        name: 'bash',
        description: 'Run shell',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      }],
      signal: new AbortController().signal,
    } as never)) { /* drain */ }
    const body = seen.at(-1)!
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  /**
   * ⚠️ `user_prompt` 的取值语义：**最后一条真正的用户发言**，不是工具结果。
   *
   * ⚠️⚠️ 若从**序列化后**的 wire 数组取，工具结果被展平成 `role:'tool'`、
   * 而 harness 原始消息里工具结果搭载在 **user** 消息中 ⇒ 会取到几百 KB 的
   * 文件内容，与 IDE「用户一句话」的语义完全相反。本用例专钉这一点。
   */
  it('user_prompt 取「用户原话」而非工具结果（末尾是工具结果时回退）', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    for await (const _ of adapter.stream({
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '请读文件' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"cat a"}' }],
        },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'AAA' }] }] },
      ],
      signal: new AbortController().signal,
    } as never)) { /* drain */ }
    expect(seen.at(-1)!.user_prompt).toBe('请读文件')
  })

  it('streams text deltas from an OpenAI-compatible SSE response', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":" there"}}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const chunks: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') chunks.push(chunk.text)
    }
    expect(chunks).toEqual(['hi', ' there'])
  })

  it('refreshes an expired credential before streaming and signs the request', async () => {
    let refreshed = false
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(String(input)).toBe(`${CHAT_API_BASE}/chat/completions`)
      expect(headers.get('Authorization')).toMatch(/^SDK-HMAC-SHA256 Access=AK/)
      expect(headers.get('x-security-token')).toBe('ST')
      expect(headers.get('Chat-Id')).toBeTruthy()
      expect(headers.get('user-agent') ?? '').not.toMatch(/^deepseek-harness\//i)
      expect(refreshed).toBe(true)
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({
      credential: { ...validCredential, expires_at: '2020-01-01T00:00:00Z' },
      refresh: async () => { refreshed = true },
      fetchImpl,
    })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(refreshed).toBe(true)
    expect(texts).toEqual(['ok'])
  })

  it('★ glm-5.3-flash 已从兜底表移除（实测 404，不再是可用模型）', async () => {
    // ⚠️⚠️ 2026-10-27 改写（原用例断言「目录里有 glm-5.3-flash」）。
    //
    // 旧事实（2026-09，对齐 deveco-code-rust 90aeb17d）：它是 benefit 免费额度
    // 模型，后端注册 id 全小写 `glm-5.3-flash`。
    //
    // 新事实（真机实测）：不带头回 `InferHub.002002009.404 The model is not
    // registered` —— 它已不是当前可调用的模型。
    // ⚠️ 至于「它是否随福利活动下线」的**归因**留给 PR #156（那边把 benefit
    //    判定整体改为只认远端集合），本用例只锁「兜底表不再列它」这一事实。
    const models = await makeAdapter().listModels('codearts')
    expect(models.map((model) => model.id)).not.toContain('glm-5.3-flash')
    // 默认模型仍是 GLM-5.2。
    expect(models[0]!.id).toBe('GLM-5.2')
  })

  it('signs glm-5.3-flash requests with the maas_type: benefit header', async () => {
    // glm-5.3-flash 是 benefit（免费额度）模型：maas_type: benefit 必须
    // 参与 SDK-HMAC-SHA256 签名并随请求发送，否则后端返回
    // InferHub.002002009.404 "model is not registered"。
    // （逆向自 CodeArts Agent IDE mitmproxy 抓包，对齐 deveco-code-rust 90aeb17d。）
    // ⚠️ 必须显式声明「远端集合确认过它」：删掉静态兜底表后，首次是否带头
    // 完全取决于远端 `gateway/config` 集合；不声明就会读到本机真实缓存，
    // 断言会随开发机的缓存内容漂移。
    setBenefitMemoryCache(['glm-5.3-flash'])
    try {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        expect(headers.get('maas_type')).toBe('benefit')
        const auth = headers.get('Authorization') ?? ''
        expect(auth).toContain('maas_type')
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
      })
      const adapter = makeAdapter({ fetchImpl })
      const texts: string[] = []
      for await (const chunk of adapter.stream({ ...streamOptions, model: 'glm-5.3-flash' } as never)) {
        if (chunk.type === 'text-delta') texts.push(chunk.text)
      }
      expect(texts).toEqual(['ok'])
    } finally {
      setBenefitMemoryCache(undefined)
    }
  })

  it('does not send maas_type for other models', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('maas_type')).toBeNull()
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({ fetchImpl })
    for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('signs deepseek-v4.1-flash with maas_type: benefit（真实缺陷回归）', async () => {
    // 真实缺陷（用户报障，2026-09-23）：deepseek-v4.1-flash 是 benefit 模型，
    // 必须带 maas_type: benefit，而早期实现把该集合硬编码为只有 glm-5.3-flash
    // → 发消息后调用失败（实测不带该头返回 InferHub.002002009.404
    // "The model is not registered"，带上即成功）。
    // 对齐 deveco-code-rust fb1b4a2 的动态判定。
    // 2026-10-25 起：**首次请求是否带头**只看「远端集合是否明确列出该模型」
    // （`isCodeArtsBenefitModelKnown`，判据只剩远端 gateway/config 集合）。
    // 这里把它放进远端集合，模拟「后端确认它是 benefit 模型」的形态
    // ⇒ 首次请求即带头并参与签名。
    // 未确认的形态由后面「404 → 补头」用例覆盖。
    setBenefitMemoryCache(['deepseek-v4.1-flash'])
    try {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        expect(headers.get('maas_type')).toBe('benefit')
        // 必须参与 SDK-HMAC-SHA256 签名（出现在 SignedHeaders 中），
        // 否则服务端验签失败。
        expect(headers.get('Authorization') ?? '').toContain('maas_type')
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
      })
      const adapter = makeAdapter({ fetchImpl })
      const texts: string[] = []
      for await (const chunk of adapter.stream({ ...streamOptions, model: 'deepseek-v4.1-flash' } as never)) {
        if (chunk.type === 'text-delta') texts.push(chunk.text)
      }
      expect(texts).toEqual(['ok'])
    } finally {
      setBenefitMemoryCache(undefined)
    }
  })

  it('does not send maas_type for the suffix-less deepseek-v4-flash', async () => {
    // 无后缀 deepseek-v4-flash 是**非 benefit** 模型（带 maas_type 反而
    // `unsupported model`）；它是 gateway 的 -0731 形态经归一化后的 id，
    // 而 -0731 才是 benefit —— 两者是后端上不同的模型，不能混为一谈。
    setBenefitMemoryCache([])
    try {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('maas_type')).toBeNull()
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
      })
      const adapter = makeAdapter({ fetchImpl })
      for await (const _ of adapter.stream({ ...streamOptions, model: 'deepseek-v4-flash' } as never)) { /* drain */ }
      expect(fetchImpl).toHaveBeenCalled()
    } finally {
      setBenefitMemoryCache(undefined)
    }
  })

  it('refreshes the credential once when the chat request fails with APIG.0602 and retries successfully', async () => {
    // CodeArts 经华为 APIG 网关鉴权：SecurityToken 过期/无效时网关返回
    // APIG.0602 "Invalid token"。入口的 expires_at 预判无法覆盖后端提前
    // 吊销或时钟偏差，stream() 应在收到该错误后触发一次静默 refresh，
    // 用新凭据重试 chat 请求；最多 refresh 一次，避免死循环。
    let refreshed = false
    let chatCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(JSON.stringify({ status: 'working', queue_position: 0, message: '' }))
      }
      chatCalls += 1
      if (chatCalls === 1) {
        return new Response(JSON.stringify({ error_code: 'APIG.0602', error_msg: 'Invalid token' }), { status: 401 })
      }
      // 第二次请求在 refresh 后发出，应使用刷新后的凭据（makeAdapter 的
      // refresh() 会把 credential 恢复为 validCredential）。
      const headers = new Headers(init?.headers)
      expect(headers.get('x-security-token')).toBe('ST')
      expect(refreshed).toBe(true)
      return new Response('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({
      refresh: async () => { refreshed = true },
      fetchImpl,
    })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(chatCalls).toBe(2)
    expect(refreshed).toBe(true)
    expect(texts).toEqual(['recovered'])
  })

  it('does not refresh more than once on repeated auth errors', async () => {
    // 连续两次 APIG.0602：第一次触发 refresh+重试，第二次仍失败应直接抛 AUTH，
    // 不再刷新，避免死循环。
    let refreshCount = 0
    let chatCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(JSON.stringify({ status: 'working', queue_position: 0, message: '' }))
      }
      chatCalls += 1
      return new Response(JSON.stringify({ error_code: 'APIG.0602', error_msg: 'Invalid token' }), { status: 401 })
    })
    const adapter = makeAdapter({
      refresh: async () => { refreshCount += 1 },
      fetchImpl,
    })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'AUTH' })
    expect(chatCalls).toBe(2)
    expect(refreshCount).toBe(1)
  })

  it('throws MISSING_CREDENTIAL when no credential is available', async () => {
    // 直接构建适配器：makeAdapter 的 refresh() 会恢复
    // 有效凭据，因此"刷新后仍无凭据"需要用原始适配器。
    const adapter = new CodeArtsAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchImpl: async () => new Response('not found', { status: 404 }),
    })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('normalizes a non-2xx response to an LlmError', async () => {
    const adapter = makeAdapter({ fetchImpl: async () => new Response('nope', { status: 500 }) })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toBeInstanceOf(LlmError)
  })

  it('retries the chat request after a queue error even when the queue status is working', async () => {
    // 对齐参考实现 runner.rs：排队时直接重试 chat 请求，不轮询等待
    // working。状态端点仅在每次重试前查一次（此处 working 非终态，
    // 不抛错），等待 10s 后重试 chat 成功。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'working', queue_position: 1, message: 'admitted' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        // 第一次 chat 调用被并发上限限流。
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"queued-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts).toEqual(['queued-ok'])
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('directly retries the chat request while queued instead of waiting for working', async () => {
    // 对齐参考实现 runner.rs：排队时直接重试 chat 请求（10s 一次），
    // 不轮询等待状态端点 working。状态端点仅在每次重试前查一次，
    // 用于检测终态（error/queue_full）提前抛错。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"finally"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts).toEqual(['finally'])
    expect(calls.chat).toBe(2)
    // 排队中不轮询状态端点：仅重试前查一次。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('retries the chat request when the SSE stream carries the TPM limit error (81111.429)', async () => {
    // CodeArts 以 HTTP 200 + SSE 内嵌 error_code 返回 TPM 限流
    // （InferHub.ModelArts.81111.429），而非 4xx。适配器必须把它当成排队
    // 处理（延迟后重试 chat），而不是静默当成 [DONE] 流结束吞掉——否则
    // 用户看到"思考后无输出"。本用例：第一次请求 SSE 返回该错误，重试后
    // 第二次返回正常文本。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        // HTTP 200 + SSE 内嵌排队/限流错误（e2e 实测的真实响应形态）。
        return new Response(
          'data:{"text":"[DONE]","error_code":"InferHub.ModelArts.81111.429","error_msg":"The model TPM limit has been significantly exceeded. Please reduce the request rate and retry later."}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const blocks: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-start') blocks.push(chunk.blockType)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 81111.429 被识别为排队错误：重试 chat 后成功输出正文。
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(1)
    // 排队/限流期间零产出：只有重试成功后的正文文本块。
    expect(blocks).toEqual(['text'])
    expect(texts).toEqual(['admitted-ok'])
  }, 30_000)

  it('emits no content blocks while waiting for queue admission', async () => {
    // 排队期间适配器不得产出任何内容块：StreamChunk 协议没有瞬态状态通道，
    // reasoning/text 块都会被组装进 assistant 消息并持久化（reasoning 还会
    // 显示在 web 的 Think 区域，visible 回退可能把推理文本回传给模型），
    // 因此排队提示既不显示也不留痕，web 显示 harness 自身的"运行中"状态。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const blocks: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-start') blocks.push(chunk.blockType)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 排队期间零产出：放行后只有正文文本块。
    expect(blocks).toEqual(['text'])
    expect(texts).toEqual(['admitted-ok'])
    expect(calls.chat).toBe(2)
    // 排队中只重试前查一次状态端点（终态检测），不轮询等待 working。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('never leaks queue notices into the visible text fallback when the model returns reasoning only', async () => {
    // GLM 特性：模型可能只返回 reasoning_content 而 content 为空，适配器
    // 回退把推理作为可见文本。排队提示必须被排除在该回退之外——否则排队
    // 文本会作为正文持久化并在后续调用中作为上下文发送给模型。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        const status = calls.queue === 1 ? 'waiting' : 'working'
        return new Response(
          JSON.stringify({ status, queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"reasoning_content":"real-reasoning"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const textEnds: string[] = []
    const reasoningEnds: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'text') textEnds.push(chunk.block.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') reasoningEnds.push(chunk.block.text)
    }
    // 可见文本回退只包含模型真实推理；排队期间零产出，故绝无"排队中"字样。
    expect(textEnds.some(text => text.includes('排队中'))).toBe(false)
    expect(textEnds).toEqual(['real-reasoning'])
    // reasoning 块只有模型真实推理，不持久化任何排队文本。
    expect(reasoningEnds.every(text => !text.includes('排队中'))).toBe(true)
    expect(calls.chat).toBe(2)
    // 排队中只重试前查一次状态端点（终态检测），不轮询等待 working。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('enters the queue path for non-TM.00001041 errors when the queue endpoint reports waiting (openpangu)', async () => {
    // openpangu 等模型的并发限流错误码/HTTP 状态可能与 GLM 的
    // TM.00001041 不同（例如 HTTP 429 + 其他错误码），但只要排队状态
    // 端点确认会话在排队，适配器就必须进入排队逻辑而不是立即抛错。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        const status = calls.queue <= 2 ? 'waiting' : 'working'
        return new Response(
          JSON.stringify({ status, queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001042', error_msg: '并发请求过多，请稍后重试。' }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const reasoning: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 探测一次（确认排队）+ 重试前查一次状态端点（终态检测），重试 chat 成功。
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(2)
    // 排队期间零产出：不放行后正文之前没有任何块（无"排队中"字样）。
    expect(reasoning).toEqual([])
    expect(texts).toEqual(['admitted-ok'])
  }, 30_000)

  it('surfaces the queue error message when the queue status is terminal', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(
          JSON.stringify({ status: 'error', queue_position: -1, message: 'peak hours, try later' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toThrow(/peak hours, try later/)
  })

  it('throws a normal HTTP error when the failure is not a queue error', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error_code: 'OTHER', error_msg: 'bad request' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  /**
   * 回归（行为级）：**空体 429** 在 CodeArts 的换号入口必须换号并写入限流标记。
   *
   * ## 真实缺陷
   *
   * 「账号池里明明还有可用账号，插件却直接报错、也不换号」—— 本可自愈的限流
   * 变成硬失败。
   *
   * 该入口原本有两道各自独立的判据，**必须同时带上 `response.status`**：
   *
   * ```ts
   * if (accountPool && isRateLimited(errorText, response.status)) {   // 外层
   *   const parsed = parseRateLimitError(errorText, options.model)     // 内层
   *   if (parsed) { ...写标记 + 换号 + continue... }
   * }
   * ```
   *
   * 只补外层、漏掉内层时，空体 429 的后果是：外层判真放行 → 内层因体为空
   * （`JSON.parse('')` 抛错，且没有状态码可兜底）返回 `null` → `if (parsed)`
   * 把**整块**（写标记 + 换号 + `continue`）一起跳过 → 最终按原错误抛出。
   * 与 buddy 侧最初那个缺陷同源，只是第三条调用点漏了。
   *
   * ## 本用例的响应体刻意是**空串**
   *
   * 换任何含限流措辞的正文（如 `TM.00001042` /「请稍后重试」），外层与内层
   * 都会命中，缺陷根本不会暴露 —— 那正是既有的 429 队列用例（:548）覆盖不到
   * 它的原因：那个用例的正文本身就能被判为排队/限流。
   *
   * ⚠️ 断言刻意落在**chat 请求逐个帐号的凭据**（`chatKeys`）而不是「fetch 总
   * 调用次数」：修复前的路径会去探测排队状态端点（`queryQueueStatus`），
   * 那也是一次 `fetch`，`mock.calls.length > 1` 在缺陷下同样成立 —— 写成
   * 「次数 > 1」就是一条永远为真的假断言。
   */
  it('空体 429 在 CodeArts 换号入口同样换号并写入限流标记（状态码必须传进 parseRateLimitError）', async () => {
    // 账号池替身：只实现 `CodeArtsAdapter.stream` 真正走到的三个方法。
    // - findAccountIdByCredential：把首个凭据 AK 归属到 acct-1（决定写标记的账号）；
    // - getAvailableAccount：返回**另一个**账号 acct-2 及其凭据 AK2；
    // - updateModelRateLimit：记录标记，供断言兜底时长。
    const marked: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const pool = {
      findAccountIdByCredential: async (provider: string, identity: string) =>
        (provider === 'codearts' && identity === 'AK' ? 'acct-1' : ''),
      getAvailableAccount: async () => ({
        entry: { id: 'acct-2' },
        credential: {
          access_key_id: 'AK2', secret_access_key: 'SK2', security_token: 'ST2',
          expires_at: '2099-01-01T00:00:00Z',
        },
      }),
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        marked.push({ accountId, modelId, resetAtMs })
      },
    }

    // 只统计 **chat/completions** 请求（按 Authorization 里的 Access=<AK> 区分账号）；
    // 排队状态端点的探测请求不参与，避免假断言（见用例注释）。
    const chatKeys: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const key = /Access=([^,\s]+)/.exec(headers.get('Authorization') ?? '')?.[1] ?? ''
      if (String(input).startsWith(CHAT_API_BASE)) chatKeys.push(key)
      if (key === 'AK2') {
        // 换号后成功：SSE 形状照抄既有用例（'streams text deltas…'）。
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      // 首个账号返回**空体 429**：没有任何可识别文案，只剩状态码可判。
      return new Response('', { status: 429 })
    })

    const adapter = makeAdapter({ fetchImpl, accountPool: pool })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }

    // ① 换号后确实重试了（请求数多于一次）。
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
    // ② 第二/后续请求用的是**另一个账号**的凭据：['AK'] 表示只试了当前账号就放弃。
    expect(chatKeys).toEqual(['AK', 'AK2'])
    // ③ 失败账号被写入限流标记；空体无时刻可解析 → 必须是兜底时长（≈ 1 小时）。
    expect(marked.map(entry => entry.accountId)).toEqual(['acct-1'])
    expect(marked[0]!.modelId).toBe((streamOptions as { model: string }).model)
    const fallbackDelta = marked[0]!.resetAtMs - Date.now()
    expect(fallbackDelta).toBeGreaterThan(RATE_LIMIT_FALLBACK_MS - 60_000)
    expect(fallbackDelta).toBeLessThanOrEqual(RATE_LIMIT_FALLBACK_MS)
    // ④ 最终拿到内容，而不是把 429 抛给用户。
    expect(texts).toEqual(['ok'])
  })

  /**
   * ★★ 回归：**`getAvailableAccount` 的第 3 参（`rateLimitTried`）不得漏传**
   * （Issue IKM3ZV 同批修的 `llm-adapter.ts` HTTP 限流换号格，2026-10-18 审计补齐）。
   *
   * ## ⚠️ 为什么上面那条用例锁不住它
   *
   * 既有那条走的是「`currentAccountId` 非空 + 刚写过限流标记」的形态 ⇒ 池的
   * **模型级过滤**已经把刚失败的账号挡掉 ⇒ **漏传 `tried` 也照样能换号** ⇒ 恒绿。
   *
   * ## 本用例构造的形态：`tried` 是**唯一**排除机制
   *
   * `findAccountIdByCredential` 恒返 `''` ⇒ `currentAccountId` 为空 ⇒
   * `:1451` 的记账分支整段跳过 ⇒ 池里**没有任何限流标记** ⇒ 模型级过滤失效
   * ⇒ 此时**只有 `tried` 能挡住刚失败的账号**。
   *
   * ⚠️ 这个形态在生产上可达：反查失败（凭据已轮换 / 账号被停用）或单凭据兜底。
   *
   * ## 判别力
   *
   * 池替身**尊重 `exclude`**（真实池同形）⇒ 漏传时它会把**同一个** acct-1 再返回一次
   * ⇒ 命中 `rateLimitTried.has` 而立即放弃换号 ⇒ 报「所有账号均受限」而 acct-2 可用。
   */
  it('★★ 空体 429 换号必须传 tried（`currentAccountId` 为空、池无标记的形态）', async () => {
    /** 池里的限流标记（本形态下必须恒空，否则模型级过滤会掩盖 `tried` 的作用）。 */
    const marked: Array<{ accountId: string }> = []
    /** 每次取号收到的 exclude（判别力所在）。 */
    const excludes: Array<string[]> = []
    const accounts = [
      { id: 'acct-1', ak: 'AK' },
      { id: 'acct-2', ak: 'AK2' },
    ]
    const credentialOf = (ak: string) => ({
      access_key_id: ak, secret_access_key: `SK-${ak}`, security_token: `ST-${ak}`,
      expires_at: '2099-01-01T00:00:00Z',
    })
    const pool = {
      // ⚠️ **恒返空串** ⇒ `currentAccountId` 为空 ⇒ 上面的记账分支跳过 ⇒
      // 池里没有任何 `modelRateLimits` ⇒ 模型级过滤失效，`tried` 是唯一闸门。
      findAccountIdByCredential: async () => '',
      getAvailableAccount: async (
        _provider: string,
        _modelId: string,
        exclude?: ReadonlySet<string>,
      ) => {
        excludes.push([...(exclude ?? [])])
        const hit = accounts.find((a) => !exclude?.has(a.id))
        return hit === undefined
          ? null
          : { entry: { id: hit.id }, credential: credentialOf(hit.ak) }
      },
      updateModelRateLimit: async (accountId: string) => { marked.push({ accountId }) },
    }

    const chatKeys: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = /Access=([^,\s]+)/.exec(new Headers(init?.headers).get('Authorization') ?? '')?.[1] ?? ''
      if (String(input).startsWith(CHAT_API_BASE)) chatKeys.push(key)
      return key === 'AK2'
        ? new Response(
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        : new Response('', { status: 429 })
    })

    const adapter = makeAdapter({ fetchImpl, accountPool: pool })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }

    /**
     * ⚠️ 判别力在**第二次取号的 exclude 是否含首号**。
     *
     * ⚠️⚠️ **实测修正（2026-10-18，写这条用例时才发现）**：本形态下
     * `currentAccountId` 起手为空 ⇒ 首号 acct-1 **从未被加进 `rateLimitTried`**
     * （`:1451` 的 `if (currentAccountId)` 与其中的 `add` 一起被跳过）⇒
     * **第二次取号的 exclude 里本来就没有 acct-1** ⇒ 桩此时会**再返回 acct-1** ⇒
     * 首号被发两次（实测 `chatKeys = ["AK","AK","AK2"]`）。
     *
     * ⇒ 所以本形态**测的不是「漏传 tried」**（那是 `currentAccountId` 非空时的形态），
     * 而是一个**独立的既有行为**：首号在反查失败时不在已试集里。
     * ⚠️ 该行为**不是本 PR 引入的**（`:1451` 那段是既有代码），且它有自限性 ——
     * 第二次换号后 `currentAccountId` 变成 acct-2（非空）⇒ 后续记账与 `add` 恢复。
     *
     * ⇒ 因此本用例改为锁「**第二号真的被用上**」这条**跨实现稳定**的不变式，
     * 而把 exclude 的精确内容交给下面那条「`currentAccountId` 非空」的用例去锁。
     */
    expect(chatKeys, '第二个账号必须真的被尝试（漏传 tried 时永远轮不到它）').toContain('AK2')
    expect(texts).toEqual(['ok'])
  })

  /**
   * ★★ 同一处修复的**另一形态**：`currentAccountId` **非空** ⇒ 首号已在
   * `rateLimitTried` 里 ⇒ 漏传第 3 参时池会把首号再返回一次 ⇒ 换号立即终止。
   *
   * ⚠️ 与上面那条**互补**：上面那条锁「换号确实发生」，这条锁「**传给池的 exclude
   * 含首号**」—— 后者才是漏传时**唯一**可观测的差异。
   */
  it('★★ 空体 429 换号：池收到的 exclude 必须含首号（非空 currentAccountId 形态）', async () => {
    const excludes: Array<string[]> = []
    const accounts = [
      { id: 'acct-1', ak: 'AK' },
      { id: 'acct-2', ak: 'AK2' },
    ]
    const credentialOf = (ak: string) => ({
      access_key_id: ak, secret_access_key: `SK-${ak}`, security_token: `ST-${ak}`,
      expires_at: '2099-01-01T00:00:00Z',
    })
    const pool = {
      // ⚠️ **非空** ⇒ `:1451` 的记账分支会执行 ⇒ 首号被写标记**并**进 `rateLimitTried`
      // ⚠️ 但池替身**不实现模型级过滤** ⇒ 唯一的排除机制就是传给它的 exclude。
      findAccountIdByCredential: async (provider: string, identity: string) =>
        (provider === 'codearts' && identity === 'AK' ? 'acct-1' : ''),
      getAvailableAccount: async (
        _provider: string,
        _modelId: string,
        exclude?: ReadonlySet<string>,
      ) => {
        excludes.push([...(exclude ?? [])])
        const hit = accounts.find((a) => !exclude?.has(a.id))
        return hit === undefined
          ? null
          : { entry: { id: hit.id }, credential: credentialOf(hit.ak) }
      },
      updateModelRateLimit: async () => {},
    }

    const chatKeys: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = /Access=([^,\s]+)/.exec(new Headers(init?.headers).get('Authorization') ?? '')?.[1] ?? ''
      if (String(input).startsWith(CHAT_API_BASE)) chatKeys.push(key)
      return key === 'AK2'
        ? new Response(
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        : new Response('', { status: 429 })
    })

    const adapter = makeAdapter({ fetchImpl, accountPool: pool })
    for await (const _chunk of adapter.stream(streamOptions)) { /* 消费 */ }

    /**
     * ⚠️⚠️ 判别力：换号**只取号一次**（成功即止），但那**一次**的 exclude 必须含首号。
     *
     * ⚠️ 实测（写这条用例时验证）：修复前 `excludes = [[]]` ⇒ 池按手动顺序把
     * 刚失败的 `acct-1` 再返回一次 ⇒ `rateLimitTried.has` 命中 ⇒ **换号终止**。
     * 修复后 `excludes = [["acct-1"]]` ⇒ 池返回 `acct-2` ⇒ 两号各一发即成功。
     *
     * ⚠️⚠️ **本用例同时锁住两处**（它们缺一不可，审计只报了其中一处）：
     *   ① `:1451` 之后的 **`rateLimitTried.add(currentAccountId)`** —— 加首号；
     *   ② 传给 `getAvailableAccount` 的**第 3 参** —— 把已试集给池。
     * 只修 ① 会让排除集为空（因为它得靠 ② 传出去）；只修 ② 会因首号从未入集而仍为空。
     */
    expect(excludes, '换号必须取号一次且排除首号').toEqual([['acct-1']])
    expect(chatKeys, '两个账号各试一次').toEqual(['AK', 'AK2'])
  })

  /**
   * ★★ 上一条断言在「只删 `rateLimitTried.add(currentAccountId)`」的变异下是
   * **恒真的**（变异实测全绿）⇒ 必须有一条**直接锁「首号进已试集」**的用例。
   *
   * ## 构造：池**忽略 exclude**（返回同一个账号）
   *
   * 真实池尊重 exclude，所以「首号不在已试集」在生产上**不会**让池返回它 ——
   * 这正是上一条守不住的原因。⇒ 本用例把桩改成**忽略 exclude**，把
   * 「首号在不在 `rateLimitTried` 里」这件事**放大成可观测**：
   *
   * - 修复态：首号已入集 ⇒ `if (next && !rateLimitTried.has(next.entry.id))` 判假
   *   ⇒ **不再重发**，如实抛「所有账号均受限」⇒ 恰好 **1 次** chat 请求；
   * - 变异态：首号不在集 ⇒ 判真 ⇒ 拿同一个号再发一遍 ⇒ **2 次** chat 请求。
   *
   * ⚠️ 判别力 = **chat 请求次数**（1 vs 2）。
   */
  /**
   * ⚠️⚠️ **本用例实测无牙，如实登记**（2026-10-18 变异验证）。
   *
   * 变异：删掉 `llm-adapter.ts` 的 `rateLimitTried.add(currentAccountId)`
   * ⇒ **本用例仍绿**（B2 变异实测）。
   *
   * ## 为什么无牙（追查到的真实原因，不是「找不到原因」）
   *
   * 本用例让桩**忽略 exclude**（恒返回 `acct-1`），意图是把「首号在不在已试集」
   * 放大成可观测的请求数差异。实测该放大**不成立**：
   * B2 变异态下 `rateLimitTried` 为空 ⇒ `!has('acct-1')` 判真 ⇒ 换号继续 ⇒
   * **重发一次** ⇒ 第二轮 `has()` 命中 ⇒ 抛「所有账号均受限」。
   * ⇒ 请求数与修复态**相同**，`chatCalls` 断言分不出。
   *
   * ## 真实影响范围（如实标注）
   *
   * ⚠️ 该行缺失在**生产**上同样有自限性：真实池**尊重 exclude**，
   * 首号会在**下一轮**才被排除，而本轮它被返回后 `!has()` 判真 ⇒ 换号成功。
   * ⇒ 后果是「**首号多发一次**」，而**不是**「换号彻底失效」。
   * ⚠️ 但 `:1323`（SSE 额度格）与 `:1393`（HTTP 额度格）**一直都有**这一行 ——
   * 本格是三格里唯一的例外，属**不一致**而非「有意设计」。
   *
   * ## 为什么不补第二条用例
   *
   * 要给它造有牙的判据，必须让「首号不在集 ⇒ 换号终止」可观测，而当前三格里
   * **没有任何一条**能在缺该行时表现出不同行为（另两格那行本就有）。
   * ⇒ 按本仓库纪律**如实登记为无牙，不为它编恒真用例**。
   * ⇒ 该行仍保留（与另两格对齐），但**它的价值是「一致性」而非「有守卫」**。
   */
  it.skip('★★ 首号进 rateLimitTried（实测无牙，见上方登记）', async () => {
    expect(true).toBe(true)
  })



  it('translates tool_calls deltas into tool-call blocks so the harness can run them', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const seen: string[] = []
    let toolCallBlock: { type: 'tool-call'; id: string; name: string; arguments: string } | undefined
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      seen.push(chunk.type)
      if (chunk.type === 'tool-call-delta') {
        expect(chunk.id).toBe('call-1')
        expect(chunk.name).toBe('bash')
        expect(chunk.argumentsDelta).toContain('ls')
      }
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCallBlock = chunk.block
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(toolCallBlock).toMatchObject({ type: 'tool-call', id: 'call-1', name: 'bash' })
    expect(JSON.parse(toolCallBlock!.arguments)).toEqual({ command: 'ls' })
    expect(finishKind).toBe('tool-calls')
  })

  // 回归：tool_stream 分段传输时，参数续分片会带回 `"function":{"name":""}`。
  // 空串不是 undefined，原先的 `!== undefined` 判断会用它覆盖首个分片解析出
  // 的真实工具名，最终 block-end 输出 name:""，harness 报 `unknown tool ""`。
  it('ignores an empty function name on tool_calls argument continuation fragments', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"bash","arguments":""}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"{\\"command\\":\\"ls -"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"la\\"}"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    let toolCallBlock: { type: 'tool-call'; id: string; name: string; arguments: string } | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'tool-call-delta') expect(chunk.name).toBe('bash')
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCallBlock = chunk.block
    }
    expect(toolCallBlock).toMatchObject({ type: 'tool-call', id: 'call-1', name: 'bash' })
    expect(JSON.parse(toolCallBlock!.arguments)).toEqual({ command: 'ls -la' })
  })

  // 回归（严重，2026-09-29）：后端**完全不返回** tool_call id（或返回空串）时，
  // 早期实现把它落成 `id:''`。后果不是「这一轮失败」而是**整条会话报废**：
  //   1. `tool/call` 带 `callId:''` 落库；
  //   2. 写 `tool/result` 时 DSH 的格式 v4 校验（`assertV4ToolResultMessage`）
  //      要求 `message.toolCallId === source.callId` 且**都非空**（判 `length === 0`），
  //      于是抛
  //      `format v4 tool/result at seq N requires toolCallId matching its tool source`；
  //   3. 日志停在 `tool/call`，崩溃恢复 `interruptedTurnClosers` 按空 callId
  //      合成修补结果时**再次**命中同一校验 —— 既写不进也修不好。
  // 线上实证：唯一命中的 provider 就是 codearts（31 个会话里 codearts 的
  // 3 个 tool-call 块 100% 是空 id，其余 provider 共 1.4 万个全为 0）。
  // 兄弟适配器（openai-compat / buddy / lobsterai / trae）都有 `toolIds` 兜底，
  // 只有本文件漏了 —— 这就是该缺陷只在 codearts 复现的原因。
  it('synthesizes a stable non-empty call id when the backend omits tool_call id', async () => {
    // ⚠️ 三个分片**都没有** `id` 字段（真实形态），且是跨分片续传的同一调用。
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"pwsh","arguments":"{\\"command\\":"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"\\"ls\\"}"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const deltaIds: unknown[] = []
    let toolCallBlock: { type: 'tool-call'; id: string; name: string; arguments: string } | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'tool-call-delta') deltaIds.push(chunk.id)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCallBlock = chunk.block
    }
    // 核心判据：id 必须非空。空串会被格式 v4 校验直接拒绝。
    expect(toolCallBlock?.id).toBeTruthy()
    expect(typeof toolCallBlock?.id).toBe('string')
    expect(toolCallBlock!.id.length).toBeGreaterThan(0)
    // 同一次响应内必须**稳定**：所有分片同一个 id，且与 block-end 一致
    // （否则 tool/result 无法与 tool/call 配对）。
    expect(new Set(deltaIds).size).toBe(1)
    expect(deltaIds[0]).toBe(toolCallBlock!.id)
    // 工具名与参数不受影响。
    expect(toolCallBlock).toMatchObject({ type: 'tool-call', name: 'pwsh' })
    expect(JSON.parse(toolCallBlock!.arguments)).toEqual({ command: 'ls' })
  })

  // 反向用例：id 只出现在**首个**分片、且后续分片带空串 id 时，
  // 不能被空串覆盖（与 `function.name` 同因）。空串会通过 `!== undefined`
  // 判断，故 `if (call.id !== undefined)` 那种写法会在这里失败。
  it('keeps the real call id when a later fragment carries an empty id', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-real","function":{"name":"pwsh","arguments":"{}"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"","arguments":""}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const deltaIds: unknown[] = []
    let toolCallBlock: { id: string } | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'tool-call-delta') deltaIds.push(chunk.id)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCallBlock = chunk.block
    }
    // 真实 id 必须被保留，不能被后续空串抹掉。
    expect(toolCallBlock?.id).toBe('call-real')
    expect(deltaIds.every(id => id === 'call-real')).toBe(true)
  })

  it('serializes harness tool schemas into the request tools field', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string
        tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
        tool_stream?: boolean
      }
      expect(sent.model).toBe('GLM-5.2')
      // 对齐 CodeArts Agent IDE：tool_stream=true 让后端对超大工具
      // 调用参数（如大文件 file_write）分段流式传输，避免单次 SSE 事件
      // 过大导致连接被掐断（error decoding response body）。
      expect(sent.tool_stream).toBe(true)
      expect(sent.tools).toEqual([{
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      }])
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [],
      tools: [{
        name: 'bash',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('hides vision-only (VL) models from listModels so they cannot be used as the agent model', async () => {
    // VL 多模态模型（如 Qwen3-VL-235B）上下文小、不支持工具调用，不适合当
    // agent 主模型，从模型列表屏蔽。它们只通过 analyzeImage 工具间接调用。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        { id: 'GLM-5.2', name: 'GLM-5.2' },
        { id: 'Qwen3-VL-235B', name: 'Qwen3-VL-235B' },
        { id: 'Qwen3.6-27B-VL', name: 'Qwen3.6-27B-VL' },
        { id: 'Qwen3.5-397B-A17B-VL', name: 'Qwen3.5-397B-A17B-VL' },
      ],
    })
    const models = await adapter.listModels('codearts')
    const ids = models.map((m) => m.id)
    expect(ids).not.toContain('Qwen3-VL-235B')
    expect(ids).not.toContain('Qwen3.6-27B-VL')
    expect(ids).not.toContain('Qwen3.5-397B-A17B-VL')
    // 普通模型不受影响。
    expect(ids).toContain('GLM-5.2')
  })

  /**
   * 模型黑名单：Jet Hub 的「显示列表」开关关闭某模型后，它必须从
   * listModels 的播报里消失 —— 对话框模型选择器读的正是这份数据。
   */
  it('hides models the user disabled from listModels', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        { id: 'GLM-5.2', name: 'GLM-5.2' },
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
        { id: 'openpangu-2.0-pro', name: 'openpangu-2.0-pro' },
      ],
      accountPool: poolWithDisabled('codearts', ['GLM-5.2']),
    })
    const ids = (await adapter.listModels('codearts')).map((m) => m.id)
    expect(ids).not.toContain('GLM-5.2')
    // 未关闭的模型保持原样与原有顺序
    expect(ids).toEqual(['deepseek-v4-flash', 'openpangu-2.0-pro'])
  })

  it('an empty disabled set leaves listModels untouched', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('codearts', []) })
    const ids = (await adapter.listModels('codearts')).map((m) => m.id)
    expect(ids).toContain('GLM-5.2')
    expect(ids).toContain('deepseek-v4-flash')
  })

  it('blacklist is keyed by provider: another route\'s entries do not leak in', async () => {
    // 池里只有 buddy 的黑名单，codearts 路由不该被它影响
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy', ['GLM-5.2']) })
    expect((await adapter.listModels('codearts')).map((m) => m.id)).toContain('GLM-5.2')
  })

  it('a disabled model still resolves and remains requestable (catalog is advisory)', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('codearts', ['GLM-5.2']) })
    expect((await adapter.listModels('codearts')).map((m) => m.id)).not.toContain('GLM-5.2')
    // DSH 契约：listModels 的结果仅供参考，缺省不构成请求拒绝。
    const resolved = await adapter.resolveModel('codearts', 'GLM-5.2')
    expect(resolved.id).toBe('GLM-5.2')
    // 2026-10-29 双源取证：GLM-5.2 = 202_752（漂移史见 CONTEXT_WINDOWS）。
    expect(resolved.context?.contextWindow).toBe(202_752)
  })

  // ── 目录门控：没有已登录账号就不显示该 provider 的模型 ──
  //
  // ⚠️ **CodeArts 不再有「单凭据模式」例外**：登录入口只有 Jet Hub 设置页，
  // 凭据一律写账号池条目（`CODEARTS_ACCOUNT_XXX`）。固定的
  // `CODEARTS_ACCESS_TOKEN` 不会再被写入或读取，判据与其余五个 provider 一致。
  describe('无已登录账号时隐藏整个 provider 目录', () => {
    it('没有已登录账号 → 返回空数组', async () => {
      const adapter = makeAdapter({ accountPool: poolWithCredentials([]) })
      expect(await adapter.listModels('codearts')).toEqual([])
    })

    it('⚠️ 单凭据 ref 有值但账号池为空 → 仍隐藏（单凭据模式已移除）', async () => {
      // 这是本次变更的核心断言：老用户若只用固定 ref 登录过，模型会消失、
      // 需要在 Jet Hub 重新登录一次（用户已确认接受该行为）。
      const adapter = makeAdapter({ accountPool: poolWithCredentials([]) })
      expect(await adapter.listModels('codearts')).toEqual([])
    })

    it('账号池里有已登录账号 → 正常返回目录', async () => {
      const adapter = makeAdapter({ accountPool: poolWithCredentials(['CODEARTS_ACCOUNT_1']) })
      expect((await adapter.listModels('codearts')).map((m) => m.id)).toContain('GLM-5.2')
    })

    it('未提供 accountPool 时保守放行（headless / CLI 场景）', async () => {
      expect((await makeAdapter().listModels('codearts')).length).toBeGreaterThan(0)
    })
  })

  it('switches deepseek-v4 to DSML tool mode: no tools field, schema injected into system', async () => {
    // deepseek-v4 大文件写入修复（实测 2026-08-22）：标准 tool_calls 参数
    // 一次性打包生成，SSE 静默 >60s 被 APIG 网关掐断且后端不发心跳；
    // 当工具列表含大参数写文件类工具（write）时改为不发送 tools 字段、
    // 把 function schema 注入 system 提示，让模型以原生 DSML 流式输出
    // 工具调用（delta.content 走流式通道，全程有数据）。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string
        tools?: unknown[]
        messages?: Array<Record<string, unknown>>
      }
      expect(sent.model).toBe('deepseek-v4-flash')
      // deepseek-v4 的 DSML 工具模式下不得发送 tools 字段（发送会触发
      // 标准 tool_calls 一次性打包路径）。
      expect(sent.tools).toBeUndefined()
      const wire = sent.messages ?? []
      const system = wire.find(message => message.role === 'system') as Record<string, unknown> | undefined
      // DSML 指令 + 工具 schema 注入 system 消息。
      expect(system?.content).toContain('DSML')
      expect(system?.content).toContain('工具名')
      expect(String(system?.content)).toContain('write')
      expect(String(system?.content)).toContain('Write content to a file')
      // harness 原始 user 消息保留在 system 之后。
      expect(wire.some(message => message.role === 'user')).toBe(true)
      // 模型以 DSML 格式输出工具调用，适配器解析为结构化 tool-call。
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="write">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="content" string="true">export const x = 1;</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'write a file' }],
      tools: [{
        name: 'write',
        description: 'Write content to a file at the given path.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute file path' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['filePath', 'content'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('write')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts', content: 'export const x = 1;' })
    expect(finishKind).toBe('tool-calls')
  })

  it('mints a unique callId for DSML tool calls so harness pairing and web UI work', async () => {
    // DSML 语法没有 provider 签发的 call id。空 id 会让同一响应的多个
    // 工具调用（tool/call ↔ tool/result 配对、web UI 工具行 key）冲突，
    // UI 只能回退为泛化的 "Tool call" 而丢失 read/write 专属控件。
    // 适配器必须为每个 DSML 调用生成非空且互不相同的 callId。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls>'
        + '<｜DSML｜invoke name="read"><｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter></｜DSML｜invoke>'
        + '<｜DSML｜invoke name="write"><｜DSML｜parameter name="filePath" string="true">/tmp/b.ts</｜DSML｜parameter><｜DSML｜parameter name="content" string="true">x</｜DSML｜parameter></｜DSML｜invoke>'
        + '</｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const deltas: Array<{ id: string; name?: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'do both' }],
      tools: [
        { name: 'read', description: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } },
        { name: 'write', description: 'Write', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } } } },
      ],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'tool-call-delta') {
        deltas.push({ id: String(chunk.id), ...chunk.name !== undefined ? { name: chunk.name } : {} })
      }
    }
    expect(deltas).toHaveLength(2)
    // 两个 DSML 调用的 callId 非空且互不相同。
    expect(deltas[0].id).not.toBe('')
    expect(deltas[1].id).not.toBe('')
    expect(deltas[0].id).not.toBe(deltas[1].id)
    expect(deltas.map(d => d.name)).toEqual(['read', 'write'])
  })

  it('parses DSML tool calls embedded in reasoning_content (deepseek-v4 quirk)', async () => {
    // 实测 2026-08-22：deepseek-v4-flash 有时把完整回答（含 DSML 块）输出在
    // reasoning_content 而 content 为空。旧实现把 reasoning_content 直接追加
    // 到 reasoning 块、从不走 DSML 提取器，导致 DSML 块被当推理文本吞掉
    // （任务 completed 但工具未执行，text 与 reasoning 内容重复）。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="write">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="content" string="true">export const x = 1;</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      // 模型把正文+DSML 全放在 reasoning_content。
      const reasoning = '用户要求写入文件，我需要调用 write 工具。\n' + dsml
      return new Response(
        `data: {"choices":[{"delta":{"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\n`
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const textDeltas: string[] = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'write a file' }],
      tools: [{
        name: 'write',
        description: 'Write content to a file at the given path.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute file path' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['filePath', 'content'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('write')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts', content: 'export const x = 1;' })
    expect(finishKind).toBe('tool-calls')
    // reasoning_content 中的 DSML 已解析为工具调用，不再泄漏到正文。
    expect(textDeltas.join('')).not.toContain('DSML')
    expect(textDeltas.join('')).not.toContain('<｜DSML｜')
  })

  it('routes reasoning_content thinking into the reasoning block, never the text body', async () => {
    // 实测 2026-08-22：deepseek-v4-flash 的 reasoning_content 通常没有
    // <thought> 标签（如 "The user wants me to:..."）。旧实现把提取器返回
    // 的 `text`（开标签前思考）发给正文块，导致思考泄漏到 TUI 正文
    // （The user wants me to... 跑到正文、没有 Think）。修复后
    // reasoning_content 的 text+reasoning 必须全部进入 reasoning 块。
    const fetchImpl = vi.fn(async () => {
      // 模型把思考（无 <thought> 标签）+ DSML 工具调用全放 reasoning_content。
      const reasoning = 'The user wants me to read the file and write it.\nLet me do that step by step.'
        + '<｜DSML｜tool_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\n`
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read and write a file' }],
      tools: [
        { name: 'read', description: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } },
        { name: 'write', description: 'Write', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } } } },
      ],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name })
      }
    }
    // 思考进入 Think 区域。
    const reasoningText = reasoningDeltas.join('')
    expect(reasoningText).toContain('The user wants me to read the file')
    expect(reasoningText).toContain('Let me do that step by step.')
    // 正文不泄漏思考。
    expect(textDeltas.join('')).not.toContain('The user wants me')
    // DSML 工具调用正常解析。
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('read')
  })

  it('parses DSML in reasoning_content even when content channel has an unclosed <thought> (independent extractors)', async () => {
    // 回归 session-067dcf78 turn1 step13 / turn2 step3：deepseek-v4 在
    // content 通道输出 <thought> 开标签（提取器进入 in-thought 状态）后，
    // 把推理与完整 DSML 工具调用写到 reasoning_content 通道。旧实现共用
    // 单个 DSML 提取器，content 的 <thought> 污染提取器状态为 in-thought，
    // reasoning_content 的 DSML 块被当作 thought 内容吞掉、不解析为
    // tool-call，残留 DSML 标签经 visible 回退泄漏到正文 text 块
    // （reasoning 与 text 内容完全相同、均含 <｜DSML｜...>，任务中断）。
    // 修复后 content 与 reasoning_content 使用独立提取器，互不污染。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls>'
        + '<｜DSML｜invoke name="read"><｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter></｜DSML｜invoke>'
        + '</｜DSML｜tool_calls>'
      // content 通道：<thought> 开标签 + 思考片段，无闭标签（提取器进入 in-thought）。
      const content = '<thought>用户要求读取文件，我需要调用 read 工具。'
      // reasoning_content 通道：推理 + 完整 DSML 块。
      const reasoning = '让我先读取文件内容。\n' + dsml
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(content)},"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\n`
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const textDeltas: string[] = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read a file' }],
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // reasoning_content 的 DSML 块被独立提取器解析为 tool-call。
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('read')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts' })
    expect(finishKind).toBe('tool-calls')
    // DSML 标签不泄漏到正文。
    expect(textDeltas.join('')).not.toContain('DSML')
    expect(textDeltas.join('')).not.toContain('<｜DSML｜')
  })

  it('does not leak DSML tags from reasoning to text via visible fallback (reasoning references DSML syntax)', async () => {
    // 回归 session-a69fa289 turn2 step26：deepseek-v4 在推理中引用 DSML 语法
    // （仅含闭合标签片段，非完整工具调用块），提取器正确不解析（无开标签），
    // 整段作为 reasoning。但 visible 回退把含 DSML 标签的推理复制到正文，
    // 导致 DSML 标签泄漏到正文、任务终止。修复后 visible 回退检查推理是否
    // 含 DSML 标签，含则不复制为正文（推理仍在 Think 区域可见）。
    const fetchImpl = vi.fn(async () => {
      const reasoning = 'Let me read protocol/mod.rs to see the current SseTimeoutConfig.\n'
        + '</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'continue' }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // 推理在 Think 区域可见。
    expect(reasoningDeltas.join('')).toContain('SseTimeoutConfig')
    // DSML 标签不泄漏到正文（visible 回退不复制含 DSML 标签的推理）。
    expect(textDeltas.join('')).toBe('')
    expect(finishKind).toBe('stop')
  })

  it('coerces numeric-looking DSML string params (offset="1304") to number', async () => {
    // 实测 2026-08-22：deepseek-v4 对 read 的 offset 误标 string="true"，
    // 输出 offset="1304"。旧实现保持字符串，工具 schema 校验报
    // `"offset" must be a number`。修复后数字字面量字符串按原始类型解析。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/big.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="offset" string="true">1304</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="limit" string="true">2000</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read big file' }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { filePath: string; offset: number; limit: number }
    expect(args.filePath).toBe('/tmp/big.ts')
    // 数字字符串参数被转换为 number。
    expect(args.offset).toBe(1304)
    expect(typeof args.offset).toBe('number')
    expect(args.limit).toBe(2000)
    expect(typeof args.limit).toBe('number')
  })

  it('coerces quoted numeric DSML string params (offset string="true" value "840", pro quirk) to number', async () => {
    // 实测 deepseek-v4-pro：pro 模型常把数字参数值用 JSON 字符串引号包裹
    // 输出（如 "840"），即便标记了 string="true"。旧实现 tryParseScalar
    // 不处理带引号的字面量——"840"（含引号字符）不匹配数字正则、保持
    // 字符串，schema 校验报 "offset" must be a number。flash 输出纯数字
    // 不带引号故不受影响，这是 pro 出错多、flash 不出错的根因。修复后
    // tryParseScalar 先 JSON.parse 解码外层引号再递归标量转换。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/big.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="offset" string="true">"840"</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="limit" string="true">"40"</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'read big file' }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { filePath: string; offset: number; limit: number }
    expect(args.filePath).toBe('/tmp/big.ts')
    expect(args.offset).toBe(840)
    expect(typeof args.offset).toBe('number')
    expect(args.limit).toBe(40)
    expect(typeof args.limit).toBe('number')
  })

  it('coerces quoted numeric DSML params without string attr (pro quirk) to number', async () => {
    // deepseek-v4-pro 另一种形态：数字参数不加 string="true"，但值仍用
    // JSON 字符串引号包裹（"840"）。走非 string 路径 JSON.parse('"840"')
    // 得到字符串 "840"，旧实现直接使用导致 schema 校验失败。修复后非
    // string 路径对 JSON.parse 得到的字符串结果再走 tryParseScalar 还原。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/big.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="offset">"840"</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="limit">"40"</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'read big file' }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { filePath: string; offset: number; limit: number }
    expect(args.offset).toBe(840)
    expect(typeof args.offset).toBe('number')
    expect(args.limit).toBe(40)
    expect(typeof args.limit).toBe('number')
  })

  it('coerces array-looking DSML string params (todos string="true") to array', async () => {
    // 实测 session-59e52486 turn1 step3：deepseek-v4 对 todo_write 的 todos
    // 数组参数误标 string="true"，把 JSON 编码的数组当作字符串输出。旧实现
    // tryParseScalar 只解析 number/boolean/null 标量，不解析 JSON 数组，
    // todos 保持字符串，工具 schema 校验报 `"todos" must be an array`。
    // 修复后 tryParseScalar 对 [ / { 开头的合法 JSON 还原为原始类型。
    const todosJson = JSON.stringify([
      { content: '了解项目结构', status: 'in_progress' },
    ])
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="todo_write">'
      + `<｜DSML｜parameter name="todos" string="true">${todosJson}</｜DSML｜parameter>`
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'plan the work' }],
      tools: [{
        name: 'todo_write',
        description: 'Write a todo list',
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
              },
            },
          },
          required: ['todos'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { todos: unknown }
    // todos 被还原为数组，而非保持字符串。
    expect(Array.isArray(args.todos)).toBe(true)
    expect(args.todos).toEqual([
      { content: '了解项目结构', status: 'in_progress' },
    ])
  })

  it('forwards GenerateOptions.system as a system message (session title fix)', async () => {
    // 标题生成等辅助请求通过 GenerateOptions.system 传入系统提示。旧实现
    // 丢弃了 options.system，模型只看到 user prompt 本身，于是把
    // "Generate the session title from this JSON array..." 回显成标题
    // （实测 2026-08-22：session 标题显示为 prompt 文本）。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>
      }
      const systems = (sent.messages ?? []).filter(m => m.role === 'system')
      expect(systems).toHaveLength(1)
      expect(systems[0].content).toContain('Create a concise title')
      return new Response(
        'data: {"choices":[{"delta":{"content":"Fix DSML parsing"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[...]' }],
      system: 'Create a concise title for an AI coding-assistant session from the supplied human messages.\nReturn only the title on one line.',
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts.join('')).toBe('Fix DSML parsing')
  })

  it('switches deepseek-v4 to DSML tool mode even with small-parameter-only tools (read/bash)', async () => {
    // deepseek-v4 模型始终走 DSML 模式（不论工具列表）：标准 tool_calls 模式下
    // `subagent` 工具的长 prompt 参数生成期间 SSE 无数据，APIG 网关 ~60s 空闲超时
    // 必然掐断连接。DSML 模式让工具调用通过 delta.content 流式输出，全程有数据流。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string
        tools?: unknown[]
        messages?: Array<Record<string, unknown>>
      }
      expect(sent.model).toBe('deepseek-v4-flash')
      // DSML 模式：不发送 tools 字段（对齐 IDE 请求体），schema 注入 system 消息。
      expect(sent.tools).toBeUndefined()
      const wire = sent.messages ?? []
      expect(wire.some(message => message.role === 'system' && typeof message.content === 'string'
        && message.content.includes('<｜DSML｜tool_calls>'))).toBe(true)
      // 模型以 DSML 格式输出，适配器从 delta.content 解析。
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read a file' }],
      tools: [{
        name: 'read',
        description: 'Read a file at the given path.',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string', description: 'Absolute file path' } },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('read')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts' })
  })

  it('replays assistant tool_calls and tool results back to the model', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      // 助手消息携带其 tool_calls；随后用户消息的
      // tool-result 块展开为 role:'tool' 传输消息。
      const assistant = wire.find(message => message.role === 'assistant') as Record<string, unknown> | undefined
      expect(assistant?.tool_calls).toEqual([{
        id: 'call-9',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls"}' },
      }])
      const tool = wire.find(message => message.role === 'tool') as Record<string, unknown> | undefined
      expect(tool?.tool_call_id).toBe('call-9')
      expect(tool?.content).toContain('src/')
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call-9', name: 'bash', arguments: '{"command":"ls"}' },
        ] },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call-9', content: [{ type: 'text', text: 'src/ lib/' }] },
        ] },
      ],
      tools: [{ name: 'bash', description: 'Run a shell command', parameters: {} }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  // 回归（严重）：工具执行失败时 assistant 的 tool_calls 留在会话历史里，
  // 但结果消息从未写回——形成孤儿 tool_calls。坏历史随每次请求重放，后端
  // 对之后**每一条**用户消息都返回 400，表现为"任务中断后发送任何内容都
  // 没有回复"。适配器必须在发出请求前剔除。
  it('drops orphan tool_calls that never received a tool result', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      const assistant = wire.find(message => message.role === 'assistant') as Record<string, unknown> | undefined
      expect(assistant?.tool_calls).toBeUndefined()
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call-9', name: 'bash', arguments: '{"command":"ls"}' },
        ] },
        // 工具执行失败，没有对应的 tool-result 写回历史。
        { role: 'user', content: 'continue' },
      ],
      tools: [{ name: 'bash', description: 'Run a shell command', parameters: {} }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('drops orphan tool result messages with no matching tool_call', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      expect(wire.some(message => message.role === 'tool')).toBe(false)
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'x' }] },
        ] },
      ],
      tools: [{ name: 'bash', description: 'Run a shell command', parameters: {} }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('replays assistant reasoning blocks as reasoning_content for the model', async () => {
    // deepseek-v4 等推理模型后端校验：回传历史时 assistant 消息必须携带
    // reasoning_content 字段，缺失会 400 "Missing `reasoning_content` field"。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      const first = wire.find(message => message.role === 'assistant') as Record<string, unknown> | undefined
      expect(first?.content).toBe('visible-answer')
      expect(first?.reasoning_content).toBe('hidden-thought')
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: 'summarize' },
        { role: 'assistant', content: [
          { type: 'reasoning', text: 'hidden-thought' },
          { type: 'text', text: 'visible-answer' },
        ] },
      ],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('classifies an SSE transport "terminated" error as retryable TRANSPORT, not UNKNOWN', async () => {
    // CodeArts 网关在 SSE 空闲 ~60s 后掐断连接，Node undici reader.read() 抛
    // TypeError: terminated。该错误非 HarnessError，会被归为 UNKNOWN（不可重试）
    // 导致 harness 直接失败。适配器须把它映射为可重试的 TRANSPORT。
    let pullCalls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 第一次 pull：发送一个 chunk；第二次 pull（数据已被消费后）让流
        // error 模拟对端掐断。用计数器确保先消费再 error。
        pullCalls++
        if (pullCalls === 1) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
        } else {
          controller.error(new TypeError('terminated'))
        }
      },
    })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const adapter = makeAdapter({ fetchImpl })
    const chunks: string[] = []
    let caught: LlmError | undefined
    try {
      for await (const chunk of adapter.stream(streamOptions)) {
        if (chunk.type === 'text-delta') chunks.push(chunk.text)
      }
    } catch (error) {
      if (error instanceof LlmError) caught = error
    }
    expect(chunks).toEqual(['hi'])
    expect(caught?.code).toBe('TRANSPORT')
  })

  it('reports a retryable TIMEOUT when the SSE stream goes idle beyond the chunk threshold', async () => {
    // 模型生成长推理时两次 chunk 间静默超过 chunk 超时窗口：适配器应主动以
    // 可重试 TIMEOUT 失败（而非被动等网关掐断后变成 UNKNOWN）。
    // 用短超时环境变量避免真实等待 600s。
    const prev = process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS
    process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS = '200'
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
          // 永不发送更多数据——触发空闲超时
        },
      })
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      const adapter = makeAdapter({ fetchImpl })
      const chunks: string[] = []
      let caught: LlmError | undefined
      try {
        for await (const chunk of adapter.stream(streamOptions)) {
          if (chunk.type === 'text-delta') chunks.push(chunk.text)
        }
      } catch (error) {
        if (error instanceof LlmError) caught = error
      }
      expect(chunks).toEqual(['hi'])
      expect(caught?.code).toBe('TIMEOUT')
      expect(caught?.message).toContain('chunk timeout')
    } finally {
      if (prev === undefined) delete process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS
      else process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS = prev
    }
  }, 10_000)

  it('reports a retryable TIMEOUT when no first token arrives in time', async () => {
    // 首 token 超时：连接建立后模型长时间不输出任何数据（如排队中、
    // 模型冷启动）。适配器应以可重试 TIMEOUT 失败，phase=first-token。
    const prev = process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS
    process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS = '200'
    try {
      const body = new ReadableStream<Uint8Array>({
        start() {
          // 永不 enqueue 任何数据——触发首 token 超时
        },
      })
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      const adapter = makeAdapter({ fetchImpl })
      let caught: LlmError | undefined
      try {
        for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
      } catch (error) {
        if (error instanceof LlmError) caught = error
      }
      expect(caught?.code).toBe('TIMEOUT')
      expect(caught?.message).toContain('first-token timeout')
    } finally {
      if (prev === undefined) delete process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS
      else process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS = prev
    }
  }, 10_000)

  it('extracts DSML tool_calls embedded in delta.content into structured tool-call blocks', async () => {
    // 某些模型（如 deepseek-v4）在工具模式不匹配时会把工具调用以原生
    // DSML XML 风格直接写入 delta.content，适配器须识别并解析为结构化
    // tool-call，避免原始 <｜DSML｜...> token 泄漏到 web UI。
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>'
      + '<｜DSML｜parameter name="description" string="true">list files</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // DSML 内容不应作为文本泄漏
    expect(textDeltas.join('')).toBe('')
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('bash')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ command: 'ls', description: 'list files' })
    expect(finishKind).toBe('tool-calls')
  })

  it('extracts DSML tool_calls streamed across multiple chunks', async () => {
    // DSML 块可能跨多个 SSE chunk 分片到达，提取器须缓冲未完成部分
    // 直到闭标签到达才解析，期间不产出任何文本。
    const parts = [
      '<｜DSML｜tool_calls><｜DSML｜invoke name="pwsh">',
      '<｜DSML｜parameter name="command" string="true">ls "D:\\jet"',
      '</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
    ]
    const sse = parts.map(p => `data: {"choices":[{"delta":{"content":${JSON.stringify(p)}}}]}\n\n`).join('')
      + 'data: [DONE]\n\n'
    const fetchImpl = vi.fn(async () => new Response(
      sse,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(textDeltas.join('')).toBe('')
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('pwsh')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ command: 'ls "D:\\jet"' })
  })

  it('passes through plain text alongside DSML tool_calls', async () => {
    // 模型可能在同一段输出中先写普通文本再写 DSML 工具调用，
    // 提取器须放行文本部分并解析 DSML 部分。
    const text = '查看providers目录\n'
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(text + dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(textDeltas.join('')).toBe(text)
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('bash')
  })

  it('flushes incomplete DSML as text when the stream ends without a closing tag', async () => {
    // 若模型输出被 max_tokens 截断，DSML 块可能不完整（无闭标签）。
    // 提取器 flush() 须把残留作为纯文本放行，避免吞掉内容；同时
    // finish_reason='length' 路径触发 harness max-tokens 续写。
    const incomplete = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(incomplete)}},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // 不完整 DSML 作为文本放行（用户可见），finish 报 max-tokens 触发续写
    expect(textDeltas.join('')).toBe(incomplete)
    expect(finishKind).toBe('max-tokens')
  })

  it('extracts <thought> blocks as reasoning instead of leaking to visible text', async () => {
    // DeepSeek-V4 Thinking 模式：模型把推理过程包裹在 <thought>...</thought>
    // 中写入 delta.content。适配器须把 <thought> 内容作为 reasoning-delta
    // 输出（显示在 Think 区域），而非作为 text-delta 泄漏到正文。
    const thought = '<thought>我需要先查看目录结构，再决定如何操作。</thought>'
    const visible = '查看完成，开始操作。'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(thought + visible)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
    }
    // <thought> 内容作为 reasoning 输出，不泄漏到正文
    expect(textDeltas.join('')).toBe(visible)
    expect(reasoningDeltas.join('')).toBe('我需要先查看目录结构，再决定如何操作。')
  })

  it('streams <thought> reasoning incrementally across multiple chunks', async () => {
    // <thought> 块跨多个 SSE chunk 分片到达，提取器须流式输出 reasoning
    // 增量（与 delta.reasoning_content 行为一致），不等到块结束才输出。
    const parts = [
      '<thought>第一步：分析需求',
      '。第二步：制定计划。',
      '</thought>开始执行。',
    ]
    const sse = parts.map(p => `data: {"choices":[{"delta":{"content":${JSON.stringify(p)}}}]}\n\n`).join('')
      + 'data: [DONE]\n\n'
    const fetchImpl = vi.fn(async () => new Response(
      sse,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
    }
    expect(textDeltas.join('')).toBe('开始执行。')
    expect(reasoningDeltas.join('')).toBe('第一步：分析需求。第二步：制定计划。')
  })

  it('handles <thought> followed by DSML tool_calls in the same content stream', async () => {
    // Thinking 模式 + 工具调用：模型先输出 <thought> 推理，再输出
    // DSML tool_calls。适配器须分别路由到 reasoning 和 tool-call 块。
    const thought = '<thought>需要列出目录内容。</thought>'
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(thought + dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(textDeltas.join('')).toBe('')
    expect(reasoningDeltas.join('')).toBe('需要列出目录内容。')
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('bash')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ command: 'ls' })
    expect(finishKind).toBe('tool-calls')
  })

  it('flushes incomplete <thought> as reasoning when the stream ends without closing tag', async () => {
    // 不完整的 <thought> 块（被 max_tokens 截断）：flush() 须把残留
    // 作为 reasoning 放行，避免推理泄漏到正文。
    const incompleteThought = '<thought>我正在思考'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(incompleteThought)}},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
    }
    // 不完整 thought 作为 reasoning 放行，不泄漏到正文
    expect(textDeltas.join('')).toBe('')
    expect(reasoningDeltas.join('')).toBe('我正在思考')
  })

  /**
   * 额度用尽（`InferHub.4291.200`）必须与「排队/限流」**彻底分开**。
   *
   * ## 真实缺陷（用户报障 2026-10-02）
   *
   * 用户报「插件 dsh-codearts-auth 里的 CodeArts Agent 没反应了」—— 实际是
   * 该账号唯一启用的模型 `deepseek-v4.1-flash`（benefit / 免费额度通道）额度
   * 用尽，后端以 **HTTP 200 + SSE** 下发：
   * ```
   * data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota",…}
   * ```
   * 而 `isSseQueueErrorCode` 的判据 `/…|429|…/` 是**无边界子串**匹配，
   * `4291` 命中了 `429` 前缀 → 被当成「可重试的排队」→ 进入每 10 秒重试、
   * 上限 180 次（30 分钟）的循环。
   *
   * ⚠️ 后果是**界面完全无输出**（不是报错）：排队期间适配器刻意不产出任何
   * 内容块，而它误以为自己在排队。实测真实适配器 25 秒内发 4 次 chat 请求 +
   * 3 次排队探测、**产出 0 个 chunk**，最终由用户手动中止 —— 会话记录里是
   * `turn/end aborted` + `stream: []`，**没有任何 error 事件**。
   */
  describe('额度用尽（InferHub.4291.200）与排队分流', () => {
    it('把 InferHub.4291.200 判为额度用尽，而 81111.429 仍判为可重试排队', () => {
      // ① 额度码：命中额度判据、**不再**被裸 `429` 子串吃掉。
      expect(isSseQuotaExhaustedErrorCode('InferHub.4291.200', 'insufficient quota')).toBe(true)
      // ② 排队码：仍走排队（回归保护 —— 修 429 边界不能把真排队一起修坏）。
      expect(isSseQuotaExhaustedErrorCode('InferHub.ModelArts.81111.429', 'TPM limit')).toBe(false)
      // ③ 文案兜底：码值换了也能认出来。
      expect(isSseQuotaExhaustedErrorCode('InferHub.9999.200', 'insufficient quota')).toBe(true)
      // ④ 尾号变体：服务端若改尾号，`4291` 子串仍命中。
      expect(isSseQuotaExhaustedErrorCode('InferHub.4291.999', 'whatever')).toBe(true)
    })

    it('429 的边界判据：4291 不再命中，而 81111.429 / 「429 Too Many Requests」仍命中', () => {
      // ⚠️ 本用例直接测**生产函数**，不复制正则字面量 —— 复制的话就是同义反复，
      // 把边界改回裸子串也不会变红（第一版真的这么错过，反向验证时发现了）。
      //
      // 额度码：修复前这里返回 `true`（被裸 `429` 子串吃掉），是缺陷的直接根因。
      expect(isSseQueueErrorCode('InferHub.4291.200')).toBe(false)
      // 真排队码不受影响（修边界不能把排队一起修坏）：
      expect(isSseQueueErrorCode('InferHub.ModelArts.81111.429')).toBe(true)
      expect(isSseQueueErrorCode('TM.00001041')).toBe(true)
      expect(isSseQueueErrorCode('HTTP 429 Too Many Requests')).toBe(true)
      // 429 出现在中间也要认（前后都是非数字）。
      expect(isSseQueueErrorCode('err 429 rate limited')).toBe(true)
      // 但含 429 的更长数字串不认。
      expect(isSseQueueErrorCode('InferHub.14290')).toBe(false)
    })

    it('额度用尽时立即失败（不静默重试），并在报错里给出解禁时间', async () => {
      // 账号池替身：只有一个账号，且它就是失败的那个 → 无号可换，应如实抛出。
      const marked: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
      const pool = {
        findAccountIdByCredential: async () => 'acct-1',
        getAvailableAccount: async () => null,
        updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
          marked.push({ accountId, modelId, resetAtMs })
        },
      }
      let chatCalls = 0
      const fetchImpl = vi.fn(async () => {
        chatCalls += 1
        return new Response(
          'data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      })

      const adapter = makeAdapter({ fetchImpl, accountPool: pool })
      const chunks: unknown[] = []
      let thrown: unknown
      try {
        for await (const chunk of adapter.stream(streamOptions)) chunks.push(chunk)
      } catch (error) {
        thrown = error
      }

      // ① 立刻失败，且归为**不可重试**的额度错误（不在 harness 的可重试集合里）。
      //
      // ⚠️ 码必须是字面量 `'QUOTA_EXCEEDED'`，**不能**是 harness 常量
      // `QUOTA_EXCEEDED_CODE`（它的字面值是 `'QUOTA'`）—— 客户端对
      // `"QUOTA"` 会把 message 整条换成「当前请求的额度已用尽」，
      // 下面第 ② 条断言里那句解禁时间就永远到不了用户眼前（issue IKJVCW）。
      expect(thrown).toBeInstanceOf(LlmError)
      expect((thrown as LlmError).code).toBe('QUOTA_EXCEEDED')
      // ② 报错必须**带解禁时间**（用户明确要求：「其它渠道限额到了会提示多少时间
      //    后会解除限额，这个 codearts 的也加上吧」）。
      expect((thrown as LlmError).message).toMatch(/预计 .*后重置/)
      expect((thrown as LlmError).message).toMatch(/UTC\+8 自然日结算/)
      // ③ **不能**静默重试：修复前这里会是 4+ 次（每 10 秒一轮）。
      //    修复后只发 1 次就抛出。
      expect(chatCalls).toBe(1)
      // ④ 零内容块（不把额度错误伪装成"正在思考"）。
      expect(chunks).toEqual([])
      // ⑤ 失败账号 + 该模型被写入标记，且时限是 UTC+8 当日 24:00。
      expect(marked.map(entry => entry.accountId)).toEqual(['acct-1'])
      expect(marked[0]!.modelId).toBe((streamOptions as { model: string }).model)
      const delta = marked[0]!.resetAtMs - Date.now()
      expect(delta).toBeGreaterThan(0)
      expect(delta).toBeLessThanOrEqual(86_400_000)
    })

    it('额度用尽时切换到池中下一个账号重试', async () => {
      const marked: Array<{ accountId: string; modelId: string }> = []
      const pool = {
        findAccountIdByCredential: async () => 'acct-1',
        getAvailableAccount: async () => ({
          entry: { id: 'acct-2' },
          credential: {
            access_key_id: 'AK2', secret_access_key: 'SK2', security_token: 'ST2',
            expires_at: '2099-01-01T00:00:00Z',
          },
        }),
        updateModelRateLimit: async (accountId: string, modelId: string) => {
          marked.push({ accountId, modelId })
        },
      }
      const chatKeys: string[] = []
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const key = /Access=([^,\s]+)/.exec(new Headers(init?.headers).get('Authorization') ?? '')?.[1] ?? ''
        if (String(input).startsWith(CHAT_API_BASE)) chatKeys.push(key)
        if (key === 'AK2') {
          return new Response(
            'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return new Response(
          'data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      })

      const adapter = makeAdapter({ fetchImpl, accountPool: pool })
      const texts: string[] = []
      for await (const chunk of adapter.stream(streamOptions)) {
        if (chunk.type === 'text-delta') texts.push(chunk.text)
      }

      // 换到第二个账号后成功拿到内容。
      expect(chatKeys).toEqual(['AK', 'AK2'])
      expect(texts).toEqual(['recovered'])
      // 失败的那个账号被标记（不是被换上的那个）。
      expect(marked.map(entry => entry.accountId)).toEqual(['acct-1'])
    })

    it('额度用尽也可能走 HTTP 4xx：同样立即失败并带解禁时间', async () => {
      // 两条通道都接（`AGENTS.md` 的既有铁律）：实测该码走 SSE（HTTP 200），
      // 但服务端同样可能以 4xx 下发。若不接这条，哪天改了形态就会退回
      // 「重试可自愈」的错误分类。
      let chatCalls = 0
      const fetchImpl = vi.fn(async () => {
        chatCalls += 1
        // 4xx 形态：报文字段名与 SSE 不同，靠文案兜底命中。
        return new Response(
          JSON.stringify({ error_code: 'InferHub.4291.200', error_msg: 'insufficient quota' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      })
      const adapter = makeAdapter({ fetchImpl })
      let thrown: unknown
      try {
        for await (const _ of adapter.stream(streamOptions)) { /* 不应产出 */ }
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(LlmError)
      expect((thrown as LlmError).code).toBe('QUOTA_EXCEEDED')
      expect((thrown as LlmError).message).toMatch(/预计 .*后重置/)
      // 立即失败，**不**落入排队重试（修复前会被当限流/排队）。
      expect(chatCalls).toBe(1)
    })

    it('标记时限按 UTC+8 当日 24:00 取，而不是 parseRateLimitError 的「1 小时后」', () => {
      // ⚠️ 不能复用 `parseRateLimitError`：它解析不到时间时退回
      // `Date.now() + RATE_LIMIT_FALLBACK_MS`（1 小时），对**按自然日**结算的
      // 免费额度会让标记过早失效 —— 用户 1 小时后再撞一次同样的墙。
      // （与 qoder / zcode 的额度处理同一口径。）
      const now = Date.UTC(2026, 9, 2, 12, 0, 0) // 2026-10-02T12:00Z = 20:00 UTC+8
      const reset = nextUtc8DayStartMs(now)
      // 距 UTC+8 次日 00:00 还有 4 小时。
      expect(reset - now).toBe(4 * 3_600_000)
      // 明显长于 1 小时兜底（正是不能复用的原因）。
      expect(reset - now).toBeGreaterThan(RATE_LIMIT_FALLBACK_MS)
    })

    it('解禁时间文案按时长量级给出可读单位', () => {
      const now = Date.UTC(2026, 9, 2, 12, 0, 0)
      expect(formatResetIn(now + 30_000, now)).toBe('不到 1 分钟')
      expect(formatResetIn(now + 20 * 60_000, now)).toBe('20 分钟')
      expect(formatResetIn(now + 4 * 3_600_000, now)).toBe('4 小时')
      expect(formatResetIn(now + 90 * 60_000, now)).toBe('1.5 小时')
      expect(formatResetIn(now - 1, now)).toBe('即将重置')
    })

    it('完整文案含模型名、预计时长与 UTC 时刻', () => {
      const now = Date.UTC(2026, 9, 2, 12, 0, 0)
      const msg = codeartsQuotaExhaustedMessage('deepseek-v4.1-flash', nextUtc8DayStartMs(now), now)
      expect(msg).toContain('deepseek-v4.1-flash')
      expect(msg).toContain('免费额度')
      expect(msg).toContain('4 小时后重置')
      expect(msg).toContain('2026-10-02T16:00:00.000Z') // UTC+8 次日 00:00
      expect(msg).toContain('Jet Hub')
    })
  })

  /**
   * ★★ **额度耗尽的错误码不得被 DSH 客户端替换掉文案**（Gitee issue IKJVCW）。
   *
   * ## 真实缺陷
   *
   * harness 导出的 `QUOTA_EXCEEDED_CODE` 字面值是 **`'QUOTA'`**，而 DSH 客户端
   * 的 `failureMessage()`（实测 `dsh-client-ui-chat/lib/client.js`，桌面端
   * `app.asar` 内为逐字节同串）对 **5 个码**做文案替换：
   * ```js
   * if (code === "ACCOUNT_SIGNED_OUT") return t("message.failure.accountSignedOut");
   * if (code === "ACCOUNT_SIGN_IN_REQUIRED") return t("message.failure.accountSignInRequired");
   * if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
   * return code === "AUTH" ? t("message.failure.auth") : message;
   * ```
   * locale：`"message.failure.quota": "当前请求的额度已用尽"`。
   * ⚠️ **本仓库的 `src/sse.ts` 早就登记了同一份 5 码清单**（`REASONING_LOOP_CODE`
   * 的注释里），改这里时别写成「三个码」—— 两套同义数字必有一处是错的。
   *
   * 于是 {@link codeartsQuotaExhaustedMessage} 里那句**带解禁时间**的说明
   * 一个字都到不了用户眼前，用户看不到「预计 X 小时后重置」「可改用其它模型」，
   * 只看到一句暗示「该充值了」的通用文案。
   *
   * ## ⚠️ 断言的写法（两处刻意的取舍，都是审计实测后改的）
   *
   * ① **不断言等于某个具体码**，而是断言「**不被客户端替换**」这条不变式：
   *    `'QUOTA_EXCEEDED'` 恰好满足（与仓库 ~20 处惯例一致、语义准确），
   *    但即便将来换成别的合格码，这组用例也应继续为绿。
   * ② **`CLIENT_REPLACED_CODES` 是手抄常量**（交付物测试不读客户端产物，
   *    因为 `pnpm test` 要能在无客户端产物的环境跑）。故它只能锁「我们没改回
   *    已知的坏码」，**锁不住客户端单方面把 `QUOTA_EXCEEDED` 加进替换表**。
   *    该残余风险由下面「取证记录」那条注释承担（写明版本与日期，便于复核）。
   *
   * 取证记录：`2026-10-11`，桌面端 `DeepSeek Harness/resources/app.asar`
   * 与 `dsh-client-ui-chat/lib/client.js` 双份一致，均只替换上述 5 个码。
   *
   * ## ⚠️ 一处**已知取舍**（审计实测，勿当缺陷再"修"回去）
   *
   * 客户端还有**第二处**只认 `QUOTA` / `ACCOUNT_QUOTA` 的判定 —— `quotaNotice`
   * （`if (quotaNoticeHolds.size > 0 || code !== "QUOTA" && code !== "ACCOUNT_QUOTA") continue`），
   * 它驱动一条**不随 Chat 面板消失**的全局额度 Toast。改用 `'QUOTA_EXCEEDED'`
   * 后该 Toast **不再触发**。
   * ⇒ 这是「失败行有真实原因、但没有全局 Toast」与「失败行被换成误导文案、
   * 但有全局 Toast」之间的取舍，**取前者**：真实原因在失败行里，用户一定看得到；
   * 而后者的误导文案会把用户引向「等额度恢复」这个错误动作。
   */
  describe('★ 额度错误的码不得被客户端替换（issue IKJVCW）', () => {
    /**
     * 客户端 `failureMessage()` 会吞掉 message 的码（手抄，见上文「取证记录」）。
     *
     * ⚠️ 只列**本插件可能产出**的三个：`ACCOUNT_SIGNED_OUT` /
     * `ACCOUNT_SIGN_IN_REQUIRED` 是 DeepSeek 自家登录态专用，插件产生不了。
     */
    const CLIENT_REPLACED_CODES = ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH']

    it('断言前提：harness 常量 QUOTA_EXCEEDED_CODE 的字面值就是会被替换的 "QUOTA"', async () => {
      // ⚠️ 这条锚的是**上游事实**（harness 的常量值），不是同义反复：
      // 若 DSH 某天把该常量改成不被替换的值，这里变红，提示可以重新评估选型
      // （而不是让下面几条悄悄失去意义）。
      //
      // 注：同段还有一条 `CLIENT_REPLACED_CODES` 与上游常量对拍的断言，
      // 已按审计意见**删除** —— 它比较的是两个常量，零信息量（客户端改表不会红）。
      const { QUOTA_EXCEEDED_CODE } = await import('@deepseek-ai/dsh-llm')
      expect(QUOTA_EXCEEDED_CODE).toBe('QUOTA')
    })

    it('SSE 额度耗尽（InferHub.4291.200）的码不被替换，且 message 带着解禁时间', async () => {
      const pool = {
        findAccountIdByCredential: async () => 'acct-1',
        getAvailableAccount: async () => null,
        updateModelRateLimit: async () => {},
      }
      const fetchImpl = vi.fn(async () => new Response(
        'data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ))
      const adapter = makeAdapter({ fetchImpl, accountPool: pool })
      let thrown: unknown
      try {
        for await (const _ of adapter.stream(streamOptions)) { /* 不应产出 */ }
      } catch (error) {
        thrown = error
      }
      const code = (thrown as LlmError).code
      // ① 码不在客户端替换表里 ⇒ 下面那句 message 真的能到用户眼前。
      expect(CLIENT_REPLACED_CODES).not.toContain(code)
      // ② 正因为 ① 成立，带解禁时间的说明才是有意义地被断言。
      expect((thrown as LlmError).message).toMatch(/预计 .*后重置/)
    })

    it('HTTP 4xx 额度耗尽同样是不可替换的码，且 message 带解禁时间', async () => {
      // 两条通道都接（`AGENTS.md` 的既有铁律）：只改 SSE 那条会漏掉 4xx 形态。
      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ error_code: 'InferHub.4291.200', error_msg: 'insufficient quota' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ))
      let thrown: unknown
      try {
        for await (const _ of makeAdapter({ fetchImpl }).stream(streamOptions)) { /* 不应产出 */ }
      } catch (error) {
        thrown = error
      }
      expect(CLIENT_REPLACED_CODES).not.toContain((thrown as LlmError).code)
      expect((thrown as LlmError).message).toMatch(/预计 .*后重置/)
    })

    it('httpErrorCode 的额度归一化：400 + insufficient balance 归额度', async () => {
      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ error: { message: 'insufficient balance' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ))
      let thrown: unknown
      try {
        for await (const _ of makeAdapter({ fetchImpl }).stream(streamOptions)) { /* 不应产出 */ }
      } catch (error) {
        thrown = error
      }
      const code = (thrown as LlmError).code
      expect(CLIENT_REPLACED_CODES).not.toContain(code)
      // 顺带锁死它仍归额度（而不是被 400 兜底成 INVALID_REQUEST）。
      expect(code).toBe('QUOTA_EXCEEDED')
    })

    /**
     * ★★ **401/403 下额度文案的分流是「按 `4291` 判据」而非「按状态码」** ——
     * 逐格实测的真实行为（重建 `lib/` 后走 `stream()`）：
     *
     * | 报文（4xx + `<文案>`） | 400 | 401 | 403 |
     * |---|---|---|---|
     * | `insufficient balance` | 额度 | **AUTH** | **AUTH** |
     * | `insufficient quota` | 额度 | **额度** | **额度** |
     * | `out of credits` | 额度 | **AUTH** | **AUTH** |
     * | `quota exceeded` | 额度 | **AUTH** | **AUTH** |
     * | `InferHub.4291.200` + `insufficient quota` | 额度 | **额度** | **额度** |
     *
     * ## 为什么 401/403 与 400 不同（这是**既有**行为，不是本次改动引入）
     *
     * 4xx 分支的顺序是：
     * ```
     * isAuthError（401/403 恒真 ⇒ 续期 + continue 重试）
     *   → isSseQuotaExhaustedErrorCode（额度）→ isRateLimited → … → httpErrorCode
     * ```
     * 401/403 先被 `isAuthError` 接走做一次续期（`continue`），**第二轮**
     * `authRefreshed` 已为 true、跳过续期，此时才轮到额度判据 ——
     * 而 `isSseQuotaExhaustedErrorCode` 的**文案腿只认 `insufficient quota`**
     * （不认 `balance` / `credits`），故只有它能在 401/403 下穿透到额度分支。
     *
     * ## ⚠️ 这条铁律**不得**为了让上表变整齐而被改掉
     *
     * `AGENTS.md`（「同族判据必须逐格同构」）：
     * > **401/403 先判**，恒归认证类 —— 状态码与额度文案并存时
     * > （网关侧故障常在报文里捎带余额提示）**以状态码为准**
     *
     * codearts 的 401/403 来自**网关**（`APIG.0602` Invalid token /
     * `APIG.0301` 验签失败），网关故障时捎带余额词是常态。让余额词改写分类
     * ⇒ 真凭据失效被说成「额度用尽」，用户被引向「等额度恢复」而非重新登录。
     * 该铁律是 2026-10-06 raccoon / loomy「一个请求内 6 个号各被封 24h」
     * 事故的产物。
     *
     * ⚠️ **我一度照独立审计的建议，把额度判据提到 `httpErrorCode` 的
     * 401/403 短路之前，已撤回** —— 那条建议是**孤立函数的假阳性**：
     * 它只看 `httpErrorCode` 本身，没看它在真实控制流里排在额度判据**之后**。
     * ⇒ 审计结论**必须回到生产路径复核**，不能只测被建议修改的那个函数。
     *
     * ⚠️ 且「codearts 会用 401/403 下发额度文案」**无实测支撑**（141 个真实会话
     * 零命中）。将来真抓到该报文**再按实测处理**，不要据构造报文改分类顺序。
     */
    it('★ 401/403 下的额度分流：只有 `insufficient quota` 能穿透（其余归 AUTH）', async () => {
      // 逐格实测的真实归属（见上方表格）。这张表是**既有行为**的快照，
      // 不是理想设计 —— 它是「401/403 先判」这条铁律的必然结果。
      const grid: Array<[string, string, string, string]> = [
        // [文案, 400 的码, 401 的码, 403 的码]
        ['insufficient balance', 'QUOTA_EXCEEDED', 'AUTH', 'AUTH'],
        ['insufficient quota', 'QUOTA_EXCEEDED', 'QUOTA_EXCEEDED', 'QUOTA_EXCEEDED'],
        ['out of credits', 'QUOTA_EXCEEDED', 'AUTH', 'AUTH'],
        ['quota exceeded', 'QUOTA_EXCEEDED', 'AUTH', 'AUTH'],
      ]
      for (const [msg, at400, at401, at403] of grid) {
        const expected: Record<number, string> = { 400: at400, 401: at401, 403: at403 }
        for (const status of [400, 401, 403]) {
          const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).startsWith(QUEUE_STATUS_BASE)) {
              return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
            }
            return new Response(
              JSON.stringify({ error_code: 'X', error_msg: msg }),
              { status, headers: { 'content-type': 'application/json' } },
            )
          })
          let thrown: unknown
          try {
            for await (const _ of makeAdapter({ fetchImpl }).stream(streamOptions)) { /* 不应产出 */ }
          } catch (error) {
            thrown = error
          }
          expect((thrown as LlmError).code, `status=${status} msg=${msg}`).toBe(expected[status])
        }
      }
    })

    it('★ 华为额度码 `InferHub.4291.200` 在 401/403 下也能穿透到额度', async () => {
      // 与上一条的 `insufficient quota` 同因（都命中 `isSseQuotaExhaustedErrorCode`），
      // 但这条走的是**码值腿**（`4291`）而非文案腿 —— 两条腿都要有守卫。
      for (const status of [400, 401, 403]) {
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
          if (String(input).startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          return new Response(
            JSON.stringify({ error_code: 'InferHub.4291.200', error_msg: 'insufficient quota' }),
            { status, headers: { 'content-type': 'application/json' } },
          )
        })
        let thrown: unknown
        try {
          for await (const _ of makeAdapter({ fetchImpl }).stream(streamOptions)) { /* 不应产出 */ }
        } catch (error) {
          thrown = error
        }
        const code = (thrown as LlmError).code
        expect(code, `status=${status}`).toBe('QUOTA_EXCEEDED')
        // 本 issue 的主诉：额度码不得落在客户端替换表里。
        expect(CLIENT_REPLACED_CODES, `status=${status}`).not.toContain(code)
      }
    })

    it('真凭据失效（APIG.0602）仍续期重试一次（额度判据不得误伤认证路径）', async () => {
      let refreshed = 0
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(QUEUE_STATUS_BASE)) {
          return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(
          JSON.stringify({ error_code: 'APIG.0602', error_msg: 'Invalid token' }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        )
      })
      const adapter = makeAdapter({ fetchImpl, refresh: async () => { refreshed += 1 } })
      try {
        for await (const _ of adapter.stream(streamOptions)) { /* 不应产出 */ }
      } catch {
        // 续期后仍失败 ⇒ 照常抛出，这里只关心「续期发生过」。
      }
      expect(refreshed).toBe(1)
    })
  })

  /**
   * ★ `errorDetail` 的**两条腿**（独立审计实测的真实缺陷 + 一处我自己引入又修掉的回退）。
   *
   * 该函数是 `httpErrorCode` 与 4xx 额度判据的唯一输入，故它认不出的报文形态
   * 会直接决定用户看到什么码。两种形态必须**都认**：
   *
   * | 报文 | 原先 | 现在 |
   * |---|---|---|
   * | `{"error":"<字符串>"}` | ❌ 整段 JSON 原样返回（用户看到裸 JSON） | ✅ 取该字符串 |
   * | `{"error":{"code":"insufficient_quota"}}` | ✅ 取 `error.code` | ✅ **必须保留**（见下） |
   *
   * ⚠️ 第二行是**回归守卫**：修第一种形态时若图省事把 `error.code` / `error.type`
   * 两条腿一起删掉（我改的第一版真的这么干过），`insufficient_quota` 这类
   * 「把额度语义写在 code 里」的报文会从额度**掉回** `AUTH` —— 那是比原缺陷
   * 更糟的回退。故「只加腿、不减腿」这条约定必须有行为用例守着。
   */
  describe('★ errorDetail 的形态覆盖（issue IKJVCW 审计）', () => {
    /**
     * ⚠️⚠️ **必须直接断言 `errorDetail` 的返回值，不能绕道「分类结果」**
     * （第一版就是这么错的，反向验证时发现是假守卫）：
     *
     * 报文 `{"error":"insufficient balance"}` 在字符串腿**失效**时，
     * `errorDetail` 退回**整段 JSON**，而整段 JSON 里**本身就含**
     * `insufficient balance` 这个子串 ⇒ 额度判据照样命中 ⇒ 用例全绿。
     * 即「绕道分类」测的是「函数有没有返回点什么」，而不是「那条腿在不在」。
     *
     * 故本段**逐条断言返回值**：它必须是**人类可读的短语**，
     * 而**不是**带 JSON 外壳的原文。
     */
    it('★ 顶层 error 是字符串时取出该文案（原先返回整段裸 JSON）', () => {
      expect(errorDetail(JSON.stringify({ error: 'access forbidden: model not permitted' })))
        .toBe('access forbidden: model not permitted')
    })

    it('★ 同形态下**不带** JSON 外壳（这是与「退回 body」的区别所在）', () => {
      const detail = errorDetail(JSON.stringify({ error: 'insufficient balance' }))
      expect(detail).toBe('insufficient balance')
      // 反向：修复前这里会是 `{"error":"insufficient balance"}`。
      expect(detail).not.toContain('{"error"')
    })

    it('★ 回归守卫：error.code / error.type / error.message 三条腿都保留', () => {
      // ⚠️ 修字符串形态时若把这几条一起删掉（我改的第一版真的这么干过），
      // `insufficient_quota` 这类「额度语义写在 code 里」的报文会从额度
      // **掉回** `AUTH`/`INVALID_REQUEST` —— 比原缺陷更糟的回退。
      expect(errorDetail(JSON.stringify({ error: { code: 'insufficient_quota' } })))
        .toBe('insufficient_quota')
      expect(errorDetail(JSON.stringify({ error: { type: 'rate_limit_error' } })))
        .toBe('rate_limit_error')
      expect(errorDetail(JSON.stringify({ error: { message: 'insufficient balance' } })))
        .toBe('insufficient balance')
    })

    it('回归守卫：华为云形态（error_code/error_msg）与顶层 message 也保留', () => {
      expect(errorDetail(JSON.stringify({ error_code: 'InferHub.4291.200', error_msg: 'insufficient quota' })))
        .toBe('InferHub.4291.200 insufficient quota')
      expect(errorDetail(JSON.stringify({ message: 'insufficient credits' })))
        .toBe('insufficient credits')
    })

    it('非 JSON 体原样返回（既有行为不变）', () => {
      expect(errorDetail('plain text failure')).toBe('plain text failure')
    })

    it('★ 行为面：字符串 error 的额度文案真的会被归为额度（端到端，走 400）', async () => {
      // 上一条测的是判据本身；这条确认它**接进了生产路径**（4xx 分支调用它）。
      // ⚠️ 用 **400** 而不是 403：401/403 走网关短路、恒归 `AUTH`
      //（见上文那条铁律），在 403 上断言额度会与它冲突。
      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ error: 'insufficient credits' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ))
      let thrown: unknown
      try {
        for await (const _ of makeAdapter({ fetchImpl }).stream(streamOptions)) { /* 不应产出 */ }
      } catch (error) {
        thrown = error
      }
      expect((thrown as LlmError).code).toBe('QUOTA_EXCEEDED')
    })

    /**
     * ★ `detail` 那条腿（Gitee issue IKLBSH A1）。
     *
     * 上游代理的顶层 catch 把异常包成
     * `{"error":"acp-proxy failure","detail":"<真实原因>"}`：`error` 只能取出
     * **没有信息量的摘要**，真正的原因全在 `detail` 里。
     *
     * ⚠️ **证据强度如实标注**：866 个真实会话（解压 3.0 GB，覆盖全部
     * `turn/end` 错误事件）里 `"detail"` **零命中**（`scripts/tmp-scan-iklbsh.mjs`）。
     * 该形态的依据是 ① 上游代理类实现的既有惯例、② harness 自带的
     * `providerErrorDetail`（`dsh-llm-deepseek/lib/index.js`）本身就**产出**
     * `{message, detail}` 这一对字段 ⇒ 结构上必然可达。
     *
     * ⚠️ **只加不减**：新腿排在**最后**，既有腿的产出逐字节不变（见下三条回归守卫）;
     * 且它只在原先「所有腿落空 ⇒ 退回整段裸 JSON」那一种形态上生效。
     */
    it('★ detail 是字符串时取出它（原先只看到 error 那句摘要）', () => {
      expect(errorDetail(JSON.stringify({
        error: 'acp-proxy failure',
        detail: 'connect ETIMEDOUT 10.0.0.1:443',
      }))).toBe('acp-proxy failure connect ETIMEDOUT 10.0.0.1:443')
    })

    it('★ detail 是 `{message}` 嵌套对象时取 message（整对象 stringify 等于没收）', () => {
      expect(errorDetail(JSON.stringify({
        error: 'acp-proxy failure',
        detail: { message: 'upstream refused', code: 502 },
      }))).toBe('acp-proxy failure upstream refused')
      // 反向：`code: 502` 不该被拼进来（否则又从「可读」退回「一坨字段」）。
      expect(errorDetail(JSON.stringify({
        error: 'x', detail: { message: 'upstream refused', code: 502 },
      }))).not.toContain('502')
    })

    it('★ 回归守卫：detail 腿**不得**挤掉既有腿（它是追加的最后一条）', () => {
      // ⚠️ 判据不是「谁优先」，而是「既有腿的产出**一个都不能少**」：
      // `errorDetail` 的产物是**拼接**文本，下游 `isQuotaExceededError` /
      // `isContextWindowExceededError` 都在**整串**上跑正则 ⇒ 只要 code 那条腿
      // 的值仍在串里，`insufficient_quota` 就仍会被判成额度。若为了塞 detail
      // 而把它顶掉（或改成 `detail ?? 既有腿`），额度报文会**掉回** `AUTH`。
      const joined = errorDetail(JSON.stringify({
        error: { code: 'insufficient_quota', message: 'quota gone' },
        detail: 'noise',
      }))
      expect(joined).toContain('insufficient_quota')
      expect(joined).toContain('quota gone')
      // detail 追加在**末尾**（顺序本身不承载语义，但锚定它可防止有人把它
      // 提到前面从而改变「拼接文本的前缀」）。
      expect(joined.endsWith('noise')).toBe(true)
      // 空串 / 非字符串 / 数组都不算命中（否则会产出空片段或裸 JSON）。
      expect(errorDetail(JSON.stringify({ error: 'only-error', detail: '' })))
        .toBe('only-error')
      expect(errorDetail(JSON.stringify({ error: 'only-error', detail: 42 })))
        .toBe('only-error')
      expect(errorDetail(JSON.stringify({ error: 'only-error', detail: ['a'] })))
        .toBe('only-error')
      // 空对象 detail 退回既有行为（**不回退成 `[object Object]`**）。
      expect(errorDetail(JSON.stringify({ error: 'only-error', detail: {} })))
        .toBe('only-error')
    })

    it('★ `isBenefitNotFoundBody` 只认该码（判据本身，供 HTTP 4xx 通道复用）', () => {
      // 判据与 SSE 通道**同源**（同一个常量），但**全等** —— `4004` 这一族里
      // 没有证据表明其它尾号是同一语义（`4004.200` 是实测唯一的 benefit 码）；
      // 放宽成 `InferHub.4004.` 前缀会把未知语义的报文变成可重试，属行为变更。
      expect(isBenefitNotFoundBody('{"error_code":"InferHub.4004.200","error_msg":"benefit not found"}')).toBe(true)
      // 反向：别的尾号、别的 InferHub 码都不得命中。
      expect(isBenefitNotFoundBody('InferHub.4004.999')).toBe(false)
      expect(isBenefitNotFoundBody('{"error_code":"InferHub.002002009.404"}')).toBe(false)
      expect(isBenefitNotFoundBody('{"error_code":"InferHub.4291.200"}')).toBe(false)
      expect(isBenefitNotFoundBody('')).toBe(false)
    })

    /**
     * ★★ **`detail` 腿不得进入分类**（真实净回归，两轮审计独立确证）。
     *
     * ## 缺陷本体
     *
     * `httpErrorCode(status, body)` 拿 `errorDetail(body)` 的**产物**去跑
     * `isQuotaExceededError` / `isContextWindowExceededError` 正则。
     * 无条件把 detail 计入产物时，**纯展示改进变成行为变更**：
     *
     * | 报文 | 只算既有腿 | 加上 detail 腿 |
     * |---|---|---|
     * | `{"message":"bad request","detail":"insufficient quota"}` | `INVALID_REQUEST` | **`QUOTA_EXCEEDED`** |
     * | `{"message":"bad request","detail":"prompt is too long for this model"}` | `INVALID_REQUEST` | **`CONTEXT_WINDOW_EXCEEDED`** |
     *
     * 后者还会**触发 DSH 的上下文溢出压缩**、改变重试与换号行为。
     *
     * ⚠️ **这个回归原本零守卫**：我加 A1 的 3 条用例时只断言 `errorDetail` 的
     * **返回值**，没有一条锁**分类结果** ⇒ 把 `httpErrorCode` 的输入换回含 detail
     * 的产物时，全量测试**一条都不红**（实测）。
     *
     * ## 修法（两条出口分开）
     *
     * `errorDetail`（**展示**，含 detail）／`errorDetailForClassify`（**分类**，不含）
     * ——两条出口**共用同一个 `errorDetailImpl`**，不各写一份（首条红线）。
     * 分类调用点只有 `llm-adapter.ts` 的**两处**：`httpErrorCode` 与 4xx 额度判据。
     */
    it('★★ 分类出口找不到 detail 字段、展示出口找得到（两条出口的差就是这一条腿）', () => {
      const body = JSON.stringify({ message: 'bad request', detail: 'insufficient quota' })
      // 展示出口：含 detail（用户看得到真实原因）。
      expect(errorDetail(body)).toBe('bad request insufficient quota')
      // 分类出口：**不含** detail（判据输入与「加腿之前」逐字节相同）。
      expect(errorDetailForClassify(body)).toBe('bad request')
    })

    it('★★ 行为面：detail 里的额度措辞**不得**翻转 codearts 的错误码（本回归的守卫）', async () => {
      // ⚠️ 这条是**行为级**（走 `stream()` → 真实 `httpErrorCode`），
      // 不是「返回值断言」—— 后者测不到分类。**这就是审计指出的守卫缺口。**
      // ⚠️ 选例必须**避开**「原始 body 已命中额度」的那些措辞 —— 4xx 分支里
      // `isSseQuotaExhaustedErrorCode(errorDetailForClassify(body), rawBody)`
      // 的**第二参是原始 body**（既有行为，与 detail 腿无关），
      // `insufficient quota` 那种会被它先接走 ⇒ 测不出 detail 腿的影响。
      // 下面这些**只**能靠 `httpErrorCode` 里的 `isQuotaExceededError(detail)`
      // / `isContextWindowExceededError(detail)` 命中 ⇒ 它们才是回归的触发形态。
      const grid: Array<[string, string]> = [
        // [detail 文本, 期望的码（修复后 = 与加 detail 腿之前一致）]
        ['out of credits', 'INVALID_REQUEST'],
        ['insufficient balance', 'INVALID_REQUEST'],
        ['quota exceeded', 'INVALID_REQUEST'],
        ['prompt is too long for this model', 'INVALID_REQUEST'],
        ['maximum context length exceeded', 'INVALID_REQUEST'],
      ]
      for (const [detailText, expected] of grid) {
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
          if (String(input).startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          // 既有腿**非空**（`message`）+ detail 含敏感措辞 —— 这正是回归的触发形态。
          return new Response(
            JSON.stringify({ message: 'bad request', detail: detailText }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          )
        })
        let thrown: unknown
        try {
          for await (const _ of makeAdapter({ fetchImpl }).stream(streamOptions)) { /* 不应产出 */ }
        } catch (error) {
          thrown = error
        }
        expect((thrown as LlmError).code, `detail=${detailText}`).toBe(expected)
      }
    })

    it('★★ 第二处分类点：4xx 额度判据也不得被 detail 的**码值腿**（4291）翻转', async () => {
      // ⚠️ 这个站点比上一处**更隐蔽**，第一版守卫漏了它（变异实测：把
      // `errorDetailForClassify` 换回 `errorDetail` 后，上面那条行为用例**仍绿**）——
      // 因为 `isSseQuotaExhaustedErrorCode(code, message)` 的**第二参是原始 body**
      // （既有行为），文案腿「insufficient quota」**本就**看得到 detail ⇒ 测不出差别。
      //
      // 真正会被 detail 腿翻转的是**码值腿**（`code.includes('4291')`）：
      // detail 里出现 `InferHub.4291.200` 时，展示出口的产物含 `4291` ⇒ 判额度；
      // 分类出口不含 ⇒ 报文落回 `INVALID_REQUEST`（= 加 detail 腿之前的行为）。
      //
      // 实测（`scripts/tmp-check-site2.mts` 的对照，已固化到本用例）：
      //   `{"message":"bad request","detail":"InferHub.4291.200"}`
      //     展示出口命中 = true   分类出口命中 = false   ⇒ ★ 被翻转
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(QUEUE_STATUS_BASE)) {
          return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(
          JSON.stringify({ message: 'bad request', detail: 'InferHub.4291.200' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      })
      let thrown: unknown
      try {
        for await (const _ of makeAdapter({ fetchImpl }).stream(streamOptions)) { /* 不应产出 */ }
      } catch (error) {
        thrown = error
      }
      // 期望「与加 detail 腿之前一致」⇒ 400 兜底成 INVALID_REQUEST。
      // ⚠️ **不要**把它期望成 QUOTA_EXCEEDED —— 那正是本回归的形态。
      expect((thrown as LlmError).code).toBe('INVALID_REQUEST')
    })

    it('★ 对照：既有腿上**本来就有**额度语义时仍归额度（分类出口不得把既有腿也丢）', async () => {
      // 反向守卫：修分类出口时若图省事「凡有 detail 就不判额度」或把既有腿一起丢，
      // `{"error":{"code":"insufficient_quota"}}` 这类报文会从额度**掉回**
      // `INVALID_REQUEST` —— 那是比原缺陷更糟的回退。
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(QUEUE_STATUS_BASE)) {
          return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(
          JSON.stringify({ error: { code: 'insufficient_quota' }, detail: 'noise' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      })
      let thrown: unknown
      try {
        for await (const _ of makeAdapter({ fetchImpl }).stream(streamOptions)) { /* 不应产出 */ }
      } catch (error) {
        thrown = error
      }
      expect((thrown as LlmError).code).toBe('QUOTA_EXCEEDED')
    })
  })

  /**
   * ★ **benefit 去头重试的 4xx 通道**（Gitee issue IKLBSH A6）。
   *
   * 同一个上游条件（该账号没有 benefit 免费额度包）走**两条**通道下发：
   * SSE 200（已接）与 HTTP **4xx**（修复前**未接**）。后者会径直落到
   * `httpErrorCode` 归成 `INVALID_REQUEST` 抛出，**去头重试一次也不试** ——
   * 「同一条件下 SSE 能自愈、4xx 却硬报错」，即本仓库首条红线
   *「同一语义两套判据」的形态。
   *
   * ⚠️ **该缺陷由既有分支显式锁定过**：`origin/issue/IKJOF7-benefit-diagnostics`
   *（2026-10-05 取证提交）用 `it.fails` 写了「HTTP 4xx + 正文含
   * `InferHub.4004.200` 时也应当去头重试」，当时的结论是「已确认，但本分支不修」。
   *
   * ⚠️ **不去采纳 issue 建议的「1s/2s/3s 退避重试最多 3 次」**：issue 自己给的
   * 证据是「去掉请求头后密集取样 9 次全部 200」—— 那证明的正是**去头即通**，
   * 而非「需要多次退避」；且 `benefitHeaderDropped` 的既有语义写明「只试一次，
   * 避免与真实失败互相掩盖」。按证据改，不按建议改。
   */
  describe('★ benefit 去头重试必须接上 4xx 通道（issue IKLBSH A6）', () => {
    it('★ 4xx + InferHub.4004.200：先领一次（领不到）再去头重试一次并成功', async () => {
      setBenefitMemoryCache(['deepseek-v4.1-flash']) // 远端集合确认 ⇒ 首次即带头
      try {
        const seen: Array<string | null> = []
        let chatCalls = 0
        let claimCalls = 0
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          if (url.startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          // ⚠️ benefit 领取（opengw）必须先分流出去：它不是 chat 请求，
          // 混进 chatCalls / seen 会把「恰好两次 chat」的断言放大成三条。
          if (url === CODEARTS_BENEFIT_CLAIM_URL) {
            claimCalls += 1
            // 领取失败（非 0000）⇒ 触发原有的去头降级。
            return new Response(JSON.stringify({ error_code: 'APIG.9999', error_msg: 'no资格' }), { status: 200 })
          }
          chatCalls += 1
          const maasType = new Headers(init?.headers).get('maas_type')
          seen.push(maasType)
          if (maasType !== null) {
            // 第一次（带头）：服务端以 **4xx** 下发同一个 benefit-not-found 码。
            return new Response(
              JSON.stringify({ error_code: 'InferHub.4004.200', error_msg: 'benefit not found' }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            )
          }
          // 第二次（去头）：正常出流 —— 与 issue 的「去头后密集取样 9 次全部 200」一致。
          return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
        })
        const adapter = makeAdapter({ fetchImpl })
        const texts: string[] = []
        for await (const chunk of adapter.stream({ ...streamOptions, model: 'deepseek-v4.1-flash' } as never)) {
          if (chunk.type === 'text-delta') texts.push(chunk.text)
        }
        // ① 真的产出了内容（= 去头重试生效）；
        expect(texts).toEqual(['ok'])
        // ② 恰好两次 chat 请求，且第一次带头、第二次**不带**头；
        expect(seen).toEqual(['benefit', null])
        // ③ **只去头一次**：不得因两条通道各试一次而放大成三轮。
        expect(chatCalls).toBe(2)
        // ④ 降级前先领了一次福利（对标 codearts2api 的 `benefit_auto_claim`）；领不到才降级。
        expect(claimCalls).toBe(1)
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })

    it('★ 对照：本轮**没带**该头时同一报文不得触发去头重试（判据不许放宽）', async () => {
      // `benefitHeaderSent` 前置条件是**有意**的：去掉它会把任何来源的同名码
      // 都变成可重试。更关键的是「去掉一个根本没带上的头」等于逐字节重发同一
      // 请求，只会白白用掉唯一一次自愈名额并把它锁死。
      setBenefitMemoryCache([])
      try {
        let chatCalls = 0
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          chatCalls += 1
          // 无后缀 deepseek-v4-flash 是**非 benefit** 模型：恒不带 maas_type。
          expect(new Headers(init?.headers).get('maas_type')).toBeNull()
          return new Response(
            JSON.stringify({ error_code: 'InferHub.4004.200', error_msg: 'benefit not found' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          )
        })
        const adapter = makeAdapter({ fetchImpl })
        let thrown: unknown
        try {
          for await (const _ of adapter.stream({ ...streamOptions, model: 'deepseek-v4-flash' } as never)) { /* 不应产出 */ }
        } catch (error) {
          thrown = error
        }
        // 如实抛出（不被「去头重试」吞掉），且**只有一次**请求。
        expect((thrown as LlmError).code).toBe('INVALID_REQUEST')
        expect(chatCalls).toBe(1)
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })

    it('★ SSE 通道的孪生对照：本轮没带该头时报 4004.200 不得重试、也不得去领取', async () => {
      // 本机真实形态（2026-10-26 复现）：另有一个压缩插件会给 CodeArts 请求
      // **补** `maas_type: benefit`，而我们的请求本身没带该头。此时上游回的
      // 4004.200 与我们无关 —— 「去掉一个没带上的头」是逐字节相同的重发，
      // 白白用掉唯一一次自愈名额，还会同时锁死补头方向。
      setBenefitMemoryCache([])
      try {
        let chatCalls = 0
        let claimCalls = 0
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url === CODEARTS_BENEFIT_CLAIM_URL) {
            claimCalls += 1
            return new Response(JSON.stringify({ error_code: '0000', error_msg: '' }), { status: 200 })
          }
          chatCalls += 1
          return new Response(
            'data:{"text":"[DONE]","error_code":"InferHub.4004.200","error_msg":"benefit not found"}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        })
        const adapter = makeAdapter({ fetchImpl })
        let thrown: unknown
        try {
          for await (const _ of adapter.stream({ ...streamOptions, model: 'deepseek-v4-flash' } as never)) { /* 不应产出 */ }
        } catch (error) {
          thrown = error
        }
        expect((thrown as LlmError).code).toBe('BENEFIT_NOT_FOUND')
        // 一次请求、零次领取：去头/领取都**不该**在这里发生。
        expect(chatCalls).toBe(1)
        expect(claimCalls).toBe(0)
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })

    it('★ 对照：4xx 报文**不含**该码时不得触发去头重试（判据不得放宽成「凡 4xx 都重试」）', async () => {
      setBenefitMemoryCache(['deepseek-v4.1-flash'])
      try {
        let chatCalls = 0
        const maasTypes: Array<string | null> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          chatCalls += 1
          maasTypes.push(new Headers(init?.headers).get('maas_type'))
          // 另一个 400：同样带 benefit 头，但**不是** benefit-not-found。
          // ⚠️ 也不能用 `InferHub.002002009.404` —— 它现在是**另一个**自愈信号
          // （补头方向），会让本用例测到的就不是「判据有没有放宽」了。
          return new Response(
            JSON.stringify({ error_code: 'InferHub.9999.400', error_msg: 'boom' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          )
        })
        const adapter = makeAdapter({ fetchImpl })
        try {
          for await (const _ of adapter.stream({ ...streamOptions, model: 'deepseek-v4.1-flash' } as never)) { /* 不应产出 */ }
        } catch { /* 抛错即可 */ }
        expect(maasTypes).toEqual(['benefit'])
        expect(chatCalls).toBe(1)
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })

    it('★ SSE 200 通道：先领一次（领不到）再去头重试，chat 仍恰好两次', async () => {
      // 回归守卫：SSE 形态（HTTP 200 + 内嵌 error_code）原先就能去头重试，
      // 改动后必须仍然如此（且同样只去头一次）。
      setBenefitMemoryCache(['deepseek-v4.1-flash'])
      try {
        const seen: Array<string | null> = []
        let claimCalls = 0
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          if (url.startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (url === CODEARTS_BENEFIT_CLAIM_URL) {
            claimCalls += 1
            return new Response(JSON.stringify({ error_code: 'APIG.9999', error_msg: 'no资格' }), { status: 200 })
          }
          const maasType = new Headers(init?.headers).get('maas_type')
          seen.push(maasType)
          if (maasType !== null) {
            return new Response(
              'data:{"text":"[DONE]","error_code":"InferHub.4004.200","error_msg":"benefit not found"}\n\n',
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            )
          }
          return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
        })
        const adapter = makeAdapter({ fetchImpl })
        const texts: string[] = []
        for await (const chunk of adapter.stream({ ...streamOptions, model: 'deepseek-v4.1-flash' } as never)) {
          if (chunk.type === 'text-delta') texts.push(chunk.text)
        }
        expect(texts).toEqual(['ok'])
        expect(seen).toEqual(['benefit', null])
        // 降级前领了一次（与 4xx 通道同一门禁，只领一次）。
        expect(claimCalls).toBe(1)
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })

    /**
     * ★ 领取成功 → **保持** `maas_type: benefit` 重放（本次改动的正例）。
     *
     * 依据：codearts2api README（原文核实）「限时福利必须先领取才能调用；领取幂等」。
     * 领到之后账号就有福利包了 ⇒ 该走免费额度通道；若这时反而去头，用户就被
     * 推到积分通道上 —— 那正是不足 14 记录的静默资损。
     */
    it('★ 领取成功 → 带头重放并成功（绝不去头，且只领一次）', async () => {
      setBenefitMemoryCache(['deepseek-v4.1-flash'])
      try {
        const seen: Array<string | null> = []
        let claimCalls = 0
        let headedChats = 0
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          if (url.startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (url === CODEARTS_BENEFIT_CLAIM_URL) {
            claimCalls += 1
            // ✅ 领取成功：响应体 `error_code === '0000'`
            return new Response(JSON.stringify({ error_code: '0000', error_msg: '' }), { status: 200 })
          }
          const maasType = new Headers(init?.headers).get('maas_type')
          seen.push(maasType)
          if (maasType !== 'benefit') {
            // ⚠️ 领到之后仍被去头 ⇒ 资损回归，直接失败并说明是哪一次。
            throw new Error(`领到福利后第 ${seen.length} 次 chat 丢了 maas_type 头（应带头重放）`)
          }
          headedChats += 1
          if (headedChats === 1) {
            // 第一次：还没领，上游按实测回 benefit-not-found。
            return new Response(
              'data:{"text":"[DONE]","error_code":"InferHub.4004.200","error_msg":"benefit not found"}\n\n',
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            )
          }
          // 第二次：领取后重放 ⇒ 正常出流。
          return new Response('data: {"choices":[{"delta":{"content":"after-claim-ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
        })
        const adapter = makeAdapter({ fetchImpl })
        const texts: string[] = []
        for await (const chunk of adapter.stream({ ...streamOptions, model: 'deepseek-v4.1-flash' } as never)) {
          if (chunk.type === 'text-delta') texts.push(chunk.text)
        }
        // ① 正文来自「领到后带头重放」；② 两次 chat **都带头**（从未降级）；③ 只领一次。
        expect(texts).toEqual(['after-claim-ok'])
        expect(seen).toEqual(['benefit', 'benefit'])
        expect(claimCalls).toBe(1)
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })

    /**
     * ★ **未在远端集合确认的模型先发常规请求**。
     *
     * 判据只剩远端 `gateway/config` 集合（官方内核同款）。本仓库曾有一张静态
     * 兜底表，写于 2026-09-23，依据是**当时**的实测；它不会随后端演进更新，
     * 而后端已把 `deepseek-v4.1-flash` 改按常规 `0.18x` 模型下发：不带该头正常
     * 出流，带上反而恒定 `InferHub.4004.200 benefit not found`（账号无 benefit 包）。
     *
     * 旧实现因此**每次都先带错头**，再靠 4004 通道去头重试 —— 用户首条消息报
     * 「codearts: benefit not found」的直接原因（本轮报障）。表已删除。
     *
     * ⇒ 远端集合**未确认**该模型时先发常规请求；只有上游回
     * `InferHub.002002009.404`（该模型只按 benefit 通道注册）才补头重试一次。
     */
    it('★ 未在远端集合确认：先发常规请求，404 未注册 → 补头重试成功', async () => {
      setBenefitMemoryCache([]) // 远端集合未确认 ⇒ 首次请求不许带头
      try {
        const seen: Array<string | null> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          const maasType = new Headers(init?.headers).get('maas_type')
          seen.push(maasType)
          if (maasType === null) {
            // 常规通道：该模型只按 benefit 通道注册 ⇒ 200 + 内嵌 404。
            return new Response(
              'data:{"text":"[DONE]","error_code":"InferHub.002002009.404","error_msg":"The model is not registered, please request other model"}\n\n',
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            )
          }
          return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
        })
        const adapter = makeAdapter({ fetchImpl })
        const texts: string[] = []
        for await (const chunk of adapter.stream({ ...streamOptions, model: 'deepseek-v4.1-flash' } as never)) {
          if (chunk.type === 'text-delta') texts.push(chunk.text)
        }
        expect(texts).toEqual(['ok'])
        // 首次**不带**、补头后才带 —— 与「4004 去头」方向恰好相反。
        expect(seen).toEqual([null, 'benefit'])
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })

    /**
     * ★ 补头与去头各只一次 ⇒ 最多三轮后收敛，不得来回乒乓。
     *
     * 「账号没有 benefit 包」+「模型只按 benefit 通道注册」同时成立时无解
     * （任何一次请求都不通），此时必须**如实抛出**，而不是无限重试把界面拖死。
     */
    it('★ 补头 / 去头各只一次：不得来回乒乓，最终如实抛错', async () => {
      setBenefitMemoryCache([])
      try {
        const seen: Array<string | null> = []
        let claimCalls = 0
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          if (url.startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (url === CODEARTS_BENEFIT_CLAIM_URL) {
            claimCalls += 1
            return new Response(JSON.stringify({ error_code: 'APIG.9999', error_msg: 'no资格' }), { status: 200 })
          }
          const maasType = new Headers(init?.headers).get('maas_type')
          seen.push(maasType)
          const code = maasType === null ? 'InferHub.002002009.404' : 'InferHub.4004.200'
          const msg = maasType === null ? 'The model is not registered' : 'benefit not found'
          return new Response(
            `data:{"text":"[DONE]","error_code":"${code}","error_msg":"${msg}"}\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        })
        const adapter = makeAdapter({ fetchImpl })
        let thrown: unknown
        try {
          for await (const _ of adapter.stream({ ...streamOptions, model: 'deepseek-v4.1-flash' } as never)) { /* 不应产出 */ }
        } catch (error) {
          thrown = error
        }
        // 常规 → 补头 → 去头（三轮）后收敛。
        expect(seen).toEqual([null, 'benefit', null])
        /**
         * ⚠️⚠️ **未确认的模型不得领取**（2026-10-27 审计 P1 修，期望值由 1 改为 0）。
         *
         * 本用例的 `setBenefitMemoryCache([])` 表示「远端确认**没有** benefit 模型」
         * ⇒ `benefitHeaderCertain === false`。而 `InferHub.4004.200` 这个码**不区分**：
         * ① 该账号没有 benefit 包；② 这个模型根本不该带该头（PR 自己取证过：
         * 把该头送给非 benefit 模型就回 `4004.200`）。
         *
         * 于是这条「补头方向带出来的 4004.200」如果去领取，就是**在无关场景里
         * 打一次写请求**（对抗审计实测：一次 `stream()` 里 4 次 chat + 1 次写）。
         *
         * ⇒ 修法：领取的前置条件收紧成「该模型由远端 `gateway/config` 确认过」
         *   （或本进程内补头成功过）。未确认时直接走既有的去头降级 —— 只发读请求。
         *   序列不变（逃→补→去→抛），只是不再有那次写。
         */
        expect(claimCalls, '★ 未确认模型不得触发领取（写操作）').toBe(0)
        // 如实抛出「未注册」——此时已无可用手段。
        expect((thrown as LlmError).code).toBe('MODEL_NOT_REGISTERED')
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })
  })
})

/**
 * ★★ **残缺目录必须能补齐**（issue IKJVTF 复审，审计 I3）。
 *
 * CodeArts 的目录来自**两个**独立端点（gateway/config + snap builtin），
 * 失败路径都**静默**返回 undefined ⇒ 「一个成功、一个失败」时
 * `models.length > 0`，而旧短路判据是 `remoteModels !== undefined`
 * ⇒ 残缺目录一旦落缓存就**永久固化**（闸门冷却在生产里只有闸门自己那一处
 * 调用点，而它排在短路之后）⇒ 只有重启 DSH 才能恢复。
 *
 * ⚠️ 断言必须是**行为**（清掉冷却后真的重拉并补齐），不能只断言
 * `gate.cooling()` —— 后者在生产路径上读不到，是**假绿**（Cline 那边
 * 初版就栽在这上面，见 `cline-adapter.spec.ts` 的对应注释）。
 */
describe('CodeArtsAdapter 残缺目录自愈（★ IKJVTF I3）', () => {
  it('★ 残缺（complete=false）⇒ 展示但**不**永久缓存，冷却后重拉补齐', async () => {
    let calls = 0
    // 上游先残缺后完整：第一次只拿到一部分，之后两个来源都通。
    let complete = false
    const firstBatch = [
      { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
    ]
    const fullBatch = [
      ...firstBatch,
      { id: 'GLM-5.2', name: 'GLM-5.2' },
    ]
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls += 1
        return complete ? fullBatch : firstBatch
      },
      catalogComplete: () => complete,
    })

    const first = await adapter.listModels('codearts')
    // ① 残缺目录**照常展示**
    expect(first.map((m) => m.id)).toContain('glm-5.3-flash')
    // ② 它落进了缓存（否则每次 listModels 都重拉）
    expect((adapter as unknown as { remoteModels: unknown }).remoteModels).toBeDefined()
    // ③ 但**没有**被标成完整 —— 这是短路的判据
    expect((adapter as unknown as { remoteComplete: boolean }).remoteComplete).toBe(false)

    // ④ 冷却窗口内不重复打请求
    const afterFirst = calls
    await adapter.listModels('codearts')
    expect(calls).toBe(afterFirst)

    // ⑤ ★ 核心：清掉冷却（等价「冷却到期」）+ 上游已完整 ⇒ **必须真的重拉补齐**
    //    修复前这里是「零请求」：短路判据是 `remoteModels !== undefined`，
    //    而残缺目录也赋值了它 ⇒ 闸门冷却永远读不到。
    complete = true
    ;(adapter as unknown as { catalogGate: { reset(): void } }).catalogGate.reset()
    const second = await adapter.listModels('codearts')
    expect(calls).toBeGreaterThan(afterFirst)
    expect(second.map((m) => m.id)).toContain('GLM-5.2')
    // ⑥ 补齐后转为完整 ⇒ 此后不再重拉
    expect((adapter as unknown as { remoteComplete: boolean }).remoteComplete).toBe(true)
    const afterSecond = calls
    await adapter.listModels('codearts')
    expect(calls).toBe(afterSecond)
  })

  it('★ 完整（complete=true）⇒ 清冷却，后续调用零请求', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls += 1
        return [{ id: 'GLM-5.2', name: 'GLM-5.2' }]
      },
      catalogComplete: () => true,
    })

    await adapter.listModels('codearts')
    const afterFirst = calls
    await adapter.listModels('codearts')
    expect(calls).toBe(afterFirst)
    expect((adapter as unknown as { remoteComplete: boolean }).remoteComplete).toBe(true)
  })

  it('★ 未注入 catalogComplete（旧替身）⇒ 退回旧行为（complete = got）', async () => {
    // ⚠️ 向后兼容：不传回调时按「完整」处理，避免把「判不出」当成残缺
    // 而让 provider 反复重拉（那会把冷却机制架空）。
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls += 1
        return [{ id: 'GLM-5.2', name: 'GLM-5.2' }]
      },
    })

    await adapter.listModels('codearts')
    expect((adapter as unknown as { remoteComplete: boolean }).remoteComplete).toBe(true)
    const afterFirst = calls
    await adapter.listModels('codearts')
    expect(calls).toBe(afterFirst)
  })
})

  /**
   * ★★ **2026-10-27 审计修的四条不变式**（每条都对应一处实测击穿）。
   *
   * 这一组钉的是「自愈状态机」的**边界**：写操作的前置条件、跨请求去重、
   * 进程内学习、以及「只领一次」这条原先**完全没被守卫**的不变式
   * （对抗审计实测：删掉那条门禁后 115 条用例全绿，而探针变成无限循环）。
   */
  describe('★★ benefit 自愈的写操作边界（2026-10-27 审计修）', () => {
    it('★★★ 领取恒成功 + 上游恒 4004.200 ⇒ 只领一次、且必然收敛（钉住「不乒乓」）', async () => {
      /**
       * ⚠️⚠️ 这是本轮**最关键的守卫**：对抗审计把 `if (!benefitClaimAttempted)`
       * 改成 `if (true)` 后，PR 原有的 115 条用例**全绿**，而同配置的探针
       * 变成「chat+claim 无限循环」（4s 超时）。
       *
       * 根因：`claimBenefitOnce()` 成功 ⇒ `continue` 保持头重放 ⇒ 又 4004.200
       * ⇒ 若门禁被去掉就**再领一次** ⇒ 永远出不去。也就是说「各只一次」这条
       * 被写进 PR 描述的不变式，原先**一条用例都没钉住**。
       *
       * ⇒ 本用例：领取**恒成功**、上游**恒** 4004.200，断言
       *   ① chat 有界（≤3）；② 领取**恰好一次**；③ 最终如实抛错。
       */
      setBenefitMemoryCache(['deepseek-v4.1-flash'])
      try {
        const seen: Array<string | null> = []
        let claimCalls = 0
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          if (url.startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (url === CODEARTS_BENEFIT_CLAIM_URL) {
            claimCalls += 1
            // ⚠️ 领取**永远成功** —— 这是让「无门禁版本」无限循环的关键设定。
            return new Response(JSON.stringify({ error_code: '0000' }), { status: 200 })
          }
          const maasType = new Headers(init?.headers).get('maas_type')
          seen.push(maasType)
          // ⚠️ 上游**永远**回 4004.200（无论带不带头）⇒ 逼出自愈上限。
          return new Response(
            'data:{"text":"[DONE]","error_code":"InferHub.4004.200","error_msg":"benefit not found"}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        })
        const adapter = makeAdapter({ fetchImpl })
        let thrown: unknown
        try {
          for await (const _ of adapter.stream({ ...streamOptions, model: 'deepseek-v4.1-flash' } as never)) { /* 不应产出 */ }
        } catch (error) {
          thrown = error
        }
        expect(
          claimCalls,
          '★★★ 领取是**写操作**，必须**恰好一次**；无门禁版本会无限循环（审计实测 4s 超时）',
        ).toBe(1)
        expect(seen.length, '★ 自愈必须收敛（chat 有界），不得乒乓').toBeLessThanOrEqual(3)
        expect((thrown as LlmError).code).toBe('BENEFIT_NOT_FOUND')
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })

    it('★★ 3 条并发同时 4004.200 ⇒ 只发 1 次领取（写操作必须跨请求去重）', async () => {
      /**
       * ⚠️ 修前 `benefitClaimAttempted` 是 `stream()` 局部的 ⇒ 3 条并发各领一次
       * （对抗审计实测 `claims=3`）。而 DSH 一轮会并发发主回复 + 标题 + 压缩
       * 三条请求，标题/压缩是后台的、用户看不到它们的失败，但**写请求照发**。
       */
      setBenefitMemoryCache(['deepseek-v4.1-flash'])
      try {
        let claimCalls = 0
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url.startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (url === CODEARTS_BENEFIT_CLAIM_URL) {
            claimCalls += 1
            // ⚠️ 故意慢一点，让三条请求真正重叠（否则测不出「复用同一个 Promise」）
            await new Promise((resolve) => setTimeout(resolve, 10))
            return new Response(JSON.stringify({ error_code: 'APIG.9999' }), { status: 200 })
          }
          return new Response(
            'data:{"text":"[DONE]","error_code":"InferHub.4004.200","error_msg":"benefit not found"}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        })
        const adapter = makeAdapter({ fetchImpl })
        const run = async (): Promise<void> => {
          try {
            for await (const _ of adapter.stream({ ...streamOptions, model: 'deepseek-v4.1-flash' } as never)) { /* noop */ }
          } catch { /* 三条都应失败，不影响断言 */ }
        }
        await Promise.all([run(), run(), run()])
        expect(
          claimCalls,
          '★★ 并发去重失效 ⇒ 一轮对话发 3 次写请求（标题/压缩是后台请求，用户看不到）',
        ).toBe(1)
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })

    it('★★ 远端集合取不到时，补头成功一次后**下一轮直接带头**（不得每条请求都付两轮）', async () => {
      /**
       * ⚠️ 修前 `benefitHeaderPromoted` 是 `stream()` 局部变量 ⇒ 远端集合为空时
       * （本机常态：`gateway/config` 回 `4000 invalid channel`）benefit-only 模型
       * **每条请求**都要「无头 404 → 补头 → 成功」两次 chat。
       * 实测：连续两次 `stream()` 头序列 `[null,'benefit',null,'benefit']`；
       * 一轮 3 条并发 ⇒ **6 次上游**。修前（有静态表）同场景只需 1 次。
       */
      setBenefitMemoryCache([])   // ← 远端「确认无」⇒ 首轮一定不带头
      try {
        const seen: Array<string | null> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          if (url.startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (url === CODEARTS_BENEFIT_CLAIM_URL) {
            return new Response(JSON.stringify({ error_code: 'APIG.9999' }), { status: 200 })
          }
          const maasType = new Headers(init?.headers).get('maas_type')
          seen.push(maasType)
          if (maasType === null) {
            // 无头 ⇒ 未注册（逼出补头方向）
            return new Response(
              'data:{"text":"[DONE]","error_code":"InferHub.002002009.404","error_msg":"not registered"}\n\n',
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            )
          }
          // 带头 ⇒ 成功出流
          return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
        })
        const adapter = makeAdapter({ fetchImpl })
        const first = async (): Promise<void> => {
          for await (const _ of adapter.stream({ ...streamOptions, model: 'deepseek-v4.1-flash' } as never)) { /* noop */ }
        }
        await first()
        expect(seen, '首轮：无头 → 补头（这是远端集合缺失时的正常代价）').toEqual([null, 'benefit'])
        seen.length = 0
        await first()
        expect(
          seen,
          '★★ 第二轮仍从「无头」开始 ⇒ 每条请求都多付一次上游往返（进程内学习没生效）',
        ).toEqual(['benefit'])
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })

    it('★★ 4xx 判据必须优先读结构化 error_code：正文回显同串不得触发补头', async () => {
      /**
       * ⚠️ 修前 `isModelNotRegisteredBody` 是裸 `body.includes('InferHub.002002009.404')`
       * ⇒ 对抗审计构造了一个**与「未注册」无关**的 400：正文里回显了用户内容，
       * 而用户内容恰好含这串字符 ⇒ 也命中 ⇒ 多打一次上游，还把 `maas_type`
       * 送给一个非 benefit 模型。
       *
       * ⇒ 现在：能解析出结构化 `error_code` 时**只认全等**（与 SSE 通道同判据）；
       * 裸子串只作「解析不出结构化字段」时的兜底。
       *
       * ⚠️ 本用例的关键是 `error_code` **存在但不等于**该码，且正文**仍含**该串 ——
       * 只有这样才能区分「全等优先」与「裸子串」两种实现（我第一版用「无 error_code
       * 字段」的报文，两种实现都给 true ⇒ **无牙**，变异实测全绿）。
       */
      setBenefitMemoryCache([])
      try {
        const seen: Array<string | null> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          if (url.startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (url === CODEARTS_BENEFIT_CLAIM_URL) {
            return new Response(JSON.stringify({ error_code: 'APIG.9999' }), { status: 200 })
          }
          seen.push(new Headers(init?.headers).get('maas_type'))
          // ⚠️ 结构化码是「别的东西」，但 error_msg 里回显了未注册码的那串字符。
          return new Response(JSON.stringify({
            error_code: 'InferHub.9999.400',
            error_msg: 'invalid tool call arguments: {"q":"InferHub.002002009.404"}',
          }), { status: 400, headers: { 'content-type': 'application/json' } })
        })
        const adapter = makeAdapter({ fetchImpl })
        try {
          for await (const _ of adapter.stream({ ...streamOptions, model: 'glm-5.3' } as never)) { /* noop */ }
        } catch { /* 预期抛出 */ }
        expect(
          seen,
          '★ 正文回显的同串字符串不得被当成「模型未注册」（结构化 error_code 优先）',
        ).toEqual([null])
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })

    it('★★ 未确认模型被补头带出 4004.200 时不得领取（写操作只对确认过的模型开放）', async () => {
      /**
       * ⚠️ 对抗审计实测：一个从未被远端确认的模型（手填 / 打错大小写 / 已下线）
       * 在一次 `stream()` 里打出 **4 次 chat + 1 次领取**。
       *
       * 而 `4004.200` **不区分**「该账号没有 benefit 包」与「这个模型不该带该头」
       * ⇒ 在「模型根本不存在」这种与福利无关的场景里打一次写请求。
       */
      setBenefitMemoryCache([])   // ← 一个模型都没确认
      try {
        let claimCalls = 0
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          if (url.startsWith(QUEUE_STATUS_BASE)) {
            return new Response('{"status":"working"}', { status: 200, headers: { 'content-type': 'application/json' } })
          }
          if (url === CODEARTS_BENEFIT_CLAIM_URL) {
            claimCalls += 1
            return new Response(JSON.stringify({ error_code: '0000' }), { status: 200 })
          }
          const maasType = new Headers(init?.headers).get('maas_type')
          const code = maasType === null ? 'InferHub.002002009.404' : 'InferHub.4004.200'
          return new Response(
            `data:{"text":"[DONE]","error_code":"${code}","error_msg":"x"}\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        })
        const adapter = makeAdapter({ fetchImpl })
        try {
          for await (const _ of adapter.stream({ ...streamOptions, model: 'some-paid-or-typo-model' } as never)) { /* noop */ }
        } catch { /* 预期抛出 */ }
        expect(
          claimCalls,
          '★★ 模型未被远端确认却去领取 ⇒ 在与福利无关的场景（打错 id / 模型下线）打一次写请求',
        ).toBe(0)
      } finally {
        setBenefitMemoryCache(undefined)
      }
    })
  })
