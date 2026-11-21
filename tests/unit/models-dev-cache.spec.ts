/**
 * models.dev 本地缓存的守卫（Issue IKM9LR，用户要求 2026-10-17）。
 *
 * 覆盖四条不变式，其中前两条是**源码扫描**（因为「唯一直读点」这件事
 * 只能靠扫全目录守住 —— 行为用例挡不住「新增了一个直连的 provider」）：
 *
 * 1. **全仓唯一直读点**：URL 字面量只允许出现在 `models-dev-cache.ts`；
 * 2. 消费方**不发起请求**：opencode / cline 侧没有任何 fetch；
 * 3. **冷启动只读文件**（同步），失败降级到本地表而非卡住；
 * 4. 刷新失败**不覆盖**既有缓存。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearModelsDevCache,
  MODELS_DEV_CACHED_PROVIDERS,
  MODELS_DEV_DEADLOCK_MS,
  MODELS_DEV_MAX_ATTEMPTS,
  MODELS_DEV_TTL_MS,
  MODELS_DEV_URL,
  MODELS_DEV_WORST_CASE_MS,
  parseModelsDev,
  primeModelsDev,
  readProviderModelsSync,
  readModelsDevSync,
  refreshModelsDev,
  refreshModelsDevAsync,
  setModelsDevForTest,
} from '../../src/models-dev-cache.js'
import {
  isFreeOpencodeModel,
  isReachableOpencodeModel,
  setRemoteOpencodeFreeFlags,
  setRemoteOpencodeReachability,
} from '../../src/opencode-product.js'
import { getOpencodeCapabilitiesSync, invalidateOpencodeCapabilities } from '../../src/opencode-capability.js'

const SRC = join(process.cwd(), 'src')

/** 剥掉注释（判据必须打在**行为**上，而不是注释里出现过的那几个字）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('唯一直读点（源码扫描）', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'))

  it('models.dev 的 URL 字面量只允许出现在 models-dev-cache.ts', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file === 'models-dev-cache.ts') continue
      const body = stripComments(readFileSync(join(SRC, file), 'utf8'))
      // 只认「真在发请求」的形态：URL 紧跟 fetch/fetcher 调用。
      // ⚠️ 不能只判字面量存在 —— `opencode-product.ts` 与 `cline-models-dev.ts`
      //   都**刻意**保留了该字面量只为文档可读性（它们不再发起请求）。
      if (/fetch\w*\s*\(\s*['"`]https:\/\/models\.dev/.test(body)
        || /fetch\w*\s*\(\s*[A-Z_]*MODELS_DEV_URL/.test(body)) {
        offenders.push(file)
      }
    }
    expect(offenders, `这些文件在直连 models.dev，应改走 models-dev-cache：${offenders.join(', ')}`).toEqual([])
  })

  it('消费方模块里没有任何 fetch 调用', () => {
    // opencode-capability 与 cline-models-dev 是两个消费方；
    // 它们若各自 fetch，就回到了「两套同义判据」的形态。
    for (const file of ['opencode-capability.ts', 'cline-models-dev.ts']) {
      const body = stripComments(readFileSync(join(SRC, file), 'utf8'))
      expect(/[^.\w]fetch\s*\(/.test(body), `${file} 不应再自己 fetch`).toBe(false)
    }
  })

  it('⚠️⚠️ 不得引入 OpenRouter 作为第二目录源（实测否决，用户提议过）', () => {
    // 用户 2026-10-17 提议用 openrouter.ai/api/v1/models 当备份，实测核对后否决：
    //   ① 470 条里 **0 条**有 `provider.api` —— 而它是协议可达性的唯一权威来源，
    //      并进来会让 `chatProtocol` 变 undefined ⇒ 退回本地表 ⇒ 等于没修 IKM9LR；
    //   ② id 命名空间与 opencode **零重叠**（`*opencode*` / `*zen*` 匹配 0 条）。
    // ⚠️ 判据扫的是**真实代码**（剥注释），故 `cline-models.ts` 里那句
    //   「openrouter/free 这类 id」的既有注释不会误伤。
    const offenders: string[] = []
    for (const file of files) {
      const body = stripComments(readFileSync(join(SRC, file), 'utf8'))
      if (/fetch\w*\s*\(\s*['"`]https:\/\/openrouter\.ai/.test(body)
        || /['"`]https:\/\/openrouter\.ai\/api\/v1\/models['"`]/.test(body)) {
        offenders.push(file)
      }
    }
    expect(offenders, `这些文件引入了 OpenRouter 目录源（实测已否决）：${offenders.join(', ')}`).toEqual([])
  })
})

describe('parseModelsDev', () => {
  it('认两种 provider 块位置（顶层直挂 / providers 下嵌）', () => {
    const entry = { name: 'X', limit: { context: 100 } }
    expect(Object.keys(parseModelsDev({ 'cline-pass': { models: { a: entry } } })['cline-pass'] ?? {})).toEqual(['a'])
    expect(Object.keys(parseModelsDev({ providers: { 'cline-pass': { models: { a: entry } } } })['cline-pass'] ?? {})).toEqual(['a'])
  })

  it('⚠️ 投影保留 provider.api（协议可达性的唯一来源）', () => {
    const parsed = parseModelsDev({
      opencode: { models: { m: { name: 'M', provider: { api: 'https://opencode.ai/inference/openai/v1' } } } },
    })
    expect(parsed.opencode?.m?.provider?.api).toBe('https://opencode.ai/inference/openai/v1')
  })

  it('非对象 / 空响应都返回空表（不抛）', () => {
    expect(parseModelsDev(null)).toEqual({})
    expect(parseModelsDev('nope')).toEqual({})
    expect(parseModelsDev({})).toEqual({})
  })

  it('⚠️⚠️ 只解析白名单里的 provider（实测踩过：整份落盘 2.6MB / 8993 条）', () => {
    const parsed = parseModelsDev({
      opencode: { models: { a: { name: 'A' } } },
      'cline-pass': { models: { b: { name: 'B' } } },
      // 未登记的 provider 必须被丢弃：它不该进内存、更不该落盘。
      openrouter: { models: { c: { name: 'C' } } },
    })
    expect(Object.keys(parsed).sort()).toEqual(['cline-pass', 'opencode'])
    expect(parsed.openrouter, '未登记的 provider 不得进入缓存').toBeUndefined()
  })

  it('⚠️ 白名单覆盖当前所有消费方（新增 provider 忘了登记 ⇒ 那家永远读到空）', () => {
    // 扫描消费方读过的 provider 名，逐个点名必须在白名单里。
    const consumers = ['opencode-capability.ts', 'cline-models-dev.ts']
    const missing: string[] = []
    for (const file of consumers) {
      const body = stripComments(readFileSync(join(SRC, file), 'utf8'))
      for (const m of body.matchAll(/readProviderModelsSync\(\s*'([^']+)'/g)) {
        if (!(MODELS_DEV_CACHED_PROVIDERS as readonly string[]).includes(m[1]!)) missing.push(`${file}:${m[1]}`)
      }
    }
    expect(missing, `这些 provider 未登记进缓存白名单，会永远读到空块：${missing.join(', ')}`).toEqual([])
  })
})

describe('读取路径（永不同步联网）', () => {
  beforeEach(() => {
    setModelsDevForTest({})
  })
  afterEach(async () => {
    await clearModelsDevCache()
    setRemoteOpencodeReachability(undefined)
    setRemoteOpencodeFreeFlags(undefined)
  })

  it('⚠️ readModelsDevSync 是同步的，返回内存里的 provider 块', () => {
    setModelsDevForTest({ opencode: { a: { name: 'A' } } })
    expect(readProviderModelsSync('opencode').a?.name).toBe('A')
    expect(Object.keys(readModelsDevSync())).toEqual(['opencode'])
  })

  it('未注入任何缓存时返回空表（不抛、不联网）', () => {
    expect(readProviderModelsSync('opencode')).toEqual({})
  })

  it('⚠️ 磁盘无缓存时 primeModelsDev 不抛（降级到本地兜底表）', () => {
    const fetcher = vi.fn(async () => { throw new Error('不应该被调用') })
    // 用注入的 fetcher 证明「读不到磁盘」这条路径不依赖网络：
    // primeModelsDev 内部走的是全局 fetch，这里只断言它不抛。
    expect(() => { primeModelsDev() }).not.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('刷新：TTL / 去重 / 失败不覆盖', () => {
  // ⚠️ 失败路径会触发指数退避（2s → 4s）；注入立即 resolve 的 sleep，
  //   否则三次全败的用例会真等 6 秒并撞上 vitest 的 5s 超时。
  const immediate = async (): Promise<void> => {}
  beforeEach(() => {
    setModelsDevForTest({ opencode: { old: { name: 'Old' } } })
  })
  afterEach(async () => {
    await clearModelsDevCache()
  })

  it('失败时保留既有缓存（绝不覆盖成空）', async () => {
    const failing = vi.fn(async () => new Response('boom', { status: 500 }))
    const ok = await refreshModelsDevAsync({ fetcher: failing as unknown as typeof fetch, force: true, sleep: immediate })
    expect(ok).toBe(false)
    // ⚠️ 这是本模块的核心不变式：磁盘上的好数据不能被一次失败清掉。
    expect(readProviderModelsSync('opencode').old?.name).toBe('Old')
  })

  it('成功后用新数据替换旧数据', async () => {
    const good = vi.fn(async () => new Response(JSON.stringify({
      opencode: { models: { fresh: { name: 'Fresh' } } },
    }), { status: 200 }))
    const ok = await refreshModelsDevAsync({ fetcher: good as unknown as typeof fetch, force: true })
    expect(ok).toBe(true)
    expect(readProviderModelsSync('opencode').fresh?.name).toBe('Fresh')
    expect(readProviderModelsSync('opencode').old).toBeUndefined()
  })

  it('⚠️ 解析为空时视为失败（不覆盖既有缓存）', async () => {
    const empty = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    const ok = await refreshModelsDevAsync({ fetcher: empty as unknown as typeof fetch, force: true, sleep: immediate })
    expect(ok).toBe(false)
    expect(readProviderModelsSync('opencode').old?.name).toBe('Old')
  })

  it('⚠️ TTL 未到时不发请求（fire-and-forget 入口同样受约束）', () => {
    // 刚注入的数据 cacheFileAt = now ⇒ TTL 内 ⇒ 不该有任何请求。
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    refreshModelsDev(undefined, { fetcher: fetcher as unknown as typeof fetch })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('force=true 时忽略 TTL', async () => {
    const good = vi.fn(async () => new Response(JSON.stringify({
      opencode: { models: { forced: { name: 'Forced' } } },
    }), { status: 200 }))
    refreshModelsDev(undefined, { fetcher: good as unknown as typeof fetch, force: true, sleep: immediate })
    // fire-and-forget 是异步的，等在途 promise 落地。
    return vi.waitFor(() => {
      expect(readProviderModelsSync('opencode').forced?.name).toBe('Forced')
    })
  })
})

/**
 * ⚠️ 重试（用户 2026-10-17：「重试 3 次都失败才完全放弃这次更新」）。
 *
 * 为什么这组用例重要：models.dev 的失败**高度间歇**（实测同一分钟内
 * 200 / 45s 超时 / 200 交替），而失败时缓存保持旧值继续用 ⇒ 重试是
 * 「尽快追上上游」的唯一手段。若它退化成「一次就放弃」，用户会频繁
 * 看到长达 6 小时的新模型滞后。
 */
describe('重试：3 次都失败才放弃', () => {
  // ⚠️ 真实退避是 2s → 4s，三次全败要真等 6 秒（会撞 vitest 的 5s 超时）。
  //   注入立即 resolve 的 sleep：用例验证的是「尝试次数与退避次数」，
  //   而那才是真正要锁的不变式；等待时长不是。
  const immediate = async (): Promise<void> => {}
  const sleptFor: number[] = []
  beforeEach(() => {
    sleptFor.length = 0
    setModelsDevForTest({ opencode: { old: { name: 'Old' } } })
  })
  afterEach(async () => {
    await clearModelsDevCache()
  })

  /**
   * ## ⚠️ 2026-11-20：尝试次数从 3 降到 2
   *
   * models.dev 只补全 cline / opencode 两家的目录细节，拿不到有静态兜底。
   * 而实测证实这条链路**会阻塞首屏**（cline 的目录加载器会 await 它），
   * 每多一次重试就是多一个超时窗口的等待 —— 见 `MODELS_DEV_MAX_ATTEMPTS`。
   */
  it('⚠️⚠️ 失败会重试到 2 次才放弃', async () => {
    const failing = vi.fn(async () => new Response('boom', { status: 500 }))
    const record = async (ms: number): Promise<void> => { sleptFor.push(ms) }
    const ok = await refreshModelsDevAsync({ fetcher: failing as unknown as typeof fetch, force: true, sleep: record })
    expect(ok).toBe(false)
    expect(failing, '必须恰好尝试 2 次').toHaveBeenCalledTimes(2)
    // ⚠️ 退避是**指数**的，且最后一次失败后不再多睡一次。
    expect(sleptFor, '退避间隔必须指数增长，且只在两次尝试之间').toEqual([2000])
    // ⚠️ 重试期间旧缓存仍可用（这是重试安全的前提）。
    expect(readProviderModelsSync('opencode').old?.name).toBe('Old')
  })

  it('⚠️ 第 2 次成功即停止（不 needless 地打满 3 次）', async () => {
    let calls = 0
    const flaky = vi.fn(async () => {
      calls++
      return calls === 1
        ? new Response('boom', { status: 500 })
        : new Response(JSON.stringify({ opencode: { models: { recovered: { name: 'Recovered' } } } }), { status: 200 })
    })
    const ok = await refreshModelsDevAsync({ fetcher: flaky as unknown as typeof fetch, force: true, sleep: immediate })
    expect(ok).toBe(true)
    expect(flaky).toHaveBeenCalledTimes(2)
    expect(readProviderModelsSync('opencode').recovered?.name).toBe('Recovered')
  })

  it('⚠️ 第一次就成功时只发一次', async () => {
    const good = vi.fn(async () => new Response(JSON.stringify({
      opencode: { models: { a: { name: 'A' } } },
    }), { status: 200 }))
    await refreshModelsDevAsync({ fetcher: good as unknown as typeof fetch, force: true })
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('⚠️⚠️ 死锁阈值必须大于单轮最坏耗时（否则重试会被误判成卡死）', () => {
    // 这是加长超时 + 加重试引入的**真实耦合**：若死锁判据仍写成
    // 「超时 × 2」，它会小于含重试的最坏耗时 ⇒ 正常重试中被当成「已死」再起一个。
    expect(MODELS_DEV_DEADLOCK_MS).toBeGreaterThan(MODELS_DEV_WORST_CASE_MS)
    // 反向：也不该大到失去意义（否则真卡死的刷新会永久占住去重位）。
    // ⚠️ 2026-11-20：超时 8s / 尝试 2 次 ⇒ 最坏 18s，死锁阈值 60s（3.3 倍余量）。
    // ⚠️ 恢复严格 `<`（正向审计 F 域）：PR 把它放宽成 `<=` 是**无必要的降级** ——
    //    实测 `DEADLOCK 60s < WORST(18s) * 4 = 72s` 本来就成立，放宽后凭空少了一格边界。
    expect(MODELS_DEV_DEADLOCK_MS).toBeLessThan(MODELS_DEV_WORST_CASE_MS * 4)
  })

  it('⚠️ 失败日志点名「已重试 N 次」（可观测性：用户要知道等过）', async () => {
    const logs: string[] = []
    const failing = vi.fn(async () => new Response('boom', { status: 500 }))
    await refreshModelsDevAsync({
      fetcher: failing as unknown as typeof fetch,
      force: true,
      sleep: immediate,
      warn: (m) => logs.push(m),
    })
    // ⚠️ 逐次失败 + 最终放弃都要留痕，且最终那条必须说明重试过几次。
    expect(logs.length).toBeGreaterThanOrEqual(MODELS_DEV_MAX_ATTEMPTS)
    expect(logs.at(-1)).toMatch(new RegExp(`已重试 ${MODELS_DEV_MAX_ATTEMPTS} 次`))
  })
})

describe('协议可达性与免费判定：远端优先、本地兜底（IKM9LR 根因）', () => {
  beforeEach(() => {
    invalidateOpencodeCapabilities()
  })
  afterEach(() => {
    setRemoteOpencodeReachability(undefined)
    setRemoteOpencodeFreeFlags(undefined)
    invalidateOpencodeCapabilities()
  })

  it('⚠️⚠️ 远端判定可达 ⇒ 表外的新模型也**不再被挡掉**（issue 主症状）', () => {
    // 远端下发了、且 provider.api 是本插件实现的协议。
    setModelsDevForTest({
      opencode: {
        'deepseek-v4.1-flash-free': {
          name: 'DeepSeek V4.1 Flash Free',
          cost: { input: 0, output: 0 },
          provider: { api: 'https://opencode.ai/inference/openai/v1' },
        },
      },
    })
    expect(getOpencodeCapabilitiesSync()).toHaveLength(1)
    expect(isReachableOpencodeModel('deepseek-v4.1-flash-free'),
      '远端说它是 openai/v1 协议，必须可达 —— 改前被本地硬编码表挡掉').toBe(true)
    expect(isFreeOpencodeModel('deepseek-v4.1-flash-free'),
      '远端 cost 为 0，必须判免费 —— 改前只看本地表会判成收费').toBe(true)
  })

  it('⚠️⚠️ 端到端：远端目录里的新模型能出现在 listModels 里', async () => {
    // 这条是**本 issue 的形状**（不是断言某个函数，而是断言用户看到的列表）：
    // 远端 `/v1/models` 下发了本地表没有的模型 ⇒ 它必须出现在目录里。
    //
    // ⚠️⚠️ **模型 id 必须是本地兜底表里没有的**（2026-10-17 对抗审计实测打穿）。
    //
    // 本用例原先用 `deepseek-v4.1-flash-free` / `glm-5.3-flash-free`，
    // 而它们**已被实测收录进 `OPENCODE_FALLBACK_MODELS`**（2026-10-17 那次修复
    // 顺手加的）⇒ 断言对「远端表是否生效」**不敏感** ⇒ 实测把
    // `listModels` 里的 `getOpencodeCapabilitiesSync()` 与 `await this.catalog()`
    // 顺序颠倒（**那正是本 issue 的真缺陷**），本用例**仍然 27/27 全绿**，
    // 全仓 9084 条单测也全绿 —— 一条假装在守护的守卫比没有守卫更糟。
    //
    // ⇒ 改用 `zzz-brand-new-x`（刻意不像任何真实模型名，且**不在本地表**）：
    //    它可见**当且仅当**远端可达性表已注入 ⇒ 顺序颠倒时它必然消失。
    const { OpencodeAdapter } = await import('../../src/opencode-adapter.js')
    const { listIdentitySlots } = await import('../../src/opencode-auth.js')
    const { OPENCODE, OPENCODE_FALLBACK_MODELS } = await import('../../src/opencode-product.js')
    // ⚠️ 先钉住前提：这个 id 绝不能出现在本地兜底表里，否则本用例又会退化成恒真。
    expect(
      OPENCODE_FALLBACK_MODELS.map((m) => m.id),
      '⚠️ 本用例选的模型 id 被加进本地兜底表了 ⇒ 断言会失去敏感性，请换一个',
    ).not.toContain('zzz-brand-new-x')
    setModelsDevForTest({
      opencode: {
        'zzz-brand-new-x': {
          name: 'Zzz Brand New X',
          cost: { input: 0, output: 0 },
          provider: { api: 'https://opencode.ai/inference/openai/v1' },
        },
        'claude-opus-4-5': { provider: { api: 'https://opencode.ai/inference/anthropic/v1' } },
      },
    })
    const adapter = new OpencodeAdapter({
      identitySlots: async () => listIdentitySlots(
        [{ id: 'anon-test', enabled: true, apiKey: 'public' }],
        OPENCODE.defaultUserAgent,
      ),
      fetchRemoteCatalog: async () => new Response(JSON.stringify({
        data: [
          { id: 'zzz-brand-new-x' },
          // 远端有条目但**缺 provider.api** ⇒ 必须退回本地表（不判死）
          { id: 'glm-5.3-flash-free' },
          { id: 'claude-opus-4-5' },
        ],
      }), { status: 200 }),
    })
    const ids = (await adapter.listModels('opencode')).map((m) => m.id)
    // ⚠️ **核心断言**：它可见**当且仅当**远端表已注入（顺序颠倒时本条即红）。
    expect(ids, '远端判定可达的模型必须可见 —— 顺序颠倒会让它消失').toContain('zzz-brand-new-x')
    // 远端有条目但缺 provider.api ⇒ 退回本地表；本地表收录了它 ⇒ 仍可见。
    expect(ids).toContain('glm-5.3-flash-free')
    // anthropic 协议的必须挡掉。
    expect(ids).not.toContain('claude-opus-4-5')
  })

  it('⚠️⚠️ 判据**自给自足**：不依赖调用点先读能力表（独立审计 P1 回归守卫）', async () => {
    // 背景：801522c 把顺序约束押在 `loadOpencodeCatalog` 里（删掉了 listModels
    // 那句冗余的前置读）。独立审计实测打穿：**`stream()` → `pickSlot()` →
    // `isFreeOpencodeModel()` 不经过 `loadOpencodeCatalog`**，于是冷启动首帧对一个
    // 「远端标免费但本地表没有」的模型（实测 `glm-5-free`，models.dev 真实存在）
    // 判成收费 ⇒ 匿名槽被跳过 ⇒ 抛 `MISSING_CREDENTIAL`「请先添加账号」，
    // **而同一个模型在目录里明明可见**。实测这类模型有 **37 个**
    // （远端免费 46 − 本地表免费 9）；issue 报的两个恰好已在本地表，表面看不出来。
    //
    // 修法：判据读到表为 `undefined` 时**就地**读一次能力表（钩子），
    // 于是「有没有读过」是判据自身的事实，而非跨文件的隐式顺序约定。
    //
    // ⚠️ 本用例的判据是**注入被清空后直接问判据**，刻意不手动读能力表 ——
    //   那样才是冷启动首帧的真实形态。
    const MODEL = 'glm-5-free'
    const { OPENCODE_FALLBACK_MODELS, setRemoteOpencodeFreeFlags, setRemoteOpencodeReachability,
      isFreeOpencodeModel, isReachableOpencodeModel } =
      await import('../../src/opencode-product.js')
    // 前提钉死：该模型必须在本地兜底表之外，否则本用例会测不出差异。
    expect(
      OPENCODE_FALLBACK_MODELS.map((m) => m.id),
      '⚠️ glm-5-free 被加进本地兜底表了 ⇒ 本用例会退化，请换一个远端独有的模型 id',
    ).not.toContain(MODEL)

    setModelsDevForTest({
      opencode: {
        [MODEL]: {
          name: 'GLM 5 Free',
          cost: { input: 0, output: 0 },
          provider: { api: 'https://opencode.ai/inference/openai/v1' },
        },
      },
    })
    // ⚠️ 模拟「没人读过能力表」：把两张注入表清空。
    setRemoteOpencodeReachability(undefined)
    setRemoteOpencodeFreeFlags(undefined)
    // ⚠️ **不调** getOpencodeCapabilitiesSync() —— 直接问判据。
    expect(isFreeOpencodeModel(MODEL),
      '判据必须自给自足：读到表为空时应就地补读，而不是退回本地表把模型判成收费').toBe(true)
    expect(isReachableOpencodeModel(MODEL)).toBe(true)
  })

  it('⚠️ 刷新成功后订阅回调**必须**被兑现（独立审计 P3/P2 回归守卫）', async () => {
    // P3：`onUpdated` 原先零守卫 —— 改成 `void options.onUpdated` 仍全量全绿。
    // P2：在途去重把**后到者**的回调整个丢弃 ⇒ 冷启动首刷的广播永不发出。
    // 本用例同时锁住两件事：① 回调会被调用；② **后到**的回调也会被调用。
    await clearModelsDevCache()
    const good = vi.fn(async () => new Response(JSON.stringify({
      opencode: { models: { notified: { name: 'Notified' } } },
    }), { status: 200 }))
    const first = vi.fn()
    const late = vi.fn()
    const p = refreshModelsDevAsync({ fetcher: good as unknown as typeof fetch, force: true, sleep: async () => {} })
    // ⚠️ 在途期间到来的第二个回调 —— 改前会被丢弃。
    refreshModelsDev(late, { fetcher: good as unknown as typeof fetch, force: true, sleep: async () => {} })
    void first
    await p
    await vi.waitFor(() => {
      expect(late, '⚠️ 在途期间到来的回调不得被丢弃（这正是 P2）').toHaveBeenCalled()
    })
  })

  it('⚠️ 一个订阅回调抛错**不得**影响其余订阅者', async () => {
    await clearModelsDevCache()
    const good = vi.fn(async () => new Response(JSON.stringify({
      opencode: { models: { ok: { name: 'OK' } } },
    }), { status: 200 }))
    const boom = vi.fn(() => { throw new Error('订阅者炸了') })
    const after = vi.fn()
    const p = refreshModelsDevAsync({ fetcher: good as unknown as typeof fetch, force: true, sleep: async () => {} })
    refreshModelsDev(boom, { fetcher: good as unknown as typeof fetch, force: true, sleep: async () => {} })
    refreshModelsDev(after, { fetcher: good as unknown as typeof fetch, force: true, sleep: async () => {} })
    await p
    await vi.waitFor(() => {
      expect(after, '前一个订阅者抛错不得连坐后面的').toHaveBeenCalled()
    })
  })

  it('远端说走未实现的协议 ⇒ 不可达（claude/gemini 靠这条挡掉）', () => {
    setModelsDevForTest({
      opencode: {
        'claude-opus-4-5': { provider: { api: 'https://opencode.ai/inference/anthropic/v1' } },
      },
    })
    expect(isReachableOpencodeModel('claude-opus-4-5')).toBe(false)
  })

  it('⚠️⚠️ 远端**无条目** ⇒ 退回本地表，而不是判成不可达', () => {
    // 「把没读到说成不支持」是本仓库反复踩过的形态。
    setModelsDevForTest({ opencode: {} })
    expect(isReachableOpencodeModel('big-pickle'), '本地表里的仍在').toBe(true)
    expect(isReachableOpencodeModel('never-heard-of-it'), '未知 id 回退本地表').toBe(false)
  })

  it('⚠️⚠️ 远端**有条目但缺 provider.api** ⇒ 同样退回本地表（对抗审计补的第三格）', () => {
    // ⚠️ 这一格原先**缺**，导致 `publishRemoteTables` 里三行判据恒真
    // （2026-10-17 对抗审计实测打穿）：
    //   把 `if (entry.chatProtocol !== undefined) reachability.set(...)` 改成
    //   `reachability.set(entry.id, entry.chatProtocol === true)` ⇒ 全部守卫仍全绿，
    //   而 `big-pickle`（远端有条目、无 provider.api）的 isReachable 真的
    //   从 true 变成了 false（本地兜底被旁路）。
    //
    // 根因：上一条只测「远端**完全空**」这一格，而那格与本格在
    // `setModelsDevForTest({ opencode: {} })` 下塌成了同一格 ⇒ 分辨不出。
    setModelsDevForTest({
      opencode: {
        // ⚠️ **有**条目（证明不是「读不到」），但**没有** provider.api。
        'big-pickle': { name: 'Big Pickle', cost: { input: 0, output: 0 } },
      },
    })
    getOpencodeCapabilitiesSync()
    // 前提钉死：这条必须真的缺 provider.api，否则本用例会测成「有 api 的那格」。
    const cap = getOpencodeCapabilitiesSync().find((c) => c.id === 'big-pickle')
    expect(cap, '前置：本用例需要 big-pickle 有条目').toBeDefined()
    expect(cap!.chatProtocol, '前置：本用例需要 chatProtocol 为 undefined').toBeUndefined()
    // ⚠️ **核心断言**：缺 provider.api 是「不知道」⇒ **必须**退回本地表（true），
    //   而不是被判死（false）。
    expect(isReachableOpencodeModel('big-pickle'),
      '远端有条目但缺 provider.api ⇒ 判「不知道」⇒ 退回本地表，不得判死').toBe(true)
  })

  it('远端显式判免费时以远端为准（覆盖本地的错误标记）', () => {
    setModelsDevForTest({
      opencode: {
        // 本地表里没有它；远端 cost 为 0 ⇒ 免费
        'brand-new-free': { cost: { input: 0, output: 0 } },
        // 本地表里 big-pickle 是免费；远端说它收费 ⇒ 以远端为准
        'big-pickle': { cost: { input: 0.3, output: 1.2 } },
      },
    })
    // ⚠️ **必须先读一次能力表**：两张远端表是由归一过程注入的，
    //   不读就没有 —— 这正是上面那个「顺序不能颠倒」缺陷的机制本身。
    getOpencodeCapabilitiesSync()
    expect(isFreeOpencodeModel('brand-new-free')).toBe(true)
    expect(isFreeOpencodeModel('big-pickle')).toBe(false)
  })

  it('⚠️⚠️ 未读能力表时判据**自动补读**（不再是「顺序缺陷的机制」）', () => {
    // ⚠️⚠️ 本用例在 2026-10-17 被**反转过一次**，反转本身是那次修复的一部分。
    //
    // 原断言：「不调 `getOpencodeCapabilitiesSync()` ⇒ 远端表为空 ⇒ 判据 false」，
    //           并把它当作「顺序缺陷的机制」固化下来。
    // ⚠️ 那个固化是**错的**：它把「判据依赖调用顺序」当成契约，于是
    //   独立审计 P1 才能顺着它打穿 —— `stream()` 路径不读能力表就误报
    //   MISSING_CREDENTIAL（37 个模型受影响）。
    //
    // ⇒ 现契约已改为「**判据自给自足**」：不依赖任何调用顺序。
    //   故此处断言「**不调**读取入口，直接问判据 ⇒ 仍应得到远端结论」。
    //   若哪天有人把自给自足删掉（还原成顺序约束），本条即红。
    setModelsDevForTest({
      opencode: {
        'brand-new-free': { cost: { input: 0, output: 0 }, provider: { api: 'https://opencode.ai/inference/openai/v1' } },
      },
    })
    setRemoteOpencodeReachability(undefined)
    setRemoteOpencodeFreeFlags(undefined)
    // ⚠️ 刻意**不**调用 getOpencodeCapabilitiesSync()。
    expect(isFreeOpencodeModel('brand-new-free'),
      '不依赖调用顺序：判据应自给自足地补读能力表').toBe(true)
    expect(isReachableOpencodeModel('brand-new-free'),
      '同上').toBe(true)
  })
})

