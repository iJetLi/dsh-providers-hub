import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireQoderRequest, qoderTrafficGuardEnabled } from '../../src/qoder-traffic-guard.js'

/**
 * `src/qoder-traffic-guard.ts` 的纯函数单测（PR #79 审计补）。
 *
 * ## 为什么这个文件必须存在
 *
 * PR #79 只给了**接线**用例（`tests/unit/qoder-adapter.spec.ts` 的
 * `describe('Qoder 单账号并发限制')` 两条：流未结束时第二个请求被拒 + 间隔 ≥390ms）。
 * 那两条守的是「装配对没对」，守不住**模块本身**的这几条：
 * 清理循环、`-Infinity` 初值、`Symbol.dispose` 幂等、已 abort 的 signal、
 * `DSH_QODER_TRAFFIC_GUARD` 的四种关闭写法、两个渠道的键隔离。
 *
 * ## 测试隔离：必须用**唯一 uid**
 *
 * `accounts` 是**模块级** `Map`，同一进程内所有用例共享。若两条用例用同一个
 * `uid`，前一条留下的 `active` / `lastDispatch` 会让后一条的行为取决于**执行顺序**
 * —— 那是最难查的一类 flaky。⇒ 每条用例用独立 uid。
 */

/** 每条用例的 uid 计数器（保证跨用例不串台）。 */
let uidCounter = 0
function nextUid(): string {
  uidCounter += 1
  return `guard-spec-${uidCounter}`
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('qoderTrafficGuardEnabled：环境变量的四种关闭写法', () => {
  it.each(['0', 'off', 'false', 'OFF', 'False', '  off  '])('★ %j 视为关闭', (raw) => {
    vi.stubEnv('DSH_QODER_TRAFFIC_GUARD', raw)
    expect(qoderTrafficGuardEnabled()).toBe(false)
  })

  it.each(['', '1', 'on', 'true', 'yes', 'disabled'])('★ %j 视为开启（默认开）', (raw) => {
    vi.stubEnv('DSH_QODER_TRAFFIC_GUARD', raw)
    expect(qoderTrafficGuardEnabled()).toBe(true)
  })

  it('未设置时默认开启（PR 的承诺：默认开启）', () => {
    vi.stubEnv('DSH_QODER_TRAFFIC_GUARD', '')
    // `stubEnv(..., '')` 等价于「空串」；真正未设置用 delete。
    vi.unstubAllEnvs()
    delete process.env.DSH_QODER_TRAFFIC_GUARD
    expect(qoderTrafficGuardEnabled()).toBe(true)
  })
})

describe('acquireQoderRequest：并发闸门', () => {
  it('★★★ 同一账号第二条必须被拒绝（不是排队）', async () => {
    const uid = nextUid()
    const first = await acquireQoderRequest('qoder', uid)
    try {
      await expect(acquireQoderRequest('qoder', uid)).rejects.toMatchObject({
        code: 'QUEUE',
        message: expect.stringContaining('本地账号并发已满'),
      })
    } finally {
      ;(first as Disposable)[Symbol.dispose]()
    }
  })

  it('★★★ 释放后同一账号可再次取得（不会永久锁死）', async () => {
    const uid = nextUid()
    const first = await acquireQoderRequest('qoder', uid)
    ;(first as Disposable)[Symbol.dispose]()
    // 400ms 间隔由下一条用例单独守；这里只关心「能再取到」。
    const second = await acquireQoderRequest('qoder', uid)
    expect(second).toBeDefined()
    ;(second as Disposable)[Symbol.dispose]()
  })

  it('★★★ 不同 provider 的键互相独立（qoder vs qodercn）', async () => {
    const uid = nextUid()
    const a = await acquireQoderRequest('qoder', uid)
    const b = await acquireQoderRequest('qodercn', uid)
    expect(b).toBeDefined()
    ;(a as Disposable)[Symbol.dispose]()
    ;(b as Disposable)[Symbol.dispose]()
  })

  it('★★ 不同 uid 互相独立（不会因为别人的请求被拒）', async () => {
    const a = await acquireQoderRequest('qoder', nextUid())
    const b = await acquireQoderRequest('qoder', nextUid())
    expect(b).toBeDefined()
    ;(a as Disposable)[Symbol.dispose]()
    ;(b as Disposable)[Symbol.dispose]()
  })
})

describe('acquireQoderRequest：400ms 间隔', () => {
  it('★★★ 释放后立刻再取，必须等满间隔（≥390ms 容差）', async () => {
    const uid = nextUid()
    const t0 = performance.now()
    const first = await acquireQoderRequest('qoder', uid)
    ;(first as Disposable)[Symbol.dispose]()
    const second = await acquireQoderRequest('qoder', uid)
    const elapsed = performance.now() - t0
    ;(second as Disposable)[Symbol.dispose]()
    expect(elapsed, `背靠背两次取的耗时 ${elapsed.toFixed(1)}ms 未达间隔`).toBeGreaterThanOrEqual(390)
  })

  it('★★ 首次获取**不**等待（`lastDispatch` 初值 `-Infinity`）', async () => {
    const t0 = performance.now()
    const slot = await acquireQoderRequest('qoder', nextUid())
    const elapsed = performance.now() - t0
    ;(slot as Disposable)[Symbol.dispose]()
    expect(elapsed, '首次获取就等待了 ⇒ 初值不是 -Infinity').toBeLessThan(200)
  })
})

describe('acquireQoderRequest：abort 与 dispose', () => {
  it('★★★ 已 abort 的 signal 必须直接抛，且**不留下** active 名额', async () => {
    const uid = nextUid()
    const controller = new AbortController()
    controller.abort()
    await expect(acquireQoderRequest('qoder', uid, controller.signal)).rejects.toThrow()
    // 关键：被 abort 的那次不能把名额占住（否则该账号永久不可用）。
    const slot = await acquireQoderRequest('qoder', uid)
    expect(slot).toBeDefined()
    ;(slot as Disposable)[Symbol.dispose]()
  })

  it('★★★ 等待间隔**期间**被 abort ⇒ 名额必须释放（否则该账号永久不可用）', async () => {
    const uid = nextUid()
    // 先占一次再释放，让下一次必然进入 `await sleep(...)`（400ms 间隔）。
    const warm = await acquireQoderRequest('qoder', uid)
    ;(warm as Disposable)[Symbol.dispose]()

    const controller = new AbortController()
    const pending = acquireQoderRequest('qoder', uid, controller.signal)
    // 在 sleep 里 aborted ⇒ 走 `catch` 分支（这一格是上面「已 abort」用例覆盖不到的：
    // 那条在 `throwIfAborted()` 第一行就抛了，根本没进 try）。
    setTimeout(() => { controller.abort() }, 50)
    await expect(pending).rejects.toThrow()

    // 关键断言：`catch` 里必须 release，否则这条会抛 QUEUE 而挂住整个账号。
    const slot = await acquireQoderRequest('qoder', uid)
    expect(slot, '等待期间被 abort 后名额没释放 ⇒ 该账号此后永远取不到').toBeDefined()
    ;(slot as Disposable)[Symbol.dispose]()
  })

  it('旧名额重复释放时，新请求仍独占账号名额', async () => {
    const uid = nextUid()
    const first = await acquireQoderRequest('qoder', uid)
    first[Symbol.dispose]()
    using second = await acquireQoderRequest('qoder', uid)
    first[Symbol.dispose]()

    // 首个请求退出时，第二个请求已持有名额，第三个请求仍须被拒。
    const result = await acquireQoderRequest('qoder', uid).then(
      (slot) => {
        slot[Symbol.dispose]()
        return undefined
      },
      (error: unknown) => error,
    )
    expect(result).toMatchObject({ code: 'QUEUE' })
  })
})
