/**
 * CodeArts 的**图片输入**守卫（2026-10-21 接通，用户报障驱动）。
 *
 * ## 报障原文
 *
 * 「我们现在使用 codearts 发送图片后端模型不支持图片，发送带图的信息会直接跳出
 * 提示阻止发送信息，但是 codearts（IDE）发送识图任务是支持识图的」
 *
 * ## 真实机制（本机 IDE 内核日志 + 只读探测，2026-10-21）
 *
 * CodeArts 的模型分两类（`/v1/model/builtin` 的 `supports_images` 逐条实测）：
 *
 * | 模型 | `supports_images` | `model_category` |
 * |---|---|---|
 * | `kimi-k2.6-vl` / `Qwen3-VL-235B` | **true** | **图片理解** |
 * | `glm-5.3` / `GLM-5.2` / `openpangu-*` / `deepseek-v4.1-flash` / `glm-5.2-sft-harmony` | false | 文本生成 |
 *
 * ⇒ 文本模型**真的不能收图**（上游原文 `InferHub.001001020.406 The request model
 * is not multimodal`，本文件的反向对照用例复现它）。IDE 的做法是**两段式**：
 * 用 `fetchMultimodalModelId` 挑一个 VL 模型，由 `analyzeImage` 工具先看图、
 * 把结果变成文字，再交给主模型。
 *
 * ## 本仓的接法（与 IDE 同构的第一段）
 *
 * 1. VL 模型**仍不进对话目录**（上下文小、不支持工具调用），但 `resolveModel`
 *    对它们声明 `['text','image']` ⇒ 主模型可以按 id 借它们识图；
 * 2. 图片 wire 形态**实测只有一种被接受**（四选一，见 `codeartsImagePart` 注释）；
 * 3. 非 VL 模型**根本不读图片字节**（`codeartsAcceptsImage` 闸门）。
 *
 * ## 四条守卫各自的「有牙」判据
 *
 * | 守卫 | 若把生产代码改坏 | 为什么有牙 |
 * |---|---|---|
 * | ① VL 模型声明 image | 改回恒 `['text']` ⇒ DSH 在入库阶段拒图 | 断言 `includes('image')` |
 * | ② 文本模型**不**声明 image | 给所有模型都加 image ⇒ 用户能选 glm-5.3 发图、上游 406 | 断言 `not.toContain('image')` |
 * | ③ VL 模型仍在目录外 | 把它们放进 `listModels` ⇒ 用户可选中当主模型（回归） | 断言目录 id 集合**不含**它们 |
 * | ④ `prepareCall` 不覆盖模态 | 加回 `inputModalities: ['text']` 硬覆盖 ⇒ ① 被静默抹平 | 断言 `prepareCall().model` 与 `resolveModel()` **一致** |
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  CODEARTS_FALLBACK_CONTEXT_WINDOW,
  CodeArtsAdapter,
  codeartsAcceptsImage,
  codeartsImagePart,
  codeartsVisionModel,
} from '../../src/llm-adapter.js'
import {
  codeartsIsVisionModel,
  resetCodeartsImageModels,
  setCodeartsImageModels,
} from '../../src/codearts-vision.js'
import { fetchCodeArtsRemoteModels, SNAP_AGENT_CENTER_DETAIL_URL, SNAP_AGENT_CENTER_USERAGENTS_URL, SNAP_MODEL_BUILTIN_URL } from '../../src/models.js'
import type { CodeArtsCredential } from '../../src/types.js'

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** 造适配器；`readImage` 可选（用来观察「非 VL 模型到底读不读字节」）。 */
function makeAdapter(options: {
  remote?: Array<{ id: string; name: string }>
  readImage?: (ref: unknown) => Promise<{ data: Uint8Array; mediaType: string }>
} = {}) {
  return new CodeArtsAdapter({
    credentialRef: 'CODEARTS_ACCESS_TOKEN',
    resolveCredential: async () => validCredential,
    refresh: async () => {},
    fetchImpl: async () => new Response('not found', { status: 404 }),
    ...options.remote === undefined
      ? { fetchRemoteModels: async () => { throw new Error('offline') } }
      : { fetchRemoteModels: async () => options.remote },
    ...options.readImage === undefined ? {} : { readImage: options.readImage },
  })
}

describe('CodeArts 图片输入：模态声明', () => {
  /**
   * 守卫 ①：**VL 模型必须声明 `image`**。
   *
   * ⚠️ 这是「能不能发图」的总闸门 —— DSH 的图片准入读的就是它
   *（官方 `read_image` 的 `assertImageCapableRoute` 同源判据）。
   * 改回恒 `['text']` 会让用户在入库阶段就被拒，请求根本不发出。
   */
  it('① VL 模型（kimi-k2.6-vl / Qwen3-VL-235B）声明 image 模态', async () => {
    const adapter = makeAdapter({
      remote: [
        { id: 'kimi-k2.6-vl', name: 'Kimi-K2.6-VL' },
        { id: 'Qwen3-VL-235B', name: 'Qwen3-VL-235B' },
      ],
    })
    for (const id of ['kimi-k2.6-vl', 'Qwen3-VL-235B']) {
      const resolved = await adapter.resolveModel('codearts', id)
      expect({ id, modalities: resolved.inputModalities }).toEqual({ id, modalities: ['text', 'image'] })
    }
  })

  /**
   * 守卫 ①b：目录 `supports_images: false`、但 **wire 实测能收图**的主模型。
   *
   * 2026-11-05 真机（`image_url` 直发，4×4 纯色 PNG）：
   * - `deepseek-v4.1-flash-1017` + 红 → 200，「红色」；
   * - `deepseek-v4.1-flash` + 蓝 → 200，「蓝色」；
   * - `glm-5.3` 对照 → 406 not multimodal。
   *
   * ⚠️ 这些模型**不是**专职 VL：必须继续拿得到 `analyzeImage`（`codeartsIsVisionModel`
   * 为 false），否则「能收图」和「该挂识图工具」会被混为一谈。
   */
  it('①b 目录标 false 但实测能收图的主模型（deepseek-v4.1-flash / -1017）', async () => {
    const adapter = makeAdapter({
      remote: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
        { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017' },
        { id: 'glm-5.3', name: 'GLM-5.3' },
      ],
    })
    for (const id of ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017']) {
      const resolved = await adapter.resolveModel('codearts', id)
      expect({ id, modalities: resolved.inputModalities }).toEqual({ id, modalities: ['text', 'image'] })
      expect(codeartsIsVisionModel(id), `${id} 不该被当成专职 VL`).toBe(false)
    }
    // 有条目但目录没标、又不在覆盖表里的模型仍是纯文本。
    expect(codeartsAcceptsImage('glm-5.3')).toBe(false)
  })

  /**
   * 守卫 ②：**文本模型不得声明 `image`**（反向对照）。
   *
   * ⚠️ 这一条与 ① 同等重要：若「所有模型都给 image」，用户就能选 `glm-5.3` 发图，
   * 而实测上游会回 `InferHub.001001020.406 The request model is not multimodal`
   * ⇒ **每一轮带图对话都失败**，且错误信息看不出是「这个模型不收图」。
   *
   * ⚠️ `deepseek-v4.1-flash` 已**不在**本组：2026-11-05 wire 实测它能收图
   *（见 ①b），旧断言基于 2026-10-26 的目录数据，已过期。
   */
  it('② 文本模型不声明 image（上游实测会 406 拒绝）', async () => {
    const adapter = makeAdapter({
      remote: [
        { id: 'glm-5.3', name: 'GLM-5.3' },
        { id: 'GLM-5.2', name: 'GLM-5.2' },
      ],
    })
    for (const id of ['glm-5.3', 'GLM-5.2']) {
      const resolved = await adapter.resolveModel('codearts', id)
      expect({ id, modalities: resolved.inputModalities }).toEqual({ id, modalities: ['text'] })
    }
  })

  /**
   * 守卫 ③：**VL 模型仍不进对话目录**（回归守卫）。
   *
   * ⚠️ 它们上下文小、不支持工具调用，当 agent 主模型会踩别的坑 —— 这是本家
   * 一直以来的刻意过滤（`-VL-` / `-vl` 判据）。接图片时**很容易顺手把它们
   * 放进目录**（那样"发图"确实也能用），但那是**另一个行为变更**，不在本次范围。
   */
  it('③ VL 模型仍被排除在对话目录外（但可按 id 解析）', async () => {
    const adapter = makeAdapter({
      remote: [
        { id: 'glm-5.3', name: 'GLM-5.3' },
        { id: 'kimi-k2.6-vl', name: 'Kimi-K2.6-VL' },
        { id: 'Qwen3-VL-235B', name: 'Qwen3-VL-235B' },
      ],
    })
    const ids = (await adapter.listModels('codearts')).map((m) => m.id)
    expect(ids).toContain('glm-5.3')
    expect(ids).not.toContain('kimi-k2.6-vl')
    expect(ids).not.toContain('Qwen3-VL-235B')
    // 但 `resolveModel` 仍认它们（识图工具要按 id 借它们）。
    expect((await adapter.resolveModel('codearts', 'kimi-k2.6-vl')).context)
      .toEqual({ contextWindow: CODEARTS_FALLBACK_CONTEXT_WINDOW })
  })

  /**
   * 守卫 ④：`prepareCall` **不得覆盖** `resolveModel` 算出的模态。
   *
   * ⚠️⚠️ 这条是接图片时发现的**真缺陷**：原代码是
   * `{ ...await this.resolveModel(...), inputModalities: ['text'] }` ——
   * 硬覆盖。只要目录开始按模型区分模态，这一行就会**静默抹平**，
   * 症状是「VL 模型明明声明了 image，发图仍被 DSH 拒掉」，且两处代码各自看都对。
   */
  it('④ prepareCall 的模态与 resolveModel 一致（不得硬覆盖成 text）', async () => {
    const adapter = makeAdapter({
      remote: [
        { id: 'kimi-k2.6-vl', name: 'Kimi-K2.6-VL' },
        { id: 'glm-5.3', name: 'GLM-5.3' },
      ],
    })
    for (const id of ['kimi-k2.6-vl', 'glm-5.3']) {
      const direct = await adapter.resolveModel('codearts', id)
      const prepared = await adapter.prepareCall('codearts', id)
      expect({ id, modalities: prepared.model.inputModalities })
        .toEqual({ id, modalities: direct.inputModalities })
    }
  })
})

describe('CodeArts 图片输入：能力判定与 wire 形态', () => {
  /**
   * 守卫 ⑤：`codeartsAcceptsImage` **大小写不敏感**。
   *
   * ⚠️ 上游目录里两种写法都出现过（`kimi-k2.6-vl` 全小写、`Qwen3-VL-235B` 混合
   * 大小写），而用户手填的 id 大小写不可控 ⇒ 判据必须归一化，否则
   * 「手填 `Kimi-K2.6-VL`」会被判成不支持图片。
   */
  it('⑤ 能力判定大小写不敏感，且不误判文本模型', () => {
    expect(codeartsAcceptsImage('kimi-k2.6-vl')).toBe(true)
    expect(codeartsAcceptsImage('Kimi-K2.6-VL')).toBe(true)
    expect(codeartsAcceptsImage('Qwen3-VL-235B')).toBe(true)
    expect(codeartsAcceptsImage('qwen3-vl-235b')).toBe(true)
    expect(codeartsAcceptsImage(' kimi-k2.6-vl ')).toBe(true)
    // 反向：文本模型与「长得像但不是」的 id 都不能放行。
    expect(codeartsAcceptsImage('glm-5.3')).toBe(false)
    expect(codeartsAcceptsImage('GLM-5.2')).toBe(false)
    // 覆盖表：大小写不敏感（目录/手填都可能大小写漂移）。
    expect(codeartsAcceptsImage('deepseek-v4.1-flash')).toBe(true)
    expect(codeartsAcceptsImage('DeepSeek-V4.1-Flash-1017')).toBe(true)
    expect(codeartsAcceptsImage('kimi-k2.6')).toBe(false)
  })

  /**
   * 守卫 ⑥：wire 形态**必须是 OpenAI 的「对象套 url」**。
   *
   * ⚠️ 这是实测四选一的结果（见 `codeartsImagePart` 注释）：
   * 字符串形态 / `{type:'image'}` / `{type:'input_image'}` 全部被拒。
   * 本用例把「必须的形状」逐字钉住 —— 若有人「顺手简化」成字符串形态，
   * 上游会回 406 且错误信息（`multimodal content ... incorrect`）**指不出**
   * 是哪个字段错了。
   */
  it('⑥ codeartsImagePart 产出 image_url 对象形态（唯一被接受的形状）', () => {
    const url = 'data:image/png;base64,AAAA'
    const part = codeartsImagePart(url)
    expect(part).toEqual({ type: 'image_url', image_url: { url } })
    // 反向对照：字符串形态**不是**本函数的产物（它是被拒的那种）。
    expect(typeof (part as { image_url: unknown }).image_url).toBe('object')
  })

  /** 守卫 ⑦：识图用的 VL 模型是 IDE 自己选的那个（不是我们猜的）。 */
  it('⑦ 识图模型是 kimi-k2.6-vl（IDE fetchMultimodalModelId 的实测选择）', () => {
    expect(codeartsVisionModel()).toBe('kimi-k2.6-vl')
    expect(codeartsAcceptsImage(codeartsVisionModel())).toBe(true)
  })
})

/**
 * CodeArts 图片输入：**跟随远端目录**新增的多模态模型（2026-10-26 报障驱动）。
 *
 * ## 报障原文
 *
 * 「codearts/kimi-k3 不支持图片，但官方是支持的」
 *
 * ## 根因
 *
 * `codeartsAcceptsImage` 原**只查静态表** `CODEARTS_VL_MODELS`（两个老 VL 模型）。
 * 而上游会持续新增/替换多模态模型，静态表**不会自己更新** ⇒ 新模型一上线就必然
 * 被判成「不能收图」：`inputModalities` 被声明成 `['text']` ⇒ DSH 在**图片入库
 * 阶段**就拒掉，请求根本发不到上游 —— 用户看到的正是「提示阻止发送」。
 *
 * ⇒ 判据改为「远端目录 `supports_images` **∪** 静态表」。
 */
describe('CodeArts 图片输入：跟随远端目录新增的多模态模型', () => {
  // ⚠️ `catalogImageModels` 是**模块级单例**状态，会跨用例、甚至跨测试文件残留
  //    ⇒ 每个用例后必须清掉，否则本文件的断言会把「能收图」泄漏到别处。
  afterEach(() => {
    resetCodeartsImageModels()
  })

  /**
   * 守卫 ⑧：本条是**这次报障的核心** —— 静态表里没有、但远端标了
   * `supports_images: true` 的模型必须能收图。
   *
   * ⚠️ 有牙：把判据改回「只查静态表」⇒ 第二条断言变红。
   */
  it('⑧ 静态表没有、但远端标了 supports_images 的模型能收图（kimi-k3）', () => {
    expect(
      codeartsAcceptsImage('kimi-k3'),
      '灌入目录前：静态表不含 kimi-k3 ⇒ 不能收图（这正是用户报的现象）',
    ).toBe(false)
    setCodeartsImageModels(['kimi-k3'])
    expect(codeartsAcceptsImage('kimi-k3'), '灌入后：远端说它能收 ⇒ 必须能收').toBe(true)
  })

  /** 守卫 ⑨：目录里**没**标 true 的模型仍不能收图 —— 别把并集写成「全都放行」。 */
  it('⑨ 目录未标 true 的模型仍不能收图（不误放行）', () => {
    setCodeartsImageModels(['kimi-k3'])
    expect(codeartsAcceptsImage('glm-5.3')).toBe(false)
    expect(codeartsAcceptsImage('GLM-5.2')).toBe(false)
    // ⚠️ `deepseek-v4.1-flash` 不在这组：它在覆盖表里（wire 实测能收图）。
    expect(codeartsAcceptsImage('deepseek-v4.1-flash')).toBe(true)
  })

  /**
   * 守卫 ⑩：判据是**并集**，不是「目录加载后以目录为准」。
   *
   * ⚠️ 有牙：改成以目录为准 ⇒ 这两条变红。而走那条路的后果是：上游某天不再
   *   下发 `supports_images`，`kimi-k2.6-vl` 就从「能收图」变成「不能」，
   *   `analyzeImage` 借它识图的整条链路当场失效。
   */
  it('⑩ 并集：目录加载后静态表里的老模型仍可收图', () => {
    setCodeartsImageModels(['kimi-k3'])
    expect(codeartsAcceptsImage('kimi-k2.6-vl')).toBe(true)
    expect(codeartsAcceptsImage('Qwen3-VL-235B')).toBe(true)
  })

  /** 守卫 ⑪：目录 id 的大小写/空白归一（上游两种写法都出现过）。 */
  it('⑪ 目录 id 大小写与空白归一', () => {
    setCodeartsImageModels(['Kimi-K3'])
    expect(codeartsAcceptsImage('kimi-k3')).toBe(true)
    expect(codeartsAcceptsImage(' kimi-k3 ')).toBe(true)
  })

  /** 守卫 ⑫：清空后回退静态表（= 目录从未加载成功时的行为，不得回归）。 */
  it('⑫ 清空后回退静态表', () => {
    setCodeartsImageModels(['kimi-k3'])
    resetCodeartsImageModels()
    expect(codeartsAcceptsImage('kimi-k3')).toBe(false)
    expect(codeartsAcceptsImage('kimi-k2.6-vl'), '静态表兜底仍生效').toBe(true)
  })

  /**
   * 守卫 ⑬：**端到端** —— 目录拉取真的把 `supports_images` 灌进了判据。
   *
   * ⚠️ 这条覆盖前面 5 条**都覆盖不到**的一处：`models.ts` 必须在
   *    `parseModelInfo` 过滤 `-VL` **之前**收集 —— 因为能收图的恰恰是那批
   *    VL 模型，它们被丢出目录后、走 `models` 数组根本看不到 ⇒ 漏了这一步，
   *    `kimi-k2.6-vl` 就会失去 image 能力，`analyzeImage` 随之失效。
   *
   * ⚠️ 有牙：把收集挪到 `parseModelInfo` 之后 ⇒ 倒数第二条断言变红。
   */
  it('⑬ 端到端：目录拉取把 supports_images 灌进判据（含被 -VL 过滤的模型）', async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === SNAP_MODEL_BUILTIN_URL) {
        return new Response(JSON.stringify({
          builtinModels: [
            { model_id: 'kimi-k3', model_name: 'Kimi-K3', supports_images: true },
            { model_id: 'glm-5.3', model_name: 'GLM-5.3', supports_images: false },
            // ⚠️ 会被 parseModelInfo 的 `-VL` 判据丢出目录，但**必须**仍记为能收图。
            //
            //    两个 id 形态都是刻意挑的：
            //    · 必须**大写** `-VL` 结尾 —— 判据只认 `-VL-` / `-VL`（大写），
            //      实测小写 `-vl`（真机 `kimi-k2.6-vl` 正是小写）会**逃过过滤**
            //      留在目录里（既有行为，非本次引入，此处不擅自改判据）；
            //    · 必须**不在静态表里** —— `kimi-k2.6-vl` / `Qwen3-VL-235B` 都在
            //      静态表，收集漏了也会被兜底判成 true ⇒ 断言**没有牙**。
            { model_id: 'kimi-k4-VL', model_name: 'Kimi-K4-VL', supports_images: true },
          ],
        }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch

    const models = await fetchCodeArtsRemoteModels(validCredential, fetcher)
    const ids = models.map((m) => m.id)
    expect(ids, 'kimi-k3 不带 -VL 后缀 ⇒ 进目录').toContain('kimi-k3')
    expect(ids, 'kimi-k4-VL 大写 -VL 结尾 ⇒ 被丢出目录').not.toContain('kimi-k4-VL')
    expect(codeartsAcceptsImage('kimi-k3'), '远端标 true ⇒ 能收图').toBe(true)
    expect(
      codeartsAcceptsImage('kimi-k4-VL'),
      '虽被丢出目录，仍须能收图 ⇒ 收集必须发生在 -VL 过滤之前',
    ).toBe(true)
    expect(codeartsAcceptsImage('glm-5.3'), '远端标 false ⇒ 不放行').toBe(false)
  })

  /**
   * 守卫 ⑭：**AgentCenter 通道**的 `supports_images` 也要灌进判据（2026-10-31 审计修）。
   *
   * ⚠️⚠️ 本用例的形状与真实上游**一致**：`kimi-k3` **只在 AgentCenter 出现**
   *    （builtin 漏发 —— 真实上游就是这么下发的，见
   *    `providers-codearts.md` 的漂移表），且 master 已把它移出兜底目录
   *    ⇒ 若 AgentCenter 通道不收，它**永远**进不了判定集（⑬ 的 fixture 把
   *    kimi-k3 放在 builtin 里，测的是理想化输入，盖不住这条真实路径）。
   *
   * ⚠️ 两个通道必须**并集**：本用例 builtin 只给 glm-5.3（不能收图）、
   *    AgentCenter 给 kimi-k3 + `kimi-k5-ac-VL`（能收图）⇒
   *    若 AgentCenter 单独灌并覆盖 builtin，或反之，断言都会红。
   *
   * ⚠️ 有牙：删掉 AgentCenter 收集腿 ⇒ 最后一条红；把并集改回「各自灌」
   *    （AgentCenter 后灌覆盖 builtin）⇒ 倒数第二条红。
   */
  it('⑭ AgentCenter 通道的 supports_images 也灌进判据（kimi-k3 真实路径），与 builtin 并集', async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === SNAP_AGENT_CENTER_USERAGENTS_URL) {
        // 与 fetchAgentCenterWindows 的解析口径一致：agents[]，取 primary。
        return new Response(JSON.stringify({
          agents: [{ agent_id: 'ag-1', is_primary_agent: true }],
        }), { status: 200 })
      }
      if (url.startsWith(SNAP_AGENT_CENTER_DETAIL_URL)) {
        // 与真机实测条目键集同形：gpts.models[] 带 model_alias + model_parameters。
        return new Response(JSON.stringify({
          gpts: { models: [
            {
              model_alias: 'kimi-k3', model_name: 'Kimi K3',
              model_parameters: { context_window: 1048576, supports_images: true },
            },
            {
              // 大写 -VL 结尾 ⇒ 与目录层过滤同口径被丢（但它要能收图）。
              model_alias: 'kimi-k5-ac-VL', model_name: 'Kimi K5 AC VL',
              model_parameters: { context_window: 1048576, supports_images: true },
            },
            {
              // 带窗口但不带图能力 ⇒ 不得被灌进图片集合。
              model_alias: 'glm-5.3', model_name: 'GLM 5.3',
              model_parameters: { context_window: 1048576 },
            },
          ] },
        }), { status: 200 })
      }
      if (url === SNAP_MODEL_BUILTIN_URL) {
        // builtin 刻意**不含** kimi-k3（与真实上游一致），只给一个不能收图的。
        return new Response(JSON.stringify({
          builtinModels: [
            { model_id: 'glm-5.2', model_name: 'GLM-5.2', supports_images: false },
          ],
        }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch

    const models = await fetchCodeArtsRemoteModels(validCredential, fetcher)
    const ids = models.map((m) => m.id)
    expect(ids, 'kimi-k3 是 windowOnly 条目（AgentCenter 有、目录没有）').toContain('kimi-k3')
    expect(codeartsAcceptsImage('kimi-k3'), 'AgentCenter 标 true ⇒ 能收图（真实报障路径）').toBe(true)
    expect(
      codeartsAcceptsImage('kimi-k5-ac-VL'),
      'AgentCenter 的 -VL 条目同样要在 -VL 过滤前收走',
    ).toBe(true)
    expect(codeartsAcceptsImage('glm-5.3'), 'AgentCenter 未标 ⇒ 不放行').toBe(false)
    expect(codeartsAcceptsImage('glm-5.2'), 'builtin 标 false ⇒ 不放行').toBe(false)
  })

  /**
   * 守卫 ⑮：**空集不清空**（2026-10-31 审计 P2 修）——「只增不减」的兑现。
   *
   * ⚠️ 场景：本轮目录拉取成功但上游某端点漏发/该账号无下发 ⇒ 灌入收到空数组。
   *    若空集直接覆盖，所有目录派生的多模态模型瞬间失去收图能力。
   *    修后语义：空集 + 已有非空集合 ⇒ 保持原集合；真空集从零开始仍可灌（首灌）。
   */
  it('⑮ 空集不清空已有集合；首次空灌后回退静态表', () => {
    setCodeartsImageModels(['kimi-k3'])
    setCodeartsImageModels([])
    expect(codeartsAcceptsImage('kimi-k3'), '空集不得清空已有能力').toBe(true)
    resetCodeartsImageModels()
    setCodeartsImageModels([])
    // ⚠️ 「首次空灌」的可观测行为与「从未加载」相同：都回退静态表。
    //    `kimi-k2.6-vl` 在静态表里 ⇒ true 是**正确**行为（不是缺陷）；
    //    `kimi-k3` 不在静态表 ⇒ false（证明目录集合确实没塞进它）。
    expect(codeartsAcceptsImage('kimi-k2.6-vl'), '静态表兜底仍生效').toBe(true)
    expect(codeartsAcceptsImage('kimi-k3'), '静态表没有 kimi-k3 ⇒ false').toBe(false)
  })
})
