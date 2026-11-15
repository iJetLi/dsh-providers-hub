/**
 * ModelScope（魔搭）**接线完整性**守卫（2026-10-17 审计新增，2026-10-23 迁移后改写）。
 *
 * ## 起因：一个真实缺陷，且症状**纯静默**
 *
 * 用户实测：「在模型列表里只开启了 V4.1 Flash，其余 35 个全关」，
 * 但**模型选择器里仍列全部 36 个**。
 *
 * 根因：`ModelscopeAdapter` 的消费点**一直是对的**，而 `index.ts` 的
 * `registerModelscopeLlm(ctx, { … })` **没有传那个回调**
 * ⇒ `?.()` 恒为 `undefined` ⇒ 过滤退化成「不过滤」。
 *
 * ⚠️⚠️ 这正是本仓库反复记录的「漏一处就静默失效」形态，且它比 accio 那次
 * 更隐蔽 —— accio 是「两处表都要登记」，本条是「**适配器支持该能力、只是接线
 * 漏了实参**」⇒ 类型检查通过、适配器自测全绿、无报错无日志。
 *
 * ## ⚠️⚠️ 2026-10-23：黑名单来源已从「选项回调」改为「账号池」
 *
 * 用户定稿「实体 provider 一律走共享骨架（`model-catalog.ts`）」后，本家的
 * `listModels` **委托骨架**，黑名单/关闭意图由骨架从 `deps.accountPool` 读。
 * ⇒ 旧的 `disabledModels` / `providerClosed` **选项回调已被删除**：
 * 留着它就是「同一语义两套判据」（本仓库红线），而且它会**掩盖**真正的接线
 * 缺陷（回调没传时看起来「只是没过滤」，而池没传时同理）。
 *
 * ⇒ 判据随之改成**账号池形态**：
 * - ① 行为级：池里有黑名单 ⇒ `listModels` 真的过滤掉它；
 * - ② 接线级：`index.ts` 的 `registerModelscopeLlm` 实参里必须有
 *   **真 `accountPool`**（不是 `undefined`、不是 `{}`）；
 * - ③ 自检：不给池时**不过滤** ⇒ 证明 ① 的红有来源。
 *
 * ⚠️ ② 为什么仍需文本判据：「某个注册调用的实参里有没有传池」没有可观测行为
 * （适配器自测替身本来就会带池）。但**一条文本判据不足以证明值是对的** ——
 * 实测过 `{ accountPool: undefined }` 那种假绿，故 ② 额外断言值不是
 * `undefined` / `null` / `{}`。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ModelscopeAdapter } from '../../src/modelscope-adapter.js'
import { MODELSCOPE, MODELSCOPE_FALLBACK_MODELS } from '../../src/modelscope-product.js'
import { MODELSCOPE_RETIRED_MODEL_IDS } from '../../src/modelscope-adapter.js'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

/** 只实现骨架消费的两个点（黑名单 + 关闭意图）。 */
function poolStub(disabled: readonly string[] = []): never {
  return {
    disabledModelsFor: () => new Set(disabled),
    providerClosedFor: () => false,
  } as never
}

describe('★ ModelScope 接线完整性（迁移后：黑名单走账号池）', () => {
  /**
   * ① 行为级：池里有黑名单，`listModels` **必须**真的过滤掉它。
   *
   * ⚠️ 判据是「**真跑**并断言返回值为空/不含该 id」，不是源码文本。
   */
  it('★ 池里的黑名单模型不得出现在 listModels（真实过滤，非恒真）', async () => {
    // ⚠️ 不能按下标硬取：表里前两条（`-Flash-0731` / `-V4-Pro`）2026-11-16 已实测下线，
    //    不再进目录 ⇒ 拿它们当样本会假红。取「仍在服务」的前两条。
    const live = MODELSCOPE_FALLBACK_MODELS.filter((m) => !MODELSCOPE_RETIRED_MODEL_IDS.has(m.id))
    const fallback = live[0]
    const second = live[1]
    expect(second, '兜底表至少要两个在服务的模型，本用例才有「过滤掉一个、留下一个」可断言')
      .toBeDefined()

    const adapter = new ModelscopeAdapter({
      slots: async () => [{ id: 'a1', apiKey: 'ms-0123456789abcdefghij' }],
      product: MODELSCOPE,
      // ⚠️ 关键：池里给黑名单，若骨架的过滤被删掉/池没接上，下面会红。
      accountPool: poolStub([second!.id]),
      // ⚠️ 不给 `fetchRemoteCatalog` ⇒ 走兜底表（确定性、无网络）。
    } as never)

    const ids = (await adapter.listModels(MODELSCOPE.id)).map((m) => m.id)
    expect(ids, '兜底表里没有被过滤的模型 ⇒ 断言恒真').toContain(fallback!.id)
    expect(ids, '池里的黑名单没有生效 ⇒ 用户关掉的模型仍出现在选择器里')
      .not.toContain(second!.id)
  })

  /**
   * ② 接线级：`index.ts` 的 `registerModelscopeLlm` 实参里必须有**真** `accountPool`。
   *
   * ⚠️ **必须剥掉注释后再判**：否则一行「⚠️ 本该接 accountPool」的注释
   * 就能让这条守卫恒绿（本仓库实测过的诱饵形态）。
   * ⚠️ 并额外排除 `accountPool: undefined` / `null` —— 实测过的假绿格
   * （骨架里 `deps.accountPool?.` 的 `?.` 让 undefined 变成静默 no-op）。
   */
  it('★ index.ts 的 modelscope 注册实参里必须带真 accountPool（剥注释后判定）', () => {
    const source = readFileSync(REPO + 'src/index.ts', 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n')

    const at = code.indexOf('registerModelscopeLlm(')
    expect(at, 'index.ts 里找不到 registerModelscopeLlm 调用点').toBeGreaterThan(-1)
    const tail = code.slice(at, at + 4000)
    const end = tail.indexOf('\n  })')
    const call = end > 0 ? tail.slice(0, end) : tail

    expect(
      call,
      '★ registerModelscopeLlm 的实参里没有 accountPool ⇒ 黑名单与「关闭供应商」'
      + '双双失效（实测形态：关闭的模型仍出现在模型选择器里）',
    ).toMatch(/accountPool:\s*pool\b/)
    expect(
      /accountPool\s*:\s*(undefined|null)\b/.test(call),
      '★ accountPool 被写成 undefined / null ⇒ 子句 `?.` 让它变成静默 no-op（假绿）',
    ).toBe(false)
  })

  /**
   * ③ 守卫自检：**不给池**时不过滤，第 ① 条的红因此有来源。
   *
   * ⚠️ 这一条防「① 的红来自别的原因」（例如目录本来就空）。
   */
  it('★ 判据自检：不给池时不过滤（第 ① 条的红因此有来源）', async () => {
    // ⚠️ 不能写 `MODELSCOPE_FALLBACK_MODELS[1]`：2026-11-16 起已下线的 id 不再进目录，
    //    而表里第 2 条正好是 `deepseek-ai/DeepSeek-V4-Pro`（已下线）⇒ 断言会假红。
    //    取「第一条仍然在服务的」当样本。
    const second = MODELSCOPE_FALLBACK_MODELS.find((m) => !MODELSCOPE_RETIRED_MODEL_IDS.has(m.id))
    const adapter = new ModelscopeAdapter({
      slots: async () => [{ id: 'a1', apiKey: 'ms-0123456789abcdefghij' }],
      product: MODELSCOPE,
      // ⚠️ 刻意**不传** accountPool
    } as never)
    const ids = (await adapter.listModels(MODELSCOPE.id)).map((m) => m.id)
    expect(ids, '不给池时应列出全部兜底模型 —— 否则第 ① 条的「红」来源可疑')
      .toContain(second!.id)
  })
})
