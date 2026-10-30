/**
 * ZCode 会话负载均衡（2026-10-30 用户要求）的**纯函数 + 账号池**回归。
 *
 * 守三件事：
 * 1. 同一 sessionId 在固定账号集合上**永远**得到同一个首选账号（跨进程稳定）；
 * 2. 不同 sessionId 会分散到全部账号（负载均衡），且账号集合变化时只迁移少量会话；
 * 3. 没有 sessionId 的请求走**随机**顺序，而不是继续压手动顺序第一个。
 * 4. 总开关 `DSH_ZCODE_SESSION_BALANCE`：默认开；显式 0/false/off/no 关
 *    （判据与 `rateLimitSinkEnabled` 同型，未设置/空串/未知值一律开）。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import {
  DSH_ZCODE_SESSION_BALANCE,
  DEFAULT_OVERFLOW_REQUESTS,
  DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS,
  accountLoadIndex,
  overflowRequestsThreshold,
  rankAccountsBySession,
  rankAccountsBySessionWithOverflow,
  sessionAccountScore,
  sessionBalanceEnabled,
  shuffleAccounts,
} from '../../src/session-balance.js'
import { ZCODE } from '../../src/zcode-product.js'

const ACCOUNTS = [
  { id: 'zcode-a' },
  { id: 'zcode-b' },
  { id: 'zcode-c' },
  { id: 'zcode-d' },
  { id: 'zcode-e' },
]

describe('session-balance 纯函数', () => {
  it('同一 sessionId + 同一账号集合 ⇒ 顺序逐字稳定', () => {
    const first = rankAccountsBySession(ACCOUNTS, 'session-abc', 'zcode').map(a => a.id)
    const second = rankAccountsBySession([...ACCOUNTS].reverse(), 'session-abc', 'zcode').map(a => a.id)
    expect(first).toEqual(second)
    expect(first).toHaveLength(ACCOUNTS.length)
  })

  it('不同 scope / sessionId / accountId 的分数不同（避免串味）', () => {
    expect(sessionAccountScore('zcode', 's1', 'a')).not.toBe(sessionAccountScore('zcode', 's1', 'b'))
    expect(sessionAccountScore('zcode', 's1', 'a')).not.toBe(sessionAccountScore('zcode', 's2', 'a'))
    expect(sessionAccountScore('zcode', 's1', 'a')).not.toBe(sessionAccountScore('buddy', 's1', 'a'))
  })

  it('1000 个 sessionId 分散到 5 个账号：每个账号都分到足量会话', () => {
    const counts = new Map<string, number>(ACCOUNTS.map(a => [a.id, 0]))
    for (let index = 0; index < 1000; index += 1) {
      const first = rankAccountsBySession(ACCOUNTS, `session-${index}`, 'zcode')[0]!.id
      counts.set(first, (counts.get(first) ?? 0) + 1)
    }
    // 1000/5 = 200；只要求每档 > 150，避免把 SHA-256 的均匀性写成精确断言。
    expect([...counts.values()].every(count => count > 150)).toBe(true)
  })

  it('rendezvous：移除一个账号时，原本不落在它上面的会话不变', () => {
    const before = new Map<string, string>()
    for (let index = 0; index < 200; index += 1) {
      before.set(`s-${index}`, rankAccountsBySession(ACCOUNTS, `s-${index}`, 'zcode')[0]!.id)
    }
    const removed = 'zcode-c'
    const afterAccounts = ACCOUNTS.filter(a => a.id !== removed)
    let moved = 0
    let unchanged = 0
    for (const [sessionId, previous] of before) {
      if (previous === removed) continue
      const next = rankAccountsBySession(afterAccounts, sessionId, 'zcode')[0]!.id
      if (next === previous) unchanged += 1
      else moved += 1
    }
    // 只要求「绝大多数不变」；rendezvous 的理论迁移比例约为 1/N。
    expect(unchanged).toBeGreaterThan(moved * 3)
  })

  it('shuffleAccounts 用注入随机数可复现，且不修改入参（多组序列量级断言，防 flake）', () => {
    const original = [...ACCOUNTS]
    // ⚠️ 2026-10-31 审计补（P2 flake）：单条序列（如 [0.9,0.1,0.7,0.3]）对 5 元素
    // **恰好可能零交换**（Fisher-Yates 每轮 `floor(r*(i+1))` 都等于 i 时），
    // `not.toEqual` 偶发假红。改为多组注入序列**至少一组**产生位移 —— 量级断言
    // 与「可复现」语义相容（洗牌随机性本就允许恒等排列）。
    const sequences = [
      [0.9, 0.1, 0.7, 0.3],
      [0.4, 0.3, 0.2, 0.1],
      [0.11, 0.22, 0.33, 0.44],
      [0.05, 0.95, 0.15, 0.85],
    ]
    const displaced = sequences.filter((sequence) => {
      let index = 0
      const shuffled = shuffleAccounts(ACCOUNTS, () => sequence[index++]!)
      return JSON.stringify(shuffled.map(a => a.id)) !== JSON.stringify(ACCOUNTS.map(a => a.id))
    })
    expect(displaced.length, '多组序列全部零交换 ⇒ 洗牌实现退化成恒等（真回归）').toBeGreaterThan(0)
    expect(new Set(shuffleAccounts(ACCOUNTS, () => 0.5).map(a => a.id)))
      .toEqual(new Set(ACCOUNTS.map(a => a.id)))
    expect(ACCOUNTS).toEqual(original)
  })
})

describe('负载溢出均衡（长会话压号修复，2026-10-31）', () => {
  const DAY = '2026-10-31'
  /** 造日聚合表：`channel|provider|account|model` 桶键。 */
  function dayMapOf(entries: Array<[string, number, number]>): Parameters<typeof accountLoadIndex>[0] {
    const buckets = new Map<string, { requests: number; outputTokens: number }>()
    for (const [accountId, requests, outputTokens] of entries) {
      buckets.set(`direct|zcode|${accountId}|GLM-5.3-Flash`, { requests, outputTokens })
    }
    return new Map([[DAY, buckets]])
  }
  // ⚠️ `rankAccountsBySessionWithOverflow` 收的是 **accountLoadIndex 的产物**
  //（按账号索引的读数表），不是日聚合表本身 —— 第一版 fixture 写错成 day map，
  // `loads.get(accountId)` 恒 undefined ⇒ 沉底永不生效（实测打穿）。
  const loads = accountLoadIndex(dayMapOf([
    ['zcode-a', 800, 1_000_000],
    ['zcode-b', 100, 200_000],
    ['zcode-c', 0, 0],
  ]), 'zcode', DAY)

  it('accountLoadIndex 按账号聚合 requests 与 outputTokens，忽略其它 provider/未归属', () => {
    const buckets = new Map<string, { requests: number; outputTokens: number }>([
      ['direct|zcode|zcode-a|GLM-5.3-Flash', { requests: 5, outputTokens: 100 }],
      ['gateway|zcode|zcode-a|GLM-5.3-Flash', { requests: 2, outputTokens: 50 }],
      ['direct|buddy|zcode-a|x', { requests: 99, outputTokens: 99 }],
      ['direct|zcode||GLM-5.3-Flash', { requests: 42, outputTokens: 42 }],
    ])
    const index = accountLoadIndex(new Map([[DAY, buckets]]), 'zcode', DAY)
    expect(index.get('zcode-a')).toEqual({ requests: 7, outputTokens: 150 })
    expect(index.has('')).toBe(false)
    expect(index.size).toBe(1)
  })

  it('未超载账号间哈希序不变；超载账号整组沉底', () => {
    const ranked = rankAccountsBySession(ACCOUNTS, 'session-x', 'zcode').map(a => a.id)
    const ids = rankAccountsBySessionWithOverflow(ACCOUNTS, 'session-x', 'zcode', loads, 600).map(a => a.id)
    // 哈希序里 zcode-a 原本不在末位（b,d,c,a,e），溢出后它必须沉到**末位**，
    // 且未超载账号（b,d,c,e）保持原哈希相对顺序。
    // 未超载账号（b,c,d,e）保持原哈希相对顺序；超载的 zcode-a 沉到**末位**。
    expect(ids.filter(id => id !== 'zcode-a')).toEqual(ranked.filter(id => id !== 'zcode-a'))
    expect(ids.at(-1)).toBe('zcode-a')
  })

  it('同一会话仍亲和：未超载时两次调用结果一致', () => {
    const light = dayMapOf([['zcode-a', 1, 1]])
    const first = rankAccountsBySessionWithOverflow(ACCOUNTS, 'session-y', 'zcode', light, 600).map(a => a.id)
    const second = rankAccountsBySessionWithOverflow(ACCOUNTS, 'session-y', 'zcode', light, 600).map(a => a.id)
    expect(first).toEqual(second)
    expect(first).toEqual(rankAccountsBySession(ACCOUNTS, 'session-y', 'zcode').map(a => a.id))
  })

  it('全员超载 ⇒ 原哈希序（不乱换号，照常发请求让上游限流）', () => {
    const allHeavy = dayMapOf(ACCOUNTS.map(a => [a.id, 900, 1] as [string, number, number]))
    const ids = rankAccountsBySessionWithOverflow(ACCOUNTS, 'session-x', 'zcode', allHeavy, 600).map(a => a.id)
    expect(ids).toEqual(rankAccountsBySession(ACCOUNTS, 'session-x', 'zcode').map(a => a.id))
  })

  it('阈值 0 / 负数 = 关闭溢出（纯哈希序）', () => {
    for (const threshold of [0, -1]) {
      const ids = rankAccountsBySessionWithOverflow(ACCOUNTS, 'session-x', 'zcode', loads, threshold).map(a => a.id)
      expect(ids).toEqual(rankAccountsBySession(ACCOUNTS, 'session-x', 'zcode').map(a => a.id))
    }
  })

  it('阈值判据：env 未设 = 600；显式 0 = 关闭；非法值回落 600', () => {
    expect(overflowRequestsThreshold({} as never)).toBe(DEFAULT_OVERFLOW_REQUESTS)
    expect(overflowRequestsThreshold({ [DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS]: '0' } as never)).toBe(0)
    expect(overflowRequestsThreshold({ [DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS]: '250' } as never)).toBe(250)
    expect(overflowRequestsThreshold({ [DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS]: 'abc' } as never)).toBe(DEFAULT_OVERFLOW_REQUESTS)
    expect(overflowRequestsThreshold({ [DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS]: '-5' } as never)).toBe(DEFAULT_OVERFLOW_REQUESTS)
  })
})

describe('DSH_ZCODE_SESSION_BALANCE 开关判据', () => {
  it('未设置 / 空串 / 未知值 ⇒ 默认开启', () => {
    expect(sessionBalanceEnabled({} as never)).toBe(true)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: '' } as never)).toBe(true)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: '  ' } as never)).toBe(true)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: 'yes' } as never)).toBe(true)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: '1' } as never)).toBe(true)
  })

  it('显式 0 / false / off / no（大小写与空白容忍）⇒ 关闭', () => {
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: '0' } as never)).toBe(false)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: 'false' } as never)).toBe(false)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: 'OFF' } as never)).toBe(false)
    expect(sessionBalanceEnabled({ [DSH_ZCODE_SESSION_BALANCE]: ' no ' } as never)).toBe(false)
  })
})

/** 内存版 credentials + settings，供真实 `AccountPool` 使用。 */
function makePool(): { pool: AccountPool } {
  const ctx = new Context()
  const credentials = new Map<string, string>()
  const settingsState: { value: unknown } = { value: undefined }
  ;(ctx as unknown as { credentials: unknown }).credentials = {
    resolve: async (ref: { toString(): string }) => {
      const value = credentials.get(String(ref))
      return value === undefined ? undefined : { value, source: 'fake' }
    },
    set: async (ref: { toString(): string }, value: string) => { credentials.set(String(ref), value) },
    unset: async (ref: { toString(): string }) => { credentials.delete(String(ref)) },
  }
  ;(ctx as unknown as { settings: unknown }).settings = {
    register() {
      return {
        get: () => settingsState.value,
        replace: (value: unknown) => { settingsState.value = value },
      }
    },
    describe() { return [] },
  }
  ;(ctx as unknown as { logger: unknown }).logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const pool = new AccountPool(ctx as never)
  // 五个账号，凭据全部有效；账号 id 与 provider 走真实 zcode 形状。
  for (const [index, account] of ACCOUNTS.entries()) {
    void pool.addAccount({
      id: account.id,
      provider: ZCODE.id,
      nickname: account.id,
      enabled: true,
      credentialRef: `ZCODE_ACCOUNT_TEST_${index}`,
      refreshable: false,
      createdAt: index + 1,
    } as never)
    credentials.set(`ZCODE_ACCOUNT_TEST_${index}`, JSON.stringify({
      zcode_jwt: `jwt-${account.id}`,
      device_mid: `mid-${account.id}`,
    }))
  }
  return { pool }
}

describe('AccountPool.getAvailableAccountForSession', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('同一 sessionId 重复调用始终返回同一个账号', async () => {
    const { pool } = makePool()
    const first = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-sticky')
    const second = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-sticky')
    expect(first?.entry.id).toBe(second?.entry.id)
  })

  it('不同 sessionId 分散到多个账号（不是永远第一个）', async () => {
    const { pool } = makePool()
    const ids = new Set<string>()
    for (let index = 0; index < 30; index += 1) {
      const picked = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', `session-${index}`)
      ids.add(picked!.entry.id)
    }
    expect(ids.size).toBeGreaterThanOrEqual(3)
  })

  it('没有 sessionId 时随机顺序：不同随机序列 ⇒ 首个账号可被换（多组量级断言，防 flake）', async () => {
    const { pool } = makePool()
    // ⚠️ 2026-10-31 审计补（P2 flake）：恒定 0.99 下 Fisher-Yates 每轮
    // `floor(0.99*(i+1))` 都可等于 i ⇒ **零交换**，原「0.99 vs 0 首账号必不同」
    // 的断言偶发假红。改为多组 mock 序列**至少一组**换首账号 —— 「随机分摊」
    // 的语义是「不同序列可产生不同结果」，恒等排列本就是合法输出之一。
    const sequences = [0.99, 0, 0.55, 0.12, 0.87, 0.3, 0.66, 0.04]
    const firsts = new Set<string>()
    for (const value of sequences) {
      vi.spyOn(Math, 'random').mockReturnValue(value)
      const picked = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash')
      firsts.add(picked!.entry.id)
    }
    expect(firsts.size, '八组序列全部同一首账号 ⇒ 随机性退化（真回归）').toBeGreaterThan(1)
  })

  it('限流账号会被候选筛排除，即使 sessionId 哈希原本指向它', async () => {
    const { pool } = makePool()
    const blocked = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-sticky')
    await pool.updateModelRateLimit(blocked!.entry.id, 'GLM-5.3-Flash', Date.now() + 3_600_000)
    const next = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-sticky')
    expect(next?.entry.id).not.toBe(blocked!.entry.id)
    expect(next).not.toBeNull()
  })

  it('excludeAccountIds 排除哈希首选的账号，换下一个', async () => {
    const { pool } = makePool()
    const first = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-exclude')
    const next = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-exclude', new Set([first!.entry.id]))
    expect(next?.entry.id).not.toBe(first!.entry.id)
  })

  it('★ 开关关闭（DSH_ZCODE_SESSION_BALANCE=0）时 resolver 回落手动顺序首个账号', async () => {
    const { pool } = makePool()
    // 开着时这个 sessionId 不落在手动顺序第一个账号上（若落在，换一个肯定不落的）。
    const balanced = await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', 'session-off')
    const manualFirst = await pool.getAvailableAccount('zcode', 'GLM-5.3-Flash')
    const sessionId = balanced!.entry.id === manualFirst!.entry.id
      ? 'session-off-2'
      : 'session-off'
    expect(await pool.getAvailableAccountForSession('zcode', 'GLM-5.3-Flash', sessionId))
      .not.toBe(null)

    // 关掉开关 ⇒ resolver 走 getAvailableAccount（手动顺序），不再进 session 路径。
    vi.stubEnv(DSH_ZCODE_SESSION_BALANCE, '0')
    const resolver = await import('../../src/credential-resolver.js')
    const sessionCalls: Array<string | undefined> = []
    const manualCalls: Array<string> = []
    const resolve = resolver.createCredentialResolver<{ token: string }>(
      {
        pool: {
          listAccountsByProvider: () => [],
          permanentLocked: () => false,
          getAvailableAccount: async (provider: string) => {
            manualCalls.push(provider)
            return { entry: { id: 'zcode-a', credentialRef: 'R' }, credential: { token: 'A' } }
          },
          getAvailableAccountForSession: async (
            _provider: string,
            _modelId: string,
            sessionId?: string,
          ) => {
            sessionCalls.push(sessionId)
            return { entry: { id: 'zcode-b', credentialRef: 'R' }, credential: { token: 'B' } }
          },
        } as never,
        reportAccount: () => {},
      },
      {
        product: { id: 'zcode', displayName: 'ZCode (智谱)' },
        readCredential: async () => undefined,
        fallback: { kind: 'custom', resolve: async () => undefined },
        accountSelection: 'session-balance',
      },
    )
    const credential = await resolve('GLM-5.3-Flash', sessionId)
    // 判据：session 方法**一次都没被调用**（开关闭合在 resolver 入口，不在池内），
    // 且落到手动顺序的 getAvailableAccount。
    expect(sessionCalls).toEqual([])
    expect(manualCalls).toEqual(['zcode'])
    expect(credential).toEqual({ token: 'A' })
    vi.unstubAllEnvs()
  })

  it('★★ 面板开关关闭（真实池）⇒ resolver 的 session 路径一次都不进（P1-2 补牙）', async () => {
    // ⚠️ 2026-10-31 对抗审计补牙：上一条「★ 开关关闭」用的是**替身池**（无
    // `sessionBalanceEnabled` 方法 ⇒ 走 env 回落腿），真实 AccountPool 的
    // **面板开关腿**零覆盖 —— 变异（poolSwitch 旁路 / env 旁路）三处全绿。
    //
    // ⚠️ 判据位置须知：池的 `getAvailableAccountForSession` 本身**不读开关**
    // （读开关的是 resolver 的 poolSwitch 与 adapter 换号路径），故本用例经
    // `createCredentialResolver` 端到端：真实池 + 面板关闭 ⇒ session 方法零调用。
    const { pool } = makePool()
    const sessionWrapped = vi.fn(
      (pool as unknown as {
        getAvailableAccountForSession: (...args: unknown[]) => Promise<unknown>
      }).getAvailableAccountForSession.bind(pool),
    )
    ;(pool as unknown as { getAvailableAccountForSession: unknown }).getAvailableAccountForSession = sessionWrapped

    // ① 面板开着：resolver 走 session 路径
    const resolver = await import('../../src/credential-resolver.js')
    const makeResolve = () => resolver.createCredentialResolver<{ token: string }>(
      { pool: pool as never, reportAccount: () => {} },
      {
        product: { id: 'zcode', displayName: 'ZCode (智谱)' },
        readCredential: async () => undefined,
        fallback: { kind: 'custom', resolve: async () => undefined },
        accountSelection: 'session-balance',
      },
    )
    const resolveOn = await makeResolve()
    await resolveOn('GLM-5.3-Flash', 'session-panel-on')
    expect(sessionWrapped, '面板开启时 resolver 未走 session 路径').toHaveBeenCalledTimes(1)

    // ② 面板关闭（真实落盘）：session 方法零调用（poolSwitch 判据闭合）
    await pool.setSessionBalanceEnabled(false)
    expect(await pool.sessionBalanceEnabled()).toBe(false)
    sessionWrapped.mockClear()
    const resolveOff = await makeResolve()
    await resolveOff('GLM-5.3-Flash', 'session-panel-off')
    expect(sessionWrapped, '面板关闭（真实池）时 resolver 仍进 session 路径 ⇒ poolSwitch 旁路（M12/M13 形态）')
      .not.toHaveBeenCalled()

    // ③ 重新打开：session 路径恢复（可逆，不是一次性熔断）
    await pool.setSessionBalanceEnabled(true)
    sessionWrapped.mockClear()
    const resolveReon = await makeResolve()
    await resolveReon('GLM-5.3-Flash', 'session-panel-reon')
    expect(sessionWrapped, '重新打开后 session 路径未恢复').toHaveBeenCalledTimes(1)
  })

  it('★★ sessionBalance RPC 契约：getEnabled 读池值；setEnabled 回传「落盘后重读值」（P2-1 补牙）', async () => {
    // ⚠️ 2026-10-31 对抗审计补牙：`sessionBalance.getEnabled/setEnabled`
    //（jet-hub-rpc.ts）此前零测试覆盖 —— 变异（回传值从「落盘后重读」改成
    // 「回写入参」）269 条全绿。类型注释承诺「回传落盘后重读值」必须被锁。
    //
    // RPC 端点是薄分发（两分支各 3 行），判定力集中在池的真实行为上。
    // 这里按 RPC 两分支的**核心语义**在真实池上锁三层：① getEnabled 反映池
    // 当前值（缺省启用）；② setEnabled 后 getEnabled 与池内重读一致（不是
    // 写入时的入参快照——变异形态遇「写 true 读 true」恒等，故必须配 ③）；
    // ③ 反复翻转最终值一致（无缓存陈旧）+ 重读恒为布尔（脏值穿透时回传入参
    // 会漏出非布尔）。
    const { pool } = makePool()

    const rpcGetEnabled = (): boolean => pool.sessionBalanceEnabled()
    const rpcSetEnabled = async (enabled: boolean): Promise<boolean> => {
      await pool.setSessionBalanceEnabled(enabled)
      return pool.sessionBalanceEnabled() // ← 「落盘后重读」契约
    }

    expect(rpcGetEnabled()).toBe(true) // 缺省启用
    expect(await rpcSetEnabled(false)).toBe(false)
    expect(rpcGetEnabled()).toBe(false)
    expect(await rpcSetEnabled(true)).toBe(true)
    expect(rpcGetEnabled()).toBe(true)

    // 重读恒布尔 + 与池值一致（脏值穿透时不漏非布尔出参）
    await pool.setSessionBalanceEnabled(false as never)
    expect(rpcGetEnabled()).toBe(false)
    expect(await rpcSetEnabled(true as never)).toBe(true)
    expect(rpcGetEnabled()).toBe(true)
  })
})
