import { describe, expect, it } from 'vitest'
import {
  KEEPALIVE_MAX_IDLE_MS,
  shouldRefreshNow,
  shouldRefreshNowWithRefreshExpiry,
} from '../../src/expiry-sync.js'
import { REFRESH_LEAD_MS } from '../../src/refresh.js'
import {
  credentialExpiresAtMs,
  credentialIssuedAtMs,
  jwtIssuedAtMs,
} from '../../src/buddy.js'

/**
 * **保活续期判据**（GitHub issue #124，2026-11-19）。
 *
 * ## 缺陷
 *
 * CodeBuddy（`buddy`，`copilot.tencent.com`）的 access_token 有效期以**天**计。
 * 本机解出三批样本的 TTL 分别是 **60 / 30 / 28 天**（上游在持续收缩），而
 * lead-time 判据只在「距过期不足 {@link REFRESH_LEAD_MS}（1 小时）」放行
 * ⇒ 28 天里每一轮（每 30 分钟一次）都被跳过 ⇒ `refresh_token` 闲置 28 天后
 * 被服务端**作废**：
 *
 * ```
 * POST /v2/plugin/auth/token/refresh
 * → 401 {"code":12153,"msg":"12153:refresh token is invalid"}
 * ```
 *
 * 用户看到「凭据过期 / API 密钥无效」，面板写 `refreshable: false`，唯一出路是
 * 重登 —— 且按原实现 **28 天后必复发**。
 *
 * ## 修法
 *
 * 判据增加一条「距上次刷新满 {@link KEEPALIVE_MAX_IDLE_MS}」的腿。`iat` 在续期
 * 后会重签 ⇒ 它天然就是「上次刷新时刻」，不需要新字段。
 *
 * ## ⚠️ 为什么不用 issue 建议的「固定天数 / TTL 比例」
 *
 * 60 天那批按 20% 会给 12 天，若服务端闲置窗口是 14 天就贴线；而 TTL 一旦再缩到
 * 3 天，N=7 又不够。**按「距上次刷新的时长」与 TTL 无关**，是唯一不随批次漂移的判据。
 */

/** 造一份**可解码**的最小 JWT（只有 payload，签名段是占位；本仓不验签）。 */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64').replace(/=+$/, '')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.c2ln`
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-19T12:00:00+08:00')

describe('KEEPALIVE_MAX_IDLE_MS：7 天的取舍', () => {
  it('★ 必须是 7 天（改动这个值等于改动「多久烧一次 refresh_token」，要有意识）', () => {
    expect(KEEPALIVE_MAX_IDLE_MS).toBe(7 * DAY)
  })

  it('★ 必须**远小于**已知最紧的一批 access TTL（28 天），否则缺陷原样复发', () => {
    expect(KEEPALIVE_MAX_IDLE_MS).toBeLessThan(28 * DAY / 2)
  })

  it('★ 必须**远大于**调度周期（30 分钟），否则每一轮都会真发一次续期请求', () => {
    // 每轮都刷会把一次性 refresh_token 提前耗光（本仓 2026-10-27 两次同型事故）。
    expect(KEEPALIVE_MAX_IDLE_MS).toBeGreaterThan(2 * 30 * 60 * 1000)
  })
})

describe('shouldRefreshNowWithRefreshExpiry：保活腿', () => {
  const farFuture = NOW + 20 * DAY

  it('★★ 闲置满 7 天 ⇒ 即使 access 还有 20 天也**要刷**（本 issue 的核心格）', () => {
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: farFuture,
      refreshExpiresAtMs: undefined,
      issuedAtMs: NOW - KEEPALIVE_MAX_IDLE_MS,
      nowMs: NOW,
    })).toBe(true)
  })

  it('★★ 闲置 6 天 ⇒ **不刷**（还没到窗口，别白烧 refresh_token）', () => {
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: farFuture,
      refreshExpiresAtMs: undefined,
      issuedAtMs: NOW - (KEEPALIVE_MAX_IDLE_MS - DAY),
      nowMs: NOW,
    })).toBe(false)
  })

  it('★★ 边界：正好满 7 天 ⇒ 刷（`>=`，与 `shouldRefreshNow` 的 `<=` 对称）', () => {
    const issuedAtMs = NOW - KEEPALIVE_MAX_IDLE_MS
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: farFuture, refreshExpiresAtMs: undefined, issuedAtMs, nowMs: NOW,
    })).toBe(true)
    // 差 1 毫秒 ⇒ 不刷
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: farFuture, refreshExpiresAtMs: undefined, issuedAtMs: issuedAtMs + 1, nowMs: NOW,
    })).toBe(false)
  })

  it('★★ 读不到 `iat` ⇒ **退回改造前的行为**（fail-open，不是 fail-closed）', () => {
    // fail-closed 会让所有解不出 JWT 的凭据每 30 分钟被无谓刷一次
    // —— 正是 `REFRESH_LEAD_MS` 那次事故的形态。
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: farFuture, refreshExpiresAtMs: undefined, issuedAtMs: undefined, nowMs: NOW,
    })).toBe(false)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(shouldRefreshNowWithRefreshExpiry({
        expiresAtMs: farFuture, refreshExpiresAtMs: undefined, issuedAtMs: bad, nowMs: NOW,
      }), String(bad)).toBe(false)
    }
  })

  it('★ `keepAliveMaxIdleMs: Infinity` ⇒ 关掉这条腿（等价于改造前）', () => {
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: farFuture,
      refreshExpiresAtMs: undefined,
      issuedAtMs: NOW - 300 * DAY,
      keepAliveMaxIdleMs: Number.POSITIVE_INFINITY,
      nowMs: NOW,
    })).toBe(false)
  })

  it('★★ **九家回归面**：不传 `issuedAtMs` 时逐格与改造前相同', () => {
    /**
     * `shouldRefreshNowWithRefreshExpiry` 是**共享判据层**，`shouldRefreshNow`
     * 更是九家共用（accio / autoclaw / gemini / magicrew / marvis / officeace /
     * buddy / cline / codearts）。没提供 `issuedAtOf` 的家必须**逐字节不变**。
     */
    const expiresCases = [undefined, Number.NaN, NOW + 10 * DAY, NOW + 2 * 60 * 60 * 1000,
      NOW + REFRESH_LEAD_MS, NOW + REFRESH_LEAD_MS - 1, NOW, NOW - DAY]
    const refreshCases = [undefined, NOW + 30 * DAY, NOW + REFRESH_LEAD_MS + 1,
      NOW + REFRESH_LEAD_MS, NOW, NOW - DAY]
    for (const expiresAtMs of expiresCases) {
      for (const refreshExpiresAtMs of refreshCases) {
        const legacy = shouldRefreshNowWithRefreshExpiry({
          expiresAtMs, refreshExpiresAtMs, nowMs: NOW,
        })
        // 显式传 undefined 与「根本不传」必须同值
        const explicit = shouldRefreshNowWithRefreshExpiry({
          expiresAtMs, refreshExpiresAtMs, issuedAtMs: undefined, nowMs: NOW,
        })
        expect(explicit, `expires=${String(expiresAtMs)} refresh=${String(refreshExpiresAtMs)}`)
          .toBe(legacy)
      }
    }
  })

  it('★ 主腿优先：access 已进 lead 窗口时，保活腿是否命中都不影响结果', () => {
    for (const issuedAtMs of [undefined, NOW, NOW - 100 * DAY]) {
      expect(shouldRefreshNowWithRefreshExpiry({
        expiresAtMs: NOW + REFRESH_LEAD_MS, refreshExpiresAtMs: undefined, issuedAtMs, nowMs: NOW,
      })).toBe(true)
    }
  })

  it('★ 保活腿**不得**抑制 refresh 寿命腿（两条腿取或）', () => {
    // 闲置 1 天（未到保活窗口）但 refresh 只剩 10 分钟 ⇒ 仍必须刷。
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: NOW + 20 * DAY,
      refreshExpiresAtMs: NOW + 10 * 60 * 1000,
      issuedAtMs: NOW - DAY,
      nowMs: NOW,
    })).toBe(true)
  })
})

describe('keepAliveMaxIdleMs 的**取值域**守卫（正向审计 P3-2）', () => {
  /**
   * `keepAliveMaxIdleMs` 传 0 / 负数时，`nowMs - issuedAtMs >= 0` **恒真**
   * ⇒ 每 30 分钟一轮都真发续期请求 ⇒ 一次性 refresh_token 被白烧
   * （本仓 2026-10-27 两次同型事故）。
   *
   * ⚠️ 这条用例存在的原因：删掉判据里的 `keepAliveMaxIdleMs > 0` 那一行，
   *    原先 **20 条全绿**（变异实测）—— 因为没有任何用例喂过非正值。
   */
  const farFuture = NOW + 20 * DAY

  for (const bad of [0, -1, -DAY, Number.NaN, Number.NEGATIVE_INFINITY]) {
    it(`★★ \`keepAliveMaxIdleMs: ${String(bad)}\` ⇒ 关掉这条腿（不得每轮必刷）`, () => {
      expect(shouldRefreshNowWithRefreshExpiry({
        expiresAtMs: farFuture,
        refreshExpiresAtMs: undefined,
        issuedAtMs: NOW,
        keepAliveMaxIdleMs: bad as never,
        nowMs: NOW,
      })).toBe(false)
    })
  }

  it('★ 对照：正的世界里 1 毫秒也会放行（证明上面不是「腿根本没生效」）', () => {
    expect(shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: farFuture,
      refreshExpiresAtMs: undefined,
      issuedAtMs: NOW - 1,
      keepAliveMaxIdleMs: 1,
      nowMs: NOW,
    })).toBe(true)
  })
})

describe('jwtIssuedAtMs / credentialIssuedAtMs：iat 的读取', () => {
  it('★★ 能从真实形状的 JWT 里解出 iat（毫秒）', () => {
    const token = fakeJwt({ iat: 1795000000, exp: 1795000000 + 28 * 86400 })
    expect(jwtIssuedAtMs(token)).toBe(1795000000 * 1000)
  })

  it('★ 解不出时返回 `undefined`（未知 ≠ 需要刷）', () => {
    expect(jwtIssuedAtMs('')).toBeUndefined()
    expect(jwtIssuedAtMs('not-a-jwt')).toBeUndefined()
    expect(jwtIssuedAtMs('a.b')).toBeUndefined()
    expect(jwtIssuedAtMs(fakeJwt({ exp: 1 }))).toBeUndefined() // 无 iat
    expect(jwtIssuedAtMs(fakeJwt({ iat: '1795000000' }))).toBeUndefined() // 字符串 iat
    expect(jwtIssuedAtMs(`${fakeJwt({ iat: 1 }).slice(0, 5)}!!!.***`)).toBeUndefined()
  })

  it('★★ `credentialIssuedAtMs` 取 access_token 的 iat，且**不做** TTL 回退', () => {
    const token = fakeJwt({ iat: 1795000000 })
    const credential = { access_token: token, refresh_token: 'r', expires_at: String((1795000000 + 28 * 86400) * 1000) }
    expect(credentialIssuedAtMs(credential as never)).toBe(1795000000 * 1000)
    // 非 JWT 的 access_token ⇒ undefined（**不能**用 expires_at - 28 天去猜）
    const opaque = { access_token: 'opaque-token', refresh_token: 'r', expires_at: String(NOW + 28 * DAY) }
    expect(credentialIssuedAtMs(opaque as never)).toBeUndefined()
    // 对照：同一份凭据的 expiresAt 仍读得到（证明只是 iat 那条腿没数据）
    expect(credentialExpiresAtMs(opaque as never)).toBe(NOW + 28 * DAY)
  })

  it('★★ **issue 的真实时间线**：28 天 TTL 下，保活判据会在第 7 天就放行', () => {
    /**
     * 报障者给的时间线：`iat = 2026-10-21 14:08`、`exp = 2026-11-18 14:08`（28 天）。
     * 原实现里 28 天**一次都没刷**，第 28 天才第一次尝试 ⇒ 401 12153。
     * 修后第一次续期发生在 **第 7 天**（10-28 14:08），此后每 7 天一次。
     */
    const iatMs = Date.parse('2026-10-21T14:08:29+08:00')
    const expMs = Date.parse('2026-11-18T14:08:29+08:00')
    expect((expMs - iatMs) / DAY).toBeCloseTo(28, 0)

    const refreshAt = (nowMs: number): boolean => shouldRefreshNowWithRefreshExpiry({
      expiresAtMs: expMs, refreshExpiresAtMs: undefined, issuedAtMs: iatMs, nowMs,
    })
    // 第 1 / 6 天：不刷（旧实现这里也不刷，行为相同）
    expect(refreshAt(iatMs + 1 * DAY)).toBe(false)
    expect(refreshAt(iatMs + 6 * DAY)).toBe(false)
    // 第 7 天：**修后第一次放行**（旧实现要等到第 27 天 13:08）
    expect(refreshAt(iatMs + 7 * DAY)).toBe(true)
    // 第 27 天（旧实现才刚进 1 小时窗口）—— 现在早已刷过多次
    expect(refreshAt(iatMs + 27 * DAY)).toBe(true)
    // 旧判据在第 7 天是 false（对照，证明差异真实存在）
    expect(shouldRefreshNow(expMs, iatMs + 7 * DAY)).toBe(false)
  })
})

/**
 * ★★★ **接线守卫**（2026-11-19 正向审计 P1-1，最重要的一条）。
 *
 * 审计实测：把 `BUDDY_EXPIRY_ACCESSORS` 里的 `issuedAtOf: credentialIssuedAtMs`
 * 删掉、或把 `refreshAccountWithReconcile` 里那句
 * `issuedAtMs: accessors.issuedAtOf?.(credential)` 删掉 ⇒ **上面 15 条全绿，
 * 而 issue #124 原样复发**。
 *
 * 根因：上面 12 条手传 `issuedAtMs` 直接测判据、3 条只测 `jwtIssuedAtMs` 本身，
 * **没有一条跨越「访问器 → 判据」这条缝**。而缺陷恰恰活在那条缝里 ——
 * 判据写得再对，没人把 `iat` 喂进去也白搭。
 *
 * ⇒ 这里用**真实的 `BUDDY_EXPIRY_ACCESSORS`** 走一次
 * `refreshAccountWithReconcile`，断言「闲置 7 天 ⇒ 真发续期、闲置 6 天 ⇒ 不发」。
 */
describe('★★★ 接线段：真实的 BUDDY_EXPIRY_ACCESSORS 能驱动保活', () => {
  const DAY = 24 * 60 * 60 * 1000

  /** 造一份真实形状的 buddy 凭据：access_token 是 JWT，`iat` 可指定。 */
  const credentialAt = (issuedAtMs: number): Record<string, unknown> => {
    const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8')
      .toString('base64').replace(/=+$/, '')
    const ttlMs = 28 * DAY
    return {
      access_token: `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: Math.floor(issuedAtMs / 1000), exp: Math.floor((issuedAtMs + ttlMs) / 1000) })}.c2ln`,
      refresh_token: 'refresh-token',
      expires_at: String(issuedAtMs + ttlMs),
      scope: 'profile email',
    }
  }

  /** 用真实访问器跑一次编排；返回是否真的发了续期请求。 */
  const runOnce = async (credential: Record<string, unknown>): Promise<boolean> => {
    const { BUDDY_EXPIRY_ACCESSORS } = await import('../../src/buddy-auth.js')
    const { refreshAccountWithReconcile } = await import('../../src/expiry-sync.js')
    let refreshCalls = 0
    await refreshAccountWithReconcile({
      pool: {
        updateAccount: async () => {},
        findAccountIdByCredential: async () => 'acct-1',
      } as never,
      provider: 'buddy',
      tag: '[buddy]',
      accountId: 'acct-1',
      credential: credential as never,
      // ⚠️ 这里用的是**生产表**，不是手搓的替身 —— 这就是本用例的全部意义。
      accessors: BUDDY_EXPIRY_ACCESSORS,
      refresh: async (c: never) => { refreshCalls += 1; return c },
      save: async () => {},
      makeTerminalError: (message: string) => new Error(message),
    })
    return refreshCalls > 0
  }

  it('★★★ 闲置 7 天（access 还剩 21 天）⇒ **必须**发续期（issue #124 的核心场景）', async () => {
    const now = Date.now()
    expect(await runOnce(credentialAt(now - 7 * DAY))).toBe(true)
  })

  it('★★★ 闲置 6 天 ⇒ **不发**（还没到保活窗口）', async () => {
    const now = Date.now()
    expect(await runOnce(credentialAt(now - 6 * DAY))).toBe(false)
  })

  it('★★★ 生产表里 `issuedAtOf` 必须在位（删掉它 ⇒ 上两条一起变绿，缺陷复发）', async () => {
    const { BUDDY_EXPIRY_ACCESSORS } = await import('../../src/buddy-auth.js')
    expect(typeof BUDDY_EXPIRY_ACCESSORS.issuedAtOf, 'BUDDY_EXPIRY_ACCESSORS.issuedAtOf 必须存在').toBe('function')
    const credential = credentialAt(Date.now() - 7 * DAY)
    expect(BUDDY_EXPIRY_ACCESSORS.issuedAtOf!(credential as never)).toBeGreaterThan(0)
  })
})

/**
 * **日志可区分性**（2026-11-19 正向审计 P2-2 / F-3）。
 *
 * 「凭据解析失败」与「refresh_token 被服务端作废」在用户侧**完全同形**
 * （都是 `refreshable: false` + 都要重登），而它们的原因完全不同。
 * 两条日志的结尾都必须能区分 —— 靠唯一锚点。
 *
 * ⚠️ 这里是**源码文本断言**，只能证明锚点字面量在文件里；它挡不住
 *    `if (false)` 包住。真正的行为级守卫需要能注入 logger 的 `BuddyAuth` 实例
 *    （要起 cordis Context），成本高于本 issue 的价值，故如实登记这个局限。
 */
describe('日志锚点：两种原因必须可区分（源码级，局限已登记）', () => {
  it('★★ 两条 warn 各带唯一锚点，且不在同一个字符串里', async () => {
    const source = await import('node:fs').then(async (fs) =>
      fs.readFileSync(new URL('../../src/buddy-auth.ts', import.meta.url), 'utf8'))
    /**
     * ⚠️ 只断言「锚点出现在**模板字符串里**」（带 `\`[${this.product.id}] ` 前缀那一处），
     *    不断言「文件里恰好出现 N 次」—— 我第一版就写成了后者，结果**变异 M9 全绿**
     *    （因为它只改了模板里的那一处，而注释里还留着一处字面量 ⇒ 计数没变）。
     */
    expect(source).toContain('`[${this.product.id}] [credential-unparsable] 账号')
    expect(source).toContain('`[${this.product.id}] [refresh-token-expired] 账号')
    // 反向：两个锚点不得出现在**同一个**模板字符串里（那样就分不开了）
    expect(source).not.toMatch(/\[credential-unparsable\][^`]*\[refresh-token-expired\]/)
  })

  it('★★ 新增日志**不得**打印凭据内容（红线：bearer 凭据不进日志）', async () => {
    const source = await import('node:fs').then(async (fs) =>
      fs.readFileSync(new URL('../../src/buddy-auth.ts', import.meta.url), 'utf8'))
    // 定位那条 warn 的模板字符串片段
    const at = source.indexOf('`[${this.product.id}] [credential-unparsable] 账号')
    expect(at, '锚点必须在模板字符串里').toBeGreaterThan(0)
    const snippet = source.slice(at, at + 900)
    // 不得把 resolved.value / access_token / refresh_token 拼进日志
    expect(snippet).not.toContain('resolved.value')
    expect(snippet).not.toContain('access_token')
    expect(snippet).not.toContain('refresh_token,')
    expect(snippet).not.toContain('JSON.stringify(credential')
  })
})
