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
 * ## 为什么短信对国际版不可用（事实，不是缺陷）
 *
 * 国际版后端**也接受**短信（`/userapi/v1/agent-send-code` 在国际基址回 `code=0`），
 * 但国际账号是**邮箱 + OAuth 创建**的：`account-profile.json` 里 `phone: null`，
 * 且**没有绑手机号的端点**（`agent-bind-phone` / `bind-phone` 全 404）。
 * ⇒ 短信对国际账号必然失败。依据见 `src/autoclaw-product.ts` 的
 * 「为什么是两个 provider」表与 `src/autoclaw-oauth.ts` 的文件头。
 *
 * ## 真正的缺陷：Z.ai OAuth 是**死代码**
 *
 * `buildZaiAuthUrl()` / `loginWithZaiCode()` / `AUTOCLAW_OAUTH_CALLBACK_PATH`
 * 三样都写了但**零调用方**：本地登录服务只有 4 条路由（没有回调），
 * 登录页 HTML 写死国内形态（不区分站点）。
 *
 * ## 判据为什么长这样（每条都对应一次对抗审查打穿）
 *
 * | 判据 | 打穿的形态 |
 * |---|---|
 * | 国际版页 `not.toContain('<input')` + `not.toContain('type="tel"')` | 只断言 `id="phone"` 时，把表单 id 改成 `phoneIntl` 就**假绿** |
 * | `code`/`state` 用**随机 nonce** | 用固定字面量时，实现把值写死在代码里也照样绿（判据打在自己的字面量上） |
 * | 失败 → **再重试一次成功**（确定性） | 「仍 pending」只用 120ms race：抓不到延迟 settle，也分不清「刻意不 settleErr」与「什么都没写」 |
 * | 源码锚点**跨条件展开 + 字面量** | 只锚字面量时，把展开条件换成 `autoclawSmsAvailable`、或把默认值 `useState` 注释掉，全都**假绿** |
 * | 真实用户路径 `new AutoclawAuth(AUTOCLAW_INTL).startLogin()` | 全直接调 flow 函数时，`startLogin` 里把 `product` 写成国内 `AUTOCLAW` **零红**（而那正是报障那条路） |
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { AutoclawAuth } from '../../src/autoclaw-auth.js'
import { AUTOCLAW, AUTOCLAW_INTL } from '../../src/autoclaw-product.js'
import {
  AUTOCLAW_OAUTH_CALLBACK_PATH,
  exchangeAutoclawZaiCode,
  startAutoclawSmsLoginFlow,
} from '../../src/autoclaw-oauth.js'

const live: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  while (live.length > 0) await live.pop()!.close()
})

/** 每次运行都不同的 nonce —— 让「实现把值写死」也能被打红。 */
let nonceSeq = 0
const nonce = (prefix: string): string => {
  nonceSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${nonceSeq}-${Math.random().toString(36).slice(2, 8)}`
}

interface Capture { bodies: Array<Record<string, unknown>> }

/**
 * 假上游：只认 Z.ai 换 token 端点。
 *
 * ⚠️ 桩值**必须 < 16 位**：`tests/unit/repo-pii-guard.spec.ts` 拦「凭据字段名 + ≥16 位高熵字面量」
 *    ⇒ `access_token: 'stub-access'`（11 位）通过，`'stub-access-token'`（17 位）会被拦。
 */
function makeFetcher(capture: Capture, mode: { fail?: boolean; omitExpiry?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input)
    if (url.includes('/userapi/overseasv1/zai-oauth-login')) {
      capture.bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      if (mode.fail === true) {
        return new Response(JSON.stringify({ code: 631001, msg: 'User login error' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      const data: Record<string, unknown> = {
        access_token: 'stub-access',
        refresh_token: 'stub-refresh',
        user_id: 'u-1',
      }
      // ⚠️ 默认给 `expires_in`；`omitExpiry` 用来打「编造 7 天」那一格。
      if (mode.omitExpiry !== true) data.expires_in = 3600
      return new Response(JSON.stringify({ code: 0, data }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('unexpected endpoint: ' + url, { status: 500 })
  }) as unknown as typeof fetch
}

/**
 * ⚠️ **必须从登录页的 `href` 取授权 URL**，不能自己拼 —— 自己拼就绕过了
 * 「实现是否真的把 `redirect_uri` 写进授权链接」这条判据。
 */
function zaiAuthUrlOf(page: string): URL {
  const href = /href="(https:\/\/chat\.z\.ai\/api\/oauth\/authorize[^"]*)"/.exec(page)?.[1]
  if (href === undefined) throw new Error('登录页里没有 Z.ai 授权链接')
  // HTML 属性里的 `&` 允许裸写（HTML5 规则），也兼容转义写法
  return new URL(href.replace(/&amp;/g, '&'))
}

function zaiRedirectUriOf(page: string): string {
  const redirectUri = zaiAuthUrlOf(page).searchParams.get('redirect_uri')
  if (redirectUri === null) throw new Error('授权 URL 里没有 redirect_uri')
  return redirectUri
}

describe('★★ 登录页按站点分裂', () => {
  it('★★ 国际版：给 Z.ai 授权链接，且**整页没有任何 input**（不能只有手机表单换个 id）', async () => {
    const flow = await startAutoclawSmsLoginFlow({
      product: AUTOCLAW_INTL, fetchImpl: makeFetcher({ bodies: [] }), deviceId: 'dev-test', timeoutMs: 5_000,
    })
    live.push(flow)
    const page = await (await fetch(flow.loginUrl)).text()

    expect(page, '国际版必须有 Z.ai 授权入口').toContain('chat.z.ai')
    expect(page, 'Z.ai 是浏览器跳转，必须是 <a href>').toMatch(/href="https:\/\/chat\.z\.ai\/api\/oauth\/authorize\?/)
    // ⚠️⚠️ 授权端点**必须是 `/api/oauth/authorize`**，不能是 `/auth`：后者只是它的前端登录页路由，
    // 只拿 `redirect_uri` 判断「我在 OAuth 流程里」，真正的回跳目标走 `redirect` 参数/sessionStorage
    // ⇒ 直接打开 `/auth` 时用户登录完会落回首页、回调永不发生（2026-11-02 真机报障）。
    expect(page, '`/auth` 是登录页路由，不是授权端点').not.toMatch(/href="https:\/\/chat\.z\.ai\/auth\?/)
    // ⚠️⚠️ `state` **必填**：`/api/oauth/authorize` 缺它直接回 422（实测），
    //    而 `state` 留空时整条流程会在用户登录完成后静默落回首页。判据必须是「非空 + aosi. 前缀」，
    //    不能只断言参数存在（空串也能让 `searchParams.get` 返回 `''`）。
    const authUrl = zaiAuthUrlOf(page)
    expect(authUrl.searchParams.get('response_type'), '必须是授权码模式').toBe('code')
    const state = authUrl.searchParams.get('state') ?? ''
    expect(state.length, '`state` 不得为空（空 state 会让授权端点 422）').toBeGreaterThan(0)
    expect(state.startsWith('aosi.'), '`state` 用官方前缀').toBe(true)
    // ⚠️ 强于 `id="phone"`：换 id 也躲不过
    expect(page, '国际账号没绑手机，页面上不该出现任何输入框').not.toContain('<input')
    expect(page).not.toContain('type="tel"')
    const redirectUri = zaiRedirectUriOf(page)
    expect(redirectUri).toContain(AUTOCLAW_OAUTH_CALLBACK_PATH)
  })

  it('★ 对照：国内版仍是短信表单，且**不得**出现 Z.ai', async () => {
    const flow = await startAutoclawSmsLoginFlow({
      product: AUTOCLAW, fetchImpl: makeFetcher({ bodies: [] }), deviceId: 'dev-test', timeoutMs: 5_000,
    })
    live.push(flow)
    const page = await (await fetch(flow.loginUrl)).text()
    expect(page).toContain('id="phone"')
    expect(page).toContain('type="tel"')
    expect(page, '国内版不该出现 Z.ai（那会让用户以为国内也能 OAuth）').not.toContain('chat.z.ai')
  })

  it('★★ 真实用户路径：`AutoclawAuth(AUTOCLAW_INTL).startLogin()` 拿到的必须是国际版页面', async () => {
    // ⚠️ 守的是 RPC 那条路：`account.create` → `startLogin` → 登录页。
    //    前两条直接调 flow 函数，把「`startLogin` 到底传了哪个 product」当成既成事实
    //    ⇒ 把 `product: this.product` 写成国内 `AUTOCLAW` 时它们**零红**。
    const ctx = new Context()
    ctx.provide('credentials', {
      resolve: async () => undefined,
      describe: async () => ({ configured: false, writable: true }),
      set: async () => {},
      unset: async () => {},
    } as never)
    ctx.provide('commands', { register: () => () => {} } as never)
    const auth = new AutoclawAuth(ctx, { product: AUTOCLAW_INTL })
    const flow = await auth.startLogin()
    live.push(flow)
    const page = await (await fetch(flow.loginUrl)).text()
    expect(page, 'startLogin 必须用实例自己的 product，不能写死国内').toContain('chat.z.ai')
    expect(page).not.toContain('<input')
  })
})

describe('★★ Z.ai OAuth 回调闭环', () => {
  it('★★ 回调必须真的读 query 里的 code/state，且 navigate_uri 与 redirect_uri 逐字节相同', async () => {
    const capture: Capture = { bodies: [] }
    const flow = await startAutoclawSmsLoginFlow({
      product: AUTOCLAW_INTL, fetchImpl: makeFetcher(capture), deviceId: 'dev-test', timeoutMs: 5_000,
    })
    live.push(flow)

    const page = await (await fetch(flow.loginUrl)).text()
    const redirectUri = zaiRedirectUriOf(page)

    // ⚠️ **每次跑都生成新 nonce**：用固定字面量时，实现把值写死也照样绿。
    const code = nonce('code')
    const state = nonce('state')
    const callbackPage = await (await fetch(`${redirectUri}?code=${code}&state=${state}`)).text()
    expect(callbackPage, '回调页要说「授权已完成」').toContain('授权已完成')

    const settled = await flow.result
    expect(settled.credential.access_token).toBe('stub-access')

    expect(capture.bodies, '换 token 必须只打一次').toHaveLength(1)
    expect(capture.bodies[0].code, '实现必须从 query 取 code，不能写死').toBe(code)
    expect(capture.bodies[0].state, 'state 必须原样透传（不解析、不重建）').toBe(state)
    expect(capture.bodies[0].navigate_uri, 'OAuth 要求两次 redirect 逐字节相同，否则上游回 631001').toBe(redirectUri)
  })

  it('★★ 失败后**必须还能重试成功**（比「仍 pending」强：后者分不清「不 settleErr」与「什么都没写」）', async () => {
    const capture: Capture = { bodies: [] }
    const mode = { fail: true }
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : (input as Request).url ?? input)
      if (url.includes('/userapi/overseasv1/zai-oauth-login')) {
        capture.bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        if (mode.fail) {
          return new Response(JSON.stringify({ code: 631001, msg: 'User login error' }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({
          code: 0, data: { access_token: 'stub-access', refresh_token: 'stub-refresh', expires_in: 3600 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('unexpected', { status: 500 })
    }) as unknown as typeof fetch

    const flow = await startAutoclawSmsLoginFlow({
      product: AUTOCLAW_INTL, fetchImpl: fetcher, deviceId: 'dev-test', timeoutMs: 5_000,
    })
    live.push(flow)
    const page = await (await fetch(flow.loginUrl)).text()
    const redirectUri = zaiRedirectUriOf(page)

    const badCode = nonce('bad')
    const failPage = await (await fetch(`${redirectUri}?code=${badCode}&state=s`)).text()
    expect(failPage).toContain('授权失败')

    // 第二次：上游放行 ⇒ 必须成功，且 flow 仍可用
    mode.fail = false
    const goodCode = nonce('good')
    const okPage = await (await fetch(`${redirectUri}?code=${goodCode}&state=s`)).text()
    expect(okPage, '失败后必须能重试（若失败就 settleErr，这里连页面都打不开）').toContain('授权已完成')
    const settled = await flow.result
    expect(settled.credential.access_token).toBe('stub-access')
    expect(capture.bodies.map((b) => b.code)).toEqual([badCode, goodCode])
  })

  it('★★ 站点门控：国内版 flow 上这条回调腿必须**不可达**（否则能把凭据写进错误槽位）', async () => {
    const capture: Capture = { bodies: [] }
    const flow = await startAutoclawSmsLoginFlow({
      product: AUTOCLAW, fetchImpl: makeFetcher(capture), deviceId: 'dev-test', timeoutMs: 5_000,
    })
    live.push(flow)
    const base = new URL(flow.loginUrl).origin
    const res = await fetch(`${base}${AUTOCLAW_OAUTH_CALLBACK_PATH}?code=x&state=y`)
    expect(res.status, '国内 flow 不该注册 Z.ai 回调').toBe(404)
    expect(capture.bodies, '被门控挡住时**不得**去打换 token').toHaveLength(0)
  })
})

describe('★★ 凭据有效期不得编造（IKOYEG 的第四处写入点）', () => {
  it('★★ 上游不给 expires_at / expires_in、token 也不是 JWT ⇒ expires_at 必须缺席，不能是「现在 +7 天」', async () => {
    const capture: Capture = { bodies: [] }
    const result = await exchangeAutoclawZaiCode('code-x', 'state-y', 'http://127.0.0.1:1/auth/callback-zai', {
      product: AUTOCLAW_INTL,
      fetchImpl: makeFetcher(capture, { omitExpiry: true }),
      deviceId: 'dev-test',
    })
    expect(result.ok).toBe(true)
    const credential = result.credential!
    // ⚠️ 旧实现 `Date.now() + 7 * 86400_000`：一个编造的值同时是续期 lead-time 与
    //    积分自愈的唯一判据 ⇒ 过期前后都**不自愈**、日志零字（IKOYEG 那次 P0 同型）。
    expect(credential.expires_at, '读不到就必须缺席，绝不编造').toBeUndefined()
    // 反向守卫：即使实现改成「随便给个未来值」，也不能是 7 天量级
    if (credential.expires_at !== undefined) {
      const sevenDays = 7 * 86400_000
      expect(Math.abs(credential.expires_at - Date.now() - sevenDays)).toBeGreaterThan(3600_000)
    }
  })

  it('★ 对照：上游给了 expires_in 时必须用它（别把兜底滤波做成「永远不带有效期」）', async () => {
    const capture: Capture = { bodies: [] }
    const startedAt = Date.now()
    const result = await exchangeAutoclawZaiCode('code-x', 'state-y', 'http://127.0.0.1:1/auth/callback-zai', {
      product: AUTOCLAW_INTL, fetchImpl: makeFetcher(capture), deviceId: 'dev-test',
    })
    const credential = result.credential!
    expect(credential.expires_at).toBeGreaterThanOrEqual(startedAt + 3600_000 - 5_000)
  })
})

describe('★★ 客户端入口（源码锚点必须跨「条件展开 + 字面量」）', () => {
  const readClient = async (): Promise<string> => {
    const { readFileSync } = await import('node:fs')
    return readFileSync('plugin-src/client/jet-hub.js', 'utf8')
  }

  it('★★ 国际版 zai 选项必须**由 autoclawZaiAvailable 门控**（只锚字面量会被「挂错条件」绕过）', async () => {
    const source = await readClient()
    expect(source).toContain("const autoclawZaiAvailable = provider === 'autoclawintl';")
    // ⚠️ 锚点跨过 `...(条件 ?` 与字面量 —— 把条件换成 autoclawSmsAvailable 时必红
    expect(source, 'zai 选项必须挂在 autoclawZaiAvailable 的条件展开里').toMatch(
      /\.\.\.\(autoclawZaiAvailable\s*\?\s*\[\{ value: 'zai', label: '🌐 使用 Z\.ai 账号登录'/,
    )
  })

  it('★★ 国内版 sms 选项必须由 autoclawSmsAvailable 门控，且两站**互斥**', async () => {
    const source = await readClient()
    expect(source).toContain("const autoclawSmsAvailable = provider === 'autoclaw';")
    expect(source).toMatch(/\.\.\.\(autoclawSmsAvailable\s*\?\s*\[\{ value: 'sms',/)
    // 互斥：sms 判据不得写成「或」式（会让国际版同时渲染两条腿）
    expect(source, 'sms 判据不得包含「或」式写法').not.toMatch(
      /const autoclawSmsAvailable = provider === 'autoclaw'\s*\|\|/,
    )
  })

  it('★ 默认值按站分（国际版落 zai，因为 local 要求本机装了客户端）', async () => {
    const source = await readClient()
    expect(source, '默认值必须与 provider 绑定，不能写死 local').toMatch(
      /React\.useState\(\s*provider === 'autoclawintl' \? 'zai' : 'local',?\s*\)/,
    )
  })
})
