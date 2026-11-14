/**
 * Qoder「网页会话」（Cookie）的**守卫**：归一化、外泄面、接线。
 *
 * ## 为什么单独一个文件
 *
 * 2026-11-14 对 PR #74 做独立复核时实测出一个 **P1**：
 *
 * - 用户把 Cookie 粘成**两行**（长的 Cookie 在开发者工具里会折行，很自然），
 *   `normalizeCookieInput` 只按 `;` 切 ⇒ 换行被原样留在头值里；
 * - `fetch` 收到带 `\n` 的头值 ⇒ 直接抛
 *   `Headers.append: "<整个头值>" is an invalid header value.` ——
 *   **错误消息原样引用了整个 Cookie**；
 * - 那条消息被拼进 `reason`，而 `reason` 有两条去向：
 *   ① `qoder.setWebSession` 的 `fail(web.reason)`（**用户屏幕上**）
 *   ② credits 端点的 `ctx.logger.warn(...)`（**落盘日志**）。
 *
 * 即：直接违反 `src/qoder-web-usage.ts` 自己写的红线「绝不下发客户端、绝不写
 * 日志或错误消息」。本文件把「不外泄」写成断言，并把四处**零覆盖**的接线
 * （RPC / `accounts.status` 布尔 / `removeAccount` 清理 / 客户端弹窗）里
 * 服务端那三处补上。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import { handleQoderRpc } from '../../src/qoder-rpc.js'
import {
  fetchQoderWebPackages,
  loadQoderWebStore,
  normalizeCookieInput,
  redactQoderCookie,
  withQoderWebSessionFlag,
  type QoderWebCredentials,
} from '../../src/qoder-web-usage.js'

/**
 * `qoder-rpc.ts` 用 `qoderFetchForAccount(id)` 取 fetcher（走 per-账号代理）。
 * 单测里换成可控替身 —— 否则会真发 HTTPS 到 qoder.com。
 */
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/qoder-proxy.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/qoder-proxy.js')>(),
  qoderFetchForAccount: () => fetchMock,
}))

const DAY = 86_400_000
const NOW = Date.now()

/** 上游网页明细的**最小**形状：只要一行「带到期时间、剩余 > 0」的资源包。 */
function webBody(details: unknown[] | null) {
  return {
    user_id: 'u-1',
    quota_key: 'big_model_credits',
    status: 'active',
    resource_package_quota: {
      quota_summary: { used_value: 0, limit_value: 600, remaining_value: 600, unit: 'credits' },
      quota_detail: details,
    },
  }
}

/** 一笔「30 天后到期、剩 100」的资源包（`expires_at` 用**秒**，上游就是秒）。 */
function oneGrant(): Record<string, unknown> {
  return {
    id: 'p-1',
    limit_value: 100,
    used_value: 0,
    remaining_value: 100,
    expires_at: Math.floor((NOW + 30 * DAY) / 1000),
    source: 'RESOURCE_PACKAGE',
    status: 'QUOTA_DETAIL_STATUS_ACTIVE',
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface CredentialsFixture {
  map: Map<string, string>
  credentials: QoderWebCredentials
}

function makeCredentials(): CredentialsFixture {
  const map = new Map<string, string>()
  const credentials: QoderWebCredentials = {
    // ⚠️ `resolve` 的返回是 `{ value } | null | undefined`（**不是**裸字符串）——
    // 第一版按裸串写，`JSON.parse(undefined)` 被 `loadQoderWebStore` 的 catch 吞掉
    // ⇒ 「已存 Cookie」的用例全绿、断言全红（假绿的反面：静默返回空 store）。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolve: (async (ref: any) => {
      const value = map.get(String(ref))
      return value === undefined ? undefined : { value }
    }) as QoderWebCredentials['resolve'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set: (async (ref: any, value: string) => { map.set(String(ref), value) }) as QoderWebCredentials['set'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unset: (async (ref: any) => { map.delete(String(ref)) }) as QoderWebCredentials['unset'],
  }
  return { map, credentials }
}

function makePool(accounts: ReadonlyArray<{ id: string; provider: string; credentialRef: string }>) {
  return {
    setQoderProxy: async () => {},
    listAccountsByProvider: (provider: string) =>
      accounts
        .filter((account) => account.provider === provider)
        .map((account) => ({ id: account.id, credentialRef: account.credentialRef })),
  }
}

beforeEach(() => {
  // ⚠️ 必须清调用记录：`fetchMock` 是**模块级**的，不清的话
  // 「不该发请求」的断言会被上一个用例的调用打红。
  fetchMock.mockReset()
})

describe('Cookie 归一化：换行必须当**分隔符**用（2026-11-14 审计 P1）', () => {
  it('★★★ 两行粘贴（无分号）必须归一成一个合法 Cookie，不许留 `\\n`', () => {
    const normalized = normalizeCookieInput('a=SECRET1\nc2=SECRET2')

    expect(normalized).toBe('a=SECRET1; c2=SECRET2')
    // 反向对照：整串里一个控制字符都不许有（有的话 fetch 必抛、且消息会引用它）
    expect(/[\u0000-\u001f\u007f]/.test(normalized)).toBe(false)
  })

  it('★★★ CRLF 同理（Windows 上从 DevTools 复制就是 `\\r\\n`）', () => {
    expect(normalizeCookieInput('a=1\r\nb=2')).toBe('a=1; b=2')
  })

  it('★★ 混合分隔符（既有 `;` 又有换行）也要收敛成 `; `', () => {
    expect(normalizeCookieInput('a=1; b=2\nc=3')).toBe('a=1; b=2; c=3')
  })

  it('★★ 控制字符所在的那一段整段丢弃（不接受「带病值」）', () => {
    // ⚠️ 这条用例的形状是**变异逼出来的**：第一版写 `'a=1\n\u0000\u0001\nb=2'`，
    // 而 `\u0000\u0001` 那一段本来就过不了 `/^[^=\s;]+=/`（没有 `=`）⇒
    // 关掉控制字符过滤照样绿（**等价变异**，不是有牙）。真正能打中这条过滤的
    // 形状是「控制字符 + 合法 `k=v`」—— 整段必须丢，而不是把控制字符留着发上去。
    const normalized = normalizeCookieInput('a=1\n\u0000evil=2')

    expect(normalized).toBe('a=1')
    expect(/[\u0000-\u001f\u007f]/.test(normalized)).toBe(false)
  })

  it('★ 纯空白的行不产生空段（否则头值里出现 `; ; `）', () => {
    expect(normalizeCookieInput('a=1\n\n\nb=2')).toBe('a=1; b=2')
  })

  it('★ cURL 形态仍然优先（`-H \'cookie: …\'` 里的换行不参与切分）', () => {
    expect(normalizeCookieInput(`curl 'https://qoder.com/x' -H 'cookie: a=1; b=2'`)).toBe('a=1; b=2')
  })
})

describe('存量坏值：凭据库里已存的两行 Cookie 读出来必须已归一', () => {
  it('★★★ `normalizeStore` 必须过 `cleanCookie`（旧版本写进去的坏值不能每次都崩）', async () => {
    // 修复只在写入侧做的话，**已经落盘**的坏值会一直被读出来当请求头用 ——
    // 而它每次都会让 fetch 抛错（且错误消息引用整个值）。读取侧也要收口。
    const { credentials, map } = makeCredentials()
    map.set('QODER_ACCOUNT_1_web', JSON.stringify({ cookie: 'a=1\r\nb=2' }))

    const store = await loadQoderWebStore(credentials, 'QODER_ACCOUNT_1')

    expect(store.cookie).toBe('a=1; b=2')
  })
})

describe('redactQoderCookie：出错文案里的 Cookie 必须抹掉', () => {
  const COOKIE = 'a=SECRET1; c2=SECRET2'

  it('★★★ 整串出现 ⇒ 整串换 `***`（不留任何片段）', () => {
    const redacted = redactQoderCookie(`Headers.append: "${COOKIE}" is an invalid header value.`, COOKIE)

    expect(redacted).toContain('***')
    expect(redacted).not.toContain('SECRET1')
    expect(redacted).not.toContain('SECRET2')
  })

  it('★★★ 只出现**一段**（8 字符窗口）也要抹 —— 宁可多抹不可漏', () => {
    // 模拟「错误消息只引用了头值的前半段」
    const redacted = redactQoderCookie('bad value: a=SECRET', COOKIE)

    expect(redacted).not.toContain('SECRET')
  })

  it('★★ 空 Cookie / 空文本 ⇒ 原样（不许把正常文案打碎）', () => {
    expect(redactQoderCookie('hello', '')).toBe('hello')
    expect(redactQoderCookie('', COOKIE)).toBe('')
  })
})

describe('★★★ 网络异常分支：`reason` 里不许出现 Cookie（P1 的守卫）', () => {
  it('★★★ 真 undici 的报文形态（`Headers.append: "<头值>" …`）⇒ reason 必须脱敏', async () => {
    // ⚠️ 这里刻意用**带换行**的 Cookie 直接调（绕过 normalizeCookieInput）：
    // 存量坏值也会走到同一条路径，守卫必须打在 fetchQoderWebPackages 里。
    const cookie = 'a=SECRET1\r\nX-Evil: 1'
    fetchMock.mockRejectedValueOnce(
      new Error(`Headers.append: "${cookie}" is an invalid header value.`),
    )

    const result = await fetchQoderWebPackages(cookie, QODER, fetchMock as never)

    expect(result.ok).toBe(false)
    const reason = (result as { reason: string }).reason
    expect(reason).toContain('网络异常')
    expect(reason).toContain('***')
    expect(reason).not.toContain('SECRET1')
    expect(reason).not.toContain('X-Evil')
    // 换行也必须被压成空格 —— 否则日志被截成两行、第二行看起来像新日志
    expect(reason).not.toContain('\n')
    expect(reason).not.toContain('\r')
  })

  it('★★ 非 Error 抛出（`String(error)` 分支）同样脱敏', async () => {
    fetchMock.mockRejectedValueOnce('a=SECRET1 被拒绝')

    const result = await fetchQoderWebPackages('a=SECRET1', QODER, fetchMock as never)

    expect((result as { reason: string }).reason).not.toContain('SECRET1')
  })

  it('★ 文案长度有上界（200 字符），不许把整个头值原样铺满屏幕', async () => {
    const cookie = `a=${'x'.repeat(5000)}`
    fetchMock.mockRejectedValueOnce(new Error(`bad ${cookie}`))

    const reason = ((await fetchQoderWebPackages(cookie, QODER, fetchMock as never)) as { reason: string }).reason

    expect(reason.length).toBeLessThanOrEqual(200)
  })
})

describe('withQoderWebSessionFlag：只下发布尔值', () => {
  it('★★★ 有 Cookie ⇒ `qoderWebSession: true`，且**返回值里不含 Cookie 明文**', async () => {
    const { credentials, map } = makeCredentials()
    map.set('QODER_ACCOUNT_1_web', JSON.stringify({ cookie: 'a=SECRET1' }))

    const accounts = await withQoderWebSessionFlag([{ id: 'q-1', credentialRef: 'QODER_ACCOUNT_1' }], credentials)

    expect(accounts[0]).toEqual({ id: 'q-1', credentialRef: 'QODER_ACCOUNT_1', qoderWebSession: true })
    // 红线：整份返回值序列化后都不许出现 Cookie
    expect(JSON.stringify(accounts)).not.toContain('SECRET1')
  })

  it('★★ 没有 Cookie ⇒ **不加键**（不是 `false`）', async () => {
    const { credentials } = makeCredentials()

    const accounts = await withQoderWebSessionFlag([{ id: 'q-1', credentialRef: 'QODER_ACCOUNT_1' }], credentials)

    expect(Object.hasOwn(accounts[0]!, 'qoderWebSession')).toBe(false)
  })

  it('★ 多个账号各自独立判定（不能一真全真）', async () => {
    const { credentials, map } = makeCredentials()
    map.set('QODER_ACCOUNT_2_web', JSON.stringify({ cookie: 'b=2' }))

    const accounts = await withQoderWebSessionFlag([
      { id: 'q-1', credentialRef: 'QODER_ACCOUNT_1' },
      { id: 'q-2', credentialRef: 'QODER_ACCOUNT_2' },
    ], credentials)

    expect(accounts[0]!.qoderWebSession).toBeUndefined()
    expect(accounts[1]!.qoderWebSession).toBe(true)
  })
})

describe('`qoder.setWebSession` RPC 接线（原本零覆盖）', () => {
  const ACCOUNTS = [{ id: 'q-1', provider: QODER.id, credentialRef: 'QODER_ACCOUNT_1' }]

  it('★★ 保存成功 ⇒ 写入 `<ref>_web`，返回 `{ saved: true, packages }`', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(webBody([oneGrant()])))
    const { credentials, map } = makeCredentials()

    const result = await handleQoderRpc(
      { credentials } as never,
      makePool(ACCOUNTS) as never,
      'qoder.setWebSession',
      { accountId: 'q-1', cookie: 'a=1' },
    ) as { ok: boolean; value?: { saved: boolean; packages: number } }

    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ saved: true, packages: 1 })
    expect(map.get('QODER_ACCOUNT_1_web')).toContain('a=1')
  })

  it('★★★ 401 ⇒ 返回失败，且**绝不落盘**（粘错的 Cookie 不许留）', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
    const { credentials, map } = makeCredentials()

    const result = await handleQoderRpc(
      { credentials } as never,
      makePool(ACCOUNTS) as never,
      'qoder.setWebSession',
      { accountId: 'q-1', cookie: 'a=1' },
    ) as { ok: boolean; error?: { message: string } }

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('网页会话已失效')
    expect(map.has('QODER_ACCOUNT_1_web')).toBe(false)
  })

  it('★★★ 失败文案经 RPC 出口时也不含 Cookie 明文（P1 的第二条去向）', async () => {
    const cookie = 'a=SECRET1\r\nX-Evil: 1'
    fetchMock.mockRejectedValueOnce(new Error(`Headers.append: "${cookie}" is an invalid header value.`))
    const { credentials } = makeCredentials()

    const result = await handleQoderRpc(
      { credentials } as never,
      makePool(ACCOUNTS) as never,
      'qoder.setWebSession',
      { accountId: 'q-1', cookie },
    ) as { ok: boolean; error?: { message: string } }

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('SECRET1')
    expect(JSON.stringify(result)).not.toContain('X-Evil')
  })

  it('★★ 空串 ⇒ 清除会话但**保留领取记录**（grants 与 cookie 是两个概念）', async () => {
    const { credentials, map } = makeCredentials()
    map.set('QODER_ACCOUNT_1_web', JSON.stringify({
      cookie: 'a=1',
      grants: [{ amount: 100, expiresAtMs: NOW + DAY }],
    }))

    const result = await handleQoderRpc(
      { credentials } as never,
      makePool(ACCOUNTS) as never,
      'qoder.setWebSession',
      { accountId: 'q-1', cookie: '' },
    ) as { ok: boolean; value?: { saved: boolean } }

    expect(result.value).toEqual({ saved: false, packages: 0 })
    const store = await loadQoderWebStore(credentials, 'QODER_ACCOUNT_1')
    expect(store.cookie).toBeUndefined()
    expect(store.grants).toEqual([{ amount: 100, expiresAtMs: NOW + DAY }])
    // 清除时一个请求都不该发
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('★★ 缺 accountId ⇒ 直接失败（不许拿空 id 去查池）', async () => {
    const { credentials } = makeCredentials()
    const result = await handleQoderRpc(
      { credentials } as never, makePool(ACCOUNTS) as never, 'qoder.setWebSession', {},
    ) as { ok: boolean; error?: { message: string } }

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('accountId')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('★★ 未知账号 ⇒ 失败（且不发请求）', async () => {
    const { credentials } = makeCredentials()
    const result = await handleQoderRpc(
      { credentials } as never,
      makePool(ACCOUNTS) as never,
      'qoder.setWebSession',
      { accountId: 'nope', cookie: 'a=1' },
    ) as { ok: boolean; error?: { message: string } }

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('账号不存在')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('★ `qodercn` 账号也要能存（两家共用一个 RPC，不能只查一家）', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(webBody([oneGrant()])))
    const { credentials, map } = makeCredentials()

    const result = await handleQoderRpc(
      { credentials } as never,
      makePool([{ id: 'cn-1', provider: QODER_CN.id, credentialRef: 'QODER_CN_ACCOUNT_1' }]) as never,
      'qoder.setWebSession',
      { accountId: 'cn-1', cookie: 'a=1' },
    ) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect(map.has('QODER_CN_ACCOUNT_1_web')).toBe(true)
  })
})

// ── 第二轮（双审计返工）新增 ──

describe('★ 粘错内容不许被当成「清除会话」（双审计 P2-1 / P2-④）', () => {
  const ACCOUNTS = [{ id: 'q-1', provider: QODER.id, credentialRef: 'QODER_ACCOUNT_1' }]
  const WEB_REF = 'QODER_ACCOUNT_1_web'

  async function attempt(cookie: string) {
    const { credentials, map } = makeCredentials()
    map.set(WEB_REF, JSON.stringify({ cookie: 'keep=1', grants: [] }))
    const result = await handleQoderRpc(
      { credentials } as never,
      makePool(ACCOUNTS) as never,
      'qoder.setWebSession',
      { accountId: 'q-1', cookie },
    ) as { ok: boolean; error?: { message: string } }
    const store = JSON.parse(map.get(WEB_REF) ?? '{}') as { cookie?: string }
    return { result, store }
  }

  it('★★★ 粘了用量页 URL ⇒ 必须失败、且已存会话**原样保留**', async () => {
    const { result, store } = await attempt('https://qoder.com/account/usage')

    expect(result.ok).toBe(false)
    // 报错必须点名「清除会话」，否则用户不知道往哪走
    expect(result.error?.message).toContain('清除会话')
    expect(store.cookie).toBe('keep=1')
  })

  it('★★★ 粘了**未加引号**的 cURL ⇒ 同款：失败 + 不删已有会话', async () => {
    const { result, store } = await attempt("curl 'https://qoder.com/x' -H Cookie: a=1")

    expect(result.ok).toBe(false)
    expect(store.cookie).toBe('keep=1')
  })

  it('★★ 失败时一个请求都不发（内容压根解析不出来，没必要打上游）', async () => {
    const { result } = await attempt('https://qoder.com/account/usage')

    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('★ 粘贴长度上限（对抗审计 P2-⑧）', () => {
  /**
   * ⚠️ 夹具必须**能解析出键值对**：纯 HTML 两种实现都会返回 `''`（没有 `=`），
   * 变异就无牙（我第一版正是如此，实测 M9 全绿）。这里粘一个「合法的第一段 +
   * 13 KB 垃圾」，只有长度上限能让结果变短。
   */
  it('★★ 13 KB 的粘贴内容必须被截到上限（不许原样落盘）', () => {
    const bloated = `a=1; token=${'x'.repeat(13_000)}`
    const normalized = normalizeCookieInput(bloated)

    expect(normalized.length).toBeLessThanOrEqual(8192)
    expect(normalized.startsWith('a=1; token=')).toBe(true)
  })

  it('★ 纯 HTML 仍然解析成空串（粘错时由 RPC 层报错，不是静默清除）', () => {
    expect(normalizeCookieInput(`<!doctype html><html><body>${'x'.repeat(200)}</body></html>`)).toBe('')
  })

  it('★ 正常长度的 Cookie 不受影响', () => {
    expect(normalizeCookieInput('a=1; b=2')).toBe('a=1; b=2')
  })
})

describe('★ 200 + HTML 登录页 ⇒「会话失效」而不是「响应不是 JSON」（对抗审计 P2-⑦）', () => {
  it('★★★ 报的是会话失效，且不需要用户去查网络', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<!doctype html><html>login</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    )
    const result = await fetchQoderWebPackages(
      'a=1',
      QODER,
      fetchMock as unknown as typeof fetch,
      // ⚠️ 第 4 参是 `timeoutMs`。传 `Date.now()`（十几位）会让
      // `AbortSignal.timeout` 抛 `RangeError: The value of "delay" is out of range`，
      // 而那条错误会被本函数的 catch 收成「网络异常」⇒ 用例红在**我的夹具**上，
      // 不是被测行为（我第一次就这么写，红因误导）。
      5_000,
    )

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ authFailed: true })
    expect(String(result.reason)).toContain('会话已失效')
    expect(String(result.reason)).not.toContain('JSON')
  })
})
