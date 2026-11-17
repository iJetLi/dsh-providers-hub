import { describe, expect, it } from 'vitest'
import { BuddyBalanceSelector, pickBuddyAccount } from '../../src/buddy-balance-selector.js'
import { BUDDY_BALANCE_TIER, splitBuddyCreditsByExpiry, buddyBalanceTier } from '../../src/buddy-balance-rank.js'
import { PERMANENT_LOCK_PROVIDERS } from '../../src/jet-hub-rpc.js'
import { supportsPermanentLock, permanentLockCopy } from '../../plugin-src/client/credits-capabilities.js'
import { fetchTraeCreditBalance } from '../../src/trae-credits.js'
import { fetchLobsteraiCreditBalance } from '../../src/lobsterai-credits.js'
import { TRAE } from '../../src/trae-product.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import type { TraeCredential } from '../../src/trae.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'
import type { CreditBalance } from '../../src/credits.js'

/**
 * TRAE（字节）与 LobsterAI（有道）的「锁定永久积分」。
 *
 * ## 为什么这两家能加进来
 *
 * 分档判据 `splitBuddyCreditsByExpiry` 只读通用的
 * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**：
 * - TRAE 的条目级 `expire_time`（秒级 Unix）已归一化到 `deductionEndTime`；
 * - LobsterAI 的 `expiresAt`（ISO 8601）同样已归一化。
 *
 * 两家都没有「每日额度 / 永久积分」两个**命名池**，但「会不会马上作废」这件事
 * 只需到期时间就能判定 —— 这正是锁定功能要的判据。
 */

const DAY = 24 * 60 * 60 * 1000
/** 固定「现在」，让窗口边界断言可复现。 */
const NOW = Date.UTC(2026, 9, 6, 0, 0, 0)
const WINDOW = 15 * DAY

/** 造一份 TRAE 形态的余额（条目级 expire_time 已归一化）。 */
function traeBalance(packages: CreditBalance['packages']): CreditBalance {
  return { total: packages.reduce((s, p) => s + p.remaining, 0), packages, expiredTotal: 0 }
}

describe('TRAE（字节）—— 按到期时间分桶', () => {
  it('签到奖励（3 天后到期）归「快到期」、每月赠送（25 天后）归「永久」', () => {
    const split = splitBuddyCreditsByExpiry(traeBalance([
      { name: '签到奖励', unit: 'credits', remaining: 150, total: 150, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 3 * DAY },
      { name: '每月登录赠送', unit: 'credits', remaining: 500, total: 500, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 25 * DAY },
    ]), NOW, WINDOW)
    expect(split).toEqual({ expiring: 150, permanent: 500, imminent: 150 })
  })

  it('★ 拿不到 expire_time（不设 deductionEndTime）归入**永久**桶（保守方向）', () => {
    // `src/trae-credits.ts`：expire_time 为 0 / 缺失时不设 deductionEndTime。
    // 宁可当「不会马上作废」（锁定时少用一个号），也不要把长期积分误当快到期烧掉。
    const split = splitBuddyCreditsByExpiry(traeBalance([
      { name: '免费', unit: 'credits', remaining: 300, total: 300, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '' },
    ]), NOW, WINDOW)
    expect(split).toEqual({ expiring: 0, permanent: 300 })
  })

  it('★ 只剩永久积分时，锁定必须判为不可用（none 档）', () => {
    const split = splitBuddyCreditsByExpiry(traeBalance([
      { name: '每月登录赠送', unit: 'credits', remaining: 500, total: 500, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 25 * DAY },
    ]), NOW, WINDOW)!
    expect(buddyBalanceTier({ expiringBalance: split.expiring, permanentBalance: split.permanent }))
      .toBe(BUDDY_BALANCE_TIER.permanent)
    expect(buddyBalanceTier({ expiringBalance: split.expiring, permanentBalance: split.permanent }, { allowPermanent: false }))
      .toBe(BUDDY_BALANCE_TIER.none)
  })
})

describe('LobsterAI（有道）—— 按到期时间分桶', () => {
  it('每日登录奖励（3/4 天后）归「快到期」、新手礼包（45 天后）归「永久」', () => {
    const split = splitBuddyCreditsByExpiry(traeBalance([
      { name: '每日登录奖励', unit: 'credit', remaining: 100, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 3 * DAY },
      { name: '每日登录奖励', unit: 'credit', remaining: 100, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 4 * DAY },
      { name: '新手礼包', unit: 'credit', remaining: 100, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 45 * DAY },
    ]), NOW, WINDOW)
    expect(split).toEqual({ expiring: 200, permanent: 100, imminent: 200 })
  })

  it('★ 已过期包（active:false）不得计入任何一桶', () => {
    // 失效包的服务端仍会返回余额，并进任何一桶都会虚增可用额度。
    const split = splitBuddyCreditsByExpiry(traeBalance([
      { name: '每日登录奖励', unit: 'credit', remaining: 100, total: 0, used: 0, active: false, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW - 1 * DAY },
      { name: '新手礼包', unit: 'credit', remaining: 50, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 40 * DAY },
    ]), NOW, WINDOW)
    expect(split).toEqual({ expiring: 0, permanent: 50 })
  })
})

describe('窗口天数对两家的影响（共用 DSH_BUDDY_EXPIRING_WINDOW_DAYS）', () => {
  it('同一份余额在不同窗口下分桶不同（7 天 vs 15 天）', () => {
    const balance = traeBalance([
      { name: 'a', unit: 'credit', remaining: 100, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 5 * DAY },
      { name: 'b', unit: 'credit', remaining: 500, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: NOW + 9 * DAY },
    ])
    expect(splitBuddyCreditsByExpiry(balance, NOW, 7 * DAY)).toEqual({ expiring: 100, permanent: 500 })
    expect(splitBuddyCreditsByExpiry(balance, NOW, 15 * DAY)).toEqual({ expiring: 600, permanent: 0 })
  })

  it('查询失败（null）返回 undefined，由调用方归入最后一档', () => {
    expect(splitBuddyCreditsByExpiry(null, NOW, WINDOW)).toBeUndefined()
    expect(splitBuddyCreditsByExpiry(undefined, NOW, WINDOW)).toBeUndefined()
  })
})

describe('选号器泛型化后对两家的实际行为', () => {
  /**
   * ⚠️ 下面这个 `for` 循环**不是** provider 特定的：两家用的是同一个假 product
   * `{ id: label }` 与同一种假凭据，测的只是「泛型后的编排对任意 provider 成立」
   * （把同一段逻辑跑两遍、换了标题）。它对 TRAE 与 LobsterAI 的**差异零覆盖** ——
   * 已实测：删掉两家的 `getAvailableAccount(..., picked.tried)`、删掉
   * `reportLedgerAccount`、不传 `modelId`、串用 `fetchBalance` ……
   * 这 6 条用例**一条都不会红**。真正的差异由本文件末尾的
   * `真实 fetchBalance 链路` 一节覆盖；**接线正确性**（工厂配置项把哪一份
   * 凭据解析器交给了共享编排）由 `credential-resolver.spec.ts` 的
   * 「LobsterAI 用**自己的**凭据解析器」那两条覆盖（形状损坏的凭据不得被交出 +
   * 形状合法的照常交出）。
   * ⚠️ 原先此处指向的 `pickCallBlock` 守卫**已随 Task 6 删除**（那个 helper 锚的
   * 旧调用形不存在了），故指针改指上面那两条。
   * ⚠️ **别把 `buddy-permanent-lock.spec.ts` 的行为组算作接线的守卫** ——
   * 已实测：把 `src/index.ts` 的 `readCredential` 换成**另一家的**解析器后，
   * 该文件 **42/42 全绿**（它只在 `() => undefined` 这种「恒不交凭据」的实现下红）。
   * 真正会因「接错了另一家的解析器」而变红的只有 `credential-resolver.spec.ts`
   * 那两条（第三轮复审已双向复现）。
   */
  /** 造一个选择器：余额由固定表给出，凭据解析恒成功。 */
  function makeSelector<TProduct, TCredential extends { token: string }>(
    product: TProduct,
    balanceById: Record<string, CreditBalance>,
  ) {
    return new BuddyBalanceSelector<TProduct, TCredential>({
      product,
      resolveCredential: async (ref) => ({ token: `cred-${ref}` }) as TCredential,
      fetchBalance: async (credential) => balanceById[credential.token.replace('cred-', '')] ?? null,
      // ⚠️ **必须钉住窗口**（实测：不钉则读真实环境变量，设
      // `DSH_BUDDY_EXPIRING_WINDOW_DAYS=0` —— 一个*合法*值，见
      // `buddy-balance-rank.ts` 对 0 的支持 —— 会让这 2 条用例假红）。
      // 本节 BALANCES 用「3 天 vs 30 天」构造，窗口取 15 天才与断言一致。
      windowMs: 15 * DAY,
    })
  }

  const CANDIDATES = [
    { id: 'permanent-only', credentialRef: 'permanent-only' },
    { id: 'has-expiring', credentialRef: 'has-expiring' },
  ]
  const BALANCES = {
    'permanent-only': traeBalance([
      { name: '长期包', unit: 'credit', remaining: 500, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: Date.now() + 30 * DAY },
    ]),
    'has-expiring': traeBalance([
      { name: '签到奖励', unit: 'credit', remaining: 150, total: 0, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '', deductionEndTime: Date.now() + 3 * DAY },
    ]),
  }

  // 两家各跑一遍：泛型化的意义就是同一套编排对任意 provider 成立。
  for (const label of ['TRAE', 'LobsterAI']) {
    it(`${label}：未锁定 → 优先选有快到期积分的号（哪怕它排在后面）`, async () => {
      const selector = makeSelector<{ id: string }, { token: string }>({ id: label }, BALANCES)
      const picked = await pickBuddyAccount(selector, CANDIDATES, {
        allowPermanent: true,
        resolveCredential: async (ref) => ({ token: `cred-${ref}` }),
      })
      expect(picked.kind).toBe('account')
      if (picked.kind === 'account') expect(picked.account.id).toBe('has-expiring')
    })

    it(`${label}：★ 已锁定 + 只剩永久积分 → locked（不消耗永久积分）`, async () => {
      const selector = makeSelector<{ id: string }, { token: string }>({ id: label }, BALANCES)
      const picked = await pickBuddyAccount(selector, [CANDIDATES[0]!], {
        allowPermanent: false,
        resolveCredential: async (ref) => ({ token: `cred-${ref}` }),
      })
      expect(picked.kind).toBe('locked')
    })

    it(`${label}：未锁定 + 只剩永久积分 → 可用（解锁生效）`, async () => {
      const selector = makeSelector<{ id: string }, { token: string }>({ id: label }, BALANCES)
      const picked = await pickBuddyAccount(selector, [CANDIDATES[0]!], {
        allowPermanent: true,
        resolveCredential: async (ref) => ({ token: `cred-${ref}` }),
      })
      expect(picked.kind).toBe('account')
    })
  }
})

describe('前后端能力声明一致（trae / lobsterai）', () => {
  it('后端白名单含两家，且未误加其它 provider', () => {
    expect(PERMANENT_LOCK_PROVIDERS.has('trae')).toBe(true)
    expect(PERMANENT_LOCK_PROVIDERS.has('lobsterai')).toBe(true)
    // 原有三家不得丢失
    expect(PERMANENT_LOCK_PROVIDERS.has('loomy')).toBe(true)
    expect(PERMANENT_LOCK_PROVIDERS.has('buddy')).toBe(true)
    expect(PERMANENT_LOCK_PROVIDERS.has('workbuddy')).toBe(true)
    // ⚠️ cline 没有逐包到期时间，加进来开关无效
    expect(PERMANENT_LOCK_PROVIDERS.has('cline')).toBe(false)
    // ⚠️ qoder / qodercn **已于 2026-10-20 加入**（用户要求补齐三档分档 + 永久锁）：
    //    此前「没有逐包到期时间 ⇒ 加进来也没用」的判断已被证伪 —— 恰恰因为
    //    **拿不到逐包到期**，哨兵被识别为永久桶，「锁定永久积分」才真能把它保住。
    //    ⇒ 本用例的反向断言不再把这两家列为「不得登记」。
  })

  it('前端 supportsPermanentLock 与后端逐项一致', () => {
    for (const id of PERMANENT_LOCK_PROVIDERS) {
      expect(supportsPermanentLock(id), id).toBe(true)
    }
    // 反向：后端没登记的，前端也不得渲染按钮
    // ⚠️ qoder / qodercn **已于 2026-10-20 移出本名单**（它们已登记
    //    `permanentLock: true`）；留着会让本用例红 —— 这是正确的红灯，
    //    不许靠放宽断言绕过。
    // ⚠️ minimax / minimaxintl / astudio 同理（三家均于 2026-10-20 登记）。
    for (const id of ['cline', 'raccoon', 'zcode', 'codearts']) {
      expect(supportsPermanentLock(id), id).toBe(false)
    }
  })

  it('★ 两家走「带天数」的文案（不得落到 Loomy 那套「每日赠送额度」）', () => {
    // ⚠️ 这是真实易错点：它们没有「每日额度」概念，落到 Loomy 文案会说反。
    for (const id of ['trae', 'lobsterai', 'buddy', 'workbuddy']) {
      const copy = permanentLockCopy(id, 7)
      expect(copy.days, id).toBe(7)
      expect(copy.lockTitle, id).toContain('7 天内到期')
    }
  })

  it('Loomy 仍走「每日赠送额度」文案（无窗口概念）', () => {
    const copy = permanentLockCopy('loomy', 7)
    expect(copy.days).toBeNull()
    expect(copy.lockTitle).toContain('每日赠送额度')
    expect(copy.lockTitle).not.toContain('7 天内到期')
  })
})

/**
 * ⚠️ **provider 特定的**那一段：各自真实的 `fetchBalance` 能否把**真实响应形状**
 * 归一化成可分桶的余额。
 *
 * 上一节的 `for` 循环用的是同一个假 product / 同一种假凭据，测不到任何差异；
 * 而整个功能成立的前提恰恰是「两家的响应形状不同，但归一化后结构一致」
 * （TRAE 的条目级 `expire_time` 秒级 Unix vs LobsterAI 的 `expiresAt` ISO 8601）。
 * 少了这一节，改坏任一家的归一化都不会有任何用例变红。
 */
describe('真实 fetchBalance 链路：各家响应形状 → 同一套分桶', () => {
  /** 造一个只回固定响应的 fetcher。 */
  function stubFetch(payload: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  }

  it('★ TRAE：条目级 expire_time（秒）归一化后可分桶', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    // ⚠️ 响应**没有** code/data 包裹 —— `postJson` 已解包（对照 trae-credits.spec.ts
    // 的既有用例：顶层直接是 `user_entitlement_pack_list`）。
    const balance = await fetchTraeCreditBalance(traeCredential(), TRAE, stubFetch({
      user_entitlement_pack_list: [{
        expire_time: nowSec + 3 * 86400,
        entitlement_base_info: {
          display_desc: '签到奖励',
          quota: { credits_limit: 150 },
        },
        usage: { credits_amount: 0 },
      }],
    }))
    expect(balance, 'TRAE 余额应可解析').not.toBeNull()
    const split = splitBuddyCreditsByExpiry(balance!, Date.now(), 15 * DAY)
    // 3 天内到期 ⇒ 必须落「快到期」桶，否则锁定时永远选不中它
    expect(split).toEqual({ expiring: 150, permanent: 0, imminent: 150 })
  })

  it('★ LobsterAI：expiresAt（ISO 8601）归一化后可分桶', async () => {
    // ⚠️ 用完整的 ISO 8601 带 Z：`Date.parse` 直接认，而实现里那个
    // `replace(' ', 'T')` 只针对「空格分隔」的旧格式。
    const soon = new Date(Date.now() + 4 * 86400000).toISOString()
    const balance = await fetchLobsteraiCreditBalance(lobsteraiCredential(), LOBSTERAI, stubFetch({
      code: 0,
      data: {
        totalCreditsRemaining: 100,
        creditItems: [{ type: 'campaign', label: '每日登录奖励', creditsRemaining: 100, expiresAt: soon }],
      },
    }))
    expect(balance, 'LobsterAI 余额应可解析').not.toBeNull()
    const split = splitBuddyCreditsByExpiry(balance!, Date.now(), 15 * DAY)
    expect(split).toEqual({ expiring: 100, permanent: 0, imminent: 100 })
  })

  it('★ 两家归一化后都带 deductionEndTime（分桶判据才拿得到到期时间）', () => {
    // 这是「能复用同一个分桶函数」的前提；哪一家不再设这个字段，功能就静默退化成
    // 「全部落永久桶」⇒ 锁定后永远选不中任何账号。
    const mk = (name: string, deductionEndTime?: number) => ({
      name, unit: 'credit', remaining: 100, total: 100, used: 0, active: true,
      cycleStartTime: '', cycleEndTime: '', expiredTime: '',
      ...(deductionEndTime === undefined ? {} : { deductionEndTime }),
    })
    const withEnd = traeBalance([mk('a', Date.now() + DAY)])
    expect(withEnd.packages[0]!.deductionEndTime, '包上必须带 deductionEndTime').toBeGreaterThan(0)
    // 拿不到时**不设**该字段（而非设 0）—— 设 0 会被当作「1970 年到期」
    expect(traeBalance([mk('b')]).packages[0]).not.toHaveProperty('deductionEndTime')
  })
})

/** 构造一条最小 TRAE 凭据。 */
function traeCredential(): TraeCredential {
  return {
    access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7200000),
    uid: 'uid-1', nickname: 'n', machine_id: 'a'.repeat(32), device_id: 'b'.repeat(32),
  }
}

/**
 * 构造一条最小 LobsterAI 凭据。
 *
 * ⚠️ 字段**不能省**：`requestJson` 会拼 `uid` / `user_id` / `uuid` 等身份头，
 * 缺字段时请求在到达响应解析之前就失败了 —— 那会让本节用例因为「造数据不全」
 * 而红，掩盖真正要测的归一化逻辑（踩过一次：空对象强转导致 LobsterAI 那条红）。
 * 字段集对齐 `lobsterai-credits.spec.ts` 的 `makeCredential`。
 */
function lobsteraiCredential(): LobsteraiCredential {
  return {
    access_token: 'AT', refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000),
    uid: 'uid-1', user_id: 'yid-1', nickname: '测试',
    uuid: 'uuid-1', first_keyfrom: '1700000000000', latest_keyfrom: '1700000000000',
  }
}
