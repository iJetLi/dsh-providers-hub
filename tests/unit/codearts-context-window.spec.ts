/**
 * CodeArts 的**上下文占用条**分母（`context.contextWindow`）守卫（2026-10-21 真实报障）。
 *
 * ## 报障原文
 *
 * 「codearts 对话后，DSH 下方本该显示上下文窗口占用比的地方没有显示」，
 * 复现模型是 `glm-5.3`。
 *
 * ## 判据链（宿主侧，**不在本仓**）
 *
 * 1. `dsh-client-ui-conversation/lib/client.js` 的 `contextOccupancy()`：
 *
 *    ```js
 *    const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
 *    if (usedTokens === void 0 || pressure?.contextWindow === void 0) return null
 *    ```
 *
 *    而 `ContextMeter` 在 `context === null` 时 **`return null`** ⇒
 *    环 + 百分比 + 弹层**整条不渲染**（不是显示 0%，是**根本不出现**）。
 * 2. 分母来自 `dsh-agent-loop` 写的 `request/context` 事件，值即适配器
 *    `resolveModel()` 返回的 `context.contextWindow`；
 * 3. 分子（`pressureTokens`）由 token-meter 从 `assistant/message.usage` 算
 *    （`inputTokens + cacheReadTokens + cacheWriteTokens`）—— **本家这条腿一直是好的**
 *    （实测 glm-5.3 上报 `inputTokens:37482, cacheReadTokens:448`）。
 *
 * ⇒ **本家唯一能出错的就是分母**。故本文件的判据全部打在「分母恒有值」上。
 *
 * ## 为什么这个文件必须存在（合并前的实测）
 *
 * 修前全仓 `llm-adapter.spec.ts` 112 条 + `codearts-rate-display.spec.ts` 7 条
 * **全绿**，却漏掉了这个用户可见缺陷 —— 因为**没有任何一条断言「目录里每个
 * 可见条目都带窗口」**：旧用例只逐个点名了几个**表里有的**模型，缺窗口的
 * （`glm-5.3` / `openpangu-*` / `glm-5.2-sft-harmony`）**一条都没被问到**。
 *
 * ## 三条守卫各自的「有牙」判据
 *
 * | 守卫 | 若把生产代码改回缺陷态 | 为什么有牙 |
 * |---|---|---|
 * | ① 目录逐条都有正数窗口 | `contextWindow` 改回 `...cond ? {...} : {}` ⇒ 缺键 ⇒ 红 | **遍历目录**（不是点名），并断言 `Number.isInteger && > 0` |
 * | ② `resolveModel` 逐条都有窗口 | 同上（走的是同一份 `CatalogEntry`） | 对**目录里每一个 id** 调 `resolveModel` 比对 |
 * | ③ 未知 id 也有窗口 | 兜底删掉 ⇒ 手填模型无占用条 | 传一个**确定不在表里**的 id，断言等于兜底常量 |
 */
import { describe, expect, it } from 'vitest'
import {
  CODEARTS_FALLBACK_CONTEXT_WINDOW,
  CodeArtsAdapter,
  codeartsContextWindow,
  DEFAULT_MODELS as DEFAULT_MODELS_FOR_TEST,
} from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/**
 * 造适配器。`remote` 为 `undefined` ⇒ 远端拉取失败 ⇒ 走**静态兜底表**
 * （`DEFAULT_MODELS`），这也是首次启动 / 未登录时的真实形态。
 */
function makeAdapter(remote?: Array<{ id: string; name: string; contextWindow?: number; windowOnly?: boolean }>) {
  return new CodeArtsAdapter({
    credentialRef: 'CODEARTS_ACCESS_TOKEN',
    resolveCredential: async () => validCredential,
    refresh: async () => {},
    fetchImpl: async () => new Response('not found', { status: 404 }),
    ...remote === undefined ? { fetchRemoteModels: async () => { throw new Error('offline') } } : { fetchRemoteModels: async () => remote },
  })
}

/** 断言一个窗口值是**可用的分母**（DSH 侧要求正整数，否则抛 INVALID_MODEL_CONTEXT）。 */
function expectUsableWindow(value: unknown, label: string): void {
  // ⚠️ 参数顺序是 (actual, expected)：把说明串放**第二个**，失败时才会打印出
  //    「是哪个模型、拿到了什么值」—— 写反了只会打印 `true`，定位不到模型。
  expect(Number.isInteger(value) && (value as number) > 0, `${label} 的 contextWindow 必须是正整数，实际=${String(value)}`).toBe(true)
}

describe('上下文占用条的分母（contextWindow）', () => {
  /**
   * 守卫 ①：**远端目录里每一条**经 `resolveModel` 都拿到可用窗口。
   *
   * ⚠️⚠️ **不能断言 `listModels` 的返回值带 `contextWindow`** ——
   * DSH 契约里 `LlmModelInfo`（`listModels` 的返回形状）**没有这个字段**，
   * 只有 `LlmResolvedModelInfo`（`resolveModel` 的返回形状）才有
   * `context?: { contextWindow }`（见 `dsh-llm/lib/types/types.d.ts:321/394`）。
   * 我第一版就是这么写的，实测恒红（`glm-5.3 的 contextWindow 实际=undefined`）——
   * **契约形状写错会让守卫变成假红**，与「假绿」一样有害。
   *
   * ⚠️ 这里刻意喂一份「静态表里查不到」的远端目录 —— 真实目录就是这种形态：
   * 上游 `/v1/model/builtin` 的条目键全集里**没有任何 context/window 字段**
   * （实测见 `CONTEXT_WINDOWS` 的注释），所以远端 id 全部依赖本地表/兜底。
   */
  it('① 远端目录里每一条经 resolveModel 都拿到正数窗口（含表里没有的新模型）', async () => {
    const remote = [
      { id: 'glm-5.3', name: 'GLM-5.3' },
      { id: 'GLM-5.2', name: 'GLM-5.2' },
      { id: 'openpangu-2.0-pro', name: 'OpenPangu-2.0-Pro' },
      { id: 'glm-5.2-sft-harmony', name: 'GLM-5.2-ArkTS-SPARK' },
      // ⚠️ 故意造一个**将来才会出现**的上游新模型：它必然不在静态表里，
      //    旧实现（省略 context）会让它没有占用条。
      { id: 'brand-new-model-2030', name: 'Brand New' },
    ]
    const adapter = makeAdapter(remote)
    const models = await adapter.listModels('codearts')
    expect(models.length).toBe(remote.length)
    for (const model of models) {
      const resolved = await adapter.resolveModel('codearts', model.id)
      expectUsableWindow(resolved.context?.contextWindow, model.id)
    }
  })

  /**
   * 守卫 ①b：**静态兜底目录**（远端失败）里每一条经 `resolveModel` 都有可用窗口。
   *
   * ⚠️ 这条覆盖的是「首次启动 / 未登录 / 远端全挂」的真实形态 ——
   * 用户在那时发第一句话，占用条也必须出现。
   */
  it('①b 静态兜底目录（远端失败）里每一条都带正数 contextWindow', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('codearts')
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      const resolved = await adapter.resolveModel('codearts', model.id)
      expectUsableWindow(resolved.context?.contextWindow, model.id)
    }
  })

  /**
   * 守卫 ②：`resolveModel` 给出的窗口与「该 id 应有值」**逐条一致**。
   *
   * ⚠️ 这是真正喂给 `request/context` 的那条路（`agent-loop` 读的是
   * `resolveModel().context.contextWindow`，不是 `listModels`）。
   * 本用例把**权威值表**与适配器输出直接比对，任一侧漂移都会红。
   */
  it('② resolveModel 的窗口与权威值逐条一致', async () => {
    const adapter = makeAdapter([
      { id: 'glm-5.3', name: 'GLM-5.3' },
      { id: 'GLM-5.2', name: 'GLM-5.2' },
      { id: 'openpangu-2.0-flash', name: 'OpenPangu-2.0-Flash' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    ])
    for (const [id, window] of [
      ['glm-5.3', 1_048_576],
      // 2026-10-29：IDE 0.2.6 抓包 + AgentCenter 双源权威 202_752（10-21 的 1M 是
      // 临时值/灰度 —— 本表三次漂移史见 CONTEXT_WINDOWS 注释）。
      ['GLM-5.2', 202_752],
      ['openpangu-2.0-flash', 524_288],
      ['deepseek-v4.1-flash', 1_048_576],
    ] as const) {
      const resolved = await adapter.resolveModel('codearts', id)
      expect({ id, window: resolved.context?.contextWindow }).toEqual({ id, window })
    }
  })

  /**
   * 守卫 ③：**手填的未知 id** 也有窗口。
   *
   * ⚠️ 用户可以在设置页手填任意模型 id（`model-catalog.ts` 的
   * `unknownModelInputModalities` / `unknownModelReasoning` 就是为这条路存在的）。
   * 若未知 id 省略 context，手填模型就**永远**没有占用条。
   */
  it('③ 手填的未知 id 也拿到兜底窗口（否则手填模型永远没有占用条）', async () => {
    const adapter = makeAdapter([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
    const resolved = await adapter.resolveModel('codearts', '手填-不存在的模型-id')
    expect(resolved.context).toEqual({ contextWindow: CODEARTS_FALLBACK_CONTEXT_WINDOW })
  })

  /**
   * 守卫 ③c：**「静态窗口表里有、但静态兜底目录里没有」的 id，离线路径也必须
   * 拿到表内值，不能拿兜底值。**
   *
   * ⚠️⚠️ 这条是**全量测试抓出来的真缺陷**（2026-10-21），不是预防性用例：
   * 第一版把 `unknownModelContextWindow` 写成无参、直接返回常数兜底 ⇒
   * `glm-5.3` 在 `CONTEXT_WINDOWS` 里是 1M，但它**不在** `DEFAULT_MODELS`
   * （静态兜底目录）里 ⇒ 远端失败（首次启动 / 未登录）时它走「目录外」分支
   * ⇒ 拿到 524_288 ⇒ **占用比分母错 2 倍**，而它**正是用户报障的模型**。
   *
   * ⚠️⚠️ **2026-10-27 换主体 id**：原用例用 `glm-5.3` 作「表里有、目录里没有」
   * 的样本。但同期实测校准把 `glm-5.3` **补进了** `DEFAULT_MODELS`
   * （它上游确实下发、真机 200），该样本条件不再成立。
   * ⇒ 改用 `glm-5.3-flash`：它仍在 `CONTEXT_WINDOWS` 里（1M），但已从
   * `DEFAULT_MODELS` 移除（实测 404）。**用例要守的语义（离线路径取表内值）
   * 一字未变**，只是换了满足条件的样本。
   *
   * ⚠️⚠️ **2026-11-22 再换一次样本**：`glm-5.3-flash` 被**加回了** `DEFAULT_MODELS` ——
   * 因为上游 `/v1/model/builtin` 当天**重新下发**了它（`enable: true`、
   * `display_enabled: true`、`ratio_display: 0.08x`，与 IDE 列表截图一致）
   * ⇒ 当初那个「实测 404」的前提**已经失效**，它现在是**可用模型**，
   * 不该再当「目录里没有」的样本。
   * ⇒ 改用 `deepseek-v4-pro`（`CONTEXT_WINDOWS` 有 1M、`DEFAULT_MODELS` 仍不含它，
   * 且它的实测结论是 `404 ModelArts.81009 Invalid model` ⇒ 确实下线）。
   * **用例要守的语义一字未变**。
   *
   * ⇒ 判据是「离线路径的取值 == 表内值」，且**必须与兜底常量不同**才算有判别力
   * （若两者恰好相等，这条用例会恒真）。
   */
  it('③c 表里有、静态目录里没有的 id（deepseek-v4-pro），离线路径也拿表内值', async () => {
    // 先自证这条用例有判别力：表内值必须与兜底值**不同**。
    expect(codeartsContextWindow('deepseek-v4-pro')).not.toBe(CODEARTS_FALLBACK_CONTEXT_WINDOW)
    // 离线：远端拉取失败 ⇒ 目录回落到静态兜底表（里面**没有** deepseek-v4-pro）。
    const adapter = makeAdapter()
    const listed = await adapter.listModels('codearts')
    expect(listed.map((m) => m.id)).not.toContain('deepseek-v4-pro')
    // 但用户仍可能（通过远端目录 / 手填 / 会话历史）请求它。
    const resolved = await adapter.resolveModel('codearts', 'glm-5.3-flash')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
  })

  /**
   * 守卫 ③b：**兜底常量本身**必须是可用的分母，且不等于「表里最小的真实窗口」
   * 之外的任意值 —— 取值口径是「当前目录最小真实窗口」（用户 2026-10-21 选定）。
   *
   * ⚠️ 断言**具体数值**：改大改小都是行为变更（偏大 ⇒ 未知模型可能上游溢出报错），
   * 必须有人主动改这条断言，不能静默漂移。
   */
  it('③b 兜底常量是 524_288（当前目录最小真实窗口，用户选定）', () => {
    expect(CODEARTS_FALLBACK_CONTEXT_WINDOW).toBe(524_288)
    expectUsableWindow(CODEARTS_FALLBACK_CONTEXT_WINDOW, 'CODEARTS_FALLBACK_CONTEXT_WINDOW')
  })

  /**
   * 守卫 ④：**逐模型的权威值**（IDE 下发的 `inferhub-provider.models[*].limit.context`）。
   *
   * ⚠️ 这条钉的是**数值本身**，防两件事：
   * ① 表值静默漂移（这条用例要求改值的人**带着取证来改**）；
   * ② 有人把兜底值「顺手」也填进表里冒充实测值。
   *
   * ## GLM-5.2 的取值史（三次漂移，改这条断言前必读）
   *
   * - 202_752（2026-09-11~10-20 内核日志，42 份）；
   * - 1_048_576（10-21 校准 —— 当时的守卫文本还专门写着「不得退回 202_752」）；
   * - **202_752（10-29 复测：IDE 0.2.6 抓包 record 38 + AgentCenter 双源一致）**
   *   ⇒ 结论：10-21 那次不是「上游永久上调」而是临时值/灰度。
   *
   * ⇒ 现按 10-29 权威写回 202_752。⚠️ 运行时权威已由 AgentCenter 动态下发
   * （`RemoteModel.contextWindow` 优先于静态表），本表只是冷缓存兜底 ——
   * 但兜底也必须钉数值：下次再漂移，改这条断言的人必须同样带着双源取证。
   */
  it('④ 逐模型窗口等于 IDE 下发的权威值（GLM-5.2 按 2026-10-29 双源取证 = 202_752）', () => {
    expect({
      'GLM-5.2': codeartsContextWindow('GLM-5.2'),
      'glm-5.3': codeartsContextWindow('glm-5.3'),
      'glm-5.3-flash': codeartsContextWindow('glm-5.3-flash'),
      'glm-5.2-sft-harmony': codeartsContextWindow('glm-5.2-sft-harmony'),
      'openpangu-2.0-flash': codeartsContextWindow('openpangu-2.0-flash'),
      'openpangu-2.0-pro': codeartsContextWindow('openpangu-2.0-pro'),
      'deepseek-v4.1-flash': codeartsContextWindow('deepseek-v4.1-flash'),
      'kimi-k3': codeartsContextWindow('kimi-k3'),
    }).toEqual({
      'GLM-5.2': 202_752,
      'glm-5.3': 1_048_576,
      'glm-5.3-flash': 1_048_576,
      'glm-5.2-sft-harmony': 202_752,
      'openpangu-2.0-flash': 524_288,
      'openpangu-2.0-pro': 524_288,
      'deepseek-v4.1-flash': 1_048_576,
      'kimi-k3': 1_048_576,
    })
  })

  /**
   * 守卫 ⑤：兜底**不得**污染表内值（表内命中时绝不返回兜底）。
   *
   * ⚠️ 变异「`codeartsContextWindow` 恒返回兜底」会让 ①②③ 全绿而这条红。
   */
  it('⑤ 表内命中时返回表内值，不是兜底', () => {
    expect(codeartsContextWindow('GLM-5.2')).not.toBe(CODEARTS_FALLBACK_CONTEXT_WINDOW)
    expect(codeartsContextWindow('deepseek-v4.1-flash')).not.toBe(CODEARTS_FALLBACK_CONTEXT_WINDOW)
  })

  /**
   * 守卫 ⑥：**AgentCenter 动态值优先于静态表**（2026-10-29 接入）。
   *
   * ⚠️ 变异「`toCatalogEntry` 忽略 `model.contextWindow`、恒走静态表」会让
   * ①②③④⑤ 全绿（静态表本身仍自洽）而这条红 —— 它是动态源唯一有牙的守卫。
   * 取值 999_999 刻意是静态表与兜底里**都不存在**的数（避免巧合相等）。
   */
  it('⑥ 远端目录带回的动态窗口优先于静态表（AgentCenter 权威）', async () => {
    const adapter = makeAdapter([
      { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 999_999 },
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576 },
    ])
    const glm = await adapter.resolveModel('codearts', 'GLM-5.2')
    expect(glm.context?.contextWindow).toBe(999_999)
    // ⚠️ 反向对照：无动态值时仍走静态表（「凡远端就赢」的变异会被这条抓到）。
    const adapterNoWin = makeAdapter([{ id: 'kimi-k3', name: 'Kimi K3' }])
    const kimi = await adapterNoWin.resolveModel('codearts', 'kimi-k3')
    expect(kimi.context?.contextWindow).toBe(1_048_576)
  })

  /**
   * 守卫 ⑦：**刻意不声明 `defaultMaxTokens`**（2026-10-30 四路审计 P1-1 修）。
   *
   * ⚠️⚠️ **这条守的是一个「会导致整轮对话报废」的回归**：
   *
   *   DSH 的契约不是「上限」而是「**默认输出预算**」：
   *   `dsh-llm` 把 `defaultMaxTokens` 注入 `config.maxTokens`
   *   （`node_modules/@deepseek-ai/dsh-llm/lib/index.js:2183-2185`），
   *   而 `dsh-compaction-basic` 的 `reservedCompletionTokens(agent,
   *   defaultMaxTokens)`（`lib/index.js:757`）读的**正是同一个值** ——
   *   它把该值当作「**输出侧预留**」**从上下文窗口里扣掉**。
   *
   *   ⇒ 落键的后果（宿主默认 thresholdRatio=0.8 / headroom=65536）：
   *   GLM-5.2 压缩触发点 **162,201 → 109,772**、压力预算 **137,216 → 71,680**；
   *   窗口 131,072 的模型配上 65536 的预留 ⇒ pressure=0 ⇒ 宿主**抛**
   *   `TargetPressureConfigError`（**不是降级**）。
   *
   * ⚠️ `master` 的 `toCatalogEntry` **全文没有 `maxTokens` 键** ⇒ 改前
   *   `defaultMaxTokens` 恒 undefined ⇒ 预留恒 0 ⇒ 上述回归是**新引入的**。
   *
   * ⚠️ 与本仓既有先例同口径：`src/opencode-adapter.ts:392-413` **刻意不声明**
   *   `defaultMaxTokens`，理由逐字为「能力表里的 `limit.output` 是**模型单次
   *   输出上限**，不是『合理的默认输出预算』……下发等于**我们替用户决定**
   *   每轮按上限请求」。
   *
   * ⚠️ 判据要**双向**：既断言「不声明」，也断言「出站仍然发 65536」
   *   （否则「把默认预算也删了」这种变异会全绿）。
   */
  it('⑦ 刻意不声明 defaultMaxTokens（否则它会变成宿主的上下文预留）', async () => {
    const adapter = makeAdapter([
      { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 202_752, maxOutputTokens: 65_536 },
    ])
    const resolved = await adapter.resolveModel('codearts', 'GLM-5.2')
    // ⚠️ **必须没有** `defaultMaxTokens` —— 它会被宿主当成「输出侧预留」扣掉。
    expect((resolved as { defaultMaxTokens?: number }).defaultMaxTokens).toBeUndefined()
  })

  /**
   * 守卫 ⑧：**动态窗口表与「目录可见性」解耦**（2026-10-30 四路审计 P3 D6 修）。
   *
   * ⚠️ 旧实现里动态窗口查的是 `remoteModels`，而
   * `src/model-catalog.ts` 的 `unknownModelContextWindow` **只在
   * `entry === undefined`（模型不在目录里）时**才被调 ⇒
   * 「在 remoteModels 里」⟺「在目录里」⇒ **动态腿在「手填模型 id」场景
   * 基本不可达**（实测唯一例外是 VL，而 VL 走 `analyzeImage` 那条路
   * **根本不需要窗口** ⇒ 实际收益 ≈ 0）。
   *
   * ⇒ 修法：动态窗口收进**独立的表**（`remoteContextWindows`），
   * 与目录可见性无关。
   *
   * ⚠️ 本用例的样本是 `windowOnly` 条目（AgentCenter 有、目录里没有的那个）⇒
   *   它**在目录里不可见**，正是「目录外 id」这条路径的样本。
   * ⚠️ 取值 777_777 刻意是静态表与兜底里**都不存在**的数（避免巧合相等）。
   */
  it('⑧ 手填「目录外但远端有窗口」的 id ⇒ 拿到动态值（动态腿真正可达）', async () => {
    const adapter = makeAdapter([
      { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 202_752 },
      { id: 'window-only-model', name: 'Window Only', contextWindow: 777_777, windowOnly: true },
    ])
    // ⚠️ 前置自证：它**不在目录里**（windowOnly ⇒ 只作窗口源）。
    const listed = await adapter.listModels('codearts')
    expect(listed.map((m) => m.id)).not.toContain('window-only-model')
    // 但手填它时，分母必须取 AgentCenter 的动态值。
    const resolved = await adapter.resolveModel('codearts', 'window-only-model')
    expect(resolved.context?.contextWindow).toBe(777_777)
  })

  /**
   * 守卫 ⑨：**窗口源条目不进目录**（2026-10-30 四路审计 P1-2 修）。
   *
   * ⚠️ AgentCenter **不下发倍率** ⇒ 这类条目进目录就是裸名 ⇒
   *   `src/aggregate-core.ts` 的 `priceFactorFromName('…')` 恒 `Infinity`
   *   ⇒ 聚合候选排序里**永远排最后、永不被挑中**（静默）。
   *
   * ⚠️ 判据是「目录里没有它」**且**「动态窗口仍可解析」⇒
   *   删掉 `windowOnly` 过滤 ⇒ 前半条红；把窗口表也删了 ⇒ 后半条红。
   */
  it('⑨ 窗口源条目不进目录，但窗口仍可解析', async () => {
    const adapter = makeAdapter([
      { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 202_752 },
      { id: 'window-only-model', name: 'Window Only', contextWindow: 777_777, windowOnly: true },
    ])
    const listed = await adapter.listModels('codearts')
    expect(listed.map((m) => m.id)).toContain('GLM-5.2')
    expect(listed.map((m) => m.id)).not.toContain('window-only-model')
    const resolved = await adapter.resolveModel('codearts', 'window-only-model')
    expect(resolved.context?.contextWindow).toBe(777_777)
  })

  /**
   * 守卫 ⑩：**`listAllModels()` 同步视图**也必须过滤窗口源条目
   * （2026-10-30 第二轮审计 P1 N-2 修）。
   *
   * ⚠️⚠️ 上一版守卫⑨**只覆盖了 `listModels()`**（异步那条路）⇒ 变异
   * 「删掉 `syncCatalogEntries()` 里的 `windowOnly` 过滤」⇒ **全量 11476 条
   * 用例全绿**（实测）⇒ 那条路**零保护**。
   *
   * ⚠️ **生产影响不是摆设**：`listAllModels()` → `src/jet-hub-rpc.ts` 的
   * `fullCatalogIds()` → **Jet Hub 的模型开关清单 + 黑名单写入集合** ⇒
   * 窗口源条目会**以裸名出现**在设置页（正是 P1-2 想消灭的形态）。
   */
  it('⑩ listAllModels() 同步视图也过滤窗口源条目（Jet Hub 模型开关那条路）', async () => {
    const adapter = makeAdapter([
      { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 202_752 },
      { id: 'window-only-model', name: 'Window Only', contextWindow: 777_777, windowOnly: true },
    ])
    // ⚠️ 先等一次远端拉取落地（`listAllModels` 是**同步**契约，读的是缓存）。
    await adapter.listModels('codearts')
    const all = adapter.listAllModels()
    expect(all.map((m) => m.id)).toContain('GLM-5.2')
    expect(all.map((m) => m.id), '同步视图也不该出现窗口源条目').not.toContain('window-only-model')
  })

  /**
   * 守卫 ⑪：**冷缓存路径**也必须过滤窗口源条目（2026-10-30 第二轮审计 P1 N-1 修）。
   *
   * ⚠️⚠️ **上一版只守「远端拉取成功」那半** ⇒ 冷缓存（首启 / 远端失败 /
   *    上游抖动）走 `DEFAULT_MODELS` 兜底 ⇒ 那些条目**没有** `windowOnly`
   *    属性 ⇒ `kimi-k3` 以**裸名**进目录 ⇒ `priceFactorFromName` 恒
   *    `Infinity` ⇒ 第一轮 P1-2 的症状**原样复发**（实测）。
   *
   * ⇒ 判据必须是「**独立 id 集合**」⇒ 远端来时记下、**冷缓存也留着**。
   *
   * ⚠️⚠️ 本用例的形状：**先**让远端成功一次（记下窗口源 id）
   *    ⇒ **再**让远端失败（目录回落兜底表）⇒ 断言 `kimi-k3` **仍不出现**
   *    ⇒ 这正是「冷缓存路径」的形状（**曾经**成功过 ⇒ 现在失败了）。
   */
  it('⑪ 冷缓存路径（远端失败）也不该出现窗口源条目', async () => {
    // ⚠️⚠️ 本用例的形状：**同一个适配器**先远端成功一次（记下窗口源 id）
    //    ⇒ **再**让远端失败（目录回落兜底表）⇒ 断言 `kimi-k3` **仍不出现**
    //    ⇒ 这正是「冷缓存路径」的形状（**曾经**成功过 ⇒ 现在失败了）。
    let fail = false
    const adapter = new CodeArtsAdapter({
      credentialRef: 'CODEARTS_ACCESS_TOKEN',
      resolveCredential: async () => validCredential,
      refresh: async () => {},
      fetchImpl: async () => new Response('not found', { status: 404 }),
      fetchRemoteModels: async () => {
        if (fail) throw new Error('offline')
        return [
          { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 202_752 },
          { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576, windowOnly: true },
        ]
      },
    })
    // ⚠ 第一轮：远端成功 ⇒ 记下「窗口源 id」。
    await adapter.listModels('codearts')
    expect(adapter.listAllModels().map((m) => m.id)).not.toContain('kimi-k3')

    // ⚠ 第二轮：**远端失败** ⇒ 目录回落 `DEFAULT_MODELS` 兜底表
    //    （那张表**含** `kimi-k3`）⇒ 若判据没被独立集合记住 ⇒ 裸名进目录。
    //    ⚠⚠ **必须让第二次拉取**真正发生（否则 TTL 短路**不会**重拉
    //    ⇒ `remoteModels` 仍是第一次的成功结果 ⇒ 下面的断言**恒真**）。
    //    ⚠ 口径：把 `catalogAt` 清零（`invalidateCatalogCache` 做的同一件事）。
    fail = true
    ;(adapter as unknown as { catalogAt: number }).catalogAt = 0
    const listed = await adapter.listModels('codearts')
    // ⚠ **判据**：`kimi-k3` 不该出现（它既不在远端路径、也不在兜底路径）。
    expect(listed.map((m) => m.id), '冷缓存也不该出现窗口源条目').not.toContain('kimi-k3')
    expect(adapter.listAllModels().map((m) => m.id), '同步视图也不该出现').not.toContain('kimi-k3')
  })

  /**
   * 守卫 ⑫：**兜底目录本身**不得含窗口源模型（2026-10-30 第二轮审计 P1 N-1 修）。
   *
   * ⚠️⚠️ **这是 N-1 的真正承重处**：`kimi-k3` 是**只在 AgentCenter 出现**的
   * 模型（builtin 漏发）⇒ AgentCenter **不下发倍率** ⇒ 它进目录必然是**裸名**
   * ⇒ `priceFactorFromName` 恒 `Infinity` ⇒ 聚合里 codearts 恒排最后、
   * **永远不被挑中**（静默）。
   *
   * ⚠️ 旧实现把 `kimi-k3` 放在 `DEFAULT_MODELS` 兜底表里 ⇒ **冷缓存路径**
   * （首启 / 远端失败 / 上游抖动）它就**裸名**进目录 ⇒ 第一轮 P1-2 的症状
   * **原样复发**（实测）。
   * ⇒ 修法：把它从兜底表**移除**（它的**窗口**仍可用 —— 见 `CONTEXT_WINDOWS`
   * 与 `remoteContextWindows`，用户手填 `kimi-k3` 时分母是对的）。
   */
  it('⑫ 兜底目录不得含「窗口源」模型（kimi-k3 只在 AgentCenter 出现）', () => {
    // ⚠️ 直接守**兜底表本身**（不依赖任何运行时状态 ⇒ 恒确定的守卫）。
    expect(DEFAULT_MODELS_FOR_TEST).not.toContain('kimi-k3')
    // ⚠️ 反向对照：兜底表**不是**空的（否则这条恒真）。
    expect(DEFAULT_MODELS_FOR_TEST.length).toBeGreaterThan(0)
    expect(DEFAULT_MODELS_FOR_TEST).toContain('GLM-5.2')
  })
})
