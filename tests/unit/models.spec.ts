import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fetchCodeArtsRemoteModels, isCodeArtsBenefitModelKnown, isRemoteCatalogComplete,
  loadBenefitCache, loadModelsCache,
  OPENGW_GATEWAY_CONFIG_URL, saveBenefitCache, saveModelsCache, setBenefitMemoryCache,
  SNAP_MODEL_BUILTIN_URL,
} from '../../src/models.js'
import type { CodeArtsCredential } from '../../src/types.js'

/** 构造一份最小可用凭据。 */
function makeCredential(): CodeArtsCredential {
  return {
    access_key_id: 'AKTEST',
    secret_access_key: 'SKTEST',
    security_token: 'STTEST',
    expires_at: '2026-12-31T00:00:00Z',
    refresh_token: 'rt',
    code_verifier: 'cv',
    dpop_private_key_jwk: 'jwk',
  } as CodeArtsCredential
}

/** 按 URL 路由返回不同响应的 mock fetch；记录每次请求的 URL 与头。 */
function makeFetcher(routes: Record<string, { status?: number; body: string }>) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: new Headers(init?.headers) })
    const route = routes[url]
    if (route === undefined) return new Response('', { status: 404 })
    return new Response(route.body, { status: route.status ?? 200 })
  }
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

describe('fetchCodeArtsRemoteModels', () => {
  it('requests the /v1/model/builtin endpoint (not the old statistics/plugin)', async () => {
    const { fetcher, calls } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          count: 2,
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'openpangu-2.0-flash', model_name: 'openpangu-2.0-flash' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const snapCall = calls.find((c) => c.url === SNAP_MODEL_BUILTIN_URL)
    expect(snapCall).toBeDefined()
    expect(models).toContainEqual({ id: 'GLM-5.2', name: 'GLM-5.2' })
    expect(models).toContainEqual({ id: 'openpangu-2.0-flash', name: 'openpangu-2.0-flash' })
  })

  it('sends Agent-Type: PromptCenter and X-Language: zh-cn on the builtin request (unsigned headers)', async () => {
    const { fetcher, calls } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: { body: JSON.stringify({ builtinModels: [] }) },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const snapCall = calls.find((c) => c.url === SNAP_MODEL_BUILTIN_URL)
    expect(snapCall?.headers.get('Agent-Type')).toBe('PromptCenter')
    expect(snapCall?.headers.get('X-Language')).toBe('zh-cn')
    expect(snapCall?.headers.get('Content-Type')).toBe('application/json')
  })

  it('parses builtinModels[] (not the old model_metrics field)', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          // 旧字段已废弃，不应被解析
          model_metrics: [{ model_id: 'OLD-SHOULD-NOT-APPEAR', model_name: 'old' }],
          builtinModels: [
            { model_id: 'GLM-5.2-ArkTS-SPARK', model_name: 'GLM-5.2 ArkTS SPARK' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models).toContainEqual({ id: 'GLM-5.2-ArkTS-SPARK', name: 'GLM-5.2 ArkTS SPARK' })
    expect(models.find((m) => m.id === 'OLD-SHOULD-NOT-APPEAR')).toBeUndefined()
  })

  it('filters out VL (vision) multimodal models from the builtin list', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'Qwen3-VL-235B', model_name: 'Qwen3-VL-235B' },
            { model_id: 'something-VL', model_name: 'something-VL' },
            { model_id: 'glm-5.2-sft-harmony', model_name: 'glm-5.2-sft-harmony' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    expect(ids).toContain('GLM-5.2')
    expect(ids).toContain('glm-5.2-sft-harmony')
    expect(ids).not.toContain('Qwen3-VL-235B')
    expect(ids).not.toContain('something-VL')
  })

  it('★ 读出上游 model_desc（模型介绍），缺失/空白/非字符串一律不落键', async () => {
    // 取证：2026-11-17 真机 12 条全带 model_desc（如
    // `【限时体验】许愿式编程一键成真`），与 CodeArts 客户端选择器上的灰字逐字相同。
    // 旧代码不读该字段 ⇒ 上游下发了、我们丢掉。
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'glm-5.3', model_name: 'GLM-5.3', model_desc: '  【限时体验】面向复杂编程与长程任务  ' },
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2', model_desc: '' },
            { model_id: 'kimi-k3', model_name: 'Kimi-K3', model_desc: '   ' },
            // 上游偶尔给非字符串（历史上出现过数字/对象共存），绝不能 `String()` 后落键。
            { model_id: 'speed', model_name: '智速模式', model_desc: 42 },
            // ⚠️ **零宽字符**不是空白：`trim()` 不会去掉 `\u200b`（`Cf`），
            //    只判 `trim().length > 0` 会让它通过 ⇒ 客户端画一格看不见的第二行。
            { model_id: 'zwsp-only', model_name: 'ZWSP', model_desc: '\u200b\u200b\u2060\ufeff' },
            { model_id: 'no-desc', model_name: 'NoDesc' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const byId = new Map(models.map((m) => [m.id, m]))

    // ⚠️ 只 trim 两端空白，**不改字**（不裁 `【限时体验】`、不改写措辞）。
    expect(byId.get('glm-5.3')?.description).toBe('【限时体验】面向复杂编程与长程任务')
    // ⚠️ 三态硬要求：空串 / 全空白 / 非字符串 / 缺失 ⇒ **键根本不出现**
    //    （写 `''` 会让宿主/客户端把「上游没给」渲染成一格空的行，与「有介绍」同形）。
    for (const id of ['GLM-5.2', 'kimi-k3', 'speed', 'zwsp-only', 'no-desc']) {
      expect(byId.get(id), `前置：${id} 必须在目录里，否则这一格是空跑`).toBeDefined()
      expect(Object.hasOwn(byId.get(id)!, 'description'), `${id} 不该带 description 键`).toBe(false)
    }
  })

  it('★ 同一 id 被两个端点各下发一次（gateway 在前、无介绍）⇒ 介绍必须被补齐，不能先到先得丢掉', async () => {
    // 真实顺序：`gateway/config`（benefit 组，**没有 `model_desc`**）先跑，
    // `/v1/model/builtin`（带介绍）后跑。两边都下发同一个 id 时（实测
    // `deepseek-v4.1-flash` 就同时出现在这两处），旧实现「先到先得」⇒ gateway
    // 那份赢 ⇒ 介绍在**合并阶段**就没了，表现为「界面上一格空白，而上游明明给了」。
    const DESC = '【限时体验】能力更高, 速度更快'
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [{ model_id: 'deepseek-v4.1-flash', model_name: 'deepseek-v4.1-flash' }],
          },
        }),
      },
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'deepseek-v4.1-flash', model_name: 'DeepSeek-V4.1-Flash', model_desc: DESC },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)

    // 前置：去重仍生效（一条，不是两条）；否则本条用例证明不了「补齐」这件事。
    expect(models.filter((m) => m.id === 'deepseek-v4.1-flash')).toHaveLength(1)
    expect(models.find((m) => m.id === 'deepseek-v4.1-flash')?.description, '后到的 builtin 必须把介绍补到先到的条目上').toBe(DESC)
    // ⚠️ 只补**缺**的字段：先到的 name/倍率不能被后到的顶掉（现在两边 name 不同，
    //    取先到的那个 —— 这是既有语义，本条只锁定「不被静默改写」）。
    expect(models.find((m) => m.id === 'deepseek-v4.1-flash')?.name).toBe('deepseek-v4.1-flash')
  })

  it('merges opengw gateway/config benefit models with builtin models, deduped', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
              { model_id: 'deepseek-v4-flash-0731', model_name: 'deepseek-v4-flash' },
            ],
          },
        }),
      },
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    // benefit 模型
    expect(ids).toContain('glm-5.3-flash')
    /**
     * ⚠️⚠️ **带日期版本后缀的模型必须「独立且直接暴露」**（2026-10-27 修）。
     *
     * 修前这里断言的是「日期后缀被 `normalizeModelId` 去掉」⇒ 上游并存的旧版与
     * 新版会被合并成一条，带版本号的那条**静默消失**（真实报障：IDE 已更新到
     * `DeepSeek-V4.1-Flash-1017`，插件列表没更新）。
     *
     * 实测依据（IDE 内核日志 `kernel-codeartsdoer-incognito-2026-10-27T220300`）：
     * `/v1/model/builtin` 同时下发 `deepseek-v4.1-flash` 与
     * `deepseek-v4.1-flash-1017` **两个独立条目**，两者 `model_type` 都是 `admin`、
     * `context` 都是 `1048576` ⇒ 是上游并存的版本，不是同一模型的两种写法。
     *
     * ⇒ 现在对外 id 用原始 `model_id`；`seen` 去重键也用 rawId。
     */
    expect(ids, '★ 带版本后缀的 id 必须原样暴露（上游把它们当独立模型）')
      .toContain('deepseek-v4-flash-0731')
    expect(ids, '★ 不得再归一成无后缀、与旧版合并成一条').not.toContain('deepseek-v4-flash')
    // 常规模型
    expect(ids).toContain('GLM-5.2')
    // 去重：glm-5.3-flash 只出现一次
    expect(ids.filter((id) => id === 'glm-5.3-flash')).toHaveLength(1)
  })

  it('returns empty array when credential lacks AK/SK', async () => {
    const { fetcher, calls } = makeFetcher({})
    const cred = makeCredential()
    cred.access_key_id = ''
    const models = await fetchCodeArtsRemoteModels(cred, fetcher)
    expect(models).toEqual([])
    expect(calls).toHaveLength(0)
  })

  /**
   * ★ **同一天下发「无后缀 + 带版本号」两条模型时必须都保留**（issue IKQY27）。
   *
   * 原实现对任何末尾 `-NNNN` 一律剥掉，`deepseek-v4.1-flash-1017` 被改写成
   * `deepseek-v4.1-flash` 后撞 id、被 `seen` 去重丢掉 —— 选择器里一条 1017
   * 都不出现，且零提示。实测上游 `display_enabled` 两条都是 true，
   * 且两条真实请求分别回显各自 id ⇒ 后端注册为**两个独立模型**。
   */
  it('★ 保留「父 id 同时存在」的带版本号模型（issue IKQY27）', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'deepseek-v4.1-flash', model_name: 'DeepSeek-V4.1-Flash', ratio_display: '0.18x' },
            { model_id: 'deepseek-v4.1-flash-1017', model_name: 'DeepSeek-V4.1-Flash-1017', ratio_display: '0.18x' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    // 两条都必须存在（这是本 issue 的核心断言）
    expect(ids).toContain('deepseek-v4.1-flash')
    expect(ids).toContain('deepseek-v4.1-flash-1017')
    expect(models).toHaveLength(2)
    // 名字也要各自独立，不能被归一化成同一个
    const byId = new Map(models.map((m) => [m.id, m.name]))
    expect(byId.get('deepseek-v4.1-flash')).toBe('DeepSeek-V4.1-Flash')
    expect(byId.get('deepseek-v4.1-flash-1017')).toBe('DeepSeek-V4.1-Flash-1017')
  })

  /**
   * ⚠️ 本 PR 首版还有一条「父 id 不存在时仍须剥掉后缀」的反向用例，**已删除**。
   *
   * 它依据的前提「chat 端点只认不带后缀的 id」在本仓早已被实测推翻
   * （见 `src/llm-adapter.ts` 的 `DEFAULT_MODELS` 注释，2026-09-23 修正：
   * `-0731` 回 404 的真因是**缺 `maas_type: benefit` 头**，带日期后缀与无后缀
   * 是后端**两个独立注册的模型，不能互相替代**）。
   * 而「带版本后缀的 id 必须原样暴露」已由本文件上方
   * `merges opengw gateway/config benefit models with builtin models, deduped`
   * 用例锁住相反方向 ⇒ 两条同时存在会互相矛盾。
   */
})

/**
 * ★ **各来源成败上报**（issue IKJVTF 复审，审计 I3）。
 *
 * CodeArts 的目录来自**两个**独立端点，失败路径都是 `fetchSignedGet`
 * **静默返回 undefined**。故「一个成功、一个失败」时 `models.length > 0`，
 * 旧判据（适配器只看长度）会判成「已拿到目录」⇒ **永久缓存** ⇒ 残缺目录固化，
 * 只有重启 DSH 才能恢复。
 *
 * ⚠️ 完整性判据必须是「**请求成功且形状可识别**」，不是「解析出非空列表」：
 * 上游把某个来源的模型**全部下架**时，`result.models: []` / `builtinModels: []`
 * 是**合法**状态 —— 把它当失败会让冷却永不清理。
 */
describe('fetchCodeArtsRemoteModels 的各来源成败（★ IKJVTF I3）', () => {
  const GATEWAY_BODY = JSON.stringify({
    result: { models: [{ model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' }] },
  })
  const BUILTIN_BODY = JSON.stringify({
    builtinModels: [{ model_id: 'GLM-5.2', model_name: 'GLM-5.2' }],
  })

  it('★ 两个端点都成功 ⇒ gatewayOk + builtinOk 皆为 true（完整）', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: { body: GATEWAY_BODY },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const outcome = { gatewayOk: false, builtinOk: false }
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    expect(models.length).toBeGreaterThan(0)
    expect(outcome).toEqual({ gatewayOk: true, builtinOk: true })
    expect(isRemoteCatalogComplete(outcome)).toBe(true)
  })

  it('★ gateway 成功 + builtin 失败（404）⇒ **不算完整**', async () => {
    // `makeFetcher` 对未登记路由回 404 ⇒ builtin 走 `!response.ok` 分支。
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: { body: GATEWAY_BODY },
    })
    const outcome = { gatewayOk: false, builtinOk: false }
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    // 目录**非空**（gateway 那一份拿到了）—— 旧判据据此判成「完整」。
    expect(models.length).toBeGreaterThan(0)
    // ★ 但完整性必须是 false，否则残缺目录被永久缓存。
    expect(outcome).toEqual({ gatewayOk: true, builtinOk: false })
    expect(isRemoteCatalogComplete(outcome)).toBe(false)
  })

  it('★ builtin 成功 + gateway 失败 ⇒ **不算完整**（镜像格）', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const outcome = { gatewayOk: false, builtinOk: false }
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    expect(models.length).toBeGreaterThan(0)
    expect(outcome).toEqual({ gatewayOk: false, builtinOk: true })
    expect(isRemoteCatalogComplete(outcome)).toBe(false)
  })

  it('★ 两个端点都失败 ⇒ 两者皆 false', async () => {
    const { fetcher } = makeFetcher({})
    const outcome = { gatewayOk: false, builtinOk: false }
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    expect(models).toEqual([])
    expect(outcome).toEqual({ gatewayOk: false, builtinOk: false })
  })

  it('★ 形状可识别但**合法为空**（两边都是空数组）⇒ 仍算**取到了**（完整）', async () => {
    // 「上游把模型全撤」与「端点挂掉」在**是否有内容**上都表现为空，
    // 但在**形状**上可区分。本层的取舍：形状可识别即算取到，
    // 由**适配器**的 `models.length === 0` 决定「不落缓存」。
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: { body: JSON.stringify({ result: { models: [] } }) },
      [SNAP_MODEL_BUILTIN_URL]: { body: JSON.stringify({ builtinModels: [] }) },
    })
    const outcome = { gatewayOk: false, builtinOk: false }
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    expect(outcome).toEqual({ gatewayOk: true, builtinOk: true })
  })

  it('★ 形状不可识别（HTTP 200 + 错误 JSON）⇒ **不算取到**', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: { body: JSON.stringify({ unexpected: true }) },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const outcome = { gatewayOk: false, builtinOk: false }
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher, outcome)
    // gateway 的 `extractJsonArray(['result','models'])` 拿不到数组 ⇒ 不算取到
    expect(outcome.gatewayOk).toBe(false)
    expect(outcome.builtinOk).toBe(true)
  })

  it('★ 无 AK/SK（早退）⇒ 两者皆 false（不能默认成 true）', async () => {
    const { fetcher } = makeFetcher({})
    const cred = makeCredential()
    cred.access_key_id = ''
    const outcome = { gatewayOk: true, builtinOk: true }
    await fetchCodeArtsRemoteModels(cred, fetcher, outcome)
    expect(outcome).toEqual({ gatewayOk: false, builtinOk: false })
  })

  it('不传 outcome ⇒ 行为与既有完全一致（返回数组）', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: { body: GATEWAY_BODY },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models.map((m) => m.id)).toContain('glm-5.3-flash')
    expect(models.map((m) => m.id)).toContain('GLM-5.2')
  })
})

/**
 * benefit（免费额度）模型判定与缓存。
 *
 * ## 判据只有一个：远端 `gateway/config`
 *
 * 官方 CodeArts Agent 内核的 `chat.headers` 钩子就是
 * `if (model_id ∈ gatewayConfig.models) headers.maas_type = "benefit"`，
 * 没有任何静态表（2026-10-26 逆向 `agentkernelServer-win32-x64.exe` 确认）。
 *
 * 本仓库曾维护一张静态兜底表，两次都因后端改注册通道而误判：
 * `deepseek-v4.1-flash` 2026-09 是 benefit 通道、2026-10 已改回常规 `0.18x`
 * 模型（2026-10-26 本机复测：不带该头出流正常、带上即 `InferHub.4004.200`）。
 * 表已删除，改由 `stream()` 的双向自愈兜住后端变化。
 */
describe('benefit 身份判定与缓存（远端集合唯一权威）', () => {
  let cacheDir: string
  const originalDir = process.env.DSH_CODEARTS_CACHE_DIR

  beforeEach(() => {
    // 隔离磁盘缓存：否则会读到真实用户缓存（~/.cache/deveco），断言不稳定
    cacheDir = mkdtempSync(join(tmpdir(), 'codearts-benefit-'))
    process.env.DSH_CODEARTS_CACHE_DIR = cacheDir
    setBenefitMemoryCache(undefined)
  })

  afterEach(() => {
    setBenefitMemoryCache(undefined)
    if (originalDir === undefined) delete process.env.DSH_CODEARTS_CACHE_DIR
    else process.env.DSH_CODEARTS_CACHE_DIR = originalDir
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('未拿到远端集合时一律不确认（不得按历史表猜）', () => {
    // 历史表里 glm-5.3-flash / deepseek-v4.1-flash 都曾被写死为 benefit，
    // 而其中 deepseek-v4.1-flash 已被后端改回常规通道 ⇒ 猜它就等于首条消息必报
    // `codearts: benefit not found`。
    expect(loadBenefitCache()).toBeUndefined()
    for (const model of ['glm-5.3-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash']) {
      expect(isCodeArtsBenefitModelKnown(model), `${model} 未确认前不得带头`).toBe(false)
    }
  })

  it('远端拉取所得集合是唯一权威：新增 benefit 模型无需改代码', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
              { model_id: 'brand-new-benefit-model', model_name: 'brand-new-benefit-model' },
            ],
          },
        }),
      },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(isCodeArtsBenefitModelKnown('brand-new-benefit-model')).toBe(true)
    // 不在远端集合里的一律不带头（哪怕历史表曾把它列为 benefit）。
    expect(isCodeArtsBenefitModelKnown('deepseek-v4.1-flash')).toBe(false)
    expect(isCodeArtsBenefitModelKnown('deepseek-v4-flash')).toBe(false)
  })

  it('落盘的 benefit 集合不含归一化改写过的 id', async () => {
    // deepseek-v4-flash-0731 在 gateway 中是 benefit，但 normalizeModelId 会把
    // 它改写成 deepseek-v4-flash 后再发出，而两者在后端是不同模型、benefit
    // 属性相反 —— 记录改写后的 id 会让无后缀模型多带 maas_type 而失败。
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'deepseek-v4-flash-0731', model_name: 'deepseek-v4-flash' },
              { model_id: 'deepseek-v4.1-flash', model_name: 'deepseek-v4.1-flash' },
            ],
          },
        }),
      },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const saved: unknown = JSON.parse(readFileSync(join(cacheDir, 'codearts_benefit_models.json'), 'utf-8'))
    expect(saved).toEqual(['deepseek-v4.1-flash'])
    expect(isCodeArtsBenefitModelKnown('deepseek-v4-flash')).toBe(false)
  })

  it('缓存读写往返：ESM 下 require 不可用的回归', () => {
    // 真实缺陷（2026-09-23）：本包是 ESM（package.json "type": "module"），
    // 而缓存读写曾用 `require('node:fs')` —— 在 ESM 下它未定义、抛
    // ReferenceError 并被 catch 吞掉，于是「写不进、也读不回」，
    // benefit 判定与模型列表磁盘缓存恒失效。
    saveBenefitCache(['glm-5.3-flash', 'brand-new-benefit-model'])
    setBenefitMemoryCache(undefined)
    expect(loadBenefitCache()).toEqual(['glm-5.3-flash', 'brand-new-benefit-model'])
    // 远端新增的 benefit 模型经磁盘缓存生效（无需改代码）
    expect(isCodeArtsBenefitModelKnown('brand-new-benefit-model')).toBe(true)
  })

  it('模型列表缓存读写往返（同一 require 缺陷）', () => {
    saveModelsCache([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
    expect(loadModelsCache()).toEqual([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
  })

  it('★★ 空集合 = 「确认无」，必须与「未确认」区分（2026-10-27 审计 P1 修）', () => {
    /**
     * ⚠️⚠️ **修前这条用例的注释与断言都是错的**（对抗审计 P5a 打穿）：
     *
     * 注释写「`loadBenefitCache()` 对空数组返回 undefined，因此上游把 benefit
     * 模型全部下架只会退回未确认，不会残留旧正值」—— 但**残留恰恰会发生**：
     * 生产写路径 `saveBenefitCache` 只在 `benefitIds.length > 0` 时被调用，
     * `[]` 根本写不进磁盘 ⇒ 旧值一直留着。而本用例手动 `saveBenefitCache([])`
     * 恰好**绕开了生产写路径**，属**假守卫**（实测：把生产写条件改回
     * `length > 0`，本用例仍绿）。
     *
     * ⇒ 现在语义明确区分：
     * | 磁盘 | `loadBenefitCache()` | 含义 |
     * |---|---|---|
     * | 不存在/解析失败 | `undefined` | **未确认**（靠自愈补头） |
     * | `[]` | `[]` | **确认无** benefit 模型 |
     * | `[id…]` | 数组 | 确认有这些 |
     *
     * 这样「确认无」才能落到磁盘、跨重启生效，陈旧集合才会被真正清掉
     * （否则会「带头 → 4004.200 → **领取写** → 去头 → 成功」每条请求一次写）。
     */
    saveBenefitCache([])
    setBenefitMemoryCache(undefined)
    expect(loadBenefitCache(), '★ 空数组必须原样返回 []（= 确认无），不能退化成「未确认」').toEqual([])
    expect(isCodeArtsBenefitModelKnown('glm-5.3-flash')).toBe(false)
  })

  it('★★ 上游回空集合 ⇒ 必须**覆盖**磁盘上的旧值（消除陈旧正值）', async () => {
    /**
     * ⚠️ 对抗审计实测（P5a）：磁盘上留着旧版本写的 `["glm-5.3-flash"]`、
     * 而 gateway 合法回 `{"result":{"models":[]}}` —— 修前什么都不做
     * ⇒ 判定仍是 `true` ⇒ 每条请求都「带头 → 4004.200 → 领取（写）→ 去头」
     * （实测 3 条请求 = 3 次领取 + 6 次 chat），跨重启存活。
     *
     * 这与本 PR 删掉静态表的理由（「静态表会过时」）是同一个病，只是搬到了磁盘。
     */
    saveBenefitCache(['glm-5.3-flash'])
    setBenefitMemoryCache(undefined)
    expect(isCodeArtsBenefitModelKnown('glm-5.3-flash'), '前置：旧值应生效').toBe(true)
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: { body: JSON.stringify({ result: { models: [] } }) },
      [SNAP_MODEL_BUILTIN_URL]: { body: JSON.stringify({ builtinModels: [] }) },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(
      isCodeArtsBenefitModelKnown('glm-5.3-flash'),
      '★★ 上游确认「无 benefit 模型」后，陈旧正值必须被清掉（否则每轮一次写请求）',
    ).toBe(false)
    expect(loadBenefitCache(), '★ 磁盘也必须被覆盖成 []').toEqual([])
  })

  it('倍率经缓存往返不丢（rateLabel 落盘/读回）', () => {
    // ⚠️ 2026-10-21：倍率曾**两次**被静默丢弃（解析层不读、service 返回类型
    //    写死 `{id,name}`），而 TS 结构类型允许「少字段」赋值 ⇒ 编译不报错、
    //    运行期悄悄丢。本用例锁住缓存这一环（JSON 序列化是隐式契约）。
    saveModelsCache([{ id: 'GLM-5.2', name: 'GLM-5.2', rateLabel: '0.7x' }])
    expect(loadModelsCache()).toEqual([{ id: 'GLM-5.2', name: 'GLM-5.2', rateLabel: '0.7x' }])
  })
})

describe('CodeArts 目录倍率解析（2026-10-21 新增）', () => {
  /**
   * 构造一份带 `credit[]` 的 `/v1/model/builtin` 响应。
   *
   * ⚠️ 形态取自真机取证（8 个模型）：`credit[0]` 同时有 `ratio`（数值）与
   * `ratio_display`（展示串），两者**不同量纲**。
   */
  function builtinResponse(models: unknown[]): string {
    return JSON.stringify({ count: models.length, builtinModels: models })
  }

  it('★ 取 ratio_display，不取 ratio（两者不同量纲）', async () => {
    // 真机对照：GLM-5.2 的 ratio=0.05 但显示 0.7x；
    // deepseek-v4.1-flash 同样 ratio=0.05 却显示 0.18x。
    // ⇒ 若用 ratio 拼 `x{n}` 会显示一个上游从未出现过的数（红线：绝不臆造）。
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: builtinResponse([{
          model_id: 'GLM-5.2',
          model_name: 'GLM-5.2',
          credit: [{ ratio: '0.05', ratio_display: '0.7x', before_display_ratio: null }],
        }]),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models).toHaveLength(1)
    expect(models?.[0]?.rateLabel).toBe('0.7x')
  })

  it('★ 错峰时段取 off_peak 档，不是 credit[0]（真实缺陷）', async () => {
    // ⚠️ 2026-10-21 用户当场发现：deepseek-v4.1-flash 在错峰时段（21:00–次日 7:59
    //    Asia/Shanghai）显示 0.09x，而 `credit[0]` 是 default 档的 0.18x ⇒
    //    取 credit[0] 会在整个错峰期显示**过高的倍率**。
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: builtinResponse([{
          model_id: 'deepseek-v4.1-flash',
          model_name: 'deepseek-v4.1-flash',
          credit: [
            { ratio: '0.05', ratio_display: '0.18x', time_slot_id: 'default' },
            { ratio: '0.05', ratio_display: '0.09x', time_slot_id: 'off_peak', before_display_ratio: '0.18x' },
          ],
          time_slots: {
            off_peak: { timezone: 'Asia/Shanghai', schedule: '0 0 21 * * *', duration: 11, timeunit: 'hour' },
            default: { timezone: 'Asia/Shanghai', schedule: null, duration: null, timeunit: 'hour' },
          },
        }]),
      },
    })
    // 北京时间的「时」→ 注入时刻（与本文件其它用例同口径：算术平移 +8h）
    const atBJ = (hour: number, minute = 0): number => {
      const shanghai = new Date(Date.now() + 8 * 3600_000)
      const target = new Date(shanghai)
      target.setUTCHours(hour - 8, minute, 0, 0)
      return target.getTime()
    }
    const rateAt = async (hour: number, minute = 0): Promise<string | undefined> => {
      const ms = await fetchCodeArtsRemoteModels(makeCredential(), fetcher, undefined, atBJ(hour, minute))
      return ms.find((m) => m.id === 'deepseek-v4.1-flash')?.rateLabel
    }
    // 错峰窗口：21:00 + 11h = 至次日 07:59
    expect(await rateAt(3), '03:00 在错峰内').toBe('0.09x')
    expect(await rateAt(21, 0), '21:00 是窗口起点').toBe('0.09x')
    expect(await rateAt(7, 59), '07:59 是窗口终点').toBe('0.09x')
    // 窗口外
    expect(await rateAt(8, 0), '08:00 已出窗口').toBe('0.18x')
    expect(await rateAt(20, 59), '20:59 未到窗口').toBe('0.18x')
    expect(await rateAt(10), '10:00 是平时').toBe('0.18x')
  })

  it('两档但 time_slot_id 都为 null 时取 credit[0]（openpangu-2.0-pro 实况）', async () => {
    // 真机：openpangu-2.0-pro 有两档，但两档 time_slot_id 都是 null、
    // display 也相同 ⇒ 取任一对，不该因为「查不到时段」而退回成无倍率。
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: builtinResponse([{
          model_id: 'openpangu-2.0-pro',
          model_name: 'OpenPangu-2.0-Pro',
          credit: [
            { ratio: '0.028', ratio_display: '0.7x', time_slot_id: null },
            { ratio: '0.028', ratio_display: '0.7x', time_slot_id: null },
          ],
        }]),
      },
    })
    const ms = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(ms).toHaveLength(1)
    expect(ms[0]?.rateLabel).toBe('0.7x')
  })

  it('credit 为空 / 缺 ratio_display 时不落 rateLabel（不用占位值冒充）', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: builtinResponse([
          // VL 模型：真机实测 credit 整个为空数组
          { model_id: 'kimi-k2.6-vl', model_name: 'kimi-k2.6-vl', credit: [] },
          // 有 credit 但没有 ratio_display
          { model_id: 'no-display', model_name: 'no-display', credit: [{ ratio: '0.05' }] },
          // 完全没有 credit 字段
          { model_id: 'no-credit', model_name: 'no-credit' },
        ]),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    // ⚠️ 三个都返回（含 kimi-k2.6-vl）：可见性过滤判据是 `-VL-` / `-VL` **大写**，
    //    而真机这条 id 是小写 `-vl` ⇒ **逃过过滤**（既有行为，非本次改动引入，
    //    此处按真实行为断言，不擅自改判据 —— 那会改变目录内容）。
    expect(models?.map((m) => m.id).sort()).toEqual(['kimi-k2.6-vl', 'no-credit', 'no-display'])
    for (const m of models ?? []) {
      expect(m.rateLabel, `${m.id} 不该有 rateLabel`).toBeUndefined()
    }
  })
})
