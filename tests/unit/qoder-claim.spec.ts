import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  claimQoderCampaign,
  claimQoderDailyCheckin,
  fetchQoderCheckinStatus,
  hasQoderCampaignRefreshedToday,
  parseQoderCampaigns,
  QODER_CAMPAIGN_REFRESH_HOUR_UTC8,
} from '../../src/qoder-credits.js'
import { resetQoderMachineIdentityCache } from '../../src/qoder-machine.js'
import { QODER } from '../../src/qoder-product.js'
import type { QoderCredential } from '../../src/qoder.js'

/**
 * ⚠️ 签到相关判据**依赖「今天刷新了没有」**（每日 10:00 UTC+8），
 * 所以下面所有用到 `CLAIMED` 痕迹的用例都必须**注入固定时刻** ——
 * 否则它们会在每天 UTC+8 02:00–10:00 这个窗口里时绿时红（CI 最容易踩）。
 */
const AFTER_REFRESH = Date.UTC(2026, 8, 21, 6, 0, 0)   // 2026-09-21 14:00（UTC+8）
const BEFORE_REFRESH = Date.UTC(2026, 8, 21, 0, 30, 0) // 2026-09-21 08:30（UTC+8）

/**
 * 2026-09-21 由抓包（keylog 解密）解出的真实响应。
 *
 * 领取成功（`replayed:false` + `benefit`）。
 */
const CLAIMED_OK = {
  grantId: '01a0c475-d6f8-70de-90b2-d4c8058c554d',
  status: 'CLAIMED',
  replayed: false,
  benefit: {
    kind: 'CREDITS',
    amount: 100,
    modelScope: { modelSeries: { key: 'ALL_MODELS' } },
    validity: { mode: 'RELATIVE_DAYS', days: 30 },
  },
  campaignId: '01a0bf8d-0c44-7352-96c5-3baa11cb2da2',
  campaignKey: 'act-20260921-308',
  campaignVersion: 1,
  claimedAt: '2026-09-21T14:54:12.176671Z',
  grantedAt: '2026-09-21T14:54:12.393072Z',
  expiresAt: '2026-10-21T14:54:12.176671Z',
}

/**
 * ⚠️ 同一活动**再次**领取的真实响应（抓包里 01a05bce 那次）。
 *
 * 关键：HTTP **200**、`replayed:true`、**无 `benefit`**，
 * 且 `claimedAt` 是**上一次**领取的旧时间（2026-09-18，而请求在 09-21）。
 */
const CLAIMED_REPLAY = {
  grantId: '01a0b515-5381-765b-9160-8fbf643bc17c',
  status: 'CLAIMED',
  replayed: true,
  campaignId: '01a05bce-e800-7494-a002-806e4438f483',
  campaignKey: 'act-20260901-493',
  campaignVersion: 2,
  claimedAt: '2026-09-18T15:14:28.79769Z',
  grantedAt: '2026-09-18T15:14:28.866351Z',
}

/**
 * 抓包里的活动列表（含一个可领、一个仅详情）。
 *
 * ⚠️ 这是 2026-09-21 `qoder积分.pcapng` 解密后**逐字节复刻**的真实响应
 * （领取动作发生**之前**那一刻）。判据的可靠性正来自它与下面
 * {@link CAMPAIGNS_AFTER_CLAIM} 的**前后对照**。
 */
const CAMPAIGNS_BODY = {
  uid: '01a0b514-ad7c-7dca-ae92-70181beb532e',
  showCampaign: true,
  claimable: true,
  campaignUrl: 'https://openapi.qoder.sh/growth-page/activity-iframe',
  campaigns: [
    {
      campaignId: '01a0bf8d-0c44-7352-96c5-3baa11cb2da2',
      campaignKey: 'act-20260921-308',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
    },
    {
      campaignId: '01a05bce-e800-7494-a002-806e4438f483',
      campaignKey: 'act-20260901-493',
      actionType: 'VIEW_DETAILS',
      claimStatus: 'CLAIMED',
    },
  ],
}

/**
 * **领取之后**的真实响应（同一抓包的后续帧，逐字节复刻）。
 *
 * ⚠️ 这条是判据的关键实证：领取成功后服务端**并没有**清空列表，而是把那条
 * `CLAIM_BENEFIT` 的 `claimStatus` 从 `CLAIMABLE` 改成 `CLAIMED`、
 * 顶层 `claimable` 从 `true` 改成 `false`。**列表依然非空**。
 *
 * 这就是「空列表 ⇒ 今天已领」这一旧判据错误的原因：真正「已领」的形态
 * 是「有 CLAIM_BENEFIT 且 CLAIMED」，而不是「列表为空」。
 */
const CAMPAIGNS_AFTER_CLAIM = {
  uid: '01a0b514-ad7c-7dca-ae92-70181beb532e',
  showCampaign: true,
  claimable: false,
  campaignUrl: 'https://openapi.qoder.sh/growth-page/activity-iframe',
  campaigns: [
    {
      campaignId: '01a0bf8d-0c44-7352-96c5-3baa11cb2da2',
      campaignKey: 'act-20260921-308',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMED',
      benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
    },
    {
      campaignId: '01a05bce-e800-7494-a002-806e4438f483',
      campaignKey: 'act-20260901-493',
      actionType: 'VIEW_DETAILS',
      claimStatus: 'CLAIMED',
    },
  ],
}

/**
 * 列表为空。
 *
 * ⚠️ **这个形态不代表「今天已领」**（旧实现正是这么误判的）。实测它出现的
 * 场景是**请求头不完整**（缺 `Cosy-MachineToken`/`Cosy-MachineType`）——
 * 此时服务端对 `Cosy-ClientType: '5'` 或头不全的请求回空列表。
 * 真正的「已领」形态见 {@link CAMPAIGNS_AFTER_CLAIM}。
 */
const CAMPAIGNS_EMPTY = { uid: 'u', showCampaign: false, claimable: false, campaignUrl: '', campaigns: [] }

const cred = {} as QoderCredential
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * 在「machine 身份受控」的环境下跑一段断言。
 *
 * ⚠️ **必须同时把 `QODER_RUNTIME_INFO` 指到不存在的路径**。
 *
 * machine 身份有两条来源：① 实时 spawn `runtime-info.exe`（真实身份）；
 * ② 磁盘 `machine_token.json`（退路）。若只设文件路径而不禁用 exe，
 * 每次调用都会**真的去 spawn 开发机上的可执行文件**（实测约 0.8~3.8 秒），
 * 且拿到的是**实时身份**而非下面的 fixture —— 用例于是既慢又与断言不符。
 *
 * 禁用后即可精确断言「插件确实把身份透传到了请求头里」这件事本身。
 */
async function withControlledMachineIdentity(body: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-claim-mach-'))
  const file = join(dir, 'machine_token.json')
  writeFileSync(file, JSON.stringify({ token: 'tok-abc', type: 'type-xyz' }))
  const prevFile = process.env.QODER_MACHINE_TOKEN_PATH
  const prevExe = process.env.QODER_RUNTIME_INFO
  process.env.QODER_MACHINE_TOKEN_PATH = file
  process.env.QODER_RUNTIME_INFO = join(dir, 'no-such-runtime-info')
  resetQoderMachineIdentityCache()
  try {
    await body()
  } finally {
    if (prevFile === undefined) delete process.env.QODER_MACHINE_TOKEN_PATH
    else process.env.QODER_MACHINE_TOKEN_PATH = prevFile
    if (prevExe === undefined) delete process.env.QODER_RUNTIME_INFO
    else process.env.QODER_RUNTIME_INFO = prevExe
    resetQoderMachineIdentityCache()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Qoder 活动列表解析', () => {
  it('提取 campaignId / actionType / claimStatus / amount', () => {
    const parsed = parseQoderCampaigns(CAMPAIGNS_BODY)!
    expect(parsed.claimable).toBe(true)
    expect(parsed.campaigns).toHaveLength(2)
    expect(parsed.campaigns[0]).toMatchObject({
      campaignId: '01a0bf8d-0c44-7352-96c5-3baa11cb2da2',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      amount: 100,
    })
  })

  /**
   * ⚠️ **真实缺陷回归（2026-09-25，用户报障）**：插件必须用**桌面 app 身份**
   * （`Cosy-ClientType: 10`）请求活动端点。
   *
   * 服务端按该头进入活动下发分支 —— 用 CLI 身份（`'5'`）时响应恒为
   * `{"showCampaign":false,"claimable":false,"campaignUrl":"","campaigns":[]}`，
   * 插件随后筛出 0 个可领活动并**误报「今日已领取」**。
   *
   * ⚠️ **`'10'` 是必要但不充分条件**：它只让服务端回 1 条 `VIEW_DETAILS`；
   * 要拿到 `CLAIM_BENEFIT/CLAIMABLE` 还必须带 `Cosy-MachineToken` +
   * `Cosy-MachineType`（见下方 machine 头用例与 `src/qoder-machine.ts`）。
   *
   * 本用例锁死该取值，防止回退到 `clientMetadata.client_type`（CLI 身份）。
   */
  it('活动端点必须带桌面 app 身份（Cosy-ClientType=10）—— 回归锁', async () => {
    const fetcher = vi.fn(async () => json(CAMPAIGNS_BODY))
    await fetchQoderCheckinStatus(cred, QODER, fetcher as never)
    const init = fetcher.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers['Cosy-ClientType']).toBe('10')
    // 明确不等于推理用的 CLI 身份，避免将来两处被"顺手"合并。
    expect(init.headers['Cosy-ClientType']).not.toBe(QODER.clientMetadata.client_type)
  })

  it('领取端点同样带 app 身份（Cosy-ClientType=10）—— 回归锁', async () => {
    const fetcher = vi.fn(async () => json(CLAIMED_OK))
    await claimQoderCampaign(cred, QODER, 'c1', fetcher as never)
    const init = fetcher.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers['Cosy-ClientType']).toBe('10')
  })

  /**
   * ⚠️ **本次缺陷的真正根因（2026-09-25，抓包 + 消融实证）**：
   * 活动请求必须带上**成对的** `Cosy-MachineToken` + `Cosy-MachineType`。
   *
   * 只用 `Cosy-ClientType: 10` 时，服务端只回 1 条 `VIEW_DETAILS` 且
   * `claimable:false` —— 插件据此误判「今天已领」，而 IDE 里可领。
   * 补上这两个头后才回 `CLAIM_BENEFIT/CLAIMABLE/amount:100`。
   *
   * 证据：`qoder积分.pcapng`（`SSLKEYLOGFILE` 解密）显示 native 带完整
   * machine 头族；逐项消融确认这两个头**缺一即失效**。
   */
  it('活动端点必须带成对的 machine 头（Token + Type）—— 回归锁', async () => {
    await withControlledMachineIdentity(async () => {
      const fetcher = vi.fn(async () => json(CAMPAIGNS_BODY))
      await fetchQoderCheckinStatus(cred, QODER, fetcher as never)
      const init = fetcher.mock.calls[0]![1] as { headers: Record<string, string> }
      expect(init.headers['Cosy-MachineToken']).toBe('tok-abc')
      expect(init.headers['Cosy-MachineType']).toBe('type-xyz')
    })
  })

  /** 领取端点同样要带（claim 也走 `/sash/`）。 */
  it('领取端点必须带成对的 machine 头 —— 回归锁', async () => {
    await withControlledMachineIdentity(async () => {
      const fetcher = vi.fn(async () => json(CLAIMED_OK))
      await claimQoderCampaign(cred, QODER, 'c1', fetcher as never)
      const init = fetcher.mock.calls[0]![1] as { headers: Record<string, string> }
      expect(init.headers['Cosy-MachineToken']).toBe('tok-abc')
      expect(init.headers['Cosy-MachineType']).toBe('type-xyz')
    })
  })

  it('形状非法返回 undefined（与「无活动」区分）', () => {
    expect(parseQoderCampaigns(null)).toBeUndefined()
    expect(parseQoderCampaigns([])).toBeUndefined()
    expect(parseQoderCampaigns('nope')).toBeUndefined()
    // 缺 campaignId 的条目被跳过，但整体仍有效
    expect(parseQoderCampaigns({ campaigns: [{ campaignKey: 'x' }] })?.campaigns).toEqual([])
  })

  it('列表为空时 campaigns 为 []（不是 undefined）', () => {
    const parsed = parseQoderCampaigns(CAMPAIGNS_EMPTY)!
    expect(parsed.campaigns).toEqual([])
    expect(parsed.claimable).toBe(false)
  })
})

describe('Qoder 签到状态', () => {
  it('有可领活动 → todayCheckedIn=false，dailyCredit 取 benefit.amount', async () => {
    const status = await fetchQoderCheckinStatus(cred, QODER, vi.fn(async () => json(CAMPAIGNS_BODY)) as never)
    expect(status).toMatchObject({ active: true, todayCheckedIn: false, dailyCredit: 100 })
  })

  /**
   * ⚠️ **真实缺陷回归（2026-09-25，用户报障「没领过就显示已领取」）**。
   *
   * 旧判据是 `todayCheckedIn = (可领活动数 === 0)`，于是**列表为空**（请求头
   * 不完整导致的空态）也被判成「今天已领」—— 而 IDE 里明明可领。
   *
   * 抓包实证指出真正的「已领」形态（见 {@link CAMPAIGNS_AFTER_CLAIM}）：
   * 列表**非空**、那条 `CLAIM_BENEFIT` 变 `CLAIMED`、顶层 `claimable:false`。
   * 故「列表为空」应判**未领**。
   */
  it('列表为空 → active 仍为 true（不误判为「活动未开启」）且 todayCheckedIn=false', async () => {
    const status = await fetchQoderCheckinStatus(cred, QODER, vi.fn(async () => json(CAMPAIGNS_EMPTY)) as never)
    // active 恒 true：若判 false，调用方会先命中「活动未开启」分支。
    expect(status).toMatchObject({ active: true, todayCheckedIn: false })
  })

  /**
   * ⚠️ **核心判据（抓包前后对照）**：领取成功后列表**不清空**，
   * 而是那条 `CLAIM_BENEFIT` 的 `claimStatus` 变为 `CLAIMED`。
   * 这才是「今天已领」。
   */
  it('领取后的真实形态（CLAIM_BENEFIT 变 CLAIMED）→ todayCheckedIn=true', async () => {
    const status = await fetchQoderCheckinStatus(
      cred, QODER, vi.fn(async () => json(CAMPAIGNS_AFTER_CLAIM)) as never, AFTER_REFRESH,
    )
    expect(status).toMatchObject({ active: true, todayCheckedIn: true })
  })

  it('仅 VIEW_DETAILS 活动（无领分类）→ todayCheckedIn=false（它不是领取类）', async () => {
    const onlyViewDetails = {
      uid: 'u', showCampaign: true, claimable: false,
      campaigns: [{ campaignId: 'c1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' }],
    }
    const status = await fetchQoderCheckinStatus(cred, QODER, vi.fn(async () => json(onlyViewDetails)) as never)
    expect(status).toMatchObject({ todayCheckedIn: false })
  })

  it('网络失败 / 非 2xx → null（与「无活动」严格区分）', async () => {
    expect(await fetchQoderCheckinStatus(cred, QODER, vi.fn(async () => { throw new Error('x') }) as never)).toBeNull()
    expect(await fetchQoderCheckinStatus(cred, QODER, vi.fn(async () => json({}, 500)) as never)).toBeNull()
    expect(await fetchQoderCheckinStatus(cred, QODER, vi.fn(async () => new Response('<html>', { status: 200 })) as never)).toBeNull()
  })
})

describe('Qoder 领取单个活动', () => {
  it('成功：从 benefit.amount 读积分', async () => {
    const outcome = await claimQoderCampaign(cred, QODER, 'c1', vi.fn(async () => json(CLAIMED_OK)) as never)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100 })
  })

  /**
   * ⚠️ 核心幂等判据：重复领取**同样是 200**，必须靠 `replayed:true` 识别。
   * 只看 HTTP 状态会把「今天已领」误报成「领取成功 +100」——
   * 用户报障过同类问题（TRAE 显示成功但 +0 积分）。
   */
  it('replayed:true → already-claimed（**不是** claimed）', async () => {
    const outcome = await claimQoderCampaign(cred, QODER, 'c1', vi.fn(async () => json(CLAIMED_REPLAY)) as never)
    expect(outcome.kind).toBe('already-claimed')
    expect(outcome).toMatchObject({ message: '今天已领取' })
  })

  it('status 非 CLAIMED 且未 replayed → failed', async () => {
    const body = { status: 'NOT_ELIGIBLE', campaignId: 'c1' }
    const outcome = await claimQoderCampaign(cred, QODER, 'c1', vi.fn(async () => json(body)) as never)
    expect(outcome).toMatchObject({ kind: 'failed' })
  })

  it('401 给出「重新登录」的可读原因（而不是空洞的 HTTP 401）', async () => {
    const outcome = await claimQoderCampaign(cred, QODER, 'c1',
      vi.fn(async () => new Response('<html>', { status: 401 })) as never)
    expect(outcome).toMatchObject({ kind: 'failed' })
    if (outcome.kind === 'failed') expect(outcome.message).toContain('重新登录')
  })

  it('请求体是空串（抓包实测 content-length: 0）', async () => {
    const fetcher = vi.fn(async () => json(CLAIMED_OK))
    await claimQoderCampaign(cred, QODER, 'c1', fetcher as never)
    const init = fetcher.mock.calls[0]![1] as RequestInit
    expect(init.body).toBe('')
    expect(init.method).toBe('POST')
  })

  it('campaignId 被 URL 编码（防注入路径分隔符）', async () => {
    const fetcher = vi.fn(async () => json(CLAIMED_OK))
    await claimQoderCampaign(cred, QODER, 'a/b', fetcher as never)
    const url = String(fetcher.mock.calls[0]![0])
    expect(url).toContain('/campaigns/a%2Fb/claim')
  })
})

describe('Qoder 领取全部可领活动', () => {
  /**
   * ⚠️ **真实缺陷回归（用户报障「没领过就显示已经领取」）**：旧实现在
   * 「无可领活动」时直接返回 `already-claimed`，于是只要服务端没下发可领项
   * （含**请求头不完整**、未到刷新时间、本就无活动），界面就显示「今天已领取」。
   *
   * 「没东西可领」（inactive）与「领过了」（already-claimed）必须分开。
   */
  it('列表为空（未下发可领项）→ inactive（**不是** already-claimed）', async () => {
    const outcome = await claimQoderDailyCheckin(cred, QODER, vi.fn(async () => json(CAMPAIGNS_EMPTY)) as never)
    expect(outcome.kind).toBe('inactive')
    expect(outcome).toMatchObject({ message: expect.stringContaining('没有可领取') })
  })

  /** 抓包实证的「真已领」形态 → already-claimed。 */
  it('领取后的真实形态 → already-claimed（真的领过了）', async () => {
    const outcome = await claimQoderDailyCheckin(
      cred, QODER, vi.fn(async () => json(CAMPAIGNS_AFTER_CLAIM)) as never, AFTER_REFRESH,
    )
    expect(outcome.kind).toBe('already-claimed')
  })

  it('只领 CLAIM_BENEFIT 且 CLAIMABLE 的，跳过 VIEW_DETAILS', async () => {
    const fetcher = vi.fn(async (url: string) =>
      String(url).includes('/claim') ? json(CLAIMED_OK) : json(CAMPAIGNS_BODY))
    const outcome = await claimQoderDailyCheckin(cred, QODER, fetcher as never)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100 })
    const claimCalls = fetcher.mock.calls.filter((c) => String(c[0]).includes('/claim'))
    // 只对 01a0bf8d 发起领取，VIEW_DETAILS 的 01a05bce 不碰
    expect(claimCalls).toHaveLength(1)
    expect(String(claimCalls[0]![0])).toContain('01a0bf8d')
  })

  it('多个可领活动逐个领取并累加积分', async () => {
    const two = {
      ...CAMPAIGNS_BODY,
      campaigns: [
        { campaignId: 'a', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } },
        { campaignId: 'b', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 50 } },
      ],
    }
    const fetcher = vi.fn(async (url: string) =>
      String(url).includes('/claim') ? json({ status: 'CLAIMED', replayed: false, benefit: { amount: String(url).includes('/a/') ? 100 : 50 } }) : json(two))
    const outcome = await claimQoderDailyCheckin(cred, QODER, fetcher as never)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 150 })
    expect(fetcher.mock.calls.filter((c) => String(c[0]).includes('/claim'))).toHaveLength(2)
  })

  it('查询列表失败 → failed（不误报已领）', async () => {
    const outcome = await claimQoderDailyCheckin(cred, QODER, vi.fn(async () => { throw new Error('x') }) as never)
    expect(outcome).toMatchObject({ kind: 'failed' })
  })
})

/**
 * ⚠️⚠️ **真实缺陷回归（2026-10-02 审查 PR !33 定位）**：每日活动** 10:00（UTC+8）
 * 才刷新**，故**刷新之前**看到的那条 `CLAIMED` 属于**昨天**。
 *
 * 修复前：9 点跑一轮自动签到 → 返回 `already-claimed` → 上层记成「今天已跑」
 * → 当天 10 点刷新出来的新额度**整天不会再被领**，面板还显示「1 个今天已领」。
 * 每天净损失 100 Credits 且**完全静默**。
 *
 * 修法：产出方自己声明「这条痕迹不算今天」（`ClaimOutcome.coversToday`），
 * 记账方只数 `summary.coversToday`。本组用例锁住产出侧。
 */
describe('Qoder 每日刷新时刻边界（10:00 UTC+8）', () => {
  it('纯函数：刷新时刻本身算「已刷新」，早一分钟不算', () => {
    // 10:00（UTC+8）= 02:00Z —— 整点起算「已刷新」
    expect(hasQoderCampaignRefreshedToday(Date.UTC(2026, 8, 21, 2, 0, 0))).toBe(true)
    // 09:59（UTC+8）= 01:59Z —— 差一分钟
    expect(hasQoderCampaignRefreshedToday(Date.UTC(2026, 8, 21, 1, 59, 0))).toBe(false)
    expect(hasQoderCampaignRefreshedToday(Date.UTC(2026, 8, 21, 2, 0, 1))).toBe(true)
  })

  it('按 UTC+8 判定而不是本机时区（东八区以外同样正确）', () => {
    // 10:00（UTC+8）= 02:00Z ⇒ 这一刻起算「已刷新」
    expect(hasQoderCampaignRefreshedToday(Date.parse('2026-09-21T02:00:00Z'))).toBe(true)
    // 09:59（UTC+8）= 01:59Z ⇒ 还没到
    expect(hasQoderCampaignRefreshedToday(Date.parse('2026-09-21T01:59:00Z'))).toBe(false)
    // ⚠️ 傍晚的 UTC 时刻落在 UTC+8 的**次日凌晨**，仍按 UTC+8 判（不是 UTC）
    expect(hasQoderCampaignRefreshedToday(Date.parse('2026-09-21T18:30:00Z'))).toBe(false)
  })

  it('刷新前看到「昨天那条已领」→ inactive 且**不**说「今天已领」', async () => {
    const outcome = await claimQoderDailyCheckin(
      cred, QODER, vi.fn(async () => json(CAMPAIGNS_AFTER_CLAIM)) as never, BEFORE_REFRESH,
    )
    expect(outcome.kind).toBe('inactive')
    expect(String((outcome as { message: string }).message)).toContain('10:00')
    // inactive 本身不参与记账（coversToday 只对 claimed / already-claimed 有意义），
    // 所以这里不该出现「今天已领」的字样。
    expect(String((outcome as { message: string }).message)).not.toContain('已领取')
  })

  it('刷新后同一份响应才判 already-claimed（前后对照，证明判据是时刻而非报文）', async () => {
    const outcome = await claimQoderDailyCheckin(
      cred, QODER, vi.fn(async () => json(CAMPAIGNS_AFTER_CLAIM)) as never, AFTER_REFRESH,
    )
    expect(outcome.kind).toBe('already-claimed')
  })

  it('刷新前领到的是昨天那条补领：算「领取成功」但 coversToday:false', async () => {
    const fetcher = vi.fn(async (url: string) =>
      String(url).includes('/claim') ? json(CLAIMED_OK) : json(CAMPAIGNS_BODY))
    const outcome = await claimQoderDailyCheckin(cred, QODER, fetcher as never, BEFORE_REFRESH)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100, coversToday: false })
  })

  it('刷新后同样的领取不带 coversToday:false（缺省即「算今天」）', async () => {
    const fetcher = vi.fn(async (url: string) =>
      String(url).includes('/claim') ? json(CLAIMED_OK) : json(CAMPAIGNS_BODY))
    const outcome = await claimQoderDailyCheckin(cred, QODER, fetcher as never, AFTER_REFRESH)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100 })
    expect(outcome).not.toHaveProperty('coversToday')
  })

  it('状态查询同源：刷新前不谎报「今天已领」', async () => {
    const fetcher = vi.fn(async () => json(CAMPAIGNS_AFTER_CLAIM))
    const before = await fetchQoderCheckinStatus(cred, QODER, fetcher as never, BEFORE_REFRESH)
    const after = await fetchQoderCheckinStatus(cred, QODER, fetcher as never, AFTER_REFRESH)
    expect(before).toMatchObject({ active: true, todayCheckedIn: false })
    expect(after).toMatchObject({ todayCheckedIn: true })
  })
})

/**
 * issue #17：Qoder 的**物理单设备每日限领锁**。
 *
 * 同一台机器上第一个账号领完后，其余账号回
 * `status:BLOCKED, failureCode:SAME_PERSON_ALREADY_CLAIMED`。这不是凭据失效，
 * 重登也无法绕过；必须如实告诉用户「设备锁」，而不是报一句笼统的领取失败。
 */
describe('Qoder 设备锁（issue #17）', () => {
  it('★★ SAME_PERSON_ALREADY_CLAIMED ⇒ already-claimed + 设备锁文案', async () => {
    const body = {
      status: 'BLOCKED',
      failureCode: 'SAME_PERSON_ALREADY_CLAIMED',
      campaignId: 'c1',
    }
    const outcome = await claimQoderCampaign(cred, QODER, 'c1', vi.fn(async () => json(body)) as never)
    expect(outcome.kind).toBe('already-claimed')
    expect(outcome).toMatchObject({ message: expect.stringContaining('设备') })
  })

  it('其它 BLOCKED 失败码仍归 failed，并把 failureCode 带进文案', async () => {
    const body = { status: 'BLOCKED', failureCode: 'CAMPAIGN_NOT_ACTIVE', campaignId: 'c1' }
    const outcome = await claimQoderCampaign(cred, QODER, 'c1', vi.fn(async () => json(body)) as never)
    expect(outcome.kind).toBe('failed')
    expect(outcome).toMatchObject({ message: expect.stringContaining('CAMPAIGN_NOT_ACTIVE') })
  })
})

/**
 * 汇总层必须把「设备锁」原因透传给用户（2026-11-03 审计 P1）。
 *
 * `claimQoderDailyCheckin` 只收集 failed 的 message，旧实现会把
 * already-claimed 一律换成通用「今天已领取」⇒ 一键领取里用户以为
 * **本账号**领过了，实际是设备被其它账号占用。
 */
describe('Qoder 设备锁：汇总层文案（issue #17）', () => {
  it('★★ 可领活动 + claim 回设备锁 ⇒ 汇总仍是「设备」而不是通用「今天已领取」', async () => {
    const blocked = {
      status: 'BLOCKED',
      failureCode: 'SAME_PERSON_ALREADY_CLAIMED',
      campaignId: 'daily',
    }
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/claim') ? json(blocked) : json(CAMPAIGNS_BODY))
    const outcome = await claimQoderDailyCheckin(cred, QODER, fetcher as never)
    expect(outcome.kind).toBe('already-claimed')
    expect(outcome).toMatchObject({ message: expect.stringContaining('设备') })
  })

  it('嵌套 data 包裹也能识别（不得落成 claimed + 0）', async () => {
    const body = { data: { status: 'BLOCKED', failureCode: 'SAME_PERSON_ALREADY_CLAIMED' } }
    const outcome = await claimQoderCampaign(cred, QODER, 'c1', vi.fn(async () => json(body)) as never)
    expect(outcome.kind).toBe('already-claimed')
  })

  it('failureCode 大小写/尾空格归一后仍命中', async () => {
    const body = { status: 'BLOCKED', failureCode: ' same_person_already_claimed ' }
    const outcome = await claimQoderCampaign(cred, QODER, 'c1', vi.fn(async () => json(body)) as never)
    expect(outcome.kind).toBe('already-claimed')
  })
})
