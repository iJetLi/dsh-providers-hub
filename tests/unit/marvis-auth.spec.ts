/**
 * Marvis 登录/续期适配层单测（零网络）。
 *
 * 全部走注入：`fetchImpl` 是假 fetch，`store` 是内存替身（形状与宿主
 * `ctx.credentials` 一致，值是字符串），浏览器登录腿用假工厂。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { AccountPool } from '../../src/account-pool.js'
import { MarvisAuth, importCredentialFromMagpie } from '../../src/marvis-auth.js'
import { parseMarvisCredential } from '../../src/marvis.js'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function refKey(ref: { name?: unknown } | string): string {
  if (typeof ref === 'string') return ref
  const name = ref?.name
  return typeof name === 'string' ? name : String(ref)
}

class FakeStore {
  readonly values = new Map<string, string>()
  readonly setCalls: string[] = []

  seed(refName: string, value: string): void {
    this.values.set(refName, value)
  }

  async resolve(ref: { name?: unknown } | string): Promise<{ value: string } | undefined> {
    const value = this.values.get(refKey(ref))
    return value === undefined ? undefined : { value }
  }

  async set(ref: { name?: unknown } | string, value: string): Promise<void> {
    this.setCalls.push(refKey(ref))
    this.values.set(refKey(ref), value)
  }

  async unset(ref: { name?: unknown } | string): Promise<void> {
    this.values.delete(refKey(ref))
  }

  saved(refName: string) {
    const raw = this.values.get(refName)
    return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>)
  }
}

function makeContext(): { ctx: Context; store: FakeStore } {
  const store = new FakeStore()
  const ctx = new Context()
  ;(ctx as unknown as { credentials: FakeStore }).credentials = store
  return { ctx, store }
}

function account(id: string, refName: string, expiresAt?: number) {
  return {
    id,
    provider: 'marvis' as const,
    nickname: '',
    enabled: true,
    credentialRef: refName,
    createdAt: 0,
    refreshable: true,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

class FakePool {
  constructor(private readonly accounts: ReturnType<typeof account>[]) {}
  updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  listAccountsByProvider(): ReturnType<typeof account>[] {
    return this.accounts
  }
  listAllAccounts(): ReturnType<typeof account>[] {
    return this.accounts
  }
  async updateAccount(id: string, patch: Record<string, unknown>): Promise<void> {
    this.updates.push({ id, patch })
  }
  asPool(): AccountPool {
    return this as unknown as AccountPool
  }
}

const MAGPIE_ENTRY = {
  type: 'oauth',
  refresh: 'test-refresh-token-0001',
  access: 'mv-test-access-token',
  expires: 1_796_660_878_059,
  accountId: 'QQ·Jet',
  uid: '864D89036E52CC338D18484131FE053D',
  metadata: {
    openid: '864D89036E52CC338D18484131FE053D',
    guid: 'f4642360411b4132d5917bf04f615b8a',
    loginType: '1',
    nickname: 'Jet',
  },
}

describe('importCredentialFromMagpie', () => {
  it('★ 认 magpie 的 plugin-auth.json 整份（顶层 marvis 键）', () => {
    const credential = importCredentialFromMagpie(JSON.stringify({ marvis: MAGPIE_ENTRY }))
    expect(credential).toMatchObject({
      access_token: 'mv-test-access-token',
      refresh_token: 'test-refresh-token-0001',
      openid: '864D89036E52CC338D18484131FE053D',
      guid: 'f4642360411b4132d5917bf04f615b8a',
      login_type: '1',
      nickname: 'Jet',
      expires_at: '1796660878059',
    })
  })

  it('★ 也认单条 entry（用户只粘了值那一层）', () => {
    expect(importCredentialFromMagpie(JSON.stringify(MAGPIE_ENTRY))?.openid).toBe(
      '864D89036E52CC338D18484131FE053D',
    )
  })

  it('缺 refresh / guid ⇒ undefined（不能造出无法续期的账号）', () => {
    const { refresh: _drop, ...noRefresh } = MAGPIE_ENTRY
    expect(importCredentialFromMagpie(JSON.stringify(noRefresh))).toBeUndefined()
    const { metadata: _m, ...noMeta } = MAGPIE_ENTRY
    expect(importCredentialFromMagpie(JSON.stringify(noMeta))).toBeUndefined()
  })

  it('非 JSON / 空串 ⇒ undefined（不抛错）', () => {
    expect(importCredentialFromMagpie('')).toBeUndefined()
    expect(importCredentialFromMagpie('not json')).toBeUndefined()
  })

  it('trim 掉首尾空白（从文件复制常带换行）', () => {
    expect(importCredentialFromMagpie(`\n  ${JSON.stringify(MAGPIE_ENTRY)}  \n`)?.openid).toBe(
      '864D89036E52CC338D18484131FE053D',
    )
  })
})

describe('parseMarvisCredential', () => {
  it('round-trip：自己写的凭据能读回来', () => {
    const raw = JSON.stringify({
      access_token: 'mv_x',
      refresh_token: 'rt_x',
      openid: 'o',
      guid: 'g',
      login_type: '2',
    })
    expect(parseMarvisCredential(raw)?.login_type).toBe('2')
  })
})

describe('MarvisAuth.exchangeCode', () => {
  it('★ 302 + Set-Cookie 换出凭据（响应体不是 JSON）', async () => {
    const { ctx } = makeContext()
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: [
          ['set-cookie', 'openid=864D; Path=/'],
          ['set-cookie', 'accesstoken=mv_new; Path=/'],
          ['set-cookie', 'refreshtoken=rt_new; Path=/'],
          ['set-cookie', 'nickname=%E6%B5%8B%E8%AF%95; Path=/'],
          ['set-cookie', 'login_type=1; Path=/'],
          ['set-cookie', 'access_token_expire_time=1796660878059; Path=/'],
        ],
      }),
    )
    const auth = new MarvisAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const credential = await auth.exchangeCode({
      code: 'CODE1',
      loginType: '1',
      guid: 'g1',
      state: '0.5',
    })
    expect(credential).toMatchObject({
      access_token: 'mv_new',
      refresh_token: 'rt_new',
      openid: '864D',
      guid: 'g1',
      login_type: '1',
      nickname: '测试',
      expires_at: '1796660878059',
    })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('login_type=QC')
    expect(url).toContain('code=CODE1')
    expect((init.headers as Record<string, string>)['Ual-Access-Guid']).toBe('g1')
    expect(init.redirect).toBe('manual')
  })

  it('★ -109 RC_PARAMS_INVALID ⇒ 抛可读错误（缺少/非法参数）', async () => {
    const { ctx } = makeContext()
    const fetchImpl = vi.fn(async () => jsonResponse({ code: -109, msg: 'RC_PARAMS_INVALID' }))
    const auth = new MarvisAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(
      auth.exchangeCode({ code: 'X', loginType: '1', guid: 'g' }),
    ).rejects.toThrow(/RC_PARAMS_INVALID|登录/)
  })

  it('★ -107 RC_NO_AUTH_ERR ⇒ 抛「授权码已失效」类文案（用户能据此重试）', async () => {
    const { ctx } = makeContext()
    const fetchImpl = vi.fn(async () => jsonResponse({ code: -107, msg: 'RC_NO_AUTH_ERR' }))
    const auth = new MarvisAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(
      auth.exchangeCode({ code: 'X', loginType: '1', guid: 'g' }),
    ).rejects.toThrow(/失效|过期|重新登录/)
  })

  it('302 但没有 accesstoken cookie ⇒ 抛错（不能造出空凭据）', async () => {
    const { ctx } = makeContext()
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 302, headers: { 'set-cookie': 'openid=x' } }),
    )
    const auth = new MarvisAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(
      auth.exchangeCode({ code: 'X', loginType: '1', guid: 'g' }),
    ).rejects.toThrow(/access_token|凭据/)
  })
})

describe('MarvisAuth.fetchUserProfile', () => {
  it('取到昵称与头像', async () => {
    const { ctx } = makeContext()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ret: 0, nick_name: 'Jet', head_img_url: 'https://x/y.png' }),
    )
    const auth = new MarvisAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const profile = await auth.fetchUserProfile({
      access_token: 'mv_x',
      refresh_token: 'rt_x',
      openid: 'o',
      guid: 'g',
      login_type: '1',
    })
    expect(profile).toEqual({ nickname: 'Jet', avatar: 'https://x/y.png' })
  })

  it('★ 失败返回空对象而不抛（昵称只是展示名，不能挡登录）', async () => {
    const { ctx } = makeContext()
    const fetchImpl = vi.fn(async () => jsonResponse({ ret: 1001, msg: 'no' }))
    const auth = new MarvisAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(
      auth.fetchUserProfile({
        access_token: 'mv_x',
        refresh_token: 'rt_x',
        openid: 'o',
        guid: 'g',
        login_type: '1',
      }),
    ).resolves.toEqual({})
  })
})

describe('MarvisAuth.refreshAccountCredential', () => {
  it('★ 续期后写回凭据库并把 expiresAt 写回账号池', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MARVIS_ACCOUNT_A'
    store.seed(
      refName,
      JSON.stringify({
        access_token: 'mv_old',
        refresh_token: 'rt_old',
        openid: 'o',
        guid: 'g',
        login_type: '1',
      }),
    )
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, msg: 'RC_SUCCESS', user_info: { access_token: 'mv_old', expires_in: 3_600 } }),
    )
    const auth = new MarvisAuth(ctx, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
    })
    const pool = new FakePool([account('marvis-a', refName)])
    await auth.refreshAccountCredential(refName, pool.asPool(), 'marvis-a')

    expect(store.setCalls).toEqual([refName])
    const saved = store.saved(refName)
    expect(saved?.access_token).toBe('mv_old')
    // ⚠️ expires_in 是**相对秒** ⇒ 必须换算成绝对毫秒
    expect(saved?.expires_at).toBe(String(1_700_000_000_000 + 3_600_000))
    expect(pool.updates).toEqual([{ id: 'marvis-a', patch: { expiresAt: 1_700_000_000_000 + 3_600_000 } }])
  })

  it('★ 续期响应的 refresh_token 是空串时保留旧值（否则账号变单向门）', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MARVIS_ACCOUNT_A'
    store.seed(
      refName,
      JSON.stringify({
        access_token: 'mv_old',
        refresh_token: 'rt_old',
        openid: 'o',
        guid: 'g',
        login_type: '1',
      }),
    )
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        code: 0,
        user_info: { access_token: 'mv_old', refresh_token: '', expires_in: 60 },
      }),
    )
    const auth = new MarvisAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    await auth.refreshAccountCredential(refName, new FakePool([]).asPool(), 'marvis-a')
    expect(store.saved(refName)?.refresh_token).toBe('rt_old')
  })

  it('业务码非 0 ⇒ 抛错（不写库）', async () => {
    const { ctx, store } = makeContext()
    const refName = 'MARVIS_ACCOUNT_A'
    store.seed(refName, JSON.stringify({ access_token: 'a', refresh_token: 'r', openid: 'o', guid: 'g', login_type: '1' }))
    const fetchImpl = vi.fn(async () => jsonResponse({ code: -107, msg: 'RC_NO_AUTH_ERR' }))
    const auth = new MarvisAuth(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(
      auth.refreshAccountCredential(refName, new FakePool([]).asPool(), 'marvis-a'),
    ).rejects.toThrow()
    expect(store.setCalls).toEqual([])
  })
})

describe('MarvisAuth.loginViaBrowser', () => {
  it('★ 未登完（waitForCallbackUrl 超时）⇒ undefined，不是异常', async () => {
    const { ctx } = makeContext()
    const auth = new MarvisAuth(ctx, {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      browserLoginFactory: async () => ({
        close: () => {},
        waitForCallbackUrl: async () => undefined,
      }),
    })
    await expect(auth.loginViaBrowser('1')).resolves.toBeUndefined()
  })

  it('★ 拿到回调后兑换并补昵称', async () => {
    const { ctx } = makeContext()
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('marvis_oauth')) {
        return new Response(null, {
          status: 302,
          headers: [
            ['set-cookie', 'openid=OPENID1; Path=/'],
            ['set-cookie', 'accesstoken=mv_1; Path=/'],
            ['set-cookie', 'refreshtoken=rt_1; Path=/'],
          ],
        })
      }
      return jsonResponse({ ret: 0, nick_name: 'Jet', head_img_url: 'https://a/b.png' })
    })
    const auth = new MarvisAuth(ctx, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      browserLoginFactory: async () => ({
        close: () => {},
        waitForCallbackUrl: async () =>
          'https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?login_type=QC&code=C1&state=0.5',
      }),
    })
    const credential = await auth.loginViaBrowser('1')
    expect(credential?.nickname).toBe('Jet')
    expect(credential?.access_token).toBe('mv_1')
    expect(credential?.guid).toMatch(/^[0-9a-f]{32}$/)
  })
})
