/**
 * ⚠️ Accio **请求级账号轮换**（Gitee issue IKM3ZV，2026-10-18）。
 *
 * ## 本 issue 的实测复现（修复前）
 *
 * 池里两个启用账号（#1、#2），#1 额度耗尽（HTTP 402）⇒
 * **#2 从未被尝试**，整轮直接失败，「登录 N 个账号未带来 N 倍可用性」。
 * 流内 402（HTTP 200 + SSE `error_code:"402"`）—— 本家**最常见**的额度形态 ——
 * 同样零换号。
 *
 * ## 本组用例的判别力设计
 *
 * ⚠️ **判别力在「第二发的 token」**：换号若不生效，第二发仍是 `TOK-A`。
 * 只断言「抛出的错误码对」是**恒真**的（修复前后完全一致）。
 *
 * ⚠️ 每条「必须换号」的用例都配一条**反向对照**（「不该换号的一律不换」），
 * 否则一个「凡错就换号」的实现也能全绿 —— 那是白烧整池（buddy 的 11128
 * 内容级拦截教训）。
 */
import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  AccioAdapter,
  accioFailureClassOf,
  recordsAccioRateLimit,
  shouldRotateAccioAccount,
} from '../../src/accio-adapter.js'
import { nextUtc8DayStartMs } from '../../src/model-queue.js'
import type { AccioCredential } from '../../src/accio.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

function cred(token: string): AccioCredential {
  return {
    access_token: token,
    refresh_token: `RT-${token}`,
    expires_at: Date.now() + 3_600_000,
    region: 'cn',
  }
}

/** 上游真实帧形状：`content` 在**顶层**。 */
function okFrame(text: string): Record<string, unknown> {
  return { content: { role: 'model', parts: [{ text }] }, partial: true }
}

function sse(...frames: unknown[]): Response {
  return new Response(
    `${frames.map((f) => `data: ${JSON.stringify(f)}\n`).join('')}`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** 流内 402（HTTP 仍是 200）—— accio 最常见的额度失败形态。 */
const STREAM_QUOTA_402 = (): Response => new Response(
  'data: {"turn_complete":true,"error_code":"402","error_message":"unauthorized"}\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
)

const OPTIONS: GenerateOptions = {
  model: '1Drift-N8kP2Q7wR5mX',
  messages: [{ role: 'user', content: '你好' }],
} as unknown as GenerateOptions

interface PoolRecord { id: string; credential: AccioCredential }

/**
 * 与真实 `AccountPool` 同形的替身。
 *
 * ⚠️ **两条腿都必须实现**，缺一条该腿的变异就无牙（变异验证实测）：
 * ① **尊重 `exclude`**：真实池按用户手动顺序返回、且会跳过排除集
 *    （`account-pool.ts` 的 `getAvailableAccount`）。不实现 ⇒ 「漏传 `tried`」
 *    的缺陷在测试里**看不出来**（桩会自己轮着发）。
 * ② **按 `modelId` 过滤 `modelRateLimits`**：真实池里
 *    `if (modelId.length === 0) return true` ⇒ **传空串会让限流过滤整体短路**，
 *    刚被标记冷却的账号立刻又被选中（trae 记过的真实用户报障）。
 *    不实现这条 ⇒ 「modelId 传空串」的变异**全绿**（实测 M12 无牙）。
 */
function makePool(accounts: PoolRecord[]) {
  const picks: Array<{ model: string; exclude: string[] }> = []
  const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
  /** 与真实池同形：`accountId → {modelId → resetAtMs}`。 */
  const limits = new Map<string, Record<string, number>>()
  const pool = {
    getAvailableAccount: async (
      _provider: string,
      modelId: string,
      exclude?: ReadonlySet<string>,
    ): Promise<{ entry: { id: string; credentialRef: string }; credential: AccioCredential } | null> => {
      picks.push({ model: modelId, exclude: [...(exclude ?? [])] })
      for (const account of accounts) {
        if (exclude?.has(account.id) === true) continue
        // ⚠️ 与 `account-pool.ts` 逐格同构：空 modelId 不做限流过滤（短路）。
        if (modelId.length > 0) {
          const resetAt = limits.get(account.id)?.[modelId]
          if (resetAt !== undefined && resetAt !== 0 && Date.now() < resetAt) continue
        }
        return { entry: { id: account.id, credentialRef: `REF_${account.id}` }, credential: account.credential }
      }
      return null
    },
    updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
      marks.push({ accountId, modelId, resetAtMs })
      limits.set(accountId, { ...(limits.get(accountId) ?? {}), [modelId]: resetAtMs })
    },
    findAccountIdByCredential: async (_provider: string, token: string) =>
      accounts.find((a) => a.credential.access_token === token)?.id ?? '',
  }
  return { pool, picks, marks, limits }
}

/** 取出实际发出的 `body.token` 序列（**判别力所在**）。 */
function sentTokens(fetcher: ReturnType<typeof vi.fn>): string[] {
  return fetcher.mock.calls.map((call) => String(
    (JSON.parse(String((call as [string, RequestInit])[1].body)) as { token?: string }).token,
  ))
}

interface RunResult { chunks: StreamChunk[]; error: unknown }

/** 跑一轮 `stream()`，错误也收回来（由用例自行断言）。 */
async function run(adapter: AccioAdapter): Promise<RunResult> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream(OPTIONS)) chunks.push(chunk)
    return { chunks, error: null }
  } catch (error) {
    return { chunks, error }
  }
}

/**
 * 造一个适配器，`fetchImpl` 按调用序回放 `responses`。
 *
 * ⚠️ `resolveCredential` **刻意走池**（模拟接线层 `createCredentialResolver`）：
 * 只在首次取号，换号由适配器自己驱动 —— 这正是本 issue 的形态。
 */
function makeAdapter(
  accounts: PoolRecord[],
  responses: Array<Response | (() => Response)>,
  extra: { pool?: unknown; refresh?: () => Promise<void> } = {},
): { adapter: AccioAdapter; fetcher: ReturnType<typeof vi.fn>; pool: ReturnType<typeof makePool> } {
  const { pool, picks, marks, limits } = makePool(accounts)
  const queue = [...responses]
  const fetcher = vi.fn(async () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('unexpected fetch call')
    return typeof next === 'function' ? next() : next
  })
  const adapter = new AccioAdapter({
    resolveCredential: async (modelId?: string) => {
      const a = await pool.getAvailableAccount('accio', modelId ?? '')
      return a?.credential
    },
    refresh: extra.refresh ?? (async () => {}),
    fetchImpl: fetcher as unknown as typeof fetch,
    accountPool: (extra.pool ?? pool) as never,
  })
  return { adapter, fetcher, pool: { pool, picks, marks, limits } }
}

// ---------------------------------------------------------------------------
// 类别判据（纯函数）
// ---------------------------------------------------------------------------

describe('accio 失败类别判据', () => {
  it('★ 四条通道各自映射到正确的类别', () => {
    // ⚠️ 这些值必须与 `httpErrorCode` / `accioErrorFrame` 的**产出**逐字相同 ——
    // 本表刻意不重扫状态码（那是「同一语义两套判据」）。
    expect(accioFailureClassOf('QUOTA_EXCEEDED')).toBe('quota')
    expect(accioFailureClassOf('RATE_LIMIT')).toBe('rate')
    expect(accioFailureClassOf('AUTH')).toBe('auth')
    expect(accioFailureClassOf('INVALID_REQUEST')).toBe('other')
    expect(accioFailureClassOf('SERVER')).toBe('other')
    expect(accioFailureClassOf('EMPTY_RESPONSE')).toBe('other')
  })

  it('★★ 认证类**只换号、绝不写冷却**（2026-10-06「全池被封」不变式）', () => {
    // ⚠️ 这是本组最要紧的一条断言：`AUTH` 若也写标记，一个请求就能把整个
    // provider 封一天（网关对全池回 401 的形态）。
    expect(shouldRotateAccioAccount('AUTH')).toBe(true)
    expect(recordsAccioRateLimit('AUTH')).toBe(false)
    expect(recordsAccioRateLimit('QUOTA_EXCEEDED')).toBe(true)
    expect(recordsAccioRateLimit('RATE_LIMIT')).toBe(true)
  })

  it('★ `other` 类一律不换号（换号无益、白烧整池）', () => {
    for (const code of ['INVALID_REQUEST', 'SERVER', 'TRANSPORT', 'EMPTY_RESPONSE', 'UNSUPPORTED_CONTENT']) {
      expect(shouldRotateAccioAccount(code), code).toBe(false)
      expect(recordsAccioRateLimit(code), code).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 行为：HTTP 层换号（issue 的主复现路径）
// ---------------------------------------------------------------------------

describe('accio 请求级换号 · HTTP 层', () => {
  it('HTTP 403 HTML：直接报告网关拒绝，不续期、不换号', async () => {
    const refresh = vi.fn(async () => {})
    const { adapter, fetcher, pool } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [
        new Response('<html>Forbidden</html>', {
          status: 403,
          headers: { 'content-type': 'text/html; charset=UTF-8' },
        }),
        sse(okFrame('不应再次请求')),
      ],
      { refresh },
    )
    const { error } = await run(adapter)
    expect(error).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(refresh).not.toHaveBeenCalled()
    expect(sentTokens(fetcher)).toEqual(['TOK-A'])
    expect(pool.marks).toHaveLength(0)
  })

  it('HTTP 403 JSON：仍按认证失败先续期、再换号', async () => {
    const refresh = vi.fn(async () => {})
    const { adapter, fetcher } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [
        Response.json({ message: 'Forbidden' }, { status: 403 }),
        Response.json({ message: 'Forbidden' }, { status: 403 }),
        sse(okFrame('换号后成功')),
      ],
      { refresh },
    )
    const { error } = await run(adapter)
    expect(error).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(sentTokens(fetcher)).toEqual(['TOK-A', 'TOK-A', 'TOK-B'])
  })

  it('★★ issue 主复现：#1 额度耗尽（HTTP 402）⇒ 换到 #2 并成功', async () => {
    const { adapter, fetcher, pool } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [
        new Response('{"error":"insufficient balance"}', { status: 402 }),
        sse(okFrame('从二号账号返回')),
      ],
    )
    const { chunks, error } = await run(adapter)
    // ⚠️ 判别力在第二发的 token：换号不生效时它是 TOK-A。
    expect(sentTokens(fetcher), '第二发必须是二号账号的令牌').toEqual(['TOK-A', 'TOK-B'])
    expect(error).toBeNull()
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    // ⚠️ 池必须**排除已试账号**（漏传 `tried` 时这里会是 `[]`）。
    expect(pool.picks.map((p) => p.exclude.join(','))).toEqual(['', 'acc-1'])
  })

  it('★★ 额度冷却必须写到**真正失败的那个账号**、且到 UTC+8 当日 24:00', async () => {
    const { adapter, pool } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [
        new Response('{"error":"insufficient balance"}', { status: 402 }),
        sse(okFrame('好')),
      ],
    )
    await run(adapter)
    expect(pool.marks).toHaveLength(1)
    expect(pool.marks[0]?.accountId, '不得记到换号后的账号头上').toBe('acc-1')
    expect(pool.marks[0]?.modelId, '限流是按模型记的').toBe('1Drift-N8kP2Q7wR5mX')
    // ⚠️ **不许**是「现在 + 24h」：那是 IKL80H 记过的滑动窗口缺陷。
    expect(pool.marks[0]?.resetAtMs).toBe(nextUtc8DayStartMs())
  })

  it('★★ 401：先续期当前账号；续期救不回来才换号', async () => {
    const refresh = vi.fn(async () => {})
    const { adapter, fetcher } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [
        new Response('unauthorized', { status: 401 }),
        // ⚠️ 续期后 `resolveCredential` 仍回 TOK-A（池里一号还排第一）⇒
        // 第二次 401 ⇒ 这才轮到换号，第三次成功。
        new Response('unauthorized', { status: 401 }),
        sse(okFrame('换号后成功')),
      ],
      { refresh },
    )
    const { error } = await run(adapter)
    expect(error).toBeNull()
    expect(refresh, '401 必须先续期一次').toHaveBeenCalled()
    expect(sentTokens(fetcher)).toEqual(['TOK-A', 'TOK-A', 'TOK-B'])
  })

  it('★★ 401 换号**绝不写冷却标记**（全池被封不变式的行为级锁）', async () => {
    const { adapter, pool } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [
        new Response('unauthorized', { status: 401 }),
        new Response('unauthorized', { status: 401 }),
        sse(okFrame('好')),
      ],
    )
    await run(adapter)
    expect(pool.marks, '认证类写了标记 ⇒ 一个请求能封死整池').toHaveLength(0)
  })

  it('★ 429 换号 + 1 小时冷却', async () => {
    const { adapter, fetcher, pool } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [
        new Response('too many requests', { status: 429 }),
        sse(okFrame('好')),
      ],
    )
    const { error } = await run(adapter)
    expect(error).toBeNull()
    expect(sentTokens(fetcher)).toEqual(['TOK-A', 'TOK-B'])
    expect(pool.marks[0]?.accountId).toBe('acc-1')
    const delta = (pool.marks[0]?.resetAtMs ?? 0) - Date.now()
    expect(delta).toBeGreaterThan(55 * 60_000)
    expect(delta).toBeLessThan(65 * 60_000)
  })

  it('★★ 反向对照：400 参数错**只发一次、绝不换号**（换号无益、白烧整池）', async () => {
    const { adapter, fetcher, pool } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [new Response('{"error":"bad request"}', { status: 400 })],
    )
    const { error } = await run(adapter)
    expect((error as LlmError).code).toBe('INVALID_REQUEST')
    expect(sentTokens(fetcher), '400 换号只会白烧二号账号').toEqual(['TOK-A'])
    expect(pool.picks.filter((p) => p.exclude.length > 0), '根本不该有第二次取号').toHaveLength(0)
  })

  it('★★ 反向对照：风控拦截页（200 + HTML）不换号', async () => {
    // ⚠️ 这一格与「流内 402 要换号」同形（都是 HTTP 200），最容易被误伤。
    const { adapter, fetcher } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [new Response('<a id="a-link" href="https://bixi-intl.alicdn.com/punish/…"></a>',
        { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } })],
    )
    const { error } = await run(adapter)
    expect((error as LlmError).code).toBe('SERVER')
    expect(sentTokens(fetcher)).toEqual(['TOK-A'])
  })

  it('★★ 全池耗尽 ⇒ 报「所有账号均不可用」并带**最后一次**的真实原因', async () => {
    // ⚠️ 笼统的「额度用尽」会丢掉服务端真正说的东西（minimax 的同款教训）。
    const { adapter, fetcher, pool } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [
        new Response('{"error":"insufficient balance A"}', { status: 402 }),
        new Response('{"error":"insufficient balance B-真实原因"}', { status: 402 }),
      ],
    )
    const { error } = await run(adapter)
    expect(sentTokens(fetcher), '两个账号各试一次').toEqual(['TOK-A', 'TOK-B'])
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    expect((error as Error).message).toContain('B-真实原因')
    // ⚠️ 两个账号都要留下冷却标记（否则下次又选中它们）。
    expect(pool.marks.map((m) => m.accountId).sort()).toEqual(['acc-1', 'acc-2'])
  })

  it.each([
    {
      格: 'HTTP 402',
      // ⚠️ 每发都失败 ⇒ 换号直到预算耗尽。
      responses: (n: number) => Array.from(
        { length: n }, () => new Response('{"error":"insufficient balance"}', { status: 402 }),
      ),
      expectCode: 'QUOTA_EXCEEDED',
    },
    {
      格: '流内 402（HTTP 200 + 错误帧）',
      // ⚠️ **这条是审计补的**（2026-10-18）：原用例只喂 HTTP 402 ⇒ 从没进过
      // 流内分支 ⇒ 段② 的 `round >= ACCIO_MAX_ROTATE - 1` 那一格**零覆盖**
      // （实测把它改成 99 全绿）。
      responses: (n: number) => Array.from({ length: n }, () => STREAM_QUOTA_402()),
      expectCode: 'QUOTA_EXCEEDED',
    },
  ])('★★ 换号有界（$格）：账号数多于预算时不得无限发', async ({ responses, expectCode }) => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `acc-${i + 1}`, credential: cred(`TOK-${i + 1}`),
    }))
    const { adapter, fetcher } = makeAdapter(many, responses(20))
    const { error } = await run(adapter)
    expect(sentTokens(fetcher).length, '预算是 8（ACCIO_MAX_ROTATE），不得更多')
      .toBeLessThanOrEqual(8)
    expect((error as LlmError).code).toBe(expectCode)
  })

  it('★ 坏凭据（`{}`）被跳过，不得掐断整个轮换', async () => {
    // ⚠️ 池的凭据是**裸 `JSON.parse`**（`getAvailableAccount` 不做形状校验），
    // 手工编辑过的备份可能损坏 ⇒ `access_token.length` 会抛 `TypeError`
    // （非 `LlmError`）且若用 `break` 则一个坏号就把整池掐断（minimax 同款）。
    const { pool, picks, marks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-bad', credential: {} as AccioCredential },
      { id: 'acc-3', credential: cred('TOK-C') },
    ])
    // ⚠️ **只有两发**：坏号 acc-bad 被跳过时**不发请求**，故序列是
    // 「TOK-A 402 → TOK-C 200」—— 若实现给坏号也发了一发，这里会 `unexpected fetch`。
    const queue: Array<Response | (() => Response)> = [
      new Response('{"error":"insufficient balance"}', { status: 402 }),
      sse(okFrame('第三个账号成功')),
    ]
    const fetcher = vi.fn(async () => {
      const n = queue.shift()
      if (n === undefined) throw new Error('unexpected fetch')
      return typeof n === 'function' ? n() : n
    })
    const adapter = new AccioAdapter({
      resolveCredential: async () => pool.getAvailableAccount('accio', '')
        .then((a) => a?.credential as AccioCredential),
      refresh: async () => {},
      fetchImpl: fetcher as unknown as typeof fetch,
      accountPool: pool as never,
    })
    const { error } = await run(adapter)
    expect(error, '坏号必须被跳过而不是掐断轮换').toBeNull()
    // ⚠️ **不得**给坏号发一发注定 401 的请求。
    expect(sentTokens(fetcher)).toEqual(['TOK-A', 'TOK-C'])
    expect(picks.map((p) => p.exclude.join(','))).toEqual(['', 'acc-1', 'acc-1,acc-bad'])
    expect(marks.map((m) => m.accountId)).toEqual(['acc-1'])
  })
})

// ---------------------------------------------------------------------------
// 行为：流内换号（本家最常见的额度形态）
// ---------------------------------------------------------------------------

describe('accio 请求级换号 · 流内（HTTP 200 + 错误帧）', () => {
  it('★★ issue 第二复现路径：流内 402 ⇒ 换号到 #2 并成功', async () => {
    const { adapter, fetcher, pool } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [STREAM_QUOTA_402(), sse(okFrame('换号后成功'))],
    )
    const { chunks, error } = await run(adapter)
    expect(error).toBeNull()
    expect(sentTokens(fetcher), '流内 402 必须换号').toEqual(['TOK-A', 'TOK-B'])
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    // ⚠️ 额度写冷却，且记在失败的那个号上。
    expect(pool.marks[0]?.accountId).toBe('acc-1')
    expect(pool.marks[0]?.resetAtMs).toBe(nextUtc8DayStartMs())
  })

  it('★★ 已产出内容后遇流内 402 ⇒ **不换号**（换号会拼正文、重复执行工具）', async () => {
    // ⚠️ 这是本组**最危险**的一条：换号会重放整次请求、新的 `consumeAccioSse`
    // 是全新生成器 ⇒ 用户会看到两份内容、工具被执行两次
    // （lobsterai 记过同款真实事故）。
    const { adapter, fetcher, pool } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [new Response([
        `data: ${JSON.stringify(okFrame('已经说了一半'))}\n`,
        'data: {"turn_complete":true,"error_code":"402","error_message":"unauthorized"}\n',
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      sse(okFrame('二号账号的内容不该出现'))],
    )
    const { error } = await run(adapter)
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    expect(sentTokens(fetcher), '已产出内容后换号 = 用户看到重复内容').toEqual(['TOK-A'])
    // ⚠️ 仍要**记账**（否则这个号永不被冷却，下次又选中它）。
    expect(pool.marks.map((m) => m.accountId)).toEqual(['acc-1'])
  })

  it('★★ 反向对照：流内 `error_code:"500"` 不换号', async () => {
    // ⚠️ `accioErrorFrame` 把非 402 的错误码统一归 `SERVER` ⇒ 不该换号。
    const { adapter, fetcher } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [new Response('data: {"error_code":"500","error_message":"internal"}\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      sse(okFrame('不该出现'))],
    )
    const { error } = await run(adapter)
    expect((error as LlmError).code).toBe('SERVER')
    expect(sentTokens(fetcher)).toEqual(['TOK-A'])
  })

  it('★★ 反向对照：已中断的 signal 下流内 402 不换号', async () => {
    // ⚠️ 判据是 `signal.aborted`，所以 signal **必须真的已中断**才有判别力 ——
    // 一个从未 abort 的 signal 会让本用例恒绿（它连 402 都遇不到）。
    // ⚠️ 池替身会**一直**给得出下一个账号 ⇒ 「没换号」只可能来自 abort 早退。
    const fetcher = vi.fn(async () => STREAM_QUOTA_402())
    const picks: string[][] = []
    const adapter = new AccioAdapter({
      resolveCredential: async () => cred('TOK-A'),
      refresh: async () => {},
      fetchImpl: fetcher as unknown as typeof fetch,
      accountPool: {
        getAvailableAccount: async (_p: string, _m: string, ex?: ReadonlySet<string>) => {
          picks.push([...(ex ?? [])])
          return { entry: { id: 'acc-2', credentialRef: 'R' }, credential: cred('TOK-B') }
        },
        updateModelRateLimit: async () => {},
        findAccountIdByCredential: async () => 'acc-1',
      } as never,
    })
    const chunks: StreamChunk[] = []
    await expect((async () => {
      for await (const c of adapter.stream({ ...OPTIONS, signal: AbortSignal.abort() } as GenerateOptions)) {
        chunks.push(c)
      }
    })()).rejects.toThrow()
    expect(fetcher, '中断后不得换号重发').toHaveBeenCalledTimes(1)
    // ⚠️ 关键：池**根本没被问过第二次**（换号判定在 abort 早退之后）。
    expect(picks, '中断 ⇒ 连取号都不该发生').toHaveLength(0)
  })

  it('★ 对照：signal 未中断时同一场景**确实会换号**（证明上一条不是因为别的原因）', async () => {
    const { adapter, fetcher } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [STREAM_QUOTA_402(), sse(okFrame('换号后成功'))],
    )
    const { error } = await run(adapter)
    expect(error).toBeNull()
    expect(sentTokens(fetcher)).toEqual(['TOK-A', 'TOK-B'])
  })

  it('★★ 已中断时不得换号、不得写冷却（中断不是账号失败）', async () => {
    // ## ⚠️ 这条**实测无牙**，如实登记（勿删勿当守卫）
    //
    // 变异验证 M15（删掉 `options.signal?.aborted` 那一格）实测**全绿**。
    // 追查到的真实原因：`AbortSignal.abort()` 下抛的是
    // **`DOMException` / `name: 'AbortError'` / `code: 20`**（实测）——
    // 它**不是 `LlmError`** ⇒ `error.code` 取到的是 `undefined`（经
    // `error instanceof LlmError ? error.code : ''` 归成 `''`）
    // ⇒ `shouldRotateAccioAccount('')` 判 `other` ⇒ 上面那条早退**已经**拦住。
    //
    // ⇒ 因此本实现里 `signal?.aborted` 那一格是**防御性冗余**：
    // 它只在上游把「中断」包成 `LlmError('QUOTA_EXCEEDED')` 时才生效
    // （形变不可测、但删除它会让那条路径变成「拿取消当额度耗尽换号」）。
    // **本组不为此编恒真用例**（本仓库纪律：无牙要如实登记，绝不为它编造用例）。
    const marks: string[] = []
    const fetcher = vi.fn(async () => STREAM_QUOTA_402())
    const adapter = new AccioAdapter({
      resolveCredential: async () => cred('TOK-A'),
      refresh: async () => {},
      fetchImpl: fetcher as unknown as typeof fetch,
      accountPool: {
        getAvailableAccount: async () => ({
          entry: { id: 'acc-2', credentialRef: 'R' }, credential: cred('TOK-B'),
        }),
        updateModelRateLimit: async (accountId: string) => { marks.push(accountId) },
        findAccountIdByCredential: async () => 'acc-1',
      } as never,
    })
    await expect((async () => {
      for await (const _c of adapter.stream({
        ...OPTIONS, signal: AbortSignal.abort(),
      } as GenerateOptions)) { /* 预期无内容 */ }
    })()).rejects.toThrow()
    // ⚠️ 断言的是**行为**（中断不换号、不写冷却），而**不是**「某一行代码存在」
    // —— 后者本组已实测无牙，如上登记。
    expect(fetcher, '中断后不得换号重发').toHaveBeenCalledTimes(1)
    expect(marks, '中断不得写冷却（否则用户点两下取消就封掉一个好号）').toEqual([])
  })

  it('★★ 换号后取回的账号在 HTTP 层就失败 ⇒ 继续换下一个', async () => {
    // ⚠️ 这一格区分两种实现：把 HTTP 错误就地 catch-and-rewrap 成
    // `SERVER` 会把额度语义整段丢掉（accio-messages 那条铁律）。
    const { adapter, fetcher, pool } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
        { id: 'acc-3', credential: cred('TOK-C') },
      ],
      [STREAM_QUOTA_402(), new Response('{"error":"insufficient balance B"}', { status: 402 }),
        sse(okFrame('第三个账号成功'))],
    )
    const { error } = await run(adapter)
    expect(error).toBeNull()
    expect(sentTokens(fetcher)).toEqual(['TOK-A', 'TOK-B', 'TOK-C'])
    expect(pool.marks.map((m) => m.accountId)).toEqual(['acc-1', 'acc-2'])
  })
})

// ---------------------------------------------------------------------------
// modelId 腿：传空串会让限流过滤整体短路
// ---------------------------------------------------------------------------

describe('accio 换号的 modelId 腿（trae 记过的真实用户报障）', () => {
  it('★★ 桩的自检：限流过滤腿真的生效（删掉它 ⇒ 本组会红）', async () => {
    // ⚠️⚠️ **第一版这条是恒真的**（只断言 `limits.size === 0`，压根没碰过滤腿）
    // ⇒ 变异验证实测：把上面 `makePool` 里的限流过滤**整段删掉**，本组 24 条
    // **全绿**。这正是本组自己警告过的失效模式（「替身缺一条真实实现里有的腿
    // ⇒ 对应变异全体无牙」），却恰好在自己写的自检上犯了。
    //
    // ⇒ 现在的判据必须**真去调池**、并断言「被冷却的账号确实选不回来」：
    //   ① 先取一次号（拿到 acc-1），
    //   ② 把它在该模型上冷却到未来，
    //   ③ 再取一次 ⇒ **必须**换成 acc-2（过滤腿生效）；
    //   ④ 用**空 modelId** 取 ⇒ **必须**又是 acc-1（空串短路，与真实池同形）。
    // 删掉过滤腿时 ③ 会返回 acc-1 ⇒ 红。
    const { pool } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    const first = await pool.getAvailableAccount('accio', 'M1')
    expect(first?.entry.id).toBe('acc-1')
    await pool.updateModelRateLimit('acc-1', 'M1', Date.now() + 3_600_000)
    // ③ 被冷却的号选不回来。
    expect((await pool.getAvailableAccount('accio', 'M1'))?.entry.id, '被冷却的账号必须被跳过')
      .toBe('acc-2')
    // ④ 空 modelId 短路（真实池 `if (modelId.length === 0) return true`）。
    expect((await pool.getAvailableAccount('accio', ''))?.entry.id, '空 modelId 不做限流过滤')
      .toBe('acc-1')
    // ⑤ 排除集仍然生效（这条腿若退化，漏传 `tried` 的变异会无牙）。
    // ⚠️ 断言 `null` 而非 `undefined`：真实池返回 `null`，而 `?.entry.id` 会把
    // `null` 折成 `undefined` ⇒ 断言 `undefined` 就**分不出**「池返回 null」
    // 与「池返回了一个没有 id 的条目」，这里必须直接比池的原始返回。
    expect(await pool.getAvailableAccount('accio', 'M1', new Set(['acc-2'])),
      'exclude 掉唯一候选后必须返回 null（不是 undefined）').toBeNull()
  })

  it('★★ 换号必须传真实 modelId：空串会让「刚标记的号」立刻又被选回', async () => {
    // ## 这条为什么必须有判别力（变异验证实测）
    //
    // 若池替身**不实现** `modelRateLimits` 过滤腿，那么「传空串」与「传真值」
    // 两种实现在测试里**逐字节同形** ⇒ 变异 M12 全绿（实测无牙）。
    // 本组的 `makePool` 实现了那条腿，本用例才真正锁得住它。
    const { adapter, pool } = makeAdapter(
      [
        { id: 'acc-1', credential: cred('TOK-A') },
        { id: 'acc-2', credential: cred('TOK-B') },
      ],
      [
        new Response('{"error":"insufficient balance"}', { status: 402 }),
        sse(okFrame('好')),
      ],
    )
    await run(adapter)
    // ⚠️ 判据在**取号时传的 modelId**（桩的 `picks` 逐字记下）。
    expect(pool.picks[0]?.model).toBe('1Drift-N8kP2Q7wR5mX')
    // ⚠️ 且必须**非空**（空串 = 短路整个限流过滤，trae 的报障根因）。
    expect(pool.picks.some((p) => p.model === ''), '不得用空 modelId 取号').toBe(false)
  })

})

// ---------------------------------------------------------------------------
// 续期后的账号反查（minimax `51ded6a` / loomy 同款）
// ---------------------------------------------------------------------------

describe('accio 续期后的账号反查', () => {
  it('★★ 401 续期换到另一个账号后，后续冷却必须记到**那个**账号头上', async () => {
    // ## 为什么不能只测「401 续期换号」（第一版就是这么写的，结构上无牙）
    //
    // 认证类**只换号、绝不写冷却**（全池被封不变式）⇒ 401 路径上**没有任何**
    // 可观测的记账动作，写出来的 `expect(marks).toEqual([...])` 恒等于
    // `expect(marks).toEqual([])`（变异验证实测：去掉反查后该用例仍全绿）。
    //
    // ⇒ 必须让**续期换号之后的那个账号**去撞一次**额度**失败（写冷却），
    // 才能观测到 `currentAccountId` 到底停在谁头上。
    //
    // ## 场景
    //
    // 接线层的 `refresh()` 走 `pool.getAvailableAccount(id, '')`（**不带 tried**）
    // ⇒ 可能续期的是**另一个**账号。若适配器不跟着更新 `currentAccountId`，
    // 冷却会记到**没失败的那个号**头上（被误封），而真该封的号下次仍被选中。
    const accounts = [
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
      { id: 'acc-3', credential: cred('TOK-C') },
    ]
    const marks: Array<{ accountId: string }> = []
    let refreshed = false
    const pool = {
      // ⚠️ 复刻真实接线层：`refresh()` 那条路**不带 tried**、拿池里第一个。
      getAvailableAccount: async (_p: string, _m: string, ex?: ReadonlySet<string>) => {
        for (const a of accounts) {
          if (ex?.has(a.id)) continue
          return { entry: { id: a.id, credentialRef: `R_${a.id}` }, credential: a.credential }
        }
        return null
      },
      updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
      findAccountIdByCredential: async (_p: string, token: string) =>
        accounts.find((a) => a.credential.access_token === token)?.id ?? '',
    }
    // 序列：TOK-A 401 → 续期得 TOK-B → 仍 401 → 轮换到 TOK-C → 流内 402（写冷却）。
    const queue: Array<Response | (() => Response)> = [
      new Response('unauthorized', { status: 401 }),
      new Response('unauthorized', { status: 401 }),
      STREAM_QUOTA_402(),
    ]
    const fetcher = vi.fn(async () => {
      const n = queue.shift()
      if (n === undefined) throw new Error('unexpected fetch')
      return typeof n === 'function' ? n() : n
    })
    const adapter = new AccioAdapter({
      resolveCredential: async () => {
        // ⚠️ 续期后返回**另一个**账号的凭据（真实形态：续期走池里第一个）。
        return (refreshed ? accounts[1]!.credential : accounts[0]!.credential)
      },
      refresh: async () => { refreshed = true },
      fetchImpl: fetcher as unknown as typeof fetch,
      accountPool: pool as never,
    })
    const { error } = await run(adapter)
    // ⚠️ 三号都试完 ⇒ 报「所有账号额度耗尽」。
    expect(sentTokens(fetcher)).toEqual(['TOK-A', 'TOK-B', 'TOK-C'])
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    // ⚠️ **判别力**：没有反查时 `currentAccountId` 停在 acc-1 ⇒ 冷却记到 acc-1
    //（被误封）；有反查则记到 acc-3（真正撞额度失败的那个号）。
    expect(marks.map((m) => m.accountId), '冷却必须记在真正失败的账号上')
      .toEqual(['acc-3'])
  })
})

// ---------------------------------------------------------------------------
// 无账号池
// ---------------------------------------------------------------------------

describe('accio 无账号池时', () => {
  it('★ 如实抛错，不静默重试（单凭据形态不得被换号逻辑改写）', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"insufficient balance"}', { status: 402 }))
    const adapter = new AccioAdapter({
      resolveCredential: async () => cred('TOK-A'),
      refresh: async () => {},
      fetchImpl: fetcher as unknown as typeof fetch,
    })
    const { error } = await run(adapter)
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    expect(fetcher, '没有池就没有换号发生过').toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 对抗审计（2026-10-18）打穿的三处缺陷的回归守卫
// ---------------------------------------------------------------------------

describe('accio 对抗审计整改 · 三条不变式的行为级锁', () => {
  /**
   * ★★ P1-2：**反查必须先于 `credential` 赋值**。
   *
   * 反查抛错时若已换 `credential` ⇒ 冷却记到**无辜账号**、真凶漏记、同号重发。
   *
   * ⚠️ 判别力在**冷却记到谁** + **token 有没有重复**两处，缺一不可：
   * 只断言错误码是恒真的（修复前后完全一致）。
   */
  it('★★ 反查抛错 ⇒ 不得把冷却记到无辜账号、不得同号重发', async () => {
    const accounts = [
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
      { id: 'acc-3', credential: cred('TOK-C') },
    ]
    const marks: Array<{ accountId: string }> = []
    let refreshed = false
    const pool = {
      getAvailableAccount: async (_p: string, _m: string, ex?: ReadonlySet<string>) => {
        for (const a of accounts) {
          if (ex?.has(a.id)) continue
          return { entry: { id: a.id, credentialRef: `R_${a.id}` }, credential: a.credential }
        }
        return null
      },
      updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
      // ⚠️ 关键注入：反查**抛错**（可达形态见 `accio-auth.ts` —— access_token
      // 每次续期都轮换，账号停用时也会返回 ''）。
      findAccountIdByCredential: async (_p: string, token: string) => {
        if (token === 'TOK-B') throw new Error('LOOKUP BOOM')
        return accounts.find((a) => a.credential.access_token === token)?.id ?? ''
      },
    }
    const queue: Array<Response | (() => Response)> = [
      new Response('unauthorized', { status: 401 }),
      new Response('{"error":"insufficient balance"}', { status: 402 }),
      sse(okFrame('好')),
    ]
    const fetcher = vi.fn(async () => {
      const n = queue.shift()
      if (n === undefined) throw new Error('unexpected fetch')
      return typeof n === 'function' ? n() : n
    })
    const adapter = new AccioAdapter({
      resolveCredential: async () => (refreshed ? accounts[1]!.credential : accounts[0]!.credential),
      refresh: async () => { refreshed = true },
      fetchImpl: fetcher as unknown as typeof fetch,
      accountPool: pool as never,
    })
    const { error } = await run(adapter)
    expect(error).toBeNull()
    const tokens = sentTokens(fetcher)
    expect(new Set(tokens).size, `同一 token 不得重发：${JSON.stringify(tokens)}`)
      .toBe(tokens.length)
    /**
     * ⚠️ 冷却记到 **`acc-2`** 是正确的，别写成 acc-1 或 acc-3：
     * 反查失败 ⇒ `sendOnce` **不换凭据**、原样退回 401 ⇒ 走「记账 + 换号」格
     * ⇒ `rotate()` 从池取回 **acc-2**（`TOK-B`）⇒ **它**撞 402 ⇒ 记 **acc-2**。
     *
     * ⚠️ 这正是本用例的核心判别力：旧实现（先换 `credential` 再反查）会记到
     * **acc-1**（无辜的、根本没失败的那个号），且 `TOK-B` 被发两次。
     */
    expect(marks.map((m) => m.accountId), '冷却必须记在真正撞额度失败的账号上').toEqual(['acc-2'])
  })

  /**
   * ★★ P1-2 的第二腿：**`tried` 单调增长，绝不 `delete`**。
   *
   * 旧写法 `tried.delete(currentAccountId)` 会把刚失败的旧账号从已试集摘掉
   * ⇒ 它重新变成可取回候选 ⇒ 同号重发（实测 token 序列 `[A,B,C]` → `[A,B,A,C]`）。
   */
  it('★★ 续期换到新账号后，旧账号不得从 `tried` 里被摘掉', async () => {
    const accounts = [
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
      { id: 'acc-3', credential: cred('TOK-C') },
    ]
    const marks: Array<{ accountId: string }> = []
    let refreshed = false
    const excludes: string[][] = []
    const pool = {
      getAvailableAccount: async (_p: string, _m: string, ex?: ReadonlySet<string>) => {
        excludes.push([...(ex ?? [])])
        for (const a of accounts) {
          if (ex?.has(a.id)) continue
          return { entry: { id: a.id, credentialRef: `R_${a.id}` }, credential: a.credential }
        }
        return null
      },
      updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
      findAccountIdByCredential: async (_p: string, token: string) =>
        accounts.find((a) => a.credential.access_token === token)?.id ?? '',
    }
    const queue: Array<Response | (() => Response)> = [
      new Response('unauthorized', { status: 401 }),
      new Response('unauthorized', { status: 401 }),
      STREAM_QUOTA_402(),
    ]
    const fetcher = vi.fn(async () => {
      const n = queue.shift()
      if (n === undefined) throw new Error('unexpected fetch')
      return typeof n === 'function' ? n() : n
    })
    const adapter = new AccioAdapter({
      resolveCredential: async () => (refreshed ? accounts[1]!.credential : accounts[0]!.credential),
      refresh: async () => { refreshed = true },
      fetchImpl: fetcher as unknown as typeof fetch,
      accountPool: pool as never,
    })
    await run(adapter)
    // ⚠️ **每次换号取号的 exclude 都必须含 acc-1**（它试过且失败了）。
    // `tried.delete` 的变异会让某一次 exclude 丢掉 'acc-1' ⇒ 这里红。
    for (const ex of excludes) {
      expect(ex, `每次取号都必须排除 acc-1，实际 ${JSON.stringify(ex)}`).toContain('acc-1')
    }
    expect(sentTokens(fetcher)).toEqual(['TOK-A', 'TOK-B', 'TOK-C'])
  })

  /**
   * ★★ P2-1：**三处池/续期调用抛错都必须隔离**，且记账失败**不得掐断换号**。
   */
  it.each([
    { what: 'updateModelRateLimit', code: 402, expectStillRotates: true },
    { what: 'getAvailableAccount', code: 402, expectStillRotates: false },
    { what: 'refresh', code: 401, expectStillRotates: false },
  ])('★★ $what 抛错 ⇒ 裸 Error 不得逃逸（HTTP $code）', async ({ what, code }) => {
    const accounts = [
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ]
    const pool = {
      getAvailableAccount: async (_p: string, _m: string, ex?: ReadonlySet<string>) => {
        if (what === 'getAvailableAccount') throw new Error('POOL BOOM')
        for (const a of accounts) {
          if (ex?.has(a.id)) continue
          return { entry: { id: a.id, credentialRef: `R_${a.id}` }, credential: a.credential }
        }
        return null
      },
      updateModelRateLimit: async () => {
        if (what === 'updateModelRateLimit') throw new Error('DISK FULL')
      },
      findAccountIdByCredential: async (_p: string, token: string) =>
        accounts.find((a) => a.credential.access_token === token)?.id ?? '',
    }
    const queue: Array<Response | (() => Response)> = [
      new Response(code === 401 ? 'unauthorized' : '{"error":"insufficient balance"}', { status: code }),
      code === 401 ? sse(okFrame('换号后成功')) : sse(okFrame('换号后成功')),
    ]
    const fetcher = vi.fn(async () => {
      const n = queue.shift()
      if (n === undefined) throw new Error('unexpected fetch')
      return typeof n === 'function' ? n() : n
    })
    const adapter = new AccioAdapter({
      resolveCredential: async () => accounts[0]!.credential,
      refresh: async () => { if (what === 'refresh') throw new Error('REFRESH BOOM') },
      fetchImpl: fetcher as unknown as typeof fetch,
      accountPool: pool as never,
    })
    const { error } = await run(adapter)
    // ⚠️ **核心判据**：不得出现内部串（`POOL BOOM` / `DISK FULL` / `REFRESH BOOM`）。
    expect(String((error as Error)?.message ?? '')).not.toMatch(/BOOM|DISK FULL/)
    // ⚠️ 记账失败**必须仍然换号**（否则一次写盘失败就退化成「零换号」= 本 issue 的症状）。
    if (what === 'updateModelRateLimit') {
      expect(sentTokens(fetcher), '记账失败不得掐断换号').toEqual(['TOK-A', 'TOK-B'])
      expect(error).toBeNull()
    }
  })
})