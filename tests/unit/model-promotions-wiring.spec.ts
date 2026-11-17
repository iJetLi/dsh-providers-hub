/**
 * 徽标从**上游报文到宿主目录字段**的全链路守卫（GitHub issue #101）。
 *
 * ## 为什么不只测 src/model-promotions.ts
 *
 * 判据层单测证明不了任何一条**接线**，而本仓反复出缺陷的形态正是
 * 「纯函数全绿、装配层没接上」。所以这里跑**真适配器**：
 *
 * | 腿 | 谁装配 | 漏接的症状 |
 * |---|---|---|
 * | 解析 → 条目 | parseModelsFromConfig | 上游给了活动、条目没带 |
 * | 并集合并 | buddy-oauth 的 applyPromotionCandidates | scoped 优先 ⇒ 活动整条丢 |
 * | **白名单重建** | reconcileWithFallback | 字段被**静默丢弃**、零报错 |
 * | 装配 → 宿主 | toCatalogEntry → 骨架 toModelInfo | 徽标不出现在 listModels |
 * | 时刻 | 每次 listModels 重算 | 白天挂着夜里的徽标 |
 *
 * ⚠️ 第三行是这条链上**唯一会静默**的一处：reconcileWithFallback 自己的注释
 * 就写着「新增远端字段时必须同步加一行，否则 listModels 看不到它」。
 */
import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import { CODEBUDDY } from '../../src/product.js'
import { QODER } from '../../src/qoder-product.js'
import type { QoderFallbackModel } from '../../src/qoder-product.js'
import { fetchModels } from '../../src/buddy-oauth.js'
import type { BuddyCredential, BuddyRemoteModel } from '../../src/buddy.js'

/** 2026-11-17 23:30 Asia/Shanghai（夜间窗口内）。 */
const NIGHT_SH = (): number => Date.parse('2026-11-17T15:30:00Z')
/** 2026-11-17 08:00 Asia/Shanghai（夜间窗口外）。 */
const DAY_SH = (): number => Date.parse('2026-11-17T00:00:00Z')

/** 一份带活动的 /v3/config 报文（形状取自 2026-11-17 只读探测）。 */
function configBody(): string {
  return JSON.stringify({
    code: 0,
    data: {
      agents: [{ name: 'craft', models: ['glm-5.2', 'glm-5.3'] }],
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', credits: 'x0.79', maxInputTokens: 1000000 },
        { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.69', maxInputTokens: 1000000 },
      ],
      modelPromotions: [{
        id: 'glm-52-night-discount',
        kind: 'discount',
        enabled: true,
        priority: 100,
        modelIds: ['glm-5.2'],
        badge: { label: '夜间折扣', color: '#009273' },
        discount: { discountedCredits: '0.50x', displayMode: 'strikethrough', factor: 0.5 },
        hover: { textZh: '每日 23:00–7:50 享 5 折。' },
        schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
      }],
      modelTiers: [{
        id: 'glm-53-pro',
        priority: 200,
        modelIds: ['glm-5.3'],
        badge: { label: '订阅优先' },
      }],
    },
  })
}

function routeFetch(routes: Array<{ when: (url: string) => boolean; respond: () => Response }>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const route of routes) if (route.when(url)) return route.respond()
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

function makeCredential(): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
  }
}

/** buddy 适配器（默认只注入远端目录，不发网络）。 */
function makeBuddyAdapter(overrides: {
  remoteModels?: () => Promise<BuddyRemoteModel[]>
  now?: () => number
} = {}): BuddyAdapter {
  return new BuddyAdapter({
    credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
    resolveCredential: async () => makeCredential(),
    refresh: async () => {},
    fetchImpl: async () => new Response('not used', { status: 500 }),
    product: CODEBUDDY,
    accountPool: {
      hasLoggedInAccount: async () => true,
      disabledModelsFor: () => new Set<string>(),
    } as never,
    ...overrides.remoteModels === undefined ? {} : { fetchRemoteModels: overrides.remoteModels },
    ...overrides.now === undefined ? {} : { now: overrides.now },
  } as never)
}

/** glm-5.2 的远端条目：一条带夜间活动候选，一条不带（参数控制）。 */
function remoteGlm(withPromos: boolean): BuddyRemoteModel {
  const base: BuddyRemoteModel = {
    id: 'glm-5.2', name: 'GLM-5.2', creditsRate: 'x0.79',
    contextWindow: 1_000_000,
  }
  if (!withPromos) return base
  return {
    ...base,
    discountedCreditsRate: 'x0.50',
    promos: [{
      id: 'glm-52-night-discount',
      source: 'promotion',
      modelIds: ['glm-5.2'],
      badge: { label: '夜间折扣', color: '#009273' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
      timeDeclared: true,
      standingEligible: true,
      priority: 100,
    }],
  }
}

function rowOf(list: readonly { id: string; name?: string; badge?: unknown }[], id: string) {
  const row = list.find((item) => item.id === id)
  if (row === undefined) throw new Error('目录里没有该条目：' + id)
  return row as { id: string; name: string; badge?: { text: unknown; tone: string } }
}

describe('★ 全链路：上游报文 → 宿主 badge 字段', () => {
  it('上游带活动 ⇒ listModels 对应条目带 badge，文案是上游原话', async () => {
    const models = await fetchModels(makeCredential(), routeFetch([
      { when: (u) => u.includes('/console/enterprises/personal/models'), respond: () => new Response(configBody(), { status: 200 }) },
      { when: (u) => u.includes('/v3/config'), respond: () => new Response(configBody(), { status: 200 }) },
    ]), undefined, CODEBUDDY)
    const glm = rowOf(models, 'glm-5.2') as unknown as BuddyRemoteModel
    expect(glm.promos, '解析层没把活动挂上条目').toBeDefined()
    expect(glm.promos![0]!.badge.label).toBe('夜间折扣')
    // ⚠️ 价格腿（discountedCreditsRate）**不在这里断言**：parseModelsFromConfig 调
    // parsePromotions 用的是真实墙上时钟（本仓既有行为，20 分钟窗口内会随昼夜变），
    // 在这里断言它会让用例随「什么时候跑」而红。价格腿由 buddy.spec.ts 的
    // 「促销必须按 schedule 判定此刻是否生效」一组用显式时钟覆盖。
    // 这里只锁「同源不同判据」这件事：原价后缀必须始终在名字里。
    expect(glm.creditsRate).toBe('x0.79')

    const adapter = makeBuddyAdapter({ remoteModels: async () => models, now: NIGHT_SH })
    const listed = await adapter.listModels('buddy')
    expect(rowOf(listed, 'glm-5.2').badge).toEqual({ text: '夜间折扣', tone: 'success' })
    // 原价后缀必须在（促销后缀按真实时钟可有可无，见上面的说明）。
    expect(rowOf(listed, 'glm-5.2').name).toContain('x0.79')
    // tier 那条（GLM-5.3：无 schedule）也画得出来 —— 常驻徽标、无颜色 ⇒ neutral。
    expect(rowOf(listed, 'glm-5.3').badge).toEqual({ text: '订阅优先', tone: 'neutral' })
  })

  it('★★ reconcileWithFallback 是白名单式重建：漏搬 promos 就静默丢弃', async () => {
    // 本用例**故意**用落在产品兜底表里的 id（glm-5.2），走那条白名单路径。
    // 变异：删掉 reconcileWithFallback 里 promos 那一行 ⇒ 本条红，
    // 而 model-promotions.spec.ts 全绿（它根本不经过装配层）。
    const adapter = makeBuddyAdapter({ remoteModels: async () => [remoteGlm(true)], now: NIGHT_SH })
    const listed = await adapter.listModels('buddy')
    expect(rowOf(listed, 'glm-5.2').badge, 'promos 被白名单重建丢掉了')
      .toEqual({ text: '夜间折扣', tone: 'success' })
  })

  it('★ scoped 优先时活动**仍要挂上**（scoped 端点不下发活动数组）', async () => {
    // 与「促销价永远不显示」那条用户报障**同一个成因**：mergeRemoteModels 对同 id
    // 以 scoped 为准；若只把价格补过去、活动不补，徽标就永远缺席。
    const models = await fetchModels(makeCredential(), routeFetch([
      {
        when: (u) => u.includes('/console/enterprises/personal/models'),
        respond: () => new Response(JSON.stringify({ data: {
          agents: [{ name: 'cli', models: ['glm-5.2'] }],
          models: [{ id: 'glm-5.2', name: 'GLM-5.2', credits: 'x0.79' }],
        } }), { status: 200 }),
      },
      { when: (u) => u.includes('/v3/config'), respond: () => new Response(configBody(), { status: 200 }) },
    ]), undefined, CODEBUDDY)
    const glm = rowOf(models, 'glm-5.2') as unknown as BuddyRemoteModel
    expect(glm.promos, 'scoped 条目没被补上 config 那份活动').toBeDefined()
    expect(glm.promos![0]!.badge.label).toBe('夜间折扣')
  })

  it('上游真的没有活动时**不写 badge 键**（而不是写 undefined）', async () => {
    const adapter = makeBuddyAdapter({
      remoteModels: async () => [remoteGlm(false)],
      now: NIGHT_SH,
    })
    const listed = await adapter.listModels('buddy')
    expect('badge' in rowOf(listed, 'glm-5.2')).toBe(false)
  })

  it('★ 编译期兜底表路径不写 badge（活动是运行时事实，静态表里没有）', async () => {
    // 红线「静态表必然腐坏」⇒ 不许在兜底表里编一枚。变异：给兜底表加假 promos ⇒ 红。
    const adapter = makeBuddyAdapter({}) // 无 fetchRemoteModels ⇒ 恒用兜底表
    const listed = await adapter.listModels('buddy')
    expect(listed.length, '兜底表应给出条目').toBeGreaterThan(0)
    for (const row of listed) expect('badge' in row).toBe(false)
  })

  it('★★ 徽标按装配时刻求值：白天不挂夜间徽标，夜里挂（同一实例、不重拉目录）', async () => {
    // 这是取舍 1 的行为证据。若把徽标在解析时冻进条目，两次都会给出同一个答案。
    let clock = DAY_SH
    const adapter = makeBuddyAdapter({ remoteModels: async () => [remoteGlm(true)], now: () => clock() })
    // 白天：窗口关着 ⇒ running 落空；本条**没有** activeOnly ⇒ 常驻那一支仍然成立
    // （照搬参考实现语义：时段管辖折扣、display 管辖徽标存续）。
    expect(rowOf(await adapter.listModels('buddy'), 'glm-5.2').badge)
      .toEqual({ text: '夜间折扣', tone: 'success' })
    // 换成 activeOnly ⇒ 白天必须什么都没有，夜里才有。
    const activeOnly: BuddyRemoteModel = {
      ...remoteGlm(true),
      promos: remoteGlm(true).promos!.map((p) => ({ ...p, badge: { ...p.badge, display: 'activeOnly' as const } })),
    }
    const nightAdapter = makeBuddyAdapter({ remoteModels: async () => [activeOnly], now: () => clock() })
    clock = DAY_SH
    expect('badge' in rowOf(await nightAdapter.listModels('buddy'), 'glm-5.2')).toBe(false)
    clock = NIGHT_SH
    expect(rowOf(await nightAdapter.listModels('buddy'), 'glm-5.2').badge)
      .toEqual({ text: '夜间折扣', tone: 'success' })
  })

  it('活动过期（validUntil 到点）⇒ activeOnly 徽标整条消失（issue #101 的核心诉求）', async () => {
    const expired: BuddyRemoteModel = {
      id: 'glm-5.2',
      name: 'GLM-5.2',
      promos: [{
        id: 'trial', source: 'promotion', modelIds: ['glm-5.2'],
        badge: { label: '限时免费', display: 'activeOnly' },
        // ⚠️ epoch **数字**（解析层的真实产物）：字符串那一类退化有专门一条用例。
        schedule: { timezone: 'Asia/Shanghai', validUntil: Date.parse('2026-11-15T16:00:00Z') },
        timeDeclared: true, standingEligible: true, priority: 200,
      }],
    }
    const adapter = makeBuddyAdapter({ remoteModels: async () => [expired], now: NIGHT_SH })
    expect('badge' in rowOf(await adapter.listModels('buddy'), 'glm-5.2')).toBe(false)
    // 反向对照：同一条活动、有效期还没到点 ⇒ 必须画得出来（否则上面是恒真）。
    const live: BuddyRemoteModel = {
      ...expired,
      promos: expired.promos!.map((p) => ({
        ...p, schedule: { timezone: 'Asia/Shanghai', validUntil: Date.parse('2026-12-15T16:00:00Z') },
      })),
    }
    const liveAdapter = makeBuddyAdapter({ remoteModels: async () => [live], now: NIGHT_SH })
    expect(rowOf(await liveAdapter.listModels('buddy'), 'glm-5.2').badge)
      .toEqual({ text: '限时免费', tone: 'neutral' })
  })

  it('★★ 持久化往返的第二入口：validUntil 落成字符串时**判为不在窗口内**', async () => {
    // 与 clockMinute 的类型闸门同规（issue #139 那条路）。这条不是假想：
    // 落盘缓存是第二个入口，那条路上没有任何东西做类型检查。
    // 关键危险方向：nowMs < '2026-…' 两侧都是 NaN 比较 ⇒ 恒 false ⇒
    // 「已结束」会被读成「没结束」，一个过期活动继续挂徽标 —— 而挡住它正是
    // 本函数的唯一职责（issue #101 点名的事故形态）。
    const poisoned = {
      id: 'trial', source: 'promotion' as const, modelIds: ['glm-5.2'],
      badge: { label: '限时免费', display: 'activeOnly' as const },
      schedule: { timezone: 'Asia/Shanghai', validUntil: '2026-11-16T00:00:00+08:00' },
      timeDeclared: true, standingEligible: true, priority: 200,
    }
    const adapter = makeBuddyAdapter({
      remoteModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2', promos: [poisoned as never] }],
      now: NIGHT_SH,
    })
    expect('badge' in rowOf(await adapter.listModels('buddy'), 'glm-5.2')).toBe(false)
    // 反向对照：同一份条目、界值是合法 number ⇒ 必须画得出来（否则上面是恒假）。
    const numeric = {
      ...poisoned,
      schedule: { timezone: 'Asia/Shanghai', validUntil: Date.parse('2026-12-16T00:00:00+08:00') },
    }
    const okAdapter = makeBuddyAdapter({
      remoteModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2', promos: [numeric as never] }],
      now: NIGHT_SH,
    })
    expect(rowOf(await okAdapter.listModels('buddy'), 'glm-5.2').badge)
      .toEqual({ text: '限时免费', tone: 'neutral' })
  })

  it('★★ 边界访问器读的是**已落地的目录**：有窗口给时刻，没窗口给 undefined', async () => {
    // 这是「保鲜腿」在 buddy 侧唯一的取数点（接线层按它排定时器）。
    // 变异：把它改成恒 return undefined ⇒ 本条红。此前它**没有牙**：
    // 接线守卫那两组用的是替身 getter，根本不会走到真实实现。
    const adapter = makeBuddyAdapter({ remoteModels: async () => [remoteGlm(true)], now: DAY_SH })
    await adapter.listModels('buddy') // 目录在这里落地（同步读字段，不 await 就是 undefined）
    // 窗口 23:00–7:50 Asia/Shanghai，此刻 08:00 ⇒ 下一个边界是今晚 23:00 = 15:00Z。
    expect(adapter.nextPromotionEdgeAt(Date.parse('2026-11-17T00:00:00Z')))
      .toBe(Date.parse('2026-11-17T15:00:00Z'))
    // ⚠️ 时刻必须真的参与（否则上一条是「恒返回某个数」）。
    expect(adapter.nextPromotionEdgeAt(Date.parse('2026-11-17T15:30:00Z')))
      .toBe(Date.parse('2026-11-17T23:50:00Z'))

    // 没有活动的目录 ⇒ undefined（未登录/上游没活动都不该空转）。
    const bare = makeBuddyAdapter({ remoteModels: async () => [remoteGlm(false)], now: DAY_SH })
    await bare.listModels('buddy')
    expect(bare.nextPromotionEdgeAt(Date.parse('2026-11-17T00:00:00Z'))).toBeUndefined()
  })

  it('⚠️ badge 不进 resolveModel（宿主契约：exact-route resolution omits it）', async () => {
    const adapter = makeBuddyAdapter({ remoteModels: async () => [remoteGlm(true)], now: NIGHT_SH })
    const resolved = await adapter.resolveModel('buddy', 'glm-5.2')
    expect('badge' in resolved).toBe(false)
    // 而 name 必须是裸名（不带倍率后缀，更不带徽标）—— 既有约定，不许因本改动漂移。
    expect(resolved.name).toBe('GLM-5.2')
  })
})

describe('★ Qoder：目录自带 promotion 的行挂徽标', () => {
  function makeQoderAdapter(
    entries: readonly QoderFallbackModel[],
    now: () => number,
    warn?: (message: string) => void,
  ): QoderAdapter {
    return new QoderAdapter({
      credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      product: { ...QODER, fallbackModels: entries } as never,
      trafficGuardEnabled: () => false,
      now,
      ...warn === undefined ? {} : { warn },
      accountPool: {
        hasLoggedInAccount: async () => true,
        disabledModelsFor: () => new Set<string>(),
      } as never,
    } as never)
  }

  const nightEntry: QoderFallbackModel = {
    id: 'qmodel_38max',
    name: 'Qwen3.8-Max',
    contextWindow: 1_000_000,
    priceFactor: 0.2,
    promotion: {
      // ⚠️ 快照 false（白天采集的）也必须能在夜里画出来 —— 窗口说了算。
      active: false,
      windowStart: '22:00',
      windowEnd: '08:00',
      badgeZh: '错峰 4 折',
      badgeEn: 'Off-Peak 60% off',
      timezone: 'Asia/Shanghai',
    },
  }

  it('★★ 边界访问器给出窗口开启时刻；没有活动时 undefined（两家都要有牙）', () => {
    // 与 buddy 那条**对称**。变异实测：把本方法改成恒 return undefined 时，
    // 接线守卫（promotion-edge-wiring）三条全绿 —— 它替身掉了 getter，
    // 根本走不到真实实现。故取数点必须有自己的一条，且带反向对照。
    const adapter = makeQoderAdapter([nightEntry], DAY_SH)
    // 窗口 22:00–08:00（Asia/Shanghai），此刻 08:00 ⇒ 下一个边界是今晚 22:00 = 14:00Z。
    expect(adapter.nextPromotionEdgeAt(Date.parse('2026-11-17T00:00:00Z')))
      .toBe(Date.parse('2026-11-17T14:00:00Z'))
    // ⚠️ 时刻必须真的参与（否则上面只是「恒返回某个数」）：窗口内再问，
    // 下一次边界是**明早** 08:00，而不是今天这个已经过去的 14:00Z。
    expect(adapter.nextPromotionEdgeAt(Date.parse('2026-11-17T15:30:00Z')))
      .toBe(Date.parse('2026-11-18T00:00:00Z'))
    // 无 promotion ⇒ 没有排定边界（上游没活动不该空转）。
    const bareEntry: QoderFallbackModel = { ...nightEntry, promotion: undefined }
    expect(makeQoderAdapter([bareEntry], DAY_SH).nextPromotionEdgeAt(Date.parse('2026-11-17T00:00:00Z')))
      .toBeUndefined()
  })
  it('夜里画双语表形态；白天整条不画（宿主徽标没有悬停位可说「几点生效」）', async () => {
    const night = await makeQoderAdapter([nightEntry], NIGHT_SH).listModels('qoder')
    expect(rowOf(night, 'qmodel_38max').badge)
      .toEqual({ text: { en: 'Off-Peak 60% off', zh: '错峰 4 折' }, tone: 'neutral' })
    const day = await makeQoderAdapter([nightEntry], DAY_SH).listModels('qoder')
    expect('badge' in rowOf(day, 'qmodel_38max')).toBe(false)
  })

  it('badge 缺席 ⇒ 不写该键（插件不编文案），但折扣箭头照旧', async () => {
    const bare: QoderFallbackModel = {
      ...nightEntry,
      // 齐备的折扣数据、**没有** badge ⇒ 徽标不画、价格腿仍给箭头。
      promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5 },
    }
    const row = rowOf(await makeQoderAdapter([bare], NIGHT_SH).listModels('qoder'), 'qmodel_38max')
    expect('badge' in row).toBe(false)
    // 折扣箭头照旧：两条腿互不依赖，「没有可显示的文案」不能顺手把价格也弄丢。
    expect(row.name).toContain('x0.5→x0.2')
  })

  it('窗口声明了但读不懂 ⇒ 不画，也不退化成全天', async () => {
    const broken: QoderFallbackModel = {
      ...nightEntry,
      promotion: { active: true, windowStart: '24:30', windowEnd: '08:00', badgeZh: '错峰 4 折' },
    }
    const row = rowOf(await makeQoderAdapter([broken], NIGHT_SH).listModels('qoder'), 'qmodel_38max')
    expect('badge' in row).toBe(false)
  })

  it('★★ 读不懂窗口的告警**每条只播一次**（回调挂在每条目录项上，不去重就是刷屏）', async () => {
    // 参考实现把日志留在解析路径（每次上游文档只跑一遍）来躲开这一格；本家没有
    // 独立解析点（活动就在目录行里），所以去重必须在装配层做。
    // 变异：删掉 promotionWarned 的去重 ⇒ 第二、三次 listModels 也各播一次 ⇒ 本条红。
    const warn = vi.fn()
    const broken: QoderFallbackModel = {
      ...nightEntry,
      promotion: { active: true, windowStart: '24:30', windowEnd: '08:00', badgeZh: '错峰 4 折' },
    }
    const adapter = makeQoderAdapter([broken], NIGHT_SH, warn)
    await adapter.listModels('qoder')
    await adapter.listModels('qoder')
    await adapter.listModels('qoder')
    expect(warn, '同一条读不懂的窗口不该每次 listModels 都播').toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('24:30')

    // 反向对照：**不同**消息各自要播（否则上面只是「恒 1 次」）。
    // ⚠️ 必须换新实例：去重表是实例字段，复用上面那台会把第二条消息也吞掉。
    const warn2 = vi.fn()
    const second: QoderFallbackModel = {
      ...nightEntry,
      id: 'other_model',
      promotion: { active: true, windowStart: '99:00', windowEnd: '08:00', badgeZh: '错峰 2 折' },
    }
    const adapter2 = makeQoderAdapter([broken, second], NIGHT_SH, warn2)
    await adapter2.listModels('qoder')
    expect(warn2, '不同消息不该被同一条去重吞掉').toHaveBeenCalledTimes(2)
  })

  it('⚠️ 无窗口形态信 active 快照：true 画、false 不画（两个方向都要有牙）', async () => {
    const on: QoderFallbackModel = { ...nightEntry, promotion: { active: true, badgeZh: '错峰 2 折' } }
    expect(rowOf(await makeQoderAdapter([on], DAY_SH).listModels('qoder'), 'qmodel_38max').badge)
      .toEqual({ text: '错峰 2 折', tone: 'neutral' })
    const off: QoderFallbackModel = { ...nightEntry, promotion: { active: false, badgeZh: '错峰 2 折' } }
    expect('badge' in rowOf(await makeQoderAdapter([off], DAY_SH).listModels('qoder'), 'qmodel_38max')).toBe(false)
  })
})
