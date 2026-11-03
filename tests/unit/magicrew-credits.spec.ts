import { describe, expect, it, vi } from 'vitest'
import {
  fetchMagicrewBalance,
  fetchMagicrewModelPoints,
  magicrewExpiry,
  magicrewIsFree,
  magicrewRateOf,
} from '../../src/magicrew-credits.js'
import { NEVER, UNUSABLE } from '../../src/aggregate-core.js'
import type { CreditBalance, CreditPackage } from '../../src/credits.js'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 折算判据用的固定时钟（`now` 可注入 ⇒ 单测不必等真时间）。 */
const NOW = Date.parse('2026-10-29T00:00:00.000Z')
/** `2026-11-27 13:47:42`（+08:00）= `2026-11-27T05:47:42Z`。 */
const EXPIRES_AT = Date.parse('2026-11-27T05:47:42.000Z')

function packageOf(overrides: Partial<CreditPackage> = {}): CreditPackage {
  return {
    name: '限时积分', unit: '积分', remaining: 93, total: 93, used: 0,
    active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
    deductionEndTime: EXPIRES_AT,
    ...overrides,
  }
}

/** 与 `fetchMagicrewBalance` 的实测报文同形（total 1093 + 一个 11-27 到期批次）。 */
function pointsResponse(): Response {
  return jsonResponse({
    code: 1000,
    data: {
      total_points: 1093,
      expiring_quota_details: [
        { quota_id: 1, expires_at: '2026-11-27 13:47:42', remaining_points: 93 },
      ],
    },
  })
}

describe('magicrew 积分', () => {
  it('★ 解析 total_points 与到期批次（expires_at 无时区 ⇒ 按 UTC+8）', async () => {
    const fetchImpl = async () => jsonResponse({
      code: 1000,
      data: {
        total_points: 1093,
        expiring_quota_details: [
          { quota_id: 1, expires_at: '2026-11-27 13:47:42', remaining_points: 93 },
        ],
      },
    })
    const balance = await fetchMagicrewBalance({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(balance?.total).toBe(1093)
    /**
     * ⚠️ **两条包**（I3，2026-10-29；**2026-11-01 修正了归因**）：
     * `expiring_quota_details` 是「**所有**会过期的批次」，不是「只有临期的」——
     * 真实账号实测里它同时含**今天到期**（200 / 47）与**一年后到期**
     * （2027-11-03 的 1000 / 200）。而 `total_points` 是全部（1093）⇒
     * 两者之差是上游**根本不下发到期时间**的那部分 ⇒ 必须**合成一条包**，
     * 否则账号卡 hover 会「只列 93、合计 1093」让用户以为丢了积分。
     * ⇒ 断言 `sum(remaining) === total`（守恒），而不是「恰好 1 条」。
     *
     * ⚠️ 这条合成包的名字是「**永久积分**」，不是「长期积分」：它**没有**
     * `deductionEndTime`，前端 `splitCreditsByExpiry` 会把它落进 `permanent` 桶
     * （绿）；真正的「长期」是**有到期时间但超出窗口**的批次（上面那条 2027 年的）。
     * 旧名字让它看起来像「长期」，而实际渲染成「永久」——两处语义打架。
     */
    expect(balance?.packages).toHaveLength(2)
    expect(balance?.packages.reduce((s, p) => s + p.remaining, 0)).toBe(1093)
    // 临期包（有到期时刻）
    const expiring = balance?.packages.find((p) => p.deductionEndTime !== undefined)
    expect(expiring?.remaining).toBe(93)
    // 2026-11-27 13:47:42 +08:00 = 2026-11-27T05:47:42Z
    expect(new Date(expiring!.deductionEndTime!).toISOString()).toBe('2026-11-27T05:47:42.000Z')
    // 长期包：**没有** `deductionEndTime`（⇒ `magicrewExpiry` 会跳过它，仍得 NEVER）
    const longLived = balance?.packages.find((p) => p.deductionEndTime === undefined)
    expect(longLived?.remaining).toBe(1000)
    expect(longLived?.name).toBe('永久积分')
  })

  it('★ 倍率：input_points / 2000（逐个核对过）', () => {
    expect(magicrewRateOf({ input_points: 200 })).toBeCloseTo(0.1)
    expect(magicrewRateOf({ input_points: 20 })).toBeCloseTo(0.01)
    expect(magicrewRateOf({ input_points: 1200 })).toBeCloseTo(0.6)
    expect(magicrewRateOf({})).toBeUndefined()
    // ⚠️ free 只看厂商声明 input_points === 0，不从 rate 反推
    expect(magicrewRateOf({ input_points: 0 })).toBe(0)
  })

  /**
   * ⚠️ 入参是 `unknown`，强转有洞：`Number([]) === 0`、`Number(true) === 1`
   * ⇒ 未收紧时会得到 `0`（**看起来像免费**）与 `0.0005`（**看起来像收费**），
   * 两个都是凭空的结论。判据只放行 `number` 与非空数字字符串。
   */
  it('★ 倍率：`[]` / `true` 这类可被强转的非数 ⇒ undefined（不许猜成 0 或 0.0005）', () => {
    expect(magicrewRateOf({ input_points: [] })).toBeUndefined()
    expect(magicrewRateOf({ input_points: true })).toBeUndefined()
    expect(magicrewRateOf({ input_points: null })).toBeUndefined()
    expect(magicrewRateOf({ input_points: '  ' })).toBeUndefined()
    expect(magicrewRateOf({ input_points: 'abc' })).toBeUndefined()
    expect(magicrewRateOf({ input_points: Number.NaN })).toBeUndefined()
  })

  /**
   * ★★ **`Number()` 的进制陷阱**（2026-11-01 三审）。
   *
   * 本文件此前自带一份「只放行 number 与非空字符串」的实现，**没有**限定十进制
   * ⇒ `"0x10"` 被 `Number()` 解析成 **16**、`"1e3"` 成 **1000**，
   * 而签到侧的同名字段被解析成 0 ⇒ 同一个上游字段在两个模块解释不同。
   *
   * 现在两处共用 `magicrew-number.ts` 的 `magicrewDecimalOf`（只认十进制），
   * 本用例钉住积分侧这一半（签到侧见 `magicrew-checkin.spec.ts` 的 points 边界组）。
   */
  it('★★ 倍率：十六进制 / 科学计数 / 千分位 ⇒ undefined（只认十进制字面量）', () => {
    expect(magicrewRateOf({ input_points: '0x10' })).toBeUndefined()
    expect(magicrewRateOf({ input_points: '0b11' })).toBeUndefined()
    expect(magicrewRateOf({ input_points: '1e3' })).toBeUndefined()
    expect(magicrewRateOf({ input_points: '1,234' })).toBeUndefined()
    expect(magicrewRateOf({ input_points: '1,234 积分' })).toBeUndefined()
    // 反向：**真正的十进制字符串必须放行**（收得太紧会让所有正常响应读不到）。
    expect(magicrewRateOf({ input_points: '200' })).toBeCloseTo(0.1)
    expect(magicrewRateOf({ input_points: ' 200 ' })).toBeCloseTo(0.1)
    expect(magicrewRateOf({ input_points: '200.0' })).toBeCloseTo(0.1)
  })

  /**
   * ★★ **负单价一律读不到**（2026-11-01 三审：原先 `'-5'` 会得到 **-0.0025 负倍率**）。
   *
   * 负倍率会直接显示在模型列表的「倍率」列上，用户看到「-0.0025×」只会困惑；
   * 而这个值还会参与排序/比较逻辑。单价不可能为负 ⇒ 读不到（`undefined`）。
   *
   * ⚠️ 与**余额**的区别：`total_points` 可以是负数（欠费，上游实测 `-31`），
   * 但它走 `fetchMagicrewBalance` 的直接读取，**不经这里** ⇒ 不会误伤。
   */
  it('★★ 倍率：负单价 ⇒ undefined（不许算出负倍率）', () => {
    expect(magicrewRateOf({ input_points: '-5' })).toBeUndefined()
    expect(magicrewRateOf({ input_points: -5 })).toBeUndefined()
    expect(magicrewRateOf({ input_points: '-0.5' })).toBeUndefined()
    // 反向：0 与正数照常（0 = 免费是合法值）。
    expect(magicrewRateOf({ input_points: 0 })).toBe(0)
    expect(magicrewRateOf({ input_points: '0' })).toBe(0)
  })

  it('★ 倍率：**数字字符串**仍照旧可算（收紧不得连合法输入一起废掉）', () => {
    expect(magicrewRateOf({ input_points: '200' })).toBeCloseTo(0.1)
    expect(magicrewRateOf({ input_points: ' 0 ' })).toBe(0)
  })

  /**
   * `free` 需要**代码出口**（全局约束第 11 条是硬项）：否则任务 6/7 很可能顺手写成
   * `rate === 0` —— 那在「字段缺失」与「真的是 0」之间分不开，一旦有人把未知压成 0，
   * 就会把**没有价格的模型全判成免费**。
   */
  it('★ free：只有「已知且 input_points === 0」才为真（缺字段 ≠ 免费）', () => {
    expect(magicrewIsFree({ input_points: 0 })).toBe(true)
    expect(magicrewIsFree({ input_points: '0' })).toBe(true)
    // 未知/不可读 ⇒ 不是免费（宁可显示收费，也不要白送）
    expect(magicrewIsFree({})).toBe(false)
    expect(magicrewIsFree({ input_points: null })).toBe(false)
    expect(magicrewIsFree({ input_points: '' })).toBe(false)
    expect(magicrewIsFree({ input_points: [] })).toBe(false)
    expect(magicrewIsFree({ input_points: true })).toBe(false)
    // 收费 ⇒ 不是免费
    expect(magicrewIsFree({ input_points: 200 })).toBe(false)
    // 与倍率同源：倍率为 0 ⇔ 免费（两者不得各写一份判据）
    expect(magicrewRateOf({ input_points: 0 }) === 0).toBe(magicrewIsFree({ input_points: 0 }))
    expect(magicrewRateOf({}) === 0).toBe(magicrewIsFree({}))
  })
})

/**
 * 计费取数腿（`fetchMagicrewModelPoints`）。
 *
 * ⚠️ `POST { model_ids: [...] }` 在本仓**只此一处**、形状**未取证**：
 * 设计规格 §1.7 的唯一实发报文是**单对象**，而旧实现只认数组 ⇒ 单对象会被
 * `Array.isArray` 吃成 `[]` ⇒ 倍率与 free **全静默 undefined**。故这里同时锁
 * 「数组」与「单对象」两种，并锁 `billing_type` 的行选取。
 */
describe('magicrew 模型计费（倍率 / free 取数腿）', () => {
  /** 固定 `code: 1000` 的信封，只让 `data` 变形状。 */
  const fetchOf = (data: unknown) => vi.fn(async () => jsonResponse({ code: 1000, data }))

  function modelPointsOf(fetchImpl: ReturnType<typeof vi.fn>) {
    return fetchMagicrewModelPoints({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      modelIds: ['deepseek-v4.1-flash'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
  }

  it('★ ① data 是**数组**（既有形状）⇒ 正常解析（不是退化）', async () => {
    const fetchImpl = fetchOf([
      { model_id: 'deepseek-v4.1-flash', billing_type: 'TextTokens', input_points: 200, output_points: 800 },
      { model_id: 'qwen3.8-max', billing_type: 'TextTokens', input_points: 1200, output_points: 2400 },
    ])
    const points = await modelPointsOf(fetchImpl)
    expect(points).toEqual({
      'deepseek-v4.1-flash': { inputPoints: 200, outputPoints: 800 },
      'qwen3.8-max': { inputPoints: 1200, outputPoints: 2400 },
    })
  })

  it('★ ② data 是**单个对象**（§1.7 唯一实发形状）⇒ 同样解析出该模型的价格', async () => {
    // 逐字取自设计规格 §1.7 的报文形状。
    const fetchImpl = fetchOf({
      model_id: 'deepseek-v4.1-flash',
      billing_type: 'TextTokens',
      input_points: 200,
      output_points: 800,
    })
    const points = await modelPointsOf(fetchImpl)
    // ⚠️ 旧实现（只认数组）在这里返回 `{}` ⇒ 倍率与 free 全静默 undefined。
    expect(points).toEqual({
      'deepseek-v4.1-flash': { inputPoints: 200, outputPoints: 800 },
    })
  })

  it('★ ③ 同一 model_id 有 TextTokens 与 ImageCount 两行 ⇒ 恒取 TextTokens（两种顺序都锁）', async () => {
    const textRow = { model_id: 'qwen3.8-max', billing_type: 'TextTokens', input_points: 1200, output_points: 2400 }
    const imageRow = { model_id: 'qwen3.8-max', billing_type: 'ImageCount', input_points: 999, output_points: 999 }

    // ⚠️ **两种顺序都断**，因为单独任一种都能被一个错误实现蒙对：
    //   · TextTokens 在**后** ⇒ 纯 last-wins 恰好也拿到它（蒙对）；
    //   · TextTokens 在**前** ⇒ 纯 first-wins 恰好也拿到它（蒙对）。
    //   两条合起来才逼出「按 billing_type 选行」这件事本身。
    const textLast = await modelPointsOf(fetchOf([imageRow, textRow]))
    expect(textLast['qwen3.8-max']).toEqual({ inputPoints: 1200, outputPoints: 2400 })

    const textFirst = await modelPointsOf(fetchOf([textRow, imageRow]))
    expect(textFirst['qwen3.8-max']).toEqual({ inputPoints: 1200, outputPoints: 2400 })
  })

  it('★ ④ code !== 1000 ⇒ 返回 {}（既有行为，别退化）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 5000,
      data: [{ model_id: 'deepseek-v4.1-flash', billing_type: 'TextTokens', input_points: 200 }],
    }))
    const points = await modelPointsOf(fetchImpl)
    expect(points).toEqual({})
  })

  /** 与 `fetchMagicrewBalance` 的 ④ **同型**（信封为 `null`）：第二处必须一起守。 */
  it('★ ⑤ 整个 body 是 JSON 字面量 null ⇒ 返回 {}（信封为 null 不抛 TypeError）', async () => {
    const fetchImpl = vi.fn(async () => new Response('null', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    expect(await modelPointsOf(fetchImpl)).toEqual({})
  })
})

describe('magicrew 临期折算', () => {
  it('★ 有余额 + 到期批次 ⇒ 返回最早到期时刻', async () => {
    const result = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      cachedBalance: async () => ({
        total: 1093,
        packages: [packageOf()],
        expiredTotal: 0,
      }),
    })
    expect(result).toBe(EXPIRES_AT)
  })

  /**
   * ⚠️ 上一条**只有单个批次** ⇒ 「取最小 / 取最大 / 取第一条」三者**同值**，
   * 把 `at < earliest` 改成 `at > earliest`（取最晚）、或改成 `earliest = packages[0]`
   * （取第一条）都**照样全绿** ⇒ 那条用例对「最早」这个词**无牙**。
   *
   * 这一条把**较晚**的批次排在数组**前面**：三者的答案就此分叉 ——
   * 「取最早」⇒ `EARLIER`；「取最晚」/「取第一条」⇒ `LATER`。
   */
  it('★ 两个批次且较晚那个在数组前面 ⇒ 仍取**最早**那个时刻（不是最晚、也不是第一条）', async () => {
    const later = Date.parse('2026-12-20T05:47:42.000Z')
    const earlier = EXPIRES_AT
    const result = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      cachedBalance: async () => ({
        total: 200,
        // ⚠️ 顺序是承重件：较晚的在前 ⇒ 取第一条会拿到 later。
        packages: [
          packageOf({ remaining: 100, deductionEndTime: later }),
          packageOf({ remaining: 100, deductionEndTime: earlier }),
        ],
        expiredTotal: 0,
      }),
    })
    expect(result).toBe(earlier)
    expect(result).not.toBe(later)
  })

  /**
   * `remaining <= 0` 的批次必须被**跳过**（上游可能仍回已烧光的批次）。
   *
   * ⚠️ 让零余量批次的 `deductionEndTime` **远早于**正常批次：不跳过的实现会把它
   * 当成「最早到期」⇒ 拿到 `STALE`，而不是正常批次的 `EXPIRES_AT`。
   */
  it('★ remaining === 0 的批次被跳过（即使它到期更早）⇒ 得到正常批次那个时刻', async () => {
    const stale = Date.parse('2026-11-05T00:00:00.000Z')
    const result = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      cachedBalance: async () => ({
        total: 93,
        packages: [
          // 零余量 + 更早到期：不跳过就会成为 earliest。
          packageOf({ remaining: 0, deductionEndTime: stale }),
          packageOf({ remaining: 93, deductionEndTime: EXPIRES_AT }),
        ],
        expiredTotal: 0,
      }),
    })
    expect(result).toBe(EXPIRES_AT)
    expect(result).not.toBe(stale)
  })

  it('★ 余额烧光 ⇒ UNUSABLE（不再被聚合选中）', async () => {
    const result = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      cachedBalance: async () => ({ total: 0, packages: [], expiredTotal: 0 }),
    })
    expect(result).toBe(UNUSABLE)
  })

  it('★ 有余额但无到期批次 ⇒ NEVER（长期积分，排最后但不剔除）', async () => {
    const result = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      cachedBalance: async () => ({ total: 500, packages: [], expiredTotal: 0 }),
    })
    expect(result).toBe(NEVER)
  })

  it('★ 取数失败（fetchMagicrewBalance 返回 undefined）⇒ UNUSABLE（不猜）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 5000, data: {} }))
    const result = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toBe(UNUSABLE)
  })

  it('★ 过期批次（deductionEndTime 在过去）不作有效批次 ⇒ 剩余只有它时是 NEVER（不是「最早作废」）', async () => {
    const past = Date.parse('2026-10-01T00:00:00.000Z')
    const balance = (packages: CreditPackage[]): CreditBalance =>
      ({ total: 100, packages, expiredTotal: 0 })

    // 上游过期后仍回该批次 ⇒ 不判它就会拿到「过去时刻」⇒ 该账号每轮排最前。
    const mixed = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      cachedBalance: async () => balance([
        packageOf({ remaining: 50, deductionEndTime: past }),
        packageOf({ remaining: 50, deductionEndTime: EXPIRES_AT }),
      ]),
    })
    expect(mixed).toBe(EXPIRES_AT)

    // ⚠️ **2026-11-02 改（PR #168 对抗审计 B1）**：原先断言 NEVER（「有余额但无临期」）。
    //    但全是过期批次 ⇒ 那 100 分**一分也扣不到** ⇒ 必须判 UNUSABLE（渠道退出轮换），
    //    与 `sharedPackageExpiry` / `splitBuddyCreditsByExpiry` / 前端 `expired` 桶同判；
    //    否则锁定态下这个零可用额度的号仍会被选中、请求必失败。
    const onlyPast = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      cachedBalance: async () => balance([packageOf({ deductionEndTime: past })]),
    })
    expect(onlyPast).toBe(UNUSABLE)
  })
})

/**
 * 取数腿（`src/provider-runtime.ts:218-231` 的契约）：`cachedBalance` 缺席、
 * 返回 `null`、返回 `undefined` 三种「没有读数」都必须**自己发请求**。
 *
 * ⚠️ 这三条（+ ③b）是本块存在的理由：少这条腿 ⇒ 任务 6 接线时不注入缓存即
 * 恒 `UNUSABLE` ⇒ 该渠道在聚合候选表里**静默消失**。
 */
describe('magicrew 临期折算：缓存的三种「没有」都必须回落自取', () => {
  /** 只用来「投毒」的桩：若实现错误地忽略缓存，会拿到 total 0 ⇒ UNUSABLE。 */
  const poisonedFetch = () => vi.fn(async () => jsonResponse({
    code: 1000,
    data: { total_points: 0, expiring_quota_details: [] },
  }))

  it('★ ① 给了缓存且有效 ⇒ 吃缓存，且**零请求**', async () => {
    const fetchImpl = poisonedFetch()
    const result = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      cachedBalance: async () => ({
        total: 1093,
        packages: [packageOf()],
        expiredTotal: 0,
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toBe(EXPIRES_AT)
    expect(fetchImpl).toHaveBeenCalledTimes(0)
  })

  it('★ ② 不给 cachedBalance ⇒ 自己发一次请求，结论与 ① 相同', async () => {
    const fetchImpl = vi.fn(async () => pointsResponse())
    const result = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toBe(EXPIRES_AT)
  })

  it('★ ③ cachedBalance 返回 null（查询失败）⇒ 回落自取（不是 TypeError、不是 UNUSABLE）', async () => {
    const fetchImpl = vi.fn(async () => pointsResponse())
    const result = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      cachedBalance: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toBe(EXPIRES_AT)
  })

  it('★ ③b cachedBalance 返回 undefined（本次没有共享读数）⇒ 同样回落自取', async () => {
    const fetchImpl = vi.fn(async () => pointsResponse())
    const result = await magicrewExpiry({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      now: NOW,
      cachedBalance: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toBe(EXPIRES_AT)
  })
})

/**
 * `fetchMagicrewBalance` 的四条**失败出口**（此前零覆盖）。
 *
 * 四条都必须返回 `undefined`（**不猜**）：调用方 `magicrewExpiry` 据它判
 * `UNUSABLE`，猜一个余额出来会让「取数失败」与「真有余额」同形。
 */
describe('magicrew 余额取数：四条失败出口', () => {
  const balanceOf = (fetchImpl: unknown) => fetchMagicrewBalance({
    jwt: 'j.w.t',
    organizationCode: 'org1',
    fetchImpl: fetchImpl as typeof fetch,
  })

  it('★ ① 非 JSON（502 + HTML）⇒ undefined（不许抛）', async () => {
    // 网关 5xx 回的 HTML 是本仓实测主导形态，`JSON.parse` 必然抛。
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }))
    expect(await balanceOf(fetchImpl)).toBeUndefined()
  })

  it('★ ② code !== 1000 ⇒ undefined', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 5000,
      data: { total_points: 1093, expiring_quota_details: [] },
    }))
    expect(await balanceOf(fetchImpl)).toBeUndefined()
  })

  it('★ ③ data 里没有 total_points（不可读成有限数）⇒ undefined', async () => {
    // 有 code: 1000 但没有 total_points ⇒ 若把 `undefined`/NaN 当余额，
    // 会把「取数退化」伪装成「余额为 0」。
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1000,
      data: { expiring_quota_details: [] },
    }))
    expect(await balanceOf(fetchImpl)).toBeUndefined()
  })

  /**
   * ## ⚠️⚠️ 这条曾是**真缺陷**的特征化用例（5c 发现，5d 已修）
   *
   * 原实现（5c 时的 `src/magicrew-credits.ts:98`）直接读 `envelope.code`，而
   * `JSON.parse('null') === null` ⇒ `envelope` 是 `null` ⇒ **抛**
   * `TypeError: Cannot read properties of null (reading 'code')`。
   *
   * 为什么必须修：本函数的契约是「取数失败 ⇒ `undefined`」，调用方 `magicrewExpiry`
   * 据它判 `UNUSABLE`；抛出去就变成「余额折算整轮 reject」，与「取数失败」**不同形**。
   * 且与 ④b（`data: null`）**不同形**：那条被 `?? {}` 兜住了 ⇒ 缺口在**信封**这一层。
   *
   * 5d 已加 `if (typeof parsed !== 'object' || parsed === null) return undefined`
   * （同型守卫见 `src/credits.ts:526-529`）⇒ 本条从「断言抛 TypeError」改为断言
   * `undefined`，与 ①②③ 同形。
   */
  it('★ ④ 整个 body 是 JSON 字面量 null ⇒ undefined（信封为 null 不抛 TypeError）', async () => {
    const fetchImpl = vi.fn(async () => new Response('null', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    expect(await balanceOf(fetchImpl)).toBeUndefined()
  })

  it('★ ④b data 为 null ⇒ undefined（`?? {}` 兜住，不与 ④ 同形）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 1000, data: null }))
    expect(await balanceOf(fetchImpl)).toBeUndefined()
  })

  /**
   * ⚠️ 全仓有**两处** `remaining <= 0` 的 skip，判据不同、互不遮蔽：
   *  - 取数阶段（本文件 `fetchMagicrewBalance`，按上游的 `remaining_points`）
   *  - 折算阶段（`magicrewExpiry`，按 `packages[].remaining`）
   *
   * 折算阶段那条会**顺带**掩掉取数阶段的漏跳（零余量批次进不了 `earliest`），
   * 所以取数阶段的 skip 必须**直接看 `packages`**才测得动。
   */
  it('★ ⑤ remaining_points: 0 的批次在**取数阶段**就被剔除（不进 packages）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1000,
      data: {
        total_points: 93,
        expiring_quota_details: [
          { quota_id: 1, expires_at: '2026-11-05 00:00:00', remaining_points: 0 },
          { quota_id: 2, expires_at: '2026-11-27 13:47:42', remaining_points: 93 },
        ],
      },
    }))
    const balance = await balanceOf(fetchImpl)
    expect(balance?.packages).toHaveLength(1)
    expect(balance?.packages[0]?.remaining).toBe(93)
  })
})

/**
 * 2026-11-01 二审（行为红队）挖出的四个**降级质量**真缺陷 —— 都不是「上游不发」，
 * 而是「上游发了一个我们没预料到的**类型/形状**，我们把它静默吃掉了」。
 *
 * 共同特征：**不报错、不打日志、与「凭据失效」或「余额为零」同形**，
 * 用户只看到积分变 0 或账号突然不可用。这四条的判别力全在「别家正常的输入不受影响」上，
 * 所以**多数**条目带一个「对照格」（同一次取数里放一条**正常**批次/正常 total）——
 * 不是每条都有：纯「越界日期」那两条的对照在断言里，不在 fixture 里。
 */
describe('magicrew 余额取数：类型漂移与越界日期（真缺陷回归）', () => {
  const balanceOf = (fetchImpl: unknown) => fetchMagicrewBalance({
    jwt: 'j.w.t',
    organizationCode: 'org1',
    fetchImpl: fetchImpl as typeof fetch,
  })

  it('★★ `total_points` 是**数字字符串** ⇒ 照常解析（旧判据 `typeof === \'number\'` 会让整条余额消失）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1000,
      data: {
        total_points: '2661',
        expiring_quota_details: [
          { quota_id: 1, expires_at: '2026-11-27 13:47:42', remaining_points: 1661 },
        ],
      },
    }))
    const balance = await balanceOf(fetchImpl)
    // 整条余额仍在（这是最要紧的一格：旧实现这里返回 undefined）
    expect(balance).toBeDefined()
    expect(balance?.total).toBe(2661)
    // 残差合成同样按数字算 ⇒ 永久 1000
    expect(balance?.packages.reduce((s, p) => s + p.remaining, 0)).toBe(2661)
  })

  it('★★ `total_points` 是**负数**（欠费）⇒ 照常解析，不许判成「读不出」（余额口径允许负数）', async () => {
    // ⚠️ 这一格是「容错」必须用**允许负数**那个解析器的理由：模型单价/任务积分
    //    为负是错的，但**账户余额**为负是上游真实状态（实测出现过 -31）。
    //    若复用拒绝负数的 `magicrewDecimalOf`，这条会退化成「查询失败」。
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1000,
      data: { total_points: -31, expiring_quota_details: [] },
    }))
    const balance = await balanceOf(fetchImpl)
    expect(balance).toBeDefined()
    expect(balance?.total).toBe(-31)
    // 负余额不该合成出「永久积分」包（残差为负 ⇒ 不合成），否则表面积大于 total
    expect(balance?.packages).toHaveLength(0)
  })

  it('★★ `remaining_points` 是**数字字符串** ⇒ 该批次保留（旧判据会丢弃它并把金额并进「永久」）', async () => {
    // 旧行为：batch 被丢 ⇒ Σ批次 = 0 ⇒ 残差 = total = 150 ⇒ **临期 50 被标成永久 150**。
    // 后果不是「少显示」，而是**锁定永久积分时这个账号被误拒**（方向正好反了）。
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1000,
      data: {
        total_points: 150,
        expiring_quota_details: [
          { quota_id: 1, expires_at: '2026-11-05 00:00:00', remaining_points: '50' },
          { quota_id: 2, expires_at: '2027-11-03 23:02:08', remaining_points: 100 },
        ],
      },
    }))
    const balance = await balanceOf(fetchImpl)
    expect(balance?.packages).toHaveLength(2)
    expect(balance?.packages.map((p) => p.remaining).sort((a, b) => a - b)).toEqual([50, 100])
    // 守恒：合成包 = total − Σ批次 = 0 ⇒ 不该冒出「永久积分」包
    expect(balance?.packages.some((p) => p.name === '永久积分')).toBe(false)
  })

  it('★★ 越界 `expires_at`（`2026-13-45 25:99:99`）⇒ 不编造到期时刻（`Date.UTC` 会把它静默归一化成 2027-02-15）', async () => {
    // 旧行为：归一化成 1802630439000（2027-02-15）⇒ 前端落「长期」、后端落「永久」，
    // 而真实值根本不可知 —— 本家契约是「解析不出来就 undefined，绝不编造」。
    // 落桶方向：无 `deductionEndTime` ⇒ 永久桶（保守：锁定永久积分时宁可拦住，也不误烧）。
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1000,
      data: {
        total_points: 100,
        expiring_quota_details: [
          { quota_id: 1, expires_at: '2026-13-45 25:99:99', remaining_points: 100 },
        ],
      },
    }))
    const balance = await balanceOf(fetchImpl)
    expect(balance?.packages).toHaveLength(1)
    expect(balance?.packages[0]?.deductionEndTime).toBeUndefined()
  })

  it('★★ 批次合计**大于** `total_points`（上游自相矛盾）⇒ 守恒裁剪，且**临期优先保留**', async () => {
    // 行为红队实测形状：total 100，批次 200（远期）+ 50（临期）= 250。
    // 不裁的后果：三档合计 350 > 账户实际 100，用户没法判断哪个是真的。
    // 裁的顺序必须**先到期先保留**（否则被裁掉的是临期，方向反了）。
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1000,
      data: {
        total_points: 100,
        expiring_quota_details: [
          { quota_id: 1, expires_at: '2027-11-03 23:02:08', remaining_points: 200 },
          { quota_id: 2, expires_at: '2026-11-05 00:00:00', remaining_points: 50 },
        ],
      },
    }))
    const balance = await balanceOf(fetchImpl)
    // ① 守恒：合计恰好等于 total（不多不少）
    expect(balance?.packages.reduce((s, p) => s + p.remaining, 0)).toBe(100)
    // ② 临期那笔**整条保留**（50），远期那笔被裁到 50（不是丢掉临期）
    const expiring = balance?.packages.find((p) => p.deductionEndTime === Date.parse('2026-11-04T16:00:00.000Z'))
    expect(expiring?.remaining).toBe(50)
    const longTerm = balance?.packages.find((p) => p.deductionEndTime !== undefined && p.deductionEndTime !== expiring?.deductionEndTime)
    expect(longTerm?.remaining).toBe(50)
    // ③ 没有「永久积分」包（残差 0）
    expect(balance?.packages.some((p) => p.name === '永久积分')).toBe(false)
  })

  it('★★ 批次合计大于 total 但 total 为 0 ⇒ 全部裁掉（余额为 0 时不许还显示能用的积分）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1000,
      data: {
        total_points: 0,
        expiring_quota_details: [
          { quota_id: 1, expires_at: '2026-11-27 13:47:42', remaining_points: 100 },
        ],
      },
    }))
    const balance = await balanceOf(fetchImpl)
    expect(balance?.total).toBe(0)
    expect(balance?.packages).toHaveLength(0)
  })
})

describe('欠费（total < 0）与批次并存时不得丢弃明细（对抗审计 B5）', () => {
  const balanceWith = async (totalPoints: number) => await fetchMagicrewBalance({
    jwt: 'j.w.t',
    organizationCode: 'org1',
    fetchImpl: (async () => jsonResponse({
      code: 1000,
      data: {
        total_points: totalPoints,
        expiring_quota_details: [
          { quota_id: 1, expires_at: '2027-01-01 00:00:00', remaining_points: 100 },
        ],
      },
    })) as unknown as typeof fetch,
  })

  it('★ total=-31 且上游给了正批次 ⇒ 批次仍保留（不再整条丢弃）', async () => {
    const out = await balanceWith(-31)
    expect(out?.total).toBe(-31)
    // ⚠️ 旧实现 `budget = total = -31` ⇒ 首轮 break ⇒ packages=[] ⇒ 面板只剩「积分 -31」。
    expect(out?.packages.length, '批次明细必须保留').toBe(1)
    expect(out?.packages[0]?.remaining).toBe(100)
  })

  it('★ total=0 且批次和 > 0 ⇒ 仍然全部裁掉（与既有语义一致）', async () => {
    const out = await balanceWith(0)
    expect(out?.packages).toHaveLength(0)
  })
})
