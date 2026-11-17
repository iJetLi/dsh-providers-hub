/**
 * ★ Marvis 账号池的**会话分散**（2026-11-17 用户报障「十个号不会自动切换」）。
 *
 * ## 事故
 *
 * 用户池里有 11 个 marvis 账号，`token-ledger.json` 里当天**只有第 1 个号**有
 * 记录（75 req / 3 err），其余 10 个 requests 恒 0 —— 另 10 个是纯备份。
 *
 * ## 根因
 *
 * 适配器取槽写的是 `slots.find(s => !tried.has(s.id))`（失败才换下一个），
 * 而 `slots()` 恒按池序返回 ⇒ 第一个健康号永远赢，池子事实上是「1 主 10 备」。
 *
 * ## 本文件守什么
 *
 * 1. `AccountPool.orderAccountsForSession` 的排序语义（无 sessionId 原样返回、
 *    有 sessionId 亲和且分散、账本抛错不反噬推理）；
 * 2. `src/index.ts` 的**生产接线**：`slots` 签名带 sessionId、调用点在开关打开
 *    且 sessionId 非空时才重排 —— 接线被回退（例如有人把排序行删掉、或改成
 *    「总是重排」破坏「手动顺序优先」）都会变红。
 *
 * ⚠️ 第 2 组是**源码断言**，与 `rotation-session-id-wiring.spec.ts` 同型：
 * 这条接线的失败形态是「静默不生效、零报错」，只有源码断言能抓住。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { MARVIS } from '../../src/marvis-product.js'
import { attachTokenLedgerStore, utc8DayKey } from '../../src/token-ledger.js'

/** 11 个号 —— 与用户现场同量级（足够看出「只有第一个在干活」）。 */
const ACCOUNTS = Array.from({ length: 11 }, (_, index) => ({ id: `marvis-${index}` }))

function makePool(): AccountPool {
  const ctx = new Context()
  ;(ctx as unknown as { credentials: unknown }).credentials = {
    resolve: async () => ({ value: 'x', source: 'fake' }),
    set: async () => {},
    unset: async () => {},
  }
  ;(ctx as unknown as { settings: unknown }).settings = {
    register() {
      const state: { value: unknown } = { value: undefined }
      return { get: () => state.value, replace: (value: unknown) => { state.value = value } }
    },
    describe() { return [] },
  }
  ;(ctx as unknown as { logger: unknown }).logger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  }
  return new AccountPool(ctx as never)
}

let detach: (() => void) | undefined
afterEach(() => {
  detach?.()
  detach = undefined
})

describe('★ AccountPool.orderAccountsForSession（槽制渠道的排序原语）', () => {
  it('★ 没有 sessionId ⇒ 原样返回池序（= 改造前逐字节同路径）', () => {
    const pool = makePool()
    expect(pool.orderAccountsForSession(MARVIS.id, ACCOUNTS)).toEqual(ACCOUNTS)
    expect(pool.orderAccountsForSession(MARVIS.id, ACCOUNTS, '')).toEqual(ACCOUNTS)
  })

  it('★★ 同一 sessionId ⇒ 顺序逐字稳定（跨多次调用、跨数组顺序）', () => {
    const pool = makePool()
    const first = pool.orderAccountsForSession(MARVIS.id, ACCOUNTS, 'session-abc').map(a => a.id)
    const second = pool.orderAccountsForSession(MARVIS.id, [...ACCOUNTS].reverse(), 'session-abc')
      .map(a => a.id)
    expect(first).toEqual(second)
    expect(first).toHaveLength(ACCOUNTS.length)
    // 池序第一个**不再**恒定赢：亲和落点若仍是它，这条用例就抓不到回归。
    expect(first[0], '亲和落点恰好等于池序第一 ⇒ 本用例对该 sessionId 无鉴别力').not.toBe(
      ACCOUNTS[0]!.id,
    )
  })

  it('★★ 不同 sessionId 分散到多个号（不是永远第一个）', () => {
    const pool = makePool()
    const firsts = new Set<string>()
    for (let index = 0; index < 60; index += 1) {
      firsts.add(pool.orderAccountsForSession(MARVIS.id, ACCOUNTS, `session-${index}`)[0]!.id)
    }
    // ⚠️ 必须**覆盖全部**账号（原先写 `>= 5`）：11 个号里只用到 5 个时 `5 >= 5` 恒真，
    //    等于这条用例对「排序只看前 5 个」这种退化完全无牙（对抗审计 m16 实测绿）。
    expect(firsts.size).toBe(ACCOUNTS.length)
  })

  it('★★ 今日负载越阈的号整组沉底（溢出均衡真的读到账本）', () => {
    const pool = makePool()
    const sessionId = 'session-overflow-marvis'
    const home = pool.orderAccountsForSession(MARVIS.id, ACCOUNTS, sessionId)[0]!.id
    // 挂一个假账本：让亲和号「今天已经打了 300 次」。
    const buckets = new Map([[
      `direct|${MARVIS.id}|${home}|deepseek-v4-pro-external`,
      { requests: 300, outputTokens: 0 },
    ]])
    const day = utc8DayKey(Date.now())
    detach = attachTokenLedgerStore({
      append: () => {},
      load: () => new Map([[day, buckets]]) as never,
    } as never)
    const order = pool.orderAccountsForSession(MARVIS.id, ACCOUNTS, sessionId)
    expect(order[0]!.id, '越阈的亲和号没有沉底 ⇒ 溢出接线失效').not.toBe(home)
    // 软溢出：仍然在序列里（全池超载时还得照常发请求让上游限流）。
    expect(order.map(a => a.id)).toContain(home)
  })

  it('★★ 账本读取抛错不得反噬推理：退化为纯哈希亲和', () => {
    const pool = makePool()
    const sessionId = 'session-ledger-boom'
    const pureFirst = pool.orderAccountsForSession(MARVIS.id, ACCOUNTS, sessionId)[0]!.id
    detach = attachTokenLedgerStore({
      append: () => {},
      load: () => { throw new Error('ledger boom') },
    } as never)
    // 不抛错 ⇒ 记账/统计故障绝不能把整条推理链路变成不可用。
    expect(pool.orderAccountsForSession(MARVIS.id, ACCOUNTS, sessionId)[0]!.id).toBe(pureFirst)
  })

  it('★ 单账号池不做无意义重排（顺序原样）', () => {
    const pool = makePool()
    const one = [{ id: 'marvis-only' }]
    expect(pool.orderAccountsForSession(MARVIS.id, one, 'session-solo')).toEqual(one)
  })
})

// ⚠️ 原先这里还有三条 `src/index.ts` 的**源码文本断言**（gate 是否调用 / 是否判开关 /
//    排序是否在凭据解析之后）。PR #190 双审计返工把判定抽成 `src/marvis-slots.ts` 的
//    `orderMarvisSlots` 之后，这三条搬到 `tests/unit/marvis-slot-ordering.spec.ts` 并升级为
//    **行为级**：源码断言挡不住「留着但失效」（`if (false)` / 丢弃返回值 /
//    反向读开关，三种实测全绿），纯函数用例才咬得住。

describe('★ 客户端开关门控（`supportsSessionBalance`）必须点名到今天这两家', () => {
  const client = readFileSync(join(process.cwd(), 'plugin-src', 'client', 'jet-hub.js'), 'utf8')

  it('★★ 门控表达式逐字锁住 zcode / marvis（扩面必须同时改这里，不许静默扩散）', () => {
    // 为什么必须锁字面量：`tests/unit/jet-hub-panel-wiring.spec.ts:391` 的 `PROVIDERS`
    // 是**手写 7 家**，而 provider registry 有 31 家 ⇒ 往门控里塞第三家（如 `gemini`）
    // 时那个 panel-wiring 用例照样全绿（对抗审计 m19 实测）。这条是「扩面必须显式
    // 改两处」的唯一闸门 —— 红在这里会逼人重新想「这一家真的支持会话分散吗」。
    const match = /const supportsSessionBalance = ([^\n]+)/u.exec(client)
    expect(match, 'plugin-src/client/jet-hub.js 里找不到 supportsSessionBalance 的定义').not.toBeNull()
    expect(match![1]!.trim()).toBe("provider === 'zcode' || provider === 'marvis';")
  })

  it('★★ 面板 tooltip 必须按 provider 分叉（marvis 不随机分摊）', () => {
    // 原文案对 marvis 是**假话**：写「无会话标识的请求随机分摊」，而 marvis 走
    // `orderAccountsForSession` ⇒ 无 sessionId 时**原样池序**（只有 zcode 走
    // `shuffleAccounts`）。用户会据此以为网关流量已经被摊开（正是本 PR 的 P1）。
    const at = client.indexOf('负载均衡：多账号按会话分散')
    expect(at, '找不到「负载均衡」tooltip 文案').toBeGreaterThan(-1)
    const window = client.slice(at - 500, at + 1000)
    expect(window).toContain("provider === 'marvis'")
    expect(window).toContain('保持池序、不分散')
    expect(window).toContain('随机分摊')
  })
})
