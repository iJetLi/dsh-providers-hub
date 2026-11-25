import { describe, expect, it } from 'vitest'
import { QODER, QODER_CN, type QoderProduct, ALL_QODER_PRODUCTS, qoderProductById } from '../../src/qoder-product.js'
import { promotionActiveNow, qoderDisplayName } from '../../src/qoder-adapter.js'

describe('Qoder 产品配置', () => {
  it('端点常量与逆向结果一致（国际版）', () => {
    // 依据：设计文档 §2.1 environments.prod
    expect(QODER.authBase).toBe('https://qoder.com')
    expect(QODER.openApiBase).toBe('https://openapi.qoder.sh')
    // ⚠️ 推理基址与 environments.prod.inferBaseUrl（api2.qoder.sh）不同
    expect(QODER.inferBase).toBe('https://api2-v2.qoder.sh')
  })

  it('prod 用 J_a 作 clientId，G_a 仅作非 prod 记录', () => {
    // 依据：源码 `client_id: i ? J_a : G_a`，调用点第 4 参是 isProd()。
    // **不要读反** —— 早期读反导致 GitHub 授权后报「参数无效」（真实缺陷）。
    expect(QODER.clientId).toBe('e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
    expect(QODER.testClientId).toBe('e93fe488-5778-4c35-a6fc-0f54ed7b3139')
  })

  it('CLI 默认身份保留，app-only 模型有独立桌面身份', () => {
    const cli = { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' }
    const desktop = { client_type: '10', business_product: 'app', business_type: 'app', scene: 'app' }
    expect(QODER.clientMetadata).toEqual(cli)
    expect(QODER_CN.clientMetadata).toEqual(cli)
    expect(QODER.appClientMetadata).toEqual(desktop)
    expect(QODER_CN.appClientMetadata).toEqual(desktop)
    expect(QODER.appSessionType).toBe('app')
    expect(QODER_CN.appSessionType).toBe('app')
    // `/sash` 仍独立使用桌面身份 client type 10。
    expect(QODER.sashClientType).toBe('10')
    expect(QODER_CN.sashClientType).toBe('10')
  })

  it('默认凭据 ref 与其它 provider 隔离', () => {
    expect(QODER.defaultCredentialRef).toBe('QODER_ACCESS_TOKEN')
  })

  it('兜底模型表非空、id 唯一、含 auto', () => {
    const ids = QODER.fallbackModels.map((m) => m.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('auto')
  })

  it('加密端点与公开端点**不是同一个 host**', () => {
    // 这是踩过的坑：加密推理（agent_chat_generation）走 api2.qoder.sh，
    // 公开 OpenAI 兼容端点走 api2-v2.qoder.sh。混用会 404。
    expect(QODER.inferBase).toBe('https://api2-v2.qoder.sh')
    expect(QODER.encryptedInferBase).toBe('https://api2.qoder.sh')
    expect(QODER.encryptedInferBase).not.toBe(QODER.inferBase)
  })

  it('展示名必须含模型名与版本，不能只写厂商（用户报障）', () => {
    // 真实缺陷（用户报障）：「选择模型时看到的是 GLM、DeepSeek、MiniMax，
    // 只有厂商名字没有模型名字和版本，这个显示肯定不对」。
    // 展示名是用户唯一的辨识依据，只写厂商等于没有信息。
    const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m.name]))
    expect(byId.get('gmodel')).toBe('GLM-5.3')
    expect(byId.get('dmodel')).toBe('DeepSeek-V4-Pro')
    expect(byId.get('mmodel')).toBe('MiniMax-M3')
    expect(byId.get('kmodel')).toBe('Kimi-K2.8-Preview')
    expect(byId.get('qmodel')).toBe('Qwen3.7-Plus')
  })

  it('表里是**模型目录 key**，与本机 catalog-v6 逐条一致', () => {
    // ⚠️ 早期误以为「目录 key 不能用于推理」，于是把表换成通用名
    // （qwen-flash 等），结果拿到的是 Qwen3.5/2.5 而非目录里的 Qwen3.8 系列
    // （用户报障）。真相：目录 key 用于**加密端点**，通用名用于公开端点。
    const ids = QODER.fallbackModels.map((m) => m.id)
    // 本机 catalog-v6 的 chat 场景 17 个 key（实测 2026-09-20）
    expect(ids).toEqual([
      'auto', 'ultimate', 'performance', 'efficient',
      'smodel', 'cmodel',
      'qmodel_38max', 'qfmodel',
      'qmodel_latest', 'qmodel',
      'kmodel_latest', 'kmodel',
      'gmodel', 'gfmodel',
      'dmodel', 'dfmodel',
      'mmodel',
    ])
    // 通用名**不属于**这张表（它们只在公开端点有意义）
    expect(ids).not.toContain('qwen-flash')
    expect(ids).not.toContain('qwen-plus')
  })

  it('Qwen3.8 系列必须在表内（这是本次修复的核心目标）', () => {
    const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m.name]))
    expect(byId.get('qfmodel')).toBe('Qwen3.8-Flash')
    expect(byId.get('qmodel_38max')).toBe('Qwen3.8-Max')
  })

  it('免费额度模型标记正确（Qwen3.8-Max / Qwen3.8-Flash）', () => {
    const free = QODER.fallbackModels.filter((m) => m.isFree === true).map((m) => m.id)
    expect(free.sort()).toEqual(['qfmodel', 'qmodel_38max'])
  })

  it('支持思考的模型要带 efforts 档位，不支持的留空', () => {
    const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m]))
    // 实测：ultimate 有 xhigh/high/low/max/medium；qmodel_38max 只有 xhigh/low/medium
    expect(byId.get('ultimate')?.efforts).toEqual(['xhigh', 'high', 'low', 'max', 'medium'])
    expect(byId.get('qmodel_38max')?.efforts).toEqual(['xhigh', 'low', 'medium'])
    // auto / efficient 是非思考模型
    expect(byId.get('auto')?.supportsThinking).toBe(false)
    expect(byId.get('auto')?.efforts).toBeUndefined()
  })

  it('每个兜底模型都有正的 contextWindow', () => {
    for (const model of QODER.fallbackModels) {
      expect(model.contextWindow, model.id).toBeGreaterThan(0)
    }
  })

  /**
   * 国际版与国际版**同一根因**（详见下方 CN 的 `上下文窗口取官方档位表的最大档` 用例）：
   * 旧表照抄 `max_input_tokens`（`smodel`/`gmodel`/`kmodel_latest` 等写 180K），
   * 但客户端 `LV()` 只要有档位表就只查成员资格。
   * 实测档位表（`scripts/probe-qoder-windows.mjs intl`）：除 `auto` 外全部含 1M 档。
   * ⚠️ 国际版**没有**服务端实发验证（`api2.qoder.sh` 在本机网络不通），
   * 故这里锁的是「客户端逻辑 + 目录档位表」这条依据。
   */
  it('上下文窗口取官方档位表的最大档（除无档位表的 auto）', () => {
    const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m]))
    for (const id of [
      'ultimate', 'performance', 'efficient', 'smodel', 'cmodel',
      'qmodel_38max', 'qfmodel', 'qmodel_latest', 'qmodel',
      'kmodel_latest', 'kmodel', 'gmodel', 'gfmodel', 'dmodel', 'dfmodel', 'mmodel',
    ]) {
      expect(byId.get(id)?.contextWindow, `${id} 的 contextWindow`).toBe(1_000_000)
    }
    // `auto` 无档位表（客户端 `HV()` 会造出 128K/200K/max 三档），沿用 200K。
    expect(byId.get('auto')?.contextWindow).toBe(200_000)
  })

  it('qoderProductById 命中与未命中', () => {
    expect(qoderProductById('qoder')).toBe(QODER)
    expect(qoderProductById('nope')).toBeUndefined()
    // 中国版加入后是两个同族产品（国际版 + 中国版）。
    expect(ALL_QODER_PRODUCTS).toHaveLength(2)
  })

  /**
   * ⚠️ 真实缺陷（用户报障）：「qwen3.8-max 是 0.5 原价打折到 0.2，
   * 现在界面显示的是 0.5 不是 0.2」。
   *
   * 根因**不是展示逻辑**，而是兜底表的数值大范围过期 —— 早期表里多处是
   * 手工估值，与真实 catalog 有 14 个模型对不上（`smodel` 写 3.2 实际 8、
   * `qmodel_38max` 写 0.5 实际 0.2 …）。而旧用例**只断言了 id 列表**，
   * 所以价格漂移一直没被发现。这里锁死真实数值。
   */
  it('倍率与真实 catalog 一致（用户报障：显示 0.5 而非折后 0.2）', () => {
    const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m]))
    // 实测 2026-09-21 的 catalog-v6 `price_factor`（采集时刻的生效价）
    const expected: Record<string, number> = {
      auto: 0.5, ultimate: 2, performance: 1.1, efficient: 0.3,
      smodel: 8, cmodel: 4,
      qmodel_38max: 0.2, qfmodel: 0, qmodel_latest: 0.1, qmodel: 0.04,
      kmodel_latest: 1.4, kmodel: 0.8,
      gmodel: 0.8, gfmodel: 0.1,
      dmodel: 0.5, dfmodel: 0.1,
      mmodel: 0.2,
    }
    for (const [id, price] of Object.entries(expected)) {
      expect(byId.get(id)?.priceFactor, `${id} 的 priceFactor`).toBe(price)
    }
  })

  it('错峰促销：原价 × 折扣 = 折后价（三条实测全部吻合）', () => {
    const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m]))
    for (const id of ['qmodel_38max', 'qmodel_latest', 'qmodel']) {
      const m = byId.get(id)
      const p = m?.promotion
      expect(p, `${id} 应有 promotion`).toBeDefined()
      const computed = p!.beforePromotionPriceFactor! * p!.discountFactor!
      // priceFactor 是采集时刻的生效价（当时在窗口内 → 等于折后价）
      expect(Number(computed.toFixed(4)), `${id} 折后价`).toBe(m!.priceFactor)
      // 且折扣确实更便宜
      expect(m!.priceFactor!).toBeLessThan(p!.beforePromotionPriceFactor!)
    }
  })

  it('窗口字段齐备（展示层据此本地推算，不依赖会过期的 active 快照）', () => {
    for (const m of QODER.fallbackModels) {
      if (m.promotion === undefined) continue
      expect(m.promotion.windowStart, m.id).toMatch(/^\d{1,2}:\d{2}$/)
      expect(m.promotion.windowEnd, m.id).toMatch(/^\d{1,2}:\d{2}$/)
    }
  })
})

describe('Qoder 错峰时段判定（本地推算）', () => {
  const promo = {
    active: false, // ⚠️ 故意写错：快照不可信，必须以窗口为准
    discountFactor: 0.4,
    beforePromotionPriceFactor: 0.5,
    windowStart: '22:00',
    windowEnd: '08:00',
  }
  const at = (iso: string): Date => new Date(iso)

  it('跨零点窗口：22:00–08:00 的各边界', () => {
    expect(promotionActiveNow(promo, at('2026-09-21T00:18:00+08:00'))).toBe(true)
    expect(promotionActiveNow(promo, at('2026-09-21T03:00:00+08:00'))).toBe(true)
    expect(promotionActiveNow(promo, at('2026-09-21T07:59:00+08:00'))).toBe(true)
    expect(promotionActiveNow(promo, at('2026-09-21T08:00:00+08:00'))).toBe(false)
    expect(promotionActiveNow(promo, at('2026-09-21T12:00:00+08:00'))).toBe(false)
    expect(promotionActiveNow(promo, at('2026-09-21T21:59:00+08:00'))).toBe(false)
    expect(promotionActiveNow(promo, at('2026-09-21T22:00:00+08:00'))).toBe(true)
  })

  it('窗口字段缺失时回退到目录的 active', () => {
    const noWindow = { active: true, discountFactor: 0.4 }
    expect(promotionActiveNow(noWindow, at('2026-09-21T12:00:00+08:00'))).toBe(true)
    expect(promotionActiveNow({ ...noWindow, active: false }, at('2026-09-21T00:00:00+08:00'))).toBe(false)
  })

  it('★★ 非法窗口值 ⇒ **不生效**（不抛错，也**不**回退 active 快照）', () => {
    // ⚠️ 本条原断言 `toBe(true)`（= 回退目录快照），那是 PR #104 之前的契约。
    // 对抗审计（P1-3）实测它与徽标腿**反向**：徽标腿把读不懂的窗口判死
    // （`dailyUnusable` ⇒ 永不成立），价格腿却退回一个**冻结在目录下发时刻**的
    // 布尔 ⇒ 上游把 `22:30–07:50` 写成 `'xx'` 时会出现「徽标灭 / 价格亮」。
    //
    // 契约改为：**「字段缺席」才回退快照**（上游没给窗口就信它），
    // **「字段读不懂」一律 fail-closed**（两条腿同判）。
    const bad = { active: true, windowStart: 'xx', windowEnd: 'yy' }
    expect(promotionActiveNow(bad, at('2026-09-21T12:00:00+08:00'))).toBe(false)
    // 字段缺席仍然回退快照（不能被本条修法误伤）。
    expect(promotionActiveNow({ active: true }, at('2026-09-21T12:00:00+08:00'))).toBe(true)
  })

  it('id 联合类型可容纳同族的中国版（类型回归）', () => {
    // 拓宽之前，下面这一行会让 `pnpm typecheck` 报
    // `Type '"qodercn"' is not assignable to type '"qoder"'`。
    // ⚠️ 本用例的红/绿判据是 **typecheck**，不是 vitest —— 拓宽之后它运行时恒真，
    // 存在的意义是「让那一行不被当作未使用变量删掉」，并锁住联合类型的形状。
    const id: QoderProduct['id'] = 'qodercn'
    expect(id).toBe('qodercn')
  })
})

describe('Qoder 展示名', () => {
  const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m]))
  const inWindow = new Date('2026-09-21T00:18:00+08:00')
  const outWindow = new Date('2026-09-21T12:00:00+08:00')

  // ⚠️ **折扣显示形态与 TRAE / buddy 对齐**（用户要求）：
  //   TRAE   `Seed-2.1-Turbo · x0.4→x0.2`
  //   buddy  `GLM-5.2 · x0.79→x0.50`
  //   Qoder  `Qwen3.8-Max · x0.5→x0.2`   ← 本次统一
  //
  // 旧形态是「只有折后价 + 中文角标」（`x0.2 错峰 4 折`），两条信息：
  // ① 看不到原价与折扣幅度；② 角标与数字**冗余**（0.2/0.5 本就是 4 折）。
  it('窗口内显示 原价→折后价（与 TRAE/buddy 形态一致）', () => {
    const name = qoderDisplayName(byId.get('qmodel_38max')!, inWindow)
    expect(name).toBe('Qwen3.8-Max · x0.5→x0.2')
  })

  it('窗口外显示原价，且**不带箭头**（避免误导为有折扣）', () => {
    const name = qoderDisplayName(byId.get('qmodel_38max')!, outWindow)
    expect(name).toBe('Qwen3.8-Max · x0.5')
    expect(name).not.toContain('→')
    expect(name).not.toContain('错峰')
  })

  it('折扣幅度不同的模型也走箭头形态', () => {
    // qmodel_latest：原价 0.5、2 折 → 0.1
    expect(qoderDisplayName(byId.get('qmodel_latest')!, inWindow)).toBe('Qwen3.7-Max · x0.5→x0.1')
    // qmodel：原价 0.1、4 折 → 0.04
    expect(qoderDisplayName(byId.get('qmodel')!, inWindow)).toBe('Qwen3.7-Plus · x0.1→x0.04')
  })

  it('免费模型显示「免费」而不是 x0', () => {
    expect(qoderDisplayName(byId.get('qfmodel')!, inWindow)).toBe('Qwen3.8-Flash · 免费')
  })

  it('无促销的模型直接用 priceFactor（无箭头）', () => {
    expect(qoderDisplayName(byId.get('smodel')!, inWindow)).toBe('Sonus · x8')
    expect(qoderDisplayName(byId.get('dmodel')!, inWindow)).toBe('DeepSeek-V4-Pro · x0.5')
  })
})

describe('Qoder 中国版产品配置（qodercn）', () => {
  // 全部取值来自设计文档 §2 的取证表 E1–E13，不是推测。

  it('域名与中国版实测一致（E4）', () => {
    expect(QODER_CN.authBase).toBe('https://qoder.cn')
    expect(QODER_CN.openApiBase).toBe('https://openapi.qoder.com.cn')
    expect(QODER_CN.encryptedInferBase).toBe('https://gateway.qoder.com.cn')
  })

  it('client_id 是 CN 自己的值，与国际版不同（E2 —— 本任务最高风险字段）', () => {
    // 取自 CN asar 的 `Vpe.authClientIds.prod`。国际版两个 id 在 CN asar 里
    // **命中 0 次**，故「沿用国际版」是错的。
    // ⚠️ 国际版的教训：client_id 用错时**入口 302 完全正常**，只在授权回调阶段
    // 才报「参数无效」，所以不能靠探测 302 验证 —— 必须真实登录闭环。
    expect(QODER_CN.clientId).toBe('732aef47-9cf2-46a2-95fe-4cebb5d0d1fa')
    expect(QODER_CN.clientId).not.toBe(QODER.clientId)
  })

  it('CN 的 prod 与 test client_id 同值，不存在国际版读反的风险（E2）', () => {
    // 国际版有 J_a / G_a 两个常量且曾被读反（真实缺陷）。CN asar 里
    // `authClientIds: { prod: X, test: X }` 是同一个值，故无此风险。
    // 两字段仍保留是为了不改 `QoderProduct` 形状、也便于将来 CN 拆出 test。
    expect(QODER_CN.testClientId).toBe(QODER_CN.clientId)
  })

  it('provider id / 凭据 ref 与国际版完全隔离', () => {
    // 不同 ref 前缀 ⇒ 不同凭据条目 ⇒ 两站账号不会串用。
    expect(QODER_CN.id).toBe('qodercn')
    expect(QODER_CN.defaultCredentialRef).toBe('QODERCN_ACCESS_TOKEN')
    expect(QODER_CN.defaultCredentialRef).not.toBe(QODER.defaultCredentialRef)
  })

  it('sashClientType 与国际版同为 10（E10：CN asar 常量 Fh.clientType === 10）', () => {
    expect(QODER_CN.sashClientType).toBe('10')
  })

  it('注册进 ALL_QODER_PRODUCTS 且可按 id 取回', () => {
    expect(ALL_QODER_PRODUCTS.map((p) => p.id)).toEqual(['qoder', 'qodercn'])
    expect(qoderProductById('qodercn')).toBe(QODER_CN)
    expect(qoderProductById('nope')).toBeUndefined()
  })

  it('两产品的 id 与默认 ref 互不重复', () => {
    const ids = ALL_QODER_PRODUCTS.map((p) => p.id)
    const refs = ALL_QODER_PRODUCTS.map((p) => p.defaultCredentialRef)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(refs).size).toBe(refs.length)
  })
})

describe('Qoder 中国版兜底模型表（E6：catalog-v6 的 chat 场景 14 条）', () => {
  it('表内容与本机 CN catalog 逐条一致（顺序即目录原序）', () => {
    // ⚠️ 这张 id 列表**与国际版不同**：CN 独有 `q37fmodel` / `gm51model`，
    // 且**没有**国际版的 `ultimate` / `performance` / `efficient` / `smodel` /
    // `cmodel` 五条 —— 沿用国际版表会让菜单出现 5 个 CN 端点不认的模型。
    expect(QODER_CN.fallbackModels.map((m) => m.id)).toEqual([
      'auto',
      'qmodel_38max', 'qfmodel',
      'qmodel_latest', 'qmodel', 'q37fmodel',
      'dmodel', 'dfmodel',
      'gmodel', 'gfmodel', 'gm51model',
      'kmodel_latest', 'kmodel',
      'mmodel',
    ])
  })

  it('展示名含模型名与版本，不只写厂商（AGENTS.md 用户报障）', () => {
    const byId = new Map(QODER_CN.fallbackModels.map((m) => [m.id, m.name]))
    expect(byId.get('gmodel')).toBe('GLM-5.3')
    expect(byId.get('gm51model')).toBe('GLM-5.2')
    expect(byId.get('dmodel')).toBe('DeepSeek-V4-Pro')
    // ⚠️ CN 的 mmodel 是 **M2.7**，国际版是 M3 —— 版本必须照目录原值，不能对齐。
    expect(byId.get('mmodel')).toBe('MiniMax-M2.7')
    expect(byId.get('q37fmodel')).toBe('Qwen3.7-Flash')
  })

  it('倍率逐条对照 catalog，不凭印象填（国际版曾有 14 处偏差被报障）', () => {
    const byId = new Map(QODER_CN.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('auto')?.priceFactor).toBe(0.5)
    expect(byId.get('qmodel_38max')?.priceFactor).toBe(0.2)
    expect(byId.get('qmodel_latest')?.priceFactor).toBe(0.1)
    expect(byId.get('qmodel')?.priceFactor).toBe(0.04)
    expect(byId.get('dmodel')?.priceFactor).toBe(0.5)
    expect(byId.get('gmodel')?.priceFactor).toBe(0.8)
    expect(byId.get('gm51model')?.priceFactor).toBe(0.6)
    expect(byId.get('kmodel_latest')?.priceFactor).toBe(1.4)
    expect(byId.get('mmodel')?.priceFactor).toBe(0.2)
  })

  it('priceFactor 为 0 是「免费」，必须保留而不是当缺失丢掉', () => {
    // 实测 `qfmodel`（Qwen3.8-Flash）price_factor = 0、original_price_factor = 0.1。
    // 用 `> 0` 过滤会恰好漏掉用户最关心的免费模型。
    const qf = QODER_CN.fallbackModels.find((m) => m.id === 'qfmodel')
    expect(qf?.priceFactor).toBe(0)
    expect(qf?.originalPriceFactor).toBe(0.1)
    expect(qf?.isFree).toBe(true)
  })

  it('免费额度模型标 isFree，供 e2e 探针默认取用以免消耗积分', () => {
    const free = QODER_CN.fallbackModels.filter((m) => m.isFree === true).map((m) => m.id)
    expect(free).toEqual(['qmodel_38max', 'qfmodel'])
  })

  it('错峰促销与国际版同形（窗口 22:00–08:00，active 只作回退）', () => {
    const byId = new Map(QODER_CN.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('qmodel_38max')?.promotion).toMatchObject({
      discountFactor: 0.4, beforePromotionPriceFactor: 0.5,
      windowStart: '22:00', windowEnd: '08:00',
    })
    expect(byId.get('qmodel_latest')?.promotion?.discountFactor).toBe(0.2)
    expect(byId.get('qmodel')?.promotion?.discountFactor).toBe(0.4)
    // 生效价 = 原价 × 折扣（实测三条全部吻合）
    for (const id of ['qmodel_38max', 'qmodel_latest', 'qmodel']) {
      const m = byId.get(id)!
      expect(m.priceFactor).toBeCloseTo(
        (m.promotion!.beforePromotionPriceFactor! * m.promotion!.discountFactor!), 10)
    }
  })

  /**
   * ⚠️ 用户报障「Qoder 中国版的上下文窗口显示不对」的直接根因就在这条。
   *
   * 旧表把 CN 的 `contextWindow` 填成目录的 `max_input_tokens`（`dmodel` 96K、
   * 其余 180K）。但**官方客户端不读那个字段**：`isContextWindowSupportedByModel()`
   * 换算后交给 `zX()`，而 `zX()` 只要发现 `context_config` 档位表存在，
   * 就**只检查「是否为表内成员」**，`max_input_tokens` 兜底分支根本不执行
   * （asar 证据：`let i=Yai(A);if(i)return i.includes(t);let n=…max_input_tokens`）。
   *
   * > 口径（用户 2026-09-27 定）：**档位表有 1M 档就填 1M**。
   *
   * ⚠️ `dmodel` 的**实测**只到 852,951（985,000 越界），但它是档位表成员
   * `1M`，故仍填 1M —— **不要因为"实测没到 1M"就改小**：1M × 0.8 = 800K 的
   * 压缩阈值低于 852,951 这个已证安全点。实测记录见
   * `src/qoder-product.ts` 表头注释与 AGENTS.md 2.1 节。
   */
  it('档位表有 1M 档就填 1M；只有 200K 档的 mmodel 例外', () => {
    const byId = new Map(QODER_CN.fallbackModels.map((m) => [m.id, m]))
    // 已实测逼近 1M 的两条（qfmodel 计入 983,490 / dfmodel 计入 999,991）。
    expect(byId.get('qfmodel')?.contextWindow).toBe(1_000_000)
    expect(byId.get('dfmodel')?.contextWindow).toBe(1_000_000)
    // ⚠️ 真实缺陷（用户报障）：`dmodel` 的 `max_input_tokens` 是 **96000**，
    // 旧表照抄 → DSH 在 76.8K 就压缩。档位表有 1M 档 → 填 1M。
    expect(byId.get('dmodel')?.contextWindow).toBe(1_000_000)
    // 其余档位表含 1M 档者。
    expect(byId.get('qmodel_latest')?.contextWindow).toBe(1_000_000)
    expect(byId.get('qmodel')?.contextWindow).toBe(1_000_000)
    expect(byId.get('kmodel')?.contextWindow).toBe(1_000_000)
    expect(byId.get('gfmodel')?.contextWindow).toBe(1_000_000)
    // ⚠️ 唯一例外：`mmodel` 的档位表只有 200K 一档，不要跟着改成 1M。
    expect(byId.get('mmodel')?.contextWindow).toBe(200_000)
  })

  it('思考档位标记按 CN catalog，与国际版相反的几条要照 CN', () => {
    const byId = new Map(QODER_CN.fallbackModels.map((m) => [m.id, m]))
    // CN 里这几条 is_reasoning 为 true（国际版表记的是 false）
    expect(byId.get('auto')?.supportsThinking).toBe(true)
    expect(byId.get('qmodel_latest')?.supportsThinking).toBe(true)
    expect(byId.get('kmodel')?.supportsThinking).toBe(true)
    // 而 dfmodel 在 CN 是 false（国际版为 true）
    expect(byId.get('dfmodel')?.supportsThinking).toBeFalsy()
    expect(byId.get('kmodel_latest')?.supportsThinking).toBeFalsy()
    // mmodel 在 CN 连图片都不支持（国际版 is_vl 为 true）
    expect(byId.get('mmodel')?.supportsImage).toBeFalsy()
  })

  it('CN 表不含国际版独有的那 5 个模型', () => {
    const ids = QODER_CN.fallbackModels.map((m) => m.id)
    for (const intlOnly of ['ultimate', 'performance', 'efficient', 'smodel', 'cmodel']) {
      expect(ids, `CN 目录里没有 ${intlOnly}`).not.toContain(intlOnly)
    }
  })

  it('两站重叠模型的倍率一致（除 auto 外实测逐条相同）', () => {
    const intl = new Map(QODER.fallbackModels.map((m) => [m.id, m.priceFactor]))
    for (const m of QODER_CN.fallbackModels) {
      if (!intl.has(m.id) || m.id === 'auto') continue
      expect(m.priceFactor, `${m.id} 倍率与国际版不符`).toBe(intl.get(m.id))
    }
  })
})
