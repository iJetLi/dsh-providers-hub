/**
 * 智谱清言（chatglm.cn 网页端）provider 的行为级守卫。
 *
 * ## ⚠️ 本文件的判据全部打在**行为**上（不锁源码文本）
 *
 * 本仓库已有多起「源码正则断言假绿 / 假红」的事故（见
 * `docs/agent-notes/client-ui.md` 的 `if (false)` 短路一节）。故这里所有断言都
 * 走**真调用**：真算签名、真发请求（`fetch` 被 stub）、真判 `ClaimOutcome`。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CHATGLM_PATHS,
  CHATGLM_SIGN_SALT,
  chatglmCookieValue,
  chatglmCredentialFromCookies,
  chatglmCredentialFromInput,
  chatglmDeviceIdOf,
  chatglmHeaders,
  chatglmSign,
  chatglmTimestamp,
  chatglmTokenExpiresAtMs,
  chatglmTokenIsGuest,
  parseChatglmCredential,
} from '../../src/chatglm.js'
import { claimChatglmDailyCheckin, fetchChatglmBalanceDetailed } from '../../src/chatglm-credits.js'
import { chatglmTokenFingerprint } from '../../src/chatglm-login.js'
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'

/** 用官方算法独立重算一次 md5（不复用被测函数），用于交叉验证。 */
async function expectedSign(stamp: string, nonce: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('md5').update(`${stamp}-${nonce}-${CHATGLM_SIGN_SALT}`, 'utf8').digest('hex')
}

describe('★ 签名与时间戳（官方 `86129` 模块 `w()` 的逐字复刻）', () => {
  it('时间戳是「倒数第 2 位被替换成 (各位数字和 − 原倒数第 2 位) % 10」', () => {
    // 取一个固定值，手算核对：1793712345678
    //   各位数字和 = 1+7+9+3+7+1+2+3+4+5+6+7+8 = 63
    //   原倒数第 2 位 = 7 ⇒ (63 − 7) % 10 = 6
    //   ⇒ 前缀 "17937123456" + "6" + 末位 "8" = "1793712345668"
    expect(chatglmTimestamp(1793712345678)).toBe('1793712345668')
  })

  it('★ 时间戳**不是**原样返回（照抄成「直接用 Date.now()」会让算法退化）', () => {
    const raw = 1793712345678
    expect(chatglmTimestamp(raw)).not.toBe(String(raw))
    expect(chatglmTimestamp(raw)).toHaveLength(13)
  })

  it('签名 = md5("<stamp>-<nonce>-<salt>")，与独立实现逐字节一致', async () => {
    const stamp = chatglmTimestamp(1793712345678)
    const nonce = '0123456789abcdef0123456789abcdef'
    expect(chatglmSign(stamp, nonce)).toBe(await expectedSign(stamp, nonce))
  })

  it('★ 换了 nonce 签名必变（判据不是恒真）', () => {
    const stamp = chatglmTimestamp()
    expect(chatglmSign(stamp, 'a'.repeat(32))).not.toBe(chatglmSign(stamp, 'b'.repeat(32)))
  })

  it('请求头带全套官方字段，且带 token 时才有 Authorization', () => {
    const withToken = chatglmHeaders('TOK', { deviceId: 'd'.repeat(32) })
    expect(withToken['Authorization']).toBe('Bearer TOK')
    expect(withToken['App-Name']).toBe('chatglm')
    expect(withToken['X-Device-Id']).toBe('d'.repeat(32))
    expect(withToken['X-Sign']).toMatch(/^[a-f0-9]{32}$/)
    expect(withToken['X-Nonce']).toMatch(/^[a-f0-9]{32}$/)
    expect(withToken['X-Timestamp']).toMatch(/^\d{13}$/)
    const withoutToken = chatglmHeaders()
    expect(withoutToken['Authorization']).toBeUndefined()
  })
})

describe('★ 凭据解析与输入归一', () => {
  it('解析池里的 JSON；坏 JSON 回 undefined（不抛）', () => {
    expect(parseChatglmCredential('{"chatglm_token":"t"}')?.chatglm_token).toBe('t')
    expect(parseChatglmCredential('not json')).toBeUndefined()
    expect(parseChatglmCredential('')).toBeUndefined()
    expect(parseChatglmCredential(undefined)).toBeUndefined()
  })

  it('整条 cookie 串可直接归一成凭据（用户最可能的粘贴形态）', () => {
    const credential = chatglmCredentialFromInput(
      'chatglm_token=abc.def; chatglm_refresh_token=rrr.zzz; chatglm_user_id=u1',
    )
    expect(credential?.chatglm_token).toBe('abc.def')
    expect(credential?.chatglm_refresh_token).toBe('rrr.zzz')
    // ⚠️ `chatglm_user_id` **不进**凭据（它是 cookie 里的展示用 id，
    //    凭据只保留鉴权与续期所需的两项 + expires_at / device_id）。
    expect(credential?.user_id).toBeUndefined()
  })

  it('裸 token 也吃；太短/含空白的串**不当凭据**（避免把随手打字当 token）', () => {
    expect(chatglmCredentialFromInput('abcdefghijklmnopqrstuvwx')?.chatglm_token).toBe('abcdefghijklmnopqrstuvwx')
    expect(chatglmCredentialFromInput('short')).toBeUndefined()
    expect(chatglmCredentialFromInput('has space in it and is long enough')).toBeUndefined()
  })

  it('cookie 取值按名精确匹配（不会把 `xchatglm_token` 认成 `chatglm_token`）', () => {
    expect(chatglmCookieValue('a=1; chatglm_token=T', 'chatglm_token')).toBe('T')
    expect(chatglmCookieValue('xchatglm_token=T', 'chatglm_token')).toBeUndefined()
  })
})

describe('★ 设备号：每账号确定性派生（不是账号归属判据，但结构性防御）', () => {
  it('同一 accountKey 永远同一套；不同 accountKey 天然不同', () => {
    const a1 = chatglmDeviceIdOf({}, 'acct-a')
    const a2 = chatglmDeviceIdOf({}, 'acct-a')
    const b = chatglmDeviceIdOf({}, 'acct-b')
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(a1).toMatch(/^[a-f0-9]{32}$/)
  })

  it('凭据里合法形态的存量设备号优先（浏览器里真实注册过的那个）', () => {
    const stored = 'a'.repeat(32)
    expect(chatglmDeviceIdOf({ device_id: stored }, 'acct-a')).toBe(stored)
  })

  it('★ 非法形态（大写/带横线/长度不对）**回落派生**，不直接透传', () => {
    const derived = chatglmDeviceIdOf({}, 'acct-a')
    expect(chatglmDeviceIdOf({ device_id: 'A'.repeat(32) }, 'acct-a')).toBe(derived)
    expect(chatglmDeviceIdOf({ device_id: 'a-b-c' }, 'acct-a')).toBe(derived)
    expect(chatglmDeviceIdOf({ device_id: 'a'.repeat(31) }, 'acct-a')).toBe(derived)
  })
})

describe('★★ 签到：判据是 result.score，不是 status（2026-11-04 实测口径）', () => {
  function stubFetch(body: unknown, status = 200): void {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  }

  it('score > 0 ⇒ claimed，且 credit 等于上游给的数', async () => {
    stubFetch({ status: 0, message: 'success', result: { score: 15 } })
    const outcome = await claimChatglmDailyCheckin({ chatglm_token: 'T' })
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') {
      expect(outcome.credit).toBe(15)
      expect(outcome.unit).toBe('credit')
      // ⚠️ 上游不下发连续天数 ⇒ 如实回 0（本仓库纪律：不编造）。
      expect(outcome.streakDays).toBe(0)
    }
  })

  it('★★ score === 0 且 status === 0 ⇒ already-claimed（**这是分水岭**）', async () => {
    // 只判 status 的实现会在这里报「claimed +0 积分」——正是本仓库反复记录过的
    // 「显示成功但 +0」缺陷形态。
    stubFetch({ status: 0, message: 'success', result: { score: 0 } })
    const outcome = await claimChatglmDailyCheckin({ chatglm_token: 'T' })
    expect(outcome.kind).toBe('already-claimed')
  })

  it('★ score 是字符串时也能读（上游可能回 "15"）', async () => {
    stubFetch({ status: 0, message: 'success', result: { score: '15' } })
    const outcome = await claimChatglmDailyCheckin({ chatglm_token: 'T' })
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') expect(outcome.credit).toBe(15)
  })

  it('40102（token 无效）⇒ failed 且文案指向续期/重登', async () => {
    stubFetch({ status: 40102, message: 'unauthorized user(40102)' }, 401)
    const outcome = await claimChatglmDailyCheckin({ chatglm_token: 'T' })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.code).toBe(40102)
      expect(outcome.message).toContain('登录态已失效')
    }
  })

  it('★ 40003（闸门收紧）的文案**指向上游改版**，不是「你没登录」', async () => {
    // 实测 40003 只在「什么头都不带」时出现；本模块总是带全套头 ⇒ 走到这里
    // 意味着上游收紧了。文案若写成「请重新登录」，用户会白重登一次。
    stubFetch({ status: 40003, message: 'bad request(40003)' }, 400)
    const outcome = await claimChatglmDailyCheckin({ chatglm_token: 'T' })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.message).toContain('上游')
  })

  it('缺 result.score ⇒ failed（不猜 0、不猜已领）', async () => {
    stubFetch({ status: 0, message: 'success', result: {} })
    const outcome = await claimChatglmDailyCheckin({ chatglm_token: 'T' })
    expect(outcome.kind).toBe('failed')
  })

  it('★ 没有 token ⇒ inactive 且**一个请求都不发**', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response('{}', { status: 200 })
    })
    const outcome = await claimChatglmDailyCheckin({})
    expect(outcome.kind).toBe('inactive')
    expect(seen).toEqual([])
  })

  it('★ 真发到自己的签到路径（不是打错端点）', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response(JSON.stringify({ status: 0, result: { score: 1 } }), { status: 200 })
    })
    await claimChatglmDailyCheckin({ chatglm_token: 'T' })
    expect(seen.some((url) => url.includes(CHATGLM_PATHS.dailyLoginScore))).toBe(true)
  })
})

describe('★★ 余额：左分读字符串，读不到回 null 不写 0', () => {
  it('left_score 在 ⇒ total 等于它，且**只有一个无到期的包**', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({
        status: 0,
        result: { _id: 'u1', member_info: { left_score: '1280' } },
      }), { status: 200 }))
    const out = await fetchChatglmBalanceDetailed({ chatglm_token: 'T' })
    expect(out.error).toBeUndefined()
    expect(out.balance?.total).toBe(1280)
    expect(out.balance?.packages).toHaveLength(1)
    // ⚠️ 上游不下发到期时间 ⇒ `expiredTime` 必须是空串（不是编造日期）。
    expect(out.balance?.packages[0]?.expiredTime).toBe('')
    expect(out.balance?.expiredTotal).toBe(0)
  })

  it('★ 缺 left_score ⇒ null + 原因，**不是 0**（0 是「已用光」的语义）', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ status: 0, result: { _id: 'u1' } }), { status: 200 }))
    const out = await fetchChatglmBalanceDetailed({ chatglm_token: 'T' })
    expect(out.balance).toBeNull()
    expect(out.error).toContain('left_score')
  })

  it('★ 40102 与「上游改版」给出**不同**原因（用户动作不同）', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ status: 40102, message: 'unauthorized user(40102)' }), { status: 401 }))
    const unauthorized = await fetchChatglmBalanceDetailed({ chatglm_token: 'T' })
    expect(unauthorized.balance).toBeNull()
    expect(unauthorized.error).toContain('登录态已失效')

    vi.stubGlobal('fetch', async () => new Response('<html>gateway</html>', { status: 502 }))
    const gate = await fetchChatglmBalanceDetailed({ chatglm_token: 'T' })
    expect(gate.balance).toBeNull()
    expect(gate.error).toContain('查询智谱清言积分失败')
  })
})

describe('★ 判重指纹：哈希而非明文（token 是会话秘密）', () => {
  it('同一 token 稳定同指纹，不同 token 不同', () => {
    const a = chatglmTokenFingerprint({ chatglm_token: 'T1' })
    expect(chatglmTokenFingerprint({ chatglm_token: 'T1' })).toBe(a)
    expect(chatglmTokenFingerprint({ chatglm_token: 'T2' })).not.toBe(a)
    expect(a).toMatch(/^[a-f0-9]{16}$/)
  })

  it('★★ 指纹里**不含** token 明文（进 state.json 也不算泄漏）', () => {
    const fingerprint = chatglmTokenFingerprint({ chatglm_token: 'super-secret-token-value' })
    expect(fingerprint).not.toContain('super-secret')
    expect(fingerprint).toBeDefined()
  })

  it('没有 token ⇒ undefined（不编造一个恒等指纹）', () => {
    expect(chatglmTokenFingerprint({})).toBeUndefined()
    expect(chatglmTokenFingerprint(undefined)).toBeUndefined()
  })
})

describe('★★ 游客态：`is_guest: true` 的 token **不是**登录成功（2026-11-04 真实缺陷）', () => {
  /** 造一个 JWT（只拼 payload，签名段随意 —— 被测代码只解码不验签）。 */
  function makeJwt(payload: Record<string, unknown>): string {
    const seg = Buffer.from(JSON.stringify(payload), 'utf8')
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `eyJhbGciOiJIUzI1NiJ9.${seg}.sig`
  }

  /** 造一份 cookie 表（`Storage.getCookies` 的形状）。 */
  function cookiesOf(entries: Array<[string, string]>): Array<{ name: string; value: string; domain: string }> {
    return entries.map(([name, value]) => ({ name, value, domain: '.chatglm.cn' }))
  }

  it('★★ 游客 token（is_guest:true）必须被判为游客', () => {
    // 实测证据：干净一次性 profile 打开 chatglm.cn 后，cookie jar **立刻**就有
    // 一套完整的 chatglm_token/chatglm_refresh_token，payload 里 is_guest:true。
    // 旧实现只看「有 token」⇒ 窗口一开就被判成功并 close()，用户看不到登录界面。
    expect(chatglmTokenIsGuest(makeJwt({ is_guest: true, type: 'access' }))).toBe(true)
  })

  /**
   * ★★★ **这条守的是生产路径本身**（`chatglmCredentialFromCookies`）。
   *
   * ⚠️ 为什么必须打在这里（2026-11-04 变异验证实测的盲区）：判据原先直接写在
   * `ChatglmLoginSession.readCredentialOnce()`（带 CDP 状态的私有方法）⇒
   * 把「游客拦截」改回旧行为（= 有 token 就算成功）、或把 `expires_at` 换回
   * 「now + 30 天」，**35 条用例全绿**。抽成纯函数后两条都能被钉住。
   */
  it('★★★ 登录判据（生产路径）：游客 cookie 表 ⇒ 不给凭据，只回报 guest', () => {
    const out = chatglmCredentialFromCookies(cookiesOf([
      ['chatglm_token', makeJwt({ is_guest: true })],
      ['chatglm_refresh_token', makeJwt({ is_guest: true, type: 'refresh' })],
    ]))
    expect(out.credential, '游客态不得产出凭据（否则窗口会被立刻关闭）').toBeUndefined()
    expect(out.guest).toBe(true)
  })

  it('★★★ 登录判据（生产路径）：真登录 cookie 表 ⇒ 给凭据，且 guest=false', () => {
    const token = makeJwt({ is_guest: false, uid: 'u1', exp: 1793857636, device_id: 'a'.repeat(32) })
    const out = chatglmCredentialFromCookies(cookiesOf([
      ['chatglm_token', token],
      ['chatglm_refresh_token', 'r-token'],
      ['chatglm_user_id', 'u1'],
    ]))
    expect(out.guest).toBe(false)
    expect(out.credential?.chatglm_token).toBe(token)
    expect(out.credential?.chatglm_refresh_token).toBe('r-token')
    expect(out.credential?.user_id).toBe('u1')
  })

  it('★★★ 生产路径的 `expires_at` 来自 JWT `exp`，**不是 now+30 天**（变异打点）', () => {
    // ⚠️ 这条是「用 cookie TTL 冒充 token 寿命」那个缺陷的唯一钉点：
    //    旧实现写 `Date.now() + 30 * 86400_000` ⇒ 比真值大 29 天 ⇒ lead-time 永不触发。
    //    判据用「量级」而非「逐毫秒相等」，因为 now 是活的。
    const exp = 1793857636
    const out = chatglmCredentialFromCookies(cookiesOf([
      ['chatglm_token', makeJwt({ is_guest: false, exp })],
    ]))
    expect(out.credential?.expires_at).toBe(exp * 1000)
    // 反向：它必须**远小于** now+30 天（否则就是那个编造值）
    expect(out.credential!.expires_at!).toBeLessThan(Date.now() + 29 * 86400_000)
  })

  it('★ 没有 token（也还没登录过）⇒ 既无凭据也不报 guest', () => {
    const out = chatglmCredentialFromCookies(cookiesOf([['other_cookie', 'x']]))
    expect(out.credential).toBeUndefined()
    expect(out.guest, '「还没登录」与「游客态」是两件事，不能混报').toBe(false)
  })

  it('★ 只认 `.chatglm.cn` 域的 cookie（别的域同名 cookie 不得混入）', () => {
    const out = chatglmCredentialFromCookies([
      { name: 'chatglm_token', value: makeJwt({ is_guest: false }), domain: '.evil.example' },
    ])
    expect(out.credential).toBeUndefined()
  })

  it('★ 非 JWT / 空串 ⇒ fail-open 判非游客（不能把真登录判成游客）', () => {
    // 上游若改成不透明 token，我们无从判断 ⇒ 只能放行继续。
    // 反过来的 fail-closed 会让登录**永远不成功**（更糟的失败形态）。
    expect(chatglmTokenIsGuest('opaque-token-value')).toBe(false)
    expect(chatglmTokenIsGuest('')).toBe(false)
    expect(chatglmTokenIsGuest(undefined)).toBe(false)
    // 生产路径同样放行（不透明 token 仍应产出凭据）
    const out = chatglmCredentialFromCookies(cookiesOf([['chatglm_token', 'opaque-token-value']]))
    expect(out.credential?.chatglm_token).toBe('opaque-token-value')
  })

  it('★★ expires_at 读 JWT 的 exp（实测：exp−iat = 24h，**不是** 30 天）', () => {
    const token = makeJwt({ iat: 1793771236, exp: 1793857636 })
    expect(chatglmTokenExpiresAtMs(token)).toBe(1793857636000)
    expect(1793857636 - 1793771236, '★ 实测寿命是 24 小时，不是 30 天').toBe(86400)
  })

  it('★ 读不到 exp ⇒ undefined（**宁缺勿造**），且生产路径**不写**该字段', () => {
    expect(chatglmTokenExpiresAtMs(makeJwt({})), '缺 exp 必须 undefined').toBeUndefined()
    expect(chatglmTokenExpiresAtMs('opaque')).toBeUndefined()
    const out = chatglmCredentialFromCookies(cookiesOf([['chatglm_token', makeJwt({})]]))
    expect(out.credential?.expires_at, '读不到就不写（不是编造一个「保守」值）').toBeUndefined()
  })

  it('★ 设备号优先取 token 里的 `device_id`（服务端下发的真值，32 hex）', () => {
    const real = '72b875712e784cbaa46493406846a706'
    const token = makeJwt({ device_id: real })
    expect(chatglmDeviceIdOf({ chatglm_token: token }, 'acct-a')).toBe(real)
    // 生产路径同样带上它
    const out = chatglmCredentialFromCookies(cookiesOf([['chatglm_token', makeJwt({ device_id: real })]]))
    expect(out.credential?.device_id).toBe(real)
    // 对照：token 里没有 device_id 时才回落派生（且与 accountKey 相关）
    const derived = chatglmDeviceIdOf({ chatglm_token: makeJwt({}) }, 'acct-a')
    expect(derived).not.toBe(real)
    expect(derived).toMatch(/^[a-f0-9]{32}$/)
  })

  it('★ 非法形态的 device_id（大写/短）不采信，回落派生', () => {
    const token = makeJwt({ device_id: 'A'.repeat(32) })
    const derived = chatglmDeviceIdOf({ chatglm_token: makeJwt({}) }, 'acct-a')
    expect(chatglmDeviceIdOf({ chatglm_token: token }, 'acct-a')).toBe(derived)
  })
})

describe('★★ 卡片「有效期」：`expiresAt` 必须落到**池条目**（2026-11-04 真机报障）', () => {
  /**
   * ## 报障与根因（真机截图：`chatglm` 卡片显示「有效期 未知」）
   *
   * `account.list` 的 `expiresAt` **只来自池条目**
   * （`ProviderAccountEntry.expiresAt`），**不读凭据文件**。
   * 登录分支当时只 `credentials.set` 而不 `pool.updateAccount({ expiresAt })`
   * ⇒ 卡片读到 `undefined` ⇒ 恒显示「未知」，且**永远不会自己补上**。
   *
   * ⚠️ 这是本仓库**第 4 次**踩同一个坑（OfficeAce → Codely → Magicrew → chatglm）。
   * 故守卫必须打在两处：① 登录分支真的写了；② `account.list` 有自愈回填。
   * 两者都**只有一份判据** `chatglmExpiresAtPatch`，这里验它的取值域。
   */
  function makeJwt(payload: Record<string, unknown>): string {
    const seg = Buffer.from(JSON.stringify(payload), 'utf8')
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `eyJhbGciOiJIUzI1NiJ9.${seg}.sig`
  }

  it('★★ 声明值（`expires_at`）优先 —— 那是**续期那一刻**算出的新值', async () => {
    const { chatglmExpiresAtPatch } = await import('../../src/jet-hub-rpc.js')
    const declared = 1795000000000
    // ⚠️ 与 autoclaw 的「JWT 优先」**方向相反**，两者理由都写在实现注释里：
    //    本家的 `expires_at` 是续期时按服务端口径写的「这份凭据还能用多久」，
    //    比旧 token 里冻结的 `exp` 更贴近现实。
    expect(chatglmExpiresAtPatch({
      chatglm_token: makeJwt({ exp: 1793857636 }),
      expires_at: declared,
    })).toEqual({ expiresAt: declared })
  })

  it('★★ 没有声明值 ⇒ 解 JWT `exp`（**24 小时**，不是 cookie 的 30 天）', async () => {
    const { chatglmExpiresAtPatch } = await import('../../src/jet-hub-rpc.js')
    expect(chatglmExpiresAtPatch({ chatglm_token: makeJwt({ exp: 1793857636 }), expires_at: undefined }))
      .toEqual({ expiresAt: 1793857636000 })
  })

  it('★★ 都读不到 ⇒ **空对象**（不是 `{ expiresAt: undefined }`）', async () => {
    const { chatglmExpiresAtPatch } = await import('../../src/jet-hub-rpc.js')
    // ⚠️ 空对象 = 「不写这个键」；`{ expiresAt: undefined }` 会在池条目上留一个
    //    值为 undefined 的键 —— 展示等价，但让「读不到就不写」这条纪律
    //    在数据里看不出区别（与 magicrewExpiresAtPatch 同款约定）。
    const patch = chatglmExpiresAtPatch({ chatglm_token: 'opaque-token' })
    expect(patch).toEqual({})
    expect(Object.hasOwn(patch, 'expiresAt'), '不得留下值为 undefined 的键').toBe(false)
  })

  it('★ 非法声明值（0 / NaN / 负数）不采信，回落 JWT `exp`', async () => {
    const { chatglmExpiresAtPatch } = await import('../../src/jet-hub-rpc.js')
    // 反向：写 0 会让卡片显示成「已过期」（比「未知」更糟的误报）
    for (const bad of [0, Number.NaN, -1]) {
      expect(chatglmExpiresAtPatch({ chatglm_token: makeJwt({ exp: 1793857636 }), expires_at: bad }))
        .toEqual({ expiresAt: 1793857636000 })
    }
  })
})

describe('★ registry 接线（能力矩阵如实登记）', () => {
  it('chatglm 登记了 balance + dailyCheckin，且是纯签到渠道（channel:false）', () => {
    const descriptor = PROVIDER_REGISTRY.find((d) => d.id === 'chatglm')
    expect(descriptor, 'registry 里找不到 chatglm').toBeDefined()
    expect(descriptor?.credits.balance).toBe(true)
    expect(descriptor?.credits.dailyCheckin).toBe(true)
    // 纯签到渠道：没有模型目录 / 适配器 / auth 服务（与 doubao 同型）。
    expect(descriptor?.channel).toBe(false)
    // 没有可清的限流标记 ⇒ 两个按钮恒惰性，必须显式登记 false。
    expect(descriptor?.rateLimit).toBe(false)
  })

  it('★ 声明序在 magicrew 之前（magicrew 系仍在 aggregate 之前 = 尾部两席）', () => {
    const ids = PROVIDER_REGISTRY.map((d) => d.id)
    const ic = ids.indexOf('chatglm')
    const im = ids.indexOf('magicrew')
    const imi = ids.indexOf('magicrewintl')
    const ia = ids.indexOf('aggregate')
    expect(ic).toBeGreaterThan(-1)
    // 上游 PR #177 后新增了 magicrewintl（国际站），它紧随 magicrew 之后；
    // 原断言「aggregate 紧邻 magicrew（差 1）」随魔法rewintl 的加入失效 ——
    // 真实不变式是「chatglm < magicrew < magicrewintl < aggregate（aggregate 恒最后）」。
    expect(ic, 'chatglm 必须排在 magicrew 之前').toBeLessThan(im)
    expect(im, 'magicrew 必须排在 magicrewintl 之前（国内站在前）').toBeLessThan(imi)
    expect(imi, 'magicrewintl 必须是 aggregate 的前一个（倒数第二）').toBe(ia - 1)
  })
})
