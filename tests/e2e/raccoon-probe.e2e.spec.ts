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

/**
 * 兜底表里**刻意保留、但不在远端目录里**的旧 id 别名（2026-11-17 起）。
 *
 * 上游把 `sn-deepseek-v4-1-flash` 换成了同族版本 `-1017`，旧 id 已不在远端目录。
 * 但旧会话里存的是旧 id，删掉它 = 升级后 `resolveModel` 拿不到能力声明 ⇒
 * 静默退化成纯文本（丢图）。所以兜底表刻意让它与新 id **并存**。
 *
 * ⚠️ 这里**只允许**出现「确实是旧版同名 id」的别名，不许把别的模型塞进来 ——
 * 它是差分判据的豁免名单，膨胀就等于把漂移判据关掉。
 */
const LEGACY_ALIAS_IDS = ['sn-deepseek-v4-1-flash'] as const

suite('Raccoon 只读探针（不发模型请求、不领取奖励）', () => {
  const entries = readRaccoonCredentialsFromDshStore()

  /**
   * 挑一个**真能用**的账号：逐个只读 GET `/model_catalog`，取第一个 200 的。
   *
   * ⚠️ 为什么不能写死 `entries[0]`（2026-11-17 实测到的真实误判）：本机两条
   * `RACCOON_ACCOUNT_*` 中 `entries[0]` 的 access_token 已过期 ⇒ 目录端点回
   * **401 / `code: 200003`** ⇒ 解析层对非 0 业务码返回 `[]` ⇒ 双差集报
   * `missing` = **全部 7 条**、`hidden` = **0**、余额 = `null`。
   * 三条红讯息都在说「目录漂了 / 过滤失效 / 余额查不到」，而真因只有一条：
   * **这个账号的凭据失效了**。两种故障**逐字同形**，排查时会先怀疑上游。
   *
   * 所以这里把「凭据失效」与「目录漂移」拆开：能用的账号挑不到时，
   * 直接报一句点名的话（而不是让后面 6 条各报一个假原因）。
   */
  async function pickUsableEntry(): Promise<RaccoonCredentialEntry | undefined> {
    const rejected: string[] = []
    for (const entry of entries) {
      const response = await fetch(
        `${RACCOON.apiBase}${RACCOON.llmApiPrefix}/model_catalog`,
        { headers: raccoonHeaders(entry.credential), signal: AbortSignal.timeout(30_000) },
      )
      if (response.status === 200) {
        const payload = await response.json() as { code?: unknown }
        // 业务码为 0（或缺失，按既有口径视为 0）才算真能读；401 + 200003 会走到这里。
        if (payload?.code === 0 || payload?.code === undefined) return entry
        rejected.push(`${entry.ref}(code=${String(payload?.code)})`)
      } else {
        rejected.push(`${entry.ref}(HTTP ${response.status})`)
      }
    }
    expect.fail(
      `所有 Raccoon 凭据均已失效，无法读取目录：${rejected.join('、')}。`
      + '这不是目录漂移 —— 请在 Jet Hub 的 Raccoon 面板重新登录一个账号。',
    )
    return undefined
  }

  it('至少有一个已登录的 Raccoon 账号', () => {
    expect(
      entries.length,
      '未找到 Raccoon 凭据。请先在 Jet Hub 的 Raccoon 面板用微信扫码或短信登录一个账号，'
      + '或设置 DSH_RACCOON_CREDENTIAL_JSON。',
    ).toBeGreaterThan(0)
  })

  it('模型目录与基线快照逐条一致（漂移即红、并点名差集）', async () => {
    const first = await pickUsableEntry()

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

    // 兜底表就是离线时的真相源 ⇒ 远端可见的那部分必须与远端**逐字同序**（顺序也是判据：
    // 表里的顺序是「照抄远端」，重排会让排查失去可比性）。
    //
    // ⚠️ 但兜底表**可以**比远端多出 `LEGACY_ALIAS_IDS`（2026-11-17 起）：
    // 上游把 `sn-deepseek-v4-1-flash` 换成 `-1017` 后，旧会话里存的旧 id 必须仍能
    // resolve 出**带图**能力（否则升级即静默丢图）。那些别名刻意不在远端目录里，
    // 所以这里显式把已知别名集剥掉再比，不把「兜底表 ⊋ 远端」误判成漂移。
    const fallbackIds = RACCOON.fallbackModels.map((m) => m.id)
    const fallbackRemotePart = fallbackIds.filter(
      (id) => !(LEGACY_ALIAS_IDS as readonly string[]).includes(id),
    )
    expect(
      fallbackRemotePart,
      '兜底表已与远端漂移：请同步 RACCOON_FALLBACK_MODELS',
    ).toEqual([...EXPECTED_VISIBLE_IDS])
    // 别名必须仍在表里（删掉 = 旧会话丢图，见 src/raccoon-product.ts 的注释）。
    for (const alias of LEGACY_ALIAS_IDS) {
      expect(fallbackIds, `兜底表必须保留旧 id 别名 ${alias}（旧会话存的是它）`).toContain(alias)
    }

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
    // ③ 上游若发了重复 **name**（= 请求 id 的来源，见上面 ①），`parseRaccoonModelCatalog`
    //    **会**按 id 去重（`src/raccoon-auth.ts` 的 `seen` 集合）⇒ 选择器不会出现两行，
    //    但也意味着**漂移被静默吞掉**：解析层悄悄替你选了一条，没人知道上游发了两条。
    //    ⚠️ 所以判据必须打在**原始层** `rawNames`：拿解析后的 `ids` 去测去重是**恒真**的
    //    （2026-11-17 审计实测：M3 让上游真发重复 id，旧断言仍 PASS —— 因为它断言的那份
    //    `ids` 已经被解析层去重过了）。这条守的是「上游目录本身不许有重复」，不是「解析层有没有去重」。
    const rawNames = visibleRaw.map((m) => String(m['name'] ?? ''))
    expect(
      new Set(rawNames).size,
      '上游目录出现重复 name（解析层会静默去重，用户看到的是它替你挑的那一条）',
    ).toBe(rawNames.length)

    // ④ 双差集必须**两个方向**都点名（2026-11-17 审计实测：把判据退化成
    //    `missing-only` 时，上游**新增**模型仍然全绿 —— 一个只报「少了什么」
    //    的判据会把「多出来什么」变成静默）。这里用两条**人造输入**把方向钉死，
    //    不依赖远端今天到底有没有多/少（否则这条用例会随上游漂移而失去意义）。
    const driftReport = (actual: readonly string[], expected: readonly string[]) => ({
      missing: expected.filter((id) => !actual.includes(id)),
      extra: actual.filter((id) => !expected.includes(id)),
    })
    expect(driftReport(['a', 'b'], ['a', 'b']), '同集必须报干净').toEqual({ missing: [], extra: [] })
    expect(driftReport(['a', 'b', 'c'], ['a', 'b']), '上游**新增**一条必须进 extra')
      .toEqual({ missing: [], extra: ['c'] })
    expect(driftReport(['a'], ['a', 'b', 'c']), '上游**下架**两条必须进 missing')
      .toEqual({ missing: ['b', 'c'], extra: [] })

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
    const first = await pickUsableEntry()
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
    const first = await pickUsableEntry()
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
    const first = await pickUsableEntry()
    if (first === undefined) return
    const balance = await fetchRaccoonCreditBalance(RACCOON, first.credential)
    expect(balance, '余额查询失败（凭据可能已失效）').not.toBeNull()
    expect(typeof balance?.total).toBe('number')
    expect(balance?.total).toBeGreaterThanOrEqual(0)
    // 各池分开作 package（reward / daily / topup）
    expect((balance?.packages.length ?? 0)).toBeGreaterThan(0)
  })

  it('登录奖励状态可查（只读，不发写请求）', async () => {
    const first = await pickUsableEntry()
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
