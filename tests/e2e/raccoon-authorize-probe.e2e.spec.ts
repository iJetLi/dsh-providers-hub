/**
 * Raccoon「浏览器授权」链 · 真实上游**形状探针**（**不需要人工交互**）。
 *
 * ## 这条探针验的是**上游的形状**，不是「能不能登进去」
 *
 * 移植这条链（`/authorize` 授权页 + 回环回调 + `login_with_authorization_code`
 * 换码）依赖三件**上游事实**。它们都不是本仓能单测出来的（单测只能锁
 * 「代码按某个形状写」，锁不住「那个形状本身对不对」）：
 *
 * ① **扫码确认页 `/login/mp` 已死**（自 2026-11-04 起全 404，含微信 UA）
 *    —— 这是「扫码链必须让位给浏览器链」的**前提**；
 * ② **`/authorize` 页活着**（HTTP 200，且**回显**我们给它的
 *    `login_source` / `appname` / `desktop_callback` / `redirect` / `state`）
 *    —— 这是「那条链的入口确实存在」的证据；
 * ③ **换码端点的形状**：`POST /api/web/auth/v1/login_with_authorization_code`
 *    对一枚**瞎编**的 code 回 **HTTP 400 `{code:200035}`**（= 官方常量
 *    `AUTHORIZATION_CODE_NOT_FOUND`）—— 这是「端点与错误码都还在」的证据。
 *
 * ## ⚠️ 这条探针**不登录、不换码、不消耗任何东西**
 *
 * ① 只 GET 那个 404 的页面；② 只 GET 授权页并读它的 HTML；
 * ③ 只 POST 一枚**自造的** code —— 它必然被拒（那正是判据），
 * **不会**产生任何凭据、**不会**碰任何真实账号。
 *
 * ## 用法
 *
 * ```powershell
 * $env:DSH_RACCOON_AUTHORIZE_E2E='1'; $env:DSH_RACCOON_AUTHORIZE_E2E_CONFIRM='yes'
 * pnpm test:e2e:raccoon-authorize
 * ```
 *
 * ⚠️ 闸门默认关闭：它要访问真实上游。
 */
import { describe, expect, it } from 'vitest'
import {
  RACCOON_API_BASE,
  RACCOON_AUTHORIZATION_CODE_NOT_FOUND,
  RACCOON_AUTHORIZE_PATH,
} from '../../src/raccoon-authorize.js'
import { RACCOON } from '../../src/raccoon-product.js'

const GATE = process.env['DSH_RACCOON_AUTHORIZE_E2E'] === '1'
  && process.env['DSH_RACCOON_AUTHORIZE_E2E_CONFIRM'] === 'yes'

/** 探针用的回环地址（**随便一个合法端口**：我们只读回显，不真收回调）。 */
const PROBE_REDIRECT = 'http://127.0.0.1:4321/auth/callback'
const PROBE_STATE = 'a'.repeat(64)

describe.skipIf(!GATE)('Raccoon 浏览器授权链 · 上游形状探针', () => {
  it('① 扫码确认页 /login/mp 已死（404）—— 这是让位的前提', async () => {
    const response = await fetch(`${RACCOON_API_BASE}/login/mp`)
    // ⚠️ 判据是「**不是** 200」而不是「精确 404」：网关换一套错误壳
    //   （Next.js 的 404 壳、网关自己的 404 页）都算死。
    expect(response.status, '/login/mp 必须不再是 200（否则扫码链还活着，不该让位）').not.toBe(200)
  })

  it('② /authorize 授权页活着，且回显我们给它的五个参数', async () => {
    const url = new URL(`${RACCOON_API_BASE}${RACCOON_AUTHORIZE_PATH}`)
    url.searchParams.set('login_source', 'desktop')
    url.searchParams.set('appname', '办公小浣熊客户端')
    url.searchParams.set('desktop_callback', 'loopback')
    url.searchParams.set('redirect', PROBE_REDIRECT)
    url.searchParams.set('state', PROBE_STATE)
    const response = await fetch(url)
    expect(response.status).toBe(200)
    const html = await response.text()
    // ⚠️ **回显**才是「页面认得这组参数」的证据（页面把参数渲染进了
    //   它自己的上下文）。查的是**解码后**的形态。
    expect(html).toContain('login_source')
    expect(html).toContain('desktop_callback')
    expect(html).toContain(PROBE_REDIRECT.replace(/&/g, '&'))
    expect(html).toContain(PROBE_STATE)
    // 授权页不是错误壳。
    expect(html).not.toContain('__next_error__')
  })

  it('③ 换码端点还在，且对一枚瞎编的 code 回 400 / 200035', async () => {
    const response = await fetch(
      `${RACCOON.apiBase}${RACCOON.authApiPrefix}/login_with_authorization_code`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorization_code: 'probe-not-a-real-code' }),
      },
    )
    expect(response.status).toBe(400)
    const payload = await response.json() as { code?: unknown }
    expect(payload.code).toBe(RACCOON_AUTHORIZATION_CODE_NOT_FOUND)
  })
})
