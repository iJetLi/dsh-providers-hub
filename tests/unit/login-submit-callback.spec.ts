/**
 * `login.submitCallback` 的**行为级**用例（远程访问 DSH 时的登录出路）。
 *
 * ## 被测意图
 *
 * 回调式 provider 把浏览器重定向到 `http://127.0.0.1:<port>/oauth/callback?code=…`，
 * 这个回环地址**只在运行 DSH 的那台机器上有效**。用户经外网访问 DSH 时浏览器在
 * 用户本机，回调打不到宿主 ⇒ 登录永远超时。
 *
 * 修法是让**宿主代替用户**去访问那条地址（宿主就在那台机器上，回调服务器正在监听），
 * 于是各 provider 的 `createServer` 处理器一行都不用改。
 *
 * 本文件守的就是这个端点：
 * 1. 只接受**回环**地址（防 SSRF —— 否则它就成了一个任意 URL 的 GET 代理）；
 * 2. 请求形态固定（GET + `redirect: 'manual'` + 超时），不许跟随跳转；
 * 3. 失败要能**区分**「端口没监听（登录已超时）」与「端口在但不响应」，
 *    否则用户只看到一句 `fetch failed`，无法判断该重开登录还是改地址。
 *
 * ## ⚠️ 为什么每条失败都要断言**错误码**而不只是 `ok === false`
 *
 * `ok: false` 有五种成因（空串 / 非法 URL / 非 http(s) / 非回环 / 网络失败）。
 * 只断言 `ok === false` 时，**把 URL 校验整段删掉**也能全绿 —— 那是本仓库
 * 反复记录过的「恒绿断言」形态。故每条用例都钉住具体的 `code` 与提示关键词。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'

type Handler = (request: Request) => Promise<Response>

/** 端点返回的单条结果（`{ ok, value? , error? }`）。 */
interface RpcResult {
  ok: boolean
  value?: { status?: number }
  error?: { code?: string; message?: string }
}

/**
 * 搭一个只注册 `login.submitCallback` 所需最小上下文的端点。
 *
 * ⚠️ `auths` 全用空桩并 `as never`：本端点**不碰任何 provider 实例**
 *（它只发一次 HTTP GET，真正的换 token 由回调服务器自己做）。这一点本身
 * 就是设计主张 —— 若哪天有人把 provider 分派塞进来，`as never` 的桩会立刻炸。
 */
function setup(): { call: (payload: unknown) => Promise<RpcResult> } {
  let handler: Handler | undefined

  const ctx = {
    get: (key: string) => key === 'connection'
      ? { fetch: { register: (c: { path: string; fetch: Handler }) => { if (c.path === JET_HUB_API_PATH) handler = c.fetch } } }
      : undefined,
    inject: (_deps: string[], cb: (c: unknown) => void) => { cb(ctx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
  }
  const pool = {
    addAccount: async () => {},
    updateAccount: async () => {},
    removeAccount: async () => {},
    listAccounts: async () => [],
    listAllAccounts: async () => [],
  }
  const stub = {} as never
  registerJetHubRpc(ctx as never, pool as never, {
    codearts: stub, buddy: stub, workbuddy: stub, lobsterai: stub, qoder: stub,
    qodercn: stub, trae: stub, cline: stub, loomy: stub, raccoon: stub,
    minimax: stub, zcode: stub, gemini: stub, accio: stub, astudio: stub,
    autoclaw: stub, autoclawintl: stub, officeace: stub, minimaxintl: stub,
    modelscope: stub,
  } as never)

  return {
    call: async (payload) => {
      const h = handler
      if (h === undefined) throw new Error('jet-hub RPC 端点未注册')
      const res = await h(new Request(`http://localhost${JET_HUB_API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'r-cb',
          method: 'jet-hub',
          payload: { method: 'login.submitCallback', payload },
        }),
      }))
      return (await res.json() as { result: RpcResult }).result
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('★ login.submitCallback：只接受本机回调地址', () => {
  it('空地址 → bad-request，且提示「粘贴」', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const { call } = setup()

    const result = await call({ url: '   ' })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('bad-request')
    expect(result.error?.message).toContain('粘贴')
    // ⚠️ 校验必须在**发请求之前**：否则空地址也会打一次 fetch。
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('非法 URL → bad-request，且不发请求', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const { call } = setup()

    const result = await call({ url: '127.0.0.1:8080/oauth/callback' })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('bad-request')
    expect(result.error?.message).toContain('不是合法 URL')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it.each([
    ['file:///etc/passwd'],
    ['ftp://127.0.0.1/x'],
    ['javascript:alert(1)'],
  ])('非 http(s) 协议被拒：%s', async (url) => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const { call } = setup()

    const result = await call({ url })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('bad-request')
    expect(result.error?.message).toContain('协议不支持')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it.each([
    ['http://example.com/oauth/callback?code=x'],
    ['http://192.168.1.5:8080/oauth/callback?code=x'],
    ['http://10.0.0.1/oauth/callback'],
    // ⚠️ 子域伪装：`127.0.0.1.evil.com` 的 hostname **不是** `127.0.0.1`。
    ['http://127.0.0.1.evil.com/oauth/callback'],
  ])('非回环地址被拒（防 SSRF）：%s', async (url) => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const { call } = setup()

    const result = await call({ url })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('bad-request')
    expect(result.error?.message).toContain('只接受本机回调地址')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it.each([
    ['http://127.0.0.1:13761/oauth/callback?code=a&state=b'],
    ['http://localhost:8845/callback'],
    // ⚠️ `URL.hostname` 对 IPv6 返回**带方括号**的 `[::1]`，故两种写法都要收。
    ['http://[::1]:9999/oauth/callback'],
  ])('回环地址放行并代发请求：%s', async (url) => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const { call } = setup()

    const result = await call({ url })

    expect(result.ok).toBe(true)
    expect(result.value?.status).toBe(200)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })
})

describe('★ login.submitCallback：请求形态', () => {
  it('GET + redirect:manual + 带超时信号', async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchStub)
    const { call } = setup()

    await call({ url: 'http://127.0.0.1:13761/oauth/callback?code=a' })

    const [, init] = fetchStub.mock.calls[0] as unknown as [URL, RequestInit]
    expect(init.method).toBe('GET')
    /**
     * ⚠️ `redirect: 'manual'` 是**行为要求**，不是风格：回调服务器在 `secret`
     * 分支会回 307 跳到 portal 结果页（外网页面）。跟随它只会多一次出站请求，
     * 还可能把状态码变成 200、掩盖真实结果。
     */
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('地址两端的空白被裁掉后再请求', async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const { call } = setup()

    await call({ url: '  http://127.0.0.1:13761/oauth/callback?code=a  ' })

    const [target] = fetchStub.mock.calls[0] as unknown as [URL]
    expect(String(target)).toBe('http://127.0.0.1:13761/oauth/callback?code=a')
  })
})

describe('★ login.submitCallback：失败必须可区分', () => {
  it('404 → bad-request（路径不是本次回调），提示「路径」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })))
    const { call } = setup()

    const result = await call({ url: 'http://127.0.0.1:13761/wrong/path' })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('bad-request')
    expect(result.error?.message).toContain('404')
    expect(result.error?.message).toContain('路径')
  })

  it('ECONNREFUSED → callback-unreachable，并指向「登录已超时」', async () => {
    const refused = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => { throw refused }))
    const { call } = setup()

    const result = await call({ url: 'http://127.0.0.1:13761/oauth/callback?code=a' })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('jet-hub/callback-unreachable')
    /**
     * ⚠️ 这条提示是本端点的**核心用户价值**：端口没监听九成是本次登录
     * 已超时（回调服务器随流程结束而 close），该重开登录而不是改地址。
     */
    expect(result.error?.message).toContain('超时')
    expect(result.error?.message).toContain('新建账号')
  })

  it('超时 → callback-unreachable，并点名 15 秒', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    })
    vi.stubGlobal('fetch', vi.fn(async () => { throw timeout }))
    const { call } = setup()

    const result = await call({ url: 'http://127.0.0.1:13761/oauth/callback?code=a' })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('jet-hub/callback-unreachable')
    expect(result.error?.message).toContain('15 秒')
  })

  it('其它网络错误 → callback-unreachable 且原样透出原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up') }))
    const { call } = setup()

    const result = await call({ url: 'http://127.0.0.1:13761/oauth/callback?code=a' })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('jet-hub/callback-unreachable')
    expect(result.error?.message).toContain('socket hang up')
  })

  it('失败一律 ok:false（绝不把错误包成成功）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const { call } = setup()

    const result = await call({ url: 'http://127.0.0.1:1/x' })

    expect(result.ok).toBe(false)
    expect(result.value).toBeUndefined()
  })
})
