import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  WORKBUDDY_INTL_REPORT_PATH,
  WORKBUDDY_INTL_STREAK_PATH,
  WORKBUDDY_INTL_WEB_CONVERSATION_PATH,
  createWorkBuddyIntlWebSession,
  keepWorkBuddyIntlActivity,
  reportWorkBuddyIntlActivity,
  streakDaysOf,
} from '../../src/workbuddy-intl-activity.js'
import { WORKBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'
import type { ClaimOutcome } from '../../src/credits.js'

/**
 * `workbuddy-intl-activity.ts`（PR #87 新增 324 行）的**直接**行为级守卫。
 *
 * ## 为什么这个文件必须存在
 *
 * 修复前这个模块**零直接 import**：`grep -rln workbuddy-intl-activity tests/`
 * 零命中。唯一碰到它的是 `claim-runtime-parity.spec.ts` 的两条
 * `urls.some(...)` 断言 —— 不看 body、不看头、不看 note、不看返回值 ⇒
 * 模块内部每一个分支都可以自由变异而不被察觉（对抗审计实测 **10 / 14 无牙**）。
 *
 * 本文件逐条锁住那些「无牙」的变异：
 *
 * | 变异 | 本文件的对应用例 |
 * |---|---|
 * | M5 删 `uid` 早退 | `uid 缺失时零上游请求` |
 * | M6 上报失败也回 `ok:true` | `上报未确认时 ok 必须 false` |
 * | M7 `streakDaysOf` 去 `Number.isFinite` | `连登天数非法时回 undefined` |
 * | M8 模型链只跑第一个 | `模型链必须逐个尝试到成功为止` |
 * | M9 `webSessionEnabled()` → `if (true)` | `默认不发网页会话` |
 * | M10 `keep…` 恒回 `undefined` | `成功时必须出话` / `失败时也必须出话` |
 * | M11 去掉 `X-User-Id` | `请求头必须带 X-User-Id` |
 * | M12 删 `AbortSignal.timeout` | `请求必须带超时信号` |
 *
 * ⚠️ 每一条都必须在**修复前**失败（否则只是同义反复）。修复前这些用例
 * 大多会红 —— 那是预期的，不是回归。
 */

const ENDPOINT = 'https://www.workbuddy.ai'

function makeCredential(overrides: Partial<BuddyCredential> = {}): BuddyCredential {
  return {
    access_token: 'AT-INTL',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'www.workbuddy.ai',
    user_id: 'uid-intl',
    ...overrides,
  }
}

/** 记录每次请求的 URL / 头 / body，并按规则应答。 */
interface Call {
  url: string
  init: RequestInit
  headers: Record<string, string>
  body: string | undefined
}

function stubFetch(
  responder: (call: Call) => { status?: number; body: unknown },
): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: Call = {
      url: String(url),
      init: init ?? {},
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const { status = 200, body } = responder(call)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

afterEach(() => {
  delete process.env.DSH_WORKBUDDY_INTL_WEB_SESSION
  vi.restoreAllMocks()
})

describe('workbuddy 国际版活跃上报：端点与请求形状', () => {
  it('三条端点路径常量必须是国际版真实值', () => {
    expect(WORKBUDDY_INTL_REPORT_PATH).toBe('/v2/report')
    expect(WORKBUDDY_INTL_STREAK_PATH).toBe('/activity/growth/streak')
    expect(WORKBUDDY_INTL_WEB_CONVERSATION_PATH).toBe('/console/as/conversations/')
  })

  /**
   * ★★★ **M11**：`X-User-Id` 缺失时上报带不上用户身份（服务端静默丢弃）。
   * 这条同时锁住 `headersOf` 的 `usableUidOf` 归一 —— 修复前是
   * `credential.user_id.length > 0`，`user_id: 0` 时 `.length` 是 `undefined`。
   */
  it('★★★ 请求头必须带 X-User-Id（取自凭据 user_id）', async () => {
    const { fetcher, calls } = stubFetch(() => ({ body: { code: 0, data: { streak: { days: 3 } } } }))
    await reportWorkBuddyIntlActivity(makeCredential(), WORKBUDDY, fetcher)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.headers['X-User-Id'], `${call.url} 没带 X-User-Id`).toBe('uid-intl')
      expect(call.headers.Authorization).toBe('Bearer AT-INTL')
    }
  })

  /**
   * ★★★ **M11 的反向**：`user_id` 是非字符串（`0` / `{}`）时**必须早退**，
   * 不能发 `X-User-Id: undefined` 却回 `ok:true`（P1-4 的 `String(undefined)` 同型）。
   */
  it.each([
    ['数字 0', 0],
    ['空对象', {}],
    ['数组', []],
    ['布尔 true', true],
  ])('★★★ user_id 是%s时必须早退，零上游请求', async (_label, user_id) => {
    const { fetcher, calls } = stubFetch(() => ({ body: { code: 0 } }))
    const report = await reportWorkBuddyIntlActivity(
      makeCredential({ user_id: user_id as never }), WORKBUDDY, fetcher,
    )
    expect(report.ok).toBe(false)
    expect(calls, '非字符串 uid 必须一个请求都不发').toHaveLength(0)
  })

  /**
   * ★★★ **M12**：请求必须带超时信号。
   * 删掉 `AbortSignal.timeout` 会让上游挂住时一直等到宿主超时。
   */
  it('★★★ 每个请求都必须带 AbortSignal（20s 超时）', async () => {
    const { fetcher, calls } = stubFetch(() => ({ body: { code: 0, data: { streak: { days: 1 } } } }))
    await reportWorkBuddyIntlActivity(makeCredential(), WORKBUDDY, fetcher)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.init.signal, `${call.url} 没有超时信号`).toBeInstanceOf(AbortSignal)
    }
  })

  /**
   * ★★ **P1-4**：`access_token` 缺失时**必须早退** —— 否则会真的发出
   * `Authorization: Bearer undefined` 两发必然 401 的请求，还回 `ok:true`。
   */
  it.each([
    ['undefined', undefined],
    ['空串', ''],
  ])('★★ access_token 是%s时必须早退，零上游请求', async (_label, access_token) => {
    const { fetcher, calls } = stubFetch(() => ({ body: { code: 0 } }))
    const report = await reportWorkBuddyIntlActivity(
      makeCredential({ access_token: access_token as never }), WORKBUDDY, fetcher,
    )
    expect(report.ok).toBe(false)
    expect(calls, '没有 token 就必须一个请求都不发').toHaveLength(0)
  })
})

describe('workbuddy 国际版活跃上报：失败必须如实', () => {
  /**
   * ★★★ **M6**：上报被上游拒绝时 `ok` 必须是 `false`。
   * 修复前「失败也回 ok:true」是全绿的 —— 那会让用户以为活跃已上报。
   */
  it('★★★ 上报未确认（code 非 0）时 ok 必须 false 且带原因', async () => {
    const { fetcher } = stubFetch(() => ({ body: { code: 40001, msg: '风控' } }))
    const report = await reportWorkBuddyIntlActivity(makeCredential(), WORKBUDDY, fetcher)
    expect(report.ok).toBe(false)
    expect(report.note).toContain('40001')
  })

  it('★★ 上报 HTTP 200 但响应非 JSON 时 ok 必须 false', async () => {
    const { fetcher } = stubFetch(() => ({ body: '<html>gateway</html>' }))
    const report = await reportWorkBuddyIntlActivity(makeCredential(), WORKBUDDY, fetcher)
    expect(report.ok).toBe(false)
    expect(report.note).toContain('非 JSON')
  })

  it('★ fetch 抛错时不外抛（契约：永不抛）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const report = await reportWorkBuddyIntlActivity(makeCredential(), WORKBUDDY, fetcher)
    expect(report.ok).toBe(false)
    expect(report.note).toContain('ECONNRESET')
  })

  /**
   * ★★★ **M7**：连登天数必须是**有限数字**。
   * `null` / `"0"` / `NaN` 都不能当连登天数（`Number.isFinite` 被删后全绿）。
   */
  it.each([
    ['null', null],
    ['字符串 "0"', '0'],
    ['缺字段', undefined],
    ['对象', {}],
  ])('★★★ 连登天数是%s时回 undefined（不能当 0 天）', async (_label, days) => {
    const { fetcher } = stubFetch(() => ({ body: { code: 0, data: { streak: { days } } } }))
    const report = await reportWorkBuddyIntlActivity(makeCredential(), WORKBUDDY, fetcher)
    expect(report.ok).toBe(true)
    expect(report.note, '非法天数不能伪造「连登 N 天」').toContain('回读失败')
  })

  /**
   * ★★★ **M7b**：`Infinity` 走**原始文本**（`1e999` 是合法 JSON 字面量，`JSON.parse`
   * 后正是 `Infinity`）。⚠️ 不能用 `JSON.stringify({days: Infinity})` —— 那是 `null`，
   * 到不了 `streakDaysOf`，删掉 `Number.isFinite` 也全绿（第一版夹具就这么无牙）。
   */
  it('★★★ 连登天数是 Infinity（原始文本 1e999）时回 undefined', async () => {
    const raw = '{"code":0,"data":{"streak":{"days":1e999}}}'
    const { fetcher } = stubFetch(() => ({ body: raw }))
    const report = await reportWorkBuddyIntlActivity(makeCredential(), WORKBUDDY, fetcher)
    expect(report.ok).toBe(true)
    expect(report.note, 'Infinity 不能伪造「连登 Infinity 天」').toContain('回读失败')
  })

  /**
   * ★★★ **M7c**：`NaN` **经 JSON 无法表达**（`JSON.parse` 没有 NaN 字面量），
   * 所以只能直测纯函数 —— 这是 `streakDaysOf` 被 export 的唯一理由。
   */
  it('★★★ 连登天数是 NaN 时 streakDaysOf 必须回 undefined（纯函数直测）', () => {
    const result = { ok: true, body: { data: { streak: { days: Number.NaN } } } }
    expect(streakDaysOf(result as never), 'NaN 被当成天数会让 note 写「连登 NaN 天」').toBeUndefined()
    expect(streakDaysOf({ ok: true, body: { data: { streak: { days: Number.POSITIVE_INFINITY } } } } as never)).toBeUndefined()
    expect(streakDaysOf({ ok: true, body: { data: { streak: { days: 5 } } } } as never)).toBe(5)
    expect(streakDaysOf({ ok: true, body: { data: { streak: { days: 0 } } } } as never), '0 是「没连登」的合法语义').toBe(0)
  })

  it('★★ 连登天数为 0 时如实报「连登 0 天」（不是回读失败）', async () => {
    const { fetcher } = stubFetch(() => ({ body: { code: 0, data: { streak: { days: 0 } } } }))
    const report = await reportWorkBuddyIntlActivity(makeCredential(), WORKBUDDY, fetcher)
    expect(report.note).toContain('连登 0 天')
  })
})

describe('workbuddy 国际版网页会话', () => {
  /**
   * ★★★ **M8**：模型链必须**逐个尝试到成功为止**。
   * `.slice(0, 1)` 让后 3 个模型永不被尝试 —— 修复前全绿。
   */
  it('★★★ 模型链必须逐个尝试：前两个失败、第三个成功时只发 3 发', async () => {
    const { fetcher, calls } = stubFetch((call) => {
      if (!call.url.endsWith(WORKBUDDY_INTL_WEB_CONVERSATION_PATH)) return { body: { code: 0 } }
      const body = JSON.parse(call.body ?? '{}') as { model: string }
      if (body.model === 'deepseek-v4.1-flash') return { body: { code: 50000, msg: '下线' } }
      if (body.model === 'hy3') return { body: { code: 50001, msg: '繁忙' } }
      return { body: { code: 0, data: { id: 'conv-1' } } }
    })
    const session = await createWorkBuddyIntlWebSession(makeCredential(), WORKBUDDY, fetcher)
    expect(session.ok, `应建成，实际 note=${session.note}`).toBe(true)
    expect(calls.map((c) => (JSON.parse(c.body ?? '{}') as { model: string }).model))
      .toEqual(['deepseek-v4.1-flash', 'hy3', 'hy4-preview'])
  })

  /**
   * ★★★ **M8 的反向**：建成一个就必须**停**（每建一个都是用户账号里的真实会话）。
   */
  it('★★★ 建成一个就停，不能继续建第二个', async () => {
    const { fetcher, calls } = stubFetch(() => ({ body: { code: 0, data: { id: 'conv-1' } } }))
    await createWorkBuddyIntlWebSession(makeCredential(), WORKBUDDY, fetcher)
    expect(calls).toHaveLength(1)
  })

  /**
   * ★★ 全失败时 `note` 必须带**最后一个**模型的原因（便于排查是模型下线还是通道被拒）。
   */
  it('★★ 全部模型失败时 note 必须带最后一个失败原因', async () => {
    const { fetcher, calls } = stubFetch(() => ({ body: { code: 50000, msg: 'boomed' } }))
    const session = await createWorkBuddyIntlWebSession(makeCredential(), WORKBUDDY, fetcher)
    expect(session.ok).toBe(false)
    expect(session.note).toContain('hy4-preview-f')
    expect(session.note).toContain('50000')
    expect(calls).toHaveLength(4)
  })

  /**
   * ★★ 网页会话必须是**浏览器** UA + `Origin`/`Referer`（渠道校验 11-128 认这个）。
   */
  it('★★ 网页会话必须带浏览器 UA 与 Origin/Referer', async () => {
    const { fetcher, calls } = stubFetch(() => ({ body: { code: 0, data: { id: 'c' } } }))
    await createWorkBuddyIntlWebSession(makeCredential(), WORKBUDDY, fetcher)
    const headers = calls[0]!.headers
    expect(headers['User-Agent']).toContain('Mozilla/5.0')
    expect(headers.Origin).toBe(ENDPOINT)
    expect(headers.Referer).toBe(`${ENDPOINT}/app`)
  })
})

describe('keepWorkBuddyIntlActivity：outcome 短路（P1-1 / P1-2）', () => {
  /**
   * ★★★ **M9 + P1-2**：`claimed` / `already-claimed` 才发活跃。
   *
   * 为什么这条是承重的：`inactive` **不计** `coversToday`（`auto-checkin.ts`
   * 只认 `claimed + alreadyClaimed`）⇒ 下个时段会重跑本钩子。词汇义上
   * 「活动未开」本来也不该在用户账号里造会话。
   */
  it.each(['claimed', 'already-claimed'] as const)(
    '★★★ outcome.kind=%s 时必须真的发上报',
    async (kind) => {
      const { fetcher, calls } = stubFetch(() => ({ body: { code: 0, data: { streak: { days: 2 } } } }))
      const note = await keepWorkBuddyIntlActivity(
        makeCredential(), WORKBUDDY, { kind } as ClaimOutcome, fetcher,
      )
      expect(note, `kind=${kind} 应该有收尾提示`).toBeTruthy()
      expect(calls.some((c) => c.url.endsWith(WORKBUDDY_INTL_REPORT_PATH))).toBe(true)
    },
  )

  /**
   * ★★★ **P1-2 的核心**：`inactive` / `failed` **一个请求都不能发**。
   *
   * 修复前四种结局行为**逐字相同** ⇒ 中招日（活动未开）两个时段各发一次 ⇒
   * 用户账号里 **2 个 `Hi` 会话/天**（30 天 60 个）。
   */
  it.each(['inactive', 'failed'] as const)(
    '★★★ outcome.kind=%s 时必须零上游请求（不能制造可见副作用）',
    async (kind) => {
      process.env.DSH_WORKBUDDY_INTL_WEB_SESSION = '1'
      const { fetcher, calls } = stubFetch(() => ({ body: { code: 0, data: { streak: { days: 2 }, id: 'c' } } }))
      const note = await keepWorkBuddyIntlActivity(
        makeCredential(), WORKBUDDY, { kind } as ClaimOutcome, fetcher,
      )
      expect(note, `kind=${kind} 不该有任何收尾提示`).toBeUndefined()
      expect(calls, `kind=${kind} 一个请求都不该发`).toHaveLength(0)
    },
  )

  /**
   * ★★★ **M9**：网页会话**默认关**。
   * `if (webSessionEnabled())` 改成 `if (true)` 修复前全绿 ⇒ 默认给用户造会话。
   */
  /**
   * ★★★ **M18**：单发超时必须是 `min(REQUEST_TIMEOUT_MS, 剩余预算)`，
   * 不能被总预算放成 45s。删掉 `Math.min` 时首发会拿到 45s —— 正好解释
   * 「上游挂住时为什么还是慢」。
   */
  it('★★★ M18 单发超时夹在 20s 以内（总预算不能放大单发）', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    try {
      const { fetcher } = stubFetch((call) => {
        if (call.url.endsWith('/v2/report')) return { body: { code: 0, data: {} } }
        return { body: { code: 0, data: { streak: { days: 1 } } } }
      })
      await reportWorkBuddyIntlActivity(makeCredential(), WORKBUDDY, fetcher, 999_000)
      expect(spy, '必须真的要过超时').toHaveBeenCalled()
      for (const call of spy.mock.calls) {
        expect(call[0], '单发超时不能超过 REQUEST_TIMEOUT_MS').toBeLessThanOrEqual(20_000)
      }
    } finally {
      spy.mockRestore()
    }
  })

  /**
   * ★★★ **P1-3**：一次 `keepWorkBuddyIntlActivity` 的总预算。
   *
   * `afterClaimNote` 在 RPC 层**没有 deadline**，而三发是串联的 ⇒ 上游挂住时
   * 最坏 6 × 20s = 120s/账号，账号还串行。这里用**假时钟**把预算耗掉，
   * 断言「不再建网页会话」且**如实出话**（不静默）。
   */
  it('★★★ P1-3 总预算用尽时不再建网页会话，且必须如实出话', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-16T00:00:00Z'))
      vi.stubEnv('DSH_WORKBUDDY_INTL_WEB_SESSION', '1')
      const { fetcher, calls } = stubFetch((call) => {
        // 上报完成后把时钟推到总预算（45s）之外
        if (call.url.endsWith('/v2/report')) {
          vi.setSystemTime(new Date('2026-11-16T00:01:00Z'))
        }
        if (call.url.endsWith('/activity/growth/streak')) {
          return { body: { code: 0, data: { streak: { days: 3 } } } }
        }
        return { body: { code: 0, data: { id: 'conv-1' } } }
      })
      const note = await keepWorkBuddyIntlActivity(
        makeCredential(), WORKBUDDY, { kind: 'claimed' } as never, fetcher,
      )
      const webCalls = calls.filter((c) => c.url.includes('/console/as/conversations/'))
      expect(webCalls, '预算用尽时必须零网页会话请求（否则用户账号被建会话）').toHaveLength(0)
      expect(note ?? '', '跳过必须能出话，不能静默').toContain('总预算')
    } finally {
      vi.useRealTimers()
      vi.unstubAllEnvs()
    }
  })

  it('★★★ 未设置环境变量时默认不发网页会话（只发上报 + 回读）', async () => {
    const { fetcher, calls } = stubFetch(() => ({ body: { code: 0, data: { streak: { days: 1 } } } }))
    await keepWorkBuddyIntlActivity(makeCredential(), WORKBUDDY, { kind: 'claimed' }, fetcher)
    expect(calls.some((c) => c.url.endsWith(WORKBUDDY_INTL_WEB_CONVERSATION_PATH)))
      .toBe(false)
    expect(calls).toHaveLength(2)
  })

  /**
   * ★★ **M9 的取值域**：`1` / `true` / `yes` 都认（大小写不敏感、可带空白），
   * 其余（含 `0` / `false` / 空串）一律关。
   */
  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    [' 1 ', true],
    ['0', false],
    ['false', false],
    ['', false],
    ['no', false],
  ])('★★ 环境变量 %j ⇒ 网页会话%s', async (value, expected) => {
    process.env.DSH_WORKBUDDY_INTL_WEB_SESSION = value
    const { fetcher, calls } = stubFetch(() => ({ body: { code: 0, data: { streak: { days: 1 }, id: 'c' } } }))
    await keepWorkBuddyIntlActivity(makeCredential(), WORKBUDDY, { kind: 'claimed' }, fetcher)
    const built = calls.some((c) => c.url.endsWith(WORKBUDDY_INTL_WEB_CONVERSATION_PATH))
    expect(built).toBe(expected)
  })

  /**
   * ★★★ **M10 + P1-3**：成功时**必须出话**（唯一用户可见通道）。
   */
  it('★★★ 成功时必须出话（含连登天数）', async () => {
    const { fetcher } = stubFetch((call) => call.url.endsWith(WORKBUDDY_INTL_STREAK_PATH)
      ? { body: { code: 0, data: { streak: { days: 5 } } } }
      : { body: { code: 0 } })
    const note = await keepWorkBuddyIntlActivity(
      makeCredential(), WORKBUDDY, { kind: 'claimed' }, fetcher,
    )
    expect(note).toContain('连登 5 天')
  })

  /**
   * ★★★ **P1-3**：**失败也必须出话**。
   *
   * 修复前只 `push` 成功的 note、全失败回 `undefined` ⇒ 唯一的用户可见通道
   * （`jet-hub-rpc.ts` 把返回值追加到 `outcome.message`）空转，上游挂了也
   * 零日志零提示 —— 这条链路**无法从用户侧或日志侧诊断**。
   */
  it('★★★ 上报失败时 note 必须能出话（不能静默）', async () => {
    const { fetcher } = stubFetch((call) => call.url.endsWith(WORKBUDDY_INTL_REPORT_PATH)
      ? { body: { code: 40001, msg: '风控' } }
      : { body: { code: 0, data: { streak: { days: 0 } } } })
    const note = await keepWorkBuddyIntlActivity(
      makeCredential(), WORKBUDDY, { kind: 'claimed' }, fetcher,
    )
    expect(note, '失败必须能被用户看到').toBeTruthy()
    expect(note).toContain('40001')
  })

  /**
   * ★★ 网页会话全败也必须出话（`calls=5` 全失败而 `keep=undefined` 是修复前的现状）。
   */
  it('★★ 网页会话全失败时 note 必须带失败原因', async () => {
    process.env.DSH_WORKBUDDY_INTL_WEB_SESSION = '1'
    const { fetcher } = stubFetch((call) => call.url.endsWith(WORKBUDDY_INTL_WEB_CONVERSATION_PATH)
      ? { body: { code: 50000, msg: 'down' } }
      : { body: { code: 0, data: { streak: { days: 1 } } } })
    const note = await keepWorkBuddyIntlActivity(
      makeCredential(), WORKBUDDY, { kind: 'claimed' }, fetcher,
    )
    expect(note).toContain('网页会话未建成')
    expect(note).toContain('50000')
  })

  /**
   * ★★ 永不抛：坏凭据 / 坏 product 都折算成 note，绝不让签到变成失败。
   */
  it.each([
    ['product 缺 endpoint', () => makeCredential(), {} as never],
  ])('★★ 坏输入(%s)不外抛', async (_label, cred, product) => {
    const { fetcher } = stubFetch(() => ({ body: { code: 0 } }))
    await expect(
      keepWorkBuddyIntlActivity(cred() as BuddyCredential, product as never, { kind: 'claimed' } as ClaimOutcome, fetcher),
    ).resolves.toBeDefined()
  })
})
