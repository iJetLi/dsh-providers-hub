import { describe, expect, it } from 'vitest'
import {
  ALL_LOOMY_PRODUCTS, LOOMY, LOOMY_CONTEXT_WINDOW_OVERRIDES, LOOMY_IMAGE_CAPABILITY_OVERRIDES,
  loomyCatalogKey, loomyContextWindow, loomyProductById, loomySupportsImage,
} from '../../src/loomy-product.js'

describe('Loomy 产品配置', () => {
  it('provider id 与展示名', () => {
    expect(LOOMY.id).toBe('loomy')
    expect(LOOMY.displayName).toBe('Loomy (讯飞)')
  })

  /**
   * ⚠️ 生产域名是 `loomyad.xunfei.cn`，**不是** `ossptest.voicecloud.cn`。
   * 后者只是 `points-config.js:16` 的代码兜底默认值（本机 points-config.json
   * 里存的正是这个误导值），实际被 `.env.prod` 覆盖。
   * 依据：`share/share-env.js:4-25` 把生产与集成两者并列写明。
   */
  it('base URL 用生产域名（不是 ossptest 测试域名）', () => {
    expect(LOOMY.apiBase).toBe('https://loomyad.xunfei.cn/api/v1')
    expect(LOOMY.accountBase).toBe('https://account.xfinfr.com')
    expect(LOOMY.apiBase).not.toContain('ossptest')
  })

  it('内置讯飞账号 AccessKey 与 appId 非空', () => {
    expect(LOOMY.accessKeyId.length).toBeGreaterThan(0)
    expect(LOOMY.accessKeySecret.length).toBeGreaterThan(0)
    expect(LOOMY.appId).toBe('GM3LOOMY')
  })

  it('默认凭据 ref 与其它 provider 隔离', () => {
    expect(LOOMY.defaultCredentialRef).toBe('LOOMY_ACCESS_TOKEN')
  })

  it('兜底模型表覆盖 9 个 chat 模型、id 唯一', () => {
    const ids = LOOMY.fallbackModels.map((m) => m.id)
    // ⚠️ 2026-11-06 由 8 → 9：远端新上架 `DeepSeek-V4.1-Flash`，兜底表必须跟上
    //（否则远端抓取失败时它落「目录外」分支 ⇒ 档位/窗口双双缺失 ⇒ 整轮失败）。
    expect(ids).toHaveLength(9)
    expect(new Set(ids).size).toBe(9)
    // 与实测远端 chat 集合逐一对齐（含 2026-09-26 那批 + 2026-11-06 新增）
    expect([...ids].sort()).toEqual([
      'DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'Kimi-k2.6', 'MiniMax-M3',
      'deepseek-v4-flash-0731', 'mimo-v2.5', 'qwen-3.8-max', 'qwen3.8-flash', 'spark-x',
    ].sort())
  })

  it('兜底模型名已含规范化倍率（用 · 分隔）', () => {
    const byId = new Map(LOOMY.fallbackModels.map((m) => [m.id, m.name]))
    expect(byId.get('MiniMax-M3')).toBe('MiniMax M3 · x4.0')
    expect(byId.get('qwen-3.8-max')).toBe('Qwen 3.8 Max · x12.0')
    expect(byId.get('spark-x')).toBe('Spark X2.5 · x0.1')
  })

  it('loomyProductById 能查到，未知 id 返回 undefined', () => {
    expect(loomyProductById('loomy')).toBe(LOOMY)
    expect(loomyProductById('nope')).toBeUndefined()
  })

  it('ALL_LOOMY_PRODUCTS 含且仅含 LOOMY', () => {
    expect(ALL_LOOMY_PRODUCTS).toEqual([LOOMY])
  })

  /**
   * ★ 上下文窗口覆盖表（Gitee issue IKJW31）。
   *
   * 远端对 `spark-x` 虚报 1048576，真实墙 262144 ⇒ 长会话被截断。
   * 这一组锁死三条：覆盖生效、判据不被调用方的值左右、未验证条目不进表。
   */
  it('★ 覆盖表把 spark-x 钉在真实的 262144（远端声明的是 1048576）', () => {
    expect(LOOMY_CONTEXT_WINDOW_OVERRIDES['spark-x']).toBe(262_144)
    expect(loomyContextWindow('spark-x', 1_048_576)).toBe(262_144)
  })

  it('覆盖表只含**有证据**的条目，且值都是安全正整数', () => {
    // ⚠️ 别为了「看起来统一」把整表填进来：每条都必须有独立证据
    //（上游墙位 / 官方客户端本地表），否则就是拿猜测覆盖远端事实。
    expect(Object.keys(LOOMY_CONTEXT_WINDOW_OVERRIDES)).toEqual(['spark-x'])
    for (const [id, value] of Object.entries(LOOMY_CONTEXT_WINDOW_OVERRIDES)) {
      expect(Number.isSafeInteger(value), id).toBe(true)
      expect(value, id).toBeGreaterThan(0)
    }
  })

  it('⚠️ 兜底表的值与覆盖表一致（两条路径不得分叉）', () => {
    for (const model of LOOMY.fallbackModels) {
      const override = LOOMY_CONTEXT_WINDOW_OVERRIDES[model.id]
      if (override === undefined) continue
      expect(model.contextWindow, `${model.id} 兜底表未按覆盖表修正`).toBe(override)
    }
  })

  /**
   * ★ 图片能力覆盖表（2026-10-14 用户报障「loomy 的 qwen3.8max 输入不能上图」）。
   *
   * 远端 `GET /api/v1/models` 对 `qwen-3.8-max` 下发
   * `capabilities.input_modalities: ['text']`（`vision: false`，**漏报**），而实测
   * 4/5 次正确读出随机纯色 PNG（64×64）的颜色 / RGB 三元组 ⇒ 照抄声明值会让 DSH
   * 在附件入库阶段就拒图（`MODEL_DOES_NOT_SUPPORT_IMAGES`），用户看到的是
   * 「当前模型不支持图片，请切换支持图片的模型」。
   * 判据、原始回答与同批 10 个模型的对照表见 `src/loomy-product.ts` 覆盖表注释。
   *
   * 这一组锁死三条：覆盖生效、覆盖表**不恒真**（未登记模型照传声明值）、表内
   * 只放有实测证据的条目。
   */
  it('★ 覆盖表让 qwen-3.8-max 在远端漏报（声明 text）时仍判定支持图片', () => {
    // 2026-11-06 审计补登 4 条（同批实测读图 ✅ 的 DeepSeek-V4.1-Flash / Kimi-k2.6 /
    // qwen3.8-flash / mimo-v2.5）：远端可用时无影响，但远端失败走兜底表时起算值
    // 恒 false ⇒ 同一批模型离线不能读图，能力随远端可用性漂移。
    expect(Array.from(LOOMY_IMAGE_CAPABILITY_OVERRIDES)).toEqual([
      'qwen-3.8-max',
      'deepseek-v4.1-flash',
      'kimi-k2.6',
      'qwen3.8-flash',
      'mimo-v2.5',
    ])
    expect(loomySupportsImage('qwen-3.8-max', false)).toBe(true)
    // 声明为 image 时当然还是 true（覆盖表只做「补报」，不做「降级」）
    expect(loomySupportsImage('qwen-3.8-max', true)).toBe(true)
  })

  it('⚠️ 覆盖表不得退化成「该家恒支持图片」：未登记模型照传声明值', () => {
    // 两个方向都要传对：声明 text 的仍是 text，声明 image 的仍是 image。
    // 恒 true 会把图放给纯文本模型，让上游回一个更晚、更难懂的 400。
    expect(loomySupportsImage('spark-x', false)).toBe(false)
    // Kimi-k2.6 已入表（2026-11-06 补登，实测 ✅）⇒ 离线也能读图
    expect(loomySupportsImage('Kimi-k2.6', false)).toBe(true)
    expect(loomySupportsImage('Kimi-k2.6', true)).toBe(true)
    expect(loomySupportsImage('qwen3.8-flash', true)).toBe(true)
    // ⚠️ 仍未登记的 GLM-5.3-Flash（实测 ⚠️ 答错过颜色名）照传声明值
    expect(loomySupportsImage('GLM-5.3-Flash', false)).toBe(false)
    expect(loomySupportsImage('GLM-5.3-Flash', true)).toBe(true)
  })

  it('⚠️ 覆盖表只放**实测确认能读图**的模型，且必须存在于兜底表', () => {
    // ⚠️ 用**同一个归一化**（loomyCatalogKey）对齐两侧：兜底表 id 保留上游
    // 大小写（如 DeepSeek-V4.1-Flash），覆盖表条目必须小写 —— 直接 Set.has
    // 会在大小写混用的 id 上恒 false（2026-11-06 补登 4 条时实测抓到）。
    const ids = new Set(LOOMY.fallbackModels.map((m) => loomyCatalogKey(m.id)))
    for (const id of Array.from(LOOMY_IMAGE_CAPABILITY_OVERRIDES)) {
      expect(ids.has(id), `${id} 不在兜底表里`).toBe(true)
    }
    // 实测确认读不了图的（spark-x / deepseek-v4-flash-0731）绝不混进表里
    expect(LOOMY_IMAGE_CAPABILITY_OVERRIDES.has('spark-x')).toBe(false)
    expect(LOOMY_IMAGE_CAPABILITY_OVERRIDES.has('deepseek-v4-flash-0731')).toBe(false)
    // 实测疑似「声明 image 但读不出」的 MiniMax-M3 本次刻意不降级（见源码注释）
    expect(LOOMY_IMAGE_CAPABILITY_OVERRIDES.has('MiniMax-M3')).toBe(false)
    // 实测 ⚠️（答错过颜色名）的 GLM-5.3-Flash 也不入表（证据不足不判死也不补报）
    expect(LOOMY_IMAGE_CAPABILITY_OVERRIDES.has('glm-5.3-flash')).toBe(false)
  })

  /**
   * ★ 覆盖表查表口径（2026-10-14 审计发现：静默失效面）。
   *
   * 修复前覆盖表用**逐字节精确匹配**，而同一文件读远端模态的
   * `readInputModalities()` 却 `.toLowerCase()` 归一 ⇒ 上游一旦把 id 改成
   * `Qwen-3.8-Max` 或前后带空白，覆盖表恒不命中、图被准入闸门重新拒掉，
   * 而**零报错、测试全绿**（正是本次修复前的用户症状原样复现）。
   *
   * ⚠️ 这两条**必须**存在：现有其它用例构造的 id 全小写，
   * 结构上抓不到这个面（反向验证：去掉 `loomyCatalogKey` ⇒ 立刻变红）。
   */
  it('★ 图片能力查表对大小写不敏感（上游改大小写不得静默失效）', () => {
    expect(loomySupportsImage('Qwen-3.8-Max', false)).toBe(true)
    expect(loomySupportsImage('QWEN-3.8-MAX', false)).toBe(true)
  })

  it('★ 图片能力查表忽略首尾空白', () => {
    expect(loomySupportsImage(' qwen-3.8-max ', false)).toBe(true)
    expect(loomySupportsImage('\tqwen-3.8-max\n', false)).toBe(true)
  })

  it('⚠️ 归一化不得把未登记模型误放行（大小写变体也不行）', () => {
    // 只有表内条目享受「补报」；大小写变体不能变成通配
    expect(loomySupportsImage('SPARK-X', false)).toBe(false)
    expect(loomySupportsImage('Spark-X', false)).toBe(false)
    expect(loomySupportsImage('SPARK-X', true)).toBe(true)
  })

  /**
   * ★ 上下文窗口覆盖表**同一口径**（2026-10-14 审计发现）。
   *
   * 源码注释自称两张表「同一条纪律」，但修复前 `loomyContextWindow` 同样是
   * 精确匹配 ⇒ 口径不一致会让那句话变成假的。这里逐格锁死两者一致。
   */
  it('★ 上下文窗口查表与图片能力同口径（大小写/空白不敏感）', () => {
    expect(loomyContextWindow('Spark-X', 1_048_576)).toBe(262_144)
    expect(loomyContextWindow(' spark-x ', 1_048_576)).toBe(262_144)
    // 未登记条目照传声明值，归一化不是通配
    expect(loomyContextWindow('SOME-OTHER', 4096)).toBe(4096)
  })

  it('⚠️ 两张覆盖表的键都必须已归一（否则恒不命中，且无人报错）', () => {
    // 这是「表内条目必须小写」的机器守卫：加新条目时忘了小写会在这里红。
    for (const key of Object.keys(LOOMY_CONTEXT_WINDOW_OVERRIDES)) {
      expect(key, `上下文窗口覆盖表键 "${key}" 未归一为小写`).toBe(key.trim().toLowerCase())
    }
    for (const key of Array.from(LOOMY_IMAGE_CAPABILITY_OVERRIDES)) {
      expect(key, `图片能力覆盖表条目 "${key}" 未归一为小写`).toBe(key.trim().toLowerCase())
    }
  })
})
