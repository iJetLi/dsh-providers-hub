/**
 * ZCode 真领取探针（e2e）：验证「营销门控 + captcha + claim」整条链路。
 *
 * issue/PR 背景：2026-11-03 的营销门控从 3.16.3 抬到 3.17.1，但 PR 只验证了
 * 「能拿到投放」，claim 那一步没跑（会消耗当天唯一一次领取机会）。
 *
 * 闸门：`DSH_ZCODE_E2E=1` 且 `DSH_ZCODE_E2E_CONFIRM=yes`（**会真实领取**）。
 * 首次跑成功后，当天再跑应返回 already-claimed（同样证明链路走通）。
 *
 * 2026-11-04 实测：`{kind:'claimed', credit:300000000, unit:'token'}`。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { ZcodeAuth } from '../../src/zcode-auth.js'
import { ZCODE } from '../../src/zcode-product.js'
import { extractYamlScalar, readCredentialsFile } from './workbuddy-credential.js'

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

const E2E = process.env.DSH_ZCODE_E2E === '1' && process.env.DSH_ZCODE_E2E_CONFIRM === 'yes'
const suite = E2E ? describe : describe.skip

const text = readCredentialsFile()
const ref = [...text.matchAll(/^\s*(ZCODE_ACCOUNT_[A-Z0-9]+):/gm)].map((m) => m[1])[0]
const credential = JSON.parse(extractYamlScalar(text, ref!)) as Record<string, unknown>

suite('E2E zcode 真领取（PR #173 claim 未覆盖项）', () => {
  it('真实 claimDailyFor：能拿到 plan 并真正领取', async () => {
    const ctx = new Context()
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    ctx.logger = { info: (...a: unknown[]) => console.log('[zcode-claim]', ...a), warn: (...a: unknown[]) => console.log('[zcode-claim][warn]', ...a), error: () => {}, debug: () => {} } as never
    await credentials.set(ZCODE.defaultCredentialRef, JSON.stringify(credential))
    const auth = new ZcodeAuth(ctx, {})
    // claimDailyFor 的第二个参数是 captcha mint 注入；不传会直接 failed（不是缺陷）。
    const outcomes = await auth.claimDailyFor(
      credential as never,
      async (config) => await auth.mintCaptcha(config),
    )
    console.log('[zcode-claim] outcomes =', JSON.stringify(outcomes, null, 2))
    expect(outcomes.length).toBeGreaterThan(0)
    const kinds = outcomes.map((o) => o.kind)
    // 今天已领也算成功路径（说明投放/领取链路已走通），但不能是 failed。
    expect(kinds).not.toContain('failed')
  }, 600_000)
})
