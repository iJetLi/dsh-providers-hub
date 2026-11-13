/**
 * `codearts-manual-callback.spec.ts` —— CodeArts（华为云）**手动回调链接**守卫。
 *
 * ## 为什么这个能力存在
 *
 * CodeArts 的 OAuth 回调被定向到**宿主本机**：
 * `http://127.0.0.1:<port>/oauth/callback?code=…`（`buildOAuthLoginUrl` 只下发
 * `port`，portal 据此构造回调地址）。用户在**手机**或另一台电脑上完成登录时，
 * 那个浏览器打不开宿主所在的 `127.0.0.1` ⇒ 跳转失败、页面停在「无法访问」，
 * 但地址栏里已经留下一条**完全合法**的回调链接（含一次性 `code`）。
 *
 * 把那条链接粘回面板，即可在本机完成原来只有浏览器能完成的那一跳。
 *
 * ## 本文件锁的契约
 *
 * 1. **解析是纯函数**：每一种坏输入都必须给出**可照做的中文原因**，而不是抛异常；
 * 2. **端口一律取链接里那个**：`redirect_uri` 必须与授权时逐字一致，
 *    换成本机当前端口会被 STS 以 `redirect_uri` 不匹配拒掉；
 * 3. **两条来路共用同一个收码器**：手动提交与浏览器回调不得各换一次
 *    （`code` 一次性，第二次必然 `invalid_grant`）；
 * 4. **落定后重复提交必须被拒且不抛** —— 用户可能在浏览器跳转成功的同一瞬间
 *    又粘一次。
 *
 * ⚠️ 本文件只 import **纯函数** 与 `startOAuthFlow`（后者只起本地 HTTP 服务器，
 * `openBrowser` 从不由它调用）—— 绝不 import / 调用 `openBrowser`、
 * `openIncognitoWindow`（那条纪律见 `officeace-incognito-window-args.spec.ts` ⑪）。
 */

import { describe, expect, it, vi } from 'vitest'
import { parseManualCallbackUrl, startOAuthFlow } from '../../src/login.js'
import { REDIRECT_PATH } from '../../src/oauth.js'

/** 从 loginUrl 里取本轮回调端口（portal 就是靠它构造 redirect_uri 的）。 */
function portOf(loginUrl: string): number {
  const match = /[?&]port=(\d+)/.exec(loginUrl)
  if (match === null) throw new Error(`loginUrl 里没有 port 参数：${loginUrl}`)
  return Number(match[1])
}

/** 一次成功的 STS 换取应答（形状对齐 `credentialFromTokenResponse`）。 */
function tokenResponse(accessKeyId = 'AKID', refreshToken = 'rt.v1.sig'): Response {
  return new Response(JSON.stringify({
    token_type: 'Bearer',
    expires_in: 7200,
    credentials: {
      access_key_id: accessKeyId,
      secret_access_key: 'SK',
      security_token: 'ST',
      expiration: '2030-01-01T00:00:00Z',
    },
    refresh_token: refreshToken,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('parseManualCallbackUrl（纯函数：每种坏输入都要有可照做的原因）', () => {
  const cases: Array<{ name: string; input: unknown; code: string }> = [
    { name: '空串', input: '', code: 'EMPTY' },
    { name: '只有空白', input: '   \t\n ', code: 'EMPTY' },
    { name: '只有引号（复制了空内容）', input: '""', code: 'EMPTY' },
    { name: '非字符串入参', input: undefined, code: 'EMPTY' },
    { name: '纯文本', input: '随便粘的一段话', code: 'NOT_A_URL' },
    { name: '非法 URL', input: 'http://[bad', code: 'NOT_A_URL' },
    { name: 'portal 结果页（不是回调）', input: 'https://codearts.huaweicloud.com/portal/login?login_succeed=true&uri_scheme=codearts-agent', code: 'NOT_LOOPBACK' },
    { name: '非本机主机', input: 'https://example.com/oauth/callback?code=1', code: 'NOT_LOOPBACK' },
    { name: '路径不对', input: 'http://127.0.0.1:50000/portal/login?code=1', code: 'WRONG_PATH' },
    { name: '缺端口', input: 'http://127.0.0.1/oauth/callback?code=1', code: 'NO_PORT' },
    { name: '端口越界', input: 'http://127.0.0.1:70000/oauth/callback?code=1', code: 'PORT_OUT_OF_RANGE' },
    { name: '既没 code 也没 secret', input: 'http://127.0.0.1:50000/oauth/callback', code: 'NO_CODE' },
    { name: 'code 是空白', input: 'http://127.0.0.1:50000/oauth/callback?code=%20', code: 'NO_CODE' },
  ]

  for (const item of cases) {
    it(`${item.name} ⇒ ${item.code}，且文案可照做`, () => {
      const parsed = parseManualCallbackUrl(item.input)
      expect(parsed.kind).toBe('error')
      if (parsed.kind !== 'error') return
      expect(parsed.code).toBe(item.code)
      // ⚠️ 文案是用户唯一的出路：必须足够长、且不是内部错误串。
      expect(parsed.message.length).toBeGreaterThan(8)
      expect(parsed.message).not.toMatch(/undefined|null|\[object/)
    })
  }

  it('完整链接 ⇒ code + 链接里的端口', () => {
    const parsed = parseManualCallbackUrl('http://127.0.0.1:51234/oauth/callback?code=ABC123')
    expect(parsed).toEqual({ kind: 'code', code: 'ABC123', port: 51234 })
  })

  it('尖括号 / 引号 / 首尾空白都会被剥掉（邮件、聊天工具常见包裹）', () => {
    expect(parseManualCallbackUrl('  <http://127.0.0.1:51234/oauth/callback?code=X>  '))
      .toEqual({ kind: 'code', code: 'X', port: 51234 })
    expect(parseManualCallbackUrl('"http://127.0.0.1:51234/oauth/callback?code=Y"'))
      .toEqual({ kind: 'code', code: 'Y', port: 51234 })
  })

  it('localhost 与 ::1 也算本机回调', () => {
    expect(parseManualCallbackUrl('http://localhost:52345/oauth/callback?code=A'))
      .toEqual({ kind: 'code', code: 'A', port: 52345 })
  })

  it('忽略多余参数（state / token / 自定义）', () => {
    expect(parseManualCallbackUrl('http://127.0.0.1:50000/oauth/callback?state=s&code=Z&token=t'))
      .toEqual({ kind: 'code', code: 'Z', port: 50000 })
  })

  it('带 fragment 的链接照样解析出 code', () => {
    expect(parseManualCallbackUrl('http://127.0.0.1:50000/oauth/callback?code=H#frag'))
      .toEqual({ kind: 'code', code: 'H', port: 50000 })
  })

  it('旧流程 secret 回调 ⇒ kind=secret', () => {
    const parsed = parseManualCallbackUrl('http://127.0.0.1:50001/oauth/callback?secret=SEC')
    expect(parsed).toEqual({ kind: 'secret', secret: 'SEC' })
  })

  it('只有查询串（用户只复制了 ?code=…）⇒ 无端口，必须拒绝而不是猜端口', () => {
    // ⚠️ 猜端口会让 redirect_uri 与实际不符 ⇒ STS 直接拒，且错因在主流程里很难解释。
    expect(parseManualCallbackUrl('?code=R').kind).toBe('error')
    expect(parseManualCallbackUrl('code=Q').kind).toBe('error')
  })
})

describe('startOAuthFlow().submitManualCallback（手动链接走同一个收码器）', () => {
  it('合法链接 ⇒ 登录态建立，且 redirect_uri 用的是**链接里的**端口', async () => {
    const fetcher = vi.fn(async () => tokenResponse())
    const started = await startOAuthFlow({ openBrowser: () => {}, fetcher })
    try {
      const port = portOf(started.loginUrl)
      const submitted = started.submitManualCallback(
        `http://127.0.0.1:${port}/oauth/callback?code=GOODCODE`,
      )
      expect(submitted).toEqual({ ok: true })

      const outcome = await started.result
      const credential = JSON.parse(outcome.access) as Record<string, unknown>
      expect(credential.access_key_id).toBe('AKID')
      // ⚠️ refresh_token 必须在：缺它这条登录就不可静默续期。
      expect(credential.refresh_token).toBe('rt.v1.sig')

      expect(fetcher).toHaveBeenCalledTimes(1)
      const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
      expect(url).toContain('sts.cn-north-4')
      const body = new URLSearchParams(String(init.body))
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code')).toBe('GOODCODE')
      expect(body.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/oauth/callback`)
      // PKCE 与 DPoP 都是授权时那一份，必须随手动提交一起带上。
      expect((body.get('code_verifier') ?? '').length).toBeGreaterThan(0)
      expect(String((init.headers as Record<string, string>).DPoP).length).toBeGreaterThan(0)
    } finally {
      await started.close()
    }
  })

  it('坏输入 ⇒ ok:false + 可照做文案，且**一次 STS 都不打**', async () => {
    const fetcher = vi.fn(async () => tokenResponse())
    const started = await startOAuthFlow({ openBrowser: () => {}, fetcher })
    try {
      for (const bad of ['', 'garbage', 'https://codearts.huaweicloud.com/portal/login?login_succeed=true']) {
        const submitted = started.submitManualCallback(bad)
        expect(submitted.ok).toBe(false)
        expect(typeof submitted.message).toBe('string')
        expect((submitted.message ?? '').length).toBeGreaterThan(8)
      }
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      await started.close()
    }
  })

  it('端口越界 ⇒ 拒绝且不打 STS（不把越界端口提交成 redirect_uri）', async () => {
    const fetcher = vi.fn(async () => tokenResponse())
    const started = await startOAuthFlow({ openBrowser: () => {}, fetcher })
    try {
      const submitted = started.submitManualCallback('http://127.0.0.1:70000/oauth/callback?code=1')
      expect(submitted.ok).toBe(false)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      await started.close()
    }
  })

  it('落定后重复提交 ⇒ ok:false 且不抛、不再打第二次 STS（code 一次性）', async () => {
    const fetcher = vi.fn(async () => tokenResponse())
    const started = await startOAuthFlow({ openBrowser: () => {}, fetcher })
    try {
      const port = portOf(started.loginUrl)
      expect(started.submitManualCallback(`http://127.0.0.1:${port}/oauth/callback?code=GOODCODE`).ok).toBe(true)
      await started.result

      let threw = false
      let again: { ok: boolean; message?: string } | undefined
      try {
        again = started.submitManualCallback(`http://127.0.0.1:${port}/oauth/callback?code=GOODCODE`)
      } catch {
        threw = true
      }
      expect(threw).toBe(false)
      expect(again?.ok).toBe(false)
      // ⚠️ 第二次绝不能真的再换一次 —— 那会把已成功的凭据烧掉（code 已被消费）。
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      await started.close()
    }
  })

  it('STS 拒绝 ⇒ result 拒绝（失败可见），但 submit 当时返回 ok:true（失败延后到统一三态）', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_code: 'x', error_msg: 'rejected' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ))
    const started = await startOAuthFlow({ openBrowser: () => {}, fetcher })
    try {
      const port = portOf(started.loginUrl)
      // 提交本身是「已受理」，真实成败由 result / login.poll 统一报出 ——
      // 若这里就抛，前端会同时收到两条互相矛盾的失败路径。
      expect(started.submitManualCallback(`http://127.0.0.1:${port}/oauth/callback?code=BAD`).ok).toBe(true)
      await expect(started.result).rejects.toThrow()
    } finally {
      await started.close()
    }
  })
})
describe('浏览器原始回调路径未被手动提交改动（回归）', () => {
  it('真跳一次 /oauth/callback ⇒ 307 到 login_succeed=true，且凭据落定', async () => {
    const fetcher = vi.fn(async () => tokenResponse('AK-HTTP', 'rt.http.sig'))
    const started = await startOAuthFlow({ openBrowser: () => {}, fetcher })
    try {
      const port = portOf(started.loginUrl)
      // ⚠️ 这条就是真实浏览器会发的那一跳（手动提交那条腿**不经过**这里）。
      const response = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=HTTPCODE`, { redirect: 'manual' })
      expect(response.status).toBe(307)
      expect(response.headers.get('location') ?? '').toContain('login_succeed=true')

      const outcome = await started.result
      const credential = JSON.parse(outcome.access) as Record<string, unknown>
      expect(credential.access_key_id).toBe('AK-HTTP')
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      await started.close()
    }
  })

  it('换取失败时 307 必须跳 login_succeed=false（不得谎报成功）', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_code: 'y', error_msg: 'rejected' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ))
    const started = await startOAuthFlow({ openBrowser: () => {}, fetcher })
    try {
      const port = portOf(started.loginUrl)
      const response = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=BAD`, { redirect: 'manual' })
      expect(response.status).toBe(307)
      // ⚠️ 真实插件按换取结果选目标页；把这句写死成 true 会让用户看到「登录成功」而账号根本没建。
      expect(response.headers.get('location') ?? '').toContain('login_succeed=false')
      await expect(started.result).rejects.toThrow()
    } finally {
      await started.close()
    }
  })
})


/**
 * ★★ 路径判据必须**精确**，且与回调服务器的 `REDIRECT_PATH` 同源。
 *
 * PR #57 正向审计 P1-2 实证：原实现是
 * `url.pathname !== MANUAL_CALLBACK_PATH && !url.pathname.startsWith(MANUAL_CALLBACK_PATH)`
 * ⇒ 把常量写短一个字符（`/oauth/callbac`）时 27 条用例**全绿**，
 * 而真实 portal 的 `…/oauth/callback` 会被全拒；反过来 `/oauth/callbackevil`
 * 与 `/oauth/callback/` 都被放行 —— 与 `WRONG_PATH` 的文案「应为 /oauth/callback」
 * 自相矛盾。
 */
describe('回调路径判据（PR #57 正向审计 P1-2）', () => {
  it('解析器认的路径必须与回调服务器的 REDIRECT_PATH 逐字相同', () => {
    // 用服务器**真实**认的那个常量构造链接：两个常量一旦漂移，这里立刻变
    // WRONG_PATH —— 这是「两处同义常量必须同值」唯一的行为级判据。
    expect(parseManualCallbackUrl(`http://127.0.0.1:50000${REDIRECT_PATH}?code=X`))
      .toEqual({ kind: 'code', code: 'X', port: 50000 })
  })

  it('前缀、尾斜杠都不许放行（`/oauth/callbackevil`、`/oauth/callback/` 都不是真实回调）', () => {
    expect(parseManualCallbackUrl('http://127.0.0.1:50000/oauth/callbackevil?code=1').kind).toBe('error')
    expect(parseManualCallbackUrl('http://127.0.0.1:50000/oauth/callback/?code=1').kind).toBe('error')
    expect(parseManualCallbackUrl('http://127.0.0.1:50000/oauth/callbac?code=1').kind).toBe('error')
  })
})

/**
 * ★ `NO_PORT` 的三个子原因必须**文案分流**（PR #57 正向审计 P2-2）：
 * 同码不同因，修法完全不同 —— 一句话糊在一起，用户只会重粘一次同样的东西。
 */
describe('NO_PORT 文案分流（PR #57 正向审计 P2-2）', () => {
  it('端口写成 0 ⇒ 直说「端口是 0」，不是泛泛的「缺端口」', () => {
    const parsed = parseManualCallbackUrl('http://127.0.0.1:0/oauth/callback?code=1')
    expect(parsed.kind).toBe('error')
    if (parsed.kind !== 'error') return
    expect(parsed.code).toBe('NO_PORT')
    expect(parsed.message).toContain('端口号是 0')
  })

  it('只粘了查询串 ⇒ 提示把 http://127.0.0.1:端口/oauth/callback 一起带上', () => {
    const parsed = parseManualCallbackUrl('?code=R')
    expect(parsed.kind).toBe('error')
    if (parsed.kind !== 'error') return
    expect(parsed.code).toBe('NO_PORT')
    expect(parsed.message).toContain('http://127.0.0.1:端口/oauth/callback')
  })

  it('单纯缺端口 ⇒ 仍是「整条复制（应含 :端口）」', () => {
    const parsed = parseManualCallbackUrl('http://127.0.0.1/oauth/callback?code=1')
    expect(parsed.kind).toBe('error')
    if (parsed.kind !== 'error') return
    expect(parsed.code).toBe('NO_PORT')
    expect(parsed.message).toContain('整条复制')
  })
})

/**
 * ★★ 超时后收码器必须**已结算**（PR #57 正向审计 P3-8）。
 *
 * 原实现超时只 reject 那个 race 的 promise，收码器仍「未落定」⇒ 用户随后
 * 粘回链接时 `acceptCode` 照常被接受、`submitManualCallback` 回 `{ ok: true }`
 * ⇒ 用户看到「提交成功」却永远等不到账号（那一轮早已超时）。
 *
 * ⚠️ 必须可测：`callbackTimeoutMs` 就是为此新增的入口 —— 没有它只能真等
 * 180 秒，这条守卫等于不存在。
 */
describe('超时后必须拒绝后续的手动提交（PR #57 正向审计 P3-8）', () => {
  it('超时 ⇒ result 落定失败，且 submitManualCallback 回 ok:false', async () => {
    const started = await startOAuthFlow({ openBrowser: () => {}, fetcher: vi.fn(), callbackTimeoutMs: 5 })
    try {
      await expect(started.result).rejects.toThrow(/timed out/)
      const submitted = started.submitManualCallback('http://127.0.0.1:50000/oauth/callback?code=LATE')
      expect(submitted.ok, '超时后仍接受手动提交 ⇒ 用户看到「成功」但永远不会登录成功').toBe(false)
    } finally {
      await started.close()
    }
  })
})
