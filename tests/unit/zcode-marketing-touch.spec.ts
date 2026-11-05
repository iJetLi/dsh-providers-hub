/**
 * ★★ ZCode **营销投放**的可领 plan：来源、版本门控、合并与回执（2026-10-23）。
 *
 * ## 用户报障（本文件的存在理由）
 *
 * > 「我在 scoop 中装了 zcode 最新版 3.16.3，其中有 1024 程序员节送的 5 亿 token，
 * >   把这个领取功能集成在每日签到中一并领取，只有 zcode 中国版有，国际版好像没有」
 *
 * ## 逆向 + 实测定下来的事实（逐条都有出处）
 *
 * | 事实 | 出处 |
 * |---|---|
 * | 官方把这类横幅放在 `GET /api/v1/marketing/touch`（`createMarketingTouchService`） | `app.asar` → `out/host/index.js` |
 * | 横幅按钮 action = `claim_zcode_plan{plan_id}` | `out/renderer/assets/src-oukR4Y1K.js` 的投放 schema |
 * | 点击后主进程走 `claimManualPlan()` → **`POST /zcode-plan/billing/claim`**（带 captcha） | `out/host/index.js` 的 `claimManualPlan` |
 * | **`billing/preview` 恒为空**（4 账号实测），1024 活动**只在** marketing 里 | `scripts/probe-zcode-marketing-touch.mjs` |
 * | **版本门控**：同一账号同一套头，`3.14.3` → `deliveries: []`；`3.16.3` → 有投放 | 同上（只改一个头） |
 * | 领取成功需回报 `POST /marketing/touch/action {campaign_id, action_type:'confirm'}` | `out/renderer/assets/styles-n-UNIiNg.js`（`p(delivery,'confirm')`） |
 *
 * ⚠ **两个来源共用同一个领取端点**：所以本次改动只是「多一个 plan 来源 + 一次回执」，
 *   **不需要**新的领取协议、也不需要新的 captcha 机制。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { ZcodeAuth } from '../../src/zcode-auth.js'
import { ZCODE } from '../../src/zcode-product.js'
import type { ZcodeCredential } from '../../src/zcode.js'
import {
  ZCODE_VERSION_GATED_MIN_APP_VERSION,
  claimablePlansFromMarketingDeliveries,
  compareZcodeAppVersion,
  fetchZcodeMarketingPlans,
  mergeZcodeClaimablePlans,
  reportZcodeMarketingAction,
  zcodeVersionGatedAppVersion,
  type ZcodeClaimablePlan,
} from '../../src/zcode-upstream.js'
import { resetCaptchaSupply } from '../../src/captcha-supply.js'
import { resetCaptchaRequirementMemory } from '../../src/captcha-requirement.js'

/**
 * **实测报文**（2026-10-23，本机账号，`X-ZCode-App-Version: 3.16.3`）。
 *
 * ⚠ 只删掉了 `description.content` 那两段 HTML（数 KB，纯文案）与资产的
 *   base64，**结构一字未改**；`grant_units` / `priority` / `plan_id` / action
 *   全部原样保留 —— 判据就该打在真实形状上。
 */
const DELIVERY_1024 = {
  campaign_id: '2113475573403824128',
  resource_position: 'banner',
  priority: 50,
  banner: {
    buttons: [
      { text: { format: '', content: '' }, action: { type: 'close', args: null } },
      {
        text: { format: '', content: '' },
        action: { type: 'claim_zcode_plan', args: { plan_id: 'zcode-v3-start-plan-1024' } },
      },
    ],
    background: {
      type: 'bundle',
      bundle: {
        bundle: {
          src: 'https://cdn-zcode.z.ai/marketing/touch/assets/2113543473562378240/dev1024-sealed-banner-2line-1.0.5.zip',
          sha256: 'e4b8cb58a8fec44e7246688e93d3b14ebc7b934c45e680dcd363e5960a211852',
        },
        entry: 'index.html',
      },
      args: {
        zcode_plan: {
          plan_id: 'zcode-v3-start-plan-1024',
          name: 'ZCode 1024 Dev Day',
          priority: 101,
          starts_at: 1792756800,
          ends_at: 1792976400,
          entitlements: [
            {
              entitlement_id: 'ent-zcode-v3-start-plan-1024-1',
              show_name: 'GLM-5.3-Flash',
              meter: 'model_usage',
              unit_type: 'token',
              capabilities: ['model:glm-5.3-flash'],
              grant_units: 300000000,
              period: 'one_time',
              effective_at: 1792767600,
              priority: 101,
            },
            {
              entitlement_id: 'ent-zcode-v3-start-plan-1024-2',
              show_name: 'GLM-5.3',
              meter: 'model_usage',
              unit_type: 'token',
              capabilities: ['model:glm-5.3'],
              grant_units: 200000000,
              period: 'one_time',
              effective_at: 1792767600,
              priority: 100,
            },
          ],
        },
      },
    },
    success_popup: {
      buttons: [
        {
          text: { format: 'plaintext', content: '模型设置' },
          action: { type: 'navigate', args: { page: 'settings', section: 'models' } },
        },
        {
          text: { format: 'plaintext', content: '复制分享' },
          theme: { variant: 'secondary' },
          action: { type: 'copy_text', args: { text: '我在 ZCode 领取了 GLM-5.3-Flash 300000000 Tokens…' } },
        },
      ],
      hero: {
        type: 'bundle',
        bundle: {
          bundle: { src: 'https://cdn-zcode.z.ai/marketing/touch/assets/2113543499743223808/dev1024-sealed-hero-1.0.4.zip', sha256: '21da98c5' },
          entry: 'index.html',
        },
        // ⚠ 同一份 plan 元数据**镜像**到多个资产位（实测如此）⇒ 解析必须能容下重复。
        args: {
          zcode_plan: {
            plan_id: 'zcode-v3-start-plan-1024',
            name: 'ZCode 1024 Dev Day',
            priority: 101,
            entitlements: [
              { unit_type: 'token', grant_units: 300000000 },
              { unit_type: 'token', grant_units: 200000000 },
            ],
          },
        },
      },
      title: { format: 'plaintext', content: 'ZCode 1024 Dev Day 领取成功' },
      description: { format: 'html', content: '<p>GLM-5.3-Flash 将于 …</p>' },
    },
  },
}

/** popup 形态（同一套按钮结构，`resource_position: 'popup'`）。 */
const POPUP_DELIVERY = {
  campaign_id: 'campaign-popup-1',
  resource_position: 'popup',
  priority: 5,
  popup: {
    title: { format: 'plaintext', content: '限时活动' },
    buttons: [
      { text: { format: 'plaintext', content: '领取' }, action: { type: 'claim_zcode_plan', args: { plan_id: 'plan-popup-1' } } },
      { text: { format: 'plaintext', content: '了解' }, action: { type: 'open_url', args: { url: 'https://zcode.z.ai' } } },
    ],
  },
}

describe('★ 营销投放解析（纯函数，判定打在实测报文的真实形状上）', () => {
  it('★ 1024 活动：提取 plan_id、求和 5 亿、取到 name/priority/campaignId', () => {
    const plans = claimablePlansFromMarketingDeliveries([DELIVERY_1024])
    expect(plans).toHaveLength(1)
    const plan = plans[0]!
    expect(plan.planId).toBe('zcode-v3-start-plan-1024')
    /**
     * ★★ 3 亿（GLM-5.3-Flash）+ 2 亿（GLM-5.3）= **5 亿** —— 正是用户截图里
     * 「5 亿 TOKENS」那一行。只取 `entitlements[0]` 会少报 2 亿。
     */
    expect(plan.grantUnits).toBe(500_000_000)
    expect(plan.unitType).toBe('token')
    expect(plan.name).toBe('ZCode 1024 Dev Day')
    expect(plan.priority).toBe(101)
    expect(plan.marketingCampaignId).toBe('2113475573403824128')
  })

  it('★★ 只有 `claim_zcode_plan` 算领取：`close` / `navigate` / `copy_text` / `open_url` 都不算', () => {
    // 该投送物里同时存在 close（banner）、navigate 与 copy_text（success_popup）。
    const plans = claimablePlansFromMarketingDeliveries([DELIVERY_1024])
    expect(plans.map((p) => p.planId)).toEqual(['zcode-v3-start-plan-1024'])
    // 提取到的那条必须是 claim 动作本身（不是靠「恰好没有 plan_id」被挡掉的）
    expect(plans).toHaveLength(1)
  })

  it('★★ `type` 判据必须**独立成立**：`close`/`navigate` 即使带了 plan_id 也不算领取', () => {
    /**
     * ⚠⚠ 这条用例是**变异验证逼出来的**（2026-10-23）。
     *
     * 上面那条用例里 `close` 的 `args` 是 `null`（实测原样），于是它**碰巧**
     * 被「`args.plan_id` 必须是非空字符串」那条腿挡住了 —— 实测把
     * `if (actionRecord.type !== 'claim_zcode_plan') continue` 整行删掉，
     * 上面那条用例**仍然全绿**（该变异无牙）。
     *
     * ⇒ 判据必须能在「服务端给非领取动作也带了 plan_id」时独立生效
     *   （服务端数据不可信，将来给 `close` 带上 plan_id 完全可能）。
     *   把那样的 args 当领取，会对一个**不该领**的 plan 发请求 + 烧 captcha。
     */
    const delivery = {
      campaign_id: 'c-close',
      resource_position: 'banner',
      banner: {
        buttons: [
          { text: { format: '', content: '' }, action: { type: 'close', args: { plan_id: 'must-not-claim' } } },
          { text: { format: 'plaintext', content: '设置' }, action: { type: 'navigate', args: { page: 'settings', plan_id: 'must-not-claim-2' } } },
          { text: { format: 'plaintext', content: '复制' }, action: { type: 'copy_text', args: { text: 'x', plan_id: 'must-not-claim-3' } } },
          { text: { format: 'plaintext', content: '外链' }, action: { type: 'open_url', args: { url: 'https://zcode.z.ai', plan_id: 'must-not-claim-4' } } },
        ],
      },
    }
    expect(claimablePlansFromMarketingDeliveries([delivery])).toEqual([])
  })

  it('popup 形态同样能提取（不是只认 banner）', () => {
    const plans = claimablePlansFromMarketingDeliveries([POPUP_DELIVERY])
    expect(plans.map((p) => p.planId)).toEqual(['plan-popup-1'])
    expect(plans[0]?.marketingCampaignId).toBe('campaign-popup-1')
    // popup 里没有 plan 元数据 ⇒ 额度缺失时**留 undefined**（不谎报 0）
    expect(plans[0]?.grantUnits).toBeUndefined()
    // 也没有元数据 priority ⇒ 回落投送物的 priority
    expect(plans[0]?.priority).toBe(5)
  })

  it('同一 plan 元数据镜像在多处 ⇒ 仍只有一条 plan（不重复领）', () => {
    const plans = claimablePlansFromMarketingDeliveries([DELIVERY_1024, DELIVERY_1024])
    expect(plans).toHaveLength(1)
  })

  it('单位不同的 entitlement **不混加**（宁可少报，也不把 token 与积分加成一个数）', () => {
    const delivery = {
      campaign_id: 'c1',
      resource_position: 'banner',
      banner: {
        buttons: [{ action: { type: 'claim_zcode_plan', args: { plan_id: 'p-mixed' } } }],
        background: {
          args: {
            zcode_plan: {
              plan_id: 'p-mixed',
              entitlements: [
                { unit_type: 'token', grant_units: 100 },
                { unit_type: 'credit', grant_units: 7 },
                { unit_type: 'token', grant_units: 5 },
              ],
            },
          },
        },
      },
    }
    const plans = claimablePlansFromMarketingDeliveries([delivery])
    expect(plans[0]?.grantUnits).toBe(105)
    expect(plans[0]?.unitType).toBe('token')
  })

  it('垃圾输入一律空数组（服务端数据不可信）', () => {
    expect(claimablePlansFromMarketingDeliveries(undefined)).toEqual([])
    expect(claimablePlansFromMarketingDeliveries(null)).toEqual([])
    expect(claimablePlansFromMarketingDeliveries({ deliveries: [] })).toEqual([])
    expect(claimablePlansFromMarketingDeliveries([null, 42, 'x'])).toEqual([])
    expect(claimablePlansFromMarketingDeliveries([{ banner: { buttons: [{ action: { type: 'claim_zcode_plan', args: {} } }] } }])).toEqual([])
    // 超深嵌套不得把解析拖死（有界扫描）
    let deep: Record<string, unknown> = { plan_id: 'too-deep' }
    for (let i = 0; i < 40; i += 1) deep = { nest: deep }
    expect(claimablePlansFromMarketingDeliveries([{ campaign_id: 'c', banner: { buttons: [], background: deep } }])).toEqual([])
  })
})

describe('★ 版本门控（实测 2026-11-03：3.14.3/3.16.3 均空，3.17.1 起才有投放）', () => {
  it('凭据里的 3.14.3 被抬到门槛值', () => {
    expect(zcodeVersionGatedAppVersion({ app_version: '3.14.3' })).toBe('3.17.1')
    expect(ZCODE_VERSION_GATED_MIN_APP_VERSION).toBe('3.17.1')
  })

  it('凭据里是更新版本时**不降级**（向前兼容）', () => {
    expect(zcodeVersionGatedAppVersion({ app_version: '3.17.2' })).toBe('3.17.2')
    expect(zcodeVersionGatedAppVersion({ app_version: '4.0.0' })).toBe('4.0.0')
  })

  it('缺版本/空串 ⇒ 用最低版本（不是空串，那会让服务端按未知版本处理）', () => {
    expect(zcodeVersionGatedAppVersion({})).toBe('3.17.1')
    expect(zcodeVersionGatedAppVersion({ app_version: '   ' })).toBe('3.17.1')
  })

  it('点分版本比较', () => {
    expect(compareZcodeAppVersion('3.14.3', '3.16.3')).toBe(-1)
    expect(compareZcodeAppVersion('3.16.3', '3.14.3')).toBe(1)
    expect(compareZcodeAppVersion('3.16.3', '3.16.3')).toBe(0)
    expect(compareZcodeAppVersion('3.16', '3.16.0')).toBe(0)
    expect(compareZcodeAppVersion('3.10.0', '3.9.9')).toBe(1)
  })
})

describe('★ 来源合并（preview 优先 + 补 campaignId + priority 降序）', () => {
  const previewPlan = (planId: string, priority: number): ZcodeClaimablePlan => ({ planId, priority })

  it('两个来源并集、按 priority 降序（1024 的 101 排在每日赠送之前）', () => {
    const merged = mergeZcodeClaimablePlans(
      [previewPlan('daily-1003', 10)],
      [{ planId: 'zcode-v3-start-plan-1024', priority: 101, marketingCampaignId: 'c1' }],
    )
    expect(merged.map((p) => p.planId)).toEqual(['zcode-v3-start-plan-1024', 'daily-1003'])
  })

  it('同一 planId 在两边 ⇒ 只领一次，且**补上** campaignId（否则领完不回执）', () => {
    const merged = mergeZcodeClaimablePlans(
      [previewPlan('same', 5)],
      [{ planId: 'same', priority: 5, grantUnits: 999, marketingCampaignId: 'c9' }],
    )
    expect(merged).toHaveLength(1)
    // preview 那份的额度口径保留（既有实测过的字段优先）
    expect(merged[0]?.grantUnits).toBeUndefined()
    // 但 campaignId 被补上 —— 这条是「领完能回执」的唯一依据
    expect(merged[0]?.marketingCampaignId).toBe('c9')
  })

  it('marketing 的 plan 不会覆盖 preview 已有的 campaignId', () => {
    const merged = mergeZcodeClaimablePlans(
      [{ planId: 'same', priority: 5, marketingCampaignId: 'keep' }],
      [{ planId: 'same', priority: 5, marketingCampaignId: 'other' }],
    )
    expect(merged[0]?.marketingCampaignId).toBe('keep')
  })
})

/** 过 `validateCaptchaParam` 的假 param（长度 ≥200 + base64 JSON + certifyId + 长 token）。 */
function fakeParam(tag: string): string {
  const body = JSON.stringify({
    certifyId: tag,
    sceneId: '11xygtvd',
    securityToken: `${tag}-${'t'.repeat(128)}`,
  })
  const encoded = Buffer.from(body, 'utf8').toString('base64')
  if (encoded.length < 200) throw new Error(`假 param 太短（${String(encoded.length)}）`)
  return encoded
}

const CREDENTIAL: ZcodeCredential = {
  zcode_jwt: 'a.b.c',
  device_mid: '11111111-2222-4333-8444-555555555555',
  app_version: '3.14.3',
  source: 'plugin',
}

class FakeCredentials {
  readonly store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) { return { configured: this.store.has(ref), writable: true } }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

 /** 领取路径的上游桩（按 URL 分派；`marketing` 可切失败形态）。 */
function makeClaimFetch(options: {
  previewPlans?: readonly string[]
  deliveries?: unknown
  marketingStatus?: number
  claimCode?: number
  confirmCode?: number
} = {}): {
  fetchImpl: typeof fetch
  claimPlanIds: string[]
  /** 每次 claim 请求带的 `X-ZCode-App-Version`（★ 版本门控的**领取侧**判据）。 */
  claimVersions: string[]
  marketingVersions: string[]
  confirmBodies: Array<Record<string, unknown>>
  marketingCalls: number
} {
  const claimPlanIds: string[] = []
  const claimVersions: string[] = []
  const marketingVersions: string[] = []
  const confirmBodies: Array<Record<string, unknown>> = []
  let marketingCalls = 0
  const json = (body: string, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } })

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const sent = (init.headers ?? {}) as Record<string, string>
    if (url.includes('/event/report')) return json('{}')
    if (url.includes('/client/configs')) {
      return json(JSON.stringify({ data: { configs: { captcha: { region: 'cn', prefix: 'pf-cn', sceneId: '11xygtvd' } } } }))
    }
    if (url.includes('/marketing/touch/action')) {
      confirmBodies.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>)
      return json(JSON.stringify({ code: options.confirmCode ?? 0 }))
    }
    if (url.includes('/marketing/touch')) {
      marketingCalls += 1
      marketingVersions.push(sent['X-ZCode-App-Version'] ?? '')
      if ((options.marketingStatus ?? 200) !== 200) return json('{"code":5000}', options.marketingStatus)
      return json(JSON.stringify({ code: 0, data: { deliveries: options.deliveries ?? [] } }))
    }
    if (url.includes('/billing/preview')) {
      const plans = (options.previewPlans ?? []).map((plan_id, index) => ({ plan_id, priority: index }))
      return json(JSON.stringify({ data: { plans } }))
    }
    if (url.includes('/billing/claim')) {
      const body = JSON.parse(String(init.body ?? '{}')) as { plan_id?: string }
      if (typeof body.plan_id === 'string') claimPlanIds.push(body.plan_id)
      claimVersions.push(sent['X-ZCode-App-Version'] ?? '')
      return json(JSON.stringify({ code: options.claimCode ?? 0, msg: 'ok' }))
    }
    throw new Error(`桩 fetch 收到未预期的 URL：${url}`)
  }) as unknown as typeof fetch

  return {
    fetchImpl,
    claimPlanIds,
    claimVersions,
    marketingVersions,
    confirmBodies,
    get marketingCalls() { return marketingCalls },
  }
}

async function makeAuth(fetchImpl: typeof fetch): Promise<ZcodeAuth> {
  const ctx = new Context()
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  await credentials.set(ZCODE.defaultCredentialRef, JSON.stringify(CREDENTIAL))
  return new ZcodeAuth(ctx, { fetchImpl })
}

beforeEach(() => {
  resetCaptchaSupply()
  resetCaptchaRequirementMemory()
})

describe('★★ 接线：签到真的会去领营销投放里的 plan（防「原语写好但没接上」）', () => {
  it('★ 1024 活动被领掉：claim 收到 `zcode-v3-start-plan-1024`，且请求头版本被抬到门控版', async () => {
    const net = makeClaimFetch({ deliveries: [DELIVERY_1024] })
    const auth = await makeAuth(net.fetchImpl)

    const outcomes = await auth.claimDaily(async () => fakeParam('p'))

    expect(outcomes[0]?.kind).toBe('claimed')
    // ★ 判据打在「真的把那个 plan_id 发出去了」上，而不是「函数返回值好看」
    expect(net.claimPlanIds).toEqual(['zcode-v3-start-plan-1024'])
    /**
     * ★★ 版本门控的**接线**判据：凭据里写的是 3.14.3，但营销请求必须带门控版
     *（本机实测：带 3.14.3 时服务端回 `deliveries: []` ⇒ 这条不成立就等于没集成）。
     */
    expect(net.marketingVersions).toEqual(['3.17.1'])
  })

  it('★★ **claim 也必须带门控版本** —— 真机实测：3.14.3 ⇒ `1004 no permission`，3.16.2 ⇒ `code 0`', async () => {
    /**
     * ⚠ 这条用例是**真机一发定音**逼出来的（`scripts/probe-zcode-claim-version-gate.mjs`）：
     *
     * | `X-ZCode-App-Version`（其余头完全相同） | claim 返回 |
     * |---|---|
     * | `3.14.3`（凭据里记的） | `400 / code 1004 "no permission"` |
     * | `3.16.2` | **`200 / code 0`** + `data.plan.{status:"active", …}` |
     *
     * ⇒ 只抬营销请求的版本**不够**：活动能查到、却领不到，而且报的是
     *   「不符合条件」（看起来像账号问题）。**两个端点必须同抬**。
     *
     * ⚠ 判据打在**请求头**上（而不是返回值）：返回值在桩里恒为 `code 0`，
     *   拿它做判据是恒真的 —— 那种用例删掉实现也全绿。
     */
    const net = makeClaimFetch({
      previewPlans: ['zcode-v3-start-plan-trust-1004'],
      deliveries: [DELIVERY_1024],
    })
    const auth = await makeAuth(net.fetchImpl)
    await auth.claimDaily(async () => fakeParam('p'))

    expect(net.claimVersions).toHaveLength(net.claimPlanIds.length)
    expect(net.claimVersions).toEqual([
      '3.17.1',
      '3.17.1',
    ])
    // 反向对照：凭据里只有 3.14.3 —— 若实现没覆盖，上面两格会变成 '3.14.3'
    expect(CREDENTIAL.app_version).toBe('3.14.3')
  })

  it('★ 领取成功后回报 `confirm`（否则服务端会反复投放 ⇒ 每轮签到白烧一个 captcha）', async () => {
    const net = makeClaimFetch({ deliveries: [DELIVERY_1024] })
    const auth = await makeAuth(net.fetchImpl)
    await auth.claimDaily(async () => fakeParam('p'))

    expect(net.confirmBodies).toEqual([
      { campaign_id: '2113475573403824128', action_type: 'confirm' },
    ])
  })

  it('★★ preview 的 plan（没有 campaignId）**不**发 confirm —— 不得误报营销动作', async () => {
    const net = makeClaimFetch({ previewPlans: ['zcode-v3-start-plan-trust-1004'] })
    const auth = await makeAuth(net.fetchImpl)
    const outcomes = await auth.claimDaily(async () => fakeParam('p'))

    expect(outcomes[0]?.kind).toBe('claimed')
    expect(net.claimPlanIds).toEqual(['zcode-v3-start-plan-trust-1004'])
    expect(net.confirmBodies).toEqual([])
  })

  it('★ 领取**失败**时绝不发 confirm（那是「别再给我看了」⇒ 用户白丢一次机会）', async () => {
    const net = makeClaimFetch({ deliveries: [DELIVERY_1024], claimCode: 1005 })
    const auth = await makeAuth(net.fetchImpl)
    const outcomes = await auth.claimDaily(async () => fakeParam('p'))

    expect(outcomes[0]?.kind).toBe('failed')
    expect(net.confirmBodies).toEqual([])
  })

  it('★ 已领取（1003，幂等成功）仍然要发 confirm —— 那正是「已处理完」的场景', async () => {
    const net = makeClaimFetch({ deliveries: [DELIVERY_1024], claimCode: 1003 })
    const auth = await makeAuth(net.fetchImpl)
    const outcomes = await auth.claimDaily(async () => fakeParam('p'))

    expect(outcomes[0]?.kind).toBe('already-claimed')
    expect(net.confirmBodies).toHaveLength(1)
  })

  it('★ 营销端点挂掉**不影响** preview 那条主路径（降级为空，不抛）', async () => {
    const net = makeClaimFetch({
      previewPlans: ['zcode-v3-start-plan-trust-1004'],
      marketingStatus: 500,
    })
    const auth = await makeAuth(net.fetchImpl)
    const outcomes = await auth.claimDaily(async () => fakeParam('p'))

    expect(outcomes[0]?.kind).toBe('claimed')
    expect(net.claimPlanIds).toEqual(['zcode-v3-start-plan-trust-1004'])
  })

  it('★ confirm 回执失败**不影响**领取结果（best-effort）', async () => {
    const net = makeClaimFetch({ deliveries: [DELIVERY_1024], confirmCode: 5000 })
    const auth = await makeAuth(net.fetchImpl)
    const outcomes = await auth.claimDaily(async () => fakeParam('p'))

    expect(outcomes[0]?.kind).toBe('claimed')
    expect(net.confirmBodies).toHaveLength(1)
  })

  it('★ 两个来源都有 plan ⇒ 各领一次，顺序按 priority 降序（1024 在前）', async () => {
    const net = makeClaimFetch({
      previewPlans: ['daily-trust-1003'],
      deliveries: [DELIVERY_1024],
    })
    const auth = await makeAuth(net.fetchImpl)
    await auth.claimDaily(async () => fakeParam('p'))

    expect(net.claimPlanIds).toEqual(['zcode-v3-start-plan-1024', 'daily-trust-1003'])
  })

  it('★ 签到状态也认营销投放（否则面板显示「已领取」而 1024 其实没领）', async () => {
    const net = makeClaimFetch({ deliveries: [DELIVERY_1024] })
    const auth = await makeAuth(net.fetchImpl)
    const status = await auth.fetchCheckinStatus()

    expect(status.active).toBe(true)
    expect(status.todayCheckedIn).toBe(false)
  })
})

describe('★ 请求层：失败一律降级，且不谎报', () => {
  it('fetchZcodeMarketingPlans：HTTP 500 / 非 JSON / 抛错 ⇒ 空数组', async () => {
    const version = { app_version: '3.17.1' }
    const bad = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    expect(await fetchZcodeMarketingPlans(CREDENTIAL, bad)).toEqual([])

    const notJson = (async () =>
      new Response('<html>edge error</html>', { status: 200 })) as unknown as typeof fetch
    expect(await fetchZcodeMarketingPlans(CREDENTIAL, notJson)).toEqual([])

    const throwing = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    expect(await fetchZcodeMarketingPlans(CREDENTIAL, throwing)).toEqual([])
    // 版本对象本身不参与断言，仅确认工具函数不抛
    expect(zcodeVersionGatedAppVersion(version)).toBe('3.17.1')
  })

  it('reportZcodeMarketingAction：只有 `{code:0}` 算成功', async () => {
    const ok = (async () => new Response('{"code":0}', { status: 200 })) as unknown as typeof fetch
    expect(await reportZcodeMarketingAction(CREDENTIAL, 'c1', 'confirm', ok)).toBe(true)

    const nonZero = (async () => new Response('{"code":5000}', { status: 200 })) as unknown as typeof fetch
    expect(await reportZcodeMarketingAction(CREDENTIAL, 'c1', 'confirm', nonZero)).toBe(false)

    const http500 = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    expect(await reportZcodeMarketingAction(CREDENTIAL, 'c1', 'confirm', http500)).toBe(false)

    const throwing = (async () => { throw new Error('down') }) as unknown as typeof fetch
    expect(await reportZcodeMarketingAction(CREDENTIAL, 'c1', 'confirm', throwing)).toBe(false)
  })
})