/**
 * ZCode 真领取探针（e2e）：验证「营销门控 + captcha + claim」整条链路。
 *
 * issue/PR 背景：2026-11-03 的营销门控从 3.16.3 抬到 3.17.1，但 PR 只验证了
 * 「能拿到投放」，claim 那一步没跑（会消耗当天唯一一次领取机会）。
 *
 * 闸门：`DSH_ZCODE_E2E=1` 且 `DSH_ZCODE_E2E_CONFIRM=yes`（**会真实领取**）。
 * 首次跑成功后，当天再跑会没有投放 ⇒ 需要显式 `DSH_ZCODE_E2E_ALLOW_ALREADY=1`
 * 才允许通过（默认严格模式要求「有投放且真的 claimed」，避免门控坏掉时假绿）。
 *
 * 2026-11-04 实测：`{kind:'claimed', credit:300000000, unit:'token'}`；
 * 当天第二次：`already-claimed`（「今日暂无可领额度」）。
 */
import { Context } from '@deepseek-ai/cordis'
import { beforeAll, describe, expect, it } from 'vitest'

import { ZcodeAuth } from '../../src/zcode-auth.js'
import { ZCODE } from '../../src/zcode-product.js'
import { fetchZcodeMarketingPlans } from '../../src/zcode-upstream.js'
import { extractYamlScalar, readCredentialsFile } from './workbuddy-credential.js'

const E2E = process.env.DSH_ZCODE_E2E === '1' && process.env.DSH_ZCODE_E2E_CONFIRM === 'yes'
const ALLOW_ALREADY = process.env.DSH_ZCODE_E2E_ALLOW_ALREADY === '1'
const suite = E2E ? describe : describe.skip

class FakeCredentials {
  private readonly store = new Map<string, string>()
  async resolve(ref: string): Promise<{ value: string, source: string } | undefined> {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'e2e' }
  }
  async set(ref: string, value: string): Promise<void> { this.store.set(ref, value) }
  async unset(ref: string): Promise<void> { this.store.delete(ref) }
  async describe(ref: string): Promise<{ configured: boolean, source: string, writable: boolean }> {
    return { configured: this.store.has(ref), source: 'e2e', writable: true }
  }
}

let credential: Record<string, unknown> | undefined
let loadError = ''

/**
 * ⚠️ 凭据读取必须放进 `beforeAll`（2026-11-04 审计：放模块顶层时，
 * `describe.skip` 也会执行模块代码 ⇒ 闸门关闭 / 没装过 zcode 的机器上
 * e2e collection 直接红）。
 */
beforeAll(() => {
  if (!E2E) return
  try {
    const text = readCredentialsFile()
    const ref = [...text.matchAll(/^\s*(ZCODE_ACCOUNT_[A-Z0-9]+):/gm)].map((m) => m[1])[0]
    if (ref === undefined) throw new Error('凭据文件里没有 ZCODE_ACCOUNT_*')
    credential = JSON.parse(extractYamlScalar(text, ref)) as Record<string, unknown>
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
  }
})

suite('E2E zcode 真领取（PR #173 claim 未覆盖项）', () => {
  it('真实 claimDailyFor：拿到投放并真正领取', async () => {
    expect(credential, `读取 ZCODE 凭据失败：${loadError}`).toBeDefined()
    const ctx = new Context()
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    ctx.logger = {
      info: (...a: unknown[]) => console.log('[zcode-claim]', ...a),
      warn: (...a: unknown[]) => console.log('[zcode-claim][warn]', ...a),
      error: () => {},
      debug: () => {},
    } as never
    await credentials.set(ZCODE.defaultCredentialRef, JSON.stringify(credential))

    /**
     * ① 先只读确认门控有效（3.17.1 拿得到投放）。
     * 没有投放只允许两种情况：今天已领（显式 ALLOW_ALREADY），否则判失败 ——
     * 这正是「门控回退到 3.16.3」的症状，不能像旧探针那样静默通过。
     */
    const plans = await fetchZcodeMarketingPlans(credential as never)
    console.log('[zcode-claim] plans =', plans.map((p) => p.planId))
    if (plans.length === 0) {
      expect(ALLOW_ALREADY, '没有投放（可能今天已领，或门控坏了）；确认已领请设 DSH_ZCODE_E2E_ALLOW_ALREADY=1').toBe(true)
      return
    }

    const auth = new ZcodeAuth(ctx, {})
    // claimDailyFor 的第二个参数是 captcha mint 注入；不传会直接 failed（不是缺陷）。
    const outcomes = await auth.claimDailyFor(
      credential as never,
      async (config) => await auth.mintCaptcha(config),
    )
    console.log('[zcode-claim] outcomes =', JSON.stringify(outcomes, null, 2))
    const claimed = outcomes.find((o) => o.kind === 'claimed')
    if (claimed === undefined) {
      // 已被别人/上一轮抢领：只允许 already-claimed，且必须显式容忍。
      expect(outcomes.every((o) => o.kind === 'already-claimed'), '出现 failed').toBe(true)
      expect(ALLOW_ALREADY, '投放存在但没领到；确认今天已领请设 DSH_ZCODE_E2E_ALLOW_ALREADY=1').toBe(true)
      return
    }
    expect(claimed.kind === 'claimed' ? claimed.credit : 0).toBeGreaterThan(0)
  }, 600_000)
})
