import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuddyCredential } from '../../src/buddy.js'
import type { BuddyProduct } from '../../src/product.js'
import { collectBuddyGrowth } from '../../src/jet-hub-rpc.js'
import {
  AUTOMATABLE_TASK_CODES,
  GROWTH_TASK_COMPLETION,
  GROWTH_TASKS_PATHS,
  claimAllGrowth,
  claimGrowthTaskReward,
  fetchGrowthTaskCodes,
  fetchMarketExpertList,
  keepStreakActive,
  runGrowthTaskCompletions,
} from '../../src/buddy-growth.js'
/**
 * buddy 成长中心任务自动化的判据回归。
 *
 * 这组用例锁的是**服务端判据**。它们来自实测与逆向，不来自代码自洽性——正因如此
 * 最容易被后续维护当成「冗余」或「笔误」改回去。改动任何一条断言前，请先跑真实
 * 账号确认判据仍成立。
 */

/** 收集 fetcher 收到的请求，返回可断言的调用列表。 */
function recordingFetcher(
  responses: { status?: number; body?: unknown }[],
): { fetcher: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = []
  let i = 0
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const spec = responses[Math.min(i, responses.length - 1)] ?? {}
    i += 1
    const status = spec.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => spec.body ?? {},
      text: async () => JSON.stringify(spec.body ?? {}),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

const PRODUCT = {
  endpoint: 'https://copilot.tencent.com',
  apiDomain: 'copilot.tencent.com',
  claimBase: 'https://www.workbuddy.cn',
  userAgent: 'CodeBuddyIDE/4.12.2',
} as unknown as BuddyProduct
const CRED: BuddyCredential = {
  access_token: 'test-token',
  refresh_token: 'test-refresh',
  user_id: 'u1',
}

/** 从上报请求体里收集所有 eventCode。 */
function reportedEventCodes(calls: { url: string; init?: RequestInit }[]): string[] {
  const codes: string[] = []
  for (const call of calls) {
    if (!call.url.includes('/v2/report') || typeof call.init?.body !== 'string') continue
    try {
      const parsed = JSON.parse(call.init.body)
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        if (entry && typeof entry.eventCode === 'string') codes.push(entry.eventCode)
      }
    } catch {
      // 非 JSON 体不是本组断言的目标。
    }
  }
  return codes
}

/** 组装任务列表响应。`target` 由调用方决定——次数越多真实 sleep 越久。 */
function taskListBody(target = 5): unknown {
  return {
    code: 0,
    data: {
      tasks: [
        {
          task_code: 'chat_5',
          accept_status: 'not_accepted',
          progress: { current: 0, target },
        },
      ],
    },
  }
}

describe('GROWTH_TASKS_PATHS', () => {
  it('同时覆盖两族任务端点', () => {
    // 两族 schema 不同：/v2/… 用 task_code + accept_status + progress，
    // /…（无 /v2）用 code + status 且无 progress。只读一族会漏任务。
    expect(GROWTH_TASKS_PATHS).toContain('/v2/activity/growth/tasks')
    expect(GROWTH_TASKS_PATHS).toContain('/activity/growth/tasks')
  })
})

describe('fetchGrowthTaskCodes', () => {
  it('合并两族端点的任务码，而不是命中第一个就返回', () => {
    const { fetcher } = recordingFetcher([
      { body: { code: 0, data: { tasks: [{ task_code: 'chat_5', accept_status: 'not_accepted' }] } } },
      { body: { code: 0, data: { tasks: [{ code: 'first_chat', status: 'available' }] } } },
    ])
    return fetchGrowthTaskCodes(CRED, PRODUCT, fetcher).then(
      (r: { ok: boolean; codes: string[] }) => {
        expect(r.ok).toBe(true)
        expect(r.codes).toContain('chat_5')
        expect(r.codes).toContain('first_chat')
      },
    )
  })

  it('等级族按 status === \'available\' 判定可做，而非 accept_status', () => {
    const { fetcher } = recordingFetcher([
      { body: { code: 0, data: { tasks: [{ code: 'skill_installed', status: 'available' }] } } },
      { body: { code: 0, data: { tasks: [] } } },
    ])
    return fetchGrowthTaskCodes(CRED, PRODUCT, fetcher).then(
      (r: { codes: string[] }) => {
        expect(r.codes).toEqual(expect.arrayContaining(['skill_installed']))
      },
    )
  })

  it('某族端点失败时仍返回另一族的结果', () => {
    const { fetcher } = recordingFetcher([
      { status: 500, body: { code: 500 } },
      { body: { code: 0, data: { tasks: [{ code: 'template_used', accept_status: 'not_accepted' }] } } },
    ])
    return fetchGrowthTaskCodes(CRED, PRODUCT, fetcher).then(
      (r: { codes: string[] }) => {
        expect(r.codes).toContain('template_used')
      },
    )
  })
})

describe('claimGrowthTaskReward', () => {
  it('打 product.claimBase 而非 endpoint', () => {
    // 判据：endpoint 是 copilot.tencent.com，claim 走 web 域。
    const { fetcher, calls } = recordingFetcher([{ body: { code: 0 } }])
    return claimGrowthTaskReward(CRED, PRODUCT, fetcher, 'chat_5').then(() => {
      expect(calls[0]?.url).toBe('https://www.workbuddy.cn/activity/growth/tasks/chat_5/claim')
      expect(calls[0]?.url).not.toContain('copilot.tencent.com')
    })
  })

  it('幂等终态（already_claimed）判为已处理而非失败', () => {
    // 服务端对已领过任务返回 already_claimed:true，属幂等终态：
    // 不报错、不计新增积分，但也不能算作「领取成功」。
    const { fetcher } = recordingFetcher([
      { body: { code: 0, data: { already_claimed: true, credit: 0 } } },
    ])
    return claimGrowthTaskReward(CRED, PRODUCT, fetcher, 'chat_5').then(
      (r: { ok: boolean; claimed: boolean; credit: number }) => {
        expect(r.ok).toBe(true)
        expect(r.claimed).toBe(false)
        expect(r.credit).toBe(0)
      },
    )
  })

  it('响应体 code 非 0 时判失败并带出 msg', () => {
    // 判定以响应体 code + msg 为准，不只看 HTTP 状态。
    const { fetcher } = recordingFetcher([
      { status: 400, body: { code: 400, msg: 'insufficient energy' } },
    ])
    return claimGrowthTaskReward(CRED, PRODUCT, fetcher, 'chat_5').then(
      (r: { ok: boolean; claimed: boolean; message: string }) => {
        expect(r.ok).toBe(false)
        expect(r.claimed).toBe(false)
        expect(r.message).toContain('insufficient energy')
      },
    )
  })

  it('正常领取返回 credit', () => {
    const { fetcher } = recordingFetcher([
      { body: { code: 0, data: { credit: 120, energy: 5 } } },
    ])
    return claimGrowthTaskReward(CRED, PRODUCT, fetcher, 'chat_5').then(
      (r: { ok: boolean; claimed: boolean; credit: number }) => {
        expect(r.ok).toBe(true)
        expect(r.claimed).toBe(true)
        expect(r.credit).toBe(120)
      },
    )
  })
})

describe('fetchMarketExpertList', () => {
  it('凭据失效时返回空列表而非抛出', () => {
    const { fetcher } = recordingFetcher([{ status: 401, body: {} }])
    return fetchMarketExpertList(CRED, PRODUCT, fetcher).then(
      (r: { ok: boolean; experts: unknown[] }) => {
        expect(r.ok).toBe(false)
        expect(r.experts).toEqual([])
      },
    )
  })
})

describe('任务映射表的自洽性', () => {
  it('AUTOMATABLE_TASK_CODES 里的每个码都有 spec', () => {
    // 反向也要成立：spec 里存在的码都要在白名单里，否则永远进不了待办。
    const missing = [...AUTOMATABLE_TASK_CODES].filter(
      (code) => !GROWTH_TASK_COMPLETION[code],
    )
    expect(missing).toEqual([])
  })

  it('spec 里出现的码都在白名单里', () => {
    const known = new Set([...AUTOMATABLE_TASK_CODES, 'first_buddy'])
    const orphan = Object.keys(GROWTH_TASK_COMPLETION).filter((code) => !known.has(code))
    expect(orphan).toEqual([])
  })

  it('需要客户端或时间窗口的任务仍在白名单里', () => {
    // 这几项 API 推不动，但必须留在白名单：否则 UI 连「需客户端」都不显示，
    // 用户会以为没有这项任务。
    expect(AUTOMATABLE_TASK_CODES.has('wechat_linked')).toBe(true)
    expect(AUTOMATABLE_TASK_CODES.has('wb_wechat_oa_subscribe_task')).toBe(true)
    expect(AUTOMATABLE_TASK_CODES.has('black_cat')).toBe(true)
  })
})

describe('时间预算耗尽的分支', () => {
  // ⚠️ 该分支用 fake timers + `vi.setSystemTime` 驱动（见用例内注释）：
  // 真实时钟下会跑满反风控 sleep（任务间 1000ms、复查前 2000/4000ms），
  // 单测无法承受。
  it('预算耗尽后如实标记 timedOut，不谎报完成', async () => {
    // 所有响应都给任务列表：兜底 {} 会让真实对话拿不到 requestId，任务在三次
    // 请求内快速失败并早于预算判定点结束，测不到 timedOut 分支。
    vi.useFakeTimers()
    const taskBody = {
      code: 0,
      data: { tasks: [{ task_code: 'chat_5', accept_status: 'not_accepted', progress: { current: 0, target: 1 } }] },
    }
    // 不轮换响应：所有请求都返同一份任务列表。若用 recordingFetcher 的
    // 轮换兜底，/v2/chat/completions 会拿到任务列表而非对话体，
    // 真实对话拿不到 requestId 而提前失败，测不到 timedOut 分支。
    const calls: string[] = []
    const fetcher = (async (url: string) => {
      calls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => taskBody,
        text: async () => JSON.stringify(taskBody),
      } as unknown as Response
    }) as unknown as typeof fetch
    const work = runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 1 })
    // 先让函数真正进入异步流程（推进一个 tick），再把系统时间推到deadline 之后，
    // 使后续判定点Date.now() >= deadline。顺序反了会因Date.now() 尚未被 fake
    // timer 接管而失效。
    await vi.advanceTimersByTimeAsync(1)
    vi.setSystemTime(Date.now() + 10_000)
    await vi.runAllTimersAsync()
    const r = await work
    expect(r.timedOut).toBe(true)
    expect(r.results.some((x) => (x.message ?? '').includes('未执行'))).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
    vi.useRealTimers()
  })
})

describe('runGrowthTaskCompletions 的上报判据', () => {
  // 该函数按反风控要求真实 sleep（任务间 1000ms、复查前 2000/4000ms），
  // 单项 chat_5（target 5）就要约 20s，故用 fake timers 驱动时钟。
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 在推进 fake timer 的同时等待 runGrowthTaskCompletions 完成。 */
  async function runWithClock<T>(work: Promise<T>): Promise<T> {
    let done = false
    const settled = work.then(
      (v) => {
        done = true
        return v
      },
      (e) => {
        done = true
        throw e
      },
    )
    // 上限 200s 虚拟时间，防止断言不成立时死等。
    for (let i = 0; i < 2_000 && !done; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
    }
    return settled
  }

  it('按 progress.target 补足次数后上报 chat_request_send', () => {
    const { fetcher, calls } = recordingFetcher([{ body: taskListBody() }])
    return runWithClock(
      runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 600_000 }),
    ).then(() => {
      const sends = reportedEventCodes(calls).filter((c) => c === 'chat_request_send')
      // progress.target = 5，故至少发出 5 次。
      expect(sends.length).toBeGreaterThanOrEqual(5)
    })
  })

  it('spec 漏写时该项被跳过且不影响同轮其它项（两表不一致的兜底）', async () => {
    /**
     * ⚠️ 先说清事实：`runGrowthTaskCompletions` 里那句
     * `if (spec === undefined) { … '无完成动作实现' … }`（源码搜该文案）
     * **在正常运行下不可达** —— 上游已用
     * `actionable = codes.filter(c => GROWTH_TASK_COMPLETION[c] !== undefined)`
     * 把没有 spec 的码过滤掉了，所以循环体根本不会拿到 undefined。
     * 实测：把 `chat_5` 的 spec 删掉后，`results` 里**没有**它的条目。
     *
     * 故本用例锁的不是那个分支，而是**两表不一致时的真实可观测行为**：
     * 该项被静默跳过、整轮不崩、**同轮其它项照常完成**。
     * 这条不变量本身有意义：`AUTOMATABLE_TASK_CODES` 与
     * `GROWTH_TASK_COMPLETION` 是两张手工维护的表，前者有码而后者漏写时，
     * 最坏后果必须是「少做一项」，不能是「整轮失败」。
     *
     * ⚠️ 原版用例构造的是有 spec 的 `chat_5`，分支从未进入、唯一断言是
     * `expect(r).toBeDefined()` —— 任何不崩的实现都能过，属本仓库明令禁止的
     * **同义反复**用例。
     */
    const table = GROWTH_TASK_COMPLETION as unknown as Record<string, unknown>
    const saved = table['chat_5']
    delete table['chat_5']
    try {
      const { fetcher } = recordingFetcher([
        {
          body: {
            code: 0,
            data: {
              tasks: [
                // 无 spec 的项（会被跳过）
                { task_code: 'chat_5', accept_status: 'in_progress', progress: { current: 0, target: 1 } },
                // 同轮的正常项：必须照常完成，证明跳过是局部的
                { task_code: 'Library_read', accept_status: 'in_progress', progress: { current: 0, target: 1 } },
              ],
            },
          },
        },
      ])
      const r = await runWithClock(
        runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 600_000 }),
      )
      // 无 spec 的项被跳过（不出现在 results 里），而不是让整轮抛错。
      expect(r.results.some((x) => x.taskCode === 'chat_5')).toBe(false)
      // 同轮其它项不受影响 —— 这才是「不影响整轮」的实证。
      expect(r.results.some((x) => x.taskCode === 'Library_read')).toBe(true)
      // 整轮没有把这一项算成 failed（它是被跳过，不是失败）。
      expect(r.ok).toBe(true)
    } finally {
      table['chat_5'] = saved
    }
  })
})

describe('养虾等级族的事件不可达短路', () => {
  // 这族任务的第二端点不返回 progress，只返回 status（available = 未达成）。
  // 事件上报改变不了 status，故合成链未达标时**不得**再做真实会话重试 ——
  // 那一次重试要发一条真实对话并等 4s 结算，而结果已确定不会变。
  const LEVEL_CODES = ['first_chat', 'template_used', 'expert_summoned', 'skill_installed']

  it.each(LEVEL_CODES)('%s 合成链未达标时不发真实会话', async (code) => {
    const { fetcher, calls } = recordingFetcher([{ body: levelTaskList(code) }])
    const r = await runGrowthTaskCompletions(CRED, PRODUCT, fetcher)
    const item = r.results.find((x) => x.taskCode === code)
    expect(item).toBeDefined()
    expect(item?.clientOnly).toBe(true)
    expect(item?.message ?? '').toContain('status')
    // 关键断言：全程不得出现真实对话（/v2/chat/completions）。
    expect(calls.filter((c) => c.url.includes('/v2/chat/completions'))).toEqual([])
  })
})

/** 养虾等级族任务列表：`status: available`、无 progress、accept_status 缺省。 */
function levelTaskList(code: string): unknown {
  return {
    code: 0,
    data: {
      tasks: [
        { code, status: 'available' },
      ],
    },
  }
}

/**
 * ⚠️ `X-Conversation-*` 三头在**两条旁路**上也必须齐全（2026-10-16）。
 *
 * ## 为什么这两条路径原先**零守卫**
 * 主链路（`buddy-adapter.ts` 的 `send()`）2026-10-16 补了三头，但本文件另有两条
 * 直打**同一个** `/v2/chat/completions` 的旁路，它们长期与之不一致：
 * - `chatRealSession`（`skill_1` / `Expert_lighthouse` 的真实会话环节，经
 *   「一键领取积分」触发）：原先**只带一枚** `X-Conversation-ID`；
 * - `keepStreakActive`（保连胜）：原先**一枚不带**（走 `growthHeaders`）。
 * ⚠️ 两条都**零守卫** —— 任何形态漂移都不会让测试变红。
 *
 * ## 这组用例锁的是「形态一致」，**不是**「三头必需」
 * 🔴 「三头缺一即 400/11128」这条外部事实**已被真机复测推翻**（逐枚消融 14 枚头
 * 全部仍 200）。保留三头的理由是**三条出站路径形态统一**，理由变了、行为没变。
 * 若将来有人认为不必统一，**删实现即可，但请连本组用例一起删**，别留半套。
 */
describe('/v2/chat/completions 旁路的 X-Conversation-* 三头', () => {
  const CONV = ['x-conversation-id', 'x-conversation-request-id', 'x-conversation-message-id']

  /** 从 recordingFetcher 的调用里挑出打 chat 端点那次的请求头。 */
  function chatHeaders(calls: { url: string; init?: RequestInit }[]): Headers {
    // ⚠️ 用 `endsWith` 而**不是** `includes`：`includes` 会让
    // `/v2/chat/completions/probe` 这类**别的** URL 也落进同一分支 ⇒
    // 取到错误的请求头而**假绿**（第二轮对抗审计实测构造出了这个假绿）。
    const hits = calls.filter((c) => c.url.endsWith('/v2/chat/completions'))
    expect(hits.length, '本轮应恰好打一次 /v2/chat/completions').toBe(1)
    return new Headers(hits[0]!.init?.headers as HeadersInit)
  }

  /** 判三枚头齐全、同值、且形态为 32 位无横线十六进制。 */
  function expectThreeConvHeaders(h: Headers, where: string): void {
    const id = h.get('X-Conversation-ID')
    expect(id, `${where}: X-Conversation-ID 缺失`).toMatch(/^[0-9a-f]{32}$/)
    expect(h.get('X-Conversation-Request-ID'), `${where}: Request-ID 缺失或不同值`).toBe(id)
    expect(h.get('X-Conversation-Message-ID'), `${where}: Message-ID 缺失或不同值`).toBe(id)
    expect(CONV.every((n) => h.get(n))).toBe(true)
  }

  it('chatRealSession：真实会话请求带齐三头', async () => {
    vi.useFakeTimers()
    try {
      const calls: { url: string; init?: RequestInit }[] = []
      const fetcher = (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        const u = String(url)
        // ⚠️ **必须按 URL 分派**，不能沿用 `recordingFetcher` 的「按调用序轮换」：
        // 任务列表走**两个**端点（`/v2/activity/growth/tasks` +
        // `/activity/growth/tasks`），chat 请求排在它们之后 —— 按序轮换会把
        // 任务列表报文喂给 chat（或反过来），于是摸不到 chat 请求。
        // 这是本轮实测踩到的真坑。⚠️ 刻意**不写死序号**：调用序列会随实现演进，
        // 而写死的序号正是本文件早期版本里一处失实的来源（曾写「第 5 位」，
        // 实测是第 3 位）。此处只陈述**相对顺序**这个不变量。
        const body = u.includes('/v2/chat/completions')
          ? 'data: {"id":"cmb-0123456789abcdef0123456789abcdef","choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n'
          : u.includes('/accept')
            ? { code: 0 }
            : { code: 0, data: { tasks: [{ task_code: 'skill_1', accept_status: 'in_progress', progress: { current: 0, target: 1 } }] } }
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        } as unknown as Response
      }) as unknown as typeof fetch

      const work = runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 600_000 })
      for (let i = 0; i < 2_000; i += 1) await vi.advanceTimersByTimeAsync(100)
      await work
      expectThreeConvHeaders(chatHeaders(calls), 'chatRealSession')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keepStreakActive：保连胜请求带齐三头', async () => {
    const { fetcher, calls } = recordingFetcher([{ body: {} }])
    await keepStreakActive(CRED, PRODUCT, fetcher)
    expectThreeConvHeaders(chatHeaders(calls), 'keepStreakActive')
  })

  /**
   * 🔴 回归：补三头**不得**弄丢 `growthHeaders` 原有的头。
   *
   * ## 这个用例为什么存在（第二轮审计实测的假绿）
   * 本 PR 的初版把 `keepStreakActive` 的头写成
   * `{ ...growthHeaders(...), ...conversationHeaders(...) }` —— 而
   * `growthHeaders` 返回的是 **`Headers` 实例**，JS 的 `Headers`
   * **没有自有可枚举属性**，`{...headers}` **恒为 `{}`**：
   * ```
   * new Headers([['a','1'],['b','2']]) 展开 → {}
   * ```
   * ⇒ 实际出站的请求头只剩三枚 `X-Conversation-*`，`Authorization` /
   * `X-Domain` / `X-Product` / `X-Product-Code` / `X-User-Id` / `User-Agent`
   * 等**全部消失**，请求必然 401。
   *
   * ⚠️ 而当时的两条守卫**只断言三枚 Conv 头齐全** ⇒ 对「其余头还在不在」
   * **零判据** ⇒ 全体**假绿**。本仓库明令禁止的「只断言新加的那几行」盲区。
   *
   * ## 判据
   * 逐项断言 `growthHeaders` 原本会设的那些键**一个都不少**，且
   * `Authorization` 的值真的是 `Bearer <token>`。
   */
  it('🔴 keepStreakActive：补三头后原有头一个都不能丢（Headers 展开假绿回归）', async () => {
    const { fetcher, calls } = recordingFetcher([{ body: {} }])
    await keepStreakActive(CRED, PRODUCT, fetcher)
    const h = chatHeaders(calls)
    // 鉴权头（丢掉就必然 401）。
    expect(h.get('Authorization')).toBe(`Bearer ${CRED.access_token}`)
    expect(h.get('User-Agent')).toBeTruthy()
    expect(h.get('Content-Type')).toBe('application/json')
    // 身份 / 归因头族。
    expect(h.get('X-Client-Platform')).toBe('web')
    expect(h.get('X-Domain')).toBe(PRODUCT.apiDomain)
    expect(h.get('X-Product-Code')).toBeTruthy()
    expect(h.get('X-Product')).toBeTruthy()
    expect(h.get('X-User-Id')).toBe(CRED.user_id)
    // ⚠️ 头总数下界：三枚 Conv + 上面这 8 枚 = 11。
    //    写成「计数」而非逐项，是因为 `Headers.keys()` 的顺序不保证。
    expect([...h.keys()].length).toBeGreaterThanOrEqual(11)
  })

  it('两条旁路各自生成独立的 id（不复用同一个值）', async () => {
    const a = recordingFetcher([{ body: {} }])
    await keepStreakActive(CRED, PRODUCT, a.fetcher)
    const b = recordingFetcher([{ body: {} }])
    await keepStreakActive(CRED, PRODUCT, b.fetcher)
    const idA = chatHeaders(a.calls).get('X-Conversation-ID')
    const idB = chatHeaders(b.calls).get('X-Conversation-ID')
    expect(idA).not.toBe(idB)
  })
})


describe('平台指纹的自洽性', () => {
  // 该用例必须用 fake timers：真实时钟下每个任务要付 4000ms 的结算等待，
  // 两个任务即 8s，超出 5s 单测上限。
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // 平台三元组（os / arch / osVersion）必须描述**同一台机器**。此前非 darwin 一律
  // 写 Windows 版本号，于是 Linux 宿主上报 os=linux 配 10.0.26220，自相矛盾；
  // 且 arch 写死 x64，在 arm64 宿主上撒谎。桌面域与 web 域还各写一份，于是同一
  // 会话在两个域报出不同的 OS。
  it('两个上报域的 os/arch/osVersion 各自自洽且互相一致', async () => {
    const desktop: Record<string, unknown>[] = []
    const web: Record<string, unknown>[] = []
    // create_canvas 走桌面域 /v2/report；Library_read 走 web 域 /v2/report。
    const taskList = {
      code: 0,
      data: {
        tasks: [
          { task_code: 'create_canvas', accept_status: 'not_accepted', progress: { current: 0, target: 1 } },
          { task_code: 'Library_read', accept_status: 'not_accepted', progress: { current: 0, target: 1 } },
        ],
      },
    }
    const fetcher = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      const body = typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>[])
        : []
      if (u.endsWith('/v2/report') && body.length > 0) {
        // web 域的 body 带 pageURL，桌面域的带 ideName。
        if (body[0]?.['pageURL'] !== undefined) web.push(body[0])
        else desktop.push(body[0])
      }
      return {
        ok: true,
        status: 200,
        json: async () => taskList,
        text: async () => JSON.stringify(taskList),
      } as unknown as Response
    }) as unknown as typeof fetch
    // 预算取缺省（10 分钟）而不是极小值：本用例要的是**两个域都发出上报**，
    // 预算过小会让 deadline 在首次上报前就触发。睡眠由 fake timer 消掉。
    const work = runGrowthTaskCompletions(CRED, PRODUCT, fetcher)
    // 先推进一个 tick 让函数真正进入异步流程，再放跑全部定时器。
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    await work
    expect(desktop.length).toBeGreaterThan(0)
    expect(web.length).toBeGreaterThan(0)
    for (const sample of [...desktop, ...web]) {
      const os = String(sample['os'])
      const osVersion = String(sample['osVersion'])
      expect(os.length).toBeGreaterThan(0)
      expect(osVersion.length).toBeGreaterThan(0)
      // os 与 osVersion 必须同平台：Linux 不得配 Windows 版本号，反之亦然。
      if (os === 'linux' || os === 'Linux x86_64') {
        expect(osVersion).not.toMatch(/^10\./)
      }
      if (os === 'win32' || os === 'Win32') {
        expect(osVersion).toMatch(/^10\./)
      }
      // arch 不得写死：必须等于宿主真实架构。
      expect(sample['arch']).toBe(process.arch)
    }
    // 同一会话在两个域必须报告同一台机器：arch 与 osVersion 相同，os 仅命名不同。
    expect(String(web[0]?.['arch'])).toBe(String(desktop[0]?.['arch']))
    expect(String(web[0]?.['osVersion'])).toBe(String(desktop[0]?.['osVersion']))
  })
})

describe('整轮时间预算（账号很多时的上界）', () => {
  // 逐账号预算是**每账号**上限，N 个账号线性累加；宿主 RPC 超时上界由 dsh 决定、
  // 本插件不可见。故另加整轮预算，让「账号很多」时如实停住并报出未跑的账号。
  //
  // 该分支必须在**第一个账号执行之前**就已耗尽，故用过去时刻构造 deadline ——
  // 这正是「上一账号吃掉了全部预算」的真实情形。
  it('整轮预算耗尽后该账号不发任何成长请求，且不算失败', async () => {
    const calls: string[] = []
    const fetcher = (async (url: string) => {
      calls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { tasks: [] } }),
        text: async () => JSON.stringify({ code: 0, data: { tasks: [] } }),
      } as unknown as Response
    }) as unknown as typeof fetch
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10_000)
    try {
      const outcome = await collectBuddyGrowth(
        CRED,
        PRODUCT,
        { id: 'acct-1', nickname: '白号', credentialRef: 'buddy:ref' } as never,
        undefined,
        now,
      )
      expect(outcome.ok).toBe(true)
      expect(outcome.failed).toBe(0)
      expect(outcome.timedOut).toBe(true)
      expect(outcome.error).toContain('时间预算')
      // 关键断言：一个上游请求都不该发。
      expect(calls).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })
})

/**
 * 扫尾补领的覆盖面（本组是复审补的 —— 原实现有两处**静默漏领**）。
 *
 * 「扫尾」要补领的是**已达标未领取**的奖励，而这类任务按定义不在 `actionable`
 * 里（它们已是 `completed`，不进 `not_accepted`/`in_progress` 的 pending）。
 * 故它与「逐项完成」是两条**独立**路径，后者为空不能短路前者。
 */
describe('扫尾补领的覆盖面', () => {
  /** 所有请求都返回同一份任务列表；记录 URL 以便断言 claim 是否发出。 */
  function constantFetcher(list: unknown) {
    const calls: string[] = []
    const fetcher = (async (url: string) => {
      calls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => list,
        text: async () => JSON.stringify(list),
      } as unknown as Response
    }) as unknown as typeof fetch
    return { fetcher, calls }
  }

  it('只有「已达标未领」的任务时仍执行扫尾补领', async () => {
    // accept_status: 'completed' 不进 pending ⇒ actionable 为空。
    // 原实现在此直接 return「无 API 可达的待完成任务」，扫尾永不执行，
    // 账号里所有已达标未领的奖励一个都领不到。
    const { fetcher, calls } = constantFetcher({
      code: 0,
      data: {
        tasks: [
          { task_code: 'chat_5', accept_status: 'completed', progress: { current: 5, target: 5 } },
        ],
      },
    })
    const r = await runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 600_000 })
    expect(calls.filter((c) => c.includes('/claim')).length).toBe(1)
    expect(r.claimedCount).toBe(1)
  })

  it('扫尾覆盖「等级族」（码字段是 code 而非 task_code）', async () => {
    // 等级族的条目用 `code` 字段。原扫尾只读 `task_code`，于是等级族全部被
    // filter 丢掉 —— 与 fetchGrowthTaskCodes 的双字段读取分叉，且静默无报错。
    const { fetcher, calls } = constantFetcher({
      code: 0,
      data: { tasks: [{ code: 'first_chat', status: 'completed' }] },
    })
    const r = await runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 600_000 })
    expect(calls.filter((c) => c.includes('/claim')).length).toBe(1)
    expect(r.claimedCount).toBe(1)
  })

  it('扫尾合并两族端点，命中第一族后不丢弃第二族', async () => {
    // 按 URL 分派而非按请求序轮换：轮换会被前序请求（列表查询 / accept / report）
    // 消耗掉，测不到想要的形状。
    // 成长族端点返回 chat_5；等级族端点返回 first_chat。两者都必须被扫尾领到。
    const growthList = {
      code: 0,
      data: { tasks: [{ task_code: 'chat_5', accept_status: 'completed' }] },
    }
    const levelList = {
      code: 0,
      data: { tasks: [{ code: 'first_chat', status: 'completed' }] },
    }
    const claimUrls: string[] = []
    const fetcher = (async (url: string) => {
      const u = String(url)
      if (u.includes('/claim')) {
        claimUrls.push(u)
        return {
          ok: true, status: 200,
          json: async () => ({ code: 0, data: { credit: 0 } }),
          text: async () => JSON.stringify({ code: 0, data: { credit: 0 } }),
        } as unknown as Response
      }
      // 等级族端点是**无 /v2 前缀**的那个。⚠️ 判据必须锚定 `/v2/`，
      // 否则 `/v2/activity/growth/tasks` 也以 `/activity/growth/tasks` 结尾，
      // 会被误判成等级族（写这条用例时真踩了）。
      const isGrowthTier = /\/v2\/activity\/growth\/tasks$/.test(u)
      const list = isGrowthTier ? growthList : levelList
      return {
        ok: true, status: 200,
        json: async () => list,
        text: async () => JSON.stringify(list),
      } as unknown as Response
    }) as unknown as typeof fetch
    const r = await runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 600_000 })
    // 两个不同任务码各领一次 —— 只命中第一族的话这里只会是 1。
    const claimedCodes = claimUrls.map((u) => decodeURIComponent(u.split('/tasks/')[1]?.split('/')[0] ?? ''))
    expect(claimedCodes).toContain('chat_5')
    expect(claimedCodes).toContain('first_chat')
    expect(r.claimedCount).toBe(2)
  })
})

/**
 * 写端点的成功判据必须是**显式 `code === 0`**。
 *
 * 反例是 `code !== undefined && code !== 0`：那样「响应里没有 code」被当成成功，
 * 于是网关错误体（非 0 但无 code 的形状）会被谎报成「已领取奖励（+0 积分）」并
 * 计入 `claimedCount` —— 用户看到「自动领取 N 项」，实际一分没到账。
 * 本文件 `classifyGrowthWrite`（写端点权威分类器）缺 code 时归 -1 → failed，
 * claim 曾与它判据相反。
 */
describe('claim 的成功判据', () => {
  function claimFetcher(body: unknown) {
    return (async () => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch
  }

  it('响应缺少 code 字段时不得谎报为已领取', async () => {
    const r = await claimGrowthTaskReward(CRED, PRODUCT, claimFetcher({ msg: 'Unauthorized' }), 'chat_5')
    expect(r.ok).toBe(false)
    expect(r.claimed).toBe(false)
    // 有 msg 时优先回显 msg（便于排障）；关键是**不得**判成 claimed:true。
    expect(r.message).toContain('Unauthorized')
  })

  it('既无 code 又无 msg 时如实报「缺少 code 字段」', async () => {
    const r = await claimGrowthTaskReward(CRED, PRODUCT, claimFetcher({ data: {} }), 'chat_5')
    expect(r.ok).toBe(false)
    expect(r.claimed).toBe(false)
    expect(r.message).toContain('缺少 code')
  })

  it('空对象响应不得谎报为已领取', async () => {
    const r = await claimGrowthTaskReward(CRED, PRODUCT, claimFetcher({}), 'chat_5')
    expect(r.claimed).toBe(false)
    expect(r.ok).toBe(false)
  })

  it('code:0 + already_claimed 仍判幂等成功（不回归）', async () => {
    const r = await claimGrowthTaskReward(
      CRED, PRODUCT, claimFetcher({ code: 0, data: { already_claimed: true } }), 'chat_5',
    )
    expect(r.ok).toBe(true)
    expect(r.claimed).toBe(false)
  })

  it('code:0 + credit 正常计为已领取（不回归）', async () => {
    const r = await claimGrowthTaskReward(
      CRED, PRODUCT, claimFetcher({ code: 0, data: { credit: 100 } }), 'chat_5',
    )
    expect(r.ok).toBe(true)
    expect(r.claimed).toBe(true)
    expect(r.credit).toBe(100)
  })
})

/**
 * `code 400` 必须**同时看 msg**（复审补）。
 *
 * 成长端点用同一个 `code 400` 表达多种语义：既表示「没有可领对象」（正常幂等
 * 终态），也表示 `task not completed`（任务真没做完）等**真失败**。
 * 原实现 `if (code === 400) return no-object` 把两者一并归成「已领奖」——
 * 与函数头注释「code 400 + msg 命中无对象文案」直接矛盾，用户会看到
 * 「已领到积分」而实际一分没有。
 */
describe('写入端点 code 400 的 msg 分流', () => {
  /** 任务列表给一个 in_progress 任务（使循环跑到旅行领奖那步）。 */
  const LIST = {
    code: 0,
    data: { tasks: [{ task_code: 'chat_5', accept_status: 'in_progress', progress: { current: 0, target: 1 } }] },
  }
  function claimAllFetcher(travel: unknown) {
    return (async (url: string) => {
      const u = String(url)
      const body = u.includes('/travel/claim') ? travel : u.includes('/accept') ? { code: 0, data: {} } : LIST
      return {
        ok: true, status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response
    }) as unknown as typeof fetch
  }

  it.each([
    ['no unclaimed travel', 'already-claimed'],
    ['insufficient energy', 'already-claimed'],
    ['please accept buddy adoption agreement first', 'already-claimed'],
  ])('无对象文案 %s 归 already-claimed', async (msg, expectedKind) => {
    const r = await claimAllGrowth(CRED, PRODUCT, claimAllFetcher({ code: 400, msg }), {})
    expect(r.kind).toBe(expectedKind)
  })

  it('code 400 + task not completed 必须判失败，不得谎报已领奖', async () => {
    const r = await claimAllGrowth(
      CRED, PRODUCT, claimAllFetcher({ code: 400, msg: 'task not completed' }), {},
    )
    expect(r.kind).toBe('failed')
    expect(r.message ?? '').toContain('task not completed')
  })

  it('code 400 + 未知文案保守判失败（宁可漏判不可误伤）', async () => {
    // 白名单外的文案一律算失败：少了词条只会让正常终态显示成失败（无害），
    // 多了词条会把真失败谎报成成功（有害）。
    const r = await claimAllGrowth(
      CRED, PRODUCT, claimAllFetcher({ code: 400, msg: 'brand new server message' }), {},
    )
    expect(r.kind).toBe('failed')
  })
})

/**
 * 列表查询阶段的失败原因必须**带进 `results`**（复审补）。
 *
 * 下游 `collectBuddyGrowth`（`src/buddy-growth.ts`）判僵尸账号的依据是**逐项**
 * `results.some(r => /凭据已失效/.test(r.message))`。原实现在列表查询失败时
 * 返回空 `results`，凭据失效就判不出来 ⇒ 前端把「请重新登录」显示成
 * 「本轮无 API 可达的任务」。
 */
describe('列表查询失败的原因传递', () => {
  it('401 时 results 必须带「凭据已失效」以便下游识别僵尸账号', async () => {
    const fetcher = (async () => ({
      ok: false, status: 401,
      json: async () => ({}),
      text: async () => '<html>unauthorized</html>',
    })) as unknown as typeof fetch
    const r = await runGrowthTaskCompletions(CRED, PRODUCT, fetcher)
    expect(r.ok).toBe(false)
    expect(r.results.length).toBeGreaterThan(0)
    expect(r.results.some((x) => x.message.includes('凭据已失效'))).toBe(true)
  })

  it('解析失败时 results 也要有可读原因（不得只剩空数组）', async () => {
    const fetcher = (async () => ({
      ok: true, status: 200,
      json: async () => ({}),
      text: async () => 'not json at all',
    })) as unknown as typeof fetch
    const r = await runGrowthTaskCompletions(CRED, PRODUCT, fetcher)
    expect(r.ok).toBe(false)
    expect(r.results.length).toBeGreaterThan(0)
  })
})

/**
 * 凭据缺 `user_id` 必须**显式留痕**（复审补）。
 *
 * 判据事件里的 `userId` / `machineId` 全由 `credential.user_id` 派生：
 * uid 为空时会静默上报 `userId: ''`、`machineId = sha256('machine:')` ——
 * 按用户维度计数的判据必然不计数，但不报错，表现为「跑完一圈 0 项完成」。
 */
describe('凭据缺 user_id 的显式提示', () => {
  function emptyListFetcher() {
    const list = { code: 0, data: { tasks: [] } }
    return (async () => ({
      ok: true, status: 200,
      json: async () => list,
      text: async () => JSON.stringify(list),
    })) as unknown as typeof fetch
  }

  it('缺 user_id 时 message 必须提示重新登录（不能静默）', async () => {
    const noUid: BuddyCredential = { access_token: 't', refresh_token: 'r' }
    const r = await runGrowthTaskCompletions(noUid, PRODUCT, emptyListFetcher())
    expect(r.message ?? '').toContain('user_id')
  })

  it('有 user_id 时不得出现该提示（防误报）', async () => {
    const r = await runGrowthTaskCompletions(CRED, PRODUCT, emptyListFetcher())
    expect(r.message ?? '').not.toContain('user_id')
  })
})

/**
 * web 域的 `os` 必须与 `arch` 自洽（复审补）。
 *
 * 原先 linux 恒写 `'Linux x86_64'`，arm64 宿主会报
 * `os: 'Linux x86_64'` 配 `arch: 'arm64'` —— 同一对象里自相矛盾，
 * 与「非 darwin 一律写 Windows 版本号」是同一类缺陷。
 */
describe('web 域 os 名与 arch 自洽', () => {
  it('linux + arm64 时 os 名必须含 aarch64 而非固定 x86_64', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const arch = vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
    try {
      const web: Record<string, unknown>[] = []
      const list = {
        code: 0,
        data: {
          tasks: [
            { task_code: 'Library_read', accept_status: 'not_accepted', progress: { current: 0, target: 1 } },
          ],
        },
      }
      const fetcher = (async (url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>[])
          : []
        // web 域的 body 带 pageURL。
        if (String(url).endsWith('/v2/report') && body[0]?.['pageURL'] !== undefined) {
          web.push(body[0])
        }
        return {
          ok: true, status: 200,
          json: async () => list, text: async () => JSON.stringify(list),
        } as unknown as Response
      }) as unknown as typeof fetch
      vi.useFakeTimers()
      const work = runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 600_000 })
      await vi.advanceTimersByTimeAsync(1)
      await vi.runAllTimersAsync()
      await work
      vi.useRealTimers()
      expect(web.length).toBeGreaterThan(0)
      expect(String(web[0]?.['os'])).toContain('aarch64')
      expect(String(web[0]?.['arch'])).toBe('arm64')
    } finally {
      platform.mockRestore()
      arch.mockRestore()
      vi.useRealTimers()
    }
  })
})

/**
 * 缺 `claimBase` / `webBase` 配置时必须**报可读错误**，不能拼出 `undefined/...`（复审补）。
 *
 * ⚠️ 这条来自 contributor 在对 !62 的复审里提的警告：原实现写
 * `String(product.claimBase)`，而 `String(undefined)` 得到的是**字符串 `"undefined"`**
 * 而非抛错 ⇒ URL 拼成 `undefined/activity/growth/tasks/<code>/claim`，
 * 请求真的发出去，失败现象看起来像服务端问题，真因（本插件缺配置）毫无线索。
 * 这类「不崩但静默错」比崩溃更难查。
 */
describe('web 域基址缺配置时的健壮性', () => {
  const NO_BASE = {
    endpoint: 'https://copilot.tencent.com',
    apiDomain: 'copilot.tencent.com',
    userAgent: 'X',
  } as unknown as BuddyProduct

  it('缺 claimBase 时返回可读错误，且不得发出指向 undefined 的请求', async () => {
    const urls: string[] = []
    const fetcher = (async (url: string) => {
      urls.push(String(url))
      return {
        ok: true, status: 200,
        json: async () => ({ code: 0, data: { credit: 1 } }),
        text: async () => JSON.stringify({ code: 0, data: { credit: 1 } }),
      } as unknown as Response
    }) as unknown as typeof fetch
    const r = await claimGrowthTaskReward(CRED, NO_BASE, fetcher, 'chat_5')
    expect(r.ok).toBe(false)
    expect(r.claimed).toBe(false)
    expect(r.message).toContain('claimBase')
    // 关键断言：一个请求都不该发出去（否则就是「能发但指向 undefined」）。
    expect(urls).toEqual([])
  })

  it('webBase 缺失时回退 claimBase；两者都缺则报错且不发请求', async () => {
    const urls: string[] = []
    const fetcher = (async (url: string) => {
      urls.push(String(url))
      const list = { code: 0, data: { tasks: [] } }
      return {
        ok: true, status: 200,
        json: async () => list, text: async () => JSON.stringify(list),
      } as unknown as Response
    }) as unknown as typeof fetch
    // 二者都缺 ⇒ Library_read 上报必须报错而非拼出 undefined。
    vi.useFakeTimers()
    const list = {
      code: 0,
      data: {
        tasks: [
          { task_code: 'Library_read', accept_status: 'not_accepted', progress: { current: 0, target: 1 } },
        ],
      },
    }
    const f2 = (async (url: string) => {
      urls.push(String(url))
      return {
        ok: true, status: 200,
        json: async () => list, text: async () => JSON.stringify(list),
      } as unknown as Response
    }) as unknown as typeof fetch
    const work = runGrowthTaskCompletions(CRED, NO_BASE, f2, { budgetMs: 600_000 })
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    const r = await work
    vi.useRealTimers()
    // 不得出现指向 undefined 的 URL。
    expect(urls.some((u) => u.includes('undefined'))).toBe(false)
    // 该项应被标记为未完成/需客户端，而不是假装成功。
    const item = r.results.find((x) => x.taskCode === 'Library_read')
    expect(item?.ok ?? false).toBe(false)
  })
})

/**
 * `claimBase` 与 `webBase` 是**两个独立字段**，且各自必须真的被用上。
 *
 * ⚠️ 本组补的是一个真实测试缺口：原有用例只覆盖「`webBase` 缺失时回退
 * `claimBase`」，**没有任何一条能证明 `webBase` 配了值时真被读取** ——
 * 把 `webBaseOf` 改成恒用 `claimBase`（即该字段**死配置复发**）时，
 * 原有 41 条用例**全绿**，无一条报警。这与「判据看似覆盖、实则同义反复」
 * 是同一类问题，故用**两站不同域**的桩把它锁死。
 */
describe('claimBase 与 webBase 各自生效（防止死配置复发）', () => {
  /** 刻意让两站不同域：只要有一处读错字段，URL 就会露馅。 */
  const TWO_SITES = {
    endpoint: 'https://copilot.tencent.com',
    apiDomain: 'copilot.tencent.com',
    claimBase: 'https://claim.example.cn',
    webBase: 'https://web.example.cn',
    userAgent: 'X',
  } as unknown as BuddyProduct

  it('领奖走 claimBase（不是 webBase、也不是 endpoint）', async () => {
    const urls: string[] = []
    const fetcher = (async (url: string) => {
      urls.push(String(url))
      return {
        ok: true, status: 200,
        json: async () => ({ code: 0, data: { credit: 1 } }),
        text: async () => JSON.stringify({ code: 0, data: { credit: 1 } }),
      } as unknown as Response
    }) as unknown as typeof fetch
    await claimGrowthTaskReward(CRED, TWO_SITES, fetcher, 'chat_5')
    const claim = urls.find((u) => u.includes('/claim'))
    expect(claim).toBeDefined()
    expect(claim).toContain('claim.example.cn')
    expect(claim).not.toContain('web.example.cn')
    expect(claim).not.toContain('copilot.tencent.com')
  })

  it('web 遥测走 webBase（不是 claimBase）—— 两站不同域时必须打对站', async () => {
    const urls: string[] = []
    const list = {
      code: 0,
      data: {
        tasks: [
          { task_code: 'Library_read', accept_status: 'not_accepted', progress: { current: 0, target: 1 } },
        ],
      },
    }
    const fetcher = (async (url: string) => {
      urls.push(String(url))
      return {
        ok: true, status: 200,
        json: async () => list, text: async () => JSON.stringify(list),
      } as unknown as Response
    }) as unknown as typeof fetch
    vi.useFakeTimers()
    const work = runGrowthTaskCompletions(CRED, TWO_SITES, fetcher, { budgetMs: 600_000 })
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    await work
    vi.useRealTimers()
    // Library_read 的 web 上报必须打 webBase 那个域（该函数是本字段的唯一读取点）。
    const webReports = urls.filter(
      (u) => u.includes('/v2/report') && u.includes('web.example.cn'),
    )
    expect(webReports.length).toBeGreaterThan(0)
    // 且不得误打到领奖站。
    expect(urls.some((u) => u.includes('claim.example.cn') && u.includes('/v2/report'))).toBe(false)
  })

  it('webBase 为空串时回退 claimBase（不改既有行为）', async () => {
    const emptyWeb = {
      endpoint: 'https://copilot.tencent.com',
      apiDomain: 'copilot.tencent.com',
      claimBase: 'https://claim.example.cn',
      webBase: '',
      userAgent: 'X',
    } as unknown as BuddyProduct
    const urls: string[] = []
    const list = {
      code: 0,
      data: {
        tasks: [
          { task_code: 'Library_read', accept_status: 'not_accepted', progress: { current: 0, target: 1 } },
        ],
      },
    }
    const fetcher = (async (url: string) => {
      urls.push(String(url))
      return {
        ok: true, status: 200,
        json: async () => list, text: async () => JSON.stringify(list),
      } as unknown as Response
    }) as unknown as typeof fetch
    vi.useFakeTimers()
    const work = runGrowthTaskCompletions(CRED, emptyWeb, fetcher, { budgetMs: 600_000 })
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    await work
    vi.useRealTimers()
    expect(
      urls.some((u) => u.includes('/v2/report') && u.includes('claim.example.cn')),
    ).toBe(true)
  })
})

// ══════════════ 2026-11-01 增补：体验专家族 / 小程序族 / 连登链 ══════════════
//
// 判据来源：workbuddy2api 面板 2026-09~10 实测（autotask.go / mp_events.go /
// streak.go / scheduler/streak.go）。这里锁的仍是**服务端判据**，改动断言前先跑
// 真实账号确认。

import {
  claimStreakExtras,
  FIXED_EXPERT_TASKS,
  isMpTaskCode,
  MP_CHAT_EVENT_GAP_MS,
  MP_CHAT_JITTER_MAX_MS,
} from '../../src/buddy-growth.js'

/** 构造单条任务项（成长族形状）。 */
function growthTask(taskCode: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { task_code: taskCode, accept_status: 'not_accepted', progress: { current: 0, target: 1 }, ...extra }
}

/** SSE 响应体（chatRealSession 从 text 里抓 32 位 hex 的服务端 requestId）。 */
const SSE_ID = '0123456789abcdef0123456789abcdef'
const SSE_TEXT = `data: {"id":"${SSE_ID}","object":"chat.completion.chunk"}\n\n`
/** 一次被记录的请求。 */
interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/**
 * 路由式 fetcher：按「URL 精确匹配（或 `*` 前缀）+ 方法」分发响应，记录全部调用。
 * `body` 可传函数（入参为本次调用，可读请求头/请求体，读用例内可变状态），
 * 供「accept 后列表翻转」「web/mp 同 URL 按头分发」之类的有状态用例。
 */
function routingFetcher(
  routes: {
    /** URL 精确匹配；以 `*` 结尾则按前缀匹配。 */
    match: string
    method?: string
    status?: number
    body?: unknown | ((call: RecordedCall) => unknown)
    text?: string
  }[],
): { fetcher: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    const rawHeaders = (init?.headers ?? {}) as unknown
    const headers: Record<string, string> = {}
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
    } else if (typeof rawHeaders === 'object' && rawHeaders !== null) {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
        headers[k.toLowerCase()] = String(v)
      }
    }
    const method = String(init?.method ?? 'GET')
    const call: RecordedCall = {
      url: String(url), method, headers,
      body: typeof init?.body === 'string' ? init.body : '',
    }
    calls.push(call)
    const route = routes.find((r) => {
      const hit = r.match.endsWith('*')
        ? String(url).startsWith(r.match.slice(0, -1))
        : String(url) === r.match
      return hit && (r.method === undefined || r.method === method)
    })
    const spec = route ?? {}
    const resolvedBody = typeof spec.body === 'function' ? (spec.body as (c: RecordedCall) => unknown)(call) : spec.body
    return {
      ok: (spec.status ?? 200) >= 200 && (spec.status ?? 200) < 300,
      status: spec.status ?? 200,
      json: async () => resolvedBody ?? {},
      text: async () => (spec.text !== undefined ? spec.text : JSON.stringify(resolvedBody ?? {})),
      // keepStreakActive 走 response.body.getReader() 读 SSE 流；立即 done 即「流已收」。
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

const EP = 'https://copilot.tencent.com'
const WB = 'https://www.workbuddy.cn'
/** web 口径的空任务列表（成长族两路 + 等级族共用）。 */
const EMPTY_TASKS = { code: 0, data: { tasks: [] } }
/** 推动真实时钟的 fake-timer 驱动器（与上文 runWithClock 同型，上限提到 600s）。 */
async function driveWithClock<T>(work: Promise<T>): Promise<T> {
  let done = false
  const settled = work.then(
    (v) => {
      done = true
      return v
    },
    (e) => {
      done = true
      throw e
    },
  )
  for (let i = 0; i < 6_000 && !done; i += 1) {
    await vi.advanceTimersByTimeAsync(100)
  }
  return settled
}

describe('体验专家族（WorkBuddy_Valorant / expert_use_*）', () => {
  it('FIXED_EXPERT_TASKS 的专家 id 与昵称/职业名不可互换（判据双字段校验）', () => {
    // 昵称（name）与职业名（title）都参与服务端校验，来自任务 jump_url 的权威口径。
    expect(FIXED_EXPERT_TASKS['WorkBuddy_Valorant']).toMatchObject({
      expertId: 'ex_xQHHD1u5Jkua', name: '无畏契约拼豆专家',
    })
    expect(FIXED_EXPERT_TASKS['expert_use_maidehao']).toMatchObject({
      expertId: 'ex_GDl31WahyIH0', name: '卖得好', title: '中国电商运营专家',
    })
    expect(FIXED_EXPERT_TASKS['expert_use_douyinyin']).toMatchObject({
      expertId: 'ex_FbY5nlWTqDod', name: '斗音音', title: '抖音策略师',
    })
    expect(FIXED_EXPERT_TASKS['expert_use_shangjia_xuanchuan']).toMatchObject({
      expertId: 'ex_Weo3x2EZuSDm', name: '商家宣传设计师', title: '商家宣传页与海报设计师',
    })
    expect(FIXED_EXPERT_TASKS['expert_use_bowangwang']).toMatchObject({
      expertId: 'ex_WZY136wV5aMt', name: '播旺旺', title: '直播电商教练',
    })
    // 白名单必须包含全部固定专家任务（否则完成动作不会进 actionable）。
    for (const code of Object.keys(FIXED_EXPERT_TASKS)) {
      expect(AUTOMATABLE_TASK_CODES.has(code)).toBe(true)
      expect(GROWTH_TASK_COMPLETION[code]).toBeDefined()
    }
  })

  it('WorkBuddy_Valorant：真实会话带 X-Expert-Id，召唤链 + LOCAL actual_use（type 空、cost 0），达标即领奖', async () => {
    vi.useFakeTimers()
    // 有状态：使用链上报（第二次 /v2/report）后 progress 翻为达标（1/1）。
    const reportedUse = { done: false }
    const taskList = () => ({
      code: 0,
      data: {
        tasks: [growthTask('WorkBuddy_Valorant', {
          progress: { current: reportedUse.done ? 1 : 0, target: 1 },
        })],
      },
    })
    const { fetcher, calls } = routingFetcher([
      { match: `${EP}/v2/activity/growth/tasks`, method: 'GET', body: taskList },
      { match: `${EP}/activity/growth/tasks`, method: 'GET', body: EMPTY_TASKS },
      { match: `${EP}/activity/growth/tasks/accept`, method: 'POST', body: { code: 0, data: {} } },
      {
        match: `${EP}/portal/operation-platform/market/expert/list`, method: 'POST',
        body: {
          code: 0,
          data: {
            experts: [{
              expert_id: 'ex_xQHHD1u5Jkua', expert_type: 'agent',
              display_name_zh: '无畏契约拼豆专家', profession_zh: '无畏契约拼豆专家', version: '1.2.1',
            }],
          },
        },
      },
      { match: `${EP}/v2/chat/completions`, method: 'POST', text: SSE_TEXT },
      {
        match: `${EP}/v2/report`, method: 'POST',
        body: () => {
          reportedUse.done = true
          return { code: 0, data: {} }
        },
      },
      { match: `${WB}/v2/activity/growth/tasks`, method: 'GET', body: EMPTY_TASKS },
      {
        match: `${WB}/activity/growth/tasks/WorkBuddy_Valorant/claim`, method: 'POST',
        body: { code: 0, data: { credit: 100 } },
      },
    ])
    const report = await driveWithClock(runGrowthTaskCompletions(CRED, PRODUCT, fetcher, { budgetMs: 600_000 }))
    vi.useRealTimers()

    const reportCalls = calls.filter((c) => c.url === `${EP}/v2/report`)
    const allEvents: Record<string, unknown>[] = []
    for (const c of reportCalls) {
      const parsed = JSON.parse(c.body) as Record<string, unknown>[]
      allEvents.push(...(Array.isArray(parsed) ? parsed : [parsed]))
    }
    const chatReal = calls.find((c) => c.url === `${EP}/v2/chat/completions`)
    expect(chatReal).toBeDefined()
    expect(chatReal?.headers['x-expert-id']).toBe('ex_xQHHD1u5Jkua')
    // 召唤链三事件（expertEventChain 前 3 条）。
    const codes = allEvents.map((e) => e['eventCode'])
    expect(codes).toContain('expert_summon_click')
    expect(codes).toContain('expert_summoned')
    expect(codes).toContain('expert_actual_use')
    // 使用链：agent_task_created 带 has_expert + 固定专家 id。
    const created = allEvents.find((e) => e['eventCode'] === 'agent_task_created')
    expect(created).toMatchObject({ has_expert: true, expert_id: 'ex_xQHHD1u5Jkua', expert_name: '无畏契约拼豆专家' })
    // actual_use 为 LOCAL 变体（type 空、cost 0，轻量云/体验族同款细节）。
    const use = allEvents.find((e) => e['eventCode'] === 'expert_actual_use')
    expect(use).toMatchObject({ mode: 'LOCAL', type: '', cost: 0, id: 'ex_xQHHD1u5Jkua' })
    // 达标后自动领奖。
    expect(report.results.some((r) => r.taskCode === 'WorkBuddy_Valorant' && /已领取/.test(r.message))).toBe(true)
    expect(calls.some((c) => c.url === `${WB}/activity/growth/tasks/WorkBuddy_Valorant/claim`)).toBe(true)
  })
})

describe('小程序任务族（Sequential_*）', () => {
  it('isMpTaskCode 只认登记过的 mp 码', () => {
    expect(isMpTaskCode('Sequential_Tasks_1')).toBe(true)
    expect(isMpTaskCode('Sequential_Tasks_7')).toBe(true)
    expect(isMpTaskCode('chat_5')).toBe(false)
    expect(isMpTaskCode('WorkBuddy_Valorant')).toBe(false)
  })

  it('fetchGrowthTaskCodes 合并 mp 口径列表（带 miniprogram 头），locked 不进待办', async () => {
    // ⚠ web 与 mp 口径的列表 URL 相同（都打 product.endpoint），只能按请求头分发。
    const { fetcher, calls } = routingFetcher([
      {
        match: `${EP}/v2/activity/growth/tasks`, method: 'GET',
        body: (call) => (call.headers['x-client-platform'] === 'miniprogram'
          ? {
              code: 0,
              data: {
                tasks: [
                  growthTask('Sequential_Tasks_1'),
                  growthTask('Sequential_Tasks_4', { locked: true }),
                ],
              },
            }
          : { code: 0, data: { tasks: [growthTask('chat_5')] } }),
      },
      { match: `${EP}/activity/growth/tasks`, method: 'GET', body: EMPTY_TASKS },
    ])
    const query = await fetchGrowthTaskCodes(CRED, PRODUCT, fetcher, { includeInProgress: true })
    expect(query.ok).toBe(true)
    expect(query.codes).toContain('chat_5')
    expect(query.codes).toContain('Sequential_Tasks_1')
    expect(query.codes).not.toContain('Sequential_Tasks_4')
    // mp 口径那发 GET 必须带 miniprogram 头（缺头 Sequential 族整族拿不到）。
    const mpCall = calls.find(
      (c) => c.url === `${EP}/v2/activity/growth/tasks` && c.headers['x-client-platform'] === 'miniprogram',
    )
    expect(mpCall).toBeDefined()
  })

  it('claimGrowthTaskReward 对 mp 码带 miniprogram 头；HTTP 400 非 JSON 时降级 web 头重试', async () => {
    // 场景一：HTTP 400 + 可解析业务信封（code 400）⇒ 正常判失败，不降级。
    const bizFail = routingFetcher([
      {
        match: `${WB}/activity/growth/tasks/Sequential_Tasks_1/claim`, method: 'POST',
        body: { code: 400, msg: 'gateway reject' },
      },
    ])
    const first = await claimGrowthTaskReward(CRED, PRODUCT, bizFail.fetcher, 'Sequential_Tasks_1')
    expect(first.ok).toBe(false)
    expect(first.message).toContain('gateway reject')
    // 业务信封失败只发一次（不降级重试）。
    expect(bizFail.calls.filter((c) => c.url.endsWith('/claim')).length).toBe(1)
    expect(bizFail.calls[0]?.headers['x-client-platform']).toBe('miniprogram')

    // 场景二：HTTP 400 + 非 JSON 体 ⇒ mp 头降级为 web 头再试，拿到 credit。
    const calls: RecordedCall[] = []
    let n = 0
    const stateful = (async (url: string, init?: RequestInit) => {
      n += 1
      const headers: Record<string, string> = {}
      const raw = (init?.headers ?? {}) as unknown
      if (raw instanceof Headers) {
        raw.forEach((v, k) => {
          headers[k.toLowerCase()] = v
        })
      } else if (typeof raw === 'object' && raw !== null) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          headers[k.toLowerCase()] = String(v)
        }
      }
      calls.push({ url: String(url), method: String(init?.method ?? 'GET'), headers, body: '' })
      if (n === 1) {
        return { ok: false, status: 400, json: async () => ({}), text: async () => 'Bad Request' } as unknown as Response
      }
      const body = { code: 0, data: { credit: 200, energy: 5 } }
      return {
        ok: true, status: 200,
        json: async () => body, text: async () => JSON.stringify(body),
      } as unknown as Response
    }) as unknown as typeof fetch
    const second = await claimGrowthTaskReward(CRED, PRODUCT, stateful, 'Sequential_Tasks_1')
    expect(second.ok).toBe(true)
    expect(second.credit).toBe(200)
    const claimCalls = calls.filter((c) => c.url === `${WB}/activity/growth/tasks/Sequential_Tasks_1/claim`)
    expect(claimCalls.length).toBe(2)
    expect(claimCalls[0]?.headers['x-client-platform']).toBe('miniprogram')
    expect(claimCalls[1]?.headers['x-client-platform']).toBe('web')
  })

  it('Sequential_Tasks_1 闭环：web/mp accept 分流 + mp 指纹上报 + 达标领奖', async () => {
    vi.useFakeTimers()
    const state = { accepted: false, current: 0 }
    const mpList = () => ({
      code: 0,
      data: {
        tasks: [growthTask('Sequential_Tasks_1', {
          accept_status: state.accepted ? 'accepted' : 'not_accepted',
          progress: { current: state.current, target: 1 },
        })],
      },
    })
    const { fetcher, calls } = routingFetcher([
      // web / mp 口径共用 URL，按头分发。
      {
        match: `${EP}/v2/activity/growth/tasks`, method: 'GET',
        body: (call) => (call.headers['x-client-platform'] === 'miniprogram' ? mpList() : EMPTY_TASKS),
      },
      { match: `${EP}/activity/growth/tasks`, method: 'GET', body: EMPTY_TASKS },
      {
        match: `${EP}/activity/growth/tasks/accept`, method: 'POST',
        body: (call) => {
          if (call.headers['x-client-platform'] === 'miniprogram') {
            state.accepted = true
          }
          return { code: 0, data: {} }
        },
      },
      {
        match: `${WB}/v2/report`, method: 'POST',
        body: () => {
          state.current = 1
          return { code: 0, data: {} }
        },
      },
      {
        match: `${WB}/activity/growth/tasks/Sequential_Tasks_1/claim`, method: 'POST',
        body: { code: 0, data: { credit: 100, energy: 5 } },
      },
    ])
    const report = await driveWithClock(runGrowthTaskCompletions(CRED, PRODUCT, fetcher, {
      budgetMs: 600_000, mpChatGapMs: 0, mpJitterMaxMs: 0, mpActionGapMs: 0,
    }))
    vi.useRealTimers()

    // accept 分流：Sequential 码必须单独走 miniprogram 头那批。
    const acceptCalls = calls.filter((c) => c.url === `${EP}/activity/growth/tasks/accept`)
    expect(acceptCalls.length).toBeGreaterThanOrEqual(1)
    const mpAccept = acceptCalls.find((c) => c.headers['x-client-platform'] === 'miniprogram')
    expect(mpAccept).toBeDefined()
    expect(JSON.parse(mpAccept?.body ?? '{}')).toMatchObject({ task_codes: ['Sequential_Tasks_1'] })
    // mp 指纹上报：ideType WorkBuddy_MP + agentName mp（打 webBase）。
    const mpReport = calls.find((c) => c.url === `${WB}/v2/report`)
    expect(mpReport).toBeDefined()
    const events = JSON.parse(mpReport?.body ?? '[]') as Record<string, unknown>[]
    expect(events[0]).toMatchObject({ ideType: 'WorkBuddy_MP', agentName: 'mp', eventCode: 'chat_request_send' })
    expect(events[0]['agentType']).toBe('main')
    // 达标领奖。
    expect(report.results.some((r) => r.taskCode === 'Sequential_Tasks_1' && /领取/.test(r.message))).toBe(true)
  })

  it('Sequential_Tasks_2：专家市场不可用时不 accept（防半程态）', async () => {
    vi.useFakeTimers()
    const { fetcher, calls } = routingFetcher([
      {
        match: `${EP}/v2/activity/growth/tasks`, method: 'GET',
        body: (call) => (call.headers['x-client-platform'] === 'miniprogram'
          ? { code: 0, data: { tasks: [growthTask('Sequential_Tasks_2')] } }
          : EMPTY_TASKS),
      },
      { match: `${EP}/activity/growth/tasks`, method: 'GET', body: EMPTY_TASKS },
      {
        match: `${EP}/portal/operation-platform/market/expert/list`, method: 'POST',
        status: 500, body: { code: 500, msg: 'market down' },
      },
      { match: `${EP}/activity/growth/tasks/accept`, method: 'POST', body: { code: 0, data: {} } },
    ])
    const report = await driveWithClock(runGrowthTaskCompletions(CRED, PRODUCT, fetcher, {
      budgetMs: 600_000, mpChatGapMs: 0, mpJitterMaxMs: 0, mpActionGapMs: 0,
    }))
    vi.useRealTimers()
    const row = report.results.find((r) => r.taskCode === 'Sequential_Tasks_2')
    expect(row).toBeDefined()
    expect(row?.ok).toBe(false)
    expect(row?.message).toContain('专家市场不可用')
    // 关键：没有对 Sequential_Tasks_2 的 accept（避免留下已登记未上报的半程态）。
    const mpAccepts = calls.filter(
      (c) => c.url === `${EP}/activity/growth/tasks/accept` && c.headers['x-client-platform'] === 'miniprogram',
    )
    expect(mpAccepts.length).toBe(0)
  })
})

describe('连登链（claimStreakExtras：补签/兑换/抽奖/首Buddy/礼包/保连胜）', () => {
  /** 全链路响应（可按用例覆盖个别路由）。 */
  function streakRoutes(overrides: {
    streakBody?: unknown
    giftBody?: unknown
    firstBody?: unknown
    summaryBody?: unknown
  } = {}) {
    return [
      {
        match: `${EP}/activity/growth/streak`, method: 'GET',
        body: overrides.streakBody ?? {
          code: 0,
          data: {
            streak: { days: 9 },
            makeup_cards: { balance: 1, max: 2 },
            redemption_status: {
              tier_7d_status: 'claimable', tier_14d_status: 'locked', tier_28d_status: 'locked',
              tiers: [{ tier: '7d', days: 7, credit: 100, energy: 10, cards: 1, chances: 2 }],
            },
          },
        },
      },
      {
        match: `${EP}/activity/growth/heatmap`, method: 'GET',
        body: {
          code: 0,
          data: {
            today: { date: '2026-11-05' },
            cells: [
              { date: '2026-11-03', score: 0 },
              { date: '2026-10-30', score: 0 }, // 上月：不补
              { date: '2026-11-04', score: 100 }, // 已签：不补
            ],
          },
        },
      },
      { match: `${EP}/activity/growth/makeup-cards/use`, method: 'POST', body: { code: 0, data: {} } },
      { match: `${EP}/activity/growth/redeem`, method: 'POST', body: { code: 0, data: {} } },
      {
        match: `${EP}/activity/growth/lottery/summary`, method: 'GET',
        body: overrides.summaryBody ?? { code: 0, data: { chances: 2, module: { enabled: true } } },
      },
      { match: `${EP}/activity/growth/lottery/draw`, method: 'POST', body: { code: 0, data: { prize: 'credit' } } },
      { match: `${EP}/activity/growth/buddy/agreement`, method: 'POST', body: { code: 0, data: {} } },
      {
        match: `${EP}/activity/growth/buddy/first`, method: 'POST',
        body: overrides.firstBody ?? { code: 0, data: { reward_credit: 300 } },
      },
      {
        match: `${WB}/billing/meter/check-gift-claimed`, method: 'POST',
        body: overrides.giftBody ?? { code: 0, data: { active: true, claimed: false, credit_num: 1500 } },
      },
      { match: `${WB}/billing/meter/claim-gift`, method: 'POST', body: { code: 0, data: { credit: 1500 } } },
      { match: `${EP}/v2/chat/completions`, method: 'POST', text: SSE_TEXT },
    ]
  }

  it('全链路：补签 1 天、兑换 7d 档、抽 2 次、领养首 Buddy、领礼包、保连胜', async () => {
    const { fetcher, calls } = routingFetcher(streakRoutes())
    const report = await claimStreakExtras(CRED, PRODUCT, fetcher)
    expect(report.credit).toBe(100 + 300 + 1500)
    expect(report.claimedCount).toBe(3)
    expect(report.drewCount).toBe(2)
    expect(report.makeupUsed).toBe(1)
    const codes = report.rows.map((r) => r.taskCode)
    expect(codes).toContain('(补签)')
    expect(codes).toContain('(连登兑换:7d)')
    expect(codes).toContain('(抽奖)')
    expect(codes).toContain('(首Buddy)')
    expect(codes).toContain('(新手礼包)')
    expect(codes).toContain('(保连胜)')
    // 补签只打本月漏签日（2026-11-03），不碰上月与已签日。
    const makeupCalls = calls.filter((c) => c.url === `${EP}/activity/growth/makeup-cards/use`)
    expect(makeupCalls.length).toBe(1)
    expect(JSON.parse(makeupCalls[0]?.body ?? '{}')).toMatchObject({ target_date: '2026-11-03' })
    // 兑换带 client_token 幂等令牌。
    const redeem = calls.find((c) => c.url === `${EP}/activity/growth/redeem`)
    expect(JSON.parse(redeem?.body ?? '{}')).toMatchObject({ tier: '7d' })
    expect(String(JSON.parse(redeem?.body ?? '{}')['client_token']).length).toBeGreaterThan(0)
    // 首Buddy 前置协议：agreement 先于 first。
    const agreeAt = calls.findIndex((c) => c.url === `${EP}/activity/growth/buddy/agreement`)
    const firstAt = calls.findIndex((c) => c.url === `${EP}/activity/growth/buddy/first`)
    expect(agreeAt).toBeGreaterThanOrEqual(0)
    expect(firstAt).toBeGreaterThan(agreeAt)
    // 抽奖按 chances 恰好 2 次。
    expect(calls.filter((c) => c.url === `${EP}/activity/growth/lottery/draw`).length).toBe(2)
  })

  it('无可领对象：locked/已领档位不兑换、chances=0 不抽、礼包已领不重复领', async () => {
    const { fetcher, calls } = routingFetcher(streakRoutes({
      streakBody: {
        code: 0,
        data: {
          streak: { days: 3 },
          makeup_cards: { balance: 0, max: 2 },
          redemption_status: {
            tier_7d_status: 'claimed', tier_14d_status: 'locked',
            tiers: [{ tier: '7d', days: 7, credit: 100, energy: 10, cards: 1, chances: 2 }],
          },
        },
      },
      giftBody: { code: 0, data: { active: true, claimed: true, credit_num: 1500 } },
      summaryBody: { code: 0, data: { chances: 0, module: { enabled: true } } },
      firstBody: { code: 400, msg: 'please accept buddy adoption agreement first' },
    }))
    const report = await claimStreakExtras(CRED, PRODUCT, fetcher)
    expect(report.credit).toBe(0)
    expect(report.claimedCount).toBe(0)
    expect(report.drewCount).toBe(0)
    expect(report.makeupUsed).toBe(0)
    expect(calls.some((c) => c.url === `${EP}/activity/growth/redeem`)).toBe(false)
    expect(calls.some((c) => c.url === `${EP}/activity/growth/lottery/draw`)).toBe(false)
    expect(calls.some((c) => c.url === `${WB}/billing/meter/claim-gift`)).toBe(false)
  })
})

describe('collectBuddyGrowth 合并连登链结果', () => {
  it('连登链积分并入 claimedCredit，合成行进入 tasks 明细', async () => {
    const { fetcher } = routingFetcher([
      { match: `${EP}/v2/activity/growth/tasks`, method: 'GET', body: EMPTY_TASKS },
      { match: `${EP}/activity/growth/tasks`, method: 'GET', body: EMPTY_TASKS },
      {
        match: `${EP}/activity/growth/streak`, method: 'GET',
        body: {
          code: 0,
          data: {
            streak: { days: 9 },
            makeup_cards: { balance: 0, max: 2 },
            redemption_status: {
              tier_7d_status: 'claimable',
              tiers: [{ tier: '7d', days: 7, credit: 100, energy: 10, cards: 1, chances: 0 }],
            },
          },
        },
      },
      { match: `${EP}/activity/growth/heatmap`, method: 'GET', body: { code: 0, data: { today: { date: '2026-11-05' }, cells: [] } } },
      { match: `${EP}/activity/growth/redeem`, method: 'POST', body: { code: 0, data: {} } },
      { match: `${EP}/activity/growth/lottery/summary`, method: 'GET', body: { code: 0, data: { chances: 0, module: { enabled: true } } } },
      { match: `${EP}/activity/growth/buddy/agreement`, method: 'POST', body: { code: 0, data: {} } },
      { match: `${EP}/activity/growth/buddy/first`, method: 'POST', body: { code: 0, data: { reward_credit: 300 } } },
      { match: `${WB}/billing/meter/check-gift-claimed`, method: 'POST', body: { code: 0, data: { active: false, claimed: true, credit_num: 0 } } },
      { match: `${EP}/v2/chat/completions`, method: 'POST', text: SSE_TEXT },
    ])
    const stub = vi.stubGlobal('fetch', fetcher)
    try {
      const outcome = await collectBuddyGrowth(
        CRED,
        PRODUCT,
        { id: 'acct-9', nickname: '连登号', credentialRef: 'buddy:ref' } as never,
        undefined,
        undefined,
      )
      expect(outcome.claimedCredit).toBe(100 + 300)
      expect(outcome.claimedCount).toBe(2)
      const codes = (outcome.tasks ?? []).map((t) => t.taskCode)
      expect(codes).toContain('(连登兑换:7d)')
      expect(codes).toContain('(首Buddy)')
      expect(codes).toContain('(保连胜)')
      expect(outcome.ok).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})


describe('生产口径锁定（2026-11-01 审计补）', () => {
  it('mp 对话节奏的默认值必须是 45s + 0~10s 抖动（反作弊口径，测试注入 0 不得覆盖默认）', () => {
    // 单测里为了速度把 gap 注入成 0；生产代码不传 options 时必须落到实测口径。
    // 这里把常量锁死，防止有人「顺手」调小默认值触发上游反作弊回滚。
    expect(MP_CHAT_EVENT_GAP_MS).toBe(45_000)
    expect(MP_CHAT_JITTER_MAX_MS).toBe(10_000)
  })

  it('连登链 401 时 collectBuddyGrowth 报「凭据已失效」而非静默成普通失败', async () => {
    const { fetcher } = routingFetcher([
      { match: `${EP}/v2/activity/growth/tasks`, method: 'GET', body: EMPTY_TASKS },
      { match: `${EP}/activity/growth/tasks`, method: 'GET', body: EMPTY_TASKS },
      // 连登链第一发（streak）就 401：响应是非 JSON 的网关页（实测形态）。
      { match: `${EP}/activity/growth/streak`, method: 'GET', status: 401, text: 'Unauthorized' },
    ])
    const stub = vi.stubGlobal('fetch', fetcher)
    try {
      const outcome = await collectBuddyGrowth(
        CRED,
        PRODUCT,
        { id: 'acct-401', nickname: '僵尸号', credentialRef: 'buddy:ref' } as never,
        undefined,
        undefined,
      )
      expect(outcome.error).toContain('凭据已失效')
      expect(outcome.ok).toBe(true) // 僵尸账号不染黄（既有口径）
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('mp claim 业务信封 msg=task not found（口径不认）时降级 web 头重试', async () => {
    const calls: RecordedCall[] = []
    let n = 0
    const stateful = (async (url: string, init?: RequestInit) => {
      n += 1
      const headers: Record<string, string> = {}
      const raw = (init?.headers ?? {}) as unknown
      if (raw instanceof Headers) {
        raw.forEach((v, k) => {
          headers[k.toLowerCase()] = v
        })
      } else if (typeof raw === 'object' && raw !== null) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          headers[k.toLowerCase()] = String(v)
        }
      }
      calls.push({ url: String(url), method: String(init?.method ?? 'GET'), headers, body: '' })
      if (n === 1) {
        const body = { code: 400, msg: 'task not found' }
        return {
          ok: false, status: 400, json: async () => body, text: async () => JSON.stringify(body),
        } as unknown as Response
      }
      const body = { code: 0, data: { credit: 200, energy: 5 } }
      return {
        ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
      } as unknown as Response
    }) as unknown as typeof fetch
    const result = await claimGrowthTaskReward(CRED, PRODUCT, stateful, 'Sequential_Tasks_1')
    expect(result.ok).toBe(true)
    expect(result.credit).toBe(200)
    expect(calls.length).toBe(2)
    expect(calls[0]?.headers['x-client-platform']).toBe('miniprogram')
    expect(calls[1]?.headers['x-client-platform']).toBe('web')
  })

  it('mp claim 业务信封 msg=task not completed（真失败）时不降级、只发一次', async () => {
    const calls: RecordedCall[] = []
    const stateful = (async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {}
      const raw = (init?.headers ?? {}) as unknown
      if (raw instanceof Headers) {
        raw.forEach((v, k) => {
          headers[k.toLowerCase()] = v
        })
      } else if (typeof raw === 'object' && raw !== null) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          headers[k.toLowerCase()] = String(v)
        }
      }
      calls.push({ url: String(url), method: String(init?.method ?? 'GET'), headers, body: '' })
      const body = { code: 400, msg: 'task not completed' }
      return {
        ok: false, status: 400, json: async () => body, text: async () => JSON.stringify(body),
      } as unknown as Response
    }) as unknown as typeof fetch
    const result = await claimGrowthTaskReward(CRED, PRODUCT, stateful, 'Sequential_Tasks_1')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('task not completed')
    expect(calls.length).toBe(1)
  })
})
