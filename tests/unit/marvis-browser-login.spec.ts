import { describe, expect, it, vi } from 'vitest'

import {
  authorizeUrlOf,
  createChromiumMarvisLogin,
  isMarvisCallbackUrl,
  MARVIS_CALLBACK_PAGE,
} from '../../src/marvis-browser-login.js'
import { MARVIS_REDIRECT_URI } from '../../src/marvis.js'

describe('authorizeUrlOf', () => {
  const guid = 'fedcba9876543210fedcba9876543210'

  it('★ QQ 走 graph.qq.com，且 login_type 在 redirect_uri 的 query 里', () => {
    const url = new URL(authorizeUrlOf('1', guid, '0.5'))
    expect(url.origin + url.pathname).toBe('https://graph.qq.com/oauth2.0/authorize')
    expect(url.searchParams.get('client_id')).toBe('1903794758')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBeNull()
    // ⚠️ 回调地址本身带 `?login_type=QC`，再被 encode 进 redirect_uri
    expect(url.searchParams.get('redirect_uri')).toBe(`${MARVIS_REDIRECT_URI}?login_type=QC`)
    // ⚠️ QQ 的 state 必须是**小数**（magpie 实测：整数会被上游拒）
    expect(url.searchParams.get('state')).toBe('0.5')
    expect(url.searchParams.get('which')).toBe('Login')
    expect(url.searchParams.get('display')).toBe('pc')
  })

  it('★ 微信走 open.weixin.qq.com，state 是设备 guid', () => {
    const url = new URL(authorizeUrlOf('2', guid))
    expect(url.origin + url.pathname).toBe('https://open.weixin.qq.com/connect/qrconnect')
    expect(url.searchParams.get('appid')).toBe('wxb650708317d56f88')
    expect(url.searchParams.get('scope')).toBe('snsapi_login')
    expect(url.searchParams.get('redirect_uri')).toBe(`${MARVIS_REDIRECT_URI}?login_type=WX`)
    expect(url.searchParams.get('state')).toBe(guid)
  })

  it('QQ 未给 state 时自己造一个小数（不能是空串）', () => {
    const state = new URL(authorizeUrlOf('1', guid)).searchParams.get('state') ?? ''
    expect(state).toMatch(/^0\.\d+$/)
  })
})

describe('isMarvisCallbackUrl', () => {
  const callback = `${MARVIS_REDIRECT_URI}?login_type=QC&code=ABC123&state=0.5`

  it('认回调 URL', () => {
    expect(isMarvisCallbackUrl(callback)).toBe(true)
  })

  it('认错误回调（用户拒绝授权时带 error=）', () => {
    expect(isMarvisCallbackUrl(`${MARVIS_REDIRECT_URI}?login_type=QC&error=access_denied`)).toBe(
      true,
    )
  })

  it('★ 没有 code / error 的同一路径**不**算回调（否则页面刚打开就「登录成功」）', () => {
    expect(isMarvisCallbackUrl(MARVIS_REDIRECT_URI)).toBe(false)
    expect(isMarvisCallbackUrl(`${MARVIS_REDIRECT_URI}?login_type=QC`)).toBe(false)
  })

  it('别的路径不算', () => {
    expect(isMarvisCallbackUrl('https://graph.qq.com/oauth2.0/show?code=1')).toBe(false)
  })

  it('路径大小写不敏感（query 键仍按原样认，上游不会大写 code）', () => {
    const upperPath = callback.replace(
      '/marvis_client_login/marvis_oauth',
      '/MARVIS_CLIENT_LOGIN/MARVIS_OAUTH',
    )
    expect(isMarvisCallbackUrl(upperPath)).toBe(true)
  })

  it('非法 URL 不抛错（CDP 给的是字符串，垃圾数据是常态）', () => {
    expect(() => isMarvisCallbackUrl('http://[::1')).not.toThrow()
    expect(isMarvisCallbackUrl('http://[::1')).toBe(false)
  })

  it('matcher 覆盖默认路径判据（保留给上游换路径的情况）', () => {
    expect(isMarvisCallbackUrl('https://example.com/x?code=1', /example\.com\/x/i)).toBe(true)
  })
})

describe('MARVIS_CALLBACK_PAGE', () => {
  it('是一段自包含的完成页（不能再加载任何外网资源）', () => {
    expect(MARVIS_CALLBACK_PAGE).toContain('<!doctype html>')
    expect(MARVIS_CALLBACK_PAGE).toContain('Marvis')
  })
})

/** 假 CDP：记录 send、手动投递事件。 */
function createFakeSession() {
  const sent: Array<{ method: string; params: unknown }> = []
  let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined
  let disposed = false
  const session = {
    cdp: {
      async send(method: string, params?: unknown) {
        sent.push({ method, params })
        return {}
      },
      subscribe(fn: (event: { method: string; params: Record<string, unknown> }) => void) {
        listener = fn
        return () => {
          listener = undefined
        }
      },
    },
    get exited() {
      return disposed
    },
    async start() {},
    dispose() {
      disposed = true
    },
    userDataDir: undefined as string | undefined,
  }
  return { session, sent, emit: (e: { method: string; params: Record<string, unknown> }) => listener?.(e) }
}

describe('createChromiumMarvisLogin', () => {
  const baseDeps = {
    executablePath: 'C:/chrome.exe',
    resolveBrowser: () => 'C:/chrome.exe',
    sleep: async () => {},
  }

  it('★ 打开授权页 + 开 Fetch 域（Request 阶段截停）', async () => {
    const { session, sent } = createFakeSession()
    const login = await createChromiumMarvisLogin({
      ...baseDeps,
      loginType: '1',
      guid: 'fedcba9876543210fedcba9876543210',
      state: '0.5',
      sessionFactory: async () => session,
    })
    expect(sent.map((s) => s.method)).toContain('Fetch.enable')
    const enable = sent.find((s) => s.method === 'Fetch.enable')
    expect(enable?.params).toEqual({
      patterns: [{ urlPattern: '*marvis_oauth*', requestStage: 'Request' }],
    })
    login.close()
  })

  it('★ 回调请求被 fulfill 成静态页（code 保持未消费），并交回 URL', async () => {
    const { session, sent, emit } = createFakeSession()
    const login = await createChromiumMarvisLogin({
      ...baseDeps,
      loginType: '1',
      guid: 'g',
      sessionFactory: async () => session,
    })
    const callback = `${MARVIS_REDIRECT_URI}?login_type=QC&code=abc&state=0.5`
    emit({
      method: 'Fetch.requestPaused',
      params: { requestId: 'r1', request: { url: callback } },
    })
    expect(await login.waitForCallbackUrl(1_000)).toBe(callback)
    const fulfill = sent.find((s) => s.method === 'Fetch.fulfillRequest')
    expect(fulfill).toBeDefined()
    expect((fulfill?.params as { responseCode: number }).responseCode).toBe(200)
    login.close()
  })

  it('非回调请求放行（continueRequest）', async () => {
    const { session, sent, emit } = createFakeSession()
    const login = await createChromiumMarvisLogin({
      ...baseDeps,
      loginType: '2',
      guid: 'g',
      sessionFactory: async () => session,
    })
    emit({
      method: 'Fetch.requestPaused',
      params: { requestId: 'r2', request: { url: 'https://graph.qq.com/favicon.ico' } },
    })
    expect(sent.some((s) => s.method === 'Fetch.continueRequest')).toBe(true)
    login.close()
  })

  it('★ 超时返回 undefined（用户没登完是正常路径，不抛错）', async () => {
    const { session } = createFakeSession()
    const login = await createChromiumMarvisLogin({
      ...baseDeps,
      loginType: '1',
      guid: 'g',
      sessionFactory: async () => session,
      now: () => 0,
    })
    expect(await login.waitForCallbackUrl(1_000)).toBeUndefined()
    login.close()
  })

  /**
   * ⚠️ 2026-11-10 对抗性审计 I3：这条守卫原来的写法（`now: () => 0` + 1 秒
   * 超时）**测不到** —— 注入的 `now` 根本没被读，而 1 秒 ≪ 5 秒默认超时，
   * 把「累计等待」改成比较时钟也照样绿。
   * 真正有牙的判据是：**no-op sleep 下循环次数必须是有限的 `timeout / poll`**
   * —— 按墙钟等待的实现在这里会一直转下去（用例挂死）。
   */
  it('★★ 超时按「累计等待」算：no-op sleep 下循环次数 = timeout / poll', async () => {
    const { session } = createFakeSession()
    const sleep = vi.fn(async () => {})
    const login = await createChromiumMarvisLogin({
      ...baseDeps,
      loginType: '1',
      guid: 'g',
      sessionFactory: async () => session,
      sleep,
      pollIntervalMs: 500,
      now: () => 0,
    })
    expect(await login.waitForCallbackUrl(1_000)).toBeUndefined()
    expect(sleep).toHaveBeenCalledTimes(2)
    login.close()
  })

  it('close() 幂等', async () => {
    const { session } = createFakeSession()
    const login = await createChromiumMarvisLogin({
      ...baseDeps,
      loginType: '1',
      guid: 'g',
      sessionFactory: async () => session,
    })
    login.close()
    expect(() => login.close()).not.toThrow()
  })

  it('找不到浏览器时抛 browser-not-found（文案带分平台提示）', async () => {
    await expect(
      createChromiumMarvisLogin({ resolveBrowser: () => undefined, loginType: '1', guid: 'g' }),
    ).rejects.toMatchObject({ deployKind: 'browser-not-found' })
  })
})
