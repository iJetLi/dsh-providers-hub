/**
 * Raccoon **只读**探针。
 *
 * 验证单测无法证明的远端事实：
 * 1. 凭据（JWT）对生产端点的有效性；
 * 2. 模型目录：`visible:true` 的条目与**基线快照**逐条同序（漂移即红，并点名差集），
 *    且**倍率来自 `billing_effective_multiplier`**（不是猜的）
 *    —— 兜底表是离线真相源，本用例同时锁住「表 == 远端」这条不变量；
 * 3. 积分余额与账单（**只读**）；
 * 4. 「Raccoon-Auto」**不在**远端目录里（它是客户端 UI 合成条目）。
 *
 * 闸门：`DSH_RACCOON_E2E=1`（用 `pnpm test:e2e:raccoon` 运行）。
 *
 * ⚠️ 本用例**不发任何模型请求**（零积分消耗）、
 * **不领取任何奖励**（`login/points/grant` 是写端点）—— 全部是 GET。
 */

import { describe, expect, it } from 'vitest'
import { RACCOON } from '../../src/raccoon-product.js'
import {
  claimRaccoonLoginReward,
  fetchRaccoonCreditBalance,
  fetchRaccoonOnboardingStatus,
} from '../../src/raccoon-credits.js'
import { parseRaccoonModelCatalog } from '../../src/raccoon-auth.js'
import { raccoonHeaders } from '../../src/raccoon.js'
import { readRaccoonCredentialsFromDshStore } from './raccoon-credential.js'

const RUN = process.env.DSH_RACCOON_E2E === '1'
const suite = RUN ? describe : describe.skip

/**
 * 上游可见目录的**基线快照**（2026-11-17 实测：10 个 chat 条目 / 7 个 visible）。
 *
 * ⚠️ 这份快照是**判据**，不是描述。上游加模型、换版本号（如
 * `sn-deepseek-v4-1-flash` → `sn-deepseek-v4-1-flash-1017`）、下架模型时，
 * 本文件必须变红 —— 红了的正确动作是「核对远端 → 同步这里
 * **和** `RACCOON_FALLBACK_MODELS`」，而**不是**把它放宽成 `toBeGreaterThan`
 * 或 `>= 兜底表条数`：那会让漂移重新变成静默（2026-11-17 它已经静默过一次，
 * 断言当时还写着 6 条、实际 7 条）。
 *
 * 顺序与远端一致（兜底表也照抄这个顺序，见 `raccoon-product.ts` 的注释）。
 */
const EXPECTED_VISIBLE_IDS = [
  'sn-sensenova-6-8-flash',
  'sn-sensenova-6-8-flash-lite',
  'sn-qwen4-max',
  'sn-glm-5-3',
  'sn-kimi-k3-1-pro',
  'sn-glm-5-3-flash',
  'sn-deepseek-v4-1-flash-1017',
] as const

suite('Raccoon 只读探针（不发模型请求、不领取奖励）', () => {
  const entries = readRaccoonCredentialsFromDshStore()

  it('至少有一个已登录的 Raccoon 账号', () => {
    expect(
      entries.length,
      '未找到 Raccoon 凭据。请先在 Jet Hub 的 Raccoon 面板用微信扫码或短信登录一个账号，'
      + '或设置 DSH_RACCOON_CREDENTIAL_JSON。',
    ).toBeGreaterThan(0)
  })

  it('模型目录与基线快照逐条一致（漂移即红、并点名差集）', async () => {
    const first = entries[0]
    expect(first).toBeDefined()
    if (first === undefined) return

    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/model_catalog`,
      { headers: raccoonHeaders(first.credential), signal: AbortSignal.timeout(30_000) },
    )
    expect(response.status, `HTTP ${response.status}`).toBe(200)

    const payload = await response.json() as {
      data?: { categories?: Array<{ type?: string; models?: Array<Record<string, unknown>> }> }
    }
    const models = parseRaccoonModelCatalog(payload)
    const ids = models.map((m) => m.id)
    // 双差集：`missing` = 基线里上游已下架 / 换了 id，`extra` = 上游新上架。
    // ⚠️ 用差集而不是「数量相等」，是为了让失败信息**点名**是哪个模型漂了
    //（只报 `expected 7 to be 6` 的话，得自己再跑一遍才知道差在哪）。
    const missing = EXPECTED_VISIBLE_IDS.filter((id) => !ids.includes(id))
    const extra = ids.filter((id) => !(EXPECTED_VISIBLE_IDS as readonly string[]).includes(id))
    expect(
      { missing, extra },
      '上游目录已漂移：请核对远端 `model_catalog`，同步本文件的 EXPECTED_VISIBLE_IDS'
      + ' 与 src/raccoon-product.ts 的 RACCOON_FALLBACK_MODELS（含顺序）。',
    ).toEqual({ missing: [], extra: [] })

    // 兜底表就是离线时的真相源 ⇒ 它必须与远端**逐字同序**（顺序也是判据：
    // 表里的顺序是「照抄远端」，重排会让排查失去可比性）。
    expect(
      RACCOON.fallbackModels.map((m) => m.id),
      '兜底表已与远端漂移：请同步 RACCOON_FALLBACK_MODELS',
    ).toEqual([...EXPECTED_VISIBLE_IDS])

    // ⚠️ 三条**静默失效**的守卫（都不是「数量对不对」，而是「取值域对不对」）：
    const raw = payload.data?.categories?.find((c) => c.type === 'chat')?.models ?? []
    const visibleRaw = raw.filter((m) => m['visible'] !== false)
    for (const m of visibleRaw) {
      // ① 请求 id 取自 `name`（`normalizeRemoteModel`）。上游若哪天把 `model_name`
      //    （真模型名）与 `name` 分叉，我们会用错的 id 发请求 ⇒ 全 404 且只在会话期暴露。
      //    今天 10/10 两条字段逐字相同，故这里断言「不许分叉」。
      expect(m['name'], '上游 name 与 model_name 分叉了，请求 id 来源要改用 model_name')
        .toBe(m['model_name'])
      // ② 倍率必须是 **number**：`normalizeRemoteModel` 对非 number 一律 NaN ⇒
      //    展示名会**静默丢掉** `· x…` 后缀（用户看到「没有计费信息」），故这里守类型。
      expect(typeof m['billing_effective_multiplier'], `${String(m['name'])} 的倍率不是 number`)
        .toBe('number')
    }
    // ③ 上游若发了重复 id，`parseRaccoonModelCatalog` 不去重 ⇒ 选择器出现两行同一模型，
    //    而差集判据对此**完全无感**（`missing`/`extra` 都是空）。
    expect(new Set(ids).size, '上游目录出现重复 id').toBe(ids.length)

    // 倍率必须真的来自 billing_effective_multiplier（逐条对照实测值）
    const byId = new Map(models.map((m) => [m.id, m]))
    // 稳定条目：价格没活动，逐字锁死
    expect(byId.get('sn-glm-5-3')?.name).toBe('GLM-5-3 · x0.75')
    // ⚠️ 1 倍也要显示（用户报障「为什么 Kimi-K3 没有倍率，ide 是 1 倍」）
    expect(byId.get('sn-kimi-k3-1-pro')?.name).toBe('Kimi-K3.1-Pro · x1')
    // ⚠️ 限免是**活动**（`billing_status_note` = 「限免到 11月30日」）⇒ 到期后
    // 远端会变成有价，故这里允许两种形态（`免费` / `x0.5`）；基线倍率写错照样红。
    expect(byId.get('sn-sensenova-6-8-flash')?.name)
      .toMatch(/^SenseNova-6\.8-Flash · (免费|x0\.5(→x0?\.\d+)?)$/)
    // ⚠️ 带**限时活动**的条目不逐字锁死折后价：活动结束（或换档）后
    // `billing_effective_multiplier` 会变，届时 `x0.75→x0.5` 变成 `x0.75` ——
    // 那是上游的正常变化，不是本插件的回归。判据是「基线倍率必须正确，
    // 折后价只能以 `→` 追加」，这样活动期间与活动结束两种形态都吃得下。
    expect(byId.get('sn-qwen4-max')?.name).toMatch(/^Qwen4-Max · x0\.75(→x[0-9.]+)?$/)
    expect(byId.get('sn-deepseek-v4-1-flash-1017')?.name)
      .toMatch(/^DeepSeek-V4\.1-Flash-1017 · x0\.25(→x[0-9.]+)?$/)
    // `sn-glm-5-3-flash` 那条 `x0.2→x0.1` 的活动已于 2026-11-17 前结束（远端回 0.2/0.2），
    // 但活动可能再来 ⇒ 同样是「基线 + 可选箭头」形态。
    expect(byId.get('sn-glm-5-3-flash')?.name).toMatch(/^GLM-5-3-Flash · x0\.2(→x[0-9.]+)?$/)
  })

  it('⚠️ Raccoon-Auto 不在远端目录里（它是客户端 UI 合成条目）', async () => {
    const first = entries[0]
    if (first === undefined) return
    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/model_catalog`,
      { headers: raccoonHeaders(first.credential), signal: AbortSignal.timeout(30_000) },
    )
    const models = parseRaccoonModelCatalog(await response.json())
    expect(models.some((m) => m.id.includes('raccoon-auto'))).toBe(false)
    expect(models.some((m) => m.name.includes('Raccoon-Auto'))).toBe(false)
    // 也不含 3 个 visible:false 的 raccoon-* 内部模型
    expect(models.some((m) => m.id.startsWith('raccoon-'))).toBe(false)
  })

  it('远端目录含 3 个 visible:false 的内部模型（证明过滤真的生效）', async () => {
    const first = entries[0]
    if (first === undefined) return
    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/model_catalog`,
      { headers: raccoonHeaders(first.credential), signal: AbortSignal.timeout(30_000) },
    )
    const payload = await response.json() as {
      data?: { categories?: Array<{ type?: string; models?: Array<{ name?: string; visible?: boolean }> }> }
    }
    const chat = payload.data?.categories?.find((c) => c.type === 'chat')
    const hidden = (chat?.models ?? []).filter((m) => m.visible === false)
    expect(hidden.length, 'visible:false 的模型数（应为 3 个 raccoon-* 内部模型）').toBe(3)
  })

  it('积分余额可查（只读）', async () => {
    const first = entries[0]
    if (first === undefined) return
    const balance = await fetchRaccoonCreditBalance(RACCOON, first.credential)
    expect(balance, '余额查询失败（凭据可能已失效）').not.toBeNull()
    expect(typeof balance?.total).toBe('number')
    expect(balance?.total).toBeGreaterThanOrEqual(0)
    // 各池分开作 package（reward / daily / topup）
    expect((balance?.packages.length ?? 0)).toBeGreaterThan(0)
  })

  it('登录奖励状态可查（只读，不发写请求）', async () => {
    const first = entries[0]
    if (first === undefined) return
    const status = await fetchRaccoonOnboardingStatus(RACCOON, first.credential)
    expect(typeof status.claimed).toBe('boolean')
    expect(status.points).toBeGreaterThan(0)
  })

  /**
   * ⚠️ **不发**写请求的证明：只检查函数存在与签名，不调用它。
   *
   * 本探针刻意不调 `claimRaccoonLoginReward` —— 那是 POST（写端点）。
   * 领取的真实性由 E2E 闸门外的 `raccoon-claim-probe` 覆盖（若将来需要）。
   */
  it('领取函数存在（但本探针不调用它 —— 那是写端点）', () => {
    expect(typeof claimRaccoonLoginReward).toBe('function')
  })
})
