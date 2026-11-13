/**
 * `trae-auth-start-login.spec.ts` —— `TraeAuth.startLogin` 的**返回值透传**守卫。
 *
 * ## 为什么单独一个文件
 *
 * `startLogin` 是「RPC 层 → 登录服务」之间唯一的一跳，它把
 * `startTraeLoginFlow()` 的四个字段（`loginUrl` / `result` / `close` /
 * `submitManualCallback`）原样交出去。其中 `submitManualCallback` 是
 * **类型必填、运行时无校验**的：漏掉它（或写错名）时 TypeScript 只在
 * 「返回类型声明里少一个必填键」时才报错，而**故意改成可选**、
 * 或写成 `submitManualCallback: undefined` 都不会被 tsc 拦住。
 *
 * 后果（PR #58 对抗审计 M9 实测）：RPC 层 `account.submitCallback` 里
 * `pending.submit(callbackUrl)` 变成 `undefined(callbackUrl)`
 * ⇒ 用户粘完回调链接后宿主侧抛
 * `TypeError: pending.submit is not a function` —— 一个网络请求都没发。
 *
 * 而当时的 13 条 RPC 用例全绿：它们把 `auths.trae` 换成了**替身**
 * （`makeAuth('trae')` 自带 `submitManualCallback`），于是
 * `src/trae-auth.ts` 这一跳从未被执行。本文件用 `vi.mock` 把
 * `startTraeLoginFlow` 换成可观测的替身，直接盯这一跳。
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** 登录流程替身交给 `startLogin` 的那个对象（逐字段可观测）。 */
const submitManualCallback = vi.fn((raw: unknown) => ({ ok: true, message: `submitted:${String(raw)}` }))
const close = vi.fn(async () => {})
const startedFlow = {
  loginUrl: 'https://trae.example.test/authorize?client_id=x',
  result: new Promise<never>(() => {}),
  close,
  submitManualCallback,
}

vi.mock('../../src/trae-oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/trae-oauth.js')>()
  return { ...actual, startTraeLoginFlow: vi.fn(async () => startedFlow) }
})

const { TraeAuth } = await import('../../src/trae-auth.js')

const services: InstanceType<typeof TraeAuth>[] = []

afterEach(() => {
  for (const service of services) service.stop()
  services.length = 0
  vi.clearAllMocks()
})

function newService(): InstanceType<typeof TraeAuth> {
  const service = new TraeAuth(new Context(), {})
  services.push(service)
  return service
}

describe('TraeAuth.startLogin（PR #58 对抗审计 M9：返回值透传）', () => {
  it('★★ 必须把 submitManualCallback 透传出去（漏这行 ⇒ RPC 层拿到 undefined ⇒ 用户粘完链接抛 TypeError）', async () => {
    const started = await newService().startLogin({})
    expect(typeof started.submitManualCallback).toBe('function')
    // 必须是**同一个**闭包，而不是包一层新函数（包一层会丢掉 `settledRef`，
    // 幂等闸门随即失效 —— 两次提交会把 `refreshToken` 轮换两次）。
    expect(started.submitManualCallback).toBe(submitManualCallback)
  })

  it('★ 透传后调用必须真的落到登录流程那一份（参数原样、返回值原样）', async () => {
    const started = await newService().startLogin({})
    const outcome = started.submitManualCallback('http://127.0.0.1:18080/authorize?refreshToken=RT-x')
    expect(submitManualCallback).toHaveBeenCalledTimes(1)
    expect(submitManualCallback).toHaveBeenCalledWith('http://127.0.0.1:18080/authorize?refreshToken=RT-x')
    expect(outcome).toEqual({ ok: true, message: 'submitted:http://127.0.0.1:18080/authorize?refreshToken=RT-x' })
  })

  it('★ 其余三个字段也必须原样交出（loginUrl / result / close 一个都不能少）', async () => {
    const started = await newService().startLogin({})
    expect(started.loginUrl).toBe(startedFlow.loginUrl)
    expect(started.close).toBe(close)
    // `result` 被 `.then(persistLogin)` 包过一层 ⇒ 不比身份，只比「是不是 Promise」
    // （包一层是必要的：它负责落库；但不允许变成 undefined）。
    expect(typeof (started.result as unknown as { then?: unknown }).then).toBe('function')
  })
})
