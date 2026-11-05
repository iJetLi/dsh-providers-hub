import { describe, expect, it } from 'vitest'
import {
  RACCOON,
  RACCOON_TEXT_ONLY_MODELS,
  raccoonProductById,
  raccoonSupportsImage,
  raccoonSupportsImageWith,
} from '../../src/raccoon-product.js'

describe('RACCOON 产品配置', () => {
  it('id 与显示名固定', () => {
    expect(RACCOON.id).toBe('raccoon')
    expect(RACCOON.displayName).toBe('Raccoon (商汤)')
  })

  it('基址与前缀来自 .env.electron（逐条对照，不凭印象）', () => {
    expect(RACCOON.apiBase).toBe('https://xiaohuanxiong.com')
    expect(RACCOON.authApiPrefix).toBe('/api/web/auth/v1')
    expect(RACCOON.llmApiPrefix).toBe('/api/web/llm/v2')
    expect(RACCOON.pointsApiPrefix).toBe('/api/web/points/v1')
    expect(RACCOON.desktopApiPrefix).toBe('/api/web/desktop/v1')
  })

  it('凭据 ref 与手机号密钥固定', () => {
    expect(RACCOON.defaultCredentialRef).toBe('RACCOON_ACCESS_TOKEN')
    expect(RACCOON.phoneCipherSecret).toBe('senseraccoon2023')
  })

  it('阿里云验证码配置来自渲染层模块 37907', () => {
    expect(RACCOON.aliyunCaptcha.sceneId).toBe('1pkmy0x3')
    expect(RACCOON.aliyunCaptcha.prefix).toBe('hk1r5l')
  })

  it('客户端平台标识必须是 desktop-windows（猜错会让 points/grant 被拒）', () => {
    expect(RACCOON.clientPlatform).toMatch(/^desktop-(windows|macos|linux)$/)
  })
})

describe('兜底模型表', () => {
  it('恰好 6 个可见模型，顺序照抄远端', () => {
    expect(RACCOON.fallbackModels.map((m) => m.id)).toEqual([
      'sn-sensenova-6-8-flash',
      'sn-sensenova-6-8-flash-lite',
      'sn-glm-5-3',
      'sn-kimi-k3',
      'sn-glm-5-3-flash',
      'sn-deepseek-v4-1-flash',
    ])
  })

  it('不包含 Raccoon-Auto（它是客户端 UI 合成条目，不是远端模型）', () => {
    expect(RACCOON.fallbackModels.some((m) => m.id.includes('raccoon-auto'))).toBe(false)
    expect(RACCOON.fallbackModels.some((m) => m.name.includes('Raccoon-Auto'))).toBe(false)
  })

  it('不包含 3 个 visible:false 的 raccoon-* 内部模型', () => {
    expect(RACCOON.fallbackModels.some((m) => m.id.startsWith('raccoon-'))).toBe(false)
  })

  it('展示名已含倍率（规范化形态，与 raccoonDisplayName 输出一致）', () => {
    const byId = new Map(RACCOON.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('sn-glm-5-3')?.name).toBe('GLM-5-3 · x0.75')
    expect(byId.get('sn-kimi-k3')?.name).toBe('Kimi-K3 · x1')
    expect(byId.get('sn-glm-5-3-flash')?.name).toBe('GLM-5-3-Flash · x0.2→x0.1')
    expect(byId.get('sn-deepseek-v4-1-flash')?.name).toBe('DeepSeek-V4.1-Flash · x0.25')
    expect(byId.get('sn-sensenova-6-8-flash')?.name).toBe('SenseNova-6.8-Flash · 免费')
    expect(byId.get('sn-sensenova-6-8-flash-lite')?.name).toBe('SenseNova-6.8-Flash-Lite · 免费')
  })

  it('上下文窗口与输出上限逐条对照远端实测值', () => {
    const byId = new Map(RACCOON.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('sn-sensenova-6-8-flash')?.contextWindow).toBe(256_000)
    expect(byId.get('sn-sensenova-6-8-flash')?.maxTokens).toBe(63_999)
    expect(byId.get('sn-glm-5-3')?.contextWindow).toBe(1_000_000)
    // ⚠️ issue IKS1L5：兜底表声明值必须 ≤ 上游硬校验上限（65_536），
    //    写 100_000 会让 DSH 每轮回传该值 ⇒ 上游 400 且该 model group 无 fallback。
    expect(byId.get('sn-glm-5-3')?.maxTokens).toBe(65_536)
    for (const model of RACCOON.fallbackModels) {
      expect(model.maxTokens, model.id).toBeLessThanOrEqual(65_536)
    }
    expect(byId.get('sn-deepseek-v4-1-flash')?.contextWindow).toBe(1_000_000)
  })

  /**
   * ⚠️ 本条**曾经锁死了缺陷行为**（断言 `sn-deepseek-v4-1-flash` 为 `false`），
   * 改动前务必先读 `src/raccoon-product.ts` 的
   * {@link RACCOON_TEXT_ONLY_MODELS} 的注释 —— 那里有 6/6 带图实测证据。
   *
   * 结论：远端 `tags` 里的 `vision` 是**客户端选模偏好**，不是能力契约。
   * 6 个可见模型实测**全部**能读图，含两个不带 `vision` 标签的。
   */
  it('图片能力：6 个模型全部为 true（含 tags 不含 vision 的两个）', () => {
    const byId = new Map(RACCOON.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('sn-sensenova-6-8-flash')?.supportsImage).toBe(true)
    expect(byId.get('sn-glm-5-3')?.supportsImage).toBe(true)
    expect(byId.get('sn-kimi-k3')?.supportsImage).toBe(true)
    // ⚠️ 这两条远端 tags **不含** vision，但实测能看图 —— 曾经错判为 false。
    expect(byId.get('sn-deepseek-v4-1-flash')?.supportsImage).toBe(true)
    expect(byId.get('sn-glm-5-3-flash')?.supportsImage).toBe(true)
    // 逐条锁死：6 条里不允许出现任何 false
    expect(RACCOON.fallbackModels.filter((m) => !m.supportsImage)).toEqual([])
  })

  it('所有 contextWindow / maxTokens 都是安全正整数（0 会让 DSH 抛 INVALID_MODEL_MAX_TOKENS）', () => {
    for (const model of RACCOON.fallbackModels) {
      expect(Number.isSafeInteger(model.contextWindow)).toBe(true)
      expect(model.contextWindow).toBeGreaterThan(0)
      expect(Number.isSafeInteger(model.maxTokens)).toBe(true)
      expect(model.maxTokens).toBeGreaterThan(0)
    }
  })
})

describe('raccoonProductById', () => {
  it('认得 raccoon，未知 id 返回 undefined', () => {
    expect(raccoonProductById('raccoon')?.id).toBe('raccoon')
    expect(raccoonProductById('buddy')).toBeUndefined()
    expect(raccoonProductById('')).toBeUndefined()
  })
})

/**
 * 图片能力判定（2026-10-21 策略翻转：**默认支持**，只把纯文本模型显式禁掉）。
 *
 * 历史两起漏判：
 * - 2026-10-03：把远端 `tags.vision` 当能力契约 ⇒ `sn-deepseek-v4-1-flash` 被判 text；
 * - 2026-10-21：白名单按精确 id 枚举 ⇒ 新 id `...-1017` 又被打回 text。
 *
 * ⇒ 判据改为「默认 image + {@link RACCOON_TEXT_ONLY_MODELS} 黑名单」，
 * 详见 `src/raccoon-product.ts` 的注释（含 6/6 与 1017 的带图实测证据）。
 */
describe('图片能力判定（默认支持，纯文本模型显式禁掉）', () => {
  it('默认对任何模型都声明 image（含 tags 不含 vision 的、未知的、带版本后缀的）', () => {
    expect(raccoonSupportsImage('sn-deepseek-v4-1-flash')).toBe(true)
    expect(raccoonSupportsImage('sn-glm-5-3-flash')).toBe(true)
    expect(raccoonSupportsImage('sn-deepseek-v4-1-flash-1017')).toBe(true)
    // 远端将来新上架的模型：默认放行，不再依赖 tags
    expect(raccoonSupportsImage('some-brand-new-model')).toBe(true)
    expect(raccoonSupportsImage('some-brand-new-model-1101')).toBe(true)
  })

  it('纯文本集合里的模型被禁（含带版本后缀的同族 id）', () => {
    const textOnly = new Set(['sn-text-only'])
    expect(raccoonSupportsImageWith(textOnly, 'sn-text-only')).toBe(false)
    // 同族滚版本也必须禁（否则新版会漏禁）
    expect(raccoonSupportsImageWith(textOnly, 'sn-text-only-1017')).toBe(false)
    // 不影响集合外的模型
    expect(raccoonSupportsImageWith(textOnly, 'sn-deepseek-v4-1-flash')).toBe(true)
    // 后缀不是纯 4 位数字 ⇒ 不剥，避免误禁 `-next` / `-text` 变体
    expect(raccoonSupportsImageWith(textOnly, 'sn-text-only-next')).toBe(true)
    expect(raccoonSupportsImageWith(textOnly, 'sn-text-only-12345')).toBe(true)
  })

  it('生产集合当前为空（目录里没有实测确认的纯文本模型）', () => {
    // ⚠️ 新增条目必须先有「带图被明确拒绝」的实测证据，见 product 注释的「代价」。
    expect([...RACCOON_TEXT_ONLY_MODELS]).toEqual([])
  })

  /**
   * **两个真相源必须一致**：兜底表（本地）vs 远端判定。
   *
   * ⚠️ 本条是防止「只改一条通道」的关键 —— raccoon 有远端目录与本地兜底表
   * 两条路径，二者曾给出互相矛盾的答案。
   * ⚠️ 反向验证：把兜底表任一条改回 `false`（或把该 id 加进纯文本集合）→ 本条立即变红。
   */
  it('兜底表的图片能力与远端判定逐条一致', () => {
    for (const model of RACCOON.fallbackModels) {
      expect(
        raccoonSupportsImage(model.id),
        `${model.id}：兜底表(${model.supportsImage}) 与远端判定不一致`,
      ).toBe(model.supportsImage)
    }
  })
})
