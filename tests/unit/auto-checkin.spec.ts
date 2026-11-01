import { describe, expect, it } from 'vitest'
import {
  AUTO_CHECKIN_DELAY_MS,
  DEFAULT_AUTO_CHECKIN,
  DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS,
  autoCheckinDelayMs,
  createAutoCheckin,
  describeChannel,
  describeRun,
  isAutoCheckinExcluded,
  DEFAULT_AUTO_CHECKIN_TIMES,
  isUnsupportedCheckin,
  latestDueSlotKey,
  nextRunAtOf,
  nextRunDelayMs,
  runnableSlotKey,
  sanitizeAutoCheckin,
  sanitizeTimes,
  sanitizeTimesStrict,
  shouldRunNow,
  slotKey,
  checkinJitterOffsetMs,
  sanitizeJitter,
  sanitizeJitterStrict,
  MAX_CHECKIN_JITTER_MINUTES,
  utc8DateString,
  utc8MomentMs,
  utc8TimeString,
  type AutoCheckinDeps,
  type AutoCheckinDoc,
  type AutoCheckinStore,
} from '../../src/auto-checkin.js'
import type { BadgeRpcResult } from '../../src/usage-badge.js'
import { descriptorOf, PROVIDER_REGISTRY } from '../../src/provider-registry.js'
import { ZCODE } from '../../src/zcode-product.js'
import type { RpcCreditsClaimAllResponse } from '../../src/types.js'

/**
 * 「每日首次启动自动签到」的回归测试。
 *
 * 锁六件事，每件都对应一个真实会出问题的场景：
 * 1. **日界是 UTC+8**（各渠道的每日额度都按 UTC+8 结算）—— 取本机时区会
 *    「偏东漏签一天 / 偏西一天跑两次」；
 * 2. **开关默认关闭**，关闭时**一个上游请求都不发**（这是代用户打的写操作）；
 * 3. **当天只跑一次**（用户要求「不多次重复触发」）；
 * 4. **不支持的渠道不算失败**（判据交给 `claimAll` 的信封，本模块不建第二份名单）；
 * 5. **整轮零成功零已领时「今天」不记账** ⇒ 下次启动重试（凭据还没续上 / 网络不通）；
 * 6. **在飞去重**：启动排定与「刚打开开关」同时想跑时只跑一轮。
 *
 * ⚠️ 全部用例零网络、零文件系统、零等待（`schedule` 注入、时钟注入）。
 */

/** 可控时钟（用例里只用它推进时间）。 */
function clock(start: number) {
  let now = start
  return { now: () => now, set: (value: number) => { now = value } }
}

/** 2026-10-02 12:00（UTC+8）= 04:00Z。 */
const NOON_UTC8 = Date.UTC(2026, 9, 2, 4, 0, 0)

/** 前一天的 `YYYY-MM-DD`（UTC+8 日界下用正午取，避开夏时制式的边界歧义）。 */
function dayBefore(date: string): string {
  const noon = utc8MomentMs(date, '12:00')
  return utc8DateString(noon - 86_400_000)
}

/** 内存文档后端（记录写入次数，便于断言「今天只记一次」）。 */
function memoryStore(initial: Partial<AutoCheckinDoc> = {}) {
  let doc: AutoCheckinDoc = { ...DEFAULT_AUTO_CHECKIN, ...initial }
  const saves: AutoCheckinDoc[] = []
  const store: AutoCheckinStore = {
    kind: 'memory',
    load: () => ({ ...doc }),
    save: async (next) => {
      doc = { ...next }
      saves.push({ ...next })
    },
  }
  return {
    store,
    saves,
    current: () => ({ ...doc }),
    /** 直接改写内存文档（模拟「用户改了时刻 / 时段又到点」等外部变化）。 */
    reset: (patch: Partial<AutoCheckinDoc>) => { doc = { ...doc, ...patch } },
  }
}

/** 构造一个 claimAll 成功信封。 */
function ok(partial: Partial<RpcCreditsClaimAllResponse['summary']> = {}): BadgeRpcResult<RpcCreditsClaimAllResponse> {
  const summary = { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, ...partial }
  return { ok: true, value: { results: [], summary } }
}

/** 构造一个「不支持每日签到」的错误信封（`claimAll` 的 cline / raccoon / workbuddy 分支）。 */
function unsupported(message = 'Cline 不支持每日签到（其后端没有签到接口）'): BadgeRpcResult<RpcCreditsClaimAllResponse> {
  return { ok: false, error: { code: 'bad-request', message } }
}

/** 组装执行体：默认「开关开着、今天没跑过、两个渠道」。 */
function makeRunner(options: {
  initial?: Partial<AutoCheckinDoc>
  providers?: string[]
  claim?: AutoCheckinDeps['claim']
  now?: () => number
  delayMs?: number
} = {}) {
  const time = clock(options.now === undefined ? NOON_UTC8 : options.now())
  const store = memoryStore({ enabled: true, ...options.initial })
  const calls: string[] = []
  const warnings: string[] = []
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const deps: AutoCheckinDeps = {
    store: store.store,
    listProviderIds: async () => options.providers ?? ['buddy', 'qoder'],
    claim: options.claim ?? (async (provider) => {
      calls.push(provider)
      return ok({ claimed: 1, totalCredit: 100 })
    }),
    now: options.now === undefined ? time.now : options.now,
    delayMs: options.delayMs,
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false }
      scheduled.push(entry)
      return { cancel: () => { entry.cancelled = true } }
    },
    warn: (message) => warnings.push(message),
  }
  return { runner: createAutoCheckin(deps), store, calls, warnings, scheduled, time }
}

describe('自动签到：日界与配置', () => {
  it('日界按 UTC+8 算（跨 16:00Z 才换日）', () => {
    // 2026-10-02 15:59Z = UTC+8 的 10-02 23:59
    expect(utc8DateString(Date.UTC(2026, 9, 2, 15, 59, 0))).toBe('2026-10-02')
    // 2026-10-02 16:00Z = UTC+8 的 10-03 00:00 —— 换日
    expect(utc8DateString(Date.UTC(2026, 9, 2, 16, 0, 0))).toBe('2026-10-03')
    // 本机时区不影响结果（这里只断言与 UTC+8 平移一致）
    expect(utc8DateString(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01')
  })

  it('开关默认**打开**（用户 2026-10-02：「自动签到默认保持打开状态」）', () => {
    expect(DEFAULT_AUTO_CHECKIN.enabled).toBe(true)
    expect(sanitizeAutoCheckin(undefined).enabled).toBe(true)
    // ⚠️ 只有**显式 `false`** 才算关闭：旧文档没有该字段、以及非布尔脏数据
    // （`'false'` / `0` 都不是用户点出来的值）都按默认打开处理。
    expect(sanitizeAutoCheckin({}).enabled).toBe(true)
    expect(sanitizeAutoCheckin({ enabled: 'false' }).enabled).toBe(true)
    expect(sanitizeAutoCheckin({ enabled: 0 }).enabled).toBe(true)
    expect(sanitizeAutoCheckin({ enabled: false }).enabled).toBe(false)
  })

  it('缺新字段的旧文档照常读出来（channels / lastAt / dismissedRunAt 都是追加的）', () => {
    const old = sanitizeAutoCheckin({ enabled: true, lastDate: '2026-10-01', lastResult: '2 个渠道：1 个账号领取成功' })
    expect(old).toMatchObject({ enabled: true, lastDate: '2026-10-01', lastAt: 0, dismissedRunAt: 0 })
    expect(old.channels).toEqual([])
  })

  it('逐渠道结果与 dismiss 标记的归一化（脏数据不撑大文档）', () => {
    const doc = sanitizeAutoCheckin({
      enabled: true,
      lastAt: 1234,
      dismissedRunAt: 1234,
      channels: [
        { provider: 'buddy', text: '2 个 +800积分' },
        { provider: '', text: 'x' }, // 无 provider → 丢弃
        { provider: 'qoder' }, // 无 text → 丢弃
        'not-an-object',
        { provider: 'cline', text: 'y'.repeat(500) }, // 超长 → 截断
      ],
    })
    expect(doc.channels).toEqual([
      { provider: 'buddy', text: '2 个 +800积分' },
      { provider: 'cline', text: 'y'.repeat(120) },
    ])
    expect(doc.dismissedRunAt).toBe(1234)
    // 非法时间戳回落 0
    expect(sanitizeAutoCheckin({ lastAt: -5, dismissedRunAt: 'x' })).toMatchObject({ lastAt: 0, dismissedRunAt: 0 })
  })

  it('lastDate 必须是 YYYY-MM-DD，否则回落空串（脏数据不该让当天被判为已跑）', () => {
    expect(sanitizeAutoCheckin({ lastDate: '2026-10-02' }).lastDate).toBe('2026-10-02')
    expect(sanitizeAutoCheckin({ lastDate: '2026/10/02' }).lastDate).toBe('')
    expect(sanitizeAutoCheckin({ lastDate: 20261002 }).lastDate).toBe('')
    expect(sanitizeAutoCheckin({ lastDate: '' }).lastDate).toBe('')
  })

  it('★ 逐渠道水位线与 pendingSlot 的归一化（脏数据不该让「跳过上游」误成立）', () => {
    // `providerSlots` 是 2026-11-01 新增的：值只认 `YYYY-MM-DD#HH:MM`。
    // ⚠️ 这条判据**有牙**：脏值若被原样保留，字符串比较会把「一个月前的乱码」
    // 判成「已处理」，该渠道就再也不会上游签到（静默漏领）。
    const doc = sanitizeAutoCheckin({
      providerSlots: {
        buddy: '2026-11-01#10:05',
        qoder: 'yesterday', // 非 SLOT_RE ⇒ 丢
        cline: '',          // 空串 ⇒ 丢
        zcode: '2026-11-01', // 缺时刻 ⇒ 丢
        '': '2026-11-01#10:05', // 空 key ⇒ 丢
      },
      pendingSlot: '2026-11-01#09:00',
    })
    expect(doc.providerSlots).toEqual({ buddy: '2026-11-01#10:05' })
    expect(doc.pendingSlot).toBe('2026-11-01#09:00')
    // 非对象 / 脏外形 ⇒ 空表，绝不能把字符串当对象用
    expect(sanitizeAutoCheckin({ providerSlots: 'oops' }).providerSlots).toEqual({})
    expect(sanitizeAutoCheckin({ providerSlots: ['x'] }).providerSlots).toEqual({})
    expect(sanitizeAutoCheckin({ pendingSlot: 'now' }).pendingSlot).toBe('')
  })

  it('延迟配置：0 是合法值（不能被 || 吃掉），非法值回落默认', () => {
    expect(autoCheckinDelayMs({})).toBe(AUTO_CHECKIN_DELAY_MS)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: '0' })).toBe(0)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: '1500' })).toBe(1500)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: '-1' })).toBe(AUTO_CHECKIN_DELAY_MS)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: 'abc' })).toBe(AUTO_CHECKIN_DELAY_MS)
  })
})

describe('自动签到：执行判据', () => {
  it('开关关闭时一个请求都不发，也不写盘', async () => {
    const { runner, calls, store } = makeRunner({ initial: { enabled: false } })
    await runner.runIfDue()
    expect(calls).toEqual([])
    expect(store.saves).toEqual([])
    expect(runner.state()).toMatchObject({ enabled: false, ranToday: false, running: false })
  })

  it('跑过之后：遍历全部有账号的渠道，写盘一次，状态变「今天已跑」', async () => {
    const { runner, calls, store } = makeRunner({
      claim: async (provider) => {
        calls.push(provider)
        return ok({ claimed: 2, totalCredit: 300 })
      },
    })
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
    expect(store.saves).toHaveLength(1)
    expect(store.current()).toMatchObject({ lastDate: '2026-10-02', enabled: true })
    expect(store.current().lastResult).toContain('2 个渠道')
    expect(runner.state()).toMatchObject({ ranToday: true, running: false })
    // 同一天再跑：一次请求都不发（用户要求「不多次重复触发」）
    calls.length = 0
    await runner.runIfDue()
    expect(calls).toEqual([])
    expect(store.saves).toHaveLength(1)
  })

  it('换到第二天会重新跑（lastDate 不等于今天）', async () => {
    const time = clock(NOON_UTC8)
    const { runner, calls } = makeRunner({ now: time.now, initial: { lastDate: '2026-10-01' } })
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
  })

  it('「不支持每日签到」计为跳过，不算失败、不重试', async () => {
    const { runner, calls, warnings } = makeRunner({
      providers: ['buddy', 'cline', 'raccoon', 'workbuddy', 'qoder'],
      claim: async (provider) => {
        calls.push(provider)
        if (provider === 'cline' || provider === 'raccoon') return unsupported()
        if (provider === 'workbuddy') return unsupported('WorkBuddy 国际版不支持每日签到（其后端没有签到接口）')
        return ok({ alreadyClaimed: 1 })
      },
    })
    await runner.runIfDue()
    const state = runner.state()
    expect(calls).toHaveLength(5)
    // 跳过 3 个、正常 2 个；摘要里明说跳过的数量，且不出现「失败」
    expect(state.lastResult).toContain('3 个渠道不支持签到')
    expect(state.lastResult).not.toContain('失败')
    expect(warnings.some((w) => w.includes('不支持每日签到'))).toBe(false)
  })

  it('整轮零成功零已领 ⇒ 不记「今天」（下次启动重试）', async () => {
    const { runner, store, warnings } = makeRunner({
      claim: async () => ({ ok: false, error: { code: 'unauthorized', message: '凭据已过期' } }),
    })
    await runner.runIfDue()
    // ⚠️ 2026-11-01 第二轮审计 P2-8：失败轮**也要**把可读结果写下来（否则面板永远
    //    显示几天前的「上次」）。判据改成「水位线不动」，不再要求「完全不写盘」。
    expect(store.current().lastSlot).toBe('')
    expect(store.current().lastDate).toBe('')
    expect(store.current().lastResult).toContain('未计入今日')
    expect(runner.state().ranToday).toBe(false)
    expect(warnings.some((w) => w.includes('未记入今日'))).toBe(true)
  })

  it('有成功也有失败 ⇒ 记账（否则一个坏账号会让好账号每次启动都被重领）', async () => {
    const { runner, store } = makeRunner({
      providers: ['buddy', 'qoder'],
      claim: async (provider) => provider === 'buddy'
        ? ok({ claimed: 1, totalCredit: 100 })
        : { ok: false, error: { code: 'unauthorized', message: '凭据已过期' } },
    })
    await runner.runIfDue()
    expect(store.saves).toHaveLength(1)
    expect(runner.state().lastResult).toContain('1 个渠道出错')
  })

  it('账号池读不出来 ⇒ 不记账（不把「读不到」当成「今天跑过了」）', async () => {
    const store = memoryStore({ enabled: true })
    const warnings: string[] = []
    const runner = createAutoCheckin({
      store: store.store,
      listProviderIds: async () => { throw new Error('store broken') },
      claim: async () => ok({ claimed: 1 }),
      now: () => NOON_UTC8,
      warn: (m) => warnings.push(m),
    })
    await runner.runIfDue()
    expect(store.saves).toEqual([])
    expect(warnings.some((w) => w.includes('读取账号池失败'))).toBe(true)
  })

  it('在飞去重：并发调用只跑一轮', async () => {
    let claimCalls = 0
    const { runner } = makeRunner({
      providers: ['buddy'],
      claim: async () => {
        claimCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return ok({ claimed: 1 })
      },
    })
    await Promise.all([runner.runIfDue(), runner.runIfDue(), runner.runIfDue()])
    expect(claimCalls).toBe(1)
  })
})

describe('自动签到：开关与启动排定', () => {
  it('打开开关会立刻尝试一轮（今天没跑过），且 running 立刻为 true', async () => {
    const { runner, calls } = makeRunner({ initial: { enabled: false } })
    const state = await runner.setEnabled(true)
    expect(state.enabled).toBe(true)
    // runIfDue 在 setEnabled 内被同步启动 ⇒ 这一瞬间 running 已为 true
    expect(state.running).toBe(true)
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
  })

  it('当前时段已跑过时打开开关不会重跑', async () => {
    // ★ 契约变更（2026-10-18 / 2026-10-31 重建）：判据从「今天跑过没有」改成
    //   「到点的时段处理完没有」。故这里必须写 lastSlot（水位线）而不是只写 lastDate。
    const { runner, calls } = makeRunner({
      initial: { enabled: false, lastDate: '2026-10-02', lastSlot: '2026-10-02#21:00' },
    })
    const state = await runner.setEnabled(true)
    expect(state).toMatchObject({ enabled: true, ranToday: true, running: false })
    await runner.runIfDue()
    expect(calls).toEqual([])
  })

  it('★ 升级兼容：只有 lastDate 没有 lastSlot 的旧文档会补跑一次（且只补一次）', async () => {
    // 旧文档的 lastDate 记的是「那天跑过」，但没记**跑在哪个时段** ⇒ 无法判断
    // 今天两个时段各自处理了没有。取「补跑」而不是「当成已跑」：签到是幂等的
    // （上游对已领的号返回 alreadyClaimed），代价是一轮请求；而误判成「已跑」
    // 的代价是**当天整天漏领**。两害相权，补跑。
    const { runner, calls, store } = makeRunner({
      initial: { enabled: true, lastDate: '2026-10-02', lastSlot: '' },
    })
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
    // NOON_UTC8 是 UTC+8 的 12:00 ⇒ 已到点的是今天第一个时段 09:00（不是 21:00）
    expect(store.current().lastSlot).toBe('2026-10-02#09:00')
    calls.length = 0
    await runner.runIfDue()
    expect(calls).toEqual([])
  })

  it('关闭开关不触发任何请求，但保留当日记录（避免关一下又开就重跑）', async () => {
    const { runner, calls, store } = makeRunner({
      initial: { enabled: true, lastDate: '2026-10-02', lastSlot: '2026-10-02#21:00' },
    })
    const state = await runner.setEnabled(false)
    expect(state).toMatchObject({ enabled: false, ranToday: true })
    await runner.runIfDue()
    expect(calls).toEqual([])
    expect(store.current().lastSlot).toBe('2026-10-02#21:00')
  })

  it('start() 按延迟排定一次；stop() 能取消', async () => {
    const { runner, scheduled, calls } = makeRunner({ delayMs: 30_000 })
    runner.start()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.ms).toBe(30_000)
    runner.stop()
    expect(scheduled[0]!.cancelled).toBe(true)
    expect(calls).toEqual([])
  })

  it('延迟为 0 时立刻跑（不经过调度器）', async () => {
    const { runner, scheduled, calls } = makeRunner({ delayMs: 0 })
    runner.start()
    expect(scheduled).toEqual([])
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
  })

  it('start() 被重复调用只排定一次（插件热替换时不该叠加定时器）', () => {
    const { runner, scheduled } = makeRunner({ delayMs: 1_000 })
    runner.start()
    runner.start()
    expect(scheduled).toHaveLength(1)
  })
})

/**
 * 「常驻状态文字 + 手动关闭」的行为回归（用户 2026-10-02 第三轮要求）。
 *
 * 关键语义（写错就会变成「关一次以后再也看不到」或「关不掉」）：
 * - 状态文字**不自动消失**，由用户点文字上方的小叉关闭；
 * - 关闭记的是**这一轮**（`lastAt`）⇒ 下一轮跑出新结果时它**重新出现**；
 * - 逐渠道结果要能列出每个渠道的简短状态。
 */
describe('自动签到：常驻状态文字与手动关闭', () => {
  it('跑完记录逐渠道结果与时刻，且默认未关闭', async () => {
    const { runner, store } = makeRunner({
      providers: ['buddy', 'cline', 'qoder'],
      claim: async (provider) => {
        if (provider === 'cline') return unsupported()
        if (provider === 'buddy') return ok({ claimed: 2, totalCredit: 800 })
        return ok({ alreadyClaimed: 1 })
      },
    })
    await runner.runIfDue()
    const state = runner.state()
    expect(state.channels).toEqual([
      { provider: 'buddy', text: '2 个 +800积分' },
      { provider: 'cline', text: '无签到接口' },
      { provider: 'qoder', text: '1 个今天已领' },
    ])
    expect(state.lastAt).toBe(NOON_UTC8)
    expect(state.dismissed).toBe(false)
    // 逐渠道文本要落盘（重启后仍能看到上次各渠道状态）
    expect(store.current().channels).toHaveLength(3)
  })

  it('dismiss() 只关掉**当前这一轮**：下一轮结果会重新出现', async () => {
    const time = clock(NOON_UTC8)
    const { runner } = makeRunner({ now: time.now, providers: ['buddy'] })
    await runner.runIfDue()
    expect(runner.state().dismissed).toBe(false)

    const afterDismiss = await runner.dismiss()
    expect(afterDismiss.dismissed).toBe(true)

    // 换到第二天再跑一轮 ⇒ lastAt 变了，关闭标记失效，文字自动回来
    time.set(NOON_UTC8 + 86_400_000)
    await runner.runIfDue()
    expect(runner.state().dismissed).toBe(false)
  })

  it('从未跑过时 dismiss 不产生「已关闭」的假状态', async () => {
    const { runner } = makeRunner({ initial: { enabled: false } })
    const state = await runner.dismiss()
    // lastAt 为 0 ⇒ 没有可关闭的那一轮，不该显示成 dismissed（否则会永远看不到第一次结果）
    expect(state.dismissed).toBe(false)
  })

  it('describeChannel 逐渠道短文案（不含渠道名，展示层补）', () => {
    // ★ 单位感知（2026-10-04）：积分渠道现在也带上单位名（`+800积分`）。
    //   改动前是裸数字 `+800` —— 那让 ZCode 的 `+100000000` 完全看不出单位，
    //   正是用户报障的核心。带上单位后两个渠道的形态一致、可互相区分。
    expect(describeChannel({ claimed: 2, totalCredit: 800, alreadyClaimed: 0, inactive: 0, failed: 0 })).toBe('2 个 +800积分')
    expect(describeChannel({ claimed: 0, totalCredit: 0, alreadyClaimed: 3, inactive: 0, failed: 0 })).toBe('3 个今天已领')
    // ⚠️「领到但 +0 分」不能说成「已领」：会和 alreadyClaimed 撞词，看不出这次有没有动作
    expect(describeChannel({ claimed: 1, totalCredit: 0, alreadyClaimed: 1, inactive: 0, failed: 1 }))
      .toBe('1 个领取成功，1 个今天已领，1 个失败')
    expect(describeChannel({ claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 2, failed: 0 })).toBe('2 个未开启')
    expect(describeChannel({ claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0 })).toBe('无可领')
  })

  /**
   * ★ 用户报障（2026-10-04）：「Zcode 获得的是 token 数量，但是这里显示成获得积分」。
   *
   * 报障原文给的期望文案是 `+100Mtoken`（逐渠道）/ `+100Mtoken, +100积分`（汇总）。
   * 这两条锁死那个形态 —— 它是本缺陷的**验收判据**，不是描述。
   */
  it('★ ZCode 的 token 按 token 报，不冒充积分（用户报障的核心）', () => {
    const zcode = { claimed: 1, totalCredit: 100_000_000, alreadyClaimed: 0, inactive: 0, failed: 0 }
    // ① 逐渠道：1 亿 token 必须压成 `100.00M` 并标 Token
    expect(describeChannel({ ...zcode, totalByUnit: { token: 100_000_000, credit: 0 } }))
      .toBe('1 个 +100.00MToken')
    // ② 汇总：token 与积分**分列**，不做跨单位求和
    expect(describeRun({
      providers: 2, claimed: 2, totalCredit: 100_000_100, totalByUnit: { token: 100_000_000, credit: 100 },
      alreadyClaimed: 0, inactive: 0, failed: 0, skipped: 0, errors: 0, coversToday: 2,
    })).toBe('2 个渠道：2 个账号领取成功（+100.00MToken, +100积分）')  })

  it('★ 缺 totalByUnit 的旧响应回落到「按积分」（不误伤旧宿主）', () => {
    // 旧宿主只回 totalCredit ⇒ 行为与改动前一致，只是多了单位名。
    expect(describeChannel({ claimed: 1, totalCredit: 300, alreadyClaimed: 0, inactive: 0, failed: 0 }))
      .toBe('1 个 +300积分')
    expect(describeRun({
      providers: 1, claimed: 1, totalCredit: 300, alreadyClaimed: 0,
      inactive: 0, failed: 0, skipped: 0, errors: 0, coversToday: 1,
    })).toBe('1 个渠道：1 个账号领取成功（+300积分）')
  })
})

describe('自动签到：摘要与判据的纯函数', () => {
  it('isUnsupportedCheckin 只认两个窄短语', () => {
    expect(isUnsupportedCheckin('Cline 不支持每日签到（其后端没有签到接口）')).toBe(true)
    expect(isUnsupportedCheckin('unsupported provider: foo')).toBe(true)
    // 反面：真正的错误不能被吞掉
    expect(isUnsupportedCheckin('凭据已过期')).toBe(false)
    expect(isUnsupportedCheckin('unsupported reasoning effort')).toBe(false)
  })

  it('describeRun 汇总各计数；无内容时给可读文案', () => {
    expect(describeRun({
      providers: 3, claimed: 2, totalCredit: 300, alreadyClaimed: 1, inactive: 0, failed: 0, skipped: 1, errors: 0, coversToday: 3,
    })).toBe('3 个渠道：2 个账号领取成功（+300积分），1 个今天已领，1 个渠道不支持签到')
    expect(describeRun({
      providers: 2, claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, skipped: 0, errors: 0, coversToday: 0,
    })).toBe('2 个渠道：没有需要领取的账号')
  })

  /**
   * ⚠️⚠️ **真实缺陷回归（2026-10-02 审查 PR !33 定位）**：`claimed` / `alreadyClaimed`
   * 为正但 `coversToday` 为 0 时**不得**记账。
   *
   * 场景：Qoder 活动每日 10:00（UTC+8）才刷新。上午 9 点那轮看到的是**昨天**
   * 那条 `CLAIMED`（`alreadyClaimed:1, coversToday:0`）。修复前按
   * `claimed + alreadyClaimed` 记账 ⇒ 当天新额度**整天不会再被领**，而面板
   * 还显示「1 个今天已领」，用户毫无提示。
   */
  it('只有「非今日轮次」的痕迹时 ⇒ 不推进水位线（否则当天刷新后的额度整天漏领）', async () => {
    // ⚠️ 这条原本打在纯函数 `shouldMarkToday` 上；该函数已被逐渠道判据取代并删除，
    //    判据本身改由**行为**验证：跑完一轮后水位线不动 ⇒ 还会再试。
    let claims = 0
    const { runner, store } = makeRunner({
      providers: ['qoder'],
      claim: async () => { claims += 1; return ok({ alreadyClaimed: 1, coversToday: 0 }) },
    })
    await runner.runIfDue()
    expect(store.current().lastSlot).toBe('')
    expect(store.current().lastDate).toBe('')
    // 结果本身要写下来（P2-8），面板才不会显示几天前的「上次」
    expect(store.current().lastResult).toContain('未计入今日')
    // 且下一轮仍会真的再打上游（而不是被误判成「今天已跑」）
    await runner.runIfDue()
    expect(claims).toBe(2)
  })

  it('describeChannel 会标出「非今日轮次」，不把昨天的痕迹说成「今天已领」', () => {
    expect(describeChannel({ claimed: 0, totalCredit: 0, alreadyClaimed: 1, inactive: 0, failed: 0, coversToday: 0 }))
      .toBe('1 个今天已领，非今日轮次')
    // 缺 coversToday（旧响应）时按 claimed+alreadyClaimed 兜底，行为不变
    expect(describeChannel({ claimed: 0, totalCredit: 0, alreadyClaimed: 3, inactive: 0, failed: 0 }))
      .toBe('3 个今天已领')
  })

  /**
   * ⚠️ **B1 端到端**：整轮只有 Qoder 且赶在 10:00 刷新前 → 不写 `lastDate`，
   * 当天还有机会补领（修复前会写，于是 10 点刷新的额度永远领不到）。
   */
  it('端到端：整轮 coversToday=0 ⇒ 不写 lastDate（刷新后还有机会）', async () => {
    const { runner, store, warnings } = makeRunner({
      providers: ['qoder'],
      claim: async () => ok({ alreadyClaimed: 1, coversToday: 0 }),
    })
    await runner.runIfDue()
    // 水位线不动（刷新后还有机会），但**结果要写下来**（P2-8）。
    expect(store.current().lastSlot).toBe('')
    expect(store.current().lastDate).toBe('')
    expect(runner.state().ranToday).toBe(false)
    expect(warnings.some((w) => w.includes('未记入今日'))).toBe(true)
  })

  it('端到端：coversToday=1 ⇒ 照常记账（防止把上面那条修成「永不记账」）', async () => {
    const { runner, store } = makeRunner({
      providers: ['qoder'],
      claim: async () => ok({ claimed: 1, totalCredit: 100, coversToday: 1 }),
    })
    await runner.runIfDue()
    expect(store.saves).toHaveLength(1)
    expect(runner.state().ranToday).toBe(true)
  })

  it('旧响应没有 coversToday 字段时回落到 claimed+alreadyClaimed（不误伤旧宿主）', async () => {
    const { runner, store } = makeRunner({
      providers: ['buddy'],
      // 构造一个**没有** coversToday 键的响应（模拟宿主未升级）
      claim: async () => ({ ok: true, value: { results: [], summary: { claimed: 1, totalCredit: 100, alreadyClaimed: 0, inactive: 0, failed: 0 } } }),
    })
    await runner.runIfDue()
    expect(store.saves).toHaveLength(1)
  })
})

/**
 * ⚠️ **B2 回归（2026-10-02 审查 PR !33 定位）**：自动签到**不能**碰 zcode。
 *
 * zcode 有签到，但每次领取都要现场产一个阿里云 captcha param（web 版会拉起
 * headful Chromium，约 200–400MB；阿里云按**设备**限流 150 次/小时）。
 * 默认开启的自动签到 + 排除表漏了它 = 用户什么都没点，开 DSH 就起浏览器进程树；
 * 失败时又不写 `lastDate` ⇒ 每次启动都重来。
 *
 * 「等 `claimAll` 返回错误再判定」在这里**来不及** —— 代价发生在调用期间。
 */
describe('自动签到：排除「签到有代价」的渠道', () => {
  it('isAutoCheckinExcluded 只认 zcode（其余渠道照常自动）', () => {
    expect(isAutoCheckinExcluded('zcode')).toBe(true)
    for (const provider of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'loomy', 'minimax']) {
      expect(isAutoCheckinExcluded(provider)).toBe(false)
    }
  })

  it('端到端：zcode **一个上游请求都不发**，只计为跳过', async () => {
    const { runner, calls, store } = makeRunner({
      providers: ['buddy', 'qoder', 'zcode'],
      claim: async (provider) => {
        calls.push(provider)
        return ok({ claimed: 1, totalCredit: 100, coversToday: 1 })
      },
    })
    await runner.runIfDue()
    expect(calls).not.toContain('zcode')
    expect(calls).toEqual(['buddy', 'qoder'])
    const state = runner.state()
    expect(state.channels).toContainEqual({ provider: 'zcode', text: '需手动签到' })
    // 跳过 zcode 不影响其余渠道记账
    expect(state.ranToday).toBe(true)
    expect(store.saves).toHaveLength(1)
  })

  it('只有 zcode 一个渠道时：不记账（跳过不构成「今天跑过」）', async () => {
    const { runner, calls, store } = makeRunner({ providers: ['zcode'] })
    await runner.runIfDue()
    expect(calls).toEqual([])
    // 跳过不构成「今天跑过」⇒ 水位线不动（结果本身会写下来，见 P2-8）
    expect(store.current().lastSlot).toBe('')
    expect(store.current().lastDate).toBe('')
    expect(runner.state().ranToday).toBe(false)
  })

  /**
   * ⚠️ **反向守护**：把「自动签到不该碰的渠道」与「claim 分支真的要产 captcha」
   * 两件事**绑在一起**断言。
   *
   * 只测排除表会漏掉一种回归：将来 zcode 的签名变了、或**新增**了一个同样要
   * 产 captcha 的 provider，而没人记得登记。这里锁的不变式是：
   * **会产 captcha 的 claim 分支，必须逐个登记进排除表。**
   *
   * ## ⚠️ 2026-10-08（Task 11-B）：从**源码文本断言**改为 **registry 断言**
   *
   * 原实现 `readFileSync('src/jet-hub-rpc.ts')` 后按 `if (req.provider === ZCODE.id)`
   * 切分支、再在该段里找 `mintCaptcha`。它有两重问题：
   *
   * 1. **会被无关重构弄假失败** —— 它依赖 `case 'credits.claimAll':` 的分支体形状
   *    （`case` 边界、`if (req.provider === X)` 的写法、`ZCODE.id` 是否还以字面量出现）。
   *    本 PR 的 Task 2/3/4/6 都大改过 `jet-hub-rpc.ts`，这类断言已在别处红过多次；
   * 2. **判据来源错位** —— 「谁该被排除」的**唯一真相源**是 `PROVIDER_REGISTRY` 的
   *    `autoCheckinExcluded`（`isAutoCheckinExcluded` 已改为查它，见该函数注释）。
   *    扫源码文本等于在断言「实现里恰好有那串字符」，而不是断言那条登记本身。
   *
   * 现在断言的**两条**（都来自 registry，与实现写法无关）：
   * - `zcode` 的 `autoCheckinExcluded` 为 `true`（它就是唯一会产 captcha 的家）；
   * - 它的 `dailyCheckin` 为 `true`（否则「排除」就退化成「这家不支持签到」，
   *   那条登记也就失去了意义 —— 被排除的前提是**本可以**自动签到）。
   *
   * ⚠️ 行为侧（zcode 真的能签到、且真的会现产 captcha）由
   * `tests/unit/claim-runtime-parity.spec.ts` 的
   * 「★ 豁免者 zcode 真的能签到（真跑端点，证明特例分支没断）」守 ——
   * 那条真跑 `credits.claimAll` 并断言**逐 plan 展开 outcome** +
   * **captcha 现产次数**，比本文件的文本断言强得多，故这里不重复。
   *
   * ## ⚠️ 反空洞自检（本仓库踩过的坑，Task 6 的 `trae-model-id-selection` 曾中招）
   *
   * 旧形态是「在源码里找符合某模式的块，然后遍历它们断言」—— 一旦模式失配，
   * 匹配到 **0 块**，循环体不执行，用例**恒绿**（「保险失效比变红更糟」）。
   * 本用例改为**无循环的直断言**，故不存在该风险；
   * 但「**排除表整体**有没有退化成空 / 有没有别的家也该进来」仍需一个锚点，
   * 由下面的**集合级**断言承担（它同时守住「排除表不许被静默清空」）。
   */
  it('反向守护：会产 captcha 的 claim 分支必须登记进排除表（registry 判据）', () => {
    const zcode = descriptorOf('zcode')
    // 被排除的前提是「本可以自动签到」—— 否则这条登记名不副实。
    expect(zcode?.credits?.dailyCheckin, 'zcode 应在 registry 里声明可签到').toBe(true)
    expect(zcode?.autoCheckinExcluded, 'zcode 必须登记为「自动签到有代价」').toBe(true)
    // 排除表本身（它已由 registry 派生）如实反映该登记。
    expect(isAutoCheckinExcluded(ZCODE.id)).toBe(true)

    /**
     * ⚠️ **反空洞锚点**：「排除表 == registry 里 `autoCheckinExcluded === true` 的家」
     * 且该集合**非空**。
     *
     * 少了它，把 `autoCheckinExcluded` 从 registry 里**整体删掉**会让上面三条
     * 全部退化成「对着 undefined 断言」—— 而本用例仍可能因措辞变化而假绿。
     * 断言集合**逐项相等**（不是 `toContain`）则两个方向都锁死：
     * 谁把某家漏登记、或谁把不该排除的家加进来，都会红并点名。
     */
    const excluded = PROVIDER_REGISTRY
      .filter((d) => d.autoCheckinExcluded === true)
      .map((d) => d.id)
      .sort()
    expect(
      excluded,
      '排除表与 registry 漂移：多出 = 有家被误排除（用户会失去自动签到），'
      + '少出 = 有家「签到有代价」却没被排除（每次启动都会拉起 headful 浏览器）',
    ).toEqual(['zcode'])
    // ⚠️ 写死 `['zcode']` 是**有意**的：新增同样要产 captcha 的家时，
    //    这条会先红，逼作者复核「它是不是也该进排除表」（而不是静默漏掉）。
  })
})
/**
 * ★ 每天两次定时签到（用户 2026-10-18 需求；2026-10-31 重建）。
 *
 * 验收标准（逐条对应一个会真实出问题的失效形态）：
 * 1. 两个时段**各自**要跑一次 —— 用「今天跑过没有」判会让第二个时段永不触发；
 * 2. DSH 没开时错过的时段，**启动后补跑** —— 否则「无遗漏」只在从不关机的机器成立；
 * 3. 同一时段不重复跑（重启 DSH 不再补）—— 与既有「不多次重复触发」一致；
 * 4. 水位线推进正确 —— 记成「跑之前那个时段」会在跨边界时立刻重跑一次；
 * 5. 用户改时段后**立刻生效**（定时器重排）。
 */
describe('★ 自动签到：每天两次定时', () => {
  const at = (date: string, time: string): number => utc8MomentMs(date, time)

  it('utc8TimeString 返回 UTC+8 的 HH:MM（与 utc8DateString 同源平移）', () => {
    expect(utc8TimeString(at('2026-10-18', '09:00'))).toBe('09:00')
    expect(utc8TimeString(at('2026-10-18', '23:59'))).toBe('23:59')
    expect(utc8TimeString(at('2026-10-18', '00:00'))).toBe('00:00')
  })

  it('utc8MomentMs 与 utc8DateString/utc8TimeString 互逆（不依赖本机时区）', () => {
    const cases: Array<[string, string]> = [['2026-10-18', '09:00'], ['2026-01-01', '00:00'], ['2026-12-31', '23:59']]
    for (const [date, time] of cases) {
      const ms = utc8MomentMs(date, time)
      expect(utc8DateString(ms)).toBe(date)
      expect(utc8TimeString(ms)).toBe(time)
    }
  })

  it('sanitizeTimes：旧文档无 times ⇒ 回落默认两个（不能变成「一个时段都没有」）', () => {
    // ⚠️ 这是升级路径的核心：若空数组原样保留，自动签到会永远等不到时段。
    expect(sanitizeTimes(undefined)).toEqual([...DEFAULT_AUTO_CHECKIN_TIMES])
    expect(sanitizeTimes([])).toEqual([...DEFAULT_AUTO_CHECKIN_TIMES])
    expect(sanitizeTimes(['09:00'])).toEqual([...DEFAULT_AUTO_CHECKIN_TIMES])
    expect(sanitizeTimes('nonsense')).toEqual([...DEFAULT_AUTO_CHECKIN_TIMES])
  })

  it('sanitizeTimes：合法输入去重、升序；非法项丢弃；多于两个**留首尾**', () => {
    expect(sanitizeTimes(['21:00', '09:00'])).toEqual(['09:00', '21:00'])
    expect(sanitizeTimes(['09:00', '09:00', '21:00'])).toEqual(['09:00', '21:00'])
    expect(sanitizeTimes(['09:00', '25:00', 'aa'])).toEqual([...DEFAULT_AUTO_CHECKIN_TIMES])
    // ⚠️ 留**首尾**而不是「排序后前两个」：后者会把最晚那一轮静默丢掉
    //    （第二轮审计 P3：[09:00,14:00,21:00] 曾被截成 09:00/14:00）。
    expect(sanitizeTimes(['21:00', '03:00', '09:00'])).toEqual(['03:00', '21:00'])
    expect(sanitizeTimes(['09:00', '14:00', '21:00'])).toEqual(['09:00', '21:00'])
  })

  it('sanitizeTimesStrict：用户输入路径必须**抛错**而不是回落（回落=静默失效）', () => {
    expect(sanitizeTimesStrict(['21:00', '09:00'])).toEqual(['09:00', '21:00'])
    expect(() => sanitizeTimesStrict(['09:00'])).toThrow(/恰好 2 个/)
    expect(() => sanitizeTimesStrict(['09:00', '21:00', '23:00'])).toThrow(/恰好 2 个/)
    expect(() => sanitizeTimesStrict([])).toThrow(/恰好 2 个/)
    expect(() => sanitizeTimesStrict(['9:00', '21:00'])).toThrow(/HH:MM/)
    expect(() => sanitizeTimesStrict(['24:00', '21:00'])).toThrow(/HH:MM/)
    expect(() => sanitizeTimesStrict(['09:60', '21:00'])).toThrow(/HH:MM/)
    expect(() => sanitizeTimesStrict(['09:00', '09:00'])).toThrow(/不能相同/)
  })

  it('latestDueSlotKey：今天已到点的最大时段；今天还没到点则回落到昨天最后一个', () => {
    const times = ['09:00', '21:00']
    expect(latestDueSlotKey(at('2026-10-18', '08:30'), times)).toBe(slotKey('2026-10-17', '21:00'))
    expect(latestDueSlotKey(at('2026-10-18', '09:00'), times)).toBe(slotKey('2026-10-18', '09:00'))
    expect(latestDueSlotKey(at('2026-10-18', '09:05'), times)).toBe(slotKey('2026-10-18', '09:00'))
    expect(latestDueSlotKey(at('2026-10-18', '20:59'), times)).toBe(slotKey('2026-10-18', '09:00'))
    expect(latestDueSlotKey(at('2026-10-18', '21:00'), times)).toBe(slotKey('2026-10-18', '21:00'))
    expect(latestDueSlotKey(at('2026-10-18', '23:59'), times)).toBe(slotKey('2026-10-18', '21:00'))
  })

  it('shouldRunNow：水位线落后于已到点时段 ⇒ 跑；相等 ⇒ 不跑；开关关 ⇒ 不跑', () => {
    const times = ['09:00', '21:00']
    const noon = at('2026-10-18', '12:00')
    expect(shouldRunNow({ enabled: true, times, lastSlot: '' }, noon)).toBe(true)
    expect(shouldRunNow({ enabled: true, times, lastSlot: slotKey('2026-10-17', '21:00') }, noon)).toBe(true)
    expect(shouldRunNow({ enabled: true, times, lastSlot: slotKey('2026-10-18', '09:00') }, noon)).toBe(false)
    expect(shouldRunNow({ enabled: false, times, lastSlot: '' }, noon)).toBe(false)
    const evening = at('2026-10-18', '21:00')
    expect(shouldRunNow({ enabled: true, times, lastSlot: slotKey('2026-10-18', '09:00') }, evening)).toBe(true)
  })

  it('nextRunAtOf：今天还有未到点时段 ⇒ 今天那个；都过了 ⇒ 明天第一个', () => {
    const times = ['09:00', '21:00']
    expect(nextRunAtOf(at('2026-10-18', '03:00'), { enabled: true, times, lastSlot: slotKey('2026-10-17', '21:00') }))
      .toBe(at('2026-10-18', '09:00'))
    expect(nextRunAtOf(at('2026-10-18', '12:00'), { enabled: true, times, lastSlot: slotKey('2026-10-18', '09:00') }))
      .toBe(at('2026-10-18', '21:00'))
    expect(nextRunAtOf(at('2026-10-18', '22:00'), { enabled: true, times, lastSlot: slotKey('2026-10-18', '21:00') }))
      .toBe(at('2026-10-19', '09:00'))
    expect(nextRunAtOf(at('2026-10-18', '12:00'), { enabled: false, times, lastSlot: '' })).toBe(0)
  })

  it('★ nextRunAtOf：水位线落后（有错过时段）⇒ 返回「现在」（补跑即将执行）', () => {
    // 原实现会算成「明天 09:00」，而实际上一轮补跑马上就要跑 —— 面板会显示一个
    // 自相矛盾的「下次执行」时间。用 `<= now` 判，因为调用方会用 `Math.max(1_000,…)` 兜住。
    const times = ['09:00', '21:00']
    const noon = at('2026-10-18', '12:00')
    expect(nextRunAtOf(noon, { enabled: true, times, lastSlot: slotKey('2026-10-17', '21:00') })).toBeLessThanOrEqual(noon)
    expect(nextRunAtOf(noon, { enabled: true, times, lastSlot: '' })).toBeLessThanOrEqual(noon)
    // 反例：已处理完当前时段 ⇒ 必须是未来的时刻
    expect(nextRunAtOf(noon, { enabled: true, times, lastSlot: slotKey('2026-10-18', '09:00') })).toBeGreaterThan(noon)
  })

  it('nextRunDelayMs：水位线落后 ⇒ 0（立刻补跑）；否则给到下一时段的毫秒差', () => {
    const times = ['09:00', '21:00']
    expect(nextRunDelayMs(at('2026-10-18', '12:00'), { enabled: true, times, lastSlot: slotKey('2026-10-17', '21:00') })).toBe(0)
    expect(nextRunDelayMs(at('2026-10-18', '12:00'), { enabled: true, times, lastSlot: slotKey('2026-10-18', '09:00') })).toBe(9 * 3_600_000)
    expect(nextRunDelayMs(at('2026-10-18', '22:00'), { enabled: true, times, lastSlot: slotKey('2026-10-18', '21:00') })).toBe(11 * 3_600_000)
  })

  it('★ 端到端：一天两个时段各跑一次（第二次在 21:00 到点后）', async () => {
    // ⚠️ 这里**显式**给 times：默认值已经改成 10:05/21:00（为覆盖 10:00 刷新额度的
    //   渠道），而本用例验的是「两个时段各自跑一次」这条逻辑，不该跟着默认值漂。
    const time = clock(at('2026-10-18', '09:00'))
    const { runner, calls, store } = makeRunner({
      now: time.now,
      providers: ['buddy'],
      initial: { times: ['09:00', '21:00'] },
    })

    await runner.runIfDue()
    expect(calls).toEqual(['buddy'])
    expect(store.current().lastSlot).toBe('2026-10-18#09:00')

    time.set(at('2026-10-18', '12:00'))
    calls.length = 0
    await runner.runIfDue()
    expect(calls).toEqual([])

    time.set(at('2026-10-18', '21:00'))
    await runner.runIfDue()
    expect(calls).toEqual(['buddy'])
    expect(store.current().lastSlot).toBe('2026-10-18#21:00')

    time.set(at('2026-10-18', '23:00'))
    calls.length = 0
    await runner.runIfDue()
    expect(calls).toEqual([])
  })

  it('★ 端到端：DSH 没开错过了 09:00 ⇒ 11:00 启动补跑', async () => {
    const { runner, calls, store } = makeRunner({
      now: () => at('2026-10-18', '11:00'),
      providers: ['buddy'],
      initial: { lastSlot: slotKey('2026-10-17', '21:00') },
    })
    await runner.runIfDue()
    expect(calls).toEqual(['buddy'])
    expect(store.current().lastSlot).toBe('2026-10-18#09:00')
  })

  it('★ 端到端：关机一整天回来只补一次（不会连发两轮）', async () => {
    const { runner, calls } = makeRunner({
      now: () => at('2026-10-18', '11:00'),
      providers: ['buddy'],
      initial: { lastSlot: slotKey('2026-10-16', '21:00') },
    })
    await runner.runIfDue()
    expect(calls).toEqual(['buddy'])
    calls.length = 0
    await runner.runIfDue()
    expect(calls).toEqual([])
  })

  it('★ setTimes：改时段后立刻按新时刻排（旧定时器被撤掉）', async () => {
    const time = clock(at('2026-10-18', '12:00'))
    const { runner, scheduled } = makeRunner({
      now: time.now,
      initial: { enabled: true, times: ['09:00', '21:00'], lastSlot: slotKey('2026-10-18', '09:00') },
    })
    runner.start()
    await Promise.resolve()
    expect(scheduled.length).toBeGreaterThan(0)
    const state = await runner.setTimes(['15:00', '23:00'])
    expect(state.times).toEqual(['15:00', '23:00'])
    expect(state.nextRunAt).toBe(at('2026-10-18', '15:00'))
    expect(scheduled.some((entry) => entry.cancelled)).toBe(true)
  })

  it('★ setTimes：非法输入抛错且**不写盘**（保住原时段）', async () => {
    const { runner, store } = makeRunner({
      now: () => at('2026-10-18', '12:00'),
      initial: { enabled: true, times: ['09:00', '21:00'] },
    })
    const savesBefore = store.saves.length
    await expect(runner.setTimes(['09:00'])).rejects.toThrow(/恰好 2 个/)
    await expect(runner.setTimes(['aa', '21:00'])).rejects.toThrow(/HH:MM/)
    expect(store.saves).toHaveLength(savesBefore)
    expect(store.current().times).toEqual(['09:00', '21:00'])
  })

  it('★ state 暴露 times / lastSlot / nextRunAt / ranToday（客户端面板靠它们渲染）', async () => {
    const { runner } = makeRunner({
      now: () => at('2026-10-18', '12:00'),
      providers: ['buddy'],
      initial: { enabled: true, times: ['09:00', '21:00'], lastSlot: slotKey('2026-10-18', '09:00') },
    })
    const state = runner.state()
    expect(state.times).toEqual(['09:00', '21:00'])
    expect(state.lastSlot).toBe('2026-10-18#09:00')
    expect(state.ranToday).toBe(true)
    expect(state.nextRunAt).toBe(at('2026-10-18', '21:00'))
  })
})

/**
 * ★ 随机浮动（用户 2026-10-31：「搞得像真人一样有时间波动」）。
 *
 * 四条硬要求，每条都对应一个会真实出问题的形态：
 * 1. **确定性**：同一个时段每次算出的偏移必须相同 —— 否则面板说「9:05」而实际
 *    9:12 才跑，用户会发现不一致；
 * 2. **每轮不同**：换一天 / 换时段必须变 —— 否则每天都在同一分钟，指纹和固定时刻一样；
 * 3. **不越界**：偏移绝不许让两个时段合并（否则「一天两次」失效）；
 * 4. **可关闭**：jitter = 0 时行为与不浮动**逐字节相同**。
 */
describe('★ 自动签到：随机浮动', () => {
  const at = (date: string, time: string): number => utc8MomentMs(date, time)

  it('jitter = 0 ⇒ 偏移恒为 0（与不浮动逐字节相同）', () => {
    for (const [d, t] of [['2026-10-18', '09:00'], ['2026-10-19', '21:00'], ['2026-12-31', '09:00']]) {
      expect(checkinJitterOffsetMs(d, t, 0, 720)).toBe(0)
    }
  })

  it('★ 确定性：同一 (日期, 时刻) 反复算十次结果相同', () => {
    const values = Array.from({ length: 10 }, () => checkinJitterOffsetMs('2026-10-18', '09:00', 10, 720))
    expect(new Set(values).size).toBe(1)
    expect(values[0]).toBe(checkinJitterOffsetMs('2026-10-18', '09:00', 10, 720))
  })

  it('★ 每轮不同：换日期或换时段，偏移不同（不能每天都在同一分钟）', () => {
    const a = checkinJitterOffsetMs('2026-10-18', '09:00', 10, 720)
    const b = checkinJitterOffsetMs('2026-10-19', '09:00', 10, 720)
    const c = checkinJitterOffsetMs('2026-10-18', '21:00', 10, 720)
    // 三天/两时段全部相同是极小概率，但不该断言「必然不同」——改为断言「不全相同」
    expect([a, b, c].every((v) => v === a)).toBe(false)
  })

  it('★ 偏移落在 ±jitter 之内', () => {
    for (let day = 1; day <= 20; day += 1) {
      const date = `2026-11-${String(day).padStart(2, '0')}`
      for (const t of ['09:00', '21:00']) {
        const ms = checkinJitterOffsetMs(date, t, 10, 720)
        expect(Math.abs(ms)).toBeLessThanOrEqual(10 * 60_000)
      }
    }
  })

  it('★ 不越界：与下一时段间隔很小时，偏移被夹紧到间隔一半', () => {
    // 09:00 与 09:10 只隔 10 分钟 ⇒ 偏移最多 ±5 分钟（不能推到 09:10 之后）
    const ms = checkinJitterOffsetMs('2026-10-18', '09:00', 60, 10)
    expect(Math.abs(ms)).toBeLessThanOrEqual(5 * 60_000)
  })

  it('sanitizeJitter：非法值回落 0（精确执行），超上限截断', () => {
    expect(sanitizeJitter(undefined)).toBe(0)
    expect(sanitizeJitter(null)).toBe(0)
    expect(sanitizeJitter('abc')).toBe(0)
    expect(sanitizeJitter(-5)).toBe(0)
    expect(sanitizeJitter(Number.NaN)).toBe(0)
    expect(sanitizeJitter(10)).toBe(10)
    expect(sanitizeJitter(MAX_CHECKIN_JITTER_MINUTES + 500)).toBe(MAX_CHECKIN_JITTER_MINUTES)
  })

  it('sanitizeJitterStrict：用户输入非法 ⇒ 抛错而不是回落', () => {
    expect(sanitizeJitterStrict(0)).toBe(0)
    expect(sanitizeJitterStrict(10)).toBe(10)
    expect(() => sanitizeJitterStrict('10')).toThrow(/必须是数字/)
    expect(() => sanitizeJitterStrict(-1)).toThrow(/不能为负/)
    expect(() => sanitizeJitterStrict(MAX_CHECKIN_JITTER_MINUTES + 1)).toThrow(/不能超过/)
  })

  it('★ shouldRunNow：正偏移 ⇒ 到「时段+偏移」才跑（提前一分钟不跑）', () => {
    const times = ['09:00', '21:00']
    // 找一个偏移为**正**的日期（真实执行晚于 09:00）
    let date = ''
    let offset = 0
    for (let d = 1; d <= 28; d += 1) {
      const candidate = `2026-11-${String(d).padStart(2, '0')}`
      const o = checkinJitterOffsetMs(candidate, '09:00', 10, 720)
      if (o > 0) { date = candidate; offset = o; break }
    }
    expect(date).not.toBe('')
    const realAt = at(date, '09:00') + offset
    // ⚠️ 水位线必须**已经停在昨天最后一个时段**：`lastSlot: ''`（从未跑过）时
    //    昨天 21:00 那轮本身就是待补的，判据会（正确地）返回 true —— 那是补跑，
    //    不是「今天这一轮提前跑了」。
    const lastSlot = slotKey(dayBefore(date), '21:00')
    const doc = { enabled: true, times, lastSlot, jitterMinutes: 10 }
    // 时段整点已过、但真实执行时刻还没到 ⇒ 不跑
    expect(shouldRunNow(doc, realAt - 60_000)).toBe(false)
    // 到了真实执行时刻 ⇒ 跑
    expect(shouldRunNow(doc, realAt)).toBe(true)
  })

  it('★★ 负偏移必须**真的提前**执行（2026-11-01 审计 P1-2：旧实现里这是死代码）', () => {
    const times = ['09:00', '21:00']
    let date = ''
    let offset = 0
    for (let d = 1; d <= 28; d += 1) {
      const candidate = `2026-11-${String(d).padStart(2, '0')}`
      const o = checkinJitterOffsetMs(candidate, '09:00', 10, 720)
      if (o < 0) { date = candidate; offset = o; break }
    }
    expect(date).not.toBe('')
    const slotAt = at(date, '09:00')
    const doc = {
      enabled: true,
      times,
      lastSlot: slotKey(dayBefore(date), '21:00'),
      jitterMinutes: 10,
    }
    // 判别力：先断言这个时段**确实是负偏移**（否则用例变成恒真）
    expect(offset).toBeLessThan(0)
    // 「时段 + 偏移」这一刻（**早于** 09:00）就必须判跑 —— 这正是旧实现恒 false 的那一格
    expect(shouldRunNow(doc, slotAt + offset)).toBe(true)
    // 更早一分钟还不该跑
    expect(shouldRunNow(doc, slotAt + offset - 60_000)).toBe(false)
    // 而且「已到点的时段」也要跟着提前：水位线推进到**今天 09:00**
    expect(latestDueSlotKey(slotAt + offset, times, 10)).toBe(slotKey(date, '09:00'))
  })

  it('★ shouldRunNow：错过的时段（真实时刻早已过去）必须立刻补跑，不能因浮动卡住', () => {
    const times = ['09:00', '21:00']
    // 水位线停在昨天，现在已过今天 09:00 很久（偏移不可能这么长）
    const now = at('2026-10-18', '12:00')
    expect(shouldRunNow({ enabled: true, times, lastSlot: slotKey('2026-10-17', '21:00'), jitterMinutes: 60 }, now)).toBe(true)
  })

  it('★ nextRunAtOf：配了浮动 ⇒ 返回的时刻 = 时段时刻 + 该轮偏移', () => {
    const times = ['09:00', '21:00']
    const noon = at('2026-10-18', '12:00')
    const doc = { enabled: true, times, lastSlot: slotKey('2026-10-18', '09:00') }
    const base = nextRunAtOf(noon, doc)
    const jittered = nextRunAtOf(noon, { ...doc, jitterMinutes: 10 })
    // ★ 判别力在「差值恰好等于该时段的确定性偏移」——不能只断言「在 ±10 之内」：
    //   那对「完全不加偏移」的实现也恒真（diff = 0 也在 10 分钟内），是假绿。
    //   这里把期望值独立算出来（走纯函数 checkinJitterOffsetMs），实现没接上就红。
    const expectedOffset = checkinJitterOffsetMs('2026-10-18', '21:00', 10, 720)
    expect(jittered - base).toBe(expectedOffset)
    // 而且偏移本身不为 0（否则「等于 0」的实现在这条上也过）
    expect(expectedOffset).not.toBe(0)
  })
})
/**
 * ★★ 退避：不许每秒重跑（真实忙循环，2026-11-01 实测）。
 *
 * 缺陷形态：`nextRunDelayMs` 在「有时段到点但没跑成」时恒返回 0，而 `armNext`
 * 用 Math.max(1_000, 0) ⇒ **每秒重跑一轮**。实测 5 轮内 claim 被调用 10 次
 *（2 渠道 × 5 轮）。凭据持续失效时等于每秒打一轮上游 —— 既烧请求也触发风控。
 *
 * 判据打在**排定的延迟**上（不是「跑了几次」）：跑几次取决于调度器何时触发，
 * 而延迟是可以直接断言的东西。
 */
describe('★★ 自动签到：失败必须退避，不许每秒重跑', () => {
  /** 起一个用「手动调度」的执行体（scheduled 收集延迟，queued 收集回调）。 */
  function makeProbe(claimImpl, startDate = '2026-11-01') {
    const time = clock(utc8MomentMs(startDate, '09:00'))
    // ⚠️ 显式给 `times: ['09:00','21:00']`：默认值已改成 10:05/21:00（覆盖 10:00
    //    才刷新额度的渠道），而本组用例的时钟是 09:00 —— 用默认值会**根本没到时段**
    //    （排定的第一项变成「到 10:05 的 65 分钟」而不是退避序列）。
    const store = memoryStore({
      enabled: true,
      times: ['09:00', '21:00'],
      lastSlot: slotKey('2026-10-31', '21:00'),
    })
    const scheduled: number[] = []
    const queued: Array<() => void> = []
    const runner = createAutoCheckin({
      store: store.store,
      listProviderIds: async () => ['buddy'],
      claim: claimImpl,
      now: time.now,
      // ⚠️ 用**非零延迟**让 start() 走调度器：`delayMs: 0` 时 start() 会直接触发
      //    首轮、不经过 schedule ⇒ 排定列表为空，看不到退避（这是测试陷阱，
      //    不是实现缺陷）。
      delayMs: 1,
      schedule: (fn, ms) => { scheduled.push(ms); queued.push(fn); return { cancel: () => {} } },
      warn: () => {},
    })
    return { runner, scheduled, queued, time, store }
  }

  async function advance(queued: Array<() => void>, rounds: number) {
    for (let i = 0; i < rounds; i += 1) {
      const fire = queued.shift()
      if (fire === undefined) break
      fire()
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }

  it('claim 恒失败 ⇒ 排定延迟递增（1s→2s→4s），不是恒 1s', async () => {
    const probe = makeProbe(async () => ({ ok: false, error: { code: 'unauthorized', message: '凭据已过期' } }))
    probe.runner.start()
    await advance(probe.queued, 4)
    expect(probe.scheduled.length).toBeGreaterThanOrEqual(3)
    // ⚠️ 首项是 `start()` 的初始延迟（1ms，测试用的 delayMs），退避从**第二项**起。
    //    实测序列：1, 1000, 2000, 4000, 8000, 16000, 32000 —— 指数递增。
    const backoff = probe.scheduled.slice(1)
    expect(backoff.length).toBeGreaterThanOrEqual(2)
    expect(backoff.every((ms) => ms >= 1_000)).toBe(true)
    // ★ 核心：必须**递增**（恒 1 秒就是忙循环）
    expect(backoff[1]!).toBeGreaterThan(backoff[0]!)
    expect(backoff[1]!).toBeGreaterThanOrEqual(2_000)
  })

  it('★ 退避有上限（不会增长到几小时）', async () => {
    const probe = makeProbe(async () => ({ ok: false, error: { code: 'unauthorized', message: '过期' } }))
    probe.runner.start()
    await advance(probe.queued, 12)
    expect(probe.scheduled.length).toBeGreaterThan(3)
    expect(Math.max(...probe.scheduled)).toBeLessThanOrEqual(30 * 60_000)
    // 且确实增长过（首项 1ms 不算）
    expect(Math.max(...probe.scheduled.slice(1))).toBeGreaterThanOrEqual(4_000)
  })

  it('★ 退避计数可见于告警文案（运维能从日志看出退避状态）', async () => {
    // ⚠️ 说明：「成功后清零」在外部**不可观测**（成功记账会推进水位线 ⇒ 下一轮走
    //    `normal > 0` 分支，根本不读 dueFailures ⇒ 清零与否对外无差别）。
    //    按本仓库纪律：**不可观测的语义不编恒真用例**（我前两版就写了假绿，变异实测
    //    删掉 `dueFailures = 0` 仍全绿）。改为断言可观测的部分 —— 退避次数写进了告警。
    const warnings: string[] = []
    const time = clock(utc8MomentMs('2026-11-01', '09:00'))
    const store = memoryStore({
      enabled: true,
      // 同上：显式时段，别让默认值（10:05）把「09:00 到点」这件事变成「还没到」。
      times: ['09:00', '21:00'],
      lastSlot: slotKey('2026-10-31', '21:00'),
    })
    const queued: Array<() => void> = []
    const runner = createAutoCheckin({
      store: store.store,
      listProviderIds: async () => ['buddy'],
      claim: async () => ({ ok: false, error: { code: 'unauthorized', message: '过期' } }),
      now: time.now,
      delayMs: 1,
      schedule: (fn) => { queued.push(fn); return { cancel: () => {} } },
      warn: (m) => warnings.push(m),
    })
    runner.start()
    for (let i = 0; i < 3; i += 1) {
      const fire = queued.shift()
      if (fire === undefined) break
      fire()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const counts = warnings
      .filter((w) => w.includes('第 '))
      .map((w) => Number((w.match(/第 (\d+) 次/) || [])[1]))
    expect(counts.length).toBeGreaterThanOrEqual(2)
    // ★ 次数必须递增（退避的依据；恒为 1 说明没在累加）
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[0]!)
  })

  it('★★ 成功一次就必须清零退避（否则下一个时段的首次失败直接等几十秒）', async () => {
    // ⚠️ 2026-11-01 审计证伪了旧注释里的「清零对外不可观测」：它**可观测** ——
    //    清零后下一轮的首次失败退避从 1000ms 起；不清零会接着上一次的 4000/16000ms。
    const time = clock(utc8MomentMs('2026-11-01', '10:05'))
    let fail = true
    const store = memoryStore({
      enabled: true,
      times: ['10:05', '21:00'],
      lastSlot: slotKey('2026-10-31', '21:00'),
    })
    const scheduled: Array<{ ms: number; fn: () => void }> = []
    const runner = createAutoCheckin({
      store: store.store,
      listProviderIds: async () => ['buddy'],
      claim: async () => (fail
        ? { ok: false, error: { code: 'unauthorized', message: '过期' } }
        : ok({ claimed: 1, totalCredit: 10, coversToday: 1 })),
      now: time.now,
      delayMs: 1,
      schedule: (fn, ms) => { scheduled.push({ ms, fn }); return { cancel: () => {} } },
      warn: () => {},
    })
    /** 推进到**这一项自己的**排定时刻再触发（不能用「最后一项」的 ms，会错位）。 */
    const tick = async (): Promise<void> => {
      const entry = scheduled.shift()
      if (entry === undefined) return
      time.set(time.now() + entry.ms)
      entry.fn()
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    runner.start()
    await tick()
    await tick()          // 失败两次 ⇒ 排定 2000ms
    const before = scheduled[0]?.ms ?? 0
    expect(before).toBe(2_000)
    fail = false
    await tick()          // 成功 ⇒ 记账 + 清零；下一项被排到 21:00
    fail = true
    // 把时钟拨到 21:00，触发下一项（那一项是「到 21:00」）⇒ 再失败一次
    time.set(utc8MomentMs('2026-11-01', '21:00'))
    await tick()
    // ★ 判别力：清零过 ⇒ 首个退避必须是 1_000ms；不清零会接着 4_000/8_000
    expect(scheduled[0]?.ms).toBe(1_000)
    expect(before).toBeGreaterThan(1_000)
  })
})

/**
 * 2026-11-01 审计打穿的三条 P1 的回归（不放上网也修不掉的形态：
 * 吞时段 / 面板时间撒谎 / 10:00 刷新渠道漏领）。
 */
describe('★★ 自动签到：时段记账与逐渠道补领', () => {
  const at = (date: string, time: string): number => utc8MomentMs(date, time)

  it('★ 跨时段边界的补跑不得吞掉下一个时段（审计 P1-6）', async () => {
    // 场景：昨天 21:00 那轮 DSH 没开（水位线停在昨天 09:00）⇒ 今天 08:58 启动补跑，
    // 一轮跑到 09:05 才结束。旧实现把水位线记成「跑完那一刻已到点的最大时段」
    // = 今天 09:00 ⇒ 09:00 那轮被吞（它从未单独执行）。
    const time = clock(at('2026-10-18', '08:58'))
    const calls: string[] = []
    const { runner, store } = makeRunner({
      now: time.now,
      providers: ['buddy'],
      initial: { times: ['09:00', '21:00'], lastSlot: slotKey('2026-10-17', '09:00') },
      claim: async (provider) => {
        calls.push(provider)
        // 一轮历时 7 分钟，跨过 09:00
        time.set(at('2026-10-18', '09:05'))
        return ok({ claimed: 1, totalCredit: 10 })
      },
    })
    await runner.runIfDue()
    // 判别力：这轮是为**昨天 21:00** 跑的，水位线只能推到那里
    expect(store.current().lastSlot).toBe('2026-10-17#21:00')
    // ⇒ 09:00 那轮仍然待跑
    calls.length = 0
    await runner.runIfDue()
    expect(calls).toEqual(['buddy'])
    expect(store.current().lastSlot).toBe('2026-10-18#09:00')
  })

  it('★ 部分渠道没领到 ⇒ 记 pendingSlot 且重试**只打**没领到的那个（审计 P1-5）', async () => {
    // 混合池：buddy 能证明今天，qoder 拿到的还是昨天的痕迹（10:00 才刷新额度）。
    let qoderRefreshed = false
    const calls: string[] = []
    const time = clock(at('2026-10-18', '09:00'))
    const { runner, store } = makeRunner({
      now: time.now,
      providers: ['buddy', 'qoder'],
      initial: { times: ['09:00', '21:00'], lastSlot: slotKey('2026-10-17', '21:00') },
      claim: async (provider) => {
        calls.push(provider)
        if (provider === 'qoder') {
          return qoderRefreshed
            ? ok({ claimed: 1, totalCredit: 5, coversToday: 1 })
            : ok({ alreadyClaimed: 1, coversToday: 0 })
        }
        return ok({ claimed: 1, totalCredit: 100, coversToday: 1 })
      },
    })
    await runner.runIfDue()
    // buddy 已证明今天、qoder 还没 ⇒ 整轮**不**记账，改为 pendingSlot
    expect(store.current().pendingSlot).toBe('2026-10-18#09:00')
    expect(store.current().lastSlot).toBe('2026-10-17#21:00')
    expect(store.current().providerSlots).toMatchObject({ buddy: '2026-10-18#09:00' })
    expect(store.current().providerSlots.qoder).toBeUndefined()

    // 到 10:05（Qoder 刷新后）重试一次：**只打 qoder**（buddy 已处理 ⇒ 不再重复请求）
    calls.length = 0
    qoderRefreshed = true
    time.set(at('2026-10-18', '10:05'))
    await runner.runIfDue()
    expect(calls).toEqual(['qoder'])
    // 补完 ⇒ 水位线推进、待补清空
    expect(store.current().lastSlot).toBe('2026-10-18#09:00')
    expect(store.current().pendingSlot).toBe('')
  })

  it('★ state().nextRunAt 必须是**真实的下一次尝试**，不能恒等于「现在」（审计 P1-4）', async () => {
    const time = clock(at('2026-10-18', '12:00'))
    const scheduled: Array<{ ms: number }> = []
    const queued: Array<() => void> = []
    const store = memoryStore({ enabled: true, times: ['10:05', '21:00'], lastSlot: slotKey('2026-10-17', '21:00') })
    const runner = createAutoCheckin({
      store: store.store,
      listProviderIds: async () => ['buddy'],
      claim: async () => ({ ok: false, error: { code: 'unauthorized', message: '过期' } }),
      now: time.now,
      delayMs: 1,
      schedule: (fn, ms) => { scheduled.push({ ms }); queued.push(fn); return { cancel: () => {} } },
      warn: () => {},
    })
    runner.start()
    for (let i = 0; i < 4; i += 1) {
      const fire = queued.shift()
      if (fire === undefined) break
      fire()
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    const ms = scheduled[scheduled.length - 1]!.ms
    const state = runner.state()
    // 判别力：旧实现这里恒等于 now（面板写「马上执行」），实际还要等 ms
    expect(ms).toBeGreaterThanOrEqual(4_000)
    expect(state.nextRunAt - time.now()).toBe(ms)
  })

  it('★ setTimes 清掉退避计数（改完时刻不该还等 30 分钟）', async () => {
    const time = clock(at('2026-10-18', '12:00'))
    const queued: Array<() => void> = []
    const store = memoryStore({ enabled: true, times: ['10:05', '21:00'], lastSlot: slotKey('2026-10-17', '21:00') })
    const runner = createAutoCheckin({
      store: store.store,
      listProviderIds: async () => ['buddy'],
      claim: async () => ({ ok: false, error: { code: 'unauthorized', message: '过期' } }),
      now: time.now,
      delayMs: 1,
      schedule: (fn) => { queued.push(fn); return { cancel: () => {} } },
      warn: () => {},
    })
    runner.start()
    for (let i = 0; i < 8; i += 1) {
      const fire = queued.shift()
      if (fire === undefined) break
      fire()
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    // 此刻 nextRunAt 在几分钟之后（退避到 30 分钟档）
    expect(runner.state().nextRunAt - time.now()).toBeGreaterThan(60_000)
    await runner.setTimes(['10:05', '21:00'])
    // 改完时刻后第一轮马上可跑（不再沿用旧退避）—— 1 秒下限由 armNext 给
    expect(runner.state().nextRunAt - time.now()).toBeLessThanOrEqual(1_000)
  })

  it('★★ setEnabled(true) 必须续排下一轮（否则当天第二个时段永不触发）', async () => {
    // 这是审计里「删掉 armNext 后 86 条全绿」的那一格 —— 补上行为级守卫。
    const time = clock(at('2026-10-18', '10:05'))
    const scheduled: Array<{ ms: number }> = []
    const store = memoryStore({ enabled: false, times: ['10:05', '21:00'], lastSlot: slotKey('2026-10-17', '21:00') })
    const runner = createAutoCheckin({
      store: store.store,
      listProviderIds: async () => ['buddy'],
      claim: async () => ok({ claimed: 1, totalCredit: 10, coversToday: 1 }),
      now: time.now,
      // delayMs: 0 ⇒ start() 不经过调度器；下面只看 setEnabled 之后是否排了下一轮
      delayMs: 0,
      schedule: (_fn, ms) => { scheduled.push({ ms }); return { cancel: () => {} } },
      warn: () => {},
    })
    await runner.setEnabled(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(scheduled).toHaveLength(1)
    // 到 21:00 的毫秒差（判据是「排到的确实是将来的时段」，不是「排了就算」）
    expect(scheduled[0]!.ms).toBe(utc8MomentMs('2026-10-18', '21:00') - time.now())
  })

  it('★ 渠道被删掉再加回来 ⇒ 旧水位线必须失效（否则当天不再签到，第二轮审计 P3）', async () => {
    // 场景：早上 09:00 跑过（providerSlots.buddy = 今天 09:00）→ 用户把 buddy 的账号
    // 全删了（池里 0 个渠道，这一轮会走 early return）→ 11:00 又把账号加回来。
    // 若旧的 providerSlots.buddy 还在，它会被判成「本轮已处理」而**跳过上游**。
    const time = clock(at('2026-10-18', '09:00'))
    let providers: string[] = []
    const claims: string[] = []
    const store = memoryStore({
      enabled: true,
      times: ['09:00', '21:00'],
      lastSlot: slotKey('2026-10-17', '21:00'),
      providerSlots: { buddy: slotKey('2026-10-18', '09:00') },
    })
    const runner = createAutoCheckin({
      store: store.store,
      listProviderIds: async () => providers,
      claim: async (provider) => { claims.push(provider); return ok({ claimed: 1, totalCredit: 1, coversToday: 1 }) },
      now: time.now,
      delayMs: 1,
      schedule: () => ({ cancel: () => {} }),
      warn: () => {},
    })
    // 池被清空的那一轮：应当把残留的逐渠道水位线清掉并落盘
    await runner.runIfDue()
    expect(store.current().providerSlots).toEqual({})
    // 账号加回来、到 11:00（仍在今天 09:00 那个时段内）⇒ 必须真的打上游
    providers = ['buddy']
    time.set(at('2026-10-18', '11:00'))
    await runner.runIfDue()
    expect(claims, '★ 旧水位线没清 ⇒ 加回来的渠道被判成「已处理」，当天一次都不签到').toEqual(['buddy'])
  })

  it('★ pendingSlot 落后于当前时段 ⇒ 判据改打**新**时段（pending 分支，第二轮审计 P3）', () => {
    // ⚠️ 直接打 `runnableSlotKey`：真机上 `pending≠'' ⇒ lastSlot<pending` 的不变量会让
    //    「pending 落后」这个分支很难走到，但它是**显式的安全网**（重试拖过下一个时段时
    //    必须改打新时段，而不是继续打那个已经无意义的旧时段）。删掉它会零红 ⇒ 这条钉住它。
    const times = ['09:00', '21:00']
    const late = at('2026-10-18', '21:05')
    // 场景：upstream 一直在补昨天 09:00 那个时段，但现在已经 21:05
    expect(runnableSlotKey({
      enabled: true,
      times,
      lastSlot: slotKey('2026-10-17', '21:00'),
      pendingSlot: slotKey('2026-10-18', '09:00'),
    }, late)).toBe(slotKey('2026-10-18', '21:00'))
    // 对照：pending 仍是最新那个时段 ⇒ 就打 pending（补领优先）
    expect(runnableSlotKey({
      enabled: true,
      times,
      lastSlot: slotKey('2026-10-17', '21:00'),
      pendingSlot: slotKey('2026-10-18', '21:00'),
    }, late)).toBe(slotKey('2026-10-18', '21:00'))
  })

  it('★ 补领预算按**时间**算（3 小时窗），覆盖「09:00 被 -120 浮动推到 07:00 等 10:00 刷新」', async () => {
    // 第二轮审计 P2-1：按「14 次」算只有 124 分钟，而最坏需要 180 分钟 ⇒ 当天仍漏领。
    const time = clock(at('2026-10-18', '09:05'))
    let qoderProves = false
    const store = memoryStore({
      enabled: true,
      times: ['09:00', '21:00'],
      lastSlot: slotKey('2026-10-17', '21:00'),
      providerSlots: { buddy: slotKey('2026-10-18', '09:00') },
      pendingSlot: slotKey('2026-10-18', '09:00'),
    })
    const runner = createAutoCheckin({
      store: store.store,
      listProviderIds: async () => ['buddy', 'qoder'],
      claim: async (provider) => (provider === 'qoder'
        ? ok({ alreadyClaimed: 1, coversToday: qoderProves ? 1 : 0 })
        : ok({ claimed: 1, totalCredit: 1, coversToday: 1 })),
      now: time.now,
      delayMs: 1,
      schedule: () => ({ cancel: () => {} }),
      warn: () => {},
    })
    // 09:05：部分完成；buddy 已处理 ⇒ 不会重复打它
    await runner.runIfDue()
    expect(store.current().pendingSlot).toBe(slotKey('2026-10-18', '09:00'))

    // +2h55m（仍 < 3h 窗）：必须继续补领，**不能**放弃
    time.set(at('2026-10-18', '12:00'))
    await runner.runIfDue()
    expect(store.current().pendingSlot, '2 小时 55 分就放弃 ⇒ 覆盖不了 180 分钟的场景')
      .toBe(slotKey('2026-10-18', '09:00'))
    expect(store.current().lastSlot).toBe(slotKey('2026-10-17', '21:00'))

    // +3h05m（超窗）：放弃并把水位线推到该时段，留一行可读结果
    time.set(at('2026-10-18', '12:10'))
    await runner.runIfDue()
    expect(store.current().pendingSlot).toBe('')
    expect(store.current().lastSlot).toBe(slotKey('2026-10-18', '09:00'))
    expect(store.current().lastResult).toContain('放弃补领')
  })
})
