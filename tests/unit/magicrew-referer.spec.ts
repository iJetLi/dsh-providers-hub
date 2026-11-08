import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { issueMagicrewGatewayKey } from '../../src/magicrew-auth.js'
import { MAGICREW, MAGICREW_USER_AGENT } from '../../src/magicrew-product.js'
import { fetchMagicrewProfile } from '../../src/magicrew-profile.js'
import { fetchMagicrewCatalogModels } from '../../src/magicrew-catalog.js'
import { fetchMagicrewBalance, magicrewApiHeaders } from '../../src/magicrew-credits.js'
import { MagicrewAdapter } from '../../src/magicrew-adapter.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

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

/**
 * ★★ 2026-11-05 审计返工：**聊天适配器**那一处 referer 原先零守卫。
 *
 * 对抗审计实测：删掉 `magicrew-adapter.ts` 的 `referer`，本文件其余 6 条用例
 * 全绿（它们只覆盖 auth / profile / credits / catalog 四条生产者）⇒
 * PR 声称的「五处生产者一并钉住」不成立。
 *
 * 判据打在行为上：真跑 `stream()`，检查**实际发出的第一个请求头**。
 * ⚠️ 聊天网关实测**不校验** referer（200），但这行存在的理由是「同一上游的
 * 其余端点缺了就 403」⇒ 它属于「统一形态」，必须与那几处同生共死。
 */
describe('★★ 聊天适配器的出站请求也带 referer（审计 P2-3 零守卫）', () => {
  const STREAM_OPTIONS = {
    provider: 'magicrew',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as unknown as GenerateOptions

  it('★ `MagicrewAdapter.stream()` 的首个请求头必须带 referer', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
    ))
    const adapter = new MagicrewAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveCredential: async () => ({
        jwt: 'jwt-abc',
        organizationCode: 'org-1',
        apiKey: 'mgw_key',
      }),
    })
    const texts: string[] = []
    for await (const chunk of adapter.stream(STREAM_OPTIONS)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // ⚠️ 反向对照：必须真的产出内容 —— 否则「fetch 被调用但 stream 提前返回」
    //    这种变异也能绿（2026-11-05 审计 M12）。
    expect(texts.join('')).toBe('ok')
    const call = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(call[1].headers.referer).toBe(EXPECTED_REFERER)
    // 反向对照：同一处必须仍带 origin（别为了加 referer 把 origin 挤掉）。
    expect(call[1].headers.origin).toBe(MAGICREW.webOrigin)
  })
})

/**
 * ★★ 2026-11-08（issue **IKTPRV**）：`User-Agent` 曾被**复制成五份**，值恒为
 * `…Chrome/141.0.0.0 Safari/537.36` —— 而那个串**在上游 WAF 的黑名单上**。
 *
 * 真机取证（同一出口、同一时刻，只改 UA 这一个变量）：
 * - 国际站 `magic-service.magicrew.ai`：常量 UA ⇒ **405**（2657 B 拦截页）；
 *   `Chrome/140.0.0.0` / `142.0.0.0` / `141.0.7390.55` ⇒ **200**。
 * - 国内站 `i-magic-service.letsmagic.cn`：常量 UA ⇒ **403**（0 B）。
 * - **聊天网关一并被拦**（`/v1/chat/completions` 405）⇒ 国际站账号曾经**完全不可用**，
 *   不是「积分面板坏了」。
 * - 判据是**整串精确匹配**：`Chrome/141.0.0.0` 去掉 ` Safari/537.36` 尾就 200；
 *   大小写不敏感、连续空白归一化；`MagicrewDesktop/1.0` / `curl/8.0` **也在名单上**
 *   ⇒ 「换成自家 UA」不是出路。全零 build 的假版本号正是被收录的形态。
 *
 * ⚠️ 本文件此前的 7 条 referer 用例**一条都不看 user-agent**（`grep 141.0.0.0 tests/`
 * 零命中）⇒ 五份副本任何一份被改坏都不会红。下面三条把这条腿钉住，判据分两层：
 * ① **行为级**（五个生产者实际发出的头）② **值级**（常量本身不得是名单上的形态）
 * ③ **源码级**（五份副本不许复活）。
 */
describe('★★ 出站 User-Agent 必须全仓一份，且不得是 WAF 黑名单上的形态（IKTPRV）', () => {
  const STREAM_OPTIONS = {
    provider: 'magicrew',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as unknown as GenerateOptions

  /**
   * 五个生产者的**实际出站** UA 逐个取出来比对。
   *
   * ⚠️ 判据是「五处**彼此相等**且等于常量」——只断言「等于常量」还不够：
   * 若某人把常量本身改坏，五处会一起绿。等值判据 + 下面的值级判据才是完整的。
   */
  it('★ 五个生产者（资料 / gateway / 目录 / 积分 / 集中出口）发出的 UA 逐字相同', async () => {
    const collected: Array<[string, string | undefined]> = []

    const profileFetch = fakeFetch({ code: 1000, data: { items: [{ nickname: 'J' }] } })
    await fetchMagicrewProfile({
      jwt: 'jwt-abc', organizationCode: 'org-1', product: MAGICREW, fetchImpl: profileFetch,
    })
    collected.push(['profile', headersOf(profileFetch)['user-agent']])

    const keyFetch = fakeFetch({ code: 1000, data: { api_key: 'k', refresh_token: 'r' } })
    await issueMagicrewGatewayKey({
      jwt: 'jwt-abc', organizationCode: 'org-1', product: MAGICREW, fetchImpl: keyFetch,
    })
    collected.push(['gatewayKey', headersOf(keyFetch)['user-agent']])

    const catalogFetch = fakeFetch({ code: 1000, data: { models: [] } })
    await fetchMagicrewCatalogModels({
      jwt: 'jwt-abc', organizationCode: '', product: MAGICREW, fetchImpl: catalogFetch,
    })
    collected.push(['catalog', headersOf(catalogFetch)['user-agent']])

    const creditsFetch = fakeFetch({
      code: 1000, data: { total_points: 1, organization_total_points: 1 },
    })
    await fetchMagicrewBalance({
      jwt: 'jwt-abc', organizationCode: '', product: MAGICREW, fetchImpl: creditsFetch,
    })
    collected.push(['credits', headersOf(creditsFetch)['user-agent']])

    collected.push(['apiHeaders', magicrewApiHeaders({
      jwt: 'jwt-abc', organizationCode: 'org-1', product: MAGICREW,
    })['user-agent']])

    for (const [where, ua] of collected) {
      expect(ua, `${where} 必须下发 user-agent`).toBeDefined()
      expect(ua, `${where} 的 UA 必须等于 MAGICREW_USER_AGENT（不得再有本地副本）`)
        .toBe(MAGICREW_USER_AGENT)
    }
    // 反向对照：五个生产者必须**真的都发了请求**（否则 collected 里是五组 undefined）。
    expect(collected.filter(([, ua]) => ua === undefined), '有生产者压根没发请求').toHaveLength(0)
  })

  it('★ 聊天适配器（第六条出站腿）也必须用同一份 UA', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
    ))
    const adapter = new MagicrewAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveCredential: async () => ({
        jwt: 'jwt-abc', organizationCode: 'org-1', apiKey: 'mgw_key',
      }),
    })
    const texts: string[] = []
    for await (const chunk of adapter.stream(STREAM_OPTIONS)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 反向对照：必须真产出内容（否则「没发请求」也能绿）。
    expect(texts.join('')).toBe('ok')
    const call = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(call[1].headers['user-agent']).toBe(MAGICREW_USER_AGENT)
  })

  /**
   * 值级判据：常量本身不得是**黑名单上的形态**。
   *
   * ⚠️ 这条是 `★` 而不是 `★★`：它挡的是「把常量改回旧值」这一类回归，但**挡不住
   * 「换成一个我们还没实测过的串」**——后者只能靠真机探针，不能靠单测（本仓红线：
   * 别为消警告编造一个「看起来对」的值）。所以注释里必须写清取证日期。
   */
  it('★ 常量不得是 WAF 名单上的那个串，也不得是全零 build 的假版本号', () => {
    // ① 精确排除已知被拒的值（2026-11-08 两站实测，各 3 次一致）。
    expect(MAGICREW_USER_AGENT)
      .not.toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')

    // ② Chrome 版本段必须带真实 build：`x.0.0.0` 这种占位形态正是被收录的形态。
    const chrome = /Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(MAGICREW_USER_AGENT)
    expect(chrome, 'UA 必须带完整的 Chrome 四段版本号').not.toBeNull()
    expect(
      Number(chrome?.[3]) + Number(chrome?.[4]),
      `Chrome 版本段不得是 x.0.0.0 占位形态（当前 ${chrome?.[0]}）`,
    ).toBeGreaterThan(0)

    // ③ 反向对照：`curl` / `MagicrewDesktop` / 空串实测都在拒绝面上，别拿它们当备选。
    expect(MAGICREW_USER_AGENT.toLowerCase()).toContain('mozilla/5.0')
  })

  /**
   * 源码级判据：五份副本**不许复活**。
   *
   * ⚠️ 这条**是辅助判据**（源码文本断言的固有弱点：`if (false)` 包一层照样绿、
   * 换个写法就漏），它存在的唯一理由是「复制粘贴」正是这一族缺陷的**唯一成因**
   * （五份副本就是这么来的）。真正承重的是上面两条行为级断言。
   * ⇒ 判据打在 `Mozilla/5.0`（任何 UA 字面量的必经前缀），不锚 `Chrome/`
   *   （注释里允许出现历史值作对照）。
   */
  it('★ 五个生产者源码里不得再出现 UA 字面量（只许 import 常量）', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const files = [
      'magicrew-adapter.ts',
      'magicrew-auth.ts',
      'magicrew-catalog.ts',
      'magicrew-credits.ts',
      'magicrew-profile.ts',
    ]
    for (const file of files) {
      const source = readFileSync(resolve(here, '../../src', file), 'utf8')
      expect(
        source.includes('Mozilla/5.0'),
        `${file} 里又出现了一份 UA 字面量 —— 改回 import { MAGICREW_USER_AGENT }`,
      ).toBe(false)
    }
  })
})
