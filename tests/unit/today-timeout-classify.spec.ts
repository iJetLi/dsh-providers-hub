/**
 * ★★★ **`TimeoutError` 必须归 `timeout`、绝不换号烧池**（PR #189 对抗审计 M4b 无牙点）。
 *
 * ## 为什么要单独守这一格
 *
 * `classifyTodayError` 有两条通向上游超时的路：
 *
 * | 形态 | 判据 | 守卫 |
 * |---|---|---|
 * | HTTP 状态码 | `s === 408 \|\| s === 504` | ✅ 已有用例（`today.spec.ts` 组 D）|
 * | **抛出的异常** | `error.name === 'TimeoutError'` | ⚠️ **零覆盖** |
 *
 * ⚠️ 对抗审计实测：把 `TimeoutError → timeout` 那条分支**单独删掉**，
 * 全部用例**仍然是绿的**（M4b 无牙）⇒「超时不换号」这个声明**没有任何测试支持**。
 *
 * ## 为什么这条重要
 *
 * `timeout` 在本适配器的语义是**立即终止、不换下一个账号**。
 * 若 `TimeoutError` 落到 `transport`（默认分支），就会触发换号重试 ⇒
 * **一次上游超时把整池账号各烧一遍**（正是 #185 审出的「空完成 ⇒ 504 ⇒ 逐号烧池」同型）。
 */
import { describe, expect, it } from 'vitest'
import { TodayAdapter } from '../../src/today-adapter.js'
import { TODAY } from '../../src/today-product.js'
import type { TodayProduct } from '../../src/today-product.js'

/** 造一个凭据（形状与 `today.spec.ts:45` 的 `makeCred` 逐字一致）。 */
function makeCred(tok: string, realm: 'cn' | 'global' = 'cn') {
  return { cookie_raw: `__Secure-better-auth.session_token=${tok}`, realm } as never
}

function okJson(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 抛一个 `name === 'TimeoutError'` 的错误（fetch 超时的真实形状）。 */
function timeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout')
  err.name = 'TimeoutError'
  return err
}

describe('★★★ TodayAdapter：`TimeoutError` 归 timeout（不换号）', () => {
  it('★★★ 发送阶段抛 `TimeoutError` ⇒ **只碰第一个账号**，不换号', async () => {
    const tokens: string[] = []
    const product: TodayProduct = { ...TODAY, initialPollIntervalMs: 1, maxPollIntervalMs: 1 }
    const adapter = new TodayAdapter({
      product,
      slots: async () => [
        { accountId: 'acc1', credential: makeCred('t1.sig', 'cn') },
        { accountId: 'acc2', credential: makeCred('t2.sig', 'cn') },
      ],
      fetchImpl: async (input, init) => {
        const u = String(input)
        const headers = (init?.headers ?? {}) as Record<string, string>
        if (u.endsWith('/api/token')) {
          return okJson({ token: (headers.Cookie ?? '').includes('t1') ? 'jwt-t1' : 'jwt-t2', expiresIn: 3600 })
        }
        if (u.endsWith('/v1/pricing/status')) {
          return okJson({ data: { status: { modelOptions: { selectedOptionId: 'model.deepseek-v4.1-flash' } } } })
        }
        if (u.endsWith('/v1/messages')) {
          tokens.push(headers.Authorization ?? '')
          throw timeoutError()
        }
        return new Response('not found', { status: 404 })
      },
    })

    let thrown: unknown
    try {
      for await (const _ of adapter.stream({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'deepseek-v4.1-flash',
      } as never)) { void _ }
    } catch (error) {
      thrown = error
    }

    expect(thrown, '必须抛错（超时不能静默成功）').toBeDefined()
    /**
     * ⚠️ 核心断言：`timeout` ⇒ 立即终止。
     * 若退化成 `transport`，会换到 acc2 再打一次 ⇒ `tokens` 里会出现两条不同凭据。
     */
    expect(tokens.length, '★ `TimeoutError` 若被归成 transport 就会换号（把整池各烧一遍）').toBe(1)
  })
})
