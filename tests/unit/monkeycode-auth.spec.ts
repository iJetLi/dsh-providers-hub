/**
 * MonkeyCode 网页登录（auth 层）单测。
 *
 * ⚠️ 这里**绝不起浏览器、绝不发网络请求**：`browserLoginFactory` 与 `exchangeKey`
 * 全部注入。真起浏览器的那条路在 `monkeycode-browser-login.spec.ts` 里也只测假会话。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { MonkeycodeAuth } from '../../src/monkeycode-auth.js'
import type { MonkeycodeBrowserLogin } from '../../src/monkeycode-browser-login.js'
import { MONKEYCODE, MONKEYCODE_INTL } from '../../src/monkeycode-product.js'

type AuthOptions = ConstructorParameters<typeof MonkeycodeAuth>[1]

/** 假登录窗口：`waitForSessionCookie` 直接给结果，`close` 记次数。 */
function fakeLogin(cookie: string | undefined): {
  login: MonkeycodeBrowserLogin
  close: ReturnType<typeof vi.fn>
} {
  const close = vi.fn()
  return {
    close,
    login: {
      close,
      waitForSessionCookie: async () => cookie,
    },
  }
}

function makeAuth(options: AuthOptions): MonkeycodeAuth {
  return new MonkeycodeAuth(new Context(), options)
}

describe('MonkeycodeAuth.loginViaBrowser', () => {
  it('读到会话后换成网关凭据（channel 固定 gateway）', async () => {
    const { login, close } = fakeLogin('sess-1')
    const exchangeKey = vi.fn(async () => ({
      ok: true as const,
      // ⚠️ `keyId` 是**每签发一把 Key 就变**的记录 id，不是账号身份；
      //    账号身份走 `profileOf`（见下一条断言）。
      key: { apiKey: 'oma_abc', signingSecret: 'sec-1', keyId: 'k-1' },
    }))
    const profileOf = vi.fn(async () => ({ userId: 'u-1', nickname: '水' }))
    const auth = makeAuth({
      browserLoginFactory: async () => login,
      exchangeKey,
      profileOf,
    })

    await expect(auth.loginViaBrowser()).resolves.toEqual({
      access_token: 'oma_abc',
      signing_secret: 'sec-1',
      session_cookie: 'sess-1',
      // ⚠️ ★★ `user_id` 必须来自 `/users/status` 的稳定 id，**不是**换 Key 响应
      //    的 `keyId`（真机实测同一账号两次兑换得到两个不同 id ⇒ 取错会让
      //    「同账号第二次登录」被判成新账号）。
      user_id: 'u-1',
      nickname: '水',
    })
    expect(profileOf).toHaveBeenCalledWith('sess-1', MONKEYCODE, expect.anything())
    // ⚠️ 第三个参数是 `product`，**不能省**（2026-11-02 国际站真机 bug）：
    //    省掉就落到缺省 `MONKEYCODE`（国内站），国际站的 cookie 会打到 `.com`
    //    的换 Key 接口 ⇒ 恒 401 ⇒ 被判成「还没登进去」⇒ 重试到超时。
    expect(exchangeKey).toHaveBeenCalledWith('sess-1', expect.anything(), MONKEYCODE)
    // ⚠️ 窗口必须在 finally 里收掉：不调就留下窗口 + 进程 + %TEMP% 目录。
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('★★ 国际站实例把 MONKEYCODE_INTL 交给换 Key 原语（换错站 = 恒 401 = 凭据永远不落库）', async () => {
    const { login } = fakeLogin('sess-intl')
    const exchangeKey = vi.fn(async () => ({
      ok: true as const,
      key: { apiKey: 'oma_intl', signingSecret: 'sec-intl' },
    }))
    const auth = makeAuth({
      product: MONKEYCODE_INTL,
      browserLoginFactory: async () => login,
      exchangeKey,
      // 登录成功后还会读一次平台用户资料（稳定 user_id）——注入，绝不发真网络。
      profileOf: async () => ({ userId: 'u-intl' }),
    })

    await expect(auth.loginViaBrowser()).resolves.toMatchObject({
      access_token: 'oma_intl',
      signing_secret: 'sec-intl',
      session_cookie: 'sess-intl',
    })
    expect(
      exchangeKey,
      '国际站必须打 .net 的换 Key 接口；传成国内站就是「浏览器窗口里已登录、账号卡却永远凭据未配置」',
    ).toHaveBeenCalledWith('sess-intl', expect.anything(), MONKEYCODE_INTL)
  })

  it('用户没登完（cookie 为 undefined）时返回 undefined 且不换凭据', async () => {
    const { login, close } = fakeLogin(undefined)
    const exchangeKey = vi.fn()
    const auth = makeAuth({
      browserLoginFactory: async () => login,
      exchangeKey: exchangeKey as never,
    })

    await expect(auth.loginViaBrowser()).resolves.toBeUndefined()
    expect(exchangeKey).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('换凭据失败时**抛错**（不能退化成只有 cookie 的账号）', async () => {
    const { login, close } = fakeLogin('sess-1')
    const auth = makeAuth({
      browserLoginFactory: async () => login,
      // ⚠️ 用 500 而不是 401/403：401/403 现在归「会话还没生效」，会进重试循环。
      exchangeKey: async () => ({ ok: false as const, error: 'HTTP 500' }),
    })

    await expect(auth.loginViaBrowser()).rejects.toThrow(/换取网关凭据失败（HTTP 500）/)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('会话还没生效（401）时继续等待，用户登录完成后成功建号', async () => {
    const { login, close } = fakeLogin('sess-1')
    let attempt = 0
    const auth = makeAuth({
      browserLoginFactory: async () => login,
      exchangeKey: async () => {
        attempt += 1
        // 第一次是窗口刚打开时的匿名会话（真机踩到的 401），第二次才是用户登完的会话。
        if (attempt === 1) return { ok: false as const, error: '网页登录态未生效（HTTP 401）' }
        return { ok: true as const, key: { apiKey: 'oma_test', signingSecret: 'sec_test' } }
      },
      // 成功路径会再读一次用户资料；注入以免单测真发网络。
      profileOf: async () => ({ userId: 'u-1' }),
    })

    await expect(auth.loginViaBrowser()).resolves.toMatchObject({
      access_token: 'oma_test',
    })
    expect(attempt).toBe(2)
    expect(close).toHaveBeenCalledTimes(1)
  }, 20_000)

  it('一直停在匿名会话 ⇒ 超时报「还没有完成登录」', async () => {
    const { login, close } = fakeLogin('sess-1')
    const auth = makeAuth({
      browserLoginFactory: async () => login,
      exchangeKey: async () => ({ ok: false as const, error: '网页登录态未生效（HTTP 401）' }),
    })

    await expect(auth.loginViaBrowser({ timeoutMs: 0 })).rejects.toThrow(/还没有完成登录/)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('等待期间被登出 ⇒ 返回 undefined，且不写凭据', async () => {
    const { login, close } = fakeLogin('sess-1')
    const exchangeKey = vi.fn()
    const auth = makeAuth({
      // ⚠️ 登出发生在「等用户登录」期间：这是分钟级窗口，完全可能。
      browserLoginFactory: async () => {
        await auth.logout()
        return login
      },
      exchangeKey: exchangeKey as never,
    })

    await expect(auth.loginViaBrowser()).resolves.toBeUndefined()
    expect(exchangeKey).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('起窗失败时把错误抛上去', async () => {
    const auth = makeAuth({
      browserLoginFactory: async () => {
        throw new Error('browser-not-found')
      },
    })
    await expect(auth.loginViaBrowser()).rejects.toThrow('browser-not-found')
  })

  it('缺省 timeoutMs 落成 240 秒（重试循环要自己算出 deadline）', async () => {
    const { login } = fakeLogin(undefined)
    let received: { timeoutMs?: number } | undefined
    const auth = makeAuth({
      browserLoginFactory: async (options) => {
        received = options as { timeoutMs?: number }
        return login
      },
    })
    await auth.loginViaBrowser()
    expect(received?.timeoutMs).toBe(240_000)
  })

  it('显式 timeoutMs 会透传给登录模块', async () => {
    const { login } = fakeLogin(undefined)
    let received: { timeoutMs?: number } | undefined
    const auth = makeAuth({
      browserLoginFactory: async (options) => {
        received = options as { timeoutMs?: number }
        return login
      },
    })
    await auth.loginViaBrowser({ timeoutMs: 90_000 })
    expect(received?.timeoutMs).toBe(90_000)
  })
})
