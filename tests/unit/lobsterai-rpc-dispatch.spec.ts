/**
 * `account.refresh` RPC 分派的回归测试。
 *
 * 覆盖两个**既有缺陷**（T7 修复）：
 *
 * 1. **workbuddy 分支缺失**：原实现只判 `codearts` / `buddy`，workbuddy 落入
 *    else 抛 `Unknown provider` —— 即 `account.refresh` 端点对 WorkBuddy 完全不可用。
 * 2. **刷错凭据**：原实现调 `service.refresh()`，而该方法读写的是该 provider 的
 *    **默认单凭据 ref**（如 `BUDDY_ACCESS_TOKEN`），要刷的却是池内条目的
 *    `BUDDY_ACCOUNT_XXX` —— 于是「刷这个账号」实际刷的是另一个凭据。
 *
 * ⚠ **本端点没有面板入口**（issue IKJOZA 取证）：账号卡片上并没有「刷新」按钮，
 * 调用方是仓库外的脚本/手工 RPC。这段说明原先写的是「账号卡片的『刷新』按钮」，
 * 那是失实的 —— 本文件末尾的「issue IKJOZA」段有完整取证。
 *
 * 这两个缺陷都无法靠 `collect*` 那类纯函数测试发现（它们不在那条代码路径上），
 * 因此这里直接驱动 `registerJetHubRpc` 注册的 HTTP 处理器，断言真实分派行为。
 */

import { describe, expect, it } from 'vitest'
import {
  EXPECTED_REFRESH_PROVIDER_IDS,
  REFRESH_PROVIDERS,
  accountEntry,
  refreshHarness,
} from '../helpers/rpc-refresh.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * 调用 `account.refresh` 并返回「被刷的 provider / ref」以及 RPC 结果载荷。
 *
 * ⚠️ **2026-10-08 改（Task 2）**：本文件原先自带一套 `makeCtx` / `makePool` /
 * `makeServiceStub` 夹具，把 13 个桩逐个摆进 `registerJetHubRpc` 的**命名对象**。
 * Task 2 把这套夹具抽到 `tests/helpers/rpc-refresh.ts`（参数化、零全局状态），
 * 使本文件与 `refresh-bootstrap-wiring.spec.ts` 共用同一份「13 个 provider 齐全」
 * 的桩 —— **断言一条未改**，改的只是「怎么供给 auth 实例」。
 *
 * ⚠️ 保留 `RefreshCall` 的 `service` / `credentialRef` 字段名（而不是换成夹具的
 * `provider` / `ref`）：本文件的 32 条断言是**最强**的既有防线，逐字保留它们
 * 才能证明「重构没有改变可观察行为」。
 */
async function callRefresh(
  accounts: ProviderAccountEntry[],
  accountId: string,
): Promise<{
  calls: { service: string; credentialRef: string }[]
  result: { ok: boolean; value?: { success: boolean }; error?: { code?: string; message?: string } }
}> {
  const harness = refreshHarness(accounts)
  const result = await harness.call(accountId)
  return {
    calls: harness.calls.map((c) => ({ service: c.provider, credentialRef: c.ref })),
    result,
  }
}

/** 取成功路径的 `value`（供既有用例断言 `success === true`）。 */
function okValue(result: { ok: boolean; value?: { success: boolean } }): { success: boolean } {
  expect(result.ok, `期望成功，实际 error=${JSON.stringify((result as { error?: unknown }).error)}`).toBe(true)
  return result.value!
}

function entry(provider: string, credentialRef: string): ProviderAccountEntry {
  return accountEntry(provider, credentialRef)
}

describe('account.refresh 分派（T7 回归）', () => {
  /**
   * ★★ **`REFRESH_PROVIDERS` 与 `PROVIDER_REGISTRY` 同源**（Task 2 复审 Finding I-1）。
   *
   * ## 为什么这条不可省（静默漏算 = failure-class #1）
   *
   * `REFRESH_PROVIDERS`（`tests/helpers/rpc-refresh.ts`）是一份**手写**的 13 id 清单，
   * 它驱动本文件与 `refresh-bootstrap-wiring.spec.ts` 的**全部**行为循环。
   * 而本仓库另外两份 13-id 清单（`AUTH_SERVICE` / `AUTH_SERVICE_OF`）都各自有
   * registry 派生的守卫，**只有它没有** —— 实测（复审者 grep 全仓）此前**零断言**
   * 交叉核对它。
   *
   * ## 具体爆炸半径（实测确认）
   *
   * `loomy-rpc-dispatch.spec.ts` / `raccoon-rpc-dispatch.spec.ts` 里
   * `account.refresh` 的断言在 Task 2 之后已退化为**纯结构**（扫源码文本找
   * `authOf(auths, entry.provider)`、并断言 `case LOOMY.id:` 不存在）。
   * ⇒ **loomy / raccoon 的 `account.refresh` 行为覆盖唯一来源就是本清单驱动的循环**。
   * 有人加 provider 时忘了这份清单、或从中删掉 loomy，那家的行为覆盖
   * **静默降到零而全部用例照样绿**。
   *
   * ## 方向性（与 `jet-hub-rpc-auth-wiring.spec.ts` 同款）
   *
   * **registry 是权威、`REFRESH_PROVIDERS` 是被测对象** ——
   * `toEqual` 的差异会**点名**那个 id。若改成「清单自己派生自己」则恒真。
   *
   * ## ⚠️ 已做反向验证（两种方向各一次）
   *
   * ① 从 `REFRESH_PROVIDERS` 删掉 `loomy` ⇒ 本条**红**，差异点名 `"loomy"`，
   *    而**其余 32 条照样绿** —— 这正证明它是该漏算的**唯一**探测器；
   * ② 加一个 registry 里没有的 `kuku` ⇒ 本条**红**，差异点名 `"kuku"`。
   */
  it('★ REFRESH_PROVIDERS 与 registry 逐项相等（漏一个即红并点名）', () => {
    expect(
      [...REFRESH_PROVIDERS].sort(),
      'REFRESH_PROVIDERS 必须等于「registry 的 channel 减去 opencode 豁免」；' +
      '左侧多出的 id = 清单里多了 registry 没有的僵尸项（该 provider 会零行为覆盖），' +
      '右侧多出的 id = registry 里有而清单漏登记（它的 account.refresh 行为覆盖为零）',
    ).toEqual([...EXPECTED_REFRESH_PROVIDER_IDS].sort())
    // ⚠️ 兜住「channel 集合变了」这个前提：豁免理由若因新 provider 而失效，
    //    上面那条会以「莫名其妙的差异」失败，这条先把原因指出来。
    //    （豁免的**理由**由 `jet-hub-rpc-auth-wiring.spec.ts` 逐条验证，本文件不重复。）
    // ⚠️ 2026-10-13 合并：officeace 与 accio **同一次**并入，故 13 → 15。
    // ⚠️ 2026-10-15 加 minimaxintl（MiniMax Code 国际版）：15 → 16。
    // ⚠️ 2026-10-16 astudio 并入（goal 302 接线）：16 → 17。
    // ⚠️ 2026-10-17 加 autoclaw（AutoClaw/智谱）：17 → 18；
    //    同日 **本 fork** 并入 modelscope（魔搭）：18 → 19。
    // ⚠️ 2026-10-20 加 autoclawintl（AutoClaw 国际版）：19 → 20。
    expect(
      EXPECTED_REFRESH_PROVIDER_IDS,
      'channel 集合变了，请复核 opencode 豁免是否仍成立（见 AUTH_EXEMPT）',
    // ⚠️ 2026-10-22（A6）：codely 翻 `channel: true`：20 → 21。
    // 2026-10-29 fork: qiniu + magicrew added -> 22 -> 23.
    // 2026-11-01 fork: magicrewintl (channel:true) added -> 23 -> 24.
    // 2026-11-02 fork: monkeycode (channel:true) added -> 24 -> 25.
    // 2026-11-02 fork: monkeycodeintl + baizhi (channel:true) -> 25 -> 27.
    ).toHaveLength(27)
  })

  it('buddy 账号刷新**自己的** credentialRef，而不是默认单凭据 ref', async () => {
    // 缺陷 2 的回归：原实现调 buddy.refresh()（读 BUDDY_ACCESS_TOKEN），
    // 刷的是另一个凭据。
    const harness = refreshHarness([entry('buddy', 'BUDDY_ACCOUNT_AAAA1111')])
    const result = await harness.call('buddy-1')
    const calls = harness.calls.map((c) => ({ service: c.provider, credentialRef: c.ref }))
    expect(okValue(result).success).toBe(true)
    expect(calls).toEqual([{ service: 'buddy', credentialRef: 'BUDDY_ACCOUNT_AAAA1111' }])
    // ⚠️ 2026-10-08 改（Task 2 复审 Finding 3）：这里原先是
    //    `expect(calls.some((c) => c.service.includes('refresh(default)'))).toBe(false)`
    //    —— 在**旧**夹具下有意义（旧桩同时有 `refresh()`，它会记一条
    //    `<name>.refresh(default)`），但新夹具（`tests/helpers/rpc-refresh.ts`）
    //    的桩**只有** `refreshAccountCredential` ⇒ 那条断言**恒真**、
    //    证明力为零（「保险失效比变红更糟」）。
    //    ⇒ 换成对**桩形状**的反向断言：桩确实**没有** `refresh` 方法，
    //    故「退化成刷默认单凭据」这条历史缺陷路径在本夹具下**不可能被走到**
    //    （这正是上面 `toEqual` 那条能独立守住的理由）。
    //    ⚠️ 若将来有人给桩补上 `refresh`，本行会红 —— 那正是要的信号：
    //    届时必须把上面那条「恒真」断言换成真正的行为断言。
    expect(
      typeof (harness.auths['buddy'] as { refresh?: unknown }).refresh,
      '夹具的桩新增了 refresh()：上面那条「不得刷默认凭据」的行为断言必须重写',
    ).toBe('undefined')
  })

  it('workbuddy 账号可刷新且不再抛 Unknown provider（缺陷 1 的回归）', async () => {
    // 原实现只判 codearts / buddy，workbuddy 落到 else 抛
    // `Unknown provider: workbuddy`。
    const { calls, result } = await callRefresh(
      [entry('workbuddy', 'WORKBUDDY_ACCOUNT_BBBB2222')], 'workbuddy-1',
    )
    expect(okValue(result).success).toBe(true)
    // 成功路径不得带 `error`（issue IKJOZA 后失败走 `ok:false`，成功必须干净）。
    expect((result as { error?: unknown }).error).toBeUndefined()
    expect(calls).toEqual([{ service: 'workbuddy', credentialRef: 'WORKBUDDY_ACCOUNT_BBBB2222' }])
  })

  it('lobsterai 账号刷新自己的 credentialRef（新增 provider 不得重蹈覆辙）', async () => {
    const { calls, result } = await callRefresh(
      [entry('lobsterai', 'LOBSTERAI_ACCOUNT_CCCC3333')], 'lobsterai-1',
    )
    expect(okValue(result).success).toBe(true)
    expect(calls).toEqual([{ service: 'lobsterai', credentialRef: 'LOBSTERAI_ACCOUNT_CCCC3333' }])
  })

  it('trae 账号刷新自己的 credentialRef（新增 provider 不得重蹈覆辙）', async () => {
    const { calls, result } = await callRefresh(
      [entry('trae', 'TRAE_ACCOUNT_EEEE5555')], 'trae-1',
    )
    expect(okValue(result).success).toBe(true)
    expect(calls).toEqual([{ service: 'trae', credentialRef: 'TRAE_ACCOUNT_EEEE5555' }])
  })

  it('qoder 账号刷新自己的 credentialRef（新增 provider 不得重蹈覆辙）', async () => {
    const { calls, result } = await callRefresh(
      [entry('qoder', 'QODER_ACCOUNT_FFFF6666')], 'qoder-1',
    )
    expect(okValue(result).success).toBe(true)
    expect(calls).toEqual([{ service: 'qoder', credentialRef: 'QODER_ACCOUNT_FFFF6666' }])
  })

  it('qodercn 账号刷新分派到**中国版实例**，不串到国际版（同族注册表的核心风险）', async () => {
    // ⚠️ 2026-10-08 改（Task 2）：分派走 `authOf(auths, entry.provider)` 查表，
    // `auths` 的键就是 provider id —— `qodercn` 这个键查到的是中国版实例
    //（`src/index.ts` 的 `qodercn: qoderCn`）。
    // 原先这里是「国际版与中国版共用一个 switch case（`case QODER.id:
    // case QODER_CN.id:`），靠 `requireQoderFamily(entry.provider)` 查注册表取实例」
    // —— 那个 switch 已被 Task 2 整体删除，该结构**不再存在**。
    // 若哪天有人把 `auths` 的 `qodercn` 键接到国际版实例上，
    // 症状是「中国版账号点刷新，实际续期了国际版的凭据」—— 两站 token
    // 不通用，于是 CN 续期永远失败而国际版被无谓地刷了一次。
    // 这条用例用**行为**（哪个 stub 被调用）而非字符串锁住这件事。
    const { calls, result } = await callRefresh(
      [entry('qodercn', 'QODERCN_ACCOUNT_GGGG7777')], 'qodercn-1',
    )
    expect(okValue(result).success).toBe(true)
    expect((result as { error?: unknown }).error).toBeUndefined()
    expect(calls).toEqual([{ service: 'qodercn', credentialRef: 'QODERCN_ACCOUNT_GGGG7777' }])
    // 关键：国际版实例必须**没有**被碰过。
    expect(calls.some((c) => c.service === 'qoder'), '中国版账号串到了国际版实例').toBe(false)
  })

  it('两站账号同时在池时各刷各的（互不串用）', async () => {
    const accounts = [
      entry('qoder', 'QODER_ACCOUNT_H1'),
      entry('qodercn', 'QODERCN_ACCOUNT_H2'),
    ]
    const intl = await callRefresh(accounts, 'qoder-1')
    expect(intl.calls).toEqual([{ service: 'qoder', credentialRef: 'QODER_ACCOUNT_H1' }])
    const cn = await callRefresh(accounts, 'qodercn-1')
    expect(cn.calls).toEqual([{ service: 'qodercn', credentialRef: 'QODERCN_ACCOUNT_H2' }])
  })

  it('codearts 账号刷新自己的 credentialRef', async () => {
    const { calls, result } = await callRefresh(
      [entry('codearts', 'CODEARTS_ACCOUNT_DDDD4444')], 'codearts-1',
    )
    expect(okValue(result).success).toBe(true)
    expect(calls).toEqual([{ service: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_DDDD4444' }])
  })

  it('七个 provider 各自分派到对应服务（互不串用）', async () => {
    const accounts = [
      entry('codearts', 'CODEARTS_ACCOUNT_1'),
      entry('buddy', 'BUDDY_ACCOUNT_1'),
      entry('workbuddy', 'WORKBUDDY_ACCOUNT_1'),
      entry('lobsterai', 'LOBSTERAI_ACCOUNT_1'),
      entry('qoder', 'QODER_ACCOUNT_1'),
      entry('qodercn', 'QODERCN_ACCOUNT_1'),
      entry('trae', 'TRAE_ACCOUNT_1'),
    ]
    for (const target of accounts) {
      const { calls, result } = await callRefresh(accounts, target.id)
      expect(okValue(result).success, target.provider).toBe(true)
      expect(calls, target.provider).toEqual([
        { service: target.provider, credentialRef: target.credentialRef },
      ])
    }
  })

  it('未知 provider 报错（不静默成功）', async () => {
    const { result } = await callRefresh([entry('mystery', 'MYSTERY_ACCOUNT_1')], 'mystery-1')
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/Unknown provider/)
  })

  it('账号不存在时报错', async () => {
    const { result } = await callRefresh([], 'nope-1')
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/not found/)
  })

  /**
   * ★ **「不支持续期」与「未知 provider」必须是两句不同的话**（Task 2 的 Step 6
   * 明确要求，此前**零覆盖**）。
   *
   * ## 为什么这条不可省
   *
   * 分派改成查表后，`authOf(auths, entry.provider)` 对两种**性质完全不同**的
   * 情况都返回 `undefined`：
   * - `opencode` —— provider **存在**（registry 里有声明、池里有账号），
   *   但它的凭据是**静态 API key**，根本没有续期概念；
   * - `mystery` —— 压根**没有**这个 provider（拼错 / 旧客户端 / 数据损坏）。
   *
   * 若两者都报泛化的 `Unknown provider`，排查者会以为「provider 没注册」而去查
   * 注册清单 —— 而真相是「该产品无此能力」。本仓库反复记录过这个缺陷形态
   *（见 `provider-runtime.ts` 模块头的「能力域全部可选」一节）。
   *
   * ⚠️ 判据是**两句文案互不相同**，且各自**点名自己的原因** ——
   *    只断言 `ok === false` 的话，把两句合并成一句照样绿（同义反复）。
   */
  it('★ opencode 账号报「不支持续期」，与「未知 provider」是两句不同的话', async () => {
    // opencode 在 registry 里有声明（`channel: true`，它确实有账号池），
    // 但**不在** `auths` 的 13 个键里（夹具的键由 REFRESH_PROVIDERS 派生）。
    const unsupported = await callRefresh(
      [entry('opencode', 'OPENCODE_ACCOUNT_1')], 'opencode-1',
    )
    expect(unsupported.result.ok).toBe(false)
    const unsupportedMessage = unsupported.result.error?.message ?? ''
    expect(unsupportedMessage, 'opencode 应报「不支持续期」而不是「未知 provider」')
      .toMatch(/不支持续期/)
    expect(unsupportedMessage).toContain('opencode')
    expect(unsupportedMessage, 'opencode 是**已知** provider，不得说它 Unknown')
      .not.toMatch(/Unknown provider/)

    // 对照组：真正不存在的 id 仍报 Unknown provider（兜底没被吃掉）。
    const unknown = await callRefresh([entry('mystery', 'MYSTERY_ACCOUNT_1')], 'mystery-1')
    expect(unknown.result.ok).toBe(false)
    expect(unknown.result.error?.message).toMatch(/Unknown provider/)

    // ⚠️ 核心：两句必须**不同** —— 否则上面两条各自都能过，而区分能力为零。
    expect(unsupportedMessage).not.toBe(unknown.result.error?.message)
  })
})

/**
 * Gitee issue IKJOZA：续期失败**不得**回 `ok:true`。
 *
 * ## 缺陷
 * 本 RPC 的 catch 曾把异常包进成功响应（`{ok:true, value:{success:false}}`）。
 * 客户端 `unwrapRpcResult`（`plugin-src/management-rpc.mjs`）只判 `ok === true`
 * 就返回 `value` ⇒ **只判 `ok` 的调用方会把失败读成成功**。报告方一个工具首版
 * 因此把 18 次里的 17 次失败显示成「✅」。
 *
 * ## 这组用例守的正是「失败形态」本身
 * ⚠️ 上面那条「账号不存在时报错」**曾经**断言的是 `value.success === false` ——
 * 也就是说**修复前的行为照样绿**。这正是本缺陷能长期存在的原因：既有断言锁的是
 * 「value 里能看到失败」，而缺陷的实质是「失败被包装成了成功」。
 * 故这里必须额外锁死顶层 `ok`，并断言**失败时 value 根本不存在**。
 */
describe('account.refresh 失败语义（issue IKJOZA）', () => {
  /**
   * 让指定 provider 的续期**抛错**，其余照常。
   *
   * ⚠ **13 个 provider 键一个都不能少** —— 夹具（`tests/helpers/rpc-refresh.ts`）
   * 从 `REFRESH_PROVIDERS` **派生**这 13 个桩，故新增 provider 时自动跟上。
   *
   * ⚠️ 2026-10-08 改（Task 2）：本函数原先自带一份 13 个键的 `stub()` 表并逐字
   * 对齐 `JetHubAuths`（该注释当时自陈「本文件不在 typecheck:tests 编译范围内，
   * 故键清单靠**人工对齐**」）。夹具派生后这条人工纪律**消失了** ——
   * 新增 provider 忘加桩不再可能，因为桩集合就是那份清单本身。
   */
  async function callRefreshFailing(accounts: ProviderAccountEntry[], accountId: string, throwing: string, message: string) {
    const harness = refreshHarness(accounts, { throwing: { [throwing]: message } })
    return harness.call(accountId)
  }

  /**
   * issue 报告里出现过的真实错误，逐条锁定「失败仍回 ok:true 就得红」。
   *
   * ⚠ **provider 与文案必须对位**（初版把 raccoon 的报错挂在 `trae` 上，因为
   * `makeThrowingStub` 当时没有 raccoon/minimax 的桩）：挂错 provider 时，
   * 该 provider 自己的失败分支**根本没被走到**，等于零覆盖 —— 后来谁在那个
   * 分支里加个 early return，也不会有任何用例会红。
   */
  const REPORTED = [
    { provider: 'codearts', message: "CodeArts token request failed: 400 {errorCode: 'STS5.1806', errorMsg: \"invalid refresh token: 'the refresh token has been used'\"}" },
    { provider: 'minimax', message: 'minimax refresh_token 已失效' },
    { provider: 'raccoon', message: 'raccoon 登录态已过期' },
  ] as const

  for (const { provider, message } of REPORTED) {
    it(`★ ${provider} 续期失败必须回 ok:false，而不是 ok:true + value.success:false`, async () => {
      const accounts = [entry(provider, `${provider.toUpperCase()}_ACCOUNT_F`)]
      const result = await callRefreshFailing(accounts, `${provider}-1`, provider, message)

      // 核心断言：顶层 ok 必须为 false。修复前这里是 true ⇒ 本用例变红。
      expect(result.ok, `${provider} 续期失败却回 ok:true，调用方会把它读成成功`).toBe(false)
      // 失败时**不得**再出现 value —— 那正是被包装成成功的形态。
      expect(result.value, `${provider} 失败时仍带 value（success:false）`).toBeUndefined()
    })

    it(`${provider} 失败必须把服务端原文带进 error.message（否则用户看到「未知故障」）`, async () => {
      const accounts = [entry(provider, `${provider.toUpperCase()}_ACCOUNT_F`)]
      const result = await callRefreshFailing(accounts, `${provider}-1`, provider, message)
      expect(result.error?.message).toBe(message)
    })
  }

  /**
   * 全部 13 个 provider 逐个覆盖。
   *
   * ⚠️ 2026-10-08 改（Task 2）：本表原先**手抄** 13 个 id，并靠注释提醒
   * 「`switch` 新增 case 时这条会静默失效」。查表分派后「新增 case」这个形态
   * 不存在了，但「新增 provider 时本表忘了加」仍然可能 ——
   * ⇒ 改为从 `REFRESH_PROVIDERS`（夹具的单一清单）**派生**，
   *    与 `src/index.ts` 的注册清单、`JetHubAuths` 的 13 个键同源。
   */
  for (const provider of REFRESH_PROVIDERS) {
    it(`${provider} 分支的失败也走同一条 ok:false 通道`, async () => {
      const accounts = [entry(provider, `${provider.toUpperCase()}_ACCOUNT_F`)]
      const result = await callRefreshFailing(accounts, `${provider}-1`, provider, `${provider} boom`)
      expect(result.ok).toBe(false)
      expect(result.error?.message).toBe(`${provider} boom`)
    })
  }

  it('失败也带 error.code，与本文件其它分支（bad-request）保持同一约定', async () => {
    const accounts = [entry('codearts', 'CODEARTS_ACCOUNT_F')]
    const result = await callRefreshFailing(accounts, 'codearts-1', 'codearts', 'boom')
    expect(result.error?.code).toBe('bad-request')
  })

  it('成功路径不受影响：仍是 ok:true + value.success:true', async () => {
    // 防止「为了让失败变红」把成功也一起改成 ok:false。
    const { result } = await callRefresh([entry('buddy', 'BUDDY_ACCOUNT_1')], 'buddy-1')
    expect(result.ok).toBe(true)
    expect(result.value?.success).toBe(true)
  })
})
