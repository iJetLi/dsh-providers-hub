import { describe, expect, it, vi } from 'vitest'
import { issueMagicrewGatewayKey } from '../../src/magicrew-auth.js'
import { MAGICREW } from '../../src/magicrew-product.js'
import { fetchMagicrewProfile } from '../../src/magicrew-profile.js'
import { fetchMagicrewCatalogModels } from '../../src/magicrew-catalog.js'
import { fetchMagicrewBalance, magicrewApiHeaders } from '../../src/magicrew-credits.js'

/**
 * ★★ 2026-11-04 真机二分实测的**唯一**修复判据：`referer` 必须下发。
 *
 * 同一套头（origin / authorization / organization-code / user-agent 全在）下：
 * - `GET /api/v1/contact/accounts/me/users`：无 referer **403 空 body**，有 **200**
 * - `POST /api/v1/model-gateway/tokens`：无 referer **403 空 body**，有 **200**
 * - `GET /api/v1/quota/points/total` / `GET /api/v1/flows/models`：两种都 200
 *
 * 漏了它的症状是「账号加得进去，但昵称恒回落 displayName + gateway key 恒签发失败」
 * —— 两条 warn 而不是明确的鉴权失败，所以必须由守卫钉住，不能靠读注释。
 *
 * 本文件独立于各模块自己的用例：任何一个生产者在**将来**被复制一份出去忘了带
 * referer，这里都会红（这是本仓库「一份语义三处实现」的历史教训）。
 */

const EXPECTED_REFERER = `${MAGICREW.webOrigin}/`

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** ⚠️ 每调一次给一个新 Response（body 只能读一次，复用作假红）。 */
function fakeFetch(body: unknown, status = 200): typeof fetch
  & { mock: { calls: unknown[][] } } {
  return vi.fn(async () => jsonResponse(body, status)) as unknown as typeof fetch
    & { mock: { calls: unknown[][] } }
}

function headersOf(
  fetchImpl: typeof fetch & { mock: { calls: unknown[][] } },
  index = 0,
): Record<string, string> {
  const call = fetchImpl.mock.calls[index] as [string, { headers: Record<string, string> }]
  return call[1].headers
}

describe('magicrew 请求头必须带 referer（缺了 = 403 空 body）', () => {
  it('★ 账号资料端点（403 直接命中过）', async () => {
    const fetchImpl = fakeFetch({
      code: 1000,
      data: { items: [{ nickname: 'Jet', real_name: 'Jet', phone: '0000000000' }] },
    })
    const profile = await fetchMagicrewProfile({
      jwt: 'jwt-abc',
      organizationCode: 'org-1',
      product: MAGICREW,
      fetchImpl,
    })
    expect(profile.nickname).toBe('Jet')
    expect(headersOf(fetchImpl).referer).toBe(EXPECTED_REFERER)
  })

  it('★ gateway key 签发端点（403 直接命中过）', async () => {
    const fetchImpl = fakeFetch({
      code: 1000,
      data: { api_key: 'sk-x', refresh_token: 'rt-x' },
    })
    await issueMagicrewGatewayKey({
      jwt: 'jwt-abc',
      organizationCode: 'org-1',
      product: MAGICREW,
      fetchImpl,
    })
    expect(headersOf(fetchImpl).referer).toBe(EXPECTED_REFERER)
  })

  it('模型目录端点（实测不校验，但头必须统一 —— 漏了就会被下一次复制漏掉）', async () => {
    const fetchImpl = fakeFetch({ code: 1000, data: { models: [] } })
    await fetchMagicrewCatalogModels({
      jwt: 'jwt-abc',
      organizationCode: '',
      product: MAGICREW,
      fetchImpl,
    })
    expect(headersOf(fetchImpl).referer).toBe(EXPECTED_REFERER)
  })

  it('积分端点（同上）', async () => {
    const fetchImpl = fakeFetch({
      code: 1000,
      data: { total_points: 1200, organization_total_points: 1200 },
    })
    await fetchMagicrewBalance({
      jwt: 'jwt-abc',
      organizationCode: '',
      product: MAGICREW,
      fetchImpl,
    })
    expect(headersOf(fetchImpl).referer).toBe(EXPECTED_REFERER)
  })

  it('★ `magicrewApiHeaders` 这一个集中出口也带（签到等复用方全靠它）', () => {
    const headers = magicrewApiHeaders({
      jwt: 'jwt-abc',
      organizationCode: 'org-1',
      product: MAGICREW,
    })
    expect(headers.referer).toBe(EXPECTED_REFERER)
    // ⚠️ 与 origin 同源同站：referer 必须是**网页 origin**，不是 API host
    //    （`i-magic-service.letsmagic.cn` 会被 WAF 当成外站来源）。
    expect(headers.referer.startsWith(new URL(MAGICREW.host).origin)).toBe(false)
  })

  it('★ 尾斜杠是照浏览器真实请求抄的形态（去掉斜杠不是等价写法）', () => {
    const headers = magicrewApiHeaders({
      jwt: 'jwt-abc',
      organizationCode: '',
      product: MAGICREW,
    })
    expect(headers.referer).toBe(`${MAGICREW.webOrigin}/`)
    expect(headers.referer.endsWith('/')).toBe(true)
  })
})
