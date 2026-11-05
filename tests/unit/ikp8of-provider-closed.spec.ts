/**
 * ★★ **Gitee issue IKP8OF**：关闭供应商后目录继续变长 ⇒ 不得自动「已打开」、
 * 新模型不得仍可选。
 *
 * ## 缺陷形态（用户报障，本仓库用真实 `ClineAdapter` 实测复现）
 *
 * 「关闭供应商」（`provider.setEnabled(false)`）只把**当时目录**的 id 写进
 * 模型黑名单；而 `provider.status` 的 `closed` 判据是
 * `total > 0 && disabled === total`（`total` 取**当前**全量目录）。
 * 于是目录**在关闭之后**继续变长（cline 三源异步 + models.dev 可恢复、
 * 其余家后台刷新器补进上游新模型）⇒ `disabled < total` ⇒ `closed` 翻回 `false`：
 *
 * ```
 * ① 冷帧关闭   {total:3,disabled:3,closed:true}
 * ② 目录补齐   {total:7,disabled:3,closed:false}   ← 开关静默翻回「已打开」
 * ③ 选择器里多出 4 条可选                           ← 真正的危害（零提示）
 * ```
 *
 * ## 修复的两条腿（**缺一条就有真缺陷**）
 *
 * | 腿 | 管什么 | 少了它的后果 |
 * |---|---|---|
 * | `providerClosed`（**意图**，持久化） | 目录**增长** | 目录一长就翻回「已打开」（本 issue） |
 * | `disabled === total`（**派生**，读目录） | 用户**逐条关光** | 逐条关光后不报已关闭（既有语义丢失） |
 *
 * ## 本文件守的是「**不走共享骨架的那 4 家**」
 *
 * 其余 14 家经 `model-catalog.ts` 的 `listModels`，那一处的意图短路由
 * `jet-hub-rpc.spec.ts` 的 IKP8OF 组覆盖。而 `autoclaw` / `modelscope` /
 * `officeace` / `opencode` **各自手写 `listModels`** ⇒ 必须逐家接线，
 * **漏一家就是静默失效**（本仓库已因同型缺陷复发多次）。
 *
 * ⚠️⚠️ 本文件同时补一个**既有守卫缺口**：实测把 `officeace` 的短路整行删掉，
 * 全量 9858 条单测**仍全绿** —— 即该家的 `providerClosed` 零覆盖。故下面
 * 每条用例都是「真跑适配器 + 断言返回值为空」，不是源码文本断言。
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AutoclawAdapter } from '../../src/autoclaw-adapter.js'
import { AUTOCLAW } from '../../src/autoclaw-product.js'
import { ModelscopeAdapter } from '../../src/modelscope-adapter.js'
import { MODELSCOPE, MODELSCOPE_FALLBACK_MODELS } from '../../src/modelscope-product.js'
import { OpencodeAdapter } from '../../src/opencode-adapter.js'
import { OPENCODE } from '../../src/opencode-product.js'
import { OfficeAceAdapter } from '../../src/officeace-adapter.js'
import { OFFICEACE, OFFICEACE_MODELS } from '../../src/officeace-product.js'
import { AggregateAdapter, AGGREGATE_PROVIDER } from '../../src/aggregate-adapter.js'
import { AccountPool } from '../../src/account-pool.js'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

/**
 * 取出一段调用实参（含首尾括号）里的**第一个实参**（按顶层逗号切）。
 *
 * ⚠️ 必须按**括号/花括号深度**切，不能用 `indexOf(',')`：deps 里可能含
 * `{ ...options === undefined ? {} : { onLoaded } }` 这类嵌套。
 */
function firstArgument(callBlock: string): string {
  // 跳过首个 `(`。
  let depth = 0
  for (let i = 0; i < callBlock.length; i += 1) {
    const ch = callBlock[i]
    if (ch === '(' || ch === '{' || ch === '[') depth += 1
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return callBlock.slice(0, i)
    } else if (ch === ',' && depth === 1) {
      return callBlock.slice(0, i)
    }
  }
  return callBlock
}

/**
 * 从 `openIndex`（指向 `(`）起，用**括号配对**求出该调用的结束位置（`)` 之后）。
 *
 * ⚠️ 独立审计指出的加固点：早期版本用「起点 + 4000 字符」当兜底窗口，
 * 一旦后续代码把那 4000 字符撑满，判据就会跨块匹配 ⇒ **静默失锚**
 *（症状是「接线漏了也全绿」，正是本仓库反复记录的假绿形态）。
 *
 * ⚠️ 只处理括号，**不处理字符串里的括号**：本仓库的 `index.ts` 在这些注册调用的
 * 实参里没有裸字符串字面量含 `(` / `)`（已人工核对）。若将来引入，本函数会
 * 偏早结束 ⇒ 判据**变红**（安全方向，不会静默放行），那时再加固即可。
 */
function matchParenEnd(code: string, openIndex: number): number {
  if (openIndex < 0) return -1
  let depth = 0
  for (let i = openIndex; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * 剥掉注释后的 `src/index.ts` 源码（接线判据用）。
 *
 * ⚠️ **必须剥注释**：否则一行「⚠️ 本该接 `providerClosed`」的注释就能让
 * 源码判据恒绿（本仓库实测过的诱饵形态）。
 */
function strippedIndexSource(): string {
  return readFileSync(REPO + 'src/index.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

describe('★★ IKP8OF：手写 listModels 的四家必须响应「供应商整体关闭」', () => {
  /**
   * ⚠️ 判据是「**真跑** `listModels` 并断言返回 `[]`」。
   *
   * 每家的前置依赖都不同（autoclaw 要凭据、modelscope 要槽位、opencode 要
   * 身份槽），故各自构造一个「**能正常返回非空目录**」的最小环境，然后
   * 只翻转 `providerClosed` 一个变量 —— 这样「返回 `[]`」只可能来自本判据，
   * 不会因为缺凭据/缺槽位而假绿（后者是**另一条**返回 `[]` 的路径）。
   */
  /**
   * ★★ **autoclaw**：2026-10-23 迁移后关闭意图由**共享骨架**提供。
   *
   * ⚠️ 迁移前本家手写 `listModels`、靠 `providerClosed` 选项回调判关闭；
   * 用户定稿「实体 provider 一律走共享骨架」后那个字段**已删除**，
   * 唯一入口是 `accountPool`。
   */
  it('★★ autoclaw：关闭意图由骨架从账号池读 ⇒ 关闭态下 listModels 为空', async () => {
    let closed = false
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      providerClosedFor: () => closed,
    } as never
    const make = (): AutoclawAdapter => new AutoclawAdapter({
      resolveCredential: async () => ({ accessToken: 'stub-token' }) as never,
      refresh: async () => {},
      product: AUTOCLAW,
      accountPool: pool,
      // ⚠️ 远端探测一律失败 ⇒ 目录回落到**兜底表**（确定性、无网络）。
      fetchRemoteModelMeta: async () => undefined,
    } as never)

    // 对照：未关闭时必须**有**模型（否则下面的空数组断言恒真）。
    const open = await make().listModels(AUTOCLAW.id)
    expect(open.length, '对照失败：未关闭时目录本就为空 ⇒ 本用例会假绿').toBeGreaterThan(0)

    closed = true
    const shut = await make().listModels(AUTOCLAW.id)
    expect(shut, '★★ 关闭态下 autoclaw 仍播出模型 ⇒ 新模型可选（IKP8OF）').toEqual([])
  })

  /**
   * ★★ **modelscope**：2026-10-23 迁移后关闭意图由**共享骨架**提供。
   *
   * ⚠️⚠️ 迁移前本家手写 `listModels`、靠 `providerClosed` **选项回调**判关闭；
   * 用户定稿「实体 provider 一律走共享骨架」后，那个回调字段**已删除**，
   * 唯一入口是 `accountPool`（骨架内部判 `providerClosedFor`）。
   * ⇒ 本用例的形态随之改成「池里报关闭」，语义断言不变。
   */
  it('★★ modelscope：关闭意图由骨架从账号池读 ⇒ 关闭态下 listModels 为空', async () => {
    let closed = false
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      providerClosedFor: () => closed,
    } as never
    const make = (): ModelscopeAdapter => new ModelscopeAdapter({
      slots: async () => [{ id: 'a1', apiKey: 'ms-0123456789abcdefghij' }],
      product: MODELSCOPE,
      accountPool: pool,
      // ⚠️ 不给 `fetchRemoteCatalog` ⇒ 走兜底表（确定性、无网络）。
    } as never)

    const open = await make().listModels(MODELSCOPE.id)
    expect(open.length, '对照失败：未关闭时目录本就为空 ⇒ 本用例会假绿').toBeGreaterThan(0)
    expect(MODELSCOPE_FALLBACK_MODELS.length).toBeGreaterThan(0)

    closed = true
    const shut = await make().listModels(MODELSCOPE.id)
    expect(shut, '★★ 关闭态下 modelscope 仍播出模型 ⇒ 新模型可选（IKP8OF）').toEqual([])
  })

  /**
   * ★★ **officeace 这一条是「补既有守卫缺口」**：实测把它的短路整行删掉，
   * 全量 9858 条单测**仍全绿** —— 该家的 `providerClosed` 零覆盖。
   *
   * 它的目录是**静态表**（`OFFICEACE_MODELS`），故只需给一个可读凭据即能
   * 返回非空目录，对照组的确定性最好。
   */
  it('★★ officeace：providerClosed 为真 ⇒ listModels 返回空（且对照：为假时有目录）', async () => {
    let closed = false
    const make = (): OfficeAceAdapter => new OfficeAceAdapter({
      // ⚠️ 目录专用凭据：给了它就不必再打任何上游（`/v2/models` 只在
      // `catalogAt === 0` 且新鲜度判据不通过时才会被探测；这里给它一个
      // 「已经新鲜过」的时钟，避免真实网络）。
      probeCredential: async () => ({ accessToken: 'stub' }) as never,
      now: () => 1_000_000,
      // ⚠️ 2026-10-23 迁移：黑名单/关闭意图的唯一入口是账号池（骨架读取）。
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        providerClosedFor: () => closed,
      } as never,
      // ⚠️ `catalogAt` 初值是 0 ⇒ **首次** `listModels` 必然先探一次 `/v2/models`
      //（探活失败且 `catalogAt === 0` 时会返回 `[]`，那是「未登录」的既有形态）。
      // 故这里必须让探活**成功**，否则对照组恒空、本用例假绿。
      fetchImpl: (async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as never,
      fetchModelTokenRates: async () => new Map(),
    } as never)

    expect(OFFICEACE_MODELS.length, '静态目录至少要两个模型，本用例才有对照可言')
      .toBeGreaterThan(0)

    // 对照：未关闭时必须**有**模型（否则下面的空数组断言恒真）。
    const open = await make().listModels(OFFICEACE.id)
    expect(open.length, '对照失败：未关闭时目录本就为空 ⇒ 本用例会假绿').toBeGreaterThan(0)

    closed = true
    const shut = await make().listModels(OFFICEACE.id)
    expect(shut, '★★ 关闭态下 officeace 仍播出模型 ⇒ 新模型可选（IKP8OF）').toEqual([])
  })

  /**
   * ★★ **聚合 provider**：它手写 `listModels`，且本文件原有 `maintainProviderClosedState`
   * 异步补写黑名单 —— 但那条路有**两个前置条件**（黑名单非空 + 覆盖上一次全量目录）
   * 且是 fire-and-forget（落盘失败只记 warn）⇒ 存在「补写落地之前」的窗口，
   * 窗口内新虚拟模型**可被选中**。意图判据没有这个窗口。
   */
  it('★★ aggregate：providerClosed 为真 ⇒ listModels 返回空（且对照：为假时有目录）', async () => {
    let closed = false
    const make = (): AggregateAdapter => new AggregateAdapter({
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }],
        listModels: async (provider: string) => (provider === 'buddy'
          ? [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }]
          : []),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never, {
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        providerClosedFor: () => closed,
        listAggregateRejections: () => ({}),
        listAvailableCredentials: async () => [
          { entry: { id: 'a1' }, credential: { access_token: 't' } },
        ],
        getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: { access_token: 't' } }),
      } as never,
      expiryProbe: async () => 100,
      rejections: () => ({}),
    } as never)

    const open = await make().listModels(AGGREGATE_PROVIDER)
    expect(open.length, '对照失败：未关闭时目录本就为空 ⇒ 本用例会假绿').toBeGreaterThan(0)

    closed = true
    const shut = await make().listModels(AGGREGATE_PROVIDER)
    expect(shut, '★★ 关闭态下 aggregate 仍播出虚拟模型 ⇒ 新模型可选（IKP8OF）').toEqual([])
  })

  /**
   * ★★ **opencode**：2026-10-23 迁移后关闭意图由**共享骨架**提供。
   *
   * ⚠️ 迁移前本家手写 `listModels`、靠 `providerClosed` 选项回调判关闭；
   * 用户定稿「实体 provider 一律走共享骨架」后那个字段**已删除**，
   * 唯一入口是 `accountPool`。⇒ 本用例形态随之改成「池里报关闭」。
   */
  it('★★ opencode：关闭意图由骨架从账号池读 ⇒ 关闭态下 listModels 为空', async () => {
    let closed = false
    const pool = {
      disabledModelsFor: () => new Set<string>(),
      providerClosedFor: () => closed,
    } as never
    const make = (): OpencodeAdapter => new OpencodeAdapter({
      identitySlots: async () => [{ id: 'a1', kind: 'account', apiKey: 'sk-stub' }],
      product: OPENCODE,
      accountPool: pool,
      markLimited: async () => {},
      warn: () => {},
      // ⚠️ 远端目录一律失败 ⇒ 回落到编译期兜底表（确定性、无网络）。
      fetchRemoteCatalog: async () => { throw new Error('offline') },
    } as never)

    const open = await make().listModels(OPENCODE.id)
    expect(open.length, '对照失败：未关闭时目录本就为空 ⇒ 本用例会假绿').toBeGreaterThan(0)

    closed = true
    const shut = await make().listModels(OPENCODE.id)
    expect(shut, '★★ 关闭态下 opencode 仍播出模型 ⇒ 新模型可选（IKP8OF）').toEqual([])
  })

  /**
   * ★ **接线判据**：四家的注册调用实参里必须有 `providerClosed`。
   *
   * ⚠️ 为什么必须有这一条（行为用例不够）：适配器侧「支持并实现」与接线层
   * 「真的传了」是**两件事**。本仓库实测过同型缺陷（modelscope 的
   * `disabledModels`：消费点完全正确、适配器自测全绿，只是 `index.ts` 漏了实参）
   * ⇒ 线上零过滤、零日志。行为用例测的是适配器，**测不到**接线。
   *
   * ⚠️ 判据锚定「注册调用 + 该调用块内出现 `providerClosed:`」，
   * 并**逐家点名**（不是数总数）—— 数总数会在「多接一家、漏接另一家」时配平。
   */
  /**
   * ★★ **每一处 `createModelCatalog(...)` 都必须传 `accountPool`**（派生式普查）。
   *
   * ## 为什么需要这条（真实缺陷）
   *
   * `astudio` 此前是**唯一**把 deps 传成 `{}` 的适配器 ⇒ 骨架里
   * `deps.accountPool?.disabledModelsFor(...)` 与 `providerClosedFor?.(...)`
   * 全部因 `?.` **静默跳过** ⇒ 该家「关闭模型」与「关闭供应商」双双无效，
   * 零报错零日志。与 modelscope 那次「接线层漏实参」逐字同型。
   *
   * ⚠️ **派生式而非点名**：扫全部调用点，而不是维护一份「哪几家要传」的名单
   *    （那份名单必然腐坏 —— 本仓库已有多次家数注释腐坏的事故）。
   * ⚠️ 判据锚定「`createModelCatalog(` 之后、下一个 `product:` 之前的实参块」，
   *    并要求其中出现 `accountPool`。剥注释后判定（防注释诱饵）。
   */
  it('★★ 每处 createModelCatalog 都必须传 accountPool（否则黑名单与关闭意图双双静默失效）', () => {
    // ⚠️⚠️ **本判据刻意在「原始源码」上做，不剥注释**：
    //    实测 `cline-adapter.ts` 剥注释后括号**不配对**（注释正文里有 `(` / `)`），
    //    `matchParenEnd` 返回 -1 ⇒ 判据失锚。而下面这个判据不需要括号配对 ——
    //    它只要求「`createModelCatalog(` 之后、**同一个调用**的 deps 段里出现
    //    `accountPool`」，用「到 `product:` 或 200 字符」当窗口即可。
    //
    // ⚠️ 注释诱饵的风险由**双向判据**兜住：既要求 deps 段里有 `accountPool:`，
    //    又要求它**不是**出现在 `//` 或 `*` 开头的注释行里。
    const files = readdirSync(REPO + 'src').filter((f) => f.endsWith('-adapter.ts'))
    const offenders: string[] = []
    for (const file of files) {
      const raw = readFileSync(REPO + 'src/' + file, 'utf8')
      let index = raw.indexOf('createModelCatalog(')
      while (index >= 0) {
        const after = raw.slice(index, index + 400)
        // deps 段 = 到 `product:`（第二个实参）或窗口结束。
        const productAt = after.indexOf('product:')
        const deps = productAt > 0 ? after.slice(0, productAt) : after
        // 逐行判：只要有一行**非注释**且含 `accountPool` 即算传了。
        const hasDeps = deps.split('\n').some((line) => {
          const trimmed = line.trim()
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false
          return trimmed.includes('accountPool')
        })
        if (!hasDeps) offenders.push(file)
        index = raw.indexOf('createModelCatalog(', index + 1)
      }
    }
    expect(
      offenders,
      '★★ 这些适配器的 createModelCatalog 没传 accountPool ⇒ 黑名单与「关闭供应商」对它们双双失效'
      + '（`?.` 让缺失变成静默 no-op，零报错零日志）',
    ).toEqual([])
  })

  /**
   * ★★ **账户池接线普查（派生式）**：每个「实体 provider」的注册实参里都必须有
   * **真 `accountPool`**。
   *
   * ## ⚠️⚠️ 2026-10-23：本用例**取代**了原来那张逐家点名的硬编码表
   *
   * 原表长这样（已删除）：
   *
   * ```ts
   * const targets = [
   *   { name: 'autoclaw（国内站）', register: /registerAutoclawLlm\(ctx, \{/g, … },
   *   { name: 'modelscope', … }, { name: 'officeace', … }, { name: 'opencode', … },
   * ]
   * ```
   *
   * 它有两个真实缺陷（都实测过）：
   * ① **新 provider 漏接是静默的** —— 往用户要求「实体 provider 一律走共享骨架」
   *    之后，手写实现已全部迁移，**不再有任何一家需要 `providerClosed` 回调**；
   *    而那张表若留着，加一家新 provider 时它不会自动进来，
   *    漏接 ⇒ 关闭态下模型照样可选（本 issue 的原症状）；
   * ② **判据失锚的报错极具误导性** —— 往表里加一个不存在的家，报的是
   *    「注册调用未找到（判据失锚）」而不是「你漏接了一家」，
   *    读起来像测试自己坏了。
   *
   * ## 现在的判据（派生式，不维护任何名单）
   *
   * 扫 `src/index.ts` 里**全部** `register*Llm(ctx, {` 调用点，对每一个：
   * - 它的 provider 必须是虚拟的（`auto` / `aggregate`）**或**
   * - 它的实参块里必须有 `accountPool: <真值>`（不是 `undefined` / `null`）。
   *
   * ⚠️ 「虚拟」的判据来自 `catalog-shared-skeleton.spec.ts` 的
   *    `VIRTUAL_PROVIDERS`（同一份豁免表，`auto` / `jet-hub-auto` / `aggregate`）。
   */
  it('★★ 每个实体 provider 的注册实参都必须带真 accountPool（派生式普查，不维护名单）', () => {
    const code = strippedIndexSource()
    const calls = [...code.matchAll(/register([A-Za-z]+)Llm\(ctx, \{/g)]
    expect(calls.length, '一个注册调用点都没找到 —— 判据失锚（源码形态变了？）')
      .toBeGreaterThanOrEqual(10)

    // ⚠️ 虚拟 provider：目录由别的 provider 推导，没有自己的上游，故不需要池。
    const VIRTUAL = new Set(['AUTO', 'AGGREGATE'])
    const offenders: string[] = []

    for (const match of calls) {
      const name = match[1] ?? ''
      if (VIRTUAL.has(name)) continue
      const from = match.index ?? 0
      // 实参块 = 从本次调用的 `{` 起到括号配对结束。
      const open = code.indexOf('{', from)
      let depth = 0
      let end = -1
      for (let i = open; i < code.length; i += 1) {
        const ch = code[i]
        if (ch === '{') depth += 1
        else if (ch === '}') {
          depth -= 1
          if (depth === 0) { end = i; break }
        }
      }
      if (end < 0) {
        offenders.push(`${name}: 实参块尾无法确定`)
        continue
      }
      const block = code.slice(open, end)
      const hasPool = /accountPool:\s*pool\b/.test(block)
      const bogus = /accountPool\s*:\s*(undefined|null)\b/.test(block)
      if (!hasPool || bogus) offenders.push(`register${name}Llm`)
    }

    expect(
      offenders,
      '★★ 这些注册调用没有 `accountPool: pool` ⇒ 它们的模型黑名单与「关闭供应商」'
      + '双双静默失效（`?.` 是 no-op，零报错零日志）。若是虚拟 provider，'
      + '请把它的注册名加进本用例的 VIRTUAL 集合（并说明理由）。',
    ).toEqual([])
  })

  /**
   * ★★ **跨实例（= 模拟重启）持久化守卫** —— 独立审计实测的**五处无牙**缺口。
   *
   * ## 为什么必须有这一组（真实事故形态）
   *
   * 审计把下面这些行**逐个删掉**，634 条用例**全绿**：
   *
   * | 变异 | 后果 |
   * |---|---|
   * | `queueStoreSave` 删 `providerClosed:` | 意图永不落盘 + 任何账号/黑名单写入都抹掉它 |
   * | `ensureLoaded` 删 `providerClosedCache = ...` | 冷启动读不到意图 |
   * | `replaceAll` 删 `providerClosedCache = {}` | 导入备份后意图残留 ⇒ 选择器恒空 |
   *
   * 根因：既有的 store 用例全都只测「**同一个** store 实例内 save → load」，
   * 而漏键的伤害恰恰在**跨实例 / 跨重启**。
   *
   * ⚠️ 判据必须用**真实的 `AccountPool`**（不是 store 替身）：漏键发生在
   * `AccountPool` 的快照构造与 `ensureLoaded`，用 store 替身测不到它们。
   */
  describe('★★ 关闭意图的跨实例持久化（漏键 = 重启后静默复发）', () => {
    /** 一个真实 settings 后端 + 真实 `AccountPool`；`stored` 就是"磁盘"。 */
    function makePool(stored: Record<string, unknown>): AccountPool {
      return new AccountPool({
        get: (key: string) => key === 'settings'
          ? {
              register: () => ({
                get: () => stored,
                replace: async (value: Record<string, unknown>) => {
                  // 整体替换语义：先清空再写入（与真实后端一致）。
                  for (const k of Object.keys(stored)) delete stored[k]
                  Object.assign(stored, value)
                },
              }),
            }
          : undefined,
        logger: { warn: () => {}, info: () => {} },
        credentials: {
          describe: async () => ({ configured: false, writable: true }),
          resolve: async () => undefined,
          set: async () => {},
          unset: async () => {},
        },
      } as never)
    }

    it('★★ 关闭意图必须写进磁盘（抓 `queueStoreSave` 漏键）', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = makePool(stored)
      await pool.setProviderClosed('cline', true)
      expect(
        stored.providerClosed,
        '★ `queueStoreSave` 漏键 ⇒ 意图永不落盘（删掉那一行后 634 条用例仍全绿）',
      ).toEqual({ cline: true })
    })

    it('★★ 新实例（= 重启）必须读回关闭意图（抓 `ensureLoaded` 漏键）', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      await makePool(stored).setProviderClosed('cline', true)
      const restarted = makePool(stored)
      expect(
        restarted.providerClosedFor('cline'),
        '★ `ensureLoaded` 漏键 ⇒ 重启后意图丢失 ⇒ 目录一变长就翻回「已打开」',
      ).toBe(true)
    })

    it('★★ 改账号 / 改黑名单不得抹掉关闭意图（整体替换语义的经典漏键）', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = makePool(stored)
      await pool.setProviderClosed('cline', true)
      // 任何一次「别处」的写入都不该把意图抹掉（`replace` 是整体替换）。
      await pool.setModelsDisabled('buddy', ['some-model'])
      expect((stored as { providerClosed?: unknown }).providerClosed).toEqual({ cline: true })
      await pool.setModelDisabled('buddy', 'another', true)
      expect((stored as { providerClosed?: unknown }).providerClosed).toEqual({ cline: true })
    })

    it('★★ 导入备份（replaceAll）必须清空关闭意图（抓 `replaceAll` 漏重置）', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = makePool(stored)
      await pool.setProviderClosed('cline', true)
      // 备份载荷不含意图（`getStateSnapshot` 也不导出它）⇒ 导入后必须回落派生判据。
      await pool.replaceAll([], {})
      expect(
        pool.providerClosedFor('cline'),
        '★ `replaceAll` 漏重置 ⇒ 导入一份「已打开」的备份后选择器恒空（危险方向）',
      ).toBe(false)
    })

    /**
     * ★★ **三个「打开」入口都必须清意图**（独立审计实测：其中两个是唯一清点）。
     *
     * ## 为什么必须逐入口测（不能只测一条）
     *
     * 审计把下面两行**逐个删掉**，634 条用例**全绿**：
     * - `clearModelsDisabled` 末尾的 `clearProviderClosed` ⇒ 「本组全开」变成死操作；
     * - `clearDisabledModels` 末尾的 `clearProviderClosed` ⇒
     *   **`model.setAllDisabled(false)`（设置页「打开全部」）变成死操作**
     *   （那条路径只调它，`provider.setEnabled(true)` 另有显式再调，所以只有它会中）。
     *
     * ⇒ 三条路径各一条用例，缺一条就漏一个入口。
     */
    it('★★ 「本组全开」（clearModelsDisabled）必须清意图 —— 且要覆盖「新模型不在黑名单」', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = makePool(stored)
      // 真实形态：关闭时只写**当时目录**的 id；目录随后变长 ⇒ 新模型不在黑名单里。
      await pool.setModelsDisabled('cline', ['old-1', 'old-2'])
      await pool.setProviderClosed('cline', true)
      // 用户对「只含新模型的分组」点「本组全开」⇒ 一个键都删不掉。
      await pool.clearModelsDisabled('cline', ['late-model'])
      expect(
        pool.providerClosedFor('cline'),
        '★ 本组全开没清意图 ⇒ 点击变成死操作（模型列表纹丝不动、零报错）',
      ).toBe(false)
    })

    /**
     * ★★ **`clearModelsDisabled` 的 `changed === true` 分支**（真正删到了键）。
     *
     * ⚠️ 这一条与上面那条**刻意分开**：上面测的是「一个键都删不掉」（`!changed`），
     * 本条测「真的删掉了」（`changed === true`）。两条早退/收尾分支各有一条清意图，
     * 漏任一条都是一个死操作入口（独立审计实测：只测前者时，删掉后者仍全绿）。
     */
    it('★★ 「本组全开」真的删到键时（changed=true）也必须清意图', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = makePool(stored)
      // 关闭时写入了 old-1/old-2；用户在设置页把这两条打开 ⇒ 真的会删到键。
      await pool.setModelsDisabled('cline', ['old-1', 'old-2'])
      await pool.setProviderClosed('cline', true)
      await pool.clearModelsDisabled('cline', ['old-1', 'old-2'])
      expect(pool.providerClosedFor('cline'), '★ changed 分支没清意图 ⇒ 用户永远打不开它')
        .toBe(false)
      // 且黑名单确实被清空了（确认这一轮真的走了 changed 分支）。
      expect(pool.listDisabledModels('cline')).toEqual({})
    })

    it('★★ 「打开全部」（clearDisabledModels）必须清意图（`model.setAllDisabled(false)` 唯一清点）', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = makePool(stored)
      await pool.setModelsDisabled('cline', ['old-1'])
      await pool.setProviderClosed('cline', true)
      await pool.clearDisabledModels('cline')
      expect(
        pool.providerClosedFor('cline'),
        '★ 打开全部没清意图 ⇒ 设置页「打开全部」变成死操作',
      ).toBe(false)
    })

    /** ★ 第三种形态：黑名单**本就为空**（`clearModelsDisabled` 的另一条早退分支）。 */
    it('★★ 黑名单里没有该 provider 时，「本组全开」也必须清意图（第二条早退分支）', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = makePool(stored)
      // 只有意图、没有黑名单（真实可达：关闭后用户已把黑名单逐条清掉）。
      await pool.setProviderClosed('cline', true)
      await pool.clearModelsDisabled('cline', ['anything'])
      expect(
        pool.providerClosedFor('cline'),
        '★ 第二条早退分支没清意图 ⇒ 用户永远打不开它',
      ).toBe(false)
    })

    /**
     * ★★ **「关闭全部模型」（`model.setAllDisabled(true)`）也必须落意图**
     *（对抗审计打穿：这是同一症状的**第二个入口**）。
     *
     * 判据是**语义同构**：「逐条关光 ⇒ 算已关闭」已被列为必须保留的既有语义
     * （派生腿 + 反向用例）。那么「一次性关光全部」是它的批量形态，同样必须抗
     * 目录增长 —— 否则点「关闭全部模型」后目录一变长就翻回「已打开」且新模型可选，
     * 而点「关闭供应商」不会 ⇒ **两个按钮给出不同的持久语义**，且无任何提示。
     */
    it('★★ 「关闭全部模型」也必须落关闭意图（否则目录一变长就翻回已打开）', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = makePool(stored)
      // 复刻 `model.setAllDisabled(true)` 的服务端动作。
      await pool.writeModelsWithProviderClosed('cline', ['m0', 'm1'], true)
      expect(
        pool.providerClosedFor('cline'),
        '★ 关闭全部模型没落意图 ⇒ 目录变长后翻回「已打开」（IKP8OF 第二入口）',
      ).toBe(true)
      expect((stored as { providerClosed?: unknown }).providerClosed).toEqual({ cline: true })
    })

    /**
     * ⚠️⚠️⚠️ 2026-11-04 真机报障：「**更新插件后停用的供应商会被启用**」。
     *
     * 上面的用例只覆盖 `true`（写意图）。而同一个方法的第三参传 `false` 时
     * 实现是 **`delete providerClosed[provider]`** —— 于是「模型列表屏全关」
     * （本意「不碰供应商开关」）会**删掉**用户先前用「关闭供应商」设好的意图：
     *
     * ```
     * ① 关闭供应商 ⇒ providerClosed={X:true}   ← 与目录无关，本来稳定
     * ② 模型列表屏点「全关」 ⇒ 传 false ⇒ 意图被删
     * ③ 更新 / 目录变长 ⇒ 派生判据失配 ⇒ 翻回「启用」
     * ```
     *
     * ⇒ 必须提供 `'keep'` 态：**既不加也不删**。
     */
    it('★★★ 第三参传 keep 时不得改动关闭意图（模型级全关专用）', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = makePool(stored)
      // 先进入「关闭供应商」态。
      await pool.writeModelsWithProviderClosed('cline', ['m0'], true)
      expect(pool.providerClosedFor('cline')).toBe(true)

      // 模型级全关：追加黑名单，但**不动**意图。
      await pool.writeModelsWithProviderClosed('cline', ['m1'], 'keep')

      expect(
        pool.providerClosedFor('cline'),
        '★★★ keep 把关闭意图删了 ⇒ 用户点过「关闭供应商」的会随更新静默变回启用',
      ).toBe(true)
      expect((stored as { providerClosed?: unknown }).providerClosed).toEqual({ cline: true })
      // 黑名单确实追加（`keep` 只影响意图，不影响黑名单）。
      expect(pool.listDisabledModels('cline')).toEqual({ m0: true, m1: true })

      // ⚠️⚠️ **必须另测「本来没有意图」的 provider**：只在「已有意图」上断言
      // `=== true` 时，把实现改成「`keep` 恒写 true」也全绿（实测 M3 无牙）。
      // 这一格才让 `keep` 的「**不动**」与「写 true」分开。
      await pool.writeModelsWithProviderClosed('cline-unused', ['m9'], 'keep')
      expect(
        pool.providerClosedFor('cline-unused'),
        '★★★ keep 不得凭空写入关闭意图（否则等于把整家关掉）',
      ).toBe(false)
    })

    /**
     * 反向对照：`false` 仍是「**删除**意图」（既有语义，`provider.setEnabled(true)`
     * 依赖它）。没有这条，把 `false` 与 `'keep'` 合并成一个分支也能全绿。
     */
    it('★★ 第三参传 false 仍必须删除关闭意图（无生产调用方；保留三态语义完整性）', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = makePool(stored)
      await pool.writeModelsWithProviderClosed('cline', ['m0'], true)

      await pool.writeModelsWithProviderClosed('cline', [], false)

      expect(pool.providerClosedFor('cline')).toBe(false)
      expect((stored as { providerClosed?: unknown }).providerClosed).toEqual({})
    })

    /**
     * ★★ **「打开供应商」必须一次落盘**（对抗审计打穿：打开方向漏了合并）。
     *
     * 原先走两步（`clearDisabledModels` save #1 → `setProviderClosed(false)` save #2），
     * 两次之间磁盘是「黑名单空 + 意图真」⇒ 第二次失败则**重启后选择器恒空**。
     * 而这条**恰好是最常见的路径**（黑名单非空 = 用户真关过东西、现在要打开）。
     */
    it('★★ 「打开供应商」必须一次落盘（不得留下「黑名单空 + 意图真」的半套）', async () => {
      let saves = 0
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = new AccountPool({
        get: (key: string) => key === 'settings'
          ? {
              register: () => ({
                get: () => stored,
                replace: async (value: Record<string, unknown>) => {
                  saves += 1
                  for (const k of Object.keys(stored)) delete stored[k]
                  Object.assign(stored, value)
                },
              }),
            }
          : undefined,
        logger: { warn: () => {}, info: () => {} },
        credentials: {
          describe: async () => ({ configured: false, writable: true }),
          resolve: async () => undefined,
          set: async () => {},
          unset: async () => {},
        },
      } as never)
      // 先进入「已关闭」态（黑名单非空 + 意图真）—— 这是打开方向最常见的起点。
      await pool.writeModelsWithProviderClosed('cline', ['m0', 'm1'], true)
      saves = 0
      await pool.clearModelsWithProviderClosed('cline')
      expect(
        saves,
        '★★ 打开供应商落了 2 次盘 ⇒ 中间态是「黑名单空 + 意图真」⇒ 崩溃后重启选择器恒空',
      ).toBe(1)
      expect(pool.providerClosedFor('cline')).toBe(false)
      expect(pool.listDisabledModels('cline')).toEqual({})
      // ⚠️ 落盘里是 `{}` 而不是缺键：`queueStoreSave` 的快照**总是**携带该键
      //（整体替换语义下「不写」等于「抹掉」，见那份快照的注释）。两者语义相同。
      expect((stored as { providerClosed?: unknown }).providerClosed).toEqual({})
    })

    /** ★ 反向：导入备份**后**的写入仍必须正常携带意图（不能因重置逻辑而永久失效）。 */
    it('★ 反向：导入备份后仍能正常写入并读回意图', async () => {
      const stored: Record<string, unknown> = { accounts: [] }
      const pool = makePool(stored)
      await pool.replaceAll([], {})
      await pool.setProviderClosed('cline', true)
      expect(pool.providerClosedFor('cline')).toBe(true)
      expect((stored as { providerClosed?: unknown }).providerClosed).toEqual({ cline: true })
    })
  })
})
