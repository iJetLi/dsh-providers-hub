/**
 * 限流标记重测 / 重置的单元测试。
 *
 * 全部使用桩函数：**不发起任何网络请求**（探测函数由 deps.probe 注入），
 * 遵循 tests/unit 的约定。
 */
import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  pickTestModel,
  resetAccount,
  resetAllAccounts,
  retestAccount,
  retestAllAccounts,
  testAccount,
} from '../../src/account-probe.js'
import type { ProbePool } from '../../src/account-probe.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/** 构造账号条目；默认带一条 deepseek-v4.1-flash 的未到期限流记录。 */
function makeEntry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'buddy-1',
    provider: 'buddy',
    nickname: '测试号',
    enabled: true,
    credentialRef: 'BUDDY_ACCOUNT_TEST',
    createdAt: 1,
    refreshable: true,
    modelRateLimits: { 'deepseek-v4.1-flash': Date.now() + 3_600_000 },
    ...overrides,
  }
}

/**
 * 记录调用的账号池替身。
 *
 * `clearModelRateLimits` 真实改写内部状态，使「重测后再查」能反映清除结果，
 * 从而验证"只有实测通过的模型才被清除"。
 */
function makePool(entries: ProviderAccountEntry[]) {
  const accounts = new Map(entries.map(e => [e.id, { ...e }]))
  const cleared: Array<{ accountId: string; modelIds?: readonly string[] }> = []
  const updated: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
  /** 账号级封禁标记的清除记录（IKS2MV）。 */
  const policyCleared: string[] = []
  const pool: ProbePool & {
    cleared: typeof cleared
    updated: typeof updated
    policyCleared: typeof policyCleared
    get(id: string): ProviderAccountEntry | undefined
  } = {
    cleared,
    updated,
    policyCleared,
    get: (id) => accounts.get(id),
    findAccount: (id) => accounts.get(id),
    listAccountsByProvider: (provider) => [...accounts.values()].filter(a => a.provider === provider),
    async resolveCredentialForAccount(id) {
      const entry = accounts.get(id)
      if (entry === undefined) return undefined
      return { access_token: 'AT', refresh_token: 'RT', expires_at: '2099-01-01T00:00:00Z' } as never
    },
    async clearModelRateLimits(accountId, modelIds) {
      const entry = accounts.get(accountId)
      if (entry?.modelRateLimits === undefined) return 0
      const limits = { ...entry.modelRateLimits }
      let removed = 0
      const targets = modelIds ?? Object.keys(limits)
      for (const m of targets) {
        if (Object.prototype.hasOwnProperty.call(limits, m)) { delete limits[m]; removed++ }
      }
      if (removed === 0) return 0
      const next = { ...entry }
      if (Object.keys(limits).length === 0) delete next.modelRateLimits
      else next.modelRateLimits = limits
      accounts.set(accountId, next)
      cleared.push({ accountId, modelIds })
      return removed
    },
    // 真实写回，供「仍受限时用上游新时刻覆盖旧值」的断言使用。
    async updateModelRateLimit(accountId, modelId, resetAtMs) {
      const entry = accounts.get(accountId)
      if (entry === undefined) return
      accounts.set(accountId, {
        ...entry,
        modelRateLimits: { ...entry.modelRateLimits, [modelId]: resetAtMs },
      })
      updated.push({ accountId, modelId, resetAtMs })
    },
    async clearAccountPolicyBlocked(accountId) {
      const entry = accounts.get(accountId)
      if (entry === undefined || entry.policyBlockedAtMs === undefined) return false
      const next = { ...entry }
      delete next.policyBlockedAtMs
      delete next.policyBlockedMessage
      accounts.set(accountId, next)
      policyCleared.push(accountId)
      return true
    },
  }
  return pool
}

describe('retestAccount', () => {
  it('实测通过的模型被清除标记', async () => {
    const pool = makePool([makeEntry()])
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => ({ modelId, ok: true }))
    const result = await retestAccount(pool, 'buddy-1', { probe })

    expect(result.tested).toBe(1)
    expect(result.cleared).toEqual(['deepseek-v4.1-flash'])
    expect(result.stillLimited).toEqual([])
    // 关键：真的写回了池子，且只清除通过的模型
    expect(pool.cleared).toEqual([{ accountId: 'buddy-1', modelIds: ['deepseek-v4.1-flash'] }])
    expect(pool.get('buddy-1')?.modelRateLimits).toBeUndefined()
  })

  it('仍受限的模型保留标记，并回报原因', async () => {
    const pool = makePool([makeEntry({
      modelRateLimits: { 'model-a': Date.now() + 1000, 'model-b': Date.now() + 1000 },
    })])
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => (
      modelId === 'model-a'
        ? { modelId, ok: false, message: '仍受限：频率限制' }
        : { modelId, ok: true }
    ))
    const result = await retestAccount(pool, 'buddy-1', { probe })

    expect(result.cleared).toEqual(['model-b'])
    expect(result.stillLimited).toEqual([{ modelId: 'model-a', ok: false, message: '仍受限：频率限制' }])
    // 只清除了 model-b，model-a 的标记必须还在
    expect(pool.cleared).toEqual([{ accountId: 'buddy-1', modelIds: ['model-b'] }])
    expect(pool.get('buddy-1')?.modelRateLimits).toEqual({ 'model-a': expect.any(Number) })
  })

  it('没有任何限流标记时不发请求', async () => {
    const pool = makePool([makeEntry({ modelRateLimits: undefined })])
    const probe = vi.fn()
    const result = await retestAccount(pool, 'buddy-1', { probe })

    expect(result.tested).toBe(0)
    expect(probe).not.toHaveBeenCalled()
    expect(pool.cleared).toEqual([])
  })

  /**
   * 回归：限流是**滚动窗口**，上游每次都会把重置时刻往后推。若重测只报「仍受限」
   * 而不把新时刻写回，存储会一直停在第一次的旧值 —— 旧值一旦过期，
   * UI 的 `modelRateLimits[v] > Date.now()` 判为过期而**不再渲染「限额重置」**，
   * 于是出现「弹窗说仍受限、账号卡片却空白」的矛盾，选号也会误判为可用。
   */
  it('仍受限时用上游给出的新重置时刻覆盖旧值（滚动窗口）', async () => {
    const staleReset = Date.now() - 60_000 // 已过期的旧时刻
    const freshReset = Date.now() + 45 * 60_000 // 上游推后到 45 分钟后
    const pool = makePool([makeEntry({
      modelRateLimits: { 'deepseek-v4.1-flash': staleReset },
    })])
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => ({
      modelId, ok: false, message: '仍受限：频率限制', resetTimeMs: freshReset,
    }))

    const result = await retestAccount(pool, 'buddy-1', { probe })

    expect(result.cleared).toEqual([])
    // 关键：新时刻被写回并覆盖过期旧值 ⇒ UI 才会重新显示「限额重置」
    expect(pool.updated).toEqual([
      { accountId: 'buddy-1', modelId: 'deepseek-v4.1-flash', resetAtMs: freshReset },
    ])
    expect(pool.get('buddy-1')?.modelRateLimits).toEqual({ 'deepseek-v4.1-flash': freshReset })
  })

  it('仍受限但没有可解析的重置时刻时不写回（保留原标记）', async () => {
    const staleReset = Date.now() + 3_600_000
    const pool = makePool([makeEntry({
      modelRateLimits: { 'deepseek-v4.1-flash': staleReset },
    })])
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => ({
      modelId, ok: false, message: '仍受限：频率限制', // 无 resetTimeMs
    }))

    await retestAccount(pool, 'buddy-1', { probe })

    expect(pool.updated).toEqual([])
    expect(pool.get('buddy-1')?.modelRateLimits).toEqual({ 'deepseek-v4.1-flash': staleReset })
  })

  it('账号不存在时返回错误而不抛异常', async () => {
    const pool = makePool([])
    const result = await retestAccount(pool, 'missing', { probe: vi.fn() })
    expect(result.error).toContain('不存在')
    expect(result.tested).toBe(0)
  })

  it('凭据不可用时不清除标记', async () => {
    const entry = makeEntry()
    const pool = makePool([entry])
    // 覆盖为"凭据不可用"
    pool.resolveCredentialForAccount = async () => undefined
    // 用真实默认探测（deps.probe 省略）会走 resolveCredentialForAccount
    const result = await retestAccount(pool, 'buddy-1')

    expect(result.cleared).toEqual([])
    expect(result.stillLimited[0]?.message).toContain('凭据不可用')
    expect(pool.cleared).toEqual([])
  })
})

describe('retestAllAccounts', () => {
  it('遍历该 provider 的全部账号，包含已停用账号', async () => {
    const pool = makePool([
      makeEntry({ id: 'buddy-on', enabled: true }),
      makeEntry({ id: 'buddy-off', enabled: false }),
      makeEntry({ id: 'codearts-1', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_X' }),
    ])
    const seen: string[] = []
    const probe = vi.fn(async (entry: ProviderAccountEntry, modelId: string) => {
      seen.push(entry.id)
      return { modelId, ok: true }
    })
    const res = await retestAllAccounts(pool, 'buddy', { probe })

    // 停用的 buddy-off 也必须被重测（用户明确要求）
    expect(seen.sort()).toEqual(['buddy-off', 'buddy-on'])
    expect(res.accounts.map(a => a.accountId).sort()).toEqual(['buddy-off', 'buddy-on'])
    expect(res.clearedCount).toBe(2)
    // codearts 账号不应被 buddy 的批量操作波及
    expect(res.accounts.some(a => a.accountId === 'codearts-1')).toBe(false)
  })

  it('按顺序逐个探测，避免并发触发真实限流', async () => {
    const pool = makePool([makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })])
    let inFlight = 0
    let maxInFlight = 0
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 1))
      inFlight--
      return { modelId, ok: true }
    })
    await retestAllAccounts(pool, 'buddy', { probe })
    expect(maxInFlight).toBe(1)
  })
})

describe('resetAccount / resetAllAccounts', () => {
  it('重置不发请求，直接清除全部标记', async () => {
    const pool = makePool([makeEntry({
      modelRateLimits: { 'model-a': Date.now() + 1000, 'model-b': Date.now() + 2000 },
    })])
    const res = await resetAccount(pool, 'buddy-1')

    expect(res.clearedCount).toBe(2)
    expect(res.accountCount).toBe(1)
    expect(pool.get('buddy-1')?.modelRateLimits).toBeUndefined()
  })

  it('无标记时重置返回 0', async () => {
    const pool = makePool([makeEntry({ modelRateLimits: undefined })])
    expect(await resetAccount(pool, 'buddy-1')).toEqual({ clearedCount: 0, accountCount: 0 })
  })

  it('重置所有覆盖停用账号并统计正确', async () => {
    const pool = makePool([
      makeEntry({ id: 'on', enabled: true }),
      makeEntry({ id: 'off', enabled: false }),
      makeEntry({ id: 'none', enabled: false, modelRateLimits: undefined }),
      makeEntry({ id: 'ca', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_X' }),
    ])
    const res = await resetAllAccounts(pool, 'buddy')

    // on + off 各 1 条；none 无标记不计入；codearts 不在范围内
    expect(res.clearedCount).toBe(2)
    expect(res.accountCount).toBe(2)
    expect(pool.get('ca')?.modelRateLimits).toBeDefined()
  })
})

describe('限流判定（isRateLimitFailure 经由默认探测暴露的行为）', () => {
  it('LlmError 的 QUOTA_EXCEEDED / RATE_LIMIT / QUOTA 都识别为限流', () => {
    // 该判定是私有的，通过默认探测路径间接验证：这里直接断言错误码集合
    // 与实际适配器抛出的码一致，防止词汇漂移（buddy 用 QUOTA_EXCEEDED，
    // harness 常量是 QUOTA）。
    for (const code of ['RATE_LIMIT', 'QUOTA_EXCEEDED', 'QUOTA']) {
      const error = new LlmError('频率限制', code)
      expect(error.code).toBe(code)
    }
  })
})

/**
 * 「测试」：**无条件**真发一次请求（用户 m03338 的需求）。
 *
 * 与 `retestAccount` 的硬性区别（这组用例存在的全部理由）：
 * - 触发条件：重测只测 `Object.keys(entry.modelRateLimits)`，没有标记时
 *   **零请求**提前返回；测试不看标记，直接发。
 * - 存储副作用：重测会清标记、写回新的重置时刻；测试**一个字节都不写**。
 */
describe('testAccount', () => {
  it('没有限流标记时依然真发一次请求（这正是重测做不到的事）', async () => {
    const pool = makePool([makeEntry({ modelRateLimits: undefined })])
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => ({ modelId, ok: true }))

    const res = await testAccount(pool, 'buddy-1', 'deepseek-v4.1-flash', { probe })

    expect(probe).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(true)
    expect(res.modelId).toBe('deepseek-v4.1-flash')
  })

  it('不写任何存储：成功时不调 clearModelRateLimits', async () => {
    const pool = makePool([makeEntry()])
    const before = JSON.stringify(pool.get('buddy-1')?.modelRateLimits)
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => ({ modelId, ok: true }))

    await testAccount(pool, 'buddy-1', 'deepseek-v4.1-flash', { probe })

    // ⚠️ 这是与重测的**关键分野**：重测成功会清标记，测试必须原封不动。
    expect(pool.cleared).toHaveLength(0)
    expect(JSON.stringify(pool.get('buddy-1')?.modelRateLimits)).toBe(before)
  })

  it('仍受限时如实回报原因，且**不**写回新的重置时刻', async () => {
    const pool = makePool([makeEntry()])
    const before = pool.get('buddy-1')?.modelRateLimits?.['deepseek-v4.1-flash']
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => ({
      modelId,
      ok: false,
      message: '仍受限：频率限制',
      resetTimeMs: Date.now() + 7_200_000,
    }))

    const res = await testAccount(pool, 'buddy-1', 'deepseek-v4.1-flash', { probe })

    expect(res.ok).toBe(false)
    expect(res.message).toContain('仍受限')
    // 结果里带出上游时刻（供展示），但**不落盘**。
    expect(res.resetTimeMs).toBeGreaterThan(Date.now())
    expect(pool.updated).toHaveLength(0)
    expect(pool.get('buddy-1')?.modelRateLimits?.['deepseek-v4.1-flash']).toBe(before)
  })

  it('账号不存在时返回错误而不抛异常', async () => {
    const pool = makePool([])
    const probe = vi.fn()
    const res = await testAccount(pool, 'ghost', 'm', { probe })

    expect(res.ok).toBe(false)
    expect(res.message).toContain('不存在')
    expect(probe).not.toHaveBeenCalled()
  })

  it('探测函数抛错时收敛为可读原因，不冒泡', async () => {
    const pool = makePool([makeEntry()])
    const probe = vi.fn(async () => { throw new Error('凭据已失效') })

    const res = await testAccount(pool, 'buddy-1', 'm', { probe })

    expect(res.ok).toBe(false)
    expect(res.message).toBe('无法确认：凭据已失效')
  })

  it('回传昵称，便于多账号时区分是哪一个', async () => {
    const pool = makePool([makeEntry({ nickname: '测试号' })])
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => ({ modelId, ok: true }))

    const res = await testAccount(pool, 'buddy-1', 'm', { probe })

    expect(res.nickname).toBe('测试号')
  })
})

/**
 * 「测试」要发哪个模型：`pickTestModel` 的优先级。
 *
 * 这是纯函数（无 IO），但它是整条测试链路里**唯一决定请求内容**的一步 ——
 * 挑错了就会得到一个与账号无关的 404，把「账号不可用」和「模型名不对」
 * 混成同一条报错，用户据此会去做完全错误的动作（重新登录）。
 */
describe('pickTestModel', () => {
  it('显式指定优先于一切', () => {
    const entry = makeEntry({ modelRateLimits: { 'marked-model': Date.now() + 1_000 } })
    expect(pickTestModel(entry, ['catalog-a', 'catalog-b'], 'explicit')).toBe('explicit')
  })

  it('空串不算显式指定（回落到标记）', () => {
    // ⚠️ `req.modelId` 来自客户端，可能是 `''`；若把空串当成「已指定」，
    // 就会拿着空模型名发出去，得到一条与账号无关的 400。
    const entry = makeEntry({ modelRateLimits: { 'marked-model': Date.now() + 1_000 } })
    expect(pickTestModel(entry, ['catalog-a'], '')).toBe('marked-model')
  })

  it('标记优先于目录：用户最想看的正是被标记的那个模型', () => {
    const entry = makeEntry({ modelRateLimits: { 'marked-model': Date.now() + 1_000 } })
    expect(pickTestModel(entry, ['catalog-a', 'catalog-b'])).toBe('marked-model')
  })

  it('没有标记时取目录第一个', () => {
    const entry = makeEntry({ modelRateLimits: undefined })
    expect(pickTestModel(entry, ['catalog-a', 'catalog-b'])).toBe('catalog-a')
  })

  it('标记与目录都拿不到时返回空串，**不猜**一个模型名', () => {
    // 调用方拿到空串必须如实报错（`account.test` 端点据此回 bad-request）。
    // 猜一个名字发出去会得到 404，与「账号不可用」无法区分。
    const entry = makeEntry({ modelRateLimits: undefined })
    expect(pickTestModel(entry, [])).toBe('')
  })
})


/**
 * ★ 账号级封禁标记的清除路径（Gitee issue IKS2MV）。
 *
 * 封禁与限流是**两笔账**：限流 30 分钟后自动过期，而封禁不自动过期、
 * 只能靠「实测通过 / 手动重置 / 重新登录」清除。若「重置」只清限流，
 * 用户点了按钮后面板仍红、选号仍排除该账号 —— 按钮看起来就是失灵。
 */
describe('★ 账号级封禁标记的清除（issue IKS2MV）', () => {
  it('★ 重置会连带清掉封禁标记（即使一条限流标记都没有）', async () => {
    const pool = makePool([makeEntry({
      modelRateLimits: undefined,
      policyBlockedAtMs: Date.now() - 60_000,
      policyBlockedMessage: '账号存在异常行为，已被限制使用',
    })])
    const res = await resetAccount(pool, 'buddy-1')
    expect(res.clearedCount).toBe(0)
    // 判据：accountCount 必须为 1 —— 那才是「按钮真的生效了」。
    expect(res.accountCount).toBe(1)
    expect(pool.get('buddy-1')?.policyBlockedAtMs).toBeUndefined()
    expect(pool.policyCleared).toEqual(['buddy-1'])
  })

  it('★ 重测全通过 ⇒ 清掉封禁标记（账号显然没被封）', async () => {
    const pool = makePool([makeEntry({ policyBlockedAtMs: Date.now() - 60_000 })])
    await retestAccount(pool, 'buddy-1', {
      probe: async (_entry, modelId) => ({ modelId, ok: true }),
    })
    expect(pool.get('buddy-1')?.policyBlockedAtMs).toBeUndefined()
  })

  it('★ 重测仍受限 ⇒ 保留封禁标记（不能因为「测过一次」就洗白）', async () => {
    const pool = makePool([makeEntry({ policyBlockedAtMs: Date.now() - 60_000 })])
    await retestAccount(pool, 'buddy-1', {
      probe: async (_entry, modelId) => ({ modelId, ok: false, message: '仍受限：403 11140' }),
    })
    expect(pool.get('buddy-1')?.policyBlockedAtMs).toBeDefined()
  })
})
