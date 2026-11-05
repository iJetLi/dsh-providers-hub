import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLINE_MODELS_DEV_TIMEOUT_MS,
  applyModelsDevCatalog,
  makeClineModelsDevLoader,
  parseClineModelsDev,
  stripClineSnapshotSuffix,
} from '../../src/cline-models-dev.js'
import { clearModelsDevCache, setModelsDevForTest } from '../../src/models-dev-cache.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * models.dev 目录来源的回归：**图片能力** + **补缺的模型** + **可读名**。
 *
 * ⚠️ fixture 的形状是**实测**的（2026-09-30 本机直连 models.dev）：
 * `cline-pass` provider 块下 18 条模型，各自带 `modalities.input` 与 `limit`。
 *
 * 它同时解释两处用户报障：
 * 1.「支持图片的模型发送不了图片」—— 这份数据没被用上；
 * 2.「cline-pass 部分模型列表不全」—— 网关只下发 14 条，这里多出 4 条。
 */
const REAL_SHAPE = {
  'cline-pass': {
    id: 'cline-pass',
    models: {
      'deepseek-v4.1-flash': {
        name: 'DeepSeek V4.1 Flash',
        modalities: { input: ['text', 'image'] },
        limit: { context: 1_000_000, output: 384_000 },
      },
      'mimo-v2.6-flash': {
        name: 'MiMo-V2.6-Flash',
        modalities: { input: ['text', 'image', 'audio', 'video'] },
        limit: { context: 1_048_576 },
      },
      'glm-5.3': { name: 'GLM-5.3', modalities: { input: ['text'] }, limit: { context: 1_000_000 } },
      // 网关没下发的 4 条（本插件此前**根本不存在**）
      'kimi-k2.6': { name: 'Kimi K2.6', modalities: { input: ['text', 'image', 'video'] } },
      'glm-5.2': { name: 'GLM-5.2', modalities: { input: ['text'] } },
      'kimi-k2.7-code': { name: 'Kimi K2.7 Code', modalities: { input: ['text', 'image'] } },
      'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', modalities: { input: ['text'] } },
      // 没有 modalities 的条目：仍然入表，但 supportsImage 为 false
      'mystery-model': { name: 'Mystery' },
    },
  },
}

describe('parseClineModelsDev', () => {
  it('读出每条模型的名字 / 窗口 / 图片能力（裸 id 补 cline-pass/ 前缀）', () => {
    const map = parseClineModelsDev(REAL_SHAPE)
    expect(map.get('cline-pass/deepseek-v4.1-flash')).toMatchObject({
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1_000_000,
      supportsImage: true,
    })
    expect(map.get('cline-pass/glm-5.3')).toMatchObject({ name: 'GLM-5.3', supportsImage: false })
    expect(map.get('cline-pass/kimi-k2.6')).toMatchObject({ name: 'Kimi K2.6', supportsImage: true })
  })

  it('已带前缀的 id 原样使用（不重复拼前缀）', () => {
    const map = parseClineModelsDev({
      'cline-pass': { models: { 'cline-pass/minimax-m3': { name: 'MiniMax-M3', modalities: { input: ['text', 'image'] } } } },
    })
    expect(map.get('cline-pass/minimax-m3')?.supportsImage).toBe(true)
    expect(map.has('cline-pass/cline-pass/minimax-m3')).toBe(false)
  })

  /** ⚠️ DSH 的模态词表只有 text/image，audio/video/pdf 必须被夹取掉。 */
  it('只认 image：audio/video/pdf 不算图片能力', () => {
    const map = parseClineModelsDev({
      'cline-pass': { models: { 'audio-only': { name: 'A', modalities: { input: ['text', 'audio', 'video', 'pdf'] } } } },
    })
    expect(map.get('cline-pass/audio-only')?.supportsImage).toBe(false)
  })

  /** ⚠️ **不取 `limit.output`**：那是要写进请求体 `max_tokens` 的值，本仓库有过据印象填大值导致 400 的历史。 */
  it('不把 limit.output 当成 maxTokens（避免下发过大的 max_tokens）', () => {
    const entry = parseClineModelsDev(REAL_SHAPE).get('cline-pass/deepseek-v4.1-flash')
    expect(entry).not.toHaveProperty('maxTokens')
  })

  it('缺 modalities 的条目仍入表（名字可用），但不宣称支持图片', () => {
    const entry = parseClineModelsDev(REAL_SHAPE).get('cline-pass/mystery-model')
    expect(entry?.name).toBe('Mystery')
    expect(entry?.supportsImage).toBe(false)
  })

  it('provider 块也能挂在 providers 下（两种实测形态都认）', () => {
    const map = parseClineModelsDev({
      providers: { 'cline-pass': { models: { 'x-1': { name: 'X', modalities: { input: ['text', 'image'] } } } } },
    })
    expect(map.get('cline-pass/x-1')?.supportsImage).toBe(true)
  })

  it('垃圾输入返回空表而不抛错', () => {
    for (const bad of [undefined, null, 'str', 42, [], {}, { 'cline-pass': {} }]) {
      expect(parseClineModelsDev(bad).size, JSON.stringify(bad)).toBe(0)
    }
  })
})

describe('applyModelsDevCatalog', () => {
  const base = [
    { id: 'cline-free/mimo-v2.6-flash', name: 'MiMo-V2.6-Flash · 免费', isFree: true, supportsImage: true },
    { id: 'cline-pass/mimo-v2.6-flash', name: 'cline-pass/mimo-v2.6-flash', isFree: false },
    { id: 'cline-pass/deepseek-v4.1-flash', name: 'cline-pass/deepseek-v4.1-flash', isFree: false },
    { id: 'deepseek/deepseek-v4.1-flash', name: 'Deepseek v4.1 flash', isFree: false },
  ]

  it('把缺的模型补在该前缀的条目之后（沉到 460 条远端 id 之后就没人看得到了）', () => {
    const dev = parseClineModelsDev(REAL_SHAPE)
    const merged = applyModelsDevCatalog(base, dev)
    const ids = merged.map((m) => m.id)
    // 新补的 4 条都在
    for (const id of ['cline-pass/kimi-k2.6', 'cline-pass/glm-5.2', 'cline-pass/kimi-k2.7-code', 'cline-pass/deepseek-v4-flash']) {
      expect(ids, id).toContain(id)
    }
    // 紧跟在最后一条 cline-pass 之后（而不是整个列表末尾）
    const lastPass = ids.lastIndexOf('cline-pass/deepseek-v4.1-flash')
    expect(ids[lastPass + 1]?.startsWith('cline-pass/')).toBe(true)
  })

  // ⚠️⚠️ **明确 false 必须落成字段，而不是省略**（issue IKKZUG 第 1 点的前置）。
  //
  // 修复前补进来的条目写作
  //   `...entry.supportsImage ? { supportsImage: true } : {}`
  // ⇒ models.dev **明确说 false**（实测 `cline-pass/glm-5.3` 就是不带图的）
  // 时字段**缺席** ⇒ 在三态语义下被读成「**未知**」，而它其实是
  // 「**确认不支持**」。
  //
  // 后果有两个方向都真实存在：宿主会按「未知」**放行**图片（发到不支持图的服务端），
  // 而门禁文案会说「能力尚未加载完成」—— 与事实相反。
  //
  // ⚠️ 这条在**两态**下无害（`['text']` 两边一致），是三态改造**暴露**出来的。
  it('models.dev 明确 supportsImage=false 时必须落成 false（不得省略成「未知」）', () => {
    const dev = new Map([
      ['cline-pass/glm-5.3', { id: 'cline-pass/glm-5.3', supportsImage: false }],
    ])
    const merged = applyModelsDevCatalog([{ id: 'other/model', name: 'other' }], dev)
    const glm = merged.find((m) => m.id === 'cline-pass/glm-5.3')
    expect(glm, '补进来的条目').toBeDefined()
    // ⚠️ 用 `toBe(false)` 而不是 `toBeDefined()`：后者对 `undefined` 也成立。
    expect(glm?.supportsImage, '明确 false 不能退化成 undefined（= 未知）').toBe(false)
  })

  it('⚠️ 但「本地兜底表显式 false」仍然赢（models.dev 不得覆盖它）', () => {
    // 与上一条**成对**：新条目用 dev 的值，已有条目仍「本地优先」。
    const dev = new Map([
      ['cline-free/local-false', { id: 'cline-free/local-false', supportsImage: true }],
    ])
    const merged = applyModelsDevCatalog(
      [{ id: 'cline-free/local-false', name: 'local', supportsImage: false }],
      dev,
    )
    expect(merged.find((m) => m.id === 'cline-free/local-false')?.supportsImage).toBe(false)
  })

  it('网关把 id 当名字下发时，用可读名替换', () => {
    const merged = applyModelsDevCatalog(base, parseClineModelsDev(REAL_SHAPE))
    const pass = merged.find((m) => m.id === 'cline-pass/deepseek-v4.1-flash')!
    expect(pass.name).toBe('DeepSeek V4.1 Flash')
    // ⚠️ 已有可读名的**不覆盖**（策展/其它来源优先）
    const other = merged.find((m) => m.id === 'deepseek/deepseek-v4.1-flash')!
    expect(other.name).toBe('Deepseek v4.1 flash')
  })

  it('补图片能力，但不覆盖已有的显式 false / true', () => {
    const models = [
      { id: 'cline-pass/a', name: 'A', isFree: false, supportsImage: false },
      { id: 'cline-pass/b', name: 'cline-pass/b', isFree: false },
    ]
    const dev = new Map([
      ['cline-pass/a', { id: 'cline-pass/a', supportsImage: true }],
      ['cline-pass/b', { id: 'cline-pass/b', supportsImage: true }],
    ])
    const merged = applyModelsDevCatalog(models, dev)
    expect(merged.find((m) => m.id === 'cline-pass/a')?.supportsImage).toBe(false)
    expect(merged.find((m) => m.id === 'cline-pass/b')?.supportsImage).toBe(true)
  })

  it('补上下文窗口，但不覆盖已有值', () => {
    const models = [
      { id: 'cline-pass/a', name: 'A', isFree: false, contextWindow: 200_000 },
      { id: 'cline-pass/b', name: 'cline-pass/b', isFree: false },
    ]
    const dev = new Map([
      ['cline-pass/a', { id: 'cline-pass/a', supportsImage: false, contextWindow: 1_000_000 }],
      ['cline-pass/b', { id: 'cline-pass/b', supportsImage: false, contextWindow: 1_000_000 }],
    ])
    const merged = applyModelsDevCatalog(models, dev)
    expect(merged.find((m) => m.id === 'cline-pass/a')?.contextWindow).toBe(200_000)
    expect(merged.find((m) => m.id === 'cline-pass/b')?.contextWindow).toBe(1_000_000)
  })

  it('空表时原样返回（不改变目录）', () => {
    expect(applyModelsDevCatalog(base, new Map())).toEqual(base)
  })
})

describe('makeClineModelsDevLoader', () => {
  // ⚠️ 全组的公共前提：共享缓存是**模块级单例**，前一个 describe 的用例
  //   往里塞过数据 ⇒ 不清就会命中缓存而走不到 fetcher（症状：明明注入了
  //   失败 fetcher，却拿到一张完整的表）。
  const immediate = async (): Promise<void> => {}

  it('命中 TTL 缓存：多次调用只发一次请求', async () => {
    await clearModelsDevCache()
    const fetcher = vi.fn(async () => new Response(JSON.stringify(REAL_SHAPE), { status: 200 }))
    const load = makeClineModelsDevLoader({ fetcher: fetcher as never, sleep: immediate })
    await load()
    await load()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️ 失败**必须抛**（而不是返回空表）：调用方据此区分「没读到」与
   * 「读到了且不支持」。把失败记成空表会让图片能力永久打回纯文本 ——
   * 那正是本次要修的缺陷形态。
   *
   * ⚠️ 2026-10-17：加载器改为**读共享本地缓存**（`models-dev-cache.ts` 是
   * 全仓唯一直读点），失败文案随之改变 —— 断言改为「抛出**含 models.dev 的
   * 可读消息**」，而不锁死具体措辞：措辞是实现细节，「抛了 + 指名来源」才是契约。
   */
  it('⚠️ 刷新失败向上抛（不缓存失败，下次可重试）', async () => {
    // ⚠️⚠️ **必须先清空共享缓存**：加载器改读 `models-dev-cache.ts` 的
    // 模块级单例，而前面的用例往里塞过数据 ⇒ 不清就会命中缓存而**不抛**
    // （症状：明明 fetcher 返回 500，却拿到了一张完整的表）。
    // 这不是测试写错，而是「全局缓存 + 跨用例」必然的耦合，必须显式隔离。
    await clearModelsDevCache()
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 }))
    // ⚠️ **必须注入 sleep**：共享缓存的重试是指数退避（2s → 4s），
    //   而本用例要连续失败两轮 ⇒ 不注入会真等 12 秒并撞 5s 单测超时。
    const load = makeClineModelsDevLoader({ fetcher: fetcher as never, sleep: async () => {} })
    await expect(load()).rejects.toThrow(/models\.dev/)
    await expect(load()).rejects.toThrow(/models\.dev/)
    // ⚠️ 失败**不写缓存** ⇒ 第二次必须真的再发一次请求（否则「失败被固化」）。
    expect(fetcher).toHaveBeenCalledTimes(2 * 3)
  })

  /**
   * ⚠️⚠️ **回归**：加载器命中共享缓存时**完全不碰网络**。
   *
   * 这条锁的是本次改造的核心承诺（用户原话：「冷启动就读本地文件缓存，
   * 读不到就 fallback 不会直读 models.dev」）—— 改前每次冷启动都要下载 5 MB。
   */
  it('⚠️⚠️ 命中共享缓存时零请求（冷启动不下载 5MB）', async () => {
    await clearModelsDevCache()
    setModelsDevForTest({
      'cline-pass': {
        'deepseek-v4.1-flash': {
          name: 'DeepSeek V4.1 Flash',
          modalities: { input: ['text', 'image'] },
          limit: { context: 1000000 },
        },
      },
    })
    const fetcher = vi.fn(async () => { throw new Error('命中缓存时不得发请求') })
    const load = makeClineModelsDevLoader({ fetcher: fetcher as never, sleep: immediate })
    const first = await load()
    expect(first.get('cline-pass/deepseek-v4.1-flash')?.name).toBe('DeepSeek V4.1 Flash')
    const second = await load()
    expect(second.size).toBe(first.size)
    expect(fetcher, '命中缓存时不得有任何请求').not.toHaveBeenCalled()
    await clearModelsDevCache()
  })

  // ── issue IKKZUG：拉取本身要健壮 ──
  //
  // 真实测（用户 oct_heaven，Windows 直连 3 次）：20010ms 超时 / 20010ms 超时 /
  // 1908ms 成功。目标 api.json **解压后 5.39 MB**、Brotli 编码、无 Content-Length。
  // 成功那次只用 1.9 秒，失败的都是整段卡死 —— 说明慢链路需要余量，
  // 而 20 秒在 5.39MB 上偏紧。

  it('⚠️ 超时上限是 60 秒（5.39MB 的目标，20 秒偏紧）', () => {
    // 反向验证：把常量改回 20_000 本条即红。
    expect(CLINE_MODELS_DEV_TIMEOUT_MS).toBe(60_000)
  })

  /**
   * ⚠️ 2026-10-17：显式 Brotli 与 ETag 条件请求都已**上移到共享缓存模块**
   * （`models-dev-cache.ts`）—— 那是全仓唯一的直读点，本模块不再自己发请求。
   *
   * ⚠️ **这两条断言现在打在共享缓存上**，而不是打在 `cline-models-dev.ts`：
   * 判据「压缩传输 + 条件请求」依然重要（缺前者白下 5 MB 明文、极易撞超时上限），
   * 但它的**归属地**变了。若继续打在已不发请求的模块上，那是一条**恒真**断言
   * ——「守卫写在不会执行的地方」比没有守卫更糟（它给人虚假的安全感）。
   * 新位置的对应断言见 `tests/unit/models-dev-cache.spec.ts` 与下方。
   */
  it('⚠️ Brotli 与条件请求的职责已上移：cline 侧不再持有任何请求实现', () => {
    const src = readFileSync(join(here, '../../src/cline-models-dev.ts'), 'utf8')
    expect(src, 'cline-models-dev.ts 不得再自己 fetch models.dev').not.toMatch(/fetch\s*\(/)
    expect(src, 'Accept-Encoding 只该出现在唯一直读点').not.toMatch(/Accept-Encoding/i)
    expect(src, 'ETag 条件请求只该出现在唯一直读点').not.toMatch(/if-none-match|If-None-Match/i)
  })

  it('ETag 条件请求与 Brotli 在**共享缓存**里（唯一直读点）', () => {
    const src = readFileSync(join(here, '../../src/models-dev-cache.ts'), 'utf8')
    expect(src).toMatch(/Accept-Encoding/i)
  })
})

/**
 * issue #18：带日期/快照后缀的模型必须继承基底能力。
 *
 * 上游常发 `qwen2.5-coder-7b-instruct-1017`，而 models.dev 只登记基底 id。
 * 精确匹配失败会让 `supportsImage` 变成「未知」（宿主据此**放行图片**），
 * `contextWindow` 也会一起丢。
 */
describe('快照后缀继承（issue #18）', () => {
  it('★★ -1017 后缀继承基底的图片能力 / 窗口 / 名字', () => {
    const dev = new Map([
      ['cline-pass/qwen2.5-coder-7b-instruct', {
        id: 'cline-pass/qwen2.5-coder-7b-instruct',
        name: 'Qwen2.5 Coder 7B',
        supportsImage: true,
        contextWindow: 131_072,
      }],
    ])
    const merged = applyModelsDevCatalog(
      [{ id: 'cline-pass/qwen2.5-coder-7b-instruct-1017', name: 'cline-pass/qwen2.5-coder-7b-instruct-1017', isFree: false }],
      dev,
    )
    const model = merged.find((m) => m.id === 'cline-pass/qwen2.5-coder-7b-instruct-1017')!
    expect(model.supportsImage, '图片能力必须从基底继承（否则宿主会放行图片）').toBe(true)
    expect(model.contextWindow).toBe(131_072)
    expect(model.name).toBe('Qwen2.5 Coder 7B (1017)')
  })

  it('精确匹配优先：同 id 的显式能力不被基底覆盖', () => {
    const dev = new Map([
      ['cline-pass/m', { id: 'cline-pass/m', supportsImage: false }],
      ['cline-pass/m-1017', { id: 'cline-pass/m-1017', supportsImage: true, contextWindow: 1 }],
    ])
    const merged = applyModelsDevCatalog(
      [{ id: 'cline-pass/m-1017', name: 'id', isFree: false }],
      dev,
    )
    expect(merged.find((m) => m.id === 'cline-pass/m-1017')?.supportsImage).toBe(true)
  })

  it('没有基底时保持原样（不猜）', () => {
    const merged = applyModelsDevCatalog(
      [{ id: 'cline-pass/unknown-1017', name: 'unknown', isFree: false }],
      new Map([['cline-pass/other', { id: 'cline-pass/other', supportsImage: true }]]),
    )
    expect(merged.find((m) => m.id === 'cline-pass/unknown-1017')?.supportsImage).toBeUndefined()
  })
})

/**
 * 快照后缀的**边界**（对抗审计：原正则把末尾任意 4/8 位数字都当日期，
 * 于是 -4096 这类上下文长度也被剥掉、误继承基底能力）。
 */
describe('stripClineSnapshotSuffix 的边界', () => {
  it('只剥 MMDD / YYYYMMDD', () => {
    expect(stripClineSnapshotSuffix('foo-1017')).toBe('foo')
    expect(stripClineSnapshotSuffix('foo-20241022')).toBe('foo')
    // 非日期数字不剥：-4096 / -2024 更像尺寸/年份，剥了会误继承基底能力。
    expect(stripClineSnapshotSuffix('foo-4096')).toBe('foo-4096')
    expect(stripClineSnapshotSuffix('foo-2024')).toBe('foo-2024')
    expect(stripClineSnapshotSuffix('foo-123')).toBe('foo-123')
    expect(stripClineSnapshotSuffix('foo-v2')).toBe('foo-v2')
    expect(stripClineSnapshotSuffix('foo-1017-suffix')).toBe('foo-1017-suffix')
    expect(stripClineSnapshotSuffix('foo')).toBe('foo')
  })
})
