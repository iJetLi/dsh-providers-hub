/**
 * **Gemini 登录的代理回落守卫**（2026-11-26，issue #170）。
 *
 * ## 报障形态
 *
 * 面板显示「**登录失败：fetch failed**」，而浏览器能正常打开 Google 授权页。
 *
 * ## 根因
 *
 * Gemini 全链路在墙外 ⇒ 没代理时 `fetch failed`。而代理是**逐账号**存的：
 *
 * ```ts
 * geminiProxyFor(accountId)                          // 只查已落池的账号
 *   ⇒ 新账号的 id 刚生成、还没落池 ⇒ 恒返回 ''
 *   ⇒ createGeminiFetcherResolver 的 raw === '' 分支 ⇒ 返回裸 fetch
 *   ⇒ Google 在墙外 ⇒ TypeError: fetch failed
 * ```
 *
 * 推理链一直有代理（`geminiFetchForAccount`），所以症状是「浏览器能授权、面板没账号」。
 *
 * ## 修法
 *
 * 登录专用 `geminiLoginFetchForAccount`：自己的代理优先，**没有 ⇒ 借本 provider 任一已配代理的账号**。
 * ⚠️ **推理路径绝不回落** —— 那里 `accountId` 是确定的，借别人的出口会让「从哪出网」失真。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GEMINI_LOGIN_NETWORK_FALLBACK,
  geminiFetchForAccount,
  geminiLoginFetchForAccount,
  isBareFetchFailure,
  setGeminiProxyPool,
} from '../../src/gemini-proxy.js'

/** 假池：只有 `known` 里的账号有代理。 */
function poolWith(known: Record<string, string>, anyValue?: string) {
  return {
    geminiProxyFor: (accountId: string) => known[accountId] ?? '',
    // ⚠️ 可选方法：给了才回落（向后兼容旧注入方）
    ...(anyValue === undefined ? {} : { geminiProxyForAny: () => anyValue }),
  }
}

afterEach(() => {
  setGeminiProxyPool(undefined)
})

describe('Gemini 登录代理回落（issue #170）', () => {
  /**
   * ★★★ 核心一格：**新账号（未落池）在登录时必须拿到代理**。
   * 这条红了就说明「必需翻墙的用户永远登录不上」这个缺陷回来了。
   */
  it('★★★ 新账号（未落池）登录 ⇒ 借用该 provider 任一已配代理的账号', () => {
    // 老账号 old-1 配了代理，新账号 new-1 还没落池
    setGeminiProxyPool(poolWith({ 'old-1': 'http://127.0.0.1:7890' }, 'http://127.0.0.1:7890'))
    const loginFetch = geminiLoginFetchForAccount('new-1')
    expect(
      loginFetch,
      '登录 fetcher 不能是裸 fetch —— 否则 Google 在墙外时必然 fetch failed',
    ).not.toBe(fetch)
  })

  /**
   * ⚠️ **反向对照**：推理路径**不许**回落。
   * 这条保证修法没有把「借出口」扩散到「这个号到底从哪出网」。
   */
  it('★★★ 推理 fetcher **不得**回落（同一份池、同一个新账号 ⇒ 仍是裸 fetch）', () => {
    setGeminiProxyPool(poolWith({ 'old-1': 'http://127.0.0.1:7890' }, 'http://127.0.0.1:7890'))
    expect(
      geminiFetchForAccount('new-1'),
      '推理路径借别人的出口会让「这个号从哪出网」失真，必须直连',
    ).toBe(fetch)
  })

  it('账号自己有代理 ⇒ 登录用**自己的**，不借别人的', () => {
    setGeminiProxyPool(poolWith({ 'own-1': 'http://10.0.0.1:8080' }, 'http://fallback:1'))
    expect(geminiLoginFetchForAccount('own-1')).not.toBe(fetch)
  })

  it('一个代理都没配 ⇒ 登录仍直连（保持「没配就当不需要代理」的既有语义）', () => {
    setGeminiProxyPool(poolWith({}))
    expect(geminiLoginFetchForAccount('new-1')).toBe(fetch)
  })

  it('池未注入 / 传 undefined ⇒ 直连（不抛错，探测按钮不会崩）', () => {
    setGeminiProxyPool(undefined)
    expect(geminiLoginFetchForAccount('any')).toBe(fetch)
    expect(geminiFetchForAccount('any')).toBe(fetch)
  })

  it('旧注入方没实现 geminiProxyForAny ⇒ 登录退回自己的代理判断，不抛错', () => {
    // 不传 anyValue ⇒ 池对象没有 geminiProxyForAny 方法
    setGeminiProxyPool(poolWith({}))
    expect(geminiLoginFetchForAccount('new-1')).toBe(fetch)
  })
  /**
   * ★★★ **裸 `fetch failed` 必须能挑到兜底文案**（2026-11-26，issue #170 审计 P1）。
   *
   * 用户报障截图里显示的**正是裸的**「登录失败：fetch failed」—— 没有 `cause` 码。
   * 而 `geminiNetworkHint` 的判据**吃码不吃文案** ⇒ 对它返回 `undefined`
   * ⇒ 修复会**静默空跑**（用户看到的还是那句零信息量的 `fetch failed`）。
   *
   * ⇒ `isBareFetchFailure` 就是这个缺口的判别器；`GEMINI_LOGIN_NETWORK_FALLBACK`
   *   是不依赖错误码的兜底文案。
   */
  it('★★★ 裸 fetch failed（无 cause 码）⇒ 判为网络失败，用兜底文案', () => {
    const bare = new TypeError('fetch failed')
    expect(isBareFetchFailure(bare), '裸 fetch failed 必须被认出').toBe(true)
    // cause 存在但没有 code（undici 某些形态）⇒ 同样算裸
    const noCode = Object.assign(new TypeError('fetch failed'), { cause: {} })
    expect(isBareFetchFailure(noCode)).toBe(true)
    // 兜底文案必须**自带出路**（否则等于没修）
    expect(GEMINI_LOGIN_NETWORK_FALLBACK).toMatch(/代理|HTTPS_PROXY/)
    expect(GEMINI_LOGIN_NETWORK_FALLBACK).toMatch(/系统代理/)
  })

  it('★★ 有 cause 码 ⇒ **不**走裸兜底（交给 geminiNetworkHint 的码表，那份更有信息量）', () => {
    const coded = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    })
    expect(isBareFetchFailure(coded), '有码时不该抢走码表的活').toBe(false)
  })

  it('★★ 非 fetch failed 的错误 ⇒ 不算（不把别的失败误标成网络问题）', () => {
    expect(isBareFetchFailure(new Error('invalid_grant'))).toBe(false)
    expect(isBareFetchFailure(new Error(''))).toBe(false)
  })

})
