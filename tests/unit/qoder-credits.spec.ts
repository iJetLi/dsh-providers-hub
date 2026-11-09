import { describe, expect, it, vi } from 'vitest'
import { fetchQoderBalanceDetailed, fetchQoderCreditBalance, QODER_PLAN_PACKAGE, QODER_USAGE_PATH } from '../../src/qoder-credits.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/qoder.js'

const cred: QoderCredential = buildQoderCredential(
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref' }), { machineId: 'm-1' })

/** 实测的真实响应形状（2026-09-19，真实凭据）。 */
function usageResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    displayMode: 'qoder',
    qoderUsage: {
      userId: '01a0b514-ad7c-7dca-ae92-70181beb532e',
      userType: 'personal_standard',
      usageType: 'credits',
      totalUsagePercentage: 0,
      isQuotaExceeded: false,
      expiresAt: 253402214400000,
      upgradeUrl: 'https://qoder.com/pricing?client=qoder',
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
      addOnQuota: {
        total: 100, used: 0, remaining: 100, percentage: 0, unit: 'credits',
        detailUrl: 'https://qoder.com/account/usage',
      },
      isPlanQuotaProrated: false,
      ...overrides,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('Qoder 积分余额', () => {
  it('读取 addOnQuota 的 100 积分（真实响应形状）', async () => {
    // 实测：userQuota.remaining=0 而 addOnQuota.remaining=100
    // —— 资源包余额在 addOnQuota 里，只读 userQuota 会得到 0（真实缺陷风险）
    const fetcher = vi.fn(async () => usageResponse()) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance).not.toBeNull()
    expect(balance!.total).toBe(100)
    expect(balance!.packages.length).toBeGreaterThan(0)
  })

  it('请求路径与鉴权头正确（Bearer + Cosy-ClientType，且不带签名）', async () => {
    const fetcher = vi.fn(async () => usageResponse()) as unknown as typeof fetch
    await fetchQoderCreditBalance(cred, QODER, fetcher)
    const call = (fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    expect(String(call[0])).toBe(`https://openapi.qoder.sh${QODER_USAGE_PATH}`)
    const headers = (call[1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers['Cosy-ClientType']).toBe('10')
  })

  it('userQuota 与 addOnQuota 同时非零时相加', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 500, used: 200, remaining: 300, percentage: 0.4, unit: 'credits' },
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    // 300（套餐剩余）+ 100（资源包剩余）
    expect(balance!.total).toBe(400)
  })

  /**
   * ## ⚠️⚠️ 「资源包」必须标 `expiryUnknown`（Gitee issue **IKTLMX**，2026-11-08）
   *
   * 报障：账号卡片写「积分 3000 **永久** 3000」，而 Qoder 官方用量页把它拆成
   * **30 × 100 credits 的每日领取、逐笔 30 天后作废**（截图实测有效期
   * `2026-11-07` … `2026-12-07`，每天一条、末尾 6 条标「即将到期」）。
   *
   * 上游确实**不给**逐笔到期（`addOnQuota` 只有 `{total,used,remaining,
   * percentage,unit,detailUrl}`，8 个真实账号 + 13 个 `Cosy-ClientType` 变体
   * + 24 条候选端点全部证实没有日期字段）⇒ 这不是解析 bug，是
   * 「**到期未知**」被展示成「**永久**」的语义错位。修法只动展示：分桶仍是
   * `permanent`（永久锁 / 选号 / 聚合轮换零变化），卡片改口径成「到期未知」。
   */
  it('★ 资源包标 expiryUnknown；套餐额度不标（9999 哨兵是真·永久）', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 500, used: 200, remaining: 300, percentage: 0.4, unit: 'credits' },
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    const addOn = balance!.packages.find((item) => item.name === '资源包')
    const plan = balance!.packages.find((item) => item.name === QODER_PLAN_PACKAGE)
    expect(addOn?.expiryUnknown).toBe(true)
    // ⚠️ 反过来：套餐额度的 `expiresAt = 9999-12-31` 是服务端**明说**不按积分
    //    到期（语义是订阅刷新日）⇒ 标成「未知」同样是假话。
    expect(plan).toBeDefined()
    expect(Object.hasOwn(plan as object, 'expiryUnknown')).toBe(false)
  })

  it('★ 反向对照：没有 addOnQuota 的账号不产出「未知」包', async () => {
    const fetcher = vi.fn(async () => usageResponse({ addOnQuota: undefined })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance!.packages.every((item) => item.expiryUnknown !== true)).toBe(true)
  })

  it('累加专用资源包（dedicatedResourcePackages）', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      dedicatedResourcePackages: [
        { id: 'p1', name: '包A', total: 50, used: 10, remaining: 40, unit: 'credits' },
      ],
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance!.total).toBe(140)
  })

  /**
   * ★ 企业账号（`userType: 'enterprise'`）的额度在 `orgResourcePackage`
   * （2026-11-09 qodercn 真实凭据实测）：该形态 `userQuota` / `addOnQuota`
   * **都不下发**，老解析一个包都拿不到 ⇒「积分查询失败（响应未包含任何额度包）」。
   *
   * ⚠️ 与 `displayMode === 'enterprise'`（上游只给网页链接、不给数字的那个分支）
   * **不是同一形态** —— 实测企业账号的 `displayMode` 仍是 `'qoder'`。
   *
   * 该层没有 `total`，`cap` 即总额；也没有任何日期字段。到期是否随订阅周期
   * 过期未验证（两方向都无证据），按 `expiryUnknown` 置位纪律**不置位**
   * ⇒ 固化：不产出 `expiryUnknown`、不产出 `deductionEndTime`（落「长期」）。
   */
  it('★ 企业账号：orgResourcePackage（cap=总额）解析为「企业资源包」', async () => {
    // 实测响应逐字段照搬（只替 userId）：displayMode 仍是 'qoder'，
    // expiresAt 是企业订阅刷新日（1796832000000），但语义归属 userQuota，
    // 该层不下发 ⇒ 不应被误挂到任何包上。
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      displayMode: 'qoder',
      qoderUsage: {
        userId: '01a1be49-d496-739d-a853-2cd75ca1dbc0',
        userType: 'enterprise',
        usageType: 'credits',
        totalUsagePercentage: 0,
        isQuotaExceeded: false,
        expiresAt: 1796832000000,
        upgradeUrl: 'https://qoder.cn/pricing?client=qoder',
        orgResourcePackage: {
          used: 0, remaining: 3000, percentage: 0, unit: 'credits',
          cap: 3000, available: true,
        },
        isPlanQuotaProrated: false,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER_CN, fetcher)
    expect(balance).not.toBeNull()
    expect(balance!.total).toBe(3000)
    expect(balance!.packages.length).toBe(1)
    const org = balance!.packages[0]!
    expect(org.name).toBe('企业资源包')
    expect(org.total).toBe(3000)
    expect(org.remaining).toBe(3000)
    // 无日期字段 ⇒ 不写 deductionEndTime（不编造日期）
    expect(Object.hasOwn(org as object, 'deductionEndTime')).toBe(false)
    // 过期策略未验证 ⇒ 按 expiryUnknown 置位纪律不置位
    expect(Object.hasOwn(org as object, 'expiryUnknown')).toBe(false)
  })

  /**
   * ★★ **`dedicatedResourcePackages` 的永久哨兵也必须被拦住**
   * （2026-10-21 合并审计发现，真实缺陷）。
   *
   * ## 缺陷
   *
   * PR !131 只对 `userQuota` 那一路的数字 `expiresAt` 做了哨兵识别，判定为永久后
   * **直接落到 `expiredTime` 字符串那一路**（`dedicatedResourcePackages[]` 走的正是
   * 它），而**那一路没有哨兵判据**。本机账号该字段实测是 `undefined` ⇒ 这条路径
   * **没有真机样本**，缺陷因此从未暴露。
   *
   * 实测后果（本用例固化）：
   * 1. `deductionEndTime` 被写成 `253402214400000` ⇒ 客户端
   *    `formatPackageExpiry` 渲染出 **「9999-12-31（2912150 天后）」**；
   * 2. 该包落 **`longTerm`** 而不是 `permanent`，而 `longTerm` 在**锁定永久积分时
   *    仍然可选** ⇒ 「锁住的永久积分」在这一路径上照样被烧，锁定形同虚设。
   *
   * ⚠️ 本用例**必须断言 `deductionEndTime` 不存在**，不能只断言 `total` ——
   *    上面那条既有用例只断言 `total`，改坏哨兵判据它照样绿（这就是它没抓到
   *    本缺陷的原因）。
   */
  it('★★ dedicatedResourcePackages 的 9999 哨兵不得写进 deductionEndTime', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      dedicatedResourcePackages: [
        {
          id: 'p1',
          name: '包A',
          total: 100,
          used: 0,
          remaining: 100,
          unit: 'credits',
          expiresAt: '9999-12-31T00:00:00.000Z',
        },
      ],
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    const pkg = balance!.packages.find((p) => p.name === '包A')
    expect(pkg, '包A 应被解析出来').toBeDefined()
    expect(
      pkg!.deductionEndTime,
      '★ 9999 哨兵不得写进 deductionEndTime（否则渲染成「9999-12-31（约 290 万天后）」）',
    ).toBeUndefined()
    // 余额照常计入（哨兵只影响「何时作废」，不影响「有多少」）。
    // ⚠️ `usageResponse` 的默认报文里 `addOnQuota` 带 100 ⇒ 合计 100 + 100。
    expect(balance!.total).toBe(200)
  })

  it('★★ 同上，纯日期形态 "9999-12-31" 与 9999 年内其它日期也要挡', async () => {
    for (const raw of ['9999-12-31', '9999-01-01', '9999-06-15T12:00:00.000Z']) {
      const fetcher = vi.fn(async () => usageResponse({
        userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
        dedicatedResourcePackages: [
          { id: 'p', name: 'P', total: 10, used: 0, remaining: 10, unit: 'credits', expiresAt: raw },
        ],
      })) as unknown as typeof fetch
      const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
      expect(
        balance!.packages.find((p) => p.name === 'P')!.deductionEndTime,
        `${raw} 必须被识别为哨兵`,
      ).toBeUndefined()
    }
  })

  /**
   * ★★ **哨兵命中时 `expiredTime` 也必须清空**（2026-10-21 对抗性审计发现，P1）。
   *
   * ## 缺陷：只挡 `deductionEndTime` 是**不完整的修复**
   *
   * 客户端 `credit-expiry.js` 的 `packageExpiryMs()` 是**两段回落**：
   * 先读 `deductionEndTime`（数字），读不到再读 `expiredTime`（字符串，
   * `Date.parse`）。⇒ 即使上一版已把 `deductionEndTime` 正确清空，
   * 只要 `expiredTime` 还留着原串，tooltip 照样渲染哨兵日期。
   *
   * 实测（本机，构造报文）：
   * ```
   * { deductionEndTime: undefined, expiredTime: '9999-12-31T00:00:00.000Z' }
   * → packageExpiryMs    = 253402214400000
   * → formatPackageExpiry = "9999-12-31（2912150 天后）"
   * ```
   * ⇒ 正是本 PR 声称「已消灭」的那句荒谬文案，**换了个字段入口又回来**。
   *   分桶不受影响（`permanent`，锁定会拦），但三档行说「永久」、hover 里说
   *   「9999-12-31 到期」，**同一个包两句话互相矛盾**。
   *
   * ⚠️ 这条用例**必须断言 `expiredTime` 为空串** —— 只断言
   *    `deductionEndTime === undefined`（上面两条）抓不到本缺陷。
   */
  it('★★ 哨兵命中时 expiredTime 也必须清空（否则前端回落到它，照样渲染 9999）', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      dedicatedResourcePackages: [
        {
          id: 'p', name: 'P', total: 100, used: 0, remaining: 100,
          unit: 'credits', expiresAt: '9999-12-31T00:00:00.000Z',
        },
      ],
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    const pkg = balance!.packages.find((p) => p.name === 'P')!
    expect(
      pkg.expiredTime,
      '★ 哨兵串不得留在 expiredTime 里 —— 前端 packageExpiryMs 会回落到它并渲染「9999-12-31（约 290 万天后）」',
    ).toBe('')
  })

  it('★ 反面对照：真实日期的 expiredTime 必须原样保留（tooltip 要显示上游原文）', async () => {
    // 若把 `expiredTime` 一律清空，上面那条会绿而真实原文丢失 —— 这是反向对照。
    const raw = '2026-11-19T00:00:00.000Z'
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      dedicatedResourcePackages: [
        { id: 'p', name: 'P', total: 100, used: 0, remaining: 100, unit: 'credits', expiresAt: raw },
      ],
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    const pkg = balance!.packages.find((p) => p.name === 'P')!
    expect(pkg.expiredTime).toBe(raw)
    expect(pkg.deductionEndTime).toBe(Date.parse(raw))
  })

  it('★ 反面对照：dedicatedResourcePackages 的**真实**到期日期仍要写进 deductionEndTime', async () => {
    // 若把哨兵判据写成「一律不写」，上面两条会全绿而真实日期丢失 ——
    // 这条是那个方向的反面对照（本仓库红线：守卫必须有反向对照）。
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
      dedicatedResourcePackages: [
        {
          id: 'p', name: '真实包', total: 100, used: 0, remaining: 100,
          unit: 'credits', expiresAt: '2026-11-19T00:00:00.000Z',
        },
      ],
    })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    const pkg = balance!.packages.find((p) => p.name === '真实包')!
    expect(pkg.deductionEndTime).toBe(Date.parse('2026-11-19T00:00:00.000Z'))
  })

  it('企业版（displayMode=enterprise）返回带原因的 null，而非 0', async () => {
    // 「查不到」与「余额为 0」必须严格区分（AGENTS.md 约定）
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      displayMode: 'enterprise',
      enterpriseUsage: { openMode: 'externalBrowser', detailUrl: 'https://qoder.com/x' },
    }), { status: 200 })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance).toBeNull()
  })

  it('401 返回带原因的 null（凭据失效）', async () => {
    const fetcher = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    const balance = await fetchQoderCreditBalance(cred, QODER, fetcher)
    expect(balance).toBeNull()
  })

  it('网络失败返回 null（不抛错，与其它 provider 同语义）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    await expect(fetchQoderCreditBalance(cred, QODER, fetcher)).resolves.toBeNull()
  })

  it('响应形状非法时返回 null（不误报 0）', async () => {
    const fetcher = vi.fn(async () => new Response('{"displayMode":"qoder"}', { status: 200 })) as unknown as typeof fetch
    await expect(fetchQoderCreditBalance(cred, QODER, fetcher)).resolves.toBeNull()
  })
})

/**
 * `fetchQoderBalanceDetailed` —— 面板用的**带原因**变体。
 *
 * ## 这些用例守的不变式
 *
 * 原实现把四种完全不同的处境压成同一句「积分查询失败（凭据失效或响应异常）」：
 *
 * | 真实原因 | 用户该做什么 |
 * |---|---|
 * | 网络出不去（SNI 阻断） | 配代理 / 换网络 |
 * | 401 | 重新登录 |
 * | 服务端 500 | 等一会儿再试 |
 * | 企业版无数字 | 去网页端看（**什么也不用修**） |
 *
 * ⇒ 判据是「**这四个原因必须产生四句不同的话**」，而不只是「有 error 字段」。
 * 只断言 `error !== undefined` 的用例对下列任意单点退化都无牙（都还会通过）。
 */
describe('fetchQoderBalanceDetailed（带原因的余额查询）', () => {
  it('成功时 balance 有值且不带 error', async () => {
    const fetcher = vi.fn(async () => usageResponse()) as unknown as typeof fetch
    const detail = await fetchQoderBalanceDetailed(cred, QODER, { fetcher })
    expect(detail.balance?.total).toBe(100)
    expect(detail.error).toBeUndefined()
  })

  it('★ 网络出不去：点名**实际主机**并给出口路（不是「凭据失效」）', async () => {
    const cause = Object.assign(new Error('getaddrinfo'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    const fetcher = vi.fn(async () => { throw new TypeError('fetch failed', { cause }) }) as unknown as typeof fetch
    const detail = await fetchQoderBalanceDetailed(cred, QODER, { fetcher })
    expect(detail.balance).toBeNull()
    // 必须点名主机 —— 用户据此判断「是不是这个域名不通」
    expect(detail.error).toContain('https://openapi.qoder.sh')
    // 必须带根因码
    expect(detail.error).toContain('UND_ERR_CONNECT_TIMEOUT')
    // ⚠️ 必须给出路；且**不得**提「凭据失效」这种会把人带偏的结论
    expect(detail.error).toContain('HTTPS_PROXY')
    expect(detail.error).not.toContain('凭据失效')
  })

  it('★ 中国版要点名中国版主机（同族两站不许串）', async () => {
    const cause = Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    const fetcher = vi.fn(async () => { throw new TypeError('fetch failed', { cause }) }) as unknown as typeof fetch
    const detail = await fetchQoderBalanceDetailed(cred, QODER_CN, { fetcher })
    expect(detail.error).toContain('https://openapi.qoder.com.cn')
    expect(detail.error).not.toContain('openapi.qoder.sh')
  })

  it('★ 非网络异常：带原始 message（不吞），且不冒充「出不去」', async () => {
    const fetcher = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    const detail = await fetchQoderBalanceDetailed(cred, QODER, { fetcher })
    expect(detail.balance).toBeNull()
    expect(detail.error).toContain('socket hang up')
    expect(detail.error).not.toContain('HTTPS_PROXY')
  })

  it('★ 401：明确指向「重新登录」，不指向代理', async () => {
    const fetcher = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    const detail = await fetchQoderBalanceDetailed(cred, QODER, { fetcher })
    expect(detail.balance).toBeNull()
    expect(detail.error).toContain('401')
    expect(detail.error).toContain('重新登录')
    expect(detail.error).not.toContain('HTTPS_PROXY')
  })

  it('★ 403 与 401 同属凭据问题，但文案保留状态码（不合并成「凭据失效」）', async () => {
    const fetcher = vi.fn(async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch
    const detail = await fetchQoderBalanceDetailed(cred, QODER, { fetcher })
    expect(detail.error).toContain('403')
    expect(detail.error).toContain('重新登录')
  })

  it('★ 5xx：带状态码、不提登录也不提代理（用户无事可做）', async () => {
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const detail = await fetchQoderBalanceDetailed(cred, QODER, { fetcher })
    expect(detail.error).toContain('500')
    expect(detail.error).not.toContain('重新登录')
    expect(detail.error).not.toContain('HTTPS_PROXY')
  })

  it('★ 企业版：说清「上游不给数字、去网页端」，不许说成故障', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      displayMode: 'enterprise',
      enterpriseUsage: { openMode: 'externalBrowser', detailUrl: 'https://qoder.com/x' },
    }), { status: 200 })) as unknown as typeof fetch
    const detail = await fetchQoderBalanceDetailed(cred, QODER, { fetcher })
    expect(detail.balance).toBeNull()
    expect(detail.error).toContain('企业版')
    expect(detail.error).not.toContain('失败')
  })

  it('★ 四种处境的文案两两不同（防「又退回同一句话」）', async () => {
    const mk = (impl: () => Promise<Response>) => vi.fn(impl) as unknown as typeof fetch
    const blocked = await fetchQoderBalanceDetailed(cred, QODER, {
      fetcher: mk(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }) }),
    })
    const unauthorized = await fetchQoderBalanceDetailed(cred, QODER, {
      fetcher: mk(async () => new Response('x', { status: 401 })),
    })
    const serverError = await fetchQoderBalanceDetailed(cred, QODER, {
      fetcher: mk(async () => new Response('x', { status: 502 })),
    })
    const enterprise = await fetchQoderBalanceDetailed(cred, QODER, {
      fetcher: mk(async () => new Response(JSON.stringify({ displayMode: 'enterprise' }), { status: 200 })),
    })
    const messages = [blocked.error, unauthorized.error, serverError.error, enterprise.error]
    expect(new Set(messages).size, `四种原因必须四句不同的话，实际：${JSON.stringify(messages)}`).toBe(4)
  })

  it('★ 非 JSON 响应：原因指向「响应不是 JSON」', async () => {
    const fetcher = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    const detail = await fetchQoderBalanceDetailed(cred, QODER, { fetcher })
    expect(detail.error).toContain('不是 JSON')
  })

  it('★ 缺 qoderUsage：原因指向缺字段（不误报 0 余额）', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ displayMode: 'qoder' }), { status: 200 })) as unknown as typeof fetch
    const detail = await fetchQoderBalanceDetailed(cred, QODER, { fetcher })
    expect(detail.error).toContain('qoderUsage')
  })

  /**
   * ★★ **凭据不可用时必须「返回失败」而不是「抛」**
   * （2026-10-21 合并审计发现，!136 引入的回归）。
   *
   * ## 为什么这条是承重件
   *
   * `src/jet-hub-rpc.ts` 的 qoder 分支用 `Promise.all` 并发查 N 个账号，其
   * **失败隔离**正是建立在「本函数本身不抛」之上（该处注释原话：
   * 「一个账号炸不影响别人（`fetchQoderBalanceDetailed` 本身不抛）」）。
   *
   * ⚠️ 原实现把 `await creditsHeaders(...)` 放在 try **之外** ⇒ 凭据形状异常
   * （例如解码出字面 `null`）时它抛 `TypeError` ⇒ `Promise.all` reject
   * ⇒ **整批** `credits.balances` 变 `ok:false` ⇒ 客户端把同一句 message
   * 盖到该 provider 的**每一个**账号卡片上，「按账号给原因」一把全丢。
   *
   * 实测（修前）：本用例红，抛出
   * `TypeError: Cannot read properties of null (reading 'security_oauth_token')`。
   * 变异：把 `creditsHeaders` 移出 try ⇒ 本条红。
   */
  it('★★ 凭据形状异常（null）⇒ 返回失败，不得抛（否则一个坏账号拖垮整批并发）', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    // `null` 是最狠的形态：`creditsHeaders` 里要读 `credential.security_oauth_token`。
    const broken = JSON.parse('null') as unknown as QoderCredential
    await expect(
      fetchQoderBalanceDetailed(broken, QODER, { fetcher }),
      '★★ 本函数的契约是「本身不抛」—— Promise.all 的失败隔离建立在它之上',
    ).resolves.toMatchObject({ balance: null })
  })

  /**
   * ★ **失败文案必须点名「哪个站点」的主机，且不得串味**
   * （2026-10-21 合并审计发现）。
   *
   * `networkBlockedHint` 的 `subject` 传的是 `product.openApiBase`，
   * 而旧 `remedy` 写死「Qoder **国际版**端点在本机被阻断」——本分支被
   * `isQoderFamily` **两站共用** ⇒ 中国版用户会读到与同一句里主机名
   * 自相矛盾的结论。变异「国际版 → 中国版」实测 86 条全绿（零守卫），
   * 故本条把两个方向都钉住。
   */
  it('★ 中国版失败文案点名中国版主机、且不出现「国际版」', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      })
    }) as unknown as typeof fetch
    const detail = await fetchQoderBalanceDetailed(cred, QODER_CN, { fetcher })
    expect(detail.balance).toBeNull()
    expect(detail.error, '必须点名中国版主机（用户据此判断该找谁）')
      .toContain('https://openapi.qoder.com.cn')
    expect(detail.error, '⚠️ 中国版失败不得说「国际版」（两站共用同一段代码）')
      .not.toContain('国际版')
    // ⚠️ 反向：国际版那条同理（避免为了过上面一条而把文案整段删掉）
    const intl = await fetchQoderBalanceDetailed(cred, QODER, { fetcher })
    expect(intl.error).toContain('https://openapi.qoder.sh')
    expect(intl.error).not.toContain('中国版')
  })

  it('薄封装与详细变体解析结果**逐字段一致**（同一份 parse，不许各解一套）', async () => {
    const fetcher = vi.fn(async () => usageResponse({
      userQuota: { total: 500, used: 200, remaining: 300, unit: 'credits' },
      dedicatedResourcePackages: [
        { id: 'p1', name: '包A', total: 50, used: 10, remaining: 40, unit: 'credits' },
      ],
    })) as unknown as typeof fetch
    const thin = await fetchQoderCreditBalance(cred, QODER, fetcher)
    const detailed = await fetchQoderBalanceDetailed(cred, QODER, { fetcher })
    expect(detailed.balance).toEqual(thin)
  })
})
