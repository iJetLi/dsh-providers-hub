/**
 * ★★ **modelscope 的目录必须由共享骨架接管**（迁移 RED 规格）。
 *
 * ## 迁移前的手写形态（将被删除）
 *
 * `ModelscopeAdapter.listModels` 自己做了四件事：
 * ① 判 `providerClosed`；② 判 `providerCatalogVisible`；③ 过滤 `disabledModels`；
 * ④ 手工 map 成 `LlmModelInfo`。
 *
 * ①③④ 与其余 13 家**逐字同义**，正是共享骨架的实现 ⇒ 各写一份必然漂移
 *（IKP8OF 就是漂移的产物）。迁移后 ①②③④ 全部由 `createModelCatalog` 承担。
 *
 * ## 本文件守什么
 *
 * 判据打在**用户可见后果**上，不锁实现：迁移后这些断言照样通过；
 * 而任何一环漏接就变红。每条都带对照组，防「空数组断言恒真」。
 */
import { describe, expect, it } from 'vitest'
import { ModelscopeAdapter } from '../../src/modelscope-adapter.js'
import { MODELSCOPE, MODELSCOPE_FALLBACK_MODELS } from '../../src/modelscope-product.js'
import { MODELSCOPE_RETIRED_MODEL_IDS } from '../../src/modelscope-adapter.js'
import type { AccountPool } from '../../src/account-pool.js'

/** 一个「有已登录账号」的账号池替身（只实现门控与黑名单两个消费点）。 */
function makePool(options: {
  disabled?: readonly string[]
  closed?: boolean
  visible?: boolean
  /** 删掉 `hasLoggedInAccount` ⇒ 模拟「老接线/替身没实现」，门控按「可见」处理。 */
  withoutVisibilityGate?: boolean
} = {}): AccountPool {
  const base: Record<string, unknown> = {
    disabledModelsFor: () => new Set(options.disabled ?? []),
    providerClosedFor: () => options.closed ?? false,
  }
  if (options.withoutVisibilityGate !== true) {
    base.hasLoggedInAccount = async () => options.visible ?? true
  }
  return base as never
}

function makeAdapter(pool: AccountPool, slots: number = 1): ModelscopeAdapter {
  return new ModelscopeAdapter({
    product: MODELSCOPE,
    accountPool: pool,
    slots: async () => Array.from({ length: slots }, (_, i) => ({
      id: `s${i + 1}`,
      apiKey: `ms-0123456789abcdefghij${i}`,
    })),
  })
}

describe('★★ modelscope 迁移到共享骨架：用户可见后果不变', () => {
  it('★★ 关闭单个模型 ⇒ 它从 listModels 消失，其余仍在', async () => {
    const adapter = makeAdapter(makePool({ disabled: ['deepseek-ai/DeepSeek-V4.1-Flash-1017'] }))
    const listed = await adapter.listModels(MODELSCOPE.id)
    const ids = listed.map((m) => m.id)

    // 对照组：目录非空（否则下面的断言恒真）。
    expect(ids.length, '对照失败：目录本就为空 ⇒ 本用例会假绿').toBeGreaterThan(0)
    expect(
      ids,
      '★★ 用户关掉的模型仍出现在选择器里 ⇒ 黑名单对 modelscope 静默失效',
    ).not.toContain('deepseek-ai/DeepSeek-V4.1-Flash-1017')
    // 且其余模型**仍在**（防「一关就整份清空」的假绿）。
    // ⚠️ 期望值必须是「兜底表 − 已下线名单 − 被关掉的那 1 个」：2026-11-16 起
    //    已下线 id 不再进目录（见 `MODELSCOPE_RETIRED_MODEL_IDS`），直接拿
    //    `FALLBACK.length - 1` 会把「过滤生效」误判成「黑名单失效」。
    const exposed = MODELSCOPE_FALLBACK_MODELS.filter((m) => !MODELSCOPE_RETIRED_MODEL_IDS.has(m.id))
    expect(ids.length).toBe(exposed.length - 1)
  })

  it('★★ 关闭整个供应商 ⇒ listModels 恒空', async () => {
    const open = await makeAdapter(makePool()).listModels(MODELSCOPE.id)
    expect(open.length, '对照失败：未关闭时目录本就为空').toBeGreaterThan(0)

    const shut = await makeAdapter(makePool({ closed: true })).listModels(MODELSCOPE.id)
    expect(shut, '★★ 关闭供应商后 modelscope 仍播出模型 ⇒ 选择器里照样能选').toEqual([])
  })

  it('★★ 无已登录账号 ⇒ 目录为空（门控统一为账号池）', async () => {
    const listed = await makeAdapter(makePool({ visible: false })).listModels(MODELSCOPE.id)
    expect(
      listed,
      '★★ 无账号却仍播出模型 ⇒ 门控未统一（本家迁移后必须与其余家同源）',
    ).toEqual([])
  })

  it('★ 没有可解析的槽位 ⇒ 目录为空（既有语义不得丢）', async () => {
    const listed = await makeAdapter(makePool(), 0).listModels(MODELSCOPE.id)
    expect(listed, '★ 无槽位仍播模型 ⇒ 会给出一个必然失败的模型选项').toEqual([])
  })

  it('★★ 关闭意图必须覆盖「关闭之后才出现的模型」', async () => {
    // 该 id 从不在黑名单里（模拟上游新增），只靠意图腿拦住。
    const adapter = makeAdapter(makePool({ closed: true, disabled: [] }))
    expect(
      (await adapter.listModels(MODELSCOPE.id)),
      '★★ 意图腿失效 ⇒ 新增模型在关闭态下仍可选（IKP8OF 原症状）',
    ).toEqual([])
  })

  it('★ 全量视图（listAllModels）不套黑名单（设置页要看得到已关闭模型的开关）', async () => {
    const adapter = makeAdapter(makePool({ disabled: ['deepseek-ai/DeepSeek-V4.1-Flash-1017'] }))
    const all = adapter.listAllModels().map((m) => m.id)
    expect(
      all,
      '★ 全量视图被黑名单过滤 ⇒ 用户再也打不开那个模型（设置页没有入口）',
    ).toContain('deepseek-ai/DeepSeek-V4.1-Flash-1017')
  })
})
