import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * ★ `credits.balances` 的**按需自愈**（Gitee issue IKKHL5 建议 C）。
 *
 * ## 被修的缺陷
 *
 * 系统睡眠/挂起数小时后恢复，**宿主进程全程没退出** ⇒ `state.json` 里的
 * `expiresAt`（上次续期时刻 + 令牌寿命）落在过去。客户端判据只有一次本地
 * 比较（`plugin-src/client/jet-hub.js` 的 `account.expiresAt <= Date.now()`）
 * ⇒ 卡片显示红色「已过期 · 自动续期」；而 `credits.balances` 原本
 * **resolve 凭据后直连上游、全程不续期** ⇒ 积分行报「HTTP 401」。
 * 该窗口内没有任何手动自救手段（「重测」的 refresh 是刻意 no-op）。
 *
 * ## 为什么这层是对的（issue 建议的 A「墙钟跳变检测」不是）
 *
 * 实测 `NtSuspendProcess` 真实挂起：libuv 定时器基于**单调时钟**，
 * 睡眠时长 > interval 时**恢复瞬间就补触发**一轮（不需要墙钟检测来抢救）；
 * 真正的缺口是**恢复后第一轮要等最多一个 interval**，而短寿命 provider
 * （minimax 1h / codearts 2h / raccoon 3h）在这个窗口里必然显示「已过期」。
 * 让**用户主动发起的积分查询**自带续期，一次刷新面板同时消灭显示与 401。
 *
 * ## 本文件锁的五件事
 *
 * 1. 已过期 → **先续期再查余额**（缺陷本体）；
 * 2. 未过期 → **一个请求都不多发**（不能变成「每次刷新都续期一遍」）；
 * 3. 续期失败 → **不上抛**、照常查余额（凭据本来就过期，直连必然 401，
 *    报「续期失败」比原来的「HTTP 401」更难懂）；
 * 4. **不判 `entry.refreshable`**（那个布尔是凭据材料的镜像、可能被误标，
 *    误标过一次就永不自愈 —— AGENTS.md 已有的铁律）；
 * 5. loomy / zcode **不进自愈**（没有 refresh 端点，探测只会白发请求）。
 */

type Handler = (request: Request) => Promise<Response>

/** 一条「已过期」的账号条目。 */
function expiredEntry(over: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'acc-1',
    provider: 'minimax',
    nickname: '测试账号',
    credentialRef: 'MINIMAX_ACCOUNT_1',
    enabled: true,
    refreshable: true,
    expiresAt: Date.now() - 3 * 60 * 60 * 1000,
    ...over,
  } as ProviderAccountEntry
}

interface HarnessOptions {
  accounts: ProviderAccountEntry[]
  /** 每家 auth 的 refreshAccountCredential 替身；未列出的 provider 仅记录调用。 */
  auths?: Record<string, (ref: string, pool: unknown, id: string) => Promise<void>>
  /**
   * 凭据解析钩子。它是**余额查询路径的第一步**（`collectCreditBalances` 的
   * `deps.resolve`），故可用来见证「先续期、后查余额」的**顺序**而不必发网络。
   */
  onResolve?: () => void
}

function setup(options: HarnessOptions) {
  const calls: Array<{ provider: string; ref: string; accountId: string }> = []
  const warns: string[] = []

  const makeAuth = (provider: string) => ({
    refreshAccountCredential: async (ref: string, _pool: unknown, accountId: string) => {
      calls.push({ provider, ref, accountId })
      const injected = options.auths?.[provider]
      if (injected !== undefined) return injected(ref, _pool, accountId)
      return undefined
    },
  })

  const ctx: Record<string, unknown> = {
    get: (key: string) => key === 'connection'
      ? { fetch: { register: (c: { path: string; fetch: Handler }) => { if (c.path === JET_HUB_API_PATH) handler = c.fetch } } }
      : undefined,
    inject: (_deps: string[], cb: (c: unknown) => void) => { cb(ctx) },
    logger: { warn: (m: string) => { warns.push(m) }, info: () => {} },
    credentials: {
      // 返回 undefined 让逐账号流程走「凭据未配置」分支（**无需真实网络**），
      // 同时它仍能作为「余额查询已开始」的可观测信号。
      resolve: async () => { options.onResolve?.(); return undefined },
    },
  }

  let handler: Handler | undefined
  const pool = {
    listAccounts: async () => options.accounts,
    // ⚠️ `account.refresh` 端点走的是 `listAllAccounts()`（跨 provider 找条目），
    // 与 `credits.balances` 的 `listAccounts(provider)` 不同 —— 两个都要给。
    listAllAccounts: async () => options.accounts,
  }

  // ⚠️ 2026-10-10（合并 master 的 provider 抽象重构）：`registerJetHubRpc` 的
  // 13 个 provider 形参已从**位置传参**改为**命名对象 `auths`**（键 = provider
  // id）。这消除的正是「少传/插队静默错位」那一类缺陷（本仓库历史复发 6 次）。
  // 本 harness 随之改为传对象 —— 少一个键会**编译不过**，而不是静默错位。
  const a = makeAuth
  const auths = {
    codearts: a('codearts'), buddy: a('buddy'), workbuddy: a('workbuddy'),
    lobsterai: a('lobsterai'), qoder: a('qoder'), qodercn: a('qodercn'),
    trae: a('trae'), cline: a('cline'), loomy: a('loomy'),
    raccoon: a('raccoon'), minimax: a('minimax'), zcode: a('zcode'),
    gemini: a('gemini'),
    officeace: {} as never,
    // ⚠️ accio 必须在这里：本 harness 的 auths 与 `JetHubAuths` **逐键同形**
    //（少一个键本应编译不过，但调用处是 `as never` 转型，故由下面那条
    //「JetHubAuths 的每个键都在 Set 里」的守卫在**源码层**兜）。
    accio: a('accio'),
    // ⚠️ **本 fork 独有**（modelscope，2026-10-16）：同 accio，本 harness 的 auths
    //    必须与 `JetHubAuths` **逐键同形**（否则上面那条「每个键都在 Set 里」的
    //    源码层守卫会红，而 `as never` 转型挡不住）。
    modelscope: a('modelscope'),
  }
  registerJetHubRpc(
    ctx as never,
    pool as never,
    auths as never,
  )
  if (handler === undefined) throw new Error('endpoint handler was not registered')

  const call = async (method: string, payload: unknown) => {
    const response = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub', payload: { method, payload },
      }),
    }))
    const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
    return body.result
  }

  return { call, calls, warns }
}

describe('credits.balances 的按需自愈（issue IKKHL5 建议 C）', () => {
  it('★ 已过期的账号会先续期再查余额（缺陷本体）', async () => {
    const { call, calls } = setup({ accounts: [expiredEntry({ id: 'a1' })] })

    const result = await call('credits.balances', { provider: 'minimax' })

    expect(calls).toEqual([{ provider: 'minimax', ref: 'MINIMAX_ACCOUNT_1', accountId: 'a1' }])
    // 续期失败不改变端点契约：仍回 ok（逐账号带 error）
    expect(result.ok).toBe(true)
  })

  it('未过期的账号**一个续期请求都不多发**', async () => {
    const fresh = expiredEntry({ id: 'a1', expiresAt: Date.now() + 60 * 60 * 1000 })
    const { call, calls } = setup({ accounts: [fresh] })

    await call('credits.balances', { provider: 'minimax' })

    expect(calls).toEqual([])
  })

  it('expiresAt 缺失（undefined / 0）时不发续期请求', async () => {
    const { call, calls } = setup({
      accounts: [
        expiredEntry({ id: 'a1', expiresAt: undefined }),
        expiredEntry({ id: 'a2', expiresAt: 0 }),
      ],
    })

    await call('credits.balances', { provider: 'minimax' })

    // ⚠️ 与客户端判据逐字一致：`typeof x === 'number' && x > 0 && x <= now`。
    // 读不到过期时间 ≠ 已过期，不得凭空发请求。
    expect(calls).toEqual([])
  })

  it('停用（enabled:false）但已过期的账号**照样自愈**（停用只影响自动选号）', async () => {
    const { call, calls } = setup({ accounts: [expiredEntry({ id: 'a1', enabled: false })] })

    await call('credits.balances', { provider: 'minimax' })

    expect(calls).toHaveLength(1)
  })

  it('★ refreshable:false 也照样自愈（不得拿这个镜像布尔当门禁）', async () => {
    // AGENTS.md 铁律：池里的 refreshable 是**凭据材料的镜像**，可能因一次瞬时
    // 失败被误标成 false；拿它当过滤条件会让账号**永不进入**续期循环。
    // 能否续期由各家 auth 内部按凭据材料判断（缺 refresh_token 时抛
    // 「请重新登录」），本层不预判。
    const { call, calls } = setup({
      accounts: [expiredEntry({ id: 'a1', refreshable: false })],
    })

    await call('credits.balances', { provider: 'minimax' })

    expect(calls).toHaveLength(1)
  })

  it('★ 续期失败**不上抛**：仍回 ok:false/true 由上游决定，并留下 warn', async () => {
    const { call, calls, warns } = setup({
      accounts: [expiredEntry({ id: 'a1' })],
      auths: {
        minimax: async () => { throw new Error('refresh_token 已失效') },
      },
    })

    const result = await call('credits.balances', { provider: 'minimax' })

    // 续期确实被尝试了（不是静默跳过）
    expect(calls).toHaveLength(1)
    // ⚠️ 端点仍成功返回：凭据本来就过期，直连上游必然 401，
    // 让整条积分行报「续期失败」比原来的「HTTP 401」更难懂。
    expect(result.ok).toBe(true)
    // 但必须留痕，否则排障时看不到自愈发生过
    expect(warns.some((w) => w.includes('refresh_token 已失效'))).toBe(true)
  })

  it('★ loomy / zcode / opencode **静默跳过**：不续期、也不留误导性 warn', async () => {
    // ⚠️ 这条原先是「不续期」—— 用 throw + catch 吞掉实现的，于是**每次刷新
    // 面板都为每个过期 loomy 账号刷一条** `自愈续期失败：loomy 不支持…`。
    // loomy 的池内 `expiresAt` 是登录时本地按 14 天推算的固定值
    //（`loomy-auth.ts` 的 LOOMY_SESSION_TTL_SECONDS）、之后永不变更 ⇒ 14 天后
    // **确定可达**，属必然噪音（AGENTS.md：「重复同一行会把有用信息埋掉」）。
    // 故这里同时锁「不发请求」与「不记 warn」两件事 —— 只锁前者会漏掉噪音。
    for (const provider of ['loomy', 'zcode', 'opencode']) {
      const h = setup({ accounts: [expiredEntry({ id: `id-${provider}`, provider })] })
      await h.call('credits.balances', { provider })

      expect(h.calls, `${provider} 不应发起续期`).toEqual([])
      // ⚠️ 关键断言：跳过**不是失败**，不得留下任何告警。
      expect(
        h.warns.filter((w) => w.includes('自愈续期失败')),
        `${provider} 不应把「设计上不支持」记成续期失败`,
      ).toEqual([])
    }
  })

  it('★ 已过期账号必须**先续期、再查余额**（顺序语义，非「顺便发起」）', async () => {
    // ⚠️ 对抗审计实测的盲区：原先把 `await task` 改成 `void task`（不等待），
    // 12 条测试**全绿** —— 而「先续期再查余额」正是本改动存在的理由。
    // 判据：续期**完成**必须早于余额查询**开始**（用事件序列见证，而不是
    // 只看「有没有被调用」）。
    const events: string[] = []
    const { call } = setup({
      accounts: [expiredEntry({ id: 'a1' })],
      auths: {
        minimax: async () => {
          events.push('refresh:start')
          await new Promise((r) => setTimeout(r, 20))
          events.push('refresh:end')
        },
      },
      // 凭据解析是余额查询路径的第一步 ⇒ 它出现即代表「已进入余额查询」。
      onResolve: () => { events.push('balance:resolve') },
    })

    await call('credits.balances', { provider: 'minimax' })

    // ⚠️ 若改成 `void`，balance:resolve 会先于 refresh:end 出现 ⇒ 断言红。
    expect(events).toEqual(['refresh:start', 'refresh:end', 'balance:resolve'])
  })

  it('★ 多账号自愈必须**逐个串行**，不得并行（避免并发触发风控）', async () => {
    // ⚠️ 对抗审计实测的盲区：把循环改成 `Promise.all(accounts.map(...))` 后
    // 17 条测试全绿 —— 而「顺序执行避免并发触发风控」正是本端点既有约定
    //（`collectCreditBalances` 的注释），且并发续期还有轮换 token 的覆盖风险。
    // ⚠️ 单账号用例**测不出**这件事（一个账号时串行与并行不可区分），
    // 故必须用**两个**账号并断言「第二个在第一个结束之后才开始」。
    const events: string[] = []
    const { call } = setup({
      accounts: [expiredEntry({ id: 'a1' }), expiredEntry({ id: 'a2' })],
      auths: {
        minimax: async (_ref, _pool, id) => {
          events.push(`start:${id}`)
          await new Promise((r) => setTimeout(r, 15))
          events.push(`end:${id}`)
        },
      },
    })

    await call('credits.balances', { provider: 'minimax' })

    // 并行时顺序会是 start:a1, start:a2, end:a1, end:a2 ⇒ 断言红。
    expect(events).toEqual(['start:a1', 'end:a1', 'start:a2', 'end:a2'])
  })

  it('★ 同一账号并发自愈只发一次续期请求（在飞去重）', async () => {
    // ⚠️ 对抗审计实测的真实缺陷：本端点是用户可反复触发的（`loadCredits` 有
    // 四个调用点且无重入闸门；徽标每 60s 轮询走同一个 `handleMethod`），
    // 而**续期会轮换 refresh_token** —— 并发会让「后写的把先写的新 token
    // 覆盖成已失效的旧 token」（AGENTS.md 记过 codearts 那次事故）。
    let refreshCount = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { call } = setup({
      accounts: [expiredEntry({ id: 'a1' })],
      auths: {
        minimax: async () => { refreshCount += 1; await gate },
      },
    })

    // 两次「同时」的积分查询（第一次挂在续期上，第二次进来时仍在飞）。
    const first = call('credits.balances', { provider: 'minimax' })
    await new Promise((r) => setTimeout(r, 10))
    const second = call('credits.balances', { provider: 'minimax' })
    await new Promise((r) => setTimeout(r, 10))
    release()
    await Promise.all([first, second])

    expect(refreshCount, '并发自愈必须共享同一次续期').toBe(1)
  })

  it('★ 自愈失败后**放行下一次**（不得把该账号永久焊死）', async () => {
    // 与 `SerialQueue` 的「失败也必须放行下一个」同一条教训：若在失败路径上
    // 忘记从在飞表里删除，一次瞬时失败会让该账号的自愈在本次会话内永不生效。
    let attempts = 0
    const { call, warns } = setup({
      accounts: [expiredEntry({ id: 'a1' })],
      auths: {
        minimax: async () => { attempts += 1; throw new Error('网络抖动') },
      },
    })

    await call('credits.balances', { provider: 'minimax' })
    await call('credits.balances', { provider: 'minimax' })

    expect(attempts, '第二次仍应重试').toBe(2)
    expect(warns.filter((w) => w.includes('网络抖动')).length).toBe(2)
  })

  it('逐账号顺序自愈（顺序查询，避免并发触发风控）', async () => {
    const { call, calls } = setup({
      accounts: [
        expiredEntry({ id: 'a1' }),
        expiredEntry({ id: 'a2', expiresAt: Date.now() + 60_000 }), // 未过期，跳过
        expiredEntry({ id: 'a3' }),
      ],
    })

    await call('credits.balances', { provider: 'minimax' })

    expect(calls.map((c) => c.accountId)).toEqual(['a1', 'a3'])
  })

  it('各家都有自愈分派（codearts / raccoon / gemini 等短寿命 provider）', async () => {
    for (const provider of ['codearts', 'raccoon', 'gemini', 'buddy', 'workbuddy', 'qodercn']) {
      const h = setup({ accounts: [expiredEntry({ id: `id-${provider}`, provider })] })
      await h.call('credits.balances', { provider })
      expect(
        h.calls.map((c) => c.provider),
        `${provider} 未被自愈分派接住`,
      ).toEqual([provider])
    }
  })

  it('qodercn 必须刷**中国版**实例（不能写死 qoder，否则刷错凭据）', async () => {
    // 两站 token 不通用：写死 qoder 会让 CN 永远续不动而国际版被无谓刷一次。
    // 该串用由 `lobsterai-rpc-dispatch.spec.ts` 的行为级用例锁死（反向验证过）。
    const { call, calls } = setup({ accounts: [expiredEntry({ id: 'cn', provider: 'qodercn' })] })

    await call('credits.balances', { provider: 'qodercn' })

    expect(calls).toEqual([{ provider: 'qodercn', ref: 'MINIMAX_ACCOUNT_1', accountId: 'cn' }])
  })

  it('account.refresh 端点仍按 provider 分派（含 loomy / zcode 的探测路径）', async () => {
    const h = setup({ accounts: [expiredEntry({ id: 'r1', provider: 'codearts' })] })

    const result = await h.call('account.refresh', { accountId: 'r1' })

    expect(result.ok).toBe(true)
    expect(h.calls).toHaveLength(1)
  })

  it('★ 未知 provider 报 `Unknown provider`（文案不得语义错位）', async () => {
    // ⚠️ 对抗审计实测的真实缺陷：分派抽成共享表后，default 一度对 loomy /
    // zcode / opencode 抛「不支持在**积分查询前**自动续期」—— 而
    // `account.refresh` 根本没有「积分查询前」这个上下文。
    //
    // ⚠️ 2026-10-10（合并 master）：master 的 provider 抽象重构把这里的文案
    // **改得更精确**了 —— 它区分两种情况（`provider-abstraction-g3-exceptions.md`
    // 登记的有意变更）：
    //   - 未注册的 id      ⇒ `Unknown provider: X`
    //   - 注册了但不支持续期 ⇒ `Provider X 不支持续期（它的凭据不是可续期类型）`
    // opencode 属**后者**（它是已注册的渠道，只是凭据是静态 API key），
    // 故这里断言后者。两种都**不含**「积分查询前」那个错位措辞。
    const h = setup({ accounts: [expiredEntry({ id: 'x1', provider: 'opencode' })] })

    const result = await h.call('account.refresh', { accountId: 'x1' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('opencode')
    expect(result.error?.message).not.toContain('积分查询前')
  })

  it('★ 真正未注册的 provider id 报 `Unknown provider`', async () => {
    const h = setup({ accounts: [expiredEntry({ id: 'y1', provider: 'not-a-channel' })] })

    const result = await h.call('account.refresh', { accountId: 'y1' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('Unknown provider: not-a-channel')
  })

  /**
   * ⚠️ **边界与类型判据**（对抗审计实测的两个测试盲区：改成 `<` 或删掉
   * `typeof` 时**没有任何**用例变红）。这两条不是同义反复，而是分别锁住
   * 「临界时刻算不算过期」与「非数字值不得被 JS 强制转换后误判」。
   */
  /**
   * ⚠️ **边界必须用冻结时钟**（对抗审计实测的高危点，初版是**概率性**守卫）。
   *
   * 初版写法：用例内 `const now = Date.now()`，随后 heal 内部**再调一次**
   * `Date.now()` —— 两次调用**跨毫秒**才检出 `<` 变异。实测同一副本单文件
   * 跑 20 次：变异后 **10 红 10 绿（50%）**，而全量 CI 下 **0 检出**。
   * 一条只在 50% 情况下生效的守卫，等于没有。
   *
   * ⇒ 用 `vi.setSystemTime` 把 `Date.now()` 钉死，令 `expiresAt` 与判据里的
   * `Date.now()` **严格相等**，`<=` 与 `<` 的差异因此**确定可判**。
   */
  it('★ 恰好等于当前时刻算过期（`<=` 边界，不是 `<`）', async () => {
    vi.useFakeTimers()
    try {
      const frozen = new Date('2030-01-01T00:00:00.000Z')
      vi.setSystemTime(frozen)
      // ⚠️ 冻结后 Date.now() 恒为 frozen.getTime()；expiresAt 与它**严格相等**。
      const { call, calls } = setup({
        accounts: [expiredEntry({ id: 'a1', expiresAt: frozen.getTime() })],
      })

      await call('credits.balances', { provider: 'minimax' })

      // 客户端判据是 `<= Date.now()`；宿主若写成 `<` 会出现「面板说已过期、
      // 宿主却不续期」的分叉（用户点刷新看不到任何自救）。
      // ⚠️ 这条断言现在是**确定性**的：改成 `<` 必红（冻结时钟不会跨毫秒）。
      expect(calls, '`<=` 边界：恰好到期即应续期').toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ 比当前时刻晚 1ms 不算过期（`<=` 的另一侧边界）', async () => {
    // 与上一条配对，锁住「不是无条件续期」——两条一起才能确定判据是 `<=`
    // 而不是 `<= 任何值`。
    vi.useFakeTimers()
    try {
      const frozen = new Date('2030-01-01T00:00:00.000Z')
      vi.setSystemTime(frozen)
      const { call, calls } = setup({
        accounts: [expiredEntry({ id: 'a1', expiresAt: frozen.getTime() + 1 })],
      })

      await call('credits.balances', { provider: 'minimax' })

      expect(calls, '未到期不应续期').toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ 非数字的 expiresAt 不得被强制转换后误判（`typeof` 检查）', async () => {
    // `expiresAt` 可从**用户可编辑的备份文件**导入，而 `sanitizeAccounts`
    // 不过滤该字段 ⇒ 池里可能是数字字符串。保留 `typeof` → 不续期（与客户端
    // 判据一致）；删掉 `typeof` → JS 强制转换判为过期 → 宿主与 UI 行为分叉。
    const { call, calls } = setup({
      accounts: [
        expiredEntry({ id: 's1', expiresAt: '1' as unknown as number }),
        expiredEntry({ id: 's2', expiresAt: '1791559805000' as unknown as number }),
      ],
    })

    await call('credits.balances', { provider: 'minimax' })

    expect(calls, '字符串形式的 expiresAt 不应触发续期').toEqual([])
  })

  /**
   * ★ **整轮预算**（对抗审计实测的真实缺陷）。
   *
   * 自愈是逐账号顺序 `await`，每家续期超时 20~60s ⇒ 39 个账号全过期时最坏
   * 约 39 分钟，发生在**用户点一下就等**的端点上。不设闸门的话，症状会从
   * 「积分行 401」**恶化成「整个端点超时、余额一起丢」**。
   *
   * ⚠️ 断言「到点后**停止继续自愈、但端点仍正常返回**」——
   * 不是「失败」：没来得及续期的账号交给下一轮远好于拿不到任何结果。
   */
  it('★ 自愈受整轮预算约束：到点即停，余下账号不续（但端点仍成功返回）', async () => {
    // 造 40 个过期账号；让每次续期「耗时」超过预算（用假时钟推进），
    // 这样第 2 个账号起就应被预算挡下。
    const accounts = Array.from({ length: 40 }, (_, i) => expiredEntry({ id: `a${i}` }))
    let refreshes = 0
    const { call, warns } = setup({
      accounts,
      auths: {
        minimax: async () => {
          refreshes += 1
          // ⚠️ 推进假时钟：模拟一次真实续期耗时（各家超时 20~60s）。
          // 预算是 60s，故推进 61s 后下一次循环必被挡下。
          vi.advanceTimersByTime(61_000)
        },
      },
    })

    vi.useFakeTimers()
    try {
      const result = await call('credits.balances', { provider: 'minimax' })
      // 端点必须仍然成功（不是整体失败）
      expect(result.ok).toBe(true)
      // 只续了第一个，其余被预算挡下 —— 而不是 40 个全跑
      expect(refreshes, '预算生效后不应继续续期').toBe(1)
      // 且必须留痕（否则用户/排查者看不到「本轮没跑完」）
      expect(warns.some((w) => w.includes('整轮预算'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * ★ `credits.claimAll` 的同一层自愈（issue IKKHL5）。
 *
 * 用户报障的场景里，「积分行报 HTTP 401」旁边**就挂着「一键领取积分」按钮**
 * —— 睡眠/挂起恢复后点它撞的是**同一个** 401。若只修余额查询，会出现
 * 「点刷新能看到余额、点领取却还是 401」这种自相矛盾的症状。
 */
describe('credits.claimAll 的按需自愈（与余额查询同一层）', () => {
  it('★ 已过期账号在领取前也会先续期', async () => {
    const { call, calls } = setup({ accounts: [expiredEntry({ id: 'a1' })] })

    await call('credits.claimAll', { provider: 'minimax' })

    expect(calls.map((c) => c.accountId)).toEqual(['a1'])
  })

  it('★ 领取路径同样要**先续期、再走领取流程**（顺序语义）', async () => {
    // 与余额端点同因：改成 `void` 就等于没修。
    const events: string[] = []
    const { call } = setup({
      accounts: [expiredEntry({ id: 'a1' })],
      auths: {
        minimax: async () => {
          events.push('refresh:start')
          await new Promise((r) => setTimeout(r, 15))
          events.push('refresh:end')
        },
      },
      // 凭据解析是领取流程的第一步 ⇒ 出现即代表「已进入领取」。
      onResolve: () => { events.push('claim:resolve') },
    })

    await call('credits.claimAll', { provider: 'minimax' })

    expect(events).toEqual(['refresh:start', 'refresh:end', 'claim:resolve'])
  })

  it('未过期账号在领取前不多发续期请求', async () => {
    const { call, calls } = setup({
      accounts: [expiredEntry({ id: 'a1', expiresAt: Date.now() + 60 * 60 * 1000 })],
    })

    await call('credits.claimAll', { provider: 'minimax' })

    expect(calls).toEqual([])
  })

  it('不签到的渠道（cline / workbuddy / raccoon）**不因自愈而改变拒绝行为**', async () => {
    // ⚠️ 这三家即使账号已过期也必须仍然返回「不支持签到」的可读错误 ——
    // 自愈不能把守卫的既有语义带偏（也不能因为续期失败就吞掉这条错误）。
    for (const provider of ['cline', 'workbuddy', 'raccoon']) {
      const h = setup({
        accounts: [expiredEntry({ id: `id-${provider}`, provider })],
        // 故意让续期失败：守卫必须在自愈失败后仍然生效。
        auths: { [provider]: async () => { throw new Error('boom') } },
      })
      const result = await h.call('credits.claimAll', { provider })
      expect(result.ok, `${provider} 应仍返回可读错误`).toBe(false)
      expect(result.error?.message).toContain('不支持每日签到')
    }
  })
})

/**
 * ★ **`SELF_HEAL_REFRESHABLE_PROVIDERS` 的漂移守卫**（对抗审计实测的零守卫缺口）。
 *
 * ## 为什么需要这组用例
 *
 * 那张 Set 是**硬编码手抄**的（`PROVIDER_REGISTRY` 里没有「有无 refresh 端点」
 * 这个字段，故硬编码本身可接受），而实际分派走 `authOf(auths, provider)`。
 * 两者**一旦漂移**就是静默缺陷：
 * - Set 少了某家 ⇒ 该家**永不参与自愈**（症状与本次要修的完全一样）；
 * - Set 多了不存在的 id ⇒ `refreshAccountByProvider` 抛错、被 catch 记一条噪音 warn。
 *
 * 对抗审计实测（独立副本变异）：**删掉 `TRAE.id` 或 `LOBSTERAI.id` ⇒ 零测试变红**；
 * 加一个假 id `'not-a-channel'` ⇒ 同样零变红。即这两类漂移此前**完全没有守卫**
 * ——「各家都有自愈分派」那条用例只覆盖了 codearts/raccoon/gemini/buddy/
 * workbuddy/qodercn，恰好漏掉 trae 与 lobsterai。
 *
 * 本组用例**逐家点名**（不写魔数、不写「>= N」），任何一家掉出 Set 都会红。
 */
describe('SELF_HEAL_REFRESHABLE_PROVIDERS 与真实分派的一致性', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const rpcSource = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')

  /**
   * 从源码里抽出 Set 的字面量成员与 `.id` 常量名。
   *
   * ⚠️ **只取 `new Set([...])` 的成员区间**，不从 `const` 起取整段 ——
   * 否则定义前的长篇注释会被一起扫进来，注释里的引号串会造成误报。
   *
   * ⚠️ 字面量正则用 `[^']+` 而不是 `[a-z]+`（初版教训）：对抗审计的假 id
   * `'not-a-channel'` 含连字符，`[a-z]+` **匹配不到它** ⇒ 加假 id 时
   * 三条守卫全绿（实测 V3 盲区）。用「引号内任意非引号字符」才能全覆盖。
   */
  function selfHealSetParts(): { literals: string[]; constants: string[] } {
    const declared = rpcSource.indexOf('const SELF_HEAL_REFRESHABLE_PROVIDERS')
    expect(declared, '未找到 SELF_HEAL_REFRESHABLE_PROVIDERS').toBeGreaterThan(-1)
    const open = rpcSource.indexOf('new Set([', declared)
    expect(open, '未找到 new Set([ 字面量').toBeGreaterThan(-1)
    const close = rpcSource.indexOf('])', open)
    expect(close).toBeGreaterThan(open)
    const body = rpcSource.slice(open + 'new Set(['.length, close)
    return {
      literals: [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!),
      constants: [...body.matchAll(/([A-Z][A-Z_]+)\.id/g)].map((m) => m[1]!),
    }
  }

  /**
   * 从源码里抽出 `JetHubAuths` 的键集合（= 生产路径上「有 auth 服务的渠道」）。
   *
   * ⚠️ 只取接口体区间（`interface {` 到第一个 `}`），不扫全文 —— 否则别处的
   * `readonly xxx:` 会被误算进来。
   */
  function jetHubAuthsKeys(): Set<string> {
    const start = rpcSource.indexOf('export interface JetHubAuths {')
    expect(start, '未找到 JetHubAuths 接口').toBeGreaterThan(-1)
    const end = rpcSource.indexOf('}', start)
    expect(end).toBeGreaterThan(start)
    /**
     * ⚠️⚠️ 正则必须允许**可选键** `readonly x?:`（2026-10-22 A6）。
     *
     * 旧写法 `/readonly (\w+):/` 对 `readonly codely?: CodelyAuth` **不匹配**
     * （`?` 不在 `(\w+)` 里）⇒ 可选键被**静默当成不存在**
     * ⇒ 下面那条「Set 里的每一个 id 都必须在 JetHubAuths 里有对应键」
     * 会把**真实存在的**键报成「假 id（会抛 Unknown provider）」。
     * ⚠️ 这正是本仓库记过的「判据漏一格 ⇒ 假红/假绿」形态：守卫自己的
     * 正则也要跟着契约的形状走。
     */
    return new Set(
      [...rpcSource.slice(start, end).matchAll(/readonly (\w+)\??:/g)].map((m) => m[1]!),
    )
  }

  /** `.id` 常量的运行期值（与源码里的常量名互为印证）。 */
  const ID_OF: Record<string, string> = {
    LOBSTERAI: 'lobsterai', QODER: 'qoder', QODER_CN: 'qodercn', TRAE: 'trae',
    CLINE: 'cline', RACCOON: 'raccoon', MINIMAX: 'minimax', GEMINI: 'gemini',
    OFFICEACE: 'officeace',
    ACCIO: 'accio',
    // ⚠️ MiniMax Code 国际版（2026-10-15）：常量名带下划线，与 id 不同形 ——
    //    与本表其余项同因（不能靠 `p.toUpperCase()` 推）。
    MINIMAX_INTL: 'minimaxintl',
    ASTUDIO: 'astudio',
    // ⚠️ AutoClaw（智谱，2026-10-17）：与本表其余项同因。
    AUTOCLAW: 'autoclaw',
    // ⚠️ AutoClaw 国际版（2026-10-20）：常量名带下划线，与 id 不同形（同 MINIMAX_INTL）。
    AUTOCLAW_INTL: 'autoclawintl',
    // ⚠️ Codely（Unity，2026-10-22 A6）：常量名 `CODERLY` 与 id `codely` 不同形
    //    （源码里叫 CODERLY、provider id 叫 codely）—— 同样不能靠大写推。
    CODERLY: 'codely',
  }

  /**
   * ⚠️ **刻意豁免的两家**：设计上**没有 refresh 端点**，其
   * `refreshAccountCredential` 做的是「有效性探测」，拿来当续期用只会白发请求
   * （理由的权威表述见 `src/jet-hub-rpc.ts` 的 `SELF_HEAL_REFRESHABLE_PROVIDERS`
   * 文档注释）。**豁免必须是显式且带理由的** —— 用「忘了登记」冒充豁免，
   * 正是本次复审抓到的缺陷形态（accio 就是这样漏掉的）。
   */
  const SELF_HEAL_EXEMPT: ReadonlyMap<string, string> = new Map([
    ['loomy', 'Loomy 没有 refresh 端点，refreshAccountCredential 只是有效性探测'],
    ['zcode', 'ZCode 同上：没有 refresh 端点，探测当续期用只会白发请求'],
    // ⚠️ **本 fork 独有**（modelscope，2026-10-16 登记；2026-10-17 **改判**）。
    //
    // ⚠️⚠️ **原理由①已作废**：它写的是「`credits.balance === false`（平台没有
    //    额度 API）⇒ 自愈链的触发点压根不会为它走到续期那一步」。
    //    **那条已被证伪**：魔搭**有**魔粒余额端点（`/openapi/v1/magicubes/balance`，
    //    带 API Key 返 200），`balance` 已改为 `true` ⇒ **积分端点现在确实会为它触发**。
    //    若只把①删掉而不写清②，会让后人以为「漏登记 = 忘了补」⇒ 可能真把它塞进 Set。
    //
    // ⇒ **仍然豁免的依据只剩②**，且它比 loomy / zcode 更根本：
    //    魔搭的凭据是**长期有效的静态 API Key**（`expires_at` 可选，实测 Key 默认
    //    不过期）⇒ **没有「快过期」这回事**，自愈链对它无事可做。
    //    `refreshAccountCredential` 按统一接口做有效性对账（回写池内 `expiresAt`），
    //    但它不发任何网络请求 ⇒ 调它等于白发一次本地读。
    //
    // ⚠️ 判据「有没有 refresh 端点」与「余额能不能读」是**两件事**：
    //    正因为余额现在能读了，才更需要显式说明「仍不进 Set」的理由。
    ['modelscope', '无 refresh 端点：凭据是长期有效的静态 API Key（expires_at 可选、实测默认不过期）⇒ 没有「快过期」，自愈链无事可做（余额能读不等于能续期，两件事）'],
    // ⚠️ **本 fork 独有**（qiniu，2026-10-29）：理由比 modelscope 更**彻底** ——
    //    ① 凭据是长期有效的静态 API Key（官方明示 `sk-` 开头、无过期语义、
    //       无 refresh 端点）⇒ 没有「快过期」；
    //    ② `credits.balance: false`（七牛云**没有余额端点**，用量只在控制台可见）
    //       ⇒ 积分端点压根不会为它触发自愈链。
    //    两层独立理由都指向「无事可做」。⚠️ 必须显式登记：本表是**反向守卫**
    //    （`JetHubAuths` 每个键都必须在自愈表或本表里），漏登记即红。
    ['qiniu', '无 refresh 端点 + 无余额端点：凭据是长期有效的静态 API Key（sk- 开头、默认不过期）⇒ 没有「快过期」；credits.balance: false ⇒ 积分端点也不会为它触发自愈链'],
    // ⚠️ **MonkeyCode**（`monkeycode`，2026-11-02）：理由与 modelscope **同型**
    //    （余额能读 ≠ 能续期，两件事）：
    //    ① 凭据是长期有效的静态 API Key（白泽 `sk-…` / 网关 `oma_…`），
    //       官方**没有 refresh 端点、也没有过期时刻**（`expires_at` 字段通常缺失，
    //       缺失时 `isMonkeycodeExpired` 恒 false）⇒ 没有「快过期」这回事；
    //    ② 即便 `credits.balance: true`（平台有 `GET /api/v1/users/wallet`），
    //       自愈链的终点 `refreshAccountCredential` 也只是本地有效期对账
    //       （`syncAccountExpiry`，零网络）⇒ 调它等于白发一次本地读。
    //    ⚠️ 必须显式登记：本表是**反向守卫**（`JetHubAuths` 每个键都必须在
    //    自愈表或本表里），漏登记即红。
    ['monkeycode', '无 refresh 端点：凭据是长期有效的静态 API Key（oma_ + signing_secret，expires_at 通常缺失）⇒ 没有「快过期」，自愈链无事可做（余额能读不等于能续期，两件事）'],
    // ⚠️ **国际站（`monkeycodeintl`，2026-11-02）**：与国内站**完全同源**
    //    （同一个 `MonkeycodeAuth` 类、同一套凭据形状，只差 `product`）
    //    ⇒ 豁免理由逐字相同。两站必须各登记一行：本表是**反向守卫**
    //    （`JetHubAuths` 每个键都必须在自愈表或本表里），漏一行即红。
    ['monkeycodeintl', '无 refresh 端点：与国内站同源（静态 oma_ + signing_secret，expires_at 通常缺失）⇒ 没有「快过期」，自愈链无事可做'],
    // ⚠️ 百智云（2026-11-02）：凭据是用户手工粘贴的 `sk-…` 静态材料，`BaizhiAuth`
    //    没有 `refresh` 端点（`isBaizhiRefreshable()` 恒 false）⇒ 不存在「快过期」，
    //    自愈链无事可做。可核对：`src/baizhi-auth.ts` 全文无 `fetch(` 续期调用，
    //    只有 `refreshAccountCredential` 的有效期对账（与 qiniu / loomy 同型）。
    ['baizhi', '静态 sk- API Key，无 refresh 端点（只有有效期对账，没有续期请求）⇒ 自愈链无事可做'],
  ])

  it('★ Set 里的字面量恰好是 codearts / buddy / workbuddy（多一个少一个都红）', () => {
    const { literals } = selfHealSetParts()
    // ⚠️ 2026-11-01 加 `magicrewintl`（MagiCrew 国际版）：与 `magicrew` 同形 ——
    //    两站共用同一个 `mgw_` key（**2 小时**寿命）与同一个 refresh 端点。
    expect(literals.slice().sort()).toEqual(['buddy', 'codearts', 'magicrew', 'magicrewintl', 'workbuddy'])
  })

  it('★ Set 里的 `.id` 常量恰好是登记的那些家（逐家点名，不写魔数阈值）', () => {
    // ⚠️ 逐家列举而不是 `expect(constants.length).toBeGreaterThanOrEqual(10)` ——
    // 后者在「删掉 trae、加上一个假的」时**仍然通过**，正是审计实测的漏报形态。
    // ⚠️ 标题刻意**不写家数**：原写「十二家」时实际已是 13 项（astudio 加入后没人
    //    回头改数字）—— 快照式数字必然腐坏（本仓库既有教训）。
    const { constants } = selfHealSetParts()
    expect(constants.slice().sort()).toEqual([
      'ACCIO', 'ASTUDIO', 'AUTOCLAW', 'AUTOCLAW_INTL', 'CLINE', 'CODERLY', 'GEMINI',
      'LOBSTERAI', 'MINIMAX', 'MINIMAX_INTL', 'OFFICEACE', 'QODER', 'QODER_CN', 'RACCOON',
      'TRAE',
    ])
  })

  it('★ Set 的成员逐家正确，且 loomy / zcode 必须不在其中', () => {
    const { literals, constants } = selfHealSetParts()
    const inSet = new Set([...literals, ...constants.map((c) => ID_OF[c] ?? c)])
    expect([...inSet].sort()).toEqual([
      'accio', 'astudio', 'autoclaw', 'autoclawintl', 'buddy', 'cline', 'codearts', 'codely',
      'gemini', 'lobsterai', 'magicrew', 'magicrewintl', 'minimax', 'minimaxintl', 'officeace',
      'qoder', 'qodercn', 'raccoon', 'trae', 'workbuddy',
    ])
    // 反向：两家没有 refresh 端点，必须**静默跳过**而非尝试续期。
    expect(inSet.has('loomy')).toBe(false)
    expect(inSet.has('zcode')).toBe(false)
  })

  /**
   * ★★ **根治守卫**：Set 的成员关系**从 `PROVIDER_REGISTRY` 派生**，不再手抄。
   *
   * ## 为什么上面那几条还不够（2026-10-13 审计实测）
   *
   * 「逐家点名」只锁住了**当时已知的那些家**（3 个字面量 + 10 个 `.id` 常量）。
   * 它拦得住「删掉 trae」「加个假 id」，
   * 却**拦不住下一个 provider 加进来时被漏掉** —— officeace（**第 15 个**）
   * 就是这么漏的（症状与 issue IKKHL5 逐字相同：睡眠/挂起恢复后积分行报 401、日志零字）。
   *
   * ⚠️ 这正是 `docs/agent-notes/providers-accio.md` 记的「接线陷阱（新 provider 通用）」：
   * **加 provider 的人不会去看这张手抄的 Set**，而漏接的代价是静默的。
   *
   * ## 判据从哪来
   *
   * 取「声明了余额能力（`credits.balance === true`）」**且**「是渠道（`channel`）」
   * **且**「不是静态凭据/匿名渠道」的集合。
   *
   * ⚠️ **豁免表必须显式写出来，不许靠「反正都不在」**——否则将来有人给
   * loomy / zcode / opencode 加上余额能力时会得到一条**难以理解**的红。
   */
  it('★★ 每个「有余额能力的渠道」都必须在自愈 Set 里（漏一家即红，不许静默）', () => {
    // 没有 refresh 端点 / 静态凭据 / 匿名通道 ⇒ 自愈对它们没有意义（强行调只会抛）。
    const NO_REFRESH_ENDPOINT = new Map<string, string>([
      ['loomy', '无 refresh 端点：refreshAll 只探测有效性，拿它当续期用只会白发请求'],
      ['zcode', '静态 API Key 凭据，无 OAuth 续期'],
      ['opencode', '匿名通道，无凭据可续'],
      ['aggregate', '虚拟渠道，无自有凭据'],
      ['auto', '虚拟渠道（auto-adapter 聚合），无自有凭据'],
      // ⚠️ **本 fork 独有**（魔搭，2026-10-17）。与 zcode **同型**：静态 API Key
      //    凭据、无 OAuth 续期、`expires_at` 可选且实测默认不过期 ⇒ 没有「快过期」。
      //    ⚠️ 别被它的 `credits.balance === true` 误导：**余额能读**（魔粒端点
      //    `/openapi/v1/magicubes/balance` 带 API Key 返 200）与**凭据能续**是两件
      //    独立的事；前者为真不推出后者。自愈链对它无事可做 ⇒ 必须豁免。
      ['modelscope', '静态 API Key 凭据、无 refresh 端点（余额能读 ≠ 凭据能续）'],
      // ⚠️ **本 fork 独有**（MonkeyCode，2026-11-02）。与 modelscope **同型**：
      //    凭据是长期有效的静态 API Key（白泽 `sk-…` / 网关 `oma_…`），官方
      //    没有 refresh 端点、也没有过期时刻（`expires_at` 通常缺失）⇒ 没有
      //    「快过期」。它的 `credits.balance === true`（平台有 wallet 端点）
      //    只说明**余额能读**，而自愈链要的是**凭据能续** —— 两件独立的事。
      ['monkeycode', '静态 API Key 凭据（oma_ + signing_secret）、无 refresh 端点（余额能读 ≠ 凭据能续）'],
      ['monkeycodeintl', '与国内站同源：静态 oma_ + signing_secret、无 refresh 端点（余额能读 ≠ 凭据能续）'],
      // ⚠️ 百智云（`baizhi`，2026-11-02）：`credits.balance === true`（控制台
      //    `GET /api/v1/user/wallet/balance` 带 cookie 返 200），但凭据是
      //    长期有效的静态材料（`sk-…` + 控制台 cookie），`BaizhiAuth` 没有
      //    refresh 端点（`isBaizhiRefreshable()` 恒 false）⇒ 没有「快过期」。
      //    ⚠️ 与 modelscope 同型：**余额能读 ≠ 凭据能续**，前者为真不推出后者。
      ['baizhi', '按量计费静态凭据（sk- 推理 + 控制台 cookie 读积分）、无 refresh 端点（余额能读 ≠ 凭据能续）'],
    ])
    const { literals, constants } = selfHealSetParts()
    const inSet = new Set([...literals, ...constants.map((c) => ID_OF[c] ?? c)])

    /**
     * ⚠⚠ **判据不得再用 `d.channel`**（2026-10-22 对抗审计 M-2）。
     *
     * 旧写法 `.filter((d) => d.channel && d.credits.balance === true …)` 把
     * 「该不该自愈」挂在 `channel` 上，而 `channel` 是**目录可见性 / 是否参与聚合**的
     * 声明，与「凭据能不能续」是**两件事**。codely 当时 `channel: false`
     * ⇒ 被这条判据**自动豁免**，而本表存在的**唯一理由**就是
     * 「拓展新 provider 时漏登记会变红」（accio 就是这样漏的）—— 用错字段等于
     * 把守卫变成**恒真**。
     *
     * ⇒ 改成「有余额能力 && 不在显式豁免表」，不看 `channel`。
     *   ⚠️ 虚拟渠道（`aggregate` / `auto`）已在 `NO_REFRESH_ENDPOINT` 里逐条登记理由。
     */
    const expected = PROVIDER_REGISTRY
      .filter((d) => d.credits.balance === true && !NO_REFRESH_ENDPOINT.has(d.id))
      .map((d) => d.id)
      .sort()

    // 反向：Set 里的每个成员都必须是有余额能力的渠道（防「加了不该自愈的渠道」）。
    const withBalance = new Set(
      PROVIDER_REGISTRY.filter((d) => d.credits.balance === true).map((d) => d.id),
    )
    for (const id of inSet) {
      expect(withBalance.has(id), `自愈 Set 里的 ${id} 没有声明余额能力，登记理由是什么？`)
        .toBe(true)
    }
    expect([...inSet].sort(), '自愈 Set 漏了渠道（症状：睡眠后积分行 401 且日志零字）')
      .toEqual(expected)
  })

  it('★ Set 里的每一个 id 都必须在 JetHubAuths 里有对应键（不得有假 id）', () => {
    // 对抗审计实测：加一个 `'not-a-channel'` 到 Set ⇒ 零测试变红，而运行期
    // 它会走 refreshAccountByProvider → authOf 查不到 → 抛错 → 被 catch
    // 记一条噪音 warn。这条锁住「Set ⊆ Auths 的键」。
    const keys = jetHubAuthsKeys()
    const { literals, constants } = selfHealSetParts()
    for (const id of [...literals, ...constants.map((c) => ID_OF[c] ?? c)]) {
      expect(keys.has(id), `Set 里的 ${id} 在 JetHubAuths 里没有对应键（会抛 Unknown provider）`)
        .toBe(true)
    }
  })

  /**
   * ★★ **反向守卫：`JetHubAuths` 的每个键都必须在 Set 里**（除非显式豁免）。
   *
   * ## ⚠️ 为什么必须补这一条（2026-10-12 复审实测的真实缺陷）
   *
   * 上面那条只锁了 `Set ⊆ Auths 的键`（挡住假 id）。**反方向没有任何守卫** ——
   * 于是 Task 7 把 `accio` 加进 `JetHubAuths` 却忘了加进 Set 时，**全绿**：
   * 而症状是 `healExpiredAccountBeforeBalance` 在
   * `SELF_HEAL_REFRESHABLE_PROVIDERS.has(entry.provider)` 处短路 ⇒
   * accio 的过期账号**永不参与自愈**，`credits.balances` 拿陈旧凭据直连上游 ⇒
   * 面板报「未登录」，而 `refresh_token` 完好 —— **正是 issue IKKHL5 的形态**。
   *
   * ## 为什么必须逐键点名（而不是「两边长度相等」）
   *
   * 长度相等在「新增一家进 Auths、另一家掉出 Set」时**仍然通过**（等量替换），
   * 而那恰好是位置错位那类静默缺陷。逐键 `for` + 失败信息带 id 才能点名。
   */
  it('★★ JetHubAuths 的每个键都在 Set 里，或落在显式豁免表里（漏登记即点名变红）', () => {
    const keys = jetHubAuthsKeys()
    // 自证这条守卫不是空跑：键集合必须真的是「全部渠道」，不是被正则漏算后的残集。
    expect(keys.size, 'JetHubAuths 键集合被解析成了空集/残集，守卫会假绿').toBeGreaterThan(10)
    expect(keys.has('accio'), 'JetHubAuths 里应有 accio（Task 7 已接线）').toBe(true)

    const { literals, constants } = selfHealSetParts()
    const inSet = new Set([...literals, ...constants.map((c) => ID_OF[c] ?? c)])
    for (const key of [...keys].sort()) {
      const exemptReason = SELF_HEAL_EXEMPT.get(key)
      if (exemptReason !== undefined) {
        // 豁免的家**不得**同时在 Set 里（否则豁免表是僵尸项、两处判断分叉）。
        expect(inSet.has(key), `${key} 已在豁免表里，就不该再出现在 Set 里`).toBe(false)
        continue
      }
      expect(
        inSet.has(key),
        `JetHubAuths 有 ${key}，但它不在 SELF_HEAL_REFRESHABLE_PROVIDERS 里 ⇒ `
        + '该家的过期账号**永不参与自愈**（积分行会报「未登录」，而凭据其实能续，'
        + 'issue IKKHL5 的形态）。若它确实没有 refresh 端点，'
        + '请把它加进本文件的 SELF_HEAL_EXEMPT 并写明可核对的理由。',
      ).toBe(true)
    }
  })

  /**
   * ★ accio **行为级**自愈（与源码层守卫互为印证）。
   *
   * 源码级断言（上面两条）只能证明「名字在集合里」；这条证明「运行期真的会
   * 为 accio 发起续期」。反向验证：从 Set 里删掉 `ACCIO.id` ⇒ 本条与上面
   * 那条反向守卫**同时**变红。
   */
  it('★ accio 的过期账号会先续期再查余额（不漏接新 provider）', async () => {
    const { call, calls } = setup({
      accounts: [expiredEntry({ id: 'accio-1', provider: 'accio', credentialRef: 'ACCIO_ACCOUNT_1' })],
    })

    await call('credits.balances', { provider: 'accio' })

    expect(calls).toEqual([
      { provider: 'accio', ref: 'ACCIO_ACCOUNT_1', accountId: 'accio-1' },
    ])
  })
})