/**
 * LobsterAI e2e 探针：只走**认证**与**签到状态**，不发模型请求。
 *
 * ⚠️ **会真实改动账号当日签到状态？不会** —— 本文件只做：
 * 1. 解析已存凭据（验证凭据结构与过期时间可解析）；
 * 2. 拉取客户端版本号（验证动态取值 + 兜底）；
 * 3. 查询签到活动槽位与上下文（**只读**，不调用 check_in）。
 *
 * 因此它**不消耗模型积分、也不改动签到状态**，可安全重复运行。
 * 真正领取的探针见 `lobsterai-claim-probe.e2e.spec.ts`（带二次确认闸门）。
 *
 * 闸门：`DSH_LOBSTERAI_E2E=1`。未设置时整体 skip，不产生任何网络调用。
 * 前置：先在 Jet Hub 的 LobsterAI 面板登录至少一个账号。
 */

import { describe, expect, it } from 'vitest'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import {
  fetchLobsteraiActivityContext,
  fetchLobsteraiActivitySlot,
  fetchLobsteraiCreditBalance,
} from '../../src/lobsterai-credits.js'
import {
  LobsteraiClientVersionResolver,
  isLobsteraiRefreshable,
  lobsteraiCredentialExpiresAtMs,
  lobsteraiModelsHeaders,
} from '../../src/lobsterai.js'
import { buildLobsteraiModelsUrl, parseLobsteraiModels, readLobsteraiModelArray } from '../../src/lobsterai-adapter.js'
import { readLobsteraiCredentialsFromDshStore } from './lobsterai-credential.js'

const enabled = process.env.DSH_LOBSTERAI_E2E === '1'
const describeGate = enabled ? describe : describe.skip

describeGate('LobsterAI 认证与签到状态探针（不消耗模型积分）', () => {
  const credentials = readLobsteraiCredentialsFromDshStore()

  it('至少有一个已登录的 LobsterAI 账号', () => {
    // 前置条件缺失时给出可操作的提示，而不是一个费解的断言失败。
    expect(
      credentials.length,
      '未找到 LobsterAI 凭据。请先在 Jet Hub 的 LobsterAI 面板登录一个账号，'
      + '或确认 DSH profile 的 .credentials.yaml 路径正确。',
    ).toBeGreaterThan(0)
  })

  it('凭据结构完整（access_token / refresh_token / keyfrom 身份字段）', () => {
    for (const { uid, credential } of credentials) {
      expect(credential.access_token, uid).toBeTruthy()
      // 这三个字段缺失会让续期失败，必须持久化。
      expect(credential.uuid, uid).toBeTruthy()
      expect(credential.first_keyfrom, uid).toBeTruthy()
      expect(isLobsteraiRefreshable(credential), uid).toBe(true)
      expect(lobsteraiCredentialExpiresAtMs(credential), uid).toBeGreaterThan(0)
    }
  })

  it('客户端版本号可动态解析（失败时回退兜底值）', async () => {
    const resolver = new LobsteraiClientVersionResolver()
    const { version, source } = await resolver.resolve(LOBSTERAI)
    // 两种结果都可接受：远端真值或兜底值 —— 关键是**不能抛错**。
    expect(['remote', 'cache', 'fallback']).toContain(source)
    expect(version).toMatch(/^\d+(\.\d+)+/)
    // 兜底值不应是 Go 侧那个假值 0.1.0。
    if (source === 'fallback') expect(version).toBe(LOBSTERAI.fallbackClientVersion)
  })

  it('可查询签到活动槽位（只读，不领取）', async () => {
    const resolver = new LobsteraiClientVersionResolver()
    const { version } = await resolver.resolve(LOBSTERAI)
    for (const { uid, credential } of credentials) {
      const slot = await fetchLobsteraiActivitySlot(credential, LOBSTERAI, version)
      // null 表示网络/信封异常；非 null 则必须给出 slotState。
      if (slot !== null) {
        expect(typeof slot.slotState, uid).toBe('string')
        // eslint-disable-next-line no-console
        console.log(`[lobsterai-e2e] ${uid}: slotState=${slot.slotState} activityCode=${slot.activityCode || '(无)'}`)
      } else {
        // eslint-disable-next-line no-console
        console.log(`[lobsterai-e2e] ${uid}: 槽位查询失败（凭据可能已失效）`)
      }
    }
  })

  it('槽位可用时可查询活动上下文（claimedToday / actions）', async () => {
    const resolver = new LobsteraiClientVersionResolver()
    const { version } = await resolver.resolve(LOBSTERAI)
    for (const { uid, credential } of credentials) {
      const slot = await fetchLobsteraiActivitySlot(credential, LOBSTERAI, version)
      if (slot === null || slot.slotState !== 'available' || slot.activityCode.length === 0) continue
      const context = await fetchLobsteraiActivityContext(credential, LOBSTERAI, slot)
      if (context === null) continue
      expect(typeof context.claimedToday, uid).toBe('boolean')
      expect(Array.isArray(context.actions), uid).toBe(true)
      // eslint-disable-next-line no-console
      console.log(
        `[lobsterai-e2e] ${uid}: claimedToday=${context.claimedToday} actions=[${context.actions.join(',')}]`,
      )
    }
  })

  /**
  /**
   * 模型目录的**线上**契约（只读：一次 GET，不消耗模型积分）—— 限免四件套 +
   * 订阅闸门三件套。
   *
   * ⚠️ 断言只锁「上游发了真值 ⇒ 解析层不得读丢」这个契约。**不锁**「此刻有几条
   * 限免 / 几条不可用」：2026-11-17 实测 21/21 限免全为 false/null，而不可用条目数
   * 随**账号订阅状态**变（换一个已订阅账号就变成 0 个）⇒ 锁数量等于把测试绑在
   * 「上游今天没活动」或某个具体账号上。
   *
   * ★ 限免起止的真实格式**尚未取证**（至今全 null）。本用例因此把**原始字符串**
   * 打出来 —— 上游第一次真的办活动时，这段日志就是格式证据（客户端自己
   * `Date.parse` 它）。
   */
  it('模型目录下发限免四件套与订阅闸门三件套（解析层不得读丢；起止格式待取证）', async () => {    const first = credentials[0]
    if (first === undefined) return
    const { version } = await new LobsteraiClientVersionResolver().resolve(LOBSTERAI)
    const response = await fetch(buildLobsteraiModelsUrl(LOBSTERAI, first.credential, version), {
      headers: lobsteraiModelsHeaders(first.credential, LOBSTERAI, version),
      signal: AbortSignal.timeout(30_000),
    })
    expect(response.status, `HTTP ${response.status}`).toBe(200)
    const body: unknown = await response.json()
    const models = parseLobsteraiModels(body)
    const byId = new Map(models.map((m) => [m.id, m]))
    const dropped: string[] = []
    const drifted: string[] = []
    const unreadable: string[] = []
    let active = 0
    let windowed = 0
    for (const item of readLobsteraiModelArray(body)) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const id = typeof record.modelId === 'string' ? record.modelId : ''
      const model = byId.get(id)
      if (model === undefined) continue
      if (typeof record.limitedFree === 'boolean' && typeof model.limitedFree !== 'boolean') dropped.push(id)
      if (typeof record.limitedFreeActive === 'boolean' && typeof model.limitedFreeActive !== 'boolean') {
        dropped.push(id)
      }
      // ★ 契约漂移探针：上游对这两个键的形态**只有「布尔」或「null/缺失」**两种（实测）。
      // 换成字符串 `"false"` / 数字 / 对象时，解析层会按「未声明」丢掉 ⇒ 徽标静默消失。
      // 这一格必须喊出来，否则症状与「上游今天没活动」完全同形。
      for (const key of ['limitedFree', 'limitedFreeActive'] as const) {
        const raw = record[key]
        if (raw === undefined || raw === null) continue
        if (typeof raw !== 'boolean') drifted.push(`${id}.${key}=${JSON.stringify(raw)}`)
      }
      if (model.limitedFreeWindowUnreadable === true) {
        unreadable.push(
          `${id} startAt=${JSON.stringify(record.limitedFreeStartAt)} endAt=${JSON.stringify(record.limitedFreeEndAt)}`,
        )
      }
      if (model.limitedFreeActive === true) active += 1
      if (model.limitedFreeStartMs !== undefined || model.limitedFreeEndMs !== undefined) {
        windowed += 1
        // eslint-disable-next-line no-console
        console.log(
          `[lobsterai-e2e] 限免窗口: ${id} startAt=${JSON.stringify(record.limitedFreeStartAt)} `
          + `endAt=${JSON.stringify(record.limitedFreeEndAt)} ⇒ `
          + `${String(model.limitedFreeStartMs)} / ${String(model.limitedFreeEndMs)}`,
        )
      }
    }
    expect(dropped, '这些条目上游发了布尔、解析层却读丢').toEqual([])
    expect(drifted, '上游把限免布尔的形态改了（解析层会按「未声明」丢掉，徽标静默消失）').toEqual([])
    for (const entry of unreadable) {
      // eslint-disable-next-line no-console
      console.log(`[lobsterai-e2e] 限免起止读不懂（已按不动处理）: ${entry}`)
    }
    // eslint-disable-next-line no-console
    console.log(
      `[lobsterai-e2e] 限免: 目录 ${models.length} 个，此刻生效 ${active} 个，带起止 ${windowed} 个`
      + (unreadable.length > 0 ? `，读不懂 ${unreadable.length} 个` : ''),
    )

    // ── 订阅闸门三件套（PR #113）──
    // 复用同一份 `models`：两个 PR 都在同一个端点上判契约，发两次 GET 只会让
    // 「一个用例红、另一个绿」时无法判断是上游变了还是解析层分叉。
    expect(models.length, '远端模型数').toBeGreaterThan(0)
    expect(
      models.filter((m) => typeof m.accessible !== 'boolean').map((m) => m.id),
      '这些条目没读到 accessible（解析层把它丢了）',
    ).toEqual([])
    const restricted = models.filter((m) => m.accessible === false)
    for (const model of restricted) {
      // eslint-disable-next-line no-console
      console.log(
        `[lobsterai-e2e] 订阅闸门: ${model.id} `
        + `subscriptionPriority=${String(model.subscriptionPriority)} `
        + `hint=${model.restrictionHint ?? '(无)'}`,
      )
    }
    // eslint-disable-next-line no-console
    console.log(`[lobsterai-e2e] 目录: ${models.length} 个模型，其中当前不可用 ${restricted.length} 个`)
  })

  it('可查询积分余额（profile-summary）', async () => {
    for (const { uid, credential } of credentials) {
      const balance = await fetchLobsteraiCreditBalance(credential, LOBSTERAI)
      if (balance === null) {
        // eslint-disable-next-line no-console
        console.log(`[lobsterai-e2e] ${uid}: 余额查询失败（凭据可能已失效）`)
        continue
      }
      expect(typeof balance.total, uid).toBe('number')
      // eslint-disable-next-line no-console
      console.log(
        `[lobsterai-e2e] ${uid}: 余额=${balance.total} 包数=${balance.packages.length}`
        + (balance.expiredTotal > 0 ? ` 已失效=${balance.expiredTotal}` : ''),
      )
    }
  })
})
