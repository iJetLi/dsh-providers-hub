/**
 * ★★ AutoClaw（国际版）**必须有可用的登录入口**（2026-11-02 用户报障）。
 *
 * ## 报障现场
 *
 * 「AutoClaw（国际版）账号管理」点「+」新建账号，弹窗里只有**一个**选项
 * 「⚡ 一键导入本机桌面端凭据」，而说明文字同时写着「或使用手机短信验证码快速登录」
 * —— 文案承诺的第二个选项根本不存在。用户本机没装客户端 ⇒ 唯一那条路也走不通
 * ⇒ **国际版完全无法添加账号**。
 *
 * ## 为什么短信对国际版不可用（这不是缺陷，是事实）
 *
 * 国际版后端**也接受**短信（`/userapi/v1/agent-send-code` 在国际基址回 `code=0`），
 * 但国际账号是**邮箱 + OAuth 创建**的：`account-profile.json` 里 `phone: null`，
 * 且**没有绑手机号的端点**（`agent-bind-phone` / `bind-phone` 全 404）。
 * ⇒ 短信对国际账号必然失败。依据见 `src/autoclaw-product.ts` 的
 * 「为什么是两个 provider」表与 `src/autoclaw-oauth.ts` 的文件头。
 *
 * ## 真正的缺陷：Z.ai OAuth 这条路是**死代码**
 *
 * `buildZaiAuthUrl()` / `loginWithZaiCode()` / `AUTOCLAW_OAUTH_CALLBACK_PATH`
 * 三样都写了，但**零调用方**：本地登录服务的路由只有
 * `GET /autoclaw/login`、`POST /autoclaw/send-code`、`POST /autoclaw/submit-code`、
 * `POST /autoclaw/import-local` —— **没有回调路由**；
 * 登录页 HTML 写死国内形态（短信 + 一键读本机），**不区分站点**。
 *
 * ## 判据分三层（每层都能单独打红）
 *
 * 1. **登录页按站点渲染** —— 国际版含 Z.ai 授权链接、不含手机号输入框；国内版反之。
 * 2. **回调闭环真跑** —— 起真 flow、真请求登录页、取授权 URL 里的 `redirect_uri`、
 *    真打回调，断言 `settleOk` 拿到凭据**且**换 token 时的 `navigate_uri` 与授权时
 *    逐字节相同（OAuth 的硬要求，写错就是 `631001`）。
 * 3. **客户端入口** —— 国际版渲染 `zai` 选项、国内版渲染 `sms` 选项，两者不得同时出现。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { AUTOCLAW, AUTOCLAW_INTL } from '../../src/autoclaw-product.js'
import {
  AUTOCLAW_OAUTH_CALLBACK_PATH,
  startAutoclawSmsLoginFlow,
} from '../../src/autoclaw-oauth.js'

const live: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  while (live.length > 0) await live.pop()!.close()
})

/** 假上游：只认 Z.ai 换 token 端点，返回一份可控凭据。 */
function makeFakeFetch(capture: { bodies: Array<Record<string, unknown>> }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input)
    if (url.includes('/userapi/overseasv1/zai-oauth-login')) {
      capture.bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({
        code: 0,
        data: {
          access_token: 'zai-access-token',
          refresh_token: 'zai-refresh-token',
          expires_in: 3600,
          user_id: 'u-1',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('unexpected endpoint: ' + url, { status: 500 })
  }) as unknown as typeof fetch
}

describe('★★ AutoClaw 国际版：Z.ai OAuth 登录入口（此前是死代码）', () => {
  it('★★ 国际版登录页必须给 Z.ai 授权链接，且**不得**出现手机号输入框', async () => {
    const flow = await startAutoclawSmsLoginFlow({
      product: AUTOCLAW_INTL, fetchImpl: makeFakeFetch({ bodies: [] }), deviceId: 'dev-test', timeoutMs: 5_000,
    })
    live.push(flow)
    const page = await (await fetch(flow.loginUrl)).text()

    expect(page, '国际版页面必须有 Z.ai 授权入口').toContain('chat.z.ai')
    expect(page, 'Z.ai 是浏览器跳转，必须是 <a href> 而不是一个死按钮').toMatch(/href="https:\/\/chat\.z\.ai\/auth/)
    expect(page, '国际账号没有绑定手机号，短信表单只会让用户白试一次').not.toContain('id="phone"')
    expect(page).not.toContain('id="btnSend"')
  })

  it('★ 对照：国内版登录页仍是短信，且**不得**出现 Z.ai', async () => {
    const flow = await startAutoclawSmsLoginFlow({
      product: AUTOCLAW, fetchImpl: makeFakeFetch({ bodies: [] }), deviceId: 'dev-test', timeoutMs: 5_000,
    })
    live.push(flow)
    const page = await (await fetch(flow.loginUrl)).text()
    expect(page).toContain('id="phone"')
    expect(page).toContain('id="btnSend"')
    expect(page, '国内版不该出现 Z.ai（那会让用户以为国内也能 OAuth）').not.toContain('chat.z.ai')
  })

  it('★★ 回调闭环：授权 URL 里的 redirect_uri 必须与换 token 的 navigate_uri **逐字节相同**', async () => {
    const capture = { bodies: [] as Array<Record<string, unknown>> }
    const flow = await startAutoclawSmsLoginFlow({
      product: AUTOCLAW_INTL,
      fetchImpl: makeFakeFetch(capture),
      deviceId: 'dev-test',
      timeoutMs: 5_000,
    })
    live.push(flow)

    // 1) 从登录页里取授权 URL（= 用户点了「使用 Z.ai 账号继续」会去的地方）
    const page = await (await fetch(flow.loginUrl)).text()
    const href = /href="(https:\/\/chat\.z\.ai\/auth[^"]*)"/.exec(page)?.[1]
    expect(href, '登录页里找不到 Z.ai 授权链接 ⇒ 国际版又只能靠一键导入了').toBeDefined()
    const authUrl = new URL(href!.replace(/&amp;/g, '&'))
    const redirectUri = authUrl.searchParams.get('redirect_uri')
    expect(redirectUri, 'OAuth 必须带 redirect_uri').toBeTruthy()
    expect(redirectUri).toContain(AUTOCLAW_OAUTH_CALLBACK_PATH)
    expect(authUrl.searchParams.get('client_id')).toBeTruthy()

    // 2) 真打回调（等价于授权页把用户送回来）
    const callbackRes = await fetch(`${redirectUri}?code=auth-code-1&state=state-abc`)
    const callbackPage = await callbackRes.text()
    expect(callbackPage, '回调失败页会把原因写在页面里').toContain('登录成功')

    // 3) flow 必须 settle 出凭据
    const settled = await flow.result
    expect(settled.credential.access_token).toBe('zai-access-token')

    // 4) 关键：换 token 时的 navigate_uri 与授权时**逐字节相同**
    expect(capture.bodies, '换 token 请求没打出去').toHaveLength(1)
    expect(capture.bodies[0].code).toBe('auth-code-1')
    expect(capture.bodies[0].state, 'state 必须原样透传（不解析、不重建）').toBe('state-abc')
    expect(capture.bodies[0].navigate_uri, 'OAuth 要求两次的 redirect 逐字节相同，否则上游回 631001').toBe(redirectUri)
  })

  it('★ 回调失败（上游拒绝）时**不得**结束整个 flow —— 用户还能回登录页重试', async () => {
    const failingFetch = (async () => new Response(JSON.stringify({
      code: 631001, msg: 'User login error',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const flow = await startAutoclawSmsLoginFlow({
      product: AUTOCLAW_INTL, fetchImpl: failingFetch, deviceId: 'dev-test', timeoutMs: 5_000,
    })
    live.push(flow)

    const page = await (await fetch(flow.loginUrl)).text()
    const href = /href="(https:\/\/chat\.z\.ai\/auth[^"]*)"/.exec(page)?.[1]!
    const redirectUri = new URL(href.replace(/&amp;/g, '&')).searchParams.get('redirect_uri')!
    const callbackPage = await (await fetch(`${redirectUri}?code=bad&state=s`)).text()

    expect(callbackPage).toContain('授权失败')
    // flow 仍处于 pending —— 用「race 到超时标记」证明它没有 reject
    const stillPending = await Promise.race([
      flow.result.then(() => 'settled').catch(() => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 120)),
    ])
    expect(stillPending, '回调失败就 settleErr 会让用户连重试都不行').toBe('pending')
  })
})

describe('★★ AutoClaw 国际版：客户端入口（面板源码）', () => {
  it('★★ 国际版必须渲染 zai 选项、国内版必须渲染 sms 选项，且互斥', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('plugin-src/client/jet-hub.js', 'utf8')

    expect(source, '站点判据必须按 provider 分').toContain("const autoclawZaiAvailable = provider === 'autoclawintl';")
    // ⚠️⚠️ **必须锚定整段**，不能只断言 `value: 'zai'`：`jet-hub.js` 里 zcode 的登录
    //    渠道也有一处 `{ value: 'zai', label: '🌐 z.ai（chat.z.ai，国际版）' }`
    //    ⇒ 裸断言会被它兜住（实测：把 autoclaw 的选项值改成 `zai-disabled` 后
    //    五条用例**全绿**，判据打偏到 zcode 上去了）。
    expect(source, '国际版的选项值必须是 zai（非 local 才会走 startLogin 打开登录页）')
      .toContain("value: 'zai', label: '🌐 使用 Z.ai 账号登录'")
    expect(source, '国际版文案不得再承诺手机短信（国际账号没绑手机）')
      .toContain('或使用 Z.ai 账号在浏览器中授权登录。')
    // 默认值：国际版落 zai（local 要求本机装了客户端）
    expect(source).toContain("provider === 'autoclawintl' ? 'zai' : 'local'")
  })
})
