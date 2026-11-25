import { describe, expect, it, vi } from 'vitest'
import {
  QODER_CATALOG_SCENE,
  QODER_CATALOG_SCENES,
  QODER_MODEL_LIST_PATH,
  fetchQoderRemoteModels,
  mergeQoderAppOnlyModels,
  parseQoderRemoteModels,
  parseQoderRemoteModelsForScenes,
  qoderRemoteModelToFallback,
} from '../../src/qoder-catalog.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/qoder.js'

const cred: QoderCredential = buildQoderCredential(
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
  { machineId: 'm-1' },
)

/**
 * 一段 `chat` 场景的远端条目 —— 字段名与取值**逐项照抄 2026-10-20 真机响应**
 * （CN `gateway.qoder.com.cn`，真实凭据）。
 */
const REMOTE_DFMODEL = {
  key: 'dfmodel',
  format: 'openai',
  source: 'system',
  enable: true,
  display_name: 'DeepSeek-Flash',
  is_vl: true,
  is_reasoning: false,
  is_new: true,
  price_factor: 0,
  original_price_factor: 0.1,
  max_input_tokens: 180000,
  is_free: true,
  is_editable: true,
  context_config: {
    '1M': { token_count: 1000000 },
    '200K': { token_count: 200000, is_default: true },
    '400K': { token_count: 400000 },
  },
  thinking_config: {
    disabled: { description: 'Disable thinking' },
    enabled: {
      description: 'Enable thinking',
      efforts: { high: { description: 'High thinking intensity' }, max: { is_default: true }, low: {} },
      is_default: true,
    },
  },
}

const REMOTE_MMODEL = {
  key: 'mmodel',
  enable: true,
  display_name: 'MiniMax-M3.1-Flash',
  is_vl: true,
  is_reasoning: false,
  price_factor: 0.1,
  context_config: { '200K': { token_count: 200000, is_default: true } },
}

/**
 * `QoDuck`（`lmodel`）—— 字段**逐项照抄 2026-11-07 真机响应**的 `app` 场景。
 *
 * ⚠️ 它**只出现在 `app` 场景**（`chat` 里没有），且**不带 `minimal_version`**
 * —— 这正是「只读 `chat` 就看不见它」的成因，见 `qoder-catalog.ts` 模块头。
 */
const REMOTE_LMODEL = {
  key: 'lmodel',
  status: 'idle',
  format: 'openai',
  source: 'system',
  enable: true,
  icon: 'QoderQoduckFill',
  display_name: 'QoDuck',
  is_vl: true,
  is_reasoning: true,
  is_default: false,
  is_new: true,
  price_factor: 0,
  original_price_factor: 0.5,
  max_input_tokens: 180000,
  is_sensitive: true,
  tags: ['free'],
  is_free: true,
  is_lite_plan: true,
  is_editable: true,
  context_config: {
    '1M': { token_count: 1000000 },
    '200K': { token_count: 200000, is_default: true },
    '400K': { token_count: 400000 },
  },
  thinking_config: {
    disabled: {},
    enabled: {
      efforts: { xhigh: {}, high: { is_default: true }, low: {} },
      is_default: true,
    },
  },
}

/**
 * Sanitized real model entry captured from Qoder CN/Global app catalogs on 2026-11-25
 * with the verified 10/app/app/app tuple. Account and auth fields are omitted.
 */
const REMOTE_HUNGERG = {
  key: 'hmodel',
  display_name: 'HungerG',
  enable: true,
  is_free: true,
  price_factor: 0,
  original_price_factor: 0,
  is_vl: true,
  is_reasoning: true,
  max_input_tokens: 1000000,
  context_config: {
    '1M': { token_count: 1000000 },
    '200K': { token_count: 200000, is_default: true },
    '400K': { token_count: 400000 },
  },
  thinking_config: {
    disabled: {},
    enabled: { efforts: { high: {}, max: { is_default: true }, low: {} }, is_default: true },
  },
  minimal_version: {
    cli: '9999.9999.9999', qoder_work: '9999.9999.9999', mobile: '9999.9999.9999',
    jb_plugin: '9999.9999.9999', cloud_agents: '9999.9999.9999', qoder_wake: '9999.9999.9999',
  },
  is_lite_plan: true,
  tags: ['free'],
  source: 'system',
  format: 'openai',
}

describe('parseQoderRemoteModels', () => {
  it('把远端条目转成兜底表同形（价格/免费/上下文按档位表最大档）', () => {
    const models = parseQoderRemoteModels({ chat: [REMOTE_DFMODEL, REMOTE_MMODEL] })
    expect(models?.map((m) => m.id)).toEqual(['dfmodel', 'mmodel'])
    const df = models![0]!
    expect(df.name).toBe('DeepSeek-Flash')
    expect(df.priceFactor).toBe(0)
    expect(df.originalPriceFactor).toBe(0.1)
    expect(df.isFree).toBe(true)
    expect(df.supportsImage).toBe(true)
    expect(df.supportsThinking).toBe(false)
    expect(df.contextWindow).toBe(1_000_000)
    expect(models![1]!.contextWindow).toBe(200_000)
  })

  it('⚠️ price_factor = 0 是**合法值**（免费），不能当缺失丢掉', () => {
    const model = qoderRemoteModelToFallback(REMOTE_DFMODEL)
    expect(model?.priceFactor).toBe(0)
    expect(Object.hasOwn(model!, 'priceFactor')).toBe(true)
  })

  it('档位保持上游键序、按白名单过滤、别名归一，且默认档取 is_default', () => {
    const model = qoderRemoteModelToFallback({
      ...REMOTE_DFMODEL,
      thinking_config: {
        disabled: {},
        enabled: {
          efforts: {
            // 白名单外的键必须被丢掉（客户端 `ao()` 也丢），否则 DSH 会渲染出
            // 一个上游不认的档位。
            bogus: {},
            max: { is_default: true },
            off: {},
            xhigh: {},
          },
        },
      },
    })
    expect(model?.efforts).toEqual(['max', 'none', 'xhigh'])
    expect(model?.defaultEffort).toBe('max')
    expect(model?.supportsDisable).toBe(true)
  })

  it('只有 disabled、无 efforts ⇒ 只有「关闭思考」（supportsDisable 与 efforts 相互独立）', () => {
    const model = qoderRemoteModelToFallback({
      key: 'qmodel', display_name: 'Qwen3.7-Plus',
      thinking_config: { disabled: {}, enabled: { is_default: true } },
    })
    expect(model?.efforts).toBeUndefined()
    expect(model?.supportsDisable).toBe(true)
  })

  it('错峰折扣映射为 QoderModelPromotion（窗口 + 折扣 + 角标）', () => {
    const model = qoderRemoteModelToFallback({
      key: 'qmodel_38max', display_name: 'Qwen3.8-Max', price_factor: 0.5,
      promotion: {
        active: false,
        discount_factor: 0.4,
        before_promotion_price_factor: 0.5,
        window_start: '22:00',
        window_end: '08:00',
        badge: { zh: '错峰 4 折' },
      },
    })
    expect(model?.promotion).toEqual({
      active: false,
      discountFactor: 0.4,
      beforePromotionPriceFactor: 0.5,
      windowStart: '22:00',
      windowEnd: '08:00',
      badgeZh: '错峰 4 折',
    })
  })

  /**
   * 双语文本块的读取口径（对齐官方 `Yg1()` / `Zq()`）。
   *
   * ⚠️ 每条都对着**一个会静默失效的方向**：认错键 ⇒ 整条徽标消失；
   * 不 trim ⇒ 上游发一个空格画出一个**空胶囊**。
   */
  describe('promotion 的双语文本按官方四键口径读（2026-11-18 对齐）', () => {
    const promo = (extra: Record<string, unknown>) => qoderRemoteModelToFallback({
      key: 'm', display_name: 'M', price_factor: 0.5,
      promotion: { active: false, window_start: '22:00', window_end: '08:00', ...extra },
    })?.promotion

    it('只发 cn_zh ⇒ 中文槽拿到，英文槽不填（跨语言兜底在下游）', () => {
      expect(promo({ badge: { cn_zh: '错峰 4 折' } })?.badgeZh).toBe('错峰 4 折')
      expect(promo({ badge: { cn_zh: '错峰 4 折' } })?.badgeEn).toBeUndefined()
    })

    it('只发 en_us ⇒ 英文槽拿到', () => {
      expect(promo({ badge: { en_us: 'Off-Peak 60% off' } })?.badgeEn).toBe('Off-Peak 60% off')
    })

    it('两个都发 ⇒ 先手键优先（zh 先于 cn_zh，en 先于 en_us）', () => {
      const p = promo({ badge: { zh: '甲', cn_zh: '乙', en: 'A', en_us: 'B' } })
      expect(p?.badgeZh).toBe('甲')
      expect(p?.badgeEn).toBe('A')
    })

    it('★ description 与 badge 同口径读，且**两条腿互不影响**', () => {
      const p = promo({ badge: { zh: '错峰 4 折' }, description: { zh: '错峰时段4折优惠（10 PM-8 AM UTC+8）' } })
      expect(p?.badgeZh).toBe('错峰 4 折')
      expect(p?.descriptionZh).toBe('错峰时段4折优惠（10 PM-8 AM UTC+8）')
    })

    it('★★ description 走**同一个**四键解析器（区域变体也必须读出来）', () => {
      // 守的是「同一 schema 两套判据」：badge 读了 cn_zh/en_us 而 description 只读 zh/en 时，
      // 上游改发区域变体就变成「徽标还在、原话没了」，且两条腿都静默（零日志）。
      expect(promo({ description: { cn_zh: '中文原话' } })?.descriptionZh).toBe('中文原话')
      expect(promo({ description: { en_us: 'English note' } })?.descriptionEn).toBe('English note')
      // 优先级同 badge：zh 先于 cn_zh / en 先于 en_us。
      expect(promo({ description: { zh: '甲', cn_zh: '乙' } })?.descriptionZh).toBe('甲')
      expect(promo({ description: { en: 'A', en_us: 'B' } })?.descriptionEn).toBe('A')
    })

    it('★ 去空白：两边带空格要 trim，纯空白按官方口径**视为空**（否则画一个空胶囊）', () => {
      expect(promo({ badge: { zh: '  错峰 4 折  ' } })?.badgeZh).toBe('错峰 4 折')
      expect(promo({ badge: { zh: '   ' } })?.badgeZh).toBeUndefined()
      expect(promo({ badge: { zh: ' ' , en: 'Off-Peak' } })?.badgeEn).toBe('Off-Peak')
      // 英文格同样要 trim —— 用例名写着「两边」，原先只断言了中文格 ⇒ 英文腿零守卫
      // （变异「英文格不 trim」在补这两行之前全绿）。
      expect(promo({ badge: { en: '  Off-Peak 60% off  ' } })?.badgeEn).toBe('Off-Peak 60% off')
      expect(promo({ badge: { en: '   ' } })?.badgeEn).toBeUndefined()
    })

    it('badge 不是对象 / 没有 badge ⇒ 都不产出（官方 XS0 也只吃对象）', () => {
      expect(promo({ badge: '错峰 4 折' })?.badgeZh).toBeUndefined()
      expect(promo({})?.badgeZh).toBeUndefined()
    })
  })

  it('丢掉 enable:false 与形状不符的条目，并按 id 去重', () => {
    const models = parseQoderRemoteModels({
      chat: [
        { ...REMOTE_MMODEL, enable: false },
        { key: 'x' },                        // 缺 display_name
        { display_name: '无 key' },          // 缺 key
        'not-an-object',
        REMOTE_MMODEL,
        REMOTE_MMODEL,                       // 重复 id ⇒ DSH 会抛 INVALID_CATALOG
      ],
    })
    expect(models?.map((m) => m.id)).toEqual(['mmodel'])
  })

  it('响应形状不符返回 undefined（与「空列表」严格区分）', () => {
    expect(parseQoderRemoteModels(null)).toBeUndefined()
    expect(parseQoderRemoteModels([])).toBeUndefined()
    expect(parseQoderRemoteModels({ developer: [] })).toBeUndefined()
    expect(parseQoderRemoteModels({ chat: [] })).toEqual([])
  })

  it('场景键可覆盖（默认 chat）', () => {
    expect(QODER_CATALOG_SCENE).toBe('chat')
    expect(parseQoderRemoteModels({ qwork: [REMOTE_MMODEL] }, 'qwork')?.length).toBe(1)
  })

  it('⚠️ 没有档位表也没有 available_context_windows ⇒ 窗口报 0（= 不声明，不编造）', () => {
    const model = qoderRemoteModelToFallback({ key: 'k', display_name: 'K', max_input_tokens: 180000 })
    expect(model?.contextWindow).toBe(0)
  })
})

/**
 * `chat ∪ app` 场景合并（2026-11-07）。
 *
 * 每一条都对应一处**真实成因**：`QoDuck` 只发布在 `app` 场景、且**不带**
 * `minimal_version` ⇒ 只读 `chat` 的实现结构性地看不见它（不是版本问题）。
 */
describe('parseQoderRemoteModelsForScenes（chat ∪ app）', () => {
  it('默认场景与优先级：chat → app', () => {
    expect(QODER_CATALOG_SCENES).toEqual(['chat', 'app'])
  })

  it('app 场景先解析上游目录，再由白名单 helper 只追加 HungerG', () => {
    const cliParsed = parseQoderRemoteModels({ chat: [REMOTE_DFMODEL] })!
    const appParsed = parseQoderRemoteModelsForScenes({
      chat: [],
      app: [REMOTE_DFMODEL, REMOTE_LMODEL, REMOTE_HUNGERG],
    })!
    expect(appParsed.map((model) => model.id)).toEqual(['dfmodel', 'lmodel', 'hmodel'])
    const hungerG = appParsed[2]!
    expect(hungerG.name).toBe('HungerG')
    expect(hungerG.contextWindow).toBe(1_000_000)
    expect(hungerG.isFree).toBe(true)
    expect(hungerG.priceFactor).toBe(0)

    const merged = mergeQoderAppOnlyModels(cliParsed, appParsed)
    expect(merged.map((model) => model.id)).toEqual(['dfmodel', 'hmodel'])
    expect(merged[1]).toMatchObject({ id: 'hmodel', isFree: true, priceFactor: 0, requiresAppIdentity: true })
    // QoDuck and other app-only entries never switch the default CLI identity.
    expect(mergeQoderAppOnlyModels(cliParsed, parseQoderRemoteModels({ chat: [REMOTE_LMODEL] })!).map((model) => model.id))
      .toEqual(['dfmodel'])
  })

  it('⚠️ 同 id 两边都有 ⇒ 取 chat 那条（顺序即优先级），且不产生重复 id', () => {
    // 重复 id 会让 DSH 的 `listModels` 抛 INVALID_CATALOG（整个 provider 消失），
    // 比少一个模型更糟 ⇒ 去重必须与合并同时做。
    const models = parseQoderRemoteModelsForScenes({
      chat: [{ ...REMOTE_MMODEL, display_name: '来自 chat' }],
      app: [{ ...REMOTE_MMODEL, display_name: '来自 app' }],
    })
    expect(models?.map((m) => m.id)).toEqual(['mmodel'])
    expect(models![0]!.name).toBe('来自 chat')
  })

  it('⚠️ chat 为空但 app 有模型 ⇒ 照常返回（不能被「空 chat」判成协议非法）', () => {
    expect(parseQoderRemoteModelsForScenes({ chat: [], app: [REMOTE_LMODEL] })?.map((m) => m.id))
      .toEqual(['lmodel'])
  })

  it('app 缺失或形状非法时退回 chat（旧响应向后兼容）', () => {
    expect(parseQoderRemoteModelsForScenes({ chat: [REMOTE_MMODEL] })?.map((m) => m.id))
      .toEqual(['mmodel'])
    expect(parseQoderRemoteModelsForScenes({ chat: [REMOTE_MMODEL], app: 'nope' })?.map((m) => m.id))
      .toEqual(['mmodel'])
  })

  it('一个场景都不是数组 ⇒ undefined（协议变了，与空列表严格区分）', () => {
    expect(parseQoderRemoteModelsForScenes(null)).toBeUndefined()
    expect(parseQoderRemoteModelsForScenes([])).toBeUndefined()
    expect(parseQoderRemoteModelsForScenes({ developer: [] })).toBeUndefined()
  })
})

/**
 * 2026-10-20 审计/对抗审计补的守卫。
 *
 * 每一条都对应一处**实测过的假绿**：变异注入后相关 spec 全绿、而语义已错
 * （见 `docs/agent-notes/providers-qoder.md` 的「审计补记」）。
 */
describe('解析层：审计补记的七格', () => {
  it('⚠️ 没有 disabled 分支 ⇒ supportsDisable 不得为真（不得臆造「关闭思考」）', () => {
    // 变异「supportsDisable = true 恒真」原先 175 条全绿：所有用例的输入
    // **都带 disabled** 且都断言 true ⇒ 变异态与修复态在被断言的输入上取值相同。
    const noDisabled = qoderRemoteModelToFallback({
      key: 'k', display_name: 'K',
      thinking_config: { enabled: { efforts: { high: { is_default: true } } } },
    })
    expect(noDisabled?.efforts).toEqual(['high'])
    expect(noDisabled?.supportsDisable).toBeUndefined()
    // 连 thinking_config 都没有的条目同样不得报「可关闭」。
    expect(qoderRemoteModelToFallback({ key: 'k2', display_name: 'K2' })?.supportsDisable).toBeUndefined()
  })

  it('顶层 supports_disabled 也算可关闭（官方 `l = … || e.supports_disabled`）', () => {
    const model = qoderRemoteModelToFallback({ key: 'k', display_name: 'K', supports_disabled: true })
    expect(model?.supportsDisable).toBe(true)
  })

  it('⚠️ 档位顺序**原样保留**（非字典序输入 ⇒ 排序变异必须变红）', () => {
    const model = qoderRemoteModelToFallback({
      key: 'k', display_name: 'K',
      thinking_config: { enabled: { efforts: { max: {}, low: {}, high: {} } } },
    })
    // 字典序是 high,low,max —— 与上游键序不同，故 `efforts.sort()` 会被这条抓住。
    expect(model?.efforts).toEqual(['max', 'low', 'high'])
  })

  it('⚠️ 空串 key / display_name 必须丢弃（DSH 空 name 会抛 INVALID_CATALOG）', () => {
    expect(qoderRemoteModelToFallback({ key: '', display_name: 'X' })).toBeUndefined()
    expect(qoderRemoteModelToFallback({ key: 'x', display_name: '' })).toBeUndefined()
    expect(parseQoderRemoteModels({
      chat: [{ key: '', display_name: 'X' }, { key: 'x', display_name: '' }],
    })).toEqual([])
  })

  it('⚠️ efforts 三形态都认：数组 / 逗号或空格字符串 / 对象（官方 sgi() 原样）', () => {
    const viaArray = qoderRemoteModelToFallback({
      key: 'k', display_name: 'K', thinking_config: { enabled: { efforts: ['low', 'high', 'low', 'bogus'] } },
    })
    expect(viaArray?.efforts).toEqual(['low', 'high'])

    const viaString = qoderRemoteModelToFallback({
      key: 'k', display_name: 'K', thinking_config: { enabled: { efforts: 'low, high  max' } },
    })
    expect(viaString?.efforts).toEqual(['low', 'high', 'max'])

    // 对象形态（真机实测形态）仍保持键序与 is_default。
    const viaObject = qoderRemoteModelToFallback({
      key: 'k', display_name: 'K',
      thinking_config: { enabled: { efforts: { max: { is_default: true }, low: {} } } },
    })
    expect(viaObject?.efforts).toEqual(['max', 'low'])
    expect(viaObject?.defaultEffort).toBe('max')
  })

  it('⚠️ available_reasoning_effort 是**一个 thinking_config 对象**（要包一层解析）', () => {
    // 官方：`a = R3(e) ?? R3({ thinking_config: e.available_reasoning_effort })`
    const model = qoderRemoteModelToFallback({
      key: 'k', display_name: 'K',
      available_reasoning_effort: {
        disabled: {},
        enabled: { efforts: { low: {}, high: { is_default: true } } },
      },
    })
    expect(model?.efforts).toEqual(['low', 'high'])
    expect(model?.defaultEffort).toBe('high')
    expect(model?.supportsDisable).toBe(true)

    // 反面：**裸档位表**形态按官方语义**不认**（它必须先包成 thinking_config）。
    const bare = qoderRemoteModelToFallback({
      key: 'k', display_name: 'K', available_reasoning_effort: { low: {}, high: {} },
    })
    expect(bare?.efforts).toBeUndefined()
  })

  it('默认档：档位对象没给 is_default 时用顶层 default_effort（官方 ci(...) 兜底）', () => {
    const model = qoderRemoteModelToFallback({
      key: 'k', display_name: 'K',
      thinking_config: { enabled: { efforts: { low: {}, high: {} } } },
      default_effort: 'high',
    })
    expect(model?.efforts).toEqual(['low', 'high'])
    expect(model?.defaultEffort).toBe('high')
    // 顶层值不在白名单内 ⇒ 不采用（官方 `Tae()` 同口径）。
    const bogus = qoderRemoteModelToFallback({
      key: 'k2', display_name: 'K2',
      thinking_config: { enabled: { efforts: { low: {} } } }, default_effort: 'bogus',
    })
    expect(bogus?.defaultEffort).toBeUndefined()
  })

  it('is_default / isDefault 两种写法都认（官方 vhc()）', () => {
    const camel = qoderRemoteModelToFallback({
      key: 'k', display_name: 'K',
      thinking_config: { enabled: { efforts: { low: {}, high: { isDefault: true } } } },
    })
    expect(camel?.defaultEffort).toBe('high')
  })

  it('⚠️ 档位白名单与官方 k3 一致：6 个值、**不含 minimal**', () => {
    const model = qoderRemoteModelToFallback({
      key: 'k', display_name: 'K',
      thinking_config: { enabled: { efforts: { minimal: {}, high: {} } } },
    })
    // 官方 `k3 = ["none","low","medium","high","xhigh","max"]` ⇒ minimal 被丢弃。
    expect(model?.efforts).toEqual(['high'])
  })
})

describe('fetchQoderRemoteModels', () => {
  it('默认目录请求继续使用 CLI tuple，WASM COSY 签名可解析标准模型', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ chat: [REMOTE_DFMODEL, REMOTE_MMODEL] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const models = await fetchQoderRemoteModels(cred, QODER, { fetcher: fetchImpl as never })
    expect(models.map((m) => m.id)).toEqual(['dfmodel', 'mmodel'])

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain(QODER_MODEL_LIST_PATH)
    expect(url.startsWith(QODER.encryptedInferBase)).toBe(true)
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toMatch(/^Bearer COSY\./)
    expect(headers.get('cosy-clienttype')).toBe('5')
    expect(headers.get('cosy-version')).toBe('1.1.79')
  })

  it('app-only 目录探测使用 numeric desktop tuple 与真实 HungerG 响应字段', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ assistant: [REMOTE_HUNGERG], app: [REMOTE_HUNGERG] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const models = await fetchQoderRemoteModels(cred, QODER_CN, {
      fetcher: fetchImpl as never, metadata: QODER_CN.appClientMetadata, allowEmpty: true,
    })
    expect(models.map((model) => model.id)).toEqual(['hmodel'])
    expect(models[0]).toMatchObject({ name: 'HungerG', isFree: true, priceFactor: 0 })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('cosy-clienttype')).toBe('10')
    expect(headers.get('cosy-version')).toBe('1.1.79')
  })

  it('app-only 目录合法返回空集合时不当作主目录故障', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ app: [], assistant: [] }), { status: 200 }))
    await expect(fetchQoderRemoteModels(cred, QODER, {
      fetcher: fetchImpl as never, metadata: QODER.appClientMetadata, allowEmpty: true,
    })).resolves.toEqual([])
    await expect(fetchQoderRemoteModels(cred, QODER, {
      fetcher: fetchImpl as never, metadata: QODER.appClientMetadata,
    })).rejects.toThrow(/为空/)
  })

  it('CN 走它自己的 host（两站共用同一实现，差异只在产品配置）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ chat: [REMOTE_MMODEL] }), { status: 200 }))
    await fetchQoderRemoteModels(cred, QODER_CN, { fetcher: fetchImpl as never })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.startsWith(QODER_CN.encryptedInferBase)).toBe(true)
    const headers = init.headers as Record<string, string>
    const gatewayClientType = Object.entries(headers).find(([key]) => key.toLowerCase() === 'cosy-clienttype')?.[1]
    expect(gatewayClientType).toBe('5')
  })

  it('非 2xx 抛错并**带上响应体片段**（401/403 分不开 token 过期与签名无效）', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(
      JSON.stringify({ code: '105', message: 'Login expired' }), { status: 403 },
    )
    await expect(fetchQoderRemoteModels(cred, QODER, { fetcher: fetchImpl as never }))
      .rejects.toThrow(/HTTP 403.*Login expired/)
  })

  it('空列表抛错（调用方据此回退兜底表，而不是把菜单变空）', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ chat: [] }), { status: 200 })
    await expect(fetchQoderRemoteModels(cred, QODER, { fetcher: fetchImpl as never }))
      .rejects.toThrow(/为空/)
  })

  it('响应不是 JSON 时抛错，不静默返回空目录', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('<html>502</html>', { status: 200 })
    await expect(fetchQoderRemoteModels(cred, QODER, { fetcher: fetchImpl as never })).rejects.toThrow()
  })

  it('⚠️ 凭据缺 uid / machine_id ⇒ 直接抛错，不发一次注定失败的请求', async () => {
    const fetchImpl = vi.fn()
    const noUid = { ...cred, uid: undefined }
    await expect(fetchQoderRemoteModels(noUid, QODER, { fetcher: fetchImpl as never }))
      .rejects.toThrow(/uid/)
    expect(fetchImpl).not.toHaveBeenCalled()

    const noMachine = { ...cred, machine_id: '' }
    await expect(fetchQoderRemoteModels(noMachine, QODER, { fetcher: fetchImpl as never }))
      .rejects.toThrow(/machine_id/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
