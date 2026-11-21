/**
 * 「限流中断 → 解禁后自动继续」的**行为级**守卫。
 *
 * 这里守的三件事都是**真机上出过**的缺陷（见 `src/rate-limit-resume.ts` 模块头）：
 * 1. 解禁时刻必须**记录那一刻**就算出来（providers-hub 从不填 `providerRetryAfterMs`，
 *    只靠它会让「18 分钟后解禁」被排到 1 小时后 ⇒ 按钮有、就是不继续）；
 * 2. 会话不在内存里**不得**丢钩子（等一小时必然跨宿主重启）；
 * 3. 只有**人类**输入才撤钩子（`runtime-context` / `dsh-memory` / `skill-catalog`
 *    等注入同样以 `user/message` 落盘）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FALLBACK_WAIT_MS,
  RATE_LIMIT_RESUME_FILE,
  classifyRateLimitFailure,
  createRateLimitResumeEngine,
  installRateLimitResume,
  rateLimitResumeEnabled,
  readRateLimitResumeState,
  resolveUnlockAt,
  setRateLimitResumeEnabled,
  unlockAtFromText,
} from '../../src/rate-limit-resume.js'

/** 真机原文（Raccoon / CodeBuddy 两种文案，逐字取自会话日志）。 */
const RACCOON_MESSAGE = 'Raccoon (商汤)：模型 sn-deepseek-v4-1-flash-1017 的可用账号均在限流中，'
  + '最近一个将于 2026/11/19 18:25:51 解禁。可改用其它 provider / 模型，或等待解禁后再试（无需重新登录）。'
const BUDDY_MESSAGE = 'buddy: 模型 deepseek-v4.1-flash 所有账号均受限，请稍后再试'

describe('classifyRateLimitFailure', () => {
  it('认号池全限流（QUOTA_EXCEEDED + 文案里带「限流」）', () => {
    expect(classifyRateLimitFailure({ code: 'QUOTA_EXCEEDED', message: RACCOON_MESSAGE })).toBe('rate')
  })

  it('认「所有账号均受限」（buddy 形态）', () => {
    expect(classifyRateLimitFailure({ code: 'QUOTA_EXCEEDED', message: BUDDY_MESSAGE })).toBe('rate')
  })

  it('认结构化码与 429', () => {
    expect(classifyRateLimitFailure({ code: 'RATE_LIMIT', message: '429' })).toBe('rate')
    expect(classifyRateLimitFailure({ code: 'SOMETHING', status: 429 })).toBe('rate')
  })

  it('额度类（没有「限流」二字）归 quota，而不是 rate', () => {
    expect(classifyRateLimitFailure({ code: 'QUOTA_EXCEEDED', message: 'trae: 积分不足' })).toBe('quota')
    expect(classifyRateLimitFailure({ code: 'QUOTA', message: 'credits exhausted' })).toBe('quota')
  })

  it('无关失败一律不认', () => {
    expect(classifyRateLimitFailure({ code: 'AUTH', message: 'API 密钥无效' })).toBeUndefined()
    expect(classifyRateLimitFailure({ code: 'TRANSPORT', message: 'fetch failed' })).toBeUndefined()
    expect(classifyRateLimitFailure(undefined)).toBeUndefined()
    expect(classifyRateLimitFailure('QUOTA_EXCEEDED')).toBeUndefined()
  })
})

describe('unlockAtFromText', () => {
  it('从真机文案里读出解禁时刻（本地时区）', () => {
    const at = unlockAtFromText(RACCOON_MESSAGE)
    expect(at).toBeDefined()
    const parsed = new Date(at!)
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(10) // 11 月
    expect(parsed.getDate()).toBe(19)
    expect(parsed.getHours()).toBe(18)
    expect(parsed.getMinutes()).toBe(25)
    expect(parsed.getSeconds()).toBe(51)
  })

  it('必须锚定「将于 … 解禁」整句 —— 文案里别的日期不算', () => {
    // 资源包到期日之类：没有「将于 / 解禁」夹住，绝不能吃进来。
    expect(unlockAtFromText('账号将于 2027/01/02 03:04:05 到期，请续费')).toBeUndefined()
    expect(unlockAtFromText('2026/11/19 18:25:51')).toBeUndefined()
    expect(unlockAtFromText('')).toBeUndefined()
  })
})

describe('resolveUnlockAt', () => {
  const now = Date.parse('2026-11-19T10:07:25Z')

  it('文案里的解禁时刻优先于 1 小时兜底（真缺陷回归）', () => {
    const resolved = resolveUnlockAt({ failure: { code: 'QUOTA_EXCEEDED', message: RACCOON_MESSAGE }, now })
    expect(resolved.source).toBe('text')
    // 必须**早于**兜底的 1 小时，否则就是那个「按钮有、就是不继续」的缺陷。
    expect(resolved.at).toBeLessThan(now + FALLBACK_WAIT_MS)
  })

  it('服务端 retry-after 与文案同时存在时取最早那条', () => {
    const resolved = resolveUnlockAt({
      failure: { code: 'RATE_LIMIT', message: RACCOON_MESSAGE, providerRetryAfterMs: 60_000 },
      now,
    })
    expect(resolved.source).toBe('retry-after')
    expect(resolved.at).toBe(now + 60_000)
  })

  it('三条来源都没有时退到兜底', () => {
    const resolved = resolveUnlockAt({ failure: { code: 'RATE_LIMIT', message: 'too many requests' }, now })
    expect(resolved.source).toBe('fallback')
    expect(resolved.at).toBe(now + FALLBACK_WAIT_MS)
  })

  it('号池给的是过去时刻 ⇒ 不采用（交给兜底）', () => {
    const resolved = resolveUnlockAt({ failure: { code: 'RATE_LIMIT', message: 'x' }, now, poolResetAt: now - 1 })
    expect(resolved.source).toBe('fallback')
  })
})

describe('rateLimitResumeEnabled', () => {
  it('默认开启，只有显式假值才算关', () => {
    expect(rateLimitResumeEnabled({})).toBe(true)
    expect(rateLimitResumeEnabled({ DSH_RATE_LIMIT_RESUME: '' })).toBe(true)
    expect(rateLimitResumeEnabled({ DSH_RATE_LIMIT_RESUME: '1' })).toBe(true)
    expect(rateLimitResumeEnabled({ DSH_RATE_LIMIT_RESUME: '0' })).toBe(false)
    expect(rateLimitResumeEnabled({ DSH_RATE_LIMIT_RESUME: 'off' })).toBe(false)
    expect(rateLimitResumeEnabled({ DSH_RATE_LIMIT_RESUME: 'NO' })).toBe(false)
  })
})

describe('createRateLimitResumeEngine', () => {
  let clock: number
  let timers: Array<{ at: number; task: () => void; id: number }>
  let nextId: number

  beforeEach(() => {
    clock = Date.parse('2026-11-19T10:07:25Z')
    timers = []
    nextId = 1
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function engineWith(overrides: Partial<Parameters<typeof createRateLimitResumeEngine>[0]> = {}) {
    return createRateLimitResumeEngine({
      now: () => clock,
      schedule: (task, delayMs) => {
        const id = nextId++
        timers.push({ at: clock + delayMs, task, id })
        return id
      },
      cancel: (handle) => { timers = timers.filter(timer => timer.id !== handle) },
      ...overrides,
    })
  }

  /** 把时钟推进到目标时刻，并执行所有到点的定时器。 */
  function advanceTo(at: number): void {
    clock = at
    for (const timer of [...timers].sort((left, right) => left.at - right.at)) {
      if (timer.at > clock) continue
      timers = timers.filter(candidate => candidate !== timer)
      timer.task()
    }
  }

  it('按文案里的解禁时刻排定时器（不是 1 小时后）', () => {
    const deliver = vi.fn(() => ({ ok: true as const }))
    const engine = engineWith({ deliver })
    engine.noteInterruption({
      sessionId: 'session-a',
      turn: 37,
      provider: 'raccoon',
      model: 'sn-deepseek-v4-1-flash-1017',
      kind: 'rate',
      failure: { code: 'QUOTA_EXCEEDED', message: RACCOON_MESSAGE },
    })
    expect(timers).toHaveLength(1)
    const unlockAt = unlockAtFromText(RACCOON_MESSAGE)!
    expect(timers[0]!.at).toBe(unlockAt)
    expect(timers[0]!.at).toBeLessThan(clock + FALLBACK_WAIT_MS)

    advanceTo(unlockAt)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]![0]).toMatchObject({ sessionId: 'session-a', turn: 37 })
    // 成功投递后钩子必须消失（按钮据此收掉）。
    expect(engine.status().hooks).toHaveLength(0)
  })

  it('号池仍未解禁 ⇒ 顺延，不投递', () => {
    const deliver = vi.fn(() => ({ ok: true as const }))
    const later = Date.parse('2026-11-19T20:00:00Z')
    const engine = engineWith({ deliver, readPoolReset: () => later })
    engine.noteInterruption({
      sessionId: 'session-a',
      turn: 1,
      provider: 'raccoon',
      model: 'm',
      kind: 'rate',
      failure: { code: 'RATE_LIMIT', message: 'too many requests' },
    })
    advanceTo(clock + FALLBACK_WAIT_MS)
    expect(deliver).not.toHaveBeenCalled()
    expect(engine.status().hooks[0]!.resetAtMs).toBe(later)
  })

  it('会话不在内存 ⇒ 留钩子并重试（真缺陷回归：不丢）', () => {
    const deliver = vi.fn(() => ({ ok: false as const, reason: '会话不在内存' }))
    const engine = engineWith({ deliver })
    engine.noteInterruption({
      sessionId: 'session-a',
      turn: 1,
      provider: 'raccoon',
      model: 'm',
      kind: 'rate',
      failure: { code: 'RATE_LIMIT', message: 'too many requests' },
    })
    const first = engine.status().hooks
    expect(first).toHaveLength(1)
    advanceTo(clock + FALLBACK_WAIT_MS)
    expect(deliver).toHaveBeenCalledTimes(1)
    // ⚠️ 关键：钩子必须还在（旧实现这里直接放弃）。
    expect(engine.status().hooks).toHaveLength(1)
    expect(engine.status().hooks[0]!.deferrals).toBe(1)
  })

  it('会话重新 live 时立刻补发（用户一打开就续上）', () => {
    let live = false
    const deliver = vi.fn(() => (live ? { ok: true as const } : { ok: false as const, reason: '会话不在内存' }))
    const engine = engineWith({ deliver })
    engine.noteInterruption({
      sessionId: 'session-a',
      turn: 1,
      provider: 'raccoon',
      model: 'm',
      kind: 'rate',
      failure: { code: 'RATE_LIMIT', message: 'too many requests' },
    })
    advanceTo(clock + FALLBACK_WAIT_MS)
    expect(deliver).toHaveBeenCalledTimes(1)
    live = true
    engine.noteAgentLive('session-a')
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(engine.status().hooks).toHaveLength(0)
  })

  it('人类发言撤钩子；切 armed 不追溯已有钩子的默认值语义', () => {
    const engine = engineWith()
    engine.noteInterruption({
      sessionId: 'session-a',
      turn: 1,
      provider: 'raccoon',
      model: 'm',
      kind: 'rate',
      failure: { code: 'RATE_LIMIT', message: 'too many requests' },
    })
    expect(engine.setArmed('session-a', false)).toMatchObject({ armed: false })
    expect(engine.status().hooks[0]!.armed).toBe(false)
    engine.noteUserMessage('session-a')
    expect(engine.status().hooks).toHaveLength(0)
  })

  it('落盘文档可恢复（跨进程接着等）', () => {
    const saved: unknown[] = []
    const engine = engineWith({ persist: (hooks) => { saved.splice(0, saved.length, ...hooks) } })
    engine.noteInterruption({
      sessionId: 'session-a',
      turn: 9,
      provider: 'raccoon',
      model: 'm',
      kind: 'rate',
      failure: { code: 'RATE_LIMIT', message: 'too many requests' },
    })
    expect(saved).toHaveLength(1)

    const restored = engineWith()
    restored.restore(saved)
    expect(restored.status().hooks[0]).toMatchObject({ sessionId: 'session-a', turn: 9 })
  })

/**
 * ★★★ **跨钩子的寿命上限**（2026-11-21 对抗审计 P0）。
 *
 * ## 这个缺口是什么
 *
 * `MAX_DEFERRALS = 48` 只在**单个钩子内部**对「投递失败 / 号池顺延」计数，
 * 而**成功投递会 `drop(hook)`** ⇒ 下一轮再被限流时建的是**新钩子**、
 * `deferrals` 从 0 重来 ⇒ 「限流 → 解禁 → 继续 → 又限流」**没有寿命上限**。
 *
 * 审计实测（engine 级）：连续 100 轮，`deliver` 被调 **100 次**、每轮
 * `deferrals` 都是 0；接线级最快 **12 次/分钟**；`quota`（积分耗尽、
 * 等多久都不会好）同样每小时重试、**永不放弃**。
 *
 * ⚠️ **这是我自己写错的地方**：我在 PR #131 的评论里写过「MAX_DEFERRALS=48
 * 在两条路径都检查 ⇒ 不存在无限循环」—— 那个结论只看了单钩子，是错的。
 * 这组用例就是为了让那条错误结论**不可能再被写出来**。
 */
describe('★★★ 跨钩子寿命上限（P0：限流→解禁→继续→又限流 必须有上界）', () => {
  it('★★★ rate 类：连续限流 10 轮，自动续跑**最多 3 次**', () => {
    const calls: string[] = []
    const engine = engineWith({
      deliver: () => { calls.push('resume'); return { ok: true } },
    })
    // 每轮：记录中断 → 时钟跨过解禁时刻 ⇒ 定时器到点投递成功 ⇒ drop ⇒ 下一轮建新钩子
    for (let i = 0; i < 10; i++) {
      engine.noteInterruption({
        sessionId: 's1', turn: i + 1, provider: 'p', model: 'm', kind: 'rate',
        failure: { code: 'RATE_LIMIT', message: '429' },
      })
      advanceTo(clock + 3 * 60 * 60 * 1000)
    }
    expect(calls.length, 'rate 类续跑必须有上界（3 次），否则无限循环').toBe(3)
  })

  it('★★★ quota 类：只给 **1** 次（额度不会因为等待而恢复）', () => {
    const calls: string[] = []
    const engine = engineWith({
      deliver: () => { calls.push('resume'); return { ok: true } },
    })
    for (let i = 0; i < 5; i++) {
      engine.noteInterruption({
        sessionId: 's2', turn: i + 1, provider: 'p', model: 'm', kind: 'quota',
        failure: { code: 'QUOTA', message: '积分不足' },
      })
      advanceTo(clock + 3 * 60 * 60 * 1000)
    }
    expect(calls.length, 'quota 类续跑必须有上界（1 次）').toBe(1)
  })

  it('★★ 用户手动发言 ⇒ 计数清零（那是「用户回来了」，不是继续消耗自动额度）', () => {
    const calls: string[] = []
    const engine = engineWith({
      deliver: () => { calls.push('resume'); return { ok: true } },
    })
    // 先用掉 rate 类的 3 次额度
    for (let i = 0; i < 5; i++) {
      engine.noteInterruption({
        sessionId: 's3', turn: i + 1, provider: 'p', model: 'm', kind: 'rate',
        failure: { code: 'RATE_LIMIT', message: '429' },
      })
      advanceTo(clock + 3 * 60 * 60 * 1000)
    }
    expect(calls.length).toBe(3)
    // 用户回来说了句话 ⇒ 计数清零，可以再自动续跑
    engine.noteUserMessage('s3')
    engine.noteInterruption({
      sessionId: 's3', turn: 99, provider: 'p', model: 'm', kind: 'rate',
      failure: { code: 'RATE_LIMIT', message: '429' },
    })
    advanceTo(clock + 3 * 60 * 60 * 1000)
    expect(calls.length, '用户发言后应能再续一次').toBe(4)
  })

  it('★★ 计数**落盘**：重启（新引擎 restore）不得绕过上限', () => {
    const persisted: Array<{ hooks: unknown; resumes: unknown }> = []
    const engine = engineWith({
      deliver: () => ({ ok: true }),
      persist: (hooks, _enabled, resumes) => { persisted.push({ hooks, resumes }) },
    })
    for (let i = 0; i < 5; i++) {
      engine.noteInterruption({
        sessionId: 's4', turn: i + 1, provider: 'p', model: 'm', kind: 'rate',
        failure: { code: 'RATE_LIMIT', message: '429' },
      })
      advanceTo(clock + 3 * 60 * 60 * 1000)
    }
    const last = persisted[persisted.length - 1]
    expect(last?.resumes, '续跑计数必须出现在落盘数据里').toEqual({ s4: 3 })

    // 模拟重启：新引擎 restore 同一份计数
    const calls: string[] = []
    const revived = engineWith({
      deliver: () => { calls.push('resume'); return { ok: true } },
    })
    revived.restore([], { s4: 3 })
    revived.noteInterruption({
      sessionId: 's4', turn: 1, provider: 'p', model: 'm', kind: 'rate',
      failure: { code: 'RATE_LIMIT', message: '429' },
    })
    advanceTo(clock + 3 * 60 * 60 * 1000)
    expect(calls, '重启不得成为绕过上限的后门').toEqual([])
  })

  /**
   * ★★★ **重开总开关不得撤销「逐个关闭」**（对抗审计 P1，2026-11-21）。
   *
   * 我上一版 `setEnabled` 写的是 `hook.armed = enabled` —— 一锅端。后果：
   * 用户在列表里把某个会话关掉（`hook.armed=false`）之后，只要重新打开总开关，
   * 它就被**一起打开**（审计实测 deliveries=2）。那等于替他撤销了「这一个别动」。
   * ⇒ `userEnabled`（全局）与 `hook.armed`（逐会话）是两个维度，只能取与。
   */
  it('★★★ 重开总开关不得把用户逐个关掉的会话重新武装', () => {
    const calls: string[] = []
    const engine = engineWith({ deliver: () => { calls.push('resume'); return { ok: true } } })
    engine.noteInterruption({
      sessionId: 'a', turn: 1, provider: 'p', model: 'm', kind: 'rate',
      failure: { code: 'RATE_LIMIT', message: '429' },
    })
    engine.noteInterruption({
      sessionId: 'b', turn: 1, provider: 'p', model: 'm', kind: 'rate',
      failure: { code: 'RATE_LIMIT', message: '429' },
    })
    // 用户单独关掉 b
    engine.setArmed('b', false)
    // 关总开关再开回来（模拟用户「先全关、再全开」的操作节奏）
    engine.setEnabled(false)
    engine.setEnabled(true)
    advanceTo(clock + 3 * 60 * 60 * 1000)
    expect(calls, '被逐个关掉的 b 不得因重开总开关而被重新武装').toEqual(['resume'])
  })

  it('★★★ `lockedOff`（env 硬闸门）下界面开不起来', () => {
    const calls: string[] = []
    const engine = engineWith({
      lockedOff: true,
      deliver: () => { calls.push('resume'); return { ok: true } },
    })
    engine.noteInterruption({
      sessionId: 'z', turn: 1, provider: 'p', model: 'm', kind: 'rate',
      failure: { code: 'RATE_LIMIT', message: '429' },
    })
    expect(engine.setEnabled(true), 'env 关着时 setEnabled(true) 必须返回 false（生效值）').toBe(false)
    advanceTo(clock + 3 * 60 * 60 * 1000)
    expect(calls, 'env=DSH_RATE_LIMIT_RESUME=0 时界面不得越过它').toEqual([])
  })

  /**
   * ★★ **结构化码不得被文案正则掩码**（对抗审计：删掉整条 `RATE_CODES` 仍 22/22 绿）。
   *
   * 原用例写的是 `{ code: 'RATE_LIMIT', message: '429' }` —— message 里的 `429`
   * 同样命中 `RATE_TEXT`，于是**删掉码判据也照样通过**。判据必须让其它腿不足以
   * 挡住它（本仓库记过同型教训：zcode 的 `action.type` 那次）。
   */
  it('★★ 结构化码 `RATE_LIMITED` / `TOO_MANY_REQUESTS` 必须**单独**生效（无文案辅助）', () => {
    expect(classifyRateLimitFailure({ code: 'RATE_LIMITED', message: 'opaque' })).toBe('rate')
    expect(classifyRateLimitFailure({ code: 'TOO_MANY_REQUESTS', message: 'opaque' })).toBe('rate')
    // 反向：文案与状态码都不帮忙 ⇒ 必须是 undefined（不是 rate）
    expect(classifyRateLimitFailure({ code: 'SOMETHING', message: 'opaque' })).toBeUndefined()
  })

})

/**
 * ★★★ **全局开关必须管住落盘的已武装钩子**（对抗审计 P1）。
 *
 * 原实现 `armed: raw.armed !== false` 完全忽略引擎的 `enabled` ⇒ 用户明确设了
 * `DSH_RATE_LIMIT_RESUME=0` 之后，重启时落盘里 `armed: true` 的钩子照样被武装、
 * 到点照样发请求。审计实测：env=0 + 落盘 armed:true ⇒ 仍然 followup。
 */
describe('★★★ 全局开关管住落盘的 armed 钩子（P1）', () => {
  it('★★★ **运行时**关掉开关 ⇒ 已挂着的钩子立刻不再投递', () => {
    /**
     * 审计 PROBE-A4：关掉开关之后，**已经挂上定时器的钩子仍会 fired 一次**。
     * 只改布尔不追溯 = 用户说的「现在别动我的会话」没有被执行。
     */
    const calls: string[] = []
    const engine = engineWith({
      deliver: () => { calls.push('resume'); return { ok: true } },
    })
    engine.noteInterruption({
      sessionId: 's8', turn: 1, provider: 'p', model: 'm', kind: 'rate',
      failure: { code: 'RATE_LIMIT', message: '429' },
    })
    // 此刻钩子已武装并有定时器
    engine.setEnabled(false)
    advanceTo(clock + 3 * 60 * 60 * 1000)
    expect(calls, '运行时关掉开关后，已挂着的钩子不得再投递').toEqual([])

    // 重新打开 ⇒ 钩子还在（开关只管「要不要自动做」，不该丢掉「待续跑」这个事实）
    engine.setEnabled(true)
    advanceTo(clock + 6 * 60 * 60 * 1000)
    expect(calls, '重新打开后应恢复投递').toEqual(['resume'])
  })

  it('★★★ `enabled: false` ⇒ restore 后不得投递', () => {
    const calls: string[] = []
    const engine = engineWith({
      enabled: false,
      deliver: () => { calls.push('resume'); return { ok: true } },
    })
    engine.restore([{
      sessionId: 's9',
      turn: 1,
      provider: 'p',
      model: 'm',
      kind: 'rate',
      resetAtMs: clock + 60_000,
      unlockAtMs: clock + 60_000,
      armed: true,
    }])
    advanceTo(clock + 3 * 60 * 60 * 1000)
    expect(calls, '全局关闭时，落盘里的 armed:true 也不得触发投递').toEqual([])
  })
})
})

describe('installRateLimitResume', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-rate-limit-resume-'))
    previous = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = dir
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
    else process.env.DSH_JET_HUB_STATE_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })

  /** 造一个够用的假 ctx / pool / agents 作用域。 */
  function harness(options: {
    readonly followup?: (message: unknown) => void
    readonly live?: boolean
  } = {}) {
    const listeners = new Map<string, Array<(payload: never) => void>>()
    const sessionListeners: Array<(session: unknown, event: unknown) => void> = []
    const agentListeners = new Map<string, Array<(payload: { agent: { id: string } }) => void>>()
    let live = options.live !== false
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      on(name: string, listener: unknown) {
        if (name === 'session/event') sessionListeners.push(listener as never)
        listeners.set(name, [...(listeners.get(name) ?? []), listener as never])
        return () => {}
      },
      inject(_deps: string[], callback: (scope: unknown) => void) {
        callback({
          agents: {
            get: (id: string) => (live ? { id, followup: options.followup ?? (() => {}) } : undefined),
            withoutInitiator: <T,>(operation: () => T) => operation(),
          },
          on(name: string, listener: (payload: { agent: { id: string } }) => void) {
            agentListeners.set(name, [...(agentListeners.get(name) ?? []), listener])
            return () => {}
          },
        })
      },
      effect(_fn: () => () => void) {},
      get: () => undefined,
    }
    const pool = {
      listAccountsByProvider: () => [
        { enabled: true, modelRateLimits: { m: Date.parse('2026-11-19T10:25:51Z') } },
      ],
    }
    const emitSession = (session: unknown, event: unknown) => {
      for (const listener of sessionListeners) listener(session, event)
    }
    const emitAgent = (name: string, agentId: string) => {
      for (const listener of agentListeners.get(name) ?? []) listener({ agent: { id: agentId } })
    }
    return { ctx, pool, emitSession, emitAgent, setLive: (value: boolean) => { live = value } }
  }

  const session = { id: 'session-a', requestHeader: () => ({ config: { provider: 'raccoon', model: 'm' } }) }

  /** 造一条「将于 <at> 解禁」的真机同形文案（时间按本地时区写）。 */
  function raccoonMessageAt(at: number): string {
    const d = new Date(at)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `Raccoon (商汤)：模型 m 的可用账号均在限流中，最近一个将于 `
      + `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} 解禁。`
      + '可改用其它 provider / 模型，或等待解禁后再试（无需重新登录）。'
  }

  function rateLimitTurnEnd(message: string = RACCOON_MESSAGE) {
    return {
      type: 'turn/end',
      data: { turn: 37, reason: { kind: 'error', error: { code: 'QUOTA_EXCEEDED', message } } },
    }
  }

  it('turn/end 限流 ⇒ 记钩子并落盘到 jet-hub 目录', async () => {
    const { ctx, pool, emitSession } = harness()
    installRateLimitResume(ctx as never, pool as never)
    const unlockAt = Date.now() + 30 * 60 * 1000
    const message = raccoonMessageAt(unlockAt)
    emitSession(session, rateLimitTurnEnd(message))
    const state = readRateLimitResumeState('session-a')
    expect(state.available).toBe(true)
    expect(state.hooks).toHaveLength(1)
    // ⚠️ 真缺陷回归：解禁时刻必须是文案里那个（约 30 分钟后），不是「1 小时后」。
    expect(state.hooks[0]!.unlockAtMs).toBe(unlockAtFromText(message))
    const { readFileSync } = await import('node:fs')
    const doc = JSON.parse(readFileSync(join(dir, 'jet-hub', RATE_LIMIT_RESUME_FILE), 'utf-8'))
    expect(doc.hooks).toHaveLength(1)
    expect(doc.hooks[0].unlockAtMs).toBe(unlockAtFromText(message))
    expect(doc.enabled).toBe(true)
  })

  it('全局默认可以关掉（生效值变 false）', () => {
    const { ctx, pool, emitSession } = harness()
    installRateLimitResume(ctx as never, pool as never)
    expect(setRateLimitResumeEnabled(false)).toBe(false)
    emitSession(session, rateLimitTurnEnd(raccoonMessageAt(Date.now() + 30 * 60 * 1000)))
    /**
     * ⚠️ **语义变更（2026-11-21 对抗审计 P1 修复的必然结果）**：
     * `hook.armed` 的含义已从「**生效**是否自动继续」改成「**用户对该会话的意图**」，
     * 全局开关由 `state.enabled`（= `!lockedOff && userEnabled`）单独表达，两者取与。
     *
     * 为什么要拆：原先 `setEnabled` 写 `hook.armed = enabled`，用户逐个关掉的会话
     * 会在**重开总开关**时被一起打开（实测 deliveries=2）—— 等于替他撤销了
     * 「这一个别动」的决定。拆开后「全局关掉」不再改写用户意图。
     */
    expect(readRateLimitResumeState('session-a').hooks[0]!.armed, '用户意图仍是「要续跑」').toBe(true)
    expect(readRateLimitResumeState('session-a').enabled, '但全局生效值是 false').toBe(false)
  })

  it('注入类 user/message 不撤钩子，人类发言才撤（真缺陷回归）', () => {
    const { ctx, pool, emitSession } = harness()
    installRateLimitResume(ctx as never, pool as never)
    emitSession(session, rateLimitTurnEnd(raccoonMessageAt(Date.now() + 30 * 60 * 1000)))
    expect(readRateLimitResumeState('session-a').hooks).toHaveLength(1)

    // DSH 里这些注入全部以 user/message 落盘（实测一个会话几百条）。
    for (const kind of ['runtime-context', 'dsh-memory', 'skill-catalog', 'agent-instructions', 'tool-jobs']) {
      emitSession(session, { type: 'user/message', data: { source: { kind } } })
      expect(readRateLimitResumeState('session-a').hooks, `${kind} 不该撤钩子`).toHaveLength(1)
    }

    emitSession(session, { type: 'user/message', data: { source: { kind: 'user' } } })
    expect(readRateLimitResumeState('session-a').hooks).toHaveLength(0)
  })

  it('会话不在内存时不丢钩子；重新 live 时补发', async () => {
    vi.useFakeTimers()
    try {
      const followup = vi.fn()
      const { ctx, pool, emitSession, emitAgent, setLive } = harness({ followup, live: false })
      installRateLimitResume(ctx as never, pool as never)
      const unlockAt = Date.now() + 30 * 60 * 1000
      emitSession(session, rateLimitTurnEnd(raccoonMessageAt(unlockAt)))
      expect(readRateLimitResumeState('session-a').hooks).toHaveLength(1)

      // 到解禁时刻：deliver 拿不到 live agent ⇒ 钩子必须还在（旧实现这里放弃）。
      await vi.advanceTimersByTimeAsync(unlockAt - Date.now() + 2000)
      expect(readRateLimitResumeState('session-a').hooks).toHaveLength(1)

      // 用户打开会话 ⇒ 立刻补发，而不是等 2 分钟后的重试定时器。
      setLive(true)
      emitAgent('agent/created', 'session-a')
      expect(followup).toHaveBeenCalledTimes(1)
      expect(readRateLimitResumeState('session-a').hooks).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
