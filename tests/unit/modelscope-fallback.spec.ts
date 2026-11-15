/**
 * ModelScope 兜底表的**上下文窗口**守卫（2026-10-17）。
 *
 * ## 为什么需要它
 *
 * 魔搭的 `/v1/models` **只下发 4 个字段**（实测 `id` / `object` / `owned_by` /
 * `created`）—— **没有 `context_window`** ⇒ 远端目录解析出的
 * `contextWindow` 恒为 0（0 是「不知道」哨兵，`resolveModel` 判 `> 0` 才下发
 * `context`，否则 DSH 的自动压缩阈值算不出来）。
 *
 * ⇒ 兜底表是**唯一**的窗口来源。它一旦与远端目录漂移，用户就会看到
 * 「模型存在但没有窗口信息」，且**无任何报错**。
 *
 * ## 本文件锁的三条不变式
 *
 * ① 兜底表**不得有 `contextWindow === 0`** —— 那等于没登记；
 * ② `supportsImage: true` 的条目**必须有实测出处**（逐条点名，防「顺手写成 true」）；
 * ③ 思考档位**只能声明真机确证过的** —— 本轮实测结论是「只有 `none` 有效，
 *    `medium`/`high` 被静默忽略」，故表里**只允许** `['none']`。
 */

import { describe, expect, it } from 'vitest'
import { MODELSCOPE_FALLBACK_MODELS, findModelscopeFallback } from '../../src/modelscope-product.js'
import {
  MODELSCOPE_RETIRED_MODEL_IDS,
  ModelscopeAdapter,
  loadModelscopeCatalog,
  parseModelscopeCatalog,
} from '../../src/modelscope-adapter.js'
import { MODELSCOPE } from '../../src/modelscope-product.js'
import { normalizeModelscopeModelId } from '../../src/modelscope.js'

describe('ModelScope 兜底表：上下文窗口（2026-10-17 扩表）', () => {
  it('★ 没有任何条目把 contextWindow 留成 0（0 = 「不知道」，DSH 算不出压缩阈值）', () => {
    const zero = MODELSCOPE_FALLBACK_MODELS
      .filter((m) => !(typeof m.contextWindow === 'number' && m.contextWindow > 0))
      .map((m) => m.id)
    expect(zero, '这些模型没有窗口信息 ⇒ DSH 不会下发 context ⇒ 自动压缩阈值算不出来')
      .toEqual([])
  })

  it('★ 窗口值只能是仓库已实测的两种（或用户指定的保守占位）', () => {
    // ⚠️ 这不是「白名单」而是「已知取值集合」：新增取值时必须同时更新本断言并
    //    在兜底表里写明出处（本仓库纪律：注释里的数字必须与实测一致）。
    const ALLOWED = new Set([1_048_576, 1_000_000, 512_000])
    const bad = MODELSCOPE_FALLBACK_MODELS
      .filter((m) => !ALLOWED.has(m.contextWindow))
      .map((m) => `${m.id}=${m.contextWindow}`)
    expect(bad, '出现未登记的窗口值 ⇒ 必须写明它是实测值还是占位值').toEqual([])
  })

  it('★ 兜底表的 id 集合与远端实测的 36 个一致（漂移即红，点名差集）', () => {
    // ⚠️ 远端清单是 2026-07-14 / 2026-10-17 两次实测的快照（36 个）。
    //    ⚠️ **刻意写成字面量**而不是调用网络：本用例必须能在离线 CI 跑，
    //    且真源是「兜底表」——远端变化应由「重跑实测并更新本清单」来对齐，
    //    而不是让用例去联网（那会让它随上游抖动而红，且红得没有行动指引）。
    const REMOTE_SNAPSHOT = [
      'deepseek-ai/DeepSeek-V4-Flash-0731', 'deepseek-ai/DeepSeek-V4-Pro',
      'deepseek-ai/DeepSeek-V4-Pro-0813', 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      'early-access/EA-29B-A4B', 'MedAIBase/AntAngelMed',
      'meituan-longcat/LongCat-Flash-Lite', 'MiniMax/MiniMax-M1-80k', 'MiniMax/MiniMax-M3',
      'mistralai/Mistral-Large-Instruct-2407', 'MusePublic/Qwen-Image-Edit',
      'nex-agi/Nex-N2.5-mini', 'nex-agi/Nex-N2.5-Pro',
      'opencompass/CompassJudger-1-32B-Instruct', 'OpenGVLab/InternVL3_5-241B-A28B',
      'PaddlePaddle/ERNIE-4.5-0.3B-PT', 'PaddlePaddle/ERNIE-4.5-21B-A3B-PT',
      'PaddlePaddle/ERNIE-4.5-300B-A47B-PT', 'PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT',
      'Qwen/Qwen-Image-Edit', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-27B',
      'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3.8-27B',
      'Qwen/Qwen3.8-Flash-Next', 'Shanghai_AI_Laboratory/Intern-S1',
      'Shanghai_AI_Laboratory/Intern-S1-mini', 'Shanghai_AI_Laboratory/Intern-S2-Preview',
      'stepfun-ai/Step-3.5-Flash', 'stepfun-ai/Step-3.7-Flash',
      'XGenerationLab/XiYanSQL-QwenCoder-32B-2412', 'XGenerationLab/XiYanSQL-QwenCoder-32B-2504',
      'ZhipuAI/GLM-4.7-Flash', 'ZhipuAI/GLM-5.2', 'ACE-Step/acestep-v15-xl-sft',
    ]
    const table = MODELSCOPE_FALLBACK_MODELS.map((m) => m.id).sort()
    const snapshot = [...REMOTE_SNAPSHOT].sort()
    const missing = snapshot.filter((id) => !table.includes(id))
    const extra = table.filter((id) => !snapshot.includes(id))
    expect({ missing, extra },
      `兜底表与远端快照漂移：missing = 远端有而表里没有；extra = 表里有而远端没有`)
      .toEqual({ missing: [], extra: [] })
  })
})

describe('ModelScope 兜底表：能力声明的诚实性', () => {
  it('★ supportsImage:true 只允许出现在有实测出处的条目上', () => {
    // ⚠️ 仓库硬约定：「声明支持就必须真支持」。accio 那轮实测：漏报 false 会让
    //    模型对图片**幻觉出答案**（HTTP 200、不报错）⇒ 比报错危险得多。
    // ⚠️ 本仓当前**只有一条**实测出处：2026-10-17 复测 32×32 纯红 PNG →
    //    模型答 `Red`（读图确实生效）。
    //    ⚠️ InternVL3_5 虽以视觉著称，但**魔搭侧未实测** ⇒ 兜底表里刻意记
    //    `false`（宁可少声明，不可让模型对图片幻觉出答案）。实测通过后两处同改。
    const ALLOWED_IMAGE = ['deepseek-ai/DeepSeek-V4.1-Flash-1017']
    const claimed = MODELSCOPE_FALLBACK_MODELS
      .filter((m) => m.supportsImage === true)
      .map((m) => m.id)
      .sort()
    const unauthorized = claimed.filter((id) => !ALLOWED_IMAGE.includes(id))
    expect(unauthorized, '这些条目声明支持图片但没有实测出处 ⇒ 会让模型对图片幻觉出答案')
      .toEqual([])
    // 反向自检：白名单里的那一条**必须真的**声明了 true，否则本用例恒真。
    for (const id of ALLOWED_IMAGE) {
      expect(claimed, `${id} 在实测白名单里，但兜底表没声明 supportsImage:true —— 两者表漂移`)
        .toContain(id)
    }
  })

  it('★ 思考档位只允许确证过的「关闭思考」（medium/high 实测被静默忽略）', () => {
    // ⚠️⚠️ 本轮真机三档对照（每档 3 次，取 reasoning 字符数中位数）：
    //    `none` → 0/0/0（稳定为 0）；`medium` → 1462；`high` → 1734；
    //    而「**不指定**」→ **1676**，**比 high 还多** ⇒ medium/high 被静默忽略。
    //    ⇒ 只声明确证的一档。给出手感档位会让用户以为能控思考量（仓库
    //    providers-accio.md §7 记录过「档位看似可选、实则无效」的教训）。
    const withEfforts = MODELSCOPE_FALLBACK_MODELS.filter((m) => m.efforts !== undefined)
    for (const m of withEfforts) {
      expect([...m.efforts!], `${m.id} 声明了未经确证的思考档位`)
        .toEqual(['none'])
    }
    // 反向自检：至少要有一条声明了（否则上面是恒真）。
    expect(withEfforts.length, '兜底表没有任何条目声明档位 ⇒ 本用例的循环恒真、失去意义')
      .toBeGreaterThan(0)
  })
})
/**
 * 日期快照后缀的**兜底匹配**（Issue #12）。
 *
 * ## 为什么需要这一组
 *
 * 魔搭的推理目录 `/v1/models` **只下发 4 个字段**（`id` / `object` / `owned_by` /
 * `created`）—— **没有 `modalities`、也没有 `context_window`**。所以能力判据
 * **必然**回落到兜底表。而魔搭会**定期换日期快照 id**，两边一旦错开就恒不命中：
 *
 * ```
 * 兜底表: deepseek-ai/DeepSeek-V4.1-Flash          （无后缀）
 * 远端:   deepseek-ai/DeepSeek-V4.1-Flash-1017     （日期快照）
 *         ⇒ 精确 find 恒不命中 ⇒ supportsImage:false + contextWindow:0
 * ```
 *
 * 真机实测那个模型**能收图**（32×32 纯红 PNG 答 `Red`）⇒ 判 false 是**能力漏报**，
 * 而本仓库的硬约定是「声明支持就必须真支持」，漏报同样有害（图片能力被静默剥掉，
 * 聚合选型时该渠道的图片候选被剔除）。
 *
 * ## 判据设计（每条都防一种「改错了也绿」的形态）
 *
 * - **双向互认**：表里是快照、远端给无后缀（或反之）都要命中 —— 只测一个方向的话，
 *   「把兜底 id 改成快照」这个动作会让另一个方向静默失效；
 * - **不误剥参数规模**：`72B`/`32B` 末尾也是数字，但**不是**日期快照（放宽到
 *   「任意位数字」就会把 `Qwen2.5-72B` 的 `72` 当版本剥掉，把不同族并到一起）；
 * - **不跨族误吞**：`Foo` 不得命中 `Foobar`（只认 `-` 边界）；
 * - **远端明确声明优先**：远端说「只有 text」就必须是 false，兜底表不得反向推翻
 *   （否则是「声明支持但实际不支持」的反方向错误）。
 */
describe('ModelScope 兜底表：日期快照后缀匹配（Issue #12）', () => {
  /** issue 证据 1 的真实响应形状（37 条，每条只有四个字段）。 */
  const realRemote = {
    data: [
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', object: '', owned_by: 'system', created: 1792403735 },
      { id: 'deepseek-ai/DeepSeek-V4-Pro', object: '', owned_by: 'system', created: 1792403735 },
    ],
  }

  it('★★ -1017 必须继承同族的图片能力与窗口（远端不给能力字段时）', () => {
    const entries = parseModelscopeCatalog(realRemote)
    const flash = entries.find((e) => e.id === 'deepseek-ai/DeepSeek-V4.1-Flash-1017')
    expect(flash, '远端有 -1017 但解析结果里没有它').toBeDefined()
    // ⚠️ 这两个断言就是 issue 的核心症状：修复前分别是 false 与 0。
    expect(flash!.supportsImage, '-1017 被误判成纯文本（真机实测它能收图）').toBe(true)
    expect(flash!.contextWindow, '-1017 拿不到窗口 ⇒ DSH 算不出压缩阈值').toBeGreaterThan(0)
  })

  it('★ 双向互认：无后缀与任意日期快照都归到同一条兜底条目', () => {
    const probes = [
      'deepseek-ai/DeepSeek-V4.1-Flash',        // 无后缀（已下线，但客户端配置里可能还留着）
      'deepseek-ai/DeepSeek-V4.1-Flash-1017',   // 当前快照
      'deepseek-ai/DeepSeek-V4.1-Flash-1101',   // 未来快照
      'deepseek-ai/DeepSeek-V4.1-Flash-20251017', // YYYYMMDD 形态
    ]
    for (const id of probes) {
      const hit = findModelscopeFallback(id)
      expect(hit, `${id} 未命中兜底表 ⇒ 能力/窗口全部退化为未知`).toBeDefined()
      expect(hit!.supportsImage, `${id} 命中了但没继承图片能力`).toBe(true)
      expect(hit!.contextWindow, `${id} 命中了但没有窗口`).toBeGreaterThan(0)
    }
  })

  it('★ 不误剥参数规模（72B / 32B 不是日期快照）——无条件断言（M7b 补牙）', () => {
    // ⚠️ 若判据放宽成「任意位数字结尾」，`Qwen2.5-72B` 会被剥成 `Qwen2.5` ⇒
    //    可能并到完全不相干的条目上。这里点名几个**必须不命中**的形态。
    // ⚠️ 2026-10-31 对抗审计 M7b 补牙：原版把「必须真同族」包在
    //    `if (hit !== undefined)` 里 —— 剥错但未误命中任何条目时断言被
    //    **整个跳过**（条件式断言假绿的变体），变异 `/-\d+$/` 实测 15 条全绿。
    //    现改为：这些 id **必须未命中**（兜底表里没有它们的无后缀/同族条目，
    //    任何命中都是剥错/误吞的直接证据），无条件、无跳过路径。
    for (const id of ['Qwen/Qwen2.5-72B-Instruct', 'Qwen/Qwen3-32B', 'some/LongCat-Flash-Lite']) {
      const hit = findModelscopeFallback(id)
      expect(hit, `${id} 不得命中任何兜底条目（命中 = 剥错参数规模或跨族误吞：${hit?.id ?? ''}）`)
        .toBeUndefined()
    }
  })

  it('★ 不跨族误吞：Foo 不得命中 Foobar（只认 `-` 边界）', () => {
    expect(findModelscopeFallback('deepseek-ai/DeepSeek-V4-ProX')).toBeUndefined()
  })

  it('★★ 远端明确声明「只有 text」时必须判 false（兜底表不得反向推翻远端）', () => {
    const body = {
      data: [{
        id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', object: '', owned_by: 'system', created: 1,
        modalities: { input: ['text'] },
      }],
    }
    const entries = parseModelscopeCatalog(body)
    // ⚠️ 这是**反方向**的硬约定：兜底表说支持，但远端明确说只有文本 ⇒ 必须 false。
    //    否则就是「声明支持但实际不支持」，模型会对图片幻觉出答案（HTTP 200 不报错）。
    expect(entries[0]?.supportsImage).toBe(false)
  })

  it('★ 兜底表里的 id 必须**自己能被自己查到**（自反性，防前缀判据写反）', () => {
    for (const m of MODELSCOPE_FALLBACK_MODELS) {
      const hit = findModelscopeFallback(m.id)
      expect(hit, `${m.id} 查不到自己`).toBeDefined()
      expect(hit!.id).toBe(m.id)
    }
  })
})

/**
 * 匹配判据的**直接**验证（不经 `parseModelscopeCatalog`）。
 *
 * ⚠️ 为什么需要独立一组（变异验证的教训）：上面那些用例走的是
 * `parseModelscopeCatalog → findModelscopeFallback`，而**兜底表当前登记的 id
 * 恰好就是 `-1017`** ⇒ 「精确命中」那条腿自己就能让它们全绿。实测把
 * `findModelscopeFallback` 换成裸 `find(m => m.id === id)`，那批用例**仍然全绿**
 * ⇒ 它们证明不了「快照匹配」这条腿存在。
 *
 * 这一组直接对 `findModelscopeFallback` 传**与兜底表 id 形态无关**的 id
 * （无后缀、未来快照、YYYYMMDD），让「剥快照同族」与「`-` 边界前缀」两条腿
 * 各自可验。
 */
describe('ModelScope 快照匹配判据（直接验证，不依赖兜底 id 形态）', () => {
  const SNAPSHOT_ID = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
  const BARE_ID = 'deepseek-ai/DeepSeek-V4.1-Flash'

  it('★★ 无后缀 id 必须命中快照条目（反向互认；裸精确查找会漏）', () => {
    // ⚠️ 这条是**裸 `find(m => m.id === id)` 会失败**的那一格：
    //    兜底表登记的是 `-1017`，而调用方给的可能是无后缀 id（老配置/上游回退）。
    const hit = findModelscopeFallback(BARE_ID)
    expect(hit, '无后缀 id 未命中 ⇒ 该模型能力/窗口全部退化为未知').toBeDefined()
    expect(hit!.id).toBe(SNAPSHOT_ID)
  })

  it('★★ 未来快照（-1101）必须命中（裸精确查找会漏）', () => {
    const hit = findModelscopeFallback('deepseek-ai/DeepSeek-V4.1-Flash-1101')
    expect(hit, '上游换快照后新 id 未命中 ⇒ 能力静默丢失（这正是 Issue #12 的形态）').toBeDefined()
    expect(hit!.supportsImage).toBe(true)
  })

  it('★★ YYYYMMDD 形态也必须命中', () => {
    const hit = findModelscopeFallback('deepseek-ai/DeepSeek-V4.1-Flash-20251017')
    expect(hit).toBeDefined()
    expect(hit!.id).toBe(SNAPSHOT_ID)
  })

  it('★ 含字母/点号的段不得被当快照剥（防判据放宽过头）', () => {
    // ⚠️ `Qwen3.8-27B` 与 `Qwen3.5-397B-A17B` **本来就在兜底表里**，所以它们会
    // 精确命中 —— 这条用例要证明的不是「查不到」，而是「命中的就是它自己，
    // 而不是被剥掉 `27B`/`397B` 后串到别的族上」。
    // 若判据放宽成「任意数字结尾」，`Qwen3.8-27B` 会被剥成 `Qwen3.8` ⇒ 可能命中
    // 到 `Qwen/Qwen3.8-*` 的**另一条**（那是完全不同的模型）。
    for (const id of ['Qwen/Qwen3.8-27B', 'Qwen/Qwen3.5-397B-A17B']) {
      const hit = findModelscopeFallback(id)
      expect(hit?.id, `${id} 被剥掉数字段后串到了别的族上`).toBe(id)
    }
    // 反向：**不存在的**含数字段 id 不得因为剥数字而命中任何条目
    expect(findModelscopeFallback('Qwen/Qwen3.8-99B')).toBeUndefined()
    expect(findModelscopeFallback('nobody/Unknown-Model-72B')).toBeUndefined()
  })
})


describe('modelscope 已下线 id（MODELSCOPE_RETIRED_MODEL_IDS，2026-11-16 实测）', () => {
  /**
   * 实测来源：用真实网关把远端目录的 **全部 38 条**逐个 `POST /v1/chat/completions`
   * （`max_tokens: 4`）打了一遍，抓上游明确回 `has no provider supported` 的 8 条。
   *
   * 为什么这层过滤必须存在：这些 id 仍在 `/v1/models` 里，用户能选中但必得 400，
   * 且会被 `aggregate` 拿去当归组候选 ⇒ 轮换到死链。
   */
  const fakeCatalog = (ids: readonly string[]) =>
    (async () => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) })) as never

  it('★ 远端目录里的已下线 id 不进目录（存活的照常保留）', async () => {
    const entries = await loadModelscopeCatalog(
      fakeCatalog([
        'deepseek-ai/DeepSeek-V4-Pro',        // 已下线
        'deepseek-ai/DeepSeek-V4-Pro-0813',   // 存活
        'MiniMax/MiniMax-M3',                 // 已下线
        'Qwen/Qwen3.8-27B',                   // 存活
      ]),
      'retired-filter-remote',
      0,
    )
    expect(entries.map((e) => e.id)).toEqual([
      'deepseek-ai/DeepSeek-V4-Pro-0813',
      'Qwen/Qwen3.8-27B',
    ])
  })

  it('★ 远端全部为已下线 id 时按「空目录」处理，回退兜底表（且兜底表里也已剔除）', async () => {
    const entries = await loadModelscopeCatalog(
      fakeCatalog(['deepseek-ai/DeepSeek-V4-Pro', 'deepseek-ai/DeepSeek-V4.1-Flash']),
      'retired-filter-all',
      0,
    )
    // 走的是兜底分支：既不该为空（否则整组从 UI 消失），也不该含那两条
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.map((e) => e.id)).not.toContain('deepseek-ai/DeepSeek-V4-Pro')
    expect(entries.map((e) => e.id)).not.toContain('deepseek-ai/DeepSeek-V4.1-Flash')
  })

  it('★ 远端失败时兜底表也不吐已下线 id', async () => {
    const boom = (async () => { throw new Error('HTTP 500') }) as never
    const entries = await loadModelscopeCatalog(boom, 'retired-filter-boom', 0)
    const ids = entries.map((e) => e.id)
    for (const dead of MODELSCOPE_RETIRED_MODEL_IDS) expect(ids).not.toContain(dead)
    expect(ids).toContain('Qwen/Qwen3.8-27B') // 兜底表本身仍有内容
  })

  it('⚠️ 名单 ⊆ 实测远端清单（拼错的 id 会让过滤静默失效）', () => {
    // ⚠️ 不能拿「兜底表」当对照：兜底表只登记**有实测窗口值**的模型（36 条里缺
    //    `DeepSeek-V4.1-Flash` / `Kimi-K3.1-Pro` / `Step-5-Preview` 等），而本名单
    //    收的是「远端列了但已没人服务」的 id —— 两者本来就不是一个集合。
    //    真源是下面这份 2026-11-16 实测的远端清单。
    const REMOTE_2026_11_16 = [
      'MedAIBase/AntAngelMed',
      'MiniMax/MiniMax-M1-80k',
      'MiniMax/MiniMax-M3',
      'MusePublic/Qwen-Image-Edit',
      'OpenGVLab/InternVL3_5-241B-A28B',
      'PaddlePaddle/ERNIE-4.5-0.3B-PT',
      'PaddlePaddle/ERNIE-4.5-21B-A3B-PT',
      'PaddlePaddle/ERNIE-4.5-300B-A47B-PT',
      'PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT',
      'Qwen/Qwen-Image-Edit',
      'Qwen/Qwen3.5-122B-A10B',
      'Qwen/Qwen3.5-27B',
      'Qwen/Qwen3.5-35B-A3B',
      'Qwen/Qwen3.5-397B-A17B',
      'Qwen/Qwen3.8-27B',
      'Qwen/Qwen3.8-Flash-Next',
      'Shanghai_AI_Laboratory/Intern-S1',
      'Shanghai_AI_Laboratory/Intern-S1-mini',
      'Shanghai_AI_Laboratory/Intern-S2-Preview',
      'XGenerationLab/XiYanSQL-QwenCoder-32B-2412',
      'XGenerationLab/XiYanSQL-QwenCoder-32B-2504',
      'ZhipuAI/GLM-4.7-Flash',
      'ZhipuAI/GLM-5.2',
      'deepseek-ai/DeepSeek-V4-Flash-0731',
      'deepseek-ai/DeepSeek-V4-Pro',
      'deepseek-ai/DeepSeek-V4-Pro-0813',
      'deepseek-ai/DeepSeek-V4.1-Flash',
      'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      'early-access/EA-29B-A4B',
      'meituan-longcat/LongCat-Flash-Lite',
      'mistralai/Mistral-Large-Instruct-2407',
      'moonshotai/Kimi-K3.1-Pro',
      'nex-agi/Nex-N2.5-Pro',
      'nex-agi/Nex-N2.5-mini',
      'opencompass/CompassJudger-1-32B-Instruct',
      'stepfun-ai/Step-3.5-Flash',
      'stepfun-ai/Step-3.7-Flash',
      'stepfun-ai/Step-5-Preview',
    ]
    const remote = new Set(REMOTE_2026_11_16)
    const bogus = [...MODELSCOPE_RETIRED_MODEL_IDS].filter((id) => !remote.has(id))
    expect(bogus, '拼错的 id ⇒ 过滤静默失效，症状只是「那条还在列表里」').toEqual([])
    // 反向：这份清单确实覆盖了远端全部条目（否则上面那条形同虚设）
    expect(REMOTE_2026_11_16.length).toBe(38)
  })

  it('⚠️ 只收「has no provider supported」：授权类 / 404 / 超时一律不进名单', () => {
    // 这三类实测都存在，但都不是「模型下线」的证据：
    //   401/403（授权令牌无效、无权访问）、404 invalid_model（存在性/权限不可区分）、
    //   超时与 `invalid_parameter`（临时或用法问题）。
    for (const id of [
      'MedAIBase/AntAngelMed',                  // 401 授权令牌无效
      'Qwen/Qwen-Image-Edit',                   // 403
      'OpenGVLab/InternVL3_5-241B-A28B',        // 401
      'PaddlePaddle/ERNIE-4.5-0.3B-PT',         // 404 invalid_model
      'XGenerationLab/XiYanSQL-QwenCoder-32B-2412', // 400 要求 tools 参数
      'ZhipuAI/GLM-4.7-Flash',                  // 超时（推理慢）
    ]) {
      expect(MODELSCOPE_RETIRED_MODEL_IDS.has(id), id + ' 不该进已下线名单').toBe(false)
    }
  })

  /**
   * ⚠️⚠️ 2026-11-16（PR #92 双审计）：名单是**逐字**比较的，而远端的 id 会以
   * 各种书写形态出现。对抗审计实测：`DEEPSEEK-AI/DEEPSEEK-V4-PRO` /
   * `deepseek-ai/deepseek-v4-pro` / `deepseek-ai/DeepSeek-V4-Pro:free` /
   * `deepseek-ai//DeepSeek-V4-Pro` 四条**全部绕过逐字闸门**，而它们的
   * `normalizeModelKey` 都是 `deepseek-v4-pro` ⇒ 会并进那个**存活**的虚拟模型
   * 成为可轮换候选 ⇒ 聚合挑中即请求期 404，而虚模型名是活的，用户不会怀疑到魔搭。
   *
   * 危害比「那条还在列表里」重得多，所以过滤必须同时按**归一化键**查。
   */
  it('★★★ 书写变体（大小写 / -free / 双斜杠）也必须被剔除（逐字闸门会漏）', async () => {
    const entries = await loadModelscopeCatalog(
      fakeCatalog([
        'deepseek-ai/DeepSeek-V4-Pro',
        'DEEPSEEK-AI/DEEPSEEK-V4-PRO',
        'deepseek-ai/deepseek-v4-pro',
        'deepseek-ai/DeepSeek-V4-Pro:free',
        'deepseek-ai//DeepSeek-V4-Pro',
        'Qwen/Qwen3.8-27B', // 存活，必须保留 —— 否则过滤宽过头
      ]),
      'retired-filter-variants',
      0,
    )
    expect(entries.map((e) => e.id)).toEqual(['Qwen/Qwen3.8-27B'])
  })

  /**
   * ⚠️ P3-5（正向审计）：`listAllModels` 的**兜底**分支原先零用例 ——
   * 变异「直用 `MODELSCOPE_FALLBACK_MODELS.map`」（本 PR 之前就长这样）全绿，
   * 而已下线模型会重新出现在 Jet Hub 设置页且进 aggregate 候选表。
   * 这条断言必须走**真实 class 路径**（`syncCatalogEntries` → `fallbackEntries`），
   * 不能直接调模块级函数，否则测不到接线。
   */
  it('★★ listAllModels 的兜底分支（无远端缓存）也不吐已下线 id', () => {
    const adapter = new ModelscopeAdapter({
      product: MODELSCOPE,
      slots: async () => [{ id: 's1', apiKey: 'ms-0123456789abcdefghij' }],
    })
    const ids = adapter.listAllModels().map((m) => m.id)
    // 对照：兜底表本身非空（否则下面的断言恒真）
    expect(ids.length, '对照失败：兜底表被剔空了 ⇒ 本用例会假绿').toBeGreaterThan(0)
    for (const dead of MODELSCOPE_RETIRED_MODEL_IDS) expect(ids).not.toContain(dead)
    expect(ids).toContain('Qwen/Qwen3.8-27B')
  })

  /**
   * ⚠️ P3-6（正向审计）：`normalizeModelscopeModelId` 的 `trim()` 零用例 ——
   * 变异「去掉 trim」全绿。上游 id 带尾空格/制表符时，名单会漏剔。
   */
  it('★ 尾空格 / 制表符不得影响剔除（normalizeModelscopeModelId 的 trim 是承重的）', async () => {
    const entries = await loadModelscopeCatalog(
      fakeCatalog([
        'deepseek-ai/DeepSeek-V4-Pro ',
        '\tdeepseek-ai/DeepSeek-V4-Pro',
        'Qwen/Qwen3.8-27B',
      ]),
      'retired-filter-trim',
      0,
    )
    const ids = entries.map((e) => e.id)
    expect(ids.some((id) => id.trim() === 'deepseek-ai/DeepSeek-V4-Pro')).toBe(false)
    expect(ids).toContain('Qwen/Qwen3.8-27B')
  })

  /**
   * ⚠️ 上一条用例测不到 `trim()` 本身（归一化口径会给尾空格兜底），所以 `trim()`
   * 必须**直测纯函数** —— 变异「去掉 `raw.trim()`」在上一条用例下全绿。
   */
  it('★ normalizeModelscopeModelId 必须 trim（纯函数直测）', () => {
    expect(normalizeModelscopeModelId('  x  ')).toBe('x')
    expect(normalizeModelscopeModelId('\tx\t')).toBe('x')
    expect(normalizeModelscopeModelId('deepseek-ai/DeepSeek-V4-Pro ')).toBe('deepseek-ai/DeepSeek-V4-Pro')
    // 反向：不得顺手改大小写 / 剥命名空间（那会回流到发请求的 model 字段）
    expect(normalizeModelscopeModelId('DEEPSEEK-AI/DeepSeek-V4-Pro')).toBe('DEEPSEEK-AI/DeepSeek-V4-Pro')
  })
})
