/**
 * MonkeyCode 网页登录（浏览器登录范式）单测。
 *
 * ⚠️ 本文件**绝不真起浏览器**：`sessionFactory` 一律注入假会话。
 * 真起浏览器的那条路只有 `createChromiumMonkeycodeLogin` 的缺省参数能走到，
 * 单测里唯一允许的用法是 `resolveBrowser: () => undefined`（测「找不到浏览器」）。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  MONKEYCODE_SESSION_COOKIE_NAME,
  createChromiumMonkeycodeLogin,
  monkeycodeLoginHostnamesOf,
  readMonkeycodeSessionCookieViaCdp,
  startMonkeycodeBrowserLogin,
  type MonkeycodeLoginSession,
  type MonkeycodeLoginSessionOptions,
} from '../../src/monkeycode-browser-login.js'

/** 假会话：只实现本模块用到的五个成员。 */
function fakeSession(overrides: Partial<MonkeycodeLoginSession> = {}): MonkeycodeLoginSession {
  return {
    cdp: undefined,
    exited: false,
    start: async () => {},
    dispose: () => {},
    userDataDir: undefined,
    ...overrides,
  }
}

/** 记录 `sessionFactory` 收到的选项（用来断言「窗口可见 / 一次性 profile」）。 */
function recordingFactory(session: MonkeycodeLoginSession): {
  calls: MonkeycodeLoginSessionOptions[]
  factory: (options: MonkeycodeLoginSessionOptions) => Promise<MonkeycodeLoginSession>
} {
  const calls: MonkeycodeLoginSessionOptions[] = []
  return {
    calls,
    factory: async (options: MonkeycodeLoginSessionOptions) => {
      calls.push(options)
      return session
    },
  }
}

/** 造一个 `Storage.getCookies` 的假返回。 */
function cdpWithCookies(cookies: unknown): MonkeycodeLoginSession {
  return fakeSession({ cdp: { send: async () => ({ cookies }) } })
}

describe('readMonkeycodeSessionCookieViaCdp', () => {
  it('没有 cdp 时返回 undefined（不抛）', async () => {
    await expect(readMonkeycodeSessionCookieViaCdp(fakeSession())).resolves.toBeUndefined()
  })

  it('CDP 抛错时返回 undefined（不抛）', async () => {
    const session = fakeSession({
      cdp: { send: async () => { throw new Error('CDP disconnected') } },
    })
    await expect(readMonkeycodeSessionCookieViaCdp(session)).resolves.toBeUndefined()
  })

  it('cookies 不是数组时返回 undefined', async () => {
    await expect(readMonkeycodeSessionCookieViaCdp(cdpWithCookies('nope'))).resolves.toBeUndefined()
    await expect(readMonkeycodeSessionCookieViaCdp(cdpWithCookies(undefined))).resolves.toBeUndefined()
  })

  it('命中同名同域 cookie 时返回其值', async () => {
    const session = cdpWithCookies([
      { name: 'other', value: 'x', domain: '.monkeycode-ai.com' },
      { name: MONKEYCODE_SESSION_COOKIE_NAME, value: 'sess-abc', domain: '.monkeycode-ai.com' },
    ])
    await expect(readMonkeycodeSessionCookieViaCdp(session)).resolves.toBe('sess-abc')
  })

  it('★★ 国际站的 cookie 在国内站判据下读不到，反之亦然（2026-11-02 真机 bug）', async () => {
    // 现场：国际站窗口里已登录（demo-user2 / 基础会员 / 今日额度 10.0M），账号卡却
    // 停在「凭据未配置」。根因有两层，这是第一层 —— 域名判据写死了 `.com`，
    // 于是 `.net` 的 cookie 永远读不到，`waitForSessionCookie` 空转到 240 秒超时。
    const session = cdpWithCookies([
      { name: MONKEYCODE_SESSION_COOKIE_NAME, value: 'sess-net', domain: '.monkeycode-ai.net' },
    ])
    // 缺省（国内站）判据：认不出国际站
    await expect(readMonkeycodeSessionCookieViaCdp(session)).resolves.toBeUndefined()
    // 显式给国际站主机名：立刻读到
    await expect(
      readMonkeycodeSessionCookieViaCdp(session, ['monkeycode-ai.net']),
    ).resolves.toBe('sess-net')
  })

  it('★ 主机名从 product.platformBaseUrl 派生（换域名不必改代码）', () => {
    expect(monkeycodeLoginHostnamesOf({ platformBaseUrl: 'https://monkeycode-ai.com' }))
      .toEqual(['monkeycode-ai.com'])
    expect(monkeycodeLoginHostnamesOf({ platformBaseUrl: 'https://monkeycode-ai.net' }))
      .toEqual(['monkeycode-ai.net'])
    // 非法 URL 不得抛（登录主路径不能在派生这一步炸掉）
    expect(monkeycodeLoginHostnamesOf({ platformBaseUrl: 'not a url' }))
      .toEqual(['monkeycode-ai.com'])
  })

  it('域名必须属于 MonkeyCode（不带点的裸域也算）', async () => {
    const bare = cdpWithCookies([
      { name: MONKEYCODE_SESSION_COOKIE_NAME, value: 'v1', domain: 'monkeycode-ai.com' },
    ])
    await expect(readMonkeycodeSessionCookieViaCdp(bare)).resolves.toBe('v1')

    const sub = cdpWithCookies([
      { name: MONKEYCODE_SESSION_COOKIE_NAME, value: 'v2', domain: 'api.monkeycode-ai.com' },
    ])
    await expect(readMonkeycodeSessionCookieViaCdp(sub)).resolves.toBe('v2')

    // ⚠️ 后缀伪装必须被拒：`evil-monkeycode-ai.com` 不是 MonkeyCode 的域。
    const spoof = cdpWithCookies([
      { name: MONKEYCODE_SESSION_COOKIE_NAME, value: 'v3', domain: 'evil-monkeycode-ai.com' },
    ])
    await expect(readMonkeycodeSessionCookieViaCdp(spoof)).resolves.toBeUndefined()
  })

  it('名字不匹配 / 值为空 的条目跳过', async () => {
    const session = cdpWithCookies([
      { name: 'something_else', value: 'x', domain: '.monkeycode-ai.com' },
      { name: MONKEYCODE_SESSION_COOKIE_NAME, value: '', domain: '.monkeycode-ai.com' },
      { name: MONKEYCODE_SESSION_COOKIE_NAME, value: 42, domain: '.monkeycode-ai.com' },
      null,
      'not-an-object',
    ])
    await expect(readMonkeycodeSessionCookieViaCdp(session)).resolves.toBeUndefined()
  })
})

describe('createChromiumMonkeycodeLogin', () => {
  it('找不到浏览器时抛 browser-not-found（文案含候选清单）', async () => {
    await expect(
      createChromiumMonkeycodeLogin({ resolveBrowser: () => undefined, platform: 'win32' }),
    ).rejects.toMatchObject({
      name: 'BrowserDeploymentError',
      deployKind: 'browser-not-found',
    })
  })

  it('起窗选项必须是「可见窗口 + 一次性 profile + 平台首页」', async () => {
    const { calls, factory } = recordingFactory(fakeSession())
    const login = await createChromiumMonkeycodeLogin({
      executablePath: 'C:\\fake\\chrome.exe',
      sessionFactory: factory,
      readCookie: async () => 'sess-1',
    })
    await login.waitForSessionCookie(5_000)

    expect(calls).toHaveLength(1)
    expect(calls[0].hideWindow).toBe(false)
    expect(calls[0].profilePrefix).toBe('monkeycode-login-')
    expect(calls[0].initialUrl).toBe('https://monkeycode-ai.com')
    login.close()
  })

  it('起窗失败时必须 dispose 会话再把错误抛上去', async () => {
    const dispose = vi.fn()
    const session = fakeSession({
      start: async () => { throw new Error('spawn failed') },
      dispose,
    })
    await expect(
      createChromiumMonkeycodeLogin({
        executablePath: 'C:\\fake\\chrome.exe',
        sessionFactory: async () => session,
      }),
    ).rejects.toThrow('spawn failed')
    // ⚠️ 不 dispose 会在 %TEMP% 留下 monkeycode-login-* 目录（每次失败一个）。
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('读到 cookie 即返回', async () => {
    const login = await createChromiumMonkeycodeLogin({
      executablePath: 'C:\\fake\\chrome.exe',
      sessionFactory: async () => fakeSession(),
      readCookie: async () => 'sess-ok',
    })
    await expect(login.waitForSessionCookie(5_000)).resolves.toBe('sess-ok')
    login.close()
  })

  it('一直读不到时按超时返回 undefined（不抛）', async () => {
    let clock = 0
    const login = await createChromiumMonkeycodeLogin({
      executablePath: 'C:\\fake\\chrome.exe',
      sessionFactory: async () => fakeSession(),
      readCookie: async () => undefined,
      // 每次问时间就前进 600ms，1 秒预算 ⇒ 第二轮即超时（零真实等待）。
      now: () => (clock += 600),
      sleep: async () => {},
    })
    await expect(login.waitForSessionCookie(1_000)).resolves.toBeUndefined()
    login.close()
  })

  it('用户关掉窗口后立刻放弃（不等满超时）', async () => {
    const holder = { exited: false }
    const logs: string[] = []
    const session: MonkeycodeLoginSession = {
      cdp: undefined,
      get exited() { return holder.exited },
      start: async () => {},
      dispose: () => {},
      userDataDir: undefined,
    }
    const login = await createChromiumMonkeycodeLogin({
      executablePath: 'C:\\fake\\chrome.exe',
      sessionFactory: async () => session,
      readCookie: async () => {
        holder.exited = true
        return undefined
      },
      sleep: async () => {},
      log: (message) => logs.push(message),
    })
    await expect(login.waitForSessionCookie(60_000)).resolves.toBeUndefined()
    expect(logs.some((line) => line.includes('浏览器窗口已关闭'))).toBe(true)
    login.close()
  })

  it('close 幂等，关闭后等待立刻返回 undefined', async () => {
    const dispose = vi.fn()
    const login = await createChromiumMonkeycodeLogin({
      executablePath: 'C:\\fake\\chrome.exe',
      sessionFactory: async () => fakeSession({ dispose }),
      readCookie: async () => 'late',
    })
    login.close()
    login.close()
    expect(dispose).toHaveBeenCalledTimes(1)
    // ⚠️ 收窗后必须立刻放弃：否则 close() 之后还要空转到超时。
    await expect(login.waitForSessionCookie(60_000)).resolves.toBeUndefined()
  })
})

describe('startMonkeycodeBrowserLogin', () => {
  it('把 sessionFactory 透传给 createChromiumMonkeycodeLogin', async () => {
    const { calls, factory } = recordingFactory(fakeSession())
    const login = await startMonkeycodeBrowserLogin({ sessionFactory: factory })
    expect(calls).toHaveLength(1)
    login.close()
  })
})
