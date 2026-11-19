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

  it('全局默认可以关掉（新中断不再 armed）', () => {
    const { ctx, pool, emitSession } = harness()
    installRateLimitResume(ctx as never, pool as never)
    expect(setRateLimitResumeEnabled(false)).toBe(false)
    emitSession(session, rateLimitTurnEnd(raccoonMessageAt(Date.now() + 30 * 60 * 1000)))
    expect(readRateLimitResumeState('session-a').hooks[0]!.armed).toBe(false)
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
