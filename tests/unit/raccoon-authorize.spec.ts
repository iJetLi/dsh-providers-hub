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
import net from 'node:net'
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
  RACCOON_CALLBACK_URL_MAX_LENGTH,
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

/**
 * 用**原始请求行**发一个请求（`http.request` 的 `path` 会被规范化，
 * 发不出协议相对 URL 那种形态）。
 */
function rawRequest(
  port: number,
  rawLine: string,
): Promise<{ status: number | null; body: string }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${rawLine} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
    })
    let body = ''
    // ⚠️ **不等 close**：我们回了 `Connection: close`，但 socket 的 close
    //   事件在某些平台上有延迟 ⇒ 用「响应头到齐」判定完成（更准，也更快）。
    socket.on('data', (chunk) => {
      body += String(chunk)
      if (body.includes('\r\n\r\n')) {
        const match = /HTTP\/1\.1 (\d{3})/.exec(body)
        const status = match === null ? null : Number(match[1])
        socket.destroy()
        resolve({ status, body })
      }
    })
    socket.on('error', () => resolve({ status: null, body: 'connection-closed' }))
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
      // ⚠️⚠️ **逐条串行**（不写成「数组字面量里直接调 probe」）：那会**同时**
      //   发出 11 个请求 ⇒ 撞上 `maxConnections = 8`（官方接收端同款的上限）
      //   ⇒ 后面的连接**被拒**（status 为 null）⇒ 用例红在「连接被关」，
      //   而不是红在它想验的那条规则上（那才是**无牙**的判据）。
      //   真实用法也是串行的：浏览器只投递**一次**回调。
      const cases: Array<[string, () => Promise<{ status: number | null; body: string }>, string]> = [
        ['POST 被拒（只收 GET）', () => probe(receiver.port, good, {}, 'POST'), 'method'],
        ['外来 Host 头被拒', () => probe(receiver.port, good, { Host: 'example.com' }), 'host'],
        ['外来 Origin 被拒', () => probe(receiver.port, good, { Origin: 'https://evil.example' }), 'origin'],
        ['非 document 的 Sec-Fetch-Dest 被拒', () => probe(receiver.port, good, { 'Sec-Fetch-Dest': 'iframe' }), 'fetch-dest'],
        ['多一个查询键被拒', () => probe(receiver.port, `${good}&foo=1`), 'keys'],
        ['state 重复出现被拒', () => probe(receiver.port, `/auth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}&state=${STATE}`), 'keys'],
        ['state 不匹配被拒', () => probe(receiver.port, `/auth/callback?code=${encodeURIComponent(CODE)}&state=${'b'.repeat(64)}`), 'state'],
        ['63 位 state 被拒', () => probe(receiver.port, `/auth/callback?code=${encodeURIComponent(CODE)}&state=${'a'.repeat(63)}`), 'state'],
        ['code 带控制字符被拒', () => probe(receiver.port, `/auth/callback?code=${encodeURIComponent('ab')}&state=${STATE}`), 'code'],
        // ⚠️ 这一格的断言原本是被**用例名**满足的（名字里就有 `code`）——
        //   真去看响应体就会发现：URL 总长判据（`RACCOON_CALLBACK_URL_MAX_LENGTH`）
        //   **排在 code 判据之前**，5000 字的 code 会先撞它 ⇒ 原因词是 `length`
        //   而不是 `code`（作者新增的 4200 字那格断言的就是 `length`）。
        ['超长 URL（code 填 5000 字）被 URL 总长上限拒', () => probe(receiver.port, `/auth/callback?code=${encodeURIComponent('c'.repeat(5000))}&state=${STATE}`), 'length'],
        ['路径不对被拒', () => probe(receiver.port, `/auth/callback2?code=x&state=${STATE}`), 'path'],
      ]
      const bodies: string[] = []
      for (const [name, run, expected] of cases) {
        const res = await run()
        bodies.push(res.body)
        // ⚠️ 断言**只看响应体**：用例名里本身就含 `state` / `code` / `host`
        //   这些词，把 `name` 拼进被断言的字符串等于让断言被自己的名字满足
        //   （实测：删掉 state 的 64 位 hex 预判后，两条 `state` 用例与两条
        //   `code` 用例照样全绿 —— 假绿）。
        expect(res.body, name).toContain(expected)
        expect(res.status, `${name} 必须回 400（不是连接被关）`).toBe(400)
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
    const second = await probe(receiver.port, good)
    // ⚠️ 两种「一次性」的表现都算过：**端口已消失**（`probe` 拿到
    //   `{status:null}` —— 连接被拒）或端口还在但回 **409**。前者是**常态**
    //   （我们回了 `Connection: close` 且落定即关端口），后者只在极窄的
    //   竞态窗口里出现。
    expect(second.status === null || second.status === 409, `第二次投递必须失败，收到 ${JSON.stringify(second)}`).toBe(true)
    // ⚠️ **绝不**是 200：那意味着那枚 code 被**换第二次**（上游会 400，但
    //   我们**不该**走到那一步 —— 一次性消费是我们自己的义务）。
    expect(second.status).not.toBe(200)
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

  it('★★★ 超长回调 URL 被拒（URL 总长上限；**够得着**才叫判据）', async () => {
    // ⚠️⚠️ **这条判据必须够得着**（本仓反复记过：「够不着的判据 = 没有」）：
    //   Node 的 `maxHeaderSize: 8192`（含请求行与各头）在 URL 长到约
    //   **8160** 时就回 **431**（实测：URL 长 8150 → 200、8160 → 431）
    //   ⇒ 若把上限写成官方的 8192，**任何超限 URL 都到不了我们的处理器**
    //   ⇒ 那条判据恒真、永远绿（**假绿**）。
    //   ⇒ 我们的上限（4096）刻意**低于** Node 的阈值 ⇒ 它**真的**生效。
    const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 60_000 })
    try {
      // code 长度 4200 ⇒ URL 总长 4291（> 4096，且远低于 Node 的 431 阈值）。
      const long = `/auth/callback?code=${'c'.repeat(4200)}&state=${STATE}`
      expect(long.length).toBeGreaterThan(RACCOON_CALLBACK_URL_MAX_LENGTH)
      expect(long.length, '必须落在 Node 的 431 阈值之内，否则测不到我们这条判据').toBeLessThan(8100)
      const res = await probe(receiver.port, long)
      expect(res.status).toBe(400)
      expect(res.body).toContain('length')
    } finally {
      receiver.cancel()
    }
  })

  it('★★★ 协议相对 URL（//evil/…）被拒（靠 origin 严格等值那一腿）', async () => {
    const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 60_000 })
    try {
      // ⚠️ 用**原始请求行**发（`http.request` 的 `path` 会被规范化）⇒
      //   真的把 `//evil.example/...` 当成请求行发出去。
      //
      // ⚠️⚠️ **判据钉在「origin 那一腿」**：实测 `new URL('//evil/x',
      //   'http://127.0.0.1:P')` 解析出的是 **`http://evil/x`** ⇒
      //   **origin 不等** ⇒ 被拒。若哪天有人把那条 origin 判据放宽，
      //   这条用例必须变红（那才是它要防的东西）。
      const res = await rawRequest(receiver.port, `//evil.example/auth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}`)
      expect(res.status).toBe(400)
      expect(res.body).toContain('path')
      // ⚠️ 响应体里**不得**出现那个外来 host（它是被拒的理由，不该外泄成
      //   一句可被反射的文本 —— 本仓记过「不转义就是一处反射型 XSS」）。
      expect(res.body).not.toContain('evil.example')
    } finally {
      receiver.cancel()
    }
  })

  it('★★★ 连接数上限是 8（官方接收端同款：慢连接不得占住这个端口）', async () => {
    // ⚠️ 没有它 ⇒ 一个**慢速连接**（不发完整请求头、也不断开）能占住这个
    //   端口直到 5 分钟整体超时 ⇒ 而这个端口是「等着收凭据」的口子，
    //   占住它不只是资源问题，还是**可用性**问题（真回调进不来）。
    const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 60_000 })
    try {
      // 真开 8 个**不结束**的连接（发一半请求头就挂着）。
      const sockets: Array<{ destroy: () => void }> = []
      for (let i = 0; i < 8; i++) {
        const socket = await new Promise<{ destroy: () => void }>((resolve, reject) => {
          const req = http.request(
            { host: '127.0.0.1', port: receiver.port, path: '/auth/callback', method: 'GET' },
            () => resolve(req),
          )
          req.on('error', reject)
          // 只写一半请求头就结束 ⇒ 服务端那边是「未完成的连接」。
          req.write('GET /auth/callback?code=')
          resolve(req)
        })
        sockets.push(socket)
      }
      // 第 9 个连接应当**拿不到**（连接数上限生效）⇒ 表现为连接被关掉。
      const ninth = await probe(receiver.port, `/auth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}`)
      expect(ninth.status === null || ninth.status === 400).toBe(true)
      for (const socket of sockets) socket.destroy()
    } finally {
      receiver.cancel()
    }
  })

  it('★★★ 慢速连接会被 socket 超时**掐掉**（官方接收端同款兜底）', async () => {
    // ⚠️ 没有它 ⇒ 一个**慢速连接**（连上了但不发完整请求头、也不断开）能
    //   占住这个端口直到 5 分钟整体超时 ⇒ 而这个端口是「等着收凭据」的口子，
    //   占住它 = **真回调进不来**（可用性缺陷，不只是资源问题）。
    //
    // ⚠️ **超时值注入成 300ms**（默认 20 秒在单测里没法等 ⇒ 那条判据就
    //   **够不着**，变异验证会如实报「无牙」）。
    const receiver = await startRaccoonAuthorizeReceiver({
      state: STATE,
      timeoutMs: 60_000,
      socketTimeoutMs: 300,
    })
    try {
      // 连上但**什么都不发** ⇒ 服务端那边是一个空闲的 socket。
      const socket = await new Promise<{ on: (e: string, cb: () => void) => void; destroy: () => void }>((resolve, reject) => {
        const client = net.connect(receiver.port, '127.0.0.1', () => resolve(client))
        client.on('error', reject)
      })
      let closed = false
      socket.on('close', () => { closed = true })
      // 等它被服务端掐掉（socket 超时 300ms + 一点余量）。
      await new Promise((resolve) => setTimeout(resolve, 900))
      expect(closed, '空闲 socket 必须被服务端掐掉（否则它一直占着这个「收凭据」的口子）').toBe(true)
      socket.destroy()
    } finally {
      receiver.cancel()
    }
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
