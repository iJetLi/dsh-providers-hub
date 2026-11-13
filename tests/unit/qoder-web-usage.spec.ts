import { describe, expect, it, vi } from 'vitest'
import { claimQoderCampaign, fetchQoderBalanceDetailed } from '../../src/qoder-credits.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/qoder.js'
import {
  fetchQoderWebPackages,
  loadQoderWebStore,
  normalizeCookieInput,
  parseQoderWebUsage,
  recordQoderGrants,
  saveQoderWebStore,
  splitAddOnQuota,
  withQoderAddOnDetail,
  type QoderWebCredentials,
} from '../../src/qoder-web-usage.js'
import type { CreditPackage } from '../../src/credits.js'

const cred: QoderCredential = buildQoderCredential(
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref' }), { machineId: 'm-1' })

const DAY = 86_400_000
const NOW = Date.parse('2026-11-14T00:00:00Z')

/** 网页明细响应（字段取自 qoder-trae-workbuddy-switch 的 2026-10-27 真机样本）。 */
function webBody(details: unknown[] | null, extra: Record<string, unknown> = {}) {
  return {
    user_id: 'u-1',
    quota_key: 'big_model_credits',
    status: 'active',
    plan_quota: {
      quota_summary: { used_value: 0, limit_value: 0, remaining_value: 0, unit: 'credits' },
      quota_detail: [{ id: 'p', limit_value: 0, used_value: 0, remaining_value: 0, expires_at: 0, source: 'PLAN', status: 'ACTIVE' }],
    },
    resource_package_quota: {
      quota_summary: { used_value: 0, limit_value: 600, remaining_value: 600, unit: 'credits' },
      quota_detail: details,
    },
    total_quota: {
      quota_summary: { used_value: 0, limit_value: 600, remaining_value: 600, unit: 'credits' },
      quota_detail: [{ id: 'p', limit_value: 0, used_value: 0, remaining_value: 0, expires_at: 0, source: 'PLAN', status: 'ACTIVE' }],
    },
    ...extra,
  }
}

function addOn(remaining: number): CreditPackage {
  return {
    name: '资源包', unit: 'credits', remaining, total: remaining, used: 0, active: true,
    cycleStartTime: '', cycleEndTime: '', expiredTime: '', expiryUnknown: true,
  }
}

function memoryCredentials(): QoderWebCredentials & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    resolve: async (ref) => {
      const value = data.get(String(ref))
      return value === undefined ? undefined : { value }
    },
    set: async (ref, value) => { data.set(String(ref), value) },
    unset: async (ref) => { data.delete(String(ref)) },
  }
}

describe('parseQoderWebUsage', () => {
  it('只取个人资源包，过滤用完/失效的，秒级 expires_at 换算成毫秒', () => {
    const packages = parseQoderWebUsage(webBody([
      { limit_value: 100, used_value: 0, remaining_value: 100, is_active: true, expires_at: 1795595404000, source: 'RESOURCE_PACKAGE_SOURCE_BONUS', status: 'ACTIVE' },
      { limit_value: 200, used_value: 12.5, remaining_value: 187.5, is_active: true, expires_at: 1795595404, source: 'RESOURCE_PACKAGE_SOURCE_BONUS', status: 'ACTIVE' },
      { limit_value: 300, used_value: 300, remaining_value: 0, is_active: false, expires_at: 0, source: 'RESOURCE_PACKAGE_SOURCE_BONUS', status: 'EXPIRED' },
    ]))
    expect(packages).toEqual([
      { remaining: 100, total: 100, used: 0, expiresAtMs: 1795595404000 },
      { remaining: 187.5, total: 200, used: 12.5, expiresAtMs: 1795595404000 },
    ])
  })

  it('quota_detail 为 null ⇒ 空数组（有响应但没有包），不是形状错误', () => {
    expect(parseQoderWebUsage(webBody(null))).toEqual([])
  })

  it('不是明细响应 ⇒ undefined', () => {
    expect(parseQoderWebUsage({ foo: 1 })).toBeUndefined()
    expect(parseQoderWebUsage([])).toBeUndefined()
  })
})

describe('splitAddOnQuota', () => {
  it('网页明细：按日合并、按到期排序，守恒等于 sash 余额', () => {
    const parts = splitAddOnQuota(addOn(300), {
      kind: 'web',
      packages: [
        { remaining: 100, total: 100, used: 0, expiresAtMs: NOW + 3 * DAY },
        { remaining: 100, total: 100, used: 0, expiresAtMs: NOW + 1 * DAY },
        { remaining: 100, total: 100, used: 0, expiresAtMs: NOW + 1 * DAY + 1000 },
      ],
    })!
    expect(parts.map((p) => [p.remaining, p.deductionEndTime])).toEqual([
      [200, NOW + 1 * DAY],
      [100, NOW + 3 * DAY],
    ])
    expect(parts.every((p) => p.expiryUnknown !== true)).toBe(true)
    expect(parts.reduce((s, p) => s + p.remaining, 0)).toBe(300)
  })

  it('明细合计多于 sash 余额 ⇒ 按先到期先扣削掉最早的', () => {
    const parts = splitAddOnQuota(addOn(150), {
      kind: 'web',
      packages: [
        { remaining: 100, total: 100, used: 0, expiresAtMs: NOW + 1 * DAY },
        { remaining: 100, total: 100, used: 0, expiresAtMs: NOW + 5 * DAY },
      ],
    })!
    expect(parts.map((p) => [p.remaining, p.deductionEndTime])).toEqual([
      [50, NOW + 1 * DAY],
      [100, NOW + 5 * DAY],
    ])
  })

  it('领取记录：剩余归给最晚到期的几笔，不足部分仍标「到期未知」，名字注明推算', () => {
    const parts = splitAddOnQuota(addOn(250), {
      kind: 'ledger',
      nowMs: NOW,
      grants: [
        { amount: 100, expiresAtMs: NOW - DAY }, // 已过期，忽略
        { amount: 100, expiresAtMs: NOW + 10 * DAY },
        { amount: 100, expiresAtMs: NOW + 20 * DAY },
      ],
    })!
    expect(parts.map((p) => [p.name, p.remaining, p.expiryUnknown === true])).toEqual([
      ['资源包（按领取记录推算）', 100, false],
      ['资源包（按领取记录推算）', 100, false],
      ['资源包', 50, true],
    ])
  })

  it('没有任何可用日期 ⇒ undefined（保留原整包）', () => {
    expect(splitAddOnQuota(addOn(100), { kind: 'ledger', nowMs: NOW, grants: [] })).toBeUndefined()
    expect(splitAddOnQuota(addOn(100), {
      kind: 'web', packages: [{ remaining: 100, total: 100, used: 0, expiresAtMs: 0 }],
    })).toBeUndefined()
  })
})

describe('normalizeCookieInput', () => {
  it('接受裸 Cookie、Cookie: 行与 cURL', () => {
    expect(normalizeCookieInput('a=1; b=2')).toBe('a=1; b=2')
    expect(normalizeCookieInput('Cookie: a=1; b=2\nAccept: x')).toBe('a=1; b=2')
    expect(normalizeCookieInput(`curl 'https://qoder.com/api' -H 'accept: x' -H 'cookie: a=1; b=2'`)).toBe('a=1; b=2')
    expect(normalizeCookieInput(`curl "https://qoder.com/api" -b "a=1; b=2"`)).toBe('a=1; b=2')
    expect(normalizeCookieInput('   ')).toBe('')
  })
})

describe('fetchQoderWebPackages', () => {
  it('中国版先试 qoder.com.cn，404 再试 qoder.cn；带 Cookie 与 Referer', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://qoder.com.cn')) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify(webBody([])), { status: 200 })
    })
    const result = await fetchQoderWebPackages('sid=x', QODER_CN, fetcher as unknown as typeof fetch)
    expect(result).toEqual({ ok: true, packages: [] })
    expect(fetcher.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://qoder.com.cn/api/v2/me/usages/big_model_credits',
      'https://qoder.cn/api/v2/me/usages/big_model_credits',
    ])
    const init = fetcher.mock.calls[1]![1] as RequestInit
    expect((init.headers as Record<string, string>).Cookie).toBe('sid=x')
    expect((init.headers as Record<string, string>).Referer).toBe('https://qoder.cn/account/usage')
  })

  it('401 ⇒ authFailed，原因里不含 Cookie', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 401 }))
    const result = await fetchQoderWebPackages('secret-cookie=1', QODER, fetcher as unknown as typeof fetch)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.authFailed).toBe(true)
      expect(result.reason).not.toContain('secret-cookie')
    }
  })
})

describe('网页会话存储与领取记录', () => {
  it('记录领取：去重、丢弃过期；清除 Cookie 不丢领取记录；全空时删除条目', async () => {
    const creds = memoryCredentials()
    await recordQoderGrants(creds, 'qoder_a', [
      { amount: 100, expiresAtMs: NOW + 5 * DAY },
      { amount: 100, expiresAtMs: NOW - DAY },
    ], NOW)
    await recordQoderGrants(creds, 'qoder_a', [{ amount: 100, expiresAtMs: NOW + 5 * DAY }], NOW)
    expect((await loadQoderWebStore(creds, 'qoder_a')).grants).toEqual([{ amount: 100, expiresAtMs: NOW + 5 * DAY }])

    await saveQoderWebStore(creds, 'qoder_a', { ...await loadQoderWebStore(creds, 'qoder_a'), cookie: 'sid=1' })
    const { cookie: _c, ...rest } = await loadQoderWebStore(creds, 'qoder_a')
    await saveQoderWebStore(creds, 'qoder_a', rest)
    expect(await loadQoderWebStore(creds, 'qoder_a')).toEqual({ grants: [{ amount: 100, expiresAtMs: NOW + 5 * DAY }] })

    await saveQoderWebStore(creds, 'qoder_a', {})
    expect(creds.data.size).toBe(0)
  })
})

describe('与积分查询 / 领取的接线', () => {
  it('查完余额再拆：资源包拆成带日期的包，合计不变', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      displayMode: 'qoder',
      qoderUsage: {
        expiresAt: 253402214400000,
        userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
        addOnQuota: { total: 200, used: 0, remaining: 200, unit: 'credits' },
      },
    }), { status: 200 }))
    const detailed = await fetchQoderBalanceDetailed(cred, QODER, { fetcher: fetcher as unknown as typeof fetch })
    const balance = withQoderAddOnDetail(detailed.balance, {
      kind: 'ledger', nowMs: NOW, grants: [{ amount: 100, expiresAtMs: NOW + DAY }, { amount: 100, expiresAtMs: NOW + 2 * DAY }],
    })
    expect(balance!.total).toBe(200)
    const addOnParts = balance!.packages.filter((p) => p.name.startsWith('资源包'))
    expect(addOnParts.map((p) => p.deductionEndTime)).toEqual([NOW + DAY, NOW + 2 * DAY])
  })

  it('没有到期来源 ⇒ 行为不变（一整包到期未知）', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      displayMode: 'qoder',
      qoderUsage: { addOnQuota: { total: 200, used: 0, remaining: 200, unit: 'credits' } },
    }), { status: 200 }))
    const { balance: raw } = await fetchQoderBalanceDetailed(cred, QODER, { fetcher: fetcher as unknown as typeof fetch })
    const balance = withQoderAddOnDetail(raw, undefined)
    expect(balance).toBe(raw)
    expect(balance!.packages).toHaveLength(1)
    expect(balance!.packages[0]!.expiryUnknown).toBe(true)
  })

  it('领取成功 ⇒ 结果带上本笔的到期；重复领取不带', async () => {
    const claimed = vi.fn(async () => new Response(JSON.stringify({
      status: 'CLAIMED', replayed: false,
      benefit: { kind: 'CREDITS', amount: 100 },
      expiresAt: '2026-12-14T02:00:00.000Z',
    }), { status: 200 }))
    const outcome = await claimQoderCampaign(cred, QODER, 'c-1', claimed as unknown as typeof fetch)
    expect(outcome).toMatchObject({
      kind: 'claimed', credit: 100,
      grants: [{ amount: 100, expiresAtMs: Date.parse('2026-12-14T02:00:00.000Z') }],
    })

    const replayed = vi.fn(async () => new Response(JSON.stringify({
      status: 'CLAIMED', replayed: true, expiresAt: '2026-12-01T00:00:00.000Z',
    }), { status: 200 }))
    const again = await claimQoderCampaign(cred, QODER, 'c-1', replayed as unknown as typeof fetch)
    expect(again.kind).toBe('already-claimed')
  })
})
