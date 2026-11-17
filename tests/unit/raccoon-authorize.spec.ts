/**
 * 「浏览器授权」登录链的单测（官方客户端自己那条链的移植）。
 *
 * ## 为什么回环接收端要**真起一个 socket**
 *
 * 那七条规则**就是**这个模块要守的东西（授权码是一次性凭据，而敞开的
 * 接收端就是凭据交换漏洞）。用桩服务器测，测的就是「我们以为的规则」，
 * 而不是规则本身 ⇒ 接收端一律真起 `127.0.0.1` 的随机端口、真发 HTTP
 * 请求、真看响应。
 *
 * ## 为什么换码用注入的 fetch
 *
 * 换码那一段只关心「成功门 + 每一种拒绝原因」⇒ 注入 fetch（零网络）。
 * 端点与错误码的**真实**形状另有一条 e2e 探针（`tests/e2e/`），
 * 不在这里靠真网络。
 */
import { describe, expect, it } from 'vitest'
import http from 'node:http'
import {
  buildRaccoonAuthorizeUrl,
  exchangeRaccoonAuthorizationCode,
  isRaccoonIamToken,
  raccoonIamTokenIsValid,
  startRaccoonAuthorizeReceiver,
  RACCOON_API_BASE,
  RACCOON_AUTH_APPNAME,
  RACCOON_AUTHORIZATION_CODE_NOT_FOUND,
  RACCOON_AUTHORIZE_PATH,
  RACCOON_IAM_ISSUER,
  RACCOON_LOOPBACK_CALLBACK_PATH,
} from '../../src/raccoon-authorize.js'
import { RACCOON } from '../../src/raccoon-product.js'

const STATE = 'a'.repeat(64)
const CODE = 'auth-code-value-0123'

/** 造一枚带指定 claims 的 base64url JWT。 */
function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.${b64({})}`
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** 真发一个 HTTP 请求探针（拿到状态码与响应体）。 */
function probe(
  port: number,
  pathAndQuery: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number | null; body: string }> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, method, headers }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', () => resolve({ status: null, body: 'connection-closed' }))
    req.end()
  })
}

describe('buildRaccoonAuthorizeUrl：官方页自己的规则，发出去之前就自查', () => {
  it('产出官方页面认的那条 URL（desktop + loopback 形态）', () => {
    const url = buildRaccoonAuthorizeUrl({ port: 4321, state: STATE })
    const parsed = new URL(url)
    expect(parsed.origin).toBe(RACCOON_API_BASE)
    expect(parsed.pathname).toBe(RACCOON_AUTHORIZE_PATH)
    expect(parsed.searchParams.get('login_source')).toBe('desktop')
    expect(parsed.searchParams.get('desktop_callback')).toBe('loopback')
    expect(parsed.searchParams.get('redirect')).toBe(
      `http://127.0.0.1:4321${RACCOON_LOOPBACK_CALLBACK_PATH}`,
    )
    expect(parsed.searchParams.get('state')).toBe(STATE)
  })

  it('默认应用名是实测走通的那一个', () => {
    const parsed = new URL(buildRaccoonAuthorizeUrl({ port: 4321, state: STATE }))
    expect(parsed.searchParams.get('appname')).toBe(RACCOON_AUTH_APPNAME)
  })

  it('参数名全在官方页面的白名单里（多一个键整条链接作废）', () => {
    const parsed = new URL(buildRaccoonAuthorizeUrl({ port: 4321, state: STATE }))
    const allowed = ['login_source', 'appname', 'state', 'redirect', 'ide', 'org', 'lang', 'desktop_callback']
    for (const key of parsed.searchParams.keys()) {
      expect(allowed).toContain(key)
    }
  })

  const refuse = (port: unknown, state: unknown = STATE, appname: unknown = RACCOON_AUTH_APPNAME): Error | null => {
    try {
      buildRaccoonAuthorizeUrl({ port, state, appname })
      return null
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  it('低于 1024 的端口被拒（官方页面的范围）', () => {
    expect(refuse(999)).not.toBeNull()
  })

  it('非整数端口被拒', () => {
    expect(refuse(4321.5)).not.toBeNull()
  })

  it('六位端口被拒（官方页面的正则是 4~5 位）', () => {
    expect(refuse(100000)).not.toBeNull()
  })

  it('超过 65535 的端口被拒', () => {
    expect(refuse(70000)).not.toBeNull()
  })

  it('边界值 1024 与 65535 都放行', () => {
    expect(refuse(1024)).toBeNull()
    expect(refuse(65535)).toBeNull()
  })

  it('63 位 state 被拒', () => {
    expect(refuse(4321, 'a'.repeat(63))).not.toBeNull()
  })

  it('**大写** state 被拒（官方规则是 [a-f0-9]）', () => {
    expect(refuse(4321, 'A'.repeat(64))).not.toBeNull()
  })

  it('101 字符的应用名被拒', () => {
    expect(refuse(4321, STATE, 'x'.repeat(101))).not.toBeNull()
  })
})

describe('startRaccoonAuthorizeReceiver：七条规则，跑在真 socket 上', () => {
  it('绑 127.0.0.1 并回报端口；URL 带着这个端口与 state', async () => {
    const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 60_000 })
    try {
      expect(receiver.port).toBeGreaterThan(0)
      expect(receiver.redirect).toBe(`http://127.0.0.1:${receiver.port}${RACCOON_LOOPBACK_CALLBACK_PATH}`)
      const parsed = new URL(receiver.authorizeUrl)
      expect(parsed.searchParams.get('redirect')).toBe(receiver.redirect)
      expect(parsed.searchParams.get('state')).toBe(receiver.state)
      expect(receiver.state).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      receiver.cancel()
    }
  })

  it('七条拒绝规则逐条生效，且**拒绝不消耗**接收端', async () => {
    const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 60_000 })
    try {
      const good = `/auth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}`
      const cases: Array<[string, Promise<{ status: number | null; body: string }>, string]> = [
        ['POST 被拒（只收 GET）', probe(receiver.port, good, {}, 'POST'), 'method'],
        ['外来 Host 头被拒', probe(receiver.port, good, { Host: 'example.com' }), 'host'],
        ['外来 Origin 被拒', probe(receiver.port, good, { Origin: 'https://evil.example' }), 'origin'],
        ['非 document 的 Sec-Fetch-Dest 被拒', probe(receiver.port, good, { 'Sec-Fetch-Dest': 'iframe' }), 'fetch-dest'],
        ['多一个查询键被拒', probe(receiver.port, `${good}&foo=1`), 'keys'],
        ['state 重复出现被拒', probe(receiver.port, `/auth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}&state=${STATE}`), 'keys'],
        ['state 不匹配被拒', probe(receiver.port, `/auth/callback?code=${encodeURIComponent(CODE)}&state=${'b'.repeat(64)}`), 'state'],
        ['63 位 state 被拒', probe(receiver.port, `/auth/callback?code=${encodeURIComponent(CODE)}&state=${'a'.repeat(63)}`), 'state'],
        ['code 带控制字符被拒', probe(receiver.port, `/auth/callback?code=${encodeURIComponent('ab')}&state=${STATE}`), 'code'],
        ['超长 code（>4096）被拒', probe(receiver.port, `/auth/callback?code=${encodeURIComponent('c'.repeat(5000))}&state=${STATE}`), 'code'],
        ['路径不对被拒', probe(receiver.port, `/auth/callback2?code=x&state=${STATE}`), 'path'],
      ]
      const bodies: string[] = []
      for (const [name, pending, expected] of cases) {
        const res = await pending
        bodies.push(res.body)
        // ⚠️ 断言**只看响应体**：用例名里本身就含 `state` / `code` / `host`
        //   这些词，把 `name` 拼进被断言的字符串等于让断言被自己的名字满足
        //   （实测：删掉 state 的 64 位 hex 预判后，两条 `state` 用例与两条
        //   `code` 用例照样全绿 —— 假绿）。
        expect(res.body, name).toContain(expected)
        expect(res.status, name).toBe(400)
      }
      // ⚠️ 拒绝**不**消耗接收端：一条合法回调仍然能落地。
      const accepted = await probe(
        receiver.port,
        `/auth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}`,
        { Origin: RACCOON_API_BASE, 'Sec-Fetch-Dest': 'document' },
      )
      expect(accepted.status).toBe(200)
      const settled = await receiver.result
      expect(settled.ok).toBe(true)
      expect(settled.code).toBe(CODE)
      // ⚠️ 响应体**永不**打印那枚 code 的值（它是凭据）。
      for (const body of bodies) {
        expect(body).not.toContain(CODE)
      }
    } finally {
      receiver.cancel()
    }
  })

  it('★★ 「缺 Origin / 缺 Sec-Fetch-Dest」一律放行（官方投递是**顶层导航**，不发 Origin）', async () => {
    // ⚠️ 这条是**必需的不变式**，不是漏判：官方页面在 desktop 形态用顶层导航投递
    //   回调（官方 bundle 里就是 `r.navigate(t)`），而顶层导航**不发 `Origin`**
    //   ⇒ 判据只能是「头存在才查」。反过来（改成必须存在）会让真浏览器里 100%
    //   收不到回调 —— 而这条用例就是防那一天（当时它不存在，双审计都点了名）。
    const shapes: Array<[string, Record<string, string>]> = [
      ['两个头都不带', {}],
      ['只带对的 Origin', { Origin: RACCOON_API_BASE }],
      ['只带对的 Sec-Fetch-Dest', { 'Sec-Fetch-Dest': 'document' }],
    ]
    for (const [name, headers] of shapes) {
      // 一次性 ⇒ 每格都必须用**新的**接收端（上一格成功后端口对一切回 409）。
      const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 60_000 })
      try {
        const res = await probe(receiver.port, `/auth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}`, headers)
        expect(res.status, name).toBe(200)
        const settled = await receiver.result
        expect(settled.ok, name).toBe(true)
        expect(settled.code, name).toBe(CODE)
      } finally {
        receiver.cancel()
      }
    }
  })

  // ⚠️ 这里原本有一条「state 形态不合法 ⇒ 不产出 authorizeUrl」的用例，**已删除**：
  //    实测非法 state 会让 `startRaccoonAuthorizeReceiver` **提前抛错**
  //    （`authorize: state 必须是 64 位小写 hex`，见 `src/raccoon-authorize.ts` 的
  //    `if (!/^[a-f0-9]{64}$/.test(state)) throw`）⇒ 调用方拿到的是异常、不是空 URL
  //    ⇒ 「空 authorizeUrl」那一支**结构上不可达**，写用例只会得到一个假契约。
  //    同一件事已由上面「畸形 state ⇒ 提前抛」那条覆盖。

  it('有效回调是**一次性**的：第二次投递拿 409（或端口已消失）', async () => {
    const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 60_000 })
    const good = `/auth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}`
    const first = await probe(receiver.port, good, { Origin: RACCOON_API_BASE, 'Sec-Fetch-Dest': 'document' })
    expect(first.status).toBe(200)
    await receiver.result
    const second = await probe(receiver.port, good).catch(() => null)
    expect(second === null || second.status === 409).toBe(true)
  })

  it('没人回调时落定为 timeout', async () => {
    const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 150 })
    const settled = await receiver.result
    expect(settled.ok).toBe(false)
    expect(settled.reason).toBe('timeout')
  })

  it('cancel() 落定为 closed', async () => {
    const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 60_000 })
    receiver.cancel()
    const settled = await receiver.result
    expect(settled.ok).toBe(false)
    expect(settled.reason).toBe('closed')
  })

  it('端口被占用时落定为 failed 且**不产出 URL**（用户重开一轮即可）', async () => {
    const blocker = http.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()))
    const address = blocker.address()
    const takenPort = typeof address === 'object' && address !== null ? address.port : 0
    const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, port: takenPort, timeoutMs: 60_000 })
    const settled = await receiver.result
    expect(settled.ok).toBe(false)
    expect(settled.reason).toBe('failed')
    expect(receiver.authorizeUrl).toBe('')
    blocker.closeAllConnections?.()
    blocker.close()
  })

  it('请求一个官方页面范围外的端口**提前抛**（那是调用方的 bug）', async () => {
    await expect(startRaccoonAuthorizeReceiver({ state: STATE, port: 80, timeoutMs: 1000 })).rejects.toThrow(/1024/)
  })

  it('畸形 state **提前抛**', async () => {
    await expect(startRaccoonAuthorizeReceiver({ state: 'z'.repeat(64) })).rejects.toThrow(/state/)
  })
})

describe('isRaccoonIamToken / raccoonIamTokenIsValid：官方 iamToken.js 的规则', () => {
  it('iss 以 /iam 结尾就算 IAM 形态（官方规则的**判定**只看后缀）', () => {
    expect(isRaccoonIamToken(fakeJwt({ iss: RACCOON_IAM_ISSUER, sub: 'a', exp: nowSec() + 60 }))).toBe(true)
    // ⚠️ 带 scheme 的那个形状**仍然**是 IAM 形态（官方规则只看后缀）——
    //   但它**过不了**下面那道严格等值的有效性检查（见下一组用例）。
    //   两条判据分工不同，别把这条写成 false。
    expect(isRaccoonIamToken(fakeJwt({ iss: 'https://xiaohuanxiong.com/iam', sub: 'a', exp: nowSec() + 60 }))).toBe(true)
    expect(isRaccoonIamToken(fakeJwt({ iss: 'xiaohuanxiong.com/other', sub: 'a', exp: nowSec() + 60 }))).toBe(false)
    expect(isRaccoonIamToken('not-a-jwt')).toBe(false)
    expect(isRaccoonIamToken('')).toBe(false)
  })

  it('有效 IAM 令牌：同一 issuer + 非空 sub + 未来的 exp', () => {
    expect(raccoonIamTokenIsValid(fakeJwt({ iss: RACCOON_IAM_ISSUER, sub: 'a', exp: nowSec() + 60 }))).toBe(true)
  })

  it('issuer 不匹配（**带 scheme 的**那个形状）被拒', () => {
    expect(raccoonIamTokenIsValid(fakeJwt({ iss: 'https://xiaohuanxiong.com/iam', sub: 'a', exp: nowSec() + 60 }))).toBe(false)
  })

  it('空 sub 被拒', () => {
    expect(raccoonIamTokenIsValid(fakeJwt({ iss: RACCOON_IAM_ISSUER, sub: '  ', exp: nowSec() + 60 }))).toBe(false)
  })

  it('过期的 exp 被拒', () => {
    expect(raccoonIamTokenIsValid(fakeJwt({ iss: RACCOON_IAM_ISSUER, sub: 'a', exp: nowSec() - 10 }))).toBe(false)
  })

  it('exp 不是有限数被拒', () => {
    expect(raccoonIamTokenIsValid(fakeJwt({ iss: RACCOON_IAM_ISSUER, sub: 'a', exp: 'soon' }))).toBe(false)
  })
})

describe('exchangeRaccoonAuthorizationCode：成功门与每一种拒绝', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('换到凭据（IAM 令牌 + 网关配发的 refresh）', async () => {
    const exp = nowSec() + 3600
    const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
      expect(url).toBe(`${RACCOON.apiBase}${RACCOON.authApiPrefix}/login_with_authorization_code`)
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body))).toEqual({ authorization_code: 'the-code' })
      return jsonResponse({
        code: 0,
        data: { access_token: fakeJwt({ iss: RACCOON_IAM_ISSUER, sub: 'a', exp }), refresh_token: 'r' },
      })
    }
    const result = await exchangeRaccoonAuthorizationCode('the-code', {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(result.credential?.refresh_token).toBe('r')
    expect(result.credential?.expires_at).toBe(String(exp * 1000))
  })

  it('授权码不存在（200035）⇒ code_not_found', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 200035, message: 'x' }, 400)
    const result = await exchangeRaccoonAuthorizationCode('stale', {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('code_not_found')
  })

  it('401 ⇒ session_dead', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 401 }, 401)
    const result = await exchangeRaccoonAuthorizationCode('c', { fetcher: fetcher as unknown as typeof fetch })
    expect(result.reason).toBe('session_dead')
  })

  it('其它服务端错误 ⇒ server_error', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 500 }, 500)
    const result = await exchangeRaccoonAuthorizationCode('c', { fetcher: fetcher as unknown as typeof fetch })
    expect(result.reason).toBe('server_error')
  })

  it('★★ HTTP 200 但业务码非 0 ⇒ server_error（**即使**报文里带着 access_token）', async () => {
    // ⚠️ 最难看的一种失败形态：HTTP 200 + 信封 `code !== 0`，而 `data.access_token`
    //   恰好也在（上游出错时回显半截数据）。原来那条 `|| envelopeCode !== 0` 判据
    //   删掉后**一条用例都不红** ⇒ 会静默产出一枚来路不明的凭据。
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 1,
      data: { access_token: fakeJwt({ iss: RACCOON_IAM_ISSUER, sub: 'a', exp: nowSec() + 3600 }) },
    })
    const result = await exchangeRaccoonAuthorizationCode('the-code', {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('server_error')
    expect(result.credential).toBeUndefined()
  })

  it('★★ 只有空白的 access_token ⇒ invalid_response（空白 = 缺失）', async () => {
    // ⚠️ `readString` 只判 typeof，原来又用精确 `=== ''` ⇒ 一个全是空格的
    //   `access_token` 会产出「成功」凭据（与成功门那句「绝不产出半截凭据」相悖）。
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { access_token: '   ', refresh_token: 'r' },
    })
    const result = await exchangeRaccoonAuthorizationCode('the-code', {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid_response')
  })

  it('★★ 只有空白的 refresh_token（非 IAM 形态）⇒ refresh_missing', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { access_token: 'not-a-jwt', refresh_token: '   ' },
    })
    const result = await exchangeRaccoonAuthorizationCode('the-code', {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('refresh_missing')
  })

  it('★★ 注入 fetcher 时 init **仍然**带 signal（生产调用点恒传 fetcher）', async () => {
    // ⚠️ 原实现是「只给默认 fetch 挂 AbortSignal.timeout」，而生产的
    //   `runAuthorizeRound` 恒传 `deps.fetcher`（= `options.fetcher ?? fetch`）
    //   ⇒ 生产路径**永远没有** signal：上游挂住就只能白等接收端的 5 分钟超时。
    let seen: RequestInit | undefined
    const fetcher = async (_url: string, init: RequestInit): Promise<Response> => {
      seen = init
      return jsonResponse({ code: 0, data: { access_token: 'not-a-jwt', refresh_token: 'r' } })
    }
    await exchangeRaccoonAuthorizationCode('the-code', { fetcher: fetcher as unknown as typeof fetch })
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
  })

  it('网络失败 ⇒ network', async () => {
    const fetcher = async (): Promise<Response> => { throw new Error('fetch failed') }
    const result = await exchangeRaccoonAuthorizationCode('c', { fetcher: fetcher as unknown as typeof fetch })
    expect(result.reason).toBe('network')
  })

  it('应答不是 JSON ⇒ invalid_response', async () => {
    const fetcher = async (): Promise<Response> => new Response('<html>', { status: 200 })
    const result = await exchangeRaccoonAuthorizationCode('c', { fetcher: fetcher as unknown as typeof fetch })
    expect(result.reason).toBe('invalid_response')
  })

  it('缺 access_token ⇒ invalid_response（**绝不**产出半截凭据）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 0, data: { refresh_token: 'r' } })
    const result = await exchangeRaccoonAuthorizationCode('c', { fetcher: fetcher as unknown as typeof fetch })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid_response')
    expect(result.credential).toBeUndefined()
  })

  it('IAM 令牌校验不通过 ⇒ token_invalid', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { access_token: fakeJwt({ iss: RACCOON_IAM_ISSUER, sub: 'a', exp: nowSec() - 10 }), refresh_token: 'r' },
    })
    const result = await exchangeRaccoonAuthorizationCode('c', { fetcher: fetcher as unknown as typeof fetch })
    expect(result.reason).toBe('token_invalid')
  })

  it('非 IAM 形态且没有 refresh_token ⇒ refresh_missing（那种令牌续不了期）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { access_token: 'opaque-token' },
    })
    const result = await exchangeRaccoonAuthorizationCode('c', { fetcher: fetcher as unknown as typeof fetch })
    expect(result.reason).toBe('refresh_missing')
  })

  it('空码不发出请求', async () => {
    let called = false
    const fetcher = async (): Promise<Response> => { called = true; return jsonResponse({ code: 0 }) }
    const result = await exchangeRaccoonAuthorizationCode('  ', { fetcher: fetcher as unknown as typeof fetch })
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
  })

  it('官方常量与网关实测的码一致', () => {
    expect(RACCOON_AUTHORIZATION_CODE_NOT_FOUND).toBe(200035)
  })
})
