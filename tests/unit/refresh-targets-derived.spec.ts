/**
 * `wiredRefreshTargets()`：批量续期表**从能力注册表派生**（Task 10）。
 *
 * ## 本文件守什么
 *
 * 原先 `src/index.ts` 手抄 **13 行** provider 清单。它的失效形态极隐蔽：
 * **漏一家 ⇒ 该家凭据永不自动续期**，而症状只是「每隔一段时间就要重新登录」，
 * **日志里一个字都没有**（`src/index.ts` 的注释记录了这一点）。
 *
 * ⚠️ 判据是**行为**（驱动派生函数），**不读源码文本** —— 初稿用
 * `readFileSync` + 正则扫那 13 行字面量，已被 pre-flight 纠正。
 *
 * ## `modelAdapters` 的键集合：为什么还留一条源码文本断言
 *
 * `modelAdapters` 是 `apply()` 内的**局部变量**（值是适配器实例，注册表里放的是
 * auth 实例，故 plan Task 10 Step 6 明确要求**保留该字面量**）。它的键集合守卫有两条：
 *
 * 1. 用例 ⑦（**源码文本**，剥注释后提键）—— 唯一能捕捉**多余键**的手段：
 *    `EXTRA_KEYS` 之外多一个键，行为侧无从察觉（`provider.status` 只会多返回一行）；
 * 2. 用例 ⑧（**行为**，真跑 `apply()` 后驱动 `provider.status`）—— 捕捉**漏键**，
 *    且失败信息直接指向是哪个 id 取不到目录。
 *
 * ⇒ 这是本 PR 刻意保留的**一处**源码文本断言：它守的方向（多余的键）**没有**
 * 行为等价物。Task 11-B 清理的是「有行为等价物却仍读源码」的那些，不是这一类。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { Context } from '@deepseek-ai/cordis'

import { apply } from '../../src/index.js'
import { JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import { descriptorOf, PROVIDER_REGISTRY } from '../../src/provider-registry.js'
import {
  clearProviderRuntimes,
  registerProviderRuntime,
  wiredRefreshTargets,
} from '../../src/provider-runtime.js'

afterEach(() => { clearProviderRuntimes() })

/** 造一个带 `refreshAll` 的最小 auth 桩。 */
function authWith(refreshAll: () => Promise<void>) {
  return { refreshAccount: vi.fn(), refreshAll }
}

describe('wiredRefreshTargets：从注册表派生', () => {
  it('① 只收**有 `auth.refreshAll`** 的 provider', () => {
    registerProviderRuntime({
      descriptor: descriptorOf('buddy')!,
      auth: authWith(async () => {}),
    })
    // ⚠️ opencode 无 auth 域（它没有续期概念）⇒ 不该进表。
    registerProviderRuntime({ descriptor: descriptorOf('opencode')! })

    expect(wiredRefreshTargets().map(([id]) => id)).toEqual(['buddy'])
  })

  it('② 派生的条目**真的调用**该 provider 的 refreshAll（转发不错位）', async () => {
    const buddyRefreshAll = vi.fn(async () => {})
    const workbuddyRefreshAll = vi.fn(async () => {})
    registerProviderRuntime({
      descriptor: descriptorOf('buddy')!,
      auth: authWith(buddyRefreshAll),
    })
    registerProviderRuntime({
      descriptor: descriptorOf('workbuddy')!,
      auth: authWith(workbuddyRefreshAll),
    })

    for (const [, refreshAll] of wiredRefreshTargets()) await refreshAll({} as never)

    // ⚠️ 这条锁「按 id 取到**对应实例**」—— 若派生时把两个实例搞混，
    //    两个 provider 的凭据会互相刷（而签名相同、类型检查抓不到）。
    expect(buddyRefreshAll).toHaveBeenCalledTimes(1)
    expect(workbuddyRefreshAll).toHaveBeenCalledTimes(1)
  })

  it('③ `this` 绑定正确（各家 refreshAll 是类方法，内部用 this.product / this.ctx）', async () => {
    // ⚠️ **真实陷阱**：直接把 `rt.auth.refreshAll` 当函数引用传出去会丢 `this`
    //    ⇒ 调用即抛 `Cannot read properties of undefined`。
    //    本用例用一个**依赖 `this`** 的桩来钉住它。
    const calls: string[] = []
    const auth = {
      refreshAccount: vi.fn(),
      product: { id: 'buddy' },
      async refreshAll() {
        calls.push(this.product.id)
      },
    }
    registerProviderRuntime({ descriptor: descriptorOf('buddy')!, auth: auth as never })

    for (const [, refreshAll] of wiredRefreshTargets()) await refreshAll({} as never)

    expect(calls).toEqual(['buddy'])
  })

  it('④ 空注册表 ⇒ 空表（**不是抛错**）', () => {
    expect(wiredRefreshTargets()).toEqual([])
  })

  it('⑤ 只注册了别的域（无 auth）⇒ 不进表', () => {
    registerProviderRuntime({
      descriptor: descriptorOf('zcode')!,
      expiry: { credentialExpiry: async () => 1 },
    })
    expect(wiredRefreshTargets()).toEqual([])
  })

  it('⑥ 有 auth 但**无 `refreshAll`** ⇒ 不进表（不能因为「有 auth」就放行）', () => {
    registerProviderRuntime({
      descriptor: descriptorOf('buddy')!,
      auth: { refreshAccount: vi.fn() },
    })
    expect(wiredRefreshTargets()).toEqual([])
  })
})

describe('modelAdapters 的键集合守卫（行为断言）', () => {
  it('⑦ registry 的 channel 集合 == `index.ts` 里 modelAdapters 的键集合', () => {
    // ⚠️ **2026-10-08 独立复审重写本条**。原版是**恒真**的：
    //
    //     for (const id of channelIds) {
    //       if (runtimeOf(id) !== undefined) continue
    //       registerProviderRuntime({ descriptor: descriptorOf(id)! })   // ← 自己注册
    //     }
    //     const runtimeChannels = registeredRuntimeIds()...                 // ← 再自断言
    //     expect(runtimeChannels).toEqual(channelIds)                       // ← 恒成立
    //
    //  用例自己把缺的都补上再比对，断言的是「我刚注册的东西」，与 `index.ts` 的
    //  `modelAdapters` **毫无关系** —— 漏一个键它照样绿。这是本仓库最重的一条红线
    //  （同义反复 / 恒真用例比没有更糟：它看起来像个守卫）。
    //
    // ## 改成什么
    //
    // `modelAdapters` 是 `apply()` 内的**局部变量**，单测取不到实例，但它的
    // **键**在源码里是逐行字面量（每行 `key: pruned(...)`）⇒ 可以**剥注释后**
    // 精确提取，与 registry 的 channel 集合**双向**比对。
    // ⚠️ 必须剥注释：本文件上方那段很长的注释里**逐字出现** `aggregate:` 形态。
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    const start = source.indexOf('const modelAdapters')
    expect(start, 'index.ts 里找不到 modelAdapters 定义').toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n  }', start))
    // 顶层键：四空格缩进 + `id:`（值是 `pruned(...)` 或任意表达式）。
    const keys = [...body.matchAll(/^ {4}([a-z][a-z0-9]*):/gm)].map((m) => m[1]).sort()
    expect(keys.length, 'modelAdapters 提取到的键太少，说明提取正则与源码形态脱节了')
      .toBeGreaterThanOrEqual(13)

    const channelIds = PROVIDER_REGISTRY.filter((d) => d.channel).map((d) => d.id).sort()
    // ⚠️ **`aggregate` 是登记在案的例外**（实测 `channel: false` 只有它一家）：
    //    它必须进本表，理由与别家**相反** —— 别的家进表是为了「关闭时把模型写进
    //    黑名单」，而聚合层**明确不参与**该机制（`pruned(..., { enabled: false })`，
    //    见 `index.ts` 那段长注释 §5.2）。它进表是为了 `fullCatalogIds` 能拿到
    //    **不套黑名单**的全量目录；漏了它会让「关闭整个聚合 provider」时
    //    只拿到未被关闭的 id。⇒ 它**不该**被当成「多余的键」删掉。
    //
    // ⚠️ **`codely` 是第二家**（2026-10-20）：`channel: false` 但**必须**进表
    //    —— `provider.status` 的「模型数 / 已关闭」读本表的 `listAllModels()`，
    //    且「关闭整个 provider」靠它拿全量目录写黑名单；缺它 ⇒ 面板恒「模型 0」、
    //    模型选择器里的 8 个真实模型**关不掉**（矛盾态，同 modelscope 那条注释）。
    //    与 `aggregate` 的例外**同族**：进表 ≠ 有 auth / 有推理 —— 它的适配器是
    //    真实的（目录来自实测 200 的 `/api/model-status`，`stream()` 显式报
    //    「推理通道尚未接通」），而 `channel: true` 会把「应有 auth / 应进聚合 /
    //    应可续期」三张守卫一起点燃，在推理与续期落地前那才是真要假桩的地方。
    // ⚠️ 2026-10-22（A6）：codely **已翻 `channel: true`** ⇒ 它由 `channelIds` 覆盖，
    //    不得再留在例外名单里（下面的反向断言会直接变红）。
    const EXTRA_KEYS = ['aggregate']
    const expected = [...channelIds, ...EXTRA_KEYS].sort()
    expect(
      keys,
      'modelAdapters 的键与期望集合不一致：'
      + '左侧多出 = 表里多了个未登记的键（若是新例外，请连同理由加进 EXTRA_KEYS，'
      + '别默默放过），'
      + '右侧多出 = **漏键**（该 provider 的「显示列表」拿不到全量目录 ⇒ '
      + '关闭它时模型不会被写进黑名单，出现「provider 已关闭、模型仍可选」的矛盾态）',
    ).toEqual(expected)

    // ⚠️ 反向：`EXTRA_KEYS` 里的每一个都必须**确实不是** channel —— 否则它该由
    //    channel 集合覆盖，留在例外名单里会让「漏键」被例外掩盖。
    for (const id of EXTRA_KEYS) {
      expect(
        descriptorOf(id)?.channel,
        `${id} 在 EXTRA_KEYS 里却有 channel: true —— 应从例外名单删掉`,
      ).not.toBe(true)
    }
  })

  /**
   * ⑧ **行为断言**：真跑一次 `apply()`，再从 `provider.status` 侧确认
   * **registry 里每个 channel 都能取到自己的目录**。
   *
   * ## 为什么在 ⑦ 之外还要这一条
   *
   * ⑦ 是**源码文本**断言（剥注释后从 `src/index.ts` 提键）。它能捕捉「多余的键」，
   * 但**读的是文本而不是行为** —— 一旦 `modelAdapters` 的写法换成别的形态
   * （改名、改成派生、把 `pruned(...)` 换成变量），⑦ 会**假失败**，
   * 而那正是本仓库花了一整个 Task 11-B 在清理的形态。
   *
   * 本用例走**公开路径**：`apply()` → RPC 端点 → `provider.status`
   * （该端点内部读 `modelAdapters[provider].listAllModels()`）。失败信息直接指向
   * 是哪个 id 拿不到目录，**与实现写法无关**。
   *
   * ⚠️ **漏键的真实症状**（`provider.status` 的 `closed` 判据是
   * `total > 0 && disabled === total`）：漏键 ⇒ `total` 恒为 0 ⇒ `closed` 恒 false
   * ⇒ 用户在设置页关掉整个 provider 后，它**显示为未关闭**，且模型仍可选。
   *
   * ⚠️ 本用例**刻意不**断言具体目录条数：那是各家上游的快照，会随目录更新腐坏
   * （本仓库已有多次「注释里的条数腐坏」教训）。这里只断言**非空**。
   */
  it('⑧ 真跑 `apply()` 后，registry 的每个 channel 都能从 `provider.status` 取到目录', async () => {
    clearProviderRuntimes()
    const ctx = new Context()
    ctx.provide('credentials', {
      resolve: async () => undefined,
      describe: async () => ({ configured: false, writable: true }),
      set: async () => {},
      unset: async () => {},
    } as never)
    ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
    ctx.provide('llm', {
      registerConfigurableProviders: () => ({ replace() {} }),
      registerAdapter: () => ({ replace() {} }),
      listModels: async () => [],
    } as never)
    // ⚠️ 桩要带 `register`：`createJetHubStore` 据此选 `SettingsStore` 老契约后端，
    //    读的是 `scope.get()` 的内存对象（同 `jet-hub-rpc-auth-wiring.spec.ts`）。
    const state = { value: { accounts: [], disabledModels: {} } }
    ctx.provide('settings', {
      register() { return { get: () => state.value, replace: (v: unknown) => { state.value = v } } },
      describe() { return [] },
    } as never)
    let handler: ((req: Request) => Promise<Response>) | undefined
    ctx.provide('connection', {
      fetch: {
        register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
          if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
        },
      },
    } as never)

    apply(ctx)
    // ⚠️ `registerJetHubRpc` 用 `ctx.inject(['connection'], …)` 惰性注册端点，
    //    cordis 在**微任务**里才解析依赖 ⇒ 不让出一轮，`handler` 仍是 undefined。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handler, 'jet-hub RPC 端点未注册').toBeDefined()

    const channelIds = PROVIDER_REGISTRY.filter((d) => d.channel).map((d) => d.id).sort()
    const res = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r-status',
        method: 'jet-hub',
        payload: { method: 'provider.status', payload: { providers: channelIds } },
      }),
    }))
    const body = await res.json() as {
      result: { ok: boolean; value: { statuses: Record<string, { models: { total: number } }> } }
    }

    expect(body.result.ok, `provider.status 失败：${JSON.stringify(body.result)}`).toBe(true)
    /**
     * ⚠️ **目录完全按账号下发的两家**（AgnesCode 两站，2026-11-19）不计入本判据。
     *
     * 这条守的是「关掉整个 provider 时拿不到全量目录 ⇒ 显示未关闭、模型仍可选」。
     * 而 AgnesCode 的 `GET {apiRoot}/v2/models` 是**账号级**端点（没有账号就
     * 403；目录里也没有任何东西可关），且本仓红线禁止编静态兜底表
     *（「静态兜底表必然腐坏」，本家的目录/价格都是每账号下发的）
     * ⇒ 本用例在**没有账号**的桩环境里必然读到 `total = 0`，而那个 0 是**事实**：
     * 此刻它确实一个模型都没有，不存在「可选却关不掉」的模型。
     *
     * ⚠️ 已知代价（如实登记）：**已登录**账号在首轮 `apply()` 之后、后台目录预热
     *    完成之前的极短窗口里，`provider.status` 也可能读到 0。那是「预热还没回来」，
     *    不是「目录为空」；根因是 `listAllModels()` 必须同步（minimax 的已知约束），
     *    而本家没有静态表可回落。根治需要宿主提供「目录预热完成」事件 —— 属接口
     *    扩张，不在本 PR 范围。
     */
    const NO_ACCOUNT_SCOPED_CATALOG = new Set(['agnescode', 'agnescodeintl'])
    const missing = channelIds
      .filter((id) => !NO_ACCOUNT_SCOPED_CATALOG.has(id))
      .filter((id) => (body.result.value.statuses[id]?.models.total ?? 0) === 0)
    expect(
      missing,
      '`modelAdapters` 漏了这些 channel 的键（它们的目录取不到 ⇒ provider.status 报 total=0 '
      + '⇒ 用户在设置页关闭整个 provider 后它显示为「未关闭」且模型仍可选）：'
      + missing.join(', '),
    ).toEqual([])
  })

  /**
   * ⑨ **codely 是 `channel: false` 却进表的例外** —— 用例 ⑧ 遍历的是
   * `channel` 集合，**覆盖不到它**，而它恰恰出过真实报障：
   *
   * > 用户 2026-10-20：「为啥供应商还是没显示有模型？」
   *
   * 根因是本表缺 `codely` 键 ⇒ `provider.status` 的 `models.total` 恒 0 ⇒
   * 设置页显示「模型 0（已关 0）」，且**模型选择器里那 8 个真实模型关不掉**
   * （「关闭整个 provider」拿不到全量目录去写黑名单）。
   *
   * ⚠️ 为什么单独一条而不是并进 ⑧：它俩的**期望集来源不同**（⑧ 是
   * `channel` 集合、本条是 `EXTRA_KEYS` 例外），塞进同一个数组会把两件
   * 语义不同的事混成一条断言 —— 失败时无法区分是「channel 漏键」还是
   * 「例外又漏了」。
   *
   * ⚠️ 与 ⑧ 同样**刻意不**断言具体条数（目录会随上游更新腐坏），只断言非空。
   */
  it('⑨ codely（channel:false 的进表例外）也要能从 provider.status 取到目录', async () => {
    clearProviderRuntimes()
    const ctx = new Context()
    ctx.provide('credentials', {
      resolve: async () => undefined,
      describe: async () => ({ configured: false, writable: true }),
      set: async () => {},
      unset: async () => {},
    } as never)
    ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
    ctx.provide('llm', {
      registerConfigurableProviders: () => ({ replace() {} }),
      registerAdapter: () => ({ replace() {} }),
      listModels: async () => [],
    } as never)
    const state = { value: { accounts: [], disabledModels: {} } }
    ctx.provide('settings', {
      register() { return { get: () => state.value, replace: (v: unknown) => { state.value = v } } },
      describe() { return [] },
    } as never)
    let handler: ((req: Request) => Promise<Response>) | undefined
    ctx.provide('connection', {
      fetch: {
        register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
          if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
        },
      },
    } as never)

    apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handler, 'jet-hub RPC 端点未注册').toBeDefined()

    const res = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r-status-codely',
        method: 'jet-hub',
        payload: { method: 'provider.status', payload: { providers: ['codely'] } },
      }),
    }))
    const body = await res.json() as {
      result: { ok: boolean; value: { statuses: Record<string, { models: { total: number } }> } }
    }
    expect(body.result.ok, `provider.status 失败：${JSON.stringify(body.result)}`).toBe(true)
    // ⚠️ 无凭据桩（`credentials.resolve` 恒 undefined）⇒ 适配器走**兜底表**
    //    （远端 `/api/model-status` 读不到时那份 8 条静态目录）⇒ 总数仍应 > 0。
    expect(
      body.result.value.statuses.codely?.models.total ?? 0,
      'modelAdapters 缺 codely 键 ⇒ 设置页「模型 0（已关 0）」且模型关不掉',
    ).toBeGreaterThan(0)
  })
})
