/**
 * 「轮换起点」在**免费模型**路径上也必须生效（真实缺陷守卫）。
 *
 * ## 事故（2026-11-11 用户实测）
 *
 * 用户选了「账号 2 · M移0959」，实际却仍用「账号 1 · M电4016」。
 *
 * 根因：`credential-resolver.ts` 的**免费短路**（`if (free) { ... return }`）
 * 按候选原序取第一个凭据可读的号并**直接 return**，而 `rotationStartId`
 * 的计算在它**之后** ⇒ 免费模型永远够不到旋转。
 *
 * ## 为什么这条缺陷之前没被测出来
 *
 * 我当初**刻意**写了「免费模型不重排」，理由原文是「免费路径不看档位，
 * 只挑第一个凭据可读的号，插优先级会改变它的既有语义」——
 * **那个理由只对「档位」成立，对「起点」不成立**：起点不是档位，
 * 它只是「从谁开始数」，与是否消耗积分无关。
 *
 * ⇒ 单测里也就没有「免费 + 起点」这一格。
 */
import { describe, expect, it, vi } from 'vitest'
import { createCredentialResolver, NO_FREE_MODEL } from '../../src/credential-resolver.js'

interface Entry {
  id: string
  credentialRef: string
  enabled: boolean
}

const PROVIDER = 'demo'

/** 造一个只有池、免费模型恒 true 的最小环境。 */
function makeEnv(options: {
  entries: Entry[]
  credentials: Record<string, string>
  rotationStartId?: string
}) {
  const pool = {
    listAccountsByProvider: (provider: string) =>
      options.entries.filter((_, i) => provider === PROVIDER || i >= 0),
    permanentLocked: () => false,
    getAvailableAccount: async () => null,
    strictManualOrder: () => false,
    // ⚠️ 关键：这是本功能新增的可选方法。未实现时（老替身）行为必须逐字节不变。
    ...(options.rotationStartId === undefined
      ? {}
      : { preferredRotationFor: () => options.rotationStartId }),
  }
  const reported: Array<string | undefined> = []
  const resolver = createCredentialResolver<string>(
    {
      pool: pool as never,
      reportAccount: (id: string | undefined) => { reported.push(id) },
    },
    {
      product: { id: PROVIDER, displayName: 'Demo' } as never,
      readCredential: async (ref: string) => options.credentials[ref],
      // 免费模型的判定：恒 true（这是本文件的核心前提）
      balance: {
        kind: 'buddy',
        selector: {
          select: vi.fn(async () => ({ ok: false, reason: { kind: 'no-candidates' } })),
        } as never,
        lockedError: () => new Error('locked'),
        isFreeModel: async () => true,
      },
    } as never,
  )
  return { resolver, reported }
}

const ENTRIES: Entry[] = [
  { id: 'acc-1', credentialRef: 'REF_1', enabled: true },
  { id: 'acc-2', credentialRef: 'REF_2', enabled: true },
  { id: 'acc-3', credentialRef: 'REF_3', enabled: true },
]
const CREDS = { REF_1: 'cred-1', REF_2: 'cred-2', REF_3: 'cred-3' }

describe('轮换起点 @ 免费模型', () => {
  it('★ 设了起点 ⇒ 从该账号开始（不是按手动序第一个）', async () => {
    const { resolver, reported } = makeEnv({
      entries: ENTRIES,
      credentials: CREDS,
      rotationStartId: 'acc-2',
    })
    const cred = await resolver('any-model', 'session-x')
    // 用户实测的正是这一格：选了 0959 却拿到 4016
    expect(cred).toBe('cred-2')
    expect(reported).toEqual(['acc-2'])
  })

  it('未设起点 ⇒ 仍取手动序第一个（零回归）', async () => {
    const { resolver, reported } = makeEnv({ entries: ENTRIES, credentials: CREDS })
    const cred = await resolver('any-model', 'session-x')
    expect(cred).toBe('cred-1')
    expect(reported).toEqual(['acc-1'])
  })

  it('起点是第一个 ⇒ 与未设置等价', async () => {
    const { resolver } = makeEnv({ entries: ENTRIES, credentials: CREDS, rotationStartId: 'acc-1' })
    expect(await resolver('any-model', 'session-x')).toBe('cred-1')
  })

  it('起点是最后一个 ⇒ 从最后一个开始', async () => {
    const { resolver } = makeEnv({ entries: ENTRIES, credentials: CREDS, rotationStartId: 'acc-3' })
    expect(await resolver('any-model', 'session-x')).toBe('cred-3')
  })

  it('★ 起点账号凭据坏 ⇒ 绕一圈继续找（集合不变）', async () => {
    const { resolver, reported } = makeEnv({
      entries: ENTRIES,
      credentials: { REF_1: 'cred-1', REF_3: 'cred-3' }, // REF_2 坏
      rotationStartId: 'acc-2',
    })
    // 旋转后 = [acc-2, acc-3, acc-1]；acc-2 凭据坏 ⇒ 取 acc-3
    expect(await resolver('any-model', 'session-x')).toBe('cred-3')
    expect(reported).toEqual(['acc-3'])
  })

  it('起点 id 不在候选里（账号被删）⇒ 退化为手动序第一个', async () => {
    const { resolver } = makeEnv({ entries: ENTRIES, credentials: CREDS, rotationStartId: 'acc-999' })
    expect(await resolver('any-model', 'session-x')).toBe('cred-1')
  })
})

describe('付费模型不受本修法影响（对照）', () => {
  it('免费判定为 false 时仍走余额分档（selector 被调用）', async () => {
    const select = vi.fn(async () => ({ ok: false as const, reason: { kind: 'no-candidates' as const } }))
    const pool = {
      listAccountsByProvider: () => ENTRIES,
      permanentLocked: () => false,
      getAvailableAccount: async () => null,
      strictManualOrder: () => false,
      preferredRotationFor: () => 'acc-2',
    }
    const resolver = createCredentialResolver<string>(
      { pool: pool as never, reportAccount: () => {} },
      {
        product: { id: PROVIDER, displayName: 'Demo' } as never,
        readCredential: async (ref: string) => CREDS[ref as keyof typeof CREDS],
        balance: {
          kind: 'buddy',
          selector: { select } as never,
          lockedError: () => new Error('locked'),
          isFreeModel: NO_FREE_MODEL,
        },
      } as never,
    )
    await resolver('paid-model', 'session-x').catch(() => {})
    expect(select).toHaveBeenCalled()
  })
})
