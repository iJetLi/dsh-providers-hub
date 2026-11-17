/**
 * `officeace-lock.spec.ts` —— officeace「锁定永久积分」的**执行路径**守卫。
 *
 * ## 背景：这是一个真实的哑锁（Gitee issue IKLTHB 第 ① 条）
 *
 * `provider-registry.ts` 早已给 officeace 登记 `permanentLock: true`，Jet Hub 据此
 * 渲染开关并**逐字承诺**「这类积分用尽后将没有可用账号」；而**全仓**
 * `permanentLocked()` 只有 `credential-resolver.ts` 的 buddy / loomy 两个分支读过。
 * officeace 走适配器自己的 `credentialProvider`（`index.ts`）⇒ 开关写进
 * `permanent-locks.json` 后行为与关闭**完全一致**，用户照旧烧永久套餐包。
 *
 * 本文件守的不变量（每条都对应一种真实的失效形态）：
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 未锁定 ⇒ **一个字节都不变**（走旧路径、不读余额） | 为了加锁把既有选号逻辑改坏 |
 * | 2 | 锁定 + 只剩不会近期作废的桶 ⇒ **抛错** | 承诺落空（原始缺陷）|
 * | 3 | 锁定 + 抛错时**绝不回落池** | 绕过锁定，照样烧永久积分 |
 * | 4 | 锁定 + 多个账号 ⇒ 换到**有临期额度**的那个 | 明明有可烧的号却报「没有可用账号」|
 * | 5 | 读不到余额 ⇒ 报「读不到」而**不是**「用尽」 | 用户据此解锁 ⇒ 不可撤回地烧钱 |
 * | 6 | 「有临期额度」这个结论**不得被缓存** | 缓存期内仍可能烧到永久桶 |
 * | 7 | 窗口真的被用上（默认 15 天） | 面板文案与实际筛号各说一套 |
 *
 * ⚠️ 全部离网（注入依赖，不发任何请求）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OFFICEACE_LOCK_PERMANENT_TTL_MS,
  OFFICEACE_LOCK_UNKNOWN_TTL_MS,
  createOfficeAceCredentialProvider,
  officeaceLockedError,
  splitOfficeAceCreditsByExpiry,
  type OfficeAceLockDeps,
  type OfficeAceSummaryRead,
} from '../../src/officeace-lock.js'
import { buddyExpiringWindowDays } from '../../src/buddy-balance-rank.js'
import type { OfficeAceCredential, OfficeAceSubscriptionSummary } from '../../src/officeace-auth.js'

const DAY = 24 * 60 * 60 * 1000
const WINDOW = 15 * DAY
/** 「临期」子窗口（与后端默认 5 天同值；本文件是判据同构用例，显式传入不依赖默认值）。 */
const IMMINENT = 5 * DAY
/** 固定「现在」，让窗口边界断言可复现。 */
const NOW = Date.UTC(2026, 9, 15, 6, 0, 0)

/** 造一份凭据（字段齐全，便于按 ref 区分账号）。 */
function cred(tag: string): OfficeAceCredential {
  return {
    modelAppKey: `k-${tag}`, modelAppSecret: `s-${tag}`, maasBaseUrl: 'https://x.example',
    access: 'ak', secret: 'sk', securityToken: 'tok', projectId: 'p',
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    refreshToken: 'r', dpopPrivateJwk: {},
  } as unknown as OfficeAceCredential
}

/** 造一份订阅摘要。 */
function summary(
  groups: Array<{ remaining: number; expiresAt?: string; expired?: boolean }>,
): OfficeAceSubscriptionSummary {
  return {
    totalCredits: groups.reduce((sum, g) => sum + g.remaining, 0),
    usedCredits: 0,
    creditGroups: groups.map((g, i) => ({
      key: `g${i}`, name: `桶${i}`, remaining: g.remaining, total: g.remaining,
      ...g.expiresAt === undefined ? {} : { expiresAt: g.expiresAt },
      ...g.expired === undefined ? {} : { expired: g.expired },
    })),
  }
}

/** 会话/活动包的到期时刻（窗口内）。 */
const SOON = new Date(NOW + 3 * DAY).toISOString()
/** 套餐包的到期时刻（窗口外 ⇒ 永久桶）。 */
const FAR = new Date(NOW + 300 * DAY).toISOString()

describe('splitOfficeAceCreditsByExpiry（分桶判据，与 buddy 系逐格同构）', () => {
  it('① 窗口内到期 ⇒ 临期桶；窗口外 ⇒ 永久桶', () => {
    const split = splitOfficeAceCreditsByExpiry(summary([
      { remaining: 1000, expiresAt: SOON },
      { remaining: 500, expiresAt: FAR },
    ]), NOW, WINDOW, IMMINENT)
    // ⚠️ SOON = 3 天后 ⇒ 既是「15 天内」（expiring 母量）又是「5 天内」（imminent 子量）。
    expect(split).toEqual({ expiring: 1000, permanent: 500, imminent: 1000 })
  })

  it('② 边界方向与 buddy 一致：**恰好 15 天**归永久，少 1ms 归临期', () => {
    // ⚠️ 方向不能反：`end - now < window` 才算临期。反了会让「15 天后才作废」的
    //    长期积分被当临期烧掉（正是锁定功能要防的事）。
    const at = splitOfficeAceCreditsByExpiry(summary([
      { remaining: 100, expiresAt: new Date(NOW + WINDOW).toISOString() },
    ]), NOW, WINDOW, IMMINENT)
    expect(at).toEqual({ expiring: 0, permanent: 100 })
    const just = splitOfficeAceCreditsByExpiry(summary([
      { remaining: 100, expiresAt: new Date(NOW + WINDOW - 1).toISOString() },
    ]), NOW, WINDOW, IMMINENT)
    expect(just).toEqual({ expiring: 100, permanent: 0 })
  })

  it('③ 拿不到到期时间 ⇒ 永久桶（保守方向：宁少用一个号，不误烧长期积分）', () => {
    const split = splitOfficeAceCreditsByExpiry(summary([
      { remaining: 4000 },
      { remaining: 500, expiresAt: '不是时间' },
    ]), NOW, WINDOW, IMMINENT)
    expect(split).toEqual({ expiring: 0, permanent: 4500 })
  })

  it('④ `expired: true` 与 `remaining <= 0` 的桶都不计入任何一桶', () => {
    // ⚠️ 已失效桶的服务端仍会返回余额，计入任一桶都会虚增可用额度。
    const split = splitOfficeAceCreditsByExpiry(summary([
      { remaining: 999, expiresAt: SOON, expired: true },
      { remaining: 0, expiresAt: SOON },
      { remaining: 1000, expiresAt: SOON },
    ]), NOW, WINDOW, IMMINENT)
    expect(split).toEqual({ expiring: 1000, permanent: 0, imminent: 1000 })
  })

  it('★ ④b 脏 `remaining`（负数 / NaN）绝不计入任何一桶', () => {
    // ⚠️ 本条是**第二轮对抗性审计**逼出来的：④ 里唯一的 `<= 0` 样本是 `remaining: 0`，
    //    而 0 加进任何桶等于没加 ⇒ 把 `!Number.isFinite || remaining <= 0` 整行删掉
    //    （或只删其中半条腿），④ **逐字节同效、仍然全绿**（审计实测 d / d1 / d2
    //    三向皆 GREEN）⇒ 那条守卫当时**一颗牙都没有**。
    //    而它的失效方向恰好是缺陷 ①：`NaN` 会让 `expiring += NaN` ⇒ 临期桶变 NaN
    //    ⇒ 判定翻成「永久」⇒ **锁定态放行、烧永久积分**（负数是反方向：永远算不出临期）。
    //    ⇒ 两个半条腿都必须有样本：删 `remaining <= 0` 由 `-5` 抓，删 `!Number.isFinite`
    //      由 `NaN` 抓，删整行两个都抓。
    //    ⚠️ 如实标注：**未取证**华为云会下发这两种形状（本轮禁网，只有真机报文里那批
    //       500/4000/1000/1000 的干净数字）—— 这里钉的是「该判据不可能变红」这件事本身。
    const split = splitOfficeAceCreditsByExpiry(summary([
      { remaining: -5, expiresAt: SOON },
      { remaining: Number.NaN, expiresAt: FAR },
      { remaining: 1000, expiresAt: SOON },
    ]), NOW, WINDOW, IMMINENT)
    expect(split).toEqual({ expiring: 1000, permanent: 0, imminent: 1000 })
  })

  it('⑤ 一个可用桶都没有 ⇒ 两桶皆 0（不是「永久有额度」）', () => {
    expect(splitOfficeAceCreditsByExpiry(summary([{ remaining: 0 }]), NOW, WINDOW, IMMINENT))
      .toEqual({ expiring: 0, permanent: 0 })
  })

  // ── 临期子量（与 buddy 那份逐格同构）─────────────────────────────

  it('★★ ⑥ 临期是 expiring 的**子量**：5 天内到期的才进 imminent', () => {
    const split = splitOfficeAceCreditsByExpiry(summary([
      { remaining: 100, expiresAt: new Date(NOW + 2 * DAY).toISOString() },   // 临期
      { remaining: 200, expiresAt: new Date(NOW + 10 * DAY).toISOString() },  // 短期
      { remaining: 1000, expiresAt: FAR },                                     // 长期
    ]), NOW, WINDOW, IMMINENT)
    expect(split).toEqual({ expiring: 300, permanent: 1000, imminent: 100 })
    // 不变量：0 <= imminent <= expiring
    expect(split.imminent!).toBeLessThanOrEqual(split.expiring)
    // 守恒：imminent 已含在 expiring 内，不得重复计
    expect(split.imminent! + split.permanent).toBe(1100)
  })

  it('★★ ⑦ 边界方向与 buddy 一致：正好 5 天 ⇒ 短期（不是临期），少 1ms ⇒ 临期', () => {
    const at = splitOfficeAceCreditsByExpiry(summary([
      { remaining: 100, expiresAt: new Date(NOW + IMMINENT).toISOString() },
    ]), NOW, WINDOW, IMMINENT)
    expect(at, '正好 5 天必须算短期').toEqual({ expiring: 100, permanent: 0 })
    expect(at).not.toHaveProperty('imminent')

    const just = splitOfficeAceCreditsByExpiry(summary([
      { remaining: 100, expiresAt: new Date(NOW + IMMINENT - 1).toISOString() },
    ]), NOW, WINDOW, IMMINENT)
    expect(just, '差 1ms 就是临期').toEqual({ expiring: 100, permanent: 0, imminent: 100 })
  })

  it('★ ⑧ 临期窗口 = 0 ⇒ 关掉临期档（退化两档），且不产出 imminent 键', () => {
    const split = splitOfficeAceCreditsByExpiry(summary([
      { remaining: 100, expiresAt: new Date(NOW + 1 * DAY).toISOString() },
    ]), NOW, WINDOW, 0)
    expect(split).toEqual({ expiring: 100, permanent: 0 })
    expect(split).not.toHaveProperty('imminent')
  })

  /**
   * ★★ **两份 splitter 必须逐格同构**（仓库红线：同一语义不得两套判据）。
   * 同一组「距到期天数」喂给 buddy 与 officeace，`expiring` / `imminent` 必须完全一致。
   */
  it('★★★ ⑨ 与 buddy 的 splitBuddyCreditsByExpiry 逐格同构', async () => {
    const { splitBuddyCreditsByExpiry } = await import('../../src/buddy-balance-rank.js')
    for (const days of [1, 3, 4.999, 5, 5.001, 10, 14.999, 15, 100]) {
      const at = new Date(NOW + days * DAY).toISOString()
      const officeAce = splitOfficeAceCreditsByExpiry(
        summary([{ remaining: 100, expiresAt: at }]), NOW, WINDOW, IMMINENT,
      )
      const buddy = splitBuddyCreditsByExpiry({
        total: 100,
        expiredTotal: 0,
        packages: [{
          name: 'p', unit: 'credits', remaining: 100, total: 100, used: 0,
          active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
          deductionEndTime: NOW + days * DAY,
        }],
      }, NOW, WINDOW, IMMINENT)
      expect(
        { expiring: officeAce.expiring, permanent: officeAce.permanent, imminent: officeAce.imminent },
        `${days} 天后到期时两份 splitter 必须同判`,
      ).toEqual({ expiring: buddy!.expiring, permanent: buddy!.permanent, imminent: buddy!.imminent })
    }
  })
})

/** 装配一个可观测的 provider（记录每次 `summaryOf` 的调用）。 */
function harness(options: {
  locked: boolean
  accounts?: Array<{ id: string; credentialRef: string }>
  credentials?: Record<string, OfficeAceCredential | undefined>
  reads?: Record<string, OfficeAceSummaryRead>
  stored?: OfficeAceCredential | undefined
  storedRead?: OfficeAceSummaryRead
  unlocked?: OfficeAceCredential | undefined
  windowMs?: number
  /**
   * ⚠️ 不注入 `windowMs`，走**生产那条** `buddyExpiringWindowMs()`（读 env）。
   *    只有这一格能测出「窗口天数是不是真的同源」—— 注入了就等于把被测判据
   *    换成了测试自己给的值（见 ⑨）。
   */
  useEnvWindow?: boolean
  now?: number
}) {
  const unlocked = vi.fn(async () => options.unlocked)
  const summaryOf = vi.fn(async (
    credential: OfficeAceCredential,
    ref: string | undefined,
  ): Promise<OfficeAceSummaryRead> => {
    if (ref === undefined) return options.storedRead ?? { ok: false, error: '无兼容读取' }
    const read = options.reads?.[ref]
    if (read !== undefined) return read
    return { ok: true, summary: summary([{ remaining: 100, expiresAt: SOON }]) }
  })
  const deps: OfficeAceLockDeps = {
    permanentLocked: () => options.locked,
    accounts: () => options.accounts ?? [],
    resolveUnlocked: unlocked,
    readCredential: async (ref) => options.credentials?.[ref],
    readStoredCredential: () => options.stored,
    summaryOf,
    now: () => options.now ?? NOW,
    ...options.useEnvWindow === true ? {} : { windowMs: () => options.windowMs ?? WINDOW },
  }
  return { provider: createOfficeAceCredentialProvider(deps), unlocked, summaryOf }
}

describe('锁定态执行路径（issue IKLTHB 第 ① 条）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('★ ① 未锁定 ⇒ 走旧路径，且**完全不读余额**（零行为变化）', async () => {
    const c = cred('A')
    const h = harness({
      locked: false,
      accounts: [{ id: 'a1', credentialRef: 'OFFICEACE_ACCOUNT_A' }],
      credentials: { OFFICEACE_ACCOUNT_A: c },
      unlocked: c,
    })
    await expect(h.provider()).resolves.toBe(c)
    expect(h.unlocked, '未锁定必须走原路径').toHaveBeenCalledTimes(1)
    expect(h.summaryOf, '未锁定不得因为「顺手」而多打一次余额请求').not.toHaveBeenCalled()
  })

  it('★ ② 锁定 + 只剩永久桶 ⇒ 抛错（这是原始缺陷里那句承诺）', async () => {
    const h = harness({
      locked: true,
      accounts: [{ id: 'a1', credentialRef: 'R1' }],
      credentials: { R1: cred('A') },
      reads: { R1: { ok: true, summary: summary([{ remaining: 4000, expiresAt: FAR }]) } },
      // ⚠️ 旧路径**故意**给一份可用凭据：若实现回落池，这条会「静默成功」。
      unlocked: cred('A'),
    })
    await expect(h.provider()).rejects.toThrow(/没有可用账号/)
    expect(h.unlocked, '锁定时绝不允许回落池（否则锁定形同虚设）').not.toHaveBeenCalled()
  })

  it('★ ③ 锁定 + 有临期额度 ⇒ 正常返回该账号凭据', async () => {
    const c = cred('A')
    const h = harness({
      locked: true,
      accounts: [{ id: 'a1', credentialRef: 'R1' }],
      credentials: { R1: c },
      reads: { R1: { ok: true, summary: summary([{ remaining: 1000, expiresAt: SOON }]) } },
    })
    await expect(h.provider()).resolves.toBe(c)
  })

  it('★ ④ 多个账号 ⇒ 换到有临期额度的那个（而不是直接报「没有可用账号」）', async () => {
    const a = cred('A')
    const b = cred('B')
    const h = harness({
      locked: true,
      accounts: [
        { id: 'a1', credentialRef: 'R1' },
        { id: 'a2', credentialRef: 'R2' },
      ],
      credentials: { R1: a, R2: b },
      reads: {
        R1: { ok: true, summary: summary([{ remaining: 500, expiresAt: FAR }]) },
        R2: { ok: true, summary: summary([{ remaining: 1000, expiresAt: SOON }]) },
      },
    })
    await expect(h.provider()).resolves.toBe(b)
  })

  it('★ ⑤ 读不到余额 ⇒ 报「无法确认」而不是「没有可用账号」（方向不能反）', async () => {
    const h = harness({
      locked: true,
      accounts: [{ id: 'a1', credentialRef: 'R1' }],
      credentials: { R1: cred('A') },
      reads: { R1: { ok: false, error: '订阅摘要查询失败：HTTP 500' } },
    })
    await expect(h.provider()).rejects.toThrow(/无法确认/)
    // ⚠️ 反例判据：把抖动说成「用尽」会引用户去解锁 ⇒ 不可撤回地烧永久积分。
    await expect(h.provider()).rejects.not.toThrow(/没有可用账号/)
  })

  it('⑥ 凭据读不出来也算「无法确认」（不是「用尽」）', async () => {
    const h = harness({
      locked: true,
      accounts: [{ id: 'a1', credentialRef: 'R1' }],
      credentials: {},
    })
    await expect(h.provider()).rejects.toThrow(/无法确认/)
  })

  it('★ ⑥b 「有临期额度」这个结论**不得被缓存**（缓存期内会烧到永久桶）', async () => {
    const c = cred('A')
    const h = harness({
      locked: true,
      accounts: [{ id: 'a1', credentialRef: 'R1' }],
      credentials: { R1: c },
      reads: { R1: { ok: true, summary: summary([{ remaining: 1000, expiresAt: SOON }]) } },
    })
    await h.provider()
    await h.provider()
    expect(h.summaryOf, '临期判定必须每次现问服务端').toHaveBeenCalledTimes(2)
  })

  it('⑥c 「只剩永久桶」与「读不到」会被短暂缓存（拒绝路径不该每轮打网络）', async () => {
    const h = harness({
      locked: true,
      accounts: [{ id: 'a1', credentialRef: 'R1' }],
      credentials: { R1: cred('A') },
      reads: { R1: { ok: true, summary: summary([{ remaining: 1, expiresAt: FAR }]) } },
    })
    await expect(h.provider()).rejects.toThrow()
    await expect(h.provider()).rejects.toThrow()
    expect(h.summaryOf).toHaveBeenCalledTimes(1)

    const h2 = harness({
      locked: true,
      accounts: [{ id: 'a1', credentialRef: 'R1' }],
      credentials: { R1: cred('A') },
      reads: { R1: { ok: false, error: 'boom' } },
    })
    await expect(h2.provider()).rejects.toThrow()
    await expect(h2.provider()).rejects.toThrow()
    expect(h2.summaryOf).toHaveBeenCalledTimes(1)
    // 两个 TTL 都是正数且「拒绝 < 临期之外」的语义另有用例覆盖，这里只锁住它们真的生效。
    expect(OFFICEACE_LOCK_PERMANENT_TTL_MS).toBeGreaterThan(OFFICEACE_LOCK_UNKNOWN_TTL_MS)
  })

  it('⑦ 池里没有任何账号 ⇒ 用兼容单凭据判（临期则可烧，永久则报错）', async () => {
    const ok = harness({
      locked: true,
      accounts: [],
      stored: cred('S'),
      storedRead: { ok: true, summary: summary([{ remaining: 1000, expiresAt: SOON }]) },
    })
    await expect(ok.provider()).resolves.toEqual(expect.objectContaining({ modelAppKey: 'k-S' }))

    const bad = harness({
      locked: true,
      accounts: [],
      stored: cred('S'),
      storedRead: { ok: true, summary: summary([{ remaining: 1000, expiresAt: FAR }]) },
    })
    await expect(bad.provider()).rejects.toThrow(/没有可用账号/)
  })

  it('★ ⑦b 池空且本机也没有凭据 ⇒ undefined（未登录），但有凭据时必须真的返回它', async () => {
    // ⚠️ 后半个对照是**第二轮对抗性审计**逼出来的：原标题下整条只有
    //    `resolves.toBeUndefined()` 一个断言 ⇒ 实测把兼容路径退化成裸
    //    `return undefined`（变异 f）时，⑦ 红而**本条保持绿** ⇒ 本条对那一格
    //    的判别力是**零**。补「池空但本机凭据**有临期额度**」这一格，钉住
    //    「undefined 的原因是真的没有凭据」，而不是「兼容路径被短路了」。
    const empty = harness({ locked: true, accounts: [], stored: undefined })
    await expect(empty.provider()).resolves.toBeUndefined()
    expect(empty.summaryOf, '根本没有凭据时不该去读余额').not.toHaveBeenCalled()

    const stored = cred('S')
    const readable = harness({
      locked: true,
      accounts: [],
      stored,
      storedRead: { ok: true, summary: summary([{ remaining: 300, expiresAt: SOON }]) },
    })
    await expect(readable.provider()).resolves.toBe(stored)
  })

  it('★ ⑧ 窗口真的被用上：同一个 3 天后到期的桶，窗口 1 天时算永久', async () => {
    const h = harness({
      locked: true,
      accounts: [{ id: 'a1', credentialRef: 'R1' }],
      credentials: { R1: cred('A') },
      reads: { R1: { ok: true, summary: summary([{ remaining: 1000, expiresAt: SOON }]) } },
      windowMs: 1 * DAY,
    })
    await expect(h.provider()).rejects.toThrow(/没有可用账号/)
  })

  it('★ ⑨ 窗口**与面板文案同源**：改环境变量 ⇒ 筛号与文案同时跟着变', async () => {
    // ⚠️ 这条是为一个**真实无牙**的缺口写的（第一轮审计「中等 1」）：
    //    「窗口天数与面板文案同源」原先只有「> 0」一句断言，而所有期望值都是
    //    `buddyExpiringWindowDays()` **现算**的 ⇒ 把筛号或文案里的窗口**写死 15 天**，
    //    默认 env 下全部用例仍然绿。判据必须让 env 走**非默认值**，并同时看两件事：
    //    ① 5 天后到期的额度在 3 天窗口下必须被当成**永久桶**（拒绝）；
    //    ② 报错文案必须说「3 天」——把天数写死在任意一侧都会被这条抓住。
    vi.stubEnv('DSH_BUDDY_EXPIRING_WINDOW_DAYS', '3')
    try {
      expect(buddyExpiringWindowDays(), 'env 必须真的被读到').toBe(3)
      const h = harness({
        locked: true,
        accounts: [{ id: 'a1', credentialRef: 'R1' }],
        credentials: { R1: cred('A') },
        reads: {
          R1: {
            ok: true,
            summary: summary([{ remaining: 900, expiresAt: new Date(NOW + 5 * DAY).toISOString() }]),
          },
        },
        useEnvWindow: true,
      })
      const error = await h.provider().then(() => undefined, (e: Error) => e)
      expect(error?.message, '3 天窗口下，5 天后到期的额度不是「临期」（写死 15 天就会放行）')
        .toContain('没有可用账号')
      expect(error?.message, '文案里的天数必须跟着 env 走，不能写死').toContain('3 天内到期')
      expect(error?.message, '默认窗口的 15 天在这里是**错**的').not.toContain('15 天')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('★ ⑩ 文案里的天数**必须用调用方给的窗口**（不是另算一份）', () => {
    // ⚠️ 与 ⑨ 互补：⑨ 证明「没有注入时读 env」，这条证明「注入时用注入值」。
    //    两条合起来才排掉「同一条判据两份取值」（本仓库红线）——
    //    原先文案自己调 `buddyExpiringWindowMs()`，注入 1 天窗口筛号、文案却说 15 天。
    expect(officeaceLockedError({ kind: 'exhausted' }, 2 * DAY).message).toContain('2 天内到期')
    // 非法值 ⇒ 回落 env（同 `buddyExpiringWindowDays()`），不是 0 天。
    // ⚠️ 这是**防御腿**，不是「忘了传参」的兜底：`windowMs` 已是**必填**参数
    //    （第二轮审计实测那个默认值改坏后 22 条全绿 ⇒ 它是死代码），
    //    所以这一格只能**显式**传 NaN 才走得到。
    const fallback = officeaceLockedError({ kind: 'exhausted' }, Number.NaN).message
    expect(fallback).toContain(`${buddyExpiringWindowDays()} 天内到期`)
  })
})

describe('officeaceLockedError（文案）', () => {
  // ⚠️ 这里**显式传窗口**（不再从 env 现算）：本段只测**格式化**。
  //    「窗口来自 env / 来自注入」由 provider 那一层的 ⑧⑨ 负责 ——
  //    两件事分开测，别让 env 混进文案断言（否则改坏装配也可能靠 env 侥幸绿）。
  it('① 「没有可用账号」说清这是锁定开关的预期效果，并给出解锁出路', () => {
    const error = officeaceLockedError({ kind: 'exhausted' }, WINDOW)
    expect(error.message).toContain('15 天内到期')
    expect(error.message).toContain('解锁')
    // ⚠️ 扣减顺序在服务端 —— 文案不得暗示「锁上就不会扣永久积分」。
    expect(error.message).toContain('扣减顺序由服务端决定')
  })

  it('★ ② 不得建议「重新登录」——那是被 issue IKLTHB 取证证伪的动作', () => {
    // 取证：重新登录换掉了账号/ref/整条 STS，却让 modelAppKey/modelAppSecret 逐字节不变。
    // 在锁定文案里重复那个指引，就是把一条已知无效的指令换个出口再说一遍。
    for (const reason of [{ kind: 'exhausted' } as const, { kind: 'unknown', errors: ['boom'] } as const]) {
      expect(officeaceLockedError(reason, WINDOW).message).not.toMatch(/重新登录/)
    }
  })

  it('★ ③ 错误必须**不带 `code`**（否则 DSH 客户端会整段替换掉指路文案）', () => {
    // ⚠️ 本仓库红线：`AUTH` / `QUOTA` / `ACCOUNT_QUOTA` 三个码的 message 会被客户端丢弃。
    //    这条错误的**全部价值**就是那段指路文案 ⇒ 必须是裸 Error。
    // ✅ 已在 DSH 装好的源码里实证（不只是推断）：
    //    `dsh-client-ui-chat/lib/client.js:1222` 把 QUOTA/ACCOUNT_QUOTA 换成
    //    `message.failure.quota`、`:1223` 把 AUTH 换成 `message.failure.auth`，
    //    且 `:7392-7395` 对 AUTH 直接给出 `message: ""`（整段抹掉）。
    expect((officeaceLockedError({ kind: 'exhausted' }, WINDOW) as { code?: unknown }).code)
      .toBeUndefined()
    expect((officeaceLockedError({ kind: 'unknown', errors: ['boom'] }, WINDOW) as { code?: unknown })
      .code).toBeUndefined()
  })

  it('④ 「无法确认」带上具体原因，并说明「可能仍有临期额度」', () => {
    const error = officeaceLockedError({ kind: 'unknown', errors: ['R1: 订阅摘要查询失败：HTTP 500'] })
    expect(error.message).toContain('HTTP 500')
    expect(error.message).toContain('无法确认')
  })
})
