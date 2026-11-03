/**
 * issue #21：CodeArtsAdapter 必须向宿主声明 providerRetryPolicy。
 *
 * 不声明时，一次 `TRANSPORT` / `TIMEOUT` / `EMPTY_RESPONSE` 抖动会直接抛给
 * 前端，长任务（多轮 Agent、长上下文）被迫人工重跑。
 */
import { describe, expect, it } from 'vitest'

import { CodeArtsAdapter, PROVIDER } from '../../src/llm-adapter.js'

function makeAdapter(): CodeArtsAdapter {
  return new CodeArtsAdapter({
    credentialRef: { name: 'CODEARTS_ACCESS_KEY' } as never,
    resolveCredential: async () => undefined,
    refresh: async () => {},
  })
}

describe('CodeArtsAdapter.providerRetryPolicy（issue #21）', () => {
  it('★★ 对本 provider 声明瞬态重试（TRANSPORT/TIMEOUT/EMPTY_RESPONSE/SERVER）', () => {
    const policy = makeAdapter().providerRetryPolicy(PROVIDER)
    expect(policy).toBeDefined()
    expect(policy).toMatchObject({
      mode: 'normal',
      maxRetries: 5,
      initialDelayMs: 2_000,
      maxDelayMs: 10_000,
      jitterRatio: 0.25,
    })
    expect(policy?.retryableCodes).toEqual(
      expect.arrayContaining(['TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE', 'SERVER', 'RATE_LIMIT']),
    )
    // 声明即替换默认集：RATE_LIMIT 必须显式保留，否则 429 从重试变成秒失败。
    expect(policy?.retryableCodes).toContain('RATE_LIMIT')
    // 不可重试的码不得混进来（重试只会白烧账号）。
    expect(policy?.retryableCodes).not.toContain('AUTH')
    expect(policy?.retryableCodes).not.toContain('QUOTA')
    expect(policy?.retryableCodes).not.toContain('INVALID_REQUEST')
    // 深冻结：外层与数组都不可变（避免调用方 push 后影响宿主）。
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy?.retryableCodes)).toBe(true)
  })

  it('别的 provider 返回 undefined（不接管全局）', () => {
    expect(makeAdapter().providerRetryPolicy('buddy')).toBeUndefined()
  })
})
