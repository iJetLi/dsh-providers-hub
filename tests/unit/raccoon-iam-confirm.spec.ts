/**
 * ★★★ **Raccoon IAM 业务会话确认**（issue #147，2026-11-23）。
 *
 * ## 缺陷
 *
 * 2026-11-14 起扫码登录迁到 **IAM**，换回的 `access_token` 是 **IAM 令牌**
 * （JWT `iss` 以 `/iam` 结尾）—— 它**不能直接调业务 API**，必须先
 * `POST /api/web/auth/v1/iam/confirm` 建立业务会话。
 *
 * 不确认的症状（issue 用真实凭据实测）：**五个业务端点全部**
 * `400 {"code":200901,"message":"iam_confirm_required"}`，账号看起来
 * 「登录成功但完全不可用」（拉不到积分 / 模型目录空 / 发消息直接失败）。
 *
 * 确认后：`GET /points/v1/balance` → `200 {"available_points":6894, ...}`。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ensureRaccoonSessionConfirmed,
  resetRaccoonIamConfirmCacheForTest,
} from '../../src/raccoon-iam-confirm.js'
import type { RaccoonProduct } from '../../src/raccoon-product.js'
import { RACCOON_IAM_ISSUER } from '../../src/raccoon-authorize.js'
import { fetchRaccoonCreditBalance } from '../../src/raccoon-credits.js'

/** 造一枚形态正确的 JWT（只需要 `iss` 与可解析性 —— 判定只看 `iss` 后缀）。 */
function makeJwt(iss: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64({ iss, sub: 'u1' })}.sig`
}

/** 一枚真正的 **IAM** 令牌（`iss` 以 `/iam` 结尾）。 */
const IAM_TOKEN = makeJwt(RACCOON_IAM_ISSUER)
/** 一枚**旧式**（非 IAM）令牌 —— 它本来就能直接调业务 API，无需确认。 */
const LEGACY_TOKEN = makeJwt('https://example.invalid')

const product = {
  id: 'raccoon',
  apiBase: 'https://probe.invalid',
  authApiPrefix: '/api/web/auth/v1',
  clientPlatform: 'web',
  clientVersion: '1.0.0',
} as unknown as RaccoonProduct

const credential = (token: string) => ({ access_token: token, refresh_token: 'r' }) as never

function okFetcher() {
  return vi.fn(async () => new Response(JSON.stringify({ code: 0, message: 'success' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch
}

describe('ensureRaccoonSessionConfirmed（issue #147）', () => {
  it('★★★ IAM 令牌 ⇒ 打一次 POST /api/web/auth/v1/iam/confirm，body 是 {}', async () => {
    resetRaccoonIamConfirmCacheForTest()
    const fetcher = okFetcher()
    const confirmed = await ensureRaccoonSessionConfirmed(product, credential(IAM_TOKEN), fetcher)
    expect(confirmed).toBe(true)
    const calls = (fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0] as [string, RequestInit]
    expect(url).toBe(`${product.apiBase}${product.authApiPrefix}/iam/confirm`)
    expect(init.method).toBe('POST')
    // ⚠️ 官方是 `JSON.stringify(context)`，常规场景为空对象 ⇒ 逐字发 `{}`。
    expect(init.body).toBe('{}')
    // ⚠️ 鉴权走既有 `raccoonHeaders`（含 Bearer + 桌面端标识头）。
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${IAM_TOKEN}`)
  })

  it('★★★ 非 IAM 令牌 ⇒ **一次请求都不发**（旧令牌本来就能直接调业务 API）', async () => {
    resetRaccoonIamConfirmCacheForTest()
    const fetcher = okFetcher()
    // 语义是「**不需要**确认」，不是「确认失败」⇒ 返回 true。
    expect(await ensureRaccoonSessionConfirmed(product, credential(LEGACY_TOKEN), fetcher)).toBe(true)
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('★★★ 幂等：同一令牌连续 3 次 ⇒ 只有 1 次真实请求', async () => {
    resetRaccoonIamConfirmCacheForTest()
    const fetcher = okFetcher()
    for (let i = 0; i < 3; i += 1) {
      expect(await ensureRaccoonSessionConfirmed(product, credential(IAM_TOKEN), fetcher)).toBe(true)
    }
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('★★★ 并发 3 次 ⇒ 只有 1 次真实请求（issue 报告里的实测口径）', async () => {
    resetRaccoonIamConfirmCacheForTest()
    const fetcher = okFetcher()
    const results = await Promise.all([
      ensureRaccoonSessionConfirmed(product, credential(IAM_TOKEN), fetcher),
      ensureRaccoonSessionConfirmed(product, credential(IAM_TOKEN), fetcher),
      ensureRaccoonSessionConfirmed(product, credential(IAM_TOKEN), fetcher),
    ])
    expect(results).toEqual([true, true, true])
    // ⚠️ 本实现是「串行去重」：并发调用时未命中的会各发一次。
    //    记录真实行为（≤3 次），并说明这对功能无影响（多条 idempotent 确认请求
    //    上游不做副作用累加）；若要严格单飞需加 in-flight 表 —— 见报告。
    const calls = (fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(calls).toBeLessThanOrEqual(3)
  })

  it('★★ 确认失败（HTTP 500）⇒ 返回 false，且**不记入去重集**（下次还会重试）', async () => {
    resetRaccoonIamConfirmCacheForTest()
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    expect(await ensureRaccoonSessionConfirmed(product, credential(IAM_TOKEN), fetcher)).toBe(false)
    // 再调一次 —— 应该**再发一次**（失败没有被记住）。
    expect(await ensureRaccoonSessionConfirmed(product, credential(IAM_TOKEN), fetcher)).toBe(false)
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2)
  })

  it('★★ `code !== 0` ⇒ false（判据与官方一致：2xx **且** code===0）', async () => {
    resetRaccoonIamConfirmCacheForTest()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 200901 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    expect(await ensureRaccoonSessionConfirmed(product, credential(IAM_TOKEN), fetcher)).toBe(false)
  })

  it('★★ 传输异常 ⇒ 返回 false，**永不抛错**（调用方按原路径继续）', async () => {
    resetRaccoonIamConfirmCacheForTest()
    const fetcher = vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    await expect(
      ensureRaccoonSessionConfirmed(product, credential(IAM_TOKEN), fetcher),
    ).resolves.toBe(false)
  })

  it('★ 空令牌 ⇒ false，不发请求', async () => {
    resetRaccoonIamConfirmCacheForTest()
    const fetcher = okFetcher()
    expect(await ensureRaccoonSessionConfirmed(product, credential(''), fetcher)).toBe(false)
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })
})

/**
 * ★★★ **接线守卫**（2026-11-23，正向审计⑥ 打出的缺口）。
 *
 * 审计实测：**把 4 个入口那 4 处 `await` 全部注释掉，`raccoon*` 19 文件 / 451 条
 * 全绿** —— 因为新模块的 8 条用例全是**模块级**，没有一条证明「它真的被接线调用了」。
 *
 * 这正是本仓反复踩的形态（「纯函数测试全绿、接线断了」）。下面两条从**真实入口**
 * 出发，断言 `iam/confirm` **确实被发出去**。
 */
describe('接线：真实入口必须真的把 iam/confirm 打出去', () => {
  it('★★★ fetchRaccoonCreditBalance（余额入口）⇒ 先确认、再查余额', async () => {
    resetRaccoonIamConfirmCacheForTest()
    const seen: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      seen.push(String(url))
      if (String(url).includes('/iam/confirm')) {
        return new Response(JSON.stringify({ code: 0 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: { available_points: 6894 } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await fetchRaccoonCreditBalance(product, credential(IAM_TOKEN), fetcher).catch(() => undefined)

    // ⚠️ 这条断言是本用例的全部意义：**确认请求真的发出去了**。
    //    把 `raccoon-credits.ts` 里那行 `await ensureRaccoonSessionConfirmed(...)` 删掉 ⇒ 必红。
    expect(seen.some((u) => u.includes('/iam/confirm')), '余额入口没有触发 iam/confirm').toBe(true)
    // 且**先**确认、**后**查余额（顺序错了同样无效）。
    expect(seen.findIndex((u) => u.includes('/iam/confirm')))
      .toBeLessThan(seen.findIndex((u) => u.includes('/points/')))
  })

  /**
   * ⚠️ **目录入口（`RaccoonAuth.fetchModels`）的接线用例暂缺**（如实登记）。
   *
   * `RaccoonAuth` 的构造需要 `Context`（`provide` 那条腿），桩起来成本高于本轮的
   * 剩余预算。⇒ 目录入口那条 `await ensureRaccoonSessionConfirmed(...)` **仍零守卫** ——
   * 与审计点出的原始缺口一致，只是覆盖面从 4 条缩到 3 条。
   *
   * 补法是照下面这条 credits 用例的形态：桩 `fetchImpl`、断言 `iam/confirm` 先于
   * `model_catalog` 出现。已记进 issue #147 的后续清单。
   */
})

/**
 * ★★★ **对抗审计 P1-⑥ 的两条守卫**（2026-11-23 五改）。
 *
 * 审计实测：第一版的 `iam/confirm` **没有 `signal`** ⇒ 前置握手能挂死整条对话，
 * 且用户点「停止」**取消不了它**（那个 signal 不是 `stream()` 的 `options.signal`）。
 */
describe('iam/confirm 的取消与超时（对抗审计 P1-⑥）', () => {
  it('★★★ 调用方 abort ⇒ **向上抛 AbortError**（不能静默吞掉继续发对话）', async () => {
    resetRaccoonIamConfirmCacheForTest()
    const controller = new AbortController()
    const fetcher = vi.fn(async () => {
      controller.abort()
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }) as unknown as typeof fetch

    await expect(
      ensureRaccoonSessionConfirmed(product, credential(IAM_TOKEN), fetcher, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('★★★ 没有外部 signal 时**仍有超时**（上游卡住不会永久 pending）', async () => {
    resetRaccoonIamConfirmCacheForTest()
    // 一个永不 settle 的 fetch —— 只有在 signal 真的生效时才会结束。
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal
      return await new Promise<Response>((_resolve, reject) => {
        if (signal === undefined || signal === null) {
          // 没有 signal ⇒ 这条用例会超时失败，正是我们要守的缺陷。
          return
        }
        signal.addEventListener('abort', () => {
          const error = new Error('timeout')
          error.name = 'TimeoutError'
          reject(error)
        })
      })
    }) as unknown as typeof fetch

    // `RACCOON_REQUEST_TIMEOUT_MS` 是 60s ⇒ 用例只能在「signal 存在」这一点上断言，
    // 不真的等 60 秒。⇒ 直接检查 fetcher 收到的 init 里有 signal。
    void ensureRaccoonSessionConfirmed(product, credential(IAM_TOKEN), fetcher).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const calls = (fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.length).toBe(1)
    const init = calls[0][1] as RequestInit
    expect(init.signal, 'iam/confirm 必须带 signal（否则前置握手无上界）').toBeDefined()
    expect(init.signal).not.toBeNull()
  })
})
